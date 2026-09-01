import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyResponseStatus, matchGroup, normalizeSubject } from "../src/classification.mjs";
import { readState, writeState } from "../src/state.mjs";

test("normalizes repeated reply prefixes", () => assert.equal(normalizeSubject("Re: Fwd:  Project update"), "project update"));
test("response status distinguishes no-reply, unreplied, and replied", () => {
  assert.equal(classifyResponseStatus({ subject: "Weekly newsletter" }).status, "no-reply");
  assert.equal(classifyResponseStatus({ subject: "Can you approve this?" }).status, "unreplied");
  assert.equal(classifyResponseStatus({ subject: "Can you approve this?", answered: true }).status, "replied");
});
test("uses first matching account rule and safe fallback", () => {
  const rules = [{ group: "Finance", keywords: ["invoice"] }, { group: "General", keywords: ["update"] }];
  assert.equal(matchGroup("Re: Invoice update", rules), "Finance");
  assert.equal(matchGroup("Hello", rules), "General");
});

test("workflow state is local and persists response records", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "mail-workflow-test-")), "state.json");
  const state = await readState(path);
  state.records["personal:<one@example.test>"] = { status: "unreplied" };
  await writeState(path, state);
  assert.equal((await readState(path)).records["personal:<one@example.test>"].status, "unreplied");
});
