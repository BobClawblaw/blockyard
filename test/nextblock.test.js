// The block being built right now, and the ancestor packages inside it.
// Pure functions, run against a shape frozen from a real getblocktemplate reply
// (height 966265, measured 2026-09-09: 1,496 selected transactions, 19 multi-tx packages,
// 40 transactions inside a package, one package = child 38.1 sat/vB over parent 0.5).
//
// Why the `depends` semantics matter: the entries are INDICES into the same
// `transactions` array, not txids. A cluster analysis that assumed txids finds zero
// packages in a template that has 19 -- and "no clusters on this node" is a claim about
// the node, so getting it wrong writes a false limitation into the docs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTemplate, packagesFromTemplate, TEMPLATE_NOTE } from '../server/collect/nextblock.js';

// A miniature of the real shape: 8 transactions, `depends` by index, `data` present and
// huge (it is the reason a real reply is 1.79 MB and why the monitor drops it at the door).
const TXS = [
  { txid: 'a', fee: 400, weight: 400, depends: [], data: 'ff'.repeat(4000) },                    // 4.0 sat/vB
  { txid: 'b', fee: 200, weight: 800, depends: [0], data: 'ff'.repeat(4000) },                   // 1.0 -- child of a
  { txid: 'c', fee: 3810, weight: 400, depends: [1], data: 'ff'.repeat(4000) },                  // 38.1 -- grandchild
  { txid: 'd', fee: 100, weight: 400, depends: [], data: 'ff'.repeat(4000) },                    // 1.0 lone
  { txid: 'e', fee: 9000, weight: 1000, depends: [], data: 'ff'.repeat(4000) },                  // 36.0 lone
  { txid: 'f', fee: 60, weight: 240, depends: [], data: 'ff'.repeat(4000) },                     // 1.0 lone
  { txid: 'g', fee: 5000, weight: 500, depends: [5], data: 'ff'.repeat(4000) },                  // 83.3 -- child of f
  { txid: 'h', fee: 0, weight: 0, depends: [], data: 'ff'.repeat(4000) },                        // degenerate: no rate
];
const TPL = { height: 966265, previousblockhash: 'prev', transactions: TXS, weightlimit: 4_000_000, coinbasevalue: 313322914, sigoplimit: 80000, sizelimit: 4_000_000, version: 536870912, bits: '1702355e', mintime: 1788981262, vbavailable: {}, vbrequired: 0 };

test('the next-block summary carries the numbers the card shows', () => {
  const s = summarizeTemplate(TPL);
  assert.equal(s.height, 966265);
  assert.equal(s.txCount, 8);
  assert.equal(s.weight, 3740);                                 // 400+800+400+400+1000+240+500+0
  assert.equal(s.weightPct, +(100 * 3740 / 4_000_000).toFixed(1));
  assert.equal(s.totalFeesSat, TXS.reduce((n, t) => n + t.fee, 0));
  assert.equal(s.feeRate.min, 1);
  assert.equal(s.feeRate.max, 40, 'the 5,000-sat / 500-WU tx is the best-paying here');
  assert.equal(s.coinbaseSat, 313322914);
});

test('a transaction with no weight is skipped, not divided by', () => {
  const s = summarizeTemplate(TPL);
  const counted = s.feeRateHistogram.reduce((n, b) => n + b.n, 0);
  assert.equal(counted, 7, 'the degenerate tx is absent, not counted at zero');
});

test('packages come from depends-by-index, and the child-pays-for-parent shape is named', () => {
  const p = packagesFromTemplate(TXS);
  assert.equal(p.total, 5, 'a,b,c are one package; d, e, f+g, h are the others');
  assert.equal(p.multiTx, 2);
  assert.equal(p.txsInPackages, 5);
  assert.equal(p.largest, 3);
  const big = p.top.find((x) => x.size === 3);
  assert.ok(big, 'the 3-transaction package is listed');
  assert.equal(big.feesSat, 400 + 200 + 3810);
  assert.equal(big.weight, 1600);
  assert.equal(big.packageFeeRate, +(4410 / 400).toFixed(2));
  assert.equal(big.childRate, 38.1);
  assert.equal(big.parentRate, 1);
  assert.equal(big.cpfp, true, '38.1 over 0.5-1.0 is the pattern, and it is labelled as such');
});

test('a package whose members pay alike is not called CPFP', () => {
  const flat = [
    { txid: 'x', fee: 400, weight: 400, depends: [] },
    { txid: 'y', fee: 420, weight: 400, depends: [0] },
  ];
  const p = packagesFromTemplate(flat);
  assert.equal(p.multiTx, 1);
  assert.equal(p.top[0].cpfp, false, 'similar rates are a dependency, not a subsidy');
});

test('depends pointing at txids, not indices, is not silently treated as a graph', () => {
  const byid = [{ txid: 'a', fee: 10, weight: 40, depends: [] }, { txid: 'b', fee: 10, weight: 40, depends: ['a'] }];
  const p = packagesFromTemplate(byid);
  assert.equal(p.multiTx, 0, 'no edge is invented from a value that is not an index');
  assert.equal(p.total, 2);
});

test('the cost note travels with the data', () => {
  assert.match(TEMPLATE_NOTE, /1\.3-1\.5 s|1\.3–1\.5 s/, 'the node-side cost is stated, not hidden');
  assert.match(TEMPLATE_NOTE, /single RPC thread|RPC thread/i);
});
