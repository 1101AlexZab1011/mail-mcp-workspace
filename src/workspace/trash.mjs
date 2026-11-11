// The system Trash, so whatever the workspace deletes can be restored from the
// workspace and from the system's own file manager:
//
//   Linux    the freedesktop Trash: files/<name> plus info/<name>.trashinfo
//   Windows  the Recycle Bin: $R<id><ext> (the item) plus $I<id><ext> (where it was)
//   macOS    ~/.Trash, through the system's trash call; where each item came
//            from is recorded here, since the Finder keeps its own record private
//
// Each bin puts items in, says where an item came from and where it is now, lists
// items newest first, and forgets an item once it has been moved back.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse } from "node:path";
import { promisify } from "node:util";
import { appDirs, isMac, isWindows } from "../platform.mjs";

const run = promisify(execFile);
const notFound = (name) => Object.assign(new Error(`No trash entry ${name}`), { status: 404, code: "not_found" });

/** The bin for this system; `dir` asks for a freedesktop Trash in that folder (tests, other roots). */
export function systemTrash(dir) {
  if (dir) return new FreedesktopTrash(dir);
  if (isWindows) return new RecycleBin();
  if (isMac) return new MacTrash();
  return new FreedesktopTrash(join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "Trash"));
}

// ---- freedesktop -----------------------------------------------------------

export class FreedesktopTrash {
  constructor(dir) { this.dir = dir; }

  async put(full) {
    const files = join(this.dir, "files");
    const info = join(this.dir, "info");
    await mkdir(files, { recursive: true, mode: 0o700 });
    await mkdir(info, { recursive: true, mode: 0o700 });
    const name = await uniqueName(files, basename(full));
    const record = `[Trash Info]\nPath=${encodePath(full)}\nDeletionDate=${localIso(new Date())}\n`;
    // Claim the name with the .trashinfo first (O_EXCL), as the spec requires.
    const handle = await open(join(info, `${name}.trashinfo`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(record); } finally { await handle.close(); }
    try { await moveAcross(full, join(files, name)); } catch (error) { await rm(join(info, `${name}.trashinfo`), { force: true }); throw error; }
    return name;
  }

  async entry(name) {
    const record = await readFile(join(this.dir, "info", `${name}.trashinfo`), "utf8").catch(() => { throw notFound(name); });
    return { path: decodeURIComponent(/^Path=(.*)$/m.exec(record)?.[1] ?? ""), location: join(this.dir, "files", name) };
  }

  async forget(name) { await rm(join(this.dir, "info", `${name}.trashinfo`), { force: true }); }

  async list() {
    const info = join(this.dir, "info");
    const out = [];
    for (const file of (await readdir(info).catch(() => [])).filter((n) => n.endsWith(".trashinfo"))) {
      const record = await readFile(join(info, file), "utf8").catch(() => "");
      out.push({ name: file.slice(0, -".trashinfo".length), path: decodeURIComponent(/^Path=(.*)$/m.exec(record)?.[1] ?? ""), deleted: /^DeletionDate=(.*)$/m.exec(record)?.[1] ?? "" });
    }
    return out;
  }
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

/** rename, or copy and delete when the bin is on another file system. */
async function moveAcross(from, to) {
  try { await rename(from, to); } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true });
  }
}

// ---- Windows ---------------------------------------------------------------

const FILETIME_EPOCH = 11644473600000n; // ms from 1601-01-01 to 1970-01-01

/** A Recycle Bin record ($I file, format 2: Windows 10 and later). */
export function recycleRecord(path, size, date = new Date()) {
  const name = Buffer.from(`${path}\0`, "utf16le");
  const head = Buffer.alloc(28);
  head.writeBigInt64LE(2n, 0);
  head.writeBigInt64LE(BigInt(size), 8);
  head.writeBigInt64LE((BigInt(date.getTime()) + FILETIME_EPOCH) * 10000n, 16);
  head.writeInt32LE(name.length / 2, 24);
  return Buffer.concat([head, name]);
}

export function parseRecycleRecord(bytes) {
  const version = bytes.readBigInt64LE(0);
  const deleted = new Date(Number(bytes.readBigInt64LE(16) / 10000n - FILETIME_EPOCH));
  // Format 1 (Windows Vista to 8.1) has a fixed 260-character path after the header.
  const path = version === 2n ? bytes.subarray(28, 28 + bytes.readInt32LE(24) * 2) : bytes.subarray(24, 24 + 520);
  return { path: path.toString("utf16le").replace(/\0.*$/s, ""), deleted, size: Number(bytes.readBigInt64LE(8)) };
}

export class RecycleBin {
  constructor({ drive = (process.env.SystemDrive ?? "C:"), sid } = {}) {
    this.drive = parse(homedir()).root || `${drive}\\`;
    this.sid = sid ?? null;
  }

  async #dir() {
    if (!this.sid) {
      // System32's whoami: Git for Windows puts a Unix whoami earlier on PATH.
      const { stdout } = await run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
      this.sid = /"(S-1-[\d-]+)"/.exec(stdout)?.[1];
      if (!this.sid) throw new Error("Could not find this user's Recycle Bin");
    }
    return join(this.drive, "$Recycle.Bin", this.sid);
  }

  async put(full) {
    const dir = await this.#dir();
    // The bin folder appears the first time the system recycles something on this drive.
    if (!(await stat(dir).catch(() => null))) await recycleByShell(full);
    else {
      const info = await lstat(full);
      for (;;) {
        const id = Array.from({ length: 6 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 36)]).join("");
        const suffix = `${id}${info.isDirectory() ? "" : extname(full)}`;
        const record = join(dir, `$I${suffix}`);
        let handle;
        try { handle = await open(record, "wx"); } catch (error) { if (error.code === "EEXIST") continue; throw error; }
        try { await handle.writeFile(recycleRecord(full, info.isDirectory() ? 0 : info.size)); } finally { await handle.close(); }
        try { await rename(full, join(dir, `$R${suffix}`)); } catch (error) { await rm(record, { force: true }); throw error; }
        return `$R${suffix}`;
      }
    }
    const newest = (await this.list()).filter((item) => item.path.toLowerCase() === full.toLowerCase()).sort((a, b) => b.deleted.localeCompare(a.deleted))[0];
    if (!newest) throw new Error(`${full} was not found in the Recycle Bin after deleting it`);
    return newest.name;
  }

  async entry(name) {
    if (!/^\$R[^\\/]+$/.test(name)) throw notFound(name);
    const dir = await this.#dir();
    const bytes = await readFile(join(dir, `$I${name.slice(2)}`)).catch(() => { throw notFound(name); });
    return { path: parseRecycleRecord(bytes).path, location: join(dir, name) };
  }

  async forget(name) { await rm(join(await this.#dir(), `$I${name.slice(2)}`), { force: true }); }

  async list() {
    const dir = await this.#dir();
    const out = [];
    for (const file of (await readdir(dir).catch(() => [])).filter((n) => n.startsWith("$I"))) {
      const bytes = await readFile(join(dir, file)).catch(() => null);
      if (!bytes || bytes.length < 28) continue;
      const record = parseRecycleRecord(bytes);
      out.push({ name: `$R${file.slice(2)}`, path: record.path, deleted: record.deleted.toISOString() });
    }
    return out;
  }
}

/** Recycle through the shell (it creates the bin folder on first use). */
async function recycleByShell(full) {
  const quoted = `'${full.replace(/'/g, "''")}'`;
  const script = [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `if (Test-Path -LiteralPath ${quoted} -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${quoted}, 'OnlyErrorDialogs', 'SendToRecycleBin') }`,
    `else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${quoted}, 'OnlyErrorDialogs', 'SendToRecycleBin') }`,
  ].join("\n");
  await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
}

// ---- macOS -----------------------------------------------------------------

// NSFileManager's trashItemAtURL, as the Finder does it (no automation permission needed).
const MAC_TRASH = `ObjC.import("Foundation");
function run(argv) {
  const out = Ref(), error = Ref();
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), out, error)) throw new Error(error[0].localizedDescription.js);
  return out[0].path.js;
}`;

export class MacTrash {
  constructor({ index = join(appDirs("mail-workspace").state, "trash.json") } = {}) { this.index = index; }

  async #read() { try { return JSON.parse(await readFile(this.index, "utf8")); } catch { return []; } }
  async #write(entries) {
    await mkdir(dirname(this.index), { recursive: true, mode: 0o700 });
    await writeFile(this.index, `${JSON.stringify(entries.slice(-500), null, 2)}\n`, { mode: 0o600 });
  }

  async put(full) {
    const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", MAC_TRASH, full]);
    const location = stdout.trim();
    const entries = (await this.#read()).filter((entry) => entry.location !== location);
    entries.push({ name: basename(location), path: full, location, deleted: new Date().toISOString() });
    await this.#write(entries);
    return basename(location);
  }

  async entry(name) {
    const found = (await this.#read()).findLast((entry) => entry.name === name);
    if (!found) throw notFound(name);
    return { path: found.path, location: found.location };
  }

  async forget(name) { await this.#write((await this.#read()).filter((entry) => entry.name !== name)); }

  async list() { return (await this.#read()).map(({ name, path, deleted }) => ({ name, path, deleted })); }
}
