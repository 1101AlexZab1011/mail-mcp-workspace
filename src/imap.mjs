import { ImapFlow } from "imapflow";

export async function withMailbox(account, mailbox, work) {
  if (!account?.imap?.host || !account?.password) throw new Error("This workflow currently requires a password-authenticated IMAP account in email-mcp config.");
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port ?? 993,
    secure: account.imap.tls !== false,
    auth: { user: account.username ?? account.email, pass: account.password },
    tls: { rejectUnauthorized: account.imap.verify_ssl !== false },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try { return await work(client); }
  finally { lock.release(); await client.logout(); }
}

export async function listMailboxes(account) {
  return withMailbox(account, "INBOX", async (client) => {
    const boxes = await client.list();
    return boxes.map((box) => box.path);
  });
}

export async function mailboxCursor(account, mailbox) {
  return withMailbox(account, mailbox, async (client) => Math.max(0, (client.mailbox?.uidNext ?? 1) - 1));
}

export async function fetchMessages(account, mailbox, limit = 100, { includeSource = true } = {}) {
  return withMailbox(account, mailbox, async (client) => {
    const result = [];
    const query = { uid: true, envelope: true, flags: true, internalDate: true };
    if (includeSource) query.source = true;
    for await (const message of client.fetch("1:*", query, { uid: false })) {
      result.push({
        uid: message.uid,
        messageId: message.envelope?.messageId ?? `${mailbox}:${message.uid}`,
        subject: message.envelope?.subject ?? "",
        from: message.envelope?.from?.[0]?.address ?? "",
        date: message.internalDate?.toISOString() ?? null,
        answered: message.flags?.has("\\Answered") ?? false,
        body: includeSource ? (message.source?.toString("utf8").slice(0, 12000) ?? "") : "",
      });
    }
    return result.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
  });
}

export async function fetchMessagesAfterUid(account, mailbox, afterUid, { includeSource = false } = {}) {
  return withMailbox(account, mailbox, async (client) => {
    const result = [];
    const query = { uid: true, envelope: true, flags: true, internalDate: true };
    if (includeSource) query.source = true;
    for await (const message of client.fetch(`${Math.max(1, afterUid + 1)}:*`, query, { uid: true })) {
      result.push({
        uid: message.uid,
        messageId: message.envelope?.messageId ?? `${mailbox}:${message.uid}`,
        subject: message.envelope?.subject ?? "",
        from: message.envelope?.from?.[0]?.address ?? "",
        date: message.internalDate?.toISOString() ?? null,
        answered: message.flags?.has("\\Answered") ?? false,
        body: includeSource ? (message.source?.toString("utf8").slice(0, 12000) ?? "") : "",
      });
    }
    return result.sort((a, b) => a.uid - b.uid);
  });
}

export async function moveMessage(account, mailbox, uid, destination) {
  return withMailbox(account, mailbox, async (client) => client.messageMove(uid, destination, { uid: true }));
}

export async function copyMessageAsUnread(account, mailbox, uid, destination) {
  return withMailbox(account, mailbox, async (client) => {
    const original = await client.fetchOne(uid, { flags: true }, { uid: true });
    const wasSeen = original?.flags?.has("\\Seen") ?? false;
    if (wasSeen) await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
    let copied = false;
    try {
      const result = await client.messageCopy(uid, destination, { uid: true });
      if (!result) throw new Error(`Unable to copy message ${uid} from ${mailbox} to ${destination}`);
      copied = true;
      return result;
    } finally {
      if (copied || wasSeen) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    }
  });
}

export async function ensureMailbox(account, mailbox) {
  return withMailbox(account, "INBOX", async (client) => client.mailboxCreate(mailbox));
}
