#!/usr/bin/env node
// Register this workspace's MCP servers with Claude Code in user scope, so agents
// started in any directory have them. The same on Linux, macOS and Windows:
//   node scripts/register-mcp.mjs [--remove]
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "listener-mcp/command";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = process.execPath;
const servers = {
  email: { command: node, args: [join(repo, "node_modules", "@codefuturist", "email-mcp", "dist", "main.js"), "stdio"] },
  "mail-workflow": { command: node, args: [join(repo, "src", "main.mjs"), "stdio"] },
  "mail-attachments": { command: node, args: [join(repo, "src", "attachments-main.mjs")] },
  "mail-gui": { command: node, args: [join(repo, "src", "gui-main.mjs")] },
};

const claude = (args) => runSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
for (const [name, server] of Object.entries(servers)) {
  try { claude(["mcp", "remove", "--scope", "user", name]); } catch { /* not registered yet */ }
  if (process.argv.includes("--remove")) { console.log(`removed ${name}`); continue; }
  claude(["mcp", "add-json", "--scope", "user", name, JSON.stringify({ type: "stdio", ...server })]);
  console.log(`registered ${name}: ${server.args[0]}`);
}
