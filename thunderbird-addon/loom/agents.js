// Loom's agents: the list Loom keeps (name, the session it is connected as, its projects), whether
// each one is there right now, and "Ask". Presence comes from listener-mcp, as Agent Chat's does: an
// agent attached to a chat session's group is listening there, and busy while it works on an event.
// Ask reaches an agent in its chat session (a draft quoting the plan or step, for the user to finish
// and send); an agent that is not connected finds the question in Loom's inbox when it joins.
import { broker, host, json } from "../shared/broker.js";
import { icon } from "../shared/icons.js";
import { sessionOfGroup } from "../shared/sessions.js";
import { h, contextMenu, toast, ask as prompt, background } from "../shared/page.js";

const PRESENCE_MS = 5000;

/** ctx: project() the open project, rerender() redraw what shows agents, showError(title, message). */
export function createAgents(ctx) {
  const s = { list: [], presence: new Map(), questions: [] }; // presence: listener agent id → { chat, busy, listening }

  async function load() {
    const project = ctx.project();
    try {
      const [{ agents }, inbox] = await Promise.all([
        host("/v1/loom/agents"),
        project ? host(`/v1/loom/inbox?${new URLSearchParams({ project: project.id, all: "1" })}`) : { questions: [] },
      ]);
      s.list = agents;
      s.questions = inbox.questions;
    } catch (error) { ctx.showError("Agents", error.message); }
  }

  /** Who is attached to which chat session, from the broker (the add-on's own token can read it). */
  async function poll() {
    if (document.hidden) return;
    try {
      const { groups } = await broker("/v1/presence?channel=mail/chat/**");
      const next = new Map();
      for (const group of groups) {
        const chat = sessionOfGroup(group.name);
        if (!chat) continue;
        for (const member of group.members) next.set(member.agent, { chat, busy: member.working_on.length > 0, listening: Boolean(member.waiting) });
      }
      const changed = JSON.stringify([...next]) !== JSON.stringify([...s.presence]);
      s.presence = next;
      if (changed) ctx.rerender();
    } catch { /* the broker is down: everyone shows as away until it is back */ }
  }
  setInterval(() => void poll(), PRESENCE_MS);
  document.addEventListener("visibilitychange", () => void poll());
  void poll();

  const byName = (name) => s.list.find((a) => a.name.toLowerCase() === String(name ?? "").toLowerCase()) ?? null;
  /** "working" (busy in its chat session), "listening" (attached to one), or "away" (nowhere Ask can reach now). */
  function presenceOf(name) {
    const agent = byName(name);
    if (!agent?.session) return { state: "away", agent };
    const live = s.presence.get(agent.session);
    if (!live) return { state: "away", agent };
    return { state: live.busy ? "working" : "listening", chat: live.chat, agent };
  }
  const LABEL = { working: "Working", listening: "Listening", away: "Not connected" };
  const dot = (name) => { const { state } = presenceOf(name); return h(`span.presence.${state}`, { title: LABEL[state] }); };

  /**
   * Ask an agent about a plan or a step (or the project). Connected: the chat opens on its session
   * with the item quoted. Away: the question is written here and waits in Loom's inbox.
   */
  async function askAgent(name, { plan = null, step = null } = {}) {
    const project = ctx.project();
    if (!name) { toast("Nobody works on this yet: choose an agent first"); return; }
    const { state, chat, agent } = presenceOf(name);
    if (!agent) { toast(`${name} has not joined Loom yet: nobody can receive the question`); return; }
    const about = [
      `Loom · ${project.name}`,
      plan ? `plan "${plan.title}"${plan.branch ? ` on ${plan.branch}` : ""}${plan.stage ? ` (${plan.progress} · ${plan.stage})` : ""}` : null,
      step ? `step ${step.id ?? ""} ${step.text}`.replace(/\s+/g, " ") : null,
    ].filter(Boolean).join(" · ");
    if (state !== "away") {
      await background("chat-draft", { session: chat, text: `> ${about}\n\n` });
      toast(`Ask ${agent.name} in the chat: the question is quoted, add yours and send`);
      return;
    }
    const question = await prompt({ title: `Ask ${agent.name}`, message: `${agent.name} is not connected. The question waits in Loom and ${agent.name} sees it on joining. About: ${about}`, value: "", placeholder: "Your question", ok: "Leave the question" });
    if (!question) return;
    try {
      await host("/v1/loom/inbox", json({ agent: agent.name, project: project.id, plan: plan?.title ?? null, step: step?.id ?? null, question }));
      toast(`Queued: ${agent.name} will see it when they join`);
      await load();
      ctx.rerender();
    } catch (error) { ctx.showError(`Ask ${agent.name}`, error.message); }
  }

  async function update(name, changes) {
    try { await host("/v1/loom/agents", { method: "PATCH", body: JSON.stringify({ name, ...changes }) }); await load(); ctx.rerender(); }
    catch (error) { ctx.showError("Agent", error.message); }
  }

  function agentMenu(event, agent) {
    const project = ctx.project();
    const assigned = agent.projects.includes(project.id);
    contextMenu(event, [
      { label: `Ask ${agent.name}…`, icon: "chat", run: () => void askAgent(agent.name) },
      "-",
      assigned
        ? { label: `Take off ${project.name}`, icon: "remove", run: () => void update(agent.name, { projects: agent.projects.filter((p) => p !== project.id) }) }
        : { label: `Assign to ${project.name}`, icon: "add", run: () => void update(agent.name, { projects: [...agent.projects, project.id] }) },
      { label: "Rename…", icon: "edit", run: async () => { const rename = await prompt({ title: "Rename agent", value: agent.name, ok: "Rename" }); if (rename) await update(agent.name, { rename }); } },
      "-",
      { label: `Forget ${agent.name}`, icon: "delete", danger: true, run: async () => {
        if (!(await prompt({ title: `Forget ${agent.name}?`, message: "Loom drops it from its list. Plans keep its name; it comes back when it joins again.", ok: "Forget", danger: true }))) return;
        try { await host(`/v1/loom/agents?${new URLSearchParams({ name: agent.name })}`, { method: "DELETE" }); await load(); ctx.rerender(); } catch (error) { ctx.showError("Agent", error.message); }
      } },
    ]);
  }

  /** The side panel's Agents section: the project's agents first, then the others; what each works on. */
  function section(plans) {
    const project = ctx.project();
    if (!project || !s.list.length) return null;
    const working = (agent) => plans.filter((p) => p.agent?.toLowerCase() === agent.name.toLowerCase() && (p.status === "In progress" || p.status === "Blocked"));
    const ours = s.list.filter((a) => a.projects.includes(project.id) || working(a).length);
    const others = s.list.filter((a) => !ours.includes(a));
    const item = (agent) => {
      const on = working(agent)[0];
      const waiting = s.questions.filter((q) => q.agent === agent.name && !q.answered).length;
      return h("button.item.agent-item", {
        type: "button", title: `${agent.name}: ${LABEL[presenceOf(agent.name).state]}${on ? ` · ${on.title}` : ""}`,
        onclick: (event) => agentMenu(event, agent), oncontextmenu: (event) => agentMenu(event, agent),
      }, dot(agent.name), h("span.name", {}, agent.name),
        on ? h("span.badge", { title: `${on.title}${on.branch ? ` on ${on.branch}` : ""}` }, on.branch ?? on.title) : null,
        waiting ? h("span.badge.ahead", { title: `${waiting} question${waiting > 1 ? "s" : ""} waiting` }, `?${waiting}`) : null);
    };
    return h("section", {},
      h("h3", {}, "Agents", h("span.count", {}, String(ours.length))),
      h("div.list", {}, ...ours.map(item), ...(others.length ? [h("div.subhead", {}, "Other agents"), ...others.map(item)] : [])));
  }

  return {
    load,
    names: () => s.list.map((a) => a.name),
    dot,
    presenceOf,
    ask: askAgent,
    section,
    /** Questions about a plan, newest first. */
    questionsFor: (plan) => s.questions.filter((q) => q.plan && q.plan.toLowerCase() === plan.title.toLowerCase()),
    state: () => ({ agents: s.list.map((a) => ({ name: a.name, presence: presenceOf(a.name).state, projects: a.projects })) }),
  };
}
