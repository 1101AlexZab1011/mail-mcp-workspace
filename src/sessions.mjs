// Agent Chat sessions. Each session is its own chat channel with a fixed id; the
// name the user sees is only a label. The list lives on the broker as the latest
// `sessions` event on mail/chat/sessions, written by the panel (and by agents
// creating a session), read by everyone. Agent 1 is `default` and always exists.
export const SESSIONS_CHANNEL = "mail/chat/sessions";
export const DEFAULT_SESSION = "default";
export const DEFAULT_SESSIONS = [{ id: DEFAULT_SESSION, name: "Agent 1" }];

const sessionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isSessionId = (value) => typeof value === "string" && sessionId.test(value) && value !== "sessions";

export const chatChannel = (id) => `mail/chat/${id}`;

/** The session list carried by a `sessions` event, or null if the event is not one. */
export function sessionsFrom(event) {
  const list = event?.type === "sessions" ? event.data?.sessions : null;
  if (!Array.isArray(list)) return null;
  const sessions = list.filter((item) => isSessionId(item?.id) && typeof item.name === "string");
  return sessions.some((item) => item.id === DEFAULT_SESSION) ? sessions : [...DEFAULT_SESSIONS, ...sessions];
}
