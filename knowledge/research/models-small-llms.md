# Small decoder LLMs as classifiers: an alternative to the Laya encoder

Survey date: 2026-10-05/06. Scope: open-weight decoders of roughly 0.25B–2B parameters used as
**classifiers**, not generators. The score comes from the logprobs of option tokens, a head on
the last hidden state, or a single constrained token. Hard constraints come from PLAN.md §0/§4/§5:
open weights, LoRA on a Mac, offline from a TS CLI, about 1.6 GB or less to download, under
300 ms per chunk on CPU, calibrated probabilities, and a permissive licence.

Legend: **[M]** = measured by us on this machine (Apple M5 Pro, 6P+12E cores, 48 GB,
Homebrew llama.cpp/ggml 0.26.0, Q8_0 GGUF, `llama-bench -n 0`). **[S]** = stated by a source
(linked). **[E]** = our estimate or extrapolation. **[U]** = unverified claim worth checking in the spike.

---

## 1. Headline findings

1. **There is a new "decision model" category built on small decoders.** These models match
   our use case closely and were not on the original list. They are decoders fine-tuned to
   behave like Laya: state plus typed `choice` / `noul` / `score` questions in,
   probabilities out, no generation.
   - `vllm-sr/Decision-2.0-Kai-0.6B` (Apache-2.0). Full fine-tune of Qwen3-0.6B-Base with a
     candidate head over option-token hidden states, 8k context. An official ONNX build
     exists (0.61 GB q8) and it runs in Node through open-jev / ONNX Runtime **[S]**.
   - `Mapika/decider-0.8b` / `decider-2b` (Apache-2.0). Fine-tunes of Qwen3.5-0.8B/2B-Base
     that read out letter logits at an answer slot. ECE is 0.03 in-task and 0.09–0.10 on
     held-out tasks after one fitted temperature (T≈1.03). GGUF builds exist **[S]**.
     *Caveat:* their training data was written by a Qwen3.5-27B teacher, so it is
     open-weight (fine under our rule).
   - llama.cpp gained a native `/v1/systemone` decision endpoint (blog of 2026-10-02) that
     lists Laya (421M), Julia-1 (144M) and others **[S]**. node-llama-cpp 3.22 has
     `createDecisionContext().decide()` with `noul` / `choice` / `score`, which works on
     *any* GGUF via token probabilities **[S]**. This makes the TS runtime story for
     decoders as good as for Laya-ONNX, and possibly better.
2. **Under 300 ms per 1k-token chunk on CPU is not achievable with a decoder of 0.5B or more**,
   even on a 2026 high-end Mac. It is also out of reach for an encoder of Laya's size at 1k
   tokens (see §4). Only models of about 270M or less get close. Plan for 256–512-token
   chunks, a shared-prefix KV cache, Metal when present, and the content-hash cache.
3. **The licence filter removes about half the list.** LFM2/LFM2.5 (LFM 1.0 licence: no
   commercial use above $10M annual revenue) is out for Supabase. So are Llama 3.2 /
   Llama Guard 3 (community licence with naming and attribution terms and an AUP),
   Gemma 3 / ShieldGemma (Gemma Terms of Use with a flow-down prohibited-use policy),
   DeepSeek-Coder (DeepSeek licence with use restrictions), StarCoder2 (OpenRAIL-M use
   restrictions) and OpenCoder ("inf" custom licence). **Clean Apache-2.0/MIT:** Qwen2.5-Coder,
   Qwen3, Qwen3.5, Qwen3Guard, SmolLM2/3, Granite 3.x/4.x and Granite Guardian, Phi-4-mini
   (MIT), **Gemma 4** (Apache-2.0 since 2026-04-02) and the Decision-2.0 / decider fine-tunes.
4. **Calibration is not free with decoders.** Raw label-token probabilities are biased by
   label wording, position and prior. That is the same failure mode PLAN.md §1 lists for
   Laya. Use neutral labels, shuffling and a fitted temperature, the same recipe as for Laya.
   4-bit weight quantization measurably shifts confidence (lower on correct answers, higher
   on wrong ones) **[S]**. 8-bit is close to lossless for argmax but still needs
   re-calibration on the shipped artifact. The Decision-2.0 q8 ONNX differs from fp32 by at
   most 0.017 in any probability **[S]**.

---

## 2. Comparison table

Prefill latency is for **1,024 tokens, batch 1**, Q8_0 via llama.cpp. "CPU" means
`-dev none -ngl 0` with 6 or 12 threads; the best of the two is shown. "Metal" means the
default GPU offload. The M5 Pro is a fast machine: a typical x86 laptop on AVX2 is about
2–5x slower than our CPU column **[E]** (see §4).

| Model | Params (total) | Ctx | Licence | Code ability | GGUF / ONNX | 1k-token prefill, M5 Pro | LoRA on Mac | Notes |
|---|---|---|---|---|---|---|---|---|
| **Decision-2.0-Kai-0.6B** (vllm-sr) | 0.6B (Qwen3-0.6B-Base) | 8k | Apache-2.0 | base Qwen3 (general + code); decision-tuned | ONNX q8 0.61 GB (official, onnx-community) | ≈ Qwen3-0.6B: CPU ~1.8–2.6 s, Metal ~0.33 s **[E from M]** | yes (Qwen3 arch; custom head needs a small training script) **[E]** | Same interface as Laya (`state` + typed questions). JevArena 48.6, ahead of GLiNER2.5-Decide and Decision 1.0 **[S]**. Prompt per question; option positions read from the hidden states. |
| **decider-0.8b** (Mapika) | 0.75B (Qwen3.5-0.8B-Base) | 262k (base) | Apache-2.0 | base Qwen3.5 | GGUF Q8 774 MB / Q4_K_M 504 MB (community); safetensors 1.4 GB | ≈ Qwen3.5-0.8B: CPU ~1.4–1.8 s, Metal ~0.49 s **[M base arch]** | yes (MLX supports Qwen3.5; a 0.8B LoRA at ~267 tok/s is reported **[S]**) | Letter-logit readout. Published ECE 0.032 in-task / 0.096 held-out **[S]**. Hybrid Gated-DeltaNet: slower on CPU, and ONNX/WebGPU support is immature (Qwen3.5-4B TTFT was 20x worse than Qwen3 in transformers.js #1599) **[S]**. |
| Qwen2.5-Coder-0.5B-Instruct | 0.49B | 32k | Apache-2.0 | **best code per param in this class** (code-specific pretraining, 5.5T tokens) | GGUF official; ONNX (onnx-community, q8 609 MB) | CPU **0.75–1.2 s**, Metal **0.23 s** **[M]** | yes, easy (MLX-LM, QLoRA) | Fastest code-aware 0.5B we measured. A plain transformer, so every runtime handles it. 151k vocab (heavy LM head; irrelevant if you score only label tokens or use a head). |
| Qwen2.5-Coder-1.5B-Instruct | 1.54B | 32k | Apache-2.0 | strong | GGUF 1.8 GB Q8 / ~1.0 GB Q4_K_M; ONNX | CPU **~3.9 s** (6 threads), Metal **0.66 s** **[M]** | yes | Over budget on CPU latency. Q8 is over the 1.6 GB budget, Q4 fits. Use as the in-house teacher/judge or the accuracy ceiling. |
| Qwen3-0.6B | 0.6B (0.44B non-emb) | 32k | Apache-2.0 | ok (general with code) | GGUF Q8 609 MB; ONNX (q8 589 MB, plus ORT-GenAI int4) | CPU **1.8–2.6 s**, Metal **0.33 s** **[M]** | yes | 28 layers: measured about 2x slower than Qwen2.5-Coder-0.5B on CPU. Base of Decision-2.0-Kai and Qwen3Guard. |
| Qwen3-1.7B | 2.0B | 32k | Apache-2.0 | good | GGUF / ONNX | ~3–4x the 0.6B **[E]** | yes | Too big for the CPU budget. A teacher candidate. |
| Qwen3.5-0.8B / 2B | 0.87B / 2.27B (incl. vision tower) | 262k | Apache-2.0 | good for size **[U]** | GGUF (unsloth); ONNX (onnx-community, needs 3 graphs) | 0.8B: CPU ~1.4–1.8 s, Metal 0.49 s **[M]** | yes | Hybrid linear attention favours long context, not short-prompt CPU latency. Vision tower is dead weight for us. |
| Gemma 3 270M | 0.27B (~0.1B non-emb) | 32k | **Gemma ToU** (custom, flow-down AUP; gated) | weak | GGUF; ONNX (q8 519 MB, q4 307 MB) | CPU **~0.41 s**, Metal **0.11 s** **[M]** | yes, very cheap | The only decoder near the latency target, but the licence is out and it is too small for nuanced code judgement **[E]**. Google pitches it for fine-tuned narrow classification. |
| Gemma 3 1B | 1.0B | 32k | Gemma ToU | modest | GGUF; ONNX | ~2x Qwen2.5-0.5B **[E]** | yes | Licence out. |
| **Gemma 4 E2B** | 5.1B stored (2.3B effective, PLE) | 128k | **Apache-2.0** | good (LiveCodeBench 44.0 **[S]**) | GGUF (QAT q4_0); ONNX mobile builds | ≥ Qwen3.5-2B **[E]** | possible, heavy | Too large to download (PLE tables). Watch for a smaller Gemma 4 text model. |
| SmolLM2-360M / 1.7B | 0.36B / 1.7B | 8k | Apache-2.0 | weak / modest | GGUF; ONNX (360M official) | 360M ≈ Gemma-270M x1.3 **[E]** | yes | Fully open data (good provenance). Weak on code. |
| SmolLM3-3B | 3.1B | 64k | Apache-2.0 | decent | GGUF; ONNX | too slow | yes | Too big. |
| Llama 3.2 1B | 1.24B | 128k | **Llama 3.2 Community** (700M MAU cap, "Built with Llama", derivative names must start with "Llama", AUP) | modest | GGUF; ONNX | ~1.5x Qwen2.5-0.5B **[E]** | yes | Licence friction. No advantage over Qwen. |
| Phi-4-mini | 3.8B | 128k | MIT | good | GGUF; ONNX | too slow | QLoRA only | Too big (≈2.3 GB at Q4). |
| Granite 4.0 350M / 1B (dense and -H hybrid Mamba) | 0.35B / 1.6B (H-1B 1.46B) | 32k–128k **[U]** | Apache-2.0 | ok (enterprise and code data) | GGUF (official); ONNX-web builds | 350M ≈ SmolLM2-360M **[E]** | yes (MLX builds exist for 4.2) | IBM ships ISO-42001, cryptographically signed weights, a clean provenance story. Granite 4.1/4.2 smallest is 3B. 350M is worth a cheap probe. |
| Granite Guardian 3.2-3B-A800M / 4.1-8B | 3.3B MoE (0.8B active) / 8B | 128k | Apache-2.0 | n/a (risk judge) | GGUF | MoE: active-param compute, but full download **[E]** | heavy | The pattern to copy (§3), not a candidate to ship. |
| Qwen3Guard-Gen-0.6B / Stream-0.6B | 0.75B / 0.6B | 32k | Apache-2.0 | n/a | GGUF (community) | ≈ Qwen3-0.6B | yes | Stream variant: classification heads on token hidden states. Gen variant: generated "Safety: X" label. |
| LFM2 / LFM2.5 (230M–2.6B) | 0.23–2.6B | 32k | **LFM 1.0: commercial use barred at ≥$10M revenue** | ok | GGUF + ONNX + MLX (official) | fast on CPU (hybrid conv) **[S, U]** | yes | Licence disqualifies it for Supabase. |
| DeepSeek-Coder-1.3B | 1.35B | 16k | DeepSeek licence (use restrictions) | good for 2023 | GGUF; ONNX | ~1.5x Qwen2.5-0.5B **[E]** | yes | Superseded by Qwen2.5-Coder. Licence friction. |
| OpenCoder-1.5B | 1.9B | 4k–8k **[U]** | "inf" custom | good | GGUF (community) | ~Qwen2.5-Coder-1.5B | yes | Open data recipe, but custom licence and too big. |
| StarCoder2-3B | 3.0B | 16k | BigCode OpenRAIL-M | good (base only) | GGUF | too slow | QLoRA | Too big. Use restrictions. |
| *Reference:* Laya (ModernBERT-large) | 0.42B | 512 | (upstream) | ModernBERT saw code | ONNX fp32 1.6 GB / fp16 0.8 GB | 512 tok: ~150–300 ms on x86 CPU **[E]**; 1k is not possible (max 512) | yes (LayaStudio MLX) | Encoder baseline. |

Raw [M] throughput (tokens/s, Q8_0, 1,024-token prompt, M5 Pro):

| Model | CPU 6 threads | CPU 12 threads | Metal |
|---|---|---|---|
| gemma-3-270m | noisy | 2,472 | 9,072 |
| qwen2.5-coder-0.5b | 863 | 1,365 | 4,467 |
| qwen3-0.6b | 388 | 555 | 3,146 |
| qwen3.5-0.8b | 568 | 705 | 2,092 |
| qwen2.5-coder-1.5b | 262 | (n/a) | 1,543 |

For reference, the same runs at 512 tokens were 25–40% faster per token. The machine had
background load, so treat CPU figures as ±30%.

---

## 3. How to use a decoder as a classifier (techniques)

**A. Label-token logprob scoring (zero extra parameters).** Prompt: chunk, then question,
then options mapped to single neutral tokens (`A`/`B`/…), then `Answer:`. Read the
next-token logits restricted to the option tokens and softmax them. This is what
decider, Llama Guard (P("unsafe") on the first output token), ShieldGemma (P("Yes")) and
Granite Guardian (Yes/No token probability as the risk score) do.
- node-llama-cpp supports it directly (`createDecisionContext().decide()`, or the low-level
  `evaluateWithMetadata(..., {probabilities: true})`). transformers.js and onnxruntime-node
  return the logits tensor.
- Pitfalls: label-name bias (renaming flips answers, the same failure as Laya
  arXiv 2609.26758), position bias, and multi-token labels. Fix them with neutral
  single-token labels, option shuffling at train time, and contextual / temperature
  calibration.

**B. Head on the last token (`AutoModelForSequenceClassification`).** HF provides it for
Qwen2/3, Llama, Gemma and Granite. It pools the last non-pad token (set `pad_token_id`). One
head per rule, or one multi-label head over all ~17 questions. That gives 17 answers from
one prefill, which is the decoder equivalent of Laya's multi-question pass. Studies find
fine-tuned decoders with a head match or slightly beat BERT-class encoders, mostly through
size (arXiv 2512.12677, 2507.10468). The controlled Ettin study (ICLR 2026) finds encoders
better at classification at equal size **[S]**. ONNX export is trivial (no KV cache needed).
- Decision-2.0 is a variant of this: a candidate head over the hidden states at each
  option's last token. It handles arbitrary option sets without retraining the head.

**C. Constrained single-token generation.** Equivalent to A at the first step. Generation
adds cost without adding information, so skip it, except for the **optional short
explanation**. A decoder (unlike Laya) can generate 1–2 sentences after the label on demand
(`--explain`). At about 50–150 tok/s on a 0.5B (CPU/Metal **[E]**) that costs 0.3–1 s extra
per finding, acceptable for fired rules only.

**Prefix caching (decoder-specific win).** Put the chunk first and the questions last.
Causal attention means the chunk's KV cache can be reused across all questions about that
chunk, so each extra question costs only its ~30–60 suffix tokens **[E]**. With a
multi-label head (B) it is a single pass anyway. An encoder must re-encode chunk and
questions together. Laya does answer several questions in one pass, but within 512 tokens
total.

**Calibration.** Hold out a calibration slice and fit a per-question-type temperature
*on the quantized artifact you ship*. Evidence: 4-bit GPTQ/BNB increases ECE (models become
under-confident on correct answers and over-confident on wrong ones) and this is
recoverable post hoc (Proskurina et al. NAACL-Findings 2024; "Quantized Can Still Be
Calibrated", ACL 2025). One study finds little change at 4/8-bit (arXiv 2508.16785) **[S]**.
decider reports ECE 0.03 in-task with one temperature **[S]**. For ONNX Runtime on CPU,
note that **int4 (MatMulNBits) prefill is about 2.5–3x slower than fp32, while int8 runs at
roughly fp32 speed** (EdgeLLM measurements on Qwen2.5-0.5B) **[S]**. So q4 buys download
size, not prefill speed, on ORT CPU. llama.cpp Q4/Q8 kernels behave differently (Q8 was not
slower than Q4 for prefill in our Metal run: Qwen3.5-0.8B 2,092 vs 1,982 t/s **[M]**).

**LoRA / QLoRA on a Mac.** MLX-LM supports Qwen2/2.5/3/3.5, Llama, Gemma, Granite and Phi
(`mlx_lm.lora`, automatic QLoRA on quantized bases, `--mask-prompt` so loss falls only on
the label). Reported speeds:
- Qwen2.5-0.5B-4bit at about 12 it/s on an 8 GB M2.
- Qwen2.5-1.5B-4bit at 1.8 it/s on 645-token rows.
- Qwen3.5-0.8B LoRA at about 267 tok/s **[S]**.

A head (approach B) is not in MLX-LM out of the box. Use PyTorch MPS + PEFT
(`AutoModelForSequenceClassification` + LoRA), or a short custom MLX script. LayaStudio
already did the latter for Laya **[E]**. Scoring approach A trains with plain causal-LM SFT
on the label token, fully supported. Expect minutes per 1k rows at 0.5B, comparable to
LayaStudio's ~12 min/1k rows for Laya-large **[E]**.

**Distillation from an open-weight teacher.** Qwen2.5-Coder-7B/32B, Qwen3/3.5-27B, Qwen3.8,
Gemma 4 31B and Granite 4.2 are all Apache-2.0. Run the teacher locally (MLX / llama.cpp)
with option-logprob scoring to get **soft targets**, then train the student on KL to the
teacher distribution plus hard programmatic labels. Keep the same-family tokenizer (a Qwen
teacher with a Qwen student) to allow token-level distillation if wanted. PLAN.md's caveats
on teacher-label share still apply (arXiv 2504.15432).

**Code-review / vuln-classification evidence at small scale is thin.** Fine-tuned
Qwen2.5-Coder-32B reaches only ~0.60 F1 on PrimeVul (LLMxCPG, USENIX Sec '25) **[S]**. No
credible 0.5–1.5B vuln-classifier results were found. Our questions are narrower and more
local than generic vuln detection ("is `getSession()` used for access?"), so the spike data
is the only real evidence. Treat any claimed advantage of code-pretrained decoders as
**[U]** until the bake-off.

---

## 4. Trade-offs vs the encoder (Laya) approach

| Dimension | Encoder (Laya, ModernBERT-large 421M) | Small decoder (0.5–0.8B) |
|---|---|---|
| **Compute per token** | About 0.35B non-embedding params, so roughly the same FLOPs per token as a 0.5B decoder. mmBERT-base (~0.1B non-emb) ONNX fp32 on x86 CPU: 120 ms @512, 263 ms @1024 **[S]**. Laya-large is then ~3x that: ~0.35 s @512 **[E]**. | Qwen2.5-Coder-0.5B on M5 Pro CPU: ~0.4 s @512, 0.75–1.2 s @1024 **[M]**. On x86 AVX2, a TinyLlama-1.1B Q8 prefills at 144–406 t/s (Skylake/Alder Lake) **[S]**, so a 0.5B decoder takes ~1.5–3.5 s per 1k tokens **[E]**. |
| **Context** | 512 (1,024 for typed-decisions): forces fine chunking | 8k–32k: can include the imported helper, the policy *and* the table DDL. That helps cross-file questions (`write-policy-missing-ownership-check`, `admin-client-for-user-scoped-work`). Cost grows linearly or worse. |
| **Size on disk** | 1.6 GB fp32 (fp16 0.8 GB; INT8 hurts calibration per upstream #790) | 0.5–0.8 GB at Q8 for 0.5–0.8B; ~0.3–0.5 GB at Q4 |
| **Accuracy on nuanced code judgement** | Bidirectional attention suits classification at equal size (Ettin) **[S]**. Zero-shot near chance on domain decisions. | More code knowledge (Qwen2.5-Coder trained on 5.5T tokens incl. code) and instruction priors. Zero-shot is usable as a weak baseline. Equal-size accuracy after fine-tuning is **[U]**: the bake-off's main question. |
| **Calibration** | Laya ships temperatures; INT8 ONNX damages them | Needs temperature fitting. Q8 safe-ish, Q4 shifts confidence. Decision-tuned variants (decider, Decision-2.0) report good ECE **[S]**. |
| **Multi-question cost** | One pass for all questions (within 512 tokens) | One pass with a multi-label head, or a cached prefix plus a cheap suffix per question |
| **Explanation** | None (canned rule message only) | An optional 1–2 sentence explanation from the same weights |
| **Training on a Mac** | Proven (LayaStudio MLX, head-only minutes) | Proven for LM-SFT/LoRA (MLX-LM). A head needs PEFT/MPS or custom MLX. |
| **TS runtime** | onnxruntime-node / laya-ts; also llama.cpp `/v1/systemone` now | onnxruntime-node or transformers.js (plain transformers only; hybrids immature); **node-llama-cpp** (GGUF, Metal/CPU, logprobs and `decide()`); wllama (WASM, CPU only, slower **[E]**) |

**Net:** a decoder trades ~2–3x CPU latency at equal chunk length for more context, code
priors, a smaller download and an optional explanation. Neither family meets "<300 ms per
1k tokens on CPU" at useful quality. The runtime design should assume:
- ~256–512-token chunks;
- Metal or GPU when available (0.23 s per 1k tokens for a 0.5B on an M5 Pro **[M]**);
- the daemon keeping the model resident;
- the per-chunk content-hash cache plus `--diff`, so a typical run scores tens of chunks,
  not thousands.

---

## 5. Ranked shortlist for the spike bake-off

All three are Apache-2.0, under 1 GB at Q8, MLX-trainable, and runnable from Node. Run them
against the encoder baselines (`laya`, `laya-typed-decisions`) on the same 8 rules, the same
gold set and the same CPU/Metal latency harness, all at ≤512-token chunks.

1. **Decision-2.0-Kai-0.6B** (Qwen3-0.6B-Base). Closest drop-in for Laya's interface
   (typed questions, per-option probabilities, 8k context), with an official ONNX q8 build
   validated against fp32 (max Δp 0.017). Compare Laya vs Kai fine-tuned on identical data.
   Risks:
   - the training code for the custom head is less mature than LayaStudio (check the
     vllm-sr repo for fine-tune scripts **[U]**);
   - prompt-per-question cost (mitigate with prefix caching);
   - CPU latency about 2x Qwen2.5-Coder-0.5B **[M]**.
2. **Qwen2.5-Coder-0.5B-Instruct + LoRA**, in two variants: (a) label-token scoring via
   MLX-LM SFT, and (b) a multi-label `SequenceClassification` head via PEFT. It is the
   fastest code-pretrained decoder we measured (CPU 0.75–1.2 s, Metal 0.23 s per 1k
   tokens), uses a plain transformer that every runtime supports (GGUF, ONNX), and has the
   strongest code prior per parameter. It also tests whether code pretraining beats
   decision pretraining.
3. **decider-0.8b** (Qwen3.5-0.8B-Base). The best published calibration story in this class
   (ECE 0.03 in-task) and a newer base, with GGUF runnable through node-llama-cpp.
   Risks: the hybrid DeltaNet architecture is slower on CPU (0.8B: 1.4–1.8 s per 1k tokens
   **[M]**), and ONNX support is immature. Include it only if node-llama-cpp is acceptable
   as the runtime.

Cheap optional probes (an afternoon each): **Granite 4.0-350M** (Apache-2.0, signed
weights, about half the latency of the 0.5B) to see how small a decoder can go. Use
**Qwen2.5-Coder-7B / Qwen3.5-27B** locally only as the teacher and accuracy ceiling, never
shipped.

Excluded on licence: LFM2/2.5, Gemma 3 family (incl. ShieldGemma), Llama 3.2 / Llama Guard,
DeepSeek-Coder, StarCoder2, OpenCoder. Excluded on size: Phi-4-mini, SmolLM3-3B,
StarCoder2-3B, Gemma 4 E2B (5.1B stored), Granite ≥3B, Granite Guardian.

---

## 6. Open questions for the spike

- Does fine-tuned Kai-0.6B or Qwen2.5-Coder-0.5B beat fine-tuned Laya on the 8 rules at
  precision ≥0.9? This is the decisive measurement. Nothing published answers it for code.
- Measure on a real x86 laptop: onnxruntime-node q8 versus node-llama-cpp Q8 CPU, at 256,
  512 and 1,024 tokens.
- ECE before and after temperature scaling, for fp16 versus q8 versus q4, per model.
- Is a multi-label head over all rules (one pass) as accurate as per-question prompting?

## Sources

- Decision-2.0-Kai-0.6B card: https://huggingface.co/vllm-sr/Decision-2.0-Kai-0.6B ; ONNX: https://huggingface.co/onnx-community/Decision-2.0-Kai-0.6B-ONNX
- decider-0.8b card: https://huggingface.co/Mapika/decider-0.8b ; code: https://github.com/Mapika/decider
- llama.cpp decision models blog (2026-10-02): https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp
- node-llama-cpp structured decisions: https://node-llama-cpp.withcat.ai/guide/structured-decisions ; low-level probabilities: https://node-llama-cpp.withcat.ai/guide/low-level-api
- HF model API (licences, params): `https://huggingface.co/api/models/<id>` for every model in the table (queried 2026-10-05)
- LFM 1.0 licence ($10M threshold): https://huggingface.co/LiquidAI/LFM2.5-350M/blob/main/LICENSE
- Gemma 4 Apache-2.0: https://venturebeat.com/technology/google-releases-gemma-4-under-apache-2-0-and-that-license-change-may-matter ; model card: https://ai.google.dev/gemma/docs/core/model_card_4
- Qwen3.5 small models / hybrid architecture: https://huggingface.co/Qwen/Qwen3.5-0.8B ; transformers.js perf issue: https://github.com/huggingface/transformers.js/issues/1599
- Qwen3Guard: https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B
- llama.cpp Apple Silicon results: https://github.com/ggml-org/llama.cpp/discussions/4167
- x86 CPU prefill (TinyLlama 1.1B Q8): https://justine.lol/matmul/ ; llamafile CPU thread: https://github.com/mozilla-ai/llamafile/discussions/450
- mmBERT CPU ONNX latency: https://arxiv.org/html/2603.12646v1
- ORT int4 vs int8 prefill: https://github.com/vijay-kapse/EdgeLLM
- Quantization and calibration: https://arxiv.org/pdf/2405.00632 ; https://aclanthology.org/2025.acl-long.1473.pdf ; https://arxiv.org/pdf/2508.16785
- Decoder vs encoder classification: https://arxiv.org/html/2512.12677v1 ; https://arxiv.org/html/2507.10468v1 ; https://arxiv.org/pdf/2507.11412 (Ettin)
- Vuln detection at scale: https://www.usenix.org/system/files/usenixsecurity25-lekssays.pdf
- MLX-LM LoRA: https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md ; https://github.com/Dolmaa24/mlxtuner ; https://github.com/sciences44/mlx-lora-finetune
