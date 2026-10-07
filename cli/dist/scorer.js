// One interface over the two model kinds a release can ship:
//   laya  - typed-decision model (encoder.onnx + head.onnx, run by vendored laya-ts); asks each rule's question
//   heads - shared encoder + per-rule heads (model.onnx)
// supacheck.json in the model dir says which rules the model judges and at what thresholds.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
const RUNTIME_HINT = 'model rules need onnxruntime-node (npm i onnxruntime-node)';
export async function loadScorer(dir, rulesDir) {
    const meta = JSON.parse(readFileSync(join(dir, 'supacheck.json'), 'utf8'));
    if (existsSync(join(dir, 'encoder.onnx')) && existsSync(join(dir, 'head.onnx'))) {
        const { Agent } = await import('./vendor/laya-ts/index.js');
        const agent = await Agent.load(dir).catch((e) => {
            throw /onnxruntime-node/.test(e.message) ? new Error(RUNTIME_HINT) : e;
        });
        const questions = {};
        for (const rule of meta.rules)
            questions[rule] = parse(readFileSync(join(rulesDir, `${rule}.yaml`), 'utf8')).question;
        return {
            kind: 'laya', rules: meta.rules, thresholds: meta.thresholds ?? {},
            async scoreBatch(states, rules) {
                const out = await agent.predictBatch(states, Object.fromEntries(rules.map((r) => [r, questions[r]])));
                return out.map((o) => Object.fromEntries(rules.map((r) => [r, Number(o.answers[r].noul)])));
            },
        };
    }
    const { loadModel, score } = await import('./runtime.js').catch(() => {
        throw new Error('heads models need: npm i onnxruntime-node @huggingface/transformers');
    });
    const model = await loadModel(dir);
    return {
        kind: 'heads', rules: meta.rules, thresholds: meta.thresholds ?? {},
        async scoreBatch(states) {
            const out = [];
            for (const s of states)
                out.push(await score(model, s));
            return out;
        },
    };
}
