// The Writer's editor: Milkdown (ProseMirror + remark) with Quarto nodes.
// Bundled by scripts/vendor.mjs into thunderbird-addon/vendor/writer/writer.mjs;
// the page (writer.js) owns files, saving, toolbar and agent commands.
//
// Fidelity: a document is cut by splitQuarto into Markdown runs and kept Quarto
// constructs. Runs go through the Markdown parser; every top-level block is
// remembered with its original text. On save, `assemble` writes untouched
// blocks (the same ProseMirror node objects) back verbatim; only edited blocks
// are serialized. Kept constructs are nodes that carry their exact source.
import katex from "katex";
import { Editor, rootCtx, editorViewCtx, parserCtx, serializerCtx, schemaCtx, remarkCtx, commandsCtx, editorViewOptionsCtx } from "@milkdown/kit/core";
import { commonmark, imageSchema } from "@milkdown/kit/preset/commonmark";
import * as cm from "@milkdown/kit/preset/commonmark";
import { gfm, insertTableCommand, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { history, undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { $node, $remark, $view, $prose } from "@milkdown/kit/utils";
import { EditorState, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import remarkMath from "remark-math";
import { assemble, gapsOf, inlineTokens, splitQuarto } from "./quarto.mjs";

// ------------------------------------------------------ remark: safety net --

const BLOCK_TYPES = new Set(["paragraph", "heading", "thematicBreak", "blockquote", "list", "listItem", "code", "table", "tableRow", "tableCell", "footnoteDefinition", "quartoBlock"]);
const INLINE_TYPES = new Set(["text", "emphasis", "strong", "inlineCode", "link", "image", "break", "html", "delete", "footnoteReference", "inlineMath", "quartoInline"]);
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

/**
 * Runs after parsing: anything Milkdown has no node for becomes a kept node
 * with its exact source, display math becomes a kept block, and Quarto inline
 * syntax inside text becomes chips. Nothing the parser does not model is lost.
 */
function quartoRemark() {
  return (tree, file) => {
    const source = String(file?.value ?? "");
    const slice = (node) => (node.position ? source.slice(node.position.start.offset, node.position.end.offset) : "");
    const walk = (node) => {
      if (!node.children) return;
      const blockParent = BLOCK_PARENTS.has(node.type);
      const out = [];
      for (const child of node.children) {
        // Pandoc inline notes ^[…] have no Markdown equivalent: such a paragraph is
        // kept as source, so an edit can never escape its brackets.
        if (blockParent && child.type === "paragraph" && /\^\[/.test(slice(child))) { out.push({ type: "quartoBlock", kind: "raw", label: "paragraph with a note", source: slice(child), position: child.position }); continue; }
        if (blockParent && child.type === "math") { out.push({ type: "quartoBlock", kind: "math", label: "", source: slice(child), position: child.position }); continue; }
        if (blockParent && !BLOCK_TYPES.has(child.type)) { out.push({ type: "quartoBlock", kind: "raw", label: child.type, source: slice(child), position: child.position }); continue; }
        if (!blockParent && !INLINE_TYPES.has(child.type) && !BLOCK_TYPES.has(child.type)) { out.push({ type: "quartoInline", kind: "raw", source: slice(child), position: child.position }); continue; }
        if (child.type === "text" && child.value) { out.push(...splitText(child)); continue; }
        if (child.type === "inlineMath") { out.push({ type: "quartoInline", kind: "math", source: slice(child) || `$${child.value}$`, position: child.position }); continue; }
        walk(child);
        out.push(child);
      }
      node.children = out;
    };
    walk(tree);
  };
}

function splitText(node) {
  const tokens = inlineTokens(node.value);
  if (!tokens.length) return [node];
  const out = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start > at) out.push({ type: "text", value: node.value.slice(at, token.start) });
    out.push({ type: "quartoInline", kind: token.kind, source: token.text });
    at = token.end;
  }
  if (at < node.value.length) out.push({ type: "text", value: node.value.slice(at) });
  return out;
}

// ------------------------------------------------------------ the nodes --

/** A Quarto construct kept as exact source: front matter, code, math, ::: fences, LaTeX, comments, raw. */
const quartoBlock = $node("quarto_block", () => ({
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  attrs: { kind: { default: "raw" }, label: { default: "" }, source: { default: "" } },
  toDOM: (node) => ["div", { "data-quarto": node.attrs.kind }, node.attrs.source],
  parseDOM: [{ tag: "div[data-quarto]", getAttrs: (dom) => ({ kind: dom.dataset.quarto, source: dom.textContent }) }],
  parseMarkdown: {
    match: (node) => node.type === "quartoBlock",
    runner: (state, node, type) => state.addNode(type, { kind: node.kind, label: node.label ?? "", source: node.source }),
  },
  toMarkdown: {
    match: (node) => node.type.name === "quarto_block",
    runner: (state, node) => state.addNode("html", undefined, node.attrs.source),
  },
}));

/** Quarto inline syntax kept as source: citations, cross-references, attributes, shortcodes, spans, math. */
const quartoInline = $node("quarto_inline", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  attrs: { kind: { default: "raw" }, source: { default: "" } },
  toDOM: (node) => ["span", { "data-quarto-inline": node.attrs.kind }, node.attrs.source],
  parseDOM: [{ tag: "span[data-quarto-inline]", getAttrs: (dom) => ({ kind: dom.dataset.quartoInline, source: dom.textContent }) }],
  parseMarkdown: {
    match: (node) => node.type === "quartoInline",
    runner: (state, node, type) => state.addNode(type, { kind: node.kind, source: node.source }),
  },
  toMarkdown: {
    match: (node) => node.type.name === "quarto_inline",
    runner: (state, node) => state.addNode("html", undefined, node.attrs.source),
  },
}));

// ----------------------------------------------------------- node views --

function renderMath(target, tex, displayMode) {
  try { katex.render(tex, target, { displayMode, throwOnError: false, strict: "ignore", trust: false }); }
  catch { target.textContent = tex; }
}

/** Display math body and label from its source: $$ … $$ {#eq-x}. */
export function parseDisplayMath(source) {
  const m = /^\s*\$\$([\s\S]*?)\$\$\s*(\{[^}]*\})?\s*$/.exec(source);
  return m ? { tex: m[1].trim(), attrs: m[2] ?? "" } : { tex: source, attrs: "" };
}

const KIND_LABEL = { frontmatter: "Document settings", code: "Code", math: "Equation", div: "Block", latex: "LaTeX", comment: "Comment", raw: "Source" };

function blockView(hooks) {
  return (node, view, getPos) => {
    const dom = document.createElement("div");
    dom.className = `qb qb-${node.attrs.kind}`;
    dom.contentEditable = "false";
    let current = node;
    let editing = false;

    const commit = (source) => {
      const pos = getPos();
      if (typeof pos !== "number" || source === current.attrs.source) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, source }));
    };

    const edit = () => {
      if (editing) return;
      editing = true;
      const area = document.createElement("textarea");
      area.className = "qb-source";
      area.spellcheck = false;
      area.value = current.attrs.source;
      area.rows = Math.max(2, current.attrs.source.split("\n").length);
      const done = () => { if (!editing) return; editing = false; commit(area.value); draw(); };
      area.addEventListener("blur", done);
      area.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { area.value = current.attrs.source; area.blur(); }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); area.blur(); }
        event.stopPropagation();
      });
      area.addEventListener("input", () => { area.rows = Math.max(2, area.value.split("\n").length); });
      dom.replaceChildren(header(true), area);
      area.focus();
    };

    const header = (open) => {
      const bar = document.createElement("div");
      bar.className = "qb-bar";
      const kind = current.attrs.kind;
      const name = document.createElement("span");
      name.className = "qb-kind";
      name.textContent = kind === "div" ? divTitle(current.attrs.source) : kind === "code" ? (current.attrs.label || "code") : KIND_LABEL[kind] ?? kind;
      bar.append(name);
      const label = current.attrs.label && kind === "math" ? current.attrs.label : "";
      if (label) { const chip = document.createElement("span"); chip.className = "qb-label"; chip.textContent = label; bar.append(chip); }
      if (!open) bar.title = "Click to edit the source";
      return bar;
    };

    const draw = () => {
      const { kind, source } = current.attrs;
      dom.className = `qb qb-${kind}${kind === "div" && /^\s*:{3,}\s*$/.test(source) ? " qb-div-close" : ""}`;
      dom.replaceChildren();
      if (kind === "math") {
        const { tex } = parseDisplayMath(source);
        const body = document.createElement("div");
        body.className = "qb-math";
        renderMath(body, tex, true);
        dom.append(body);
        if (current.attrs.label) { const chip = document.createElement("span"); chip.className = "qb-eqlabel"; chip.textContent = `(${current.attrs.label})`; dom.append(chip); }
      } else if (kind === "frontmatter") {
        const title = /^title:\s*["']?(.*?)["']?\s*$/m.exec(source)?.[1] ?? "";
        dom.append(header(false));
        const summary = document.createElement("div");
        summary.className = "qb-summary";
        summary.textContent = title ? title : `${source.split("\n").length - 2} settings`;
        dom.append(summary);
      } else if (kind === "div") {
        if (/^\s*:{3,}\s*$/.test(source)) { const end = document.createElement("span"); end.className = "qb-kind"; end.textContent = "end of block"; dom.append(end); }
        else dom.append(header(false));
      } else {
        dom.append(header(false));
        const pre = document.createElement("pre");
        pre.className = "qb-pre";
        pre.textContent = kind === "code" ? source.split("\n").slice(1, -1).join("\n") : source;
        dom.append(pre);
      }
    };

    dom.addEventListener("click", (event) => { if (!editing && !event.defaultPrevented) edit(); });
    draw();
    return {
      dom,
      update: (next) => { if (next.type !== current.type) return false; current = next; if (!editing) draw(); return true; },
      stopEvent: (event) => editing && event.target instanceof HTMLTextAreaElement,
      ignoreMutation: () => true,
      selectNode: () => dom.classList.add("selected"),
      deselectNode: () => dom.classList.remove("selected"),
    };
  };
}

function divTitle(source) {
  const rest = source.replace(/^\s*:{3,}\s*/, "").trim();
  const classes = /\.(callout-\w+|[\w-]+)/.exec(rest)?.[1];
  const id = /#([\w-]+)/.exec(rest)?.[1];
  if (classes?.startsWith("callout-")) return `${classes.slice(8)[0].toUpperCase()}${classes.slice(9)} callout`;
  if (id?.startsWith("fig-")) return `Figure ${id}`;
  if (id === "refs") return "References";
  return rest ? `Block ${rest}` : "Block";
}

const INLINE_ICON = { cite: "📖", crossref: "#", attr: "", shortcode: "⟨⟩", math: "", span: "", raw: "" };

function inlineView(hooks) {
  return (node, view, getPos) => {
    const dom = document.createElement("span");
    let current = node;
    const draw = () => {
      const { kind, source } = current.attrs;
      dom.className = `qi qi-${kind}`;
      dom.replaceChildren();
      if (kind === "math") { renderMath(dom, source.replace(/^\$+|\$+$/g, ""), false); return; }
      if (kind === "cite") dom.textContent = source.replace(/^\[|\]$/g, "");
      else dom.textContent = source;
      dom.title = kind === "cite" ? "Citation · click to edit" : kind === "crossref" ? "Cross-reference · click to edit" : "Click to edit";
      if (kind === "cite" || kind === "crossref") hooks.describeInline?.(current.attrs, dom);
    };
    dom.contentEditable = "false";
    dom.addEventListener("click", async (event) => {
      event.preventDefault();
      const pos = getPos();
      const next = await hooks.editInline?.(current.attrs);
      if (typeof pos !== "number" || next === null || next === undefined || next === current.attrs.source) return;
      if (next === "") { view.dispatch(view.state.tr.delete(pos, pos + current.nodeSize)); return; }
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, source: next }));
    });
    draw();
    return { dom, update: (next) => { if (next.type !== current.type) return false; current = next; draw(); return true; }, ignoreMutation: () => true };
  };
}

function imageView(hooks) {
  return (node) => {
    const dom = document.createElement("img");
    let current = node;
    const draw = () => {
      dom.alt = current.attrs.alt ?? "";
      dom.title = current.attrs.src;
      dom.className = "wr-image";
      Promise.resolve(hooks.resolveImage?.(current.attrs.src)).then((url) => { if (url) dom.src = url; else dom.classList.add("missing"); }, () => dom.classList.add("missing"));
    };
    draw();
    return { dom, update: (next) => { if (next.type !== current.type) return false; current = next; draw(); return true; } };
  };
}

// ----------------------------------------------------- grammar marks --

const grammarKey = new PluginKey("writer-grammar");
const grammarPlugin = $prose(() => new Plugin({
  key: grammarKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, set) => {
      const next = tr.getMeta(grammarKey);
      if (next) return next;
      return set.map(tr.mapping, tr.doc);
    },
  },
  props: { decorations: (state) => grammarKey.getState(state) },
}));

// ------------------------------------------------- supervisor review --
//
// A review is a region (the passage the user selected) with comments on parts
// of it. Both live in plugin state and move with edits; a comment disappears
// once the text it quotes is changed. The page draws the region frame and the
// hover cards; the plugin draws the coloured underlines.

const reviewKey = new PluginKey("writer-review");
let reviewIds = 0;

/** Text of a range as the reviewer sees it: chips as their source, blocks separated by blank lines. */
function rangeText(doc, from, to) {
  let text = "";
  const starts = []; // doc position where each character starts
  const ends = [];   // doc position right after each character
  let first = true;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (!first) { for (const ch of "\n\n") { starts.push(pos); ends.push(pos); text += ch; } }
    first = false;
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      if (child.isText) {
        for (let k = 0; k < child.text.length; k++) {
          const p = at + k;
          if (p < from || p >= to) continue;
          starts.push(p); ends.push(p + 1); text += child.text[k];
        }
      } else if (at >= from && at < to) {
        const source = child.type.name === "quarto_inline" ? child.attrs.source : child.type.name === "hardbreak" ? "\n" : "";
        for (const ch of source) { starts.push(at); ends.push(at + child.nodeSize); text += ch; }
      }
    });
    return false;
  });
  return { text, starts, ends };
}

const reviewPlugin = $prose(() => new Plugin({
  key: reviewKey,
  state: {
    init: () => ({ regions: [], comments: [] }),
    apply: (tr, value, _old, state) => {
      let { regions, comments } = value;
      if (tr.docChanged) {
        const map = (r) => ({ ...r, from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) });
        regions = regions.map(map).filter((r) => r.to > r.from);
        comments = comments.map(map).filter((c) => c.to > c.from && rangeText(state.doc, c.from, c.to).text === c.quote);
      }
      const meta = tr.getMeta(reviewKey);
      if (meta?.clear) return { regions: [], comments: [] };
      if (meta?.add) regions = [...regions, meta.add];
      if (meta?.update) regions = regions.map((r) => (r.id === meta.update.id ? { ...r, ...meta.update } : r));
      if (meta?.comments) comments = [...comments.filter((c) => c.region !== meta.comments.region), ...meta.comments.list];
      if (meta?.removeComment) comments = comments.filter((c) => c.id !== meta.removeComment);
      if (meta?.removeRegion) { regions = regions.filter((r) => r.id !== meta.removeRegion); comments = comments.filter((c) => c.region !== meta.removeRegion); }
      return { regions, comments };
    },
  },
  props: {
    decorations: (state) => {
      const { regions, comments } = reviewKey.getState(state);
      if (!regions.length) return null;
      const decorations = [];
      for (const r of regions) decorations.push(Decoration.inline(r.from, r.to, { class: `rv-region rv-region-${r.state}`, "data-rv-region": String(r.id) }));
      for (const c of comments) decorations.push(Decoration.inline(c.from, c.to, { class: `rv rv-${c.kind}`, "data-rv": String(c.id) }));
      return DecorationSet.create(state.doc, decorations);
    },
  },
}));

// --------------------------------------------------------------- editor --

/**
 * Create the editor in `root`. Hooks (all optional):
 *   onChange()                 the document changed (debounce saving in the page)
 *   onSelection(info)          cursor or selection moved
 *   resolveImage(src)          → URL to display a relative image path
 *   editInline(attrs)          → new source for a chip, "" to delete, null to keep
 *   describeInline(attrs, el)  decorate a citation/cross-reference chip
 */
export async function createWriter(root, hooks = {}) {
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, attributes: { class: "wr-doc", spellcheck: "false" } }));
      ctx.get(listenerCtx).updated(() => hooks.onChange?.());
      ctx.get(listenerCtx).selectionUpdated(() => hooks.onSelection?.());
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(clipboard)
    .use(listener)
    .use($remark("remarkMath", () => remarkMath))
    .use($remark("quartoRemark", () => quartoRemark))
    .use(quartoBlock)
    .use(quartoInline)
    .use($view(quartoBlock, () => blockView(hooks)))
    .use($view(quartoInline, () => inlineView(hooks)))
    .use($view(imageSchema.node, () => imageView(hooks)))
    .use(grammarPlugin)
    .use(reviewPlugin)
    .create();

  const view = editor.ctx.get(editorViewCtx);
  const schema = editor.ctx.get(schemaCtx);
  const parse = editor.ctx.get(parserCtx);
  const stringify = editor.ctx.get(serializerCtx);
  const remark = editor.ctx.get(remarkCtx);

  let loaded = { source: "", units: [], gaps: [""] };

  const serializeNodes = (nodes) => stringify(schema.topNodeType.create(null, nodes));
  const own = (node) => (node.type.name === "quarto_block" ? node.attrs.source : null);
  const current = () => { const out = []; view.state.doc.forEach((n) => out.push(n)); return out; };

  /** Parse a document into nodes and units (see the module comment). */
  function build(source) {
    const units = [];
    for (const segment of splitQuarto(source)) {
      if (segment.kind !== "markdown") {
        units.push({ ...segment, nodes: [schema.nodes.quarto_block.create({ kind: segment.kind, label: segment.label ?? "", source: segment.text })] });
        continue;
      }
      const doc = parse(segment.text);
      const nodes = [];
      doc.forEach((n) => nodes.push(n));
      const tree = remark.runSync(remark.parse(segment.text), segment.text);
      const blocks = tree.children.filter((c) => c.position);
      if (blocks.length === nodes.length && nodes.length) {
        blocks.forEach((block, k) => {
          const start = segment.start + block.position.start.offset;
          const end = segment.start + block.position.end.offset;
          units.push({ kind: "markdown", start, end, text: source.slice(start, end), nodes: [nodes[k]] });
        });
      } else if (nodes.length) {
        units.push({ ...segment, nodes }); // keep the whole run together
      }
    }
    return units;
  }

  /** Load a document. `keep` restores scroll and cursor (for reloads after outside edits). */
  function load(source, { keep = false } = {}) {
    const scroll = keep ? root.scrollTop : 0;
    const anchor = keep ? cursorAnchor() : null;
    let units = build(source);
    let nodes = units.flatMap((u) => u.nodes);
    let doc = schema.topNodeType.createAndFill(null, nodes.length ? nodes : undefined);
    const state = EditorState.create({ doc, plugins: view.state.plugins });
    view.updateState(state);
    // The view may normalize; re-anchor units on the nodes it actually holds.
    const now = current();
    if (now.length === nodes.length && now.some((n, k) => n !== nodes[k])) {
      let k = 0;
      units = units.map((u) => ({ ...u, nodes: u.nodes.map(() => now[k++]) }));
    }
    loaded = { source, units, gaps: gapsOf(source, units) };
    const check = markdown();
    loaded.safe = check === source;
    if (keep) { root.scrollTop = scroll; restoreCursor(anchor); }
    return { safe: loaded.safe, blocks: units.length, ...(loaded.safe ? {} : { mismatchAt: firstDifference(check, source) }) };
  }

  /** The document as text: original text for untouched blocks. */
  function markdown() {
    return assemble({ units: loaded.units, gaps: loaded.gaps, current: current(), serialize: serializeNodes, own });
  }

  function cursorAnchor() {
    const { from } = view.state.selection;
    let index = 0;
    let offset = 0;
    view.state.doc.forEach((node, pos, i) => { if (from >= pos && from <= pos + node.nodeSize) { index = i; offset = from - pos; } });
    return { index, offset };
  }
  function restoreCursor(anchor) {
    if (!anchor) return;
    let target = null;
    view.state.doc.forEach((node, pos, i) => { if (i === anchor.index) target = Math.min(pos + anchor.offset, pos + node.nodeSize - 1); });
    if (target === null) return;
    try { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(target))).setMeta("addToHistory", false)); } catch { /* keep the default */ }
  }

  const run = (key, payload) => editor.action((ctx) => ctx.get(commandsCtx).call(key.key ?? key, payload));

  const api = {
    editor,
    view,
    load,
    markdown,
    get loadedSource() { return loaded.source; },
    get safe() { return loaded.safe; },
    isClean: () => markdown() === loaded.source,
    focus: () => view.focus(),

    /** Headings for the outline: { level, text, pos, index }. */
    outline() {
      const out = [];
      view.state.doc.forEach((node, pos, index) => {
        if (node.type.name === "heading") out.push({ level: node.attrs.level, text: node.textContent.replace(/\s*\{[#.][^}]*\}\s*$/, "").trim(), pos, index });
        if (node.type.name === "quarto_block" && node.attrs.kind === "frontmatter") out.push({ level: 0, text: "Document settings", pos, index });
      });
      return out;
    },

    /** Where the cursor is: the heading it sits under, and the selected text. */
    where() {
      const { from, to, empty } = view.state.selection;
      let heading = null;
      view.state.doc.forEach((node, pos) => { if (node.type.name === "heading" && pos <= from) heading = node.textContent.replace(/\s*\{[#.][^}]*\}\s*$/, "").trim(); });
      const text = empty || view.state.selection.node ? "" : view.state.doc.textBetween(from, to, "\n\n", " ").trim();
      return { heading, selection: text, from, to };
    },

    reveal(pos) {
      const dom = view.nodeDOM(pos);
      if (dom?.scrollIntoView) dom.scrollIntoView({ block: "start", behavior: "smooth" });
      try { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(pos + 1, view.state.doc.content.size))))); } catch { /* ignore */ }
      view.focus();
    },

    /** Find text in the document; returns the position of the block containing it. */
    find(text) {
      let found = null;
      view.state.doc.descendants((node, pos) => {
        if (found !== null) return false;
        if (node.isTextblock && node.textContent.includes(text)) { found = pos; return false; }
        if (node.type.name === "quarto_block" && node.attrs.source.includes(text)) { found = pos; return false; }
        return true;
      });
      return found;
    },

    /** Insert Markdown: at the cursor, at the end, or after the block at `pos`. */
    insertMarkdown(md, where = "cursor") {
      const units = build(md.endsWith("\n") ? md : `${md}\n`);
      const nodes = units.flatMap((u) => u.nodes);
      if (!nodes.length) return 0;
      const { state } = view;
      let at;
      if (where === "end") at = state.doc.content.size;
      else if (typeof where === "number") { const node = state.doc.nodeAt(where); at = node ? where + node.nodeSize : state.doc.content.size; }
      else { const $from = state.selection.$from; at = $from.depth ? $from.after(1) : $from.pos; }
      view.dispatch(state.tr.insert(at, nodes).scrollIntoView());
      return nodes.length;
    },

    /** Replace the selection with Markdown (block-level when the selection spans blocks). */
    replaceSelection(md) {
      const { state } = view;
      const { from, to, $from, $to } = state.selection;
      const doc = parse(md);
      const inline = doc.childCount === 1 && doc.firstChild.isTextblock && $from.sameParent($to);
      const tr = inline ? state.tr.replaceWith(from, to, doc.firstChild.content) : state.tr.replaceWith($from.before(1), $to.after(1), build(md).flatMap((u) => u.nodes));
      view.dispatch(tr.scrollIntoView());
    },

    insertInline(kind, source) {
      const node = schema.nodes.quarto_inline.create({ kind, source });
      view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
      view.focus();
    },

    insertBlocks(sources) {
      const nodes = sources.map(([kind, source, label = ""]) => kind === "markdown" ? build(`${source}\n`).flatMap((u) => u.nodes) : [schema.nodes.quarto_block.create({ kind, source, label })]).flat();
      const $from = view.state.selection.$from;
      const at = $from.depth ? $from.after(1) : $from.pos;
      view.dispatch(view.state.tr.insert(at, nodes).scrollIntoView());
      view.focus();
    },

    /** Toolbar commands by name. */
    command(name, payload) {
      const map = {
        bold: cm.toggleStrongCommand, italic: cm.toggleEmphasisCommand, strike: toggleStrikethroughCommand, code: cm.toggleInlineCodeCommand,
        bullet: cm.wrapInBulletListCommand, ordered: cm.wrapInOrderedListCommand, quote: cm.wrapInBlockquoteCommand, hr: cm.insertHrCommand,
        paragraph: cm.turnIntoTextCommand, heading: cm.wrapInHeadingCommand, link: cm.toggleLinkCommand, image: cm.insertImageCommand,
        table: insertTableCommand, undo: undoCommand, redo: redoCommand, codeblock: cm.createCodeBlockCommand,
      };
      const key = map[name];
      if (!key) throw new Error(`Unknown command ${name}`);
      run(key, payload);
      view.focus();
    },

    /** Plain text of the visible textblocks, for grammar checking: { text, map } per block. */
    textBlocks({ from = 0, to = view.state.doc.content.size } = {}) {
      const out = [];
      view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock || node.type.name === "code_block") return node.type.name !== "code_block";
        let text = "";
        const map = []; // text offset → doc position
        node.forEach((child, offset) => {
          const at = pos + 1 + offset;
          if (child.isText) { for (let k = 0; k < child.text.length; k++) map.push(at + k); text += child.text; }
          else { map.push(at); text += child.type.name === "quarto_inline" && child.attrs.kind === "cite" ? "Smith" : "X"; }
        });
        if (text.trim().length > 3) out.push({ pos, text, map });
        return false;
      });
      return out;
    },

    /** Show grammar issues: [{ from, to, match }]. */
    setGrammar(issues) {
      const decorations = issues.map((issue) => Decoration.inline(issue.from, issue.to, { class: `gram ${issue.match.spelling ? "gram-spell" : "gram-style"}`, "data-gram": String(issue.id) }, { issue }));
      view.dispatch(view.state.tr.setMeta(grammarKey, DecorationSet.create(view.state.doc, decorations)).setMeta("addToHistory", false));
    },
    grammarAt(pos) {
      const set = grammarKey.getState(view.state);
      return set?.find(pos, pos).map((d) => ({ from: d.from, to: d.to, ...d.spec.issue })) ?? [];
    },
    replaceRange(from, to, text) {
      view.dispatch(view.state.tr.insertText(text, from, to));
    },

    // --- supervisor review ---------------------------------------------------

    /** Start a review of the selection: returns { id, text, before, after, heading } or null. */
    startReview() {
      const { from, to, empty } = view.state.selection;
      if (empty || view.state.selection.node) return null;
      const { text } = rangeText(view.state.doc, from, to);
      if (!text.trim()) return null;
      const id = ++reviewIds;
      const before = rangeText(view.state.doc, Math.max(0, from - 2000), from).text;
      const after = rangeText(view.state.doc, to, Math.min(view.state.doc.content.size, to + 1000)).text;
      let heading = "";
      view.state.doc.forEach((node, pos) => { if (node.type.name === "heading" && pos < from) heading = node.textContent.replace(/\s*\{[#.][^}]*\}\s*$/, "").trim(); });
      view.dispatch(view.state.tr.setMeta(reviewKey, { add: { id, from, to, state: "pending", text, heading } }).setMeta("addToHistory", false));
      return { id, text, before, after, heading };
    },

    /** Attach the reviewer's answer: comments carry offsets into the reviewed text. */
    finishReview(id, result) {
      const region = this.reviews().regions.find((r) => r.id === id);
      if (!region) return null;
      const now = rangeText(view.state.doc, region.from, region.to);
      const list = [];
      for (const c of result.comments ?? []) {
        let start = c.start;
        let end = c.end;
        if (now.text !== region.text) { // edited meanwhile: find the quote again
          start = now.text.indexOf(c.quote);
          if (start < 0) continue;
          end = start + c.quote.length;
        }
        if (start === undefined || end > now.text.length || start >= end) continue;
        list.push({ id: ++reviewIds, region: id, from: now.starts[start], to: now.ends[end - 1], kind: c.kind, comment: c.comment, quote: c.quote, replacement: c.replacement });
      }
      view.dispatch(view.state.tr.setMeta(reviewKey, { update: { id, state: result.error ? "error" : result.verdict, summary: result.summary ?? result.error ?? "" }, comments: { region: id, list } }).setMeta("addToHistory", false));
      return list.length;
    },

    failReview(id, message) {
      view.dispatch(view.state.tr.setMeta(reviewKey, { update: { id, state: "error", summary: message } }).setMeta("addToHistory", false));
    },

    /** Select the first occurrence of `needle` in the document's text. */
    selectText(needle) {
      let found = null;
      view.state.doc.descendants((node, pos) => {
        if (found || !node.isTextblock) return !found;
        const { text, starts, ends } = rangeText(view.state.doc, pos, pos + node.nodeSize);
        const at = text.indexOf(needle);
        if (at >= 0) found = [starts[at], ends[at + needle.length - 1]];
        return false;
      });
      return found ? this.selectRange(found[0], found[1]) : false;
    },

    selectRange(from, to) {
      try { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))); return true; } catch { return false; }
    },

    reviews: () => reviewKey.getState(view.state),
    clearReviews() { view.dispatch(view.state.tr.setMeta(reviewKey, { clear: true }).setMeta("addToHistory", false)); },
    removeRegion(id) { view.dispatch(view.state.tr.setMeta(reviewKey, { removeRegion: id }).setMeta("addToHistory", false)); },
    dismissComment(id) { view.dispatch(view.state.tr.setMeta(reviewKey, { removeComment: id }).setMeta("addToHistory", false)); },

    /** Apply a comment's replacement (parsed as Markdown, so citations and math stay chips). */
    acceptComment(id) {
      const comment = this.reviews().comments.find((c) => c.id === id);
      if (!comment || comment.replacement === undefined) return false;
      const parsed = parse(comment.replacement || " ");
      const content = parsed.childCount === 1 && parsed.firstChild.isTextblock ? parsed.firstChild.content : null;
      const tr = view.state.tr;
      if (content && comment.replacement) tr.replaceWith(comment.from, comment.to, content);
      else tr.insertText(comment.replacement, comment.from, comment.to);
      tr.setMeta(reviewKey, { removeComment: id });
      view.dispatch(tr);
      return true;
    },

    /** Client rectangles of a document range (for drawing review frames). */
    rangeRects(from, to) {
      try {
        const start = view.domAtPos(from);
        const end = view.domAtPos(to);
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        return [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      } catch { return []; }
    },

    destroy: () => editor.destroy(),
  };
  return api;
}

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { offset: i, ours: a.slice(Math.max(0, i - 40), i + 40), theirs: b.slice(Math.max(0, i - 40), i + 40) };
}

// The page uses these too (merging on conflicts, cross-reference autocomplete).
export { merge3, labels, splitQuarto } from "./quarto.mjs";
