/* about:logins, the list as data: which saved logins it shows and in what order. A plain script: the page
   loads it, and the tests load it with node:vm. */

/** Web logins only: Thunderbird's own (mail, news, chat, OAuth) stay in its Settings. */
function isWebLogin(login) {
  return /^https?:\/\//i.test(String(login?.origin ?? ""));
}

/** The name Firefox lists a login under: its host, without a leading "www.". */
function loginTitle(login) {
  try {
    return new URL(login.origin).host.replace(/^www\./i, "");
  } catch {
    return String(login?.origin ?? "");
  }
}

/** Logins whose name, address or username contain every word of `query`. */
function filterLogins(logins, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return logins;
  return logins.filter((login) => {
    const hay = `${loginTitle(login)} ${login.origin} ${login.username ?? ""}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

var LOGIN_SORTS = {
  "name": "Name (A-Z)",
  "name-reverse": "Name (Z-A)",
  "last-used": "Last used",
  "last-changed": "Last changed",
};

/** A sorted copy: by name (then username), or newest first by use or by password change. */
function sortLogins(logins, by = "name") {
  const byName = (a, b) => loginTitle(a).localeCompare(loginTitle(b)) || String(a.username ?? "").localeCompare(String(b.username ?? ""));
  const compare = {
    "name": byName,
    "name-reverse": (a, b) => byName(b, a),
    "last-used": (a, b) => (b.timeLastUsed ?? 0) - (a.timeLastUsed ?? 0) || byName(a, b),
    "last-changed": (a, b) => (b.timePasswordChanged ?? 0) - (a.timePasswordChanged ?? 0) || byName(a, b),
  }[by] ?? byName;
  return [...logins].sort(compare);
}

/** What the user typed as a website → the origin a login is saved for ("example.org" → https://example.org). */
function loginOrigin(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The icon to show for a login: its host's, else its www twin's, else a parent domain's (google.com for
    accounts.google.com). `icons` maps hosts to icon URLs. */
function siteIconFor(icons, origin) {
  let host;
  try { host = new URL(origin).hostname; } catch { return null; }
  const bare = host.replace(/^www\./, "");
  const names = [host, bare, `www.${bare}`];
  const parts = bare.split(".");
  for (let i = 1; i < parts.length - 1; i++) names.push(parts.slice(i).join("."), `www.${parts.slice(i).join(".")}`);
  for (const name of names) if (icons?.[name]) return icons[name];
  return null;
}
