// Paint: a small object-based drawing space. Shapes, strokes, text and images
// stay editable until the end; the eraser and the bucket fill work on pixels
// (erasing is a stroke drawn with destination-out, a fill becomes an image).
// Paste a screenshot, mark it up, and send it to the agent.
import { broker, host, HOST_ENDPOINT, json } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, toast, background, registerPage } from "./shared/page.js";

const viewport = $("#viewport");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const textEditor = $("#text-editor");

const PALETTE = ["#1b1f27", "#ffffff", "#e53935", "#fb8c00", "#fdd835", "#43a047", "#00acc1", "#1e88e5", "#5e35b1", "#d81b60", "#8d6e63", "#9e9e9e"];
const TOOLS = [
  { id: "select", icon: "arrow_selector_tool", label: "Select and move", key: "v" },
  { id: "pan", icon: "pan_tool", label: "Pan (hold Space)", key: "h" },
  "-",
  { id: "pen", icon: "draw", label: "Pen", key: "p" },
  { id: "highlighter", icon: "ink_highlighter", label: "Highlighter", key: "m" },
  { id: "eraser", icon: "ink_eraser", label: "Eraser", key: "e" },
  "-",
  { id: "line", icon: "horizontal_rule", label: "Line", key: "l" },
  { id: "arrow", icon: "north_east", label: "Arrow", key: "a" },
  { id: "rect", icon: "rectangle", label: "Rectangle", key: "r" },
  { id: "ellipse", icon: "circle", label: "Ellipse", key: "o" },
  { id: "text", icon: "title", label: "Text", key: "t" },
  "-",
  { id: "fill", icon: "format_color_fill", label: "Fill area", key: "f" },
  { id: "eyedropper", icon: "colorize", label: "Pick colour", key: "i" },
  { id: "crop", icon: "crop", label: "Crop canvas", key: "c" },
];

// ------------------------------------------------------------- document --

let doc = { width: 1600, height: 1000, background: "#ffffff", objects: [] };
const style = { color: "#e53935", fill: null, width: 4, opacity: 1, fontSize: 28 };
let tool = "pen";
let selected = null; // index into doc.objects
const images = new Map(); // src → HTMLImageElement
const undoStack = [];
const redoStack = [];
const view = { scale: 1, x: 0, y: 0 };
let draft = null; // shape being drawn
let layer = document.createElement("canvas"); // objects without background
let dirty = true;

let nextId = 1;
const newId = () => `o${Date.now().toString(36)}${(nextId++).toString(36)}`;

function snapshotState() { return { width: doc.width, height: doc.height, background: doc.background, objects: [...doc.objects] }; }
function commit(label) {
  undoStack.push(snapshotState());
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  dirty = true;
  if (label) status(label);
}
function restore(state) { doc = { ...state, objects: [...state.objects] }; selected = null; dirty = true; render(); renderChrome(); scheduleSave(); }
function undo() { if (!undoStack.length) return; redoStack.push(snapshotState()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshotState()); restore(redoStack.pop()); }

/** Replace an object immutably (history snapshots share unchanged objects). */
function update(index, patch) { doc.objects[index] = { ...doc.objects[index], ...patch }; dirty = true; }

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
    const mx = (points[i][0] + points[i + 1][0]) / 2;
    const my = (points[i][1] + points[i + 1][1]) / 2;
    c.quadraticCurveTo(points[i][0], points[i][1], mx, my);
  }
  const last = points.at(-1);
  c.lineTo(last[0], last[1]);
  c.stroke();
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
    case "stroke":
      if (o.mode === "eraser") { c.globalCompositeOperation = "destination-out"; c.globalAlpha = 1; }
      if (o.mode === "highlighter") c.globalCompositeOperation = "multiply";
      strokePath(c, o.points);
      break;
    case "line":
    case "arrow": {
      c.beginPath(); c.moveTo(o.x1, o.y1); c.lineTo(o.x2, o.y2); c.stroke();
      if (o.type === "arrow") {
        const angle = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
        const size = Math.max(12, o.width * 3.5);
        c.beginPath();
        c.moveTo(o.x2, o.y2);
        c.lineTo(o.x2 - size * Math.cos(angle - Math.PI / 7), o.y2 - size * Math.sin(angle - Math.PI / 7));
        c.lineTo(o.x2 - size * Math.cos(angle + Math.PI / 7), o.y2 - size * Math.sin(angle + Math.PI / 7));
        c.closePath(); c.fill();
      }
      break;
    }
    case "rect":
    case "ellipse": {
      const x = Math.min(o.x, o.x + o.w); const y = Math.min(o.y, o.y + o.h); const w = Math.abs(o.w); const hgt = Math.abs(o.h);
      c.beginPath();
      if (o.type === "rect") c.roundRect(x, y, w, hgt, Math.min(8, w / 4, hgt / 4)); else c.ellipse(x + w / 2, y + hgt / 2, w / 2, hgt / 2, 0, 0, Math.PI * 2);
      if (o.fill) { c.fillStyle = o.fill; c.fill(); }
      if (o.width > 0) c.stroke();
      break;
    }
    case "text": {
      c.font = `600 ${o.size}px ${getComputedStyle(document.body).fontFamily}`;
      c.textBaseline = "top";
      o.text.split("\n").forEach((line, i) => c.fillText(line, o.x, o.y + i * o.size * 1.25));
      break;
    }
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
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function renderLayer() {
  if (layer.width !== doc.width || layer.height !== doc.height) { layer.width = doc.width; layer.height = doc.height; }
  const c = layer.getContext("2d");
  c.clearRect(0, 0, layer.width, layer.height);
  for (const o of doc.objects) drawObject(c, o);
  if (draft) drawObject(c, draft);
  dirty = false;
}

/** The finished picture at document resolution. */
function composite() {
  if (dirty || draft) renderLayer();
  const out = document.createElement("canvas");
  out.width = doc.width;
  out.height = doc.height;
  const c = out.getContext("2d");
  c.fillStyle = doc.background;
  c.fillRect(0, 0, out.width, out.height);
  c.drawImage(layer, 0, 0);
  return out;
}

function toScreen(x, y) { return [x * view.scale + view.x, y * view.scale + view.y]; }
function toDoc(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  return [(clientX - rect.left - view.x) / view.scale, (clientY - rect.top - view.y) / view.scale];
}

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
  ctx.fillStyle = doc.background;
  ctx.fillRect(0, 0, doc.width, doc.height);
  ctx.shadowColor = "transparent";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
  // Selection and crop overlays, in screen space so they stay crisp.
  const primary = getComputedStyle(document.documentElement).getPropertyValue("--mw-primary").trim();
  if (selected !== null && doc.objects[selected]) {
    const b = bounds(doc.objects[selected]);
    const [x, y] = toScreen(b.x, b.y);
    ctx.strokeStyle = primary; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.strokeRect(x - 4, y - 4, b.w * view.scale + 8, b.h * view.scale + 8);
    ctx.setLineDash([]);
    for (const [hx, hy] of handles(b)) { ctx.fillStyle = "#fff"; ctx.strokeStyle = primary; ctx.beginPath(); ctx.rect(hx - 5, hy - 5, 10, 10); ctx.fill(); ctx.stroke(); }
  }
  if (cropRect) {
    const r = normal(cropRect);
    const [x, y] = toScreen(r.x, r.y);
    ctx.fillStyle = "rgba(10,12,18,0.45)";
    const [dx, dy] = toScreen(0, 0);
    ctx.fillRect(dx, dy, doc.width * view.scale, doc.height * view.scale);
    ctx.clearRect(x, y, r.w * view.scale, r.h * view.scale);
    ctx.drawImage(layer, r.x, r.y, r.w, r.h, x, y, r.w * view.scale, r.h * view.scale);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, r.w * view.scale, r.h * view.scale);
  }
  $("#empty").hidden = doc.objects.length > 0 || Boolean(draft);
  $("#doc-size").textContent = `${doc.width} × ${doc.height}`;
}

function handles(b) {
  const [x, y] = toScreen(b.x, b.y);
  const w = b.w * view.scale; const hh = b.h * view.scale;
  return [[x - 4, y - 4], [x + w + 4, y - 4], [x - 4, y + hh + 4], [x + w + 4, y + hh + 4]];
}

const normal = (r) => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });

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
    if (o.type === "stroke" && o.mode === "eraser") continue;
    if (o.type === "stroke") {
      for (let j = 0; j < o.points.length; j++) {
        const a = o.points[j]; const b = o.points[j + 1] ?? a;
        if (distanceToSegment(x, y, a[0], a[1], b[0], b[1]) <= o.width / 2 + slack) return i;
      }
      continue;
    }
    if (o.type === "line" || o.type === "arrow") { if (distanceToSegment(x, y, o.x1, o.y1, o.x2, o.y2) <= o.width / 2 + slack) return i; continue; }
    const b = bounds(o);
    if (x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack) return i;
  }
  return null;
}

function handleAt(clientX, clientY) {
  if (selected === null) return null;
  const rect = viewport.getBoundingClientRect();
  const list = handles(bounds(doc.objects[selected]));
  const index = list.findIndex(([hx, hy]) => Math.abs(clientX - rect.left - hx) < 9 && Math.abs(clientY - rect.top - hy) < 9);
  return index < 0 ? null : index;
}

/** Scale an object from its bounds `from` to `to`. */
function scaleObject(o, from, to) {
  const sx = to.w / (from.w || 1); const sy = to.h / (from.h || 1);
  const mx = (x) => to.x + (x - from.x) * sx; const my = (y) => to.y + (y - from.y) * sy;
  switch (o.type) {
    case "image": case "rect": case "ellipse": return { ...o, x: mx(Math.min(o.x, o.x + o.w)), y: my(Math.min(o.y, o.y + o.h)), w: Math.abs(o.w) * sx, h: Math.abs(o.h) * sy };
    case "line": case "arrow": return { ...o, x1: mx(o.x1), y1: my(o.y1), x2: mx(o.x2), y2: my(o.y2) };
    case "stroke": return { ...o, points: o.points.map(([x, y, p]) => [mx(x), my(y), p]) };
    case "text": return { ...o, x: mx(o.x), y: my(o.y), size: Math.max(6, o.size * sy) };
  }
  return o;
}

function translateObject(o, dx, dy) {
  switch (o.type) {
    case "line": case "arrow": return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case "stroke": return { ...o, points: o.points.map(([x, y, p]) => [x + dx, y + dy, p]) };
    default: return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

// ------------------------------------------------------------ pixel ops --

function floodFill(x, y) {
  const image = composite();
  const c = image.getContext("2d", { willReadFrequently: true });
  const { width, height } = image;
  const data = c.getImageData(0, 0, width, height).data;
  const sx = Math.floor(x); const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return;
  const at = (i) => [data[i], data[i + 1], data[i + 2], data[i + 3]];
  const target = at((sy * width + sx) * 4);
  const tolerance = 48;
  const same = (i) => Math.abs(data[i] - target[0]) + Math.abs(data[i + 1] - target[1]) + Math.abs(data[i + 2] - target[2]) + Math.abs(data[i + 3] - target[3]) <= tolerance;
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
  const w = maxX - minX + 1; const hgt = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = w; out.height = hgt;
  const oc = out.getContext("2d");
  const pixels = oc.createImageData(w, hgt);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(style.color.slice(i, i + 2), 16));
  for (let yy = 0; yy < hgt; yy++) for (let xx = 0; xx < w; xx++) {
    if (!mask[(minY + yy) * width + minX + xx]) continue;
    const i = (yy * w + xx) * 4;
    pixels.data[i] = r; pixels.data[i + 1] = g; pixels.data[i + 2] = b; pixels.data[i + 3] = 255;
  }
  oc.putImageData(pixels, 0, 0);
  const src = out.toDataURL("image/png");
  images.set(src, out); // a canvas draws like an image
  commit("Filled area");
  doc.objects.push({ id: newId(), type: "image", fill: true, src, x: minX, y: minY, w, h: hgt, opacity: style.opacity });
  dirty = true;
  render();
  scheduleSave();
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
  scheduleSave();
}

// ------------------------------------------------------------- pointer --

let pointer = null;
let cropRect = null;
let spaceDown = false;

viewport.addEventListener("pointerdown", (event) => {
  if (event.button === 1 || spaceDown || tool === "pan") return startPan(event);
  if (event.button !== 0) return;
  viewport.focus();
  viewport.setPointerCapture(event.pointerId);
  const [x, y] = toDoc(event.clientX, event.clientY);
  const base = { color: style.color, width: style.width, opacity: style.opacity };
  pointer = { x, y, startX: x, startY: y };
  switch (tool) {
    case "select": {
      const handle = handleAt(event.clientX, event.clientY);
      if (handle !== null) { pointer.resize = { handle, from: bounds(doc.objects[selected]), original: doc.objects[selected] }; commit(); break; }
      selected = hit(x, y);
      if (selected !== null) { pointer.move = { original: doc.objects[selected] }; commit(); }
      renderProps();
      break;
    }
    case "pen": draft = { id: newId(), type: "stroke", mode: "pen", points: [[x, y, event.pressure || 0.5]], ...base }; break;
    case "highlighter": draft = { id: newId(), type: "stroke", mode: "highlighter", points: [[x, y, 0.5]], ...base, width: Math.max(style.width * 3, 14), opacity: 0.45, color: style.color }; break;
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

viewport.addEventListener("pointermove", (event) => {
  if (!pointer) {
    if (tool === "select") viewport.style.cursor = handleAt(event.clientX, event.clientY) !== null ? "nwse-resize" : hit(...toDoc(event.clientX, event.clientY)) !== null ? "move" : "";
    return;
  }
  let [x, y] = toDoc(event.clientX, event.clientY);
  const shift = event.shiftKey;
  if (pointer.resize) {
    const { from, handle, original } = pointer.resize;
    const left = handle === 0 || handle === 2; const top = handle === 0 || handle === 1;
    let nx = left ? x : from.x; let ny = top ? y : from.y;
    let nw = left ? from.x + from.w - x : x - from.x; let nh = top ? from.y + from.h - y : y - from.y;
    if (shift || original.type === "image" || original.type === "text") { const ratio = from.w / (from.h || 1); nh = nw / ratio; if (top) ny = from.y + from.h - nh; }
    if (nw > 2 && nh > 2) { doc.objects[selected] = scaleObject(original, from, { x: nx, y: ny, w: nw, h: nh }); dirty = true; }
  } else if (pointer.move) {
    doc.objects[selected] = translateObject(pointer.move.original, x - pointer.startX, y - pointer.startY);
    dirty = true;
  } else if (draft?.type === "stroke") {
    for (const e of event.getCoalescedEvents?.() ?? [event]) { const [cx, cy] = toDoc(e.clientX, e.clientY); draft.points.push([cx, cy, e.pressure || 0.5]); }
  } else if (draft?.type === "line" || draft?.type === "arrow") {
    if (shift) { const angle = Math.round(Math.atan2(y - draft.y1, x - draft.x1) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(x - draft.x1, y - draft.y1); x = draft.x1 + len * Math.cos(angle); y = draft.y1 + len * Math.sin(angle); }
    draft.x2 = x; draft.y2 = y;
  } else if (draft) {
    let w = x - draft.x; let hh = y - draft.y;
    if (shift) { const size = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * size; hh = Math.sign(hh || 1) * size; }
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
  if (cropRect) { applyCrop(cropRect); cropRect = null; }
  if (pointer.move || pointer.resize) {
    const last = undoStack.at(-1);
    if (last && last.objects[selected] === doc.objects[selected]) undoStack.pop(); // a click, not a move
  }
  pointer = null;
  render();
  renderChrome();
  scheduleSave();
}
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);
viewport.addEventListener("dblclick", (event) => {
  if (tool !== "select" || selected === null) return;
  const o = doc.objects[selected];
  if (o.type === "text") startText(o.x, o.y, selected);
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

function startText(x, y, editIndex = null) {
  const existing = editIndex !== null ? doc.objects[editIndex] : null;
  const size = existing?.size ?? style.fontSize;
  const [sx, sy] = toScreen(x, y);
  Object.assign(textEditor.style, {
    left: `${sx}px`, top: `${sy}px`, font: `600 ${size * view.scale}px ${getComputedStyle(document.body).fontFamily}`,
    color: existing?.color ?? style.color, width: "auto", height: "auto",
  });
  textEditor.value = existing?.text ?? "";
  textEditor.hidden = false;
  const resize = () => { textEditor.style.width = "10px"; textEditor.style.width = `${textEditor.scrollWidth + 8}px`; textEditor.style.height = "10px"; textEditor.style.height = `${textEditor.scrollHeight}px`; };
  resize();
  textEditor.oninput = resize;
  setTimeout(() => textEditor.focus());
  const done = () => {
    textEditor.hidden = true;
    textEditor.onblur = null;
    const text = textEditor.value.replace(/\s+$/, "");
    if (existing) {
      commit();
      if (text) update(editIndex, { text }); else { doc.objects.splice(editIndex, 1); selected = null; }
    } else if (text) {
      commit("Added text");
      doc.objects.push({ id: newId(), type: "text", x, y, text, color: style.color, size, opacity: style.opacity });
    }
    dirty = true;
    render();
    scheduleSave();
  };
  textEditor.onblur = done;
  textEditor.onkeydown = (event) => {
    if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); textEditor.blur(); }
    event.stopPropagation();
  };
}

// ---------------------------------------------------------------- images --

async function addImage(src, { name } = {}) {
  const img = await loadImage(src);
  commit(`Added ${name ?? "image"}`);
  if (!doc.objects.length) { doc.width = img.naturalWidth; doc.height = img.naturalHeight; }
  const scale = Math.min(1, (doc.width * 0.9) / img.naturalWidth, (doc.height * 0.9) / img.naturalHeight);
  const w = img.naturalWidth * (doc.objects.length ? scale : 1);
  const hh = img.naturalHeight * (doc.objects.length ? scale : 1);
  doc.objects.push({ id: newId(), type: "image", src, x: (doc.width - w) / 2, y: (doc.height - hh) / 2, w, h: hh, opacity: 1 });
  selected = doc.objects.length - 1;
  dirty = true;
  if (doc.objects.length === 1) fit(); else render();
  renderChrome();
  scheduleSave();
}

const fileToDataUrl = (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });

addEventListener("paste", async (event) => {
  if (!textEditor.hidden) return;
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

async function pasteFromClipboard() {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) { await addImage(await fileToDataUrl(await item.getType(type)), { name: "pasted image" }); return; }
    }
    toast("No image on the clipboard");
  } catch { toast("Press Ctrl+V to paste"); }
}

/** Load an image from a path on disk (through the workspace host). */
async function addImageFromPath(path) {
  const { url } = await host("/v1/links", json({ path }));
  const blob = await (await fetch(`${HOST_ENDPOINT}${url}`)).blob();
  await addImage(await fileToDataUrl(blob), { name: path.split("/").pop() });
}

// ---------------------------------------------------------------- export --

const exportBlob = () => new Promise((resolve) => composite().toBlob(resolve, "image/png"));

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

async function copyImage() {
  try { await navigator.clipboard.write([new ClipboardItem({ "image/png": await exportBlob() })]); toast("Copied to the clipboard"); }
  catch (error) { toast(`Copy failed: ${error.message}`); }
}

function clearAll() {
  if (!doc.objects.length) return;
  commit("Cleared");
  doc.objects = [];
  selected = null;
  dirty = true;
  render();
  renderChrome();
  scheduleSave();
}

// ------------------------------------------------------------- autosave --

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const db = await openDb();
    db.transaction("paint", "readwrite").objectStore("paint").put({ doc }, "current");
  }, 800);
}
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("mail-workspace-paint", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("paint");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function restoreSaved() {
  try {
    const db = await openDb();
    const saved = await new Promise((resolve) => { const r = db.transaction("paint").objectStore("paint").get("current"); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
    if (!saved?.doc) return;
    doc = saved.doc;
    await Promise.all(doc.objects.filter((o) => o.type === "image").map((o) => loadImage(o.src).catch(() => null)));
    dirty = true;
  } catch { /* nothing saved */ }
}

// ---------------------------------------------------------------- chrome --

let statusTimer;
function status(text) { $("#status").textContent = text; clearTimeout(statusTimer); statusTimer = setTimeout(() => { $("#status").textContent = hintFor(tool); }, 2500); }
const hintFor = (id) => ({
  select: "Click to select, drag to move, corners to resize. Delete removes. Double-click text to edit.",
  pan: "Drag to move around. Ctrl+wheel zooms.",
  pen: "Draw freely. Shift is not needed for pressure: pens report it.",
  highlighter: "Translucent marker that doesn't hide what's under it.",
  eraser: "Erase pixels. Undo brings them back.",
  line: "Drag to draw. Shift snaps to 45°.", arrow: "Drag to point at something. Shift snaps to 45°.",
  rect: "Drag to draw. Shift makes a square.", ellipse: "Drag to draw. Shift makes a circle.",
  text: "Click where the text goes. Ctrl+Enter or click away to finish.",
  fill: "Click an area to fill it with the current colour.", eyedropper: "Click to pick a colour from the picture.",
  crop: "Drag the area to keep.",
}[id] ?? "");

function setTool(id) {
  tool = id;
  viewport.dataset.tool = id;
  if (id !== "select") selected = null;
  renderChrome();
  render();
  $("#status").textContent = hintFor(id);
}

function renderChrome() {
  const tools = $("#tools");
  tools.replaceChildren(...TOOLS.map((t) => (t === "-" ? h("span.sep") : iconButton(t.icon, `${t.label} (${t.key.toUpperCase()})`, () => setTool(t.id), { pressed: tool === t.id }))));
  $("#history").replaceChildren(
    iconButton("undo", "Undo (Ctrl+Z)", undo, { small: true }),
    iconButton("redo", "Redo (Ctrl+Shift+Z)", redo, { small: true }),
  );
  $("#history").children[0].disabled = !undoStack.length;
  $("#history").children[1].disabled = !redoStack.length;
  $("#file-actions").replaceChildren(
    iconButton("content_paste", "Paste image", pasteFromClipboard, { small: true }),
    iconButton("photo_library", "Open image", () => $("#file-input").click(), { small: true }),
    iconButton("content_copy", "Copy picture", copyImage, { small: true }),
    iconButton("download", "Download PNG", download, { small: true }),
    iconButton("delete", "Clear canvas", clearAll, { small: true }),
  );
  renderProps();
}

function swatches(current, onPick, { allowNone = false } = {}) {
  const colors = allowNone ? [null, ...PALETTE.slice(0, 11)] : PALETTE;
  return h("div.swatches", {}, ...colors.map((color) => h(`button.swatch${color ? "" : ".none"}`, {
    type: "button", title: color ?? "No fill", "aria-pressed": String(current === color), style: color ? { background: color } : {}, onclick: () => onPick(color),
  })));
}

function slider(label, value, min, max, step, onInput, format = (v) => v) {
  const output = h("output", {}, format(value));
  const input = h("input", { type: "range", min, max, step, value, "aria-label": label, oninput: () => { output.textContent = format(Number(input.value)); onInput(Number(input.value)); } });
  return h("div", {}, h("h3", {}, label), h("div.slider", {}, input, output));
}

function applyToSelection(patch) {
  if (selected === null) return;
  commit();
  update(selected, patch);
  render();
  scheduleSave();
}

function renderProps() {
  const o = selected !== null ? doc.objects[selected] : null;
  const custom = h("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(style.color) ? style.color : "#000000", "aria-label": "Custom colour", oninput: (e) => { style.color = e.target.value; renderProps(); if (o) applyToSelection({ color: style.color }); } });
  $("#props").replaceChildren(...[
    h("div", {}, h("h3", {}, "Colour"), swatches(style.color, (c) => { style.color = c; renderProps(); if (o && o.type !== "image") applyToSelection({ color: c }); }), h("div.color-row", {}, custom, h("span.hex", {}, style.color))),
    ["rect", "ellipse"].includes(tool) || ["rect", "ellipse"].includes(o?.type)
      ? h("div", {}, h("h3", {}, "Fill"), swatches(style.fill, (c) => { style.fill = c; renderProps(); if (o) applyToSelection({ fill: c }); }, { allowNone: true }))
      : null,
    tool === "text" || o?.type === "text"
      ? slider("Text size", o?.size ?? style.fontSize, 10, 160, 1, (v) => { style.fontSize = v; if (o) { update(selected, { size: v }); render(); } })
      : slider("Stroke width", o?.width ?? style.width, 1, 48, 1, (v) => { style.width = v; if (o && o.type !== "image" && o.type !== "text") { update(selected, { width: v }); render(); } }, (v) => `${v}px`),
    slider("Opacity", Math.round((o?.opacity ?? style.opacity) * 100), 10, 100, 1, (v) => { style.opacity = v / 100; if (o) { update(selected, { opacity: v / 100 }); render(); } }, (v) => `${v}%`),
    o ? h("div", {}, h("h3", {}, "Arrange"), h("div.row-buttons", {},
      h("button.btn", { type: "button", onclick: () => { commit(); const [x] = doc.objects.splice(selected, 1); doc.objects.push(x); selected = doc.objects.length - 1; dirty = true; render(); } }, icon("flip_to_front", { size: 16 }), "Front"),
      h("button.btn", { type: "button", onclick: () => { commit(); const [x] = doc.objects.splice(selected, 1); doc.objects.unshift(x); selected = 0; dirty = true; render(); } }, icon("flip_to_back", { size: 16 }), "Back"),
      h("button.btn", { type: "button", onclick: deleteSelected }, icon("delete", { size: 16 }), "Delete"))) : null,
    h("div", {}, h("h3", {}, "Canvas"),
      h("div.row-buttons", {},
        ...[["#ffffff", "White"], ["transparent", "None"], ["#1b1f27", "Dark"]].map(([bg, label]) => h("button.btn", { type: "button", "aria-pressed": String(doc.background === bg), onclick: () => { commit(); doc.background = bg; render(); scheduleSave(); } }, label))),
      h("p.hint", {}, "Paste a screenshot with Ctrl+V, draw on it, then Send to agent.")),
  ].filter(Boolean));
}

function deleteSelected() {
  if (selected === null) return;
  commit("Deleted");
  doc.objects.splice(selected, 1);
  selected = null;
  dirty = true;
  render();
  renderChrome();
  scheduleSave();
}

function renderZoom() {
  $("#zoom-controls").replaceChildren(
    iconButton("zoom_out", "Zoom out (−)", () => { const r = viewport.getBoundingClientRect(); zoomAt(1 / 1.2, r.width / 2, r.height / 2); }, { small: true }),
    h("span.zoom", {}, `${Math.round(view.scale * 100)}%`),
    iconButton("zoom_in", "Zoom in (+)", () => { const r = viewport.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); }, { small: true }),
    iconButton("fit_screen", "Fit (Ctrl+0)", fit, { small: true }),
  );
}

$("#send").append(icon("send", { size: 18 }), "Send to agent");
$("#send").addEventListener("click", () => sendToAgent().catch((error) => toast(error.message)));
$(".empty-card").append(icon("brush"), h("strong", {}, "Paste, draw, send"), h("span", {}, "Ctrl+V pastes a screenshot. Mark it up, then send it to the agent."));

addEventListener("keydown", (event) => {
  if (!textEditor.hidden || event.target.closest?.("input, textarea")) return;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
  if (mod && key === "y") { event.preventDefault(); redo(); return; }
  if (mod && key === "0") { event.preventDefault(); fit(); return; }
  if (mod && key === "1") { event.preventDefault(); actualSize(); return; }
  if (mod && key === "c" && selected === null) { event.preventDefault(); void copyImage(); return; }
  if (mod && key === "s") { event.preventDefault(); void download(); return; }
  if (mod) return;
  if (key === " " && !spaceDown) { spaceDown = true; viewport.classList.add("panning"); event.preventDefault(); return; }
  if ((key === "delete" || key === "backspace") && selected !== null) { event.preventDefault(); deleteSelected(); return; }
  if (key === "escape") { selected = null; cropRect = null; render(); renderProps(); return; }
  if (key === "+" || key === "=") { const r = viewport.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); return; }
  if (key === "-") { const r = viewport.getBoundingClientRect(); zoomAt(1 / 1.2, r.width / 2, r.height / 2); return; }
  if (selected !== null && key.startsWith("arrow")) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[key];
    commit();
    doc.objects[selected] = translateObject(doc.objects[selected], ...d);
    dirty = true; render(); scheduleSave();
    return;
  }
  const found = TOOLS.find((t) => t !== "-" && t.key === key);
  if (found) setTool(found.id);
});
addEventListener("keyup", (event) => { if (event.key === " ") { spaceDown = false; viewport.classList.remove("panning"); } });
new ResizeObserver(() => render()).observe(viewport);

// ------------------------------------------------------------- agent API --

const SHAPE_TYPES = new Set(["stroke", "line", "arrow", "rect", "ellipse", "text"]);
registerPage("paint", {
  state: () => ({
    width: doc.width, height: doc.height, background: doc.background, tool, color: style.color,
    objects: doc.objects.length,
    kinds: doc.objects.reduce((acc, o) => ({ ...acc, [o.type]: (acc[o.type] ?? 0) + 1 }), {}),
    selected: selected !== null ? { index: selected, type: doc.objects[selected].type } : null,
  }),
  commands: {
    snapshot: async () => uploadDrawing(),
    "insert-image": async ({ path }) => { await addImageFromPath(path); return { objects: doc.objects.length }; },
    "add-shapes": async ({ shapes = [] }) => {
      const valid = shapes.filter((s) => SHAPE_TYPES.has(s.type)).map((s) => ({ color: style.color, width: style.width, opacity: 1, size: style.fontSize, ...s, id: newId(), ...(s.type === "stroke" ? { mode: "pen" } : {}) }));
      if (!valid.length) throw new Error("No valid shapes: use stroke, line, arrow, rect, ellipse or text");
      commit(`Added ${valid.length} shapes`);
      doc.objects.push(...valid);
      dirty = true; render(); scheduleSave();
      return { added: valid.length };
    },
    clear: () => { clearAll(); return { objects: 0 }; },
    tool: ({ name }) => { if (!TOOLS.some((t) => t.id === name)) throw new Error(`Unknown tool ${name}`); setTool(name); return { tool }; },
    resize: ({ width, height }) => { commit("Resized canvas"); doc.width = Math.max(16, Math.min(8000, Number(width))); doc.height = Math.max(16, Math.min(8000, Number(height))); dirty = true; fit(); return { width: doc.width, height: doc.height }; },
  },
});

// ------------------------------------------------------------------ start --

await restoreSaved();
setTool("pen");
fit();
