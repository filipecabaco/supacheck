// Parse every generated sample (TS with oxc, SQL with the real Postgres parser) so template
// bugs surface as syntax errors instead of silently teaching the model broken code.
//
//   pnpm validate-samples [../data/generated]
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseSync } from 'oxc-parser'
import { parse as parseSql } from 'libpg-query'

type Sample = { id: string; rule: string; family: string; framework: string; state: string }

const dir = process.argv[2] ?? join(import.meta.dirname, '../../data/generated')
const files = readdirSync(dir).filter((f) => /^(train|val|test)\.jsonl$/.test(f))

const failures = new Map<string, { count: number; example: string }>()
let checked = 0

for (const file of files) {
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const s: Sample = JSON.parse(line)
    const [header, code] = s.state.split('\n---\n', 2)
    checked++

    let error: string | undefined
    if (header.startsWith('Language: SQL')) {
      try {
        await parseSql(code)
      } catch (e) {
        error = (e as Error).message
      }
    } else {
      const result = parseSync('sample.ts', code, { sourceType: 'module', lang: 'ts' })
      if (result.errors.length) error = result.errors[0].message
    }

    if (error) {
      const key = `${s.rule} / ${s.family} / ${s.framework}`
      const prev = failures.get(key)
      failures.set(key, { count: (prev?.count ?? 0) + 1, example: prev?.example ?? `${error}\n${code}` })
    }
  }
}

console.log(`checked ${checked} samples, ${failures.size} failing template groups`)
for (const [key, { count, example }] of failures) {
  console.log(`\n✗ ${key} (${count})\n${example.split('\n').slice(0, 30).join('\n')}`)
}
process.exitCode = failures.size ? 1 : 0
