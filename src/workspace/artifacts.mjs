// Artifacts: small React apps kept as plain folders under ~/Artifacts.
//
//   ~/Artifacts/<folders…>/<artifact>/
//       artifact.json   { title, description, entry, created, updated, tags, capabilities }
//       App.tsx         default-exported React component (entry)
//       …               any other modules, styles, assets it imports
//
// A folder without artifact.json is a container. The host bundles an artifact
// with esbuild (React, Recharts, lucide-react and the workspace SDK resolve
// from this project), and serves it to a sandboxed frame.
import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOT = join(homedir(), "Artifacts");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const META = "artifact.json";
const TEXT_LIMIT = 512 * 1024;

export class ArtifactStore {
  constructor(root = DEFAULT_ROOT) {
    this.root = resolve(root);
    this.trash = join(this.root, ".trash");
  }

  /** A path inside the store, from a store-relative path; refuses escapes. */
  resolve(rel = "") {
    const full = resolve(this.root, String(rel).replace(/^\/+/, ""));
    if (full !== this.root && !full.startsWith(this.root + sep)) throw Object.assign(new Error("Path escapes the artifacts folder"), { status: 400 });
    if (full === this.trash || full.startsWith(this.trash + sep)) throw Object.assign(new Error("The trash is not addressable"), { status: 400 });
    return full;
  }

  rel(full) { return relative(this.root, full).split(sep).join("/"); }

  async isArtifact(full) {
    try { await stat(join(full, META)); return true; } catch { return false; }
  }

  async meta(full) {
    return JSON.parse(await readFile(join(full, META), "utf8"));
  }

  async tree() {
    await mkdir(this.root, { recursive: true });
    const walk = async (full) => {
      const node = { name: basename(full), path: this.rel(full), type: "folder", children: [] };
      if (full === this.root) node.name = "Artifacts";
      const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const child = join(full, entry.name);
        if (await this.isArtifact(child)) {
          const meta = await this.meta(child).catch(() => ({}));
          node.children.push({ name: entry.name, path: this.rel(child), type: "artifact", title: meta.title ?? entry.name, description: meta.description ?? "", updated: meta.updated ?? null, tags: meta.tags ?? [], capabilities: meta.capabilities ?? null });
        } else {
          node.children.push(await walk(child));
        }
      }
      node.children.sort((a, b) => (a.type === b.type ? (a.title ?? a.name).localeCompare(b.title ?? b.name, undefined, { numeric: true }) : a.type === "folder" ? -1 : 1));
      return node;
    };
    return walk(this.root);
  }

  async read(rel) {
    const full = this.resolve(rel);
    if (!(await this.isArtifact(full))) throw Object.assign(new Error(`${rel} is not an artifact`), { status: 404 });
    const meta = await this.meta(full);
    const files = {};
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const child = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(child); continue; }
        const info = await stat(child);
        const name = relative(full, child).split(sep).join("/");
        if (name === META) continue;
        files[name] = info.size <= TEXT_LIMIT && /\.(tsx?|jsx?|mjs|css|json|md|txt|html|svg|csv)$/i.test(name) ? await readFile(child, "utf8") : { binary: true, size: info.size };
      }
    };
    await walk(full);
    return { path: this.rel(full), meta, files };
  }

  static slug(title) {
    return String(title).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "artifact";
  }

  async #writeFiles(full, files = {}, removed = []) {
    for (const [name, content] of Object.entries(files)) {
      const target = resolve(full, name);
      if (!target.startsWith(full + sep) || basename(target) === META) throw Object.assign(new Error(`Bad file name ${name}`), { status: 400 });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    for (const name of removed) {
      const target = resolve(full, name);
      if (target.startsWith(full + sep)) await rm(target, { force: true });
    }
  }

  /** Create an artifact in `folder` (store-relative). Returns its path. */
  async create({ folder = "", name, title, description = "", files, entry = "App.tsx", tags = [], capabilities = null }) {
    if (!title) throw Object.assign(new Error("title is required"), { status: 400 });
    if (!files || !Object.keys(files).length) throw Object.assign(new Error("files is required"), { status: 400 });
    const parent = this.resolve(folder);
    if (await this.isArtifact(parent)) throw Object.assign(new Error(`${folder} is an artifact, not a folder`), { status: 400 });
    await mkdir(parent, { recursive: true });
    const base = ArtifactStore.slug(name ?? title);
    let full = join(parent, base);
    for (let n = 2; await stat(full).then(() => true, () => false); n++) full = join(parent, `${base}-${n}`);
    await mkdir(full, { recursive: true });
    const now = new Date().toISOString();
    await this.#writeFiles(full, files);
    await writeFile(join(full, META), `${JSON.stringify({ title, description, entry, tags, capabilities, created: now, updated: now }, null, 2)}\n`);
    return { path: this.rel(full) };
  }

  async update(rel, { title, description, files, remove = [], entry, tags, capabilities }) {
    const full = this.resolve(rel);
    const meta = await this.meta(full);
    await this.#writeFiles(full, files ?? {}, remove);
    const next = { ...meta, updated: new Date().toISOString() };
    if (title !== undefined) next.title = title;
    if (description !== undefined) next.description = description;
    if (entry !== undefined) next.entry = entry;
    if (tags !== undefined) next.tags = tags;
    if (capabilities !== undefined) next.capabilities = capabilities;
    await writeFile(join(full, META), `${JSON.stringify(next, null, 2)}\n`);
    return { path: this.rel(full) };
  }

  async mkdir(rel) {
    const full = this.resolve(rel);
    await mkdir(full, { recursive: true });
    return { path: this.rel(full) };
  }

  /** Move or rename an artifact or folder: `to` is the new store-relative path. */
  async move(rel, to) {
    const from = this.resolve(rel);
    const target = this.resolve(to);
    if (from === this.root) throw Object.assign(new Error("Cannot move the root"), { status: 400 });
    if (target.startsWith(from + sep)) throw Object.assign(new Error("Cannot move a folder into itself"), { status: 400 });
    if (await stat(target).then(() => true, () => false)) throw Object.assign(new Error(`${to} already exists`), { status: 409 });
    await mkdir(dirname(target), { recursive: true });
    await rename(from, target).catch(async (error) => {
      if (error.code !== "EXDEV") throw error;
      await cp(from, target, { recursive: true });
      await rm(from, { recursive: true, force: true });
    });
    return { path: this.rel(target) };
  }

  /** Delete to ~/Artifacts/.trash, never permanently. */
  async remove(rel) {
    const from = this.resolve(rel);
    if (from === this.root) throw Object.assign(new Error("Cannot delete the root"), { status: 400 });
    await mkdir(this.trash, { recursive: true });
    const target = join(this.trash, `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(from)}`);
    await rename(from, target);
    return { trashed: this.rel(target) };
  }

  /** Bundle an artifact into one browser script. */
  async bundle(rel) {
    const full = this.resolve(rel);
    const meta = await this.meta(full);
    const entry = resolve(full, meta.entry ?? "App.tsx");
    const result = await build({
      stdin: {
        contents: [
          `import App from ${JSON.stringify(entry)};`,
          `import { mount } from "workspace:runtime";`,
          `mount(App);`,
        ].join("\n"),
        resolveDir: full,
        loader: "tsx",
        sourcefile: "entry.tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      minify: false,
      sourcemap: "inline",
      logLevel: "silent",
      nodePaths: [join(projectRoot, "node_modules")],
      alias: {
        "workspace:runtime": join(projectRoot, "src/workspace/artifact-runtime.jsx"),
        workspace: join(projectRoot, "src/workspace/artifact-sdk.js"),
      },
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl", ".svg": "text", ".csv": "text", ".md": "text", ".txt": "text" },
    }).catch((error) => {
      const message = (error.errors ?? []).map((e) => `${e.location ? `${relative(full, e.location.file)}:${e.location.line}:${e.location.column}: ` : ""}${e.text}`).join("\n") || error.message;
      throw Object.assign(new Error(message), { status: 422, code: "build_failed" });
    });
    return { code: result.outputFiles[0].text, meta };
  }
}
