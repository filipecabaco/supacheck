# Prior art: tools that lint, scan or audit Supabase apps

Survey date: 2026-10-05. Sources: `gh search repos` and `gh api`, plus web search. Star counts
and last-push dates are from the GitHub API on that day. Ids in `backticks` refer to the
ranked list in [README.md](README.md).

**Bottom line.** All the prior art clusters in three places:
1. **Live-DB catalog lints**, led by Splinter.
2. **Live RLS testing**: pgTAP helpers, rlsautotest, SupaShield.
3. **Black-box probing** of deployed apps with the anon key.

The **TypeScript side of a Supabase app is almost untouched**. Two small exceptions exist:
- one 4-rule ESLint plugin;
- one open, unmerged Semgrep PR.

Static analysis of **migration files** without a database also has almost no
serious tooling; only regex-based scanners exist. Most of supacheck's Laya questions and
cross-file rules have no prior art at all.

---

## 1. Tool catalogue

Approach legend:
- **LIVE-SQL**: catalog queries against a running Postgres.
- **LIVE-PROBE**: SQL-level role impersonation against a running DB.
- **STATIC-SQL**: reads migration files.
- **STATIC-TS**: reads JS/TS source.
- **BLACKBOX**: HTTP probing of a deployed app.
- **LLM**: an agent or LLM decides.

### 1.1 Official Supabase tooling

#### Splinter (Supabase Postgres linter): the reference implementation
- **Where:** https://github.com/supabase/splinter. Docs at https://supabase.github.io/splinter.
- **Activity:** 279★, last push 2026-09-29. Very active, with ~20 open PRs.
- **Licence:** **none**. The repo has no LICENSE file, and the commit history shows none ever
  existed, even though the README links one. GitHub reports `null`.
- **Approach:** LIVE-SQL. Each lint is a SQL view returning a common interface:

  | Field | Notes |
  |---|---|
  | `name` | |
  | `level` | ERROR, WARN or INFO |
  | `facing` | |
  | `categories` | |
  | `detail` | |
  | `remediation` | |
  | `metadata` | |
  | `cache_key` | used for exclusions |

  The shipped artefact is one `splinter.sql`.
- **Where it runs:**
  - the Studio Security/Performance Advisor;
  - `supabase db advisors` in the CLI, being ported to native TS
    ([cli#6811](https://github.com/supabase/cli/pull/6811));
  - MCP `get_advisors`;
  - the Management API;
  - Lovable's publish scan, which integrated the Security Advisor.

  See https://supabase.com/docs/guides/database/database-advisors.
- **Lints (29 shipped)** (https://github.com/supabase/splinter/tree/main/lints):

  | # | Lint | Our id |
  |---|---|---|
  | 0001 | unindexed_foreign_keys | ~`policy-column-not-indexed` (generic) |
  | 0002 | auth_users_exposed | `auth-users-exposed` |
  | 0003 | auth_rls_initplan | `auth-function-not-wrapped-in-select` |
  | 0004 | no_primary_key | — |
  | 0005 | unused_index | — |
  | 0006 | multiple_permissive_policies | — |
  | 0007 | policy_exists_rls_disabled | — |
  | 0008 | rls_enabled_no_policy | `rls-enabled-no-policy` |
  | 0009 | duplicate_index | — |
  | 0010 | security_definer_view | `view-missing-security-invoker` |
  | 0011 | function_search_path_mutable | part of `security-definer-function-exposed` |
  | 0013 | rls_disabled_in_public | `rls-disabled-on-exposed-table` |
  | 0014 | extension_in_public | — |
  | 0015 | rls_references_user_metadata | `user-metadata-for-authorization`, policies only |
  | 0016 | materialized_view_in_api | — |
  | 0017 | foreign_table_in_api | — |
  | 0018 | unsupported_reg_types | — |
  | 0019 | insecure_queue_exposed_in_api | — |
  | 0020 | table_bloat | — |
  | 0021 | fkey_to_auth_unique | — |
  | 0022 | extension_versions_outdated | — |
  | 0023 | sensitive_columns_exposed | — |
  | 0024 | rls_policy_always_true | `rls-policy-always-true`, writes only |
  | 0025 | public_bucket_allows_listing | partial `storage-policy-not-owner-scoped` |
  | 0026 / 0027 | pg_graphql anon / authenticated table exposed | — |
  | 0028 / 0029 | anon / authenticated security definer function executable | `security-definer-function-exposed`, ACL half only |
  | 0030 | autovacuum_disabled | — |

- **Pipeline (open PRs, worth tracking):**
  - [#197](https://github.com/supabase/splinter/pull/197) `policy_without_privilege` (0031):
    a policy exists but the role lacks the table GRANT. This is the closest anyone gets to
    `missing-api-grants-new-table`.
  - [#195](https://github.com/supabase/splinter/pull/195): flag SELECT `using (true)` when
    the **policy name** claims owner or role scope. This is a name-vs-body heuristic,
    exactly the kind of semantic check Laya does better.
  - [#169](https://github.com/supabase/splinter/pull/169) (0030): read policy is true when
    an auth function is NULL.
  - #179: invalid index.
  - #173: unused replication slot.
- **How the checks are implemented, and their limits:**
  - **0024 is pure string normalisation.** It lowercases and strips whitespace, then tests
    `in ('true','(true)','1=1','(1=1)')`. It skips SELECT on purpose, because public reads
    are common. It only looks at permissive policies for anon, authenticated or public.
    `using (auth.uid() is not null)` or `using (auth.role() = 'authenticated')` pass
    silently.
  - **0015 is a `LIKE '%auth.jwt()%user_metadata%'` match** on qual and with_check. It
    never looks inside functions called from the policy. Its own comment says "false
    positives are possible".
  - **0023 matches exact column names** against a ~70-item list, and only on tables
    **without** RLS.
  - **API-exposure lints depend on `pgrst.db_schemas`.** In a plain psql session they
    silently fall back to `public`.
  - **0028/0029 report EXECUTE grants, not intent.** Every definer function callable by
    anon is flagged, whether or not its body checks `auth.uid()`.
- **Reuse:**
  - **Test fixtures.** `test/sql/*.sql` plus `test/expected/*.out` (pg_regress) give
    labelled positive and negative SQL for each lint. Example:
    [test/sql/0024](https://github.com/supabase/splinter/blob/main/test/sql/0024_rls_policy_always_true.sql)
    covers SELECT-true (not flagged), UPDATE-true (flagged), and so on. These convert
    directly into migration-file fixtures for our SQL rules.
  - **Evaluation oracle.** Splinter's output on a replayed DB is ground truth for the
    static fact store (see §4).
  - **Output contract.** Adopt the shape: `level`, `categories`, `cache_key` exclusions.
  - **Licence:** there is none, so reuse is legally "all rights reserved" unless Supabase
    owns supacheck. **Action:** if supacheck is a Supabase project, fine. If not, ask for a
    LICENSE file to be added. The README badge implies one was intended.

#### Studio Auth advisors (not in Splinter)
The dashboard also surfaces **Auth and config** advisors:
- leaked-password protection off;
- OTP expiry too long;
- insufficient MFA options;
- vulnerable Postgres version.

These come from the platform, not Splinter. *(Names are from memory of Studio and were not
verified against source this session.)* Static analogue for us: `supabase/config.toml`
`[auth]` settings. We have no ids for these today.

#### `supabase db lint` (plpgsql_check)
- **plpgsql_check:** https://github.com/okbob/plpgsql_check. 780★, pushed 2026-10-05,
  custom BSD-style licence (GitHub NOASSERTION).
- **What it does:** LIVE-SQL. It compiles PL/pgSQL bodies against the real catalog and
  reports runtime errors: unknown columns or functions, type mismatches, dead code. It
  also has a SQL-injection check for `EXECUTE` with concatenation.
- **What it misses:** no RLS, grant or Supabase semantics at all.
- **Relevance:** catches the *crash* half of `auth-users-trigger-fragile`, for example a
  trigger that references a missing column. It misses the semantic half: a failing insert
  that breaks signup, or a missing `security definer` or `search_path`.
- **CLI:** `--fail-on`, `--level`.
- Docs: https://supabase.com/docs/guides/local-development/cli/testing-and-linting

#### postgres-language-server (`pgls`)
- **Where:** https://github.com/supabase-community/postgres-language-server. 5,261★, pushed
  2026-10-05, MIT.
- **Static analyser rules (~65), all migration-safety, typecheck and style:**
  - squawk-derived lock rules: `require_concurrent_index_creation`,
    `adding_not_null_field`, `constraint_missing_not_valid`, and others;
  - destructive rules: `ban_drop_table`, `ban_update_without_where`, `ban_truncate`;
  - typecheck rules: `unknown_column`, `function_argument_mismatch`.
- **Zero static RLS or security rules.** Security comes only through a bundled
  **Splinter integration** (`crates/pgls_splinter`, vendored SQL), which needs a DB
  connection.
- **Reuse:**
  - Its Rust parser and crates (MIT) are a candidate SQL front end.
  - Its LSP diagnostics plumbing is a model for editor integration.
  - It is also the most likely **home for upstreaming** supacheck's static SQL rules.

#### Supabase MCP server (`get_advisors`) and agent skills
- **MCP server:** https://github.com/supabase/mcp. 2,933★, Apache-2.0. `get_advisors`
  just returns Splinter output.
- **Agent skills:** https://github.com/supabase/agent-skills. 2,700★, MIT. The
  `supabase-postgres-best-practices` skill has `security-rls-basics.md`,
  `security-rls-performance.md` and `security-privileges.md`. This is guidance prose,
  not checks, but it is a **source of rule-doc text and fix examples**, and
  licence-compatible.

#### GitHub secret scanning (Supabase is a partner)
- **Partnership:** Supabase has been a partner since 2022
  ([changelog](https://github.blog/changelog/2022-03-28-supabase-is-now-a-github-secret-scanning-partner/)).
- **Detectors (March 2026)**
  ([changelog](https://github.blog/changelog/2026-03-10-secret-scanning-pattern-updates-march-2026/)):
  - `supabase_secret_key` (`sb_secret_…`), **push-protected by default**;
  - `supabase_personal_access_token` (`sbp_…`).
- **Revocation:** Supabase auto-revokes leaked new-format secret keys
  ([2025 security retro](https://supabase.com/blog/supabase-security-2025-retro)).
- **Implication:** *literal* `sb_secret_` leaks in public repos are largely handled
  upstream. The gap is:
  - legacy `service_role` **JWTs** (the role must be decoded);
  - **env-var names** (`NEXT_PUBLIC_*SERVICE_ROLE*`);
  - **import-graph** leaks (a server-only env read reachable from a client component);
  - private repos without GHAS.

### 1.2 Static code tools (closest to supacheck)

#### eslint-plugin-supabase-security (ofri-peretz/eslint monorepo)
- **Where:** https://github.com/ofri-peretz/eslint. 19★, MIT. npm
  `eslint-plugin-supabase-security@0.2.0`, published 2026-09.
  [PR #960](https://github.com/ofri-peretz/eslint/pull/960) merged 2026-09-10.
- **Approach:** STATIC-TS, AST-only, single-file. **4 rules:**

  | Rule | What it checks | Our id |
  |---|---|---|
  | `no-service-role-key-in-client` | service-role env var behind `NEXT_PUBLIC_`, `VITE_` or 5 more prefixes, or read inside a `"use client"` module; abstains on `server-only` | `service-key-in-client`, D part only, no import graph |
  | `require-auth-error-check` | `const { data } = await supabase.auth.getUser()` with `error` ignored: a forged token reads as anonymous success | narrow `ignored-query-error`; **auth-specific variant we don't name** |
  | `no-dynamic-rpc-name` | computed `.rpc(name)` lets the caller pick which function runs | **we don't have this** |
  | `no-public-storage-bucket` | public bucket creation; strict preset only, because site assets are legitimately public | ~`private-data-in-public-bucket` without the semantics |

- **Deliberately not done:** `.from()` with no filter as "RLS assumed". The author argues
  it can't be right without the DB. That is exactly the fact-store argument.
- **Reuse:**
  - 105 tests (valid and invalid snippets), MIT, usable as **labelled TS fixtures**.
  - The env-prefix list (`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, `PUBLIC_`,
    `REACT_APP_`, `NUXT_PUBLIC_`, `GATSBY_`) is a ready allowlist for our D rule.

#### Semgrep
- **Registry:** `semgrep/semgrep-rules` (https://github.com/semgrep/semgrep-rules, 1,263★)
  has **no Supabase rules** as of 2026-10-05. A `repo:` code search for "supabase" returns
  nothing.
- **Open PR:** [#4057](https://github.com/semgrep/semgrep-rules/pull/4057), opened
  2026-09-11, adds `supabase-service-role-key-public-env`. It only checks `NEXT_PUBLIC_`.
  The author confirms `--config auto` (381 rules) finds nothing on a Next.js plus Supabase
  service-key leak.
- **Licence:** the Semgrep Rules License v1.0 is **not OSI**. It forbids using the rules
  in a competing hosted product. **Don't copy registry rules into supacheck.** Writing our
  own patterns is fine.

#### CodeQL
- No supabase-js models or queries exist in `github/codeql`. The only "supabase" hits are
  Actions models for reusable workflows. **Nothing to reuse.** A models-as-data extension
  is the CodeQL route if we ever want taint tracking, for example into
  `.or()`/`.filter()` for `unescaped-postgrest-filter-string`.

#### vibeproof
- **Where:** https://github.com/humora2504/vibeproof. MIT, pushed 2026-09-17. Free CLI
  plus GitHub Action, with a paid "generator" half.
- **Approach:** STATIC-SQL and STATIC-TS, **regex only**, in `lib/rules-*.js`.
- **Checks, mapped to our ids:**

  | Check | Our id |
  |---|---|
  | `create table` without a matching `enable row level security` | `rls-disabled-on-exposed-table`, no schema or exposure model |
  | `create policy … using (true)` to anon | `rls-policy-always-true` |
  | `grant insert/update/delete … to anon` | not in our list |
  | `insert into storage.buckets … public true` | |
  | service_role JWT **decoded** from the token | `service-key-in-client` |
  | `NEXT_PUBLIC_`/`VITE_`/`EXPO_PUBLIC_` secrets | `service-key-in-client` |
  | "admin client in browser code" | `service-key-in-client` |
  | "endpoint writes without auth check" | weak heuristic |
  | CORS `*` with credentials | |
  | connection strings with passwords | |
  | env files tracked by git | |
  | Firebase rules | |

- **Notable:** explicitly does not flag the anon key, which agrees with our README.
- **Limitations:** regex over `[\s\S]{0,400}`. There is no drop/alter replay, so a later
  `drop policy` or `disable rls` is invisible, as are the `[api] schemas` config and
  multi-statement policies.
- **Reuse:**
  - Its `demo/` deliberately vulnerable project, with `expected-output.txt`, is a ready
    **end-to-end fixture**.
  - Its SEO pages (`docs/*.html`) show the questions users google.

#### VibeRaven
- **Where:** https://github.com/ohad6k/VibeRaven. 60★, MIT, pushed 2026-10-05. npm
  `viberaven`, plus a GitHub Action `ohad6k/viberaven-action`.
- **Approach:** STATIC (repo scan offline), plus provider MCP (Supabase `get_advisors`,
  `execute_sql`), plus an agent cockpit (LLM).
- **Gap ids seen:**
  - `rls_disabled`, from migrations;
  - `service_role_key_in_client_env`;
  - `missing_monitoring`, and other launch-readiness checks.
- **Limitations:** the check source is not in the public repo, which only holds the
  exported skills, rules and docs. Coverage is shallow and readiness-score oriented.
- **Reuse:** low. Its idea of *pushing to main* (Lovable and Bolt bypass PRs) is a CI
  design point worth copying: comment on commits, not only PRs.

#### supabase-rls-guardian (unverified)
- **Claim:** pitched in [supabase/cli#5992](https://github.com/supabase/cli/issues/5992),
  closed stale on 2026-07-29, as an AST static analyser for migration files. Its claimed
  rules:
  - self-referencing policy subqueries (`recursive-rls-policy`);
  - unindexed FK joins in policies (`policy-column-not-indexed`);
  - definer functions without `search_path`.
- **Status:** the claimed repo `supabase-community/rls-guardian` and the npm package
  **both 404**. Treat as vapour. The useful signal is that Supabase CLI maintainers let a
  "static RLS linter in `db lint`" request go stale. **Nobody owns this space.**

### 1.3 Live RLS testing tools (complementary, need a DB)

#### rlsautotest: the most sophisticated RLS tool found
- **Where:** https://github.com/unitautogen/rlsautotest. 23★, **Apache-2.0**, pushed
  2026-09-07, PyPI `rlsautotest`. Featured in the Supabase July 2026 developer update.
- **Approach:** LIVE-PROBE plus LIVE-SQL lint.
  - It reads policies from the catalog and **synthesises seed data and identities**:
    owner, other user, anon, role-holder, two-tenant member.
  - It emits a native pgTAP suite using basejump helpers, plus a per-identity access
    matrix (HTML or JSON) and a CI gate.
  - "Never a false pass": opaque functions are marked, not faked.
- **Static lint codes** ([lint.py](https://github.com/unitautogen/rlsautotest/blob/main/rlsautotest/lint.py)):

  | Code | Finding | Our id |
  |---|---|---|
  | L001 | `USING(true)` | `rls-policy-always-true`, SELECT included |
  | L002 | `WITH CHECK(true)` | |
  | L003 | UPDATE with USING and no WITH CHECK (row can move out of scope) | **not in our list** |
  | L004 | RLS on, no policy | `rls-enabled-no-policy` |
  | L005 | policy calls a UDF; opaque | |
  | L006 | self-referencing policy | `recursive-rls-policy`, self-table only |
  | L007 | anon full SELECT | |
  | L008 | policies exist but RLS disabled | |
  | L009 | USING ≠ WITH CHECK | |
  | L010 | no DELETE policy (info) | |
  | L016 | **scalar-subquery membership** | **not in our list** |
  | L017 | **no `TO` clause while sibling policies are role-scoped** | `policy-missing-to-role` |
  | L018 | write policy constrains columns but **not the access-scope column** | `write-policy-missing-ownership-check`, D form |
  | L019 | unwrapped `auth.uid()` | `auth-function-not-wrapped-in-select` |

  L016 detail: `team_id = (select team_id from team_members where user_id = auth.uid())`
  works for one-team users and raises `21000` for two-team users. `LIMIT 1` "fixes" it by
  arbitrarily hiding data.
- **Other unique checks:**
  - **cross-policy WITH CHECK leak**: two permissive UPDATE/INSERT policies with narrow
    value constraints OR together;
  - **a column-scoped GRANT defeated by a broader table-wide grant**: relevant to
    `self-updatable-privilege-column`;
  - a "bypass surface" report covering definer views, definer functions and BYPASSRLS
    roles.
- **Reuse (Apache-2.0, fully compatible):**
  - Its lint heuristics translate almost one-to-one into static rules over our fact store.
  - Its **two-membership** insight is a strong new rule.
  - Its blog post on RLS as a compliance control is good positioning material.

#### SupaShield
- **Where:** https://github.com/Rodrigotari1/supashield. 103★, MIT, last push 2026-02-07,
  npm `supashield@0.3.0`.
- **Approach:** LIVE-PROBE (transactions with rollback, impersonating JWT claims) plus a
  small catalog lint.
- **Commands:** `audit`, `lint`, `coverage`, `test`, `test-storage`, `snapshot`/`diff`,
  `export-pgtap`.
- **Lint rules** (`src/core/lint.ts`):

  | Rule | Our id |
  |---|---|
  | `ALWAYS_TRUE_USING` | `rls-policy-always-true` |
  | `ALWAYS_TRUE_WITH_CHECK` | `rls-policy-always-true` |
  | `NO_AUTH_UID_CHECK` | `policy-authenticated-not-authorized`, literal form |
  | `PERMISSIVE_FOR_ALL` | |
  | `MISSING_WITH_CHECK` | |

- **Other features:** a YAML expectation file per table, role and command
  (ALLOW or DENY).
- **Limitations:** needs a DB URL, and recommends the *pooler* URL. Expectations are
  hand-written. Development is quiet since February.
- **Reuse:** the "expected access matrix" YAML is a nice spec format for **evidence
  tests** in our fake projects. The lint rules are trivially covered by ours.

#### supabase-test-helpers (basejump)
- **Where:** https://github.com/usebasejump/supabase-test-helpers. 132★, MIT, last push
  2024-05.
- **What it provides:** pgTAP helpers:
  - `tests.create_supabase_user`;
  - `tests.authenticate_as`;
  - `tests.rls_enabled(schema)`;
  - `tests.freeze_time`.
- **Status:** the de-facto standard, used by rlsautotest.
- **Reuse:** use it for **supacheck's own evidence tests**. Each candidate rule gets a fake
  project and a pgTAP test proving the bug (README "evidence test").

#### Other live and SQL-paste auditors
- **supabase-audit** (https://github.com/EstasDespedido/supabase-audit). 1★, MIT. One
  read-only `audit.sql` pasted into the SQL editor, with 12 checks. **Unique: #12, INSERT
  policy with no SELECT policy**, so `RETURNING` (`.insert().select()`) fails with 42501.
  That is our `update-policy-without-select-policy` family. Its README makes **good FP
  notes**:
  - definer views are often correct;
  - the recursion and FK-index checks are heuristics tuned to over-report.
- **Lintel** (https://github.com/Amsozzer1/lintel). MIT, pushed 2026-09-28.
  - Replays **base and head migrations into two throwaway Supabase DBs** and runs Splinter
    on each.
  - Comments on the PR only with *new* or *fixed* findings.
  - Probe P001 proves anon reads. Anon writes and cross-user reads are in progress.
  - Has an MCP `check_migrations`.
  - **Most relevant architecture idea found** (§4).
- **constructive-io/supabase-test-suite** (https://github.com/constructive-io/supabase-test-suite).
  23★, MIT. An RLS test playground.
- **aceework11/supabase-rls-lab** (https://github.com/aceework11/supabase-rls-lab). MIT. A
  multi-tenant schema with "seven documented defects" and an isolation suite. **Labelled
  fixtures.** Notably it records which claimed defects turned out *false* on testing, which
  is useful FP evidence.

### 1.4 Black-box scanners for deployed apps (different product category)

These all extract the URL and anon key from the JS bundle, then probe PostgREST, Storage,
RPC, Auth and Functions. They find **effects**, not causes, and cannot point to a file or
line.

| Tool | URL | Licence and activity | Notes |
|---|---|---|---|
| supabomb | https://github.com/ModernPentest/supabomb | 35★, **no licence**, 2025-11 | Python. Discovery from HTML, JS, HAR and Katana crawl. Enumerates tables, RPC, buckets and functions. Compares anon vs auth row counts; tests `verify_jwt` on functions. |
| supabase-pentest-skills | https://github.com/yoanbernabeu/supabase-pentest-skills | 69★, README says MIT (GitHub: NOASSERTION), 2026-01 | **LLM**: 24 agent skills (extract keys, RLS, RPC, storage, auth config, signup, realtime, functions, report). Companion intentionally vulnerable app: https://github.com/yoanbernabeu/SupatestVibeDemo (licence "other"). |
| Supabase RLS Checker (Chrome) | https://github.com/hand-dot/supabase-rls-checker | 121★, no licence, 2025-04 | Intercepts `.supabase.co/rest/v1/` calls, then `select * limit 30` on guessed sensitive table names. ≥30 rows means "RLS off". Crude. |
| Securify Burp extension | https://github.com/Securify-AI/Supabase-RLS-Extension | MIT | Burp plugin. |
| Many 0★ CLIs | supasec, supaxray (Apache-2.0), saintmalik/supabase-audit, eugenicum/supabase-audit, sahanxdissanayake/supabase-security-scanner-oss | mostly MIT | Same probe set. Signals a crowded, commoditised category. |
| Vibe App Scanner | https://vibeappscanner.com | commercial, $29–49/mo | Black-box URL scan, plus SEO content on Lovable and Supabase risks. |
| Escape.tech (Visage + BLST) | [methodology](https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/) | commercial | 5,600 apps: 2k+ vulns, 400+ secrets, 175 PII leaks. DAST surface scanner for anon JWTs and Supabase routes. |
| Symbiotic Security | [blog](https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws) | commercial | 1,072 apps. 172 unauthenticated DELETE, 172 PATCH, 39 full reads. **Counts the exposed anon key as High** on 308 sites, the FP we must avoid. Most "98%" findings are missing headers. |
| Lovable Security Scan | [docs](https://docs.lovable.dev/features/security) | built-in | Quick scan (~10 s, every publish): RLS lint (Supabase Advisor), deps (OSV), MCP exposure. Deep scan (3–15 min, LLM) reviews app logic. Admins can block publishing on critical findings. Critics say it historically checked policy *existence*, not effectiveness. |
| vibe-eval, LaunchGuard, scan.testavi.com, SupaExplorer (Chrome) | various | commercial or free | Same anon-key probing. |
| AquilaX | https://aquilax.ai | commercial | General AppSec. Secrets scanning plus a fine-tuned Qwen2.5-Coder-3B "AI scanner" that filters FPs. **No Supabase-specific checks found.** Interesting as a precedent for a small fine-tuned model as a FP filter. |

**Reuse:**
- The incident write-ups (Escape, Symbiotic, UpGuard) supply prevalence numbers for
  prioritisation.
- The vulnerable demo apps (SupatestVibeDemo, vibeproof `demo/`) are E2E fixtures, subject
  to licence.

### 1.5 Generic Postgres and secret linters

- **squawk** (https://github.com/sbdchd/squawk). 1,210★, **Apache-2.0**, pushed
  2026-10-04.
  - Migration safety only: locks, NOT NULL, concurrent indexes, timeouts,
    `prefer-robust-stmts`, bans.
  - **No RLS, grant or security rules.**
  - **Reuse:** its Rust Postgres parser and GitHub Action are licence-compatible. Running
    squawk alongside us is complementary.
- **pgspot** (https://github.com/timescale/pgspot). 149★, PostgreSQL licence, pushed
  2026-10-05. Static SQL security linter for extension scripts:

  | Code | Finding | Our id |
  |---|---|---|
  | PS003 / PS004 | definer function without, or with an insecure, `search_path` | `security-definer-function-exposed` |
  | PS016 / PS017 | **unqualified function or object reference** | hijack inside definer bodies |
  | PS002 / PS012 / PS015 | `CREATE OR REPLACE` / `IF NOT EXISTS` object-hijack patterns | |
  | PS018 | unsafe `SET search_path` | |

  **Reuse:** the rule definitions and tests are good fixtures. The licence is compatible
  with attribution.
- **gitleaks** (https://github.com/gitleaks/gitleaks). 29.7k★, MIT. **No Supabase rule**;
  only the generic `jwt` rule, and code search finds no `sb_secret`/`sbp_`. It can't tell
  anon JWTs from service_role JWTs, so it is noisy on anon keys.
- **trufflehog** (https://github.com/trufflesecurity/trufflehog). 28.3k★, **AGPL-3.0**.
  - The only Supabase detector is `supabasetoken`: `\bsbp_[a-z0-9]{40}\b`, verified
    against `api.supabase.com/v1/projects`.
  - No `sb_secret_` or service_role JWT detector.
  - **Don't copy code (AGPL).**
- **drizzle-supabase-rls, prisma-extension-supabase-rls, hmmhmmhm/supabase-rls:** RLS
  *authoring* helpers in TS, not linters. They matter as **input formats**: Drizzle's
  `pgPolicy()` defines policies in TS, which a migration-only fact store would miss
  (see §4).

### 1.6 Checklists (no code, but rule-text sources)
- **boxed-dev/vibe-coding-security** (https://github.com/boxed-dev/vibe-coding-security).
  15★, no licence. A 69-item pre-launch checklist. Supabase items: RLS everywhere,
  policies per role, service_role server-only, user isolation by `auth.uid()`, no mass
  assignment of `role`/`admin` (= `self-updatable-privilege-column`).
- **VibeRaven `.cursor/rules/viberaven-supabase-rls.mdc`** and the Supabase agent-skills
  references: prose rules for agents.

---

## 2. Coverage matrix (our top ids × tools)

Legend:
- **●** detects the core case.
- **◐** partial: literal or heuristic form only, or a different scope.
- **L** needs a live DB or deployed app.
- **·** nothing.

Columns:
- **Spl**: Splinter / Security Advisor (L).
- **rat**: rlsautotest (L).
- **SS**: SupaShield (L).
- **EA**: EstasDespedido supabase-audit (L).
- **vp**: vibeproof (static regex).
- **ESL**: eslint-plugin-supabase-security.
- **SG**: Semgrep PR #4057 (unmerged).
- **Sec**: GitHub secret scanning, gitleaks and trufflehog.
- **pgs**: pgspot.
- **plc**: plpgsql_check (L).
- **BB**: black-box scanners: supabomb, pentest-skills, Escape, Symbiotic, VAS (L).
- **Lov**: Lovable scan.

| # | id | Spl | rat | SS | EA | vp | ESL | SG | Sec | pgs | plc | BB | Lov |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `rls-disabled-on-exposed-table` | ● 0013 | ● | ● | ● | ◐ | · | · | · | · | · | ● | ● |
| 2 | `rls-policy-always-true` | ◐ 0024 writes | ● L001/2 | ● | ◐ anon | ◐ | · | · | · | · | · | ● effect | ◐ |
| 3 | `service-key-in-client` | · | · | · | · | ● JWT decode + prefix | ◐ prefix / use client | ◐ NEXT_PUBLIC | ◐ literal `sb_secret_` (GH) | · | · | ● bundle | ? |
| 4 | `ef-service-role-trusts-body-identity` | · | · | · | · | ◐ weak | · | · | · | · | · | ◐ LLM skill | ◐ deep (LLM) |
| 5 | `server-trusts-getsession` | · | · | · | · | · | · (adjacent: auth error check) | · | · | · | · | · | · |
| 6 | `policy-authenticated-not-authorized` | · (PR #195 name heuristic) | ● probe | ◐ NO_AUTH_UID | · | · | · | · | · | · | · | ◐ | · |
| 7 | `user-metadata-for-authorization` | ◐ 0015 policies, LIKE | · | · | · | · | · | · | · | · | · | · | ◐ |
| 8 | `security-definer-function-exposed` | ◐ 0028/29 ACL, 0011 | ◐ bypass report | · | ◐ #4/#5 | · | · | · | · | ◐ PS003/4 | · | ◐ RPC probe | ◐ |
| 9 | `storage-policy-not-owner-scoped` | ◐ 0025 listing | · | ◐ test-storage | · | · | · | · | · | · | · | ◐ | · |
| 10 | `write-policy-missing-ownership-check` | · | ◐ L018/L003 + probe | ◐ | · | · | · | · | · | · | · | ◐ | · |
| 11 | `module-scope-server-client` | · | · | · | · | · | · | · | · | · | · | · | · |
| 12 | `jwt-decode-without-verification` | · | · | · | · | · | · | · | · | · | · | ◐ JWT tamper | · |
| 13 | `view-missing-security-invoker` / `auth-users-exposed` | ● 0010/0002 | ◐ | · | ● #6 | · | · | · | · | ◐ PS015 | · | · | ◐ |
| 14 | `self-updatable-privilege-column` | · | ◐ column-grant defeat | · | · | · | · | · | · | · | · | ◐ | · |
| 15 | `private-data-in-public-bucket` | ◐ 0025 | · | · | · | ◐ public bucket | ◐ strict | · | · | · | · | ◐ list | · |
| 16 | `realtime-public-channel-for-private-data` | · | · | · | · | · | · | · | · | · | · | ◐ skill | · |
| 17 | `admin-client-for-user-scoped-work` | · | · | · | · | · | · | · | · | · | · | · | · |
| 18 | `unescaped-postgrest-filter-string` | · | · | · | · | · | · (adjacent: dynamic rpc) | · | · | · | · | · | · |
| 19 | `cron-hardcoded-secret-key` | · | · | · | · | ◐ generic | · | · | ◐ literal | · | · | · | · |
| 20 | `missing-api-grants-new-table` | ◐ PR #197 (0031) | ◐ grant vs RLS deny | · | · | · | · | · | · | · | · | · | · |
| 21 | `ignored-query-error` | · | · | · | · | · | ◐ getUser only | · | · | · | · | · | · |
| 22 | `rls-enabled-no-policy` | ● 0008 | ● L004 | · | ● #2 | · | · | · | · | · | · | · | ● |
| 23 | `recursive-rls-policy` | · | ◐ L006 self | · | ◐ #9 self | · | · | · | · | · | · | · | · |
| 24 | `auth-users-trigger-fragile` | · | · | · | · | · | · | · | · | · | ◐ compile errors | ◐ signup probe | · |
| 25 | `update-policy-without-select-policy` | · | ◐ L010 | · | ◐ #12 INSERT | · | · | · | · | · | · | · | · |
| 26 | `single-where-maybe-single` | · | · | · | · | · | · | · | · | · | · | · | · |
| 27 | `onauthstatechange-async-deadlock` | · | · | · | · | · | · | · | · | · | · | · | · |
| 28 | `ssr-cookie-adapter-broken` / `middleware-session-refresh-missing` | · | · | · | · | · | · | · | · | · | · | · | · |
| 29 | `realtime-channel-not-removed` / `client-per-render` | · | · | · | · | · | · | · | · | · | · | · | · |
| 30 | `storage-upsert-missing-policies` | · | · | ◐ | · | · | · | · | · | · | · | · | · |
| 31 | `serverless-direct-db-without-pooler` | · | · | · | · | · | · | · | · | · | · | · | · |
| 32 | `ef-missing-cors-preflight` | · | · | · | · | · | · | · | · | · | · | · | · |
| 33 | `fk-to-auth-users-blocks-deletion` | · (0021 is different) | · | · | · | · | · | · | · | · | · | · | · |
| 34 | `deprecated-auth-helpers` | · | · | · | · | · | · | · | · | · | · | · | · |
| P | `auth-function-not-wrapped-in-select` | ● 0003 | ● L019 | · | ● #8 | · | · | · | · | · | · | · | · |
| P | `policy-column-not-indexed` | ◐ 0001 FKs | · | · | ◐ #10 | · | · | · | · | · | · | · | · |
| P | `policy-missing-to-role` | ◐ 0006 related | ● L017 | · | · | · | · | · | · | · | · | · | · |
| P | `n-plus-one-queries`, `row-by-row-writes`, `count-exact-on-large-table`, `unbounded-select-silent-truncation`, `client-side-filtering` | · | · | · | · | · | · | · | · | · | · | · | · |

**Reading the matrix:**
- **Rows 1, 2, 13, 22 and the `auth.uid()` perf row are well covered**, but only on a
  live DB. Statically, the only coverage is regex: vibeproof and VibeRaven.
- **Rows 3–8 and 10 are partially covered.** Every existing check is the *literal or
  ACL* form. None answers the semantic question:
  - does this policy actually scope to an owner?
  - does this definer body check the caller?
  - is this metadata used to authorise?
- **Rows 5, 11, 12, 17, 18 and 26–34 have no prior art at all.** That is all the TS, SSR,
  Edge Function and client-correctness rules.

---

## 3. Things others detect that we don't have (candidate additions)

Ranked by value to supacheck. Each line ends with whether the rule is static-feasible.

### Security
1. **Scalar-subquery membership policy** (rlsautotest L016). `col = (select … where
   user_id = auth.uid())` raises 21000 when a user has two memberships, and `LIMIT 1`
   hides data arbitrarily. *D on the policy AST.* High frequency in multi-tenant AI
   schemas.
2. **UPDATE policy with USING but no WITH CHECK** (rlsautotest L003, SupaShield
   `MISSING_WITH_CHECK`), so a row can be moved to another owner or tenant. Splinter
   covers only the always-true variant. *D.* Note: aceework11/supabase-rls-lab found one
   claimed exploit of this *false* in practice, because PostgREST applies USING as the
   default check. **Verify the semantics in an evidence test before shipping.**
3. **Cross-policy WITH CHECK leak** (rlsautotest): multiple permissive write policies are
   OR-ed. *X over the policy set.*
4. **Column-scoped GRANT defeated by a table-wide grant** (rlsautotest). This feeds
   `self-updatable-privilege-column`. *X over grants.*
5. **Dynamic `.rpc(name)`** (ESLint `no-dynamic-rpc-name`). *D.*
6. **Ignored `error` from `auth.getUser()`/`getClaims()`**: a forged token reads as an
   anonymous success (ESLint `require-auth-error-check`). This is a security-flavoured
   sub-case of `ignored-query-error` and should be its own id with higher severity. *D.*
7. **Write privileges granted to anon** (vibeproof): `grant insert/update/delete … to
   anon`. This matters more after 2026-10-30, when people "fix" 42501 with `GRANT ALL TO
   anon`. *D.* Fold into `missing-api-grants-new-table` as the companion "over-grant"
   rule.
8. **pg_graphql exposure** (Splinter 0026/27), **insecure pgmq queue exposed**
   (0019), **materialized or foreign table in API** (0016/17), **extension in public**
   (0014). All are *X* from schema replay plus `[api] schemas`, so they are cheap to add
   once the fact store exists.
9. **Sensitive-named columns on exposed tables** (Splinter 0023). Splinter applies it only
   without RLS. Laya could extend it to "sensitive column readable by a `using (true)`
   SELECT policy". *X + S.*
10. **Unqualified references inside definer functions** (pgspot PS016/17): search_path
    hijack even when `search_path` is set to `public`. *D.*
11. **Policy exists but RLS disabled** (Splinter 0007, rlsautotest L008): dead policies
    give a false sense of security. *X.*
12. **Auth config advisors** (Studio, Lovable, pentest-skills). Static analogue:
    `config.toml [auth]`:
    - `enable_confirmations = false`;
    - signups open;
    - OTP expiry;
    - leaked-password protection;
    - `[functions.x] verify_jwt = false` without in-body auth.

    *D on config.*
13. **Connection string with an embedded password** in the repo, and **env files tracked
    by git** (vibeproof). Generic; low priority, since secret scanners cover it.

### Correctness and operations
14. **INSERT policy with no SELECT policy** breaks `.insert().select()`/RETURNING with
    42501 (supabase-audit #12). Extend our `update-policy-without-select-policy` to
    INSERT explicitly; it is the more common case. *X.*
15. **Migration lock safety** (squawk, pgls): concurrent index creation, NOT NULL with
    default, `NOT VALID` constraints. **Out of scope.** Recommend running squawk or pgls
    alongside; don't duplicate.
16. **Missing primary key** (Splinter 0004). Realtime UPDATE/DELETE payloads and
    PostgREST upserts depend on it. *X*, cheap.

---

## 4. Synthesis

### Gaps nobody covers: where supacheck is differentiated
1. **The TypeScript side of Supabase.** The only static TS tooling is a 4-rule,
   single-file ESLint plugin and an unmerged one-rule Semgrep PR. Nothing covers:
   - `getSession()` on the server;
   - module-scope server clients;
   - SSR cookie adapters or middleware refresh;
   - `onAuthStateChange` deadlocks;
   - `.single()` misuse;
   - realtime cleanup;
   - PostgREST filter injection;
   - deprecated auth-helpers;
   - Edge Function CORS;
   - admin client used for user-scoped work.

   CodeQL and Semgrep have zero supabase-js models.
2. **Cross-file reasoning.** No tool joins TS facts with schema facts. Examples:
   - "this client file calls `.from('invoices').update()` and the migration's UPDATE
     policy has no ownership check";
   - "this Edge Function has `verify_jwt=false` and trusts `body.user_id`".

   Black-box scanners see the effect; live linters see the schema; nobody sees both
   sides.
3. **Static migration analysis with real semantics.** The static SQL tools are all regex
   (vibeproof, VibeRaven) or vapour (rls-guardian). None replays `drop policy`, `alter
   table … disable rls`, `revoke`, `alter default privileges`, `[api] schemas` or
   `supabase/schemas/*.sql`. Supabase's own pgls has zero static security rules.
4. **Semantic judgement on policies and function bodies.** Every tool stops at literals:
   - `true`;
   - `LIKE '%user_metadata%'`;
   - "is `auth.uid()` present";
   - "is EXECUTE granted".

   The Laya questions (owner-scoped? caller-checked? privilege-bearing column? meant to
   be public?) are exactly the cases tools punt on. Splinter skips SELECT-true, PR #195
   tries policy-name matching, and supabase-audit says definer views need "a decision".
5. **Time-sensitive `missing-api-grants-new-table`.** Only Splinter PR #197 (unmerged)
   approaches it, and only on a live DB. A static rule that ships before **2026-10-30** is
   first-to-market.
6. **The PR/IDE moment.** Splinter runs after deploy or on a local stack. Black-box scanners
   run after publish. Only Lintel (0★, Splinter-based) and VibeRaven target PRs. A fast,
   DB-less linter in the editor and PR is an open slot.

### Ideas to borrow
- **Splinter's output contract and exclusions.** Use `level` (ERROR/WARN/INFO),
  `categories` (SECURITY/PERFORMANCE), `remediation` URL, and a stable `cache_key` for
  allowlists. Add a `splinter:` cross-reference on each overlapping supacheck rule. That
  lets users dedupe against the dashboard, and lets Supabase surface supacheck results in
  the same UI. Emit SARIF for GitHub code scanning.
- **Splinter's FP decisions as priors:**
  - SELECT `using (true)` is not flagged by default;
  - only permissive policies to anon, authenticated or public count;
  - system schemas are excluded. Copy Splinter's schema exclusion list verbatim.
- **Lintel's base-vs-head diff.** Report only findings *introduced* by the PR, plus "fixed
  in this PR". This cuts noise on legacy repos dramatically. Our schema replay makes it
  cheap: replay at `merge-base` and at `HEAD`.
- **rlsautotest's identity model** for evidence tests and wording:
  - anon;
  - authenticated-not-authorized;
  - owner;
  - **member-of-2-tenants**.

  Also its stance of "mark, never fake" when a policy calls an opaque function. That is
  the right behaviour when Laya's confidence is low: say "unverified" instead of passing.
- **ESLint plugin's abstentions:**
  - abstain on `import 'server-only'`;
  - recognise all 7 env prefixes;
  - catch `process['env'].X` spelling variants.
- **vibeproof's JWT decoding.** Decode the `role` claim of any `eyJ…` literal: flag
  `service_role`, ignore `anon`. This is the cheapest high-precision fix for the #1 FP in
  the scanner market (Symbiotic counted anon keys as High on 308 sites).
- **VibeRaven's commit comments on pushes to main.** Lovable and Bolt users don't open PRs.
- **pgTAP plus basejump helpers** as the evidence-test harness for each candidate rule.
- **Laya as an FP filter (AquilaX precedent).** AquilaX uses a fine-tuned 3B coder model to
  drop 93% of raw findings. Supacheck can run deterministic candidates first, then ask Laya
  the perception question to keep or drop each one. This is consistent with our design.

### Labelled data and fixtures we can reuse (licence-checked)

| Source | Licence | Apache-2.0 OK? | What |
|---|---|---|---|
| Splinter `test/sql` + `test/expected` | **none** | Only if Supabase-internal | Positive and negative SQL per lint (pg_regress) |
| rlsautotest tests, lint.py | Apache-2.0 | Yes | Policy shapes incl. two-membership and WITH CHECK leak |
| eslint-plugin-supabase-security tests (105) | MIT | Yes (attribution) | TS valid/invalid snippets for 4 rules |
| vibeproof `demo/` + expected output | MIT | Yes | Vulnerable Next.js + Supabase repo |
| supabase-rls-lab | MIT | Yes | Multi-tenant schema, 7 defects, incl. claims proven false (FP data) |
| SupaShield `.supashield/policy.yaml` format | MIT | Yes | Expected-access-matrix spec |
| pgspot tests | PostgreSQL | Yes (attribution) | search_path and hijack SQL cases |
| squawk / pgls parsers | Apache-2.0 / MIT | Yes | SQL front end |
| supabase/agent-skills references | MIT | Yes | Rule doc prose and fixes |
| Semgrep registry rules (incl. PR #4057 once merged) | Semgrep Rules License | **No**: restrictive, non-OSI | Don't copy |
| trufflehog | AGPL-3.0 | **No** | Don't copy code |
| supabomb, hand-dot extension, vibe-coding-security | none | **No** | Read for ideas only |
| supabase-pentest-skills, SupatestVibeDemo | README says MIT; GitHub says NOASSERTION / "other" | Verify first | Vulnerable demo app; probe recipes |

### What changes our plan
1. **Consider a replayed Postgres as the SQL fact store, or at least as the test oracle.**
   Lintel shows that replaying migrations into a throwaway DB and running Splinter works.
   Options:
   - **(a)** Keep the planned pure-static schema replay for speed and the IDE. **Use
     Splinter on a `supabase db start` shadow DB as the CI oracle.** For every overlapping
     rule, the static result must agree with Splinter on the same migrations. This gives
     free regression data from Splinter's fixtures.
   - **(b)** Spike **PGlite** (in-process WASM Postgres) with stubbed `auth`/`storage`
     schemas and the `anon`/`authenticated` roles. It would get exact catalog semantics
     (drops, defaults, grants, default privileges) without writing a replay engine, and
     would let us run `splinter.sql` in process. Needs a feasibility check (role
     support, extensions). *Recommendation: (a) now, (b) as a time-boxed spike.*
2. **Don't rebuild Splinter's literal lints as the headline.** Rows 1, 13, 22 and
   `auth-function-not-wrapped-in-select` are already in every Supabase dashboard, CLI and
   MCP session. Supacheck still needs them statically for the PR/IDE moment and as Laya
   context. But marketing and evaluation should centre on the **uncovered** rows: TS,
   cross-file, semantic, and the 2026-10-30 grants change.
3. **Pick the spike's 8 Laya rules from rows with zero prior art**, plus the semantic halves
   of partially covered rows. Strong picks:
   - `server-trusts-getsession`;
   - `ef-service-role-trusts-body-identity`;
   - `policy-authenticated-not-authorized`;
   - `security-definer-function-exposed` (body check);
   - `user-metadata-for-authorization` (TS and function bodies, beyond 0015);
   - `admin-client-for-user-scoped-work`;
   - `rls-policy-always-true` (SELECT intent);
   - `single-where-maybe-single`.

   None of these is answered by any existing tool.
4. **Add these new deterministic ids**:
   - scalar-subquery membership (§3.1);
   - INSERT-without-SELECT;
   - dynamic `.rpc()`;
   - `auth-getuser-error-ignored`;
   - anon write grants;
   - unqualified refs in definer bodies;
   - `config.toml` auth and `verify_jwt` config.
5. **Use a real SQL parser, not regex.** vibeproof's regex approach misses drops, alters
   and multi-statement policies. Candidates: libpg_query (via pg_query bindings), squawk's
   parser (Apache-2.0), or pgls crates (MIT). The pgls crates are also the natural
   **upstream home** if Supabase wants supacheck's static SQL rules in `supabase db lint`.
   cli#5992 shows the demand, and that nobody has filled it.
6. **Secret detection is commoditised for new-format literals.** GitHub push protection
   covers `supabase_secret_key`, and Supabase auto-revokes leaked keys. Keep
   `service-key-in-client` focused on:
   - legacy `service_role` JWTs (decode the role);
   - env-name and prefix leaks;
   - **import-graph reachability** from `'use client'` or browser bundles.

   No tool does the last one.
7. **Watch Splinter PRs #195, #197 and #169.** If they merge, align our ids and messages
   and mark the overlap, so the dashboard and supacheck don't contradict each other.

---

## Sources
- Splinter: https://github.com/supabase/splinter, https://supabase.github.io/splinter,
  open PRs https://github.com/supabase/splinter/pulls
- Supabase Advisors docs: https://supabase.com/docs/guides/database/database-advisors
- CLI testing and linting: https://supabase.com/docs/guides/local-development/cli/testing-and-linting
- CLI `db advisors` request and port: https://github.com/supabase/cli/issues/3839,
  https://github.com/supabase/cli/pull/6811
- Static RLS linter request (stale): https://github.com/supabase/cli/issues/5992
- postgres-language-server: https://github.com/supabase-community/postgres-language-server
- Supabase MCP: https://github.com/supabase/mcp. Agent skills: https://github.com/supabase/agent-skills
- plpgsql_check: https://github.com/okbob/plpgsql_check,
  https://supabase.com/docs/guides/database/extensions/plpgsql_check
- squawk: https://github.com/sbdchd/squawk. pgspot: https://github.com/timescale/pgspot
- gitleaks: https://github.com/gitleaks/gitleaks. trufflehog:
  https://github.com/trufflesecurity/trufflehog (pkg/detectors/supabasetoken)
- GitHub secret scanning: https://github.blog/changelog/2022-03-28-supabase-is-now-a-github-secret-scanning-partner/,
  https://github.blog/changelog/2026-03-10-secret-scanning-pattern-updates-march-2026/,
  https://supabase.com/blog/supabase-security-2025-retro
- ESLint plugin: https://github.com/ofri-peretz/eslint/pull/960,
  https://www.npmjs.com/package/eslint-plugin-supabase-security
- Semgrep: https://github.com/semgrep/semgrep-rules/pull/4057
- rlsautotest: https://github.com/unitautogen/rlsautotest
- SupaShield: https://github.com/Rodrigotari1/supashield
- basejump test helpers: https://github.com/usebasejump/supabase-test-helpers
- supabase-audit: https://github.com/EstasDespedido/supabase-audit
- Lintel: https://github.com/Amsozzer1/lintel
- vibeproof: https://github.com/humora2504/vibeproof
- VibeRaven: https://github.com/ohad6k/VibeRaven
- supabomb: https://github.com/ModernPentest/supabomb
- supabase-pentest-skills: https://github.com/yoanbernabeu/supabase-pentest-skills
- Supabase RLS Checker: https://github.com/hand-dot/supabase-rls-checker
- supabase-rls-lab: https://github.com/aceework11/supabase-rls-lab
- supabase-test-suite: https://github.com/constructive-io/supabase-test-suite
- vibe-coding-security: https://github.com/boxed-dev/vibe-coding-security
- Escape.tech: https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/
- Symbiotic: https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws
- Lovable security: https://docs.lovable.dev/features/security, https://docs.lovable.dev/features/security-view
- Vibe App Scanner: https://vibeappscanner.com
- AquilaX: https://aquilax.ai
