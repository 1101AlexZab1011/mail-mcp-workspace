---
name: mail-workspace
description: Operate the Mail Workspace GUI in Thunderbird for the user through the mail-gui MCP server - see what is selected, open spaces, files, artifacts, paint and the Writer document editor, write and edit files, click and type in any part of the interface, build artifacts, run commands in the shared terminal. Use when the user asks you to do something in their mail client, file viewer, artifacts, paint, calendar, contacts or tasks, or refers to what they are looking at.
---

# Mail Workspace

The user works in Thunderbird with the Mail Workspace add-on: chat on the right
(this conversation), a file browser dock on the left, and spaces for Mail,
Address Book, Calendar, Tasks, Files (viewer), Artifacts and Paint, plus a
terminal that slides up over the window (Ctrl+`). The
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
- The space bar shows tool groups: Mail and calendar, Files, Create. Each group
  button opens its last-used tool, and its other tools are in a flyout. Open a
  space with `gui_open`, not by clicking a group.
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

## Terminal

The terminal is shared with the user: whatever you type there, they see.

- `terminal_list` shows the open terminals. `terminal_open` starts one
  (`placement`: `tab`, `right` or `down`; `cwd`), and `terminal_panel` shows
  or hides the panel.
- `terminal_run` types a command and returns what it printed. It finishes when
  the output goes quiet, or when `wait_for` (a regex) matches. For long jobs,
  set `wait_for` or read later with `terminal_read`.
- `terminal_send` sends raw keys (answers to prompts, `\u0003` for Ctrl+C).
- Use your own shell tool for work the user doesn't need to watch; use the
  terminal when they asked for it or should see it happen.

## Settings

`workspace_settings` sets the appearance (`system`, `light`, `dark`) and the
code viewer theme (`one-dark-pro` by default; the tool lists the themes).
With no arguments it returns the current settings. Change them only when the
user asks.

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

## Files: writing

You can write files anywhere in the user's home folder (credential folders such
as `~/.ssh` are refused):

- `files_read` gives the text and a `hash`. Pass it as `expect` to
  `files_write`, so you never overwrite edits made since you read.
- **Prefer `files_edit`** (exact `old_string` → `new_string`) for changes to
  existing files. It fails if the text is not found exactly once; read again
  and copy the text exactly.
- `files_mkdir`, `files_move` and `files_trash` cover the rest. Trashing asks
  the user in the chat; respect a "declined".

## Editors: tabs and saving

Writer, Slides and Paint keep every open file in a tab, the way VS Code does. A dot on a tab marks
unsaved changes, and nothing saves on its own: the user saves with Ctrl+S, and unsaved changes survive
a reload as drafts.

- Your edits through the editors (`writer_insert`, `slides_apply`, …) are saved at once when the
  document had no unsaved changes of the user's.
- When the user has unsaved changes, your edit joins them, unsaved; the result says so. Tell the user,
  and never save over their work unasked.
- `*_state` lists the open tabs and which are modified.
- Switching from the File viewer to an editor opens the viewed file there (images in Paint, decks in
  Slides, .qmd/.md in Writer, pages of the notes vault in Notes).
- Notes is the exception: it saves as the user types, so your edits to a page land at once.

## Writer (papers in Quarto)

The Writer space edits `.qmd` and `.md` files. The user writes there; you add
content when asked.

- **Start with `writer_state`.** It tells you the open document, its unsaved
  state, the heading the cursor is under and the selected text ("this
  paragraph", "here").
- **Add new material** with `writer_insert`: at the cursor, at the end, or
  after a heading. Rewrite what the user selected with
  `writer_replace_selection`.
- **For precise edits elsewhere** use `files_edit` on the document. An open
  Writer reloads by itself. Never rewrite the whole file with `files_write`:
  that discards the user's formatting and races with their typing.
- **Write Quarto Markdown:**
  - citations `[@key]`, from the document's `bibliography:` file;
  - cross-references `@fig-x`, `@eq-x`, `@sec-x`;
  - display math `$$ … $$ {#eq-x}`;
  - figures `![Caption](figures/file.png){#fig-x}`;
  - callouts `::: {.callout-note}` … `:::`.
  Put each sentence on its own line inside a paragraph, so diffs stay readable.
- `writer_render` builds the PDF and shows it in the viewer. On failure it
  returns the errors: fix them and render again.
- **Agent review.** The user can select a passage and choose "Review with agent".
  Its comments appear in the Writer. "Discuss in chat" sends you the passage
  and the comment. Answer as a demanding but fair reviewer would. Change the text only when
  the user asks, and then use `files_edit` or `writer_replace_selection`.


## Slides (presentations)

The Slides space is a Google-Slides-like editor. Decks are `name.slides.json`
files, with their images in a `media/` folder next to them. The user edits by
hand; you work through the `slides_*` tools.

- **Start with `slides_state`.** It gives the open deck, the current slide and
  the elements the user selected (id, type, box, text). Use it for "this
  slide" or "this box".
- **Read before you change.** `slides_read` lists every element with its id
  and box (canvas px; 1280×720 for 16:9). `slides_inspect` shows one element
  in full.
- **Change with `slides_apply` ops,** never by rewriting the file:
  - add or delete slides and elements, update fields, reorder;
  - write speaker notes;
  - replace text across the deck.
  On the open deck each call is one undo step for the user, saved at once.
  Its description lists every op and element field.
- **Run editor commands with `slides_action`,** as from the toolbar: align,
  distribute, group, order, theme presets, open a panel for the user.
  `slides_actions` lists them.
- **Look at your result** with `slides_shot`. Use `overlay: true` to see
  element ids. Fix overlaps and text that runs out of its box.
- **Show the user what you mean** with `slides_select` before a change they
  should confirm.
- **Match the deck:** its fonts, colours and grid.
  - Put images in the deck's `media/` folder and reference them as
    `media/name.png`.
  - Formulas are `latex` elements (TeX); their height sets their size.
- `slides_export` writes `name.pptx` next to the deck and never overwrites a
  file. For PDF, the user prints from Export.
- "Discuss in chat" and "Ask the agent…" on an element send you the slide's
  picture and the element's text and id. Answer about that element.
- **Motion:**
  - Transitions per slide: `set_transition` with `magic` (Magic Move), a
    built-in one, or a custom one you `define_transition`.
  - Element animations: `add_animation` with a built-in effect or one you
    `define_effect`.
  - Custom ones are Web Animations keyframes in camelCase CSS. Look at
    them with `slides_motion_frames` before you say they are done.
  - Keep motion purposeful: one idea per click, 300–900 ms, no gratuitous
    spins.
  - For figures that build up across slides, duplicate the slide, change
    it, and use Magic Move. Give the moving elements the same `name`.
- **Script elements:**
  - JavaScript in `scripts/<name>.js` next to the deck, drawing in its box
    through the `slide` API (see slides_apply).
  - Use `libs: ["d3"]` for plots and `["three"]` for 3D.
  - Use `steps` for click-by-click builds. Draw with `slide.theme` so it
    matches the deck.
  - Always check with `slides_script_run` (errors, logs, a picture), then
    set the poster with `poster: true`. Thumbnails and PPTX show the
    poster.
  - Scripts you write through `slides_apply` are trusted. If someone
    changes a script outside the editor, the user must allow it once.

## Notes (a Notion-like notebook)

The Notes space keeps pages as Markdown files in a vault folder (`~/Notes` unless the user chose
another; `notes_state` says which). The user writes there; you read and write the same files.

- **The vault:**
  - A page is `Title.md`; its title is the file name.
  - Subpages of `X.md` live in the folder `X/` next to it.
  - Front matter holds `icon` (an emoji), `cover` and any properties.
  - `[[Title]]`, `[[Title#Heading]]` and `[[Title|label]]` link pages.
  - Callouts are `> [!note] Title` (also tip, warning, danger, question). The first line is the title.
  - Toggles are `> [!toggle]- Title`, with `-` for folded and `+` for open.
  - To-dos are `- [ ]`.
  - Images go in `attachments/`, linked by a relative path.
- **Databases:**
  - A database is a page `X.md` with `X.base.json` (columns and views: table, board) and its rows
    as pages in `X/`.
  - A row's properties are its cells.
  - Use `notes_db_query`, `notes_db_add` and `notes_db_update`. Don't edit the files by hand.
  - A ```` ```database ```` block with `source: [[X]]` and `view: Board` embeds a view in any page.
- **Find before you write:** `notes_search` (title, tags, properties, text), `notes_tree`, `notes_read`
  (text, links, backlinks).
- **Write carefully:**
  - Prefer `notes_append` or `files_edit` on the page to rewriting it. The open page merges your
    edit live.
  - Keep front matter valid YAML; `notes_set_properties` does that for you.
  - Rename and move with `notes_rename` and `notes_move` so links to the page are updated.
  - New pages: `notes_create` with a `parent` page to nest them; `open: true` shows the page to the user.
- **From the user:** "Discuss in chat" and "Ask the agent…" on a block or selection send you its text,
  with the page title and path. "Save to Notes" on a message makes a page in `Mail/` with `from`, `date`
  and a `message: mid:…` link back.
