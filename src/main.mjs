#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { accountPolicy, defaultStatePath, initPolicy, loadEmailConfig, loadPolicy } from "./config.mjs";
import { classifyMailbox, fileReviewedMessage, overrideStatus, reviewPending, routeInbox, searchStatuses, undoLastRun } from "./workflow.mjs";

const execFileAsync = promisify(execFile);
const watcherService = "mail-mcp-workflow-watcher.service";

async function context() {
  return { accounts: await loadEmailConfig(), policy: await loadPolicy(), statePath: process.env.MAIL_WORKFLOW_STATE ?? defaultStatePath };
}
async function select(accountName) {
  const current = await context();
  const account = current.accounts.get(accountName);
  if (!account) throw new Error(`Unknown account: ${accountName}`);
  return { ...current, account, accountName };
}
function text(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function error(error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }

async function sync(accountName, dryRun = true) {
  const selected = await select(accountName);
  const routed = await routeInbox({ ...selected, dryRun });
  const classified = await classifyMailbox({ ...selected, policy: selected.policy, limit: 250 });
  const pending = await reviewPending({ ...selected, dryRun, limit: 250 });
  return { routed, classified: classified.length + pending.length, policy: accountPolicy(selected.policy, accountName) };
}

async function installWatcherService(account, seconds) {
  if (!account || !Number.isFinite(seconds) || seconds < 30) throw new Error("Usage: mail-workflow-mcp install-watcher-service <account> [seconds, minimum 30]");
  await select(account);
  const unitPath = resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), `systemd/user/${watcherService}`);
  const scriptPath = fileURLToPath(import.meta.url);
  await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
  await writeFile(unitPath, `[Unit]\nDescription=Mail MCP workflow watcher\n\n[Service]\nWorkingDirectory=${resolve(dirname(scriptPath), "..")}\nExecStart=${process.execPath} ${scriptPath} watch ${account} ${seconds} --apply\nRestart=on-failure\nRestartSec=15\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
  await chmod(unitPath, 0o600);
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", "--now", watcherService]);
  return { service: watcherService, account, interval_seconds: seconds, unit_path: unitPath };
}

async function runMcp() {
  const server = new McpServer({ name: "mail-workflow-mcp", version: "1.0.0" });
  server.tool("workflow_accounts", "List accounts visible to the provider-neutral workflow service.", {}, { readOnlyHint: true }, async () => {
    try { const current = await context(); return text([...current.accounts.keys()]); } catch (e) { return error(e); }
  });
  server.tool("classify_response_status", "Classify incoming messages and persist local response status without changing mail.", { account: z.string(), mailbox: z.string().default("INBOX"), limit: z.number().int().min(1).max(500).default(100) }, { destructiveHint: false }, async (params) => {
    try { return text(await classifyMailbox({ ...(await select(params.account)), mailbox: params.mailbox, limit: params.limit })); } catch (e) { return error(e); }
  });
  server.tool("search_response_status", "Search locally indexed mail by no-reply, replied, or unreplied status.", { account: z.string(), response_status: z.enum(["no-reply", "replied", "unreplied"]).optional() }, { readOnlyHint: true }, async (params) => {
    try { return text(await searchStatuses({ ...(await select(params.account)), status: params.response_status })); } catch (e) { return error(e); }
  });
  server.tool("set_response_status", "Set a user or agent response-status override in local workflow state; does not change email.", { account: z.string(), message_id: z.string(), response_status: z.enum(["no-reply", "replied", "unreplied"]), reason: z.string().min(1) }, { destructiveHint: false }, async (params) => {
    try { return text(await overrideStatus({ ...(await select(params.account)), messageId: params.message_id, status: params.response_status, reason: params.reason })); } catch (e) { return error(e); }
  });
  server.tool("review_pending_workflow", "Review Pending folders. Default dry run only proposes filing; non-dry runs obey local account policy.", { account: z.string(), dry_run: z.boolean().default(true), limit_per_folder: z.number().int().min(1).max(500).default(100) }, { destructiveHint: false }, async (params) => {
    try { return text(await reviewPending({ ...(await select(params.account)), dryRun: params.dry_run, limit: params.limit_per_folder })); } catch (e) { return error(e); }
  });
  server.tool("file_reviewed_pending_email", "Move a reviewed, non-urgent Pending message to Active/<group>. Local policy enforces approval and new-group rules.", { account: z.string(), mailbox: z.string(), uid: z.number().int().positive(), message_id: z.string(), group: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/), create_group: z.boolean().default(false) }, { destructiveHint: true }, async (params) => {
    try { return text(await fileReviewedMessage({ ...(await select(params.account)), mailbox: params.mailbox, uid: params.uid, messageId: params.message_id, group: params.group, createGroup: params.create_group })); } catch (e) { return error(e); }
  });
  server.tool("sync_workflow", "Apply or preview Inbox routing then classify statuses. Set dry_run=false only after account policy is configured.", { account: z.string(), dry_run: z.boolean().default(true) }, { destructiveHint: true }, async (params) => {
    try { return text(await sync(params.account, params.dry_run)); } catch (e) { return error(e); }
  });
  server.tool("undo_last_workflow_action", "Undo the last move or route action for an account using the local action journal.", { account: z.string() }, { destructiveHint: true }, async (params) => {
    try { return text(await undoLastRun(await select(params.account))); } catch (e) { return error(e); }
  });
  await server.connect(new StdioServerTransport());
}

const command = process.argv[2] ?? "stdio";
if (command === "help" || command === "--help" || command === "-h") console.log("Usage: mail-workflow-mcp [stdio|init|sync <account> [--apply]|watch <account> [seconds] [--apply]|install-watcher-service <account> [seconds]]");
else if (command === "init") console.log(`Created policy template: ${await initPolicy()}`);
else if (command === "sync") {
  const account = process.argv[3];
  if (!account) throw new Error("Usage: mail-workflow-mcp sync <account> [--apply]");
  console.log(JSON.stringify(await sync(account, process.argv.includes("--apply") ? false : true), null, 2));
} else if (command === "watch") {
  const account = process.argv[3];
  const seconds = Number(process.argv[4] ?? 300);
  const apply = process.argv.includes("--apply");
  if (!account || !Number.isFinite(seconds) || seconds < 30) throw new Error("Usage: mail-workflow-mcp watch <account> [seconds, minimum 30]");
  const run = async () => {
    const selected = await select(account);
    return routeInbox({ ...selected, dryRun: !apply });
  };
  await run();
  setInterval(() => { void run().catch((e) => console.error(e.message)); }, seconds * 1000);
  console.error(`Watching ${account} every ${seconds} seconds in ${apply ? "apply" : "dry-run"} mode.`);
} else if (command === "install-watcher-service") {
  const account = process.argv[3];
  const seconds = Number(process.argv[4] ?? 60);
  console.log(JSON.stringify(await installWatcherService(account, seconds), null, 2));
} else if (command === "stdio") await runMcp();
else throw new Error("Usage: mail-workflow-mcp [stdio|init|sync <account> [--apply]|watch <account> [seconds] [--apply]|install-watcher-service <account> [seconds]]");
