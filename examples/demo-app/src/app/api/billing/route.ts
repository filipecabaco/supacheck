import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { createAdminClient } from '@/lib/admin'

// server-trusts-getsession (via an unverified helper) + service-role-in-request-handler
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = createAdminClient()
  const { data, error } = await admin.from('orders').select('id, total').eq('user_id', session.user.id)
  if (error) throw error
  return NextResponse.json(data)
}
