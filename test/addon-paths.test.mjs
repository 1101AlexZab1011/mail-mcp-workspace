import assert from "node:assert/strict";
import test from "node:test";
import { dirOf, isAbsolutePath, nameOf, resolvePath, rootOf, tildePath } from "../thunderbird-addon/shared/paths.js";

test("the add-on's paths work for Linux, macOS and Windows paths", () => {
  assert.equal(nameOf("/home/a/notes.md"), "notes.md");
  assert.equal(nameOf("C:/Users/a/notes.md"), "notes.md");
  assert.equal(nameOf("C:\\Users\\a\\notes.md"), "notes.md");
  assert.equal(nameOf("/home/a/folder/"), "folder");
  assert.equal(dirOf("/home/a/notes.md"), "/home/a");
  assert.equal(dirOf("/notes.md"), "/");
  assert.equal(dirOf("/"), "/");
  assert.equal(dirOf("C:/Users/a/notes.md"), "C:/Users/a");
  assert.equal(dirOf("C:/notes.md"), "C:/");
  assert.equal(dirOf("C:\\Users\\a.txt"), "C:/Users");
  assert.equal(dirOf("//server/share/x/y.txt"), "//server/share/x");
  assert.equal(rootOf("c:/x"), "c:/");
  assert.ok(isAbsolutePath("/x") && isAbsolutePath("D:\\x") && !isAbsolutePath("x/y") && !isAbsolutePath("~/x"));
  assert.equal(resolvePath("C:/deck", "./img/a.png"), "C:/deck/img/a.png");
  assert.equal(resolvePath("C:/deck", "D:/a.png"), "D:/a.png");
  assert.equal(resolvePath("/deck", "~/a.png"), "~/a.png");
  assert.equal(tildePath("/home/alex/Projects"), "~/Projects");
  assert.equal(tildePath("/Users/alex/Projects"), "~/Projects");
  assert.equal(tildePath("C:/Users/alex/Projects"), "~/Projects");
  assert.equal(tildePath("/opt/x"), "/opt/x");
});
