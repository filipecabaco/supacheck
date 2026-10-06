# supacheck: internal showcase

**A local, offline checker for Supabase projects that catches the security mistakes behind most
real incidents before they ship.** It reads SQL migrations and supabase-js code and explains every
finding with the facts it rests on. It's built for people and for coding agents.

## Why

| Source | Finding |
|---|---|
| Lovable CVE-2025-48757 | ~10% of 1,645 apps had missing or broken RLS |
| Symbiotic (Jun 2026) | 98% of 1,072 vibe-coded Supabase apps had at least one issue, 16% critical |
| Wiz / Moltbook | RLS off: 1.5M API tokens exposed |

Agents are now the main way people build on Supabase: Stack Overflow questions fell from 832 in
2023 to 34 in 2026. Nothing checks the supabase-js side today; Splinter needs a live database and
can't see TypeScript.

## Try it (no install, no publish)

```sh
# from a clone of this repo
node cli/dist/cli.js check examples/demo-app

# or straight from GitHub once pushed (replace <org>)
npx -y github:filipecabaco/supacheck check path/to/your/project
npx -y github:filipecabaco/supacheck check . --format json     # for agents / scripts
npx -y github:filipecabaco/supacheck check . --format sarif    # GitHub code scanning
```

`examples/demo-app` is a small Supabase project with one seeded issue per rule. `cd cli && pnpm test`
checks that supacheck finds exactly those (17 findings).

## What a finding looks like

```
supabase/migrations/20261101000000_init.sql:82  [critical] definer-function-no-caller-check
  because: security definer; 1 parameter(s) used in the body; never checks the caller;
           executable by anon/authenticated in exposed schema public
  A security definer function bypasses RLS and trusts caller-supplied parameters without checking the caller.
  fix: Check the caller inside the body (where user_id = (select auth.uid())), move it to a non-exposed
       schema, and revoke execute from public, anon, authenticated.
  don't: revoke execute only from public (anon/authenticated keep access on Supabase)
  https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker
```

The `don't:` line tells agents which "fixes" not to apply: disabling RLS, `GRANT ALL` to anon, and
adding `security definer`. These are the shortcuts agents reach for when they hit permission errors.

## How it works

1. **Fact store.** Replays every migration with the real Postgres parser (libpg_query): tables,
   RLS state, policies, grants and revokes, functions, exposed schemas from `config.toml`. Builds the
   TypeScript import graph: which files are server-only, what imported helpers really do
   (unverified `getSession()`, service-role client), and `verify_jwt` per Edge Function.
2. **Facts-first rules.** Each rule is a deterministic check over those facts, so every finding can
   say *why*. Cross-file facts are the point: a function whose EXECUTE is revoked three migrations
   later isn't a finding.
3. **Optional model.** A small fine-tuned encoder (ModernBERT-base, ~600 MB, ~40 ms/chunk on CPU)
   for judgement calls, behind `--experimental --model`. It isn't on by default because it hasn't
   reached the precision bar on real code yet.

## Rules on by default

| Rule | Severity | Measured on reviewed real code |
|---|---|---|
| definer-function-no-caller-check | critical | 25/25 correct |
| user-metadata-for-authorization | critical | precision 1.00, recall 0.75 |
| server-trusts-getsession | high | precision 1.00, recall 0.83 |
| rls-disabled-on-exposed-table | critical | new: top field issue, not yet gold-validated |
| grant-write-without-rls | critical | corpus sanity-checked |
| rls-policy-always-true-write | high | new: top field issue (8/54 repos), not yet gold-validated |
| service-role-policy-without-to | high | new (6/54 repos in field survey), not yet gold-validated |
| select-true-on-private-data | warning | recall 1.00, precision 0.50 (misses are intent questions) |
| missing-api-grants-new-table | warning | for the 2026-10-30 default-privilege change |
| ef-service-role-trusts-body-identity | warning | precision 0.75, recall 0.50 |
| single-where-maybe-single | info | precision 0.84 |
| service-role-in-request-handler | info | precision 0.95 |
| team-wide-access-confirm-signup | info | precision 0.80 |

"Reviewed real code" is 300+ chunks from about 30 open-source repos, labelled by security-review
agents with repo facts visible, plus human review.

## For agents

```json
{ "mcpServers": { "supacheck": { "command": "npx", "args": ["-y", "github:filipecabaco/supacheck", "mcp"] } } }
```

Claude Code hook: run `supacheck check . --format json` after edits to migrations or Supabase code.
See the README.

## Honest status

- **Spike.** Not published to npm; run it from the repo.
- **Facts beat the model.** On the same 242 reviewed items, facts-first rules reach precision 0.84
  against 0.37 for the best model alone. The model stays experimental.
- **Still validating:** several new rules need a review round. No suppression comments or `--diff`
  mode yet.
- **Full research and numbers:** [PLAN.md](PLAN.md), [docs/spike-results.md](docs/spike-results.md),
  [knowledge/research/](knowledge/research/README.md).
