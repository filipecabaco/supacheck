# Anti-pattern research: index and synthesis

Internet research on problems Supabase users actually hit (2026-10-05). It feeds the
knowledge layer (PLAN.md §3). These are **candidates**: each still needs owning-team
review and an evidence test in a fake project before it becomes a shipped rule.

| File | Area | Items |
|---|---|---|
| [sql-rls.md](sql-rls.md) | RLS, policies, grants, functions, views, schema | 24 + 4 minor |
| [auth-ssr-keys.md](auth-ssr-keys.md) | Auth, SSR/cookies, API keys, client setup | 21 |
| [storage-realtime-functions.md](storage-realtime-functions.md) | Storage, Realtime, Edge Functions, Cron/Queues | 22 + 4 candidates |
| [data-api-queries.md](data-api-queries.md) | supabase-js queries, errors, types, pooling, plus the pain-point landscape and incident studies | 20 + 5 minor |
| [prior-art-tools.md](prior-art-tools.md) | ~30 existing scanners and linters: coverage matrix, gaps, reusable fixtures, licences | coverage of 38 ids |
| [field-survey.md](field-survey.md) | 63 real GitHub repos: usage map, measured prevalence, hard negatives, corpus licences | prevalence of 17 rules |
| [blogs-tutorials.md](blogs-tutorials.md) | 26 tutorials audited, ~20 new candidates, production themes, official blog sources | ~20 new |
| [community-and-ai-codegen.md](community-and-ai-codegen.md) | 867 Stack Overflow questions, 2,846 Reddit posts, AI-builder prompts and output | 13 new |

There are ~87 raw items and **~80 after merging duplicates**. The merges:
- service key in client: auth #1, storage #2, data #15a
- module-scope server client: auth #5, functions #10, data #14
- user_metadata for authorization: auth #4, sql #4
- client per render: auth #13, data #13
- SSR client with service key: auth #7, data #15b

## What the research says

1. **The worst incidents share one root cause.** Lovable CVE-2025-48757 (~10% of 1,645
   apps), Escape.tech (5,600 apps), Wiz/Moltbook (1.5M tokens), and Symbiotic (98% of
   1,072 apps with at least one issue, 16% critical) all trace back to:
   - missing RLS
   - `using (true)` write policies
   - service keys in the bundle

   AI-built apps are a large and growing share of the user base.
2. **A public anon or publishable key is by design.** Flagging it is the most common
   false positive in existing scanners. Don't.
3. **Most anti-patterns are not deterministic, but many aren't semantic either. They are
   cross-file.** They need facts from elsewhere:
   - is this file server or client?
   - is RLS enabled in some migration?
   - is this bucket public?
   - is `verify_jwt` off?

   A **fact store** (below) carries more of the linter than the model does.
4. **There is a lot of static value beyond Splinter.** Recursion (42P17), incomplete
   revokes, signup-breaking triggers, FK `on delete`, missing grants after the
   **2026-10-30** default-privilege change, update-without-select, and missing `TO`
   clauses have no Splinter lint, and several are invisible even on a live DB.
5. **Time-sensitive:** `missing-api-grants-new-table`. From 2026-10-30, existing projects
   and CLI migrations stop auto-granting new public tables. Expect a wave of `42501`
   errors, and of "fixes" that add `GRANT ALL … TO anon` on tables without RLS.

## Round 2: validated in the wild (field survey, community, tutorials, prior art)

The first round ranked items by what the docs and incident reports say. Round 2 checked
real code (63 repos, every hit read in context), community volume (867 Stack Overflow
questions, 2,846 Reddit posts), 26 tutorials, and ~30 existing tools. It changes the
ranking:

**Measured prevalence** (confirmed hits / repos where the rule applies):

| Rule | All | AI-built | Starters | Takeaway |
|---|---|---|---|---|
| `rls-policy-always-true` (writes, net) | **8/54** | **4/14** | 0/15 | **New #1.** Lovable enables RLS everywhere now, so the risk moved from "RLS off" to "RLS on with `true`" |
| ↳ "Service role can …" policy without `TO service_role` (ever) | 6 | 1 | 0 | distinct, greppable sub-check |
| `server-trusts-getsession` | **7/63** | 0/17 | 2/17 | includes an 814★ starter; ~50% of server call sites are legitimate, so **needs Laya** |
| `policy-authenticated-not-authorized` (writes) | 4–5 | 1 | 0 | single-tenant apps make it legitimate: S judgement |
| `rls-disabled-on-exposed-table` | 3/54 | 1/14 | 1/15 | rarer than the incidents suggest; comes from Drizzle and hand-written SQL, so the fact store must read those |
| `user-metadata-for-authorization` | 3/63 | 1 | 0 | includes a signup trigger copying `role` from metadata (sign up as admin) |
| `ef-service-role-trusts-body-identity` | 2/18 | 1/5 | 0/4 | both with `verify_jwt=false`; widen to resource ids and shared secrets |
| `service-key-in-client` | **0 live** | 0 | 0 | all 20 literal hits were local demo keys or fixtures; GitHub push protection catches `sb_secret_`. Demote; focus on the import-graph path |
| `realtime-channel-not-removed` | 0/22 | | | demote |
| `client-per-render` | 0/63 | | | demote (the `createClient()` wrapper over `createBrowserClient` is a guaranteed FP) |
| `ef-missing-cors-preflight` | 0/18 | | | demote (preflight lives in `_shared/cors.ts`, Hono, or middleware) |
| `auth-function-not-wrapped-in-select` | **36/36** | | | ubiquitous: info level + autofix, aggregate per file |
| `ignored-query-error` | **38/63** | | | including the official examples: info level, raise only on mutations or unchecked dereference |
| `security definer` without `search_path` | 22/37 | | | mostly copied from Supabase's own `handle_new_user` example |

**Other round-2 findings:**
- **Nobody lints the TypeScript side.** There is a 4-rule ESLint plugin and an unmerged
  Semgrep PR, nothing in the Semgrep registry or CodeQL, and no tool that joins TS facts
  with schema facts. About 14 of our ids have zero prior art. `missing-api-grants-new-table`
  is uncovered; a static rule shipped before 2026-10-30 would be first.
- **Help-seeking moved to AI.** Stack Overflow `supabase` questions peaked at 832 in 2023,
  fell to 206 in 2025, and number 34 so far in 2026. Agents really are the main consumer.
- **AI builders produce a distinct stack.** 0/17 AI-built repos use Next.js or
  `@supabase/ssr` (Vite React SPA or TanStack Start). Bolt's prompt *requires* email
  confirmation off and shows an unwrapped `auth.uid()` example. General agents fall back on
  stale patterns (auth-helpers, server `getSession`).
- **Official samples spread anti-patterns too.** The quickstart avatar policy lets anon
  upload; Vercel's `with-supabase` `/auth/confirm` has an open redirect on `next`;
  Astro's guide shares a module-scope client. Agree expected behaviour with the owning
  teams before rules fire on these.
- **Supabase's agent skill already states most top rules,** but its own eval shows 50–88%
  pass rates with the skill loaded. A *verification* step is the gap supacheck fills.
- **False-positive trap confirmed:** an UPDATE policy without WITH CHECK reuses USING, so
  a USING-only ownership policy is safe. Several blogs say otherwise.

**New candidate rules (round 2, to triage into the knowledge base):**
- **From the community and AI codegen**:
  - `migration-weakens-security`: a later migration disables RLS, adds `using (true)`,
    definer functions or anon grants. This is how agents "fix" errors.
  - `insert-missing-owner-column`
  - `policy-ignores-is-anonymous`
  - `auth-email-confirmation-disabled`
  - `schema-not-exposed-in-config`
  - `rpc-args-mismatch-function-signature`
  - `embedded-filter-without-inner`
  - `mutation-result-without-select`
  - `supabase-env-not-public-in-client`
- **From tutorials and production write-ups**:
  - `orm-connection-bypasses-rls`: Prisma or Drizzle connecting as `postgres`
  - `session-level-set-role-on-pooled-connection`
  - `realtime-client-asserted-identity`
  - `realtime-channel-name-as-authorization`
  - `webhook-signature-not-verified`
  - `db-webhook-unauthenticated`
  - `ef-open-relay`
  - `spread-client-input-into-write`
  - `mfa-aal-not-enforced`
  - `delete-user-without-session-revoke`
  - `network-extension-exposed` (SSRF)
- **From prior art**:
  - scalar-subquery membership policies (21000 once a user is in two teams)
  - OR-ed WITH CHECK across policies
  - column grants defeated by a table-wide grant
  - INSERT policy without a SELECT policy (`.insert().select()` fails with 42501)
  - dynamic `.rpc()` names
  - ignored `getUser()` error

**Implications for the CLI and plan:**
- **Tell agents which fixes not to take.** Findings should list the unsafe "fixes" to
  avoid (disable RLS, add `security definer`, `GRANT ALL` to anon), because those are
  what agents reach for.
- **Report missing schema files.** When a repo has none (~20% of Lovable repos), say so
  instead of passing silently.
- **Report new findings only.** Flag only what a change introduces, with stable
  `cache_key` allowlists like Splinter's, plus SARIF output.
- **Parse properly.** Use a real SQL parser (libpg_query or the postgres-language-server
  crates, the natural place to upstream SQL rules), and read Drizzle `pgTable`
  definitions into the fact store.
- **Test SQL rules against Splinter.** Run Splinter on a shadow DB replayed from the
  migrations as the oracle for our static SQL rules.
- **Corpus licences.** 26 permissively licensed repos are usable, but only 2/17 AI-built
  ones, so AI-pattern training data must come from fake projects that copy the Lovable
  patterns. Reusable fixtures: rlsautotest (Apache-2.0), the ESLint plugin's 105 tests
  and SupaShield (MIT), pgspot. **Splinter has no licence file:** fine if supacheck is a
  Supabase project, otherwise ask for one. Don't copy Semgrep registry rules or
  trufflehog (AGPL).
- **Fake-project matrix.** Weight it to the measured usage: Next.js 16 + ssr 0.12; Vite
  React (Lovable); TanStack Start (new Lovable template); both key eras; Drizzle and
  declarative-schema layouts. See `field-survey.md` §6.

## Ranked shortlist (severity × frequency, merged; round 1, see round 2 adjustments above)

Detection labels:
- **D**: deterministic (AST or regex).
- **X**: cross-file facts.
- **S**: semantic (Laya).

### Security
| # | id | Detection | Source |
|---|---|---|---|
| 1 | `rls-disabled-on-exposed-table` | X | sql #1 |
| 2 | `rls-policy-always-true` | D (writes) / S (is a SELECT intended public?) | sql #2 |
| 3 | `service-key-in-client` | D (env names, literals) + X (import graph) | auth #1, storage #2, data #15a |
| 4 | `ef-service-role-trusts-body-identity` | **S** + X (`verify_jwt`) | functions #1 |
| 5 | `server-trusts-getsession` | D (location) + **S** (used for authorization?) | auth #2 |
| 6 | `policy-authenticated-not-authorized` | **S** (D for literal forms) | sql #3 |
| 7 | `user-metadata-for-authorization` | D (policies) + **S** (function and trigger bodies, TS) | sql #4, auth #4 |
| 8 | `security-definer-function-exposed` | X + **S** (body checks the caller?) | sql #5, #6 |
| 9 | `storage-policy-not-owner-scoped` | D + S (helper functions) | storage #3 |
| 10 | `write-policy-missing-ownership-check` | D + **S** (which column is the owner?) | sql #9 |
| 11 | `module-scope-server-client` | X (server context) + D | auth #5, functions #10, data #14 |
| 12 | `jwt-decode-without-verification` | D + **S** (does it gate access?) | auth #3 |
| 13 | `view-missing-security-invoker` / `auth-users-exposed` | D | sql #7, #8 |
| 14 | `self-updatable-privilege-column` | X + **S** (is the column privilege-bearing?) | sql #10 |
| 15 | `private-data-in-public-bucket` | **S** (sensitivity) + X | storage #4 |
| 16 | `realtime-public-channel-for-private-data` | **S** + D + X | storage #9 |
| 17 | `admin-client-for-user-scoped-work` | **S** + X | data #15b, auth #7 |
| 18 | `unescaped-postgrest-filter-string` | D (+X: service-role client) | data #18 |
| 19 | `cron-hardcoded-secret-key` | D | functions #12 |

### Correctness, high frequency
| # | id | Detection | Source |
|---|---|---|---|
| 20 | `missing-api-grants-new-table` (time-sensitive) | X | sql #18 |
| 21 | `ignored-query-error` | D | data #1 |
| 22 | `rls-enabled-no-policy` | X (+S: intended service-only?) | sql #11 |
| 23 | `recursive-rls-policy` | X (policy graph) | sql #14 |
| 24 | `auth-users-trigger-fragile` | D + X | sql #15 |
| 25 | `update-policy-without-select-policy` / `unchecked-mutation-effect` | X + S | sql #13, data minor |
| 26 | `single-where-maybe-single` | **S** | data #2 |
| 27 | `onauthstatechange-async-deadlock` | D | auth #8 |
| 28 | `ssr-cookie-adapter-broken` / `middleware-session-refresh-missing` | D + X | auth #9, #10 |
| 29 | `realtime-channel-not-removed` / `client-per-render` | D | storage #7, auth #13, data #13 |
| 30 | `storage-upsert-missing-policies` | X | storage #6 |
| 31 | `serverless-direct-db-without-pooler` | X | data #16 |
| 32 | `ef-missing-cors-preflight` | D | functions #11 |
| 33 | `fk-to-auth-users-blocks-deletion` | D (+S: cascade vs set null) | sql #17 |
| 34 | `deprecated-auth-helpers` | D | auth #11 |

### Performance and cost
`auth-function-not-wrapped-in-select` (D), `policy-column-not-indexed` (X),
`policy-missing-to-role` (D), `n-plus-one-queries` (D),
`unbounded-select-silent-truncation` (**S**), `client-side-filtering` (**S**),
`count-exact-on-large-table` (D/S), `realtime-unfiltered-postgres-changes-at-scale`
(D/S), `row-by-row-writes` (D).

## Where Laya is actually needed

These need judgement about meaning, which AST, regex and facts alone can't supply. They
are the **training targets**, and the spike's 8 rules should come from here:

| Laya question (what the text says, not what to do) | Rule |
|---|---|
| Does this function verify the caller before using the user id from the request body? | `ef-service-role-trusts-body-identity` |
| Is the `getSession()` result used to decide access, or only for display? | `server-trusts-getsession` |
| Does this policy restrict rows to an owner or tenant, or only to "signed in"? | `policy-authenticated-not-authorized` |
| Is this metadata field used to grant permissions, or only shown to the user? | `user-metadata-for-authorization` |
| Does this definer function check who is calling it? | `security-definer-function-exposed` |
| Is this table intended to be readable by everyone? | `rls-policy-always-true` (SELECT) |
| Which column identifies the row's owner? | `write-policy-missing-ownership-check` |
| Does this column grant privileges (role, plan, credits)? | `self-updatable-privilege-column` |
| Do the files in this bucket look private or sensitive? | `private-data-in-public-bucket` |
| Does this channel carry private data between specific users? | `realtime-public-channel-for-private-data` |
| Does the decoded token decide access? | `jwt-decode-without-verification` |
| Is this server code reading or writing data on behalf of a specific user? | `admin-client-for-user-scoped-work` |
| Can this lookup legitimately find no row? | `single-where-maybe-single` |
| Is this result used as if it contained all rows (sum, count, export)? | `unbounded-select-silent-truncation` |
| Are these writes meant to succeed or fail together? | `non-atomic-multi-step-write` |
| Does this code assume the user is signed in right after `signUp`? | `signup-confirmation-misread` |
| Is this table meant to be reachable only with the service key? | `rls-enabled-no-policy` |

Note the phrasing: perception questions about the code ("does X check Y"), per the Laya
guidance. Deterministic facts (server or client, RLS on or off, bucket public) are
computed first and stated in the state header in words.

## Fact store the linter needs (union across areas)

- **Per file**:
  - server or client context: `'use client'`, `'use server'`, Next/SvelteKit/Remix file
    conventions, `*.server.ts`, Express handlers, Edge Functions dir
  - framework and version from `package.json`
  - React Native / Expo project flag
- **Import graph**: does an admin client reach a client file?
- **Schema replay** over `supabase/migrations/*.sql` and `supabase/schemas/*.sql`:
  - per table: exposed schema (from `config.toml [api] schemas`), RLS on or forced,
    policies net of drops (command, roles, permissive, qual and check ASTs), grants,
    default privileges, indexes, FKs with on-delete, NOT NULL and defaults, publication
    membership, replica identity
  - per function: definer, `search_path`, EXECUTE ACL
  - per view: `security_invoker`
  - buckets → public flag; `storage.objects` policies per bucket and operation;
    `realtime.messages` policies
- **Config**: `supabase/config.toml` (`verify_jwt` per function, exposed schemas),
  env-var names and connection strings, deploy target (serverless or not).

## Known false-positive traps
- A public anon or publishable key.
- Browser-side module singletons, which are correct; only flag module scope on the server.
- `getSession()` in browser code.
- SvelteKit `safeGetSession`.
- A no-op `setAll` in Server Component clients.
- A secret-key `createClient` with `persistSession: false`, which is the correct admin
  client.
- `SELECT using (true)` on genuinely public catalogue tables.
- Tables added to the realtime publication via the dashboard (warn, don't error).
- Both API generations must count as correct: anon/service_role and publishable/secret;
  manual CORS/JWT handling and `withSupabase`.

## Research gaps
- **Missing sources**: no Reddit (the fetcher is blocked) and thin Stack Overflow
  evidence. A second pass is worth doing via other means.
- **Rate limits**: GitHub search rate-limited in two of the four runs, so frequency
  signals are partial.
- **Unverified claims** are marked in each file.
