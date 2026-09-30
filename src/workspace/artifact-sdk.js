// The `workspace` module artifacts import for capabilities beyond the page:
//
//   import { exec, shell, fetchLocal, readFile, writeFile, listDir } from "workspace";
//
// The artifact runs in a sandboxed frame without network access; every call
// goes to the Artifacts space by postMessage, which checks the grants the user
// approved for this artifact and forwards it to the workspace host.
let next = 0;
const pending = new Map();
const streams = new Map();

addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message?.source !== "mw-host") return;
  if (message.type === "result") {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), message.error));
    else waiter.resolve(message.value);
  } else if (message.type === "stream") {
    streams.get(message.session)?.(message.chunk);
  }
});

function call(method, args) {
  const id = ++next;
  parent.postMessage({ source: "mw-artifact", type: "call", id, method, args }, "*");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Run a command once (needs an `exec` grant). Resolves { code, stdout, stderr }. */
export const exec = (command, { cwd, stdin, timeout, env } = {}) => call("exec", { command, cwd, stdin, timeout, env });

/**
 * A persistent shell session (needs an `exec` grant). `onOutput` receives
 * { stream: "stdout" | "stderr" | "exit", data } chunks as they arrive.
 */
export async function shell({ cwd, onOutput } = {}) {
  const { session } = await call("shell.open", { cwd });
  if (onOutput) streams.set(session, onOutput);
  return {
    id: session,
    write: (data) => call("shell.write", { session, data }),
    interrupt: () => call("shell.signal", { session, signal: "SIGINT" }),
    close: () => { streams.delete(session); return call("shell.close", { session }); },
  };
}

/** HTTP to an origin the `fetch` grant lists. Resolves { status, headers, body }. */
export const fetchLocal = (url, { method = "GET", headers, body } = {}) => call("fetch", { url, method, headers, body });

/** Files under the paths the `fs` grant lists. */
export const readFile = (path) => call("fs.read", { path });
export const writeFile = (path, content) => call("fs.write", { path, content });
export const listDir = (path) => call("fs.list", { path });

/** Ask the agent something from inside the artifact (sent into the chat). */
export const askAgent = (text) => call("agent.ask", { text });
