defmodule Tpl.ServerTrustsGetSession do
  @moduledoc "server-trusts-getsession: label 1 when the getSession() result decides access."
  import Tpl.Vocab, only: [camel: 1]

  def rule, do: "server-trusts-getsession"
  def kind, do: :server

  def render(r, fw) do
    [
      {"owner-filter", 1,
       """
       const { data: { session } } = await supabase.auth.getSession()
       if (!session) #{fw.deny}
       const { data, error } = await supabase
         .from('#{r.table}')
         .select('#{r.cols}')
         .eq('#{r.owner}', session.user.id)
       if (error) throw error
       #{fw.ok.("data")}
       """},
      {"owner-filter", 0,
       """
       const { data: claims } = await supabase.auth.getClaims()
       if (!claims) #{fw.deny}
       const { data: { session } } = await supabase.auth.getSession()
       const { data, error } = await supabase
         .from('#{r.table}')
         .select('#{r.cols}')
         .eq('#{r.owner}', claims.claims.sub)
       if (error) throw error
       #{fw.ok.("{ data, expiresAt: session?.expires_at }")}
       """},
      {"insert-owner", 1,
       """
       const input = #{fw.input}
       const { data: { session } } = await supabase.auth.getSession()
       if (!session?.user) #{fw.deny}
       const { error } = await supabase
         .from('#{r.table}')
         .insert({ ...input, #{r.owner}: session.user.id })
       if (error) throw error
       #{fw.ok.("{ ok: true }")}
       """},
      {"insert-owner", 0,
       """
       const input = #{fw.input}
       const { data: { user }, error: authError } = await supabase.auth.getUser()
       if (authError || !user) #{fw.deny}
       const { data: { session } } = await supabase.auth.getSession()
       const { error } = await supabase
         .from('#{r.table}')
         .insert({ ...input, #{r.owner}: user.id })
       if (error) throw error
       #{fw.ok.("{ ok: true, token: session?.access_token }")}
       """},
      {"admin-write", 1,
       """
       const { data: { session } } = await supabase.auth.getSession()
       if (!session) #{fw.deny}
       const admin = createAdminClient()
       await admin
         .from('#{r.table}')
         .update({ archived: true })
         .eq('#{r.owner}', session.user.id)
       #{fw.ok.("{ archived: true }")}
       """},
      {"admin-write", 0,
       """
       const { data: { session } } = await supabase.auth.getSession()
       const { data: { user } } = await supabase.auth.getUser(session?.access_token)
       if (!user) #{fw.deny}
       const admin = createAdminClient()
       await admin
         .from('#{r.table}')
         .update({ archived: true })
         .eq('#{r.owner}', user.id)
       #{fw.ok.("{ archived: true }")}
       """},
      {"role-gate", 1,
       """
       const { data: { session } } = await supabase.auth.getSession()
       const role = session?.user.app_metadata?.role
       if (role !== 'admin') #{fw.deny}
       const { data } = await supabase.from('#{r.table}').select('#{r.cols}')
       #{fw.ok.("data")}
       """},
      {"role-gate", 0,
       """
       const { data: { session } } = await supabase.auth.getSession()
       const { data: claims } = await supabase.auth.getClaims()
       const role = claims?.claims.app_metadata?.role
       if (role !== 'admin') #{fw.deny}
       const { data } = await supabase.from('#{r.table}').select('#{r.cols}')
       #{fw.ok.("{ data, sessionExpires: session?.expires_at }")}
       """},
      {"forward-token", 0,
       """
       const { data: { session } } = await supabase.auth.getSession()
       const apiRes = await fetch(`${process.env.API_URL}/#{r.plural}/export`, {
         method: 'POST',
         headers: { Authorization: `Bearer ${session?.access_token}` },
       })
       if (apiRes.status === 401) #{fw.deny}
       #{fw.ok.("await apiRes.json()")}
       """},
      {"display-only", 0,
       """
       const { data: { session } } = await supabase.auth.getSession()
       const { data: #{r.plural} } = await supabase
         .from('#{r.table}')
         .select('#{r.cols}')
         .order('id', { ascending: false })
       #{fw.ok.("{ #{r.plural}, greeting: session?.user.email ?? 'there' }")}
       """},
      {"user-id-param", 1,
       """
       const { data: { session } } = await supabase.auth.getSession()
       const userId = session?.user?.id
       if (!userId) #{fw.deny}
       const #{r.plural} = await db#{camel(r.noun)}.findMany({ where: { #{r.owner}: userId } })
       #{fw.ok.(r.plural)}
       """},
      {"user-id-param", 0,
       """
       const { data: claims, error } = await supabase.auth.getClaims()
       const userId = claims?.claims.sub
       if (error || !userId) #{fw.deny}
       const { data: { session } } = await supabase.auth.getSession()
       const #{r.plural} = await db#{camel(r.noun)}.findMany({ where: { #{r.owner}: userId } })
       #{fw.ok.("{ #{r.plural}, refreshed: Boolean(session) }")}
       """}
    ]
  end
end

defmodule Tpl.GetSessionHelpers do
  @moduledoc """
  server-trusts-getsession shapes that live outside route handlers: Next.js middleware and
  shared server-only auth helpers in lib/. Rendered per resource (not per framework).
  """

  def rule, do: "server-trusts-getsession"
  def kind, do: :standalone

  def render(r) do
    [
      {"middleware-gate", 1, "middleware.ts", "server (Next.js middleware)",
       """
       import { NextResponse, type NextRequest } from 'next/server'
       import { createServerClient } from '@supabase/ssr'

       export async function middleware(request: NextRequest) {
         const response = NextResponse.next({ request })
         const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
           cookies: { getAll: () => request.cookies.getAll(), setAll: (all) => all.forEach(({ name, value, options }) => response.cookies.set(name, value, options)) },
         })
         const { data: { session } } = await supabase.auth.getSession()
         if (!session && request.nextUrl.pathname.startsWith('/#{r.plural}')) {
           return NextResponse.redirect(new URL('/login', request.url))
         }
         return response
       }
       """},
      {"middleware-gate", 0, "middleware.ts", "server (Next.js middleware)",
       """
       import { NextResponse, type NextRequest } from 'next/server'
       import { createServerClient } from '@supabase/ssr'

       export async function middleware(request: NextRequest) {
         const response = NextResponse.next({ request })
         const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
           cookies: { getAll: () => request.cookies.getAll(), setAll: (all) => all.forEach(({ name, value, options }) => response.cookies.set(name, value, options)) },
         })
         // refresh the auth cookie only; pages verify the user themselves
         await supabase.auth.getSession()
         return response
       }
       """},
      {"lib-check-auth", 1, "lib/auth.ts", "server",
       """
       import { cookies } from 'next/headers'
       import { createServerClient } from '@supabase/ssr'
       import { prisma } from './db'

       export async function get#{Tpl.Vocab.camel(r.plural)}ForCurrentUser() {
         const supabase = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { cookies: await cookies() })
         const { data: { session } } = await supabase.auth.getSession()
         if (!session) throw new Error('not signed in')
         return prisma.#{r.noun}.findMany({ where: { #{r.owner}: session.user.id } })
       }
       """},
      {"lib-check-auth", 0, "lib/auth.ts", "server",
       """
       import { cookies } from 'next/headers'
       import { createServerClient } from '@supabase/ssr'
       import { prisma } from './db'

       export async function get#{Tpl.Vocab.camel(r.plural)}ForCurrentUser() {
         const supabase = createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { cookies: await cookies() })
         const { data: { user } } = await supabase.auth.getUser()
         if (!user) throw new Error('not signed in')
         const { data: { session } } = await supabase.auth.getSession()
         console.debug('session expires', session?.expires_at)
         return prisma.#{r.noun}.findMany({ where: { #{r.owner}: user.id } })
       }
       """},
      {"decode-token-role", 1, "lib/supabase/get-role.ts", "server",
       """
       import { createClient } from './server'

       export async function canManage#{Tpl.Vocab.camel(r.plural)}() {
         const supabase = await createClient()
         const { data: { session } } = await supabase.auth.getSession()
         if (!session) return false
         const payload = JSON.parse(atob(session.access_token.split('.')[1]))
         return payload.app_metadata?.role === 'admin'
       }
       """},
      {"safe-get-session", 0, "src/hooks.server.ts", "server (SvelteKit +page.server.ts)",
       """
       import { createServerClient } from '@supabase/ssr'
       import type { Handle } from '@sveltejs/kit'

       export const handle: Handle = async ({ event, resolve }) => {
         event.locals.supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, { cookies: { getAll: () => event.cookies.getAll(), setAll: () => {} } })
         event.locals.safeGetSession = async () => {
           const { data: { session } } = await event.locals.supabase.auth.getSession()
           if (!session) return { session: null, user: null }
           const { data: { user }, error } = await event.locals.supabase.auth.getUser()
           if (error) return { session: null, user: null }
           return { session, user }
         }
         return resolve(event)
       }
       """}
    ]
  end
end

defmodule Tpl.EfServiceRoleTrustsBodyIdentity do
  @moduledoc "ef-service-role-trusts-body-identity: Edge Functions acting on body ids without verifying the caller."

  def rule, do: "ef-service-role-trusts-body-identity"
  def kind, do: :edge

  @admin "const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)"

  def render(r) do
    [
      {"insert-body-user", 1,
       """
       const { #{r.owner}, ...fields } = await req.json()
       #{@admin}
       const { error } = await admin.from('#{r.table}').insert({ #{r.owner}, ...fields })
       if (error) return new Response(error.message, { status: 400 })
       return Response.json({ ok: true })
       """},
      {"insert-body-user", 0,
       """
       const token = req.headers.get('Authorization')?.replace('Bearer ', '')
       #{@admin}
       const { data: { user }, error: authError } = await admin.auth.getUser(token)
       if (authError || !user) return new Response('Unauthorized', { status: 401 })
       const { #{r.owner}: _ignored, ...fields } = await req.json()
       const { error } = await admin.from('#{r.table}').insert({ #{r.owner}: user.id, ...fields })
       if (error) return new Response(error.message, { status: 400 })
       return Response.json({ ok: true })
       """},
      {"admin-update-user", 1,
       """
       const { userId, plan } = await req.json()
       #{@admin}
       await admin.auth.admin.updateUserById(userId, { app_metadata: { plan } })
       await admin.from('#{r.table}').update({ plan }).eq('#{r.owner}', userId)
       return Response.json({ updated: userId })
       """},
      {"admin-update-user", 0,
       """
       const { userId, plan } = await req.json()
       #{@admin}
       const token = req.headers.get('Authorization')?.replace('Bearer ', '')
       const { data: { user } } = await admin.auth.getUser(token)
       if (!user || user.app_metadata?.role !== 'admin') {
         return new Response('Forbidden', { status: 403 })
       }
       await admin.auth.admin.updateUserById(userId, { app_metadata: { plan } })
       await admin.from('#{r.table}').update({ plan }).eq('#{r.owner}', userId)
       return Response.json({ updated: userId })
       """},
      {"resource-callback", 1,
       """
       const { #{r.noun}_id, status } = await req.json()
       #{@admin}
       await admin.from('#{r.table}').update({ status }).eq('id', #{r.noun}_id)
       return new Response('ok')
       """},
      {"resource-callback", 0,
       """
       const secret = req.headers.get('x-webhook-secret')
       if (secret !== Deno.env.get('WEBHOOK_SECRET')) {
         return new Response('Forbidden', { status: 403 })
       }
       const { #{r.noun}_id, status } = await req.json()
       #{@admin}
       await admin.from('#{r.table}').update({ status }).eq('id', #{r.noun}_id)
       return new Response('ok')
       """},
      {"delete-by-email", 1,
       """
       const { email } = await req.json()
       #{@admin}
       const { data: profile } = await admin.from('profiles').select('id').eq('email', email).single()
       await admin.from('#{r.table}').delete().eq('#{r.owner}', profile.id)
       return Response.json({ deleted: true })
       """},
      {"delete-by-email", 0,
       """
       const auth = req.headers.get('Authorization') ?? ''
       const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
         global: { headers: { Authorization: auth } },
       })
       const { email } = await req.json()
       const { data: profile } = await supabase.from('profiles').select('id').eq('email', email).single()
       await supabase.from('#{r.table}').delete().eq('#{r.owner}', profile.id)
       return Response.json({ deleted: true })
       """},
      {"claims-check", 0,
       """
       #{@admin}
       const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
       const { data: claims, error } = await admin.auth.getClaims(token)
       if (error || !claims) return new Response('Unauthorized', { status: 401 })
       const { #{r.noun}_id } = await req.json()
       const { data } = await admin
         .from('#{r.table}')
         .select('#{r.cols}')
         .eq('id', #{r.noun}_id)
         .eq('#{r.owner}', claims.claims.sub)
       return Response.json(data)
       """},
      {"read-body-user", 1,
       """
       #{@admin}
       const { #{r.owner} } = await req.json()
       const { data } = await admin
         .from('#{r.table}')
         .select('#{r.cols}')
         .eq('#{r.owner}', #{r.owner})
       return Response.json(data)
       """}
    ]
  end
end

defmodule Tpl.AdminClientForUserScopedWork do
  @moduledoc "admin-client-for-user-scoped-work: service-role client used for ordinary per-user work."

  def rule, do: "admin-client-for-user-scoped-work"
  def kind, do: :server

  @admin "const supabaseAdmin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)"

  def render(r, fw) do
    [
      {"per-user-read", 1,
       """
       const { data: { user } } = await supabase.auth.getUser()
       if (!user) #{fw.deny}
       #{@admin}
       const { data } = await supabaseAdmin
         .from('#{r.table}')
         .select('#{r.cols}')
         .eq('#{r.owner}', user.id)
       #{fw.ok.("data")}
       """},
      {"per-user-read", 0,
       """
       const { data: { user } } = await supabase.auth.getUser()
       if (!user) #{fw.deny}
       #{@admin}
       await supabaseAdmin.auth.admin.updateUserById(user.id, { app_metadata: { last_export: Date.now() } })
       const { data } = await supabase
         .from('#{r.table}')
         .select('#{r.cols}')
         .eq('#{r.owner}', user.id)
       #{fw.ok.("data")}
       """},
      {"per-user-insert", 1,
       """
       const input = #{fw.input}
       const { data: claims } = await supabase.auth.getClaims()
       if (!claims) #{fw.deny}
       #{@admin}
       const { error } = await supabaseAdmin
         .from('#{r.table}')
         .insert({ ...input, #{r.owner}: claims.claims.sub })
       if (error) throw error
       #{fw.ok.("{ ok: true }")}
       """},
      {"per-user-insert", 0,
       """
       const input = #{fw.input}
       const { data: claims } = await supabase.auth.getClaims()
       if (!claims) #{fw.deny}
       const { error } = await supabase
         .from('#{r.table}')
         .insert({ ...input, #{r.owner}: claims.claims.sub })
       if (error) throw error
       #{@admin}
       await supabaseAdmin.from('audit_log').insert({ actor: claims.claims.sub, action: 'create_#{r.noun}' })
       #{fw.ok.("{ ok: true }")}
       """},
      {"delete-account", 0,
       """
       const { data: { user } } = await supabase.auth.getUser()
       if (!user) #{fw.deny}
       #{@admin}
       const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id)
       if (error) throw error
       #{fw.ok.("{ deleted: true }")}
       """},
      {"own-profile-update", 1,
       """
       const input = #{fw.input}
       const { data: { user } } = await supabase.auth.getUser()
       if (!user) #{fw.deny}
       #{@admin}
       const { error } = await supabaseAdmin
         .from('profiles')
         .update({ display_name: input.display_name, bio: input.bio })
         .eq('id', user.id)
       if (error) throw error
       #{fw.ok.("{ ok: true }")}
       """},
      {"own-profile-update", 0,
       """
       const input = #{fw.input}
       const { data: { user } } = await supabase.auth.getUser()
       if (!user) #{fw.deny}
       const { error } = await supabase
         .from('profiles')
         .update({ display_name: input.display_name, bio: input.bio })
         .eq('id', user.id)
       if (error) throw error
       #{@admin}
       await supabaseAdmin.auth.admin.updateUserById(user.id, { user_metadata: { display_name: input.display_name } })
       #{fw.ok.("{ ok: true }")}
       """},
      {"cross-user-job", 0,
       """
       if (#{fw.input}.secret !== process.env.CRON_SECRET) #{fw.deny}
       #{@admin}
       const { data: expired } = await supabaseAdmin
         .from('#{r.table}')
         .select('id, #{r.owner}')
         .lt('expires_at', new Date().toISOString())
       for (const row of expired ?? []) {
         await supabaseAdmin.from('#{r.table}').update({ status: 'expired' }).eq('id', row.id)
       }
       #{fw.ok.("{ expired: expired?.length ?? 0 }")}
       """},
      {"per-user-count", 1,
       """
       const { data: claims } = await supabase.auth.getClaims()
       if (!claims) #{fw.deny}
       #{@admin}
       const { count } = await supabaseAdmin
         .from('#{r.table}')
         .select('id', { count: 'exact', head: true })
         .eq('#{r.owner}', claims.claims.sub)
       #{fw.ok.("{ count }")}
       """}
    ]
  end
end

defmodule Tpl.SingleWhereMaybeSingle do
  @moduledoc "single-where-maybe-single: .single() where zero rows is a legitimate outcome."

  def rule, do: "single-where-maybe-single"
  def kind, do: :server

  def render(r, fw) do
    [
      {"lookup-then-create", 1,
       """
       const input = #{fw.input}
       const { data: existing } = await supabase
         .from('#{r.table}')
         .select('id')
         .eq('external_ref', input.ref)
         .single()
       if (!existing) {
         await supabase.from('#{r.table}').insert({ external_ref: input.ref })
       }
       #{fw.ok.("{ ok: true }")}
       """},
      {"lookup-then-create", 0,
       """
       const input = #{fw.input}
       const { data: created, error } = await supabase
         .from('#{r.table}')
         .insert({ external_ref: input.ref })
         .select('id')
         .single()
       if (error) throw error
       #{fw.ok.("created")}
       """},
      {"existence-check", 1,
       """
       const input = #{fw.input}
       const { data: duplicate } = await supabase
         .from('#{r.table}')
         .select('id')
         .eq('slug', input.slug)
         .single()
       if (duplicate) #{fw.ok.("{ error: 'slug already taken' }")}
       #{fw.ok.("{ ok: true }")}
       """},
      {"existence-check", 0,
       """
       const input = #{fw.input}
       const { data: updated, error } = await supabase
         .from('#{r.table}')
         .upsert({ slug: input.slug, title: input.title }, { onConflict: 'slug' })
         .select('id, slug')
         .single()
       if (error) throw error
       #{fw.ok.("updated")}
       """},
      {"optional-settings", 1,
       """
       const { data: { user } } = await supabase.auth.getUser()
       if (!user) #{fw.deny}
       const { data: prefs } = await supabase
         .from('#{r.noun}_preferences')
         .select('*')
         .eq('user_id', user.id)
         .single()
       #{fw.ok.("prefs ?? { notifications: true }")}
       """},
      {"optional-settings", 0,
       """
       const { data: { user } } = await supabase.auth.getUser()
       if (!user) #{fw.deny}
       const { data: prefs, error } = await supabase
         .from('#{r.noun}_preferences')
         .update({ notifications: false })
         .eq('user_id', user.id)
         .select('*')
         .single()
       if (error) throw error
       #{fw.ok.("prefs")}
       """},
      {"invite-by-email", 1,
       """
       const input = #{fw.input}
       const { data: invitee } = await supabase
         .from('profiles')
         .select('id')
         .eq('email', input.email)
         .single()
       if (!invitee) #{fw.ok.("{ invited: false, reason: 'no account yet' }")}
       await supabase.from('#{r.noun}_shares').insert({ #{r.noun}_id: input.id, user_id: invitee.id })
       #{fw.ok.("{ invited: true }")}
       """},
      {"rpc-scalar", 0,
       """
       const input = #{fw.input}
       const { data: totals, error } = await supabase
         .rpc('#{r.noun}_totals', { p_id: input.id })
         .single()
       if (error) throw error
       #{fw.ok.("totals")}
       """}
    ]
  end
end

defmodule Tpl.FactPairs do
  @moduledoc """
  Contrastive pairs where the code is identical and only the "Facts:" line (what an imported
  helper does, verify_jwt) decides the label. Teaches the model to read repo facts, which is what
  real code needs: the deciding information usually lives in another file.
  Returns {rule, family, label, file, context, code, facts}.
  """
  def kind, do: :fact_pairs
  def rule, do: "server-trusts-getsession"
  def rules, do: ~w(server-trusts-getsession admin-client-for-user-scoped-work ef-service-role-trusts-body-identity)

  @unverified "returns the session from auth.getSession() without verifying the JWT"
  @verified "verifies the user with auth.getUser()/getClaims()"
  @service "creates a Supabase service-role client that bypasses RLS"
  @scoped "creates a user-scoped client (anon/publishable key, RLS applies)"

  def render(r) do
    route = "src/app/api/#{r.plural}/route.ts"
    ctx = "server (Next.js route handler)"

    getsession = """
    import { NextResponse } from 'next/server'
    import { getSession } from '@/lib/auth/session'
    import { db } from '@/lib/db'

    export async function GET() {
      const session = await getSession()
      if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      const #{r.plural} = await db.#{r.noun}.findMany({ where: { #{r.owner}: session.user.id } })
      return NextResponse.json(#{r.plural})
    }
    """

    admin = """
    import { NextResponse } from 'next/server'
    import { createAdminClient } from '@/lib/supabase/admin'
    import { requireUser } from '@/lib/auth/require-user'

    export async function GET() {
      const user = await requireUser()
      const supabase = createAdminClient()
      const { data, error } = await supabase.from('#{r.table}').select('#{r.cols}').eq('#{r.owner}', user.id)
      if (error) throw error
      return NextResponse.json(data)
    }
    """

    fname = "#{String.replace(r.noun, "_", "-")}-sync"

    edge = """
    import { createAdminClient } from '../_shared/admin.ts'
    import { readCaller } from '../_shared/caller.ts'

    Deno.serve(async (req) => {
      const caller = await readCaller(req)
      const { #{r.owner} } = await req.json()
      const admin = createAdminClient()
      await admin.from('#{r.table}').update({ synced_at: new Date().toISOString() }).eq('#{r.owner}', caller?.id ?? #{r.owner})
      return Response.json({ ok: true })
    })
    """

    efile = "supabase/functions/#{fname}/index.ts"
    ectx = "edge function (Supabase Edge Function, Deno)"

    [
      {"server-trusts-getsession", "fact-helper-session", 1, route, ctx, getsession,
       ["imported getSession (src/lib/auth/session.ts) #{@unverified}"]},
      {"server-trusts-getsession", "fact-helper-session", 0, route, ctx, getsession,
       ["imported getSession (src/lib/auth/session.ts) #{@verified}"]},
      {"admin-client-for-user-scoped-work", "fact-helper-admin", 1, route, ctx, admin,
       ["imported createAdminClient (src/lib/supabase/admin.ts) #{@service}", "imported requireUser (src/lib/auth/require-user.ts) #{@verified}"]},
      {"admin-client-for-user-scoped-work", "fact-helper-admin", 0, route, ctx, admin,
       ["imported createAdminClient (src/lib/supabase/admin.ts) #{@scoped}", "imported requireUser (src/lib/auth/require-user.ts) #{@verified}"]},
      {"ef-service-role-trusts-body-identity", "fact-edge-caller", 1, efile, ectx, edge,
       ["imported createAdminClient (supabase/functions/_shared/admin.ts) #{@service}", "config.toml sets verify_jwt = false for function #{fname}"]},
      {"ef-service-role-trusts-body-identity", "fact-edge-caller", 0, efile, ectx, edge,
       ["imported createAdminClient (supabase/functions/_shared/admin.ts) #{@service}", "imported readCaller (supabase/functions/_shared/caller.ts) #{@verified}", "config.toml sets verify_jwt = false for function #{fname}"]}
    ]
  end
end
