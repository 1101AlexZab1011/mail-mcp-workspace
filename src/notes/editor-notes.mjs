// The Notes layer on the Writer's editor (createWriter(root, hooks, { mode: "notes" })):
//   /-menu        typing "/" offers blocks (hooks.onSlash / onSlashKey draw and drive the menu)
//   block handle  ⋮⋮ beside the hovered block: drag to move it, click for its menu (hooks.onBlockMenu); + adds a block
//   callouts      > [!note] Title … blockquotes shown as callouts; [!x]- / [!x]+ fold (toggles)
//   to-dos        - [ ] items with a clickable box
// Everything stays plain Markdown (GitHub and Obsidian show the same file).
import { $prose, $remark } from "@milkdown/kit/utils";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { block, BlockProvider } from "@milkdown/kit/plugin/block";

export const SLASH_ITEMS = [
  { id: "text", label: "Text", hint: "Plain text", keys: "paragraph p" },
  { id: "h1", label: "Heading 1", hint: "Big section heading", keys: "title h1" },
  { id: "h2", label: "Heading 2", hint: "Medium section heading", keys: "h2" },
  { id: "h3", label: "Heading 3", hint: "Small section heading", keys: "h3" },
  { id: "todo", label: "To-do list", hint: "Track tasks with a checkbox", keys: "task checkbox check" },
  { id: "bullet", label: "Bulleted list", hint: "A simple list", keys: "ul unordered" },
  { id: "numbered", label: "Numbered list", hint: "A list with numbers", keys: "ol ordered" },
  { id: "toggle", label: "Toggle", hint: "Hide content inside", keys: "fold collapse details" },
  { id: "callout", label: "Callout", hint: "Make writing stand out", keys: "note info tip" },
  { id: "warning", label: "Warning callout", hint: "Something to watch out for", keys: "caution" },
  { id: "quote", label: "Quote", hint: "Capture a quote", keys: "blockquote" },
  { id: "divider", label: "Divider", hint: "Separate blocks", keys: "hr line rule" },
  { id: "page", label: "Link to page", hint: "Link another page", keys: "wikilink link" },
  { id: "subpage", label: "Page", hint: "A new page inside this one", keys: "new child" },
  { id: "database", label: "Database", hint: "Table and board of pages", keys: "table board db" },
  { id: "table", label: "Table", hint: "A simple Markdown table", keys: "grid" },
  { id: "image", label: "Image", hint: "Upload or paste an image", keys: "picture photo" },
  { id: "code", label: "Code", hint: "Capture a code snippet", keys: "snippet" },
  { id: "math", label: "Equation", hint: "TeX display math", keys: "latex formula" },
];

export function filterSlash(query) {
  const q = String(query ?? "").toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((item) => `${item.id} ${item.label} ${item.keys}`.toLowerCase().includes(q));
}

// ------------------------------------------------------- remark: callouts --

/**
 * In "> [!note] Title\n> Body" the title line and the body are one Markdown paragraph; Obsidian (and Notes)
 * read the first line as the title. Split it off so the title shows on its own line and a folded toggle hides
 * the body. Untouched callouts are still written back exactly as they were.
 */
export function calloutRemark() {
  return (tree) => {
    const visit = (node) => {
      for (const child of node.children ?? []) visit(child);
      if (node.type !== "blockquote") return;
      const first = node.children?.[0];
      if (first?.type !== "paragraph" || first.children?.[0]?.type !== "text" || !/^\[![\w-]+\][+-]?/.test(first.children[0].value)) return;
      // The line ends at a soft break: Milkdown makes it an inline break node; plain remark leaves "\n" in text.
      const k = first.children.findIndex((c) => (c.type === "break" && c.data?.isInline) || (c.type === "text" && c.value.includes("\n")));
      if (k < 0) return;
      const split = first.children[k];
      const at = split.type === "text" ? split.value.indexOf("\n") : -1;
      const head = [...first.children.slice(0, k), ...(at >= 0 ? [{ type: "text", value: split.value.slice(0, at) }] : [])];
      const rest = [...(at >= 0 ? [{ type: "text", value: split.value.slice(at + 1) }] : []), ...first.children.slice(k + 1)].filter((c) => c.type !== "text" || c.value);
      node.children.splice(0, 1, { type: "paragraph", children: head }, ...(rest.length ? [{ type: "paragraph", children: rest }] : []));
    };
    visit(tree);
  };
}

// ---------------------------------------------------------------- /-menu --

export const slashKey = new PluginKey("notes-slash");

function slashPlugin(hooks) {
  return $prose(() => new Plugin({
    key: slashKey,
    state: {
      init: () => null,
      apply(tr, previous, _old, state) {
        if (tr.getMeta(slashKey) === "close") return { closed: true, from: previous?.from };
        const { selection } = state;
        if (!selection.empty) return null;
        const $from = selection.$from;
        if (!$from.parent.isTextblock || $from.parent.type.name === "code_block") return null;
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 30), $from.parentOffset, undefined, "￼");
        const m = /(?:^|\s)\/([\w-]{0,24})$/.exec(before);
        if (!m) return null;
        const from = $from.pos - m[1].length - 1;
        if (previous?.closed && previous.from === from) return previous;
        return { from, to: $from.pos, query: m[1] };
      },
    },
    props: {
      handleKeyDown(view, event) {
        const state = slashKey.getState(view.state);
        if (!state || state.closed || !hooks.onSlashKey) return false;
        return hooks.onSlashKey(event.key, event) === true;
      },
    },
    view: () => ({
      update(view) {
        const state = slashKey.getState(view.state);
        if (!state || state.closed) return hooks.onSlash?.(null);
        let rect = null;
        try { rect = view.coordsAtPos(state.from); } catch { /* not laid out */ }
        hooks.onSlash?.({ ...state, rect, items: filterSlash(state.query) });
      },
    }),
  }));
}

// -------------------------------------------------------- callouts, to-dos --

const CALLOUT = /^\[!([\w-]+)\]([+-]?)[ \t]?/;
const calloutKey = new PluginKey("notes-callouts");

function calloutDecorations(doc, opened) {
  const decorations = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockquote") return true;
    const first = node.firstChild;
    const m = first?.isTextblock ? CALLOUT.exec(first.textContent) : null;
    if (!m) return true;
    const type = m[1].toLowerCase();
    const fold = m[2];
    const open = opened.has(pos) ? opened.get(pos) : fold !== "-";
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `nt-callout nt-callout-${type}${fold ? " nt-foldable" : ""}${fold && !open ? " nt-folded" : ""}`, "data-callout": type }));
    const markerFrom = pos + 2;
    decorations.push(Decoration.inline(markerFrom, markerFrom + m[0].length, { class: "nt-callout-marker", "data-label": type === "toggle" ? "" : type }));
    if (fold) {
      decorations.push(Decoration.widget(markerFrom, () => {
        const arrow = document.createElement("span");
        arrow.className = "nt-fold";
        arrow.dataset.pos = String(pos);
        arrow.textContent = open ? "▾" : "▸";
        arrow.contentEditable = "false";
        return arrow;
      }, { side: -1, key: `fold-${pos}-${open}` }));
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

function calloutPlugin() {
  return $prose(() => new Plugin({
    key: calloutKey,
    state: {
      // Folds the reader opened or closed (by blockquote position), over the default from the - / + marker.
      init: () => new Map(),
      apply(tr, opened) {
        let next = opened;
        if (tr.docChanged && opened.size) {
          next = new Map();
          for (const [pos, open] of opened) {
            const mapped = tr.mapping.mapResult(pos);
            if (!mapped.deleted) next.set(mapped.pos, open);
          }
        }
        const flip = tr.getMeta(calloutKey);
        if (flip) { next = new Map(next); next.set(flip.pos, flip.open); }
        return next;
      },
    },
    props: {
      decorations: (state) => calloutDecorations(state.doc, calloutKey.getState(state)),
      handleDOMEvents: {
        mousedown(view, event) {
          const arrow = event.target.closest?.(".nt-fold");
          if (!arrow) return false;
          event.preventDefault();
          const pos = Number(arrow.dataset.pos);
          view.dispatch(view.state.tr.setMeta(calloutKey, { pos, open: arrow.textContent !== "▾" }).setMeta("addToHistory", false));
          return true;
        },
      },
      handleClickOn(view, _pos, node, nodePos, event) {
        // A to-do's box: a click in the item's left gutter flips it.
        if (node.type.name !== "list_item" || node.attrs.checked === null || node.attrs.checked === undefined) return false;
        const dom = view.nodeDOM(nodePos);
        if (!(dom instanceof HTMLElement) || event.clientX - dom.getBoundingClientRect().left > 26) return false;
        view.dispatch(view.state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
        return true;
      },
    },
  }));
}

// --------------------------------------------------------- block handle --

function blockHandle(hooks) {
  let provider = null;
  const content = document.createElement("div");
  content.className = "nt-handle";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "nt-add";
  add.title = "Add a block below";
  add.textContent = "+";
  const grip = document.createElement("div");
  grip.className = "nt-grip";
  grip.title = "Drag to move · click for options";
  grip.textContent = "⋮⋮";
  grip.draggable = true;
  content.append(add, grip);
  const active = () => provider?.active;
  grip.addEventListener("click", () => { const a = active(); if (a) hooks.onBlockMenu?.({ pos: a.$pos.pos, node: a.node, rect: grip.getBoundingClientRect() }); });
  add.addEventListener("click", () => { const a = active(); if (a) hooks.onAddBlock?.({ pos: a.$pos.pos, node: a.node }); });
  return {
    plugin: block,
    // The provider binds once the editor view exists; without this it would wait for the first edit.
    start: () => provider?.update(),
    config: (ctx) => ctx.set(block.key, {
      view: () => {
        provider = new BlockProvider({ ctx, content, getOffset: () => 6 });
        return { update: () => provider.update(), destroy: () => { provider.destroy(); content.remove(); } };
      },
    }),
  };
}

// ------------------------------------------------------------ assembly --

/** The Milkdown plugins of the Notes mode, and a config step (the block handle needs the ctx). */
export function notesPlugins(hooks) {
  const handle = blockHandle(hooks);
  return { plugins: [$remark("calloutRemark", () => calloutRemark), slashPlugin(hooks), calloutPlugin(), handle.plugin], config: handle.config, start: handle.start };
}

/** Editing operations the Notes page uses (the /-menu, the block menu). */
export function notesApi({ view, run, commands, build, schema }) {
  const topBlock = (pos) => {
    const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
    return $pos.depth ? { from: $pos.before(1), node: $pos.node(1) } : { from: pos, node: view.state.doc.nodeAt(pos) };
  };
  const replaceCurrentBlock = (markdown) => {
    const { from } = view.state.selection;
    const { from: start, node } = topBlock(from);
    const nodes = build(markdown.endsWith("\n") ? markdown : `${markdown}\n`).flatMap((u) => u.nodes);
    if (!node || !nodes.length) return;
    const empty = node.isTextblock && !node.textContent.trim();
    const at = empty ? start : start + node.nodeSize;
    const tr = empty ? view.state.tr.replaceWith(start, start + node.nodeSize, nodes) : view.state.tr.insert(at, nodes);
    let end = at + nodes.reduce((sum, n) => sum + n.nodeSize, 0);
    const last = nodes[nodes.length - 1];
    if (!last.isTextblock && !last.type.name.endsWith("list") && last.type.name !== "blockquote") {
      // A divider, equation or database: the cursor goes on below it, in a new paragraph if need be.
      if (end >= tr.doc.content.size || !tr.doc.nodeAt(end)?.isTextblock) tr.insert(end, schema.nodes.paragraph.create());
      end += 1;
    } else end -= 2;
    try { tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(Math.max(end, 0), tr.doc.content.size)))); } catch { /* keep */ }
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };
  const markQuote = (marker) => {
    run(commands.wrapInBlockquoteCommand);
    const $from = view.state.selection.$from;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name !== "blockquote") continue;
      const first = $from.node(d).firstChild;
      if (first?.isTextblock) view.dispatch(view.state.tr.insert($from.start(d) + 1, view.state.schema.text(marker))); // unmarked, even before bold text
      return;
    }
  };
  const turnInto = (id) => {
    switch (id) {
      case "text": return run(commands.turnIntoTextCommand);
      case "h1": case "h2": case "h3": return run(commands.wrapInHeadingCommand, Number(id[1]));
      case "bullet": return run(commands.wrapInBulletListCommand);
      case "numbered": return run(commands.wrapInOrderedListCommand);
      case "todo": {
        run(commands.wrapInBulletListCommand);
        const $from = view.state.selection.$from;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === "list_item") { view.dispatch(view.state.tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, checked: false })); break; }
        }
        return undefined;
      }
      case "quote": return run(commands.wrapInBlockquoteCommand);
      case "code": return run(commands.createCodeBlockCommand);
      case "divider": return replaceCurrentBlock("---");
      case "table": return run(commands.insertTableCommand);
      // Callouts and toggles wrap the block in a quote and mark it, keeping its text and formatting.
      case "callout": return markQuote("[!note] ");
      case "warning": return markQuote("[!warning] ");
      case "toggle": return markQuote("[!toggle]+ ");
      case "math": return replaceCurrentBlock("$$\nE = mc^2\n$$");
      default: return undefined;
    }
  };
  return {
    /** Remove the "/query" text and turn the block into the chosen kind. */
    applySlash(id) {
      const state = slashKey.getState(view.state);
      if (state && !state.closed) view.dispatch(view.state.tr.delete(state.from, state.to).setMeta(slashKey, "close"));
      turnInto(id);
      view.focus();
    },
    closeSlash() { view.dispatch(view.state.tr.setMeta(slashKey, "close")); },
    turnInto(pos, id) {
      try { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1)))); } catch { return; }
      turnInto(id);
    },
    replaceCurrentBlock,
    /** The block handle's operations take the position before a block (any depth). */
    duplicateBlock(pos) {
      const node = view.state.doc.nodeAt(pos);
      if (node) view.dispatch(view.state.tr.insert(pos + node.nodeSize, node.copy(node.content)));
    },
    deleteBlock(pos) {
      const node = view.state.doc.nodeAt(pos);
      if (node) view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
    },
    /** Markdown of the block (for "Copy" and for asking the agent about it). */
    blockText(pos) {
      const node = view.state.doc.nodeAt(pos);
      return node ? node.textContent : "";
    },
    /** An empty paragraph after the block at pos, with the cursor in it (the + button). */
    addBlockAfter(pos) {
      const node = view.state.doc.nodeAt(pos);
      if (!node) return;
      const at = pos + node.nodeSize;
      const tr = view.state.tr.insert(at, schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, at + 1));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
    /** Insert text at the cursor (e.g. "/" to open the menu, or a [[link]]). */
    insertText(text) {
      view.dispatch(view.state.tr.insertText(text));
      view.focus();
    },
  };
}
