#!/usr/bin/env node
// How does the built address index compare? (docs/MEASUREMENTS.md §30)
//
//   node scripts/index-benchmark.js --index <dir> [--sample 400] [--verify 40]
//
// 1. opening the index (the sparse keys load into memory)
// 2. lookup latency for real addresses: a sample from blocks across the chain's history, plus
//    addresses known to have enormous histories -- summary (count, balance, newest 25 rows) timed
// 3. CORRECTNESS against the node: for --verify addresses, the index balance plus any blocks the node
//    has connected since the build, against `scantxoutset` at the same height. scantxoutset is Core's
//    only address query; it reads the whole UTXO set, answers balance only (no history), and is also
//    timed, as the method the index replaces.
import { loadConfig } from '../server/config.js';
import { RpcClient } from '../server/rpc/client.js';
import { IndexStore } from '../server/chain/index/store.js';
import { scriptKey } from '../server/chain/index/rows.js';
import { addressToScript } from '../server/chain/tx.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const dir = arg('index', null);
if (!dir) { console.error('--index <dir> is required'); process.exit(2); }
const SAMPLE = Number(arg('sample', 400)), VERIFY = Number(arg('verify', 40));
const cfg = loadConfig();
const node = cfg.nodes.find((n) => n.id === arg('node', null)) ?? cfg.nodes.find((n) => n.datadir) ?? cfg.nodes[0];
const rpc = new RpcClient(node, { ...(cfg.rpc ?? {}), ...(node.rpc ?? {}) }, { log: { info() {}, warn() {}, error() {}, debug() {} } });
const call = async (method, params, timeoutMs = 600_000) => {
  const [r] = await rpc.batch([{ method, params }], { key: `ibench:${method}:${JSON.stringify(params).slice(0, 80)}`, timeoutMs, maxWaitMs: 900_000 });
  if (!r.ok) throw new Error(`${method}: ${r.error?.message}`);
  return r.result;
};
const pct = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const report = {};

// 1. open
let t = performance.now();
const store = new IndexStore(dir);
report.open = { ms: +(performance.now() - t).toFixed(1), rows: store.manifest.rows, gb: +(store.manifest.bytes / 1e9).toFixed(1), tip: store.manifest.tip.height };
const tip = store.manifest.tip.height;

// 2. addresses: outputs from blocks spread over the chain, and some famously heavy ones
const heavy = [
  '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',            // the genesis address, sent dust for fifteen years
  '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo',            // a long-lived exchange cold wallet
  'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h',    // a large exchange wallet
  '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF',            // untouched since 2011
];
let seed = 20260914;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const addresses = new Set();
const heights = Array.from({ length: 24 }, (_, i) => Math.floor(((i + 0.5) / 24) * tip));
for (const h of heights) {
  const b = await call('getblock', [await call('getblockhash', [h]), 2]);
  const found = [];
  for (const tx of b.tx) for (const o of tx.vout) if (o.scriptPubKey.address) found.push(o.scriptPubKey.address);
  for (let k = 0; k < Math.ceil(SAMPLE / heights.length) && found.length; k++) addresses.add(found[Math.floor(rnd() * found.length)]);
}
const sample = [...addresses].slice(0, SAMPLE);

const lookups = [];
for (const [label, list] of [['sampled', sample], ['heavy', heavy]]) {
  for (const a of list) {
    const script = addressToScript(a);
    if (!script) continue;
    const key = scriptKey(script);
    const t0 = performance.now();
    const s = store.summaryForKey(key);
    lookups.push({ label, address: a, ms: performance.now() - t0, txCount: s.txCount, balance: s.balance });
  }
}
const sampled = lookups.filter((l) => l.label === 'sampled');
report.lookup = {
  sampled: sampled.length,
  msP50: +pct(sampled.map((l) => l.ms), 0.5).toFixed(3), msP90: +pct(sampled.map((l) => l.ms), 0.9).toFixed(3),
  msP99: +pct(sampled.map((l) => l.ms), 0.99).toFixed(3), msMax: +Math.max(...sampled.map((l) => l.ms)).toFixed(3),
  txCountP50: pct(sampled.map((l) => l.txCount), 0.5), txCountMax: Math.max(...sampled.map((l) => l.txCount)),
  heavy: lookups.filter((l) => l.label === 'heavy').map((l) => ({ address: l.address, txCount: l.txCount, btc: l.balance / 1e8, ms: +l.ms.toFixed(1) })),
};
// warm: the same lookups again, now that their pages are in the page cache
const warm = [];
for (const l of sampled) { const t0 = performance.now(); store.summaryForKey(scriptKey(addressToScript(l.address))); warm.push(performance.now() - t0); }
report.lookup.warmMsP50 = +pct(warm, 0.5).toFixed(3);
report.lookup.warmMsP99 = +pct(warm, 0.99).toFixed(3);

// 3. correctness against scantxoutset, at one height
const check = [...heavy.slice(1), ...sample.slice(0, Math.max(0, VERIFY - heavy.length + 1))];
for (let attempt = 0; attempt < 3; attempt++) {
  const nodeTip = await call('getblockcount', []);
  // rows the node has connected since the build, for just these scripts
  const want = new Map(check.map((a) => [addressToScript(a).toString('hex'), a]));
  const delta = new Map();
  for (let h = tip + 1; h <= nodeTip; h++) {
    const b = await call('getblock', [await call('getblockhash', [h]), 3]);
    for (const tx of b.tx) {
      for (const o of tx.vout) if (want.has(o.scriptPubKey.hex)) delta.set(o.scriptPubKey.hex, (delta.get(o.scriptPubKey.hex) ?? 0) + Math.round(o.value * 1e8));
      for (const v of tx.vin) if (v.prevout && want.has(v.prevout.scriptPubKey.hex)) delta.set(v.prevout.scriptPubKey.hex, (delta.get(v.prevout.scriptPubKey.hex) ?? 0) - Math.round(v.prevout.value * 1e8));
    }
  }
  t = performance.now();
  const scan = await call('scantxoutset', ['start', check.map((a) => `addr(${a})`)], 900_000);
  const scanMs = performance.now() - t;
  if (scan.height !== nodeTip) continue;                          // a block arrived mid-check: again
  const utxo = new Map();
  for (const u of scan.unspents) { const hex = u.scriptPubKey; utxo.set(hex, (utxo.get(hex) ?? 0) + Math.round(u.amount * 1e8)); }
  const rows = check.map((a) => {
    const hex = addressToScript(a).toString('hex');
    const indexSat = store.summaryForKey(scriptKey(Buffer.from(hex, 'hex')), { limit: 0 }).balance + (delta.get(hex) ?? 0);
    const nodeSat = utxo.get(hex) ?? 0;
    return { address: a, indexSat, nodeSat, match: indexSat === nodeSat };
  });
  report.verify = {
    height: nodeTip, blocksSinceBuild: nodeTip - tip, addresses: rows.length, matches: rows.filter((r) => r.match).length,
    mismatches: rows.filter((r) => !r.match), scantxoutsetSec: +(scanMs / 1000).toFixed(1),
  };
  break;
}
console.log(JSON.stringify(report, null, 1));
process.exit(0);
