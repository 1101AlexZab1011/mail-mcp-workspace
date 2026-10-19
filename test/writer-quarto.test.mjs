import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assemble, gapsOf, inlineTokens, labels, merge3, splitQuarto } from "../src/writer/quarto.mjs";

const fixture = (name) => readFile(join(import.meta.dirname, "fixtures/writer", name), "utf8");
const CORPUS = ["stress.qmd"];
// The user's paper, when present on this machine: the real document must split cleanly too.
const PAPER = join(process.env.HOME ?? "", "Projects/AlzheimerGridCells/paper/paper.qmd");

async function corpus() {
  const out = [];
  for (const name of CORPUS) out.push([name, await fixture(name)]);
  const paper = await readFile(PAPER, "utf8").catch(() => null);
  if (paper !== null) out.push(["paper.qmd", paper]);
  // Edge cases: empty, no trailing newline, CRLF, only front matter, unclosed fence.
  out.push(["empty", ""], ["no-newline", "# Title\n\nText"], ["crlf", "# A\r\n\r\nText\r\n"], ["only-yaml", "---\na: 1\n---\n"], ["unclosed", "Text\n\n```\ncode without end\n"]);
  return out;
}

test("splitting: segments plus gaps give back every document byte for byte", async () => {
  for (const [name, source] of await corpus()) {
    const segments = splitQuarto(source);
    for (const s of segments) assert.equal(source.slice(s.start, s.end), s.text, `${name}: offsets`);
    const gaps = gapsOf(source, segments);
    for (const gap of gaps) assert.match(gap, /^\s*$/, `${name}: only whitespace between segments`);
    const rebuilt = segments.reduce((text, s, k) => text + gaps[k] + s.text, "") + gaps[segments.length];
    assert.equal(rebuilt, source, name);
  }
});

test("splitting: Quarto constructs become kept segments", async () => {
  const kinds = splitQuarto(await fixture("stress.qmd")).map((s) => [s.kind, s.label ?? ""]);
  const kept = kinds.filter(([kind]) => kind !== "markdown");
  assert.deepEqual(kept, [
    ["frontmatter", ""],
    ["math", "eq-acc"],
    ["math", ""],
    ["div", "callout-note"],
    ["div", ""],
    ["div", "#fig-sweep"],
    ["div", ""],
    ["code", "{python}"],
    ["code", ""],
    ["latex", "table"],
    ["comment", ""],
  ]);
  const python = splitQuarto(await fixture("stress.qmd")).find((s) => s.label === "{python}");
  assert.match(python.text, /not a fence end/, "a fence-like line inside a cell does not close it");
  assert.match(python.text, /\n```$/);
});

/**
 * A stand-in editor: kept segments become one node each; Markdown runs are cut
 * into blocks at blank lines (as the Markdown parser does), one node object per
 * block, identity-preserving like ProseMirror.
 */
function load(source) {
  const units = [];
  for (const s of splitQuarto(source)) {
    if (s.kind !== "markdown") { units.push({ ...s, nodes: [{ kind: s.kind, text: s.text }] }); continue; }
    for (const m of s.text.matchAll(/[^\n](?:[\s\S]*?)(?=\n[ \t]*\n|$)/g)) {
      const start = s.start + m.index;
      units.push({ kind: "markdown", start, end: start + m[0].length, text: m[0], nodes: [{ kind: "markdown", text: m[0] }] });
    }
  }
  return { units, gaps: gapsOf(source, units), current: units.flatMap((u) => u.nodes) };
}
const serialize = (nodes) => nodes.map((n) => n.text).join("\n\n");

test("assembling: no edits is a no-op, an edit changes only its block", async () => {
  for (const [name, source] of await corpus()) {
    const doc = load(source);
    assert.equal(assemble({ ...doc, serialize }), source, `${name}: unchanged`);
  }
  const source = await fixture("stress.qmd");
  const doc = load(source);
  const k = doc.current.findIndex((n) => n.kind === "markdown" && n.text.startsWith("Final paragraph"));
  doc.current[k] = { kind: "markdown", text: "Final paragraph, edited." };
  const out = assemble({ ...doc, serialize });
  assert.equal(out, source.replace("Final paragraph without trailing blank line.", "Final paragraph, edited."));

  // Inserting a block: blank lines around it, everything else untouched.
  const again = load(source);
  const at = again.current.findIndex((n) => n.text.startsWith("> quote"));
  again.current.splice(at, 0, { kind: "markdown", text: "New paragraph." });
  const inserted = assemble({ ...again, serialize });
  assert.equal(inserted, source.replace("> quote", "New paragraph.\n\n> quote"));

  // Deleting a block keeps its neighbours' original text.
  const del = load(source);
  del.current.splice(del.current.findIndex((n) => n.text.startsWith("> quote")), 1);
  assert.equal(assemble({ ...del, serialize }), source.replace("> quote\n\n", ""));
});

test("assembling: kept constructs carry their own source", () => {
  const source = "Text\n\n$$\nx\n$$ {#eq-a}\n";
  const doc = load(source);
  const math = { kind: "math", own: "$$\nx + 1\n$$ {#eq-a}" };
  doc.current[1] = math;
  const out = assemble({ ...doc, serialize, own: (n) => n.own ?? null });
  assert.equal(out, "Text\n\n$$\nx + 1\n$$ {#eq-a}\n");
});

test("three-way merge: separate edits combine, overlapping ones are flagged", () => {
  const base = "a\nb\nc\nd\ne\n";
  assert.deepEqual(merge3(base, "a\nB\nc\nd\ne\n", "a\nb\nc\nD\ne\n"), { text: "a\nB\nc\nD\ne\n", conflicts: 0 });
  assert.deepEqual(merge3(base, "a\nB\nc\nd\ne\n", "a\nb\nc\nd\ne\nf\n"), { text: "a\nB\nc\nd\ne\nf\n", conflicts: 0 });
  const both = merge3(base, "a\nX\nc\nd\ne\n", "a\nY\nc\nd\ne\n");
  assert.equal(both.conflicts, 1);
  assert.equal(merge3(base, base, "z\n").text, "z\n");
});

test("inline tokens: citations, cross-references, attributes and shortcodes, not emails", () => {
  const text = "Shown [@ridler2020; @jun2020, p. 3], as @ying2022 found; see @fig-sweep and [@eq-acc]. Mail someone@example.org. {{< pagebreak >}} A [span]{.smallcaps} and ## H {#sec-x}";
  const found = inlineTokens(text).map((t) => [t.kind, t.text]);
  assert.deepEqual(found, [
    ["cite", "[@ridler2020; @jun2020, p. 3]"],
    ["cite", "@ying2022"],
    ["crossref", "@fig-sweep"],
    ["crossref", "[@eq-acc]"],
    ["shortcode", "{{< pagebreak >}}"],
    ["attr", "{.smallcaps}"],
    ["attr", "{#sec-x}"],
  ]);
});

test("labels: what a cross-reference can point to", async () => {
  const found = labels(await fixture("stress.qmd")).map((l) => l.label);
  assert.deepEqual(found, ["sec-intro", "eq-acc", "fig-sweep", "fig-ring", "fig-sheet", "fig-plot"]);
});
