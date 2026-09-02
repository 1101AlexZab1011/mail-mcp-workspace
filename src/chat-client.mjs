import { defaultChatConfigPath, readChatConfig } from "./chat-state.mjs";

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
export async function waitForChatMessage({ conversationId = "default", waitMs = 45_000 } = {}) { await chatAgentHeartbeat(); return request(`/v1/wait-for-message?conversation_id=${encodeURIComponent(conversationId)}&wait_ms=${waitMs}`); }
export const acknowledgeChatMessage = (messageId) => request(`/v1/messages/${encodeURIComponent(messageId)}/acknowledge`, { method: "POST" });
export const sendChatReply = ({ conversationId = "default", text }) => request("/v1/replies", { method: "POST", body: { conversation_id: conversationId, text } });
