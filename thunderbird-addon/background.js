// Mail Workspace background: installs the layout, owns the spaces, pairs with
// the local listener-mcp broker, and runs the agent's GUI command loop.
import { ensurePaired, host } from "./shared/broker.js";
import { startGuiBridge } from "./background/gui-bridge.js";
import { CHAT_SIDE, FILES_SIDE } from "./shared/docks.js";

const SPACES = [
  { name: "viewer", title: "File viewer (Ctrl+7)", url: "viewer.html", icon: "preview" },
  { name: "artifacts", title: "Artifacts (Ctrl+8)", url: "artifacts.html", icon: "artifact" },
  { name: "paint", title: "Paint (Ctrl+9)", url: "paint.html", icon: "brush" },
  { name: "writer", title: "Writer (Ctrl+Shift+6)", url: "writer.html", icon: "writer" },
  { name: "slides", title: "Slides (Ctrl+Shift+7)", url: "slides.html", icon: "slides" },
  { name: "notes", title: "Notes (Ctrl+Shift+8)", url: "notes.html", icon: "notes" },
];

async function installSpaces() {
  for (const space of SPACES) {
    const props = {
      title: space.title,
      defaultIcons: `icons/${space.icon}.svg`,
    };
    try {
      // spaces.update takes the space's id, not its name; look it up first.
      const [existing] = await browser.spaces.query({ name: space.name });
      if (!existing) await browser.spaces.create(space.name, space.url, props);
      else {
        // A space can survive while its button is gone (e.g. the add-on was reloaded with the space
        // open); updating it then fails. Recreate it.
        try { await browser.spaces.update(existing.id, props); }
        catch (error) {
          console.warn(`Mail Workspace: recreating the ${space.name} space`, error);
          await browser.spaces.remove(existing.id).catch(() => {});
          await browser.spaces.create(space.name, space.url, props);
        }
      }
      // Or the update "succeeds" and still no button shows: forget that space and make it again.
      if (!(await browser.workspace.spaceShown(space.name))) {
        console.warn(`Mail Workspace: the ${space.name} button was missing; making it again`);
        await browser.workspace.dropSpace(space.name);
        await browser.spaces.create(space.name, space.url, props);
      }
    } catch (error) { console.error(`Mail Workspace: could not install the ${space.name} space`, error); }
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

let viewerLeft = null;
/** Which files each editor edits (for the viewer → editor handoff). */
const EDITS = {
  writer: /\.(qmd|md|markdown|rmd)$/i,
  slides: /\.(slides\.json|pptx)$/i,
  paint: /\.(png|jpe?g|webp|bmp|gif)$/i,
};

// Requests from the add-on's pages.
const pageRequests = {
  "open-file": ({ path }) => openSpace("viewer", path),
  "open-document": ({ path }) => openSpace(/\.(slides\.json|pptx)$/i.test(path) ? "slides" : "writer", path),
  "attach-to-chat": ({ files }) => deliver("chat", { type: "attach", files }),
  "open-space": ({ name, query }) => openSpace(name, query),
  "set-dock": ({ side, change }) => browser.workspace.setDock(side, change),
  // The File viewer reports its document when the user leaves it; an editor shown right after (the user
  // switched to it) opens that document if it edits that kind of file.
  "viewer-left": ({ path }) => { viewerLeft = path ? { path, at: Date.now() } : null; },
  "viewer-handoff": ({ editor, vault }) => {
    const left = viewerLeft;
    // Notes takes the Markdown pages of its vault.
    const edits = editor === "notes" ? Boolean(vault) && left?.path.startsWith(`${vault}/`) && /\.md$/i.test(left.path) : EDITS[editor]?.test(left?.path ?? "");
    if (!left || Date.now() - left.at > 4000 || !edits) return { path: null };
    viewerLeft = null;
    return { path: left.path };
  },
  "chat-draft": async ({ text }) => {
    await browser.workspace.setDock(CHAT_SIDE, { state: "open" });
    return deliver("chat", { type: "draft", text });
  },
  "files-reveal": async ({ path }) => {
    const docks = await browser.workspace.getDocks();
    if (docks.find((d) => d.side === FILES_SIDE)?.state === "minimized") await browser.workspace.setDock(FILES_SIDE, { state: "open" });
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

// "Save to Notes" on messages: a page in the vault's Mail folder with the sender, date, text and a link back.
const MENU_SAVE_TO_NOTES = "save-to-notes";
function messageText(part) {
  if (!part) return { plain: "", html: "" };
  if (part.parts?.length) {
    const kids = part.parts.map(messageText);
    return { plain: kids.map((k) => k.plain).find(Boolean) ?? "", html: kids.map((k) => k.html).find(Boolean) ?? "" };
  }
  if (part.contentType === "text/plain" && part.body) return { plain: part.body, html: "" };
  if (part.contentType === "text/html" && part.body) return { plain: "", html: part.body };
  return { plain: "", html: "" };
}
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
  for (const block of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4")) block.append("\n");
  return (doc.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
/** Mail text as Markdown that reads like the mail: its line breaks kept, "> " quotes as quotes, nothing turned into a heading. */
function emailMarkdown(text) {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, "").replace(/^(\s*)(#{1,6}\s)/, "$1\\$2").replace(/^(\s*)([-=]{2,})$/, "$1\\$2"));
  return lines.map((line, i) => (line && lines[i + 1] ? `${line}  ` : line)).join("\n");
}
export async function saveMessageToNotes(messageId) {
  const header = await browser.messages.get(messageId);
  const full = await browser.messages.getFull(messageId);
  const { plain, html } = messageText(full);
  const text = (plain || (html ? htmlToText(html) : "")).replace(/\r\n/g, "\n").trim();
  const { root } = await host("/v1/notes/vault");
  const date = new Date(header.date);
  const page = await host("/v1/notes/new", { method: "POST", body: JSON.stringify({
    title: header.subject || "(no subject)",
    folder: `${root}/Mail`,
    properties: { type: "email", from: header.author, date: date.toISOString().slice(0, 10), message: header.headerMessageId ? `mid:${header.headerMessageId}` : undefined, tags: ["email"] },
    body: `> From **${header.author}**, ${date.toLocaleString()}\n\n${emailMarkdown(text)}\n`,
  }) });
  await openSpace("notes", page.path);
  return page;
}
function installMenus() {
  if (!browser.menus) return;
  browser.menus.create({ id: MENU_SAVE_TO_NOTES, title: "Save to Notes", contexts: ["message_list"], icons: { 16: "icons/notes.svg" } });
  browser.menus.onClicked.addListener(async (info) => {
    if (info.menuItemId !== MENU_SAVE_TO_NOTES) return;
    for (const message of info.selectedMessages?.messages ?? []) {
      try { await saveMessageToNotes(message.id); } catch (error) { console.error("Mail Workspace: Save to Notes failed", error); }
    }
  });
}

async function start() {
  const pages = { [CHAT_SIDE]: browser.runtime.getURL("chat.html?dock=1"), [FILES_SIDE]: browser.runtime.getURL("files.html") };
  // Each step on its own: a failure in one must never keep the agent's GUI bridge from starting.
  const step = (name, run) => Promise.resolve().then(run).catch((error) => console.error(`Mail Workspace: ${name} failed`, error));
  await step("layout", () => browser.workspace.install({ filesSide: FILES_SIDE, terminalUrl: browser.runtime.getURL("terminal.html"), leftUrl: pages.left, rightUrl: pages.right }));
  await step("spaces", installSpaces);
  await step("menus", installMenus);
  await step("legacy tabs", closeLegacyChatTabs);
  await ensurePaired().catch(() => {});
  startGuiBridge({ openSpace, deliver });
}

void start();
