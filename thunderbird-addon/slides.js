// Slides space: presentations in a Google-Slides-like editor (vendor/slides, our PPTist fork), kept
// in `name.slides.json` files with media in `media/` next to them.
//
// The file on disk is the source of truth. This page loads it into the editor, saves with the
// lost-update guard, merges outside edits (the agent's, or another program's) by slide and element
// id, and reloads live. The agent works through the page while a deck is open (its edits become one
// undo step for the user) and through the host otherwise (src/workspace/slides.mjs).
import { host, HOST_ENDPOINT } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, background, toast, registerPage, ask } from "./shared/page.js";
import { applyOps, isDeckPath, isRelativeMedia, mapMedia, mergeDecks, newDeck, parseDeck, serializeDeck, summarize, extensionForMime, EXTENSION } from "./vendor/slides-core/slides-core.mjs";

const SAVE_DELAY = 1000;
const BACKUPS = "~/.local/state/mail-workspace/slides-backups";
const SHOTS = "~/.cache/mail-workspace/slides-shots";

const ui = { app: $("#app"), start: $("#start"), bar: $("#bar") };

const doc = {
  path: null,     // absolute path of the open deck
  hash: null,     // version on disk we last read or wrote (sent as `expect`)
  base: null,     // that version, parsed (media as on disk)
  baseText: null, // and its text
  status: "idle", // idle | saved | unsaved | saving | conflict | error
  backedUp: new Set(),
};
let saveTimer = null;
let saving = null;
let watchToken = 0;
let applying = false; // true while we load a deck into the editor ourselves

// Media: files next to the deck are shown through blob URLs (fetched once); saving maps them back.
const mediaUrl = new Map(); // absolute path → blob URL
const mediaRef = new Map(); // blob URL → reference as written in the file

// ---------------------------------------------------------------- helpers --

const dirOf = (path) => path.replace(/\/[^/]+$/, "") || "/";
const nameOf = (path) => path.split("/").pop();
const tilde = (path) => path.replace(/^\/home\/[^/]+/, "~");
const deckName = (path) => nameOf(path).replace(/\.slides\.json$/i, "");
const isLocal = (ref) => isRelativeMedia(ref) || (typeof ref === "string" && (ref.startsWith("/") || ref.startsWith("~/")));
const absolute = (ref) => (ref.startsWith("/") || ref.startsWith("~/") ? ref : `${dirOf(doc.path)}/${ref.replace(/^\.\//, "")}`);

async function waitForEditor() {
  while (!window.pptist) await new Promise((r) => setTimeout(r, 30));
  await window.pptist.ready;
  return window.pptist;
}
const pptist = await waitForEditor();

async function recent() {
  const { "slides.recent": list = [] } = await browser.storage.local.get("slides.recent").catch(() => ({}));
  return list;
}
async function remember(path) {
  const list = (await recent()).filter((p) => p !== path);
  list.unshift(path);
  await browser.storage.local.set({ "slides.recent": list.slice(0, 12), "slides.last": path }).catch(() => {});
}

// ----------------------------------------------------------------- media --

/** A blob URL for a local media file (relative to the deck, or absolute). */
async function loadMedia(ref) {
  const full = absolute(ref);
  if (mediaUrl.has(full)) return mediaUrl.get(full);
  const link = await host("/v1/links", { method: "POST", body: JSON.stringify({ path: full }) });
  const blob = await (await fetch(`${HOST_ENDPOINT}${link.url}`)).blob();
  const url = URL.createObjectURL(blob);
  mediaUrl.set(full, url);
  mediaRef.set(url, ref);
  return url;
}

/** The deck as the editor shows it: local media replaced by blob URLs (missing files stay as they are). */
async function forDisplay(deck) {
  const refs = new Set();
  mapMedia(deck, (ref) => { if (isLocal(ref)) refs.add(ref); return ref; });
  const loaded = new Map();
  await Promise.all([...refs].map(async (ref) => loaded.set(ref, await loadMedia(ref).catch(() => null))));
  return mapMedia(deck, (ref) => loaded.get(ref) ?? ref);
}

/** The deck as the file holds it: blob URLs back to their references. */
const forDisk = (deck) => ({ ...mapMedia(deck, (ref) => mediaRef.get(ref) ?? ref), format: undefined });

async function sha(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Write bytes to a file through the host (raw upload: no size-inflating base64). */
const writeBytes = (path, blob, { expect, createDirs = false } = {}) =>
  host(`/v1/fs/raw?${new URLSearchParams({ path, ...(expect ? { expect } : {}), ...(createDirs ? { createDirs: "1" } : {}) })}`, { method: "PUT", body: blob });

/**
 * Pasted, dropped, imported or template images arrive inline (data: or unknown blob: URLs). Write
 * each into media/ (named by content, so repeats are stored once) and point the editor at it.
 */
async function internalize() {
  const deck = pptist.getDeck();
  const inline = new Set();
  mapMedia(deck, (ref) => { if (typeof ref === "string" && (ref.startsWith("data:") || (ref.startsWith("blob:") && !mediaRef.has(ref)))) inline.add(ref); return ref; });
  if (!inline.size) return false;
  const replaced = new Map();
  for (const ref of inline) {
    const blob = await (await fetch(ref)).blob().catch(() => null);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = `media/${await sha(bytes)}.${extensionForMime(blob.type)}`;
    await writeBytes(`${dirOf(doc.path)}/${name}`, blob, { createDirs: true });
    const url = URL.createObjectURL(blob);
    mediaUrl.set(absolute(name), url);
    mediaRef.set(url, name);
    replaced.set(ref, url);
  }
  if (!replaced.size) return false;
  // Swap in place (no new undo step): same deck, its media now in files.
  applying = true;
  try { await pptist.setDeck(mapMedia(pptist.getDeck(), (ref) => replaced.get(ref) ?? ref), { history: false }); }
  finally { applying = false; }
  return true;
}

// ------------------------------------------------------------------ status --

const status = { chip: h("span.chip", { hidden: true }), path: h("span.path") };
const hostLeft = h("div.host-file", {}, status.chip, status.path);
const hostRight = h("div.host-actions", {},
  iconButton("note_add", "New presentation", () => void newDeckDialog(), { small: true }),
  iconButton("folder_open", "Open a presentation", () => void openDialog(), { small: true }),
  iconButton("save", "Save (Ctrl+S)", () => void save(), { small: true }),
);
function mountHeader() {
  document.querySelector("#pptist-host-left")?.replaceChildren(hostLeft);
  document.querySelector("#pptist-host-right")?.replaceChildren(hostRight);
}
// The editor re-renders its header when it shows or leaves the slideshow; put our parts back.
new MutationObserver(() => { if (!hostLeft.isConnected || !hostRight.isConnected) mountHeader(); }).observe(ui.app, { childList: true, subtree: true });

function setStatus(state, detail = "") {
  doc.status = state;
  const label = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", conflict: "Changed on disk", error: "Not saved" }[state];
  status.chip.hidden = !label;
  status.chip.textContent = label ?? "";
  status.chip.className = `chip ${state === "saved" ? "saved" : state === "unsaved" || state === "saving" ? "unsaved" : "warning"}`;
  status.chip.title = detail;
}

function showBar(message, buttons = [], danger = false) {
  ui.bar.hidden = false;
  ui.bar.className = `slides-bar${danger ? " danger" : ""}`;
  ui.bar.replaceChildren(h("span", {}, message), ...buttons.map(([label, run], i) => h(`button.btn${i === 0 ? ".primary" : ""}`, { type: "button", onclick: run }, label)));
}
const hideBar = () => { ui.bar.hidden = true; };

// -------------------------------------------------------------------- open --

// Agent commands wait while a deck is opening (its media can take a while to load).
let opening = null;
async function settled() { while (opening) await opening.catch(() => {}); }

async function open(path) {
  const task = openNow(path);
  opening = task;
  try { return await task; } finally { if (opening === task) opening = null; }
}

async function openNow(path) {
  if (!path) return showStart();
  if (doc.path && doc.status === "unsaved") await save();
  const info = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch((error) => { toast(error.message); return null; });
  if (!info || info.directory) return showStart();
  if (/\.pptx$/i.test(info.path)) return importPptx(info.path);
  if (!isDeckPath(info.path)) { await background("open-file", { path: info.path }); return { opened: "viewer", path: info.path }; }
  const file = await host(`/v1/fs/read?path=${encodeURIComponent(info.path)}&limit=${50 * 1024 * 1024}`);
  if (file.truncated) { toast("This deck is too large to open"); return showStart(); }
  let deck;
  try { deck = parseDeck(file.text); } catch (error) { toast(error.message); return showStart(); }
  for (const url of mediaUrl.values()) URL.revokeObjectURL(url);
  mediaUrl.clear();
  mediaRef.clear();
  Object.assign(doc, { path: info.path, hash: file.hash, base: deck, baseText: file.text });
  applying = true;
  try { await pptist.setDeck(await forDisplay(deck), { history: "reset" }); }
  finally { applying = false; }
  pptist.select({ slide: 0 });
  ui.start.hidden = true;
  ui.app.hidden = false;
  status.path.textContent = tilde(info.path);
  status.path.title = info.path;
  document.title = `${deck.title || deckName(info.path)} · Slides`;
  setStatus("saved");
  hideBar();
  mountHeader();
  await remember(info.path);
  void watch();
  // A deck that still holds inline media (e.g. written by another tool) gets it moved to files.
  if (await internalize()) await save();
  return { opened: "slides", path: info.path, slides: deck.slides.length };
}

/** Import a PowerPoint file into a new deck next to it (name.slides.json). */
async function importPptx(path) {
  let target = path.replace(/\.pptx$/i, EXTENSION);
  const exists = await host(`/v1/fs/stat?path=${encodeURIComponent(target)}`).then(() => true, () => false);
  if (exists) {
    const choice = await ask({ title: "Import PowerPoint", message: `${nameOf(target)} already exists. Open it, or import into a new deck under another name:`, value: target.replace(/\.slides\.json$/i, " (2).slides.json"), ok: "Import" });
    if (!choice) return open(target);
    target = choice.endsWith(EXTENSION) ? choice : `${choice}${EXTENSION}`;
  }
  const link = await host("/v1/links", { method: "POST", body: JSON.stringify({ path }) });
  const blob = await (await fetch(`${HOST_ENDPOINT}${link.url}`)).blob();
  await host("/v1/slides/new", { method: "POST", body: JSON.stringify({ path: target, title: nameOf(path).replace(/\.pptx$/i, "") }) });
  await open(target);
  const ok = await pptist.importPPTX(blob, nameOf(path));
  if (!ok) { toast("Could not read this PowerPoint file"); return { imported: false }; }
  pptist.stores.slides().setTitle(nameOf(path).replace(/\.pptx$/i, ""));
  await internalize();
  await save();
  toast(`Imported ${nameOf(path)} into ${nameOf(target)}`);
  return { opened: "slides", path: target, imported: path, slides: pptist.state().slideCount };
}

// -------------------------------------------------------------------- save --

const currentDisk = () => forDisk(pptist.getDeck());
const unsaved = () => doc.path && serializeDeck(currentDisk()) !== doc.baseText;

pptist.onChange(() => {
  if (!doc.path || applying) return;
  if (!unsaved()) { if (doc.status === "unsaved") setStatus("saved"); return; }
  setStatus("unsaved");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), SAVE_DELAY);
});

async function save({ force = false } = {}) {
  clearTimeout(saveTimer);
  if (!doc.path) return { saved: false };
  if (saving) await saving;
  saving = (async () => {
    await internalize();
    const deck = currentDisk();
    const text = serializeDeck(deck);
    if (text === doc.baseText && !force) { setStatus("saved"); return { saved: true, unchanged: true }; }
    setStatus("saving");
    try {
      await backup();
      const result = await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: doc.path, text, expect: doc.hash }) });
      Object.assign(doc, { hash: result.hash, base: deck, baseText: text });
      setStatus(unsaved() ? "unsaved" : "saved");
      document.title = `${deck.title || deckName(doc.path)} · Slides`;
      return { saved: true };
    } catch (error) {
      if (error.status === 409) return reconcile();
      setStatus("error", error.message);
      toast(`Not saved: ${error.message}`);
      return { saved: false, error: error.message };
    }
  })();
  try { return await saving; } finally { saving = null; }
}

/** First save of a session: keep a copy of the file as it was. */
async function backup() {
  if (doc.backedUp.has(doc.path)) return;
  doc.backedUp.add(doc.path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: `${BACKUPS}/${nameOf(doc.path)}.${stamp}`, text: doc.baseText, createDirs: true }) }).catch(() => {});
}

/** Show a deck from disk in the editor, as one undo step (so the user can undo an outside change). */
async function showDeck(deck) {
  applying = true;
  try { await pptist.setDeck(await forDisplay(deck), { history: true }); }
  finally { applying = false; }
}

/** The file changed under us: merge by slide and element; on a clash the user's version wins. */
async function reconcile() {
  const file = await host(`/v1/fs/read?path=${encodeURIComponent(doc.path)}&limit=${50 * 1024 * 1024}`).catch(() => null);
  if (!file) { setStatus("error", "The file was removed"); showBar("The deck was moved or deleted on disk.", [["Save here again", () => { doc.hash = "absent"; hideBar(); return save({ force: true }); }]], true); return { saved: false }; }
  let theirs;
  try { theirs = parseDeck(file.text); } catch (error) { setStatus("conflict"); showBar(`The file on disk is no longer a deck (${error.message}).`, [["Overwrite with mine", () => { doc.hash = file.hash; hideBar(); return save({ force: true }); }]], true); return { saved: false }; }
  const { deck, conflicts } = mergeDecks(doc.base, currentDisk(), theirs);
  Object.assign(doc, { hash: file.hash, base: theirs, baseText: file.text });
  await showDeck(deck);
  if (conflicts.length) toast(`Merged changes from disk; where both changed the same thing (${conflicts.length}), yours was kept`, { ms: 5000 });
  return save();
}

/** Live reload: wait for the file to change on disk, then fold the change in. */
async function watch() {
  const token = ++watchToken;
  const path = doc.path;
  while (token === watchToken && doc.path === path) {
    const change = await host(`/v1/fs/watch?path=${encodeURIComponent(path)}&since=${doc.hash}&wait=25000`).catch(() => null);
    if (token !== watchToken || doc.path !== path) return;
    if (!change) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    if (change.hash === doc.hash || saving) continue;
    if (change.absent) { setStatus("error", "The file was removed"); continue; }
    if (unsaved()) { await reconcile(); continue; }
    const file = await host(`/v1/fs/read?path=${encodeURIComponent(path)}&limit=${50 * 1024 * 1024}`).catch(() => null);
    if (!file || file.hash === doc.hash) continue;
    let deck;
    try { deck = parseDeck(file.text); } catch { continue; }
    Object.assign(doc, { hash: file.hash, base: deck, baseText: file.text });
    await showDeck(deck);
    setStatus("saved");
    toast("Updated from disk", { ms: 1800 });
  }
}

// ------------------------------------------------------------ start screen --

async function showStart() {
  ui.app.hidden = true;
  ui.start.hidden = false;
  document.title = "Slides";
  const list = await recent();
  ui.start.replaceChildren(h("div.inner", {},
    h("h2", {}, icon("slides"), "Presentations"),
    h("p", {}, "Make slides by hand, like in Google Slides, with the agent beside you: it can read every slide, see what you select, and add or change anything. Decks are .slides.json files; PowerPoint files import and export."),
    h("div.buttons", {},
      h("button.btn.primary", { type: "button", onclick: () => void newDeckDialog() }, icon("note_add", { size: 18 }), "New presentation"),
      h("button.btn", { type: "button", onclick: () => void openDialog() }, icon("folder_open", { size: 18 }), "Open…"),
      h("button.btn", { type: "button", onclick: () => void importDialog() }, icon("upload", { size: 18 }), "Import PowerPoint…")),
    ...(list.length ? [h("h3", {}, "Recent"), h("div.recent", {}, ...list.map((path) => h("button", { type: "button", onclick: () => void open(path) }, icon("slides"), h("div", { style: { minWidth: 0 } }, h("div.name", {}, deckName(path)), h("div.path", {}, tilde(dirOf(path)))))))] : []),
  ));
  return { opened: null };
}

async function openDialog() {
  const path = await ask({ title: "Open a presentation", message: "Path of a .slides.json (or .pptx to import)", value: doc.path ? `${dirOf(doc.path)}/` : "~/", ok: "Open" });
  if (path) await open(path);
}

async function importDialog() {
  const path = await ask({ title: "Import PowerPoint", message: "Path of a .pptx file", value: doc.path ? `${dirOf(doc.path)}/` : "~/", ok: "Import" });
  if (path) await importPptx(path);
}

async function newDeckDialog(path) {
  const chosen = path ?? await ask({ title: "New presentation", message: "Where to create it", value: doc.path ? `${dirOf(doc.path)}/untitled${EXTENSION}` : `~/Documents/untitled${EXTENSION}`, ok: "Create" });
  if (!chosen) return null;
  const file = chosen.endsWith(EXTENSION) ? chosen : `${chosen.replace(/\.json$/i, "")}${EXTENSION}`;
  try { await host("/v1/slides/new", { method: "POST", body: JSON.stringify({ path: file }) }); }
  catch (error) { toast(error.status === 409 ? "That file already exists" : error.message); return null; }
  return open(file);
}

// ------------------------------------------------------------------- hooks --

let lastExport = null;
pptist.hooks.saveFile = async (blob, name) => {
  try { await saveExport(blob, name); }
  catch (error) { lastExport?.reject(error); toast(`Export not saved: ${error.message}`); }
};
async function saveExport(blob, name) {
  if (!doc.path) throw new Error("Open a deck first");
  // Next to the deck, never over an existing file (it may be the PowerPoint the deck came from).
  const extension = name.split(".").pop();
  let target;
  for (let n = 1; ; n++) {
    target = `${dirOf(doc.path)}/${deckName(doc.path)}${n > 1 ? ` (${n})` : ""}.${extension}`;
    try { await writeBytes(target, blob, { expect: "absent" }); break; }
    catch (error) { if (error.status !== 409 || n > 50) throw error; }
  }
  lastExport?.resolve(target);
  toast(`Saved ${nameOf(target)} next to the deck`, { ms: 4000 });
}

pptist.hooks.rewrite = async (text, command) => (await host("/v1/slides/rewrite", { method: "POST", body: JSON.stringify({ text, command, path: doc.path }) })).text;

const quote = (text) => text.split("\n").map((line) => `> ${line}`).join("\n");

/** A picture of the slide (or element) for the agent, saved where the chat can attach it. */
async function savedShot(options) {
  const dataUrl = await pptist.shot({ scale: 1, ...options });
  const path = `${SHOTS}/${Date.now()}.png`;
  await writeBytes(path, await (await fetch(dataUrl)).blob(), { createDirs: true });
  return (await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`)).path;
}

function contextText(context, request = "") {
  const where = `slide ${context.slideIndex + 1} of ${nameOf(doc.path ?? "the deck")}`;
  if (context.motion) {
    const { kind, name, definition } = context.motion;
    return `${request || `About the custom ${kind}`}\n\nThe custom ${kind} "${name || "(new)"}" in ${nameOf(doc.path ?? "the deck")} (previewed on ${where}), as it stands in the editor:\n\n\`\`\`json\n${definition}\n\`\`\`\n\n`;
  }
  const parts = [request ? `${request}\n\nOn ${where}` : `About ${where}`];
  if (context.elements.length) {
    parts[0] += context.elements.length === 1 ? `, this ${context.elements[0].type} (id ${context.elements[0].id}):` : `, these ${context.elements.length} elements:`;
    for (const element of context.elements) parts.push(`${context.elements.length > 1 ? `- ${element.type} ${element.id}:\n` : ""}${element.text ? quote(element.text) : `(${element.type}, no text)`}`);
  } else parts[0] += ":";
  return `${parts.join("\n\n")}\n\n`;
}

async function toChat(context, request) {
  const picture = await savedShot({ slide: context.slideId, overlay: context.elements.length === 0 }).catch(() => null);
  if (picture) await background("attach-to-chat", { files: [{ path: picture, name: `slide-${context.slideIndex + 1}.png`, type: "image/png" }] });
  await background("chat-draft", { text: contextText(context, request) });
}
pptist.hooks.discuss = (context) => void toChat(context);
pptist.hooks.ask = async (context) => {
  const request = await ask({ title: "Ask the agent", message: context.motion ? `What should the agent do with this ${context.motion.kind}?` : context.elements.length ? `What should the agent do with the selected ${context.elements.length === 1 ? context.elements[0].type : "elements"}?` : `What should the agent do on slide ${context.slideIndex + 1}?`, value: "", placeholder: "e.g. make this a two-column layout", ok: "Send to chat" });
  if (request) await toChat(context, request);
};

// ------------------------------------------------------------------ scripts --
// Script elements run in a sealed frame served by the host (/s/<id>/: no network, no access to the add-on).
// Code that arrives from elsewhere runs only after the user trusts it, once per deck and script version;
// scripts written here (in the editor, or by the agent through this page) are trusted as they are saved.

const deckDir = () => dirOf(doc.path);
const scriptPath = (src) => (src.startsWith("/") ? src : `${deckDir()}/${src.replace(/^\.\//, "")}`);
async function hashText(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function trustedHashes() {
  const { "slides.trust": all = {} } = await browser.storage.local.get("slides.trust").catch(() => ({}));
  return all;
}
async function trust(hashes) {
  const all = await trustedHashes();
  all[doc.path] = [...new Set([...(all[doc.path] ?? []), ...hashes])].slice(-200);
  await browser.storage.local.set({ "slides.trust": all }).catch(() => {});
}
const readScript = async (src) => (await host(`/v1/fs/read?path=${encodeURIComponent(scriptPath(src))}`)).text;
async function writeScript(src, code) {
  if (!/\.js$/i.test(src) || src.startsWith("/") || src.split("/").includes("..")) throw new Error("A script's src is a .js path inside the deck's folder");
  await host("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path: scriptPath(src), text: code, createDirs: true }) });
  await trust([await hashText(code)]);
  return src;
}

const declined = new Set();
let asking = null;
/**
 * May the deck's scripts run? Asks once for all its untrusted scripts; "Not now" holds for this session.
 * Without prompt (the agent's check runs), it only answers whether they are trusted already.
 */
async function scriptTrust({ prompt = true } = {}) {
  if (!doc.path || declined.has(doc.path)) return false;
  if (!prompt) {
    const known = new Set((await trustedHashes())[doc.path] ?? []);
    for (const src of new Set(pptist.getDeck().slides.flatMap((slide) => slide.elements.filter((el) => el.type === "script").map((el) => el.src)))) {
      const code = await readScript(src).catch(() => null);
      if (code !== null && !known.has(await hashText(code))) return false;
    }
    return true;
  }
  if (asking) return asking;
  asking = (async () => {
    const known = new Set((await trustedHashes())[doc.path] ?? []);
    const scripts = [...new Set(pptist.getDeck().slides.flatMap((slide) => slide.elements.filter((el) => el.type === "script").map((el) => el.src)))];
    const pending = [];
    for (const src of scripts) {
      const code = await readScript(src).catch(() => null);
      if (code === null) continue;
      const hash = await hashText(code);
      if (!known.has(hash)) pending.push({ src, hash });
    }
    if (!pending.length) return true;
    const ok = await ask({
      title: "Run this deck's scripts?",
      message: `${deckName(doc.path)} contains ${pending.length === 1 ? "a script" : `${pending.length} scripts`} that ${pending.length === 1 ? "was" : "were"} not written here: ${pending.map((p) => p.src).join(", ")}. Scripts draw and animate on slides. They run sealed off: no network, no access to your files, mail or the add-on.`,
      ok: "Run scripts",
    });
    if (!ok) { declined.add(doc.path); return false; }
    await trust(pending.map((p) => p.hash));
    return true;
  })();
  try { return await asking; } finally { asking = null; }
}

pptist.hooks.scriptTrust = (element, options) => scriptTrust(options);
pptist.hooks.readScript = readScript;
pptist.hooks.writeScript = async (src, code) => { await writeScript(src, code); };
pptist.hooks.scriptFrame = async (element, code) => {
  const { url } = await host("/v1/slides/script", { method: "POST", body: JSON.stringify({ deck: doc.path, src: element.src, code, libs: element.libs ?? [] }) });
  return `${HOST_ENDPOINT}${url}`;
};
pptist.hooks.scriptData = async (path) => {
  const link = await host("/v1/links", { method: "POST", body: JSON.stringify({ path: scriptPath(path) }) });
  const response = await fetch(`${HOST_ENDPOINT}${link.url}`);
  return /\.(json|csv|tsv|txt|md)$/i.test(path) ? response.text() : response.arrayBuffer();
};
const STARTER_SCRIPT = `// A script: it draws in its box on the slide. slide.canvas() (or slide.svg()) gives the drawing surface;
// slide.onEnter runs when the slide shows, slide.onStep(n) on each click (set Steps); slide.theme has the deck's colours.
const canvas = slide.canvas()
const ctx = canvas.getContext('2d')
const { width, height } = slide

slide.onEnter(() => {
  slide.requestFrame(function draw(t) {
    ctx.clearRect(0, 0, width, height)
    const r = (Math.min(width, height) / 3) * (0.8 + 0.2 * Math.sin(t / 400))
    ctx.fillStyle = slide.theme.themeColors?.[0] ?? '#4557d6'
    ctx.beginPath()
    ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2)
    ctx.fill()
    if (t < 4000) slide.requestFrame(draw)
  })
})
`;
pptist.hooks.createScript = async () => {
  for (let n = 1; ; n++) {
    const src = `scripts/script-${n}.js`;
    const exists = await host(`/v1/fs/stat?path=${encodeURIComponent(scriptPath(src))}`).then(() => true, () => false);
    if (!exists) return writeScript(src, STARTER_SCRIPT);
  }
};
/** A poster picture into media/, shown through a blob URL (mapped back to its file when saving). */
async function savePoster(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const name = `media/${await sha(new Uint8Array(await blob.arrayBuffer()))}.png`;
  await writeBytes(`${deckDir()}/${name}`, blob, { createDirs: true });
  const url = URL.createObjectURL(blob);
  mediaUrl.set(absolute(name), url);
  mediaRef.set(url, name);
  return url;
}
pptist.hooks.savePoster = savePoster;

// System fonts join the editor's font list.
host("/v1/slides/fonts").then(({ fonts }) => pptist.addFonts(fonts), () => {});

// ---------------------------------------------------------------- keyboard --

addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
}, true);
// Saving on hide (not beforeunload: a pending unload handler blocks add-on reloads).
addEventListener("pagehide", () => { if (doc.status === "unsaved") void save(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && doc.status === "unsaved") void save(); });

// --------------------------------------------------------------- agent API --

async function requireDeck() {
  await settled();
  if (!doc.path) throw new Error("No deck is open in Slides");
}

/** Natural size of an image reference (for ops that give only a width or a height). */
async function imageSize(src) {
  const url = isLocal(src) ? await loadMedia(src).catch(() => null) : src;
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => null);
  return img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null;
}

registerPage("slides", {
  state: () => {
    if (opening) return { path: doc.path, loading: true };
    if (!doc.path) return { path: null };
    const state = pptist.state();
    const deck = currentDisk();
    const slide = deck.slides[state.slideIndex];
    const selected = summarize(deck, { from: state.slideIndex, to: state.slideIndex }).slides[0]?.elements.filter((e) => state.selected.includes(e.id)) ?? [];
    return {
      path: doc.path, status: doc.status, unsavedChanges: unsaved(), title: deck.title,
      slide: { index: state.slideIndex, id: slide?.id, count: state.slideCount, elements: slide?.elements.length ?? 0 },
      selected, selectedSlides: state.selectedSlides, canvas: state.canvas, presenting: state.screening,
    };
  },
  commands: {
    open: ({ path, query }) => open(path ?? query),
    new: ({ path }) => newDeckDialog(path),
    import: ({ path }) => importPptx(path),
    save: () => save(),
    read: async ({ first, last, html }) => { await requireDeck(); return summarize(currentDisk(), { from: first, to: last, html }); },
    inspect: async ({ id }) => {
      await requireDeck();
      for (const [index, slide] of currentDisk().slides.entries()) {
        const element = slide.elements.find((e) => e.id === id);
        if (element) return { slide: index, element };
      }
      throw new Error(`No element ${id}`);
    },
    shot: async ({ slide, element, region, scale = 0.75, overlay = false }) => {
      await requireDeck();
      return { path: await savedShot({ slide, element, region, scale, overlay }) };
    },
    "script-run": async ({ id, steps, wait, poster }) => {
      await requireDeck();
      let result;
      try { result = await pptist.runScript(id, { steps, wait }); }
      catch (error) {
        if (error.message === "not-trusted") throw new Error("This deck's scripts changed outside the editor and the user has not allowed them yet. Ask the user to run the script once (▶ on it, or the slideshow) and allow it; scripts you write through slides_apply are allowed automatically.");
        throw error;
      }
      let path = null;
      if (result.picture) {
        path = `${SHOTS}/script-${Date.now()}.png`;
        await writeBytes(path, await (await fetch(result.picture)).blob(), { createDirs: true });
        path = (await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`)).path;
        if (poster && !result.errors.length) {
          const slideId = pptist.getDeck().slides.find((slide) => slide.elements.some((el) => el.id === id))?.id;
          pptist.stores.slides().updateElement({ id, slideId, props: { poster: await savePoster(result.picture) } });
          await pptist.stores.snapshot().addSnapshot();
          await save();
        }
      }
      return { logs: result.logs, errors: result.errors, steps: result.steps, picture: path, posterSet: Boolean(poster && path && !result.errors.length) };
    },
    frames: async ({ slide, transition, element, effect, at, width }) => {
      await requireDeck();
      const dataUrl = await pptist.motionFrames({ slide, transition, element, effect, at, width });
      const path = `${SHOTS}/frames-${Date.now()}.png`;
      await writeBytes(path, await (await fetch(dataUrl)).blob(), { createDirs: true });
      return { path: (await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`)).path };
    },
    select: async ({ ids, slide }) => { await requireDeck(); return pptist.select({ ids, slide }); },
    apply: async ({ ops }) => {
      await requireDeck();
      const { deck, results } = await applyOps(currentDisk(), ops, { imageSize, writeScript });
      await showDeck(deck);
      const saved = await save();
      // Definitions are checked structurally by the ops; the browser checks the CSS itself.
      const warnings = [];
      for (const op of ops) {
        if (op.op === "define_transition") warnings.push(...pptist.validateTransition(deck.motion.transitions[op.name]).map((p) => `transition ${op.name}: ${p}`));
        if (op.op === "define_effect") warnings.push(...pptist.validateEffect(deck.motion.effects[op.name]).map((p) => `effect ${op.name}: ${p}`));
      }
      return { results, saved: saved.saved, slideCount: pptist.state().slideCount, ...(warnings.length ? { warnings } : {}) };
    },
    actions: () => pptist.actions(),
    action: async ({ name, args }) => { await requireDeck(); await pptist.runAction(name, args ?? {}); return pptist.state(); },
    export: async ({ format = "pptx", media = false }) => {
      await requireDeck();
      if (format !== "pptx") throw new Error("Export pptx here; for PDF, ask the user to use Export → Print / export PDF");
      const done = new Promise((resolve, reject) => { lastExport = { resolve, reject }; setTimeout(() => reject(new Error("The export did not finish within three minutes")), 180_000); });
      await pptist.runAction("export.pptx", { media });
      return { saved: await done };
    },
  },
});

// ------------------------------------------------------------------- start --

mountHeader();
const { "slides.last": last } = await browser.storage.local.get("slides.last").catch(() => ({}));
const query = new URLSearchParams(location.search).get("path");
if (query || last) await open(query ?? last).catch((error) => { toast(error.message); return showStart(); });
else await showStart();
