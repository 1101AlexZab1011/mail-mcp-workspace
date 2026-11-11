// The app's background services, set up as per-user services that start at
// login: the workspace host (files, editors and terminals for the add-on) and,
// optionally, the mail watcher (routing and reply notifications for one account).
// listener-mcp/service picks systemd, launchd or a Windows logon task.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userService } from "listener-mcp/service";
import { appDirs } from "./platform.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const logs = appDirs("mail-workspace").state;

export const hostService = () => userService({
  name: "mail-workspace-host",
  label: "dev.mail-workspace.host",
  description: "Mail Workspace host (files, viewer, artifacts)",
  command: [process.execPath, join(here, "workspace-main.mjs"), "serve"],
  after: "listener-mcp.service",
  log: join(logs, "host.log"),
});

export const watcherService = (account = "", seconds = 60) => userService({
  name: "mail-mcp-workflow-watcher",
  label: "dev.mail-workspace.watcher",
  description: "Mail MCP workflow watcher",
  command: [process.execPath, join(here, "main.mjs"), "watch", account, String(seconds), "--apply"],
  cwd: resolve(here, ".."),
  restartSec: 15,
  log: join(logs, "watcher.log"),
});
