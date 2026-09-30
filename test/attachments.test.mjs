import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { messageFor, validateAttachments } from "../src/attachments.mjs";

const account = { email: "someone@example.org", full_name: "Some One" };

test("sending without attachments is allowed, so replies can be filed in Sent", async () => {
  assert.deepEqual(await validateAttachments(undefined), []);
  assert.deepEqual(await validateAttachments([]), []);
  await assert.rejects(validateAttachments("nope"), /must be a list/);
});

test("a validated attachment keeps its own name and size", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "attachments-")), "note.txt");
  await writeFile(path, "hello");
  const [file] = await validateAttachments([{ path }]);
  assert.equal(file.filename, "note.txt");
  assert.equal(file.size, 5);
});

test("a reply carries In-Reply-To and References so clients keep the thread", () => {
  const message = messageFor({ account, to: ["them@example.org"], subject: "Re: Poster", body: "Thanks!", files: [], in_reply_to: "<first@example.org>" });
  assert.equal(message.inReplyTo, "<first@example.org>");
  assert.deepEqual(message.references, ["<first@example.org>"]);
  assert.equal(message.text, "Thanks!");
});

test("an explicit chain of references is preserved", () => {
  const references = ["<first@example.org>", "<second@example.org>"];
  const message = messageFor({ account, to: ["them@example.org"], subject: "Re: Poster", body: "Thanks!", files: [], in_reply_to: "<second@example.org>", references });
  assert.deepEqual(message.references, references);
});

test("a new message has no threading headers", () => {
  const message = messageFor({ account, to: ["them@example.org"], subject: "Poster", body: "Hello", files: [] });
  assert.equal(message.inReplyTo, undefined);
  assert.equal(message.references, undefined);
  assert.equal(message.from, '"Some One" <someone@example.org>');
});
