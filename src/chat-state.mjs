import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const configRoot = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
const stateRoot = process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local/state");
export const defaultChatConfigPath = process.env.MAIL_AGENT_CHAT_CONFIG ?? resolve(configRoot, "mail-mcp-workspace/agent-chat.json");
export const defaultChatStatePath = process.env.MAIL_AGENT_CHAT_STATE ?? resolve(stateRoot, "mail-mcp-workspace/agent-chat.json");

const emptyState = () => ({ version: 1, next_sequence: 1, messages: [], replies: [] });

export const historyLimit = 500;

// Keep only the newest `historyLimit` entries across both messages and replies,
// so the stored transcript matches what the chat panel renders. Unacknowledged
// messages are never dropped: the agent still owes them a response.
function trimHistory(state) {
  const total = state.messages.length + state.replies.length;
  if (total <= historyLimit) return state;
  const keep = [...state.messages, ...state.replies].sort((a, b) => a.sequence - b.sequence).slice(-historyLimit);
  const kept = new Set(keep.map((item) => item.sequence));
  state.messages = state.messages.filter((item) => kept.has(item.sequence) || !item.acknowledged_at);
  state.replies = state.replies.filter((item) => kept.has(item.sequence));
  return state;
}

async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function initChatConfig(path = defaultChatConfigPath) {
  try { await readFile(path, "utf8"); return { path, created: false }; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await writePrivate(path, { version: 1, host: "127.0.0.1", port: 46931, token: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "") });
  return { path, created: true };
}

export async function readChatConfig(path = defaultChatConfigPath) {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (config.version !== 1 || config.host !== "127.0.0.1" || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || typeof config.token !== "string" || config.token.length < 32) {
    throw new Error(`Invalid Agent Chat configuration: ${path}`);
  }
  return config;
}

export async function setChatExtensionOrigin(origin, path = defaultChatConfigPath) {
  if (!/^moz-extension:\/\/[a-f0-9-]{36}$/.test(origin)) throw new Error("Extension origin must be a moz-extension UUID origin");
  const config = await readChatConfig(path);
  await writePrivate(path, { ...config, extension_origin: origin });
  return { origin, path };
}

export const defaultAttachmentRoot = process.env.MAIL_AGENT_CHAT_ATTACHMENTS ?? resolve(stateRoot, "mail-mcp-workspace/attachments");
export const maxAttachmentBytes = 25 * 1024 * 1024;

// Attachments are written to a private local directory and referenced by path: chat carries
// text only, so the agent reads the file from disk rather than through the conversation.
export async function saveAttachment({ root = defaultAttachmentRoot, name, type, data }) {
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw new Error("Attachment is empty");
  if (bytes.length > maxAttachmentBytes) throw new Error(`Attachment exceeds ${maxAttachmentBytes} bytes`);
  const safe = (name ?? "attachment").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(-80) || "attachment";
  const day = new Date().toISOString().slice(0, 10);
  const directory = resolve(root, day);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${randomUUID().slice(0, 8)}-${safe}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, name: safe, type: type ?? "application/octet-stream", size: bytes.length };
}

const contentTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv" };

// Serving stored files needs a path check, not trust: the panel supplies the path from a
// message, so anything resolving outside the attachment root is refused rather than read.
export async function readAttachment({ root = defaultAttachmentRoot, path }) {
  const resolved = resolve(path);
  const base = resolve(root);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) throw new Error("Attachment path is outside the attachment directory");
  const bytes = await readFile(resolved);
  const extension = resolved.split(".").pop()?.toLowerCase() ?? "";
  return { bytes, type: contentTypes[extension] ?? "application/octet-stream" };
}

export async function readChatState(path = defaultChatStatePath) {
  try { return { ...emptyState(), ...JSON.parse(await readFile(path, "utf8")) }; }
  catch (error) { if (error.code === "ENOENT") return emptyState(); throw error; }
}

export async function writeChatState(path, state) { await writePrivate(path, state); }

export async function addMessage({ statePath = defaultChatStatePath, conversationId = "default", text }) {
  const state = await readChatState(statePath);
  const message = { id: randomUUID(), sequence: state.next_sequence++, conversation_id: conversationId, text, created_at: new Date().toISOString(), delivered_at: null, acknowledged_at: null };
  state.messages.push(message);
  trimHistory(state);
  await writeChatState(statePath, state);
  return message;
}

// A message is "in progress" once the agent has taken delivery of it and before it
// has replied. Work that never finishes (a session that died mid-task) stops counting
// after this window, so the panel cannot show a busy agent forever.
export const deliveryStaleMs = 15 * 60_000;
export const agentActiveMs = 90_000;

export async function markDelivered({ statePath = defaultChatStatePath, ids = [] }) {
  if (!ids.length) return [];
  const state = await readChatState(statePath);
  const stamp = new Date().toISOString();
  const marked = state.messages.filter((item) => ids.includes(item.id) && !item.delivered_at);
  for (const item of marked) item.delivered_at = stamp;
  if (marked.length) await writeChatState(statePath, state);
  return marked;
}

export async function agentBusy({ statePath = defaultChatStatePath, conversationId = "default" }) {
  const state = await readChatState(statePath);
  const seen = Date.parse(state.agent_seen_at ?? "");
  // An agent that stopped heartbeating is gone, whatever it had picked up.
  if (!Number.isFinite(seen) || Date.now() - seen >= agentActiveMs) return false;
  return state.messages.some((item) => item.conversation_id === conversationId && !item.acknowledged_at && item.delivered_at && Date.now() - Date.parse(item.delivered_at) < deliveryStaleMs);
}

export async function acknowledgeMessage({ statePath = defaultChatStatePath, messageId }) {
  const state = await readChatState(statePath);
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) throw new Error(`Unknown chat message: ${messageId}`);
  if (!message.acknowledged_at) message.acknowledged_at = new Date().toISOString();
  await writeChatState(statePath, state);
  return message;
}

export async function addReply({ statePath = defaultChatStatePath, conversationId = "default", text }) {
  const state = await readChatState(statePath);
  const reply = { id: randomUUID(), sequence: state.next_sequence++, conversation_id: conversationId, text, created_at: new Date().toISOString() };
  state.replies.push(reply);
  trimHistory(state);
  await writeChatState(statePath, state);
  return reply;
}

export async function recordAgentHeartbeat(statePath = defaultChatStatePath) {
  const state = await readChatState(statePath);
  state.agent_seen_at = new Date().toISOString();
  await writeChatState(statePath, state);
  return { agent_active: true, agent_seen_at: state.agent_seen_at };
}

export async function agentStatus(statePath = defaultChatStatePath) {
  const state = await readChatState(statePath);
  const seen = Date.parse(state.agent_seen_at ?? "");
  return { agent_active: Number.isFinite(seen) && Date.now() - seen < agentActiveMs, agent_seen_at: state.agent_seen_at ?? null };
}

export async function pendingMessages({ statePath = defaultChatStatePath, conversationId = "default" }) {
  const state = await readChatState(statePath);
  return state.messages.filter((item) => item.conversation_id === conversationId && !item.acknowledged_at);
}

export async function conversation({ statePath = defaultChatStatePath, conversationId = "default", after = 0, includeAcknowledged = true }) {
  const state = await readChatState(statePath);
  const messages = state.messages.filter((item) => item.conversation_id === conversationId && item.sequence > after && (includeAcknowledged || !item.acknowledged_at));
  const replies = state.replies.filter((item) => item.conversation_id === conversationId && item.sequence > after);
  return [...messages.map((item) => ({ ...item, type: "user" })), ...replies.map((item) => ({ ...item, type: "agent" }))].sort((a, b) => a.sequence - b.sequence);
}
