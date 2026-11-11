// Draw: a vector editor for posters, figures and diagrams, on plain SVG files (Inkscape's too).
//
// The file is the document. Each open file is loaded into a sandboxed frame of its own (no scripts
// run; same origin, so the editor reaches in): the frame's SVG document is what you see, what the
// tools change and what Ctrl+S writes back. Edits are small changes to that document (a move is a
// `transform`, a delete removes the element), so everything the editor does not know about (Inkscape
// layers and settings, filters, clones, clip paths, flowed text) is kept exactly as it was.
//
// On top of the frame lies the editor's own overlay: it takes the pointer, finds what is under it,
// and draws the selection and its handles. Undo records what each edit changed in the document
// (draw/history.js). Each tab keeps its frame, undo and view while another tab is shown.
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { dirOf, nameOf, tildePath } from "./shared/paths.js";
import { $, h, iconButton, background, toast, registerPage, ask, contextMenu } from "./shared/page.js";
import { DocTabs } from "./shared/doctabs.js";
import { History } from "./draw/history.js";
import * as g from "./draw/geometry.js";
import { indexSource, serializePreserving } from "./draw/serialize.js";
import { parsePath, serializePath, pointAt, splitSegment, removeNode, setSegmentCurved, makeSmooth, isSmooth, shapePath, GEOMETRY } from "./draw/path.js";

import {
  SVG_NS, XLINK_NS, XML_NS, INKSCAPE_NS, SODIPODI_NS, ensureNamespace, takenIds, appendIndented, createElement, setAttributes,
  copyWithFreshIds, declareNamespaces, removeTidy, freshenIds, setProperty, setsProperty, textLines, setTextLines, importSvg,
} from "./draw/content.js";
const BACKUPS = "@state/draw-backups";
const RECENT_KEY = "draw.recent";
const MAX_FILE = 50 * 1024 * 1024;
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 64;
const DRAG_START = 3; // pointer travel (px) before a press becomes a drag

const ui = {
  app: $("#app"), start: $("#start"), viewport: $("#viewport"), stage: $("#stage"), page: $("#page"),
  overlay: $("#overlay"), bar: $("#bar"), status: $("#status"), props: $("#props"),
};

const TOOLS = [
  { id: "select", icon: "arrow_selector_tool", label: "Select and transform", key: "s" },
  { id: "node", icon: "polyline", label: "Nodes: click a path, drag its nodes and handles; double-click a segment adds a node", key: "n" },
  "-",
  { id: "pen", icon: "draw", label: "Pen: click for corners, drag for curves; Enter or double-click ends, clicking the first node closes", key: "b" },
  { id: "rect", icon: "rectangle", label: "Rectangle (Ctrl: square)", key: "r" },
  { id: "ellipse", icon: "circle", label: "Ellipse (Ctrl: circle)", key: "e" },
  { id: "line", icon: "horizontal_rule", label: "Line (Ctrl: 15° steps)", key: "l" },
  { id: "text", icon: "title", label: "Text: click to write, click a text to edit it", key: "t" },
  "-",
  { id: "pan", icon: "pan_tool", label: "Hand: move the view (or hold Space)", key: "h" },
  { id: "zoom", icon: "zoom_in", label: "Zoom: click to zoom in, Shift+click out, drag an area", key: "z" },
];
const SHORTCUTS = [
  ["Click, Shift+click", "Select, add to the selection"],
  ["Ctrl+click", "Select inside groups"],
  ["Double-click a group", "Enter it; Esc or double-click outside leaves"],
  ["Drag on empty space", "Select everything inside the box"],
  ["Ctrl while dragging", "Move only horizontally or vertically; keep proportions when scaling"],
  ["Arrows (Shift: ×10)", "Move the selection"],
  ["Home / End, Page Up / Down", "To front / back, one step up / down"],
  ["R, E, L, T, B", "Rectangle, ellipse, line, text, pen"],
  ["N, double-click a path", "Edit its nodes: drag nodes and handles, double-click a segment to add a node, Delete removes nodes"],
  ["Pen: Enter, Backspace, Esc", "Finish the path, remove the last node, cancel"],
  ["Double-click a text", "Edit it (Ctrl+Enter or click away to finish, Esc to cancel)"],
  ["Ctrl+I, drop, paste", "Insert an image, SVG or PDF figure"],
  ["Ctrl+C / Ctrl+X / Ctrl+V", "Copy / cut / paste (in place)"],
  ["Ctrl+D, Delete", "Duplicate, delete"],
  ["Ctrl+G / Ctrl+Shift+G", "Group / ungroup"],
  ["Ctrl+K / Ctrl+Shift+K", "Combine / break apart (Inkscape)"],
  ["Ctrl+Shift+C, Ctrl+Alt+C, Ctrl+L", "Object to path, stroke to path, simplify (Inkscape)"],
  ["Ctrl+Shift+E", "Export to PDF or PNG"],
  ["Shift+Page Up / Down", "Move the selection to the layer above / below"],
  ["Ctrl+A, Esc", "Select all, deselect"],
  ["Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y", "Undo / redo"],
  ["5, Ctrl+0", "Fit the page"],
  ["1", "Zoom 1:1"],
  ["+ / −, Ctrl+wheel", "Zoom"],
  ["Wheel, Shift+wheel, Space+drag", "Scroll, scroll sideways, pan"],
  ["Ctrl+S, Ctrl+Shift+S", "Save, save as"],
];

// The active tab and its parts. A tab holds:
//   path, hash (of the file as last read or written: sent as `expect`), framing (what the serializer
//   cannot restore), frame (the iframe), doc (its SVG document), history, size ({w, h} of the page in
//   frame pixels), view ({scale, x, y}), selection (Set of elements), scope (the group being edited)
let tab = null;
let tool = "select";
let spaceDown = false;
let saving = null;
let watchToken = 0;

const root = () => tab?.doc.documentElement;
const selected = () => (tab ? [...tab.selection].filter((el) => el.isConnected) : []);

// ------------------------------------------------------------- the file --

const readFile = (path) => host(`/v1/fs/read?path=${encodeURIComponent(path)}&limit=${MAX_FILE}`);
const tilde = tildePath;

/** Load SVG text into a sandboxed frame; resolves with the frame once its document is up. */
async function loadFrame(text) {
  const frame = h("iframe.sheet", { sandbox: "allow-same-origin", scrolling: "no", tabindex: "-1", "aria-hidden": "true" });
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  frame.hidden = true;
  ui.page.append(frame);
  try {
    await new Promise((resolve, reject) => { frame.onload = resolve; frame.onerror = () => reject(new Error("The file could not be loaded")); frame.src = url; });
  } finally { URL.revokeObjectURL(url); }
  const rootEl = frame.contentDocument?.documentElement;
  if (rootEl?.namespaceURI !== SVG_NS || rootEl.localName !== "svg") {
    const reason = rootEl?.localName === "parsererror" ? rootEl.textContent.split("\n")[0] : "it is not an SVG drawing";
    frame.remove();
    throw new Error(`Cannot open this file: ${reason}`);
  }
  return frame;
}

/** The page's size in frame pixels: from width/height (any unit), else the viewBox, else what is drawn. */
function naturalSize(doc) {
  const el = doc.documentElement;
  const length = (name) => {
    const value = el.getAttribute(name);
    if (!value || value.trim().endsWith("%")) return null;
    try { return el[name].baseVal.value || null; } catch { return null; }
  };
  let w = length("width");
  let ht = length("height");
  const vb = el.viewBox?.baseVal;
  if (vb?.width && vb?.height) {
    if (w === null && ht === null) { w = vb.width; ht = vb.height; }
    else if (w === null) w = (ht * vb.width) / vb.height;
    else if (ht === null) ht = (w * vb.height) / vb.width;
  }
  if (!w || !ht) {
    const box = el.getBBox();
    w ||= Math.max(1, box.x + box.width);
    ht ||= Math.max(1, box.y + box.height);
  }
  return { w, h: ht };
}

/** The document's units, as Inkscape shows them: the unit of width/height when the viewBox matches it. */
function documentUnit(doc) {
  const el = doc.documentElement;
  const unit = /^[\d.]+\s*(mm|cm|in|pt|pc)$/.exec(el.getAttribute("width") ?? "")?.[1];
  const vb = el.viewBox?.baseVal;
  if (unit && vb?.width && Math.abs(parseFloat(el.getAttribute("width")) - vb.width) < 1e-6) return unit;
  return "px";
}

/** The document as file text: the file's own bytes wherever nothing changed (see draw/serialize.js). */
const serialize = (t) => (t.source ? serializePreserving(t.doc, t.source) : g.frame(new XMLSerializer().serializeToString(t.doc), t.framing));

async function makeTab(t, text) {
  const frame = await loadFrame(text);
  const doc = frame.contentDocument;
  Object.assign(t, {
    frame, doc, framing: g.framing(text), source: indexSource(text, doc), size: naturalSize(doc), unit: documentUnit(doc),
    view: null, selection: new Set(), scope: doc.documentElement,
  });
  t.style ??= defaultStyle(doc, t.size);
  t.history ??= new History((step) => onHistory(t, step));
  t.history.attach(doc);
}

// ----------------------------------------------------------------- tabs --

const tabs = new DocTabs({
  page: "draw",
  mount: $("#tabs"),
  icon: "shape_line",
  onEmpty: () => void showStart(),
  adapter: {
    async load(t, draft) {
      const file = await readFile(t.path);
      if (file.truncated) throw new Error("This drawing is too large to open (over 50 MB)");
      t.hash = file.hash;
      t.status = "saved";
      if (draft?.text && draft.text !== file.text) {
        // Unsaved changes from before a reload. If the file changed meanwhile, saving will say so.
        await makeTab(t, draft.text);
        t.hash = draft.baseHash ?? file.hash;
        t.history.savedAt = -1;
        t.dirty = true;
      } else await makeTab(t, file.text);
    },
    show(t) {
      tab = t;
      t.frame.hidden = false;
      ui.start.hidden = true;
      ui.app.hidden = false;
      layoutPage();
      if (t.view) applyView(); else fit();
      document.title = `${nameOf(t.path)} · Draw`;
      renderChrome();
      void remember(t.path);
      void watch(t);
    },
    hide(t) {
      if (editing) commitText();
      watchToken++;
      t.frame.hidden = true;
      if (tab === t) tab = null;
    },
    save: (t) => save(t),
    draft: (t) => ({ text: serialize(t), baseHash: t.hash }),
    dispose(t) { t.frame?.remove(); if (tab === t) tab = null; },
  },
});

function onHistory(t, step) {
  if (t !== tab) return;
  tabs.setDirty(t, t.history.modified);
  if (step) tabs.touch(t);
  renderHistory();
  drawOverlay();
  renderProps();
}

async function openFile(path) {
  if (!path) return showStart();
  const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch((error) => { toast(error.message); return null; });
  if (!info || info.directory) return tabs.tabs.length ? { opened: null } : showStart();
  if (!/\.svg$/i.test(info.path)) { toast("Draw opens SVG files"); return { opened: null }; }
  try { await tabs.open(info.path); }
  catch (error) { toast(error.message); return tabs.tabs.length ? { opened: null } : showStart(); }
  return { opened: "draw", path: info.path };
}

// ----------------------------------------------------------------- save --

async function save(t = tab, { as = false } = {}) {
  if (!t) return false;
  if (saving) await saving.catch(() => {});
  let path = t.path;
  if (as) {
    const chosen = await ask({ title: "Save drawing as", message: "An SVG file", value: path, ok: "Save" });
    if (!chosen) return false;
    path = /\.svg$/i.test(chosen) ? chosen : `${chosen}.svg`;
  }
  const task = (async () => {
    const text = serialize(t);
    try {
      if (path === t.path) await backup(t);
      const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path, text, expect: path === t.path ? t.hash : "absent", createDirs: true }) });
      // What was written is now the file the next save compares against.
      Object.assign(t, { path: result.path, hash: result.hash, status: "saved", framing: g.framing(text), source: indexSource(text, t.doc) });
      t.history.markSaved();
      if (t === tab) { document.title = `${nameOf(t.path)} · Draw`; hideBar(); setStatus(`Saved ${nameOf(t.path)}`); }
      void remember(t.path);
      return true;
    } catch (error) {
      if (error.status === 409 && path === t.path) { conflictBar(t); return false; }
      if (error.status === 409) { toast(`${nameOf(path)} already exists; choose another name`); return false; }
      toast(`Not saved: ${error.message}`);
      return false;
    }
  })();
  saving = task;
  try { return await task; } finally { if (saving === task) saving = null; }
}

/** The first save of a session keeps a copy of the file as it was. */
const backedUp = new Set();
async function backup(t) {
  if (backedUp.has(t.path)) return;
  const file = await readFile(t.path).catch(() => null);
  if (!file || file.hash !== t.hash) return;
  backedUp.add(t.path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: `${BACKUPS}/${nameOf(t.path)}.${stamp}`, text: file.text, createDirs: true }) }).catch(() => {});
}

/** Show the file as it is on disk now (its own undo history starts over). */
async function reloadFromDisk(t) {
  const file = await readFile(t.path);
  const view = t.view;
  const old = t.frame;
  await makeTab(t, file.text);
  old.remove();
  Object.assign(t, { hash: file.hash, status: "saved", view });
  tabs.setDirty(t, false);
  if (t === tab) { t.frame.hidden = false; layoutPage(); if (view) applyView(); else fit(); renderChrome(); }
}

function conflictBar(t) {
  t.status = "conflict";
  showBar("The file changed on disk since you opened it.", [
    ["Reload from disk", async () => { hideBar(); await reloadFromDisk(t); toast("Reloaded; your changes were discarded"); }],
    ["Keep mine", async () => { const file = await readFile(t.path).catch(() => null); t.hash = file?.hash ?? "absent"; hideBar(); await save(t); }],
  ]);
}

/** Live reload: a clean drawing follows its file; a modified one asks. */
async function watch(t) {
  const token = ++watchToken;
  while (token === watchToken && tab === t && tabs.tabs.includes(t)) {
    const change = await host(`/v1/fs/watch?path=${encodeURIComponent(t.path)}&since=${t.hash}&wait=25000`).catch(() => null);
    if (token !== watchToken || tab !== t) return;
    if (!change) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (change.hash === t.hash || saving) continue;
    if (change.absent) { setStatus("The file was moved or deleted"); continue; }
    if (!t.history.modified) { await reloadFromDisk(t); toast("Updated from disk", { ms: 1800 }); }
    else if (t.status !== "conflict") conflictBar(t);
  }
}

function showBar(message, actions) {
  ui.bar.replaceChildren(h("span", {}, message), h("span.spacer"), ...actions.map(([label, run]) => h("button.btn", { type: "button", onclick: run }, label)));
  ui.bar.hidden = false;
}
function hideBar() { ui.bar.hidden = true; }

// ------------------------------------------------------------ the view --

/** Size the page and frame to the drawing's natural size; the view transform does the rest. */
function layoutPage() {
  const { w, h: ht } = tab.size;
  for (const el of [ui.page, tab.frame]) { el.style.width = `${w}px`; el.style.height = `${ht}px`; }
  const color = tab.doc.querySelector("namedview")?.getAttribute("pagecolor");
  ui.page.style.background = color && color !== "none" ? color : "#ffffff";
}

function applyView() {
  const { scale, x, y } = tab.view;
  ui.stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  renderZoom();
  drawOverlay();
}

function fit() {
  if (!tab) return;
  const r = ui.viewport.getBoundingClientRect();
  const scale = Math.min((r.width - 48) / tab.size.w, (r.height - 48) / tab.size.h);
  tab.view = { scale, x: (r.width - tab.size.w * scale) / 2, y: (r.height - tab.size.h * scale) / 2 };
  applyView();
}

function zoomAt(factor, px, py) {
  const v = tab.view;
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
  const k = scale / v.scale;
  tab.view = { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
  applyView();
}
function zoomCenter(factor) { const r = ui.viewport.getBoundingClientRect(); zoomAt(factor, r.width / 2, r.height / 2); }
function zoomTo(scale) { if (tab) zoomCenter(scale / tab.view.scale); }
function zoomToBox(box) {
  const r = ui.viewport.getBoundingClientRect();
  const scale = Math.min(ZOOM_MAX, (r.width - 48) / Math.max(box.w, 1), (r.height - 48) / Math.max(box.h, 1));
  tab.view = { scale, x: r.width / 2 - (box.x + box.w / 2) * scale, y: r.height / 2 - (box.y + box.h / 2) * scale };
  applyView();
}

/** Viewport point (client coordinates) → frame pixels. */
function toFrame(clientX, clientY) {
  const r = ui.viewport.getBoundingClientRect();
  return [(clientX - r.left - tab.view.x) / tab.view.scale, (clientY - r.top - tab.view.y) / tab.view.scale];
}
/** Frame pixels → viewport pixels (the overlay's coordinates). */
const toView = (x, y) => [x * tab.view.scale + tab.view.x, y * tab.view.scale + tab.view.y];

ui.viewport.addEventListener("wheel", (event) => {
  if (!tab) return;
  event.preventDefault();
  const r = ui.viewport.getBoundingClientRect();
  if (event.ctrlKey || event.metaKey) { zoomAt(Math.exp(-event.deltaY * (event.deltaMode ? 0.05 : 0.002)), event.clientX - r.left, event.clientY - r.top); return; }
  const step = event.deltaMode ? 40 : 1;
  const [dx, dy] = event.shiftKey ? [event.deltaY * step, 0] : [event.deltaX * step, event.deltaY * step];
  tab.view = { ...tab.view, x: tab.view.x - dx, y: tab.view.y - dy };
  applyView();
}, { passive: false });
new ResizeObserver(() => { if (tab?.view) drawOverlay(); }).observe(ui.viewport);

// ----------------------------------------------------------- selecting --

const SKIP = "defs, clipPath, mask, marker, pattern, symbol, metadata, style, script, title, desc, linearGradient, radialGradient, filter";
const isLayer = (el) => el?.localName === "g" && el.getAttributeNS(INKSCAPE_NS, "groupmode") === "layer";
const isGroup = (el) => ["g", "a", "switch"].includes(el?.localName) && !isLayer(el);
/** Locked (sodipodi:insensitive) or hidden: the pointer passes through it, as in Inkscape. */
function locked(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    if (node.getAttributeNS(SODIPODI_NS, "insensitive") === "true") return true;
  }
  return false;
}
const label = (el) => el.getAttributeNS(INKSCAPE_NS, "label") || el.id || el.localName;

/** What a click on `node` selects: the object in the group being edited (or its layer) that holds it. */
function pickable(node, { deep = false } = {}) {
  const top = root();
  if (!node || node.nodeType !== 1 || node === top || node.closest(SKIP)) return null;
  let el = node;
  if (deep) {
    while (["tspan", "textPath"].includes(el.localName)) el = el.parentNode;
    return locked(el) ? null : el;
  }
  if (!tab.scope.contains(el) || tab.scope === el) tab.scope = top; // a click outside the group leaves it
  while (el.parentNode && el.parentNode !== tab.scope && !isLayer(el.parentNode)) el = el.parentNode;
  if (el === top || isLayer(el) || locked(el)) return null;
  return el;
}

function hitAt(clientX, clientY, options) {
  const [x, y] = toFrame(clientX, clientY);
  if (x < 0 || y < 0 || x > tab.size.w || y > tab.size.h) return null;
  return pickable(tab.doc.elementFromPoint(x, y), options);
}

/** The children of the group being edited (or of its layers) that can be selected. */
function selectableChildren() {
  const out = [];
  const walk = (parent) => {
    for (const el of parent.children) {
      if (el.matches(SKIP) || el.localName === "namedview" || locked(el)) continue;
      if (isLayer(el)) { if (el.getAttribute("style")?.includes("display:none") !== true) walk(el); continue; }
      out.push(el);
    }
  };
  walk(tab.scope);
  return out;
}

function select(elements, { add = false } = {}) {
  if (!add) tab.selection.clear();
  for (const el of elements) tab.selection.add(el);
  drawOverlay();
  renderProps();
}

function toggle(el) {
  if (tab.selection.has(el)) tab.selection.delete(el); else tab.selection.add(el);
  drawOverlay();
  renderProps();
}

function enterGroup(group, clientX, clientY) {
  tab.scope = group;
  const hit = clientX !== undefined ? hitAt(clientX, clientY) : null;
  select(hit ? [hit] : []);
  setStatus(`Editing inside ${label(group)}. Esc or double-click outside to leave.`);
}

function leaveGroup() {
  if (!tab || tab.scope === root()) return false;
  const group = tab.scope;
  tab.scope = group.parentNode && group.parentNode !== tab.doc ? group.parentNode : root();
  while (isLayer(tab.scope) && tab.scope !== root()) tab.scope = tab.scope.parentNode;
  select([group]);
  return true;
}

// ------------------------------------------------------------ geometry --

const matrixOf = (m) => [m.a, m.b, m.c, m.d, m.e, m.f];
/** Element (or its parent's) units → frame pixels. */
const screenCTM = (el) => matrixOf(el.getScreenCTM() ?? new DOMMatrix());
const parentCTM = (el) => (el.parentNode?.nodeType === 1 && el.parentNode.getScreenCTM ? screenCTM(el.parentNode) : [...g.IDENTITY]);
/** The element's own transform as one matrix, read without touching the attribute. */
function ownMatrix(el) {
  let m = [...g.IDENTITY];
  const list = el.transform?.baseVal;
  if (list) for (let i = 0; i < list.numberOfItems; i++) m = g.multiply(m, matrixOf(list.getItem(i).matrix));
  return m;
}

/** An element's box in frame pixels. */
function boxOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
function unionBox(elements) {
  const boxes = elements.map(boxOf).filter((b) => b.w || b.h);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** Frame pixels → the document's user units (what X/Y/W/H show). */
function toUser(box) {
  const inv = g.invert(screenCTM(root()));
  const [x, y] = g.apply(inv, [box.x, box.y]);
  const [w, hh] = g.applyVector(inv, [box.w, box.h]);
  return { x, y, w, h: hh };
}

// ----------------------------------------------------------- transforms --

/** Snapshot of the selection before a move or scale: each element's transform and matrices. */
function capture(elements) {
  return elements.map((el) => ({ el, original: el.getAttribute("transform"), own: ownMatrix(el), parent: parentCTM(el) }));
}

function setTransform(el, value) {
  if (value === null) el.removeAttribute("transform");
  else if (el.getAttribute("transform") !== value) el.setAttribute("transform", value);
}

/** Move the captured elements by (dx, dy) frame pixels. */
function moveBy(items, dx, dy) {
  for (const { el, original, parent } of items) {
    const [ux, uy] = g.applyVector(g.invert(parent), [dx, dy]);
    setTransform(el, g.moveTransform(original, ux, uy));
  }
}

/** Apply a frame-pixel transform `m` to the captured elements, each in its own parent's units. */
function transformBy(items, m) {
  for (const { el, original, own, parent } of items) {
    const local = g.multiply(g.multiply(g.invert(parent), m), parent);
    setTransform(el, g.composedTransform(original, local, own));
  }
}

// --------------------------------------------------------- pointer work --

let gesture = null; // { kind: "move" | "scale" | "band" | "pan" | "zoom", ... }

ui.overlay.addEventListener("pointerdown", (event) => {
  if (!tab || event.button === 2) return;
  ui.viewport.focus({ preventScroll: true });
  const pan = event.button === 1 || spaceDown || tool === "pan";
  if (pan) { startPan(event); return; }
  if (event.button !== 0) return;
  if (editing) commitText();
  const start = { x: event.clientX, y: event.clientY, frame: toFrame(event.clientX, event.clientY) };
  if (tool === "zoom") { gesture = { kind: "zoom", start, shift: event.shiftKey }; ui.overlay.setPointerCapture(event.pointerId); return; }
  if (SHAPES.has(tool)) { gesture = { kind: "create", start, el: null }; ui.overlay.setPointerCapture(event.pointerId); return; }
  if (tool === "pen") { penDown(event, start); return; }
  if (tool === "node") { nodeDown(event, start); return; }
  if (tool === "text") {
    event.preventDefault();
    const text = tab.doc.elementFromPoint(...start.frame)?.closest?.("text");
    if (text && !locked(text)) editText(text); else newText(start.frame);
    return;
  }

  const handle = event.target.closest?.("[data-handle]");
  if (handle && tab.selection.size) {
    const [hx, hy] = handle.dataset.handle.split(",").map(Number);
    const box = unionBox(selected());
    gesture = { kind: "scale", start, box, hx, hy, items: capture(selected()), begun: false };
    ui.overlay.setPointerCapture(event.pointerId);
    return;
  }

  const hit = hitAt(event.clientX, event.clientY, { deep: event.ctrlKey || event.metaKey });
  if (hit) {
    if (event.shiftKey) toggle(hit);
    else if (!tab.selection.has(hit)) select([hit]);
    gesture = { kind: "move", start, items: null, begun: false };
  } else {
    if (!event.shiftKey) select([]);
    gesture = { kind: "band", start, add: event.shiftKey, rect: null };
  }
  ui.overlay.setPointerCapture(event.pointerId);
});

ui.overlay.addEventListener("pointermove", (event) => {
  if (!gesture && tab && tool === "pen" && pen) { pen.cursor = toFrame(event.clientX, event.clientY); drawOverlay(); return; }
  if (!gesture || !tab) return;
  const { start } = gesture;
  const travelled = Math.hypot(event.clientX - start.x, event.clientY - start.y);
  const [fx, fy] = toFrame(event.clientX, event.clientY);
  let dx = fx - start.frame[0];
  let dy = fy - start.frame[1];

  if (gesture.kind === "pan") {
    tab.view = { ...tab.view, x: gesture.view.x + event.clientX - start.x, y: gesture.view.y + event.clientY - start.y };
    applyView();
  } else if (gesture.kind === "move") {
    if (!gesture.begun) {
      if (travelled < DRAG_START || !tab.selection.size) return;
      gesture.begun = true;
      gesture.items = capture(selected());
      tab.history.begin("Move");
    }
    if (event.ctrlKey || event.metaKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    moveBy(gesture.items, dx, dy);
    drawOverlay();
    const user = g.applyVector(g.invert(screenCTM(root())), [dx, dy]);
    setStatus(`Move ${g.fmt(user[0])}, ${g.fmt(user[1])} ${tab.unit}`, { sticky: true });
  } else if (gesture.kind === "scale") {
    if (!gesture.begun) { if (travelled < 1) return; gesture.begun = true; tab.history.begin("Scale"); }
    const { box, hx, hy } = gesture;
    const ax = box.x + box.w * (1 - hx);
    const ay = box.y + box.h * (1 - hy);
    const grabX = box.x + box.w * hx;
    const grabY = box.y + box.h * hy;
    let sx = hx === 0.5 ? 1 : (grabX + dx - ax) / (grabX - ax || 1);
    let sy = hy === 0.5 ? 1 : (grabY + dy - ay) / (grabY - ay || 1);
    if (event.ctrlKey || event.metaKey) {
      const s = hx === 0.5 ? sy : hy === 0.5 ? sx : (Math.abs(sx) > Math.abs(sy) ? sx : sy);
      sx = s; sy = s;
    }
    if (!Number.isFinite(sx) || Math.abs(sx) < 1e-3) sx = 1e-3;
    if (!Number.isFinite(sy) || Math.abs(sy) < 1e-3) sy = 1e-3;
    transformBy(gesture.items, g.scalingAbout(sx, sy, ax, ay));
    drawOverlay();
    setStatus(`Scale ${Math.round(sx * 100)}% × ${Math.round(sy * 100)}%`, { sticky: true });
  } else if (gesture.kind === "pen") {
    if (travelled < DRAG_START) return;
    const { node } = gesture;
    node.out = [fx, fy];
    node.in = [2 * node.p[0] - fx, 2 * node.p[1] - fy];
    drawOverlay();
  } else if (gesture.kind === "nodes" || gesture.kind === "handle") {
    if (!gesture.begun) { if (travelled < DRAG_START) return; gesture.begun = true; tab.history.begin(gesture.kind === "nodes" ? "Move nodes" : "Move handle"); }
    dragNodes(gesture, dx, dy, [fx, fy], event.ctrlKey || event.metaKey);
    drawOverlay();
  } else if (gesture.kind === "create") {
    if (!gesture.el) {
      if (travelled < DRAG_START) return;
      tab.history.begin(`Draw ${tool}`);
      gesture.parent = insertionParent();
      gesture.local = placer(gesture.parent);
      gesture.el = createElement(gesture.parent, tool === "line" ? "path" : tool, { transform: gesture.local.transform, style: shapeStyle(gesture.local, tool) });
    }
    const [sx, sy] = start.frame;
    let [ex, ey] = [fx, fy];
    if (event.ctrlKey || event.metaKey) {
      if (tool === "line") { const [ddx, ddy] = g.snapAngle(ex - sx, ey - sy); ex = sx + ddx; ey = sy + ddy; }
      else { const d = Math.max(Math.abs(ex - sx), Math.abs(ey - sy)); ex = sx + Math.sign(ex - sx || 1) * d; ey = sy + Math.sign(ey - sy || 1) * d; }
    }
    shapeGeometry(gesture.el, tool, gesture.local, [sx, sy], [ex, ey]);
    select([gesture.el]);
  } else if (gesture.kind === "band" || gesture.kind === "zoom" || gesture.kind === "nodeband") {
    if (travelled < DRAG_START) return;
    gesture.rect = { x: Math.min(start.frame[0], fx), y: Math.min(start.frame[1], fy), w: Math.abs(dx), h: Math.abs(dy) };
    drawOverlay();
  }
});

function endGesture(event) {
  if (!gesture || !tab) { gesture = null; return; }
  const done = gesture;
  gesture = null;
  if (event?.pointerId !== undefined && ui.overlay.hasPointerCapture(event.pointerId)) ui.overlay.releasePointerCapture(event.pointerId);
  if (done.kind === "pan") ui.viewport.classList.remove("dragging");
  if ((done.kind === "move" || done.kind === "scale") && done.begun) { tab.history.end(); setStatus(""); }
  if (done.kind === "create" && done.el) { tab.history.end(); select([done.el]); }
  if ((done.kind === "nodes" || done.kind === "handle") && done.begun) tab.history.end();
  if (done.kind === "nodeband" && nodes) {
    if (!done.add) nodes.selected.clear();
    if (done.rect) {
      const r = done.rect;
      const m = screenCTM(nodes.el);
      nodes.subpaths.forEach((sub, si) => sub.nodes.forEach((n, i) => {
        const [x, y] = g.apply(m, n.p);
        if (x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h) nodes.selected.add(`${si}:${i}`);
      }));
    }
  }
  if (done.kind === "band" && done.rect) {
    const r = done.rect;
    const inside = selectableChildren().filter((el) => {
      const b = boxOf(el);
      return (b.w || b.h) && b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
    });
    select(inside, { add: done.add });
  }
  if (done.kind === "zoom") {
    if (done.rect && done.rect.w > 4 && done.rect.h > 4) zoomToBox(done.rect);
    else { const r = ui.viewport.getBoundingClientRect(); zoomAt(done.shift ? 1 / 1.5 : 1.5, done.start.x - r.left, done.start.y - r.top); }
  }
  drawOverlay();
  renderProps();
}
ui.overlay.addEventListener("pointerup", endGesture);
ui.overlay.addEventListener("pointercancel", endGesture);
ui.overlay.addEventListener("lostpointercapture", () => { if (gesture) endGesture(); });

function startPan(event) {
  gesture = { kind: "pan", start: { x: event.clientX, y: event.clientY, frame: [0, 0] }, view: { ...tab.view } };
  ui.viewport.classList.add("dragging");
  ui.overlay.setPointerCapture(event.pointerId);
  event.preventDefault();
}

ui.overlay.addEventListener("dblclick", (event) => {
  if (!tab) return;
  if (tool === "pen") { finishPen(false, { dropRepeat: true }); return; }
  if (tool === "node") { addNodeAt(event.clientX, event.clientY); return; }
  if (tool !== "select") return;
  const hit = hitAt(event.clientX, event.clientY);
  if (hit?.localName === "text") editText(hit);
  else if (hit?.localName === "path") setTool("node");
  else if (hit && isGroup(hit)) enterGroup(hit, event.clientX, event.clientY);
  else if (!hit) leaveGroup();
});

ui.overlay.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (!tab) return;
  const hit = hitAt(event.clientX, event.clientY);
  if (hit && !tab.selection.has(hit)) select([hit]);
  const items = selected();
  contextMenu(event, [
    ...(items.length === 1 && isGroup(items[0]) ? [{ label: "Enter group", icon: "layers", run: () => enterGroup(items[0]) }] : []),
    ...(tab.scope !== root() ? [{ label: "Leave group", icon: "arrow_upward", run: leaveGroup }] : []),
    ...(items.length ? [
      { label: "Duplicate", icon: "content_copy", run: duplicate },
      { label: "Raise to top", icon: "flip_to_front", run: () => arrange("top") },
      { label: "Lower to bottom", icon: "flip_to_back", run: () => arrange("bottom") },
      "-",
      { label: "Delete", icon: "delete", run: deleteSelection },
    ] : [{ label: "Select all", icon: "select_all", run: selectAll }]),
    "-",
    { label: "Fit page", icon: "fit_screen", run: fit },
  ]);
});

// --------------------------------------------------------- the overlay --

const OVERLAY_NS = SVG_NS;
const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(OVERLAY_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const HANDLES = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
const HANDLE_GAP = 8; // px between the box and its handles
const HANDLE_CURSORS = { "0,0": "nwse-resize", "1,1": "nwse-resize", "1,0": "nesw-resize", "0,1": "nesw-resize", "0.5,0": "ns-resize", "0.5,1": "ns-resize", "0,0.5": "ew-resize", "1,0.5": "ew-resize" };

function viewRect(box) {
  const [x1, y1] = toView(box.x, box.y);
  const [x2, y2] = toView(box.x + box.w, box.y + box.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function drawOverlay() {
  const parts = [];
  if (tab?.view) {
    if (tab.scope !== root()) {
      const b = boxOf(tab.scope);
      if (b.w || b.h) { const r = viewRect(b); parts.push(svgEl("rect", { class: "scope", x: r.x - 4, y: r.y - 4, width: r.w + 8, height: r.h + 8 })); }
    }
    const items = selected();
    if (items.length > 1) for (const el of items) { const r = viewRect(boxOf(el)); parts.push(svgEl("rect", { class: "item", x: r.x, y: r.y, width: r.w, height: r.h })); }
    if (tool === "node") syncNodes();
    const box = items.length && !(tool === "node" && nodes) ? unionBox(items) : null;
    if (nodes) parts.push(...nodeOverlay());
    if (pen) parts.push(...penOverlay());
    if (box) {
      const r = viewRect(box);
      parts.push(svgEl("rect", { class: "selection", x: r.x, y: r.y, width: Math.max(r.w, 1), height: Math.max(r.h, 1) }));
      // Handles sit just outside the box (as in Inkscape), so a small object stays easy to grab and move.
      if (tool === "select") for (const [hx, hy] of HANDLES) {
        const cx = r.x + r.w * hx + (hx - 0.5) * 2 * HANDLE_GAP;
        const cy = r.y + r.h * hy + (hy - 0.5) * 2 * HANDLE_GAP;
        parts.push(svgEl("rect", { class: "handle", "data-handle": `${hx},${hy}`, x: cx - 5, y: cy - 5, width: 10, height: 10, style: `cursor:${HANDLE_CURSORS[`${hx},${hy}`]}` }));
      }
    }
    if (gesture?.rect) { const r = viewRect(gesture.rect); parts.push(svgEl("rect", { class: gesture.kind === "zoom" ? "zoombox" : "band", x: r.x, y: r.y, width: r.w, height: r.h })); }
  }
  ui.overlay.replaceChildren(...parts);
}

// -------------------------------------------------------------- creating --

const SHAPES = new Set(["rect", "ellipse", "line"]);
const textEditor = $("#text-editor");
let editing = null; // the text being written: { text: element | null, at: [x, y] frame px }

/** Starting style for a drawing: sizes in its own units, scaled to its page. */
function defaultStyle(doc, size) {
  const vb = doc.documentElement.viewBox?.baseVal;
  const pageH = vb?.height || size.h;
  const nice = (v) => Number(v.toPrecision(2));
  return { fill: "#1e88e5", stroke: null, strokeWidth: nice(pageH / 1000), fontSize: nice(pageH / 90), fontFamily: "sans-serif", textFill: "#1b1f27" };
}

const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
/** How many of an element's own units make one unit of the document. */
const unitsPerDocUnit = (el) => scaleOf(screenCTM(root())) / scaleOf(screenCTM(el));

/** Where new objects go: the group being edited, else the layer of the selection, the current layer or the top one. */
function insertionParent() {
  if (tab.scope !== root()) return tab.scope;
  return currentLayer() ?? root();
}

/** The layer new objects go to: the selection's, the one picked in the panel, Inkscape's current one, or the top one. */
function currentLayer() {
  const layers = allLayers();
  if (!layers.length) return null;
  const first = selected()[0];
  const current = tab.doc.querySelector("namedview")?.getAttributeNS(INKSCAPE_NS, "current-layer");
  // Without a choice (selection, panel), never a layer you cannot see or touch.
  const usable = layers.filter((l) => !layerHidden(l) && !layerLocked(l) && !layers.some((outer) => outer !== l && outer.contains(l) && (layerHidden(outer) || layerLocked(outer))));
  return layers.find((l) => first && l.contains(first) && !layers.some((inner) => inner !== l && l.contains(inner) && inner.contains(first)))
    ?? (tab.layer?.isConnected ? tab.layer : null) ?? usable.find((l) => l.id === current) ?? usable.at(-1) ?? layers.at(-1);
}

/** Every layer and sublayer, in document order. */
const allLayers = () => [...root().querySelectorAll("g")].filter(isLayer);

/**
 * How to place frame points in `parent`: straight into its units when it is not rotated or skewed,
 * else in frame pixels with a transform that undoes the parent's. `unit`: local units per document unit.
 */
function placer(parent) {
  const m = screenCTM(parent);
  if (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) {
    const inv = g.invert(m);
    return { at: (x, y) => g.apply(inv, [x, y]), transform: null, unit: unitsPerDocUnit(parent) };
  }
  return { at: (x, y) => [x, y], transform: g.matrixString(g.invert(m)), unit: scaleOf(screenCTM(root())) };
}

const fontValue = (family) => (/^[\w-]+$/.test(family) ? family : `'${family.replace(/'/g, "")}'`);

function shapeStyle(local, kind) {
  const s = tab.style;
  if (kind === "line") return `fill:none;stroke:${s.stroke ?? s.fill ?? "#1b1f27"};stroke-width:${g.fmt(s.strokeWidth * local.unit)};stroke-linecap:round`;
  return `fill:${s.fill ?? "none"};stroke:${s.stroke ?? "none"}${s.stroke ? `;stroke-width:${g.fmt(s.strokeWidth * local.unit)}` : ""}`;
}

/** Shape a new rect, ellipse or line between two frame points. */
function shapeGeometry(el, kind, local, a, b) {
  const [x1, y1] = local.at(...a);
  const [x2, y2] = local.at(...b);
  const box = { x: g.fmt(Math.min(x1, x2)), y: g.fmt(Math.min(y1, y2)), width: g.fmt(Math.abs(x2 - x1)), height: g.fmt(Math.abs(y2 - y1)) };
  if (kind === "rect") setAttributes(el, box);
  else if (kind === "ellipse") setAttributes(el, { cx: g.fmt((x1 + x2) / 2), cy: g.fmt((y1 + y2) / 2), rx: g.fmt(Math.abs(x2 - x1) / 2), ry: g.fmt(Math.abs(y2 - y1) / 2) });
  else el.setAttribute("d", `M ${g.fmt(x1)},${g.fmt(y1)} ${g.fmt(x2)},${g.fmt(y2)}`);
}

// Text is written in a box over the drawing and goes into the document when it is done.
function showTextEditor({ value, x, y, size, family, color }) {
  const [vx, vy] = toView(x, y);
  Object.assign(textEditor.style, { left: `${vx}px`, top: `${vy}px`, fontSize: `${Math.max(size * tab.view.scale, 6)}px`, fontFamily: family, color, width: "auto", height: "auto" });
  textEditor.value = value;
  textEditor.hidden = false;
  fitTextEditor();
  setTimeout(() => { textEditor.focus(); textEditor.select(); }, 0);
  setStatus("Ctrl+Enter or click away to finish, Esc to cancel.", { sticky: true });
}
function fitTextEditor() {
  textEditor.style.width = "0"; textEditor.style.height = "0";
  textEditor.style.width = `${textEditor.scrollWidth + 8}px`;
  textEditor.style.height = `${textEditor.scrollHeight}px`;
}
textEditor.addEventListener("input", fitTextEditor);
textEditor.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape") { event.preventDefault(); editing = null; textEditor.hidden = true; setStatus(""); ui.viewport.focus(); }
  else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitText(); ui.viewport.focus(); }
});
textEditor.addEventListener("blur", () => commitText());

function newText([x, y]) {
  editing = { text: null, at: [x, y] };
  const size = tab.style.fontSize * scaleOf(screenCTM(root()));
  showTextEditor({ value: "", x, y, size, family: tab.style.fontFamily, color: tab.style.textFill });
}

function editText(text) {
  editing = { text };
  select([text]);
  const cs = tab.doc.defaultView.getComputedStyle(text);
  const box = boxOf(text);
  const size = Number.parseFloat(cs.fontSize) * scaleOf(screenCTM(text));
  showTextEditor({ value: textLines(text).map((l) => l.text).join("\n"), x: box.x, y: box.y - size * 0.1, size, family: cs.fontFamily, color: g.hexColor(cs.fill) ?? "#000" });
}

function commitText() {
  if (!editing || !tab) return;
  const done = editing;
  editing = null;
  textEditor.hidden = true;
  setStatus("");
  const value = textEditor.value.replace(/\s+$/, "");
  const lines = value.split("\n");
  if (done.text) {
    const text = done.text;
    if (value === textLines(text).map((l) => l.text).join("\n")) return;
    if (!value.trim()) { tab.history.edit("Delete text", () => text.remove()); select([]); return; }
    const old = textLines(text).map((l) => Number.parseFloat(l.node.getAttribute("y")));
    const size = Number.parseFloat(tab.doc.defaultView.getComputedStyle(text).fontSize);
    const lineHeight = old.length > 1 && Number.isFinite(old[1] - old[0]) ? old.at(-1) - old.at(-2) : size * 1.25;
    tab.history.edit("Edit text", () => setTextLines(text, lines, { lineHeight, taken: takenIds(tab.doc) }));
    select([text]);
    return;
  }
  if (!value.trim()) return;
  const parent = insertionParent();
  const local = placer(parent);
  const size = tab.style.fontSize * local.unit;
  const [x, top] = local.at(...done.at);
  let text;
  tab.history.edit("Text", () => {
    ensureNamespace(tab.doc, "sodipodi", SODIPODI_NS);
    const taken = takenIds(tab.doc);
    text = createElement(parent, "text", {
      style: `font-size:${g.fmt(size)};line-height:1.25;font-family:${fontValue(tab.style.fontFamily)};fill:${tab.style.textFill}`,
      x: g.fmt(x), y: g.fmt(top + size * 0.8), transform: local.transform,
    }, taken);
    text.setAttributeNS(XML_NS, "xml:space", "preserve");
    lines.forEach((line, i) => {
      const tspan = createElement(text, "tspan", { x: g.fmt(x), y: g.fmt(top + size * (0.8 + 1.25 * i)) }, taken);
      tspan.setAttributeNS(SODIPODI_NS, "sodipodi:role", "line");
      tspan.textContent = line;
    });
  });
  select([text]);
}

// Images (embedded, as Inkscape does by default) and SVG figures (as a group, ids kept unique).
const blobToDataUrl = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });

/** A box of `w`×`h` frame px, shrunk to at most half the page, centred in the view. */
function placeBox(w, h) {
  const k = Math.min(1, (tab.size.w * 0.5) / w, (tab.size.h * 0.5) / h);
  const r = ui.viewport.getBoundingClientRect();
  const [cx, cy] = toFrame(r.left + r.width / 2, r.top + r.height / 2);
  return { x: cx - (w * k) / 2, y: cy - (h * k) / 2, w: w * k, h: h * k };
}

async function insertImage(blob, name) {
  const href = await blobToDataUrl(blob);
  const img = new Image();
  img.src = href;
  await img.decode().catch(() => { throw new Error(`${name} is not an image Draw can show`); });
  const box = placeBox(img.naturalWidth, img.naturalHeight);
  const parent = insertionParent();
  const local = placer(parent);
  let el;
  tab.history.edit("Insert image", () => {
    ensureNamespace(tab.doc, "xlink", XLINK_NS);
    el = createElement(parent, "image", { preserveAspectRatio: "none", transform: local.transform });
    shapeGeometry(el, "rect", local, [box.x, box.y], [box.x + box.w, box.y + box.h]);
    el.setAttributeNS(XLINK_NS, "xlink:href", href);
  });
  select([el]);
}

function insertSvg(text, name) {
  const parent = insertionParent();
  let group;
  tab.history.edit("Insert figure", () => {
    const imported = importSvg(tab.doc, text, name, takenIds(tab.doc));
    group = imported.group;
    const box = placeBox(imported.px.w, imported.px.h);
    // Figure units → frame px (placed and fitted), then into the parent's units.
    const figure = g.multiply(g.multiply(g.translation(box.x, box.y), [box.w / imported.box.w, 0, 0, box.h / imported.box.h, 0, 0]), g.translation(-imported.box.x, -imported.box.y));
    group.setAttribute("transform", g.matrixString(g.multiply(g.invert(screenCTM(parent)), figure)));
    appendIndented(parent, group);
  });
  select([group]);
}

/** Insert files: SVGs as figures, anything else as images. */
async function insertFiles(files) {
  for (const file of files) {
    try {
      if (/\.svg$/i.test(file.name) || file.type === "image/svg+xml") insertSvg(await file.text(), file.name);
      else if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") await insertPdf({ blob: file, name: file.name });
      else await insertImage(file, file.name);
    } catch (error) { toast(error.message); }
  }
}

async function insertDialog() {
  const path = await ask({ title: "Insert an image or figure", message: "PNG, JPEG, WebP, GIF, SVG, or the first page of a PDF", value: `${dirOf(tab.path)}/`, ok: "Insert" });
  if (!path) return;
  try {
    const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`);
    if (/\.pdf$/i.test(info.path)) { await insertPdf({ path: info.path, name: nameOf(info.path) }); return; }
    const { url } = await host("/v1/links", { method: "POST", body: JSON.stringify({ path: info.path }) });
    const blob = await (await fetch(`${HOST_ENDPOINT}${url}`)).blob();
    await insertFiles([new File([blob], nameOf(info.path), { type: blob.type })]);
  } catch (error) { toast(error.message); }
}

ui.viewport.addEventListener("dragover", (event) => { if (tab && event.dataTransfer.types.includes("Files")) { event.preventDefault(); ui.viewport.classList.add("drop"); } });
ui.viewport.addEventListener("dragleave", () => ui.viewport.classList.remove("drop"));
ui.viewport.addEventListener("drop", (event) => {
  ui.viewport.classList.remove("drop");
  if (!tab || !event.dataTransfer.files.length) return;
  event.preventDefault();
  void insertFiles([...event.dataTransfer.files]);
});

// The clipboard: objects copied here paste back in place (into the group or layer being edited);
// an image or SVG from elsewhere is inserted.
let clip = null; // { items: [{ node, parent: frame matrix of its old parent }], text }

async function copySelection({ cut = false } = {}) {
  const items = selected();
  if (!items.length) return;
  clip = { items: items.map((el) => ({ node: el.cloneNode(true), parent: parentCTM(el) })), text: null };
  clip.text = `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}">${items.map((el) => new XMLSerializer().serializeToString(el)).join("")}</svg>`;
  await navigator.clipboard.writeText(clip.text).catch(() => {});
  if (cut) deleteSelection();
  setStatus(`${cut ? "Cut" : "Copied"} ${items.length} ${items.length === 1 ? "object" : "objects"}`);
}

function pasteObjects() {
  const parent = insertionParent();
  const here = screenCTM(parent);
  const taken = takenIds(tab.doc);
  const copies = [];
  tab.history.edit("Paste", () => {
    for (const { node, parent: there } of clip.items) {
      const copy = copyWithFreshIds(node, taken);
      appendIndented(parent, copy);
      declareNamespaces(tab.doc, copy);
      // Where it was on the page, whatever the new parent's transform.
      setTransform(copy, g.composedTransform(copy.getAttribute("transform"), g.multiply(g.invert(here), there), ownMatrix(copy)));
      copies.push(copy);
    }
  });
  select(copies);
}

async function paste() {
  let items = [];
  try { items = await navigator.clipboard.read(); } catch { /* nothing readable */ }
  for (const item of items) {
    const image = item.types.find((t) => t.startsWith("image/") && t !== "image/svg+xml");
    if (image) { await insertImage(await item.getType(image), "pasted image").catch((error) => toast(error.message)); return; }
    if (item.types.includes("text/plain")) {
      const text = await (await item.getType("text/plain")).text();
      if (clip && text === clip.text) { pasteObjects(); return; }
      if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(text)) { try { insertSvg(text, "pasted figure"); } catch (error) { toast(error.message); } return; }
    }
  }
  if (clip) pasteObjects();
}

// ------------------------------------------------------------ paths: pen --

// The path being drawn, in frame px until it is finished: { nodes: [{ p, in, out }], cursor }.
let pen = null;

function penDown(event, start) {
  pen ??= { nodes: [] };
  const first = pen.nodes[0];
  if (first && pen.nodes.length >= 2) {
    const [vx, vy] = toView(...first.p);
    const r = ui.viewport.getBoundingClientRect();
    if (Math.hypot(event.clientX - r.left - vx, event.clientY - r.top - vy) < 8) { finishPen(true); return; }
  }
  const node = { p: start.frame, in: null, out: null };
  pen.nodes.push(node);
  gesture = { kind: "pen", start, node };
  ui.overlay.setPointerCapture(event.pointerId);
  drawOverlay();
}

/** Turn what the pen drew into a path (closed: back to its first node). */
function finishPen(closed, { dropRepeat = false } = {}) {
  const drawn = pen;
  pen = null;
  // A double-click to finish also put down two nodes on top of each other.
  if (dropRepeat && drawn) {
    const near = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) * tab.view.scale < 4;
    while (drawn.nodes.length > 1 && near(drawn.nodes.at(-1), drawn.nodes.at(-2))) drawn.nodes.pop();
  }
  if (!drawn || drawn.nodes.length < 2) { drawOverlay(); return; }
  const parent = insertionParent();
  const local = placer(parent);
  const at = (pt) => (pt ? local.at(...pt) : null);
  const list = drawn.nodes.map((n, i) => ({ p: at(n.p), in: at(n.in), out: at(n.out), kind: "M" }));
  list.forEach((n, i) => { if (i) n.kind = list[i - 1].out || n.in ? "C" : "L"; });
  if (!closed) { list[0].in = null; list.at(-1).out = null; }
  const s = tab.style;
  let el;
  tab.history.edit("Pen", () => {
    el = createElement(parent, "path", {
      style: `fill:${closed ? (s.fill ?? "none") : "none"};stroke:${s.stroke ?? "#1b1f27"};stroke-width:${g.fmt(s.strokeWidth * local.unit)};stroke-linecap:round;stroke-linejoin:round`,
      d: serializePath([{ nodes: list, closed }]), transform: local.transform,
    });
  });
  select([el]);
}

function penOverlay() {
  const pts = pen.nodes;
  if (!pts.length) return [];
  const v = (pt) => toView(...pt).map(g.fmt).join(",");
  let d = `M ${v(pts[0].p)}`;
  for (let i = 1; i < pts.length; i++) d += pts[i - 1].out || pts[i].in ? ` C ${v(pts[i - 1].out ?? pts[i - 1].p)} ${v(pts[i].in ?? pts[i].p)} ${v(pts[i].p)}` : ` L ${v(pts[i].p)}`;
  const parts = [svgEl("path", { class: "pen-path", d })];
  const last = pts.at(-1);
  if (pen.cursor && !gesture) parts.push(svgEl("path", { class: "pen-rubber", d: `M ${v(last.p)} ${last.out ? `C ${v(last.out)} ${v(pen.cursor)} ` : "L "}${v(pen.cursor)}` }));
  if (last.out) {
    for (const h of [last.in, last.out]) { const [x, y] = toView(...h); const [px, py] = toView(...last.p); parts.push(svgEl("line", { class: "node-arm", x1: px, y1: py, x2: x, y2: y }), svgEl("circle", { class: "node-handle", cx: x, cy: y, r: 3.5 })); }
  }
  pts.forEach((n, i) => { const [x, y] = toView(...n.p); parts.push(svgEl("rect", { class: `node${i === 0 && pts.length > 1 ? " closer" : ""}`, x: x - 4, y: y - 4, width: 8, height: 8 })); });
  return parts;
}

// ----------------------------------------------------------- paths: nodes --

// The path whose nodes are being edited: { el, d (as last read or written), subpaths (in the
// element's own units), selected: Set of "subpath:node" }.
let nodes = null;

const viewMatrix = () => [tab.view.scale, 0, 0, tab.view.scale, tab.view.x, tab.view.y];
const nodeTarget = () => { const items = selected(); return items.length === 1 && items[0].localName === "path" ? items[0] : null; };

/** Follow the selected path (and its `d`, which undo or the agent may change). */
function syncNodes() {
  const el = tool === "node" ? nodeTarget() : null;
  if (!el) { nodes = null; return; }
  const d = el.getAttribute("d") ?? "";
  if (nodes?.el === el && nodes.d === d) return;
  let subpaths;
  try { subpaths = parsePath(d); } catch (error) { nodes = null; setStatus(error.message); return; }
  const kept = nodes?.el === el ? [...nodes.selected].filter((k) => { const [s, i] = k.split(":").map(Number); return subpaths[s]?.nodes[i]; }) : [];
  nodes = { el, d, subpaths, selected: new Set(kept) };
}

function writeNodes() {
  nodes.d = serializePath(nodes.subpaths);
  nodes.el.setAttribute("d", nodes.d);
}

const nodeAt = (key) => { const [s, i] = key.split(":").map(Number); return { sub: nodes.subpaths[s], i, node: nodes.subpaths[s]?.nodes[i] }; };
const neighbours = (sub, i) => {
  const n = sub.nodes.length;
  return { prev: i > 0 ? sub.nodes[i - 1] : sub.closed ? sub.nodes[n - 1] : null, next: i < n - 1 ? sub.nodes[i + 1] : sub.closed ? sub.nodes[0] : null };
};
const copyNode = (n) => ({ ...n, p: [...n.p], in: n.in && [...n.in], out: n.out && [...n.out] });

function nodeDown(event, start) {
  syncNodes();
  const target = event.target.closest?.("[data-node], [data-handle-of]");
  if (nodes && target?.dataset.node) {
    const key = target.dataset.node;
    if (event.shiftKey) { if (nodes.selected.has(key)) nodes.selected.delete(key); else nodes.selected.add(key); }
    else if (!nodes.selected.has(key)) nodes.selected = new Set([key]);
    gesture = { kind: "nodes", start, begun: false, origin: new Map([...nodes.selected].map((k) => [k, copyNode(nodeAt(k).node)])) };
  } else if (nodes && target?.dataset.handleOf) {
    const [s, i, which] = target.dataset.handleOf.split(":");
    const { node } = nodeAt(`${s}:${i}`);
    gesture = { kind: "handle", start, begun: false, key: `${s}:${i}`, which, smooth: isSmooth(node) };
  } else {
    // A click on another object picks it (inside groups too); on nothing, a box selects nodes.
    const hit = tab.doc.elementFromPoint(...start.frame);
    const el = hit && pickable(hit, { deep: true });
    if (el && el !== nodes?.el) {
      select([el]);
      if (el.localName !== "path") setStatus(`A ${el.localName} has no nodes to edit until it is a path: Object to path, in the panel.`);
      return;
    }
    gesture = { kind: "nodeband", start, add: event.shiftKey, rect: null };
  }
  ui.overlay.setPointerCapture(event.pointerId);
  drawOverlay();
  renderProps();
}

/** Move the selected nodes (with their handles) or one handle, by a drag in frame px. */
function dragNodes(drag, dx, dy, [fx, fy], constrain) {
  const inv = g.invert(screenCTM(nodes.el));
  if (drag.kind === "nodes") {
    if (constrain) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const [ux, uy] = g.applyVector(inv, [dx, dy]);
    const shift = (pt) => pt && [pt[0] + ux, pt[1] + uy];
    for (const [key, from] of drag.origin) Object.assign(nodeAt(key).node, { p: shift(from.p), in: shift(from.in), out: shift(from.out) });
  } else {
    const { node } = nodeAt(drag.key);
    let pt = g.apply(inv, [fx, fy]);
    if (constrain) { const [sx, sy] = g.snapAngle(pt[0] - node.p[0], pt[1] - node.p[1]); pt = [node.p[0] + sx, node.p[1] + sy]; }
    node[drag.which] = pt;
    const other = drag.which === "in" ? "out" : "in";
    // A smooth node stays smooth: the other handle turns with this one and keeps its length.
    if (drag.smooth && node[other]) {
      const len = Math.hypot(node[other][0] - node.p[0], node[other][1] - node.p[1]);
      const dir = [node.p[0] - pt[0], node.p[1] - pt[1]];
      const l = Math.hypot(...dir) || 1;
      node[other] = [node.p[0] + (dir[0] / l) * len, node.p[1] + (dir[1] / l) * len];
    }
    if (drag.which === "in" && node.kind === "L") node.kind = "C";
  }
  writeNodes();
}

function nodeOverlay() {
  const m = screenCTM(nodes.el);
  const total = g.multiply(viewMatrix(), m);
  const v = (pt) => g.apply(total, pt);
  const parts = [svgEl("path", { class: "node-outline", d: nodes.d, transform: g.matrixString(total) })];
  const shown = new Set();
  for (const key of nodes.selected) {
    const { sub, i, node } = nodeAt(key);
    if (!node) continue;
    const [s] = key.split(":");
    shown.add(`${s}:${i}:in`).add(`${s}:${i}:out`);
    const { prev, next } = neighbours(sub, i);
    if (prev) shown.add(`${s}:${sub.nodes.indexOf(prev)}:out`);
    if (next) shown.add(`${s}:${sub.nodes.indexOf(next)}:in`);
  }
  for (const key of shown) {
    const [s, i, which] = key.split(":");
    const node = nodes.subpaths[s].nodes[i];
    if (!node?.[which]) continue;
    const [px, py] = v(node.p);
    const [hx, hy] = v(node[which]);
    parts.push(svgEl("line", { class: "node-arm", x1: px, y1: py, x2: hx, y2: hy }), svgEl("circle", { class: "node-handle", cx: hx, cy: hy, r: 4, "data-handle-of": key }));
  }
  nodes.subpaths.forEach((sub, s) => sub.nodes.forEach((node, i) => {
    const [x, y] = v(node.p);
    const key = `${s}:${i}`;
    const smooth = isSmooth(node);
    parts.push(svgEl("rect", {
      class: `node${nodes.selected.has(key) ? " selected" : ""}`, "data-node": key, x: x - 4.5, y: y - 4.5, width: 9, height: 9,
      ...(smooth ? {} : { transform: `rotate(45 ${x} ${y})` }),
    }));
  }));
  return parts;
}

/** Double-click on a segment of the edited path: a node there, the curve's shape kept. */
function addNodeAt(clientX, clientY) {
  syncNodes();
  if (!nodes) { const hit = hitAt(clientX, clientY, { deep: true }); if (hit) select([hit]); return; }
  const [fx, fy] = toFrame(clientX, clientY);
  const m = screenCTM(nodes.el);
  let best = null;
  nodes.subpaths.forEach((sub, s) => {
    const n = sub.nodes.length;
    for (let i = sub.closed ? 0 : 1; i < n; i++) {
      const from = sub.nodes[(i - 1 + n) % n];
      const to = sub.nodes[i];
      if (to.kind === "A") continue;
      for (let k = 1; k < 48; k++) {
        const t = k / 48;
        const [x, y] = g.apply(m, pointAt(from, to, t));
        const dist = Math.hypot(x - fx, y - fy);
        if (!best || dist < best.dist) best = { dist, s, i, t };
      }
    }
  });
  if (!best || best.dist * tab.view.scale > 8) return;
  tab.history.edit("Add node", () => { splitSegment(nodes.subpaths[best.s], best.i, best.t); writeNodes(); });
  const sub = nodes.subpaths[best.s];
  nodes.selected = new Set([`${best.s}:${best.i === 0 ? sub.nodes.length - 1 : best.i}`]);
  drawOverlay(); renderProps();
}

function selectAllNodes() {
  nodes.selected = new Set(nodes.subpaths.flatMap((sub, s) => sub.nodes.map((_, i) => `${s}:${i}`)));
  drawOverlay(); renderProps();
}

/** Remove the selected nodes; a subpath left with one node goes, and so does a path left with none. */
function deleteNodes() {
  const el = nodes.el;
  const byPath = new Map();
  for (const key of nodes.selected) { const [s, i] = key.split(":").map(Number); byPath.set(s, [...(byPath.get(s) ?? []), i]); }
  tab.history.edit("Delete nodes", () => {
    for (const [s, list] of byPath) for (const i of list.sort((a, b) => b - a)) removeNode(nodes.subpaths[s], i);
    nodes.subpaths = nodes.subpaths.filter((sub) => sub.nodes.length > 1);
    if (nodes.subpaths.length) writeNodes(); else removeTidy(el);
  });
  if (!el.isConnected) { nodes = null; select([]); return; }
  nodes.selected.clear();
  drawOverlay(); renderProps();
}

/** Selected nodes: smooth (handles in line) or sharp (no handles). */
function setNodeKind(kind) {
  tab.history.edit(kind === "smooth" ? "Smooth nodes" : "Sharp nodes", () => {
    for (const key of nodes.selected) {
      const { sub, i, node } = nodeAt(key);
      const { prev, next } = neighbours(sub, i);
      if (kind === "smooth") makeSmooth(node, prev, next);
      else {
        node.in = null; node.out = null;
        if (node.kind === "C" && !prev?.out) node.kind = "L";
        if (next?.kind === "C" && !next.in) next.kind = "L";
      }
    }
    writeNodes();
  });
}

/** The segments between selected nodes (or next to a lone selected node): straight or curved. */
function setSegments(curved) {
  tab.history.edit(curved ? "Curve segments" : "Straighten segments", () => {
    nodes.subpaths.forEach((sub, s) => {
      const n = sub.nodes.length;
      const picked = (i) => nodes.selected.has(`${s}:${(i + n) % n}`);
      for (let i = sub.closed ? 0 : 1; i < n; i++) {
        const lone = nodes.selected.size === 1 && (picked(i) || picked(i - 1));
        if ((picked(i) && picked(i - 1)) || lone) setSegmentCurved(sub, i, curved);
      }
    });
    writeNodes();
  });
}

/** Rectangles, ellipses, lines and polygons become paths with the same outline, id and style. */
function objectToPath() {
  const shapes = selected().filter((el) => GEOMETRY[el.localName]);
  // Text, groups and the rest: Inkscape knows how.
  if (shapes.length !== selected().length) { void inkscapeOperation("object-to-path"); return; }
  const made = [];
  tab.history.edit("Object to path", () => {
    for (const el of shapes) {
      const attrs = Object.fromEntries(GEOMETRY[el.localName].map((name) => [name, name === "points" ? el.getAttribute(name) : Number.parseFloat(el.getAttribute(name))]));
      const d = shapePath(el.localName, attrs);
      if (!d) continue;
      const path = tab.doc.createElementNS(SVG_NS, "path");
      for (const attr of el.attributes) if (!GEOMETRY[el.localName].includes(attr.name)) path.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
      path.setAttribute("d", d);
      el.replaceWith(path);
      made.push(path);
    }
  });
  select(made);
}

function nodesSection(items) {
  if (tool !== "node") return null;
  const shapes = items.filter((el) => GEOMETRY[el.localName]);
  if (!nodes) {
    return h("div", {}, h("h3", {}, "Nodes"),
      shapes.length ? h("div.row-buttons", {}, h("button.btn", { type: "button", title: "Make it a path with the same outline", onclick: objectToPath }, icon("polyline", { size: 16 }), "Object to path"))
        : h("p.hint", {}, "Click a path to see its nodes. Double-click a path with the Select tool to come here."));
  }
  const count = nodes.selected.size;
  const total = nodes.subpaths.reduce((sum, sub) => sum + sub.nodes.length, 0);
  const button = (title, text, run, disabled) => h("button.btn", { type: "button", title, disabled: disabled || null, onclick: run }, text);
  return h("div", {}, h("h3", {}, "Nodes"),
    h("p.hint", {}, count ? `${count} of ${total} nodes selected` : `${total} nodes. Click one (Shift adds), drag a box around several, Ctrl+A selects all.`),
    h("div.row-buttons", {},
      button("Handles in one line (smooth curve through the node)", "Smooth", () => setNodeKind("smooth"), !count),
      button("No handles (a sharp corner)", "Sharp", () => setNodeKind("sharp"), !count),
      button("Straight segments between the selected nodes", "Straight", () => setSegments(false), !count),
      button("Curved segments between the selected nodes", "Curved", () => setSegments(true), !count),
      button("Remove the selected nodes (Delete)", "Delete", deleteNodes, !count)),
    h("p.hint", {}, "Double-click a segment to add a node. Ctrl while dragging: straight moves, handles in 15° steps."));
}

// ---------------------------------------------------------- Inkscape's tools --

// Booleans, text and stroke to path, combine, break apart and simplify are Inkscape's own: it gets a
// copy of the drawing with the objects' ids, marks what it made, and that is swapped in here (one
// undo step). Export and PDF import go through Inkscape as well (src/workspace/draw.mjs).
const OPERATION_LABELS = {
  union: "Union", difference: "Difference", intersection: "Intersection", exclusion: "Exclusion", division: "Division", "cut-path": "Cut path",
  combine: "Combine", "break-apart": "Break apart", "object-to-path": "Object to path", "stroke-to-path": "Stroke to path", simplify: "Simplify",
};
const NEEDS_TWO = new Set(["union", "difference", "intersection", "exclusion", "division", "cut-path", "combine"]);
const SAFE_ID = /^[A-Za-z_][\w.-]*$/;
let inkscapeBusy = false;

/** Where `node` is, as child indices from the document (to find its twin in a copy). */
const routeTo = (node) => { const route = []; for (let n = node; n.parentNode; n = n.parentNode) route.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n)); return route; };
const follow = (doc, route) => route.reduce((n, i) => n?.childNodes[i], doc);

async function inkscapeOperation(operation) {
  const items = inDocumentOrder(selected());
  const name = OPERATION_LABELS[operation];
  if (!items.length) { toast(`${name}: select the objects first`); return; }
  if (NEEDS_TWO.has(operation) && items.length < 2) { toast(`${name} works on two or more objects`); return; }
  if (inkscapeBusy) return;
  inkscapeBusy = true;
  setStatus(`${name}: Inkscape is working…`, { sticky: true });
  const doc = tab.doc;
  try {
    // A copy of the drawing where the objects, their parents and what follows them have ids Inkscape
    // can select by and keeps, so its result can be put back in the same place here.
    const copy = doc.cloneNode(true);
    const taken = takenIds(doc);
    const live = new Map(); // id in the copy → element here
    const tag = (el) => {
      const twin = follow(copy, routeTo(el));
      if (!el.id || !SAFE_ID.test(el.id)) twin.setAttribute("id", g.freshId("draw-anchor", taken));
      live.set(twin.getAttribute("id"), el);
      return twin.getAttribute("id");
    };
    const ids = items.map(tag);
    for (const el of items) {
      for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) tag(p);
      for (let n = el.nextElementSibling; n; n = n.nextElementSibling) tag(n);
    }
    const { svg } = await host("/v1/draw/operate", { method: "POST", body: JSON.stringify({ svg: g.frame(new XMLSerializer().serializeToString(copy), tab.framing), ids, operation }) });
    if (tab?.doc !== doc) return;
    const out = new DOMParser().parseFromString(svg, "image/svg+xml");
    const results = [...out.querySelectorAll("[data-draw-result]")].filter((el) => !el.parentNode.closest?.("[data-draw-result]"));
    const consumed = items.filter((el, i) => { const twin = out.getElementById(ids[i]); return !twin || twin.hasAttribute("data-draw-result"); });
    const made = [];
    tab.history.edit(name, () => {
      // Where each result goes: its parent here, before the first of its next siblings that stays.
      const places = results.map((r) => {
        const parent = r.parentNode === out.documentElement ? root() : live.get(r.parentNode.getAttribute("id")) ?? doc.getElementById(r.parentNode.getAttribute("id")) ?? insertionParent();
        let before = null;
        for (let sib = r.nextElementSibling; sib && !before; sib = sib.nextElementSibling) {
          const here = live.get(sib.getAttribute("id"));
          if (here && here.parentNode === parent && !consumed.includes(here)) before = here;
        }
        return { r, parent, before };
      });
      for (const el of consumed) removeTidy(el);
      for (const { r, parent, before } of places) {
        const node = doc.importNode(r, true);
        node.removeAttribute("data-draw-result");
        for (const inner of node.querySelectorAll("[data-draw-result]")) inner.removeAttribute("data-draw-result");
        for (const inner of [node, ...node.querySelectorAll("[id^='draw-anchor']")]) if (inner.id?.startsWith("draw-anchor")) inner.removeAttribute("id");
        freshenIds(node, takenIds(doc));
        if (!node.id) node.setAttribute("id", g.freshId(node.localName, takenIds(doc)));
        if (before) { parent.insertBefore(node, before); const indent = node.previousSibling; if (indent?.nodeType === 3 && /^\s+$/.test(indent.data)) parent.insertBefore(doc.createTextNode(indent.data), before); }
        else appendIndented(parent, node);
        declareNamespaces(doc, node);
        made.push(node);
      }
    });
    select(made);
    setStatus(`${name}: done`);
  } catch (error) {
    setStatus("");
    toast(`${name} failed: ${error.message}`, { ms: 6000 });
  } finally { inkscapeBusy = false; }
}

/** Export the drawing as it is now (unsaved changes too) to PDF or PNG, at the page's size. */
function exportDialog() {
  if (!tab) return;
  const base = tab.path.replace(/\.svg$/i, "");
  let format = "pdf";
  let dpi = 300;
  let textToPath = false;
  const pathInput = h("input.input", { type: "text", value: `${base}.pdf`, "aria-label": "File" });
  const options = h("div.export-options");
  const render = () => {
    pathInput.value = pathInput.value.replace(/\.(pdf|png)$/i, `.${format}`);
    options.replaceChildren(
      h("div.segmented", {}, ...["pdf", "png"].map((f) => h("button", { type: "button", "aria-pressed": String(format === f), onclick: () => { format = f; render(); } }, f.toUpperCase()))),
      format === "png"
        ? h("div.segmented", {}, ...[150, 300, 600].map((d) => h("button", { type: "button", "aria-pressed": String(dpi === d), onclick: () => { dpi = d; render(); } }, `${d} dpi`)))
        : h("label.check", {}, h("input", { type: "checkbox", checked: textToPath, onchange: (e) => { textToPath = e.target.checked; } }), "Text as outlines (prints the same everywhere, but is no longer text)"),
      h("p.hint", {}, format === "png" ? `${Math.round((toUserSize().w / ({ mm: 25.4, cm: 2.54, in: 1, pt: 72, pc: 6 }[tab.unit] ?? 96)) * dpi)} × ${Math.round((toUserSize().h / ({ mm: 25.4, cm: 2.54, in: 1, pt: 72, pc: 6 }[tab.unit] ?? 96)) * dpi)} px` : "Vector PDF at the page's size, fonts embedded."));
  };
  render();
  const close = () => backdrop.remove();
  const go = async () => {
    const out = pathInput.value.trim();
    if (!out) return;
    const exists = await host(`/v1/fs/stat?path=${encodeURIComponent(out)}`).then(() => true, () => false);
    if (exists && !(await ask({ title: `Replace ${nameOf(out)}?`, message: "A file with this name is already there.", ok: "Replace", danger: true }))) return;
    close();
    setStatus(`Exporting ${nameOf(out)} with Inkscape…`, { sticky: true });
    try {
      const result = await host("/v1/draw/export", { method: "POST", body: JSON.stringify({ svg: serialize(tab), source: tab.path, out, format, dpi, textToPath }) });
      setStatus(`Exported ${nameOf(result.path)}`);
      showBar(`Exported ${tilde(result.path)}`, [["Open", () => { hideBar(); void background("open-file", { path: result.path }); }], ["Close", hideBar]]);
    } catch (error) { setStatus(""); toast(`Not exported: ${error.message}`, { ms: 6000 }); }
  };
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) close(); } },
    h("div.dialog.export-drawing", { role: "dialog", "aria-label": "Export" },
      h("h2", {}, "Export"), options,
      h("label.field-wide", {}, h("span", {}, "File"), pathInput),
      h("div.actions", {}, h("button.btn", { type: "button", onclick: close }, "Cancel"), h("span.spacer"), h("button.btn.primary", { type: "button", onclick: () => void go() }, "Export"))));
  backdrop.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); if (e.key === "Enter" && e.target === pathInput) void go(); e.stopPropagation(); });
  document.body.append(backdrop);
  pathInput.focus();
}

/** A PDF page (from a path, or bytes) inserted as an SVG figure, by way of Inkscape. */
async function insertPdf({ path, blob, name }) {
  setStatus(`Reading ${name} with Inkscape…`, { sticky: true });
  try {
    const body = path ? { path } : { base64: (await blobToDataUrl(blob)).replace(/^data:[^,]*,/, "") };
    const { svg } = await host("/v1/draw/import-pdf", { method: "POST", body: JSON.stringify(body) });
    insertSvg(svg, name);
    setStatus(`Inserted ${name} (page 1)`);
  } catch (error) { setStatus(""); toast(`${name}: ${error.message}`, { ms: 6000 }); }
}

function pathSection(items) {
  if (!items.length) return null;
  const op = (operation, title) => h("button.btn", { type: "button", title, disabled: inkscapeBusy || null, onclick: () => void inkscapeOperation(operation) }, OPERATION_LABELS[operation]);
  return h("div", {}, h("h3", {}, "Path"),
    h("div.row-buttons", {},
      ...(items.length > 1 ? [
        op("union", "One outline around everything"), op("difference", "The bottom object minus the top one"),
        op("intersection", "Only where they overlap"), op("exclusion", "Only where they do not overlap"),
        op("division", "Cut the bottom object along the top one"), op("combine", "One path holding them all (Ctrl+K)"),
      ] : []),
      op("break-apart", "Each part of a path on its own (Ctrl+Shift+K)"), op("object-to-path", "Shapes and text become paths (Ctrl+Shift+C)"),
      op("stroke-to-path", "The outline becomes a filled shape (Ctrl+Alt+C)"), op("simplify", "Fewer nodes, about the same shape (Ctrl+L)")),
    h("p.hint", {}, "These run in Inkscape and come back as one undo step."));
}

// ------------------------------------------------------------- structure --

const inDocumentOrder = (items) => [...items].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
const INHERITED = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor", "letter-spacing", "line-height", "color", "visibility"];

/** Move `el` into `parent` (before `before`, else last), keeping its place on the page. */
function reparent(el, parent, before = null) {
  const correction = g.multiply(g.invert(screenCTM(parent)), parentCTM(el));
  const own = ownMatrix(el);
  const original = el.getAttribute("transform");
  removeTidy(el);
  if (!before) appendIndented(parent, el);
  else {
    parent.insertBefore(el, before);
    // Keep each object on its own line: the indentation in front of `before` goes in front of `el` too.
    const indent = el.previousSibling;
    if (indent?.nodeType === 3 && /^\s+$/.test(indent.data) && !["text", "tspan"].includes(parent.localName)) parent.insertBefore(tab.doc.createTextNode(indent.data), before);
  }
  if (!g.isIdentity(correction)) setTransform(el, g.composedTransform(original, correction, own));
}

/** Group the selection where its top object is (Ctrl+G). */
function group() {
  const items = inDocumentOrder(selected());
  if (!items.length) return;
  const top = items.at(-1);
  const parent = top.parentNode;
  let made;
  tab.history.edit(`Group ${items.length}`, () => {
    made = tab.doc.createElementNS(SVG_NS, "g");
    made.setAttribute("id", g.freshId("g", takenIds(tab.doc)));
    top.after(made);
    const indent = top.previousSibling;
    if (indent?.nodeType === 3 && /^\s+$/.test(indent.data)) made.before(tab.doc.createTextNode(indent.data));
    for (const el of items) reparent(el, made);
  });
  select([made]);
}

/** Ungroup the selected groups (Ctrl+Shift+G): their objects take over the group's transform and style. */
function ungroup() {
  const groups = selected().filter(isGroup);
  if (!groups.length) return;
  const clipped = groups.filter((gr) => ["clip-path", "mask", "filter"].some((p) => setsProperty(gr, p)));
  if (clipped.length) { toast(`${label(clipped[0])} is clipped, masked or filtered; ungrouping it would lose that. Enter the group instead (double-click).`, { ms: 5000 }); return; }
  const freed = [];
  tab.history.edit(`Ungroup ${groups.length}`, () => {
    for (const gr of groups) {
      const view = tab.doc.defaultView;
      const opacity = Number(view.getComputedStyle(gr).opacity);
      const own = INHERITED.filter((p) => setsProperty(gr, p)).map((p) => [p, gr.style.getPropertyValue(p) || gr.getAttribute(p)]);
      for (const el of [...gr.children]) {
        if (el.matches("title, desc, metadata")) continue;
        // The group's own style still applies to what it held, unless they set their own.
        for (const [property, value] of own) if (value && !setsProperty(el, property)) setProperty(el, property, value);
        if (opacity < 1) setProperty(el, "opacity", g.fmt(opacity * Number(view.getComputedStyle(el).opacity)));
        reparent(el, gr.parentNode, gr);
        freed.push(el);
      }
      removeTidy(gr);
    }
  });
  select(freed);
}

/** Align the selection's objects to each other (several) or to the page (one, or `toPage`). */
function align(side, { toPage = selected().length < 2 } = {}) {
  const items = selected();
  if (!items.length) return;
  const target = toPage ? { x: 0, y: 0, w: tab.size.w, h: tab.size.h } : unionBox(items);
  if (!target) return;
  tab.history.edit("Align", () => {
    for (const el of items) {
      const b = boxOf(el);
      const dx = { left: target.x - b.x, center: target.x + target.w / 2 - (b.x + b.w / 2), right: target.x + target.w - (b.x + b.w) }[side] ?? 0;
      const dy = { top: target.y - b.y, middle: target.y + target.h / 2 - (b.y + b.h / 2), bottom: target.y + target.h - (b.y + b.h) }[side] ?? 0;
      if (dx || dy) moveBy(capture([el]), dx, dy);
    }
  });
  drawOverlay(); renderProps();
}

/** Equal gaps between three or more objects, along x or y; the outer two stay. */
function distribute(axis) {
  const items = selected();
  if (items.length < 3) return;
  const [pos, size] = axis === "x" ? ["x", "w"] : ["y", "h"];
  const boxes = items.map((el) => ({ el, b: boxOf(el) })).sort((a, b) => a.b[pos] - b.b[pos]);
  const first = boxes[0].b;
  const last = boxes.at(-1).b;
  const gap = (last[pos] + last[size] - first[pos] - boxes.reduce((sum, { b }) => sum + b[size], 0)) / (boxes.length - 1);
  tab.history.edit("Distribute", () => {
    let at = first[pos] + first[size] + gap;
    for (const { el, b } of boxes.slice(1, -1)) {
      const d = at - b[pos];
      if (d) moveBy(capture([el]), axis === "x" ? d : 0, axis === "x" ? 0 : d);
      at += b[size] + gap;
    }
  });
  drawOverlay(); renderProps();
}

// Layers are Inkscape's: groups marked inkscape:groupmode="layer", named by inkscape:label,
// hidden with display:none and locked with sodipodi:insensitive.
const layerHidden = (layer) => tab.doc.defaultView.getComputedStyle(layer).display === "none";
const layerLocked = (layer) => layer.getAttributeNS(SODIPODI_NS, "insensitive") === "true";

function addLayer() {
  const above = currentLayer();
  let layer;
  tab.history.edit("Add layer", () => {
    ensureNamespace(tab.doc, "inkscape", INKSCAPE_NS);
    const taken = takenIds(tab.doc);
    const names = new Set(allLayers().map((l) => l.getAttributeNS(INKSCAPE_NS, "label")));
    let n = allLayers().length + 1;
    while (names.has(`Layer ${n}`)) n++;
    layer = tab.doc.createElementNS(SVG_NS, "g");
    layer.setAttributeNS(INKSCAPE_NS, "inkscape:label", `Layer ${n}`);
    layer.setAttributeNS(INKSCAPE_NS, "inkscape:groupmode", "layer");
    layer.setAttribute("id", g.freshId("layer", taken));
    if (above) { above.after(layer); const indent = above.previousSibling; if (indent?.nodeType === 3 && /^\s+$/.test(indent.data)) above.after(tab.doc.createTextNode(indent.data)); }
    else appendIndented(root(), layer);
  });
  tab.layer = layer;
  select([]);
}

function toggleLayer(layer, what) {
  tab.history.edit(what === "hide" ? "Show or hide layer" : "Lock or unlock layer", () => {
    if (what === "hide") setProperty(layer, "display", layerHidden(layer) ? "inline" : "none");
    else if (layerLocked(layer)) layer.removeAttributeNS(SODIPODI_NS, "insensitive");
    else { ensureNamespace(tab.doc, "sodipodi", SODIPODI_NS); layer.setAttributeNS(SODIPODI_NS, "sodipodi:insensitive", "true"); }
  });
  for (const el of selected()) if (layer.contains(el)) tab.selection.delete(el);
  drawOverlay(); renderProps();
}

async function renameLayer(layer) {
  const name = await ask({ title: "Rename layer", value: layer.getAttributeNS(INKSCAPE_NS, "label") ?? "", ok: "Rename" });
  if (name) tab.history.edit("Rename layer", () => layer.setAttributeNS(INKSCAPE_NS, "inkscape:label", name));
}

async function deleteLayer(layer) {
  const count = layer.querySelectorAll(":scope > *").length;
  if (count && !(await ask({ title: `Delete ${layer.getAttributeNS(INKSCAPE_NS, "label") ?? "this layer"}?`, message: `It holds ${count} ${count === 1 ? "object" : "objects"}; they go too (Ctrl+Z brings them back).`, ok: "Delete", danger: true }))) return;
  tab.history.edit("Delete layer", () => removeTidy(layer));
  if (tab.layer === layer) tab.layer = null;
  select([]);
}

/** Restack a layer among its sibling layers: up is towards the front. */
function moveLayer(layer, direction) {
  const siblings = [...layer.parentNode.children].filter(isLayer);
  const other = siblings[siblings.indexOf(layer) + (direction === "up" ? 1 : -1)];
  if (!other) return;
  tab.history.edit("Move layer", () => { const indent = layer.previousSibling; removeTidy(layer); if (direction === "up") other.after(layer); else other.before(layer); if (indent?.nodeType === 3 && /^\s+$/.test(indent.data)) layer.before(indent); });
  renderProps();
}

/** Move the selection into `layer` (on top of it), keeping it in place on the page. */
function moveToLayer(layer) {
  const items = inDocumentOrder(selected()).filter((el) => el !== layer && !el.contains(layer));
  if (!items.length || !layer) return;
  tab.history.edit("Move to layer", () => { for (const el of items) reparent(el, layer); });
  tab.layer = layer;
  tab.scope = root();
  select(items);
}

function layerStep(direction) {
  const layers = allLayers();
  const at = layers.indexOf(currentLayer());
  const next = layers[at + (direction === "up" ? 1 : -1)];
  if (next && tab.selection.size) moveToLayer(next);
}

// --------------------------------------------------------------- editing --

function deleteSelection() {
  const items = selected();
  if (!items.length) return;
  tab.history.edit(`Delete ${items.length}`, () => { for (const el of items) removeTidy(el); });
  tab.selection.clear();
  drawOverlay(); renderProps();
}

function duplicate() {
  const items = selected();
  if (!items.length) return;
  const taken = takenIds(tab.doc);
  const copies = [];
  tab.history.edit(`Duplicate ${items.length}`, () => {
    for (const el of items) { const copy = copyWithFreshIds(el, taken); el.after(copy); copies.push(copy); }
  });
  select(copies);
}

/** Restack the selection among its siblings: top, bottom, up (one step) or down; its own order stays. */
function arrange(where) {
  const items = selected().sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  if (!items.length) return;
  tab.history.edit("Arrange", () => {
    if (where === "top") for (const el of items) el.parentNode.append(el);
    else if (where === "bottom") for (const el of [...items].reverse()) el.parentNode.insertBefore(el, firstPainted(el.parentNode));
    else if (where === "up") for (const el of [...items].reverse()) { const next = nextPainted(el); if (next && !tab.selection.has(next)) next.after(el); }
    else for (const el of items) { const prev = previousPainted(el); if (prev && !tab.selection.has(prev)) prev.before(el); }
  });
  drawOverlay();
}
const painted = (el) => el && !el.matches(SKIP) && el.localName !== "namedview";
function firstPainted(parent) { let el = parent.firstElementChild; while (el && !painted(el)) el = el.nextElementSibling; return el; }
function nextPainted(el) { let n = el.nextElementSibling; while (n && !painted(n)) n = n.nextElementSibling; return n; }
function previousPainted(el) { let p = el.previousElementSibling; while (p && !painted(p)) p = p.previousElementSibling; return p; }

function nudge(dx, dy) {
  const items = selected();
  if (!items.length) return;
  tab.history.edit("Move", () => moveBy(capture(items), dx, dy));
  drawOverlay(); renderProps();
}

function selectAll() { if (tab) select(selectableChildren()); }

/** Set X, Y, W or H (document units) of the selection's box. */
function setGeometry(key, value) {
  const items = selected();
  const box = unionBox(items);
  if (!box || !Number.isFinite(value)) return;
  const user = toUser(box);
  const ctm = screenCTM(root());
  if (key === "x" || key === "y") {
    const [dx, dy] = g.applyVector(ctm, key === "x" ? [value - user.x, 0] : [0, value - user.y]);
    tab.history.edit("Move", () => moveBy(capture(items), dx, dy));
  } else {
    const s = value / (key === "w" ? user.w : user.h);
    if (!Number.isFinite(s) || s <= 0) return;
    tab.history.edit("Scale", () => transformBy(capture(items), key === "w" ? g.scalingAbout(s, 1, box.x, box.y) : g.scalingAbout(1, s, box.x, box.y)));
  }
  drawOverlay(); renderProps();
}

// ---------------------------------------------------------------- chrome --

let statusTimer;
function setStatus(text, { sticky = false } = {}) {
  ui.status.textContent = text || hintFor(tool);
  clearTimeout(statusTimer);
  if (text && !sticky) statusTimer = setTimeout(() => { ui.status.textContent = hintFor(tool); }, 3000);
}
const hintFor = (id) => ({
  select: "Click to select (Ctrl+click inside groups), drag to move, drag the corners to scale. Double-click a group to enter it.",
  rect: "Drag to draw a rectangle; Ctrl makes a square.",
  ellipse: "Drag to draw an ellipse; Ctrl makes a circle.",
  line: "Drag to draw a line; Ctrl snaps it to 15° steps.",
  text: "Click where the text goes, or click a text to edit it.",
  node: "Click a path to edit its nodes; drag nodes and handles; double-click a segment to add a node.",
  pen: "Click for corners, drag for curves. Enter or double-click ends the path; click the first node to close it.",
  pan: "Drag to move around. Ctrl+wheel zooms.",
  zoom: "Click to zoom in, Shift+click to zoom out, or drag around an area.",
}[id] ?? "");

function setTool(id) {
  if (editing) commitText();
  if (pen && id !== "pen") finishPen(false);
  tool = id;
  ui.viewport.dataset.tool = id;
  renderTools();
  drawOverlay();
  if (tab) renderProps();
  setStatus("");
}

function renderTools() {
  $("#tools").replaceChildren(...TOOLS.map((t) => (t === "-" ? h("span.sep") : iconButton(t.icon, `${t.label} (${t.key.toUpperCase()})`, () => setTool(t.id), { pressed: tool === t.id }))));
}

function renderHistory() {
  const undo = iconButton("undo", "Undo (Ctrl+Z)", () => tab?.history.undo(), { small: true });
  const redo = iconButton("redo", "Redo (Ctrl+Shift+Z)", () => tab?.history.redo(), { small: true });
  undo.disabled = !tab?.history.canUndo;
  redo.disabled = !tab?.history.canRedo;
  $("#history").replaceChildren(undo, redo);
}

function renderChrome() {
  renderTools();
  renderHistory();
  $("#file-actions").replaceChildren(
    iconButton("note_add", "New drawing", () => void newDrawingDialog(), { small: true }),
    iconButton("folder_open", "Open… (Ctrl+O)", () => void openDialog(), { small: true }),
    iconButton("save", "Save (Ctrl+S)", () => void tabs.save(), { small: true }),
    iconButton("photo_library", "Insert an image, SVG or PDF figure (Ctrl+I)", () => tab && void insertDialog(), { small: true }),
    iconButton("download", "Export to PDF or PNG (Ctrl+Shift+E)", exportDialog, { small: true }),
    iconButton("keyboard", "Keyboard shortcuts", showShortcuts, { small: true }),
  );
  $("#doc-info").textContent = tab ? `${g.fmt(toUserSize().w)} × ${g.fmt(toUserSize().h)} ${tab.unit}` : "";
  renderProps();
  setStatus("");
}

const toUserSize = () => {
  const vb = root().viewBox?.baseVal;
  return vb?.width ? { w: vb.width, h: vb.height } : tab.size;
};

function numberField(labelText, value, onCommit) {
  const input = h("input.input.num", { type: "number", step: "any", value: g.fmt(value), "aria-label": labelText, title: labelText });
  input.addEventListener("change", () => onCommit(Number(input.value)));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } e.stopPropagation(); });
  return h("label.field", {}, h("span", {}, labelText), input);
}

// ----------------------------------------------------------------- style --

let fontList = [];
host("/v1/slides/fonts").then(({ fonts }) => { fontList = fonts; }, () => {});

const textsIn = (el) => (el.localName === "text" ? [el] : [...el.querySelectorAll("text")]);

/** What the style panel shows: the first selected object's look (sizes in document units), or the defaults. */
function currentLook(items) {
  const el = items[0];
  if (!el) return { ...tab.style, opacity: 1, textual: tool === "text" };
  const view = tab.doc.defaultView;
  const cs = view.getComputedStyle(el);
  const text = textsIn(el)[0];
  const ts = text ? view.getComputedStyle(text) : null;
  return {
    fill: g.hexColor(cs.fill), stroke: g.hexColor(cs.stroke), strokeWidth: Number.parseFloat(cs.strokeWidth) / unitsPerDocUnit(el),
    opacity: Number(cs.opacity), textual: Boolean(text),
    fontSize: text ? Number.parseFloat(ts.fontSize) / unitsPerDocUnit(text) : null, fontFamily: ts?.fontFamily.replace(/["']/g, "") ?? null,
  };
}

/** Set a style property on the selection (one undo step), or on the defaults for new objects. */
function applyLook(property, value) {
  const items = selected();
  if (!items.length) {
    const key = { fill: tool === "text" ? "textFill" : "fill", stroke: "stroke", "stroke-width": "strokeWidth", "font-size": "fontSize", "font-family": "fontFamily" }[property];
    if (key) tab.style[key] = value;
    renderProps();
    return;
  }
  tab.history.edit(`Set ${property}`, () => {
    for (const el of items) {
      if (property === "stroke-width") setProperty(el, property, g.fmt(value * unitsPerDocUnit(el)));
      else if (property === "opacity") setProperty(el, property, value === 1 ? null : g.fmt(value));
      else if (property === "font-size") for (const text of textsIn(el)) resizeText(text, value);
      else {
        // Colours and fonts: on the object and wherever inside it sets its own.
        const v = value === null ? "none" : property === "font-family" ? fontValue(value) : value;
        setProperty(el, property, v);
        for (const inner of el.querySelectorAll("*")) if (setsProperty(inner, property)) setProperty(inner, property, v);
      }
    }
  });
}

/** A new font size (document units) for a text, its lines spaced to match. */
function resizeText(text, size) {
  const old = Number.parseFloat(tab.doc.defaultView.getComputedStyle(text).fontSize);
  const next = size * unitsPerDocUnit(text);
  setProperty(text, "font-size", g.fmt(next));
  for (const span of text.querySelectorAll("tspan")) if (setsProperty(span, "font-size")) setProperty(span, "font-size", g.fmt(next));
  const lines = textLines(text).map((l) => l.node).filter((n) => n !== text && n.hasAttribute("y"));
  const y0 = Number.parseFloat(lines[0]?.getAttribute("y"));
  for (const line of lines.slice(1)) line.setAttribute("y", g.fmt(y0 + (Number.parseFloat(line.getAttribute("y")) - y0) * (next / old)));
}

function paintControl(labelText, value, onPick) {
  const input = h("input", { type: "color", value: value ?? "#000000", title: labelText, "aria-label": labelText });
  input.addEventListener("change", () => onPick(input.value));
  return h("div.paint-row", {}, h("span.name", {}, labelText), input, h("span.hex", {}, value ?? "none"),
    h("button.btn.toggle", { type: "button", "aria-pressed": String(value === null), title: value === null ? `Give it a ${labelText.toLowerCase()}` : `No ${labelText.toLowerCase()}`, onclick: () => onPick(value === null ? input.value : null) }, "None"));
}

function labeledNumber(labelText, value, onCommit, suffix = tab.unit) {
  const input = h("input.input.num", { type: "number", step: "any", min: 0, value: g.fmt(value ?? 0), "aria-label": labelText, title: labelText });
  input.addEventListener("change", () => { const v = Number(input.value); if (Number.isFinite(v) && v >= 0) onCommit(v); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } e.stopPropagation(); });
  return h("label.field-row", {}, h("span.name", {}, labelText), input, h("span.unit", {}, suffix));
}

function fontField(value, onCommit) {
  const input = h("input.input", { type: "text", value: value ?? "", list: "draw-fonts", "aria-label": "Font", title: "Font" });
  input.addEventListener("change", () => { if (input.value.trim()) onCommit(input.value.trim()); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } e.stopPropagation(); });
  return h("label.field-row.font", {}, h("span.name", {}, "Font"), input, h("datalist", { id: "draw-fonts" }, ...fontList.map((f) => h("option", { value: f }))));
}

function styleSection(items) {
  const creating = !items.length && (SHAPES.has(tool) || tool === "text" || tool === "pen");
  if (!items.length && !creating) return null;
  const look = currentLook(items);
  const textual = items.length ? look.textual : tool === "text";
  const opacity = h("input", { type: "range", min: 0, max: 100, value: Math.round(look.opacity * 100), "aria-label": "Opacity", title: "Opacity" });
  opacity.addEventListener("change", () => applyLook("opacity", Number(opacity.value) / 100));
  return h("div", {}, h("h3", {}, items.length ? "Style" : `New ${tool === "text" ? "text" : "shapes"}`),
    paintControl(textual && !items.length ? "Colour" : "Fill", textual && !items.length ? tab.style.textFill : look.fill, (v) => applyLook("fill", v)),
    textual && !items.length ? null : paintControl("Stroke", look.stroke, (v) => applyLook("stroke", v)),
    textual && !items.length ? null : labeledNumber("Stroke width", look.strokeWidth, (v) => applyLook("stroke-width", v)),
    textual ? labeledNumber("Font size", look.fontSize ?? tab.style.fontSize, (v) => applyLook("font-size", v)) : null,
    textual ? fontField(look.fontFamily ?? tab.style.fontFamily, (v) => applyLook("font-family", v)) : null,
    items.length ? h("label.field-row", {}, h("span.name", {}, "Opacity"), opacity, h("span.unit", {}, `${Math.round(look.opacity * 100)}%`)) : null);
}

function alignSection(items) {
  const toPage = items.length < 2 || tab.alignTo === "page";
  const button = (name, title, run) => iconButton(name, title, run, { small: true });
  return h("div", {}, h("h3", {}, "Align"),
    items.length > 1 ? h("div.segmented.align-to", {}, ...[["selection", "To each other"], ["page", "To the page"]].map(([value, text]) => h("button", {
      type: "button", "aria-pressed": String((tab.alignTo ?? "selection") === value), onclick: () => { tab.alignTo = value; renderProps(); },
    }, text))) : h("p.hint.align-note", {}, "One object aligns to the page."),
    h("div.icon-row", {},
      button("align_horizontal_left", "Left edges", () => align("left", { toPage })),
      button("align_horizontal_center", "Centres, horizontally", () => align("center", { toPage })),
      button("align_horizontal_right", "Right edges", () => align("right", { toPage })),
      button("align_vertical_top", "Top edges", () => align("top", { toPage })),
      button("align_vertical_center", "Centres, vertically", () => align("middle", { toPage })),
      button("align_vertical_bottom", "Bottom edges", () => align("bottom", { toPage }))),
    items.length > 2 ? h("div.icon-row", {},
      button("horizontal_distribute", "Equal gaps across", () => distribute("x")),
      button("vertical_distribute", "Equal gaps down", () => distribute("y"))) : null);
}

function layersSection() {
  const layers = allLayers();
  const current = currentLayer();
  const rows = [...layers].reverse().map((layer) => {
    const depth = [...allLayers()].filter((l) => l !== layer && l.contains(layer)).length;
    const hidden = layerHidden(layer);
    const lockedLayer = layerLocked(layer);
    const name = layer.getAttributeNS(INKSCAPE_NS, "label") || layer.id;
    const row = h(`div.layer${layer === current ? ".current" : ""}`, {
      style: { paddingLeft: `${6 + depth * 14}px` }, title: "Click: new objects go here. Right-click for more.", "data-agent": `Layer ${name}`,
      onclick: () => { tab.layer = layer; tab.scope = root(); select([]); },
      ondblclick: () => void renameLayer(layer),
    },
    iconButton(hidden ? "visibility_off" : "visibility", hidden ? "Show" : "Hide", (e) => { e.stopPropagation(); toggleLayer(layer, "hide"); }, { small: true }),
    iconButton(lockedLayer ? "lock" : "lock_open", lockedLayer ? "Unlock" : "Lock", (e) => { e.stopPropagation(); toggleLayer(layer, "lock"); }, { small: true }),
    h("span.layer-name", {}, name));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      contextMenu(event, [
        ...(tab.selection.size ? [{ label: "Move the selection here", icon: "move_down", run: () => moveToLayer(layer) }] : []),
        { label: "Rename", icon: "edit", run: () => void renameLayer(layer) },
        { label: "Raise", icon: "keyboard_arrow_up", run: () => moveLayer(layer, "up") },
        { label: "Lower", icon: "keyboard_arrow_down", run: () => moveLayer(layer, "down") },
        "-",
        { label: "Delete layer", icon: "delete", run: () => void deleteLayer(layer) },
      ]);
    });
    return row;
  });
  return h("div", {}, h("div.section-head", {}, h("h3", {}, "Layers"), iconButton("add", "New layer above the current one", addLayer, { small: true })),
    rows.length ? h("div.layers", {}, ...rows) : h("p.hint", {}, "No layers: everything is on the page itself. Add one to keep parts apart, as in Inkscape."),
    rows.length && tab.selection.size ? h("p.hint", {}, "Shift+Page Up / Down moves the selection to the layer above / below.") : null);
}

function renderProps() {
  if (!tab) { ui.props.replaceChildren(); return; }
  const items = selected();
  const sections = [];
  // Where the edits go: the document, a layer or a group being edited.
  const trail = [];
  for (let node = tab.scope; node && node !== tab.doc; node = node.parentNode) trail.unshift(node);
  sections.push(h("div", {}, h("h3", {}, "Editing"), h("div.trail", {}, ...trail.map((node, i) => h("button.crumb", {
    type: "button", disabled: i === trail.length - 1, title: i ? `Leave to ${label(node)}` : "The whole drawing",
    onclick: () => { tab.scope = node; select([]); },
  }, i ? label(node) : "Drawing")))));

  if (items.length) {
    const box = unionBox(items);
    const user = box ? toUser(box) : null;
    const one = items.length === 1 ? items[0] : null;
    sections.push(h("div", {},
      h("h3", {}, one ? `${one.localName}${one.id ? ` · ${one.id}` : ""}` : `${items.length} objects`),
      one?.getAttributeNS(INKSCAPE_NS, "label") ? h("p.hint", {}, one.getAttributeNS(INKSCAPE_NS, "label")) : null,
      user ? h("div.geometry", {},
        numberField("X", user.x, (v) => setGeometry("x", v)), numberField("Y", user.y, (v) => setGeometry("y", v)),
        numberField("W", user.w, (v) => setGeometry("w", v)), numberField("H", user.h, (v) => setGeometry("h", v))) : null,
      user ? h("p.hint", {}, `In ${tab.unit}, from the page's top left corner.`) : null));
    sections.push(styleSection(items));
    sections.push(h("div", {}, h("h3", {}, "Arrange"), h("div.row-buttons", {},
      h("button.btn", { type: "button", title: "Raise to top (Home)", onclick: () => arrange("top") }, icon("flip_to_front", { size: 16 }), "Top"),
      h("button.btn", { type: "button", title: "Raise one step (Page Up)", onclick: () => arrange("up") }, icon("keyboard_arrow_up", { size: 16 }), "Up"),
      h("button.btn", { type: "button", title: "Lower one step (Page Down)", onclick: () => arrange("down") }, icon("keyboard_arrow_down", { size: 16 }), "Down"),
      h("button.btn", { type: "button", title: "Lower to bottom (End)", onclick: () => arrange("bottom") }, icon("flip_to_back", { size: 16 }), "Bottom"),
      h("button.btn", { type: "button", title: "Duplicate (Ctrl+D)", onclick: duplicate }, icon("content_copy", { size: 16 }), "Duplicate"),
      h("button.btn", { type: "button", title: "Delete (Del)", onclick: deleteSelection }, icon("delete", { size: 16 }), "Delete"),
      h("button.btn", { type: "button", title: "Group (Ctrl+G)", onclick: group }, icon("ad_group", { size: 16 }), "Group"),
      items.some(isGroup) ? h("button.btn", { type: "button", title: "Ungroup (Ctrl+Shift+G)", onclick: ungroup }, icon("ungroup", { size: 16 }), "Ungroup") : null,
      one && isGroup(one) ? h("button.btn", { type: "button", title: "Edit inside this group (double-click)", onclick: () => enterGroup(one) }, icon("layers", { size: 16 }), "Enter group") : null)));
    sections.push(alignSection(items));
    sections.push(pathSection(items));
    sections.splice(2, 0, nodesSection(items));
  } else {
    const size = toUserSize();
    sections.push(nodesSection(items));
    sections.push(styleSection(items));
    sections.push(h("div", {}, h("h3", {}, "Page"),
      h("p.hint", {}, `${g.fmt(size.w)} × ${g.fmt(size.h)} ${tab.unit}`),
      h("p.hint", { title: tab.path }, tilde(tab.path))));
  }
  if (tab.scope === root()) sections.push(layersSection());
  ui.props.replaceChildren(...sections.filter(Boolean));
}

function renderZoom() {
  $("#zoom-controls").replaceChildren(
    iconButton("zoom_out", "Zoom out (−)", () => zoomCenter(1 / 1.25), { small: true }),
    h("span.zoom", { title: "Zoom" }, tab?.view ? `${Math.round(tab.view.scale * 100)}%` : ""),
    iconButton("zoom_in", "Zoom in (+)", () => zoomCenter(1.25), { small: true }),
    iconButton("fit_screen", "Fit the page (5)", fit, { small: true }),
  );
}

function showShortcuts() {
  const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog.shortcuts", { role: "dialog", "aria-label": "Keyboard shortcuts" },
      h("h2", {}, "Keyboard shortcuts"),
      h("dl", {}, ...SHORTCUTS.flatMap(([keys, what]) => [h("dt", {}, keys), h("dd", {}, what)])),
      h("div.actions", {}, h("button.btn.primary", { type: "button", onclick: () => backdrop.remove() }, "Close"))));
  document.body.append(backdrop);
  backdrop.querySelector(".btn").focus();
}

// ------------------------------------------------------- start and new --

async function recent() {
  const stored = await browser.storage.local.get(RECENT_KEY).catch(() => ({}));
  return stored[RECENT_KEY] ?? [];
}
async function remember(path) {
  const list = [path, ...(await recent()).filter((p) => p !== path)].slice(0, 10);
  await browser.storage.local.set({ [RECENT_KEY]: list }).catch(() => {});
}

async function showStart() {
  tab = null;
  ui.app.hidden = true;
  ui.start.hidden = false;
  document.title = "Draw";
  const list = await recent();
  ui.start.replaceChildren(h("div.inner", {},
    h("h2", {}, icon("shape_line"), "Drawings"),
    h("p", {}, "Posters, figures and diagrams as SVG files, edited by hand with the agent beside you. Files stay plain SVG: Inkscape opens them as they are, layers and all."),
    h("div.buttons", {},
      h("button.btn.primary", { type: "button", onclick: () => void newDrawingDialog() }, icon("note_add", { size: 18 }), "New drawing"),
      h("button.btn", { type: "button", onclick: () => void openDialog() }, icon("folder_open", { size: 18 }), "Open…")),
    ...(list.length ? [h("h3", {}, "Recent"), h("div.recent", {}, ...list.map((path) => h("button", { type: "button", onclick: () => void openFile(path) },
      icon("shape_line"), h("div", { style: { minWidth: 0 } }, h("div.name", {}, nameOf(path)), h("div.path", {}, tilde(dirOf(path)))))))] : []),
  ));
  return { opened: null };
}

async function openDialog() {
  const path = await ask({ title: "Open a drawing", message: "Path of an SVG file", value: tab ? `${dirOf(tab.path)}/` : "~/", ok: "Open" });
  if (path) await openFile(path);
}

/** Pick a page size and where the file goes; the new drawing opens in a tab. */
function newDrawingDialog() {
  return new Promise((resolve) => {
    let size = g.PAGE_SIZES[0];
    let landscape = false;
    const pathInput = h("input.input", { type: "text", value: `~/Documents/${tab ? "drawing" : "poster"}.svg`, "aria-label": "File" });
    const sizes = h("div.sizes", { role: "radiogroup" });
    const orientation = h("div.segmented", {});
    const render = () => {
      sizes.replaceChildren(...g.PAGE_SIZES.map((s) => h("button.size", { type: "button", role: "radio", "aria-checked": String(s === size), onclick: () => { size = s; landscape = s.w > s.h; render(); } },
        h("strong", {}, s.label), h("span", {}, `${s.w} × ${s.h} ${s.unit}`))));
      orientation.replaceChildren(...[["Portrait", false], ["Landscape", true]].map(([text, value]) => h("button", { type: "button", "aria-pressed": String(landscape === value), onclick: () => { landscape = value; render(); } }, text)));
    };
    render();
    const close = (value) => { backdrop.remove(); resolve(value); };
    const create = async () => {
      let path = pathInput.value.trim();
      if (!path) return;
      if (!/\.svg$/i.test(path)) path += ".svg";
      try {
        const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path, text: g.blankDrawing({ ...size, landscape }), expect: "absent", createDirs: true }) });
        close(result.path);
        await openFile(result.path);
      } catch (error) { toast(error.status === 409 ? `${nameOf(path)} already exists` : error.message); }
    };
    const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) close(null); } },
      h("div.dialog.new-drawing", { role: "dialog", "aria-label": "New drawing" },
        h("h2", {}, "New drawing"), sizes, h("div.row", {}, orientation),
        h("label.field-wide", {}, h("span", {}, "File"), pathInput),
        h("div.actions", {}, h("button.btn", { type: "button", onclick: () => close(null) }, "Cancel"), h("span.spacer"),
          h("button.btn.primary", { type: "button", onclick: () => void create() }, "Create"))));
    backdrop.addEventListener("keydown", (e) => { if (e.key === "Escape") close(null); if (e.key === "Enter") void create(); e.stopPropagation(); });
    document.body.append(backdrop);
    pathInput.focus();
    pathInput.setSelectionRange(Math.max(pathInput.value.lastIndexOf("/"), pathInput.value.lastIndexOf("\\")) + 1, pathInput.value.length - 4);
  });
}

// ------------------------------------------------------------- keyboard --

addEventListener("keydown", (event) => {
  if (event.target.closest?.("input, textarea, select, .dialog")) return;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  const take = () => { event.preventDefault(); event.stopPropagation(); };
  if (mod) {
    const actions = {
      z: () => (event.shiftKey ? tab?.history.redo() : tab?.history.undo()), y: () => tab?.history.redo(),
      s: () => (event.shiftKey ? save(tab, { as: true }) : tabs.save()), o: openDialog,
      a: () => (tool === "node" && nodes ? selectAllNodes() : selectAll()), d: duplicate, 0: fit, i: insertDialog, g: () => (event.shiftKey ? ungroup() : group()),
      c: () => (event.altKey ? inkscapeOperation("stroke-to-path") : event.shiftKey ? inkscapeOperation("object-to-path") : copySelection()),
      x: () => copySelection({ cut: true }), v: paste,
      k: () => inkscapeOperation(event.shiftKey ? "break-apart" : "combine"), l: () => inkscapeOperation("simplify"),
      e: () => (event.shiftKey ? exportDialog() : undefined), "=": () => zoomCenter(1.25), "+": () => zoomCenter(1.25), "-": () => zoomCenter(1 / 1.25),
    };
    const action = actions[key];
    if (action && (tab || key === "o")) { take(); void action(); }
    return;
  }
  if (!tab || event.altKey) return;
  if (key === " ") { if (!spaceDown) { spaceDown = true; ui.viewport.classList.add("panning"); } take(); return; }
  const step = event.shiftKey ? 10 : 1;
  const arrows = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
  if (arrows[key]) { if (tab.selection.size) { take(); nudge(...arrows[key]); } return; }
  if (event.shiftKey && (key === "pageup" || key === "pagedown")) { take(); layerStep(key === "pageup" ? "up" : "down"); return; }
  if (pen) {
    const penKeys = { enter: () => finishPen(false), escape: () => { pen = null; drawOverlay(); }, backspace: () => { pen.nodes.pop(); if (!pen.nodes.length) pen = null; drawOverlay(); } };
    if (penKeys[key]) { take(); penKeys[key](); return; }
  }
  if (tool === "node" && nodes?.selected.size && (key === "delete" || key === "backspace" || key === "escape")) {
    take();
    if (key === "escape") { nodes.selected.clear(); drawOverlay(); renderProps(); } else deleteNodes();
    return;
  }
  const simple = {
    delete: deleteSelection, backspace: deleteSelection,
    escape: () => { if (tab.selection.size) select([]); else leaveGroup(); },
    home: () => arrange("top"), end: () => arrange("bottom"), pageup: () => arrange("up"), pagedown: () => arrange("down"),
    "+": () => zoomCenter(1.25), "=": () => zoomCenter(1.25), "-": () => zoomCenter(1 / 1.25), 5: fit, 1: () => zoomTo(1),
  };
  if (simple[key]) { take(); simple[key](); return; }
  const found = TOOLS.find((t) => t !== "-" && t.key === key);
  if (found) { take(); setTool(found.id); }
}, true);
addEventListener("keyup", (event) => { if (event.key === " ") { spaceDown = false; ui.viewport.classList.remove("panning"); } });
// A drag that ends outside the window still ends.
addEventListener("blur", () => { spaceDown = false; ui.viewport.classList.remove("panning"); });

// ------------------------------------------------------------- agent API --


const SHOTS = "~/.cache/mail-workspace/draw-shots";
const round = (v) => Number(g.fmt(v));
const userBox = (el) => { const b = unionBox([el]); return b ? Object.fromEntries(Object.entries(toUser(b)).map(([k, v]) => [k, round(v)])) : null; };

/** An element or layer by id, or a layer by its name. */
function target(ref) {
  if (!tab) throw new Error("No drawing is open in Draw");
  if (ref === undefined || ref === null || ref === "") return null;
  const el = tab.doc.getElementById(ref) ?? allLayers().find((l) => l.getAttributeNS(INKSCAPE_NS, "label") === ref);
  if (!el) throw new Error(`Nothing has the id or layer name "${ref}"`);
  return el;
}
const targets = (ids) => (Array.isArray(ids) ? ids : [ids]).map(target);

/** What one element is, for the agent: id, tag, label, box (document units), text, colours. */
function outline(el, depth, budget) {
  if (budget.left-- <= 0) { budget.truncated = true; return null; }
  const view = tab.doc.defaultView;
  const item = { id: el.id || undefined, tag: el.localName };
  const name = el.getAttributeNS(INKSCAPE_NS, "label");
  if (name) item.label = name;
  if (isLayer(el)) Object.assign(item, { layer: true, hidden: layerHidden(el) || undefined, locked: layerLocked(el) || undefined });
  const box = el.localName === "svg" ? null : userBox(el);
  if (box) item.box = box;
  if (el.localName === "text") item.text = textLines(el).map((l) => l.text).join("\n");
  if (["rect", "circle", "ellipse", "path", "line", "polyline", "polygon", "text"].includes(el.localName)) {
    const cs = view.getComputedStyle(el);
    const fill = g.hexColor(cs.fill);
    const stroke = g.hexColor(cs.stroke);
    if (fill) item.fill = fill;
    if (stroke) item.stroke = stroke;
    if (el.localName === "text") { item.fontSize = round(Number.parseFloat(cs.fontSize) / unitsPerDocUnit(el)); item.font = cs.fontFamily.replace(/["']/g, ""); }
  }
  if (el.localName === "image") {
    const href = el.getAttributeNS(XLINK_NS, "href") ?? el.getAttribute("href") ?? "";
    item.image = href.startsWith("data:") ? `embedded ${href.slice(5, href.indexOf(";"))}, ${Math.round((href.length * 0.75) / 1024)} KB` : href;
  }
  const kids = [...el.children].filter((c) => !c.matches(SKIP) && c.localName !== "namedview" && c.localName !== "tspan");
  if (kids.length && el.localName !== "text") {
    if (depth > 0) item.children = kids.map((c) => outline(c, depth - 1, budget)).filter(Boolean);
    else item.count = kids.length;
  }
  return item;
}

/** An element's markup, embedded images shortened. */
function markup(el, limit = 20000) {
  const text = new XMLSerializer().serializeToString(el)
    .replace(/(data:[\w/+.-]+;base64,)[A-Za-z0-9+/=\s]{200,}/g, (m, head) => `${head}…(${Math.round((m.length * 0.75) / 1024)} KB)`)
    .replace(/ xmlns(:\w+)?="[^"]*"/g, "");
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit} more characters)` : text;
}

/** Document units → frame px (a move). */
const docVector = (dx, dy) => g.applyVector(screenCTM(root()), [dx, dy]);

/** Parse an SVG fragment ("<rect …/>", several elements) into nodes of this document. */
function fragment(svg) {
  const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:inkscape="${INKSCAPE_NS}" xmlns:sodipodi="${SODIPODI_NS}">${svg}</svg>`, "image/svg+xml");
  if (parsed.documentElement.localName !== "svg") throw new Error(`The SVG does not parse: ${parsed.documentElement.textContent.split("\n")[0]}`);
  return [...parsed.documentElement.children].map((node) => tab.doc.importNode(node, true));
}

const setAttr = (el, name, value) => {
  const prefix = name.includes(":") ? name.split(":")[0] : null;
  const ns = prefix ? ({ xlink: XLINK_NS, inkscape: INKSCAPE_NS, sodipodi: SODIPODI_NS, xml: XML_NS }[prefix] ?? root().lookupNamespaceURI(prefix)) : null;
  if (prefix && !ns) throw new Error(`Unknown prefix in ${name}`);
  if (prefix && prefix !== "xml") ensureNamespace(tab.doc, prefix, ns);
  if (value === null || value === undefined) { if (ns) el.removeAttributeNS(ns, name.split(":")[1]); else el.removeAttribute(name); }
  else if (ns) el.setAttributeNS(ns, name, String(value)); else el.setAttribute(name, String(value));
};

/** The agent's edits, one op at a time (draw_apply). Returns what each op made or changed. */
const OPS = {
  async add({ svg, parent, before }) {
    const into = parent ? target(parent) : insertionParent();
    const anchor = before ? target(before) : null;
    const made = [];
    for (const node of fragment(svg)) {
      freshenIds(node, takenIds(tab.doc));
      if (!node.id) node.setAttribute("id", g.freshId(node.localName, takenIds(tab.doc)));
      if (anchor) { into.insertBefore(node, anchor); const indent = node.previousSibling; if (indent?.nodeType === 3 && /^\s+$/.test(indent.data)) into.insertBefore(tab.doc.createTextNode(indent.data), anchor); }
      else appendIndented(into, node);
      declareNamespaces(tab.doc, node);
      made.push(node.id);
    }
    return { added: made };
  },
  set({ id, ids, attrs = {} }) { for (const el of targets(ids ?? id)) for (const [name, value] of Object.entries(attrs)) setAttr(el, name, value); return { set: Object.keys(attrs) }; },
  style({ id, ids, props = {} }) {
    for (const el of targets(ids ?? id)) for (const [name, value] of Object.entries(props)) setProperty(el, name, value === null ? null : String(value));
    return { styled: Object.keys(props) };
  },
  text({ id, text }) {
    const el = target(id);
    if (el.localName !== "text") throw new Error(`${id} is a ${el.localName}, not a text`);
    const lines = String(text).split("\n");
    const old = textLines(el).map((l) => Number.parseFloat(l.node.getAttribute("y")));
    const size = Number.parseFloat(tab.doc.defaultView.getComputedStyle(el).fontSize);
    setTextLines(el, lines, { lineHeight: old.length > 1 && Number.isFinite(old[1] - old[0]) ? old.at(-1) - old.at(-2) : size * 1.25, taken: takenIds(tab.doc) });
    return { lines: lines.length };
  },
  move({ id, ids, dx = 0, dy = 0 }) { const [fx, fy] = docVector(dx, dy); moveBy(capture(targets(ids ?? id)), fx, fy); return {}; },
  place({ id, ids, x, y, w, h }) {
    const els = targets(ids ?? id);
    select(els);
    for (const [key, value] of Object.entries({ w, h, x, y })) if (value !== undefined) setGeometry(key, Number(value));
    return { box: userBox(els[0]) };
  },
  delete({ id, ids }) { const els = targets(ids ?? id); for (const el of els) removeTidy(el); tab.selection.clear(); return { deleted: els.length }; },
  group({ ids }) { select(targets(ids)); group(); return { group: selected()[0]?.id }; },
  ungroup({ id, ids }) { select(targets(ids ?? id)); ungroup(); return { freed: selected().map((el) => el.id) }; },
  order({ id, ids, to }) { select(targets(ids ?? id)); arrange(to); return {}; },
  align({ ids, side, to = "selection" }) { select(targets(ids)); align(side, { toPage: to === "page" || ids.length < 2 }); return {}; },
  distribute({ ids, axis = "x" }) { select(targets(ids)); distribute(axis); return {}; },
  layer({ action, layer, name }) {
    if (action === "add") { addLayer(); const made = tab.layer; if (name) made.setAttributeNS(INKSCAPE_NS, "inkscape:label", name); return { layer: made.id }; }
    const el = target(layer);
    if (!isLayer(el)) throw new Error(`${layer} is not a layer`);
    if (action === "rename") el.setAttributeNS(INKSCAPE_NS, "inkscape:label", name);
    else if (action === "hide" || action === "show") { if (layerHidden(el) !== (action === "hide")) toggleLayer(el, "hide"); }
    else if (action === "lock" || action === "unlock") { if (layerLocked(el) !== (action === "lock")) toggleLayer(el, "lock"); }
    else if (action === "delete") removeTidy(el);
    else if (action === "current") tab.layer = el;
    else throw new Error("layer action is add, rename, hide, show, lock, unlock, delete or current");
    return { layer: el.id };
  },
  to_layer({ ids, layer }) { const el = target(layer); if (!isLayer(el)) throw new Error(`${layer} is not a layer`); select(targets(ids)); moveToLayer(el); return {}; },
  async insert({ path, x, y, w, parent }) {
    if (parent) { tab.scope = target(parent); }
    const before = new Set(takenIds(tab.doc));
    const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`);
    if (/\.pdf$/i.test(info.path)) await insertPdf({ path: info.path, name: nameOf(info.path) });
    else {
      const { url } = await host("/v1/links", { method: "POST", body: JSON.stringify({ path: info.path }) });
      const blob = await (await fetch(`${HOST_ENDPOINT}${url}`)).blob();
      await insertFiles([new File([blob], nameOf(info.path), { type: blob.type })]);
    }
    tab.scope = root();
    const made = selected().filter((el) => !before.has(el.id));
    if (!made.length) throw new Error(`${nameOf(info.path)} could not be inserted`);
    select(made);
    // A width scales it in proportion; x and y place its top left corner.
    if (w !== undefined) { const box = toUser(unionBox(made)); setGeometry("w", Number(w)); setGeometry("h", (box.h * Number(w)) / box.w); }
    if (x !== undefined) setGeometry("x", Number(x));
    if (y !== undefined) setGeometry("y", Number(y));
    return { inserted: made.map((el) => el.id), box: userBox(made[0]) };
  },
  async path({ operation, ids }) {
    if (!OPERATION_LABELS[operation]) throw new Error(`operation is one of ${Object.keys(OPERATION_LABELS).join(", ")}`);
    select(targets(ids));
    await inkscapeOperation(operation);
    return { result: selected().map((el) => el.id) };
  },
};

/** Run the agent's ops as one undo step; a drawing without unsaved changes of the user's is saved at once. */
async function applyOps(ops) {
  if (!tab) throw new Error("No drawing is open in Draw");
  const t = tab;
  const userChanges = t.history.modified;
  const results = [];
  t.history.begin("Agent edit");
  try {
    for (const [i, op] of ops.entries()) {
      const run = OPS[op.op];
      if (!run) throw new Error(`Op ${i}: unknown op "${op.op}" (${Object.keys(OPS).join(", ")})`);
      try { results.push({ op: op.op, ...(await run(op)) }); }
      catch (error) { throw new Error(`Op ${i} (${op.op}): ${error.message}`); }
    }
  } catch (error) {
    // Nothing half done stays: what the ops changed so far is undone (and not offered for redo).
    if (t.history.finish()) { t.history.undo(); t.history.undone.pop(); }
    drawOverlay(); renderProps();
    throw error;
  }
  t.history.finish();
  drawOverlay(); renderProps();
  let saved = false;
  if (!userChanges && t.history.modified) saved = await save(t);
  return { results, saved, ...(userChanges ? { note: "The user has unsaved changes; your edit joined them, unsaved. Tell them." } : {}) };
}

/** A PNG of the page, an element or a region (document units), written to the shots folder. */
async function shot({ id, region, scale = 1 }) {
  if (!tab) throw new Error("No drawing is open in Draw");
  const url = URL.createObjectURL(new Blob([serialize(tab)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let area = { x: 0, y: 0, w: tab.size.w, h: tab.size.h };
    if (id) { const b = unionBox([target(id)]); if (!b) throw new Error(`${id} has no size`); const pad = Math.max(b.w, b.h) * 0.04; area = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }; }
    else if (region) {
      const ctm = screenCTM(root());
      const [x, y] = g.apply(ctm, [region.x, region.y]);
      const [w, hh] = g.applyVector(ctm, [region.w, region.h]);
      area = { x, y, w, h: hh };
    }
    const k = Math.min(scale, 4096 / area.w, 4096 / area.h, 32);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(area.w * k));
    canvas.height = Math.max(1, Math.round(area.h * k));
    const c = canvas.getContext("2d");
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, -area.x * k, -area.y * k, tab.size.w * k, tab.size.h * k);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const path = `${SHOTS}/${Date.now()}.png`;
    const written = await host(`/v1/fs/raw?${new URLSearchParams({ path, createDirs: "1" })}`, { method: "PUT", body: blob });
    return { path: written.path, width: canvas.width, height: canvas.height };
  } finally { URL.revokeObjectURL(url); }
}

const describe = (el) => ({ id: el.id || null, tag: el.localName, label: el.getAttributeNS(INKSCAPE_NS, "label") || undefined, box: userBox(el) });

registerPage("draw", {
  state: () => ({
    path: tab?.path ?? null,
    modified: Boolean(tab?.history.modified),
    tabs: tabs.tabs.map((t) => ({ path: t.path, title: t.title, modified: t.dirty, active: t === tab })),
    tool,
    unit: tab?.unit,
    page: tab ? toUserSize() : null,
    zoom: tab?.view ? Math.round(tab.view.scale * 1000) / 1000 : null,
    layers: tab ? allLayers().map((l) => ({ id: l.id, name: l.getAttributeNS(INKSCAPE_NS, "label") || undefined, hidden: layerHidden(l) || undefined, locked: layerLocked(l) || undefined, current: l === currentLayer() || undefined })) : [],
    editing: tab && tab.scope !== root() ? describe(tab.scope) : null,
    selected: selected().slice(0, 100).map(describe),
    nodes: nodes ? { path: nodes.el.id, selected: [...nodes.selected] } : undefined,
  }),
  commands: {
    open: ({ path, query }) => openFile(path ?? query),
    new: async ({ path, size = "a0", landscape }) => {
      const page = g.PAGE_SIZES.find((p) => p.id === size) ?? g.PAGE_SIZES[0];
      const file = /\.svg$/i.test(path) ? path : `${path}.svg`;
      const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: file, text: g.blankDrawing({ ...page, landscape: landscape ?? page.w > page.h }), expect: "absent", createDirs: true }) });
      await openFile(result.path);
      return { path: result.path, page: toUserSize(), unit: tab.unit };
    },
    save: async () => ({ saved: tab ? await tabs.save() : false }),
    read: ({ id, depth = 2, limit = 400, markup: asMarkup = false }) => {
      const el = id ? target(id) : root();
      if (asMarkup) return { id, svg: markup(el) };
      const budget = { left: limit, truncated: false };
      return { path: tab.path, unit: tab.unit, page: toUserSize(), tree: outline(el, depth, budget), ...(budget.truncated ? { truncated: `Only ${limit} elements shown; read deeper parts by id` } : {}) };
    },
    apply: ({ ops }) => applyOps(ops),
    shot: (args) => shot(args),
    export: async ({ format = "pdf", out, dpi, textToPath }) => {
      if (!tab) throw new Error("No drawing is open in Draw");
      const file = out ?? tab.path.replace(/\.svg$/i, `.${format}`);
      return host("/v1/draw/export", { method: "POST", body: JSON.stringify({ svg: serialize(tab), source: tab.path, out: file, format, dpi, textToPath }) });
    },
    select: ({ ids = [] }) => {
      if (!tab) throw new Error("No drawing is open");
      const found = ids.map((id) => tab.doc.getElementById(id)).filter(Boolean);
      select(found);
      if (found.length) { const box = unionBox(found); if (box) zoomToBox({ x: box.x - box.w * 0.25, y: box.y - box.h * 0.25, w: box.w * 1.5, h: box.h * 1.5 }); }
      return { selected: found.map(describe), missing: ids.filter((id) => !tab.doc.getElementById(id)) };
    },
    zoom: ({ fit: what = "page", ids, scale }) => {
      if (!tab) throw new Error("No drawing is open");
      if (scale) zoomTo(scale);
      else if (what === "selection" || ids) { const box = unionBox(ids ? ids.map((id) => tab.doc.getElementById(id)).filter(Boolean) : selected()); if (box) zoomToBox(box); }
      else fit();
      return { zoom: tab.view.scale };
    },
  },
});

// ------------------------------------------------------------------ start --

setTool("select");
renderChrome();
addEventListener("pagehide", () => { for (const t of tabs.tabs) if (t.dirty) void tabs.writeDraft(t); });
// Coming here straight from the File viewer brings its SVG along.
async function takeHandoff() {
  const handoff = await background("viewer-handoff", { editor: "draw" }).catch(() => null);
  if (handoff?.path) await openFile(handoff.path);
  return Boolean(handoff?.path);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void takeHandoff(); });
const restored = await tabs.restore();
if (!(await takeHandoff()) && !restored) await showStart();
