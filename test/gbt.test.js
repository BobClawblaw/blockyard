// THE BLOCK BEING BUILT, ASSEMBLED HERE INSTEAD OF ASKED FOR.
//
// (operator, 2026-09-13, on how mempool.space gets this out of a base Core install: "do it".)
//
// The next-block card used to come from `getblocktemplate`, which costs the operator's node
// 1.3-1.5 s of its single RPC thread and 1.79 MB per call. Core publishes everything needed to
// assemble it ourselves in the `getrawmempool(true)` reply the monitor ALREADY reads for the
// mempool view -- including `depends`, the ancestor sizes and fees, and `fees.chunk` over
// `chunkweight`, which is the node's own cluster-mempool linearization.
//
// MEASURED before this was written (2026-09-13, Umbrel/Core, a back-to-back template and mempool
// pair at height 966821, so the two describe the same pool):
//
//                    transactions      weight        fees
//   ours                    6,546   3,995,859   643,076 sat
//   the node's template     6,535   3,991,951   642,860 sat
//
// 0.03% apart on fees, and the set difference is churn at the 0.30 sat/vB margin where ties are
// arbitrary (178 in theirs not ours, 189 in ours not theirs). That is the claim these tests hold
// to: not "identical to Core", which it cannot be -- sigop limits and policy the mempool does not
// publish are not modelled -- but a faithful reconstruction that gets the fee total, the ordering
// and the package graph right.
//
// THE FIXTURE is a real Core mempool, cut to 637 entries with the big CPFP clusters kept whole
// (325 entries have parents). It is deliberately UNDER one block's weight, so the tests that need
// overflow pass a reduced `weightLimit` rather than the repo carrying a megabyte of JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { templateFromMempool, subsidyAt, orderingRate, LOCAL_TEMPLATE_NOTE } from '../server/collect/gbt.js';
import { summarizeTemplate, packagesFromTemplate, templateCells, blockEconomy } from '../server/collect/nextblock.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'mempool-core.json'), 'utf8'));

test('the fixture is real Core mempool data with real packages in it', () => {
  const n = Object.keys(POOL).length;
  assert.ok(n > 500, `${n} entries`);
  const withParents = Object.values(POOL).filter((e) => e.depends?.length).length;
  assert.ok(withParents > 200, `${withParents} entries have parents -- CPFP must actually be exercised`);
  const e = Object.values(POOL)[0];
  assert.ok(Number.isFinite(e.weight) && Number.isFinite(e.fees.base), 'weight and a BTC fee');
});

test('a parent is never selected after its child', () => {
  // THE ORDERING INVARIANT. A template listing a child above its parent is not a block anyone
  // could mine, and `depends` are indices into this same array -- a forward reference is both.
  const t = templateFromMempool(POOL, { height: 966821 });
  t.transactions.forEach((tx, i) => {
    for (const d of tx.depends) {
      assert.ok(Number.isInteger(d), `depends must be indices, got ${typeof d}`);
      assert.ok(d < i, `transaction ${i} depends on ${d}, which comes after it`);
    }
  });
});

test('THE REMAP: depends arrive as txids and must leave as indices', () => {
  // The failure this test exists for is SILENT. getrawmempool gives `depends` as txid strings;
  // getblocktemplate gives them as array indices, and packagesFromTemplate walks them as indices
  // behind `Number.isInteger(d)`. Pass the strings through and every test in that walk fails, so
  // every transaction reports as a singleton: no packages, no CPFP, no error -- a wrong answer
  // that looks like a quiet mempool.
  const t = templateFromMempool(POOL, { height: 966821 });
  const withDeps = t.transactions.filter((x) => x.depends.length);
  assert.ok(withDeps.length > 50, `${withDeps.length} selected transactions have in-block parents`);
  assert.ok(t.transactions.every((x) => x.depends.every((d) => Number.isInteger(d))), 'all indices');

  const packages = packagesFromTemplate(t.transactions);
  // (the committed fixture keeps a dozen whole clusters; the live pool this was measured against
  // had 352. What matters is that packages FORM at all, which the control below pins.)
  assert.ok(packages.multiTx >= 10, `${packages.multiTx} multi-transaction packages`);
  assert.ok(packages.largest > 2, `largest package ${packages.largest}`);

  // THE NEGATIVE CONTROL: the same analysis on txid-shaped depends collapses to all-singletons.
  // If this ever stops collapsing, the assertion above has stopped discriminating.
  const asTxids = t.transactions.map((x, i) => ({ ...x, depends: x.depends.map((d) => t.transactions[d].txid) }));
  const broken = packagesFromTemplate(asTxids);
  assert.equal(broken.multiTx, 0, 'txid depends must produce no packages -- proving the remap is what earns the packages above');
  assert.equal(broken.largest, 1);
});

test('fees convert from BTC to satoshis exactly once', () => {
  // A factor of 1e8 in a feerate is not a subtle graph. One entry, hand-checked.
  const [txid, e] = Object.entries(POOL).find(([, v]) => !v.depends?.length);
  const one = templateFromMempool({ [txid]: e }, { height: 966821 });
  assert.equal(one.transactions.length, 1);
  assert.equal(one.transactions[0].fee, Math.round(e.fees.base * 1e8));
  assert.equal(one.feesSat, Math.round(e.fees.base * 1e8));
  assert.ok(one.transactions[0].fee < 1e7, 'a mempool fee in sat, not a BTC number multiplied twice');
});

test('the weight budget is respected, and the coinbase gets its room', () => {
  // A template that fills all 4,000,000 describes a block that could not be mined: Core reserves
  // 4,000 weight for the coinbase transaction.
  const limit = 1_200_000, reserve = 4_000;
  const t = templateFromMempool(POOL, { height: 966821, weightLimit: limit, reserveWeight: reserve });
  assert.ok(t.weightUsed <= limit - reserve, `${t.weightUsed} must fit in ${limit - reserve}`);
  assert.ok(t.weightUsed > (limit - reserve) * 0.9, `and should nearly fill it: ${t.weightUsed}`);
  assert.equal(t.transactions.reduce((n, x) => n + x.weight, 0), t.weightUsed, 'the reported weight is the weight of what was selected');
  assert.ok(t.selected < Object.keys(POOL).length, 'with a reduced limit, something must be left out');
});

test('a package is taken whole or not at all', () => {
  // A child in the block without its parent is the bug that a naive feerate sort produces. Every
  // selected transaction's parents must also be selected.
  const t = templateFromMempool(POOL, { height: 966821, weightLimit: 900_000 });
  const chosen = new Set(t.transactions.map((x) => x.txid));
  for (const tx of t.transactions) {
    for (const p of POOL[tx.txid].depends ?? []) {
      assert.ok(chosen.has(p), `${tx.txid} is in the block but its parent ${p} is not`);
    }
  }
});

test('a child whose parent has left the mempool is not selectable', () => {
  // Between the node building the reply and us reading it a parent can be mined or evicted. The
  // child is then unselectable this round -- not selectable with a missing parent.
  const [childId] = Object.entries(POOL).find(([, v]) => v.depends?.length);
  const parentId = POOL[childId].depends[0];
  const holed = { ...POOL };
  delete holed[parentId];
  const t = templateFromMempool(holed, { height: 966821 });
  const chosen = new Set(t.transactions.map((x) => x.txid));
  assert.equal(chosen.has(parentId), false, 'the parent is genuinely gone');
  assert.equal(chosen.has(childId), false, 'so the child cannot be in the block either');
});

test('ordering prefers the node\'s own chunk feerate, then ancestor, then its own', () => {
  // Core's cluster mempool has already decided what travels together and in what order.
  // fees are BTC in, sat/vB out.
  assert.equal(orderingRate({ chunkweight: 400, fees: { chunk: 0.00001, base: 0.00001 }, vsize: 100 }), 1000 / 100);
  assert.equal(orderingRate({ ancestorsize: 200, fees: { ancestor: 0.000002, base: 0.000002 }, vsize: 100 }), 200 / 200);
  assert.equal(orderingRate({ vsize: 100, fees: { base: 0.000001 } }), 100 / 100);
  assert.equal(orderingRate({}), 0, 'nothing to go on is not a crash');
  assert.equal(orderingRate(null), 0);
});

test('the subsidy halves on schedule', () => {
  assert.equal(subsidyAt(0), 50 * 1e8);
  assert.equal(subsidyAt(209_999), 50 * 1e8);
  assert.equal(subsidyAt(210_000), 25 * 1e8, 'the first halving');
  assert.equal(subsidyAt(966_821), 312_500_000, 'the height this was measured at: 3.125 BTC');
  assert.equal(subsidyAt(210_000 * 33), 0, 'past the last satoshi');
  assert.equal(subsidyAt(null), null, 'an unknown height has no subsidy, rather than a wrong one');
});

test('the existing consumers read it unchanged -- that is the whole point of the shape', () => {
  // summarizeTemplate, templateCells, packagesFromTemplate and blockEconomy were written against
  // a getblocktemplate reply. If any of them needed changing, the seam would be in the wrong place.
  const t = templateFromMempool(POOL, { height: 966821, previousblockhash: 'ab'.repeat(32) });
  const s = summarizeTemplate(t);
  assert.equal(s.height, 966821);
  assert.equal(s.previous, 'ab'.repeat(32));
  assert.equal(s.txCount, t.transactions.length);
  assert.ok(s.feeRate.median > 0, 'a median feerate comes out');
  assert.ok(s.feeRateHistogram.some((b) => b.n > 0), 'and the histogram has weight in it');
  assert.equal(s.coinbaseSat, t.coinbasevalue, 'coinbase = subsidy + fees');
  assert.equal(s.coinbaseSat, subsidyAt(966821) + t.feesSat);

  const cells = templateCells(t.transactions);
  assert.ok(cells.cells.length > 0 && cells.cells.length <= 401, 'bounded cells for the viewer');

  const econ = blockEconomy({ template: s, mempool: { bytes: 40_000_000 } });
  assert.ok(econ.remainingWeight >= 0);
  assert.ok(econ.backlogBlocks > 0, 'and the queue depth still computes');
});

test('it says where it came from, and what that costs', () => {
  const t = templateFromMempool(POOL, { height: 966821 });
  assert.equal(t.assembledLocally, true);
  assert.equal(t.source, 'getrawmempool');
  assert.equal(t.poolSize, Object.keys(POOL).length, 'it reports the pool it was handed');
  assert.ok(t.poolSize >= t.selected, 'and never claims to have selected more than exists');
  // where the pool genuinely overflows a block, the two must differ
  const tight = templateFromMempool(POOL, { height: 966821, weightLimit: 900_000 });
  assert.ok(tight.poolSize > tight.selected, 'a pool bigger than the block leaves transactions out');
  assert.match(LOCAL_TEMPLATE_NOTE, /getrawmempool/, 'the note names the source');
  assert.match(LOCAL_TEMPLATE_NOTE, /no extra call/, 'and says it costs the node nothing further');
  assert.match(LOCAL_TEMPLATE_NOTE, /reconstruction|can differ/, 'and does not claim to BE the node\'s template');
});

test('rubbish in is an empty block, not a crash', () => {
  for (const bad of [null, undefined, [], 'nope', 42, { a: null }, { b: { weight: 0 } }, { c: { weight: -5 } }]) {
    const t = templateFromMempool(bad, { height: 1 });
    assert.equal(t.transactions.length, 0, `${JSON.stringify(bad)} selects nothing`);
    assert.equal(t.feesSat, 0);
    assert.equal(t.coinbasevalue, subsidyAt(1), 'an empty block still pays the subsidy');
  }
});

test('assembling a full mempool is fast enough to do inline', () => {
  // 25,000 entries assembled in 52 ms when this was written. The point of the change is that the
  // node pays nothing; if WE paid seconds instead, the cost would just have moved.
  const t0 = performance.now();
  templateFromMempool(POOL, { height: 966821 });
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `${ms.toFixed(0)} ms for ${Object.keys(POOL).length} entries`);
});
