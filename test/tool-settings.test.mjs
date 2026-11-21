import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../thunderbird-addon/${path}`, import.meta.url), "utf8");

/**
 * { groupId: [toolId…] } from the list that starts at `start` and ends at the first "];": groups are
 * `id: "x", label:`, tools match `toolPattern`, in order of appearance.
 */
function groupsIn(source, start, toolPattern) {
  const from = source.indexOf(start);
  const block = source.slice(from, source.indexOf("];", from));
  const tokens = [
    ...[...block.matchAll(/id: "([a-z]+)", label:/g)].map((m) => ({ at: m.index, group: m[1] })),
    ...[...block.matchAll(toolPattern)].map((m) => ({ at: m.index, tool: m[1] })),
  ].sort((a, b) => a.at - b.at);
  const out = {};
  let current = null;
  for (const token of tokens) {
    if (token.group) out[(current = token.group)] = [];
    else if (current) out[current].push(token.tool);
  }
  return out;
}

test("Settings → Tools lists exactly the side bar's groups and tools", async () => {
  const groups = await read("experiments/workspace/groups.js");
  const options = await read("options.js");
  const bar = groupsIn(groups, "const TOOL_GROUPS", /\{ id: "([a-z]+)", selector/g);
  const page = groupsIn(options, "const TOOL_SETTINGS", /\["([a-z]+)", "/g);
  assert.deepEqual(Object.keys(bar), ["communicate", "files", "create", "web"]);
  assert.deepEqual(page, bar);
});

test("the side bar, the Settings page and the settings allow-list use the same pref", async () => {
  const pref = (source) => source.match(/TOOLS_PREF = "([^"]+)"/)?.[1];
  const groups = await read("experiments/workspace/groups.js");
  const options = await read("options.js");
  const settings = await read("experiments/workspace/settings.js");
  assert.equal(pref(groups), "extensions.mailworkspace.tools");
  assert.equal(pref(options), pref(groups));
  assert.match(settings, /"extensions\.mailworkspace\.tools": "string"/);
});
