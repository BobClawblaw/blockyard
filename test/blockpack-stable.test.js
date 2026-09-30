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
