// Fact store v0: replay a repo's SQL (migrations, declarative schemas) in path order and keep the
// facts single-chunk analysis can't see: RLS state, policies, function security/grants, exposed
// schemas, table columns. Rules combine these facts deterministically; the model only gets the
// genuinely fuzzy judgement (and these facts, in words, in its header).
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseSql } from 'libpg-query';
const CALLER = /auth\.(uid|jwt|role|email)\s*\(|current_user|session_user|request\.jwt\.claims?/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'tests', 'test', '__tests__', 'e2e']);
export async function buildFacts(repoDir) {
    const facts = { tables: new Map(), policies: [], functions: new Map(), history: [], exposed: exposedSchemas(repoDir), schemaGrants: new Map() };
    for (const file of sqlFiles(repoDir).sort()) {
        const rel = relative(repoDir, file);
        if (/seed|test|spec|fixture/i.test(rel))
            continue;
        for (const st of await statements(file))
            apply(facts, st, rel);
    }
    // A definer that calls a helper which checks the caller counts as checked (one level).
    const checkers = [...facts.functions.values()].filter((f) => CALLER.test(f.body)).map((f) => f.name);
    for (const f of facts.history) {
        f.callerChecked = CALLER.test(f.body) || checkers.some((n) => n !== f.name && new RegExp(`\\b${n}\\s*\\(`, 'i').test(f.body));
    }
    return facts;
}
export const key = (schema, name) => `${schema || 'public'}.${name}`.toLowerCase();
function apply(facts, { node, text, line }, file) {
    const [type, s] = Object.entries(node)[0];
    if (type === 'GrantStmt' && s.objtype === 'OBJECT_TABLE')
        return tableGrant(facts, s);
    if (type === 'AlterDefaultPrivilegesStmt' && s.action?.GrantStmt?.objtype === 'OBJECT_TABLE') {
        const schemas = (s.options ?? []).flatMap((o) => o.DefElem?.defname === 'schemas' ? (o.DefElem.arg?.List?.items ?? []).map((i) => i.String?.sval) : []);
        return tableGrant(facts, { ...s.action.GrantStmt, targtype: 'ACL_TARGET_ALL_IN_SCHEMA', objects: (schemas.length ? schemas : ['public']).map((n) => ({ String: { sval: n } })) });
    }
    if (type === 'CreateStmt') {
        const columns = (s.tableElts ?? []).map((e) => e.ColumnDef?.colname).filter(Boolean);
        // a column referencing auth.users marks the table as per-user data
        const ownerColumns = (s.tableElts ?? []).filter((e) => (e.ColumnDef?.constraints ?? []).some((c) => c.Constraint?.contype === 'CONSTR_FOREIGN' && c.Constraint?.pktable?.schemaname === 'auth' && c.Constraint?.pktable?.relname === 'users'))
            .map((e) => e.ColumnDef.colname);
        const t = { schema: s.relation.schemaname ?? 'public', name: s.relation.relname, columns, rls: false, ownerColumns, grants: new Map(), file, line };
        facts.tables.set(key(t.schema, t.name), t);
    }
    else if (type === 'AlterTableStmt') {
        const t = facts.tables.get(key(s.relation?.schemaname, s.relation?.relname));
        for (const c of s.cmds ?? []) {
            const cmd = c.AlterTableCmd;
            if (!t || !cmd)
                continue;
            if (cmd.subtype === 'AT_EnableRowSecurity' || cmd.subtype === 'AT_ForceRowSecurity')
                t.rls = true;
            if (cmd.subtype === 'AT_DisableRowSecurity')
                t.rls = false;
            if (cmd.subtype === 'AT_AddColumn' && cmd.def?.ColumnDef?.colname)
                t.columns.push(cmd.def.ColumnDef.colname);
        }
    }
    else if (type === 'CreatePolicyStmt') {
        const roles = (s.roles ?? []).map((r) => r.RoleSpec?.rolename ?? (r.RoleSpec?.roletype === 'ROLESPEC_PUBLIC' ? 'public' : '?'));
        // storage.objects policies that only filter on bucket_id don't restrict rows to the caller either
        const bucketOnly = s.table.relname === 'objects' && /using\s*\(\s*\(?\s*bucket_id\s*=\s*'[^']+'\s*\)?\s*\)/i.test(text);
        const qualTrue = s.qual?.A_Const?.boolval?.boolval === true || bucketOnly || /using\s*\(\s*\(?\s*(true|1\s*=\s*1)\s*\)?\s*\)/i.test(text);
        facts.policies.push({ schema: s.table.schemaname ?? 'public', table: s.table.relname, name: s.policy_name, cmd: s.cmd_name ?? 'all', roles, qualTrue, text, file, line });
    }
    else if (type === 'DropStmt' && s.removeType === 'OBJECT_POLICY') {
        for (const obj of s.objects ?? []) {
            const parts = (obj.List?.items ?? []).map((i) => i.String?.sval);
            const name = parts.at(-1), table = parts.at(-2);
            facts.policies = facts.policies.filter((p) => !(p.name === name && p.table === table));
        }
    }
    else if (type === 'CreateFunctionStmt') {
        const names = s.funcname.map((n) => n.String.sval);
        const opt = (n) => s.options?.find((o) => o.DefElem?.defname === n)?.DefElem?.arg;
        const body = opt('as')?.List?.items?.map((i) => i.String?.sval ?? '').join('\n') ?? '';
        const returns = (s.returnType?.names ?? []).map((n) => n.String?.sval).join('.');
        const fn = {
            schema: names.length > 1 ? names[0] : 'public', name: names.at(-1),
            params: (s.parameters ?? []).filter((p) => p.FunctionParameter?.mode !== 'FUNC_PARAM_OUT').map((p) => p.FunctionParameter?.name).filter(Boolean),
            definer: opt('security')?.Boolean?.boolval === true, trigger: /trigger/i.test(returns),
            body, file, line, text, revokedFrom: new Set(), grantedTo: new Set(),
        };
        // keep grants across redefinitions (create or replace), and every version for lookups by file/line
        const prev = facts.functions.get(key(fn.schema, fn.name));
        if (prev) {
            fn.revokedFrom = prev.revokedFrom;
            fn.grantedTo = prev.grantedTo;
        }
        facts.functions.set(key(fn.schema, fn.name), fn);
        facts.history.push(fn);
    }
    else if (type === 'GrantStmt' && s.objtype === 'OBJECT_FUNCTION') {
        const roles = (s.grantees ?? []).map((g) => g.RoleSpec?.rolename ?? (g.RoleSpec?.roletype === 'ROLESPEC_PUBLIC' ? 'public' : '?'));
        for (const o of s.objects ?? []) {
            const names = (o.ObjectWithArgs?.objname ?? []).map((n) => n.String.sval);
            const fn = facts.functions.get(key(names.length > 1 ? names[0] : 'public', names.at(-1)));
            if (!fn)
                continue;
            for (const r of roles) {
                if (s.is_grant) {
                    fn.grantedTo.add(r);
                    fn.revokedFrom.delete(r);
                }
                else {
                    fn.revokedFrom.add(r);
                    fn.grantedTo.delete(r);
                }
            }
        }
    }
}
function tableGrant(facts, s) {
    const roles = (s.grantees ?? []).map((g) => g.RoleSpec?.rolename ?? (g.RoleSpec?.roletype === 'ROLESPEC_PUBLIC' ? 'public' : '?'));
    const privs = s.privileges?.length ? s.privileges.map((p) => p.AccessPriv?.priv_name) : ['select', 'insert', 'update', 'delete'];
    const edit = (m) => {
        for (const r of roles) {
            const cur = m.get(r) ?? new Set();
            for (const p of privs)
                s.is_grant ? cur.add(p) : cur.delete(p);
            m.set(r, cur);
        }
    };
    if (s.targtype === 'ACL_TARGET_ALL_IN_SCHEMA') {
        for (const o of s.objects ?? []) {
            const schema = (o.String?.sval ?? 'public').toLowerCase();
            if (!facts.schemaGrants.has(schema))
                facts.schemaGrants.set(schema, new Map());
            edit(facts.schemaGrants.get(schema));
        }
        return;
    }
    for (const o of s.objects ?? []) {
        const t = facts.tables.get(key(o.RangeVar?.schemaname, o.RangeVar?.relname));
        if (t)
            edit(t.grants);
    }
}
/** Supabase grants EXECUTE on new public functions to anon and authenticated by default. */
export function callableByClients(fn, facts) {
    if (!facts.exposed.has(fn.schema.toLowerCase()))
        return false;
    return !(fn.revokedFrom.has('anon') && fn.revokedFrom.has('authenticated'));
}
function exposedSchemas(repoDir) {
    const exposed = new Set(['public', 'graphql_public']);
    for (const cfg of [join(repoDir, 'supabase/config.toml')]) {
        if (!existsSync(cfg))
            continue;
        const m = /\[api\][\s\S]*?\bschemas\s*=\s*\[([^\]]*)\]/.exec(readFileSync(cfg, 'utf8'));
        if (m)
            for (const s of m[1].matchAll(/"([^"]+)"/g))
                exposed.add(s[1].toLowerCase());
    }
    return exposed;
}
function sqlFiles(dir) {
    let out = [];
    for (const f of readdirSync(dir)) {
        if (SKIP_DIRS.has(f))
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
            out = out.concat(sqlFiles(p));
        else if (f.endsWith('.sql'))
            out.push(p);
    }
    return out;
}
async function statements(file) {
    const code = readFileSync(file, 'utf8');
    if (!code.trim())
        return [];
    let tree;
    try {
        tree = await parseSql(code);
    }
    catch {
        return [];
    }
    const bytes = Buffer.from(code, 'utf8');
    return (tree.stmts ?? []).map((s) => {
        const start = s.stmt_location ?? 0;
        const raw = bytes.subarray(start, s.stmt_len ? start + s.stmt_len : bytes.length).toString('utf8');
        const lead = raw.length - raw.trimStart().length;
        const line = bytes.subarray(0, start).toString('utf8').split('\n').length + raw.slice(0, lead).split('\n').length - 1;
        return { node: s.stmt, text: raw.trim(), line };
    });
}
