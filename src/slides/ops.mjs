// Agent edits to a deck, as a list of small operations. The same code runs in the Slides page
// (open deck: the result goes into the editor as one undo step) and in the host (deck not open:
// the result is written to the file). Elements are addressed by id, slides by index or id.
import { newId, blankSlide, htmlText } from "./deck.mjs";
import { applyMotionOp, MOTION_OPS } from "./motion.mjs";

// ------------------------------------------------------------ text --

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/\^([^^\s]+)\^/g, "<sup>$1</sup>")
    .replace(/~([^~\s]+)~/g, "<sub>$1</sub>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank">${label}</a>`);
}

/**
 * Light Markdown → PPTist text HTML. One paragraph per line; "- " / "* " lines make a bulleted list,
 * "1. " lines a numbered one; **bold**, *italic*, `code`, ^sup^, ~sub~ and [links](url) inline.
 * Style applies to all of it: size (px), color, font, bold, italic, align.
 */
export function textHtml(text, { size, color, font, bold, italic, align } = {}) {
  const spanStyle = [size && `font-size: ${size}px`, color && `color: ${color}`, font && `font-family: ${font}`].filter(Boolean).join("; ");
  const wrap = (html) => {
    let out = spanStyle ? `<span style="${spanStyle};">${html}</span>` : html;
    if (italic) out = `<em>${out}</em>`;
    if (bold) out = `<strong>${out}</strong>`;
    return out;
  };
  const pStyle = align && align !== "left" ? ` style="text-align: ${align};"` : "";
  const paragraph = (line) => `<p${pStyle}>${wrap(inline(line))}</p>`;
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text ?? "").split("\n")) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(raw);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    const kind = bullet ? "ul" : number ? "ol" : null;
    if (kind) {
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${paragraph((bullet ?? number)[1])}</li>`);
    } else {
      close();
      out.push(paragraph(raw));
    }
  }
  close();
  return out.join("");
}

// ---------------------------------------------------------- shapes --

const SHAPES = {
  rect: { viewBox: [200, 200], path: "M 0 0 L 200 0 L 200 200 L 0 200 Z" },
  ellipse: { viewBox: [200, 200], path: "M 100 0 A 50 50 0 1 1 100 200 A 50 50 0 1 1 100 0 Z" },
  triangle: { viewBox: [200, 200], path: "M 100 0 L 0 200 L 200 200 L 100 0 Z" },
  diamond: { viewBox: [200, 200], path: "M 100 0 L 0 100 L 100 200 L 200 100 Z" },
  "arrow-right": { viewBox: [200, 200], path: "M 0 50 L 120 50 L 120 0 L 200 100 L 120 200 L 120 150 L 0 150 Z" },
  "arrow-left": { viewBox: [200, 200], path: "M 200 50 L 80 50 L 80 0 L 0 100 L 80 200 L 80 150 L 200 150 Z" },
  chevron: { viewBox: [200, 200], path: "M 0 0 L 140 0 L 200 100 L 140 200 L 0 200 L 60 100 Z" },
  hexagon: { viewBox: [200, 200], path: "M 50 0 L 150 0 L 200 100 L 150 200 L 50 200 L 0 100 Z" },
};
const roundRectPath = (w, h, r = 0.125) => {
  const radius = Math.min(w, h) * r;
  return `M ${radius} 0 L ${w - radius} 0 Q ${w} 0 ${w} ${radius} L ${w} ${h - radius} Q ${w} ${h} ${w - radius} ${h} L ${radius} ${h} Q 0 ${h} 0 ${h - radius} L 0 ${radius} Q 0 0 ${radius} 0 Z`;
};
export const SHAPE_NAMES = [...Object.keys(SHAPES), "roundRect"];

function shapeGeometry(name, width, height, radius) {
  if (name === "roundRect") return { viewBox: [width, height], path: roundRectPath(width, height, radius ?? 0.125), pathFormula: "roundRect", keypoints: [radius ?? 0.125] };
  const shape = SHAPES[name];
  if (!shape) throw new Error(`Unknown shape "${name}"; use one of: ${SHAPE_NAMES.join(", ")}`);
  return { viewBox: [...shape.viewBox], path: shape.path };
}

// The editor's chart names, as its menu shows them, to PPTist's model: there "bar" draws vertical columns.
export const CHART_TYPES = { column: "bar", bar: "column", line: "line", area: "area", pie: "pie", ring: "ring", doughnut: "ring", radar: "radar", scatter: "scatter" };

// ------------------------------------------------------------ helpers --

const num = (value, what) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number`);
  return n;
};

function boxOf(spec, fallback = {}) {
  const [left, top, width, height] = Array.isArray(spec.box) ? spec.box : [spec.left, spec.top, spec.width, spec.height];
  return {
    left: left ?? fallback.left ?? 0,
    top: top ?? fallback.top ?? 0,
    width: width ?? fallback.width,
    height: height ?? fallback.height,
  };
}

function findSlide(deck, ref) {
  if (ref === undefined || ref === null) throw new Error("Which slide? Pass slide (index from 0, or id)");
  const index = typeof ref === "number" ? ref : deck.slides.findIndex((slide) => slide.id === ref);
  if (index < 0 || index >= deck.slides.length || !Number.isInteger(index)) throw new Error(`No slide ${JSON.stringify(ref)} (the deck has ${deck.slides.length})`);
  return index;
}

function findElement(deck, id) {
  for (const slide of deck.slides) {
    const index = slide.elements.findIndex((element) => element.id === id);
    if (index >= 0) return { slide, index, element: slide.elements[index] };
  }
  throw new Error(`No element ${id}`);
}

const outlineOf = (spec) => spec && { width: spec.width ?? 2, color: spec.color ?? "#525252", style: spec.style ?? "solid" };
const clean = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
const textStyle = (spec) => ({ size: spec.size, color: spec.color, font: spec.font, bold: spec.bold, italic: spec.italic, align: spec.align });

// ---------------------------------------------------------- elements --

/** Build a PPTist element from the agent's friendly spec. */
async function buildElement(spec, deck, env) {
  const theme = deck.theme ?? {};
  const id = spec.id ?? env.newId();
  const common = clean({ id, rotate: spec.rotate ?? 0, name: spec.name, lock: spec.lock });
  const canvasW = deck.viewportSize;
  const canvasH = deck.viewportSize * deck.viewportRatio;
  switch (spec.type) {
    case "text": {
      const box = boxOf(spec, { left: 80, top: 80, width: canvasW - 160, height: 60 });
      return clean({
        type: "text", ...common, ...box,
        content: spec.html ?? textHtml(spec.text ?? "", textStyle(spec)),
        defaultFontName: spec.defaultFont ?? theme.fontName ?? "",
        defaultColor: spec.defaultColor ?? theme.fontColor ?? "#333",
        fill: spec.fill, lineHeight: spec.lineHeight, vAlign: spec.vAlign, vertical: spec.vertical ?? false,
        outline: outlineOf(spec.outline),
      });
    }
    case "image": {
      if (!spec.src) throw new Error("An image needs src (a path relative to the deck, an absolute path, or a URL)");
      let box = boxOf(spec);
      if (box.width === undefined || box.height === undefined) {
        const size = await env.imageSize?.(spec.src);
        const ratio = size ? size.height / size.width : 0.75;
        if (box.width === undefined && box.height === undefined) box.width = Math.min(size?.width ?? 480, canvasW * 0.6);
        if (box.width === undefined) box.width = box.height / ratio;
        if (box.height === undefined) box.height = box.width * ratio;
      }
      return clean({ type: "image", ...common, ...box, src: spec.src, fixedRatio: spec.fixedRatio ?? true, radius: spec.radius, outline: outlineOf(spec.outline) });
    }
    case "shape": {
      const box = boxOf(spec, { left: 100, top: 100, width: 200, height: 120 });
      const geometry = shapeGeometry(spec.shape ?? "rect", box.width, box.height, spec.radius);
      return clean({
        type: "shape", ...common, ...box, ...geometry,
        fill: spec.fill ?? theme.themeColors?.[0] ?? "#4557d6",
        fixedRatio: false, opacity: spec.opacity,
        outline: outlineOf(spec.outline),
        text: spec.text !== undefined || spec.html !== undefined ? {
          content: spec.html ?? textHtml(spec.text, { align: "center", ...clean(textStyle(spec)) }),
          defaultFontName: theme.fontName ?? "", defaultColor: spec.color ?? theme.fontColor ?? "#333", align: spec.vAlign ?? "middle",
        } : undefined,
      });
    }
    case "line": {
      const from = spec.from ?? [100, 100];
      const to = spec.to ?? [300, 100];
      const left = Math.min(from[0], to[0]);
      const top = Math.min(from[1], to[1]);
      const ends = { none: ["", ""], end: ["", "arrow"], start: ["arrow", ""], both: ["arrow", "arrow"], dots: ["dot", "dot"] }[spec.arrow ?? "none"];
      if (!ends) throw new Error("arrow is none, start, end, both or dots");
      return clean({
        type: "line", id, name: spec.name, left, top,
        start: [from[0] - left, from[1] - top], end: [to[0] - left, to[1] - top],
        width: spec.width ?? 2, color: spec.color ?? theme.fontColor ?? "#333", style: spec.style ?? "solid", points: ends,
      });
    }
    case "latex": {
      if (!spec.latex) throw new Error("A formula needs latex");
      const box = boxOf(spec, { left: 100, top: 100 });
      // No path: the Slides page draws it (MathJax) when the deck is shown; height (or width) sets the size.
      return clean({ type: "latex", ...common, left: box.left, top: box.top, width: box.width ?? 0, height: box.height ?? (box.width ? 0 : 60), latex: spec.latex, path: "", color: spec.color ?? theme.fontColor ?? "#333", strokeWidth: 0, viewBox: [1, 1], fixedRatio: true, renderer: "mathjax" });
    }
    case "table": {
      const rows = spec.rows;
      if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw new Error("A table needs rows: an array of arrays of cell text");
      const columns = Math.max(...rows.map((row) => row.length));
      const style = clean({ fontname: theme.fontName || undefined, color: theme.fontColor, fontsize: spec.size ? `${spec.size}px` : undefined });
      const data = rows.map((row) => Array.from({ length: columns }, (_, i) => ({ id: env.newId(), colspan: 1, rowspan: 1, text: String(row[i] ?? ""), style: { ...style } })));
      const box = boxOf(spec, { left: 100, top: 100, width: columns * 140, height: rows.length * 40 });
      const widths = spec.colWidths ?? Array(columns).fill(1);
      const total = widths.reduce((a, b) => a + b, 0);
      return clean({
        type: "table", ...common, ...box, data, colWidths: widths.map((w) => w / total), cellMinHeight: spec.cellHeight ?? 36,
        outline: outlineOf(spec.outline) ?? { width: 2, style: "solid", color: "#eeece1" },
        theme: { color: spec.color ?? theme.themeColors?.[0] ?? "#4557d6", rowHeader: spec.header ?? true, rowFooter: false, colHeader: false, colFooter: false },
      });
    }
    case "chart": {
      if (!CHART_TYPES[spec.chartType]) throw new Error(`chartType is one of ${Object.keys(CHART_TYPES).join(", ")}`);
      if (!Array.isArray(spec.labels) || !Array.isArray(spec.series)) throw new Error("A chart needs labels and series (one array of numbers per series)");
      const box = boxOf(spec, { left: 300, top: 100, width: 480, height: 360 });
      return clean({
        type: "chart", ...common, ...box, chartType: CHART_TYPES[spec.chartType],
        data: { labels: spec.labels.map(String), legends: (spec.legends ?? spec.series.map((_, i) => `Series ${i + 1}`)).map(String), series: spec.series.map((s) => s.map(Number)) },
        themeColors: spec.colors ?? theme.themeColors ?? ["#4557d6"], textColor: spec.textColor ?? theme.fontColor, options: clean({ stack: spec.stack, lineSmooth: spec.smooth }),
      });
    }
    case "script": {
      // Code goes into a file next to the deck (scripts/<name>.js); src points at an existing one.
      let src = spec.src;
      if (spec.code !== undefined) {
        if (!env.writeScript) throw new Error("Scripts cannot be written here");
        src = await env.writeScript(src ?? `scripts/${String(spec.name ?? id).replace(/[^A-Za-z0-9_-]+/g, "-")}.js`, String(spec.code));
      }
      if (!src) throw new Error("A script needs code (or src: an existing file next to the deck)");
      const box = boxOf(spec, { left: canvasW / 2 - 240, top: canvasH / 2 - 160, width: 480, height: 320 });
      const libs = (spec.libs ?? []).filter((lib) => ["d3", "three"].includes(lib));
      return clean({ type: "script", ...common, ...box, src, steps: Number(spec.steps ?? 0), libs, data: spec.data, poster: spec.poster });
    }
    default:
      throw new Error(`Unknown element type "${spec.type}"; use text, image, shape, line, latex, table, chart or script`);
  }
}

/** Apply friendly property changes to an existing element. `props` is merged raw, last. */
async function updateElement(element, spec, deck, env) {
  const theme = deck.theme ?? {};
  const changes = {};
  if (spec.box || spec.left !== undefined || spec.top !== undefined || spec.width !== undefined || spec.height !== undefined) {
    if (element.type === "line") {
      const box = boxOf(spec, element);
      changes.left = box.left; changes.top = box.top;
    } else Object.assign(changes, boxOf(spec, element));
  }
  if (element.type === "line" && (spec.from || spec.to)) {
    const from = spec.from ?? [element.left + element.start[0], element.top + element.start[1]];
    const to = spec.to ?? [element.left + element.end[0], element.top + element.end[1]];
    const rebuilt = await buildElement({ type: "line", from, to, id: element.id, width: element.width, color: element.color, style: element.style }, deck, env);
    Object.assign(changes, { left: rebuilt.left, top: rebuilt.top, start: rebuilt.start, end: rebuilt.end });
  }
  for (const key of ["rotate", "name", "lock", "opacity", "radius", "fixedRatio", "vAlign", "lineHeight"]) if (spec[key] !== undefined) changes[key] = spec[key];
  if (spec.outline !== undefined) changes.outline = spec.outline === null ? undefined : outlineOf(spec.outline);
  const styled = ["size", "color", "font", "bold", "italic", "align"].some((key) => spec[key] !== undefined);
  if (element.type === "text") {
    if (spec.html !== undefined) changes.content = spec.html;
    else if (spec.text !== undefined || styled) changes.content = textHtml(spec.text ?? htmlText(element.content), textStyle(spec));
    if (spec.fill !== undefined) changes.fill = spec.fill;
  } else if (element.type === "shape") {
    if (spec.fill !== undefined) changes.fill = spec.fill;
    if (spec.shape !== undefined || ((changes.width !== undefined || changes.height !== undefined) && element.pathFormula === "roundRect")) {
      const { width = element.width, height = element.height } = changes;
      Object.assign(changes, shapeGeometry(spec.shape ?? element.pathFormula ?? "rect", width, height, spec.radius ?? element.keypoints?.[0]));
    }
    if (spec.html !== undefined || spec.text !== undefined) {
      changes.text = { ...(element.text ?? { defaultFontName: theme.fontName ?? "", defaultColor: theme.fontColor ?? "#333", align: "middle" }), content: spec.html ?? textHtml(spec.text, textStyle(spec)) };
    }
  } else if (element.type === "latex") {
    if (spec.latex !== undefined && spec.latex !== element.latex) {
      changes.latex = spec.latex;
      changes.path = ""; // redrawn by the page, keeping the height
      if (changes.width === undefined) changes.width = 0;
    }
    if (spec.color !== undefined) changes.color = spec.color;
  } else if (element.type === "line") {
    if (spec.color !== undefined) changes.color = spec.color;
    if (spec.width !== undefined && !spec.box) changes.width = spec.width;
    if (spec.style !== undefined) changes.style = spec.style;
    if (spec.arrow !== undefined) changes.points = (await buildElement({ type: "line", arrow: spec.arrow }, deck, env)).points;
  } else if (element.type === "image" || element.type === "video" || element.type === "audio") {
    if (spec.src !== undefined) changes.src = spec.src;
  } else if (element.type === "table") {
    if (spec.rows) {
      const rebuilt = await buildElement({ type: "table", rows: spec.rows, size: spec.size, box: [element.left, element.top, element.width, element.height] }, deck, env);
      Object.assign(changes, { data: rebuilt.data, colWidths: spec.rows[0]?.length === element.colWidths.length ? element.colWidths : rebuilt.colWidths });
    }
  } else if (element.type === "script") {
    if (spec.code !== undefined) {
      if (!env.writeScript) throw new Error("Scripts cannot be written here");
      changes.src = await env.writeScript(spec.src ?? element.src, String(spec.code));
    } else if (spec.src !== undefined) changes.src = spec.src;
    if (spec.steps !== undefined) changes.steps = Number(spec.steps);
    if (spec.libs !== undefined) changes.libs = spec.libs.filter((lib) => ["d3", "three"].includes(lib));
    if (spec.data !== undefined) changes.data = spec.data;
    if (spec.poster !== undefined) changes.poster = spec.poster;
  } else if (element.type === "chart") {
    const data = { ...element.data };
    if (spec.labels) data.labels = spec.labels.map(String);
    if (spec.series) data.series = spec.series.map((s) => s.map(Number));
    if (spec.legends) data.legends = spec.legends.map(String);
    changes.data = data;
    if (spec.chartType) {
      if (!CHART_TYPES[spec.chartType]) throw new Error(`chartType is one of ${Object.keys(CHART_TYPES).join(", ")}`);
      changes.chartType = CHART_TYPES[spec.chartType];
    }
    if (spec.colors) changes.themeColors = spec.colors;
  }
  Object.assign(element, changes, spec.props ?? {});
  for (const [key, value] of Object.entries(element)) if (value === undefined) delete element[key];
}

// ------------------------------------------------------------- slides --

function insertIndex(deck, after) {
  if (after === undefined || after === "end") return deck.slides.length;
  if (after === "start") return 0;
  return findSlide(deck, after) + 1;
}

function textReplace(html, find, replace) {
  // Replace inside text nodes only, never in tags or attributes.
  let count = 0;
  const out = String(html).replace(/(^|>)([^<]+)/g, (_, open, text) => {
    const parts = text.split(find);
    count += parts.length - 1;
    return open + parts.join(replace);
  });
  return { html: out, count };
}

export const OP_NAMES = [...MOTION_OPS, "add_slide", "delete_slide", "move_slide", "duplicate_slide", "update_slide", "add_element", "update_element", "delete_element", "move_element", "set_notes", "set_theme", "set_title", "replace_text"];

/**
 * Apply ops to a copy of the deck. env: { newId, imageSize(src) → {width, height} }.
 * Returns { deck, results } where results[i] describes what op i did (ids it created, etc.).
 * Throws on the first invalid op, naming it; nothing is applied then.
 */
export async function applyOps(deck, ops, env = {}) {
  if (!Array.isArray(ops)) throw new Error("ops must be a list");
  const context = { newId, ...env };
  const out = structuredClone(deck);
  const results = [];
  for (const [n, op] of ops.entries()) {
    try { results.push(await applyOp(out, op ?? {}, context)); }
    catch (error) { throw new Error(`Op ${n + 1} (${op?.op ?? "?"}): ${error.message}`); }
  }
  return { deck: out, results };
}

async function applyOp(deck, op, env) {
  if (MOTION_OPS.includes(op.op)) return applyMotionOp(deck, op, env, findSlide);
  switch (op.op) {
    case "add_slide": {
      const slide = blankSlide(deck.theme);
      if (op.id) slide.id = op.id;
      if (op.background) slide.background = typeof op.background === "string" ? { type: "solid", color: op.background } : op.background;
      if (op.notes !== undefined) slide.remark = textHtml(op.notes);
      for (const spec of op.elements ?? []) slide.elements.push(await buildElement(spec, deck, env));
      const index = insertIndex(deck, op.after);
      deck.slides.splice(index, 0, slide);
      return { slide: slide.id, index, elements: slide.elements.map((element) => element.id) };
    }
    case "delete_slide": {
      if (deck.slides.length === 1) throw new Error("A deck keeps at least one slide");
      const index = findSlide(deck, op.slide);
      const [removed] = deck.slides.splice(index, 1);
      return { deleted: removed.id };
    }
    case "move_slide": {
      const index = findSlide(deck, op.slide);
      const to = num(op.to, "to");
      if (to < 0 || to >= deck.slides.length) throw new Error(`to must be 0..${deck.slides.length - 1}`);
      const [slide] = deck.slides.splice(index, 1);
      deck.slides.splice(to, 0, slide);
      return { slide: slide.id, index: to };
    }
    case "duplicate_slide": {
      const index = findSlide(deck, op.slide);
      const copy = structuredClone(deck.slides[index]);
      const groups = new Map();
      copy.id = env.newId();
      for (const element of copy.elements) {
        element.id = env.newId();
        if (element.groupId) { if (!groups.has(element.groupId)) groups.set(element.groupId, env.newId()); element.groupId = groups.get(element.groupId); }
      }
      delete copy.notes;
      delete copy.animations;
      deck.slides.splice(index + 1, 0, copy);
      return { slide: copy.id, index: index + 1, elements: copy.elements.map((element) => element.id) };
    }
    case "update_slide": {
      const slide = deck.slides[findSlide(deck, op.slide)];
      if (op.background !== undefined) slide.background = typeof op.background === "string" ? { type: "solid", color: op.background } : op.background;
      if (op.notes !== undefined) slide.remark = textHtml(op.notes);
      if (op.transition !== undefined) slide.turningMode = op.transition;
      Object.assign(slide, op.props ?? {});
      return { slide: slide.id };
    }
    case "set_notes": {
      const slide = deck.slides[findSlide(deck, op.slide)];
      slide.remark = op.html ?? textHtml(op.text ?? "");
      return { slide: slide.id };
    }
    case "add_element": {
      const slide = deck.slides[findSlide(deck, op.slide)];
      if (!op.element?.type) throw new Error("add_element needs element: { type, … }");
      const element = await buildElement(op.element, deck, env);
      if (deck.slides.some((s) => s.elements.some((e) => e.id === element.id))) throw new Error(`Id ${element.id} is taken`);
      slide.elements.push(element);
      return { slide: slide.id, element: element.id };
    }
    case "update_element": {
      const { element } = findElement(deck, op.id);
      await updateElement(element, op.set ?? op, deck, env);
      return { element: element.id };
    }
    case "delete_element": {
      const ids = Array.isArray(op.ids) ? op.ids : [op.id];
      for (const id of ids) {
        const { slide, index } = findElement(deck, id);
        slide.elements.splice(index, 1);
        if (slide.animations) slide.animations = slide.animations.filter((animation) => animation.elId !== id);
      }
      return { deleted: ids };
    }
    case "move_element": {
      // Stacking order (to: front|back|forward|backward or an index), or to another slide (slide).
      const { slide, index, element } = findElement(deck, op.id);
      if (op.slide !== undefined) {
        const target = deck.slides[findSlide(deck, op.slide)];
        slide.elements.splice(index, 1);
        target.elements.push(element);
        return { element: element.id, slide: target.id };
      }
      slide.elements.splice(index, 1);
      const last = slide.elements.length;
      const to = { front: last, back: 0, forward: Math.min(index + 1, last), backward: Math.max(index - 1, 0) }[op.to] ?? num(op.to, "to");
      slide.elements.splice(Math.max(0, Math.min(to, last)), 0, element);
      return { element: element.id, order: slide.elements.indexOf(element) };
    }
    case "set_theme": {
      deck.theme = { ...deck.theme, ...(op.theme ?? clean({ fontName: op.font, fontColor: op.color, backgroundColor: op.background, themeColors: op.colors })) };
      return { theme: deck.theme };
    }
    case "set_title": {
      deck.title = String(op.title ?? "");
      return { title: deck.title };
    }
    case "replace_text": {
      if (!op.find) throw new Error("replace_text needs find");
      let count = 0;
      for (const slide of deck.slides) {
        for (const element of slide.elements) {
          if (element.type === "text") { const r = textReplace(element.content, op.find, op.replace ?? ""); element.content = r.html; count += r.count; }
          if (element.type === "shape" && element.text) { const r = textReplace(element.text.content, op.find, op.replace ?? ""); element.text.content = r.html; count += r.count; }
          if (element.type === "table") for (const row of element.data) for (const cell of row) { const parts = cell.text.split(op.find); count += parts.length - 1; cell.text = parts.join(op.replace ?? ""); }
        }
      }
      return { replaced: count };
    }
    default:
      throw new Error(`Unknown op; use one of: ${OP_NAMES.join(", ")}`);
  }
}
