// Filesystem access for the file browser and viewer: listing, stat with a
// "viewer kind", and bounded text reads. Paths are absolute; "~" expands.
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

export const expand = (path) => resolve(String(path ?? "").replace(/^~(?=$|\/)/, homedir()));

const kinds = {
  pdf: ["pdf"],
  document: ["doc", "docx", "odt", "rtf", "fodt", "wpd", "pages"],
  slides: ["ppt", "pptx", "odp", "fodp", "key", "pps", "ppsx"],
  sheet: ["xls", "xlsx", "xlsm", "xlsb", "ods", "fods", "csv", "tsv", "numbers"],
  markdown: ["md", "markdown", "mdx", "mkd"],
  svg: ["svg"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "apng"],
  audio: ["mp3", "ogg", "oga", "opus", "wav", "flac", "m4a", "aac", "weba"],
  video: ["mp4", "webm", "mkv", "mov", "m4v", "ogv"],
  text: ["txt", "log", "text", "out", "err", "rst", "adoc", "org", "nfo"],
};
const byExtension = new Map(Object.entries(kinds).flatMap(([kind, list]) => list.map((ext) => [ext, kind])));

const mime = {
  pdf: "application/pdf", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", apng: "image/apng",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", weba: "audio/webm",
  mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg",
  json: "application/json", txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", css: "text/css", js: "text/javascript",
};

export const mimeOf = (path) => mime[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";

/** Is the start of this file text? NUL bytes or invalid UTF-8 mean binary. */
async function looksTextual(path) {
  const handle = await open(path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, Math.max(0, bytesRead - 4))); return true; }
    catch { return false; }
  } finally { await handle.close(); }
}

/** The viewer that fits a file: pdf, document, slides, sheet, markdown, svg, image, audio, video, text, code, binary. */
export async function kindOf(path, info) {
  if (info.isDirectory()) return "directory";
  const ext = extname(path).slice(1).toLowerCase();
  const known = byExtension.get(ext);
  if (known) return known;
  const { languageOf } = await import("./highlight.mjs");
  if (languageOf(path)) return "code";
  if (info.size === 0) return "text";
  return (await looksTextual(path)) ? "text" : "binary";
}

export async function statPath(path) {
  const full = expand(path);
  const info = await stat(full);
  const kind = await kindOf(full, info);
  const { languageOf } = await import("./highlight.mjs");
  return {
    path: full,
    name: basename(full) || full,
    kind,
    language: kind === "code" || kind === "text" ? languageOf(full) : null,
    size: info.size,
    mtime: info.mtime.toISOString(),
    mime: mimeOf(full),
    directory: info.isDirectory(),
  };
}

export async function listDirectory(path, { hidden = false } = {}) {
  const full = expand(path);
  const entries = await readdir(full, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!hidden && entry.name.startsWith(".")) continue;
    const child = join(full, entry.name);
    let directory = entry.isDirectory();
    let size = 0;
    let mtime = null;
    let broken = false;
    try {
      const info = await stat(child); // follows symlinks
      directory = info.isDirectory();
      size = info.size;
      mtime = info.mtime.toISOString();
    } catch { broken = true; }
    out.push({ name: entry.name, path: child, directory, symlink: entry.isSymbolicLink(), size, mtime, broken });
  }
  out.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.directory ? -1 : 1));
  const real = await realpath(full).catch(() => full);
  return { path: full, real, entries: out };
}

/** Read up to `limit` bytes as UTF-8 text. */
export async function readText(path, { limit = 5 * 1024 * 1024 } = {}) {
  const full = expand(path);
  const info = await stat(full);
  const handle = await open(full, "r");
  try {
    const size = Math.min(info.size, limit);
    const { buffer } = await handle.read(Buffer.alloc(size), 0, size, 0);
    return { path: full, text: buffer.toString("utf8"), size: info.size, truncated: info.size > limit };
  } finally { await handle.close(); }
}

/** Directory completions for the path field: children of the parent matching the typed prefix. */
export async function complete(partial, { limit = 20 } = {}) {
  const full = expand(partial);
  const endsWithSlash = /\/$/.test(String(partial));
  const dir = endsWithSlash ? full : resolve(full, "..");
  const prefix = endsWithSlash ? "" : basename(full).toLowerCase();
  const { entries } = await listDirectory(dir, { hidden: prefix.startsWith(".") }).catch(() => ({ entries: [] }));
  return entries.filter((entry) => entry.directory && entry.name.toLowerCase().startsWith(prefix)).slice(0, limit).map((entry) => entry.path);
}
