'use server'
import { createClient } from '@/lib/supabase/server'

// single-where-maybe-single: a profile that may not exist yet
export async function loadProfile(email: string) {
  const supabase = await createClient()
  const { data: profile } = await supabase.from('profiles').select('*').eq('email', email).single()
  if (!profile) return { onboarding: true }
  return profile
}
