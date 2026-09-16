// THE ADDRESS INDEX AGAINST A SECOND IMPLEMENTATION (test/helpers/reference-index.js). Until now the
// index's answers were checked against a live node by hand (scripts/index-benchmark.js --verify for
// balances, nothing at all for history). Here a seeded synthetic chain (test/helpers/chain-synth.js)
// is written as obfuscated blk/rev files, the real index is built over them, and for EVERY address
// its balance and its whole history -- walked page by page through the store's own paged query, to
// the end -- must equal what a naive UTXO replay of the same blocks says. Then again after the live
// follower carries the index forward through folds and a layer merge, after a reorganisation it
// repairs, and after a restart; and a reorganisation it is designed not to repair must be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readChainFile, records, MAGIC } from '../server/chain/blockfile.js';
import { Reader, readHeader } from '../server/chain/tx.js';
import { buildIndex } from '../server/chain/index/build.js';
import { IndexStore } from '../server/chain/index/store.js';
import { LiveIndex } from '../server/chain/index/live.js';
import { ChainGen, verboseBlock, frame, undoChecksum, xor, TYPES } from './helpers/chain-synth.js';
import { ReferenceIndex } from './helpers/reference-index.js';

const BASE_TIP = 300;               // the full build covers 0..300
const RING_MAX_BLIND = 4096;        // store.js: a page past this many rows counts the history first

// Walk an address's whole history through the store's paged query, newest page first, and compare it
// with the reference: every page's count and balance, then the rows in order, heights and amounts.
function compareAll(store, ref, label) {
  const balances = ref.balances();
  let maxRows = 0, rows = 0;
  for (const [scriptHex, want] of ref.history) {
    const script = Buffer.from(scriptHex, 'hex');
    const net = want.reduce((a, r) => a + r.value, 0);
    assert.equal(net, balances.get(scriptHex) ?? 0, `${label}: the reference agrees with itself for ${scriptHex}`);
    // pages of a size that makes several of them; for the largest histories, pages that reach past
    // the ring's blind limit so the counting path is taken
    const limit = want.length > RING_MAX_BLIND ? 1000 : Math.max(1, Math.ceil(want.length / 3));
    const got = [];
    for (let skip = 0, pages = 0; ; skip += limit, pages++) {
      assert.ok(pages <= want.length + 1, `${label}: paging ends for ${scriptHex}`);
      const s = store.summary(script, { skip, limit });
      assert.equal(s.txCount, want.length, `${label}: transaction count for ${scriptHex}`);
      assert.equal(s.balance, net, `${label}: balance for ${scriptHex}`);
      if (!s.recent.length) {
        assert.equal(s.received, want.reduce((a, r) => a + Math.max(0, r.value), 0), `${label}: received for ${scriptHex}`);
        assert.equal(s.sent, want.reduce((a, r) => a - Math.min(0, r.value), 0), `${label}: sent for ${scriptHex}`);
        break;
      }
      got.push(...s.recent);
    }
    got.reverse();
    const shaped = got.map(({ height, pos, value }) => ({ height, pos, value }));
    if (shaped.length !== want.length || shaped.some((r, i) => r.height !== want[i].height || r.pos !== want[i].pos || r.value !== want[i].value)) {
      const i = shaped.findIndex((r, k) => !want[k] || r.height !== want[k].height || r.pos !== want[k].pos || r.value !== want[k].value);
      assert.fail(`${label}: history of ${scriptHex} differs at row ${i < 0 ? want.length : i} of ${want.length}: index ${JSON.stringify(shaped[i])}, reference ${JSON.stringify(want[i < 0 ? shaped.length : i])}`);
    }
    maxRows = Math.max(maxRows, want.length); rows += want.length;
  }
  // and an address nobody used has nothing
  const none = store.summary(Buffer.from('0014' + 'ee'.repeat(20), 'hex'), { limit: 5 });
  assert.deepEqual([none.txCount, none.balance, none.recent.length], [0, 0, 0], `${label}: an unused address is empty`);
  return { addresses: ref.history.size, rows, maxRows };
}

// a node that serves a chain of generated blocks, which the test can replace from any height
function fakeNode(blocks) {
  const node = { blocks };
  const verbose = new Map();
  const v = (b) => verbose.get(b.hash) ?? verbose.set(b.hash, verboseBlock(b)).get(b.hash);
  node.rpc = { batch: async (calls) => calls.map((c) => {
    const tip = node.blocks.length - 1;
    if (c.method === 'getblockchaininfo') return { ok: true, result: { chain: 'main', blocks: tip } };
    if (c.method === 'getblockcount') return { ok: true, result: tip };
    if (c.method === 'getblockhash') return node.blocks[c.params[0]] ? { ok: true, result: node.blocks[c.params[0]].hash } : { ok: false, error: { message: 'Block height out of range' } };
    if (c.method === 'getblock') { const b = node.blocks.find((x) => x.hash === c.params[0]); return b ? { ok: true, result: v(b) } : { ok: false, error: { message: 'Block not found' } }; }
    return { ok: false, error: { message: c.method } };
  }) };
  return node;
}

test('THE INDEX EQUALS A NAIVE UTXO REPLAY: every address, balance and full paged history, built, followed, reorganised', async () => {
  const t0 = performance.now();
  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-index-ref-'));
  try {
    // --- the chain, and its block files -------------------------------------------------------
    const gen = new ChainGen(20260916);
    gen.extendTo(99);
    const beforeStale = gen.snapshot();
    gen.extendTo(BASE_TIP);
    // a block that was connected and then reorganised away: in the files, with its undo, not on the chain
    const stale = ChainGen.resume(gen, beforeStale, 7).block();

    const blocksDir = path.join(root, 'blocks'), out = path.join(root, 'index');
    mkdirSync(blocksDir);
    const key = Buffer.from('3a17c4e2905bd168', 'hex');
    writeFileSync(path.join(blocksDir, 'xor.dat'), key);
    const files = [[0, 80], [81, 170], [171, 240], [241, BASE_TIP]];
    files.forEach(([from, to], f) => {
      const inFile = gen.blocks.slice(from, to + 1);
      if (f === 1) inFile.splice(20, 0, stale);
      // blk: as blocks arrived -- neighbours swapped here and there, and one stored twice
      const arrived = inFile.slice();
      for (let i = 1; i < arrived.length - 1; i += 7) [arrived[i], arrived[i + 1]] = [arrived[i + 1], arrived[i]];
      arrived.push(arrived[3]);
      const id = String(f).padStart(5, '0');
      writeFileSync(path.join(blocksDir, `blk${id}.dat`), xor(Buffer.concat(arrived.map((b) => frame(b.body))), key));
      // rev: as blocks were connected -- chain order, the stale one where it was connected
      const connected = inFile.filter((b) => b.height > 0);
      writeFileSync(path.join(blocksDir, `rev${id}.dat`), xor(Buffer.concat(connected.map((b) => frame(b.undo, undoChecksum(b.prev, b.undo)))), key));
    });

    // --- the build, against the reference read from those same files --------------------------
    const node = fakeNode(gen.blocks.slice());
    const manifest = await buildIndex({ rpc: node.rpc, blocksDir, out, workers: 2 });
    assert.equal(manifest.tip.height, BASE_TIP);
    assert.equal(manifest.stats.scan.staleBlocks, 1, 'the stale block is skipped');

    const byHash = new Map();
    files.forEach((_, f) => {
      const id = String(f).padStart(5, '0');
      for (const rec of records(readChainFile(path.join(blocksDir, `blk${id}.dat`), key), MAGIC.main, 0, key)) byHash.set(readHeader(new Reader(rec.body)).hash, Buffer.from(rec.body));
    });
    const ref = ReferenceIndex.over(node.blocks.map((b) => byHash.get(b.hash)));

    const base = compareAll(new IndexStore(out), ref, 'the built index');
    const hotRows = ref.history.get(gen.hot.toString('hex')).length;
    assert.ok(hotRows > RING_MAX_BLIND, `one address outgrows the page ring (${hotRows} rows)`);
    // the chain is the shape it claims to be
    let txs = 0, sameBlockSpends = 0, multiInOut = 0, netZero = 0;
    for (const b of gen.blocks) {
      txs += b.spentByTx.length + 1;
      for (const ins of b.spentByTx) if (ins.some((c) => c.height === b.height)) sameBlockSpends++;
    }
    for (const b of node.blocks.map(verboseBlock)) for (const tx of b.tx) {
      if (tx.vin.length > 1 && tx.vout.length > 1) multiInOut++;
    }
    for (const list of ref.history.values()) netZero += list.filter((r) => r.value === 0 && r.pos > 0).length;
    const types = new Set(gen.addresses.filter((s) => ref.history.has(s.toString('hex'))).map((s) => (s[0] === 0x41 ? 'p2pk-uncompressed' : s.length === 35 ? 'p2pk' : s.length === 25 ? 'p2pkh' : s.length === 23 ? 'p2sh' : s[0] === 0x51 && s[1] === 0x20 ? 'p2tr' : s.length === 22 ? 'p2wpkh' : s.length === 34 ? 'p2wsh' : 'multisig')));
    assert.ok(sameBlockSpends > 100, `transactions spending coins made in their own block (${sameBlockSpends})`);
    assert.ok(multiInOut > 200, `multi-input multi-output transactions (${multiInOut})`);
    assert.ok(netZero > 0, `a transaction paying a script exactly what it spent from it (${netZero})`);
    assert.equal(types.size, TYPES.length + 1, `every script type in use (${[...types]})`);
    assert.ok(base.addresses > 300, `many addresses (${base.addresses})`);

    // --- the live follower: catch up in steps, folding into layers and merging them -------------
    const opts = { rpc: node.rpc, confirmations: 6, foldBlocks: 10, maxLayers: 2, maxBlocksPerPoll: 1000 };
    let live = new LiveIndex(out, opts);
    for (const tip of [BASE_TIP + 20, BASE_TIP + 40, BASE_TIP + 60]) {
      gen.extendTo(tip);
      node.blocks = gen.blocks.slice();
      await live.poll();
      assert.equal(live.lastError, null, live.lastError);
      assert.equal(live.store.tip, tip);
    }
    const s = live.status();
    assert.ok(s.layers >= 1 && s.layers <= 2 && s.tailBlocks > 0 && s.sortedTip > BASE_TIP, `base, layers and a tail all in play (${JSON.stringify(s)})`);
    const followed = compareAll(live.store, ReferenceIndex.over(node.blocks.map((b) => b.body)), 'followed');

    // --- a reorganisation inside the tail: repaired ------------------------------------------
    const forkAt = s.sortedTip + 2;
    const fork = replayTo(gen, forkAt - 1, 31);
    fork.extendTo(BASE_TIP + 63);
    assert.notEqual(fork.blocks[forkAt].hash, gen.blocks[forkAt].hash, 'the fork replaces blocks');
    node.blocks = fork.blocks.slice();
    await live.poll();
    assert.equal(live.lastError, null, live.lastError);
    assert.equal(live.status().stale, null, 'a reorganisation inside the tail is not stale');
    assert.equal(live.store.tip, BASE_TIP + 63);
    const refFork = ReferenceIndex.over(node.blocks.map((b) => b.body));
    const reorged = compareAll(live.store, refFork, 'after a reorg in the tail');
    live = new LiveIndex(out, opts);
    compareAll(live.store, refFork, 'after a reorg and a restart');

    // --- a reorganisation below what is folded: refused, as designed -----------------------------
    const deep = replayTo(gen, live.store.sortedTip - 5, 99);
    deep.extendTo(BASE_TIP + 66);
    node.blocks = deep.blocks.slice();
    await live.poll();
    assert.match(live.status().stale ?? '', /rebuild/, 'a reorganisation into a folded layer asks for a rebuild');
    assert.equal(live.store.tip, BASE_TIP + 63, 'and the index does not move');
    await live.poll();
    assert.equal(live.store.tip, BASE_TIP + 63, 'nor on the next poll');

    const ms = performance.now() - t0;
    console.log(`# synthetic chain: ${BASE_TIP + 1} base blocks + 63 followed, ${txs} base txs, ${base.addresses} addresses, ${base.rows} base history rows, max ${base.maxRows} per address; followed ${followed.addresses} addresses / max ${followed.maxRows}; after reorg ${reorged.addresses} / max ${reorged.maxRows}; ${ms.toFixed(0)} ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A generator whose chain is `from`'s up to `height`, with the coin pool as it stood there, continuing
// with a different future. Replays the same seed to that height -- the generator is deterministic.
function replayTo(from, height, salt) {
  if (from.salt) throw new Error('replayTo: fork from the original chain only');
  const g = new ChainGen(from.seed);
  g.extendTo(height);
  return ChainGen.resume(g, g.snapshot(), salt);
}
