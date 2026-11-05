import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The Browser's history logic is a plain script the Experiment loads into its scope.
const source = await readFile(new URL("../thunderbird-addon/experiments/workspace/webhistory.js", import.meta.url), "utf8");
const scope = vm.createContext({});
vm.runInContext(source, scope);
const plain = (value) => JSON.parse(JSON.stringify(value));
const visit = (list, url, time, title = "") => scope.addHistoryVisit(list, { url, title, time });

test("a visit goes to the top, and a revisit moves the page up instead of repeating it", () => {
  let list = [];
  list = visit(list, "https://a.example/", 1, "A");
  list = visit(list, "https://b.example/", 2, "B");
  list = visit(list, "https://a.example/", 3);
  assert.deepEqual(plain(list), [{ url: "https://a.example/", title: "A", time: 3 }, { url: "https://b.example/", title: "B", time: 2 }]);
});

test("blank and internal pages are not recorded", () => {
  assert.deepEqual(plain(visit([], "about:blank", 1)), []);
  assert.deepEqual(plain(visit([], "view-source:https://a.example/", 1)), []);
  assert.equal(visit([], "file:///home/u/x.html", 1).length, 1);
});

test("the list is capped: the oldest entries drop off", () => {
  let list = [];
  for (let i = 0; i < 12; i++) list = scope.addHistoryVisit(list, { url: `https://e.example/${i}`, time: i }, 10);
  assert.equal(list.length, 10);
  assert.equal(list[0].url, "https://e.example/11");
  assert.equal(list.at(-1).url, "https://e.example/2");
});

test("a title that arrives later is kept", () => {
  const list = scope.setHistoryTitle(visit([], "https://a.example/", 1), "https://a.example/", "Alpha");
  assert.equal(list[0].title, "Alpha");
  assert.equal(scope.setHistoryTitle(list, "https://nope.example/", "X"), list);
});

test("search matches every word in the title or the address", () => {
  let list = [];
  list = visit(list, "https://www.elster.de/eportal/start", 1, "Mein ELSTER");
  list = visit(list, "https://store.steampowered.com/", 2, "Steam Store");
  assert.deepEqual(plain(scope.searchHistory(list, "elster eportal")).map((e) => e.title), ["Mein ELSTER"]);
  assert.deepEqual(plain(scope.searchHistory(list, "STEAM")).map((e) => e.title), ["Steam Store"]);
  assert.equal(scope.searchHistory(list, "").length, 2);
});

test("a stored list is read back clean", () => {
  const list = scope.parseHistory([{ url: "https://a.example/", title: "A", time: 5 }, { url: "https://a.example/", time: 4 }, { url: "javascript:x" }, null, { url: "https://b.example/", title: 3 }]);
  assert.deepEqual(plain(list), [{ url: "https://a.example/", title: "A", time: 5 }, { url: "https://b.example/", title: "", time: 0 }]);
  assert.deepEqual(plain(scope.parseHistory("nope")), []);
});
