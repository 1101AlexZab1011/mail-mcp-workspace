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

import * as P from "../thunderbird-addon/draw/path.js";

test("path data reads into nodes with handles, whatever the command", () => {
  const [sq] = P.parsePath("m10 10 l10 0 0 10z");
  assert.equal(sq.closed, true);
  assert.deepEqual(sq.nodes.map((n) => n.p), [[10, 10], [20, 10], [20, 20]]);
  assert.equal(P.serializePath(P.parsePath("m10 10 l10 0 0 10z")), "M 10,10 L 20,10 L 20,20 Z");
  assert.equal(P.serializePath(P.parsePath("M0 0 H5 V5")), "M 0,0 L 5,0 L 5,5");
  const smooth = P.parsePath("M0 0 C 1 1 2 2 3 3 S 5 5 6 6")[0].nodes;
  assert.deepEqual(smooth[1].out, [4, 4]); // reflected control point
  const quad = P.parsePath("M0,0 Q 6,9 12,0")[0].nodes;
  assert.deepEqual(quad[0].out, [4, 6]);
  assert.deepEqual(quad[1].in, [8, 6]);
  const arc = P.parsePath("M0 0 a5 5 0 01 10 0")[0].nodes[1];
  assert.equal(arc.kind, "A");
  assert.deepEqual(arc.arc, [5, 5, 0, 0, 1]);
  assert.deepEqual(arc.p, [10, 0]);
  assert.equal(P.serializePath(P.parsePath("M0 0 a5 5 0 01 10 0")), "M 0,0 A 5 5 0 0 1 10,0");
});

test("a closed curve that ends on its start keeps its closing curve", () => {
  const d = "M 0,0 C 0,5 5,10 10,10 C 15,10 10,0 0,0 Z";
  const [sub] = P.parsePath(d);
  assert.equal(sub.nodes.length, 2);
  assert.deepEqual(sub.nodes[0].in, [10, 0]);
  assert.equal(P.serializePath([sub]), "M 0,0 C 0,5 5,10 10,10 C 15,10 10,0 0,0 Z");
});

test("splitting keeps the curve's shape; removing joins the neighbours", () => {
  const [sub] = P.parsePath("M 0,0 C 0,10 10,10 10,0");
  const before = P.pointAt(sub.nodes[0], sub.nodes[1], 0.25);
  const node = P.splitSegment(sub, 1, 0.5);
  assert.equal(sub.nodes.length, 3);
  assert.deepEqual(node.p, [5, 7.5]);
  const after = P.pointAt(sub.nodes[0], sub.nodes[1], 0.5);
  assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 1e-9);
  P.removeNode(sub, 1);
  assert.equal(sub.nodes.length, 2);
  assert.equal(sub.nodes[1].kind, "C");
  const [line] = P.parsePath("M 0,0 L 10,0 L 20,0");
  P.splitSegment(line, 1, 0.5);
  assert.deepEqual(line.nodes[1].p, [5, 0]);
  P.removeNode(line, 0);
  assert.equal(P.serializePath([line]), "M 5,0 L 10,0 L 20,0");
});

test("segments turn straight or curved, nodes smooth", () => {
  const [sub] = P.parsePath("M 0,0 L 9,0 L 9,9");
  P.setSegmentCurved(sub, 1, true);
  assert.deepEqual(sub.nodes[0].out, [3, 0]);
  assert.deepEqual(sub.nodes[1].in, [6, 0]);
  P.makeSmooth(sub.nodes[1], sub.nodes[0], sub.nodes[2]);
  assert.ok(P.isSmooth(sub.nodes[1]));
  P.setSegmentCurved(sub, 1, false);
  assert.equal(sub.nodes[0].out, null);
});

test("shapes become the same outline as a path", () => {
  assert.equal(P.shapePath("rect", { x: 1, y: 2, width: 3, height: 4 }), "M 1,2 L 4,2 L 4,6 L 1,6 Z");
  assert.match(P.shapePath("circle", { cx: 0, cy: 0, r: 10 }), /^M 10,0 C 10,5\.5228 5\.5228,10 0,10/);
  assert.equal(P.shapePath("polygon", { points: "0,0 5,0 5,5" }), "M 0,0 L 5,0 L 5,5 Z");
  assert.equal(P.shapePath("line", { x1: 0, y1: 0, x2: 3, y2: 4 }), "M 0,0 L 3,4");
  assert.match(P.shapePath("rect", { x: 0, y: 0, width: 10, height: 10, rx: 2 }), /C/);
});
