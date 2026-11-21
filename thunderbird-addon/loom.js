// Loom: the project screen. Projects on the left (a git repository each); the commit graph in the
// middle with every branch, remote and tag; branches, worktrees and the selected commit on the right;
// the working tree's state below. The Plans tab shows the project's plans (loom/plans.js). Every git action asks first and says what it will do; the screen
// follows the repository live, whoever changes it (the host watches the git folder).
import { host, json } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { tildePath } from "./shared/paths.js";
import { pickFiles } from "./shared/filepicker.js";
import { $, h, iconButton, contextMenu, toast, ask, registerPage } from "./shared/page.js";
import { renderGraph, refChip } from "./loom/graph.js";
import { createPlans } from "./loom/plans.js";

const LIMIT_STEP = 400;
const state = {
  projects: [],
  project: null, // { id, name, path }
  summary: null, // git.summary
  graph: null, // { commits, lanes, more }
  status: null, // git.status of the active worktree
  worktree: null, // the active worktree's path (null: the main one)
  selected: null, // a commit sha
  limit: LIMIT_STEP,
  view: "graph",
  version: 0,
  error: null,
  busy: false,
};
const plans = createPlans({
  project: () => state.project,
  branches: () => state.summary?.branches.map((b) => b.name) ?? [],
  rerender: () => { renderContent(); renderActions(); },
  showError: (title, message) => showError(title, message),
  showView: (id) => showView(id),
  showBranch: (name) => {
    const sha = state.summary?.branches.find((b) => b.name === name)?.sha;
    if (!sha) { showError("Branch", `${name} is not a branch in this repository (yet)`); return; }
    showView("graph");
    select(sha, { scroll: true });
  },
});
const views = {
  graph: { label: "Graph", icon: "account_tree", render: renderGraphView },
  plans: { label: "Plans", icon: "view_kanban", render: (content) => plans.render(content), actions: () => plans.actions() },
};

const q = (params) => new URLSearchParams(params).toString();
const worktreePath = () => state.worktree ?? state.project?.path;
const lanes = () => new Map(state.graph?.commits.map((c) => [c.sha, c.lane]) ?? []);

// ------------------------------------------------------------------------------------ loading --

async function loadProjects() {
  state.projects = (await host("/v1/loom/projects")).projects;
  renderProjects();
}

async function openProject(id) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;
  state.project = project;
  state.worktree = null;
  state.selected = null;
  state.limit = LIMIT_STEP;
  state.version = 0;
  plans.reset();
  localStorage.setItem("loom.project", id);
  void host("/v1/loom/projects/open", json({ id })).catch(() => {});
  renderProjects();
  await reload();
  follow();
}

/** Everything about the open project, again: summary, graph, the worktree's status, the plans. */
async function reload() {
  const project = state.project;
  if (!project) return render();
  try {
    const [summary, graph, status] = await Promise.all([
      host(`/v1/git/repo?${q({ path: project.path })}`),
      host(`/v1/git/graph?${q({ path: project.path, limit: state.limit })}`),
      host(`/v1/git/status?${q({ path: worktreePath() })}`),
      plans.load(),
    ]);
    if (state.project !== project) return;
    Object.assign(state, { summary, graph, status, error: null });
    if (state.worktree && !summary.worktrees.some((w) => w.path === state.worktree)) state.worktree = null;
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function refreshStatus() {
  if (!state.project || document.hidden) return;
  try {
    const status = await host(`/v1/git/status?${q({ path: worktreePath() })}`);
    const before = JSON.stringify(state.status);
    state.status = status;
    if (JSON.stringify(status) !== before) { renderStatus(); renderBanner(); }
  } catch { /* the next change or poll tries again */ }
}

/** Follow the open project's change feed (commits, checkouts, merges, from anyone). */
let following = null;
function follow() {
  const project = state.project;
  if (!project || following === project.id) return;
  following = project.id;
  void (async () => {
    while (state.project === project) {
      try {
        const { version } = await host(`/v1/loom/changes?${q({ project: project.id, since: state.version, wait: 50_000 })}`);
        if (state.project !== project) break;
        if (version !== state.version) {
          const first = state.version === 0;
          state.version = version;
          if (!first) await reload();
        }
      } catch { await new Promise((r) => setTimeout(r, 5000)); }
    }
    if (following === project.id) following = null;
  })();
}
// Edits to files don't touch the git folder: the working tree's state is polled while visible.
setInterval(() => void refreshStatus(), 8000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshStatus(); });

// ------------------------------------------------------------------------------------ actions --

/** Ask, run a git action on the active worktree, report, reload. */
async function act({ title, message, ok, danger = false, run, done }) {
  if (!(await ask({ title, message, ok, danger }))) return null;
  state.busy = true;
  renderActions();
  try {
    const result = await run();
    if (result?.conflicts?.length) {
      toast(`Conflicts in ${result.conflicts.length} file${result.conflicts.length > 1 ? "s" : ""}: resolve them, or abort the merge`);
    } else toast(typeof done === "function" ? done(result) : done);
    return result;
  } catch (error) {
    showError(title, error.message);
    return null;
  } finally {
    state.busy = false;
    await reload();
  }
}

function showError(title, message) {
  state.error = `${title}: ${message}`;
  renderBanner();
}

const currentBranch = () => state.status?.branch ?? null;
const dirtyNote = () => (state.status && !state.status.clean ? "\n\nThis worktree has uncommitted changes, so git will refuse; commit or stash them first." : "");

const actions = {
  checkout: (ref, { remote = false } = {}) => act({
    title: remote ? `Check out ${ref} as a local branch?` : `Check out ${ref}?`,
    message: `${remote ? `A local branch ${ref.split("/").slice(1).join("/")} is created to track ${ref}, and` : "The worktree"} ${tildePath(worktreePath())} switches to it.${dirtyNote()}`,
    ok: "Check out",
    run: () => host("/v1/git/checkout", json({ path: worktreePath(), ref })),
    done: (r) => `On ${r.head.branch ?? r.head.sha.slice(0, 7)}`,
  }),
  checkoutCommit: (sha) => act({
    title: `Check out commit ${sha.slice(0, 7)}?`,
    message: `The worktree leaves its branch and sits on this commit ("detached"). Create a branch here to keep new work.${dirtyNote()}`,
    ok: "Check out",
    run: () => host("/v1/git/checkout", json({ path: worktreePath(), ref: sha })),
    done: `On commit ${sha.slice(0, 7)}`,
  }),
  async createBranch(at, { checkout = true } = {}) {
    const name = await ask({ title: "New branch", message: `Starting at ${at.length === 40 ? at.slice(0, 7) : at}.`, value: "", placeholder: "feature/name", ok: checkout ? "Create and check out" : "Create" });
    if (!name) return;
    try {
      if (checkout) await host("/v1/git/checkout", json({ path: worktreePath(), ref: at, create: name }));
      else await host("/v1/git/branch", json({ path: worktreePath(), name, at }));
      toast(`Branch ${name} created`);
    } catch (error) { showError("New branch", error.message); }
    await reload();
  },
  merge: (from) => {
    const into = currentBranch();
    if (!into) return showError("Merge", "Check out a branch to merge into first");
    return act({
      title: `Merge ${from} into ${into}?`,
      message: `Fast-forwards ${into} when it can, otherwise makes a merge commit. If files conflict, the merge stops so you (or an agent) can resolve them, or abort it.${dirtyNote()}`,
      ok: "Merge",
      run: () => host("/v1/git/merge", json({ path: worktreePath(), from })),
      done: (r) => (r.upToDate ? `${into} already has ${from}` : r.fastForward ? `${into} fast-forwarded to ${from}` : `Merged ${from} into ${into}`),
    });
  },
  abortMerge: () => act({
    title: "Abort the merge?",
    message: "The worktree goes back to how it was before the merge started. Conflict resolutions made so far are lost.",
    ok: "Abort merge", danger: true,
    run: () => host("/v1/git/merge/abort", json({ path: worktreePath() })),
    done: "Merge aborted",
  }),
  deleteBranch: async (name) => {
    const merged = await ask({ title: `Delete branch ${name}?`, message: "Only if it is merged; git refuses otherwise. The commits stay reachable from wherever they were merged.", ok: "Delete", danger: true });
    if (!merged) return;
    try {
      await host(`/v1/git/branch?${q({ path: worktreePath(), name })}`, { method: "DELETE" });
      toast(`Branch ${name} deleted`);
    } catch (error) {
      if (/not fully merged/i.test(error.message) && await ask({ title: `${name} is not merged`, message: `Deleting it anyway loses the commits only it has. Delete ${name} for good?`, ok: "Delete anyway", danger: true })) {
        try { await host(`/v1/git/branch?${q({ path: worktreePath(), name, force: 1 })}`, { method: "DELETE" }); toast(`Branch ${name} deleted`); } catch (again) { showError("Delete branch", again.message); }
      } else showError("Delete branch", error.message);
    }
    await reload();
  },
  fetch: () => act({ title: "Fetch from all remotes?", message: "Downloads new commits and branches; your branches and files don't change.", ok: "Fetch", run: () => host("/v1/git/fetch", json({ path: worktreePath() })), done: "Fetched" }),
  pull: () => {
    const status = state.status;
    if (!status?.upstream) return showError("Pull", `${status?.branch ?? "This commit"} has no upstream branch`);
    return act({ title: `Pull ${status.branch} from ${status.upstream}?`, message: `Fast-forward only: if ${status.branch} has commits of its own, git refuses and you merge instead.${dirtyNote()}`, ok: "Pull", run: () => host("/v1/git/pull", json({ path: worktreePath() })), done: "Pulled" });
  },
  push: async (branch = currentBranch()) => {
    if (!branch) return showError("Push", "Check out a branch to push, or choose one");
    const local = state.summary?.branches.find((b) => b.name === branch);
    if (local?.upstream) return act({ title: `Push ${branch} to ${local.upstream}?`, message: "Never forced: if the remote has commits you don't, git refuses and you pull first.", ok: "Push", run: () => host("/v1/git/push", json({ path: worktreePath(), branch: branch === currentBranch() ? undefined : branch, ...(branch === currentBranch() ? {} : { remote: local.upstream.split("/")[0] }) })), done: `Pushed ${branch}` });
    const remotes = state.summary?.remotes ?? [];
    if (!remotes.length) return showError("Push", "This repository has no remote to push to");
    const remote = remotes.length === 1 ? remotes[0].name : await ask({ title: `Push ${branch} to which remote?`, value: remotes[0].name, ok: "Next" });
    if (!remote) return null;
    return act({ title: `Push ${branch} to ${remote}?`, message: `${branch} is published as ${remote}/${branch} and set to track it.`, ok: "Push", run: () => host("/v1/git/push", json({ path: worktreePath(), remote, branch, setUpstream: true })), done: `Pushed ${branch} to ${remote}` });
  },
};

async function addProject() {
  const path = await pickFiles({ mode: "folder", title: "Choose a project folder (a git repository)" });
  if (!path) return;
  try {
    const project = await host("/v1/loom/projects", json({ path }));
    await loadProjects();
    await openProject(project.id);
  } catch (error) { showError(`Add ${tildePath(path)}`, error.message); }
}

function projectMenu(event, project) {
  contextMenu(event, [
    { label: "Rename…", icon: "edit", run: async () => {
      const name = await ask({ title: "Rename project", value: project.name, ok: "Rename" });
      if (!name) return;
      await host("/v1/loom/projects", { method: "PATCH", body: JSON.stringify({ id: project.id, name }) }).catch((error) => toast(error.message));
      await loadProjects();
      if (state.project?.id === project.id) { state.project = state.projects.find((p) => p.id === project.id); renderHeader(); }
    } },
    "-",
    { label: "Remove from Loom", icon: "delete", danger: true, run: async () => {
      if (!(await ask({ title: `Remove ${project.name} from Loom?`, message: "Only Loom forgets it; the repository and its files stay where they are.", ok: "Remove", danger: true }))) return;
      await host(`/v1/loom/projects?${q({ id: project.id })}`, { method: "DELETE" });
      if (state.project?.id === project.id) { state.project = null; localStorage.removeItem("loom.project"); }
      await loadProjects();
      if (!state.project && state.projects[0]) await openProject(state.projects[0].id); else render();
    } },
  ]);
}

/** The menu for a commit, or for one of its refs. */
function commitMenu(event, commit, ref) {
  const items = [];
  const name = ref?.name;
  if (ref?.kind === "branch") {
    if (name !== currentBranch()) items.push({ label: `Check out ${name}`, icon: "call_split", run: () => actions.checkout(name) });
    if (currentBranch() && name !== currentBranch()) items.push({ label: `Merge ${name} into ${currentBranch()}`, icon: "merge", run: () => actions.merge(name) });
    items.push({ label: `Push ${name}`, icon: "cloud_upload", run: () => actions.push(name) });
    items.push("-");
    if (name !== currentBranch()) items.push({ label: `Delete ${name}…`, icon: "delete", danger: true, run: () => actions.deleteBranch(name) });
  } else if (ref?.kind === "remote") {
    items.push({ label: `Check out ${name}`, icon: "cloud_download", run: () => actions.checkout(name, { remote: true }) });
    if (currentBranch()) items.push({ label: `Merge ${name} into ${currentBranch()}`, icon: "merge", run: () => actions.merge(name) });
  }
  if (items.length && items.at(-1) !== "-") items.push("-");
  items.push({ label: "New branch here…", icon: "add", run: () => actions.createBranch(commit.sha) });
  items.push({ label: "Check out this commit", icon: "commit", run: () => actions.checkoutCommit(commit.sha) });
  items.push({ label: "Copy commit id", icon: "content_copy", run: () => { void navigator.clipboard.writeText(commit.sha); toast("Copied"); } });
  contextMenu(event, items.filter((item, i, all) => !(item === "-" && (i === 0 || all[i - 1] === "-"))));
}

function select(sha, { scroll = false } = {}) {
  state.selected = sha;
  for (const row of document.querySelectorAll(".commit-row")) row.setAttribute("aria-selected", String(row.dataset.sha === sha));
  if (scroll) document.querySelector(`.commit-row[data-sha="${sha}"]`)?.scrollIntoView({ block: "center" });
  renderSide();
}

// ------------------------------------------------------------------------------------- render --

function render() {
  renderProjects();
  renderHeader();
  renderViews();
  renderBanner();
  renderContent();
  renderStatus();
}

function renderProjects() {
  $("#project-actions").replaceChildren(iconButton("add", "Add a project", () => void addProject(), { small: true }));
  $("#project-list").replaceChildren(...state.projects.map((project) => h("button.project", {
    type: "button", role: "option", "aria-selected": String(project.id === state.project?.id), title: project.path,
    onclick: () => void openProject(project.id), oncontextmenu: (event) => projectMenu(event, project),
  }, h("strong", {}, project.name), h("span", {}, tildePath(project.path)))));
}

function renderHeader() {
  $("#glyph").replaceChildren(icon("account_tree"));
  $("#title").textContent = state.project?.name ?? "Loom";
  $("#subtitle").textContent = state.project ? tildePath(state.project.path) : "Projects, branches and plans";
  renderActions();
}

function renderActions() {
  const on = Boolean(state.project && state.summary);
  const button = (name, title, run) => { const b = iconButton(name, title, run); b.disabled = !on || state.busy; return b; };
  $("#actions").replaceChildren(...(state.view === "graph" || !views[state.view]?.actions ? [
    button("cloud_download", "Fetch from all remotes", () => void actions.fetch()),
    button("download", "Pull", () => void actions.pull()),
    button("cloud_upload", "Push", () => void actions.push()),
    button("call_split", "New branch", () => void actions.createBranch(state.status?.branch ?? state.summary?.head.sha ?? "HEAD")),
    button("refresh", "Refresh", () => void reload()),
  ] : views[state.view].actions()));
}

function renderViews() {
  $("#views").hidden = Object.keys(views).length < 2 || !state.project;
  $("#views").replaceChildren(...Object.entries(views).map(([id, view]) => h("button", {
    type: "button", role: "tab", "aria-selected": String(id === state.view),
    onclick: () => showView(id),
  }, icon(view.icon), view.label)));
}

function showView(id) {
  state.view = views[id] ? id : "graph";
  localStorage.setItem("loom.view", state.view);
  renderViews();
  renderActions();
  renderContent();
}

function renderBanner() {
  const banner = $("#banner");
  const status = state.status;
  if (state.error) {
    banner.className = "banner error";
    banner.replaceChildren(icon("error"), h("div.grow", {}, h("pre", {}, state.error)), h("button.btn.ghost", { type: "button", onclick: () => { state.error = null; renderBanner(); } }, "Dismiss"));
    banner.hidden = false;
  } else if (status?.merging) {
    banner.className = "banner";
    banner.replaceChildren(icon("merge"),
      h("div.grow", {}, h("strong", {}, "A merge is in progress"), status.conflicts.length ? h("div.files", {}, `Conflicts: ${status.conflicts.map((c) => c.path).join(", ")}`) : h("div", {}, "No conflicts left: commit to finish the merge.")),
      h("button.btn.danger", { type: "button", onclick: () => void actions.abortMerge() }, "Abort merge"));
    banner.hidden = false;
  } else banner.hidden = true;
}

function renderContent() {
  const content = $("#content");
  if (!state.project) {
    content.replaceChildren(h("div.empty-state", {}, icon("account_tree"), h("h2", {}, state.projects.length ? "Choose a project" : "Add your first project"),
      h("p", {}, "A project is a folder with a git repository. Loom shows its branches and commits as a graph, the plans your agents are working on, and who is working where."),
      h("button.btn.primary", { type: "button", onclick: () => void addProject() }, icon("add"), "Add a project")));
    return;
  }
  (views[state.view] ?? views.graph).render(content);
}

function renderGraphView(content) {
  if (!state.graph) { content.replaceChildren(h("div.empty-state", {}, h("p", {}, "Loading…"))); return; }
  const pane = h("div.graph-pane", { tabindex: "0", onkeydown: onGraphKey });
  if (!state.graph.commits.length) pane.append(h("div.empty-state", {}, icon("commit"), h("h2", {}, "No commits yet"), h("p", {}, "The graph fills in with the first commit.")));
  else pane.append(renderGraph(state.graph, {
    head: state.summary?.head.branch, headSha: state.summary?.head.sha, selected: state.selected,
    onSelect: (commit) => select(commit.sha),
    onContext: (event, commit, ref) => { select(commit.sha); commitMenu(event, commit, ref); },
    onMore: () => { state.limit += LIMIT_STEP; void reload(); },
    decorate: (commit) => plans.chips(commit),
  }));
  const side = h("aside.side", { id: "side", "aria-label": "Details" });
  const scroll = document.querySelector(".graph-pane")?.scrollTop ?? 0;
  content.replaceChildren(pane, side);
  pane.scrollTop = scroll;
  renderSide();
}

function onGraphKey(event) {
  const commits = state.graph?.commits ?? [];
  const index = commits.findIndex((c) => c.sha === state.selected);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = commits[Math.max(0, Math.min(commits.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) select(next.sha, { scroll: true });
  }
  if ((event.key === "Home" || event.key === "End") && commits.length) {
    event.preventDefault();
    select(commits[event.key === "Home" ? 0 : commits.length - 1].sha, { scroll: true });
  }
}

function renderSide() {
  const side = $("#side");
  if (!side || !state.summary) return;
  const laneOf = lanes();
  const summary = state.summary;
  const parts = [];
  const commit = state.graph?.commits.find((c) => c.sha === state.selected);
  if (commit) parts.push(commitCard(commit));

  const branch = (b) => h("button.item" + (b.current ? ".current" : ""), {
    type: "button", title: b.subject,
    onclick: () => select(b.sha, { scroll: true }), ondblclick: () => { if (!b.current) void actions.checkout(b.name); },
    oncontextmenu: (event) => { const c = state.graph?.commits.find((x) => x.sha === b.sha) ?? { sha: b.sha }; commitMenu(event, c, { kind: "branch", name: b.name }); },
  }, h("span.lane-dot", { style: { "--lane": `var(--lane-${(laneOf.get(b.sha) ?? 0) % 8})` } }), h("span.name", {}, b.name),
    b.ahead ? h("span.badge.ahead", { title: `${b.ahead} to push` }, `↑${b.ahead}`) : null,
    b.behind ? h("span.badge.behind", { title: `${b.behind} to pull` }, `↓${b.behind}`) : null,
    b.worktree && b.worktree !== (state.worktree ?? summary.root) ? h("span.badge", { title: `Checked out in ${b.worktree}` }, icon("folder_open")) : null,
    b.current ? icon("check") : null);
  parts.push(section("Branches", summary.branches.length, summary.branches.map(branch)));

  if (summary.worktrees.length > 1) parts.push(section("Worktrees", summary.worktrees.length, summary.worktrees.map((tree) => h("button.item" + ((state.worktree ?? summary.root) === tree.path ? ".current" : ""), {
    type: "button", title: tree.path,
    onclick: () => { state.worktree = tree.main ? null : tree.path; void reload(); },
  }, icon("folder_open"), h("span.name", {}, tildePath(tree.path)), h("span.badge", {}, tree.branch ?? (tree.sha ? tree.sha.slice(0, 7) : ""))))));

  if (summary.remoteBranches.length) parts.push(section("Remote branches", summary.remoteBranches.length, summary.remoteBranches.map((b) => h("button.item", {
    type: "button", title: b.subject,
    onclick: () => select(b.sha, { scroll: true }), ondblclick: () => void actions.checkout(b.name, { remote: true }),
    oncontextmenu: (event) => commitMenu(event, state.graph?.commits.find((x) => x.sha === b.sha) ?? { sha: b.sha }, { kind: "remote", name: b.name }),
  }, icon("cloud_download"), h("span.name", {}, b.name)))));

  if (summary.tags.length) parts.push(section("Tags", summary.tags.length, summary.tags.map((tag) => h("button.item", { type: "button", onclick: () => select(tag.sha, { scroll: true }) }, icon("label"), h("span.name", {}, tag.name)))));
  side.replaceChildren(...parts);
}

function section(title, count, items) {
  return h("section", {}, h("h3", {}, title, h("span.count", {}, String(count))), h("div.list", {}, ...items));
}

function commitCard(commit) {
  const branches = commit.refs.filter((r) => r.kind === "branch").map((r) => r.name);
  const buttons = [];
  for (const name of branches) {
    if (name !== currentBranch()) buttons.push(h("button.btn", { type: "button", onclick: () => void actions.checkout(name) }, icon("call_split"), `Check out ${name}`));
    if (currentBranch() && name !== currentBranch()) buttons.push(h("button.btn", { type: "button", onclick: () => void actions.merge(name) }, icon("merge"), `Merge into ${currentBranch()}`));
  }
  buttons.push(h("button.btn", { type: "button", onclick: () => void actions.createBranch(commit.sha) }, icon("add"), "Branch here"));
  return h("div.card", {},
    h("h2", {}, commit.subject),
    h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } }, ...commit.refs.filter((r) => r.kind !== "head").map((r) => refChip(r, { lane: commit.lane, current: r.name === currentBranch() }))),
    h("dl.meta", {},
      h("dt", {}, "Commit"), h("dd.mono", { title: commit.sha }, commit.sha.slice(0, 12)),
      h("dt", {}, "Author"), h("dd", { title: commit.email }, commit.author),
      h("dt", {}, "Date"), h("dd", {}, new Date(commit.date).toLocaleString()),
      h("dt", {}, commit.parents.length > 1 ? "Parents" : "Parent"), h("dd.mono", {}, commit.parents.map((p) => p.slice(0, 7)).join(", ") || "none")),
    h("div.buttons", {}, ...buttons));
}

function renderStatus() {
  const bar = $("#statusbar");
  const status = state.status;
  if (!state.project || !status) { bar.replaceChildren(); return; }
  const changes = status.staged.length + status.changed.length + status.conflicts.length;
  const parts = [
    h("span", { title: worktreePath() }, icon("folder_open"), " ", tildePath(worktreePath())),
    h("span", {}, icon(status.branch ? "call_split" : "commit"), " ", status.branch ?? `detached at ${status.sha?.slice(0, 7) ?? "nothing"}`),
  ];
  if (status.upstream) parts.push(h("span", { title: `Tracking ${status.upstream}` }, `↑${status.ahead} ↓${status.behind} · ${status.upstream}`));
  parts.push(changes || status.untracked.length
    ? h("span.dirty", { title: [...status.staged.map((f) => `staged: ${f.path}`), ...status.changed.map((f) => `changed: ${f.path}`), ...status.untracked.map((f) => `new: ${f.path}`)].slice(0, 40).join("\n") },
      [status.staged.length && `${status.staged.length} staged`, status.changed.length && `${status.changed.length} changed`, status.untracked.length && `${status.untracked.length} new`, status.conflicts.length && `${status.conflicts.length} conflicted`].filter(Boolean).join(" · "))
    : h("span.clean", {}, icon("check"), " Clean"));
  bar.replaceChildren(...parts);
}

// --------------------------------------------------------------------------------- the agent --

registerPage("loom", {
  state: () => ({
    project: state.project ? { id: state.project.id, name: state.project.name, path: state.project.path } : null,
    view: state.view,
    worktree: worktreePath() ?? null,
    branch: state.status?.branch ?? null,
    selected: state.selected,
    clean: state.status?.clean ?? null,
    merging: state.status?.merging ?? false,
    projects: state.projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    ...plans.state(),
  }),
  commands: {
    // openSpace("loom", { project, view }) from the background or the agent.
    async open({ query = {} }) {
      if (query.project) {
        await loadProjects();
        const project = state.projects.find((p) => p.id === query.project || p.path === query.project || p.name === query.project);
        if (project) await openProject(project.id);
      }
      if (query.plan && state.project) await plans.open(query.plan);
      else if (query.view && views[query.view]) showView(query.view);
      return { project: state.project?.id ?? null, view: state.view };
    },
    reload: async () => { await loadProjects(); await reload(); return { ok: true }; },
  },
});

// ----------------------------------------------------------------------------------------- go --

state.view = localStorage.getItem("loom.view") ?? "graph";
void (async () => {
  try { await loadProjects(); } catch (error) { state.error = error.message; render(); return; }
  const last = localStorage.getItem("loom.project");
  const start = state.projects.find((p) => p.id === last) ?? state.projects[0];
  if (start) await openProject(start.id); else render();
})();
