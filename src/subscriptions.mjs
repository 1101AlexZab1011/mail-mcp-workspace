import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// Reply subscriptions live in their own file rather than state.json: the MCP tools
// and the watcher both change them, and routeInbox holds state.json in memory for a
// whole poll, so sharing that file would let one writer drop the other's changes.
export const defaultSubscriptionsPath = resolve(homedir(), ".local/state/mail-mcp-workspace/subscriptions.json");
export const DEFAULT_DAYS = 30;
const LOCK_STALE_MS = 10_000;

const empty = () => ({ version: 1, subscriptions: [], watches: [] });

/** "<a@b>" for "a@b", " <a@b> " or "<a@b>"; null for anything without an id. */
export function normalizeId(value) {
  const id = String(value ?? "").trim().replace(/^<|>$/g, "").trim();
  return id ? `<${id}>` : null;
}

/** Message-IDs named in an In-Reply-To or References header value. */
export function headerIds(value) {
  return [...String(value ?? "").matchAll(/<[^<>\s]+>/g)].map((match) => match[0]);
}

async function read(path) {
  try { return { ...empty(), ...JSON.parse(await readFile(path, "utf8")) }; }
  catch (error) { if (error.code === "ENOENT") return empty(); throw error; }
}

async function write(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

// A directory lock: mkdir is atomic, and a lock older than LOCK_STALE_MS belongs to a
// process that died mid-update, so it is taken over rather than waited on forever.
async function locked(path, work) {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt += 1) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > LOCK_STALE_MS) { await rm(lock, { recursive: true, force: true }); continue; }
      if (attempt > 200) throw new Error(`Subscriptions are locked: ${lock}`);
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  try { return await work(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function update(path, change) {
  return locked(path, async () => {
    const current = await read(path);
    const result = await change(current);
    await write(path, current);
    return result;
  });
}

const live = (subscription, now) => !subscription.expiresAt || Date.parse(subscription.expiresAt) > now;

export async function subscribe(path, { account, messageId, subject = "", to = [], note = "", chat = "", days = DEFAULT_DAYS, now = Date.now() }) {
  const rootId = normalizeId(messageId);
  if (!rootId) throw new Error("A Message-ID is required to subscribe.");
  const expiresAt = new Date(now + days * 86_400_000).toISOString();
  return update(path, (state) => {
    const existing = state.subscriptions.find((item) => item.account === account && item.ids.includes(rootId));
    if (existing) {
      Object.assign(existing, { expiresAt, ...(note ? { note } : {}), ...(subject ? { subject } : {}), ...(chat ? { chat } : {}) });
      return { subscribed: true, renewed: true, subscription: existing };
    }
    const subscription = { account, rootId, ids: [rootId], subject, to, note, ...(chat ? { chat } : {}), createdAt: new Date(now).toISOString(), expiresAt, notified: [] };
    state.subscriptions.push(subscription);
    return { subscribed: true, renewed: false, subscription };
  });
}

export async function unsubscribe(path, { account, messageId }) {
  const id = normalizeId(messageId);
  return update(path, (state) => {
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter((item) => !(item.account === account && item.ids.includes(id)));
    return { removed: before - state.subscriptions.length };
  });
}

export async function list(path, { account, now = Date.now() } = {}) {
  const state = await read(path);
  return state.subscriptions.filter((item) => (!account || item.account === account) && live(item, now));
}

/**
 * Whether a newly arrived message answers a subscribed thread. Self-sent mail,
 * automatic replies (out-of-office, receipts), expired subscriptions and messages
 * already notified about never match.
 */
export function matchReply(subscriptions, message, { account, self, now = Date.now() }) {
  const id = normalizeId(message.messageId);
  if (!id) return null;
  if (self && String(message.from ?? "").toLowerCase() === String(self).toLowerCase()) return null;
  if (message.autoReply) return null;
  const parents = [...headerIds(message.inReplyTo), ...headerIds(message.references)];
  if (!parents.length) return null;
  return subscriptions.find((item) => item.account === account && live(item, now) && !item.notified.includes(id) && parents.some((parent) => item.ids.includes(parent))) ?? null;
}

// Mail watches cover what thread subscriptions cannot: notifications (Booking.com,
// Steam, PayPal) arrive as new mail with no In-Reply-To, so they are matched by sender
// and subject instead. Automatic mail is the point here, so it is not filtered out.
const subjectWords = (value) => String(value ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/** "@example.org" matches the whole domain; anything else is one exact address. */
function senderMatches(pattern, from) {
  const sender = String(from ?? "").trim().toLowerCase();
  const wanted = String(pattern ?? "").trim().toLowerCase();
  return wanted.startsWith("@") ? sender.endsWith(wanted) : sender === wanted;
}

export async function watch(path, { account, from = "", subject = "", note = "", chat = "", days = DEFAULT_DAYS, now = Date.now() }) {
  if (!String(from).trim() && !subjectWords(subject).length) throw new Error("A watch needs a sender, a subject query, or both.");
  const expiresAt = new Date(now + days * 86_400_000).toISOString();
  return update(path, (state) => {
    const watches = state.watches ?? (state.watches = []);
    const same = (item) => item.account === account && item.from === from.trim().toLowerCase() && item.subject === subjectWords(subject).join(" ");
    const existing = watches.find(same);
    if (existing) {
      Object.assign(existing, { expiresAt, ...(note ? { note } : {}), ...(chat ? { chat } : {}) });
      return { watching: true, renewed: true, watch: existing };
    }
    const item = { id: `watch_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, account, from: from.trim().toLowerCase(), subject: subjectWords(subject).join(" "), note, ...(chat ? { chat } : {}), createdAt: new Date(now).toISOString(), expiresAt, notified: [] };
    watches.push(item);
    return { watching: true, renewed: false, watch: item };
  });
}

export async function unwatch(path, { id }) {
  return update(path, (state) => {
    const before = (state.watches ?? []).length;
    state.watches = (state.watches ?? []).filter((item) => item.id !== id);
    return { removed: before - state.watches.length };
  });
}

/** Live watches for an account, including those set on every account ("*"). */
export async function listWatches(path, { account, now = Date.now() } = {}) {
  const state = await read(path);
  return (state.watches ?? []).filter((item) => (!account || item.account === account || item.account === "*") && live(item, now));
}

/** The first live watch a new message satisfies; every given criterion must hold. */
export function matchWatch(watches, message, { account, self, now = Date.now() }) {
  const id = normalizeId(message.messageId);
  if (!id) return null;
  if (self && String(message.from ?? "").toLowerCase() === String(self).toLowerCase()) return null;
  const subject = String(message.subject ?? "").toLowerCase();
  return watches.find((item) => (item.account === account || item.account === "*") && live(item, now) && !item.notified.includes(id)
    && (!item.from || senderMatches(item.from, message.from))
    && subjectWords(item.subject).every((word) => subject.includes(word))) ?? null;
}

export async function recordWatchHits(path, { hits, now = Date.now() }) {
  return update(path, (state) => {
    for (const { watchId, messageId } of hits) {
      const item = (state.watches ?? []).find((entry) => entry.id === watchId);
      const id = normalizeId(messageId);
      if (item && !item.notified.includes(id)) item.notified.push(id);
    }
    state.watches = (state.watches ?? []).filter((item) => live(item, now));
  });
}

/** True for messages a mail system sent on its own (RFC 3834 and common vendor headers). */
export function isAutoReply(headers) {
  const autoSubmitted = String(headers["auto-submitted"] ?? "").trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (headers["x-autoreply"] || headers["x-autorespond"]) return true;
  // Exchange out-of-office replies do not always carry Auto-Submitted.
  return /^(automatische antwort|automatic reply|auto-?reply|out of office|abwesenheitsnotiz)\b/i.test(String(headers.subject ?? "").trim());
}

/**
 * Record the replies that were announced, and drop expired subscriptions. A reply's
 * own id joins the thread, so an answer to that reply still matches.
 */
export async function recordNotified(path, { account, hits, now = Date.now() }) {
  return update(path, (state) => {
    for (const { rootId, messageId } of hits) {
      const subscription = state.subscriptions.find((item) => item.account === account && item.rootId === rootId);
      if (!subscription) continue;
      const id = normalizeId(messageId);
      if (!subscription.notified.includes(id)) subscription.notified.push(id);
      if (!subscription.ids.includes(id)) subscription.ids.push(id);
    }
    state.subscriptions = state.subscriptions.filter((item) => live(item, now));
    return state.subscriptions.length;
  });
}
