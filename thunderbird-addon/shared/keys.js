// Shortcuts as each system writes them. On macOS ⌘ (Command) does what Ctrl does
// elsewhere; Ctrl+` (the terminal) stays Ctrl there, as ⌘` switches windows.

export const IS_MAC = /^Mac/i.test(globalThis.navigator?.platform ?? "");

/** Ctrl, or ⌘ on macOS: the key that goes with letters for commands. */
export const accel = (event, mac = IS_MAC) => (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

/** "Save (Ctrl+S)" → "Save (⌘S)" on macOS; unchanged elsewhere. */
export function keyHint(text, mac = IS_MAC) {
  if (!mac || !text) return text;
  return String(text)
    .replace(/Ctrl\+Shift\+(?!`)/g, "⇧⌘")
    .replace(/Ctrl\+Alt\+(?!`)/g, "⌥⌘")
    .replace(/Ctrl\+(?!`)/g, "⌘")
    .replace(/\bAlt\+/g, "⌥")
    .replace(/\bShift\+/g, "⇧");
}

/** On macOS, rewrite shortcut hints in titles and <kbd> as the page builds them. */
export function followKeyHints(root = document, mac = IS_MAC) {
  if (!mac) return;
  const fix = (el) => {
    // Only real changes: setting a title, even to the same text, would wake the observer again.
    for (const name of ["title", "aria-label"]) {
      const value = el.getAttribute?.(name);
      if (value?.includes("+") && keyHint(value, true) !== value) el.setAttribute(name, keyHint(value, true));
    }
    if (el.localName === "kbd" && keyHint(el.textContent, true) !== el.textContent) el.textContent = keyHint(el.textContent, true);
  };
  const pass = (node) => { if (node.nodeType !== 1) return; fix(node); for (const el of node.querySelectorAll("[title], [aria-label], kbd")) fix(el); };
  pass(root.documentElement ?? root);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") fix(record.target);
      else for (const node of record.addedNodes) pass(node);
    }
  }).observe(root.documentElement ?? root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title", "aria-label"] });
}
