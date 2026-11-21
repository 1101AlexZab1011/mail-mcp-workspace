// Git for Loom, the project screen: what a repository holds (branches, remotes, tags, worktrees, the
// commit graph laid out in lanes, the working tree's state) and the actions GitKraken offers from its
// graph (checkout, branches, merge and its abort, fetch, pull, push). Agents do most of these; the
// user can do them by hand, and the add-on asks before each one.
//
// Everything runs the git program (MAIL_WORKSPACE_GIT points elsewhere) with an argument list, never
// a shell, on a repository inside the host's home folder (FileWriter.target). Names that come from
// a request may not start with "-", so they can't turn into options. Nothing waits on a terminal
// prompt (GIT_TERMINAL_PROMPT=0): a remote that wants a password fails instead of hanging the host.
// Nothing destructive runs without being asked by name: no force-push, no reset, no clean; a
// checkout or a merge over uncommitted changes is refused, and a branch is deleted only once merged
// unless `force` says so.
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expand } from "./files.mjs";

const run = promisify(execFile);
const RS = "\x1e"; // between records
const US = "\x1f"; // between fields
const LOCAL_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 120_000;
const MAINLINE = ["main", "master", "trunk"]; // the branch others are merged into, the first that exists

export class GitError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

/** A name from a request: a branch, a remote, a commit. Never an option. */
function name(value, what) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GitError(400, "bad_request", `${what} is required`);
  if (text.startsWith("-") || /[\0\n\r]/.test(text)) throw new GitError(400, "bad_request", `${what} "${text}" is not a valid name`);
  return text;
}

export class Git {
  /** `files` confines repositories to the home folder; `env` is added to git's environment (tests set identities). */
  constructor({ files, program = process.env.MAIL_WORKSPACE_GIT ?? "git", env = {} } = {}) {
    this.files = files;
    this.program = program;
    this.env = env;
  }

  async git(cwd, args, { timeout = LOCAL_TIMEOUT, allowFail = false } = {}) {
    try {
      const { stdout } = await run(this.program, args, {
        cwd, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...this.env },
      });
      return stdout;
    } catch (error) {
      if (error.code === "ENOENT") throw new GitError(503, "git_missing", "Git is not installed (or MAIL_WORKSPACE_GIT points nowhere)");
      if (allowFail) return null;
      const detail = String(error.stderr || error.stdout || error.message).trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
      throw new GitError(error.killed ? 504 : 409, error.killed ? "git_timeout" : "git_failed", detail || `git ${args[0]} failed`, { stdout: String(error.stdout ?? "") });
    }
  }

  /** The repository's top folder for a path inside it (a worktree's own top for a worktree). */
  async repo(path) {
    // FileWriter.target confines to the home folder and keeps out of protected folders; the home
    // folder itself it refuses (it can't be written as a whole), but reading git there is fine.
    const full = await this.files.target(path).catch(async (error) => {
      const real = await realpath(expand(path)).catch(() => null);
      if (real && real === (await realpath(this.files.root))) return real;
      throw error;
    });
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) throw new GitError(404, "not_found", `${path} is not a folder`);
    const top = (await this.git(full, ["rev-parse", "--show-toplevel"], { allowFail: true }))?.trim();
    if (!top) throw new GitError(404, "not_a_repository", `${path} is not in a git repository`);
    return resolve(top);
  }

  // ------------------------------------------------------------------------------------- reading --

  /** Branches (local and remote), tags, remotes, worktrees and HEAD, in one call. */
  async summary(path) {
    const root = await this.repo(path);
    const format = ["%(refname)", "%(objectname)", "%(upstream:short)", "%(upstream:track,nobracket)", "%(HEAD)", "%(worktreepath)", "%(committerdate:iso-strict)", "%(contents:subject)"].join(US);
    const refs = (await this.git(root, ["for-each-ref", `--format=${format}${RS}`, "refs/heads", "refs/remotes", "refs/tags"]))
      .split(RS).map((r) => r.replace(/^\r?\n/, "")).filter(Boolean).map((r) => r.split(US));
    const branches = [];
    const remoteBranches = [];
    const tags = [];
    for (const [ref, sha, upstream, track, head, worktree, date, subject] of refs) {
      if (ref.startsWith("refs/heads/")) {
        const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
        const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
        branches.push({ name: ref.slice(11), sha, upstream: upstream || null, gone: track === "gone", ahead, behind, current: head === "*", worktree: worktree ? resolve(worktree) : null, date, subject });
      } else if (ref.startsWith("refs/remotes/")) {
        if (ref.endsWith("/HEAD")) continue;
        remoteBranches.push({ name: ref.slice(13), sha, date, subject });
      } else tags.push({ name: ref.slice(10), sha, date });
    }
    const remotes = (await this.git(root, ["remote", "-v"])).split(/\r?\n/).filter(Boolean).reduce((out, line) => {
      const [remote, url, kind] = line.split(/\s+/);
      const entry = out.find((r) => r.name === remote) ?? (out.push({ name: remote, fetch: null, push: null }), out.at(-1));
      entry[kind === "(push)" ? "push" : "fetch"] = url;
      return out;
    }, []);
    // Branches whose every commit is already on the main line are finished: their work is in it.
    const mainline = MAINLINE.find((name) => branches.some((b) => b.name === name)) ?? null;
    if (mainline) {
      const merged = new Set((await this.git(root, ["for-each-ref", `--merged=refs/heads/${mainline}`, "--format=%(refname)", "refs/heads", "refs/remotes"])).split(/\r?\n/).filter(Boolean));
      for (const b of branches) b.merged = b.name !== mainline && merged.has(`refs/heads/${b.name}`);
      // A remote copy of the main line itself (origin/main) is not a finished branch.
      for (const b of remoteBranches) b.merged = b.name.split("/").slice(1).join("/") !== mainline && merged.has(`refs/remotes/${b.name}`);
    }
    const head = await this.head(root);
    return { root, head, mainline, branches, remoteBranches, tags, remotes, worktrees: await this.worktrees(root) };
  }

  async head(root) {
    const sha = (await this.git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true }))?.trim() || null;
    const branch = (await this.git(root, ["symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true }))?.trim() || null;
    return { sha, branch, detached: Boolean(sha) && !branch, unborn: !sha };
  }

  /** Every worktree: its folder, branch (or detached commit) and whether git may prune it. */
  async worktrees(path) {
    const root = await this.repo(path);
    const out = [];
    let current = null;
    for (const line of (await this.git(root, ["worktree", "list", "--porcelain"])).split(/\r?\n/)) {
      if (line.startsWith("worktree ")) out.push((current = { path: resolve(line.slice(9)), sha: null, branch: null, detached: false, bare: false, locked: false, prunable: false }));
      else if (!current) continue;
      else if (line.startsWith("HEAD ")) current.sha = line.slice(5);
      else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") current.detached = true;
      else if (line === "bare") current.bare = true;
      else if (line.startsWith("locked")) current.locked = true;
      else if (line.startsWith("prunable")) current.prunable = true;
    }
    for (const tree of out) tree.main = tree === out[0];
    return out;
  }

  /**
   * The commit graph, newest first, `limit` commits from `skip`, with lanes for drawing it: each
   * commit has a `lane`, and `edges` to the lanes its parents continue in. A later page is laid
   * out with what came before it, so the client asks again from 0 with a larger limit.
   */
  async graph(path, { limit = 300, skip = 0 } = {}) {
    const root = await this.repo(path);
    const count = Math.max(1, Math.min(Number(limit) || 300, 5000));
    const from = Math.max(0, Number(skip) || 0);
    if (!(await this.head(root)).sha && !(await this.git(root, ["for-each-ref", "--count=1", "--format=%(refname)"])).trim()) return { root, commits: [], lanes: 0, more: false };
    const format = ["%H", "%P", "%an", "%ae", "%aI", "%D", "%s"].join(US);
    const text = await this.git(root, ["log", "--all", "--date-order", "--decorate=full", `--format=${format}${RS}`, `--max-count=${count + 1}`, `--skip=${from}`]);
    const rows = text.split(RS).map((r) => r.replace(/^\r?\n/, "")).filter(Boolean).map((r) => r.split(US));
    const more = rows.length > count;
    const commits = rows.slice(0, count).map(([sha, parents, author, email, date, decorations, subject]) => ({
      sha, parents: parents ? parents.split(" ") : [], author, email, date, subject, refs: parseDecorations(decorations),
    }));
    const { lanes } = layoutGraph(commits);
    return { root, commits, lanes, more };
  }

  /** The working tree: branch, upstream, ahead/behind, staged, changed, untracked and conflicted files, a merge in progress. */
  async status(path) {
    const root = await this.repo(path);
    const out = { root, branch: null, sha: null, upstream: null, ahead: 0, behind: 0, staged: [], changed: [], untracked: [], conflicts: [], merging: false, rebasing: false };
    const records = (await this.git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])).split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      if (record.startsWith("# branch.oid ")) out.sha = record.slice(13) === "(initial)" ? null : record.slice(13);
      else if (record.startsWith("# branch.head ")) out.branch = record.slice(14) === "(detached)" ? null : record.slice(14);
      else if (record.startsWith("# branch.upstream ")) out.upstream = record.slice(18);
      else if (record.startsWith("# branch.ab ")) { const [a, b] = record.slice(12).split(" "); out.ahead = Math.abs(Number(a)); out.behind = Math.abs(Number(b)); }
      else if (record.startsWith("1 ") || record.startsWith("2 ")) {
        const parts = record.split(" ");
        const xy = parts[1];
        const file = parts.slice(record.startsWith("1 ") ? 8 : 9).join(" ");
        const renamedFrom = record.startsWith("2 ") ? records[++i] : undefined;
        if (xy[0] !== ".") out.staged.push({ path: file, change: CHANGE[xy[0]] ?? xy[0], ...(renamedFrom ? { from: renamedFrom } : {}) });
        if (xy[1] !== ".") out.changed.push({ path: file, change: CHANGE[xy[1]] ?? xy[1] });
      } else if (record.startsWith("u ")) out.conflicts.push({ path: record.split(" ").slice(10).join(" ") });
      else if (record.startsWith("? ")) out.untracked.push({ path: record.slice(2) });
    }
    const gitDir = resolve(root, (await this.git(root, ["rev-parse", "--git-dir"])).trim());
    out.merging = Boolean(await stat(join(gitDir, "MERGE_HEAD")).catch(() => null));
    out.rebasing = Boolean(await stat(join(gitDir, "rebase-merge")).catch(() => null) || await stat(join(gitDir, "rebase-apply")).catch(() => null));
    out.clean = !out.staged.length && !out.changed.length && !out.conflicts.length;
    return out;
  }

  // ------------------------------------------------------------------------------------- actions --

  /** Uncommitted changes (untracked files aside) would be carried along or lost: refuse. */
  async #requireClean(root, action) {
    const state = await this.status(root);
    if (state.merging || state.rebasing) throw new GitError(409, "busy", `A ${state.merging ? "merge" : "rebase"} is in progress here; finish or abort it before you ${action}`);
    if (!state.clean) throw new GitError(409, "dirty", `This worktree has uncommitted changes (${state.staged.length + state.changed.length + state.conflicts.length} files); commit or stash them before you ${action}`, { worktree: state });
    return state;
  }

  /** Check out a branch, or a commit (detached); with `create`, a new branch at `ref` (default HEAD). */
  async checkout(path, { ref, create } = {}) {
    const root = await this.repo(path);
    await this.#requireClean(root, "check out");
    if (create) {
      const branch = await this.#branchName(root, create);
      await this.git(root, ["switch", "-c", branch, ...(ref ? [name(ref, "The starting point")] : [])]);
    } else {
      const target = name(ref, "The branch or commit");
      const local = await this.git(root, ["show-ref", "--verify", "-q", `refs/heads/${target}`], { allowFail: true });
      if (local !== null) await this.git(root, ["switch", target]);
      else {
        // A remote branch ("origin/feature") gets a local one that tracks it, as GitKraken does.
        const remote = await this.git(root, ["show-ref", "--verify", "-q", `refs/remotes/${target}`], { allowFail: true });
        if (remote !== null) {
          const short = target.split("/").slice(1).join("/");
          const exists = await this.git(root, ["show-ref", "--verify", "-q", `refs/heads/${short}`], { allowFail: true });
          if (exists !== null) throw new GitError(409, "exists", `A local branch ${short} already exists; check it out instead`);
          await this.git(root, ["switch", "-c", short, "--track", target]);
        } else await this.git(root, ["switch", "--detach", target]);
      }
    }
    return { head: await this.head(root), status: await this.status(root) };
  }

  async #branchName(root, value) {
    const branch = name(value, "The branch name");
    if ((await this.git(root, ["check-ref-format", "--branch", branch], { allowFail: true })) === null) throw new GitError(400, "bad_request", `"${branch}" is not a valid branch name`);
    return branch;
  }

  /** A new branch at `at` (default HEAD), without checking it out. */
  async createBranch(path, { name: branchName, at } = {}) {
    const root = await this.repo(path);
    const branch = await this.#branchName(root, branchName);
    await this.git(root, ["branch", branch, ...(at ? [name(at, "The starting point")] : [])]);
    return { branch, sha: (await this.git(root, ["rev-parse", `refs/heads/${branch}`])).trim() };
  }

  /** Delete a local branch: only once merged, unless `force`. Never the current one, nor one another worktree has out. */
  async deleteBranch(path, { name: branchName, force = false } = {}) {
    const root = await this.repo(path);
    const branch = name(branchName, "The branch");
    await this.git(root, ["branch", force ? "-D" : "-d", branch]);
    return { deleted: branch };
  }

  /**
   * Merge `from` into the checked-out branch. `mode`: "auto" (fast-forward when possible), "ff-only",
   * or "no-ff" (always a merge commit). A conflict leaves the merge in progress and reports the files;
   * abortMerge() undoes it.
   */
  async merge(path, { from, mode = "auto", message } = {}) {
    const root = await this.repo(path);
    const source = name(from, "The branch to merge");
    const before = await this.#requireClean(root, "merge");
    if (!before.branch) throw new GitError(409, "detached", "Check out a branch to merge into first");
    const flags = { auto: [], "ff-only": ["--ff-only"], "no-ff": ["--no-ff"] }[mode];
    if (!flags) throw new GitError(400, "bad_request", `Unknown merge mode ${mode}`);
    const args = ["merge", ...flags, "--no-edit", ...(message ? ["-m", String(message)] : []), source];
    const sourceSha = (await this.git(root, ["rev-parse", "--verify", "-q", `${source}^{commit}`], { allowFail: true }))?.trim();
    if (!sourceSha) throw new GitError(404, "not_found", `There is no branch or commit ${source}`);
    try {
      await this.git(root, args);
    } catch (error) {
      const state = await this.status(root);
      if (state.merging && state.conflicts.length) return { merged: false, conflicts: state.conflicts.map((c) => c.path), status: state };
      throw error;
    }
    const after = await this.head(root);
    // Already up to date: HEAD did not move. A fast-forward: HEAD is now the merged commit itself.
    return { merged: true, into: before.branch, from: source, upToDate: after.sha === before.sha, fastForward: after.sha !== before.sha && after.sha === sourceSha, head: after };
  }

  async abortMerge(path) {
    const root = await this.repo(path);
    if (!(await this.status(root)).merging) throw new GitError(409, "not_merging", "No merge is in progress here");
    await this.git(root, ["merge", "--abort"]);
    return { aborted: true, status: await this.status(root) };
  }

  async fetch(path, { remote, prune = true } = {}) {
    const root = await this.repo(path);
    await this.git(root, ["fetch", ...(prune ? ["--prune"] : []), ...(remote ? [name(remote, "The remote")] : ["--all"])], { timeout: NETWORK_TIMEOUT });
    return { fetched: remote ?? "all", status: await this.status(root) };
  }

  /** Pull the current branch from its upstream: fast-forward only by default, or merge with mode "merge". */
  async pull(path, { mode = "ff-only" } = {}) {
    const root = await this.repo(path);
    const state = await this.#requireClean(root, "pull");
    if (!state.upstream) throw new GitError(409, "no_upstream", `${state.branch ?? "This commit"} has no upstream branch to pull from`);
    const flags = { "ff-only": ["--ff-only"], merge: ["--no-rebase", "--no-edit"] }[mode];
    if (!flags) throw new GitError(400, "bad_request", `Unknown pull mode ${mode}`);
    try {
      await this.git(root, ["pull", ...flags], { timeout: NETWORK_TIMEOUT });
    } catch (error) {
      const after = await this.status(root);
      if (after.merging && after.conflicts.length) return { pulled: false, conflicts: after.conflicts.map((c) => c.path), status: after };
      throw error;
    }
    return { pulled: true, status: await this.status(root) };
  }

  /** Push a branch (default: the current one) to its upstream, or to `remote` with `setUpstream`. Never forced. */
  async push(path, { remote, branch, setUpstream = false } = {}) {
    const root = await this.repo(path);
    const state = await this.status(root);
    const source = branch ? name(branch, "The branch") : state.branch;
    if (!source) throw new GitError(409, "detached", "Check out a branch to push, or name one");
    const target = remote ? name(remote, "The remote") : null;
    if (!target && !state.upstream && source === state.branch) throw new GitError(409, "no_upstream", `${source} has no upstream; choose a remote to push it to`);
    const args = target ? ["push", ...(setUpstream ? ["-u"] : []), target, `refs/heads/${source}:refs/heads/${source}`] : ["push"];
    await this.git(root, args, { timeout: NETWORK_TIMEOUT });
    return { pushed: source, to: target ?? state.upstream, status: await this.status(root) };
  }
}

const CHANGE = { M: "modified", T: "type", A: "added", D: "deleted", R: "renamed", C: "copied", U: "unmerged" };

/**
 * Full decorations (git log --decorate=full) → [{ kind, name }]:
 * "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". Full names tell a local
 * branch with a slash (fix/x) from a remote one (origin/x).
 */
export function parseDecorations(text) {
  if (!text) return [];
  const ref = (full) => {
    if (full.startsWith("refs/heads/")) return [{ kind: "branch", name: full.slice(11) }];
    if (full.startsWith("refs/remotes/")) return full.endsWith("/HEAD") ? [] : [{ kind: "remote", name: full.slice(13) }];
    if (full.startsWith("refs/tags/")) return [{ kind: "tag", name: full.slice(10) }];
    return []; // stashes, notes and other refs are not drawn
  };
  return text.split(", ").map((part) => {
    if (part.startsWith("HEAD -> ")) return [{ kind: "head", name: "HEAD" }, ...ref(part.slice(8))];
    if (part === "HEAD") return [{ kind: "head", name: "HEAD" }];
    if (part.startsWith("tag: ")) return ref(part.slice(5));
    return ref(part);
  }).flat();
}

/**
 * Lanes for a commit list in date order (newest first), as GitKraken draws it: a commit sits in the
 * lane that was waiting for it (or a free one); its first parent continues that lane, and each other
 * parent takes the lane already waiting for it or a new one. `edges` connect a commit to the lanes its
 * parents are drawn in; lanes freed by a commit are reused below it.
 */
export function layoutGraph(commits) {
  const waiting = []; // lane → the sha that lane is drawn down to, or null when free
  let lanes = 0;
  const take = (sha) => {
    let lane = waiting.indexOf(null);
    if (lane === -1) lane = waiting.length;
    waiting[lane] = sha;
    lanes = Math.max(lanes, waiting.length);
    return lane;
  };
  for (const commit of commits) {
    // Every lane waiting for this commit merges into one; the leftmost keeps it.
    const into = waiting.flatMap((sha, lane) => (sha === commit.sha ? [lane] : []));
    const lane = into.length ? into[0] : take(commit.sha);
    for (const other of into.slice(1)) waiting[other] = null;
    commit.lane = lane;
    commit.merging = into.slice(1); // lanes that end here, joining this commit
    commit.edges = [];
    const [first, ...others] = commit.parents;
    waiting[lane] = first ?? null;
    if (first) commit.edges.push({ to: lane, parent: first });
    for (const parent of others) {
      const existing = waiting.indexOf(parent);
      commit.edges.push({ to: existing !== -1 ? existing : take(parent), parent });
    }
    while (waiting.length && waiting.at(-1) === null) waiting.pop();
  }
  return { commits, lanes };
}
