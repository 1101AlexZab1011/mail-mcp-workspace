import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appDirs, commandShell, wirePaths } from "../src/platform.mjs";
import { RecycleBin, parseRecycleRecord, recycleRecord } from "../src/workspace/trash.mjs";

test("paths reach the add-on with / on Windows, file contents untouched", () => {
  const value = { path: "c:\\Users\\a\\notes.md", entries: [{ path: "C:\\Users\\a\\b" }], text: "C:\\Users\\a\\x", note: "see C:\\x", multi: "C:\\a\nb" };
  assert.deepEqual(wirePaths(value, true), { path: "C:/Users/a/notes.md", entries: [{ path: "C:/Users/a/b" }], text: "C:\\Users\\a\\x", note: "see C:\\x", multi: "C:\\a\nb" });
  assert.equal(wirePaths(value, false), value);
});

test("each system keeps the app's files in its own place", () => {
  const dirs = appDirs("mail-workspace");
  if (process.platform === "win32") assert.match(dirs.config, /AppData[\\/]Roaming[\\/]mail-workspace$/);
  else if (process.platform === "darwin") assert.match(dirs.config, /Library\/Application Support\/mail-workspace$/);
  else assert.match(dirs.config, /\.config\/mail-workspace$/);
});

test("artifact commands run in bash, or in PowerShell (encoded) on Windows", () => {
  const shell = commandShell("echo 'a b' && dir", { MAIL_WORKSPACE_EXEC_SHELL: "powershell", PATH: "" });
  assert.equal(shell.shell, "powershell");
  const encoded = shell.args[shell.args.indexOf("-EncodedCommand") + 1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "echo 'a b' && dir");
  assert.deepEqual(commandShell("ls", { MAIL_WORKSPACE_EXEC_SHELL: "bash" }), { shell: "bash", file: "bash", args: ["-lc", "ls"] });
});

test("a Recycle Bin record says where an item came from and when", () => {
  const when = new Date("2026-11-11T10:20:30.000Z");
  const record = recycleRecord("C:\\Users\\a\\Документы\\report.docx", 12345, when);
  assert.deepEqual(parseRecycleRecord(record), { path: "C:\\Users\\a\\Документы\\report.docx", deleted: when, size: 12345 });
});

test("the Recycle Bin takes an item and gives it back", { skip: process.platform !== "win32" && "Windows only" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mw-recycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "note.txt");
  await writeFile(file, "keep me");
  const bin = new RecycleBin();
  const name = await bin.put(file);
  assert.equal(await stat(file).catch(() => null), null);
  const entry = await bin.entry(name);
  assert.equal(entry.path.toLowerCase(), file.toLowerCase());
  assert.ok((await bin.list()).some((item) => item.name === name));
  const { rename } = await import("node:fs/promises");
  await rename(entry.location, file);
  await bin.forget(name);
  assert.equal(await readFile(file, "utf8"), "keep me");
});
