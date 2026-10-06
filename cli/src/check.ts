// Core check: facts-engine rules always run; model rules only when a model is supplied.
// Shared by the CLI (text/json/sarif) and the MCP server.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { chunksFor, withFacts } from './chunks.js'
import { buildFacts, type Facts } from './facts.js'
import { buildTsFacts, factsFor } from './tsfacts.js'
import { alwaysTrueWrite, definerNoCallerCheck, firstSignupAdmin, rlsDisabled, serviceRolePolicyWithoutTo, grantWriteWithoutRls, missingGrants, policyAuthenticated, selectTrueOnPrivate, singleVerdict, sqlFactLines, suppressedBy, tsExtraVerdicts, tsRuleVerdict, userMetadataSql, userMetadataTs } from './checks.js'
import { applicable, loadRules, type Rule } from './rules.js'

export type Finding = {
  rule_id: string; engine: 'facts' | 'model'; severity: string; file: string; line: number
  message: string; fix: string; avoid: string[]; docs_url: string
  because?: string[]; facts?: string[]; probability?: number; threshold?: number
}
export type CheckOptions = { modelDir?: string; allGrants?: boolean; rulesDir?: string; experimental?: boolean }

/** Rules ship next to dist/ in the package; fall back to the repo's rules/ during development. */
export function defaultRulesDir() {
  for (const d of [resolve(import.meta.dirname, '../rules'), resolve(import.meta.dirname, '../../rules')]) if (existsSync(d)) return d
  throw new Error('rules directory not found')
}

export async function runCheck(root: string, opts: CheckOptions = {}): Promise<{ files: number; findings: Finding[] }> {
  const projectRoot = resolve(root)
  const rules = loadRules(opts.rulesDir ?? defaultRulesDir())
  const byId = new Map(rules.map((r) => [r.id, r]))
  const findings: Finding[] = []
  const files = listFiles(projectRoot)

  // One fact store per Supabase project: SQL never mixes across projects (monorepos, vendored examples)
  const groups = new Map<string, string[]>()
  for (const f of files.filter((x) => x.endsWith('.sql'))) {
    const root = supabaseRoot(f, projectRoot)
    groups.set(root, [...(groups.get(root) ?? []), f])
  }
  const stores: Facts[] = []
  for (const [root, sqlFiles] of groups) stores.push(await buildFacts(root, sqlFiles, projectRoot))

  const base = (r: Rule) => ({ severity: r.severity, message: r.message, fix: r.fix, avoid: (r as any).avoid ?? [], docs_url: r.docs_url })
  const report = (id: string, file: string, line: number, because: string[]) => {
    const r = byId.get(id)
    if (r) findings.push({ rule_id: id, engine: 'facts', file, line, because, ...base(r) })
  }
  for (const sql of stores) {
  const on = (id: string) => { const e = String((byId.get(id) as any)?.engine ?? ''); return e === 'facts' || (e === 'facts-experimental' && !!opts.experimental) }
  for (const fn of sql.functions.values()) {
    const v = definerNoCallerCheck(fn, sql); if (v.flagged) report('definer-function-no-caller-check', fn.file, fn.line, v.because)
    const a = firstSignupAdmin(fn); if (a.flagged && on('first-signup-becomes-admin')) report('first-signup-becomes-admin', fn.file, fn.line, a.because)
    const u = userMetadataSql(fn.text); if (u?.flagged && on('user-metadata-for-authorization')) report('user-metadata-for-authorization', fn.file, fn.line, u.because)
  }
  for (const p of sql.policies) {
    const v = selectTrueOnPrivate(p, sql); if (v.flagged) report('select-true-on-private-data', p.file, p.line, v.because)
    const sr = serviceRolePolicyWithoutTo(p); if (sr.flagged) report('service-role-policy-without-to', p.file, p.line, sr.because)
    else { const w = alwaysTrueWrite(p); if (w.flagged) report('rls-policy-always-true-write', p.file, p.line, w.because) }
    const pa = policyAuthenticated(p, sql)
    if (pa?.owner.flagged && on('policy-authenticated-not-authorized')) report('policy-authenticated-not-authorized', p.file, p.line, pa.owner.because)
    if (pa?.team.flagged && on('team-wide-access-confirm-signup')) report('team-wide-access-confirm-signup', p.file, p.line, pa.team.because)
    const u = userMetadataSql(p.text); if (u?.flagged && on('user-metadata-for-authorization')) report('user-metadata-for-authorization', p.file, p.line, u.because)
  }
  for (const t of sql.tables.values()) {
    // tables created before the 2026-10-30 default change were auto-granted when they were created
    const stamp = Number(/(\d{14})_/.exec(t.file)?.[1] ?? 0)
    const affected = opts.allGrants || stamp >= 20261030000000 || !/migrations\//.test(t.file)
    const g = missingGrants(t, sql); if (g.flagged && affected) report('missing-api-grants-new-table', t.file, t.line, g.because)
    const w = grantWriteWithoutRls(t, sql); if (w.flagged) report('grant-write-without-rls', t.file, t.line, w.because)
    else { const d = rlsDisabled(t, sql); if (d.flagged) report('rls-disabled-on-exposed-table', t.file, t.line, d.because) }
  }
  }

  const ts = buildTsFacts(projectRoot, files.filter((f) => !f.endsWith('.sql')))
  const sqlFor = (rel: string) => stores.find((st) => st.policies.some((p) => p.file === rel) || st.history.some((fn) => fn.file === rel) || [...st.tables.values()].some((t) => t.file === rel))

  // TS rules decided by facts + code (getSession always; edge-function/admin-client while below the bar: --experimental)
  const tsRules = rules.filter((r) => (r as any).engine === 'facts' || ((r as any).engine === 'facts-experimental' && opts.experimental))
    .filter((r) => r.domain === 'sdk' || r.id === 'user-metadata-for-authorization')
  for (const file of files.filter((f) => !f.endsWith('.sql'))) {
    for (const chunk of await chunksFor(file)) {
      const rel = relative(projectRoot, resolve(chunk.file))
      const facts = factsFor(ts, rel, chunk.state)
      const state = withFacts(chunk.state, facts)
      const code = chunk.state.split('\n---\n').slice(1).join('\n---\n')
      for (const r of tsRules) {
        const v = r.id === 'user-metadata-for-authorization' ? userMetadataTs(code)
          : r.id === 'single-where-maybe-single' ? singleVerdict(chunk.state)
          : r.id === 'service-role-in-request-handler' || r.id === 'cross-tenant-id-from-body' ? tsExtraVerdicts(r.id, state, facts, chunk.kind)
          : tsRuleVerdict(r.id, state, facts, chunk.kind)
        if (v?.flagged) findings.push({ rule_id: r.id, engine: 'facts', file: rel, line: chunk.line, because: v.because, facts, ...base(r) })
      }
    }
  }

  if (opts.modelDir) {
    // model deps (onnxruntime-node, transformers) load only when a model is requested
    const { loadModel, score } = await import('./runtime.js').catch(() => {
      throw new Error('model rules need: npm i onnxruntime-node @huggingface/transformers')
    })
    const model = await loadModel(opts.modelDir)
    for (const file of files) {
      for (const chunk of await chunksFor(file)) {
        const asked = rules.filter((r) => !String((r as any).engine ?? '').startsWith('facts') && applicable(r, chunk) && model.meta.rules.includes(r.id))
        if (!asked.length) continue
        const rel = relative(projectRoot, resolve(chunk.file))
        const st = rel.endsWith('.sql') ? sqlFor(rel) : undefined
        const facts = rel.endsWith('.sql') ? (st ? sqlFactLines(st, rel, chunk.line) : []) : factsFor(ts, rel, chunk.state)
        const state = withFacts(chunk.state, facts)
        const probs = await score(model, state)
        for (const r of asked) {
          const threshold = model.meta.thresholds[r.id] ?? 0.5
          if (probs[r.id] >= threshold && !suppressedBy(r.id, state, facts))
            findings.push({ rule_id: r.id, engine: 'model', file: rel, line: chunk.line, facts, probability: round(probs[r.id]), threshold: round(threshold), ...base(r) })
        }
      }
    }
  }
  return { files: files.length, findings: dedupe(findings) }
}

/** Info rules report once per table (team-wide) or once per file (service-role), not once per statement. */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const k = f.rule_id === 'team-wide-access-confirm-signup' ? `${f.rule_id}#${f.because?.find((b) => /table/.test(b)) ?? ''}#${f.file}`
      : f.rule_id === 'service-role-in-request-handler' ? `${f.rule_id}#${f.file}`
      : `${f.rule_id}#${f.file}#${f.line}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Nearest ancestor (within the scan root) that holds a supabase/ project; else the file's own directory. */
function supabaseRoot(file: string, scanRoot: string): string {
  let dir = dirname(file)
  while (dir.startsWith(scanRoot)) {
    if (existsSync(join(dir, 'supabase', 'config.toml')) || existsSync(join(dir, 'supabase', 'migrations'))) return dir
    if (dir === scanRoot) break
    dir = dirname(dir)
  }
  const m = /^(.*)\/supabase\/(migrations|schemas)\//.exec(file)
  return m ? m[1] : dirname(file)
}

/** Files git tracks or would track (respects .gitignore), minus .supacheckignore; falls back to a walk. */
export function listFiles(root: string): string[] {
  let files: string[]
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    files = out.split('\n').filter(Boolean).map((f) => join(root, f)).filter((f) => /\.(tsx?|jsx?|sql)$/.test(f) && !/\.(test|spec)\.[tj]sx?$/.test(f) && existsSync(f))
  } catch {
    files = walk(root)
  }
  const ignoreFile = join(root, '.supacheckignore')
  const ignores = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : []
  return files.filter((f) => !ignores.some((pat) => relative(root, f).startsWith(pat.replace(/^\//, '').replace(/\*+$/, ''))))
}

export function walk(p: string): string[] {
  let st
  try { st = lstatSync(p) } catch { return [] }
  if (st.isSymbolicLink()) return []
  if (st.isFile()) return /\.(tsx?|jsx?|sql)$/.test(p) && !/\.(test|spec)\.[tj]sx?$/.test(p) ? [p] : []
  return readdirSync(p).filter((f) => !['node_modules', '.git', 'dist', '.next', 'build'].includes(f)).flatMap((f) => walk(join(p, f)))
}

const round = (x: number) => Math.round(x * 1000) / 1000
