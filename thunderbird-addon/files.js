// File browser dock: a path bar (click any ancestor to go up, or type a path)
// over a VS Code-style tree with Material Icon Theme icons.
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, contextMenu, background, toast, formatSize, registerPage, watchDockWidth } from "./shared/page.js";

const tree = $("#tree");
const crumbs = $("#crumbs");
const pathEdit = $("#path-edit");
const pathInput = $("#path-input");
const completions = $("#completions");
const filterInput = $("#filter");
const status = $("#status");

const state = {
  root: null,
  home: null,
  hidden: false,
  filter: "",
  expanded: new Set(),
  children: new Map(), // path → entries | { error }
  loading: new Set(),
  selected: new Set(),
  cursor: null,
  dock: "open",
};
let theme = null;

// ------------------------------------------------------------------ icons --

async function loadTheme() {
  theme = await fetch(`${HOST_ENDPOINT}/icons/theme.json`).then((r) => r.json()).catch(() => null);
}

function iconFor(entry, open = false) {
  const url = (name) => `${HOST_ENDPOINT}/icons/${name}.svg`;
  if (!theme) return url(entry.directory ? "folder" : "file");
  const name = entry.name.toLowerCase();
  if (entry.directory) {
    const map = open ? theme.folderNamesExpanded : theme.folderNames;
    return url(map[name] ?? (open ? theme.folderExpanded : theme.folder));
  }
  if (theme.fileNames[name]) return url(theme.fileNames[name]);
  // Longest extension first: "d.ts" before "ts".
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    if (theme.fileExtensions[ext]) return url(theme.fileExtensions[ext]);
  }
  const ext = parts.at(-1);
  const language = { py: "python", js: "javascript", ts: "typescript", sh: "shellscript", md: "markdown", json: "json", html: "html", css: "css", java: "java", c: "c", cpp: "cpp", rs: "rust", go: "go", rb: "ruby", php: "php", yml: "yaml", yaml: "yaml", xml: "xml", sql: "sql" }[ext];
  if (language && theme.languageIds[language]) return url(theme.languageIds[language]);
  return url(theme.file);
}

// ------------------------------------------------------------------- data --

async function load(path, { force = false } = {}) {
  if (!force && state.children.has(path)) return state.children.get(path);
  state.loading.add(path);
  render();
  try {
    const result = await host(`/v1/fs/list?path=${encodeURIComponent(path)}${state.hidden ? "&hidden=1" : ""}`);
    state.children.set(path, result.entries);
  } catch (error) {
    state.children.set(path, { error: error.message });
  } finally {
    state.loading.delete(path);
  }
  render();
  return state.children.get(path);
}

async function navigate(path) {
  const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch((error) => { toast(error.message); return null; });
  if (!info) return;
  if (!info.directory) { await navigate(info.path.replace(/\/[^/]+$/, "") || "/"); select(info.path); return; }
  state.root = info.path;
  state.expanded.clear();
  state.selected.clear();
  state.cursor = null;
  filterInput.value = state.filter = "";
  await browser.storage.local.set({ "files.root": state.root }).catch(() => {});
  renderCrumbs();
  await load(state.root, { force: true });
  tree.scrollTop = 0;
}

async function refresh() {
  const open = [state.root, ...state.expanded];
  state.children.clear();
  await Promise.all(open.map((path) => load(path, { force: true })));
}

// ----------------------------------------------------------------- render --

function renderCrumbs() {
  crumbs.replaceChildren();
  const parts = state.root === "/" ? [""] : state.root.split("/");
  parts.forEach((part, index) => {
    const path = parts.slice(0, index + 1).join("/") || "/";
    const home = path === state.home;
    if (index > 0) { const sep = icon("chevron_right", { size: 14 }); sep.classList.add("sep"); crumbs.append(sep); }
    crumbs.append(h(`button.crumb${index === parts.length - 1 ? ".current" : ""}`, {
      type: "button",
      title: path,
      onclick: (event) => { event.stopPropagation(); void navigate(path); },
    }, index === 0 ? "/" : home ? "~" : part));
  });
  crumbs.append(h("span.fill", { title: "Type a path" }));
  crumbs.scrollLeft = crumbs.scrollWidth;
}

function visibleRows() {
  const rows = [];
  const needle = state.filter.toLowerCase();
  const walk = (path, depth) => {
    const entries = state.children.get(path);
    if (!Array.isArray(entries)) return entries?.error ? [{ note: entries.error, depth }] : [];
    const out = [];
    for (const entry of entries) {
      const open = entry.directory && state.expanded.has(entry.path);
      const kids = open ? walk(entry.path, depth + 1) : [];
      const hit = !needle || entry.name.toLowerCase().includes(needle);
      if (hit || kids.some((k) => !k.note)) out.push({ entry, depth, open }, ...kids);
    }
    return out;
  };
  if (state.root) rows.push(...walk(state.root, 0));
  return rows;
}

function highlightName(name) {
  const needle = state.filter.toLowerCase();
  const at = needle ? name.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return [name];
  return [name.slice(0, at), h("mark", {}, name.slice(at, at + needle.length)), name.slice(at + needle.length)];
}

function render() {
  const rows = visibleRows();
  if (!state.root) { tree.replaceChildren(h("div.note", {}, "Loading…")); return; }
  if (!rows.length) {
    const own = state.children.get(state.root);
    tree.replaceChildren(h("div.note", {}, state.loading.has(state.root) ? "Loading…" : own?.error ?? (state.filter ? "No matches" : "Empty folder")));
    status.textContent = "";
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    if (row.note) { fragment.append(h("div.note", { style: { paddingLeft: `${20 + row.depth * 14}px` } }, row.note)); continue; }
    const { entry, depth, open } = row;
    const el = h(`div.row${entry.name.startsWith(".") ? ".hidden-file" : ""}${entry.broken ? ".broken" : ""}${state.loading.has(entry.path) ? ".loading" : ""}${state.cursor === entry.path ? ".cursor" : ""}`, {
      role: "treeitem",
      "aria-level": depth + 1,
      "aria-selected": String(state.selected.has(entry.path)),
      ...(entry.directory ? { "aria-expanded": String(open) } : {}),
      title: `${entry.path}${entry.directory ? "" : ` · ${formatSize(entry.size)}`}${entry.mtime ? ` · ${new Date(entry.mtime).toLocaleString()}` : ""}`,
      dataset: { path: entry.path },
      style: { "--depth": depth },
    });
    for (let d = 0; d < depth; d++) el.append(h("span.guide", { style: { left: `${14 + d * 14}px` } }));
    const twisty = icon(state.loading.has(entry.path) ? "refresh" : "chevron_right", { size: 16 });
    twisty.classList.add("twisty");
    if (!entry.directory) twisty.classList.add("none");
    el.append(twisty, h("img", { src: iconFor(entry, open), alt: "", draggable: "false" }), h("span.name", {}, ...highlightName(entry.name)));
    if (!entry.directory && entry.size != null) el.append(h("span.meta", {}, formatSize(entry.size)));
    fragment.append(el);
  }
  tree.replaceChildren(fragment);
  const files = rows.filter((r) => r.entry && !r.entry.directory).length;
  const folders = rows.filter((r) => r.entry?.directory).length;
  status.textContent = `${folders} folders · ${files} files${state.selected.size > 1 ? ` · ${state.selected.size} selected` : ""}`;
}

// --------------------------------------------------------------- actions --

function entryAt(path) {
  for (const entries of state.children.values()) if (Array.isArray(entries)) { const found = entries.find((e) => e.path === path); if (found) return found; }
  return null;
}

function select(path, { extend = false } = {}) {
  if (!extend) state.selected.clear();
  if (state.selected.has(path) && extend) state.selected.delete(path); else state.selected.add(path);
  state.cursor = path;
  render();
  tree.querySelector(`.row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
}

async function toggle(path, open = !state.expanded.has(path)) {
  if (open) { state.expanded.add(path); await load(path); } else { state.expanded.delete(path); }
  render();
}

function openFile(path) {
  return background("open-file", { path }).catch((error) => toast(error.message));
}

async function attachToChat(paths) {
  const files = [];
  for (const path of paths) {
    const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch(() => null);
    if (info && !info.directory) files.push({ path: info.path, name: info.name, type: info.mime, size: info.size });
  }
  if (!files.length) return toast("Select files to attach");
  await background("attach-to-chat", { files });
  toast(`Attached ${files.length} file${files.length > 1 ? "s" : ""} to the chat`);
}

function onRowActivate(entry, event) {
  if (event.ctrlKey || event.metaKey) { select(entry.path, { extend: true }); return; }
  select(entry.path);
  if (entry.directory) void toggle(entry.path);
  else void openFile(entry.path);
}

tree.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row) return;
  const entry = entryAt(row.dataset.path);
  if (entry) onRowActivate(entry, event);
});
tree.addEventListener("dblclick", (event) => {
  const row = event.target.closest(".row");
  const entry = row && entryAt(row.dataset.path);
  if (entry?.directory) void navigate(entry.path);
});
tree.addEventListener("contextmenu", (event) => {
  const row = event.target.closest(".row");
  const entry = row && entryAt(row.dataset.path);
  if (!entry) return contextMenu(event, [
    { label: "Refresh", icon: "refresh", run: refresh },
    { label: state.hidden ? "Hide hidden files" : "Show hidden files", icon: state.hidden ? "visibility_off" : "visibility", run: toggleHidden },
  ]);
  if (!state.selected.has(entry.path)) select(entry.path);
  const paths = [...state.selected];
  contextMenu(event, [
    ...(entry.directory
      ? [{ label: "Open as root", icon: "folder_open", run: () => navigate(entry.path) }, { label: state.expanded.has(entry.path) ? "Collapse" : "Expand", icon: "chevron_right", run: () => toggle(entry.path) }]
      : [{ label: "Open in viewer", icon: "preview", run: () => openFile(entry.path) }, { label: "Attach to chat", icon: "attach_file", run: () => attachToChat(paths) }]),
    "-",
    { label: "Copy path", icon: "content_copy", run: async () => { await navigator.clipboard.writeText(paths.join("\n")); toast("Path copied"); } },
    { label: "Copy name", icon: "text_snippet", run: () => navigator.clipboard.writeText(entry.name) },
    ...(entry.directory ? [] : [{ label: "Open containing folder as root", icon: "arrow_upward", run: () => navigate(entry.path.replace(/\/[^/]+$/, "") || "/") }]),
  ]);
});

tree.addEventListener("keydown", (event) => {
  const rows = visibleRows().filter((r) => r.entry);
  const index = rows.findIndex((r) => r.entry.path === state.cursor);
  const current = rows[index]?.entry;
  const move = (to) => { const row = rows[Math.max(0, Math.min(rows.length - 1, to))]; if (row) select(row.entry.path); };
  switch (event.key) {
    case "ArrowDown": move(index + 1); break;
    case "ArrowUp": move(index < 0 ? 0 : index - 1); break;
    case "Home": move(0); break;
    case "End": move(rows.length - 1); break;
    case "ArrowRight": if (current?.directory) { if (!state.expanded.has(current.path)) void toggle(current.path, true); else move(index + 1); } break;
    case "ArrowLeft": {
      if (current?.directory && state.expanded.has(current.path)) void toggle(current.path, false);
      else { const parent = current?.path.replace(/\/[^/]+$/, ""); if (parent && parent !== state.root && entryAt(parent)) select(parent); }
      break;
    }
    case "Enter": if (current) { if (current.directory) void (event.ctrlKey ? navigate(current.path) : toggle(current.path)); else void openFile(current.path); } break;
    case "Backspace": void navigate(state.root.replace(/\/[^/]+$/, "") || "/"); break;
    default: return;
  }
  event.preventDefault();
});

// Path editing: click empty space in the bar (or press Ctrl+L) to type a path.
function editPath() {
  crumbs.hidden = true;
  pathEdit.hidden = false;
  pathInput.value = state.root.endsWith("/") ? state.root : `${state.root}/`;
  pathInput.focus();
  pathInput.setSelectionRange(pathInput.value.length, pathInput.value.length);
  void suggest();
}
function stopEditing() { pathEdit.hidden = true; completions.hidden = true; crumbs.hidden = false; }
crumbs.addEventListener("click", (event) => { if (!event.target.closest(".crumb")) editPath(); });
let suggestTimer;
let suggestions = [];
let suggestionIndex = -1;
async function suggest() {
  const value = pathInput.value;
  const { paths } = await host(`/v1/fs/complete?path=${encodeURIComponent(value)}`).catch(() => ({ paths: [] }));
  if (pathInput.value !== value) return;
  suggestions = paths;
  suggestionIndex = -1;
  completions.replaceChildren(...paths.map((path, i) => h("button", { type: "button", role: "option", "aria-selected": "false", onpointerdown: (e) => { e.preventDefault(); pathInput.value = `${path}/`; void suggest(); pathInput.focus(); } }, path)));
  completions.hidden = !paths.length;
}
pathInput.addEventListener("input", () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(suggest, 120); });
pathInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { stopEditing(); tree.focus(); }
  else if (event.key === "Enter") {
    const pick = suggestions[suggestionIndex];
    stopEditing();
    void navigate(pick ?? (pathInput.value.trim() || "~"));
  } else if (event.key === "Tab" && suggestions.length) {
    event.preventDefault();
    pathInput.value = `${suggestions[Math.max(0, suggestionIndex)]}/`;
    void suggest();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    suggestionIndex = (suggestionIndex + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
    [...completions.children].forEach((el, i) => el.setAttribute("aria-selected", String(i === suggestionIndex)));
  }
});
pathInput.addEventListener("blur", () => setTimeout(stopEditing, 120));
addEventListener("keydown", (event) => { if (event.ctrlKey && event.key.toLowerCase() === "l") { event.preventDefault(); editPath(); } });

filterInput.addEventListener("input", () => { state.filter = filterInput.value.trim(); render(); });
filterInput.addEventListener("keydown", (event) => { if (event.key === "Escape") { filterInput.value = state.filter = ""; render(); tree.focus(); } if (event.key === "ArrowDown") { tree.focus(); } });

async function toggleHidden() {
  state.hidden = !state.hidden;
  await browser.storage.local.set({ "files.hidden": state.hidden }).catch(() => {});
  renderActions();
  await refresh();
}

// ------------------------------------------------------------ dock chrome --

const setDock = (change) => browser.workspace.setDock("right", change);
function renderActions() {
  $("#actions").replaceChildren(
    iconButton("home", "Home folder", () => navigate("~"), { small: true }),
    iconButton("arrow_upward", "Up one level (Backspace)", () => navigate(state.root.replace(/\/[^/]+$/, "") || "/"), { small: true }),
    iconButton(state.hidden ? "visibility" : "visibility_off", state.hidden ? "Hide hidden files" : "Show hidden files", toggleHidden, { small: true, pressed: state.hidden }),
    iconButton("refresh", "Refresh", refresh, { small: true }),
    iconButton(state.dock === "maximized" ? "close_fullscreen" : "open_in_full", state.dock === "maximized" ? "Restore" : "Maximize", () => setDock({ state: state.dock === "maximized" ? "open" : "maximized" }), { small: true }),
    iconButton("right_panel_close", "Minimize (Ctrl+6)", () => setDock({ state: "minimized" }), { small: true }),
  );
}
$("#rail-open").append(icon("folder_open"));
$("#rail-open").addEventListener("click", () => setDock({ state: "open" }));
browser.workspace.onDockChanged.addListener((dock) => { if (dock.side === "right") { state.dock = dock.state; renderActions(); } });

// ------------------------------------------------------------- agent API --

registerPage("files", {
  state: () => ({ root: state.root, selected: [...state.selected], cursor: state.cursor, expanded: [...state.expanded], filter: state.filter, hiddenFiles: state.hidden, dock: state.dock }),
  commands: {
    navigate: async ({ path }) => { await navigate(path); return { root: state.root }; },
    select: async ({ paths }) => {
      for (const path of paths) {
        const parent = path.replace(/\/[^/]+$/, "");
        if (parent.startsWith(state.root) && parent !== state.root) { await toggle(parent, true); }
      }
      state.selected = new Set(paths);
      state.cursor = paths[0] ?? null;
      render();
      return { selected: [...state.selected] };
    },
    expand: async ({ path, open = true }) => { await toggle(path, open); return { expanded: [...state.expanded] }; },
    refresh: async () => { await refresh(); return { ok: true }; },
  },
});

// ------------------------------------------------------------------ start --

$(".filterbar").prepend(icon("search", { size: 18 }));
watchDockWidth();
const saved = await browser.storage.local.get({ "files.root": "~", "files.hidden": false }).catch(() => ({ "files.root": "~", "files.hidden": false }));
state.hidden = saved["files.hidden"];
state.dock = (await browser.workspace.getDocks()).find((d) => d.side === "right")?.state ?? "open";
renderActions();
await loadTheme();
const homeInfo = await host("/v1/fs/stat?path=~").catch(() => null);
state.home = homeInfo?.path ?? null;
await navigate(saved["files.root"]).catch(() => navigate("~"));
