import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chunksFor } from './chunks.js'

/** Fetch a GitHub permalink at its pinned commit (cached) and return the chunk starting at `line`. */
export async function fetchChunk(url: string, line: number, cacheDir: string): Promise<string | undefined> {
  const m = /github\.com\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]+)\/(.+)$/.exec(url)
  if (!m) return undefined
  const [, owner, repo, sha, path] = m
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`
  const local = join(cacheDir, createHash('sha1').update(raw).digest('hex').slice(0, 12) + '-' + path.split('/').pop())
  if (!existsSync(local)) {
    const res = await fetch(raw)
    if (!res.ok) return undefined
    writeFileSync(local, await res.text())
  }
  const chunks = await chunksFor(local, { displayPath: decodeURIComponent(path) })
  return chunks.find((c) => c.line === line)?.state ?? chunks[0]?.state
}
