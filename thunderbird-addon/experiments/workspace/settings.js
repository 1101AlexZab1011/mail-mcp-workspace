/* One Settings for Thoth. The Settings space (the gear, the ☰ menu, gui_open settings) opens our
   settings page (options.html) instead of Thunderbird's; that page shows Thoth's own settings and a
   curated set of mail, writing and calendar settings, read and written here through an allow-list.
   Everything else stays reachable from "Advanced settings", Thunderbird's full list, themed and
   without the parts that don't belong to this app (Chat, Export for Mobile, data collection,
   updates, start page).
   Loaded into the Experiment's scope; installSettingsSpace() is called per window by applyLayout. */
/* global Services */

// The settings the page may read and write, with their types. Nothing else passes.
var SETTINGS_PREFS = {
  // Tools: those turned off, { groupId: [toolId…] } as JSON (groups.js, TOOLS_PREF)
  "extensions.mailworkspace.tools": "string",
  // Mail
  "mail.threadpane.listview": "int", // 0 cards, 1 table
  "mail.threadpane.cardsview.rowcount": "int",
  "mailnews.mark_message_read.auto": "bool",
  "mailnews.mark_message_read.delay": "bool",
  "mailnews.mark_message_read.delay.interval": "int",
  "mailnews.message_display.disable_remote_image": "bool",
  "mail.biff.show_alert": "bool",
  "mail.biff.play_sound": "bool",
  // Writing
  "mail.spellcheck.inline": "bool",
  "mail.compose.autosave": "bool",
  "mail.compose.autosaveinterval": "int",
  "mail.collect_email_address_outgoing": "bool",
  "mail.warn_on_send_accel_key": "bool",
  // Calendar
  "calendar.week.start": "int",
  "calendar.view-minimonth.showWeekNumber": "bool",
  "calendar.view.daystarthour": "int",
  "calendar.view.dayendhour": "int",
  "calendar.event.defaultlength": "int",
  "calendar.alarms.onforevents": "int",
  "calendar.alarms.eventalarmlen": "int",
  "calendar.alarms.playsound": "bool",
};

function getSettings(names) {
  const out = {};
  for (const name of names ?? Object.keys(SETTINGS_PREFS)) {
    const type = SETTINGS_PREFS[name];
    if (!type) continue;
    try {
      out[name] = type === "bool" ? Services.prefs.getBoolPref(name) : type === "int" ? Services.prefs.getIntPref(name) : Services.prefs.getStringPref(name);
    } catch { out[name] = null; }
  }
  return out;
}

function setSetting(name, value) {
  const type = SETTINGS_PREFS[name];
  if (!type) throw new Error(`${name} is not a setting this page can change`);
  if (type === "bool") Services.prefs.setBoolPref(name, Boolean(value));
  else if (type === "int") {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) throw new Error(`${name} needs a number`);
    Services.prefs.setIntPref(name, number);
  } else Services.prefs.setStringPref(name, String(value));
  return getSettings([name]);
}

/** The page's buttons that open Thunderbird's own dialogs and pages. */
function settingsAction(window, action) {
  const actions = {
    accounts: () => window.MsgAccountManager(null),
    "add-mail": () => window.openAccountSetup(),
    "add-calendar": () => window.goDoCommand("calendar_new_calendar_command"),
    "add-addressbook": () => window.openNewABDialog(),
    keys: () => window.openKeyManager(),
    passwords: () => window.openTab("contentTab", { url: "about:logins" }),
    filters: () => window.MsgFilters(),
    advanced: () => window.mwOpenPreferences?.(),
    config: () => window.openTab("contentTab", { url: "about:config" }),
  };
  const run = actions[action];
  if (!run) throw new Error(`Unknown settings action ${action}`);
  run();
  return { ok: true };
}

/** The Settings space opens our page; Thunderbird's own stays behind "Advanced settings". */
function installSettingsSpace(window, ctx) {
  const space = window.gSpacesToolbar?.spaces?.find((candidate) => candidate.name === "settings");
  const optionsUrl = ctx.extension.baseURI.resolve("options.html");
  const originalOpenPrefs = window.openPreferencesTab;
  window.mwOpenPreferences = (...args) => originalOpenPrefs.apply(window, args);
  // Thunderbird's own "Settings" commands land on our page too; a call for a given pane still gets
  // that pane of Thunderbird's list.
  window.openPreferencesTab = (...args) => (args[0] ? originalOpenPrefs.apply(window, args) : ctx.shortcut("settings"));
  if (!space) return () => { window.openPreferencesTab = originalOpenPrefs; delete window.mwOpenPreferences; };
  const originalOpen = space.open;
  const originalIn = space.tabInSpace;
  space.open = () => ctx.shortcut("settings");
  space.tabInSpace = (tabInfo) => {
    try { if (tabInfo?.browser?.currentURI?.spec?.startsWith(optionsUrl)) return 1; } catch { /* no browser */ }
    return originalIn.call(space, tabInfo);
  };
  return () => {
    space.open = originalOpen;
    space.tabInSpace = originalIn;
    window.openPreferencesTab = originalOpenPrefs;
    delete window.mwOpenPreferences;
  };
}
