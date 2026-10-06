// Deterministic rules over the fact store. Each returns a verdict plus the facts it rests on,
// so findings can explain themselves and the model header can state them in words.
import { callableByClients, key, type Facts, type Fn, type Policy, type Table } from './facts.js'

export type Verdict = { flagged: boolean; because: string[] }

/** definer-function-no-caller-check: client-callable definer whose parameters pick rows, no caller check. */
export function definerNoCallerCheck(fn: Fn, facts: Facts): Verdict {
  const usesParams = fn.params.some((p) => new RegExp(`\\b${p}\\b`).test(fn.body)) || /\$\d/.test(fn.body)
  const callable = callableByClients(fn, facts)
  const because = [
    fn.definer ? 'security definer' : 'security invoker',
    fn.trigger ? 'trigger function' : `${fn.params.length} parameter(s)${usesParams ? ' used in the body' : ''}`,
    fn.callerChecked ? 'checks the caller (auth.uid/jwt/role or a helper that does)' : 'never checks the caller',
    callable ? `executable by anon/authenticated in exposed schema ${fn.schema}` : `not client-callable (${facts.exposed.has(fn.schema) ? 'execute revoked' : `schema ${fn.schema} not exposed`})`,
  ]
  return { flagged: fn.definer && !fn.trigger && usesParams && !fn.callerChecked && callable, because }
}

// strong personal / secret data only; weak words (notes, amount, location) made catalogues look private
const SENSITIVE = /(email|phone|mobile|street|address_line|postcode|zip_?code|birth|dob|ssn|tax_id|iban|card_(number|last4)|token|secret|password|_hash$|api_?key|salary|diagnos|medical|ip_addr)/i
const OWNER = /^(user_id|owner_id|author_id|created_by|profile_id|customer_id|sender_id|recipient_id|member_id|account_id|tenant_id|org(anization)?_id)$/i

/** select-true-on-private-data: always-true SELECT reachable by clients on a per-user / sensitive table. */
export function selectTrueOnPrivate(p: Policy, facts: Facts): Verdict {
  const t = facts.tables.get(key(p.schema, p.table))
  const cols = t?.columns ?? []
  const sensitive = cols.filter((c) => SENSITIVE.test(c))
  const owned = [...new Set([...(t?.ownerColumns ?? []), ...cols.filter((c) => OWNER.test(c))])]
  const reachable = p.roles.length === 0 || p.roles.some((r) => ['anon', 'public', 'authenticated'].includes(r))
  const reads = p.cmd === 'select' || p.cmd === 'all'
  const because = [
    p.qualTrue ? (p.table === 'objects' ? 'USING only checks the bucket (any file in it)' : 'USING is always true') : 'USING is scoped',
    reads ? `applies to ${p.cmd}` : `applies to ${p.cmd} only`,
    reachable ? `reachable by ${p.roles.length ? p.roles.join(', ') : 'everyone (no TO clause)'}` : `limited to ${p.roles.join(', ')}`,
    t ? `table ${p.table}: ${owned.length ? `per-user (${owned.join(', ')})` : 'no owner column'}${sensitive.length ? `, sensitive columns ${sensitive.join(', ')}` : ''}` : `table ${p.table} not defined in migrations`,
  ]
  // storage buckets have no column facts: a bucket-only read policy on a private-sounding bucket is flagged
  const privateBucket = p.table === 'objects' && /(private|chat|media|document|invoice|avatar_private|upload|proof|attachment)/i.test(p.text)
  return { flagged: p.qualTrue && reads && reachable && (owned.length > 0 || sensitive.length > 0 || privateBucket), because }
}

/** Fact sentences for the SQL statement at file:line, as fed to reviewers and to the model header. */
export function sqlFactLines(facts: Facts, file: string, line: number): string[] {
  const fn = facts.history.find((f) => f.file === file && f.line === line)
  if (fn) return definerNoCallerCheck(fn, facts).because
  const p = facts.policies.find((x) => x.file === file && x.line === line)
  if (!p) return []
  const t = facts.tables.get(key(p.schema, p.table))
  const others = facts.policies.filter((o) => o.table === p.table && o !== p)
    .map((o) => `other policy on ${p.table}: ${o.cmd} to ${o.roles.join(', ') || 'public'}${o.qualTrue ? ' using (true)' : ''}`)
  return [...selectTrueOnPrivate(p, facts).because, ...(t ? [`RLS ${t.rls ? 'enabled' : 'NOT enabled'} on ${p.table}`] : []), ...others].slice(0, 8)
}

/**
 * Facts that settle "no" outright: returned reason means the finding is suppressed whatever the
 * model scored. Conservative on purpose: only cases where the deciding evidence is explicit.
 */
export function suppressedBy(rule: string, chunk: string, facts: string[]): string | undefined {
  const code = chunk.split('\n---\n').slice(1).join('\n')
  const verifiedHelper = facts.find((f) => /verifies the user/.test(f) && new RegExp(`imported (\\w+)`).test(f))
  if (rule === 'ef-service-role-trusts-body-identity') {
    if (/auth\.(getUser|getClaims)\(/.test(code)) return 'caller verified with getUser/getClaims in the handler'
    if (verifiedHelper && new RegExp(`\\b${/imported (\w+)/.exec(verifiedHelper)![1]}\\b`).test(code)) return `caller verified by ${verifiedHelper}`
    if (/constructEventAsync|timingSafeEqual|verifySignature|===\s*Deno\.env\.get\(|!==\s*Deno\.env\.get\(/.test(code)) return 'shared secret / signature check before acting'
  }
  if (rule === 'admin-client-for-user-scoped-work') {
    const service = /SERVICE_ROLE|service_role|SUPABASE_SECRET|sb_secret/.test(code) || facts.some((f) => /service-role client/.test(f))
    if (!service && facts.some((f) => /user-scoped client/.test(f))) return 'only a user-scoped client is used (RLS applies)'
  }
  if (rule === 'server-trusts-getsession' && /auth\.(getUser|getClaims)\(/.test(code)) return 'getUser/getClaims verifies the user in the same chunk'
  return undefined
}

const CMD_PRIV: Record<string, string[]> = { select: ['select'], insert: ['insert'], update: ['update'], delete: ['delete'], all: ['select', 'insert', 'update', 'delete'] }

function privileges(t: Table, facts: Facts, role: string): Set<string> {
  const out = new Set<string>()
  for (const src of [t.grants.get(role), t.grants.get('public'), facts.schemaGrants.get(t.schema)?.get(role), facts.schemaGrants.get(t.schema)?.get('public')])
    for (const p of src ?? []) out.add(p === 'all' ? 'select' : p), p === 'all' && ['insert', 'update', 'delete'].forEach((x) => out.add(x))
  return out
}

/** missing-api-grants-new-table: a policy targets anon/authenticated but no grant gives them the privilege. */
export function missingGrants(t: Table, facts: Facts): Verdict {
  if (!facts.exposed.has(t.schema)) return { flagged: false, because: [`schema ${t.schema} not exposed`] }
  const missing: string[] = []
  for (const p of facts.policies.filter((x) => x.table === t.name && x.schema === t.schema)) {
    const roles = p.roles.length ? p.roles.flatMap((r) => (r === 'public' ? ['anon', 'authenticated'] : [r])) : ['anon', 'authenticated']
    for (const role of roles.filter((r) => r === 'anon' || r === 'authenticated')) {
      const have = privileges(t, facts, role)
      for (const priv of CMD_PRIV[p.cmd] ?? []) if (!have.has(priv)) missing.push(`${role} lacks ${priv} (policy "${p.name}")`)
    }
  }
  const uniq = [...new Set(missing)]
  return { flagged: uniq.length > 0, because: uniq.length ? uniq.slice(0, 6) : ['grants match the policies'] }
}

/** grant-write-without-rls: anon/authenticated (or public) can write and RLS is off. */
export function grantWriteWithoutRls(t: Table, facts: Facts): Verdict {
  if (!facts.exposed.has(t.schema) || t.rls) return { flagged: false, because: [t.rls ? 'RLS enabled' : `schema ${t.schema} not exposed`] }
  const writers = ['anon', 'authenticated'].filter((r) => ['insert', 'update', 'delete'].some((p) => privileges(t, facts, r).has(p)))
  return { flagged: writers.length > 0, because: writers.length ? [`RLS not enabled on ${t.name}`, `write privileges granted to ${writers.join(', ')}`] : ['no write grants to anon/authenticated'] }
}

/**
 * Deterministic verdicts for the TS rules, from the chunk code plus repo facts.
 * Returns undefined when the rule doesn't apply to this chunk (nothing to judge).
 */
export function tsRuleVerdict(rule: string, state: string, facts: string[], kind: string): Verdict | undefined {
  const code = state.split('\n---\n').slice(1).join('\n---\n').replace(/^import .*$/gm, '')
  const verifiesCaller = /auth\.(getUser|getClaims)\(/.test(code) || facts.some((f) => /verifies the user/.test(f) && usesImport(f, code))
  const serviceRole = /SERVICE_ROLE|service_role|SUPABASE_SECRET|sb_secret/.test(code) || facts.some((f) => /service-role client/.test(f) && usesImport(f, code))
  const queries = /\.(from|rpc)\(|\.storage\b/.test(code)

  if (rule === 'admin-client-for-user-scoped-work') {
    if (!queries || !serviceRole) return undefined
    // caller identity: values obtained from an auth call or auth helper (getUser, requireUser, getCurrentUserId, authenticate*...)
    const authCall = /(auth\.(getUser|getClaims|getSession)|get\w*(User|Account|Session|Claims)\w*|requireUser|currentUser|authenticate\w*|verify\w*(Token|User))\s*\(/
    const callerVars = [...code.matchAll(/const\s+(\{[^}]*\}|\w+)\s*=\s*(await\s+)?([\w.]+)\s*\(/g)]
      .filter((m) => authCall.test(`${m[3]}(`)).flatMap((m) => m[1].replace(/[{}\s]/g, '').split(',').map((v) => v.split(':').pop()!))
      .concat(['user', 'claims', 'session'])
    const idExpr = callerVars.map((v) => `\\b${v}\\??\\.(id|sub|user\\??\\.id|claims\\??\\.sub)\\b|\\b${v}\\b(?=\\s*[),])`).join('|')
    const callerId = callerVars.length > 3 || new RegExp(idExpr).test(code)
    const filtersByCaller = new RegExp(`\\.(eq|match|filter|in)\\([^)]*(${idExpr})`).test(code)
      || new RegExp(`\\.(insert|upsert|update)\\(\\s*\\{[^}]*:\\s*(${idExpr})`).test(code)
    const adminOnly = /auth\.admin\./.test(code) && !/\.from\(/.test(code)
    const flagged = callerId && filtersByCaller && !adminOnly
    return { flagged, because: [serviceRole ? 'service-role client' : '', callerId ? 'uses the signed-in caller id' : 'no caller id', filtersByCaller ? 'filters/writes rows by the caller id' : 'not scoped to the caller', adminOnly ? 'auth.admin only' : ''].filter(Boolean) }
  }

  if (rule === 'server-trusts-getsession') {
    const direct = /auth\.getSession\(/.test(code)
    const viaHelper = facts.some((f) => /auth\.getSession\(\) without verifying/.test(f) && usesImport(f, code))
    if (!direct && !viaHelper) return undefined
    const server = kind === 'server' || kind === 'edge-function' || facts.some((f) => /server-only/.test(f))
    const safe = /safeGetSession|exchangeCodeForSession|verifyOtp/.test(code) || /auth\.(getUser|getClaims)\(/.test(code)
    const decides = /session\??\.user\??\.(id|app_metadata|role)/.test(code) && /\.(eq|match|filter|insert|update|delete|upsert)\(|where:\s*\{|findMany|findFirst|findUnique/.test(code)
      || /if\s*\(\s*!\s*session\b[^)]*\)\s*(\{[^}]*)?(redirect|return|throw|NextResponse\.redirect)/.test(code)
      || /session\??\.user\??\.(app_metadata|user_metadata|role)/.test(code)
    const forwards = /Authorization:\s*`Bearer \$\{session\??\.access_token\}`/.test(code) && !decides
    return { flagged: server && !safe && decides && !forwards, because: [direct ? 'calls auth.getSession()' : 'imported helper wraps unverified getSession()', server ? 'server-side' : 'client-side', safe ? 'verified/exchanged elsewhere in the chunk' : 'no getUser/getClaims', decides ? 'session decides access or rows' : 'session only displayed/forwarded'] }
  }

  if (rule === 'ef-service-role-trusts-body-identity') {
    if (kind !== 'edge-function' || !/req\.json\(\)/.test(code)) return undefined
    // body ids: destructured from req.json(), or read as props of a variable holding the body
    const bodyObjs = [...code.matchAll(/const\s+(\w+)\s*=\s*(await\s+)?req\.json\(\)/g)].map((m) => m[1])
    const fromObjs = bodyObjs.flatMap((o) => [...code.matchAll(new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*${o}\\b`, 'g'))].map((m) => m[1]))
    const bodyVars = [...code.matchAll(/const\s*\{([^}]*)\}\s*=\s*(await\s+)?req\.json\(\)/g)].map((m) => m[1]).concat(fromObjs)
      .flatMap((d) => d.split(',').map((v) => v.split(':').pop()!.trim().split('=')[0].trim())).filter(Boolean)
      .concat(bodyObjs.flatMap((o) => [...code.matchAll(new RegExp(`\\b${o}\\.(\\w+)`, 'g'))].map((m) => `${o}.${m[1]}`)))
    const esc = (v: string) => v.replace(/\./g, '\\??\\.')
    const bodyIdUsed = bodyVars.some((v) => /id$|Id$|_id$|email/i.test(v) && new RegExp(`\\.(eq|match|in|update|delete|getUserById|updateUserById|deleteUser)\\([^)]*\\b${esc(v)}\\b`).test(code))
    const secret = /constructEventAsync|timingSafeEqual|verifySignature|[!=]==\s*Deno\.env\.get\(|Deno\.env\.get\([^)]*\)\s*[!=]==|x-webhook-secret|authorization.*(Bearer|Basic).*Deno\.env/i.test(code)
    const userScoped = /global:\s*\{\s*headers:\s*\{\s*Authorization/.test(code) && !serviceRole
    return { flagged: serviceRole && bodyIdUsed && !verifiesCaller && !secret && !userScoped, because: [serviceRole ? 'service-role client' : 'no service-role client', bodyIdUsed ? 'acts on an id from the request body' : 'no body id used for data access', verifiesCaller ? 'caller verified' : secret ? 'shared secret/signature check' : 'caller never verified', ...facts.filter((f) => /verify_jwt/.test(f))] }
  }
  return undefined
}

function usesImport(fact: string, code: string) {
  const name = /imported (\w+)/.exec(fact)?.[1]
  return !!name && new RegExp(`\\b${name}\\b`).test(code)
}

// ---- more facts-first rules ----

const META_AUTHZ_KEY = /(role|admin|is_admin|plan|tier|permission|permissions|scope|access|level|org_?id|tenant_?id|owner)/i
const META_DISPLAY_KEY = /(full_?name|name|avatar|picture|locale|username|display|first_?name|last_?name|phone|bio)/i

/** user-metadata-for-authorization (SQL): a metadata key that sounds like authorization decides access or is stored as a role. */
export function userMetadataSql(text: string): Verdict | undefined {
  const refs = [...text.matchAll(/(raw_user_meta_data|user_metadata)['"]?\s*->>?\s*'(\w+)'/gi)].map((m) => m[2])
  if (!/raw_user_meta_data|user_metadata/i.test(text)) return undefined
  const authz = refs.filter((k) => META_AUTHZ_KEY.test(k) && !META_DISPLAY_KEY.test(k))
  return { flagged: authz.length > 0, because: authz.length ? [`user-writable metadata key(s) ${[...new Set(authz)].join(', ')} decide authorization`] : [`metadata read only for display (${[...new Set(refs)].join(', ') || 'whole object'})`] }
}

/** user-metadata-for-authorization (TS): user_metadata.<authz key> used in a condition or comparison. */
export function userMetadataTs(code: string): Verdict | undefined {
  if (!/user_metadata/.test(code)) return undefined
  const m = [...code.matchAll(/user_metadata\??\.(\w+)|user_metadata\??\[['"](\w+)['"]\]/g)].map((x) => x[1] ?? x[2])
  const authz = m.filter((k) => META_AUTHZ_KEY.test(k) && !META_DISPLAY_KEY.test(k))
  const decides = authz.some((k) => new RegExp(`user_metadata\\??\\.${k}\\s*(===|!==|==|!=)|if\\s*\\([^)]*user_metadata\\??\\.${k}|includes\\([^)]*user_metadata\\??\\.${k}`).test(code))
  return { flagged: decides, because: decides ? [`user_metadata.${authz[0]} decides access (user-writable)`] : ['metadata not used for an access decision'] }
}

/** policy-authenticated-not-authorized: "signed in" is the whole predicate, on a per-user table. Shared tables → team-wide info rule. */
export function policyAuthenticated(p: Policy, facts: Facts): { owner: Verdict; team: Verdict } | undefined {
  const t = facts.tables.get(key(p.schema, p.table))
  const qual = p.text.replace(/\s+/g, ' ')
  const signedInOnly = /auth\.role\(\)\s*=\s*'authenticated'/i.test(qual) || /auth\.uid\(\)\s+is\s+not\s+null/i.test(qual)
    || (p.qualTrue && p.roles.includes('authenticated') && !p.roles.includes('anon'))
  if (!signedInOnly) return undefined
  // any comparison against the caller (auth.uid()/auth.jwt(), incl. storage folder checks) means rows are scoped
  const scoped = /auth\.(uid|jwt)\(\)/i.test(qual.replace(/\(?\s*(select\s+)?auth\.uid\(\)\s*\)?\s+is\s+not\s+null/gi, '').replace(/auth\.role\(\)/gi, ''))
  if (scoped) return undefined
  // global reference data (catalogues, config, flags): sign-up restriction doesn't matter, skip
  if (/(price|plan|provider|config|setting|flag|feature|catalog|categor|countr|currenc|lookup|_types?$|enum|default|quota|template)/i.test(p.table)) return undefined
  const owned = [...new Set([...(t?.ownerColumns ?? []), ...(t?.columns ?? []).filter((c) => OWNER.test(c))])]
  const because = [`predicate only checks sign-in (${p.cmd})`, owned.length ? `per-user table (${owned.join(', ')})` : 'no owner column: team-shared table']
  return { owner: { flagged: owned.length > 0, because }, team: { flagged: owned.length === 0, because } }
}

/** first-signup-becomes-admin: a trigger grants admin/owner when a table is empty (count/exists check). */
export function firstSignupAdmin(fn: Fn): Verdict {
  const emptyCheck = /count\s*\(\s*\*?\s*\)\s*(=|<|<=)\s*0|not\s+exists\s*\(\s*select|count\s*\(\s*\*?\s*\)\s+into\s+\w+/i.test(fn.body)
  const grantsAdmin = /'(admin|administrator|owner|superadmin|super_admin)'|\btrue\b.*is_admin|is_admin\s*[:=]\s*true|administrator\s*[:=]\s*true/i.test(fn.body)
  return { flagged: fn.trigger && emptyCheck && grantsAdmin, because: [fn.trigger ? 'trigger function' : 'not a trigger', emptyCheck ? 'checks whether a table is empty' : 'no emptiness check', grantsAdmin ? 'assigns an admin/owner role' : 'no admin assignment'] }
}

/** service-role-in-request-handler (info) and cross-tenant-id-from-body, for TS chunks. */
export function tsExtraVerdicts(rule: string, state: string, facts: string[], kind: string): Verdict | undefined {
  const code = state.split('\n---\n').slice(1).join('\n---\n').replace(/^import .*$/gm, '')
  const serviceRole = /SERVICE_ROLE|service_role|SUPABASE_SECRET|sb_secret/.test(code) || facts.some((f) => /service-role client/.test(f) && usesImport(f, code))
  // edge-function files only count as handlers at the entry point (not _shared/ helpers)
  const handler = (kind === 'edge-function' && /Deno\.serve|\bserve\(/.test(state)) || (kind === 'server' && /export (async )?function (GET|POST|PUT|PATCH|DELETE|action|loader)|createServerFn|router\.(get|post|put|delete)|Deno\.serve|['"]use server['"]|export const (actions|load)/.test(state))
  if (rule === 'service-role-in-request-handler') {
    if (!handler || !serviceRole || !/\.(from|rpc|auth\.admin|storage)\b|\.from\(/.test(code)) return undefined
    return { flagged: true, because: ['service-role client used in a request handler'] }
  }
  if (rule === 'cross-tenant-id-from-body') {
    if (!handler || !serviceRole) return undefined
    const verified = /auth\.(getUser|getClaims)\(/.test(code) || facts.some((f) => /verifies the user/.test(f) && usesImport(f, code))
    const tenantFromBody = /(tenant_?id|org(anization)?_?id|team_?id|workspace_?id|account_?id|school_?id|company_?id)/i
    const bodyTenant = [...code.matchAll(/const\s*\{([^}]*)\}\s*=\s*(await\s+)?(req|request)\.json\(\)/g)].flatMap((m) => m[1].split(',')).map((v) => v.split(':').pop()!.trim()).filter((v) => tenantFromBody.test(v))
    const used = bodyTenant.some((v) => new RegExp(`\\.(eq|match|in|insert|update|upsert|rpc)\\([^)]*\\b${v}\\b`).test(code))
    const membership = /member|membership|belongs|has_?access|is_?member|user_tenants|tenant_users|org_users/i.test(code)
    if (!bodyTenant.length) return undefined
    return { flagged: verified && used && !membership, because: [verified ? 'caller authenticated' : 'caller not verified', `tenant id from body: ${bodyTenant.join(', ')}`, membership ? 'membership checked' : 'no membership check'] }
  }
  return undefined
}

/** single-where-maybe-single: clear cases decided by code; undefined → leave to the model. */
export function singleVerdict(state: string): Verdict | undefined {
  const code = state.split('\n---\n').slice(1).join('\n---\n')
  if (!/\.single\(\)/.test(code)) return undefined
  const writeThenSingle = /\.(insert|update|upsert)\([\s\S]{0,300}?\.select\([^)]*\)\s*\.single\(\)/.test(code)
  const lookups = code.split('.single()').length - 1
  const nullHandled = /\.single\(\)[\s\S]{0,400}?(if\s*\(\s*!\s*\w+\s*\)|\?\?|PGRST116|notFound\(\)|status:\s*404|\|\|\s*null)/.test(code)
  if (nullHandled && !(writeThenSingle && lookups === 1)) return { flagged: true, because: ['.single() result is null-checked: zero rows is expected'] }
  if (writeThenSingle && lookups === 1) return { flagged: false, because: ['insert/update/upsert ...select().single()'] }
  return undefined
}

/** rls-disabled-on-exposed-table: exposed schema, RLS never enabled after replaying all migrations. */
export function rlsDisabled(t: Table, facts: Facts): Verdict {
  const exposed = facts.exposed.has(t.schema)
  return { flagged: exposed && !t.rls, because: [exposed ? `schema ${t.schema} is exposed to the Data API` : `schema ${t.schema} not exposed`, t.rls ? 'RLS enabled' : 'RLS never enabled in any migration'] }
}

/** rls-policy-always-true-write: write command whose USING or WITH CHECK is always true, reachable by clients. */
export function alwaysTrueWrite(p: Policy): Verdict {
  const writes = ['insert', 'update', 'delete', 'all'].includes(p.cmd)
  const checkTrue = /with\s+check\s*\(\s*\(?\s*(true|1\s*=\s*1)\s*\)?\s*\)/i.test(p.text)
  const reachable = p.roles.length === 0 || p.roles.some((r) => ['anon', 'public', 'authenticated'].includes(r))
  const always = (p.qualTrue && p.table !== 'objects') || checkTrue
  return { flagged: writes && always && reachable, because: [`${p.cmd} policy`, p.qualTrue ? 'USING is always true' : checkTrue ? 'WITH CHECK is always true' : 'scoped', reachable ? `reachable by ${p.roles.join(', ') || 'everyone (no TO clause)'}` : `limited to ${p.roles.join(', ')}`] }
}

/** service-role-policy-without-to: named for the service role, no TO service_role, always true. */
export function serviceRolePolicyWithoutTo(p: Policy): Verdict {
  const named = /service[\s_-]?role|backend|system|server/i.test(p.name)
  const scoped = p.roles.includes('service_role')
  const always = p.qualTrue || /with\s+check\s*\(\s*\(?\s*true\s*\)?\s*\)/i.test(p.text)
  return { flagged: named && !scoped && always, because: [`policy "${p.name}"`, scoped ? 'TO service_role' : `applies to ${p.roles.join(', ') || 'everyone (no TO clause)'}`, always ? 'always true' : 'scoped predicate'] }
}
