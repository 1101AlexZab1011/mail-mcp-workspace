/* Mail Workspace Browser: web pages in Thunderbird's own content tabs, one tool in the space bar's Web
   group. Loaded into the Experiment's scope (with address.js); `installWeb` returns the undo.

   A web tab is a contentTab opened with linkHandler null: its browser is in the "browsers" message
   manager group, which Thunderbird does not restrict (links stay inside, target=_blank and
   window.open open further web tabs in the same group). The workspace hides Thunderbird's tab bar, so
   each web tab's toolbox gets a strip of the open web tabs, and its toolbar an editable address bar,
   reload/stop and a new-tab button. The agent reads and fills pages through the add-on's content
   script (background/web.js); clicks are sent from here, as real mouse input. */
/* global Services, ChromeUtils, Cc, Ci, ExtensionParent, parseAddress, webShortcut, makeSpaceButton */

var WEB_GROUP = "browsers";
var WEB_START = "https://www.google.com/";
var WEB_FALLBACK_SEARCH = "https://duckduckgo.com/?q=";
var WEB_BUTTON = "mw-browser-button";

function isWebTab(info) {
  return info?.mode?.name === "contentTab" && info.browser?.getAttribute("messagemanagergroup") === WEB_GROUP && !info.panel?.hasAttribute("mw-own");
}

function webTabs(window) {
  return (window.gTabmail?.tabInfo ?? []).filter(isWebTab);
}

/** The web tab the agent and the Web button mean: the current one, else the one shown last. */
function activeWebTab(window) {
  const current = window.gTabmail?.currentTabInfo;
  if (isWebTab(current)) return current;
  const tabs = webTabs(window);
  return tabs.find((info) => info === window.mwLastWebTab) ?? tabs.at(-1) ?? null;
}

/** Typed text → the URL to load: an address as it is, anything else through the default search engine. */
async function resolveAddress(input) {
  const parsed = parseAddress(input);
  if (!parsed) return null;
  if (parsed.url) return parsed.url;
  try {
    const engine = await Services.search.getDefault();
    if (engine) return engine.getSubmission(parsed.search).uri.spec;
  } catch (error) { console.warn("Mail Workspace: no default search engine", error); }
  return WEB_FALLBACK_SEARCH + encodeURIComponent(parsed.search);
}

/** Thunderbird's user agent with Firefox in its place: sites serve Thunderbird reduced pages (Google its
    legacy one), and a web tab is the Firefox engine Thunderbird is built on. */
function firefoxUserAgent() {
  const ua = Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler).userAgent;
  return ua.replace(/Thunderbird\/([\d.]+)/, "Firefox/$1");
}

/** Before its first request (it stays across navigations). */
function presentAsFirefox(info) {
  const context = info.browser?.browsingContext;
  if (context) context.customUserAgent = firefoxUserAgent();
}

function loadInTab(info, url) {
  // Typed into the address bar (or given by the agent on the user's behalf): loaded as the user's own navigation.
  info.browser.fixupAndLoadURIString(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
}

/** Open `input` (an address or search words) in the active web tab, or in a new one. Without input:
    show the active web tab, or open one on the start page (Google). */
async function openWeb(window, input, { newTab = false } = {}) {
  const tabmail = window.gTabmail;
  if (!input && !newTab) return showBrowser(window);
  const url = input ? await resolveAddress(input) : WEB_START;
  if (!url) throw new Error("Nothing to open");
  const target = newTab ? null : activeWebTab(window);
  let info = target;
  if (target) {
    tabmail.switchToTab(target);
    loadInTab(target, url);
  } else {
    // Opened blank and loaded after, so the first request already carries the Firefox user agent.
    info = tabmail.openTab("contentTab", { url: "about:blank", linkHandler: null, background: false });
    enhanceWebTab(window, info);
    presentAsFirefox(info);
    loadInTab(info, url);
  }
  renderWebChrome(window);
  // Loading has only begun: report where the tab is going.
  return { ...describeWebTab(window, info), url, loading: true };
}

/** The Web button: back to the web tab shown last, or a new one. */
function showBrowser(window) {
  const info = activeWebTab(window);
  if (info) { window.gTabmail.switchToTab(info); return describeWebTab(window, info); }
  return openWeb(window, "", { newTab: true });
}

function tabIdOf(info) {
  try { return ExtensionParent.apiManager.global.tabTracker.getId(info); } catch { return null; }
}

function describeWebTab(window, info) {
  if (!info) return null;
  const url = info.browser?.currentURI?.spec ?? null;
  return {
    id: tabIdOf(info),
    url,
    title: info.title ?? "",
    loading: Boolean(info.browser?.webProgress?.isLoadingDocument),
    current: window.gTabmail?.currentTabInfo === info,
  };
}

function webState(window) {
  const active = activeWebTab(window);
  return { tabs: webTabs(window).map((info) => ({ ...describeWebTab(window, info), active: info === active })) };
}

function webNavigate(window, action) {
  const info = activeWebTab(window);
  if (!info) throw new Error("No web tab is open");
  const browser = info.browser;
  if (action === "back") { if (!browser.canGoBack) throw new Error("There is no page to go back to"); browser.goBack(); }
  else if (action === "forward") { if (!browser.canGoForward) throw new Error("There is no page to go forward to"); browser.goForward(); }
  else if (action === "reload") browser.reload();
  else if (action === "stop") browser.stop();
  else if (action === "close") window.gTabmail.closeTab(info);
  else throw new Error(`Unknown navigation ${action}`);
  return { action, tab: action === "close" ? null : describeWebTab(window, info) };
}

/**
 * A real click at a point of the active web tab's page (content CSS pixels), sent as mouse input from
 * the window: pages see trusted events, as from the user. The tab is shown first.
 */
async function webClick(window, x, y) {
  const info = activeWebTab(window);
  if (!info) throw new Error("No web tab is open");
  if (window.gTabmail.currentTabInfo !== info) { window.gTabmail.switchToTab(info); await new Promise((r) => window.setTimeout(r, 200)); }
  const box = info.browser.getBoundingClientRect();
  const zoom = info.browser.fullZoom || 1;
  const at = { x: box.x + x * zoom, y: box.y + y * zoom };
  if (at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom) throw new Error("That point is outside the visible page");
  const send = (type, count) => {
    if (typeof window.synthesizeMouseEvent === "function") window.synthesizeMouseEvent(type, at.x, at.y, { button: 0, clickCount: count });
    else window.windowUtils.sendMouseEvent(type, at.x, at.y, 0, count, 0);
  };
  send("mousemove", 0);
  send("mousedown", 1);
  send("mouseup", 1);
  await new Promise((r) => window.setTimeout(r, 150));
  return { clicked: true };
}

// ------------------------------------------------------------- the toolbar --

function webIcon(document, name) {
  const img = document.createElementNS(MW_XHTML, "img");
  img.alt = "";
  img.src = `resource://mailworkspace/icons/${name}.svg`;
  return img;
}

function webButton(document, { className, title, icon, onclick }) {
  const button = document.createElementNS(MW_XHTML, "button");
  button.className = `mw-web-btn ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(webIcon(document, icon));
  button.addEventListener("click", onclick);
  return button;
}

/** Give a web tab the workspace's address bar, reload/stop, new tab and the strip of web tabs. */
function enhanceWebTab(window, info) {
  if (!info?.toolbar || info.mwWeb) return;
  const document = window.document;
  info.mwWeb = true;
  info.panel?.setAttribute("mw-web", "");
  const toolbox = info.toolbar.parentNode;

  const strip = document.createElementNS(MW_XHTML, "div");
  strip.className = "mw-web-tabs";
  strip.setAttribute("role", "tablist");
  toolbox.insertBefore(strip, info.toolbar);

  const reload = webButton(document, { className: "mw-web-reload", title: "Reload (Ctrl+R)", icon: "refresh", onclick: () => (info.browser.webProgress?.isLoadingDocument ? info.browser.stop() : info.browser.reload()) });
  info.forwardButton.after(reload);

  const urlbar = info.urlbar;
  urlbar.removeAttribute("readonly");
  urlbar.setAttribute("placeholder", "Search or enter address");
  urlbar.setAttribute("spellcheck", "false");
  const onUrlKey = async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      // As in Firefox: Ctrl+Enter completes a bare word to www.….com, Shift+Enter to .net; Alt+Enter opens a new tab.
      const word = urlbar.value.trim();
      const tld = /^[\p{L}\p{N}-]+$/u.test(word) && !event.altKey ? (event.ctrlKey ? ".com" : event.shiftKey ? ".net" : "") : "";
      const input = tld ? `www.${word}${tld}` : urlbar.value;
      if (event.altKey) { void openWeb(window, input, { newTab: true }); return; }
      const url = await resolveAddress(input);
      if (url) { loadInTab(info, url); info.browser.focus(); }
    } else if (event.key === "Escape") {
      urlbar.value = info.browser.currentURI?.spec === "about:blank" ? "" : info.browser.currentURI?.spec ?? "";
      urlbar.select();
    }
  };
  const onUrlFocus = () => window.setTimeout(() => urlbar.select(), 0);
  urlbar.addEventListener("keydown", onUrlKey);
  urlbar.addEventListener("focus", onUrlFocus);

  // Loading state for the reload button; title and favicon changes reach the strip through the tab monitor.
  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    onStateChange(webProgress, request, flags) {
      if (!webProgress?.isTopLevel || !(flags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) return;
      if (flags & (Ci.nsIWebProgressListener.STATE_START | Ci.nsIWebProgressListener.STATE_STOP)) renderWebChrome(window);
    },
    onLocationChange(webProgress) {
      if (!webProgress?.isTopLevel) return;
      if (info.browser.currentURI?.spec === "about:blank" && document.activeElement !== urlbar) urlbar.value = "";
      renderWebChrome(window);
    },
    onProgressChange() {}, onStatusChange() {}, onSecurityChange() {}, onContentBlockingEvent() {},
  };
  info.browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_NETWORK | Ci.nsIWebProgress.NOTIFY_LOCATION);

  info.mwWebUndo = () => {
    try { info.browser.removeProgressListener(listener); } catch { /* browser gone */ }
    try { info.browser.browsingContext.customUserAgent = ""; } catch { /* browser gone */ }
    urlbar.removeEventListener("keydown", onUrlKey);
    urlbar.removeEventListener("focus", onUrlFocus);
    urlbar.setAttribute("readonly", "readonly");
    strip.remove();
    reload.remove();
    info.panel?.removeAttribute("mw-web");
    delete info.mwWeb;
    delete info.mwWebUndo;
  };
}

function faviconOf(info) {
  return info.favIconUrl || null;
}

/** Redraw every web tab's strip and reload button, and the Web button's state. */
function renderWebChrome(window) {
  if (window.mwWebQueued) return;
  window.mwWebQueued = window.requestAnimationFrame(() => {
    window.mwWebQueued = 0;
    const document = window.document;
    const tabmail = window.gTabmail;
    const tabs = webTabs(window);
    for (const info of tabs) {
      enhanceWebTab(window, info);
      const strip = info.toolbar?.parentNode?.querySelector(".mw-web-tabs");
      if (strip) {
        strip.replaceChildren(...tabs.map((tab) => {
          const chip = document.createElementNS(MW_XHTML, "div");
          chip.className = "mw-web-tab";
          chip.setAttribute("role", "tab");
          chip.setAttribute("aria-selected", String(tab === info));
          chip.title = `${tab.title || ""}\n${tab.browser?.currentURI?.spec ?? ""}`.trim();
          const loading = Boolean(tab.browser?.webProgress?.isLoadingDocument);
          chip.toggleAttribute("loading", loading);
          const icon = faviconOf(tab);
          const img = icon ? Object.assign(document.createElementNS(MW_XHTML, "img"), { src: icon, alt: "" }) : webIcon(document, "public");
          img.className = "mw-web-tab-icon";
          const label = document.createElementNS(MW_XHTML, "span");
          label.className = "mw-web-tab-label";
          label.textContent = tab.title && tab.title !== "about:blank" ? tab.title : "New tab";
          const close = webButton(document, { className: "mw-web-tab-close", title: "Close tab", icon: "close", onclick: (event) => { event.stopPropagation(); tabmail.closeTab(tab); } });
          chip.append(img, label, close);
          chip.addEventListener("click", () => tabmail.switchToTab(tab));
          chip.addEventListener("auxclick", (event) => { if (event.button === 1) tabmail.closeTab(tab); });
          return chip;
        }), webButton(document, { className: "mw-web-new", title: "New tab (Ctrl+T)", icon: "add", onclick: () => void openWeb(window, "", { newTab: true }) }));
      }
      const reload = info.toolbar?.querySelector(".mw-web-reload");
      if (reload) {
        const loading = Boolean(info.browser?.webProgress?.isLoadingDocument);
        reload.replaceChildren(webIcon(document, loading ? "close" : "refresh"));
        reload.title = loading ? "Stop (Esc)" : "Reload (Ctrl+R)";
      }
    }
    document.getElementById(WEB_BUTTON)?.classList.toggle("current", isWebTab(tabmail?.currentTabInfo));
  });
}

/** The Web group's tool button, the tab monitor and the keys; returns the undo. */
/** Carry out a Firefox shortcut in a web tab; false leaves the key to the page (Escape while nothing loads). */
function runWebShortcut(window, info, { command, index }) {
  const tabmail = window.gTabmail;
  const browser = info.browser;
  const tabs = webTabs(window);
  const step = (by) => tabmail.switchToTab(tabs[(tabs.indexOf(info) + by + tabs.length) % tabs.length]);
  switch (command) {
    case "address": info.urlbar?.focus(); info.urlbar?.select(); break;
    case "new-tab": void openWeb(window, "", { newTab: true }); break;
    case "close-tab": tabmail.closeTab(info); break;
    case "reopen-tab": {
      const url = window.mwClosedWebTabs?.pop();
      if (url) void openWeb(window, url, { newTab: true });
      break;
    }
    case "next-tab": step(1); break;
    case "previous-tab": step(-1); break;
    case "tab": { const tab = tabs.at(index); if (tab) tabmail.switchToTab(tab); break; }
    case "back": if (browser.canGoBack) browser.goBack(); break;
    case "forward": if (browser.canGoForward) browser.goForward(); break;
    case "home": loadInTab(info, WEB_START); break;
    case "reload": browser.reload(); break;
    case "hard-reload": browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE | Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY); break;
    case "stop":
      if (!browser.webProgress?.isLoadingDocument || window.document.activeElement === info.urlbar) return false;
      browser.stop();
      break;
    case "find": info.findbar?.onFindCommand(); break;
    case "find-next": info.findbar?.onFindAgainCommand(false); break;
    case "find-previous": info.findbar?.onFindAgainCommand(true); break;
    case "print": window.PrintUtils?.startPrintWindow(browser.browsingContext); break;
    case "view-source": if (browser.currentURI?.schemeIs("http") || browser.currentURI?.schemeIs("https")) void openWeb(window, `view-source:${browser.currentURI.spec}`, { newTab: true }); break;
    default: return false;
  }
  return true;
}

function installWeb(window) {
  const document = window.document;
  const tabmail = window.gTabmail;
  const top = document.querySelector("#spacesToolbar .spaces-toolbar-top-container");
  if (!top || !tabmail || document.getElementById(WEB_BUTTON)) return () => {};
  const button = makeSpaceButton(document, { id: WEB_BUTTON, title: "Browser (Ctrl+Shift+9)", icon: "public", onclick: () => void showBrowser(window) });
  top.insertBefore(button, document.getElementById("mw-files-dock-button")?.nextSibling ?? null);

  const monitor = {
    monitorName: "mailWorkspaceWeb",
    onTabTitleChanged: () => renderWebChrome(window),
    onTabSwitched(tab) { if (isWebTab(tab)) window.mwLastWebTab = tab; renderWebChrome(window); },
    // Tabs a page opens (target=_blank, window.open) arrive here before their first load.
    onTabOpened(tab) { if (isWebTab(tab)) presentAsFirefox(tab); renderWebChrome(window); },
    onTabClosing(tab) {
      if (window.mwLastWebTab === tab) window.mwLastWebTab = null;
      // For Ctrl+Shift+T.
      const url = isWebTab(tab) ? tab.browser?.currentURI?.spec : null;
      if (url && url !== "about:blank") window.mwClosedWebTabs = [...(window.mwClosedWebTabs ?? []), url].slice(-20);
      window.setTimeout(() => renderWebChrome(window), 0);
    },
    onTabPersist() {},
    onTabRestored: () => renderWebChrome(window),
  };
  tabmail.registerTabMonitor(monitor);

  // Ctrl+Shift+9 opens the Browser; in a web tab, Firefox's shortcuts (shortcuts.js) win over Thunderbird's.
  const onKey = (event) => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "Digit9") { event.preventDefault(); event.stopPropagation(); void showBrowser(window); return; }
    const info = tabmail.currentTabInfo;
    if (!isWebTab(info)) return;
    const shortcut = webShortcut(event);
    if (shortcut && runWebShortcut(window, info, shortcut)) { event.preventDefault(); event.stopPropagation(); }
  };
  window.addEventListener("keydown", onKey, true);
  renderWebChrome(window);

  return () => {
    window.removeEventListener("keydown", onKey, true);
    tabmail.unregisterTabMonitor(monitor);
    for (const info of tabmail.tabInfo ?? []) info.mwWebUndo?.();
    if (window.mwWebQueued) window.cancelAnimationFrame(window.mwWebQueued);
    delete window.mwWebQueued;
    delete window.mwLastWebTab;
    delete window.mwClosedWebTabs;
    button.remove();
  };
}
