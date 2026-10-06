// Send answered gold items back for review when repo facts could change the answer:
// TS items whose chunk uses a helper/config we can now describe, SQL items where the
// fact-based check disagrees with the label. Keeps the old answer as prev_label.
//   CORPUS=<clones dir> pnpm tsx src/mark-rereview.ts [--dry-run]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fetchChunk } from './gold.js'
import { buildFacts, type Facts } from './facts.js'
import { buildTsFacts, factsFor, type TsFacts } from './tsfacts.js'
import { definerNoCallerCheck, selectTrueOnPrivate } from './checks.js'

const root = resolve(import.meta.dirname, '../..')
const corpus = process.env.CORPUS!
const dry = process.argv.includes('--dry-run')
const reviewPath = join(root, 'data/gold/review.jsonl')
const manifestPath = join(root, 'data/gold/manifest.jsonl')
const rows = readFileSync(reviewPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const ts = new Map<string, TsFacts>(), sql = new Map<string, Facts>()
const marked: any[] = []

for (const row of rows) {
  if (row.label === null) continue
  // never overwrite human labels; .single() judgements don't depend on repo facts
  if (row.reviewer !== 'claude-review-agent' || row.rule === 'single-where-maybe-single') continue
  const m = /github\.com\/([^/]+)\/([^/]+)\/blob\/[0-9a-f]+\/(.+)$/.exec(row.url)!
  const dir = join(corpus, `${m[1]}__${m[2]}`)
  const file = decodeURIComponent(m[3])
  if (!existsSync(dir)) continue
  let reason: string | undefined
  if (file.endsWith('.sql')) {
    if (!sql.has(dir)) sql.set(dir, await buildFacts(dir))
    const f = sql.get(dir)!
    const fn = f.history.find((x) => x.file === file && x.line === row.line)
    const p = f.policies.find((x) => x.file === file && x.line === row.line)
    const v = row.rule === 'definer-function-no-caller-check' && fn ? definerNoCallerCheck(fn, f)
      : row.rule === 'select-true-on-private-data' && p ? selectTrueOnPrivate(p, f) : undefined
    if (v && Number(v.flagged) !== row.label) reason = `fact check says ${v.flagged ? 'yes' : 'no'}: ${v.because.join(' · ')}`
  } else {
    if (!ts.has(dir)) ts.set(dir, buildTsFacts(dir))
    const chunk = await fetchChunk(row.url, row.line, join(root, 'data/gold/cache'))
    const facts = chunk ? factsFor(ts.get(dir)!, file, chunk) : []
    if (facts.length) reason = facts.join(' · ')
  }
  if (!reason) continue
  marked.push({ rule: row.rule, prev: row.label, url: row.url, line: row.line, reason })
  if (dry) continue
  Object.assign(row, { prev_label: row.label, prev_note: row.note, label: null, note: '', reviewer: null })
}

if (!dry) {
  writeFileSync(reviewPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  // match url + line + rule exactly: a file can hold several reviewed items (and original gold rows)
  const keys = new Set(marked.map((x) => `${x.url}#${x.line}#${x.rule}`))
  const kept = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).filter((l) => { const g = JSON.parse(l); return !keys.has(`${g.url}#${g.line}#${g.rule}`) })
  writeFileSync(manifestPath, kept.join('\n') + '\n')
}
const by: Record<string, number> = {}
for (const x of marked) by[x.rule] = (by[x.rule] ?? 0) + 1
console.log(`${dry ? '[dry run] ' : ''}${marked.length} items to re-review`, by)
for (const x of marked.slice(0, 6)) console.log(`  ${x.rule} prev=${x.prev}  ${x.reason.slice(0, 160)}`)
