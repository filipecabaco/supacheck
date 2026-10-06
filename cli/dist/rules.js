import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
export function loadRules(dir) {
    return readdirSync(dir)
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => parse(readFileSync(join(dir, f), 'utf8')));
}
/** A rule is asked only when the chunk kind fits and one of its trigger literals appears. */
export function applicable(rule, chunk) {
    const kindOk = rule.applies_to.includes(chunk.kind) || (chunk.kind === 'trigger' && rule.applies_to.includes('function'));
    if (!kindOk)
        return false;
    const code = chunk.state.toLowerCase();
    return rule.trigger.split('|').some((t) => code.includes(t.toLowerCase()));
}
