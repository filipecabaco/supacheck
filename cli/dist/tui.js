// Terminal front-end for `supacheck check`: live stage progress on stderr (@clack/prompts), the
// findings report on stdout. Colours via picocolors (NO_COLOR / FORCE_COLOR / TTY aware).
// --format json/sarif never come through here.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { intro, isCI, isTTY, log, outro, progress, spinner } from '@clack/prompts';
import pc from 'picocolors';
import wrapAnsi from 'wrap-ansi';
const SEVERITIES = ['critical', 'high', 'error', 'warning', 'info'];
const BLOCKING = new Set(['critical', 'high', 'error']);
const tone = (sev) => (sev === 'critical' || sev === 'error' ? (t) => pc.bold(pc.red(t)) : sev === 'high' ? pc.red : sev === 'warning' ? pc.yellow : pc.cyan);
const MARK = { critical: '●', high: '●', error: '●', warning: '▲', info: '○' };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const seconds = (ms) => (ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);
const label = (l) => pc.bold(l.padEnd(6));
const tilde = (p) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length) : p);
/** Interactive only on a real terminal outside CI; otherwise progress stays silent (the report still prints). */
export const interactive = (out = process.stderr) => isTTY(out) && !isCI() && process.env.TERM !== 'dumb' && (out.columns ?? 0) >= 40;
// ── live progress (stderr) ─────────────────────────────────────────────────────────────────────
export class ProgressView {
    live;
    bar;
    barAt = 0;
    tick;
    dl;
    score;
    assembling;
    started = Date.now();
    out = process.stderr;
    on_;
    constructor() {
        this.on_ = interactive(this.out);
    }
    intro(target, version) {
        if (this.on_)
            intro(`${pc.bold('supacheck')} ${pc.dim(version)}  ${pc.dim('checking')} ${target}`, { output: this.out });
    }
    on = (e) => {
        if (!this.on_)
            return this.plain(e);
        if (e.stage === 'sql' && !e.done)
            this.spin(`${label('SQL')} replaying ${plural(e.files, 'migration file')}`);
        else if (e.stage === 'sql' && e.done)
            this.done(!e.files ? `${label('SQL')} ${pc.dim('no migrations found')}`
                : `${label('SQL')} ${[plural(e.files, 'file'), plural(e.tables, 'table'), plural(e.policies, 'policy', 'policies'), plural(e.functions, 'function')].join(pc.dim(' · '))}${e.projects > 1 ? pc.dim(` · ${e.projects} projects`) : ''}`);
        else if (e.stage === 'code' && !e.done)
            this.spin(`${label('Code')} reading ${plural(e.files, 'file')}`);
        else if (e.stage === 'code' && e.done) {
            this.done(`${label('Code')} ${plural(e.files, 'file')} ${pc.dim('·')} ${plural(e.rules, 'rule')} checked`);
            this.spin(`${label('Model')} looking for the cached model`, 'slow');
        }
        else if (e.stage === 'fetch')
            this.fetch(e.event);
        else if (e.stage === 'load' && !e.done)
            this.spin(`${label('Load')} loading ${size(e.bytes)} of weights into ONNX Runtime ${pc.dim('(can take a few seconds)')}`, 'slow');
        else if (e.stage === 'load' && e.done)
            this.done(`${label('Load')} ${e.kind === 'laya' ? 'Laya decision model' : 'classifier'} ready ${pc.dim('(ONNX Runtime, CPU)')}`);
        else if (e.stage === 'prepare' && !e.done)
            this.spin(`${label('Chunks')} splitting ${plural(e.files, 'file')} into functions and statements for the model`, 'slow');
        else if (e.stage === 'prepare' && e.done)
            this.done(`${label('Chunks')} ${plural(e.chunks, 'chunk')} for the model${e.settled ? pc.dim(` · ${e.settled} already settled by facts`) : ''}`);
        else if (e.stage === 'model' && !e.done) {
            if (!this.score) {
                this.score = { t0: Date.now() };
                this.startBar(Math.max(1, e.total), `${label('Score')} asking ${plural(e.rules, 'rule question')} about ${plural(e.total, 'chunk')}`);
            }
            const left = e.scored ? ((Date.now() - this.score.t0) / e.scored) * (e.total - e.scored) : 0;
            this.advance(e.scored, `${label('Score')} ${e.scored}/${e.total} chunks${left > 1500 ? pc.dim(`  ~${seconds(left)} left`) : ''}`);
        }
        else if (e.stage === 'model' && e.done)
            this.done(`${label('Score')} ${plural(e.scored, 'chunk')} scored ${pc.dim('·')} ${plural(e.rules, 'rule')} ${pc.dim('·')} ${e.findings ? pc.magenta(plural(e.findings, 'finding')) : 'no findings'} ${pc.magenta('experimental')}`);
    };
    fetch(e) {
        if (e.step === 'cached')
            this.done(`${label('Model')} ${e.tag.replace(/^model-/, '')} ${pc.dim('·')} ${size(e.bytes)} ${pc.dim(`cached in ${tilde(e.dir)}`)}`);
        else if (e.step === 'wait')
            this.spin(e.pid ? `${label('Model')} another supacheck (pid ${e.pid}) is downloading it, waiting`
                : `${label('Model')} found a download lock with no owner, taking it over within a minute ${pc.dim(`(${tilde(e.lock)})`)}`, 'slow');
        else if (e.step === 'manifest')
            this.spin(`${label('Model')} first run: fetching the ${e.tag} manifest from ${e.url.replace(/^https?:\/\//, '').split('/').slice(0, 3).join('/')}`, 'slow');
        else if (e.step === 'download') {
            const now = Date.now();
            if (!this.dl) {
                this.dl = { t0: now, resumed: e.resumed, total: e.total, samples: [[now, e.bytes]], painted: 0 };
                const resumed = e.resumed ? pc.dim(` (resuming, ${size(e.resumed)} already here)`) : '';
                this.startBar(e.total, `${label('Model')} downloading ${size(e.total)} once, in ${e.parts} parts${resumed}`);
                this.advance(e.bytes, undefined);
            }
            const dl = this.dl;
            dl.samples.push([now, e.bytes]);
            while (dl.samples.length > 2 && now - dl.samples[0][0] > 5000)
                dl.samples.shift();
            if (now - dl.painted < 120 && e.bytes < e.total)
                return; // byte events arrive per network chunk; repaint ~8×/s
            dl.painted = now;
            const [t0, b0] = dl.samples[0];
            const rate = now > t0 ? ((e.bytes - b0) / (now - t0)) * 1000 : 0;
            const eta = rate > 0 ? ((e.total - e.bytes) / rate) * 1000 : 0;
            const stats = [`${e.partsDone}/${e.parts} parts`, rate > 0 ? `${(rate / 1e6).toFixed(1)} MB/s` : 'waiting for data', eta > 1500 ? `~${seconds(eta)} left` : ''].filter(Boolean).join(' · ');
            this.advance(e.bytes, `${label('Model')} ${size(e.bytes)} / ${size(e.total)}  ${pc.dim(stats)}${dl.note ? pc.yellow(`  ${dl.note}`) : ''}`);
        }
        else if (e.step === 'retry') {
            if (this.dl)
                this.dl.note = `${e.asset} ${e.reason}, retry ${e.attempt}/${e.of}`;
        }
        else if (e.step === 'assemble') {
            if (this.dl) {
                this.done(`${label('Model')} downloaded ${size(this.dl.total - this.dl.resumed)} ${pc.dim('· every part sha256-checked')}`);
                this.dl = undefined;
            }
            this.assembling ??= Date.now();
            this.spin(`${label('Model')} joining parts and checking ${e.file} ${pc.dim(`(${e.index}/${e.count}, ${size(e.bytes)})`)}`, 'slow');
        }
        else if (e.step === 'ready') {
            this.started = this.assembling ?? this.started;
            this.done(`${label('Model')} ${e.tag.replace(/^model-/, '')} ${pc.dim('·')} ${size(e.bytes)} ${pc.dim(`saved to ${tilde(e.dir)} for next time`)}`);
        }
    }
    /** Non-interactive (CI, pipes): a line for each slow step, so a log never looks hung. */
    plain(e) {
        const say = (m) => this.out.write(`supacheck: ${m}\n`);
        if (e.stage === 'fetch') {
            const f = e.event;
            if (f.step === 'wait')
                say(`waiting for another supacheck${f.pid ? ` (pid ${f.pid})` : ''} to finish downloading the model…`);
            else if (f.step === 'download' && !this.dl) {
                this.dl = { t0: Date.now(), resumed: f.resumed, total: f.total, samples: [], painted: 0 };
                say(`downloading the model once (${size(f.total)}${f.resumed ? `, ${size(f.resumed)} already here` : ''}), cached for later runs…`);
            }
            else if (f.step === 'retry')
                say(`${f.asset}: ${f.reason}, retrying (${f.attempt}/${f.of})`);
            else if (f.step === 'ready')
                say(`model saved to ${f.dir}`);
        }
        else if (e.stage === 'load' && !e.done)
            say(`loading the model (${size(e.bytes)})…`);
        else if (e.stage === 'model' && !e.done && !this.score) {
            this.score = { t0: Date.now() };
            say(`model scoring ${plural(e.total, 'chunk')}…`);
        }
    }
    advance(to, msg) {
        if (to > this.barAt)
            this.bar?.advance(to - this.barAt, msg);
        else if (msg)
            this.bar?.message(msg);
        this.barAt = Math.max(this.barAt, to);
    }
    /** Clear whatever is still animating (before an error or the report). */
    stop() {
        clearInterval(this.tick);
        this.live?.clear();
        this.bar?.clear();
        this.live = this.bar = undefined;
    }
    /** slow: a step whose length depends on the machine or network; shows elapsed seconds once it passes 2s. */
    spin(msg, slow = '') {
        this.stop();
        this.started = Date.now();
        this.live = spinner({ output: this.out, indicator: 'dots' });
        this.live.start(msg);
        if (slow)
            this.tick = setInterval(() => {
                const ms = Date.now() - this.started;
                if (ms >= 2000)
                    this.live?.message(`${msg}  ${pc.dim(seconds(ms).replace(/\.\ds$/, 's'))}`);
            }, 1000).unref();
    }
    startBar(max, msg) {
        this.stop();
        this.started = Date.now();
        this.barAt = 0;
        this.bar = progress({ output: this.out, max, size: 24, style: 'heavy' });
        this.bar.start(msg);
    }
    done(msg) {
        const took = pc.dim(seconds(Date.now() - this.started));
        const active = this.live ?? this.bar;
        clearInterval(this.tick);
        this.live = this.bar = undefined;
        if (active)
            active.stop(`${msg}  ${took}`);
        else
            log.success(`${msg}  ${took}`, { output: this.out });
        this.started = Date.now();
    }
}
// ── report (stdout) ────────────────────────────────────────────────────────────────────────────
const PER_RULE = 5;
export function report(opts) {
    const output = process.stdout;
    const cols = Math.max(60, Math.min(output.columns || 100, 110)) - 3; // clack's "│  " rail
    const wrap = (text, indent) => wrapAnsi(text, cols - indent, { hard: false }).split('\n').join('\n' + ' '.repeat(indent));
    const bySeverity = new Map();
    for (const f of opts.findings) {
        const sev = SEVERITIES.includes(f.severity) ? f.severity : 'info';
        const rules = bySeverity.get(sev) ?? new Map();
        rules.set(f.rule_id, [...(rules.get(f.rule_id) ?? []), f]);
        bySeverity.set(sev, rules);
    }
    for (const sev of SEVERITIES) {
        const rules = bySeverity.get(sev);
        if (!rules)
            continue;
        const paint = tone(sev);
        const count = [...rules.values()].reduce((n, fs) => n + fs.length, 0);
        log.message(paint(`${sev.toUpperCase()} · ${count}`), { output, symbol: paint('■') });
        for (const [rule, fs] of [...rules].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
            const f0 = fs[0];
            const lines = [
                `${pc.bold(rule)}${fs.length > 1 ? pc.dim(`  ×${fs.length}`) : ''}${fs.every((f) => f.engine === 'model') ? pc.magenta('  model · experimental') : ''}`,
                wrap(f0.message, 0),
            ];
            fs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
            for (const f of fs.slice(0, PER_RULE)) {
                const at = focusLine(opts.root, f);
                lines.push('', pc.underline(`${f.file}:${at}`));
                for (const l of excerpt(opts.root, f.file, at, cols - 2))
                    lines.push(l.focus ? `${paint('▶')} ${pc.dim(l.no)} ${pc.dim('│')} ${l.text}` : `  ${pc.dim(l.no)} ${pc.dim('│')} ${pc.dim(l.text)}`);
                const why = f.because?.length ? f.because.join(pc.dim(' · ')) : f.probability !== undefined ? `model probability ${f.probability} ≥ threshold ${f.threshold}` : '';
                if (why)
                    lines.push(`${pc.dim('why')}   ${wrap(why, 6)}`);
            }
            if (fs.length > PER_RULE) {
                const rest = fs.slice(PER_RULE);
                const files = [...new Set(rest.map((f) => f.file))];
                lines.push(pc.dim(`+ ${rest.length} more in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} other files` : ''} (--format json lists all)`));
            }
            lines.push('', `${pc.green('fix')}   ${wrap(f0.fix, 6)}`);
            f0.avoid.forEach((a, i) => lines.push(`${i ? '     ' : pc.yellow("don't")} ${wrap(a, 6)}`));
            lines.push(`${pc.dim('docs')}  ${pc.dim(f0.docs_url)}`);
            log.message(lines.flatMap((l) => l.split('\n')), { output, symbol: paint(MARK[sev] ?? '●') });
        }
    }
    const blocking = opts.findings.some((f) => opts.strict || BLOCKING.has(f.severity));
    const where = pc.dim(`${plural(opts.files, 'file')} · ${seconds(opts.ms)}`);
    const modelNote = opts.findings.some((f) => f.engine === 'model') ? pc.dim('\n   Model findings are experimental: check them before acting.') : '';
    if (!opts.files) {
        log.warn(`Nothing to check: no SQL or TypeScript/JavaScript files under ${opts.root}.`, { output });
        outro(pc.dim('Run it from your project root, the folder that contains supabase/.'), { output });
    }
    else if (!opts.findings.length) {
        outro(`${pc.green('✔')} ${pc.bold('No issues found.')}  ${where}`, { output });
    }
    else {
        const tally = SEVERITIES.map((s) => [s, [...(bySeverity.get(s)?.values() ?? [])].reduce((n, fs) => n + fs.length, 0)])
            .filter(([, n]) => n).map(([s, n]) => tone(s)(`${n} ${s}`)).join(pc.dim(' · '));
        const verdict = blocking
            ? pc.dim(`\n   Exit 1: ${opts.strict ? 'any finding fails with --strict' : 'critical and high findings block CI'}.`)
            : pc.dim('\n   Exit 0: nothing blocking. Add --strict to fail on warnings and info too.');
        outro(`${blocking ? pc.red('✖') : pc.green('✔')} ${tally}  ${where}${verdict}${modelNote}`, { output });
    }
}
// ── code excerpts ──────────────────────────────────────────────────────────────────────────────
// Code findings are anchored at the enclosing function or chunk; the excerpt points at the line that
// shows the problem when one matches within the chunk. SQL findings already sit on their statement.
const EVIDENCE = {
    'server-trusts-getsession': /\bgetSession\s*\(/,
    'user-metadata-for-authorization': /user_metadata|userMetadata/,
    'single-where-maybe-single': /\.single\s*\(/,
    'service-role-in-request-handler': /service.?role/i,
    'admin-client-for-user-scoped-work': /service.?role|\badmin\b/i,
    'ef-service-role-trusts-body-identity': /req(uest)?\.json\s*\(|\bbody\b/,
    'cross-tenant-id-from-body': /\bbody\b|req(uest)?\.json\s*\(/,
};
const CHUNK_REACH = 80;
const cache = new Map();
function load(root, file) {
    const path = join(root, file);
    if (!cache.has(path))
        cache.set(path, existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : null);
    return cache.get(path);
}
/** The line to show for a finding: its anchor, or the first evidence line inside the chunk for code rules. */
export function focusLine(root, f) {
    const re = EVIDENCE[f.rule_id];
    const src = re && !f.file.endsWith('.sql') ? load(root, f.file) : null;
    if (!src)
        return f.line;
    for (let n = f.line; n <= Math.min(src.length, f.line + CHUNK_REACH); n++)
        if (re.test(src[n - 1]))
            return n;
    return f.line;
}
/** The finding's line with one line of context either side (blank context lines skipped). */
function excerpt(root, file, line, cols) {
    const src = load(root, file);
    if (!src || line < 1 || line > src.length)
        return [];
    const from = Math.max(1, line - 1), to = Math.min(src.length, line + 1);
    const pad = String(to).length;
    const out = [];
    for (let n = from; n <= to; n++) {
        const raw = src[n - 1].replace(/\t/g, '  ');
        if (n !== line && !raw.trim())
            continue;
        const text = raw.length > cols - pad - 5 ? raw.slice(0, cols - pad - 6) + '…' : raw;
        out.push({ no: String(n).padStart(pad), text, focus: n === line });
    }
    return out;
}
export function fail(message, hint) {
    log.error(`${pc.bold(message)}${hint ? '\n' + pc.dim(hint) : ''}`, { output: process.stderr });
}
