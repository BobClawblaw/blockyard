#!/usr/bin/env node
// STEP 4 of the address index (docs/DEFECTS.md): what does storing it cost? Measured on real rows.
//
//   node --no-warnings scripts/index-bench.js [--files 384,2685,5370] [--out <dir>]
//
// THE ROW. One row per (address script, transaction) that touched it -- an output paying the script,
// or an input spending an output that paid it (the spent script comes from the undo file, so no UTXO
// replay). Key: the first 8 bytes of sha256(script), then the block height and the transaction's
// position in the block. Value (optional): the net amount that transaction moved for that script.
// Everything else -- the transaction itself, its txid -- stays in the node, which has txindex.
//
// It builds the rows for the sampled files, then stores them two ways and measures each:
//   A. node:sqlite, a WITHOUT ROWID table keyed (script hash, height, position) -- the runtime's own
//      SQLite, already used by server/store/ledger.js, so no dependency
//   B. sorted fixed-size rows in a flat file with a sparse block index, looked up by binary search
// and reports bytes per row, rows per second to write, and lookup latency for real addresses.
import { openSync, readSync, writeSync, closeSync, fstatSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.js';
import { RpcClient } from '../server/rpc/client.js';
import { Reader, readHeader, readTx } from '../server/chain/tx.js';
import { xorKey, readChainFile, records, decodeBlockUndo, pairBlocksWithUndo, MAGIC } from '../server/chain/blockfile.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const dir = arg('dir', '/storage/core-oracle/blocks');
const files = arg('files', '384,2685,5370').split(',').map(Number);
const outDir = arg('out', path.join(process.env.TMPDIR ?? '/tmp', 'blockyard-index-bench'));
const ms = (t0) => performance.now() - t0;
const key = xorKey(dir);

const cfg = loadConfig();
const node = cfg.nodes.find((n) => n.datadir && dir.startsWith(n.datadir)) ?? cfg.nodes[0];
const rpc = new RpcClient(node, { ...(cfg.rpc ?? {}), ...(node.rpc ?? {}) }, { log: { info() {}, warn() {}, error() {}, debug() {} } });
const heightsOf = async (hashes) => {
  const got = await rpc.batch(hashes.map((h) => ({ method: 'getblockheader', params: [h] })), { key: `bench:hdr:${hashes[0]}`, timeoutMs: 120_000, maxWaitMs: 120_000 });
  return got.map((g) => (g.ok ? g.result.height : null));
};

// --- rows ------------------------------------------------------------------
// kept in parallel typed arrays while building; the stores below pick their own layout
let n = 0;
const cap = 40_000_000;
const SH = new BigUint64Array(cap), HT = new Uint32Array(cap), POS = new Uint16Array(cap), VAL = new Float64Array(cap);
const sh8 = (script) => createHash('sha256').update(script).digest().readBigUInt64BE(0);

const build = { decodeMs: 0, blocks: 0, txs: 0, rawRows: 0 };
for (const f of files) {
  const id = String(f).padStart(5, '0');
  const blk = readChainFile(path.join(dir, `blk${id}.dat`), key);
  const rev = readChainFile(path.join(dir, `rev${id}.dat`), key);
  const blocks = [...records(blk, MAGIC.main)].map((r) => { const rd = new Reader(r.body); const h = readHeader(rd); return { rec: r, hash: h.hash, previousblockhash: h.previousblockhash, ntx: rd.varint(), rd }; });
  const pairs = pairBlocksWithUndo(blocks, [...records(rev, MAGIC.main, 32)]);
  const idx = [...pairs.keys()];
  const heights = await heightsOf(idx.map((i) => blocks[i].hash));
  const t0 = performance.now();
  idx.forEach((i, k) => {
    const b = blocks[i], height = heights[k];
    if (height == null) return;
    const undo = decodeBlockUndo(pairs.get(i).body);
    const rd = b.rd;
    for (let p = 0; p < b.ntx; p++) {
      const tx = readTx(rd);
      build.txs++;
      const moved = new Map();                       // sh8 -> net sats for this transaction
      for (const o of tx.vout) {
        if (o.scriptPubKey.type === 'nulldata') continue;
        const s = sh8(Buffer.from(o.scriptPubKey.hex, 'hex'));
        moved.set(s, (moved.get(s) ?? 0) + o.value_sat); build.rawRows++;
      }
      if (p > 0) for (const c of undo[p - 1]) {
        const s = sh8(c.script);
        moved.set(s, (moved.get(s) ?? 0) - c.value_sat); build.rawRows++;
      }
      for (const [s, v] of moved) { SH[n] = s; HT[n] = height; POS[n] = p; VAL[n] = v; n++; }
    }
    build.blocks++;
  });
  build.decodeMs += ms(t0);
  console.log(`blk${id}: ${idx.length} blocks, rows so far ${n.toLocaleString()} (raw ${build.rawRows.toLocaleString()} before merging a script's outputs and inputs within one transaction)`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
const toSigned = (u) => BigInt.asIntN(64, u);

// lookups: real scripts, chosen from the rows, so every query has at least one hit
let seed = 20260914;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const probes = Array.from({ length: 20_000 }, () => SH[Math.floor(rnd() * n)]);

// --- A. node:sqlite ----------------------------------------------------------
const A = {};
{
  const file = path.join(outDir, 'hist.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA page_size = 16384; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA locking_mode = EXCLUSIVE;');
  db.exec('CREATE TABLE hist (sh INTEGER NOT NULL, h INTEGER NOT NULL, p INTEGER NOT NULL, v INTEGER NOT NULL, PRIMARY KEY (sh, h, p)) WITHOUT ROWID');
  const ins = db.prepare('INSERT OR REPLACE INTO hist (sh, h, p, v) VALUES (?, ?, ?, ?)');
  // in the order blocks arrive -- what a live, incremental index would do
  let t0 = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    ins.run(toSigned(SH[i]), HT[i], POS[i], VAL[i]);
    if (i % 500_000 === 499_999) { db.exec('COMMIT'); db.exec('BEGIN'); }
  }
  db.exec('COMMIT');
  A.insertMs = ms(t0);
  A.bytes = statSync(file).size;
  t0 = performance.now(); db.exec('VACUUM'); A.vacuumMs = ms(t0);
  A.bytesVacuumed = statSync(file).size;
  const q = db.prepare('SELECT h, p, v FROM hist WHERE sh = ? ORDER BY h DESC, p DESC LIMIT 25');
  for (let i = 0; i < 2000; i++) q.all(toSigned(probes[i]));      // warm
  t0 = performance.now(); let hits = 0;
  for (const s of probes) hits += q.all(toSigned(s)).length;
  A.lookupMs = ms(t0) / probes.length; A.hits = hits;
  db.close();
}

// --- B. sorted flat file -----------------------------------------------------
// row: sh8 8 | height 3 | position 2 | value 8 (signed sats: one transaction has moved 500,000 BTC, past 6 bytes'
// reach of 1.4 M only by a margin nobody should bet a format on) = 21 bytes; history-only drops the value (13)
const B = {};
{
  let t0 = performance.now();
  // bucket by the top 16 bits of the hash, then sort each small bucket: a comparator sort over tens of
  // millions of rows at once is what makes a naive JS sort slow
  const bucketOf = (i) => Number(SH[i] >> 48n);
  const counts = new Uint32Array(65537);
  for (let i = 0; i < n; i++) counts[bucketOf(i) + 1]++;
  for (let b = 0; b < 65536; b++) counts[b + 1] += counts[b];
  const fill = counts.slice();
  for (let i = 0; i < n; i++) order[fill[bucketOf(i)]++] = i;
  for (let b = 0; b < 65536; b++) {
    const sub = order.subarray(counts[b], counts[b + 1]);
    if (sub.length > 1) sub.sort((x, y) => (SH[x] < SH[y] ? -1 : SH[x] > SH[y] ? 1 : HT[x] - HT[y] || POS[x] - POS[y]));
  }
  B.sortMs = ms(t0);
  const ROW = 21, BLOCK = 4096;                      // rows per index entry
  const file = path.join(outDir, 'hist.rows');
  const fd = openSync(file, 'w');
  const buf = Buffer.allocUnsafe(ROW * 65536);
  const sparse = new BigUint64Array(Math.ceil(n / BLOCK));
  t0 = performance.now();
  let off = 0;
  for (let i = 0; i < n; i++) {
    const r = order[i];
    if (i % BLOCK === 0) sparse[i / BLOCK] = SH[r];
    const at = off;
    buf.writeBigUInt64BE(SH[r], at);
    buf.writeUIntBE(HT[r], at + 8, 3);
    buf.writeUInt16BE(POS[r], at + 11);
    buf.writeBigInt64BE(BigInt(VAL[r]), at + 13);
    off += ROW;
    if (off === buf.length) { writeSync(fd, buf, 0, off); off = 0; }
  }
  if (off) writeSync(fd, buf, 0, off);
  closeSync(fd);
  B.writeMs = ms(t0);
  B.bytes = statSync(file).size + sparse.byteLength;
  B.historyOnlyBytes = n * 13 + sparse.byteLength;
  // lookup: binary search the sparse index in memory, read one index block of rows, scan it
  const rfd = openSync(file, 'r');
  const block = Buffer.allocUnsafe(ROW * BLOCK * 2);
  const lookup = (s) => {
    let lo = 0, hi = sparse.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sparse[mid] < s) lo = mid; else hi = mid - 1; }
    const got = readSync(rfd, block, 0, block.length, lo * BLOCK * ROW);
    let found = 0;
    for (let o = 0; o + ROW <= got; o += ROW) { const k = block.readBigUInt64BE(o); if (k === s) found++; else if (k > s) break; }
    return found;
  };
  for (let i = 0; i < 2000; i++) lookup(probes[i]);
  t0 = performance.now(); let hits = 0;
  for (const s of probes) hits += lookup(s);
  B.lookupMs = ms(t0) / probes.length; B.hits = hits;
  closeSync(rfd);
}

// --- A2. node:sqlite, bulk-loaded in key order --------------------------------
// A B-tree fed random keys stops fitting in memory long before 5 billion rows and then pays a seek per
// insert; fed sorted keys it only ever appends to its rightmost page. This is SQLite's bulk-build path,
// and the one a full build would have to take -- which means sorting the rows first either way.
{
  const file = path.join(outDir, 'hist-sorted.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA page_size = 16384; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA locking_mode = EXCLUSIVE;');
  db.exec('CREATE TABLE hist (sh INTEGER NOT NULL, h INTEGER NOT NULL, p INTEGER NOT NULL, v INTEGER NOT NULL, PRIMARY KEY (sh, h, p)) WITHOUT ROWID');
  const ins = db.prepare('INSERT INTO hist (sh, h, p, v) VALUES (?, ?, ?, ?)');
  // the flat file's order is unsigned; SQLite's INTEGER order is signed, so feed the negative half first
  const t0 = performance.now();
  db.exec('BEGIN');
  let k = 0;
  const firstNonNeg = order.findIndex((r) => SH[r] >= 0x8000000000000000n);
  const seq = firstNonNeg < 0 ? [order] : [order.subarray(firstNonNeg), order.subarray(0, firstNonNeg)];
  for (const part of seq) for (const r of part) {
    ins.run(toSigned(SH[r]), HT[r], POS[r], VAL[r]);
    if (++k % 500_000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
  }
  db.exec('COMMIT');
  A.sortedInsertMs = ms(t0);
  A.sortedBytes = statSync(file).size;
  db.close();
}

const perRow = (bytes) => +(bytes / n).toFixed(2);
const report = {
  sample: { files, blocks: build.blocks, txs: build.txs, rows: n, rawRows: build.rawRows, rowsPerTx: +(n / build.txs).toFixed(3), mergedAway: +(1 - n / build.rawRows).toFixed(3) },
  sqlite: { bytesPerRow: perRow(A.bytes), bytesPerRowVacuumed: perRow(A.bytesVacuumed), bytesPerRowSortedLoad: perRow(A.sortedBytes), insertRowsPerSec: Math.round(n / (A.insertMs / 1000)), sortedInsertRowsPerSec: Math.round(n / (A.sortedInsertMs / 1000)), vacuumSec: +(A.vacuumMs / 1000).toFixed(1), lookupMs: +A.lookupMs.toFixed(4), meanHitsPerLookup: +(A.hits / probes.length).toFixed(2) },
  sortedFile: { bytesPerRow: perRow(B.bytes), bytesPerRowHistoryOnly: perRow(B.historyOnlyBytes), sortRowsPerSec: Math.round(n / (B.sortMs / 1000)), writeRowsPerSec: Math.round(n / (B.writeMs / 1000)), lookupMs: +B.lookupMs.toFixed(4), meanHitsPerLookup: +(B.hits / probes.length).toFixed(2) },
};
console.log(JSON.stringify(report, null, 1));
rmSync(outDir, { recursive: true, force: true });
process.exit(0);
