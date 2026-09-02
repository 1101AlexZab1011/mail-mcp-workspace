import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const emptyState = () => ({ version: 1, records: {}, actions: [], routing: {} });

export async function readState(path) {
  try { return { ...emptyState(), ...JSON.parse(await readFile(path, "utf8")) }; }
  catch (error) { if (error.code === "ENOENT") return emptyState(); throw error; }
}

export async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function recordKey(account, messageId) { return `${account}:${messageId}`; }
