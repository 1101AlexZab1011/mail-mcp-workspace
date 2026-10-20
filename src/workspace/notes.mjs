// Host side of the Notes space: the vault index (page tree, links, backlinks, tags, properties, full-text
// search), page operations that keep links intact (new, rename, move), and databases (schema, rows,
// queries). The index refreshes on each request from file sizes and times, so outside edits (the agent's,
// Obsidian's, git's) are seen at once without a watcher.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  DATABASE_SUFFIX, databaseFileOf, folderOf, inlineTags, isPage, markdownLinks, newDatabase, pageText, parseDatabase,
  queryRows, renameLinks, setProperties, splitPage, titleOf, wikilinks,
} from "../notes/vault.mjs";
import { FsError } from "./writes.mjs";

const SKIP = new Set([".git", ".obsidian", ".trash", "node_modules", "attachments"]);
const MAX_PAGES = 20_000;

export class Notes {
  constructor({ files, configDir }) {
    this.files = files; // FileWriter: confined, atomic writes
    this.configFile = join(configDir, "notes.json");
    this.pages = new Map(); // path → { path, title, mtime, size, data, links, tags, headings, text }
    this.root = null;
  }

  // ----------------------------------------------------------------- vault --

  async vault() {
    if (this.root) return this.root;
    const config = JSON.parse(await readFile(this.configFile, "utf8").catch(() => "{}"));
    this.root = config.root ?? join(homedir(), "Notes");
    return this.root;
  }

  async setVault(path) {
    const full = await this.files.target(path);
    await this.files.mkdir(full).catch(() => {});
    await this.files.write(this.configFile, { text: `${JSON.stringify({ root: full }, null, 2)}\n`, createDirs: true });
    this.root = full;
    this.pages.clear();
    return { root: full };
  }

  /** Make sure the vault exists; a new one gets a welcome page. */
  async ensureVault() {
    const root = await this.vault();
    if (!(await stat(root).catch(() => null))) await this.files.mkdir(root);
    if (!(await readdir(root).catch(() => [])).length) await this.files.write(join(root, "Welcome.md"), { text: WELCOME, createDirs: true });
    return root;
  }

  async refresh() {
    const root = await this.ensureVault();
    const seen = new Set();
    const walk = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!isPage(entry.name) || seen.size >= MAX_PAGES) continue;
        seen.add(full);
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        const known = this.pages.get(full);
        if (known && known.mtime === info.mtimeMs && known.size === info.size) continue;
        const text = await readFile(full, "utf8").catch(() => "");
        this.pages.set(full, analyse(full, text, info));
      }
    };
    await walk(root);
    for (const path of this.pages.keys()) if (!seen.has(path)) this.pages.delete(path);
    return root;
  }

  /** Resolve a [[link]] target from a page: an exact path within the vault, else the nearest page with that title. */
  resolve(target, from) {
    const name = String(target).replace(/\.md$/i, "").trim().toLowerCase();
    if (!name) return null;
    if (name.includes("/")) {
      for (const page of this.pages.values()) if (relative(this.root, page.path).replace(/\.md$/i, "").toLowerCase() === name) return page.path;
    }
    const tail = name.split("/").pop();
    const candidates = [...this.pages.values()].filter((page) => page.title.toLowerCase() === tail);
    if (!candidates.length) return null;
    // Closest to the linking page first (most shared folders), then the shortest path.
    const shared = (a) => { const x = a.split("/"); const y = (from ?? "").split("/"); let n = 0; while (n < x.length && x[n] === y[n]) n++; return n; };
    candidates.sort((a, b) => shared(b.path) - shared(a.path) || a.path.length - b.path.length);
    return candidates[0].path;
  }

  // ----------------------------------------------------------------- reads --

  /** The page tree: folders and pages, folder notes merged (a page with its subpages). */
  async tree() {
    const root = await this.refresh();
    const databases = new Set();
    for (const page of this.pages.values()) if (await stat(databaseFileOf(page.path)).catch(() => null)) databases.add(page.path);
    const build = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const pages = new Map();
      const folders = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) folders.push(full);
        else if (isPage(entry.name)) pages.set(folderOf(full), full);
      }
      const nodes = [];
      for (const [key, path] of pages) {
        const page = this.pages.get(path);
        const node = { path, title: titleOf(path), icon: page?.data.icon ?? null, database: databases.has(path), children: [] };
        if (folders.includes(key)) {
          node.children = databases.has(path) ? [] : await build(key); // a database's rows show in the database, not the tree
          if (databases.has(path)) node.rows = (await readdir(key).catch(() => [])).filter(isPage).length;
        }
        nodes.push(node);
      }
      for (const folder of folders) {
        if (pages.has(folder)) continue; // a folder note
        nodes.push({ path: null, folder, title: basename(folder), children: await build(folder) });
      }
      return nodes.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    };
    return { root, pages: this.pages.size, tree: await build(root) };
  }

  /** A page with what the editor and the agent need around it. */
  async page(path) {
    await this.refresh();
    const full = await this.files.target(path);
    const page = this.pages.get(full);
    if (!page) throw new FsError(404, "not_found", `${path} is not a page in the vault`);
    const links = page.links.map((link) => ({ ...link, path: link.href ? join(dirname(full), link.href) : this.resolve(link.target, full) }));
    const database = await stat(databaseFileOf(full)).then(() => databaseFileOf(full), () => null);
    return {
      path: full, title: page.title, properties: page.data, tags: page.tags, headings: page.headings,
      links, backlinks: this.backlinks(full), database,
      parent: this.parentOf(full),
    };
  }

  parentOf(full) {
    const dir = dirname(full);
    if (dir === this.root) return null;
    const parent = `${dir}.md`;
    return this.pages.has(parent) ? parent : null;
  }

  backlinks(full) {
    const out = [];
    for (const page of this.pages.values()) {
      if (page.path === full) continue;
      const hits = page.links.filter((link) => (link.href ? join(dirname(page.path), link.href) === full : this.resolve(link.target, page.path) === full));
      if (hits.length) out.push({ path: page.path, title: page.title, context: contextOf(page.text, hits[0].start) });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Full-text search over titles, tags, properties and text; title hits rank first. */
  async search(query, { limit = 30 } = {}) {
    await this.refresh();
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const results = [];
    for (const page of this.pages.values()) {
      const title = page.title.toLowerCase();
      const haystack = `${title}\n${page.tags.join(" ")}\n${JSON.stringify(page.data)}\n${page.text}`.toLowerCase();
      if (!words.every((w) => haystack.includes(w))) continue;
      const score = words.reduce((s, w) => s + (title.includes(w) ? 10 : 0) + (title.startsWith(w) ? 5 : 0), 0) - page.path.length / 1000;
      const at = page.text.toLowerCase().indexOf(words[0]);
      results.push({ path: page.path, title: page.title, icon: page.data.icon ?? null, score, snippet: at >= 0 ? contextOf(page.text, at) : "" });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---------------------------------------------------------------- writes --

  /** A new page: in a folder (default the vault root) or under a parent page (its folder note). */
  async create({ title, parent, folder, properties, body = "", template } = {}) {
    const root = await this.ensureVault();
    const name = cleanTitle(title || "Untitled");
    let dir = root;
    if (parent) dir = folderOf(await this.files.target(parent));
    else if (folder) dir = await this.files.target(folder);
    let text = pageText({ properties, body });
    if (template) {
      const source = await readFile(await this.files.target(template), "utf8");
      const { data, body: templateBody } = splitPage(source);
      text = pageText({ properties: { ...data, ...properties }, body: `${templateBody.replace(/^\n/, "")}${body ? `\n${body}` : ""}` });
    }
    for (let n = 1; ; n++) {
      const path = join(dir, `${name}${n > 1 ? ` ${n}` : ""}.md`);
      try {
        const written = await this.files.write(path, { text, expect: "absent", createDirs: true });
        return { path: written.path, title: titleOf(written.path) };
      } catch (error) { if (error.status !== 409 || n > 200) throw error; }
    }
  }

  /** Rename a page (and its subpages folder, and its database file), updating every link to it. */
  async rename(path, title) {
    await this.refresh();
    const full = await this.files.target(path);
    const name = cleanTitle(title);
    const target = join(dirname(full), `${name}.md`);
    if (target === full) return { path: full, updated: 0 };
    const oldTitle = titleOf(full);
    await this.files.move(full, target);
    if (await stat(folderOf(full)).catch(() => null)) await this.files.move(folderOf(full), folderOf(target));
    if (await stat(databaseFileOf(full)).catch(() => null)) await this.files.move(databaseFileOf(full), databaseFileOf(target));
    let updated = 0;
    // Only pages whose links pointed at this page (by title) change.
    for (const page of [...this.pages.values()]) {
      if (!page.links.some((link) => !link.href && link.target.toLowerCase().split("/").pop() === oldTitle.toLowerCase())) continue;
      const source = page.path === full ? target : page.path.startsWith(`${folderOf(full)}/`) ? page.path.replace(folderOf(full), folderOf(target)) : page.path;
      const text = await readFile(source, "utf8").catch(() => null);
      if (text === null) continue;
      const result = renameLinks(text, oldTitle, name);
      if (result.count) { await this.files.write(source, { text: result.text }); updated += result.count; }
    }
    this.pages.clear();
    return { path: target, title: name, updated };
  }

  /** Move a page (with its subpages and database) under another page, into a folder, or to the vault root. */
  async move(path, { parent, folder } = {}) {
    const full = await this.files.target(path);
    const root = await this.vault();
    const dir = parent ? folderOf(await this.files.target(parent)) : folder ? await this.files.target(folder) : root;
    if (dir === folderOf(full) || dir.startsWith(`${folderOf(full)}/`)) throw new FsError(400, "bad_request", "A page cannot move into itself");
    await this.files.mkdir(dir).catch(() => {});
    const target = join(dir, basename(full));
    if (await stat(target).catch(() => null)) throw new FsError(409, "conflict", `${basename(full)} already exists there`);
    await this.files.move(full, target);
    if (await stat(folderOf(full)).catch(() => null)) await this.files.move(folderOf(full), folderOf(target));
    if (await stat(databaseFileOf(full)).catch(() => null)) await this.files.move(databaseFileOf(full), databaseFileOf(target));
    this.pages.clear();
    return { path: target };
  }

  /** Append Markdown to a page (a new paragraph or blocks at the end). */
  async append(path, markdown) {
    const full = await this.files.target(path);
    const text = await readFile(full, "utf8").catch(() => { throw new FsError(404, "not_found", `${path} does not exist`); });
    const joined = `${text.replace(/\s*$/, "")}${text.trim() ? "\n\n" : ""}${String(markdown).trim()}\n`;
    const written = await this.files.write(full, { text: joined });
    return { path: full, hash: written.hash };
  }

  async setProperties(path, changes) {
    const full = await this.files.target(path);
    const text = await readFile(full, "utf8").catch(() => { throw new FsError(404, "not_found", `${path} does not exist`); });
    const written = await this.files.write(full, { text: setProperties(text, changes) });
    return { path: full, hash: written.hash };
  }

  // ------------------------------------------------------------- databases --

  /** Turn a page into a database (or make a new database page). */
  async createDatabase({ path, title, parent, folder, properties } = {}) {
    const page = path ? { path: await this.files.target(path) } : await this.create({ title: title || "Untitled database", parent, folder });
    const file = databaseFileOf(page.path);
    await this.files.write(file, { text: `${JSON.stringify(newDatabase({ properties }), null, 2)}\n`, expect: "absent" });
    await this.files.mkdir(folderOf(page.path)).catch(() => {});
    return { path: page.path, database: file };
  }

  async database(path) {
    await this.refresh();
    const full = await this.files.target(path);
    const pagePath = full.endsWith(DATABASE_SUFFIX) ? `${full.slice(0, -DATABASE_SUFFIX.length)}.md` : full;
    const file = databaseFileOf(pagePath);
    const schema = parseDatabase(await readFile(file, "utf8").catch(() => { throw new FsError(404, "not_found", `${titleOf(pagePath)} is not a database`); }));
    const rowsDir = folderOf(pagePath);
    const rows = [...this.pages.values()].filter((page) => dirname(page.path) === rowsDir)
      .map((page) => ({ path: page.path, title: page.title, icon: page.data.icon ?? null, properties: page.data }));
    return { path: pagePath, file, schema, rows };
  }

  async query(path, { filter = [], sort = [], view } = {}) {
    const db = await this.database(path);
    const chosen = view ? db.schema.views.find((v) => v.name === view) : null;
    return { ...db, rows: queryRows(db.rows, { filter: [...(chosen?.filter ?? []), ...filter], sort: sort.length ? sort : chosen?.sort ?? [] }) };
  }

  async saveSchema(path, schema) {
    const db = await this.database(path);
    parseDatabase(JSON.stringify(schema));
    await this.files.write(db.file, { text: `${JSON.stringify(schema, null, 2)}\n` });
    return { path: db.path };
  }

  async addRow(path, { title, properties = {}, body = "" } = {}) {
    const db = await this.database(path);
    await this.files.mkdir(folderOf(db.path)).catch(() => {});
    return this.create({ title: title || "Untitled", folder: folderOf(db.path), properties, body });
  }
}

// ---------------------------------------------------------------- helpers --

function analyse(path, text, info) {
  const { data, body } = splitPage(text);
  const links = [...wikilinks(body).map((l) => ({ target: l.target, heading: l.heading, embed: l.embed, start: l.start })), ...markdownLinks(body).map((l) => ({ href: l.href, start: l.start }))];
  const tags = [...new Set([...(Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : []).map(String), ...inlineTags(body)])];
  const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2].trim() }));
  return { path, title: titleOf(path), mtime: info.mtimeMs, size: info.size, data, links, tags, headings, text: body };
}

function contextOf(text, at) {
  const start = Math.max(0, text.lastIndexOf("\n", at - 1) + 1);
  const end = text.indexOf("\n", at);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 200);
}

const cleanTitle = (title) => String(title).replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";

const WELCOME = `---
icon: 👋
---

Pages are Markdown files in this folder. Type **/** for blocks, drag the **⋮⋮** handle to move them, and
type **\\[\\[** to link another page.

- [ ] Make a page
- [ ] Link it from here
- [ ] Create a database (type /database)

> [!tip] The agent can read and write these notes too.
`;
