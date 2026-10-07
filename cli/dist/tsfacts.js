// TypeScript facts from the import graph: which files are server-only, what imported Supabase
// helpers actually do, and Edge Function verify_jwt settings. Stated in words next to a chunk.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';
import { tsContext } from './chunks.js';
const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage']);
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
export function buildTsFacts(dir, files) {
    // modules are keyed by absolute path (factsFor resolves against root): a relative root would match nothing
    const root = resolve(dir);
    const mods = new Map();
    for (const file of (files ?? walk(root)).map((f) => resolve(f))) {
        const code = readFileSync(file, 'utf8');
        const parsed = parseSync(file, code, { sourceType: 'module', lang: file.endsWith('x') ? 'tsx' : 'ts' });
        const imports = [];
        const exports = new Map();
        for (const n of parsed.program.body) {
            if (n.type === 'ImportDeclaration')
                imports.push({ from: n.source.value, names: (n.specifiers ?? []).map((s) => s.local?.name).filter(Boolean) });
            const decl = n.type === 'ExportNamedDeclaration' ? n.declaration : n.type === 'ExportDefaultDeclaration' ? n.declaration : undefined;
            if (decl?.id?.name)
                exports.set(decl.id.name, code.slice(decl.start, decl.end));
            for (const d of decl?.declarations ?? [])
                if (d.id?.name)
                    exports.set(d.id.name, code.slice(d.start, d.end));
        }
        const ctx = tsContext(relative(root, file), code);
        const own = /^\s*['"]use client['"]/.test(code) ? 'client'
            : ctx.kind === 'server' || ctx.kind === 'edge-function' || imports.some((i) => /^(server-only|next\/headers|next\/server)$/.test(i.from)) ? 'server' : undefined;
        mods.set(file, { file, code, imports, exports, own });
    }
    // Unsignalled modules inherit from importers: only server importers → server; any client → shared/client.
    const importers = new Map();
    for (const m of mods.values())
        for (const i of m.imports) {
            const target = resolveImport(root, m.file, i.from);
            if (target)
                importers.set(target, [...(importers.get(target) ?? []), m.file]);
        }
    const side = new Map();
    for (const m of mods.values())
        side.set(m.file, m.own ?? 'unknown');
    for (let pass = 0; pass < 6; pass++) {
        for (const m of mods.values()) {
            if (m.own)
                continue;
            const from = (importers.get(m.file) ?? []).map((f) => side.get(f));
            if (!from.length || from.includes('unknown'))
                continue;
            side.set(m.file, from.every((s) => s === 'server') ? 'server' : from.every((s) => s === 'client') ? 'client' : 'shared');
        }
    }
    return { mods, side, verifyJwt: verifyJwtSettings(root), root };
}
/** Sentences about a chunk: file side, what imported helpers do, verify_jwt for Edge Functions. */
export function factsFor(tf, file, chunkText) {
    const abs = resolve(tf.root, file);
    const mod = tf.mods.get(abs);
    if (!mod)
        return [];
    const out = [];
    const side = tf.side.get(abs);
    if (!mod.own && side && side !== 'unknown')
        out.push(`${file} is ${side === 'shared' ? 'imported by both server and client code' : `${side}-only (inferred from its importers)`}`);
    for (const i of mod.imports) {
        const target = resolveImport(tf.root, abs, i.from);
        const helper = target && tf.mods.get(target);
        if (!helper)
            continue;
        for (const name of i.names) {
            if (!new RegExp(`\\b${name}\\b`).test(chunkText.split('\n---\n').pop().replace(/^import .*$/gm, '')))
                continue;
            const body = helper.exports.get(name);
            const what = body && describe(body);
            if (what)
                out.push(`imported ${name} (${relative(tf.root, target)}) ${what}`);
        }
    }
    const fn = /supabase\/functions\/([^/]+)\//.exec(file)?.[1];
    if (fn && tf.verifyJwt.has(fn))
        out.push(`config.toml sets verify_jwt = ${tf.verifyJwt.get(fn)} for function ${fn}`);
    return out;
}
function describe(body) {
    if (/SERVICE_ROLE|service_role|SUPABASE_SECRET|sb_secret/.test(body))
        return 'creates a Supabase service-role client that bypasses RLS';
    if (/auth\.getSession\(/.test(body) && !/auth\.(getUser|getClaims)\(/.test(body))
        return 'returns the session from auth.getSession() without verifying the JWT';
    if (/auth\.(getUser|getClaims)\(/.test(body))
        return 'verifies the user with auth.getUser()/getClaims()';
    if (/create(Server|Browser)Client\(/.test(body))
        return 'creates a user-scoped client (anon/publishable key, RLS applies)';
    return undefined;
}
function verifyJwtSettings(root) {
    const out = new Map();
    const cfg = join(root, 'supabase/config.toml');
    if (!existsSync(cfg))
        return out;
    for (const m of readFileSync(cfg, 'utf8').matchAll(/\[functions\.([\w-]+)\][^[]*?verify_jwt\s*=\s*(true|false)/g))
        out.set(m[1], m[2] === 'true');
    return out;
}
const aliasCache = new Map();
function resolveImport(root, from, spec) {
    let base;
    if (spec.startsWith('.'))
        base = resolve(dirname(from), spec);
    else
        for (const [prefix, target] of aliases(root, from))
            if (spec.startsWith(prefix)) {
                base = join(target, spec.slice(prefix.length));
                break;
            }
    if (!base)
        return undefined;
    for (const ext of EXTS) {
        const p = base + ext;
        try {
            if (lstatSync(p).isFile())
                return p;
        }
        catch { }
    }
    return undefined;
}
/** tsconfig "paths" of the nearest tsconfig.json (e.g. "@/*": ["./src/*"]), plus common defaults. */
function aliases(root, file) {
    let dir = dirname(file);
    while (dir.startsWith(root)) {
        const cfg = join(dir, 'tsconfig.json');
        if (existsSync(cfg)) {
            if (!aliasCache.has(cfg)) {
                const out = [];
                try {
                    const json = JSON.parse(readFileSync(cfg, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
                    const baseUrl = resolve(dir, json.compilerOptions?.baseUrl ?? '.');
                    for (const [k, v] of Object.entries(json.compilerOptions?.paths ?? {}))
                        out.push([k.replace('*', ''), resolve(baseUrl, v[0].replace('*', ''))]);
                }
                catch { }
                out.push(['@/', join(dir, 'src')], ['~/', join(dir, 'app')]);
                aliasCache.set(cfg, out);
            }
            return aliasCache.get(cfg);
        }
        dir = dirname(dir);
    }
    return [];
}
function walk(dir) {
    let out = [];
    for (const f of readdirSync(dir)) {
        if (SKIP.has(f))
            continue;
        const p = join(dir, f);
        let st;
        try {
            st = lstatSync(p);
        }
        catch {
            continue;
        }
        if (st.isSymbolicLink())
            continue;
        if (st.isDirectory())
            out = out.concat(walk(p));
        else if (/\.(tsx?|jsx?)$/.test(f) && !/\.(test|spec|d)\.[tj]sx?$/.test(f))
            out.push(p);
    }
    return out;
}
