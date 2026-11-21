import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { FileWriter } from "../src/workspace/writes.mjs";
import { Git } from "../src/workspace/git.mjs";
import { Loom } from "../src/workspace/loom.mjs";
import { Notes } from "../src/workspace/notes.mjs";
import { Plans, addSteps, appendLog, ensureStepIds, parsePlan, setDescription, setStep, stageOf } from "../src/workspace/plans.mjs";

const exec = promisify(execFile);
const ENV = { GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.org", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.org", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
const sh = (cwd, ...args) => exec("git", args, { cwd, env: { ...process.env, ...ENV }, windowsHide: true }).then((r) => r.stdout.trim());

const PAGE = `---
Status: In progress
Branch: loom-plans
---

Plans live in the vault.

## Steps

- [x] Design the data model ^s1
- [/] Write the host routes ^s2
  Routes under /v1/loom.
  - one more detail
- [ ] Plans board
- [!] Ask about colours ^s7

## Log

- 2026-11-21 10:00 · Created as Queued
`;

test("a plan page: properties, description, steps with details, log", () => {
  const plan = parsePlan(PAGE);
  assert.equal(plan.properties.Branch, "loom-plans");
  assert.equal(plan.description, "Plans live in the vault.");
  assert.deepEqual(plan.steps.map((s) => [s.id, s.state, s.text]), [
    ["s1", "done", "Design the data model"], ["s2", "running", "Write the host routes"], [null, "pending", "Plans board"], ["s7", "blocked", "Ask about colours"]]);
  assert.equal(plan.steps[1].details, "Routes under /v1/loom.\n- one more detail");
  assert.deepEqual(plan.log, ["2026-11-21 10:00 · Created as Queued"]);
  assert.deepEqual(stageOf(plan.steps), { progress: "1/4", stage: "Write the host routes", step: "s2", blocked: true, finished: false });
  // Brackets and carets escaped by an editor still read as steps.
  assert.deepEqual(parsePlan("## Steps\n\n- \\[x\\] Done \\^s3\n").steps.map((s) => [s.id, s.state]), [["s3", "done"]]);
});

test("plan edits change only their lines", () => {
  const ids = ensureStepIds(PAGE);
  assert.match(ids, /- \[ \] Plans board \^s8\n/, "a step without an id gets the next free one");
  assert.equal(ids.replace(" ^s8", ""), PAGE, "nothing else moves");

  const { text, step } = setStep(ids, "s8", { state: "running", note: "Started on the board.\nColumns first." });
  assert.equal(step.text, "Plans board");
  assert.match(text, /- \[\/\] Plans board \^s8\n {2}Started on the board\.\n {2}Columns first\.\n- \[!\] Ask/);
  assert.equal(setStep(ids, "Ask about colours", { state: "done" }).text.includes("- [x] Ask about colours ^s7"), true, "a step can be named by its text");
  assert.equal(setStep(ids, "2", { state: "done" }).text.includes("- [x] Write the host routes ^s2"), true, "or by its number");
  assert.throws(() => setStep(ids, "s99", { state: "done" }), { code: "no_step" });
  assert.throws(() => setStep(ids, "s1", { state: "maybe" }), { code: "bad_request" });

  const more = addSteps(ids, ["Graph chips", "  Tests  "]);
  assert.deepEqual(more.added, [{ id: "s9", text: "Graph chips" }, { id: "s10", text: "Tests" }]);
  assert.match(more.text, /- \[!\] Ask about colours \^s7\n- \[ \] Graph chips \^s9\n- \[ \] Tests \^s10\n\n## Log/);

  const fresh = addSteps("---\nStatus: Idea\n---\n\nJust an idea.\n", ["First"]).text;
  assert.equal(fresh, "---\nStatus: Idea\n---\n\nJust an idea.\n\n## Steps\n\n- [ ] First ^s1\n");
  const beforeLog = addSteps("Idea.\n\n## Log\n\n- x\n", ["First"]).text;
  assert.equal(beforeLog, "Idea.\n\n## Steps\n\n- [ ] First ^s1\n\n## Log\n\n- x\n");

  const logged = appendLog("Idea.\n", "Created");
  assert.match(logged, /^Idea\.\n\n## Log\n\n- \d{4}-\d\d-\d\d \d\d:\d\d · Created\n$/);
  assert.match(appendLog(PAGE, "Again"), /Created as Queued\n- [\d :-]+ · Again\n$/);

  const described = setDescription(PAGE, "A new description.");
  assert.equal(parsePlan(described).description, "A new description.");
  assert.equal(parsePlan(described).steps.length, 4);
  assert.deepEqual(parsePlan(described).log, parsePlan(PAGE).log);
});

async function setup(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mw-plans-")));
  const files = new FileWriter({ root: home, trashDir: join(home, ".trash") });
  const configDir = join(home, ".config/thoth");
  const loom = new Loom({ git: new Git({ files, env: ENV }), configDir });
  const notes = new Notes({ files, configDir });
  await notes.setVault(join(home, "Notes"));
  const plans = new Plans({ notes, loom, files });
  t.after(async () => { loom.close(); await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });
  const repo = join(home, "Code", "Thoth");
  await mkdir(repo, { recursive: true });
  await sh(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "one\n");
  await sh(repo, "add", "a.txt");
  await sh(repo, "commit", "-q", "-m", "First");
  const project = await loom.addProject({ path: repo });
  return { home, notes, plans, loom, project };
}

test("plans: a Notes database per project; ideas, plans with steps, stages and the log", async (t) => {
  const { home, notes, plans, loom, project } = await setup(t);
  assert.deepEqual((await plans.list(project.id)).plans, []);
  const database = join(home, "Notes", "Loom", "Thoth", "Plans.md");
  const db = await notes.database(database);
  assert.deepEqual(db.schema.properties.map((p) => p.name), ["Status", "Stage", "Progress", "Branch", "Agent", "Priority", "Updated"]);
  assert.equal(db.schema.views.find((v) => v.type === "board").groupBy, "Status");

  const idea = await plans.create(project.id, { title: "Offline mode", description: "Someday: work without the host." });
  assert.equal(idea.status, "Idea", "a plan without steps starts as an idea");
  assert.equal(idea.branch, null);

  const plan = await plans.create(project.id, { title: "Plans board", steps: ["Data model", "Routes", "Board"], branch: "loom-plans", agent: "Ivy", by: "Ivy" });
  assert.equal(plan.status, "Queued", "a plan with steps starts queued");
  assert.deepEqual(plan.steps.map((s) => s.id), ["s1", "s2", "s3"]);
  assert.equal(plan.progress, "0/3");
  assert.equal(plan.stage, "Data model");
  const page = await readFile(plan.path, "utf8");
  assert.match(page, /^---\n(.*\n)*Status: Queued\n/);
  assert.match(page, /Stage: Data model\n/, "Notes' table sees the stage");
  assert.match(page, /· Created as Queued \(Ivy\)\n/);

  // Steps move the plan: running starts it, blocked blocks it, the last one done finishes it.
  let now = await plans.step(project.id, "Plans board", { step: "s1", state: "running", by: "Ivy" });
  assert.equal(now.status, "In progress");
  now = await plans.step(project.id, "plans board", { step: "s1", state: "done" });
  now = await plans.step(project.id, plan.path, { step: "s2", state: "blocked", note: "Which port?", by: "Ivy" });
  assert.equal(now.status, "Blocked");
  assert.equal(now.stage, "Routes");
  assert.equal(now.steps[1].details, "Which port?");
  now = await plans.step(project.id, "Plans board", { step: "s2", state: "running" });
  assert.equal(now.status, "In progress", "unblocked");
  now = await plans.addSteps(project.id, "Plans board", { steps: ["Chips on the graph"] });
  assert.equal(now.progress, "1/4");
  for (const step of ["s2", "s3"]) await plans.step(project.id, "Plans board", { step, state: "done" });
  now = await plans.step(project.id, "Plans board", { step: "s4", state: "skipped" });
  assert.equal(now.status, "Done");
  assert.equal(now.stage, "All steps done");
  assert.ok(now.log.some((l) => /s2 Routes: blocked \(Which port\?\) \(Ivy\)/.test(l)));
  assert.ok(now.log.some((l) => /Status: In progress → Done/.test(l)));

  // Fields, and a new title renames the page.
  const moved = await plans.update(project.id, "Offline mode", { status: "Queued", branch: "offline", priority: "High", title: "Offline first", description: "Work without the host." });
  assert.equal(moved.title, "Offline first");
  assert.equal(moved.branch, "offline");
  assert.equal(moved.priority, "High");
  assert.equal(moved.description, "Work without the host.");
  assert.ok(moved.log.some((l) => /Status: Idea → Queued/.test(l)));
  await assert.rejects(plans.update(project.id, "Offline first", { status: "Maybe" }), { code: "bad_request" });
  await assert.rejects(plans.get(project.id, "Nothing"), { code: "no_plan" });

  const listed = (await plans.list(project.id)).plans;
  assert.deepEqual(listed.map((p) => [p.title, p.status, p.steps]).sort(), [["Offline first", "Queued", 0], ["Plans board", "Done", 4]]);
  assert.equal("description" in listed[0], false, "the list leaves the text out");

  // Searching the plans' text.
  assert.deepEqual((await plans.list(project.id, { query: "host" })).plans.map((p) => p.title), ["Offline first"], "words in the description");
  assert.deepEqual((await plans.list(project.id, { query: "which PORT" })).plans.map((p) => p.title), ["Plans board"], "a step's note, any case");
  assert.deepEqual((await plans.list(project.id, { query: "port host" })).plans, [], "every word must match");

  // The event log: statuses and stages that moved, signed by who moved them.
  const events = (await loom.eventsSince({ since: 0 })).events;
  assert.deepEqual(events.filter((e) => e.title === "Plans board").map((e) => [e.kind, e.status, e.by]).slice(0, 4), [
    ["created", "Queued", "Ivy"], ["status", "In progress", "Ivy"], ["stage", "In progress", null], ["status", "Blocked", "Ivy"]]);
  const blocked = events.find((e) => e.status === "Blocked");
  assert.equal(blocked.note, "Which port?");
  assert.equal(blocked.stage, "Routes");
  const { seq, epoch } = await loom.eventsSince({ since: 0 });
  const waiting = loom.eventsSince({ since: seq, epoch, wait: 5000 });
  await plans.step(project.id, "Plans board", { step: "s1", state: "running", by: "Kai" });
  assert.deepEqual((await waiting).events.map((e) => [e.kind, e.status, e.by]), [["status", "In progress", "Kai"]], "a waiting reader wakes");
  assert.deepEqual(await loom.eventsSince({ since: 3, epoch: "old" }).then((r) => r.events), [], "a reader from another host run starts over");
  await plans.step(project.id, "Plans board", { step: "s1", state: "done" });
  assert.equal((await plans.get(project.id, "Plans board")).status, "Done");
  assert.equal((await plans.addSteps(project.id, "Plans board", { steps: ["Polish"] })).status, "In progress", "new work reopens a finished plan");

  // Writes wake the project's feed.
  const { version } = await loom.changes(project.id);
  await plans.update(project.id, "Plans board", { agent: "Kai" });
  assert.ok((await loom.changes(project.id)).version > version);

  // A renamed project takes its plans along.
  await loom.renameProject(project.id, "Thoth app");
  await plans.renameProject("Thoth", "Thoth app");
  assert.equal((await plans.list(project.id)).plans.length, 2);
  assert.ok((await plans.list(project.id)).database.endsWith(join("Loom", "Thoth app", "Plans.md")));
});
