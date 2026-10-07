#!/usr/bin/env node
// supacheck check [dir] [--format text|json|sarif] [--strict] [--all-grants] [--experimental] [--model] [--model-dir <dir>]
// supacheck mcp                              (stdio MCP server exposing supacheck_check)
// supacheck chunks <paths...>                (hidden, dev: model input chunks)
//
// Exit codes: 0 clean (or warnings only), 1 critical/high findings (any finding with --strict), 2 usage error.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import pc from 'picocolors';
import { chunksFor } from './chunks.js';
import { defaultRulesDir, ModelUnavailable, runCheck, walk } from './check.js';
import { applicable, loadRules } from './rules.js';
import { startMcp } from './mcp.js';
import { fail, ProgressView, report } from './tui.js';
const VERSION = (() => {
    for (const p of ['../../package.json', '../package.json']) {
        const f = resolve(import.meta.dirname, p);
        if (existsSync(f))
            return String(JSON.parse(readFileSync(f, 'utf8')).version ?? '');
    }
    return '';
})();
const BLOCKING = new Set(['error', 'critical', 'high']);
const NPX = 'npx -y github:filipecabaco/supacheck';
const program = new Command('supacheck')
    .description('Catch Supabase security mistakes before you ship them.')
    .version(VERSION, '-v, --version')
    .showHelpAfterError(pc.dim('(run supacheck --help for usage)'))
    .exitOverride()
    .configureOutput({ outputError: (msg, write) => write(pc.red(msg)) });
program.command('check', { isDefault: true })
    .description('check a Supabase project: SQL migrations and supabase-js code')
    .argument('[dir]', 'project root, the folder that contains supabase/', '.')
    .addOption(new Option('-f, --format <format>', 'output format').choices(['text', 'json', 'sarif']).default('text'))
    .option('--strict', 'exit 1 on any finding, not just critical/high')
    .option('--experimental', 'add rules still being validated')
    .option('--all-grants', 'report missing grants on tables created before 2026-10-30 too')
    .option('--model', 'add experimental model checks (downloads 1.7 GB once)')
    .option('--model-dir <dir>', 'use a local model directory instead of downloading')
    .addHelpText('after', `
Exit codes: 0 clean or only warnings/info · 1 critical or high findings · 2 usage error or model unavailable

Examples:
  $ ${NPX} check .
  $ ${NPX} check apps/web --strict
  $ ${NPX} check . --format sarif > supacheck.sarif`)
    .action(check);
program.command('mcp').description('run as an MCP server for coding agents (stdio)').action(() => startMcp());
program.command('chunks', { hidden: true }).argument('<paths...>').option('--strip-prefix <dir>').action(async (paths, o) => {
    const rules = loadRules(defaultRulesDir());
    for (const file of paths.flatMap(walk)) {
        const shown = o.stripPrefix ? file.replace(o.stripPrefix, '').replace(/^\//, '') : file;
        for (const chunk of await chunksFor(file, { displayPath: shown })) {
            const asked = rules.filter((r) => applicable(r, chunk)).map((r) => r.id);
            if (asked.length)
                console.log(JSON.stringify({ ...chunk, rules: asked }));
        }
    }
    // no process.exit(): stdout to a pipe is async and would be truncated
});
try {
    await program.parseAsync();
}
catch (e) {
    if (!(e instanceof CommanderError))
        throw e;
    // help/version exit 0; anything commander rejects (unknown option, bad choice, no command) is a usage error
    process.exitCode = ['commander.helpDisplayed', 'commander.version'].includes(e.code) ? 0 : 2;
}
async function check(dir, o) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        fail(`No directory at ${dir}.`, 'Pass your project root, the folder that contains supabase/.');
        process.exitCode = 2;
        return;
    }
    const wantsModel = o.model || !!o.modelDir;
    const view = o.format === 'text' ? new ProgressView(wantsModel) : undefined;
    view?.intro(dir === '.' ? basename(process.cwd()) : dir, VERSION);
    const t0 = Date.now();
    let result;
    try {
        result = await runCheck(dir, { allGrants: o.allGrants, experimental: o.experimental, model: o.model, modelDir: o.modelDir, onProgress: view?.on });
    }
    catch (e) {
        view?.stop();
        if (!(e instanceof ModelUnavailable))
            throw e;
        fail(e.message.replace(/ \(run without.*\)$/, ''), 'Run without --model / --model-dir to use the rule checks only.');
        process.exitCode = 2;
        return;
    }
    view?.stop();
    const { files, findings } = result;
    if (o.format === 'json')
        console.log(JSON.stringify({ files, findings }, null, 2));
    else if (o.format === 'sarif')
        console.log(JSON.stringify(sarif(findings), null, 2));
    else
        report({ root: resolve(dir), files, findings, strict: !!o.strict, ms: Date.now() - t0 });
    process.exitCode = findings.some((f) => o.strict || BLOCKING.has(f.severity)) ? 1 : 0;
}
function sarif(findings) {
    const level = (s) => (BLOCKING.has(s) ? 'error' : s === 'warning' ? 'warning' : 'note');
    const ids = [...new Set(findings.map((f) => f.rule_id))];
    return {
        version: '2.1.0',
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        runs: [{
                tool: { driver: { name: 'supacheck', informationUri: 'https://github.com/filipecabaco/supacheck', rules: ids.map((id) => {
                            const f = findings.find((x) => x.rule_id === id);
                            return { id, shortDescription: { text: f.message }, help: { text: `${f.fix}\nAvoid: ${f.avoid.join('; ')}` }, helpUri: f.docs_url };
                        }) } },
                results: findings.map((f) => ({
                    ruleId: f.rule_id, level: level(f.severity),
                    message: { text: `${f.message}${f.because ? ` (${f.because.join('; ')})` : ''}` },
                    locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line } } }],
                })),
            }],
    };
}
