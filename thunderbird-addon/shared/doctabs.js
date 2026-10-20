// Editor tabs, the VS Code way: every open file keeps its tab; a dot marks unsaved changes (the close
// button shows on hover); Ctrl+S saves; closing a modified tab asks Save / Don't Save / Cancel.
// Open tabs come back after a reload, and so do unsaved changes (drafts in browser.storage.local).
//
// The page supplies an adapter:
//   load(tab, draft?)   read tab.path (or start a new document) into the tab; restore a draft if given
//   show(tab) / hide(tab)   make the tab's document the visible one / stash it
//   save(tab)           write it; resolve true when saved (false: cancelled or failed)
//   draft(tab)          a JSON-able snapshot of unsaved changes (for drafts)
//   dispose(tab)        free what the tab holds
//   untitled?           a title for new, unsaved documents ("Untitled"), if the editor has them
import { h } from "./page.js";
import { icon } from "./icons.js";

const DRAFT_DELAY = 1200;
let nextId = 1;
const nameOf = (path) => path?.split("/").pop() ?? "";
const dirOf = (path) => path?.replace(/\/[^/]+$/, "") ?? "";

export class DocTabs {
  constructor({ page, mount, adapter, icon: tabIcon = "description", onEmpty = () => {}, onChange = () => {} }) {
    this.page = page;
    this.adapter = adapter;
    this.tabIcon = tabIcon;
    this.onEmpty = onEmpty;
    this.onChange = onChange;
    this.tabs = [];
    this.active = null;
    this.bar = h("div.dt-bar", { role: "tablist" });
    this.bar.addEventListener("wheel", (e) => { if (e.deltaY) { this.bar.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    mount.replaceChildren(this.bar);
    this.draftTimers = new Map();
  }

  // ------------------------------------------------------------ opening --

  find(path) { return this.tabs.find((tab) => tab.path === path); }

  /** Open a file in a tab (or switch to its tab). */
  async open(path, { activate = true, draft, append = false } = {}) {
    const existing = this.find(path);
    if (existing) { if (activate) await this.activate(existing); return existing; }
    const tab = { id: `t${nextId++}`, path, title: nameOf(path), dirty: false };
    try { await this.adapter.load(tab, draft ?? await this.readDraft(tab)); }
    catch (error) { this.adapter.dispose?.(tab); throw error; }
    const at = this.active && !append ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    if (activate || !this.active) await this.activate(tab);
    else this.render();
    this.persist();
    return tab;
  }

  /** A new, unsaved document (editors with untitled documents only). */
  async openNew(draft) {
    const used = new Set(this.tabs.filter((t) => !t.path).map((t) => t.title));
    let n = 1;
    while (used.has(`${this.adapter.untitled ?? "Untitled"}-${n}`)) n++;
    const tab = { id: `t${nextId++}`, path: null, title: `${this.adapter.untitled ?? "Untitled"}-${n}`, dirty: false };
    await this.adapter.load(tab, draft);
    this.tabs.splice(this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length, 0, tab);
    await this.activate(tab);
    this.persist();
    return tab;
  }

  async activate(tab) {
    if (this.active === tab) { this.render(); return; }
    if (this.active) await this.adapter.hide?.(this.active);
    this.active = tab;
    await this.adapter.show(tab);
    this.render();
    this.persist();
    this.onChange();
  }

  // ---------------------------------------------------------- modified --

  /** Mark a tab modified (or not); modified tabs keep a draft so a reload loses nothing. */
  setDirty(tab, dirty) {
    if (!tab) return;
    if (!dirty && !tab.dirty) return;
    if (tab.dirty !== dirty) {
      tab.dirty = dirty;
      this.render();
      this.onChange();
    }
    clearTimeout(this.draftTimers.get(tab.id));
    if (dirty) this.draftTimers.set(tab.id, setTimeout(() => void this.writeDraft(tab), DRAFT_DELAY));
    else void this.dropDraft(tab);
  }

  /** A modified tab changed again: its draft is written once the changes pause. */
  touch(tab) {
    if (!tab?.dirty) return;
    clearTimeout(this.draftTimers.get(tab.id));
    this.draftTimers.set(tab.id, setTimeout(() => void this.writeDraft(tab), DRAFT_DELAY));
  }

  /** After a save: the tab may have a (new) path. */
  saved(tab) {
    tab.title = nameOf(tab.path) || tab.title;
    this.setDirty(tab, false);
    this.persist();
  }

  async save(tab = this.active) {
    if (!tab) return false;
    const ok = await this.adapter.save(tab);
    if (ok) this.saved(tab);
    return ok;
  }

  async saveAll() {
    for (const tab of this.tabs.filter((t) => t.dirty)) if (!(await this.save(tab))) return false;
    return true;
  }

  // ------------------------------------------------------------ closing --

  /** Close a tab; a modified one asks first. Resolves false when the user cancels. */
  async close(tab = this.active) {
    if (!tab) return true;
    if (tab.dirty) {
      if (this.active !== tab) await this.activate(tab);
      const choice = await confirmClose(tab.title);
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this.save(tab))) return false;
    }
    clearTimeout(this.draftTimers.get(tab.id));
    await this.dropDraft(tab);
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    if (this.active === tab) {
      await this.adapter.hide?.(tab);
      this.active = null;
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      if (next) await this.activate(next);
    }
    this.adapter.dispose?.(tab);
    this.render();
    this.persist();
    if (!this.tabs.length) this.onEmpty();
    this.onChange();
    return true;
  }

  async closeOthers(keep) {
    for (const tab of this.tabs.filter((t) => t !== keep)) if (!(await this.close(tab))) return;
  }

  // ------------------------------------------------------- persistence --

  get storageKey() { return `${this.page}.tabs`; }
  draftKey(tab) { return `${this.page}.draft.${tab.path ?? tab.id}`; }

  persist() {
    const files = this.tabs.filter((t) => t.path).map((t) => t.path);
    const untitled = this.tabs.filter((t) => !t.path).map((t) => t.id);
    void browser.storage.local.set({ [this.storageKey]: { files, untitled, active: this.active?.path ?? this.active?.id ?? null } }).catch(() => {});
  }

  async writeDraft(tab) {
    if (!tab.dirty || !this.tabs.includes(tab)) return;
    try {
      const data = await this.adapter.draft(tab);
      await browser.storage.local.set({ [this.draftKey(tab)]: { title: tab.title, path: tab.path, at: Date.now(), data } });
    } catch (error) { console.warn("Mail Workspace: draft not kept", error); }
  }

  async readDraft(tab) {
    const key = this.draftKey(tab);
    const stored = await browser.storage.local.get(key).catch(() => ({}));
    return stored[key]?.data;
  }

  async dropDraft(tab) {
    await browser.storage.local.remove(this.draftKey(tab)).catch(() => {});
  }

  /** Reopen the tabs of the last session, with their unsaved changes. */
  async restore() {
    const { [this.storageKey]: saved } = await browser.storage.local.get(this.storageKey).catch(() => ({}));
    if (!saved) return false;
    for (const path of saved.files ?? []) {
      try { await this.open(path, { activate: false, append: true }); } catch { /* moved or deleted since */ }
    }
    for (const id of saved.untitled ?? []) {
      const key = `${this.page}.draft.${id}`;
      const stored = (await browser.storage.local.get(key).catch(() => ({})))[key];
      await browser.storage.local.remove(key).catch(() => {});
      if (stored?.data) {
        const tab = await this.openNew(stored.data);
        tab.title = stored.title ?? tab.title;
        this.setDirty(tab, true);
      }
    }
    const active = this.tabs.find((t) => t.path === saved.active || t.id === saved.active) ?? this.tabs[0];
    if (active) await this.activate(active);
    this.persist();
    return this.tabs.length > 0;
  }

  // ------------------------------------------------------------- render --

  render() {
    const names = new Map();
    for (const tab of this.tabs) names.set(tab.title, (names.get(tab.title) ?? 0) + 1);
    this.bar.replaceChildren(...this.tabs.map((tab) => {
      const same = names.get(tab.title) > 1 && tab.path;
      const close = h("button.dt-close", {
        type: "button", title: tab.dirty ? "Unsaved changes · close" : "Close",
        onclick: (e) => { e.stopPropagation(); void this.close(tab); },
      }, h("span.dt-dot"), icon("close", { size: 14 }));
      const el = h(`div.dt-tab${tab === this.active ? ".active" : ""}${tab.dirty ? ".dirty" : ""}`, {
        role: "tab", "aria-selected": String(tab === this.active), title: tab.path ?? `${tab.title} (not saved yet)`, draggable: "true",
        onclick: () => void this.activate(tab),
        onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); void this.close(tab); } },
        onmousedown: (e) => { if (e.button === 1) e.preventDefault(); },
        ondragstart: (e) => { e.dataTransfer.setData("text/x-dt-tab", tab.id); e.dataTransfer.effectAllowed = "move"; },
        ondragover: (e) => { if (e.dataTransfer.types.includes("text/x-dt-tab")) { e.preventDefault(); el.classList.add("drop"); } },
        ondragleave: () => el.classList.remove("drop"),
        ondrop: (e) => {
          el.classList.remove("drop");
          const moved = this.tabs.find((t) => t.id === e.dataTransfer.getData("text/x-dt-tab"));
          if (!moved || moved === tab) return;
          this.tabs.splice(this.tabs.indexOf(moved), 1);
          this.tabs.splice(this.tabs.indexOf(tab), 0, moved);
          this.render();
          this.persist();
        },
      }, icon(this.tabIcon, { size: 15 }), h("span.dt-name", {}, tab.title), same ? h("span.dt-dir", {}, dirOf(tab.path).split("/").pop()) : null, close);
      el.addEventListener("contextmenu", (e) => this.menu(e, tab));
      return el;
    }));
    this.active && this.bar.querySelector(".dt-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  menu(event, tab) {
    event.preventDefault();
    import("./page.js").then(({ contextMenu }) => contextMenu(event, [
      { label: "Close", icon: "close", run: () => void this.close(tab) },
      { label: "Close others", icon: "close", run: () => void this.closeOthers(tab) },
      "-",
      ...(tab.path ? [{ label: "Copy path", icon: "content_copy", run: () => navigator.clipboard.writeText(tab.path) }] : []),
      ...(tab.dirty ? [{ label: "Save", icon: "save", run: () => void this.save(tab) }] : []),
    ]));
  }
}

/** VS Code's question when closing a modified file. Resolves "save" | "discard" | "cancel". */
export function confirmClose(name) {
  return new Promise((resolve) => {
    const done = (choice) => { backdrop.remove(); removeEventListener("keydown", onKey, true); resolve(choice); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done("cancel"); } };
    const save = h("button.btn.primary", { type: "button", onclick: () => done("save") }, "Save");
    const backdrop = h("div.dialog-backdrop", { onclick: (e) => { if (e.target === backdrop) done("cancel"); } },
      h("div.dialog.dt-confirm", { role: "alertdialog" },
        h("h2", {}, `Do you want to save the changes you made to ${name}?`),
        h("p", {}, "Your changes will be lost if you don't save them."),
        h("div.actions", {},
          h("button.btn", { type: "button", onclick: () => done("discard") }, "Don't Save"),
          h("span.spacer"),
          h("button.btn", { type: "button", onclick: () => done("cancel") }, "Cancel"),
          save)));
    addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    save.focus();
  });
}
