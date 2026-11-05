/* The Browser's sessions as data: each is a named browser profile with its own container (cookies, logins,
   storage). A plain script: the Experiment loads it into its scope, and the tests load it with node:vm. */

var WEB_SESSIONS_PREF = "extensions.mailworkspace.webSessions";

/** The stored list → { sessions: [{ id, name, userContextId }], last }; anything malformed is dropped. */
function parseWebSessions(text) {
  let data;
  try { data = JSON.parse(text || "{}"); } catch { data = {}; }
  const sessions = [];
  for (const item of Array.isArray(data?.sessions) ? data.sessions : []) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const userContextId = Number(item?.userContextId);
    // Container 0 is Thunderbird's own (mail sign-ins): a session never uses it.
    if (!id || !name || !Number.isInteger(userContextId) || userContextId <= 0) continue;
    if (sessions.some((s) => s.id === id || s.userContextId === userContextId)) continue;
    sessions.push({ id, name, userContextId });
  }
  const last = sessions.some((s) => s.id === data?.last) ? data.last : sessions[0]?.id ?? null;
  return { sessions, last };
}

function serializeWebSessions({ sessions, last }) {
  return JSON.stringify({ sessions: sessions.map(({ id, name, userContextId }) => ({ id, name, userContextId })), last });
}

/** A session by id, or by name ignoring case. */
function findWebSession(sessions, key) {
  const text = String(key ?? "").trim();
  if (!text) return null;
  return sessions.find((s) => s.id === text) ?? sessions.find((s) => s.name.toLowerCase() === text.toLowerCase()) ?? null;
}

/** "Session N" for a new session: the first free number after the sessions there are. */
function webSessionName(sessions) {
  const taken = new Set(sessions.map((s) => s.name.toLowerCase()));
  let n = sessions.length + 1;
  while (taken.has(`session ${n}`)) n++;
  return `Session ${n}`;
}

/** Six random lowercase letters and digits, unused by the sessions there are. */
function newWebSessionId(sessions, random = Math.random) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    let id = "";
    for (let i = 0; i < 6; i++) id += chars[Math.floor(random() * chars.length)];
    if (!sessions.some((s) => s.id === id)) return id;
  }
}
