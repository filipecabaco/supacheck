// Evaluate an artifact on the real-code gold set (data/gold/manifest.jsonl).
// Files are fetched at their pinned commit into a git-ignored cache; only URLs + labels are committed.
//
//   pnpm tsx src/eval-gold.ts <artifact dir> [--verbose]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { chunksFor, withFacts, type Chunk } from './chunks.js'
import { buildFacts, type Facts } from './facts.js'
import { buildTsFacts, factsFor, type TsFacts } from './tsfacts.js'
import { policyAuthenticated, singleVerdict, sqlFactLines, suppressedBy, tsRuleVerdict, userMetadataSql, userMetadataTs } from './checks.js'
import { applicable, loadRules } from './rules.js'
import { loadModel, score } from './runtime.js'

type Entry = { url: string; line: number; rule: string; label: 0 | 1; note: string; kind?: Chunk['kind'] }

const root = resolve(import.meta.dirname, '../..')
const artifact = process.argv[2]
const verbose = process.argv.includes('--verbose')
// Repo-level split so tuning never sees the repos it's scored on: ~40% calibration, ~60% held-out test.
const tune = process.argv.includes('--tune')
// --facts-engine: TS rules with a deterministic check are decided by it (p = 0/1) instead of the model
const factsEngine = process.argv.includes('--facts-engine')
const repoOf = (url: string) => url.split('/').slice(3, 5).join('/')
// repos added for calibration only (never part of the original test pool) always go to the calibration side
const calibOnly = new Set(readFileSync(join(root, 'data/gold/review.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).filter((r) => r.source === 'v6-calibration').map((r) => repoOf(r.url)))
const isCalib = (url: string) => { if (calibOnly.has(repoOf(url))) return true; let h = 0; for (const c of repoOf(url)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 5 < 2 }
const useFacts = !process.argv.includes('--no-facts') && !!process.env.CORPUS
const sqlF = new Map<string, Facts>(), tsF = new Map<string, TsFacts>()

/** Facts-engine verdict as 0/1, or undefined to fall back to the model. */
async function factsDecision(rule: string, chunk: Chunk, facts: string[], url: string): Promise<number | undefined> {
  const code = chunk.state.split('\n---\n').slice(1).join('\n---\n')
  const bool = (v: { flagged: boolean } | undefined, fallbackNo = true) => (v ? (v.flagged ? 1 : 0) : fallbackNo ? 0 : undefined)
  if (['admin-client-for-user-scoped-work', 'server-trusts-getsession', 'ef-service-role-trusts-body-identity'].includes(rule))
    return bool(tsRuleVerdict(rule, chunk.state, facts, chunk.kind))
  if (rule === 'user-metadata-for-authorization') return bool(chunk.file.endsWith('.sql') ? userMetadataSql(code) : userMetadataTs(code))
  if (rule === 'single-where-maybe-single') return bool(singleVerdict(chunk.state), false)
  if (rule === 'policy-authenticated-not-authorized' && chunk.file.endsWith('.sql')) {
    const m = /github\.com\/([^/]+)\/([^/]+)\//.exec(url)
    const dir = m && [process.env.CORPUS, process.env.CORPUS2].filter(Boolean).map((c) => join(c!, `${m[1]}__${m[2]}`)).find((d) => existsSync(d))
    const f = dir ? sqlF.get(dir) : undefined
    const pol = f?.policies.find((x) => x.file === chunk.file && x.line === chunk.line)
    return pol ? bool(policyAuthenticated(pol, f!)?.owner) : undefined
  }
  return undefined
}

/** Repo-wide facts for the chunk when a local clone (same commit) exists in $CORPUS. */
async function chunkFacts(url: string, chunk: Chunk): Promise<string[]> {
  const m = /github\.com\/([^/]+)\/([^/]+)\/blob\/[0-9a-f]+\/(.+)$/.exec(url)
  const dir = m && [process.env.CORPUS, process.env.CORPUS2].filter(Boolean).map((c) => join(c!, `${m[1]}__${m[2]}`)).find((d) => existsSync(d))
  if (!dir) return []
  if (chunk.file.endsWith('.sql')) {
    if (!sqlF.has(dir)) sqlF.set(dir, await buildFacts(dir))
    return sqlFactLines(sqlF.get(dir)!, chunk.file, chunk.line)
  }
  if (!tsF.has(dir)) tsF.set(dir, buildTsFacts(dir))
  return factsFor(tsF.get(dir)!, chunk.file, chunk.state)
}
const entries: Entry[] = readFileSync(join(root, 'data/gold/manifest.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))

const model = await loadModel(artifact)
const rules = loadRules(join(root, 'rules'))
const cacheDir = join(root, 'data/gold/cache')
mkdirSync(cacheDir, { recursive: true })

const results = []
for (const e of entries) {
  const { raw, repoPath } = rawUrl(e.url)
  const local = join(cacheDir, createHash('sha1').update(raw).digest('hex').slice(0, 12) + '-' + repoPath.split('/').pop())
  if (!existsSync(local)) {
    const res = await fetch(raw)
    if (!res.ok) { results.push({ ...e, status: `fetch ${res.status}` }); continue }
    writeFileSync(local, await res.text())
  }
  const source = readFileSync(local, 'utf8')
  const lineText = source.split('\n')[e.line - 1]?.trim() ?? ''
  const chunks = await chunksFor(local, { displayPath: repoPath, kind: e.kind })
  const chunk = chunks.find((c) => lineText && c.state.includes(lineText)) ?? (chunks.length === 1 ? chunks[0] : undefined)
  const rule = rules.find((r) => r.id === e.rule)!
  if (!chunk) { results.push({ ...e, status: 'no chunk covers line' }); continue }
  if (!applicable(rule, chunk)) { results.push({ ...e, status: `not asked (kind=${chunk.kind})` }); continue }
  const facts = useFacts ? await chunkFacts(e.url, chunk) : []
  chunk.state = withFacts(chunk.state, facts)
  const suppressed = useFacts ? suppressedBy(e.rule, chunk.state, facts) : undefined
  const decided = factsEngine ? await factsDecision(e.rule, chunk, facts, e.url) : undefined
  const p = decided !== undefined ? decided : suppressed ? 0 : (await score(model, chunk.state))[e.rule]
  const thr = model.meta.thresholds[e.rule] ?? 0.5
  results.push({ ...e, status: 'scored', p, predicted: p >= thr ? 1 : 0, thr, state: chunk.state })
}

let scored = results.filter((r: any) => r.status === 'scored') as any[]
if (tune) {
  // Per rule: lowest threshold reaching precision >= 0.9 on the calibration repos (else 0.5), applied to test repos.
  const calib = scored.filter((r) => isCalib(r.url))
  const thr: Record<string, number> = {}
  for (const rule of new Set(scored.map((r) => r.rule))) {
    const rs = calib.filter((r) => r.rule === rule).sort((a, b) => b.p - a.p)
    let tp = 0, fp = 0, best: number | undefined
    for (const r of rs) { r.label ? tp++ : fp++; if (tp && tp / (tp + fp) >= 0.9) best = r.p }
    thr[rule] = best !== undefined ? Math.max(best, 0.05) : 0.5
  }
  console.log('tuned thresholds (calibration repos):', Object.fromEntries(Object.entries(thr).map(([k, v]) => [k, +v.toFixed(3)])))
  scored = scored.filter((r) => !isCalib(r.url)).map((r) => ({ ...r, predicted: r.p >= thr[r.rule] ? 1 : 0 }))
  console.log(`held-out test repos: ${new Set(scored.map((r) => repoOf(r.url))).size}, items: ${scored.length}`)
}
// Same chunk texts for the Python-side typed baselines (Laya, Clef): cache only, never committed.
writeFileSync(join(cacheDir, 'states.jsonl'), scored.map((r) => JSON.stringify({ rule: r.rule, label: r.label, url: r.url, state: r.state })).join('\n') + '\n')
const tp = scored.filter((r) => r.label === 1 && r.predicted === 1).length
const fp = scored.filter((r) => r.label === 0 && r.predicted === 1).length
const fn = scored.filter((r) => r.label === 1 && r.predicted === 0).length
const tn = scored.filter((r) => r.label === 0 && r.predicted === 0).length
for (const r of results as any[]) {
  const mark = r.status !== 'scored' ? '·' : r.predicted === r.label ? '✓' : '✗'
  const repo = r.url.split('/').slice(3, 5).join('/')
  console.log(`${mark} ${r.rule.padEnd(38)} label=${r.label} ${r.status === 'scored' ? `p=${r.p.toFixed(3)} thr=${(r.thr ?? 0.5).toFixed(2)}` : r.status}  ${repo}${verbose ? `  — ${r.note}` : ''}`)
}
// AUROC: chance that a random positive outranks a random negative (threshold-free).
const pos = scored.filter((r) => r.label === 1).map((r) => r.p)
const neg = scored.filter((r) => r.label === 0).map((r) => r.p)
const pairs: number[] = pos.flatMap((a) => neg.map((b): number => (a > b ? 1 : a === b ? 0.5 : 0)))
const auroc = pairs.length ? (pairs.reduce((x, y) => x + y, 0) / pairs.length).toFixed(3) : '-'
console.log(`\nscored ${scored.length}/${results.length}  auroc=${auroc}  tp=${tp} fp=${fp} fn=${fn} tn=${tn}  precision=${tp + fp ? (tp / (tp + fp)).toFixed(2) : '-'} recall=${tp + fn ? (tp / (tp + fn)).toFixed(2) : '-'}`)

function rawUrl(url: string) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]+)\/(.+)$/.exec(url)
  if (!m) throw new Error(`unsupported url ${url}`)
  const [, owner, repo, sha, path] = m
  return { raw: `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`, repoPath: decodeURIComponent(path) }
}
