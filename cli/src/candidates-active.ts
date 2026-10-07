// Active-learning candidates: score a corpus with a committee of models, then queue for review the chunks
// that teach the most (committee unsure or split) plus likely positives for rules that have few.
//   CORPUS=<dir> pnpm tsx src/candidates-active.ts score --model <dir> [--model <dir> ...] [--max-chunks-per-repo 40]
//   pnpm tsx src/candidates-active.ts select [--total 300] [--per-repo 3]
// score appends to artifacts/active/pool.jsonl per repo (resumable); select appends pending rows to
// data/gold/review.jsonl with source "active-1", which keeps the repo-hash calibration/test split.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chunksFor, withFacts } from './chunks.js'
import { buildFacts } from './facts.js'
import { buildTsFacts, factsFor } from './tsfacts.js'
import { sqlFactLines, suppressedBy } from './checks.js'
import { applicable, loadRules } from './rules.js'
import { loadScorer, type Scorer } from './scorer.js'
import { walk } from './check.js'

const root = resolve(import.meta.dirname, '../..')
const rulesDir = join(root, 'rules')
const poolPath = join(root, 'artifacts/active/pool.jsonl')
const reviewPath = join(root, 'data/gold/review.jsonl')
// repos without a permissive licence: gold labels only, never training rows (mutate.ts, frozen_baseline.exs skip them)
const evalOnlyPath = join(root, 'data/gold/eval-only-repos.txt')
const SOURCE = 'active-1'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', multiple: true },
    'max-chunks-per-repo': { type: 'string', default: '40' },
    total: { type: 'string', default: '300' },
    'per-repo': { type: 'string', default: '3' },
  },
})
const readJsonl = (path: string): any[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

if (positionals[0] === 'score') await scorePool()
else if (positionals[0] === 'select') select()
else { console.error('usage: candidates-active.ts score --model <dir>... | select [--total N]'); process.exitCode = 2 }

async function scorePool() {
  const corpus = process.env.CORPUS
  if (!corpus || !values.model?.length) throw new Error('need CORPUS=<dir> and at least one --model <dir>')
  const committee: [string, Scorer][] = []
  for (const dir of values.model) committee.push([basename(resolve(dir)), await loadScorer(resolve(dir), rulesDir)])
  const rules = loadRules(rulesDir).filter((r) => (r as any).engine !== 'facts' && committee.some(([, s]) => s.rules.includes(r.id)))
  const maxChunks = Number(values['max-chunks-per-repo'])

  // trained-on repos (mutations) and gold repos already reviewed teach nothing new
  const trained = new Set(readJsonl(join(root, 'data/generated/mutations.jsonl')).map((m) => m.resource))
  const reviewedRepos = new Set(readJsonl(reviewPath).map((r) => String(r.url).split('/').slice(3, 5).join('__')))
  const manifest = new Map(readJsonl(join(corpus, 'manifest.jsonl')).map((m) => [m.repo.replace('/', '__'), m]))
  mkdirSync(join(root, 'artifacts/active'), { recursive: true })
  const done = new Set(readJsonl(poolPath).map((p) => p.repo))
  const repos = readdirSync(corpus).filter((d) => manifest.has(d) && !trained.has(d) && !reviewedRepos.has(d) && !done.has(manifest.get(d).repo))
  console.error(`${repos.length} repos to score (${done.size} already in pool), committee: ${committee.map(([n]) => n).join(', ')}`)

  for (const [i, name] of repos.entries()) {
    const dir = join(corpus, name)
    const { repo, sha, eval_only } = manifest.get(name)
    const sql = await buildFacts(dir)
    const ts = buildTsFacts(dir)
    const jobs: { rel: string; line: number; kind: string; state: string; open: string[] }[] = []
    for (const file of walk(dir)) {
      const rel = relative(dir, file)
      for (const chunk of await chunksFor(file, { displayPath: rel })) {
        if (chunk.state.length > 20000) continue
        const asked = rules.filter((r) => applicable(r, chunk))
        if (!asked.length) continue
        const facts = rel.endsWith('.sql') ? sqlFactLines(sql, rel, chunk.line) : factsFor(ts, rel, chunk.state)
        const state = withFacts(chunk.state, facts)
        const open = asked.filter((r) => !suppressedBy(r.id, state, facts)).map((r) => r.id)
        if (open.length) jobs.push({ rel, line: chunk.line, kind: chunk.kind, state, open })
      }
    }
    // bounded cost per repo: a random sample keeps big repos from dominating the pool
    const sample = jobs.sort(() => Math.random() - 0.5).slice(0, maxChunks)
    const rows: string[] = []
    for (const job of sample) {
      const scores: Record<string, Record<string, number>> = {}
      for (const [n, s] of committee) {
        const mine = job.open.filter((r) => s.rules.includes(r))
        if (mine.length) scores[n] = (await s.scoreBatch([job.state], mine))[0]
      }
      for (const rule of job.open) {
        const committeeP = Object.fromEntries(Object.entries(scores).filter(([, p]) => rule in p).map(([n, p]) => [n, Math.round(p[rule] * 1000) / 1000]))
        rows.push(JSON.stringify({ url: `https://github.com/${repo}/blob/${sha}/${job.rel}`, line: job.line, rule, kind: job.kind, repo, committee: committeeP, ...(eval_only ? { eval_only: true } : {}) }))
      }
    }
    if (rows.length) appendFileSync(poolPath, rows.join('\n') + '\n')
    console.error(`[${i + 1}/${repos.length}] ${repo}: ${sample.length}/${jobs.length} chunks, ${rows.length} rows`)
  }
}

function select() {
  const total = Number(values.total)
  const perRepoCap = Number(values['per-repo'])
  const review = readJsonl(reviewPath)
  const seen = new Set(review.map((r) => `${r.url}#${r.line}#${r.rule}`))
  const pool = readJsonl(poolPath).filter((p) => !seen.has(`${p.url}#${p.line}#${p.rule}`)).map((p) => {
    const ps = Object.values(p.committee as Record<string, number>)
    const mean = ps.reduce((a, b) => a + b, 0) / ps.length
    // unsure (mean near 0.5) plus split (members far apart): both are where a label moves the models most
    const spread = ps.length > 1 ? Math.max(...ps) - Math.min(...ps) : 0
    return { ...p, teacher_p: Math.round(mean * 1000) / 1000, gain: 1 - Math.abs(2 * mean - 1) + spread }
  })

  // budget leans to rules with few labelled positives: those are the thresholds we can't set yet
  const positives: Record<string, number> = {}
  for (const r of review) if (r.label === 1) positives[r.rule] = (positives[r.rule] ?? 0) + 1
  const ruleIds: string[] = [...new Set(pool.map((p) => p.rule as string))]
  const weight: Record<string, number> = Object.fromEntries(ruleIds.map((r) => [r, 1 / (1 + (positives[r] ?? 0))]))
  const weightSum = Object.values(weight).reduce((a, b) => a + b, 0)

  const picked: any[] = []
  const perRepo = new Map<string, number>()
  for (const rule of ruleIds) {
    const n = Math.max(10, Math.round((total * weight[rule]) / weightSum))
    const rs = pool.filter((p) => p.rule === rule)
    const take = (xs: any[], k: number) => {
      for (const x of xs) {
        if (k <= 0) break
        const key = `${x.rule}#${x.repo}`
        if ((perRepo.get(key) ?? 0) >= perRepoCap || picked.includes(x)) continue
        perRepo.set(key, (perRepo.get(key) ?? 0) + 1); picked.push(x); k--
      }
    }
    const likely = Math.ceil(n / 3)
    take([...rs].sort((a, b) => b.teacher_p - a.teacher_p), likely)
    take([...rs].sort((a, b) => b.gain - a.gain), n - likely)
  }

  const rows = picked.map(({ gain, ...x }) => JSON.stringify({ ...x, label: null, reviewer: null, note: '', source: SOURCE }))
  // append only: existing reviewed rows stay byte-for-byte as they are
  const text = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : ''
  if (rows.length) appendFileSync(reviewPath, (text && !text.endsWith('\n') ? '\n' : '') + rows.join('\n') + '\n')
  const known = new Set(existsSync(evalOnlyPath) ? readFileSync(evalOnlyPath, 'utf8').split('\n').filter(Boolean) : [])
  const evalOnly = [...new Set(picked.filter((x) => x.eval_only).map((x) => x.repo as string))].filter((r) => !known.has(r))
  if (evalOnly.length) appendFileSync(evalOnlyPath, evalOnly.join('\n') + '\n')
  const by: Record<string, number> = {}
  for (const x of picked) by[x.rule] = (by[x.rule] ?? 0) + 1
  console.log(`pool ${pool.length} unreviewed → queued ${picked.length} for review`, by)
}
