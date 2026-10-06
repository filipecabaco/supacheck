// Score the deterministic fact-based checks on the reviewed gold items for their rules.
//   pnpm tsx src/eval-facts.ts <corpus dir with owner__repo clones> [--verbose]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildFacts } from './facts.js';
import { definerNoCallerCheck, selectTrueOnPrivate } from './checks.js';
const root = resolve(import.meta.dirname, '../..');
const corpus = process.argv[2];
const verbose = process.argv.includes('--verbose');
const RULES = ['definer-function-no-caller-check', 'select-true-on-private-data'];
const gold = readFileSync(join(root, 'data/gold/manifest.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((g) => RULES.includes(g.rule));
const factsByRepo = new Map();
const stats = {};
for (const g of gold) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/blob\/[0-9a-f]+\/(.+)$/.exec(g.url);
    const [, owner, repo, path] = m;
    const dir = join(corpus, `${owner}__${repo}`);
    const s = (stats[g.rule] ??= { tp: 0, fp: 0, fn: 0, tn: 0, missing: 0 });
    if (!existsSync(dir)) {
        s.missing++;
        continue;
    }
    if (!factsByRepo.has(dir))
        factsByRepo.set(dir, await buildFacts(dir));
    const facts = factsByRepo.get(dir);
    const file = decodeURIComponent(path);
    let v;
    if (g.rule === 'definer-function-no-caller-check') {
        const version = facts.history.find((f) => f.file === file && f.line === g.line);
        // judge the version the reviewer saw, with the repo's final grants (shared across redefinitions)
        if (version)
            v = definerNoCallerCheck(version, facts);
    }
    else {
        const p = facts.policies.find((x) => x.file === file && x.line === g.line);
        if (p)
            v = selectTrueOnPrivate(p, facts);
    }
    if (!v) {
        s.missing++;
        if (verbose)
            console.log(`· ${g.rule} not found (later redefined/dropped?) ${owner}/${repo}/${file}:${g.line}`);
        continue;
    }
    const cell = v.flagged ? (g.label ? 'tp' : 'fp') : g.label ? 'fn' : 'tn';
    s[cell]++;
    if (verbose || cell === 'fp' || cell === 'fn')
        console.log(`${cell === 'tp' || cell === 'tn' ? '✓' : '✗'} ${cell} ${g.rule} ${owner}/${repo}/${file}:${g.line}\n    ${v.because.join(' · ')}${g.note ? `\n    reviewer: ${g.note}` : ''}`);
}
for (const [rule, s] of Object.entries(stats)) {
    const p = s.tp + s.fp ? (s.tp / (s.tp + s.fp)).toFixed(2) : '-';
    const r = s.tp + s.fn ? (s.tp / (s.tp + s.fn)).toFixed(2) : '-';
    console.log(`${rule.padEnd(36)} tp=${s.tp} fp=${s.fp} fn=${s.fn} tn=${s.tn} not-found=${s.missing}  precision=${p} recall=${r}`);
}
