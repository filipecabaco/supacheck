// Spike-level chunking: one chunk per file (TS) or per policy/function statement (SQL),
// with the same "Language / Context / File" header the model was trained on.
import { readFileSync } from 'node:fs'
import { parse as parseSql } from 'libpg-query'
import { parseSync } from 'oxc-parser'

export type Chunk = {
  file: string
  kind: 'server' | 'client' | 'edge-function' | 'policy' | 'function' | 'trigger' | 'sql'
  state: string
  /** 1-based line where the chunk's code starts in the source file. */
  line: number
}

export function tsContext(file: string, code: string): { kind: Chunk['kind']; context: string } {
  if (file.includes('supabase/functions/')) return { kind: 'edge-function', context: 'edge function (Supabase Edge Function, Deno)' }
  if (/^\s*['"]use client['"]/.test(code)) return { kind: 'client', context: 'client (React client component)' }
  if (/^\s*['"]use server['"]/.test(code)) return { kind: 'server', context: 'server (Next.js server action)' }
  if (/app\/.*\/route\.tsx?$/.test(file)) return { kind: 'server', context: 'server (Next.js route handler)' }
  if (/\+(page|layout)\.server\.ts$|hooks\.server\.ts$/.test(file)) return { kind: 'server', context: 'server (SvelteKit +page.server.ts)' }
  if (/createServerFn/.test(code)) return { kind: 'server', context: 'server (TanStack Start server function)' }
  if (/@remix-run|react-router/.test(code) && /export async function (action|loader)/.test(code)) return { kind: 'server', context: 'server (Remix action)' }
  if (/from ['"]express['"]/.test(code)) return { kind: 'server', context: 'server (Express route)' }
  if (/\.server\.tsx?$|\/api\/|middleware\.ts$/.test(file)) return { kind: 'server', context: 'server' }
  return { kind: 'client', context: 'client' }
}

export type ChunkOptions = {
  /** Path shown in the header (repo-relative), when the file is read from elsewhere. */
  displayPath?: string
  /** Context fact from outside the file (e.g. import graph says it's server-only). */
  kind?: Chunk['kind']
}

export async function chunksFor(file: string, opts: ChunkOptions = {}): Promise<Chunk[]> {
  const code = readFileSync(file, 'utf8')
  const shown = opts.displayPath ?? file
  if (file.endsWith('.sql')) return sqlChunks(shown, code)
  let { kind, context } = tsContext(shown, code)
  if (opts.kind && opts.kind !== kind) {
    kind = opts.kind
    context = opts.kind === 'server' ? 'server' : opts.kind
  }
  const header = `Language: TypeScript. Context: ${context}. File: ${shown}\n---\n`
  return tsChunks(code).map(({ text, line }) => ({ file: shown, kind, line, state: `${header}${text.trim()}\n` }))
}

const SKIP_NODES = new Set(['ImportDeclaration', 'TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'EmptyStatement'])

/**
 * One chunk per top-level declaration (function, exported handler, class, call like
 * router.post(...)), each carrying the file's directives and imports as context, which is
 * the shape the model was trained on. Falls back to the whole file if the parse fails.
 */
export function tsChunks(code: string): { text: string; line: number }[] {
  const result = parseSync('chunk.tsx', code, { sourceType: 'module', lang: 'tsx' })
  if (result.errors.length || !result.program.body.length) return [{ text: code, line: 1 }]

  const body = result.program.body as any[]
  const lineOf = (offset: number) => code.slice(0, offset).split('\n').length
  const directives = body.filter((n) => n.type === 'ExpressionStatement' && n.directive).map((n) => code.slice(n.start, n.end))
  const imports = body.filter((n) => n.type === 'ImportDeclaration').map((n) => code.slice(n.start, n.end))
  const context = [...directives, ...imports.slice(0, 15)].join('\n')

  const chunks = body
    .filter((n) => !SKIP_NODES.has(n.type) && !(n.type === 'ExpressionStatement' && n.directive))
    .map((n) => ({ text: (context ? context + '\n\n' : '') + code.slice(n.start, n.end), line: lineOf(n.start) }))
  return chunks.length ? chunks : [{ text: code, line: 1 }]
}

async function sqlChunks(file: string, code: string): Promise<Chunk[]> {
  // Keep `create table` statements as context for the policies/functions that follow them.
  if (!code.trim()) return []
  let tree: any
  try {
    tree = await parseSql(code)
  } catch (e) {
    console.error(`skipping ${file}: ${(e as Error).message}`)
    return []
  }
  // libpg_query reports byte offsets into the UTF-8 source, not UTF-16 string indices.
  const bytes = Buffer.from(code, 'utf8')
  const statements: { text: string; type: string; line: number }[] = (tree.stmts ?? []).map((s: any) => {
    const start = s.stmt_location ?? 0
    const end = s.stmt_len ? start + s.stmt_len : bytes.length
    const raw = bytes.subarray(start, end).toString('utf8')
    const lead = raw.length - raw.trimStart().length
    const line = bytes.subarray(0, start).toString('utf8').split('\n').length + raw.slice(0, lead).split('\n').length - 1
    return { text: raw.trim(), type: Object.keys(s.stmt)[0], line }
  })

  const tables = new Map<string, string>()
  const chunks: Chunk[] = []
  for (const st of statements) {
    if (st.type === 'CreateStmt') {
      const name = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i.exec(st.text)?.[1]?.replace(/^public\./, '')
      if (name) tables.set(name, st.text)
      continue
    }
    const kind: Chunk['kind'] | undefined =
      st.type === 'CreatePolicyStmt' ? 'policy'
      : st.type === 'CreateFunctionStmt' ? (/returns\s+trigger/i.test(st.text) ? 'trigger' : 'function')
      : st.type === 'ViewStmt' ? 'sql'
      : undefined
    if (!kind) continue

    const onTable = /\son\s+([\w."]+)/i.exec(st.text)?.[1]?.replace(/^public\./, '')
    const ddl = onTable && tables.get(onTable) ? `${tables.get(onTable)};\nalter table public.${onTable} enable row level security;\n\n` : ''
    const facts = onTable ? `Table public.${onTable} holds ${looksShared(onTable) ? 'shared' : 'per-user'} data.` : ''
    chunks.push({ file, kind, line: st.line, state: `Language: SQL. Context: migration. File: ${file}. ${facts}\n---\n${ddl}${st.text};\n` })
  }
  return chunks
}

// Placeholder fact until the schema-replay fact store exists.
function looksShared(table: string) {
  return /^(products|categories|tags|plans|countries|announcements|faq|blog_posts|posts|changelog)/.test(table)
}

/** Insert a "Facts:" line between the header and the code (same format in training and inference). */
export function withFacts(state: string, facts: string[]): string {
  if (!facts.length) return state
  const [header, ...rest] = state.split('\n---\n')
  return `${header}\nFacts: ${facts.join('; ')}\n---\n${rest.join('\n---\n')}`
}
