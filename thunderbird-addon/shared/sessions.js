// Agent Chat sessions, as the add-on sees them (src/sessions.mjs is the Node side).
// A session is a chat channel with a fixed id; its name is only a label. The list is
// the latest `sessions` event on mail/chat/sessions. Agent 1 is `default`, always.
export const SESSIONS_CHANNEL = "mail/chat/sessions";
export const DEFAULT_SESSION = "default";
export const DEFAULT_SESSIONS = [{ id: DEFAULT_SESSION, name: "Agent 1" }];

const sessionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isSessionId = (value) => typeof value === "string" && sessionId.test(value) && value !== "sessions";
export const chatChannel = (id) => `mail/chat/${id}`;
/** The session a chat channel belongs to, or null (the list channel is no session). */
export const sessionOfChannel = (channel) => {
  const id = /^mail\/chat\/([^/]+)$/.exec(channel)?.[1];
  return id && isSessionId(id) ? id : null;
};
/** The session a listener group serves: `mail-chat-<id>`, as the mail app profile names them. */
export const sessionOfGroup = (group) => (group.startsWith("mail-chat-") ? group.slice(10) : null);

/** The session list carried by a `sessions` event, or null if the event is not one. */
export function sessionsFrom(event) {
  const list = event?.type === "sessions" ? event.data?.sessions : null;
  if (!Array.isArray(list)) return null;
  const sessions = list.filter((item) => isSessionId(item?.id) && typeof item.name === "string");
  return sessions.some((item) => item.id === DEFAULT_SESSION) ? sessions : [...DEFAULT_SESSIONS, ...sessions];
}

/** "Agent N" with the lowest N no session is called, so a freed name is reused. */
export function nextName(sessions) {
  const taken = new Set(sessions.map((item) => item.name.trim().toLowerCase()));
  let number = 1;
  while (taken.has(`agent ${number}`)) number++;
  return `Agent ${number}`;
}

export function newSessionId(sessions) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const id = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
    if (isSessionId(id) && !sessions.some((item) => item.id === id)) return id;
  }
}

// The open session is remembered per profile, so the panel reopens where it was and
// other pages (artifacts asking the agent) know which session the user is looking at.
export async function openSession() {
  try { return (await browser.storage.local.get({ chatSession: DEFAULT_SESSION })).chatSession; }
  catch { return DEFAULT_SESSION; }
}
export async function rememberOpenSession(id) {
  try { await browser.storage.local.set({ chatSession: id }); } catch { /* reopens on Agent 1 */ }
}
