# Cloudflare Clef / Clef-flash: fit for supacheck

Researched 2026-10-05. Models released 2026-10-01 (HF repos created 2026-09-30).
Legend: **[V]** verified from a primary source (HF API/files, Cloudflare blog/docs, GitHub);
**[R]** reported by a secondary source; **[E]** our own estimate, not measured.

## TL;DR

Clef is a typed-decision model with the same contract as Laya (state + `noul`/`choice`/`score`
questions in, a probability per option out, one forward pass), but it is a **9B / 27B decoder
LLM backbone** (Qwen3.5-9B / Qwen3.8-27B) with a joint schema head, not a 400M encoder. The
licence (Apache-2.0) and open weights are fine. Size and CPU latency rule it out as the model
we ship: Clef-flash is ~19 GB bf16 and ~4.2-6 GB even at Q2-Q4 GGUF. CPU latency per chunk
will be seconds, not milliseconds. **Do not ship it in place of Laya.** It is still useful as
a **local open-weight teacher** for labelling data, and its architecture is a **distillation
target**: a third party has already distilled Clef-flash into a 0.8B Qwen3.5 backbone.

## Sources

- Blog: https://blog.cloudflare.com/clef-decision-models ("Introducing Clef: our open-source
  decision models, and new RL fine-tuning platform") [V]
- HF: https://huggingface.co/Cloudflare/clef, https://huggingface.co/Cloudflare/clef-flash [V]
- Workers AI docs: https://developers.cloudflare.com/workers-ai/models/clef/ and `/clef-flash/` [V]
- Decision Index leaderboard: https://clef-evals.workers-ai-mle.workers.dev (linked from model card; not fetched)
- RL interest form: https://www.cloudflare.com/resource/clef-rl-interest/
- llama.cpp support: https://github.com/ggml-org/llama.cpp/pull/29831 (merged 2026-10-03, text-only) [V]
- Independent review: https://flaviocopes.com/clef/ [R]; DataNorth news [R]
- Community conversions: `ollaya-dev/clef` (ONNX), `FluidInference/clef-vision-0.8b-coreml`
  (0.8B distillation), `bartowski/Cloudflare_clef-flash-GGUF`, `ggml-org/Clef-Flash-GGUF`, MLX 4/8-bit [V]
- No paper found. There is no Cloudflare GitHub repo with training code. The only code
  released is the inference file `joint_schema_model.py` in the HF repos [V].

## Facts

| | Clef | Clef-flash |
|---|---|---|
| Base model | Qwen/Qwen3.8-27B [V] | Qwen/Qwen3.5-9B (hybrid: 3 Gated-DeltaNet linear-attention layers to 1 full-attention layer, 32 layers, hidden 4096, vocab 248k) [V] |
| Params (backbone, BF16) | 27.36 B [V] | 9.41 B [V] |
| Joint head | `joint_head.safetensors` 256 MB [V] | 244 MB. Width 1024, 2 routing layers + 4 transformer layers, 16 heads [V] |
| Download (bf16 safetensors) | ~55 GB [V] | ~19 GB [V] |
| Smallest community quant | GGUF exists | Q2_K 4.19 GB, Q4_K_M 6.04 GB, Q8_0 9.68 GB (+0.92 GB mmproj for vision) [V] |
| Context | 64k on Workers AI (65,536) [V]. HF reference code defaults to `max_length=16384` [V] | same |
| Modalities | text, JSON, images, video (vision encoder kept) [V] | same |
| Licence | **Apache-2.0** (LICENSE file in repo; follows Qwen base) [V] | same |
| Weights | Public, not gated, safetensors + custom code (`trust`-style import of `joint_schema_model.py`) [V] | same |
| Workers AI id | `@cf/cloudflare/clef` [V] | `@cf/cloudflare/clef-flash` [V] |
| Hosted price | $0.24 / M input tokens [V] | $0.09 / M input tokens [V] |
| Hosted latency (Cloudflare) | median 209 ms, p95 239 ms [V] | median 39 ms, p95 122 ms [V] (GPU at the edge) |
| Hosted latency (independent, incl. network) | median 524-726 ms [R] | median 191-205 ms [R] |

### Architecture and I/O
- Non-autoregressive, prefill-only. The backbone's final hidden states feed a "joint schema
  head" that mean-pools the question and option token spans. A two-stage "evidence routing"
  attention pulls evidence from the state into each question, then the head scores every
  option of every question jointly. Output is one logit per option, with a softmax per
  question [V: model card + code].
- Schema: `state` (string or JSON), `questions` map. Types are `noul` (true/false; optional
  criteria for each side), `choice` (option-id to description map) and `score` (ordered list
  of descriptions). `instructions` is optional. 1-64 questions per request; question ids are at
  most 100 characters [V].
- **"Fully compatible with Jev and SystemOne"** (the TypeSafe `POST /v1/systemone` API). It
  returns `choice`/`confidence`/`probabilities`, `score` + `legend`, and `noul` = P(true) [V].
  This is the same typed-question family Laya uses. Our rule questions port unchanged.

### Training and calibration (as claimed)
- Backbone frozen. Routing head trained jointly with **rank-256 LoRA** adapters [V: blog].
- Loss: label-smoothed CE plus a **Brier loss "to refine probability calibration"**. Then RL,
  which they call "RLCD" (Reinforcement Learning for Calibrated Decisions): it rewards fully
  correct records and adds a reference penalty against drift [V: blog]. RLCD has the same name
  as Laya's objective. Our plan already found RLCD gave no gain for Laya (upstream #741).
- **No ECE or reliability numbers are published.** The only calibration-type metric is the
  ForecastBench Brier score (flash 10.6, Clef 13.9, Jev 17.4, Laya 41.1) [V]. Calibration is
  therefore **unverified** for our domain.
- `ollaya-dev/clef` ships a `calibration.json` with temperatures for flash [V], so
  post-hoc temperature scaling is expected.

### Benchmarks (Cloudflare's own run of Decision Index 0.2.1) [V, self-reported]
- Clef and flash lead most of the 41 rows against Jev, DiffusionGemma Jev, Kev 9B and Laya.
  Code-relevant rows: CRUXEval Clef 86.7, flash 86.1, Jev 73.0, **Laya 40.2**. BFCL: flash
  98.8 vs Laya 38.1.
- Laya scores near chance on almost everything (CLINC 3.2, BANKING77 14.3). That matches our
  own note that **zero-shot Laya is near chance and fine-tuning is the project**. The table
  compares zero-shot runs, so it says nothing about a fine-tuned 400M encoder on a narrow task.
- Laya median latency is 5.8 ms (on GPU), against 38.8 ms for flash.
- Workflow evals (Typesafe): Clef roughly equals Jev, within a few points either way.

### Fine-tuning
- **Cloudflare RL platform: hosted only, not self-serve yet.** For now it is a hands-on
  service with forward-deployed engineers (the interest form). A planned self-serve version
  would chain AI Gateway logs into a dataset, Workers AI rollouts, Containers as the RL
  sandbox, and a new "Trainer" that redeploys onto Workers AI [V: blog]. No data format is
  published. Output stays on Cloudflare. This conflicts with our offline / own-weights
  constraint.
- **Doing it ourselves offline: technically possible, but no recipe is released.** The weights
  are Apache-2.0 and the head architecture is in `joint_schema_model.py`. There is no training
  script, no loss code and no data loader, so we would write the loss (CE + Brier) and a LoRA
  setup ourselves [V: file inspection]. The reference was tested on a single H200 [V]. A LoRA
  on a 9B model needs a 24-48 GB GPU, or an M-series Mac with 64 GB+ under MLX [E]. Either way
  it is far heavier than Laya's minutes-on-a-laptop loop.
- Proof of concept for distillation: `FluidInference/clef-vision-0.8b-coreml` distilled
  Clef-flash into Qwen3.5-0.8B with a copy of the joint head. It reached 92.2% gold accuracy
  against the teacher's 94.1% on its (vision) task, with KL 0.095 [V: model card]. Its
  artifacts total ~2.1 GB fp16/fp32 (LM ~960 MB per length bucket + 264 MB head + 508 MB
  embeddings + 377 MB vision tower, which we would drop) [V].

### Running locally from Node/TS
- **ONNX: exists.** `ollaya-dev/clef` provides an fp32 ONNX graph for flash. Its weights
  point by byte offset at the upstream 19 GB bf16 shards, and a Rust runtime matches the
  reference to within 6e-6 in probability [V]. A JS port would need our own span/record
  encoding (`decision.json` describes the layout). onnxruntime-node support for the Gated
  DeltaNet ops in this graph is **unverified**.
- **llama.cpp: supported** (text-only) through `llama-server`'s `/v1/systemone` endpoint and
  a new `llama_batch_ext_set_decision_order` API [V]. From Node this means spawning
  `llama-server`. node-llama-cpp exposing the new batch API is **unverified**.
- Tokenizer: Qwen BPE `tokenizer.json` (20 MB), loadable by `@huggingface/tokenizers` /
  transformers.js [E: standard format].
- transformers.js: `onnx-community/Qwen3.5-0.8B-ONNX` exists, so the Qwen3.5 architecture
  exports and runs [V for existence]. Nothing exists for 9B with the head.
- **CPU latency [E, unmeasured]:** 9.4B params at ~2 FLOPs per param per token, over a
  500-1000-token chunk, is roughly 10-20 TFLOP per chunk. That means multiple seconds to tens
  of seconds on a laptop CPU, and about 0.5-2 s on Apple-silicon GPU via Metal/MLX at Q4.
  Our budget is under 300 ms.

## Verdict against the hard constraints

| Constraint | Clef-flash (9B) | Clef (27B) | Distilled ~0.8B Clef-style student (does not exist for text/code yet) |
|---|---|---|---|
| Open weights we can fine-tune ourselves | **Met**: Apache-2.0 safetensors. No training code, so we write it [V] | Met (same caveat) | Met if we build it (Qwen3.5-0.8B is Apache-2.0) |
| Fully local from TS CLI, offline after download | **Partly met**: ONNX and llama.cpp paths exist. Node path is via a llama-server subprocess, or an unverified ORT port | Same, heavier | Likely: ONNX export of Qwen3.5-0.8B exists [E] |
| Download ≤ ~1.6 GB | **Not met**: 19 GB bf16, 4.2 GB at Q2_K | **Not met**: 55 GB | **Borderline**: ~1.6 GB fp16 backbone + ~0.25 GB head. INT8 would fit, but Laya's #790 calibration damage applies [E] |
| CPU latency < 300 ms per chunk | **Not met** [E: seconds] | **Not met** | Unknown. ~2x Laya's params, decoder prefill. Probably 150-500 ms on CPU [E] |
| Calibrated probabilities | **Unknown**: Brier-trained and RL-calibrated (claimed), but no ECE published. Verify on our gold set | Unknown | Unknown (needs our own temperature scaling either way) |
| Licence OK for commercial/OSS | **Met**: Apache-2.0 (Qwen base Apache-2.0) [V] | **Met** [V] (Qwen3.8-27B licence not independently checked) | Met |

## How it slots into our plan vs Laya

1. **Runtime model: keep Laya** (ModernBERT-large, ~1.6 GB fp32, ms latency, laptop
   fine-tuning). Clef-flash breaks the size and latency budgets by more than an order of
   magnitude.
2. **Teacher for labelling (strong fit).** Plan §0 already requires an *open-weight,
   Apache-2.0 teacher run locally* for LLM labels. Clef-flash is exactly that. It speaks our
   rule-question schema natively, and it returns **soft probabilities per option** directly,
   with no k-sample voting. That gives soft targets for Laya distillation cheaply. It runs on
   a 32 GB+ Mac via MLX 4/8-bit or llama.cpp `/v1/systemone`. Caveats: no code-specific
   training is claimed, and its labels go in the lowest-trust tier (§4 data rank 3).
3. **Baseline in the evaluation gate.** Add zero-shot Clef-flash next to "zero-shot Laya" and
   "small hosted LLM" (§4 evaluation gate). If fine-tuned Laya can't beat zero-shot Clef-flash
   on our gold set, that is a signal. Clef-flash is cheap to run hosted for eval: $0.09 per M
   tokens.
4. **Plan B if Laya plateaus.** Distil Clef-flash, or LoRA-tune it on our data first, into a
   Qwen3.5-0.8B backbone + joint head, as FluidInference did. This is a real research project:
   we write the training loop, and the latency, the ~1.8 GB download and the calibration
   after quantization are all unknown. Spike it only if Laya fails the precision ≥ 0.9 gate on
   several rules. Other options: Qwen3.5-0.8B → unlikely under 300 ms on CPU for long chunks;
   needs measurement.
5. **Do not use the Cloudflare RL platform.** It is hosted only (FDE-led), the weights stay on
   Workers AI, and no data format is published. It conflicts with the local-first,
   own-weights decision.

## Open questions / to verify
- Real ECE of Clef-flash on our gold set, before and after temperature scaling.
- Measured local latency of Clef-flash Q4 (llama.cpp, Metal) on a ~800-token code chunk.
- Whether onnxruntime-node runs the `ollaya-dev/clef` graph (linear-attention ops).
- Qwen3.8-27B licence text (assumed Apache-2.0 from the Clef card).
- Whether the `/v1/systemone` endpoint in llama.cpp has been released (merged 2026-10-03).
