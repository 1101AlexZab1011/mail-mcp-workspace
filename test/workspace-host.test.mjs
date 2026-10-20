import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  const agent = (await admin.createToken({ name: "agent", scopes: ["read:mail/workspace/files", "read:mail/workspace/artifacts", "publish:mail/workspace/artifacts", "publish:mail/workspace/fs", "publish:mail/workspace/render"] })).token;
  const stranger = (await admin.createToken({ name: "stranger", scopes: ["publish:crm/**"] })).token;
  const host = await startHost({ port: 0, brokerUrl: broker.url, artifactsRoot: join(home, "Artifacts"), cacheDir: join(home, "cache"), grantsPath: join(home, "grants.json"), filesRoot: join(home, "files"), trashDir: join(home, "trash"), configDir: join(home, "files/.config/mail-workspace") });
  await mkdir(join(home, "files"), { recursive: true });
  t.after(async () => { await host.close(); await broker.close(); await rm(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.port}`;
  const call = async (token, method, path, body) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json().catch(() => null);
    return { status: response.status, value };
  };
  return { home, base, call, addon, agent, stranger, admin };
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
  assert.equal(code.value.theme, "one-dark-pro");
  const dracula = await call(addon, "GET", `/v1/fs/highlight?path=${join(dir, "src/main.ts")}&theme=dracula`);
  assert.equal(dracula.value.bg.toLowerCase(), "#282a36");

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

test("an artifact asking the agent reaches the chat session that is open", async (t) => {
  const { call, addon, agent, admin } = await setup(t);
  await call(agent, "POST", "/v1/artifacts", { title: "Asker", files: { "App.tsx": "export default () => null;" }, capabilities: { agent: true } });
  assert.equal((await call(addon, "POST", "/v1/artifacts/grant", { path: "asker", declared: { agent: true } })).status, 200);
  assert.equal((await call(addon, "POST", "/v1/artifacts/call", { path: "asker", method: "agent.ask", args: { text: "to the open session" }, chat: "k3f9qa" })).status, 200);
  assert.equal((await call(addon, "POST", "/v1/artifacts/call", { path: "asker", method: "agent.ask", args: { text: "no session given" } })).status, 200);
  assert.equal((await call(addon, "POST", "/v1/artifacts/call", { path: "asker", method: "agent.ask", args: { text: "bad id" }, chat: "../x" })).status, 200);
  const events = await admin.events({ channel: "mail/chat/*" });
  assert.deepEqual(events.map((event) => [event.channel, event.data.text.split("\n")[1]]), [
    ["mail/chat/k3f9qa", "to the open session"],
    ["mail/chat/default", "no session given"],
    ["mail/chat/default", "bad id"],
  ]);
});

test("terminals: a real shell the add-on and the agent share", async (t) => {
  const { home, call, addon, agent } = await setup(t);
  assert.equal((await call(agent, "POST", "/v1/term", {})).status, 403, "needs the terminal scope");
  const created = await call(addon, "POST", "/v1/term", { cwd: home, cols: 90, rows: 20 });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const id = created.value.id;
  const ran = await call(addon, "POST", `/v1/term/${id}/run`, { command: "echo hello-42; tput cols", idleMs: 600, timeoutMs: 10000 });
  assert.match(ran.value.output, /hello-42/);
  assert.match(ran.value.output, /\b90\b/, "the pty has the requested size");
  const read = await call(addon, "GET", `/v1/term/${id}/read?lines=50`);
  assert.match(read.value.text, /hello-42/);
  const listed = await call(addon, "GET", "/v1/term");
  assert.equal(listed.value.terminals.length, 1);
  await call(addon, "DELETE", `/v1/term/${id}`);
  assert.equal((await call(addon, "GET", "/v1/term")).value.terminals.length, 0);
});

test("writing files: scopes, confinement, atomic writes, lost-update guard, edits, moves, trash", async (t) => {
  const { home, call, addon, agent, stranger } = await setup(t);
  const root = join(home, "files");
  const doc = join(root, "paper", "paper.qmd");

  assert.equal((await call(stranger, "PUT", "/v1/fs/file", { path: doc, text: "x" })).status, 403, "needs publish:mail/workspace/fs");
  assert.equal((await call(agent, "PUT", "/v1/fs/file", { path: doc, text: "x" })).status, 404, "parent folder must exist without createDirs");

  const created = await call(agent, "PUT", "/v1/fs/file", { path: doc, text: "# Draft\n\nFirst.\n", createDirs: true });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  assert.equal(created.value.created, true);
  const read = await call(agent, "GET", `/v1/fs/read?path=${doc}`);
  assert.equal(read.value.hash, created.value.hash, "read and write report the same version");

  // Somebody else (the user, in the editor) changes the file; a stale write is refused.
  const theirs = await call(addon, "PUT", "/v1/fs/file", { path: doc, text: "# Draft\n\nFirst, edited.\n", expect: read.value.hash });
  assert.equal(theirs.status, 200);
  const stale = await call(agent, "PUT", "/v1/fs/file", { path: doc, text: "clobber", expect: read.value.hash });
  assert.equal(stale.status, 409);
  assert.equal(stale.value.error.current.text, "# Draft\n\nFirst, edited.\n", "the conflict carries the current text");
  assert.equal(await readFile(doc, "utf8"), "# Draft\n\nFirst, edited.\n");

  // Exact-match edits.
  assert.equal((await call(agent, "POST", "/v1/fs/edit", { path: doc, oldString: "Second", newString: "x" })).value.error.code, "not_found_in_file");
  await call(agent, "PUT", "/v1/fs/file", { path: doc, text: "a b a\n" });
  assert.equal((await call(agent, "POST", "/v1/fs/edit", { path: doc, oldString: "a", newString: "c" })).value.error.code, "not_unique");
  assert.equal((await call(agent, "POST", "/v1/fs/edit", { path: doc, oldString: "a b", newString: "c b" })).status, 200);
  assert.equal((await call(agent, "POST", "/v1/fs/edit", { path: doc, oldString: "a", newString: "z", all: true })).value.replacements, 1);
  assert.equal(await readFile(doc, "utf8"), "c b z\n");
  assert.deepEqual((await readdir(join(root, "paper"))).sort(), ["paper.qmd"], "no temp files left behind");

  // Confinement: outside the root, through .., through a symlink, and protected folders.
  for (const path of ["/etc/mw-test", join(root, "..", "escape.txt"), join(root, ".ssh", "authorized_keys")]) {
    assert.equal((await call(agent, "PUT", "/v1/fs/file", { path, text: "x", createDirs: true })).status, 403, path);
  }
  await symlink(home, join(root, "out"));
  assert.equal((await call(agent, "PUT", "/v1/fs/file", { path: join(root, "out", "escape.txt"), text: "x" })).status, 403, "symlink escape");

  // Folders and moves.
  assert.equal((await call(agent, "POST", "/v1/fs/mkdir", { path: join(root, "paper", "figures") })).status, 200);
  await call(agent, "PUT", "/v1/fs/file", { path: join(root, "fig.png"), base64: Buffer.from([1, 2, 3]).toString("base64") });
  const moved = await call(agent, "POST", "/v1/fs/move", { from: join(root, "fig.png"), to: join(root, "paper", "figures") });
  assert.equal(moved.value.path, join(root, "paper", "figures", "fig.png"), "moving onto a folder moves into it");
  await call(agent, "PUT", "/v1/fs/file", { path: join(root, "fig.png"), text: "again" });
  assert.equal((await call(agent, "POST", "/v1/fs/move", { from: join(root, "fig.png"), to: join(root, "paper", "figures", "fig.png") })).status, 409);

  // Trash: the agent cannot trash directly (it goes through the GUI, which asks the user).
  assert.equal((await call(agent, "POST", "/v1/fs/trash", { path: doc })).status, 403);
  const trashed = await call(addon, "POST", "/v1/fs/trash", { path: doc });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.value));
  const info = await readFile(join(home, "trash", "info", `${trashed.value.trashed}.trashinfo`), "utf8");
  assert.match(info, new RegExp(`Path=${doc.replace(/[/.]/g, "\\$&")}`));
  assert.equal((await call(addon, "GET", "/v1/fs/trash")).value.entries[0].path, doc);
  assert.equal((await call(addon, "POST", "/v1/fs/restore", { name: trashed.value.trashed })).status, 200);
  assert.equal(await readFile(doc, "utf8"), "c b z\n");
});

test("watching a file wakes on an atomic write", async (t) => {
  const { home, call, agent } = await setup(t);
  const doc = join(home, "files", "notes.md");
  const first = await call(agent, "PUT", "/v1/fs/file", { path: doc, text: "one\n" });
  const started = Date.now();
  const waiting = call(agent, "GET", `/v1/fs/watch?path=${doc}&since=${first.value.hash}&wait=10000`);
  setTimeout(() => { void call(agent, "PUT", "/v1/fs/file", { path: doc, text: "two\n" }); }, 300);
  const changed = await waiting;
  assert.notEqual(changed.value.hash, first.value.hash);
  assert.ok(Date.now() - started < 5000, "woke on the change, not on the timeout");
});

test("writer: bibliography from the document header, and Quarto rendering", { timeout: 240_000 }, async (t) => {
  const { home, call, agent } = await setup(t);
  const dir = join(home, "files", "paper");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "refs.bib"), "@article{ridler2020,\n  author = {Ridler, Thomas and Brown, Jonathan T.},\n  title = {Impaired speed encoding and {grid} cell periodicity},\n  journal = {eLife}, year = {2020}}\n@comment{ignored}\n@book{knuth, title=\"The Art\", year=1968}\n");
  await writeFile(join(dir, "paper.qmd"), "---\ntitle: Test\nbibliography: refs.bib\n---\n\nAs shown [@ridler2020].\n");
  const bib = await call(agent, "GET", `/v1/writer/bibliography?path=${join(dir, "paper.qmd")}`);
  assert.deepEqual(bib.value.entries.map((e) => [e.key, e.year]), [["ridler2020", "2020"], ["knuth", "1968"]]);
  assert.equal(bib.value.entries[0].title, "Impaired speed encoding and grid cell periodicity");

  const { execFileSync } = await import("node:child_process");
  try { execFileSync("quarto", ["--version"]); } catch { t.skip("quarto is not installed"); return; }
  const rendered = await call(agent, "POST", "/v1/writer/render", { path: join(dir, "paper.qmd"), to: "html" });
  assert.equal(rendered.status, 200, JSON.stringify(rendered.value));
  assert.ok(rendered.value.ok, rendered.value.log);
  assert.equal(rendered.value.output, join(dir, "paper.html"));
  assert.equal((await call(agent, "GET", `/v1/writer/render?path=${join(dir, "paper.qmd")}`)).value.result.ok, true);
});

test("writer: supervisor review keeps only comments that quote the passage", async (t) => {
  const { call, addon, agent } = await setup(t);
  process.env.WRITER_REVIEW_CMD = join(import.meta.dirname, "fixtures/writer/review-stub.mjs");
  t.after(() => { delete process.env.WRITER_REVIEW_CMD; });
  const text = "Grid cells fires in the frontal lobe, therefore memory fails.";
  assert.equal((await call(agent, "POST", "/v1/writer/review", { text })).status, 403, "the agent does not run reviews");
  const review = await call(addon, "POST", "/v1/writer/review", { text, before: "Intro.", heading: "Results" });
  assert.equal(review.status, 200, JSON.stringify(review.value));
  assert.equal(review.value.verdict, "needs-work");
  assert.deepEqual(review.value.comments.map((c) => [c.kind, c.quote, c.start]), [
    ["error", "cells fires", 5],
    ["correction", "frontal lobe", 24],
    ["sense", "therefore", 38],
  ]);
  assert.equal(review.value.comments[0].replacement, "cells fire");
  const good = await call(addon, "POST", "/v1/writer/review", { text: "Grid fields form a hexagonal lattice." });
  assert.deepEqual([good.value.verdict, good.value.comments.length], ["good", 0]);
  assert.equal((await call(addon, "POST", "/v1/writer/review", { text: "  " })).status, 400);
});

test("writer: review quotes match across whitespace and never overlap", async () => {
  const { normalizeReview } = await import("../src/workspace/writer.mjs");
  const text = "The model is   robust. The model is robust.";
  const out = normalizeReview(text, { verdict: "minor", summary: "s", comments: [
    { quote: "The model is robust.", kind: "style", comment: "a" },
    { quote: "The model is robust.", kind: "style", comment: "b" },
    { quote: "model", kind: "bogus", comment: "c" },
  ] });
  assert.deepEqual(out.comments.map((c) => [c.start, c.quote]), [[0, "The model is   robust."], [23, "The model is robust."]]);
  assert.equal(normalizeReview(text, { verdict: "needs-work", summary: "", comments: [] }).verdict, "good", "no comments means good");
});

test("slides: create, read and edit a deck file through ops; fonts; rewrites", async (t) => {
  const { home, base, call, addon, agent } = await setup(t);
  process.env.WRITER_REVIEW_CMD = join(import.meta.dirname, "fixtures/writer/review-stub.mjs");
  t.after(() => { delete process.env.WRITER_REVIEW_CMD; });
  const path = join(home, "files/talk.slides.json");
  assert.equal((await call(agent, "POST", "/v1/slides/new", { path: join(home, "files/talk.json") })).status, 400, "decks end in .slides.json");
  const created = await call(agent, "POST", "/v1/slides/new", { path });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  assert.equal((await call(agent, "POST", "/v1/slides/new", { path })).status, 409, "never overwrites");

  // A 4x2 PNG next to the deck: the image's height follows from its file.
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000004000000020806000000", "hex");
  await mkdir(join(home, "files/media"));
  await writeFile(join(home, "files/media/fig.png"), Buffer.concat([png, Buffer.alloc(16)]));
  const applied = await call(agent, "POST", "/v1/slides/apply", { path, ops: [
    { op: "set_title", title: "Grid cells" },
    { op: "add_slide", notes: "Explain the lattice.", elements: [{ type: "text", text: "Hexagonal firing", size: 40 }, { type: "image", src: "media/fig.png", left: 100, top: 200, width: 400 }] },
  ] });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.slideCount, 2);
  const read = await call(agent, "GET", `/v1/slides/read?path=${encodeURIComponent(path)}&from=1`);
  assert.equal(read.value.title, "Grid cells");
  assert.equal(read.value.slides.length, 1);
  const [text, image] = read.value.slides[0].elements;
  assert.deepEqual([text.text, text.size, image.src, image.box[3], read.value.slides[0].notes], ["Hexagonal firing", 40, "media/fig.png", 200, "Explain the lattice."]);
  const file = JSON.parse(await readFile(path, "utf8"));
  assert.equal(file.format, "mail-workspace-slides");

  const stale = await call(agent, "POST", "/v1/slides/apply", { path, expect: created.value.hash, ops: [{ op: "set_title", title: "x" }] });
  assert.equal(stale.status, 409, "a stale expect is refused");
  const bad = await call(agent, "POST", "/v1/slides/apply", { path, ops: [{ op: "update_element", id: "nope", text: "x" }] });
  assert.equal(bad.status, 422);
  assert.match(bad.value.error.message, /Op 1 \(update_element\): No element nope/);

  // Large binaries (exports, media) go up raw.
  const rawPath = join(home, "files/export.pptx");
  const upload = (expect) => fetch(`${base}/v1/fs/raw?${new URLSearchParams({ path: rawPath, ...(expect ? { expect } : {}) })}`, { method: "PUT", headers: { authorization: `Bearer ${addon}` }, body: Buffer.from([1, 2, 3, 250]) });
  assert.equal((await upload("absent")).status, 200);
  assert.deepEqual([...await readFile(rawPath)], [1, 2, 3, 250]);
  assert.equal((await upload("absent")).status, 409, "expect: absent never overwrites");

  const fonts = await call(agent, "GET", "/v1/slides/fonts");
  assert.ok(Array.isArray(fonts.value.fonts));

  assert.equal((await call(agent, "POST", "/v1/slides/rewrite", { text: "short", command: "polish" })).status, 403, "rewrites are the add-on's");
  const rewrite = await call(addon, "POST", "/v1/slides/rewrite", { text: "keep it short", command: "condense" });
  assert.deepEqual(rewrite.value, { text: "KEEP IT SHORT" });
  assert.equal((await call(addon, "POST", "/v1/slides/rewrite", { text: "x", command: "shout" })).status, 400);
});

test("slides: script frames are sealed off and expire with their link", async (t) => {
  const { home, base, call, agent } = await setup(t);
  const deck = join(home, "files/talk.slides.json");
  await call(agent, "POST", "/v1/slides/new", { path: deck });
  await mkdir(join(home, "files/scripts"));
  await writeFile(join(home, "files/scripts/plot.js"), "slide.canvas()");
  const launched = await call(agent, "POST", "/v1/slides/script", { deck, src: "scripts/plot.js", libs: ["d3", "evil"] });
  assert.equal(launched.status, 200, JSON.stringify(launched.value));
  assert.match(launched.value.url, /^\/s\/[A-Za-z0-9_-]+\/\?libs=d3$/);
  const page = await fetch(base + launched.value.url);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(await page.text(), /runtime\.js/);
  const prefix = launched.value.url.split("?")[0];
  assert.equal(await (await fetch(`${base}${prefix}script.js`)).text(), "slide.canvas()");
  assert.equal((await fetch(`${base}${prefix}lib/d3.js`)).status, 200);
  assert.equal((await fetch(`${base}${prefix}lib/evil.js`)).status, 404);
  assert.equal((await fetch(`${base}/s/nope/script.js`)).status, 404);
  const outside = await call(agent, "POST", "/v1/slides/script", { deck, src: "../../.ssh/id_rsa" });
  assert.ok([403, 404].includes(outside.status), `reading outside the home folder is refused (${outside.status})`);
});

test("notes: vault, pages, links and backlinks, rename that rewrites links, databases", async (t) => {
  const { home, call, agent, addon } = await setup(t);
  const vault = join(home, "files/Notes");
  assert.equal((await call(agent, "POST", "/v1/notes/vault", { path: vault })).status, 200);
  const tree0 = await call(agent, "GET", "/v1/notes/tree");
  assert.deepEqual(tree0.value.tree.map((n) => n.title), ["Welcome"], "a new vault gets a welcome page");

  const projects = await call(agent, "POST", "/v1/notes/new", { title: "Projects", body: "Work in progress." });
  const paper = await call(agent, "POST", "/v1/notes/new", { title: "gCAN paper", parent: projects.value.path, properties: { status: "draft" }, body: "See [[Experiments]] and [[Welcome|the welcome page]]." });
  assert.equal(paper.status, 200, JSON.stringify(paper.value));
  assert.equal(paper.value.path, join(vault, "Projects/gCAN paper.md"), "a subpage lives in its parent's folder");
  const tree = (await call(agent, "GET", "/v1/notes/tree")).value.tree;
  const node = tree.find((n) => n.title === "Projects");
  assert.deepEqual(node.children.map((c) => c.title), ["gCAN paper"], "a folder note shows as one item with children");

  const db = await call(agent, "POST", "/v1/notes/database", { title: "Experiments", parent: projects.value.path });
  assert.equal(db.status, 200, JSON.stringify(db.value));
  await call(agent, "POST", "/v1/notes/database/row", { path: db.value.path, title: "tau sweep", properties: { Status: "Running", Date: "2026-10-20" } });
  await call(agent, "POST", "/v1/notes/database/row", { path: db.value.path, title: "noise", properties: { Status: "Done" } });
  const running = await call(agent, "GET", `/v1/notes/database?path=${encodeURIComponent(db.value.path)}&filter=${encodeURIComponent(JSON.stringify([{ property: "Status", op: "is", value: "Running" }]))}`);
  assert.deepEqual(running.value.rows.map((r) => r.title), ["tau sweep"]);
  assert.deepEqual(running.value.schema.views.map((v) => v.type), ["table", "board"]);

  const page = await call(agent, "GET", `/v1/notes/page?path=${encodeURIComponent(db.value.path)}`);
  assert.deepEqual(page.value.backlinks.map((b) => b.title), ["gCAN paper"]);
  assert.equal(page.value.database, join(vault, "Projects/Experiments.base.json"));
  const found = await call(agent, "GET", "/v1/notes/search?q=progress");
  assert.deepEqual(found.value.results.map((r) => r.title), ["Projects"]);

  const renamed = await call(agent, "POST", "/v1/notes/rename", { path: db.value.path, title: "Runs" });
  assert.equal(renamed.value.updated, 1);
  assert.match(await readFile(paper.value.path, "utf8"), /See \[\[Runs\]\] and \[\[Welcome\|the welcome page\]\]/);
  assert.ok((await readdir(join(vault, "Projects/Runs"))).includes("tau sweep.md"), "the rows moved with the database");

  await call(agent, "POST", "/v1/notes/properties", { path: paper.value.path, properties: { status: "submitted", icon: "📄" } });
  assert.match(await readFile(paper.value.path, "utf8"), /^---\nstatus: submitted\nicon: 📄\n---\n/);
  assert.equal((await call(agent, "POST", "/v1/notes/trash", { path: renamed.value.path })).status, 403, "trash is the add-on's (it asks the user)");
  const trashed = await call(addon, "POST", "/v1/notes/trash", { path: renamed.value.path });
  assert.equal(trashed.value.trashed.length, 3, "the page, its rows folder and its database file");
});
