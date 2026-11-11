import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The Browser's Firefox shortcuts are a plain script the Experiment loads into its scope.
const source = await readFile(new URL("../thunderbird-addon/experiments/workspace/shortcuts.js", import.meta.url), "utf8");
const scope = vm.createContext({});
vm.runInContext(source, scope);
const press = (event) => JSON.parse(JSON.stringify(scope.webShortcut(event)));
const command = (event) => press(event)?.command ?? null;
const letter = (l, mods = {}) => ({ key: l.toLowerCase(), code: `Key${l}`, ...mods });

test("address bar, tabs and navigation as in Firefox on Linux", () => {
  assert.equal(command(letter("L", { ctrlKey: true })), "address");
  assert.equal(command(letter("D", { altKey: true })), "address");
  assert.equal(command({ key: "F6" }), "address");
  assert.equal(command(letter("T", { ctrlKey: true })), "new-tab");
  assert.equal(command(letter("T", { ctrlKey: true, shiftKey: true })), "reopen-tab");
  assert.equal(command(letter("W", { ctrlKey: true })), "close-tab");
  assert.equal(command({ key: "Tab", code: "Tab", ctrlKey: true }), "next-tab");
  assert.equal(command({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }), "previous-tab");
  assert.equal(command({ key: "PageUp", code: "PageUp", ctrlKey: true }), "previous-tab");
  assert.equal(command({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }), "back");
  assert.equal(command({ key: "ArrowRight", code: "ArrowRight", altKey: true }), "forward");
  assert.equal(command({ key: "Home", code: "Home", altKey: true }), "home");
});

test("Alt+1…8 pick a tab and Alt+9 the last", () => {
  assert.deepEqual(press({ key: "1", code: "Digit1", altKey: true }), { command: "tab", index: 0 });
  assert.deepEqual(press({ key: "8", code: "Digit8", altKey: true }), { command: "tab", index: 7 });
  assert.deepEqual(press({ key: "9", code: "Digit9", altKey: true }), { command: "tab", index: -1 });
  // Ctrl+1…9 stay Thunderbird's space shortcuts.
  assert.equal(press({ key: "1", code: "Digit1", ctrlKey: true }), null);
});

test("reload, find, print and view source", () => {
  assert.equal(command(letter("R", { ctrlKey: true })), "reload");
  assert.equal(command({ key: "F5" }), "reload");
  assert.equal(command(letter("R", { ctrlKey: true, shiftKey: true })), "hard-reload");
  assert.equal(command({ key: "F5", ctrlKey: true }), "hard-reload");
  assert.equal(command(letter("F", { ctrlKey: true })), "find");
  assert.equal(command({ key: "F3" }), "find-next");
  assert.equal(command({ key: "F3", shiftKey: true }), "find-previous");
  assert.equal(command(letter("G", { ctrlKey: true, shiftKey: true })), "find-previous");
  assert.equal(command(letter("P", { ctrlKey: true })), "print");
  assert.equal(command(letter("U", { ctrlKey: true })), "view-source");
  assert.equal(command({ key: "Escape" }), "stop");
});

test("save page, history and downloads", () => {
  assert.equal(command(letter("S", { ctrlKey: true })), "save-page");
  assert.equal(command(letter("H", { ctrlKey: true })), "history");
  assert.equal(command(letter("Y", { ctrlKey: true, shiftKey: true })), "downloads");
});

test("the keyboard layout does not matter: letters go by their key position", () => {
  assert.equal(command({ key: "е", code: "KeyT", ctrlKey: true }), "new-tab");
});

test("other keys are left to the page and to Thunderbird", () => {
  assert.equal(press(letter("A", { ctrlKey: true })), null);
  assert.equal(press({ key: "a", code: "KeyA" }), null);
  assert.equal(press(letter("L", { ctrlKey: true, altKey: true })), null);
  assert.equal(press(letter("L", { metaKey: true, ctrlKey: true })), null);
});

test("on macOS, ⌘ does what Ctrl does, and hints say so", () => {
  const mac = (event) => scope.webShortcut(event, true)?.command ?? null;
  assert.equal(mac(letter("L", { metaKey: true })), "address");
  assert.equal(mac(letter("T", { metaKey: true, shiftKey: true })), "reopen-tab");
  assert.equal(mac({ key: "[", code: "BracketLeft", metaKey: true }), "back");
  assert.equal(mac(letter("U", { metaKey: true, altKey: true })), "view-source");
  assert.equal(mac(letter("L", { ctrlKey: true })), null, "Ctrl+L is not the address bar on macOS");
  assert.equal(mac({ key: "1", code: "Digit1", metaKey: true }), null, "⌘1… stay Thunderbird's");
  assert.equal(scope.keyHint("Writer (Ctrl+Shift+6)", true), "Writer (⇧⌘6)");
  assert.equal(scope.keyHint("Hide terminal (Ctrl+`)", true), "Hide terminal (Ctrl+`)");
  assert.equal(scope.keyHint("Writer (Ctrl+Shift+6)", false), "Writer (Ctrl+Shift+6)");
  assert.equal(scope.accelKey({ metaKey: true, ctrlKey: false }, true), true);
  assert.equal(scope.accelKey({ metaKey: true, ctrlKey: false }, false), false);
});
