// Add the inference-time "Facts:" line to generated SQL samples by running the real fact store on
// each sample (as a one-file migration), so the model trains on exactly what the CLI will show it.
// TS samples carry template-provided facts already. Idempotent.
//   pnpm tsx src/annotate-facts.ts [../data/generated]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseSql } from 'libpg-query';
import { existsSync } from 'node:fs';
import { buildFacts } from './facts.js';
import { buildTsFacts, factsFor } from './tsfacts.js';
import { sqlFactLines } from './checks.js';
import { withFacts } from './chunks.js';
const sqlCache = new Map(), tsCache = new Map();
const dir = process.argv[2] ?? resolve(import.meta.dirname, '../../data/generated');
const tmp = mkdtempSync(join(tmpdir(), 'supacheck-facts-'));
const file = 'supabase/migrations/0001_sample.sql';
mkdirSync(join(tmp, 'supabase/migrations'), { recursive: true });
for (const name of ['train.jsonl', 'val.jsonl', 'test.jsonl', 'teacher_train.jsonl']) {
    let rows;
    try {
        rows = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
    catch {
        continue;
    }
    let annotated = 0;
    for (const r of rows) {
        const [head, ...rest] = r.state.split('\n---\n');
        const header = head.split('\n').filter((l) => !l.startsWith('Facts: ')).join('\n');
        const code = rest.join('\n---\n');
        r.state = `${header}\n---\n${code}`;
        // real-code rows (teacher labels): facts from the actual repo clone, exactly as the CLI computes them
        if (r.url && process.env.CORPUS) {
            const facts = await repoFacts(r.url, r.line, r.state);
            r.state = withFacts(r.state, facts);
            if (facts.length)
                annotated++;
            continue;
        }
        if (!header.startsWith('Language: SQL'))
            continue;
        writeFileSync(join(tmp, file), code);
        const target = await lastStatementLine(code);
        if (!target)
            continue;
        const facts = sqlFactLines(await buildFacts(tmp), file, target);
        r.state = withFacts(r.state, facts);
        annotated++;
    }
    writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${name}: ${annotated} SQL samples annotated`);
}
rmSync(tmp, { recursive: true, force: true });
/** Line of the last policy/function statement: the chunk the CLI would score. */
async function lastStatementLine(code) {
    let tree;
    try {
        tree = await parseSql(code);
    }
    catch {
        return undefined;
    }
    const bytes = Buffer.from(code, 'utf8');
    let line;
    for (const s of tree.stmts ?? []) {
        const type = Object.keys(s.stmt)[0];
        if (type !== 'CreatePolicyStmt' && type !== 'CreateFunctionStmt')
            continue;
        const start = s.stmt_location ?? 0;
        const raw = bytes.subarray(start, s.stmt_len ? start + s.stmt_len : bytes.length).toString('utf8');
        line = bytes.subarray(0, start).toString('utf8').split('\n').length + raw.slice(0, raw.length - raw.trimStart().length).split('\n').length - 1;
    }
    return line;
}
async function repoFacts(url, line, state) {
    const m = /github\.com\/([^/]+)\/([^/]+)\/blob\/[0-9a-f]+\/(.+)$/.exec(url);
    const repoDir = m && join(process.env.CORPUS, `${m[1]}__${m[2]}`);
    if (!repoDir || !existsSync(repoDir))
        return [];
    const file = decodeURIComponent(m[3]);
    if (file.endsWith('.sql')) {
        if (!sqlCache.has(repoDir))
            sqlCache.set(repoDir, await buildFacts(repoDir));
        return sqlFactLines(sqlCache.get(repoDir), file, line);
    }
    if (!tsCache.has(repoDir))
        tsCache.set(repoDir, buildTsFacts(repoDir));
    return factsFor(tsCache.get(repoDir), file, state);
}
