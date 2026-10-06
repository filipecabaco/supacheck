// Regression test: supacheck on examples/demo-app must produce exactly expected-findings.json.
//   pnpm test        (UPDATE=1 pnpm test to accept new output)
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCheck } from './check.js';
const demo = resolve(import.meta.dirname, '../../examples/demo-app');
const expectedPath = join(demo, 'expected-findings.json');
const { findings } = await runCheck(demo);
const actual = findings.map((f) => ({ rule_id: f.rule_id, file: f.file, line: f.line }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule_id.localeCompare(b.rule_id));
if (process.env.UPDATE) {
    writeFileSync(expectedPath, JSON.stringify(actual, null, 1));
    console.log('updated');
    process.exit(0);
}
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
const key = (f) => `${f.rule_id} ${f.file}:${f.line}`;
const missing = expected.map(key).filter((k) => !actual.map(key).includes(k));
const extra = actual.map(key).filter((k) => !expected.map(key).includes(k));
for (const k of missing)
    console.log(`✗ missing  ${k}`);
for (const k of extra)
    console.log(`✗ unexpected ${k}`);
console.log(missing.length || extra.length ? `FAIL (${missing.length} missing, ${extra.length} unexpected)` : `ok: ${actual.length} findings match`);
process.exitCode = missing.length || extra.length ? 1 : 0;
