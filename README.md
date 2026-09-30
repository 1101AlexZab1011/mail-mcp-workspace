# Mail MCP Workspace

A portable, local setup for [email-mcp](https://github.com/codefuturist/email-mcp) and Thunderbird.

`email-mcp` gives an MCP-compatible AI client access to a mailbox over IMAP and SMTP. Thunderbird is a separate desktop client for the same mailbox. This repository does not modify Thunderbird, copy a Thunderbird profile, or connect to Thunderbird directly.

## What is included

- A version-pinned local installation of `@codefuturist/email-mcp`.
- `mail-workflow-mcp`, an optional provider-neutral IMAP workflow server.
- Commands to configure, verify, and run the MCP server.
- Portable skills for Pending-mail review and chronological email summaries.
- Mail Workspace, an optional Thunderbird add-on: chat and file docks, a file
  viewer, artifacts, paint, and agent control of the GUI, connected through
  [listener-mcp](https://github.com/1101AlexZab1011/listener-mcp).
- Documentation for setting up the same mailbox on another machine.

No account details, server addresses, passwords, OAuth tokens, or Thunderbird profiles are stored here.

## Requirements

- Node.js 24 or newer
- An IMAP/SMTP mail account (an app password is recommended when supported)
- Thunderbird, installed separately, if you want a graphical mail client

## Install on another machine

```bash
git clone https://github.com/YOUR-GITHUB-USER/mail-mcp-workspace.git
cd mail-mcp-workspace
npm ci
npm run configure
chmod 600 ~/.config/email-mcp/config.toml
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
```

Agent Chat's MCP server (`listener`) is added per project by `listener-mcp init`;
see [Mail Workspace for Thunderbird](#mail-workspace-for-thunderbird).

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
npm run workflow:install-watcher -- personal 60 # install/start a systemd user service
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

The service is named `mail-mcp-workflow-watcher.service`; manage it with
`systemctl --user status|stop|restart mail-mcp-workflow-watcher.service`.

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

Copy a skill directory into the skill location used by Codex, Claude Code, or
another SKILL.md-compatible agent. The agent must also have access to the email
and workflow MCP servers above.

## Mail Workspace for Thunderbird

Mail Workspace is an optional Thunderbird add-on (in `thunderbird-addon/`)
that turns Thunderbird into a workspace built around your agent.

- **No tab bar.** You navigate with the spaces sidebar: Mail, Address Book,
  Calendar, Tasks, Files, Artifacts and Paint.
- **Chat dock (right, open by default).** Drag to resize, minimize to a rail,
  or maximize. It stays visible in every space. <kbd>Ctrl</kbd>+<kbd>5</kbd>.
- **File browser dock (left, minimized by default).** Click any part of the
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
  `~/Artifacts`:
  - they're organised in a folder tree you can collapse, and reload live when
    their files change;
  - they're sandboxed: running commands, calling local HTTP services and
    touching files each need a permission that you approve per artifact.
- **Paint space.** Paste a screenshot, mark it up, and use **Send to agent**.
- **Agent control.** Through the `mail-gui` MCP server, the agent sees what's
  selected, opens spaces and files, and clicks or types anywhere in the GUI.
  Sending, deleting, moving mail and changing settings ask you first, in the
  chat.
- **Redesign.** Material Symbols icons and a light/dark palette applied to
  Thunderbird's own UI.

Parts:

| Part | What it is |
|------|------------|
| `thunderbird-addon/` | The add-on: an Experiment API for the layout, theme and automation, plus the pages for chat, files, viewer, artifacts and paint |
| `src/workspace/`, `src/workspace-main.mjs` | Workspace host on `127.0.0.1:47810`: files, conversions, highlighting, artifacts and grants |
| `src/gui-main.mjs` | `mail-gui` MCP server: GUI, viewer, files, paint and artifact tools |
| [listener-mcp](https://github.com/1101AlexZab1011/listener-mcp) | Local broker the add-on and agents talk through (chat on `mail/chat/*`, GUI commands on `mail/gui/commands`) |

Set it up on each machine:

```bash
npm install -g --allow-git=root github:1101AlexZab1011/listener-mcp
listener-mcp service install             # broker, systemd user service
npm ci                                   # add-on and host dependencies
node src/workspace-main.mjs install-service   # workspace host, systemd user service
listener-mcp init --agent claude,codex --channels 'mail/chat/**' --group mail-chat --from now --credential email-agent
npm run chat:addon                       # builds dist/agent-chat.xpi
```

Install `dist/agent-chat.xpi` from **Add-ons and Themes → gear menu → Install
Add-on From File**. Then pair the add-on:

1. Open its settings page, which shows the exact `listener-mcp pair …`
   command.
2. Run that command.
3. Press **Pair now**, or restart Thunderbird within ten minutes.

For GUI control, the agent's credential also needs the GUI and workspace
scopes:

```bash
listener-mcp token create --name email-agent --replace --save --scopes \
  'subscribe:mail/chat/**,publish:mail/chat/**,read:mail/chat/**,publish:mail/gui/commands,read:mail/gui/**,read:mail/workspace/files,publish:mail/workspace/artifacts,read:mail/workspace/artifacts,blobs'
```

The agent's token deliberately lacks `publish:mail/workspace/grants` and
`…/capabilities`. It can write an artifact, but only you can allow what the
artifact may do.

To start chatting, run `/email-start-chat` in Claude Code or Codex (restart the
agent after `init`). The `mail-workspace` skill teaches the agent the GUI
tools. Disabling the add-on restores Thunderbird's own layout, tab bar and
look.

**Development.** Start Thunderbird with `node scripts/tb.mjs restart` (it
enables Marionette), then:

- `node scripts/tb.mjs install` loads the add-on from its folder;
- `node scripts/tb.mjs shot out.png` takes a screenshot;
- `node scripts/gui.mjs state` sends GUI commands the way the agent does.

`node scripts/build-icons.mjs` and `node scripts/vendor.mjs` regenerate the
icon set and the vendored PDF.js.

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
outside the repository (`~/.config/listener-mcp/`, `~/.local/state/listener-mcp/`).

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
