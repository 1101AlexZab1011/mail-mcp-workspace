/* Mail Workspace window shell: space management between panels, sidebar
   buttons, the Ctrl+F search overlay, one-window behaviour for messages and
   tooltip hygiene. Loaded into the Experiment scope after layout.js. */
/* global Services, ChromeUtils, readDock, writeDock, applyDock, MIN_WIDTH, RAIL */

// ------------------------------------------------------ space management --
//
// Panels never cover each other. When a dock grows (or the window shrinks)
// and the content no longer fits, other panels are minimized one by one:
// the other dock, the Today pane, the folder pane, the message pane. They
// come back, last one first, as space frees up. With nothing left to
// minimize, the growing dock stops.

const CONTENT_MIN = { mail3PaneTab: 320, calendar: 520, tasks: 480, addressBookTab: 520, default: 420 };
const MESSAGE_PANE_MIN = 360;

function paneLayoutOf(window) {
  const info = window.gTabmail?.currentTabInfo;
  if (info?.mode?.name !== "mail3PaneTab") return null;
  return window.gTabmail.currentAbout3Pane?.paneLayout ?? null;
}

/** Minimum width the current tab's content needs, and what inside it can collapse. */
function contentNeeds(window) {
  const mode = window.gTabmail?.currentTabInfo?.mode?.name ?? "default";
  const layout = paneLayoutOf(window);
  const collapsibles = [];
  let min = CONTENT_MIN[mode] ?? CONTENT_MIN.default;
  if (layout) {
    const pane = window.gTabmail.currentAbout3Pane;
    const folderWidth = layout.folderPaneVisible ? Math.round(pane.document.getElementById("folderPane").getBoundingClientRect().width) : 0;
    const vertical = layout.layoutPreference !== 1; // classic (1) stacks the message pane under the list
    if (layout.folderPaneVisible) {
      min += folderWidth;
      collapsibles.push({ key: "folderPane", width: folderWidth, collapse: () => { layout.folderPaneVisible = false; }, restore: () => { layout.folderPaneVisible = true; } });
    }
    if (layout.messagePaneVisible && vertical) {
      min += MESSAGE_PANE_MIN;
      collapsibles.push({ key: "messagePane", width: MESSAGE_PANE_MIN, collapse: () => { layout.messagePaneVisible = false; }, restore: () => { layout.messagePaneVisible = true; } });
    }
  }
  return { min, collapsibles };
}

function todayPane(window) {
  const panel = window.document.getElementById("today-pane-panel");
  const visible = Boolean(panel && !panel.hidden && panel.getBoundingClientRect().width > 0);
  return {
    visible,
    width: visible ? Math.round(panel.getBoundingClientRect().width) : 0,
    collapse: () => window.TodayPane?.toggleVisibility?.(),
    restore: () => { if (!window.TodayPane?.isVisible) window.TodayPane?.toggleVisibility?.(); },
  };
}

const dockWidth = (dock) => (dock.state === "minimized" ? RAIL[dock.side] : dock.width);

/**
 * Make everything fit. `request` ({ side, width }) is a dock asking to be that
 * wide; the answer is the width it can have. `notify(dock)` reports docks the
 * manager minimized or restored.
 */
function fit(window, request = null, notify = () => {}) {
  const container = window.document.getElementById("tabmail-container");
  if (!container) return request?.width;
  const total = container.getBoundingClientRect().width;
  const docks = { left: readDock("left"), right: readDock("right") };
  if (docks.left.state === "maximized" || docks.right.state === "maximized") return request?.width;
  if (request) { docks[request.side].state = "open"; docks[request.side].width = Math.max(MIN_WIDTH, request.width); }
  const stack = (window.mwAutoStack ??= loadAutoStack(window, docks));
  const changed = new Set();
  const free = () => total - dockWidth(docks.left) - dockWidth(docks.right) - todayPane(window).width - contentNeeds(window).min;

  for (let guard = 0; guard < 8 && free() < 0; guard++) {
    // Order: when a dock asks for room, the other dock goes first; when the
    // window shrinks, the file browser goes first and the chat last.
    const dockCandidate = (side) => (docks[side].state === "open" && side !== request?.side
      ? [{ key: `dock:${side}`, width: docks[side].width - RAIL[side], collapse: () => { docks[side].state = "minimized"; changed.add(side); }, restore: () => { docks[side].state = "open"; changed.add(side); } }]
      : []);
    const filesSide = window.mwCtx?.filesSide ?? "left";
    const chatSide = filesSide === "left" ? "right" : "left";
    const today = todayPane(window);
    const inner = [...(today.visible ? [{ key: "todayPane", width: today.width, collapse: today.collapse, restore: today.restore }] : []), ...contentNeeds(window).collapsibles];
    const candidates = request
      ? [...dockCandidate(request.side === "left" ? "right" : "left"), ...inner]
      : [...dockCandidate(filesSide), ...inner, ...dockCandidate(chatSide)];
    const next = candidates[0];
    if (!next) {
      // Nothing left to minimize: the requesting dock stops growing.
      if (request) docks[request.side].width = Math.max(MIN_WIDTH, docks[request.side].width + free());
      break;
    }
    next.collapse();
    stack.push(next);
  }

  // Give space back, the most recently minimized first.
  while (stack.length) {
    const last = stack.at(-1);
    if (free() < last.width + 8) break;
    last.restore();
    stack.pop();
  }

  for (const side of changed) { writeDock(docks[side]); applyDock(window, docks[side]); notify(docks[side]); }
  saveAutoStack(stack);
  return request ? docks[request.side].width : null;
}

// What the manager minimized survives restarts, so it can still be given back.
const AUTO_PREF = "extensions.mailworkspace.autoStack";
function saveAutoStack(stack) {
  Services.prefs.setStringPref(AUTO_PREF, JSON.stringify(stack.map(({ key, width }) => ({ key, width }))));
}
function loadAutoStack(window, docks) {
  let saved = [];
  try { saved = JSON.parse(Services.prefs.getStringPref(AUTO_PREF, "[]")); } catch { saved = []; }
  return saved.map(({ key, width }) => {
    if (key.startsWith("dock:")) {
      const side = key.slice(5);
      return { key, width, restore: () => { const dock = readDock(side); dock.state = "open"; writeDock(dock); applyDock(window, dock); window.mwCtx?.notify?.(dock); } };
    }
    if (key === "todayPane") return { key, width, restore: () => todayPane(window).restore() };
    if (key === "folderPane") return { key, width, restore: () => { const layout = paneLayoutOf(window); if (layout) layout.folderPaneVisible = true; } };
    if (key === "messagePane") return { key, width, restore: () => { const layout = paneLayoutOf(window); if (layout) layout.messagePaneVisible = true; } };
    return null;
  }).filter(Boolean);
}

/** The user changed a dock themselves: it is no longer the manager's to restore. */
function forgetAuto(window, key) {
  if (window.mwAutoStack) { window.mwAutoStack = window.mwAutoStack.filter((entry) => entry.key !== key); saveAutoStack(window.mwAutoStack); }
}

// --------------------------------------------------------- sidebar buttons --

function makeSpaceButton(document, { id, title, icon, onclick }) {
  const button = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
  button.id = id;
  button.className = "spaces-toolbar-button mw-space-button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.dataset.icon = icon;
  const img = document.createElementNS("http://www.w3.org/1999/xhtml", "img");
  img.alt = "";
  img.src = `resource://mailworkspace/icons/${icon}.svg`;
  button.append(img);
  button.addEventListener("click", onclick);
  return button;
}

function installSidebarButtons(window, ctx) {
  const document = window.document;
  const top = document.querySelector("#spacesToolbar .spaces-toolbar-top-container");
  const bottom = document.querySelector("#spacesToolbar .spaces-toolbar-bottom-container");
  if (!top || document.getElementById("mw-files-dock-button")) return;
  const files = makeSpaceButton(document, { id: "mw-files-dock-button", title: "File browser (Ctrl+6)", icon: "folder_open", onclick: () => ctx.update(ctx.filesSide, { state: "toggle" }) });
  top.insertBefore(files, document.getElementById("tasksButton")?.nextSibling ?? null);
  const menu = makeSpaceButton(document, { id: "mw-appmenu-button", title: "Thunderbird menu", icon: "menu", onclick: (event) => window.PanelUI?.show(event) });
  bottom?.insertBefore(menu, bottom.firstChild);
}

function markSidebar(window, filesSide) {
  const button = window.document.getElementById("mw-files-dock-button");
  button?.classList.toggle("mw-active", readDock(filesSide).state !== "minimized");
}

// ------------------------------------------------------------------ search --
// Ctrl+F (and Ctrl+K) open Thunderbird's search as a floating box instead of
// the browser find bar; there is no top bar to host it otherwise.

function installSearch(window) {
  const document = window.document;
  const root = document.documentElement;
  for (const id of ["key_find", "key_quickSearchFocus"]) {
    const key = document.getElementById(id);
    if (!key || key.hasAttribute("mw-original-oncommand")) continue;
    key.setAttribute("mw-original-oncommand", key.getAttribute("oncommand") ?? "");
    key.setAttribute("oncommand", "window.mailWorkspaceSearch?.open();");
  }
  const close = () => { root.removeAttribute("mw-search"); };
  const onKey = (event) => { if (event.key === "Escape" && root.hasAttribute("mw-search")) { close(); event.preventDefault(); } };
  const onFocusOut = () => window.setTimeout(() => { if (!document.getElementById("navigation-toolbox")?.contains(document.activeElement)) close(); }, 150);
  window.mailWorkspaceSearch = {
    open() {
      root.setAttribute("mw-search", "");
      try { window.QuickSearchFocus(); } catch { /* not ready */ }
    },
    close,
  };
  document.getElementById("navigation-toolbox")?.addEventListener("focusout", onFocusOut);
  window.addEventListener("keydown", onKey, true);
  return () => {
    for (const id of ["key_find", "key_quickSearchFocus"]) {
      const key = document.getElementById(id);
      if (!key?.hasAttribute("mw-original-oncommand")) continue;
      key.setAttribute("oncommand", key.getAttribute("mw-original-oncommand"));
      key.removeAttribute("mw-original-oncommand");
    }
    document.getElementById("navigation-toolbox")?.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("keydown", onKey, true);
    close();
    delete window.mailWorkspaceSearch;
  };
}

// ------------------------------------------------- panes: one window only --
// Double-click or Enter on a message would open it in its own window (or an
// invisible tab). In Mail Workspace a message is read in the message pane.

function onePaneBehaviour(doc) {
  if (!/^about:3pane/.test(doc.documentURI) || doc.mwOnePane) return;
  doc.mwOnePane = true;
  const showInPane = (event) => {
    if (!event.target.closest?.("#threadTree tr")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const layout = doc.defaultView.paneLayout;
    if (layout && !layout.messagePaneVisible) layout.messagePaneVisible = true;
  };
  doc.addEventListener("dblclick", showInPane, true);
  doc.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) showInPane(event); }, true);
  // Folder rows get a tooltip worth reading: counts and account, not the name again.
  doc.addEventListener("mouseover", (event) => {
    const row = event.target.closest?.("#folderTree li");
    if (!row) return;
    let uri = row.uri;
    if (!uri) { try { uri = atob(row.id.slice(row.id.indexOf("-") + 1)); } catch { return; } }
    if (!uri || row.mwTitled === uri) return;
    try {
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const folder = MailServices.folderLookup.getFolderForURL(uri);
      if (!folder) return;
      const unread = folder.getNumUnread(false);
      const total = folder.getTotalMessages(false);
      const parts = [`${total.toLocaleString()} message${total === 1 ? "" : "s"}`];
      if (unread) parts.unshift(`${unread.toLocaleString()} unread`);
      parts.push(folder.server?.prettyName ?? "");
      const title = parts.filter(Boolean).join(" · ");
      for (const el of [row, ...row.querySelectorAll("[title]")]) el.setAttribute("title", title);
      row.mwTitled = uri;
    } catch { /* tooltips are best effort */ }
  }, true);
}

// ------------------------------------------------------ tooltip hygiene --
// A tooltip that repeats the text you are pointing at says nothing; drop it.

function dropEchoTooltips(target) {
  target.addEventListener("mouseover", (event) => {
    for (let el = event.target; el && el.nodeType === 1; el = el.parentElement) {
      const attr = el.hasAttribute("title") ? "title" : el.hasAttribute("tooltiptext") ? "tooltiptext" : null;
      if (!attr) continue;
      const tip = (el.getAttribute(attr) ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const text = (el.textContent ?? el.getAttribute("label") ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const label = (el.getAttribute("label") ?? "").trim().toLowerCase();
      if (tip && (tip === text || tip === label)) { el.setAttribute(`mw-dropped-${attr}`, el.getAttribute(attr)); el.removeAttribute(attr); }
      break;
    }
  }, true);
}
