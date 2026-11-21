import assert from "node:assert/strict";
import test from "node:test";
import { loomNotice } from "../thunderbird-addon/background/loom-notify.js";

const base = { project: "thoth-1a2b3c", projectName: "Thoth", plan: "/v/Loom/Thoth/Plans/Offline.md", title: "Offline", by: "Ivy" };

test("Loom announces what agents do: blocks, finished plans and answers by default; every move on 'all'", () => {
  const blocked = { ...base, kind: "status", from: "In progress", status: "Blocked", stage: "Sync", note: "Which conflict rule?" };
  assert.deepEqual(loomNotice(blocked, "important"), { title: "Offline is blocked", message: "Thoth · Sync\nIvy: Which conflict rule?" });
  assert.equal(loomNotice({ ...base, kind: "status", from: "In progress", status: "Done", progress: "3/3" }, "important").title, "Offline is done");
  const answer = { ...base, plan: null, kind: "answer", question: "Last write wins?", answer: "Per field." };
  assert.deepEqual(loomNotice(answer, "important"), { title: "Ivy answered", message: "Thoth · Offline\nLast write wins?\n→ Per field." });

  const stage = { ...base, kind: "stage", status: "In progress", stage: "Sync", progress: "1/3" };
  assert.equal(loomNotice(stage, "important"), null, "a new stage only on 'all'");
  assert.deepEqual(loomNotice(stage, "all"), { title: "Offline: 1/3", message: "Thoth · now: Sync · Ivy" });
  assert.equal(loomNotice({ ...base, kind: "status", from: "Queued", status: "In progress" }, "all").message, "Thoth · Queued → In progress · Ivy");

  assert.equal(loomNotice(blocked, "off"), null);
  assert.equal(loomNotice({ ...blocked, by: null }, "all"), null, "the user's own changes are not announced back");
});
