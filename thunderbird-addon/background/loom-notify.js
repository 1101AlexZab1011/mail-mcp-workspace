// Loom's notifications: when an agent moves a plan (it blocks, finishes, reaches a new stage) or
// answers a question, the user hears of it even with Loom closed. The host keeps a log of what
// happened to plans (/v1/loom/events); this follows it with a long poll. Changes the user made
// themselves (no agent behind them) are not announced back to them.
//
// What is announced is the user's choice, kept in storage.local.loomNotify:
//   "important" (default): blocked and finished plans, and answers
//   "all": every status and stage change too
//   "off"
import { host } from "../shared/broker.js";

export const LOOM_NOTIFY = "loomNotify";
const PREFIX = "loom:";
const RETRY_MS = 15_000;

/** The notification for an event, or null when the setting leaves it out. */
export function loomNotice(event, setting) {
  if (setting === "off" || !event.by) return null;
  const where = `${event.projectName}${event.title ? ` · ${event.title}` : ""}`;
  if (event.kind === "answer") return { title: `${event.by} answered`, message: `${where}\n${event.question}\n→ ${event.answer}` };
  if (event.kind === "status" && event.status === "Blocked") return { title: `${event.title} is blocked`, message: `${event.projectName} · ${event.stage ?? ""}${event.note ? `\n${event.by}: ${event.note}` : ""}` };
  if (event.kind === "status" && event.status === "Done") return { title: `${event.title} is done`, message: `${event.projectName}${event.progress ? ` · ${event.progress} steps` : ""} · ${event.by}` };
  if (setting !== "all") return null;
  if (event.kind === "status") return { title: `${event.title}: ${event.status}`, message: `${event.projectName} · ${event.from} → ${event.status} · ${event.by}` };
  if (event.kind === "stage") return { title: `${event.title}: ${event.progress ?? ""}`, message: `${event.projectName} · now: ${event.stage} · ${event.by}` };
  if (event.kind === "created") return { title: `New plan: ${event.title}`, message: `${event.projectName} · ${event.status} · ${event.by}` };
  return null;
}

export function startLoomNotifications({ openSpace }) {
  const shown = new Map(); // notification id → event, for clicks
  browser.notifications.onClicked.addListener((id) => {
    const event = shown.get(id);
    if (!event) return;
    void openSpace("loom", event.plan ? { project: event.project, plan: event.plan } : { project: event.project, view: "plans" });
    void browser.notifications.clear(id);
  });

  void (async () => {
    let epoch;
    let since = -1; // the first answer only tells where the log is: nothing older is announced
    for (;;) {
      try {
        const params = new URLSearchParams({ since: String(Math.max(since, 0)), wait: since < 0 ? "0" : "50000", ...(epoch ? { epoch } : {}) });
        const log = await host(`/v1/loom/events?${params}`);
        const fresh = since >= 0 && log.epoch === epoch;
        if (fresh) {
          const { [LOOM_NOTIFY]: setting = "important" } = await browser.storage.local.get(LOOM_NOTIFY);
          for (const event of log.events) {
            const notice = loomNotice(event, setting);
            if (!notice) continue;
            const id = `${PREFIX}${log.epoch}:${event.seq}`;
            shown.set(id, event);
            if (shown.size > 50) shown.delete(shown.keys().next().value);
            await browser.notifications.create(id, { type: "basic", iconUrl: browser.runtime.getURL("icons/thoth.svg"), title: notice.title, message: notice.message });
          }
        }
        epoch = log.epoch;
        since = log.seq;
      } catch {
        await new Promise((r) => setTimeout(r, RETRY_MS)); // the host is down or restarting
      }
    }
  })();
}
