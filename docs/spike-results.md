# Spike results (2026-10-06)

Eight semantic rules. Gold = 17 real-code cases (URL@commit, see `data/gold/manifest.jsonl`):
a regression set, too small to separate models reliably.

| Model | Gold P / R | Gold AUROC | Synthetic test (held-out tables + families) | Size | CPU latency |
|---|---|---|---|---|---|
| ModernBERT-base + heads, synthetic only (v1) | 1.00 / 0.62 | **0.923** | weak on held-out families (getsession, metadata) | 597 MB | 46 ms @256 tok, 96 ms @512; ~40 ms/chunk in TS |
| v2: + raw Clef soft labels | 1.00 / 0.31 | 0.788 | worse | same | same |
| v3: + calibrated, balanced Clef labels | 1.00 / 0.46 | 0.885 | **best**: getsession AUPRC 0.998, metadata 0.988 | same | same |
| Clef-flash 9B zero-shot (teacher) | 1.00 / 0.77 | – | 0.92–1.0 accuracy once Platt-calibrated | 9.7 GB | ~0.5 s/question (Metal) |

## Findings
- **The pipeline works end to end:** templates → parse-checked data → Pythonx training → ONNX → TS runtime → gold eval.
- **Raw Clef probabilities are compressed (~0.15–0.7).** Distilling them unscaled hurts (v2). Per-rule Platt
  scaling fixes the teacher (`scripts/calibrate_teacher.exs`).
- **Synthetic data overfits fast.** Near-zero loss, and AUPRC 1.0 on most rules. Held-out template families are the honest synthetic signal.
- **v1 vs v3 on real code is unresolved at n=17.** It needs the reviewed gold set (`data/gold/review.jsonl`, 159 candidates).
- **The chunker needs facts.** `lib/` helpers aren't recognised as server code, which is the import-graph fact. Whole-file TS
  chunks were too large; declaration-level chunking is now in.
- **jina-code fine-tuning was ~8× slower on MPS.** Stopped; retry later as frozen features + linear head, with a pinned revision.

## Next
1. Human review of `data/gold/review.jsonl` (`cd cli && pnpm tsx src/review.ts`).
2. Re-evaluate v1/v3 on the reviewed gold set; refit teacher calibration on real labels.
3. Laya zero-shot baseline (`scripts/eval_typed.exs`), jina frozen-feature run.

## Update: reviewed gold set (172 cases)

- **Sources:** 17 original cases, 20 human-reviewed (admin-client rule), 135 labelled by security-reviewer agents. Agent labels are tagged `claude-review-agent` and used for evaluation only.
- **Selection bias:** a third of the candidates were picked because the teacher was confident they were positive, so this set is harder than real-world prevalence.

| Model | Precision | Recall | AUROC |
|---|---|---|---|
| ModernBERT-base v1 (synthetic only) | **0.50** | **0.65** | **0.749** |
| ModernBERT-base v3 (+ calibrated teacher) | 0.59 | 0.20 | 0.606 |
| Clef-flash 9B zero-shot (threshold 0.5) | 0.41 | 0.53 | – |

Per rule (v1):
- **single-where-maybe-single:** strong, 13 tp / 0 fp.
- **definer, select-true:** only false positives.
- **policy-authenticated:** misses 9 of 14.

### What this says
- **No model is near the 0.9 precision target on real code**, including the 9B teacher. The gap is not just the student.
- **Many real errors need facts the chunk doesn't contain:**
  - is execute revoked elsewhere?
  - is the app single-tenant?
  - what does the imported helper do?
  - is verify_jwt set?

  This supports the plan's fact store (schema replay, import graph, config) feeding the model, and some rules becoming deterministic + fact checks rather than model questions.
- **v3's teacher data pushed the model off real distributions** (calibrated on synthetic data). v1 stays the best student.

### Open labelling decisions (agent reports)
- Is a single-tenant team CRM (atomic-crm) "shared by design"? This flips about 4 labels in the policy and select-true rules.
- Does "lookup by a caller-supplied id, then 404" count as a `.single()` positive? 2 labels.
- New rule candidates surfaced:
  - cross-tenant id trusted from the request body after auth (lms-front `get-plan-features`)
  - first-signup-becomes-admin (atomic-crm)

## Update: fact store (SQL replay + TS import graph) and fact-informed re-review

- **Facts on the review site, then 18 agent labels re-reviewed with facts visible.** 4 flipped yes → no:
  - 2 definer functions: EXECUTE is revoked in a later migration.
  - 2 tables that are public by design.
- **Deterministic checks over facts, on the corrected gold set:**

| Rule | v1 model | Fact-based check |
|---|---|---|
| definer-function-no-caller-check | 0 tp / 3 fp | **1 tp / 0 fp / 24 tn: precision 1.00, recall 1.00** |
| select-true-on-private-data | 0 tp / 4 fp | 2 tp / 2 fp / 0 fn: precision 0.50, recall 1.00 (the 2 fp are intent: public reviews, team CRM) |

- **v1 overall on the corrected set:** precision 0.50, recall 0.71, AUROC 0.743.
- **Lesson:** facts fix labels as well as predictions. Reviewers without repo context mislabel; the gold set must be reviewed with facts.
- **Next:**
  - Model input carries the facts as a header line.
  - select-true's remaining judgement ("is this table meant to be public?") goes to the model.
  - Same facts-first treatment for the getSession, admin-client and edge-function rules.

## Update: facts in model input (v4) and fact suppressors

- **Facts in the CLI and eval:** both now add a `Facts:` header line (SQL fact store + TS import graph) and apply fact suppressors (caller verified, shared secret, user-scoped client only, getUser in chunk).
- **Facts in training:** SQL training samples are annotated by the real fact store; new TS contrastive fact pairs (same code, the fact decides the label).

| | Precision | Recall | AUROC |
|---|---|---|---|
| v1 (no facts) | 0.50 | 0.71 | 0.743 |
| v1 + facts/suppressors at inference | 0.52 | 0.71 | 0.779 |
| v4 trained with facts | 0.43 | 0.42 | 0.685 |
| **Best-per-rule system** (fact checks for definer/select-true, v1+facts elsewhere) | **0.52** | **0.78** | – |

- **v4 hurt.** Synthetic fact lines don't match the distribution of real ones; the model learned template-specific fact shortcuts (e.g. admin: 0/6/9/5).
- **Training on facts needs facts from real code**, i.e. real-code mutation or teacher-labelled real chunks with real repo facts, not template facts.
- **Shippable today by the precision bar:** definer-function-no-caller-check (fact check, 25/25).
- **Main false-alarm sources** (model rules): admin-client (9), single (7), policy-authenticated (6), user-metadata (4).

## Update: shippable deterministic rules, real-code data, Jev baseline

**Shipping path (`supacheck check`):**
- **Always on (facts engine):** definer-function-no-caller-check, select-true-on-private-data (warning), missing-api-grants-new-table (migrations on or after 2026-10-30, or `--all-grants`), grant-write-without-rls.
- **Opt-in (`--experimental`):** model rules.

**New training data:**
- 234 real-code mutation rows from the 11 permissive training repos (owner predicate → `true` / signed-in only; `getUser` → `getSession`; user-scoped → service-role client), with real repo facts.
- **Clef rescaled on the real gold labels is a weak teacher on real code:**
  - admin-client slope is negative (anti-correlated)
  - getSession at chance (0.53)
  - only 65 confident rows survived

  Calibration used the gold labels, which mildly contaminates v5's teacher rows.

| Model (172 real cases, facts on) | Precision | Recall | AUROC |
|---|---|---|---|
| v1 synthetic + facts/suppressors | 0.52 | 0.71 | 0.779 |
| v4 facts in training (synthetic facts) | 0.43 | 0.42 | 0.685 |
| v5 + real mutations + real-calibrated teacher | **0.60** | 0.40 | 0.712 |
| Clef-flash 9B zero-shot | 0.41 | 0.53 | – |
| **Jev (hosted) zero-shot, threshold 0.5** | 0.43 | **0.87** | – |

**Takeaways:**
- **Real mutations raise precision, but recall drops.** Mutations cover only 4 rules and mostly SQL policies.
- **Jev has by far the best recall.** It's usable as an evaluation reference (not for training labels, per the open-weight decision).
- **No model reaches the 0.9 precision bar.** Deterministic fact rules remain the shippable part.

## Update: shippable CLI, honest held-out measurement, mutation ceiling

**CLI (ready to ship):**
- `supacheck check` runs the facts engine, with text / JSON / SARIF output.
- Exit codes: 1 on error/critical findings (any finding with `--strict`), 2 on usage errors.
- Every finding lists the facts it rests on, the fix, and fixes to `avoid`.
- `supacheck mcp` serves a stdio MCP tool, `supacheck_check`.
- Rules ship inside the npm package (`cli/rules`, copied at build).

**Held-out measurement:** a repo-level split, with ~40% of repos used to tune thresholds and ~60% held out for testing (96 items).

| Model (test repos only, tuned thresholds) | Precision | Recall | AUROC |
|---|---|---|---|
| v1 synthetic + facts | 0.41 | 0.61 | 0.738 |
| v5 + real mutations/teacher | 0.50 | 0.13 | 0.624 |

These are the honest numbers; the earlier in-sample figures were optimistic.

**Mutation ceiling:** extending mutations to edge functions, `.single()` and signup triggers added only 12 rows. The 11 permissive training repos don't contain enough of these shapes. More real-code data needs a larger permissive corpus (100+ repos) or fake projects.

## Update: bigger permissive corpus (v6)

- **Jev as teacher ruled out:** TypeSafe MCA §2.3 forbids distillation and training on Output. Recorded in PLAN decisions.
- **`scripts/corpus_discover.exs`:**
  - 269 MIT/Apache/BSD/Unlicense candidates; 100 kept with real Supabase usage
  - gold-eval repos excluded
  - paced for GitHub's search limit (30/min)
- **Mutations over 111 training repos:** 4,540 rows from 69 repos, up from 246, after capping `.single()` positives at 3× negatives.
- **v6 training:** synthetic + mutations, no teacher; batch 8 with periodic `torch.mps.empty_cache()` (batch 16 ran out of MPS memory).

| Held-out test repos (96 items, thresholds tuned on calibration repos) | AUROC | Precision | Recall |
|---|---|---|---|
| v1 synthetic | 0.738 | 0.41 | 0.61 |
| **v6 + corpus mutations** | **0.818** | 0.39 | 0.48 |

- **Ranking improved clearly** (AUROC +0.08): real-code data is the lever.
- **Threshold choice is now the bottleneck.** The calibration split is too small per rule (a handful of items each) to pick precision-0.9 thresholds reliably.
- **Next:** grow labelled real data for calibration (a fact-visible review round on the new corpus), then re-tune.

## Update: calibration round on unseen repos

- **91 candidates** from 20 corpus repos v6 never trained on, pre-scored by v6 (no Jev/Clef). Labelled by 4 fact-visible security-review agents: 70 labelled, 21 skipped (tests/fixtures, client-construction-only chunks).
- **Calibration-only:** these labels never touch the held-out test repos (96 items, unchanged).
- **Fixed:** an evaluator routing bug, where an edit silently failed to apply and briefly mixed new labels into the test split.
- **Cleanup:**
  - removed 8 mutation rows from an RLS "audit kit" repo
  - discovery now skips scanner/audit/fixture/CTF/lint repos (one, codeinspectus, was in the calibration pool only)

| Held-out test repos (thresholds tuned on 146 calibration items) | AUROC | Precision | Recall |
|---|---|---|---|
| v1 synthetic | 0.738 | 0.38 | 0.48 |
| v6 + corpus mutations | **0.818** | 0.39 | 0.48 |

### What this says
- **More calibration data didn't lift precision.** v6 ranks better, but no per-rule threshold reaches precision 0.9 on calibration, so they fall back to 0.5. The model rules are not near shippable.
- **Real code is mostly negatives** (this round: 3 yes in 45 edge-function / getSession / admin items). At realistic prevalence even a good ranker yields many false positives.
- **The precision path is facts-first, as definer showed:**
  - admin-client: ask only when the chunk queries data (`.from`/`.rpc`); 11/25 items were construction-only.
  - getSession: deterministic when facts show an unverified `getSession` and its user id flows into a query.
  - edge-function: deterministic negatives already cover most cases (caller verified / shared secret).

## Update: facts-first TS rules

Deterministic checks (`tsRuleVerdict` in `cli/src/checks.ts`) from chunk code plus repo facts (import graph, helper behaviour, verify_jwt), compared with v6 on all 242 gold items:

| Rule | v6 model tp/fp/fn/tn | Facts check tp/fp/fn/tn | Precision / Recall |
|---|---|---|---|
| server-trusts-getsession | 3/11/3/10 | **5/0/1/21** | **1.00 / 0.83**: ships (engine: facts) |
| ef-service-role-trusts-body-identity | 5/22/1/8 | 3/1/3/29 | 0.75 / 0.50: `--experimental` |
| admin-client-for-user-scoped-work | 1/4/8/21 | 1/0/8/25 | 1.00 / 0.11: `--experimental` |

- **Edge-function misses:** remaining ones use non-Supabase privileged keys (Cloudflare) or body ids passed through helpers.
- **Admin-client recall is low mostly because of a definition gap.** Most positives are the user's labels ("admin client used by default / potentially dangerous"). That's broader than the rule's question ("service-role used for one user's own data"). Candidate: a separate info rule `service-role-in-request-handler`.
- **`supacheck check` now runs, always:**
  - SQL: definer, select-true, missing grants, grant-write-without-rls
  - TS: getSession

  The edge-function and admin-client facts checks run with `--experimental`.

## Update: more rules facts-first, new rules

All 242 gold items, facts engine where a rule has one (the model only as fallback for `.single()`'s middle cases):

| | tp | fp | fn | tn | Precision | Recall |
|---|---|---|---|---|---|---|
| v6 model | 28 | 47 | 33 | 134 | 0.37 | 0.46 |
| **Facts engine** | 32 | **6** | 29 | 175 | **0.84** | 0.52 |

| Rule | Model P / R | Facts P / R | Status |
|---|---|---|---|
| user-metadata-for-authorization | 0.44 / 1.00 | **1.00 / 0.75** | on |
| server-trusts-getsession | 0.21 / 0.50 | **1.00 / 0.83** | on |
| single-where-maybe-single | 0.83 / 0.38 | **0.84 / 0.62** | on (clear cases), warning |
| ef-service-role-trusts-body-identity | 0.19 / 0.83 | 0.75 / 0.50 | on as warning (decision) |
| policy-authenticated-not-authorized | 0.62 / 0.71 | 0.67 / 0.57 | experimental; team-wide info rule covers shared tables |
| admin-client-for-user-scoped-work | 0.20 / 0.11 | 1.00 / 0.11 | experimental, split: + info `service-role-in-request-handler` |

**New rules:**
- `first-signup-becomes-admin` (high; found in lms-front)
- `team-wide-access-confirm-signup` (info, deduped per table)
- `service-role-in-request-handler` (info, deduped per file)
- `cross-tenant-id-from-body` (experimental, unvalidated)

**Noise control:** info rules are deduplicated; text output is grouped by rule (max 5 shown per rule), while JSON and SARIF stay complete.

**Unvalidated by gold** (sanity-checked on corpus repos only): first-signup, team-wide, service-role-in-request-handler, cross-tenant.

## Update: validation of the new rules (57 reviewed items)

| Rule | Reviewed | Precision | Action |
|---|---|---|---|
| service-role-in-request-handler | 20 flagged | **0.95** (19/20) | on (info). Fixed the one fp: `_shared/` helpers now count as handlers only at a `Deno.serve`/`serve(` entry point |
| team-wide-access-confirm-signup | 20 flagged | 0.80 (16/20) | on (info). Refined: any `auth.uid()`/`auth.jwt()` comparison counts as scoped (storage folder fp); global reference tables (price/config/flag/plan/…) skipped |
| first-signup-becomes-admin | 7 flagged + 10 near-miss | **0.00** | moved to experimental. It confused count/exists *guards* and "creator owns their new org" with "first user becomes admin". Needs a rework (auth.users insert trigger + emptiness check on the user table + admin granted to `new`) |
| cross-tenant-id-from-body | 0 fired in ~120 repos | – | stays experimental |

- **Severity changes:** `.single()` moved to info (volume).
- **Fixed:** duplicate rows in the review file (3), which stalled the review queue. The review agent patched the server to prefer pending rows; the candidate builder now dedupes.
- **Escalation found during review:** 3 lms-front team-wide items are really cross-tenant gaps (rows belong to a tenant via course). These are inputs for policy-authenticated / cross-tenant work.
