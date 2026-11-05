/* The Browser's history as data: one list per session, newest first, one entry per address (a revisit
   moves it to the top), capped so it never grows without end. A plain script: the Experiment loads it into
   its scope, and the tests load it with node:vm. web.js keeps the lists in files in the profile. */

var WEB_HISTORY_LIMIT = 1000;

/** Pages worth remembering: web pages and files, not blank or internal ones. */
function isRecordable(url) {
  return /^(https?|file):/i.test(String(url ?? ""));
}

/** The list after a visit: the address at the top (with its title, if known), the oldest beyond the cap dropped. */
function addHistoryVisit(list, { url, title = "", time = Date.now() }, limit = WEB_HISTORY_LIMIT) {
  if (!isRecordable(url)) return list;
  const before = list.find((entry) => entry.url === url);
  const entry = { url, title: title || before?.title || "", time };
  return [entry, ...list.filter((item) => item.url !== url)].slice(0, limit);
}

/** A page's title arrives after its address: give it to the newest entry of that address. */
function setHistoryTitle(list, url, title) {
  if (!title || !list.some((entry) => entry.url === url)) return list;
  return list.map((entry) => (entry.url === url ? { ...entry, title } : entry));
}

/** Entries whose title or address contains every word of the query, newest first. */
function searchHistory(list, query, limit = 300) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? list.filter((entry) => {
    const hay = `${entry.title} ${entry.url}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  }) : list;
  return hits.slice(0, limit);
}

/** A stored list, read back: anything that is not an entry is dropped, and the cap applies. */
function parseHistory(data, limit = WEB_HISTORY_LIMIT) {
  if (!Array.isArray(data)) return [];
  const seen = new Set();
  const list = [];
  for (const item of data) {
    if (!item || !isRecordable(item.url) || seen.has(item.url)) continue;
    seen.add(item.url);
    list.push({ url: item.url, title: typeof item.title === "string" ? item.title : "", time: Number(item.time) || 0 });
  }
  return list.slice(0, limit);
}
