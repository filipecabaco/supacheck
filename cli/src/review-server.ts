// Local web UI for gold-set review: same data and effects as review.ts
// (labels into data/gold/review.jsonl, confirmed rows appended to data/gold/manifest.jsonl).
//
//   pnpm review-web            → http://127.0.0.1:4321
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { fetchChunk } from './gold.js'
import { buildFacts, type Facts } from './facts.js'
import { buildTsFacts, factsFor, type TsFacts } from './tsfacts.js'
import { sqlFactLines } from './checks.js'
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import sql from 'highlight.js/lib/languages/pgsql'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('sql', sql)
const hljsStyles = join(import.meta.dirname, '../node_modules/highlight.js/styles')
const THEME = `${readFileSync(join(hljsStyles, 'github.min.css'), 'utf8')}
@media (prefers-color-scheme: dark) { ${readFileSync(join(hljsStyles, 'github-dark.min.css'), 'utf8')} }`

/** Header stays plain; code is highlighted server-side so the page needs no client library. */
function highlight(chunk: string) {
  const [header, ...rest] = chunk.split('\n---\n')
  const code = rest.join('\n---\n')
  const language = header.startsWith('Language: SQL') ? 'sql' : 'typescript'
  return { header, html: hljs.highlight(code, { language, ignoreIllegals: true }).value, lines: code.split('\n').length }
}

type Row = { url: string; line: number; rule: string; repo: string; teacher_p: number; label: 0 | 1 | null; reviewer: string | null; note: string }

const root = resolve(import.meta.dirname, '../..')
const reviewPath = join(root, 'data/gold/review.jsonl')
const manifestPath = join(root, 'data/gold/manifest.jsonl')
const cacheDir = join(root, 'data/gold/cache')
const port = Number(process.env.PORT ?? 4321)
const reviewer = process.env.USER ?? 'human'
mkdirSync(cacheDir, { recursive: true })

const rows: Row[] = readFileSync(reviewPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const questions = new Map<string, any>()
// Local clones of the reviewed repos (same commits), for repo-wide facts. Optional.
const corpus = process.env.CORPUS
const sqlFacts = new Map<string, Promise<Facts>>()
const tsFacts = new Map<string, TsFacts>()

/** Repo-wide facts a reviewer can't see in the chunk: import graph, helper behaviour, grants, RLS. */
async function repoFacts(row: Row, chunk: string): Promise<string[]> {
  const m = /github\.com\/([^/]+)\/([^/]+)\/blob\/[0-9a-f]+\/(.+)$/.exec(row.url)
  if (!corpus || !m) return []
  const dir = [corpus, process.env.CORPUS2].filter(Boolean).map((c) => join(c!, `${m[1]}__${m[2]}`)).find((d) => existsSync(d))
  if (!dir) return []
  const file = decodeURIComponent(m[3])
  if (!file.endsWith('.sql')) {
    if (!tsFacts.has(dir)) tsFacts.set(dir, buildTsFacts(dir))
    return factsFor(tsFacts.get(dir)!, file, chunk)
  }
  if (!sqlFacts.has(dir)) sqlFacts.set(dir, buildFacts(dir))
  return sqlFactLines(await sqlFacts.get(dir)!, file, row.line)
}
const history: { index: number; manifestLine?: string }[] = []

const key = (r: Row) => `${r.url}#${r.line}#${r.rule}`
const pending = (rule?: string) => rows.map((r, index) => ({ r, index })).filter(({ r }) => r.label === null && r.note !== 'skipped' && (!rule || r.rule === rule))
const save = () => writeFileSync(reviewPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

function question(rule: string) {
  if (!questions.has(rule)) questions.set(rule, parse(readFileSync(join(root, 'rules', `${rule}.yaml`), 'utf8')).question)
  return questions.get(rule)
}

async function item(rule?: string) {
  const [next, after] = pending(rule)
  if (after) void fetchChunk(after.r.url, after.r.line, cacheDir) // warm the cache for the next click
  const byRule: Record<string, { done: number; total: number }> = {}
  for (const r of rows) {
    byRule[r.rule] ??= { done: 0, total: 0 }
    byRule[r.rule].total++
    if (r.label !== null || r.note === 'skipped') byRule[r.rule].done++
  }
  const done = rows.filter((r) => r.label !== null || r.note === 'skipped').length
  const progress = { done, total: rows.length, byRule, canUndo: history.length > 0 }
  if (!next) return { progress, item: null }
  const chunk = (await fetchChunk(next.r.url, next.r.line, cacheDir)) ?? 'unavailable\n---\n(could not fetch chunk)'
  return { progress, item: { key: key(next.r), ...next.r, ...highlight(chunk), facts: await repoFacts(next.r, chunk), question: question(next.r.rule) } }
}

function answer(body: { key: string; answer: 'y' | 'n' | 's'; note?: string }) {
  // Prefer a still-pending row: the review file can hold exact duplicates (same url/line/rule).
  const matches = rows.flatMap((r, i) => (key(r) === body.key ? [i] : []))
  const index = matches.find((i) => rows[i].label === null && rows[i].note !== 'skipped') ?? matches[0] ?? -1
  if (index < 0) throw new Error('unknown item')
  const row = rows[index]
  row.reviewer = reviewer
  row.note = body.note?.trim() ?? ''
  let manifestLine: string | undefined
  if (body.answer === 's') {
    row.note = 'skipped'
  } else {
    row.label = body.answer === 'y' ? 1 : 0
    manifestLine = JSON.stringify({ url: row.url, line: row.line, rule: row.rule, label: row.label, note: row.note || `reviewed (teacher p=${row.teacher_p.toFixed(2)})`, reviewer })
    const kept = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean)
      .filter((l) => { const g = JSON.parse(l); return !(g.url === row.url && g.line === row.line && g.rule === row.rule) })
    writeFileSync(manifestPath, kept.concat(manifestLine).join('\n') + '\n')
  }
  history.push({ index, manifestLine })
  save()
}

function undo() {
  const last = history.pop()
  if (!last) return
  const row = rows[last.index]
  row.label = null
  row.note = ''
  row.reviewer = null
  if (last.manifestLine) {
    const lines = readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean)
    const at = lines.lastIndexOf(last.manifestLine)
    if (at >= 0) lines.splice(at, 1)
    writeFileSync(manifestPath, lines.join('\n') + '\n')
  }
  save()
}

async function readBody(req: IncomingMessage) {
  let data = ''
  for await (const chunk of req) data += chunk
  return data ? JSON.parse(data) : {}
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type })
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body))
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const rule = url.searchParams.get('rule') || undefined
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8')
    if (req.method === 'GET' && url.pathname === '/api/item') return send(res, 200, await item(rule))
    if (req.method === 'POST' && url.pathname === '/api/answer') { answer(await readBody(req)); return send(res, 200, await item(rule)) }
    if (req.method === 'POST' && url.pathname === '/api/undo') { undo(); return send(res, 200, await item(rule)) }
    send(res, 404, { error: 'not found' })
  } catch (e) {
    send(res, 500, { error: (e as Error).message })
  }
}).listen(port, '127.0.0.1', () => console.log(`gold review: http://127.0.0.1:${port}  (${pending().length} pending)`))

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>supacheck · gold review</title>
<style>${THEME}</style>
<style>
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#18181b; --muted:#71717a; --card:#fff; --border:#e4e4e7; --code:#f4f4f5; --yes:#16a34a; --no:#dc2626; --accent:#3ecf8e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f10; --fg:#ececee; --muted:#a1a1aa; --card:#18181b; --border:#2a2a2e; --code:#111113; } }
  * { box-sizing: border-box } body { margin:0; font:14px/1.5 system-ui,sans-serif; background:var(--bg); color:var(--fg) }
  header { position:sticky; top:0; z-index:1; display:flex; gap:16px; align-items:center; padding:10px 20px; background:var(--card); border-bottom:1px solid var(--border) }
  header h1 { font-size:15px; margin:0 } .bar { flex:1; height:6px; background:var(--border); border-radius:3px; overflow:hidden } .bar > i { display:block; height:100%; background:var(--accent) }
  select, input, button { font:inherit; color:inherit; background:var(--card); border:1px solid var(--border); border-radius:6px; padding:6px 10px }
  main { display:grid; grid-template-columns:minmax(0,1fr) 380px; gap:20px; padding:20px; max-width:1500px; margin:0 auto }
  .code { background:var(--code); border:1px solid var(--border); border-radius:8px; overflow:auto; max-height:calc(100vh - 140px); font:12.5px/1.55 ui-monospace,Menlo,monospace }
  .code .hdr { padding:10px 14px; color:var(--muted); border-bottom:1px solid var(--border); white-space:pre-wrap }
  .code .body { display:flex } .code pre { margin:0; padding:12px 14px; font:inherit; background:transparent !important }
  .code .gutter { color:var(--muted); opacity:.6; text-align:right; user-select:none; border-right:1px solid var(--border) }
  .code pre.hljs { flex:1; overflow:visible }
  aside { display:flex; flex-direction:column; gap:14px; position:sticky; top:70px; align-self:start }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:14px }
  .rule { font-weight:600; font-size:15px } .meta { color:var(--muted); font-size:12.5px; word-break:break-all } .meta a { color:inherit }
  .teacher { display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12.5px } .teacher .bar { height:8px } .teacher .bar > i { background:var(--muted) }
  .q { font-weight:600; margin-bottom:8px } .crit { font-size:13px; margin:6px 0; padding-left:10px; border-left:3px solid } .crit.y { border-color:var(--yes) } .crit.n { border-color:var(--no) }
  .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px } .actions button { padding:10px; font-weight:600; cursor:pointer }
  button.y { background:var(--yes); border-color:var(--yes); color:#fff } button.n { background:var(--no); border-color:var(--no); color:#fff }
  kbd { font:11px ui-monospace,monospace; border:1px solid currentColor; border-radius:3px; padding:0 4px; opacity:.75; margin-left:6px }
  .rules { font-size:12px; color:var(--muted); display:grid; grid-template-columns:1fr auto; gap:2px 10px }
  .facts ul { margin:0; padding-left:18px; font-size:12.5px } .facts li { margin:3px 0 }
  .done { text-align:center; padding:60px; color:var(--muted) } input#note { width:100% }
  @media (max-width:900px) { main { grid-template-columns:1fr } aside { position:static } }
</style></head>
<body>
<header><h1>supacheck · gold review</h1><div class="bar"><i id="prog"></i></div><span id="count" class="meta"></span>
  <select id="filter"><option value="">all rules</option></select></header>
<main id="main"><div class="done">loading…</div></main>
<script>
const $ = (s) => document.querySelector(s)
let current = null, busy = false
const rule = () => $('#filter').value
async function call(path, body) {
  busy = true
  const res = await fetch(path + '?rule=' + encodeURIComponent(rule()), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  busy = false
  const data = await res.json()
  if (data.error) return alert(data.error)
  render(data)
}
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) k === 'class' ? (e.className = v) : e.setAttribute(k, v)
  for (const c of children) e.append(c)
  return e
}
function render({ progress, item }) {
  current = item
  $('#prog').style.width = (100 * progress.done / progress.total) + '%'
  $('#count').textContent = progress.done + ' / ' + progress.total
  const f = $('#filter')
  if (f.options.length === 1) for (const r of Object.keys(progress.byRule).sort()) f.append(el('option', { value: r }, r))
  for (const o of f.options) if (o.value) { const s = progress.byRule[o.value]; o.textContent = o.value + '  (' + s.done + '/' + s.total + ')' }
  const main = $('#main'); main.replaceChildren()
  if (!item) { main.append(el('div', { class: 'done' }, 'Nothing pending' + (rule() ? ' for this rule' : '') + '. 🎉')); return }
  const codePre = el('pre', { class: 'hljs' }); codePre.innerHTML = item.html // escaped by highlight.js
  const gutter = el('pre', { class: 'gutter' }, Array.from({ length: item.lines }, (_, i) => i + 1).join('\\n'))
  const pre = el('div', { class: 'code' }, el('div', { class: 'hdr' }, item.header), el('div', { class: 'body' }, gutter, codePre))
  const q = item.question
  const bar = el('div', { class: 'bar' }, el('i')); bar.firstChild.style.width = (item.teacher_p * 100) + '%'
  const note = el('input', { id: 'note', placeholder: 'note (optional) — Enter to focus' })
  const btn = (cls, label, k, ans) => { const b = el('button', { class: cls }, label, el('kbd', {}, k)); b.onclick = () => submit(ans); return b }
  const undo = el('button', {}, 'Undo', el('kbd', {}, 'u')); undo.onclick = () => progress.canUndo && call('/api/undo', {}); if (!progress.canUndo) undo.disabled = true
  const rulesList = el('div', { class: 'rules' })
  for (const [r, s] of Object.entries(progress.byRule).sort()) rulesList.append(el('span', {}, r), el('span', {}, s.done + '/' + s.total))
  main.append(pre, el('aside', {},
    el('div', { class: 'card' }, el('div', { class: 'rule' }, item.rule),
      el('div', { class: 'meta' }, el('a', { href: item.url + '#L' + item.line, target: '_blank', rel: 'noreferrer' }, item.repo + ' · ' + item.url.split('/blob/')[1].split('/').slice(1).join('/') + ':' + item.line)),
      el('div', { class: 'teacher' }, 'teacher', bar, item.teacher_p.toFixed(2))),
    ...(item.facts?.length ? [el('div', { class: 'card facts' }, el('div', { class: 'q' }, 'Repo facts'), el('ul', {}, ...item.facts.map((f) => el('li', {}, f))))] : []),
    ...(item.prev_label != null ? [el('div', { class: 'card meta' }, 'Re-review: previously labelled ' + (item.prev_label ? 'yes' : 'no') + (item.prev_note ? ' — ' + item.prev_note : ''))] : []),
    el('div', { class: 'card' }, el('div', { class: 'q' }, q.instructions),
      el('div', { class: 'crit y' }, el('b', {}, 'yes: '), q.criteria.true), el('div', { class: 'crit n' }, el('b', {}, 'no: '), q.criteria.false)),
    el('div', { class: 'card' }, note),
    el('div', { class: 'actions' }, btn('y', 'Yes, problem', 'y', 'y'), btn('n', 'No problem', 'n', 'n'), btn('', 'Skip', 's', 's'), undo),
    el('div', { class: 'card' }, rulesList)))
}
function submit(answer) { if (current && !busy) call('/api/answer', { key: current.key, answer, note: $('#note')?.value ?? '' }) }
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') e.target.blur(); return }
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'y' || e.key === 'n' || e.key === 's') submit(e.key)
  else if (e.key === 'u') call('/api/undo', {})
  else if (e.key === 'Enter') { e.preventDefault(); $('#note')?.focus() }
})
$('#filter').onchange = () => call('/api/item')
call('/api/item')
</script></body></html>`
