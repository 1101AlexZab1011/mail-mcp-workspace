// Notes space: a Notion-like notebook over a folder of Markdown files (the vault, ~/Notes by default).
//
// Pages are .md files; a page with subpages has a folder of the same name next to it; front matter holds
// the icon, cover and properties; [[links]] connect pages; a database is a page with X.base.json and its
// rows as pages in X/ (src/notes/vault.mjs). The host indexes the vault (tree, links, backlinks, search,
// databases: src/workspace/notes.mjs); this page edits one page per tab with the Writer's editor in its
// Notes mode (the /-menu, block handles, callouts, to-dos: src/notes/editor-notes.mjs) and saves as you
// type, with the same lost-update guard and live merging of outside edits as the Writer.
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, contextMenu, background, toast, registerPage, ask } from "./shared/page.js";
import { DocTabs } from "./shared/doctabs.js";
import { createWriter, merge3, splitPage, setProperties } from "./vendor/writer/writer.mjs";

const AUTOSAVE = 700;
const DB_POLL = 5000;

const ui = {
  sidebar: $("#sidebar"), vault: $("#vault"), tree: $("#tree"), favourites: $("#favourites"), favList: $("#fav-list"),
  crumbs: $("#crumbs"), conflict: $("#conflict"), scroll: $("#scroll"), start: $("#start"), page: $("#page"),
  cover: $("#cover"), icon: $("#icon"), headerTools: $("#header-tools"), title: $("#title"), properties: $("#properties"),
  database: $("#database"), editorRoot: $("#editor"), backlinks: $("#backlinks"), slash: $("#slash"),
  imageInput: $("#image-input"), coverInput: $("#cover-input"),
};

// One state object per tab; `doc` and `editor` point at the active tab's.
//   path, hash (version on disk, sent as `expect`), base (its full text), front (front matter text),
//   info (host page info: properties, links, backlinks, database, parent), editor, root, scroll, status
const EMPTY = { path: null, hash: null, base: null, front: "", info: null, status: "idle" };
let doc = EMPTY;
let editor = null;
let vault = "";
let treeData = [];
let byPath = new Map(); // page path → tree node
let titles = new Set(); // lower-case page titles (resolved vs dimmed links)
let expanded = new Set();
let favourites = [];
let watchToken = 0;

const nameOf = (path) => path.split("/").pop();
const dirOf = (path) => path.replace(/\/[^/]+$/, "") || "/";
const titleOf = (path) => nameOf(path).replace(/\.md$/i, "");
const folderOf = (path) => path.replace(/\.md$/i, "");
const inVault = (path) => Boolean(vault) && path.startsWith(`${vault}/`) && /\.md$/i.test(path);
const rel = (path) => (path.startsWith(`${vault}/`) ? path.slice(vault.length + 1) : path);
/** Where a page lives, for lists: its folder inside the vault ("" at the top level). */
const placeOf = (path) => (dirOf(path) === vault ? "" : rel(dirOf(path)));
const store = (key, value) => browser.storage.local.set({ [`notes.${key}`]: value }).catch(() => {});
const load = async (key, fallback) => (await browser.storage.local.get(`notes.${key}`).catch(() => ({})))[`notes.${key}`] ?? fallback;

/** Relative path from a folder to a file (for image links in pages). */
function relativePath(fromDir, to) {
  const a = fromDir.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

// ---------------------------------------------------------------- tree --

async function refreshTree() {
  const result = await host("/v1/notes/tree").catch((error) => { toast(error.message); return null; });
  if (!result) return;
  vault = result.root;
  treeData = result.tree;
  byPath = new Map();
  titles = new Set();
  const walk = (nodes, parent) => {
    for (const node of nodes) {
      node.parent = parent;
      if (node.path) { byPath.set(node.path, node); titles.add(node.title.toLowerCase()); }
      walk(node.children ?? [], node);
    }
  };
  walk(treeData, null);
  ui.vault.textContent = vault.replace(/^\/home\/[^/]+/, "~");
  renderTree();
  renderCrumbs();
}

function renderTree() {
  const row = (node, depth) => {
    const key = node.path ?? node.folder;
    const open = expanded.has(key);
    const kids = node.children?.length ?? 0;
    const active = node.path && node.path === doc.path;
    const glyph = node.icon ? h("span.emoji", {}, node.icon) : icon(node.database ? "database" : node.path ? "description" : "folder", { size: 17 });
    const el = h(`div.tree-row${active ? ".active" : ""}${node.path ? "" : ".folder"}`, {
      role: "treeitem", "aria-selected": String(Boolean(active)), "aria-expanded": kids ? String(open) : undefined,
      draggable: "true", style: { "--depth": depth }, title: node.path ? rel(node.path) : rel(node.folder),
      onclick: () => (node.path ? void open_(node.path) : toggle(key)),
      ondragstart: (e) => { e.dataTransfer.setData("text/x-note", node.path ?? node.folder); e.dataTransfer.effectAllowed = "move"; },
      ondragover: (e) => { if (e.dataTransfer.types.includes("text/x-note")) { e.preventDefault(); el.classList.add("drop"); } },
      ondragleave: () => el.classList.remove("drop"),
      ondrop: (e) => { e.preventDefault(); el.classList.remove("drop"); void movePage(e.dataTransfer.getData("text/x-note"), node.path ? { parent: node.path } : { folder: node.folder }); },
      oncontextmenu: (e) => pageMenu(e, node),
    },
    h("button.twisty", { type: "button", tabIndex: -1, hidden: !kids, onclick: (e) => { e.stopPropagation(); toggle(key); } }, icon("chevron_right", { size: 16 })),
    h("span.tree-icon", {}, glyph),
    h("span.tree-title", {}, node.title),
    node.rows !== undefined ? h("span.tree-count", {}, String(node.rows)) : null,
    h("span.tree-tools", {},
      node.path ? h("button", { type: "button", title: "Add a page inside", onclick: (e) => { e.stopPropagation(); void newPage({ parent: node.path }); } }, icon("add", { size: 16 })) : null,
      h("button", { type: "button", title: "More", onclick: (e) => { e.stopPropagation(); pageMenu(e, node); } }, icon("more_horiz", { size: 16 })),
    ));
    const out = [el];
    if (open) for (const child of node.children ?? []) out.push(...row(child, depth + 1));
    return out;
  };
  ui.tree.replaceChildren(...treeData.flatMap((node) => row(node, 0)));
  if (!treeData.length) ui.tree.append(h("p.side-empty", {}, "No pages yet"));
  // Favourites
  const favs = favourites.filter((p) => byPath.has(p));
  ui.favourites.hidden = !favs.length;
  ui.favList.replaceChildren(...favs.map((path) => {
    const node = byPath.get(path);
    return h(`div.tree-row${path === doc.path ? ".active" : ""}`, { role: "treeitem", style: { "--depth": 0 }, onclick: () => void open_(path), oncontextmenu: (e) => pageMenu(e, node) },
      h("span.twisty"), h("span.tree-icon", {}, node.icon ? h("span.emoji", {}, node.icon) : icon("description", { size: 17 })), h("span.tree-title", {}, node.title));
  }));
}

function toggle(key) {
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  void store("expanded", [...expanded]);
  renderTree();
}

/** Open the tree down to a page. */
function revealInTree(path) {
  let node = byPath.get(path)?.parent;
  let changed = false;
  while (node) { const key = node.path ?? node.folder; if (!expanded.has(key)) { expanded.add(key); changed = true; } node = node.parent; }
  if (changed) void store("expanded", [...expanded]);
  renderTree();
  ui.tree.querySelector(".tree-row.active")?.scrollIntoView({ block: "nearest" });
}

function pageMenu(event, node) {
  if (!node.path) {
    contextMenu(event, [{ label: "New page here", icon: "add", run: () => void newPage({ folder: node.folder }) }]);
    return;
  }
  const fav = favourites.includes(node.path);
  contextMenu(event, [
    { label: "Open", icon: "open_in_new", run: () => void open_(node.path) },
    { label: "Add a page inside", icon: "add", run: () => void newPage({ parent: node.path }) },
    { label: fav ? "Remove from favourites" : "Add to favourites", icon: "star", run: () => toggleFavourite(node.path) },
    "-",
    { label: "Rename", icon: "drive_file_rename", run: () => void renamePrompt(node.path) },
    { label: "Duplicate", icon: "content_copy", run: () => void duplicatePage(node.path) },
    ...(node.parent || dirOf(node.path) !== vault ? [{ label: "Move to the top level", icon: "arrow_upward", run: () => void movePage(node.path, {}) }] : []),
    { label: "Copy link", icon: "link", run: () => navigator.clipboard.writeText(`[[${node.title}]]`) },
    { label: "Show in Files", icon: "folder_open", run: () => void background("files-reveal", { path: node.path }) },
    "-",
    { label: "Move to Trash", icon: "delete", danger: true, run: () => void trashPage(node.path) },
  ]);
}

function toggleFavourite(path) {
  favourites = favourites.includes(path) ? favourites.filter((p) => p !== path) : [...favourites, path];
  void store("favourites", favourites);
  renderTree();
  renderHeaderTools();
}

/** A page (and its subpages) moved or was renamed: follow it in tabs and favourites. */
function remap(from, to) {
  const oldFolder = folderOf(from);
  const newFolder = folderOf(to);
  const map = (p) => (p === from ? to : p?.startsWith(`${oldFolder}/`) ? `${newFolder}${p.slice(oldFolder.length)}` : p);
  for (const tab of tabs.tabs) {
    const next = map(tab.path);
    if (next !== tab.path) { tab.path = next; tab.title = titleOf(next); }
  }
  favourites = favourites.map(map);
  void store("favourites", favourites);
  for (const key of [...expanded]) { const next = map(key); if (next !== key) { expanded.delete(key); expanded.add(next); } }
  tabs.render();
  tabs.persist();
}

async function movePage(path, target) {
  if (!path || path === target.parent) return;
  for (const tab of tabs.tabs) if (tab.dirty) await saveTab(tab);
  try {
    const result = await host("/v1/notes/move", { method: "POST", body: JSON.stringify({ path, ...target }) });
    if (target.parent) expanded.add(target.parent);
    remap(path, result.path);
    await refreshTree();
    if (doc.path) await refreshInfo(doc);
  } catch (error) { toast(error.message); }
}

async function renamePage(path, title) {
  const tab = tabs.find(path);
  if (tab?.dirty) await saveTab(tab);
  const result = await host("/v1/notes/rename", { method: "POST", body: JSON.stringify({ path, title }) });
  remap(path, result.path);
  if (tab) { const file = await host(`/v1/fs/read?path=${encodeURIComponent(result.path)}`); tab.hash = file.hash; tab.base = file.text; }
  await refreshTree();
  if (doc.path) { await refreshInfo(doc); renderHeader(); renderBacklinks(); renderCrumbs(); }
  if (result.updated) toast(`Renamed; updated ${result.updated} link${result.updated === 1 ? "" : "s"}`);
  return result;
}

async function renamePrompt(path) {
  const title = await ask({ title: "Rename page", message: "Links to it are updated", value: titleOf(path), ok: "Rename" });
  if (title && title !== titleOf(path)) await renamePage(path, title).catch((error) => toast(error.message));
}

async function duplicatePage(path) {
  const file = await host(`/v1/fs/read?path=${encodeURIComponent(path)}`).catch((error) => { toast(error.message); return null; });
  if (!file) return;
  const { data, body } = splitPage(file.text);
  const result = await host("/v1/notes/new", { method: "POST", body: JSON.stringify({ title: `${titleOf(path)} copy`, folder: dirOf(path), properties: data, body: body.replace(/^\n/, "") }) });
  await refreshTree();
  await open_(result.path);
}

async function trashPage(path) {
  const node = byPath.get(path);
  const inside = node?.children?.length ? ` and the ${node.children.length} page${node.children.length === 1 ? "" : "s"} inside it` : "";
  const ok = await ask({ title: `Move “${titleOf(path)}” to the Trash?`, message: `This page${inside} can be restored from the Trash.`, ok: "Move to Trash", danger: true });
  if (!ok) return;
  for (const tab of [...tabs.tabs]) if (tab.path === path || tab.path.startsWith(`${folderOf(path)}/`)) { if (tab.dirty) await saveTab(tab); await tabs.close(tab); }
  try {
    await host("/v1/notes/trash", { method: "POST", body: JSON.stringify({ path }) });
    toast(`Moved “${titleOf(path)}” to the Trash`);
  } catch (error) { toast(error.message); }
  await refreshTree();
}

async function showTrash() {
  const { entries = [] } = await host("/v1/fs/trash?limit=200").catch(() => ({}));
  const mine = entries.filter((e) => e.path.startsWith(`${vault}/`));
  const list = h("div.trash-list", {}, ...(mine.length ? mine.map((entry) => h("div.trash-row", {},
    icon(/\.md$/i.test(entry.path) ? "description" : /\.base\.json$/.test(entry.path) ? "database" : "folder", { size: 18 }),
    h("div.trash-name", {}, h("div", {}, nameOf(entry.path).replace(/\.md$/i, "")), h("div.meta", {}, `${placeOf(entry.path) || "Top level"} · ${entry.deleted.replace("T", " ").slice(0, 16)}`)),
    h("button.btn.small", { type: "button", onclick: async (e) => {
      try {
        await host("/v1/fs/restore", { method: "POST", body: JSON.stringify({ name: entry.name }) });
        e.target.closest(".trash-row").remove();
        await refreshTree();
        toast(`Restored ${nameOf(entry.path)}`);
      } catch (error) { toast(error.message); }
    } }, "Restore"))) : [h("p", {}, "The Trash has no pages from this vault.")]));
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog", { style: { width: "min(560px, calc(100vw - 32px))" } }, h("h2", {}, "Trash"), list,
      h("div.actions", {}, h("button.btn.primary", { type: "button", onclick: () => backdrop.remove() }, "Close"))));
  document.body.append(backdrop);
}

// ------------------------------------------------------------- editors --

async function createTabEditor(tab) {
  tab.root = h("div.tab-editor", { hidden: true });
  ui.editorRoot.append(tab.root);
  tab.editor = await createWriter(tab.root, {
    onChange: () => {
      if (!tab.path || tab.status === "readonly") return;
      const dirty = fullText(tab) !== tab.base;
      tabs.setDirty(tab, dirty);
      tabs.touch(tab);
      if (dirty) scheduleSave(tab);
    },
    onSelection: () => {},
    resolveImage: (src) => resolveImage(tab, src),
    editInline: (attrs) => ask({ title: "Edit source", message: "Exactly as it appears in the file", value: attrs.source, ok: "Apply" }),
    openLink: (link, event) => void followLink(tab, link, event),
    describeLink: (link, el) => { if (link && !titles.has(link.target.split("/").pop().toLowerCase())) { el.classList.add("unresolved"); el.title = `“${link.target}” does not exist yet · click to create it`; } },
    renderDatabase: (el, source) => void renderEmbeddedDatabase(tab, el, source),
    onSlash: (state) => drawSlash(tab, state),
    onSlashKey: (key, event) => slashKey(tab, key, event),
    onBlockMenu: (info) => blockMenu(tab, info),
    onAddBlock: ({ pos }) => { tab.editor.notes.addBlockAfter(pos); tab.editor.notes.insertText("/"); },
  }, { mode: "notes" });
  tab.root.addEventListener("keydown", (event) => linkTrigger(tab, event));
  return tab.editor;
}
ui.editorRoot.addEventListener("paste", onPasteImages, true);
ui.editorRoot.addEventListener("drop", onDropImages, true);

const imageUrls = new Map();
async function resolveImage(tab, src) {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (!tab.path) return null;
  const full = src.startsWith("/") ? src : `${dirOf(tab.path)}/${decodeURI(src).replace(/^\.\//, "")}`;
  if (imageUrls.has(full)) return imageUrls.get(full);
  const link = await host("/v1/links", { method: "POST", body: JSON.stringify({ path: full }) }).catch(() => null);
  const url = link ? `${HOST_ENDPOINT}${link.url}` : null;
  if (url) imageUrls.set(full, url);
  return url;
}

/** The page's whole text: its front matter as kept, then the edited body. */
const fullText = (tab) => `${tab.front}${tab.editor.markdown()}`;

function loadText(tab, text, options) {
  const { front, valid } = splitPage(text);
  tab.front = front;
  const result = tab.editor.load(text.slice(front.length), options);
  tab.safe = result.safe && valid;
  if (!tab.safe) { tab.status = "readonly"; tab.editor.view.setProps({ editable: () => false }); }
  return result;
}

async function refreshInfo(tab) {
  tab.info = await host(`/v1/notes/page?path=${encodeURIComponent(tab.path)}`).catch(() => tab.info);
}

// ---------------------------------------------------------------- tabs --

const tabs = new DocTabs({
  page: "notes",
  mount: $("#tabs"),
  icon: "notes",
  onEmpty: () => void showStart(),
  adapter: {
    async load(tab, draft) {
      const file = await host(`/v1/fs/read?path=${encodeURIComponent(tab.path)}`);
      if (file.truncated) throw new Error("This page is too large for Notes");
      Object.assign(tab, { title: titleOf(tab.path), hash: file.hash, base: file.text, status: "saved", scroll: 0 });
      await refreshInfo(tab);
      await createTabEditor(tab);
      let text = file.text;
      if (draft?.text !== undefined && draft.text !== file.text) {
        if (draft.baseHash === file.hash) text = draft.text;
        else { const merged = merge3(draft.base ?? file.text, draft.text, file.text); text = merged.conflicts ? file.text : merged.text; }
      }
      loadText(tab, text);
      tab.dirty = tab.status !== "readonly" && fullText(tab) !== tab.base;
      if (tab.dirty) scheduleSave(tab);
    },
    async show(tab) {
      doc = tab;
      editor = tab.editor;
      for (const other of tabs.tabs) if (other.root) other.root.hidden = other !== tab;
      ui.start.hidden = true;
      ui.page.hidden = false;
      document.title = `${tab.title} · Notes`;
      hideBar();
      if (!tab.safe) showBar("This page cannot be edited safely here: saving would change text you did not edit (or its front matter is not valid YAML). It is open read-only.", [["Open in Writer", () => background("open-space", { name: "writer", query: tab.path })]], true);
      renderHeader();
      void renderDatabasePage(tab);
      renderBacklinks();
      revealInTree(tab.path);
      renderCrumbs();
      requestAnimationFrame(() => { ui.scroll.scrollTop = tab.scroll ?? 0; });
      void remember(tab.path);
      void refreshInfo(tab).then(() => { if (doc === tab) { renderBacklinks(); renderCrumbs(); } });
      void watch(tab);
    },
    hide(tab) {
      tab.scroll = ui.scroll.scrollTop;
      if (tab.root) tab.root.hidden = true;
      watchToken++;
      drawSlash(tab, null);
      if (tab.dirty) void saveTab(tab);
    },
    save: (tab) => saveTab(tab),
    draft: (tab) => ({ text: fullText(tab), base: tab.base, baseHash: tab.hash }),
    dispose(tab) {
      clearTimeout(tab.saveTimer);
      try { tab.editor?.destroy(); } catch { /* gone */ }
      tab.root?.remove();
      if (doc === tab) { doc = EMPTY; editor = null; }
    },
  },
});
// Pages save as you type: closing a tab saves it instead of asking.
const closeTab = tabs.close.bind(tabs);
tabs.close = async (tab = tabs.active) => { if (tab?.dirty) await saveTab(tab); return closeTab(tab); };

async function remember(path) {
  const list = (await load("recent", [])).filter((p) => p !== path);
  list.unshift(path);
  await store("recent", list.slice(0, 20));
}

/** Open a page in its tab. Other files go to their editors. */
async function open_(path, { heading } = {}) {
  if (!path) return null;
  if (!/\.md$/i.test(path)) { await background("open-file", { path }); return { opened: "viewer", path }; }
  let tab;
  try { tab = await tabs.open(path); }
  catch (error) { toast(error.message); return null; }
  if (heading) {
    const item = tab.editor.outline().find((o) => o.text.toLowerCase() === heading.toLowerCase());
    if (item) tab.editor.reveal(item.pos);
  }
  return { opened: "notes", path: tab.path };
}

async function newPage({ title, parent, folder, body = "", open = true } = {}) {
  try {
    const result = await host("/v1/notes/new", { method: "POST", body: JSON.stringify({ title: title || "Untitled", parent, folder, body }) });
    if (parent) expanded.add(parent);
    await refreshTree();
    if (open) {
      await open_(result.path);
      if (!title) { ui.title.focus(); document.getSelection()?.selectAllChildren(ui.title); }
    }
    return result;
  } catch (error) { toast(error.message); return null; }
}

// ---------------------------------------------------------------- save --

function scheduleSave(tab) {
  clearTimeout(tab.saveTimer);
  tab.saveTimer = setTimeout(() => void saveTab(tab), AUTOSAVE);
}

/** Save a tab now. With an outside change on disk, merge it in first. Resolves true when saved. */
async function saveTab(tab) {
  clearTimeout(tab.saveTimer);
  if (!tab?.path || !tab.editor || tab.status === "readonly") return false;
  while (tab.saving) await tab.saving;
  const text = fullText(tab);
  if (text === tab.base) { tabs.setDirty(tab, false); return true; }
  tab.saving = (async () => {
    try {
      const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: tab.path, text, expect: tab.hash }) });
      tab.hash = result.hash;
      tab.base = text;
      tab.status = "saved";
      tabs.setDirty(tab, fullText(tab) !== text);
      if (tab === doc) hideBar();
      return true;
    } catch (error) {
      if (error.status === 409) { const outcome = await mergeFromDisk(tab); return outcome === "merged" || outcome === "reloaded" ? "again" : false; }
      tab.status = "error";
      toast(`Not saved: ${error.message}`);
      return false;
    }
  })();
  let result;
  try { result = await tab.saving; } finally { tab.saving = null; }
  return result === "again" ? saveTab(tab) : result;
}

/** The page changed on disk: reload a clean tab, merge into one with unsaved changes. */
async function mergeFromDisk(tab) {
  const file = await host(`/v1/fs/read?path=${encodeURIComponent(tab.path)}`).catch(() => null);
  if (!file) {
    tab.status = "error";
    if (tab === doc) showBar("This page was moved or deleted on disk.", [["Save here again", () => { tab.hash = "absent"; hideBar(); return saveTab(tab); }]], true);
    return "gone";
  }
  if (file.hash === tab.hash) return "reloaded";
  const mine = fullText(tab);
  if (mine === tab.base) {
    loadText(tab, file.text, { keep: true });
    Object.assign(tab, { base: file.text, hash: file.hash });
    tabs.setDirty(tab, false);
    if (tab === doc) { await refreshInfo(tab); renderHeader(); renderBacklinks(); }
    return "reloaded";
  }
  const merged = merge3(tab.base, mine, file.text);
  if (!merged.conflicts) {
    loadText(tab, merged.text, { keep: true });
    Object.assign(tab, { base: file.text, hash: file.hash });
    tabs.setDirty(tab, merged.text !== file.text);
    if (tab === doc) renderHeader();
    return "merged";
  }
  tab.status = "conflict";
  if (tab === doc) {
    showBar("This page changed on disk where you were editing the same lines.", [
      ["Use the version on disk", () => { loadText(tab, file.text, { keep: true }); Object.assign(tab, { base: file.text, hash: file.hash, status: "saved" }); tabs.setDirty(tab, false); hideBar(); renderHeader(); }],
      ["Keep mine", async () => { tab.hash = file.hash; tab.base = file.text; tab.status = "saved"; hideBar(); await saveTab(tab); }],
    ]);
  }
  return "conflict";
}

async function watch(tab) {
  const token = ++watchToken;
  while (token === watchToken && doc === tab && tabs.tabs.includes(tab)) {
    const change = await host(`/v1/fs/watch?path=${encodeURIComponent(tab.path)}&since=${tab.hash}&wait=25000`).catch(() => null);
    if (token !== watchToken || doc !== tab) return;
    if (!change) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (change.hash === tab.hash || tab.saving) continue;
    if (change.absent) { await new Promise((r) => setTimeout(r, 1500)); continue; } // renamed or moved: the tree refresh follows it
    const outcome = await mergeFromDisk(tab);
    if (outcome === "reloaded" || outcome === "merged") void refreshTree();
  }
}

function showBar(message, buttons = [], danger = false) {
  ui.conflict.hidden = false;
  ui.conflict.className = `conflict${danger ? " danger" : ""}`;
  ui.conflict.replaceChildren(icon(danger ? "error" : "warning", { size: 18 }), h("span", {}, message), h("span.spacer"),
    ...buttons.map(([label, run]) => h("button.btn.small", { type: "button", onclick: run }, label)));
}
function hideBar() { ui.conflict.hidden = true; }

// --------------------------------------------------------- page header --

const COVERS = [
  "linear-gradient(120deg, #f6d365 0%, #fda085 100%)", "linear-gradient(120deg, #a1c4fd 0%, #c2e9fb 100%)",
  "linear-gradient(120deg, #84fab0 0%, #8fd3f4 100%)", "linear-gradient(120deg, #fccb90 0%, #d57eeb 100%)",
  "linear-gradient(120deg, #e0c3fc 0%, #8ec5fc 100%)", "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  "linear-gradient(135deg, #0f2027 0%, #2c5364 100%)", "linear-gradient(135deg, #43cea2 0%, #185a9d 100%)",
];
const EMOJI = "📝 📄 📌 📎 📚 📖 🗂️ 🗃️ 📁 🗒️ ✅ ☑️ 💡 🧠 🔬 🧪 🧬 📊 📈 📉 🧮 🖥️ 💻 ⚙️ 🛠️ 🔧 🧭 🗺️ 🎯 🚀 ⭐ 🌟 🔥 ⚡ 🌱 🌳 🌊 🌙 ☀️ ❄️ 🎓 🏛️ 🏠 ✈️ 📅 🗓️ ⏰ 📬 📮 ✉️ 💬 🗣️ 👥 🤝 👋 🙂 🤔 😎 🎉 🎨 🎵 📷 🎬 🧩 🔑 🔒 🛡️ 💰 🧾 📦 🏷️ ❓ ❗ ⚠️ 🐞 🧹 ♻️ 🔁 🧘 🍀 🍎 ☕".split(" ");

const props = () => splitPage(doc.base !== null && doc.editor ? fullText(doc) : "").data;

/** Change front matter (icon, cover, properties): saved with the body like any edit. */
function changeProperties(changes, tab = doc) {
  // The body stays as the editor holds it; the front matter is everything before it.
  const body = tab.editor.markdown();
  const text = setProperties(`${tab.front}${body}`, changes);
  tab.front = text.endsWith(body) ? text.slice(0, text.length - body.length) : "";
  tabs.setDirty(tab, fullText(tab) !== tab.base);
  if (tab.dirty) void saveTab(tab).then(() => { void refreshTree(); });
  if (tab === doc) renderHeader();
}

function renderHeader() {
  if (!doc.path) return;
  const data = props();
  // Icon
  ui.icon.hidden = !data.icon;
  ui.icon.replaceChildren(data.icon ? String(data.icon) : "");
  ui.icon.onclick = (e) => emojiPicker(e.currentTarget);
  // Cover
  const cover = data.cover ? String(data.cover) : "";
  ui.cover.hidden = !cover;
  ui.cover.style.background = "";
  ui.cover.style.backgroundImage = "";
  if (/^gradient:\d+$/.test(cover)) ui.cover.style.background = COVERS[Number(cover.slice(9)) % COVERS.length];
  else if (cover) void resolveImage(doc, cover).then((url) => { if (url) ui.cover.style.backgroundImage = `url("${url}")`; });
  ui.cover.replaceChildren(h("div.cover-tools", {},
    h("button.btn.small", { type: "button", onclick: (e) => coverMenu(e) }, "Change cover"),
    h("button.btn.small", { type: "button", onclick: () => changeProperties({ cover: null }) }, "Remove")));
  ui.page.classList.toggle("has-cover", Boolean(cover));
  ui.page.classList.toggle("has-icon", Boolean(data.icon));
  // Title
  if (document.activeElement !== ui.title) ui.title.textContent = doc.title;
  ui.title.contentEditable = doc.safe ? "plaintext-only" : "false";
  renderHeaderTools();
  renderProperties(data);
}

function renderHeaderTools() {
  if (!doc.path) return;
  const data = props();
  const fav = favourites.includes(doc.path);
  const tool = (glyph, label, run) => h("button.header-tool", { type: "button", onclick: run }, icon(glyph, { size: 17 }), label);
  ui.headerTools.replaceChildren(
    data.icon ? null : tool("mood", "Add icon", (e) => emojiPicker(e.currentTarget)),
    data.cover ? null : tool("wallpaper", "Add cover", () => changeProperties({ cover: `gradient:${Math.floor(Math.random() * COVERS.length)}` })),
    tool("tune", "Add property", () => void addProperty()),
    h("span.spacer"),
    h("button.header-tool", { type: "button", title: fav ? "Remove from favourites" : "Add to favourites", onclick: () => toggleFavourite(doc.path) }, icon("star", { size: 17, fill: fav })),
  );
}

function emojiPicker(anchor) {
  document.querySelector(".emoji-pop")?.remove();
  const pop = h("div.emoji-pop", { role: "dialog" },
    h("div.emoji-head", {}, h("span", {}, "Icon"), h("span.spacer"),
      h("button.btn.ghost.small", { type: "button", onclick: () => { pop.remove(); changeProperties({ icon: EMOJI[Math.floor(Math.random() * EMOJI.length)] }); } }, "Random"),
      h("button.btn.ghost.small", { type: "button", onclick: () => { pop.remove(); changeProperties({ icon: null }); } }, "Remove")),
    h("div.emoji-grid", {}, ...EMOJI.map((e) => h("button", { type: "button", onclick: () => { pop.remove(); changeProperties({ icon: e }); } }, e))));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8)}px`;
  const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); removeEventListener("pointerdown", close, true); } };
  setTimeout(() => addEventListener("pointerdown", close, true));
}

function coverMenu(event) {
  contextMenu(event, [
    ...COVERS.map((_, i) => ({ label: `Gradient ${i + 1}`, icon: "palette", run: () => changeProperties({ cover: `gradient:${i}` }) })),
    "-",
    { label: "Upload an image…", icon: "upload", run: () => ui.coverInput.click() },
  ]);
}
ui.coverInput.addEventListener("change", async () => {
  const file = ui.coverInput.files?.[0];
  ui.coverInput.value = "";
  if (!file || !doc.path) return;
  const path = await uploadAttachment(file);
  if (path) changeProperties({ cover: relativePath(dirOf(doc.path), path) });
});

// Title: Enter goes to the text; leaving it renames the page (and updates links to it).
ui.title.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); editor?.focus(); }
  if (event.key === "Escape") { ui.title.textContent = doc.title; editor?.focus(); }
});
ui.title.addEventListener("blur", async () => {
  const title = ui.title.textContent.replace(/\s+/g, " ").trim();
  if (!doc.path || !title || title === doc.title) { ui.title.textContent = doc.title; return; }
  try { await renamePage(doc.path, title); } catch (error) { toast(error.message); ui.title.textContent = doc.title; }
});

// Properties: the front matter as a small form.
const HIDDEN_KEYS = new Set(["icon", "cover"]);
function renderProperties(data) {
  const keys = Object.keys(data).filter((k) => !HIDDEN_KEYS.has(k));
  const schema = databaseSchemaOf(doc);
  ui.properties.replaceChildren(...keys.map((key) => {
    const value = data[key];
    const type = schema?.properties.find((p) => p.name === key)?.type ?? (typeof value === "boolean" ? "checkbox" : Array.isArray(value) ? "multi-select" : "text");
    return h("div.prop", {},
      h("button.prop-key", { type: "button", title: "Property options", onclick: (e) => contextMenu(e, [
        { label: "Rename", icon: "drive_file_rename", run: async () => { const name = await ask({ title: "Rename property", value: key, ok: "Rename" }); if (name && name !== key) changeProperties({ [key]: null, [name]: value }); } },
        { label: "Delete", icon: "delete", danger: true, run: () => changeProperties({ [key]: null }) },
      ]) }, icon(PROP_ICON[type] ?? "text_snippet", { size: 16 }), key),
      propertyInput(type, value, (next) => changeProperties({ [key]: next }), schema?.properties.find((p) => p.name === key)));
  }));
}
const PROP_ICON = { text: "text_snippet", number: "tag", select: "keyboard_arrow_down", "multi-select": "format_list_bulleted", date: "calendar_month", checkbox: "check_circle", url: "link", person: "contacts", relation: "link" };

/** An input for one property value; `commit(value)` with the new value (null clears it). */
function propertyInput(type, value, commit, column) {
  const asText = Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value);
  if (type === "checkbox") return h("input.prop-check", { type: "checkbox", checked: Boolean(value), onchange: (e) => commit(e.target.checked) });
  if (type === "select" && column) {
    const select = h("select.prop-input", { onchange: (e) => commit(e.target.value || null) }, h("option", { value: "" }, "—"), ...(column.options ?? []).map((o) => h("option", { value: o, selected: o === asText }, o)));
    if (asText && !(column.options ?? []).includes(asText)) select.append(h("option", { value: asText, selected: true }, asText));
    return select;
  }
  const input = h("input.prop-input", { type: type === "date" ? "date" : type === "number" ? "number" : "text", value: asText, placeholder: "Empty" });
  const done = () => {
    const raw = input.value.trim();
    if (raw === asText) return;
    if (!raw) return commit(null);
    if (type === "number") return commit(Number(raw));
    if (type === "multi-select" || Array.isArray(value)) return commit(raw.split(",").map((s) => s.trim()).filter(Boolean));
    return commit(raw);
  };
  input.addEventListener("change", done);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  return input;
}

async function addProperty() {
  const name = await ask({ title: "Add property", message: "A name, e.g. Status, Due, Tags", value: "", ok: "Next" });
  if (!name) return;
  const value = await ask({ title: name, message: "Its value (comma-separated for a list)", value: "", ok: "Add" });
  if (value === null) return;
  changeProperties({ [name]: value.includes(",") ? value.split(",").map((s) => s.trim()).filter(Boolean) : value || "—" });
}

function renderCrumbs() {
  if (!doc.path || !vault) { ui.crumbs.hidden = true; return; }
  const parts = rel(doc.path).replace(/\.md$/i, "").split("/");
  const items = [];
  for (let i = 0; i < parts.length; i++) {
    const path = `${vault}/${parts.slice(0, i + 1).join("/")}.md`;
    const node = byPath.get(path);
    const label = h("span", {}, node?.icon ? `${node.icon} ` : "", parts[i]);
    items.push(i < parts.length - 1 && node ? h("button.crumb", { type: "button", onclick: () => void open_(path) }, label) : h("span.crumb.here", {}, label));
    if (i < parts.length - 1) items.push(h("span.crumb-sep", {}, "/"));
  }
  ui.crumbs.hidden = false;
  ui.crumbs.replaceChildren(...items, h("span.spacer"), h("span.save-state", {}, doc.dirty ? "Saving…" : doc.status === "error" ? "Not saved" : ""));
}

function renderBacklinks() {
  const list = doc.info?.backlinks ?? [];
  ui.backlinks.hidden = !list.length;
  ui.backlinks.replaceChildren(
    h("h2", {}, `${list.length} backlink${list.length === 1 ? "" : "s"}`),
    ...list.map((b) => h("button.backlink", { type: "button", onclick: () => void open_(b.path) }, h("div.bl-title", {}, icon("description", { size: 16 }), b.title), b.context ? h("div.bl-context", {}, b.context) : null)));
}

// --------------------------------------------------------------- links --

async function followLink(tab, link, event) {
  if (!link?.target) return;
  const result = await host(`/v1/notes/resolve?${new URLSearchParams({ target: link.target, from: tab.path })}`).catch(() => null);
  if (result?.path) { await open_(result.path, { heading: link.heading }); return; }
  // A link to a page that does not exist yet: create it (next to the linking page), as Obsidian does.
  if (event?.shiftKey) return;
  const created = await newPage({ title: link.target.split("/").pop(), folder: dirOf(tab.path), open: false });
  if (created) { await open_(created.path); tab.editor.view.dispatch(tab.editor.view.state.tr); }
}

/** Typing [[ opens the page picker and inserts a link. */
function linkTrigger(tab, event) {
  if (event.key !== "[" || event.ctrlKey || event.metaKey || event.altKey) return;
  const { $from, empty } = tab.editor.view.state.selection;
  if (!empty || $from.parent.type.name === "code_block") return;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, undefined, "￼");
  if (before !== "[") return;
  event.preventDefault();
  const view = tab.editor.view;
  view.dispatch(view.state.tr.delete($from.pos - 1, $from.pos));
  void pickPage({ title: "Link to a page", create: "Link to a new page" }).then(async (choice) => {
    view.focus();
    if (!choice) return;
    const title = choice.create ? (await newPage({ title: choice.create, folder: dirOf(tab.path), open: false }))?.title : choice.title;
    if (title) tab.editor.insertInline("wikilink", `[[${title}]]`);
  });
}

// ------------------------------------------------------------- /-menu --

let slash = { tab: null, items: [], index: 0, query: null };

function drawSlash(tab, state) {
  if (!state) {
    if (slash.tab === tab || !slash.tab) { ui.slash.hidden = true; slash = { tab: null, items: [], index: 0, query: null }; }
    return;
  }
  if (slash.query !== state.query) slash.index = 0;
  slash = { tab, items: state.items, index: Math.min(slash.index, Math.max(0, state.items.length - 1)), query: state.query };
  if (!state.items.length) { ui.slash.hidden = false; ui.slash.replaceChildren(h("div.slash-empty", {}, "No results")); }
  else {
    ui.slash.replaceChildren(h("div.slash-head", {}, "Blocks"), ...state.items.map((item, k) => h(`button.slash-item${k === slash.index ? ".active" : ""}`, {
      type: "button", role: "option", "aria-selected": String(k === slash.index),
      onmousedown: (e) => { e.preventDefault(); void chooseSlash(item); },
      onmousemove: () => { if (slash.index !== k) { slash.index = k; drawSlash(tab, state); } },
    }, h("span.slash-glyph", {}, SLASH_GLYPH[item.id] ?? "¶"), h("span.slash-text", {}, h("span.slash-label", {}, item.label), h("span.slash-hint", {}, item.hint)))));
  }
  ui.slash.hidden = false;
  const rect = state.rect ?? { left: 100, bottom: 100, top: 100 };
  const height = Math.min(ui.slash.scrollHeight, 340);
  const below = rect.bottom + 6 + height < innerHeight;
  ui.slash.style.left = `${Math.min(rect.left, innerWidth - 300)}px`;
  ui.slash.style.top = `${below ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)}px`;
  ui.slash.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}
const SLASH_GLYPH = { text: "Aa", h1: "H1", h2: "H2", h3: "H3", todo: "☑", bullet: "•", numbered: "1.", toggle: "▸", callout: "💡", warning: "⚠️", quote: "❝", divider: "—", page: "↗", subpage: "📄", database: "▦", table: "⊞", image: "🖼", code: "</>", math: "∑" };

function slashKey(tab, key) {
  if (ui.slash.hidden || slash.tab !== tab) return false;
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (!slash.items.length) return true;
    slash.index = (slash.index + (key === "ArrowDown" ? 1 : -1) + slash.items.length) % slash.items.length;
    [...ui.slash.querySelectorAll(".slash-item")].forEach((el, k) => { el.classList.toggle("active", k === slash.index); el.setAttribute("aria-selected", String(k === slash.index)); });
    ui.slash.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    return true;
  }
  if (key === "Enter" || key === "Tab") { const item = slash.items[slash.index]; if (!item) return false; void chooseSlash(item); return true; }
  if (key === "Escape") { tab.editor.notes.closeSlash(); return true; }
  return false;
}

async function chooseSlash(item) {
  const tab = slash.tab ?? doc;
  const notes = tab.editor.notes;
  ui.slash.hidden = true;
  switch (item.id) {
    case "page": {
      notes.applySlash("none");
      const choice = await pickPage({ title: "Link to a page", create: "Link to a new page" });
      tab.editor.focus();
      if (!choice) return;
      const title = choice.create ? (await newPage({ title: choice.create, folder: dirOf(tab.path), open: false }))?.title : choice.title;
      if (title) tab.editor.insertInline("wikilink", `[[${title}]]`);
      return;
    }
    case "subpage": {
      notes.applySlash("none");
      const title = await ask({ title: "New page inside this one", value: "", placeholder: "Untitled", ok: "Create" });
      tab.editor.focus();
      if (title === null) return;
      const created = await newPage({ title: title || "Untitled", parent: tab.path, open: false });
      if (created) tab.editor.insertInline("wikilink", `[[${created.title}]]`);
      return;
    }
    case "database": {
      notes.applySlash("none");
      const title = await ask({ title: "New database", message: "A page inside this one; its rows are pages too", value: "", placeholder: "Tasks", ok: "Create" });
      tab.editor.focus();
      if (title === null) return;
      try {
        const created = await host("/v1/notes/database", { method: "POST", body: JSON.stringify({ title: title || "Untitled database", parent: tab.path }) });
        expanded.add(tab.path);
        await refreshTree();
        notes.replaceCurrentBlock(`\`\`\`database\nsource: [[${titleOf(created.path)}]]\nview: Table\n\`\`\``);
      } catch (error) { toast(error.message); }
      return;
    }
    case "image": notes.applySlash("none"); ui.imageInput.click(); return;
    default: notes.applySlash(item.id);
  }
}

// --------------------------------------------------------- block menu --

const TURN_INTO = [["text", "Text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["todo", "To-do list"], ["bullet", "Bulleted list"], ["numbered", "Numbered list"], ["quote", "Quote"], ["code", "Code"]];

function blockMenu(tab, { pos, node, rect }) {
  const at = { preventDefault() {}, clientX: rect.left, clientY: rect.bottom + 4 };
  const text = node.textContent;
  contextMenu(at, [
    { label: "Turn into…", icon: "wand_stars", run: () => contextMenu(at, TURN_INTO.map(([id, label]) => ({ label, run: () => tab.editor.notes.turnInto(pos, id) }))) },
    { label: "Duplicate", icon: "content_copy", run: () => tab.editor.notes.duplicateBlock(pos) },
    { label: "Copy text", icon: "content_paste", run: () => navigator.clipboard.writeText(text) },
    "-",
    { label: "Discuss in chat", icon: "forum", run: () => discuss(tab, text) },
    { label: "Ask the agent…", icon: "smart_toy", run: () => void askAgent(tab, text) },
    "-",
    { label: "Delete", icon: "delete", danger: true, run: () => tab.editor.notes.deleteBlock(pos) },
  ]);
}

const quoteBlock = (text) => text.split("\n").map((line) => `> ${line}`).join("\n");
function discuss(tab, text) {
  if (!text.trim()) { toast("This block has no text"); return; }
  void background("chat-draft", { text: `About this in my note “${tab.title}” (${tab.path}):\n\n${quoteBlock(text)}\n\n` });
}
async function askAgent(tab, text) {
  const request = await ask({ title: "Ask the agent", message: "What should the agent do with this? It can edit the page.", value: "", placeholder: "Expand this into a plan with to-dos", ok: "Ask" });
  if (!request) return;
  void background("chat-draft", { text: `${request}\n\nIn my note “${tab.title}” (${tab.path})${text.trim() ? `, about this part:\n\n${quoteBlock(text)}` : "."}\n` });
}

// Selections: discuss, ask, review (as in the Writer).
ui.editorRoot.addEventListener("contextmenu", (event) => {
  if (!editor || !doc.path) return;
  const { selection } = editor.where();
  if (!selection) return;
  contextMenu(event, [
    { label: "Discuss in chat", icon: "forum", run: () => discuss(doc, selection) },
    { label: "Ask the agent…", icon: "smart_toy", run: () => void askAgent(doc, selection) },
    { label: "Review with agent", icon: "rate_review", run: () => void reviewSelection() },
    "-",
    { label: "Copy", icon: "content_copy", run: () => navigator.clipboard.writeText(selection) },
  ]);
});

async function reviewSelection() {
  if (!editor || !doc.path) return null;
  const request = editor.startReview();
  if (!request) { toast("Select some text first"); return null; }
  toast("The agent is reviewing the selection…", { ms: 2000 });
  try {
    const result = await host("/v1/writer/review", { method: "POST", body: JSON.stringify({ text: request.text, before: request.before, after: request.after, heading: request.heading, path: doc.path }) });
    const count = editor.finishReview(request.id, result);
    toast(`${result.summary || "Reviewed"}${count ? ` · ${count} comment${count === 1 ? "" : "s"} (hover the underlines)` : ""}`, { ms: 6000 });
    return result;
  } catch (error) { editor.failReview(request.id, error.message); toast(error.message); return null; }
}

// Review comments: a card on hover with Accept / Discuss / Dismiss.
const card = h("div.rv-card", { hidden: true, onmouseleave: () => { card.hidden = true; } });
document.body.append(card);
ui.editorRoot.addEventListener("mouseover", (event) => {
  const mark = event.target.closest?.(".rv[data-rv]");
  if (!mark || !editor) return;
  const comment = editor.reviews().comments.find((c) => c.id === Number(mark.dataset.rv));
  if (!comment) return;
  card.className = `rv-card rv-card-${comment.kind}`;
  card.replaceChildren(
    h("p.rv-comment", {}, comment.comment),
    comment.replacement !== undefined ? h("div.rv-suggest", {}, h("del", {}, comment.quote), h("span.rv-arrow", {}, "→"), h("ins", {}, comment.replacement || "(remove)")) : null,
    h("div.rv-actions", {},
      comment.replacement !== undefined ? h("button.btn.primary.rv-btn", { type: "button", onclick: () => { editor.acceptComment(comment.id); card.hidden = true; } }, "Accept") : null,
      h("button.btn.rv-btn", { type: "button", onclick: () => { discuss(doc, `${comment.quote}\n\nReview: ${comment.comment}`); card.hidden = true; } }, "Discuss in chat"),
      h("span.spacer"),
      h("button.icon-btn.small", { type: "button", title: "Dismiss", onclick: () => { editor.dismissComment(comment.id); card.hidden = true; } }, icon("close"))));
  card.hidden = false;
  const r = mark.getBoundingClientRect();
  card.style.left = `${Math.min(r.left, innerWidth - card.offsetWidth - 8)}px`;
  card.style.top = `${r.bottom + 6 + card.offsetHeight > innerHeight ? r.top - card.offsetHeight - 6 : r.bottom + 6}px`;
});

// -------------------------------------------------------------- images --

async function uploadAttachment(file) {
  const clean = (file.name || "image.png").replace(/[^\w.-]+/g, "-");
  for (let i = 0; i < 50; i++) {
    const name = i ? clean.replace(/(\.[^.]+)?$/, `-${i + 1}$1`) : clean;
    const path = `${vault}/attachments/${name}`;
    try {
      await host(`/v1/fs/raw?${new URLSearchParams({ path, expect: "absent", createDirs: "1" })}`, { method: "PUT", body: file });
      return path;
    } catch (error) { if (error.status !== 409) { toast(error.message); return null; } }
  }
  return null;
}
async function insertImages(files) {
  if (!doc.path) return;
  for (const file of files) {
    const path = await uploadAttachment(file);
    if (path) editor.insertMarkdown(`![](${encodeURI(relativePath(dirOf(doc.path), path))})`);
  }
}
const imageFiles = (transfer) => [...(transfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
function onPasteImages(event) { const files = imageFiles(event.clipboardData); if (!files.length) return; event.preventDefault(); event.stopPropagation(); void insertImages(files); }
function onDropImages(event) { const files = imageFiles(event.dataTransfer); if (!files.length) return; event.preventDefault(); event.stopPropagation(); void insertImages(files); }
ui.imageInput.addEventListener("change", () => { const files = [...(ui.imageInput.files ?? [])]; ui.imageInput.value = ""; void insertImages(files); });

// ----------------------------------------------------------- databases --

const databaseSchemas = new Map(); // database page path → schema (for the properties of its rows)
function databaseSchemaOf(tab) {
  const parent = tab.info?.parent;
  return parent ? databaseSchemas.get(parent)?.schema ?? null : null;
}

async function queryDatabase(path, view) {
  const db = await host(`/v1/notes/database?${new URLSearchParams({ path, ...(view ? { view } : {}) })}`);
  databaseSchemas.set(db.path, db);
  return db;
}

/** A database page shows its view under the title. */
async function renderDatabasePage(tab) {
  ui.database.hidden = true;
  ui.database.replaceChildren();
  if (tab.info?.parent && !databaseSchemas.has(tab.info.parent)) await queryDatabase(tab.info.parent).catch(() => {});
  if (doc === tab && tab.info?.parent && databaseSchemas.has(tab.info.parent)) renderProperties(props());
  if (!tab.info?.database || doc !== tab) return;
  ui.database.hidden = false;
  await mountDatabase(ui.database, tab.path, {});
}

/** A ```database block: `source: [[Name]]` and `view: Board`. */
async function renderEmbeddedDatabase(tab, el, source) {
  const name = /source:\s*\[\[([^\]|#]+)/.exec(source)?.[1]?.trim();
  const view = /view:\s*(.+)/.exec(source)?.[1]?.trim();
  if (!name) { el.replaceChildren(h("div.db-error", {}, "A database block needs `source: [[Database]]`")); return; }
  const result = await host(`/v1/notes/resolve?${new URLSearchParams({ target: name, from: tab.path ?? "" })}`).catch(() => null);
  if (!result?.path) { el.replaceChildren(h("div.db-error", {}, `No database “${name}”`)); return; }
  await mountDatabase(el, result.path, { view, embedded: true });
}

/** Draw a database view into `el` and keep it current (rows the agent adds show up). */
async function mountDatabase(el, path, { view, embedded = false }) {
  let current = view;
  let last = "";
  const draw = async () => {
    let db;
    try { db = await queryDatabase(path, current); }
    catch (error) { el.replaceChildren(h("div.db-error", {}, error.message)); return; }
    const key = JSON.stringify([db.schema, db.rows, current]);
    if (key === last) return;
    last = key;
    const chosen = db.schema.views.find((v) => v.name === current) ?? db.schema.views[0];
    current = chosen.name;
    const head = h("div.db-head", {},
      embedded ? h("button.db-title", { type: "button", onclick: () => void open_(db.path) }, icon("database", { size: 18 }), titleOf(db.path)) : null,
      h("div.db-views", {}, ...db.schema.views.map((v) => h(`button.db-view${v.name === chosen.name ? ".active" : ""}`, { type: "button", onclick: () => { current = v.name; last = ""; void draw(); } }, icon(v.type === "board" ? "view_kanban" : "table", { size: 16 }), v.name))),
      h("span.spacer"),
      h("button.btn.primary.small", { type: "button", onclick: () => void addRow(db, {}).then(() => { last = ""; return draw(); }) }, icon("add", { size: 16 }), "New"));
    const body = chosen.type === "board" ? boardView(db, chosen, () => { last = ""; void draw(); }) : tableView(db, chosen, () => { last = ""; void draw(); });
    el.replaceChildren(head, body);
  };
  await draw();
  const timer = setInterval(() => { if (!el.isConnected) { clearInterval(timer); return; } if (!document.hidden) void draw(); }, DB_POLL);
}

async function addRow(db, properties) {
  const title = await ask({ title: `New in ${titleOf(db.path)}`, value: "", placeholder: "Untitled", ok: "Add" });
  if (title === null) return;
  await host("/v1/notes/database/row", { method: "POST", body: JSON.stringify({ path: db.path, title: title || "Untitled", properties }) }).catch((error) => toast(error.message));
  void refreshTree();
}

async function setRowProperty(row, name, value, redraw) {
  try {
    const open = tabs.find(row.path);
    if (open) changeProperties({ [name]: value }, open);
    else await host("/v1/notes/properties", { method: "POST", body: JSON.stringify({ path: row.path, properties: { [name]: value } }) });
  } catch (error) { toast(error.message); }
  redraw();
}

async function saveSchema(db, schema, redraw) {
  try { await host("/v1/notes/database", { method: "PUT", body: JSON.stringify({ path: db.path, schema }) }); }
  catch (error) { toast(error.message); }
  redraw();
}

function tableView(db, view, redraw) {
  const columns = db.schema.properties;
  const sortBy = (property) => {
    const was = view.sort?.[0];
    const direction = was?.property === property && was.direction === "asc" ? "desc" : "asc";
    const schema = structuredClone(db.schema);
    schema.views.find((v) => v.name === view.name).sort = [{ property, direction }];
    void saveSchema(db, schema, redraw);
  };
  const arrow = (property) => (view.sort?.[0]?.property === property ? (view.sort[0].direction === "desc" ? " ↓" : " ↑") : "");
  const headCell = (column) => h("th", {}, h("button.db-col", { type: "button", onclick: (e) => contextMenu(e, [
    { label: "Sort", icon: "sort", run: () => sortBy(column.name) },
    { label: "Rename", icon: "drive_file_rename", run: async () => {
      const name = await ask({ title: "Rename column", message: "Row pages keep the old name until edited", value: column.name, ok: "Rename" });
      if (!name || name === column.name) return;
      const schema = structuredClone(db.schema);
      schema.properties.find((p) => p.name === column.name).name = name;
      for (const v of schema.views) if (v.groupBy === column.name) v.groupBy = name;
      await saveSchema(db, schema, () => {});
      for (const row of db.rows) if (row.properties[column.name] !== undefined) await host("/v1/notes/properties", { method: "POST", body: JSON.stringify({ path: row.path, properties: { [column.name]: null, [name]: row.properties[column.name] } }) }).catch(() => {});
      redraw();
    } },
    { label: "Delete column", icon: "delete", danger: true, run: () => { const schema = structuredClone(db.schema); schema.properties = schema.properties.filter((p) => p.name !== column.name); void saveSchema(db, schema, redraw); } },
  ]) }, icon(PROP_ICON[column.type] ?? "text_snippet", { size: 15 }), column.name + arrow(column.name)));
  const addColumn = h("th.db-add-col", {}, h("button", { type: "button", title: "Add a column", onclick: (e) => contextMenu(e, ["text", "number", "select", "multi-select", "date", "checkbox", "url"].map((type) => ({ label: type, icon: PROP_ICON[type], run: async () => {
    const name = await ask({ title: `New ${type} column`, value: "", ok: "Add" });
    if (!name) return;
    const schema = structuredClone(db.schema);
    schema.properties.push({ name, type, ...(type.includes("select") ? { options: [] } : {}) });
    void saveSchema(db, schema, redraw);
  } }))) }, icon("add", { size: 16 })));
  const cell = (row, column) => {
    const value = row.properties[column.name];
    const commit = (next) => {
      if (column.type === "select" && next && !(column.options ?? []).includes(next)) {
        const schema = structuredClone(db.schema);
        schema.properties.find((p) => p.name === column.name).options = [...(column.options ?? []), next];
        void saveSchema(db, schema, () => {});
      }
      void setRowProperty(row, column.name, next, redraw);
    };
    if (column.type === "select") {
      return h("td", {}, h("button.db-chip", { type: "button", dataset: { empty: value ? "" : "1" }, onclick: (e) => contextMenu(e, [
        ...(column.options ?? []).map((o) => ({ label: o, run: () => commit(o) })),
        "-",
        { label: "New option…", icon: "add", run: async () => { const o = await ask({ title: column.name, message: "New option", value: "", ok: "Add" }); if (o) commit(o); } },
        ...(value ? [{ label: "Clear", icon: "close", run: () => commit(null) }] : []),
      ]) }, value ? String(value) : "—"));
    }
    return h("td", {}, propertyInput(column.type, value, commit, column));
  };
  const table = h("table.db-table", {},
    h("thead", {}, h("tr", {}, h("th.db-name", {}, h("button.db-col", { type: "button", onclick: () => sortBy("Title") }, icon("text_snippet", { size: 15 }), `Name${arrow("Title")}`)), ...columns.map(headCell), addColumn)),
    h("tbody", {}, ...db.rows.map((row) => h("tr", {},
      h("td.db-name", {}, h("button.db-open", { type: "button", onclick: () => void open_(row.path) }, row.icon ? h("span.emoji", {}, row.icon) : icon("description", { size: 16 }), h("span", {}, row.title))),
      ...columns.map((column) => cell(row, column)), h("td")))));
  const foot = h("button.db-new-row", { type: "button", onclick: () => void addRow(db, {}).then(redraw) }, icon("add", { size: 16 }), "New");
  return h("div.db-body", {}, h("div.db-scroll", {}, table), foot, h("div.db-count", {}, `${db.rows.length} page${db.rows.length === 1 ? "" : "s"}`));
}

function boardView(db, view, redraw) {
  const column = db.schema.properties.find((p) => p.name === view.groupBy) ?? db.schema.properties.find((p) => p.type === "select");
  if (!column) return h("div.db-error", {}, "A board groups by a select property: add one first.");
  const groups = [...(column.options ?? []), ...new Set(db.rows.map((r) => r.properties[column.name]).filter((v) => v && !(column.options ?? []).includes(v)))];
  const lane = (value) => {
    const rows = db.rows.filter((r) => (value === null ? !r.properties[column.name] : String(r.properties[column.name]) === value));
    const el = h("div.board-lane", {
      ondragover: (e) => { if (e.dataTransfer.types.includes("text/x-note-row")) { e.preventDefault(); el.classList.add("drop"); } },
      ondragleave: () => el.classList.remove("drop"),
      ondrop: (e) => { e.preventDefault(); el.classList.remove("drop"); const row = db.rows.find((r) => r.path === e.dataTransfer.getData("text/x-note-row")); if (row) void setRowProperty(row, column.name, value, redraw); },
    },
    h("div.lane-head", {}, h("span.db-chip", { dataset: { empty: value === null ? "1" : "" } }, value ?? `No ${column.name}`), h("span.lane-count", {}, String(rows.length))),
    ...rows.map((row) => h("div.board-card", { draggable: "true", ondragstart: (e) => { e.dataTransfer.setData("text/x-note-row", row.path); e.dataTransfer.effectAllowed = "move"; }, onclick: () => void open_(row.path) },
      h("div.card-title", {}, row.icon ? `${row.icon} ` : "", row.title),
      h("div.card-props", {}, ...db.schema.properties.filter((p) => p.name !== column.name && row.properties[p.name] !== undefined && row.properties[p.name] !== "").slice(0, 3).map((p) => h("span.card-prop", {}, Array.isArray(row.properties[p.name]) ? row.properties[p.name].join(", ") : String(row.properties[p.name])))))),
    h("button.db-new-row", { type: "button", onclick: () => void addRow(db, value === null ? {} : { [column.name]: value }).then(redraw) }, icon("add", { size: 16 }), "New"));
    return el;
  };
  return h("div.board", {}, ...groups.map(lane), lane(null));
}

// ----------------------------------------------------------- switcher --

/** The quick switcher (and page picker): search titles and text; resolves { path, title } or { create } or null. */
function pickPage({ title = "Go to a page", create = "Create page" } = {}) {
  return new Promise((resolve) => {
    let index = 0;
    let shown = [];
    let seq = 0;
    const input = h("input.input", { type: "text", placeholder: "Search pages" });
    const list = h("div.switch-list");
    const close = (value) => { backdrop.remove(); resolve(value); };
    const draw = async () => {
      const q = input.value.trim();
      const n = ++seq;
      let items;
      if (!q) {
        const recent = (await load("recent", [])).filter((p) => byPath.has(p));
        items = recent.map((path) => ({ path, title: byPath.get(path).title, icon: byPath.get(path).icon, snippet: placeOf(path) }));
      } else {
        const { results = [] } = await host(`/v1/notes/search?${new URLSearchParams({ q, limit: "30" })}`).catch(() => ({}));
        items = results.map((r) => ({ ...r, snippet: r.snippet || placeOf(r.path) }));
        if (!items.some((r) => r.title.toLowerCase() === q.toLowerCase())) items.push({ create: q });
      }
      if (n !== seq) return;
      shown = items;
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((item, k) => h(`button.switch-item${k === index ? ".active" : ""}`, { type: "button", onclick: () => close(item) },
        h("span.switch-icon", {}, item.create ? icon("add", { size: 18 }) : item.icon ? item.icon : icon("description", { size: 18 })),
        h("span.switch-text", {}, h("span.switch-title", {}, item.create ? `${create} “${item.create}”` : item.title), item.snippet ? h("span.switch-snippet", {}, item.snippet) : null))) : [h("p.switch-empty", {}, q ? "No pages" : "Type to search")]));
      list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => { index = 0; void draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { index = Math.min(index + 1, shown.length - 1); void draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { index = Math.max(0, index - 1); void draw(); e.preventDefault(); }
      else if (e.key === "Enter") { const item = shown[index]; if (item) close(item); e.preventDefault(); }
      else if (e.key === "Escape") { e.stopPropagation(); close(null); }
    });
    const backdrop = h("div.dialog-backdrop.switch-backdrop", { onclick: (e) => { if (e.target === backdrop) close(null); } }, h("div.dialog.switcher", {}, h("div.switch-head", {}, icon("search", { size: 18 }), h("span", {}, title)), input, list));
    document.body.append(backdrop);
    void draw();
    input.focus();
  });
}

async function quickSwitch() {
  const choice = await pickPage();
  if (!choice) return;
  if (choice.create) await newPage({ title: choice.create });
  else await open_(choice.path);
}

// ---------------------------------------------------------- start page --

async function showStart() {
  ui.start.hidden = false;
  ui.page.hidden = true;
  ui.crumbs.hidden = true;
  document.title = "Notes";
  hideBar();
  renderTree();
  const recent = (await load("recent", [])).filter((p) => byPath.has(p)).slice(0, 8);
  ui.start.replaceChildren(
    h("div.start-icon", {}, icon("notes", { size: 44 })),
    h("h2", {}, "Notes"),
    h("p", {}, "Pages, links and databases, kept as Markdown files in ", h("code", {}, vault.replace(/^\/home\/[^/]+/, "~")), ". Type / in a page for blocks, [[ to link a page."),
    h("div.buttons", {}, h("button.btn.primary", { type: "button", onclick: () => void newPage({}) }, icon("add", { size: 18 }), "New page"), h("button.btn", { type: "button", onclick: () => void quickSwitch() }, icon("search", { size: 18 }), "Find a page")),
    ...(recent.length ? [h("h3", {}, "Recently opened"), h("div.recent", {}, ...recent.map((path) => {
      const node = byPath.get(path);
      return h("button", { type: "button", onclick: () => void open_(path) }, h("span.recent-icon", {}, node.icon ?? icon("description")), h("div", { style: { minWidth: 0 } }, h("div.name", {}, node.title), h("div.path", {}, placeOf(path))));
    }))] : []),
  );
  return { opened: null };
}

async function chooseVault() {
  const path = await ask({ title: "Notes folder", message: "The folder that holds your pages (an Obsidian vault works too)", value: vault.replace(/^\/home\/[^/]+/, "~"), ok: "Use this folder" });
  if (!path) return;
  try {
    for (const tab of [...tabs.tabs]) await tabs.close(tab);
    await host("/v1/notes/vault", { method: "POST", body: JSON.stringify({ path }) });
    await refreshTree();
    await showStart();
  } catch (error) { toast(error.message); }
}

// ------------------------------------------------------------ keyboard --

addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.shiftKey && event.key.toLowerCase() === "s") { event.preventDefault(); if (doc.path) void saveTab(doc); }
  if (mod && !event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); void quickSwitch(); }
  if (mod && !event.shiftKey && event.key.toLowerCase() === "n") { event.preventDefault(); void newPage({}); }
  if (mod && event.altKey && event.key.toLowerCase() === "r") { event.preventDefault(); void reviewSelection(); }
});
addEventListener("pagehide", () => { for (const tab of tabs.tabs) if (tab.dirty) void tabs.writeDraft(tab); });

// The File viewer hands over Markdown pages from the vault.
async function takeHandoff() {
  const handoff = await background("viewer-handoff", { editor: "notes", vault }).catch(() => null);
  if (handoff?.path) await open_(handoff.path);
  return Boolean(handoff?.path);
}
// Coming back: pages may have changed meanwhile (the agent, another program), so the tree and links are read again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void takeHandoff();
  void refreshTree();
  const tab = doc;
  if (tab.path) void refreshInfo(tab).then(() => { if (doc === tab) { renderBacklinks(); renderCrumbs(); } });
});

// Keep the "Saving…" crumb honest.
tabs.onChange = () => { renderCrumbs(); };

// -------------------------------------------------------------- agent API --

registerPage("notes", {
  state: () => ({
    vault,
    path: doc.path,
    title: doc.path ? doc.title : null,
    unsavedChanges: Boolean(doc.dirty),
    properties: doc.path ? props() : undefined,
    database: doc.info?.database ? true : undefined,
    tabs: tabs.tabs.map((t) => ({ path: t.path, modified: t.dirty, active: t === doc })),
    cursor: editor && doc.path ? editor.where() : undefined,
    outline: editor && doc.path ? editor.outline().map((o) => `${"#".repeat(o.level || 0)} ${o.text}`) : undefined,
  }),
  commands: {
    open: async ({ query, path, title }) => {
      let target = path ?? query;
      if (!target && title) target = (await host(`/v1/notes/resolve?${new URLSearchParams({ target: title })}`)).path;
      if (target && !target.includes("/") && !/\.md$/i.test(target)) target = (await host(`/v1/notes/resolve?${new URLSearchParams({ target })}`).catch(() => ({}))).path ?? target;
      if (!target) throw new Error("No such page");
      return open_(target.startsWith("~") || target.startsWith("/") ? target : `${vault}/${target}`);
    },
    new: async ({ title, parent, folder, body }) => newPage({ title: title || "Untitled", parent, folder, body }),
    rename: async ({ path, title }) => {
      const target = path ?? doc.path;
      if (!target || !title) throw new Error("Which page, and its new title?");
      return renamePage(target, title);
    },
    save: async () => ({ saved: doc.path ? await saveTab(doc) : false }),
    close: async ({ path }) => {
      const tab = path ? tabs.find(path) : doc;
      if (!tab?.path) throw new Error("No such page is open");
      return { closed: await tabs.close(tab) };
    },
    insert: async ({ markdown, at = "cursor" }) => {
      if (!doc.path) throw new Error("No page is open");
      let where = at;
      if (at !== "cursor" && at !== "end") {
        const item = editor.outline().find((o) => o.text.toLowerCase() === String(at).toLowerCase());
        if (!item) throw new Error(`No heading “${at}”`);
        where = item.pos;
      }
      const count = editor.insertMarkdown(markdown, where);
      return { inserted: count, saved: await saveTab(doc) };
    },
    reveal: ({ heading, text }) => {
      if (!doc.path) throw new Error("No page is open");
      const pos = heading ? editor.outline().find((o) => o.text.toLowerCase() === heading.toLowerCase())?.pos : editor.find(text);
      if (pos === null || pos === undefined) throw new Error("Not found");
      editor.reveal(pos);
      return { revealed: true };
    },
    select: ({ text }) => { if (!editor?.selectText(String(text ?? ""))) throw new Error("Text not found on the page"); return { selected: text }; },
    review: async ({ text }) => {
      if (text && !editor?.selectText(String(text))) throw new Error("Text not found on the page");
      const result = await reviewSelection();
      return result ? { verdict: result.verdict, summary: result.summary, comments: result.comments } : null;
    },
    "set-properties": ({ properties }) => { if (!doc.path) throw new Error("No page is open"); changeProperties(properties ?? {}); return { properties: props() }; },
    switcher: () => { void quickSwitch(); return { shown: true }; },
    focus: ({ end = false }) => {
      if (!editor || !doc.path) throw new Error("No page is open");
      if (end) editor.reveal(Math.max(0, editor.view.state.doc.content.size - 2)); else editor.focus();
      return { focused: true };
    },
  },
});

// --------------------------------------------------------------- start --

$("#vault-icon").append(icon("notes", { size: 20 }));
$("#search .si").append(icon("search", { size: 18 }));
$("#new-page .si").append(icon("add", { size: 18 }));
$("#trash .si").append(icon("delete", { size: 18 }));
$("#add-root").append(icon("add", { size: 16 }));
$("#search").addEventListener("click", () => void quickSwitch());
$("#new-page").addEventListener("click", () => void newPage({}));
$("#add-root").addEventListener("click", () => void newPage({}));
$("#trash").addEventListener("click", () => void showTrash());
ui.vault.addEventListener("click", () => void chooseVault());
// Dropping a page on the "Pages" heading moves it to the top level.
const rootDrop = $("#add-root").parentElement;
rootDrop.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-note")) { e.preventDefault(); rootDrop.classList.add("drop"); } });
rootDrop.addEventListener("dragleave", () => rootDrop.classList.remove("drop"));
rootDrop.addEventListener("drop", (e) => { e.preventDefault(); rootDrop.classList.remove("drop"); void movePage(e.dataTransfer.getData("text/x-note"), {}); });

expanded = new Set(await load("expanded", []));
favourites = await load("favourites", []);
await refreshTree();
const restored = await tabs.restore();
if (!(await takeHandoff()) && !restored) {
  const recent = (await load("recent", [])).find((p) => byPath.has(p));
  if (recent) await open_(recent); else await showStart();
}
