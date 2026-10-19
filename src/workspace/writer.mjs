// Host side of the Writer space: rendering Quarto documents, reading their
// bibliographies, and grammar checking through a local LanguageTool server.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { FsError } from "./writes.mjs";

const QUARTO = process.env.QUARTO ?? "quarto";
// The supervisor review runs Claude Code headless: no tools, no MCP servers, a
// JSON schema for the answer. WRITER_REVIEW_CMD swaps the command (tests use a stub).
const REVIEW_CMD = process.env.WRITER_REVIEW_CMD ?? "claude";
const REVIEW_MODEL = process.env.WRITER_REVIEW_MODEL ?? "sonnet";
const KINDS = ["style", "error", "correction", "sense"];
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["good", "minor", "needs-work"] },
    summary: { type: "string" },
    comments: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          quote: { type: "string" },
          kind: { type: "string", enum: KINDS },
          comment: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["quote", "kind", "comment"],
      },
    },
  },
  required: ["verdict", "summary", "comments"],
};
const REVIEW_PROMPT = `You are the author's PhD supervisor, reading one passage of their scientific paper (Quarto Markdown) and leaving margin comments.

How to comment:
- Flag only real problems. If the passage is sound and well written, return verdict "good", no comments, and one short sentence saying what works.
- Judge the passage for what it is: a sentence or paragraph in a draft section. Brevity is a virtue; do not ask for detail, numbers, citations or explanations that belong elsewhere in the paper (methods, results, discussion) unless the passage makes a claim that cannot stand without them here.
- Do not comment on matters of taste, and do not invent problems so you have something to say. Most good passages get no comments.
- Write every comment about the text, never about yourself: no "I", no "I cannot", no "I have not".
- Be specific and brief: one or two sentences per comment, in a supervisor's voice (direct, constructive, no flattery).
- kind:
  "error"      plainly wrong language: grammar, spelling, agreement, punctuation;
  "correction" must change to be correct or precise: wrong term, wrong claim of fact, ambiguous reference, misused citation;
  "style"      correct but could be said better: clearer, shorter, better word or order;
  "sense"      the reasoning does not hold: a logic gap, an unsupported or contradictory claim, a sentence that does not make sense.
- quote: an exact, verbatim, minimal substring of the PASSAGE (copy characters exactly, including citations like [@key] and math like $x$). Never quote the context.
- replacement: text that replaces exactly the quote, ready to use, keeping Quarto syntax (citations [@key], cross-references @fig-x, math $...$). Omit it when the author must rethink rather than reword.
- Never rewrite the whole passage; at most 8 comments.
- Never invent citation keys, references or results. If a claim needs a source, say so in the comment and omit the replacement.
- verdict: "good" (nothing to change), "minor" (only style or small errors), "needs-work" (a correction or sense problem that matters).
- summary: one or two sentences: your overall judgement of the passage.
- Keep the author's spelling variant (British or American) as in the text.`;
const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL ?? "http://127.0.0.1:8081";
const LANGUAGETOOL_JARS = ["/usr/share/java/languagetool", "/usr/share/languagetool", "/opt/languagetool"];
const WRITABLE_DOCUMENTS = new Set([".qmd", ".md", ".markdown", ".rmd"]);

/**
 * One headless Claude Code call: no tools, no MCP servers, the answer shaped by a JSON schema.
 * WRITER_REVIEW_CMD swaps the command (tests use a stub). Resolves to { result, seconds, cost }.
 */
export async function runClaude({ prompt, schema, system, cwd = homedir(), model = REVIEW_MODEL, who = "agent", timeoutMs = 180_000 }) {
  const args = ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--model", String(model), "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--append-system-prompt", system];
  const output = await new Promise((resolveRun, reject) => {
    const child = spawn(process.env.WRITER_REVIEW_CMD ?? REVIEW_CMD, args, { cwd: existsSync(cwd) ? cwd : homedir(), env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(new FsError(503, "review_unavailable", `Could not start the ${who} (${error.message})`)); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolveRun(stdout) : reject(new FsError(502, "review_failed", (stderr || stdout).trim().slice(-400) || `The ${who} exited with ${code}`)); });
    child.stdin.end(prompt);
  });
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new FsError(502, "review_failed", `The ${who}'s answer was not JSON`); }
  if (parsed.is_error) throw new FsError(502, "review_failed", String(parsed.result ?? `The ${who} failed`).slice(0, 400));
  const result = parsed.structured_output ?? (() => { try { return JSON.parse(parsed.result); } catch { return null; } })();
  if (!result || typeof result !== "object") throw new FsError(502, "review_failed", `The ${who} gave no structured answer`);
  return { result, seconds: (parsed.duration_ms ?? 0) / 1000, cost: parsed.total_cost_usd };
}

export class Writer {
  constructor({ files, cacheDir, log = () => {}, configDir } = {}) {
    this.files = files;
    this.log = log;
    this.cacheDir = cacheDir;
    this.configDir = configDir ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "mail-workspace");
    this.renders = new Map(); // path → { running, promise, result }
    this.languagetool = null; // spawned server, if we started one
    this.starting = null;
  }

  // ---------------------------------------------------------------- render --

  /** Render a document with Quarto (one render per file at a time) and return the result. */
  async render(full, { to = "pdf" } = {}) {
    if (!WRITABLE_DOCUMENTS.has(extname(full).toLowerCase())) throw new FsError(400, "bad_request", "Only .qmd and Markdown documents render");
    if (!/^[a-z0-9+-]+$/i.test(String(to))) throw new FsError(400, "bad_request", "Unknown output format");
    await stat(full).catch(() => { throw new FsError(404, "not_found", `${full} does not exist`); });
    const current = this.renders.get(full);
    if (current?.running) return current.promise;
    const entry = { running: true, started: new Date().toISOString(), log: "" };
    entry.promise = new Promise((resolveRender) => {
      const child = spawn(QUARTO, ["render", basename(full), "--to", to], { cwd: dirname(full), env: { ...process.env, QUARTO_PRINT_STACK: "false" } });
      const take = (chunk) => { entry.log += chunk.toString(); if (entry.log.length > 400_000) entry.log = entry.log.slice(-300_000); };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
      child.on("error", (error) => { entry.log += `\n${error.message}`; });
      child.on("close", async (code) => {
        clearTimeout(timer);
        const output = /Output created:\s*(.+)/.exec(entry.log)?.[1]?.trim();
        const outputPath = output ? (isAbsolute(output) ? output : resolve(dirname(full), output)) : null;
        const result = {
          ok: code === 0 && Boolean(outputPath),
          path: full,
          to,
          output: outputPath,
          seconds: (Date.now() - Date.parse(entry.started)) / 1000,
          errors: parseErrors(entry.log),
          log: entry.log.slice(-20_000),
        };
        Object.assign(entry, { running: false, result });
        resolveRender(result);
      });
    });
    this.renders.set(full, entry);
    return entry.promise;
  }

  renderStatus(full) {
    const entry = this.renders.get(full);
    if (!entry) return { path: full, running: false, result: null };
    return { path: full, running: entry.running, started: entry.started, log: entry.running ? entry.log.slice(-4000) : undefined, result: entry.result ?? null };
  }

  // ----------------------------------------------------------- bibliography --

  /** Bibliography entries of a document (from its YAML `bibliography:`) or of a .bib file. */
  async bibliography(full) {
    const files = extname(full).toLowerCase() === ".bib" ? [full] : await bibliographyFiles(full);
    const entries = [];
    for (const file of files) {
      const source = await readFile(file, "utf8").catch(() => null);
      if (source === null) { entries.push({ file, missing: true }); continue; }
      for (const entry of parseBibtex(source)) entries.push({ ...entry, file });
    }
    return { files, entries: entries.filter((e) => !e.missing), missing: entries.filter((e) => e.missing).map((e) => e.file) };
  }

  // ---------------------------------------------------------------- grammar --

  /** Check plain text with LanguageTool. Starts a local server on first use when one is installed. */
  async grammar(text, { language = "en-US" } = {}) {
    if (typeof text !== "string") throw new FsError(400, "bad_request", "text is required");
    if (!text.trim()) return { matches: [] };
    await this.#ensureLanguageTool();
    const body = new URLSearchParams({ text, language, enabledOnly: "false" });
    const response = await fetch(`${LANGUAGETOOL_URL}/v2/check`, { method: "POST", body }).catch(() => null);
    if (!response?.ok) throw new FsError(503, "grammar_unavailable", `LanguageTool did not answer (${response?.status ?? "unreachable"})`);
    const result = await response.json();
    const words = new Set((await this.words()).map((w) => w.toLowerCase()));
    const matches = result.matches
      .map((m) => ({
        offset: m.offset,
        length: m.length,
        message: m.message,
        short: m.shortMessage || undefined,
        replacements: m.replacements.slice(0, 6).map((r) => r.value),
        rule: m.rule.id,
        category: m.rule.category?.id,
        spelling: m.rule.issueType === "misspelling",
      }))
      .filter((m) => !(m.spelling && words.has(text.slice(m.offset, m.offset + m.length).toLowerCase())));
    return { language: result.language?.code ?? language, matches };
  }

  async #ensureLanguageTool() {
    if (await reachable(`${LANGUAGETOOL_URL}/v2/languages`)) return;
    this.starting ??= (async () => {
      const jar = await findLanguageToolJar();
      if (!jar) throw new FsError(503, "grammar_unavailable", "LanguageTool is not installed. Install it with: sudo pacman -S languagetool");
      const port = new URL(LANGUAGETOOL_URL).port || "8081";
      this.log(`starting LanguageTool server on port ${port}`);
      this.languagetool = spawn("java", ["-cp", jar, "org.languagetool.server.HTTPServer", "--port", port], { stdio: "ignore" });
      this.languagetool.on("exit", () => { this.languagetool = null; });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await reachable(`${LANGUAGETOOL_URL}/v2/languages`)) return;
      }
      throw new FsError(503, "grammar_unavailable", "LanguageTool did not start within 30 seconds");
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  // ---------------------------------------------------- supervisor review --

  /**
   * Review a passage. Returns { verdict, summary, comments: [{ quote, kind,
   * comment, replacement? }] }, keeping only comments whose quote really occurs
   * in the passage.
   */
  async review({ text, before = "", after = "", heading = "", path = "", model = REVIEW_MODEL } = {}) {
    if (typeof text !== "string" || !text.trim()) throw new FsError(400, "bad_request", "Select some text to review");
    if (text.length > 20_000) throw new FsError(413, "too_large", "Select at most about three pages at a time");
    this.reviewing = (this.reviewing ?? 0) + 1;
    try {
      if (this.reviewing > 3) throw new FsError(429, "busy", "Three reviews are already running");
      const prompt = [
        path ? `Document: ${basename(path)}${heading ? `, section "${heading}"` : ""}` : "",
        before ? `CONTEXT BEFORE (do not comment on it):\n${before.slice(-1500)}` : "",
        `PASSAGE TO REVIEW:\n${text}`,
        after ? `CONTEXT AFTER (do not comment on it):\n${after.slice(0, 800)}` : "",
      ].filter(Boolean).join("\n\n");
      const { result, seconds, cost } = await runClaude({ prompt, schema: REVIEW_SCHEMA, system: REVIEW_PROMPT, cwd: path ? dirname(path) : homedir(), model, who: "reviewer" });
      if (!Array.isArray(result.comments)) throw new FsError(502, "review_failed", "The reviewer gave no structured answer");
      return normalizeReview(text, result, { model, seconds, cost });
    } finally { this.reviewing--; }
  }

  // ------------------------------------------------------- personal words --

  get wordsFile() { return join(this.configDir, "dictionary.txt"); }

  async words() {
    const text = await readFile(this.wordsFile, "utf8").catch(() => "");
    return text.split("\n").map((w) => w.trim()).filter(Boolean);
  }

  async updateWords({ add = [], remove = [] } = {}) {
    const words = new Set(await this.words());
    for (const word of [].concat(add)) if (typeof word === "string" && word.trim() && word.length < 100) words.add(word.trim());
    for (const word of [].concat(remove)) words.delete(word);
    await mkdir(this.configDir, { recursive: true });
    const list = [...words].sort((a, b) => a.localeCompare(b));
    await writeFile(this.wordsFile, list.join("\n") + "\n");
    return list;
  }

  close() { this.languagetool?.kill(); }
}

// ------------------------------------------------------------- helpers --

/** Keep comments whose quote occurs in the passage (allowing whitespace differences); order them by position. */
export function normalizeReview(text, result, meta = {}) {
  const comments = [];
  const used = [];
  for (const raw of result.comments ?? []) {
    if (!raw || typeof raw.quote !== "string" || !raw.quote.trim() || !KINDS.includes(raw.kind)) continue;
    let at = -1;
    let length = raw.quote.length;
    for (let from = 0; ; ) { // the first occurrence that does not overlap an earlier comment
      const found = text.indexOf(raw.quote, from);
      if (found < 0) break;
      if (!used.some(([s, e]) => found < e && found + length > s)) { at = found; break; }
      from = found + 1;
    }
    if (at < 0) {
      const pattern = new RegExp(raw.quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
      const m = [...text.matchAll(pattern)].find((x) => !used.some(([s, e]) => x.index < e && x.index + x[0].length > s));
      if (!m) continue;
      at = m.index;
      length = m[0].length;
    }
    used.push([at, at + length]);
    const replacement = typeof raw.replacement === "string" && raw.replacement !== text.slice(at, at + length) ? raw.replacement : undefined;
    comments.push({ start: at, end: at + length, quote: text.slice(at, at + length), kind: raw.kind, comment: String(raw.comment ?? "").trim(), ...(replacement !== undefined ? { replacement } : {}) });
  }
  comments.sort((a, b) => a.start - b.start);
  const verdict = ["good", "minor", "needs-work"].includes(result.verdict) ? result.verdict : comments.length ? "minor" : "good";
  return { verdict: comments.length ? (verdict === "good" ? "minor" : verdict) : "good", summary: String(result.summary ?? "").trim(), comments, ...meta };
}

async function reachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try { return (await fetch(url, { signal: controller.signal })).ok; } catch { return false; } finally { clearTimeout(timer); }
}

async function findLanguageToolJar() {
  for (const dir of LANGUAGETOOL_JARS) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir).catch(() => []);
    const server = names.find((n) => /^languagetool-server.*\.jar$/.test(n));
    if (server) return join(dir, server);
  }
  return null;
}

/** `bibliography:` files named in a document's YAML header, relative to the document. */
export async function bibliographyFiles(full) {
  const source = await readFile(full, "utf8").catch(() => "");
  const header = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source)?.[1] ?? "";
  const files = [];
  const inline = /^bibliography:\s*(.+)$/m.exec(header);
  if (inline && inline[1].trim() && !inline[1].trim().startsWith("|")) {
    const value = inline[1].trim();
    if (value.startsWith("[")) files.push(...value.slice(1, -1).split(",").map((v) => v.trim()));
    else files.push(value);
  } else if (inline) {
    // a YAML list on the following lines
    const after = header.slice(inline.index + inline[0].length).split("\n");
    for (const line of after) { const item = /^\s+-\s+(.+)$/.exec(line); if (!item) break; files.push(item[1].trim()); }
  }
  return files.map((f) => f.replace(/^["']|["']$/g, "")).filter(Boolean).map((f) => resolve(dirname(full), f));
}

/** A small BibTeX reader: key, type and the fields an author picks a citation by. */
export function parseBibtex(source) {
  const entries = [];
  const at = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let match;
  while ((match = at.exec(source))) {
    const type = match[1].toLowerCase();
    if (["comment", "string", "preamble"].includes(type)) continue;
    let depth = 1;
    let i = at.lastIndex;
    for (; i < source.length && depth > 0; i++) { if (source[i] === "{") depth++; else if (source[i] === "}") depth--; }
    const body = source.slice(at.lastIndex, i - 1);
    at.lastIndex = i;
    const fields = {};
    const field = /(\w+)\s*=\s*/g;
    let f;
    while ((f = field.exec(body))) {
      let j = field.lastIndex;
      let value = "";
      if (body[j] === "{") {
        let d = 1; j++;
        const start = j;
        for (; j < body.length && d > 0; j++) { if (body[j] === "{") d++; else if (body[j] === "}") d--; }
        value = body.slice(start, j - 1);
      } else if (body[j] === '"') {
        const end = body.indexOf('"', j + 1);
        value = body.slice(j + 1, end < 0 ? body.length : end);
        j = end < 0 ? body.length : end + 1;
      } else {
        const end = body.slice(j).search(/[,}\n]/);
        value = body.slice(j, end < 0 ? body.length : j + end).trim();
        j = end < 0 ? body.length : j + end;
      }
      fields[f[1].toLowerCase()] = value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      field.lastIndex = j;
    }
    entries.push({ key: match[2], type, title: fields.title ?? "", author: fields.author ?? fields.editor ?? "", year: fields.year ?? (fields.date ?? "").slice(0, 4), journal: fields.journal ?? fields.booktitle ?? "" });
  }
  return entries;
}

/** Error lines worth showing from a Quarto/pandoc/LaTeX log. */
function parseErrors(log) {
  const out = [];
  for (const line of log.split("\n")) {
    if (/^(ERROR|Error|! |\[WARNING\] Citeproc: citation .* not found|WARNING .*not found)/.test(line.trim())) out.push(line.trim());
    if (out.length >= 20) break;
  }
  return out;
}
