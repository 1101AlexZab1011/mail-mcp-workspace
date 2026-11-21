// Loom's commit graph: rows of commits with the lanes drawn beside them as one SVG, the way GitKraken
// shows a repository. The host lays out the lanes (src/workspace/git.mjs, layoutGraph); this draws
// them: a dot per commit in its lane, and for each parent a line that leaves the commit, runs down
// the parent's lane and, if that lane ends at the parent, bends into it.
import { h } from "../shared/page.js";
import { icon } from "../shared/icons.js";


export const ROW = 30;
const LANE = 16;
const PAD = 14;
const SVG_NS = "http://www.w3.org/2000/svg";
const laneColor = (lane) => `var(--lane-${lane % 8})`;
const x = (lane) => PAD + lane * LANE;
const y = (row) => row * ROW + ROW / 2;

const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
};

/** A short, readable date: time today, weekday this week, else the date. */
export function shortDate(iso) {
  const date = new Date(iso);
  const now = new Date();
  const days = (now - date) / 86_400_000;
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days < 6) return date.toLocaleDateString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/**
 * A ref as a chip: local branches in their lane's colour (the checked-out one filled), remote
 * branches outlined, tags in amber. `extra` adds chips (Loom puts a running plan's stage here).
 */
export function refChip(ref, { lane = 0, current = false, merged = null } = {}) {
  const kind = ref.kind;
  const glyph = { branch: "call_split", remote: "cloud_download", tag: "label" }[kind];
  // `merged`: the main line this branch is already in; the chip fades and says so.
  return h(`span.ref.${kind}${current ? ".current" : ""}${merged ? ".merged" : ""}`, { style: { "--lane": laneColor(lane) }, title: merged ? `${ref.name}: merged into ${merged}` : ref.name },
    glyph ? icon(glyph) : null, h("span.name", {}, ref.name), merged ? icon("check") : null);
}

/**
 * Draw `graph` ({ commits, lanes, more }). `head` is the checked-out branch name (its chip is filled),
 * `selected` a sha, `names` each commit's branch (branchesOf), `merged` the ref names already in the
 * `mainline` branch. Callbacks: onSelect(commit),
 * onContext(event, commit, ref?), onMore(). `decorate(commit)` returns extra chips for a row (plans on
 * its branches). The result's `showLanes(scrollTop)` labels the lanes crossing the top edge.
 */
export function renderGraph(graph, { head, headSha, selected, names = new Map(), merged = new Set(), mainline = null, onSelect, onContext, onMore, decorate = () => [] }) {
  const { commits } = graph;
  const rowOf = new Map(commits.map((commit, row) => [commit.sha, row]));
  const width = PAD * 2 + Math.max(graph.lanes - 1, 0) * LANE;
  const height = commits.length * ROW;
  const drawing = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
  const lines = svg("g");
  const dots = svg("g");
  drawing.append(lines, dots);

  commits.forEach((commit, row) => {
    for (const edge of commit.edges) {
      const parentRow = rowOf.get(edge.parent);
      const parentLane = parentRow === undefined ? edge.to : commits[parentRow].lane;
      const x1 = x(commit.lane);
      const y1 = y(row);
      const x2 = x(edge.to);
      const yEnd = parentRow === undefined ? height + ROW : y(parentRow);
      // Leave the commit: straight down its own lane, or a bend into a new lane within the row.
      const yTurn = x2 === x1 ? y1 : y1 + ROW;
      // Arrive at the parent: straight in, or a bend from this lane into the parent's in the last row.
      const xEnd = x(parentLane);
      const yBend = xEnd === x2 ? yEnd : yEnd - ROW;
      let d;
      if (yBend < yTurn) d = `M${x1} ${y1} C${x1} ${(y1 + yEnd) / 2} ${xEnd} ${(y1 + yEnd) / 2} ${xEnd} ${yEnd}`;
      else {
        d = `M${x1} ${y1}`;
        if (x2 !== x1) d += ` C${x1} ${y1 + ROW * 0.6} ${x2} ${y1 + ROW * 0.4} ${x2} ${yTurn}`;
        d += ` L${x2} ${yBend}`;
        if (xEnd !== x2) d += ` C${x2} ${yBend + ROW * 0.6} ${xEnd} ${yBend + ROW * 0.4} ${xEnd} ${yEnd}`;
      }
      // A branch leaving is drawn in its new lane's colour; a lane continuing keeps its own.
      lines.append(svg("path", { d, stroke: laneColor(x2 !== x1 ? edge.to : commit.lane) }));
    }
    const merge = commit.parents.length > 1;
    const isHead = commit.sha === headSha;
    if (isHead) dots.append(svg("circle", { cx: x(commit.lane), cy: y(row), r: 8.5, fill: "none", stroke: laneColor(commit.lane), "stroke-width": 2 }));
    dots.append(svg("circle", { cx: x(commit.lane), cy: y(row), r: merge ? 4 : 5.5, fill: merge ? "var(--mw-surface)" : laneColor(commit.lane), stroke: laneColor(commit.lane), "stroke-width": 2 }));
  });

  const rows = commits.map((commit) => {
    const chips = commit.refs.filter((ref) => ref.kind !== "head").map((ref) => {
      const chip = refChip(ref, { lane: commit.lane, current: ref.kind === "branch" && ref.name === head, merged: merged.has(ref.name) ? mainline : null });
      chip.addEventListener("contextmenu", (event) => { event.stopPropagation(); onContext(event, commit, ref); });
      return chip;
    });
    const branch = names.get(commit.sha);
    const row = h("div.commit-row", {
      role: "option", tabindex: "-1", "aria-selected": String(commit.sha === selected), "aria-label": `${commit.subject} · ${commit.sha.slice(0, 7)}${branch ? ` · on ${branch}` : ""}`, dataset: { sha: commit.sha },
      title: branch ? `On ${branch}` : undefined,
      style: { paddingLeft: `${width + 6}px` },
      onclick: () => onSelect(commit),
      oncontextmenu: (event) => onContext(event, commit, null),
    },
      h("div.subject", {}, ...chips, ...decorate(commit), h("span.text", { title: commit.subject }, commit.subject)),
      h("div.author", { title: commit.email }, commit.author),
      h("div.date", { title: new Date(commit.date).toLocaleString() }, shortDate(commit.date)),
      h("div.sha.mono", {}, commit.sha.slice(0, 7)));
    return row;
  });

  // The lines in each lane, with the branch they carry: an edge to a first parent carries the
  // commit's own branch, an edge to a merged parent that parent's.
  const spans = commits.flatMap((commit, row) => commit.edges.map((edge) => ({
    lane: edge.to, from: row, to: rowOf.get(edge.parent) ?? commits.length,
    name: names.get(edge.parent === commit.parents[0] ? commit.sha : edge.parent) ?? null,
  })));
  // Sticky over the graph: once the branch labels have scrolled away, each lane crossing the top
  // edge says which branch it is, in its colour.
  const lanesBar = h("div.lane-bar", { "aria-hidden": "true" });
  const chips = h("div.lane-chips");
  lanesBar.append(chips);
  let shown = "";
  function showLanes(scrollTop) {
    const row = Math.floor(scrollTop / ROW);
    const at = new Map();
    if (scrollTop > ROW / 2 && commits[row]) {
      at.set(commits[row].lane, names.get(commits[row].sha) ?? null);
      for (const span of spans) if (span.from < row && row < span.to && !at.has(span.lane)) at.set(span.lane, span.name);
    }
    const lanes = [...at].filter(([, name]) => name).sort((a, b) => a[0] - b[0]);
    const key = JSON.stringify(lanes);
    if (key === shown) return;
    shown = key;
    chips.replaceChildren(...lanes.map(([lane, name]) => h("span.lane-chip", { style: { "--lane": laneColor(lane) } }, h("span.dot"), name)));
    lanesBar.hidden = !lanes.length;
  }
  showLanes(0);

  const box = h("div.graph", { role: "listbox", "aria-label": "Commits", style: { height: `${height}px` } }, drawing, ...rows);
  const wrap = h("div", {}, lanesBar, box);
  if (graph.more) wrap.append(h("div.graph-more", {}, h("button.btn", { type: "button", onclick: onMore }, "Load more commits")));
  wrap.showLanes = showLanes;
  return wrap;
}
