#!/usr/bin/env node
// CHECK A NODE BEFORE RUNNING AGAINST IT: the RPC server answers, the credentials work, the
// chain is the one configured, the indexes the explorer needs are there, the block files can be
// read (the address index is built from them), the node's log is where it should be, and an
// address index, if configured, is readable, writable and not far behind.
//
//   npm run check                 # every node in config/local.json
//   node scripts/check.js --node <id>
//
// Prints one line per check and exits 1 if anything FAILED. `npm run setup` runs the same checks
// on the answers it is given before it writes config/local.json. The checks are a function
// (runChecks) so they can be tested against a stub node, with the printing kept out here.
import { existsSync, statSync, readdirSync, accessSync, readFileSync, realpathSync, constants as FS } from 'node:fs';
import path from 'node:path';
import { loadConfig, configProblems, resolveCookie } from '../server/config.js';
import { RpcClient } from '../server/rpc/client.js';
import { MAGIC, xorKey, readChainFile, records } from '../server/chain/blockfile.js';
import { c, checkLine } from './ui.js';
import { fileURLToPath } from 'node:url';

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

/** The RPC client a check talks through; setup and the tests pass their own. */
export function clientFor(node, cfg) {
  return new RpcClient(node, { ...(cfg?.rpc ?? {}), ...(node.rpc ?? {}) }, { log: QUIET });
}

const CORE_VERSION_MIN = 250000;   // getblock verbosity 3 (the follower's one call) arrived in 25.0

/**
 * Every check for one node. `rpc` is anything with batch(calls) -> [{ok, result, error}].
 * Returns { ok, checks: [{ name, status: 'ok'|'warn'|'fail'|'info', detail }], facts }.
 */
export async function runChecks(node, { rpc, fs = { existsSync, statSync, readdirSync, accessSync, readFileSync }, readBlockFile = readChainFile } = {}) {
  const checks = [];
  const facts = {};
  const add = (name, status, detail) => { checks.push({ name, status, detail }); return status; };

  // credentials
  const cred = resolveCookie(node);
  if (!cred) add('credentials', 'fail', `no cookie file found under ${node.datadir ?? '(no datadir)'} and no rpcUser/rpcPassword`);
  else add('credentials', 'ok', cred.source === 'config' ? `rpcUser "${cred.user}" from the config` : `cookie ${cred.source}`);

  // the RPC server
  // every call is timed: how fast the node answers is half of what an install needs to know
  const ms = (t0) => `${Date.now() - t0 >= 1000 ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : `${Date.now() - t0} ms`}`;
  const one = async (method, params = [], timeoutMs = 20000) => {
    const t0 = Date.now();
    try { const [r] = await rpc.batch([{ method, params }], { timeoutMs }); r.ms = ms(t0); return r; }
    catch (err) { return { ok: false, ms: ms(t0), error: { message: err.message, kind: err.kind } }; }
  };
  const info = await one('getblockchaininfo');
  if (!info.ok) {
    add('rpc', 'fail', `${node.rpcUrl}: ${info.error.message}`);
    return { ok: false, checks, facts };
  }
  const chain = info.result.chain;
  facts.chain = chain; facts.blocks = info.result.blocks; facts.headers = info.result.headers;
  add('rpc', 'ok', `${node.rpcUrl} answers in ${info.ms}: chain ${chain}, block ${info.result.blocks.toLocaleString()} of ${info.result.headers.toLocaleString()} headers${info.result.initialblockdownload ? ', still in initial block download' : ''}${info.result.pruned ? ', PRUNED' : ''}`);
  if (node.chainHint && node.chainHint !== chain) add('chain', 'fail', `config says chainHint "${node.chainHint}" but the node is on "${chain}"`);
  if (info.result.pruned) add('pruned', 'fail', 'a pruned node has discarded old block files; the address index needs every one of them');

  const net = await one('getnetworkinfo');
  if (net.ok) {
    facts.version = net.result.version; facts.subversion = net.result.subversion;
    const v = net.result.version;
    add('version', v >= CORE_VERSION_MIN ? 'ok' : 'fail', `${net.result.subversion} (${v})${v < CORE_VERSION_MIN ? ` -- the address index follower needs getblock verbosity 3, Bitcoin Core 25.0 or later` : ''}`);
  } else add('version', 'warn', `getnetworkinfo: ${net.error.message}`);

  const idx = await one('getindexinfo');
  if (idx.ok) {
    const tx = idx.result.txindex;
    if (!tx) add('txindex', 'fail', 'txindex is off: the explorer cannot look a confirmed transaction up by id (set txindex=1 in bitcoin.conf)');
    else add('txindex', tx.synced ? 'ok' : 'warn', tx.synced ? `synced to ${tx.best_block_height.toLocaleString()}` : `still building (${tx.best_block_height.toLocaleString()} of ${info.result.blocks.toLocaleString()})`);
    const cs = idx.result.coinstatsindex;
    add('coinstatsindex', cs ? (cs.synced ? 'ok' : 'warn') : 'info', cs ? (cs.synced ? 'synced: the Chain page has UTXO figures' : 'still building') : 'off: the Chain page marks UTXO figures unindexed (optional)');
  } else add('txindex', 'warn', `getindexinfo: ${idx.error.message}`);

  // the explorer's one heavy need from the node: a block with every input's prevout
  const best = await one('getbestblockhash');
  if (best.ok) {
    const blk = await one('getblock', [best.result, 3], 120_000);
    if (blk.ok) {
      const withPrevout = blk.result.tx.slice(1, 4).every((t) => t.vin.every((v) => v.prevout));
      const slow = blk.ms.endsWith(' s') && parseFloat(blk.ms) >= 5;
      add('getblock 3', withPrevout ? (slow ? 'warn' : 'ok') : 'fail', withPrevout ? `the tip block decodes with prevouts (${blk.result.tx.length.toLocaleString()} transactions) in ${blk.ms}${slow ? ' -- slow: the block files are on a slow disk, or the node is busy' : ''}` : 'the node answered verbosity 3 without prevouts');
    } else add('getblock 3', 'fail', `getblock <tip> 3: ${blk.error.message} -- the address index follower cannot run`);
  }
  // the mempool, verbose: the monitor's heaviest regular read, every 20 s; how long the node takes
  // over it is what decides whether the block-space board fills
  const mp = await one('getrawmempool', [true], 120_000);
  if (mp.ok) {
    const n = Object.keys(mp.result).length;
    const slow = mp.ms.endsWith(' s') && parseFloat(mp.ms) >= 10;
    add('mempool', slow ? 'warn' : 'ok', `${n.toLocaleString()} transactions, verbose, in ${mp.ms}${slow ? ' -- slow: the board and the block being built will lag behind this' : ''}`);
  } else add('mempool', 'warn', `getrawmempool verbose: ${mp.error.message} after ${mp.ms}`);
  const addr = await one('getaddresstxids', [{ addresses: [] }]);
  add('address index rpc', 'info', addr.ok ? 'the node has insight-style address RPCs (unused: BlockYard keeps its own index)' : 'the node has no address index, as expected of Bitcoin Core; BlockYard builds its own');

  // the data directory: block files and the log
  if (!node.datadir) add('datadir', 'fail', 'no datadir configured: the address index is built from the node\'s block files');
  else if (!fs.existsSync(node.datadir)) add('datadir', 'fail', `${node.datadir} does not exist on this machine`);
  else {
    const blocksDir = path.join(node.datadir, 'blocks');
    let names = null;
    try { names = fs.readdirSync(blocksDir); } catch (err) { add('block files', 'fail', `${blocksDir}: ${err.message}`); }
    if (names) {
      const blk = names.filter((f) => /^blk\d{5}\.dat$/.test(f)).sort();
      const rev = names.filter((f) => /^rev\d{5}\.dat$/.test(f)).sort();
      const xor = names.includes('xor.dat');
      facts.blockFiles = blk.length; facts.undoFiles = rev.length;
      if (!blk.length) add('block files', 'fail', `${blocksDir} holds no blk*.dat`);
      else {
        let bytes = 0;
        for (const f of [...blk, ...rev]) { try { bytes += fs.statSync(path.join(blocksDir, f)).size; } catch { /* counted as far as readable */ } }
        facts.blockBytes = bytes;
        add('block files', rev.length === blk.length ? 'ok' : 'warn', `${blk.length} block files and ${rev.length} undo files, ${(bytes / 1e9).toFixed(1)} GB${xor ? ', XOR-obfuscated (xor.dat present)' : ''}${rev.length !== blk.length ? ' -- every block file needs its undo file' : ''}`);
        // prove they can be read: the first file's first record is the genesis block
        try {
          const key = xorKey(blocksDir);
          const buf = readBlockFile(path.join(blocksDir, blk[0]), key);
          const first = records(buf, MAGIC[chain] ?? MAGIC.main, 0, key).next().value;
          const genesis = first && first.body.subarray(4, 36).every((b) => b === 0);
          add('read a block', genesis ? 'ok' : 'fail', genesis ? `${blk[0]} opens and its first record is the genesis block` : `${blk[0]} opens but its first record is not a ${chain} genesis block: wrong chain, or a key this reader does not know`);
        } catch (err) { add('read a block', 'fail', `${blk[0]}: ${err.message}`); }
      }
    }
    const logs = [path.join(node.datadir, chain === 'main' ? '' : ({ test: 'testnet3', testnet4: 'testnet4', signet: 'signet', regtest: 'regtest' }[chain] ?? chain), 'debug.log')];
    const log = logs.find((f) => fs.existsSync(f));
    if (log) { const st = fs.statSync(log); facts.logFile = log; add('node log', 'info', `${log} (${(st.size / 1e6).toFixed(1)} MB) -- found; not parsed on Bitcoin Core, and not needed`); }
    else add('node log', 'info', `no debug.log under ${node.datadir} -- not needed`);
  }

  // an address index, if there is one
  if (node.addressIndex) {
    const dir = node.addressIndex;
    const manifest = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifest)) add('address index', node.addressIndexBuild === 'manual' ? 'warn' : 'info', `${dir}: not built yet${node.addressIndexBuild === 'manual' ? ` (node scripts/index-build.js --out ${dir})` : ' -- BlockYard builds it when it starts'}`);
    else {
      try {
        const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const behind = info.result.blocks - m.tip.height;
        facts.indexTip = m.tip.height;
        add('address index', behind > 200 ? 'warn' : 'ok', `${dir}: built at ${m.builtAt ?? '?'} to block ${m.tip.height.toLocaleString()}, ${behind.toLocaleString()} behind the node${behind > 200 ? ' (the follower catches up 50 blocks a poll)' : ''}`);
      } catch (err) { add('address index', 'fail', `${manifest}: ${err.message}`); }
      try { fs.accessSync(dir, FS.W_OK); add('index writable', 'ok', 'the follower can write live.log and layers/ there'); }
      catch { add('index writable', 'fail', `${dir} is not writable by this user; the follower writes live.log and layers/ inside it`); }
    }
  }

  return { ok: !checks.some((c) => c.status === 'fail'), checks, facts };
}

export function printChecks(label, { ok, checks }) {
  console.log(`\n  ${c.bold(label)}`);
  for (const ch of checks) console.log(checkLine(ch.status, ch.name, ch.detail));
  console.log(ok ? `    ${c.ok(c.bold('everything this needs is there'))}` : `    ${c.bad(c.bold('something this needs is missing'))}${c.dim(' (the ✗ lines say what)')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
  const cfg = loadConfig();
  for (const p of configProblems()) console.log(checkLine('fail', 'config', p));
  const nodes = arg('node') ? cfg.nodes.filter((n) => n.id === arg('node')) : cfg.nodes;
  if (!nodes.length) { console.log(`no node ${arg('node') ?? ''} in ${cfg.__configFile ?? 'the configuration'}`); process.exit(2); }
  let allOk = configProblems().length === 0;
  for (const node of nodes) {
    const r = await runChecks(node, { rpc: clientFor(node, cfg) });
    printChecks(`node "${node.id}" (${node.label ?? ''})`, r);
    allOk &&= r.ok;
  }
  process.exit(allOk ? 0 : 1);
}
