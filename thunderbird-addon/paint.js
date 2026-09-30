// Paint: a small drawing space for marking up screenshots for the agent.
//
// The picture is a list of objects (images, strokes, shapes, text) that stay
// editable, drawn in order onto one layer over the background. Pixel work is
// expressed as objects too: the eraser is a destination-out stroke, deleting
// a selected area is a destination-out fill, a bucket fill is an image. That
// keeps undo simple (a snapshot of the object list) and nothing is lost.
//
// Two kinds of selection:
//   objects  the Select tool (click, Shift+click, rubber band, Ctrl+A)
//   pixels   rectangle, lasso and polygon selections; Delete clears the area,
//            Ctrl+C / Ctrl+X copy / cut it, dragging it lifts it into a movable image.
import { broker, host, HOST_ENDPOINT, json } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, toast, background, registerPage } from "./shared/page.js";

const viewport = $("#viewport");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const textEditor = $("#text-editor");

const PALETTE = ["#1b1f27", "#ffffff", "#e53935", "#fb8c00", "#fdd835", "#43a047", "#00acc1", "#1e88e5", "#5e35b1", "#d81b60", "#8d6e63", "#9e9e9e"];
const TOOLS = [
  { id: "select", icon: "arrow_selector_tool", label: "Select and move objects", key: "v" },
  { id: "marquee", icon: "select", label: "Rectangle selection", key: "m" },
  { id: "lasso", icon: "lasso_select", label: "Lasso selection", key: "l" },
  { id: "polygon", icon: "polyline", label: "Polygon selection (click points, Enter or double-click to close)", key: "k" },
  { id: "pan", icon: "pan_tool", label: "Hand: move the view (or hold Space)", key: "h" },
  "-",
  { id: "pen", icon: "draw", label: "Pen", key: "b" },
  { id: "highlighter", icon: "ink_highlighter", label: "Highlighter", key: "y" },
  { id: "eraser", icon: "ink_eraser", label: "Eraser", key: "e" },
  "-",
  { id: "line", icon: "horizontal_rule", label: "Line (Shift snaps to 45°)", key: "u" },
  { id: "arrow", icon: "north_east", label: "Arrow (Shift snaps to 45°)", key: "a" },
  { id: "rect", icon: "rectangle", label: "Rectangle (Shift: square)", key: "r" },
  { id: "ellipse", icon: "circle", label: "Ellipse (Shift: circle)", key: "o" },
  { id: "text", icon: "title", label: "Text", key: "t" },
  "-",
  { id: "fill", icon: "format_color_fill", label: "Fill an area", key: "g" },
  { id: "eyedropper", icon: "colorize", label: "Pick a colour", key: "i" },
  { id: "crop", icon: "crop", label: "Crop the canvas", key: "c" },
];
const SHORTCUTS = [
  ["Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y", "Undo / redo"],
  ["Ctrl+A", "Select all objects"],
  ["Ctrl+C / Ctrl+X / Ctrl+V", "Copy / cut / paste (objects or selected area)"],
  ["Ctrl+D", "Duplicate selection"],
  ["Delete, Backspace", "Delete selection or clear selected area"],
  ["Esc", "Deselect / cancel"],
  ["Arrows (Shift: ×10)", "Nudge selection"],
  ["[ and ]", "Thinner / thicker stroke"],
  ["Ctrl+0 / Ctrl+1", "Fit / actual size"],
  ["Ctrl+= / Ctrl+-, + / −", "Zoom in / out"],
  ["Space + drag, middle drag", "Pan"],
  ["Ctrl+N", "New canvas"],
  ["Ctrl+O", "Open image"],
  ["Ctrl+S", "Save as PNG"],
  ["Ctrl+Shift+C", "Copy the whole picture"],
  ["Ctrl+Enter", "Send to agent"],
  ...TOOLS.filter((t) => t !== "-").map((t) => [t.key.toUpperCase(), t.label]),
];

// ------------------------------------------------------------- document --

const NEW_SIZE = { width: 1600, height: 1000 };
let doc = { ...NEW_SIZE, background: "#ffffff", objects: [] };
const style = { color: "#e53935", fill: null, width: 4, opacity: 1, fontSize: 28 };
let tool = "pen";
let selection = new Set(); // object ids
let region = null; // pixel selection: { kind: "rect", x, y, w, h } | { kind: "path", points }
let polygonDraft = null; // points of a polygon selection being drawn
let clipboard = null; // { kind: "objects", objects, blobSize } | { kind: "image", src, w, h, blobSize }
const images = new Map(); // src → drawable
const undoStack = [];
const redoStack = [];
const view = { scale: 1, x: 0, y: 0 };
let draft = null;
let bandRect = null; // rubber band of the Select tool
const layer = document.createElement("canvas");
let dirty = true;

let nextId = 1;
const newId = () => `o${Date.now().toString(36)}${(nextId++).toString(36)}`;
const byId = (id) => doc.objects.find((o) => o.id === id);
const selectedObjects = () => doc.objects.filter((o) => selection.has(o.id));

function snapshotState() { return { width: doc.width, height: doc.height, background: doc.background, objects: [...doc.objects] }; }
function commit(label) {
  undoStack.push(snapshotState());
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  dirty = true;
  if (label) status(label);
  renderHistory();
}
function restore(state) { doc = { ...state, objects: [...state.objects] }; selection = new Set([...selection].filter((id) => byId(id))); dirty = true; render(); renderChrome(); }
function undo() { if (!undoStack.length) return; redoStack.push(snapshotState()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshotState()); restore(redoStack.pop()); }
function replace(id, next) { const i = doc.objects.findIndex((o) => o.id === id); if (i >= 0) doc.objects[i] = next; dirty = true; }

async function loadImage(src) {
  if (images.has(src)) return images.get(src);
  const img = new Image();
  img.src = src;
  await img.decode();
  images.set(src, img);
  return img;
}

// -------------------------------------------------------------- drawing --

function strokePath(c, points) {
  if (points.length === 1) { c.beginPath(); c.arc(points[0][0], points[0][1], c.lineWidth / 2, 0, Math.PI * 2); c.fill(); return; }
  c.beginPath();
  c.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    c.quadraticCurveTo(points[i][0], points[i][1], (points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2);
  }
  const last = points.at(-1);
  c.lineTo(last[0], last[1]);
  c.stroke();
}

function regionPath(c, r) {
  c.beginPath();
  if (r.kind === "rect") c.rect(r.x, r.y, r.w, r.h);
  else { c.moveTo(r.points[0][0], r.points[0][1]); for (const [x, y] of r.points.slice(1)) c.lineTo(x, y); c.closePath(); }
}

function arrowHead(o) {
  const angle = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
  const size = Math.max(12, o.width * 3.6);
  const length = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
  const head = Math.min(size, length * 0.6);
  return { angle, head };
}

function drawObject(c, o) {
  c.save();
  c.globalAlpha = o.opacity ?? 1;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = o.color;
  c.fillStyle = o.color;
  c.lineWidth = o.width ?? 4;
  switch (o.type) {
    case "image": { const img = images.get(o.src); if (img) c.drawImage(img, o.x, o.y, o.w, o.h); break; }
    case "erase": c.globalCompositeOperation = "destination-out"; c.globalAlpha = 1; c.fillStyle = "#000"; regionPath(c, o.region); c.fill(); break;
    case "stroke":
      if (o.mode === "eraser") { c.globalCompositeOperation = "destination-out"; c.globalAlpha = 1; }
      if (o.mode === "highlighter") c.globalCompositeOperation = "multiply";
      strokePath(c, o.points);
      break;
    case "line": c.beginPath(); c.moveTo(o.x1, o.y1); c.lineTo(o.x2, o.y2); c.stroke(); break;
    case "arrow": {
      // The shaft stops where the head begins, so the tip is the head's point,
      // not a rounded line end poking through it.
      const { angle, head } = arrowHead(o);
      const baseX = o.x2 - Math.cos(angle) * head * 0.8;
      const baseY = o.y2 - Math.sin(angle) * head * 0.8;
      c.lineCap = "butt";
      c.beginPath(); c.moveTo(o.x1, o.y1); c.lineTo(baseX, baseY); c.stroke();
      c.lineJoin = "miter";
      c.beginPath();
      c.moveTo(o.x2, o.y2);
      c.lineTo(o.x2 - head * Math.cos(angle - Math.PI / 7), o.y2 - head * Math.sin(angle - Math.PI / 7));
      c.lineTo(o.x2 - head * Math.cos(angle + Math.PI / 7), o.y2 - head * Math.sin(angle + Math.PI / 7));
      c.closePath();
      c.fill();
      break;
    }
    case "rect":
    case "ellipse": {
      const x = Math.min(o.x, o.x + o.w); const y = Math.min(o.y, o.y + o.h); const w = Math.abs(o.w); const hh = Math.abs(o.h);
      c.beginPath();
      if (o.type === "rect") c.roundRect(x, y, w, hh, Math.min(8, w / 4, hh / 4)); else c.ellipse(x + w / 2, y + hh / 2, w / 2, hh / 2, 0, 0, Math.PI * 2);
      if (o.fill) { c.fillStyle = o.fill; c.fill(); }
      if (o.width > 0) c.stroke();
      break;
    }
    case "text":
      c.font = `600 ${o.size}px ${getComputedStyle(document.body).fontFamily}`;
      c.textBaseline = "top";
      o.text.split("\n").forEach((line, i) => c.fillText(line, o.x, o.y + i * o.size * 1.25));
      break;
  }
  c.restore();
}

function textBox(o) {
  ctx.save();
  ctx.font = `600 ${o.size}px ${getComputedStyle(document.body).fontFamily}`;
  const lines = o.text.split("\n");
  const w = Math.max(...lines.map((line) => ctx.measureText(line).width), o.size / 2);
  ctx.restore();
  return { x: o.x, y: o.y, w, h: lines.length * o.size * 1.25 };
}

function bounds(o) {
  const pad = (o.width ?? 0) / 2;
  switch (o.type) {
    case "image": return { x: o.x, y: o.y, w: o.w, h: o.h };
    case "rect": case "ellipse": return { x: Math.min(o.x, o.x + o.w) - pad, y: Math.min(o.y, o.y + o.h) - pad, w: Math.abs(o.w) + pad * 2, h: Math.abs(o.h) + pad * 2 };
    case "line": case "arrow": return { x: Math.min(o.x1, o.x2) - pad, y: Math.min(o.y1, o.y2) - pad, w: Math.abs(o.x2 - o.x1) + pad * 2, h: Math.abs(o.y2 - o.y1) + pad * 2 };
    case "stroke": {
      const xs = o.points.map((p) => p[0]); const ys = o.points.map((p) => p[1]);
      return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
    }
    case "text": return textBox(o);
    case "erase": return regionBounds(o.region);
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function union(boxes) {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)); const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}
const selectionBounds = () => union(selectedObjects().map(bounds));
function regionBounds(r) {
  if (r.kind === "rect") return normal(r);
  const xs = r.points.map((p) => p[0]); const ys = r.points.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
const normal = (r) => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });

function renderLayer() {
  if (layer.width !== doc.width || layer.height !== doc.height) { layer.width = doc.width; layer.height = doc.height; }
  const c = layer.getContext("2d");
  c.clearRect(0, 0, layer.width, layer.height);
  for (const o of doc.objects) drawObject(c, o);
  if (draft) drawObject(c, draft);
  dirty = false;
}

/** The finished picture at document resolution. */
function composite({ background: withBackground = true } = {}) {
  if (dirty || draft) renderLayer();
  const out = document.createElement("canvas");
  out.width = doc.width;
  out.height = doc.height;
  const c = out.getContext("2d");
  if (withBackground && doc.background !== "transparent") { c.fillStyle = doc.background; c.fillRect(0, 0, out.width, out.height); }
  c.drawImage(layer, 0, 0);
  return out;
}

function toScreen(x, y) { return [x * view.scale + view.x, y * view.scale + view.y]; }
function toDoc(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  return [(clientX - rect.left - view.x) / view.scale, (clientY - rect.top - view.y) / view.scale];
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let antsOffset = 0;
function render() {
  const dpr = devicePixelRatio;
  const { width, height } = viewport.getBoundingClientRect();
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  }
  if (dirty || draft) renderLayer();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = 24 / view.scale;
  if (doc.background === "transparent") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, doc.width, doc.height); ctx.shadowColor = "transparent"; drawChecker(); }
  else { ctx.fillStyle = doc.background; ctx.fillRect(0, 0, doc.width, doc.height); }
  ctx.shadowColor = "transparent";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(layer, 0, 0);
  ctx.restore();

  const primary = cssVar("--mw-primary");
  // Object selection: dashed box and resize handles.
  const box = selectionBounds();
  if (box) {
    const [x, y] = toScreen(box.x, box.y);
    ctx.strokeStyle = primary; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.strokeRect(x - 4, y - 4, box.w * view.scale + 8, box.h * view.scale + 8);
    ctx.setLineDash([]);
    if (selection.size === 1) for (const o of selectedObjects()) if (o.type !== "image" && o.type !== "text" && o.type !== "erase") {
      const b = bounds(o); const [bx, by] = toScreen(b.x, b.y);
      ctx.strokeStyle = primary; ctx.globalAlpha = 0.35; ctx.strokeRect(bx, by, b.w * view.scale, b.h * view.scale); ctx.globalAlpha = 1;
    }
    for (const [hx, hy] of handles(box)) { ctx.fillStyle = "#fff"; ctx.strokeStyle = primary; ctx.beginPath(); ctx.rect(hx - 5, hy - 5, 10, 10); ctx.fill(); ctx.stroke(); }
  }
  // Pixel selection: marching ants.
  const ants = region ?? (polygonDraft ? { kind: "path", points: polygonDraft, open: true } : null);
  if (ants) {
    ctx.save();
    ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale);
    ctx.lineWidth = 1.2 / view.scale;
    if (ants.open) { ctx.beginPath(); ants.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (polygonCursor) ctx.lineTo(...polygonCursor); }
    else regionPath(ctx, ants);
    ctx.setLineDash([6 / view.scale, 6 / view.scale]);
    ctx.strokeStyle = "#fff"; ctx.lineDashOffset = antsOffset / view.scale; ctx.stroke();
    ctx.strokeStyle = "#111"; ctx.lineDashOffset = (antsOffset + 6) / view.scale; ctx.stroke();
    if (ants.open) for (const [x, y] of ants.points) { ctx.setLineDash([]); ctx.fillStyle = "#fff"; ctx.fillRect(x - 3 / view.scale, y - 3 / view.scale, 6 / view.scale, 6 / view.scale); }
    ctx.restore();
  }
  if (bandRect) {
    const r = normal(bandRect); const [x, y] = toScreen(r.x, r.y);
    ctx.fillStyle = `${primary}22`; ctx.strokeStyle = primary; ctx.lineWidth = 1;
    ctx.fillRect(x, y, r.w * view.scale, r.h * view.scale); ctx.strokeRect(x, y, r.w * view.scale, r.h * view.scale);
  }
  if (cropRect) {
    const r = normal(cropRect);
    const [x, y] = toScreen(r.x, r.y);
    const [dx, dy] = toScreen(0, 0);
    ctx.fillStyle = "rgba(10,12,18,0.45)";
    ctx.fillRect(dx, dy, doc.width * view.scale, doc.height * view.scale);
    ctx.clearRect(x, y, r.w * view.scale, r.h * view.scale);
    ctx.drawImage(layer, r.x, r.y, r.w, r.h, x, y, r.w * view.scale, r.h * view.scale);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, r.w * view.scale, r.h * view.scale);
  }
  // Canvas resize grip at the bottom-right corner (Select tool).
  if (tool === "select") {
    const [gx, gy] = toScreen(doc.width, doc.height);
    ctx.fillStyle = primary; ctx.beginPath(); ctx.arc(gx, gy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
  }
  $("#empty").hidden = doc.objects.length > 0 || Boolean(draft);
  $("#doc-size").textContent = `${doc.width} × ${doc.height}`;
}

function drawChecker() {
  const size = 12;
  ctx.fillStyle = "#e8e8e8";
  for (let y = 0; y < doc.height; y += size) for (let x = (y / size) % 2 ? size : 0; x < doc.width; x += size * 2) ctx.fillRect(x, y, size, size);
}

// Animate marching ants only while there is a pixel selection.
setInterval(() => { if (region || polygonDraft) { antsOffset = (antsOffset + 1) % 12; render(); } }, 90);

function handles(b) {
  const [x, y] = toScreen(b.x, b.y);
  const w = b.w * view.scale; const hh = b.h * view.scale;
  return [[x - 4, y - 4], [x + w + 4, y - 4], [x - 4, y + hh + 4], [x + w + 4, y + hh + 4]];
}

// -------------------------------------------------------------- hit test --

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1; const dy = y2 - y1;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hit(x, y) {
  const slack = 6 / view.scale;
  for (let i = doc.objects.length - 1; i >= 0; i--) {
    const o = doc.objects[i];
    if (o.type === "erase" || (o.type === "stroke" && o.mode === "eraser")) continue;
    if (o.type === "stroke") {
      for (let j = 0; j < o.points.length; j++) {
        const a = o.points[j]; const b = o.points[j + 1] ?? a;
        if (distanceToSegment(x, y, a[0], a[1], b[0], b[1]) <= o.width / 2 + slack) return o;
      }
      continue;
    }
    if (o.type === "line" || o.type === "arrow") { if (distanceToSegment(x, y, o.x1, o.y1, o.x2, o.y2) <= o.width / 2 + slack) return o; continue; }
    const b = bounds(o);
    if (x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack) return o;
  }
  return null;
}

function handleAt(clientX, clientY) {
  const box = selectionBounds();
  if (!box) return null;
  const rect = viewport.getBoundingClientRect();
  const index = handles(box).findIndex(([hx, hy]) => Math.abs(clientX - rect.left - hx) < 9 && Math.abs(clientY - rect.top - hy) < 9);
  return index < 0 ? null : index;
}

function onCanvasGrip(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  const [gx, gy] = toScreen(doc.width, doc.height);
  return Math.hypot(clientX - rect.left - gx, clientY - rect.top - gy) < 12;
}

function insideRegion(x, y) {
  if (!region) return false;
  const c = document.createElement("canvas").getContext("2d");
  regionPath(c, region);
  return c.isPointInPath(x, y);
}

function scaleObject(o, from, to) {
  const sx = to.w / (from.w || 1); const sy = to.h / (from.h || 1);
  const mx = (x) => to.x + (x - from.x) * sx; const my = (y) => to.y + (y - from.y) * sy;
  switch (o.type) {
    case "image": case "rect": case "ellipse": return { ...o, x: mx(Math.min(o.x, o.x + o.w)), y: my(Math.min(o.y, o.y + o.h)), w: Math.abs(o.w) * sx, h: Math.abs(o.h) * sy };
    case "line": case "arrow": return { ...o, x1: mx(o.x1), y1: my(o.y1), x2: mx(o.x2), y2: my(o.y2) };
    case "stroke": return { ...o, points: o.points.map(([x, y, p]) => [mx(x), my(y), p]) };
    case "text": return { ...o, x: mx(o.x), y: my(o.y), size: Math.max(6, o.size * sy) };
    case "erase": return o.region.kind === "rect" ? { ...o, region: { ...o.region, x: mx(o.region.x), y: my(o.region.y), w: o.region.w * sx, h: o.region.h * sy } } : { ...o, region: { ...o.region, points: o.region.points.map(([x, y]) => [mx(x), my(y)]) } };
  }
  return o;
}

function translateObject(o, dx, dy) {
  switch (o.type) {
    case "line": case "arrow": return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case "stroke": return { ...o, points: o.points.map(([x, y, p]) => [x + dx, y + dy, p]) };
    case "erase": return { ...o, region: translateRegion(o.region, dx, dy) };
    default: return { ...o, x: o.x + dx, y: o.y + dy };
  }
}
const translateRegion = (r, dx, dy) => (r.kind === "rect" ? { ...r, x: r.x + dx, y: r.y + dy } : { ...r, points: r.points.map(([x, y]) => [x + dx, y + dy]) });

// ------------------------------------------------------------ pixel ops --

/** The pixels inside a region (objects only, no background) as a drawable + data URL. */
function regionPixels(r) {
  const b = regionBounds(r);
  const box = { x: Math.floor(b.x), y: Math.floor(b.y), w: Math.max(1, Math.ceil(b.w)), h: Math.max(1, Math.ceil(b.h)) };
  if (dirty) renderLayer();
  const out = document.createElement("canvas");
  out.width = box.w; out.height = box.h;
  const c = out.getContext("2d");
  c.translate(-box.x, -box.y);
  regionPath(c, r);
  c.clip();
  c.drawImage(layer, 0, 0);
  return { canvas: out, box, src: out.toDataURL("image/png") };
}

function eraseRegion(r, label = "Cleared area") {
  commit(label);
  doc.objects.push({ id: newId(), type: "erase", region: structuredClone(r) });
  dirty = true;
}

/** Lift the selected pixels into a movable image object. */
function liftRegion() {
  const { canvas: piece, box, src } = regionPixels(region);
  images.set(src, piece);
  eraseRegion(region, "Moved area");
  const lifted = { id: newId(), type: "image", src, x: box.x, y: box.y, w: box.w, h: box.h, opacity: 1 };
  doc.objects.push(lifted);
  region = null;
  selection = new Set([lifted.id]);
  dirty = true;
  return lifted;
}

function floodFill(x, y) {
  const image = composite();
  const c = image.getContext("2d", { willReadFrequently: true });
  const { width, height } = image;
  const data = c.getImageData(0, 0, width, height).data;
  const sx = Math.floor(x); const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return;
  const i0 = (sy * width + sx) * 4;
  const target = [data[i0], data[i0 + 1], data[i0 + 2], data[i0 + 3]];
  const same = (i) => Math.abs(data[i] - target[0]) + Math.abs(data[i + 1] - target[1]) + Math.abs(data[i + 2] - target[2]) + Math.abs(data[i + 3] - target[3]) <= 48;
  const mask = new Uint8Array(width * height);
  const stack = [[sx, sy]];
  let minX = sx; let maxX = sx; let minY = sy; let maxY = sy;
  while (stack.length) {
    const [px, py] = stack.pop();
    let lx = px;
    while (lx >= 0 && !mask[py * width + lx] && same((py * width + lx) * 4)) lx--;
    lx++;
    let rx = px;
    while (rx < width && !mask[py * width + rx] && same((py * width + rx) * 4)) rx++;
    for (let i = lx; i < rx; i++) {
      mask[py * width + i] = 1;
      if (py > 0 && !mask[(py - 1) * width + i] && same(((py - 1) * width + i) * 4)) stack.push([i, py - 1]);
      if (py < height - 1 && !mask[(py + 1) * width + i] && same(((py + 1) * width + i) * 4)) stack.push([i, py + 1]);
    }
    minX = Math.min(minX, lx); maxX = Math.max(maxX, rx - 1); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const w = maxX - minX + 1; const hh = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = w; out.height = hh;
  const oc = out.getContext("2d");
  const pixels = oc.createImageData(w, hh);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(style.color.slice(i, i + 2), 16));
  for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < w; xx++) {
    if (!mask[(minY + yy) * width + minX + xx]) continue;
    const i = (yy * w + xx) * 4;
    pixels.data[i] = r; pixels.data[i + 1] = g; pixels.data[i + 2] = b; pixels.data[i + 3] = 255;
  }
  oc.putImageData(pixels, 0, 0);
  const src = out.toDataURL("image/png");
  images.set(src, out);
  commit("Filled area");
  doc.objects.push({ id: newId(), type: "image", fill: true, src, x: minX, y: minY, w, h: hh, opacity: style.opacity });
  dirty = true;
  render();
}

function pickColor(x, y) {
  const c = composite().getContext("2d", { willReadFrequently: true });
  const [r, g, b] = c.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  style.color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  renderProps();
  status(`Picked ${style.color}`);
}

function applyCrop(r) {
  const box = normal(r);
  if (box.w < 4 || box.h < 4) return;
  commit("Cropped");
  const x = Math.round(box.x); const y = Math.round(box.y);
  doc.objects = doc.objects.map((o) => translateObject(o, -x, -y));
  doc.width = Math.round(box.w); doc.height = Math.round(box.h);
  dirty = true;
  fit();
}

function resizeCanvas(width, height, { label = "Resized canvas", record = true } = {}) {
  if (record) commit(label);
  doc.width = Math.max(16, Math.min(10000, Math.round(width)));
  doc.height = Math.max(16, Math.min(10000, Math.round(height)));
  dirty = true;
  render();
  renderProps();
}

function fitCanvasToContent() {
  const box = union(doc.objects.filter((o) => o.type !== "erase").map(bounds));
  if (!box) return;
  commit("Canvas fitted to content");
  const pad = 16;
  const dx = -Math.floor(box.x) + pad; const dy = -Math.floor(box.y) + pad;
  doc.objects = doc.objects.map((o) => translateObject(o, dx, dy));
  resizeCanvas(box.w + pad * 2, box.h + pad * 2, { record: false });
  fit();
}

// ------------------------------------------------------------- pointer --

let pointer = null;
let cropRect = null;
let spaceDown = false;
let polygonCursor = null;

viewport.addEventListener("pointerdown", (event) => {
  if (event.button === 1 || spaceDown || tool === "pan") return startPan(event);
  if (event.button !== 0) return;
  viewport.focus();
  viewport.setPointerCapture(event.pointerId);
  const [x, y] = toDoc(event.clientX, event.clientY);
  const base = { color: style.color, width: style.width, opacity: style.opacity };
  pointer = { startX: x, startY: y };
  switch (tool) {
    case "select": {
      if (onCanvasGrip(event.clientX, event.clientY)) { commit(); pointer.canvas = { width: doc.width, height: doc.height }; break; }
      const handle = handleAt(event.clientX, event.clientY);
      if (handle !== null) { commit(); pointer.resize = { handle, from: selectionBounds(), originals: selectedObjects() }; break; }
      const found = hit(x, y);
      if (found) {
        if (event.shiftKey) { if (selection.has(found.id)) selection.delete(found.id); else selection.add(found.id); }
        else if (!selection.has(found.id)) selection = new Set([found.id]);
        commit();
        pointer.move = { originals: selectedObjects() };
      } else {
        if (!event.shiftKey) selection.clear();
        bandRect = { x, y, w: 0, h: 0 };
        pointer.band = { additive: event.shiftKey };
      }
      renderProps();
      break;
    }
    case "marquee":
    case "lasso":
      if (region && insideRegion(x, y)) { const lifted = liftRegion(); pointer.move = { originals: [lifted] }; break; }
      region = null;
      if (tool === "marquee") pointer.marquee = { x, y }; else pointer.lasso = [[x, y]];
      break;
    case "polygon":
      if (!polygonDraft && region && insideRegion(x, y)) { const lifted = liftRegion(); pointer.move = { originals: [lifted] }; break; }
      pointer = null;
      if (!polygonDraft) { region = null; polygonDraft = [[x, y]]; }
      else {
        const [fx, fy] = polygonDraft[0];
        if (polygonDraft.length > 2 && Math.hypot(fx - x, fy - y) * view.scale < 10) closePolygon();
        else polygonDraft.push([x, y]);
      }
      render();
      return;
    case "pen": draft = { id: newId(), type: "stroke", mode: "pen", points: [[x, y, event.pressure || 0.5]], ...base }; break;
    case "highlighter": draft = { id: newId(), type: "stroke", mode: "highlighter", points: [[x, y, 0.5]], ...base, width: Math.max(style.width * 3, 14), opacity: 0.45 }; break;
    case "eraser": draft = { id: newId(), type: "stroke", mode: "eraser", points: [[x, y, 0.5]], color: "#000", width: Math.max(style.width * 3, 16), opacity: 1 }; break;
    case "line": case "arrow": draft = { id: newId(), type: tool, x1: x, y1: y, x2: x, y2: y, ...base }; break;
    case "rect": case "ellipse": draft = { id: newId(), type: tool, x, y, w: 0, h: 0, ...base, fill: style.fill }; break;
    case "text": pointer = null; startText(x, y); return;
    case "fill": pointer = null; floodFill(x, y); return;
    case "eyedropper": pointer = null; pickColor(x, y); return;
    case "crop": cropRect = { x, y, w: 0, h: 0 }; break;
  }
  render();
});

function closePolygon() {
  if (polygonDraft && polygonDraft.length > 2) region = { kind: "path", points: polygonDraft };
  polygonDraft = null;
  polygonCursor = null;
  render();
}

viewport.addEventListener("pointermove", (event) => {
  let [x, y] = toDoc(event.clientX, event.clientY);
  if (!pointer) {
    if (tool === "polygon" && polygonDraft) { polygonCursor = [x, y]; render(); return; }
    if (tool === "select") {
      viewport.style.cursor = onCanvasGrip(event.clientX, event.clientY) ? "nwse-resize" : handleAt(event.clientX, event.clientY) !== null ? "nwse-resize" : hit(x, y) ? "move" : "";
    } else if ((tool === "marquee" || tool === "lasso" || tool === "polygon") && region) {
      viewport.style.cursor = insideRegion(x, y) ? "move" : "";
    } else viewport.style.cursor = "";
    return;
  }
  const shift = event.shiftKey;
  if (pointer.canvas) {
    resizeCanvas(Math.max(16, x), Math.max(16, y), { record: false });
    return;
  }
  if (pointer.resize) {
    const { from, handle, originals } = pointer.resize;
    const left = handle === 0 || handle === 2; const top = handle === 0 || handle === 1;
    let nx = left ? x : from.x; let ny = top ? y : from.y;
    const nw = left ? from.x + from.w - x : x - from.x; let nh = top ? from.y + from.h - y : y - from.y;
    const keepRatio = shift || originals.some((o) => o.type === "image" || o.type === "text");
    if (keepRatio) { nh = nw / (from.w / (from.h || 1)); if (top) ny = from.y + from.h - nh; }
    if (nw > 2 && nh > 2) { for (const o of originals) replace(o.id, scaleObject(o, from, { x: nx, y: ny, w: nw, h: nh })); }
    void nx;
  } else if (pointer.move) {
    for (const o of pointer.move.originals) replace(o.id, translateObject(o, x - pointer.startX, y - pointer.startY));
  } else if (pointer.band) {
    bandRect.w = x - bandRect.x; bandRect.h = y - bandRect.y;
  } else if (pointer.marquee) {
    let w = x - pointer.marquee.x; let hh = y - pointer.marquee.y;
    if (shift) { const s = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * s; hh = Math.sign(hh || 1) * s; }
    region = { kind: "rect", ...normal({ x: pointer.marquee.x, y: pointer.marquee.y, w, h: hh }) };
  } else if (pointer.lasso) {
    pointer.lasso.push([x, y]);
    region = { kind: "path", points: pointer.lasso };
  } else if (draft?.type === "stroke") {
    for (const e of event.getCoalescedEvents?.() ?? [event]) { const [cx, cy] = toDoc(e.clientX, e.clientY); draft.points.push([cx, cy, e.pressure || 0.5]); }
  } else if (draft?.type === "line" || draft?.type === "arrow") {
    if (shift) { const angle = Math.round(Math.atan2(y - draft.y1, x - draft.x1) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(x - draft.x1, y - draft.y1); x = draft.x1 + len * Math.cos(angle); y = draft.y1 + len * Math.sin(angle); }
    draft.x2 = x; draft.y2 = y;
  } else if (draft) {
    let w = x - draft.x; let hh = y - draft.y;
    if (shift) { const s = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * s; hh = Math.sign(hh || 1) * s; }
    draft.w = w; draft.h = hh;
  } else if (cropRect) {
    cropRect.w = x - cropRect.x; cropRect.h = y - cropRect.y;
  }
  render();
});

function endPointer() {
  if (!pointer) return;
  if (draft) {
    const tiny = (draft.type === "rect" || draft.type === "ellipse") ? Math.abs(draft.w) < 2 && Math.abs(draft.h) < 2 : (draft.type === "line" || draft.type === "arrow") ? Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) < 2 : false;
    if (!tiny) { commit(); doc.objects.push(draft); }
    draft = null;
    dirty = true;
  }
  if (pointer.band) {
    const r = normal(bandRect);
    if (r.w > 2 || r.h > 2) {
      for (const o of doc.objects) {
        if (o.type === "erase" || (o.type === "stroke" && o.mode === "eraser")) continue;
        const b = bounds(o);
        if (b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y) selection.add(o.id);
      }
    }
    bandRect = null;
  }
  if (pointer.marquee && region && (region.w < 2 || region.h < 2)) region = null;
  if (pointer.lasso) { region = pointer.lasso.length > 2 ? { kind: "path", points: pointer.lasso } : null; }
  if (cropRect) { applyCrop(cropRect); cropRect = null; }
  if (pointer.move || pointer.resize || pointer.canvas) {
    const last = undoStack.at(-1);
    const unchanged = last && last.width === doc.width && last.height === doc.height && last.objects.length === doc.objects.length && last.objects.every((o, i) => o === doc.objects[i]);
    if (unchanged) { undoStack.pop(); renderHistory(); } // a click, not a change
  }
  if (pointer.canvas) fit();
  pointer = null;
  render();
  renderProps();
}
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);
viewport.addEventListener("dblclick", (event) => {
  if (tool === "polygon" && polygonDraft) { polygonDraft.pop(); closePolygon(); return; }
  if (tool !== "select") return;
  const found = hit(...toDoc(event.clientX, event.clientY));
  if (found?.type === "text") startText(found.x, found.y, found.id);
});

function startPan(event) {
  event.preventDefault();
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add("dragging");
  const start = { cx: event.clientX, cy: event.clientY, x: view.x, y: view.y };
  const move = (e) => { view.x = start.x + e.clientX - start.cx; view.y = start.y + e.clientY - start.cy; render(); };
  viewport.addEventListener("pointermove", move);
  viewport.addEventListener("pointerup", () => { viewport.removeEventListener("pointermove", move); viewport.classList.remove("dragging"); }, { once: true });
}

viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const rect = viewport.getBoundingClientRect();
    zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
  } else { view.x -= event.deltaX; view.y -= event.deltaY; render(); }
}, { passive: false });

function zoomAt(factor, px, py) {
  const next = Math.max(0.05, Math.min(16, view.scale * factor));
  view.x = px - ((px - view.x) * next) / view.scale;
  view.y = py - ((py - view.y) * next) / view.scale;
  view.scale = next;
  render();
  renderZoom();
}
const zoomCenter = (factor) => { const r = viewport.getBoundingClientRect(); zoomAt(factor, r.width / 2, r.height / 2); };
function fit() {
  const { width, height } = viewport.getBoundingClientRect();
  view.scale = Math.min((width - 64) / doc.width, (height - 64) / doc.height, 2);
  view.x = (width - doc.width * view.scale) / 2;
  view.y = (height - doc.height * view.scale) / 2;
  render();
  renderZoom();
}
function actualSize() { const { width, height } = viewport.getBoundingClientRect(); view.scale = 1; view.x = (width - doc.width) / 2; view.y = (height - doc.height) / 2; render(); renderZoom(); }

// ----------------------------------------------------------------- text --

function startText(x, y, editId = null) {
  const existing = editId ? byId(editId) : null;
  const size = existing?.size ?? style.fontSize;
  const [sx, sy] = toScreen(x, y);
  Object.assign(textEditor.style, { left: `${sx}px`, top: `${sy}px`, font: `600 ${size * view.scale}px ${getComputedStyle(document.body).fontFamily}`, color: existing?.color ?? style.color, width: "auto", height: "auto" });
  textEditor.value = existing?.text ?? "";
  textEditor.hidden = false;
  const resize = () => { textEditor.style.width = "10px"; textEditor.style.width = `${textEditor.scrollWidth + 8}px`; textEditor.style.height = "10px"; textEditor.style.height = `${textEditor.scrollHeight}px`; };
  resize();
  textEditor.oninput = resize;
  setTimeout(() => textEditor.focus());
  textEditor.onblur = () => {
    textEditor.hidden = true;
    textEditor.onblur = null;
    const text = textEditor.value.replace(/\s+$/, "");
    if (existing) {
      commit();
      if (text) replace(existing.id, { ...existing, text }); else { doc.objects = doc.objects.filter((o) => o.id !== existing.id); selection.delete(existing.id); }
    } else if (text) {
      commit("Added text");
      doc.objects.push({ id: newId(), type: "text", x, y, text, color: style.color, size, opacity: style.opacity });
    }
    dirty = true;
    render();
  };
  textEditor.onkeydown = (event) => {
    if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); textEditor.blur(); }
    event.stopPropagation();
  };
}

// --------------------------------------------------- images and clipboard --

async function addImage(src, { name, at } = {}) {
  const img = await loadImage(src);
  commit(`Added ${name ?? "image"}`);
  const empty = !doc.objects.length;
  if (empty) { doc.width = img.naturalWidth; doc.height = img.naturalHeight; }
  const scale = empty ? 1 : Math.min(1, (doc.width * 0.9) / img.naturalWidth, (doc.height * 0.9) / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const hh = img.naturalHeight * scale;
  const object = { id: newId(), type: "image", src, x: at?.x ?? (doc.width - w) / 2, y: at?.y ?? (doc.height - hh) / 2, w, h: hh, opacity: 1 };
  doc.objects.push(object);
  selection = new Set([object.id]);
  if (tool !== "select") setTool("select");
  dirty = true;
  if (empty) fit(); else render();
  renderProps();
}

const fileToDataUrl = (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
const canvasBlob = (c) => new Promise((resolve) => c.toBlob(resolve, "image/png"));

async function writeClipboardImage(blob) {
  try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); } catch { /* keep the internal copy only */ }
}

async function copySelection({ cut = false } = {}) {
  if (region) {
    const { canvas: piece, box, src } = regionPixels(region);
    const blob = await canvasBlob(piece);
    clipboard = { kind: "image", src, w: box.w, h: box.h, x: box.x, y: box.y, blobSize: blob.size };
    images.set(src, piece);
    await writeClipboardImage(blob);
    if (cut) { eraseRegion(region, "Cut area"); region = null; render(); }
    status(cut ? "Cut area" : "Copied area");
    return;
  }
  const objects = selectedObjects();
  if (!objects.length) { await copyPicture(); return; }
  const box = selectionBounds();
  const shot = document.createElement("canvas");
  shot.width = Math.max(1, Math.ceil(box.w)); shot.height = Math.max(1, Math.ceil(box.h));
  const c = shot.getContext("2d");
  c.translate(-box.x, -box.y);
  for (const o of objects) drawObject(c, o);
  const blob = await canvasBlob(shot);
  clipboard = { kind: "objects", objects: structuredClone(objects), blobSize: blob.size };
  await writeClipboardImage(blob);
  if (cut) { commit("Cut"); doc.objects = doc.objects.filter((o) => !selection.has(o.id)); selection.clear(); dirty = true; render(); }
  status(cut ? `Cut ${objects.length} object${objects.length > 1 ? "s" : ""}` : `Copied ${objects.length} object${objects.length > 1 ? "s" : ""}`);
}

function pasteInternal() {
  if (!clipboard) return false;
  commit("Pasted");
  if (clipboard.kind === "objects") {
    const pasted = clipboard.objects.map((o) => ({ ...translateObject(o, 20, 20), id: newId() }));
    clipboard.objects = pasted.map((o) => structuredClone(o));
    doc.objects.push(...pasted);
    selection = new Set(pasted.map((o) => o.id));
  } else {
    const object = { id: newId(), type: "image", src: clipboard.src, x: clipboard.x + 20, y: clipboard.y + 20, w: clipboard.w, h: clipboard.h, opacity: 1 };
    clipboard = { ...clipboard, x: object.x, y: object.y };
    doc.objects.push(object);
    selection = new Set([object.id]);
  }
  region = null;
  if (tool !== "select") setTool("select");
  dirty = true;
  render();
  renderProps();
  return true;
}

/** Ctrl+V: our own copy stays editable; anything else on the clipboard comes in as an image. */
async function paste() {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      if (clipboard && blob.size === clipboard.blobSize) { pasteInternal(); return; }
      await addImage(await fileToDataUrl(blob), { name: "pasted image" });
      return;
    }
    if (!pasteInternal()) toast("Nothing to paste");
  } catch {
    if (!pasteInternal()) toast("Nothing to paste");
  }
}

function duplicate() {
  const objects = selectedObjects();
  if (!objects.length) return;
  commit("Duplicated");
  const copies = objects.map((o) => ({ ...translateObject(o, 20, 20), id: newId() }));
  doc.objects.push(...copies);
  selection = new Set(copies.map((o) => o.id));
  dirty = true;
  render();
}

function deleteSelection() {
  if (region) { eraseRegion(region); region = null; render(); return; }
  if (!selection.size) return;
  commit("Deleted");
  doc.objects = doc.objects.filter((o) => !selection.has(o.id));
  selection.clear();
  dirty = true;
  render();
  renderProps();
}

function selectAll() {
  if (tool !== "select") setTool("select");
  region = null;
  selection = new Set(doc.objects.filter((o) => o.type !== "erase" && !(o.type === "stroke" && o.mode === "eraser")).map((o) => o.id));
  render();
  renderProps();
  status(`Selected ${selection.size} object${selection.size === 1 ? "" : "s"}`);
}

function nudge(dx, dy) {
  if (region) { region = translateRegion(region, dx, dy); render(); return; }
  if (!selection.size) return;
  commit();
  for (const o of selectedObjects()) replace(o.id, translateObject(o, dx, dy));
  render();
}

function newCanvas() {
  if (doc.objects.length) commit("New canvas");
  doc = { ...NEW_SIZE, background: "#ffffff", objects: [] };
  selection.clear();
  region = null;
  dirty = true;
  fit();
  renderProps();
}

async function addImageFromPath(path) {
  const { url } = await host("/v1/links", json({ path }));
  const blob = await (await fetch(`${HOST_ENDPOINT}${url}`)).blob();
  await addImage(await fileToDataUrl(blob), { name: path.split("/").pop() });
}

addEventListener("paste", async (event) => {
  // Keyboard paste is handled on keydown; this covers the Edit menu and drops from other apps.
  if (!textEditor.hidden || event.target.closest?.("input, textarea")) return;
  const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  event.preventDefault();
  await addImage(await fileToDataUrl(item.getAsFile()), { name: "pasted image" });
});
viewport.addEventListener("dragover", (event) => { event.preventDefault(); viewport.classList.add("drop"); });
viewport.addEventListener("dragleave", () => viewport.classList.remove("drop"));
viewport.addEventListener("drop", async (event) => {
  event.preventDefault();
  viewport.classList.remove("drop");
  for (const file of event.dataTransfer.files) if (file.type.startsWith("image/")) await addImage(await fileToDataUrl(file), { name: file.name });
});
$("#file-input").addEventListener("change", async (event) => {
  for (const file of event.target.files) await addImage(await fileToDataUrl(file), { name: file.name });
  event.target.value = "";
});

// ---------------------------------------------------------------- export --

const exportBlob = () => canvasBlob(composite());

async function uploadDrawing() {
  const blob = await exportBlob();
  const name = `drawing-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
  const saved = await broker(`/v1/blobs?name=${encodeURIComponent(name)}&type=image%2Fpng`, { method: "POST", body: blob, headers: { "content-type": "image/png" } });
  return { path: saved.path, name: saved.name, type: "image/png", size: saved.size, blob: saved.id };
}

async function sendToAgent() {
  if (!doc.objects.length) return toast("Draw or paste something first");
  const file = await uploadDrawing();
  await background("attach-to-chat", { files: [file], focus: true });
  toast("Added to the chat. Tell the agent what to do with it.");
}

async function download() {
  const url = URL.createObjectURL(await exportBlob());
  h("a", { href: url, download: "drawing.png" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyPicture() {
  try { await navigator.clipboard.write([new ClipboardItem({ "image/png": await exportBlob() })]); toast("Copied the picture"); }
  catch (error) { toast(`Copy failed: ${error.message}`); }
}

// ---------------------------------------------------------------- chrome --

let statusTimer;
function status(text) { $("#status").textContent = text; clearTimeout(statusTimer); statusTimer = setTimeout(() => { $("#status").textContent = hintFor(tool); }, 2500); }
const hintFor = (id) => ({
  select: "Click to select, Shift+click to add, drag on empty space for a rubber band. Drag the dot at the canvas corner to resize the canvas.",
  marquee: "Drag to select an area. Drag inside it to move those pixels; Delete clears it; Ctrl+C / Ctrl+X copy / cut.",
  lasso: "Draw around an area to select it. Drag inside to move; Delete clears it.",
  polygon: "Click the corners; click the first point, double-click or press Enter to close.",
  pan: "Drag to move around. Ctrl+wheel zooms.",
  pen: "Draw freely. [ and ] change the width.", highlighter: "A translucent marker that doesn't hide what's under it.",
  eraser: "Erase pixels. Undo brings them back.",
  line: "Drag to draw. Shift snaps to 45°.", arrow: "Drag towards what you point at. Shift snaps to 45°.",
  rect: "Drag to draw. Shift makes a square.", ellipse: "Drag to draw. Shift makes a circle.",
  text: "Click where the text goes. Ctrl+Enter or click away to finish.",
  fill: "Click an area to fill it with the current colour.", eyedropper: "Click to pick a colour from the picture.",
  crop: "Drag the area to keep.",
}[id] ?? "");

function setTool(id) {
  if (polygonDraft && id !== "polygon") { polygonDraft = null; polygonCursor = null; }
  if (!["marquee", "lasso", "polygon"].includes(id)) region = null;
  if (!["select"].includes(id)) selection.clear();
  tool = id;
  viewport.dataset.tool = id;
  renderTools();
  renderProps();
  render();
  $("#status").textContent = hintFor(id);
}

function renderTools() {
  $("#tools").replaceChildren(...TOOLS.map((t) => (t === "-" ? h("span.sep") : iconButton(t.icon, `${t.label} (${t.key.toUpperCase()})`, () => setTool(t.id), { pressed: tool === t.id }))));
}

function renderHistory() {
  const [undoButton, redoButton] = [iconButton("undo", "Undo (Ctrl+Z)", undo, { small: true }), iconButton("redo", "Redo (Ctrl+Shift+Z)", redo, { small: true })];
  undoButton.disabled = !undoStack.length;
  redoButton.disabled = !redoStack.length;
  $("#history").replaceChildren(undoButton, redoButton);
}

function renderChrome() {
  renderTools();
  renderHistory();
  $("#file-actions").replaceChildren(
    iconButton("note_add", "New canvas (Ctrl+N)", newCanvas, { small: true }),
    iconButton("photo_library", "Open an image (Ctrl+O)", () => $("#file-input").click(), { small: true }),
    iconButton("content_paste", "Paste (Ctrl+V)", paste, { small: true }),
    iconButton("content_copy", "Copy the whole picture (Ctrl+Shift+C)", copyPicture, { small: true }),
    iconButton("download", "Save as PNG (Ctrl+S)", download, { small: true }),
    iconButton("keyboard", "Keyboard shortcuts", showShortcuts, { small: true }),
    iconButton("tune", "Show or hide the style panel", () => {
      if (document.body.classList.contains("narrow")) document.body.classList.toggle("props-shown");
      else document.body.classList.toggle("props-hidden");
      render();
    }, { small: true }),
  );
  renderProps();
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

function swatches(current, onPick, { allowNone = false } = {}) {
  const colors = allowNone ? [null, ...PALETTE.slice(0, 11)] : PALETTE;
  return h("div.swatches", {}, ...colors.map((color) => h(`button.swatch${color ? "" : ".none"}`, {
    type: "button", title: color ? `Colour ${color}` : "No fill", "aria-pressed": String(current === color), style: color ? { background: color } : {}, onclick: () => onPick(color),
  })));
}

function slider(label, value, min, max, step, onInput, format = (v) => v) {
  const output = h("output", {}, format(value));
  const input = h("input", { type: "range", min, max, step, value, "aria-label": label, title: label, oninput: () => { output.textContent = format(Number(input.value)); onInput(Number(input.value)); } });
  return h("div", {}, h("h3", {}, label), h("div.slider", {}, input, output));
}

function applyToSelection(patch) {
  const objects = selectedObjects().filter((o) => o.type !== "image" && o.type !== "erase");
  if (!objects.length) return;
  commit();
  for (const o of objects) replace(o.id, { ...o, ...patch });
  render();
}

function renderProps() {
  const objects = selectedObjects();
  const one = objects.length === 1 ? objects[0] : null;
  const shapeFill = ["rect", "ellipse"].includes(tool) || objects.some((o) => o.type === "rect" || o.type === "ellipse");
  const custom = h("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(style.color) ? style.color : "#000000", "aria-label": "Custom colour", title: "Custom colour", oninput: (e) => { style.color = e.target.value; renderProps(); applyToSelection({ color: style.color }); } });
  const widthInput = h("input.input.size-input", { type: "number", min: 16, max: 10000, value: doc.width, "aria-label": "Canvas width", title: "Canvas width in pixels" });
  const heightInput = h("input.input.size-input", { type: "number", min: 16, max: 10000, value: doc.height, "aria-label": "Canvas height", title: "Canvas height in pixels" });
  const applySize = () => { if (Number(widthInput.value) !== doc.width || Number(heightInput.value) !== doc.height) { resizeCanvas(Number(widthInput.value), Number(heightInput.value)); fit(); } };
  for (const input of [widthInput, heightInput]) input.addEventListener("change", applySize);
  $("#props").replaceChildren(...[
    h("div", {}, h("h3", {}, "Colour"), swatches(style.color, (c) => { style.color = c; renderProps(); applyToSelection({ color: c }); }), h("div.color-row", {}, custom, h("span.hex", {}, style.color))),
    shapeFill ? h("div", {}, h("h3", {}, "Fill"), swatches(style.fill, (c) => { style.fill = c; renderProps(); applyToSelection({ fill: c }); }, { allowNone: true })) : null,
    tool === "text" || one?.type === "text"
      ? slider("Text size", one?.size ?? style.fontSize, 10, 160, 1, (v) => { style.fontSize = v; if (one) { replace(one.id, { ...one, size: v }); render(); } })
      : slider("Stroke width", one?.width ?? style.width, 1, 48, 1, (v) => { style.width = v; for (const o of selectedObjects()) if (o.width !== undefined && o.type !== "image") replace(o.id, { ...o, width: v }); render(); }, (v) => `${v}px`),
    slider("Opacity", Math.round((one?.opacity ?? style.opacity) * 100), 10, 100, 1, (v) => { style.opacity = v / 100; for (const o of selectedObjects()) replace(o.id, { ...o, opacity: v / 100 }); render(); }, (v) => `${v}%`),
    objects.length ? h("div", {}, h("h3", {}, objects.length > 1 ? `${objects.length} objects` : "Arrange"), h("div.row-buttons", {},
      h("button.btn", { type: "button", title: "Bring to front", onclick: () => { commit(); doc.objects = [...doc.objects.filter((o) => !selection.has(o.id)), ...objects]; dirty = true; render(); } }, icon("flip_to_front", { size: 16 }), "Front"),
      h("button.btn", { type: "button", title: "Send to back", onclick: () => { commit(); doc.objects = [...objects, ...doc.objects.filter((o) => !selection.has(o.id))]; dirty = true; render(); } }, icon("flip_to_back", { size: 16 }), "Back"),
      h("button.btn", { type: "button", title: "Duplicate (Ctrl+D)", onclick: duplicate }, icon("content_copy", { size: 16 }), "Copy"),
      h("button.btn", { type: "button", title: "Delete (Del)", onclick: deleteSelection }, icon("delete", { size: 16 }), "Delete"))) : null,
    region ? h("div", {}, h("h3", {}, "Selected area"), h("div.row-buttons", {},
      h("button.btn", { type: "button", title: "Copy (Ctrl+C)", onclick: () => copySelection() }, icon("content_copy", { size: 16 }), "Copy"),
      h("button.btn", { type: "button", title: "Cut (Ctrl+X)", onclick: () => copySelection({ cut: true }) }, icon("content_cut", { size: 16 }), "Cut"),
      h("button.btn", { type: "button", title: "Clear the area (Del)", onclick: deleteSelection }, icon("delete", { size: 16 }), "Clear"),
      h("button.btn", { type: "button", title: "Crop the canvas to this area", onclick: () => { applyCrop(regionBounds(region)); region = null; } }, icon("crop", { size: 16 }), "Crop"))) : null,
    h("div", {}, h("h3", {}, "Canvas"),
      h("div.size-row", {}, widthInput, h("span", {}, "×"), heightInput),
      h("div.row-buttons", {},
        h("button.btn", { type: "button", title: "Shrink or grow the canvas around what is drawn", onclick: fitCanvasToContent }, icon("aspect_ratio", { size: 16 }), "Fit to content"),
        ...[["#ffffff", "White"], ["transparent", "None"], ["#1b1f27", "Dark"]].map(([bg, label]) => h("button.btn", { type: "button", title: `${label} background`, "aria-pressed": String(doc.background === bg), onclick: () => { commit(); doc.background = bg; render(); renderProps(); } }, label))),
      h("p.hint", {}, "Or drag the dot at the canvas corner with the Select tool.")),
  ].filter(Boolean));
}

function renderZoom() {
  $("#zoom-controls").replaceChildren(
    iconButton("zoom_out", "Zoom out (Ctrl+−)", () => zoomCenter(1 / 1.2), { small: true }),
    h("span.zoom", { title: "Zoom" }, `${Math.round(view.scale * 100)}%`),
    iconButton("zoom_in", "Zoom in (Ctrl+=)", () => zoomCenter(1.2), { small: true }),
    iconButton("fit_screen", "Fit to window (Ctrl+0)", fit, { small: true }),
  );
}

$("#send").append(icon("send", { size: 18 }), "Send to agent");
$("#send").title = "Attach the picture to the chat (Ctrl+Enter)";
$("#send").addEventListener("click", () => sendToAgent().catch((error) => toast(error.message)));
$(".empty-card").append(icon("brush"), h("strong", {}, "Paste, draw, send"), h("span", {}, "Ctrl+V pastes a screenshot. Mark it up, then send it to the agent."));

// Paint owns the keyboard while it is focused: these shortcuts win over
// Thunderbird's and the page's defaults (Ctrl+A selects drawn objects, etc.).
addEventListener("keydown", (event) => {
  if (!textEditor.hidden || event.target.closest?.("input, textarea, select, .dialog")) return;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  const take = () => { event.preventDefault(); event.stopPropagation(); };
  if (mod) {
    const actions = {
      z: () => (event.shiftKey ? redo() : undo()), y: redo, a: selectAll, d: duplicate,
      c: () => (event.shiftKey ? copyPicture() : copySelection()), x: () => copySelection({ cut: true }), v: paste,
      n: newCanvas, o: () => $("#file-input").click(), s: download,
      0: fit, 1: actualSize, "=": () => zoomCenter(1.2), "+": () => zoomCenter(1.2), "-": () => zoomCenter(1 / 1.2),
      enter: () => sendToAgent().catch((error) => toast(error.message)),
    };
    const action = actions[key];
    if (action) { take(); void action(); }
    return;
  }
  if (event.altKey) return;
  if (key === " " && !spaceDown) { spaceDown = true; viewport.classList.add("panning"); take(); return; }
  if (key === "delete" || key === "backspace") {
    if (polygonDraft && key === "backspace") { polygonDraft.pop(); if (!polygonDraft.length) polygonDraft = null; render(); take(); return; }
    take(); deleteSelection(); return;
  }
  if (key === "enter" && polygonDraft) { take(); closePolygon(); return; }
  if (key === "escape") { take(); selection.clear(); region = null; polygonDraft = null; cropRect = null; bandRect = null; render(); renderProps(); return; }
  if (key === "+" || key === "=") { take(); zoomCenter(1.2); return; }
  if (key === "-") { take(); zoomCenter(1 / 1.2); return; }
  if (key === "[" || key === "]") { take(); style.width = Math.max(1, Math.min(48, style.width + (key === "]" ? 2 : -2))); renderProps(); status(`Stroke ${style.width}px`); return; }
  if (key.startsWith("arrow")) {
    const step = event.shiftKey ? 10 : 1;
    const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[key];
    if (d && (selection.size || region)) { take(); nudge(...d); }
    return;
  }
  const found = TOOLS.find((t) => t !== "-" && t.key === key);
  if (found) { take(); setTool(found.id); }
}, true);
addEventListener("keyup", (event) => { if (event.key === " ") { spaceDown = false; viewport.classList.remove("panning"); } });
new ResizeObserver(() => { document.body.classList.toggle("narrow", innerWidth < 900); render(); }).observe(viewport);

// ------------------------------------------------------------- agent API --

const SHAPE_TYPES = new Set(["stroke", "line", "arrow", "rect", "ellipse", "text"]);
registerPage("paint", {
  state: () => ({
    width: doc.width, height: doc.height, background: doc.background, tool, color: style.color,
    objects: doc.objects.length,
    kinds: doc.objects.reduce((acc, o) => ({ ...acc, [o.type]: (acc[o.type] ?? 0) + 1 }), {}),
    selected: selectedObjects().map((o) => ({ id: o.id, type: o.type })),
    area: region ? regionBounds(region) : null,
  }),
  commands: {
    snapshot: async () => uploadDrawing(),
    "insert-image": async ({ path }) => { await addImageFromPath(path); return { objects: doc.objects.length }; },
    "add-shapes": async ({ shapes = [] }) => {
      const valid = shapes.filter((s) => SHAPE_TYPES.has(s.type)).map((s) => ({ color: style.color, width: style.width, opacity: 1, size: style.fontSize, ...s, id: newId(), ...(s.type === "stroke" ? { mode: "pen" } : {}) }));
      if (!valid.length) throw new Error("No valid shapes: use stroke, line, arrow, rect, ellipse or text");
      commit(`Added ${valid.length} shapes`);
      doc.objects.push(...valid);
      dirty = true; render();
      return { added: valid.length };
    },
    clear: () => { newCanvas(); return { objects: 0 }; },
    tool: ({ name }) => { if (!TOOLS.some((t) => t !== "-" && t.id === name)) throw new Error(`Unknown tool ${name}`); setTool(name); return { tool }; },
    resize: ({ width, height }) => { resizeCanvas(width, height); fit(); return { width: doc.width, height: doc.height }; },
  },
});

// ------------------------------------------------------------------ start --

// Paint starts empty every time; earlier versions kept a drawing between sessions.
indexedDB.deleteDatabase("mail-workspace-paint");
renderChrome();
setTool("pen");
fit();
