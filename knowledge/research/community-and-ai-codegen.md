# Community evidence (Stack Overflow, Reddit) and AI code generation

Research pass done 2026-10-05. It fills the two gaps listed in [README.md](README.md#research-gaps):
there was no Reddit evidence and the Stack Overflow evidence was thin. It also adds what AI app
builders and coding agents generate for Supabase.

Status markers used below:
- **[verified]**: read in a primary source (an API response, a repo file, or the vendor's own docs).
- **[secondary]**: reported by a third party; the primary source was not read.
- **[unverified]**: a vendor or marketing claim, or the numbers disagree between sources.

---

## 0. Key takeaways

1. **The question volume is moving away from public Q&A.** Questions tagged `supabase` on
   Stack Overflow peaked in 2023 at 832, then fell to 553 in 2024, 206 in 2025 and 34 so far in
   2026. r/Supabase kept growing until 2025 (4,051 posts) and is lower in 2026 (≈2,000 to
   October; the archive may be incomplete). Most debugging now happens inside AI assistants.
   That supports the plan's view that **agents are a primary consumer of our CLI**.
2. **Old Stack Overflow questions are about the query API and errors. Recent Reddit posts are
   about security and operations.**
   - Stack Overflow's highest-view clusters: embedded joins and filters, RLS write violations
     (`new row violates…`, mostly Storage), server-side session in Next.js, count and
     pagination, `permission denied for schema public`, and env and client initialisation.
   - Reddit, Oct 2025 to Oct 2026: about 12% of posts mention RLS, 2.3% mention
     `service_role`/secret keys and 2.6% mention MCP. Audit posts ("I audited N apps")
     repeatedly name the same top 5: RLS off, `USING (true)`, service key in the bundle,
     public buckets, and anon access to auth endpoints.
3. **AI builders generate the security-critical anti-patterns at scale, and their prompts only
   half prevent them.**
   - Bolt's open-source prompt requires `ENABLE ROW LEVEL SECURITY` and "appropriate policies".
     It also requires that **email confirmation is always disabled**, shows `auth.uid()`
     unwrapped, and gives no guidance on Edge Function auth, storage policies or UPDATE
     `WITH CHECK`.
   - Lovable generates a Vite SPA with no server, so every authorization decision has to live
     in RLS or Edge Functions.
   - General agents (Cursor, Claude Code, Codex) fall back on outdated training data:
     `auth-helpers`, server-side `getSession`, and `get/set/remove` cookie adapters.
4. **A counter-signal on `service-key-in-client`.** A Reddit static scan of 47 verified Lovable
   repos found **0/47** service_role keys in frontend code and 6/24 Supabase repos with
   `CREATE TABLE` but no `ENABLE RLS`. This matches the field survey's "0 live, 2 latent".
   Service keys in bundles show up in *URL* scans (SupaExplorer: 11% of 20k indie apps expose
   *some* Supabase credential). The linter will meet them less often in repos than in
   deployed bundles.
5. **13 candidate rules the catalogue doesn't have yet** (§4). The strongest are:
   - `insert-missing-owner-column`: the policy checks `auth.uid() = user_id`, but the insert
     never sets `user_id`.
   - `embedded-filter-without-inner`.
   - `rpc-args-mismatch-function-signature`.
   - `schema-not-exposed-in-config`.
   - `mutation-result-without-select`.
   - `auth-email-confirmation-disabled`.
   - `policy-ignores-is-anonymous`.
   - `supabase-env-not-public-in-client`.

---

## 1. Stack Overflow

### 1.1 Method

- I used the Stack Exchange API 2.3 with no key (quota was 300 a day; about 120 were used).
- I fetched `tagged=supabase`: top 500 by votes, the 300 most recently active, and the top 100
  by votes for each of these tag combinations:
  - `supabase;supabase-js`
  - `supabase;supabase-auth`
  - `supabase;supabase-database`
  - `supabase;row-level-security`
  - `supabase;supabase-realtime`
  - `supabase;supabase-flutter`
  - `supabase;supabase-edge-functions`
  - `supabase;nextjs`
- **After de-duplication there are 867 unique questions with 2.42M total views.**
- I assigned themes with a title-keyword heuristic (ordered regex, first match wins, plus
  multi-label counts), using Elixir scripts in the session scratchpad.
  - **Expect noise of about 20–30%.** For example, "sql dump file" lands in Storage because of
    "file".
  - Treat the counts as orders of magnitude, not exact figures.
  - The `search/advanced` counts in §1.4 match title and body, so they are a second,
    independent signal.

### 1.2 Tag size and growth [verified]

| | Questions |
|---|---|
| `supabase` tag total (`filter=total`) | **2,136** |
| `supabase-database` | 464 |
| `supabase-js` | 211 |
| `supabase-flutter` | 82 |
| `supabase-realtime` | 25 |
| `supabase-py` | 23 |
| `supabase-edge-functions` / `supabase-function` | 3 / 3 |
| `supabase-auth` | synonym of `supabase` (merged; applied 19 times) |

| Year | New `supabase` questions |
|---|---|
| 2020 | 2 |
| 2021 | 102 |
| 2022 | 407 |
| 2023 | **832** (peak) |
| 2024 | 553 |
| 2025 | 206 |
| 2026 (to 5 Oct) | 34 |

Stack Overflow is a **historical** corpus. It is good for which errors confuse people
(2021–2024) but says nothing about the 2025–26 key and API changes. The decline follows
Stack Overflow's overall post-LLM collapse; it doesn't mean Supabase usage fell.

### 1.3 Themes, mapped to catalogue ids (867 questions)

"Primary" means the first matching theme; "any" means any matching theme.

| Theme | Primary n | Primary views | Any n | Catalogue ids |
|---|---|---|---|---|
| Auth flows: redirect, OAuth, email, password reset | 79 | 196k | 106 | `redirect-url-hardcoded-or-unlisted`, `pkce-email-link-misconfig`, `auth-callback-open-redirect`, `signup-confirmation-misread` |
| Server-side session, SSR, cookies, middleware | 76 | 225k | 85 | `server-trusts-getsession`, `ssr-cookie-adapter-broken`, `middleware-session-refresh-missing`, `deprecated-auth-helpers`, `plain-client-in-ssr` |
| Storage (uploads, bucket RLS, URLs) | 57 | 183k | 67 | `storage-upsert-missing-policies`, `storage-policy-not-owner-scoped`, `storage-getpublicurl-on-private-bucket`, `storage-rn-blob-upload` |
| RLS design how-to (roles, column-level, tenants) | 57 | 95k | 79 | `policy-authenticated-not-authorized`, `policy-join-row-to-membership`, `sensitive-columns-exposed`, `user-metadata-for-authorization` |
| Pooler, ORM, connections | 42 | 142k | 56 | `serverless-direct-db-without-pooler` |
| Embedded joins and foreign-table filters | 34 | 146k | 49 | **gap**: `embedded-filter-without-inner`, `ambiguous-embed-needs-fk-hint` (new); `n-plus-one-queries` |
| Edge Functions | 34 | 69k | 37 | `ef-missing-cors-preflight`, `ef-unpinned-remote-imports`, `ef-service-role-trusts-body-identity` |
| Realtime | 34 | 52k | 39 | `realtime-table-not-in-publication`, `realtime-filter-or-old-without-replica-identity`, `realtime-channel-not-removed` |
| Dates, enums, types, bigint | 35 | 94k | 70 | `timezone-naive-date-filter`, `untyped-or-stale-client-types`; **gap**: `bigint-precision-loss` |
| Signup, profile, trigger | 32 | 87k | 36 | `auth-users-trigger-fragile`, `signup-confirmation-misread` |
| Filter syntax (or/and, jsonb, FTS, escaping) | 22 | 40k | 60 | `unescaped-postgrest-filter-string`, `textsearch-raw-input-default-type` |
| RLS write violation (`new row violates…`) | 20 | **122k** | 20 | `rls-enabled-no-policy`, `storage-upsert-missing-policies`, `write-policy-missing-ownership-check`; **gap**: `insert-missing-owner-column` |
| RPC, functions, triggers | 20 | 36k | 32 | `security-definer-function-exposed`, `security-definer-mutable-search-path`; **gap**: `rpc-args-mismatch-function-signature` |
| Env, client init, singleton | 19 | 111k | 28 | `client-per-render`; **gap**: `supabase-env-not-public-in-client` |
| Auth client state (`onAuthStateChange`, refresh, GoTrue instances) | 16 | 47k | 23 | `onauthstatechange-async-deadlock`, `client-per-render` |
| Mutations: upsert, transactions, return id | 14 | 81k | 22 | `upsert-conflict-target-mismatch`, `non-atomic-multi-step-write`, `row-by-row-writes`; **gap**: `mutation-result-without-select` |
| Admin, service role, `auth.users` | 13 | 41k | 19 | `admin-api-from-client`, `auth-users-exposed`, `service-key-in-client` |
| Silent empty result or no-op update | 13 | 53k | 15 | `rls-enabled-no-policy`, `update-policy-without-select-policy`, `unchecked-mutation-effect` |
| Count and pagination | 9 | 89k | 17 | `count-exact-on-large-table`, `unbounded-select-silent-truncation`, `range-without-order` |
| `.single()`, 406 | 8 | 37k | 10 | `single-where-maybe-single` |
| JWT and third-party auth (Clerk, Firebase, custom) | 8 | 19k | 24 | `jwt-decode-without-verification` |
| `permission denied` / grants | 6 | 64k | 7 | `missing-api-grants-new-table` |
| RLS recursion | 4 | 7k | 4 | `recursive-rls-policy` |
| Custom schema access | 1 | 11k | 3 | **gap**: `schema-not-exposed-in-config` |
| Out of scope: SDK, build, platform (Flutter, Expo, Gradle…) | 67 | 92k | 143 | n/a |
| Out of scope: CLI, local dev, self-hosting, deploy | 36 | 113k | 130 | n/a |
| Unclassified | 111 | 163k | | |

Representative high-view questions [verified]:
- Joins and filters:
  - [How to query using join](https://stackoverflow.com/q/64996432) (58k views)
  - [Filtering in join](https://stackoverflow.com/q/69137919) (21k)
  - [Filter by column of foreign key row](https://stackoverflow.com/q/69665030) (10k)
- RLS writes:
  - [Bucket: new row violates RLS for "objects"](https://stackoverflow.com/q/74302341) (49k)
  - [new row violates RLS for "tasks"](https://stackoverflow.com/q/73862780) (23k)
  - [Bucket insert policy not working](https://stackoverflow.com/q/72861584) (11k)
- Grants: [permission denied for schema public](https://stackoverflow.com/q/67551593) (45k)
  and [public tables became inaccessible by API](https://stackoverflow.com/q/76600285). These
  were the precursor of the 2026-10-30 wave (`missing-api-grants-new-table`).
- Env: [supabaseUrl is required](https://stackoverflow.com/q/68239168) (30k).
- Mutations: [INSERT and return id](https://stackoverflow.com/q/74981893) (21k) is the v2
  `insert()` that returns `data: null` without `.select()`.
- Custom schema: [Access custom schema from supabase-js](https://stackoverflow.com/q/73281996) (11k).
- RPC: [Could not find the function in the schema cache](https://stackoverflow.com/q/76011758)
  (10k) and [PGRST202 with a passed parameter](https://stackoverflow.com/q/76747152).
- Silent empty results: [Supabase returns empty array](https://stackoverflow.com/q/75039258)
  (11k) and [Next.js empty array when data exists](https://stackoverflow.com/q/71294440) (10k).
- Session: [`getSession()` is potentially insecure](https://stackoverflow.com/q/78297790)
  (7k; 2024) and [Multiple GoTrueClient instances](https://stackoverflow.com/q/76773817) (13k).
- Recursion: [infinite recursion in policy for "profiles"](https://stackoverflow.com/q/77592664).

### 1.4 Full-text search counts within `tagged=supabase` (title and body) [verified]

| Query | Hits | | Query | Hits |
|---|---|---|---|---|
| `null` | 529 | | `row level security` | 92 |
| `types` | 241 | | `auth-helpers` | 90 |
| `redirect` | 200 | | `prisma` | 90 |
| `.schema(` | 200 (noisy) | | `edge function` | 88 |
| `policy` | 184 | | `realtime` | 75 |
| `RLS` | 175 | | `migration` | 68 |
| `single()` | 133 | | `storage upload` | 66 |
| `session null` | 126 | | `middleware` | 59 |
| `undefined` | 123 | | `delete user` | 59 |
| `join` | 119 | | `rpc` | 52 |
| `role` | 118 | | `bigint` | 51 |
| `foreign key` | 104 | | `@supabase/ssr` | 39 |
| `cookies` | 100 | | `security definer` | 39 |
| `new row violates row-level security` | 34 | | `!inner` | **33** |
| `returns empty` | 34 | | `Could not find the function` | **31** |
| `getUser` / `getSession` | 29 / 23 | | `onAuthStateChange` | 28 |
| `auth.uid() null` | 25 | | `trigger auth.users` | 24 |
| `insert returns null` | **22** | | `Auth session missing` | 20 |
| `on delete cascade` | 20 | | `42501` | 17 |
| `supabaseUrl is required` | **17** | | `.select() after insert` | 17 |
| `service_role` | 16 | | `CORS` | 13 |
| `schema cache` | 13 | | `permission denied` | 11 |
| `pooler` | 11 | | `user_metadata` | 10 |
| `handle_new_user` | 9 | | `raw_user_meta_data` | 7 |
| `infinite recursion` | 6 | | `Invalid Refresh Token` | 6 |
| `Multiple GoTrueClient` | 5 | | `More than one relationship` | 4 |
| `PGRST202` | 3 | | `Lovable` / `ChatGPT` / `Cursor` | 1 / 13 / 14 |

### 1.5 What Stack Overflow adds to the catalogue

- **It confirms these existing items as high-frequency:**
  - `storage-upsert-missing-policies` and storage insert policies (the largest single RLS
    cluster by views)
  - `missing-api-grants-new-table`
  - `server-trusts-getsession` and SSR
  - `rls-enabled-no-policy` (silent empty results)
  - `single-where-maybe-single`
  - `count-exact-on-large-table`
  - `serverless-direct-db-without-pooler`
- **It surfaces six query-API correctness gaps** (§4: items 1–6). These are pain points
  (confusion and broken behaviour), not security, but they are cheap, mostly deterministic, and
  agents hit them too.
- **Thin on SO:** realtime, edge functions and recursion. These questions mostly live in
  GitHub Discussions and Discord. Few security questions are on SO because people don't know
  they have a problem; scanners and audits surface those instead (see Reddit and §3).

---

## 2. Reddit (r/Supabase)

### 2.1 Access

- I tried these endpoints with a descriptive User-Agent:
  - `www.reddit.com/.../top.json` → **403**.
  - `old.reddit.com/...json` → **403**.
  - `api.reddit.com` → 302 to a block page.
  - `www.reddit.com/r/Supabase/top/.rss?t=year` → **200, 100 entries** (top of the year).
  - Search RSS → 200 for the first two queries, then **429**.
  - PullPush → 429, refused for agents.
- **The [Arctic Shift](https://arctic-shift.photon-reddit.com) archive API worked.** I pulled
  every r/Supabase submission from **2025-10-01 to 2026-10-05: 2,846 posts**, with title, the
  first 600 characters of selftext, score, comments and flair. I fetched full text for about 30
  key posts by id.
- **Caveats:**
  - Arctic Shift is a third-party archive. The Aug–Sep 2026 monthly counts (152, 140) are lower
    than earlier months (~220–315), which may be ingestion lag.
  - I matched on titles plus 600 characters, so body-only mentions are undercounted.

Yearly r/Supabase submission counts from Arctic Shift's aggregate endpoint [verified, archive
coverage unverified]:

| Year | Posts |
|---|---|
| 2021 | 180 |
| 2022 | 685 |
| 2023 | 2,176 |
| 2024 | 3,902 |
| 2025 | 4,051 |
| 2026 (to Oct) | 1,999 |

Flair split for Oct 2025 to Oct 2026:

| Flair | Posts |
|---|---|
| tips | 760 |
| database | 428 |
| other | 425 |
| auth | 316 |
| realtime | 155 |
| integrations | 153 |
| self-hosting | 132 |
| edge-functions | 130 |
| dashboard | 107 |
| cli | 97 |
| storage | 71 |

**The top 100 posts of the year (RSS) are dominated by platform news, outages, pricing and
self-hosting.** Code anti-patterns are a minority of what is upvoted. Security posts that do
rank:
- "Supabase Auth allows direct signup via anon key, make sure you enable captcha" (74)
- "12 things that show up almost every time I go through someone else's Supabase project" (39)
- "State of Supabase Exposure Across Vibe-Coding Apps" (35)
- "How do you personally verify your RLS… before launching?" (36)

### 2.2 Themes (2,846 posts, title plus 600 characters, keyword heuristic)

| Theme | Primary | Any | Of "any", posts naming an AI tool | Catalogue ids |
|---|---|---|---|---|
| RLS design and policies | 314 | 359 | 52 | `rls-disabled-on-exposed-table`, `rls-policy-always-true`, `policy-authenticated-not-authorized`, `write-policy-missing-ownership-check`, `self-updatable-privilege-column` |
| Outage, billing, platform | 228 | 352 | 16 | out of scope |
| Migrations, CLI, environments | 166 | 286 | 39 | `policy drift` (dashboard edits not in migrations; see §4) |
| Edge Functions | 172 | 241 | 33 | `ef-*`, `webhook-signature-not-verified` |
| Storage | 131 | 233 | 14 | `storage-*`, `public-bucket-listing-policy` |
| Self-hosting | 129 | 205 | 10 | out of scope |
| Auth flows (email, OAuth, OTP, captcha) | 132 | 160 | 6 | `redirect-url-hardcoded-or-unlisted`, `captcha-client-only`, `pkce-email-link-misconfig` |
| Pooling, connections, performance | 82 | 144 | 7 | `serverless-direct-db-without-pooler`, `policy-column-not-indexed`, `auth-function-not-wrapped-in-select` |
| Realtime | 72 | 126 | 8 | `realtime-*` |
| Service key and secret exposure | 45 | 109 | 25 | `service-key-in-client`, `cron-hardcoded-secret-key` |
| Query API (joins, upsert, single, range) | 47 | 106 | 7 | data-api items |
| Cron, queues, webhooks | 43 | 96 | 14 | `cron-*`, `queues-exposed-without-rls` |
| Server session, SSR | 47 | 72 | **0** | `server-trusts-getsession`, `ssr-cookie-adapter-broken` |
| Security definer and RPC | 17 | 51 | 6 | `security-definer-function-exposed` |
| Grants and Data API exposure | 17 | 28 | 1 | `missing-api-grants-new-table` |
| Silent empty or no-op | 10 | 17 | 4 | `rls-enabled-no-policy`, `update-policy-without-select-policy` |
| Signup trigger and metadata | 7 | 17 | 0 | `auth-users-trigger-fragile`, `user-metadata-for-authorization` |
| Unclassified | 1,173 | | | |

Term frequency in the same corpus (posts, of which name an AI tool):

| Term | Posts | Naming an AI tool |
|---|---|---|
| RLS / row level security | 303 | 43 |
| MCP | 73 | **32** |
| service_role / secret key | 66 | 12 |
| email confirmation / SMTP | 48 | 1 |
| redirect URL / OAuth callback | 48 | 2 |
| `@supabase/ssr` / cookies / middleware | 46 | 0 |
| webhook | 44 | 8 |
| pooler / connections | 32 | 1 |
| captcha / signup abuse / rate limit | 30 | 0 |
| Data API / grants / default privileges | 21 | 0 |
| realtime channel / `postgres_changes` | 19 | 0 |
| `USING (true)` | 16 | **7** |
| security definer | 16 | 3 |
| getSession / getUser / getClaims | 13 | 0 |
| upsert | 12 | 2 |
| pg_cron / pg_net | 12 | 2 |
| storage public bucket / `storage.objects` | 11 | 0 |
| app_metadata / custom claims | 6 | 0 |
| verify_jwt | 5 | 0 |
| CORS | 4 | 1 |
| new row violates RLS | 3 | 1 |
| user_metadata | 3 | 0 |
| anonymous sign-in / is_anonymous | 3 | 0 |
| infinite recursion | 0 | 0 |

Tool mentions:

| Tool | Posts |
|---|---|
| lovable | 81 |
| claude | 62 |
| vibe | 58 |
| cursor | 35 |
| bolt | 15 |
| v0 | 10 |
| replit | 7 |
| base44 | 2 |

In total, 281 of 2,846 posts (9.9%) mention an AI tool.

### 2.3 Notable posts and what they map to [verified unless marked]

All links are `reddit.com/r/Supabase/comments/<id>`.

- **Audits of AI-built apps.** Practitioners describe these as recurring:
  - `1t1owgf`, "Audited 8 Supabase apps last week. Most had RLS off" (22). All 8 were built
    with Lovable, v0 or Cursor; most had `users` readable by anon.
    - Maps to `rls-disabled-on-exposed-table` and `rls-policy-always-true`.
    - One app bundled the service key because "they imported `supabase` from the same shared
      file that browser code was using". That is `service-key-in-client` via the
      **import graph**, which confirms the X detection.
    - One app had a `delete_all_users()` RPC that anon could execute
      (`security-definer-function-exposed`, `function-execute-revoke-incomplete`).
  - `1wg0u4r`, "12 things…" (39). Code-relevant items:
    - service key in the bundle, sometimes "a fix from eight months ago somebody meant to
      revert";
    - RLS on with a "true" policy "to make the error go away";
    - **no index on FK columns**;
    - public buckets left over from testing;
    - **triggers that assume one row changes at a time**;
    - migrations run by hand and missing from files;
    - anon hitting auth directly;
    - cron or Edge Functions toggled in the dashboard with no trace in the repo;
    - **an auth trigger written for email signup that breaks on OAuth** (metadata fields
      missing), which is `auth-users-trigger-fragile`.
  - `1u5h5zl`, "AI agents keep saying apps are production-ready while RLS is still broken" (9,
    13 comments). The author's list:
    - the agent treats `[]` as "no data" instead of "policy blocked it";
    - **the policy checks `auth.uid() = user_id` but the insert never sets `user_id`**;
    - `WITH CHECK` is missing;
    - a broad authenticated SELECT is added "just to make the UI work";
    - redirect URLs are missing for Vercel previews;
    - **dashboard policy edits are missing from migrations**;
    - anonymous users pass `authenticated`;
    - a policy depends on a table whose own RLS blocks the check.
  - `1t58g8u`, "Three RLS pitfalls AI codegen tools keep shipping" (20):
    - tables created through SQL don't get RLS (only the Table Editor turns it on);
    - RLS enabled with no policies fails silently;
    - `auth.uid() = user_id` silently false for anon;
    - views bypass RLS (`view-missing-security-invoker`).
  - `1t69so5`, "Three Storage pitfalls AI codegen tools keep shipping":
    - `upload(..., {upsert:true})` with only an INSERT policy
      (`storage-upsert-missing-policies`);
    - **an owner-scoped SELECT still lets `list('')` enumerate every filename** (new sub-case
      of `storage-policy-not-owner-scoped`).
  - `1ujwgy7`, "Supabase bugs generated by Claude/Cursor" (5):
    - an **inverted predicate `auth.uid() != id`**;
    - unsigned webhooks (`webhook-signature-not-verified`);
    - `user_id` taken from `req.body` (`ef-service-role-trusts-body-identity`);
    - missing user filter.
  - `1rbxrh7`, "How do you stop Cursor from writing insecure PostgREST calls" (8):
    - string-interpolated SQL in Edge Functions;
    - raw input into `.rpc()`;
    - the service key leaking through server/client confusion.
  - `1wv5k7i`: an agent added 3 tables; the dashboard showed RLS on; one still returned every
    row to anon "because of a leftover `USING (true)` policy". This is a **multiple permissive
    policies** case: one permissive policy opens the table regardless of the others.
- **Counter-evidence.** `1v747so`, "I scanned 47 public Lovable repos… 0 for 47" (12):
  - Repos were verified via the `lovable-tagger` dependency.
  - service_role in frontend code: **0/47**. Real secrets anywhere: 0/47. Committed `.env`:
    12, all values public by design.
  - Of the 24 repos using Supabase, **6 had `CREATE TABLE` with no `ENABLE ROW LEVEL SECURITY`**
    and 5 shipped no SQL at all.
  - Treat this as a small sample; the author's own scanner initially false-positived on the
    public `.env` values.
  - It matches the field survey: repo-level service-key leaks are rare. The **RLS-in-migrations
    signal is the common one**, and some repos have no migrations to check (coverage
    limitation).
- **Privilege-bearing columns.** `1o0esut`: in Post-Bridge ($10k+ MRR), `profiles` had an
  UPDATE policy scoped to the owner, but users could set `has_access` and `access_level`
  themselves. That is `self-updatable-privilege-column`, the canonical example. The fix was
  `WITH CHECK (has_access IS NOT DISTINCT FROM (select …))`.
- **Anonymous sign-ins.** `1tm0lm5` (50): anonymous users hold `authenticated`. An
  invitation-accept UPDATE policy compared `invited_email = (select email from auth.users …)`;
  the anon user's email is null and some invitation rows had null email. The post describes this
  as "null matched null" (by SQL semantics it's more likely `IS NOT DISTINCT FROM`, a
  `coalesce`, or an RPC path; the post is ambiguous). Anon users joined teams.
  - New candidates: `policy-ignores-is-anonymous` and `nullable-comparison-in-policy` (§4).
- **Performance.** `1o18s4i`: a SECURITY DEFINER helper `user_has_tenant_access(tenant_id)` in a
  policy ran 8,010 times per query (155× slower). Generalise
  `auth-function-not-wrapped-in-select` to **any STABLE helper whose arguments don't depend on
  the row** (`(select fn())` lets Postgres cache it), and to row-dependent helpers that should
  be rewritten as `tenant_id in (select …)`.
- **Auth abuse.** `1sm75sv` (74): `/auth/v1/signup` can be called directly with the anon key,
  which bypasses app-level Turnstile and rate limits.
  - This maps to `captcha-client-only` plus config `[auth.captcha] enabled = false`.
  - Echoed in `1wg0u4r` (#7) and by Symbiotic (69 sites with email confirmation disabled).
- **Webhooks.** `1nw4krx`: Dashboard Database Webhooks embed the secret header in the trigger
  definition, so it leaks via schema copy and `pg_dump`, then lands in git or in AI chats.
  Extend `cron-hardcoded-secret-key` to `supabase_functions.http_request(...)` and
  `net.http_post` triggers in migrations.
- **Scraping with a valid token.** `1pjbu4j` (39): an authenticated user can
  `select('*')` an entire 5,000-question table. This is an architectural issue, not lintable.
  It is related to `policy-authenticated-not-authorized` and to choosing a view or RPC that
  pages server-side.
- **Agents with database access.**
  - `1q00gtb`, "If you're using Claude Code with Supabase CLI, do this NOW" (25, 28 comments):
    the author lost their dev database twice.
  - `1vaa038`: a satire/meme post about an agent wiping production tables (not evidence of an
    actual incident).
  - `1sg9k4x`: MCP with `always_allow` makes RLS the last line of defence.
  - These matter for CLI design (agents as consumers): the linter's output must not suggest
    destructive fixes such as `db reset` or `disable row level security`.
- **Supabase Evals** (`1vc27f5`, `1vfjy99`) [secondary for numbers]: Supabase's open-source
  agent benchmark.
  - The leaderboard as of 2026-08-04 without skills: Codex / GPT-5.6 sol at 100%; Claude Code
    Opus 5 / Sonnet 5 and OpenCode / Kimi K3 at 95%; GPT-5.4 mini at 79%.
  - "Investigate" is the weakest stage at 67% for most agents.
- **Reddit-only themes Stack Overflow lacks:**
  - migration drift (policies edited in the dashboard), the most frequent operational
    complaint after outages and billing;
  - auth abuse through direct API access;
  - MCP and agent safety.

---

## 3. AI code generation

### 3.1 What each tool's prompt says about Supabase

| Tool | Source | What the prompt or docs require | What is missing or induced |
|---|---|---|---|
| **Bolt / bolt.diy** | [`app/lib/common/prompts/prompts.ts`](https://github.com/stackblitz-labs/bolt.diy/blob/main/app/lib/common/prompts/prompts.ts) and `new-prompt.ts` [verified] | Supabase by default. "ALWAYS enable RLS for new tables". "Add appropriate RLS policies for CRUD operations". A singleton `@supabase/supabase-js` client. Env in `.env` as `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`. Built-in auth only, no custom auth tables. No `DROP`/`DELETE` and no `BEGIN/COMMIT`. A migration file per change, plus immediate query execution. `IF NOT EXISTS` everywhere. "Add indexes for frequently queried columns". | **"Email confirmation is ALWAYS disabled unless explicitly stated!"** → `auth-email-confirmation-disabled` (new). "Create policies based on user authentication" is ambiguous and invites `TO authenticated USING (true)` → `policy-authenticated-not-authorized`. The example policy uses bare `auth.uid() = id` → `auth-function-not-wrapped-in-select`. The example creates `public.users (email …)`, duplicating `auth.users` → `sensitive-columns-exposed`. It says both "Do not try to generate types" and "Use TypeScript generated types" → `untyped-or-stale-client-types`. Nothing on UPDATE `WITH CHECK`, `FOR ALL`, Edge Function auth (`verify_jwt`, caller identity), Storage policies, service-key handling, `security definer`, views, or grants. "Strings: DEFAULT ''" masks missing data. No password strength or captcha. |
| **Bolt (hosted)** | [support.bolt.new/integrations/supabase](https://support.bolt.new/integrations/supabase), [troubleshooting](https://support.bolt.new/troubleshooting/integrations-issues) [verified] | Supabase for DB, auth and Edge Functions (Stripe, OpenAI); the newer default is "Bolt Database". The troubleshooting page says that for webhooks, "JWT verification must be disabled, and other validation methods should be added". | The docs push `verify_jwt=false` for webhooks. Without signature checks this becomes `webhook-signature-not-verified` / `ef-service-role-trusts-body-identity`. No RLS defaults are documented. |
| **Lovable** | Leaked Agent Prompt and Tools (Sep 2025), [x1xhlol/system-prompts…](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/tree/main/Lovable) [verified as leaked]; [docs: Supabase](https://docs.lovable.dev/integrations/supabase), [security](https://docs.lovable.dev/features/security) [verified] | Stack is React + Vite + Tailwind, and it "cannot run backend code"; the backend is Supabase (DB, auth, Edge Functions). Tools: `supabase--docs-search`, `supabase--docs-get`, `security--run_security_scan` ("detect exposed data, missing RLS policies, and security misconfigurations"), `security--get_table_schema`. Secrets go to Supabase Edge Function secrets and are "never in code". The scan checks RLS coverage, "access rules that let everyone through", and leaked-password protection. The "Deep scan" claims to verify that server code honors the ownership rules. | **The architecture concentrates risk.** With no server, every authorization decision lives in RLS or Edge Functions; there is no SSR layer to get wrong. So the dominant failures are: `rls-disabled-on-exposed-table`, `rls-policy-always-true`, `write-policy-missing-ownership-check`, `self-updatable-privilege-column`, `ef-service-role-trusts-body-identity`, `verify_jwt=false` functions, `security-definer-function-exposed` (helper RPCs), and `private-data-in-public-bucket`. The scanner reportedly checked RLS *presence*, not correctness, at launch (Apr 2025) [secondary: Superblocks, VibeAppScanner]. |
| **v0 (Vercel)** | Leaked prompt [verified as leaked]; [v0 docs: databases](https://v0.app/docs/databases); [Vercel Academy client utilities](https://vercel.com/academy/subscription-store/supabase-client-utilities) [secondary] | Supabase is the **mandatory default recommendation** for auth and DB ("MUST recommend Supabase"). It "MUST use native Supabase Auth". It "ALWAYS implements … Row Level Security (RLS) when using Supabase", HTTP-only cookies, and no ORM. Integration-specific "skills" drive setup (MCP for Supabase). The Academy pattern is `@supabase/ssr` `createBrowserClient`/`createServerClient` with `getAll/setAll`, and middleware `updateSession`. | Next.js App Router, so the whole SSR class applies: `server-trusts-getsession`, `middleware-session-refresh-missing`, `module-scope-server-client`, `ssr-client-with-service-role`, `NEXT_PUBLIC_*SERVICE*`, and `nextjs-fetch-cache-stale-data`. Older v0 flows produced `.sql` files for the user to paste into the SQL Editor [secondary: Codecademy], which causes policy drift and repos with no migrations. |
| **Replit Agent** | Leaked prompt (no Supabase mention) [verified]; [Replit support](https://x.com/ReplitSupport/status/2046721307903922321), [Supabase blog](https://supabase.com/blog/using-supabase-replit) [secondary] | Defaults to Replit's built-in (Neon) Postgres. Supabase is reached via a connector or secrets, and the agent "can't see" the Supabase DB, so it writes scripts. | Lower Supabase share. Backend code is often Express with `DATABASE_URL` → `serverless-direct-db-without-pooler`, and admin-key server code → `admin-client-for-user-scoped-work`. |
| **Base44** | [Wiz via The Hacker News](https://thehackernews.com/2025/07/wiz-uncovers-critical-access-bypass.html) [secondary] | Uses its own backend, not Supabase. | Not relevant to Supabase rules. Its July 2025 auth bypass (registration via a public `app_id`) is the same idea as `captcha-client-only` and open signup. |
| **Cursor, Claude Code, Codex, ChatGPT** (general agents) | Supabase blog ["AI Agents Know About Supabase. They Don't Always Use It Right"](https://supabase.com/blog/supabase-agent-skills) [verified]; [auth-helpers README "for AI assistants"](https://github.com/supabase/auth-helpers) [secondary] | No Supabase prompt by default; they rely on rules files (`.cursor/rules`, `CLAUDE.md`) and skills. | Training-data lag: `@supabase/auth-helpers-nextjs`, `get/set/remove` cookie adapters, server-side `getSession()`, and `middleware.ts` vs Next 16 `proxy.ts`. Supabase says agents "skip RLS policies on exposed schemas", hallucinate CLI commands (`supabase db execute`), create views without `security_invoker`, and "even with `search_docs` available, the MCP-only agent never called it". Skill eval pass rates, MCP only vs MCP + skill: Opus 4.6 50→67%, Sonnet 4.6 58→71%, GPT-5.4 71→88%, Codex Mini 63→71%. |

### 3.2 Supabase's own AI guidance, and which rules it already encodes

Sources [verified]:
- prompts in [`supabase/supabase/examples/prompts/`](https://github.com/supabase/supabase/tree/master/examples/prompts),
  served at [supabase.com/docs/guides/getting-started/ai-prompts](https://supabase.com/docs/guides/getting-started/ai-prompts);
- the [`supabase/agent-skills`](https://github.com/supabase/agent-skills) skill `supabase`
  v0.1.2, which includes a security checklist, plus `supabase-postgres-best-practices`.

| Guidance (quoted or paraphrased) | Where | Catalogue id |
|---|---|---|
| Enable RLS on every table in an exposed schema | skill §5, `database-create-migration.md` | `rls-disabled-on-exposed-table` |
| Newly created tables may not be exposed; grant `anon`/`authenticated` explicitly and enable RLS with any public grant | skill §4 | `missing-api-grants-new-table` (and the "fix with GRANT ALL" trap) |
| Never use `user_metadata` in authorization; use `app_metadata` | skill checklist | `user-metadata-for-authorization` |
| Never expose `service_role`/secret keys; `NEXT_PUBLIC_` goes to the browser | skill checklist | `service-key-in-client` |
| Views bypass RLS; use `security_invoker = true` | skill checklist | `view-missing-security-invoker` |
| UPDATE requires a SELECT policy; otherwise 0 rows silently | skill checklist | `update-policy-without-select-policy` |
| `auth.role()` is deprecated; use `TO`; anon users pass `authenticated` | skill checklist | `policy-missing-to-role`, `policy-ignores-is-anonymous` (new) |
| `TO authenticated` alone is BOLA/IDOR; add an ownership predicate | skill checklist | `policy-authenticated-not-authorized` |
| UPDATE needs both `USING` and `WITH CHECK` | skill checklist, `database-rls-policies.md` | `write-policy-missing-ownership-check` |
| **"Never add `SECURITY DEFINER` to resolve a permission error"** | skill checklist | `security-definer-function-exposed`; an AI-specific failure mode |
| SECURITY DEFINER in `public` is callable by `anon` (EXECUTE granted to PUBLIC) | skill checklist | `function-execute-revoke-incomplete` |
| Storage upsert needs INSERT + SELECT + UPDATE | skill checklist | `storage-upsert-missing-policies` |
| Deleting a user doesn't invalidate access tokens | skill checklist | (runtime, not lintable) |
| Pin package versions, commit lockfiles | skill checklist | (supply chain) |
| Wrap `auth.uid()` in `select`; specify `TO`; minimise joins | `database-rls-policies.md` | `auth-function-not-wrapped-in-select`, `policy-missing-to-role`, `policy-join-row-to-membership` |
| Don't use `FOR ALL`; one policy per operation and role | `database-rls-policies.md`, `database-create-migration.md` | (style; `multiple-permissive-policies`) |
| `set search_path = ''` on functions | `database-functions.md` | `security-definer-mutable-search-path` |
| `@supabase/ssr` only, `getAll`/`setAll` only, never `get/set/remove`, never `auth-helpers-nextjs`; keep `getUser()` in middleware and return `supabaseResponse` unchanged | `nextjs-supabase-auth.md` | `deprecated-auth-helpers`, `ssr-cookie-adapter-broken`, `middleware-session-refresh-missing` |
| Edge Functions: `npm:`/`jsr:` with pinned versions, no bare specifiers, wrap with `withSupabase`, `EdgeRuntime.waitUntil` for background work, `_shared` for shared code | `edge-functions.md` | `ef-unpinned-remote-imports`, `ef-unawaited-background-work` |
| Realtime: prefer `broadcast` over `postgres_changes`, check channel state, always clean up | `use-realtime.md` | `realtime-unfiltered-postgres-changes-at-scale`, `realtime-channel-not-removed` |

**Implication for supacheck: the skill already tells agents most of our top rules.** Agents
still break them (the eval pass rates above; "never called search_docs"). A static check that
runs in the agent loop fills the gap between instructing and verifying. The skill's own
principle 2, "Verify your work", is exactly the hook for `supacheck` as a verification step.

### 3.3 Incidents and scans of AI-built Supabase apps

| Study | Date | Sample | Finding | Status |
|---|---|---|---|---|
| CVE-2025-48757 (Matt Palmer) | reported 2025-03-21, CVE 2025-05 | 1,645 Lovable apps | 303 endpoints in 170 apps (10.3%) readable or writable with the anon key: missing or insufficient RLS | [secondary; widely corroborated] |
| Escape.tech | ~Oct 2025 | 5,600 vibe-coded apps | 2,000+ vulns, 400+ exposed secrets, 175 PII exposures; missing RLS and exposed tokens are the main classes | [secondary]; [methodology post](https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/) |
| Wiz, Moltbook | 2026-01-31 | 1 app | Supabase key in client JS plus **RLS disabled** gave read and write to 1.5M agent tokens, ~35k emails and 4,060 DMs; fixed with "two SQL statements" | [secondary, many outlets] |
| SupaExplorer | 2026-01 | 20,052 URLs (5 indie directories) | 2,217 domains (11.04%) expose Supabase credentials; "critical exposures" 2,325; no per-builder split. Note: this counts anon keys too | [verified: [report](https://supaexplorer.com/cybersecurity-insight-report-january-2026)] |
| Symbiotic Security | data Jan–Mar 2026 | 1,072 Supabase-backed apps (Lovable, v0, Bolt, Replit, Windsurf, Tempo) | 16% critical. **172 apps allow unauthenticated delete/modify**, 39 anon-readable tables, 34 expose sensitive columns, 14 allow anon insert, 12 allow anon upsert, **44 have callable RPCs**, **69 have email confirmation disabled**. It counts "anon key exposed" (308) as High, which is the known false positive | [secondary: [blog](https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws)] |
| Reeve (via VibeEval) | 2026-08-12..14 | 30,998 apps, 3,680 reachable Supabase backends | **57% (2,096) allow unauthenticated table reads**; 394 expose people-named tables; 1 in 23 ship a secret in the bundle | [unverified: vendor summary; "unauthenticated read" includes intentionally public tables] |
| arXiv 2606.23130, "Understanding the (In)Security of Vibe-Coded Applications" | 2026 | 9,041 OSS apps (Claude Code, Lovable); 200 deployed audited | 1,186 vulns (the abstract) or 1,471 (VibeEval); broken access control is the top class | [secondary; numbers disagree] |
| UpGuard, "Everything Everywhere" | 2026-10-01 | ~300k Supabase domains | **16,326 exposed DBs** (a probe for a `users` table); over 50% with PII indicators | [verified: [blog](https://www.upguard.com/blog/everything-everywhere-systemic-data-exposure-in-supabase-apps)]; TechCrunch coverage 2026-09-25 |
| General Analysis, Supabase MCP | 2025-07 | demo | Prompt injection in a support ticket plus a Cursor agent holding `service_role` leaks `integration_tokens`. Supabase response: read-only mode, project scoping, dev projects | [secondary: [GA](https://generalanalysis.com/blog/supabase-mcp-blog), [Supabase](https://supabase.com/blog/defense-in-depth-mcp)] |
| Reddit 47-repo Lovable scan | 2026 | 47 repos | **0/47 service keys in the frontend**; 6/24 Supabase repos with a table lacking `ENABLE RLS` | [verified post; small sample] |

### 3.4 Anti-patterns AI tools systematically produce, ranked by evidence

| # | Anti-pattern | Why AI produces it | Prompts that try to prevent it | Evidence |
|---|---|---|---|---|
| 1 | `rls-disabled-on-exposed-table` | Tables created by SQL don't get RLS by default; agents create tables in SQL | Bolt, v0, Supabase skill (all say "ALWAYS") | CVE-2025-48757, Moltbook, Symbiotic, Reeve, Reddit `1t1owgf`/`1v747so`/`1t58g8u` |
| 2 | `rls-policy-always-true` / `policy-authenticated-not-authorized` (incl. `multiple-permissive-policies` leftovers) | "Fix the visible error": a permissive policy is added to make 42501 or `[]` go away | Supabase skill (BOLA note); not Bolt (its text is ambiguous) | Reddit `1wg0u4r` #2, `1u5h5zl`, `1wv5k7i`; Symbiotic 172 apps writable |
| 3 | `write-policy-missing-ownership-check` / `self-updatable-privilege-column` | No `WITH CHECK`; the profile table holds role, plan or credit columns | Supabase skill (USING + WITH CHECK); not Bolt | Post-Bridge `1o0esut`; `1u5h5zl` |
| 4 | `ef-service-role-trusts-body-identity` / `verify_jwt=false` without a check | No server in Lovable or Bolt, so EFs act as the backend; webhook docs say turn verification off | Supabase `withSupabase`; Bolt's docs *recommend* disabling for webhooks | Reddit `1ujwgy7`; GitHub PRs fixing 63/77 `verify_jwt=false` functions [secondary] |
| 5 | `security-definer-function-exposed` | Agents add definer helpers for "complicated queries" or to clear permission errors | Supabase skill: "Never add SECURITY DEFINER to resolve a permission error" | Symbiotic 44 callable RPCs; `delete_all_users()` in `1t1owgf` |
| 6 | `server-trusts-getsession`, `deprecated-auth-helpers`, `ssr-cookie-adapter-broken` | Training-data lag (pre-2024 tutorials) | Supabase `nextjs-supabase-auth.md` ("🚨 CRITICAL INSTRUCTIONS FOR AI LANGUAGE MODELS"); the auth-helpers README addresses AI assistants | SO cluster (225k views); Supabase prompt content. Reddit shows 0 AI-tagged SSR posts, so it is a silent failure |
| 7 | `auth-email-confirmation-disabled` (new) | **Bolt's prompt mandates it**; it lowers friction in demos | none | Symbiotic: 69 sites |
| 8 | `storage-upsert-missing-policies`, storage listing leak, `private-data-in-public-bucket` | "Edit avatar" flows use `upsert:true`; buckets made public while testing | Supabase skill (upsert) | SO's largest RLS cluster; Reddit `1t69so5`, `1wg0u4r` #4 |
| 9 | `insert-missing-owner-column` (new) | The policy is written separately from client code; the insert omits `user_id` | none | Reddit `1u5h5zl`; SO "new row violates" (34 hits) |
| 10 | `service-key-in-client` | Shared `supabase.ts` imported by both server and browser code; `VITE_`/`NEXT_PUBLIC_` prefix | All | Strong in *URL* scans (SupaExplorer, Escape); **weak in repos** (0/47 Lovable, 0 live in the field survey) |
| 11 | `view-missing-security-invoker` | Agents create views without it | Supabase skill | Supabase blog (agent eval observations) |
| 12 | Migration drift (dashboard or MCP edits, v0 "paste this SQL") | Bolt and v0 execute queries directly; MCP `apply_migration` misuse | Bolt (migration plus query, identical SQL); the Supabase skill warns about `apply_migration` | Reddit `1u5h5zl`, `1wg0u4r` #6/#10, `1s5i68h` |
| 13 | Destructive agent operations (`db reset`, drops) | Agents with CLI or MCP write access | Bolt forbids DROP/DELETE; Supabase MCP read-only mode | Reddit `1q00gtb`; GA MCP demo |

**What the prompts actively prevent, so the linter will see these less in AI repos:**
- custom auth tables, which Bolt and v0 forbid;
- client-per-render, since Bolt mandates a singleton;
- ORMs and the pooler issue, since v0 forbids ORMs;
- hard-coded keys, since Lovable's secrets flow and Bolt's `.env` rule cover them;
- `auth-helpers` in v0, since the Academy pattern uses `@supabase/ssr`.

### 3.5 Implications for supacheck

1. **Prioritise the "fixed the visible error" family.** These are permissive policies,
   SECURITY DEFINER added to clear 42501, `GRANT ALL … TO anon`, and
   `disable row level security` in a later migration. The **diff** between migrations is the
   signal. A deterministic check, `migration-weakens-security`, would flag a later migration
   that does any of the following to a table or function an earlier migration secured:
   - disables RLS;
   - adds a `using (true)` policy;
   - adds `security definer`;
   - grants to `anon`.

   It is cheap, D + X, and directly targets how agents behave.
2. **Agent-facing output.**
   - Every finding should state the safe fix and, explicitly, the unsafe fix the agent must
     not take: "do not disable RLS; do not add SECURITY DEFINER; do not GRANT ALL to anon".
   - Supabase's skill already uses this framing.
   - Add an `--agent` output mode in the style of `npx viberaven --agent-mode` and
     `ship-safe agent` (competitors seen on Reddit).
3. **Coverage gap: repos with no SQL.** 5/24 Lovable repos had no migrations, and v0 users
   paste SQL into the editor. The linter should report "no schema source: RLS facts unknown"
   rather than staying silent. Optionally it could read a `supabase db dump` if one is
   provided.
4. **Lovable/Bolt projects as a profile.**
   - Detect them via `lovable-tagger`, a `bolt` `.bolt/` directory, or `VITE_SUPABASE_*` with
     no server directory.
   - In this profile, everything is client code except `supabase/functions/**`.
   - That simplifies the server/client fact and raises the priority of RLS and EF rules.
5. **Calibrate `service-key-in-client` severity by evidence source.** In repos it is rare but
   critical; its main value is the import-graph case (a shared module).
6. **Competitors seen in the community:** ship-safe (OSS), VibeRaven, PreFlight,
   supabase-security-skill/MCP (OSS), SupaExplorer, AuditYourApp, Vibe App Scanner, Symbiotic,
   CheckYourVibe and supabase-test. Most check RLS presence and key leaks. None advertise
   cross-file schema replay, which is supacheck's differentiator.

---

## 4. Candidate rules not in the catalogue

Checked against every `.md` in this directory, including `field-survey.md`,
`blogs-tutorials.md` and `prior-art-tools.md`.

| # | Proposed id | What goes wrong | Detection | Evidence |
|---|---|---|---|---|
| 1 | `embedded-filter-without-inner` | `.select('*, author(*)').eq('author.name', x)` filters the *embedded* rows, not the parent, so parents come back with `author: null` unless `author!inner(*)` is used. People think the filter worked | D (an embedded filter path without `!inner` in select), S (did they intend to filter parents?) | SO: 146k views in the joins cluster; "!inner" 33 hits; [q/69137919](https://stackoverflow.com/q/69137919), [q/69665030](https://stackoverflow.com/q/69665030) |
| 2 | `ambiguous-embed-needs-fk-hint` | Two FKs between the same tables, so `PGRST201 "More than one relationship was found"` at runtime | X (schema replay: count FKs between the pair; select without a `!fk_name` hint) | SO 4 hits; [q/69260172](https://stackoverflow.com/q/69260172) (3.4k views) |
| 3 | `rpc-args-mismatch-function-signature` | `.rpc('fn', {userId})` but the function arg is `user_id`, or the function lives in a non-exposed schema: `PGRST202` "Could not find the function … in the schema cache" | X (match `.rpc` name and arg keys against replayed `create function` signatures) | SO "Could not find the function" 31, PGRST202 3; [q/76011758](https://stackoverflow.com/q/76011758) (9.7k), [q/76747152](https://stackoverflow.com/q/76747152) |
| 4 | `schema-not-exposed-in-config` | `.schema('x')` or `createClient(…, {db:{schema:'x'}})` where `x` isn't in `config.toml [api] schemas`, so 406/PGRST106 | X (config) | [q/73281996](https://stackoverflow.com/q/73281996) (11k) |
| 5 | `mutation-result-without-select` | v2 `insert/update/upsert` returns `data: null` unless `.select()` is chained; the code reads `data[0].id` | D | SO "insert returns null" 22, ".select() after insert" 17; [q/74981893](https://stackoverflow.com/q/74981893) (21k) |
| 6 | `supabase-env-not-public-in-client` | A client component reads `process.env.SUPABASE_URL`/`SUPABASE_ANON_KEY` without the `NEXT_PUBLIC_`/`VITE_`/`EXPO_PUBLIC_` prefix, so it is undefined in the browser ("supabaseUrl is required"). This is the inverse of `service-key-in-client` | D + X (client file) | SO 17 hits; [q/68239168](https://stackoverflow.com/q/68239168) (30k) |
| 7 | `insert-missing-owner-column` | The INSERT policy has `with check (auth.uid() = user_id)`, but the client `.insert({...})` omits `user_id` and the column has no `default auth.uid()`, so 42501 follows. Agents then "fix" it permissively | X (policy ↔ insert object keys ↔ column default) | Reddit `1u5h5zl`; SO "new row violates" 34 hits / 122k views |
| 8 | `auth-email-confirmation-disabled` | `config.toml [auth.email] enable_confirmations = false` in a production config: anyone can register any email, and the account farm feeds `TO authenticated` policies | D (config) + context (is this the prod config?) | Bolt prompt mandates it [verified]; Symbiotic 69 sites |
| 9 | `policy-ignores-is-anonymous` | `[auth] enable_anonymous_sign_ins = true` (or `signInAnonymously()` in code) while write or privilege policies are `TO authenticated` with no `is_anonymous` check. Existing ids only mention this in prose (sql-rls #3) | X (config or code ↔ policies) + S (is the action sensitive?) | Reddit `1tm0lm5` (50); Supabase skill; [anon auth docs](https://supabase.com/docs/guides/auth/auth-anonymous) |
| 10 | `nullable-comparison-in-policy` | Policy predicates compare nullable values (`email = (select email …)`, `invited_email`), or use `!=`, `IS NOT DISTINCT FROM`, or `coalesce`, which can let null or anonymous users match | S (+D for `!=`/`<>` against `auth.uid()`) | Reddit `1tm0lm5`; the inverted `auth.uid() != id` in `1ujwgy7` |
| 11 | `fk-column-not-indexed` (generic) | FK columns with no index: slow joins and cascades. Splinter 0001 exists, but the catalogue only has the policy-column variant | X (schema replay) | Reddit `1wg0u4r` #3; Splinter `unindexed_foreign_keys` |
| 12 | `migration-weakens-security` | A later migration disables RLS, adds `using(true)`/`security definer`/`grant … to anon` on objects an earlier migration secured: the "fix the visible error" pattern | D + X (migration diff) | Supabase skill ("never add SECURITY DEFINER to resolve a permission error"); Reddit `1wg0u4r` #1/#2; README §5 |
| 13 | `bigint-precision-loss` (minor) | `int8`/`bigserial` ids beyond 2^53 parsed as JS numbers | X (column type) + D (numeric use) | SO "bigint" 51 hits; ["How to use bigint safely"](https://stackoverflow.com/q/74549311) (2.5k) |

Extensions to existing ids, rather than new ones:
- `storage-policy-not-owner-scoped`: add the **listing** sub-case. An owner-scoped SELECT
  still lets `list('')` enumerate names; recommend `storage.allow_only_operation`
  (Reddit `1t69so5`).
- `auth-function-not-wrapped-in-select`: generalise to any STABLE helper function in a policy
  (Reddit `1o18s4i`, 8,010 calls per query).
- `cron-hardcoded-secret-key`: include Database Webhook triggers
  (`supabase_functions.http_request`, `net.http_post` with an `Authorization` header) in
  migrations and dumps (Reddit `1nw4krx`).
- `auth-users-trigger-fragile`: add the OAuth-metadata case, where the trigger reads
  `raw_user_meta_data->>'full_name'` and that field is only set by the email signup form
  (Reddit `1wg0u4r` #12).
- `captcha-client-only`: add the config side, `[auth.captcha] enabled = false` with
  signup open (Reddit `1sm75sv`).

---

## 5. Effect on the ranked shortlist (README)

- **Move up:**
  - `rls-policy-always-true` / `multiple-permissive-policies`. Leftover permissive policies are
    the most-cited AI failure after RLS-off.
  - `self-updatable-privilege-column`. It has a concrete revenue-impact incident.
  - `storage-upsert-missing-policies`. It is the largest Stack Overflow RLS cluster by views,
    and AI avatar flows use `upsert:true`.
- **Add to the deterministic core**, all cheap D/X and agent-relevant:
  - `migration-weakens-security`
  - `insert-missing-owner-column`
  - `auth-email-confirmation-disabled`
  - `rpc-args-mismatch-function-signature`
  - `mutation-result-without-select`
- **Severity note:** `service-key-in-client` stays critical but should be expected rarely in
  repo scans. Its value is the import-graph case.
- **New Laya question candidates:**
  - "Does this policy let an anonymous (guest) user perform this action?"
    (`policy-ignores-is-anonymous`)
  - "Is the embedded-table filter meant to drop parent rows?"
    (`embedded-filter-without-inner`)

---

## 6. Unverified or weak items

- Reeve's 57% "open Supabase" figure: vendor summary, and it doesn't separate intentionally
  public tables.
- ShipSafe's "89% of Lovable apps missing RLS / 34% service keys": "dozens" of apps; not used.
- The arXiv 2606.23130 counts disagree (1,186 vs 1,471).
- The "Lovable scanner checks only RLS presence": secondary (Superblocks, VibeAppScanner). The
  current Lovable docs claim both a policy-permissiveness check and a deep scan.
- Supabase Evals leaderboard numbers come from a Reddit post, not the Supabase site.
- The Escape.tech date and the 170-app overlap: sources conflate it with CVE-2025-48757.
- The v0 "paste .sql into the SQL editor" flow: from a Codecademy tutorial; current v0 uses the
  integration MCP.
- Reddit counts depend on Arctic Shift coverage. The Aug–Sep 2026 dip may be ingestion lag.
- Stack Overflow theme counts use a title-only heuristic with roughly 20–30% misassignment.
  Exemplar questions were read by title only.

## 7. Sources (primary)

- Stack Exchange API 2.3: `api.stackexchange.com/2.3/questions`, `/search/advanced`,
  `/tags/supabase/info`, `/tags/supabase/synonyms` (queried 2026-10-05).
- Arctic Shift: `arctic-shift.photon-reddit.com/api/posts/search`, `/aggregate`, `/ids`;
  r/Supabase RSS `reddit.com/r/Supabase/top/.rss?t=year`.
- bolt.diy prompts: https://github.com/stackblitz-labs/bolt.diy/tree/main/app/lib/common/prompts
- Leaked prompts (Lovable, v0, Replit and others):
  https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools
- Supabase AI prompts: https://github.com/supabase/supabase/tree/master/examples/prompts ·
  https://supabase.com/docs/guides/getting-started/ai-prompts
- Supabase agent skills: https://github.com/supabase/agent-skills ·
  https://supabase.com/blog/supabase-agent-skills
- Lovable: https://docs.lovable.dev/integrations/supabase ·
  https://docs.lovable.dev/features/security · https://lovable.dev/blog/secure-vibe-coding
- Bolt: https://support.bolt.new/integrations/supabase ·
  https://support.bolt.new/troubleshooting/integrations-issues
- v0: https://v0.app/docs/databases ·
  https://vercel.com/academy/subscription-store/supabase-client-utilities
- Studies:
  - https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/
  - https://supaexplorer.com/cybersecurity-insight-report-january-2026
  - https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws
  - https://www.upguard.com/blog/everything-everywhere-systemic-data-exposure-in-supabase-apps
  - https://vibe-eval.com/updates/vibe-coding-security-monthly-aug-2026/
  - https://arxiv.org/abs/2606.23130
  - https://generalanalysis.com/blog/supabase-mcp-blog
  - https://supabase.com/blog/defense-in-depth-mcp
  - https://thehackernews.com/2025/07/wiz-uncovers-critical-access-bypass.html
  - https://www.theregister.com/software/2026/02/27/ai-built-app-on-lovable-exposed-18k-users-researcher-claims/5038511
- Moltbook (Wiz) coverage: https://www.implicator.ai/moltbook-left-every-ai-agents-api-keys-in-an-open-database-security-researcher-finds/ ·
  https://bastion.tech/blog/moltbook-security-lessons-ai-agents
