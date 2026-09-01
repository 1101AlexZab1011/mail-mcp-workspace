# Mail MCP Workspace

A portable, local setup for [email-mcp](https://github.com/codefuturist/email-mcp) and Thunderbird.

`email-mcp` gives an MCP-compatible AI client access to a mailbox over IMAP and SMTP. Thunderbird is a separate desktop client for the same mailbox. This repository does not modify Thunderbird, copy a Thunderbird profile, or connect to Thunderbird directly.

## What is included

- A version-pinned local installation of `@codefuturist/email-mcp`.
- `mail-workflow-mcp`, an optional provider-neutral IMAP workflow server.
- Commands to configure, verify, and run the MCP server.
- Portable skills for Pending-mail review and chronological email summaries.
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
```

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

`mail-workflow-mcp` currently supports password-authenticated IMAP accounts
configured by email-mcp. Providers requiring OAuth-only access need an upstream
email-mcp OAuth extension before this workflow process can connect directly.

## Agent skills

- [email-review-pending](skills/email-review-pending/SKILL.md) reviews pending
  mail, reports urgent items, and files only non-urgent mail when policy allows.
- [email-summary](skills/email-summary/SKILL.md) summarizes received mail from
  the requested number of days in chronological order.

Copy a skill directory into the skill location used by Codex, Claude Code, or
another SKILL.md-compatible agent. The agent must also have access to the email
and workflow MCP servers above.

## Everyday commands

```bash
npm run configure  # add or update an account interactively
npm run verify     # test all configured accounts
npm run mcp        # run the MCP server over stdio
npm run workflow:mcp # run the workflow MCP server over stdio
npm test            # run local workflow tests
```

## Privacy and security

Credentials are deliberately kept outside the repository. Do not commit `~/.config/email-mcp/config.toml`, a Thunderbird profile, `.env` files, or MCP client configuration files. The provided `.gitignore` excludes common local credential files, but always inspect `git status` before committing.

This workspace only pins and configures the upstream server; email operations and the credential storage format are implemented by `@codefuturist/email-mcp`.

`npm audit` currently reports two high-severity findings inherited from the
upstream package's `nodemailer` dependency (GHSA-p6gq-j5cr-w38f). `npm audit
fix --dry-run` found no available automatic remediation. Review the advisory
before using this setup with untrusted message content, and keep the dependency
updated.

## License

The workspace documentation and configuration files are MIT licensed. The upstream `@codefuturist/email-mcp` dependency is separately licensed under LGPL-3.0-or-later.
