// Writer space: a word-processor-like editor for Quarto (.qmd) and Markdown.
//
// Each open document has a tab (shared/doctabs.js) with its own editor (vendor/writer, see
// src/writer/editor.mjs), which writes untouched blocks back byte for byte. Ctrl+S saves with a
// lost-update guard; a tab with unsaved changes shows a dot and keeps a draft. Outside edits (the
// agent's, another editor's) reload a clean tab live and merge line by line into a modified one.
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, contextMenu, background, toast, registerPage, ask } from "./shared/page.js";
import { DocTabs } from "./shared/doctabs.js";
import { createWriter, merge3, labels } from "./vendor/writer/writer.mjs";

const GRAMMAR_DELAY = 1800;
const BACKUPS = "~/.local/state/mail-workspace/writer-backups";

const ui = {
  title: $("#title"), subtitle: $("#subtitle"), state: $("#state"), actions: $("#actions"), render: $("#render"),
  toolbar: $("#toolbar"), conflict: $("#conflict"), outline: $("#outline"), scroll: $("#scroll"), start: $("#start"),
  page: $("#page"), editorRoot: $("#editor"), statusbar: $("#statusbar"), where: $("#where"), words: $("#words"),
  grammarCount: $("#grammar-count"), imageInput: $("#image-input"),
};

// One state object per tab; `doc` and `editor` always point at the active tab's.
//   path, hash (the version on disk we last read or wrote, sent as `expect`), base (its text),
//   status (saved | saving | conflict | readonly | error), bibliography, editor, root, scroll
const EMPTY = { path: null, hash: null, base: null, status: "idle", bibliography: new Map() };
let doc = EMPTY;
let editor = null;
const backedUp = new Set();
let saving = null;
let watchToken = 0;
let outlineOpen = false;
let grammarOn = false;
let grammarTimer = null;
const grammarCache = new Map(); // block text → matches
const imageUrls = new Map();

// -------------------------------------------------------------- helpers --

const dirOf = (path) => path.replace(/\/[^/]+$/, "") || "/";
const nameOf = (path) => path.split("/").pop();
const isDocument = (path) => /\.(qmd|md|markdown|rmd)$/i.test(path);
const isQuarto = () => /\.qmd$/i.test(doc.path ?? "");

/** The header chip, for states worth a word (the tab's dot already says "modified"). */
function setStatus(status, detail = "", tab = doc) {
  tab.status = status;
  if (tab !== doc) return;
  const label = { saving: "Saving…", conflict: "Changed on disk", readonly: "Read-only", error: "Not saved", rendering: "Rendering…" }[status];
  ui.state.hidden = !label;
  ui.state.textContent = label ?? "";
  ui.state.className = `chip ${status === "saving" ? "unsaved" : status === "rendering" ? "" : "warning"}`;
  ui.state.title = detail;
}

async function recent() {
  const { "writer.recent": list = [] } = await browser.storage.local.get("writer.recent").catch(() => ({}));
  return list;
}
async function remember(path) {
  const list = (await recent()).filter((p) => p !== path);
  list.unshift(path);
  await browser.storage.local.set({ "writer.recent": list.slice(0, 12), "writer.last": path }).catch(() => {});
}

// ----------------------------------------------------------- editor setup --

/** An editor of its own for a tab (undo history and scroll survive switching tabs). */
async function createTabEditor(tab) {
  tab.root = h("div.tab-editor", { hidden: true });
  ui.editorRoot.append(tab.root);
  tab.editor = await createWriter(tab.root, {
    onChange: () => {
      if (!tab.path || tab.status === "readonly") return;
      tabs.setDirty(tab, tab.editor.markdown() !== tab.base);
      if (tab !== doc) return;
      scheduleOutline();
      scheduleGrammar();
      drawFrames();
    },
    onSelection: () => { if (tab === doc) updateWhere(); },
    resolveImage: (src) => resolveImage(tab, src),
    editInline: editChip,
    describeInline: (attrs, el) => {
      if (attrs.kind !== "cite") return;
      const keys = [...attrs.source.matchAll(/@([\w:.#$%&\-+?<>~/]+\w)/g)].map((m) => m[1]);
      const known = keys.map((k) => tab.bibliography.get(k));
      if (tab.bibliography.size && known.some((e) => !e)) el.classList.add("unknown");
      el.title = known.map((e, i) => e ? `${e.author.split(" and ")[0]}${e.year ? ` (${e.year})` : ""}: ${e.title}` : `${keys[i]}: not in the bibliography`).join("\n") || el.title;
    },
  });
  return tab.editor;
}
ui.editorRoot.addEventListener("paste", onPasteImages, true);
ui.editorRoot.addEventListener("drop", onDropImages, true);
ui.editorRoot.addEventListener("click", onGrammarClick);

async function resolveImage(tab, src) {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (!tab.path) return null;
  const full = src.startsWith("/") ? src : `${dirOf(tab.path)}/${src.replace(/^\.\//, "")}`;
  if (imageUrls.has(full)) return imageUrls.get(full);
  const link = await host("/v1/links", { method: "POST", body: JSON.stringify({ path: full }) }).catch(() => null);
  const url = link ? `${HOST_ENDPOINT}${link.url}` : null;
  if (url) imageUrls.set(full, url);
  return url;
}

// ---------------------------------------------------------------- tabs --

const tabs = new DocTabs({
  page: "writer",
  mount: $("#tabs"),
  icon: "writer",
  onEmpty: () => void showStart(),
  adapter: {
    /** Read the file into a new tab; a draft (unsaved changes from before a reload) is merged back in. */
    async load(tab, draft) {
      const file = await host(`/v1/fs/read?path=${encodeURIComponent(tab.path)}`);
      if (file.truncated) throw new Error("This document is too large for the Writer");
      Object.assign(tab, { hash: file.hash, base: file.text, status: "saved", bibliography: new Map(), scroll: 0 });
      await createTabEditor(tab);
      let text = file.text;
      if (draft?.text !== undefined && draft.text !== file.text) {
        if (draft.baseHash === file.hash) text = draft.text;
        else {
          const merged = merge3(draft.base ?? file.text, draft.text, file.text);
          text = merged.conflicts ? draft.text : merged.text;
          if (merged.conflicts) tab.conflictOnShow = true;
        }
      }
      const result = tab.editor.load(text);
      tab.safe = result.safe;
      tab.blocks = result.blocks;
      if (!result.safe) tab.status = "readonly";
      tab.dirty = tab.status !== "readonly" && tab.editor.markdown() !== tab.base;
      void loadBibliography(tab);
    },
    async show(tab) {
      doc = tab;
      editor = tab.editor;
      for (const other of tabs.tabs) if (other.root) other.root.hidden = other !== tab;
      ui.start.hidden = true;
      ui.page.hidden = false;
      ui.toolbar.hidden = false;
      ui.statusbar.hidden = false;
      ui.render.hidden = false;
      ui.title.textContent = nameOf(tab.path);
      ui.subtitle.textContent = dirOf(tab.path).replace(/^\/home\/[^/]+/, "~");
      document.title = `${nameOf(tab.path)} · Writer`;
      ui.page.classList.toggle("readonly", !tab.safe);
      editor.view.setProps({ editable: () => tab.safe });
      setStatus(tab.status === "readonly" ? "readonly" : tab.status === "conflict" ? "conflict" : "saved", "", tab);
      hideBar();
      if (!tab.safe) {
        showBar("This document cannot be edited safely here: saving would change text you did not edit. It is open read-only.", [["Open in viewer", () => background("open-file", { path: tab.path })]], true);
      } else if (tab.conflictOnShow) {
        tab.conflictOnShow = false;
        showBar("This document changed on disk while it had unsaved changes here; your version is kept. Save to overwrite, or reload.", [["Reload from disk", () => reloadFromDisk(tab)]]);
      }
      hideCard();
      renderToolbar();
      renderActions();
      renderOutline();
      updateWhere();
      drawFrames();
      requestAnimationFrame(() => { ui.scroll.scrollTop = tab.scroll ?? 0; });
      if (grammarOn) scheduleGrammar(200);
      await remember(tab.path);
      void watch(tab);
    },
    hide(tab) {
      tab.scroll = ui.scroll.scrollTop;
      if (tab.root) tab.root.hidden = true;
      watchToken++;
      hideCard();
    },
    save: (tab) => save({ tab }).then((result) => result.saved),
    draft: (tab) => ({ text: tab.editor.markdown(), base: tab.base, baseHash: tab.hash }),
    dispose(tab) {
      try { tab.editor?.destroy(); } catch { /* already gone */ }
      tab.root?.remove();
      if (doc === tab) { doc = EMPTY; editor = null; }
    },
  },
});

/** Open a document in its tab (other files go to the viewer). */
async function open(path) {
  if (!path) return showStart();
  const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch((error) => { toast(error.message); return null; });
  if (!info || info.directory) return tabs.tabs.length ? { opened: null } : showStart();
  if (!isDocument(info.path)) { await background("open-file", { path: info.path }); return { opened: "viewer", path: info.path }; }
  let tab;
  try { tab = await tabs.open(info.path); }
  catch (error) { toast(error.message); return tabs.tabs.length ? { opened: null } : showStart(); }
  return { opened: "writer", path: tab.path, safe: tab.safe, blocks: tab.blocks, modified: tab.dirty };
}

async function loadBibliography(tab = doc) {
  tab.bibliography = new Map();
  if (!tab.path) return;
  const bib = await host(`/v1/writer/bibliography?path=${encodeURIComponent(tab.path)}`).catch(() => null);
  for (const entry of bib?.entries ?? []) tab.bibliography.set(entry.key, entry);
}

// ---------------------------------------------------------------- save --

/** Save a tab (the active one by default). If the file changed on disk, merge first, then save. */
async function save({ tab = doc, force = false } = {}) {
  if (!tab?.path || !tab.editor || tab.status === "readonly") return { saved: false };
  if (saving) { await saving; }
  const text = tab.editor.markdown();
  if (text === tab.base && !force) { tabs.setDirty(tab, false); return { saved: true, unchanged: true }; }
  saving = (async () => {
    setStatus("saving", "", tab);
    try {
      await backup(tab);
      const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: tab.path, text, expect: tab.hash }) });
      tab.hash = result.hash;
      tab.base = text;
      setStatus("saved", "", tab);
      tabs.saved(tab);
      if (tab.editor.markdown() !== text) tabs.setDirty(tab, true);
      if (tab === doc) hideBar();
      return { saved: true };
    } catch (error) {
      if (error.status === 409) {
        const merged = await mergeFromDisk(tab);
        if (merged === "merged") return save({ tab });
        return { saved: false, conflict: true };
      }
      setStatus("error", error.message, tab);
      toast(`Not saved: ${error.message}`);
      return { saved: false, error: error.message };
    }
  })();
  try { return await saving; } finally { saving = null; }
}

/** First save of a session: keep a copy of the file as it was on disk. */
async function backup(tab) {
  if (backedUp.has(tab.path)) return;
  backedUp.add(tab.path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: `${BACKUPS}/${nameOf(tab.path)}.${stamp}`, text: tab.base, createDirs: true }) }).catch(() => {});
}

/**
 * The file changed on disk. A clean tab just reloads; a modified one merges the change in line by line
 * (still unsaved), or, when both changed the same lines, keeps the user's version and says so.
 * Returns "reloaded" | "merged" | "conflict" | "gone".
 */
async function mergeFromDisk(tab) {
  const file = await host(`/v1/fs/read?path=${encodeURIComponent(tab.path)}`).catch(() => null);
  if (!file) {
    setStatus("error", "The file was removed", tab);
    if (tab === doc) showBar("This document was moved or deleted on disk.", [["Save here again", () => { tab.hash = "absent"; hideBar(); return save({ tab, force: true }); }]], true);
    return "gone";
  }
  if (file.hash === tab.hash) return "reloaded";
  const mine = tab.editor.markdown();
  if (mine === tab.base) {
    reloadText(tab, file.text);
    Object.assign(tab, { base: file.text, hash: file.hash });
    tabs.setDirty(tab, false);
    setStatus("saved", "", tab);
    return "reloaded";
  }
  const merged = merge3(tab.base, mine, file.text);
  if (merged.conflicts === 0) {
    reloadText(tab, merged.text);
    Object.assign(tab, { base: file.text, hash: file.hash });
    tabs.setDirty(tab, merged.text !== file.text);
    setStatus("saved", "", tab);
    return "merged";
  }
  setStatus("conflict", "", tab);
  if (tab === doc) {
    showBar("This document changed on disk where you have unsaved edits to the same lines.", [
      ["Show changes", () => showDiff(file.text, mine)],
      ["Reload from disk", () => reloadFromDisk(tab, file)],
      ["Keep mine", async () => { tab.hash = file.hash; tab.base = file.text; hideBar(); await save({ tab, force: true }); }],
    ]);
  }
  return "conflict";
}

async function reloadFromDisk(tab, file) {
  file ??= await host(`/v1/fs/read?path=${encodeURIComponent(tab.path)}`);
  reloadText(tab, file.text);
  Object.assign(tab, { base: file.text, hash: file.hash });
  tabs.setDirty(tab, false);
  setStatus("saved", "", tab);
  hideBar();
}

function reloadText(tab, text) {
  const result = tab.editor.load(text, { keep: true });
  if (tab === doc) { drawFrames(); renderOutline(); }
  if (!result.safe) { setStatus("readonly", "", tab); tab.editor.view.setProps({ editable: () => false }); }
}

/** Live reload of the active tab: wait for its file to change on disk, then fold the change in. */
async function watch(tab) {
  const token = ++watchToken;
  while (token === watchToken && doc === tab && tabs.tabs.includes(tab)) {
    const change = await host(`/v1/fs/watch?path=${encodeURIComponent(tab.path)}&since=${tab.hash}&wait=25000`).catch(() => null);
    if (token !== watchToken || doc !== tab) return;
    if (!change) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (change.hash === tab.hash || saving) continue;
    if (change.absent) { setStatus("error", "The file was removed", tab); continue; }
    const outcome = await mergeFromDisk(tab);
    if (outcome === "reloaded") flash("Updated from disk");
    if (outcome === "merged") flash("Merged changes from disk into your unsaved edits");
  }
}

function flash(message) { toast(message, { ms: 1800 }); }

// ----------------------------------------------------------- notices --

function showBar(message, buttons = [], danger = false) {
  ui.conflict.hidden = false;
  ui.conflict.className = `conflict${danger ? " danger" : ""}`;
  ui.conflict.replaceChildren(icon(danger ? "error" : "warning", { size: 18 }), h("span", {}, message), h("span.spacer"),
    ...buttons.map(([label, run]) => h("button.btn.small", { type: "button", onclick: run }, label)));
}
function hideBar() { ui.conflict.hidden = true; }

function showDiff(theirs, mine) {
  const a = theirs.split("\n");
  const b = mine.split("\n");
  const rows = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) if (a[i] !== b[i]) rows.push(h("div", {}, h("div", { style: { color: "var(--mw-danger)", whiteSpace: "pre-wrap" } }, `disk  ${i + 1}: ${a[i] ?? ""}`), h("div", { style: { color: "var(--mw-success)", whiteSpace: "pre-wrap" } }, `yours ${i + 1}: ${b[i] ?? ""}`)));
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog", { style: { width: "min(900px, calc(100vw - 32px))" } }, h("h2", {}, "Lines that differ"), h("div", { style: { font: "12.5px var(--mw-font-mono)", display: "grid", gap: "8px" } }, ...rows.slice(0, 200)),
      h("div.actions", {}, h("button.btn", { type: "button", onclick: () => backdrop.remove() }, "Close"))));
  document.body.append(backdrop);
}

// ------------------------------------------------------------- toolbar --

function renderToolbar() {
  const run = (name, payload) => () => { try { editor.command(name, payload); } catch (error) { toast(error.message); } };
  const tb = (name, title, onclick) => iconButton(name, title, onclick, { small: true });
  const text = (label, title, onclick) => h("button.tb-text", { type: "button", title, onclick }, label);
  const sep = () => h("span.divider");
  ui.toolbar.replaceChildren(
    tb("undo", "Undo (Ctrl+Z)", run("undo")), tb("redo", "Redo (Ctrl+Shift+Z)", run("redo")), sep(),
    text("Text", "Normal text", run("paragraph")), tb("format_h1", "Heading 1", run("heading", 1)), tb("format_h2", "Heading 2", run("heading", 2)), tb("format_h3", "Heading 3", run("heading", 3)), sep(),
    tb("format_bold", "Bold (Ctrl+B)", run("bold")), tb("format_italic", "Italic (Ctrl+I)", run("italic")), tb("format_strikethrough", "Strikethrough", run("strike")), tb("code", "Inline code", run("code")), sep(),
    tb("format_list_bulleted", "Bulleted list", run("bullet")), tb("format_list_numbered", "Numbered list", run("ordered")), tb("format_quote", "Quote", run("quote")), sep(),
    tb("link", "Link", insertLink), tb("image", "Figure", insertFigure), tb("table", "Table", run("table")), tb("horizontal_rule", "Divider", run("hr")), sep(),
    text("x²", "Inline math", insertInlineMath), tb("functions", "Equation", insertEquation), tb("menu_book", "Citation", insertCitation), tb("tag", "Cross-reference", insertCrossref), sep(),
    tb("lightbulb", "Callout", insertCallout), tb("data_object", "Code cell", insertCodeCell),
  );
}

function renderActions() {
  ui.actions.replaceChildren(
    iconButton("toc", outlineOpen ? "Hide outline" : "Show outline", () => { outlineOpen = !outlineOpen; renderOutline(); renderActions(); }, { pressed: outlineOpen }),
    iconButton("spellcheck", grammarOn ? "Grammar checking: on" : "Grammar checking: off", toggleGrammar, { pressed: grammarOn }),
    iconButton("save", "Save (Ctrl+S)", () => save({ force: false })),
    iconButton("folder_open", "Open a document", openDialog),
    iconButton("note_add", "New document", newDocument),
  );
  ui.render.replaceChildren(icon("picture_as_pdf", { size: 18 }), "Render PDF");
}

// Insertions ------------------------------------------------------------------

async function insertLink() {
  const href = await ask({ title: "Link", message: "Select the text first; it becomes the link text.", value: "https://", ok: "Link" });
  if (href) editor.command("link", { href });
}

async function insertInlineMath() {
  const tex = await ask({ title: "Inline math", message: "TeX, without dollar signs", value: "", placeholder: "\\tau_i", ok: "Insert" });
  if (tex) editor.insertInline("math", `$${tex}$`);
}

async function insertEquation() {
  const tex = await ask({ title: "Equation", message: "TeX for a numbered display equation", value: "", placeholder: "\\frac{d\\tau}{dt} = \\alpha_T \\tau (1 - \\tau)", ok: "Next" });
  if (!tex) return;
  const label = await ask({ title: "Equation label", message: "Used to refer to it as @eq-…; leave empty for an unnumbered equation", value: "eq-", ok: "Insert" });
  const id = label && label !== "eq-" ? (label.startsWith("eq-") ? label : `eq-${label}`) : "";
  editor.insertBlocks([["math", `$$\n${tex}\n$$${id ? ` {#${id}}` : ""}`, id]]);
}

async function insertCallout() {
  const kind = await ask({ title: "Callout", message: "note, tip, warning, important or caution", value: "note", ok: "Insert" });
  if (!kind) return;
  const type = ["note", "tip", "warning", "important", "caution"].includes(kind) ? kind : "note";
  editor.insertBlocks([["div", `::: {.callout-${type}}`, `callout-${type}`], ["markdown", "Text of the callout."], ["div", ":::", ""]]);
}

function insertCodeCell() {
  editor.insertBlocks([["code", "```{python}\n#| echo: false\n\n```", "{python}"]]);
}

function insertFigure(event) {
  contextMenu(event, [
    { label: "Upload an image…", icon: "upload", run: () => ui.imageInput.click() },
    { label: "Use an image in the project…", icon: "image", run: async () => {
      const path = await ask({ title: "Figure", message: "Path relative to the document", value: "figures/", ok: "Next" });
      if (path) await placeFigure(path);
    } },
  ]);
}
ui.imageInput.addEventListener("change", async () => {
  const file = ui.imageInput.files?.[0];
  ui.imageInput.value = "";
  if (file) await uploadImage(file);
});

async function placeFigure(path, caption) {
  const name = nameOf(path).replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").toLowerCase();
  const text = caption ?? await ask({ title: "Caption", value: "", placeholder: "What the figure shows", ok: "Insert" }) ?? "";
  editor.insertMarkdown(`![${text}](${path}){#fig-${name}}`);
}

async function uploadImage(file) {
  if (!doc.path) return;
  const base64 = await new Promise((resolveRead) => { const reader = new FileReader(); reader.onload = () => resolveRead(String(reader.result).split(",")[1]); reader.readAsDataURL(file); });
  const clean = (file.name || "image.png").replace(/[^\w.-]+/g, "-");
  for (let i = 0; i < 50; i++) {
    const name = i ? clean.replace(/(\.[^.]+)?$/, `-${i + 1}$1`) : clean;
    try {
      await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: `${dirOf(doc.path)}/figures/${name}`, base64, createDirs: true, expect: "absent" }) });
      await placeFigure(`figures/${name}`);
      return;
    } catch (error) { if (error.status !== 409) { toast(error.message); return; } }
  }
}
function imageFiles(transfer) { return [...(transfer?.files ?? [])].filter((f) => f.type.startsWith("image/")); }
function onPasteImages(event) {
  const files = imageFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault(); event.stopPropagation();
  for (const file of files) void uploadImage(file);
}
function onDropImages(event) {
  const files = imageFiles(event.dataTransfer);
  if (!files.length) return;
  event.preventDefault(); event.stopPropagation();
  for (const file of files) void uploadImage(file);
}

/** A searchable list dialog; resolves to the chosen item or null. */
function pick({ title, items, describe, empty }) {
  return new Promise((resolvePick) => {
    let index = 0;
    const input = h("input.input", { type: "text", placeholder: "Search" });
    const list = h("div.list");
    const close = (value) => { backdrop.remove(); resolvePick(value); };
    const draw = () => {
      const q = input.value.toLowerCase();
      const shown = items.filter((item) => describe(item).join(" ").toLowerCase().includes(q)).slice(0, 200);
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((item, k) => { const [main, meta] = describe(item); return h(`button${k === index ? ".active" : ""}`, { type: "button", onclick: () => close(item) }, h("div.key", {}, main), meta ? h("div.meta", {}, meta) : null); }) : [h("p", {}, empty)]));
      list._shown = shown;
    };
    input.addEventListener("input", () => { index = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { index++; draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { index = Math.max(0, index - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter") { const item = list._shown?.[index]; if (item) close(item); e.preventDefault(); }
      else if (e.key === "Escape") close(null);
    });
    const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) close(null); } }, h("div.dialog.picker", {}, h("h2", {}, title), input, list));
    document.body.append(backdrop);
    draw();
    input.focus();
  });
}

async function insertCitation() {
  await loadBibliography();
  const items = [...doc.bibliography.values()];
  if (!items.length) { toast(isQuarto() ? "No bibliography: add `bibliography: refs.bib` to the document settings" : "No bibliography for this document"); return; }
  const entry = await pick({ title: "Insert citation", items, describe: (e) => [`@${e.key}`, `${e.author.split(" and ")[0]}${e.year ? ` ${e.year}` : ""} · ${e.title}`], empty: "No match" });
  if (entry) editor.insertInline("cite", `[@${entry.key}]`);
}

async function insertCrossref() {
  const items = labels(editor.markdown());
  if (!items.length) { toast("No labels yet: give a figure, equation, table or section an id like {#fig-name}"); return; }
  const item = await pick({ title: "Insert cross-reference", items, describe: (l) => [`@${l.label}`, { fig: "Figure", tbl: "Table", eq: "Equation", sec: "Section" }[l.kind] ?? l.kind], empty: "No match" });
  if (item) editor.insertInline("crossref", `@${item.label}`);
}

async function editChip(attrs) {
  const names = { cite: "Citation", crossref: "Cross-reference", attr: "Attributes", shortcode: "Shortcode", math: "Inline math", span: "Span", raw: "Source" };
  return ask({ title: `Edit ${(names[attrs.kind] ?? "source").toLowerCase()}`, message: "Exactly as it appears in the file", value: attrs.source, ok: "Apply" });
}

// ------------------------------------------------------------- outline --

let outlineTimer = null;
function scheduleOutline() { clearTimeout(outlineTimer); outlineTimer = setTimeout(renderOutline, 400); }
function renderOutline() {
  ui.outline.hidden = !outlineOpen || !editor || !doc.path;
  if (ui.outline.hidden) return;
  const items = editor.outline();
  const { heading } = editor.where();
  ui.outline.replaceChildren(h("h2", {}, "Outline"), ...(items.length ? items.map((item) => h(`button${heading && item.text === heading ? ".current" : ""}`, { type: "button", dataset: { level: item.level }, title: item.text, onclick: () => editor.reveal(item.pos) }, item.text || "(untitled)")) : [h("p", { style: { color: "var(--mw-text-3)", padding: "0 8px", fontSize: "13px" } }, "No headings yet")]));
}

function updateWhere() {
  if (!editor || !doc.path) return;
  const { heading, selection } = editor.where();
  const count = selection ? selection.split(/\s+/).filter((w) => /\w/.test(w)).length : 0;
  ui.where.textContent = count ? `${count} word${count === 1 ? "" : "s"} selected` : heading ? `In “${heading}”` : "";
  const words = editor.view.state.doc.textContent.split(/\s+/).filter(Boolean).length;
  ui.words.textContent = `${words.toLocaleString()} words`;
}

// ------------------------------------------------------------- grammar --

async function toggleGrammar() {
  grammarOn = !grammarOn;
  renderActions();
  if (grammarOn) scheduleGrammar(50);
  else { editor?.setGrammar([]); ui.grammarCount.textContent = ""; }
}

function scheduleGrammar(delay = GRAMMAR_DELAY) {
  if (!grammarOn) return;
  clearTimeout(grammarTimer);
  grammarTimer = setTimeout(() => void checkGrammar(), delay);
}

async function checkGrammar() {
  if (!editor || !grammarOn) return;
  const blocks = editor.textBlocks();
  const todo = blocks.filter((b) => !grammarCache.has(b.text));
  // Check new text in batches of whole paragraphs, joined by blank lines.
  for (let i = 0; i < todo.length;) {
    const batch = [];
    let size = 0;
    while (i < todo.length && size + todo[i].text.length < 15_000) { batch.push(todo[i]); size += todo[i].text.length + 2; i++; }
    if (!batch.length) { batch.push(todo[i]); i++; }
    const text = batch.map((b) => b.text).join("\n\n");
    let result;
    try { result = await host("/v1/writer/grammar", { method: "POST", body: JSON.stringify({ text, language: "en-US" }) }); }
    catch (error) { toast(error.message, { ms: 6000 }); grammarOn = false; renderActions(); return; }
    let offset = 0;
    for (const block of batch) {
      const end = offset + block.text.length;
      grammarCache.set(block.text, result.matches.filter((m) => m.offset >= offset && m.offset + m.length <= end).map((m) => ({ ...m, offset: m.offset - offset })));
      offset = end + 2;
    }
  }
  if (!grammarOn) return;
  const fresh = editor.textBlocks();
  const issues = [];
  let id = 0;
  for (const block of fresh) {
    for (const match of grammarCache.get(block.text) ?? []) {
      const from = block.map[match.offset];
      const last = block.map[match.offset + match.length - 1];
      if (from === undefined || last === undefined) continue;
      issues.push({ id: id++, from, to: last + 1, match });
    }
  }
  editor.setGrammar(issues);
  ui.grammarCount.textContent = issues.length ? `${issues.length} suggestion${issues.length === 1 ? "" : "s"}` : "No suggestions";
}

function onGrammarClick(event) {
  const target = event.target.closest?.(".gram");
  if (!target || !editor) return;
  const pos = editor.view.posAtDOM(target, 0);
  const [issue] = editor.grammarAt(pos);
  if (!issue) return;
  const { match } = issue;
  const word = editor.view.state.doc.textBetween(issue.from, issue.to);
  contextMenu(event, [
    ...match.replacements.slice(0, 5).map((r) => ({ label: r || "(remove)", icon: "check_small", run: () => { editor.replaceRange(issue.from, issue.to, r); scheduleGrammar(300); } })),
    ...(match.replacements.length ? ["-"] : []),
    ...(match.spelling ? [{ label: `Add “${word}” to dictionary`, icon: "dictionary", run: async () => { await host("/v1/writer/words", { method: "POST", body: JSON.stringify({ add: [word] }) }).catch((e) => toast(e.message)); grammarCache.clear(); scheduleGrammar(50); } }] : []),
    { label: "Ignore", icon: "visibility_off", run: () => { const list = grammarCache.get(textOfBlockAt(issue.from)); if (list) { const k = list.indexOf(match); if (k >= 0) list.splice(k, 1); } scheduleGrammar(10); } },
  ]);
  const menu = document.querySelector(".menu");
  menu?.classList.add("gram-pop");
  menu?.prepend(h("div.gram-msg", {}, match.message));
}
function textOfBlockAt(pos) { return editor.textBlocks().find((b) => b.map[0] <= pos && b.map.at(-1) >= pos)?.text; }

// ------------------------------------------------------ agent review --
//
// Select text → right click → "Review with agent". The passage gets a frame
// whose colour says how it fared (green: sound, amber: minor, red: needs work);
// comments are wavy underlines by kind. Hover an underline for the comment,
// accept its suggestion or take it to the chat; hover the frame's tab for the
// overall judgement. Esc clears every review.

const KIND = {
  error: { label: "Mistake", hint: "plainly wrong" },
  correction: { label: "Correction needed", hint: "must change to be correct" },
  style: { label: "Could be said better", hint: "clearer or shorter" },
  sense: { label: "Doesn't hold up", hint: "logic, facts or sense" },
};
const VERDICT = {
  pending: { label: "Reviewing…", icon: null },
  good: { label: "Looks good", icon: "check" },
  minor: { label: "Minor suggestions", icon: "rate_review" },
  "needs-work": { label: "Needs work", icon: "priority_high" },
  error: { label: "Review failed", icon: "error" },
};

const layer = h("div.rv-layer");
ui.page.append(layer);
const card = h("div.rv-card", { hidden: true, onmouseenter: () => clearTimeout(cardTimer), onmouseleave: () => hideCardSoon() });
document.body.append(card);
let cardTimer = null;
let cardFor = null;
let framesQueued = false;

async function reviewSelection() {
  if (!editor || !doc.path) return;
  const request = editor.startReview();
  if (!request) { toast("Select some text first"); return; }
  window.getSelection()?.removeAllRanges();
  drawFrames();
  try {
    const result = await host("/v1/writer/review", { method: "POST", body: JSON.stringify({ text: request.text, before: request.before, after: request.after, heading: request.heading, path: doc.path }) });
    const kept = editor.finishReview(request.id, result);
    if (kept === null) return; // cleared meanwhile
  } catch (error) {
    editor.failReview(request.id, error.message);
  }
  drawFrames();
  if (cardFor?.region === request.id) showRegionCard(request.id);
}

function drawFrames() {
  if (framesQueued) return;
  framesQueued = true;
  requestAnimationFrame(() => {
    framesQueued = false;
    layer.replaceChildren();
    if (!editor) return;
    const { regions, comments } = editor.reviews();
    const base = ui.page.getBoundingClientRect();
    for (const region of regions) {
      const rects = editor.rangeRects(region.from, region.to);
      if (!rects.length) continue;
      const pad = 6;
      const left = Math.min(...rects.map((r) => r.left)) - base.left - pad;
      const top = Math.min(...rects.map((r) => r.top)) - base.top - pad;
      const right = Math.max(...rects.map((r) => r.right)) - base.left + pad;
      const bottom = Math.max(...rects.map((r) => r.bottom)) - base.top + pad;
      const count = comments.filter((c) => c.region === region.id).length;
      const verdict = VERDICT[region.state] ?? VERDICT.pending;
      const tab = h(`button.rv-tab.rv-${region.state}`, {
        type: "button", "aria-label": verdict.label,
        onmouseenter: () => showRegionCard(region.id),
        onmouseleave: () => hideCardSoon(),
        onclick: () => showRegionCard(region.id, { pin: true }),
      }, region.state === "pending" ? h("span.rv-spin") : icon(verdict.icon, { size: 15 }), h("span", {}, region.state === "pending" ? verdict.label : count ? `${count} comment${count === 1 ? "" : "s"}` : verdict.label));
      const frame = h(`div.rv-frame.rv-${region.state}`, { style: { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` } });
      // The frame's edge reacts to the pointer; its inside stays clickable text.
      for (const side of ["top", "right", "bottom", "left"]) frame.append(h(`div.rv-edge.rv-edge-${side}`, { onmouseenter: () => showRegionCard(region.id), onmouseleave: () => hideCardSoon() }));
      tab.style.left = `${right}px`;
      tab.style.top = `${top}px`;
      layer.append(frame, tab);
    }
  });
}

function placeCard(anchor) {
  card.hidden = false;
  const box = card.getBoundingClientRect();
  let left = Math.min(Math.max(8, anchor.left), innerWidth - box.width - 8);
  let top = anchor.bottom + 8;
  if (top + box.height > innerHeight - 8) top = Math.max(8, anchor.top - box.height - 8);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}
function hideCardSoon() { clearTimeout(cardTimer); cardTimer = setTimeout(hideCard, 260); }
function hideCard() { card.hidden = true; cardFor = null; }

function showCommentCard(id, anchorEl) {
  const comment = editor.reviews().comments.find((c) => c.id === id);
  if (!comment) return;
  clearTimeout(cardTimer);
  cardFor = { comment: id };
  const kind = KIND[comment.kind];
  card.className = `rv-card rv-card-${comment.kind}`;
  card.replaceChildren(
    h("div.rv-card-head", {}, h(`span.rv-dot.rv-${comment.kind}`), h("strong", {}, kind.label), h("span.rv-hint", {}, kind.hint)),
    h("p.rv-comment", {}, comment.comment),
    comment.replacement !== undefined ? h("div.rv-suggest", {}, h("del", {}, comment.quote), h("span.rv-arrow", {}, "→"), h("ins", {}, comment.replacement || "(remove)")) : null,
    h("div.rv-actions", {},
      comment.replacement !== undefined ? h("button.btn.primary.rv-btn", { type: "button", onclick: () => { editor.acceptComment(id); hideCard(); drawFrames(); } }, icon("check", { size: 16 }), "Accept") : null,
      h("button.btn.rv-btn", { type: "button", onclick: () => { discussComment(comment); hideCard(); } }, icon("forum", { size: 16 }), "Discuss in chat"),
      h("span.spacer"),
      h("button.icon-btn.small", { type: "button", title: "Dismiss this comment", onclick: () => { editor.dismissComment(id); hideCard(); drawFrames(); } }, icon("close")),
    ),
  );
  placeCard(anchorEl.getBoundingClientRect());
}

function showRegionCard(id, { pin = false } = {}) {
  const region = editor.reviews().regions.find((r) => r.id === id);
  if (!region) return;
  clearTimeout(cardTimer);
  cardFor = { region: id };
  const comments = editor.reviews().comments.filter((c) => c.region === id);
  const verdict = VERDICT[region.state] ?? VERDICT.pending;
  const counts = Object.keys(KIND).map((k) => [k, comments.filter((c) => c.kind === k).length]).filter(([, n]) => n);
  card.className = `rv-card rv-card-region rv-card-${region.state}`;
  card.replaceChildren(
    h("div.rv-card-head", {}, h(`span.rv-badge.rv-${region.state}`, {}, region.state === "pending" ? h("span.rv-spin") : icon(verdict.icon, { size: 15 }), verdict.label), h("span.spacer"), ...counts.map(([k, n]) => h("span.rv-count", { title: KIND[k].label }, h(`span.rv-dot.rv-${k}`), String(n)))),
    region.summary ? h("p.rv-comment", {}, region.summary) : h("p.rv-comment.rv-muted", {}, region.state === "pending" ? "The agent is reading this passage…" : ""),
    h("div.rv-actions", {},
      h("button.btn.rv-btn", { type: "button", onclick: () => { discussRegion(region, comments); hideCard(); } }, icon("forum", { size: 16 }), "Discuss in chat"),
      region.state !== "pending" ? h("button.btn.ghost.rv-btn", { type: "button", onclick: () => { reReview(region); hideCard(); } }, icon("refresh", { size: 16 }), "Review again") : null,
      h("span.spacer"),
      h("button.icon-btn.small", { type: "button", title: "Clear this review", onclick: () => { editor.removeRegion(id); hideCard(); drawFrames(); } }, icon("close")),
    ),
  );
  const tab = [...layer.querySelectorAll(".rv-tab")].find((el, k) => editor.reviews().regions[k]?.id === id) ?? layer;
  placeCard(tab.getBoundingClientRect());
  if (pin) clearTimeout(cardTimer);
}

function reReview(region) {
  editor.removeRegion(region.id);
  if (editor.selectRange(region.from, region.to)) void reviewSelection();
}

const where = () => `${nameOf(doc.path)}${editor.where().heading ? `, “${editor.where().heading}”` : ""}`;
const quoteBlock = (text) => text.split("\n").map((line) => `> ${line}`).join("\n");

function discussComment(comment) {
  const region = editor.reviews().regions.find((r) => r.id === comment.region);
  const text = `About this passage in ${nameOf(doc.path)}${region?.heading ? ` (“${region.heading}”)` : ""}:\n\n${quoteBlock(region?.text ?? comment.quote)}\n\nThe review flagged “${comment.quote}” (${KIND[comment.kind].label.toLowerCase()}): ${comment.comment}${comment.replacement !== undefined ? `\nSuggested: “${comment.replacement}”` : ""}\n\n`;
  void background("chat-draft", { text });
}

function discussRegion(region, comments) {
  const lines = comments.map((c) => `- “${c.quote}” — ${KIND[c.kind].label.toLowerCase()}: ${c.comment}${c.replacement !== undefined ? ` (suggested: “${c.replacement}”)` : ""}`);
  const text = `Let's discuss this passage from ${nameOf(doc.path)}${region.heading ? ` (“${region.heading}”)` : ""}:\n\n${quoteBlock(region.text)}\n\n${region.summary ? `Review: ${region.summary}\n` : ""}${lines.length ? `${lines.join("\n")}\n` : ""}\n`;
  void background("chat-draft", { text });
}

function discussSelection() {
  const { selection, heading } = editor.where();
  if (!selection) return;
  void background("chat-draft", { text: `About this passage in ${nameOf(doc.path)}${heading ? ` (“${heading}”)` : ""}:\n\n${quoteBlock(selection)}\n\n` });
}

ui.editorRoot.addEventListener("mouseover", (event) => {
  const mark = event.target.closest?.(".rv[data-rv]");
  if (mark) showCommentCard(Number(mark.dataset.rv), mark);
});
ui.editorRoot.addEventListener("mouseout", (event) => {
  if (event.target.closest?.(".rv[data-rv]") && !event.relatedTarget?.closest?.(".rv[data-rv]")) hideCardSoon();
});
ui.editorRoot.addEventListener("contextmenu", (event) => {
  if (!editor || !doc.path || doc.status === "readonly") return;
  const { selection } = editor.where();
  if (!selection) return;
  contextMenu(event, [
    { label: "Review with agent", icon: "rate_review", run: () => void reviewSelection() },
    { label: "Discuss in chat", icon: "forum", run: discussSelection },
    "-",
    { label: "Copy", icon: "content_copy", run: () => navigator.clipboard.writeText(selection) },
    { label: "Cut", icon: "content_cut", run: async () => { await navigator.clipboard.writeText(selection); editor.view.dispatch(editor.view.state.tr.deleteSelection()); } },
  ]);
});
addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "r") { event.preventDefault(); void reviewSelection(); return; }
  if (event.key !== "Escape" || !editor) return;
  if (document.querySelector(".dialog-backdrop, .menu")) return;
  if (!editor.reviews().regions.length) return;
  event.preventDefault();
  editor.clearReviews();
  hideCard();
  drawFrames();
}, true);
addEventListener("resize", drawFrames);

// -------------------------------------------------------------- render --

async function render() {
  if (!doc.path) return { ok: false, error: "No document is open" };
  // Quarto renders the file on disk: save first.
  if (doc.dirty || saving) { const result = await save(); if (!result.saved) return { ok: false, error: "The document could not be saved" }; }
  setStatus("rendering");
  ui.render.disabled = true;
  try {
    const result = await host("/v1/writer/render", { method: "POST", body: JSON.stringify({ path: doc.path, to: "pdf" }) });
    setStatus("saved");
    if (result.ok) {
      toast(`Rendered in ${result.seconds.toFixed(0)} s`);
      await background("open-file", { path: result.output });
    } else showRenderError(result);
    return { ok: result.ok, output: result.output, errors: result.errors, seconds: result.seconds, log: result.ok ? undefined : result.log.slice(-3000) };
  } catch (error) {
    setStatus("error", error.message);
    toast(error.message);
    return { ok: false, error: error.message };
  } finally { ui.render.disabled = false; }
}

function showRenderError(result) {
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog", { style: { width: "min(860px, calc(100vw - 32px))" } }, h("h2", {}, "Rendering failed"),
      result.errors.length ? h("p", {}, ...result.errors.map((e) => h("div", { style: { font: "12.5px var(--mw-font-mono)", color: "var(--mw-danger)" } }, e))) : null,
      h("pre", { style: { maxHeight: "50vh", overflow: "auto", font: "12px/1.45 var(--mw-font-mono)", background: "var(--mw-surface-2)", padding: "10px", borderRadius: "8px", whiteSpace: "pre-wrap" } }, result.log.slice(-8000)),
      h("div.actions", {}, h("button.btn", { type: "button", onclick: () => { void background("chat-draft", { text: `Rendering ${nameOf(doc.path)} failed:\n\n${result.errors.join("\n") || result.log.slice(-1500)}\n\nCan you fix it?` }); backdrop.remove(); } }, "Ask the agent"), h("button.btn.primary", { type: "button", onclick: () => backdrop.remove() }, "Close"))));
  document.body.append(backdrop);
}
ui.render.addEventListener("click", () => void render());

// ---------------------------------------------------------- start page --

async function showStart() {
  ui.start.hidden = false;
  ui.page.hidden = true;
  ui.toolbar.hidden = true;
  ui.statusbar.hidden = true;
  ui.render.hidden = true;
  ui.outline.hidden = true;
  ui.title.textContent = "Writer";
  ui.subtitle.textContent = "";
  document.title = "Writer";
  hideBar();
  setStatus("idle", "", EMPTY);
  ui.state.hidden = true;
  renderActions();
  const list = await recent();
  ui.start.replaceChildren(
    h("h2", {}, "Write a paper"),
    h("p", {}, "Quarto and Markdown documents, with math, figures, citations and cross-references. Open a .qmd or .md file from the Files panel, or start one here."),
    h("div.buttons", {}, h("button.btn.primary", { type: "button", onclick: newDocument }, icon("note_add", { size: 18 }), "New document"), h("button.btn", { type: "button", onclick: openDialog }, icon("folder_open", { size: 18 }), "Open…")),
    ...(list.length ? [h("h3", {}, "Recent"), h("div.recent", {}, ...list.map((path) => h("button", { type: "button", onclick: () => open(path) }, icon("writer"), h("div", { style: { minWidth: 0 } }, h("div.name", {}, nameOf(path)), h("div.path", {}, dirOf(path).replace(/^\/home\/[^/]+/, "~"))))))] : []),
  );
  return { opened: null };
}

async function openDialog() {
  const path = await ask({ title: "Open a document", message: "Path of a .qmd or .md file", value: doc.path ? `${dirOf(doc.path)}/` : "~/", ok: "Open" });
  if (path) await open(path);
}

async function newDocument() {
  const path = await ask({ title: "New document", message: "Where to create it", value: doc.path ? `${dirOf(doc.path)}/untitled.qmd` : "~/Documents/untitled.qmd", ok: "Create" });
  if (!path) return;
  const file = /\.[a-z0-9]+$/i.test(path) ? path : `${path}.qmd`;
  const title = nameOf(file).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  const text = /\.qmd$/i.test(file) ? `---\ntitle: "${title.replace(/"/g, "'")}"\nformat: pdf\n---\n\n` : `# ${title}\n\n`;
  try { await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: file, text, expect: "absent", createDirs: true }) }); }
  catch (error) { toast(error.status === 409 ? "That file already exists" : error.message); return; }
  await open(file);
}

// --------------------------------------------------------- keyboard --

addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") { event.preventDefault(); void tabs.save(); }
});
// Unsaved changes are kept as drafts (not saved behind the user's back); write them now when the page goes.
addEventListener("pagehide", () => { for (const tab of tabs.tabs) if (tab.dirty) void tabs.writeDraft(tab); });
// Coming here straight from the File viewer brings its document along.
async function takeHandoff() {
  const handoff = await background("viewer-handoff", { editor: "writer" }).catch(() => null);
  if (handoff?.path) await open(handoff.path);
  return Boolean(handoff?.path);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void takeHandoff(); });

// ------------------------------------------------------------- agent API --

function blockAfterHeading(text) {
  const item = editor.outline().find((o) => o.text.toLowerCase() === String(text).toLowerCase()) ?? editor.outline().find((o) => o.text.toLowerCase().includes(String(text).toLowerCase()));
  return item?.pos ?? null;
}

registerPage("writer", {
  state: () => doc.path ? {
    path: doc.path,
    status: doc.status,
    unsavedChanges: Boolean(doc.dirty),
    tabs: tabs.tabs.map((t) => ({ path: t.path, modified: t.dirty, active: t === doc })),
    cursor: editor?.where(),
    outline: editor?.outline().map((o) => `${"#".repeat(o.level || 0) || "-"} ${o.text}`),
    words: editor?.view.state.doc.textContent.split(/\s+/).filter(Boolean).length,
    grammar: grammarOn,
  } : { path: null },
  commands: {
    open: ({ query, path }) => open(path ?? query),
    save: () => save(),
    close: async ({ path }) => {
      const tab = path ? tabs.tabs.find((t) => t.path === path) : doc;
      if (!tab?.path) throw new Error("No such document is open");
      return { closed: await tabs.close(tab) };
    },
    render: () => render(),
    insert: async ({ markdown, at = "cursor" }) => {
      if (!doc.path) throw new Error("No document is open");
      if (doc.status === "readonly") throw new Error("The document is open read-only");
      let where = at;
      if (at !== "cursor" && at !== "end") { where = blockAfterHeading(at); if (where === null) throw new Error(`No heading “${at}”`); }
      const wasClean = !doc.dirty;
      const count = editor.insertMarkdown(markdown, where);
      // The agent's edit is saved when the document had no unsaved changes of the user's; otherwise it
      // joins them, unsaved, for the user to save (or not).
      const saved = wasClean ? (await save()).saved : false;
      return { inserted: count, at, saved, ...(wasClean ? {} : { note: "The user has unsaved changes in this document; the insertion is unsaved too." }) };
    },
    "replace-selection": async ({ markdown }) => {
      if (!doc.path || doc.status === "readonly") throw new Error("No editable document is open");
      if (!editor.where().selection) throw new Error("Nothing is selected");
      const wasClean = !doc.dirty;
      editor.replaceSelection(markdown);
      const saved = wasClean ? (await save()).saved : false;
      return { replaced: true, saved };
    },
    reveal: ({ heading, text }) => {
      if (!doc.path) throw new Error("No document is open");
      const pos = heading ? blockAfterHeading(heading) : editor.find(text);
      if (pos === null || pos === undefined) throw new Error("Not found");
      editor.reveal(pos);
      return { revealed: true };
    },
    select: ({ text }) => { if (!editor?.selectText(String(text ?? ""))) throw new Error("Text not found in the document"); return { selected: text }; },
    review: async ({ text }) => {
      if (text && !editor?.selectText(String(text))) throw new Error("Text not found in the document");
      await reviewSelection();
      const { regions, comments } = editor.reviews();
      const region = regions.at(-1);
      return region ? { verdict: region.state, summary: region.summary, comments: comments.filter((c) => c.region === region.id).map((c) => ({ kind: c.kind, quote: c.quote, comment: c.comment, replacement: c.replacement })) } : null;
    },
    /** Point the user at a comment: scroll to it and open its card. */
    "show-comment": ({ index = 0 }) => {
      const comment = editor?.reviews().comments.sort((a, b) => a.from - b.from)[index];
      if (!comment) throw new Error("No such comment");
      const mark = ui.editorRoot.querySelector(`.rv[data-rv="${comment.id}"]`);
      mark?.scrollIntoView({ block: "center" });
      if (mark) showCommentCard(comment.id, mark);
      clearTimeout(cardTimer);
      return { shown: comment.quote };
    },
    "clear-reviews": () => { editor?.clearReviews(); hideCard(); drawFrames(); return { cleared: true }; },
    grammar: async ({ on }) => { if (Boolean(on) !== grammarOn) await toggleGrammar(); return { grammar: grammarOn }; },
  },
});

// ---------------------------------------------------------------- start --

$("#doc-icon").append(icon("writer"));
// The tabs of the last session come back (with their unsaved changes); before tabs, the last document.
const restored = await tabs.restore();
if (!(await takeHandoff()) && !restored) {
  const { "writer.last": last } = await browser.storage.local.get("writer.last").catch(() => ({}));
  if (last) await open(last).catch(() => showStart()); else await showStart();
}
