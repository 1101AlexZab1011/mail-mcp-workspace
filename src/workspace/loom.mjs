// Loom, the project screen's own state: the projects the user added (a git repository each) and a
// change feed per project, so the screen redraws when anything happens in the repository, whoever
// did it: Loom's buttons, an agent's git commands in a terminal, a commit from an editor. The feed
// watches the repository's git folder (shared by all its worktrees) rather than waiting to be told,
// because most changes come from programs that know nothing about Loom; and the project's folder of
// plans in the vault (`watchAlso`), which Notes, Obsidian or an agent may edit directly.
//
// Loom also keeps its own list of agents, independent of any one agent system: an agent is a name
// (what plans say in their Agent field), the listener-mcp session it is connected as right now, and
// the projects it is assigned to. Agents join through the loom MCP server. Questions the user asks
// an agent who is not connected wait in Loom's inbox until it joins and answers.
//
// Stored in <configDir>/loom.json:
//   { projects: [{ id, name, path, added, opened }],
//     agents:   [{ name, session, projects: [id], joined, seen }],
//     inbox:    [{ id, agent, project, plan, step, question, asked, answer, answered, by }] }
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export class LoomError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const slug = (text) => String(text).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "project";

export class Loom {
  constructor({ git, configDir, log = () => {}, watchAlso = async () => null }) {
    this.git = git;
    this.watchAlso = watchAlso; // project → another folder whose changes count (made later, so tried again until it exists)
    this.file = join(configDir, "loom.json");
    this.log = log;
    this.data = null;
    this.feeds = new Map(); // project id → { version, waiters, watchers, timer }
  }

  async #load() {
    if (this.data) return this.data;
    try { this.data = JSON.parse(await readFile(this.file, "utf8")); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.data = {};
    }
    this.data.projects ??= [];
    this.data.agents ??= [];
    this.data.inbox ??= [];
    return this.data;
  }

  async #save() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`);
    await rename(temp, this.file);
  }

  // ------------------------------------------------------------------------------------ projects --

  /** The projects, the most recently opened first. */
  async projects() {
    const { projects } = await this.#load();
    return [...projects].sort((a, b) => (b.opened ?? b.added).localeCompare(a.opened ?? a.added));
  }

  async project(id) {
    const project = (await this.#load()).projects.find((p) => p.id === id);
    if (!project) throw new LoomError(404, "no_project", `There is no Loom project ${id}`);
    return project;
  }

  /** Add the repository a folder belongs to; adding one again returns the existing project. */
  async addProject({ path, name } = {}) {
    const root = await this.git.repo(path);
    const data = await this.#load();
    const existing = data.projects.find((p) => resolve(p.path) === root);
    if (existing) return existing;
    const title = String(name ?? "").trim() || basename(root);
    const id = `${slug(title)}-${createHash("sha256").update(root).digest("hex").slice(0, 6)}`;
    const now = new Date().toISOString();
    const project = { id, name: title, path: root, added: now, opened: now };
    data.projects.push(project);
    await this.#save();
    return project;
  }

  async renameProject(id, name) {
    const project = await this.project(id);
    const title = String(name ?? "").trim();
    if (!title) throw new LoomError(400, "bad_request", "A name is required");
    project.name = title;
    await this.#save();
    this.touch(id);
    return project;
  }

  /** Forget a project. The repository itself is not touched. */
  async removeProject(id) {
    const data = await this.#load();
    const project = await this.project(id);
    data.projects = data.projects.filter((p) => p !== project);
    for (const agent of data.agents) agent.projects = agent.projects.filter((p) => p !== id);
    data.inbox = data.inbox.filter((q) => q.project !== id);
    await this.#save();
    this.#unwatch(id);
    return { removed: id };
  }

  async openProject(id) {
    const project = await this.project(id);
    project.opened = new Date().toISOString();
    await this.#save();
    return project;
  }

  // -------------------------------------------------------------------------------------- agents --

  /** The agents, by name. */
  async agents() {
    const { agents } = await this.#load();
    return [...agents].sort((a, b) => a.name.localeCompare(b.name));
  }

  async agent(name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    const agent = (await this.#load()).agents.find((a) => a.name.toLowerCase() === wanted);
    if (!agent) throw new LoomError(404, "no_agent", `Loom has no agent ${name}`);
    return agent;
  }

  /**
   * An agent session says who it is: its name, its listener-mcp agent id (the session), and the
   * projects it works on (added to those it already has). A name already in use is the same agent
   * in a new session. Returns the agent and the questions waiting for it.
   */
  async join({ name, session, projects = [] } = {}) {
    const title = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!title) throw new LoomError(400, "bad_request", "An agent needs a name");
    const data = await this.#load();
    for (const id of projects) await this.project(id);
    const now = new Date().toISOString();
    let agent = data.agents.find((a) => a.name.toLowerCase() === title.toLowerCase());
    if (!agent) data.agents.push(agent = { name: title, session: null, projects: [], joined: now, seen: now });
    // One session is one agent: a session that joins under a new name leaves its old one.
    if (session) for (const other of data.agents) if (other !== agent && other.session === session) other.session = null;
    Object.assign(agent, { session: session || null, joined: now, seen: now, projects: [...new Set([...agent.projects, ...projects])] });
    await this.#save();
    this.#touchAll();
    return { agent, questions: data.inbox.filter((q) => q.agent.toLowerCase() === agent.name.toLowerCase() && !q.answered) };
  }

  /** The user assigns projects to an agent, renames it, or forgets it. */
  async updateAgent(name, { projects, rename: newName } = {}) {
    const data = await this.#load();
    const agent = await this.agent(name);
    if (projects) { for (const id of projects) await this.project(id); agent.projects = [...new Set(projects)]; }
    if (newName !== undefined) {
      const title = String(newName).replace(/\s+/g, " ").trim().slice(0, 60);
      if (!title) throw new LoomError(400, "bad_request", "An agent needs a name");
      if (data.agents.some((a) => a !== agent && a.name.toLowerCase() === title.toLowerCase())) throw new LoomError(409, "conflict", `There is already an agent ${title}`);
      for (const q of data.inbox) if (q.agent === agent.name) q.agent = title;
      agent.name = title;
    }
    await this.#save();
    this.#touchAll();
    return agent;
  }

  async removeAgent(name) {
    const data = await this.#load();
    const agent = await this.agent(name);
    data.agents = data.agents.filter((a) => a !== agent);
    await this.#save();
    this.#touchAll();
    return { removed: agent.name };
  }

  // --------------------------------------------------------------------------------------- inbox --

  /** Questions, newest first: an agent's open ones by default; `all` includes answered ones. */
  async questions({ agent, project, plan, all = false } = {}) {
    const { inbox } = await this.#load();
    const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
    return inbox.filter((q) => (!agent || same(q.agent, agent)) && (!project || q.project === project) && (!plan || same(q.plan, plan)) && (all || !q.answered))
      .sort((a, b) => b.asked.localeCompare(a.asked));
  }

  /** The user asks an agent about a project, a plan or one of its steps. */
  async ask({ agent, project, plan = null, step = null, question } = {}) {
    const text = String(question ?? "").trim();
    if (!text) throw new LoomError(400, "bad_request", "Ask something");
    const data = await this.#load();
    const who = await this.agent(agent);
    await this.project(project);
    const entry = { id: randomUUID().slice(0, 8), agent: who.name, project, plan, step, question: text, asked: new Date().toISOString(), answer: null, answered: null, by: null };
    data.inbox.push(entry);
    await this.#save();
    this.touch(project);
    return entry;
  }

  async answer(id, { answer, by } = {}) {
    const text = String(answer ?? "").trim();
    if (!text) throw new LoomError(400, "bad_request", "An empty answer");
    const data = await this.#load();
    const entry = data.inbox.find((q) => q.id === id);
    if (!entry) throw new LoomError(404, "no_question", `There is no question ${id}`);
    Object.assign(entry, { answer: text, answered: new Date().toISOString(), by: by ?? entry.agent });
    // Answered questions are kept for a while, then dropped (the plan's page shows recent ones).
    const month = Date.now() - 30 * 86_400_000;
    data.inbox = data.inbox.filter((q) => !q.answered || Date.parse(q.answered) > month);
    await this.#save();
    this.touch(entry.project);
    return entry;
  }

  // -------------------------------------------------------------------------------- change feed --

  #touchAll() { for (const id of this.feeds.keys()) this.touch(id); }

  /** Something in a project changed (Loom's own writes call this; the watcher does for git). */
  touch(id) {
    const feed = this.feeds.get(id);
    if (!feed) return;
    feed.version++;
    const waiters = feed.waiters;
    feed.waiters = [];
    for (const wake of waiters) wake();
  }

  async #feed(id) {
    let feed = this.feeds.get(id);
    if (feed) return feed;
    feed = { version: 1, waiters: [], watchers: [], extra: false, timer: 0 };
    this.feeds.set(id, feed);
    const project = await this.project(id);
    try {
      // The common git folder holds every worktree's HEAD, index and refs.
      const common = resolve(project.path, (await this.git.git(project.path, ["rev-parse", "--git-common-dir"])).trim());
      this.#watch(feed, id, common, (file) => !/(^|[\\/])objects[\\/]/.test(file)); // objects come with a ref change anyway
    } catch (error) { this.log(`loom: cannot watch ${project.path}: ${error.message}`); }
    await this.#watchExtra(feed, project);
    return feed;
  }

  #watch(feed, id, folder, counts = () => true) {
    const watcher = watch(folder, { recursive: true }, (_event, file) => {
      if (file && !counts(String(file))) return;
      clearTimeout(feed.timer);
      feed.timer = setTimeout(() => this.touch(id), 250); // one bump per burst (a commit writes many files)
    });
    watcher.on("error", (error) => this.log(`loom: watching ${folder} stopped: ${error.message}`));
    feed.watchers.push(watcher);
  }

  /** Watch the `watchAlso` folder once it exists (the plans folder is made on first use). */
  async #watchExtra(feed, project) {
    if (feed.extra) return;
    const folder = await this.watchAlso(project).catch(() => null);
    if (!folder) return;
    try { this.#watch(feed, project.id, folder); feed.extra = true; } catch { /* not made yet: tried again on the next request */ }
  }

  /** The project's version, after waiting up to `wait` ms for it to pass `since`. */
  async changes(id, { since = 0, wait = 0 } = {}) {
    const feed = await this.#feed(id);
    if (!feed.extra) await this.#watchExtra(feed, await this.project(id));
    if (feed.version <= since && wait > 0) {
      await new Promise((resolveWait) => {
        const timer = setTimeout(done, Math.min(wait, 60_000));
        function done() { clearTimeout(timer); resolveWait(); }
        feed.waiters.push(done);
      });
    }
    return { project: id, version: feed.version };
  }

  #unwatch(id) {
    const feed = this.feeds.get(id);
    if (!feed) return;
    for (const watcher of feed.watchers) watcher.close();
    clearTimeout(feed.timer);
    for (const wake of feed.waiters) wake();
    this.feeds.delete(id);
  }

  close() { for (const id of [...this.feeds.keys()]) this.#unwatch(id); }
}
