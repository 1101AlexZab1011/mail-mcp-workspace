import { accountPolicy } from "./config.mjs";
import { classifyResponseStatus, classifyUrgency, matchGroup } from "./classification.mjs";
import { copyMessageAsUnread, ensureMailbox, fetchMessages, fetchMessagesAfterUid, listMailboxes, mailboxCursor, moveMessage } from "./imap.mjs";
import { readState, recordKey, writeState } from "./state.mjs";
import { announceReplies } from "./replies.mjs";
import { list as listSubscriptions, listWatches } from "./subscriptions.mjs";

function serialize(record) { const { body, ...safe } = record; return safe; }

export async function classifyMailbox({ accountName, account, policy, statePath, mailbox = "INBOX", limit = 100 }) {
  const messages = await fetchMessages(account, mailbox, limit);
  const state = await readState(statePath);
  const records = messages.map((message) => {
    const key = recordKey(accountName, message.messageId);
    const existing = state.records[key];
    const derived = classifyResponseStatus(message);
    const result = existing?.override
      ? { status: existing.status, reason: existing.reason, overridden: true }
      : { ...derived, overridden: false };
    state.records[key] = { ...serialize(message), account: accountName, mailbox, ...result, classifiedAt: new Date().toISOString() };
    return state.records[key];
  });
  await writeState(statePath, state);
  return records;
}

export async function searchStatuses({ accountName, status, statePath }) {
  const state = await readState(statePath);
  return Object.values(state.records).filter((record) => record.account === accountName && (!status || record.status === status));
}

export async function overrideStatus({ accountName, messageId, status, reason, statePath }) {
  const state = await readState(statePath);
  const key = recordKey(accountName, messageId);
  if (!state.records[key]) throw new Error("Message has not been classified yet. Run classify_mailbox first.");
  state.records[key] = { ...state.records[key], status, reason, override: true, overriddenAt: new Date().toISOString() };
  await writeState(statePath, state);
  return state.records[key];
}

export async function reviewPending({ accountName, account, policy, statePath, dryRun = true, limit = 100 }) {
  const configured = accountPolicy(policy, accountName);
  const mailboxes = await listMailboxes(account);
  const pending = mailboxes.filter((name) => name === "Pending" || name.startsWith("Pending/"));
  const results = [];
  for (const mailbox of pending) {
    for (const message of await fetchMessages(account, mailbox, limit)) {
      const urgency = classifyUrgency(message);
      const status = classifyResponseStatus(message);
      const state = await readState(statePath);
      const key = recordKey(accountName, message.messageId);
      if (!state.records[key]?.override) {
        state.records[key] = { ...serialize(message), account: accountName, mailbox, ...status, classifiedAt: new Date().toISOString() };
        await writeState(statePath, state);
      }
      const group = matchGroup(message.subject, configured.subject_rules);
      const destination = `Active/${group}`;
      const canMove = !urgency.important && configured.filing_mode === "existing-folders" && configured.approved_folders.includes(group);
      let action = urgency.important ? "leave-pending" : "propose";
      if (!dryRun && canMove) {
        await moveMessage(account, mailbox, message.uid, destination);
        const state = await readState(statePath);
        state.actions.push({ type: "move", account: accountName, messageId: message.messageId, uid: message.uid, from: mailbox, to: destination, at: new Date().toISOString(), rationale: urgency.reason });
        await writeState(statePath, state);
        action = "moved";
      }
      results.push({ ...serialize(message), mailbox, response_status: status.status, response_status_reason: status.reason, important: urgency.important, importance_reason: urgency.reason, destination, action });
    }
  }
  return results;
}

const nonDeliveryMailbox = (mailbox) => ["Active", "Archived", "Drafts", "Junk", "Pending", "Sent", "Trash"].some((root) => mailbox === root || mailbox.startsWith(`${root}/`));

export function routingSourceMailboxes(mailboxes, configured) {
  const configuredSources = configured.routing_source_mailboxes;
  if (Array.isArray(configuredSources) && configuredSources.length) return configuredSources.filter((mailbox) => mailboxes.includes(mailbox));
  return mailboxes.filter((mailbox) => !nonDeliveryMailbox(mailbox));
}

export async function routeInbox({ accountName, account, policy, statePath, subscriptionsPath, publish, dryRun = true }) {
  const configured = accountPolicy(policy, accountName);
  if (configured.routing_mode !== "watcher") return { routed: [], skipped: "routing_mode is provider; the provider is responsible for inbound routing." };
  const sources = routingSourceMailboxes(await listMailboxes(account), configured);
  const state = await readState(statePath);
  const routing = state.routing ?? {};
  const accountRouting = routing[accountName] ?? { mailboxes: {} };
  const checkpoints = accountRouting.mailboxes ?? {};
  const routed = [];
  const initialized = [];
  const arrivals = [];

  // A per-mailbox UID cursor makes the first live run a baseline. This avoids
  // copying historic mail, including mail delivered outside INBOX, while later
  // polls fetch only messages that arrived after that baseline.
  for (const mailbox of sources) {
    const cursor = await mailboxCursor(account, mailbox);
    const checkpoint = checkpoints[mailbox];
    if (!checkpoint || cursor < checkpoint.lastUid) {
      if (!dryRun) {
        checkpoints[mailbox] = { lastUid: cursor, initializedAt: new Date().toISOString() };
        initialized.push(mailbox);
      }
      continue;
    }
    if (dryRun || cursor === checkpoint.lastUid) continue;
    const messages = await fetchMessagesAfterUid(account, mailbox, checkpoint.lastUid);
    for (const message of messages) {
      arrivals.push({ mailbox, message });
      const group = matchGroup(message.subject, configured.subject_rules);
      const destination = `Pending/${group}`;
      await ensureMailbox(account, destination);
      await copyMessageAsUnread(account, mailbox, message.uid, destination);
      state.actions.push({ type: "route-copy", account: accountName, messageId: message.messageId, uid: message.uid, from: mailbox, to: destination, at: new Date().toISOString() });
      routed.push({ ...serialize(message), mailbox, destination, action: "copied" });
    }
    checkpoints[mailbox] = { ...checkpoint, lastUid: cursor, lastRunAt: new Date().toISOString() };
  }
  if (!dryRun) {
    routing[accountName] = { ...accountRouting, mailboxes: checkpoints, initializedAt: accountRouting.initializedAt ?? new Date().toISOString(), lastRunAt: new Date().toISOString() };
    state.routing = routing;
    await writeState(statePath, state);
  }
  // Reply announcements run after routing is saved, and a broker or subscription
  // problem is reported rather than thrown, so it can never hold up routing.
  let replies = null;
  if (!dryRun && subscriptionsPath) {
    replies = await announceReplies({ accountName, account, subscriptionsPath, arrivals, ...(publish ? { publish } : {}) }).catch((error) => ({ error: error.message }));
  }
  return { routed: routed.map(({ headers, ...item }) => item), initialized, sources, dry_run: dryRun, ...(replies ? { replies } : {}) };
}

const FIRST_LOOK_WINDOW = 200;

// Accounts the workflow does not route still get reply notices. Their provider files the
// mail, so only the mailboxes replies land in are read (INBOX unless the policy names
// `reply_mailboxes`), and nothing is moved or marked. An account with no live
// subscription or mail watch is not contacted at all.
export async function watchReplies({ accountName, account, policy, statePath, subscriptionsPath, publish, now = Date.now() }) {
  const active = [...await listSubscriptions(subscriptionsPath, { account: accountName, now }), ...await listWatches(subscriptionsPath, { account: accountName, now })];
  if (!active.length) return { skipped: "no active subscriptions or watches" };
  const configured = accountPolicy(policy, accountName);
  const mailboxes = Array.isArray(configured.reply_mailboxes) && configured.reply_mailboxes.length ? configured.reply_mailboxes : ["INBOX"];
  const state = await readState(statePath);
  const watch = state.replyWatch ?? {};
  const checkpoints = watch[accountName]?.mailboxes ?? {};
  const since = Math.min(...active.map((item) => Date.parse(item.createdAt)));
  const arrivals = [];
  for (const mailbox of mailboxes) {
    const cursor = await mailboxCursor(account, mailbox);
    let lastUid = checkpoints[mailbox]?.lastUid;
    // On the first look, or after the server renumbered the mailbox, the recent window is
    // read back to the oldest subscription, so a reply that came before this poll is not
    // skipped. A date SEARCH would be shorter, but Yandex drops the connection on it.
    const baseline = lastUid === undefined || cursor < lastUid;
    if (baseline) lastUid = Math.max(0, cursor - FIRST_LOOK_WINDOW);
    if (cursor > lastUid) {
      for (const message of await fetchMessagesAfterUid(account, mailbox, lastUid)) {
        if (!baseline || Date.parse(message.date) >= since - 86_400_000) arrivals.push({ mailbox, message });
      }
    }
    checkpoints[mailbox] = { lastUid: cursor, lastRunAt: new Date(now).toISOString() };
  }
  state.replyWatch = { ...watch, [accountName]: { mailboxes: checkpoints } };
  await writeState(statePath, state);
  const replies = await announceReplies({ accountName, account, subscriptionsPath, arrivals, now, ...(publish ? { publish } : {}) });
  return { mailboxes, replies };
}

export async function undoLastRun({ accountName, account, statePath }) {
  const state = await readState(statePath);
  const action = [...state.actions].reverse().find((item) => item.account === accountName && !item.undone && (item.type === "move" || item.type === "route"));
  if (!action) return { undone: false, message: "No reversible action found." };
  await moveMessage(account, action.to, action.uid, action.from);
  action.undone = true;
  action.undoneAt = new Date().toISOString();
  await writeState(statePath, state);
  return { undone: true, action };
}

export async function fileReviewedMessage({ accountName, account, policy, statePath, mailbox, uid, messageId, group, createGroup = false }) {
  const configured = accountPolicy(policy, accountName);
  if (!['existing-folders', 'managed-groups'].includes(configured.filing_mode)) {
    throw new Error("Filing is disabled by this account's policy. Use review or propose mode until the account owner opts in.");
  }
  if (configured.filing_mode === 'existing-folders' && !configured.approved_folders.includes(group)) {
    throw new Error(`Group ${group} is not in this account's approved_folders allowlist.`);
  }
  const destination = `Active/${group}`;
  if (createGroup) {
    if (configured.filing_mode !== 'managed-groups' || configured.allow_new_groups !== true) {
      throw new Error("New group creation requires managed-groups mode and allow_new_groups=true in the local account policy.");
    }
    await ensureMailbox(account, destination);
  }
  await moveMessage(account, mailbox, uid, destination);
  const state = await readState(statePath);
  state.actions.push({ type: 'move', account: accountName, messageId, uid, from: mailbox, to: destination, at: new Date().toISOString(), source: 'agent-review' });
  await writeState(statePath, state);
  return { moved: true, destination };
}
