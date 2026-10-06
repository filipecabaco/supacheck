# Data API (supabase-js / PostgREST) anti-patterns + pain-point landscape

Research catalogue, 2026-10-05.

**Sources:**
- Web searches and fetched pages.
- `gh api search/issues … sort=reactions`.
- postgrest-js source JSDoc (`supabase/supabase-js/packages/core/postgrest-js/src/*.ts`),
  which is where the official reference text now lives.
- The 223 troubleshooting articles.

"N hits" is the GitHub search `total_count` across `org:supabase`, a rough signal.
**[UNVERIFIED]** marks unconfirmed claims.

**Detection legend:**
- **D**: deterministic.
- **S**: semantic (Laya).
- **X**: cross-file.

---

## Anti-patterns

### 1. `ignored-query-error`
supabase-js resolves `{ data: null, error }` and never rejects, so destructuring only
`data` makes failures look like "no rows". Mutations fail silently, and React Query
never sees the error. **Correctness, silent data loss.**
- **Evidence**:
  - supabase-js #885 "throwOnError should be default" (50 reactions, open, 6th most-reacted)
  - <https://makerkit.dev/blog/saas/supabase-react-query>
  - supabase-js #1661 (`count: exact` + `head: true` hides errors)
  - <https://dev.to/victor_caa_ab4153b4bcf6e/supabase-maybesingle-returns-null-with-multiple-rows-and-it-wont-tell-you-why-mc>
- **Guidance**: `throwOnError()` JSDoc ("will reject the promise"). All reference examples
  destructure `{ data, error }`.
- **BAD** `const { data } = await supabase.from('todos').select('*'); return data.map(render)`
- **GOOD** `const { data, error } = …; if (error) throw error` (or `.throwOnError()`)
- **Detection: D.** The result pattern lacks `error`, or binds it and never reads it,
  with no `.throwOnError()`. Sub-rule: a `queryFn` in `useQuery` or `useSWR` that
  doesn't throw.

### 2. `single-where-maybe-single`
`.single()` errors with PGRST116 (406) on 0 rows, when it is used for "find if exists".
- **Evidence**:
  - 81 hits for "PGRST116"
  - <https://github.com/orgs/supabase/discussions/3343>, <https://github.com/orgs/supabase/discussions/2284>
  - postgrest-js #361
  - <https://nikofischer.com/supabase-pgrst116-multiple-or-no-rows-fix>
- **Guidance**: `single()` JSDoc says "Query result must be one row … otherwise this
  returns an error." `maybeSingle()` returns `null`.
- **Detection: S**, from signals like `if (!data)` after `.single()`, a PGRST116 check,
  or a non-PK filter. **X** for column uniqueness.

### 3. `n-plus-one-queries`
One query per row in a loop or `Promise.all(map)`. **Performance, cost.**
- **Evidence**:
  - <https://axonbuild.com/blog/n-plus-1-query-problem>
  - <https://www.iloveblogs.blog/post/supabase-slow-queries-fix>
  - <https://supabase.com/docs/guides/troubleshooting/high-latency-with-supabase-client-z0pZzR>
- **Guidance**: embed relations in one select
  (<https://supabase.com/docs/guides/database/joins-and-nesting>).
- **GOOD** `select('id, title, author:profiles(name)')` or `.in('id', authorIds)`
- **Detection: D** (`from()` or `rpc()` inside a loop, `map`/`forEach`, or
  `Promise.all(x.map)`). **X** for whether an FK exists for the embed.

### 4. `unbounded-select-silent-truncation`
PostgREST caps responses at `max_rows` (1000) with no error, so "get all rows" silently
drops data. The cap applies to set-returning RPCs too.
- **Evidence**:
  - 238 hits for "1000 rows"
  - <https://github.com/orgs/supabase/discussions/1742>, <https://github.com/orgs/supabase/discussions/26770>
  - <https://mulungood.com/supabase-all-rows-pagination>
- **Guidance**: `select()` JSDoc says "By default, Supabase projects return a maximum of
  1,000 rows … use `range()` queries to paginate."
- **Detection: S.** No `limit`, `range`, `single` or PK eq, especially when the result
  feeds an aggregate (`reduce`, `.length`) or an export.

### 5. `range-without-order`
`.range()` without `.order()` on a unique key gives overlapping or skipped pages.
`range(p*n, (p+1)*n)` returns n+1 rows because the bounds are inclusive.
- **Evidence**:
  - <https://makerkit.dev/blog/tutorials/pagination-supabase-react>
  - <https://github.com/orgs/supabase/discussions/3938>
  - <https://dev.to/mbrookson/pagination-pitfalls-preventing-data-loss-4dc1>
- **Guidance**: <https://supabase.com/docs/reference/javascript/range> **[quote unverified]**
- **Detection: D.**

### 6. `client-side-filtering`
Fetch everything, then `.filter()`, `.slice()` or `.find()` in JS. **Egress cost,
performance, and wrong past 1000 rows.**
- **Evidence**:
  - <https://dev.to/victor_caa_ab4153b4bcf6e/how-i-turned-a-single-supabase-query-into-19gb-of-egress-7ob>
  - <https://readytorelease.online/blog/supabase-egress-optimization-select-star>
- **Guidance**: <https://supabase.com/docs/guides/troubleshooting/all-about-supabase-egress-a_Sg_e>
- **Detection: S**, with D seeds (a filterless select flowing into a JS filter).

### 7. `rls-as-only-filter`
Relying on the RLS policy instead of an explicit `.eq('user_id', uid)`
(171 ms → 9 ms in the official benchmark).
- **Guidance**: <https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv>
  says "Do not rely on RLS for filtering but only for security."
- **Detection: X** (ownership column from policies). **S** without migrations.

### 8. `count-exact-on-large-table`
`{ count: 'exact' }` runs `COUNT(*)` on every page view and times out on big tables
(57014). With `head: true` the timeout shows up as an empty-message 500.
- **Evidence**:
  - supabase-js #1661 (30M rows)
  - postgrest-js #190
  - 157 hits
  - <https://supabase.com/docs/guides/troubleshooting/canceling-statement-due-to-statement-timeout-581wFv>
- **Guidance**: JSDoc says "`exact`: Exact but slow … `planned`: Approximated but fast …
  `estimated`".
- **Detection: D** to find it. Severity is **X** or **S**.

### 9. `untyped-or-stale-client-types`
`createClient` without the `Database` generic, or a stale `database.types.ts`.
- **Evidence**:
  - <https://github.com/Frazzled-Productions/poke-memory/issues/2014> (the stub type
    unchanged 47 migrations later)
  - <https://github.com/dwenderf/membership-system/issues/247>
  - Type issues dominate the top supabase-js issues (#808 with 36 reactions; #1483,
    #974, #1542).
- **Guidance**: <https://supabase.com/docs/guides/api/rest/generating-types>
- **Detection: D** (no type argument). **X** (types file older than the newest migration).

### 10. `upsert-conflict-target-mismatch`
`upsert` without `onConflict` when the payload lacks the PK, which creates duplicates.
An `onConflict` that matches no full unique constraint fails with 42P10; partial
indexes can't be targeted.
- **Evidence**:
  - <https://github.com/orgs/supabase/discussions/36532>
  - <https://dev.to/maliikb/postgrest-cant-upsert-against-partial-unique-indexes-4c0g>
  - postgrest-js #403, supabase-js #1653
- **Guidance**: `onConflict` JSDoc says "Comma-separated UNIQUE column(s)."
- **Detection: D** (no `onConflict` and no `id` key in the payload literal). **X**
  (match against unique constraints).

### 11. `row-by-row-writes`
`insert`, `update` or `upsert` in a loop instead of one array call.
- **Evidence**: <https://github.com/orgs/supabase/discussions/11349>, <https://github.com/supabase/supabase/discussions/511>
- **Detection: D.**

### 12. `non-atomic-multi-step-write`
Sequential dependent writes from the client with no transaction (order → items → stock).
- **Evidence**: postgrest-js #219 "client-side transactions": **121 reactions, the
  most-reacted postgrest-js issue, still open.** Also postgrest-js #240.
- **Guidance**: <https://supabase.com/docs/guides/troubleshooting/certain-operations-are-too-complex-to-perform-directly-using-the-client-libraries-8JaphH>
  says to use `supabase.rpc`.
- **Detection: S.** Seed on two or more awaited mutations where a later one uses an id
  from an earlier result.

### 13. `client-recreated-per-call`
`createClient` inside components, hooks or functions in browser code causes "Multiple
GoTrueClient instances", refresh races and hangs.
- **Evidence**:
  - 16 hits
  - <https://github.com/orgs/supabase/discussions/16062>, <https://github.com/orgs/supabase/discussions/37755>
  - <https://community.vercel.com/t/multiple-gotrueclient-instances-detected-in-the-same-browser-context/32990>
  - supabase-js #936
- **Detection: D.**

### 14. `module-scope-server-client`
A session-bearing client shared across server requests (Vercel Fluid, containers) leaks
one user's session into another's request.
- **Evidence**:
  - <https://github.com/afterclass-io/afterclass.io/issues/566>
  - <https://github.com/pawtograder/platform/pull/984>
- **Guidance**: <https://supabase.com/docs/guides/auth/server-side/advanced-guide>
  says "Always initialize the Supabase client inside the request handler."
- **Detection: X** (server context), then D.

### 15. `privileged-key-misuse`
- **15a**: a service-role or `sb_secret_` key in the browser bundle.
- **15b**: the admin client used for user-scoped server work, or confusion between the
  SSR client and the service key.
- **Guidance**: <https://supabase.com/docs/guides/api/api-keys> says "Never put one in a
  browser, a shipped application, or source control."
  - New `sb_secret_` keys return 401 in browsers (matched on User-Agent); legacy JWTs
    are not protected this way.
  - <https://supabase.com/docs/guides/troubleshooting/why-is-my-service-role-key-client-getting-rls-errors-or-not-returning-data-7_1K9z>
- **Evidence**: 110 hits, plus the incidents below.
- **Detection**: 15a **D**. 15b **S + X**.

### 16. `serverless-direct-db-without-pooler`
Direct `:5432` connections from serverless cause exhaustion, and prepared statements on
transaction mode (6543) fail with 42P05. **The largest troubleshooting cluster
(33/223).**
- **Evidence**: 23 hits for "prepared statement already exists";
  <https://github.com/supabase/supabase/discussions/17751>;
  <https://supabase.com/docs/guides/database/prisma/prisma-troubleshooting>
- **Guidance**: <https://supabase.com/docs/guides/database/connecting-to-postgres>
  says "Transaction mode does not support prepared statements."
- **Detection: X** (deploy target + host/port + driver options + pool scope).

### 17. `filter-with-possibly-undefined`
`.eq('id', user?.id)` sends `"undefined"`, giving 22P02. `.eq(col, null)` matches
nothing; use `.is()`.
- **Evidence**: 31 hits; <https://github.com/orgs/supabase/discussions/34022>,
  <https://github.com/orgs/supabase/discussions/3369>
- **Detection: D** with the TS checker. **S** in plain JS.

### 18. `unescaped-postgrest-filter-string`
User input interpolated into `.or()`, `.filter()` or `.not()` can change the filter
logic. On a service-role client that is an authorization bypass.
- **Evidence**:
  - <https://github.com/orgs/supabase/discussions/3843>, <https://github.com/orgs/supabase/discussions/19651>
  - "Fix PostgREST filter injection" PRs: <https://github.com/Felipevieira2/wacrm/pull/47>,
    <https://github.com/shsacademyvirtualacd/Scholario/pull/68>
- **Detection: D.** Higher severity on a service-role client (**X**).

### 19. `timezone-naive-date-filter`
Local `Date` with `setHours(0)`, or bare date strings against `timestamptz`, give
off-by-one-day or off-by-hours results.
- **Evidence**: discussions <https://github.com/orgs/supabase/discussions/2625>, #22144, #14363
- **Detection: S.**

### 20. `textsearch-raw-input-default-type`
`.textSearch(col, userInput)` without `type` throws a tsquery syntax error on
multi-word input. Use `type: 'websearch'`. **[partially unverified]**
- **Detection: D.**

### Smaller candidates
- **`mutation-without-filter` / `single-as-guard`**: postgrest-js #461 shows
  `.delete().single()` still deletes multiple rows. **D.**
- **`unchecked-mutation-effect`**: an RLS-blocked update or delete returns `[]` with no
  error. Fix with `.select()` and assert a row came back. **S.**
- **`huge-in-list`**: `.in()` with hundreds of IDs fails with 414 URI too long
  (postgrest-js #393, 20 reactions). **S.**
- **`nextjs-fetch-cache-stale-data`**: caching in Next.js ≤ 14. Version-dependent. **X.**
- **`rpc-custom-40001-errcode`**: `raise … errcode '40001'` makes PostgREST retry in a
  loop. **D** on SQL.

---

## Pain-point landscape

### A. Troubleshooting articles clustered (223 articles, ±3 per bucket)

| Theme | Count |
|---|---|
| DB connectivity / pooling (Supavisor, IPv6, prepared statements, too many connections, serverless hangs) | 33 |
| Platform / billing / integrations (Vercel, Lovable, Bolt, egress, pausing) | 33 |
| Auth (emails, OTP/PKCE, OAuth redirects, cookies, SSR migration) | 32 |
| Performance / resources (CPU, RAM, disk IO, timeouts, indexes) | 27 |
| Edge Functions (status codes, CPU/wall-clock limits, bundle size) | 25 |
| Data API / PostgREST / SQL errors (schema cache, 42P01, 520s, OR-filter, "too complex") | 25 |
| RLS / permissions / keys | 16 |
| Realtime | 14 |
| Storage | 9 |
| CLI / migrations / branching | 7 |
| pg_cron / webhooks | 2 |

AI-builder platforms (Lovable, Bolt) now appear by name in article titles.

### B. Top-reacted GitHub issues (2026-10-05)
- **supabase-js**: bundling and runtime compatibility (#612 with 92 reactions, #151,
  #1400 Expo with 66r/147c); auth locks (#936) and getSession warnings (#1703, #1709);
  **#885 throwOnError default (50)**; types (#808).
- **postgrest-js**: **#219 transactions (121)**, #204 camelCase (105), #206 aggregates
  (56), #174 bulk update (54), #393 URI too long (20).
- **supabase**: mostly product requests. Historically relevant: #4991 "Enable RLS by
  default" (24), #563 signup trigger (22).

### C. Security incidents in AI-generated ("vibe-coded") Supabase apps

| Source | Date | Findings |
|---|---|---|
| CVE-2025-48757 (Lovable) | Mar–May 2025 | **170 of 1,645 apps (~10.3%)** with missing or weak RLS; 303 endpoints. <https://www.bleek.dev/cve-2025-48757> |
| Escape.tech | 2025-10-29 | 5,600 apps: 2,000+ vulnerabilities, 400+ exposed secrets, 175 PII exposures, service-role keys exposed. <https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/> |
| Wiz (Moltbook) | 2026-01/02 | No RLS: ~4.75M records, 1.5M API tokens. <https://www.wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys> |
| Symbiotic Security | 2026-06-02 | 1,072 apps: **98% had at least one issue, 16% critical**; 172 allow anon DELETE, 172 allow anon PATCH. <https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws> |

**Linter implication:** the root cause is almost always missing RLS, permissive write
policies, or (less often) service keys in the bundle. **A public anon or publishable key
is by design; do not flag it.** Several scanners make that false positive.

### D. What users complain about most (2025–2026)
1. Connections and pooling (largest troubleshooting cluster).
2. Auth and SSR session handling.
3. Silent RLS behaviour (empty arrays, 0-row mutations), plus the missing-RLS disasters.
4. Error-as-value DX and types.
5. Client-library gaps that drive unsafe workarounds (no transactions, no bulk update,
   the 1000-row cap).
6. Bundling and runtime compatibility (mostly not lintable).
7. Cost: egress and realtime quotas.
