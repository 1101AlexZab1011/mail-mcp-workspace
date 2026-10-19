// Mail Workspace host: the local service behind the file browser, the viewer
// and artifacts. Loopback only. Every API call carries a listener-mcp token;
// the host asks the broker who it belongs to and checks its scopes:
//
//   read:mail/workspace/files          browse, stat, read, highlight, convert, link
//   read:mail/workspace/artifacts      artifact tree and sources
//   publish:mail/workspace/artifacts   create, update, move, delete, launch
//   publish:mail/workspace/grants      approve or revoke artifact capabilities
//   publish:mail/workspace/capabilities run granted capabilities
//   publish:mail/workspace/fs          write, edit, create folders, move (inside the home folder)
//   publish:mail/workspace/fs-trash    move to the Trash and restore (the add-on only: the
//                                      agent trashes through the GUI, which asks the user)
//   publish:mail/workspace/render      render Quarto documents
//   publish:mail/workspace/review      supervisor review of a passage (runs Claude Code headless)
//
// The add-on's token has all of them; the agent's token lacks the last two, so
// an agent can write an artifact but never approve what it may do.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync, watch } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matches } from "listener-mcp";
import { expand, listDirectory, mimeOf, readText, statPath, complete } from "./files.mjs";
import { CODE_THEMES, DEFAULT_CODE_THEME, highlight } from "./highlight.mjs";
import { needsConversion, toPdf } from "./convert.mjs";
import { readSheet } from "./sheet.mjs";
import { ArtifactStore } from "./artifacts.mjs";
import { Capabilities } from "./capabilities.mjs";
import { Terminals } from "./terminal.mjs";
import { FileWriter, versionOf, waitForChange } from "./writes.mjs";
import { Writer } from "./writer.mjs";
import { Slides } from "./slides.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const here = dirname(fileURLToPath(import.meta.url));
const modules = join(projectRoot, "node_modules");
export const DEFAULT_HOST_PORT = 47810;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

function send(response, status, value, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  response.end(JSON.stringify(value));
}

async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "too_large", "Request body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "bad_request", "Body must be JSON"); }
}

/** Map of Material Icon Theme lookups, compact enough for the file browser to load once. */
function iconTheme() {
  const theme = JSON.parse(readFileSync(join(modules, "material-icon-theme/dist/material-icons.json"), "utf8"));
  const nameOf = (id) => theme.iconDefinitions[id]?.iconPath?.replace(/^.*\/icons\//, "").replace(/\.svg$/, "") ?? null;
  const mapValues = (object = {}) => Object.fromEntries(Object.entries(object).map(([key, id]) => [key, nameOf(id)]).filter(([, value]) => value));
  return {
    file: nameOf(theme.file),
    folder: nameOf(theme.folder),
    folderExpanded: nameOf(theme.folderExpanded),
    fileExtensions: mapValues(theme.fileExtensions),
    fileNames: mapValues(theme.fileNames),
    folderNames: mapValues(theme.folderNames),
    folderNamesExpanded: mapValues(theme.folderNamesExpanded),
    languageIds: mapValues(theme.languageIds),
  };
}

export async function startHost({
  port = DEFAULT_HOST_PORT,
  brokerUrl = process.env.LISTENER_MCP_URL ?? "http://127.0.0.1:47800",
  artifactsRoot = process.env.MAIL_WORKSPACE_ARTIFACTS ?? join(homedir(), "Artifacts"),
  cacheDir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "mail-workspace"),
  grantsPath,
  filesRoot = process.env.MAIL_WORKSPACE_FILES_ROOT ?? homedir(),
  trashDir,
  log = () => {},
} = {}) {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const store = new ArtifactStore(artifactsRoot);
  await mkdir(store.root, { recursive: true });
  const publishToAgent = async (text, token) => {
    const response = await fetch(`${brokerUrl}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ channel: "mail/chat/default", type: "message", data: { text } }) });
    if (!response.ok) throw new HttpError(502, "broker_error", `The broker refused the message (${response.status})`);
    return { sent: true };
  };
  const capabilities = new Capabilities({ grantsPath, publishToAgent });
  const terminals = new Terminals();
  const theme = iconTheme();
  const writer = new FileWriter({ root: filesRoot, trashDir });
  const documents = new Writer({ files: writer, cacheDir, log });
  const decks = new Slides({ files: writer });

  // --- auth: tokens are listener-mcp tokens, verified by the broker, cached briefly.
  const principals = new Map();
  async function principalOf(request) {
    const header = String(request.headers.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new HttpError(401, "unauthorized", "A listener-mcp token is required");
    const key = createHash("sha256").update(token).digest("hex");
    const cached = principals.get(key);
    if (cached && cached.until > Date.now()) return { ...cached.principal, token };
    const response = await fetch(`${brokerUrl}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    if (!response) throw new HttpError(503, "broker_unavailable", "The listener-mcp broker is not reachable");
    if (!response.ok) throw new HttpError(401, "unauthorized", "Unknown token");
    const principal = await response.json();
    principals.set(key, { principal, until: Date.now() + 60_000 });
    return { ...principal, token };
  }
  const allowed = (principal, action, channel) => principal.scopes.includes("admin") || principal.scopes.some((scope) => scope.startsWith(`${action}:`) && matches(scope.slice(action.length + 1), channel));
  const need = (principal, action, channel) => { if (!allowed(principal, action, channel)) throw new HttpError(403, "forbidden", `Token "${principal.name}" lacks ${action}:${channel}`); };

  // --- capability URLs: unguessable, short-lived paths for <video>, <img>, pdf.js and artifact frames.
  const links = new Map();
  const mint = (entry, ttl = 60 * 60_000) => {
    const id = randomBytes(18).toString("base64url");
    links.set(id, { ...entry, until: Date.now() + ttl });
    return id;
  };
  setInterval(() => { const now = Date.now(); for (const [id, entry] of links) if (entry.until < now) links.delete(id); }, 60_000).unref();

  // --- artifact change feed for live reload.
  let version = 0;
  const changed = new Map();
  let changeWaiters = [];
  let watcher = null;
  try {
    watcher = watch(store.root, { recursive: true }, (_event, file) => {
      if (!file || file.startsWith(".trash")) return;
      version++;
      changed.set(version, String(file).split("/").slice(0, -1).join("/"));
      if (changed.size > 500) changed.delete(changed.keys().next().value);
      for (const wake of changeWaiters) wake();
      changeWaiters = [];
    });
  } catch (error) { log(`artifact watch unavailable: ${error.message}`); }

  const routes = [];
  const route = (method, path, handler, { auth = true } = {}) => routes.push({ method, path, handler, auth });

  route("GET", "/v1/health", () => ({ ok: true, service: "mail-workspace-host", artifacts: store.root }), { auth: false });

  // Icons (public, static)
  route("GET", "/icons/theme.json", () => theme, { auth: false });
  route("GET", /^\/icons\/([a-z0-9_.-]+)\.svg$/, async ({ response, match }) => {
    const file = join(modules, "material-icon-theme/icons", `${match[1]}.svg`);
    const body = await readFile(file).catch(() => { throw new HttpError(404, "not_found", "No such icon"); });
    response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" });
    response.end(body);
  }, { auth: false });

  // Files
  route("GET", "/v1/fs/list", async ({ url, principal }) => {
    need(principal, "read", "mail/workspace/files");
    return listDirectory(url.searchParams.get("path") ?? "~", { hidden: url.searchParams.get("hidden") === "1" });
  });
  route("GET", "/v1/fs/stat", async ({ url, principal }) => { need(principal, "read", "mail/workspace/files"); return statPath(url.searchParams.get("path")); });
  route("GET", "/v1/fs/complete", async ({ url, principal }) => { need(principal, "read", "mail/workspace/files"); return { paths: await complete(url.searchParams.get("path") ?? "~/") }; });
  route("GET", "/v1/fs/read", async ({ url, principal }) => {
    need(principal, "read", "mail/workspace/files");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 5 * 1024 * 1024), 50 * 1024 * 1024);
    return readText(url.searchParams.get("path"), { limit });
  });
  route("GET", "/v1/fs/highlight", async ({ url, principal }) => {
    need(principal, "read", "mail/workspace/files");
    const path = url.searchParams.get("path");
    const info = await statPath(path);
    const { text, truncated } = await readText(path, { limit: 1024 * 1024 });
    const result = await highlight(text, url.searchParams.get("lang") ?? info.language, url.searchParams.get("theme") ?? undefined);
    return { ...result, language: info.language, truncated, lines: text.split("\n").length };
  });
  // Highlight a snippet (theme previews in Settings).
  route("POST", "/v1/highlight", async ({ request, principal }) => {
    need(principal, "read", "mail/workspace/files");
    const { code = "", lang = "typescript", theme } = await readJson(request, 64 * 1024);
    return highlight(String(code).slice(0, 20_000), lang, theme);
  });
  route("GET", "/v1/code-themes", () => ({ themes: CODE_THEMES.map(([id, name]) => ({ id, name })), default: DEFAULT_CODE_THEME }), { auth: false });
  route("GET", "/v1/fs/sheet", async ({ url, principal }) => { need(principal, "read", "mail/workspace/files"); return readSheet(expand(url.searchParams.get("path"))); });
  route("POST", "/v1/links", async ({ request, principal }) => {
    need(principal, "read", "mail/workspace/files");
    const { path, convert } = await readJson(request);
    const full = expand(path);
    const info = await stat(full);
    if (info.isDirectory()) throw new HttpError(400, "bad_request", "Cannot link a directory");
    let target = full;
    let mime = mimeOf(full);
    if (convert === "pdf" && needsConversion(full)) {
      target = await toPdf(full, cacheDir).catch((error) => { throw new HttpError(422, "conversion_failed", error.message); });
      mime = "application/pdf";
    }
    const id = mint({ path: target, mime });
    return { url: `/f/${id}/${encodeURIComponent(basename(target))}`, mime, size: (await stat(target)).size };
  });
  route("GET", /^\/f\/([A-Za-z0-9_-]+)\/[^/]*$/, async ({ request, response, match }) => {
    const entry = links.get(match[1]);
    if (!entry || entry.until < Date.now()) throw new HttpError(404, "not_found", "Link expired");
    const info = await stat(entry.path);
    const headers = {
      "content-type": entry.mime, "accept-ranges": "bytes", "cache-control": "private, max-age=600",
      "x-content-type-options": "nosniff", "access-control-allow-origin": "*",
      // An SVG or HTML file opened directly must not run scripts.
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
      start = Math.max(0, start); end = Math.min(end, info.size - 1);
      if (start > end) { response.writeHead(416, { "content-range": `bytes */${info.size}` }); return response.end(); }
      response.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": end - start + 1 });
      createReadStream(entry.path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, "content-length": info.size });
    createReadStream(entry.path).pipe(response);
  }, { auth: false });

  // Writing (publish:mail/workspace/fs). Confined to the home folder; see writes.mjs.
  const fsWrite = (principal) => need(principal, "publish", "mail/workspace/fs");
  route("PUT", "/v1/fs/file", async ({ request, principal }) => {
    fsWrite(principal);
    const { path, text: content, base64, expect, create, createDirs } = await readJson(request, 64 * 1024 * 1024);
    return writer.write(path, { text: content, base64, expect, create, createDirs });
  });
  // The same as PUT /v1/fs/file for large binaries (exports, media): the body is the file's bytes.
  route("PUT", "/v1/fs/raw", async ({ url, request, principal }) => {
    fsWrite(principal);
    const p = url.searchParams;
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 ** 3) throw new HttpError(413, "too_large", "Files over 2 GB are not written here");
      chunks.push(chunk);
    }
    return writer.write(p.get("path"), { bytes: Buffer.concat(chunks), expect: p.get("expect") ?? undefined, createDirs: p.get("createDirs") === "1" });
  });
  route("POST", "/v1/fs/edit", async ({ request, principal }) => {
    fsWrite(principal);
    const { path, oldString, newString, all, expect } = await readJson(request);
    return writer.edit(path, { oldString, newString, all, expect });
  });
  route("POST", "/v1/fs/mkdir", async ({ request, principal }) => { fsWrite(principal); return writer.mkdir((await readJson(request)).path); });
  route("POST", "/v1/fs/move", async ({ request, principal }) => {
    fsWrite(principal);
    const { from, to, overwrite } = await readJson(request);
    return writer.move(from, to, { overwrite });
  });
  const fsTrash = (principal) => need(principal, "publish", "mail/workspace/fs-trash");
  route("POST", "/v1/fs/trash", async ({ request, principal }) => { fsTrash(principal); return writer.trash((await readJson(request)).path); });
  route("POST", "/v1/fs/restore", async ({ request, principal }) => { fsTrash(principal); return writer.restore((await readJson(request)).name); });
  route("GET", "/v1/fs/trash", async ({ url, principal }) => { need(principal, "read", "mail/workspace/files"); return { entries: await writer.trashed({ limit: Number(url.searchParams.get("limit") ?? 50) }) }; });
  // The version an editor passes back as `expect`, and a long-poll for changes to one file.
  route("GET", "/v1/fs/version", async ({ url, principal }) => { need(principal, "read", "mail/workspace/files"); return versionOf(expand(url.searchParams.get("path"))); });
  route("GET", "/v1/fs/watch", async ({ request, url, principal }) => {
    need(principal, "read", "mail/workspace/files");
    const controller = new AbortController();
    request.on("close", () => controller.abort());
    const wait = Math.min(Number(url.searchParams.get("wait") ?? 25_000), 25_000);
    return waitForChange(expand(url.searchParams.get("path")), url.searchParams.get("since"), { waitMs: wait, signal: controller.signal });
  });

  // Writer: Quarto rendering, bibliographies, grammar (see writer.mjs).
  route("POST", "/v1/writer/render", async ({ request, principal }) => {
    need(principal, "publish", "mail/workspace/render");
    const { path, to } = await readJson(request);
    return documents.render(await writer.target(path), { to });
  });
  route("GET", "/v1/writer/render", async ({ url, principal }) => { need(principal, "read", "mail/workspace/files"); return documents.renderStatus(expand(url.searchParams.get("path"))); });
  route("GET", "/v1/writer/bibliography", async ({ url, principal }) => { need(principal, "read", "mail/workspace/files"); return documents.bibliography(expand(url.searchParams.get("path"))); });
  route("POST", "/v1/writer/grammar", async ({ request, principal }) => {
    need(principal, "read", "mail/workspace/files");
    const { text: content, language } = await readJson(request, 2 * 1024 * 1024);
    return documents.grammar(content, { language });
  });
  route("POST", "/v1/writer/review", async ({ request, principal }) => {
    need(principal, "publish", "mail/workspace/review");
    return documents.review(await readJson(request, 512 * 1024));
  });
  // Slides: decks that are not open in the editor (an open deck is edited through the page).
  route("GET", "/v1/slides/read", async ({ url, principal }) => {
    need(principal, "read", "mail/workspace/files");
    const p = url.searchParams;
    const number = (key) => (p.has(key) ? Number(p.get(key)) : undefined);
    return decks.read(p.get("path"), { from: number("from"), to: number("to"), html: p.get("html") === "1" });
  });
  route("POST", "/v1/slides/apply", async ({ request, principal }) => {
    fsWrite(principal);
    const { path, ops, expect } = await readJson(request, 8 * 1024 * 1024);
    return decks.apply(path, ops, { expect });
  });
  route("POST", "/v1/slides/new", async ({ request, principal }) => {
    fsWrite(principal);
    const { path, title } = await readJson(request);
    return decks.create(path, { title });
  });
  // Script elements: the Slides page asks for a frame address; the frame itself is served without auth,
  // sandboxed (opaque origin) and with a CSP that allows no network at all.
  const SCRIPT_LIBS = { d3: join(modules, "d3/dist/d3.min.js"), three: join(modules, "three/build/three.module.min.js") };
  route("POST", "/v1/slides/script", async ({ request, principal }) => {
    need(principal, "read", "mail/workspace/files");
    const { deck, src, code, libs = [] } = await readJson(request, 4 * 1024 * 1024);
    const text = typeof code === "string" ? code : await decks.scriptCode(deck, src);
    const wanted = (Array.isArray(libs) ? libs : []).filter((lib) => SCRIPT_LIBS[lib]);
    const id = mint({ script: text }, 12 * 60 * 60_000);
    const hash = createHash("sha256").update(text).digest("hex");
    return { url: `/s/${id}/${wanted.length ? `?libs=${wanted.join(",")}` : ""}`, hash };
  });
  route("GET", /^\/s\/([A-Za-z0-9_-]+)\/(runtime\.js|script\.js|lib\/(d3|three)\.js)?$/, async ({ request, response, match }) => {
    const entry = links.get(match[1]);
    if (!entry || entry.script === undefined || entry.until < Date.now()) throw new HttpError(404, "not_found", "This script link expired");
    const scriptHeaders = { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
    if (match[2] === "runtime.js") {
      response.writeHead(200, scriptHeaders);
      return createReadStream(join(here, "script-runtime.js")).pipe(response);
    }
    if (match[2] === "script.js") {
      response.writeHead(200, scriptHeaders);
      return response.end(entry.script);
    }
    if (match[3]) {
      response.writeHead(200, { ...scriptHeaders, "cache-control": "public, max-age=86400" });
      return createReadStream(SCRIPT_LIBS[match[3]]).pipe(response);
    }
    const self = `http://${request.headers.host}`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src ${self}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'`,
    });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Script</title></head><body><script type="module" src="runtime.js"></script></body></html>`);
  }, { auth: false });
  route("GET", "/v1/slides/fonts", async ({ principal }) => { need(principal, "read", "mail/workspace/files"); return { fonts: await decks.fonts() }; });
  route("POST", "/v1/slides/rewrite", async ({ request, principal }) => {
    need(principal, "publish", "mail/workspace/review");
    return decks.rewrite(await readJson(request, 256 * 1024));
  });
  route("GET", "/v1/writer/words", async ({ principal }) => { need(principal, "read", "mail/workspace/files"); return { words: await documents.words() }; });
  route("POST", "/v1/writer/words", async ({ request, principal }) => {
    need(principal, "publish", "mail/workspace/fs");
    const { add, remove } = await readJson(request);
    return { words: await documents.updateWords({ add, remove }) };
  });

  // Opening a file in its default application is an action on the desktop, so it
  // needs a publish scope (the add-on has it; the agent does not).
  route("POST", "/v1/open", async ({ request, principal }) => {
    need(principal, "publish", "mail/workspace/open");
    const full = expand((await readJson(request)).path);
    await stat(full);
    const { spawn } = await import("node:child_process");
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [full], { detached: true, stdio: "ignore" }).unref();
    return { opened: full };
  });

  // Terminals (publish:mail/workspace/terminal): the panel and the agent share them.
  const term = (principal) => need(principal, "publish", "mail/workspace/terminal");
  route("GET", "/v1/term", ({ principal }) => { term(principal); return { terminals: terminals.list() }; });
  route("POST", "/v1/term", async ({ request, principal }) => { term(principal); return terminals.create(await readJson(request)); });
  route("POST", /^\/v1\/term\/([\w-]+)\/input$/, async ({ request, principal, match }) => { term(principal); return terminals.input(match[1], (await readJson(request)).data); });
  route("POST", /^\/v1\/term\/([\w-]+)\/resize$/, async ({ request, principal, match }) => { term(principal); const { cols, rows } = await readJson(request); return terminals.resize(match[1], cols, rows); });
  route("POST", /^\/v1\/term\/([\w-]+)\/run$/, async ({ request, principal, match }) => { term(principal); return terminals.run(match[1], await readJson(request)); });
  route("GET", /^\/v1\/term\/([\w-]+)\/read$/, ({ url, principal, match }) => { term(principal); return terminals.read(match[1], { lines: url.searchParams.get("lines") ?? 200 }); });
  route("POST", /^\/v1\/term\/([\w-]+)\/ticket$/, ({ principal, match }) => { term(principal); return { ticket: terminals.ticket(match[1]) }; });
  route("DELETE", /^\/v1\/term\/([\w-]+)$/, ({ principal, match }) => { term(principal); return terminals.close(match[1]); });
  route("GET", /^\/v1\/term-stream\/([\w-]+)$/, ({ response, match }) => { terminals.stream(match[1], response); }, { auth: false });

  // Artifacts
  route("GET", "/v1/artifacts/tree", async ({ principal }) => { need(principal, "read", "mail/workspace/artifacts"); return { root: store.root, tree: await store.tree() }; });
  route("GET", "/v1/artifacts/item", async ({ url, principal }) => { need(principal, "read", "mail/workspace/artifacts"); return store.read(url.searchParams.get("path")); });
  route("POST", "/v1/artifacts", async ({ request, principal }) => { need(principal, "publish", "mail/workspace/artifacts"); return store.create(await readJson(request)); });
  route("PATCH", "/v1/artifacts", async ({ request, principal }) => { need(principal, "publish", "mail/workspace/artifacts"); const body = await readJson(request); return store.update(body.path, body); });
  route("POST", "/v1/artifacts/move", async ({ request, principal }) => { need(principal, "publish", "mail/workspace/artifacts"); const { path, to } = await readJson(request); return store.move(path, to); });
  route("POST", "/v1/artifacts/folder", async ({ request, principal }) => { need(principal, "publish", "mail/workspace/artifacts"); return store.mkdir((await readJson(request)).path); });
  route("DELETE", "/v1/artifacts", async ({ url, principal }) => { need(principal, "publish", "mail/workspace/artifacts"); return store.remove(url.searchParams.get("path")); });
  route("GET", "/v1/artifacts/changes", async ({ url, principal }) => {
    need(principal, "read", "mail/workspace/artifacts");
    const since = Number(url.searchParams.get("since") ?? version);
    if (since >= version) await new Promise((resolveWait) => { changeWaiters.push(resolveWait); setTimeout(resolveWait, Math.min(Number(url.searchParams.get("wait") ?? 25_000), 25_000)); });
    const paths = [...new Set([...changed].filter(([v]) => v > since).map(([, path]) => path))];
    return { version, paths };
  });
  route("POST", "/v1/artifacts/launch", async ({ request, principal }) => {
    need(principal, "read", "mail/workspace/artifacts");
    const { path } = await readJson(request);
    const { code, meta } = await store.bundle(path);
    const id = mint({ artifact: path, code, meta }, 12 * 60 * 60_000);
    const grant = await capabilities.status(path, meta.capabilities);
    return { url: `/a/${id}/`, meta, grant };
  });
  route("GET", /^\/a\/([A-Za-z0-9_-]+)\/(bundle\.js|tailwind\.js)?$/, async ({ request, response, match }) => {
    const entry = links.get(match[1]);
    if (!entry?.code) throw new HttpError(404, "not_found", "This artifact link expired; reopen the artifact");
    if (match[2] === "bundle.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return response.end(entry.code);
    }
    if (match[2] === "tailwind.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" });
      return createReadStream(join(modules, "@tailwindcss/browser/dist/index.global.js")).pipe(response);
    }
    const self = `http://${request.headers.host}`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The page may run its own code but may not connect anywhere: capabilities
      // go through the parent frame, which enforces the grants.
      "content-security-policy": `default-src 'none'; script-src ${self} 'unsafe-inline'; style-src 'unsafe-inline' ${self}; img-src data: blob: ${self}; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'`,
    });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(entry.meta.title ?? "Artifact")}</title>
<style>html,body{margin:0;min-height:100%}body{font:14px/1.5 system-ui,sans-serif}#root{min-height:100vh}</style>
<script src="tailwind.js"></script></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`);
  }, { auth: false });
  route("GET", "/v1/artifacts/grant", async ({ url, principal }) => {
    need(principal, "read", "mail/workspace/artifacts");
    const path = url.searchParams.get("path");
    const { meta } = await store.read(path);
    return capabilities.status(path, meta.capabilities);
  });
  route("POST", "/v1/artifacts/grant", async ({ request, principal }) => {
    need(principal, "publish", "mail/workspace/grants");
    const { path, declared } = await readJson(request);
    const { meta } = await store.read(path);
    // Approve exactly what the user was shown; if the artifact changed since, ask again.
    if (JSON.stringify(canonicalize(meta.capabilities)) !== JSON.stringify(canonicalize(declared))) throw new HttpError(409, "changed", "The artifact's capabilities changed; review them again");
    return capabilities.approve(path, meta.capabilities);
  });
  route("DELETE", "/v1/artifacts/grant", async ({ url, principal }) => { need(principal, "publish", "mail/workspace/grants"); return capabilities.revoke(url.searchParams.get("path")); });
  route("POST", "/v1/artifacts/call", async ({ request, principal }) => {
    need(principal, "publish", "mail/workspace/capabilities");
    const { path, method, args } = await readJson(request);
    const { meta } = await store.read(path);
    return capabilities.call(path, meta.capabilities, method, args, { token: principal.token });
  });

  const { canonical: canonicalize } = await import("./capabilities.mjs");

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://host");
    const origin = request.headers.origin;
    // Extension pages and sandboxed artifact frames only; web pages get nothing.
    const cors = typeof origin === "string" && origin.startsWith("moz-extension://")
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE", vary: "Origin" }
      : {};
    try {
      if (!allowedHosts.has(String(request.headers.host ?? "").toLowerCase())) throw new HttpError(403, "forbidden", "Unexpected Host header");
      if (typeof origin === "string" && origin !== "null" && !cors["access-control-allow-origin"]) throw new HttpError(403, "forbidden", "Origin not allowed");
      if (request.method === "OPTIONS") { response.writeHead(204, cors); return response.end(); }
      const found = routes.find((r) => r.method === request.method && (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname)));
      if (!found) throw new HttpError(404, "not_found", "No such endpoint");
      const principal = found.auth ? await principalOf(request) : null;
      const match = typeof found.path === "string" ? null : url.pathname.match(found.path);
      const result = await found.handler({ request, response, url, principal, match });
      if (result !== undefined) send(response, 200, result, cors);
    } catch (error) {
      const status = error.status ?? (error.code === "ENOENT" ? 404 : error.code === "EACCES" ? 403 : 500);
      if (status === 500) log(`error: ${error.stack ?? error}`);
      send(response, status, { error: { code: error.code && typeof error.code === "string" ? error.code : "error", message: error.message, ...(error.declared ? { declared: error.declared } : {}), ...(error.current ? { current: error.current } : {}) } }, cors);
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); });
  const actualPort = server.address().port;
  if (actualPort !== port) { allowedHosts.add(`127.0.0.1:${actualPort}`); allowedHosts.add(`localhost:${actualPort}`); }
  log(`mail-workspace host listening on http://127.0.0.1:${actualPort} (artifacts: ${store.root})`);
  return { server, port: actualPort, store, capabilities, terminals, close: () => new Promise((r) => { watcher?.close(); capabilities.closeAll(); terminals.closeAll(); documents.close(); for (const wake of changeWaiters) wake(); server.closeAllConnections?.(); server.close(r); }) };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
