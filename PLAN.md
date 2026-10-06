# supacheck — plan

A local, offline Supabase checker: a fine-tuned [Laya](https://github.com/NandhaKishorM/laya)
decision model shipped behind a CLI that reviews supabase-js usage (JS/TS first) and SQL
setup (schemas, RLS, functions), and answers in milliseconds, for humans and agents.

## 0. Decisions (2026-10-05)

| Topic | Decision |
|---|---|
| Ownership | **Experimental, aiming for official.** Personal org for now; design everything to move under Supabase later. Ask the Splinter maintainers to add a licence before reusing their fixtures. |
| Spike compute | **Local Mac** (LayaStudio-style LoRA / head-only). Cloud GPU only for later full fine-tunes. |
| Spike rules | **8 semantic rules** from the Laya-needed list (`knowledge/research/README.md`). |
| Labelling | **LLM pre-label + human review.** Pre-labels feed eval only, never training. |
| Training labels from LLMs | **Open-weight teacher only** (Apache-2.0, e.g. Qwen, run locally). No hosted-LLM outputs in training data. |
| Release | **Private until v1.** Private HF repo; decide the public licence when it goes official. |
| Stacks | Next.js App Router + `@supabase/ssr`, Lovable Vite React SPA, TanStack Start (Lovable's new template), then SvelteKit / Expo / others. |
| Upstream (Laya) | Contact the maintainer **after the spike**, with measured results. Pin the version meanwhile. |
| Model choice | **Not locked to Laya.** Spike runs a bake-off (§4): ModernBERT-base + per-rule heads (primary), jina-code, DeBERTa-v3-large (ceiling), fine-tuned Laya (baseline), and small decision decoders. Clef-flash is the local teacher. |
| Team-shared data (single-tenant CRMs) | **Info-level finding only**: "team-wide access; confirm sign-up is restricted". Not a positive for the security rules (gold keeps `no`). New backlog rule `team-wide-access-confirm-signup`. |
| `.single()` + caller-supplied id → 404 | **Counts as yes**: prefer `.maybeSingle()` plus an explicit 404. |
| Branch size | **Ship the spike as one branch** (settled 2026-10-06, not to be re-raised for this branch). |
| Next work | Facts-first rules (getSession, edge functions, admin client) plus a `Facts:` header in model input, then retrain v4. |
| admin-client split (2026-10-06) | Strict `admin-client-for-user-scoped-work` (service-role used for one user's own data) **plus** info rule `service-role-in-request-handler` (any service-role client in a request handler, matching the user's broader labels). |
| Edge-function rule | Ships as a **warning, on by default** (facts check, precision 0.75); errors only once it reaches ≥0.9. |
| New rules | `first-signup-becomes-admin`, `cross-tenant-id-from-body`, `team-wide-access-confirm-signup` (info). |
| Jev (TypeSafe) | **Not usable as a teacher**: MCA §2.3 (2026-09-23) forbids using Output for model distillation or to train a model that imitates it. Evaluation-baseline use only, and even that is a gray area under "facilitate the development of a similar product". Confirm with legal before any further use. Key stored in git-ignored `.env.local`; rotate it. |
| Labelling teacher | **Clef-flash (Apache-2.0)** run locally for soft labels. Satisfies the open-weight-only rule. |

## 1. What Laya is, and what that implies

- An encoder (ModernBERT-large 421M English, or mmBERT-base 322M multilingual) plus a small
  decision head. Input: `state` text + typed questions (`choice` / `score` / `noul`).
  Output: calibrated probabilities per option, in one forward pass, 20–140 ms.
- **It never generates text.** "Feedback" is therefore a fixed **rule catalog**: each rule
  is a question; the CLI maps a firing rule to a canned message, fix hint, and docs link.
  Free-form explanations, if wanted, come from an optional LLM escalation, not Laya.
- **Context is small**: 512 tokens (English) / 1024 (multilingual, typed-decisions). Code
  must be chunked (one function, one component, one SQL statement or policy at a time).
- **Zero-shot is near chance on domain decisions** (0.36 vs 0.318 random on typed-decisions);
  fine-tuned it reaches 0.77. Training is the project, not an optional step.
- Known failure modes that shape the design:
  - Follows the option **name** over its description: renaming `0/1`→`no/yes` flipped 70%
    of answers ([arXiv 2609.26758](https://arxiv.org/abs/2609.26758)). → neutral labels,
    label shuffling in training.
  - **Negation**: picked `cancel_account` on negated requests (upstream #377). Code is full
    of near-miss negatives (`getUser` vs `getSession`). → contrastive pairs in training.
  - Can't compare numbers or reason over several steps. → compute facts in code first.
  - Position bias across options (#131). → `shuffle_options` in training.
  - `action.act_probability` is useless (#185); gate on `confidence` / probabilities.
  - INT8 ONNX quantization damages calibrated probabilities (#790). → ship fp32/fp16.

## 2. Architecture: deterministic first, Laya for the semantic gap

```
files ──► chunker (tree-sitter TS/JS, pg_query for SQL)
            │
            ├─► deterministic facts (in code): "runs on server", "imports service key",
            │   "table has RLS enabled", "policy uses auth.uid() unwrapped" …
            │       └─► some rules fire directly (no model needed)
            │
            └─► Laya: state = header facts in words + chunk text
                      questions = only rules applicable to this chunk kind
                      ─► per-rule probability ─► per-rule threshold ─► finding
```

Don't duplicate what's exact already: Splinter (security/perf advisors, ~30 lints) and
`supabase db lint` (plpgsql_check) cover SQL on a live DB. supacheck's value is
**static, pre-deploy, and semantic**: intent-level judgments a regex/AST can't make
("does this policy actually restrict rows to the owner?", "is this a client component
using a server-only key?").

### Rule catalog (concept-level, language-agnostic)

One YAML file per rule: `id`, `domain` (sdk | sql), `applies_to` (chunk kinds),
`question` (Laya type, instructions, criteria with neutral labels), `severity`,
`message`, `fix`, `docs_url`, `threshold`. Rules are generated from the knowledge base
(section 3), not written from memory.

**Research done (2026-10-05):** `knowledge/research/` holds ~80 evidence-backed
anti-patterns from docs, GitHub, blogs and incident studies, ranked and labelled by
detection mode. Main findings:
- Most items are **deterministic or cross-file**, so the rule engine plus a **fact
  store** (file context, import graph, schema replay over migrations, config) carries
  most of the linter.
- Laya is needed for ~17 semantic questions. Those are the training targets, listed in
  `knowledge/research/README.md`.

Original seed list, now superseded by that ranking:

- **SDK**: service_role key in browser/client code; `getSession()` trusted on the server
  instead of `getUser()`/`getClaims()`; `@supabase/auth-helpers` instead of `@supabase/ssr`;
  client created per request in a hot loop; missing `error` handling on query results;
  `.single()` where rows may be 0/many; realtime channel never unsubscribed; storage
  public bucket for private data; Edge Function missing CORS/auth check.
- **SQL**: table in exposed schema without RLS; RLS enabled with no policy; policy that
  doesn't scope to `auth.uid()`; `auth.uid()` not wrapped in `(select …)` (initplan);
  policy references `user_metadata`; `security definer` without `set search_path`;
  view without `security_invoker`; missing index on policy/FK column; missing grants
  for anon/authenticated (new default since 2026-05/10); extension in `public`.

Extending to Python/Dart/Swift/Kotlin = add a chunker + training data for the same rule
IDs. The state header names the language (`Language: Python. Context: server.`).

## 3. Knowledge layer: what "correct" means, and proof that it holds

Before writing rules or generating data, build a reviewed **knowledge base** of correct
patterns and anti-patterns. Three inputs feed it, and they check each other:

- **Docs** (this section's sources): what Supabase says is correct. Defines the rules.
- **Field research** (below): how Supabase is actually used on the internet. Shows which
  patterns are common, surfaces anti-patterns the docs don't cover, and supplies real code.
- **Fake projects** (below): realistic apps we build and run. These prove each entry
  holds in practice (the anti-pattern really leaks or slows something down; the fix
  really works), and they become an end-to-end test bed and a training source.

Everything downstream uses the knowledge base: rule catalog, mutation templates, eval
cases, and the CLI's messages and links.

### Sources (in priority order)

1. **[`supabase/agent-skills`](https://github.com/supabase/agent-skills)**:
   `supabase-postgres-best-practices/references/*.md` (~35 files: RLS basics/performance,
   privileges, FK indexes, primary keys, pooling, N+1, pagination, upserts, locking…). Each
   is already an *Incorrect / Correct* SQL pair with an `impact` rating, which makes them
   direct seeds for SQL rules and mutation pairs. The `supabase` skill covers SDK/auth/SSR.
2. **Docs guides** ([`supabase/supabase` → `apps/docs/content/guides`](https://github.com/supabase/supabase/tree/master/apps/docs/content/guides)):
   - `auth/`: server-side auth & SSR, sessions, `getUser` / `getClaims` vs `getSession`,
     anonymous sign-ins, user metadata.
   - `database/`: `row-level-security`, `row-level-security-performance`, `roles`,
     `column-level-security`, functions, triggers, indexes.
   - `api/`: securing the Data API, grants on exposed schemas, keys (anon/publishable vs
     service_role/secret).
   - `storage/` (access control, buckets), `realtime/` (authorization, channel cleanup),
     `functions/` (auth, CORS, secrets), `security/`, `deployment/` (production checklist).
3. **Troubleshooting** (`apps/docs/content/troubleshooting`, 224 articles): every article
   is a failure users really hit, which makes them sources of anti-patterns, realistic
   eval states, and frequency signal.
4. **[Splinter](https://github.com/supabase/splinter) lint docs**: each lint has a
   description and remediation, mapped 1:1 to SQL rules where static detection is possible.
5. **SDK reference + supabase-js changelogs**: deprecations and renames (auth-helpers →
   `@supabase/ssr`, anon → publishable keys, v1 → v2 APIs). These make rules version-aware.
6. **Real-world frequency**: GitHub issues/discussions, support tickets, Discord. Used to
   rank anti-patterns by how often they hurt users, not to define correctness.
7. **Known-good code**: `examples/` and quickstarts in the main repo, used as clean
   negatives and as bases for mutations.

### Knowledge entry format

```yaml
id: auth.server-trusts-getsession
kind: anti-pattern            # or: pattern
topic: auth / ssr
statement: Server code must not trust getSession() for authorization; use getUser() or getClaims().
why: getSession reads the cookie without revalidating the JWT, so it can be spoofed.
sources:
  - url: https://supabase.com/docs/guides/auth/server-side/...
    repo_path: apps/docs/content/guides/auth/server-side/...
    commit: <sha>
    quote: "<verbatim sentence the entry rests on>"
applies_to: { languages: [ts, js], sdk: "@supabase/supabase-js >=2", context: server }
severity: security            # security | data-loss | performance | correctness | style
detectability: semantic       # deterministic | semantic | runtime-only
examples:
  incorrect: [ ... ]          # lifted from the docs where they exist
  correct:   [ ... ]
field:                        # from field research
  prevalence: common          # common | occasional | rare, with the sample it was measured on
  seen_in: [ <repo/post URLs> ]
evidence:                     # from fake projects: the entry is demonstrated, not just stated
  project: fake-projects/nextjs-notes-app
  test: tests/auth/spoofed-cookie.test.ts   # fails on the anti-pattern, passes on the fix
owner_review: auth-team       # who signed it off
```

An entry is **verified** only when it has a docs source (or explicit owning-team
approval for field-only entries) **and** a passing evidence test in a fake project.
Only verified entries become rules that ship.

### Process

1. **Extract**: a script pulls the docs and skills at a pinned commit; an LLM pass
   proposes candidate entries, **each with a verbatim quote and path** (no quote, no
   entry). Extraction only summarises our own docs, so it is not affected by the
   teacher-labelling terms question.
2. **Review**: entries are grouped by product and signed off by the owning team (Auth,
   Database, Storage, Realtime, Functions). Contradictions between pages get resolved
   here and reported back to docs as issues.
3. **Classify detectability**:
   - `deterministic`: an AST/regex check in the rule engine, no model needed.
   - `semantic`: becomes a Laya question.
   - `runtime-only` (needs a live DB, traffic, or config): out of scope for static
     checks. The CLI points to Splinter/advisors instead.
4. **Prioritise**: severity (security > data-loss > performance > correctness > style)
   × frequency from troubleshooting/support. The top ~25 semantic entries become v0 rules.
5. **Generate**: entries → rule YAML (`message`, `fix`, `docs_url` come straight from the
   entry), mutation templates (incorrect/correct pairs), and gold-set candidates.
6. **Version awareness**: `applies_to.sdk` ranges let the CLI read `package.json` and
   only apply rules relevant to the installed SDK (no `getClaims` advice on old versions).
7. **Freshness**: a scheduled CI job re-pulls docs, flags entries whose source lines
   changed for re-review, and queues new pages/troubleshooting articles as candidates.
   Each model release records the knowledge-base commit it was trained on.

### Field research: how Supabase is used in the wild

Survey real usage, both to sharpen the knowledge base and to collect real code.

- **Where to look**:
  - **Code**: GitHub code search for supabase-js imports, `createClient`, `@supabase/ssr`,
    and repos with `supabase/migrations/` or `supabase/functions/`.
  - **Templates**: starters and boilerplates (Vercel/Netlify templates, popular SaaS
    starters), which get copied widely, so their mistakes spread.
  - **Tutorials**: blog posts and videos, a known source of anti-patterns (e.g. the
    service key used in the browser "to make it work").
  - **Q&A**: Stack Overflow, Reddit r/Supabase, GitHub Discussions, Discord.
- **What comes out**:
  1. **A usage map**: frameworks (Next.js app/pages router, SvelteKit, Expo, Remix, Astro,
     plain Node), SDK versions, auth styles, features used (RLS, Storage, Realtime, Edge
     Functions, RPC). This decides the fake-project matrix and rule priority, and records
     `field.prevalence` per entry.
  2. **New candidate entries**: anti-patterns seen in the wild that the docs don't spell
     out. They go through the same review; field-only entries need explicit owning-team
     approval, and docs gaps get filed as docs issues.
  3. **A real-world corpus**: chunks for the gold set (human-labelled) and for the
     active-learning loop.
- **Hygiene**:
  - **Licences**: train only on permissively licensed code (MIT/Apache/BSD), and keep
    provenance (repo, commit, licence) per sample.
  - **Site rules**: respect robots.txt and each site's terms.
  - **Secrets**: redact any keys or secrets found. Public repos will contain real
    Supabase keys; report them via GitHub secret scanning rather than storing them.

### Fake projects: a test bed that also teaches

A set of realistic, runnable Supabase apps in `fake-projects/`. Each is generated from a
scenario matrix driven by the usage map, and each exists in a **clean** variant and one
or more **seeded** variants.

- **Matrix**:
  - **Domain**: notes, multi-tenant SaaS, marketplace, chat, file sharing.
  - **Framework**: Next.js app router, SvelteKit, Expo, Edge Functions + plain Node, and so on.
  - **Auth model**: per-user, team/org, public-read, anonymous sign-in.
  - **Features**: Storage, Realtime, RPC, cron/queues.
- **Clean variant**: follows every applicable knowledge entry. It must pass Splinter, typecheck,
  and its own test suite.
- **Seeded variants**: inject specific anti-patterns at known locations and record them
  in a `seeded.json` manifest (`entry_id, file, range`). Seed one or a few per variant so
  each finding can be attributed.
- **Run them for real**: `supabase start`, apply migrations, run the app's tests.
  **Evidence tests** prove each entry:
  - *Security*: anon or another user reads or writes rows via the Data API; a spoofed
    cookie passes `getSession()`.
  - *Performance*: `explain analyze` shows the initplan or seq-scan cost at N rows.
  - *Correctness*: `.single()` throws on 0 rows; a leaked realtime channel keeps
    receiving messages.

  The test fails on the seeded variant and passes on the clean one. An entry with no
  reproducible evidence goes back to review: either the docs claim is narrower than
  stated, or our understanding is wrong.

They serve four uses:
1. **Testing the knowledge**: evidence tests as above. Re-run when docs or SDK versions
   change, so stale entries are caught by failing tests, not by users.
2. **Knowledge source**: building a clean variant forces concrete answers ("what's the
   correct SSR client setup in SvelteKit with SDK x.y?"). These go back in as
   `pattern` entries with working code.
3. **End-to-end CLI eval**: run `supacheck check` over every variant and score against
   `seeded.json` at file and line level. Unlike the chunk-level gold set, this includes
   cross-file context (client vs server files, env usage) and catches chunking and
   fact-extraction bugs. Clean variants measure false positives on realistic code.
4. **Training data**: chunks from seeded and clean variants with manifest-derived labels.
   Hold out whole projects (not chunks) for eval so nothing leaks between splits.

Generation: scaffold from official templates (`create-next-app`, the Supabase examples),
then build out with coding agents against the knowledge base, with a human pass on the
clean variants. Seeding is scripted from the entries' incorrect/correct examples, so
it's reproducible. If agent-written code is used as *training* data, the hosted-LLM terms
question in section 4 applies; using it purely for eval and evidence does not.

Output lives in `knowledge/` (entries), `field/` (usage map, corpus manifests with
provenance), and `fake-projects/` (apps, seeded manifests, evidence tests) in this
repo: reviewable in PRs, diffable, and cited from every rule.

## 4. Training plan (the core)

### Model selection: a bake-off, not a commitment

Research: `knowledge/research/models-encoders.md`, `models-small-llms.md`,
`models-clef.md`. The model is chosen by measurement in the spike.

**Architecture: shared encoder plus one head per rule beats "question as text" for us.**
- The only thing typed decisions (Laya/Jev/Clef) add is asking *new* questions without
  retraining. That is worth little here: our rule set is fixed per release, and
  zero-shot Laya is near chance on our domain (Open-Jev: 0.69 on unseen questions vs
  0.85 on seen ones).
- Meanwhile we would carry every weakness that comes from reading options as text:
  following the option name (arXiv 2609.26758), position bias, misreading negations, and
  question tokens using up the context.
- Heads need **masked loss**: a rule not applicable to a chunk is not a negative for it.
- The one candidate-picking rule ("which column is the owner?") gets a small scoring
  head over candidate columns, or one yes/no check per candidate.

**Measured CPU latency** on an M5 Pro, onnxruntime-node, fp32, 512 tokens, median, under
background load. Expect 2–3× slower on typical laptops and CI.

| Candidate | Role | Size | CPU @512 | Notes |
|---|---|---|---|---|
| **ModernBERT-base + per-rule heads** | primary shipping candidate | ~600 MB fp32 | 101–145 ms | Apache-2.0, code in pretraining, 8k ctx, official ONNX |
| **jina-embeddings-v2-base-code** | shipping candidate | ~600 MB | 90–104 ms | only small permissive ONNX-ready encoder trained on TS + SQL. Ladder: frozen features + logistic regression → SetFit → full fine-tune |
| DeBERTa-v3-large (heads, and Open-Jev typed) | accuracy ceiling; cleanest heads-vs-typed test | 1.74 GB fp32 / 0.87 GB fp16 | ~323 ms | at the latency limit |
| Laya / laya-typed-decisions (fine-tuned) | incumbent baseline | 1.6 GB | ~300–332 ms | typed design; known biases |
| Decision-2.0-Kai-0.6B (decoder "decision model") | decoder alternative | 0.61 GB ONNX | ~1 s @1k CPU, ~0.3 s Metal | Apache-2.0, Laya-like interface; fine-tune scripts unconfirmed |
| Qwen2.5-Coder-0.5B + LoRA (label-token scoring, or a classification head over all rules) | decoder alternative | ~0.5 GB q8 | 0.75–1.2 s @1k CPU, 0.23 s Metal | fastest code-trained decoder measured |
| Ettin-encoder-150m | optional | small | ~ModernBERT-base | fully open training data |

**Not shipping, but useful:**
- **Cloudflare Clef-flash (9B, Apache-2.0)** as the **local open-weight teacher** for
  soft labels (per-option probabilities, Jev/Laya-compatible request format). It also
  serves as the zero-shot accuracy reference. At 4.2 GB minimum and seconds per chunk on
  CPU it can't ship. Cloudflare's RL fine-tuning platform is hosted only.
- **Fallback if no small model reaches precision ≥ 0.9:** distil Clef-flash into a ~0.8B
  model, as already done for vision (92.2% vs the teacher's 94.1%).

**Excluded:**
- **Licences**: LFM2 (bars commercial use at $10M+ revenue), plus Gemma 3, Llama 3.2,
  DeepSeek-Coder, StarCoder2, OpenCoder and jina-code-0.5b (custom or non-commercial
  terms).
- **Older code encoders**: CodeBERT, GraphCodeBERT, UniXcoder and CodeT5+ (short context,
  ~17–21% F1 on realistic PrimeVul).
- **Zero-shot NLI and GLiClass**: pre-labelling and baselines only.

**Consequences for the runtime:**
- **Chunks of 256–512 tokens**: ~1k at most; 2k costs 600–700 ms even on base models.
- **Ship fp32, no int8**: int8 isn't faster on Apple Silicon and damages calibration.
  4-bit decoders save size, not latency.
- **Fit temperatures on the exact file we ship.**
- **A base-size encoder is ~600 MB,** well inside the 1.6 GB budget, so the parallel part
  download still applies.
- **Speed**: use Metal or WebGPU when available, plus the resident daemon and the
  per-chunk cache.

**Bake-off protocol (spike):** the same 8 semantic rules, the same training data (Clef-flash
soft labels plus mutation pairs plus fake projects), and the same gold set (LLM pre-label
plus human review). Score each candidate on per-rule precision at the operating
threshold, recall, AUPRC, ECE, CPU and Metal latency at 512 tokens via the TS runtime,
download size, and Mac training time. The winner is the smallest model that clears
precision ≥ 0.9 on most rules with ECE ≤ 0.1.

### Laya-specific notes (if Laya or a typed model wins)
Use the English `convaiinnovations/laya` and also try `typed-decisions`. **Always pin the
model explicitly**; never `Router`, because its language detector is built for natural
language and will misroute code.

### Objective
For heads on an encoder: multi-label soft cross-entropy (or BCE against soft teacher
targets) with masked loss for non-applicable rules, plus temperature scaling per rule on
a held-out slice. For a typed model: upstream `laya.train.finetune` with `loss="soft-ce"`, not the default RLCD policy gradient:
upstream #741 measured no gain from the RL term, and LayaStudio measured the
deterministic proper-scoring objective at 88.2% vs 79.2% for RLCD on the same data.
Plus:
- `shuffle_options=("choice",)` against position bias.
- Neutral option labels (`labels: {"true": "A", "false": "B"}` on `noul`, opaque keys on
  `choice`), and randomize the label strings per epoch in our data builder.
- Calibration slice held out **before** training (`calib_frac`), temperatures per type.

**Training is fast. Data is the slow part.** Measured times:

| Approach | Measured | Source |
|---|---|---|
| Frozen encoder, train head only | ~4.5 min for 9k rows (3 × 3k) | stuntd |
| LoRA rank 16 + full head (MLX) | ~12 min for 1k rows on an M4 MacBook, 47% → 88% | LayaStudio |
| Full fine-tune, demo set | 4–6 min for 6k decisions on 2×T4 | upstream notebook |
| Full fine-tune, large set | 4–5 h for ~30k questions on 2×T4 | upstream notebook |

Use the tiers in that order: the spike and day-to-day iteration on a laptop (head-only or
LoRA, minutes); full fine-tune only for release candidates, on a modern GPU (L4 / A10 /
4090 / A100). That should be well under the T4 figure, but it is unmeasured, so time it in
the spike. Iteration speed is therefore bound by how fast we can produce and verify
labelled data, which is what sections 3 and the data pipeline below are for.

### Data: ranked by label quality

1. **Programmatic labels (the backbone, highest trust)**
   - *SQL via Splinter*: generate schemas/migrations (templated + LLM-written), apply to an
     ephemeral Postgres (`supabase start`), run `splinter.sql` → exact labels per object.
     Covers RLS/policy/index/security-definer rules for free.
   - *Mutation pairs*: driven by the knowledge base's incorrect/correct examples; take
     known-good snippets (Supabase docs, examples repo, quickstarts)
     and inject one anti-pattern each (swap `getUser`→`getSession`, drop `enable row level
     security`, unwrap `(select auth.uid())`, move service key into a `"use client"` file).
     Every pair is a positive + a near-identical negative — exactly what fixes the negation
     and name-following weaknesses.
   - *Fake projects*: chunks from clean and seeded variants, labelled from `seeded.json`,
     in realistic multi-file context. Split by project, not by chunk.
2. **Human gold set (eval only, never trained on)**: 300–500 real snippets from support
   tickets, GitHub issues, Discord and the field-research corpus, labeled by Supabase
   engineers/DevRel. ≥200 per domain
   so confidence intervals mean something.
3. **LLM-teacher labels (volume, lowest trust)**: run a frontier model over real OSS code
   using supabase-js (GitHub code search) for the rule questions; sample k times for soft
   targets. Filter by teacher agreement, and cap its share: LLM-only labels plateau early,
   flip across seeds, and under-learn minority classes
   ([arXiv 2504.15432](https://arxiv.org/abs/2504.15432)).
   **Terms:** hosted providers restrict training on outputs (Anthropic Commercial Terms
   D.4: no use "to build a competing product or service, including to train competing AI
   models … except as expressly approved"; OpenAI has a similar clause). A narrow lint
   classifier is arguably not a competing model, but that's legal's call, not ours. Fallback
   that needs no sign-off: an open-weight teacher whose license allows distillation (e.g.
   Qwen, Apache-2.0) run locally or on rented GPUs. Sources 1–2 need no teacher at all.

Targets: start at ~30–100 positives per rule (LayaStudio's guidance), aim for 300+ per rule
before trusting it (stuntd's floor). ~25 rules × balanced pos/neg ≈ 15–25k items.

### Active-learning loop (after v0)
Student-guided, as in [arXiv 2610.02516](https://arxiv.org/html/2610.02516): run the
model across many OSS repos → collect low-confidence or disagreeing chunks → label with
teacher/human → retrain. When you use truncated teacher scores, train on hard labels, not
zeroed-out soft distributions.

### Evaluation gate (per release, in CI)
Per rule: precision, recall, AUPRC, ECE on the gold set and on held-out fake projects (file/line level against `seeded.json`, false positives on clean variants); overall McNemar vs previous
release; latency p50/p95 on CPU. **Thresholds per rule are set for precision ≥ 0.9.** A
linter with false positives gets ignored, so a rule that can't clear that bar ships as
`info` or not at all. Baselines to beat: zero-shot Laya, and a small hosted LLM on the
same gold set (accuracy, cost, latency).

## 5. Runtime and distribution

- **Language**: TypeScript throughout (CLI, chunkers, rule engine, inference), so it can be
  integrated into the Supabase CLI later. Python stays confined to the training pipeline.
- **Inference**: ONNX via `scripts/export_onnx.py` (no `--quantize`), fp32 ≈ 1.6 GB for
  421M (accepted). Engine: `laya-ts` (upstream's on-device ONNX runtime for JS) on
  `onnxruntime-node`; tokenizer via `@huggingface/tokenizers` or `laya-ts`'s own. Keep
  inference behind a small `Engine` interface so a server-side or WASM backend can be
  swapped in.
- **Artifact layout** (each piece versioned, hashed, downloaded independently):
  ```
  manifest.json            version, rules_version, files[] {path, size, sha256, parts[]}
  model.onnx               graph only (small; weights stored as ONNX external data)
  model.onnx.data          ~1.6 GB weights, published as N × 64 MB parts
  tokenizer.json, config.json (temperatures, max_len, head_max_len)
  rules/                   rule catalog matching this model version
  ```
  Parallel download: fetch `manifest.json`, then pull parts concurrently (6–8 at a time)
  either as separate shard files or as HTTP `Range` requests against one file (HF Hub and
  GitHub Releases both serve ranges; shards are simpler to resume and cache-bust). Verify
  each part's sha256, reassemble, verify the whole file, atomic rename into
  `~/.cache/supacheck/<version>/`. Interrupted downloads resume from finished parts.
  Small files (rules, config) update without re-downloading weights.
- **Hosting**: Hugging Face Hub `supabase/supacheck` (or GitHub Releases / Supabase
  Storage), pinned revision. Works offline after first pull. The rule catalog version is
  pinned in the manifest (rules and weights move together).
- **CLI** (`npx supacheck` first):
  - `supacheck check [paths] [--diff <ref>] [--format text|json|sarif]` — exit codes for CI.
  - `supacheck daemon` keeps the model resident (load is seconds, so agents calling it
    repeatedly shouldn't pay that each time); the CLI uses it via a unix socket if running.
  - Content-hash cache per chunk; `--diff` checks only changed hunks.
  - `supacheck mcp` — MCP server exposing `check_file` / `check_snippet` for agents.
  - JSON output per finding: `rule_id, severity, probability, confidence, file, range,
    message, fix, docs_url`. Low-confidence findings are labeled as such, not hidden.

## 6. Phases

| # | Phase | Output | Go/no-go |
|---|---|---|---|
| 0 | **Spike** (~1–2 wk) | 8 semantic rules from the Laya-needed list in `knowledge/research/README.md` (e.g. ef-service-role-trusts-body-identity, server-trusts-getsession, policy-authenticated-not-authorized, user-metadata-for-authorization), seeded with `agent-skills` incorrect/correct pairs, ~150 hand-labeled examples, zero-shot vs quick soft-CE fine-tune (mutation data only); ONNX export running in TS via laya-ts; CPU latency; parallel part download prototype | fine-tuned ≥ 0.85 precision on the 8 rules; < 300 ms/chunk on CPU |
| 1 | **Knowledge layer** | docs extraction into `knowledge/` (sources + quotes, team sign-off, detectability + priority), field-research usage map + corpus, first fake projects (clean + seeded) with evidence tests, freshness CI | top ~25 semantic entries **verified** (docs source + passing evidence test) |
| 2 | Rule catalog + data pipeline | YAML rules, chunkers (TS/SQL), Splinter harness, mutation generator, gold set | gold set ≥ 300 |
| 3 | Training pipeline | reproducible `train → calibrate → eval → export` job, eval report in CI | per-rule gate above |
| 4 | CLI v0 | `check`, JSON/SARIF, cache, model download | e2e eval on fake projects vs `seeded.json` meets per-rule gate; dogfood on Supabase example repos |
| 5 | Agent integration | daemon, MCP server, Claude Code / Cursor hook examples | |
| 6 | Active learning + more languages | Python next (supabase-py), then Dart/Swift/Kotlin | per-language gold set |

## 7. Risks

- **Upstream maturity**: 0.3.x, a fast release cadence, mostly one maintainer. Pin versions;
  keep our training data/rules independent so we could swap to a plain ModernBERT
  classifier head if needed.
- **Download size** (~1.6 GB, accepted). Mitigated by parallel, resumable part downloads
  and lazy fetch on first `check`.
- **Chunking hides cross-file facts** (is this file a client component? which key is in
  env?). That's why deterministic facts go in the state header.
- **False positives kill adoption** → precision-first thresholds, `info` tier,
  inline `// supacheck-ignore <rule>` suppressions.

## Sources

- Laya: <https://github.com/NandhaKishorM/laya> (README "Honest limits", `docs/finetune.md`,
  `laya/train.py`), <https://huggingface.co/convaiinnovations/laya>,
  <https://brainfunctioncollapse.com/laya>
- LayaStudio (objective comparison, LoRA on Mac): <https://github.com/biplovgautam/LayaStudio>
- stuntd (frozen-encoder heads, data floors): <https://github.com/bladedevoff/stuntd>
- Browser-agent fine-tune (input-format lesson): <https://huggingface.co/cklxx/laya-browser>
- Option-name failure: <https://arxiv.org/abs/2609.26758>
- Student-guided distillation into ModernBERT: <https://arxiv.org/html/2610.02516>
- Risks of LLM labels for BERT classifiers: <https://pith.science/paper/2504.15432>
- Splinter: <https://github.com/supabase/splinter>
- Supabase agent skills (best-practice incorrect/correct pairs): <https://github.com/supabase/agent-skills>
- Supabase docs source: <https://github.com/supabase/supabase/tree/master/apps/docs/content>
- Anti-pattern research (sources per item): `knowledge/research/`
