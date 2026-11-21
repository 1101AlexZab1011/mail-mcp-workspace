// Loom's plans: a board (Ideas → Planned → In progress → Done) and a plan's own page with its steps
// and history. Plans are pages of the project's Plans database in the Notes vault (the host's
// plans.mjs); this draws them and changes them through the host, the same calls the agents make.
import { host } from "../shared/broker.js";
import { icon } from "../shared/icons.js";
import { h, iconButton, contextMenu, ask, background, dropdown } from "../shared/page.js";

/* global marked, DOMPurify */
marked.setOptions({ gfm: true, breaks: false });

const STATUSES = ["Idea", "Queued", "In progress", "Blocked", "Done", "Dropped"];
const PRIORITIES = ["High", "Normal", "Low"];
const COLUMNS = [
  { label: "Ideas", icon: "lightbulb", statuses: ["Idea"], drop: "Idea", add: "New idea" },
  { label: "Planned", icon: "assignment", statuses: ["Queued"], drop: "Queued", add: "New plan" },
  { label: "In progress", icon: "progress_activity", statuses: ["In progress", "Blocked"], drop: "In progress" },
  { label: "Done", icon: "task_alt", statuses: ["Done", "Dropped"], drop: "Done" },
];
const STEP_ICON = { pending: "radio_button_unchecked", running: "progress_activity", done: "check_circle", blocked: "block", skipped: "do_not_disturb_on" };
const STEP_LABEL = { pending: "To do", running: "Running", done: "Done", blocked: "Blocked", skipped: "Skipped" };
const ACTIVE = new Set(["Queued", "In progress", "Blocked"]);
const DRAG = "application/x-loom-plan";

const q = (params) => new URLSearchParams(params).toString();
const markdown = (text) => { const div = h("div.markdown"); div.innerHTML = DOMPurify.sanitize(marked.parse(text)); return div; };
const percent = (progress) => { const [done, all] = String(progress || "0/0").split("/").map(Number); return all ? Math.round((done / all) * 100) : 0; };

/**
 * ctx: project() the open project, branches() its local branch names, rerender() redraw the view and
 * its buttons, showError(title, message), showBranch(name) show a branch in the graph, showView(id),
 * agents (loom/agents.js: names, dot, ask, questionsFor).
 */
export function createPlans(ctx) {
  const s = { list: [], database: null, open: null, plan: null, expanded: new Set(), loaded: false };

  function reset() { Object.assign(s, { list: [], database: null, open: null, plan: null, loaded: false }); s.expanded.clear(); }

  /** The project's plans, and the open plan, again. */
  async function load() {
    const project = ctx.project();
    if (!project) return;
    try {
      const result = await host(`/v1/loom/plans?${q({ project: project.id })}`);
      if (ctx.project() !== project) return;
      Object.assign(s, { list: result.plans, database: result.database, loaded: true });
      if (s.open) {
        s.plan = await host(`/v1/loom/plan?${q({ project: project.id, plan: s.open })}`).catch(() => null);
        if (!s.plan) s.open = null; // renamed or deleted elsewhere
      }
    } catch (error) { ctx.showError("Plans", error.message); }
  }

  /** Change something through the host, then show the plan as it now is. */
  async function change(title, method, path, body) {
    const project = ctx.project();
    try {
      const plan = await host(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ project: project.id, ...body }) });
      if (s.open && plan?.path) { s.plan = plan; s.open = plan.path; }
      await load();
      ctx.rerender();
      return plan;
    } catch (error) { ctx.showError(title, error.message); return null; }
  }
  const update = (plan, changes) => change("Plan", "PATCH", "/v1/loom/plan", { plan, ...changes });
  const step = (plan, body) => change("Step", "POST", "/v1/loom/plan/step", { plan, ...body });

  async function open(id) {
    s.open = id;
    s.plan = await host(`/v1/loom/plan?${q({ project: ctx.project().id, plan: id })}`).catch((error) => { ctx.showError("Plan", error.message); return null; });
    if (!s.plan) s.open = null; else s.open = s.plan.path;
    ctx.showView("plans");
  }
  function close() { s.open = null; s.plan = null; ctx.rerender(); }

  async function create(status) {
    const idea = status === "Idea";
    const title = await ask({ title: idea ? "New idea" : "New plan", message: idea ? "A rough idea: no steps or branch needed yet." : "An exact plan: add its steps on its page.", value: "", placeholder: "Title", ok: "Create" });
    if (!title) return;
    const plan = await change("New plan", "POST", "/v1/loom/plans", { title, status });
    if (plan) await open(plan.path);
  }

  const openInNotes = (path) => void background("open-space", { name: "notes", query: path });

  function planMenu(event, plan) {
    contextMenu(event, [
      { label: "Open", icon: "assignment", run: () => void open(plan.path) },
      ...(plan.agent ? [{ label: `Ask ${plan.agent}…`, icon: "chat", run: () => void ctx.agents.ask(plan.agent, { plan }) }] : []),
      { label: "Open in Notes", icon: "description", run: () => openInNotes(plan.path) },
      ...(plan.branch ? [{ label: `Show ${plan.branch} in the graph`, icon: "account_tree", run: () => ctx.showBranch(plan.branch) }] : []),
      "-",
      ...STATUSES.filter((status) => status !== plan.status).map((status) => ({ label: `Move to ${status}`, icon: status === "Dropped" ? "do_not_disturb_on" : "arrow_forward", run: () => void update(plan.path, { status }) })),
      "-",
      { label: "Rename…", icon: "edit", run: async () => { const title = await ask({ title: "Rename plan", value: plan.title, ok: "Rename" }); if (title) await update(plan.path, { title }); } },
    ]);
  }

  // ------------------------------------------------------------------------------ the board --

  function card(plan) {
    const meta = [
      plan.status === "Blocked" ? h("span.pill.blocked", {}, icon("block"), "Blocked") : null,
      plan.status === "Dropped" ? h("span.pill", {}, "Dropped") : null,
      plan.priority === "High" ? h("span.pill.high", { title: "High priority" }, icon("flag"), "High") : null,
      plan.branch ? h("span.ref.branch", { style: { "--lane": "var(--lane-0)" }, title: plan.branch }, icon("call_split"), h("span.name", {}, plan.branch)) : null,
      plan.agent ? h("span.agent", { title: `Agent: ${plan.agent}` }, ctx.agents.dot(plan.agent), plan.agent) : null,
    ].filter(Boolean);
    return h(`div.plan-card${plan.status === "Blocked" ? ".blocked" : ""}${plan.status === "Dropped" ? ".dropped" : ""}`, {
      role: "button", tabindex: "0", draggable: "true", "aria-label": `${plan.title} · ${plan.status}${plan.progress ? ` · ${plan.progress}` : ""}`,
      onclick: () => void open(plan.path),
      onkeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void open(plan.path); } },
      oncontextmenu: (event) => planMenu(event, plan),
      ondragstart: (event) => { event.dataTransfer.setData(DRAG, plan.path); event.dataTransfer.effectAllowed = "move"; },
    },
      h("div.title", {}, plan.title),
      plan.steps ? h("div.progress", { title: `${plan.progress} steps done` }, h("div.bar", {}, h("span", { style: { width: `${percent(plan.progress)}%` } })), h("span.stage", {}, `${plan.progress} · ${plan.stage}`)) : null,
      meta.length ? h("div.meta", {}, ...meta) : null);
  }

  function renderBoard(content) {
    if (!s.loaded) { content.replaceChildren(h("div.empty-state", {}, h("p", {}, "Loading plans…"))); return; }
    const order = (a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || String(b.updated ?? "").localeCompare(String(a.updated ?? "")) || a.title.localeCompare(b.title);
    const columns = COLUMNS.map((column) => {
      const plans = s.list.filter((p) => column.statuses.includes(p.status)).sort(order);
      const box = h("section.column", {
        "aria-label": column.label,
        ondragover: (event) => { if (event.dataTransfer.types.includes(DRAG)) { event.preventDefault(); box.classList.add("over"); } },
        ondragleave: () => box.classList.remove("over"),
        ondrop: (event) => {
          box.classList.remove("over");
          const path = event.dataTransfer.getData(DRAG);
          const plan = s.list.find((p) => p.path === path);
          if (!plan || column.statuses.includes(plan.status)) return;
          event.preventDefault();
          void update(path, { status: column.drop });
        },
      },
        h("header", {}, icon(column.icon), h("strong", {}, column.label), h("span.count", {}, String(plans.length)), h("span.spacer"),
          column.add ? iconButton("add", column.add, () => void create(column.drop), { small: true }) : null),
        h("div.cards", {}, ...plans.map(card), plans.length ? null : h("p.hint", {}, column.add ? `${column.add}: the + above, or drag a card here` : "Drag a card here")));
      return box;
    });
    content.replaceChildren(h("div.board", {}, ...columns));
  }

  // ---------------------------------------------------------------------------- a plan's page --

  function stepRow(plan, item, index) {
    const open = s.expanded.has(item.id) || item.state === "blocked";
    const setState = (state) => async () => {
      let note;
      if (state === "blocked") { note = await ask({ title: `Blocked: ${item.text}`, message: "What is it waiting for?", value: "", placeholder: "Waiting for…", ok: "Mark blocked" }); if (note === null) return; }
      await step(plan.path, { step: item.id ?? String(index + 1), state, note });
    };
    const menu = (event) => contextMenu(event, [
      ...Object.keys(STEP_ICON).filter((state) => state !== item.state).map((state) => ({ label: STEP_LABEL[state], icon: STEP_ICON[state], run: setState(state) })),
      "-",
      { label: "Add a note…", icon: "edit", run: async () => { const note = await ask({ title: `Note on: ${item.text}`, value: "", ok: "Add" }); if (note) await step(plan.path, { step: item.id ?? String(index + 1), note }); } },
      ...(plan.agent ? [{ label: `Ask ${plan.agent} about this step…`, icon: "chat", run: () => void ctx.agents.ask(plan.agent, { plan, step: item }) }] : []),
    ]);
    return h(`div.step.${item.state}`, { dataset: { step: item.id ?? "" } },
      h("button.state", { type: "button", title: `${STEP_LABEL[item.state]}: change`, "aria-label": `${item.text}: ${STEP_LABEL[item.state]}`, onclick: menu }, icon(STEP_ICON[item.state])),
      h("div.body", {},
        h("div.text", {
          role: item.details ? "button" : null, tabindex: item.details ? "0" : null,
          onclick: () => { if (!item.details) return; if (s.expanded.has(item.id)) s.expanded.delete(item.id); else s.expanded.add(item.id); ctx.rerender(); },
        }, h("span", {}, item.text), item.id ? h("span.id", {}, item.id) : null, item.details ? icon(open ? "keyboard_arrow_down" : "keyboard_arrow_right") : null),
        open && item.details ? markdown(item.details) : null),
      iconButton("more_vert", "Step actions", menu, { small: true }));
  }

  function renderPlan(content) {
    const plan = s.plan;
    const branches = ctx.branches();
    const branchOptions = [["", "No branch"], ...[...new Set([...(plan.branch ? [plan.branch] : []), ...branches])].map((b) => [b, b])];
    const addStep = h("input.input", { type: "text", placeholder: "Add a step…", "aria-label": "New step" });
    const page = h("div.plan-page", {},
      h("div.plan-head", {},
        iconButton("arrow_back", "All plans", close),
        h("h1", { title: "Double-click to rename", ondblclick: async () => { const title = await ask({ title: "Rename plan", value: plan.title, ok: "Rename" }); if (title) await update(plan.path, { title }); } }, plan.title),
        h("span.spacer"),
        plan.agent ? h("button.btn", { type: "button", onclick: () => void ctx.agents.ask(plan.agent, { plan }) }, icon("chat"), `Ask ${plan.agent}`) : null,
        h("button.btn", { type: "button", onclick: () => openInNotes(plan.path) }, icon("description"), "Open in Notes")),
      h("div.plan-fields", {},
        field("Status", dropdown(STATUSES.map((v) => [v, v]), plan.status, (status) => void update(plan.path, { status }), { label: "Status" })),
        field("Branch", h("span.with-button", {},
          dropdown(branchOptions, plan.branch ?? "", (branch) => void update(plan.path, { branch }), { label: "Branch" }),
          plan.branch ? iconButton("account_tree", "Show in the graph", () => ctx.showBranch(plan.branch), { small: true }) : null)),
        field("Agent", h("span.with-button", {}, plan.agent ? ctx.agents.dot(plan.agent) : null, agentPicker(plan))),
        field("Priority", dropdown(PRIORITIES.map((v) => [v, v]), plan.priority, (priority) => void update(plan.path, { priority }), { label: "Priority" })),
        plan.progress ? field("Progress", h("div.progress.wide", {}, h("div.bar", {}, h("span", { style: { width: `${percent(plan.progress)}%` } })), h("span.stage", {}, `${plan.progress} · ${plan.stage}`))) : null),
      plan.description ? markdown(plan.description) : h("p.hint", {}, "No description yet: write it in Notes."),
      h("section.steps", {},
        h("h3", {}, "Steps", h("span.count", {}, plan.progress || "0")),
        ...plan.steps.map((item, i) => stepRow(plan, item, i)),
        h("form.add-step", { onsubmit: async (event) => {
          event.preventDefault();
          const text = addStep.value.trim();
          if (!text) return;
          addStep.value = "";
          await change("Add step", "POST", "/v1/loom/plan/steps", { plan: plan.path, steps: [text] });
          document.querySelector(".add-step input")?.focus();
        } }, icon("add"), addStep, h("button.btn", { type: "submit" }, "Add step"))),
      questions(plan),
      plan.log.length ? h("section.history", {}, h("h3", {}, "History"), h("ul", {}, ...[...plan.log].reverse().map((line) => h("li", {}, line)))) : null);
    content.replaceChildren(page);
  }

  /** The agents Loom knows, nobody, or a name typed in (an agent that has not joined yet). */
  function agentPicker(plan) {
    const names = [...new Set([...(plan.agent ? [plan.agent] : []), ...ctx.agents.names()])];
    return dropdown([["", "Nobody"], ...names.map((n) => [n, n]), ["\u0000other", "Someone else…"]], plan.agent ?? "", async (agent) => {
      if (agent === "\u0000other") {
        const name = await ask({ title: "Who works on this plan?", value: "", placeholder: "Agent name", ok: "Save" });
        if (name) await update(plan.path, { agent: name });
        else ctx.rerender();
        return;
      }
      await update(plan.path, { agent });
    }, { label: "Agent" });
  }

  /** Questions the user left for the plan's agent, and their answers. */
  function questions(plan) {
    const list = ctx.agents.questionsFor(plan);
    if (!list.length) return null;
    const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return h("section.questions", {}, h("h3", {}, "Questions", h("span.count", {}, String(list.length))),
      ...list.map((q) => h(`div.question${q.answered ? ".answered" : ""}`, {},
        h("div.q", {}, icon("help"), h("span", {}, q.question), h("span.when", {}, `${q.step ? `${q.step} · ` : ""}${when(q.asked)}`)),
        q.answered ? h("div.a", {}, h("strong", {}, `${q.by ?? q.agent}: `), markdown(q.answer)) : h("div.a.waiting", {}, `Waiting for ${q.agent} to join`))));
  }

  const field = (label, control) => h("label.field", {}, h("span.label", {}, label), control);

  // --------------------------------------------------------------------------------- outward --

  return {
    reset,
    load,
    open,
    list: () => s.list,
    state: () => ({ plans: s.list.map(({ path, title, status, branch, agent, stage, progress }) => ({ path, title, status, branch, agent, stage, progress })), open: s.plan ? { path: s.plan.path, title: s.plan.title, status: s.plan.status } : null }),
    render: (content) => (s.open && s.plan ? renderPlan(content) : renderBoard(content)),
    actions: () => [
      iconButton("lightbulb", "New idea", () => void create("Idea")),
      iconButton("add", "New plan", () => void create("Queued")),
      iconButton("description", "Open the Plans database in Notes", () => { if (s.database) openInNotes(s.database); }),
    ],
    /** Chips for the graph: each active plan on the row of its branch's head. */
    chips(commit) {
      const branches = new Set(commit.refs.filter((r) => r.kind === "branch").map((r) => r.name));
      return s.list.filter((p) => p.branch && branches.has(p.branch) && ACTIVE.has(p.status)).map((plan) => h(`span.ref.plan${plan.status === "Blocked" ? ".blocked" : ""}`, {
        title: `${plan.title}: ${plan.status}${plan.stage ? ` · ${plan.stage}` : ""}`, role: "button", tabindex: "-1",
        onclick: (event) => { event.stopPropagation(); void open(plan.path); },
      }, icon(plan.status === "Blocked" ? "block" : "assignment"), h("span.name", {}, plan.progress ? `${plan.title} · ${plan.progress}` : plan.title)));
    },
  };
}
