# SQL anti-patterns: RLS, policies, grants, functions, views, schema

Research catalogue, 2026-10-05. Ranked by severity × frequency. Splinter lints were
confirmed against `supabase/splinter/lints` (0001–0030). GitHub search rate-limited
partway through, so some frequency signals come from web search. Reddit and Stack Overflow
searches returned no usable threads. Items marked **[unverified]** have weaker evidence.

**Detection legend:**
- **D**: deterministic, a pg_query AST is enough.
- **S**: semantic, needs judgement (Laya).
- **X**: cross-migration, needs schema state replayed across all migrations.

---

## Tier 1: critical security, high frequency

### 1. `rls-disabled-on-exposed-table`
A table in an exposed schema never gets `ENABLE ROW LEVEL SECURITY`. Anyone with the anon
key can read and write it through PostgREST. **Security, critical.**
- **Evidence**:
  - CVE-2025-48757 (Lovable, CVSS 9.3): 170 of 1,645 scanned apps were exposed.
    <https://www.superblocks.com/blog/lovable-vulnerabilities>,
    <https://www.brinztech.com/breach-alerts/brinztech-alert-critical-row-level-security-rls-vulnerability-cve-2025-48757-exposed-lovable-supabase-applications/>
  - Moltbook, Jan 2026 (found by Wiz): 1.5M API tokens and ~4.75M records exposed.
    <https://www.infosecurity-magazine.com/news/moltbook-exposes-user-data-api/>,
    <https://www.techzine.eu/news/security/138458/moltbook-database-exposes-35000-emails-and-1-5-million-api-keys/>
  - <https://www.penetrify.cloud/en/blog/supabase-rls-misconfiguration-exposed-every-users-profile/>
- **Guidance**: <https://supabase.com/docs/guides/database/postgres/row-level-security>
  says "A table in an exposed schema without RLS is readable and writable by any role
  with a grant on it." **Splinter** `0013_rls_disabled_in_public` (ERROR).
- **BAD** `create table public.orders (id bigint primary key, user_id uuid, total numeric);`
- **GOOD** adds `alter table public.orders enable row level security;`
- **Detection: X.**
  - Flag a `CREATE TABLE` in an exposed schema (`public` plus `config.toml` `[api].schemas`)
    with no later ENABLE.
  - Also catch a later DISABLE.
  - Lower severity if the table has no anon or authenticated grants.

### 2. `rls-policy-always-true`
`USING (true)` or `WITH CHECK (true)` (also `1=1`) on writes for anon or authenticated.
RLS is on but does nothing, often added "to make the error go away". **Security, critical.**
- **Evidence**: Lovable CVE root cause. <https://vibeappscanner.com/lovable-vulnerability-cve-2025-48757>,
  <https://www.bleek.dev/cve-2025-48757>,
  <https://dev.to/mason_roy/6-supabase-rls-policies-that-pass-code-review-and-still-leak-data-1hi5>
- **Guidance**: **Splinter** `0024_rls_policy_always_true` covers UPDATE, DELETE and ALL,
  plus INSERT WITH CHECK. `SELECT USING (true)` is legitimate for public data, so the
  lint skips SELECT.
- **BAD** `create policy "allow all" on public.orders for all using (true) with check (true);`
- **GOOD** `... for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);`
- **Detection**:
  - **D** for literal true on writes.
  - **S** for whether `SELECT USING (true)` is intended public data or a leak. Table and
    column names help (e.g. `profiles` with `email`).

### 3. `policy-authenticated-not-authorized`
The policy checks only that someone is signed in (`auth.role() = 'authenticated'`,
`auth.uid() is not null`, or `to authenticated using (true)`). With open sign-up that is
effectively public, and anonymous users also hold the `authenticated` role.
**Security, high.**
- **Evidence**:
  - <https://dev.to/victor_yrazusta/10-common-supabase-security-misconfigurations-and-how-to-fix-them-do8>
  - <https://opsily.com/blog/users-can-see-other-users-data-supabase>
  - <https://thefrontkit.com/blogs/supabase-row-level-security>
  - <https://github.com/orgs/supabase/discussions/22855>
- **Guidance**: <https://supabase.com/docs/guides/auth/auth-anonymous> says "Anonymous
  users use the authenticated role … your policies need to check the is_anonymous field."
  No Splinter lint covers this.
- **BAD** `create policy "read profiles" on public.profiles for select using (auth.role() = 'authenticated');`
- **GOOD** `... for select to authenticated using ((select auth.uid()) = id);`
- **Detection**:
  - **S**, a prime classifier case: does the predicate scope to ownership or tenancy, or
    only to "is logged in"?
  - **D** for the literal forms.

### 4. `rls-references-user-metadata`
Authorization based on `auth.jwt() -> 'user_metadata'` or `raw_user_meta_data`, in a
policy, a definer helper or a signup trigger. Users can rewrite these fields with
`updateUser()` and at sign-up, so this is privilege escalation. **Security, critical.**
- **Evidence**:
  - <https://github.com/orgs/supabase/discussions/13091>
  - <https://makerkit.dev/blog/tutorials/supabase-rls-best-practices>
  - <https://github.com/orgs/supabase/discussions/7317>
- **Guidance**: the RLS docs say raw_user_meta_data "can be updated by the authenticated
  user … not a good place to store authorization data." Use `app_metadata` or a roles
  table. **Splinter** `0015_rls_references_user_metadata` covers policies only.
- **BAD** `using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin')`
- **GOOD** `to authenticated using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')`
- **Detection**:
  - **D** for policies.
  - **S** for function and trigger bodies: reading metadata for display is fine, deriving
    a permission is not. Splinter misses triggers.

### 5. `security-definer-function-exposed`
A `SECURITY DEFINER` function in an exposed schema is callable at `/rest/v1/rpc/<fn>`,
bypasses RLS, and often trusts caller-supplied IDs. EXECUTE is granted to PUBLIC by
default, and Supabase's default privileges also grant it to anon and authenticated.
**Security, critical.**
- **Evidence**:
  - CVE-2026-56082 (Capgo, `public.record_build_time`).
  - <https://github.com/louisianahelpr/louisianahelpr/issues/1358> (145 definer functions
    callable).
  - <https://tech.rebounder.jp/en/posts/supabase-security-definer-function-default-public-execute-exposes-rpc/>
  - <https://github.com/supabase/supabase/issues/43884>
- **Guidance**:
  - The RLS docs say "Never create one in a schema listed under 'Exposed schemas.'"
  - Securing your API says "RLS doesn't apply to functions, so grant EXECUTE only to the
    roles that need to call them."
  - **Splinter** `0028`/`0029` (anon or authenticated security definer function executable).
- **BAD**
  ```sql
  create function public.get_user_orders(p_user uuid) returns setof orders
  language sql security definer as $$ select * from public.orders where user_id = p_user $$;
  ```
- **GOOD**
  ```sql
  create function private.get_my_orders() returns setof public.orders
  language sql security definer set search_path = '' as $$
    select * from public.orders where user_id = (select auth.uid()) $$;
  revoke execute on function private.get_my_orders() from public, anon, authenticated;
  ```
- **Detection**:
  - **X**: definer, in an exposed schema, with no later revoke from all three roles.
  - **S**: does the body check `auth.uid()` or a role, or trust a parameter?

### 6. `function-execute-revoke-incomplete`
`revoke execute … from public` only, or `alter default privileges in schema public revoke
execute … from public`. Neither has any effect on Supabase, so anon can still call the
function. **Security, high.**
- **Evidence**:
  - <https://github.com/supabase/supabase/issues/49338> (the docs statement had no
    effect; fixed in PR #49366)
  - <https://github.com/supabase/supabase/issues/43884>
  - <https://github.com/korkje/stubs.tv/pull/55>
- **Guidance**: a maintainer says to use `revoke execute on function foo from public,
  anon, authenticated;`. Splinter catches only the definer outcome.
- **Detection: D.** The revoke's role list lacks anon or authenticated, or it uses a
  schema-scoped default-privilege revoke from public.

### 7. `view-missing-security-invoker`
A view in an exposed schema runs as `postgres`, bypasses RLS and returns all rows.
**Security, high.**
- **Evidence**:
  - <https://github.com/orgs/supabase/discussions/901>
  - <https://dev.to/datadeer/postgres-views-the-hidden-security-gotcha-in-supabase-ckd>
  - <https://github.com/supabase/supabase/issues/35823>, <https://github.com/supabase/supabase/issues/44934>
  - A Jan 2026 pgsql-hackers proposal for `SECURITY_INVOKER_VIEWS`.
- **Guidance**: the RLS docs say "Views bypass RLS by default" and recommend
  `security_invoker = true` (Postgres 15+). **Splinter** `0010_security_definer_view`.
- **BAD** `create view public.order_summary as select …`
- **GOOD** `create view public.order_summary with (security_invoker = true) as select …`
- **Detection: D**, plus **X** for a later `ALTER VIEW … SET (security_invoker = on)` or
  a revoke.

### 8. `auth-users-exposed`
A view or materialized view in an exposed schema selects from `auth.users`, exposing
emails, phones and metadata. **Security, critical.**
- **Evidence**: Splinter rates it ERROR. Common in "public.users view" tutorials
  **[frequency partly unverified]**.
- **Guidance**: **Splinter** `0002_auth_users_exposed`. Use a `public.profiles` table
  populated by a trigger instead.
- **Detection: D.** The view's FROM clause references `auth.users` in an exposed schema.

### 9. `write-policy-missing-ownership-check`
An INSERT policy whose WITH CHECK doesn't tie the owner column to `auth.uid()`, or an
UPDATE with an explicit, looser `WITH CHECK (true)`. Users can insert rows as someone
else, or reassign ownership. If WITH CHECK is omitted on UPDATE, Postgres reuses USING,
so omission alone is not the bug. **Security, high.**
- **Evidence**:
  - <https://designrevision.com/blog/supabase-row-level-security>
  - <https://markaicode.com/errors/supabase-rls-policy-fix/>
  - <https://hrekov.com/blog/rls-policies-supabase>
- **Guidance**: the RLS docs use `with check ((select auth.uid()) = user_id)` so "a user
  cannot create a row that belongs to someone else." No Splinter lint beyond 0024.
- **BAD**
  ```sql
  create policy "insert" on public.posts for insert to authenticated with check (auth.uid() is not null);
  create policy "update" on public.posts for update using (auth.uid() = user_id) with check (true);
  ```
- **GOOD** `with check ((select auth.uid()) = user_id)` on both.
- **Detection**:
  - **D** when an owner-like column (`user_id`, `owner_id`, `created_by`, `profile_id`)
    is missing from WITH CHECK.
  - **S** to decide which column is the owner.

### 10. `self-updatable-privilege-column`
`profiles` holds `role`, `is_admin`, `plan` or `credits`, and its owner-scoped UPDATE
policy covers the whole row, so the user can `update profiles set role='admin'`.
**Security, high.**
- **Evidence**: <https://makerkit.dev/blog/tutorials/supabase-rls-best-practices>, and
  vendor blogs **[secondary sources]**.
- **Guidance**: use a separate roles table, or column-level grants
  (<https://supabase.com/docs/guides/database/postgres/column-level-security>). No
  Splinter lint covers this.
- **GOOD**
  ```sql
  revoke update on public.profiles from authenticated;
  grant update (name) on public.profiles to authenticated;
  ```
- **Detection**:
  - **X**: a privilege-like column, an owner-scoped UPDATE, and no column grant or
    trigger guard.
  - **S**: is the column actually privilege-bearing?

---

## Tier 2: correctness and signup-breaking

### 11. `rls-enabled-no-policy`
RLS is enabled with no policies, so every API query returns `[]` silently. Often "fixed"
by switching to the service key or adding `using (true)`. **Correctness.**
- **Evidence**:
  - <https://supabase.com/docs/guides/troubleshooting/why-is-my-select-returning-an-empty-data-array-and-i-have-data-in-the-table-xvOPgx>
  - <https://github.com/orgs/supabase/discussions/33500>
  - <https://dev.to/mahdi_benrhouma_fe1c6005/supabase-returns-an-empty-array-even-though-the-rows-exist-heres-the-rls-fix-37c6>
- **Guidance**: **Splinter** `0008_rls_enabled_no_policy` (INFO).
- **Detection: X** (policy count net of DROP POLICY is 0). **S** for whether the table
  is intended to be service-role-only.

### 12. `policy-exists-rls-disabled`
Policies are written but RLS is never enabled, so the policies do nothing.
**Security, high.**
- **Evidence**: Splinter ERROR `0007_policy_exists_rls_disabled`. Common in AI-generated
  migrations **[frequency unverified]**.
- **Detection: X.**

### 13. `update-policy-without-select-policy`
An UPDATE or DELETE policy with no SELECT policy covering the same rows, so updates
affect 0 rows silently. Variant: the SELECT predicate excludes the post-update state
(soft delete). **Correctness.**
- **Evidence**: <https://github.com/orgs/supabase/discussions/18684>,
  <https://github.com/PostgREST/postgrest/discussions/1844>
- **Guidance**: the RLS docs say "To perform an UPDATE operation, a corresponding SELECT
  policy is required." No Splinter lint covers this.
- **Detection: X** (commands covered per role). **S** for the soft-delete variant.

### 14. `recursive-rls-policy`
A policy on table A queries A, or B whose policy queries A (`team_members`,
`list_members`). Fails with `42P17 infinite recursion`, and apps hang after login.
**Correctness, outage.**
- **Evidence**:
  - The official troubleshooting doc "RLS policy causes infinite recursion".
  - <https://github.com/orgs/supabase/discussions/47525>, <https://github.com/orgs/supabase/discussions/3802>
  - <https://github.com/supabase/supabase/issues/31387> (Bolt.new)
  - <https://tomaspozo.com/articles/series-lovable-supabase-errors-application-hangs-up-after-log-in>
- **Guidance**: the RLS docs ("Avoid recursive policies") say to break the cycle with a
  security definer function. No Splinter lint; runtime-only today, so static detection
  is unique value.
- **BAD**
  ```sql
  create policy "members see team members" on public.team_members for select
    using (team_id in (select team_id from public.team_members where user_id = auth.uid()));
  ```
- **GOOD**: a `private.my_team_ids()` definer function, then
  `using (team_id in (select private.my_team_ids()))`.
- **Detection: X** (policy reference graph through invoker functions, stopping at
  definer functions; flag cycles). A self-loop within one file is **D**.

### 15. `auth-users-trigger-fragile`
The `handle_new_user` trigger function is invoker, has no `search_path`, uses unqualified
names, misses NOT NULL columns, or casts metadata unsafely. Signups fail with "Database
error saving new user". **Correctness, signups down.**
- **Evidence**:
  - <https://github.com/supabase/supabase/issues/563> (32 comments)
  - <https://github.com/supabase/supabase/issues/37497>, <https://github.com/supabase/supabase/issues/36086>
  - Discussions #7916, #5289, #32852
  - <https://supabase.com/docs/guides/troubleshooting/database-error-saving-new-user-RU_EwB>
- **Guidance**: <https://supabase.com/docs/guides/auth/managing-user-data> uses
  `security definer set search_path = ''` with `public.profiles`.
- **Detection: D** (parse the plpgsql body) **+ X** (NOT NULL columns).

### 16. `security-definer-mutable-search-path`
A function without `SET search_path`. The most common Security Advisor warning.
**Security, medium.**
- **Evidence**:
  - <https://github.com/orgs/supabase/discussions/23170>
  - <https://github.com/supabase/supabase/issues/33131> (the fix prevents inlining, a
    real trade-off)
  - <https://github.com/supabase/supabase/issues/37566>
- **Guidance**: **Splinter** `0011_function_search_path_mutable`.
- **Detection: D.** High severity for definer functions, info for invoker functions.

### 17. `fk-to-auth-users-blocks-deletion`
`references auth.users(id)` without ON DELETE, so user deletion fails with "Database
error deleting user" (23503). **Correctness, and GDPR deletion blocked.**
- **Evidence**:
  - <https://github.com/supabase/supabase/issues/3283>
  - Discussions #3284, #3296
  - <https://github.com/supabase/storage/issues/65>
- **Guidance**: the docs use `references auth.users on delete cascade`. Related:
  **Splinter** `0021_fkey_to_auth_unique`.
- **Detection: D**, plus **S** for CASCADE vs SET NULL.

### 18. `missing-api-grants-new-table`
New public tables no longer get default grants: from 2026-05-30 for new projects, and
from **2026-10-30** for existing projects and CLI migrations. Policies without grants
return `42501`. The inverse failure is "fixing" it with `GRANT ALL … TO anon` on a table
without RLS.
- **Evidence**:
  - <https://github.com/orgs/supabase/discussions/45329>
  - <https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically>
  - <https://dev.to/x3blank/supabase-stops-auto-granting-new-tables-on-oct-30-dont-fix-the-42501-with-grant-all-3lom>
  - <https://dev.to/amangupta678/supabase-stops-auto-granting-on-oct-30-here-is-what-breaks-and-five-traps-the-changelog-does-not-5h77>
- **Guidance**: Securing your API says "A table isn't reachable through the Data API
  unless you have granted a role privileges on it."
- **Detection: X.**
  - Policies `TO anon` or `TO authenticated` without a matching grant (version-aware).
  - Inverse: write grants to anon or authenticated without RLS, or a blanket
    `grant all on all tables`.

### 19. `custom-objects-in-auth-schema`
Creating tables, functions or indexes in `auth`, `storage` or `realtime`, or altering
their tables. Fails with permission errors since 2025-04-21 and breaks `db reset` and
branching.
- **Evidence**: discussions <https://github.com/orgs/supabase/discussions/34270>, #38887,
  #34518
- **Detection: D.** Triggers, FKs and policies on `auth.users` are still allowed.

---

## Tier 3: performance

### 20. `auth-function-not-wrapped-in-select`
A bare `auth.uid()`, `auth.jwt()` or `current_setting()` in a policy is re-evaluated per
row (official benchmark: 179 ms → 9 ms).
- **Guidance**:
  <https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv>.
  **Splinter** `0003_auth_rls_initplan`. It is also the first "incorrect" example in
  agent-skills `security-rls-performance.md`.
- **Detection: D.** A FuncCall that is not inside a SubLink.

### 21. `policy-column-not-indexed`
Policy filter columns (`user_id`, `team_id`, `org_id`) have no index (171 ms → <0.1 ms).
**Splinter** `0001` covers FKs only. **Detection: X.**

### 22. `policy-join-row-to-membership`
A membership subquery correlated to the outer row instead of a fixed set
(9,000 ms → 20 ms, from the official performance doc) **[frequency unverified]**.
**Detection: D/S.**

### 23. `policy-missing-to-role`
No `TO` clause, so the policy applies to PUBLIC and is evaluated for anon too. It leaks if
the predicate doesn't depend on `auth.uid()`. The RLS docs say "Always name the role a
policy applies to." **Detection: D.**

### 24. `multiple-permissive-policies`
Policies are OR-ed, which is slow, and authors often wrongly expect AND. A lone
RESTRICTIVE policy with no permissive one returns nothing. **Splinter** `0006`.
**Detection: X**, plus **S** for the restrictive-only case.

---

## Lower priority
- `materialized-view-in-api` (Splinter 0016). **D.**
- `sensitive-columns-exposed` (Splinter 0023). **D** by name list, **S** for fuzzy names.
- `extension-in-public` (0014), `no-primary-key` (0004). **D.**

## Static value beyond Splinter
These are not covered by any Splinter lint, and several are invisible even with a live
DB: #3, #6, #9, #10, #13, #14, #15, #17, #18, #19, #22, #23.

**Need the classifier (S)**:
- #2: is a SELECT `using (true)` intended?
- #3: is the predicate only "is logged in"?
- #4: metadata used for permissions in function bodies.
- #5: missing auth check in a definer body.
- #9: which column is the owner?
- #10: is the column privilege-bearing?
- #13: soft-delete variant.

## Cross-migration state the linter must replay
- **Per table**:
  - schema, and whether it is exposed (`supabase/config.toml` `[api] schemas`)
  - RLS enabled or forced
  - policies net of DROP (command, roles, permissive, qual and check ASTs)
  - grants including default privileges and REVOKEs
  - indexes (leading columns), FKs with their ON DELETE action, NOT NULL and defaults
- **Per function**: schema, SECURITY DEFINER, the `search_path` setting, and the EXECUTE
  ACL including the PUBLIC default.
- **Per view**: `security_invoker` and source relations.

Treat `supabase/schemas/*.sql` (declarative schemas) as the same state.
