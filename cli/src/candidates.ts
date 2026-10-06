// Calibration candidates from corpus repos the model never trained on, pre-scored by the model.
// Appends pending rows to data/gold/review.jsonl (existing reviewed rows are kept).
//   CORPUS2=<dir> pnpm tsx src/candidates.ts <artifact dir> [--per-rule 25]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { chunksFor, withFacts } from './chunks.js'
import { buildFacts } from './facts.js'
import { buildTsFacts, factsFor } from './tsfacts.js'
import { sqlFactLines, suppressedBy } from './checks.js'
import { applicable, loadRules } from './rules.js'
import { loadModel, score } from './runtime.js'
import { walk } from './check.js'

const root = resolve(import.meta.dirname, '../..')
const corpus2 = process.env.CORPUS2!
const perRule = Number(process.argv[process.argv.indexOf('--per-rule') + 1] || 25)
const model = await loadModel(process.argv[2])
const rules = loadRules(join(root, 'rules')).filter((r) => (r as any).engine !== 'facts')

// repos that contributed training rows (mutations) are excluded: calibrate on unseen code only
const trained = new Set(readFileSync(join(root, 'data/generated/mutations.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).resource))
const manifest = new Map(readFileSync(join(corpus2, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.repo.replace('/', '__'), m]))
const repos = readdirSync(corpus2).filter((d) => manifest.has(d) && !trained.has(d))
console.error(`${repos.length} untrained repos`)

const pool: any[] = []
for (const name of repos) {
  const dir = join(corpus2, name)
  const { repo, sha } = manifest.get(name)
  const sql = await buildFacts(dir)
  const ts = buildTsFacts(dir)
  for (const file of walk(dir)) {
    const rel = relative(dir, file)
    for (const chunk of await chunksFor(file, { displayPath: rel })) {
      const asked = rules.filter((r) => applicable(r, chunk))
      if (!asked.length || chunk.state.length > 20000) continue
      const facts = rel.endsWith('.sql') ? sqlFactLines(sql, rel, chunk.line) : factsFor(ts, rel, chunk.state)
      const state = withFacts(chunk.state, facts)
      const probs = await score(model, state)
      for (const r of asked) {
        if (suppressedBy(r.id, state, facts)) continue
        pool.push({ url: `https://github.com/${repo}/blob/${sha}/${rel}`, line: chunk.line, rule: r.id, kind: chunk.kind, repo, teacher_p: probs[r.id], label: null, reviewer: null, note: '', source: 'v6-calibration' })
      }
    }
  }
}

// per rule: spread across score range (top / bottom / middle), at most 3 per repo
const picked: any[] = []
for (const r of rules) {
  const rs = pool.filter((x) => x.rule === r.id).sort((a, b) => b.teacher_p - a.teacher_p)
  const perRepo = new Map<string, number>()
  const take = (xs: any[], n: number) => {
    for (const x of xs) {
      if (n <= 0) break
      if ((perRepo.get(x.repo) ?? 0) >= 3 || picked.includes(x)) continue
      perRepo.set(x.repo, (perRepo.get(x.repo) ?? 0) + 1); picked.push(x); n--
    }
  }
  const third = Math.ceil(perRule / 3)
  take(rs, third); take([...rs].reverse(), third)
  take([...rs].sort((a, b) => Math.abs(a.teacher_p - 0.5) - Math.abs(b.teacher_p - 0.5)), perRule - 2 * third)
}

const reviewPath = join(root, 'data/gold/review.jsonl')
const existing = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8').split('\n').filter(Boolean) : []
const seen = new Set(existing.map((l) => { const j = JSON.parse(l); return `${j.url}#${j.line}#${j.rule}` }))
const fresh = picked.filter((x) => !seen.has(`${x.url}#${x.line}#${x.rule}`)).map((x) => JSON.stringify(x))
writeFileSync(reviewPath, existing.concat(fresh).join('\n') + '\n')
const by: Record<string, number> = {}
for (const x of picked) by[x.rule] = (by[x.rule] ?? 0) + 1
console.log(`pool ${pool.length} → appended ${fresh.length} candidates`, by)
