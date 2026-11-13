/* Mail Workspace Browser: web pages in Thunderbird's own content tabs, in sessions: the space bar's Web
   group lists them. Loaded into the Experiment's scope (with address.js, shortcuts.js and websessions.js);
   `installWeb` returns the undo.

   A session is a named browser profile: its tabs live in a container of their own (userContextId), so
   each has its own cookies, logins and storage, and none shares Thunderbird's (container 0, where mail
   accounts sign in). The list is in a pref (websessions.js); the containers are
   ContextualIdentityService's. Tabs keep their container across restarts (content tabs persist it).

   A web tab is a contentTab opened with linkHandler null: its browser is in the "browsers" message
   manager group, which Thunderbird does not restrict (links stay inside, target=_blank and
   window.open open further web tabs in the same group). The workspace hides Thunderbird's tab bar, so
   each web tab's toolbox gets a strip of the open web tabs, and its toolbar an editable address bar,
   reload/stop and a new-tab button. The agent reads and fills pages through the add-on's content
   script (background/web.js); clicks are sent from here, as real mouse input. */
/* global Services, ChromeUtils, Cc, Ci, ExtensionParent, parseAddress, webShortcut, accelKey, keyHint, makeSpaceButton, GROUP_FLYOUTS,
   WEB_SESSIONS_PREF, parseWebSessions, serializeWebSessions, findWebSession, webSessionName, newWebSessionId,
   WEB_MENU, ABOUT_LOGINS, openWebMenu, closeWebMenu, recordVisit, recordTitle, noteSiteIcon, dropSessionHistory, savePage, prepareWebPrefs */

var WEB_GROUP = "browsers";
var WEB_START = "https://www.google.com/";
var WEB_FALLBACK_SEARCH = "https://duckduckgo.com/?q=";
var WEB_BUTTON = "mw-browser-button";

function isWebTab(info) {
  return info?.mode?.name === "contentTab" && info.browser?.getAttribute("messagemanagergroup") === WEB_GROUP && !info.panel?.hasAttribute("mw-own");
}

// ------------------------------------------------------------- sessions --

function containers() {
  const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
  ContextualIdentityService.ensureDataReady();
  return ContextualIdentityService;
}

function readSessions() { return parseWebSessions(Services.prefs.getStringPref(WEB_SESSIONS_PREF, "")); }
function writeSessions(state) { Services.prefs.setStringPref(WEB_SESSIONS_PREF, serializeWebSessions(state)); }

/** The container a tab's page lives in (the attribute, else what its browsing context says). */
function containerOf(info) {
  const attribute = Number(info?.browser?.getAttribute("usercontextid"));
  if (attribute) return attribute;
  try { return info?.browser?.browsingContext?.originAttributes?.userContextId ?? 0; } catch { return 0; }
}

/** Write a tab's container into its attribute, which is what Thunderbird persists: tabs a page opens
    (window.open) get their opener's container without it. */
function pinContainer(info) {
  if (!info?.browser || info.browser.getAttribute("usercontextid")) return;
  const container = containerOf(info);
  if (container) info.browser.setAttribute("usercontextid", String(container));
}

function sessionOfTab(info, state = readSessions()) {
  const container = containerOf(info);
  return state.sessions.find((s) => s.userContextId === container) ?? null;
}

/** A new session with a container of its own; it becomes the last used one. */
function createSession(name) {
  const state = readSessions();
  const identity = containers().create(`Mail Workspace · ${name}`, "fingerprint", "blue");
  const session = { id: newWebSessionId(state.sessions), name, userContextId: identity.userContextId };
  state.sessions.push(session);
  state.last = session.id;
  writeSessions(state);
  return session;
}

/** By id or name; with `create`, an unknown name makes a new session. */
function resolveSession(key, { create = false } = {}) {
  const found = findWebSession(readSessions().sessions, key);
  if (found || !create || !String(key ?? "").trim()) return found;
  return createSession(String(key).trim());
}

function renameSession(id, name) {
  const text = String(name ?? "").trim();
  const state = readSessions();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) throw new Error("No such session");
  if (!text) throw new Error("A session needs a name");
  if (state.sessions.some((s) => s !== session && s.name.toLowerCase() === text.toLowerCase())) throw new Error(`There is already a session "${text}"`);
  session.name = text;
  writeSessions(state);
  try { containers().update(session.userContextId, `Mail Workspace · ${text}`, "fingerprint", "blue"); } catch { /* the name is ours */ }
  return session;
}

/** The user's alone (the flyout's delete): closes the session's tabs and wipes its cookies, logins and storage. */
function deleteSession(window, id) {
  const state = readSessions();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  for (const info of webTabs(window, session)) window.gTabmail.closeTab(info);
  // Removing the container clears its data; one that is already gone is cleared all the same.
  if (!containers().remove(session.userContextId)) Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId: session.userContextId });
  state.sessions = state.sessions.filter((s) => s !== session);
  if (state.last === id) state.last = state.sessions[0]?.id ?? null;
  writeSessions(state);
  window.mwClosedWebTabs?.delete(id);
  window.mwLastWebTabs?.delete(id);
  dropSessionHistory(id);
}

/** The session there always is: the first run makes "Main". */
function ensureSession(state = readSessions()) {
  return findWebSession(state.sessions, state.last) ?? state.sessions[0] ?? createSession("Main");
}

/**
 * Web tabs outside any session (from before sessions, or Thunderbird's container 0) are reopened in the
 * last used session, at the same address, and closed.
 */
function adoptStrayTabs(window) {
  const state = readSessions();
  const strays = (window.gTabmail?.tabInfo ?? []).filter((info) => isWebTab(info) && !sessionOfTab(info, state));
  if (!strays.length) return;
  const session = ensureSession(state);
  for (const info of strays) {
    const url = info.browser?.currentURI?.spec;
    if (url && url !== "about:blank") openTabIn(window, session, url, { background: true });
    window.gTabmail.closeTab(info);
  }
}

/** The web tabs, or one session's. */
function webTabs(window, session = null) {
  const tabs = (window.gTabmail?.tabInfo ?? []).filter(isWebTab);
  return session ? tabs.filter((info) => containerOf(info) === session.userContextId) : tabs;
}

/** The web tab the agent and the Web button mean: the current one, else the one shown last. */
function activeWebTab(window) {
  const current = window.gTabmail?.currentTabInfo;
  if (isWebTab(current)) return current;
  const tabs = webTabs(window);
  return tabs.find((info) => info === window.mwLastWebTab) ?? tabs.at(-1) ?? null;
}

/** The session in front: the active web tab's, else the last used one. */
function currentSession(window) {
  const state = readSessions();
  const info = activeWebTab(window);
  return (info && sessionOfTab(info, state)) ?? findWebSession(state.sessions, state.last) ?? state.sessions[0] ?? null;
}

/** A session's tab to show: the current one if it is the session's, else the one shown last, else its newest. */
function lastTabOf(window, session) {
  const tabs = webTabs(window, session);
  const current = window.gTabmail?.currentTabInfo;
  if (tabs.includes(current)) return current;
  const last = window.mwLastWebTabs?.get(session.id);
  return tabs.includes(last) ? last : tabs.at(-1) ?? null;
}

/**
 * The tab to show when the current web tab closes, as in Firefox: its right neighbour in the session's
 * strip, else its left one; the session's last tab gives way to the tab the Browser was entered from.
 * Thunderbird itself would pick the next tab of its hidden strip, which may be any space (Settings, Files).
 */
function tabAfterClosing(window, info) {
  const tabmail = window.gTabmail;
  const session = sessionOfTab(info);
  const tabs = session ? webTabs(window, session) : webTabs(window);
  const index = tabs.indexOf(info);
  const next = tabs[index + 1] ?? tabs[index - 1];
  if (next) return next;
  const before = window.mwBeforeWebTab;
  if (before && before !== info && tabmail.tabInfo.includes(before)) return before;
  return tabmail.tabInfo.find((tab) => tab !== info && tab.mode?.name === "mail3PaneTab") ?? null;
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

/** A new web tab in a session's container. Opened blank and loaded after, so the first request already
    carries the Firefox user agent. */
function openTabIn(window, session, url, { background = false } = {}) {
  const info = window.gTabmail.openTab("contentTab", { url: "about:blank", linkHandler: null, background, userContextId: session.userContextId });
  enhanceWebTab(window, info);
  presentAsFirefox(info);
  loadInTab(info, url);
  return info;
}

/** Open `input` (an address or search words) in the session's tab shown last, or in a new one. Without
    input: show the session, or open a tab on the start page (Google). The session is the current one
    unless named; an unknown name makes a new session. */
async function openWeb(window, input, { newTab = false, session: key = null } = {}) {
  const session = key ? resolveSession(key, { create: true }) : currentSession(window) ?? ensureSession();
  if (!input && !newTab) return showBrowser(window, session.id);
  const url = input ? await resolveAddress(input) : WEB_START;
  if (!url) throw new Error("Nothing to open");
  const target = newTab ? null : lastTabOf(window, session);
  let info = target;
  if (target) {
    window.gTabmail.switchToTab(target);
    loadInTab(target, url);
  } else {
    info = openTabIn(window, session, url);
  }
  renderWebChrome(window);
  // Loading has only begun: report where the tab is going.
  return { ...describeWebTab(window, info), url, loading: true };
}

/** The Web button, a session in the flyout: back to the session's tab shown last, or a new one. */
function showBrowser(window, key = null) {
  const session = (key && resolveSession(key)) || currentSession(window) || ensureSession();
  const info = lastTabOf(window, session);
  if (info) { window.gTabmail.switchToTab(info); return describeWebTab(window, info); }
  return openWeb(window, "", { newTab: true, session: session.id });
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
    session: sessionOfTab(info)?.name ?? null,
    loading: Boolean(info.browser?.webProgress?.isLoadingDocument),
    current: window.gTabmail?.currentTabInfo === info,
  };
}

function webState(window) {
  const active = activeWebTab(window);
  const current = currentSession(window);
  return {
    sessions: readSessions().sessions.map((s) => ({ id: s.id, name: s.name, tabs: webTabs(window, s).length, current: s.id === current?.id })),
    tabs: webTabs(window).map((info) => ({ ...describeWebTab(window, info), active: info === active })),
  };
}

/** The agent's session commands: switch to one, create one, rename one. Deleting is the user's alone. */
async function webSession(window, action, name, newName) {
  if (action === "switch") {
    const session = resolveSession(name);
    if (!session) throw new Error(`No session "${name}"; web_state lists them`);
    await showBrowser(window, session.id);
  } else if (action === "create") {
    if (resolveSession(name)) throw new Error(`There is already a session "${name}"`);
    const session = createSession(String(name ?? "").trim() || webSessionName(readSessions().sessions));
    await openWeb(window, "", { newTab: true, session: session.id });
  } else if (action === "rename") {
    const session = resolveSession(name);
    if (!session) throw new Error(`No session "${name}"; web_state lists them`);
    renameSession(session.id, newName);
    renderWebChrome(window);
  } else throw new Error(`Unknown session action ${action}`);
  return webState(window);
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
  if (info.browser?.currentURI?.spec === ABOUT_LOGINS) throw new Error("The saved passwords are the user's alone");
  window.mwAgentInputUntil = Date.now() + 1500;
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
  button.title = keyHint(title);
  button.setAttribute("aria-label", keyHint(title));
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

  // ☰: the session's menu (webmenu.js), at the end of the toolbar as in Firefox.
  const menu = webButton(document, { className: "mw-web-menu-btn", title: "Open menu", icon: "menu", onclick: () => {
    if (menu.getAttribute("aria-expanded") === "true") closeWebMenu(window);
    else openWebMenu(window, info);
  } });
  menu.setAttribute("aria-haspopup", "menu");
  menu.setAttribute("aria-expanded", "false");
  info.toolbar.append(menu);

  const urlbar = info.urlbar;
  urlbar.removeAttribute("readonly");
  urlbar.setAttribute("placeholder", "Search or enter address");
  urlbar.setAttribute("spellcheck", "false");
  const onUrlKey = async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      // As in Firefox: Ctrl+Enter completes a bare word to www.….com, Shift+Enter to .net; Alt+Enter opens a new tab.
      const word = urlbar.value.trim();
      const tld = /^[\p{L}\p{N}-]+$/u.test(word) && !event.altKey ? (accelKey(event) ? ".com" : event.shiftKey ? ".net" : "") : "";
      const input = tld ? `www.${word}${tld}` : urlbar.value;
      if (event.altKey) { void openWeb(window, input, { newTab: true, session: sessionOfTab(info)?.id }); return; }
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
      const spec = info.browser.currentURI?.spec ?? "";
      if (document.activeElement !== urlbar) urlbar.value = spec === "about:blank" ? "" : spec;
      void recordVisit(info);
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
    menu.remove();
    info.panel?.removeAttribute("mw-web");
    delete info.mwWeb;
    delete info.mwWebUndo;
  };
}

function faviconOf(info) {
  if (info.browser?.currentURI?.spec === ABOUT_LOGINS) return "resource://mailworkspace/icons/key.svg";
  return info.favIconUrl || null;
}

/** Redraw every web tab's strip (its session's tabs) and reload button, and the Web button's state. */
function renderWebChrome(window) {
  if (window.mwWebQueued) return;
  window.mwWebQueued = window.requestAnimationFrame(() => {
    window.mwWebQueued = 0;
    const document = window.document;
    const tabmail = window.gTabmail;
    const state = readSessions();
    for (const info of webTabs(window)) {
      enhanceWebTab(window, info);
      pinContainer(info);
      void noteSiteIcon(info);
      const session = sessionOfTab(info, state);
      const tabs = session ? webTabs(window, session) : [info];
      const strip = info.toolbar?.parentNode?.querySelector(".mw-web-tabs");
      if (strip) {
        // The session's name leads the strip and opens the session list.
        const name = document.createElementNS(MW_XHTML, "button");
        name.className = "mw-web-session";
        name.title = "Browser sessions";
        name.textContent = session?.name ?? "No session";
        name.addEventListener("click", () => window.mwOpenToolGroup?.("web", name));
        strip.replaceChildren(name, ...tabs.map((tab) => {
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
        }), webButton(document, { className: "mw-web-new", title: "New tab (Ctrl+T)", icon: "add", onclick: () => void openWeb(window, "", { newTab: true, session: session?.id }) }));
      }
      const reload = info.toolbar?.querySelector(".mw-web-reload");
      if (reload) {
        const loading = Boolean(info.browser?.webProgress?.isLoadingDocument);
        reload.replaceChildren(webIcon(document, loading ? "close" : "refresh"));
        reload.title = loading ? "Stop (Esc)" : keyHint("Reload (Ctrl+R)");
      }
    }
    document.getElementById(WEB_BUTTON)?.classList.toggle("current", isWebTab(tabmail?.currentTabInfo));
  });
}

/** Carry out a Firefox shortcut in a web tab, within its session; false leaves the key to the page
    (Escape while nothing loads). */
function runWebShortcut(window, info, { command, index }) {
  const tabmail = window.gTabmail;
  const browser = info.browser;
  const session = sessionOfTab(info);
  const tabs = session ? webTabs(window, session) : [info];
  const step = (by) => tabmail.switchToTab(tabs[(tabs.indexOf(info) + by + tabs.length) % tabs.length]);
  const inSession = { newTab: true, session: session?.id };
  switch (command) {
    case "address": info.urlbar?.focus(); info.urlbar?.select(); break;
    case "new-tab": void openWeb(window, "", inSession); break;
    case "close-tab": tabmail.closeTab(info); break;
    case "reopen-tab": {
      const url = window.mwClosedWebTabs?.get(session?.id)?.pop();
      if (url) void openWeb(window, url, inSession);
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
    case "save-page": void savePage(window, info).then(() => openWebMenu(window, info, "downloads"), (error) => console.warn("Mail Workspace:", error.message)); break;
    case "history": openWebMenu(window, info, "history"); break;
    case "downloads": openWebMenu(window, info, "downloads"); break;
    case "view-source": if (browser.currentURI?.schemeIs("http") || browser.currentURI?.schemeIs("https")) void openWeb(window, `view-source:${browser.currentURI.spec}`, inSession); break;
    default: return false;
  }
  return true;
}

// ------------------------------------------------- the sessions flyout --
// The Web group's flyout (groups.js) lists the sessions instead of tools: click one to go to it, double-
// click or F2 to rename it, × to delete it (the user's alone: it wipes the session's logins).

/** True while the agent sends input to the window (automation.js): user-only controls ignore it. */
function agentActing(window) {
  return Date.now() < (window.mwAgentInputUntil ?? 0);
}

function webSessionsFlyout(window, { rerender, close }) {
  const document = window.document;
  const html = (tag, className, text) => {
    const el = document.createElementNS(MW_XHTML, tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const state = readSessions();
  const current = currentSession(window);

  function startRename(row, session) {
    if (row.hasAttribute("mw-busy")) return;
    row.setAttribute("mw-busy", "");
    const input = html("input", "mw-web-session-rename");
    input.value = session.name;
    input.setAttribute("aria-label", "Session name");
    row.querySelector(".mw-group-item-label").replaceWith(input);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== session.name) {
        try { renameSession(session.id, input.value); renderWebChrome(window); } catch (error) { console.warn("Mail Workspace:", error.message); }
      }
      rerender();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.focus();
    input.select();
  }

  function askDelete(row, session) {
    if (agentActing(window) || row.hasAttribute("mw-busy")) return;
    row.setAttribute("mw-busy", "");
    row.classList.add("mw-web-session-confirm");
    const yes = html("button", "mw-web-session-yes", "Delete");
    const no = html("button", "mw-web-session-no", "Cancel");
    for (const button of [yes, no]) { button.type = "button"; button.setAttribute("data-user-only", ""); }
    yes.addEventListener("click", (event) => {
      event.stopPropagation();
      if (agentActing(window)) return;
      deleteSession(window, session.id);
      renderWebChrome(window);
      rerender();
    });
    no.addEventListener("click", (event) => { event.stopPropagation(); rerender(); });
    row.replaceChildren(html("span", "mw-group-item-label", `Delete “${session.name}” and its logins?`), yes, no);
    no.focus();
  }

  const rows = state.sessions.map((session) => {
    const row = html("div", "mw-group-item mw-web-session-item");
    row.setAttribute("role", "menuitem");
    row.dataset.session = session.id;
    if (session.id === current?.id) row.classList.add("current");
    const img = html("img");
    img.alt = "";
    img.src = "resource://mailworkspace/icons/public.svg";
    const count = webTabs(window, session).length;
    const remove = html("button", "mw-web-session-delete");
    remove.type = "button";
    remove.title = "Delete session…";
    remove.setAttribute("aria-label", `Delete session ${session.name}`);
    remove.setAttribute("data-user-only", "");
    remove.append(webIcon(document, "close"));
    remove.addEventListener("click", (event) => { event.stopPropagation(); askDelete(row, session); });
    row.append(img, html("span", "mw-group-item-label", session.name), html("span", "mw-group-item-key", `${count} ${count === 1 ? "tab" : "tabs"}`), remove);
    // A click goes to the session, unless it was the first of a double-click (rename).
    let pending = 0;
    row.addEventListener("click", () => {
      if (row.hasAttribute("mw-busy")) return;
      window.clearTimeout(pending);
      pending = window.setTimeout(() => { close(); void showBrowser(window, session.id); }, 220);
    });
    row.addEventListener("dblclick", () => { window.clearTimeout(pending); startRename(row, session); });
    row.onFlyoutKey = (event) => {
      if (event.key === "F2") { startRename(row, session); return true; }
      if (event.key === "Delete") { askDelete(row, session); return true; }
      return false;
    };
    return row;
  });

  const add = html("div", "mw-group-item mw-web-session-new");
  add.setAttribute("role", "menuitem");
  const plus = html("img");
  plus.alt = "";
  plus.src = "resource://mailworkspace/icons/add.svg";
  add.append(plus, html("span", "mw-group-item-label", "New session"));
  add.addEventListener("click", async () => {
    const session = createSession(webSessionName(readSessions().sessions));
    await openWeb(window, "", { newTab: true, session: session.id });
    const flyout = rerender();
    const row = flyout?.querySelector(`[data-session="${session.id}"]`);
    if (row) startRename(row, session);
  });
  return [...rows, add];
}
GROUP_FLYOUTS.web = webSessionsFlyout;

/** The Web group's tool button, the tab monitor and the keys; returns the undo. */
function installWeb(window) {
  const document = window.document;
  const tabmail = window.gTabmail;
  const top = document.querySelector("#spacesToolbar .spaces-toolbar-top-container");
  if (!top || !tabmail || document.getElementById(WEB_BUTTON)) return () => {};
  const button = makeSpaceButton(document, { id: WEB_BUTTON, title: "Browser (Ctrl+Shift+9)", icon: "public", onclick: () => void showBrowser(window) });
  top.insertBefore(button, document.getElementById("mw-files-dock-button")?.nextSibling ?? null);
  window.mwLastWebTabs = new Map();
  window.mwClosedWebTabs = new Map();

  const monitor = {
    monitorName: "mailWorkspaceWeb",
    onTabTitleChanged(tab) { if (isWebTab(tab)) void recordTitle(tab); renderWebChrome(window); },
    onTabSwitched(tab, oldTab) {
      closeWebMenu(window);
      if (oldTab && !isWebTab(oldTab) && isWebTab(tab)) window.mwBeforeWebTab = oldTab;
      if (isWebTab(tab)) {
        window.mwLastWebTab = tab;
        const state = readSessions();
        const session = sessionOfTab(tab, state);
        if (session) {
          window.mwLastWebTabs.set(session.id, tab);
          if (state.last !== session.id) { state.last = session.id; writeSessions(state); }
        }
      }
      renderWebChrome(window);
    },
    // Tabs a page opens (target=_blank, window.open) arrive here before their first load. Their page is
    // in the opener's container; the attribute is made to say so, so the tab is persisted in its session.
    onTabOpened(tab) {
      if (isWebTab(tab)) {
        presentAsFirefox(tab);
        // Its page may not be set up yet: the container is read again once it is.
        window.setTimeout(() => { pinContainer(tab); if (!sessionOfTab(tab)) adoptStrayTabs(window); }, 0);
      }
      renderWebChrome(window);
    },
    onTabClosing(tab) {
      if (window.mwLastWebTab === tab) window.mwLastWebTab = null;
      if (window.mwBeforeWebTab === tab) window.mwBeforeWebTab = null;
      // closeTab selects its opener, when one is set, once the current tab is gone.
      if (isWebTab(tab) && tabmail.currentTabInfo === tab) tabmail.mLastTabOpener = tabAfterClosing(window, tab);
      // For Ctrl+Shift+T, per session.
      const session = isWebTab(tab) ? sessionOfTab(tab) : null;
      const url = session ? tab.browser?.currentURI?.spec : null;
      if (url && url !== "about:blank") window.mwClosedWebTabs.set(session.id, [...(window.mwClosedWebTabs.get(session.id) ?? []), url].slice(-20));
      window.setTimeout(() => renderWebChrome(window), 0);
    },
    onTabPersist() {},
    onTabRestored() { window.setTimeout(() => { adoptStrayTabs(window); renderWebChrome(window); }, 0); },
  };
  tabmail.registerTabMonitor(monitor);
  prepareWebPrefs();
  adoptStrayTabs(window);

  // Ctrl+Shift+9 opens the Browser; in a web tab, Firefox's shortcuts (shortcuts.js) win over Thunderbird's.
  const onKey = (event) => {
    if (accelKey(event) && event.shiftKey && !event.altKey && event.code === "Digit9") { event.preventDefault(); event.stopPropagation(); void showBrowser(window); return; }
    const info = tabmail.currentTabInfo;
    if (!isWebTab(info)) return;
    const shortcut = webShortcut(event);
    // about:logins searches its list on Ctrl+F, as in Firefox.
    if (shortcut?.command === "find" && info.browser?.currentURI?.spec === ABOUT_LOGINS) return;
    if (shortcut && runWebShortcut(window, info, shortcut)) { event.preventDefault(); event.stopPropagation(); }
  };
  window.addEventListener("keydown", onKey, true);
  // A tab's icon arrives after its page: the strip and the site icons follow it.
  const onTabAttr = () => renderWebChrome(window);
  window.addEventListener("TabAttrModified", onTabAttr);
  // about:logins opens a site in a new tab of its own tab's session.
  window.mwOpenWebFrom = (doc, url) => {
    const from = tabmail.tabInfo.find((tab) => tab.browser?.contentDocument === doc);
    return openWeb(window, url, { newTab: true, session: from ? sessionOfTab(from)?.id : null });
  };
  // A tab restored before about:logins was registered shows an error page: load it again.
  for (const info of webTabs(window)) {
    if (info.browser?.currentURI?.spec === ABOUT_LOGINS && !info.browser.contentDocument?.getElementById("rows")) loadInTab(info, ABOUT_LOGINS);
  }
  renderWebChrome(window);

  return () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("TabAttrModified", onTabAttr);
    delete window.mwOpenWebFrom;
    tabmail.unregisterTabMonitor(monitor);
    closeWebMenu(window);
    document.getElementById(WEB_MENU)?.remove();
    for (const info of tabmail.tabInfo ?? []) info.mwWebUndo?.();
    if (window.mwWebQueued) window.cancelAnimationFrame(window.mwWebQueued);
    delete window.mwWebQueued;
    delete window.mwLastWebTab;
    delete window.mwBeforeWebTab;
    delete window.mwLastWebTabs;
    delete window.mwClosedWebTabs;
    button.remove();
  };
}
