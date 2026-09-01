# Mail MCP Workspace

A portable, local setup for [email-mcp](https://github.com/codefuturist/email-mcp) and Thunderbird.

`email-mcp` gives an MCP-compatible AI client access to a mailbox over IMAP and SMTP. Thunderbird is a separate desktop client for the same mailbox. This repository does not modify Thunderbird, copy a Thunderbird profile, or connect to Thunderbird directly.

## What is included

- A version-pinned local installation of `@codefuturist/email-mcp`.
- Commands to configure, verify, and run the MCP server.
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
```

For Codex, add that block to `~/.codex/config.toml`. Restart the client after editing its configuration. Other MCP clients use the same command and argument in their equivalent user configuration.

## Everyday commands

```bash
npm run configure  # add or update an account interactively
npm run verify     # test all configured accounts
npm run mcp        # run the MCP server over stdio
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
