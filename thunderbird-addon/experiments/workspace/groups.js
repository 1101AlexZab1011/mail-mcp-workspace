// ------------------------------------------------------------ tool groups --
// The space bar shows one button per group of tools, the way Illustrator groups its tools: the button
// opens the group's tool you used last, and the group's other tools are in a flyout beside it. The flyout
// opens when the pointer rests on the button, on a press-and-hold, on a right-click, or from the small
// corner mark. The original buttons stay in the toolbar, hidden: Thunderbird keeps their state (current
// space, badges) and its shortcuts and the add-on's spaces API keep working; a group button only
// clicks the right one.

const TOOL_GROUPS = [
  {
    id: "communicate", label: "Mail and calendar",
    tools: [
      { id: "mail", selector: "#mailButton", icon: "mail" },
      { id: "addressbook", selector: "#addressBookButton", icon: "contacts" },
      { id: "calendar", selector: "#calendarButton", icon: "calendar_month" },
      { id: "tasks", selector: "#tasksButton", icon: "task_alt" },
    ],
  },
  {
    id: "files", label: "Files",
    tools: [
      { id: "files", selector: "#mw-files-dock-button", icon: "folder_open", dock: true },
      { id: "viewer", selector: '[id$="spacesButton-viewer"]', icon: "preview" },
      { id: "artifacts", selector: '[id$="spacesButton-artifacts"]', icon: "artifact" },
    ],
  },
  {
    id: "create", label: "Create",
    tools: [
      { id: "notes", selector: '[id$="spacesButton-notes"]', icon: "notes" },
      { id: "paint", selector: '[id$="spacesButton-paint"]', icon: "brush" },
      { id: "writer", selector: '[id$="spacesButton-writer"]', icon: "writer" },
      { id: "slides", selector: '[id$="spacesButton-slides"]', icon: "slides" },
    ],
  },
];

const GROUPS_PREF = "extensions.mailworkspace.toolGroups";
const FLYOUT_DELAY = 350; // resting on a button this long opens its flyout
const HOLD_DELAY = 450; // and so does holding it down
const CLOSE_DELAY = 250; // leaving the button and the flyout closes it

function readLastTools() {
  try { return JSON.parse(Services.prefs.getStringPref(GROUPS_PREF, "{}")); } catch { return {}; }
}
function writeLastTools(last) { Services.prefs.setStringPref(GROUPS_PREF, JSON.stringify(last)); }

/** "Mail (Ctrl+1)" → { label: "Mail", key: "Ctrl+1" }. */
function splitTitle(title) {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(title ?? "");
  return m ? { label: m[1], key: m[2] } : { label: title ?? "", key: "" };
}

function installToolGroups(window) {
  const document = window.document;
  const top = document.querySelector("#spacesToolbar .spaces-toolbar-top-container");
  if (!top || document.getElementById("mw-group-communicate")) return () => {};
  const html = (tag, className) => { const el = document.createElementNS("http://www.w3.org/1999/xhtml", tag); if (className) el.className = className; return el; };
  const iconUrl = (name) => `resource://mailworkspace/icons/${name}.svg`;
  const original = (tool) => document.querySelector(`#spacesToolbar ${tool.selector}`);
  const last = { communicate: "mail", files: "files", create: "notes", ...readLastTools() };

  // --- the group buttons ---------------------------------------------------------------------------
  const buttons = new Map();
  const anchor = document.getElementById("mailButton") ?? top.firstChild;
  for (const group of TOOL_GROUPS) {
    const button = html("button", "spaces-toolbar-button mw-group-button");
    button.id = `mw-group-${group.id}`;
    button.dataset.group = group.id;
    const img = html("img");
    img.alt = "";
    const corner = html("span", "mw-group-corner");
    const badge = html("span", "mw-group-badge");
    button.append(img, badge, corner);
    top.insertBefore(button, anchor);
    buttons.set(group.id, button);
    wire(group, button, corner);
  }
  document.documentElement.setAttribute("mw-groups", "true");

  // --- the flyout -------------------------------------------------------------------------------------
  const flyout = html("div", "mw-group-flyout");
  flyout.id = "mw-group-flyout";
  flyout.setAttribute("role", "menu");
  flyout.hidden = true;
  (document.body ?? document.documentElement).append(flyout);
  let openGroup = null;
  let openTimer = 0;
  let closeTimer = 0;
  let active = -1;

  const toolsOf = (group) => group.tools.filter((tool) => original(tool));
  const currentTool = (group) => group.tools.find((tool) => {
    const el = original(tool);
    return el && (tool.dock ? false : el.classList.contains("current"));
  });

  function activate(group, tool) {
    const el = original(tool);
    if (!el) return;
    last[group.id] = tool.id;
    writeLastTools(last);
    close();
    el.click();
    refresh();
  }

  function open(group) {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    const button = buttons.get(group.id);
    const tools = toolsOf(group);
    const current = currentTool(group)?.id;
    flyout.replaceChildren(...[html("div", "mw-group-flyout-title")].map((t) => { t.textContent = group.label; return t; }),
      ...tools.map((tool) => {
        const el = original(tool);
        const { label, key } = splitTitle(el.getAttribute("title") ?? el.getAttribute("aria-label"));
        const item = html("button", "mw-group-item");
        item.setAttribute("role", "menuitem");
        item.dataset.tool = tool.id;
        if (tool.id === current || (tool.dock && el.classList.contains("mw-active"))) item.classList.add("current");
        if (tool.id === last[group.id]) item.classList.add("last");
        const img = html("img");
        img.alt = "";
        img.src = iconUrl(tool.icon);
        const name = html("span", "mw-group-item-label");
        name.textContent = label;
        const shortcut = html("span", "mw-group-item-key");
        shortcut.textContent = key;
        item.append(img, name, shortcut);
        item.addEventListener("click", () => activate(group, tool));
        item.addEventListener("pointerenter", () => setActive([...flyout.querySelectorAll(".mw-group-item")].indexOf(item)));
        return item;
      }));
    flyout.hidden = false;
    openGroup = group;
    active = -1;
    const box = button.getBoundingClientRect();
    const height = flyout.getBoundingClientRect().height;
    flyout.style.left = `${Math.round(box.right + 6)}px`;
    flyout.style.top = `${Math.round(Math.max(6, Math.min(box.top - 8, window.innerHeight - height - 6)))}px`;
    button.classList.add("mw-flyout-open");
  }

  function close() {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    if (!openGroup) return;
    buttons.get(openGroup.id)?.classList.remove("mw-flyout-open");
    flyout.hidden = true;
    openGroup = null;
  }
  const closeSoon = () => { window.clearTimeout(closeTimer); closeTimer = window.setTimeout(close, CLOSE_DELAY); };

  function setActive(index) {
    const items = [...flyout.querySelectorAll(".mw-group-item")];
    active = (index + items.length) % items.length;
    items.forEach((item, k) => item.classList.toggle("active", k === active));
  }

  function wire(group, button, corner) {
    let held = false;
    let holdTimer = 0;
    button.addEventListener("pointerenter", () => {
      window.clearTimeout(closeTimer);
      // Moving along the bar with a flyout open shows the next group's tools at once.
      if (openGroup && openGroup !== group) { open(group); return; }
      if (!openGroup) openTimer = window.setTimeout(() => open(group), FLYOUT_DELAY);
    });
    button.addEventListener("pointerleave", () => { window.clearTimeout(openTimer); window.clearTimeout(holdTimer); if (openGroup) closeSoon(); });
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      held = false;
      holdTimer = window.setTimeout(() => { held = true; open(group); }, HOLD_DELAY);
    });
    button.addEventListener("pointerup", () => window.clearTimeout(holdTimer));
    button.addEventListener("click", (event) => {
      if (held) { held = false; return; } // the press opened the flyout
      if (event.target === corner) { if (openGroup === group) close(); else open(group); return; }
      const tool = group.tools.find((t) => t.id === last[group.id] && original(t)) ?? toolsOf(group)[0];
      if (tool) activate(group, tool);
    });
    button.addEventListener("contextmenu", (event) => { event.preventDefault(); event.stopPropagation(); open(group); });
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); open(group); setActive(0); }
    });
  }

  flyout.addEventListener("pointerenter", () => window.clearTimeout(closeTimer));
  flyout.addEventListener("pointerleave", closeSoon);
  const onKey = (event) => {
    if (!openGroup) return;
    const items = [...flyout.querySelectorAll(".mw-group-item")];
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActive(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(active - 1); }
    else if (event.key === "Enter" && items[active]) { event.preventDefault(); items[active].click(); }
  };
  const onDown = (event) => { if (openGroup && !flyout.contains(event.target) && !buttons.get(openGroup.id)?.contains(event.target)) close(); };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("blur", close);

  // --- following Thunderbird's state ------------------------------------------------------------------
  // A tool that becomes current by any route (shortcut, the agent, a link) is its group's last tool.
  const dockWasOpen = new Map();
  function refresh() {
    let changed = false;
    for (const group of TOOL_GROUPS) {
      const button = buttons.get(group.id);
      const current = currentTool(group);
      if (current && last[group.id] !== current.id) { last[group.id] = current.id; changed = true; }
      const files = group.tools.find((t) => t.dock);
      // Opening the file browser (Ctrl+6, the agent) makes it the group's last tool too.
      const isOpen = Boolean(files && original(files)?.classList.contains("mw-active"));
      if (files && isOpen && dockWasOpen.get(group.id) === false && last[group.id] !== files.id) { last[group.id] = files.id; changed = true; }
      if (files) dockWasOpen.set(group.id, isOpen);
      const dockOpen = files && last[group.id] === files.id && original(files)?.classList.contains("mw-active");
      const tool = group.tools.find((t) => t.id === last[group.id] && original(t)) ?? toolsOf(group)[0] ?? group.tools[0];
      const src = iconUrl(tool.icon);
      const img = button.querySelector("img");
      if (img.getAttribute("src") !== src) img.setAttribute("src", src);
      button.classList.toggle("current", Boolean(current));
      button.classList.toggle("mw-active", Boolean(dockOpen));
      const el = original(tool);
      const { label, key } = splitTitle(el?.getAttribute("title"));
      const others = toolsOf(group).filter((t) => t !== tool).length;
      const aria = `${label}${key ? ` (${key})` : ""}${others ? `; ${others} more in ${group.label}` : ""}`;
      if (button.getAttribute("aria-label") !== aria) button.setAttribute("aria-label", aria);
      // Badges (unread mail, due tasks) of any tool in the group show on the group.
      const badge = group.tools.map((t) => original(t)?.querySelector(".spaces-badge-container")).find((b) => b && b.textContent.trim() && getComputedStyleSafe(window, b)?.display !== "none"); // its button is hidden, so not checkVisibility
      const text = badge?.textContent.trim() ?? "";
      const mine = button.querySelector(".mw-group-badge");
      if (mine.textContent !== text) mine.textContent = text;
      mine.hidden = !text;
    }
    if (changed) writeLastTools(last);
  }
  let queued = 0;
  const queue = () => { if (!queued) queued = window.requestAnimationFrame(() => { queued = 0; refresh(); }); };
  const observer = new window.MutationObserver((records) => {
    if (records.every((r) => r.target.closest?.(".mw-group-button"))) return; // our own changes
    queue();
  });
  observer.observe(document.getElementById("spacesToolbar") ?? top, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "title"], characterData: true });
  refresh();

  return () => {
    observer.disconnect();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("blur", close);
    for (const button of buttons.values()) button.remove();
    flyout.remove();
    document.documentElement.removeAttribute("mw-groups");
  };
}

function getComputedStyleSafe(window, el) {
  try { return window.getComputedStyle(el); } catch { return null; }
}
