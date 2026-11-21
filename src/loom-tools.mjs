// The loom MCP server's tools: an agent's way into Loom. They talk to the workspace host's
// /v1/loom and /v1/git routes (with the agent's own listener-mcp token), so they work whether or not
// Thoth is open; the Loom screen follows whatever they change. Kept apart from the stdio entry
// (loom-main.mjs) so they can be tested against a real host.
import { resolve, sep } from "node:path";
import { z } from "zod";

const STATUSES = ["Idea", "Queued", "In progress", "Blocked", "Done", "Dropped"];
const PRIORITIES = ["High", "Normal", "Low"];
const STEP_STATES = ["pending", "running", "done", "blocked", "skipped"];

const project = z.string().optional().describe("Project id, name or folder. Default: the Loom project this session's working folder is in");
const plan = z.string().describe("The plan's title (or its page path)");

/**
 * The tools, as { name: { description, input, readOnly, run(params) } }.
 * `call(method, path, body)` reaches the workspace host; `cwd` picks the default project. One server
 * process serves one agent session: loom_join says who it is, and its changes are signed with that name.
 */
export function loomTools({ call, cwd = process.cwd() }) {
  let me = null; // the agent this session joined as
  const q = (params) => new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))).toString();
  const inside = (folder, path) => { const a = resolve(folder).toLowerCase(); const b = resolve(path).toLowerCase(); return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep); };

  async function projects() { return (await call("GET", "/v1/loom/projects")).projects; }

  /** The project named (id, name or folder), else the one the working folder is in. */
  async function find(wanted) {
    const all = await projects();
    if (wanted) {
      const w = String(wanted).trim();
      const found = all.find((p) => p.id === w) ?? all.find((p) => p.name.toLowerCase() === w.toLowerCase()) ?? all.find((p) => inside(p.path, w));
      if (found) return found;
      throw new Error(`No Loom project "${w}". Projects: ${all.map((p) => `${p.name} (${p.id})`).join(", ") || "none yet; add one with loom_project_add"}`);
    }
    const here = all.filter((p) => inside(p.path, cwd)).sort((a, b) => b.path.length - a.path.length)[0];
    if (here) return here;
    throw new Error(`${cwd} is not in a Loom project. Name one (${all.map((p) => p.name).join(", ") || "none yet"}) or add it with loom_project_add`);
  }

  const by = () => me?.name;
  const needJoin = () => { if (!me) throw new Error("Join Loom first: loom_join with your name and session id"); return me; };
  const brief = (p) => ({ title: p.title, status: p.status, stage: p.stage || null, progress: p.progress || null, branch: p.branch, agent: p.agent, priority: p.priority, updated: p.updated });
  const full = (p) => ({ ...brief(p), path: p.path, description: p.description, steps: p.steps.map((s) => ({ id: s.id, state: s.state, text: s.text, ...(s.details ? { details: s.details } : {}) })), log: p.log.slice(-15) });

  return {
    loom_join: {
      description: "Say who you are in Loom, once per session, before changing plans: your name (the user sees it on plans and in Loom's agent list; the same name later means the same agent), your session id (the listener-mcp agent id from your session context, e.g. claude:1234…, so the user's Ask reaches this session), and the projects you work on (default: the one your working folder is in). Returns questions the user left for you while you were away: answer them with loom_inbox.",
      input: {
        name: z.string().describe("Your name, e.g. the one the user calls you"),
        session: z.string().optional().describe("Your listener-mcp agent id, e.g. claude:<session uuid>"),
        projects: z.array(z.string()).optional().describe("Projects (id, name or folder) you are assigned to"),
      },
      run: async ({ name, session, projects: wanted }) => {
        const ids = wanted?.length ? await Promise.all(wanted.map(async (w) => (await find(w)).id)) : await find().then((p) => [p.id], () => []);
        const { agent, questions } = await call("POST", "/v1/loom/agents/join", { name, session, projects: ids });
        me = agent;
        return { agent: { name: agent.name, session: agent.session, projects: agent.projects }, questions };
      },
    },

    loom_inbox: {
      description: "Questions the user asked you through Loom while you were not connected (each about a project, a plan or a step). Answer one with `answer` and its `id`; the answer shows on the plan in Loom. Questions asked while you are connected come through the chat instead.",
      input: {
        answer: z.object({ id: z.string(), text: z.string() }).optional(),
        all: z.boolean().optional().describe("Include answered questions"),
      },
      run: async ({ answer, all }) => {
        const agent = needJoin();
        if (answer) await call("POST", "/v1/loom/inbox/answer", { id: answer.id, answer: answer.text, by: agent.name });
        return { questions: (await call("GET", `/v1/loom/inbox?${q({ agent: agent.name, all: all ? 1 : undefined })}`)).questions };
      },
    },

    loom_projects: {
      description: "The projects in Loom (git repositories the user added), and which one this session's working folder belongs to.",
      input: {}, readOnly: true,
      run: async () => {
        const all = await projects();
        const here = all.filter((p) => inside(p.path, cwd)).sort((a, b) => b.path.length - a.path.length)[0];
        return { projects: all.map((p) => ({ id: p.id, name: p.name, path: p.path })), current: here?.id ?? null };
      },
    },

    loom_project_add: {
      description: "Add a git repository to Loom as a project (any folder inside it works). Adding one twice returns the existing project.",
      input: { path: z.string().describe("A folder in the repository"), name: z.string().optional().describe("Display name; default: the folder's name") },
      run: async ({ path, name }) => call("POST", "/v1/loom/projects", { path, name }),
    },

    loom_status: {
      description: "Where a project stands: the checked-out branch and its worktree state, every branch (ahead/behind, which worktree has it, whether it is already merged into the main line), worktrees, recent commits, the plans that are not finished, and which agents work on what.",
      input: { project, commits: z.number().int().min(0).max(100).optional().describe("Recent commits to include (default 10)") }, readOnly: true,
      run: async ({ project: wanted, commits = 10 }) => {
        const p = await find(wanted);
        const [summary, status, graph, plans, agents] = await Promise.all([
          call("GET", `/v1/git/repo?${q({ path: p.path })}`),
          call("GET", `/v1/git/status?${q({ path: p.path })}`),
          commits ? call("GET", `/v1/git/graph?${q({ path: p.path, limit: commits })}`) : { commits: [] },
          call("GET", `/v1/loom/plans?${q({ project: p.id })}`),
          call("GET", "/v1/loom/agents"),
        ]);
        const working = plans.plans.filter((x) => ["In progress", "Blocked"].includes(x.status));
        const mine = (a, x) => x.agent?.toLowerCase() === a.name.toLowerCase();
        return {
          project: { id: p.id, name: p.name, path: p.path },
          head: summary.head,
          worktree: { branch: status.branch, upstream: status.upstream, ahead: status.ahead, behind: status.behind, clean: status.clean, merging: status.merging, staged: status.staged.length, changed: status.changed.length, untracked: status.untracked.length, conflicts: status.conflicts.map((c) => c.path) },
          branches: summary.branches.map((b) => ({ name: b.name, current: b.current, upstream: b.upstream, ahead: b.ahead, behind: b.behind, worktree: b.worktree ?? null, merged: b.merged ?? false })),
          mainline: summary.mainline,
          worktrees: summary.worktrees.map((w) => ({ path: w.path, branch: w.branch ?? null, main: w.main })),
          commits: graph.commits.map((c) => ({ sha: c.sha.slice(0, 10), subject: c.subject, author: c.author, date: c.date, refs: c.refs.filter((r) => r.kind !== "head").map((r) => r.name) })),
          plans: plans.plans.filter((x) => !["Done", "Dropped"].includes(x.status)).map(brief),
          // Who works where: the project's agents, with the plans they are on and those plans' branches.
          agents: agents.agents.filter((a) => a.projects.includes(p.id) || working.some((x) => mine(a, x)))
            .map((a) => ({ name: a.name, connected: Boolean(a.session), working: working.filter((x) => mine(a, x)).map((x) => ({ plan: x.title, branch: x.branch, stage: x.stage })) })),
        };
      },
    },

    loom_plans: {
      description: "A project's plans (title, status, stage, progress, branch, agent). Filter by status, branch or agent; `query` searches their text (title, description, steps, notes, history).",
      input: {
        project,
        status: z.enum(STATUSES).optional(), branch: z.string().optional(), agent: z.string().optional(),
        query: z.string().optional().describe("Words that must all appear in the plan"),
      }, readOnly: true,
      run: async ({ project: wanted, status, branch, agent, query }) => {
        const p = await find(wanted);
        const { plans } = await call("GET", `/v1/loom/plans?${q({ project: p.id, q: query })}`);
        return { project: p.id, plans: plans.filter((x) => (!status || x.status === status) && (!branch || x.branch === branch) && (!agent || x.agent?.toLowerCase() === agent.toLowerCase())).map(brief) };
      },
    },

    loom_plan_get: {
      description: "One plan in full: description, steps (id, state, text, details), and its recent history.",
      input: { project, plan }, readOnly: true,
      run: async ({ project: wanted, plan: name }) => full(await call("GET", `/v1/loom/plan?${q({ project: (await find(wanted)).id, plan: name })}`)),
    },

    loom_plan_create: {
      description: "Create a plan. With steps it starts Queued (an exact plan); without, it is an Idea (a rough, long-term one). Put the branch on it once work has one. The plan is a page in the user's Notes vault.",
      input: {
        project,
        title: z.string(), description: z.string().optional().describe("What the plan is about, in Markdown"),
        steps: z.array(z.string()).optional().describe("Step texts, in order"),
        status: z.enum(STATUSES).optional(), branch: z.string().optional(), agent: z.string().optional().describe("Who works on it; default: this session's name, if it set one"),
        priority: z.enum(PRIORITIES).optional(),
      },
      run: async ({ project: wanted, agent, ...plan }) => full(await call("POST", "/v1/loom/plans", { project: (await find(wanted)).id, ...plan, agent: agent ?? (plan.steps?.length ? by() : undefined), by: by() })),
    },

    loom_plan_update: {
      description: "Change a plan: status, title, description, priority, the agent on it, or the branch its work is on (empty string removes it).",
      input: {
        project, plan,
        status: z.enum(STATUSES).optional(), title: z.string().optional(), description: z.string().optional(),
        branch: z.string().optional(), agent: z.string().optional(), priority: z.enum(PRIORITIES).optional(),
      },
      run: async ({ project: wanted, plan: name, ...changes }) => full(await call("PATCH", "/v1/loom/plan", { project: (await find(wanted)).id, plan: name, ...changes, by: by() })),
    },

    loom_step: {
      description: "Move a step as you work: running when you start it, done when it is finished, blocked (say why in note) when it waits on someone, skipped if dropped, pending to reopen. A note alone adds details under the step. The plan's status follows: a running step starts it, a blocked one blocks it, the last one done finishes it.",
      input: {
        project, plan,
        step: z.string().describe("The step's id (s3), its number (3) or its text"),
        state: z.enum(STEP_STATES).optional(), note: z.string().optional().describe("Markdown added under the step"),
      },
      run: async ({ project: wanted, plan: name, step, state, note }) => {
        if (!state && !note) throw new Error("Give a state, a note, or both");
        const p = full(await call("POST", "/v1/loom/plan/step", { project: (await find(wanted)).id, plan: name, step, state, note, by: by() }));
        return { title: p.title, status: p.status, stage: p.stage, progress: p.progress, steps: p.steps.map(({ id, state: s, text }) => ({ id, state: s, text })) };
      },
    },

    loom_steps_add: {
      description: "Add steps at the end of a plan (they get ids s1, s2, … in order).",
      input: { project, plan, steps: z.array(z.string()).min(1) },
      run: async ({ project: wanted, plan: name, steps }) => full(await call("POST", "/v1/loom/plan/steps", { project: (await find(wanted)).id, plan: name, steps, by: by() })),
    },

    loom_git: {
      description: "Git actions on a project's worktree, the same ones the user has on Loom's graph: checkout (a branch, a remote branch, or a commit; `create` makes a new branch there), branch (create at a ref without switching), delete_branch (refused if unmerged unless force), merge (into the checked-out branch; conflicts are reported, then resolve and commit, or abort_merge), abort_merge, fetch, pull (fast-forward only unless mode merge), push (sets the upstream the first time). Refused with a reason when the worktree has uncommitted changes that would be lost.",
      input: {
        project,
        action: z.enum(["checkout", "branch", "delete_branch", "merge", "abort_merge", "fetch", "pull", "push"]),
        worktree: z.string().optional().describe("A worktree folder of the project; default: the main one"),
        ref: z.string().optional().describe("checkout: what to check out; branch: where it starts (default HEAD)"),
        name: z.string().optional().describe("branch / delete_branch: the branch; checkout: a new branch to create at ref"),
        from: z.string().optional().describe("merge: the branch or commit to merge in"),
        mode: z.string().optional().describe("merge: auto | ff-only | no-ff; pull: ff-only | merge"),
        force: z.boolean().optional().describe("delete_branch: delete even if not merged"),
        remote: z.string().optional(), branch: z.string().optional().describe("push: which branch (default: the checked-out one)"),
      },
      run: async ({ project: wanted, action, worktree, ref, name, from, mode, force, remote, branch }) => {
        const p = await find(wanted);
        const path = worktree ?? p.path;
        switch (action) {
          case "checkout": return call("POST", "/v1/git/checkout", { path, ref, create: name });
          case "branch": return call("POST", "/v1/git/branch", { path, name, at: ref });
          case "delete_branch": return call("DELETE", `/v1/git/branch?${q({ path, name, force: force ? 1 : undefined })}`);
          case "merge": return call("POST", "/v1/git/merge", { path, from, mode });
          case "abort_merge": return call("POST", "/v1/git/merge/abort", { path });
          case "fetch": return call("POST", "/v1/git/fetch", { path });
          case "pull": return call("POST", "/v1/git/pull", { path, mode });
          case "push": return call("POST", "/v1/git/push", { path, remote, branch, setUpstream: remote ? true : undefined });
          default: throw new Error(`Unknown action ${action}`);
        }
      },
    },
  };
}
