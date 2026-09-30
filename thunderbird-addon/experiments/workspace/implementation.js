/* Mail Workspace Experiment: the privileged half of the add-on. Layout lives in
   layout.js, GUI state and automation in automation.js; both are loaded into
   this scope so they share helpers without globals leaking into Thunderbird. */
/* global ExtensionAPI */
var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");
var { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");

const MESSENGER = "chrome://messenger/content/messenger.xhtml";
const RESOURCE_HOST = "mailworkspace";

var workspace = class extends ExtensionAPI {
  onStartup() {
    const resProto = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
    resProto.setSubstitutionWithFlags(RESOURCE_HOST, this.extension.rootURI, resProto.ALLOW_CONTENT_ACCESS);
    this.scope = { Services, ChromeUtils, Ci, Cc, Cu, ExtensionParent, console };
    for (const file of ["layout.js", "automation.js"]) {
      // Through resource://, which is trusted also when the add-on runs from a folder.
      Services.scriptloader.loadSubScript(`resource://${RESOURCE_HOST}/experiments/workspace/${file}?${Date.now()}`, this.scope);
    }
    this.listeners = { dock: new Set(), shortcut: new Set() };
    this.sheetUrl = `resource://${RESOURCE_HOST}/theme/chrome.css`;
    this.paneSheetUrl = `resource://${RESOURCE_HOST}/theme/panes.css`;
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;
    ExtensionSupport.unregisterWindowListener(`${this.extension.id}-workspace`);
    this.scope?.removeTheme?.(this.paneSheetUrl);
    for (const window of ExtensionSupport.openWindows) {
      if (window.location.href === MESSENGER) this.scope?.removeLayout?.(window, this.sheetUrl);
    }
    Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution(RESOURCE_HOST, null);
    // Our subscripts may be cached; a reload must pick up the new files.
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }

  messengerWindows() {
    return [...ExtensionSupport.openWindows].filter((window) => window.location.href === MESSENGER && window.document.readyState !== "uninitialized");
  }

  mainWindow() {
    return Services.wm.getMostRecentWindow("mail:3pane");
  }

  getAPI(context) {
    const self = this;
    const scope = this.scope;

    const emitDock = (dock) => { for (const listener of self.listeners.dock) listener(dock); };
    const update = (side, change) => {
      const dock = scope.readDock(side);
      if (change.state === "toggle") dock.state = dock.state === "open" ? "minimized" : "open";
      else if (change.state) dock.state = change.state;
      if (Number.isInteger(change.width)) dock.width = Math.max(scope.MIN_WIDTH, change.width);
      // Maximizing one dock takes the whole area, so the other one cannot also be maximized.
      if (dock.state === "maximized") {
        const other = scope.readDock(side === "left" ? "right" : "left");
        if (other.state === "maximized") { other.state = "open"; scope.writeDock(other); for (const w of self.messengerWindows()) scope.applyDock(w, other); emitDock(other); }
      }
      scope.writeDock(dock);
      for (const window of self.messengerWindows()) scope.applyDock(window, dock);
      emitDock(dock);
      return dock;
    };

    return {
      workspace: {
        async install({ leftUrl, rightUrl }) {
          const ctx = {
            extension: self.extension,
            leftUrl,
            rightUrl,
            sheetUrl: self.sheetUrl,
            update,
            shortcut: (name) => { for (const listener of self.listeners.shortcut) listener(name); },
          };
          const apply = (window) => {
            const run = () => { try { scope.applyLayout(window, ctx); } catch (error) { console.error("Mail Workspace layout failed", error); } };
            if (window.document.getElementById("tabmail")) run();
            else window.addEventListener("load", run, { once: true });
          };
          ExtensionSupport.registerWindowListener(`${self.extension.id}-workspace`, { chromeURLs: [MESSENGER], onLoadWindow: apply });
          for (const window of self.messengerWindows()) apply(window);
          scope.installTheme(self.paneSheetUrl, self.messengerWindows());
          scope.preparePrefs();
          return true;
        },
        async getDocks() { return [scope.readDock("left"), scope.readDock("right")]; },
        async setDock(side, change) { return update(side, change); },
        async openSpace(name) { return scope.openSpace(self.mainWindow(), name); },
        async getState() { return scope.getState(self.mainWindow(), [scope.readDock("left"), scope.readDock("right")]); },
        async snapshot(options = {}) { return scope.snapshot(self.mainWindow(), options); },
        async act(ref, action, value, options = {}) { return scope.act(self.mainWindow(), ref, action, value, options); },
        async pressKey(combo, options = {}) { return scope.pressKey(self.mainWindow(), combo, options); },
        async screenshot(options = {}) { return scope.screenshot(self.mainWindow(), options); },
        async selectMail(folderUri, messageKeys) { return scope.selectMail(self.mainWindow(), folderUri, messageKeys); },
        async calendarGoto(date, view) { return scope.calendarGoto(self.mainWindow(), date, view); },
        async focusOwnTab() { for (const window of self.messengerWindows()) scope.markTabs(window, self.extension); return true; },
        onDockChanged: new ExtensionCommon.EventManager({
          context,
          name: "workspace.onDockChanged",
          register(fire) {
            const listener = (dock) => fire.async(dock);
            self.listeners.dock.add(listener);
            return () => self.listeners.dock.delete(listener);
          },
        }).api(),
        onShortcut: new ExtensionCommon.EventManager({
          context,
          name: "workspace.onShortcut",
          register(fire) {
            const listener = (name) => fire.async(name);
            self.listeners.shortcut.add(listener);
            return () => self.listeners.shortcut.delete(listener);
          },
        }).api(),
      },
    };
  }
};
