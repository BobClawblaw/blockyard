// The address index (server/chain/index/): rows, the parallel build, and lookups -- end to end on a
// block directory written here, with a fake RPC standing in for the node. The real build was checked
// against the node on whole blocks and against scantxoutset balances (docs/MEASUREMENTS.md §30);
// this keeps the machinery honest without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash256, decodeTx } from '../server/chain/tx.js';
import { MAGIC } from '../server/chain/blockfile.js';
import { blockRows, RowSink, ROW, readRow, scriptKey } from '../server/chain/index/rows.js';
import { buildIndex } from '../server/chain/index/build.js';
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
