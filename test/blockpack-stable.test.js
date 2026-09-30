// THE STABLE EXACT FILL (public/js/blockpack.js packExactStable; 2026-09-30). The pool now reaches the
// Simple board every few seconds, and a fresh pack re-lays nearly every square (measured on bmc's live
// pool: 126-348 of 599 tiles moved per 5 s update, against 0 kept in place by this). Held here: what
// stays, where the new ones go, that the board is still full to the last cell, and when it packs fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packExact, packExactStable, STABLE_DRIFT, STABLE_KEEP } from '../public/js/blockpack.js';

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pool = (n, tag = 't') => Array.from({ length: n }, (_, i) => ({ txid: `${tag}-${i}-`.padEnd(64, 'x'), vsize: Math.round(140 + rnd() ** 4 * 30000), rate: 80 - i * 0.1 }));
const tail = { vbytes: 400000, rateAt: (f) => 3 - 2 * f };
const OPTS = { resolution: 44, cap: 3 };
const named = (p) => { for (const t of p.tiles) if (String(t.txid).startsWith('aggregate-')) t.txid = `aggregate@${t.x},${t.y}`; return p; };
const full = (p) => {
  const grid = new Uint8Array(44 * 44);
  for (const t of p.tiles) for (let y = t.y; y < t.y + t.s; y++) for (let x = t.x; x < t.x + t.s; x++) { assert.equal(grid[y * 44 + x], 0, `overlap at ${x},${y}`); grid[y * 44 + x] = 1; }
  return grid.every((c) => c === 1);
};

test('the same pool again: every square where it was', () => {
  const plain = pool(300);
  const a = named(packExact(plain, tail, OPTS));
  const b = packExactStable(a, plain, tail, OPTS);
  assert.ok(b?.stable);
  assert.equal(b.moved, 0);
  const at = new Map(a.tiles.map((t) => [t.txid, `${t.x},${t.y},${t.s}`]));
  for (const t of b.tiles) if (!t.txid.startsWith('aggregate')) assert.equal(`${t.x},${t.y},${t.s}`, at.get(t.txid));
  assert.ok(full(b), 'full to the last cell');
});

test('a few leave and a few arrive: the rest stay put, the new ones fill in, the board stays flush', () => {
  const plain = pool(300);
  const a = named(packExact(plain, tail, OPTS));
  const next = plain.filter((_, i) => i % 40 !== 7).concat(pool(6, 'n'));
  const b = packExactStable(a, next, tail, OPTS);
  assert.ok(b?.stable, 'kept');
  assert.equal(b.moved, 6, 'only the arrivals were placed');
  const at = new Map(a.tiles.map((t) => [t.txid, `${t.x},${t.y},${t.s}`]));
  let held = 0;
  for (const t of b.tiles) if (at.get(t.txid) === `${t.x},${t.y},${t.s}`) held++;
  assert.ok(held >= next.length - 6, `every survivor held (${held})`);
  assert.ok(full(b), 'full to the last cell');
  for (const t of b.tiles) assert.ok(t.y + t.s <= 44 && t.x + t.s <= 44, 'on the board');
});

test('it packs fresh: no last layout, another grid, a drifted scale, or a found block', () => {
  const plain = pool(300);
  const a = named(packExact(plain, tail, OPTS));
  assert.equal(packExactStable(null, plain, tail, OPTS), null);
  assert.equal(packExactStable(a, plain, tail, { ...OPTS, resolution: 48 }), null, 'another board size');
  assert.equal(packExactStable(a, plain, { ...tail, vbytes: tail.vbytes * 3 }, OPTS), null, `the scale moved past ${STABLE_DRIFT * 100}%`);
  // a block took the richest half and more: under STABLE_KEEP of the vbytes survive
  const afterBlock = plain.slice(Math.ceil(plain.length * (1 - STABLE_KEEP / 2))).concat(pool(200, 'b'));
  assert.equal(packExactStable(a, afterBlock, tail, OPTS), null);
});

// ---- the Detailed board's kept layout settles (2026-09-30: "Why is it leaving holes like that in detailed view?")
import { packBlock, packStable, packDenseStable, settleDown, gapShare, DENSE_GAP_MAX, vbytesPerUnit } from '../public/js/blockpack.js';

test('settleDown: a square drops straight down into the gap under it, and a settled board stays put', () => {
  const tiles = [{ txid: 'a', x: 0, y: 0, s: 2 }, { txid: 'b', x: 0, y: 5, s: 1 }, { txid: 'c', x: 1, y: 4, s: 3 }];
  const { tiles: out, moved } = settleDown(tiles, { width: 8, height: 8 });
  const at = Object.fromEntries(out.map((t) => [t.txid, t.y]));
  assert.equal(at.a, 0);
  assert.equal(at.b, 2, 'b falls onto a');
  assert.equal(at.c, 2, 'c falls onto a (its left column), not through it');
  assert.equal(moved, 2);
  assert.ok(out.every((t, i) => t.x === tiles[i].x && t.s === tiles[i].s), 'only y changes');
  assert.equal(settleDown(out, { width: 8, height: 8 }).moved, 0, 'settled is settled');
  // (c rests on a's right column, so the cells under c's other two columns stay empty: settling closes
  // what a square can fall into, not every gap)
  assert.ok(gapShare(out, { width: 8, height: 8 }) < gapShare(tiles, { width: 8, height: 8 }), 'fewer gaps than before');
});

test('packDenseStable: the same pool twice moves nothing; under churn the gaps stay under DENSE_GAP_MAX', () => {
  let r = 29;
  const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const mkTx = (tag, i) => ({ txid: `${tag}-${i}`.padEnd(64, 'x'), vsize: Math.round(120 + rnd() ** 3 * 1500), fee: 0 });
  const cfg = { resolution: 96, blockLimit: 1e6, dither: true };
  const vpu = vbytesPerUnit(cfg.blockLimit, cfg.resolution);
  // (about a block's worth, as the Detailed list is: 1,900 x ~495 vB)
  let pool = Array.from({ length: 1900 }, (_, i) => ({ ...mkTx('p', i), fee: (60 - i * 0.02) * 400 }));
  let tiles = packBlock(pool, cfg).tiles;
  const again = packDenseStable(tiles, pool, cfg);
  const pos = new Map(tiles.map((t) => [t.txid, `${t.x},${t.y}`]));
  // (the first pass may settle a fresh pack's own gaps; after that the same data is still)
  const twice = packDenseStable(again.tiles, pool, cfg);
  const pos2 = new Map(again.tiles.map((t) => [t.txid, `${t.x},${t.y}`]));
  assert.equal(twice.tiles.filter((t) => pos2.get(t.txid) !== `${t.x},${t.y}`).length, 0, 'idempotent');
  assert.ok(pos.size > 0 && vpu > 0);
  let worst = 0, fresh = 0;
  for (let k = 0; k < 40; k++) {
    // the cheapest leave out of the top, richer ones arrive
    pool = pool.slice(0, pool.length - 25).concat(Array.from({ length: 25 }, (_, i) => ({ ...mkTx(`n${k}`, i), fee: (40 + rnd() * 20) * 400 })));
    const next = packDenseStable(tiles, pool, cfg);
    if (!next) { fresh++; tiles = packBlock(pool, cfg).tiles; continue; }
    tiles = next.tiles;
    worst = Math.max(worst, gapShare(tiles, { width: 96, height: 96 }));
  }
  assert.ok(worst <= DENSE_GAP_MAX, `worst interior gaps ${(worst * 100).toFixed(2)}%`);
  assert.ok(fresh < 40, 'and it is not simply packing fresh every time');
});
