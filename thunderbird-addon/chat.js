// Agent chat, docked on the left. It holds several sessions; each is a listener-mcp
// channel mail/chat/<id>, and the agent's answers come back on the same channel.
import { icon } from "./shared/icons.js";
import { registerPage, watchDockWidth, iconButton, h, agentIsActing, toast, ask } from "./shared/page.js";
import { DEFAULT_SESSION, DEFAULT_SESSIONS, SESSIONS_CHANNEL, chatChannel, newSessionId, nextName, openSession, rememberOpenSession, sessionOfChannel, sessionOfGroup, sessionsFrom } from "./shared/sessions.js";
import { HOST_ENDPOINT } from "./shared/broker.js";
import { CHAT_SIDE, sideIcon } from "./shared/docks.js";

const messages = document.querySelector("#messages");
const connection = document.querySelector("#connection");
const text = document.querySelector("#text");
const suggestions = document.querySelector("#skill-suggestions");
const typing = document.querySelector("#typing");
const sendButton = document.querySelector("#send");
const preview = document.querySelector("#preview");
const attachButton = document.querySelector("#attach");
const fileInput = document.querySelector("#file-input");
const attachmentTray = document.querySelector("#attachments");
const pending = [];

const formatSize = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
// An image is identified by looking at it, not by reading "image.png"; the stored name is
// unique anyway (the listener prefixes an id), so it only appears as a tooltip.
function renderAttachments() {
  attachmentTray.hidden = !pending.length;
  attachmentTray.replaceChildren(...pending.map((file) => {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.title = `${file.name} · ${formatSize(file.size)}`;
    if (file.thumbnail) chip.append(Object.assign(document.createElement("img"), { src: file.thumbnail, alt: file.name }));
    else chip.append(Object.assign(document.createElement("span"), { className: "file-name", textContent: `${file.name} · ${formatSize(file.size)}` }));
    const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "×", title: `Remove ${file.name}`, className: "attachment-remove" });
    remove.addEventListener("click", () => {
      if (file.thumbnail) URL.revokeObjectURL(file.thumbnail);
      pending.splice(pending.indexOf(file), 1);
      renderAttachments();
    });
    chip.append(remove);
    return chip;
  }));
}
// Files are uploaded to the local broker as blobs as they are picked, so sending only has
// to append their paths — the agent then reads them from disk.
async function attachFiles(files) {
  for (const file of files) {
    try {
      await ensureSettings();
      const name = file.name || `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      const saved = await api(`/v1/blobs?name=${encodeURIComponent(name)}&type=${encodeURIComponent(file.type || "application/octet-stream")}`, { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
      pending.push({ ...saved, thumbnail: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
      renderAttachments();
      connection.textContent = `Attached ${saved.name}`;
    } catch (error) { connection.textContent = `chat: ${error.message}`; }
  }
}

marked.setOptions({ gfm: true, breaks: true });
// Message text is rendered as HTML, so every string is sanitised before it reaches the
// DOM — the agent's replies included, since they carry whatever an email quoted.
const mathLanguages = new Set(["latex", "tex", "math"]);
// KaTeX renders after sanitising: it writes its own markup, and running it on
// already-sanitised text keeps untrusted input from reaching innerHTML unchecked.
function typeset(element, source, displayMode) {
  try { katex.render(source, element, { displayMode, throwOnError: false, output: "html" }); }
  catch { element.textContent = source; }
}
function renderMath(target) {
  for (const block of target.querySelectorAll("pre code")) {
    const language = [...block.classList].find((name) => name.startsWith("language-"))?.slice(9);
    if (!mathLanguages.has(language)) continue;
    const rendered = document.createElement("div");
    rendered.className = "math-block";
    typeset(rendered, block.textContent.trim(), true);
    block.closest("pre").replaceWith(rendered);
  }
  // $$…$$ and $…$ inside ordinary text, skipping anything already inside code.
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const pending = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest("code, pre, .math-block")) continue;
    if (/\$\$?[^$]+\$\$?/.test(node.nodeValue)) pending.push(node);
  }
  for (const node of pending) {
    const fragment = document.createDocumentFragment();
    let index = 0;
    for (const match of node.nodeValue.matchAll(/(\$\$)([^$]+?)\1|\$([^$\n]+?)\$/g)) {
      fragment.append(node.nodeValue.slice(index, match.index));
      const span = document.createElement("span");
      typeset(span, (match[2] ?? match[3]).trim(), Boolean(match[2]));
      fragment.append(span);
      index = match.index + match[0].length;
    }
    fragment.append(node.nodeValue.slice(index));
    node.replaceWith(fragment);
  }
}
// Prism has no "svg" grammar — it is markup. Beyond highlighting, an svg block is worth
// showing as the picture it describes, sanitised like any other rendered content.
const grammarFor = (language) => Prism.languages[language === "svg" ? "markup" : language];
function renderSvgPreviews(target) {
  for (const block of target.querySelectorAll("pre code.language-svg")) {
    const figure = document.createElement("div");
    figure.className = "svg-preview";
    figure.innerHTML = DOMPurify.sanitize(block.textContent, { USE_PROFILES: { svg: true, svgFilters: true } });
    if (figure.querySelector("svg")) block.closest("pre").after(figure);
  }
}
// Code is there to be reused, so every block carries a copy button. It sits inside the
// block's own corner rather than in the message, so it follows the code when it wraps.
function addCopyButtons(target) {
  for (const block of target.querySelectorAll("pre")) {
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    block.replaceWith(wrapper);
    wrapper.append(block);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button icon-button";
    button.title = "Copy code";
    button.setAttribute("aria-label", "Copy code");
    button.innerHTML = copyIcon;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(block.textContent);
        button.classList.remove("copied");
        void button.offsetWidth; // restart the animation when copying twice in a row
        button.classList.add("copied");
        button.title = "Copied";
        button.addEventListener("animationend", () => { button.classList.remove("copied"); button.title = "Copy code"; }, { once: true });
      } catch { button.title = "Copy failed"; }
    });
    wrapper.append(button);
  }
}
// A drafted email is shown as an envelope, not as a code block: headers as labelled rows
// and the body rendered, so what you approve is what the recipient will see.
const headerLabels = { to: "To", cc: "Cc", bcc: "Bcc", subject: "Subject", from: "From" };
function renderEmailCards(target) {
  for (const block of target.querySelectorAll("pre code.language-email")) {
    const raw = block.textContent;
    const separator = raw.search(/^---\s*$/m);
    const headerText = separator === -1 ? raw : raw.slice(0, separator);
    const bodyText = separator === -1 ? "" : raw.slice(separator).replace(/^---\s*\n?/, "");
    const card = document.createElement("div");
    card.className = "email-card";
    const headers = document.createElement("dl");
    headers.className = "email-headers";
    for (const line of headerText.split("\n")) {
      const [, key, value] = line.match(/^\s*([A-Za-z-]+)\s*:\s*(.*)$/) ?? [];
      if (!key || !value) continue;
      headers.append(Object.assign(document.createElement("dt"), { textContent: headerLabels[key.toLowerCase()] ?? key }));
      headers.append(Object.assign(document.createElement("dd"), { textContent: value, className: key.toLowerCase() === "subject" ? "email-subject" : "" }));
    }
    card.append(headers);
    const body = document.createElement("div");
    body.className = "email-body markdown";
    body.innerHTML = DOMPurify.sanitize(marked.parse(bodyText));
    card.append(body);
    block.closest("pre").replaceWith(card);
  }
}
function renderMarkdown(target, text) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(text));
  for (const block of target.querySelectorAll("pre code")) {
    const language = [...block.classList].find((name) => name.startsWith("language-"))?.slice(9);
    const grammar = language && !mathLanguages.has(language) && grammarFor(language);
    if (grammar) block.innerHTML = Prism.highlight(block.textContent, grammar, language);
  }
  renderEmailCards(target);
  addCopyButtons(target);
  renderSvgPreviews(target);
  renderMath(target);
}
// Plain prose needs no preview: it would just repeat the composer back at you. The preview
// appears only once the text actually contains markup that renders differently.
const markdownPatterns = [
  /```/, /(^|\s)`[^`\n]+`/, /\*\*[^*\n]+\*\*/, /(^|\s)\*[^*\n]+\*/, /(^|\s)_[^_\n]+_/,
  /~~[^~\n]+~~/, /^#{1,6}\s/m, /^\s*[-*+]\s+\S/m, /^\s*\d+\.\s+\S/m, /^\s*>\s/m,
  /\[[^\]\n]+\]\([^)\n]+\)/, /\$\$?[^$\n]+\$\$?/, /^\s*\|.+\|/m, /^\s*(-{3,}|\*{3,})\s*$/m,
];
const hasMarkdown = (value) => markdownPatterns.some((pattern) => pattern.test(value));
function renderPreview() {
  const value = text.value.trim();
  preview.hidden = !value || !hasMarkdown(value);
  if (!preview.hidden) renderMarkdown(preview, value);
}
// Sending is only allowed while an agent is actually connected: a queued message with
// nobody listening would sit unanswered with no sign of it in the panel.
let canSend = false;
function setCanSend(value) {
  canSend = value;
  sendButton.disabled = !value;
  attachButton.disabled = !value;
  text.placeholder = value ? "Message your agent" : `No agent is listening · start one with /email-start-chat ${currentSession().name}`;
}
function setPresence(kind, label) {
  connection.textContent = label;
  for (const dot of [document.querySelector("#presence-dot"), document.querySelector("#rail-dot")]) {
    dot.classList.toggle("on", kind === "on");
    dot.classList.toggle("busy", kind === "busy");
  }
}
let settings;
let selectedSuggestion = 0;
const skills = [
  { command: "/email-start-chat", description: "Start or continue an Agent Chat session" },
  { command: "/email-review-pending", description: "Review and triage Pending email" },
  { command: "/email-summary", description: "Summarize recent email" },
];
// The composer grows with its content instead of being drag-resized, so a new line
// is always visible rather than pinned against the bottom edge; past max-height it scrolls.
// scrollHeight excludes borders while box-sizing: border-box includes them, so the height
// must add them back — otherwise the final line is pressed against the bottom border.
const autosize = () => {
  text.style.height = "auto";
  text.style.height = `${text.scrollHeight + text.offsetHeight - text.clientHeight}px`;
};
const atBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
// The panel has no layout yet on the first paint, so an immediate scrollTop write is
// discarded and the transcript opens at the oldest message. Defer to the next frame.
const scrollToBottom = () => { following = true; requestAnimationFrame(() => requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; })); };
// Whether the transcript follows new messages is decided by the reader's scrolling, not
// re-measured when a reply arrives: by then late layout (images, highlighted code, a dock
// resize, a minimized panel with no height) has moved the bottom away and the check fails,
// leaving the transcript stuck above every later reply.
let following = true;
messages.addEventListener("scroll", () => { if (messages.clientHeight) following = atBottom(); });
const follow = new ResizeObserver(() => { if (following && messages.clientHeight) messages.scrollTop = messages.scrollHeight; });
follow.observe(messages);
follow.observe(typing);
const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M15 1.25H10.9436C9.10583 1.24998 7.65019 1.24997 6.51098 1.40314C5.33856 1.56076 4.38961 1.89288 3.64124 2.64124C2.89288 3.38961 2.56076 4.33856 2.40314 5.51098C2.24997 6.65019 2.24998 8.10582 2.25 9.94357V16C2.25 17.8722 3.62205 19.424 5.41551 19.7047C5.55348 20.4687 5.81753 21.1208 6.34835 21.6517C6.95027 22.2536 7.70814 22.5125 8.60825 22.6335C9.47522 22.75 10.5775 22.75 11.9451 22.75H15.0549C16.4225 22.75 17.5248 22.75 18.3918 22.6335C19.2919 22.5125 20.0497 22.2536 20.6517 21.6517C21.2536 21.0497 21.5125 20.2919 21.6335 19.3918C21.75 18.5248 21.75 17.4225 21.75 16.0549V10.9451C21.75 9.57754 21.75 8.47522 21.6335 7.60825C21.5125 6.70814 21.2536 5.95027 20.6517 5.34835C20.1208 4.81753 19.4687 4.55348 18.7047 4.41551C18.424 2.62205 16.8722 1.25 15 1.25ZM17.1293 4.27117C16.8265 3.38623 15.9876 2.75 15 2.75H11C9.09318 2.75 7.73851 2.75159 6.71085 2.88976C5.70476 3.02502 5.12511 3.27869 4.7019 3.7019C4.27869 4.12511 4.02502 4.70476 3.88976 5.71085C3.75159 6.73851 3.75 8.09318 3.75 10V16C3.75 16.9876 4.38624 17.8265 5.27117 18.1293C5.24998 17.5194 5.24999 16.8297 5.25 16.0549V10.9451C5.24998 9.57754 5.24996 8.47522 5.36652 7.60825C5.48754 6.70814 5.74643 5.95027 6.34835 5.34835C6.95027 4.74643 7.70814 4.48754 8.60825 4.36652C9.47522 4.24996 10.5775 4.24998 11.9451 4.25H15.0549C15.8297 4.24999 16.5194 4.24998 17.1293 4.27117ZM7.40901 6.40901C7.68577 6.13225 8.07435 5.9518 8.80812 5.85315C9.56347 5.75159 10.5646 5.75 12 5.75H15C16.4354 5.75 17.4365 5.75159 18.1919 5.85315C18.9257 5.9518 19.3142 6.13225 19.591 6.40901C19.8678 6.68577 20.0482 7.07435 20.1469 7.80812C20.2484 8.56347 20.25 9.56458 20.25 11V16C20.25 17.4354 20.2484 18.4365 20.1469 19.1919C20.0482 19.9257 19.8678 20.3142 19.591 20.591C19.3142 20.8678 18.9257 21.0482 18.1919 21.1469C17.4365 21.2484 16.4354 21.25 15 21.25H12C10.5646 21.25 9.56347 21.2484 8.80812 21.1469C8.07435 21.0482 7.68577 20.8678 7.40901 20.591C7.13225 20.3142 6.9518 19.9257 6.85315 19.1919C6.75159 18.4365 6.75 17.4354 6.75 16V11C6.75 9.56458 6.75159 8.56347 6.85315 7.80812C6.9518 7.07435 7.13225 6.68577 7.40901 6.40901Z" clip-rule="evenodd"/></svg>';
const missingFileIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2"/></g></svg>';
const missingImageIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></g></svg>';

// A sent message carries its attachments as a trailing list of paths. The transcript shows
// them as the files they are, so the raw paths are lifted out before the text is rendered.
function splitAttachments(text) {
  const match = text.match(/\n*Attachments:\n((?:- \/\S.*(?:\n|$))+)$/);
  if (!match) return { body: text, files: [] };
  const files = [...match[1].matchAll(/^- (\/\S+?)(?: \(([^,)]+)(?:, ([^)]+))?\))?$/gm)]
    .map((line) => ({ path: line[1], type: line[2] ?? "", size: line[3] ?? "" }));
  return { body: text.slice(0, match.index).trimEnd(), files };
}
// Blob files are named "<id>.<name>", so the path a message carries leads back to its blob.
const blobId = (path) => path.split("/").pop().match(/^(blob_[A-Za-z0-9_-]+)\./)?.[1];
async function hydrateAttachment(tile, file) {
  const id = blobId(file.path);
  const name = id ? file.path.split("/").pop().slice(id.length + 1) : file.path.split("/").pop();
  tile.title = [name, file.type, file.size].filter(Boolean).join(" · ");
  tile.addEventListener("click", () => browser.runtime.sendMessage({ to: "background", type: "open-file", path: file.path }));
  try {
    await ensureSettings();
    let response;
    if (id) response = await fetch(`${settings.endpoint}/v1/blobs/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${settings.token}` } });
    else {
      // A file attached from the file browser lives where it is; the host serves it.
      const link = await fetch(`${HOST_ENDPOINT}/v1/links`, { method: "POST", headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" }, body: JSON.stringify({ path: file.path }) });
      if (!link.ok) throw new Error(String(link.status));
      response = await fetch(`${HOST_ENDPOINT}${(await link.json()).url}`);
    }
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      tile.innerHTML = missingFileIcon;
      tile.classList.add("file-tile");
      tile.append(Object.assign(document.createElement("span"), { className: "file-name", textContent: name }));
      return;
    }
    const image = Object.assign(document.createElement("img"), { src: URL.createObjectURL(blob), alt: name });
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
    tile.replaceChildren(image);
  } catch {
    // The file is gone from disk: show what it was, not a broken image.
    tile.innerHTML = file.type.startsWith("image/") ? missingImageIcon : missingFileIcon;
    tile.classList.add("missing-tile");
    tile.append(Object.assign(document.createElement("span"), { className: "file-name", textContent: `${name} — missing` }));
  }
}
function renderMessageAttachments(article, files) {
  if (!files.length) return;
  const gallery = document.createElement("div");
  gallery.className = "message-attachments";
  for (const file of files) {
    const tile = document.createElement("span");
    tile.className = "attachment-tile";
    gallery.append(tile);
    void hydrateAttachment(tile, file);
  }
  article.append(gallery);
}
// A poll already in flight when the user sends returns the new message too, so the same
// event can arrive from both paths; each broker sequence is drawn once.
const shown = new Set();
const show = (item, keepPinned = true) => {
  if (item.sequence != null) { if (shown.has(item.sequence)) return; shown.add(item.sequence); }
  const article = document.createElement("article");
  article.className = `${item.type} markdown`;
  const { body, files } = splitAttachments(item.text);
  renderMarkdown(article, body || (files.length ? "" : item.text));
  renderMessageAttachments(article, files);
  messages.append(article);
  messages.append(typing);
  follow.observe(article);
  if (keepPinned) scrollToBottom();
};
// Every session is its own listener-mcp channel, mail/chat/<id>. Messages the user sends
// are events on it; the agent's answers are events on it too, marked with the agent that
// published them. One poll over mail/chat/* covers every session and the session list.
let sessions = DEFAULT_SESSIONS;
let sessionsEvent = null;
let current = DEFAULT_SESSION;
let cursor = 0;
let started = false;
const unreadBy = new Map();
let presenceBy = new Map();
const currentSession = () => sessions.find((item) => item.id === current) ?? sessions[0];
const channel = () => chatChannel(current);
const defaultEndpoint = "http://127.0.0.1:47800";
// Storage is a convenience, not a dependency: the panel re-pairs with the broker when it
// is unreadable, so an extension-storage failure cannot take the whole conversation down.
async function storedSettings() {
  try {
    const stored = await browser.storage.local.get({ listenerEndpoint: defaultEndpoint, listenerToken: "" });
    return { endpoint: stored.listenerEndpoint, token: stored.listenerToken };
  } catch { return { endpoint: defaultEndpoint, token: "" }; }
}
async function forgetToken() {
  settings = { endpoint: settings?.endpoint ?? defaultEndpoint, token: "" };
  try { await browser.storage.local.set({ listenerToken: "" }); } catch { /* nothing stored */ }
}
// An extension cannot read the token file, so it takes its token once from an open
// pairing grant (`listener-mcp pair --origin <this extension's origin>`).
async function loadSettings() {
  settings = await storedSettings();
  if (settings.token) return;
  const response = await fetch(`${settings.endpoint}/v1/pair`, { method: "POST" }).catch(() => null);
  if (!response?.ok) return;
  settings = { endpoint: settings.endpoint, token: (await response.json()).token };
  try { await browser.storage.local.set({ listenerEndpoint: settings.endpoint, listenerToken: settings.token }); } catch { /* pairing is repeated next tick */ }
}
// Pairing must be retried: if the broker is down or restarting when the panel opens,
// a one-shot load would leave the panel stuck on "Connecting…" with no way back.
async function ensureSettings() {
  if (settings?.token) return;
  try { await loadSettings(); } catch { settings = { endpoint: defaultEndpoint, token: "" }; }
  if (!settings?.token) throw new Error(`Not paired · run: listener-mcp pair --name thunderbird --origin ${location.origin} --scopes 'publish:mail/chat/**,read:mail/chat/**,blobs'`);
}
async function api(path, init = {}) {
  if (!settings?.token) throw new Error("Open Settings and add the local listener token.");
  const response = await fetch(`${settings.endpoint}${path}`, { ...init, headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const result = await response.json().catch(() => ({}));
  // A revoked or foreign token is dropped, so the next attempt pairs again.
  if (response.status === 401) { await forgetToken(); throw new Error("Pairing expired · retrying"); }
  if (!response.ok) throw new Error(result.error?.message ?? "Listener unavailable");
  return result;
}
const toItem = (event) => ({ type: event.from.agent ? "agent" : "user", text: typeof event.data?.text === "string" ? event.data.text : JSON.stringify(event.data), sequence: event.seq });
// A deleted session's farewell to its agent is protocol, not conversation.
const visible = (event) => event.type !== "session.closed";
const latestEvent = async (pattern) => (await api(`/v1/events?channel=${encodeURIComponent(pattern)}&before=${Number.MAX_SAFE_INTEGER}&limit=1`)).events.at(-1) ?? null;
// Refreshes and session switches run one after another, so a poll never draws one
// session's messages into another's transcript.
let chain = Promise.resolve();
const serial = (task) => (chain = chain.then(task, task));

function applySessions(event) {
  const list = sessionsFrom(event);
  if (event && !list) return;
  sessionsEvent = event;
  sessions = list ?? DEFAULT_SESSIONS;
  for (const id of unreadBy.keys()) if (!sessions.some((item) => item.id === id)) unreadBy.delete(id);
  renderHeader();
  renderMenu();
  // The open session was deleted elsewhere (another panel, an agent): fall back to Agent 1.
  if (started && !sessions.some((item) => item.id === current)) void serial(() => switchTo(DEFAULT_SESSION));
}
// Edits re-read the newest list first and change that, so two writers lose nothing in
// practice (edits are human-paced). The list is republished weekly so the broker's
// retention can never prune it.
async function publishSessions(change) {
  const fresh = sessionsFrom(await latestEvent(SESSIONS_CHANNEL)) ?? DEFAULT_SESSIONS;
  const sent = await api("/v1/events", { method: "POST", body: JSON.stringify({ channel: SESSIONS_CHANNEL, type: "sessions", data: { sessions: change(fresh.map((item) => ({ ...item }))) } }) });
  cursor = Math.max(cursor, sent.seq);
  applySessions(sent);
}
const WEEK = 7 * 86_400_000;

async function loadHistory() {
  for (let after = 0; ;) {
    const { events } = await api(`/v1/events?channel=${channel()}&after=${after}&limit=500`);
    for (const event of events) if (visible(event)) show(toItem(event), false);
    if (events.length < 500) return;
    after = events.at(-1).seq;
  }
}
async function start() {
  const [list, newest] = await Promise.all([latestEvent(SESSIONS_CHANNEL), latestEvent("mail/chat/*")]);
  applySessions(list);
  cursor = newest?.seq ?? 0;
  const remembered = await openSession();
  current = sessions.some((item) => item.id === remembered) ? remembered : DEFAULT_SESSION;
  renderHeader();
  await loadHistory();
  scrollToBottom();
  started = true;
  if (!list || Date.now() - Date.parse(list.created_at) > WEEK) await publishSessions((items) => items);
}
async function switchTo(id) {
  if (id === current) return;
  current = id;
  void rememberOpenSession(id);
  unreadBy.delete(id);
  unread = 0;
  shown.clear();
  messages.replaceChildren(typing);
  renderHeader();
  renderBadge();
  renderMenu();
  await loadHistory();
  scrollToBottom();
  await refresh();
}

// Presence per session, from the groups the mail app profile creates (mail-chat-<id>).
function presenceOf({ groups }) {
  const map = new Map();
  for (const group of groups) {
    const id = sessionOfGroup(group.name);
    if (!id) continue;
    map.set(id, {
      busy: group.members.some((member) => member.working_on.length),
      listening: group.members.some((member) => member.waiting),
      attached: group.members.length > 0,
      agent: group.members[0]?.agent ?? null,
    });
  }
  return map;
}
const agentLabel = (agent) => (!agent ? "No agent" : agent.startsWith("claude:") ? "Claude Code" : agent.startsWith("codex:") ? "Codex" : agent);

async function refresh() {
  try {
    await ensureSettings();
    if (!started) await start();
    const [{ events }, presence] = await Promise.all([api(`/v1/events?channel=mail/chat/*&after=${cursor}&limit=500`), api("/v1/presence?channel=mail/chat/**")]);
    const pinned = following;
    for (const event of events) {
      cursor = Math.max(cursor, event.seq);
      if (event.channel === SESSIONS_CHANNEL) { applySessions(event); continue; }
      const id = sessionOfChannel(event.channel);
      if (!id || !visible(event)) continue;
      if (id === current) {
        show(toItem(event), false);
        // Only replies arriving while the panel is a rail count as unread here.
        if (event.from.agent && document.documentElement.hasAttribute("data-rail")) unread++;
      } else if (event.from.agent) unreadBy.set(id, (unreadBy.get(id) ?? 0) + 1);
    }
    presenceBy = presenceOf(presence);
    const state = presenceBy.get(current) ?? { busy: false, listening: false, attached: false };
    // An attached agent receives the message even if it is between waits right now.
    setCanSend(state.listening || state.busy || state.attached);
    renderBadge();
    renderMenu();
    const wasBusy = !typing.hidden;
    typing.hidden = !state.busy;
    if ((events.length || typing.hidden !== wasBusy) && pinned) scrollToBottom();
    if (state.busy) setPresence("busy", "Working…");
    else if (state.listening) setPresence("on", "Listening");
    else if (state.attached) setPresence("on", "Attached");
    else setPresence("off", "No agent connected");
  } catch (error) {
    setCanSend(false);
    // A failed fetch means the broker is down; either way the user needs the state, not
    // the transport error. Only genuinely unexpected failures keep their message.
    const unreachable = error instanceof TypeError || /NetworkError|Failed to fetch/i.test(error.message);
    setPresence("off", unreachable ? "Listener unavailable · reconnecting" : error.message);
  }
}
document.querySelector("#compose").addEventListener("submit", async (event) => { event.preventDefault(); const value = text.value.trim(); if ((!value && !pending.length) || !canSend) return;
  const withFiles = pending.length ? `${value}${value ? "\n\n" : ""}Attachments:\n${pending.map((file) => `- ${file.path} (${file.type}, ${formatSize(file.size)})`).join("\n")}` : value; try { await ensureSettings(); const sent = await api("/v1/events", { method: "POST", body: JSON.stringify({ channel: channel(), type: "message", data: { text: withFiles } }) }); show(toItem(sent)); text.value = ""; for (const file of pending) if (file.thumbnail) URL.revokeObjectURL(file.thumbnail); pending.length = 0; renderAttachments(); autosize(); renderPreview(); connection.textContent = "Waiting for agent"; } catch (error) { connection.textContent = error.message; } });
// Inside an unclosed ``` fence the composer is a code editor: Enter adds a line and Tab
// indents, instead of sending the message and moving focus.
function insideCodeFence() {
  const before = text.value.slice(0, text.selectionStart);
  return (before.match(/^```/gm) ?? []).length % 2 === 1;
}
const closingFor = { "(": ")", "[": "]", "{": "}", "'": "'", '"': '"' };
// Inside a fence the composer behaves like an editor: a new line keeps the current
// indentation (one level deeper after ":" or an opening brace), and brackets auto-close.
function indentedNewline() {
  const before = text.value.slice(0, text.selectionStart);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  const indent = line.match(/^[ \t]*/)[0];
  const deeper = /[:{[(]\s*$/.test(line) ? "    " : "";
  return `\n${indent}${deeper}`;
}
// A fence only closes at the start of a line, but auto-indent leaves the cursor indented,
// so typing ``` to close a block has to pull the line back to column 0 itself.
function dedentClosingFence() {
  const start = text.selectionStart;
  const lineStart = text.value.lastIndexOf("\n", start - 1) + 1;
  const line = text.value.slice(lineStart, start);
  const match = line.match(/^([ \t]+)(```[^\n]*)$/);
  if (!match) return;
  text.setRangeText(match[2], lineStart, start, "end");
}
function insertAtCursor(value) {
  const { selectionStart: start, selectionEnd: end } = text;
  text.setRangeText(value, start, end, "end");
  autosize();
  renderPreview();
}
function matchingSkills() { const query = text.value.trim().toLowerCase(); return query.startsWith("/") ? skills.filter((skill) => skill.command.startsWith(query)) : []; }
function hideSuggestions() { suggestions.hidden = true; suggestions.replaceChildren(); selectedSuggestion = 0; }
function chooseSuggestion(skill) { text.value = `${skill.command} `; hideSuggestions(); text.focus(); }
function renderSuggestions() {
  const matches = matchingSkills();
  if (!matches.length) return hideSuggestions();
  selectedSuggestion = Math.min(selectedSuggestion, matches.length - 1);
  suggestions.replaceChildren(...matches.map((skill, index) => {
    const item = document.createElement("div"); item.className = "skill-suggestion"; item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(index === selectedSuggestion));
    item.innerHTML = `<span>${skill.command}</span><small>${skill.description}</small>`;
    item.addEventListener("mousedown", (event) => { event.preventDefault(); chooseSuggestion(skill); });
    return item;
  }));
  suggestions.hidden = false;
}
attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => { await attachFiles([...fileInput.files]); fileInput.value = ""; });
text.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  void attachFiles(files);
});
text.addEventListener("scroll", () => text.classList.toggle("scrolled", text.scrollTop > 2));
text.addEventListener("input", () => { dedentClosingFence(); autosize(); renderPreview(); renderSuggestions(); });
text.addEventListener("keydown", (event) => {
  const matches = matchingSkills();
  if (matches.length && event.key === "ArrowDown") { event.preventDefault(); selectedSuggestion = (selectedSuggestion + 1) % matches.length; return renderSuggestions(); }
  if (matches.length && event.key === "ArrowUp") { event.preventDefault(); selectedSuggestion = (selectedSuggestion - 1 + matches.length) % matches.length; return renderSuggestions(); }
  if (matches.length && event.key === "Tab") { event.preventDefault(); return chooseSuggestion(matches[selectedSuggestion]); }
  if (event.key === "Escape") return hideSuggestions();
  if (event.key === "Backspace" && text.selectionStart === text.selectionEnd) {
    const previous = text.value[text.selectionStart - 1];
    if (closingFor[previous] && text.value[text.selectionStart] === closingFor[previous]) {
      event.preventDefault();
      text.setRangeText("", text.selectionStart - 1, text.selectionStart + 1, "end");
      autosize();
      return renderPreview();
    }
  }
  if (insideCodeFence()) {
    if (event.key === "Tab") { event.preventDefault(); return insertAtCursor("    "); }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); return insertAtCursor(indentedNewline()); }
    const next = text.value[text.selectionStart];
    if (Object.values(closingFor).includes(event.key) && next === event.key && text.selectionStart === text.selectionEnd) {
      event.preventDefault();
      text.selectionStart = text.selectionEnd = text.selectionStart + 1;
      return;
    }
    if (closingFor[event.key] && text.selectionStart === text.selectionEnd) {
      event.preventDefault();
      insertAtCursor(event.key + closingFor[event.key]);
      text.selectionStart = text.selectionEnd = text.selectionStart - 1;
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (canSend) document.querySelector("#compose").requestSubmit();
  }
});
document.querySelector("#settings").addEventListener("click", () => browser.runtime.openOptionsPage());

// ---------------------------------------------------------------- dock ----

const railBadge = document.querySelector("#rail-badge");
let unread = 0;
let dockState = "open";
// The rail badge counts unread replies in every session, the open one only while railed.
function renderBadge() {
  const total = unread + [...unreadBy.values()].reduce((sum, count) => sum + count, 0);
  railBadge.hidden = !total;
  railBadge.textContent = String(total);
}
document.querySelector("#avatar").append(icon("smart_toy"));
document.querySelector("#settings").append(icon("settings"));
attachButton.append(icon("attach_file"));
sendButton.append(icon("send", { fill: true }));
document.querySelector("#rail-open").append(icon("forum"));
document.querySelector("#rail-open").addEventListener("click", () => browser.workspace.setDock(CHAT_SIDE, { state: "open" }));
function renderDockActions() {
  const maximized = dockState === "maximized";
  document.querySelector("#dock-actions").replaceChildren(
    document.querySelector("#settings"),
    iconButton(maximized ? "close_fullscreen" : "open_in_full", maximized ? "Restore" : "Maximize", () => browser.workspace.setDock(CHAT_SIDE, { state: maximized ? "open" : "maximized" }), { small: true }),
    iconButton(sideIcon(CHAT_SIDE, "close"), "Minimize (Ctrl+5)", () => browser.workspace.setDock(CHAT_SIDE, { state: "minimized" }), { small: true }),
  );
}
browser.workspace.onDockChanged.addListener((dock) => { if (dock.side === CHAT_SIDE) { dockState = dock.state; renderDockActions(); } });
browser.workspace.getDocks().then((docks) => { dockState = docks.find((d) => d.side === CHAT_SIDE)?.state ?? "open"; renderDockActions(); });
watchDockWidth((rail) => { if (!rail) { unread = 0; renderBadge(); } });

// ------------------------------------------------------------ sessions ----

function renderHeader() {
  const { name } = currentSession();
  document.querySelector("#session-name").textContent = name;
  document.title = name;
  setCanSend(canSend);
}

// The session menu opens from the agent icon: every session with its presence, rename
// and delete per row, and "New session" at the bottom.
const avatar = document.querySelector("#avatar");
let menu = null;
let editing = null;
function closeMenu() {
  menu?.remove();
  menu = null;
  editing = null;
  avatar.setAttribute("aria-expanded", "false");
  removeEventListener("pointerdown", outside, true);
}
function outside(event) { if (menu && !menu.contains(event.target) && !avatar.contains(event.target)) closeMenu(); }
function openMenu() {
  menu = h("div.menu.session-menu", { role: "menu", "aria-label": "Sessions", onkeydown: (event) => { if (event.key === "Escape" && !editing) { closeMenu(); avatar.focus(); } } });
  document.body.append(menu);
  avatar.setAttribute("aria-expanded", "true");
  const rect = avatar.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  renderMenu();
  menu.querySelector(".session-row.current")?.focus();
  setTimeout(() => addEventListener("pointerdown", outside, true));
}
avatar.addEventListener("click", () => (menu ? closeMenu() : openMenu()));

// Polls redraw the open menu for presence and unread counts, but never under the
// cursor of a rename in progress.
function renderMenu() {
  if (!menu || editing) return;
  drawMenu();
}
function drawMenu() {
  const rows = sessions.map((session) => {
    const state = presenceBy.get(session.id);
    const isCurrent = session.id === current;
    const choose = () => { if (editing) return; closeMenu(); void serial(() => switchTo(session.id)); };
    const label = editing === session.id
      ? h("input.input.session-name", {
          type: "text", value: session.name, maxlength: "60", "aria-label": "Session name",
          onclick: (event) => event.stopPropagation(),
          onkeydown: (event) => {
            event.stopPropagation();
            if (event.key === "Enter") { event.preventDefault(); void commitRename(session.id, event.target.value); }
            if (event.key === "Escape") { editing = null; drawMenu(); }
          },
          onblur: (event) => void commitRename(session.id, event.target.value),
        })
      : h("span.name", {}, session.name);
    const count = unreadBy.get(session.id);
    return h(`div.session-row${isCurrent ? ".current" : ""}`, {
      role: "menuitemradio", "aria-checked": String(isCurrent), tabindex: "0", onclick: choose,
      onkeydown: (event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); choose(); } },
    },
      h(`span.dot${state?.busy ? ".busy" : state?.attached ? ".on" : ""}`),
      h("span.session-text", {}, label, h("small", {}, state?.busy ? `${agentLabel(state.agent)} · working` : agentLabel(state?.agent))),
      count ? h("span.badge", { "aria-label": `${count} unread` }, String(count)) : null,
      h("span.row-actions", {},
        iconButton("edit", "Rename", (event) => { event.stopPropagation(); editing = session.id; drawMenu(); }, { small: true }),
        session.id === DEFAULT_SESSION ? null : iconButton("delete", "Delete", (event) => { event.stopPropagation(); void removeSession(session); }, { small: true })));
  });
  menu.replaceChildren(...rows, h("hr"), h("button", { role: "menuitem", type: "button", onclick: () => void createSession() }, icon("add"), "New session"));
  const field = menu.querySelector(".session-name");
  if (field) { field.focus(); field.select(); }
}

async function commitRename(id, value) {
  if (editing !== id) return;
  editing = null;
  const name = value.trim();
  const session = sessions.find((item) => item.id === id);
  if (!session || !name || name === session.name) return drawMenu();
  if (sessions.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) {
    toast(`A session named “${name}” already exists`);
    editing = id;
    return drawMenu();
  }
  try { await publishSessions((items) => items.map((item) => (item.id === id ? { ...item, name } : item))); }
  catch (error) { toast(error.message); }
  if (menu) drawMenu();
}

// A new session opens at once with its name selected, so typing names it.
async function createSession() {
  const id = newSessionId(sessions);
  try {
    await publishSessions((items) => [...items, { id, name: nextName(items) }]);
    await serial(() => switchTo(id));
    if (!menu) openMenu();
    editing = id;
    drawMenu();
  } catch (error) { toast(error.message); }
}

async function removeSession(session) {
  const confirmed = await ask({ title: `Delete “${session.name}”?`, message: "The session leaves the list. An agent attached to it is told to leave.", ok: "Delete", danger: true });
  if (!confirmed) return;
  try {
    await api("/v1/events", { method: "POST", body: JSON.stringify({ channel: chatChannel(session.id), type: "session.closed", data: { text: "This session was deleted." } }) });
    await publishSessions((items) => items.filter((item) => item.id !== session.id));
    unreadBy.delete(session.id);
    renderBadge();
    if (session.id === current) await serial(() => switchTo(DEFAULT_SESSION));
  } catch (error) { toast(error.message); }
}
new ResizeObserver(() => document.documentElement.toggleAttribute("data-narrow", innerWidth < 360)).observe(document.body);

// Confirmation cards: the GUI bridge asks here before irreversible agent actions.
function confirmAction({ kind, title, detail }) {
  if (dockState === "minimized") void browser.workspace.setDock(CHAT_SIDE, { state: "open" });
  return new Promise((resolve) => {
    const card = h("div.confirm-card", { role: "alertdialog", "aria-label": title, "data-user-only": "" });
    const finish = (approved) => {
      // Only the user's own input counts: the agent cannot approve its own request.
      if (approved && agentIsActing()) { toast("This needs your own click"); return; }
      clearTimeout(timer); card.remove(); resolve({ approved });
    };
    const timer = setTimeout(() => finish(false), 5 * 60_000);
    const iconName = { send: "send", delete: "delete", move: "folder_open", settings: "settings" }[kind] ?? "warning";
    card.append(
      h("div.head", {}, icon(iconName), title),
      detail ? h("div.detail", {}, detail) : null,
      h("div.buttons", {},
        h("button.btn", { type: "button", onclick: () => finish(false) }, "Decline"),
        h("button.btn.primary", { type: "button", onclick: () => finish(true) }, "Allow")),
    );
    document.querySelector("#confirmations").append(card);
    card.querySelector(".btn:not(.primary)").focus();
  });
}

async function attachExisting(files, { focus } = {}) {
  for (const file of files) {
    let thumbnail = null;
    if (file.type?.startsWith("image/")) {
      try {
        await ensureSettings();
        const blobId = file.path.split("/").pop().match(/^(blob_[A-Za-z0-9_-]+)\./)?.[1];
        const response = blobId
          ? await fetch(`${settings.endpoint}/v1/blobs/${blobId}`, { headers: { authorization: `Bearer ${settings.token}` } })
          : await fetch(`${HOST_ENDPOINT}${(await (await fetch(`${HOST_ENDPOINT}/v1/links`, { method: "POST", headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" }, body: JSON.stringify({ path: file.path }) })).json()).url}`);
        thumbnail = URL.createObjectURL(await response.blob());
      } catch { thumbnail = null; }
    }
    if (!pending.some((item) => item.path === file.path)) pending.push({ ...file, thumbnail });
  }
  renderAttachments();
  if (focus || dockState === "minimized") await browser.workspace.setDock(CHAT_SIDE, { state: "open" });
  text.focus();
  return { attached: files.length, pending: pending.length };
}

registerPage("chat", {
  state: () => ({
    session: currentSession(),
    sessions,
    status: connection.textContent,
    canSend,
    draft: text.value,
    pendingAttachments: pending.map((file) => file.path),
    dock: dockState,
  }),
  commands: {
    attach: ({ files, focus }) => attachExisting(files ?? [], { focus }),
    confirm: (request) => confirmAction(request),
    focus: () => { text.focus(); return { ok: true }; },
    draft: ({ text: value }) => { text.value = value ?? ""; autosize(); renderPreview(); text.focus(); return { ok: true }; },
  },
});
autosize();
renderPreview();
void serial(refresh);
setInterval(() => { void serial(refresh); }, 1500);
