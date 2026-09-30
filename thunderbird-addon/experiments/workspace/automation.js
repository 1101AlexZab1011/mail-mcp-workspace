/* Mail Workspace GUI automation: what the agent can see and do in the chrome.

   snapshot()  lists visible, actionable elements of the main window and of the
               in-process documents inside it (about:3pane, about:message,
               about:addressbook, preferences), each with a ref like "c42".
   act()       clicks, types, selects… on a ref using trusted input events, so
               Thunderbird reacts exactly as to a user. Irreversible actions
               (send, delete, move mail, settings) are classified first; the
               caller asks the user before running them.
   getState()  the active space and the current selection in every space.
   Pages of the add-on itself (docks, viewer, artifacts, paint) answer for
   themselves through the background script. */
/* global Services, ChromeUtils, Cc, Ci */

var MW_XHTML = "http://www.w3.org/1999/xhtml";
/** The window an element lives in (some chrome elements lack ownerGlobal). */
const winOf = (el) => el.ownerDocument?.defaultView ?? el.ownerGlobal;

function preparePrefs() {
  // The start page is a web page that can't follow the theme; an empty message
  // pane until something is selected reads better.
  if (Services.prefs.getBoolPref("mailnews.start_page.enabled", true)) {
    Services.prefs.setBoolPref("extensions.mailworkspace.previousStartPage", true);
    Services.prefs.setBoolPref("mailnews.start_page.enabled", false);
  }
  // Without a tab bar a message opened "in a new tab" would be invisible, so
  // messages open in the message pane / a reusable window instead.
  if (Services.prefs.getIntPref("mail.openMessageBehavior", 2) === 2) {
    Services.prefs.setIntPref("extensions.mailworkspace.previousOpenMessageBehavior", 2);
    Services.prefs.setIntPref("mail.openMessageBehavior", 1);
  }
}

// ---------------------------------------------------------------- spaces --

function openSpace(window, name) {
  const toolbar = window.gSpacesToolbar;
  const aliases = { contacts: "addressbook", "address-book": "addressbook", tasks: "tasks", calendar: "calendar", mail: "mail", settings: "settings" };
  const wanted = aliases[name] ?? name;
  const space = toolbar?.spaces?.find((candidate) => candidate.name === wanted);
  if (!space) throw new Error(`Unknown space ${name}. Built-in spaces: ${toolbar?.spaces?.map((s) => s.name).join(", ")}`);
  toolbar.openSpace(window.gTabmail, space);
  return { space: space.name };
}

// ----------------------------------------------------------------- state --

const iso = (prTime) => (prTime ? new Date(prTime / 1000).toISOString() : null);
function describeHeader(hdr) {
  return {
    key: hdr.messageKey,
    messageId: hdr.messageId,
    subject: hdr.mime2DecodedSubject,
    from: hdr.mime2DecodedAuthor,
    to: hdr.mime2DecodedRecipients,
    date: iso(hdr.date),
    read: hdr.isRead,
    flagged: hdr.isFlagged,
    folder: hdr.folder?.URI,
    account: hdr.folder?.server?.prettyName,
  };
}

function calendarItem(item) {
  return {
    id: item.id,
    title: item.title,
    start: (item.startDate ?? item.entryDate)?.toString() ?? null,
    end: (item.endDate ?? item.dueDate)?.toString() ?? null,
    location: item.getProperty?.("LOCATION") ?? null,
    calendar: item.calendar?.name ?? null,
    completed: item.isCompleted ?? undefined,
  };
}

function getState(window, docks) {
  const tabmail = window.gTabmail;
  const info = tabmail?.currentTabInfo;
  const state = {
    // Add-on spaces carry an internal prefix ("…-spacesButton-viewer"); report the short name.
    space: window.gSpacesToolbar?.currentSpace?.name?.replace(/^.*-spacesButton-/, "") ?? null,
    tab: info ? { mode: info.mode?.name, title: info.title, url: info.browser?.currentURI?.spec ?? null } : null,
    docks,
  };
  try {
    const about3Pane = tabmail?.currentAbout3Pane;
    if (about3Pane) {
      const folder = about3Pane.gFolder;
      const hdrs = about3Pane.gDBView?.getSelectedMsgHdrs?.() ?? [];
      state.mail = {
        folder: folder ? { uri: folder.URI, name: folder.localizedName ?? folder.prettyName ?? folder.name, account: folder.server?.prettyName, unread: folder.getNumUnread(false), total: folder.getTotalMessages(false) } : null,
        selected: hdrs.slice(0, 50).map(describeHeader),
        selectedCount: hdrs.length,
      };
    }
  } catch (error) { state.mail = { error: String(error) }; }
  try {
    const mode = info?.mode?.name;
    if (mode === "calendar" && typeof window.currentView === "function") {
      const view = window.currentView();
      state.calendar = { view: view?.type, selectedDay: view?.selectedDay?.toString?.() ?? null, selected: (view?.getSelectedItems?.() ?? []).map(calendarItem) };
    }
    if (mode === "tasks") {
      const tree = window.document.getElementById("calendar-task-tree");
      state.tasks = { selected: (tree?.selectedTasks ?? []).map(calendarItem) };
    }
    if (mode === "addressBookTab") {
      const abWindow = info.browser?.contentWindow;
      const cards = abWindow?.cardsPane?.selectedCards ?? [];
      state.contacts = {
        book: abWindow?.booksList?.getRowAtIndex?.(abWindow.booksList.selectedIndex)?.dataset?.uid ?? null,
        selected: cards.slice(0, 50).map((card) => ({ uid: card.UID, name: card.displayName, email: card.primaryEmail })),
      };
    }
  } catch (error) { state.spaceError = String(error); }
  return state;
}

// -------------------------------------------------------------- snapshot --

const ACTIONABLE = [
  "button", "toolbarbutton", "menulist", "checkbox", "radio", "input:not([type=hidden])", "textarea", "select", "a[href]",
  "[role=button]", "[role=tab]", "[role=treeitem]", "[role=option]", "[role=menuitem]", "[role=menuitemcheckbox]",
  "[role=checkbox]", "[role=link]", "[role=row]", "[role=gridcell][tabindex]", "[role=switch]", "[role=combobox]",
  "menuitem", "richlistitem", "treechildren",
].join(",");

function documentsOf(window) {
  const docs = [{ doc: window.document, offset: { x: 0, y: 0 }, where: "window" }];
  // In-process documents embedded in the window (the 3-pane, message, address
  // book, preferences). Remote ones (web content, add-on pages) are skipped.
  const visit = (doc, offset, depth) => {
    if (depth > 3) return;
    for (const frame of doc.querySelectorAll("browser, iframe")) {
      let inner;
      try { inner = frame.contentDocument; } catch { continue; }
      if (!inner || !inner.documentElement) continue;
      const rect = frame.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      // A background tab's document still lays itself out; only frames that are
      // actually showing in their parent count.
      if (!isVisible(frame)) continue;
      const next = { x: offset.x + rect.x, y: offset.y + rect.y };
      docs.push({ doc: inner, offset: next, where: inner.location?.href?.split("?")[0] ?? "frame" });
      visit(inner, next, depth + 1);
    }
  };
  visit(window.document, { x: 0, y: 0 }, 0);
  return docs;
}

function labelOf(el) {
  const text = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  const direct = text(el.getAttribute?.("aria-label")) || text(el.getAttribute?.("label")) || text(el.getAttribute?.("tooltiptext"));
  if (direct) return direct.slice(0, 100);
  const own = text(el.textContent);
  if (own) return own.slice(0, 100);
  return text(el.getAttribute?.("title")) || text(el.getAttribute?.("placeholder")) || text(el.id) || "";
}

function roleOf(el) {
  return el.getAttribute("role") || (el.localName === "input" ? `input:${el.type || "text"}` : el.localName);
}

function isVisible(el) {
  if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const view = winOf(el);
  if (!(rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth)) return false;
  // Hidden toolbars can still report a box; what is actually under the element's
  // centre decides. Shadow DOM reports its host, so containment counts both ways.
  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), view.innerWidth - 1);
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), view.innerHeight - 1);
  const top = el.ownerDocument.elementFromPoint(x, y);
  if (!top) return false;
  return top === el || el.contains(top) || top.contains(el) || (el.getRootNode?.().host && top.contains(el.getRootNode().host));
}

function snapshot(window, { limit = 400, query } = {}) {
  window.mwRefs = new Map();
  let counter = 0;
  const items = [];
  const seen = new Set();
  const needle = query?.toLowerCase();
  for (const { doc, offset, where } of documentsOf(window)) {
    // Open popups (menus) come first: while one is open, it is what matters.
    const candidates = doc.querySelectorAll(ACTIONABLE);
    for (const el of candidates) {
      if (items.length >= limit) break;
      if (seen.has(el) || !isVisible(el)) continue;
      // Skip wrappers whose actionable child is also listed (rows keep their cells out).
      if (el.closest("[role=row]") && el.closest("[role=row]") !== el && !["button", "input", "a"].includes(el.localName)) continue;
      seen.add(el);
      const name = labelOf(el);
      if (needle && !name.toLowerCase().includes(needle) && !(el.id ?? "").toLowerCase().includes(needle)) continue;
      const rect = el.getBoundingClientRect();
      const ref = `c${++counter}`;
      window.mwRefs.set(ref, Cu.getWeakReference(el));
      const item = { ref, role: roleOf(el), name, where: where === "chrome://messenger/content/messenger.xhtml" ? "window" : where.replace(/^about:/, "") };
      if (el.id) item.id = el.id;
      if ("value" in el && typeof el.value === "string" && el.value && el.localName !== "button") item.value = el.value.slice(0, 200);
      if (el.getAttribute("aria-selected") === "true" || el.selected === true || el.classList?.contains("selected")) item.selected = true;
      if (el.checked === true || el.getAttribute("aria-checked") === "true" || el.getAttribute("checked") === "true") item.checked = true;
      if (el.disabled === true || el.getAttribute("disabled") === "true" || el.getAttribute("aria-disabled") === "true") item.disabled = true;
      if (el.getAttribute("aria-expanded")) item.expanded = el.getAttribute("aria-expanded") === "true";
      item.box = [Math.round(rect.x + offset.x), Math.round(rect.y + offset.y), Math.round(rect.width), Math.round(rect.height)];
      items.push(item);
    }
  }
  return { count: items.length, truncated: items.length >= limit, items };
}

function resolveRef(window, ref) {
  const el = window.mwRefs?.get(ref)?.get();
  if (!el || !el.isConnected) throw new Error(`Ref ${ref} is stale or unknown; take a new snapshot`);
  return el;
}

// -------------------------------------------------- irreversible actions --

const RISKY = [
  { kind: "send", re: /(^|[-_])send|sendnow|sendlater|cmd_send/i },
  { kind: "delete", re: /delete|trash|cmd_shiftdelete|emptytrash|expunge|remove(account|book|card)|deletecard/i },
  { kind: "move", re: /cmd_move|movemenu|copymenu|archive|markasjunk|junk|move-to|movetofolder|cmd_copymessage/i },
];
const RISKY_LABEL = [
  { kind: "send", re: /^(send|send now|send later)\b/i },
  { kind: "delete", re: /^(delete|remove|empty trash|move to trash|discard)\b/i },
  { kind: "move", re: /^(move|archive|mark as junk|copy to)\b/i },
];
const SETTINGS_DOCS = /^about:(preferences|accountsettings|addons|config|support)|accountManager|am-/;

function classify(el) {
  const doc = el.ownerDocument?.location?.href ?? "";
  if (SETTINGS_DOCS.test(doc)) return { irreversible: true, kind: "settings", reason: `changes settings (${doc.split("?")[0]})` };
  for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
    const hay = [node.id, node.getAttribute?.("command"), node.getAttribute?.("observes"), node.getAttribute?.("oncommand"), node.dataset?.command].filter(Boolean).join(" ");
    for (const rule of RISKY) if (rule.re.test(hay)) return { irreversible: true, kind: rule.kind, reason: `${rule.kind}: ${hay.slice(0, 80)}` };
  }
  const label = labelOf(el);
  for (const rule of RISKY_LABEL) if (rule.re.test(label)) return { irreversible: true, kind: rule.kind, reason: `${rule.kind}: "${label}"` };
  return { irreversible: false };
}

// ---------------------------------------------------------------- act ----

function centerOf(el) {
  const rect = el.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function mouse(el, type, button = 0, count = 1) {
  const utils = winOf(el).windowUtils;
  const { x, y } = centerOf(el);
  utils.sendMouseEvent(type, x, y, button, count, 0);
}

function click(el, { button = 0, count = 1 } = {}) {
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  mouse(el, "mousemove", button, 0);
  for (let i = 1; i <= count; i++) {
    mouse(el, "mousedown", button, i);
    mouse(el, "mouseup", button, i);
  }
  if (button === 2) mouse(el, "contextmenu", 2, 1);
}

async function act(window, ref, action, value, { check } = {}) {
  const el = resolveRef(window, ref);
  const verdict = ["click", "dblclick", "select", "press"].includes(action) ? classify(el) : { irreversible: false };
  if (check) return { ref, action, ...verdict, name: labelOf(el) };
  switch (action) {
    case "click": click(el); break;
    case "dblclick": click(el, { count: 2 }); break;
    case "rightclick": click(el, { button: 2 }); break;
    case "hover": mouse(el, "mousemove", 0, 0); break;
    case "focus": el.focus(); break;
    case "scroll": el.scrollIntoView({ block: "center" }); break;
    case "type": {
      el.focus();
      if (typeof el.setUserInput === "function") el.setUserInput(value ?? "");
      else if (el.isContentEditable) el.ownerDocument.execCommand("insertText", false, value ?? "");
      else if ("value" in el) { el.value = value ?? ""; el.dispatchEvent(new winOf(el).Event("input", { bubbles: true })); el.dispatchEvent(new winOf(el).Event("change", { bubbles: true })); }
      break;
    }
    case "select": {
      if (el.localName === "menulist" || el.localName === "select") {
        el.value = value;
        el.dispatchEvent(new winOf(el).Event(el.localName === "select" ? "change" : "command", { bubbles: true }));
      } else click(el);
      break;
    }
    default: throw new Error(`Unknown action ${action}`);
  }
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  return { ref, action, done: true, name: labelOf(el) };
}

// ------------------------------------------------------------------ keys --

const KEY_CODES = {
  Enter: "Enter", Return: "Enter", Escape: "Escape", Esc: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: " ",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6", F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
};
const MODIFIERS = { control: "Control", ctrl: "Control", shift: "Shift", alt: "Alt", meta: "Meta", super: "Meta", accel: "Control" };

function classifyCombo(combo, focusedDoc) {
  const lower = combo.toLowerCase();
  if (/(control|ctrl|accel)\+(enter|return)/.test(lower) && /messengercompose/i.test(focusedDoc)) return { irreversible: true, kind: "send", reason: "Ctrl+Enter sends the message being composed" };
  if (/^(shift\+)?delete$/.test(lower) || lower === "backspace" && !/input|textarea/.test(focusedDoc)) return { irreversible: true, kind: "delete", reason: "deletes the selection" };
  if (/^(a|j|shift\+j)$/.test(lower) && /3pane|messenger\.xhtml/.test(focusedDoc)) return { irreversible: true, kind: "move", reason: "archives or marks as junk" };
  return { irreversible: false };
}

async function pressKey(window, combo, { check } = {}) {
  const focused = Services.focus.focusedWindow ?? window;
  const verdict = classifyCombo(combo, focused.document?.location?.href ?? "");
  if (check) return { combo, ...verdict };
  const parts = combo.split("+").map((part) => part.trim()).filter(Boolean);
  const keyName = parts.pop();
  const mods = parts.map((part) => MODIFIERS[part.toLowerCase()]).filter(Boolean);
  const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
  if (!tip.beginInputTransactionForTests(focused)) throw new Error("Could not start keyboard input");
  const make = (key) => {
    const printable = key.length === 1;
    const code = printable ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : "") : key;
    return new focused.KeyboardEvent("", { key: printable && mods.includes("Shift") ? key.toUpperCase() : key, code });
  };
  for (const mod of mods) tip.keydown(new focused.KeyboardEvent("", { key: mod, code: `${mod}Left` }));
  const key = KEY_CODES[keyName] ?? (keyName.length === 1 ? keyName.toLowerCase() : keyName);
  tip.keydown(make(key));
  tip.keyup(make(key));
  for (const mod of mods.reverse()) tip.keyup(new focused.KeyboardEvent("", { key: mod, code: `${mod}Left` }));
  await new Promise((resolve) => window.setTimeout(resolve, 150));
  return { combo, done: true };
}

// ------------------------------------------------------------ screenshot --

async function screenshot(window, { ref, scale } = {}) {
  let rect = null;
  if (ref) {
    const el = resolveRef(window, ref);
    const box = el.getBoundingClientRect();
    // Elements in embedded documents are offset by their browser's position.
    let x = box.x;
    let y = box.y;
    for (let frame = winOf(el).browsingContext?.embedderElement; frame; frame = winOf(frame).browsingContext?.embedderElement) {
      const r = frame.getBoundingClientRect();
      x += r.x; y += r.y;
    }
    rect = new window.DOMRect(x, y, box.width, box.height);
  }
  const ratio = scale ?? Math.min(window.devicePixelRatio, 1.5);
  const bitmap = await window.browsingContext.currentWindowGlobal.drawSnapshot(rect, ratio, "white");
  const canvas = window.document.createElementNS(MW_XHTML, "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL("image/png") };
}

// ----------------------------------------------------- typed navigation --

async function selectMail(window, folderUri, messageKeys) {
  openSpace(window, "mail");
  const about3Pane = window.gTabmail.currentAbout3Pane;
  if (!about3Pane) throw new Error("The mail space is not ready");
  if (folderUri && about3Pane.gFolder?.URI !== folderUri) {
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const folder = MailServices.folderLookup.getFolderForURL(folderUri);
    if (!folder) throw new Error(`No folder ${folderUri}`);
    about3Pane.displayFolder(folder);
    await new Promise((resolve) => window.setTimeout(resolve, 400));
  }
  if (messageKeys?.length) {
    const view = about3Pane.gDBView;
    const indices = messageKeys.map((key) => view.findIndexFromKey(key, true)).filter((index) => index >= 0);
    if (!indices.length) throw new Error("None of those messages are in the current view");
    about3Pane.threadTree.selectedIndices = indices;
    about3Pane.threadTree.scrollToIndex?.(indices[0]);
  }
  return getState(window, null).mail;
}

async function calendarGoto(window, date, view) {
  openSpace(window, "calendar");
  const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
  if (view && typeof window.switchCalendarView === "function") window.switchCalendarView(view, true);
  const day = cal.createDateTime(date.replace(/-/g, "").slice(0, 8));
  day.isDate = true;
  window.currentView().goToDay(day);
  return { view: window.currentView().type, day: window.currentView().selectedDay?.toString() };
}
