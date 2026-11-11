/* Firefox's keyboard shortcuts for the Browser's web tabs (as on Linux and Windows, or as on macOS),
   and how shortcuts are written per system. A plain script: the Experiment loads it into its scope,
   and the tests load it with node:vm. */

/** Whether Thunderbird runs on macOS, where ⌘ (Command) does what Ctrl does elsewhere. */
function isMac() {
  return typeof Services !== "undefined" && Services.appinfo?.OS === "Darwin";
}

/** Ctrl, or ⌘ on macOS. */
function accelKey(event, mac = isMac()) {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** "Files (Ctrl+6)" → "Files (⌘6)" on macOS. Ctrl+` stays: ⌘` switches windows there. */
function keyHint(text, mac = isMac()) {
  if (!mac || !text) return text;
  return String(text).replace(/Ctrl\+Shift\+(?!`)/g, "⇧⌘").replace(/Ctrl\+Alt\+(?!`)/g, "⌥⌘").replace(/Ctrl\+(?!`)/g, "⌘").replace(/\bAlt\+/g, "⌥").replace(/\bShift\+/g, "⇧");
}

/**
 * A key event in a web tab → the Firefox command it means, or null to leave the key to the page and
 * Thunderbird. Commands: address, new-tab, close-tab, reopen-tab, next-tab, previous-tab, tab (with
 * `index`, -1 for the last), back, forward, home, reload, hard-reload, stop, find, find-next,
 * find-previous, print, view-source, save-page, history, downloads.
 */
function webShortcut(event, mac = isMac()) {
  if (mac) return macWebShortcut(event);
  const { key, code, ctrlKey = false, shiftKey = false, altKey = false, metaKey = false } = event;
  if (metaKey) return null;
  const ctrl = ctrlKey && !altKey;
  const alt = altKey && !ctrlKey;
  const none = !ctrlKey && !altKey;
  const letter = /^Key[A-Z]$/.test(code ?? "") ? code[3] : null;
  if (ctrl && !shiftKey) {
    switch (letter) {
      case "L": case "K": case "E": return { command: "address" };
      case "T": return { command: "new-tab" };
      case "W": return { command: "close-tab" };
      case "R": return { command: "reload" };
      case "F": return { command: "find" };
      case "G": return { command: "find-next" };
      case "P": return { command: "print" };
      case "U": return { command: "view-source" };
      case "S": return { command: "save-page" };
      case "H": return { command: "history" };
    }
    if (key === "F4") return { command: "close-tab" };
    if (key === "F5") return { command: "hard-reload" };
    if (key === "Tab" || key === "PageDown") return { command: "next-tab" };
    if (key === "PageUp") return { command: "previous-tab" };
  }
  if (ctrl && shiftKey) {
    if (letter === "T") return { command: "reopen-tab" };
    if (letter === "R") return { command: "hard-reload" };
    if (letter === "G") return { command: "find-previous" };
    if (letter === "Y") return { command: "downloads" };
    if (key === "Tab") return { command: "previous-tab" };
  }
  if (alt && !shiftKey) {
    if (letter === "D") return { command: "address" };
    if (key === "ArrowLeft") return { command: "back" };
    if (key === "ArrowRight") return { command: "forward" };
    if (key === "Home") return { command: "home" };
    const digit = /^Digit([1-9])$/.exec(code ?? "");
    if (digit) return { command: "tab", index: digit[1] === "9" ? -1 : Number(digit[1]) - 1 };
  }
  if (none) {
    if (key === "F6" && !shiftKey) return { command: "address" };
    if (key === "F5") return { command: shiftKey ? "hard-reload" : "reload" };
    if (key === "F3") return { command: shiftKey ? "find-previous" : "find-next" };
    if (key === "Escape" && !shiftKey) return { command: "stop" };
  }
  return null;
}

/** As Firefox does it on macOS. ⌘1…9 stay Thunderbird's space shortcuts. */
function macWebShortcut({ key, code, ctrlKey = false, shiftKey = false, altKey = false, metaKey = false }) {
  const letter = /^Key[A-Z]$/.test(code ?? "") ? code[3] : null;
  const cmd = metaKey && !ctrlKey && !altKey;
  if (cmd && !shiftKey) {
    switch (letter) {
      case "L": return { command: "address" };
      case "T": return { command: "new-tab" };
      case "W": return { command: "close-tab" };
      case "R": return { command: "reload" };
      case "F": return { command: "find" };
      case "G": return { command: "find-next" };
      case "P": return { command: "print" };
      case "S": return { command: "save-page" };
      case "Y": return { command: "history" };
    }
    if (code === "BracketLeft" || key === "ArrowLeft") return { command: "back" };
    if (code === "BracketRight" || key === "ArrowRight") return { command: "forward" };
  }
  if (cmd && shiftKey) {
    if (letter === "T") return { command: "reopen-tab" };
    if (letter === "R") return { command: "hard-reload" };
    if (letter === "G") return { command: "find-previous" };
    if (letter === "H") return { command: "home" };
    if (letter === "J") return { command: "downloads" };
  }
  if (metaKey && altKey && !ctrlKey && !shiftKey) {
    if (letter === "U") return { command: "view-source" };
    if (key === "ArrowRight") return { command: "next-tab" };
    if (key === "ArrowLeft") return { command: "previous-tab" };
  }
  if (ctrlKey && !metaKey && !altKey && key === "Tab") return { command: shiftKey ? "previous-tab" : "next-tab" };
  if (!ctrlKey && !metaKey && !altKey && !shiftKey && key === "Escape") return { command: "stop" };
  return null;
}
