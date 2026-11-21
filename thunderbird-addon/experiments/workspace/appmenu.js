/* Thoth's own app menu (☰ at the bottom of the spaces bar), in place of Thunderbird's: New ▸, search and
   filters, import and export, Accounts ▸, Settings, Keyboard shortcuts, Help, About ▸ (version, the
   licences, troubleshooting) and Quit. Thunderbird's own commands do the work. It draws with the
   browser menu's styles (.mw-web-menu…), so the two menus look alike.
   Loaded into the Experiment's scope after shell.js and webmenu.js. */
/* global Services, ChromeUtils, keyHint, isMac, MW_XHTML, webIcon, openSpace, toolEnabled */

var APP_MENU = "mw-app-menu";
var THOTH_ADDON_ID = "agent-chat@mail-mcp-workspace.local";
var THOTH_HELP_URL = "https://github.com/1101AlexZab1011/Thoth#readme";

function closeAppMenu(window) {
  const panel = window.document.getElementById(APP_MENU);
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  panel.mwUndo?.();
  window.document.getElementById("mw-appmenu-button")?.setAttribute("aria-expanded", "false");
}

/** Open an add-on space (Writer, Draw, …) by its short name. */
function openAddonSpace(window, name) {
  const space = window.gSpacesToolbar?.spaces?.find((s) => s.name === name || s.name.endsWith(`-spacesButton-${name}`));
  if (space) window.gSpacesToolbar.openSpace(window.gTabmail, space);
}

function openAppMenu(window, view = "main") {
  const document = window.document;
  const anchor = document.getElementById("mw-appmenu-button");
  let panel = document.getElementById(APP_MENU);
  if (!panel) {
    panel = document.createElementNS(MW_XHTML, "div");
    panel.id = APP_MENU;
    panel.className = "mw-web-menu mw-app-menu";
    panel.setAttribute("role", "menu");
    panel.hidden = true;
    (document.body ?? document.documentElement).append(panel);
  }
  panel.mwUndo?.();
  const html = (tag, className, text) => { const el = document.createElementNS(MW_XHTML, tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const go = (next) => () => openAppMenu(window, next);
  const done = (run) => () => { closeAppMenu(window); try { run(); } catch (error) { console.error("Thoth menu:", error); } };
  const cmd = (name) => done(() => window.goDoCommand(name));
  function item(label, { icon, key, submenu, run, danger } = {}) {
    const row = html("button", "mw-web-menu-item");
    row.type = "button";
    row.setAttribute("role", "menuitem");
    if (danger) row.classList.add("danger");
    row.append(icon ? webIcon(document, icon) : html("span", "mw-web-menu-noicon"), html("span", "mw-web-menu-label", label));
    if (key) row.append(html("span", "mw-web-menu-key", keyHint(key)));
    if (submenu) row.append(webIcon(document, "chevron_right"));
    row.addEventListener("click", (event) => { event.stopPropagation(); run?.(); });
    return row;
  }
  const separator = () => html("div", "mw-web-menu-sep");
  const header = (title) => {
    const row = html("div", "mw-web-menu-header");
    const back = html("button", "mw-web-menu-back");
    back.type = "button";
    back.title = "Back";
    back.append(webIcon(document, "arrow_back"));
    back.addEventListener("click", (event) => { event.stopPropagation(); openAppMenu(window, "main"); });
    row.append(back, html("span", "mw-web-menu-title", title));
    return row;
  };
  const mod = isMac() ? "⌘" : "Ctrl+";

  const views = {
    main: () => [
      ...(updateOffer ? [item(`Install update ${updateOffer.version}`, { icon: "download", run: done(() => {
        void installThothUpdate(updateOffer.url).catch((error) => Services.prompt.alert(window, "Thoth update", `The update could not be installed: ${error.message}`));
      }) }), separator()] : []),
      item("New", { icon: "add", submenu: true, run: go("new") }),
      separator(),
      item("Search messages…", { icon: "search", key: `${mod}Shift+F`, run: done(() => window.searchAllMessages()) }),
      item("Message filters…", { icon: "filter_list", run: done(() => window.MsgFilters()) }),
      item("Import…", { icon: "download", run: done(() => window.toImport()) }),
      item("Export…", { icon: "upload", run: done(() => window.toExport()) }),
      separator(),
      item("Accounts", { icon: "manage_accounts", submenu: true, run: go("accounts") }),
      item("Settings", { icon: "settings", run: done(() => openSpace(window, "settings")) }),
      item("Keyboard shortcuts", { icon: "keyboard", submenu: true, run: go("keys") }),
      item("Help", { icon: "help", run: done(() => window.openLinkExternally(THOTH_HELP_URL)) }),
      item("About Thoth", { icon: "info", submenu: true, run: go("about") }),
      separator(),
      item("Quit", { icon: "power_settings_new", key: `${mod}Q`, run: done(() => window.goQuitApplication()) }),
    ],
    new: () => {
      // Tools turned off in Settings → Tools (groups.js) have no "New" entry.
      const when = (tool, entry) => (toolEnabled(tool) ? [entry] : []);
      const create = [
        ...when("writer", item("Document", { icon: "description", run: done(() => openAddonSpace(window, "writer")) })),
        ...when("draw", item("Drawing", { icon: "draw", run: done(() => openAddonSpace(window, "draw")) })),
        ...when("pdf", item("PDF", { icon: "picture_as_pdf", run: done(() => openAddonSpace(window, "pdf")) })),
        ...when("slides", item("Slides", { icon: "slideshow", run: done(() => openAddonSpace(window, "slides")) })),
        ...when("notes", item("Note", { icon: "sticky_note_2", run: done(() => openAddonSpace(window, "notes")) })),
      ];
      return [
        header("New"),
        item("Message", { icon: "mail", key: `${mod}N`, run: cmd("cmd_newMessage") }),
        ...when("calendar", item("Event", { icon: "event", key: `${mod}I`, run: cmd("calendar_new_event_command") })),
        ...when("tasks", item("Task", { icon: "task_alt", key: `${mod}D`, run: cmd("calendar_new_todo_command") })),
        ...when("addressbook", item("Contact", { icon: "person_add", run: cmd("cmd_newCard") })),
        ...(create.length ? [separator(), ...create] : []),
      ];
    },
    accounts: () => [
      header("Accounts"),
      item("Account settings", { icon: "manage_accounts", run: done(() => window.MsgAccountManager(null)) }),
      item("Add a mail account…", { icon: "mail", run: done(() => window.openAccountSetup()) }),
      item("Add a calendar…", { icon: "event", run: cmd("calendar_new_calendar_command") }),
      item("Add an address book…", { icon: "contacts", run: done(() => window.openNewABDialog()) }),
      separator(),
      item("Encryption keys (OpenPGP)", { icon: "key", run: done(() => window.openKeyManager()) }),
    ],
    keys: () => {
      const rows = [header("Keyboard shortcuts")];
      const list = [
        ["New message", `${mod}N`], ["Search", `${mod}K`], ["Search all messages", `${mod}Shift+F`],
        ["Chat dock", `${mod}5`], ["File dock", `${mod}6`], ["Files", `${mod}7`], ["Artifacts", `${mod}8`], ["Paint", `${mod}9`],
        ["Terminal", `${mod}\``], ["Quit", `${mod}Q`],
      ];
      for (const [label, key] of list) {
        const row = html("div", "mw-web-menu-item mw-app-menu-static");
        row.append(html("span", "mw-web-menu-noicon"), html("span", "mw-web-menu-label", label), html("span", "mw-web-menu-key", keyHint(key)));
        rows.push(row);
      }
      return rows;
    },
    about: () => {
      const card = html("div", "mw-app-about");
      const logo = html("img", "mw-app-about-logo");
      logo.alt = "";
      logo.src = "resource://mailworkspace/icons/thoth.svg";
      const name = html("div", "mw-app-about-name", "Thoth");
      const version = html("div", "mw-app-about-version", "");
      const base = html("div", "mw-app-about-base", `Built on Thunderbird ${Services.appinfo.version}, by MZLA Technologies and the Mozilla community.`);
      card.append(logo, name, version, base);
      ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager.getAddonByID(THOTH_ADDON_ID)
        .then((addon) => { version.textContent = `Version ${addon?.version ?? ""}`; }).catch(() => {});
      return [
        header("About Thoth"), card, separator(),
        item("Licences", { icon: "gavel", run: done(() => window.openContentTab?.("about:license") ?? window.openTab("contentTab", { url: "about:license" })) }),
        item("Source code", { icon: "code", run: done(() => window.openLinkExternally("https://github.com/1101AlexZab1011/Thoth")) }),
        item("Troubleshooting information", { icon: "build", run: done(() => window.openAboutSupport()) }),
      ];
    },
  };

  panel.replaceChildren(...(views[view] ?? views.main)());
  panel.dataset.view = view;
  panel.hidden = false;
  anchor?.setAttribute("aria-expanded", "true");
  // Beside the button, its bottom edge level with the button's, inside the window.
  const box = anchor?.getBoundingClientRect() ?? { right: 60, bottom: window.innerHeight - 10 };
  const { width, height } = panel.getBoundingClientRect();
  panel.style.left = `${Math.round(Math.min(box.right + 6, window.innerWidth - width - 6))}px`;
  panel.style.top = `${Math.round(Math.max(6, Math.min(box.bottom - height, window.innerHeight - height - 6)))}px`;
  if (!panel.contains(document.activeElement)) panel.querySelector("button:not([disabled])")?.focus();
  const onDown = (event) => { if (!panel.contains(event.target) && event.target !== anchor && !anchor?.contains(event.target)) closeAppMenu(window); };
  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); if (view !== "main") openAppMenu(window, "main"); else closeAppMenu(window); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const items = [...panel.querySelectorAll("button.mw-web-menu-item, .mw-web-menu-back")];
      const at = items.indexOf(document.activeElement);
      items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      event.preventDefault();
    }
  };
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", () => closeAppMenu(window), { once: true });
  panel.mwUndo = () => { window.removeEventListener("mousedown", onDown, true); window.removeEventListener("keydown", onKey, true); delete panel.mwUndo; };
}

function toggleAppMenu(window) {
  const panel = window.document.getElementById(APP_MENU);
  if (panel && !panel.hidden) closeAppMenu(window); else openAppMenu(window);
}
