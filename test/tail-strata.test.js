// THE TAIL IN COLOUR (operator, 2026-09-11: "why can't we do 128 colors in simple mode as well?").
// The aggregate cell carried 96% of the Simple board under one mean feerate; it now carries strata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMempool } from '../server/collect/monitor.js';
import { toTxs } from '../public/js/details3d.js';
import { vbytesPerUnit } from '../public/js/blockpack.js';
import { feeColor } from '../public/js/feepalette.js';

function pool() {
  const raw = {};
  for (let i = 0; i < 400; i++) raw[`r${i}`.padEnd(64, 'a')] = { vsize: 200, fees: { base: 200 * (5 + i) * 1e-8 } };
  // the tail: 20,000 small transactions from 0.1 to 4 sat/vB
  for (let i = 0; i < 20000; i++) raw[`t${i}`.padEnd(64, 'b')] = { vsize: 140, fees: { base: 140 * 0.1 * 40 ** (i / 20000) * 1e-8 } };
  return raw;
}

test('the tail cell carries its make-up: feerate strata, richest first, summing to the cell', () => {
  const d = summarizeMempool(pool());
  assert.equal(d.cells.filter((c) => c.aggregate > 1).length, 1, 'still ONE aggregate cell');
  const tail = d.cells.at(-1);
  assert.ok(tail.aggregate > 19000, String(tail.aggregate));
  assert.ok(Array.isArray(tail.strata) && tail.strata.length >= 16 && tail.strata.length <= 32, `${tail.strata?.length} strata`);
  assert.equal(tail.strata.reduce((a, s) => a + s.vbytes, 0), tail.vbytes);
  assert.equal(tail.strata.reduce((a, s) => a + s.n, 0), tail.aggregate);
  for (let i = 1; i < tail.strata.length; i++) assert.ok(tail.strata[i].rate <= tail.strata[i - 1].rate, 'richest first');
  const mean = tail.strata.reduce((a, s) => a + s.rate * s.vbytes, 0) / tail.vbytes;
  assert.ok(Math.abs(mean - tail.rate) < 0.02, `the strata average to the cell's rate (${mean.toFixed(3)} vs ${tail.rate})`);
});

test('Simple paints the tail by stratum: the same pieces at the same sizes, in many colours', () => {
  const d = summarizeMempool(pool());
  const vpu = vbytesPerUnit(3_000_000, 80);
  const coloured = toTxs(d.cells, vpu);
  const plain = toTxs(d.cells.map((c) => ({ ...c, strata: undefined })), vpu);
  assert.equal(coloured.length, plain.length, 'the same number of pieces');
  coloured.forEach((t, i) => { assert.equal(t.txid, plain[i].txid); assert.equal(t.vsize, plain[i].vsize); });
  const piecesOf = (list) => list.filter((t) => String(t.txid).startsWith('aggregate-'));
  const colours = (list) => new Set(piecesOf(list).map((t) => feeColor(t.fee / t.vsize))).size;
  assert.equal(colours(plain), 1, 'one mean feerate: one colour');
  assert.ok(colours(coloured) >= 12, `with strata: ${colours(coloured)} colours`);
  const rates = piecesOf(coloured).map((t) => t.fee / t.vsize);
  for (let i = 1; i < rates.length; i++) assert.ok(rates[i] <= rates[i - 1] + 1e-9, 'richest first, continuing the individual cells');
});
