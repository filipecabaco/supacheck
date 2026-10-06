# Blogs, tutorials and articles: what they teach and what bites in production

Research pass of 2026-10-05. It covers official Supabase blog posts and docs quickstarts,
framework docs (Astro, Expo, SvelteKit), Vercel's template, community tutorials (dev.to,
Medium, LogRocket, freeCodeCamp, makerkit, personal blogs), source repos for the most-watched
YouTube courses, pentest and scanner write-ups, and "leaving Supabase" or production posts.

Ids refer to the ranked catalogue in [README.md](README.md) and the area files. New
candidate ids are marked **NEW**.

Caveats:
- YouTube transcripts were not available. For video courses I read the **companion GitHub
  repo** instead. Anything shown only on video (dashboard-created RLS, for example) is
  unverified.
- Some pages returned 403 or 410 (DZone, bombillazo on Medium, cloudnweb). Claims about them
  come from search snippets and are marked *(unverified)*.
- Tutorial dates are unreliable. Toptal's CRUD tutorial says "Published May 26, 2026" but
  teaches the v1 `supabase.auth.signIn` magic link. Republishing hides stale APIs, so the
  linter should judge the code, not the stated date.

---

## 1. Tutorial audit

Key to columns: **Teaches** = anti-patterns the tutorial's code demonstrates. **Warns** = ones
it explicitly cautions against. **API era** = auth-helpers vs `@supabase/ssr`, v1 vs v2,
anon/service_role vs publishable/secret, and getSession vs getUser/getClaims on the server.

### 1a. Official or quasi-official sources (highest copy rate)

| # | Source | Date | Framework | Teaches | Warns / good | API era |
|---|---|---|---|---|---|---|
| T1 | [Supabase "User Management App with Next.js"](https://supabase.com/docs/guides/getting-started/tutorials/with-nextjs) (also the React, Expo and SvelteKit variants share this SQL) | live docs, 2026 | Next.js App Router | `storage-policy-not-owner-scoped`: `"Anyone can upload an avatar." on storage.objects for insert with check (bucket_id = 'avatars')`, which has no `TO` and no owner or folder check, so **anon can upload**. `policy-missing-to-role` on every table policy. `rls-policy-always-true` on SELECT for profiles (intended public, so this is a correct-usage example). The avatar UPDATE policy `using ((select auth.uid()) = owner) with check (bucket_id = 'avatars')` has no `bucket_id` in USING, so it matches the user's own objects in **any** bucket *(impact unverified)*. | Explicit `GRANT`s (ready for the 2026-10-30 change). `(select auth.uid())` wrapping. `handle_new_user` is `security definer` with `set search_path = ''`. Uses getClaims, getUser and getSession with correct guidance. | publishable key, `@supabase/ssr`, `getClaims` |
| T2 | [Vercel `with-supabase` template](https://github.com/vercel/next.js/tree/canary/examples/with-supabase) (`create-next-app -e with-supabase`) | live, 2026 | Next.js 15/16 (proxy) | **`auth-callback-open-redirect` (auth #15), concrete instance.** `app/auth/confirm/route.ts` does `const next = searchParams.get("next") ?? "/"` and then `redirect(next)` with no validation. It also interpolates `error.message` into a URL unencoded. | Excellent comments against module-scope clients ("Don't put this client in a global variable", Fluid compute). `getClaims()` in proxy. No-op `setAll` in the RSC client with an explanation. | publishable, `@supabase/ssr`, getClaims |
| T3 | [Supabase Google social-login docs callback](https://supabase.com/docs/guides/auth/social-login/auth-google) | live | Next.js | Trusts `x-forwarded-host` for the redirect host. That is safe only behind a proxy that overwrites the header *(risk depends on hosting; unverified)*. | Validates `next` with `if (!next.startsWith('/')) next = '/'`. Combined with `${origin}${next}`, `//evil.com` stays on-origin. This is the GOOD counterpart to T2. | ssr |
| T4 | [Supabase UI Library "Realtime Chat" block](https://supabase.com/ui/docs/nextjs/realtime-chat) ([hook source](https://github.com/supabase/supabase/blob/master/apps/ui-library/registry/default/blocks/realtime-chat/hooks/use-realtime-chat.tsx)) | live | Next.js / React (shadcn registry) | `realtime-public-channel-for-private-data`: `supabase.channel(roomName)` with no `private: true`. **NEW `realtime-client-asserted-identity`**: the sender name is a client prop put into the payload (`user: { name: username }`), which any client can spoof. | Removes the channel in the `useEffect` cleanup. Uses `createBrowserClient`, a singleton, so calling `createClient()` in the hook body is **not** a `client-per-render` bug (false-positive trap). | ssr browser client |
| T5 | [Astro docs: Supabase guide](https://docs.astro.build/en/guides/backend/supabase/) | live | Astro SSR | **`plain-client-in-ssr` (auth #12)** with a hand-rolled cookie flow: `createClient` from supabase-js at module scope (`module-scope-server-client` on the server), `cookies.set("sb-access-token", access_token, { path: "/" })` with **no httpOnly, secure or sameSite**, then `supabase.auth.setSession({...})` on the shared module client per request. This last step can leak session state across concurrent requests on a long-lived server *(cross-request leak inferred from the module-scope client; unverified in practice)*. | PKCE for OAuth. No RLS discussion. | anon key, no `@supabase/ssr` |
| T6 | [Expo docs: Using Supabase](https://docs.expo.dev/guides/using-supabase/) | live | Expo / RN | Nothing serious. The example grants SELECT to both `anon` and `authenticated` (fine for demo data). | `detectSessionInUrl: false`, AppState-driven `startAutoRefresh`, "Never put the database password or a secret key in your app". | publishable key |
| T7 | [Supabase SvelteKit SSR guide](https://supabase.com/docs/guides/auth/server-side/sveltekit) | live | SvelteKit | Nothing serious. | `safeGetSession` = `getSession` then `getUser`. This is a known false-positive trap for `server-trusts-getsession`. | publishable, ssr |
| T8 | [Supabase blog: React Native file upload](https://supabase.com/blog/react-native-storage) | 2023-08-01 | Expo | `policy-missing-to-role`: the storage policy is `TO public` but owner-scoped by `(storage.foldername(name))[1]`, so access is still effectively per-user. | GOOD: private bucket, `${userId}/` prefix, base64 → ArrayBuffer (avoids `storage-rn-blob-upload`). | anon key |
| T9 | [Supabase Flutter chat tutorial](https://supabase.com/blog/flutter-tutorial-building-a-chat-app) | ~2022 | Flutter | Single shared room; part 1 has no RLS until part 2 *(snippet-level)*. | `alter publication supabase_realtime add table`. RLS in part 2. | old |

### 1b. Video courses (read via their source repos)

| # | Source | Date | Framework | Teaches | API era |
|---|---|---|---|---|---|
| T10 | JavaScript Mastery, "SaaS App Full Course 2025" (the most-watched Supabase video, ~1.2M views per [developereducators](https://developereducators.com/best/supabase/)). Repo: [adrianhajdin/saas-app](https://github.com/adrianhajdin/saas-app), 442★ / 194 forks | 2025-05 | Next.js + **Clerk third-party auth** | **`unescaped-postgrest-filter-string` (#18)**: `query.or(\`topic.ilike.%${topic}%,name.ilike.%${topic}%\`)`, where `topic` comes from URL search params. **NEW `spread-client-input-into-write`**: `.insert({...formData, author})` lets the client set any column (author is overwritten, but id, created_at and any privileged columns are not). `getRecentSessions` reads `session_history` with no user filter, so it relies on RLS or shows everyone's history (`rls-as-only-filter`; intent unclear). `getCompanion` does `.eq('id', id)` then `data[0]` (`single-where-maybe-single` territory). `if(error) return console.log(error)` (`ignored-query-error`, soft). RLS lives only in the video/dashboard *(unverified)*. | anon key + `accessToken: () => auth().getToken()` (correct native Clerk integration) |
| T11 | Code With Antonio, "Spotify Clone: Next 13.4, Supabase, Stripe" (2023, ~1.2M views). Original repo is gone; read the fork [DevGeekPhoenix/spotify-with-next13](https://github.com/DevGeekPhoenix/spotify-with-next13) | 2023-07 | Next 13 | **`deprecated-auth-helpers` (#34)**: `@supabase/auth-helpers-nextjs@0.7.2`, `createMiddlewareClient`, `createServerComponentClient`. **`server-trusts-getsession`**: `getSession()` in server actions. **`filter-with-possibly-undefined` (data #17)**: `.eq("user_id", sessionData.session?.user.id)`. **`storage-policy-not-owner-scoped` risk**: upload path is `song-${values.title}-${uniqueID}`, built from user input with no user folder. **`non-atomic-multi-step-write`**: two uploads then an insert, with no cleanup on failure (orphan files). Errors are logged and `data` returned as `[]`. | auth-helpers, anon |
| T12 | freeCodeCamp "Twitter clone with Next.js 13 and Supabase" ([article](https://www.freecodecamp.org/news/learn-full-stack-development-with-next-js-and-supabase-by-building-a-twitter-clone/)) | 2023 | Next 13 | `deprecated-auth-helpers` era *(from course date and snippets; repo not inspected)*. | auth-helpers |

### 1c. Community written tutorials

| # | Source | Date | Framework | Teaches | Warns / notes |
|---|---|---|---|---|---|
| T13 | [TechStaunch: Auth in Next.js with Supabase](https://www.techstaunch.com/blogs/implementing-authentication-in-next-js-with-supabase?tech_blog=true) | 2025-02-06 | Next App Router | **`server-trusts-getsession`** in middleware and route guards (`getSession()`). Defines `SUPABASE_SERVICE_ROLE_KEY` with no guidance on where it may be used. No RLS at all, so route protection is the only control (`rls-disabled-on-exposed-table` risk). | Uses `@supabase/ssr`, per-request client, `if (error) throw error`. |
| T14 | [ShipSaaS: Auth with Next.js and Supabase](https://shipsaas.com/blog/next-js-auth-supabase) | 2023-02-20 | Next (client only) | Client-only protection with `getSession()`. Copies the user to `localStorage.setItem("user", ...)` and logs out with `localStorage.clear()`, which **never calls `signOut`** (**NEW `logout-without-signout`**). No RLS ("next steps"). | — |
| T15 | [nextjsstarter.com: Supabase Auth Next.js Simplified](https://nextjsstarter.com/blog/supabase-auth-nextjs-integration-simplified/) | 2023-12-06 | Next pages | v1 APIs: `supabase.auth.signIn()`, `supabase.auth.api.getUserByCookie(req)`, `auth.session()`, `auth-helpers-react`. These no longer compile on supabase-js v2, but LLMs still emit them. | — |
| T16 | [Toptal/Adeva CRUD with React](https://www.toptal.com/external-blogs/adeva/building-crud-app-with-react-js-supabase) | "2026-05-26" (republished; content is v1) | CRA | v1 `signIn` magic link. `.eq()` filters with "identity verification" only client-side *(details from summary)*. | Date is misleading (see caveats). |
| T17 | [DEV, Suresh Ramani: CRUD app with Supabase + Next.js](https://dev.to/sureshramani/build-a-powerful-crud-app-with-supabase-and-nextjs-full-guide-3a6p) | 2025-06-20 | Next | Policies with no `TO` (`policy-missing-to-role`), no `(select ...)` wrapping (`auth-function-not-wrapped-in-select`), `author_id uuid REFERENCES auth.users(id)` with no `on delete` (`fk-to-auth-users-blocks-deletion`). No UPDATE/DELETE policies although the app updates and deletes (silent 0-row updates: `update-policy-without-select-policy` / `unchecked-mutation-effect`). Realtime hook with no cleanup (`realtime-channel-not-removed`). | — |
| T18 | [LogRocket: Remix + Supabase realtime chat](https://blog.logrocket.com/remix-supabase-real-time-chat-app/) | 2023-06-20 | Remix | `deprecated-auth-helpers` (`@supabase/auth-helpers-remix`). `server-trusts-getsession` in the loader. "Enable RLS so only authenticated users can read and send" but **no policy SQL shown** (readers improvise, likely `policy-authenticated-not-authorized`). `supabase.channel("*")` with an unfiltered postgres_changes subscription on all messages. Insert with no error check (`ignored-query-error`). | Cleans up with `removeChannel`. |
| T19 | [Programonaut: Svelte realtime chat](https://www.programonaut.com/how-to-create-realtime-chat-application-using-supabase/) | 2023-08-01 | Svelte SPA | **`policy-authenticated-not-authorized` (#6)**: an `ALL` policy lets every authenticated user do everything on chats, chats_users and messages, so any user can read any chat. `ignored-query-error` (`const { data, error } = await ...insert` with `error` never read). Unfiltered `postgres_changes` on `chats` (`realtime-unfiltered-postgres-changes-at-scale`). Policies are created in the dashboard (no migration). | Unsubscribes in `onDestroy`. |
| T20 | [SitePen: Serverless chat with Supabase](https://www.sitepen.com/blog/building-a-serverless-chat-application-with-supabase) | 2023-03-14 | React/Vite | Public broadcast channel `room:${roomCode}` with no auth (`realtime-public-channel-for-private-data`). Username comes from client input (NEW `realtime-client-asserted-identity`). Room secrecy relies on an unguessable code. | Clean unsubscribe. |
| T21 | [OWolf: React image uploader](https://www.owolf.com/blog/building-a-react-image-uploader-with-supabase-storage) | 2025-03-17 | React | `${uuidv4()}_${file.name}` with no user prefix, `getPublicUrl` (public bucket implied), no storage policies shown. MIME and size checked client-side only. | `if (uploadError) throw`. |
| T22 | [Mobisoft: Supabase + React + TS](https://mobisoftinfotech.com/resources/blog/app-development/supabase-react-typescript-tutorial) | 2025 *(approx.)* | React | `storage-policy-not-owner-scoped`: "access … only to authenticated users", path `public/{file.name}`. **`storage-signed-url-persisted-or-long-lived`**: `createSignedUrl` for **30 days (2,592,000 s)**. Profiles readable by all authenticated users. | Uses `getUser()`, `removeChannel`. |
| T23 | [DEV, asheeshh: Mastering Supabase RLS](https://dev.to/asheeshh/mastering-supabase-rls-row-level-security-as-a-beginner-5175) | 2025-03-20 | SQL | Storage example `for insert with check (bucket_id = 'your-bucket-id')` with no `TO` and no owner (anon upload). | Names over-permissive authenticated policies as a mistake. Uses `TO`. |
| T24 | [Lovable Migration: Edge Functions Guide](https://www.lovablemigration.com/blog/supabase-edge-functions-guide) | 2025-04-03 | Edge Functions | **Stripe webhook with signature verification commented out** (`// const event = stripe.webhooks.constructEvent(...)`) and `JSON.parse(body)` with a service-role client (**NEW `webhook-signature-not-verified`**; related to `ef-stripe-sync-constructEvent`). `send-email` takes `{to, subject, html}` from the body with no auth check (**NEW `ef-open-relay`**). The DB-webhook handler trusts `payload.record` with no shared-secret check (**NEW `db-webhook-unauthenticated`**). No CORS preflight handling (`ef-missing-cors-preflight`). | — |
| T25 | [DEV, kanta13jp1: Supabase × Stripe subscriptions](https://dev.to/kanta13jp1/supabase-x-stripe-implement-subscription-billing-with-edge-functions-hah) | 2026 *(year inferred)* | Flutter + EF | **`ef-service-role-trusts-body-identity` (#4)**: `const { userId, priceId } = await req.json()` goes into checkout `metadata.user_id`, which the webhook later trusts. Sync `constructEvent` on Deno (`ef-stripe-sync-constructEvent`). | "Always verify" the webhook signature. |
| T26 | [DEV, krish_kakadiya: Inside Supabase Edge Functions](https://dev.to/krish_kakadiya_5f0eaf6342/inside-supabase-edge-functions-how-serverless-magic-actually-works-2m1p) | 2024-02-17 | EF | Sync `constructEvent`. `esm.sh/stripe@8.174.0?deno-std=0.63.0` (ancient pin). Module-scope service-role client: OK for admin clients, flag only if a user JWT is set on it. | Uses `req.text()` correctly; 400 on bad signature. |

### 1d. Best-practice and "mistakes" articles (mostly good; listed for contradictions)

| Source | Date | Notes |
|---|---|---|
| [MakerKit: Supabase RLS Best Practices](https://makerkit.dev/blog/tutorials/supabase-rls-best-practices) | 2026-01-26 | Strong list: wrap `auth.uid()`, index, `TO`, UPDATE needs SELECT, column grants for identity columns, app_metadata over user_metadata, `security_invoker` views, pgTAP with `is_empty()` for denials. **But** its own helper `create function has_role_on_account(...) language sql security definer` has **no `set search_path`** and no schema (defaults to public, so it is exposed as RPC). That is `security-definer-mutable-search-path` and `security-definer-function-exposed` inside a best-practice article. |
| [DesignRevision: RLS Guide 2026](https://designrevision.com/blog/supabase-row-level-security) | 2026-02-09, upd. 2026-07-02 | Good on `TO` and USING + WITH CHECK, but doesn't wrap `auth.uid()` in select. 8 named mistakes match the catalogue. |
| [DEV, lazydev_oh: 5 RLS mistakes](https://dev.to/lazydev_oh/supabase-rls-5-common-mistakes-i-broke-and-fixed-myself-38bl) | 2025–26 | Contains a **wrong claim** (see §2c): "UPDATE without WITH CHECK → user_id can be tampered". |
| [iloveblogs: 10 Next.js + Supabase mistakes](https://www.iloveblogs.blog/post/nextjs-supabase-common-mistakes) | 2026-02-25, upd. 2026-08-14 | Matches the catalogue: RLS off, browser client in RSC, service key, middleware, indexes, types, realtime cleanup, transactions, pooler, `await cookies()` (Next 15), N+1, migrations. Recommends `getUser()` in middleware (pre-getClaims, but not wrong). |
| [Pentestly: Lessons from real pentests](https://www.pentestly.io/blog/supabase-security-best-practices-2025-guide) | 2025-09-09, upd. 2025-10-09 | Best source of new items (see §2a). |
| [ModernPentest: 10 misconfigurations](https://modernpentest.com/blog/supabase-security-misconfigurations) | 2025-12-08 | Mostly the catalogue's items. One factual error (see §2c). |

### 1e. Cross-tutorial tallies

Counted across the 26 audited tutorials (T1–T26):

| Pattern taught | Count | Tutorials |
|---|---|---|
| `deprecated-auth-helpers` or v1 API | 6 | T11, T12, T15, T16, T18, plus the egghead Remix course (2022; known from snippet only) |
| `server-trusts-getsession` | 4 | T11, T13, T18, T14 (client-only variant) |
| Storage insert not owner-scoped, or anon-uploadable | 6 | **T1 (official)**, T11, T21, T22, T23, plus DZone's "anyone can upload avatars" *(unverified, 403)* |
| `policy-missing-to-role` | ≥4 | T1, T8, T17, T23 |
| No policy SQL at all ("enable RLS in the dashboard") | 5 | T13, T18, T19, T21, T10 |
| `ignored-query-error` (explicit) | 4 | T10 (soft), T18, T19, T11 (log-and-continue) |
| Realtime with no cleanup | 1–2 | T17 (most tutorials do clean up; the leak is more common in real apps than in tutorials) |
| Public realtime channel / client-asserted identity | 3 | **T4 (official)**, T20, T18 (wildcard) |
| Webhook / EF auth gaps | 4 | T24 (no verification, open relay), T25 (body identity), T26 and T25 (sync constructEvent) |
| Open redirect in auth callback | 1 | **T2 (official Vercel template)** |
| anon/service_role naming (pre-2025 keys) | most | everything except T1, T2, T6, T7 |

Takeaways for the model and rules:
1. **Official samples teach two patterns we plan to flag.** The anon-uploadable avatar policy
   (T1) and missing `TO` clauses are in the most-copied SQL on the internet. Rules on these
   need a **"looks like the official avatar quickstart" severity calibration**: warn, don't
   error, unless the bucket is private or the path implies per-user content.
2. **The tutorial era is detectable.** `@supabase/auth-helpers-*`, `auth.signIn(`,
   `auth.session()`, `auth.user()`, `auth.api.*`, `createMiddlewareClient` and
   `createServerComponentClient` fingerprint 2022–2023 tutorial code. Their presence raises
   the prior for `server-trusts-getsession` and missing RLS in the same repo.
3. **"Enable RLS in the dashboard" tutorials leave no SQL.** For repos built that way,
   `rls-disabled-on-exposed-table` (X) can't be proven from migrations. Report "RLS state
   unknown (no migrations)" rather than a false negative or a false positive.

---

## 2. New anti-patterns, nuances and contradictions

### 2a. New candidates not in the catalogue

| Candidate id | Detection | What goes wrong | Sources |
|---|---|---|---|
| `orm-connection-bypasses-rls` | X (env `DATABASE_URL` user is `postgres` + Prisma/Drizzle imports + RLS policies exist) + S | Prisma and Drizzle connect as `postgres` (table owner with BYPASSRLS), so every policy is ignored and the "same query returns every tenant's rows". Policies give false assurance. `FORCE RLS` doesn't help against BYPASSRLS. | [GuardLayer](https://www.guardlayer.io/blog/orm-bypasses-supabase-rls), [Mortadha Ghanmi](https://mortadha.dev/blog/restore-supabase-rls-with-drizzle-using-trpc-middlewares/), [rphlmr/drizzle-supabase-rls](https://github.com/rphlmr/drizzle-supabase-rls), [gautamkhorana](https://gautamkhorana.com/blog/drizzle-vs-prisma-2026/) |
| `session-level-set-role-on-pooled-connection` | D (`SET ROLE` / `set_config(..., false)` outside a transaction) | Teams "restoring" RLS under an ORM use session-level `SET`, which persists on a pooled connection and **leaks one user's identity into the next request**. The popular Prisma RLS extension sets claims but not the role, so `TO authenticated` policies fail silently. | [GuardLayer](https://www.guardlayer.io/blog/orm-bypasses-supabase-rls) |
| `transaction-pooler-prepared-statements` | X (`:6543` URL + postgres-js without `prepare:false`, or Prisma without `pgbouncer=true`) | `prepared statement "…" already exists/does not exist`, only in prod. Inside transactions the writes may be silently lost while the handler returns 200. Partly in data #16; worth its own D/X rule. | [Drizzle docs](https://orm.drizzle.team/docs/connect-supabase), [supabase discussion #28239](https://github.com/orgs/supabase/discussions/28239), [zenn](https://zenn.dev/cosoado/articles/supabase-pooler-url-migration-vs-runtime?locale=en) |
| `realtime-client-asserted-identity` | S + D (broadcast payload contains `user`/`username`/`sender` taken from props/state) | Broadcast receivers trust sender identity carried in the payload. With public channels anyone can impersonate. Even private channels authorize the *channel*, not the payload fields. | T4 (official UI block), T20 |
| `realtime-channel-name-as-authorization` | S | "Namespace channels `tenant:${id}:room:${id}` to prevent cross-tenant subscriptions" treats naming as access control. Without `private: true` + `realtime.messages` policies, any client can join any topic it can guess. | [agilesoftlabs](https://www.agilesoftlabs.com/blog/2026/05/supabase-realtime-in-production-what) (contradicts the [Realtime Authorization docs](https://supabase.com/docs/guides/realtime/authorization)) |
| `webhook-signature-not-verified` | D (Stripe/Svix/GitHub webhook handler with no `constructEvent(Async)`/verify call, or a commented-out one) + X (`verify_jwt=false`) | With `verify_jwt=false` the signature is the only control. A forged curl marks orders paid. | T24, [Gosign](https://www.gosign.de/en/magazine/supabase-edge-functions-secure/), [official example](https://github.com/supabase/supabase/blob/master/examples/edge-functions/supabase/functions/stripe-webhooks/index.ts) |
| `db-webhook-unauthenticated` | D/X | Edge Functions targeted by Database Webhooks / `pg_net` trust `payload.record` with no shared secret or `secret` auth mode, so anyone can post fake "row inserted" events. | T24. Official fix: `withSupabase({auth:'secret'})` ([blog](https://supabase.com/blog/introducing-supabase-server)) |
| `ef-open-relay` | S | A function sends email, SMS or LLM calls with recipient and content from the body and no caller check. Because the anon/publishable key is public, `verify_jwt` alone doesn't stop abuse. The API keys docs note that "the verify_jwt check alone doesn't authenticate a caller that sends only an API key". | T24, [API keys docs](https://supabase.com/docs/guides/getting-started/api-keys) |
| `spread-client-input-into-write` | D (`insert({...body` / `...formData` / `update(req.body)`) + S | Mass assignment. The client sets columns like `role`, `plan`, `credits`, `user_id`, `id`. On a service-role client it bypasses everything. On a user client it combines with `self-updatable-privilege-column`. | T10 |
| `mfa-aal-not-enforced` | D (policies or server code on sensitive tables lack `auth.jwt()->>'aal' = 'aal2'` when the app uses MFA) + S | A pre-MFA (`aal1`) token can do "MFA-protected" actions because the checks live only in the UI. | [Pentestly](https://www.pentestly.io/blog/supabase-security-best-practices-2025-guide), [Supabase MFA docs](https://supabase.com/docs/guides/auth/auth-mfa) |
| `invite-only-but-signup-enabled` | X (`config.toml [auth] enable_signup = true` + no signup UI / invite flow present) | `/auth/v1/signup` stays callable when the UI hides signup. | Pentestly |
| `network-extension-exposed` | X (`http`/`pg_net` functions in an exposed schema with EXECUTE for anon/authenticated) | Full-read SSRF via `/rest/v1/rpc/http_get`. Similar for an exposed `cron` schema (persistence) and `vault` functions (plaintext secrets). | Pentestly |
| `captcha-client-only` | S | The Turnstile token is checked in the frontend only, or not passed to `signUp`/`signInWithPassword` `options.captchaToken`. | Pentestly |
| `cors-wildcard-or-reflected-on-authenticated-ef` | D | `Access-Control-Allow-Origin: *` or an echoed Origin on functions that read the user's JWT. This is the opposite failure to `ef-missing-cors-preflight`. Note the official `corsHeaders` snippet uses `*`, so this is low severity unless cookies or credentials are involved *(severity debatable)*. | Pentestly |
| `logout-without-signout` | D (`localStorage.clear()` / `removeItem('sb-...')` in a logout handler with no `auth.signOut`) | The refresh token stays valid server-side. | T14 |
| `delete-user-without-session-revoke` | D (`auth.admin.deleteUser(` with no prior `auth.admin.signOut(`) + S | "Deleting a user doesn't invalidate their JWT. You must revoke sessions first." `getClaims()` keeps accepting the token until expiry. | [Supabase Agent Skills blog, 2026-04-09](https://supabase.com/blog/supabase-agent-skills) |
| `third-party-auth-uid-on-text-ids` | D (Clerk/Firebase/Auth0 in deps + `auth.uid()` in policies, or `uuid` user columns) | `auth.uid()` casts `sub` to uuid, but Clerk ids are text, so policies fail closed or error. Also covers FKs to `auth.users` that can never be satisfied under third-party auth. | [Clerk docs](https://clerk.com/docs/guides/development/integrations/databases/supabase), [Supabase third-party docs](https://supabase.com/docs/guides/auth/third-party/overview) |
| `storage-path-from-user-input` | D/S | Object keys built from user-supplied titles or filenames with no user prefix: collisions, overwrite (with upsert), guessable paths, and policy folder checks that are impossible. | T11, T21, T22 |
| `default-smtp-in-production` | X (`config.toml` / no `[auth.email.smtp]` + production signals) | The built-in mailer allows 2 emails/hour per project and only to team addresses. Signups silently stall at launch. Not a code bug, but a top "it broke in prod" item. | [discussion #15896](https://github.com/orgs/supabase/discussions/15896), [axonbuild](https://axonbuild.com/blog/supabase-email-rate-limit/) |

### 2b. Nuances that refine existing ids

- **`auth-callback-open-redirect` (auth #15).** The catalogue says "no incident found". The
  **official Vercel `with-supabase` template** ships `redirect(next)` unvalidated in
  `/auth/confirm` (T2), while Supabase's own callback sample validates it (T3). This is high
  copy volume, so consider upgrading its frequency. Also note that Next's `redirect()`
  accepts absolute URLs, so a `startsWith('/')` check is needed and `//` must be rejected
  when the value isn't prefixed with origin.
- **`client-per-render` (data #13).** `createBrowserClient` from `@supabase/ssr` is a
  singleton in the browser, so `createClient()` inside a hook body (T4) is not a bug. Only
  `createClient` from supabase-js per render is.
- **`jwt-decode-without-verification` (#12).** The official [RBAC
  docs](https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac)
  tell you to `jwt-decode` the access token **client-side** to read custom claims for UI.
  Server-side, [SvelteKit RBAC tutorials](https://mike-eviota.com/blogs/supabase-rbac-and-subscription-plans-in-sveltekit-database-roles-jwt-claims-and-typed-locals-0197ac90)
  decode the token *after* `safeGetSession` validated that same token. Flag only when the
  decoded token is not the one that was verified, or when it is decoded server-side with no
  preceding verification.
- **getClaims vs getUser.** MakerKit says "getClaims(), not getUser(), and never getSession()"
  ([TanStack post](https://makerkit.dev/blog/tutorials/tanstack-start-supabase-auth)). The
  Supabase docs add a caveat: getClaims accepts a non-expired token **after session
  revocation, logout-everywhere or user deletion**. For destructive or high-value actions,
  `getUser()` is the right call. Don't flag `getUser()` as "slow" in those paths.
- **Module-scope clients in Edge Functions.** A module-scope **service-role** client with
  `persistSession:false` is fine (T26, the official example). The bug is a module-scope
  client carrying a user's JWT (functions #10). Already in the false-positive list;
  tutorials confirm it is common.
- **Storage UPDATE policy scoping.** In the official avatar SQL, `USING (owner = uid)` lacks
  `bucket_id`, so the policy applies across buckets. A rule could require `bucket_id` in
  *both* USING and WITH CHECK for storage policies *(impact unverified)*.
- **Astro's official guide** (T5) is a fresh source of `plain-client-in-ssr`, cookies without
  httpOnly, and module-scope server clients. Astro users copy the framework docs, not
  Supabase's own `@supabase/ssr` Astro guide.
- **Time-sensitive default (sql #18).** The official quickstart (T1) already includes explicit
  `GRANT SELECT ... TO anon; GRANT SELECT, INSERT, UPDATE ... TO authenticated`. Every older
  tutorial omits grants, so after **2026-10-30** a tutorial-copied `create table` returns
  `42501`. The GitHub discussion notes the default privileges are GRANT ALL, not just DML,
  and that **views** are also affected
  ([discussion #45329](https://github.com/orgs/supabase/discussions/45329)). A
  [project issue](https://github.com/build-once/team-tasks/issues/130) claims the missing
  grant shows up as empty results, while Supabase says PostgREST errors. *(Conflicting;
  verify in a fake project.)*

### 2c. Where blogs contradict official docs or Postgres

| Claim (source) | Reality | Linter implication |
|---|---|---|
| "UPDATE without WITH CHECK → user_id can be tampered" ([lazydev_oh](https://dev.to/lazydev_oh/supabase-rls-5-common-mistakes-i-broke-and-fixed-myself-38bl)); "Skipping WITH CHECK on writes" ([DesignRevision](https://designrevision.com/blog/supabase-row-level-security)) | Postgres: "if no WITH CHECK expression is defined, then the USING expression will be used both … (WITH CHECK case)" ([CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html)). A USING-only `uid = user_id` UPDATE policy **does** block ownership transfer. | **False-positive trap.** Don't flag UPDATE/ALL policies that lack WITH CHECK when USING contains the ownership predicate. Flag only when WITH CHECK is present but weaker than USING (for example `with check (true)` or bucket-only). |
| "Supabase doesn't have built-in rate limiting for authentication endpoints" ([ModernPentest](https://modernpentest.com/blog/supabase-security-misconfigurations)) | Supabase Auth has configurable rate limits (Authentication → Rate Limits; email limits per hour, OTP and verification limits). CAPTCHA, not rate limiting, is off by default. | Don't encode this. |
| "Don't use RLS … use a backend with the service role" ([Paralect](https://www.paralect.com/stack/dont-use-rls-in-supabase)); "keep logic out of DB functions and policies" ([Lior Amsalem](https://medium.com/@lior_amsalem/3-biggest-mistakes-using-supabase-854fe45712e3)) | The docs make RLS the primary control for any table in an exposed schema. Paralect's quote "do not rely on RLS for filtering but only for security" is from the RLS performance guide and means *add explicit filters*, not *skip RLS*. Their alternative is valid **only if the Data API is disabled** or tables are not granted to anon/authenticated. | A repo following this advice will look like `admin-client-for-user-scoped-work` everywhere. Detect the "Data API disabled / no grants" fact before flagging. Otherwise, recommend keeping RLS as defense in depth. |
| "Namespace channels to prevent cross-tenant subscriptions" (agilesoftlabs) | Channel names are not authorization. Use `private: true` + `realtime.messages` policies ([docs](https://supabase.com/docs/guides/realtime/authorization)). | New `realtime-channel-name-as-authorization`. |
| Realtime plan limits "Pro: 500 concurrent; 2,000 msg/s" (agilesoftlabs) | *(Unverified; check [Realtime limits](https://supabase.com/docs/guides/realtime/limits).)* | Don't hard-code numbers in rule messages. |
| "Use `getSession()` instead of `getUserByCookie`" (summarised advice on [nextjsstarter](https://nextjsstarter.com/blog/supabase-auth-nextjs-integration-simplified/)) | The server should use getClaims or getUser. | Older migration advice actively *introduces* `server-trusts-getsession`. |
| MakerKit puts `security definer` helpers in exposed schemas with no search_path | The docs require `set search_path = ''` and a non-exposed schema ([RLS docs](https://supabase.com/docs/guides/database/postgres/row-level-security)). The Auth Hooks docs go further and **recommend against `security definer`** for hook functions. | Even best-practice posts trip `security-definer-mutable-search-path`, so expect high frequency. |
| "Testing in SQL Editor bypasses RLS" (DesignRevision) | True (it runs as postgres). Studio now has "run as role", but tutorials don't mention it. | Not lintable. Docs-only note. |

---

## 3. Production experience themes

1. **Security misconfiguration dominates, not platform failure.** It is the same three root
   causes (RLS off, permissive policies, service key in the bundle) across
   [CVE-2025-48757](https://www.guardlayer.io/blog/supabase-security-breaches) (303
   endpoints / 170 Lovable apps), the [Symbiotic
   scan](https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws),
   [SupaExplorer Jan 2026](https://supaexplorer.com/cybersecurity-insight-report-january-2026)
   (11% of 20k indie launches expose credentials), and [Vibe-eval Aug
   2026](https://vibe-eval.com/updates/vibe-coding-security-monthly-aug-2026/) (57% of
   3,680 reachable Supabase backends allow unauthenticated reads). These are vendor-run scans
   and the numbers may be inflated. Pentest write-ups add a second tier: exposed RPC helpers,
   SECURITY DEFINER without search_path, `pg_net`/`http` SSRF, Vault grants, long-lived
   signed URLs, MFA `aal1` accepted, and hidden signup endpoints
   ([Pentestly](https://www.pentestly.io/blog/supabase-security-best-practices-2025-guide)).
2. **Connections and pooling.** Serverless with direct `:5432` connections leads to
   exhaustion. ORM defaults ignore serverless concurrency. Prepared statements break on
   `:6543` (prod-only, can silently lose writes). Leaked Realtime channels in SPAs hit the
   concurrent-connection cap and new subscriptions then "silently fail"
   ([axonbuild](https://axonbuild.com/blog/database-connection-pool-exhausted),
   [opsily](https://opsily.com/blog/supabase-connection-pool-exhausted-serverless),
   [agilesoftlabs](https://www.agilesoftlabs.com/blog/2026/05/supabase-realtime-in-production-what)).
   A Micro instance saturates at about 40–50 concurrent connections in one reported MVP
   *(single anecdote)*.
3. **RLS performance at scale.** Unwrapped `auth.uid()`, unindexed policy columns, and
   row-to-membership join direction. Supabase's benchmark went from 178,000 ms to 12 ms
   ([RLS perf guide](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv)).
   Realtime postgres_changes multiplies policy cost per subscriber.
4. **ORMs silently disable RLS.** See `orm-connection-bypasses-rls`. "Teams pick Prisma …
   then wonder why their RLS policies aren't firing" (Khorana). The reverse failure, adding
   policies the app never goes through, gives false assurance in audits.
5. **Migrations and drift.** Dashboard edits make history diverge, so `db push` fails or
   half-applies. `db diff` misses triggers, functions and policies. Declarative sync silently
   drops Studio changes. Buckets and seed DML are never captured
   ([Flavio Copes](https://flaviocopes.com/courses/supabase/version-schema-changes/),
   [Supabase environments blog](https://supabase.com/blog/the-vibe-coders-guide-to-supabase-environments),
   [opsily](https://opsily.com/blog/supabase-database-migrations-staging-to-production)).
   One team wrote its own migration runner because policies drifted
   ([dev.to](https://dev.to/simicdev/supabase-workflows-from-dashboard-to-git-based-development-4080)).
   Val Town (2023) left partly over CLI, migration and local-dev pain, custom roles that the
   migration system couldn't handle, and ORMs (Prisma, Drizzle) lacking RLS and trigger
   support ([Val Town](https://blog.val.town/blog/migrating-from-supabase)).
   **Linter relevance:** policies, grants and buckets created only in the dashboard are
   invisible to static analysis. Surface a "schema facts incomplete" warning when
   migrations contain no RLS statements but the code queries tables.
6. **Auth edge cases.** The default SMTP (2 emails/hour, team-only recipients) silently
   blocks signups at launch. Site URL and redirect allowlist mismatches. PKCE email links
   opened in another browser. Caching an SSR response that refreshed a token means "another
   user will be signed in as the wrong person"
   ([SSR docs](https://supabase.com/docs/guides/auth/server-side/nextjs)). Deleted users
   keep valid JWTs until expiry. Anonymous users hold the `authenticated` role. With
   third-party auth (Clerk, Firebase), `auth.uid()` and FKs to `auth.users` break.
7. **Cost.** Compute is billed **per project** while the plan is per org, so idle staging
   projects bill ("ghost compute", $300 vs an expected $25). Egress at $0.09/GB dominates
   media apps. Disks auto-grow at 90% and don't shrink. Realtime connection and message caps
   force a plan change or self-hosting at about 500+ concurrent connections
   ([makerkit pricing](https://makerkit.dev/blog/saas/supabase-pricing),
   [cloudzero](https://www.cloudzero.com/blog/supabase-pricing/),
   [buildmvpfast](https://www.buildmvpfast.com/blog/supabase-pricing-hidden-costs-scale-alternatives-2026)).
   Linter-relevant items: `count-exact-on-large-table`, unbounded selects, public-bucket
   egress with no CDN or transform caching, and `realtime-unfiltered-postgres-changes-at-scale`.
8. **Vendor reliability and opacity.** Older posts cite auth 500s with no known cause
   ([cellfed, ~2022](https://cellfed.medium.com/why-i-ditched-supabase-and-moved-my-backend-to-firebase-e347408e6a64)),
   nightly backup downtime and disk-full read-only mode (Val Town 2023), and unexplained
   egress spikes plus free-tier pausing
   ([Eliana Jordan](https://elianajourney.substack.com/p/why-i-stopped-using-supabase-for)).
   A recent issue reports 12+ hours down after a compute resize with the API still
   `ACTIVE_HEALTHY` ([supabase#51134](https://github.com/supabase/supabase/issues/51134)).
   Not lintable, but these explain why teams move to self-hosted or other platforms.
9. **"Logic in the database" maintainability debate.** HN and blog critics say RLS and
   functions are hard to debug and test; defenders say app-level checks get forgotten
   ([HN](https://news.ycombinator.com/item?id=36005966)). Supabase's answer is pgTAP tests
   plus advisors. **Linter opportunity:** a missing `supabase/tests/*.sql` (pgTAP) in a
   repo with many policies is an info-level hint (MakerKit and the docs both recommend it).
10. **Leaving at scale is mostly about control.** A fintech moved to Spring Boot for complex
    auth flows and tuning *(snippet-level)*. Typical advice: keep Postgres, swap the layer
    that hurts (Realtime → Ably or self-host; Auth → Clerk via third-party auth).

---

## 4. Official Supabase blog posts and changelog entries to add as knowledge sources

| Date | Title | Why it matters for rules |
|---|---|---|
| 2024-04 (GA week) | [Security Advisor & Performance Advisor](https://supabase.com/blog/security-performance-advisor) | Splinter/index_advisor origin. Baseline for "beyond Splinter" claims. |
| 2024-04 *(approx.)* | [Anonymous Sign-ins](https://supabase.com/blog/anonymous-sign-ins) | `is_anonymous` in policies; restrictive-policy pattern. |
| 2024-08-13 | [Realtime: Broadcast and Presence Authorization](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization) | `private: true`, `realtime.messages` policies, `realtime.topic()`. |
| 2025-07-14 | [Introducing JWT Signing Keys](https://supabase.com/blog/jwt-signing-keys) | Publishable and secret keys, `getClaims`, JWKS, legacy-key timeline (removal late 2026). |
| 2025-07-16 | [Improved Security Controls](https://supabase.com/blog/improved-security-controls) | Private-only Realtime setting; per-rule advisor disabling. |
| 2025-08-16 | [The Vibe Coding Master Checklist](https://supabase.com/blog/the-vibe-coding-master-checklist) | Official checklist (RLS, key exposure, user isolation tests). |
| 2025 *(date unverified)* | [The Vibe Coder's Guide to Supabase Environments](https://supabase.com/blog/the-vibe-coders-guide-to-supabase-environments) | `db diff` to capture dashboard changes; one-way flow. |
| 2026-01-07 | [Supabase Security Retro: 2025](https://supabase.com/blog/supabase-security-2025-retro) | RLS on by default (dashboard), event-trigger RLS enforcement, leaked-key auto-revocation, OpenAPI restricted to publishable keys, pg_graphql off by default (2026), grant toggles. |
| 2026-01-21 | [Postgres Best Practices for AI Agents](https://supabase.com/blog/postgres-best-practices-for-ai-agents) | 8-category rule set (query perf, connections, RLS, schema, locking…). Possible overlap or alignment target for our SQL rules. |
| 2026-04-09 | [AI Agents Know About Supabase. They Don't Always Use It Right.](https://supabase.com/blog/supabase-agent-skills) | Short canonical "mistakes" list: user_metadata, NEXT_PUBLIC_ service key, views and security_invoker, UPDATE needs SELECT, storage upsert needs INSERT+SELECT+UPDATE, **deleted user's JWT still valid**. Hallucinated CLI commands (`supabase db execute`). |
| 2026-04-28 | [Changelog: Tables not exposed to Data and GraphQL API automatically](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) | The **2026-10-30** enforcement; `auto_expose_new_tables = false` (CLI ≥ 2.102.0). |
| 2026-05 | [Developer Update May 2026](https://supabase.com/changelog/45702-developer-update-may-2026) | Per-table and per-function Data API toggles. |
| 2026-05-06 | [Introducing @supabase/server](https://supabase.com/blog/introducing-supabase-server) | `withSupabase({auth: 'user' \| 'secret' \| 'publishable' \| 'none'})`. Must count as correct EF auth. `verify_jwt=false` required for non-user modes; built-in verify_jwt doesn't understand new keys. |
| older | [Realtime Postgres RLS](https://supabase.com/blog/realtime-row-level-security-in-postgresql) (2021) | Policy cost per change per subscriber. |
| live docs | [RLS performance and best practices](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv), [Custom claims & RBAC](https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac), [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks), [Migrating to new API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys), [Third-party auth](https://supabase.com/docs/guides/auth/third-party/overview) | Primary references for several rules. The Auth Hooks docs say to revoke EXECUTE from `authenticated, anon, public` and avoid `security definer`, which gives a deterministic check for hook functions. |

Also worth tracking as **official code that ships patterns we flag** (to agree on with the
owning teams before the linter fires on them):
- The quickstart avatar policies (T1).
- The UI-library realtime chat block (T4).
- Vercel's `with-supabase` confirm route (T2, maintained by Vercel and Supabase).

---

## Unverified or low-confidence items

- Video-only content in T10/T12 (dashboard policies) was not seen.
- DZone quickstart ("anyone can upload avatars"; 403) and the bombillazo Medium post (403)
  are known from search snippets only.
- Exploitability of the storage UPDATE policy without `bucket_id` in USING (T1), and of
  `x-forwarded-host` trust (T3), depends on the platform.
- The cross-request session leak in Astro's module-scope client + `setSession` (T5) is
  inferred, not reproduced.
- Realtime plan limits quoted by third-party blogs, and the "empty result vs 42501" behaviour
  after 2026-10-30, are both conflicting.
- Several dates (Mobisoft, kanta13jp1, the environments blog post) are approximate.
