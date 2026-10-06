import { createClient } from 'npm:@supabase/supabase-js@2'

// ef-service-role-trusts-body-identity: verify_jwt = false, service role, user id from the body
Deno.serve(async (req) => {
  const { user_id, message } = await req.json()
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  await admin.from('notifications').insert({ user_id, message })
  await admin.from('profiles').update({ last_notified_at: new Date().toISOString() }).eq('id', user_id)
  return Response.json({ ok: true })
})
