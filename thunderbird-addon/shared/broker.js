// The add-on's connection to the local listener-mcp broker, shared by the
// background script and every page. One token (paired once, bound to this
// add-on's origin) is used for the broker and for the workspace host, which
// verifies it against the broker.
export const DEFAULT_ENDPOINT = "http://127.0.0.1:47800";
export const HOST_ENDPOINT = "http://127.0.0.1:47810";
// What the add-on needs: chat, the GUI command channel, workspace files,
// artifacts, grants, and blobs. Tokens paired before these existed are replaced.
export const REQUIRED_SCOPES = ["publish:mail/**", "read:mail/**", "subscribe:mail/gui/**", "blobs"];
export const PAIR_COMMAND = (origin) => `listener-mcp pair --name thunderbird --origin ${origin} --scopes '${REQUIRED_SCOPES.join(",")}'`;

let settings = null;

async function stored() {
  try {
    const value = await browser.storage.local.get({ listenerEndpoint: DEFAULT_ENDPOINT, listenerToken: "", listenerScopesOk: false });
    return { endpoint: value.listenerEndpoint, token: value.listenerToken, scopesOk: value.listenerScopesOk };
  } catch { return { endpoint: DEFAULT_ENDPOINT, token: "", scopesOk: false }; }
}

export async function forgetToken() {
  settings = { endpoint: settings?.endpoint ?? DEFAULT_ENDPOINT, token: "" };
  await browser.storage.local.set({ listenerToken: "", listenerScopesOk: false }).catch(() => {});
}

async function pair(endpoint) {
  // POST: Thunderbird omits Origin on extension GETs, and pairing is bound to it.
  const response = await fetch(`${endpoint}/v1/pair`, { method: "POST" }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json()).token;
}

/** Make sure a token with the required scopes is stored; pairs if needed. */
export async function ensurePaired() {
  if (settings?.token && settings.scopesOk) return settings;
  settings = await stored();
  if (settings.token && !settings.scopesOk) {
    const who = await fetch(`${settings.endpoint}/v1/whoami`, { headers: { authorization: `Bearer ${settings.token}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (who && REQUIRED_SCOPES.every((scope) => who.scopes.includes(scope) || who.scopes.includes("admin"))) {
      settings.scopesOk = true;
      await browser.storage.local.set({ listenerScopesOk: true }).catch(() => {});
    } else if (who) {
      await forgetToken();
    }
  }
  if (!settings.token) {
    const token = await pair(settings.endpoint);
    if (token) {
      settings = { endpoint: settings.endpoint, token, scopesOk: true };
      await browser.storage.local.set({ listenerEndpoint: settings.endpoint, listenerToken: token, listenerScopesOk: true }).catch(() => {});
    }
  }
  if (!settings.token) throw new Error(`Not paired · run: ${PAIR_COMMAND(location.origin)}`);
  return settings;
}

export async function token() { return (await ensurePaired()).token; }

async function call(base, path, init = {}) {
  const current = await ensurePaired();
  const headers = { authorization: `Bearer ${current.token}`, ...(init.body && !(init.body instanceof Blob) && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) };
  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (response.status === 401) { await forgetToken(); throw new Error("Pairing expired · retrying"); }
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = text; }
  if (!response.ok) {
    const error = new Error(value?.error?.message ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.code = value?.error?.code;
    error.details = value?.error;
    throw error;
  }
  return value;
}

/** listener-mcp broker API. */
export const broker = (path, init) => ensurePaired().then((s) => call(s.endpoint, path, init));
/** Workspace host API (files, viewer conversions, artifacts). */
export const host = (path, init) => call(HOST_ENDPOINT, path, init);

export const json = (value) => ({ method: "POST", body: JSON.stringify(value) });
