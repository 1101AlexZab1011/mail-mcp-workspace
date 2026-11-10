// Draw: undo and redo for edits made straight to the SVG document.
//
// An edit is whatever changes the document between begin() and end(): a MutationObserver records
// each attribute change (with the old value) and each node added or removed (with where it was).
// Undo plays the records back in reverse; redo plays them forward again. The editor never has to
// say what it changed, so every tool (and the agent) gets undo for free.

export class History {
  constructor(onChange = () => {}) {
    this.done = [];
    this.undone = [];
    this.onChange = onChange;
    this.pending = null;
    this.depth = 0; // edits inside an edit (an agent's batch) join the outer one
    this.savedAt = 0; // the length of `done` when the file was last read or written
    this.observer = null;
    this.root = null;
  }

  /** Follow a (new) document. The history starts empty. */
  attach(doc) {
    this.observer?.disconnect();
    this.root = doc;
    // Records arrive here when an edit spans several tasks (a drag); end() takes the rest.
    this.observer = new doc.defaultView.MutationObserver((records) => this.pending?.records.push(...records));
    this.done = [];
    this.undone = [];
    this.pending = null;
    this.depth = 0;
    this.savedAt = 0;
    this.onChange();
  }

  begin(label) {
    if (this.pending) { this.depth++; return; }
    this.pending = { label, records: [] };
    this.observer.observe(this.root, { subtree: true, attributes: true, attributeOldValue: true, childList: true, characterData: true, characterDataOldValue: true });
  }

  /** Close the current edit; an edit that changed nothing leaves no step. */
  end() {
    if (!this.pending) return null;
    if (this.depth > 0) { this.depth--; return null; }
    const step = this.pending;
    step.records.push(...this.observer.takeRecords());
    this.observer.disconnect();
    this.pending = null;
    if (!step.records.length) return null;
    step.records = step.records.map(snapshot);
    finishValues(step.records);
    if (this.savedAt > this.done.length) this.savedAt = -1; // the saved state was undone and is now unreachable
    this.done.push(step);
    this.undone = [];
    this.onChange(step);
    return step;
  }

  /** Run `change` as one undoable step. */
  edit(label, change) {
    this.begin(label);
    try { return change(); } finally { this.end(); }
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  get modified() { return this.savedAt !== this.done.length; }
  markSaved() { this.savedAt = this.done.length; this.onChange(); }

  /** Close whatever is open, however deep (before undo and redo). */
  finish() { this.depth = 0; return this.end(); }

  undo() {
    this.finish();
    const step = this.done.pop();
    if (!step) return null;
    for (const record of [...step.records].reverse()) revert(record);
    this.undone.push(step);
    this.onChange(step);
    return step;
  }

  redo() {
    this.finish();
    const step = this.undone.pop();
    if (!step) return null;
    for (const record of step.records) replay(record);
    this.done.push(step);
    this.onChange(step);
    return step;
  }
}

/** A MutationRecord as plain data (the live record's node lists are fine to keep). */
const snapshot = (r) => ({
  type: r.type, target: r.target, name: r.attributeName, ns: r.attributeNamespace, oldValue: r.oldValue,
  added: [...r.addedNodes], removed: [...r.removedNodes], previous: r.previousSibling, next: r.nextSibling,
});

/** Each change also needs its new value (for redo): the old value of the next change to the same thing, or what is there now. */
function finishValues(records) {
  const later = new Map();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === "childList") continue;
    const key = r.type === "attributes" ? `${r.ns ?? ""}|${r.name}` : "#text";
    let byTarget = later.get(r.target);
    if (!byTarget) later.set(r.target, (byTarget = new Map()));
    if (byTarget.has(key)) r.newValue = byTarget.get(key);
    else r.newValue = r.type === "attributes" ? r.target.getAttributeNS(r.ns, r.name) : r.target.data;
    byTarget.set(key, r.oldValue);
  }
}

function setAttribute(target, ns, name, value) {
  if (value === null || value === undefined) target.removeAttributeNS(ns, name);
  else if (ns) target.setAttributeNS(ns, target.lookupPrefix(ns) ? `${target.lookupPrefix(ns)}:${name}` : name, value);
  else target.setAttribute(name, value);
}

function revert(r) {
  if (r.type === "attributes") setAttribute(r.target, r.ns, r.name, r.oldValue);
  else if (r.type === "characterData") r.target.data = r.oldValue;
  else {
    for (const node of r.added) node.remove();
    const before = r.next?.parentNode === r.target ? r.next : null;
    for (const node of r.removed) r.target.insertBefore(node, before);
  }
}

function replay(r) {
  if (r.type === "attributes") setAttribute(r.target, r.ns, r.name, r.newValue);
  else if (r.type === "characterData") r.target.data = r.newValue;
  else {
    for (const node of r.removed) node.remove();
    const before = r.next?.parentNode === r.target ? r.next : null;
    for (const node of r.added) r.target.insertBefore(node, before);
  }
}
