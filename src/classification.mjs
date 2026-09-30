const REPLY_PREFIX = /^(?:(?:re|aw|sv|fwd?|svar)\s*:\s*)+/i;

export function normalizeSubject(subject = "") {
  return subject.replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function classifyResponseStatus({ subject = "", body = "", answered = false }) {
  const text = `${subject}\n${body}`.toLowerCase();
  const asksForReply = /\b(reply|respond|response|let me know|please (?:confirm|send|approve|review)|can you|could you|would you|do you|are you|\?)\b/.test(text);
  if (!asksForReply) return { status: "no-reply", reason: "No concrete request for a reply was detected." };
  if (answered) return { status: "replied", reason: "The message requests a reply and has the IMAP Answered flag." };
  return { status: "unreplied", reason: "The message appears to request a reply and has no IMAP Answered flag." };
}

export function classifyUrgency({ subject = "", body = "" }) {
  const text = `${subject}\n${body}`.toLowerCase();
  const urgent = /\b(urgent|asap|today|tomorrow|deadline|expires?|overdue|security|suspicious|verify|password|account access|action required|final notice)\b/.test(text);
  return urgent
    ? { important: true, reason: "The message contains a time-sensitive action, deadline, or security signal." }
    : { important: false, reason: "No immediate action, deadline, or security signal was detected." };
}

const escapeKeyword = (keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Substring matching made short keywords catch anything: "it" matched Invitation and
// Institute, so most institute mail was filed as IT. Keywords match whole words instead,
// with the boundaries written out because \b does not work next to non-ASCII letters.
const keywordPattern = (keyword) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeKeyword(keyword.toLowerCase())}(?![\\p{L}\\p{N}])`, "u");

export function matchGroup(subject, rules = []) {
  const normalized = normalizeSubject(subject);
  for (const rule of rules) {
    if ((rule.keywords ?? []).some((keyword) => keywordPattern(keyword).test(normalized))) return rule.group;
  }
  return "General";
}
