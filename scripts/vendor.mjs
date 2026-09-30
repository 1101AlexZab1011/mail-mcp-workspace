#!/usr/bin/env node
// Copies third-party browser assets from node_modules into the add-on, so the
// add-on works offline and ships exactly what it uses. Run after npm install.
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = (path) => join(root, "node_modules", path);
const to = (path) => join(root, "thunderbird-addon/vendor", path);

await rm(to("pdfjs"), { recursive: true, force: true });
await mkdir(to("pdfjs"), { recursive: true });
for (const file of ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "web/pdf_viewer.mjs", "web/pdf_viewer.css", "LICENSE"]) {
  await cp(from(`pdfjs-dist/${file}`), to(`pdfjs/${file.split("/").pop()}`));
}
for (const dir of ["cmaps", "standard_fonts", "iccs", "web/images"]) {
  await cp(from(`pdfjs-dist/${dir}`), to(`pdfjs/${dir.split("/").pop()}`), { recursive: true });
}
// Image decoders only; the scripting engine (quickjs) stays out: PDF scripts never run here.
await mkdir(to("pdfjs/wasm"), { recursive: true });
for (const file of ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm", "openjpeg_nowasm_fallback.js", "jbig2_nowasm_fallback.js", "LICENSE_OPENJPEG", "LICENSE_JBIG2", "LICENSE_QCMS"]) {
  await cp(from(`pdfjs-dist/wasm/${file}`), to(`pdfjs/wasm/${file}`));
}
// xterm.js for the terminal panel.
await rm(to("xterm"), { recursive: true, force: true });
await mkdir(to("xterm"), { recursive: true });
for (const [file, name] of [["@xterm/xterm/lib/xterm.mjs", "xterm.mjs"], ["@xterm/xterm/css/xterm.css", "xterm.css"], ["@xterm/addon-fit/lib/addon-fit.mjs", "addon-fit.mjs"], ["@xterm/addon-web-links/lib/addon-web-links.mjs", "addon-web-links.mjs"], ["@xterm/xterm/LICENSE", "LICENSE"]]) {
  await cp(from(file), to(`xterm/${name}`));
}
console.log("vendored pdf.js and xterm.js");
