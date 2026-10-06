import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publish } from "../src/broker.mjs";
import { parseHeaders } from "../src/imap.mjs";
import { announceReplies } from "../src/replies.mjs";
import { headerIds, isAutoReply, list, listWatches, matchReply, matchWatch, normalizeId, subscribe, unsubscribe, unwatch, watch } from "../src/subscriptions.mjs";

const account = { email: "me@example.org" };
const store = async () => join(await mkdtemp(join(tmpdir(), "subscriptions-")), "subscriptions.json");
const reply = (fields) => ({ uid: 7, messageId: "<reply@example.org>", from: "them@example.org", subject: "Re: Trip", date: "2026-10-05T12:00:00.000Z", inReplyTo: "", references: "", headers: {}, ...fields });

test("Message-IDs compare with or without angle brackets", () => {
  assert.equal(normalizeId("a@b"), "<a@b>");
  assert.equal(normalizeId(" <a@b> "), "<a@b>");
  assert.equal(normalizeId(""), null);
  assert.deepEqual(headerIds("<one@x> <two@x>\t<three@x>"), ["<one@x>", "<two@x>", "<three@x>"]);
});

test("subscribe, list and unsubscribe round-trip, and subscribing again renews", async () => {
  const path = await store();
  const first = await subscribe(path, { account: "work", messageId: "sent@example.org", subject: "Trip", note: "Anja's answer" });
  assert.equal(first.subscription.rootId, "<sent@example.org>");
  const again = await subscribe(path, { account: "work", messageId: "<sent@example.org>", days: 60 });
  assert.equal(again.renewed, true);
  assert.equal((await list(path, { account: "work" })).length, 1);
  assert.deepEqual(await unsubscribe(path, { account: "work", messageId: "sent@example.org" }), { removed: 1 });
  assert.equal((await list(path)).length, 0);
});

test("a reply matches through In-Reply-To or through References alone", async () => {
  const path = await store();
  await subscribe(path, { account: "work", messageId: "<sent@example.org>" });
  const subscriptions = await list(path);
  assert.ok(matchReply(subscriptions, reply({ inReplyTo: "<sent@example.org>" }), { account: "work", self: account.email }));
  assert.ok(matchReply(subscriptions, reply({ references: "<root@x> <sent@example.org>" }), { account: "work", self: account.email }));
  assert.equal(matchReply(subscriptions, reply({ inReplyTo: "<other@example.org>" }), { account: "work", self: account.email }), null);
  assert.equal(matchReply(subscriptions, reply({ inReplyTo: "<sent@example.org>" }), { account: "personal", self: account.email }), null);
});

test("own mail, automatic replies and expired subscriptions never match", async () => {
  const path = await store();
  await subscribe(path, { account: "work", messageId: "<sent@example.org>", days: 1, now: Date.parse("2026-10-01T00:00:00Z") });
  const items = JSON.parse(await readFile(path, "utf8")).subscriptions;
  const options = { account: "work", self: account.email, now: Date.parse("2026-10-01T12:00:00Z") };
  assert.equal(matchReply(items, reply({ from: "ME@example.org", inReplyTo: "<sent@example.org>" }), options), null);
  assert.equal(matchReply(items, reply({ inReplyTo: "<sent@example.org>", autoReply: true }), options), null);
  assert.equal(matchReply(items, reply({ inReplyTo: "<sent@example.org>" }), { ...options, now: Date.parse("2026-10-03T00:00:00Z") }), null);
  assert.ok(matchReply(items, reply({ inReplyTo: "<sent@example.org>" }), options));
});

test("out-of-office and other automatic mail is recognised", () => {
  assert.equal(isAutoReply({ "auto-submitted": "auto-replied" }), true);
  assert.equal(isAutoReply({ "auto-submitted": "no" }), false);
  assert.equal(isAutoReply({ "x-autoreply": "yes" }), true);
  assert.equal(isAutoReply({ subject: "Automatische Antwort: AW: AW: Entschuldigung" }), true);
  assert.equal(isAutoReply({ subject: "Re: September 2026 timesheet" }), false);
});

test("raw headers are unfolded and keyed by lowercase name", () => {
  const headers = parseHeaders("References: <a@x>\r\n <b@x>\r\nAuto-Submitted: auto-replied\r\n\r\n");
  assert.equal(headers.references, "<a@x> <b@x>");
  assert.equal(headers["auto-submitted"], "auto-replied");
});

test("a reply is announced once, and an answer to that reply still matches", async () => {
  const path = await store();
  await subscribe(path, { account: "work", messageId: "<sent@example.org>", subject: "September timesheet", note: "trip application" });
  const events = [];
  const send = async (event) => { events.push(event); return { id: `evt_${events.length}` }; };
  const first = await announceReplies({ accountName: "work", account, subscriptionsPath: path, arrivals: [{ mailbox: "Important", message: reply({ inReplyTo: "<sent@example.org>" }) }], publish: send });
  assert.equal(first.delivered.length, 1);
  assert.equal(events[0].channel, "mail/replies/work");
  assert.equal(events[0].type, "mail.reply");
  assert.equal(events[0].data.note, "trip application");
  assert.equal(events[0].data.body, undefined);
  const repeat = await announceReplies({ accountName: "work", account, subscriptionsPath: path, arrivals: [{ mailbox: "INBOX", message: reply({ inReplyTo: "<sent@example.org>" }) }], publish: send });
  assert.equal(repeat.delivered.length, 0);
  const deeper = reply({ messageId: "<second@example.org>", inReplyTo: "<reply@example.org>" });
  const next = await announceReplies({ accountName: "work", account, subscriptionsPath: path, arrivals: [{ mailbox: "Additional", message: deeper }], publish: send });
  assert.equal(next.delivered.length, 1);
  assert.equal(events.length, 2);
});

test("an event the broker refuses is queued and delivered on the next poll", async () => {
  const path = await store();
  await subscribe(path, { account: "work", messageId: "<sent@example.org>" });
  const arrivals = [{ mailbox: "Important", message: reply({ inReplyTo: "<sent@example.org>" }) }];
  const down = await announceReplies({ accountName: "work", account, subscriptionsPath: path, arrivals, publish: async () => { throw new Error("connection refused"); } });
  assert.equal(down.failed.length, 1);
  const events = [];
  const up = await announceReplies({ accountName: "work", account, subscriptionsPath: path, arrivals: [], publish: async (event) => { events.push(event); } });
  assert.equal(up.delivered.length, 1);
  assert.equal(events[0].data.message_id, "<reply@example.org>");
  const after = await announceReplies({ accountName: "work", account, subscriptionsPath: path, arrivals: [], publish: async (event) => { events.push(event); } });
  assert.equal(after.delivered.length, 0);
});

test("the broker client posts the event with the watcher's token", async () => {
  let request;
  const fetchImpl = async (url, init) => { request = { url, init }; return { ok: true, json: async () => ({ id: "evt_1" }) }; };
  const result = await publish({ channel: "mail/replies/work", type: "mail.reply", data: { uid: 1 } }, { env: { MAIL_WATCHER_TOKEN: "secret", MAIL_WATCHER_BROKER_URL: "http://127.0.0.1:1" }, fetchImpl });
  assert.equal(result.id, "evt_1");
  assert.equal(request.url, "http://127.0.0.1:1/v1/events");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.equal(JSON.parse(request.init.body).channel, "mail/replies/work");
});

test("a watch matches by exact sender, by domain, by subject words, or by both", async () => {
  const path = await store();
  await watch(path, { account: "yandex", from: "noreply@booking.com", subject: "Homaris" });
  await watch(path, { account: "*", from: "@steampowered.com" });
  await watch(path, { account: "yandex", subject: "invoice 5688198373" });
  const watches = await listWatches(path, { account: "yandex" });
  assert.equal(watches.length, 3);
  const options = { account: "yandex", self: account.email };
  const hotel = reply({ from: "noreply@booking.com", subject: "You have a message from Homaris Apartments" });
  assert.equal(matchWatch(watches, hotel, options).from, "noreply@booking.com");
  assert.equal(matchWatch(watches, reply({ from: "noreply@booking.com", subject: "Your wishlist is on sale" }), options), null);
  assert.equal(matchWatch(watches, reply({ from: "support@steampowered.com", subject: "Thank you for your purchase" }), options).from, "@steampowered.com");
  assert.ok(matchWatch(watches, reply({ from: "cs@homaris.de", subject: "Ihre Invoice zu Buchung 5688198373" }), options));
  assert.equal(matchWatch(watches, reply({ from: "cs@homaris.de", subject: "Ihre Invoice" }), options), null);
  assert.equal(matchWatch(watches, reply({ from: "ME@example.org", subject: "Homaris invoice 5688198373" }), options), null);
});

test("a watch needs a criterion, renews instead of duplicating, and can be removed", async () => {
  const path = await store();
  await assert.rejects(watch(path, { account: "work", note: "anything" }), /sender, a subject query/);
  const first = await watch(path, { account: "work", from: "Noreply@Booking.com " });
  const again = await watch(path, { account: "work", from: "noreply@booking.com", note: "hotel" });
  assert.equal(again.renewed, true);
  assert.equal(again.watch.id, first.watch.id);
  assert.deepEqual(await unwatch(path, { id: first.watch.id }), { removed: 1 });
  assert.equal((await listWatches(path)).length, 0);
});

test("a watched notification is announced once as mail.watch, and a thread reply wins over a watch", async () => {
  const path = await store();
  await subscribe(path, { account: "yandex", messageId: "<sent@example.org>" });
  const { watch: item } = await watch(path, { account: "yandex", from: "@booking.com", note: "hotel invoice" });
  const events = [];
  const send = async (event) => { events.push(event); };
  const notification = reply({ messageId: "<n1@booking.com>", from: "noreply@booking.com", subject: "You have a message", headers: { "auto-submitted": "auto-generated" } });
  const threaded = reply({ messageId: "<r1@booking.com>", from: "noreply@booking.com", inReplyTo: "<sent@example.org>" });
  const first = await announceReplies({ accountName: "yandex", account, subscriptionsPath: path, arrivals: [{ mailbox: "INBOX", message: notification }, { mailbox: "INBOX", message: threaded }], publish: send });
  assert.equal(first.delivered.length, 2);
  assert.equal(events[0].type, "mail.watch");
  assert.equal(events[0].data.watch_id, item.id);
  assert.equal(events[0].data.note, "hotel invoice");
  assert.equal(events[1].type, "mail.reply");
  const repeat = await announceReplies({ accountName: "yandex", account, subscriptionsPath: path, arrivals: [{ mailbox: "INBOX", message: notification }], publish: send });
  assert.equal(repeat.delivered.length, 0);
});
