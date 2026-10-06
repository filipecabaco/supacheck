import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { AutoTokenizer } from '@huggingface/transformers';
export async function loadModel(artifactDir) {
    const meta = JSON.parse(readFileSync(join(artifactDir, 'supacheck.json'), 'utf8'));
    const tokenizer = await AutoTokenizer.from_pretrained(artifactDir, { local_files_only: true });
    const session = await ort.InferenceSession.create(join(artifactDir, 'model.onnx'), {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
    });
    return { meta, tokenizer, session };
}
/** Calibrated probability per rule for one state (temperatures are baked into the graph). */
export async function score(model, state) {
    const enc = model.tokenizer(state, { truncation: true, max_length: model.meta.max_len });
    const ids = toInt64(enc.input_ids);
    const mask = toInt64(enc.attention_mask);
    const dims = [1, ids.length];
    const out = await model.session.run({
        input_ids: new ort.Tensor('int64', ids, dims),
        attention_mask: new ort.Tensor('int64', mask, dims),
    });
    const probs = out.probs.data;
    return Object.fromEntries(model.meta.rules.map((rule, i) => [rule, probs[i]]));
}
export function tokenCount(model, text) {
    return model.tokenizer(text, { truncation: false }).input_ids.size;
}
function toInt64(t) {
    return BigInt64Array.from(Array.from(t.data, (v) => BigInt(v)));
}
