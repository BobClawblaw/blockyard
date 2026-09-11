// The stable packing: a refresh moves only what the pool changed, and where it
// cannot, only the cheap top of the board.
//
// Operator, 2026-09-11: "There is way too much shit overlapping in 3D space."
// Measured on a realistic refresh, a fresh first-fit pack moved 213 of 274
// blocks -- one new transaction low in the order shifts every block placed
// after it -- and ~100 of them crossed paths in every frame of travel. Most of
// that motion was the packer's, not the pool's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packBlock, packStable } from '../public/js/blockpack.js';

function pool(seed, n, tag = 't') {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, (_, i) => {
    const vsize = Math.floor(200 + rnd() * 6000);
    return { txid: tag + i, vsize, fee: vsize * (1 + rnd() * 80) };
  });
}
const byRate = (x) => [...x].sort((a, b) => b.fee / b.vsize - a.fee / a.vsize);
const oneBlock = (x, limit = 1000000) => { const out = []; let used = 0; for (const t of byRate(x)) { if (used + t.vsize > limit) break; out.push(t); used += t.vsize; } return out; };
const CFG = { resolution: 40, blockLimit: 1000000 };
const noOverlap = (tiles) => {
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
    const a = tiles[i], b = tiles[j];
    assert.ok(!(a.x < b.x + b.s && b.x < a.x + a.s && a.y < b.y + b.s && b.y < a.y + a.s), `${a.txid} and ${b.txid} overlap`);
  }
};
const movedIn = (prev, next) => {
  const was = new Map(prev.map((t) => [t.txid, t]));
  return next.filter((t) => was.has(t.txid) && (was.get(t.txid).x !== t.x || was.get(t.txid).y !== t.y));
};

test('a light refresh keeps every survivor exactly where it was', () => {
  const before = byRate(pool(3, 120));
  const a = packBlock(before, CFG).tiles.filter((t) => t.y + t.s <= CFG.resolution);
  const onBoard = before.filter((tx) => a.some((t) => t.txid === tx.txid));
  const after = byRate(onBoard.filter((_, i) => i % 7 !== 0));                  // a few leave, nobody arrives
  const r = packStable(a, after, CFG);
  assert.ok(r, 'packs stably');
  assert.equal(movedIn(a, r.tiles).length, 0, 'nothing moves when nothing needs to');
  assert.equal(r.waiting, 0);
  noOverlap(r.tiles);
});

test('a realistic refresh moves only the top of the board, far less than a fresh pack', () => {
  // 90% of a block: the renderer first scales a block until a FRESH pack fits
  // the grid (square sides round up, so a full block overflows at scale 1) and
  // only then packs the next refresh stably at that scale. A full block here
  // would overflow even fresh, and no stable packing could be asked to beat that.
  const LIMIT = 900000;
  const base = pool(4, 400);
  const a = packBlock(oneBlock(base, LIMIT), CFG).tiles.filter((t) => t.y + t.s <= CFG.resolution);
  const next = oneBlock([...base.filter((_, i) => i % 4 !== 0), ...pool(11, 70, 'n')], LIMIT);
  const r = packStable(a, next, CFG);
  assert.ok(r, 'packs stably');
  noOverlap(r.tiles);
  assert.ok(r.tiles.every((t) => t.y + t.s <= CFG.resolution && t.x + t.s <= CFG.resolution), 'all inside the grid');
  const total = next.reduce((n, tx) => n + tx.vsize, 0);
  assert.ok(r.waiting <= total * 0.03 + 1e-9, `at most 3% of the block waits off the board (${(100 * r.waiting / total).toFixed(1)}%)`);
  // everything that survived and lies wholly below the line did not move
  const was = new Map(a.map((t) => [t.txid, t]));
  for (const t of r.tiles) {
    const w = was.get(t.txid);
    if (w && w.s === t.s && w.y + w.s <= r.keptBelow) assert.ok(w.x === t.x && w.y === t.y, `${t.txid} below the line stays put`);
  }
  const fresh = packBlock(next, CFG).tiles.filter((t) => t.y + t.s <= CFG.resolution);
  const nStable = movedIn(a, r.tiles).length, nFresh = movedIn(a, fresh).length;
  assert.ok(nStable < nFresh * 0.6, `stable moved ${nStable}, a fresh pack would move ${nFresh}`);
});

test('aggregate pieces reclaim their old slots; heavy turnover packs afresh', () => {
  const agg = Array.from({ length: 20 }, (_, i) => ({ txid: `aggregate-${i}`, vsize: 2000, fee: 2000 }));
  const a = packBlock(agg, CFG).tiles.map((t) => ({ ...t, txid: `aggregate@${t.x},${t.y}` }));
  const r = packStable(a, agg, CFG);
  const slots = new Set(a.map((t) => `${t.x},${t.y}`));
  assert.ok(r && r.tiles.every((t) => slots.has(`${t.x},${t.y}`)), 'every piece lands in a previous aggregate slot');

  const before = pool(5, 80);
  const pa = packBlock(before, CFG).tiles;
  assert.equal(packStable(pa, pool(6, 80, 'z'), CFG), null, 'an entirely new pool (a block was mined) is packed afresh');
  assert.equal(packStable([], before, CFG), null, 'and so is a first paint');
});
