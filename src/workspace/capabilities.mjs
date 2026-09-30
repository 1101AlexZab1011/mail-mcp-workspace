// Per-artifact capability grants and the capabilities themselves.
//
// An artifact declares what it needs in artifact.json:
//   "capabilities": {
//     "exec":  { "cwd": "~/Projects/app" },                 run commands / shells under cwd
//     "fetch": { "origins": ["http://localhost:3000"] },    HTTP to these origins only
//     "fs":    { "read": ["~/data"], "write": ["~/out"] },  files under these paths
//     "agent": true                                         send messages to the agent chat
//   }
// The user approves that exact declaration once; any later change to it needs
// approval again. Grants live in ~/.config/mail-workspace/grants.json.
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { expand } from "./files.mjs";

export const DEFAULT_GRANTS = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "mail-workspace", "grants.json");

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

/** Canonical form of a capability declaration, so approval compares exactly. */
export function canonical(caps) {
  if (!caps || typeof caps !== "object") return null;
  const out = {};
  if (caps.exec) out.exec = { cwd: expand(caps.exec.cwd ?? "~") };
  if (caps.fetch) out.fetch = { origins: [...new Set((caps.fetch.origins ?? []).map((o) => new URL(o).origin))].sort() };
  if (caps.fs) out.fs = { read: [...new Set((caps.fs.read ?? []).map(expand))].sort(), write: [...new Set((caps.fs.write ?? []).map(expand))].sort() };
  if (caps.agent) out.agent = true;
  return Object.keys(out).length ? out : null;
}

const inside = (path, roots) => roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));

export class Capabilities {
  constructor({ grantsPath = DEFAULT_GRANTS, publishToAgent } = {}) {
    this.grantsPath = grantsPath;
    this.sessions = new Map();
    this.publishToAgent = publishToAgent;
  }

  /** End every shell session (host shutdown). */
  closeAll() { for (const session of this.sessions.values()) session.kill(); this.sessions.clear(); }

  async #load() {
    try { return JSON.parse(await readFile(this.grantsPath, "utf8")); } catch { return {}; }
  }

  async #save(grants) {
    await mkdir(dirname(this.grantsPath), { recursive: true, mode: 0o700 });
    const temp = `${this.grantsPath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.grantsPath);
  }

  /** The declared capabilities of an artifact and whether they are approved as declared. */
  async status(artifact, declared) {
    const want = canonical(declared);
    const grants = await this.#load();
    const have = grants[artifact]?.capabilities ?? null;
    return { artifact, declared: want, approved: want === null || JSON.stringify(have) === JSON.stringify(want) };
  }

  async approve(artifact, declared) {
    const grants = await this.#load();
    grants[artifact] = { capabilities: canonical(declared), approved_at: new Date().toISOString() };
    await this.#save(grants);
    return this.status(artifact, declared);
  }

  async revoke(artifact) {
    const grants = await this.#load();
    delete grants[artifact];
    await this.#save(grants);
    return { artifact, revoked: true };
  }

  /** Run one capability call for an artifact, after checking its grant. */
  async call(artifact, declared, method, args = {}, context = {}) {
    const state = await this.status(artifact, declared);
    const caps = state.declared ?? {};
    if (!state.approved) throw fail(403, "needs_approval", "This artifact's capabilities are not approved yet", { declared: caps });
    switch (method) {
      case "exec": return this.#exec(caps, args);
      case "shell.open": return this.#shellOpen(caps, artifact, args);
      case "shell.write": return this.#session(artifact, args.session).write(String(args.data ?? ""));
      case "shell.signal": return this.#session(artifact, args.session).signal(args.signal ?? "SIGINT");
      case "shell.read": return this.#session(artifact, args.session).read(Number(args.offset ?? 0), Number(args.wait ?? 0));
      case "shell.close": return this.#session(artifact, args.session).close();
      case "fetch": return this.#fetch(caps, args);
      case "fs.read": return this.#fsRead(caps, args);
      case "fs.write": return this.#fsWrite(caps, args);
      case "fs.list": return this.#fsList(caps, args);
      case "agent.ask": return this.#ask(caps, artifact, args, context);
      default: throw fail(400, "bad_request", `Unknown capability ${method}`);
    }
  }

  #cwd(caps, requested) {
    if (!caps.exec) throw fail(403, "not_granted", "This artifact has no exec capability");
    const cwd = requested ? expand(requested) : caps.exec.cwd;
    if (!inside(cwd, [caps.exec.cwd])) throw fail(403, "not_granted", `cwd must be inside ${caps.exec.cwd}`);
    return cwd;
  }

  #exec(caps, { command, cwd, stdin, timeout = 60_000, env }) {
    if (typeof command !== "string" || !command.trim()) throw fail(400, "bad_request", "command is required");
    const dir = this.#cwd(caps, cwd);
    return new Promise((resolvePromise) => {
      const child = spawn("bash", ["-lc", command], { cwd: dir, env: { ...process.env, ...(env ?? {}) } });
      let stdout = "";
      let stderr = "";
      const cap = 2 * 1024 * 1024;
      child.stdout.on("data", (chunk) => { if (stdout.length < cap) stdout += chunk; });
      child.stderr.on("data", (chunk) => { if (stderr.length < cap) stderr += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), Math.min(Number(timeout) || 60_000, 600_000));
      child.on("close", (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, stdout, stderr }); });
      if (stdin) child.stdin.end(String(stdin)); else child.stdin.end();
    });
  }

  #shellOpen(caps, artifact, { cwd }) {
    const dir = this.#cwd(caps, cwd);
    const id = randomUUID();
    const child = spawn("bash", ["--norc", "--noprofile", "--noediting", "-i"], { cwd: dir, env: { ...process.env, PS1: "\\w $ ", TERM: "dumb" } });
    const chunks = [];
    let waiters = [];
    let closed = false;
    const push = (stream, data) => {
      chunks.push({ stream, data: String(data) });
      if (chunks.length > 5000) chunks.splice(0, chunks.length - 5000);
      for (const wake of waiters) wake();
      waiters = [];
    };
    child.stdout.on("data", (data) => push("stdout", data));
    child.stderr.on("data", (data) => push("stderr", data));
    child.on("close", (code) => { closed = true; clearTimeout(idle); push("exit", String(code)); setTimeout(() => this.sessions.delete(id), 60_000).unref(); });
    // Sessions nobody touches for 30 minutes are ended.
    const arm = () => setTimeout(() => child.kill("SIGHUP"), 30 * 60_000).unref();
    let idle = arm();
    const touch = () => { clearTimeout(idle); idle = arm(); };
    const session = {
      artifact,
      kill: () => child.kill("SIGKILL"),
      write: (data) => { touch(); if (!closed) child.stdin.write(data); return { ok: true }; },
      signal: (signal) => { touch(); child.kill(signal); return { ok: true }; },
      close: () => { child.kill("SIGHUP"); return { ok: true }; },
      read: async (offset, wait) => {
        touch();
        if (offset >= chunks.length && !closed && wait > 0) {
          await new Promise((resolveWait) => { waiters.push(resolveWait); setTimeout(resolveWait, Math.min(wait, 25_000)).unref(); });
        }
        return { chunks: chunks.slice(offset), next: chunks.length, closed };
      },
    };
    this.sessions.set(id, session);
    return { session: id, cwd: dir };
  }

  #session(artifact, id) {
    const session = this.sessions.get(id);
    if (!session || session.artifact !== artifact) throw fail(404, "not_found", "No such shell session");
    return session;
  }

  async #fetch(caps, { url, method = "GET", headers, body }) {
    if (!caps.fetch) throw fail(403, "not_granted", "This artifact has no fetch capability");
    const target = new URL(url);
    if (!caps.fetch.origins.includes(target.origin)) throw fail(403, "not_granted", `${target.origin} is not in the granted origins`);
    const response = await fetch(target, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    return { status: response.status, headers: Object.fromEntries(response.headers), body: text.slice(0, 5 * 1024 * 1024) };
  }

  #fsPath(caps, path, mode) {
    if (!caps.fs) throw fail(403, "not_granted", "This artifact has no fs capability");
    const full = resolve(expand(path));
    const roots = mode === "write" ? caps.fs.write : [...caps.fs.read, ...caps.fs.write];
    if (!inside(full, roots)) throw fail(403, "not_granted", `${full} is outside the granted paths`);
    return full;
  }

  async #fsRead(caps, { path }) {
    const full = this.#fsPath(caps, path, "read");
    const info = await stat(full);
    if (info.size > 10 * 1024 * 1024) throw fail(413, "too_large", "File exceeds 10 MB");
    return { path: full, content: await readFile(full, "utf8") };
  }

  async #fsWrite(caps, { path, content }) {
    const full = this.#fsPath(caps, path, "write");
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, String(content ?? ""));
    return { path: full, written: Buffer.byteLength(String(content ?? "")) };
  }

  async #fsList(caps, { path }) {
    const full = this.#fsPath(caps, path, "read");
    const entries = await readdir(full, { withFileTypes: true });
    return { path: full, entries: entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() })) };
  }

  async #ask(caps, artifact, { text }, context) {
    if (!caps.agent) throw fail(403, "not_granted", "This artifact may not message the agent");
    if (!this.publishToAgent) throw fail(503, "unavailable", "The agent channel is not configured");
    return this.publishToAgent(`[From artifact ${artifact}]\n${String(text ?? "").slice(0, 8000)}`, context.token);
  }
}
