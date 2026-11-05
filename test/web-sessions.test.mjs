import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The Browser's session list is a plain script the Experiment loads into its scope.
const source = await readFile(new URL("../thunderbird-addon/experiments/workspace/websessions.js", import.meta.url), "utf8");
const scope = vm.createContext({});
vm.runInContext(source, scope);
const plain = (value) => JSON.parse(JSON.stringify(value));
const parse = (text) => plain(scope.parseWebSessions(text));

test("the stored list is read back, and the last session defaults to the first", () => {
  const text = scope.serializeWebSessions({ sessions: [{ id: "a1", name: "Main", userContextId: 7 }, { id: "b2", name: "ELSTER", userContextId: 8 }], last: "b2" });
  assert.deepEqual(parse(text), { sessions: [{ id: "a1", name: "Main", userContextId: 7 }, { id: "b2", name: "ELSTER", userContextId: 8 }], last: "b2" });
  assert.equal(parse(JSON.stringify({ sessions: [{ id: "a1", name: "Main", userContextId: 7 }], last: "gone" })).last, "a1");
});

test("nothing stored, or garbage, is no sessions", () => {
  assert.deepEqual(parse(""), { sessions: [], last: null });
  assert.deepEqual(parse("{oops"), { sessions: [], last: null });
  assert.deepEqual(parse('{"sessions": 3}'), { sessions: [], last: null });
});

test("malformed sessions, Thunderbird's own container and duplicates are dropped", () => {
  const { sessions } = parse(JSON.stringify({ sessions: [
    { id: "a1", name: "Main", userContextId: 0 },
    { id: "", name: "X", userContextId: 5 },
    { id: "b2", name: " Work ", userContextId: "6" },
    { id: "b2", name: "Again", userContextId: 9 },
    { id: "c3", name: "Same box", userContextId: 6 },
  ] }));
  assert.deepEqual(sessions, [{ id: "b2", name: "Work", userContextId: 6 }]);
});

test("a session is found by id or by name, ignoring case", () => {
  const sessions = [{ id: "a1", name: "Main", userContextId: 7 }, { id: "b2", name: "ELSTER", userContextId: 8 }];
  assert.equal(scope.findWebSession(sessions, "b2").name, "ELSTER");
  assert.equal(scope.findWebSession(sessions, "elster").id, "b2");
  assert.equal(scope.findWebSession(sessions, "nope"), null);
  assert.equal(scope.findWebSession(sessions, ""), null);
});

test("new sessions are named Session N with a free number", () => {
  assert.equal(scope.webSessionName([]), "Session 1");
  assert.equal(scope.webSessionName([{ name: "Main" }]), "Session 2");
  assert.equal(scope.webSessionName([{ name: "Main" }, { name: "session 3" }]), "Session 4");
});

test("session ids are six characters and unused", () => {
  let n = 0;
  const sequence = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  const id = scope.newWebSessionId([{ id: "aaaaaa" }], () => sequence[n++ % sequence.length]);
  assert.equal(id, "ssssss");
  assert.match(scope.newWebSessionId([]), /^[a-z0-9]{6}$/);
});
