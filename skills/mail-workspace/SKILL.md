---
name: mail-workspace
description: Operate the Mail Workspace GUI in Thunderbird for the user through the mail-gui MCP server - see what is selected, open spaces, files, artifacts and paint, click and type in any part of the interface, build artifacts. Use when the user asks you to do something in their mail client, file viewer, artifacts, paint, calendar, contacts or tasks, or refers to what they are looking at.
---

# Mail Workspace

The user works in Thunderbird with the Mail Workspace add-on: chat on the left
(this conversation), a file browser dock on the right, and spaces for Mail,
Address Book, Calendar, Tasks, Files (viewer), Artifacts and Paint. The
`mail-gui` MCP server lets you see and operate all of it. Do the job for the
user instead of describing clicks.

## See first

- `gui_state` tells you the active space and every selection: folder and
  messages, calendar event, task, contacts, the file in the viewer (page,
  selected text), the file browser's folder and selection, the open artifact,
  the paint canvas. "This", "these", "what I'm looking at" refer to it.
- `gui_snapshot` lists what can be clicked, with refs (`c12` for Thunderbird,
  `files:p3` for a Mail Workspace page). Use `query` to narrow it. Refs change
  with every snapshot: take a new one after the UI changes.
- `gui_screenshot` shows the window when layout or visuals matter.

## Act

- Prefer the direct tools: `gui_open`, `gui_dock`, `mail_select`,
  `calendar_goto`, `viewer_open`, `viewer_command`, `files_navigate`,
  `files_select`, `paint_*`, `artifact_*`.
- For anything else: `gui_snapshot` → `gui_click` / `gui_type` /
  `gui_select` / `gui_key`, then check the result with `gui_state` or a new
  snapshot.
- Mail content and sending belong to the email tools (email MCP server). Use
  the GUI to show the user things and for actions those tools lack.
- Sending, deleting, moving mail and changing settings show the user a
  confirmation card. If the result says they declined, stop and say so.
- Selecting or opening a message marks it read. Don't do that just to look;
  read mail with the email tools instead.
- You can never approve an artifact's permissions or a confirmation card:
  those buttons are hidden from you and ignore your input. Ask the user.

## Artifacts

Artifacts are React apps kept in `~/Artifacts`, organised in folders.

1. Call `artifact_tree` first and choose the folder that fits the topic
   ("Dev tools", "Data", "Mail", "Writing", …). Create a new folder only when
   nothing fits, and name it by topic.
2. `artifact_create` with `App.tsx` default-exporting a component. Use Tailwind
   classes; `react`, `recharts` and `lucide-react` are available. Keep it one
   file unless it is large.
3. Artifacts are sandboxed: no network and no files. For more, import from
   `"workspace"` (`exec`, `shell`, `fetchLocal`, `readFile`, `writeFile`,
   `listDir`, `askAgent`) and declare the narrowest `capabilities`
   (`exec: {cwd}`, `fetch: {origins}`, `fs: {read, write}`, `agent: true`).
   Tell the user they must allow them in the Artifacts space.
4. If `artifact_open` reports a build error, fix it with `artifact_update`.
   The open artifact reloads by itself.

## Paint

When the user says "look at what I drew", call `paint_snapshot`. To mark up a
picture for them, use `paint_insert_image` and `paint_add_shapes`.
