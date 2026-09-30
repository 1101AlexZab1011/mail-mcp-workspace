// Syntax highlighting with Shiki (VS Code grammars): the host renders HTML
// with both a light and a dark theme, and the viewer picks one by CSS.
import { basename, extname } from "node:path";
import { bundledLanguagesInfo, createHighlighter } from "shiki";

const byExtension = new Map();
const byName = new Map([
  ["dockerfile", "docker"], ["containerfile", "docker"], ["makefile", "make"], ["gnumakefile", "make"], ["cmakelists.txt", "cmake"],
  ["justfile", "just"], ["gemfile", "ruby"], ["rakefile", "ruby"], ["vagrantfile", "ruby"], ["pkgbuild", "shellscript"],
  [".bashrc", "shellscript"], [".zshrc", "shellscript"], [".profile", "shellscript"], [".bash_profile", "shellscript"],
  [".gitignore", "ini"], [".gitconfig", "ini"], [".editorconfig", "ini"], [".env", "dotenv"], ["go.mod", "go"],
  ["cargo.lock", "toml"], ["package-lock.json", "json"], ["tsconfig.json", "jsonc"], [".prettierrc", "json"], [".eslintrc", "json"],
]);
// Extensions Shiki's language ids and aliases don't cover directly.
const extra = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  py: "python", pyw: "python", pyi: "python", rb: "ruby", rs: "rust", kt: "kotlin", kts: "kotlin", cs: "csharp", fs: "fsharp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish", ps1: "powershell", psm1: "powershell", bat: "bat", cmd: "bat",
  yml: "yaml", h: "c", hpp: "cpp", hh: "cpp", cc: "cpp", cxx: "cpp", m: "objective-c", mm: "objective-cpp", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", ml: "ocaml", mli: "ocaml", pl: "perl", pm: "perl", r: "r", jl: "julia", tf: "terraform", hcl: "hcl",
  htm: "html", xhtml: "html", xsl: "xml", xsd: "xml", plist: "xml", csproj: "xml", vue: "vue", svelte: "svelte", astro: "astro",
  scss: "scss", sass: "sass", less: "less", styl: "stylus", sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
  toml: "toml", ini: "ini", cfg: "ini", conf: "ini", properties: "properties", json5: "json5", jsonc: "jsonc", jsonl: "json",
  ipynb: "json", tex: "latex", sty: "latex", bib: "bibtex", dart: "dart", lua: "lua", nim: "nim", zig: "zig", v: "v", sol: "solidity",
  swift: "swift", scala: "scala", sc: "scala", groovy: "groovy", gradle: "groovy", clj: "clojure", cljs: "clojure", elm: "elm",
  purs: "purescript", nix: "nix", diff: "diff", patch: "diff", mk: "make", cmake: "cmake", vim: "viml", asm: "asm", s: "asm",
  wgsl: "wgsl", glsl: "glsl", hlsl: "hlsl", prisma: "prisma", d: "d", pas: "pascal", f90: "fortran-free-form", cob: "cobol",
  ada: "ada", adb: "ada", vb: "vb", fsx: "fsharp", rkt: "racket", scm: "scheme", lisp: "common-lisp", el: "emacs-lisp", coffee: "coffee",
  pug: "pug", haml: "haml", hbs: "handlebars", liquid: "liquid", j2: "jinja", jinja: "jinja", twig: "twig", erb: "erb",
  csv: null, tsv: null, txt: null, log: null, md: null, svg: null,
};
for (const info of bundledLanguagesInfo) {
  for (const name of [info.id, ...(info.aliases ?? [])]) if (!byExtension.has(name)) byExtension.set(name, info.id);
}
for (const [ext, lang] of Object.entries(extra)) byExtension.set(ext, lang);

export function languageOf(path) {
  const name = basename(path).toLowerCase();
  if (byName.has(name)) return byName.get(name);
  const ext = extname(name).slice(1);
  if (!ext) return null;
  return byExtension.get(ext) ?? null;
}

let highlighter = null;
const loaded = new Set();

export async function highlight(code, lang) {
  highlighter ??= await createHighlighter({ themes: ["github-light-default", "github-dark-default"], langs: [] });
  let language = lang && bundledLanguagesInfo.some((info) => info.id === lang) ? lang : "text";
  if (language !== "text" && !loaded.has(language)) {
    try { await highlighter.loadLanguage(language); loaded.add(language); } catch { language = "text"; }
  }
  return highlighter.codeToHtml(code, {
    lang: language,
    themes: { light: "github-light-default", dark: "github-dark-default" },
    defaultColor: false,
  });
}
