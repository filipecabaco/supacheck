// Human review of teacher pre-labels (data/gold/review.jsonl). Shows the chunk, the rule question
// and the teacher probability; y/n records a label, s skips, q quits. Confirmed rows are appended
// to data/gold/manifest.jsonl. Code is fetched at its pinned commit into the git-ignored cache.
//
//   pnpm tsx src/review.ts [--rule <id>]
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parse } from 'yaml';
import { fetchChunk } from './gold.js';
const root = resolve(import.meta.dirname, '../..');
const reviewPath = join(root, 'data/gold/review.jsonl');
const onlyRule = process.argv.includes('--rule') ? process.argv[process.argv.indexOf('--rule') + 1] : undefined;
const rows = readFileSync(reviewPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cacheDir = join(root, 'data/gold/cache');
mkdirSync(cacheDir, { recursive: true });
const reviewer = process.env.USER ?? 'human';
const argAnswer = process.argv.includes('--answer') ? process.argv[process.argv.indexOf('--answer') + 1] : undefined;
const argNote = process.argv.includes('--note') ? process.argv[process.argv.indexOf('--note') + 1] : '';
// Without a TTY (e.g. Claude Code's `!`), show one item per run; record it with --answer y|n|s.
const interactive = stdin.isTTY && !argAnswer;
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : undefined;
const pending = rows.filter((r) => r.label === null && r.note !== 'skipped' && (!onlyRule || r.rule === onlyRule));
console.log(`${pending.length} pending of ${rows.length}`);
for (const [i, row] of pending.entries()) {
    const question = parse(readFileSync(join(root, 'rules', `${row.rule}.yaml`), 'utf8')).question;
    const chunk = await fetchChunk(row.url, row.line, cacheDir);
    console.clear();
    console.log(`[${i + 1}/${pending.length}] ${row.rule}   teacher p=${row.teacher_p.toFixed(3)}\n${row.url}#L${row.line}\n`);
    console.log(chunk ?? '(could not locate chunk)');
    console.log(`\nQ: ${question.instructions}\n  yes: ${question.criteria.true}\n  no:  ${question.criteria.false}`);
    if (!interactive && !argAnswer) {
        console.log(`\nrecord with: pnpm tsx src/review.ts --answer y|n|s [--note "..."]${onlyRule ? ` --rule ${onlyRule}` : ''}`);
        break;
    }
    const answer = interactive ? (await rl.question('\n[y]es / [n]o / [s]kip / [q]uit > ')).trim().toLowerCase() : argAnswer;
    if (answer === 'q')
        break;
    if (answer !== 'y' && answer !== 'n') {
        if (interactive)
            continue;
        row.note = 'skipped';
        save();
        break;
    }
    row.label = answer === 'y' ? 1 : 0;
    row.reviewer = reviewer;
    row.note = interactive ? (await rl.question('note (optional) > ')).trim() : argNote;
    save();
    appendFileSync(join(root, 'data/gold/manifest.jsonl'), JSON.stringify({
        url: row.url, line: row.line, rule: row.rule, label: row.label,
        note: row.note || `reviewed (teacher p=${row.teacher_p.toFixed(2)})`, reviewer,
    }) + '\n');
    if (!interactive)
        break;
}
rl?.close();
function save() {
    writeFileSync(reviewPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
