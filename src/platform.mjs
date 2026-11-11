// What differs between Linux, macOS and Windows, in one place: where the app
// keeps its files, how programs are found and started, which shell runs
// commands, how a file opens on the desktop, and how paths travel to the add-on.
//
// Linux keeps the XDG folders it always used. macOS and Windows get their own
// conventions (Application Support, AppData), as listener-mcp does.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { commandLine, whichWindows } from "listener-mcp/command";

export const OS = platform();
export const isWindows = OS === "win32";
export const isMac = OS === "darwin";
const run = promisify(execFile);

/** The folders an app keeps its settings (config), its records (state) and throwaway files (cache) in. */
export function appDirs(name, env = process.env) {
  const home = homedir();
  if (isWindows) {
    const roaming = join(env.APPDATA ?? join(home, "AppData", "Roaming"), name);
    return { config: roaming, state: roaming, cache: join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), name, "Cache") };
  }
  if (isMac) {
    const support = join(home, "Library", "Application Support", name);
    return { config: support, state: support, cache: join(home, "Library", "Caches", name) };
  }
  return {
    config: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), name),
    state: join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), name),
    cache: join(env.XDG_CACHE_HOME ?? join(home, ".cache"), name),
  };
}

/** email-mcp keeps its accounts in ~/.config/email-mcp on every system (it only knows XDG). */
export const emailMcpDir = (env = process.env) => join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "email-mcp");

// ---- programs --------------------------------------------------------------

const programFiles = (env, ...rest) => [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")].filter(Boolean).map((base) => join(base, ...rest));

/** Where the optional programs install themselves when they are not on PATH (app bundles, Program Files). */
const KNOWN = {
  inkscape: (env) => (isMac ? ["/Applications/Inkscape.app/Contents/MacOS/inkscape"] : isWindows ? programFiles(env, "Inkscape", "bin", "inkscape.exe") : []),
  soffice: (env) => (isMac ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"] : isWindows ? programFiles(env, "LibreOffice", "program", "soffice.exe") : []),
  quarto: (env) => (isMac ? ["/Applications/quarto/bin/quarto"] : isWindows ? programFiles(env, "Quarto", "bin", "quarto.exe") : []),
  java: (env) => (isWindows && env.JAVA_HOME ? [join(env.JAVA_HOME, "bin", "java.exe")] : env.JAVA_HOME ? [join(env.JAVA_HOME, "bin", "java")] : []),
};

function onPath(name, env) {
  if (isWindows) return whichWindows(name, env);
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

/**
 * The program to run for `name`: an override from `envVar`, then PATH, then where it installs
 * itself. Falls back to the bare name, so a missing program fails with ENOENT as before.
 */
export function program(name, envVar, env = process.env) {
  if (envVar && env[envVar]) return env[envVar];
  if (!isWindows && !isMac) return name; // Linux: PATH, as it always was
  return onPath(name, env) ?? KNOWN[name]?.(env).find((path) => existsSync(path)) ?? name;
}

/** The script an npm .cmd shim runs ("%dp0%\\node_modules\\…\\cli.js" %*), or null. */
export function npmShimTarget(file) {
  try {
    const target = /"%~?dp0%?\\([^"]+\.[cm]?js)"\s+%\*/i.exec(readFileSync(file, "utf8"))?.[1];
    return target ? join(dirname(file), target) : null;
  } catch { return null; }
}

/**
 * spawn() that also starts Windows .cmd shims (npm-installed CLIs such as claude). An npm shim's
 * script runs on this node directly: through cmd.exe, arguments could not hold line breaks.
 */
export function spawnProgram(name, args, options = {}) {
  const env = options.env ?? process.env;
  if (isWindows) {
    const file = whichWindows(name, env);
    const script = file && /\.cmd$/i.test(file) ? npmShimTarget(file) : null;
    if (script) return spawn(process.execPath, [script, ...args], { windowsHide: true, ...options });
  }
  const line = commandLine(name, args, env);
  return spawn(line.file, line.args, { windowsHide: true, ...options, ...line.options });
}

/** End a child and everything it started (on Windows a .cmd shim's node, a shell's commands). */
export function killTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (isWindows) execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
  else child.kill(signal);
}

// ---- shells ----------------------------------------------------------------

/** PowerShell 7 when installed, else the Windows PowerShell every Windows has. */
const powershell = (env = process.env) => (onPath("pwsh", env) ? "pwsh.exe" : "powershell.exe");

/** The shell the Terminal opens. */
export function terminalShell(env = process.env) {
  if (env.MAIL_WORKSPACE_SHELL) return env.MAIL_WORKSPACE_SHELL;
  if (isWindows) return powershell(env);
  return env.SHELL ?? (isMac ? "/bin/zsh" : "/bin/bash");
}

/**
 * How an artifact's command runs: bash where there is one, PowerShell on Windows
 * (MAIL_WORKSPACE_EXEC_SHELL=bash picks Git Bash there).
 * @returns {{ shell: "bash" | "powershell", file: string, args: string[] }}
 */
export function commandShell(command, env = process.env) {
  const choice = env.MAIL_WORKSPACE_EXEC_SHELL ?? (isWindows ? "powershell" : "bash");
  if (choice === "powershell") {
    return { shell: "powershell", file: powershell(env), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")] };
  }
  return { shell: "bash", file: "bash", args: ["-lc", command] };
}

/** An interactive shell reading commands from a pipe (an artifact's shell session). */
export function sessionShell(env = process.env) {
  const choice = env.MAIL_WORKSPACE_EXEC_SHELL ?? (isWindows ? "powershell" : "bash");
  if (choice === "powershell") return { shell: "powershell", file: powershell(env), args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"], env: {} };
  return { shell: "bash", file: "bash", args: ["--norc", "--noprofile", "--noediting", "-i"], env: { PS1: "\\w $ ", TERM: "dumb" } };
}

// ---- the desktop -----------------------------------------------------------

/** Open a file or folder in its default application. */
export function openOnDesktop(full) {
  const [file, args] = isWindows ? ["explorer.exe", [full]] : isMac ? ["open", [full]] : ["xdg-open", [full]];
  spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** Font families installed on this machine. */
export async function fontFamilies() {
  const families = new Set();
  if (isWindows) {
    // Names of installed fonts, machine-wide and per user: "Segoe UI Bold (TrueType)" → "Segoe UI".
    for (const key of ["HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts", "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"]) {
      const { stdout } = await run("reg", ["query", key], { maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
      for (const line of stdout.split(/\r?\n/)) {
        const name = /^\s{4}(.+?)\s{4}REG_/.exec(line)?.[1];
        if (!name) continue;
        for (const part of name.replace(/\s*\((TrueType|OpenType|All res|VGA res|8514\/a res)\)$/i, "").split(" & ")) {
          const family = part.replace(/\s+(Regular|Bold|Italic|Oblique|Light|Medium|Semibold|SemiBold|Semilight|SemiLight|Black|Heavy|Thin|ExtraLight|ExtraBold|Condensed|Narrow)(\s+(Bold|Italic|Oblique|Condensed))*$/i, "").trim();
          if (family) families.add(family);
        }
      }
    }
  } else if (isMac && !onPath("fc-list", process.env)) {
    const { stdout } = await run("system_profiler", ["SPFontsDataType", "-json"], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }).catch(() => ({ stdout: "{}" }));
    try {
      for (const font of JSON.parse(stdout).SPFontsDataType ?? []) for (const face of font.typefaces ?? []) if (face.family) families.add(face.family);
    } catch { /* no list */ }
  } else {
    const { stdout } = await run("fc-list", [":", "family"], { maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
    for (const line of stdout.split("\n")) families.add(line.split(",")[0].trim());
  }
  return [...families].filter((family) => family && !family.startsWith("."));
}

// ---- paths on the wire -----------------------------------------------------

const WINDOWS_PATH = /^[A-Za-z]:\\/;
const TEXT_KEYS = new Set(["text", "content", "data", "source", "svg", "stdout", "stderr", "log", "markdown", "html"]);

/**
 * Paths as the add-on handles them: with "/" on every system (C:/Users/…), which
 * Windows accepts too. Values under text keys (file contents) are left alone.
 */
export function wirePaths(value, windows = isWindows) {
  return windows ? toWire(value, "") : value;
}

function toWire(value, key) {
  if (TEXT_KEYS.has(key)) return value;
  if (typeof value === "string") return value.length < 4096 && WINDOWS_PATH.test(value) && !value.includes("\n") ? value[0].toUpperCase() + value.slice(1).replace(/\\/g, "/") : value;
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((item) => toWire(item, ""));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = toWire(v, k);
  return out;
}
