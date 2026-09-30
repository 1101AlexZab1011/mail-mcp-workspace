// Terminal panel (Ctrl+`): tabs of terminals, each tab split into panes
// (right or down) with draggable dividers. Every pane is an xterm.js view of
// a pseudo-terminal the workspace host owns, which the agent can use too.
import { Terminal } from "./vendor/xterm/xterm.mjs";
import { FitAddon } from "./vendor/xterm/addon-fit.mjs";
import { WebLinksAddon } from "./vendor/xterm/addon-web-links.mjs";
import { host, HOST_ENDPOINT, json } from "./shared/broker.js";
import { icon } from "./shared/icons.js";
import { $, h, iconButton, toast, background, registerPage } from "./shared/page.js";

const area = $("#area");
const tabs = []; // { root: node, focused: paneId }
let active = -1;
const panes = new Map(); // paneId (= session id) → { id, term, fit, el, source, title, cwd, exited }

const THEMES = {
  dark: { background: "#1e2127", foreground: "#d7dae0", cursor: "#8e9cff", selectionBackground: "#3a4150", black: "#1e2127", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#d7dae0", brightBlack: "#5c6370", brightRed: "#ef7b86", brightGreen: "#a5d188", brightYellow: "#f0cc8a", brightBlue: "#74bdf5", brightMagenta: "#d38be8", brightCyan: "#65c6d2", brightWhite: "#ffffff" },
  light: { background: "#fafafa", foreground: "#383a42", cursor: "#4557d6", selectionBackground: "#d7dcf4", black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401", blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#fafafa", brightBlack: "#a0a1a7", brightRed: "#e45649", brightGreen: "#50a14f", brightYellow: "#c18401", brightBlue: "#4078f2", brightMagenta: "#a626a4", brightCyan: "#0184bc", brightWhite: "#ffffff" },
};
const currentTheme = () => (document.documentElement.dataset.theme === "light" || (!document.documentElement.dataset.theme && !matchMedia("(prefers-color-scheme: dark)").matches) ? THEMES.light : THEMES.dark);

// ---------------------------------------------------------------- panes --

async function createPane({ cwd } = {}) {
  const el = h("div.pane");
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", "Source Code Pro", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    theme: currentTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((event, uri) => { event.preventDefault(); window.open(uri, "_blank", "noopener"); }));
  const session = await host("/v1/term", json({ cwd, cols: 100, rows: 30 }));
  // "Pristine" until someone types: the agent may take over an untouched starter tab.
  const pane = { id: session.id, term, fit, el, source: null, title: session.title, cwd: session.cwd, exited: null, pristine: true };
  panes.set(session.id, pane);
  el.dataset.pane = session.id;
  el.addEventListener("mousedown", () => focusPane(session.id));

  // Keystrokes: batched into one request per frame.
  let pendingInput = "";
  let flushing = null;
  const flush = async () => {
    const data = pendingInput;
    pendingInput = "";
    flushing = null;
    if (data) await host(`/v1/term/${session.id}/input`, json({ data })).catch(() => {});
  };
  term.onData((data) => { pane.pristine = false; pendingInput += data; flushing ??= setTimeout(() => void flush(), 4); });
  term.onResize(({ cols, rows }) => { void host(`/v1/term/${session.id}/resize`, json({ cols, rows })).catch(() => {}); });
  term.onTitleChange((title) => { pane.title = title || session.title; renderTabs(); });
  new ResizeObserver(() => { if (el.isConnected && el.offsetWidth) { try { fit.fit(); } catch { /* not laid out */ } } }).observe(el);
  await connect(pane);
  return pane;
}

async function connect(pane) {
  const { ticket } = await host(`/v1/term/${pane.id}/ticket`, { method: "POST" });
  const source = new EventSource(`${HOST_ENDPOINT}/v1/term-stream/${ticket}`);
  pane.source = source;
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "replay") { pane.term.reset(); pane.term.write(event.data); if (event.exited) markExited(pane, event.exited.code); }
    else if (event.type === "data") pane.term.write(event.data);
    else if (event.type === "exit") markExited(pane, event.code);
    else if (event.type === "closed") source.close();
  };
  source.onerror = () => {
    // The host restarted or the network hiccuped: reconnect with a fresh ticket.
    source.close();
    if (!pane.exited && panes.has(pane.id)) setTimeout(() => connect(pane).catch(() => markExited(pane, null)), 1500);
  };
}

function markExited(pane, code) {
  pane.exited = { code };
  pane.el.querySelector(".ended")?.remove();
  pane.el.append(h("span.ended", {}, `Process exited${code != null ? ` (${code})` : ""} · Ctrl+Shift+W closes`));
  renderTabs();
}

function disposePane(id) {
  const pane = panes.get(id);
  if (!pane) return;
  pane.source?.close();
  pane.term.dispose();
  panes.delete(id);
  void host(`/v1/term/${id}`, { method: "DELETE" }).catch(() => {});
}

// --------------------------------------------------------------- layout --
// A tab's layout is a tree: { pane: id } or { split: "row" | "col", a, b, ratio }.

function paneIds(node) { return node.pane ? [node.pane] : [...paneIds(node.a), ...paneIds(node.b)]; }

function renderNode(node, container) {
  if (node.pane) {
    const pane = panes.get(node.pane);
    container.append(pane.el);
    if (!pane.term.element) pane.term.open(pane.el);
    return;
  }
  const split = h(`div.split.${node.split}`);
  const a = h("div.slot", { style: { flex: `${node.ratio} 1 0` } });
  const b = h("div.slot", { style: { flex: `${1 - node.ratio} 1 0` } });
  const divider = h("div.divider", { role: "separator", title: "Drag to resize" });
  divider.addEventListener("pointerdown", (event) => {
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("dragging");
    const rect = split.getBoundingClientRect();
    const move = (e) => {
      const ratio = node.split === "row" ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
      node.ratio = Math.max(0.1, Math.min(0.9, ratio));
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", () => { divider.removeEventListener("pointermove", move); divider.classList.remove("dragging"); }, { once: true });
  });
  split.append(a, divider, b);
  container.append(split);
  renderNode(node.a, a);
  renderNode(node.b, b);
}

function render() {
  const tab = tabs[active];
  area.replaceChildren();
  if (!tab) {
    area.append(h("div.empty", {}, icon("terminal"), h("p", {}, "No terminals."), h("button.btn.primary", { type: "button", onclick: () => newTab() }, "New terminal")));
    renderTabs();
    return;
  }
  renderNode(tab.root, area);
  area.toggleAttribute("data-single", Boolean(tab.root.pane));
  for (const id of paneIds(tab.root)) panes.get(id).el.classList.toggle("focused", id === tab.focused);
  renderTabs();
  requestAnimationFrame(() => { for (const id of paneIds(tab.root)) { try { panes.get(id).fit.fit(); } catch { /* hidden */ } } panes.get(tab.focused)?.term.focus(); });
}

function renderTabs() {
  $("#tabs").replaceChildren(...tabs.map((tab, index) => {
    const ids = paneIds(tab.root);
    const focusedPane = panes.get(tab.focused);
    const title = focusedPane?.title ?? "terminal";
    return h("button.tab", {
      type: "button", role: "tab", "aria-selected": String(index === active), title: `${title}${focusedPane?.cwd ? ` · ${focusedPane.cwd}` : ""}`,
      onclick: () => { active = index; render(); },
      onauxclick: (event) => { if (event.button === 1) closeTab(index); },
    }, icon("terminal"), h("span.label", {}, title), ids.length > 1 ? h("span.count", {}, `${ids.length} panes`) : null,
    h("span.close", { role: "button", title: "Close tab (Ctrl+Shift+W closes a pane)", onclick: (event) => { event.stopPropagation(); closeTab(index); } }, icon("close", { size: 14 })));
  }));
  $("#tabs").append(iconButton("add", "New terminal tab (Ctrl+Shift+T)", () => newTab(), { small: true }));
}

function focusPane(id) {
  const index = tabs.findIndex((tab) => paneIds(tab.root).includes(id));
  if (index < 0) return;
  tabs[index].focused = id;
  if (index !== active) { active = index; render(); return; }
  for (const paneId of paneIds(tabs[index].root)) panes.get(paneId).el.classList.toggle("focused", paneId === id);
  panes.get(id).term.focus();
  renderTabs();
}

async function newTab({ cwd } = {}) {
  const pane = await createPane({ cwd });
  tabs.push({ root: { pane: pane.id }, focused: pane.id });
  active = tabs.length - 1;
  render();
  return pane.id;
}

/** Split the focused pane: "row" puts the new one to the right, "col" below. */
async function split(direction, { cwd } = {}) {
  const tab = tabs[active];
  if (!tab) return newTab({ cwd });
  const pane = await createPane({ cwd: cwd ?? panes.get(tab.focused)?.cwd });
  const replace = (node) => {
    if (node.pane === tab.focused) return { split: direction, a: node, b: { pane: pane.id }, ratio: 0.5 };
    if (node.pane) return node;
    return { ...node, a: replace(node.a), b: replace(node.b) };
  };
  tab.root = replace(tab.root);
  tab.focused = pane.id;
  render();
  return pane.id;
}

function closePane(id = tabs[active]?.focused) {
  const index = tabs.findIndex((tab) => paneIds(tab.root).includes(id));
  if (index < 0) return;
  const tab = tabs[index];
  const remove = (node) => {
    if (node.pane) return node.pane === id ? null : node;
    const a = remove(node.a);
    const b = remove(node.b);
    return a && b ? { ...node, a, b } : a ?? b;
  };
  const root = remove(tab.root);
  disposePane(id);
  if (!root) { tabs.splice(index, 1); active = Math.min(active, tabs.length - 1); }
  else { tab.root = root; if (tab.focused === id) tab.focused = paneIds(root)[0]; }
  render();
}

function closeTab(index) {
  const tab = tabs[index];
  if (!tab) return;
  for (const id of paneIds(tab.root)) disposePane(id);
  tabs.splice(index, 1);
  active = Math.min(Math.max(active - (index <= active ? 1 : 0), tabs.length ? 0 : -1), tabs.length - 1);
  render();
}

// ------------------------------------------------------------------ bar --

let maximized = false;
function renderActions() {
  $("#actions").replaceChildren(
    iconButton("splitscreen_right", "Split right (Ctrl+Shift+5)", () => split("row"), { small: true }),
    iconButton("splitscreen_bottom", "Split down (Ctrl+Shift+E)", () => split("col"), { small: true }),
    iconButton("close", "Close pane (Ctrl+Shift+W)", () => closePane(), { small: true }),
    iconButton(maximized ? "close_fullscreen" : "open_in_full", maximized ? "Restore height" : "Maximize", async () => {
      maximized = !maximized;
      await browser.workspace.setTerminal({ maximized });
      renderActions();
    }, { small: true }),
    iconButton("keyboard_arrow_down", "Hide terminal (Ctrl+`)", () => browser.workspace.setTerminal({ visible: false }), { small: true }),
  );
}

addEventListener("keydown", (event) => {
  if (!(event.ctrlKey && event.shiftKey)) return;
  const key = event.key.toLowerCase();
  const actions = { t: () => newTab(), w: () => closePane(), 5: () => split("row"), "%": () => split("row"), e: () => split("col"), pageup: () => { active = (active - 1 + tabs.length) % tabs.length; render(); }, pagedown: () => { active = (active + 1) % tabs.length; render(); } };
  const action = actions[key] ?? actions[event.code === "Digit5" ? 5 : ""];
  if (action) { event.preventDefault(); event.stopPropagation(); void action(); }
}, true);

// Follow the app's light/dark choice.
new MutationObserver(() => { for (const pane of panes.values()) pane.term.options.theme = currentTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// ------------------------------------------------------------- agent API --

registerPage("terminal", {
  state: () => ({
    tabs: tabs.map((tab, index) => ({ index, active: index === active, focused: tab.focused, panes: paneIds(tab.root).map((id) => ({ id, title: panes.get(id).title, cwd: panes.get(id).cwd, exited: panes.get(id).exited })) })),
  }),
  commands: {
    open: async ({ placement = "tab", cwd }) => {
      // The panel starts with one terminal; if nobody has used it, a new tab replaces it.
      const starter = tabs.length === 1 && paneIds(tabs[0].root).length === 1 ? panes.get(tabs[0].focused) : null;
      const id = placement === "right" ? await split("row", { cwd }) : placement === "down" ? await split("col", { cwd }) : await newTab({ cwd });
      if (placement === "tab" && starter?.pristine) closeTab(tabs.findIndex((tab) => tab.focused === starter.id));
      return { id };
    },
    focus: ({ id }) => { focusPane(id); return { focused: id }; },
    close: ({ id }) => { closePane(id); return { closed: id }; },
    tab: ({ index }) => { if (!tabs[index]) throw new Error("No such tab"); active = index; render(); return { active }; },
  },
});

// ------------------------------------------------------------------ start --

renderActions();
await newTab().catch((error) => { toast(error.message); render(); });
void background;
