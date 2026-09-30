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
var RAIL_WIDTH = 52;
var MIN_WIDTH = 260;
var DEFAULTS = {
  left: { state: "open", width: 400 },
  right: { state: "minimized", width: 340 },
};

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
  const load = () => {
    ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
    browser.fixupAndLoadURIString(url, { triggeringPrincipal: extension.principal });
  };
  // Navigation is only possible once the frame loader exists, and not inside the
  // event that announces it: Thunderbird's popups defer to a promise tick too.
  if (extension.remote) browser.addEventListener("XULFrameLoaderCreated", () => Promise.resolve().then(load), { once: true });
  return { browser, load: extension.remote ? null : load };
}

function applyDock(window, dock) {
  const document = window.document;
  const element = document.getElementById(`mw-dock-${dock.side}`);
  const resizer = document.getElementById(`mw-resizer-${dock.side}`);
  const container = document.getElementById("tabmail-container");
  if (!element || !container) return;
  element.dataset.state = dock.state;
  element.style.width = dock.state === "minimized" ? `${RAIL_WIDTH}px` : dock.state === "maximized" ? "" : `${dock.width}px`;
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
      dock.style.width = `${Math.max(MIN_WIDTH, Math.min(max(), startWidth + delta))}px`;
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

  // Keyboard: Ctrl+5 toggles chat, Ctrl+6 files; Ctrl+7/8/9 open the add-on spaces.
  const onKey = (event) => {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const map = { Digit5: "dock:left", Digit6: "dock:right", Digit7: "space:viewer", Digit8: "space:artifacts", Digit9: "space:paint" };
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
    onTabSwitched: markOwnTabs,
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

function themeDocument(doc, url) {
  if (!doc?.defaultView || themedDocs.has(doc)) return;
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
