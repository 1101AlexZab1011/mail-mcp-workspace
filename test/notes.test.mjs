import assert from "node:assert/strict";
import test from "node:test";
import { notesTokens, pageText, queryRows, renameLinks, setProperties, splitPage, wikilinks } from "../src/notes/vault.mjs";

test("front matter: read, change in place keeping comments, remove", () => {
  const text = "---\n# kept comment\nicon: 🧪\ntags: [a, b]\n---\n\nBody\n";
  assert.deepEqual(splitPage(text).data, { icon: "🧪", tags: ["a", "b"] });
  assert.equal(splitPage(text).body, "\nBody\n");
  const changed = setProperties(text, { icon: "📄", status: "draft" });
  assert.match(changed, /# kept comment/);
  assert.deepEqual(splitPage(changed).data, { icon: "📄", tags: ["a", "b"], status: "draft" });
  assert.equal(splitPage(changed).body, "\nBody\n");
  assert.equal(setProperties("Just text\n", { icon: "📄" }), "---\nicon: 📄\n---\n\nJust text\n");
  assert.equal(setProperties("---\nicon: x\n---\n\nBody\n", { icon: null }), "Body\n");
  assert.equal(pageText({ properties: { a: 1 }, body: "B" }), "---\na: 1\n---\n\nB");
  assert.equal(splitPage("---\n: bad: yaml: [\n---\nx").valid, false);
});

test("links: wikilinks with headings, labels and embeds; renaming rewrites them", () => {
  const links = wikilinks("See [[Page]], [[Folder/Other#Methods|methods]] and ![[Chart]].");
  assert.deepEqual(links.map((l) => [l.target, l.heading, l.label, l.embed]), [["Page", "", "", false], ["Folder/Other", "Methods", "methods", false], ["Chart", "", "", true]]);
  assert.deepEqual(notesTokens("a [[B]] c").map((t) => [t.kind, t.text]), [["wikilink", "[[B]]"]]);
  const { text, count } = renameLinks("[[Old]] [[old#H|l]] [[Folder/Old]] [[Older]]", "Old", "New");
  assert.equal(text, "[[New]] [[New#H|l]] [[Folder/New]] [[Older]]");
  assert.equal(count, 3);
});

test("database queries filter and sort rows", () => {
  const rows = [
    { title: "b", properties: { Status: "Done", Date: "2026-10-02", N: 2 } },
    { title: "a", properties: { Status: "Running", Date: "2026-10-01", N: 10 } },
    { title: "c", properties: { Status: "Running", Tags: ["x", "y"] } },
  ];
  assert.deepEqual(queryRows(rows, { filter: [{ property: "Status", op: "is", value: "running" }] }).map((r) => r.title), ["a", "c"]);
  assert.deepEqual(queryRows(rows, { sort: [{ property: "N", direction: "desc" }] }).map((r) => r.title), ["a", "b", "c"]);
  assert.deepEqual(queryRows(rows, { filter: [{ property: "Tags", op: "contains", value: "y" }] }).map((r) => r.title), ["c"]);
  assert.deepEqual(queryRows(rows, { filter: [{ property: "Date", op: "before", value: "2026-10-02" }] }).map((r) => r.title), ["a"]);
});

test("editor: a callout's title line is split from its body; the /-menu filters by name and keyword", async () => {
  const { calloutRemark, filterSlash } = await import("../src/notes/editor-notes.mjs");
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  const tree = unified().use(remarkParse).parse("> [!toggle]- Title *here*\n> Body line\n\n> plain quote\n> two lines\n");
  calloutRemark()(tree);
  const [callout, plain] = tree.children;
  assert.equal(callout.children.length, 2);
  assert.equal(callout.children[0].children.map((c) => c.value ?? c.children?.[0]?.value).join(""), "[!toggle]- Title here");
  assert.equal(callout.children[1].children[0].value, "Body line");
  assert.equal(plain.children.length, 1); // an ordinary quote stays one paragraph
  assert.deepEqual(filterSlash("todo").map((i) => i.id), ["todo"]);
  assert.ok(filterSlash("check").some((i) => i.id === "todo"));
  assert.equal(filterSlash("").length > 15, true);
});
