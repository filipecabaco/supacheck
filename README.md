# supacheck

**Catch the Supabase security mistakes behind real incidents, before you ship them.**

supacheck reads your SQL migrations and supabase-js code, runs on your machine, and explains every
finding with the facts it rests on, the fix, and the tempting "fixes" to avoid. It's built for people
and for coding agents.

```sh
npx -y github:filipecabaco/supacheck check .
```

Run it from your project root (the folder that contains `supabase/`). You need Node 22 or newer.
Nothing else to install or configure, and no code leaves your machine. The first run downloads the
model (1.7 GB, once); after that everything runs offline.

supacheck pairs deterministic rules with a small fine-tuned model: the rules settle what the facts
in your migrations and code can prove, and the model makes the judgement calls they can't.

## What you'll see

```
┌  supacheck 0.1.0-internal  checking acme-orders
│
◇  SQL    1 file · 3 tables · 4 policies · 1 function  10ms
◇  Code   4 files · 13 rules checked  3ms
◇  Model  laya-v1 · 1.69 GB cached in ~/.cache/supacheck/models/model-laya-v1  1ms
◇  Load   Laya decision model ready (ONNX Runtime, CPU)  602ms
◇  Chunks 7 chunks for the model  4ms
◇  Score  7 chunks scored · 2 rules · 4 findings experimental  943ms
│
■  CRITICAL · 4
│
●  user-metadata-for-authorization  ×2
│  user_metadata can be changed by the user (updateUser, sign-up options), so using it for
│  authorization is privilege escalation.
│
│  app/dashboard/page.ts:6
│    5 │   const { data: { user } } = await supabase.auth.getUser()
│  ▶ 6 │   if (user?.user_metadata?.role !== 'admin') return 'forbidden'
│    7 │   const { data: profile } = await supabase.from('profiles').select('*')…
│  why   user_metadata.role decides access (user-writable)
│
│  fix   Store authorization data in app_metadata or a roles table that users cannot write.
│  don't validate the metadata value in the frontend
│        move the check into user_metadata of the JWT (still user-writable)
│  docs  https://supabase.com/docs/guides/database/postgres/row-level-security
│
└  ✖ 4 critical · 2 high · 3 warning · 2 info  5 files · 32ms
   Exit 1: critical and high findings block CI.
```

Findings are grouped by severity, then by rule. Each one shows:

- **The code:** the line that triggered it, with context.
- **why:** the facts behind it, gathered across your whole project. A function whose `EXECUTE` is
  revoked three migrations later is not reported.
- **fix:** what to change.
- **don't:** fixes that make things worse, such as disabling RLS, `GRANT ALL` to anon, or revoking
  only from `public`.

Try it on the bundled demo project, which has one seeded issue per rule:

```sh
git clone https://github.com/filipecabaco/supacheck && cd supacheck
npx -y github:filipecabaco/supacheck check examples/demo-app
```

## Usage

```sh
supacheck check [dir] [options]     # dir defaults to the current directory
supacheck mcp                       # MCP server for coding agents (stdio)
supacheck --help
```

| Option | What it does |
|---|---|
| `-f, --format <text\|json\|sarif>` | `text` (default) for people; `json` lists every finding for agents and scripts; `sarif` for GitHub code scanning |
| `--strict` | Exit 1 on any finding, not just critical and high |
| `--experimental` | Add rules that are still being validated |
| `--all-grants` | Also report missing grants on tables created before 2026-10-30 |
| `--model-dir <dir>` | Use a local model directory instead of the release download (see [The model](#the-model)) |

A monorepo? Point it at the app folder: `supacheck check apps/web`. Each `supabase/` project is
analysed on its own, so vendored examples and sibling apps don't mix.

**Exit codes:** `0` clean, or only warnings and info; `1` critical or high findings (any finding with
`--strict`); `2` usage error, or the model could not be downloaded or loaded.

**What gets scanned:** SQL, TypeScript and JavaScript files that git tracks or would track
(`.gitignore` is respected), excluding `node_modules`, build output and tests. To skip more, add a
`.supacheckignore` file with one path prefix per line.

**Colour and progress** appear only in an interactive terminal. Piped output and CI get the same
report without escape codes, and `NO_COLOR` / `FORCE_COLOR` are honoured.

**Getting the newest version:** npx caches git installs. Run
`npx -y github:filipecabaco/supacheck#main check .` to pull the latest commit.

## In CI

GitHub code scanning, with findings shown inline on pull requests:

```yaml
# .github/workflows/supacheck.yml
name: supacheck
on: [push, pull_request]
permissions:
  contents: read
  security-events: write
jobs:
  supacheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 22 }
      - run: npx -y github:filipecabaco/supacheck check . --format sarif > supacheck.sarif
        continue-on-error: true
      - uses: github/codeql-action/upload-sarif@v4
        with: { sarif_file: supacheck.sarif }
```

Or simply fail the build: `npx -y github:filipecabaco/supacheck check .` exits 1 on critical and
high findings. The same command works as a pre-commit hook.

## With coding agents

**MCP:** give your agent a `supacheck_check` tool.

```json
{ "mcpServers": { "supacheck": { "command": "npx", "args": ["-y", "github:filipecabaco/supacheck", "mcp"] } } }
```

**Claude Code hook** (`.claude/settings.json`): check automatically after every edit.

```json
{ "hooks": { "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx -y github:filipecabaco/supacheck check . --format json" }] }] } }
```

The `don't` lists are there on purpose. Agents tend to "fix" permission errors by disabling RLS or
granting everything to anon, and supacheck tells them not to.

## What it checks

| Rule | Severity | Catches |
|---|---|---|
| `rls-disabled-on-exposed-table` | critical | A table reachable through the Data API with RLS never enabled |
| `grant-write-without-rls` | critical | anon/authenticated can write a table that has no RLS (the classic "fix" for 42501) |
| `definer-function-no-caller-check` | critical | A `security definer` function callable over `/rpc` that trusts its parameters |
| `user-metadata-for-authorization` | critical | Roles or permissions taken from user-writable `user_metadata` (policies, triggers, code) |
| `rls-policy-always-true-write` | high | Insert/update/delete policies that are always true |
| `service-role-policy-without-to` | high | "Service role can…" policies with no `TO service_role`, which actually open the table to everyone |
| `server-trusts-getsession` | high | Server code deciding access from `getSession()`, directly or through a helper, without `getUser()`/`getClaims()` |
| `select-true-on-private-data` | warning | Personal or per-user tables readable by everyone, including private storage buckets |
| `ef-service-role-trusts-body-identity` | warning | Edge Functions acting on an id from the request body with the service role, without verifying the caller |
| `missing-api-grants-new-table` | warning | Policies without grants: Data API calls fail with 42501 after the 2026-10-30 default change |
| `single-where-maybe-single` | info | `.single()` on lookups that can legitimately return no rows |
| `service-role-in-request-handler` | info | Service-role clients inside request handlers (every check is then hand-written) |
| `team-wide-access-confirm-signup` | info | Tables every signed-in user can access: confirm sign-up is restricted |

With `--experimental`: `policy-authenticated-not-authorized`, `admin-client-for-user-scoped-work`,
`cross-tenant-id-from-body` and `first-signup-becomes-admin` (all high), which are still being
validated against real projects.

## The model

Every check runs a fine-tuned [Laya](https://github.com/NandhaKishorM/laya) decision model
(ModernBERT-large) for judgement calls the facts can't settle, such as whether a service-role client
is doing per-user work. It runs locally with ONNX Runtime, and the progress view shows each step:
finding or downloading the model, loading it, picking the chunks the rules left open, and scoring them.

- **First run:** downloads the model pinned to this CLI version from
  [GitHub Releases](https://github.com/filipecabaco/supacheck/releases/tag/model-laya-v1)
  (1.7 GB, with progress, speed and time left). Every part is verified by sha256, a part that stalls
  for 20 seconds is retried, and an interrupted download resumes where it stopped.
- **After that:** runs offline from `~/.cache/supacheck/models` (set `SUPACHECK_CACHE` to move it).
- **If it can't load,** the run exits with code 2 instead of silently falling back to the rules.

Treat model findings as leads, not verdicts. On held-out projects the model reaches precision 0.27,
well below the rule checks, and its findings are labelled `model · experimental` in the report.

## How it works

1. **Facts.** supacheck replays your migrations with the real Postgres parser (libpg_query) and
   tracks tables, RLS, policies, grants and revokes, functions, and exposed schemas. It also builds
   the TypeScript import graph: which files are server-only, what your helpers really do, and
   `verify_jwt` for each Edge Function.
2. **Rules.** Deterministic checks run over those facts. That's why every finding can say *why*,
   and why precision is high on real code.
3. **Model.** The model answers each rule's question for code chunks the facts leave open.

## Status

This is an early spike, run from GitHub and not published to npm. The default rules were measured
against 300+ reviewed chunks from about 30 open-source Supabase projects: the rule checks reach
precision 0.84 overall, against 0.37 for the best model alone. Suppression comments and a `--diff`
mode are planned.

Found a false positive or a missed issue? [Open an issue](https://github.com/filipecabaco/supacheck/issues)
with the finding and the file.

---

### Developing supacheck

| Path | What |
|---|---|
| `cli/src/` | The CLI: `cli.ts` (commands), `tui.ts` (terminal report), `check.ts`, fact stores (`facts.ts`, `tsfacts.ts`), rules (`checks.ts`), `mcp.ts`, model download (`model.ts`) and scoring (`scorer.ts`) |
| `rules/*.yaml` | Rule metadata: message, fix, don'ts, docs link, severity, engine, model question |
| `examples/demo-app/` | Demo project and `expected-findings.json`, the regression test |
| `scripts/`, `training/`, `data/` | Model pipeline: data generation and training (Elixir with Pythonx), gold set |
| `cli/src/{gold,review-server,eval-*,candidates*,mutate,bench}.ts` | Dev tools for the gold set and evaluation (not shipped) |

```sh
mise install && cd cli && pnpm install
pnpm build        # compiles to cli/dist (committed, so npx needs no build step)
pnpm test         # demo-app findings must match expected-findings.json
pnpm review-web   # gold-set review UI (http://127.0.0.1:4321)
```

**Shipping a new model:** export it to ONNX, split it into release parts, then publish under a new
tag and bump `MODEL_TAG` in `cli/src/model.ts`. Tags are immutable because the cache is keyed by
tag.

```sh
elixir scripts/train_laya.exs --export artifacts/laya-supacheck        # → artifacts/laya-supacheck-onnx
node cli/dist/pack-model.js artifacts/laya-supacheck-onnx model-laya-v2 laya /tmp/release \
  encoder.onnx head.onnx tokenizer.json rl_agent_config.json supacheck.json
gh release create model-laya-v2 /tmp/release/* --title model-laya-v2 --notes "…"
```
