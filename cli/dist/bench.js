// End-to-end latency through the TS runtime (tokenize + ONNX), on real test samples.
//   pnpm bench <artifact dir> [n]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadModel, score, tokenCount } from './runtime.js';
const dir = process.argv[2];
const n = Number(process.argv[3] ?? 100);
const t0 = performance.now();
const model = await loadModel(dir);
const loadMs = performance.now() - t0;
const rows = readFileSync(join(import.meta.dirname, '../../data/generated/test.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, n);
for (const r of rows.slice(0, 3))
    await score(model, r.state); // warm-up
const times = [];
const tokens = [];
for (const r of rows) {
    const t = performance.now();
    await score(model, r.state);
    times.push(performance.now() - t);
    tokens.push(Math.min(tokenCount(model, r.state), model.meta.max_len));
}
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
console.log(JSON.stringify({ model: dir, load_ms: Math.round(loadMs), samples: rows.length,
    tokens_median: q(tokens, 0.5), tokens_p90: q(tokens, 0.9),
    latency_median_ms: Math.round(q(times, 0.5)), latency_p90_ms: Math.round(q(times, 0.9)) }, null, 2));
