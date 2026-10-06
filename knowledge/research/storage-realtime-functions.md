# Storage, Realtime, Edge Functions, Cron/Queues anti-patterns

Research catalogue, 2026-10-05. Ranked by severity × frequency (S, F each 1–5).

How this was gathered, and its limits:
- **GitHub rate limit**: GitHub search hit its rate limit partway through. Discussion
  evidence was gathered through web search instead.
- **Comment counts**: "Nc" counts are shown only where they were seen.
- **Missing sources**: no Stack Overflow or Reddit threads surfaced.
- **Doc drift**: the current Edge Functions docs (Oct 2026) teach the
  `withSupabase({ auth: 'user' | 'secret' | 'publishable' | 'none' })` wrapper (giving
  `ctx.supabase` and `ctx.supabaseAdmin`) and `corsHeaders` from
  `npm:@supabase/supabase-js@^2/cors`. The legacy-JWT docs still show the manual pattern.
  **Rules must accept both generations as correct.**

**Detection legend:**
- **D**: deterministic.
- **S**: semantic (Laya).
- **X**: cross-file.

---

## 1. `ef-service-role-trusts-body-identity` (S5 F5)
An Edge Function builds a service-role or secret-key client (bypassing RLS) and acts on a
`user_id` read from `req.json()`, without verifying the caller. This is an IDOR and
privilege escalation, worst with `verify_jwt=false`.
- **Evidence**:
  - <https://dev.to/systagproject/your-supabase-edge-function-probably-has-no-auth-8-out-of-9-vibe-coded-apps-i-scanned-this-week-4lb1>
    (8 of 9 AI-scaffolded apps had it)
  - <https://github.com/orgs/supabase/discussions/39555>,
    <https://github.com/orgs/supabase/discussions/15631>,
    <https://github.com/orgs/supabase/discussions/21907>
- **Guidance**: <https://supabase.com/docs/guides/functions/auth>
  - "`ctx.supabaseAdmin` bypasses RLS (service role)."
  - "`auth: 'none'` disables every credential check, so your handler is fully responsible
    for authenticating the caller."
- **BAD**
  ```ts
  Deno.serve(async (req) => {
    const { user_id, amount } = await req.json()
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    await sb.from('orders').insert({ user_id, amount })
    return new Response('ok')
  })
  ```
- **GOOD**
  ```ts
  Deno.serve(async (req) => {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '')
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: { user }, error } = await admin.auth.getUser(token)
    if (error || !user) return new Response('Unauthorized', { status: 401 })
    const { amount } = await req.json()
    await admin.from('orders').insert({ user_id: user.id, amount })
    return new Response('ok')
  })
  ```
- **Detection: S**, a prime classifier target. Taint flows from `req.json()` fields into
  `.eq('user_id')`, `.insert({user_id})` or `auth.admin.*`, and there is no
  `auth.getUser`, `getClaims` or `withSupabase({auth:'user'})`. **X** with
  `config.toml` `[functions.x] verify_jwt = false`.

## 2. `secret-key-in-client-bundle` (S5 F4)
An RLS error on upload is "fixed" by switching the browser client to the service key,
via `NEXT_PUBLIC_…SERVICE_ROLE_KEY` or `VITE_…`.
- **Evidence**:
  - <https://dev.to/cekuu35/your-supabase-servicerole-key-is-probably-in-your-browser-bundle-4j49>
  - <https://github.com/itanne99/teachy-time/issues/129>
  - <https://github.com/stellar-creator-portfolio/stellar-creator-portfolio-/issues/48>
    (a shared module drags the admin client into the bundle)
- **Guidance**: <https://supabase.com/docs/guides/storage/security/access-control> says
  "Service keys entirely bypass RLS policies … you should not share the service key
  publicly."
- **GOOD**: the server issues `createSignedUploadUrl(`${user.id}/${name}`)` and the
  client calls `uploadToSignedUrl(path, token, file)`.
- **Detection**:
  - **D**: env names matching `/(NEXT_PUBLIC|VITE|EXPO_PUBLIC|PUBLIC)_.*(SERVICE_ROLE|SECRET)/`,
    `sb_secret_` literals, or JWT literals with `"role":"service_role"`.
  - **X**: an admin client exported from a module imported by `'use client'` files.

## 3. `storage-policy-not-owner-scoped` (S5 F4)
A `storage.objects` policy checks only `bucket_id` or the role, so any user reads,
overwrites or deletes everyone's files. Because permissive policies are OR-ed, one broad
policy cancels out a strict one.
- **Evidence**:
  - <https://www.answeroverflow.com/m/1453375466021847181>
  - <https://modernpentest.com/blog/supabase-security-misconfigurations>
  - <https://eastondev.com/blog/en/posts/dev/20260409-supabase-storage/>
- **Guidance**: access-control docs scope with `(storage.foldername(name))[1] = …`.
  Private-bucket SELECT uses `storage.allow_any_operation(...)`.
- **BAD** `create policy "read" on storage.objects for select to authenticated using (bucket_id = 'docs');`
- **GOOD** `… using (bucket_id = 'docs' and (storage.foldername(name))[1] = (select auth.uid())::text);`
- **Detection**:
  - **D**: no `auth.uid()`, `auth.jwt()`, `owner_id` or `owner` in USING or WITH CHECK.
  - **S**: scoping through a helper function.
  - **X**: the client upload path must start with `user.id`.

## 4. `private-data-in-public-bucket` (S5 F3)
A public bucket serves every object without auth, signed URLs don't help, and paths like
`{user_id}/invoice.pdf` can be enumerated.
- **Evidence**:
  - <https://dev.to/veristria/your-supabase-storage-bucket-is-public-signed-urls-will-not-save-you-519a>
  - UpGuard study (Sep 2026, 16,326 leaking projects): <https://cybernews.com/news/16000-supabase-databases-exposed/>,
    <https://byteiota.com/16326-supabase-databases-leaked-check-your-rls-now/>
- **Guidance**: <https://supabase.com/docs/guides/storage/buckets/fundamentals> says a
  public bucket "effectively bypasses access controls … Anyone who possesses the asset URL
  can readily access the file."
- **Detection**:
  - **S**: is the content sensitive, judging by bucket name, path or content type
    (invoice, id, passport, medical)?
  - **X**: `createBucket(…, {public:true})` or a `storage.buckets` insert, combined with
    user-scoped upload paths.

## 5. `public-bucket-listing-policy` (S3 F4)
A broad SELECT policy on a public bucket lets anon call `.list()` and enumerate every
object. Public URLs don't need any policy.
- **Evidence**: Advisor lint `0025_public_bucket_allows_listing`, raised in many repos:
  - <https://github.com/louisianahelpr/louisianahelpr/issues/1229>
  - <https://github.com/MatthieuK21/mkpk-inventory/pull/19>
  - <https://github.com/Gut-Einern-e-V/wr-repair/issues/109>
- **Guidance**: <https://supabase.com/docs/guides/database/database-linter?lint=0025_public_bucket_allows_listing>
- **Detection: X** (a public bucket plus a SELECT policy with no owner predicate).

## 6. `storage-upsert-missing-policies` (S2 F5)
`upload(…, { upsert: true })` with only an INSERT policy. Upsert also needs SELECT and
UPDATE, so it fails with "new row violates row-level security policy", and developers
then reach for the service key (#2).
- **Evidence**:
  - Discussions <https://github.com/orgs/supabase/discussions/30510>, /10059, /2169
  - <https://community.weweb.io/t/get-row-level-sec-error-when-uploading-images-to-supabase-from-weweb/14062>
- **Guidance**: access-control docs say "[for upsert] you will need to additionally grant
  SELECT and UPDATE permissions."
- **Detection: X** (`upsert: true` on bucket X in TS, versus the policies covering
  bucket X in migrations).

## 7. `realtime-channel-not-removed` (S3 F5)
`channel(...).subscribe()` in `useEffect` without `removeChannel` cleanup, or a channel or
client created in the render body. Channels leak, events fire more than once, and the
app hits `too_many_channels` (100 per connection) and connection quotas.
- **Evidence**:
  - <https://supabase.com/docs/guides/troubleshooting/realtime-too-many-channels-error>
  - <https://github.com/supabase/realtime-js/issues/169> (17c, StrictMode)
  - <https://github.com/supabase/supabase-js/issues/1729> (server-side broadcast leak)
  - <https://github.com/orgs/supabase/discussions/49604>
- **Guidance**: that troubleshooting page says "Cleanup function - ALWAYS unsubscribe!",
  "Create client outside component (singleton)", and to call `removeAllChannels()` on
  logout.
- **BAD**
  ```tsx
  useEffect(() => {
    supabase.channel('room').on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, h).subscribe()
  }, [])
  ```
- **GOOD**
  ```tsx
  useEffect(() => {
    const ch = supabase.channel(`room:${roomId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, h)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [roomId])
  ```
- **Detection: D.** Check `useEffect`, `onMounted` and `$effect` for missing cleanup, and
  flag `createClient` or `.channel()` in a component body or a server request handler.

## 8. `realtime-table-without-rls` (S4 F3)
`postgres_changes` on a table without RLS, or with a permissive SELECT policy, streams
every change to anyone holding the anon key. DELETE events skip RLS entirely, leaking
primary keys or whole old rows under `replica identity full`.
- **Evidence**:
  - <https://supabase.com/docs/guides/realtime/postgres-changes>
  - <https://cybernews.com/news/16000-supabase-databases-exposed/>
  - <https://medium.com/@kidane10g/supabase-realtime-stops-working-when-rls-is-enabled-heres-the-fix-154f0b43c69a>
    (people disable RLS to "fix" realtime)
- **Guidance**: "RLS policies are not applied to DELETE statements."
- **Detection: X** (publication DDL versus RLS). **S** for sensitive columns.

## 9. `realtime-public-channel-for-private-data` (S4 F3)
Broadcast or Presence without `config: { private: true }` while "Allow public access" is
on. Anyone who guesses the topic can listen and send.
- **Evidence**: <https://github.com/supabase/realtime/issues/1111> (23c; private channels
  are hard to get working, which pushes users back to public ones),
  <https://github.com/supabase/realtime/issues/2273>
- **Guidance**: <https://supabase.com/docs/guides/realtime/authorization> says to disable
  "Allow public access", use `private: true`, and add RLS on `realtime.messages` using
  `realtime.topic()`.
- **GOOD**
  ```ts
  await supabase.realtime.setAuth()
  supabase.channel(`dm:${a}:${b}`, { config: { private: true } }).on('broadcast', { event: 'msg' }, h).subscribe()
  ```
- **Detection**:
  - **S**: does the topic or payload look private?
  - **D**: no `private: true`.
  - **X**: no `realtime.messages` policies.

## 10. `ef-user-client-module-scope` (S4 F2)
A per-user client built at module scope, capturing an Authorization header or calling
`setSession` or `signIn*`, is reused by the warm worker across users. That is
cross-user session leakage.
- **Evidence**:
  - <https://supabase.com/docs/guides/auth/server-side/advanced-guide> (Vercel Fluid
    compute)
  - <https://github.com/supabase/auth-js/issues/881>
  - Frequency in Edge Functions specifically is unverified.
- **Guidance**: "Always initialize the Supabase client inside the request handler, not at
  module level." See also <https://supabase.com/docs/guides/functions/auth-legacy-jwt>.
- **Detection: D.**

## 11. `ef-missing-cors-preflight` (S2 F5)
No OPTIONS handler, or error paths return without CORS headers, which hides the real
error behind a CORS message.
- **Evidence**:
  - Discussions <https://github.com/orgs/supabase/discussions/6370>, /38832, /29707, /32719
  - <https://zenn.dev/k_kind/articles/supabase-edge-functions-cors>
  - <https://corsproxy.io/blog/fix-supabase-cors-errors/>
- **Guidance**: <https://supabase.com/docs/guides/functions/cors> recommends
  `corsHeaders` from `npm:@supabase/supabase-js@^2/cors`, or `withSupabase`, which
  handles preflight.
- **Detection: D** (no OPTIONS branch and no `withSupabase`, or a Response without CORS
  headers). **X**: the function is invoked from browser code.

## 12. `cron-hardcoded-secret-key` (S4 F3)
pg_cron or pg_net SQL embeds a service-role key literal. The key ends up in plain text in
`cron.job`, in git and in backups.
- **Evidence**:
  - <https://medium.com/@samuelmpwanyi/how-to-set-up-cron-jobs-with-supabase-edge-functions-using-pg-cron-a0689da81362>
  - <https://github.com/orgs/supabase/discussions/29265>
  - <https://cronjobpro.com/blog/supabase-cron>
  - <https://github.com/supabase/cli/issues/4287>
- **Guidance**: <https://supabase.com/docs/guides/functions/schedule-functions> says
  "we recommend storing them in Supabase Vault" (`vault.decrypted_secrets`).
- **Detection: D** (`eyJ[A-Za-z0-9_-]{10,}\.` or `sb_secret_` inside SQL strings,
  especially in `cron.schedule` or `net.http_*`).

## 13. `realtime-table-not-in-publication` (S2 F5)
A subscription to a table missing from `supabase_realtime` never receives anything. It
often works locally (enabled in the dashboard) and fails in production.
- **Evidence**:
  - <https://github.com/orgs/supabase/discussions/49604>, <https://github.com/orgs/supabase/discussions/13680>
  - <https://supabase.com/docs/guides/troubleshooting/realtime-postgres-changes-troubleshooting>
- **Detection: X.** Report as a warning, because tables enabled through the dashboard
  produce false positives.

## 14. `realtime-filter-or-old-without-replica-identity` (S2 F4)
`payload.old` has only the primary key, and DELETE filters silently don't match, without
`replica identity full`.
- **Evidence**: <https://github.com/orgs/supabase/discussions/29884>, discussion #49604
- **Detection: X.**

## 15. `realtime-unfiltered-postgres-changes-at-scale` (S2 F4)
`event: '*'` with no filter. Changes are processed on a single thread and authorized per
subscriber.
- **Guidance**: postgres-changes guide says "If you expect more than ~3,000 concurrent
  subscribers on the same changes, use Broadcast."
- **Evidence**: blogs only (moderately verified): <https://axonbuild.com/blog/supabase-realtime-slow>,
  <https://www.agilesoftlabs.com/blog/2026/05/supabase-realtime-in-production-what>
- **Detection: D**, plus **S** for whether it matters at scale.

## 16. `ef-unawaited-background-work` (S3 F3)
Fire-and-forget promises may be killed after the response is sent, and inline slow work
hits the 150 s idle timeout or the 2 s CPU limit.
- **Guidance**: <https://supabase.com/docs/guides/functions/background-tasks>
  (`EdgeRuntime.waitUntil`), <https://supabase.com/docs/guides/functions/limits>
- **Evidence**: <https://github.com/orgs/supabase/discussions/37574>. The dropped-promise
  case is unverified.
- **Detection: D**, plus **S** for whether the work is long-running.

## 17. `ef-stripe-sync-constructEvent` (S3 F3)
Synchronous `constructEvent` always throws on Deno, so developers delete the
verification, leaving an unauthenticated webhook.
- **Evidence**:
  - <https://github.com/stripe/stripe-node/issues/1942>, <https://github.com/stripe/stripe-node/issues/1827>
  - <https://github.com/supabase/supabase/issues/26126>
- **GOOD** `await stripe.webhooks.constructEventAsync(await req.text(), sig, secret, undefined, Stripe.createSubtleCryptoProvider())`
- **Detection: D.** **S**: a `verify_jwt=false` function with no signature check.

## 18. `cron-pgnet-default-timeout` (S2 F3)
`net.http_post` without `timeout_milliseconds`. The small default (documented as 2–5 s)
loses statuses.
- **Evidence**:
  - <https://github.com/orgs/supabase/discussions/37574>
  - <https://github.com/supabase/pg_net/issues/74>, <https://github.com/supabase/pg_net/issues/179>
  - <https://github.com/orgs/supabase/discussions/21023>
- **Detection: D.**

## 19. `queues-exposed-without-rls` (S4 F1)
`pgmq_public` granted to anon or authenticated without RLS on `pgmq.q_*`.
- **Evidence**: weak (unverified frequency). Included because
  <https://supabase.com/docs/guides/queues/quickstart> explicitly calls out the risk.
- **Detection: D**, plus **X** (no RLS on `pgmq.q_*`).

## 20. `storage-signed-url-persisted-or-long-lived` (S2 F3)
Signed URLs stored in tables, or multi-year `expiresIn`, turn a private file permanently
public with no way to revoke it.
- **Evidence**: <https://github.com/orgs/supabase/discussions/29011>,
  <https://github.com/orgs/supabase/discussions/35182>,
  <https://github.com/supabase/storage/issues/1186>
- **Detection: D** (`expiresIn` above 7 days), plus **S** for data flow into an insert.

## 21. `storage-getpublicurl-on-private-bucket` (S1 F4)
`getPublicUrl` on a private bucket returns 400/404, and the "fix" is to flip the bucket
to public (#4).
- **Evidence**: <https://github.com/orgs/supabase/discussions/28104>, <https://github.com/orgs/supabase/discussions/5601>
- **Detection: X.**

## 22. `storage-rn-blob-upload` (S2 F3)
React Native uploads using Blob, File or FormData produce 0-byte or corrupted files.
- **Guidance**: <https://supabase.com/docs/reference/javascript/storage-from-upload> says
  to "Upload file using ArrayBuffer from base64 file data instead."
- **Evidence**: <https://github.com/orgs/supabase/discussions/2336>, <https://github.com/orgs/supabase/discussions/2106>
- **Detection: D** in RN/Expo projects.

---

## Lower-confidence candidates
- **`ef-unpinned-remote-imports`**: an unversioned `esm.sh` import or a `deno.land/std`
  `serve` import. The docs prefer `npm:` specifiers and a `deno.json` per function. See
  edge-runtime issues #410 (24c) and #591 (25c). **D.**
- **`realtime-subscribe-status-ignored`**: no `(status, err)` callback on `.subscribe()`. **D.**
- **`realtime-private-policy-joins-rls-table`**: realtime/#1111. Fix with a definer helper.
- **`ef-heavy-top-level-init`**: no direct evidence found.

## Linter design notes
- **Deterministic, high value**: #2, #7, #11, #12, #17, #18, #22.
- **Classifier targets**: #1, #4, #9, #16.
- **Cross-file fact store**:
  - buckets → public flag
  - `storage.objects` policies per bucket and operation, with an owner-scoping flag
  - per table: publication membership, RLS, replica identity
  - `config.toml` `verify_jwt` per function
  - client/server module boundaries
