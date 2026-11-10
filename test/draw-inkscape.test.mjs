import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Draw } from "../src/workspace/draw.mjs";
import { FileWriter } from "../src/workspace/writes.mjs";

const hasInkscape = (() => { try { execFileSync("inkscape", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const DRAWING = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <g id="layer" style="fill:#ff0000">
    <rect id="a" x="10" y="10" width="40" height="40"/>
    <rect id="b" x="30" y="30" width="40" height="40"/>
  </g>
</svg>
`;

test("Inkscape unites two objects and marks the result", { skip: !hasInkscape && "inkscape is not installed" }, async () => {
  const draw = new Draw({ files: new FileWriter({ root: tmpdir() }) });
  const { svg } = await draw.operate({ svg: DRAWING, ids: ["a", "b"], operation: "union" });
  assert.match(svg, /data-draw-result="1"/);
  assert.doesNotMatch(svg, /id="b"/);
});

test("operations refuse ids that could smuggle in other actions", async () => {
  const draw = new Draw({ files: new FileWriter({ root: tmpdir() }) });
  assert.throws(() => draw.operate({ svg: DRAWING, ids: ["a;export-do"], operation: "union" }), /ids/);
  assert.throws(() => draw.operate({ svg: DRAWING, ids: ["a"], operation: "rm" }), /operation/);
});

test("a drawing exports to PDF and PNG at print size", { skip: !hasInkscape && "inkscape is not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "draw-export-"));
  try {
    const draw = new Draw({ files: new FileWriter({ root: dir }) });
    await writeFile(join(dir, "poster.svg"), DRAWING);
    const pdf = await draw.export({ svg: DRAWING, source: join(dir, "poster.svg"), out: join(dir, "poster.pdf") });
    assert.equal(pdf.format, "pdf");
    assert.equal((await readFile(join(dir, "poster.pdf"))).subarray(0, 4).toString(), "%PDF");
    const png = await draw.export({ svg: DRAWING, source: join(dir, "poster.svg"), out: join(dir, "poster.png"), dpi: 96 });
    assert.equal(png.dpi, 96);
    const bytes = await readFile(join(dir, "poster.png"));
    assert.equal(bytes.readUInt32BE(16), 100); // 100 px at 96 dpi
    const { svg } = await draw.importPdf({ path: join(dir, "poster.pdf") });
    assert.match(svg, /<svg/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
