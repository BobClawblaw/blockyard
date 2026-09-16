// The address index (server/chain/index/): rows, the parallel build, and lookups -- end to end on a
// block directory written here, with a fake RPC standing in for the node. The real build was checked
// against the node on whole blocks and against scantxoutset balances (docs/MEASUREMENTS.md §30);
// this keeps the machinery honest without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, mkdirSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash256, decodeTx } from '../server/chain/tx.js';
import { Pool } from '../server/chain/index/build.js';
import { MAGIC } from '../server/chain/blockfile.js';
import { blockRows, RowSink, ROW, readRow, scriptKey } from '../server/chain/index/rows.js';
import { buildIndex, JOURNAL, journalText, FORMAT } from '../server/chain/index/build.js';
import { IndexStore } from '../server/chain/index/store.js';
import { HeightTable } from '../server/chain/index/heights.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-tx.json', import.meta.url), 'utf8'));
const hex = (h) => Buffer.from(h, 'hex');

// Core's WriteVarInt and CompressAmount, to write undo records the way Core does
const varint = (n) => { const t = []; for (let len = 0; ; len++) { t.push((n % 128) | (len ? 0x80 : 0)); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; } return Buffer.from(t.reverse()); };
const compressAmount = (n) => { if (n === 0) return 0; let e = 0; while (n % 10 === 0 && e < 9) { n /= 10; e++; } if (e < 9) { const d = n % 10; n = Math.floor(n / 10); return 1 + (n * 9 + d - 1) * 10 + e; } return 1 + (n - 1) * 10 + 9; };
const compact = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 255, n >> 8]));

// a block of real fixture transactions after a coinbase, each input given an invented spent coin
let nonce = 0;
function makeBlock(prevHex, coinbaseHex, txHexes, spentScripts) {
  const header = Buffer.alloc(80);
  hex(prevHex).reverse().copy(header, 4);
  header.writeUInt32LE(0x1d00ffff, 72);
  header.writeUInt32LE(++nonce, 76);                             // every block its own header, so its own hash
  const txs = [coinbaseHex, ...txHexes].map(hex);
  const body = Buffer.concat([header, compact(txs.length), ...txs]);
  const hash = hash256(header).reverse().toString('hex');
  const undoParts = [compact(txHexes.length)];
  const spent = [];
  txHexes.forEach((h, i) => {
    const nin = decodeTx(h).vin.length;
    undoParts.push(compact(nin));
    for (let j = 0; j < nin; j++) {
      const script = spentScripts[(i + j) % spentScripts.length];
      const value = 1000 * (i + 1) + j;
      undoParts.push(varint(500 * 2), varint(0), varint(compressAmount(value)), varint(script.length + 6), script);
      spent.push({ tx: i + 1, script, value });
    }
  });
  return { body, hash, undo: Buffer.concat(undoParts), spent };
}
const frame = (body, trailer = Buffer.alloc(0)) => { const h = Buffer.alloc(8); h.writeUInt32LE(MAGIC.main, 0); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body, trailer]); };

test('rows: one per (script, transaction), paid minus spent, OP_RETURN skipped', () => {
  const tx = FX.txs.find((f) => f.covers.includes('witness_v1_taproot'));
  const coinbase = FX.txs.find((f) => f.covers.includes('segwit-coinbase'));
  const payee = hex(decodeTx(tx.hex).vout[0].scriptPubKey.hex);
  // the transaction spends coins that paid its own first output's script: the row nets the two
  const b = makeBlock('00'.repeat(32), coinbase.hex, [tx.hex], [payee]);
  const sink = new RowSink(4);
  blockRows(b.body, b.undo, 777, sink);
  const rows = [];
  for (let at = 0; at < sink.bytes().length; at += ROW) rows.push(readRow(sink.bytes(), at));
  const decoded = decodeTx(tx.hex);
  const paid = decoded.vout.filter((o) => o.scriptPubKey.hex === payee.toString('hex')).reduce((a, o) => a + o.value_sat, 0);
  const spent = b.spent.reduce((a, s) => a + s.value, 0);
  const mine = rows.filter((r) => r.pos === 1 && r.key === scriptKey(payee));
  assert.equal(mine.length, 1, 'paid and spent in one transaction is one row');
  assert.equal(mine[0].value, paid - spent, 'carrying the net');
  assert.equal(mine[0].height, 777);
  assert.ok(!rows.some((r) => r.key === scriptKey(hex('6a'))), 'no row for an OP_RETURN');
  const cbOutputs = decodeTx(coinbase.hex).vout.filter((o) => !o.scriptPubKey.hex.startsWith('6a'));
  assert.equal(rows.filter((r) => r.pos === 0).length, new Set(cbOutputs.map((o) => o.scriptPubKey.hex)).size, 'the coinbase: one row per script it pays, none for its OP_RETURN');
});

test('the height table keys on the random end of a block hash, not its proof-of-work zeros', () => {
  const t = new HeightTable(1 << 12);
  const a = '00000000000000000001c139c71cde2aaf55c2ba154d1014bbfac15041b5af5c';
  const b = '00000000000000000001c139c71cde2aaf55c2ba154d1014bbfac15041b5af5d'.replace(/5d$/, '11');
  t.set(a, 966923); t.set(b, 12);
  assert.equal(t.get(a), 966923);
  assert.equal(t.get(b), 12, 'two hashes that share their first 20 digits stay apart');
  assert.equal(t.get('00'.repeat(32)), -1);
});

test('BUILD AND LOOK UP: workers, 256 buckets, sort, manifest, and every script found with its rows', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-index-'));
  try {
    const blocksDir = path.join(root, 'blocks'), out = path.join(root, 'index');
    (await import('node:fs')).mkdirSync(blocksDir);
    // a small chain: genesis, then three blocks of fixture transactions, split across two files --
    // and a stale block that must not be indexed
    const txs = FX.txs.filter((f) => f.expect.vin[0].coinbase == null).map((f) => f.hex);
    const coinbase = FX.txs.find((f) => f.covers.includes('segwit-coinbase')).hex;
    const spentScripts = [hex('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'), hex('0014751e76e8199196d454941c45d1b3a323f1433bd6')];
    const genesis = { body: hex(FX.genesis.hex), hash: FX.genesis.expect.hash };
    const chain = [genesis];
    for (let k = 0; k < 3; k++) chain.push(makeBlock(chain[chain.length - 1].hash, coinbase, txs.slice(k * 2, k * 2 + 3), spentScripts));
    const stale = makeBlock(chain[1].hash, coinbase, txs.slice(0, 1), spentScripts);
    const checksum = (prev, undo) => hash256(Buffer.concat([hex(prev).reverse(), undo]));
    // file 0: genesis, block 2 (out of order), block 1; file 1: stale, block 3 -- undo in chain order
    writeFileSync(path.join(blocksDir, 'blk00000.dat'), Buffer.concat([frame(genesis.body), frame(chain[2].body), frame(chain[1].body)]));
    writeFileSync(path.join(blocksDir, 'rev00000.dat'), Buffer.concat([frame(chain[1].undo, checksum(chain[0].hash, chain[1].undo)), frame(chain[2].undo, checksum(chain[1].hash, chain[2].undo))]));
    writeFileSync(path.join(blocksDir, 'blk00001.dat'), Buffer.concat([frame(stale.body), frame(chain[3].body)]));
    writeFileSync(path.join(blocksDir, 'rev00001.dat'), Buffer.concat([frame(stale.undo, checksum(chain[1].hash, stale.undo)), frame(chain[3].undo, checksum(chain[2].hash, chain[3].undo))]));

    const rpc = { batch: async (calls) => calls.map((c) => {
      if (c.method === 'getblockchaininfo') return { ok: true, result: { chain: 'main', blocks: chain.length - 1 } };
      if (c.method === 'getblockhash') return { ok: true, result: chain[c.params[0]].hash };
      return { ok: false, error: { message: c.method } };
    }) };
    let paced = 0;
    const manifest = await buildIndex({ rpc, blocksDir, out, workers: 2, pace: async () => { paced++; } });

    // what the index must contain, computed independently from the blocks
    const expected = new Map();
    const add = (script, height, pos, v) => { const k = `${scriptKey(script)}:${height}:${pos}`; expected.set(k, (expected.get(k) ?? 0) + v); };
    chain.forEach((b, height) => {
      const all = height === 0 ? [genesis.body.subarray(81).toString('hex')] : [coinbase, ...txs.slice((height - 1) * 2, (height - 1) * 2 + 3)];
      all.forEach((h, pos) => { for (const o of decodeTx(h).vout) if (!o.scriptPubKey.hex.startsWith('6a')) add(hex(o.scriptPubKey.hex), height, pos, o.value_sat); });
      for (const s of b.spent ?? []) add(s.script, height, s.tx, -s.value);
    });

    assert.equal(manifest.tip.height, 3);
    assert.ok(paced >= 1, `pace is awaited before each file is handed to a worker (${paced})`);
    assert.equal(manifest.stats.check.missingHeights, 0, 'every height indexed');
    assert.equal(manifest.stats.scan.staleBlocks, 1, 'and the stale block skipped, not indexed');
    assert.equal(manifest.rows, expected.size, 'row for row what the blocks say');
    assert.ok(!readdirSync(out).some((f) => f.endsWith('.unsorted')), 'no unsorted bucket left behind');

    const store = new IndexStore(out);
    const byScript = new Map();
    for (const [k, v] of expected) { const [key, height, pos] = k.split(':'); (byScript.get(key) ?? byScript.set(key, []).get(key)).push({ height: +height, pos: +pos, value: v }); }
    for (const [key, want] of byScript) {
      const got = store.rowsForKey(BigInt(key)).map(({ height, pos, value }) => ({ height, pos, value }));
      want.sort((a, b) => a.height - b.height || a.pos - b.pos);
      assert.deepEqual(got, want, `rows for script key ${key}`);
      const s = store.summaryForKey(BigInt(key), { limit: 2 });
      assert.equal(s.txCount, want.length);
      assert.equal(s.balance, want.reduce((a, r) => a + r.value, 0));
      assert.deepEqual(s.recent.map((r) => [r.height, r.pos]), want.slice(-2).reverse().map((r) => [r.height, r.pos]), 'the newest rows, newest first');
    }
    assert.deepEqual(store.rowsForKey(scriptKey(hex('51'))), [], 'a script nobody paid has no rows');
    // A PAGE NUMBER IS A REQUEST PARAMETER (audit 2026-09-14, M1): a page far past the history must
    // not size a ring by the page -- page 1,000,000 was a 525 MB allocation for a two-row address
    const [anyKey, anyWant] = [...byScript][0];
    const before = process.memoryUsage().arrayBuffers;
    const deep = store.summaryForKey(BigInt(anyKey), { limit: 25, skip: 25_000_000 });
    assert.equal(deep.txCount, anyWant.length, 'the count and balance are still the whole history');
    assert.deepEqual(deep.recent, [], 'and a page past the end is empty');
    assert.ok(process.memoryUsage().arrayBuffers - before < 8e6, `without allocating for the page number (${((process.memoryUsage().arrayBuffers - before) / 1e6).toFixed(1)} MB)`);
    // and rows above a height are not history (audit 2026-09-14, M2): counted apart, in nothing else
    const cut = store.summaryForKey(BigInt(anyKey), { limit: 25, maxHeight: 1 });
    const within = anyWant.filter((r) => r.height <= 1);
    assert.equal(cut.txCount, within.length, 'the count stops at the height');
    assert.equal(cut.postTip, anyWant.length - within.length, 'the rest are reported as beyond it');
    assert.equal(cut.balance, within.reduce((a, r) => a + r.value, 0), 'and the balance is theirs alone');
    assert.ok(cut.recent.every((r) => r.height <= 1), 'the page too');
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('THE PACER holds a build while the node is failing or slow, eases while it is merely slow, and lets it run when it is well', async () => {
  const { rpcPacer } = await import('../server/chain/index/build.js');
  let t = { avgLatencyMs: 100, lastError: null, lastGoodAt: Date.now(), breakerOpen: false };
  const changes = [];
  const pace = rpcPacer({ telemetry: () => t }, { slowMs: 2000, easeMs: 5, holdMs: 5, onChange: (held) => changes.push(held) });
  let t0 = Date.now(); await pace(); assert.ok(Date.now() - t0 < 50, 'a well node: no wait');
  t = { ...t, avgLatencyMs: 900 }; t0 = Date.now(); await pace(); assert.ok(Date.now() - t0 >= 4, 'merely slow: eased');
  t = { ...t, avgLatencyMs: 5000 };
  const p = pace(); await new Promise((r) => setTimeout(r, 12));
  assert.deepEqual(changes, [true], 'too slow: held, and said so once');
  t = { ...t, avgLatencyMs: 100 }; await p;
  assert.deepEqual(changes, [true, false], 'released when the node recovers');
  t = { ...t, lastError: { at: Date.now(), message: 'timeout' }, lastGoodAt: Date.now() - 1000 };
  const q = pace(); await new Promise((r) => setTimeout(r, 12));
  assert.equal(changes.at(-1), true, 'a fresh failure holds too');
  t = { ...t, lastGoodAt: Date.now() + 1 }; await q;
  assert.equal(changes.at(-1), false, 'and a good answer after it releases');
});

test('a worker that dies fails the build, naming the job -- it does not hang at N-1 of N', async () => {
  // 2026-09-15, the first Mac install: "scan 5,720 of 5,721 (100%), about 1 s left (88m ago)".
  // The pool listened for `message` only; a worker killed outright never sent one, and the run
  // waited for it forever.
  const script = new URL('./fixtures/index-worker-dies.js', import.meta.url);
  const pool = new Pool(2, {}, script);
  try {
    const done = [];
    await pool.run([{ type: 'ok', n: 1 }, { type: 'ok', n: 2 }, { type: 'ok', n: 3 }], (msg) => { done.push(msg.job.n); });
    assert.deepEqual(done.sort(), [1, 2, 3], 'a healthy run completes');
  } finally { await pool.close(); }
  const dying = new Pool(2, {}, script);
  try {
    const t0 = Date.now();
    await assert.rejects(
      dying.run([{ type: 'ok', n: 1 }, { type: 'die', n: 2 }, { type: 'ok', n: 3 }, { type: 'ok', n: 4 }], () => {}),
      (err) => /exited with code 3/.test(err.message) && /"type":"die"/.test(err.message) && /fewer workers/.test(err.message),
    );
    assert.ok(Date.now() - t0 < 5000, 'and promptly, not after a timeout');
  } finally { await dying.close(); }
  const throwing = new Pool(1, {}, script);
  try {
    await assert.rejects(throwing.run([{ type: 'throw', n: 1 }], () => {}), (err) => /threw: worker blew up/.test(err.message));
  } finally { await throwing.close(); }
});

// ---------------------------------------------------------------------------------------------------
// AN INTERRUPTED BUILD RESUMES (build.js, THE BUILD JOURNAL). A chain of eight block files, built once
// straight through for reference; then builds stopped at every point that matters -- after some files,
// half way through appending one, with a worker killed, between sorted buckets, after a sort's segments
// were renamed but before the journal said so, and just before the manifest -- each resumed twice over:
// from the directory the failed build left (an orderly stop, which saves what it finished) and from a
// copy taken at the moment of the stop (what a process killed there leaves on the disk). Every resumed
// index must be the reference's byte for byte, and answer every address as it does.
const resumeChain = (() => {
  let cached = null;
  return () => {
    if (cached) return cached;
    const txs = FX.txs.filter((f) => f.expect.vin[0].coinbase == null).map((f) => f.hex);
    const coinbase = FX.txs.find((f) => f.covers.includes('segwit-coinbase')).hex;
    const spentScripts = [hex('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'), hex('0014751e76e8199196d454941c45d1b3a323f1433bd6'), hex('a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87')];
    const chain = [{ body: hex(FX.genesis.hex), hash: FX.genesis.expect.hash }];
    for (let k = 1; k < 16; k++) chain.push(makeBlock(chain[k - 1].hash, coinbase, Array.from({ length: 1 + (k % 3) }, (_, i) => txs[(k * 3 + i) % txs.length]), spentScripts));
    const stale = makeBlock(chain[5].hash, coinbase, [txs[1]], spentScripts);
    cached = { chain, stale };
    return cached;
  };
})();

function writeResumeBlocks(blocksDir) {
  const { chain, stale } = resumeChain();
  const checksum = (prev, undo) => hash256(Buffer.concat([hex(prev).reverse(), undo]));
  mkdirSync(blocksDir, { recursive: true });
  for (let f = 0; f < 8; f++) {
    const a = chain[2 * f], b = chain[2 * f + 1];
    const blocks = f % 2 ? [b, a] : [a, b];                      // odd files out of order
    const undo = [a, b].filter((x) => x.undo).map((x) => frame(x.undo, checksum(chain[chain.indexOf(x) - 1].hash, x.undo)));
    if (f === 3) { blocks.push(stale); undo.push(frame(stale.undo, checksum(chain[5].hash, stale.undo))); }
    writeFileSync(path.join(blocksDir, `blk${String(f).padStart(5, '0')}.dat`), Buffer.concat(blocks.map((x) => frame(x.body))));
    writeFileSync(path.join(blocksDir, `rev${String(f).padStart(5, '0')}.dat`), Buffer.concat(undo));
  }
}

const resumeRpc = ({ tip = 15, hashAt = (h) => resumeChain().chain[h].hash } = {}) => ({ batch: async (calls) => calls.map((c) => {
  if (c.method === 'getblockchaininfo') return { ok: true, result: { chain: 'main', blocks: tip } };
  if (c.method === 'getblockhash') return { ok: true, result: hashAt(c.params[0]) };
  return { ok: false, error: { message: c.method } };
}) });

// everything a reader can see: the segment files' bytes, and every key's rows and summary
function indexView(dir) {
  const segs = readdirSync(dir).filter((f) => f.startsWith('seg-')).sort();
  const bytes = Object.fromEntries(segs.map((f) => [f, readFileSync(path.join(dir, f)).toString('hex')]));
  const store = new IndexStore(dir);
  const keys = new Set();
  for (const f of segs.filter((s) => s.endsWith('.rows'))) { const buf = readFileSync(path.join(dir, f)); for (let at = 0; at < buf.length; at += ROW) keys.add(buf.readBigUInt64BE(at)); }
  const answers = [...keys].sort().map((k) => [String(k), store.rowsForKey(k), store.summaryForKey(k, { limit: 3 })]);
  answers.push(['nobody', store.rowsForKey(scriptKey(hex('51')))]);
  store.close();
  return { bytes, answers, keys: keys.size };
}

test('A BUILD STOPPED ANYWHERE RESUMES to the index an uninterrupted build writes, byte for byte, and no manifest appears before the end', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-resume-'));
  try {
    const blocksDir = path.join(root, 'blocks');
    writeResumeBlocks(blocksDir);
    const refDir = path.join(root, 'ref');
    const ref = await buildIndex({ rpc: resumeRpc(), blocksDir, out: refDir, workers: 2 });
    const want = indexView(refDir);
    assert.equal(ref.stats.check.missingHeights, 0);
    assert.equal(ref.stats.scan.staleBlocks, 1);
    assert.ok(want.keys > 5 && Object.keys(want.bytes).length > 10, `a reference with something in it (${want.keys} keys)`);
    assert.ok(!readdirSync(refDir).includes(JOURNAL), 'a finished build leaves no journal');

    const STOP = new Error('stopped here');
    let sortResults = 0;
    const cases = [
      { name: 'after three files, checkpointed as they finished', checkpointMs: 0, at: (p, i) => p === 'scanned' && i.done === 3, resumedScan: true },
      { name: 'half way through appending a file', checkpointMs: 0, at: (p, i) => p === 'scan-part' && i.part === 1 && i.parts > 2 },
      { name: 'half way through a file, with no checkpoint since the start', checkpointMs: 1e9, at: (p, i) => p === 'scan-part' && i.part === 1 && i.parts > 2 },
      { name: 'with a worker killed', checkpointMs: 1e9, kill: 3 },
      { name: 'between sorted buckets', checkpointMs: 0, at: (p, i) => p === 'sorted' && i.done === 4 },
      { name: 'after a sort renamed its segments, before the journal recorded them', checkpointMs: 0, at: (p) => p === 'sort-result' && ++sortResults === 3 },
      { name: 'just before the manifest', checkpointMs: 0, at: (p) => p === 'manifest' },
    ];
    for (const c of cases) {
      sortResults = 0;
      const out = path.join(root, `stop-${cases.indexOf(c)}`), crash = `${out}-crash`;
      let pool = null, paced = 0, copied = false;
      const hook = (p, i) => {
        if (p === 'pool') { pool = i.pool; return; }
        assert.ok(!readdirSync(out).includes('manifest.json'), `no manifest during the build (${c.name}, ${p})`);
        if (c.at?.(p, i)) { cpSync(out, crash, { recursive: true }); copied = true; throw STOP; }
      };
      const pace = c.kill ? async () => { if (++paced === c.kill) { cpSync(out, crash, { recursive: true }); copied = true; await pool.workers[1].terminate(); } } : null;
      await assert.rejects(buildIndex({ rpc: resumeRpc(), blocksDir, out, workers: 2, hook, pace, checkpointMs: c.checkpointMs }), (err) => err === STOP || /exited with code/.test(err.message), c.name);
      assert.ok(copied, `the stop was reached (${c.name})`);
      for (const dir of [out, crash]) {
        const how = `${c.name}, ${dir === crash ? 'as a crash left it' : 'as the stopped build left it'}`;
        assert.ok(!readdirSync(dir).includes('manifest.json'), `no manifest after the stop (${how})`);
        assert.ok(readdirSync(dir).includes(JOURNAL), `a journal is left (${how})`);
        const logs = [], progress = [];
        const m = await buildIndex({ rpc: resumeRpc(), blocksDir, out: dir, workers: 2, log: (s) => logs.push(s), onProgress: (p) => progress.push(p) });
        assert.ok(logs.some((s) => /resuming the interrupted build/.test(s)) && !logs.some((s) => /discarding/.test(s)), `resumed, not discarded (${how}): ${logs.join(' | ')}`);
        assert.deepEqual(indexView(dir), want, `the same index (${how})`);
        assert.equal(m.rows, ref.rows); assert.deepEqual(m.bucketRows, ref.bucketRows);
        assert.deepEqual({ ...m.stats.scan, workerReadSec: 0, workerCpuSec: 0 }, { ...ref.stats.scan, workerReadSec: 0, workerCpuSec: 0 }, `the same scan counts, no file counted twice (${how})`);
        assert.equal(m.stats.sort.duplicateRowsDropped, ref.stats.sort.duplicateRowsDropped, `no rows appended twice (${how})`);
        assert.ok(!readdirSync(dir).some((f) => f === JOURNAL || f.endsWith('.tmp') || f.endsWith('.unsorted')), `nothing left behind (${how})`);
        const scan = progress.filter((p) => p.phase === 'scan');
        if (c.resumedScan) assert.ok(scan[0].done >= 3 && scan[0].done === scan[0].from, `progress starts where the build stopped, not at zero (${how}: ${JSON.stringify(scan[0])})`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A JOURNAL THAT DOES NOT MATCH, or cannot be trusted, is discarded and the build starts over', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-resume-'));
  try {
    const blocksDir = path.join(root, 'blocks');
    writeResumeBlocks(blocksDir);
    const refDir = path.join(root, 'ref');
    await buildIndex({ rpc: resumeRpc(), blocksDir, out: refDir, workers: 2 });
    const want = indexView(refDir);
    const STOP = new Error('stopped here');
    const stopped = async (out, at = (p, i) => p === 'scanned' && i.done === 4) => {
      await assert.rejects(buildIndex({ rpc: resumeRpc(), blocksDir, out, workers: 2, checkpointMs: 0, hook: (p, i) => { if (at(p, i)) throw STOP; } }), (err) => err === STOP);
      return JSON.parse(JSON.parse(readFileSync(path.join(out, JOURNAL), 'utf8')).body);
    };
    const rewrite = (out, edit) => { const j = JSON.parse(JSON.parse(readFileSync(path.join(out, JOURNAL), 'utf8')).body); edit(j); writeFileSync(path.join(out, JOURNAL), journalText(j)); };
    const cases = [
      { name: 'another index format', edit: (out) => rewrite(out, (j) => { j.format = FORMAT + 1; }), why: /format/ },
      { name: 'another file selection', edit: (out) => rewrite(out, (j) => { j.files = [0, 1]; }), why: /files/ },
      { name: 'a reorganisation below the tip', rpc: resumeRpc({ tip: 16, hashAt: (h) => (h >= 12 ? 'ab'.repeat(30) + String(h).padStart(4, '0') : resumeChain().chain[h].hash) }), why: /reorganisation/ },
      { name: 'a node behind the journal', rpc: resumeRpc({ tip: 9 }), why: /node is at 9/ },
      { name: 'a truncated journal', edit: (out) => { const f = path.join(out, JOURNAL); writeFileSync(f, readFileSync(f).subarray(0, 200)); }, why: /not readable JSON/ },
      { name: 'a journal edited in place', edit: (out) => { const f = path.join(out, JOURNAL); const text = readFileSync(f, 'utf8'); const at = text.indexOf('\\"rows\\":') + 9; writeFileSync(f, text.slice(0, at) + '9' + text.slice(at)); }, why: /checksum/ },
      { name: 'a well-formed journal of the wrong shape', edit: (out) => rewrite(out, (j) => { j.buckets.pop(); }), why: /shape/ },
      { name: 'a bucket shorter than the journal proves', edit: (out) => { const f = readdirSync(out).find((x) => x.endsWith('.unsorted')); writeFileSync(path.join(out, f), Buffer.alloc(0)); }, why: /journal proves/ },
    ];
    for (const c of cases) {
      const out = path.join(root, `bad-${cases.indexOf(c)}`);
      const j = await stopped(out);
      assert.equal(j.phase, 'scan'); assert.equal(j.tip.height, 15);
      c.edit?.(out);
      const logs = [];
      // the reorganised and the lagging node fail here (their invented chains have no blocks on disk);
      // what matters is that the journal was not trusted
      const m = await buildIndex({ rpc: c.rpc ?? resumeRpc(), blocksDir, out, workers: 2, log: (s) => logs.push(s) }).catch((err) => err);
      assert.ok(logs.some((s) => /discarding the interrupted build/.test(s) && c.why.test(s)), `discarded, saying why (${c.name}): ${logs.join(' | ')}`);
      assert.ok(!logs.some((s) => /resuming/.test(s)), `and not resumed (${c.name})`);
      if (c.rpc) continue;
      assert.ok(!(m instanceof Error), `${c.name}: ${m?.message}`);
      assert.deepEqual(indexView(out), want, `a fresh build is the reference (${c.name})`);
    }

    // a bucket changed in place after the scan -- same length, other bytes -- is caught by its CRC
    // before it is sorted: the build fails, the journal goes, and the next start is a fresh build
    const out = path.join(root, 'crc');
    const j = await stopped(out, (p, i) => p === 'sorted' && i.done === 2);
    assert.equal(j.phase, 'sort');
    const victim = readdirSync(out).find((x) => x.endsWith('.unsorted'));
    const buf = readFileSync(path.join(out, victim)); buf[buf.length - 1] ^= 0xff; writeFileSync(path.join(out, victim), buf);
    const logs = [];
    await assert.rejects(buildIndex({ rpc: resumeRpc(), blocksDir, out, workers: 2, log: (s) => logs.push(s) }), /does not hold what the scan wrote/);
    assert.ok(logs.some((s) => /resuming/.test(s)) && logs.some((s) => /discarding/.test(s)), logs.join(' | '));
    assert.ok(!readdirSync(out).includes('manifest.json') && !readdirSync(out).includes(JOURNAL), 'no manifest, and no journal to trust next time');
    await buildIndex({ rpc: resumeRpc(), blocksDir, out, workers: 2 });
    assert.deepEqual(indexView(out), want, 'the fresh build after it is the reference');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
