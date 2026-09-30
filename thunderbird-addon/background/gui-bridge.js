// Agent → GUI bridge. The add-on attaches to listener-mcp as agent
// "thunderbird:gui" in group "mail-gui" and executes each command event on
// `mail/gui/commands`, replying on the same channel (reply_to = the command).
// The mail-gui MCP server publishes commands and waits for these replies.
//
// Irreversible actions (send, delete, move mail, settings) are shown to the
// user as a confirmation card in the chat dock and run only if approved.
import { broker, json } from "../shared/broker.js";
import { CHAT_SIDE, FILES_SIDE } from "../shared/docks.js";

const AGENT = "thunderbird:gui";
const GROUP = "mail-gui";
const CHANNEL = "mail/gui/commands";
const OWN_PAGES = ["viewer", "artifacts", "paint"];
const PANELS = ["terminal"]; // pages outside the spaces, answered when loaded

let ctx = null;

// ------------------------------------------------------------ commands --

async function pageFor(ref) {
  const at = ref.indexOf(":");
  return at > 0 && !/^c\d+$/.test(ref) ? ref.slice(0, at) : null;
}

async function visiblePages() {
  const docks = await browser.workspace.getDocks();
  const pages = [];
  if (docks.find((d) => d.side === CHAT_SIDE)?.state !== "minimized") pages.push("chat");
  if (docks.find((d) => d.side === FILES_SIDE)?.state !== "minimized") pages.push("files");
  const state = await browser.workspace.getState();
  const url = state.tab?.url ?? "";
  for (const page of OWN_PAGES) if (url.includes(`/${page}.html`)) pages.push(page);
  return pages;
}

async function askUser(summary) {
  // The chat page shows a card with Approve / Decline and resolves with the choice.
  const reply = await ctx.deliver("chat", { type: "confirm", ...summary }, 20).catch(() => null);
  return reply?.approved === true;
}

const commands = {
  async state() {
    const chrome = await browser.workspace.getState();
    const pages = {};
    for (const page of ["chat", "files", ...OWN_PAGES, ...PANELS]) {
      const value = await browser.runtime.sendMessage({ to: page, type: "state" }).catch(() => null);
      if (value && !value.error) pages[page] = value;
    }
    return { ...chrome, pages };
  },

  async snapshot({ query, limit, scope = "visible" }) {
    const pages = scope === "visible" ? await visiblePages() : [];
    const chrome = scope === "pages" ? { items: [] } : await browser.workspace.snapshot({ query, limit });
    const sections = [{ where: "thunderbird", items: chrome.items, truncated: chrome.truncated }];
    for (const page of pages) {
      const value = await browser.runtime.sendMessage({ to: page, type: "snapshot", query, limit: 150 }).catch(() => null);
      if (value?.items) sections.push({ where: page, items: value.items });
    }
    return { sections };
  },

  async act({ ref, action = "click", value, confirmed }) {
    const page = await pageFor(ref);
    if (page) { await announceAgentInput(); return browser.runtime.sendMessage({ to: page, type: "act", ref, action, value }); }
    const verdict = await browser.workspace.act(ref, action, value, { check: true });
    if (verdict.irreversible && !confirmed) {
      const approved = await askUser({ kind: verdict.kind, title: `The agent wants to ${action} “${verdict.name}”`, detail: verdict.reason });
      if (!approved) return { declined: true, reason: "The user declined this action" };
    }
    await announceAgentInput();
    return browser.workspace.act(ref, action, value);
  },

  async key({ combo }) {
    const verdict = await browser.workspace.pressKey(combo, { check: true });
    if (verdict.irreversible) {
      const approved = await askUser({ kind: verdict.kind, title: `The agent wants to press ${combo}`, detail: verdict.reason });
      if (!approved) return { declined: true, reason: "The user declined this action" };
    }
    await announceAgentInput();
    return browser.workspace.pressKey(combo);
  },

  async screenshot({ ref, scale }) {
    const shot = await browser.workspace.screenshot({ ref, scale });
    const bytes = await (await fetch(shot.dataUrl)).blob();
    const blob = await broker(`/v1/blobs?name=screenshot.png&type=image%2Fpng`, { method: "POST", body: bytes, headers: { "content-type": "image/png" } });
    return { width: shot.width, height: shot.height, path: blob.path, blob: blob.id };
  },

  async open({ space, query }) { return ctx.openSpace(space, query); },

  async dock({ dock, side, state, width }) {
    const where = dock === "chat" ? CHAT_SIDE : dock === "files" ? FILES_SIDE : side;
    return browser.workspace.setDock(where, { ...(state ? { state } : {}), ...(width ? { width } : {}) });
  },

  async page({ page, type, ...args }) {
    // Direct commands to an add-on page (viewer, files, artifacts, paint, chat).
    if (OWN_PAGES.includes(page) && type !== "state") await ctx.openSpace(page);
    return ctx.deliver(page, { type, ...args });
  },

  async "mail.select"({ folder, keys }) { await ctx.openSpace("mail"); return browser.workspace.selectMail(folder, keys); },

  async "calendar.goto"({ date, view }) { return browser.workspace.calendarGoto(date, view); },

  async settings({ appearance, codeTheme }) {
    if (appearance) {
      if (!["system", "light", "dark"].includes(appearance)) throw new Error("appearance must be system, light or dark");
      await browser.storage.local.set({ appearance });
      await browser.workspace.setAppearance(appearance);
    }
    if (codeTheme) await browser.storage.local.set({ codeTheme });
    return browser.storage.local.get({ appearance: "system", codeTheme: "one-dark-pro" });
  },

  async terminal({ visible, toggle, maximized, height }) { return browser.workspace.setTerminal({ visible, toggle, maximized, height }); },

  /** Open a terminal in the panel (new tab, or split right/down) and return its id. */
  async "terminal.open"({ placement = "tab", cwd, show = true }) {
    await browser.workspace.setTerminal({ visible: true });
    const result = await ctx.deliver("terminal", { type: "open", placement, cwd }, 60);
    if (!show) await browser.workspace.setTerminal({ visible: false });
    return result;
  },

  async "open-settings"() { await browser.runtime.openOptionsPage(); await browser.workspace.focusOwnTab(); return { ok: true }; },
};

/** Tell every page the agent is about to send input, so user-only controls ignore it. */
const announceAgentInput = (ms = 2500) => browser.runtime.sendMessage({ to: "*", type: "agent-input", ms }).catch(() => {});

async function run(event) {
  const { command, args = {} } = event.data ?? {};
  const handler = commands[command];
  if (!handler) return { ok: false, error: `Unknown GUI command ${command}. Known: ${Object.keys(commands).join(", ")}` };
  try {
    const result = await handler(args);
    if (result?.error) return { ok: false, error: result.error };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message ?? String(error) };
  }
}

// --------------------------------------------------------------- loop ----

async function attach() {
  await broker("/v1/groups", json({ name: GROUP, channels: [CHANNEL], from: "now", durable: true })).catch((error) => { if (error.code !== "group_mismatch") throw error; });
  await broker("/v1/subscriptions", json({ agent: AGENT, group: GROUP, mode: "poll", meta: { app: "thunderbird" } }));
}

async function loop() {
  const waiter = crypto.randomUUID();
  let attached = false;
  for (;;) {
    try {
      if (!attached) { await attach(); attached = true; }
      const { events } = await broker(`/v1/agents/${encodeURIComponent(AGENT)}/next?wait_ms=240000&waiter=${waiter}&max=5`);
      for (const event of events) {
        const reply = await run(event);
        await broker("/v1/events", json({ channel: CHANNEL, type: "result", reply_to: event.id, agent: AGENT, data: reply }));
        await broker("/v1/ack", json({ agent: AGENT, event_ids: [event.id] }));
      }
    } catch (error) {
      if (error.code === "superseded") return; // another Thunderbird window/instance took over
      if (error.status === 404 || error.code === "detached") attached = false;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

export function startGuiBridge(context) {
  ctx = context;
  void loop();
}
