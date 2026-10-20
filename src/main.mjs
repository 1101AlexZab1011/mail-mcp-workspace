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
import { defaultSubscriptionsPath, list as listSubscriptions, listWatches, subscribe, unsubscribe, unwatch, watch } from "./subscriptions.mjs";
import { classifyMailbox, fileReviewedMessage, overrideStatus, reviewPending, routeInbox, searchStatuses, undoLastRun, watchReplies } from "./workflow.mjs";

const execFileAsync = promisify(execFile);
const watcherService = "mail-mcp-workflow-watcher.service";
// The Agent Chat session whose agent a notification wakes; the skill passes its own.
const chatParam = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional().describe("Agent Chat session id to wake (default: Agent 1, id \"default\")");

async function context() {
  return { accounts: await loadEmailConfig(), policy: await loadPolicy(), statePath: process.env.MAIL_WORKFLOW_STATE ?? defaultStatePath, subscriptionsPath: process.env.MAIL_WORKFLOW_SUBSCRIPTIONS ?? defaultSubscriptionsPath };
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
  server.tool("subscribe_thread", "Watch a sent message's thread: when a reply arrives, the workflow watcher publishes a mail.reply event on mail/replies/<chat>/<account> that wakes the agent attached to that Agent Chat session. Works for any Message-ID, including mail already sent.", { account: z.string(), message_id: z.string().min(1), subject: z.string().optional(), note: z.string().max(500).optional(), chat: chatParam, days: z.number().int().min(1).max(365).default(30) }, { destructiveHint: false }, async (params) => {
    try { const selected = await select(params.account); return text(await subscribe(selected.subscriptionsPath, { account: params.account, messageId: params.message_id, subject: params.subject, note: params.note, chat: params.chat, days: params.days })); } catch (e) { return error(e); }
  });
  server.tool("unsubscribe_thread", "Stop watching a thread for replies. Any Message-ID in the thread identifies it.", { account: z.string(), message_id: z.string().min(1) }, { destructiveHint: false }, async (params) => {
    try { const selected = await select(params.account); return text(await unsubscribe(selected.subscriptionsPath, { account: params.account, messageId: params.message_id })); } catch (e) { return error(e); }
  });
  server.tool("watch_mail", "Watch incoming mail by sender and/or subject, for notifications that are not replies to anything (Booking.com, Steam, PayPal). A matching message publishes a mail.watch event on mail/replies/<chat>/<account> that wakes the agent attached to that Agent Chat session. from is one address or a whole domain written as \"@example.org\"; subject lists words that must all appear in the subject; give one or both. account \"*\" watches every connected account.", { account: z.string(), from: z.string().optional(), subject: z.string().optional(), note: z.string().max(500).optional(), chat: chatParam, days: z.number().int().min(1).max(365).default(30) }, { destructiveHint: false }, async (params) => {
    try {
      const current = await context();
      if (params.account !== "*" && !current.accounts.has(params.account)) throw new Error(`Unknown account: ${params.account}`);
      return text(await watch(current.subscriptionsPath, { account: params.account, from: params.from, subject: params.subject, note: params.note, chat: params.chat, days: params.days }));
    } catch (e) { return error(e); }
  });
  server.tool("unwatch_mail", "Stop a mail watch, by the id that watch_mail or list_subscriptions shows.", { id: z.string().min(1) }, { destructiveHint: false }, async (params) => {
    try { const current = await context(); return text(await unwatch(current.subscriptionsPath, { id: params.id })); } catch (e) { return error(e); }
  });
  server.tool("list_subscriptions", "List what is being watched: threads awaiting replies and mail watches (sender/subject), with notes, expiry and what was already announced.", { account: z.string().optional() }, { readOnlyHint: true }, async (params) => {
    try { const current = await context(); return text({ threads: await listSubscriptions(current.subscriptionsPath, { account: params.account }), watches: await listWatches(current.subscriptionsPath, { account: params.account }) }); } catch (e) { return error(e); }
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
    const result = await routeInbox({ ...selected, dryRun: !apply });
    for (const reply of result.replies?.delivered ?? []) console.error(`Announced reply ${reply.message_id} from ${reply.from} (${reply.mailbox}).`);
    for (const reply of result.replies?.failed ?? []) console.error(`Could not announce reply ${reply.message_id}: ${reply.error}`);
    if (result.replies?.error) console.error(`Reply check failed: ${result.replies.error}`);
    // Every other connected account is checked for replies to its subscribed threads; one
    // unreachable account must not stop the others or the routing above.
    if (apply) for (const [name, other] of selected.accounts) {
      if (name === account || accountPolicy(selected.policy, name).routing_mode === "watcher") continue;
      try {
        // A server that stalls mid-command would otherwise hold the whole loop forever.
        const watched = await Promise.race([
          watchReplies({ ...selected, accountName: name, account: other }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 90 s")), 90_000).unref()),
        ]);
        for (const reply of watched.replies?.delivered ?? []) console.error(`Announced reply ${reply.message_id} from ${reply.from} (${name}/${reply.mailbox}).`);
        for (const reply of watched.replies?.failed ?? []) console.error(`Could not announce reply ${reply.message_id}: ${reply.error}`);
      } catch (e) { console.error(`Reply check failed for ${name}: ${e.message}`); }
    }
    return result;
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
