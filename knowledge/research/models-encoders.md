# Encoder / non-generative alternatives to Laya

Date: 2026-10-06. Scope: encoder-only and other non-generative models that could replace or
challenge Laya in the semantic layer (the 17 questions in [README.md](README.md#where-laya-is-actually-needed)).
Cloudflare Clef is out of scope here (covered separately). Generative LLMs are out of scope.

Hard constraints (from the brief and [PLAN.md](../../PLAN.md) §0, §1, §4, §5): open weights we can fine-tune,
fully local and offline from a TypeScript CLI (`onnxruntime-node` / transformers.js), at most ~1.6 GB,
CPU latency ideally under 300 ms per chunk of 512 to 2k tokens, calibrated probabilities, permissive licence.

How much to trust each claim:
- **[measured]**: measured by me on this machine for this doc (see "Latency bench" below).
- **[source]**: taken from the model card, paper or repo that is linked.
- **[est]**: my estimate, not measured. Treat it as a hypothesis for the spike.
- **[unverified]**: a claim from a third party that I could not check.

---

## TL;DR

1. **Architecture: for us, a shared encoder with one trained head per rule beats Laya's
   "question as text + options" design.** Our rule set is fixed per release, and zero-shot is
   already near chance on our domain (PLAN §1), so the one thing typed decisions add (asking new
   questions without retraining) is worth little to us. Meanwhile we pay for every weakness that
   comes from reading options as text: following the label name, position bias, misreading negated
   questions, and question tokens eating the 512-token budget. Keep a typed or span-scoring head
   only for the one question that really picks among candidates ("which column is the owner?").
   Reasoning and evidence are in the "Architecture question" section below.
2. **Bake-off shortlist** (each one as a shared encoder with one head per rule, trained against
   the same data as Laya):
   1. **ModernBERT-base** (149M, 8k ctx, Apache-2.0, code in pretraining, official ONNX):
      **~100–145 ms for 512 tokens on CPU [measured]**, ~3× faster than Laya.
   2. **jina-embeddings-v2-base-code** (161M, 8k ALiBi, Apache-2.0, pretrained on GitHub code
      with TS and SQL explicitly listed, official ONNX): **~90–105 ms for 512 tokens [measured]**.
      It is the code-specific candidate, and also the obvious SetFit body.
   3. **DeBERTa-v3-large** (435M, 512 ctx, MIT): **~320 ms for 512 tokens [measured]**, the same
      speed as Laya. It was the best and most stable learner in the only public head-to-head of
      typed-decision backbones, including a code task. Run it as the accuracy ceiling. It is also
      available with a ready typed-decision head as Open-Jev.
   4. **Ettin-encoder-150m / 400m** (MIT, ModernBERT architecture, open data, claims to beat
      ModernBERT on classification and code search) as an optional fourth. It has the same export
      path as #1, so it costs little to add.
   - Day-one cheap baselines (no fine-tune): a **frozen encoder plus logistic regression per rule**
     (what stuntd does), then **SetFit** on the same body. These tell us quickly whether the
     signal is in the embeddings at all.
3. **Drop:** CodeBERT, GraphCodeBERT and UniXcoder (512/1k ctx, no TS or SQL in pretraining, no
   licence file on the HF cards for the first two); CodeT5+ (512 ctx, custom code, no TS or SQL);
   StarEncoder (gated, OpenRAIL-M, 1k ctx); nomic-embed-code (7B) and Qodo-Embed-1.5B (too big or
   slow, and Qodo's licence is OpenRAIL-M); voyage-code (closed); jina-code-embeddings-0.5b
   (CC-BY-NC); CodeSage-v2 (good code coverage, but custom architecture with no ONNX path, and
   `large` is 1.3B). NeoBERT, EuroBERT and mmBERT are fine encoders with no edge for English code.
   GLiClass and NLI zero-shot models are only useful as zero-shot baselines or pre-labellers.
4. **Do not ship int8.** On Apple Silicon, int8 ModernBERT was *not faster* than fp32 [measured],
   and int8 is known to wreck calibration for ModernBERT-large and DeBERTa-v3-large
   (Laya #790/#792 [source]). A base-size encoder in fp32 is ~600 MB, about 2.7× smaller than
   Laya's 1.6 GB, which makes the size problem go away without quantising.

---

## Comparison table

Params come from HF safetensors totals where available. "ONNX/TS" means: is there an ONNX export,
and does transformers.js support the architecture (if not, we use raw `onnxruntime-node` plus
`@huggingface/tokenizers`, which is fine because we export our own fine-tuned graph anyway).
Latency is fp32, batch 1, CPU, 512 tokens unless noted (see the bench section).

| Model | Params | Ctx | Licence | Code-pretrained? | ONNX / TS ready? | CPU latency @512 | Fine-tune cost (Mac) | Notes |
|---|---|---|---|---|---|---|---|---|
| **Laya** (`convaiinnovations/laya[-typed-decisions]`) *(baseline)* | 421M | 512 / 1024 | Apache-2.0 | Via ModernBERT-large | ONNX (onnx-community), custom inputs; `laya-ts` | **332 ms [measured]**, 714 ms @1024 | LoRA via MLX: ~12 min per 1k rows on M4 [source: LayaStudio] | Typed decisions; zero-shot near chance on domain; label-name following |
| **ModernBERT-base** | 150M | 8192 | Apache-2.0 | Yes: code in its 2T-token mix; CodeSearchNet 56.4 vs DeBERTa-v3-base 17.5 [source] | Official ONNX (fp32/fp16/int8/q4); transformers.js supported | **101–145 ms [measured]**; 246–329 @1k; 669 @2k | Full FT on MPS: tens of minutes for 10k×512 [est] | Kotoba saw run-to-run divergence in typed-decision heads; use several seeds |
| ModernBERT-large | 396M | 8192 | Apache-2.0 | Yes; CSN 59.5, StackQA 83.9 [source] | Official ONNX; transformers.js supported | **~300 ms [measured]**, ~750 @1k | ~3× base [est] | Slowest learner of five encoders in kotoba's typed-decision head [source] |
| **Ettin-encoder** 17m / 32m / 68m / 150m / 400m / 1b | 17M–1B | ~8k | MIT | Yes; open 2T-token data incl. code; claims beat ModernBERT on CSN [source] | ModernBERT architecture, so the same export; onnx-community has 17m and 32m | ≈ ModernBERT at equal size [est] | ≈ ModernBERT [est] | ICLR'26; fully open data is useful for provenance |
| mmBERT-base / small | 307M / 140M (~110M / ~40M non-embedding) | 8192 | MIT | Some: StarCoder ≈5% of pretraining [source] | onnx-community ONNX; ModernBERT architecture | ≈ ModernBERT-base plus a 256k-vocab embedding [est] | ≈ ModernBERT [est] | Multilingual; no advantage for English code. Laya-multilingual uses it |
| NeoBERT | 245M | 4096 | MIT | No (RefinedWeb only) [source] | onnx-community ONNX; transformers.js supported; HF needs `trust_remote_code` | ~deb-base [est] | ~base [est] | Strong on MTEB, but no code in pretraining |
| EuroBERT-210m / 610m | 310M / 756M | 8192 | Apache-2.0 | Yes: code and math (Stack v2) [source] | transformers.js supported; no ONNX on the Hub; custom code | 210m ≈ base; 610m > 300 ms [est] | — | Best mmBERT-era CoIR scores; multilingual focus; 128k vocab |
| DeBERTa-v3-base | 184M | 512 (relative position) | MIT | No; CSN 17.5 [source] | ONNX (Xenova, MoritzLaurer); transformers.js supported | **111–129 ms [measured]**; 323–387 @1k | ~base [est] | Learned poorly in kotoba's typed head (0.398) [source] |
| **DeBERTa-v3-large** | 435M | 512 | MIT | No; CSN 21.2 [source] | ONNX (MoritzLaurer, onnx-community Open-Jev); transformers.js supported | **323 ms [measured]**; 921 @1k | Heavier: about 33 GiB peak on H100 at 512 [source]; on Mac, LoRA or a short full FT [est] | Best typed-decision learner (0.855 ID, 0.638 on code) [source]; int8 breaks it [unverified] |
| CodeBERT / GraphCodeBERT | 125M | 512 | MIT on GitHub; no licence on HF card | CodeSearchNet: 6 languages, JS but no TS or SQL | RoBERTa architecture, so it exports trivially; no Hub ONNX | ~deb-base [est] | Cheap | PrimeVul realistic F1 ≈17–21% (same as a code-metrics baseline) [source] |
| UniXcoder-base | 125M | 1024 | Apache-2.0 | CSN plus C4 (no TS or SQL) | RoBERTa architecture; no Hub ONNX | ~deb-base [est] | Cheap | Strongest classic code encoder on PrimeVul, still ≈21% F1 realistic [source] |
| CodeT5+ 110M-embedding / 220M encoder | 110M / 220M | 512 | BSD-3 | github-code, 9 languages (JS; no TS or SQL) [source] | `trust_remote_code`; T5 encoder exportable; no Hub ONNX | ~base [est] | Cheap | Retrieval-tuned; short context |
| CodeSage-v2 small / base / large | 130M / 356M / 1.3B | 2048 | Apache-2.0 | Stack v1 + v2 (incl. TS) [source] | Custom `CodeSage` architecture; no ONNX; no transformers.js | ~base / large / too slow [est] | — | Good code embeddings; export risk |
| StarEncoder | 125M | 1024 | BigCode OpenRAIL-M [unverified: gated] | The Stack, 86 languages | Gated; no ONNX | ~base [est] | — | Gated plus RAIL use restrictions |
| **jina-embeddings-v2-base-code** | 161M | 8192 (ALiBi; trained at 512) | Apache-2.0 | Yes: github-code plus 150M code QA pairs; **TS and SQL listed** [source] | Official ONNX (fp32/fp16/quant); JinaBERT needs custom code in HF | **90–104 ms [measured]**; 214–251 @1k; 575 @2k | ~base [est] | Embedding model: good body for SetFit or frozen-feature heads |
| CodeRankEmbed (nomic) | 137M | 8192 | MIT | Contrastive on CoRNStack 21M (code) [source] | Community ONNX (many); NomicBERT custom code | ~base [est] | ~base [est] | Retrieval-tuned; query prefix required; a SetFit body option |
| granite-embedding-english-r2 | 149M | 8192 | Apache-2.0 | Retrieval training includes code [unverified] | ModernBERT architecture; community ONNX | ≈ ModernBERT-base [est] | ≈ base | ModernBERT-arch embedding body for SetFit |
| nomic-embed-code | 7B | 32k | Apache-2.0 | Yes | — | Far over budget | — | Too big |
| Qodo-Embed-1-1.5B | 1.5B | 32k | QodoAI-Open-RAIL-M | Yes | — | Over budget [est] | — | Licence not permissive; too slow |
| jina-code-embeddings-0.5b | 494M | 32k | CC-BY-NC-4.0 | Yes | — | — | — | Non-commercial: out |
| voyage-code-3 | closed | — | Proprietary API | — | — | — | — | Note only: no weights |
| **Open-Jev DeBERTa-v3-large** (`com-kotobalabs/…`) | 434M + 3-layer head | 512 (state cut to 256) | Apache-2.0 | No (base); the repo has a code-decision variant | onnx-community ONNX (fp32 / fp16 / q4) | ≈ DeBERTa-v3-large, **~320 ms** [measured backbone] | $0.26 per 18k states on H100 [source] | Typed-decision reproduction; OOD 0.69 vs ID 0.85 |
| `MSGEncrypted/ocf-typed-decisions-mbert-base` | ~150M | 8192 | Apache-2.0 | Via ModernBERT-base | `.pt` only | ≈ ModernBERT-base [est] | — | Community typed-decisions fine-tune; no eval card [unverified] |
| GLiClass modern-base / large v3 | 151M / 399M | 8192 (ModernBERT) | Apache-2.0 | Via ModernBERT | Community ONNX (cnmoro) | ≈ ModernBERT [est] | 8-shot fine-tune gives +0.19–0.21 F1 [source] | Zero-shot avg F1 0.56 / 0.62 on NL datasets; code is OOD |
| NLI zero-shot (`MoritzLaurer/deberta-v3-*-zeroshot-v2.0`, `ModernBERT-base-zeroshot-v2.0`) | 184M / 435M / 150M | 512 / 8k | MIT / Apache-2.0 | No / via ModernBERT | ONNX in repo; Xenova copies | One pass **per rule**: 110–320 ms × N [measured backbone] | Fine-tunable as a cross-encoder | Pre-labeller or zero-shot baseline only |

The vulnerability-detection benchmarks above are mostly not comparable across papers. In PrimeVul's
realistic (imbalanced) setting, fine-tuned CodeBERT and UniXcoder sit at **~17–21% F1**, no better
than a code-metrics classifier (ICSE'26). Papers reporting 74–89% F1 "on PrimeVul" rebuilt or
balanced the test set. BigVul figures (60–90%) are inflated by duplicates and leakage. The lesson for
us is not "pick UniXcoder" but **"labels and the eval split dominate"**: split by project, as PLAN
§4 already says.

---

## Architecture question: typed decisions vs one head per rule on a shared encoder

### The two designs

- **Typed decision (Laya, Open-Jev, GLiClass, NLI):** input is `[state] + [question text] + [option
  texts]`, and a head scores each option's span against the question. One model answers *any*
  question phrased in text.
- **One head per rule (multi-label):** input is `[state]` only (the code chunk plus the fact header
  in words). The `[CLS]` or mean-pooled vector goes to R independent logits, one per rule (sigmoid),
  trained with **masked BCE** (only the rules that were gated or labelled for that chunk contribute
  loss). One forward pass gives every rule's probability. Each head gets its own temperature or
  Platt scaling.

### What the evidence says

| Point | Evidence | Favours |
|---|---|---|
| Asking new questions without retraining (the one unique benefit of typed decisions) | Zero-shot Laya is 0.36 vs 0.318 random on domain decisions (PLAN §1). Open-Jev: OOD questions 0.69 vs 0.85 in-domain, and a **new ordered scale is at or below the majority class** [source]. Kotoba: ModernBERT-base "memorises the slot" and is near the majority class on OOD (0.485) [source] | Heads (the benefit barely exists for us) |
| Label-name following and polarity | arXiv 2609.26758: renaming options `0/1`→`no/yes` changes 70.4 answers per 100, and AUC goes from .94 to .23; random option names fix it [source] | Heads (they have no option names) |
| Negated questions | Laya #377; kotoba: ModernBERT-base and LLaDA fall *below* the majority class on negated `noul` (0.40 / 0.39), and only augmentation lifts DeBERTa to 0.83 [source] | Heads (the question is never re-phrased) |
| Position bias | Laya #131 (needs `shuffle_options`) | Heads |
| Context budget | Laya: 512 tokens total; Open-Jev cuts the state to 256. Every question and option takes tokens away from code | Heads (the full window goes to the code) |
| Head trainability | Kotoba: a marker-token head on ModernBERT "does not learn" at any learning rate; only a span-mean head works, and ModernBERT-large still stalls (0.39). DeBERTa-v3-large learns (0.787 on 3k rows) [source]. A `[CLS]`/mean-pool linear head is the standard, well-tested path | Heads (less exotic, fewer failure modes) |
| Sharing knowledge across related rules | Typed questions let similar rules share the question-text signal. A shared encoder trained multi-task shares it too, just not through text | Roughly even |
| Adding a rule | Typed: add data, no architecture change. Heads: add a logit. With a frozen or shared encoder you can train only the new head (minutes, stuntd-style) or retrain everything. Rules and weights ship together per release anyway (PLAN §5) | Even |
| Latency | Both are one pass per chunk if all applicable questions are packed into one Laya input. Heads are slightly cheaper (shorter input) | Heads (slightly) |
| Calibration | Both are fine after temperature scaling. Per-head temperature is simpler than per (type, option count) temperatures (Laya README: ECE 0.466 → 0.081 after refit [source]) | Even |
| "Pick one of these candidates" questions (`write-policy-missing-ownership-check`: "Which column identifies the row's owner?") | A fixed-class head cannot pick among a variable set of columns. Typed `choice` or span scoring over candidates in the state can | Typed or span scoring, for this one rule |

### Recommendation

Use **one head per rule on a shared encoder** as the default for the 16 yes/no-style questions.
The deterministic layer already decides which rules apply to a chunk; it passes a mask and we read
only those logits. For the candidate-choice question, either:
(a) mark each candidate column in the state (e.g. `⟦owner?⟧user_id`) and score each marker's or
span's mean with a small head (the span-mean pattern that kotoba found trainable), or
(b) turn it into R binary checks computed in code ("is column X the owner?", one pass per
candidate, usually 1–3 candidates).

Keep Laya / Open-Jev in the bake-off as the typed baseline. If heads win on the gold set at
precision ≥ 0.9, the typed format adds only risk.

The extra rule we need with heads: **never train on rules that were not gated for a chunk**. Use
masked BCE, not "absent means negative". Otherwise every chunk would count as a silent negative for
15 unrelated rules.

---

## Zero-shot and few-shot families

- **SetFit** (contrastive fine-tune of a sentence encoder, then a logistic-regression or
  differentiable head). Supports `multi_target_strategy="one-vs-rest"` [source]. Reported 8 shots
  per class ≈ close to the full-data result on NL tasks (IMDB 92.7% with SetFit-ModernBERT)
  [source]. No published code-classification results [unverified for code]. It fits our early regime
  (30–100 positives per rule, PLAN §4) and trains in minutes on a Mac [est]. Best bodies for us:
  jina-v2-base-code, CodeRankEmbed, modernbert-embed-base, granite-embedding-english-r2. Caveat:
  sentence-embedding bodies are trained for *topic similarity*, while our rules hinge on small
  semantic deltas (`getUser` vs `getSession`, `using (true)` vs `using (auth.uid() = owner)`).
  Mutation pairs are exactly the contrastive pairs SetFit wants, so the fit is better than it
  looks, but expect full fine-tuning to win once we have 300+ items per rule.
- **Frozen encoder plus logistic regression per rule** (stuntd's approach: cache hidden states
  once, train only heads, ~4.5 min for 9k rows [source: PLAN]). This is the cheapest test of
  "is the signal in the representation". Run it first on every candidate.
- **GLiClass v3** (ModernBERT-based, all labels in one pass; Apache-2.0). Zero-shot average F1 is
  0.49–0.72 on NL datasets [source], below DeBERTa NLI for the ModernBERT variants. It is the same
  typed design as Laya, so it carries the same label-text weaknesses. Use only as a zero-shot
  pre-labeller comparison.
- **NLI cross-encoders** (`deberta-v3-*-zeroshot-v2.0`): one forward pass *per rule hypothesis*,
  so the cost is N × 110–320 ms. They are trained on natural language, so code is OOD. Useful as a
  second-opinion pre-labeller for the human-review queue. Not a shipping candidate.

---

## Practical notes

### Latency bench [measured]

- Machine: Apple M5 Pro (18 cores, 48 GB), `onnxruntime-node` (latest), CPU execution provider,
  graph optimisation `all`, batch 1, random token IDs, 3 warm-ups and 10 timed runs, p50 shown.
  Script: `bench.mjs` in the session scratchpad (not committed).
- **Caveat:** another process (`llama-bench`, ~4 cores) and other agents were running, with a load
  average of 15–21. p50s are usable. p90s had multi-second (sometimes minutes-long) stalls from
  contention and are not reported. Expect a 4-core x86 CI runner or an M1/M2 Air to be **~2–3× slower** [est].

| ONNX file | 512 tok | 1024 tok | 2048 tok | Load | RSS |
|---|---|---|---|---|---|
| ModernBERT-base fp32 (599 MB) | 101 ms (all threads) / 117 (4 thr) / 145 (6 thr, contended) | 246–329 | 669 | 0.3 s | 1.5–3.8 GB |
| ModernBERT-base int8 (151 MB) | 127–151 | 273–458 | 686 | 0.2 s | 1.3–3.5 GB |
| jina-v2-base-code fp32 (641 MB) | 90–104 | 214–251 | 575 | 0.25 s | 1.6–2.8 GB |
| DeBERTa-v3-base fp32 (738 MB) | 111–129 | 323–387 | n/a (512 native) | 0.35 s | 1.9 GB |
| ModernBERT-large int8 (398 MB) | 293–363 | 626 | — | 0.5 s | 2.7–2.9 GB |
| ModernBERT-large fp32 (1.58 GB) | 303 (6 thr) | 751 | — | 0.8 s | 4.2 GB |
| **Laya typed-decisions fp32 (1.69 GB)** | **332** | **714** | — | 2.6 s | 2.3 GB |
| DeBERTa-v3-large fp32 (1.74 GB) | 323 | 921 | — | 0.9 s | 3.1 GB |

What the bench shows:
- **Base-size encoders give ~3× headroom** under the 300 ms target at 512 tokens. They reach
  ~250 ms at 1k tokens. At 2k tokens they reach ~600–700 ms on this fast machine, so **2k-token
  chunks blow the budget on any encoder**. Either chunk to ≤1k (function or policy level, which
  PLAN §1 already prescribes) or accept ~0.6 s for the rare long chunk.
- ModernBERT's alternating local/global attention gives little CPU benefit in the ONNX export:
  cost roughly doubles or triples per doubling of length, the same as plain BERT. Its 8k window is
  a *capability* (no truncation), not a speed win.
- Large encoders (Laya, ModernBERT-large, DeBERTa-v3-large) sit right at ~300–330 ms on a top-end
  laptop, so they will **miss 300 ms on typical hardware** [est]. Laya's own PR #498 reports
  ~340 ms fp32 [source], which matches.
- **int8 gives no speed-up on Apple Silicon** for ModernBERT-base (it was slower). The speed-up is
  real on x86 with AVX-512 VNNI, which is CPU-dependent [source]. Combined with the calibration
  damage below, ship **fp32** (or fp16 weights upcast at load, for download size only).

### Quantisation and calibration

- ModernBERT-large in Laya: per-channel dynamic int8 matched fp32 on only 32% of decisions, and
  per-tensor on 67%. Static QDQ did not fix it. The cause is activation outliers. Weight-only int8
  reached 100% agreement [source: Laya #790/#792, nvkudva/laya-web-q8 (unverified)].
- One community card reports only 50% of DeBERTa-v3-large MatMuls quantise properly vs 95% for
  ModernBERT-base [unverified].
- Temperature scaling (one T per head, fitted on the held-out calibration slice) works the same
  way for every candidate. With heads there is no (type × option count) grid of temperatures. If
  some rules stay miscalibrated after temperature scaling, use per-head Platt scaling or isotonic
  regression.

### ONNX and transformers.js availability

- **Easy path** (optimum export works, and transformers.js supports the architecture): ModernBERT
  (+ Ettin, mmBERT, gte/granite/GLiClass-modern variants), DeBERTa-v2/v3, RoBERTa (CodeBERT,
  UniXcoder), EuroBERT and NeoBERT (transformers.js lists both; the HF side needs custom code).
- **Custom export** (`trust_remote_code`): JinaBERT (jina-v2-code, though official ONNX exists),
  NomicBERT (CodeRankEmbed, many community ONNX), CodeT5+, CodeSage.
- We export our *own* fine-tuned graph regardless, so what matters is that "optimum or
  `torch.onnx.export` works and fp32 ORT matches PyTorch". That is true for every model in the
  easy path. With heads, the exported graph is just encoder plus a linear layer, with standard
  inputs (`input_ids`, `attention_mask`). Laya's export needs extra `marker_pos`, `marker_mask`
  and `qtype` inputs.

### Training cost on a Mac

All Mac figures here are **[est]** except where marked.
- **Frozen encoder plus heads:** encode once (10k chunks × 512 tok ≈ 10k × 0.1 s ≈ 15–20 min on
  CPU, faster on MPS), then train heads in seconds to minutes. stuntd measured ~4.5 min for 9k rows
  [source].
- **Full fine-tune, base size (150M) on MPS:** on the order of 10–30 sequences/s at 512 tokens
  for forward plus backward on an M-series Pro, so roughly **30–60 min for 10k chunks × 3 epochs**.
  ModernBERT on MPS runs without flash-attention (SDPA/eager), so expect it to be slower than its
  GPU marketing.
- **Large (400M):** ~3× base, so ~2–3 h for the same run. Prefer LoRA r16 (LayaStudio: ~12 min per
  1k rows on an M4 for ModernBERT-large [source]) or rent a GPU. Kotoba's H100 figures, for scale:
  ModernBERT-base 18k×2 epochs in 150 s ($0.16), DeBERTa-v3-large 18k×1 epoch in 237 s ($0.26)
  [source].
- **MLX:** LayaStudio shows ModernBERT-large LoRA on MLX [source]. Generic MLX support for
  encoder fine-tuning (mlx-embeddings etc.) is [unverified]. PyTorch MPS is the safe default.
- **Stability:** kotoba saw ModernBERT-base diverge or collapse in 4 separate runs (0.434, 0.504,
  0.286 on code) under the typed head [source]. Run ≥3 seeds per candidate and report mean ± sd.
  Use a conservative learning rate (2e-5 to 5e-5) with warm-up.

---

## Ranked shortlist for the spike bake-off

Same data, same split (by project), same gold set and the same gate (precision ≥ 0.9 per rule,
AUPRC, ECE, CPU p50/p95). Laya (typed, LoRA plus soft-CE per PLAN §4) is the incumbent.

1. **ModernBERT-base + per-rule heads** (`answerdotai/ModernBERT-base`, Apache-2.0).
   Why: code-heavy pretraining (by far the best CSN/StackQA among general encoders), an 8k window
   so chunks never truncate, an official ONNX export, transformers.js support, ~100–145 ms
   [measured], and 600 MB fp32 (about 2.7× smaller than Laya, so the 1.6 GB download problem
   goes away). Risk: instability across runs (seeds), and it is a slower learner than DeBERTa at
   equal data [source: arXiv 2504.08716, kotoba].
2. **jina-embeddings-v2-base-code + per-rule heads, and as a SetFit body**
   (Apache-2.0). Why: the only small, permissive, ONNX-ready encoder whose pretraining explicitly
   lists **TypeScript and SQL**. Fastest measured (90–104 ms), 8k via ALiBi. Run it three ways: frozen
   plus logistic regression (hour one), SetFit (day one), full fine-tune. Risk: an embedding-tuned
   body may blur the small code deltas; JinaBERT needs custom code for training; trained at 512 and
   extrapolated beyond that.
3. **DeBERTa-v3-large**, both as **heads** and as **Open-Jev (typed)**. Why: the strongest learner
   in the only public controlled comparison (0.855 ID, 0.638 on held-out code namespaces, stable
   across seeds, ECE 0.02) [source]. Running both formats on the *same backbone* answers the
   architecture question cleanly, separate from the choice of encoder. Risks: 512 context, no code
   pretraining, ~320 ms (at the budget limit, over it on slower machines), int8 unsafe, 1.74 GB fp32
   (just over the ~1.6 GB cap; fp16 weights are 0.87 GB). Treat it as the accuracy ceiling, not the
   likely shipping model.
4. *(optional)* **Ettin-encoder-150m** (MIT): same architecture and export path as #1, open
   training data, and claimed wins over ModernBERT on classification and code search [source,
   unverified for our task]. Add it if #1 shows instability. The 400m variant is the ceiling if base
   sizes plateau.

Decision rule after the spike: ship the smallest model that clears the per-rule gate on the gold
set. If a base encoder with heads is within ~2 points of AUPRC of the best large model, take the
base: 3× faster, a third of the download, and fp32 without quantisation trade-offs.

---

## Sources

- Laya: <https://github.com/NandhaKishorM/laya>; INT8 issues [#790](https://github.com/NandhaKishorM/laya/issues/790), [#792](https://github.com/NandhaKishorM/laya/pull/792), [#498](https://github.com/NandhaKishorM/laya/pull/498); `onnx-community/laya-typed-decisions-ONNX`
- Label-name following: [arXiv 2609.26758](https://arxiv.org/abs/2609.26758)
- Open-Jev: <https://huggingface.co/com-kotobalabs/open-jev-deberta-v3-large>; measurements in <https://github.com/kotoba-lang/typed-decisions> (README, iterations 1–3: backbone comparison, head ablation, OOD, code decisions)
- stuntd: <https://github.com/bladedevoff/stuntd>
- ModernBERT: [arXiv 2412.13663](https://arxiv.org/html/2412.13663v2); ModernBERT vs DeBERTaV3: [arXiv 2504.08716](https://arxiv.org/abs/2504.08716)
- Ettin: [arXiv 2507.11412](https://arxiv.org/abs/2507.11412); mmBERT: [arXiv 2509.06888](https://arxiv.org/html/2509.06888v1); NeoBERT: [arXiv 2502.19587](https://arxiv.org/pdf/2502.19587)
- Model cards (HF API, 2026-10-05): answerdotai/ModernBERT-*, jhu-clsp/{mmBERT,ettin-encoder}-*, chandar-lab/NeoBERT, EuroBERT/*, microsoft/{deberta-v3,codebert,graphcodebert,unixcoder}-*, Salesforce/codet5p-*, codesage/codesage-*-v2, bigcode/starencoder, jinaai/jina-embeddings-v2-base-code, nomic-ai/{CodeRankEmbed,nomic-embed-code}, Qodo/Qodo-Embed-1-1.5B, knowledgator/gliclass-*-v3.0, MoritzLaurer/*-zeroshot-v2.0
- PrimeVul: [Ding et al. arXiv 2403.18624](https://arxiv.org/pdf/2403.18624); ICSE'26 code-metrics comparison <https://mlsec.org/docs/2026-icse.pdf>; inflated or balanced variants: [arXiv 2512.09006](https://arxiv.org/pdf/2512.09006), [arXiv 2508.16625](https://arxiv.org/pdf/2508.16625), [CleanVul arXiv 2411.17274](https://arxiv.org/pdf/2411.17274)
- GLiClass: [arXiv 2508.07662](https://arxiv.org/pdf/2508.07662); SetFit: <https://huggingface.co/docs/setfit/en/how_to/multilabel>, SetFit + ModernBERT results (Wasserblat, Medium)
- transformers.js supported architectures: <https://github.com/huggingface/transformers.js> README
