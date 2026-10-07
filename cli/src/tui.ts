// Terminal front-end for `supacheck check`: live stage progress on stderr (@clack/prompts), the
// findings report on stdout. Colours via picocolors (NO_COLOR / FORCE_COLOR / TTY aware).
// --format json/sarif never come through here.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { intro, isCI, isTTY, log, outro, progress, spinner, type ProgressResult, type SpinnerResult } from '@clack/prompts'
import pc from 'picocolors'
import wrapAnsi from 'wrap-ansi'
import type { Finding, Progress } from './check.js'

const SEVERITIES = ['critical', 'high', 'error', 'warning', 'info'] as const
const BLOCKING = new Set(['critical', 'high', 'error'])
const tone = (sev: string) => (sev === 'critical' || sev === 'error' ? (t: string) => pc.bold(pc.red(t)) : sev === 'high' ? pc.red : sev === 'warning' ? pc.yellow : pc.cyan)
const MARK: Record<string, string> = { critical: '●', high: '●', error: '●', warning: '▲', info: '○' }

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const seconds = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`)
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`)
const label = (l: string) => pc.bold(l.padEnd(6))

/** Interactive only on a real terminal outside CI; otherwise progress stays silent (the report still prints). */
export const interactive = (out: NodeJS.WriteStream = process.stderr) => isTTY(out) && !isCI() && process.env.TERM !== 'dumb' && (out.columns ?? 0) >= 40

// ── live progress (stderr) ─────────────────────────────────────────────────────────────────────

export class ProgressView {
  private live?: SpinnerResult
  private bar?: ProgressResult
  private barAt = 0
  private dl?: { t0: number; b0: number; total: number }
  private phase?: 'download' | 'score'
  private started = Date.now()
  private readonly out = process.stderr
  private readonly on_: boolean

  constructor(private modelRequested = false) {
    this.on_ = interactive(this.out)
  }

  intro(target: string, version: string) {
    if (this.on_) intro(`${pc.bold('supacheck')} ${pc.dim(version)}  ${pc.dim('checking')} ${target}`, { output: this.out })
  }

  on = (e: Progress) => {
    if (!this.on_) {
      // non-interactive: one line for the only slow, surprising step
      if (e.stage === 'download' && !this.dl) {
        this.dl = { t0: Date.now(), b0: e.bytes, total: e.total }
        this.out.write(`supacheck: downloading the model once (${size(e.total)}), cached for later runs…\n`)
      }
      return
    }

    if (e.stage === 'sql' && !e.done) this.spin(`${label('SQL')} replaying ${plural(e.files, 'migration file')}`)
    else if (e.stage === 'sql' && e.done) this.done(!e.files ? `${label('SQL')} ${pc.dim('no migrations found')}`
      : `${label('SQL')} ${[plural(e.files, 'file'), plural(e.tables, 'table'), plural(e.policies, 'policy', 'policies'), plural(e.functions, 'function')].join(pc.dim(' · '))}${e.projects > 1 ? pc.dim(` · ${e.projects} projects`) : ''}`)
    else if (e.stage === 'code' && !e.done) this.spin(`${label('Code')} reading ${plural(e.files, 'file')}`)
    else if (e.stage === 'code' && e.done) {
      this.done(`${label('Code')} ${plural(e.files, 'file')} ${pc.dim('·')} ${plural(e.rules, 'rule')} checked`)
      if (this.modelRequested) this.spin(`${label('Model')} loading`)
    } else if (e.stage === 'download') {
      if (this.phase !== 'download') {
        this.phase = 'download'
        this.dl = { t0: Date.now(), b0: e.bytes, total: e.total }
        this.startBar(e.total, `${label('Model')} downloading ${size(e.total)}, once`)
      }
      const rate = (e.bytes - this.dl!.b0) / Math.max(0.001, (Date.now() - this.dl!.t0) / 1000)
      this.advance(e.bytes, `${label('Model')} ${size(e.bytes)} / ${size(e.total)}${rate > 0 ? pc.dim(`  ${(rate / 1e6).toFixed(0)} MB/s`) : ''}`)
    } else if (e.stage === 'model' && !e.done) {
      if (this.phase !== 'score') {
        if (this.phase === 'download') this.done(`${label('Model')} downloaded ${size(this.dl!.total)} ${pc.dim('(cached for next time)')}`)
        this.phase = 'score'
        this.startBar(Math.max(1, e.total), `${label('Model')} scoring ${plural(e.total, 'chunk')}`)
      }
      this.advance(e.scored, `${label('Model')} scoring ${e.scored}/${e.total}`)
    } else if (e.stage === 'model' && e.done) this.done(`${label('Model')} ${plural(e.scored, 'chunk')} scored ${pc.dim('·')} ${plural(e.rules, 'rule')} ${pc.magenta('experimental')}`)
  }

  private advance(to: number, msg: string) {
    if (to > this.barAt) this.bar?.advance(to - this.barAt, msg)
    this.barAt = Math.max(this.barAt, to)
  }

  /** Clear whatever is still animating (before an error or the report). */
  stop() {
    this.live?.clear()
    this.bar?.clear()
    this.live = this.bar = undefined
  }

  private spin(msg: string) {
    this.stop()
    this.started = Date.now()
    this.live = spinner({ output: this.out, indicator: 'dots' })
    this.live.start(msg)
  }

  private startBar(max: number, msg: string) {
    this.stop()
    this.started = Date.now()
    this.barAt = 0
    this.bar = progress({ output: this.out, max, size: 24, style: 'heavy' })
    this.bar.start(msg)
  }

  private done(msg: string) {
    const took = pc.dim(seconds(Date.now() - this.started))
    const active = this.live ?? this.bar
    this.live = this.bar = undefined
    if (active) active.stop(`${msg}  ${took}`)
    else log.success(`${msg}  ${took}`, { output: this.out })
  }
}

// ── report (stdout) ────────────────────────────────────────────────────────────────────────────

const PER_RULE = 5

export function report(opts: { root: string; files: number; findings: Finding[]; strict: boolean; ms: number }) {
  const output = process.stdout
  const cols = Math.max(60, Math.min(output.columns || 100, 110)) - 3 // clack's "│  " rail
  const wrap = (text: string, indent: number) => wrapAnsi(text, cols - indent, { hard: false }).split('\n').join('\n' + ' '.repeat(indent))

  const bySeverity = new Map<string, Map<string, Finding[]>>()
  for (const f of opts.findings) {
    const sev = SEVERITIES.includes(f.severity as any) ? f.severity : 'info'
    const rules = bySeverity.get(sev) ?? new Map<string, Finding[]>()
    rules.set(f.rule_id, [...(rules.get(f.rule_id) ?? []), f])
    bySeverity.set(sev, rules)
  }

  for (const sev of SEVERITIES) {
    const rules = bySeverity.get(sev)
    if (!rules) continue
    const paint = tone(sev)
    const count = [...rules.values()].reduce((n, fs) => n + fs.length, 0)
    log.message(paint(`${sev.toUpperCase()} · ${count}`), { output, symbol: paint('■') })

    for (const [rule, fs] of [...rules].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const f0 = fs[0]
      const lines: string[] = [
        `${pc.bold(rule)}${fs.length > 1 ? pc.dim(`  ×${fs.length}`) : ''}${fs.every((f) => f.engine === 'model') ? pc.magenta('  model · experimental') : ''}`,
        wrap(f0.message, 0),
      ]
      fs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      for (const f of fs.slice(0, PER_RULE)) {
        const at = focusLine(opts.root, f)
        lines.push('', pc.underline(`${f.file}:${at}`))
        for (const l of excerpt(opts.root, f.file, at, cols - 2)) lines.push(l.focus ? `${paint('▶')} ${pc.dim(l.no)} ${pc.dim('│')} ${l.text}` : `  ${pc.dim(l.no)} ${pc.dim('│')} ${pc.dim(l.text)}`)
        const why = f.because?.length ? f.because.join(pc.dim(' · ')) : f.probability !== undefined ? `model probability ${f.probability} ≥ threshold ${f.threshold}` : ''
        if (why) lines.push(`${pc.dim('why')}   ${wrap(why, 6)}`)
      }
      if (fs.length > PER_RULE) {
        const rest = fs.slice(PER_RULE)
        const files = [...new Set(rest.map((f) => f.file))]
        lines.push(pc.dim(`+ ${rest.length} more in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} other files` : ''} (--format json lists all)`))
      }
      lines.push('', `${pc.green('fix')}   ${wrap(f0.fix, 6)}`)
      f0.avoid.forEach((a, i) => lines.push(`${i ? '     ' : pc.yellow("don't")} ${wrap(a, 6)}`))
      lines.push(`${pc.dim('docs')}  ${pc.dim(f0.docs_url)}`)
      log.message(lines.flatMap((l) => l.split('\n')), { output, symbol: paint(MARK[sev] ?? '●') })
    }
  }

  const blocking = opts.findings.some((f) => opts.strict || BLOCKING.has(f.severity))
  const where = pc.dim(`${plural(opts.files, 'file')} · ${seconds(opts.ms)}`)
  const modelNote = opts.findings.some((f) => f.engine === 'model') ? pc.dim('\n   Model findings are experimental: check them before acting.') : ''
  if (!opts.files) {
    log.warn(`Nothing to check: no SQL or TypeScript/JavaScript files under ${opts.root}.`, { output })
    outro(pc.dim('Run it from your project root, the folder that contains supabase/.'), { output })
  } else if (!opts.findings.length) {
    outro(`${pc.green('✔')} ${pc.bold('No issues found.')}  ${where}`, { output })
  } else {
    const tally = SEVERITIES.map((s) => [s, [...(bySeverity.get(s)?.values() ?? [])].reduce((n, fs) => n + fs.length, 0)] as const)
      .filter(([, n]) => n).map(([s, n]) => tone(s)(`${n} ${s}`)).join(pc.dim(' · '))
    const verdict = blocking
      ? pc.dim(`\n   Exit 1: ${opts.strict ? 'any finding fails with --strict' : 'critical and high findings block CI'}.`)
      : pc.dim('\n   Exit 0: nothing blocking. Add --strict to fail on warnings and info too.')
    outro(`${blocking ? pc.red('✖') : pc.green('✔')} ${tally}  ${where}${verdict}${modelNote}`, { output })
  }
}

// ── code excerpts ──────────────────────────────────────────────────────────────────────────────

// Code findings are anchored at the enclosing function or chunk; the excerpt points at the line that
// shows the problem when one matches within the chunk. SQL findings already sit on their statement.
const EVIDENCE: Record<string, RegExp> = {
  'server-trusts-getsession': /\bgetSession\s*\(/,
  'user-metadata-for-authorization': /user_metadata|userMetadata/,
  'single-where-maybe-single': /\.single\s*\(/,
  'service-role-in-request-handler': /service.?role/i,
  'admin-client-for-user-scoped-work': /service.?role|\badmin\b/i,
  'ef-service-role-trusts-body-identity': /req(uest)?\.json\s*\(|\bbody\b/,
  'cross-tenant-id-from-body': /\bbody\b|req(uest)?\.json\s*\(/,
}
const CHUNK_REACH = 80
const cache = new Map<string, string[] | null>()

function load(root: string, file: string) {
  const path = join(root, file)
  if (!cache.has(path)) cache.set(path, existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : null)
  return cache.get(path)
}

/** The line to show for a finding: its anchor, or the first evidence line inside the chunk for code rules. */
export function focusLine(root: string, f: Finding): number {
  const re = EVIDENCE[f.rule_id]
  const src = re && !f.file.endsWith('.sql') ? load(root, f.file) : null
  if (!src) return f.line
  for (let n = f.line; n <= Math.min(src.length, f.line + CHUNK_REACH); n++) if (re.test(src[n - 1])) return n
  return f.line
}

/** The finding's line with one line of context either side (blank context lines skipped). */
function excerpt(root: string, file: string, line: number, cols: number) {
  const src = load(root, file)
  if (!src || line < 1 || line > src.length) return []
  const from = Math.max(1, line - 1), to = Math.min(src.length, line + 1)
  const pad = String(to).length
  const out: { no: string; text: string; focus: boolean }[] = []
  for (let n = from; n <= to; n++) {
    const raw = src[n - 1].replace(/\t/g, '  ')
    if (n !== line && !raw.trim()) continue
    const text = raw.length > cols - pad - 5 ? raw.slice(0, cols - pad - 6) + '…' : raw
    out.push({ no: String(n).padStart(pad), text, focus: n === line })
  }
  return out
}

export function fail(message: string, hint?: string) {
  log.error(`${pc.bold(message)}${hint ? '\n' + pc.dim(hint) : ''}`, { output: process.stderr })
}
