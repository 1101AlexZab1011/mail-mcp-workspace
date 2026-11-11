#!/usr/bin/env node
// mail-workspace: `serve` runs the host (the default); `install`, `uninstall` and
// `status` manage the background services (systemd, launchd or a Windows logon task).
//
//   install [--watch <account> [--every <seconds>]]   the host, and the mail watcher for one account
//   uninstall                                         both
//   status
import { parseArgs } from "node:util";
import { hostService, watcherService } from "./services.mjs";

const [command = "serve", ...rest] = process.argv.slice(2);
const print = (value) => console.log(JSON.stringify(value, null, 2));

if (command === "serve") {
  const { startHost } = await import("./workspace/host.mjs");
  const host = await startHost({ log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => host.close().then(() => process.exit(0)));
} else if (command === "install" || command === "install-service") {
  const { values } = parseArgs({ args: rest, options: { watch: { type: "string" }, every: { type: "string", default: "60" } } });
  const result = { host: await hostService().install() };
  if (values.watch) {
    const seconds = Number(values.every);
    if (!Number.isFinite(seconds) || seconds < 30) throw new Error("--every is at least 30 seconds");
    const { loadEmailConfig } = await import("./config.mjs");
    if (!(await loadEmailConfig()).has(values.watch)) throw new Error(`Unknown account: ${values.watch}`);
    result.watcher = await watcherService(values.watch, seconds).install();
  }
  print(result);
} else if (command === "uninstall") {
  print({ host: await hostService().uninstall(), watcher: await watcherService().uninstall() });
} else if (command === "status") {
  print({ host: await hostService().status(), watcher: await watcherService().status() });
} else {
  console.error("Usage: workspace-main.mjs [serve | install [--watch <account> [--every <seconds>]] | uninstall | status]");
  process.exit(2);
}
