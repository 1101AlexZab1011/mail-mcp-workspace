/* What the Browser's address bar makes of typed text: an address to load, or words to search for.
   A plain script: the Experiment loads it into its scope, and the tests load it with node:vm. */

var URL_SCHEMES = /^(https?|ftp|file|about|data|view-source|moz-extension):/i;
var LOCAL_HOSTS = /^(localhost|127(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i;

/**
 * "elster.de" → { url: "https://elster.de/" }; "steuer id beantragen" → { search: "steuer id beantragen" }.
 * Something that looks like a host (a dot, no spaces, a known-looking end) is an address; anything else
 * is searched for. A leading "?" forces a search, as in Firefox.
 */
function parseAddress(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  if (text.startsWith("?")) return { search: text.slice(1).trim() };
  if (URL_SCHEMES.test(text)) return { url: text };
  if (/\s/.test(text)) return { search: text };
  if (LOCAL_HOSTS.test(text)) return { url: `http://${text}` };
  // host[:port][/path…] with a dot in the host and a letter-only last label (or an IPv4 address).
  const m = /^([^/?#:]+)(:\d+)?([/?#].*)?$/.exec(text);
  if (m) {
    const host = m[1];
    const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    const named = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,63}$/u.test(host);
    if (ipv4 || named) return { url: `https://${text}` };
  }
  return { search: text };
}
