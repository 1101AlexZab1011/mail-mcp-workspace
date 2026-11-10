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
import { host } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, background, toast, registerPage, ask, contextMenu } from "./shared/page.js";
import { DocTabs } from "./shared/doctabs.js";
import { History } from "./draw/history.js";
import * as g from "./draw/geometry.js";
import { indexSource, serializePreserving } from "./draw/serialize.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape";
const SODIPODI_NS = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd";
const BACKUPS = "~/.local/state/mail-workspace/draw-backups";
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
  ["Ctrl+D, Delete", "Duplicate, delete"],
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
const nameOf = (path) => path.split("/").pop();
const dirOf = (path) => path.replace(/\/[^/]+$/, "") || "/";
const tilde = (path) => path.replace(/^\/home\/[^/]+/, "~");

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
  const start = { x: event.clientX, y: event.clientY, frame: toFrame(event.clientX, event.clientY) };
  if (tool === "zoom") { gesture = { kind: "zoom", start, shift: event.shiftKey }; ui.overlay.setPointerCapture(event.pointerId); return; }

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
  } else if (gesture.kind === "band" || gesture.kind === "zoom") {
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
  if (!tab || tool !== "select") return;
  const hit = hitAt(event.clientX, event.clientY);
  if (hit && isGroup(hit)) enterGroup(hit, event.clientX, event.clientY);
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
    const box = items.length ? unionBox(items) : null;
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

// --------------------------------------------------------------- editing --

function deleteSelection() {
  const items = selected();
  if (!items.length) return;
  tab.history.edit(`Delete ${items.length}`, () => { for (const el of items) el.remove(); });
  tab.selection.clear();
  drawOverlay(); renderProps();
}

/** Every id in the document (for new ones). */
const takenIds = () => new Set([...tab.doc.querySelectorAll("[id]")].map((el) => el.id));

/** A copy of `el` with fresh ids; references inside the copy follow the renamed ids. */
function cloneWithFreshIds(el, taken) {
  const copy = el.cloneNode(true);
  const renamed = new Map();
  for (const node of [copy, ...copy.querySelectorAll("[id]")]) {
    if (!node.id) continue;
    const fresh = g.freshId(node.id.replace(/[-_]?\d+$/, "") || node.localName, taken);
    renamed.set(node.id, fresh);
    node.id = fresh;
  }
  if (renamed.size) {
    for (const node of [copy, ...copy.querySelectorAll("*")]) {
      for (const attr of [...node.attributes]) {
        let value = attr.value;
        value = value.replace(/url\(\s*#([^)\s]+)\s*\)/g, (m, id) => (renamed.has(id) ? `url(#${renamed.get(id)})` : m));
        if ((attr.localName === "href") && value.startsWith("#") && renamed.has(value.slice(1))) value = `#${renamed.get(value.slice(1))}`;
        if (value !== attr.value) attr.value = value;
      }
    }
  }
  return copy;
}

function duplicate() {
  const items = selected();
  if (!items.length) return;
  const taken = takenIds();
  const copies = [];
  tab.history.edit(`Duplicate ${items.length}`, () => {
    for (const el of items) { const copy = cloneWithFreshIds(el, taken); el.after(copy); copies.push(copy); }
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
  pan: "Drag to move around. Ctrl+wheel zooms.",
  zoom: "Click to zoom in, Shift+click to zoom out, or drag around an area.",
}[id] ?? "");

function setTool(id) {
  tool = id;
  ui.viewport.dataset.tool = id;
  renderTools();
  drawOverlay();
  setStatus("");
}

function renderTools() {
  $("#tools").replaceChildren(...TOOLS.map((t) => iconButton(t.icon, `${t.label} (${t.key.toUpperCase()})`, () => setTool(t.id), { pressed: tool === t.id })));
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
    sections.push(h("div", {}, h("h3", {}, "Arrange"), h("div.row-buttons", {},
      h("button.btn", { type: "button", title: "Raise to top (Home)", onclick: () => arrange("top") }, icon("flip_to_front", { size: 16 }), "Top"),
      h("button.btn", { type: "button", title: "Raise one step (Page Up)", onclick: () => arrange("up") }, icon("keyboard_arrow_up", { size: 16 }), "Up"),
      h("button.btn", { type: "button", title: "Lower one step (Page Down)", onclick: () => arrange("down") }, icon("keyboard_arrow_down", { size: 16 }), "Down"),
      h("button.btn", { type: "button", title: "Lower to bottom (End)", onclick: () => arrange("bottom") }, icon("flip_to_back", { size: 16 }), "Bottom"),
      h("button.btn", { type: "button", title: "Duplicate (Ctrl+D)", onclick: duplicate }, icon("content_copy", { size: 16 }), "Duplicate"),
      h("button.btn", { type: "button", title: "Delete (Del)", onclick: deleteSelection }, icon("delete", { size: 16 }), "Delete"),
      one && isGroup(one) ? h("button.btn", { type: "button", title: "Edit inside this group (double-click)", onclick: () => enterGroup(one) }, icon("layers", { size: 16 }), "Enter group") : null)));
  } else {
    const size = toUserSize();
    sections.push(h("div", {}, h("h3", {}, "Page"),
      h("p.hint", {}, `${g.fmt(size.w)} × ${g.fmt(size.h)} ${tab.unit}`),
      h("p.hint", { title: tab.path }, tilde(tab.path))));
  }
  ui.props.replaceChildren(...sections);
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
    pathInput.setSelectionRange(pathInput.value.lastIndexOf("/") + 1, pathInput.value.length - 4);
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
      a: selectAll, d: duplicate, 0: fit, "=": () => zoomCenter(1.25), "+": () => zoomCenter(1.25), "-": () => zoomCenter(1 / 1.25),
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
  const simple = {
    delete: deleteSelection, backspace: deleteSelection,
    escape: () => { if (tab.selection.size) select([]); else leaveGroup(); },
    home: () => arrange("top"), end: () => arrange("bottom"), pageup: () => arrange("up"), pagedown: () => arrange("down"),
    "+": () => zoomCenter(1.25), "=": () => zoomCenter(1.25), "-": () => zoomCenter(1 / 1.25), 5: fit, 1: () => zoomTo(1),
  };
  if (simple[key]) { take(); simple[key](); return; }
  const found = TOOLS.find((t) => t.key === key);
  if (found) { take(); setTool(found.id); }
}, true);
addEventListener("keyup", (event) => { if (event.key === " ") { spaceDown = false; ui.viewport.classList.remove("panning"); } });
// A drag that ends outside the window still ends.
addEventListener("blur", () => { spaceDown = false; ui.viewport.classList.remove("panning"); });

// ------------------------------------------------------------- agent API --

const describe = (el) => ({ id: el.id || null, tag: el.localName, label: el.getAttributeNS(INKSCAPE_NS, "label") || undefined, box: (() => { const b = unionBox([el]); return b ? Object.fromEntries(Object.entries(toUser(b)).map(([k, v]) => [k, Number(g.fmt(v))])) : null; })() });

registerPage("draw", {
  state: () => ({
    path: tab?.path ?? null,
    modified: Boolean(tab?.history.modified),
    tabs: tabs.tabs.map((t) => ({ path: t.path, title: t.title, modified: t.dirty, active: t === tab })),
    tool,
    unit: tab?.unit,
    page: tab ? toUserSize() : null,
    zoom: tab?.view ? Math.round(tab.view.scale * 1000) / 1000 : null,
    editing: tab && tab.scope !== root() ? describe(tab.scope) : null,
    selected: selected().slice(0, 100).map(describe),
  }),
  commands: {
    open: ({ path, query }) => openFile(path ?? query),
    save: async () => ({ saved: tab ? await tabs.save() : false }),
    select: ({ ids = [] }) => {
      if (!tab) throw new Error("No drawing is open");
      const found = ids.map((id) => tab.doc.getElementById(id)).filter(Boolean);
      select(found);
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
