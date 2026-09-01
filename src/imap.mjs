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

export async function fetchMessages(account, mailbox, limit = 100) {
  return withMailbox(account, mailbox, async (client) => {
    const result = [];
    for await (const message of client.fetch("1:*", { uid: true, envelope: true, flags: true, internalDate: true, source: true }, { uid: false })) {
      result.push({
        uid: message.uid,
        messageId: message.envelope?.messageId ?? `${mailbox}:${message.uid}`,
        subject: message.envelope?.subject ?? "",
        from: message.envelope?.from?.[0]?.address ?? "",
        date: message.internalDate?.toISOString() ?? null,
        answered: message.flags?.has("\\Answered") ?? false,
        body: message.source?.toString("utf8").slice(0, 12000) ?? "",
      });
    }
    return result.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
  });
}

export async function moveMessage(account, mailbox, uid, destination) {
  return withMailbox(account, mailbox, async (client) => client.messageMove(uid, destination, { uid: true }));
}

export async function ensureMailbox(account, mailbox) {
  return withMailbox(account, "INBOX", async (client) => client.mailboxCreate(mailbox));
}
