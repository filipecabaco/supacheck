import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

export async function getSession() {
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: await cookies() })
  const { data } = await supabase.auth.getSession()
  return data.session
}
