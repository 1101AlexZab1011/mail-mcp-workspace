#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadEmailConfig } from "./config.mjs";
import { sendWithAttachments } from "./attachments.mjs";
import { defaultSubscriptionsPath, subscribe } from "./subscriptions.mjs";
function text(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function error(value) { return { isError: true, content: [{ type: "text", text: value instanceof Error ? value.message : String(value) }] }; }
const attachments = z.array(z.object({ path: z.string().min(1), filename: z.string().min(1).optional(), content_type: z.string().min(1).optional() })).max(10).optional();
const server = new McpServer({ name: "mail-attachments-mcp", version: "1.0.0" });
server.tool("send_email_with_attachments", "Send an email, optionally with local file attachments, using a configured email-mcp SMTP account. A copy is filed in the Sent mailbox. Pass in_reply_to (and references) with the original Message-ID to keep a reply in its thread.", { account: z.string(), to: z.array(z.string().email()).min(1), cc: z.array(z.string().email()).optional(), bcc: z.array(z.string().email()).optional(), subject: z.string().min(1), body: z.string(), html: z.boolean().default(false), attachments, in_reply_to: z.string().min(1).optional(), references: z.array(z.string().min(1)).optional(), subscribe: z.boolean().default(false).describe("Watch this thread: a reply wakes the attached agent through a mail.reply event."), subscribe_note: z.string().max(500).optional().describe("What the reply is awaited for; shown when the reply is announced.") }, { destructiveHint: true }, async (params) => {
  try {
    const accounts = await loadEmailConfig(); const account = accounts.get(params.account); if (!account) throw new Error(`Unknown account: ${params.account}`);
    const { subscribe: watch, subscribe_note: note, ...message } = params;
    const sent = await sendWithAttachments({ ...message, account });
    if (!watch) return text(sent);
    // The mail is already out; a failed subscription is reported, not thrown, so the
    // caller does not resend.
    const subscription = await subscribe(process.env.MAIL_WORKFLOW_SUBSCRIPTIONS ?? defaultSubscriptionsPath, { account: params.account, messageId: sent.message_id, subject: params.subject, to: params.to, note }).then(({ subscription: item }) => ({ root_id: item.rootId, expires_at: item.expiresAt }), (cause) => ({ error: cause.message }));
    return text({ ...sent, subscription });
  } catch (cause) { return error(cause); }
});
await server.connect(new StdioServerTransport());
