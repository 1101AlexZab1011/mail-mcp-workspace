import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The watcher publishes with its own listener-mcp credential, scoped to
// publish:mail/replies/**, so it can announce replies but not speak in the chat.
export const DEFAULT_BROKER_URL = "http://127.0.0.1:47800";
export const DEFAULT_CREDENTIAL = "mail-watcher";

export function credentialPath(name, env = process.env) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`Invalid credential name ${JSON.stringify(name)}`);
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "listener-mcp", "credentials", `${name}.token`);
}

export async function brokerToken(env = process.env) {
  if (env.MAIL_WATCHER_TOKEN) return env.MAIL_WATCHER_TOKEN;
  const name = env.MAIL_WATCHER_CREDENTIAL ?? DEFAULT_CREDENTIAL;
  try { return (await readFile(credentialPath(name, env), "utf8")).trim(); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`No listener-mcp credential "${name}". Create it with: listener-mcp token create --name ${name} --scopes 'publish:mail/replies/**' --save`);
    throw error;
  }
}

export async function publish({ channel, type, data }, { env = process.env, fetchImpl = fetch } = {}) {
  const url = env.MAIL_WATCHER_BROKER_URL ?? DEFAULT_BROKER_URL;
  const response = await fetchImpl(`${url}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await brokerToken(env)}` },
    body: JSON.stringify({ channel, type, data }),
  });
  if (!response.ok) throw new Error(`Broker refused the event (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}
