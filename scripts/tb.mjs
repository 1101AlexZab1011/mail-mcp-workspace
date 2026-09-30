#!/usr/bin/env node
// Development driver for Thunderbird through Marionette (start Thunderbird with
// `--marionette`). It runs scripts in the main window's chrome context, takes
// screenshots, and installs the add-on from its source folder as a temporary
// add-on, so a change can be tried without packaging or restarting.
//
//   node scripts/tb.mjs eval '<js returning a value>'   run in the messenger window
//   node scripts/tb.mjs shot <file.png> [css selector]  screenshot (window or element)
//   node scripts/tb.mjs install [dir]                   (re)install the add-on temporarily
//   node scripts/tb.mjs restart                         restart Thunderbird with Marionette
import { connect } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PORT = Number(process.env.MARIONETTE_PORT ?? 2828);
const THUNDERBIRD = process.env.THUNDERBIRD ?? `${process.env.HOME}/.local/opt/thunderbird/thunderbird`;

class Marionette {
  constructor() { this.id = 0; this.pending = new Map(); this.buffer = Buffer.alloc(0); }

  open() {
    return new Promise((resolveOpen, reject) => {
      this.socket = connect(PORT, "127.0.0.1");
      let greeted = false;
      this.socket.on("error", reject);
      this.socket.on("data", (chunk) => {
        // The length prefix counts bytes, so frame on bytes and decode after.
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
          const colon = this.buffer.indexOf(58); // ":"
          if (colon < 0) return;
          const length = Number(this.buffer.subarray(0, colon).toString());
          if (this.buffer.length < colon + 1 + length) return;
          const message = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString("utf8"));
          this.buffer = this.buffer.subarray(colon + 1 + length);
          if (!greeted) { greeted = true; resolveOpen(); continue; }
          const [, id, error, result] = message;
          const waiter = this.pending.get(id);
          this.pending.delete(id);
          if (error) waiter?.reject(new Error(`${error.error}: ${error.message}`));
          else waiter?.resolve(result);
        }
      });
    });
  }

  send(name, params = {}) {
    const id = ++this.id;
    const body = JSON.stringify([0, id, name, params]);
    this.socket.write(`${Buffer.byteLength(body)}:${body}`);
    return new Promise((resolveSend, reject) => this.pending.set(id, { resolve: resolveSend, reject }));
  }

  async session() {
    await this.send("WebDriver:NewSession", { capabilities: { alwaysMatch: { "moz:webdriverClick": false } } });
    await this.send("Marionette:SetContext", { value: "chrome" });
    // Switch to the main messenger window (a compose or dialog window may be on top).
    const handles = await this.send("WebDriver:GetWindowHandles");
    for (const handle of handles) {
      await this.send("WebDriver:SwitchToWindow", { handle, focus: false });
      const url = await this.send("WebDriver:ExecuteScript", { script: "return window.location.href", args: [] });
      if (url.value === "chrome://messenger/content/messenger.xhtml") return;
    }
  }

  close() { this.socket.end(); }
}

async function withSession(fn) {
  const m = new Marionette();
  await m.open();
  await m.session();
  try { return await fn(m); } finally { await m.send("WebDriver:DeleteSession").catch(() => {}); m.close(); }
}

/** Check the new main window's class; quit Thunderbird at once if it would land elsewhere. */
async function verifyClass(expected) {
  if (!expected) return;
  for (let i = 0; i < 60; i++) {
    let classes = [];
    try {
      const pid = execFileSync("pgrep", ["-x", "thunderbird-bin"], { encoding: "utf8" }).trim().split("\n")[0];
      const windows = execFileSync("xdotool", ["search", "--pid", pid, "--name", "Thunderbird"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      classes = windows.map((w) => execFileSync("xprop", ["-id", w, "WM_CLASS"], { encoding: "utf8" }));
    } catch { /* not up yet */ }
    const main = classes.find((c) => /"Mail"/.test(c));
    if (main) {
      if (main.includes(`"${expected}"`)) return;
      try { execFileSync("pkill", ["-KILL", "-x", "thunderbird-bin"]); } catch { /* gone */ }
      throw new Error(`wrong window class (${main.trim()}); Thunderbird was stopped`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "eval") {
  const script = args[0].includes("return") ? args[0] : `return (${args[0]})`;
  const result = await withSession((m) => m.send("WebDriver:ExecuteAsyncScript", {
    script: `const done = arguments[arguments.length - 1]; (async () => { ${script} })().then((v) => done({ ok: v }), (e) => done({ error: String(e && e.stack || e) }));`,
    args: [], scriptTimeout: 60000,
  }));
  console.log(JSON.stringify(result.value, null, 2));
} else if (command === "shot") {
  const [file, selector] = args;
  const png = await withSession(async (m) => {
    let element;
    if (selector) {
      const found = await m.send("WebDriver:FindElement", { using: "css selector", value: selector });
      element = found.value;
    }
    return (await m.send("WebDriver:TakeScreenshot", { ...(element ? { id: element[Object.keys(element)[0]] } : {}), full: false })).value;
  });
  await writeFile(file, Buffer.from(png, "base64"));
  console.log(file);
} else if (command === "install") {
  const dir = resolve(args[0] ?? new URL("../thunderbird-addon", import.meta.url).pathname);
  const result = await withSession((m) => m.send("Addon:Install", { path: dir, temporary: true }));
  console.log(JSON.stringify(result));
} else if (command === "restart" || command === "quit") {
  // Quit cleanly through Marionette when it is listening; a TERM signal can
  // crash a Marionette-driven instance during shutdown.
  const graceful = await (async () => {
    try {
      const m = new Marionette();
      await m.open();
      await m.session();
      m.send("WebDriver:ExecuteScript", { script: "Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit); return 1", args: [] }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      m.close();
      return true;
    } catch { return false; }
  })();
  if (!graceful) { try { execFileSync("pkill", ["-TERM", "-x", "thunderbird-bin"]); } catch { /* not running */ } }
  const running = () => { try { execFileSync("pgrep", ["-x", "thunderbird-bin"]); return true; } catch { return false; } };
  for (let i = 0; i < 60 && running(); i++) await new Promise((r) => setTimeout(r, 500));
  // Never launch while an old instance lives: Thunderbird would hand the launch
  // to it and drop our arguments (the window class among them).
  if (running()) { console.error("Thunderbird is still running; not starting a second one"); process.exit(1); }
  // TB_WM_CLASS sets the X window class, so a window-manager rule can place the
  // window: e.g. dwm's `RULE(.class = "Firefox", .tags = 1 << 7)` puts it on tag 8.
  // Default "Firefox": the user's dwm rule puts that class on tag 8, the desktop
  // reserved for this work. Set TB_WM_CLASS="" to launch with Thunderbird's own class.
  const wmClassName = process.env.TB_WM_CLASS ?? "Firefox";
  const wmClass = wmClassName ? ["--class", wmClassName] : [];
  if (command === "quit") process.exit(0);
  // PLAIN=1 starts Thunderbird normally, without the Marionette remote port.
  const plain = process.env.PLAIN === "1";
  if (plain) {
    spawn(THUNDERBIRD, [...wmClass], { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":0" } }).unref();
    await verifyClass(wmClassName);
    console.log("started");
    process.exit(0);
  }
  spawn(THUNDERBIRD, [...wmClass, "--marionette", "-remote-allow-system-access"], { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":0" } }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const m = new Marionette(); await m.open(); m.close(); await verifyClass(wmClassName); console.log("ready"); process.exit(0); } catch (error) { if (error.message?.startsWith("wrong window class")) throw error; }
  }
  console.error("Marionette did not come up");
  process.exit(1);
} else {
  console.error("usage: tb.mjs eval <js> | shot <file> [selector] | install [dir] | restart");
  process.exit(2);
}
