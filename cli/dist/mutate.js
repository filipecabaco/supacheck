// Real-code mutation: take correct chunks from permissively licensed training repos and inject one
// anti-pattern each, keeping real repo facts. Original = negative, mutation = positive, for that rule.
// Closes the synthetic→real gap: same code style, imports, facts and noise as what the CLI will see.
//   CORPUS=<clones> pnpm tsx src/mutate.ts > ../data/generated/mutations.jsonl
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';
import { chunksFor, withFacts } from './chunks.js';
import { buildFacts, key } from './facts.js';
import { buildTsFacts, factsFor } from './tsfacts.js';
import { selectTrueOnPrivate, sqlFactLines } from './checks.js';
const TRAIN_REPOS = ['vercel__nextjs-subscription-payments', 'makerkit__nextjs-saas-starter-kit-lite', 'imbhargav5__nextbase-nextjs-supabase-starter',
    'usebasejump__basejump', 'devtodollars__mvp-boilerplate', 'ShenSeanChen__launch-mvp-stripe-nextjs-supabase', 'Razikus__supabase-nextjs-template',
    'ibelick__zola', 'matiasbattocchia__open-bsp-api', 'supabase__supabase', 'vercel__next.js'];
const corpus = process.env.CORPUS;
const readLines = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
// CORPUS2: extra permissive repos from scripts/corpus_discover.exs (owner__repo dirs; gold repos already excluded)
// Eval-only repos (no permissive licence) are gold labels only: never mutate them into training rows.
const evalOnly = new Set([
    ...readLines(join(import.meta.dirname, '../../data/gold/eval-only-repos.txt')),
    ...(process.env.CORPUS2 ? readLines(join(process.env.CORPUS2, 'manifest.jsonl')).map((l) => JSON.parse(l)).filter((m) => m.eval_only).map((m) => m.repo) : []),
].map((r) => r.replace('/', '__')));
const extra = process.env.CORPUS2 && existsSync(process.env.CORPUS2)
    ? readdirSync(process.env.CORPUS2).filter((d) => d.includes('__') && !evalOnly.has(d)).map((d) => join(process.env.CORPUS2, d)) : [];
const repoDirs = [...TRAIN_REPOS.map((r) => join(corpus, r)), ...extra];
let n = 0;
const emit = (rule, label, state, repo, kind) => console.log(JSON.stringify({ id: `mut${n++}`, rule, label, soft: label, family: `mutation:${kind}`, framework: 'real', resource: repo, split: 'train', state }));
const parses = (code) => !parseSync('m.tsx', code, { sourceType: 'module', lang: 'tsx' }).errors.length;
for (const dir of repoDirs) {
    const repo = dir.split('/').pop();
    const sql = await buildFacts(dir);
    const ts = buildTsFacts(dir);
    // SQL: owner-scoped policies → always true / signed-in only
    for (const p of sql.policies) {
        const owner = /using\s*\(([\s\S]*auth\.uid\(\)[\s\S]*)\)\s*(with check|;|$)/i.exec(p.text);
        const t = sql.tables.get(key(p.schema, p.table));
        if (!owner || !t)
            continue;
        const chunk = (await chunksFor(join(dir, p.file), { displayPath: p.file })).find((c) => c.line === p.line);
        if (!chunk)
            continue;
        const base = withFacts(chunk.state, sqlFactLines(sql, p.file, p.line));
        const header = chunk.state.split('\n---\n')[0];
        for (const [rule, replacement] of [['policy-authenticated-not-authorized', 'auth.uid() is not null'], ...(p.cmd === 'select' || p.cmd === 'all' ? [['select-true-on-private-data', 'true']] : [])]) {
            const mutatedText = p.text.replace(owner[1], replacement);
            const facts = rule === 'select-true-on-private-data'
                ? selectTrueOnPrivate({ ...p, qualTrue: true, text: mutatedText }, sql).because
                : sqlFactLines(sql, p.file, p.line);
            emit(rule, 0, base, repo, 'sql-original');
            emit(rule, 1, withFacts(`${header}\n---\n${chunk.state.split('\n---\n')[1].replace(p.text, mutatedText)}`, facts), repo, `sql-${rule}`);
        }
    }
    // SQL: signup triggers with a literal role → role copied from user-writable metadata
    for (const fn of sql.history) {
        if (!fn.trigger || !/insert\s+into/i.test(fn.body))
            continue;
        const lit = /(['"])(member|user|client|customer|student|viewer|basic)\1/i.exec(fn.body);
        if (!lit)
            continue;
        const chunk = (await chunksFor(join(dir, fn.file), { displayPath: fn.file })).find((c) => c.line === fn.line);
        if (!chunk)
            continue;
        const facts = sqlFactLines(sql, fn.file, fn.line);
        const mutated = chunk.state.replace(lit[0], `coalesce(new.raw_user_meta_data ->> 'role', ${lit[0]})`);
        if (mutated === chunk.state)
            continue;
        emit('user-metadata-for-authorization', 0, withFacts(chunk.state, facts), repo, 'sql-original');
        emit('user-metadata-for-authorization', 1, withFacts(mutated, facts), repo, 'sql-trigger-role');
    }
    // TS: getUser → getSession, user-scoped client → service-role client
    for (const [abs, mod] of ts.mods) {
        if (ts.side.get(abs) === 'client' || !/auth\.getUser\(\)|createClient\(|createServerClient\(/.test(mod.code))
            continue;
        const file = abs.slice(dir.length + 1);
        for (const chunk of await chunksFor(abs, { displayPath: file })) {
            if (chunk.kind === 'client')
                continue;
            const [header, code] = chunk.state.split('\n---\n');
            const facts = factsFor(ts, file, chunk.state);
            const m = /const \{\s*data:\s*\{\s*user\s*\}[^}]*\}\s*=\s*await (\w+)\.auth\.getUser\(\)/.exec(code);
            if (m && /\buser\??\.id\b/.test(code)) {
                const mutated = code.replace(m[0], `const { data: { session } } = await ${m[1]}.auth.getSession()`)
                    .replace(/\buser\?\.id\b/g, 'session?.user.id').replace(/\buser\.id\b/g, 'session.user.id').replace(/!user\b/g, '!session');
                if (parses(mutated)) {
                    emit('server-trusts-getsession', 0, withFacts(chunk.state, facts), repo, 'ts-original');
                    emit('server-trusts-getsession', 1, withFacts(`${header}\n---\n${mutated}`, facts), repo, 'ts-getsession');
                }
            }
            // Edge Functions: drop the caller verification so body-supplied ids are trusted
            if (chunk.kind === 'edge-function' && /auth\.getUser\(/.test(code) && /req\.json\(\)/.test(code)) {
                const mutated = code.split('\n').filter((l) => !/auth\.getUser\(/.test(l) && !/^\s*if\s*\(.*!user\b.*\)\s*(return|throw)/.test(l)).join('\n');
                if (mutated !== code && parses(mutated)) {
                    emit('ef-service-role-trusts-body-identity', 0, withFacts(chunk.state, facts), repo, 'ts-original');
                    emit('ef-service-role-trusts-body-identity', 1, withFacts(`${header}\n---\n${mutated}`, facts), repo, 'ts-ef-unverified');
                }
            }
            // .maybeSingle() followed by a null check → .single() (zero rows is legitimate here)
            if (/\.maybeSingle\(\)/.test(code) && /if\s*\(\s*!\w+/.test(code)) {
                const mutated = code.replace('.maybeSingle()', '.single()');
                emit('single-where-maybe-single', 1, withFacts(`${header}\n---\n${mutated}`, facts), repo, 'ts-single');
            }
            // real negatives: insert/update/upsert ... .select().single()
            if (/\.(insert|update|upsert)\([\s\S]{0,200}?\.select\([^)]*\)\s*\.single\(\)/.test(code) && !/\.maybeSingle\(\)/.test(code))
                emit('single-where-maybe-single', 0, withFacts(chunk.state, facts), repo, 'ts-original');
            const client = /const (\w+) = (await )?create(Server)?Client\([^)]*\)/.exec(code);
            if (client && new RegExp(`${client[1]}\\s*\\.from\\(`).test(code) && /\.eq\([^)]*\b(user\??\.id|claims\??\.sub|userId)\b/.test(code)) {
                const mutated = code.replace(client[0], `const ${client[1]} = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)`);
                if (parses(mutated)) {
                    emit('admin-client-for-user-scoped-work', 0, withFacts(chunk.state, facts), repo, 'ts-original');
                    emit('admin-client-for-user-scoped-work', 1, withFacts(`${header}\n---\n${mutated}`, facts), repo, 'ts-admin');
                }
            }
        }
    }
}
console.error(`emitted ${n} rows`);
