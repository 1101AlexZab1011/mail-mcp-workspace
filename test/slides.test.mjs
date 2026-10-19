import assert from "node:assert/strict";
import test from "node:test";
import { mapMedia, newDeck, parseDeck, serializeDeck, summarize, isRelativeMedia, htmlText } from "../src/slides/deck.mjs";
import { applyOps, textHtml } from "../src/slides/ops.mjs";
import { mergeDecks } from "../src/slides/merge.mjs";

let counter = 0;
const env = { newId: () => `id${++counter}`, imageSize: async () => ({ width: 400, height: 300 }) };

test("a new deck round-trips through its file text", () => {
  const deck = newDeck({ title: "Talk" });
  const again = parseDeck(serializeDeck(deck));
  assert.deepEqual(again, deck);
  assert.equal(serializeDeck(again), serializeDeck(deck));
});

test("parseDeck accepts PPTist's JSON export and rejects other JSON", () => {
  const deck = parseDeck(JSON.stringify({ title: "X", width: 1000, height: 562.5, theme: { fontColor: "#111" }, slides: [{ id: "s", elements: [] }] }));
  assert.equal(deck.viewportSize, 1000);
  assert.equal(deck.viewportRatio, 0.5625);
  assert.equal(deck.theme.fontColor, "#111");
  assert.throws(() => parseDeck("{\"a\": 1}"), /no slides/);
  assert.throws(() => parseDeck("not json"), /Not a slide deck/);
});

test("light Markdown becomes PPTist text HTML", () => {
  assert.equal(textHtml("Hello **world**", { size: 24, color: "#333" }), "<p><span style=\"font-size: 24px; color: #333;\">Hello <strong>world</strong></span></p>");
  assert.equal(textHtml("- one\n- two\nafter"), "<ul><li><p>one</p></li><li><p>two</p></li></ul><p>after</p>");
  assert.equal(textHtml("1. a\n2. b", { align: "center" }), "<ol><li><p style=\"text-align: center;\">a</p></li><li><p style=\"text-align: center;\">b</p></li></ol>");
  assert.equal(textHtml("a < b & *c*"), "<p>a &lt; b &amp; <em>c</em></p>");
  assert.equal(htmlText(textHtml("- one\n- two")), "one\ntwo");
});

test("ops add a slide with elements, edit, reorder and delete them", async () => {
  const deck = newDeck();
  const first = deck.slides[0].id;
  const { deck: out, results } = await applyOps(deck, [
    { op: "add_slide", after: 0, notes: "Say hello", elements: [
      { type: "text", text: "Title", size: 40, box: [80, 60, 800, 70] },
      { type: "image", src: "media/fig.png", left: 100, top: 200, width: 400 },
      { type: "shape", shape: "roundRect", box: [600, 200, 200, 100], text: "Box" },
      { type: "line", from: [100, 500], to: [400, 450], arrow: "end" },
      { type: "latex", latex: "E = mc^2", left: 700, top: 400, height: 50 },
      { type: "table", rows: [["a", "b"], ["1", "2"]] },
      { type: "chart", chartType: "column", labels: ["x", "y"], series: [[1, 2]] },
    ] },
  ], env);
  assert.equal(out.slides.length, 2);
  assert.equal(deck.slides.length, 1, "the input deck is not changed");
  const [, slide] = out.slides;
  assert.deepEqual(results[0].elements, slide.elements.map((e) => e.id));
  assert.equal(slide.remark, "<p>Say hello</p>");
  const [text, image, shape, line, latex, table, chart] = slide.elements;
  assert.match(text.content, /font-size: 40px/);
  assert.equal(image.height, 300, "image height follows its aspect ratio");
  assert.equal(shape.pathFormula, "roundRect");
  assert.deepEqual([line.left, line.top, line.start, line.end, line.points], [100, 450, [0, 50], [300, 0], ["", "arrow"]]);
  assert.equal(latex.path, "", "formulas are drawn by the page");
  assert.equal(table.data[1][1].text, "2");
  assert.deepEqual(chart.data.series, [[1, 2]]);
  assert.equal(chart.chartType, "bar", "the menu's Column is PPTist's bar");

  const { deck: edited } = await applyOps(out, [
    { op: "update_element", id: text.id, text: "New title", color: "#c00" },
    { op: "update_element", id: line.id, to: [500, 500] },
    { op: "update_element", id: shape.id, box: [600, 200, 300, 100] },
    { op: "move_element", id: image.id, to: "front" },
    { op: "delete_element", id: chart.id },
    { op: "move_slide", slide: 1, to: 0 },
    { op: "replace_text", find: "New", replace: "Better" },
    { op: "set_notes", slide: 0, text: "Changed" },
  ], env);
  const moved = edited.slides[0];
  assert.equal(edited.slides[1].id, first);
  assert.equal(htmlText(moved.elements.find((e) => e.id === text.id).content), "Better title");
  assert.match(moved.elements.find((e) => e.id === text.id).content, /color: #c00/);
  assert.equal(moved.elements.at(-1).id, image.id);
  assert.ok(!moved.elements.some((e) => e.id === chart.id));
  assert.match(moved.elements.find((e) => e.id === shape.id).path, /L 300 /, "round rectangle path follows the new width");
  const newLine = moved.elements.find((e) => e.id === line.id);
  assert.deepEqual([newLine.left + newLine.end[0], newLine.top + newLine.end[1]], [500, 500]);
  assert.equal(moved.remark, "<p>Changed</p>");
});

test("a bad op names itself and leaves nothing applied", async () => {
  const deck = newDeck();
  await assert.rejects(applyOps(deck, [{ op: "add_slide" }, { op: "update_element", id: "nope" }], env), /Op 2 \(update_element\): No element nope/);
  await assert.rejects(applyOps(deck, [{ op: "delete_slide", slide: 0 }], env), /at least one slide/);
  await assert.rejects(applyOps(deck, [{ op: "add_element", slide: 0, element: { type: "shape", shape: "blob" } }], env), /Unknown shape/);
});

test("summaries show what the agent needs", async () => {
  const { deck } = await applyOps(newDeck(), [{ op: "add_element", slide: 0, element: { type: "text", text: "Hi", size: 30, box: [1, 2, 3, 4] } }], env);
  const summary = summarize(deck);
  assert.deepEqual(summary.slides[0].elements[0], { id: deck.slides[0].elements[0].id, type: "text", box: [1, 2, 3, 4], text: "Hi", size: 30 });
  assert.deepEqual(summary.canvas, { width: 1280, height: 720 });
});

test("media references map both ways", () => {
  const deck = newDeck();
  deck.slides[0].elements.push({ id: "i", type: "image", src: "media/a.png" }, { id: "s", type: "shape", pattern: "data:image/png;base64,AAAA" });
  deck.slides[0].background = { type: "image", image: { src: "media/bg.jpg", size: "cover" } };
  const seen = [];
  const mapped = mapMedia(deck, (ref) => { seen.push(ref); return `blob:${ref}`; });
  assert.deepEqual(seen, ["media/bg.jpg", "media/a.png", "data:image/png;base64,AAAA"]);
  assert.equal(mapped.slides[0].elements[0].src, "blob:media/a.png");
  assert.equal(deck.slides[0].elements[0].src, "media/a.png");
  assert.ok(isRelativeMedia("media/a.png"));
  assert.ok(!isRelativeMedia("blob:x") && !isRelativeMedia("data:x") && !isRelativeMedia("/abs/a.png") && !isRelativeMedia("https://x/a.png"));
});

test("merge combines property edits on the same element and keeps the user's on a clash", async () => {
  const { deck: base } = await applyOps(newDeck(), [{ op: "add_element", slide: 0, element: { type: "text", id: "t", text: "Hello", box: [0, 0, 100, 40] } }], env);
  const mine = structuredClone(base);
  mine.slides[0].elements[0].left = 50;                                  // the user moved it
  const { deck: theirs } = await applyOps(base, [
    { op: "update_element", id: "t", text: "Hello there" },              // the agent rewrote it
    { op: "add_slide", elements: [{ type: "text", text: "New" }] },
  ], env);
  const merged = mergeDecks(base, mine, theirs);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.deck.slides.length, 2);
  assert.equal(merged.deck.slides[0].elements[0].left, 50);
  assert.equal(htmlText(merged.deck.slides[0].elements[0].content), "Hello there");

  const clash = structuredClone(mine);
  clash.slides[0].elements[0].content = "<p>Mine</p>";
  const result = mergeDecks(base, clash, theirs);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.deck.slides[0].elements[0].content, "<p>Mine</p>");
});

test("merge honours deletions and reordering from either side", async () => {
  const { deck: base } = await applyOps(newDeck(), [{ op: "add_slide", id: "b" }, { op: "add_slide", id: "c" }], env);
  const a = base.slides[0].id;
  const mine = structuredClone(base);
  mine.slides = [mine.slides[2], mine.slides[0], mine.slides[1]];       // user moved c to the front
  const { deck: theirs } = await applyOps(base, [{ op: "delete_slide", slide: "b" }, { op: "add_slide", id: "d", after: "c" }], env);
  const { deck, conflicts } = mergeDecks(base, mine, theirs);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(deck.slides.map((s) => s.id), ["c", "d", a]);
});

test("motion: define transitions and effects, use them, and clean up", async () => {
  const { deck: base } = await applyOps(newDeck(), [
    { op: "add_element", slide: 0, element: { type: "text", id: "t", name: "title", text: "Hi" } },
    { op: "add_slide", id: "s2", elements: [{ type: "text", id: "t2", name: "title", text: "Hi", box: [400, 300, 400, 60] }] },
  ], env);
  const { deck, results } = await applyOps(base, [
    { op: "define_transition", name: "iris", duration: 900, in: [{ clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)" }] },
    { op: "define_effect", name: "rise", type: "in", keyframes: [{ opacity: 0, transform: "translateY(20px)" }, { opacity: 1 }], duration: 600 },
    { op: "set_transition", slide: "s2", transition: "magic" },
    { op: "set_transition", slide: 0, transition: "iris" },
    { op: "add_animation", id: "t2", effect: "rise", trigger: "after" },
    { op: "add_animation", id: "t2", effect: "pulse" },
  ], env);
  assert.equal(results[0].use, "custom:iris");
  assert.deepEqual([deck.slides[0].turningMode, deck.slides[1].turningMode], ["custom:iris", "magic"]);
  const [rise, pulse] = deck.slides[1].animations;
  assert.deepEqual([rise.effect, rise.type, rise.trigger, rise.duration], ["custom:rise", "in", "auto", 600]);
  assert.deepEqual([pulse.effect, pulse.type, pulse.trigger], ["pulse", "attention", "click"]);

  const summary = summarize(deck);
  assert.deepEqual(summary.motion, { transitions: ["iris"], effects: { rise: "in" } });
  assert.equal(summary.slides[1].transition, "magic");
  assert.deepEqual(summary.slides[1].animations.map((a) => [a.effect, a.trigger]), [["custom:rise", "after"], ["pulse", "click"]]);
  assert.equal(parseDeck(serializeDeck(deck)).motion.transitions.iris.duration, 900, "motion survives the file");

  const { deck: edited } = await applyOps(deck, [
    { op: "update_animation", id: pulse.id, trigger: "with", position: 0 },
    { op: "delete_motion", name: "iris" },
  ], env);
  assert.equal(edited.slides[1].animations[0].id, pulse.id);
  assert.equal(edited.slides[1].animations[0].trigger, "meantime");
  assert.equal(edited.slides[0].turningMode, undefined, "slides using a deleted transition fall back");
});

test("motion: bad definitions and names are refused with a reason", async () => {
  const deck = newDeck();
  await assert.rejects(applyOps(deck, [{ op: "define_transition", name: "x", in: [{ "clip-path": "circle(0%)" }] }], env), /camelCase \(clip-path → clipPath\)/);
  await assert.rejects(applyOps(deck, [{ op: "define_transition", name: "Iris Wipe", in: [{ opacity: 0 }] }], env), /lowercase/);
  await assert.rejects(applyOps(deck, [{ op: "define_effect", name: "x", type: "sideways", keyframes: [{}] }], env), /type is in, out or attention/);
  await assert.rejects(applyOps(deck, [{ op: "set_transition", slide: 0, transition: "warp" }], env), /No transition "warp"/);
  await assert.rejects(applyOps(deck, [{ op: "define_effect", name: "x", type: "in", duration: 60000, keyframes: [{}] }], env), /duration/);
});

test("merge keeps custom motion from both sides", async () => {
  const base = newDeck();
  const { deck: mine } = await applyOps(base, [{ op: "define_effect", name: "rise", type: "in", keyframes: [{ opacity: 0 }, { opacity: 1 }] }], env);
  const { deck: theirs } = await applyOps(base, [{ op: "define_transition", name: "iris", in: [{ opacity: 0 }, { opacity: 1 }] }], env);
  const { deck, conflicts } = mergeDecks(base, mine, theirs);
  assert.deepEqual(conflicts, []);
  assert.deepEqual([Object.keys(deck.motion.transitions), Object.keys(deck.motion.effects)], [["iris"], ["rise"]]);
});

test("script elements: code goes to a file next to the deck; edits rewrite it", async () => {
  const written = new Map();
  const scriptEnv = { ...env, writeScript: async (src, code) => { written.set(src, code); return src; } };
  const { deck, results } = await applyOps(newDeck(), [
    { op: "add_element", slide: 0, element: { type: "script", name: "rate map", code: "slide.canvas()", steps: 3, libs: ["d3", "jquery"], box: [100, 100, 400, 300] } },
  ], scriptEnv);
  const script = deck.slides[0].elements[0];
  assert.deepEqual([script.src, script.steps, script.libs], ["scripts/rate-map.js", 3, ["d3"]]);
  assert.equal(written.get("scripts/rate-map.js"), "slide.canvas()");
  const { deck: edited } = await applyOps(deck, [{ op: "update_element", id: results[0].element, code: "slide.svg()", poster: "media/p.png" }], scriptEnv);
  assert.equal(written.get("scripts/rate-map.js"), "slide.svg()");
  assert.equal(edited.slides[0].elements[0].poster, "media/p.png");
  const refs = [];
  mapMedia(edited, (ref) => { refs.push(ref); return ref; });
  assert.deepEqual(refs, ["media/p.png"], "posters are media");
  assert.equal(summarize(edited).slides[0].elements[0].src, "scripts/rate-map.js");
  await assert.rejects(applyOps(newDeck(), [{ op: "add_element", slide: 0, element: { type: "script" } }], scriptEnv), /needs code/);
});
