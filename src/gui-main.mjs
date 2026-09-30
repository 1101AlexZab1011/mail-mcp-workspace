#!/usr/bin/env node
// mail-gui MCP server: the agent's hands in Mail Workspace (Thunderbird).
//
// GUI tools publish a command on listener-mcp channel mail/gui/commands and
// wait for the add-on's reply; artifact tools talk to the workspace host
// directly. Irreversible GUI actions (send, delete, move mail, settings) are
// confirmed by the user in the chat dock; artifact capabilities can only be
// approved by the user, never through these tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ListenerClient } from "listener-mcp/client";

const HOST = process.env.MAIL_WORKSPACE_HOST ?? "http://127.0.0.1:47810";
const CREDENTIAL = process.env.MAIL_GUI_CREDENTIAL ?? "email-agent";
let client = null;
const connect = async () => (client ??= await ListenerClient.fromEnvironment({ credential: CREDENTIAL }));

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (error) => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
const tool = (fn) => async (params) => { try { return await fn(params); } catch (error) { return failure(error); } };

/** Run a GUI command in Thunderbird and return its result. */
async function gui(command, args = {}, { timeoutMs = 120_000 } = {}) {
  const c = await connect();
  const sent = await c.publish({ channel: "mail/gui/commands", type: "command", data: { command, args }, ttlMs: timeoutMs, waitReplyMs: timeoutMs });
  const reply = sent.replies?.[0]?.data;
  if (!reply) throw new Error("Thunderbird did not answer. Is it running with the Mail Workspace add-on?");
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

async function hostCall(path, init = {}) {
  const c = await connect();
  const response = await fetch(`${HOST}${path}`, { ...init, headers: { authorization: `Bearer ${c.token}`, ...(init.body ? { "content-type": "application/json" } : {}) } });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message ?? `Workspace host answered ${response.status}`);
  return value;
}

async function imageResult(path, caption) {
  const data = (await readFile(path)).toString("base64");
  return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: caption }] };
}

function formatSnapshot({ sections }) {
  const lines = [];
  for (const section of sections) {
    lines.push(`## ${section.where}${section.truncated ? " (truncated; pass query to narrow)" : ""}`);
    for (const item of section.items) {
      const flags = [item.selected && "selected", item.checked && "checked", item.disabled && "disabled", item.expanded === true && "expanded", item.expanded === false && "collapsed"].filter(Boolean);
      lines.push(`${item.ref} ${item.role} "${item.name}"${item.id ? ` #${item.id}` : ""}${item.value ? ` = "${item.value}"` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}${item.where && item.where !== "window" ? ` (${item.where})` : ""}`);
    }
  }
  return lines.join("\n");
}

const server = new McpServer({ name: "mail-gui", version: "1.0.0" });
const register = (name, description, inputSchema, handler, annotations = {}) => server.registerTool(name, { description, inputSchema, annotations }, tool(handler));

// ------------------------------------------------------------- seeing --

register("gui_state", "What the user is looking at in Thunderbird: the active space; the selected folder and messages; calendar, task or contact selection; the docks; the file open in the viewer (and its page/selection); the file browser's folder and selection; the open artifact; the paint canvas. Start here.", {}, async () => text(await gui("state")), { readOnlyHint: true });

register("gui_snapshot", "List the visible, clickable things in Thunderbird with refs to act on (gui_click, gui_type, …). Sections: the Thunderbird window itself, then each visible Mail Workspace page (chat, files, viewer, artifacts, paint). Pass `query` to filter by label. Refs expire with the next snapshot.", {
  query: z.string().optional().describe("Only items whose label or id contains this text"),
  limit: z.number().int().min(10).max(1000).optional(),
}, async ({ query, limit }) => text(formatSnapshot(await gui("snapshot", { query, limit }))), { readOnlyHint: true });

register("gui_screenshot", "A screenshot of the Thunderbird window (or of one element by ref), to see layout, content or what the user refers to.", {
  ref: z.string().optional(),
}, async ({ ref }) => {
  const shot = await gui("screenshot", { ref });
  return imageResult(shot.path, `${shot.width}×${shot.height} screenshot${ref ? ` of ${ref}` : ""}`);
}, { readOnlyHint: true });

// ------------------------------------------------------------- acting --

register("gui_click", "Click (or double-click, right-click, hover) a snapshot ref. Sending, deleting, moving mail or changing settings first asks the user in the chat; the result says if they declined.", {
  ref: z.string(),
  action: z.enum(["click", "dblclick", "rightclick", "hover", "focus", "scroll"]).default("click"),
}, async ({ ref, action }) => text(await gui("act", { ref, action }, { timeoutMs: 360_000 })));

register("gui_type", "Type text into a field (by ref), replacing its content, as if the user typed it.", {
  ref: z.string(),
  text: z.string(),
}, async ({ ref, text: value }) => text(await gui("act", { ref, action: "type", value })));

register("gui_select", "Choose a value in a dropdown (by ref), or select a list/tree item.", {
  ref: z.string(),
  value: z.string().optional(),
}, async ({ ref, value }) => text(await gui("act", { ref, action: "select", value }, { timeoutMs: 360_000 })));

register("gui_key", "Press a key combination in Thunderbird, e.g. \"Control+Shift+K\", \"Escape\", \"Delete\". Keys that send, delete or move mail ask the user first.", {
  combo: z.string(),
}, async ({ combo }) => text(await gui("key", { combo }, { timeoutMs: 360_000 })));

register("gui_open", "Open a space: mail, addressbook, calendar, tasks, settings, viewer (file viewer), artifacts, paint.", {
  space: z.enum(["mail", "addressbook", "calendar", "tasks", "settings", "viewer", "artifacts", "paint"]),
}, async ({ space }) => text(await gui("open", { space })));

register("gui_dock", "Show, minimize, maximize or resize a dock: chat (right side) or files (left side).", {
  dock: z.enum(["chat", "files"]),
  state: z.enum(["open", "minimized", "maximized", "toggle"]).optional(),
  width: z.number().int().min(260).max(1600).optional(),
}, async ({ dock, state, width }) => text(await gui("dock", { dock, state, width })));

register("workspace_settings", "Change Mail Workspace settings: appearance (system, light, dark: Thunderbird switches too) and the code theme of the file viewer (one-dark-pro, dracula, github-dark, github-light, monokai, night-owl, tokyo-night, catppuccin-mocha, catppuccin-latte, nord, material-theme-palenight, solarized-dark, gruvbox-dark-medium, ayu-dark, rose-pine). Without arguments, returns the current settings.", {
  appearance: z.enum(["system", "light", "dark"]).optional(),
  code_theme: z.string().optional(),
}, async ({ appearance, code_theme }) => text(await gui("settings", { appearance, codeTheme: code_theme })));

// ---------------------------------------------------------- mail/calendar --

register("mail_select", "Show a mail folder and/or select messages in it. Folder is a folder URI (see gui_state.mail.folder.uri); keys are message keys (IMAP UIDs, from gui_state or email tools).", {
  folder_uri: z.string().optional(),
  keys: z.array(z.number().int()).optional(),
}, async ({ folder_uri, keys }) => text(await gui("mail.select", { folder: folder_uri, keys })));

register("calendar_goto", "Open the calendar on a date (YYYY-MM-DD), optionally in a view: day, week, multiweek, month.", {
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  view: z.enum(["day", "week", "multiweek", "month"]).optional(),
}, async ({ date, view }) => text(await gui("calendar.goto", { date, view })));

// ------------------------------------------------------------ files --

register("viewer_open", "Open a file in the Files viewer (read-only): PDF, Word/ODT, PowerPoint/ODP, Excel/ODS/CSV, markdown, code, text, images, SVG, audio, video.", {
  path: z.string().describe("Absolute path, or ~/…"),
}, async ({ path }) => text(await gui("page", { page: "viewer", type: "open", path })));

register("viewer_command", "Control the open file: pdf → page {page}, next, previous, zoom {zoom: auto|page-fit|page-width|1.5}, find {text}, mode {mode: scroll|pages}, text {page} (returns page text); sheet → sheet {sheet}, find {text}, rows {from, count}; code → line {line}, wrap {wrap}; markdown → mode {mode}, heading {text}; image → zoom {zoom: fit|100}; audio/video → play, pause, seek {seconds}, rate {rate}.", {
  action: z.string(),
  args: z.record(z.string(), z.any()).optional(),
}, async ({ action, args }) => text(await gui("page", { page: "viewer", type: "view", action, args })));

register("files_navigate", "Show a folder in the file browser dock (opens the dock).", {
  path: z.string(),
}, async ({ path }) => {
  await gui("dock", { dock: "files", state: "open" });
  return text(await gui("page", { page: "files", type: "navigate", path }));
});

register("files_select", "Select files in the file browser dock (their folders expand).", {
  paths: z.array(z.string()).min(1),
}, async ({ paths }) => text(await gui("page", { page: "files", type: "select", paths })));

// --------------------------------------------------------- terminal --
// Terminals are shared with the user: what the agent runs shows in the panel.

register("terminal_list", "The terminals open in the Mail Workspace panel (Ctrl+`), with ids, titles and working directories.", {}, async () => text(await hostCall("/v1/term")), { readOnlyHint: true });

register("terminal_open", "Open a terminal in the panel: a new tab, or a split of the focused one (right or down). Returns its id. The panel slides up unless show is false.", {
  placement: z.enum(["tab", "right", "down"]).default("tab"),
  cwd: z.string().optional(),
  show: z.boolean().default(true),
}, async ({ placement, cwd, show }) => text(await gui("terminal.open", { placement, cwd, show })));

register("terminal_run", "Type a command into a terminal (the user sees it run) and return what it printed. Returns when the output goes quiet, `wait_for` (a regex) appears, or the timeout passes; long-running programs keep running afterwards.", {
  id: z.string().describe("Terminal id from terminal_list or terminal_open"),
  command: z.string(),
  timeout_seconds: z.number().min(1).max(3600).default(60),
  wait_for: z.string().optional(),
  quiet_ms: z.number().int().min(200).max(60000).default(1500),
}, async ({ id, command, timeout_seconds, wait_for, quiet_ms }) => text(await hostCall(`/v1/term/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify({ command, timeoutMs: timeout_seconds * 1000, waitFor: wait_for, idleMs: quiet_ms }) })));

register("terminal_read", "The last lines a terminal printed, as plain text.", {
  id: z.string(),
  lines: z.number().int().min(1).max(5000).default(200),
}, async ({ id, lines }) => text(await hostCall(`/v1/term/${encodeURIComponent(id)}/read?lines=${lines}`)), { readOnlyHint: true });

register("terminal_send", "Send raw keystrokes to a terminal, e.g. answers to a prompt, or control keys: \u0003 is Ctrl+C, \u0004 Ctrl+D, \r Enter, \u001b Escape.", {
  id: z.string(),
  text: z.string(),
}, async ({ id, text: data }) => text(await hostCall(`/v1/term/${encodeURIComponent(id)}/input`, { method: "POST", body: JSON.stringify({ data }) })));

register("terminal_close", "Close a terminal (ends its shell).", { id: z.string() }, async ({ id }) => text(await gui("page", { page: "terminal", type: "close", id }).catch(() => hostCall(`/v1/term/${encodeURIComponent(id)}`, { method: "DELETE" }))));

register("terminal_panel", "Show, hide or maximize the terminal panel (Ctrl+`).", {
  visible: z.boolean().optional(),
  maximized: z.boolean().optional(),
}, async ({ visible, maximized }) => text(await gui("terminal", { visible, maximized })));

// ------------------------------------------------------------ paint --

register("paint_snapshot", "The current Paint canvas as an image (what the user drew or pasted).", {}, async () => {
  const shot = await gui("page", { page: "paint", type: "snapshot" });
  return imageResult(shot.path, `Paint canvas, saved at ${shot.path}`);
}, { readOnlyHint: true });

register("paint_insert_image", "Put an image file onto the Paint canvas (opens Paint).", {
  path: z.string(),
}, async ({ path }) => text(await gui("page", { page: "paint", type: "insert-image", path })));

register("paint_add_shapes", "Draw on the Paint canvas. Shapes: {type:'rect'|'ellipse', x, y, w, h, color, fill?, width}, {type:'line'|'arrow', x1, y1, x2, y2, color, width}, {type:'text', x, y, text, color, size}, {type:'stroke', points:[[x,y],…], color, width}. Coordinates are canvas pixels.", {
  shapes: z.array(z.record(z.string(), z.any())).min(1),
}, async ({ shapes }) => text(await gui("page", { page: "paint", type: "add-shapes", shapes })));

register("paint_clear", "Clear the Paint canvas (undoable by the user).", {}, async () => text(await gui("page", { page: "paint", type: "clear" })));

// ---------------------------------------------------------- artifacts --

const ARTIFACT_GUIDE = `Artifacts are small React apps in ~/Artifacts, organised in folders. Before creating one, call artifact_tree and put it into the folder that fits (e.g. "Dev tools", "Data", "Mail", "Writing"); create a new folder only when none fits, named for the topic, not the date. Files: App.tsx default-exports a React component; Tailwind classes work; react, recharts and lucide-react can be imported. Beyond the page an artifact is sandboxed (no network, no files): import { exec, shell, fetchLocal, readFile, writeFile, listDir, askAgent } from "workspace" and declare what it needs in capabilities: { exec: { cwd }, fetch: { origins: [...] }, fs: { read: [...], write: [...] }, agent: true }. The user must approve capabilities in the GUI; ask for the narrowest ones.`;

register("artifact_tree", `The artifact library as a tree of folders and artifacts. ${ARTIFACT_GUIDE}`, {}, async () => text(await hostCall("/v1/artifacts/tree")), { readOnlyHint: true });

register("artifact_read", "An artifact's metadata and source files.", {
  path: z.string().describe("Store-relative path, e.g. \"Dev tools/test-shell\""),
}, async ({ path }) => text(await hostCall(`/v1/artifacts/item?path=${encodeURIComponent(path)}`)), { readOnlyHint: true });

register("artifact_create", `Create an artifact and open it in the Artifacts space. ${ARTIFACT_GUIDE}`, {
  folder: z.string().describe("Existing or new folder path in the library (\"\" for the top level)"),
  title: z.string(),
  description: z.string().describe("One sentence: what it is for"),
  files: z.record(z.string(), z.string()).describe("File name → content; must include App.tsx (or the entry)"),
  entry: z.string().optional(),
  tags: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.any()).optional(),
  open: z.boolean().default(true),
}, async ({ open, ...body }) => {
  const created = await hostCall("/v1/artifacts", { method: "POST", body: JSON.stringify(body) });
  const opened = open ? await gui("page", { page: "artifacts", type: "open", path: created.path }).catch((error) => ({ error: error.message })) : null;
  return text({ ...created, opened, note: body.capabilities ? "The user must allow its capabilities in the Artifacts space before they work." : undefined });
});

register("artifact_update", "Change an artifact: replace or add files, remove files, update title/description/tags/capabilities. The open view reloads by itself.", {
  path: z.string(),
  files: z.record(z.string(), z.string()).optional(),
  remove: z.array(z.string()).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.any()).nullable().optional(),
}, async (body) => text(await hostCall("/v1/artifacts", { method: "PATCH", body: JSON.stringify(body) })));

register("artifact_move", "Move or rename an artifact or folder within the library (`to` is the new store-relative path).", {
  path: z.string(),
  to: z.string(),
}, async ({ path, to }) => text(await hostCall("/v1/artifacts/move", { method: "POST", body: JSON.stringify({ path, to }) })));

register("artifact_mkdir", "Create a folder in the artifact library.", { path: z.string() }, async ({ path }) => text(await hostCall("/v1/artifacts/folder", { method: "POST", body: JSON.stringify({ path }) })));

register("artifact_delete", "Move an artifact or folder to ~/Artifacts/.trash (recoverable).", { path: z.string() }, async ({ path }) => text(await hostCall(`/v1/artifacts?path=${encodeURIComponent(path)}`, { method: "DELETE" })), { destructiveHint: true });

register("artifact_open", "Open an artifact in the Artifacts space. Returns build errors if it does not compile.", { path: z.string() }, async ({ path }) => text(await gui("page", { page: "artifacts", type: "open", path })));

await server.connect(new StdioServerTransport());
