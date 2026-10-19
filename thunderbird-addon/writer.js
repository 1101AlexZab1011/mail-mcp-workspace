// Writer space: a word-processor-like editor for Quarto (.qmd) and Markdown.
//
// The file on disk is the source of truth. The editor (vendor/writer, see
// src/writer/editor.mjs) writes untouched blocks back byte for byte; this page
// saves with a lost-update guard, merges outside edits (the agent's, another
// editor's) line by line, and reloads live when the file changes on disk.
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, contextMenu, background, toast, registerPage, ask } from "./shared/page.js";
import { createWriter, merge3, labels } from "./vendor/writer/writer.mjs";

const SAVE_DELAY = 1000;
const GRAMMAR_DELAY = 1800;
const BACKUPS = "~/.local/state/mail-workspace/writer-backups";

const ui = {
  title: $("#title"), subtitle: $("#subtitle"), state: $("#state"), actions: $("#actions"), render: $("#render"),
  toolbar: $("#toolbar"), conflict: $("#conflict"), outline: $("#outline"), scroll: $("#scroll"), start: $("#start"),
  page: $("#page"), editorRoot: $("#editor"), statusbar: $("#statusbar"), where: $("#where"), words: $("#words"),
  grammarCount: $("#grammar-count"), imageInput: $("#image-input"),
};

const doc = {
  path: null,      // absolute path of the open document
  hash: null,      // version on disk we last read or wrote (sent as `expect`)
  base: null,      // text of that version
  status: "idle",  // idle | saved | unsaved | saving | conflict | readonly | error
  backedUp: new Set(),
  bibliography: new Map(),
};
let editor = null;
let saveTimer = null;
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

function setStatus(status, detail = "") {
  doc.status = status;
  const label = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", conflict: "Changed on disk", readonly: "Read-only", error: "Not saved", rendering: "Rendering…" }[status];
  ui.state.hidden = !label;
  ui.state.textContent = label ?? "";
  ui.state.className = `chip ${status === "saved" ? "saved" : status === "unsaved" || status === "saving" ? "unsaved" : status === "rendering" ? "" : "warning"}`;
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

async function ensureEditor() {
  if (editor) return editor;
  editor = await createWriter(ui.editorRoot, {
    onChange: () => {
      if (!doc.path || doc.status === "readonly") return;
      if (editor.markdown() === doc.base) { if (doc.status === "unsaved") setStatus("saved"); return; }
      setStatus("unsaved");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void save(), SAVE_DELAY);
      scheduleOutline();
      scheduleGrammar();
      drawFrames();
    },
    onSelection: () => updateWhere(),
    resolveImage,
    editInline: editChip,
    describeInline: (attrs, el) => {
      if (attrs.kind !== "cite") return;
      const keys = [...attrs.source.matchAll(/@([\w:.#$%&\-+?<>~/]+\w)/g)].map((m) => m[1]);
      const known = keys.map((k) => doc.bibliography.get(k));
      if (doc.bibliography.size && known.some((e) => !e)) el.classList.add("unknown");
      el.title = known.map((e, i) => e ? `${e.author.split(" and ")[0]}${e.year ? ` (${e.year})` : ""}: ${e.title}` : `${keys[i]}: not in the bibliography`).join("\n") || el.title;
    },
  });
  ui.editorRoot.addEventListener("paste", onPasteImages, true);
  ui.editorRoot.addEventListener("drop", onDropImages, true);
  ui.editorRoot.addEventListener("click", onGrammarClick);
  return editor;
}

async function resolveImage(src) {
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (!doc.path) return null;
  const full = src.startsWith("/") ? src : `${dirOf(doc.path)}/${src.replace(/^\.\//, "")}`;
  if (imageUrls.has(full)) return imageUrls.get(full);
  const link = await host("/v1/links", { method: "POST", body: JSON.stringify({ path: full }) }).catch(() => null);
  const url = link ? `${HOST_ENDPOINT}${link.url}` : null;
  if (url) imageUrls.set(full, url);
  return url;
}

// ---------------------------------------------------------------- open --

async function open(path) {
  if (!path) return showStart();
  if (doc.path && doc.status === "unsaved") await save();
  const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch((error) => { toast(error.message); return null; });
  if (!info || info.directory) return showStart();
  if (!isDocument(info.path)) { await background("open-file", { path: info.path }); return { opened: "viewer", path: info.path }; }
  const file = await host(`/v1/fs/read?path=${encodeURIComponent(info.path)}`);
  if (file.truncated) { toast("This document is too large for the Writer"); return showStart(); }
  await ensureEditor();
  Object.assign(doc, { path: info.path, hash: file.hash, base: file.text });
  imageUrls.clear();
  grammarCache.clear();
  const result = editor.load(file.text);
  drawFrames();
  ui.start.hidden = true;
  ui.page.hidden = false;
  ui.toolbar.hidden = false;
  ui.statusbar.hidden = false;
  ui.render.hidden = false;
  ui.title.textContent = nameOf(info.path);
  ui.subtitle.textContent = dirOf(info.path).replace(/^\/home\/[^/]+/, "~");
  document.title = `${nameOf(info.path)} · Writer`;
  ui.page.classList.toggle("readonly", !result.safe);
  editor.view.setProps({ editable: () => result.safe });
  if (!result.safe) {
    setStatus("readonly", "This file has syntax the Writer cannot round-trip; editing is disabled so nothing is lost.");
    showBar("This document cannot be edited safely here: saving would change text you did not edit. It is open read-only.", [["Open in viewer", () => background("open-file", { path: doc.path })]], true);
    console.warn("writer: unsafe round trip", result.mismatchAt);
  } else {
    setStatus("saved");
    hideBar();
  }
  ui.scroll.scrollTop = 0;
  renderToolbar();
  renderActions();
  renderOutline();
  updateWhere();
  await remember(info.path);
  void loadBibliography();
  void watch();
  if (grammarOn) scheduleGrammar(200);
  return { opened: "writer", path: info.path, safe: result.safe, blocks: result.blocks };
}

async function loadBibliography() {
  doc.bibliography = new Map();
  if (!doc.path) return;
  const bib = await host(`/v1/writer/bibliography?path=${encodeURIComponent(doc.path)}`).catch(() => null);
  for (const entry of bib?.entries ?? []) doc.bibliography.set(entry.key, entry);
}

// ---------------------------------------------------------------- save --

/** Save now. Refuses while read-only; merges if the file changed on disk. */
async function save({ force = false } = {}) {
  clearTimeout(saveTimer);
  if (!doc.path || !editor || doc.status === "readonly") return { saved: false };
  if (saving) { await saving; }
  const text = editor.markdown();
  if (text === doc.base && !force) { setStatus("saved"); return { saved: true, unchanged: true }; }
  saving = (async () => {
    setStatus("saving");
    try {
      await backup();
      const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: doc.path, text, expect: doc.hash }) });
      doc.hash = result.hash;
      doc.base = text;
      setStatus(editor.markdown() === text ? "saved" : "unsaved");
      return { saved: true };
    } catch (error) {
      if (error.status === 409) return reconcile(error.details?.current);
      setStatus("error", error.message);
      toast(`Not saved: ${error.message}`);
      return { saved: false, error: error.message };
    }
  })();
  try { return await saving; } finally { saving = null; }
}

/** First save of a session: keep a copy of the file as it was on disk. */
async function backup() {
  if (doc.backedUp.has(doc.path)) return;
  doc.backedUp.add(doc.path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: `${BACKUPS}/${nameOf(doc.path)}.${stamp}`, text: doc.base, createDirs: true }) }).catch(() => {});
}

/** The file changed under us: merge line by line, or ask the user. */
async function reconcile(current) {
  if (!current || current.absent) { setStatus("error", "The file was removed"); showBar("The file was moved or deleted on disk.", [["Save here again", () => { doc.hash = "absent"; return save({ force: true }); }]], true); return { saved: false }; }
  const theirs = current.text ?? (await host(`/v1/fs/read?path=${encodeURIComponent(doc.path)}`)).text;
  const mine = editor.markdown();
  const merged = merge3(doc.base, mine, theirs);
  if (merged.conflicts === 0) {
    reloadText(merged.text);
    doc.base = theirs;
    doc.hash = current.hash;
    if (merged.text !== theirs) return save();
    setStatus("saved");
    return { saved: true, merged: true };
  }
  setStatus("conflict");
  showBar("This document changed on disk while you edited the same lines.", [
    ["Show changes", () => showDiff(theirs, mine)],
    ["Reload from disk", () => { reloadText(theirs); doc.base = theirs; doc.hash = current.hash; hideBar(); setStatus("saved"); }],
    ["Keep mine", async () => { doc.hash = current.hash; doc.base = theirs; hideBar(); await save({ force: true }); }],
  ]);
  return { saved: false, conflict: true };
}

function reloadText(text) {
  const result = editor.load(text, { keep: true });
  drawFrames();
  if (!result.safe) { setStatus("readonly"); editor.view.setProps({ editable: () => false }); }
  renderOutline();
}

/** Live reload: wait for the file to change on disk, then fold the change in. */
async function watch() {
  const token = ++watchToken;
  const path = doc.path;
  while (token === watchToken && doc.path === path) {
    const since = doc.hash;
    const change = await host(`/v1/fs/watch?path=${encodeURIComponent(path)}&since=${since}&wait=25000`).catch(() => null);
    if (token !== watchToken || doc.path !== path) return;
    if (!change) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (change.hash === doc.hash || saving) continue;
    if (change.absent) { setStatus("error", "The file was removed"); continue; }
    const file = await host(`/v1/fs/read?path=${encodeURIComponent(path)}`).catch(() => null);
    if (!file || file.hash === doc.hash) continue;
    const mine = editor.markdown();
    if (mine === doc.base) {
      reloadText(file.text);
      doc.base = file.text;
      doc.hash = file.hash;
      setStatus("saved");
      flash("Updated from disk");
    } else {
      await reconcile({ ...file, text: file.text });
    }
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

// ------------------------------------------------- supervisor review --
//
// Select text → right click → "Review with supervisor". The passage gets a frame
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
    region.summary ? h("p.rv-comment", {}, region.summary) : h("p.rv-comment.rv-muted", {}, region.state === "pending" ? "Your supervisor is reading this passage…" : ""),
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
    { label: "Review with supervisor", icon: "rate_review", run: () => void reviewSelection() },
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
  if (doc.status === "unsaved" || saving) await save();
  setStatus("rendering");
  ui.render.disabled = true;
  try {
    const result = await host("/v1/writer/render", { method: "POST", body: JSON.stringify({ path: doc.path, to: "pdf" }) });
    setStatus(editor.markdown() === doc.base ? "saved" : "unsaved");
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
  setStatus("idle");
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
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
});
// Saving on hide (not beforeunload: a pending unload handler blocks add-on reloads).
addEventListener("pagehide", () => { if (doc.status === "unsaved") void save(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && doc.status === "unsaved") void save(); });

// ------------------------------------------------------------- agent API --

function blockAfterHeading(text) {
  const item = editor.outline().find((o) => o.text.toLowerCase() === String(text).toLowerCase()) ?? editor.outline().find((o) => o.text.toLowerCase().includes(String(text).toLowerCase()));
  return item?.pos ?? null;
}

registerPage("writer", {
  state: () => doc.path ? {
    path: doc.path,
    status: doc.status,
    unsavedChanges: editor ? editor.markdown() !== doc.base : false,
    cursor: editor?.where(),
    outline: editor?.outline().map((o) => `${"#".repeat(o.level || 0) || "-"} ${o.text}`),
    words: editor?.view.state.doc.textContent.split(/\s+/).filter(Boolean).length,
    grammar: grammarOn,
  } : { path: null },
  commands: {
    open: ({ query, path }) => open(path ?? query),
    save: () => save(),
    render: () => render(),
    insert: async ({ markdown, at = "cursor" }) => {
      if (!doc.path) throw new Error("No document is open");
      if (doc.status === "readonly") throw new Error("The document is open read-only");
      let where = at;
      if (at !== "cursor" && at !== "end") { where = blockAfterHeading(at); if (where === null) throw new Error(`No heading “${at}”`); }
      const count = editor.insertMarkdown(markdown, where);
      await save();
      return { inserted: count, at };
    },
    "replace-selection": async ({ markdown }) => {
      if (!doc.path || doc.status === "readonly") throw new Error("No editable document is open");
      if (!editor.where().selection) throw new Error("Nothing is selected");
      editor.replaceSelection(markdown);
      await save();
      return { replaced: true };
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
const { "writer.last": last } = await browser.storage.local.get("writer.last").catch(() => ({}));
if (last) await open(last).catch(() => showStart()); else await showStart();
