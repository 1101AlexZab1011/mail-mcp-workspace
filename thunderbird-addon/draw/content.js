// Draw: making and changing content in the SVG document (new elements, text lines, imported figures,
// style properties), written the way Inkscape writes it so the file stays at home in Inkscape.
import * as g from "./geometry.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";
export const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
export const INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape";
export const SODIPODI_NS = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd";

/** Make sure `prefix` is declared on the root (a prefixed name written without it would break the file). */
export function ensureNamespace(doc, prefix, uri) {
  const root = doc.documentElement;
  if (root.lookupNamespaceURI(prefix) === uri) return;
  root.setAttributeNS(XMLNS_NS, `xmlns:${prefix}`, uri);
}

export const takenIds = (doc) => new Set(Array.from(doc.querySelectorAll("[id]"), (el) => el.id));

/**
 * Append `el` to `parent` on a line of its own when the file indents its elements (never inside text,
 * where whitespace would show).
 */
export function appendIndented(parent, el) {
  const doc = parent.ownerDocument;
  if (["text", "tspan", "textPath"].includes(parent.localName)) { parent.append(el); return el; }
  const tail = parent.lastChild;
  const last = parent.lastElementChild;
  const indent = last?.previousSibling?.nodeType === 3 && /^\s+$/.test(last.previousSibling.data) ? last.previousSibling.data : null;
  if (indent && tail?.nodeType === 3 && /^\s*$/.test(tail.data)) {
    parent.insertBefore(doc.createTextNode(indent), tail);
    parent.insertBefore(el, tail);
    return el;
  }
  // The first child of an empty element: one level deeper than the element's own line.
  const own = !last && parent.previousSibling?.nodeType === 3 ? /\n[ \t]*$/.exec(parent.previousSibling.data)?.[0] : null;
  if (own && !parent.firstChild) parent.append(doc.createTextNode(`${own}  `), el, doc.createTextNode(own));
  else parent.append(el);
  return el;
}

/** A new SVG element with a fresh id (rect1, text3…), appended to `parent`. */
export function createElement(parent, name, attributes = {}, taken = takenIds(parent.ownerDocument)) {
  const el = parent.ownerDocument.createElementNS(SVG_NS, name);
  el.setAttribute("id", g.freshId(name, taken));
  setAttributes(el, attributes);
  return appendIndented(parent, el);
}

export function setAttributes(el, attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) el.removeAttribute(name);
    else el.setAttribute(name, String(value));
  }
}

/** Give every id in `fragment` that is taken a fresh one, and repoint references inside it. */
export function freshenIds(fragment, taken) {
  return renameIds(fragment, taken, (id) => taken.has(id));
}

/** A copy of `el` whose ids are all new (each one is its original's, so every one is renamed). */
export const copyWithFreshIds = (el, taken) => renameIds(el.cloneNode(true), taken, () => true);

function renameIds(fragment, taken, needsNew) {
  const renamed = new Map();
  for (const node of [fragment, ...fragment.querySelectorAll("[id]")]) {
    if (!node.id) continue;
    if (!needsNew(node.id)) { taken.add(node.id); continue; }
    const fresh = g.freshId(node.id.replace(/[-_]?\d+$/, "") || node.localName, taken);
    renamed.set(node.id, fresh);
    node.id = fresh;
  }
  if (!renamed.size) return fragment;
  for (const node of [fragment, ...fragment.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      let value = attr.value.replace(/url\(\s*#([^)\s]+)\s*\)/g, (m, id) => (renamed.has(id) ? `url(#${renamed.get(id)})` : m));
      if (attr.localName === "href" && value.startsWith("#") && renamed.has(value.slice(1))) value = `#${renamed.get(value.slice(1))}`;
      if (value !== attr.value) attr.value = value;
    }
  }
  return fragment;
}

/** Every prefixed name in `fragment` gets its namespace declared on the document's root. */
export function declareNamespaces(doc, fragment) {
  for (const node of [fragment, ...fragment.querySelectorAll("*")]) {
    if (node.prefix && node.namespaceURI) ensureNamespace(doc, node.prefix, node.namespaceURI);
    for (const attr of node.attributes) {
      if (attr.prefix && attr.prefix !== "xmlns" && attr.prefix !== "xml" && attr.namespaceURI) ensureNamespace(doc, attr.prefix, attr.namespaceURI);
    }
  }
}

// ----------------------------------------------------------------- style --

/** Set a style property where the element keeps it: its attribute if it has one, else `style`. */
export function setProperty(el, property, value) {
  const style = el.getAttribute("style");
  const inStyle = g.parseStyle(style).some(([name]) => name === property);
  if (el.hasAttribute(property) && !inStyle) { if (value === null) el.removeAttribute(property); else el.setAttribute(property, value); return; }
  const next = g.setStyleProperty(style, property, value);
  if (next) el.setAttribute("style", next); else el.removeAttribute("style");
}

/** Does the element set `property` itself (attribute or style)? */
export const setsProperty = (el, property) => el.hasAttribute(property) || g.parseStyle(el.getAttribute("style")).some(([name]) => name === property);

// ------------------------------------------------------------------ text --

/** The lines of a text element: its line tspans (each placed with x or y), or the text itself. */
export function textLines(text) {
  const tspans = [...text.children].filter((c) => c.localName === "tspan");
  const lines = tspans.length && tspans.every((t) => t.hasAttribute("x") || t.hasAttribute("y") || t.getAttributeNS(SODIPODI_NS, "role") === "line") ? tspans : [text];
  return lines.map((node) => ({ node, text: node.textContent }));
}

/**
 * Put `lines` into a text element. Lines that did not change keep their nodes (and inner styles); a
 * changed line becomes plain text in its own tspan; new lines copy the last line one line lower.
 */
export function setTextLines(text, lines, { lineHeight, taken }) {
  const old = textLines(text);
  if (old.length === 1 && old[0].node === text) {
    if (lines.length === 1) { if (text.textContent !== lines[0]) text.textContent = lines[0]; return; }
    // One plain line becomes line tspans.
    const x = text.getAttribute("x") ?? "0";
    const y = Number.parseFloat(text.getAttribute("y") ?? "0");
    ensureNamespace(text.ownerDocument, "sodipodi", SODIPODI_NS);
    text.textContent = "";
    lines.forEach((line, i) => {
      const tspan = text.ownerDocument.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("id", g.freshId("tspan", taken));
      tspan.setAttributeNS(SODIPODI_NS, "sodipodi:role", "line");
      tspan.setAttribute("x", x);
      tspan.setAttribute("y", g.fmt(y + i * lineHeight));
      tspan.textContent = line;
      text.append(tspan);
    });
    return;
  }
  lines.forEach((line, i) => {
    if (i < old.length) { if (old[i].text !== line) old[i].node.textContent = line; return; }
    const last = text.lastElementChild;
    const tspan = last.cloneNode(false);
    if (tspan.id) tspan.setAttribute("id", g.freshId("tspan", taken));
    const y = Number.parseFloat(last.getAttribute("y"));
    if (Number.isFinite(y)) tspan.setAttribute("y", g.fmt(y + lineHeight));
    tspan.textContent = line;
    last.after(tspan);
  });
  for (const { node } of old.slice(lines.length)) node.remove();
}

// ------------------------------------------------------------- figures --

/**
 * An SVG file as a group for this document: its content (metadata and Inkscape settings left out),
 * ids made unique, namespaces declared. Returns the group (not yet placed) and the figure's box in
 * its own units, plus its size in px.
 */
export function importSvg(doc, text, name, taken) {
  const source = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = source.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg") throw new Error(`${name} is not an SVG drawing`);
  const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const width = g.lengthInPx(root.getAttribute("width"));
  const height = g.lengthInPx(root.getAttribute("height"));
  const box = vb.length === 4 && vb.every(Number.isFinite) ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : { x: 0, y: 0, w: width ?? 100, h: height ?? 100 };
  const px = { w: width ?? (height ? (height * box.w) / box.h : box.w), h: height ?? (width ? (width * box.h) / box.w : box.h) };
  const group = doc.createElementNS(SVG_NS, "g");
  ensureNamespace(doc, "inkscape", INKSCAPE_NS);
  group.setAttributeNS(INKSCAPE_NS, "inkscape:label", name);
  // Presentation attributes on the figure's root still apply to its content.
  for (const attr of root.attributes) {
    if (!attr.namespaceURI && !["width", "height", "viewBox", "version", "id", "x", "y", "preserveAspectRatio", "baseProfile"].includes(attr.name)) group.setAttribute(attr.name, attr.value);
  }
  for (const child of [...root.childNodes]) {
    if (child.nodeType !== 1 || ["metadata", "namedview"].includes(child.localName)) continue;
    group.append(doc.importNode(child, true));
  }
  // A page-wide rule (matplotlib's "*{stroke-linejoin: round}") would restyle the whole poster: it becomes the group's style.
  for (const style of [...group.querySelectorAll("style")]) {
    const universal = /^\s*\*\s*\{([^}]*)\}\s*$/.exec(style.textContent);
    if (!universal) continue;
    for (const [property, value] of g.parseStyle(universal[1])) group.setAttribute("style", g.setStyleProperty(group.getAttribute("style"), property, value));
    const holder = style.parentNode;
    style.remove();
    if (holder.localName === "defs" && !holder.children.length) holder.remove();
  }
  freshenIds(group, taken);
  group.setAttribute("id", g.freshId("g", taken));
  declareNamespaces(doc, group);
  return { group, box, px };
}
