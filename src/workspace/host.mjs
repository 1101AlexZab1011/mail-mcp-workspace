// Mail Workspace host: the local service behind the file browser, the viewer
// and artifacts. Loopback only. Every API call carries a listener-mcp token;
// the host asks the broker who it belongs to and checks its scopes:
//
//   read:mail/workspace/files          browse, stat, read, highlight, convert, link
//   read:mail/workspace/artifacts      artifact tree and sources
//   publish:mail/workspace/artifacts   create, update, move, delete, launch
//   publish:mail/workspace/grants      approve or revoke artifact capabilities
//   publish:mail/workspace/capabilities run granted capabilities
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

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PATCH, DELETE", vary: "Origin" }
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
      send(response, status, { error: { code: error.code && typeof error.code === "string" ? error.code : "error", message: error.message, ...(error.declared ? { declared: error.declared } : {}) } }, cors);
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); });
  const actualPort = server.address().port;
  if (actualPort !== port) { allowedHosts.add(`127.0.0.1:${actualPort}`); allowedHosts.add(`localhost:${actualPort}`); }
  log(`mail-workspace host listening on http://127.0.0.1:${actualPort} (artifacts: ${store.root})`);
  return { server, port: actualPort, store, capabilities, terminals, close: () => new Promise((r) => { watcher?.close(); capabilities.closeAll(); terminals.closeAll(); for (const wake of changeWaiters) wake(); server.closeAllConnections?.(); server.close(r); }) };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
