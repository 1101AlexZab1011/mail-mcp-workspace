// Loom's plans. A project's plans are rows of one Notes database, <vault>/Loom/<project>/Plans, so
// they are ordinary Markdown pages: the user reads and edits them in Notes (or Obsidian), agents
// change them through Loom, and git can version the vault. A plan page is
//
//   ---
//   Status: In progress          Idea · Queued · In progress · Blocked · Done · Dropped
//   Branch: loom-plans           the branch the work is on (empty for ideas: plans outlive versions)
//   Agent: Ivy                   who works on it
//   Priority: Normal
//   Stage: Write the host routes the current step, kept up to date by Loom for Notes' table view
//   Progress: 1/3
//   Updated: 2026-11-21
//   ---
//
//   What the plan is about, any Markdown.
//
//   ## Steps
//
//   - [x] Design the data model ^s1
//   - [/] Write the host routes ^s2
//     Details of a step are indented under it; notes from agents land here too.
//   - [ ] Plans board ^s3
//
//   ## Log
//
//   - 2026-11-21 17:10 · s2 Write the host routes: running (Ivy)
//
// Step boxes: [ ] pending, [/] running, [x] done, [!] blocked, [-] skipped (the task states Obsidian
// themes already draw). Step ids are Obsidian block ids (^s2), so a step can be linked to and stays
// the same step when its text changes. Edits are made line by line, so whatever the user wrote by
// hand around the steps is kept.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { databaseFileOf, folderOf, isPage, pageText, setProperties, splitPage, titleOf } from "../notes/vault.mjs";
import { LoomError } from "./loom.mjs";

export const STATUSES = ["Idea", "Queued", "In progress", "Blocked", "Done", "Dropped"];
export const PRIORITIES = ["High", "Normal", "Low"];
export const STEP_STATES = ["pending", "running", "done", "blocked", "skipped"];
const MARK = { pending: " ", running: "/", done: "x", blocked: "!", skipped: "-" };
const STATE_OF = { " ": "pending", "/": "running", x: "done", X: "done", "!": "blocked", "-": "skipped" };

const PROPERTIES = [
  { name: "Status", type: "select", options: STATUSES },
  { name: "Stage", type: "text" },
  { name: "Progress", type: "text" },
  { name: "Branch", type: "text" },
  { name: "Agent", type: "text" },
  { name: "Priority", type: "select", options: PRIORITIES },
  { name: "Updated", type: "date" },
];

// A step: "- [/] Text ^s2" at the start of a line (editors may escape the brackets and the caret).
const STEP_LINE = /^[-*+][ \t]+\\?\[(.)\\?\][ \t]+(.*?)(?:[ \t]+\\?\^([A-Za-z][\w-]*))?[ \t]*$/;
const SECTION = /^#{1,2}[ \t]+(.+?)[ \t]*$/;

// ------------------------------------------------------------------------------- the page format --

/** Where the Steps and Log sections are, and each step's lines, in a plan body's lines. */
function layout(lines) {
  const out = { steps: null, log: null, items: [] };
  let section = null;
  let item = null;
  lines.forEach((line, i) => {
    const heading = SECTION.exec(line);
    if (heading) {
      if (section) section.end = i;
      const name = heading[1].trim().toLowerCase();
      section = name === "steps" || name === "log" ? { name, start: i, end: lines.length } : null;
      if (section && !out[name]) out[name] = section;
      else if (section) section = null; // a second Steps or Log heading is ordinary text
      item = null;
      return;
    }
    if (section?.name !== "steps") return;
    const m = STEP_LINE.exec(line);
    if (m) { item = { line: i, last: i, mark: m[1], text: m[2].trim(), id: m[3] ?? null }; out.items.push(item); return; }
    if (item && /^[ \t]+\S/.test(line)) item.last = i; // details are indented under their step
    else if (item && line.trim()) item = null;
  });
  return out;
}

/** A plan page's parts: properties, description, steps (with their details) and log lines. */
export function parsePlan(text) {
  const { data, body } = splitPage(text);
  const lines = body.split(/\r?\n/);
  const { steps, log, items } = layout(lines);
  const inside = (i, section) => section && i >= section.start && i < section.end;
  const description = lines.filter((_, i) => !inside(i, steps) && !inside(i, log)).join("\n").trim();
  return {
    properties: data,
    description,
    steps: items.map((item) => ({
      id: item.id, state: STATE_OF[item.mark] ?? "pending", text: item.text,
      details: lines.slice(item.line + 1, item.last + 1).map((l) => l.replace(/^( {1,4}|\t)/, "")).join("\n").trim(),
    })),
    log: log ? lines.slice(log.start + 1, log.end).map((l) => /^[-*][ \t]+(.*)$/.exec(l)?.[1].trim()).filter(Boolean) : [],
  };
}

/** The current stage of a plan from its steps: the running step, else a blocked one, else the next to do. */
export function stageOf(steps) {
  const counted = steps.filter((s) => s.state !== "skipped");
  const done = counted.filter((s) => s.state === "done").length;
  const current = steps.find((s) => s.state === "running") ?? steps.find((s) => s.state === "blocked") ?? steps.find((s) => s.state === "pending");
  return {
    progress: counted.length ? `${done}/${counted.length}` : "",
    stage: current ? current.text : counted.length ? "All steps done" : "",
    step: current?.id ?? null,
    blocked: steps.some((s) => s.state === "blocked"),
    finished: counted.length > 0 && done === counted.length,
  };
}

const editBody = (text, edit) => { const { front, body } = splitPage(text); return `${front}${edit(body)}`; };
const nextId = (items) => `s${Math.max(0, ...items.map((i) => Number(/^s(\d+)$/.exec(i.id ?? "")?.[1] ?? 0))) + 1}`;

/** Give every step an id (steps written by hand have none yet). */
export function ensureStepIds(text) {
  return editBody(text, (body) => {
    const lines = body.split(/\r?\n/);
    const { items } = layout(lines);
    for (const item of items) if (!item.id) { item.id = nextId(items); lines[item.line] = `${lines[item.line].replace(/[ \t]+$/, "")} ^${item.id}`; }
    return lines.join("\n");
  });
}

function findStep(items, step) {
  const want = String(step ?? "").trim();
  const found = items.find((i) => i.id === want) ?? items.find((i) => i.text.toLowerCase() === want.toLowerCase())
    ?? (/^\d+$/.test(want) ? items[Number(want) - 1] : null);
  if (!found) throw new LoomError(404, "no_step", `The plan has no step ${want}`);
  return found;
}

/** Set a step's state; `note` (any Markdown) goes under it. */
export function setStep(text, step, { state, note } = {}) {
  if (state && !STEP_STATES.includes(state)) throw new LoomError(400, "bad_request", `A step is ${STEP_STATES.join(", ")}`);
  let changed = null;
  const out = editBody(text, (body) => {
    const lines = body.split(/\r?\n/);
    const item = findStep(layout(lines).items, step);
    changed = item;
    if (state) lines[item.line] = lines[item.line].replace(/\\?\[(.)\\?\]/, `[${MARK[state]}]`);
    if (note && String(note).trim()) lines.splice(item.last + 1, 0, ...String(note).trim().split(/\r?\n/).map((l) => `  ${l}`.replace(/[ \t]+$/, "")));
    return lines.join("\n");
  });
  return { text: out, step: changed };
}

/** Add steps at the end of the Steps section (made if missing, before the Log). */
export function addSteps(text, texts) {
  const clean = texts.map((t) => String(t).replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!clean.length) throw new LoomError(400, "bad_request", "No step text");
  const added = [];
  const out = editBody(text, (body) => {
    let lines = body.replace(/\s+$/, "").split(/\r?\n/);
    let { steps, log, items } = layout(lines);
    if (!steps) {
      const at = log ? log.start : lines.length;
      const before = lines.slice(0, at);
      while (before.length && !before.at(-1).trim()) before.pop();
      lines = [...before, ...(before.length ? [""] : []), "## Steps", "", ...lines.slice(at)];
      ({ steps, items } = layout(lines));
    }
    let at = items.length ? items.at(-1).last + 1 : steps.start + 1;
    if (!items.length) { if (lines[at] !== "") lines.splice(at, 0, ""); at++; }
    const pool = [...items];
    const stepLines = clean.map((t) => { const id = nextId(pool); pool.push({ id }); added.push({ id, text: t }); return `- [ ] ${t} ^${id}`; });
    if (at < lines.length && lines[at].trim()) stepLines.push("");
    lines.splice(at, 0, ...stepLines);
    return `${lines.join("\n")}\n`;
  });
  return { text: out, added };
}

/** Append a line to the Log section (made at the end if missing). */
export function appendLog(text, entry) {
  return editBody(text, (body) => {
    const lines = body.replace(/\s+$/, "").split(/\r?\n/);
    const { log } = layout(lines);
    const line = `- ${stamp()} · ${String(entry).replace(/\s+/g, " ").trim()}`;
    if (!log) return `${lines.join("\n")}${lines.join("").trim() ? "\n\n" : ""}## Log\n\n${line}\n`;
    let at = log.end;
    while (at > log.start + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, ...(at === log.start + 1 ? [""] : []), line);
    return `${lines.join("\n")}\n`;
  });
}

/** Replace the description, keeping the Steps and Log sections. */
export function setDescription(text, description) {
  return editBody(text, (body) => {
    const lines = body.split(/\r?\n/);
    const { steps, log } = layout(lines);
    const block = (s) => (s ? lines.slice(s.start, s.end).join("\n").trim() : "");
    return `${[String(description ?? "").trim(), block(steps), block(log)].filter(Boolean).join("\n\n")}\n`;
  });
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const today = () => stamp().slice(0, 10);

/** The status a step change implies, or null to leave it. */
function statusAfter(status, steps) {
  const { blocked, finished } = stageOf(steps);
  if (finished) return status === "Dropped" ? null : "Done";
  if (blocked) return "Blocked";
  const started = steps.some((s) => s.state === "running" || s.state === "done");
  // Unblocked, started, or a finished plan with a step reopened: it is in progress again.
  if (status === "Blocked" || status === "Done" || ((status === "Idea" || status === "Queued") && started)) return "In progress";
  return null;
}

// ------------------------------------------------------------------------------------- Plans --

const cleanName = (name) => String(name).replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Project";
const by = (who) => (who ? ` (${who})` : "");

export class Plans {
  constructor({ notes, loom, files }) {
    this.notes = notes;
    this.loom = loom;
    this.files = files;
    this.queues = new Map(); // plan path → the promise of its last write (writes to one plan go one at a time)
  }

  /** The project's folder in the vault: Loom/<name>. */
  async folder(project) { return join(await this.notes.vault(), "Loom", cleanName(project.name)); }

  /** The Plans database page, made on first use. */
  async database(project) {
    const page = join(await this.folder(project), "Plans.md");
    if (await stat(databaseFileOf(page)).catch(() => null)) return page;
    await this.notes.ensureVault();
    if (!(await stat(page).catch(() => null))) {
      await this.files.write(page, { text: pageText({ properties: { icon: "🧵" }, body: `The plans for ${project.name}, kept by Loom: ideas, and exact plans with steps.\n` }), createDirs: true });
    }
    await this.notes.createDatabase({ path: page, properties: PROPERTIES });
    return page;
  }

  /** A renamed project takes its plans along. */
  async renameProject(before, after) {
    const from = await this.folder({ name: before });
    const to = await this.folder({ name: after });
    if (from === to || !(await stat(from).catch(() => null))) return;
    if (await stat(to).catch(() => null)) throw new LoomError(409, "conflict", `The vault already has ${to}`);
    await this.files.move(from, to);
  }

  async #paths(project) {
    const dir = folderOf(await this.database(project));
    return (await readdir(dir).catch(() => [])).filter(isPage).map((name) => join(dir, name));
  }

  async #resolve(project, plan) {
    // A plan is named by its title, or by its page's path.
    const key = (p) => String(p).trim().replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
    const want = key(plan ?? "");
    if (!want) throw new LoomError(400, "bad_request", "Which plan?");
    const paths = await this.#paths(project);
    const found = want.includes("/") ? paths.find((p) => key(p) === want) : paths.find((p) => titleOf(p).toLowerCase() === want);
    if (!found) throw new LoomError(404, "no_plan", `${project.name} has no plan "${plan}"`);
    return found;
  }

  #view(path, text) {
    const plan = parsePlan(text);
    const p = plan.properties;
    return {
      id: titleOf(path), title: titleOf(path), path,
      status: STATUSES.includes(p.Status) ? p.Status : "Idea",
      branch: p.Branch ? String(p.Branch) : null, agent: p.Agent ? String(p.Agent) : null,
      priority: PRIORITIES.includes(p.Priority) ? p.Priority : "Normal",
      updated: p.Updated ? String(p.Updated) : null,
      ...stageOf(plan.steps),
      description: plan.description, steps: plan.steps, log: plan.log,
    };
  }

  /** Every plan of a project, without their text; `query` keeps those whose text has every word. */
  async list(projectId, { query } = {}) {
    const project = await this.loom.project(projectId);
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const plans = [];
    for (const path of await this.#paths(project)) {
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) continue;
      if (words.length) { const haystack = `${titleOf(path)}\n${text}`.toLowerCase(); if (!words.every((w) => haystack.includes(w))) continue; }
      const { description, steps, log, ...summary } = this.#view(path, text);
      plans.push({ ...summary, steps: steps.length });
    }
    return { project: project.id, database: await this.database(project), plans };
  }

  async get(projectId, plan) {
    const project = await this.loom.project(projectId);
    const path = await this.#resolve(project, plan);
    return this.#view(path, await readFile(path, "utf8"));
  }

  /** A new plan: an idea (no steps needed) or an exact plan with steps. */
  async create(projectId, { title, status, description = "", steps = [], branch, agent, priority, by: who } = {}) {
    const project = await this.loom.project(projectId);
    const name = String(title ?? "").trim();
    if (!name) throw new LoomError(400, "bad_request", "A plan needs a title");
    const chosen = status ?? (steps.length ? "Queued" : "Idea");
    check(chosen, priority);
    let text = pageText({ body: `${String(description).trim()}\n` });
    if (steps.length) text = addSteps(text, steps).text;
    text = appendLog(text, `Created as ${chosen}${by(who)}`);
    const created = await this.notes.addRow(await this.database(project), {
      title: name,
      properties: { Status: chosen, Branch: branch || undefined, Agent: agent || undefined, Priority: priority || "Normal" },
      body: splitPage(text).body,
    });
    await this.#write(project, created.path, (current) => current, { by: who }); // fills Stage, Progress, Updated
    this.loom.emit({ project: project.id, projectName: project.name, plan: created.path, title: name, kind: "created", status: chosen, by: who ?? null });
    return this.get(projectId, created.path);
  }

  /** Change a plan's fields; a new title renames the page (links to it follow). */
  async update(projectId, plan, { title, status, branch, agent, priority, description, by: who } = {}) {
    const project = await this.loom.project(projectId);
    let path = await this.#resolve(project, plan);
    check(status, priority);
    await this.#write(project, path, (text) => {
      const p = splitPage(text).data;
      const changes = {};
      const notes = [];
      if (status !== undefined && status !== p.Status) { changes.Status = status; notes.push(`Status: ${p.Status ?? "Idea"} → ${status}`); }
      if (branch !== undefined && (branch || null) !== (p.Branch || null)) { changes.Branch = branch || null; notes.push(branch ? `Branch: ${branch}` : "Branch removed"); }
      if (agent !== undefined && (agent || null) !== (p.Agent || null)) { changes.Agent = agent || null; notes.push(agent ? `Agent: ${agent}` : "Agent removed"); }
      if (priority !== undefined && priority !== p.Priority) changes.Priority = priority;
      let out = Object.keys(changes).length ? setProperties(text, changes) : text;
      if (description !== undefined) out = setDescription(out, description);
      for (const note of notes) out = appendLog(out, `${note}${by(who)}`);
      return out;
    }, { by: who });
    const name = String(title ?? "").trim();
    if (name && name !== titleOf(path)) path = (await this.notes.rename(path, name)).path;
    this.loom.touch(project.id);
    return this.get(projectId, path);
  }

  /** Move a step (start, finish, block, skip, reopen) and/or add a note under it. */
  async step(projectId, plan, { step, state, note, by: who } = {}) {
    const project = await this.loom.project(projectId);
    const path = await this.#resolve(project, plan);
    let moved = null;
    await this.#write(project, path, (text) => {
      const result = setStep(ensureStepIds(text), step, { state, note });
      moved = result.step;
      let out = result.text;
      const before = STATE_OF[moved.mark] ?? "pending";
      if (state && state !== before) {
        out = appendLog(out, `${moved.id} ${moved.text}: ${state}${state === "blocked" && note ? ` (${String(note).split("\n")[0]})` : ""}${by(who)}`);
        const p = parsePlan(out);
        const next = statusAfter(p.properties.Status ?? "Idea", p.steps);
        if (next && next !== p.properties.Status) out = appendLog(setProperties(out, { Status: next }), `Status: ${p.properties.Status ?? "Idea"} → ${next}`);
      }
      return out;
    }, { by: who, note: state === "blocked" ? note : undefined });
    return this.get(projectId, path);
  }

  async addSteps(projectId, plan, { steps, by: who } = {}) {
    const project = await this.loom.project(projectId);
    const path = await this.#resolve(project, plan);
    await this.#write(project, path, (text) => {
      const { text: withSteps, added } = addSteps(ensureStepIds(text), Array.isArray(steps) ? steps : [steps]);
      let out = appendLog(withSteps, `${added.length === 1 ? `Step ${added[0].id} added` : `${added.length} steps added`}${by(who)}`);
      // New work on a finished plan reopens it.
      const p = parsePlan(out);
      const next = statusAfter(p.properties.Status ?? "Idea", p.steps);
      if (next && next !== p.properties.Status) out = appendLog(setProperties(out, { Status: next }), `Status: ${p.properties.Status ?? "Idea"} → ${next}`);
      return out;
    }, { by: who });
    return this.get(projectId, path);
  }

  /**
   * Read, change and write one plan, then refresh what Notes' table shows, wake the project's feed and
   * tell Loom's event log when the plan's status or stage moved (`by` who, a block's `note`).
   */
  async #write(project, path, change, { by: who, note } = {}) {
    const previous = this.queues.get(path) ?? Promise.resolve();
    let moved = null;
    const run = previous.catch(() => {}).then(async () => {
      const text = await readFile(path, "utf8").catch(() => { throw new LoomError(404, "no_plan", `${titleOf(path)} is gone`); });
      const before = this.#view(path, text);
      let out = change(text);
      const { stage, progress } = stageOf(parsePlan(out).steps);
      out = setProperties(out, { Stage: stage || null, Progress: progress || null, Updated: today() });
      if (out !== text) await this.files.write(path, { text: out });
      const after = this.#view(path, out);
      if (after.status !== before.status) moved = { kind: "status", from: before.status };
      else if (after.stage !== before.stage && after.stage) moved = { kind: "stage" };
      if (moved) Object.assign(moved, { status: after.status, stage: after.stage || null, progress: after.progress || null });
    });
    this.queues.set(path, run);
    try { await run; } finally { if (this.queues.get(path) === run) this.queues.delete(path); }
    this.loom.touch(project.id);
    if (moved) this.loom.emit({ project: project.id, projectName: project.name, plan: path, title: titleOf(path), ...moved, note: note ?? null, by: who ?? null });
  }
}

function check(status, priority) {
  if (status !== undefined && !STATUSES.includes(status)) throw new LoomError(400, "bad_request", `A plan's status is one of ${STATUSES.join(", ")}`);
  if (priority !== undefined && priority !== null && priority !== "" && !PRIORITIES.includes(priority)) throw new LoomError(400, "bad_request", `Priority is one of ${PRIORITIES.join(", ")}`);
}
