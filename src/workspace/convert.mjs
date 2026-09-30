// Office documents → PDF through LibreOffice, headless. Results are cached by
// path, size and mtime, conversions run one at a time, and LibreOffice gets a
// private profile so it never collides with a LibreOffice the user has open.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
let queue = Promise.resolve();

export function soffice() {
  return process.env.MAIL_WORKSPACE_SOFFICE ?? "soffice";
}

export async function toPdf(path, cacheDir) {
  const info = await stat(path);
  const key = createHash("sha256").update(`${path}\0${info.size}\0${info.mtimeMs}`).digest("hex").slice(0, 32);
  const target = join(cacheDir, `${key}.pdf`);
  try { await access(target); return target; } catch { /* not cached */ }
  const job = queue.then(async () => {
    try { await access(target); return target; } catch { /* still missing */ }
    const work = join(cacheDir, `work-${key}`);
    await mkdir(work, { recursive: true, mode: 0o700 });
    try {
      await run(soffice(), [
        `-env:UserInstallation=file://${join(cacheDir, "lo-profile")}`,
        "--headless", "--norestore", "--nologo", "--convert-to", "pdf", "--outdir", work, path,
      ], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
      const produced = (await readdir(work)).find((name) => name.toLowerCase().endsWith(".pdf"));
      if (!produced) throw new Error(`LibreOffice produced no PDF for ${basename(path)}`);
      await rename(join(work, produced), target);
      return target;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => {});
  return job;
}

export const convertible = new Set(["doc", "docx", "odt", "rtf", "fodt", "wpd", "pages", "ppt", "pptx", "odp", "fodp", "key", "pps", "ppsx"]);
export const needsConversion = (path) => convertible.has(extname(path).slice(1).toLowerCase());
