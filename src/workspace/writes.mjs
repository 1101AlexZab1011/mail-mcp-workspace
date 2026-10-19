// Writing files for the add-on and the agent: atomic writes with a lost-update
// guard, exact-match edits, folders, moves, and deletion into the freedesktop
// Trash (restorable from any file manager).
//
// Everything is confined to one root (the home folder by default), checked on
// the real path so a symlink cannot lead outside it, and credential folders are
// refused outright.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { expand } from "./files.mjs";

export class FsError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

/** Paths under the root that are never written, moved or trashed. */
export const DENIED = [".ssh", ".gnupg", ".pki", ".password-store", ".config/listener-mcp", ".local/share/keyrings", ".local/share/Trash"];

export const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The version of a file the editor and agent pass back as `expect`. */
export async function versionOf(full) {
  const info = await stat(full);
  if (info.isDirectory()) return { mtime: info.mtime.toISOString(), size: info.size, hash: null, directory: true };
  return { mtime: info.mtime.toISOString(), size: info.size, hash: hashOf(await readFile(full)) };
}

export class FileWriter {
  constructor({ root = homedir(), trashDir, denied = DENIED } = {}) {
    this.root = resolve(root);
    this.trashDir = trashDir ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "Trash");
    this.denied = denied;
    this.realRoot = null;
  }

  async #realRoot() { return (this.realRoot ??= await realpath(this.root)); }

  /** Resolve `path` to a real absolute path inside the root; new paths resolve through their nearest existing ancestor. */
  async target(path) {
    if (typeof path !== "string" || !path.trim()) throw new FsError(400, "bad_request", "A path is required");
    const full = expand(path);
    let existing = full;
    const rest = [];
    for (;;) {
      try { existing = await realpath(existing); break; } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = dirname(existing);
        if (parent === existing) throw new FsError(400, "bad_request", `Cannot resolve ${path}`);
        rest.unshift(basename(existing));
        existing = parent;
      }
    }
    const real = join(existing, ...rest);
    const root = await this.#realRoot();
    const inside = relative(root, real);
    if (inside === "" ) throw new FsError(403, "forbidden", "The home folder itself cannot be changed");
    if (inside.startsWith("..") || inside.startsWith(sep) || resolve(root, inside) !== real) throw new FsError(403, "forbidden", `${path} is outside ${this.root}`);
    for (const denied of this.denied) {
      if (inside === denied || inside.startsWith(denied + sep)) throw new FsError(403, "forbidden", `${path} is in a protected folder (~/${denied})`);
    }
    return real;
  }

  /** Write text or bytes atomically. `expect` (a hash, or {hash}) refuses to overwrite a file that changed since it was read. */
  async write(path, { text, base64, bytes: raw, expect, create = true, createDirs = false } = {}) {
    if (text === undefined && base64 === undefined && raw === undefined) throw new FsError(400, "bad_request", "Pass text, base64 or bytes");
    const full = await this.target(path);
    const bytes = raw ?? (text !== undefined ? Buffer.from(String(text), "utf8") : Buffer.from(String(base64), "base64"));
    const before = await stat(full).catch(() => null);
    if (before?.isDirectory()) throw new FsError(400, "is_directory", `${path} is a folder`);
    if (!before && !create) throw new FsError(404, "not_found", `${path} does not exist`);
    const expected = typeof expect === "string" ? expect : expect?.hash;
    if (expected !== undefined && expected !== null) {
      const current = before ? hashOf(await readFile(full)) : "absent";
      if (current !== expected) {
        const conflict = before ? { ...(await versionOf(full)), text: bytes.length < 5e6 && text !== undefined ? await readFile(full, "utf8") : undefined } : { absent: true };
        throw new FsError(409, "conflict", `${path} changed since it was read`, { current: conflict });
      }
    }
    if (createDirs) await mkdir(dirname(full), { recursive: true });
    else await stat(dirname(full)).catch(() => { throw new FsError(404, "not_found", `Folder ${dirname(full)} does not exist (pass createDirs)`); });
    await atomicWrite(full, bytes, before?.mode);
    return { path: full, created: !before, ...(await versionOf(full)) };
  }

  /** Replace `oldString` with `newString`; it must occur exactly once unless `all`. */
  async edit(path, { oldString, newString, all = false, expect } = {}) {
    if (typeof oldString !== "string" || typeof newString !== "string" || !oldString) throw new FsError(400, "bad_request", "oldString (non-empty) and newString are required");
    const full = await this.target(path);
    const original = await readFile(full, "utf8").catch((error) => { throw error.code === "ENOENT" ? new FsError(404, "not_found", `${path} does not exist`) : error; });
    const expected = typeof expect === "string" ? expect : expect?.hash;
    if (expected && hashOf(Buffer.from(original, "utf8")) !== expected) throw new FsError(409, "conflict", `${path} changed since it was read`, { current: await versionOf(full) });
    const count = original.split(oldString).length - 1;
    if (count === 0) throw new FsError(422, "not_found_in_file", "oldString does not occur in the file; read it again and copy the text exactly");
    if (count > 1 && !all) throw new FsError(422, "not_unique", `oldString occurs ${count} times; add surrounding context to make it unique, or pass all`);
    const updated = all ? original.split(oldString).join(newString) : original.replace(oldString, () => newString);
    await atomicWrite(full, Buffer.from(updated, "utf8"), (await stat(full)).mode);
    return { path: full, replacements: all ? count : 1, ...(await versionOf(full)) };
  }

  async mkdir(path) {
    const full = await this.target(path);
    await mkdir(full, { recursive: true });
    return { path: full, created: true };
  }

  async move(from, to, { overwrite = false } = {}) {
    const source = await this.target(from);
    await lstat(source).catch(() => { throw new FsError(404, "not_found", `${from} does not exist`); });
    let destination = await this.target(to);
    // Moving onto an existing folder means "into it", as mv does.
    if ((await stat(destination).catch(() => null))?.isDirectory()) destination = join(destination, basename(source));
    if (destination === source) return { path: destination, moved: false };
    if (await lstat(destination).catch(() => null)) {
      if (!overwrite) throw new FsError(409, "exists", `${destination} already exists (pass overwrite)`);
    }
    if ((destination + sep).startsWith(source + sep)) throw new FsError(400, "bad_request", "Cannot move a folder into itself");
    await mkdir(dirname(destination), { recursive: true });
    try { await rename(source, destination); } catch (error) {
      if (error.code !== "EXDEV") throw error;
      await cp(source, destination, { recursive: true, errorOnExist: !overwrite, force: overwrite, preserveTimestamps: true });
      await rm(source, { recursive: true, force: true });
    }
    return { path: destination, moved: true, from: source };
  }

  /** Move to the freedesktop Trash: files/<name> plus info/<name>.trashinfo. */
  async trash(path) {
    const full = await this.target(path);
    await lstat(full).catch(() => { throw new FsError(404, "not_found", `${path} does not exist`); });
    const files = join(this.trashDir, "files");
    const info = join(this.trashDir, "info");
    await mkdir(files, { recursive: true, mode: 0o700 });
    await mkdir(info, { recursive: true, mode: 0o700 });
    const name = await uniqueName(files, basename(full));
    const record = `[Trash Info]\nPath=${encodePath(full)}\nDeletionDate=${localIso(new Date())}\n`;
    // Claim the name with the .trashinfo first (O_EXCL), as the spec requires.
    const handle = await open(join(info, `${name}.trashinfo`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(record); } finally { await handle.close(); }
    try { await rename(full, join(files, name)); } catch (error) {
      if (error.code !== "EXDEV") { await rm(join(info, `${name}.trashinfo`), { force: true }); throw error; }
      await cp(full, join(files, name), { recursive: true, preserveTimestamps: true });
      await rm(full, { recursive: true, force: true });
    }
    return { path: full, trashed: name };
  }

  /** Put a trashed item back where it came from. */
  async restore(name) {
    if (typeof name !== "string" || !name || name.includes("/") || name.startsWith(".")) throw new FsError(400, "bad_request", "A trash entry name is required");
    const infoFile = join(this.trashDir, "info", `${name}.trashinfo`);
    const record = await readFile(infoFile, "utf8").catch(() => { throw new FsError(404, "not_found", `No trash entry ${name}`); });
    const original = decodeURIComponent(/^Path=(.*)$/m.exec(record)?.[1] ?? "");
    const target = await this.target(original);
    if (await lstat(target).catch(() => null)) throw new FsError(409, "exists", `${target} exists again; move it away first`);
    await mkdir(dirname(target), { recursive: true });
    await rename(join(this.trashDir, "files", name), target);
    await rm(infoFile, { force: true });
    return { path: target, restored: true };
  }

  /** Trash entries, newest first. */
  async trashed({ limit = 50 } = {}) {
    const info = join(this.trashDir, "info");
    const names = (await readdir(info).catch(() => [])).filter((n) => n.endsWith(".trashinfo"));
    const out = [];
    for (const file of names) {
      const record = await readFile(join(info, file), "utf8").catch(() => "");
      out.push({ name: file.slice(0, -".trashinfo".length), path: decodeURIComponent(/^Path=(.*)$/m.exec(record)?.[1] ?? ""), deleted: /^DeletionDate=(.*)$/m.exec(record)?.[1] ?? "" });
    }
    return out.sort((a, b) => b.deleted.localeCompare(a.deleted)).slice(0, limit);
  }
}

async function atomicWrite(full, bytes, mode) {
  const temp = join(dirname(full), `.${basename(full)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", mode ?? 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try { await rename(temp, full); } catch (error) { await rm(temp, { force: true }); throw error; }
}

async function uniqueName(folder, name) {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; ; i++) {
    const candidate = i ? `${stem}.${i + 1}${ext}` : name;
    const taken = await lstat(join(folder, candidate)).then(() => true, () => false)
      || await lstat(join(folder, "..", "info", `${candidate}.trashinfo`)).then(() => true, () => false);
    if (!taken) return candidate;
  }
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
function localIso(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Wait until the file's version differs from `since` (a hash), or `waitMs` passes. */
export async function waitForChange(full, since, { waitMs = 25_000, signal } = {}) {
  const current = async () => versionOf(full).catch((error) => (error.code === "ENOENT" ? { absent: true, hash: "absent" } : Promise.reject(error)));
  let now = await current();
  if (!since || now.hash !== since) return now;
  const { watch } = await import("node:fs");
  const name = basename(full);
  return new Promise((resolveWait) => {
    let done = false;
    let watcher = null;
    const finish = async () => {
      if (done) return;
      done = true;
      watcher?.close();
      clearTimeout(timer);
      resolveWait(await current().catch(() => now));
    };
    const check = async () => { const next = await current().catch(() => now); if (next.hash !== since) finish(); };
    try {
      // Watch the folder: atomic writes replace the file, which a file watch would miss.
      watcher = watch(dirname(full), (_event, file) => { if (!file || file === name) void check(); });
    } catch { /* fall back to the poll below */ }
    const poll = setInterval(() => { if (done) clearInterval(poll); else void check(); }, 2000);
    const timer = setTimeout(() => { clearInterval(poll); finish(); }, waitMs);
    signal?.addEventListener("abort", () => { clearInterval(poll); finish(); });
  });
}
