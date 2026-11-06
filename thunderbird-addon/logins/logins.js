/* about:logins: the Browser's saved passwords (Thunderbird's password manager, shared by every session), as
   Firefox shows them: a searchable list, the selected login with Edit and Remove, Copy and show-password,
   adding a login, and import, export and remove-all in the ⋯ menu. Web logins only: Thunderbird's own
   (mail accounts) stay in Settings.

   The page is the user's alone. It is data-user-only (the agent's snapshot skips it and its actions are
   refused), it ignores any input that arrives while the agent is sending some, and a password shown here
   is hidden again before the agent takes a screenshot (window.mwHideSecrets). */
/* global Services, ChromeUtils, Cc, Ci, IOUtils, PathUtils, isWebLogin, siteIconFor, loginTitle, filterLogins, sortLogins, LOGIN_SORTS, loginOrigin */

const { LoginHelper } = ChromeUtils.importESModule("resource://gre/modules/LoginHelper.sys.mjs");
const $ = (id) => document.getElementById(id);
const ICONS = "resource://mailworkspace/icons";
const SORT_PREF = "extensions.mailworkspace.loginsSort";
const APPEARANCE_PREF = "extensions.mailworkspace.appearance";
const MASK = "••••••••";

let logins = [];        // the web logins, as the store has them
let icons = {};         // host → icon URL (the Browser keeps them, experiments/workspace/webmenu.js)
let shown = [];         // filtered and sorted, as listed
let selected = null;    // guid
let editing = null;     // null, "new" or the guid being edited
let revealed = false;

// ------------------------------------------------------- the agent stays out --

const chromeWindow = window.browsingContext.topChromeWindow;
const agentActing = () => Date.now() < (chromeWindow?.mwAgentInputUntil ?? 0);
for (const type of ["mousedown", "click", "dblclick", "keydown", "keypress", "beforeinput", "paste", "submit"]) {
  window.addEventListener(type, (event) => {
    if (!agentActing()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

/** Before anything else can see the page: no password is left showing. */
window.mwHideSecrets = () => {
  setRevealed(false);
  const input = $("edit-password");
  input.type = "password";
  setEye($("edit-reveal"), false);
};

// ------------------------------------------------------------- appearance --

function markAppearance() {
  const mode = Services.prefs.getStringPref(APPEARANCE_PREF, "system");
  if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
  else document.documentElement.removeAttribute("data-theme");
}

// ------------------------------------------------------------------ data --

async function load() {
  try { icons = await IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, "mail-workspace", "site-icons.json")); } catch { icons = {}; }
  logins = (await Services.logins.getAllLogins()).filter(isWebLogin);
  render();
}

const byGuid = (guid) => logins.find((login) => login.guid === guid) ?? null;

function favicon(img, login) {
  img.onerror = () => { img.onerror = null; img.src = `${ICONS}/public.svg`; };
  img.src = (login && siteIconFor(icons, login.origin)) || `${ICONS}/public.svg`;
}

function formatDate(time) {
  return time ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(time)) : "";
}

// ---------------------------------------------------------------- render --

function render() {
  shown = sortLogins(filterLogins(logins, $("search").value), $("sort").value);
  if (!editing && !byGuid(selected)) selected = shown[0]?.guid ?? null;
  renderList();
  renderDetail();
}

function renderList() {
  const total = logins.length;
  const filtering = $("search").value.trim() !== "";
  $("count").textContent = filtering ? `${shown.length} of ${total} passwords` : `${total} ${total === 1 ? "password" : "passwords"}`;
  const rows = shown.map((login) => {
    const row = document.createElement("li");
    row.className = "row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(login.guid === selected && editing !== "new"));
    row.dataset.guid = login.guid;
    const img = document.createElement("img");
    img.className = "favicon";
    img.alt = "";
    favicon(img, login);
    const text = document.createElement("div");
    text.className = "row-text";
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = loginTitle(login);
    const user = document.createElement("span");
    user.className = "row-user";
    user.textContent = login.username || "(no username)";
    text.append(title, user);
    row.append(img, text);
    row.addEventListener("click", () => select(login.guid));
    return row;
  });
  if (!rows.length) {
    const none = document.createElement("li");
    none.className = "none";
    none.textContent = filtering ? "No passwords found" : "No saved passwords";
    rows.push(none);
  }
  $("rows").replaceChildren(...rows);
  $("rows").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function renderDetail() {
  const login = byGuid(selected);
  $("view").hidden = Boolean(editing) || !login;
  $("editor").hidden = !editing;
  $("empty").hidden = Boolean(editing) || Boolean(login);
  $("empty-text").textContent = logins.length
    ? "Select a password on the left to see it."
    : "Passwords you save in the Browser show up here, for every session. Add one with +, or import a file from the ⋯ menu.";
  if (!editing && login) {
    favicon($("view-icon"), login);
    $("view-title").textContent = loginTitle(login);
    $("view-origin").textContent = login.origin;
    $("view-origin").title = `Open ${login.origin} in a new tab`;
    const user = $("view-username");
    user.textContent = login.username || "(no username)";
    user.classList.toggle("muted", !login.username);
    $("copy-username").hidden = !login.username;
    setRevealed(revealed);
    renderTimeline(login);
  }
}

function renderTimeline(login) {
  const meta = login.QueryInterface(Ci.nsILoginMetaInfo);
  const points = [["Created", meta.timeCreated]];
  if (meta.timePasswordChanged && meta.timePasswordChanged !== meta.timeCreated) points.push(["Modified", meta.timePasswordChanged]);
  if (meta.timeLastUsed && meta.timeLastUsed !== meta.timeCreated) points.push(["Used", meta.timeLastUsed]);
  $("timeline").replaceChildren(...points.map(([what, time]) => {
    const point = document.createElement("li");
    const date = document.createElement("span");
    date.textContent = formatDate(time);
    const label = document.createElement("span");
    label.textContent = what;
    point.append(date, label);
    return point;
  }));
}

function setEye(button, on) {
  button.setAttribute("aria-pressed", String(on));
  button.title = on ? "Hide password" : "Show password";
  button.setAttribute("aria-label", button.title);
  button.querySelector("img").src = `${ICONS}/${on ? "visibility_off" : "visibility"}.svg`;
}

function setRevealed(on) {
  revealed = on;
  const login = byGuid(selected);
  $("view-password").textContent = on && login ? login.password : MASK;
  setEye($("reveal"), on);
}

function select(guid) {
  if (editing) return; // the editor's Cancel or Save first
  selected = guid;
  revealed = false;
  renderList();
  renderDetail();
}

// ---------------------------------------------------------------- notice --

let noticeTimer = 0;
function notify(text, { bad = false } = {}) {
  const notice = $("notice");
  notice.textContent = text;
  notice.classList.toggle("bad", bad);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 8000);
}

function confirmAction({ title, text, ok }) {
  const dialog = $("confirm");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = ok;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}

// ------------------------------------------------------------ copy, open --

function copy(text, button) {
  const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
  // Marked sensitive, so clipboard managers that honour it keep no history of it.
  try { helper.copyString(text, null, Ci.nsIClipboardHelper.Sensitive); } catch { helper.copyString(text); }
  button.textContent = "Copied!";
  button.classList.add("copied");
  setTimeout(() => { button.textContent = "Copy"; button.classList.remove("copied"); }, 3000);
}

function openSite(url) {
  // In a new tab of this tab's session (web.js puts the opener on the window).
  if (chromeWindow?.mwOpenWebFrom) chromeWindow.mwOpenWebFrom(document, url);
  else window.open(url);
}

// ---------------------------------------------------------------- editor --

function startEditing(guid) {
  const login = guid === "new" ? null : byGuid(guid);
  editing = guid;
  revealed = false;
  favicon($("editor-icon"), login);
  $("editor-title").textContent = login ? loginTitle(login) : "Add password";
  $("edit-origin").value = login?.origin ?? "";
  $("edit-origin").readOnly = Boolean(login);
  $("edit-username").value = login?.username ?? "";
  $("edit-password").value = login?.password ?? "";
  $("edit-password").type = "password";
  setEye($("edit-reveal"), false);
  $("editor-error").hidden = true;
  renderList();
  renderDetail();
  (login ? $("edit-username") : $("edit-origin")).focus();
}

function stopEditing() {
  editing = null;
  $("edit-password").value = "";
  render();
}

function showEditorError(text, existing = null) {
  const error = $("editor-error");
  error.replaceChildren(text);
  if (existing) {
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "Go to the saved one";
    link.addEventListener("click", (event) => { event.preventDefault(); stopEditing(); select(existing.guid); });
    error.append(" ", link);
  }
  error.hidden = false;
}

async function save() {
  const old = editing === "new" ? null : byGuid(editing);
  const origin = old?.origin ?? loginOrigin($("edit-origin").value);
  const username = $("edit-username").value;
  const password = $("edit-password").value;
  if (!origin) return showEditorError("Enter a web address, such as https://www.example.com.");
  if (!password) return showEditorError("A password can’t be empty.");
  const same = (await Services.logins.searchLoginsAsync({ origin })).find((login) => login.username === username && login.guid !== old?.guid);
  if (same) return showEditorError(`A password for ${username || "(no username)"} on ${loginTitle({ origin })} is already saved.`, same);
  try {
    if (old) {
      await Services.logins.modifyLoginAsync(old, LoginHelper.newPropertyBag({ username, password }));
      selected = old.guid;
    } else {
      const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
      login.init(origin, origin, null, username, password, "", "");
      selected = (await Services.logins.addLoginAsync(login)).guid;
    }
  } catch (error) {
    return showEditorError(`Could not save: ${error.message ?? error}`);
  }
  editing = null;
  $("edit-password").value = "";
  await load();
}

// ------------------------------------------------------------- ⋯ the menu --

function setMenu(open) {
  $("menu").hidden = !open;
  $("more").setAttribute("aria-expanded", String(open));
  if (open) $("menu").querySelector("button")?.focus();
}

function pickFile(title, mode, { name } = {}) {
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  picker.init(window.browsingContext, title, mode);
  picker.appendFilter("CSV", "*.csv");
  picker.appendFilters(Ci.nsIFilePicker.filterAll);
  if (name) picker.defaultString = name;
  return new Promise((resolve) => picker.open((result) => resolve(result === Ci.nsIFilePicker.returnCancel ? null : picker.file.path)));
}

const menuActions = {
  async import() {
    const path = await pickFile("Import passwords from a file", Ci.nsIFilePicker.modeOpen);
    if (!path) return;
    const { LoginCSVImport } = ChromeUtils.importESModule("resource://gre/modules/LoginCSVImport.sys.mjs");
    try {
      const summary = await LoginCSVImport.importFromCSV(path);
      const count = (result) => summary.filter((entry) => entry.result === result).length;
      const errors = summary.filter((entry) => String(entry.result).startsWith("error")).length;
      notify(`Imported: ${count("added")} new, ${count("modified")} updated, ${count("no_change")} already saved${errors ? `, ${errors} could not be read` : ""}.`, { bad: errors > 0 && !count("added") });
    } catch (error) {
      notify(`Could not import that file: ${error.message ?? error}`, { bad: true });
    }
    await load();
  },
  async export() {
    const ok = await confirmAction({
      title: "Export passwords?",
      text: "Your passwords will be saved as readable text in a CSV file. Anyone who can open that file can read them.",
      ok: "Export…",
    });
    if (!ok) return;
    const path = await pickFile("Export passwords to a file", Ci.nsIFilePicker.modeSave, { name: "logins.csv" });
    if (!path) return;
    const { LoginExport } = ChromeUtils.importESModule("resource://gre/modules/LoginExport.sys.mjs");
    await LoginExport.exportAsCSV(path, logins);
    notify(`Exported ${logins.length} passwords to ${path}.`);
  },
  async "remove-all"() {
    if (!logins.length) return;
    const ok = await confirmAction({
      title: `Remove all ${logins.length} passwords?`,
      text: "This removes every password saved for websites, in every Browser session. Your mail account passwords stay. This cannot be undone.",
      ok: "Remove all",
    });
    if (!ok) return;
    for (const login of logins) await Services.logins.removeLoginAsync(login);
    selected = null;
    await load();
  },
};

// ------------------------------------------------------------------ wire --

function wire() {
  for (const [value, label] of Object.entries(LOGIN_SORTS)) $("sort").append(new Option(label, value));
  $("sort").value = Services.prefs.getStringPref(SORT_PREF, "name") in LOGIN_SORTS ? Services.prefs.getStringPref(SORT_PREF, "name") : "name";
  $("sort").addEventListener("change", () => { Services.prefs.setStringPref(SORT_PREF, $("sort").value); render(); });
  $("search").addEventListener("input", () => { if (!editing) selected = null; render(); });
  $("search").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("search").value) { $("search").value = ""; render(); }
    if (event.key === "ArrowDown") { event.preventDefault(); $("rows").focus(); }
  });
  $("rows").addEventListener("keydown", (event) => {
    const at = shown.findIndex((login) => login.guid === selected);
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[event.key];
    if (step) { event.preventDefault(); const next = shown[Math.max(0, Math.min(shown.length - 1, at + step))]; if (next) select(next.guid); }
    if (event.key === "Home" && shown[0]) { event.preventDefault(); select(shown[0].guid); }
    if (event.key === "End" && shown.length) { event.preventDefault(); select(shown.at(-1).guid); }
  });
  $("add").addEventListener("click", () => startEditing("new"));
  $("edit").addEventListener("click", () => selected && startEditing(selected));
  $("remove").addEventListener("click", async () => {
    const login = byGuid(selected);
    if (!login) return;
    const ok = await confirmAction({ title: "Remove this password?", text: `${login.username || "(no username)"} on ${loginTitle(login)}. This cannot be undone.`, ok: "Remove" });
    if (!ok || !byGuid(login.guid)) return;
    const at = shown.findIndex((item) => item.guid === login.guid);
    await Services.logins.removeLoginAsync(login);
    selected = shown[at + 1]?.guid ?? shown[at - 1]?.guid ?? null;
    await load();
  });
  $("view-origin").addEventListener("click", (event) => { event.preventDefault(); const login = byGuid(selected); if (login) openSite(login.origin); });
  $("copy-username").addEventListener("click", (event) => { const login = byGuid(selected); if (login) copy(login.username, event.currentTarget); });
  $("copy-password").addEventListener("click", (event) => { const login = byGuid(selected); if (login) copy(login.password, event.currentTarget); });
  $("reveal").addEventListener("click", () => setRevealed(!revealed));
  $("edit-reveal").addEventListener("click", () => {
    const input = $("edit-password");
    input.type = input.type === "password" ? "text" : "password";
    setEye($("edit-reveal"), input.type === "text");
  });
  $("editor").addEventListener("submit", (event) => { event.preventDefault(); void save(); });
  $("cancel").addEventListener("click", stopEditing);
  $("editor").addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); stopEditing(); } });

  $("more").addEventListener("click", (event) => { event.stopPropagation(); setMenu($("menu").hidden); });
  $("menu").addEventListener("click", (event) => {
    const run = event.target.closest("[data-run]")?.dataset.run;
    if (!run) return;
    setMenu(false);
    void menuActions[run]().catch((error) => notify(String(error.message ?? error), { bad: true }));
  });
  document.addEventListener("click", (event) => { if (!$("menu").hidden && !event.target.closest(".top")) setMenu(false); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("menu").hidden) { setMenu(false); $("more").focus(); }
    // Firefox's about:logins: Ctrl+F searches the list.
    if (event.key === "f" && (event.ctrlKey || event.metaKey) && !event.altKey) { event.preventDefault(); $("search").focus(); $("search").select(); }
  });
  // A password stays hidden when the user looks away (another tab) and comes back.
  document.addEventListener("visibilitychange", () => { if (document.hidden) window.mwHideSecrets(); });

  // Changes made elsewhere (a login saved in a tab, Settings) show up here.
  let reloadQueued = 0;
  const observer = { observe() { clearTimeout(reloadQueued); reloadQueued = setTimeout(() => { if (!editing) void load(); }, 100); } };
  Services.obs.addObserver(observer, "passwordmgr-storage-changed");
  const prefObserver = { observe: markAppearance };
  Services.prefs.addObserver(APPEARANCE_PREF, prefObserver);
  window.addEventListener("unload", () => {
    Services.obs.removeObserver(observer, "passwordmgr-storage-changed");
    Services.prefs.removeObserver(APPEARANCE_PREF, prefObserver);
  });
}

markAppearance();
wire();
void load().then(() => $("search").focus());
