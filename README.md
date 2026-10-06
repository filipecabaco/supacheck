# supacheck

**Catch the Supabase security mistakes behind real incidents before you ship them.**
supacheck reads your SQL migrations and supabase-js code, runs locally and offline, and explains every
finding with the facts it rests on. It's built for people and for coding agents.

```sh
npx -y github:filipecabaco/supacheck check .
```

Run it from your project root, the folder that contains `supabase/`. Requires Node 22+. Nothing to
install or configure, and no code leaves your machine.

## What you get

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

Every finding tells you:
- **because:** the facts that triggered it, gathered across your whole project. For example, a
  function whose EXECUTE is revoked three migrations later is not reported.
- **fix:** what to change.
- **don't:** tempting "fixes" that make things worse, such as disabling RLS, `GRANT ALL` to anon, or
  revoking only from `public`.

## Try it on the demo

```sh
git clone https://github.com/filipecabaco/supacheck && cd supacheck
npx -y github:filipecabaco/supacheck check examples/demo-app
```

`examples/demo-app` is a small Supabase project (migrations, a Next.js route, an Edge Function) with
one seeded issue per rule.

## Options

```sh
npx -y github:filipecabaco/supacheck check .                  # human-readable (max 5 findings shown per rule)
npx -y github:filipecabaco/supacheck check . --format json    # everything, machine-readable (agents, scripts)
npx -y github:filipecabaco/supacheck check . --format sarif   # GitHub code scanning
npx -y github:filipecabaco/supacheck check . --strict         # fail on warnings too
npx -y github:filipecabaco/supacheck check apps/web           # monorepo: point at the app folder
npx -y github:filipecabaco/supacheck check . --all-grants     # also report missing grants on older tables
npx -y github:filipecabaco/supacheck check . --experimental   # add rules still being validated
```

**Exit codes:** `0` clean or only warnings and info, `1` critical or high findings (any finding with
`--strict`), `2` usage error. So it drops straight into CI or a pre-commit hook.

**What gets scanned:** files git tracks or would track (`.gitignore` is respected), excluding
`node_modules`, build output and tests. Add a `.supacheckignore` file (one path prefix per line) to
skip more. Each `supabase/` project is analysed on its own, so monorepos and vendored examples don't
mix.

**Latest version:** npx caches git installs. Use `npx -y github:filipecabaco/supacheck#main check .`
to pull the newest commit.

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

## Use it with coding agents

**MCP:** give your agent a `supacheck_check` tool.

```json
{ "mcpServers": { "supacheck": { "command": "npx", "args": ["-y", "github:filipecabaco/supacheck", "mcp"] } } }
```

**Claude Code hook (`.claude/settings.json`):** check automatically after edits.

```json
{ "hooks": { "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx -y github:filipecabaco/supacheck check . --format json" }] }] } }
```

Findings include the `don't:` list on purpose. Agents tend to "fix" permission errors by disabling
RLS or granting everything to anon, and supacheck tells them not to.

## How it works

1. **Facts:** it replays your migrations with the real Postgres parser (libpg_query) and tracks
   tables, RLS, policies, grants and revokes, functions, and exposed schemas. It also builds the
   TypeScript import graph: which files are server-only, what your helpers really do, and
   `verify_jwt` per Edge Function.
2. **Rules:** deterministic checks over those facts. That's why every finding can say *why*, and why
   precision is high on real code.
3. **Model (optional, experimental):** a small local encoder for judgement calls
   (`--experimental --model <dir>`). It's off by default until it meets the precision bar, and it
   isn't distributed yet.

## Status

This is an internal spike, run from GitHub and not published to npm. The default rules were measured
against 300+ reviewed chunks from about 30 open-source Supabase projects. Facts-first rules reach
precision 0.84 overall, against 0.37 for the best model alone. Some newer rules are still being
validated. Suppression comments and a `--diff` mode are planned.

Found a false positive or a missed issue? Open an issue with the finding and the file.

---

### Developing supacheck

| Path | What |
|---|---|
| `cli/` | TypeScript CLI: chunker, fact store (`facts.ts`, `tsfacts.ts`), rules (`checks.ts`), MCP server, review UI |
| `rules/*.yaml` | Rule metadata: message, fix, don'ts, docs link, severity, engine |
| `examples/demo-app/` | Demo project + `expected-findings.json` (`cd cli && pnpm test`) |
| `scripts/`, `training/`, `data/` | Model spike: data generation (Elixir), training via Pythonx, gold set |
| [SHOWCASE.md](SHOWCASE.md), [PLAN.md](PLAN.md), [docs/spike-results.md](docs/spike-results.md), [knowledge/research/](knowledge/research/README.md) | Showcase, plan, measured results, research |

```sh
mise install && cd cli && pnpm install
pnpm build        # compiles to cli/dist (committed, so npx needs no build step)
pnpm test         # demo-app findings must match expected-findings.json
pnpm review-web   # gold-set review UI (http://127.0.0.1:4321)
```
