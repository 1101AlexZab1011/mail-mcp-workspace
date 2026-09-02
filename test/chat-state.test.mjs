import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acknowledgeMessage, addMessage, addReply, conversation } from "../src/chat-state.mjs";
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
