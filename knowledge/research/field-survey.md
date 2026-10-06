# Field survey: Supabase usage and anti-pattern prevalence in open-source repos

Survey date 2026-10-05. Shallow clones (`--depth 1`) of 71 GitHub repos. 63 were analysed and 8
were excluded (reasons below). Every hit counted as **confirmed** was read in context by a human
pass. Raw grep counts appear only where the rule is purely deterministic.
No secret values were copied. Where key material was found, only its *kind* is recorded.

Companion to [README.md](README.md). Rule ids refer to the ranked shortlist there.

## 1. Method and sample

**Discovery.**
- `gh search repos` sorted by stars: "supabase", "supabase saas", "supabase nextjs starter".
- Sorted by recently updated: "supabase" across all repos and across 0–2-star TS repos, "lovable supabase", "bolt.new supabase".
- Hand-picked starters: the official examples via sparse checkout (`vercel/next.js` → `examples/with-supabase`; `supabase/supabase` → user-management, todo-list, slack-clone and auth Next.js examples plus `examples/edge-functions`).

**Scanning.**
- A scanner script (Elixir `.exs`, scratchpad only) collected the following from each clone:
  - framework and SDK versions from all `package.json` files
  - feature use: auth calls, `storage.from`, `.channel(`, `supabase/functions/*/index.ts`, `.rpc(`, `cron.schedule`, pgvector
  - AI-builder markers
  - a rough SQL replay over every `.sql` file: tables, `enable row level security`, `create policy` (command, roles, `true` quals), `security definer` with or without `search_path`, drops
  - Edge Function heuristics
- Every security hit was then opened and judged by hand.
- JWT literals were decoded only to read `iss`/`role`, which separates local `supabase-demo` keys from real project keys.

**Groups** (prevalence is reported per group):

| Group | n | What | How assigned |
|---|---|---|---|
| **S**: starters/templates/official examples | 17 | vercel/next.js with-supabase, supabase/supabase examples, nextjs-subscription-payments, makerkit lite, basejump, nextbase, KolbySisk, ShenSeanChen, devtodollars, CMSaasStarter, dzlau, Razikus, nuxt-supabase-starter, vibe-stack, Chensokheng, mrclrchtr, Hikari | self-described starter/boilerplate/example |
| **A**: real apps | 19 | midday, git-city, DeskcommCRM, carbon, wacrm, zola, open-scouts, atomic-crm, realtime-chat, expense.fyi, feedbase, open-bsp-api, chatgpt-your-files, cloudcertprep, TarkovTracker, tdavidson/portfolio, lms-front, creatorai, in-bed-ai | product repos, mostly 25–15k stars, not builder-generated |
| **G**: AI-builder generated | 17 | 16 Lovable + 1 Figma Make/Replit | structural markers (below), not README claims |
| **I**: indie/small, not builder-generated | 10 | random recent 0–2-star repos | the remainder |

**AI-builder markers** used for G. The structural markers are more reliable than README text:
- `lovable-tagger` devDependency
- `.lovable/` directory
- `src/integrations/supabase/client.ts`, the Lovable scaffold, also present in its newer TanStack Start template alongside `auth-attacher.ts` and `client.server.ts`
- migrations named `<timestamp>_<uuid>.sql`
- `supabase/functions/make-server-<hash>/` (Figma Make) and `replit.md`

Five of the 17 G repos carried no "lovable" text in their README at all.
Separately, 26/63 repos (41%) contain agent instruction files (`CLAUDE.md`, `AGENTS.md`,
`.cursor/`). That signals AI-*assisted* development, not generation, and is reported as a
feature, not a group.

**Excluded (8):**
- classroomio: migrated off Supabase to better-auth.
- RedView-App, Echo, bolt-newsletter: no Supabase client code.
- luma-beauty-atelier, b2b-saaskit: Drizzle/Postgres only, no Supabase client usage.
- cpl-website: partial upload with no code.
- trustwall1337/veyra: a Lovable/Supabase **security scanner** whose fixtures are deliberately vulnerable. It is a competitor and a fixture source, not a prevalence data point.

**Limitations.**
- n=63 with hand-picked starters, so the percentages are indicative, not population estimates.
- SQL replay is regex-level. It handles drops by name but not every dynamic `DO $$ … format()` loop. Where a repo applies a blanket fix (carbon, lms-front for `search_path`), net state is marked uncertain.
- Dashboard-applied settings are invisible to the scan (RLS toggled in the UI, buckets created in the UI).
- Tables defined only in Drizzle TS (`pgTable`) are not in the SQL fact store (midday, dzlau).

## 2. Usage map

### Frameworks (from package.json)

| Framework | All (63) | S | A | G | I |
|---|---|---|---|---|---|
| Next.js 16 (App Router) | 16 | 4 | 9 | 0 | 3 |
| Next.js 15 | 7 | 4 | 1 | 0 | 2 |
| Next.js 14 | 7 | 3 | 3 | 0 | 1 |
| Next.js `latest`/catalog (official examples, monorepo) | 4 | 3 | 1 | 0 | 0 |
| Vite + React SPA | 14 | 0 | 1 | **10** | 3 |
| TanStack Start (new Lovable template) | 5 | 0 | 0 | **5** | 0 |
| Remix / React Router | 2 | 0 | 1 | 1 | 0 |
| Nuxt | 2 | 1 | 1 | 0 | 0 |
| SvelteKit | 1 | 1 | 0 | 0 | 0 |
| Astro | 1 | 0 | 1 | 0 | 0 |
| none / SQL-only | 4 | 1 | 1 | 1 | 1 |

Next.js accounts for 34/63 repos (54%) and dominates S and A. **AI-builder output is 0% Next.js:**
it is Vite SPA (10/17) or TanStack Start (5/17). Expo/React Native appears only as a subfolder
(Razikus `supabase-expo-template`). The sample has no standalone RN app.

### SDK versions

- **supabase-js**: 2.39 → 2.117. Clusters at 2.43–2.57 (2024–25 templates), 2.97–2.117 (2026 apps), and `latest`/`^2`/catalog (5 repos).
- **@supabase/ssr**:
  - used by 32/63 (51%): S 15/17, A 11/19, I 6/10, **G 0/17**
  - versions: 0.12.x (11 repos), 0.5.x (7), 0.8–0.10 (5), ancient 0.0.10/0.1 (3: Chensokheng, feedbase, subscription-payments)
- **auth-helpers** (deprecated): 2/63. Both are real apps: expense.fyi (`auth-helpers-nextjs`) and supabase-community/chatgpt-your-files, an official community repo.
- **Key generation**:
  - `ANON_KEY` names in 42/63 (67%), publishable keys in 31/63 (49%). Many have both.
  - G is publishable-first (13/17), because Lovable now scaffolds `VITE_SUPABASE_PUBLISHABLE_KEY`.
- **Auth verification calls**: `getUser()` in 43/63, `getClaims()` in 16/63 (25%; already in 5/17 starters including the vercel example).

### Features (percent of group)

| Feature | S (17) | A (19) | G (17) | I (10) | All (63) |
|---|---|---|---|---|---|
| Auth | 88% | 100% | 71% | 90% | 87% |
| RLS in SQL | 82% | 79% | 71% | 80% | 78% |
| `supabase/migrations` present | 76% | 74% | 76% | 40% | 70% |
| any `.sql` schema | 88% | 89% | 82% | 80% | 86% |
| Storage | 24% | 79% | 29% | 40% | 44% |
| RPC | 6% | 68% | 41% | 50% | 41% |
| Realtime | 12% | 63% | 29% | 20% | 33% |
| Edge Functions | 24% | 42% | 29% | 10% | 29% |
| `functions.invoke` from client | 6% | 21% | 35% | 0% | 17% |
| Cron (pg_cron) | 0% | 32% | 12% | 30% | 17% |
| pgvector | 0% | 37% | 6% | 10% | 14% |
| Next middleware / proxy.ts | 76% | 68% | 0% | 60% | 51% |

**Shape of the data:**
- Starters exercise only auth, RLS and maybe one table.
- Real apps use the whole platform: storage, RPC, realtime and cron.
- Migration volume in real apps is large: carbon has 1,109 migrations, DeskcommCRM 441, tdavidson 270, lms-front 257, git-city 161. The schema replay must be fast and must handle drops and re-creates.
- Two repos use declarative `supabase/schemas/` (atomic-crm, open-bsp-api).

## 3. Prevalence of anti-patterns

"Net" means the state after replaying later drops in the repo. "Ever" means introduced at some
point in history, including policies later fixed. Denominators are the repos where the rule can
apply.

| Rule id | What was checked | S | A | G | I | All | Notes |
|---|---|---|---|---|---|---|---|
| `service-key-in-client` | secret/service env with public prefix, live in client | 0/17 | 0/19 (1 latent) | 0/17 (1 latent) | 0/10 | **0 live, 2 latent** | latent cases: VITE_/NEXT_PUBLIC_ fallback in code, unused or server-only |
| (same, literals) | committed service_role / sb_secret literals | 0 real | 0 real | 0 | 0 real | **0 real** | 20 literal hits in 7 repos, all `iss=supabase-demo` local keys or test fixtures |
| `rls-disabled-on-exposed-table` | public table created, never `enable row level security` | 1/15 | 0/17 | 1/14 | 1/8 | **3/54** | dzlau (Drizzle), TifeQ (G), watchtower |
| `rls-policy-always-true` (writes, net, unintended) | INSERT/UPDATE/DELETE/ALL with `true` | **0/15** | 3/17 | **4/14** | 1/8 | **8/54** | G is 29%; plus 6 repos with intentional public-insert forms |
| (same, ever) | "Service role can …" `using (true)` **without `TO service_role`** | 0 | 5 | 1 | 0 | **6** | all later fixed; a distinct, very greppable sub-pattern |
| `policy-authenticated-not-authorized` (writes) | `TO authenticated using (true)` / `auth.role()='authenticated'` on multi-user tables | 0 | 2 (+1 single-tenant by design) | 1 | 1 | 4–5 | feedbase, creatorai, alchemy, app-vidros; atomic-crm is single-tenant by design (needs S) |
| `server-trusts-getsession` | server `getSession()` result used for an access decision | 2/17 | 5/19 | 0/17 | 0/10 | **7/63** | 7 of the 15 repos with server-side getSession; ~55% of server call sites were legitimate |
| `user-metadata-for-authorization` | `user_metadata` / `raw_user_meta_data` deciding role or ownership | 0 | 1 | 1 | 1 | **3/63** | includes a signup trigger copying `role` from metadata (privilege escalation) |
| `ef-service-role-trusts-body-identity` | service-role EF acting on body-supplied id with no caller check | 0/4 | 1/8 | 1/5 | 0/1 | **2/18** | both have `verify_jwt = false` |
| `security-definer` without `search_path` (ever) | definer function without `set search_path` | 11/13 | 7/12 | 3/6 | 1/6 | **22/37** | mostly the `handle_new_user` copied from Supabase's own example; net uncertain where blanket fixes exist |
| `auth-function-not-wrapped-in-select` | policy uses bare `auth.uid()` | 12/12 | 12/12 | 6/6 | 6/6 | **36/36** | 1,045 of 1,304 auth.uid() policies (80%) |
| `ignored-query-error` | `const { data } = await … .from/.rpc(` without `error` | 9/17 | 16/19 | 7/17 | 6/10 | **38/63** | 1,434 sites (non-test); official examples included |
| `single-where-maybe-single` | `.single()` usage (needs S) | 10/17 use | 17/19 | 11/17 | 6/10 | 44/63 | `.single()`:`.maybeSingle()` is 47:14 in starters, ~1:1 in real apps |
| `deprecated-auth-helpers` | auth-helpers dependency | 0/17 | 2/19 | 0/17 | 0/10 | **2/63** | |
| `realtime-channel-not-removed` | `.channel().subscribe()` with no removeChannel/unsubscribe | 0 | 0 | 0 | 0 | **0/22** | every realtime user cleans up (Tarkov through a custom release helper) |
| `client-per-render` | direct supabase-js `createClient` in component bodies | 0 | 0 | 0 | 0 | **0/63** | 6 candidates were wrappers over `createBrowserClient` (a singleton); 3 were RSC/route code |
| `ef-missing-cors-preflight` | browser-invoked EF with no OPTIONS handling | 0 | 0 | 0 | 0 | **0/18** | 80 heuristic hits; all browser-facing ones handle preflight in `_shared/cors.ts`, Hono `cors()`, or middleware; the rest are webhooks |
| `verify_jwt = false` (fact) | config.toml | 3 | 5 | 2 | 1 | 11/63 | mostly legitimate webhooks; matters only combined with the body-identity rule |

**Committed keys (FP-trap evidence).**
- 6/17 G repos commit `.env` containing `VITE_SUPABASE_PUBLISHABLE_KEY` and the project ref. Lovable does this by default.
- Project-ref anon/publishable JWTs appear in source in 15 repos.
- These are public by design. A linter that flags them would fire on a third of AI-built repos for no gain.

## 4. Notable examples (permalinks at the scanned commit)

### Confirmed true positives

1. **Signup privilege escalation via metadata** (`user-metadata-for-authorization`, I).
   - Where: tax-marketplace `handle_new_user` does `v_role := coalesce(nullif(new.raw_user_meta_data->>'role','')::user_role,'client')`, and `user_role` includes `'admin'`.
   - Impact: anyone calling `signUp({ options: { data: { role: 'admin' } } })` becomes an admin.
   - [0010_admin_profiles.sql#L40](https://github.com/mushfiqur2029-coder/tax-marketplace/blob/02dc40d03e81f1389f54e42f673548ea71809c38/supabase/migrations/0010_admin_profiles.sql#L40)
   - Contrast (correct): PiBarber hardcodes `'client' -- NUNCA vem do formulário` ("never comes from the form") ([02_functions.sql#L45](https://github.com/PiBarber/pibarber/blob/ed04d77d6631b7a82669305f5e6574ac2c9afc43/supabase/02_functions.sql#L45)).
2. **`is_admin()` from user_metadata, plus `OR true`** (G, Lovable).
   - [005_rls_security.sql#L218](https://github.com/j0n777/endtimes-live/blob/c5ce2c10d1c048ee5ee811ba8bbe4447e14289c1/supabase/migrations/005_rls_security.sql#L218)
   - Policies `… (auth.jwt()->'user_metadata'->>'role') = 'admin' OR true` ([#L95](https://github.com/j0n777/endtimes-live/blob/c5ce2c10d1c048ee5ee811ba8bbe4447e14289c1/supabase/migrations/005_rls_security.sql#L95)).
   - The same repo's client lib has a latent `VITE_SUPABASE_SERVICE_ROLE_KEY` fallback ([lib/supabaseClient.ts#L18](https://github.com/j0n777/endtimes-live/blob/c5ce2c10d1c048ee5ee811ba8bbe4447e14289c1/lib/supabaseClient.ts#L18)).
3. **Ownership via user_metadata** (A, git-city, 5.8k stars).
   - Where: survey policies match `github_login = auth.jwt()->'user_metadata'->>…`.
   - Impact: user_metadata is user-writable, so a user can impersonate another developer.
   - [044_surveys.sql#L16](https://github.com/srizzon/git-city/blob/a43b615468f0d69e889e92b0a72d2fe0d2e5c952/supabase/migrations/044_surveys.sql#L16)
4. **Write `using (true)` in a multi-tenant SaaS** (A, feedbase, 677 stars).
   - Where: `projects FOR DELETE TO authenticated USING (true)`, never dropped, same for feedback, changelogs and invites.
   - Impact: any signed-in user can delete any project.
   - [db_auth_schema.sql#L267](https://github.com/chroxify/feedbase/blob/18dca32a923e12b3af54f1f761c063c7925dfeef/supabase/migrations/20231126133700_db_auth_schema.sql#L267)
5. **Lovable-generated `Public insert/update/delete`** (G).
   - gtm-radar `companies` ([L27–29](https://github.com/martinpawluszek/gtm-radar/blob/f00411518b4915005abce4cea227bbc440d2d2f3/supabase/migrations/20260606195802_708d5339-5735-4036-adb9-1f896e10b1b5.sql#L27-L29)).
   - my-reading-journey: books and users are anon-writable ([L19–21](https://github.com/rafaelraah/my-reading-journey-app/blob/cbddfecbce9f3173899f803a6fe4c901150505d8/supabase/migrations/20260409112649_a2bb503b-0339-4921-99d1-034c8faa3c98.sql#L19-L21)).
   - colinsight: `for all using (true)` ([pipeline.sql#L43](https://github.com/winn/colinsight/blob/2f1b6da5620f80c3c331e09bc19143beb5268053/supabase/migrations/20260522000000_pipeline.sql#L43)).
6. **Permissive policies OR together** (G, alchemy-stock-flow).
   - Where: `"Allow all for demo" ON public.user_roles FOR ALL USING (true)` ([L17](https://github.com/fahadazhar1/alchemy-stock-flow/blob/83f70e62204da88d946a3f748d2a86663c89a0ab/supabase/migrations/20260403225957_678c4e29-b415-4612-8a09-fe6c22eeedb4.sql#L17)).
   - A later migration adds proper `user_can_read_own_role` / `service_role_manage_roles` policies but never drops the demo one.
   - Impact: still anyone-writes-roles.
   - The fact store must evaluate *net* permissive policies, not the latest-looking ones.
7. **Misnamed "service role" policies** (ever-introduced in 6 repos, all fixed later).
   - Example: wacrm `"Service role can insert messages" … WITH CHECK (true)` with no `TO service_role` ([001_initial_schema.sql#L185](https://github.com/ArnasDon/wacrm/blob/45e80ad9e23b91f5c02ab9f935edbae67810e59d/supabase/migrations/001_initial_schema.sql#L185)).
   - Others: git-city `033_live_presence.sql`, bitebag, TarkovTracker, tdavidson, lms-front.
   - The `service_role` bypasses RLS anyway, so these policies only ever open the table to everyone else.
8. **Server `getSession()` → admin client → Stripe** (S, KolbySisk starter, 814 stars).
   - Where: `session.user.id` from an unverified cookie selects the Stripe customer through `supabaseAdminClient` and opens a billing portal.
   - [manage-subscription/route.ts#L12](https://github.com/KolbySisk/next-supabase-stripe-starter/blob/9839fd47d282b1b41a80fb82efea80ac7d1080bc/src/app/(account)/manage-subscription/route.ts#L12)
9. **Server `getSession()` → Prisma** (A, expense.fyi): `checkAuth` uses `session.user.id` for Prisma queries, bypassing RLS entirely ([lib/auth.ts#L41](https://github.com/gokulkrishh/expense.fyi/blob/258d173406ac5f04a4ff03db8457dc087f2fbd65/lib/auth.ts#L41)).
10. **Server role from an unverified token** (A, lms-front): falls back to `JSON.parse(atob(session.access_token.split('.')[1]))` to pick the tenant role ([get-user-role.ts#L47](https://github.com/guillermoscript/lms-front/blob/a9ff05a342e13cc32402c5b026fdaf7cd88c4b30/lib/supabase/get-user-role.ts#L47)). This also hits `jwt-decode-without-verification`.
11. **Lower-severity getSession gating.**
    - midday: draft invoice visible iff `session` exists ([page.tsx#L89](https://github.com/midday-ai/midday/blob/51587319f26a0ffaa9dfccab1920373cb65689b7/apps/dashboard/src/app/%5Blocale%5D/(public)/i/%5Btoken%5D/page.tsx#L89)).
    - creatorai: admin redirects in proxy.ts.
    - Chensokheng and feedbase: middleware route gating ([middleware.ts#L58](https://github.com/Chensokheng/next--supabase-saas-boilerplate/blob/918a13bbbe121aca7ee951a7468103ac5789936f/middleware.ts#L58)).
12. **Unauthenticated service-role callbacks** (G, insights-lm-public, 657 stars, MIT).
    - Where: `audio-generation-callback` and `process-document-callback` both have `verify_jwt = false` and no shared-secret check, and update rows by body-supplied `notebook_id` / `source_id` with the service role.
    - Impact: anyone can overwrite any notebook's content.
    - [audio-generation-callback/index.ts#L16](https://github.com/theaiautomators/insights-lm-public/blob/76cf9d808056c3b7afac3c1cb9bd180014ff6f64/supabase/functions/audio-generation-callback/index.ts#L16)
    - Variant of rule 4 where the "identity" is a resource id, not a user id.
13. **EF trusts body `userId`** (A, open-scouts, 1.4k stars).
    - Where: `send-test-email` has `verify_jwt = false`, uses the service role and calls `auth.admin.getUserById(body.userId)`.
    - Impact: anyone can trigger emails to any user.
    - [index.ts#L41](https://github.com/firecrawl/open-scouts/blob/0d9b714c219aa1400c9d13c12af838a89da5d60f/supabase/functions/send-test-email/index.ts#L41)
14. **Missing RLS.**
    - dzlau starter: Drizzle-created `users_table` with plan and stripe_id, in `public`, no RLS ([0000_colossal_kree.sql#L1](https://github.com/dzlau/stripe-supabase-saas-template/blob/7efcba25d7aa9f37579a2beb24c50cb49a713246/utils/db/migrations/0000_colossal_kree.sql#L1)).
    - TifeQ Bakery (G): orders and products queried from the browser, no RLS in any SQL ([schema.sql#L11](https://github.com/TifeQ/Bakery-System/blob/ec0ecde13e12d5bd4656870ffc2504644a85c7ed/database/schema.sql#L11)).
15. **Official examples teach the patterns.**
    - Supabase's user-management example `handle_new_user` is `security definer` without `search_path` ([init.sql#L28](https://github.com/supabase/supabase/blob/dcf266c360ffcd3e2ba38291ccbbaa57b28007cc/examples/user-management/nextjs-user-management/supabase/migrations/20221017024722_init.sql#L28)), and that shape recurs in 11 starters.
    - The vercel with-supabase tutorial snippet uses `const { data } = await supabase.from('notes').select()` with no error handling ([fetch-data-steps.tsx#L42](https://github.com/vercel/next.js/blob/5dc4b954060e36c9428b50de2501519b6a399875/examples/with-supabase/components/tutorial/fetch-data-steps.tsx#L42)).
    - The slack-clone `Store.js` ignores errors in 7 queries.

### Confirmed negatives worth keeping (hard negatives for Laya)

- `getSession()` for **token forwarding** after or instead of verification:
  - CoreBiz documents why it is safe ([client.ts#L73](https://github.com/Jundev66/CoreBiz/blob/3f520db65192f20ee74a250aa883661ea3b9fc5e/apps/web/src/api/client.ts#L73)).
  - DeskcommCRM calls `getUser()` first, then `getSession()` only to extract the token ([route.ts#L52](https://github.com/melgarafael/DeskcommCRM/blob/689337035992e4b6d163e6214fdf2b0aa664a3e2/app/api/v1/auth/realtime-token/route.ts#L52)).
  - midday tRPC request context; open-bsp CLI plugin.
- `getSession()` right after `exchangeCodeForSession` / `verifyOtp` (lms-front callback, midday verify-otp).
- Refresh-only middleware `await supabase.auth.getSession()` (in-bed-ai, chatgpt-your-files).
- SvelteKit `safeGetSession` (CMSaasStarter [hooks.server.ts#L60](https://github.com/scosman/CMSaasStarter/blob/2e61406c0764585031b40e657ebebf50187c8429/src/hooks.server.ts#L60)).
- An EF that reads `user_id` from the body but checks `targetUserId !== user.id` ([lms-front check-achievements#L49](https://github.com/guillermoscript/lms-front/blob/a9ff05a342e13cc32402c5b026fdaf7cd88c4b30/supabase/functions/check-achievements/index.ts#L49)), and Figma Make's Hono `requireAuth` (kaya-rentals).
- Intentional public-insert policies: newsletter, contact form, reviews, job applications, payment-funnel logs. Also the explicitly public "kanban-publico" board, where anon may write by design.

## 5. Candidate corpus

**Licence policy.**
- Only MIT, Apache-2.0, BSD and Unlicense repos are proposed for training.
- AGPL/GPL repos may be used for **evaluation only**, with eval sets kept internal, after legal sign-off.
- Repos with no licence ("none") are all-rights-reserved. That covers most AI-builder repos (15/17). Do not train on them; use them only as private eval references, or reproduce their *patterns* in fake projects.

| Repo | Licence | Permissive | Group | Why it is useful |
|---|---|---|---|---|
| vercel/next.js `examples/with-supabase` | MIT | yes | S | canonical @supabase/ssr + getClaims baseline (clean negatives) |
| supabase/supabase `examples/*` | Apache-2.0 | yes | S | canonical shapes; definer without search_path; ignored errors; 39 EFs (CORS and verify_jwt variety) |
| vercel/nextjs-subscription-payments | MIT | yes | S | old ssr 0.1, definer trigger, admin client for webhooks |
| KolbySisk/next-supabase-stripe-starter | MIT | yes | S | **positive** server getSession → admin client |
| makerkit/nextjs-saas-starter-kit-lite | MIT | yes | S | monorepo, getClaims, local demo keys (FP trap) |
| imbhargav5/nextbase-nextjs-supabase-starter | MIT | yes | S | ssr 0.12, getClaims, documented-unused getSession helper |
| usebasejump/basejump | MIT | yes | S | rich SQL (accounts, definer, policies) |
| scosman/CMSaasStarter | MIT | yes | S | SvelteKit, safeGetSession (FP trap) |
| devtodollars/mvp-boilerplate | MIT | yes | S | EFs, webhooks with verify_jwt=false |
| ShenSeanChen/launch-mvp-stripe-nextjs-supabase | MIT | yes | S | EFs, triggers, mixed key eras |
| Razikus/supabase-nextjs-template | Apache-2.0 | yes | S | Next + Expo template, MFA SQL |
| YuDefine/nuxt-supabase-starter | MIT | yes | S | Nuxt, sb_secret / demo literals (FP trap) |
| mrclrchtr/supabase-nextjs-starter, vibestackdev/vibe-stack | MIT | yes | S | small 2026 Next 15/16 baselines |
| ArnasDon/wacrm | MIT | yes | A | misnamed service-role policy (fixed), 42 migrations, realtime cleanup |
| melgarafael/DeskcommCRM | MIT | yes | A | 441 migrations, getUser-then-getSession negative, heavy RPC/realtime |
| guillermoscript/lms-front | MIT | yes | A | **positive** decoded-JWT role; negatives (callback, check-achievements); multi-tenant RLS |
| creatorai-app/creatorai | MIT | yes | A | `for all to public using (true)` on referrals; proxy getSession gating; NEXT_PUBLIC service-key fallback |
| marmelab/atomic-crm | MIT | yes | A | declarative schemas, single-tenant `TO authenticated using (true)` (S-judgement case), grant-all-to-anon file |
| geeks-accelerator/in-bed-ai | MIT | yes | A | refresh-only middleware getSession (negative) |
| nastaso/cloudcertprep | MIT | yes | A | Astro + EF |
| ibelick/zola | Apache-2.0 | yes | A | ssr 0.5, storage and realtime |
| shwosner/realtime-chat-supabase-react | Apache-2.0 | yes | A | SPA realtime with correct cleanup |
| tdavidson/portfolio | Apache-2.0 | yes | A | 270 migrations, misnamed service policy (fixed) |
| matiasbattocchia/open-bsp-api | Unlicense | yes | A | 16 EFs, declarative schemas, verify_jwt=false webhooks |
| theaiautomators/insights-lm-public | MIT | yes | G | **positive** unauthenticated service-role callbacks; Lovable scaffold |
| martinpawluszek/gtm-radar | MIT | yes | G | **positive** Lovable `Public insert/update/delete` |
| Jundev66/CoreBiz | MIT | yes | I | documented token-forwarding getSession (negative) |
| JV-Vigneesh/EcoTrack | MIT | yes | I | small SPA baseline |
| midday-ai/midday, srizzon/git-city, chroxify/feedbase, gokulkrishh/expense.fyi | AGPL-3.0 | no (eval only) | A | positives: getSession gating, user_metadata ownership, write `true`, getSession → Prisma |
| tarkovtracker-org/TarkovTracker | GPL-3.0 | no (eval only) | A | Nuxt, 14 EFs, custom realtime release |
| crbnos/carbon, coremvp/Hikari, creova-gif/kaya-rentals | custom (NOASSERTION) | no (review) | A/S/G | carbon: 1,109 migrations plus dynamic search_path fix (stress test) |
| firecrawl/open-scouts, supabase-community/chatgpt-your-files, dzlau/stripe-supabase-saas-template | none | no | A/S | positives (EF body userId; auth-helpers; Drizzle table without RLS); reproduce the patterns only |
| all other G/I repos (fahadazhar1, rafaelraah, j0n777, winn, TifeQ, mushfiqur2029, Luizffeng, …) | none | no | G/I | best positives for AI-built apps; **pattern source for fake projects, not training text** |

**Licence gap.** Permissive AI-builder repos are scarce: 2/17. The AI-builder slice of the corpus
will have to come from synthetic fake projects that imitate the Lovable scaffold:
- `src/integrations/supabase/*`
- `<ts>_<uuid>.sql` migrations
- the `Public …` / `Allow all for demo` policy idioms
- `.env` with a publishable key

## 6. Implications

### Rule priority

1. **`rls-policy-always-true` (writes) goes to #1** for AI-built code.
   - It is net-present in 4/17 AI-builder repos and absent from starters. Lovable now enables RLS on every table (only 1/14 G repos had a table without RLS), so the risk has **moved from "RLS off" to "RLS on with `true`"**.
   - Ship three deterministic sub-checks first:
     - (a) write command with a `true` qual or check
     - (b) policy named "service role/system" without a `TO service_role` clause (6 repos ever)
     - (c) net-permissive evaluation: an old permissive policy survives newer strict ones (alchemy)
   - Intentional public-insert forms are common (6 repos). Keep `INSERT TO anon … WITH CHECK (true)` on contact/newsletter-like tables as a warning or an S-judgement, not an error.
2. **`rls-disabled-on-exposed-table` is rarer than the incident literature suggests** (3/54).
   - Where it occurs it comes from non-Supabase tooling: Drizzle migrations, a hand-written `schema.sql`, scripts.
   - Keep it at the top for severity, but the fact store must ingest Drizzle `pgTable` definitions and non-`supabase/` SQL paths, or it will miss exactly these cases.
3. **`server-trusts-getsession` remains a Laya target and the survey confirms why.**
   - 7 repos are true positives, including an 814-star starter.
   - About half of server-side call sites are legitimate:
     - token forwarding to a verifying API
     - right after `exchangeCodeForSession`/`verifyOtp`
     - after `getUser()`
     - refresh-only middleware
     - `safeGetSession`
   - Location alone (D) would be roughly 50% precision. The Laya question "is the result used to decide access?" is the right one.
   - Severity tiers that emerged: admin client / Prisma with `session.user.id` (high) > role decisions > middleware redirects (low).
4. **`user-metadata-for-authorization` should cover signup triggers**, not only policies.
   - `raw_user_meta_data->>'role'` assigned into a role, admin or plan column inside `handle_new_user` is a deterministic, high-severity form (tax-marketplace).
   - Keep the S question for the other metadata uses (name, avatar: benign and very common, found in ~10 triggers).
5. **Broaden `ef-service-role-trusts-body-identity`** to body-supplied **resource ids** in callbacks combined with `verify_jwt = false` and no shared-secret check (insights-lm).
   - Suggested Laya question: "Does this function authenticate the caller, by JWT or by a shared secret, before writing rows identified by the request body?"
6. **Demote** for the spike and eval:
   - `realtime-channel-not-removed` (0/22)
   - `client-per-render` (0/63; the `createClient()` wrapper idiom over `createBrowserClient` is a guaranteed FP trap)
   - `ef-missing-cors-preflight` (0/18; preflight lives in `_shared/cors.ts`, Hono `cors()` or middleware, so the rule needs cross-file facts to avoid 80 FPs)
   - `deprecated-auth-helpers` (2/63)
   - `service-key-in-client` (0 live, 2 latent)

   Keep them as cheap D rules, but they will not produce eval signal from real code.
7. **Ubiquitous perf and hygiene rules need noise control.**
   - `auth-function-not-wrapped-in-select` fires in 100% of repos and on 80% of `auth.uid()` policies.
   - `ignored-query-error` fires in 60% of repos (1,434 sites), including the official examples.
   - Ship both as info with an autofix and aggregate per file. For ignored errors, raise severity only on mutations or when `data` is dereferenced without a null check.
8. **`security definer` without `search_path` is mostly inherited from Supabase's own example** (22/37 repos with definer functions).
   - Low severity on a schema-qualified trigger.
   - Deduplicate against Splinter's `function_search_path_mutable`.
   - Handle blanket `DO $$ … ALTER FUNCTION … SET search_path` fixes (carbon) before reporting a net state.
9. **Key-handling FP traps confirmed in the wild.**
   - Lovable commits `.env` with publishable keys (6/17 G).
   - 7 repos commit local `supabase-demo` service_role JWTs. Whitelist by decoding `iss`; never report a value.
   - Test fixtures contain fake `sb_secret_` strings.

### Fake-project matrix (what to build)

| Axis | Values to cover, with survey weight |
|---|---|
| Framework | **Next.js 16 App Router + @supabase/ssr 0.12** (largest share of S/A); Next 14/15 + ssr 0.5 (legacy share); **Vite React SPA, Lovable scaffold** (10/17 G); **TanStack Start, new Lovable template with `client.server.ts` + `auth-attacher.ts`** (5/17 G); Nuxt; SvelteKit; Remix/React Router; one Expo app (thin in the sample, but the README fact store expects it) |
| Key era | anon/service_role (67%) and publishable/secret (49%), plus mixed projects |
| Auth verification | getUser, getClaims (25% and rising), safeGetSession, token forwarding |
| SQL layout | `supabase/migrations` with many files and drop/re-create churn; `supabase/schemas` declarative; root `schema.sql`; Drizzle-generated SQL; monorepo `packages/database/supabase` |
| Policy idioms | Lovable `Public …`/`Allow all for demo`, misnamed "Service role can …" without `TO`, permissive-OR leftovers, helper-function policies (carbon/lms style), single-tenant `TO authenticated using(true)` (S-judgement) |
| Triggers | `handle_new_user` copies: benign metadata (name, avatar), role-from-metadata (positive), hardcoded role (negative) |
| Edge Functions | `_shared/cors.ts`, Hono `cors()`, webhook with signature check, callback with `verify_jwt=false` and no secret (positive), service role + `getUser` check (negative) |
| Committed env | `.env` with publishable key and project ref (must not fire), demo service_role keys (must not fire) |

## Reproduction

Scanner, aggregation and verification scripts lived in the session scratchpad and have been
deleted along with the clones. To rerun:
- clone the repos listed in §5 at the SHAs in the permalinks
- grep for the patterns named in the §3 "What was checked" column
- verify each hit by reading it
