#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { acknowledgeChatMessage, chatHealth, chatMessages, sendChatReply, waitForChatMessage } from "./chat-client.mjs";

const execFileAsync = promisify(execFile);
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const error = (value) => ({ isError: true, content: [{ type: "text", text: value instanceof Error ? value.message : String(value) }] });
async function startListener() {
  try { return await chatHealth(); }
  catch {
    try {
      await execFileAsync("systemctl", ["--user", "start", "mail-mcp-agent-chat.service"]);
      return await chatHealth();
    } catch (error) {
      throw new Error(`Agent Chat listener is unavailable. Start mail-mcp-agent-chat.service from your desktop session. (${error.message})`);
    }
  }
}

const server = new McpServer({ name: "mail-agent-chat-mcp", version: "1.0.0" });
server.tool("start_chat_listener", "Start the local Agent Chat listener service and verify it is reachable. It does not start an LLM agent.", {}, { destructiveHint: false }, async () => { try { return text(await startListener()); } catch (e) { return error(e); } });
server.tool("chat_listener_status", "Check whether the token-protected local Agent Chat listener is available.", {}, { readOnlyHint: true }, async () => { try { return text(await chatHealth()); } catch (e) { return error(e); } });
server.tool("get_chat_messages", "Get unacknowledged user messages from one local Agent Chat conversation. Reading does not alter the conversation.", { conversation_id: z.string().min(1).default("default"), after: z.number().int().min(0).default(0) }, { readOnlyHint: true }, async (params) => { try { return text(await chatMessages({ conversationId: params.conversation_id, after: params.after })); } catch (e) { return error(e); } });
server.tool("wait_for_chat_message", "Wait up to one minute for an unacknowledged Agent Chat message. Call this continuously while actively monitoring chat; it returns immediately when a message arrives.", { conversation_id: z.string().min(1).default("default"), wait_seconds: z.number().int().min(1).max(60).default(45) }, { readOnlyHint: true }, async (params) => { try { return text(await waitForChatMessage({ conversationId: params.conversation_id, waitMs: params.wait_seconds * 1000 })); } catch (e) { return error(e); } });
server.tool("acknowledge_chat_message", "Acknowledge a chat message after handling it. The message remains in the local action history.", { message_id: z.string().uuid() }, { destructiveHint: false }, async (params) => { try { return text(await acknowledgeChatMessage(params.message_id)); } catch (e) { return error(e); } });
server.tool("send_to_chat", "Send text to a local Agent Chat conversation. This does not send email or modify mail.", { conversation_id: z.string().min(1).default("default"), text: z.string().min(1).max(12000) }, { destructiveHint: false }, async (params) => { try { return text(await sendChatReply({ conversationId: params.conversation_id, text: params.text })); } catch (e) { return error(e); } });
await server.connect(new StdioServerTransport());
