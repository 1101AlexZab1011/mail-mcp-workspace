import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
function inside(path, parent) { const value = relative(parent, path); return value === "" || (!value.startsWith("..") && !isAbsolute(value)); }
function protectedPaths() { const home = homedir(); return [resolve(home, ".config/email-mcp"), resolve(home, ".config/mail-mcp-workspace")]; }
export async function validateAttachments(attachments) {
  // A reply often carries no file, and sending it here rather than through the mail
  // server's own reply tool is what gets a copy filed in Sent.
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) throw new Error("Attachments must be a list.");
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments are allowed.`);
  let totalBytes = 0; const validated = [];
  for (const attachment of attachments) {
    if (!attachment?.path || !isAbsolute(attachment.path)) throw new Error("Each attachment path must be absolute.");
    const sourceInfo = await lstat(attachment.path);
    if (sourceInfo.isSymbolicLink()) throw new Error(`Attachment paths must not be symbolic links: ${attachment.path}`);
    const path = await realpath(attachment.path);
    if (protectedPaths().some((parent) => inside(path, parent))) throw new Error("Attachments may not be read from credential or workspace-config directories.");
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Attachment must be a regular file: ${attachment.path}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`Attachment exceeds the ${MAX_FILE_BYTES} byte limit: ${attachment.path}`);
    totalBytes += info.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Attachments exceed the ${MAX_TOTAL_BYTES} byte total limit.`);
    validated.push({ path, filename: attachment.filename || basename(path), contentType: attachment.content_type || undefined, size: info.size });
  }
  return validated;
}
function smtpTransport(account) {
  if (!account?.smtp?.host || !account?.password) throw new Error("This account needs password-authenticated SMTP settings in email-mcp config.");
  return nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port ?? 465, secure: account.smtp.tls !== false && account.smtp.starttls !== true, requireTLS: account.smtp.starttls === true, auth: { user: account.username ?? account.email, pass: account.password }, tls: { rejectUnauthorized: account.smtp.verify_ssl !== false } });
}
function sender(account) { return account.full_name ? `"${account.full_name.replaceAll('"', "\\\"")}" <${account.email}>` : account.email; }
async function appendSentCopy(account, raw) {
  const client = new ImapFlow({ host: account.imap.host, port: account.imap.port ?? 993, secure: account.imap.tls !== false, auth: { user: account.username ?? account.email, pass: account.password }, logger: false, tls: { rejectUnauthorized: account.imap.verify_ssl !== false } });
  await client.connect();
  try {
    const mailboxes = await client.list();
    const sent = mailboxes.find((mailbox) => mailbox.specialUse === "\\Sent")?.path ?? "Sent";
    await client.append(sent, raw, ["\\Seen"]);
    return sent;
  } finally { await client.logout(); }
}
// Threading is by header: In-Reply-To carries the message being answered, References the
// chain it belongs to. Without both, mail clients file the reply as a new conversation.
export function messageFor({ account, to, cc, bcc, subject, body, html, files, in_reply_to, references }) {
  const chain = references ?? (in_reply_to ? [in_reply_to] : undefined);
  return { from: sender(account), to, cc, bcc, subject, text: html ? undefined : body, html: html ? body : undefined, inReplyTo: in_reply_to, references: chain, attachments: files.map(({ path, filename, contentType }) => ({ path, filename, contentType })) };
}
export async function sendWithAttachments({ account, to, cc, bcc, subject, body, html, attachments, in_reply_to, references }) {
  const files = await validateAttachments(attachments);
  const message = messageFor({ account, to, cc, bcc, subject, body, html, files, in_reply_to, references });
  const built = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(message);
  const recipients = [to, cc, bcc].flatMap((value) => value ? (Array.isArray(value) ? value : [value]) : []);
  const result = await smtpTransport(account).sendMail({ raw: built.message, envelope: { from: account.email, to: recipients } });
  const sent_mailbox = await appendSentCopy(account, built.message);
  return { message_id: result.messageId, accepted: result.accepted, rejected: result.rejected, sent_mailbox, attachments: files.map(({ filename, size }) => ({ filename, size })) };
}
