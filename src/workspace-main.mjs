#!/usr/bin/env node
// mail-workspace host: `serve` (default) or `install-service` (systemd user unit).
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startHost } from "./workspace/host.mjs";

const command = process.argv[2] ?? "serve";
if (command === "serve") {
  const host = await startHost({ log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => host.close().then(() => process.exit(0)));
} else if (command === "install-service") {
  const unit = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user/mail-workspace-host.service");
  await mkdir(join(unit, ".."), { recursive: true });
  await writeFile(unit, `[Unit]\nDescription=Mail Workspace host (files, viewer, artifacts)\nAfter=listener-mcp.service\n\n[Service]\nExecStart=${process.execPath} ${fileURLToPath(import.meta.url)} serve\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`);
  const run = promisify(execFile);
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "mail-workspace-host.service"]);
  await run("systemctl", ["--user", "restart", "mail-workspace-host.service"]);
  console.log(JSON.stringify({ service: "mail-workspace-host.service", unit }, null, 2));
} else {
  console.error("Usage: workspace-main.mjs [serve|install-service]");
  process.exit(2);
}
