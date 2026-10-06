import { publish as brokerPublish } from "./broker.mjs";
import { isAutoReply, list, listWatches, matchReply, matchWatch, normalizeId, recordNotified, recordWatchHits, update } from "./subscriptions.mjs";

export const replyChannel = (account) => `mail/replies/${account}`;

// The event names the reply and where it is; it never carries the body. Mail text is
// untrusted, and the agent reads it with the ordinary read tools when it wakes.
function eventFor(accountName, mailbox, message, subscription) {
  return {
    channel: replyChannel(accountName),
    type: "mail.reply",
    data: {
      text: `Reply from ${message.from} to "${subscription.subject || message.subject}"`,
      account: accountName,
      mailbox,
      uid: message.uid,
      message_id: normalizeId(message.messageId),
      from: message.from,
      subject: message.subject,
      date: message.date,
      root_id: subscription.rootId,
      note: subscription.note || undefined,
    },
  };
}

// A watch hit is announced like a reply, on the same channel, but names the watch
// that matched instead of a thread.
function watchEventFor(accountName, mailbox, message, item) {
  return {
    channel: replyChannel(accountName),
    type: "mail.watch",
    data: {
      text: `Mail from ${message.from}: "${message.subject}"`,
      account: accountName,
      mailbox,
      uid: message.uid,
      message_id: normalizeId(message.messageId),
      from: message.from,
      subject: message.subject,
      date: message.date,
      watch_id: item.id,
      watch: { from: item.from || undefined, subject: item.subject || undefined },
      note: item.note || undefined,
    },
  };
}

async function deliver(path, accountName, events, publish) {
  const delivered = [];
  const failed = [];
  for (const event of events) {
    try { await publish(event); delivered.push(event); }
    catch (error) { failed.push({ ...event, error: error.message }); }
  }
  await recordNotified(path, { account: accountName, hits: delivered.filter((event) => event.data.root_id).map((event) => ({ rootId: event.data.root_id, messageId: event.data.message_id })) });
  await recordWatchHits(path, { hits: delivered.filter((event) => event.data.watch_id).map((event) => ({ watchId: event.data.watch_id, messageId: event.data.message_id })) });
  // The routing checkpoint has already moved past these messages, so an event the
  // broker could not take is kept here and retried on the next poll.
  await update(path, (state) => {
    const queue = (state.queue ?? []).filter((event) => !delivered.some((done) => done.data.message_id === event.data.message_id));
    for (const event of failed) if (!queue.some((item) => item.data.message_id === event.data.message_id)) queue.push(event);
    state.queue = queue;
  });
  return { delivered: delivered.map((event) => event.data), failed: failed.map(({ data, error }) => ({ ...data, error })) };
}

/** Announce new messages that answer a subscribed thread or match a mail watch, and retry earlier failures. */
export async function announceReplies({ accountName, account, subscriptionsPath, arrivals, publish = brokerPublish, now = Date.now() }) {
  const subscriptions = await list(subscriptionsPath, { account: accountName, now });
  const watches = await listWatches(subscriptionsPath, { account: accountName, now });
  const { queue = [] } = await update(subscriptionsPath, (state) => ({ queue: [...(state.queue ?? [])] }));
  const events = queue.filter((event) => event.data.account === accountName).map(({ error, ...event }) => event);
  const seen = new Set(events.map((event) => event.data.message_id));
  for (const { mailbox, message } of arrivals) {
    const id = normalizeId(message.messageId);
    if (!id || seen.has(id)) continue;
    const options = { account: accountName, self: account.email, now };
    const subscription = matchReply(subscriptions, { ...message, autoReply: isAutoReply(message.headers ?? {}) }, options);
    const watched = subscription ? null : matchWatch(watches, message, options);
    if (!subscription && !watched) continue;
    seen.add(id);
    events.push(subscription ? eventFor(accountName, mailbox, message, subscription) : watchEventFor(accountName, mailbox, message, watched));
  }
  if (!events.length) return { delivered: [], failed: [] };
  return deliver(subscriptionsPath, accountName, events, publish);
}
