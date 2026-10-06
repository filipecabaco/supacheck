# Supabase Auth, SSR, API key and client-setup anti-patterns (supabase-js, JS/TS)

Research catalogue for the Laya-based static linter. It covers supabase-js v2, `@supabase/ssr`, the deprecated `@supabase/auth-helpers-*` packages, Next.js (App and Pages Router), SvelteKit, Remix, Astro, Expo/React Native, and Node/Express.

**How it was gathered:** Supabase docs were fetched directly. GitHub signal (comments and reactions) was pulled with `gh api` on 2026-10-05, using the format `c=` comments, `r=` reactions, `up=` discussion upvotes. Web searches covered blogs and security write-ups.

**Gaps:**
- **Reddit:** the fetcher is blocked from reddit.com, so there is no Reddit evidence.
- **Stack Overflow:** searches returned GitHub and docs results instead of SO threads, so SO evidence is thin. Treat frequency mostly as GitHub, docs, blogs, and AI-codegen postmortems.
- **Remix and Astro:** I did not verify their specifics separately. They use the same `createServerClient` patterns as Next.js and SvelteKit.

**Severity scale:** S = security, D = data loss, P = performance, C = correctness. Ranking is severity × frequency, highest first.

---

## 1. `service-role-key-in-client-bundle`
**Title:** Service role or secret key reachable from browser or mobile code

- **What goes wrong:** The legacy `service_role` JWT (or the new `sb_secret_...` key) is shipped to the client. Common routes:
  - a `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` or `EXPO_PUBLIC_` env var;
  - a hard-coded string;
  - a shared module that exports both the browser client and the admin client, which pulls the admin client into the client bundle through the import graph.
  The service role bypasses RLS, so anyone can read, write or delete everything, including `auth.admin`. A typical cause is someone swapping in the privileged key "to make the RLS error go away."
- **Impact:** S, D. Critical.
- **Evidence:**
  - CVE-2025-48757 / Lovable postmortems: 170 of 1,645 scanned apps exposed. Some had the service_role key in the bundle on top of missing RLS. https://www.bleek.dev/cve-2025-48757 , https://vibeappscanner.com/lovable-supabase-security
  - https://dev.to/cekuu35/your-supabase-servicerole-key-is-probably-in-your-browser-bundle-4j49
  - Example real-repo bug reports: https://github.com/itanne99/teachy-time/issues/129 (`NEXT_PUBLIC_` service key) and https://github.com/stellar-creator-portfolio/stellar-creator-portfolio-/issues/48 (shared import pulls in the admin client).
  - Discussions where users reach for service_role to get past RLS: https://github.com/orgs/supabase/discussions/7586 (c=4), https://github.com/orgs/supabase/discussions/34958
- **Official guidance:**
  - https://supabase.com/docs/guides/api/api-keys : secret keys must never "be embedded in browsers or shipped applications". When a secret key reaches a browser, "Supabase matches on the `User-Agent` header and returns HTTP 401 Unauthorized." That check covers only the new `sb_secret_` keys. A legacy `service_role` JWT is not blocked.
  - https://supabase.com/docs/guides/database/postgres/row-level-security : "Never use a secret key in the browser or expose it to customers."
- **BAD:**
```ts
// lib/supabase.ts  (imported by client components)
export const supabase = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!)
export const supabaseAdmin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!) // same module as browser client
```
- **GOOD:**
```ts
// lib/supabase/admin.ts
import 'server-only'
import { createClient } from '@supabase/supabase-js'
export const createAdminClient = () =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
```
- **Detection:**
  - Deterministic:
    - regex on env names matching `(NEXT_PUBLIC|VITE|PUBLIC|EXPO_PUBLIC|REACT_APP)_.*(SERVICE_ROLE|SECRET)`;
    - string literals `sb_secret_[A-Za-z0-9_-]+`;
    - a JWT literal whose payload decodes to `"role":"service_role"`.
  - Cross-file: does a module that reads a non-public secret env get imported, transitively, by a `'use client'` file, a `.svelte`/`+page.ts` universal load, or an Expo app? Facts needed are the import graph, client/server boundary markers, and whether `server-only` is present.
  - Semantic, good for the classifier: a key variable whose name looks harmless but is used in client code.
- **Versions:** All. The `sb_secret_` 401 browser check applies only to the new API keys. Legacy keys are being deprecated by end of 2026.

## 2. `server-trusts-getsession`
**Title:** Authorization on the server based on `getSession()` (or `session.user`) instead of `getClaims()`/`getUser()`

- **What goes wrong:** On the server, `getSession()` reads the session straight from request cookies without verifying it. An attacker can forge the cookie and be treated as any user in middleware/proxy, Server Components, Route Handlers, SvelteKit hooks and load functions, or Remix loaders. The user id from that unverified session then drives service-role queries, redirects, or rendering.
- **Impact:** S. High.
- **Evidence:**
  - https://github.com/supabase/auth-js/issues/873 "Can't get rid of getUser() warning" (c=122, r=89)
  - https://github.com/supabase/supabase-js/issues/1709 (c=117, r=35, open)
  - https://github.com/supabase/supabase-js/issues/1703 (c=22, r=68)
  - https://github.com/orgs/supabase/discussions/23224 "SSR attack vector… when using session from getSession()" (c=13, up=14)
  - https://github.com/orgs/supabase/discussions/22353 (SvelteKit)
  - https://github.com/vercel/nextjs-subscription-payments/issues/343
  - The very large warning-thread volume shows how much `getSession()` is still used on servers.
- **Official guidance:**
  - https://supabase.com/docs/guides/auth/server-side/nextjs : "*Never* trust `supabase.auth.getSession()` inside server code such as Proxy. It reads the session out of the cookie without revalidating it." and "Anyone can forge the session cookie, so trusting it without verification lets an attacker render another user's page. Always use `supabase.auth.getClaims()` to protect pages and user data."
  - https://supabase.com/docs/reference/javascript/auth-getsession : "If that storage is based on request cookies for example, the values in it may not be authentic and therefore it's strongly advised against using this method…"
- **BAD:**
```ts
// app/dashboard/page.tsx (Server Component)
const supabase = await createClient()
const { data: { session } } = await supabase.auth.getSession()
if (!session) redirect('/login')
const { data } = await admin.from('invoices').select().eq('user_id', session.user.id)
```
- **GOOD:**
```ts
const supabase = await createClient()
const { data, error } = await supabase.auth.getClaims()
if (error || !data?.claims) redirect('/login')
const userId = data.claims.sub
```
- **Detection:**
  - Deterministic: a `auth.getSession()` call in a server context, meaning:
    - `middleware.ts` or `proxy.ts`;
    - `app/**/page|layout|route.ts(x)` without `'use client'`;
    - `'use server'` files;
    - `hooks.server.ts`, `+page.server.ts`, `+layout.server.ts`, `+server.ts`;
    - Remix `loader`/`action`;
    - Astro frontmatter;
    - Express handlers.
  - Semantic: whether the result is used for an auth decision (a redirect, building a query filter, passing to an admin client) or only to read `access_token` and forward it. The second is legitimate.
  - Exception: the SvelteKit `safeGetSession` pattern (getSession followed by getUser) is fine.
- **Versions:** supabase-js ≥ 2.x. The warning has been emitted since about auth-js 2.6x (2024). `getClaims()` arrived in 2025, and verifies locally only on projects with asymmetric JWT signing keys, which are the default for projects created after 2025-05-01.

## 3. `jwt-decode-without-verification`
**Title:** Backend trusts `sub` from a decoded-but-unverified Supabase access token

- **What goes wrong:** Express, Edge Function or API route code takes a user id from `jwt.decode()`, `jwtDecode()`, or `JSON.parse(atob(token.split('.')[1]))`, and never checks the signature.
- **Impact:** S. Critical: full impersonation.
- **Evidence:**
  - https://github.com/orgs/supabase/discussions/20763 , https://github.com/orgs/supabase/discussions/34196 , https://github.com/orgs/supabase/discussions/21907
  - CodeQL ships a rule for decoding a JWT without verification: https://github.com/github/codeql/pull/14088
  - Frequency on Supabase specifically is moderate. I did not count individual occurrences.
- **Official guidance:** https://supabase.com/docs/guides/auth/jwts and https://supabase.com/docs/reference/javascript/auth-getclaims . The docs say to avoid implementing the algorithms yourself and to "rely on `supabase.auth.getClaims()`, or other high-quality JWT verification libraries". For legacy HS256 projects they recommend verifying with the Auth server (`getUser(token)`).
- **BAD:**
```ts
import { jwtDecode } from 'jwt-decode'
app.use((req, _res, next) => {
  const token = req.headers.authorization!.slice(7)
  req.userId = jwtDecode<{ sub: string }>(token).sub
  next()
})
```
- **GOOD:**
```ts
app.use(async (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  const { data, error } = await supabase.auth.getClaims(token)
  if (error || !data) return res.status(401).end()
  req.userId = data.claims.sub
  next()
})
```
- **Detection:**
  - Deterministic: an import of `jwt-decode`, `jsonwebtoken.decode`, `jose.decodeJwt`, or `atob(...split('.')[1])` applied to an Authorization header or a Supabase token, with no `verify`, `jwtVerify`, `getClaims` or `getUser` in the same handler.
  - Semantic: whether the decoded value drives authorization.
- **Versions:** All.

## 4. `user-metadata-for-authorization`
**Title:** Roles or permissions read from `user_metadata` (`raw_user_meta_data`)

- **What goes wrong:** `user.user_metadata.role === 'admin'`, or signUp `options.data: { role }`, is used to gate features or seed profile roles. Any user can call `supabase.auth.updateUser({ data: { role: 'admin' } })`, including at signup.
- **Impact:** S. Privilege escalation.
- **Evidence:**
  - Supabase's own database linter (splinter) has a dedicated rule for it: https://supabase.github.io/splinter/0015_rls_references_user_metadata/
  - https://github.com/orgs/supabase/discussions/13091
  - https://makerkit.dev/blog/tutorials/supabase-rls-best-practices
  - https://github.com/orgs/supabase/discussions/13890 (community expert: "user metadata is not secure. The user can change it at anytime")
- **Official guidance:** https://supabase.com/docs/guides/database/postgres/row-level-security : "raw_user_meta_data - can be updated by the authenticated user using the `supabase.auth.update()` function. It is not a good place to store authorization data." Use `app_metadata`, a roles table, or a custom access token hook instead.
- **BAD:**
```ts
await supabase.auth.signUp({ email, password, options: { data: { role: 'admin' } } })
// …
const { data: { user } } = await supabase.auth.getUser()
if (user?.user_metadata.role === 'admin') return adminPanel()
```
- **GOOD:**
```ts
const { data } = await supabase.auth.getClaims()
if (data?.claims.app_metadata?.role === 'admin') return adminPanel()
// or: query a roles table protected by RLS
```
- **Detection:**
  - Deterministic: regex `user_metadata\??\.(role|is_admin|admin|plan|tier|permissions|org)` used in a conditional, and `signUp(...options.data` containing role-like keys.
  - Semantic: whether the field is security-relevant (`display_name` is fine).
  - Cross-file: SQL migrations that reference `raw_user_meta_data ->> 'role'` in triggers or policies. This overlaps with the SQL/RLS area.
- **Versions:** All.

## 5. `module-scope-server-client`
**Title:** User-scoped server client created once at module scope and shared across requests

- **What goes wrong:** On long-lived or warm serverless instances (for example Vercel Fluid compute or Express), a module-level `createClient`/`createServerClient` keeps the session in memory. `signInWithPassword`, `setSession` or cookies from one request rewrite the shared client's `Authorization` header. The next user's request then runs as the previous user. A related failure: logout revokes the wrong user, or the shared refresh loop consumes a user's refresh token (`refresh_token_already_used`).
- **Impact:** S. Session cross-talk.
- **Evidence:**
  - https://github.com/afterclass-io/afterclass.io/issues/566
  - https://github.com/kcrsromero-cmyk/Contrato-Cla/pull/133
  - https://github.com/lagarcess/argus/pull/728
  - https://github.com/pawtograder/platform/pull/984 (the variant where per-request plain `createClient` leaks an auto-refresh `setInterval` and caused an OOM at about 18h)
  - Moderate frequency. The fixes are spread across many small repos.
- **Official guidance:** https://supabase.com/docs/guides/auth/server-side/advanced-guide : "Always initialize the Supabase client inside the request handler, not at module level. Do not store the client or any user-specific state in a variable that persists between requests." The Next.js guide adds: "With Fluid compute, don't put this client in a global environment variable. Always create a new one on each request."
- **BAD:**
```ts
// server/supabase.ts
export const supabase = createClient(url, key) // module scope, used by all requests
app.post('/login', async (req, res) => {
  const { data } = await supabase.auth.signInWithPassword(req.body) // mutates shared client
  res.json(data)
})
```
- **GOOD:**
```ts
app.post('/login', async (req, res) => {
  const supabase = createServerClient(url, key, { cookies: cookieAdapter(req, res) }) // per request
  const { data, error } = await supabase.auth.signInWithPassword(req.body)
  res.status(error ? 401 : 200).json(data)
})
```
- **Detection:**
  - Deterministic: a top-level `const x = createClient(...)` or `createServerClient(...)` in a server-only file, combined with calls in handlers to `x.auth.signIn*`, `setSession`, `exchangeCodeForSession`, `verifyOtp`, `signOut`, or passing user `Authorization` headers.
  - Semantic or cross-file: whether the file runs on the server (Express, `route.ts`, `hooks.server.ts`) and whether the client is user-scoped or an admin client used only with `persistSession: false`.
  - Browser singletons are correct, so the server/client context fact is essential to avoid false positives.
- **Versions:** All. Risk is higher on Vercel Fluid compute and Node servers.

## 6. `auth-response-cacheable`
**Title:** Responses carrying refreshed Supabase `Set-Cookie` headers can be cached (ISR, static rendering, CDN)

- **What goes wrong:** A page or route that triggers a session refresh is statically rendered, uses ISR, or is cached by a CDN. The cached `Set-Cookie` holding user A's JWT is served to user B, who becomes user A.
- **Impact:** S. Account takeover.
- **Evidence:**
  - Supabase docs say they "received reports of user metadata being cached across unique anonymous users as a result of Next.js static page rendering" (https://supabase.com/docs/guides/auth/auth-anonymous).
  - The same class of bug hit Auth0's Next.js SDK: https://github.com/auth0/nextjs-auth0/issues/2100
  - Direct Supabase GitHub reports are sparse. Mark as **severity high, frequency medium, partly unverified**.
- **Official guidance:** https://supabase.com/docs/guides/auth/server-side/advanced-guide : "If your CDN (e.g. Vercel Edge, Cloudflare) caches that response and serves it to a different user, that user's browser will store the cached token and be signed in as the wrong person." The Next.js guide says the `setAll` headers "must be applied to the HTTP response to prevent CDNs from caching the response and leaking the session to other users."
- **BAD:**
```ts
export const revalidate = 3600 // ISR
export default async function Page() {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims() // may refresh and set cookies
  return <Profile id={data?.claims.sub} />
}
```
- **GOOD:**
```ts
export const dynamic = 'force-dynamic'
// proxy.ts: copy cache headers from setAll onto the response
setAll(cookiesToSet, headers) {
  cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
  Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v))
}
```
- **Detection:**
  - Deterministic: in a file that calls `auth.getClaims/getUser/getSession`, look for `export const revalidate = <number>`, `export const dynamic = 'force-static'`, `'use cache'`, or `unstable_cache` wrapping an authed Supabase client.
  - Deterministic: a `setAll` implementation that ignores its second `headers` argument (new `@supabase/ssr` versions).
  - Cross-file: CDN config such as `vercel.json` headers or `Cache-Control: s-maxage` on authed routes.
- **Versions:** `@supabase/ssr` versions whose `setAll(cookies, headers)` passes cache headers (2025+). Applies to Next.js App Router, especially `'use cache'` in Next 16.

## 7. `ssr-client-with-service-role` (also covers `auth-calls-on-admin-client`)
**Title:** Service-role key used with a cookie-aware SSR client, or a user session attached to the admin client

- **What goes wrong:** `createServerClient(url, SERVICE_ROLE_KEY, { cookies })` reads the user's cookie session, which overrides `Authorization`, so RLS still applies and queries silently return `[]` or RLS errors. The same happens when the code:
  - calls `signUp` or `signInWithPassword` on the admin client;
  - calls `setSession` on the admin client;
  - sets `global.headers.Authorization` to the user's JWT on the admin client.
  A common next step is then disabling RLS, which leads to item 1.
- **Impact:** C, and indirectly S.
- **Evidence:**
  - https://github.com/supabase/auth/issues/965 (c=10, r=8)
  - https://github.com/orgs/supabase/discussions/30146 (up=4)
  - https://github.com/orgs/supabase/discussions/30739
  - https://github.com/orgs/supabase/discussions/7586
  - https://github.com/orgs/supabase/discussions/34958
  - There is a dedicated troubleshooting page (below), which suggests it is frequent.
- **Official guidance:** https://supabase.com/docs/guides/troubleshooting/why-is-my-service-role-key-client-getting-rls-errors-or-not-returning-data-7_1K9z : "The SSR clients are designed to share the user session from cookies. The user session will override the default `apikey`", "RLS in enforced based on the `Authorization` header and not the `apikey` header.", "If you are wanting to create a user in a service role client use `admin.createUser()` instead."
- **BAD:**
```ts
const admin = createServerClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
})
await admin.from('orders').select() // runs as the logged-in user, not service_role
```
- **GOOD:**
```ts
import { createClient } from '@supabase/supabase-js'
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
```
- **Detection:**
  - Deterministic:
    - `createServerClient` or `createBrowserClient` whose key argument refers to a `SERVICE_ROLE` or `SECRET` env var;
    - a client built with a service or secret key that later calls `auth.signUp`, `signInWith*` or `setSession`;
    - `global.headers.Authorization` set on a client built with a secret key.
  - Cross-file: resolve which client factory is imported where.
- **Versions:** `@supabase/ssr` all versions, and auth-helpers.

## 8. `onauthstatechange-async-deadlock`
**Title:** Awaiting Supabase calls inside the `onAuthStateChange` callback

- **What goes wrong:** The callback runs while auth-js holds its internal lock and waits for every listener. An awaited `supabase.from(...)`, `getUser()`, `getSession()` or `updateUser()` inside the callback queues on the same lock. Every later Supabase call hangs, typically after `INITIAL_SESSION` on reload or after `TOKEN_REFRESHED`. Users experience "app hangs after login" or "infinite spinner after relaunch."
- **Impact:** C. High frequency, especially in AI-generated code (Lovable, Dyad, v0).
- **Evidence:**
  - https://github.com/supabase/auth-js/issues/762 (c=44, r=21, open)
  - https://github.com/supabase/supabase-js/issues/1441 "setSession and updateUser do not resolve" (c=17)
  - https://github.com/supabase/supabase-js/issues/1401 (Expo Web)
  - https://github.com/orgs/supabase/discussions/19058
  - https://github.com/dyad-sh/dyad/issues/1364
  - https://tomaspozo.com/articles/series-lovable-supabase-errors-application-hangs-up-after-log-in
  - Related lock-infinite-timeout bug: https://github.com/supabase/supabase-js/issues/1594 (c=13, r=10)
- **Official guidance:** https://supabase.com/docs/reference/javascript/auth-onauthstatechange . The wording below is quoted via secondary sources, and the live page excerpt I fetched no longer showed it: "A callback can be an async function and it runs synchronously during the processing of the changes causing the event. You can easily create a dead-lock by using await on a call to another method of the Supabase library." The docs recommended dispatching the work with `setTimeout(..., 0)`.
- **BAD:**
```ts
supabase.auth.onAuthStateChange(async (event, session) => {
  if (session) {
    const { data } = await supabase.from('profiles').select().eq('id', session.user.id).single()
    setProfile(data)
  }
})
```
- **GOOD:**
```ts
supabase.auth.onAuthStateChange((event, session) => {
  setSession(session)
  if (session) setTimeout(() => void loadProfile(session.user.id), 0) // runs after lock release
})
```
- **Detection:**
  - Deterministic (AST): the callback passed to `.auth.onAuthStateChange` is `async` and contains an `await` on an expression rooted at a Supabase client: `.from(`, `.rpc(`, `.auth.*`, `.storage`, `.functions.invoke`.
  - Semantic: an `await` on a wrapper function that internally calls Supabase. Cross-file resolution helps here.
- **Versions:** supabase-js v2, browser and React Native. Still present in 2.9x per community reports.

## 9. `ssr-cookie-adapter-broken`
**Title:** Middleware or server client that cannot persist refreshed cookies (missing `setAll`, deprecated `get/set/remove`, returning a fresh `NextResponse`)

- **What goes wrong:** The session refresh writes new cookies, but the adapter drops them. The causes are:
  - `setAll` omitted or a no-op in middleware;
  - the legacy `get/set/remove` API, which rebuilds the response per cookie and drops chunked cookies;
  - middleware returning `NextResponse.next()` or `redirect()` instead of the `supabaseResponse` that `setAll` built, without copying its cookies.
  The result is random logouts, `refresh_token_already_used`, and stale cookies.
- **Impact:** C. Very frequent.
- **Evidence:**
  - https://github.com/supabase/ssr/issues/36 "Cookies not setting properly" (c=45, r=22)
  - https://github.com/supabase/supabase/issues/18981 (c=23)
  - https://github.com/supabase/auth/issues/2136
  - https://github.com/supabase/supabase/issues/29910 (even the docs used the deprecated functions)
  - https://github.com/prabhatia/boss-web/pull/9 (chunked-cookie drop)
- **Official guidance:**
  - https://supabase.com/docs/guides/auth/server-side/nextjs : "Return the `supabaseResponse` object that `setAll` last built. An earlier response doesn't carry the refreshed cookies, so the user is signed out on the next request."
  - The `@supabase/ssr` source warns: "createServerClient was configured without the setAll cookie method, but the client needs to set cookies. This can lead to issues such as random logouts, early session termination…" and "Consider switching to the getAll and setAll cookie methods instead of get, set and remove which are deprecated".
  - Supabase's AI prompt (https://supabase.com/docs/guides/getting-started/ai-prompts/nextjs-supabase-auth) says to use ONLY `getAll` and `setAll` and never `get`, `set` or `remove`.
- **BAD:**
```ts
export async function middleware(req: NextRequest) {
  const res = NextResponse.next()
  const supabase = createServerClient(url, key, {
    cookies: {
      get: (n) => req.cookies.get(n)?.value,
      set: (n, v, o) => res.cookies.set({ name: n, value: v, ...o }),
      remove: (n, o) => res.cookies.set({ name: n, value: '', ...o }),
    },
  })
  await supabase.auth.getUser()
  return NextResponse.next() // drops refreshed cookies
}
```
- **GOOD:**
```ts
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options))
        Object.entries(headers ?? {}).forEach(([k, v]) => supabaseResponse.headers.set(k, v))
      },
    },
  })
  await supabase.auth.getClaims()
  return supabaseResponse
}
```
- **Detection:**
  - Deterministic:
    - a `cookies` option with `get`/`set`/`remove` keys;
    - a `cookies` option with `getAll` but no `setAll` in middleware, proxy or route handler;
    - a middleware function whose return value is a new `NextResponse.*` other than the variable reassigned inside `setAll`, with no `cookies.setAll(supabaseResponse.cookies.getAll())` copy.
  - Note: a no-op or try/catch `setAll` in a Server Component client is the documented pattern, so it is not a violation.
  - Semantic: custom redirect branches.
- **Versions:** `@supabase/ssr` ≥ 0.4 (getAll/setAll introduced; get/set/remove deprecated, to be removed at 1.0). The `setAll(…, headers)` second argument exists in newer versions.

## 10. `middleware-session-refresh-missing`
**Title:** No session refresh at the request boundary, or logic placed between `createServerClient` and the refresh call

- **What goes wrong:** Server Components cannot write cookies, so tokens expire unless middleware/proxy refreshes them. Failure modes:
  - no middleware at all;
  - `proxy.ts` on Next ≤15 or `middleware.ts` on Next 16 (the file never runs);
  - the file is at the wrong level in a `src/` layout;
  - the matcher excludes app routes;
  - code (early returns, other awaits) runs between `createServerClient` and `getClaims()`/`getUser()`.
- **Impact:** C. Random logouts, and a perceived cause of item 2 when people fall back to `getSession()`.
- **Evidence:**
  - https://github.com/orgs/supabase/discussions/26757
  - https://github.com/supabase/supabase/issues/30241
  - https://github.com/dikuwa/scolapro/pull/467 , https://github.com/gabrielbalenton/ai-unity/pull/46 (Next 16 rename)
  - https://github.com/orgs/supabase/discussions/21468 (up=6)
- **Official guidance:**
  - The official template comment: "Do not run code between createServerClient and supabase.auth.getUser(). A simple mistake could make it very hard to debug issues with users being randomly logged out."
  - https://supabase.com/docs/guides/auth/server-side/creating-a-client : before Next 16 the file is `middleware.ts`, and from 16 it is `proxy.ts`.
- **BAD:**
```ts
const supabase = createServerClient(/* … */)
if (request.nextUrl.pathname.startsWith('/public')) return NextResponse.next() // before refresh
const { data } = await supabase.auth.getUser()
```
- **GOOD:**
```ts
const supabase = createServerClient(/* … */)
const { data } = await supabase.auth.getClaims() // immediately
if (!data?.claims && request.nextUrl.pathname.startsWith('/app')) { /* redirect, copying cookies */ }
return supabaseResponse
```
- **Detection:**
  - Deterministic (AST): statements other than declarations between `createServerClient(...)` and the first `auth.getClaims|getUser` call in middleware/proxy.
  - Cross-file: the Next.js version from `package.json` versus the file name `middleware.ts`/`proxy.ts` and the export name; `src/app` versus the location of the root file; whether a Supabase SSR server client exists without any middleware/proxy.
- **Versions:** Next.js 13.4–16 with `@supabase/ssr`. Equivalent for SvelteKit `hooks.server.ts`.

## 11. `deprecated-auth-helpers`
**Title:** Using `@supabase/auth-helpers-*`, or mixing it with `@supabase/ssr`

- **What goes wrong:** The packages are deprecated and frozen (auth-helpers-nextjs 0.15.0 is the "FINAL version"). Mixing them with `@supabase/ssr` or plain supabase-js causes PKCE verifier and cookie mismatches ("code verifier not found"). The old SvelteKit helper's `getSession` was unverified, which leads to item 2.
- **Impact:** C, S.
- **Evidence:**
  - https://github.com/orgs/supabase/discussions/27849 (up=15)
  - https://github.com/supabase/auth-helpers (archived, "now deprecated")
  - The npm deprecation notice for `@supabase/auth-helpers-nextjs`
  - Mixing causes verifier errors: https://github.com/supabase/auth-helpers/issues/545 (repo archived, so counts are unavailable)
- **Official guidance:** https://supabase.com/docs/guides/auth/server-side/migrating-to-ssr-from-auth-helpers : the auth-helpers are deprecated and replaced with `@supabase/ssr`. "It's important that you don't use both auth-helpers-nextjs and @supabase/ssr packages in the same application to avoid running into authentication issues."
- **BAD:**
```ts
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs'
const supabase = createServerComponentClient({ cookies })
```
- **GOOD:**
```ts
import { createServerClient } from '@supabase/ssr'
const cookieStore = await cookies()
const supabase = createServerClient(url, key, {
  cookies: { getAll: () => cookieStore.getAll(), setAll: (c) => { try { c.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } catch {} } },
})
```
- **Detection:** Fully deterministic. Look for imports from `@supabase/auth-helpers-(nextjs|react|sveltekit|remix|shared)`, the `createClientComponentClient`, `createServerComponentClient`, `createRouteHandlerClient`, `createMiddlewareClient` and `createPagesServerClient` identifiers, and `package.json` deps. Mixing is cross-file: both packages present.
- **Versions:** auth-helpers (all). `@supabase/ssr` ≥ 0.1 is the replacement.

## 12. `plain-client-in-ssr`
**Title:** Plain `createClient` (localStorage session) used in SSR frameworks for user-authenticated server code

- **What goes wrong:** Plain `@supabase/supabase-js` `createClient` stores the session in localStorage, which the server cannot see. Server Components, Route Handlers and loaders get `AuthSessionMissingError` and queries run as anon. PKCE exchange on the server finds no verifier. People then reach for the service key or hand-roll cookie parsing.
- **Impact:** C, and indirectly S.
- **Evidence:**
  - https://github.com/orgs/supabase/discussions/26791 (c=19, up=7)
  - https://github.com/orgs/supabase/discussions/28914
  - https://github.com/supabase/ssr/issues/107 (c=4, r=4)
  - https://github.com/supabase/supabase-js/issues/992 (c=31)
  - https://github.com/orgs/supabase/discussions/28997
- **Official guidance:** https://supabase.com/docs/guides/auth/server-side : local storage isn't accessible by the server, so for SSR the tokens need to be stored in a secure cookie. `createBrowserClient` and `createServerClient` always store the session in cookies.
- **BAD:**
```ts
// app/account/page.tsx (server)
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(url, anonKey)
const { data: { user } } = await supabase.auth.getUser() // always null
```
- **GOOD:** Use the per-request `createServerClient` helper from item 11, and `createBrowserClient` in client components.
- **Detection:**
  - Cross-file: the project uses Next.js, SvelteKit, Remix, Astro or Nuxt, and a server-context file imports `createClient` from `@supabase/supabase-js` with a publishable or anon key, and calls `auth.getUser/getClaims/getSession` or relies on RLS-as-user.
  - Admin clients built with a secret key and plain `createClient` are correct.
  - Also deterministic: `@supabase/ssr` client options passing `auth.storage`, which is ignored.
- **Versions:** All SSR frameworks.

## 13. `onauthstatechange-unsubscribed` / `client-per-render`
**Title:** Browser client created inside components, or auth listener never unsubscribed

- **What goes wrong:** `createClient()` called in a component body or hook triggers the warning "Multiple GoTrueClient instances detected… may produce undefined behavior when used concurrently under the same storage key". Concurrent refreshes race and can contribute to hangs and lock contention. A missing `subscription.unsubscribe()` stacks listeners on every remount.
- **Impact:** C, P.
- **Evidence:**
  - https://github.com/supabase/auth-js/issues/725
  - https://github.com/supabase/supabase-js/issues/1394
  - https://github.com/orgs/supabase/discussions/37755
  - https://community.vercel.com/t/multiple-gotrueclient-instances-detected-in-the-same-browser-context/32990
  - https://community.vercel.com/t/warning-wont-go-away-multiple-gotrueclient-instances-detected/15340
  - Caveat: maintainers often call the warning benign. Medium confidence on impact.
- **Official guidance:** Supabase's React quickstart (https://supabase.com/docs/guides/auth/quickstarts/react) uses a module-level client and returns `() => subscription.unsubscribe()` from `useEffect`. `createBrowserClient` is a singleton by default.
- **BAD:**
```tsx
function Nav() {
  const supabase = createClient(url, key)
  useEffect(() => { supabase.auth.onAuthStateChange((_e, s) => setSession(s)) }, [supabase])
}
```
- **GOOD:**
```tsx
// lib/supabase.ts: export const supabase = createBrowserClient(url, key)
useEffect(() => {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
  return () => subscription.unsubscribe()
}, [])
```
- **Detection:** Deterministic (AST):
  - `createClient` or `createBrowserClient` called inside a function component or hook body without `useMemo`/`useState` init;
  - an `onAuthStateChange` call inside `useEffect` whose return value is not unsubscribed in the cleanup.
- **Versions:** supabase-js v2 (browser, React, React Native).

## 14. `pkce-email-link-misconfig`
**Title:** SSR app uses the default `{{ .ConfirmationURL }}` / PKCE link and expects it to work cross-device, or has no server exchange route

- **What goes wrong:** With PKCE (the default in `@supabase/ssr`), the code verifier lives in the initiating browser. Links opened in another browser, a webview or on mobile fail with "PKCE code verifier not found in storage". A missing `/auth/callback` or `/auth/confirm` route handler, or a `page.tsx` used instead of `route.ts`, also breaks the flow.
- **Impact:** C. Signup, magic-link and password-reset failures.
- **Evidence:**
  - https://github.com/supabase/auth-helpers/issues/545
  - https://github.com/supabase/ssr/issues/21
  - https://github.com/supabase/supabase-js/issues/1686
  - https://github.com/supabase/supabase-js/issues/1704
  - https://github.com/supabase/supabase-js/pull/1931 (new explicit error message)
  - https://github.com/orgs/supabase/discussions/26791 (the page.tsx-vs-route.ts callback case)
- **Official guidance:**
  - https://supabase.com/docs/guides/auth/sessions/pkce-flow : "The code exchange must be initiated on the same browser and device where the flow was started." and "the code has a validity of 5 minutes and can only be exchanged for an access token once."
  - The SSR guide (https://supabase.com/docs/guides/auth/server-side/email-based-auth-with-pkce-flow-for-ssr) says to change the template to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` and call `verifyOtp`.
- **BAD:**
```ts
// app/auth/confirm/page.tsx  ('use client')
useEffect(() => { supabase.auth.exchangeCodeForSession(params.code) }, []) // browser-only, cross-device fails
```
- **GOOD:**
```ts
// app/auth/confirm/route.ts
export async function GET(req: NextRequest) {
  const token_hash = req.nextUrl.searchParams.get('token_hash')
  const type = req.nextUrl.searchParams.get('type') as EmailOtpType | null
  if (token_hash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })
    if (!error) redirect('/')
  }
  redirect('/error')
}
```
- **Detection:**
  - Mostly cross-file or config: `signInWithOtp`, `signUp` or `resetPasswordForEmail` with `emailRedirectTo`, but no route handler that calls `exchangeCodeForSession` or `verifyOtp`.
  - `exchangeCodeForSession` in a `'use client'` file within an SSR app.
  - Email templates live in the dashboard or `supabase/config.toml` / `supabase/templates/*.html`, which can be linted for `ConfirmationURL`.
  - Semantic: `verifyOtp` with `type: 'magiclink'` for a token_hash link (should be `type: 'email'`).
- **Versions:** `@supabase/ssr` (PKCE default), supabase-js with `flowType: 'pkce'`.

## 15. `auth-callback-open-redirect`
**Title:** Unvalidated `next`/`redirect_to` query param in the auth callback

- **What goes wrong:** `NextResponse.redirect(next)` or `${origin}${next}` without validation. `next=@evil.com` resolves to `https://app.com@evil.com`, and `//evil.com` is protocol-relative. The result is phishing right after a real login on your domain. Supabase's Redirect URLs allowlist does not cover your own `next` param. Trusting a client-supplied `x-forwarded-host` is a related risk.
- **Impact:** S. Medium.
- **Evidence:** Unverified as a reported incident. I found no Supabase CVE or issue. The vulnerable pattern is widespread in tutorials (https://dev.to/thatanjan/how-to-add-github-oauth-in-nextjs-with-supabase-auth-login-with-github-oko , https://github.com/SamuelSackey/nextjs-supabase-example). NextAuth's analogous CVE is CVE-2022-24858.
- **Official guidance:** The Supabase template in https://supabase.com/docs/guides/auth/social-login/auth-github validates the param: `if (!next.startsWith('/')) { // if "next" is not a relative URL, use the default  next = '/' }`
- **BAD:**
```ts
const next = searchParams.get('next') ?? '/'
await supabase.auth.exchangeCodeForSession(code)
return NextResponse.redirect(next)
```
- **GOOD:**
```ts
let next = searchParams.get('next') ?? '/'
if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) next = '/'
return NextResponse.redirect(new URL(next, origin))
```
- **Detection:**
  - Deterministic plus a light semantic check: a `searchParams.get('next'|'redirect'|'redirect_to'|'returnTo')` value flows into `NextResponse.redirect`, `redirect()`, `Response.redirect` or `res.redirect` with no `startsWith('/')` or URL-origin comparison. This is a dataflow check within one function.
- **Versions:** Any callback route.

## 16. `redirect-url-hardcoded-or-unlisted`
**Title:** `redirectTo`/`emailRedirectTo` hard-coded to localhost, or relying on an unlisted URL

- **What goes wrong:** If `redirectTo` is not in the Redirect URLs allowlist, Supabase silently falls back to Site URL, which defaults to `http://localhost:3000`. Production OAuth, magic links and password resets then land on localhost. Hard-coded `http://localhost` in `redirectTo` ships to prod.
- **Impact:** C. Very common, but mostly a config issue.
- **Evidence:**
  - https://github.com/orgs/supabase/discussions/27991
  - https://github.com/supabase/supabase/issues/3069
  - https://github.com/orgs/supabase/discussions/2842 "Auth and redirecting" (c=19, up=34)
  - https://dev.to/arling/supabase-oauth-redirects-to-localhost-in-production-the-allow-list-rule-nobody-reads-3g1b
- **Official guidance:** https://supabase.com/docs/guides/auth/redirect-urls (quoted via secondary sources): the Site URL is the default redirect when no `redirectTo` is passed, and non-allowlisted URLs fall back to it.
- **BAD:**
```ts
await supabase.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: 'http://localhost:3000/auth/callback' } })
```
- **GOOD:**
```ts
await supabase.auth.signInWithOAuth({
  provider: 'github',
  options: { redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin}/auth/callback` },
})
```
- **Detection:**
  - Deterministic: a literal `localhost` or `127.0.0.1` in `redirectTo`, `emailRedirectTo` or `options.redirectTo` for `signInWithOAuth`, `signInWithOtp`, `signUp` or `resetPasswordForEmail`.
  - Cross-file or config: `supabase/config.toml` `[auth] site_url` and `additional_redirect_urls` compared with code values.
- **Versions:** All.

## 17. `signup-confirmation-misread`
**Title:** Treating `signUp()` success as "logged in" or as a "new account"

- **What goes wrong:** With email confirmation on, `signUp` returns `user` with `session: null`. Code that assumes a session crashes or loops through redirects. For an existing confirmed email, Supabase returns an obfuscated fake user (no error) to prevent enumeration. Apps then show "check your email" or create profile rows with a random fake id. Some devs add enumeration endpoints to work around it.
- **Impact:** C. A security footgun if worked around badly.
- **Evidence:**
  - https://github.com/supabase/auth/issues/1517 (moved from supabase-js #296, c=96, r=19)
  - https://github.com/supabase/auth/issues/748
  - https://github.com/orgs/supabase/discussions/32976
  - https://www.guardlayer.io/blog/supabase-email-already-exists-enumeration
- **Official guidance:** https://supabase.com/docs/reference/javascript/auth-signup : "If Confirm email is enabled, a `user` is returned but `session` is null." For an existing confirmed user, "an obfuscated/fake user object is returned."
- **BAD:**
```ts
const { data } = await supabase.auth.signUp({ email, password })
await supabase.from('profiles').insert({ id: data.user!.id, name }) // may be fake id / no session → RLS fail
router.push('/dashboard')
```
- **GOOD:**
```ts
const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name } } })
if (error) return showError(error)
if (!data.session) return showMessage('If this address is new, check your inbox to confirm.')
// create profile via DB trigger on auth.users, not from the client
```
- **Detection:**
  - Semantic, a good classifier case: code after `signUp` dereferences `data.session`/`data.user!` unconditionally, navigates to an authed page, or inserts rows keyed by `data.user.id`.
  - Deterministic sub-signal: `data.user.identities.length === 0` used as an "exists" check is fragile. Flag it as info, not an error.
- **Versions:** All.

## 18. `react-native-client-misconfig`
**Title:** Expo/React Native client without persistent storage, AppState-driven refresh, or `detectSessionInUrl: false`

- **What goes wrong:** With no `storage`, there is no localStorage on RN, so the session is lost on every restart. Without the AppState start/stop hook, refresh runs continuously in the background, and refreshes can race after resume and kill the refresh token. `detectSessionInUrl` left at true is meaningless on native and can interfere with deep links.
- **Impact:** C, P.
- **Evidence:**
  - https://github.com/supabase/supabase/issues/25827 "Expo - React Native - Auth session missing!"
  - https://github.com/supabase/supabase-js/issues/1401
  - https://dev.to/chris_fa_8fca9f4ba09d963/your-expo-supabase-login-works-now-restart-the-app-386d
  - Expo's own guide: https://docs.expo.dev/guides/using-supabase/
- **Official guidance:** https://supabase.com/docs/reference/javascript/auth-startautorefresh : on non-browser platforms "the refresh process works _continuously_ in the background, which may not be desirable. You should hook into your platform's foreground indication mechanism and call these methods appropriately". The quickstart is https://supabase.com/docs/guides/auth/quickstarts/react-native ; I could not extract its code verbatim.
- **BAD:**
```ts
export const supabase = createClient(url, key) // RN: no storage, no AppState hook
```
- **GOOD:**
```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
export const supabase = createClient(url, key, {
  auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
})
AppState.addEventListener('change', (s) => (s === 'active' ? supabase.auth.startAutoRefresh() : supabase.auth.stopAutoRefresh()))
```
- **Detection:**
  - Cross-file: the project is React Native or Expo (`package.json` has `react-native`/`expo`), and `createClient` has no `auth.storage`, no `detectSessionInUrl: false`, and no `startAutoRefresh` anywhere.
  - All deterministic once the project type is known.
- **Versions:** supabase-js v2 on RN and Expo. Newer docs add `lock: processLock` and may use `expo-sqlite/localStorage`; check the version before recommending these.

## 19. `admin-api-from-client`
**Title:** `supabase.auth.admin.*` called from browser code or with a publishable/anon client

- **What goes wrong:** `auth.admin.deleteUser`, `listUsers`, `createUser` and `inviteUserByEmail` need service_role. From the browser they fail with "User not allowed" (403/401), and devs then "fix" it by shipping the service key, which leads to item 1.
- **Impact:** C, then S.
- **Evidence:**
  - https://github.com/orgs/supabase/discussions/5434
  - https://github.com/orgs/supabase/discussions/7728
  - https://github.com/orgs/supabase/discussions/13890
  - https://github.com/orgs/supabase/discussions/18780
- **Official guidance:** https://supabase.com/docs/reference/javascript/admin-api : admin methods must be called on a trusted server with a service_role or secret key, never in the browser. Paraphrased; I did not fetch the exact sentence.
- **BAD:**
```tsx
'use client'
await supabase.auth.admin.deleteUser(userId)
```
- **GOOD:**
```ts
'use server'
export async function deleteAccount() {
  const { data } = await (await createClient()).auth.getClaims()
  if (!data) throw new Error('unauthorized')
  await createAdminClient().auth.admin.deleteUser(data.claims.sub)
}
```
- **Detection:** Deterministic: `.auth.admin.` in a client-context file. Cross-file: `.auth.admin.` on a client whose key resolves to a publishable or anon key.
- **Versions:** All.

## 20. `new-api-key-misuse`
**Title:** New `sb_publishable_`/`sb_secret_` keys used like JWTs (e.g. in `Authorization: Bearer`), or legacy keys kept past deprecation

- **What goes wrong:** The new keys are not JWTs. Code that sets `Authorization: Bearer <sb_secret_...>`, or verifies keys as JWTs (Edge Functions with `verify_jwt`), breaks. Admin clients on new keys failed in some library versions.
- **Impact:** C. Rising with the migration, because legacy keys are deprecated by end of 2026.
- **Evidence:**
  - https://github.com/supabase/supabase-js/issues/1568 "cannot authenticate supabase admin / service_role client with new api keys" (c=4, r=15)
  - Only one strong thread found, so **partly unverified** frequency.
- **Official guidance:** https://supabase.com/docs/guides/api/api-keys : the new keys "require the `apikey` header rather than `Authorization: Bearer`", "Edge Functions need to authorize API keys in code", and Supabase is "deprecating the `anon` and `service_role` keys by the end of 2026".
- **BAD:**
```ts
fetch(`${url}/rest/v1/items`, { headers: { Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` } })
```
- **GOOD:**
```ts
fetch(`${url}/rest/v1/items`, { headers: { apikey: process.env.SUPABASE_SECRET_KEY! } })
// or simply createClient(url, process.env.SUPABASE_SECRET_KEY!) on a recent supabase-js
```
- **Detection:**
  - Deterministic: `Authorization` set to `Bearer` plus a variable or literal matching `sb_(secret|publishable)_` or env names `*_SECRET_KEY`/`*_PUBLISHABLE_KEY`.
  - Info level: env names `*ANON_KEY` or `*SERVICE_ROLE_KEY` mean migration is due.
- **Versions:** supabase-js versions from 2025 onward that support the new keys.

## 21. `getuser-on-every-render` (lower severity)
**Title:** Network-bound `getUser()` called in every server component or middleware request where `getClaims()` would do

- **What goes wrong:** `getUser()` makes an Auth server round trip each time. Calling it in middleware plus every layout or component multiplies latency and load, and parallel refreshes contribute to `refresh_token_already_used` races.
- **Impact:** P, C.
- **Evidence:**
  - https://github.com/supabase/auth-js/issues/898 "Security and performance risk with getUser and getSession" (c=9)
  - https://github.com/orgs/supabase/discussions/32917
  - https://github.com/supabase/supabase/issues/18981 (multiple layouts racing to refresh)
  - https://github.com/supabase/supabase/issues/30241
- **Official guidance:** https://supabase.com/docs/reference/javascript/auth-getclaims : "Prefer this method over GoTrueClient.getUser which always sends a request to the Auth server for each JWT." Caveat from the advanced guide: getClaims doesn't detect revoked sessions, and "The only way to detect that a session ended server-side… is to fetch the user with `getUser()`."
- **BAD / GOOD:** `await supabase.auth.getUser()` in middleware and in 5 nested layouts, versus `getClaims()` in middleware and layouts, with `getUser()` only before sensitive mutations.
- **Detection:** Cross-file: count `auth.getUser()` calls across the middleware and route tree for the same request path. Semantic: whether the call needs a fresh user record or revocation check. Info level only.
- **Versions:** Projects with asymmetric JWT signing keys (default after 2025-05-01). On legacy HS256 projects, getClaims falls back to a network call, so there is no gain.

---

## Summary table (ranked)

| # | id | Impact | Frequency signal | Detection mode |
|---|---|---|---|---|
| 1 | service-role-key-in-client-bundle | S/D critical | CVE-2025-48757, many repo bugs | deterministic + cross-file import graph |
| 2 | server-trusts-getsession | S high | auth-js#873 (122c/89r), sj#1709 (117c), sj#1703 (68r) | deterministic location + semantic use |
| 3 | jwt-decode-without-verification | S critical | several discussions, CodeQL rule | deterministic + semantic |
| 4 | user-metadata-for-authorization | S high | splinter lint 0015, discussions | deterministic regex + semantic |
| 5 | module-scope-server-client | S high | multiple repo fixes, official warning | deterministic + server-context fact |
| 6 | auth-response-cacheable | S high | official docs, Auth0 analogue | deterministic (route config) + cross-file |
| 7 | ssr-client-with-service-role | C/S | auth#965, troubleshooting page | deterministic + cross-file |
| 8 | onauthstatechange-async-deadlock | C high | auth-js#762 (44c/21r), sj#1441, Lovable/Dyad | deterministic AST |
| 9 | ssr-cookie-adapter-broken | C high | ssr#36 (45c/22r), supabase#18981 | deterministic AST |
| 10 | middleware-session-refresh-missing | C | discussions, Next 16 rename PRs | AST + cross-file (Next version, layout) |
| 11 | deprecated-auth-helpers | C/S | disc#27849, npm deprecation | deterministic |
| 12 | plain-client-in-ssr | C | disc#26791 (19c), sj#992 (31c) | cross-file (framework + context) |
| 13 | client-per-render / unsubscribed listener | C/P | several issues, benign-ish | deterministic AST |
| 14 | pkce-email-link-misconfig | C | many issues | cross-file + config |
| 15 | auth-callback-open-redirect | S medium | tutorial pattern; no incident found (unverified) | intra-function dataflow |
| 16 | redirect-url-hardcoded-or-unlisted | C | disc#2842 (34 up) | deterministic literal + config |
| 17 | signup-confirmation-misread | C | auth#1517 (96c) | semantic (classifier) |
| 18 | react-native-client-misconfig | C/P | issues + Expo docs | cross-file (project type) |
| 19 | admin-api-from-client | C→S | 4+ discussions | deterministic + cross-file |
| 20 | new-api-key-misuse | C | sj#1568 (15r) only | deterministic |
| 21 | getuser-on-every-render | P | auth-js#898, disc#32917 | cross-file, info level |

## Notes for linter design

- **Server/client context is the key fact.** Items 1, 2, 5, 12 and 19 need it. Signals are `'use client'`, `'use server'`, Next file conventions, `*.server.ts`, SvelteKit `+page.server.ts`, `hooks.server.ts`, Express handlers, and RN/Expo `package.json`. Compute it once per file and feed it to both the rules and Laya.
- **Best fits for the classifier (semantic):**
  - item 2: is the `getSession` result used for authorization?
  - item 4: is a metadata field security-relevant?
  - item 17: post-signup assumptions;
  - item 3: does the decoded `sub` gate access?
  - item 8: awaited wrapper functions that hide Supabase calls.
- **AST or regex is enough for:** items 9, 10 (ordering), 11, 13, 16, 20, and the env-name part of item 1.
- **Known false-positive traps:**
  - browser-side module singletons are correct, so only flag module scope on the server;
  - a try/catch no-op `setAll` in Server Component clients is the documented pattern;
  - `getSession()` in browser code is fine;
  - SvelteKit `safeGetSession` (getSession then getUser) is fine;
  - plain `createClient` with a secret key and `persistSession: false` is the correct admin client.
- **Overlap with the RLS/SQL area:** CVE-2025-48757 is missing RLS, not a client bug. Item 4's SQL-trigger variant also belongs to the RLS/SQL catalogue.
