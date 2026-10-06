#!/usr/bin/env node
// supacheck check <project> [--format text|json|sarif] [--strict] [--all-grants] [--experimental --model <dir>]
// supacheck chunks <paths...> [--strip-prefix <dir>]
// supacheck mcp                              (stdio MCP server exposing supacheck_check)
//
// Exit codes: 0 clean (or warnings only), 1 error/critical findings (any finding with --strict), 2 usage.
import { parseArgs } from 'node:util'
import { chunksFor } from './chunks.js'
import { defaultRulesDir, runCheck, walk, type Finding } from './check.js'
import { applicable, loadRules } from './rules.js'
import { startMcp } from './mcp.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: 'string', default: 'text' },
    strict: { type: 'boolean', default: false },
    'all-grants': { type: 'boolean', default: false },
    experimental: { type: 'boolean', default: false },
    model: { type: 'string' },
    'strip-prefix': { type: 'string' },
  },
})
const [command, ...paths] = positionals
const BLOCKING = new Set(['error', 'critical', 'high'])

if (command === 'mcp') {
  await startMcp()
} else if (command === 'chunks' && paths.length) {
  const rules = loadRules(defaultRulesDir())
  for (const file of paths.flatMap(walk)) {
    const shown = values['strip-prefix'] ? file.replace(values['strip-prefix'], '').replace(/^\//, '') : file
    for (const chunk of await chunksFor(file, { displayPath: shown })) {
      const asked = rules.filter((r) => applicable(r, chunk)).map((r) => r.id)
      if (asked.length) console.log(JSON.stringify({ ...chunk, rules: asked }))
    }
  }
  // no process.exit(): stdout to a pipe is async and would be truncated
} else if (command === 'check') {
  const root = paths[0] ?? '.'
  const { files, findings } = await runCheck(root, { allGrants: values['all-grants'], experimental: values.experimental, modelDir: values.experimental ? values.model : undefined })
  if (values.format === 'json') console.log(JSON.stringify({ files, findings }, null, 2))
  else if (values.format === 'sarif') console.log(JSON.stringify(sarif(findings), null, 2))
  else printText(files, findings)
  process.exitCode = findings.some((f) => values.strict || BLOCKING.has(f.severity)) ? 1 : 0
} else {
  console.error('usage: supacheck check [project] [--format text|json|sarif] [--strict] [--all-grants] [--experimental --model <dir>]\n       supacheck chunks <paths...> [--strip-prefix <dir>]\n       supacheck mcp')
  process.exitCode = 2
}

function printText(files: number, findings: Finding[]) {
  // grouped by rule, at most 5 shown per rule (JSON/SARIF carry everything)
  const shown = new Map<string, number>()
  const order = ['critical', 'high', 'error', 'warning', 'info']
  const sorted = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.rule_id.localeCompare(b.rule_id))
  for (const f of sorted) {
    const n = (shown.get(f.rule_id) ?? 0) + 1
    shown.set(f.rule_id, n)
    if (n > 5) continue
    const why = f.because ? `because: ${f.because.join('; ')}` : `p=${f.probability} (thr ${f.threshold})`
    const avoid = f.avoid.length ? `\n  don't: ${f.avoid.join(' | ')}` : ''
    console.log(`${f.file}:${f.line}  [${f.severity}] ${f.rule_id}\n  ${why}\n  ${f.message}\n  fix: ${f.fix}${avoid}\n  ${f.docs_url}\n`)
  }
  for (const [id, n] of shown) if (n > 5) console.log(`  … +${n - 5} more ${id} findings (use --format json for all)`)
  console.log(`${files} files, ${findings.length} findings`)
}

function sarif(findings: Finding[]) {
  const level = (s: string) => (BLOCKING.has(s) ? 'error' : s === 'warning' ? 'warning' : 'note')
  const ids = [...new Set(findings.map((f) => f.rule_id))]
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: { driver: { name: 'supacheck', informationUri: 'https://github.com/supabase', rules: ids.map((id) => {
        const f = findings.find((x) => x.rule_id === id)!
        return { id, shortDescription: { text: f.message }, help: { text: `${f.fix}\nAvoid: ${f.avoid.join('; ')}` }, helpUri: f.docs_url }
      }) } },
      results: findings.map((f) => ({
        ruleId: f.rule_id, level: level(f.severity),
        message: { text: `${f.message}${f.because ? ` (${f.because.join('; ')})` : ''}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line } } }],
      })),
    }],
  }
}
