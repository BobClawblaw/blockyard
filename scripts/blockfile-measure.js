#!/usr/bin/env node
// What would an address index over this node's chain cost? Measured on the node's own files, not
// estimated from blog posts.
//
//   node scripts/blockfile-measure.js [--dir <datadir>/blocks] [--files 0,500,...] [--sample N] [--verify]
//
// For each sampled blkNNNNN.dat and its revNNNNN.dat it times, separately: the disk read, the XOR,
// decoding every block (transactions, output scripts, addresses), pairing each block with its undo
// record (shape, then Core's checksum), and decoding the undo data (every spent output, with its
// address). It counts what an index would have to store -- a funding row per spendable output, a
// spending row per input -- and extrapolates across all files by interpolating between the samples,
// because file contents change a great deal over the chain's history.
//
// --verify also checks one block per sampled file against getblock <hash> 3 (every prevout), so the
// numbers are never measured on a decoder that is quietly wrong.
//
// Read-only: the node's files are opened for reading and nothing else.
import { openSync, readSync, closeSync, fstatSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Reader, readHeader, readTx, classifyScript } from '../server/chain/tx.js';
import { xorKey, unxor, records, decodeBlockUndo, pairBlocksWithUndo, MAGIC } from '../server/chain/blockfile.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const dir = arg('dir', '/storage/core-oracle/blocks');
const all = readdirSync(dir).filter((f) => /^blk\d{5}\.dat$/.test(f)).sort();
const last = all.length - 1;
// the newest file is still being written, so the default sample stops one short of it
const sample = arg('files', null)
  ? arg('files').split(',').map(Number)
  : Array.from({ length: Number(arg('sample', 16)) }, (_, i) => Math.round((i * (last - 1)) / (Number(arg('sample', 16)) - 1)));
const key = xorKey(dir);
const verify = process.argv.includes('--verify');
const ms = (t0) => performance.now() - t0;

let rpcCall = null;
if (verify) {
  const { loadConfig } = await import('../server/config.js');
  const { RpcClient } = await import('../server/rpc/client.js');
  const cfg = loadConfig();
  const node = cfg.nodes.find((n) => n.datadir && dir.startsWith(n.datadir)) ?? cfg.nodes[0];
  const rpc = new RpcClient(node, { ...(cfg.rpc ?? {}), ...(node.rpc ?? {}) }, { log: { info() {}, warn() {}, error() {}, debug() {} } });
  rpcCall = async (method, params) => {
    const [r] = await rpc.batch([{ method, params }], { key: `measure:${method}:${params[0]}`, timeoutMs: 600_000, maxWaitMs: 600_000 });
    if (!r.ok) throw new Error(`${method}: ${r.error?.message}`);
    return r.result;
  };
}

function readRaw(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    while (got < size) { const n = readSync(fd, buf, got, size - got, got); if (n === 0) break; got += n; }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

const rows = [];
for (const n of sample) {
  const id = String(n).padStart(5, '0');
  const r = { file: n };
  let t = performance.now();
  const blk = readRaw(path.join(dir, `blk${id}.dat`));
  const rev = readRaw(path.join(dir, `rev${id}.dat`));
  r.readMs = ms(t); r.blkMB = blk.length / 1e6; r.revMB = rev.length / 1e6;
  t = performance.now(); unxor(blk, key); unxor(rev, key); r.xorMs = ms(t);

  // blocks: full decode, addresses included (classifyScript runs per output inside readTx)
  t = performance.now();
  const blocks = [];
  let txs = 0, outputs = 0, inputs = 0, funding = 0, height0 = null;
  const scripts = new Set();
  for (const rec of records(blk, MAGIC.main)) {
    const rd = new Reader(rec.body);
    const header = readHeader(rd);
    const ntx = rd.varint();
    const inCounts = [];
    for (let i = 0; i < ntx; i++) {
      const tx = readTx(rd);
      txs++; outputs += tx.vout.length;
      if (i > 0) { inputs += tx.vin.length; inCounts.push(tx.vin.length); }
      for (const o of tx.vout) if (o.scriptPubKey.type !== 'nulldata') { funding++; scripts.add(createHash('sha256').update(o.scriptPubKey.hex).digest('base64').slice(0, 11)); }
    }
    blocks.push({ header, ntx, inCounts });
  }
  r.decodeMs = ms(t);
  Object.assign(r, { blocks: blocks.length, txs, outputs, inputs, funding, distinctScripts: scripts.size });

  // pair each block with its undo record: tx count first, then Core's checksum
  t = performance.now();
  const undos = [...records(rev, MAGIC.main, 32)];
  const pairs = pairBlocksWithUndo(blocks.map((b) => ({ hash: b.header.hash, previousblockhash: b.header.previousblockhash, ntx: b.ntx })), undos);
  const paired = [...pairs].map(([i, u]) => [blocks[i], u]);
  r.pairMs = ms(t); r.paired = paired.length; r.undoRecords = undos.length;

  // undo: every spent coin, with the address its script pays
  t = performance.now();
  let spent = 0, special = 0;
  for (const [, u] of paired) {
    for (const coins of decodeBlockUndo(u.body)) for (const c of coins) {
      spent++;
      classifyScript(c.script);
      if (c.script.length === 67) special++;       // an uncompressed-key P2PK, rebuilt from 33 bytes
    }
  }
  r.undoMs = ms(t); r.spent = spent; r.p2pkUncompressedSpent = special;

  if (verify && paired.length) {
    const [b, u] = paired[Math.floor(paired.length / 2)];
    const want = await rpcCall('getblock', [b.header.hash, 3]);
    const undo = decodeBlockUndo(u.body);
    let bad = 0, checked = 0;
    want.tx.slice(1).forEach((tx, i) => tx.vin.forEach((vin, j) => {
      const c = undo[i][j]; const p = vin.prevout; checked++;
      if (c.value_sat !== Math.round(p.value * 1e8) || c.script.toString('hex') !== p.scriptPubKey.hex || c.height !== p.height || c.coinbase !== p.generated) bad++;
    }));
    r.verified = { height: want.height, coins: checked, mismatches: bad };
    height0 = want.height;
  }
  rows.push(r);
  const f = (v, d = 0) => v.toFixed(d);
  console.log(`blk${id}: ${f(r.blkMB)}+${f(r.revMB)} MB read ${f(r.readMs)} ms, xor ${f(r.xorMs)}, decode ${f(r.decodeMs)}, pair ${f(r.pairMs)}, undo ${f(r.undoMs)} | ${r.blocks} blocks (${r.paired} paired), ${txs} tx, ${outputs} out, ${inputs} in${r.verified ? ` | verified h${r.verified.height}: ${r.verified.coins} coins, ${r.verified.mismatches} mismatches` : ''}${height0 == null ? '' : ''}`);
}

// extrapolate across every file by linear interpolation between sampled files
const at = (k, fileNo) => {
  const s = rows;
  if (fileNo <= s[0].file) return s[0][k];
  for (let i = 1; i < s.length; i++) if (fileNo <= s[i].file) {
    const a = s[i - 1], b = s[i]; const u = (fileNo - a.file) / Math.max(1, b.file - a.file);
    return a[k] + (b[k] - a[k]) * u;
  }
  return s[s.length - 1][k];
};
const total = (k) => { let v = 0; for (let fno = 0; fno <= last; fno++) v += at(k, fno); return v; };
const T = Object.fromEntries(['blkMB', 'revMB', 'readMs', 'xorMs', 'decodeMs', 'pairMs', 'undoMs', 'txs', 'outputs', 'inputs', 'funding', 'spent'].map((k) => [k, total(k)]));
const h = (x) => (x / 3.6e6).toFixed(2);
const G = (x) => (x / 1e9).toFixed(2);
const summary = {
  files: all.length, sampled: sample.length,
  data: { blkGB: +(T.blkMB / 1e3).toFixed(1), revGB: +(T.revMB / 1e3).toFixed(1) },
  counts: { txs: Math.round(T.txs), outputs: Math.round(T.outputs), inputs: Math.round(T.inputs), fundingRows: Math.round(T.funding), spendingRows: Math.round(T.spent) },
  singleCoreHours: { read: +h(T.readMs), xor: +h(T.xorMs), decodeBlocks: +h(T.decodeMs), pairUndo: +h(T.pairMs), decodeUndo: +h(T.undoMs), cpuTotal: +h(T.xorMs + T.decodeMs + T.pairMs + T.undoMs) },
  // raw row bytes for two designs, before any storage-engine overhead
  indexGB: {
    historyOnly: +G((T.funding + T.spent) * 12),       // script-hash prefix 8 B + height 4 B, and outpoint prefix 8 B + height 4 B
    withValues: +G((T.funding + T.spent) * 20),        // the same plus an 8 B amount, so a balance needs no node call
  },
};
console.log(JSON.stringify(summary, null, 1));
const out = arg('json', null);
if (out) writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), dir, sample: rows, summary }, null, 1) + '\n');
process.exit(0);
