#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadEmailConfig } from "./config.mjs";
import { sendWithAttachments } from "./attachments.mjs";
function text(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function error(value) { return { isError: true, content: [{ type: "text", text: value instanceof Error ? value.message : String(value) }] }; }
const attachments = z.array(z.object({ path: z.string().min(1), filename: z.string().min(1).optional(), content_type: z.string().min(1).optional() })).min(1).max(10);
const server = new McpServer({ name: "mail-attachments-mcp", version: "1.0.0" });
server.tool("send_email_with_attachments", "Send an email with local file attachments using a configured email-mcp SMTP account.", { account: z.string(), to: z.array(z.string().email()).min(1), cc: z.array(z.string().email()).optional(), bcc: z.array(z.string().email()).optional(), subject: z.string().min(1), body: z.string(), html: z.boolean().default(false), attachments }, { destructiveHint: true }, async (params) => {
  try { const accounts = await loadEmailConfig(); const account = accounts.get(params.account); if (!account) throw new Error(`Unknown account: ${params.account}`); return text(await sendWithAttachments({ ...params, account })); } catch (cause) { return error(cause); }
});
await server.connect(new StdioServerTransport());
