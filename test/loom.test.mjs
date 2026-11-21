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

const exec = promisify(execFile);
const ENV = { GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.org", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.org", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
const sh = (cwd, ...args) => exec("git", args, { cwd, env: { ...process.env, ...ENV }, windowsHide: true }).then((r) => r.stdout.trim());

async function setup(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mw-loom-")));
  const git = new Git({ files: new FileWriter({ root: home, trashDir: join(home, ".trash") }), env: ENV });
  const loom = new Loom({ git, configDir: join(home, ".config/thoth") });
  t.after(async () => { loom.close(); await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });
  const repo = join(home, "Code", "Thoth");
  await mkdir(repo, { recursive: true });
  await sh(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "one\n");
  await sh(repo, "add", "a.txt");
  await sh(repo, "commit", "-q", "-m", "First");
  return { home, repo, git, loom };
}

test("projects: added once by their repository, renamed, opened, removed, kept on disk", async (t) => {
  const { home, repo, loom } = await setup(t);
  await mkdir(join(repo, "src"));
  const project = await loom.addProject({ path: join(repo, "src") });
  assert.equal(project.path, repo, "a folder inside the repository adds the repository");
  assert.equal(project.name, "Thoth");
  assert.match(project.id, /^thoth-[0-9a-f]{6}$/);
  assert.equal((await loom.addProject({ path: repo, name: "Other" })).id, project.id, "adding again returns the same project");

  await mkdir(join(home, "plain"));
  await assert.rejects(loom.addProject({ path: join(home, "plain") }), { code: "not_a_repository" });

  assert.equal((await loom.renameProject(project.id, "Thoth app")).name, "Thoth app");
  const saved = JSON.parse(await readFile(join(home, ".config/thoth/loom.json"), "utf8"));
  assert.deepEqual(saved.projects.map((p) => [p.id, p.name, p.path]), [[project.id, "Thoth app", repo]]);

  // A second Loom over the same file sees the same projects (the host restarting).
  const again = new Loom({ git: loom.git, configDir: join(home, ".config/thoth") });
  assert.equal((await again.projects())[0].name, "Thoth app");

  assert.deepEqual(await loom.removeProject(project.id), { removed: project.id });
  assert.deepEqual(await loom.projects(), []);
  await assert.rejects(loom.project(project.id), { code: "no_project" });
});

test("the change feed moves when git changes the repository, whoever does it", async (t) => {
  const { repo, loom } = await setup(t);
  const project = await loom.addProject({ path: repo });
  const { version } = await loom.changes(project.id);
  const waiting = loom.changes(project.id, { since: version, wait: 20_000 });
  await new Promise((r) => setTimeout(r, 300)); // the watcher is set up
  await sh(repo, "switch", "-q", "-c", "feature"); // not through Loom
  const after = await waiting;
  assert.ok(after.version > version, "a checkout outside Loom moved the feed");
  // Loom's own writes (plans) move it too, and a wait that times out returns the same version.
  loom.touch(project.id);
  assert.ok((await loom.changes(project.id)).version > after.version);
  const quiet = await loom.changes(project.id, { since: Number.MAX_SAFE_INTEGER, wait: 50 });
  assert.equal(typeof quiet.version, "number");
});
