// Package a model directory for a GitHub Release: split files into <=95 MB parts, write manifest.json.
//   pnpm tsx src/pack-model.ts <model dir> <tag> <kind: laya|heads> <out dir> <file...>
// then: gh release create <tag> <out dir>/* --title <tag> --notes "..."
import { createHash } from 'node:crypto'
import { mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [modelDir, tag, kind, outDir, ...files] = process.argv.slice(2)
if (!files.length) throw new Error('usage: pack-model <model dir> <tag> <laya|heads> <out dir> <file...>')
const PART = 95 * 1024 * 1024
mkdirSync(outDir, { recursive: true })

const manifest = { tag, kind, files: [] as any[] }
for (const name of files) {
  const path = join(modelDir, name)
  const size = statSync(path).size
  const whole = createHash('sha256')
  const parts = []
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(PART)
  for (let offset = 0, i = 0; offset < size; offset += PART, i++) {
    const n = readSync(fd, buf, 0, Math.min(PART, size - offset), offset)
    const chunk = buf.subarray(0, n)
    whole.update(chunk)
    const asset = `${name.replace(/[^\w.-]/g, '_')}.part${String(i).padStart(3, '0')}`
    writeFileSync(join(outDir, asset), chunk)
    parts.push({ asset, size: n, sha256: createHash('sha256').update(chunk).digest('hex') })
  }
  closeSync(fd)
  manifest.files.push({ name, size, sha256: whole.digest('hex'), parts })
  console.log(`${name}: ${(size / 1e6).toFixed(1)} MB → ${parts.length} parts`)
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`manifest → ${join(outDir, 'manifest.json')}`)
