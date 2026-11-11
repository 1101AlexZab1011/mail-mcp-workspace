// Draw's Inkscape work, by the inkscape command line: path operations (booleans, object and stroke
// to path, combine, break apart, simplify), export at print size (PDF, PNG) and PDF pages as SVG.
//
// Operations run on a copy of the whole drawing, so styles, clips and fonts behave exactly as in
// Inkscape; the result is marked (data-draw-result) and the Draw page swaps it in for the originals.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { program } from "../platform.mjs";
import { FsError, versionOf } from "./writes.mjs";

const run = promisify(execFile);

export const inkscape = () => program("inkscape", "MAIL_WORKSPACE_INKSCAPE");

/** Draw's names for Inkscape's actions. */
export const OPERATIONS = {
  union: "path-union", difference: "path-difference", intersection: "path-intersection", exclusion: "path-exclusion",
  division: "path-division", "cut-path": "path-cut", combine: "path-combine", "break-apart": "path-break-apart",
  "object-to-path": "object-to-path", "stroke-to-path": "object-stroke-to-path", simplify: "path-simplify",
};
const ID = /^[A-Za-z_][\w.-]*$/; // ids go into an action list, where "," and ";" separate

export class Draw {
  constructor({ files }) {
    this.files = files;
    this.queue = Promise.resolve();
  }

  /** One Inkscape at a time: it is heavy, and several at once gain nothing. */
  #serial(job) {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  async #inkscape(args, timeout = 180_000) {
    try {
      return await run(inkscape(), args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, SELF_CALL: "1" }, windowsHide: true });
    } catch (error) {
      if (error.code === "ENOENT") throw new FsError(501, "no_inkscape", "Inkscape is not installed (it does this part of Draw's work)");
      const detail = String(error.stderr ?? error.message).split("\n").filter((line) => line && !/^\s*$|Gtk-|dbus|Fontconfig/i.test(line)).slice(-3).join(" ");
      throw new FsError(502, "inkscape_failed", `Inkscape failed${detail ? `: ${detail}` : ""}`);
    }
  }

  /** Run `operation` on the objects `ids` of the drawing `svg`; returns the drawing as Inkscape left it. */
  operate({ svg, ids, operation }) {
    const action = OPERATIONS[operation];
    if (!action) throw new FsError(400, "bad_request", `operation is one of ${Object.keys(OPERATIONS).join(", ")}`);
    if (typeof svg !== "string" || !svg.includes("<svg")) throw new FsError(400, "bad_request", "svg is the drawing's text");
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string" && ID.test(id))) throw new FsError(400, "bad_request", "ids are the ids of the objects to work on");
    return this.#serial(async () => {
      const work = await mkdtemp(join(tmpdir(), "mail-workspace-draw-"));
      try {
        const input = join(work, "in.svg");
        const output = join(work, "out.svg");
        await writeFile(input, svg);
        const actions = [`select-by-id:${ids.join(",")}`, action, "object-set-attribute:data-draw-result,1", "export-type:svg", `export-filename:${output}`, "export-do"];
        await this.#inkscape([`--actions=${actions.join(";")}`, input]);
        const result = await readFile(output, "utf8").catch(() => { throw new FsError(502, "inkscape_failed", "Inkscape wrote no result"); });
        if (!result.includes("data-draw-result")) throw new FsError(422, "nothing_done", `Inkscape could not ${operation.replace(/-/g, " ")} these objects`);
        return { svg: result };
      } finally { await rm(work, { recursive: true, force: true }); }
    });
  }

  /**
   * Export a drawing (its current text) as PDF or PNG at `out`. The text is written next to the
   * drawing for a moment, so images it links by relative path are found.
   */
  async export({ svg, source, out, format = extname(out ?? "").slice(1).toLowerCase(), dpi = 300, textToPath = false }) {
    if (!["pdf", "png"].includes(format)) throw new FsError(400, "bad_request", "format is pdf or png");
    if (typeof svg !== "string" || !svg.includes("<svg")) throw new FsError(400, "bad_request", "svg is the drawing's text");
    const target = await this.files.target(out);
    const beside = source ? dirname(await this.files.target(source)) : dirname(target);
    const resolution = Math.min(Math.max(Number(dpi) || 300, 30), 1200);
    return this.#serial(async () => {
      const input = join(beside, `.${basename(source ?? target, extname(source ?? target))}.draw-export-${process.pid}-${Date.now()}.svg`);
      await writeFile(input, svg, { mode: 0o600 });
      try {
        const args = [input, `--export-type=${format}`, `--export-filename=${target}`, "--export-area-page"];
        if (format === "png") args.push(`--export-dpi=${resolution}`, "--export-background-opacity=1");
        if (format === "pdf" && textToPath) args.push("--export-text-to-path");
        await this.#inkscape(args, 600_000);
      } finally { await rm(input, { force: true }); }
      return { path: target, format, ...(format === "png" ? { dpi: resolution } : {}), ...(await versionOf(target)) };
    });
  }

  /** One page of a PDF (a file, or its bytes in base64) as SVG text. */
  importPdf({ path, base64, page = 1 }) {
    return this.#serial(async () => {
      const work = await mkdtemp(join(tmpdir(), "mail-workspace-draw-"));
      try {
        let input = path ? await this.files.target(path) : null;
        if (!input) {
          if (typeof base64 !== "string") throw new FsError(400, "bad_request", "Pass the PDF's path or its bytes (base64)");
          input = join(work, "in.pdf");
          await writeFile(input, Buffer.from(base64, "base64"));
        }
        const output = join(work, "page.svg");
        await this.#inkscape([`--pages=${Math.max(1, Number(page) || 1)}`, input, "--export-type=svg", "--export-plain-svg", `--export-filename=${output}`]);
        return { svg: await readFile(output, "utf8") };
      } finally { await rm(work, { recursive: true, force: true }); }
    });
  }
}
