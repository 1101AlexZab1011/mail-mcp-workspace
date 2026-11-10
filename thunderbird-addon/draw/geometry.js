// Draw: the arithmetic the editor needs, kept free of the DOM so it can be tested on its own.
//
// Matrices are SVG's [a, b, c, d, e, f] (x' = a·x + c·y + e, y' = b·x + d·y + f).

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export const multiply = ([a1, b1, c1, d1, e1, f1], [a2, b2, c2, d2, e2, f2]) => [
  a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
  a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
  a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
];

export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!det) return [...IDENTITY];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
/** A direction (no translation): how a drag of (x, y) reads in the matrix's space. */
export const applyVector = ([a, b, c, d], [x, y]) => [a * x + c * y, b * x + d * y];

export const translation = (x, y) => [1, 0, 0, 1, x, y];
/** Scale by (sx, sy) about the point (ox, oy). */
export const scalingAbout = (sx, sy, ox, oy) => [sx, 0, 0, sy, ox - sx * ox, oy - sy * oy];

/** A number as SVG files write it: at most 4 decimals, no trailing zeros, no "-0". */
export function fmt(value) {
  const n = Math.round(value * 1e4) / 1e4;
  return Object.is(n, -0) || n === 0 ? "0" : String(n);
}

export const matrixString = (m) => `matrix(${m.map(fmt).join(",")})`;
export const isIdentity = (m) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
export const isTranslation = (m) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9;

const TRANSLATE_ONLY = /^\s*translate\(\s*(-?[\d.eE+-]+)(?:\s*[,\s]\s*(-?[\d.eE+-]+))?\s*\)\s*$/;

/**
 * An element's `transform` after moving it by (dx, dy) in its parent's units. The original stays as
 * written: a plain translate is updated in place, anything else gets a translate in front.
 */
export function moveTransform(original, dx, dy) {
  const text = original?.trim() ?? "";
  if (!text) return `translate(${fmt(dx)},${fmt(dy)})`;
  const m = TRANSLATE_ONLY.exec(text);
  if (m) {
    const x = Number(m[1]) + dx;
    const y = Number(m[2] ?? 0) + dy;
    return x || y ? `translate(${fmt(x)},${fmt(y)})` : null;
  }
  return `translate(${fmt(dx)},${fmt(dy)}) ${text}`;
}

/**
 * The `transform` that puts `matrix` (in the parent's units) in front of the element's current one,
 * written as simply as it can be: nothing, a translate, or one matrix.
 */
export function composedTransform(original, before, current) {
  const total = multiply(before, current);
  if (isIdentity(total)) return null;
  if (isTranslation(before) && (!original?.trim() || TRANSLATE_ONLY.test(original))) return moveTransform(original, before[4], before[5]);
  if (isTranslation(total)) return `translate(${fmt(total[4])},${fmt(total[5])})`;
  return matrixString(total);
}

// --------------------------------------------------------------- the file --

/**
 * What a serializer cannot give back: the XML declaration before the root (it is not a node) and the
 * newline after it. The editor keeps them from the file it read.
 */
export function framing(text) {
  const declaration = /^﻿?\s*(<\?xml[^?]*\?>)/.exec(text)?.[1] ?? "";
  return { declaration, trailingNewline: /\n\s*$/.test(text) };
}

/** The file text for a serialized document, framed as the original was. */
export function frame(serialized, { declaration, trailingNewline }) {
  let body = serialized.replace(/^<\?xml[^?]*\?>\s*/, "");
  if (declaration) body = `${declaration}\n${body}`;
  return trailingNewline && !body.endsWith("\n") ? `${body}\n` : body;
}

/** A fresh id like Inkscape's (rect12, g5), not among `taken`. */
export function freshId(prefix, taken) {
  const base = String(prefix || "id").replace(/[^A-Za-z0-9_-]/g, "") || "id";
  for (let n = 1; ; n++) if (!taken.has(`${base}${n}`)) { taken.add(`${base}${n}`); return `${base}${n}`; }
}

// ---------------------------------------------------------------- new files --

export const PAGE_SIZES = [
  { id: "a0", label: "A0 poster", w: 841, h: 1189, unit: "mm" },
  { id: "a1", label: "A1 poster", w: 594, h: 841, unit: "mm" },
  { id: "a2", label: "A2", w: 420, h: 594, unit: "mm" },
  { id: "a3", label: "A3", w: 297, h: 420, unit: "mm" },
  { id: "a4", label: "A4", w: 210, h: 297, unit: "mm" },
  { id: "hd", label: "Screen 16:9", w: 1920, h: 1080, unit: "px" },
];

/** A new drawing: one page (landscape: wider than tall), one Inkscape layer, ready to open in Inkscape too. */
export function blankDrawing({ w, h, unit = "mm", landscape = false }) {
  const [short, long] = [Math.min(w, h), Math.max(w, h)];
  const [width, height] = landscape ? [long, short] : [short, long];
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
   width="${fmt(width)}${unit === "px" ? "" : unit}"
   height="${fmt(height)}${unit === "px" ? "" : unit}"
   viewBox="0 0 ${fmt(width)} ${fmt(height)}"
   version="1.1"
   id="svg1"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview
     id="namedview1"
     pagecolor="#ffffff"
     bordercolor="#000000"
     borderopacity="0.25"
     inkscape:document-units="${unit}" />
  <defs
     id="defs1" />
  <g
     inkscape:label="Layer 1"
     inkscape:groupmode="layer"
     id="layer1" />
</svg>
`;
}
