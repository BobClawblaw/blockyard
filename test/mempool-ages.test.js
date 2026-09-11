// A mempool entry time of 0 is not a timestamp.
//
// Measured 2026-09-11 on deploy-20260910ag: 94 of 19,014 getrawmempool entries
// carried `time: 0`. Read as a unix time, each was ~20,707 days old (since
// 1970); they stretched the Mempool page's fee-vs-age axis to 56 years and
// crushed every real transaction into one vertical line at its left edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMempool } from '../server/collect/monitor.js';

test('entries with time = 0 are an UNKNOWN age: counted, and kept out of every age figure', () => {
  const now = Math.floor(Date.now() / 1000);
  const raw = {};
  for (let i = 0; i < 50; i++) raw['a' + i] = { vsize: 200, weight: 800, time: now - 60 * (i + 1), fees: { base: 0.00001 } };
  for (let i = 0; i < 3; i++) raw['z' + i] = { vsize: 200, weight: 800, time: 0, fees: { base: 0.00001 } };
  const d = summarizeMempool(raw);
  assert.equal(d.count, 53, 'every entry is still counted');
  assert.equal(d.ageUnknown, 3, 'the three with no entry time are counted as unknown');
  assert.ok(d.oldestSec <= 50 * 60 + 5, `the oldest known age is ~50 minutes, not decades (got ${d.oldestSec} s)`);
  assert.ok(d.scatter.every(([age]) => age <= 50 * 60 + 5), 'no scatter point claims an ancient age');
  assert.equal(d.scatter.length, 50, 'and the unknown ones are not plotted at all');
});
