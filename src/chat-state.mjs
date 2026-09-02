import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const configRoot = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
const stateRoot = process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local/state");
export const defaultChatConfigPath = process.env.MAIL_AGENT_CHAT_CONFIG ?? resolve(configRoot, "mail-mcp-workspace/agent-chat.json");
export const defaultChatStatePath = process.env.MAIL_AGENT_CHAT_STATE ?? resolve(stateRoot, "mail-mcp-workspace/agent-chat.json");

const emptyState = () => ({ version: 1, next_sequence: 1, messages: [], replies: [] });

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

export async function readChatState(path = defaultChatStatePath) {
  try { return { ...emptyState(), ...JSON.parse(await readFile(path, "utf8")) }; }
  catch (error) { if (error.code === "ENOENT") return emptyState(); throw error; }
}

export async function writeChatState(path, state) { await writePrivate(path, state); }

export async function addMessage({ statePath = defaultChatStatePath, conversationId = "default", text }) {
  const state = await readChatState(statePath);
  const message = { id: randomUUID(), sequence: state.next_sequence++, conversation_id: conversationId, text, created_at: new Date().toISOString(), acknowledged_at: null };
  state.messages.push(message);
  state.messages = state.messages.slice(-1000);
  await writeChatState(statePath, state);
  return message;
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
  state.replies = state.replies.slice(-1000);
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
  return { agent_active: Number.isFinite(seen) && Date.now() - seen < 90_000, agent_seen_at: state.agent_seen_at ?? null };
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
