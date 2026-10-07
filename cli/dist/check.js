// Core check: facts-engine rules always run; model rules only with --model / --model-dir.
// Shared by the CLI (text/json/sarif) and the MCP server.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { chunksFor, withFacts } from './chunks.js';
import { buildFacts } from './facts.js';
import { buildTsFacts, factsFor } from './tsfacts.js';
import { alwaysTrueWrite, definerNoCallerCheck, firstSignupAdmin, rlsDisabled, serviceRolePolicyWithoutTo, grantWriteWithoutRls, missingGrants, policyAuthenticated, selectTrueOnPrivate, singleVerdict, sqlFactLines, suppressedBy, tsExtraVerdicts, tsRuleVerdict, userMetadataSql, userMetadataTs } from './checks.js';
import { applicable, loadRules } from './rules.js';
import { ensureModel } from './model.js';
import { loadScorer } from './scorer.js';
/** Rules ship next to dist/ in the package; fall back to the repo's rules/ during development. */
export function defaultRulesDir() {
    for (const d of [resolve(import.meta.dirname, '../rules'), resolve(import.meta.dirname, '../../rules')])
        if (existsSync(d))
            return d;
    throw new Error('rules directory not found');
}
export async function runCheck(root, opts = {}) {
    const projectRoot = resolve(root);
    const rules = loadRules(opts.rulesDir ?? defaultRulesDir());
    const byId = new Map(rules.map((r) => [r.id, r]));
    const findings = [];
    const files = listFiles(projectRoot);
    const progress = opts.onProgress ?? (() => { });
    // One fact store per Supabase project: SQL never mixes across projects (monorepos, vendored examples)
    const groups = new Map();
    for (const f of files.filter((x) => x.endsWith('.sql'))) {
        const root = supabaseRoot(f, projectRoot);
        groups.set(root, [...(groups.get(root) ?? []), f]);
    }
    const sqlCount = [...groups.values()].reduce((n, g) => n + g.length, 0);
    progress({ stage: 'sql', done: false, files: sqlCount });
    const stores = [];
    for (const [root, sqlFiles] of groups)
        stores.push(await buildFacts(root, sqlFiles, projectRoot));
    progress({ stage: 'sql', done: true, files: sqlCount, projects: stores.length,
        tables: stores.reduce((n, s) => n + s.tables.size, 0), policies: stores.reduce((n, s) => n + s.policies.length, 0), functions: stores.reduce((n, s) => n + s.functions.size, 0) });
    const base = (r) => ({ severity: r.severity, message: r.message, fix: r.fix, avoid: r.avoid ?? [], docs_url: r.docs_url });
    const report = (id, file, line, because) => {
        const r = byId.get(id);
        if (r)
            findings.push({ rule_id: id, engine: 'facts', file, line, because, ...base(r) });
    };
    for (const sql of stores) {
        const on = (id) => { const e = String(byId.get(id)?.engine ?? ''); return e === 'facts' || (e === 'facts-experimental' && !!opts.experimental); };
        for (const fn of sql.functions.values()) {
            const v = definerNoCallerCheck(fn, sql);
            if (v.flagged)
                report('definer-function-no-caller-check', fn.file, fn.line, v.because);
            const a = firstSignupAdmin(fn);
            if (a.flagged && on('first-signup-becomes-admin'))
                report('first-signup-becomes-admin', fn.file, fn.line, a.because);
            const u = userMetadataSql(fn.text);
            if (u?.flagged && on('user-metadata-for-authorization'))
                report('user-metadata-for-authorization', fn.file, fn.line, u.because);
        }
        for (const p of sql.policies) {
            const v = selectTrueOnPrivate(p, sql);
            if (v.flagged)
                report('select-true-on-private-data', p.file, p.line, v.because);
            const sr = serviceRolePolicyWithoutTo(p);
            if (sr.flagged)
                report('service-role-policy-without-to', p.file, p.line, sr.because);
            else {
                const w = alwaysTrueWrite(p);
                if (w.flagged)
                    report('rls-policy-always-true-write', p.file, p.line, w.because);
            }
            const pa = policyAuthenticated(p, sql);
            if (pa?.owner.flagged && on('policy-authenticated-not-authorized'))
                report('policy-authenticated-not-authorized', p.file, p.line, pa.owner.because);
            if (pa?.team.flagged && on('team-wide-access-confirm-signup'))
                report('team-wide-access-confirm-signup', p.file, p.line, pa.team.because);
            const u = userMetadataSql(p.text);
            if (u?.flagged && on('user-metadata-for-authorization'))
                report('user-metadata-for-authorization', p.file, p.line, u.because);
        }
        for (const t of sql.tables.values()) {
            // tables created before the 2026-10-30 default change were auto-granted when they were created
            const stamp = Number(/(\d{14})_/.exec(t.file)?.[1] ?? 0);
            const affected = opts.allGrants || stamp >= 20261030000000 || !/migrations\//.test(t.file);
            const g = missingGrants(t, sql);
            if (g.flagged && affected)
                report('missing-api-grants-new-table', t.file, t.line, g.because);
            const w = grantWriteWithoutRls(t, sql);
            if (w.flagged)
                report('grant-write-without-rls', t.file, t.line, w.because);
            else {
                const d = rlsDisabled(t, sql);
                if (d.flagged)
                    report('rls-disabled-on-exposed-table', t.file, t.line, d.because);
            }
        }
    }
    const codeFiles = files.filter((f) => !f.endsWith('.sql'));
    progress({ stage: 'code', done: false, files: codeFiles.length });
    await new Promise((r) => setImmediate(r)); // let the progress line paint before the synchronous TS pass
    const ts = buildTsFacts(projectRoot, codeFiles);
    const sqlFor = (rel) => stores.find((st) => st.policies.some((p) => p.file === rel) || st.history.some((fn) => fn.file === rel) || [...st.tables.values()].some((t) => t.file === rel));
    // TS rules decided by facts + code (getSession always; edge-function/admin-client while below the bar: --experimental)
    const tsRules = rules.filter((r) => r.engine === 'facts' || (r.engine === 'facts-experimental' && opts.experimental))
        .filter((r) => r.domain === 'sdk' || r.id === 'user-metadata-for-authorization');
    for (const file of codeFiles) {
        for (const chunk of await chunksFor(file)) {
            const rel = relative(projectRoot, resolve(chunk.file));
            const facts = factsFor(ts, rel, chunk.state);
            const state = withFacts(chunk.state, facts);
            const code = chunk.state.split('\n---\n').slice(1).join('\n---\n');
            for (const r of tsRules) {
                const v = r.id === 'user-metadata-for-authorization' ? userMetadataTs(code)
                    : r.id === 'single-where-maybe-single' ? singleVerdict(chunk.state)
                        : r.id === 'service-role-in-request-handler' || r.id === 'cross-tenant-id-from-body' ? tsExtraVerdicts(r.id, state, facts, chunk.kind)
                            : tsRuleVerdict(r.id, state, facts, chunk.kind);
                if (v?.flagged)
                    findings.push({ rule_id: r.id, engine: 'facts', file: rel, line: chunk.line, because: v.because, facts, ...base(r) });
            }
        }
    }
    progress({ stage: 'code', done: true, files: codeFiles.length, rules: new Set([...rules.filter((r) => { const e = String(r.engine ?? ''); return e === 'facts' || (e === 'facts-experimental' && !!opts.experimental); }).map((r) => r.id)]).size });
    // Model (opt-in): judgement calls facts can't settle. Fetched once from the GitHub Release (cached), or a local dir.
    const scorer = opts.model || opts.modelDir ? await loadModelScorer(opts.modelDir, opts.rulesDir ?? defaultRulesDir(), progress) : undefined;
    if (scorer) {
        const modelRules = rules.filter((r) => scorer.rules.includes(r.id) && r.engine !== 'facts');
        // Chunks asking the same rules share one forward pass per batch
        const groups = new Map();
        for (const file of files) {
            for (const chunk of await chunksFor(file)) {
                const asked = modelRules.filter((r) => applicable(r, chunk));
                if (!asked.length)
                    continue;
                const rel = relative(projectRoot, resolve(chunk.file));
                const st = rel.endsWith('.sql') ? sqlFor(rel) : undefined;
                const facts = rel.endsWith('.sql') ? (st ? sqlFactLines(st, rel, chunk.line) : []) : factsFor(ts, rel, chunk.state);
                const state = withFacts(chunk.state, facts);
                const open = asked.filter((r) => !suppressedBy(r.id, state, facts));
                if (!open.length)
                    continue;
                const key = open.map((r) => r.id).join(',');
                groups.set(key, [...(groups.get(key) ?? []), { rel, line: chunk.line, facts, state, open }]);
            }
        }
        const total = [...groups.values()].reduce((n, j) => n + j.length, 0);
        let scored = 0;
        progress({ stage: 'model', done: false, scored, total });
        for (const jobs of groups.values()) {
            // similar lengths together: a batch pads to its longest state
            jobs.sort((a, b) => a.state.length - b.state.length);
            const ids = jobs[0].open.map((r) => r.id);
            for (let i = 0; i < jobs.length; i += MODEL_BATCH) {
                const batch = jobs.slice(i, i + MODEL_BATCH);
                const probs = await scorer.scoreBatch(batch.map((j) => j.state), ids);
                batch.forEach((j, k) => {
                    for (const r of j.open) {
                        const p = probs[k][r.id];
                        const threshold = scorer.thresholds[r.id] ?? 0.5;
                        if (p >= threshold)
                            findings.push({ rule_id: r.id, engine: 'model', file: j.rel, line: j.line, facts: j.facts, probability: round(p), threshold: round(threshold), ...base(r) });
                    }
                });
                scored += batch.length;
                progress({ stage: 'model', done: false, scored, total });
            }
        }
        progress({ stage: 'model', done: true, scored, rules: modelRules.length });
    }
    return { files: files.length, findings: dedupe(findings) };
}
/** Info rules report once per table (team-wide) or once per file (service-role), not once per statement. */
function dedupe(findings) {
    const seen = new Set();
    return findings.filter((f) => {
        const k = f.rule_id === 'team-wide-access-confirm-signup' ? `${f.rule_id}#${f.because?.find((b) => /table/.test(b)) ?? ''}#${f.file}`
            : f.rule_id === 'service-role-in-request-handler' ? `${f.rule_id}#${f.file}`
                : `${f.rule_id}#${f.file}#${f.line}`;
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
}
/** Nearest ancestor (within the scan root) that holds a supabase/ project; else the file's own directory. */
function supabaseRoot(file, scanRoot) {
    let dir = dirname(file);
    while (dir.startsWith(scanRoot)) {
        if (existsSync(join(dir, 'supabase', 'config.toml')) || existsSync(join(dir, 'supabase', 'migrations')))
            return dir;
        if (dir === scanRoot)
            break;
        dir = dirname(dir);
    }
    const m = /^(.*)\/supabase\/(migrations|schemas)\//.exec(file);
    return m ? m[1] : dirname(file);
}
/** Files git tracks or would track (respects .gitignore), minus .supacheckignore; falls back to a walk. */
export function listFiles(root) {
    let files;
    try {
        const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        files = out.split('\n').filter(Boolean).map((f) => join(root, f)).filter((f) => /\.(tsx?|jsx?|sql)$/.test(f) && !/\.(test|spec)\.[tj]sx?$/.test(f) && existsSync(f));
    }
    catch {
        files = walk(root);
    }
    const ignoreFile = join(root, '.supacheckignore');
    const ignores = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
    return files.filter((f) => !ignores.some((pat) => relative(root, f).startsWith(pat.replace(/^\//, '').replace(/\*+$/, ''))));
}
export function walk(p) {
    let st;
    try {
        st = lstatSync(p);
    }
    catch {
        return [];
    }
    if (st.isSymbolicLink())
        return [];
    if (st.isFile())
        return /\.(tsx?|jsx?|sql)$/.test(p) && !/\.(test|spec)\.[tj]sx?$/.test(p) ? [p] : [];
    return readdirSync(p).filter((f) => !['node_modules', '.git', 'dist', '.next', 'build'].includes(f)).flatMap((f) => walk(join(p, f)));
}
/** States per forward pass. 1 on CPU: ONNX Runtime already spreads one state over every core, and batching
 *  only adds padding (230-file bench: 294 s at 1, 311 s at 4 and 8). Raise it for GPU execution providers. */
const MODEL_BATCH = Math.max(1, Number(process.env.SUPACHECK_MODEL_BATCH) || 1);
const round = (x) => Math.round(x * 1000) / 1000;
/** The model was asked for explicitly, so failing to load it is an error rather than a silent facts-only run. */
export class ModelUnavailable extends Error {
}
async function loadModelScorer(modelDir, rulesDir, progress) {
    try {
        const dir = modelDir ?? (await ensureModel(undefined, undefined, undefined, (bytes, total) => progress({ stage: 'download', bytes, total }))).dir;
        return await loadScorer(dir, rulesDir);
    }
    catch (e) {
        throw new ModelUnavailable(`model unavailable: ${e.message.split('\n')[0]} (run without --model/--model-dir for facts-only rules)`);
    }
}
