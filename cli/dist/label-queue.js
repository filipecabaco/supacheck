// Agent pre-labelling for queued review rows (data/gold/review.jsonl rows with source "active-1").
//   CORPUS=<clones> pnpm tsx src/label-queue.ts export [--out ../artifacts/active/queue.jsonl]
//     one line per pending row: key, rule, question, committee scores and the state the models saw (with facts)
//   pnpm tsx src/label-queue.ts apply <decisions.jsonl>...
//     decisions: {"key","label":0|1,"confidence":"high"|"low","reason"}. Confident labels that the committee
//     doesn't strongly contradict become gold (reviewer claude-review-agent); the rest stay pending in
//     `pnpm review-web` with the agent's suggestion shown, for a human spot-check.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { chunksFor, withFacts } from './chunks.js';
import { buildFacts } from './facts.js';
import { buildTsFacts, factsFor } from './tsfacts.js';
import { sqlFactLines } from './checks.js';
const root = resolve(import.meta.dirname, '../..');
const reviewPath = join(root, 'data/gold/review.jsonl');
const manifestPath = join(root, 'data/gold/manifest.jsonl');
const SOURCE = 'active-1';
const AGENT = 'claude-review-agent';
// rules with fewer labelled positives than this get every agent "yes" spot-checked: those labels set thresholds
const RARE_POSITIVES = 5;
const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', default: join(root, 'artifacts/active/queue.jsonl') } } });
const readJsonl = (path) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const key = (r) => `${r.url}#${r.line}#${r.rule}`;
const isQueued = (r) => r.source === SOURCE && r.label === null && r.note !== 'skipped' && r.agent_label == null;
if (positionals[0] === 'export')
    await exportQueue();
else if (positionals[0] === 'apply')
    apply(positionals.slice(1));
else {
    console.error('usage: label-queue.ts export [--out file] | apply <decisions.jsonl>...');
    process.exitCode = 2;
}
async function exportQueue() {
    const corpus = process.env.CORPUS;
    if (!corpus)
        throw new Error('need CORPUS=<clones dir> (the corpus the queue was scored from)');
    const questions = new Map();
    const sqlFacts = new Map();
    const tsFacts = new Map();
    const out = [];
    let missing = 0;
    for (const r of readJsonl(reviewPath).filter(isQueued)) {
        const [owner, repo, , , ...path] = String(r.url).split('/').slice(3);
        const dir = join(corpus, `${owner}__${repo}`);
        const rel = decodeURIComponent(path.join('/'));
        const chunk = existsSync(join(dir, rel)) ? (await chunksFor(join(dir, rel), { displayPath: rel })).find((c) => c.line === r.line) : undefined;
        if (!chunk) {
            missing++;
            continue;
        }
        let facts;
        if (rel.endsWith('.sql')) {
            if (!sqlFacts.has(dir))
                sqlFacts.set(dir, await buildFacts(dir));
            facts = sqlFactLines(sqlFacts.get(dir), rel, r.line);
        }
        else {
            if (!tsFacts.has(dir))
                tsFacts.set(dir, buildTsFacts(dir));
            facts = factsFor(tsFacts.get(dir), rel, chunk.state);
        }
        if (!questions.has(r.rule))
            questions.set(r.rule, parse(readFileSync(join(root, 'rules', `${r.rule}.yaml`), 'utf8')).question);
        out.push(JSON.stringify({ key: key(r), rule: r.rule, question: questions.get(r.rule), url: r.url, committee: r.committee, state: withFacts(chunk.state, facts) }));
    }
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, out.join('\n') + '\n');
    console.log(`exported ${out.length} queued rows → ${values.out}${missing ? ` (${missing} not found in CORPUS)` : ''}`);
}
function apply(files) {
    const decisions = new Map(files.flatMap(readJsonl).map((d) => [d.key, d]));
    const rows = readJsonl(reviewPath);
    const positives = {};
    for (const r of rows)
        if (r.label === 1)
            positives[r.rule] = (positives[r.rule] ?? 0) + 1;
    const manifest = readJsonl(manifestPath);
    const counts = { accepted: 0, spotCheck: 0, unknown: 0 };
    const reasons = {};
    for (const r of rows) {
        const d = decisions.get(key(r));
        if (!d || !isQueued(r))
            continue;
        if (d.label !== 0 && d.label !== 1) {
            counts.unknown++;
            continue;
        }
        const ps = Object.values((r.committee ?? {}));
        const mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0.5;
        const why = d.confidence !== 'high' ? 'agent unsure'
            : d.label === 1 && mean < 0.2 ? 'committee says no'
                : d.label === 0 && mean > 0.8 ? 'committee says yes'
                    : d.label === 1 && (positives[r.rule] ?? 0) < RARE_POSITIVES ? 'rare-rule positive'
                        : undefined;
        if (why) {
            // stays pending for a human; the UI shows the suggestion
            Object.assign(r, { agent_label: d.label, agent_note: `${why}: ${d.reason}` });
            counts.spotCheck++;
            reasons[why] = (reasons[why] ?? 0) + 1;
        }
        else {
            Object.assign(r, { label: d.label, reviewer: AGENT, note: d.reason });
            const at = manifest.findIndex((g) => key(g) === key(r));
            const entry = { url: r.url, line: r.line, rule: r.rule, label: d.label, note: d.reason, reviewer: AGENT };
            if (at >= 0)
                manifest[at] = entry;
            else
                manifest.push(entry);
            counts.accepted++;
        }
    }
    writeFileSync(reviewPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(manifestPath, manifest.map((g) => JSON.stringify(g)).join('\n') + '\n');
    console.log(`accepted ${counts.accepted} as gold, ${counts.spotCheck} left for spot-check`, reasons, counts.unknown ? `(${counts.unknown} without a 0/1 label ignored)` : '');
}
