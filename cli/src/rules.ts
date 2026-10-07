import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { Chunk } from './chunks.js'

export type Rule = {
  id: string
  domain: 'sdk' | 'sql'
  /** Chunk kinds the model is asked about; facts-only rules have none. */
  applies_to?: string[]
  trigger: string
  severity: string
  message: string
  fix: string
  docs_url: string
}

export function loadRules(dir: string): Rule[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parse(readFileSync(join(dir, f), 'utf8')) as Rule)
}

/** A rule is asked only when the chunk kind fits and one of its trigger literals appears. */
export function applicable(rule: Rule, chunk: Chunk): boolean {
  if (!rule.applies_to) return false
  const kindOk = rule.applies_to.includes(chunk.kind) || (chunk.kind === 'trigger' && rule.applies_to.includes('function'))
  if (!kindOk) return false
  const code = chunk.state.toLowerCase()
  return rule.trigger.split('|').some((t) => code.includes(t.toLowerCase()))
}
