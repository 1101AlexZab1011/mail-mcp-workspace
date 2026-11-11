// File paths as the pages handle them. "/" separates folders on every system: the
// host sends Windows paths as C:/Users/…, and Windows accepts them back. Paths an
// agent or the user types on Windows may still use "\", so everything here takes both.

export const toSlash = (path) => String(path ?? "").replace(/\\/g, "/");

/** "/", "C:/" or "//server/share/": the part of an absolute path no folder can go above. */
export const rootOf = (path) => /^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+\/|\/)/.exec(toSlash(path))?.[0] ?? "";

export const isAbsolutePath = (path) => rootOf(path) !== "";

/** The last part: a file's name, a folder's name. */
export const nameOf = (path) => toSlash(path).replace(/(.)\/+$/, "$1").split("/").pop();

/** The folder a path is in; a root stays itself. */
export function dirOf(path) {
  const slashed = toSlash(path);
  const root = rootOf(slashed);
  const rest = slashed.slice(root.length);
  return root + (rest.includes("/") ? rest.replace(/\/[^/]*$/, "") : "") || (root ? root : slashed);
}

/** `ref` against folder `dir`, unless it is absolute or ~-relative already. */
export const resolvePath = (dir, ref) => (isAbsolutePath(ref) || /^~(\/|\\|$)/.test(ref) ? ref : `${dir.replace(/\/+$/, "")}/${String(ref).replace(/^\.[\\/]/, "")}`);

/** The home folder shown as ~ (Linux /home/name, macOS /Users/name, Windows C:/Users/name). */
export const tildePath = (path) => toSlash(path).replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/i, "~");

const WINDOWS = /^Win/i.test(globalThis.navigator?.platform ?? "");

/** Why `name` cannot name a file or folder here, or "" when it can. */
export function badName(name, windows = WINDOWS) {
  if (name.includes("/")) return "cannot contain /";
  if (windows && /[\\:*?"<>|]/.test(name)) return 'cannot contain \\ : * ? " < > |';
  if (windows && /[. ]$/.test(name)) return "cannot end with a dot or a space";
  return "";
}
