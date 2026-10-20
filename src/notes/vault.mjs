// The Notes vault model, shared by the workspace host (index, databases) and the Notes page.
//
// A page is a Markdown file; its title is the file name. A page with subpages has a folder of the same
// name next to it (a "folder note"): Projects.md + Projects/. Front matter (YAML) holds the icon, cover,
// tags and other properties. A database is a page X.md with X.base.json (columns and views) and its rows
// as pages in X/.
import YAML from "yaml";

export const DATABASE_SUFFIX = ".base.json";
export const isPage = (path) => /\.md$/i.test(path);
export const titleOf = (path) => String(path).split("/").pop().replace(/\.md$/i, "");
export const folderOf = (path) => String(path).replace(/\.md$/i, ""); // Projects.md → Projects (its subpages)
export const databaseFileOf = (path) => `${folderOf(path)}${DATABASE_SUFFIX}`;

// ----------------------------------------------------------- front matter --

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Split a page into front matter (text and parsed) and body. Invalid YAML keeps its text, data {}. */
export function splitPage(text) {
  const m = FRONT.exec(text);
  if (!m) return { front: "", data: {}, body: text, valid: true };
  try {
    const data = YAML.parse(m[1]) ?? {};
    return { front: m[0], data: typeof data === "object" && !Array.isArray(data) ? data : {}, body: text.slice(m[0].length), valid: true };
  } catch {
    return { front: m[0], data: {}, body: text.slice(m[0].length), valid: false };
  }
}

/**
 * Set properties in a page's front matter, keeping its other keys, order and comments.
 * `changes`: { key: value } (undefined or null removes the key).
 */
export function setProperties(text, changes) {
  const { front, body } = splitPage(text);
  const doc = front ? YAML.parseDocument(FRONT.exec(text)[1]) : new YAML.Document({});
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === null || value === "") doc.delete(key);
    else doc.set(key, value);
  }
  const yaml = doc.contents.items.length ? doc.toString({ lineWidth: 0 }).replace(/\n$/, "") : "";
  if (!yaml || yaml === "{}") return body.replace(/^\r?\n/, "");
  return `---\n${yaml}\n---\n${front ? "" : "\n"}${body}`;
}

/** A new page's text: front matter (if any properties) and a body. */
export function pageText({ properties = {}, body = "" } = {}) {
  const keys = Object.entries(properties).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!keys.length) return body;
  return `---\n${YAML.stringify(Object.fromEntries(keys), { lineWidth: 0 }).trimEnd()}\n---\n\n${body}`;
}

// ------------------------------------------------------------------ links --

const WIKILINK = /(!?)\[\[([^\[\]\n|#]+?)(?:#([^\[\]\n|]*))?(?:\|([^\[\]\n]*))?\]\]/g;

/** [[Target#Heading|Label]] links (and ![[embeds]]) in a text, with their positions. */
export function wikilinks(text) {
  return [...String(text).matchAll(WIKILINK)].map((m) => ({
    start: m.index, end: m.index + m[0].length, text: m[0], embed: m[1] === "!",
    target: m[2].trim(), heading: m[3]?.trim() || "", label: m[4]?.trim() || "",
  }));
}

/** Tokens the Notes editor shows as chips: [[links]] and ![[embeds]]. */
export function notesTokens(text) {
  return wikilinks(text).map((l) => ({ start: l.start, end: l.end, kind: l.embed ? "embed" : "wikilink", text: l.text }));
}

/** Markdown links to local Markdown files: [label](relative/path.md). */
export function markdownLinks(text) {
  return [...String(text).matchAll(/\[([^\]\n]*)\]\(((?![a-z]+:)[^)\s]+\.md)(#[^)]*)?\)/gi)].map((m) => ({ start: m.index, end: m.index + m[0].length, label: m[1], href: decodeURI(m[2]) }));
}

/** #tags in body text (not in code, not headings). */
export function inlineTags(text) {
  const plain = String(text).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...plain.matchAll(/(^|[\s(])#([A-Za-z][\w/-]*)/g)].map((m) => m[2]);
}

/** Rewrite links to a renamed page: [[Old…]] → [[New…]], keeping heading and label. */
export function renameLinks(text, oldTitle, newTitle) {
  const old = oldTitle.toLowerCase();
  let count = 0;
  const out = String(text).replace(WIKILINK, (all, bang, target, heading, label) => {
    if (target.trim().toLowerCase() !== old && !target.trim().toLowerCase().endsWith(`/${old}`)) return all;
    count++;
    const kept = target.includes("/") ? `${target.slice(0, target.lastIndexOf("/") + 1)}${newTitle}` : newTitle;
    return `${bang}[[${kept}${heading !== undefined ? `#${heading}` : ""}${label !== undefined ? `|${label}` : ""}]]`;
  });
  return { text: out, count };
}

// -------------------------------------------------------------- databases --

export const PROPERTY_TYPES = ["text", "number", "select", "multi-select", "date", "checkbox", "person", "url", "relation"];

export function newDatabase({ properties } = {}) {
  return {
    version: 1,
    properties: properties ?? [
      { name: "Status", type: "select", options: ["Idea", "Running", "Done"] },
      { name: "Date", type: "date" },
      { name: "Tags", type: "multi-select", options: [] },
    ],
    views: [
      { name: "Table", type: "table", sort: [], filter: [] },
      { name: "Board", type: "board", groupBy: "Status" },
    ],
  };
}

export function parseDatabase(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.properties)) throw new Error("Not a database: no properties");
  data.views = Array.isArray(data.views) && data.views.length ? data.views : [{ name: "Table", type: "table" }];
  return data;
}

const asList = (value) => (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]);

/** Does a row match a filter clause { property, op, value }? Ops: is, is-not, contains, empty, not-empty, before, after. */
export function matches(row, { property, op = "is", value }) {
  const raw = property === "Title" ? row.title : row.properties[property];
  const values = asList(raw).map((v) => String(v).toLowerCase());
  const want = String(value ?? "").toLowerCase();
  switch (op) {
    case "is": return values.includes(want) || (want === "true" && raw === true) || (want === "false" && !raw);
    case "is-not": return !values.includes(want);
    case "contains": return values.some((v) => v.includes(want));
    case "empty": return !values.length;
    case "not-empty": return values.length > 0;
    case "before": return values.some((v) => v < want);
    case "after": return values.some((v) => v > want);
    default: return true;
  }
}

/** Apply a view's (or a query's) filter and sort to rows. */
export function queryRows(rows, { filter = [], sort = [] } = {}) {
  const kept = rows.filter((row) => filter.every((clause) => matches(row, clause)));
  const key = (row, property) => (property === "Title" ? row.title : row.properties[property]);
  return kept.sort((a, b) => {
    for (const { property, direction = "asc" } of sort) {
      const x = key(a, property);
      const y = key(b, property);
      if (x === y) continue;
      if (x === undefined || x === null) return 1;
      if (y === undefined || y === null) return -1;
      const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      if (order) return direction === "desc" ? -order : order;
    }
    return a.title.localeCompare(b.title);
  });
}
