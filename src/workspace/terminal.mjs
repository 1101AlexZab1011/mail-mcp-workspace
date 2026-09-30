// Terminal sessions: real pseudo-terminals (node-pty) owned by the host, so
// the Thunderbird panel and the agent share them. The panel streams output
// over server-sent events and sends keystrokes back; the agent can run a
// command and read what it printed, visibly, in the same terminal.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import pty from "node-pty";
import { expand } from "./files.mjs";

const BUFFER_LIMIT = 2 * 1024 * 1024; // characters kept per session for late viewers and the agent
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Terminal output without colours, cursor moves and other control sequences. */
export function plainText(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78DEHMNOZc]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\n]*\r(?!\n)/g, "") // carriage-return overwrites keep the last write
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export class Terminals {
  constructor() {
    this.sessions = new Map();
    this.tickets = new Map();
    this.counter = 0;
  }

  create({ cwd, cols = 100, rows = 30, shell = process.env.SHELL ?? "/bin/bash", args = [], title } = {}) {
    const id = `t${++this.counter}_${randomBytes(4).toString("hex")}`;
    const dir = cwd ? expand(cwd) : homedir();
    const proc = pty.spawn(shell, Array.isArray(args) ? args.map(String) : [], {
      name: "xterm-256color",
      cols: Math.max(10, Math.min(500, Number(cols) || 100)),
      rows: Math.max(4, Math.min(200, Number(rows) || 30)),
      cwd: dir,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", MAIL_WORKSPACE_TERMINAL: id },
    });
    const session = { id, proc, cwd: dir, shell, title: title ?? shell.split("/").pop(), buffer: "", total: 0, subscribers: new Set(), waiters: new Set(), exited: null, created: new Date().toISOString(), cols, rows };
    proc.onData((data) => {
      // Programs ask the terminal questions (device attributes, version, cursor
      // position) and wait for answers. With no terminal attached, answer the
      // common ones so they don't hang or read the user's next command instead.
      if (!session.subscribers.size) {
        if (data.includes("\x1b[c") || data.includes("\x1b[0c")) proc.write("\x1b[?62;22c");
        if (data.includes("\x1b[>0q")) proc.write("\x1bP>|mail-workspace\x1b\\");
        if (data.includes("\x1b[6n")) proc.write("\x1b[1;1R");
        if (data.includes("\x1b[5n")) proc.write("\x1b[0n");
        if (/\x1b\]1[01];\?/.test(data)) proc.write("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\");
      }
      session.buffer += data;
      session.total += data.length;
      if (session.buffer.length > BUFFER_LIMIT) session.buffer = session.buffer.slice(-BUFFER_LIMIT);
      for (const send of session.subscribers) send({ type: "data", data });
      for (const wake of session.waiters) wake();
    });
    proc.onExit(({ exitCode, signal }) => {
      session.exited = { code: exitCode, signal };
      for (const send of session.subscribers) send({ type: "exit", code: exitCode });
      for (const wake of session.waiters) wake();
      // Keep a finished session briefly so its last output can still be read.
      setTimeout(() => this.sessions.delete(id), 10 * 60_000).unref();
    });
    this.sessions.set(id, session);
    return this.describe(session);
  }

  get(id) {
    const session = this.sessions.get(String(id));
    if (!session) throw fail(404, "not_found", `No terminal ${id}`);
    return session;
  }

  describe(session) {
    return { id: session.id, title: session.title, cwd: session.cwd, pid: session.proc.pid, exited: session.exited, created: session.created, cols: session.proc.cols, rows: session.proc.rows };
  }

  list() { return [...this.sessions.values()].map((s) => this.describe(s)); }

  input(id, data) {
    const session = this.get(id);
    if (session.exited) throw fail(409, "exited", "This terminal has exited");
    session.proc.write(String(data));
    return { ok: true };
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!session.exited) session.proc.resize(Math.max(10, Math.min(500, Number(cols))), Math.max(4, Math.min(200, Number(rows))));
    return this.describe(session);
  }

  close(id) {
    const session = this.get(id);
    if (!session.exited) session.proc.kill();
    this.sessions.delete(session.id);
    for (const send of session.subscribers) send({ type: "closed" });
    return { closed: session.id };
  }

  /** The last `lines` lines, as plain text (and raw, for replay). */
  read(id, { lines = 200 } = {}) {
    const session = this.get(id);
    const plain = plainText(session.buffer).split("\n");
    return { id: session.id, text: plain.slice(-Math.max(1, Math.min(5000, Number(lines) || 200))).join("\n"), exited: session.exited };
  }

  /**
   * Type a command into the terminal (the user sees it run) and return what it
   * printed. Finishes when `waitFor` matches, the output has been quiet for
   * `idleMs`, the shell exits, or `timeoutMs` passes.
   */
  async run(id, { command, timeoutMs = 60_000, idleMs = 1500, waitFor } = {}) {
    const session = this.get(id);
    if (session.exited) throw fail(409, "exited", "This terminal has exited");
    await this.settled(session);
    const start = session.total;
    const pattern = waitFor ? new RegExp(waitFor) : null;
    session.proc.write(`${command}\r`);
    const began = Date.now();
    let lastChange = Date.now();
    let seen = session.total;
    for (;;) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 200);
        const wake = () => { clearTimeout(timer); session.waiters.delete(wake); resolve(); };
        session.waiters.add(wake);
      });
      if (session.total !== seen) { seen = session.total; lastChange = Date.now(); }
      const produced = session.total - start;
      const output = produced > 0 ? session.buffer.slice(-Math.min(produced, session.buffer.length)) : "";
      // Drop the echoed command line: what matters is what it printed.
      const plain = plainText(output).replace(/^[^\n]*\n?/, "");
      const done = session.exited
        || (pattern && pattern.test(plain))
        || (!pattern && Date.now() - lastChange >= idleMs && produced > 0)
        || Date.now() - began >= timeoutMs;
      if (done) {
        return { id: session.id, output: plain, timedOut: Date.now() - began >= timeoutMs && !(pattern && pattern.test(plain)), exited: session.exited };
      }
    }
  }

  /** Wait until a new shell has finished starting (its rc files print, then go quiet). */
  async settled(session, { quietMs = 500, maxMs = 8000 } = {}) {
    if (session.settled) return;
    const began = Date.now();
    let seen = session.total;
    let quietSince = Date.now();
    while (Date.now() - began < maxMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (session.total !== seen) { seen = session.total; quietSince = Date.now(); }
      if (session.total > 0 && Date.now() - quietSince >= quietMs) break;
    }
    session.settled = true;
  }

  /** A one-use ticket for the event stream (EventSource cannot send headers). */
  ticket(id) {
    this.get(id);
    const ticket = randomBytes(18).toString("base64url");
    this.tickets.set(ticket, { id, until: Date.now() + 60_000 });
    return ticket;
  }

  /** Attach an SSE response: replay the buffer, then stream. */
  stream(ticket, response) {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!entry || entry.until < Date.now()) throw fail(403, "forbidden", "Stream ticket expired");
    const session = this.get(entry.id);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "access-control-allow-origin": "*" });
    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "replay", data: session.buffer, exited: session.exited });
    session.subscribers.add(send);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
    response.on("close", () => { clearInterval(keepAlive); session.subscribers.delete(send); });
  }

  closeAll() { for (const session of this.sessions.values()) { try { session.proc.kill(); } catch { /* gone */ } } this.sessions.clear(); }
}
