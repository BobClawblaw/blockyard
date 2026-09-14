#!/usr/bin/env node
// Replay whole blocks from a live node through server/chain/tx.js and compare every field against the
// node's own verbose decoding. A decoder is only as good as the last time it was checked against Core.
//
//   node scripts/decode-check.js [--node <id>] [--blocks N] [--from <height>] [--heights h1,h2,...]
//
// Fetches each block twice, as raw bytes (getblock <hash> 0) and as Core's JSON (getblock <hash> 2),
// decodes the bytes, and reports every disagreement plus the count of each script type seen. Read-only
// RPC, through the same client and lane the monitor uses.
import { loadConfig } from '../server/config.js';
import { RpcClient } from '../server/rpc/client.js';
import { decodeBlock } from '../server/chain/tx.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const cfg = loadConfig();
const node = cfg.nodes.find((n) => n.id === arg('node', null)) ?? cfg.nodes[0];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const rpc = new RpcClient(node, { ...(cfg.rpc ?? {}), ...(node.rpc ?? {}) }, { log: quiet });
const call = async (method, params, timeoutMs = 120_000) => {
  const [r] = await rpc.batch([{ method, params }], { key: `decode-check:${method}:${params[0]}`, priority: 5, maxWaitMs: 120_000, timeoutMs });
  if (!r.ok) throw new Error(`${method}: ${r.error?.message}`);
  return r.result;
};

const info = await call('getblockchaininfo', []);
const count = Math.max(1, Number(arg('blocks', 3)));
const from = Number(arg('from', info.blocks - count + 1));
const sat = (btc) => Math.round(btc * 1e8);
const mismatches = [];
const types = {};
let txs = 0, inputs = 0, outputs = 0, bytes = 0, decodeMs = 0;
const differ = (where, got, want) => { if (got !== want && mismatches.length < 50) mismatches.push(`${where}: decoded ${JSON.stringify(got)}, node ${JSON.stringify(want)}`); return got !== want; };

const heights = arg('heights', null) ? arg('heights').split(',').map(Number) : Array.from({ length: count }, (_, i) => from + i);
for (const h of heights) {
  const hash = await call('getblockhash', [h]);
  const raw = await call('getblock', [hash, 0]);
  const want = await call('getblock', [hash, 2], 300_000);
  const buf = Buffer.from(raw, 'hex');
  const t0 = performance.now();
  const got = decodeBlock(buf, info.chain);
  decodeMs += performance.now() - t0;
  bytes += buf.length;
  for (const k of ['hash', 'version', 'previousblockhash', 'merkleroot', 'time', 'bits', 'nonce', 'size', 'nTx']) differ(`block ${h} ${k}`, got[k], want[k]);
  want.tx.forEach((w, i) => {
    const g = got.tx[i];
    const at = `block ${h} tx ${i} (${w.txid.slice(0, 12)})`;
    txs++;
    for (const k of ['txid', 'hash', 'version', 'size', 'vsize', 'weight', 'locktime']) differ(`${at} ${k}`, g[k], w[k]);
    differ(`${at} vin count`, g.vin.length, w.vin.length);
    w.vin.forEach((wi, j) => {
      const gi = g.vin[j] ?? {};
      inputs++;
      if (wi.coinbase != null) differ(`${at} vin ${j} coinbase`, gi.coinbase, wi.coinbase);
      else {
        differ(`${at} vin ${j} txid`, gi.txid, wi.txid);
        differ(`${at} vin ${j} vout`, gi.vout, wi.vout);
        differ(`${at} vin ${j} scriptSig`, gi.scriptSig?.hex, wi.scriptSig?.hex);
      }
      differ(`${at} vin ${j} sequence`, gi.sequence, wi.sequence);
      differ(`${at} vin ${j} witness`, JSON.stringify(gi.txinwitness ?? null), JSON.stringify(wi.txinwitness ?? null));
    });
    differ(`${at} vout count`, g.vout.length, w.vout.length);
    w.vout.forEach((wo, j) => {
      const go = g.vout[j] ?? { scriptPubKey: {} };
      outputs++;
      types[wo.scriptPubKey.type] = (types[wo.scriptPubKey.type] ?? 0) + 1;
      differ(`${at} vout ${j} value`, go.value_sat, sat(wo.value));
      differ(`${at} vout ${j} n`, go.n, wo.n);
      differ(`${at} vout ${j} hex`, go.scriptPubKey.hex, wo.scriptPubKey.hex);
      differ(`${at} vout ${j} type`, go.scriptPubKey.type, wo.scriptPubKey.type);
      differ(`${at} vout ${j} address`, go.scriptPubKey.address ?? null, wo.scriptPubKey.address ?? null);
    });
  });
}

console.log(`${node.id} (${info.chain}): ${heights.length} blocks (${heights[0]}..${heights[heights.length - 1]}), ${txs} transactions, ${inputs} inputs, ${outputs} outputs, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`decoded in ${decodeMs.toFixed(0)} ms (${(bytes / 1e6 / (decodeMs / 1000)).toFixed(1)} MB/s, ${(txs / (decodeMs / 1000)).toFixed(0)} tx/s)`);
console.log('script types:', JSON.stringify(types));
console.log(mismatches.length ? `MISMATCHES (${mismatches.length}${mismatches.length >= 50 ? '+' : ''}):\n  ${mismatches.join('\n  ')}` : 'every field matches the node');
process.exit(mismatches.length ? 1 : 0);
