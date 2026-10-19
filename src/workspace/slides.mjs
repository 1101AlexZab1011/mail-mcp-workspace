// Host side of the Slides space: reading and editing deck files that are not open in the editor,
// the system's font list, image sizes, and agent rewrites of slide text.
import { execFile } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { isDeckPath, newDeck, parseDeck, serializeDeck, summarize } from "../slides/deck.mjs";
import { applyOps } from "../slides/ops.mjs";
import { readText } from "./files.mjs";
import { FsError } from "./writes.mjs";
import { runClaude } from "./writer.mjs";

const run = promisify(execFile);
const DECK_LIMIT = 50 * 1024 * 1024;

const REWRITE_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const REWRITE_PROMPT = `You edit the text of one element on a presentation slide (a scientific talk unless the text says otherwise).
Return only the new text in "text": no quotes, no commentary.
- Keep the language, the meaning, the facts and any numbers, symbols or citations.
- Keep the line structure: one line per paragraph or bullet; keep a leading "- " on bullet lines.
- Slide text is short: fragments are fine, no filler, no marketing tone.
- polish: same length or shorter, clearer and more precise wording.
- expand: add a little substance (at most about half again as long), nothing invented.
- condense: about half as long, keep what matters most.`;
const COMMANDS = new Set(["polish", "expand", "condense"]);

/** Width and height of a PNG, GIF, JPEG, WebP or SVG file, read from its first bytes; null if unknown. */
export async function imageSize(path) {
  const handle = await openFile(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(256 * 1024), 0, 256 * 1024, 0);
    const b = buffer.subarray(0, bytesRead);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const kind = b.toString("ascii", 12, 16);
      if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    const text = b.toString("utf8");
    if (/<svg[\s>]/i.test(text)) {
      const tag = /<svg[^>]*>/i.exec(text)?.[0] ?? "";
      const attr = (name) => Number.parseFloat(new RegExp(`\\s${name}="([\\d.]+)`, "i").exec(tag)?.[1]);
      const viewBox = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/i.exec(tag);
      const width = attr("width") || Number(viewBox?.[1]);
      const height = attr("height") || Number(viewBox?.[2]);
      if (width && height) return { width, height };
    }
    return null;
  } finally { await handle.close(); }
}

export class Slides {
  constructor({ files }) {
    this.files = files; // FileWriter: confined, atomic writes with the lost-update guard
    this.fontList = null;
  }

  async load(path) {
    const full = await this.files.target(path);
    if (!isDeckPath(full)) throw new FsError(400, "bad_request", "Decks are .slides.json files");
    const file = await readText(full, { limit: DECK_LIMIT }).catch((error) => { throw new FsError(error.code === "ENOENT" ? 404 : 400, error.code === "ENOENT" ? "not_found" : "bad_request", error.code === "ENOENT" ? `${full} does not exist` : error.message); });
    if (file.truncated) throw new FsError(413, "too_large", "This deck is over 50 MB; move inline media into files");
    try { return { full, hash: file.hash, deck: parseDeck(file.text) }; }
    catch (error) { throw new FsError(422, "not_a_deck", error.message); }
  }

  /** The deck as the agent reads it (see summarize in src/slides/deck.mjs). */
  async read(path, { from, to, html } = {}) {
    const { full, hash, deck } = await this.load(path);
    return { path: full, hash, ...summarize(deck, { from: from ?? 0, to: to ?? deck.slides.length - 1, html: Boolean(html) }) };
  }

  /** Apply agent ops to a deck file; fails with 409 if the file changed meanwhile (or since `expect`). */
  async apply(path, ops, { expect } = {}) {
    const { full, hash, deck } = await this.load(path);
    if (expect && expect !== hash) throw Object.assign(new FsError(409, "conflict", "The deck changed since you read it"), { current: { hash } });
    const base = dirname(full);
    const sizeOf = (src) => (/^[a-z]+:/i.test(src) ? null : imageSize(isAbsolute(src) ? src : join(base, src)));
    let result;
    const writeScript = async (src, code) => {
      if (!/\.js$/i.test(src) || isAbsolute(src) || src.split("/").includes("..")) throw new Error("A script's src is a .js path inside the deck's folder");
      await this.files.write(join(base, src), { text: code, createDirs: true });
      return src;
    };
    try { result = await applyOps(deck, ops, { imageSize: sizeOf, writeScript }); }
    catch (error) { throw new FsError(422, "bad_op", error.message); }
    const written = await this.files.write(full, { text: serializeDeck(result.deck), expect: hash });
    return { path: full, hash: written.hash, results: result.results, slideCount: result.deck.slides.length };
  }

  async create(path, { title } = {}) {
    const full = await this.files.target(path);
    if (!isDeckPath(full)) throw new FsError(400, "bad_request", "A deck's name ends in .slides.json");
    const name = title ?? full.split("/").pop().replace(/\.slides\.json$/i, "").replace(/[-_]+/g, " ");
    const written = await this.files.write(full, { text: serializeDeck(newDeck({ title: name })), expect: "absent", createDirs: true });
    return { path: full, hash: written.hash };
  }

  /** The code of a script element (a file relative to the deck), for its sandboxed frame. */
  async scriptCode(deck, src) {
    if (typeof src !== "string" || !src.trim()) throw new FsError(400, "bad_request", "src is the script file, relative to the deck");
    const base = dirname(await this.files.target(deck));
    const full = await this.files.target(isAbsolute(src) ? src : join(base, src));
    const file = await readText(full, { limit: 2 * 1024 * 1024 }).catch(() => { throw new FsError(404, "not_found", `No script ${src} next to the deck`); });
    if (file.truncated) throw new FsError(413, "too_large", "Scripts are at most 2 MB");
    return file.text;
  }

  /** Installed font families (fontconfig), sorted. */
  async fonts() {
    if (this.fontList) return this.fontList;
    const { stdout } = await run("fc-list", [":", "family"], { maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
    const families = new Set();
    for (const line of stdout.split("\n")) {
      const family = line.split(",")[0].trim();
      if (family && !family.startsWith(".")) families.add(family);
    }
    this.fontList = [...families].sort((a, b) => a.localeCompare(b));
    return this.fontList;
  }

  /** Rewrite slide text: polish, expand or condense. */
  async rewrite({ text, command, path } = {}) {
    if (typeof text !== "string" || !text.trim()) throw new FsError(400, "bad_request", "There is no text to rewrite");
    if (!COMMANDS.has(command)) throw new FsError(400, "bad_request", "command is polish, expand or condense");
    if (text.length > 8000) throw new FsError(413, "too_large", "That is too much text for one slide element");
    const { result } = await runClaude({ prompt: `Command: ${command}\n\nTEXT:\n${text}`, schema: REWRITE_SCHEMA, system: REWRITE_PROMPT, cwd: path ? dirname(path) : undefined, who: "agent" });
    if (typeof result.text !== "string") throw new FsError(502, "review_failed", "The agent gave no text");
    return { text: result.text.trim() };
  }
}
