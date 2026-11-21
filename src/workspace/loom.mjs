// Loom, the project screen's own state: the projects the user added (a git repository each) and a
// change feed per project, so the screen redraws when anything happens in the repository, whoever
// did it: Loom's buttons, an agent's git commands in a terminal, a commit from an editor. The feed
// watches the repository's git folder (shared by all its worktrees) rather than waiting to be told,
// because most changes come from programs that know nothing about Loom; and the project's folder of
// plans in the vault (`watchAlso`), which Notes, Obsidian or an agent may edit directly.
//
// Stored in <configDir>/loom.json: { projects: [{ id, name, path, added, opened }] }.
import { createHash } from "node:crypto";
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

  // -------------------------------------------------------------------------------- change feed --

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
