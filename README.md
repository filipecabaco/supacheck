# supacheck

A local, offline linter for Supabase usage (supabase-js and SQL migrations), powered by a
small fine-tuned model plus deterministic rules. Built for people and coding agents.
**Status: phase 0 spike (model bake-off).** See [PLAN.md](PLAN.md) and the research in
[knowledge/research/](knowledge/research/README.md).

## Use it

```sh
npx supacheck check .                     # facts-engine rules, no model download
npx supacheck check . --format json       # for agents and scripts
npx supacheck check . --format sarif      # GitHub code scanning
npx supacheck check . --strict            # fail on warnings too
```

Exit codes: `0` clean or warnings only, `1` error/critical findings (any with `--strict`), `2` usage.
Every finding says *why* (the facts it rests on), how to fix it, and which "fixes" to avoid:
never disable RLS or `GRANT ALL` to `anon` to silence a finding.

Rules that always run (facts engine, no model):

| Rule | Severity |
|---|---|
| `definer-function-no-caller-check` | critical |
| `grant-write-without-rls` | critical |
| `server-trusts-getsession` | high |
| `user-metadata-for-authorization` | critical |
| `select-true-on-private-data` | warning |
| `missing-api-grants-new-table` (migrations on or after 2026-10-30, or `--all-grants`) | warning |
| `ef-service-role-trusts-body-identity` | warning |
| `single-where-maybe-single` (clear cases only) | info |
| `team-wide-access-confirm-signup` | info |
| `service-role-in-request-handler` | info |

`--experimental` adds `policy-authenticated-not-authorized`, `admin-client-for-user-scoped-work`,
`cross-tenant-id-from-body` and `first-signup-becomes-admin` (facts checks still below the precision bar), and `--model <dir>` the model rules.

**For agents (MCP):**

```json
{ "mcpServers": { "supacheck": { "command": "npx", "args": ["supacheck", "mcp"] } } }
```

**Claude Code hook (`.claude/settings.json`):** check after migrations or Supabase code change.

```json
{ "hooks": { "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx supacheck check . --format json" }] }] } }
```

## Layout

| Path | What |
|---|---|
| `rules/*.yaml` | The 8 spike rules: question, message, fix, docs link, trigger, applicable chunk kinds |
| `data/templates/*.exs` | Positive / near-identical negative code templates per rule |
| `scripts/gen_dataset.exs` | Renders templates × tables × frameworks × surface variants into train/val/test |
| `scripts/train.exs` | Trains shared encoder + per-rule heads (Pythonx → `training/heads.py`), calibrates, exports ONNX, benches CPU |
| `scripts/eval_typed.exs` | Zero-shot Laya baseline on the same splits and gold set |
| `scripts/gold_candidates.exs` | Clones permissive repos, chunks them, pre-labels with Clef-flash, writes a review file |
| `data/gold/manifest.jsonl` | Real-code gold set: URL@commit + line + label (code is fetched, never committed) |
| `cli/` | TypeScript CLI: chunker, ONNX runtime, `check`, `chunks`, benchmarks, gold evaluation |

## Spike workflow

```sh
mise install                                   # node 24, python 3.12, elixir 1.19, uv

elixir scripts/gen_dataset.exs                 # data/generated/{train,val,test}.jsonl
(cd cli && pnpm install && pnpm validate-samples)   # every sample must parse (oxc / libpg_query)

elixir scripts/train.exs --base answerdotai/ModernBERT-base --name modernbert-base
elixir scripts/train.exs --base jinaai/jina-embeddings-v2-base-code --name jina-code

(cd cli && pnpm bench ../artifacts/modernbert-base)               # TS runtime latency
(cd cli && pnpm tsx src/eval-gold.ts ../artifacts/modernbert-base) # real-code gold set
elixir scripts/eval_typed.exs                                       # zero-shot Laya baseline

# teacher pre-labels for gold review (Clef-flash, Apache-2.0, local)
llama-server -m models/Clef-Flash-Q8_0.gguf --port 8089 --parallel 4 -c 32768
elixir scripts/gold_candidates.exs --skip-clone

(cd cli && pnpm dev check path/to/project --model ../artifacts/modernbert-base)
```

Language choices: TypeScript for the CLI and runtime; Elixir `.exs` for data generation and
orchestration; Python only inside Pythonx for torch/transformers training code (no
equivalent ecosystem in Elixir).
