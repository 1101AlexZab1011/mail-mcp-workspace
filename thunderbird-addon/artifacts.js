// Artifacts space: the open artifact fills the main area; the library tree on
// the right organises ~/Artifacts into folders. Artifacts run in a sandboxed
// frame served by the workspace host; anything beyond the page (commands,
// local HTTP, files) goes through this page, which enforces the user's grants.
import { host, HOST_ENDPOINT, json } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, contextMenu, toast, background, registerPage, agentIsActing } from "./shared/page.js";

const stage = $("#stage");
const banner = $("#banner");
const treeEl = $("#tree");

const state = {
  tree: null,
  root: "",
  expanded: new Set(JSON.parse(localStorage.getItem("artifacts.expanded") ?? "[]")),
  current: null, // { path, meta, url, grant }
  frame: null,
  error: null,
  search: "",
  version: 0,
  shells: new Map(), // session → { offset, stop }
};

// ------------------------------------------------------------------ tree --

async function loadTree() {
  const { root, tree } = await host("/v1/artifacts/tree");
  state.tree = tree;
  state.root = root;
  $("#root-path").textContent = root.replace(/^\/home\/[^/]+/, "~");
  $("#root-path").title = root;
  renderTree();
  return tree;
}

function allArtifacts(node = state.tree, out = []) {
  for (const child of node?.children ?? []) { if (child.type === "artifact") out.push(child); else allArtifacts(child, out); }
  return out;
}

function renderTree() {
  const needle = state.search.toLowerCase();
  const rows = [];
  const walk = (node, depth) => {
    for (const child of node.children) {
      if (child.type === "folder") {
        const open = needle ? true : state.expanded.has(child.path);
        const inner = [];
        const saved = rows.length;
        walk(child, depth + 1);
        const kids = rows.splice(saved);
        if (needle && !kids.length && !child.name.toLowerCase().includes(needle)) continue;
        rows.push({ node: child, depth, open });
        if (open) rows.push(...kids);
        void inner;
      } else if (!needle || `${child.title} ${child.description} ${child.path} ${(child.tags ?? []).join(" ")}`.toLowerCase().includes(needle)) {
        rows.push({ node: child, depth });
      }
    }
  };
  if (state.tree) walk(state.tree, 0);
  if (!rows.length) { treeEl.replaceChildren(h("div.note", {}, state.search ? "No matches" : "No artifacts yet. Ask the agent to build one.")); return; }
  treeEl.replaceChildren(...rows.map(({ node, depth, open }) => {
    const folder = node.type === "folder";
    const twisty = icon("chevron_right", { size: 16 });
    twisty.classList.add("twisty");
    if (!folder) twisty.classList.add("none");
    const kind = icon(folder ? (open ? "folder_open" : "folder") : "artifact", { size: 18, fill: folder });
    kind.classList.add("kind");
    const row = h(`div.row.${node.type}`, {
      role: "treeitem", draggable: "true", title: folder ? node.path : `${node.title}\n${node.description ?? ""}\n${node.path}`,
      "aria-selected": String(state.current?.path === node.path), ...(folder ? { "aria-expanded": String(Boolean(open)) } : {}),
      dataset: { path: node.path, type: node.type }, style: { "--depth": depth },
    }, twisty, kind, h("span.name", {}, folder ? node.name : node.title));
    if (!folder && node.capabilities) { const lock = icon("lock", { size: 14 }); lock.classList.add("lock"); lock.setAttribute("aria-label", "Asks for extra permissions"); row.append(lock); }
    return row;
  }));
}

const nodeAt = (path, node = state.tree) => {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children ?? []) { const found = nodeAt(path, child); if (found) return found; }
  return null;
};

treeEl.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row) return;
  if (row.dataset.type === "folder") {
    if (state.expanded.has(row.dataset.path)) state.expanded.delete(row.dataset.path); else state.expanded.add(row.dataset.path);
    localStorage.setItem("artifacts.expanded", JSON.stringify([...state.expanded]));
    renderTree();
  } else void open(row.dataset.path);
});

treeEl.addEventListener("contextmenu", (event) => {
  const row = event.target.closest(".row");
  const path = row?.dataset.path ?? "";
  const folder = !row || row.dataset.type === "folder";
  contextMenu(event, [
    ...(!folder ? [{ label: "Open", icon: "play_arrow", run: () => open(path) }, { label: "View source", icon: "code", run: () => viewSource(path) }, "-"] : []),
    ...(folder ? [{ label: "New folder here", icon: "create_new_folder", run: () => newFolder(path) }, { label: "New artifact here", icon: "add", run: () => newArtifact(path) }] : []),
    ...(row ? [
      { label: "Rename", icon: "drive_file_rename", run: () => rename(path) },
      { label: "Move to…", icon: "folder_open", run: () => moveTo(path) },
      { label: "Show in file browser", icon: "preview", run: () => background("files-reveal", { path: `${state.root}/${path}` }) },
      "-",
      { label: "Move to trash", icon: "delete", danger: true, run: () => remove(path) },
    ] : []),
  ]);
});

// Drag an artifact or folder onto a folder to move it.
let dragged = null;
treeEl.addEventListener("dragstart", (event) => { dragged = event.target.closest(".row")?.dataset.path ?? null; event.dataTransfer.effectAllowed = "move"; });
treeEl.addEventListener("dragover", (event) => {
  const row = event.target.closest(".row");
  if (!dragged || (row && row.dataset.type !== "folder")) return;
  event.preventDefault();
  treeEl.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  row?.classList.add("drop-target");
});
treeEl.addEventListener("drop", async (event) => {
  event.preventDefault();
  const row = event.target.closest(".row");
  treeEl.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  const folder = row?.dataset.type === "folder" ? row.dataset.path : "";
  const from = dragged;
  dragged = null;
  if (!from || from === folder || folder.startsWith(`${from}/`)) return;
  const to = `${folder ? `${folder}/` : ""}${from.split("/").pop()}`;
  if (to === from) return;
  await host("/v1/artifacts/move", json({ path: from, to })).catch((error) => toast(error.message));
  if (state.current?.path === from) state.current.path = to;
  await loadTree();
});

$("#search").addEventListener("input", (event) => { state.search = event.target.value.trim(); renderTree(); });

// --------------------------------------------------------------- dialogs --

function dialog(title, body, actions, { userOnly = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) close(null); }, ...(userOnly ? { "data-user-only": "" } : {}) });
    const close = (value) => { backdrop.remove(); resolve(value); };
    const box = h("div.dialog", { role: "dialog", "aria-label": title }, h("h2", {}, title), body,
      h("div.actions", {}, ...actions.map((a) => h(`button.btn${a.primary ? ".primary" : ""}${a.danger ? ".danger" : ""}`, { type: "button", onclick: () => {
        if (userOnly && agentIsActing()) { toast("This needs your own click"); return; }
        close(a.value());
      } }, a.label))));
    backdrop.append(box);
    document.body.append(backdrop);
    backdrop.addEventListener("keydown", (e) => { if (e.key === "Escape") close(null); if (e.key === "Enter" && e.target.localName === "input") box.querySelector(".btn.primary")?.click(); });
    // A permission dialog never starts on its approving button: Enter must not approve.
    (box.querySelector("input") ?? (userOnly ? box.querySelector(".btn:not(.primary)") : box.querySelector(".btn.primary")))?.focus();
  });
}

async function prompt(title, label, value = "") {
  const input = h("input.input", { value, "aria-label": label });
  return dialog(title, h("label.field", {}, label, input), [{ label: "Cancel", value: () => null }, { label: "OK", primary: true, value: () => input.value.trim() || null }]);
}

async function newFolder(parent = "") {
  const name = await prompt("New folder", "Folder name");
  if (!name) return;
  const path = `${parent ? `${parent}/` : ""}${name.replace(/[/\\]/g, "-")}`;
  await host("/v1/artifacts/folder", json({ path })).catch((error) => toast(error.message));
  state.expanded.add(parent);
  await loadTree();
}

async function newArtifact(folder = "") {
  const title = h("input.input", { placeholder: "e.g. JSON formatter" });
  const description = h("input.input", { placeholder: "What should it do?" });
  const choice = await dialog("New artifact", h("div", {},
    h("label.field", {}, "Title", title),
    h("label.field", {}, "Description", description),
    h("p", {}, "Start from a blank React component, or let the agent build it from the description."),
  ), [
    { label: "Cancel", value: () => null },
    { label: "Ask the agent", value: () => "agent" },
    { label: "Blank", primary: true, value: () => "blank" },
  ]);
  if (!choice) return;
  if (choice === "agent") {
    await background("chat-draft", { text: `Build an artifact${folder ? ` in the "${folder}" folder` : ""}: ${title.value.trim() || "(untitled)"}. ${description.value.trim()}` });
    return;
  }
  const created = await host("/v1/artifacts", json({
    folder, title: title.value.trim() || "Untitled", description: description.value.trim(),
    files: { "App.tsx": `export default function App() {\n  return (\n    <main className="min-h-screen grid place-items-center bg-slate-50">\n      <h1 className="text-2xl font-semibold text-slate-800">${(title.value.trim() || "Untitled").replace(/[<>{}]/g, "")}</h1>\n    </main>\n  );\n}\n` },
  })).catch((error) => { toast(error.message); return null; });
  if (created) { await loadTree(); await open(created.path); }
}

async function rename(path) {
  const name = await prompt("Rename", "New name", path.split("/").pop());
  if (!name) return;
  const to = [...path.split("/").slice(0, -1), name.replace(/[/\\]/g, "-")].join("/");
  await host("/v1/artifacts/move", json({ path, to })).catch((error) => toast(error.message));
  if (state.current?.path === path) state.current.path = to;
  await loadTree();
}

async function moveTo(path) {
  const folders = [""];
  const walk = (node) => { for (const child of node.children ?? []) if (child.type === "folder") { folders.push(child.path); walk(child); } };
  walk(state.tree);
  const select = h("select.input", {}, ...folders.filter((f) => f !== path && !f.startsWith(`${path}/`)).map((f) => h("option", { value: f }, f || "Artifacts (top level)")));
  const target = await dialog("Move to folder", h("label.field", {}, "Folder", select), [{ label: "Cancel", value: () => null }, { label: "Move", primary: true, value: () => select.value }]);
  if (target === null || target === undefined) return;
  const to = `${target ? `${target}/` : ""}${path.split("/").pop()}`;
  if (to === path) return;
  await host("/v1/artifacts/move", json({ path, to })).catch((error) => toast(error.message));
  if (state.current?.path === path) state.current.path = to;
  await loadTree();
}

async function remove(path) {
  const ok = await dialog("Move to trash?", h("p", {}, `“${path}” goes to ~/Artifacts/.trash. You can restore it from there.`), [{ label: "Cancel", value: () => false }, { label: "Move to trash", danger: true, value: () => true }]);
  if (!ok) return;
  await host(`/v1/artifacts?path=${encodeURIComponent(path)}`, { method: "DELETE" }).catch((error) => toast(error.message));
  if (state.current?.path === path || state.current?.path.startsWith(`${path}/`)) showGallery();
  await loadTree();
}

async function viewSource(path) {
  const node = nodeAt(path);
  const item = await host(`/v1/artifacts/item?path=${encodeURIComponent(path)}`);
  await background("open-file", { path: `${state.root}/${path}/${item.meta.entry ?? "App.tsx"}` });
  void node;
}

// ---------------------------------------------------------------- running --

const CAPABILITY_TEXT = {
  exec: (c) => ({ icon: "terminal", title: "Run commands", detail: `in ${c.cwd} and its subfolders` }),
  fetch: (c) => ({ icon: "link", title: "Connect to local services", detail: c.origins.join(", ") }),
  fs: (c) => ({ icon: "folder_open", title: "Read and write files", detail: [...(c.read ?? []).map((p) => `read ${p}`), ...(c.write ?? []).map((p) => `write ${p}`)].join(" · ") }),
  agent: () => ({ icon: "smart_toy", title: "Send messages to your agent", detail: "into the chat, labelled with the artifact's name" }),
};

async function askGrant(declared) {
  const caps = Object.entries(declared ?? {}).map(([name, value]) => CAPABILITY_TEXT[name]?.(value)).filter(Boolean);
  return dialog("Allow this artifact?", h("div", {},
    h("p", {}, `“${state.current.meta.title}” asks for more than showing a page. It can do this until you revoke it or it asks for something different.`),
    h("div.caps", {}, ...caps.map((c) => h("div.cap", {}, icon(c.icon), h("div", {}, h("strong", {}, c.title), h("code", {}, c.detail))))),
  ), [{ label: "Don't allow", value: () => false }, { label: "Allow", primary: true, value: () => true }], { userOnly: true });
}

async function approveCurrent() {
  const declared = state.current.meta.capabilities;
  if (!(await askGrant(declared))) return false;
  await host("/v1/artifacts/grant", json({ path: state.current.path, declared }));
  state.current.grant = await host(`/v1/artifacts/grant?path=${encodeURIComponent(state.current.path)}`);
  renderHeader();
  return true;
}

async function revokeCurrent() {
  await host(`/v1/artifacts/grant?path=${encodeURIComponent(state.current.path)}`, { method: "DELETE" });
  state.current.grant = await host(`/v1/artifacts/grant?path=${encodeURIComponent(state.current.path)}`);
  for (const shell of state.shells.values()) shell.stop();
  state.shells.clear();
  renderHeader();
  toast("Permissions revoked");
}

function post(message) { state.frame?.contentWindow?.postMessage({ source: "mw-host", ...message }, "*"); }

async function capabilityCall(method, args) {
  const call = () => host("/v1/artifacts/call", json({ path: state.current.path, method, args }));
  try { return await call(); }
  catch (error) {
    if (error.code !== "needs_approval") throw error;
    if (!(await approveCurrent())) throw Object.assign(new Error("The user did not allow this"), { code: "denied" });
    return call();
  }
}

function followShell(session) {
  let stopped = false;
  let offset = 0;
  const shell = { stop: () => { stopped = true; } };
  state.shells.set(session, shell);
  (async () => {
    while (!stopped && state.current) {
      try {
        const read = await host("/v1/artifacts/call", json({ path: state.current.path, method: "shell.read", args: { session, offset, wait: 20000 } }));
        offset = read.next;
        for (const chunk of read.chunks) post({ type: "stream", session, chunk });
        if (read.closed) break;
      } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    state.shells.delete(session);
  })();
}

addEventListener("message", async (event) => {
  if (!state.frame || event.source !== state.frame.contentWindow) return;
  const message = event.data;
  if (message?.source !== "mw-artifact") return;
  if (message.type === "ready") { state.error = null; renderBanner(); return; }
  if (message.type === "error") { state.error = { kind: message.kind, message: message.message }; renderBanner(); return; }
  if (message.type !== "call") return;
  try {
    const value = await capabilityCall(message.method, message.args ?? {});
    if (message.method === "shell.open" && value?.session) followShell(value.session);
    post({ type: "result", id: message.id, value });
  } catch (error) {
    post({ type: "result", id: message.id, error: { message: error.message, code: error.code } });
  }
});

function renderBanner() {
  const error = state.error;
  banner.hidden = !error;
  if (!error) return;
  banner.replaceChildren(
    icon("error"),
    h("div.grow", {}, h("strong", {}, error.kind === "build" ? "This artifact doesn't build" : "This artifact hit an error"), h("pre", {}, error.message)),
    h("button.btn.tonal", { type: "button", onclick: () => background("chat-draft", { text: `The artifact "${state.current.meta?.title ?? state.current.path}" (${state.current.path}) fails:\n\n\`\`\`\n${error.message.slice(0, 4000)}\n\`\`\`\nPlease fix it.` }) }, icon("smart_toy", { size: 18 }), "Ask agent to fix"),
    iconButton("close", "Dismiss", () => { state.error = null; renderBanner(); }, { small: true }),
  );
}

function renderHeader() {
  const current = state.current;
  $("#glyph").replaceChildren(icon(current ? "artifact" : "widgets"));
  $("#title").textContent = current?.meta?.title ?? "Artifacts";
  $("#subtitle").textContent = current ? `${current.path}${current.meta?.description ? ` · ${current.meta.description}` : ""}` : "React pages your agent builds for you";
  const grant = $("#grant");
  const declared = current?.grant?.declared;
  grant.hidden = !declared;
  if (declared) {
    grant.className = `chip ${current.grant.approved ? "success" : "warning"}`;
    grant.replaceChildren(icon(current.grant.approved ? "verified_user" : "gpp_maybe", { size: 14 }), current.grant.approved ? "Permissions allowed" : "Needs permission");
    grant.title = Object.keys(declared).join(", ");
    grant.style.cursor = "pointer";
    grant.onclick = () => (current.grant.approved ? revokeCurrent() : approveCurrent());
    grant.dataset.userOnly = "";
  }
  $("#actions").replaceChildren(...(current ? [
    iconButton("refresh", "Reload", () => open(current.path, { force: true })),
    iconButton("code", "View source", () => viewSource(current.path)),
    iconButton("smart_toy", "Ask the agent to change it", () => background("chat-draft", { text: `Change the artifact "${current.meta.title}" (${current.path}): ` })),
    iconButton("open_in_new", "Open in its own window", () => window.open(current.url, "_blank", "noopener")),
    iconButton("close", "Close", showGallery),
  ] : [iconButton("add", "New artifact", () => newArtifact(""))]),
  iconButton($("#sidebar").classList.contains("collapsed") ? "right_panel_open" : "right_panel_close", "Toggle library", toggleSidebar));
}

function toggleSidebar() {
  $("#sidebar").classList.toggle("collapsed");
  localStorage.setItem("artifacts.sidebar", $("#sidebar").classList.contains("collapsed") ? "collapsed" : "open");
  renderHeader();
}

async function open(path, { force = false } = {}) {
  if (!force && state.current?.path === path && state.frame) return { path };
  for (const shell of state.shells.values()) shell.stop();
  state.shells.clear();
  stage.replaceChildren(h("div.loading", {}, h("div.spinner"), h("span", {}, "Building…")));
  state.error = null;
  try {
    const launched = await host("/v1/artifacts/launch", json({ path }));
    state.current = { path, meta: launched.meta, url: `${HOST_ENDPOINT}${launched.url}`, grant: launched.grant };
    const frame = h("iframe", { src: state.current.url, sandbox: "allow-scripts allow-forms allow-modals allow-popups allow-downloads", title: launched.meta.title, allow: "clipboard-write" });
    state.frame = frame;
    stage.replaceChildren(frame);
    localStorage.setItem("artifacts.last", path);
  } catch (error) {
    const meta = await host(`/v1/artifacts/item?path=${encodeURIComponent(path)}`).then((item) => item.meta).catch(() => ({ title: path }));
    state.current = { path, meta, url: null, grant: null };
    state.frame = null;
    state.error = { kind: "build", message: error.message };
    stage.replaceChildren(h("div.loading", {}, icon("bug_report"), h("span", {}, "Fix the error above, or ask the agent to.")));
  }
  // Expand the folders leading to it and select it in the tree.
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join("/"));
  renderTree();
  renderHeader();
  renderBanner();
  return { path, title: state.current.meta?.title, error: state.error?.message ?? null };
}

function showGallery() {
  for (const shell of state.shells.values()) shell.stop();
  state.shells.clear();
  state.current = null;
  state.frame = null;
  state.error = null;
  renderBanner();
  renderHeader();
  renderTree();
  const recent = allArtifacts().sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 12);
  stage.replaceChildren(h("div.gallery", {},
    h("h2", {}, "Artifacts"),
    h("p", {}, "Small apps built for a task: a test shell, a converter, a dashboard. Ask the agent to build one; it files it into the library on the right."),
    h("div.start-actions", {},
      h("button.btn.primary", { type: "button", onclick: () => background("chat-draft", { text: "Build an artifact: " }) }, icon("smart_toy", { size: 18 }), "Ask the agent to build one"),
      h("button.btn", { type: "button", onclick: () => newArtifact("") }, icon("add", { size: 18 }), "New blank artifact"),
      h("button.btn", { type: "button", onclick: () => newFolder("") }, icon("create_new_folder", { size: 18 }), "New folder")),
    recent.length ? h("h3", {}, "Recently changed") : null,
    h("div.cards", {}, ...recent.map((item) => h("button.card-item", { type: "button", onclick: () => open(item.path) },
      h("div.top", {}, icon("artifact"), h("strong", {}, item.title)),
      item.description ? h("div.desc", {}, item.description) : null,
      h("div.where", {}, item.path)))),
  ));
}

// Live reload: the host reports changes under ~/Artifacts.
async function watch() {
  for (;;) {
    try {
      const { version, paths } = await host(`/v1/artifacts/changes?since=${state.version}&wait=25000`);
      const changed = version !== state.version;
      state.version = version;
      if (!changed) continue;
      await loadTree();
      if (state.current && paths.some((p) => p === state.current.path || p.startsWith(`${state.current.path}/`))) await open(state.current.path, { force: true });
      else if (!state.current) showGallery();
    } catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
}

// ------------------------------------------------------------- agent API --

registerPage("artifacts", {
  state: () => ({ open: state.current ? { path: state.current.path, title: state.current.meta?.title, grant: state.current.grant, error: state.error } : null, root: state.root, count: allArtifacts().length, sidebar: !$("#sidebar").classList.contains("collapsed") }),
  commands: {
    open: ({ query, path }) => open(query ?? path, { force: true }),
    reload: () => (state.current ? open(state.current.path, { force: true }) : loadTree()),
    close: () => { showGallery(); return { ok: true }; },
    sidebar: ({ open: show }) => { if (Boolean(show) === $("#sidebar").classList.contains("collapsed")) toggleSidebar(); return { sidebar: !$("#sidebar").classList.contains("collapsed") }; },
    tree: () => loadTree(),
  },
});

// ------------------------------------------------------------------ start --

$("#side-actions").replaceChildren(
  iconButton("add", "New artifact", () => newArtifact(""), { small: true }),
  iconButton("create_new_folder", "New folder", () => newFolder(""), { small: true }),
  iconButton("refresh", "Refresh", loadTree, { small: true }),
);
$(".side-search").prepend(icon("search", { size: 18 }));
if (localStorage.getItem("artifacts.sidebar") === "collapsed") $("#sidebar").classList.add("collapsed");
await loadTree().catch((error) => treeEl.replaceChildren(h("div.note", {}, error.message)));
const initial = new URLSearchParams(location.search).get("path") ?? localStorage.getItem("artifacts.last");
if (initial && nodeAt(initial)) await open(initial); else showGallery();
void watch();
