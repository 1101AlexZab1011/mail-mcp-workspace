import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startBroker } from "listener-mcp/broker";
import { ListenerClient } from "listener-mcp/client";
import { startHost } from "../src/workspace/host.mjs";

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), "mw-host-"));
  const env = { ...process.env, LISTENER_MCP_HOME: join(home, "listener") };
  const config = { version: 1, host: "127.0.0.1", port: 0, limits: { event_bytes: 262144, blob_bytes: 1e6, lease_ms: 60000, max_attempts: 10, retention_days: 30 } };
  const broker = await startBroker({ config, env, database: ":memory:", port: 0 });
  const admin = new ListenerClient({ url: broker.url, token: broker.adminToken });
  const addon = (await admin.createToken({ name: "thunderbird", scopes: ["publish:mail/**", "read:mail/**", "blobs"] })).token;
  const agent = (await admin.createToken({ name: "agent", scopes: ["read:mail/workspace/files", "read:mail/workspace/artifacts", "publish:mail/workspace/artifacts"] })).token;
  const stranger = (await admin.createToken({ name: "stranger", scopes: ["publish:crm/**"] })).token;
  const host = await startHost({ port: 0, brokerUrl: broker.url, artifactsRoot: join(home, "Artifacts"), cacheDir: join(home, "cache"), grantsPath: join(home, "grants.json") });
  t.after(async () => { await host.close(); await broker.close(); await rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  const call = async (token, method, path, body) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json().catch(() => null);
    return { status: response.status, value };
  };
  return { home, base, call, addon, agent, stranger };
}

test("files: auth, scopes, listing, kinds, text, highlight, sheets and ranged links", async (t) => {
  const { home, base, call, addon, stranger } = await setup(t);
  const dir = join(home, "files");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.ts"), "const answer: number = 42;\n");
  await writeFile(join(dir, "notes.md"), "# Title\n");
  await writeFile(join(dir, "data.csv"), "name,value\nalpha,1\nbeta,2\n");
  await writeFile(join(dir, "clip.mp4"), Buffer.alloc(1000, 7));
  await writeFile(join(dir, ".hidden"), "x");

  assert.equal((await fetch(`${base}/v1/fs/list?path=${dir}`)).status, 401);
  assert.equal((await call(stranger, "GET", `/v1/fs/list?path=${dir}`)).status, 403);

  const listing = await call(addon, "GET", `/v1/fs/list?path=${dir}`);
  assert.deepEqual(listing.value.entries.map((e) => e.name), ["src", "clip.mp4", "data.csv", "notes.md"]);
  assert.equal((await call(addon, "GET", `/v1/fs/list?path=${dir}&hidden=1`)).value.entries.length, 5);

  const kinds = {};
  for (const name of ["src/main.ts", "notes.md", "data.csv", "clip.mp4"]) kinds[name] = (await call(addon, "GET", `/v1/fs/stat?path=${join(dir, name)}`)).value.kind;
  assert.deepEqual(kinds, { "src/main.ts": "code", "notes.md": "markdown", "data.csv": "sheet", "clip.mp4": "video" });

  const code = await call(addon, "GET", `/v1/fs/highlight?path=${join(dir, "src/main.ts")}`);
  assert.equal(code.value.language, "typescript");
  assert.match(code.value.html, /shiki/);

  const sheet = await call(addon, "GET", `/v1/fs/sheet?path=${join(dir, "data.csv")}`);
  assert.equal(sheet.value.sheets[0].rows[2][0].t, "beta");

  const link = await call(addon, "POST", "/v1/links", { path: join(dir, "clip.mp4") });
  const ranged = await fetch(base + link.value.url, { headers: { range: "bytes=10-19" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 10-19/1000");
  assert.equal((await ranged.arrayBuffer()).byteLength, 10);

  const evil = await fetch(`${base}/v1/fs/list?path=${dir}`, { headers: { authorization: `Bearer ${addon}`, origin: "https://evil.example" } });
  assert.equal(evil.status, 403, "web origins are refused");
});

test("office documents convert to PDF through LibreOffice", { timeout: 180_000 }, async (t) => {
  const { home, base, call, addon } = await setup(t);
  const file = join(home, "letter.rtf");
  await writeFile(file, "{\\rtf1\\ansi Hello from a document.}");
  const link = await call(addon, "POST", "/v1/links", { path: file, convert: "pdf" });
  assert.equal(link.status, 200, JSON.stringify(link.value));
  assert.equal(link.value.mime, "application/pdf");
  const pdf = Buffer.from(await (await fetch(base + link.value.url)).arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});

test("artifacts: create, organise, launch in a locked-down page, and report build errors", async (t) => {
  const { base, call, agent } = await setup(t);
  const created = await call(agent, "POST", "/v1/artifacts", {
    folder: "dev/tools", title: "Counter", description: "A counter", files: { "App.tsx": "import { useState } from 'react';\nexport default function App() { const [n, set] = useState(0); return <button onClick={() => set(n + 1)}>{n}</button>; }\n" },
  });
  assert.equal(created.value.path, "dev/tools/counter");
  const again = await call(agent, "POST", "/v1/artifacts", { folder: "dev/tools", title: "Counter", files: { "App.tsx": "export default () => null;" } });
  assert.equal(again.value.path, "dev/tools/counter-2");

  const tree = (await call(agent, "GET", "/v1/artifacts/tree")).value.tree;
  assert.equal(tree.children[0].name, "dev");
  assert.equal(tree.children[0].children[0].children.length, 2);

  const launched = await call(agent, "POST", "/v1/artifacts/launch", { path: "dev/tools/counter" });
  assert.equal(launched.status, 200, JSON.stringify(launched.value));
  const page = await fetch(base + launched.value.url);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'none'/);
  const bundle = await (await fetch(`${base}${launched.value.url}bundle.js`)).text();
  assert.match(bundle, /useState/);

  await call(agent, "POST", "/v1/artifacts/move", { path: "dev/tools/counter-2", to: "scratch/counter-copy" });
  await call(agent, "DELETE", "/v1/artifacts?path=scratch/counter-copy");
  assert.equal((await call(agent, "GET", "/v1/artifacts/item?path=scratch/counter-copy")).status, 404);

  await call(agent, "PATCH", "/v1/artifacts", { path: "dev/tools/counter", files: { "App.tsx": "export default function App() { return <div>{undefinedName}</div> " } });
  const broken = await call(agent, "POST", "/v1/artifacts/launch", { path: "dev/tools/counter" });
  assert.equal(broken.status, 422);
  assert.match(broken.value.error.message, /App\.tsx:1/);

  assert.equal((await call(agent, "POST", "/v1/artifacts", { folder: "../../etc", title: "x", files: { "App.tsx": "" } })).status, 400);
});

test("capabilities: nothing runs before the user approves, and an agent cannot approve", async (t) => {
  const { home, call, addon, agent } = await setup(t);
  const work = join(home, "project");
  await mkdir(work, { recursive: true });
  await call(agent, "POST", "/v1/artifacts", { title: "Shell", files: { "App.tsx": "export default () => null;" }, capabilities: { exec: { cwd: work } } });

  const denied = await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "exec", args: { command: "echo hi" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.value.error.code, "needs_approval");

  assert.equal((await call(agent, "POST", "/v1/artifacts/grant", { path: "shell", declared: { exec: { cwd: work } } })).status, 403, "agents cannot approve");
  assert.equal((await call(agent, "POST", "/v1/artifacts/call", { path: "shell", method: "exec", args: { command: "echo hi" } })).status, 403, "agents cannot run capabilities");

  assert.equal((await call(addon, "POST", "/v1/artifacts/grant", { path: "shell", declared: { exec: { cwd: work } } })).status, 200);
  const ran = await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "exec", args: { command: "pwd && echo hi" } });
  assert.equal(ran.value.stdout.trim(), `${work}\nhi`);
  assert.equal((await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "exec", args: { command: "pwd", cwd: "/" } })).status, 403);
  assert.equal((await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "fs.read", args: { path: "/etc/passwd" } })).status, 403);

  const opened = await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "shell.open", args: {} });
  await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "shell.write", args: { session: opened.value.session, data: "echo from-shell\n" } });
  let text = "";
  for (let offset = 0, i = 0; i < 20 && !text.includes("from-shell"); i++) {
    const read = await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "shell.read", args: { session: opened.value.session, offset, wait: 1000 } });
    offset = read.value.next;
    text += read.value.chunks.map((c) => c.data).join("");
  }
  assert.match(text, /from-shell/);
  await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "shell.close", args: { session: opened.value.session } });

  // Changing what the artifact asks for voids the approval.
  await call(agent, "PATCH", "/v1/artifacts", { path: "shell", capabilities: { exec: { cwd: "/" } } });
  assert.equal((await call(addon, "POST", "/v1/artifacts/call", { path: "shell", method: "exec", args: { command: "echo hi" } })).value.error.code, "needs_approval");
});
