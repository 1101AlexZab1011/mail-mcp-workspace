#!/usr/bin/env node
// loom MCP server: Loom for agents. Plans (create, read, move steps, attach branches), the state of a
// project's repository, and the git actions of Loom's graph. It needs only the workspace host and a
// listener-mcp credential with Loom's scopes (default "loom-agent"), not Thunderbird: Loom's screen,
// when open, follows what the agent does.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListenerClient } from "listener-mcp/client";
import { loomTools } from "./loom-tools.mjs";
import { wirePaths } from "./platform.mjs";

const HOST = process.env.MAIL_WORKSPACE_HOST ?? "http://127.0.0.1:47810";
const CREDENTIAL = process.env.LOOM_CREDENTIAL ?? "loom-agent";
let client = null;
const connect = async () => (client ??= await ListenerClient.fromEnvironment({ credential: CREDENTIAL }));

async function call(method, path, body) {
  const c = await connect();
  const response = await fetch(`${HOST}${path}`, {
    method,
    headers: { authorization: `Bearer ${c.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(wirePaths(body)) : undefined,
  }).catch(() => { throw new Error(`The workspace host is not running at ${HOST} (npm run services:install starts it)`); });
  const value = await response.json().catch(() => null);
  if (response.status === 403) throw new Error(`${value?.error?.message ?? "Forbidden"}. The "${CREDENTIAL}" credential needs Loom's scopes: see the README's Loom section.`);
  if (!response.ok) throw new Error(value?.error?.message ?? `Workspace host answered ${response.status}`);
  return value;
}

const server = new McpServer({ name: "loom", version: "1.0.0" });
const tools = loomTools({ call, cwd: process.cwd(), who: () => process.env.LOOM_AGENT || null });
for (const [name, { description, input, readOnly, run }] of Object.entries(tools)) {
  server.registerTool(name, { description, inputSchema: input, annotations: readOnly ? { readOnlyHint: true } : {} }, async (params) => {
    try {
      const value = await run(params);
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });
}
await server.connect(new StdioServerTransport());
