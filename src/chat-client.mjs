import { request as httpRequest } from "node:http";
import { defaultChatConfigPath, readChatConfig } from "./chat-state.mjs";

const heartbeatIntervalMs = 30_000;

// Node's global fetch (undici) aborts after 300s, so long polls use node:http with timeouts disabled.
function longPoll(path, config) {
  return new Promise((resolvePromise, reject) => {
    const call = httpRequest({ host: config.host, port: config.port, path, method: "GET", headers: { authorization: `Bearer ${config.token}` } }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let result;
        try { result = JSON.parse(raw); } catch { return reject(new Error(`Agent Chat listener returned ${response.statusCode}`)); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(result.error ?? `Agent Chat listener returned ${response.statusCode}`));
        resolvePromise(result);
      });
      response.on("error", reject);
    });
    call.setTimeout(0);
    call.on("error", reject);
    call.end();
  });
}

async function request(path, { method = "GET", body, configPath = defaultChatConfigPath } = {}) {
  const config = await readChatConfig(configPath);
  const response = await fetch(`http://${config.host}:${config.port}${path}`, { method, headers: { authorization: `Bearer ${config.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Agent Chat listener returned ${response.status}`);
  return result;
}
export const chatHealth = () => request("/v1/health");
export const chatAgentHeartbeat = () => request("/v1/agent/heartbeat", { method: "POST" });
export async function chatMessages({ conversationId = "default" } = {}) { await chatAgentHeartbeat(); return request(`/v1/messages?conversation_id=${encodeURIComponent(conversationId)}`); }
// The panel treats a stale heartbeat as "no agent", so the beat must continue while the
// agent is working on a reply, not only while its poll is parked. It lives as long as this
// MCP process does and is unref'd, so it never keeps the process alive on its own.
let heartbeat;
function keepAgentAlive() {
  if (heartbeat) return;
  heartbeat = setInterval(() => { chatAgentHeartbeat().catch(() => {}); }, heartbeatIntervalMs);
  heartbeat.unref?.();
}
export async function waitForChatMessage({ conversationId = "default", waitMs = 45_000, configPath = defaultChatConfigPath } = {}) {
  await chatAgentHeartbeat();
  keepAgentAlive();
  const config = await readChatConfig(configPath);
  return longPoll(`/v1/wait-for-message?conversation_id=${encodeURIComponent(conversationId)}&wait_ms=${waitMs}`, config);
}
export const acknowledgeChatMessage = (messageId) => request(`/v1/messages/${encodeURIComponent(messageId)}/acknowledge`, { method: "POST" });
export const sendChatReply = ({ conversationId = "default", text }) => request("/v1/replies", { method: "POST", body: { conversation_id: conversationId, text } });
