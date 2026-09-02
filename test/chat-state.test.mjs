import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acknowledgeMessage, addMessage, addReply, agentBusy, conversation, historyLimit, markDelivered, readAttachment, readChatState, recordAgentHeartbeat, saveAttachment, writeChatState } from "../src/chat-state.mjs";
import { startListener } from "../src/chat-listener.mjs";

test("Agent Chat queues, acknowledges, and orders a conversation", async () => {
  const statePath = join(await mkdtemp(join(tmpdir(), "agent-chat-")), "state.json");
  const message = await addMessage({ statePath, conversationId: "alpha", text: "Hello" });
  const reply = await addReply({ statePath, conversationId: "alpha", text: "Hi" });
  assert.deepEqual((await conversation({ statePath, conversationId: "alpha" })).map(({ type, text }) => ({ type, text })), [{ type: "user", text: "Hello" }, { type: "agent", text: "Hi" }]);
  await acknowledgeMessage({ statePath, messageId: message.id });
  assert.equal((await conversation({ statePath, conversationId: "alpha", includeAcknowledged: false })).length, 1);
  assert.equal(reply.sequence, 2);
});

test("Agent Chat listener accepts local messages and replies with a token", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-chat-listener-"));
  const port = 47000 + Math.floor(Math.random() * 1000);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  await writeFile(configPath, JSON.stringify({ version: 1, host: "127.0.0.1", port, token: "x".repeat(40) }));
  const listener = await startListener({ configPath, statePath });
  try {
    const headers = { authorization: `Bearer ${"x".repeat(40)}`, "content-type": "application/json" };
    const created = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ text: "Hello" }) });
    assert.equal(created.status, 201);
    const message = await created.json();
    const reply = await fetch(`http://127.0.0.1:${port}/v1/replies`, { method: "POST", headers, body: JSON.stringify({ text: "Hi" }) });
    assert.equal(reply.status, 201);
    const listed = await fetch(`http://127.0.0.1:${port}/v1/messages`, { headers });
    assert.equal((await listed.json()).items.length, 1);
    const acknowledged = await fetch(`http://127.0.0.1:${port}/v1/messages/${message.id}/acknowledge`, { method: "POST", headers });
    assert.equal(acknowledged.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/messages`, { headers })).status, 200);
    const waiting = fetch(`http://127.0.0.1:${port}/v1/wait-for-message?wait_ms=1000`, { headers });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ text: "Second message" }) });
    const waited = await waiting;
    assert.equal(waited.status, 200);
    assert.equal((await waited.json()).items.some((item) => item.text === "Second message"), true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/messages`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  } finally { await new Promise((resolve) => listener.close(resolve)); }
});

test("Agent Chat history keeps the newest 500 entries and never drops pending messages", async () => {
  const statePath = join(await mkdtemp(join(tmpdir(), "agent-chat-cap-")), "state.json");
  const pending = await addMessage({ statePath, conversationId: "cap", text: "unacknowledged" });
  for (let index = 0; index < historyLimit + 40; index += 1) {
    const message = await addMessage({ statePath, conversationId: "cap", text: `message ${index}` });
    await acknowledgeMessage({ statePath, messageId: message.id });
    await addReply({ statePath, conversationId: "cap", text: `reply ${index}` });
  }
  const state = await readChatState(statePath);
  assert.equal(state.messages.length + state.replies.length, historyLimit + 1);
  assert.ok(state.messages.some((item) => item.id === pending.id));
  assert.equal(state.replies.at(-1).text, `reply ${historyLimit + 39}`);
  assert.ok(!state.replies.some((item) => item.text === "reply 0"));
});

test("Agent Chat reports a busy agent only between delivery and the reply", async () => {
  const statePath = join(await mkdtemp(join(tmpdir(), "agent-chat-busy-")), "state.json");
  const message = await addMessage({ statePath, conversationId: "busy", text: "Question" });
  await recordAgentHeartbeat(statePath);
  assert.equal(await agentBusy({ statePath, conversationId: "busy" }), false, "queued but undelivered is not busy");
  await markDelivered({ statePath, ids: [message.id] });
  assert.equal(await agentBusy({ statePath, conversationId: "busy" }), true);
  assert.equal(await agentBusy({ statePath, conversationId: "other" }), false, "busy state is per conversation");
  const stale = await readChatState(statePath);
  stale.agent_seen_at = new Date(Date.now() - 120_000).toISOString();
  await writeChatState(statePath, stale);
  assert.equal(await agentBusy({ statePath, conversationId: "busy" }), false, "an agent that stopped heartbeating is not busy");
  await recordAgentHeartbeat(statePath);
  await acknowledgeMessage({ statePath, messageId: message.id });
  assert.equal(await agentBusy({ statePath, conversationId: "busy" }), false);
});

test("Agent Chat stores attachments privately and returns their path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-chat-files-"));
  const saved = await saveAttachment({ root, name: "../../evil name!.png", type: "image/png", data: Buffer.from("binary").toString("base64") });
  assert.equal(saved.name, "evil-name-.png", "path separators and spaces are stripped from the stored name");
  assert.ok(saved.path.startsWith(root), "the file stays inside the attachment root");
  assert.equal(await readFile(saved.path, "utf8"), "binary");
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
  await assert.rejects(saveAttachment({ root, name: "empty", data: "" }), /empty/);
});

test("Agent Chat serves stored attachments and refuses paths outside the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-chat-read-"));
  const saved = await saveAttachment({ root, name: "note.txt", type: "text/plain", data: Buffer.from("hello").toString("base64") });
  assert.equal((await readAttachment({ root, path: saved.path })).bytes.toString("utf8"), "hello");
  assert.equal((await readAttachment({ root, path: saved.path })).type, "text/plain");
  await assert.rejects(readAttachment({ root, path: "/etc/passwd" }), /outside the attachment directory/);
  await assert.rejects(readAttachment({ root, path: join(root, "../escape.txt") }), /outside the attachment directory/);
  await assert.rejects(readAttachment({ root, path: join(root, "missing.png") }), { code: "ENOENT" });
});

test("Agent Chat reports no agent once an interrupted poll drops its connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-chat-interrupt-"));
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  const port = 47500 + Math.floor(Math.random() * 400);
  const token = "t".repeat(40);
  await writeFile(configPath, JSON.stringify({ version: 1, host: "127.0.0.1", port, token }));
  const server = await startListener({ configPath, statePath });
  const headers = { authorization: `Bearer ${token}` };
  const active = async () => (await (await fetch(`http://127.0.0.1:${port}/v1/conversations/default?after=0`, { headers })).json()).agent_active;
  try {
    const controller = new AbortController();
    const poll = fetch(`http://127.0.0.1:${port}/v1/wait-for-message?wait_ms=-1`, { headers, signal: controller.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await active(), true, "a parked poll means an agent is listening");
    controller.abort();
    await poll;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await active(), false, "an interrupted poll must not keep counting as an agent");
  } finally { server.close(); }
});
