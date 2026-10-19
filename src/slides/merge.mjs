// Three-way merge of decks: the version both sides started from (base), the editor's (mine) and the
// file's (theirs, e.g. after the agent or another program wrote it). Slides and elements are matched
// by id and merged property by property, so the user moving a box while the agent rewrites its text
// is no conflict. When both changed the same property differently, mine wins and it is reported.

/** JSON with sorted keys, for comparing values regardless of key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
const same = (a, b) => canonical(a) === canonical(b);

function mergeValue(base, mine, theirs, path, conflicts) {
  if (same(mine, theirs)) return mine;
  if (same(base, mine)) return theirs;
  if (same(base, theirs)) return mine;
  conflicts.push(path);
  return mine;
}

/** Key-wise merge of two objects; `nested` names keys merged recursively by a given function. */
function mergeObject(base = {}, mine = {}, theirs = {}, path, conflicts, nested = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base)])) {
    const value = nested[key]
      ? nested[key](base[key], mine[key], theirs[key], `${path}.${key}`, conflicts)
      : mergeValue(base[key], mine[key], theirs[key], `${path}.${key}`, conflicts);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Order of the merged list: one side's order (the side that reordered), plus items only the other side has. */
function mergeOrder(baseIds, mineIds, theirsIds, keep) {
  const changed = (ids) => !same(baseIds.filter(keep), ids.filter(keep));
  const [primary, secondary] = changed(mineIds) || !changed(theirsIds) ? [mineIds, theirsIds] : [theirsIds, mineIds];
  const order = primary.filter(keep);
  for (const [i, id] of secondary.entries()) {
    if (!keep(id) || order.includes(id)) continue;
    const before = secondary.slice(0, i).reverse().find((other) => order.includes(other));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  }
  return order;
}

/** Merge lists of objects with ids. Deleted on one side and untouched on the other: deleted. */
function mergeList(base = [], mine = [], theirs = [], path, conflicts, mergeItem) {
  const byId = (list) => new Map(list.map((item) => [item.id, item]));
  const b = byId(base), m = byId(mine), t = byId(theirs);
  const keep = (id) => {
    const inBase = b.has(id), inMine = m.has(id), inTheirs = t.has(id);
    if (!inBase) return inMine || inTheirs;               // added on one side (or both)
    if (inMine && inTheirs) return true;
    const survivor = inMine ? m.get(id) : inTheirs ? t.get(id) : null;
    if (!survivor) return false;                          // deleted on both sides
    if (same(survivor, b.get(id))) return false;          // deleted on one side, untouched on the other
    conflicts.push(`${path}[${id}] deleted on one side, changed on the other`);
    return true;                                          // keep the edited one
  };
  const order = mergeOrder(base.map((x) => x.id), mine.map((x) => x.id), theirs.map((x) => x.id), keep);
  return order.map((id) => {
    if (m.has(id) && t.has(id)) return mergeItem(b.get(id), m.get(id), t.get(id), `${path}[${id}]`, conflicts);
    return m.get(id) ?? t.get(id);
  });
}

const mergeElement = (base, mine, theirs, path, conflicts) => mergeObject(base, mine, theirs, path, conflicts);
const mergeSlide = (base, mine, theirs, path, conflicts) => mergeObject(base, mine, theirs, path, conflicts, {
  elements: (b, m, t, p, c) => mergeList(b, m, t, p, c, mergeElement),
});

/** Returns { deck, conflicts }: conflicts lists the paths where both sides changed the same thing (mine kept). */
export function mergeDecks(base, mine, theirs) {
  const conflicts = [];
  const deck = mergeObject(base, mine, theirs, "deck", conflicts, {
    slides: (b, m, t, p, c) => mergeList(b, m, t, p, c, mergeSlide),
    theme: (b, m, t, p, c) => mergeObject(b, m, t, p, c),
    // Custom transitions and effects merge by name (each definition as a whole).
    motion: (b, m, t, p, c) => mergeObject(b, m, t, p, c, {
      transitions: (b2, m2, t2, p2, c2) => mergeObject(b2, m2, t2, p2, c2),
      effects: (b2, m2, t2, p2, c2) => mergeObject(b2, m2, t2, p2, c2),
    }),
  });
  if (!deck.slides?.length) deck.slides = mine.slides;
  return { deck, conflicts };
}
