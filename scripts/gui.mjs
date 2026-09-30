#!/usr/bin/env node
// Send one GUI command to Thunderbird through listener-mcp and print the reply.
//   node scripts/gui.mjs state
//   node scripts/gui.mjs page '{"page":"viewer","type":"open","path":"~/notes.md"}'
import { ListenerClient } from "listener-mcp/client";

const [command, args = "{}"] = process.argv.slice(2);
const client = await ListenerClient.fromEnvironment({ credential: process.env.GUI_CREDENTIAL ?? "email-agent" });
const sent = await client.publish({ channel: "mail/gui/commands", type: "command", data: { command, args: JSON.parse(args) }, ttlMs: 120_000, waitReplyMs: 120_000 });
const reply = sent.replies?.[0]?.data;
if (!reply) { console.error("No reply from Thunderbird (is the add-on running?)"); process.exit(1); }
console.log(JSON.stringify(reply, null, 2));
if (!reply.ok) process.exit(1);
