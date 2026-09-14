#!/usr/bin/env node
// SET UP A FRESH INSTALL: ask where the node is, prove the answers work (scripts/check.js: the
// RPC server answers with the right chain, the credentials are accepted, txindex is on, the block
// files open, the log is found), write config/local.json, and -- optionally -- start building the
// address index straight away, so a new machine is running and indexing in one sitting.
//
//   npm run setup                       # interactive
//   node scripts/setup.js --yes [--rpc-url URL] [--datadir DIR] [--label L] [--rpc-user U --rpc-password P]
//                         [--host 127.0.0.1] [--port 21000] [--index-dir DIR] [--workers N] [--no-build] [--force]
//
// --yes takes every default without asking (a scripted install); --force overwrites an existing
// config/local.json (a backup is kept either way). The written file is mode 0600: it may carry
// an RPC password. Nothing here touches the node: every call is a read.
import { existsSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, loadConfig, resolveCookie } from '../server/config.js';
import { runChecks, printChecks, clientFor } from './check.js';
import { buildIndex } from '../server/chain/index/build.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, def = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const YES = flag('yes');

/** Where Bitcoin Core keeps its data by default on this platform. */
export function defaultDatadir(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Bitcoin');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Bitcoin');
  return path.join(home, '.bitcoin');
}

/** Workers for the index build: leave four cores for the node, and count ~2.5 GB of memory each. */
export function defaultWorkers(cpus = os.cpus().length, totalMem = os.totalmem()) {
  return Math.max(1, Math.min(16, cpus - 4, Math.floor(totalMem / 2.5e9)));
}

/** The config/local.json a set of answers produces. */
export function localConfig(a) {
  const node = { id: 'main', label: a.label, rpcUrl: a.rpcUrl, datadir: a.datadir, chainHint: a.chain ?? 'main' };
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

async function main() {
  const rl = YES ? null : readline.createInterface({ input: stdin, output: stdout });
  if (!YES && !stdin.isTTY) { console.error('no terminal to ask on: pass --yes with the --rpc-url/--datadir flags (see the header of scripts/setup.js)'); process.exit(2); }
  const ask = async (q, def) => {
    if (YES) return def;
    const a = (await rl.question(`${q}${def != null && def !== '' ? ` [${def}]` : ''}: `)).trim();
    return a === '' ? def : a;
  };
  const yes = async (q, def = true) => {
    if (YES) return def;
    const a = (await rl.question(`${q} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
    return a === '' ? def : a.startsWith('y');
  };
  // the same file loadConfig reads: config/local.json, or BLOCKYARD_CONFIG where the environment names one
  const env = process.env.BLOCKYARD_CONFIG;
  const file = env && !/^(none|off|no|-)$/i.test(env) ? path.resolve(env) : path.join(ROOT, 'config', 'local.json');
  const defaults = loadConfig({ configFile: null });

  console.log('\nBlockYard setup -- the node, checked, then config/local.json.\n');
  console.log('BlockYard runs on the machine that runs Bitcoin Core: the address index is built from the');
  console.log('node\'s block files. Every check below is a read; nothing is changed on the node.\n');

  const a = {};
  let result;
  for (;;) {
    a.rpcUrl = await ask('Bitcoin Core RPC URL', arg('rpc-url', 'http://127.0.0.1:8332'));
    a.datadir = await ask('Bitcoin Core data directory', arg('datadir', defaultDatadir()));
    a.label = await ask('A label for this node', arg('label', 'Bitcoin Core'));
    a.rpcUser = arg('rpc-user'); a.rpcPassword = arg('rpc-password');
    const cookie = resolveCookie({ datadir: a.datadir, chainHint: 'main' });
    if (cookie && cookie.source !== 'config') console.log(`  cookie found: ${cookie.source}`);
    else if (!a.rpcUser) {
      console.log(`  no .cookie readable under ${a.datadir}; a node authenticating with rpcauth needs a user and password`);
      a.rpcUser = await ask('  rpcUser', '');
      if (a.rpcUser) a.rpcPassword = await ask('  rpcPassword', '');
    }
    const node = localConfig({ ...a, host: '127.0.0.1', port: 0 }).nodes[0];
    console.log('\nchecking...');
    result = await runChecks(node, { rpc: clientFor(node, defaults) });
    a.chain = result.facts.chain ?? 'main';
    if (a.chain !== 'main') { node.chainHint = a.chain; result = await runChecks(node, { rpc: clientFor(node, defaults) }); }
    printChecks(`node at ${a.rpcUrl}`, result);
    if (result.ok) break;
    if (result.checks.some((c) => c.name === 'rpc' && c.status === 'fail')) {
      if (await yes('\nThe RPC server did not answer. Try different answers?', !YES)) continue;
    } else if (await yes('\nSomething is missing (FAIL above). Write the config anyway?', false)) break;
    console.log('nothing written.'); rl?.close(); process.exit(1);
  }

  a.host = await ask('\nWeb interface: bind address (127.0.0.1 = this machine only; 0.0.0.0 = everyone who can reach it)', arg('host', '127.0.0.1'));
  a.port = await ask('Web interface: port', arg('port', '21000'));
  const gb = result.facts.blockBytes ? (result.facts.blockBytes / 1e9 * 0.14).toFixed(0) : '124';
  console.log(`\nThe address index (history and balances on the explorer) is built from the block files -- about\n${gb} GB on disk, best on a different disk from the node's. It can be built now or later with\n  node scripts/index-build.js --out <dir>`);
  a.indexDir = await ask('Address index directory', arg('index-dir', path.join(os.homedir(), 'blockyard-index')));
  a.workers = Number(await ask('Build workers (each needs ~2.5 GB of memory)', arg('workers', String(defaultWorkers()))));

  const cfg = localConfig(a);
  console.log(`\n${JSON.stringify(cfg, (k, v) => (k === 'rpcPassword' ? '********' : v), 2)}`);
  let force = flag('force');
  if (existsSync(file) && !force) force = await yes(`${file} exists. Replace it (a backup is kept)?`, false);
  try { writeLocalConfig(file, cfg, { force }); }
  catch (err) { console.log(`\n${err.message}`); rl?.close(); process.exit(1); }
  console.log(`\nwrote ${file} (mode 0600)`);

  const built = result.facts.indexTip != null || existsSync(path.join(a.indexDir, 'manifest.json'));
  if (built) console.log(`\nan address index is already built in ${a.indexDir}; the server follows the chain from there`);
  const build = !built && !flag('no-build') && await yes(`\nBuild the address index now into ${a.indexDir}? (${a.workers} workers; the whole chain takes ~30 min on 16)`, true);
  rl?.close();
  if (build) {
    const node = cfg.nodes[0];
    const rpc = clientFor(node, defaults);
    const started = Date.now();
    let last = 0;
    const manifest = await buildIndex({
      rpc, blocksDir: path.join(node.datadir, 'blocks'), out: a.indexDir, workers: a.workers,
      onProgress: (p) => {
        const now = Date.now();
        if (now - last < 1000 && p.done !== p.total) return;
        last = now;
        process.stderr.write(`[${((now - started) / 1000).toFixed(0)}s] ${p.phase} ${p.done}/${p.total}${p.rows != null ? ` rows ${p.rows.toLocaleString()}` : ''}\n`);
      },
    });
    console.log(`\nindex built: ${manifest.rows?.toLocaleString?.() ?? ''} rows to block ${manifest.tip.height.toLocaleString()} in ${((Date.now() - started) / 60000).toFixed(1)} min`);
  } else if (!built) {
    console.log(`\nlater:  node scripts/index-build.js --out ${a.indexDir} --workers ${a.workers}\n(the address page says "not indexed" until then; restart BlockYard after the build)`);
  }
  console.log(`\nnow:    npm start\nthen:   http://${a.host === '0.0.0.0' ? '127.0.0.1' : a.host}:${a.port}\ncheck:  npm run check\n`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
