import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { FileWriter } from "../src/workspace/writes.mjs";
import { Git, layoutGraph, parseDecorations } from "../src/workspace/git.mjs";

const exec = promisify(execFile);
// Fixed identities and no user or system config, so the tests don't depend on this machine's git.
const ENV = { GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.org", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.org", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
const sh = (cwd, ...args) => exec("git", args, { cwd, env: { ...process.env, ...ENV }, windowsHide: true }).then((r) => r.stdout.trim());

async function setup(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mw-git-")));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const git = new Git({ files: new FileWriter({ root: home, trashDir: join(home, ".trash") }), env: ENV });
  const repo = join(home, "project");
  await mkdir(repo);
  await sh(repo, "init", "-q", "-b", "main");
  const commit = async (file, text, message) => { await writeFile(join(repo, file), text); await sh(repo, "add", file); await sh(repo, "commit", "-q", "-m", message); return sh(repo, "rev-parse", "HEAD"); };
  return { home, repo, git, commit };
}

test("graph lanes: a branch beside main, merged back", () => {
  // Newest first: M merges F into C; F and C both come from B; B from A.
  const { commits, lanes } = layoutGraph([
    { sha: "M", parents: ["C", "F"] },
    { sha: "F", parents: ["B"] },
    { sha: "C", parents: ["B"] },
    { sha: "B", parents: ["A"] },
    { sha: "A", parents: [] },
  ]);
  const at = Object.fromEntries(commits.map((c) => [c.sha, c]));
  assert.equal(lanes, 2);
  assert.equal(at.M.lane, 0);
  assert.deepEqual(at.M.edges, [{ to: 0, parent: "C" }, { to: 1, parent: "F" }]);
  assert.equal(at.F.lane, 1);
  assert.equal(at.C.lane, 0);
  assert.equal(at.B.lane, 0);
  assert.deepEqual(at.B.merging, [1]); // the branch's lane ends at B
  assert.deepEqual(at.A.edges, []);
});

test("decorations become typed refs", () => {
  assert.deepEqual(parseDecorations("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/heads/fix/login, refs/stash"), [
    { kind: "head", name: "HEAD" }, { kind: "branch", name: "main" }, { kind: "remote", name: "origin/main" }, { kind: "tag", name: "v1.0" },
    { kind: "branch", name: "fix/login" }, // a local branch with a slash stays local
  ]);
  assert.deepEqual(parseDecorations(""), []);
});

test("reading: summary, graph, status and worktrees of a real repository", async (t) => {
  const { home, repo, git, commit } = await setup(t);
  await commit("a.txt", "one\n", "First");
  await sh(repo, "tag", "v1");
  await sh(repo, "switch", "-q", "-c", "feature");
  await commit("b.txt", "two\n", "Feature work");
  await sh(repo, "switch", "-q", "main");
  await commit("a.txt", "one\nthree\n", "Main work");
  await sh(repo, "worktree", "add", "-q", join(home, "project-wt"), "feature");

  const summary = await git.summary(join(repo, "."));
  assert.equal(summary.root, repo);
  assert.deepEqual(summary.head, { sha: await sh(repo, "rev-parse", "HEAD"), branch: "main", detached: false, unborn: false });
  assert.deepEqual(summary.branches.map((b) => [b.name, b.current]).sort(), [["feature", false], ["main", true]]);
  assert.equal(summary.branches.find((b) => b.name === "feature").worktree, join(home, "project-wt"));
  assert.deepEqual(summary.tags.map((tag) => tag.name), ["v1"]);
  assert.equal(summary.mainline, "main");
  assert.equal(summary.branches.find((b) => b.name === "feature").merged, false, "feature has work main lacks");
  await sh(repo, "branch", "done-fix", "HEAD~1");
  assert.equal((await git.summary(repo)).branches.find((b) => b.name === "done-fix").merged, true, "a branch main already contains is merged");
  assert.equal((await git.summary(repo)).branches.find((b) => b.name === "main").merged, false, "the main line itself is not");
  await sh(repo, "branch", "-q", "-D", "done-fix");
  assert.deepEqual(summary.worktrees.map((w) => [w.path, w.branch, w.main]), [[repo, "main", true], [join(home, "project-wt"), "feature", false]]);

  const graph = await git.graph(repo);
  assert.equal(graph.commits.length, 3);
  assert.equal(graph.more, false);
  assert.equal(graph.lanes, 2);
  assert.deepEqual(graph.commits.at(-1).refs, [{ kind: "tag", name: "v1" }]);
  const paged = await git.graph(repo, { limit: 2 });
  assert.equal(paged.commits.length, 2);
  assert.equal(paged.more, true);

  await writeFile(join(repo, "a.txt"), "changed\n");
  await writeFile(join(repo, "new.txt"), "new\n");
  await writeFile(join(repo, "b.txt"), "staged\n");
  await sh(repo, "add", "b.txt");
  const status = await git.status(repo);
  assert.equal(status.branch, "main");
  assert.deepEqual(status.changed, [{ path: "a.txt", change: "modified" }]);
  assert.deepEqual(status.staged, [{ path: "b.txt", change: "added" }]);
  assert.deepEqual(status.untracked, [{ path: "new.txt" }]);
  assert.equal(status.clean, false);

  // A folder inside the repository finds its top; one outside the home folder or outside git doesn't.
  await mkdir(join(repo, "sub"));
  assert.equal((await git.summary(join(repo, "sub"))).root, repo);
  await mkdir(join(home, "plain"));
  await assert.rejects(git.summary(join(home, "plain")), { code: "not_a_repository" });
  await assert.rejects(git.summary(tmpdir()), { status: 403 });
});

test("an empty repository has no commits and no HEAD yet", async (t) => {
  const { repo, git } = await setup(t);
  assert.deepEqual((await git.graph(repo)).commits, []);
  assert.equal((await git.summary(repo)).head.unborn, true);
});

test("checkout: branches, commits, remote branches; refused over uncommitted changes", async (t) => {
  const { repo, git, commit } = await setup(t);
  const first = await commit("a.txt", "one\n", "First");
  await commit("a.txt", "two\n", "Second");
  await git.createBranch(repo, { name: "feature", at: first });
  assert.equal((await git.checkout(repo, { ref: "feature" })).head.branch, "feature");
  assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "one\n");
  const detached = await git.checkout(repo, { ref: first });
  assert.equal(detached.head.detached, true);
  assert.equal((await git.checkout(repo, { ref: "main", create: "topic" })).head.branch, "topic");

  await writeFile(join(repo, "a.txt"), "dirty\n");
  await assert.rejects(git.checkout(repo, { ref: "main" }), { code: "dirty" });
  await sh(repo, "checkout", "--", "a.txt");

  await assert.rejects(git.checkout(repo, { ref: "--orphan" }), { code: "bad_request" });
  await assert.rejects(git.createBranch(repo, { name: "bad..name" }), { code: "bad_request" });
  await assert.rejects(git.checkout(repo, { ref: "nope" }), { code: "git_failed" });
});

test("branches: delete only when merged unless forced, never the current one", async (t) => {
  const { repo, git, commit } = await setup(t);
  await commit("a.txt", "one\n", "First");
  await sh(repo, "switch", "-q", "-c", "unmerged");
  await commit("b.txt", "b\n", "Unmerged work");
  await sh(repo, "switch", "-q", "main");
  await assert.rejects(git.deleteBranch(repo, { name: "unmerged" }), { code: "git_failed" });
  assert.deepEqual(await git.deleteBranch(repo, { name: "unmerged", force: true }), { deleted: "unmerged" });
  await assert.rejects(git.deleteBranch(repo, { name: "main" }), { code: "git_failed" });
});

test("merge: fast-forward, merge commit, conflict and abort", async (t) => {
  const { repo, git, commit } = await setup(t);
  await commit("a.txt", "base\n", "Base");
  await sh(repo, "switch", "-q", "-c", "ahead");
  const aheadSha = await commit("b.txt", "b\n", "Ahead");
  await sh(repo, "switch", "-q", "main");

  const ff = await git.merge(repo, { from: "ahead" });
  assert.equal(ff.merged, true);
  assert.equal(ff.fastForward, true);
  assert.equal(ff.head.sha, aheadSha);
  assert.equal((await git.merge(repo, { from: "ahead" })).upToDate, true);

  await sh(repo, "switch", "-q", "-c", "side");
  await commit("c.txt", "c\n", "Side");
  await sh(repo, "switch", "-q", "main");
  const merged = await git.merge(repo, { from: "side", mode: "no-ff" });
  assert.equal(merged.fastForward, false);
  assert.equal((await sh(repo, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ").length, 3);

  await sh(repo, "switch", "-q", "-c", "theirs");
  await commit("a.txt", "theirs\n", "Theirs");
  await sh(repo, "switch", "-q", "main");
  const ours = await commit("a.txt", "ours\n", "Ours");
  const conflict = await git.merge(repo, { from: "theirs" });
  assert.equal(conflict.merged, false);
  assert.deepEqual(conflict.conflicts, ["a.txt"]);
  assert.equal(conflict.status.merging, true);
  await assert.rejects(git.checkout(repo, { ref: "theirs" }), { code: "busy" });
  const aborted = await git.abortMerge(repo);
  assert.equal(aborted.status.merging, false);
  assert.equal(await sh(repo, "rev-parse", "HEAD"), ours);
  await assert.rejects(git.abortMerge(repo), { code: "not_merging" });
  await assert.rejects(git.merge(repo, { from: "missing" }), { code: "not_found" });
});

test("fetch, pull and push against a bare remote", async (t) => {
  const { home, repo, git, commit } = await setup(t);
  const remote = join(home, "remote.git");
  await sh(home, "init", "-q", "--bare", "-b", "main", remote);
  await commit("a.txt", "one\n", "First");
  await sh(repo, "remote", "add", "origin", remote);
  await assert.rejects(git.push(repo), { code: "no_upstream" });
  const pushed = await git.push(repo, { remote: "origin", setUpstream: true });
  assert.equal(pushed.pushed, "main");
  assert.equal(pushed.status.upstream, "origin/main");

  // A second clone moves the remote ahead; fetch sees it, pull brings it.
  const other = join(home, "other");
  await sh(home, "clone", "-q", remote, other);
  await writeFile(join(other, "z.txt"), "z\n");
  await sh(other, "add", "z.txt");
  await sh(other, "commit", "-q", "-m", "From elsewhere");
  await sh(other, "push", "-q");
  const fetched = await git.fetch(repo, { remote: "origin" });
  assert.equal(fetched.status.behind, 1);
  const pulled = await git.pull(repo);
  assert.equal(pulled.pulled, true);
  assert.equal(pulled.status.behind, 0);
  assert.equal(await readFile(join(repo, "z.txt"), "utf8"), "z\n");

  // A branch someone else pushed: checking out "origin/shared" makes a local branch that tracks it.
  await sh(other, "switch", "-q", "-c", "shared");
  await sh(other, "push", "-q", "-u", "origin", "shared");
  await git.fetch(repo);
  const tracked = await git.checkout(repo, { ref: "origin/shared" });
  assert.equal(tracked.head.branch, "shared");
  assert.equal(tracked.status.upstream, "origin/shared");
  await assert.rejects(git.checkout(repo, { ref: "origin/shared" }), { code: "exists" });
  await git.checkout(repo, { ref: "main" });

  // Work pushed from here shows as ahead until pushed.
  await commit("a.txt", "two\n", "Second");
  assert.equal((await git.status(repo)).ahead, 1);
  assert.equal((await git.push(repo)).status.ahead, 0);
  const summary = await git.summary(repo);
  assert.deepEqual(summary.remotes, [{ name: "origin", fetch: remote, push: remote }]);
  assert.ok(summary.remoteBranches.some((b) => b.name === "origin/main"));
});

test("the home folder itself can be read (it just isn't a repository here)", async (t) => {
  const { home, git } = await setup(t);
  await assert.rejects(git.summary(home), { code: "not_a_repository" });
});
