#!/usr/bin/env node
// SET UP A FRESH INSTALL: ask where the node is, prove the answers work (scripts/check.js: the
// RPC server answers with the right chain, the credentials are accepted, txindex is on, the block
// files open, the log is found), write config/local.json, build the address index, and start the
// monitor -- so a new machine goes from a clone to running and indexing in one sitting.
//
//   npm run setup                       # interactive
//   node scripts/setup.js --yes [--rpc-url URL] [--datadir DIR] [--label L] [--rpc-user U --rpc-password P]
//                         [--host 127.0.0.1] [--port 21000] [--index-dir DIR] [--workers N]
//                         [--no-build] [--start] [--force]
//
// --yes takes every default without asking (a scripted install); --force replaces an existing
// config/local.json (a backup is kept either way); --start boots the monitor at the end without
// asking. The written file is mode 0600: it may carry an RPC password. Nothing here touches the
// node: every call is a read. (operator, 2026-09-14: "Make this npm installer absolutely beautiful")
import { existsSync, statSync, writeFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, loadConfig, resolveCookie } from '../server/config.js';
import { runChecks, clientFor } from './check.js';
import { buildIndex } from '../server/chain/index/build.js';
import { c, banner, step, checkLine, box, spinner, progress, progressLine, fmt, strip } from './ui.js';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const YES = flag('yes');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const STEPS = 6;

// ---------------------------------------------------------------- the answers, and their shape
/** Where Bitcoin Core keeps its data by default on this platform. */
export function defaultDatadir(platform = process.platform, home = os.homedir(), env = process.env) {
  // joined with the named platform's own separator, so the answer for a Mac is a Mac path
  // whatever machine asks (the tests ask for all three from one)
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return P.join(home, 'Library', 'Application Support', 'Bitcoin');
  if (platform === 'win32') return P.join(env.APPDATA ?? P.join(home, 'AppData', 'Roaming'), 'Bitcoin');
  return P.join(home, '.bitcoin');
}

/** Workers for the index build: leave four cores for the node, and count ~2.5 GB of memory each. */
export function defaultWorkers(cpus = os.cpus().length, totalMem = os.totalmem()) {
  return Math.max(1, Math.min(16, cpus - 4, Math.floor(totalMem / 2.5e9)));
}

/** The config/local.json a set of answers produces. */
export function localConfig(a) {
  const node = { id: 'main', label: a.label, rpcUrl: a.rpcUrl, datadir: a.datadir, chainHint: a.chain ?? 'main' };
  if (a.cookieFile) node.cookieFile = a.cookieFile;
  if (a.rpcUser) { node.rpcUser = a.rpcUser; node.rpcPassword = a.rpcPassword ?? ''; }
  if (a.indexDir) node.addressIndex = a.indexDir;
  return { server: { host: a.host, port: Number(a.port) }, nodes: [node] };
}

/** Write it, keeping a dated copy of whatever was there. Refuses an existing file unless `force`. */
export function writeLocalConfig(file, cfg, { force = false, now = new Date() } = {}) {
  if (existsSync(file)) {
    if (!force) throw new Error(`${file} exists; pass --force (or answer yes) to replace it`);
    const bak = `${file}.bak-${now.toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
    copyFileSync(file, bak);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// ------------------------------------------------------------------------- what an answer must be
// Each returns { value } or { error }: a bad answer is explained and asked again, never written.
/** A path as a person would type it: relative to the checkout, or under ~. */
export function shortPath(p, root = ROOT, home = os.homedir()) {
  const rel = path.relative(root, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return p.startsWith(home + '/') || p.startsWith(home + '\\') ? `~${p.slice(home.length)}` : p;
}
export function expand(p) { return p.startsWith('~/') || p === '~' ? path.join(os.homedir(), p.slice(1)) : p; }
export const validate = {
  rpcUrl(s) {
    let u;
    try { u = new URL(String(s).trim()); } catch { return { error: 'not a URL -- something like http://127.0.0.1:8332' }; }
    if (!/^https?:$/.test(u.protocol)) return { error: `${u.protocol.slice(0, -1)} is not http or https` };
    if (!u.port) u.port = u.protocol === 'https:' ? '443' : '8332';
    return { value: u.toString().replace(/\/$/, '') };
  },
  dir(s) {
    const p = expand(String(s).trim());
    if (!path.isAbsolute(p)) return { error: 'give an absolute path' };
    if (!existsSync(p)) return { error: `${p} does not exist` };
    if (!statSync(p).isDirectory()) return { error: `${p} is not a directory` };
    return { value: p };
  },
  newDir(s) {
    const p = expand(String(s).trim());
    if (!path.isAbsolute(p)) return { error: 'give an absolute path' };
    if (existsSync(p) && !statSync(p).isDirectory()) return { error: `${p} exists and is not a directory` };
    return { value: p };
  },
  port(s) {
    const n = Number(String(s).trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: 'a port is a whole number from 1 to 65535' };
    return { value: n };
  },
  host(s) {
    const h = String(s).trim();
    if (h === 'localhost') return { value: '127.0.0.1' };
    if (!net.isIP(h)) return { error: 'an IP address literal: 127.0.0.1 for this machine only, 0.0.0.0 for everyone who can reach it, or one of this machine\'s addresses' };
    return { value: h };
  },
  workers(s) {
    const n = Number(String(s).trim());
    if (!Number.isInteger(n) || n < 1 || n > 64) return { error: 'a whole number of workers, 1 to 64' };
    return { value: n };
  },
  label(s) { const l = String(s).trim(); return l ? { value: l.slice(0, 40) } : { error: 'a label, even a short one' }; },
};

/**
 * THE NODE'S OWN bitcoin.conf (operator, 2026-09-14: "can't you look through the user's .conf and find
 * the rpc values?"): read from the data directory, so the RPC port, the chain, rpcconnect, a
 * rpcuser/rpcpassword pair, rpcauth users, a cookie file the node was told to write elsewhere, and
 * server= / txindex= all arrive as defaults instead of questions. Core's rules: `key=value`, `#`
 * comments, `[main]` / `[test]` / `[signet]` / `[regtest]` sections whose keys apply to that chain
 * only, the chain chosen by testnet=1 / signet=1 / regtest=1 / chain=, and includeconf= pulling in
 * another file relative to the data directory. The last value of a key wins, except rpcauth, which
 * may repeat. Returns { found, file, chain, values, rpcauthUsers }.
 */
export function readBitcoinConf(datadir, { file = null, depth = 0 } = {}) {
  const conf = file ?? path.join(datadir, 'bitcoin.conf');
  const out = { found: false, file: conf, chain: 'main', values: {}, rpcauthUsers: [] };
  let text;
  try { text = readFileSync(conf, 'utf8'); } catch { return out; }
  out.found = true;
  const top = {}, sections = {};
  const rpcauth = { top: [], sections: {} };
  let section = null;
  const includes = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[([a-z0-9]+)\]$/i);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase(), value = line.slice(eq + 1).trim();
    if (key === 'includeconf') { includes.push(value); continue; }
    if (key === 'rpcauth') { (section ? (rpcauth.sections[section] ??= []) : rpcauth.top).push(value); continue; }
    if (section) (sections[section] ??= {})[key] = value; else top[key] = value;
  }
  // the chain: only the top level may choose it
  const chain = top.chain ? { main: 'main', test: 'test', testnet3: 'test', testnet4: 'testnet4', signet: 'signet', regtest: 'regtest' }[top.chain] ?? top.chain
    : top.regtest === '1' ? 'regtest' : top.signet === '1' ? 'signet' : top.testnet4 === '1' ? 'testnet4' : top.testnet === '1' ? 'test' : 'main';
  out.chain = chain;
  const secName = { main: 'main', test: 'test', signet: 'signet', regtest: 'regtest', testnet4: 'testnet4' }[chain];
  // on mainnet, a few keys are only honoured inside [main]; everywhere else the top level applies too
  const MAIN_ONLY = new Set(['rpcport', 'rpcbind', 'port', 'bind', 'wallet', 'addnode', 'connect']);
  const values = {};
  for (const [k, v] of Object.entries(top)) if (!(chain === 'main' && MAIN_ONLY.has(k)) || true) values[k] = v;
  if (chain === 'main') for (const k of MAIN_ONLY) if (k in top && !(k in (sections.main ?? {}))) values[k] = top[k];
  Object.assign(values, sections[secName] ?? {});
  out.values = values;
  out.rpcauthUsers = [...rpcauth.top, ...(rpcauth.sections[secName] ?? [])].map((v) => v.split(':')[0]).filter(Boolean);
  // included files, once, relative to the data directory
  if (depth < 3) for (const inc of includes) {
    const sub = readBitcoinConf(datadir, { file: path.isAbsolute(inc) ? inc : path.join(datadir, inc), depth: depth + 1 });
    if (!sub.found) continue;
    Object.assign(out.values, sub.values);
    out.rpcauthUsers.push(...sub.rpcauthUsers);
  }
  return out;
}
export const RPC_PORT = { main: 8332, test: 18332, testnet4: 48332, signet: 38332, regtest: 18443 };

/** Is a BlockYard (or anything) already answering on this port? */
export async function portInUse(host, port) {
  const at = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/api/health`;
  try {
    const r = await fetch(at, { signal: AbortSignal.timeout(1500) });
    const j = await r.json().catch(() => null);
    return { busy: true, blockyard: j?.version ?? null };
  } catch (err) {
    const refused = /ECONNREFUSED/.test(err?.cause?.code ?? '') || /ECONNREFUSED/.test(err?.message ?? '') || err?.name === 'TimeoutError';
    return { busy: !refused, blockyard: null };
  }
}

// ------------------------------------------------------------------------------------ the flow
async function main() {
  if (!YES && !stdin.isTTY) { console.error('no terminal to ask on: pass --yes with the --rpc-url/--datadir flags (see the header of scripts/setup.js)'); process.exit(2); }
  const rl = YES ? null : readline.createInterface({ input: stdin, output: stdout });
  const out = (s = '') => stdout.write(`${s}\n`);
  const say = (s) => out(`    ${s}`);
  const q = c.accent('?');

  /** Ask until the answer validates; --yes takes the default (validated the same way). */
  const ask = async (label, def, check, { secret = false } = {}) => {
    for (;;) {
      let raw;
      if (YES) raw = def;
      else {
        const shown = def != null && def !== '' && !secret ? ` ${c.dim(`(${def})`)}` : '';
        raw = (await rl.question(`    ${q} ${label}${shown} ${c.dim('›')} `)).trim();
        if (raw === '') raw = def;
      }
      const r = check ? check(raw ?? '') : { value: raw };
      if (!('error' in r)) return r.value;
      say(`${c.bad('✗')} ${r.error}`);
      if (YES) { out(); say(c.bad('--yes cannot answer that one; pass it as a flag')); process.exit(2); }
    }
  };
  const yes = async (label, def = true) => {
    if (YES) return def;
    const a = (await rl.question(`    ${q} ${label} ${c.dim(def ? '(Y/n)' : '(y/N)')} ${c.dim('›')} `)).trim().toLowerCase();
    return a === '' ? def : a.startsWith('y');
  };

  // the same file loadConfig reads: config/local.json, or BLOCKYARD_CONFIG where the environment names one
  const env = process.env.BLOCKYARD_CONFIG;
  const file = env && !/^(none|off|no|-)$/i.test(env) ? path.resolve(env) : path.join(ROOT, 'config', 'local.json');
  const defaults = loadConfig({ configFile: null });

  let building = null;
  process.on('SIGINT', () => {
    out(); out();
    if (building) say(c.warn(`stopped. The index in ${building} is unfinished: run the build again (it starts over) before pointing BlockYard at it.`));
    else say(c.dim('stopped; nothing written.'));
    process.exit(130);
  });

  out(banner(VERSION));
  say(c.dim('BlockYard runs on the machine that runs Bitcoin Core: the explorer\'s address index is built from'));
  say(c.dim('the node\'s block files. Every check below is a read; nothing on the node is changed.'));
  say(c.dim('Enter accepts the value shown. Ctrl-C leaves everything as it was.'));

  // ---------------------------------------------------------------- 1. the node, until it answers
  const a = {};
  let result;
  for (;;) {
    out(step(1, STEPS, 'Your Bitcoin Core node'));
    // the data directory first: its bitcoin.conf answers most of the rest
    a.datadir = await ask('data directory', arg('datadir', defaultDatadir()), validate.dir);
    let conf = readBitcoinConf(a.datadir);
    if (conf.found && conf.values.datadir && conf.values.datadir !== a.datadir && existsSync(conf.values.datadir)) {
      say(`${c.warn('!')} ${shortPath(conf.file)} moves the data directory to ${conf.values.datadir}; using that`);
      a.datadir = conf.values.datadir; conf = readBitcoinConf(a.datadir, { file: conf.file });
    }
    a.chain = conf.chain;
    if (conf.found) {
      const v = conf.values;
      const bits = [`chain ${conf.chain}`, v.rpcport ? `rpcport ${v.rpcport}` : null, v.server === '1' ? 'server=1' : c.warn('no server=1'),
        v.txindex === '1' ? 'txindex=1' : c.warn('no txindex=1'), v.rpcuser ? `rpcuser ${v.rpcuser}` : conf.rpcauthUsers.length ? `rpcauth ${conf.rpcauthUsers.join(', ')}` : 'cookie auth',
        v.prune && v.prune !== '0' ? c.bad(`prune=${v.prune}`) : null].filter(Boolean);
      say(`${c.ok('✓')} read ${c.dim(shortPath(conf.file))}: ${bits.join(c.dim(' · '))}`);
    } else say(c.dim(`no bitcoin.conf under ${a.datadir}: Core's defaults assumed`));
    const host = conf.values.rpcconnect ?? '127.0.0.1';
    const port = conf.values.rpcport ?? RPC_PORT[conf.chain] ?? 8332;
    a.rpcUrl = await ask('RPC URL', arg('rpc-url', `http://${host}:${port}`), validate.rpcUrl);
    a.label = await ask('a label for the node', arg('label', conf.chain === 'main' ? 'Bitcoin Core' : `Bitcoin Core (${conf.chain})`), validate.label);
    a.rpcUser = arg('rpc-user'); a.rpcPassword = arg('rpc-password');
    a.cookieFile = conf.values.rpccookiefile ? (path.isAbsolute(conf.values.rpccookiefile) ? conf.values.rpccookiefile : path.join(a.datadir, conf.values.rpccookiefile)) : null;
    const cookie = resolveCookie({ datadir: a.datadir, chainHint: a.chain, cookieFile: a.cookieFile ?? undefined });
    if (cookie && cookie.source !== 'config') say(`${c.ok('✓')} cookie found: ${c.dim(cookie.source)}`);
    else if (!a.rpcUser && conf.values.rpcuser && conf.values.rpcpassword) {
      a.rpcUser = conf.values.rpcuser; a.rpcPassword = conf.values.rpcpassword;
      say(`${c.ok('✓')} rpcuser/rpcpassword taken from ${shortPath(conf.file)}`);
    } else if (!a.rpcUser) {
      const who = conf.rpcauthUsers[0] ?? '';
      say(`${c.warn('!')} no .cookie readable under ${a.datadir}${who ? `; ${shortPath(conf.file)} has rpcauth for "${who}", whose password is not in the file` : ': a node authenticating with rpcauth needs a user and password'}`);
      a.rpcUser = await ask('rpcUser', who, null);
      if (a.rpcUser) a.rpcPassword = await ask('rpcPassword', '', null, { secret: true });
    }

    out(step(2, STEPS, 'Checking the node'));
    const node = localConfig({ ...a, host: '127.0.0.1', port: 0 }).nodes[0];
    const spin = spinner(`asking ${a.rpcUrl} …`);
    result = await runChecks(node, { rpc: clientFor(node, defaults) });
    if (result.facts.chain && result.facts.chain !== a.chain) { a.chain = result.facts.chain; node.chainHint = a.chain; result = await runChecks(node, { rpc: clientFor(node, defaults) }); }
    spin.stop();
    for (const ch of result.checks) out(checkLine(ch.status, ch.name, ch.detail));
    out();
    if (result.ok) { say(c.ok(c.bold('everything this needs is there'))); break; }
    if (result.checks.some((ch) => ch.name === 'rpc' && ch.status === 'fail')) {
      say(c.bad(c.bold('the RPC server did not answer')));
      say(c.dim('is the node running, is server=1 in its bitcoin.conf, and is that its RPC port (rpcport)?'));
      if (await yes('try different answers?', !YES)) continue;
    } else {
      say(c.bad(c.bold('something this needs is missing')) + c.dim(' (the ✗ lines say what, and what to do)'));
      if (await yes('write the config anyway?', false)) break;
    }
    out(); say(c.dim('nothing written.')); rl?.close(); process.exit(1);
  }

  // ------------------------------------------------------------------------ 3. the web interface
  out(step(3, STEPS, 'The web interface'));
  say(c.dim('127.0.0.1 keeps it to this machine; 0.0.0.0 opens it to everyone who can reach the port (docs/SECURITY.md).'));
  a.host = await ask('bind address', arg('host', '127.0.0.1'), validate.host);
  for (;;) {
    a.port = await ask('port', arg('port', '21000'), validate.port);
    const inUse = await portInUse(a.host, a.port);
    if (!inUse.busy) break;
    say(`${c.warn('!')} ${inUse.blockyard ? `BlockYard ${inUse.blockyard} is already listening on ${a.port}` : `something is already listening on ${a.port}`}`);
    if (YES || await yes('use it anyway?', false)) break;
  }

  // -------------------------------------------------------------------------- 4. the address index
  out(step(4, STEPS, 'The address index'));
  const gb = result.facts.blockBytes ? Math.round(result.facts.blockBytes / 1e9 * 0.141) : 124;
  say(c.dim('History and balances on the explorer come from an index built from the node\'s block files: about'));
  say(c.dim(`${gb} GB on disk, best on a different disk from the node's. It can be built now, or later with`));
  say(c.dim('node scripts/index-build.js --out <dir>.'));
  // inside the checkout by default (operator, 2026-09-14, on the Mac: "It should honor the directory
  // it's run out of"): data/ is where this install keeps everything it writes, and it is gitignored
  a.indexDir = await ask('index directory', arg('index-dir', path.join(ROOT, 'data', 'index')), validate.newDir);
  const built = existsSync(path.join(a.indexDir, 'manifest.json'));
  if (built) say(`${c.ok('✓')} an index is already built there; the server will follow the chain from it`);
  else a.workers = await ask(`build workers ${c.dim('(each needs ~2.5 GB of memory)')}`, arg('workers', String(defaultWorkers())), validate.workers);

  // ------------------------------------------------------------------------------- 5. written
  out(step(5, STEPS, 'config/local.json'));
  const cfg = localConfig(a);
  out(box(JSON.stringify(cfg, (k, v) => (k === 'rpcPassword' ? '••••••••' : v), 2).split('\n').map((l) => c.dim(l)), { title: shortPath(file) }).split('\n').map((l) => `    ${l}`).join('\n'));
  let force = flag('force');
  if (existsSync(file) && !force) force = await yes(`${shortPath(file)} exists -- replace it? (a backup is kept)`, false);
  try { writeLocalConfig(file, cfg, { force }); }
  catch (err) { out(); say(c.bad(err.message)); rl?.close(); process.exit(1); }
  say(`${c.ok('✓')} written ${c.dim('(mode 0600)')}`);

  // --------------------------------------------------------------------------------- 6. build
  out(step(6, STEPS, 'Building the index'));
  const build = !built && !flag('no-build') && await yes(`build the address index now into ${a.indexDir}? ${c.dim(`(${a.workers} workers; ~30 min on 16, longer on fewer)`)}`, true);
  if (build) {
    const node = cfg.nodes[0];
    const rpc = clientFor(node, defaults);
    const started = Date.now();
    let phaseStart = started, phase = null;
    const bar = progress();
    building = a.indexDir;
    try {
      const manifest = await buildIndex({
        rpc, blocksDir: path.join(node.datadir, 'blocks'), out: a.indexDir, workers: a.workers,
        onProgress: (p) => {
          if (p.phase !== phase) {
            if (phase) bar.done(strip(progressLine({ phase, done: 1, total: 1, elapsed: (Date.now() - phaseStart) / 1000 })));
            phase = p.phase; phaseStart = Date.now();
          }
          bar.update({ ...p, elapsed: (Date.now() - phaseStart) / 1000 });
        },
      });
      bar.done();
      building = null;
      const mins = (Date.now() - started) / 60000;
      say(`${c.ok('✓')} index built: ${fmt.big(manifest.rows ?? 0)} rows to block ${Number(manifest.tip?.height ?? 0).toLocaleString()} in ${mins.toFixed(1)} min`);
    } catch (err) {
      bar.done();
      building = null;
      say(c.bad(`the build failed: ${err.message}`));
      say(c.dim(`fix the cause and run: node scripts/index-build.js --out ${a.indexDir} --workers ${a.workers}`));
    }
  } else if (built) say(c.dim('nothing to build'));
  else say(c.dim(`skipped. Later:  node scripts/index-build.js --out ${a.indexDir} --workers ${a.workers}   (the address page says "not indexed" until then; restart BlockYard after)`));

  // --------------------------------------------------------------------------------- done
  const url = `http://${a.host === '0.0.0.0' ? '127.0.0.1' : a.host}:${a.port}`;
  out();
  out(box([
    `${c.bold('start it')}     ${c.accent('npm start')}${!YES ? c.dim('   (or answer yes below)') : ''}`,
    `${c.bold('open it')}      ${c.cyan(url)}`,
    `${c.bold('check it')}     ${c.accent('npm run check')}${c.dim('   the same checks, any time')}`,
    `${c.bold('keep it up')}   ${c.dim('docs/GETTING-STARTED.md §6: systemd on Linux, launchd on macOS')}`,
  ], { title: c.bold('BlockYard is set up') }).split('\n').map((l) => `    ${l}`).join('\n'));
  out();
  const start = flag('start') || (!YES && await yes('start BlockYard now, in this terminal? (Ctrl-C stops it)', true));
  rl?.close();
  if (!start) process.exit(0);
  const { boot, banner: serverBanner } = await import('../server/main.js');
  const app = await boot();
  stdout.write(serverBanner(app) + '\n');
  if (app.bootstrap) await app.audit({ type: 'bootstrap-admin', generated: app.bootstrap.generated, ip: 'local' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((err) => { console.error(c.bad(err.message)); process.exit(1); });
}
