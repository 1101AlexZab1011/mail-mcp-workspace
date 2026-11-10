// Draw: writing the document back so that a save changes only what was edited.
//
// When a file is opened, its text is matched to the document node by node (the parser made one
// node from each tag, text run and comment, in order), and each element's attributes and children
// are noted. On save, whatever is unchanged is copied from the file as it was, byte for byte; an
// element whose attributes changed gets a new start tag laid out like its old one (Inkscape puts
// each attribute on its own line, other tools keep one line); new elements follow their parent's
// layout. Undoing back to the file's state gives the file back exactly.

const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
const signature = (el) => Array.from(el.attributes, (a) => `${a.name}\u0000${a.value}`).join("\u0001");

/** Read past a start tag at `p` (quotes respected). Returns { name, end, selfClosing, sep, close }. */
function startTag(text, p) {
  const nameMatch = /^<([^\s/>]+)/.exec(text.slice(p, p + 256));
  if (!nameMatch) return null;
  let i = p + nameMatch[0].length;
  let quote = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") break;
  }
  if (i >= text.length) return null;
  const selfClosing = text[i - 1] === "/";
  const inner = text.slice(p + nameMatch[0].length, selfClosing ? i - 1 : i);
  return {
    name: nameMatch[1], end: i + 1, selfClosing,
    sep: /^\s*/.exec(inner)[0] || " ", // what goes before each attribute
    close: /\s*$/.exec(inner)[0], // what goes before ">" or "/>"
  };
}

/**
 * Match the file's text to the document. Returns a map from each node to where it is in the text,
 * or null when they do not line up (then the whole document is written afresh).
 */
export function indexSource(text, doc) {
  const index = new Map();
  const root = doc.documentElement;
  const rootStart = text.search(new RegExp(`<${root.nodeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s/>]`));
  if (rootStart < 0) return null;
  let p = rootStart;
  const element = (el) => {
    if (text[p] !== "<") return false;
    const tag = startTag(text, p);
    if (!tag || tag.name !== el.nodeName) return false;
    const entry = { start: p, tagEnd: tag.end, sep: tag.sep, close: tag.close, selfClosing: tag.selfClosing, sig: signature(el), kids: [...el.childNodes] };
    index.set(el, entry);
    p = tag.end;
    if (tag.selfClosing) { entry.end = p; return el.childNodes.length === 0; }
    for (const child of el.childNodes) if (!node(child)) return false;
    const endTag = `</${el.nodeName}`;
    if (!text.startsWith(endTag, p)) return false;
    entry.closeStart = p;
    p = text.indexOf(">", p) + 1;
    if (!p) return false;
    entry.end = p;
    return true;
  };
  const until = (marker) => { const at = text.indexOf(marker, p); if (at < 0) return false; p = at + marker.length; return true; };
  const node = (n) => {
    const start = p;
    switch (n.nodeType) {
      case 1: return element(n);
      case 3: {
        if (text[p] === "<") return false;
        const at = text.indexOf("<", p);
        p = at < 0 ? text.length : at;
        index.set(n, { start, end: p, data: n.data });
        return true;
      }
      case 4: if (!text.startsWith("<![CDATA[", p) || !until("]]>")) return false; break;
      case 7: if (!text.startsWith("<?", p) || !until("?>")) return false; break;
      case 8: if (!text.startsWith("<!--", p) || !until("-->")) return false; break;
      default: return false;
    }
    index.set(n, { start, end: p, data: n.data });
    return true;
  };
  if (!element(root)) return null;
  return { index, text, rootStart, rootEnd: index.get(root).end };
}

/** The document as text: the file's own bytes wherever nothing changed. */
export function serializePreserving(doc, source) {
  const { index, text } = source;
  const out = [];
  const write = (n, style) => {
    const at = index.get(n);
    if (n.nodeType === 3) { out.push(at && at.data === n.data ? text.slice(at.start, at.end) : escapeText(n.data)); return; }
    if (n.nodeType === 4 || n.nodeType === 7 || n.nodeType === 8) {
      if (at && at.data === n.data) out.push(text.slice(at.start, at.end));
      else out.push(n.nodeType === 4 ? `<![CDATA[${n.data}]]>` : n.nodeType === 7 ? `<?${n.target} ${n.data}?>` : `<!--${n.data}-->`);
      return;
    }
    if (n.nodeType !== 1) return;
    if (clean(n)) { out.push(text.slice(at.start, at.end)); return; }
    const kids = n.childNodes;
    // A new element lays out its attributes like its parent's, one level deeper.
    const own = at ? { sep: at.sep, close: at.close } : { sep: style.sep.includes("\n") ? `${style.sep}  ` : " ", close: null };
    if (at && at.sig === signature(n) && !at.selfClosing) out.push(text.slice(at.start, at.tagEnd));
    else {
      out.push(`<${n.nodeName}`);
      for (const attr of n.attributes) out.push(`${own.sep}${attr.name}="${escapeAttribute(attr.value)}"`);
      if (!kids.length) { out.push(own.close !== null ? `${own.close}/>` : own.sep.includes("\n") ? " />" : "/>"); return; }
      out.push(at && !at.selfClosing ? `${own.close}>` : ">");
    }
    for (const child of kids) write(child, own);
    out.push(at && !at.selfClosing ? text.slice(at.closeStart, at.end) : `</${n.nodeName}>`);
  };
  // Is this element's whole subtree as in the file? (Memoized per save: subtrees are checked once.)
  const verdict = new Map();
  const clean = (el) => {
    if (verdict.has(el)) return verdict.get(el);
    const at = index.get(el);
    let ok = Boolean(at) && at.sig === signature(el) && at.kids.length === el.childNodes.length;
    if (ok) {
      for (let i = 0; ok && i < at.kids.length; i++) {
        const k = el.childNodes[i];
        if (k !== at.kids[i]) ok = false;
        else if (k.nodeType === 1) ok = clean(k);
        else ok = index.get(k)?.data === k.data;
      }
    }
    verdict.set(el, ok);
    return ok;
  };
  write(doc.documentElement, { sep: " " });
  return text.slice(0, source.rootStart) + out.join("") + text.slice(source.rootEnd);
}
