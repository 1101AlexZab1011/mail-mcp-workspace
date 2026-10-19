// The Writer's safety layer. Pure functions, no editor or DOM, so they are
// tested in Node (test/writer-quarto.test.mjs):
//
//   splitQuarto   cuts a .qmd/.md file into segments: Markdown runs, and Quarto
//                 constructs the editor keeps as exact source (front matter,
//                 code blocks and cells, display math with labels, ::: fences,
//                 raw LaTeX environments, comments). Concatenating the segments
//                 and the gaps between them gives back the file byte for byte.
//   assemble      writes a document back: every block the user did not touch is
//                 emitted as its original text, gaps included, so a save without
//                 edits is a no-op and an edit changes only the edited blocks.
//   merge3        line-level three-way merge for "changed on disk" conflicts.
//   inlineTokens  finds Quarto inline syntax in text: citations, cross-references,
//                 attribute blocks and shortcodes.

// ------------------------------------------------------------ splitting --

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const DIV = /^ {0,3}:{3,}/;
const BEGIN_ENV = /^ {0,3}\\begin\{([^}]+)\}/;
const COMMENT_OPEN = /^ {0,3}<!--/;
const MATH_OPEN = /^ {0,3}\$\$/;

/** Line table: start offset of every line, and its text without the line break. */
function lines(source) {
  const out = [];
  let start = 0;
  for (;;) {
    const nl = source.indexOf("\n", start);
    if (nl < 0) { out.push({ start, end: source.length, text: source.slice(start) }); break; }
    out.push({ start, end: nl, text: source.slice(start, nl).replace(/\r$/, "") });
    start = nl + 1;
  }
  return out;
}

const blank = (text) => text.trim() === "";

/**
 * Segments of a document: { kind, start, end, text, label? }. `kind` is
 * "markdown" or one of the kept constructs: frontmatter, code, math, div, latex,
 * comment. Offsets index into `source`; a segment's text excludes the final line
 * break, which belongs to the gap before the next segment.
 */
export function splitQuarto(source) {
  const L = lines(source);
  const segments = [];
  const push = (kind, from, to, extra = {}) => segments.push({ kind, start: L[from].start, end: L[to].end, text: source.slice(L[from].start, L[to].end), ...extra });
  let i = 0;

  // Front matter: only at the very top.
  if (L.length > 1 && /^---\s*$/.test(L[0].text)) {
    for (let j = 1; j < L.length; j++) {
      if (/^(---|\.\.\.)\s*$/.test(L[j].text)) { push("frontmatter", 0, j); i = j + 1; break; }
    }
  }

  let run = null; // the Markdown run being collected: [firstLine, lastNonBlankLine]
  const closeRun = () => { if (run) { push("markdown", run[0], run[1]); run = null; } };

  while (i < L.length) {
    const text = L[i].text;
    if (blank(text)) { i++; continue; }

    const fence = FENCE.exec(text);
    if (fence) {
      const [, , marks, info] = fence;
      // A backtick fence's info string may not contain backticks (CommonMark).
      if (!(marks[0] === "`" && info.includes("`"))) {
        closeRun();
        let j = i + 1;
        const close = new RegExp(`^ {0,3}${marks[0] === "`" ? "`" : "~"}{${marks.length},}\\s*$`);
        while (j < L.length && !close.test(L[j].text)) j++;
        const end = Math.min(j, L.length - 1);
        push("code", i, end, { label: info.trim() });
        i = end + 1;
        continue;
      }
    }

    if (MATH_OPEN.test(text)) {
      closeRun();
      const rest = text.replace(/^ {0,3}\$\$/, "");
      // One-line display math: $$ x = 1 $$ {#eq-x}
      if (/\$\$\s*(\{[^}]*\})?\s*$/.test(rest)) { push("math", i, i, { label: labelOf(rest) }); i++; continue; }
      let j = i + 1;
      while (j < L.length && !/\$\$\s*(\{[^}]*\})?\s*$/.test(L[j].text)) j++;
      const end = Math.min(j, L.length - 1);
      push("math", i, end, { label: labelOf(L[end].text) });
      i = end + 1;
      continue;
    }

    if (DIV.test(text)) {
      closeRun();
      push("div", i, i, { label: divLabel(text) });
      i++;
      continue;
    }

    const env = BEGIN_ENV.exec(text);
    if (env) {
      closeRun();
      const name = env[1];
      const open = new RegExp(`\\\\begin\\{${escapeRegExp(name)}\\}`, "g");
      const close = new RegExp(`\\\\end\\{${escapeRegExp(name)}\\}`, "g");
      let depth = 0;
      let j = i;
      for (; j < L.length; j++) {
        depth += (L[j].text.match(open) ?? []).length - (L[j].text.match(close) ?? []).length;
        if (depth <= 0) break;
      }
      const end = Math.min(j, L.length - 1);
      push("latex", i, end, { label: name });
      i = end + 1;
      continue;
    }

    if (COMMENT_OPEN.test(text)) {
      closeRun();
      let j = i;
      while (j < L.length && !L[j].text.includes("-->")) j++;
      const end = Math.min(j, L.length - 1);
      push("comment", i, end);
      i = end + 1;
      continue;
    }

    // Markdown: extend the run through blank lines, so loose lists and indented
    // continuations stay in one piece for the Markdown parser.
    if (!run) run = [i, i]; else run[1] = i;
    i++;
  }
  closeRun();
  return segments;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const labelOf = (text) => /\{#([^\s}]+)[^}]*\}\s*$/.exec(text)?.[1] ?? "";
function divLabel(text) {
  const rest = text.replace(/^ {0,3}:{3,}\s*/, "").trim();
  if (!rest) return "";
  const braces = /^\{([^}]*)\}/.exec(rest);
  if (!braces) return rest.split(/\s+/)[0];
  const parts = braces[1].trim().split(/\s+/);
  return parts.find((p) => p.startsWith(".callout"))?.slice(1) ?? parts.find((p) => p.startsWith("#"))?.slice(0) ?? parts[0] ?? "";
}

// ---------------------------------------------------------- assembling --

/**
 * Write a document back.
 *
 *   units      what was loaded, in order: { nodes: [node, …], text, start, end }.
 *              `nodes` are the editor's top-level nodes made from that text.
 *   gaps       gaps[k] is the source text before unit k; gaps[units.length]
 *              is what follows the last unit (usually the final line break).
 *   current    the editor's top-level nodes now.
 *   serialize  (nodes[]) → Markdown for nodes that are new or changed.
 *   own        (node) → source text the node carries itself (kept constructs),
 *              or null.
 *
 * Nodes are matched by identity: an editor that reuses node objects for
 * untouched content (ProseMirror does) gets its original text back.
 */
export function assemble({ units, gaps, current, serialize, own = () => null }) {
  const where = new Map(); // node → [unit, index]
  units.forEach((unit, u) => unit.nodes.forEach((node, k) => where.set(node, [u, k])));
  const pieces = []; // { text, unit? }
  let i = 0;
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const text = serialize(pending).replace(/\n+$/, "");
    if (text) pieces.push({ text });
    pending = [];
  };
  while (i < current.length) {
    const node = current[i];
    const at = where.get(node);
    if (at && at[1] === 0) {
      const unit = units[at[0]];
      const intact = unit.nodes.every((n, k) => current[i + k] === n);
      if (intact) { flush(); pieces.push({ text: unit.text, unit: at[0] }); i += unit.nodes.length; continue; }
    }
    const kept = own(node);
    if (kept !== null && kept !== undefined) { flush(); pieces.push({ text: kept }); i++; continue; }
    pending.push(node);
    i++;
  }
  flush();

  let out = "";
  pieces.forEach((piece, p) => {
    const previous = pieces[p - 1];
    if (p === 0) out += piece.unit === 0 ? gaps[0] : "";
    else if (previous.unit !== undefined && piece.unit === previous.unit + 1) out += gaps[piece.unit];
    else out += "\n\n";
    out += piece.text;
  });
  const last = pieces.at(-1);
  if (last?.unit === units.length - 1) out += gaps[units.length];
  else if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

/** Gaps between units, from their offsets in `source`. */
export function gapsOf(source, units) {
  const gaps = [];
  let previous = 0;
  for (const unit of units) { gaps.push(source.slice(previous, unit.start)); previous = unit.end; }
  gaps.push(source.slice(previous));
  return gaps;
}

// -------------------------------------------------------------- merging --

/** Longest-common-subsequence diff of two line arrays: [[aIndex, bIndex], …] matches. */
function matches(a, b) {
  // Trim common head and tail first: conflicts are local, the rest is shared.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const n = A.length;
  const m = B.length;
  const out = [];
  for (let k = 0; k < head; k++) out.push([k, k]);
  if (n && m) {
    if (n * m > 25e6) throw new Error("Documents too different to merge line by line");
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) dp[x][y] = A[x] === B[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
    let x = 0;
    let y = 0;
    while (x < n && y < m) {
      if (A[x] === B[y]) { out.push([head + x, head + y]); x++; y++; } else if (dp[x + 1][y] >= dp[x][y + 1]) x++; else y++;
    }
  }
  for (let k = 0; k < tail; k++) out.push([a.length - tail + k, b.length - tail + k]);
  return out;
}

/**
 * Three-way merge of texts by lines. Returns { text, conflicts }: conflicts > 0
 * means some region changed on both sides differently; `text` then keeps "mine"
 * there and the caller should not save it silently.
 */
export function merge3(base, mine, theirs) {
  if (mine === theirs) return { text: mine, conflicts: 0 };
  if (mine === base) return { text: theirs, conflicts: 0 };
  if (theirs === base) return { text: mine, conflicts: 0 };
  const O = base.split("\n");
  const A = mine.split("\n");
  const B = theirs.split("\n");
  const mA = new Map(matches(O, A));
  const mB = new Map(matches(O, B));
  // Anchors: base lines kept unchanged on both sides, in order.
  const anchors = [];
  for (let o = 0; o < O.length; o++) if (mA.has(o) && mB.has(o)) anchors.push([o, mA.get(o), mB.get(o)]);
  anchors.push([O.length, A.length, B.length]);
  const out = [];
  let conflicts = 0;
  let po = 0;
  let pa = 0;
  let pb = 0;
  for (const [o, a, b] of anchors) {
    const base = O.slice(po, o);
    const ours = A.slice(pa, a);
    const their = B.slice(pb, b);
    const same = (x, y) => x.length === y.length && x.every((line, k) => line === y[k]);
    if (same(ours, base)) out.push(...their);
    else if (same(their, base) || same(ours, their)) out.push(...ours);
    else { conflicts++; out.push(...ours); }
    if (o < O.length) out.push(O[o]);
    po = o + 1; pa = a + 1; pb = b + 1;
  }
  return { text: out.join("\n"), conflicts };
}

// --------------------------------------------------------- inline syntax --

/**
 * Quarto inline syntax inside plain text: [ { start, end, kind, text } ].
 *   cite      [@key], [see @a, p. 3; @b], @key, -@key
 *   crossref  @fig-x, @tbl-x, @eq-x, @sec-x, @lst-x, @thm-x …
 *   attr      {#id .class key=value}
 *   shortcode {{< name args >}}
 */
const CROSSREF = /^(fig|tbl|eq|sec|lst|thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|alg|apx)-/;
export function inlineTokens(text) {
  const out = [];
  const add = (start, end, kind) => out.push({ start, end, kind, text: text.slice(start, end) });
  const taken = (start, end) => out.some((t) => start < t.end && end > t.start);
  for (const m of text.matchAll(/\{\{<[\s\S]*?>\}\}/g)) add(m.index, m.index + m[0].length, "shortcode");
  for (const m of text.matchAll(/\[[^\[\]]*?-?@[\w:.#$%&\-+?<>~/]+[^\[\]]*\]/g)) if (!taken(m.index, m.index + m[0].length)) add(m.index, m.index + m[0].length, /\[\s*-?@([\w-]+)\s*\]/.test(m[0]) && CROSSREF.test(/@([\w-]+)/.exec(m[0])[1]) ? "crossref" : "cite");
  for (const m of text.matchAll(/\{[#.][^{}\n]*\}/g)) if (!taken(m.index, m.index + m[0].length)) add(m.index, m.index + m[0].length, "attr");
  for (const m of text.matchAll(/(^|[^\w@.])(-?@([A-Za-z_][\w:.#$%&\-+?<>~/]*[\w]))/g)) {
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    if (!taken(start, end)) add(start, end, CROSSREF.test(m[3]) ? "crossref" : "cite");
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Labels defined in a document, for cross-reference autocomplete. */
export function labels(source) {
  const out = new Map();
  for (const m of source.matchAll(/\{#((fig|tbl|eq|sec|lst|thm|lem|cor|prp|def|exm|apx)-[\w-]+)[^}]*\}/g)) if (!out.has(m[1])) out.set(m[1], m[2]);
  for (const m of source.matchAll(/#\|\s*label:\s*((fig|tbl)-[\w-]+)/g)) if (!out.has(m[1])) out.set(m[1], m[2]);
  return [...out].map(([label, kind]) => ({ label, kind }));
}
