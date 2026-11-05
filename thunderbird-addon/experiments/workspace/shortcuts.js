/* Firefox's keyboard shortcuts (as on Linux) for the Browser's web tabs. A plain script: the Experiment
   loads it into its scope, and the tests load it with node:vm. */

/**
 * A key event in a web tab → the Firefox command it means, or null to leave the key to the page and
 * Thunderbird. Commands: address, new-tab, close-tab, reopen-tab, next-tab, previous-tab, tab (with
 * `index`, -1 for the last), back, forward, home, reload, hard-reload, stop, find, find-next,
 * find-previous, print, view-source, save-page, history, downloads.
 */
function webShortcut({ key, code, ctrlKey = false, shiftKey = false, altKey = false, metaKey = false }) {
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
