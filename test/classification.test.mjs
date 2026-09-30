import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyResponseStatus, matchGroup, normalizeSubject } from "../src/classification.mjs";
import { readState, writeState } from "../src/state.mjs";
import { routingSourceMailboxes } from "../src/workflow.mjs";

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

test("routes delivery folders but never workflow or special-use folders", () => {
  const mailboxes = ["INBOX", "Additional", "Important", "Active/Research", "Pending/General", "Sent", "Archived"];
  assert.deepEqual(routingSourceMailboxes(mailboxes, {}), ["INBOX", "Additional", "Important"]);
  assert.deepEqual(routingSourceMailboxes(mailboxes, { routing_source_mailboxes: ["INBOX", "Important", "Missing"] }), ["INBOX", "Important"]);
});

test("workflow state is local and persists response records", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "mail-workflow-test-")), "state.json");
  const state = await readState(path);
  state.records["personal:<one@example.test>"] = { status: "unreplied" };
  await writeState(path, state);
  assert.equal((await readState(path)).records["personal:<one@example.test>"].status, "unreplied");
});

test("subject keywords match whole words, not fragments", () => {
  const rules = [
    { group: "IT-and-access", keywords: ["it", "hpc", "account"] },
    { group: "Meetings-and-events", keywords: ["meeting", "colloquium", "defense"] },
  ];
  // "it" used to match inside Invitation and Institute, filing most institute mail as IT.
  assert.equal(matchGroup("Invitation to Guest Lecture", rules), "General");
  assert.equal(matchGroup("Ice Cream Day at the Institute", rules), "General");
  assert.equal(matchGroup("IT ticket about your account", rules), "IT-and-access");
  assert.equal(matchGroup("[Hpc-users] Maintenance of the HPC cluster", rules), "IT-and-access");
  assert.equal(matchGroup("Cognition Colloquium Rentrée", rules), "Meetings-and-events");
  assert.equal(matchGroup("Re: Department Meeting September 7th", rules), "Meetings-and-events");
});
