<p align="center"><img src="assets/brand/thoth.svg" width="128" height="128" alt="Thoth"></p>

<h1 align="center">Thoth</h1>

<p align="center">Mail, calendar, tasks, documents and an AI agent in one workspace.</p>

Thoth is a desktop workspace built on Thunderbird: mail, calendar and tasks,
a document editor, slides, drawing, notes, a browser and a terminal, with an
AI agent that works in all of them through MCP. This repository holds the
app (the `thunderbird-addon/` folder), its MCP servers and the setup around
[email-mcp](https://github.com/codefuturist/email-mcp).

`email-mcp` gives an MCP-compatible AI client access to a mailbox over IMAP and SMTP, independently of the app. Nothing here copies a Thunderbird profile or changes Thunderbird itself; Thoth runs as an add-on.

## What is included

- A version-pinned local installation of `@codefuturist/email-mcp`.
- `mail-workflow-mcp`, an optional provider-neutral IMAP workflow server.
- Commands to configure, verify, and run the MCP server.
- Portable skills for Pending-mail review and chronological email summaries.
- Thoth itself, installed into Thunderbird as an add-on: chat and file docks, a file
  viewer, artifacts, paint, and agent control of the GUI, connected through
  [listener-mcp](https://github.com/1101AlexZab1011/listener-mcp).
- Documentation for setting up the same mailbox on another machine.

No account details, server addresses, passwords, OAuth tokens, or Thunderbird profiles are stored here.

## Requirements

Linux, macOS or Windows 10/11, with:

- Node.js 24 or newer, and Git (npm fetches listener-mcp from GitHub)
- An IMAP/SMTP mail account (an app password is recommended when supported)
- Thunderbird 140 or newer, installed separately, if you want a graphical mail client

Optional programs, each used for one part of the workspace:

| Program | Used for | Linux | macOS | Windows |
|---------|----------|-------|-------|---------|
| LibreOffice | viewing Word and PowerPoint files | package manager | `brew install --cask libreoffice` | `winget install TheDocumentFoundation.LibreOffice` |
| Inkscape | Draw: path operations, PDF and PNG export | package manager | `brew install --cask inkscape` | `winget install Inkscape.Inkscape` |
| Quarto | Writer: rendering documents | package manager | `brew install --cask quarto` | `winget install Posit.Quarto` |
| Tesseract | PDF: recognizing text in scans (OCR) | `tesseract-ocr` and `tesseract-ocr-<language>` | `brew install tesseract tesseract-lang` | `winget install UB-Mannheim.TesseractOCR` |
| LanguageTool (Java) | Writer: grammar checks | package manager | `brew install languagetool` | unpack the download, set `LANGUAGETOOL_HOME` |

They are found on `PATH` or where their installers put them (the app bundle on
macOS, Program Files on Windows). `MAIL_WORKSPACE_INKSCAPE`,
`MAIL_WORKSPACE_SOFFICE`, `MAIL_WORKSPACE_TESSERACT` and `QUARTO` point at a
program anywhere else. LibreOffice also lets the PDF space create a PDF from a
Word file.

On Windows, run the commands below in PowerShell (or Git Bash), in a normal
terminal window. Not in a terminal that runs inside a packaged (MSIX) app,
such as the Claude desktop app's terminal: Windows keeps what such an app
creates in `%APPDATA%` and `%LOCALAPPDATA%` private to it
(`%LOCALAPPDATA%\Packages\<app>\LocalCache`), so Thunderbird, the logon
tasks and the taskbar would not see Thoth's profile, listener-mcp's tokens
or the settings. `npm run thoth:install` and `npm run services:install`
check this and stop with that message. An agent in such an app can still
use Thoth afterwards; it only must not do the setup.

## Install on another machine

```bash
git clone https://github.com/YOUR-GITHUB-USER/mail-mcp-workspace.git
cd mail-mcp-workspace
npm ci
npm run configure
chmod 600 ~/.config/email-mcp/config.toml   # Linux and macOS
npm run verify
```

`npm run configure` opens the upstream interactive setup wizard. It discovers or asks for your account's IMAP/SMTP settings and writes credentials only to `~/.config/email-mcp/config.toml` on that machine.

Add the same account independently in Thunderbird using its account setup screen. Thunderbird keeps its own profile and credentials; they are not needed by this repository.

## Connect an MCP client

Use the locally installed, locked dependency in your MCP client's user-level configuration. Replace `/absolute/path/to/mail-mcp-workspace` with this clone's actual path:

```toml
[mcp_servers.email]
command = "/absolute/path/to/mail-mcp-workspace/node_modules/.bin/email-mcp"
args = ["stdio"]

[mcp_servers.mail_workflow]
command = "node"
args = ["/absolute/path/to/mail-mcp-workspace/src/main.mjs", "stdio"]

[mcp_servers.mail_attachments]
command = "node"
args = ["/absolute/path/to/mail-mcp-workspace/src/attachments-main.mjs"]

[mcp_servers.mail_gui]
command = "node"
args = ["/absolute/path/to/mail-mcp-workspace/src/gui-main.mjs"]

[mcp_servers.loom]
command = "node"
args = ["/absolute/path/to/mail-mcp-workspace/src/loom-main.mjs"]
```

For Claude Code, register the same servers in user scope, so agents started in
any directory have them. On any system:

```bash
node scripts/register-mcp.mjs     # --remove takes them out again
```

or by hand (bash):

```bash
repo=/absolute/path/to/mail-mcp-workspace
claude mcp add-json --scope user email "{\"command\":\"$repo/node_modules/.bin/email-mcp\",\"args\":[\"stdio\"]}"
claude mcp add-json --scope user mail-workflow "{\"command\":\"node\",\"args\":[\"$repo/src/main.mjs\",\"stdio\"]}"
claude mcp add-json --scope user mail-attachments "{\"command\":\"node\",\"args\":[\"$repo/src/attachments-main.mjs\",\"stdio\"]}"
claude mcp add-json --scope user mail-gui "{\"command\":\"node\",\"args\":[\"$repo/src/gui-main.mjs\"]}"
claude mcp add-json --scope user loom "{\"command\":\"node\",\"args\":[\"$repo/src/loom-main.mjs\"]}"
```

Agent Chat's MCP server (`listener`) is added for every agent session by
`listener-mcp init --user`; see
[Thoth for Thunderbird](#mail-workspace-for-thunderbird).

For Codex, add both blocks to `~/.codex/config.toml`. Restart the client after editing its configuration. Other MCP clients use the same command and argument in their equivalent user configuration.

## Workflow automation

The optional workflow MCP server is provider-neutral: it uses IMAP and the
existing local `email-mcp` account configuration, but keeps its policy and state
outside this repository.

```bash
npm run workflow:init              # create ~/.config/mail-mcp-workspace/policy.toml
npm run workflow:sync -- personal  # preview routing, status classification, and filing
npm run workflow:sync -- personal --apply
npm run workflow:watch -- personal 300 --apply
npm run services:install -- --watch personal --every 60   # run the watcher at login
```

Start with the generated policy's `review` mode. The supported filing modes are
`review`, `propose`, `existing-folders`, and `managed-groups`; the last two are
explicit opt-ins. In `existing-folders` mode, only allowlisted Active folders
can receive automatic moves. New groups require `managed-groups` plus
`allow_new_groups = true`. Every move is recorded in a local action journal and
can be undone with the `undo_last_workflow_action` MCP tool.

For accounts with provider-side filtering, leave `routing_mode = "provider"`.
For a generic IMAP fallback, choose `routing_mode = "watcher"` and configure
account-local subject rules. Never enable both routing mechanisms for one
account at the same time.

The installed watcher polls every 60 seconds by default. Its first live run
stores a per-folder UID baseline and never copies existing mail. Later runs copy
only newly delivered mail from `INBOX` and other eligible delivery folders (for
example, `Additional` or `Important`) into `Pending/<group>`, preserving the
original delivery in its source folder. The original is marked read and the
Pending copy is unread. It never watches
`Active`, `Archived`, `Drafts`, `Junk`, `Pending`, `Sent`, or `Trash`. To use a
strict source allowlist instead, set it in the account policy:

```toml
[accounts.personal]
routing_mode = "watcher"
routing_source_mailboxes = ["INBOX", "Additional", "Important"]
```

`npm run services:status` shows it. The service is a systemd user unit
`mail-mcp-workflow-watcher.service` on Linux, the launchd agent
`dev.mail-workspace.watcher` on macOS, and the logon task
`mail-mcp-workflow-watcher` on Windows; its log is `watcher.log` in the
workspace's state folder (see [Files on each system](#files-on-each-system)).

`mail-workflow-mcp` currently supports password-authenticated IMAP accounts
configured by email-mcp. Providers requiring OAuth-only access need an upstream
email-mcp OAuth extension before this workflow process can connect directly.

## Agent skills

- [email-review-pending](skills/email-review-pending/SKILL.md) reviews pending
  mail, reports urgent items, and files only non-urgent mail when policy allows.
- [email-summary](skills/email-summary/SKILL.md) summarizes received mail from
  the requested number of days in chronological order.
- [email-start-chat](skills/email-start-chat/SKILL.md) starts, handles and
  stops the Agent Chat conversation.
- [listener](skills/listener/SKILL.md) is listener-mcp's general skill for
  receiving app events.
- [loom](skills/loom/SKILL.md) keeps Loom's plans true while the agent works:
  it registers the plan, moves steps, puts the branch on it and reports what
  blocks it.

Copy a skill directory into the skill location used by Codex, Claude Code, or
another SKILL.md-compatible agent. The agent must also have access to the email
and workflow MCP servers above.

## Thoth for Thunderbird

Thoth is an optional Thunderbird add-on (in `thunderbird-addon/`)
that turns Thunderbird into a workspace built around your agent.

- **One window, no tab bar, no top bar.** You navigate with the spaces
  sidebar: Mail, Address Book, Calendar, Tasks, Files, Artifacts and Paint.
  Double-clicking a message shows it in the message pane instead of a new
  window. <kbd>Ctrl</kbd>+<kbd>F</kbd> opens a floating search box.
- **Panels never overlap.** Widening a dock minimizes other panels (the other
  dock, Today pane, folder pane, message pane) and restores them as you shrink
  it again. When there is nothing left to minimize, the dock stops growing.
- **Chat dock (right, open by default).** Drag to resize, minimize to a rail,
  or maximize. It stays visible in every space. <kbd>Ctrl</kbd>+<kbd>5</kbd>.
- **File browser dock (left, minimized by default).** Toggle it from the
  spaces sidebar. Click any part of the
  path to go up, or type a path. It shows a VS Code-style tree with Material
  Icon Theme icons. <kbd>Ctrl</kbd>+<kbd>6</kbd>.
- **Files space: a read-only viewer.** It shows:
  - PDF;
  - Word, ODT, PowerPoint and ODP (converted to PDF with LibreOffice);
  - Excel, ODS and CSV;
  - markdown, and code (Shiki, about 300 languages) or text;
  - images, GIF and SVG;
  - audio (with a waveform) and video.
- **Artifacts space.** React apps the agent builds for you, stored in
  `~/Artifacts`, with the library on the left:
  - they're organised in a folder tree you can collapse, and reload live when
    their files change;
  - they're sandboxed: running commands, calling local HTTP services and
    touching files each need a permission that you approve per artifact.
- **Paint space.** Paste a screenshot, mark it up, and use **Send to agent**.
  It has rectangle, lasso and polygon selection (cut, copy, delete, move),
  a resizable canvas, and the usual paint shortcuts while it has focus
  (<kbd>?</kbd> lists them).
- **Writer space.** A word processor for papers in Quarto (`.qmd`, `.md`),
  laid out like ONLYOFFICE's document editor: ribbon tabs, rulers, the
  document on sheets of its paper, side panels and a status bar.
  - **File:** create, open, save, a copy, print, Info (title, authors, date,
    abstract and the Quarto header) and Download As: DOCX, PDF, ODT, MD, RTF,
    TXT, FB2, EPUB and HTML, through Quarto.
  - **Home:** font, size, case, bold to subscript, highlight and font colours,
    lists, indents, alignment, line spacing, formatting marks, the style
    gallery, and Find and Replace (<kbd>Ctrl</kbd>+<kbd>F</kbd>/<kbd>H</kbd>).
  - **Insert:** page breaks, tables, images, comments, links, the date,
    equations and symbols.
  - **Layout:** margins, orientation, size, columns, line numbers
    (continuous or per page) and the paragraph's indents and spacing. The
    rulers drag margins and indents.
  - **References:** table of contents, footnotes, bookmarks,
    cross-references, citations and the bibliography. Citations and
    cross-references read as in the PDF: "(Smith and Jones 2020)", "Figure 2".
  - **Collaboration:** comments, track changes (kept in Pandoc's form, so the
    Word export has them as Word's own), display modes, accept and reject,
    "Review with agent" and spell checking (LanguageTool).
  - **View:** headings, zoom and fit, and which bars show.
  - A document without its own page settings is set as Word sets a new one
    (A4, 2.5 cm margins, 12 pt Times New Roman or a metric twin), on the page
    and in the PDF and Word file alike. Formatting Markdown has no syntax for
    is written the Pandoc way (`[text]{.underline}`,
    `[text]{style="color: #C00000"}`, `::: {style="text-align: center"}`),
    which the exports honour; untouched paragraphs are saved byte for byte.
- **PDF space.** A PDF editor like Acrobat, on MuPDF, laid out as the Writer
  is; .pdf files open in it (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>0</kbd>).
  Edits stay in the document, with undo, until you save.
  - **File:** create a PDF from a blank page, by combining files, from a Word
    file or from images; open, recent files, Save As, Download As (PDF, Word,
    Excel, PNG, JPEG, text), print and the document's properties.
  - **Home and View:** zoom and fit, one or two pages, rotation, thumbnails,
    bookmarks and search with results in context.
  - **Comment:** sticky notes, text boxes, highlight, underline, strike-out,
    drawing, shapes, arrows and stamps, with replies and status in a
    comments panel.
  - **Fill & Sign:** form fields filled in place, ticks, crosses, dates, and
    a signature typed, drawn or from an image; flatten.
  - **Pages:** reorder by dragging thumbnails, insert pages or files, delete,
    rotate, duplicate, crop, extract and split.
  - **Edit:** change the document's own text and images in place, keeping
    the paragraph's font, size and colour; add text and images.
  - **Protect:** true redaction (what is under the marks is removed from the
    file), passwords and permissions (AES-256), sanitizing.
  - **Tools:** recognize text in scans (Tesseract), compress, export to Word
    and Excel, and compare two versions.
- **Loom: projects, branches and plans** (in the Files group). Add a folder
  with a git repository as a project and Loom shows it the way GitKraken
  does: every branch, remote and tag on a lane graph, the selected commit,
  branches with ahead/behind, worktrees, and the working tree's state. Check
  out, branch, merge (with abort on conflicts), fetch, pull and push from the
  graph; each asks first. The **Plans** tab is a board (Ideas → Planned → In
  progress → Done) of the project's plans: rough ideas for later, and exact
  plans with steps that agents move as they work, each on its branch. Plans
  are pages of a database in your Notes vault (`Loom/<project>/Plans`), so you
  can read and edit them there too. Agents get Loom through the `loom` MCP
  server and skill (see [Loom for agents](#loom-for-agents)).
- **Terminal.** <kbd>Ctrl</kbd>+<kbd>`</kbd> slides a terminal up over the
  window, with tabs and horizontal or vertical splits. The agent can open
  terminals and run commands in them; you see everything it types.
- **Agent control.** Through the `mail-gui` MCP server, the agent sees what's
  selected, opens spaces and files, and clicks or types anywhere in the GUI.
  Sending, deleting, moving mail and changing settings ask you first, in the
  chat.
- **Redesign.** Material Symbols icons, styled tooltips, and a System, Light
  or Dark appearance applied to Thunderbird's own UI. The settings page also
  picks the code viewer's theme from 15 popular ones (One Dark Pro by
  default).

Parts:

| Part | What it is |
|------|------------|
| `thunderbird-addon/` | The add-on: an Experiment API for the layout, theme and automation, plus the pages for chat, files, viewer, artifacts and paint |
| `src/workspace/`, `src/workspace-main.mjs` | Workspace host on `127.0.0.1:47810`: files, conversions, highlighting, artifacts, grants and terminals |
| `src/gui-main.mjs` | `mail-gui` MCP server: GUI, viewer, files, paint, artifact, PDF, settings and terminal tools |
| `src/loom-main.mjs`, `src/loom-tools.mjs` | `loom` MCP server: Loom's projects, plans and git actions for agents |
| [listener-mcp](https://github.com/1101AlexZab1011/listener-mcp) | Local broker the add-on and agents talk through (chat on `mail/chat/*`, GUI commands on `mail/gui/commands`) |

Set it up on each machine:

```bash
npm install -g --allow-git=root github:1101AlexZab1011/listener-mcp
listener-mcp service install             # the broker, started at login
npm ci                                   # add-on and host dependencies
npm run services:install                 # the workspace host, started at login
listener-mcp init --user --agent claude,codex   # listener MCP server, hooks and skill for every session
listener-mcp app add mail --credential email-agent --group "mail-chat-{instance}" --channels "mail/chat/{instance},mail/replies/{instance}/**" --from now --exclusive --single-instance
listener-mcp token create --name mail-watcher --scopes "publish:mail/replies/**,read:mail/chat/sessions" --save   # reply announcements
npm run thoth:install                    # Thoth itself: its profile, the add-on, and a "Thoth" app entry; starts it
```

Thoth runs in Thunderbird, in a profile of its own, so starting Thoth always
opens Thoth and a Thunderbird you already use stays as it was.
`npm run thoth:install` (Thunderbird must be installed first):

- creates the profile (`~/.local/share/thoth`, `~/Library/Application
  Support/Thoth` or `%APPDATA%\Thoth`) with the add-on installed and enabled,
  and without Thunderbird's start page, What's New, donation and default-client
  prompts or data collection;
- pairs the add-on with listener-mcp, so the chat works on the first start;
- adds **Thoth** where you start apps, with its icon: the app menu on Linux,
  the Start menu and the desktop on Windows, `~/Applications/Thoth.app` on
  macOS. Thoth's windows carry its icon too.

Start it from there, or with `npm run thoth`. Running `thoth:install` again
updates the add-on and keeps your profile; `npm run thoth:uninstall` removes
the app entry (`-- --purge` also deletes the profile with its accounts and
local mail). Thoth updates itself afterwards (Settings → Updates).

The commands are the same on every system. `service install` and
`services:install` set up per-user services: systemd user units on Linux,
launchd agents on macOS, logon tasks on Windows (they run hidden, and restart
after a failure).

Agent Chat holds several **sessions**, each its own conversation with its own
agent. Click the agent icon in the chat header to switch, rename, delete or
create one. A new session is called "Agent N" (the lowest free N) and opens
with its name selected, so you can type the real one at once. Agent 1 can be
renamed but not deleted.

`app add` registers mail as the app `mail` with one listener group per session
(`{instance}` is the session id), so a session in any directory can start
Agent Chat. Each session holds one agent, and an agent holds one session:
`/email-start-chat Presentations` attaches it there, or moves it if it was in
another session. Reply and mail-watch notifications go to the session that set
them up. To make the skills available outside this repository, link them into
your user skill folders:

```bash
for skill in email-start-chat email-compose email-review-pending email-summary mail-workspace loom; do
  ln -sfn "$PWD/skills/$skill" ~/.claude/skills/$skill
  ln -sfn "$PWD/skills/$skill" ~/.agents/skills/$skill   # Codex
done
```

On Windows (PowerShell), junctions need no administrator rights:

```powershell
foreach ($skill in "email-start-chat","email-compose","email-review-pending","email-summary","mail-workspace","loom") {
  New-Item -ItemType Junction -Force -Path "$HOME\.claude\skills\$skill" -Target "$PWD\skills\$skill"
}
```

If the chat says it is not paired (the pairing waits ten minutes for Thoth's
first start), open Settings → Agent connection, run the `listener-mcp pair …`
command it shows, and press **Pair now**.

For GUI control, the agent's credential also needs the GUI and workspace
scopes. The command replaces the credential `app add` made, so it repeats
that one's chat and reply scopes (without `mail/replies`, attaching fails
with "may not subscribe on mail/replies/…"):

```bash
listener-mcp token create --name email-agent --replace --save --scopes "subscribe:mail/chat/**,publish:mail/chat/**,read:mail/chat/**,subscribe:mail/replies/**,publish:mail/replies/**,read:mail/replies/**,publish:mail/gui/commands,read:mail/gui/**,read:mail/workspace/files,publish:mail/workspace/fs,publish:mail/workspace/render,publish:mail/workspace/artifacts,read:mail/workspace/artifacts,publish:mail/workspace/terminal,blobs"
```

The agent's token deliberately lacks `publish:mail/workspace/grants` and
`…/capabilities`. It can write an artifact, but only you can allow what the
artifact may do.

With `publish:mail/workspace/fs` the agent writes, edits, moves and creates
files and folders anywhere in your home folder, except credential folders
such as `~/.ssh` and `~/.gnupg`. Writes are atomic and refuse to overwrite a
file that changed since it was read. Trashing needs
`publish:mail/workspace/fs-trash`, which only the add-on has, so the agent's
`files_trash` always asks you in the chat first.

### Loom for agents

The `loom` MCP server (registered by `scripts/register-mcp.mjs`) gives an
agent Loom's projects, plans and git actions. It works through the workspace
host, so Thoth need not be open, and the screen follows what the agent does.
It uses a listener-mcp credential of its own, `loom-agent` (`LOOM_CREDENTIAL`
names another), with Loom's and git's scopes:

```bash
listener-mcp token create --name loom-agent --save --scopes "read:mail/workspace/loom,publish:mail/workspace/loom,read:mail/workspace/git,publish:mail/workspace/git"
```

Link the [loom skill](skills/loom/SKILL.md) with the others above. Tools take
a `project` (id, name or folder) and default to the project the agent's
working folder is in:

| Tool | What it does |
|------|--------------|
| `loom_projects`, `loom_project_add` | The projects, and which one the agent is in; add a repository |
| `loom_status` | Branch, worktree state, branches, worktrees, recent commits, unfinished plans |
| `loom_plans`, `loom_plan_get` | Plans by status, branch or agent; one plan with its steps and history |
| `loom_plan_create`, `loom_plan_update` | New idea or plan; status, branch, agent, priority, title, description |
| `loom_step`, `loom_steps_add` | Move a step (running, done, blocked with a note, skipped, pending); add steps |
| `loom_git` | checkout, branch, delete_branch, merge, abort_merge, fetch, pull, push |

### Files on each system

| What | Linux | macOS | Windows |
|------|-------|-------|---------|
| Mail accounts (email-mcp) | `~/.config/email-mcp` | `~/.config/email-mcp` | `%USERPROFILE%\.config\email-mcp` |
| Workflow policy and state | `~/.config/mail-mcp-workspace`, `~/.local/state/mail-mcp-workspace` | `~/Library/Application Support/mail-mcp-workspace` | `%APPDATA%\mail-mcp-workspace` |
| Workspace settings, grants, logs, editor backups | `~/.config/mail-workspace`, `~/.local/state/mail-workspace` | `~/Library/Application Support/mail-workspace` | `%APPDATA%\mail-workspace` |
| Workspace cache | `~/.cache/mail-workspace` | `~/Library/Caches/mail-workspace` | `%LOCALAPPDATA%\mail-workspace\Cache` |
| listener-mcp tokens | `~/.config/listener-mcp` | `~/Library/Application Support/listener-mcp` | `%APPDATA%\listener-mcp` |

What else differs:

- **Trash.** Deleting goes to the system's Trash: the freedesktop Trash, the
  macOS Trash, or the Recycle Bin. Restoring works from the workspace and from
  the file manager.
- **Shells.** The terminal opens your login shell; on Windows, PowerShell 7 if
  it is installed, else Windows PowerShell (`MAIL_WORKSPACE_SHELL` picks
  another). Artifact commands run in bash, and in PowerShell on Windows
  (`MAIL_WORKSPACE_EXEC_SHELL=bash` uses Git Bash there).
- **Shortcuts.** On macOS, <kbd>⌘</kbd> replaces <kbd>Ctrl</kbd> in the
  workspace's shortcuts, and the hints say so. <kbd>Ctrl</kbd>+<kbd>`</kbd>
  stays the terminal, since <kbd>⌘</kbd>+<kbd>`</kbd> switches windows.

To start chatting, run `/email-start-chat <session name>` in Claude Code or
Codex, in any directory (restart the agent after `init --user`). The `mail-workspace` skill teaches the agent the GUI
tools. Disabling the add-on restores Thunderbird's own layout, tab bar and
look.

**Development** (Linux). Start Thunderbird with `node scripts/tb.mjs restart` (it
enables Marionette), then:

- `node scripts/tb.mjs install` loads the add-on from its folder;
- `node scripts/tb.mjs shot out.png` takes a screenshot;
- `node scripts/gui.mjs state` sends GUI commands the way the agent does.

`node scripts/build-icons.mjs` and `node scripts/vendor.mjs` regenerate the
icon set and the vendored PDF.js and xterm.js. `tb.mjs` starts Thunderbird with
`--class Firefox` (override with `TB_WM_CLASS`) so a window-manager rule can
keep it on its own workspace.

## Everyday commands

```bash
npm run configure  # add or update an account interactively
npm run verify     # test all configured accounts
npm run mcp        # run the MCP server over stdio
npm run workflow:mcp # run the workflow MCP server over stdio
npm run chat:addon   # build the Thunderbird add-on package
listener-mcp status 'mail/chat/**' # who is listening to Agent Chat
npm test            # run local workflow tests
```

## Privacy and security

Credentials are deliberately kept outside the repository. Do not commit `~/.config/email-mcp/config.toml`, a Thunderbird profile, `.env` files, or MCP client configuration files. The provided `.gitignore` excludes common local credential files, but always inspect `git status` before committing.

Agent Chat's tokens and conversation history belong to listener-mcp and live
outside the repository (see [Files on each system](#files-on-each-system)).

- The broker binds only to `127.0.0.1` and checks the `Host` header.
- Every request needs a token, scoped here to `mail/chat/**`.
- The add-on's token works only from the add-on's own origin.
- The chat tools only exchange chat events: they can't send email, modify
  mail, or execute commands.

This workspace only pins and configures the upstream server; email operations and the credential storage format are implemented by `@codefuturist/email-mcp`.

`npm audit` currently reports two high-severity findings inherited from the
upstream package's `nodemailer` dependency (GHSA-p6gq-j5cr-w38f). `npm audit
fix --dry-run` found no available automatic remediation. Review the advisory
before using this setup with untrusted message content, and keep the dependency
updated.

## License

The workspace documentation and configuration files are MIT licensed. The upstream `@codefuturist/email-mcp` dependency is separately licensed under LGPL-3.0-or-later.

The PDF space uses [MuPDF](https://mupdf.com/) (mupdf.js), vendored into `thunderbird-addon/vendor/mupdf/`, under its AGPL-3.0 licence (`vendor/mupdf/LICENSE`).

The Slides editor in `slides/` is a fork of [PPTist](https://github.com/pipipi-pikachu/PPTist) and stays under its AGPL-3.0 licence (`slides/LICENSE`); so does its build, vendored into `thunderbird-addon/vendor/slides/`.
