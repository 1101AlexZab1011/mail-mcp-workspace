#!/usr/bin/env node
import { createServer } from "node:http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acknowledgeMessage, addMessage, addReply, agentStatus, conversation, defaultChatConfigPath, defaultChatStatePath, initChatConfig, pendingMessages, readChatConfig, recordAgentHeartbeat, setChatExtensionOrigin } from "./chat-state.mjs";

const execFileAsync = promisify(execFile);
const maxTextLength = 12000;
const json = (response, status, value, origin = "*") => response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type" }).end(JSON.stringify(value));
async function body(request) {
  let raw = "";
  for await (const chunk of request) { raw += chunk; if (raw.length > 65536) throw new Error("Request body too large"); }
  try { return JSON.parse(raw || "{}"); } catch { throw new Error("Request body must be JSON"); }
}
function validText(value) { return typeof value === "string" && value.trim().length > 0 && value.length <= maxTextLength; }

export async function startListener({ configPath = defaultChatConfigPath, statePath = defaultChatStatePath } = {}) {
  const config = await readChatConfig(configPath);
  let writes = Promise.resolve();
  const messageWaiters = new Set();
  const notifyMessageWaiters = () => { for (const resolveWaiter of messageWaiters) resolveWaiter(); messageWaiters.clear(); };
  const waitForPendingMessages = async (conversationId, waitMs) => {
    let items = await pendingMessages({ statePath, conversationId });
    if (items.length || !waitMs) return items;
    await new Promise((resolveWaiter) => {
      const timer = setTimeout(() => { messageWaiters.delete(wake); resolveWaiter(); }, waitMs);
      const wake = () => { clearTimeout(timer); resolveWaiter(); };
      messageWaiters.add(wake);
    });
    return pendingMessages({ statePath, conversationId });
  };
  const serialWrite = (operation) => {
    const result = writes.then(operation, operation);
    writes = result.catch(() => {});
    return result;
  };
  const server = createServer(async (request, response) => {
    try {
      const requestOrigin = request.headers.origin;
      const extensionOrigin = config.extension_origin === requestOrigin ? requestOrigin : "*";
      if (request.method === "OPTIONS") return json(response, 204, {}, extensionOrigin);
      const url = new URL(request.url, `http://${config.host}:${config.port}`);
      if (request.method === "GET" && url.pathname === "/v1/extension-settings") {
        if (!config.extension_origin || requestOrigin !== config.extension_origin) return json(response, 401, { error: "Unauthorized" });
        return json(response, 200, { endpoint: `http://${config.host}:${config.port}`, token: config.token }, extensionOrigin);
      }
      if (request.headers.authorization !== `Bearer ${config.token}`) return json(response, 401, { error: "Unauthorized" }, extensionOrigin);
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/v1/health") return json(response, 200, { ok: true, ...(await agentStatus(statePath)) });
      if (request.method === "POST" && url.pathname === "/v1/agent/heartbeat") return json(response, 200, await serialWrite(() => recordAgentHeartbeat(statePath)));
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        const input = await body(request);
        if (!validText(input.text)) return json(response, 400, { error: "text must be 1-12000 characters" });
        const message = await serialWrite(() => addMessage({ statePath, conversationId: input.conversation_id ?? "default", text: input.text.trim() }));
        notifyMessageWaiters();
        return json(response, 201, message);
      }
      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "conversations" && parts.length === 3) {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) return json(response, 400, { error: "after must be a non-negative integer" });
        return json(response, 200, { items: await conversation({ statePath, conversationId: decodeURIComponent(parts[2]), after }), ...(await agentStatus(statePath)) });
      }
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        return json(response, 200, { items: await pendingMessages({ statePath, conversationId: url.searchParams.get("conversation_id") ?? "default" }) });
      }
      if (request.method === "GET" && url.pathname === "/v1/wait-for-message") {
        const waitMs = Number(url.searchParams.get("wait_ms") ?? 45_000);
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) return json(response, 400, { error: "wait_ms must be an integer from 0 to 60000" });
        const items = await waitForPendingMessages(url.searchParams.get("conversation_id") ?? "default", waitMs);
        return json(response, 200, { items, timed_out: items.length === 0 });
      }
      if (request.method === "POST" && parts[0] === "v1" && parts[1] === "messages" && parts[3] === "acknowledge") return json(response, 200, await serialWrite(() => acknowledgeMessage({ statePath, messageId: parts[2] })));
      if (request.method === "POST" && url.pathname === "/v1/replies") {
        const input = await body(request);
        if (!validText(input.text)) return json(response, 400, { error: "text must be 1-12000 characters" });
        return json(response, 201, await serialWrite(() => addReply({ statePath, conversationId: input.conversation_id ?? "default", text: input.text.trim() })));
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) { return json(response, 400, { error: error.message }); }
  });
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolvePromise); });
  return server;
}

async function installService() {
  const config = await readChatConfig(defaultChatConfigPath);
  const unitPath = resolve(process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME, ".config"), "systemd/user/mail-mcp-agent-chat.service");
  const scriptPath = fileURLToPath(import.meta.url);
  await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
  await writeFile(unitPath, `[Unit]\nDescription=Mail MCP Agent Chat listener\n\n[Service]\nExecStart=${process.execPath} ${scriptPath} serve\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
  await chmod(unitPath, 0o600);
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", "--now", "mail-mcp-agent-chat.service"]);
  console.log(JSON.stringify({ service: "mail-mcp-agent-chat.service", config: { host: config.host, port: config.port }, unitPath }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "serve";
  if (command === "init") console.log(JSON.stringify(await initChatConfig(), null, 2));
else if (command === "serve") { await initChatConfig(); const server = await startListener(); console.error("Agent Chat listener ready on loopback."); for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0))); }
else if (command === "install-service") await installService();
else if (command === "pair-extension") { const origin = process.argv[3]; if (!origin) throw new Error("Usage: chat-listener pair-extension <moz-extension://UUID>"); console.log(JSON.stringify(await setChatExtensionOrigin(origin), null, 2)); }
else throw new Error("Usage: chat-listener [init|serve|install-service]");
}
