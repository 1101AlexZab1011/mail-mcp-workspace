/* Mail Workspace Browser, the session's menu (☰ at the end of the toolbar, like Firefox's app menu) and
   what it opens: the session's history, downloads, saved passwords, page tools and session settings.
   Loaded into the Experiment's scope after web.js and webhistory.js.

   History is per session, recorded here (top-level pages: address, title, time), one entry per address,
   capped (webhistory.js), and kept in a file per session in the profile, removed with the session.
   Downloads go to the Downloads folder without asking, as in Firefox. Passwords are Thunderbird's, shared
   by all sessions (saved logins are per site, not per container); after a login the tab offers to save
   it. The agent never sees a password: the offer, the password manager and anything that wipes data are
   the user's alone (data-user-only, and agent input is ignored). */
/* global Services, ChromeUtils, Cc, Ci, IOUtils, PathUtils, ExtensionParent, keyHint, isMac, MW_XHTML, isWebTab, webTabs, sessionOfTab, readSessions,
   currentSession, openWeb, openTabIn, webTabs, ABOUT_LOGINS, showBrowser, createSession, renameSession, deleteSession, webSessionName, agentActing,
   webIcon, renderWebChrome, isRecordable, addHistoryVisit, setHistoryTitle, searchHistory, parseHistory */

var WEB_MENU = "mw-web-menu";
// The Experiment's scope has no window timers of its own.
var { setTimeout: historyTimeout, clearTimeout: clearHistoryTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
var WEB_PREPARED_PREF = "extensions.mailworkspace.webPrepared";

/** Once: downloads save to the Downloads folder without asking (Thunderbird's "always ask" opens no picker
    from a web tab), and the password manager saves and fills web logins. */
function prepareWebPrefs() {
  if (Services.prefs.getBoolPref(WEB_PREPARED_PREF, false)) return;
  Services.prefs.setBoolPref("browser.download.useDownloadDir", true);
  Services.prefs.setIntPref("browser.download.folderList", 1);
  Services.prefs.setBoolPref("signon.rememberSignons", true);
  Services.prefs.setBoolPref("signon.autofillForms", true);
  Services.prefs.setBoolPref(WEB_PREPARED_PREF, true);
}

// --------------------------------------------------------------- history --

var webHistory = new Map(); // session id → its list, once read
var webHistorySaves = new Map(); // session id → pending save timer

function historyFile(id) {
  return PathUtils.join(PathUtils.profileDir, "mail-workspace", "web-history", `${id}.json`);
}

async function sessionHistory(id) {
  if (!webHistory.has(id)) {
    let list = [];
    try { list = parseHistory(await IOUtils.readJSON(historyFile(id))); } catch { /* none yet */ }
    if (!webHistory.has(id)) webHistory.set(id, list);
  }
  return webHistory.get(id);
}

function saveHistorySoon(id) {
  clearHistoryTimeout(webHistorySaves.get(id));
  webHistorySaves.set(id, historyTimeout(async () => {
    webHistorySaves.delete(id);
    const file = historyFile(id);
    try {
      await IOUtils.makeDirectory(PathUtils.parent(file), { createAncestors: true, ignoreExisting: true });
      await IOUtils.writeJSON(file, webHistory.get(id) ?? [], { tmpPath: `${file}.tmp` });
    } catch (error) { console.warn("Mail Workspace: could not save the Browser history", error); }
  }, 1500));
}

var webHistoryQueue = new Map(); // session id → the last change, so changes apply in order

/** Change a session's history after the changes before it (the first one reads the file). */
function changeHistory(id, change) {
  const next = (webHistoryQueue.get(id) ?? Promise.resolve()).then(async () => {
    const list = await sessionHistory(id);
    const changed = change(list);
    if (changed !== list) { webHistory.set(id, changed); saveHistorySoon(id); }
  }).catch((error) => console.warn("Mail Workspace: Browser history", error));
  webHistoryQueue.set(id, next);
  return next;
}

/** A top-level page a web tab arrived at. Its title is the document's (none yet while it loads). */
function recordVisit(info) {
  const url = info.browser?.currentURI?.spec;
  const session = sessionOfTab(info);
  if (!session || !isRecordable(url)) return Promise.resolve();
  const title = info.browser.contentTitle || "";
  return changeHistory(session.id, (list) => addHistoryVisit(list, { url, title, time: Date.now() }));
}

function recordTitle(info) {
  const url = info.browser?.currentURI?.spec;
  const title = info.browser?.contentTitle;
  const session = sessionOfTab(info);
  if (!session || !isRecordable(url) || !title) return Promise.resolve();
  return changeHistory(session.id, (list) => setHistoryTitle(list, url, title));
}

async function clearSessionHistory(id) {
  await changeHistory(id, () => []);
  clearHistoryTimeout(webHistorySaves.get(id));
  webHistorySaves.delete(id);
  await IOUtils.remove(historyFile(id), { ignoreAbsent: true }).catch(() => {});
}

/** With its session: the list and its file go. */
function dropSessionHistory(id) {
  void clearSessionHistory(id).then(() => { webHistory.delete(id); webHistoryQueue.delete(id); });
}

// ------------------------------------------------------------ site icons --
// The icon each site showed last, by host, for about:logins' list (logins/logins.js reads the file).

var SITE_ICONS_LIMIT = 1000;
var siteIcons = null; // host → icon URL, oldest first, once read
var siteIconsSave = 0;

function siteIconsFile() {
  return PathUtils.join(PathUtils.profileDir, "mail-workspace", "site-icons.json");
}

async function noteSiteIcon(info) {
  const icon = info.favIconUrl;
  let host;
  try { host = new URL(info.browser?.currentURI?.spec).hostname; } catch { return; }
  if (!host || !/^(https?|data):/.test(icon ?? "") || !/^https?:/.test(info.browser.currentURI.spec)) return;
  if (!siteIcons) {
    let read = {};
    try { read = await IOUtils.readJSON(siteIconsFile()); } catch { /* none yet */ }
    siteIcons ??= new Map(Object.entries(read));
  }
  if (siteIcons.get(host) === icon) return;
  siteIcons.delete(host);
  siteIcons.set(host, icon);
  for (const old of siteIcons.keys()) { if (siteIcons.size <= SITE_ICONS_LIMIT) break; siteIcons.delete(old); }
  clearHistoryTimeout(siteIconsSave);
  siteIconsSave = historyTimeout(async () => {
    const file = siteIconsFile();
    try {
      await IOUtils.makeDirectory(PathUtils.parent(file), { createAncestors: true, ignoreExisting: true });
      await IOUtils.writeJSON(file, Object.fromEntries(siteIcons), { tmpPath: `${file}.tmp` });
    } catch (error) { console.warn("Mail Workspace: could not save the site icons", error); }
  }, 3000);
}

// ------------------------------------------------------------- downloads --

function downloadsApi() {
  return ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs").Downloads;
}

/**
 * Where a finished download is now: its target, or, when something moved it (the user's Downloads sorter
 * files downloads into subfolders such as archives/ and documents/), the newest file of that name, or of
 * that name with a " (1)"-style number, in a subfolder of the Downloads folder.
 */
async function locateDownload(path) {
  if (await IOUtils.exists(path)) return path;
  const folder = PathUtils.parent(path);
  const name = PathUtils.filename(path);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const same = new RegExp(`^${escape(stem)}(\\s?\\(\\d+\\))?${escape(ext)}$`);
  let best = null;
  for (const dir of await IOUtils.getChildren(folder).catch(() => [])) {
    for (const file of await IOUtils.getChildren(dir).catch(() => [])) {
      if (!same.test(PathUtils.filename(file))) continue;
      const info = await IOUtils.stat(file).catch(() => null);
      if (info?.type === "regular" && (!best || info.lastModified > best.time)) best = { path: file, time: info.lastModified };
    }
  }
  return best?.path ?? null;
}

function describeDownload(download, where = download.target.path) {
  return {
    name: PathUtils.filename(where ?? download.target.path),
    path: where,
    ...(where !== download.target.path ? { savedAs: download.target.path } : {}),
    url: download.source.url,
    size: download.target.size ?? download.totalBytes ?? null,
    done: download.succeeded,
    failed: Boolean(download.error),
    running: !download.stopped,
    progress: download.progress,
    started: download.startTime ? new Date(download.startTime).toISOString() : null,
  };
}

/** The newest downloads first. */
async function recentDownloads(limit = 30) {
  const list = await downloadsApi().getList(downloadsApi().ALL);
  return (await list.getAll()).slice(-limit).reverse();
}

async function webDownloads() {
  const downloads = [];
  for (const download of await recentDownloads()) downloads.push(describeDownload(download, download.succeeded ? await locateDownload(download.target.path) : download.target.path));
  return { folder: await downloadsApi().getPreferredDownloadsDirectory(), downloads };
}

/** Open a finished download, or show it in its folder, wherever it is now. */
async function openDownload(download, { reveal = false } = {}) {
  const path = await locateDownload(download.target.path);
  if (!path) return;
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  try { if (reveal) file.reveal(); else file.launch(); }
  catch { if (reveal) { const dir = file.parent; dir.launch(); } }
}

/** Save Page As: the page (HTML) into the Downloads folder, fetched with the session's cookies. */
async function savePage(window, info) {
  const uri = info.browser?.currentURI;
  if (!uri || !(uri.schemeIs("http") || uri.schemeIs("https") || uri.schemeIs("file"))) throw new Error("This page cannot be saved");
  const { DownloadPaths } = ChromeUtils.importESModule("resource://gre/modules/DownloadPaths.sys.mjs");
  const Downloads = downloadsApi();
  const folder = await Downloads.getPreferredDownloadsDirectory();
  await IOUtils.makeDirectory(folder, { createAncestors: true, ignoreExisting: true });
  const base = DownloadPaths.sanitize((info.title && info.title !== uri.spec ? info.title : uri.host) || "page") || "page";
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(PathUtils.join(folder, `${base.slice(0, 120)}.html`));
  const target = DownloadPaths.createNiceUniqueFile(file);
  const userContextId = sessionOfTab(info)?.userContextId ?? 0;
  const download = await Downloads.createDownload({
    source: { url: uri.spec, userContextId, loadingPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId }) },
    target: target.path,
  });
  (await Downloads.getList(Downloads.ALL)).add(download);
  void download.start().catch((error) => console.warn("Mail Workspace: Save Page failed", error));
  return { saving: target.path };
}

// ------------------------------------------------------------- passwords --

/** The saved passwords (shared by every session) in a tab of the session, as Firefox opens about:logins:
    the session's own about:logins tab if it has one, else a new one. */
function openLogins(window, info) {
  const session = sessionOfTab(info) ?? currentSession(window);
  const open = session && webTabs(window, session).find((tab) => tab.browser?.currentURI?.spec === ABOUT_LOGINS);
  if (open) window.gTabmail.switchToTab(open);
  else if (session) openTabIn(window, session, ABOUT_LOGINS);
  renderWebChrome(window);
}

/**
 * After a login form in a web tab was sent (web/logins.js, through the background): offer to save or update
 * the password in the tab's toolbar. The password stays in this closure until the user answers.
 */
async function offerLogin(window, tabId, { origin, formActionOrigin, username, password }) {
  let info;
  try { info = ExtensionParent.apiManager.global.tabTracker.getTab(tabId); } catch { return { ignored: "no such tab" }; }
  if (!isWebTab(info) || !password || !/^https?:\/\//.test(origin ?? "")) return { ignored: "not a web tab" };
  if (!Services.logins.getLoginSavingEnabled(origin)) return { ignored: "never for this site" };
  const saved = await Services.logins.searchLoginsAsync({ origin });
  const same = saved.find((login) => login.username === (username ?? ""));
  if (same?.password === password) return { ignored: "already saved" };
  const document = window.document;
  const toolbox = info.toolbar?.parentNode;
  if (!toolbox) return { ignored: "no toolbar" };
  toolbox.querySelector(".mw-web-login")?.remove();
  const html = (tag, className, text) => { const el = document.createElementNS(MW_XHTML, tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const bar = html("div", "mw-web-login");
  bar.setAttribute("data-user-only", "");
  bar.setAttribute("role", "alert");
  const host = Services.io.newURI(origin).host;
  const who = username ? `for ${username} ` : "";
  const text = html("span", "mw-web-login-text", same ? `Update the saved password ${who}on ${host}?` : `Save the password ${who}on ${host}?`);
  const button = (label, primary, run) => {
    const el = html("button", `mw-web-login-btn${primary ? " primary" : ""}`, label);
    el.type = "button";
    el.addEventListener("click", async () => {
      if (agentActing(window)) return; // the user's answer, never the agent's
      try { await run(); } catch (error) { console.warn("Mail Workspace: saving the login failed", error); }
      bar.remove();
    });
    return el;
  };
  const save = button(same ? "Update" : "Save", true, async () => {
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init(origin, formActionOrigin || origin, null, username ?? "", password, "", "");
    if (same) await Services.logins.modifyLoginAsync(same, login);
    else await Services.logins.addLoginAsync(login);
  });
  const never = button("Never for this site", false, () => Services.logins.setLoginSavingEnabled(origin, false));
  const later = button("Not now", false, () => {});
  bar.append(webIcon(document, "key"), text, save, never, later);
  toolbox.append(bar);
  return { offered: true };
}

// ------------------------------------------------------------------ menu --

function closeWebMenu(window) {
  const panel = window.document.getElementById(WEB_MENU);
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  panel.mwUndo?.();
  window.document.querySelector(".mw-web-menu-btn[aria-expanded=true]")?.setAttribute("aria-expanded", "false");
}

/** The ☰ menu of the web tab `info`, open at `view` (main, sessions, history, all-history, downloads, settings). */
function openWebMenu(window, info, view = "main") {
  const document = window.document;
  const anchor = info.toolbar?.querySelector(".mw-web-menu-btn");
  let panel = document.getElementById(WEB_MENU);
  if (!panel) {
    panel = document.createElementNS(MW_XHTML, "div");
    panel.id = WEB_MENU;
    panel.className = "mw-web-menu";
    panel.setAttribute("role", "menu");
    panel.hidden = true;
    (document.body ?? document.documentElement).append(panel);
  }
  panel.mwUndo?.();
  const html = (tag, className, text) => { const el = document.createElementNS(MW_XHTML, tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const session = sessionOfTab(info) ?? currentSession(window);
  const go = (next) => () => openWebMenu(window, info, next);
  const done = (run) => () => { closeWebMenu(window); run(); };

  /** A menu row: icon, label, shortcut or ▸; `userOnly` rows ignore the agent. */
  function item(label, { icon, key, submenu, run, userOnly, danger } = {}) {
    const row = html("button", "mw-web-menu-item");
    row.type = "button";
    row.setAttribute("role", "menuitem");
    if (danger) row.classList.add("danger");
    if (userOnly) row.setAttribute("data-user-only", "");
    const img = icon ? webIcon(document, icon) : html("span", "mw-web-menu-noicon");
    row.append(img, html("span", "mw-web-menu-label", label));
    if (key) row.append(html("span", "mw-web-menu-key", keyHint(key)));
    if (submenu) row.append(webIcon(document, "chevron_right"));
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      if (userOnly && agentActing(window)) return;
      run?.();
    });
    return row;
  }
  const separator = () => html("div", "mw-web-menu-sep");
  const header = (title, back = "main") => {
    const row = html("div", "mw-web-menu-header");
    const button = html("button", "mw-web-menu-back");
    button.type = "button";
    button.title = "Back";
    button.append(webIcon(document, "arrow_back"));
    button.addEventListener("click", (event) => { event.stopPropagation(); openWebMenu(window, info, back); });
    row.append(button, html("span", "mw-web-menu-title", title));
    return row;
  };
  /** An inline "are you sure" in place of `row`. */
  function confirmIn(row, question, label, run) {
    const box = html("div", "mw-web-menu-confirm");
    box.setAttribute("data-user-only", "");
    const yes = html("button", "mw-web-menu-yes", label);
    const no = html("button", "mw-web-menu-no", "Cancel");
    for (const el of [yes, no]) el.type = "button";
    yes.addEventListener("click", async (event) => { event.stopPropagation(); if (agentActing(window)) return; await run(); });
    no.addEventListener("click", (event) => { event.stopPropagation(); openWebMenu(window, info, view); });
    box.append(html("span", "mw-web-menu-question", question), yes, no);
    row.replaceWith(box);
    no.focus();
  }
  const zoomRow = () => {
    const row = html("div", "mw-web-menu-zoom");
    const value = html("span", "mw-web-menu-zoom-value", `${Math.round(window.ZoomManager.getZoomForBrowser(info.browser) * 100)}%`);
    const zoom = () => html("button", "mw-web-menu-zoom-btn");
    const minus = zoom(); minus.title = keyHint("Zoom out (Ctrl+−)"); minus.append(webIcon(document, "remove"));
    const plus = zoom(); plus.title = keyHint("Zoom in (Ctrl+=)"); plus.append(webIcon(document, "add"));
    value.title = keyHint("Reset (Ctrl+0)");
    const update = () => { value.textContent = `${Math.round(window.ZoomManager.getZoomForBrowser(info.browser) * 100)}%`; };
    minus.addEventListener("click", (e) => { e.stopPropagation(); window.ZoomManager.reduce(info.browser); update(); });
    plus.addEventListener("click", (e) => { e.stopPropagation(); window.ZoomManager.enlarge(info.browser); update(); });
    value.addEventListener("click", (e) => { e.stopPropagation(); window.ZoomManager.reset(info.browser); update(); });
    for (const el of [minus, plus]) el.type = "button";
    row.append(html("span", "mw-web-menu-noicon"), html("span", "mw-web-menu-label", "Zoom"), minus, value, plus);
    return row;
  };

  const views = {
    main: () => {
      const name = item(session?.name ?? "No session", { icon: "public", submenu: true, run: go("sessions") });
      name.classList.add("mw-web-menu-session");
      return [
        name, separator(),
        item("New tab", { icon: "tab", key: "Ctrl+T", run: done(() => void openWeb(window, "", { newTab: true, session: session?.id })) }),
        item("History", { icon: "history", key: isMac() ? "⌘Y" : "Ctrl+H", submenu: true, run: go("history") }),
        item("Downloads", { icon: "download", key: isMac() ? "⇧⌘J" : "Ctrl+Shift+Y", submenu: true, run: go("downloads") }),
        item("Passwords", { icon: "key", userOnly: true, run: done(() => openLogins(window, info)) }),
        separator(),
        item("Print…", { icon: "print", key: "Ctrl+P", run: done(() => window.PrintUtils?.startPrintWindow(info.browser.browsingContext)) }),
        item("Save page as…", { icon: "save", key: "Ctrl+S", run: done(() => void savePage(window, info).then(() => openWebMenu(window, info, "downloads"), (error) => console.warn(error))) }),
        item("Find in page…", { icon: "search", key: "Ctrl+F", run: done(() => info.findbar?.onFindCommand()) }),
        zoomRow(),
        separator(),
        item("Session settings", { icon: "settings", submenu: true, run: go("settings") }),
      ];
    },
    sessions: () => {
      const state = readSessions();
      const rows = [header(session?.name ?? "Sessions")];
      for (const other of state.sessions.filter((s) => s.id !== session?.id)) {
        rows.push(item(other.name, { icon: "public", key: tabCount(webTabs(window, other).length), run: done(() => void showBrowser(window, other.id)) }));
      }
      if (rows.length > 1) rows.push(separator());
      rows.push(item("New session", { icon: "add", run: done(async () => {
        const created = createSession(webSessionName(readSessions().sessions));
        await openWeb(window, "", { newTab: true, session: created.id });
        window.mwOpenToolGroup?.("web");
      }) }));
      if (session) {
        const rename = item("Rename…", { icon: "drive_file_rename", run: () => {
          const input = html("input", "mw-web-menu-input");
          input.value = session.name;
          input.setAttribute("aria-label", "Session name");
          rename.replaceWith(input);
          input.focus();
          input.select();
          input.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              try { renameSession(session.id, input.value); renderWebChrome(window); } catch (error) { console.warn("Mail Workspace:", error.message); }
              openWebMenu(window, info, "sessions");
            } else if (event.key === "Escape") openWebMenu(window, info, "sessions");
          });
        } });
        rows.push(rename);
        const remove = item("Delete session…", { icon: "delete", userOnly: true, danger: true, run: () => confirmIn(remove, `Delete “${session.name}” with its tabs, logins and history?`, "Delete", () => {
          closeWebMenu(window);
          deleteSession(window, session.id);
          renderWebChrome(window);
        }) });
        rows.push(remove);
      }
      return rows;
    },
    history: async () => {
      const list = session ? await sessionHistory(session.id) : [];
      const rows = [header("History")];
      if (!list.length) rows.push(html("div", "mw-web-menu-empty", "No pages yet in this session"));
      for (const entry of list.slice(0, 15)) rows.push(historyRow(entry));
      rows.push(separator());
      rows.push(item("Show all history", { icon: "history", key: "", run: go("all-history") }));
      const clear = item("Clear this session’s history", { icon: "delete_sweep", userOnly: true, run: () => confirmIn(clear, "Clear the history of this session?", "Clear", async () => {
        await clearSessionHistory(session.id);
        openWebMenu(window, info, "history");
      }) });
      if (session && list.length) rows.push(clear);
      return rows;
    },
    "all-history": async () => {
      const list = session ? await sessionHistory(session.id) : [];
      const search = html("input", "mw-web-menu-input mw-web-menu-search");
      search.placeholder = `Search ${list.length} ${list.length === 1 ? "page" : "pages"}`;
      search.setAttribute("aria-label", "Search history");
      const results = html("div", "mw-web-menu-scroll");
      const show = () => results.replaceChildren(...searchHistory(list, search.value, 300).map(historyRow));
      search.addEventListener("input", show);
      search.addEventListener("keydown", (event) => { if (event.key !== "Escape") event.stopPropagation(); });
      show();
      window.setTimeout(() => search.focus(), 0);
      return [header("All history", "history"), search, results];
    },
    downloads: async () => {
      const rows = [header("Downloads")];
      const list = await recentDownloads(15);
      if (!list.length) rows.push(html("div", "mw-web-menu-empty", "No downloads yet"));
      for (const download of list) {
        const d = describeDownload(download);
        const row = html("div", "mw-web-menu-download");
        const status = d.running ? `${Math.round(d.progress ?? 0)}%` : d.failed ? "Failed" : d.size ? formatSize(d.size) : "";
        const text = html("div", "mw-web-menu-download-text");
        text.append(html("span", "mw-web-menu-label", d.name), html("span", "mw-web-menu-sub", [status, hostOf(d.url)].filter(Boolean).join(" · ")));
        const open = html("button", "mw-web-menu-zoom-btn");
        open.type = "button";
        open.title = "Open";
        open.append(webIcon(document, "open_in_new"));
        open.disabled = !d.done;
        open.addEventListener("click", (e) => { e.stopPropagation(); closeWebMenu(window); void openDownload(download); });
        const folder = html("button", "mw-web-menu-zoom-btn");
        folder.type = "button";
        folder.title = "Show in folder";
        folder.append(webIcon(document, "folder_open"));
        folder.addEventListener("click", (e) => { e.stopPropagation(); closeWebMenu(window); void openDownload(download, { reveal: true }); });
        row.append(webIcon(document, "download"), text, open, folder);
        rows.push(row);
      }
      rows.push(separator());
      rows.push(item("Open the Downloads folder", { icon: "folder_open", run: done(async () => {
        const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        dir.initWithPath(await downloadsApi().getPreferredDownloadsDirectory());
        try { dir.launch(); } catch { /* no file manager */ }
      }) }));
      return rows;
    },
    settings: () => {
      const rows = [header("Session settings")];
      const clear = item("Clear cookies and site data of this session…", { icon: "cookie", userOnly: true, danger: true, run: () => confirmIn(clear, `Sign out of every site in “${session?.name}” and clear its cookies and storage? Saved passwords stay.`, "Clear", () => {
        closeWebMenu(window);
        Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId: session.userContextId });
      }) });
      if (session) rows.push(clear);
      return rows;
    },
  };

  function historyRow(entry) {
    const row = item(entry.title || entry.url, { icon: "public", run: done(() => void openWeb(window, entry.url, { newTab: true, session: session?.id })) });
    row.title = entry.url;
    row.append(html("span", "mw-web-menu-sub", hostOf(entry.url)));
    return row;
  }

  void Promise.resolve(views[view]?.() ?? views.main()).then((rows) => {
    panel.replaceChildren(...rows);
    panel.dataset.view = view;
    panel.hidden = false;
    anchor?.setAttribute("aria-expanded", "true");
    const box = (anchor ?? info.toolbar).getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    panel.style.left = `${Math.round(Math.max(6, Math.min(box.right - width, window.innerWidth - width - 6)))}px`;
    panel.style.top = `${Math.round(Math.max(6, Math.min(box.bottom + 4, window.innerHeight - height - 6)))}px`;
    if (!panel.contains(document.activeElement)) panel.querySelector("button:not([disabled])")?.focus();
  });

  // Closes on a click outside, Escape (or back from a subview), the window losing focus or the tab changing.
  const onDown = (event) => { if (!panel.contains(event.target) && event.target !== anchor && !anchor?.contains(event.target)) closeWebMenu(window); };
  const onKey = (event) => {
    if (panel.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (view === "main") closeWebMenu(window); else openWebMenu(window, info, view === "all-history" ? "history" : "main"); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (event.target.localName === "input") return;
      const items = [...panel.querySelectorAll("button:not([disabled])")];
      const at = items.indexOf(document.activeElement);
      event.preventDefault();
      event.stopPropagation();
      items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  const onBlur = () => closeWebMenu(window);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  panel.mwUndo = () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    delete panel.mwUndo;
  };
}

const tabCount = (n) => `${n} ${n === 1 ? "tab" : "tabs"}`;

function hostOf(url) {
  try { return new URL(url).host || url; } catch { return url ?? ""; }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
