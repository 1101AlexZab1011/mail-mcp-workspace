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
const readAsBase64 = (file) => new Promise((resolvePromise, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
  reader.onload = () => resolvePromise(String(reader.result).split(",", 2)[1]);
  reader.readAsDataURL(file);
});
// Files are uploaded to the local listener as they are picked, so sending only has to
// append their paths — the agent then reads them from disk.
async function attachFiles(files) {
  for (const file of files) {
    try {
      await ensureSettings();
      const saved = await api("/v1/attachments", { method: "POST", body: JSON.stringify({ name: file.name || `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.png`, type: file.type, data: await readAsBase64(file) }) });
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
  text.placeholder = value ? "Write to your agent" : "Agent disconnected";
}
let settings; let cursor = 0;
let selectedSuggestion = 0;
const skills = [
  { command: "/email-start-chat", description: "Start or continue Agent Chat" },
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
const scrollToBottom = () => requestAnimationFrame(() => requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; }));
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
async function hydrateAttachment(tile, file) {
  const name = file.path.split("/").pop();
  tile.title = [name, file.type, file.size].filter(Boolean).join(" · ");
  try {
    await ensureSettings();
    const response = await fetch(`${settings.endpoint}/v1/attachments?path=${encodeURIComponent(file.path)}`, { headers: { authorization: `Bearer ${settings.token}` } });
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
const show = (item, keepPinned = true) => {
  const article = document.createElement("article");
  article.className = `${item.type} markdown`;
  const { body, files } = splitAttachments(item.text);
  renderMarkdown(article, body || (files.length ? "" : item.text));
  renderMessageAttachments(article, files);
  messages.append(article);
  messages.append(typing);
  if (keepPinned) scrollToBottom();
};
const defaultEndpoint = "http://127.0.0.1:46931";
// Storage is a convenience, not a dependency: the panel re-pairs with the listener when it
// is unreadable, so an extension-storage failure cannot take the whole conversation down.
async function storedSettings() {
  try { return await browser.storage.local.get({ endpoint: defaultEndpoint, token: "" }); }
  catch { return { endpoint: defaultEndpoint, token: "" }; }
}
async function loadSettings() {
  settings = await storedSettings();
  if (settings.token) return;
  const response = await fetch(`${settings.endpoint ?? defaultEndpoint}/v1/extension-settings`).catch(() => null);
  if (!response?.ok) return;
  const paired = await response.json();
  settings = { endpoint: paired.endpoint, token: paired.token };
  try { await browser.storage.local.set(settings); } catch { /* pairing is repeated next tick */ }
}
// Pairing must be retried: if the listener is down or restarting when the panel opens,
// a one-shot load would leave the panel stuck on "Connecting…" with no way back.
async function ensureSettings() {
  if (settings?.token) return;
  try { await loadSettings(); } catch { settings = { endpoint: defaultEndpoint, token: "" }; }
  if (!settings?.token) throw new Error("Listener unavailable · retrying");
}
async function api(path, init = {}) {
  if (!settings?.token) throw new Error("Open Settings and add the local listener token.");
  const response = await fetch(`${settings.endpoint}${path}`, { ...init, headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Listener unavailable"); return result;
}
async function refresh() {
  try { await ensureSettings(); const result = await api(`/v1/conversations/default?after=${cursor}`); const pinned = cursor === 0 || atBottom(); for (const item of result.items) { show(item, false); cursor = Math.max(cursor, item.sequence); } setCanSend(Boolean(result.agent_active)); const wasBusy = !typing.hidden; typing.hidden = !result.agent_busy; if ((result.items.length || typing.hidden !== wasBusy) && pinned) scrollToBottom(); connection.textContent = result.agent_busy ? "Agent working…" : result.agent_active ? "Agent active" : "Agent disconnected"; }
  catch (error) {
    setCanSend(false);
    // A failed fetch means the listener is down; either way the user needs the state, not
    // the transport error. Only genuinely unexpected failures keep their message.
    const unreachable = error instanceof TypeError || /NetworkError|Failed to fetch|retrying/i.test(error.message);
    connection.textContent = unreachable ? "Listener unavailable · reconnecting" : `chat: ${error.message}`;
  }
}
document.querySelector("#compose").addEventListener("submit", async (event) => { event.preventDefault(); const value = text.value.trim(); if ((!value && !pending.length) || !canSend) return;
  const withFiles = pending.length ? `${value}${value ? "\n\n" : ""}Attachments:\n${pending.map((file) => `- ${file.path} (${file.type}, ${formatSize(file.size)})`).join("\n")}` : value; try { await ensureSettings(); const item = await api("/v1/messages", { method: "POST", body: JSON.stringify({ conversation_id: "default", text: withFiles }) }); show({ ...item, type: "user" }); cursor = Math.max(cursor, item.sequence); text.value = ""; for (const file of pending) if (file.thumbnail) URL.revokeObjectURL(file.thumbnail); pending.length = 0; renderAttachments(); autosize(); renderPreview(); connection.textContent = "Waiting for agent"; } catch (error) { connection.textContent = error.message; } });
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
autosize();
renderPreview();
void refresh();
setInterval(() => { void refresh(); }, 1500);
