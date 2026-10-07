// Model distribution via GitHub Releases: a release holds manifest.json plus files split into
// <=95 MB parts. On first use the CLI downloads parts in parallel, verifies every sha256, reassembles
// and caches under ~/.cache/supacheck/models/<tag>/. Already-downloaded parts are kept (resume).
// Release tags are immutable: the cache is keyed by tag, so a new model ships under a new tag (bump MODEL_TAG).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
/** The model release this CLI version was validated against. */
export const MODEL_TAG = 'model-laya-v1';
export const DEFAULT_MODEL = { repo: process.env.SUPACHECK_MODEL_REPO ?? 'filipecabaco/supacheck', tag: process.env.SUPACHECK_MODEL_TAG ?? MODEL_TAG };
const MANIFEST_TIMEOUT = 15_000;
/** A part that sends no bytes for this long is aborted and retried, instead of hanging the run. */
const STALL_TIMEOUT = 20_000;
const ATTEMPTS = 5;
const STALE_LOCK = 30 * 60_000;
const cacheRoot = () => process.env.SUPACHECK_CACHE ?? join(homedir(), '.cache', 'supacheck', 'models');
const sha256File = async (path) => {
    const h = createHash('sha256');
    await pipeline(createReadStream(path), h);
    return h.digest('hex');
};
const modelBytes = (m) => m.files.reduce((n, f) => n + f.size, 0);
/** Local directory with the verified model files, downloading the release on first use. */
/** onEvent: step-by-step progress for interactive front-ends; when given, the text log is off by default. */
export async function ensureModel(repo = DEFAULT_MODEL.repo, tag = DEFAULT_MODEL.tag, log, onEvent) {
    log ??= onEvent ? () => { } : (m) => process.stderr.write(m + '\n');
    const emit = onEvent ?? (() => { });
    const dir = join(cacheRoot(), tag);
    const marker = join(dir, '.complete');
    const ready = () => {
        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        emit({ step: 'cached', tag, dir, bytes: modelBytes(manifest) });
        return { dir, manifest };
    };
    if (existsSync(marker))
        return ready();
    // One downloader per tag: concurrent runs (CLI + MCP + hooks) wait for it instead of racing on the same files.
    // The lock holds the owner's pid, so a lock left by a killed run is taken over at once rather than after STALE_LOCK.
    mkdirSync(cacheRoot(), { recursive: true });
    const lock = dir + '.lock';
    for (let waiting = false;;) {
        try {
            mkdirSync(lock);
            writeFileSync(join(lock, 'pid'), String(process.pid));
            break;
        }
        catch { }
        if (existsSync(marker))
            return ready();
        const pid = lockOwner(lock);
        let stale = pid !== undefined && !alive(pid);
        try {
            stale ||= Date.now() - statSync(lock).mtimeMs > STALE_LOCK;
        }
        catch { }
        if (stale) {
            rmSync(lock, { recursive: true, force: true });
            continue;
        }
        if (!waiting) {
            waiting = true;
            emit({ step: 'wait', tag, pid });
            log(`supacheck: waiting for another supacheck${pid ? ` (pid ${pid})` : ''} to finish downloading the model…`);
        }
        await sleep(1000);
    }
    try {
        if (existsSync(marker))
            return ready();
        return await download(dir, repo, tag, log, emit);
    }
    finally {
        rmSync(lock, { recursive: true, force: true });
    }
}
function lockOwner(lock) {
    try {
        return Number(readFileSync(join(lock, 'pid'), 'utf8')) || undefined;
    }
    catch {
        return undefined;
    }
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
async function download(dir, repo, tag, log, emit) {
    const marker = join(dir, '.complete');
    mkdirSync(join(dir, '.parts'), { recursive: true });
    const base = process.env.SUPACHECK_MODEL_URL ?? `https://github.com/${repo}/releases/download/${tag}`; // override: mirrors, tests
    emit({ step: 'manifest', tag, url: base });
    const res = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT) });
    if (!res.ok)
        throw new Error(`model manifest not found at ${base}/manifest.json (${res.status})`);
    const manifest = await res.json();
    const parts = manifest.files.flatMap((f) => f.parts);
    const total = parts.reduce((n, p) => n + p.size, 0);
    const queue = parts.filter((p) => !partOk(dir, p));
    let done = total - queue.reduce((n, p) => n + p.size, 0);
    const resumed = done;
    let partsDone = parts.length - queue.length;
    let inflight = 0; // bytes of parts still downloading
    const progress = () => emit({ step: 'download', tag, bytes: done + inflight, total, parts: parts.length, partsDone, resumed });
    progress();
    log(`supacheck: downloading model ${tag} (${(total / 1e6).toFixed(0)} MB, ${parts.length} parts${resumed ? `, ${(resumed / 1e6).toFixed(0)} MB already here` : ''})…`);
    const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) {
            const target = join(dir, '.parts', p.asset);
            for (let attempt = 1;; attempt++) {
                let got = 0;
                const abort = new AbortController();
                let idle;
                const arm = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(new Error(`stalled: no data for ${STALL_TIMEOUT / 1000}s`)), STALL_TIMEOUT); };
                try {
                    arm();
                    const r = await fetch(`${base}/${p.asset}`, { signal: abort.signal });
                    if (!r.ok || !r.body)
                        throw new Error(`HTTP ${r.status}`);
                    const body = Readable.fromWeb(r.body);
                    body.on('data', (c) => { arm(); got += c.length; inflight += c.length; progress(); });
                    await pipeline(body, createWriteStream(target + '.tmp'));
                    if ((await sha256File(target + '.tmp')) !== p.sha256)
                        throw new Error('checksum mismatch');
                    renameSync(target + '.tmp', target);
                    writeFileSync(target + '.ok', p.sha256);
                    try {
                        utimesSync(dir + '.lock', new Date(), new Date());
                    }
                    catch { } // keep the lock fresh on slow links
                    done += p.size;
                    partsDone++;
                    log(`  ${(100 * done / total).toFixed(0)}%  ${p.asset}`);
                    break;
                }
                catch (e) {
                    const reason = abort.signal.aborted ? abort.signal.reason.message : e.message;
                    if (attempt >= ATTEMPTS)
                        throw new Error(`failed to download ${p.asset}: ${reason}`);
                    emit({ step: 'retry', asset: p.asset, attempt: attempt + 1, of: ATTEMPTS, reason });
                    log(`  retrying ${p.asset} (${reason})`);
                    await sleep(1000 * attempt);
                }
                finally {
                    clearTimeout(idle);
                    inflight -= got;
                    progress();
                }
            }
        }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    for (const [i, f] of manifest.files.entries()) {
        emit({ step: 'assemble', file: f.name, index: i + 1, count: manifest.files.length, bytes: f.size });
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
    emit({ step: 'ready', tag, dir, bytes: modelBytes(manifest) });
    log(`supacheck: model ready (${dir})`);
    return { dir, manifest };
}
function partOk(dir, p) {
    const f = join(dir, '.parts', p.asset);
    return existsSync(f) && existsSync(f + '.ok') && statSync(f).size === p.size && readFileSync(f + '.ok', 'utf8') === p.sha256;
}
