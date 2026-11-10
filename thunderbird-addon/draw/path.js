// Draw: path data as nodes with handles, the way the node tool and the pen work on it.
//
// A path is a list of subpaths; a subpath is a list of nodes and whether it is closed. Each node has
// its point `p`, its handles `in` (towards the previous node) and `out` (towards the next), or null,
// and `kind`: how the segment arriving at it is drawn ("M" for the first node, "L" straight, "C"
// cubic, "A" an elliptical arc with its `arc` parameters). Quadratic curves become cubic ones (the
// same shape). A closed subpath whose last node sits on its first is folded into the first.

import { fmt } from "./geometry.js";

const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Path data as [command, numbers] pairs, absolute or relative as written. */
export function tokenize(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let command = null;
  let numbers = [];
  for (let i = 0; i < d.length;) {
    const c = d[i];
    if (/[\s,]/.test(c)) { i++; continue; }
    // Arc flags are one digit each and may be written without separators ("a1,1 0 01 10,10").
    if (command && "Aa".includes(command) && (numbers.length % 7 === 3 || numbers.length % 7 === 4) && (c === "0" || c === "1")) {
      numbers.push(Number(c)); i++; continue;
    }
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m || m.index !== i) throw new Error(`Cannot read the path near "${d.slice(i, i + 12)}"`);
    if (m[1]) { if (command) out.push([command, numbers]); command = m[1]; numbers = []; }
    else numbers.push(Number(m[2]));
    i = re.lastIndex;
  }
  if (command) out.push([command, numbers]);
  return out;
}

/** Read path data into subpaths of nodes (all absolute). */
export function parsePath(d) {
  const subpaths = [];
  let sub = null;
  let cur = [0, 0];
  let start = [0, 0];
  let lastCubic = null; // second control point of the previous C/S (for S)
  let lastQuad = null; // control point of the previous Q/T (for T)
  const last = () => sub.nodes.at(-1);
  const add = (node) => { sub.nodes.push(node); cur = node.p; };
  for (const [letter, numbers] of tokenize(d ?? "")) {
    const upper = letter.toUpperCase();
    const rel = letter !== upper;
    const n = ARGS[upper];
    if (upper === "Z") {
      if (sub) { sub.closed = true; cur = start; }
      lastCubic = lastQuad = null;
      continue;
    }
    for (let i = 0; i + n <= numbers.length || (n === 0 && i === 0); i += n) {
      const a = numbers.slice(i, i + n);
      const pt = (x, y) => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
      let command = upper;
      if (command === "M" && i > 0) command = "L"; // extra pairs after M are lines
      if (command === "M") {
        sub = { nodes: [], closed: false };
        subpaths.push(sub);
        start = pt(a[0], a[1]);
        add({ p: start, in: null, out: null, kind: "M" });
        lastCubic = lastQuad = null;
        continue;
      }
      if (!sub) { sub = { nodes: [{ p: [...cur], in: null, out: null, kind: "M" }], closed: false }; subpaths.push(sub); start = cur; }
      if (sub.closed) { sub = { nodes: [{ p: [...start], in: null, out: null, kind: "M" }], closed: false }; subpaths.push(sub); }
      if (command === "L" || command === "H" || command === "V") {
        const p = command === "H" ? [rel ? cur[0] + a[0] : a[0], cur[1]] : command === "V" ? [cur[0], rel ? cur[1] + a[0] : a[0]] : pt(a[0], a[1]);
        add({ p, in: null, out: null, kind: "L" });
        lastCubic = lastQuad = null;
      } else if (command === "C" || command === "S") {
        const c1 = command === "C" ? pt(a[0], a[1]) : lastCubic ? [2 * cur[0] - lastCubic[0], 2 * cur[1] - lastCubic[1]] : [...cur];
        const c2 = command === "C" ? pt(a[2], a[3]) : pt(a[0], a[1]);
        const p = command === "C" ? pt(a[4], a[5]) : pt(a[2], a[3]);
        last().out = c1;
        add({ p, in: c2, out: null, kind: "C" });
        lastCubic = c2; lastQuad = null;
      } else if (command === "Q" || command === "T") {
        const q = command === "Q" ? pt(a[0], a[1]) : lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]] : [...cur];
        const p = command === "Q" ? pt(a[2], a[3]) : pt(a[0], a[1]);
        last().out = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])];
        add({ p, in: [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], out: null, kind: "C" });
        lastQuad = q; lastCubic = null;
      } else if (command === "A") {
        add({ p: pt(a[5], a[6]), in: null, out: null, kind: "A", arc: a.slice(0, 5) });
        lastCubic = lastQuad = null;
      }
    }
  }
  for (const s of subpaths) foldClosing(s);
  return subpaths;
}

const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** A closed subpath that ends on its start: the last node is the first one again. */
function foldClosing(sub) {
  if (!sub.closed || sub.nodes.length < 3) return;
  const first = sub.nodes[0];
  const last = sub.nodes.at(-1);
  if (!same(first.p, last.p)) return;
  sub.nodes.pop();
  first.in = last.in;
  first.kind = last.kind;
  if (last.arc) first.arc = last.arc;
}

const pair = ([x, y]) => `${fmt(x)},${fmt(y)}`;

/** The segment from `from` to `to`, as path data. */
function segment(from, to) {
  if (to.kind === "A" && to.arc && !from.out && !to.in) return `A ${to.arc.map(fmt).join(" ")} ${pair(to.p)}`;
  if (from.out || to.in) return `C ${pair(from.out ?? from.p)} ${pair(to.in ?? to.p)} ${pair(to.p)}`;
  return `L ${pair(to.p)}`;
}

/** Subpaths back to path data (absolute commands). */
export function serializePath(subpaths) {
  const parts = [];
  for (const { nodes, closed } of subpaths) {
    if (!nodes.length) continue;
    parts.push(`M ${pair(nodes[0].p)}`);
    for (let i = 1; i < nodes.length; i++) parts.push(segment(nodes[i - 1], nodes[i]));
    if (closed) {
      const first = nodes[0];
      // A curved (or arc) closing segment is written out; a straight one is what Z draws anyway.
      if (nodes.length > 1 && (nodes.at(-1).out || first.in || first.kind === "A")) parts.push(segment(nodes.at(-1), { ...first, kind: first.kind === "A" ? "A" : "C" }));
      parts.push("Z");
    }
  }
  return parts.join(" ");
}

// -------------------------------------------------------------- editing --

/** Is the node smooth: are its two handles on one line through it? */
export function isSmooth(node) {
  if (!node.in || !node.out) return false;
  const a = [node.in[0] - node.p[0], node.in[1] - node.p[1]];
  const b = [node.out[0] - node.p[0], node.out[1] - node.p[1]];
  const la = Math.hypot(...a);
  const lb = Math.hypot(...b);
  if (la < 1e-9 || lb < 1e-9) return false;
  return (a[0] * b[0] + a[1] * b[1]) / (la * lb) < -0.999;
}

/** Point on the segment arriving at `to` from `from`, at t in [0, 1]. */
export function pointAt(from, to, t) {
  if (!from.out && !to.in) return [from.p[0] + (to.p[0] - from.p[0]) * t, from.p[1] + (to.p[1] - from.p[1]) * t];
  const [p0, p1, p2, p3] = [from.p, from.out ?? from.p, to.in ?? to.p, to.p];
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
}

/** Split the segment arriving at node `index` at t; the new node keeps the shape (de Casteljau). */
export function splitSegment(sub, index, t) {
  const n = sub.nodes.length;
  const to = sub.nodes[index % n];
  const from = sub.nodes[(index - 1 + n) % n];
  if (to.kind === "A") throw new Error("Arcs cannot be split yet");
  const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let node;
  if (!from.out && !to.in) node = { p: lerp(from.p, to.p), in: null, out: null, kind: "L" };
  else {
    const [p0, p1, p2, p3] = [from.p, from.out ?? from.p, to.in ?? to.p, to.p];
    const a = lerp(p0, p1), b = lerp(p1, p2), c = lerp(p2, p3);
    const d = lerp(a, b), e = lerp(b, c);
    const f = lerp(d, e);
    from.out = a;
    to.in = c;
    node = { p: f, in: d, out: e, kind: "C" };
    to.kind = "C";
  }
  sub.nodes.splice(index === 0 ? n : index, 0, node);
  return node;
}

/** Remove a node; its neighbours are joined by one segment keeping their outer handles. */
export function removeNode(sub, index) {
  const nodes = sub.nodes;
  nodes.splice(index, 1);
  const n = nodes.length;
  if (!n) return;
  if (!sub.closed && index === 0) { Object.assign(nodes[0], { in: null, kind: "M" }); delete nodes[0].arc; return; }
  if (!sub.closed && index === n) { nodes[n - 1].out = null; return; }
  const prev = nodes[(index - 1 + n) % n];
  const next = nodes[index % n];
  delete next.arc;
  next.kind = prev.out || next.in ? "C" : "L";
}

/** Make the segment arriving at node `index` straight (no handles) or curved (handles at thirds). */
export function setSegmentCurved(sub, index, curved) {
  const n = sub.nodes.length;
  const to = sub.nodes[index];
  const from = sub.nodes[(index - 1 + n) % n];
  if (!curved) { from.out = null; to.in = null; to.kind = "L"; delete to.arc; return; }
  if (from.out || to.in) return;
  from.out = [from.p[0] + (to.p[0] - from.p[0]) / 3, from.p[1] + (to.p[1] - from.p[1]) / 3];
  to.in = [from.p[0] + (2 * (to.p[0] - from.p[0])) / 3, from.p[1] + (2 * (to.p[1] - from.p[1])) / 3];
  to.kind = "C";
  delete to.arc;
}

/** Make a node smooth (its handles in one line, each keeping its length) or a corner (as it is). */
export function makeSmooth(node, prev, next) {
  const dir = next && prev ? [next.p[0] - prev.p[0], next.p[1] - prev.p[1]] : [1, 0];
  const len = Math.hypot(...dir) || 1;
  const u = [dir[0] / len, dir[1] / len];
  const lin = node.in ? Math.hypot(node.in[0] - node.p[0], node.in[1] - node.p[1]) : prev ? Math.hypot(prev.p[0] - node.p[0], prev.p[1] - node.p[1]) / 3 : len / 6;
  const lout = node.out ? Math.hypot(node.out[0] - node.p[0], node.out[1] - node.p[1]) : next ? Math.hypot(next.p[0] - node.p[0], next.p[1] - node.p[1]) / 3 : len / 6;
  node.in = [node.p[0] - u[0] * lin, node.p[1] - u[1] * lin];
  node.out = [node.p[0] + u[0] * lout, node.p[1] + u[1] * lout];
  if (node.kind !== "M") node.kind = "C";
}

// ---------------------------------------------------------- shapes as paths --

const K = 0.5522847498; // circle → cubic handle length

/** Path data for a basic shape given its attributes (numbers), or null when it is not one. */
export function shapePath(tag, a) {
  const num = (name, fallback = 0) => (Number.isFinite(a[name]) ? a[name] : fallback);
  if (tag === "rect") {
    const [x, y, w, h] = [num("x"), num("y"), num("width"), num("height")];
    let rx = Number.isFinite(a.rx) ? a.rx : Number.isFinite(a.ry) ? a.ry : 0;
    let ry = Number.isFinite(a.ry) ? a.ry : rx;
    rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
    if (!rx || !ry) return `M ${pair([x, y])} L ${pair([x + w, y])} L ${pair([x + w, y + h])} L ${pair([x, y + h])} Z`;
    const kx = rx * K, ky = ry * K;
    return [
      `M ${pair([x + rx, y])}`, `L ${pair([x + w - rx, y])}`, `C ${pair([x + w - rx + kx, y])} ${pair([x + w, y + ry - ky])} ${pair([x + w, y + ry])}`,
      `L ${pair([x + w, y + h - ry])}`, `C ${pair([x + w, y + h - ry + ky])} ${pair([x + w - rx + kx, y + h])} ${pair([x + w - rx, y + h])}`,
      `L ${pair([x + rx, y + h])}`, `C ${pair([x + rx - kx, y + h])} ${pair([x, y + h - ry + ky])} ${pair([x, y + h - ry])}`,
      `L ${pair([x, y + ry])}`, `C ${pair([x, y + ry - ky])} ${pair([x + rx - kx, y])} ${pair([x + rx, y])}`, "Z",
    ].join(" ");
  }
  if (tag === "circle" || tag === "ellipse") {
    const [cx, cy] = [num("cx"), num("cy")];
    const rx = tag === "circle" ? num("r") : num("rx", num("ry"));
    const ry = tag === "circle" ? num("r") : num("ry", num("rx"));
    const kx = rx * K, ky = ry * K;
    return [
      `M ${pair([cx + rx, cy])}`, `C ${pair([cx + rx, cy + ky])} ${pair([cx + kx, cy + ry])} ${pair([cx, cy + ry])}`,
      `C ${pair([cx - kx, cy + ry])} ${pair([cx - rx, cy + ky])} ${pair([cx - rx, cy])}`,
      `C ${pair([cx - rx, cy - ky])} ${pair([cx - kx, cy - ry])} ${pair([cx, cy - ry])}`,
      `C ${pair([cx + kx, cy - ry])} ${pair([cx + rx, cy - ky])} ${pair([cx + rx, cy])}`, "Z",
    ].join(" ");
  }
  if (tag === "line") return `M ${pair([num("x1"), num("y1")])} L ${pair([num("x2"), num("y2")])}`;
  if (tag === "polyline" || tag === "polygon") {
    const n = String(a.points ?? "").trim().split(/[\s,]+/).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    if (!pts.length) return null;
    return `M ${pts.map(pair).join(" L ")}${tag === "polygon" ? " Z" : ""}`;
  }
  return null;
}

/** The attributes a shape's geometry lives in (dropped when it becomes a path). */
export const GEOMETRY = { rect: ["x", "y", "width", "height", "rx", "ry"], circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"], line: ["x1", "y1", "x2", "y2"], polyline: ["points"], polygon: ["points"] };
