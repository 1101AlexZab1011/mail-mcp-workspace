// Plumbing every add-on page shares: a name the background can address, and
// the agent-facing basics (state, snapshot, act) answered from inside the page.
import { icon } from "./icons.js";
import "./theme.js";

const handlers = new Map();
let agentInputUntil = 0;
/** True while the agent is sending keyboard or mouse input: user-only controls ignore it. */
export const agentIsActing = () => Date.now() < agentInputUntil;
let pageName = "page";
let stateProvider = () => ({});

/**
 * Register this page. `commands` maps message types to handlers returning a
 * value (or a promise). `state` describes what the page shows and has selected.
 */
export function registerPage(name, { commands = {}, state } = {}) {
  pageName = name;
  if (state) stateProvider = state;
  for (const [type, handler] of Object.entries(commands)) handlers.set(type, handler);
  browser.runtime.onMessage.addListener((message) => {
    if (message?.to === "*" && message.type === "agent-input") { agentInputUntil = Date.now() + (message.ms ?? 2000); return undefined; }
    if (message?.to !== pageName) return undefined;
    const handler = handlers.get(message.type) ?? builtin[message.type];
    if (!handler) return Promise.resolve({ error: `Unknown command ${message.type} for ${pageName}` });
    return Promise.resolve().then(() => handler(message)).then((value) => value ?? { ok: true }, (error) => ({ error: error.message ?? String(error) }));
  });
}

// ------------------------------------------------ agent access to the page --

const refs = new Map();
const ACTIONABLE = "button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=treeitem], [role=tab], [role=option], [role=menuitem], [contenteditable=true], [data-agent]";

function label(el) {
  const text = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  return (text(el.getAttribute("aria-label")) || text(el.dataset.agent) || text(el.textContent) || text(el.title) || text(el.placeholder) || el.id || "").slice(0, 100);
}

const builtin = {
  state: () => ({ page: pageName, ...stateProvider() }),
  snapshot: ({ query, limit = 250 }) => {
    refs.clear();
    const items = [];
    let n = 0;
    for (const el of document.querySelectorAll(ACTIONABLE)) {
      if (items.length >= limit) break;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > innerHeight || !el.checkVisibility()) continue;
      if (el.closest("[data-user-only]")) continue; // approvals are the user's alone
      const name = label(el);
      if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
      const ref = `${pageName}:p${++n}`;
      refs.set(ref, new WeakRef(el));
      const item = { ref, role: el.getAttribute("role") || el.localName, name };
      if ("value" in el && el.value && el.localName !== "button") item.value = String(el.value).slice(0, 200);
      if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-pressed") === "true") item.selected = true;
      if (el.disabled) item.disabled = true;
      items.push(item);
    }
    return { page: pageName, items };
  },
  act: ({ ref, action, value }) => {
    const el = refs.get(ref)?.deref();
    if (!el?.isConnected) throw new Error(`Ref ${ref} is stale; take a new snapshot`);
    if (el.closest("[data-user-only]")) throw new Error("This control is reserved for the user");
    el.scrollIntoView({ block: "nearest" });
    if (action === "click") el.click();
    else if (action === "dblclick") el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    else if (action === "rightclick") { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })); }
    else if (action === "focus") el.focus();
    else if (action === "type") {
      el.focus();
      if (el.isContentEditable) document.execCommand("insertText", false, value ?? "");
      else { el.value = value ?? ""; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }
    } else if (action === "select") { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); }
    else if (action === "press") { el.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })); }
    else throw new Error(`Unknown action ${action}`);
    return { ref, action, done: true, name: label(el) };
  },
};

// ---------------------------------------------------------------- helpers --

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Build an element: h("button.icon-btn", { title, onclick }, child…). */
export function h(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style" && typeof value === "object") {
      // Custom properties (--depth) only take effect through setProperty.
      for (const [name, v] of Object.entries(value)) if (name.startsWith("--")) el.style.setProperty(name, String(v)); else el.style[name] = v;
    }
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}

/** An icon button. */
export function iconButton(name, title, onclick, { small = false, pressed, fill } = {}) {
  return h(`button.icon-btn${small ? ".small" : ""}`, { type: "button", title, "aria-label": title, onclick, ...(pressed !== undefined ? { "aria-pressed": String(pressed) } : {}) }, icon(name, { fill }));
}

let toastTimer;
export function toast(message, { ms = 3200 } = {}) {
  document.querySelector(".toast")?.remove();
  const el = h("div.toast", { role: "status" }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}

/** A context menu at the pointer: items are { label, icon, run, danger } or "-". */
export function contextMenu(event, items) {
  event.preventDefault();
  document.querySelector(".menu")?.remove();
  const menu = h("div.menu", { role: "menu" });
  for (const item of items) {
    if (item === "-") { menu.append(h("hr")); continue; }
    menu.append(h(`button${item.danger ? ".danger" : ""}`, { role: "menuitem", onclick: () => { menu.remove(); item.run(); } }, item.icon ? icon(item.icon) : null, item.label));
  }
  document.body.append(menu);
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 8)}px`;
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); removeEventListener("pointerdown", close, true); } };
  setTimeout(() => addEventListener("pointerdown", close, true));
  addEventListener("keydown", (e) => { if (e.key === "Escape") menu.remove(); }, { once: true });
  menu.querySelector("button")?.focus();
}

/** Ask the background script to do something. */
export const background = (type, payload = {}) => browser.runtime.sendMessage({ to: "background", type, ...payload });

export function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** React to the dock this page lives in: rail when narrow. */
export function watchDockWidth(onRail) {
  const media = matchMedia("(max-width: 120px)");
  const apply = () => { document.documentElement.toggleAttribute("data-rail", media.matches); onRail?.(media.matches); };
  media.addEventListener("change", apply);
  apply();
}

/**
 * A dropdown drawn in the page (a native <select> opens an OS popup window,
 * which some compositors frame oddly). Returns a button element with
 * `.value` getter/setter; `onChange(value)` runs on a pick.
 */
export function dropdown(options, value, onChange, { label = "", width } = {}) {
  let current = value;
  const text = () => options.find(([v]) => String(v) === String(current))?.[1] ?? String(current);
  const button = h("button.btn.dropdown", { type: "button", title: label, "aria-label": label, "aria-haspopup": "menu", style: width ? { minWidth: `${width}px` } : {} });
  const draw = () => button.replaceChildren(h("span", {}, text()), icon("keyboard_arrow_down", { size: 16 }));
  draw();
  button.addEventListener("click", () => {
    const rect = button.getBoundingClientRect();
    contextMenu({ preventDefault() {}, clientX: rect.left, clientY: rect.bottom + 4 }, options.map(([v, name]) => ({
      label: name, icon: String(v) === String(current) ? "check" : undefined,
      run: () => { current = v; draw(); onChange(v); },
    })));
  });
  Object.defineProperty(button, "value", { get: () => current, set: (v) => { current = v; draw(); } });
  return button;
}
