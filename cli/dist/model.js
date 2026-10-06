// Model distribution via GitHub Releases: a release holds manifest.json plus files split into
// <=95 MB parts. On first use the CLI downloads parts in parallel, verifies every sha256, reassembles
// and caches under ~/.cache/supacheck/models/<tag>/. Already-downloaded parts are kept (resume).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
export const DEFAULT_MODEL = { repo: process.env.SUPACHECK_MODEL_REPO ?? 'filipecabaco/supacheck', tag: process.env.SUPACHECK_MODEL_TAG ?? 'model-latest' };
const cacheRoot = () => process.env.SUPACHECK_CACHE ?? join(homedir(), '.cache', 'supacheck', 'models');
const sha256File = async (path) => {
    const h = createHash('sha256');
    await pipeline(createReadStream(path), h);
    return h.digest('hex');
};
/** Local directory with the verified model files, downloading the release on first use. */
export async function ensureModel(repo = DEFAULT_MODEL.repo, tag = DEFAULT_MODEL.tag, log = (m) => process.stderr.write(m + '\n')) {
    const dir = join(cacheRoot(), tag);
    const marker = join(dir, '.complete');
    if (existsSync(marker))
        return { dir, manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) };
    mkdirSync(join(dir, '.parts'), { recursive: true });
    const base = `https://github.com/${repo}/releases/download/${tag}`;
    const res = await fetch(`${base}/manifest.json`);
    if (!res.ok)
        throw new Error(`model manifest not found at ${base}/manifest.json (${res.status})`);
    const manifest = await res.json();
    const parts = manifest.files.flatMap((f) => f.parts);
    const total = parts.reduce((n, p) => n + p.size, 0);
    let done = parts.filter((p) => partOk(dir, p)).reduce((n, p) => n + p.size, 0);
    log(`supacheck: downloading model ${tag} (${(total / 1e6).toFixed(0)} MB, ${parts.length} parts)…`);
    const queue = parts.filter((p) => !partOk(dir, p));
    const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
            const target = join(dir, '.parts', p.asset);
            for (let attempt = 1;; attempt++) {
                try {
                    const r = await fetch(`${base}/${p.asset}`);
                    if (!r.ok || !r.body)
                        throw new Error(`HTTP ${r.status}`);
                    await pipeline(Readable.fromWeb(r.body), createWriteStream(target + '.tmp'));
                    if ((await sha256File(target + '.tmp')) !== p.sha256)
                        throw new Error('checksum mismatch');
                    renameSync(target + '.tmp', target);
                    writeFileSync(target + '.ok', p.sha256);
                    done += p.size;
                    log(`  ${(100 * done / total).toFixed(0)}%  ${p.asset}`);
                    break;
                }
                catch (e) {
                    if (attempt >= 3)
                        throw new Error(`failed to download ${p.asset}: ${e.message}`);
                }
            }
        }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    for (const f of manifest.files) {
        const out = join(dir, f.name);
        const tmp = out + '.tmp';
        rmSync(tmp, { force: true });
        for (const p of f.parts)
            await pipeline(createReadStream(join(dir, '.parts', p.asset)), createWriteStream(tmp, { flags: 'a' }));
        if ((await sha256File(tmp)) !== f.sha256)
            throw new Error(`reassembled ${f.name} failed checksum`);
        renameSync(tmp, out);
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    rmSync(join(dir, '.parts'), { recursive: true, force: true });
    writeFileSync(marker, new Date().toISOString());
    log(`supacheck: model ready (${dir})`);
    return { dir, manifest };
}
function partOk(dir, p) {
    const f = join(dir, '.parts', p.asset);
    return existsSync(f) && existsSync(f + '.ok') && statSync(f).size === p.size && readFileSync(f + '.ok', 'utf8') === p.sha256;
}
