// Mail Workspace background: installs the layout, owns the spaces, pairs with
// the local listener-mcp broker, and runs the agent's GUI command loop.
import { ensurePaired } from "./shared/broker.js";
import { startGuiBridge } from "./background/gui-bridge.js";

const SPACES = [
  { name: "viewer", title: "Files", url: "viewer.html", icon: "preview" },
  { name: "artifacts", title: "Artifacts", url: "artifacts.html", icon: "artifact" },
  { name: "paint", title: "Paint", url: "paint.html", icon: "brush" },
];

async function installSpaces() {
  for (const space of SPACES) {
    const props = {
      title: space.title,
      defaultIcons: `icons/${space.icon}.svg`,
    };
    try { await browser.spaces.create(space.name, space.url, props); }
    catch { await browser.spaces.update(space.name, props).catch(() => {}); }
  }
}

export async function openSpace(name, query = "") {
  const space = SPACES.find((candidate) => candidate.name === name);
  if (!space) return browser.workspace.openSpace(name);
  const [found] = await browser.spaces.query({ name: space.name });
  if (!found) throw new Error(`The ${name} space is not installed`);
  await browser.spaces.open(found.id);
  // A query (e.g. which file to show) is delivered to the page once it is up.
  if (query) await deliver(space.name, { type: "open", query });
  await browser.workspace.focusOwnTab();
  return { space: name };
}

/** Send a message to an add-on page, retrying while it is still loading. */
export async function deliver(page, message, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const reply = await browser.runtime.sendMessage({ to: page, ...message });
      if (reply !== undefined) return reply;
    } catch { /* page not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`The ${page} page did not answer`);
}

async function closeLegacyChatTabs() {
  const url = browser.runtime.getURL("chat.html");
  const tabs = await browser.tabs.query({});
  const stale = tabs.filter((tab) => tab.url?.startsWith(url)).map((tab) => tab.id);
  if (stale.length) await browser.tabs.remove(stale).catch(() => {});
}

browser.workspace.onShortcut.addListener((name) => { void openSpace(name); });

// Requests from the add-on's pages.
const pageRequests = {
  "open-file": ({ path }) => openSpace("viewer", path),
  "attach-to-chat": ({ files }) => deliver("chat", { type: "attach", files }),
  "open-space": ({ name, query }) => openSpace(name, query),
  "set-dock": ({ side, change }) => browser.workspace.setDock(side, change),
  "files-reveal": async ({ path }) => {
    const docks = await browser.workspace.getDocks();
    if (docks.find((d) => d.side === "right")?.state === "minimized") await browser.workspace.setDock("right", { state: "open" });
    const parent = path.replace(/\/[^/]+$/, "") || "/";
    await deliver("files", { type: "navigate", path: parent });
    return deliver("files", { type: "select", paths: [path] });
  },
};
browser.runtime.onMessage.addListener((message) => {
  if (message?.to !== "background") return undefined;
  const handler = pageRequests[message.type];
  if (!handler) return Promise.resolve({ error: `Unknown request ${message.type}` });
  return Promise.resolve(handler(message)).then((value) => value ?? { ok: true }, (error) => ({ error: error.message }));
});

async function start() {
  await browser.workspace.install({ leftUrl: browser.runtime.getURL("chat.html?dock=1"), rightUrl: browser.runtime.getURL("files.html") });
  await installSpaces();
  await closeLegacyChatTabs();
  await ensurePaired().catch(() => {});
  startGuiBridge({ openSpace, deliver });
}

void start();
