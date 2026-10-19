// One-off tool for the English translation of the fork.
//   node scripts/i18n-extract.mjs            → scripts/i18n/strings.json (unique CJK runs, with a sample location)
//   node scripts/i18n-extract.mjs --apply    → replaces every run found in scripts/i18n/en.json
// A "run" is the CJK-bearing text between code delimiters (quotes, tags, mustaches), comments excluded.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = new URL('../src/', import.meta.url).pathname
const OUT = new URL('./i18n/', import.meta.url).pathname
const CJK = /[　-〿一-鿿＀-￯]/
const RUN = /[^'"`<>{}\n]*[一-鿿　-〿＀-￯][^'"`<>{}\n]*/g
const SKIP = new Set(['configs/font.ts']) // font-family names, replaced by the system font list

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* files(full)
    else if (['.vue', '.ts'].includes(extname(name))) yield full
  }
}

// Blank out comments but keep offsets, so runs map back to the original text.
function maskComments(text) {
  const out = text.split('')
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ' }
  let i = 0
  let quote = null
  let inStyle = false
  while (i < text.length) {
    if (!quote && text.startsWith('<style', i)) inStyle = true
    if (inStyle && text.startsWith('</style>', i)) inStyle = false
    const c = text[i]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote || (c === '\n' && quote !== '`')) quote = null
      i++
      continue
    }
    if (text.startsWith('<!--', i)) { const end = text.indexOf('-->', i); blank(i, end < 0 ? text.length : end + 3); i = end < 0 ? text.length : end + 3; continue }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i); blank(i, end < 0 ? text.length : end + 2); i = end < 0 ? text.length : end + 2; continue }
    if (text.startsWith('//', i) && text[i - 1] !== ':') { const end = text.indexOf('\n', i); blank(i, end < 0 ? text.length : end); i = end < 0 ? text.length : end; continue }
    // Quotes only open strings in script code; in templates an apostrophe in text is just text.
    if ((c === '\'' || c === '"' || c === '`') && !inStyle) quote = c
    i++
  }
  return out.join('')
}

function runsOf(text) {
  const masked = maskComments(text)
  const runs = []
  for (const match of masked.matchAll(RUN)) {
    const raw = match[0]
    const start = match.index + raw.length - raw.trimStart().length
    const value = raw.trim()
    if (value && CJK.test(value)) runs.push({ start, end: start + value.length, value })
  }
  return runs
}

const apply = process.argv.includes('--apply')
const table = apply ? JSON.parse(readFileSync(join(OUT, 'en.json'), 'utf8')) : null
const found = new Map()
let missing = 0
for (const file of files(ROOT)) {
  const rel = file.slice(ROOT.length)
  if (SKIP.has(rel)) continue
  const text = readFileSync(file, 'utf8')
  const runs = runsOf(text)
  if (!runs.length) continue
  if (!apply) {
    for (const run of runs) if (!found.has(run.value)) found.set(run.value, `${rel}:${text.slice(0, run.start).split('\n').length}`)
    continue
  }
  let result = ''
  let at = 0
  for (const run of runs) {
    const english = table[run.value]
    if (english == null) { missing++; continue }
    result += text.slice(at, run.start) + english
    at = run.end
  }
  result += text.slice(at)
  if (result !== text) writeFileSync(file, result)
}
if (!apply) {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'strings.json'), JSON.stringify(Object.fromEntries(found), null, 1))
  console.log(`${found.size} unique runs`)
} else console.log(`applied; ${missing} runs without a translation`)
