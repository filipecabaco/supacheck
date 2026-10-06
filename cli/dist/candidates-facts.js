// Validation candidates for facts-engine rules that have no gold labels yet: a sample of flagged
// findings (precision) plus near-misses where cheap to define (recall gaps). Appends pending rows
// to data/gold/review.jsonl with source "facts-validation".
//   CORPUS=<dir> CORPUS2=<dir> pnpm tsx src/candidates-facts.ts [--per-rule 20]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCheck } from './check.js';
import { buildFacts } from './facts.js';
import { firstSignupAdmin } from './checks.js';
const RULES = ['first-signup-becomes-admin', 'team-wide-access-confirm-signup', 'service-role-in-request-handler', 'cross-tenant-id-from-body'];
const root = resolve(import.meta.dirname, '../..');
const perRule = Number(process.argv[process.argv.indexOf('--per-rule') + 1] || 20);
const dirs = [process.env.CORPUS, process.env.CORPUS2].filter(Boolean).flatMap((c) => readdirSync(c).filter((d) => d.includes('__')).map((d) => join(c, d)));
const pool = [];
for (const dir of dirs) {
    const repo = dir.split('/').pop().replace('__', '/');
    let sha;
    try {
        sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
    }
    catch {
        continue;
    }
    const url = (file) => `https://github.com/${repo}/blob/${sha}/${file}`;
    const { findings } = await runCheck(dir, { experimental: true });
    for (const f of findings.filter((x) => RULES.includes(x.rule_id)))
        pool.push({ url: url(f.file), line: f.line, rule: f.rule_id, kind: 'facts', repo, teacher_p: 1, flagged: true });
    // near-misses for first-signup: triggers that assign an admin/owner role without an emptiness check
    const sql = await buildFacts(dir);
    for (const fn of sql.functions.values())
        if (fn.trigger && /'(admin|owner|administrator)'/i.test(fn.body) && !firstSignupAdmin(fn).flagged)
            pool.push({ url: url(fn.file), line: fn.line, rule: 'first-signup-becomes-admin', kind: 'facts', repo, teacher_p: 0, flagged: false });
}
const picked = [];
for (const rule of RULES) {
    for (const flagged of [true, false]) {
        const perRepo = new Map();
        const cap = flagged ? perRule : Math.ceil(perRule / 2);
        for (const x of pool.filter((p) => p.rule === rule && p.flagged === flagged).sort(() => Math.random() - 0.5)) {
            if (picked.filter((p) => p.rule === rule && p.flagged === flagged).length >= cap)
                break;
            if ((perRepo.get(x.repo) ?? 0) >= 3)
                continue;
            perRepo.set(x.repo, (perRepo.get(x.repo) ?? 0) + 1);
            picked.push(x);
        }
    }
}
const reviewPath = join(root, 'data/gold/review.jsonl');
const existing = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8').split('\n').filter(Boolean) : [];
const seen = new Set(existing.map((l) => { const j = JSON.parse(l); return `${j.url}#${j.line}#${j.rule}`; }));
const fresh = picked.filter((x) => { const k = `${x.url}#${x.line}#${x.rule}`; if (seen.has(k))
    return false; seen.add(k); return true; })
    .map(({ flagged, ...x }) => JSON.stringify({ ...x, label: null, reviewer: null, note: '', source: 'facts-validation', engine_flagged: flagged }));
writeFileSync(reviewPath, existing.concat(fresh).join('\n') + '\n');
const by = {};
for (const r of RULES)
    by[r] = `${picked.filter((p) => p.rule === r && p.flagged).length} flagged + ${picked.filter((p) => p.rule === r && !p.flagged).length} near-miss (pool ${pool.filter((p) => p.rule === r).length})`;
console.log(`appended ${fresh.length}`, by);
