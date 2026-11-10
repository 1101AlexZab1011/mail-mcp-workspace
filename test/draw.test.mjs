import test from "node:test";
import assert from "node:assert/strict";
import * as g from "../thunderbird-addon/draw/geometry.js";

const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test("matrices multiply, invert and apply like SVG's", () => {
  const m = g.multiply(g.translation(10, 20), g.scalingAbout(2, 3, 0, 0));
  assert.deepEqual(g.apply(m, [1, 1]), [12, 23]);
  assert.ok(close(g.multiply(m, g.invert(m)), g.IDENTITY));
  assert.deepEqual(g.applyVector(m, [1, 1]), [2, 3]);
  assert.deepEqual(g.apply(g.scalingAbout(2, 2, 5, 5), [5, 5]), [5, 5]);
});

test("numbers are written briefly", () => {
  assert.equal(g.fmt(1.23456789), "1.2346");
  assert.equal(g.fmt(-0.00001), "0");
  assert.equal(g.fmt(3), "3");
  assert.equal(g.matrixString([1, 0, 0, 1, 2.5, -3]), "matrix(1,0,0,1,2.5,-3)");
});

test("a move keeps the original transform as written", () => {
  assert.equal(g.moveTransform(null, 5, -2), "translate(5,-2)");
  assert.equal(g.moveTransform("translate(10, 20)", 5, -2), "translate(15,18)");
  assert.equal(g.moveTransform("translate(7)", 3, 4), "translate(10,4)");
  assert.equal(g.moveTransform("translate(5,-2)", -5, 2), null);
  assert.equal(g.moveTransform("rotate(30) scale(2)", 1, 1), "translate(1,1) rotate(30) scale(2)");
});

test("a scale is written as simply as it can be", () => {
  // A translation in front of no transform stays a translate.
  assert.equal(g.composedTransform(null, g.translation(3, 4), g.IDENTITY), "translate(3,4)");
  // Undoing a transform entirely removes the attribute.
  assert.equal(g.composedTransform("translate(3,4)", g.translation(-3, -4), g.translation(3, 4)), null);
  // Anything else becomes one matrix.
  assert.equal(g.composedTransform("rotate(90)", g.scalingAbout(2, 2, 0, 0), [0, 1, -1, 0, 0, 0]), "matrix(0,2,-2,0,0,0)");
});

test("the XML declaration and final newline survive serialization", () => {
  const text = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>\n';
  const framing = g.framing(text);
  assert.equal(framing.declaration, '<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  assert.equal(g.frame('<svg xmlns="http://www.w3.org/2000/svg"/>', framing), text);
  // A serializer that writes its own declaration does not get two.
  assert.equal(g.frame('<?xml version="1.0"?><svg/>', framing), `${framing.declaration}\n<svg/>\n`);
  assert.equal(g.frame("<svg/>", g.framing("<svg/>")), "<svg/>");
});

test("fresh ids do not collide", () => {
  const taken = new Set(["rect1", "rect2", "g1"]);
  assert.equal(g.freshId("rect", taken), "rect3");
  assert.equal(g.freshId("rect", taken), "rect4");
  assert.equal(g.freshId("", taken), "id1");
});

test("a new drawing is an Inkscape-ready page in the chosen orientation", () => {
  const a0 = g.blankDrawing({ w: 841, h: 1189, unit: "mm" });
  assert.match(a0, /width="841mm"/);
  assert.match(a0, /height="1189mm"/);
  assert.match(a0, /viewBox="0 0 841 1189"/);
  assert.match(a0, /inkscape:groupmode="layer"/);
  const wide = g.blankDrawing({ w: 841, h: 1189, unit: "mm", landscape: true });
  assert.match(wide, /width="1189mm"/);
  const hd = g.blankDrawing({ w: 1920, h: 1080, unit: "px", landscape: true });
  assert.match(hd, /width="1920"/);
  assert.match(hd, /viewBox="0 0 1920 1080"/);
});

test("style attributes change one property and keep the rest as written", () => {
  assert.deepEqual(g.parseStyle("fill:#fff; stroke : none;;font-family:'URW Gothic', sans-serif"), [["fill", "#fff"], ["stroke", "none"], ["font-family", "'URW Gothic', sans-serif"]]);
  assert.equal(g.setStyleProperty("fill:#fff;stroke:none", "stroke", "#000"), "fill:#fff;stroke:#000");
  assert.equal(g.setStyleProperty("fill:#fff", "stroke-width", "2"), "fill:#fff;stroke-width:2");
  assert.equal(g.setStyleProperty("fill:#fff;stroke:none", "fill", null), "stroke:none");
  assert.equal(g.setStyleProperty(null, "fill", "red"), "fill:red");
});

test("colours and lengths are read the way the panel shows them", () => {
  assert.equal(g.hexColor("rgb(30, 136, 229)"), "#1e88e5");
  assert.equal(g.hexColor("#ABC"), "#aabbcc");
  assert.equal(g.hexColor("none"), null);
  assert.equal(g.hexColor("rgba(0, 0, 0, 0)"), null);
  assert.equal(g.hexColor("url(#grad)"), null);
  assert.equal(g.lengthInPx("10mm").toFixed(3), "37.795");
  assert.equal(g.lengthInPx("12pt"), 16);
  assert.equal(g.lengthInPx("100"), 100);
  assert.equal(g.lengthInPx("50%"), null);
});

test("Ctrl snaps lines to 15° steps", () => {
  const [x, y] = g.snapAngle(10, 1);
  assert.ok(Math.abs(x - Math.hypot(10, 1)) < 1e-9 && Math.abs(y) < 1e-9);
  const [a, b] = g.snapAngle(10, 9);
  assert.ok(Math.abs(a - b) < 1e-9);
});
