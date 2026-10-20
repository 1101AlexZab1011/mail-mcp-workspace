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

register("gui_open", "Open a space: mail, addressbook, calendar, tasks, settings, viewer (file viewer), artifacts, paint, writer (document editor).", {
  space: z.enum(["mail", "addressbook", "calendar", "tasks", "settings", "viewer", "artifacts", "paint", "writer", "slides", "notes"]),
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

// ----------------------------------------------------- writing files --
// Writes are atomic and confined to the home folder (credential folders are refused).

register("files_read", "Read a text file. Returns its text and `hash`: pass that hash as `expect` to files_write so you never overwrite edits made since you read it.", {
  path: z.string().describe("Absolute path, or ~/…"),
}, async ({ path }) => text(await hostCall(`/v1/fs/read?path=${encodeURIComponent(path)}`)), { readOnlyHint: true });

register("files_write", "Create or replace a whole file (atomic). To change part of an existing file prefer files_edit. With `expect` (the hash from files_read) the write is refused if the file changed meanwhile, and the error carries the current text.", {
  path: z.string(),
  text: z.string().optional().describe("UTF-8 content"),
  base64: z.string().optional().describe("Binary content, base64"),
  expect: z.string().optional().describe("Hash from files_read; refuse if the file changed since"),
  create_dirs: z.boolean().default(false),
}, async ({ path, text: content, base64, expect, create_dirs }) => text(await hostCall("/v1/fs/file", { method: "PUT", body: JSON.stringify({ path, text: content, base64, expect, createDirs: create_dirs }) })));

register("files_edit", "Replace an exact piece of text in a file. `old_string` must occur exactly once (add surrounding context to make it unique) unless `all`. The Writer reloads an open document by itself.", {
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  all: z.boolean().default(false),
}, async ({ path, old_string, new_string, all }) => text(await hostCall("/v1/fs/edit", { method: "POST", body: JSON.stringify({ path, oldString: old_string, newString: new_string, all }) })));

register("files_mkdir", "Create a folder (and any missing parents).", { path: z.string() }, async ({ path }) => text(await hostCall("/v1/fs/mkdir", { method: "POST", body: JSON.stringify({ path }) })));

register("files_move", "Move or rename a file or folder. Moving onto an existing folder moves into it. Refuses to replace an existing file unless `overwrite`.", {
  from: z.string(),
  to: z.string(),
  overwrite: z.boolean().default(false),
}, async ({ from, to, overwrite }) => text(await hostCall("/v1/fs/move", { method: "POST", body: JSON.stringify({ from, to, overwrite }) })));

register("files_trash", "Move a file or folder to the Trash (restorable). The user confirms in the chat first; the result says if they declined.", {
  path: z.string(),
}, async ({ path }) => text(await gui("files.trash", { path }, { timeoutMs: 360_000 })), { destructiveHint: true });

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

// ------------------------------------------------------------- writer --
// The Writer edits Quarto (.qmd) and Markdown documents. The file on disk is the
// truth: files_edit changes it directly and an open Writer reloads by itself.

register("writer_state", "The Writer: which document is open, whether it has unsaved edits, where the cursor is (the heading it is under, the selected text), the outline, the word count. Use it before writing into the user's document, and to resolve \"this section\" or \"the selected text\".", {}, async () => text(await gui("page", { page: "writer", type: "state" })), { readOnlyHint: true });

register("writer_open", "Open a .qmd or .md document in the Writer (other files open in the viewer).", {
  path: z.string(),
}, async ({ path }) => text(await gui("page", { page: "writer", type: "open", path })));

register("writer_insert", "Insert Quarto Markdown into the open document: at the cursor, at the end, or after the heading named by `at`. Citations [@key], cross-references @fig-x, math $…$ and $$…$$ {#eq-x}, ::: callouts and figures ![cap](path){#fig-x} all work. Saves immediately.", {
  markdown: z.string(),
  at: z.string().default("cursor").describe("\"cursor\", \"end\", or a heading's text"),
}, async ({ markdown, at }) => text(await gui("page", { page: "writer", type: "insert", markdown, at })));

register("writer_replace_selection", "Replace the text the user selected in the Writer with new Markdown (e.g. a rewrite they asked for). Saves immediately.", {
  markdown: z.string(),
}, async ({ markdown }) => text(await gui("page", { page: "writer", type: "replace-selection", markdown })));

register("writer_reveal", "Scroll the Writer to a heading or to the first block containing some text, and put the cursor there.", {
  heading: z.string().optional(),
  text: z.string().optional(),
}, async ({ heading, text: needle }) => text(await gui("page", { page: "writer", type: "reveal", heading, text: needle })));

register("writer_render", "Render the open document to PDF with Quarto and show it in the viewer. Returns errors and the end of the log if it fails.", {}, async () => text(await gui("page", { page: "writer", type: "render" }, { timeoutMs: 660_000 })));

// ------------------------------------------------------------- slides --
// Slides edits presentations (.slides.json, PPTist's model; media in media/ next to the deck).
// The open deck is edited through the page, so each change is one undo step for the user; other
// decks are edited in their file through the host.

const OPS_HELP = `Ops (a list, applied in order, all or nothing). Slides are addressed by index (0-based) or id; elements by id (see slides_read).
- {op:"add_slide", after?: index|id|"start"|"end", background?: "#hex", notes?: text, elements?: [element, …]}
- {op:"update_slide", slide, background?, notes?, transition?: fade|slideX|slideY|scale|…}
- {op:"delete_slide", slide} · {op:"move_slide", slide, to: index} · {op:"duplicate_slide", slide}
- {op:"add_element", slide, element} · {op:"update_element", id, …element fields to change, props?: {raw PPTist fields}}
- {op:"delete_element", id | ids} · {op:"move_element", id, to: front|back|forward|backward|index} or {op:"move_element", id, slide} (to another slide)
- {op:"set_notes", slide, text} (speaker notes) · {op:"set_title", title} · {op:"set_theme", font?, color?, background?, colors?: [6 hex]}
- {op:"replace_text", find, replace} (all text in the deck)
Motion (play in the slideshow; check them with slides_motion_frames):
- {op:"set_transition", slide | "all", transition: magic | a built-in (fade, slideX, slideY, slideX3D, slideY3D, rotate, scale, scaleReverse, scaleX, scaleY, no, random) | a custom name}
- {op:"define_transition", name, out?: [keyframes], in?: [keyframes], duration?, easing?, order?: in-over|out-over, perspective?, label?} — Web Animations keyframes, camelCase CSS (opacity, transform, filter, clipPath…); out = the slide leaving, in = the slide arriving
- {op:"define_effect", name, type: in|out|attention, keyframes?, path?: SVG path in slide px from the element's place, origin?, duration?, easing?, label?}
- {op:"add_animation", id: element, effect: a custom name or built-in (fadeIn, fadeInUp, zoomIn, bounceIn, slideInLeft, fadeOut, zoomOut, pulse, headShake…), trigger?: click|with|after, duration?, position?}
- {op:"update_animation", id: animation, effect?, trigger?, duration?, position?} · {op:"remove_animation", id} · {op:"delete_motion", name, kind?}
Magic Move matches elements on consecutive slides by name (set name on elements), then by the same image or text.
Elements (canvas px, origin top left; box: [left, top, width, height]):
- text: {type:"text", box, text: light Markdown (one paragraph per line, "- " bullets, "1. " numbers, **bold**, *italic*, \`code\`, ^sup^, ~sub~, [link](url)), size?: px, color?, font?, bold?, italic?, align?: left|center|right|justify, fill?: box colour, html?: raw PPTist HTML instead of text}
- image: {type:"image", src: path relative to the deck (e.g. "media/fig.png"), absolute path or URL, box (give width or height alone to keep the aspect ratio), radius?}
- shape: {type:"shape", shape: rect|roundRect|ellipse|triangle|diamond|arrow-right|arrow-left|chevron|hexagon, box, fill?, outline?: {color, width, style}, text?, size?, color?}
- line: {type:"line", from: [x, y], to: [x, y], color?, width?, style?: solid|dashed|dotted, arrow?: none|end|start|both|dots}
- latex: {type:"latex", latex: TeX, left, top, height (sets the size), color?}
- table: {type:"table", rows: [["a","b"], …], box?, header?: true, size?, colWidths?: [relative widths]}
- script: {type:"script", code: JavaScript (saved as scripts/<name>.js next to the deck) or src: an existing file, name?, box, steps?: clicks it takes in the slideshow, libs?: ["d3"] and/or ["three"], data?: [files next to the deck]}. Its code uses one global, slide: slide.canvas() or slide.svg() (box px), slide.width/height, slide.theme (themeColors, fontName, fontColor), slide.onEnter(fn), slide.onStep(fn(n)), slide.onLeave(fn), slide.requestFrame(fn(t ms)), slide.data(name), slide.random(seed), slide.ease.{inOut,out,in}. No network. Check it with slides_script_run (poster: true sets its still picture).
- chart: {type:"chart", chartType: column (vertical)|bar (horizontal)|line|area|pie|doughnut|radar|scatter, labels, series: [[numbers], …], legends?, box?}`;

async function slidesState() {
  // A deck that is still opening (loading its media) is reported once it is ready.
  for (let i = 0; i < 120; i++) {
    const state = await gui("page", { page: "slides", type: "state" }).catch(() => ({ path: null }));
    if (!state.loading) return state;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Slides is still opening the deck");
}
/** Is `path` (or, with no path, any deck) the one open in Slides? */
async function openDeck(path) {
  const state = await slidesState();
  if (!state.path) return false;
  return !path || (await hostCall(`/v1/fs/stat?path=${encodeURIComponent(path)}`).catch(() => null))?.path === state.path;
}

register("slides_state", "Slides: the open deck (path, title, unsaved edits), the current slide, and what the user has selected (each element's id, type, box and text). Use it to resolve \"this slide\" or \"the selected box\" before changing anything.", {}, async () => text(await slidesState()), { readOnlyHint: true });

register("slides_open", "Open a deck (.slides.json) in Slides, or import a PowerPoint (.pptx) into a new deck next to it and open that.", {
  path: z.string(),
}, async ({ path }) => text(await gui("page", { page: "slides", type: "open", path })));

register("slides_new", "Create an empty deck (path ends in .slides.json) and open it in Slides.", {
  path: z.string(),
}, async ({ path }) => text(await gui("page", { page: "slides", type: "new", path })));

register("slides_read", "Read a deck: each slide's elements (id, type, box [left, top, width, height] in canvas px, text, image path, font size), speaker notes and comments. Without path: the deck open in Slides, including unsaved edits.", {
  path: z.string().optional().describe("A .slides.json file; omit for the open deck"),
  from: z.number().int().min(0).optional().describe("First slide index (0-based)"),
  to: z.number().int().min(0).optional().describe("Last slide index"),
  html: z.boolean().optional().describe("Include the text elements' HTML (styles, spans)"),
}, async ({ path, from, to, html }) => {
  if (await openDeck(path)) return text(await gui("page", { page: "slides", type: "read", first: from, last: to, html })); // `to` addresses pages
  if (!path) throw new Error("No deck is open in Slides; pass path");
  const query = new URLSearchParams({ path, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(html ? { html: "1" } : {}) });
  return text(await hostCall(`/v1/slides/read?${query}`));
}, { readOnlyHint: true });

register("slides_inspect", "Every property of one element of the open deck (PPTist's model: content HTML, fills, outlines, shadows, animations…), for edits slides_apply's friendly fields do not cover (pass them as props).", {
  id: z.string(),
}, async ({ id }) => text(await gui("page", { page: "slides", type: "inspect", id })), { readOnlyHint: true });

register("slides_shot", "A picture of a slide of the open deck (or one element, or a region), rendered from the deck itself. Use it to check your edits; overlay labels every element with its id.", {
  slide: z.union([z.number().int().min(0), z.string()]).optional().describe("Index or id; default: the current slide"),
  element: z.string().optional().describe("Crop to this element"),
  region: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }).optional(),
  scale: z.number().min(0.2).max(2).optional().describe("Pixels per canvas px (default 0.75)"),
  overlay: z.boolean().optional(),
}, async ({ slide, element, region, scale, overlay }) => {
  const shot = await gui("page", { page: "slides", type: "shot", slide, element, region, scale, overlay });
  return imageResult(shot.path, `slide ${slide ?? "(current)"}${element ? `, element ${element}` : ""}`);
}, { readOnlyHint: true });

register("slides_motion_frames", "Frames of a slide's transition (from the slide before) or of an element's custom effect, side by side at moments `at` (0 = start, 1 = end), so you can see motion you defined. Custom transitions and Magic Move only.", {
  slide: z.union([z.number().int().min(0), z.string()]).optional().describe("The arriving slide (index or id); default: current"),
  transition: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("magic, custom:<name>, or a definition to try before saving it; default: the slide's own"),
  element: z.string().optional().describe("Show this element's custom effect instead"),
  effect: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("custom:<name> or a definition; default: the element's first custom animation"),
  at: z.array(z.number().min(0).max(1)).max(8).optional(),
  width: z.number().int().min(160).max(640).optional().describe("Width of each frame in px (default 360)"),
}, async (args) => {
  const shot = await gui("page", { page: "slides", type: "frames", ...args });
  return imageResult(shot.path, `motion frames${args.element ? ` of ${args.element}` : ""} on slide ${args.slide ?? "(current)"}`);
}, { readOnlyHint: true });

register("slides_script_run", "Run a script element of the open deck off screen, as a check: it steps through `steps` clicks, runs `wait` ms, and returns its console output, errors and a picture of where it ended. With poster: true, that picture becomes the element's poster (thumbnails, export).", {
  id: z.string(),
  steps: z.number().int().min(0).max(50).optional(),
  wait: z.number().int().min(0).max(15000).optional().describe("ms to let it run after the last step (default 1500)"),
  poster: z.boolean().optional(),
}, async ({ id, steps, wait, poster }) => {
  const result = await gui("page", { page: "slides", type: "script-run", id, steps, wait, poster }, { timeoutMs: 120_000 });
  const summary = { errors: result.errors, logs: result.logs.slice(-40), steps: result.steps, posterSet: result.posterSet };
  if (!result.picture) return text({ ...summary, picture: "nothing drawn" });
  const image = await imageResult(result.picture, "");
  return { content: [image.content[0], { type: "text", text: JSON.stringify(summary, null, 2) }] };
});

register("slides_select", "Select elements on a slide of the open deck (and go to that slide), to show the user what you mean before changing it, or before slides_action.", {
  ids: z.array(z.string()).optional(),
  slide: z.union([z.number().int().min(0), z.string()]).optional(),
}, async ({ ids, slide }) => text(await gui("page", { page: "slides", type: "select", ids, slide })));

register("slides_apply", `Change a deck with a list of ops. The open deck changes in place (one undo step for the user; saved at once); with path, another deck's file is edited. Returns the ids of what was created. Check the result with slides_shot.\n${OPS_HELP}`, {
  ops: z.array(z.record(z.string(), z.any())).min(1),
  path: z.string().optional().describe("A .slides.json file that is not open; omit for the open deck"),
}, async ({ ops, path }) => {
  if (await openDeck(path)) return text(await gui("page", { page: "slides", type: "apply", ops }));
  if (!path) throw new Error("No deck is open in Slides; pass path");
  return text(await hostCall("/v1/slides/apply", { method: "POST", body: JSON.stringify({ path, ops }) }));
});

register("slides_action", "Run an editor command on the open deck, as the user would from the toolbar: align, distribute, order, group, lock, hide, duplicate, theme presets, undo/redo, present, open a panel or tab… Pass ids to act on those elements (selected first). slides_actions lists them all with their arguments.", {
  name: z.string(),
  args: z.record(z.string(), z.any()).optional(),
}, async ({ name, args }) => text(await gui("page", { page: "slides", type: "action", name, args })));

register("slides_actions", "List the editor commands slides_action can run, with their arguments.", {}, async () => text(await gui("page", { page: "slides", type: "actions" })), { readOnlyHint: true });

register("slides_export", "Export the open deck as PowerPoint (saved next to the deck as name.pptx). For a PDF, ask the user to use Export → Print / export PDF.", {
  media: z.boolean().optional().describe("Include audio and video (slower)"),
}, async ({ media }) => text(await gui("page", { page: "slides", type: "export", format: "pptx", media }, { timeoutMs: 180_000 })));

// -------------------------------------------------------------- notes --
// Notes is a vault of Markdown pages (default ~/Notes): the title is the file name, a page's subpages live
// in a folder of the same name next to it, front matter holds icon/cover/properties, [[Page]] links pages,
// and a database is a page X.md + X.base.json (columns, views) with its rows as pages in X/.

const NOTES_GUIDE = "Pages are plain Markdown: prefer notes_append to rewriting a page, keep front matter valid YAML, link pages with [[Title]], callouts are > [!note] Title, toggles > [!toggle]- Title, to-dos - [ ]. For precise edits use files_edit on the page's path; the open page merges them live.";
const notesQuery = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));

register("notes_state", "Notes: the page open in the Notes space (path, title, properties, unsaved edits, cursor, outline) and its tabs. Use it to resolve \"this page\" or \"the selected text\".", {}, async () => text(await gui("page", { page: "notes", type: "state" }).catch(() => ({ path: null, note: "The Notes space is not open" }))), { readOnlyHint: true });

register("notes_tree", `The Notes vault as a tree of pages (folder notes merged; databases flagged with their row count). ${NOTES_GUIDE}`, {}, async () => text(await hostCall("/v1/notes/tree")), { readOnlyHint: true });

register("notes_search", "Search Notes pages by words in their title, tags, properties and text; title matches rank first.", {
  query: z.string(),
  limit: z.number().int().min(1).max(100).optional(),
}, async ({ query, limit }) => text(await hostCall(`/v1/notes/search?${notesQuery({ q: query, limit: String(limit ?? 30) })}`)), { readOnlyHint: true });

async function notesPath(page) {
  if (!page) return null;
  if (page.startsWith("/") || page.startsWith("~")) return page;
  const { path } = await hostCall(`/v1/notes/resolve?${notesQuery({ target: page })}`);
  if (!path) throw new Error(`No page “${page}”`);
  return path;
}

register("notes_read", "Read a Notes page: its text, properties, tags, headings, links (resolved) and backlinks. `page` is a path or a title.", {
  page: z.string(),
}, async ({ page }) => {
  const path = await notesPath(page);
  const info = await hostCall(`/v1/notes/page?${notesQuery({ path })}`);
  const file = await hostCall(`/v1/fs/read?${notesQuery({ path: info.path })}`);
  return text({ ...info, text: file.text });
}, { readOnlyHint: true });

register("notes_open", "Open a page in the Notes space for the user (a path or a title).", {
  page: z.string(),
}, async ({ page }) => {
  const path = await notesPath(page);
  await gui("open", { space: "notes" });
  return text(await gui("page", { page: "notes", type: "open", path }));
});

register("notes_create", `Create a Notes page: at the top level, inside a parent page (as its subpage), or in a folder; optionally from a template page. Returns its path. ${NOTES_GUIDE}`, {
  title: z.string(),
  parent: z.string().optional().describe("A page (path or title) to put it under"),
  folder: z.string().optional().describe("A folder path in the vault"),
  body: z.string().optional().describe("Markdown"),
  properties: z.record(z.any()).optional().describe("Front matter, e.g. {icon: \"🧪\", tags: [\"tau\"]}"),
  template: z.string().optional().describe("A template page's path"),
  open: z.boolean().optional().describe("Also open it for the user"),
}, async ({ title, parent, folder, body, properties, template, open }) => {
  const created = await hostCall("/v1/notes/new", { method: "POST", body: JSON.stringify({ title, parent: await notesPath(parent), folder, body, properties, template }) });
  if (open) { await gui("open", { space: "notes" }); await gui("page", { page: "notes", type: "open", path: created.path }).catch(() => {}); }
  return text(created);
});

register("notes_append", "Append Markdown to the end of a Notes page (a path or a title). The open page merges it live.", {
  page: z.string(),
  markdown: z.string(),
}, async ({ page, markdown }) => text(await hostCall("/v1/notes/append", { method: "POST", body: JSON.stringify({ path: await notesPath(page), markdown }) })));

register("notes_set_properties", "Set front-matter properties of a Notes page (null removes one), keeping its other keys and comments. For a database row, these are its cells.", {
  page: z.string(),
  properties: z.record(z.any()),
}, async ({ page, properties }) => text(await hostCall("/v1/notes/properties", { method: "POST", body: JSON.stringify({ path: await notesPath(page), properties }) })));

register("notes_rename", "Rename a Notes page (with its subpages and database); every [[link]] to it is updated.", {
  page: z.string(),
  title: z.string(),
}, async ({ page, title }) => text(await hostCall("/v1/notes/rename", { method: "POST", body: JSON.stringify({ path: await notesPath(page), title }) })));

register("notes_move", "Move a Notes page (with its subpages) under another page, into a folder, or to the top level (neither given).", {
  page: z.string(),
  parent: z.string().optional(),
  folder: z.string().optional(),
}, async ({ page, parent, folder }) => text(await hostCall("/v1/notes/move", { method: "POST", body: JSON.stringify({ path: await notesPath(page), parent: await notesPath(parent), folder }) })));

register("notes_db_create", "Create a Notes database: a new page (inside `parent` if given) or an existing page turned into one. Default columns: Status (Idea/Running/Done), Date, Tags; views Table and Board.", {
  title: z.string().optional(),
  page: z.string().optional().describe("An existing page to turn into a database"),
  parent: z.string().optional(),
  properties: z.array(z.object({ name: z.string(), type: z.enum(["text", "number", "select", "multi-select", "date", "checkbox", "person", "url", "relation"]), options: z.array(z.string()).optional() })).optional(),
}, async ({ title, page, parent, properties }) => text(await hostCall("/v1/notes/database", { method: "POST", body: JSON.stringify({ title, path: await notesPath(page), parent: await notesPath(parent), properties }) })));

register("notes_db_query", "Rows of a Notes database (a path or a title), with the schema. Filter clauses: {property, op: is|is-not|contains|empty|not-empty|before|after, value}; sort: [{property, direction}]. `view` applies a saved view's filter and sort.", {
  database: z.string(),
  view: z.string().optional(),
  filter: z.array(z.object({ property: z.string(), op: z.string().optional(), value: z.any().optional() })).optional(),
  sort: z.array(z.object({ property: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(),
}, async ({ database, view, filter, sort }) => text(await hostCall(`/v1/notes/database?${notesQuery({ path: await notesPath(database), view, filter, sort })}`)), { readOnlyHint: true });

register("notes_db_add", "Add a row to a Notes database: a page in its folder with these properties (cells) and an optional body.", {
  database: z.string(),
  title: z.string(),
  properties: z.record(z.any()).optional(),
  body: z.string().optional(),
}, async ({ database, title, properties, body }) => text(await hostCall("/v1/notes/database/row", { method: "POST", body: JSON.stringify({ path: await notesPath(database), title, properties, body }) })));

register("notes_db_update", "Update cells of database rows: the rows matching `where` (filter clauses, as in notes_db_query) or the row titled `row` get `properties`.", {
  database: z.string(),
  row: z.string().optional(),
  where: z.array(z.object({ property: z.string(), op: z.string().optional(), value: z.any().optional() })).optional(),
  properties: z.record(z.any()),
}, async ({ database, row, where, properties }) => {
  const filter = row ? [{ property: "Title", op: "is", value: row }, ...(where ?? [])] : where ?? [];
  if (!filter.length) throw new Error("Say which rows: row or where");
  const db = await hostCall(`/v1/notes/database?${notesQuery({ path: await notesPath(database), filter })}`);
  const updated = [];
  for (const r of db.rows) { await hostCall("/v1/notes/properties", { method: "POST", body: JSON.stringify({ path: r.path, properties }) }); updated.push(r.title); }
  return text({ updated });
});

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
