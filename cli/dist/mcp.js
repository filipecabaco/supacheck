// Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited) exposing one tool, supacheck_check.
// Agents call it after editing migrations or Supabase client code.
import { createInterface } from 'node:readline';
import { runCheck } from './check.js';
const TOOL = {
    name: 'supacheck_check',
    description: 'Check a Supabase project (SQL migrations + supabase-js code) for security anti-patterns: deterministic rules over facts, plus a local model for the judgement calls they leave open (downloads 1.7 GB on first use). Returns findings with the facts they rest on, a fix, and fixes to avoid (never disable RLS or GRANT ALL to anon to silence a finding).',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Project root (defaults to the current directory)' },
            all_grants: { type: 'boolean', description: 'Report missing grants for tables created before 2026-10-30 too' },
        },
    },
};
export async function startMcp() {
    const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
    for await (const line of createInterface({ input: process.stdin })) {
        if (!line.trim())
            continue;
        let req;
        try {
            req = JSON.parse(line);
        }
        catch {
            continue;
        }
        const reply = (result) => req.id !== undefined && send({ jsonrpc: '2.0', id: req.id, result });
        const fail = (message) => req.id !== undefined && send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message } });
        try {
            if (req.method === 'initialize')
                reply({ protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'supacheck', version: '0.0.0' } });
            else if (req.method === 'tools/list')
                reply({ tools: [TOOL] });
            else if (req.method === 'tools/call' && req.params?.name === TOOL.name) {
                const args = req.params.arguments ?? {};
                const result = await runCheck(args.path ?? process.cwd(), { allGrants: !!args.all_grants });
                reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
            }
            else if (req.method === 'ping')
                reply({});
            else if (req.id !== undefined)
                send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
        }
        catch (e) {
            fail(e.message);
        }
    }
}
