import { readFile, copyFile, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";

export const defaultEmailConfigPath = resolve(homedir(), ".config/email-mcp/config.toml");
export const defaultPolicyPath = resolve(homedir(), ".config/mail-mcp-workspace/policy.toml");
export const defaultStatePath = resolve(homedir(), ".local/state/mail-mcp-workspace/state.json");
export const examplePolicyPath = new URL("../config/policy.example.toml", import.meta.url);

export async function loadEmailConfig(path = process.env.MAIL_WORKFLOW_EMAIL_CONFIG ?? defaultEmailConfigPath) {
  const raw = parse(await readFile(path, "utf8"));
  return new Map((raw.accounts ?? []).map((account) => [account.name, account]));
}

export async function loadPolicy(path = process.env.MAIL_WORKFLOW_POLICY ?? defaultPolicyPath) {
  try { return parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { accounts: {} }; throw error; }
}

export function accountPolicy(policy, account) {
  return {
    routing_mode: "provider",
    filing_mode: "review",
    approved_folders: [],
    subject_rules: [],
    ...policy.defaults,
    ...(policy.accounts?.[account] ?? {}),
  };
}

export async function initPolicy(target = process.env.MAIL_WORKFLOW_POLICY ?? defaultPolicyPath) {
  try { await access(target); throw new Error(`Policy already exists: ${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(examplePolicyPath, target);
  return target;
}
