/* Mail Workspace chrome layout. Loaded into the Experiment's scope; every
   change it makes to a messenger window is undone by `removeLayout`.

   #tabmail-container (an hbox) becomes:
     [left dock][resizer] tabmail [today pane] [resizer][right dock]
   Each dock hosts an extension page in its own <browser>. A dock is "open"
   (resizable width), "minimized" (a narrow rail: the page switches to its
   rail layout by width) or "maximized" (fills the content area). */
/* global Services, ChromeUtils, ExtensionParent */

var XHTML = "http://www.w3.org/1999/xhtml";
var PREF_ROOT = "extensions.mailworkspace.";
// A minimized dock: the chat keeps a rail on the right; the file browser
// disappears (its button lives in the spaces sidebar).
var RAIL = { left: 0, right: 52 };
var MIN_WIDTH = 260;
// Files on the left (minimized), chat on the right (open): see shared/docks.js.
var DEFAULTS = {
  left: { state: "minimized", width: 340 },
  right: { state: "open", width: 400 },
};
var LAYOUT_VERSION = 2;

/** Layout 1 had the chat on the left; move saved dock states with their pages. */
function migrateDockPrefs() {
  if (Services.prefs.getIntPref(`${PREF_ROOT}layoutVersion`, 1) >= LAYOUT_VERSION) return;
  const saved = (side) => ({
    state: Services.prefs.getStringPref(`${PREF_ROOT}${side}.state`, ""),
    width: Services.prefs.getIntPref(`${PREF_ROOT}${side}.width`, 0),
  });
  const [left, right] = [saved("left"), saved("right")];
  for (const [side, value] of [["left", right], ["right", left]]) {
    if (value.state) Services.prefs.setStringPref(`${PREF_ROOT}${side}.state`, value.state); else Services.prefs.clearUserPref(`${PREF_ROOT}${side}.state`);
    if (value.width) Services.prefs.setIntPref(`${PREF_ROOT}${side}.width`, value.width); else Services.prefs.clearUserPref(`${PREF_ROOT}${side}.width`);
  }
  Services.prefs.setIntPref(`${PREF_ROOT}layoutVersion`, LAYOUT_VERSION);
}

function readDock(side) {
  const fallback = DEFAULTS[side];
  const state = Services.prefs.getStringPref(`${PREF_ROOT}${side}.state`, fallback.state);
  const width = Services.prefs.getIntPref(`${PREF_ROOT}${side}.width`, fallback.width);
  return { side, state, width };
}

function writeDock(dock) {
  Services.prefs.setStringPref(`${PREF_ROOT}${dock.side}.state`, dock.state);
  Services.prefs.setIntPref(`${PREF_ROOT}${dock.side}.width`, Math.round(dock.width));
}

/** An extension-page <browser>, wired the way Thunderbird wires its own popups. */
function createExtensionBrowser(document, extension, url) {
  const browser = document.createXULElement("browser");
  browser.setAttribute("type", "content");
  browser.setAttribute("disableglobalhistory", "true");
  browser.setAttribute("messagemanagergroup", "webext-browsers");
  browser.setAttribute("webextension-view-type", "sidebar");
  browser.setAttribute("context", "browserContext");
  browser.setAttribute("tooltip", "aHTMLTooltip");
  browser.setAttribute("autocompletepopup", "PopupAutoComplete");
  browser.setAttribute("selectmenulist", "ContentSelectDropdown");
  browser.setAttribute("datetimepicker", "DateTimePickerPanel");
  browser.toggleAttribute("nodefaultsrc", true);
  browser.setAttribute("maychangeremoteness", "true");
  browser.setAttribute("initialBrowsingContextGroupId", extension.policy.browsingContextGroupId);
  if (extension.remote) {
    browser.toggleAttribute("remote", true);
    browser.setAttribute("remoteType", extension.remoteType);
  }
  browser.setAttribute("flex", "1");
  browser.classList.add("mw-dock-browser");
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
    browser.fixupAndLoadURIString(url, { triggeringPrincipal: extension.principal });
  };
  // Navigation is only possible once the frame loader exists, and not inside the
  // event that announces it: Thunderbird's popups defer to a promise tick too.
  if (extension.remote) {
    browser.addEventListener("XULFrameLoaderCreated", () => Promise.resolve().then(load), { once: true });
    // A browser inserted while hidden may never announce its frame loader; load
    // it directly once it has one.
    const fallback = () => { if (loaded) return; if (browser.frameLoader && browser.webNavigation) load(); else browser.ownerGlobal?.setTimeout(fallback, 250); };
    browser.ownerGlobal?.setTimeout(fallback, 500);
  }
  return { browser, load: extension.remote ? null : load };
}

function applyDock(window, dock) {
  const document = window.document;
  const element = document.getElementById(`mw-dock-${dock.side}`);
  const resizer = document.getElementById(`mw-resizer-${dock.side}`);
  const container = document.getElementById("tabmail-container");
  if (!element || !container) return;
  element.dataset.state = dock.state;
  element.style.width = dock.state === "minimized" ? `${RAIL[dock.side]}px` : dock.state === "maximized" ? "" : `${dock.width}px`;
  element.hidden = dock.state === "minimized" && RAIL[dock.side] === 0;
  resizer.hidden = dock.state !== "open";
  // Only one dock can be maximized; it hides everything else in the container.
  if (dock.state === "maximized") container.setAttribute("mw-maximized", dock.side);
  else if (container.getAttribute("mw-maximized") === dock.side) container.removeAttribute("mw-maximized");
}

function makeResizer(window, side, onResize) {
  const document = window.document;
  const resizer = document.createElementNS(XHTML, "div");
  resizer.id = `mw-resizer-${side}`;
  resizer.className = "mw-resizer";
  resizer.dataset.side = side;
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const dock = document.getElementById(`mw-dock-${side}`);
    const startX = event.clientX;
    const startWidth = dock.getBoundingClientRect().width;
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
    // The page under the pointer would swallow move events; overlay-free drag
    // works because pointer capture keeps them on the resizer.
    dock.classList.add("resizing");
    const max = () => window.innerWidth - 360;
    const move = (e) => {
      const delta = side === "left" ? e.clientX - startX : startX - e.clientX;
      // The space manager decides how wide it may get, minimizing other panels first.
      const width = fit(window, { side, width: Math.max(MIN_WIDTH, Math.min(max(), startWidth + delta)) }, ctxNotify(window));
      dock.style.width = `${width}px`;
    };
    const up = () => {
      resizer.releasePointerCapture(event.pointerId);
      resizer.classList.remove("dragging");
      dock.classList.remove("resizing");
      resizer.removeEventListener("pointermove", move);
      onResize(parseInt(dock.style.width, 10));
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up, { once: true });
    resizer.addEventListener("pointercancel", up, { once: true });
  });
  // Double-click restores a sensible width.
  resizer.addEventListener("dblclick", () => onResize(DEFAULTS[side].width));
  return resizer;
}

/**
 * Install the layout in one messenger window.
 * `ctx` supplies the extension, page URLs and a callback for dock changes.
 */
function applyLayout(window, ctx) {
  const document = window.document;
  if (document.getElementById("mw-dock-left")) return;
  const container = document.getElementById("tabmail-container");
  const tabmail = document.getElementById("tabmail");
  if (!container || !tabmail) return;

  document.documentElement.setAttribute("mw-workspace", "true");
  markAppearance(document);
  window.windowUtils.loadSheetUsingURIString(ctx.sheetUrl, window.windowUtils.AUTHOR_SHEET);

  for (const side of ["left", "right"]) {
    const dock = readDock(side);
    const element = document.createElementNS(XHTML, "div");
    element.id = `mw-dock-${side}`;
    element.className = "mw-dock";
    element.dataset.side = side;
    const { browser, load } = createExtensionBrowser(document, ctx.extension, side === "left" ? ctx.leftUrl : ctx.rightUrl);
    browser.id = `mw-dock-browser-${side}`;
    element.append(browser);
    const resizer = makeResizer(window, side, (width) => ctx.update(side, { state: "open", width }));
    if (side === "left") {
      container.insertBefore(resizer, container.firstChild);
      container.insertBefore(element, resizer);
    } else {
      container.append(resizer, element);
    }
    load?.();
    applyDock(window, dock);
  }
  window.mwCtx = ctx;
  installSidebarButtons(window, ctx);
  markSidebar(window, ctx.filesSide);
  const stopSearch = installSearch(window);
  dropEchoTooltips(window);
  // Refit when the window changes size (debounced to a frame).
  let pending = 0;
  const refit = () => { if (pending) return; pending = window.requestAnimationFrame(() => { pending = 0; fit(window, null, ctxNotify(window)); }); };
  const observer = new window.ResizeObserver(refit);
  observer.observe(container);

  // Keyboard: Ctrl+5 toggles chat (right), Ctrl+6 files (left); Ctrl+7/8/9 open the add-on spaces.
  const onKey = (event) => {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    // Ctrl+` toggles the terminal (handled before the dock/space shortcuts).
    if (event.code === "Backquote") { event.preventDefault(); event.stopPropagation(); setTerminal(window, ctx, { toggle: true }); return; }
    const map = { Digit5: "dock:right", Digit6: "dock:left", Digit7: "space:viewer", Digit8: "space:artifacts", Digit9: "space:paint" };
    const name = map[event.code];
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    if (name.startsWith("dock:")) ctx.update(name.slice(5), { state: "toggle" });
    else ctx.shortcut(name.slice(6));
  };
  window.addEventListener("keydown", onKey, true);

  // Our own pages open as content tabs; they don't need the address toolbar.
  const markOwnTabs = () => markTabs(window, ctx.extension);
  const monitor = {
    monitorName: "mailWorkspace",
    // A tab is opened before its page loads; the title change marks the load.
    onTabTitleChanged: markOwnTabs,
    onTabSwitched: () => { markOwnTabs(); window.setTimeout(() => fit(window, null, ctxNotify(window)), 50); },
    onTabOpened: markOwnTabs,
    onTabClosing() {},
    onTabPersist() {},
    onTabRestored() {},
  };
  tabmail.registerTabMonitor(monitor);
  markOwnTabs();

  window.mailWorkspaceCleanup = () => {
    window.removeEventListener("keydown", onKey, true);
    tabmail.unregisterTabMonitor(monitor);
    observer.disconnect();
    stopSearch();
    document.getElementById("mw-files-dock-button")?.remove();
    document.getElementById("mw-appmenu-button")?.remove();
    document.getElementById("mw-terminal")?.remove();
    delete window.mwCtx;
    delete window.mwAutoStack;
  };
}

function markTabs(window, extension) {
  const prefix = extension.baseURI.spec;
  for (const info of window.gTabmail?.tabInfo ?? []) {
    const browser = info.browser ?? info.linkedBrowser;
    const own = Boolean(browser?.currentURI?.spec?.startsWith(prefix) || info.urlbar?.value?.startsWith(prefix));
    const panel = info.panel ?? browser?.closest?.("vbox, tabpanels > *");
    panel?.toggleAttribute?.("mw-own", own);
  }
}

function removeLayout(window, sheetUrl) {
  const document = window.document;
  window.mailWorkspaceCleanup?.();
  delete window.mailWorkspaceCleanup;
  for (const id of ["mw-dock-left", "mw-resizer-left", "mw-dock-right", "mw-resizer-right"]) document.getElementById(id)?.remove();
  document.getElementById("tabmail-container")?.removeAttribute("mw-maximized");
  document.documentElement.removeAttribute("mw-workspace");
  try { window.windowUtils.removeSheetUsingURIString(sheetUrl, window.windowUtils.AUTHOR_SHEET); } catch { /* not loaded */ }
}

// ------------------------------------------------------------------ theme --
// The main window gets chrome.css (with applyLayout); the mail, message and
// address book documents inside it get panes.css. Both build on the same
// tokens, and both are removed again when the add-on stops.

var PANE_DOCS = /^about:(3pane|message|addressbook)/;
var themeObserver = null;
var themedDocs = new Set();

function ctxNotify(window) {
  return (dock) => { window.mwCtx?.notify?.(dock); markSidebar(window, window.mwCtx?.filesSide ?? "left"); };
}

var APPEARANCE_PREF = "extensions.mailworkspace.appearance";
var THEME_ADDONS = { light: "thunderbird-compact-light@mozilla.org", dark: "thunderbird-compact-dark@mozilla.org", system: "default-theme@mozilla.org" };

/** Mark a document with the chosen appearance (tokens.css reads data-theme). */
function markAppearance(doc) {
  const mode = Services.prefs.getStringPref(APPEARANCE_PREF, "system");
  if (mode === "light" || mode === "dark") doc.documentElement?.setAttribute("data-theme", mode);
  else doc.documentElement?.removeAttribute("data-theme");
}

async function setAppearance(mode, windows) {
  Services.prefs.setStringPref(APPEARANCE_PREF, mode);
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const theme = await AddonManager.getAddonByID(THEME_ADDONS[mode] ?? THEME_ADDONS.system);
  if (theme && !theme.isActive) await theme.enable();
  for (const window of windows) markAppearance(window.document);
  for (const doc of themedDocs) markAppearance(doc);
  return { appearance: mode };
}

function themeDocument(doc, url) {
  if (!doc?.defaultView || themedDocs.has(doc)) return;
  markAppearance(doc);
  onePaneBehaviour(doc);
  dropEchoTooltips(doc);
  try {
    doc.defaultView.windowUtils.loadSheetUsingURIString(url, doc.defaultView.windowUtils.AUTHOR_SHEET);
    themedDocs.add(doc);
    doc.defaultView.addEventListener("unload", () => themedDocs.delete(doc), { once: true });
  } catch (error) { console.error("Mail Workspace theme", error); }
}

function paneDocuments(root) {
  const out = [];
  const visit = (doc, depth) => {
    if (depth > 3) return;
    for (const frame of doc.querySelectorAll("browser, iframe")) {
      let inner = null;
      try { inner = frame.contentDocument; } catch { continue; }
      if (!inner) continue;
      if (PANE_DOCS.test(inner.documentURI ?? "")) out.push(inner);
      visit(inner, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function installTheme(url, windows) {
  if (!themeObserver) {
    themeObserver = {
      observe(doc) {
        if (!PANE_DOCS.test(doc?.documentURI ?? "")) return;
        // The window exists once the root element is inserted; styles can load now.
        themeDocument(doc, url);
      },
    };
    Services.obs.addObserver(themeObserver, "document-element-inserted");
  }
  for (const window of windows) for (const doc of paneDocuments(window.document)) themeDocument(doc, url);
}

function removeTheme(url) {
  if (themeObserver) { Services.obs.removeObserver(themeObserver, "document-element-inserted"); themeObserver = null; }
  for (const doc of themedDocs) {
    try { doc.defaultView.windowUtils.removeSheetUsingURIString(url, doc.defaultView.windowUtils.AUTHOR_SHEET); } catch { /* gone */ }
  }
  themedDocs.clear();
}


// --------------------------------------------------------------- terminal --
// Ctrl+` slides a terminal up from the bottom. It covers what is under it
// (panels keep their layout) and keeps running while hidden.

var TERMINAL_HEIGHT_PREF = "extensions.mailworkspace.terminal.height";

function terminalState(window) {
  const panel = window.document.getElementById("mw-terminal");
  return {
    visible: Boolean(panel && !panel.hidden),
    maximized: panel?.hasAttribute("maximized") ?? false,
    height: Services.prefs.getIntPref(TERMINAL_HEIGHT_PREF, Math.round(window.innerHeight * 0.42)),
  };
}

function ensureTerminal(window, ctx) {
  const document = window.document;
  let panel = document.getElementById("mw-terminal");
  if (panel) return panel;
  panel = document.createElementNS(XHTML, "div");
  panel.id = "mw-terminal";
  panel.hidden = true;
  const grip = document.createElementNS(XHTML, "div");
  grip.className = "mw-terminal-grip";
  grip.title = "Drag to resize the terminal";
  grip.addEventListener("pointerdown", (event) => {
    grip.setPointerCapture(event.pointerId);
    panel.classList.add("resizing");
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const move = (e) => { panel.style.height = `${Math.max(120, Math.min(window.innerHeight - 60, startHeight + startY - e.clientY))}px`; };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", () => {
      grip.removeEventListener("pointermove", move);
      panel.classList.remove("resizing");
      Services.prefs.setIntPref(TERMINAL_HEIGHT_PREF, Math.round(panel.getBoundingClientRect().height));
    }, { once: true });
  });
  panel.append(grip);
  document.getElementById("messengerBody").append(panel);
  return panel;
}

function setTerminal(window, ctx, change = {}) {
  const panel = ensureTerminal(window, ctx);
  const visible = change.toggle ? panel.hidden : change.visible ?? !panel.hidden;
  if (change.maximized !== undefined) panel.toggleAttribute("maximized", change.maximized);
  if (Number.isInteger(change.height)) Services.prefs.setIntPref(TERMINAL_HEIGHT_PREF, Math.max(120, change.height));
  panel.style.height = panel.hasAttribute("maximized") ? "" : `${terminalState(window).height}px`;
  // The page (and its first shell) is created the first time the panel opens,
  // after the panel is shown, so its frame is laid out.
  if (visible) panel.hidden = false;
  if (visible && !panel.querySelector("browser")) {
    const { browser, load } = createExtensionBrowser(window.document, ctx.extension, ctx.terminalUrl);
    browser.id = "mw-terminal-browser";
    panel.append(browser);
    load?.();
  }
  panel.hidden = !visible;
  const browser = panel.querySelector("browser");
  if (visible) window.setTimeout(() => browser?.focus(), 50);
  else if (window.document.activeElement === browser) window.gTabmail?.currentTabInfo?.browser?.focus?.();
  return terminalState(window);
}
