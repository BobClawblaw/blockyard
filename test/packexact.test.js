// THE EXACT FILL (operator, 2026-09-12: "Simple viewer mode is what I use as default. It needs
// to be fucking perfect"). The board fills to the last cell with a flush top, and the tail stays a
// field of small pieces rather than a few slabs pretending to be huge transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packExact } from '../public/js/blockpack.js';

let seed = 5;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const pool = (n, big) => Array.from({ length: n }, (_, i) => ({ txid: 'x' + i, vsize: Math.round(120 + rnd() * (big ? 3000 : 700)), rate: 20 - i * 0.04 }));

function occupancy(p) {
  const RES = p.gridWidth, grid = new Uint8Array(RES * RES);
  let doubles = 0;
  for (const t of p.tiles) for (let y = t.y; y < t.y + t.s; y++) for (let x = t.x; x < t.x + t.s; x++) {
    if (x < 0 || x >= RES || y < 0 || y >= RES) throw new Error(`tile outside the grid: ${JSON.stringify(t)}`);
    if (grid[y * RES + x]) doubles++;
    grid[y * RES + x] = 1;
  }
  let filled = 0; for (const v of grid) if (v) filled++;
  let top = 0; for (let x = 0; x < RES; x++) if (grid[(RES - 1) * RES + x]) top++;
  return { filled, total: RES * RES, top, doubles };
}

test('the board fills to the last cell with a flush top, on very different pools', () => {
  const cases = [
    ['small tail', pool(400, false), { vbytes: 600_000, rate: 0.3 }],
    ['huge tail', pool(400, false), { vbytes: 5_000_000, rate: 0.3 }],
    ['big transactions', pool(400, true), { vbytes: 2_000_000, rate: 0.3 }],
    ['almost no tail', pool(400, false), { vbytes: 40_000, rate: 0.3 }],
  ];
  for (const [name, plain, tail] of cases) {
    for (const RES of [44, 48]) {
      const p = packExact(plain, tail, { resolution: RES, cap: 3 });
      const o = occupancy(p);
      assert.equal(o.filled, o.total, `${name} @${RES}: every cell is used (${o.filled}/${o.total})`);
      assert.equal(o.top, RES, `${name} @${RES}: the top row is full across`);
      assert.equal(o.doubles, 0, `${name} @${RES}: nothing overlaps`);
    }
  }
});

test('the tail is a field of small pieces, never a slab, and its vbytes are conserved', () => {
  const plain = pool(400, false);
  const tail = { vbytes: 923_056, rate: 0.25 };
  const p = packExact(plain, tail, { resolution: 44, cap: 3 });
  const pieces = p.tiles.filter((t) => t.txid.startsWith('aggregate-'));
  assert.ok(pieces.length > 100, `many pieces (${pieces.length})`);
  assert.ok(pieces.every((t) => t.s <= 3), 'no tail piece wider than the cap');
  const share = pieces.reduce((a, t) => a + t.vsize, 0);
  assert.ok(Math.abs(share - tail.vbytes) < 1, `the pieces add up to the tail (${share.toFixed(0)} of ${tail.vbytes})`);
  // a piece's vbytes follow its area: a 3x3 stands for nine times a 1x1
  const three = pieces.find((t) => t.s === 3), one = pieces.find((t) => t.s === 1);
  if (three && one) assert.ok(Math.abs(three.vsize / one.vsize - 9) < 1e-6, 'area-true');
});

test('the real transactions keep their identity, order and colour', () => {
  const plain = pool(50, true);
  const p = packExact(plain, { vbytes: 900_000, rate: 0.3 }, { resolution: 44 });
  const real = p.tiles.filter((t) => !t.txid.startsWith('aggregate-'));
  assert.equal(real.length, 50, 'every transaction is on the board -- none dropped for overflowing');
  assert.deepEqual(real.map((t) => t.txid), plain.map((c) => c.txid), 'in the order they arrived: richest first');
  assert.ok(real.every((t) => typeof t.color === 'string' && t.color.length > 3), 'coloured by feerate');
  assert.ok(real.every((t) => t.rate === plain.find((c) => c.txid === t.txid).rate), 'each carrying its own rate');
});

test('the tail is coloured richest-first through the strata rule it is handed', () => {
  const rates = [];
  const rateAt = (frac) => { rates.push(frac); return 10 - 9 * frac; };
  const p = packExact(pool(120, false), { vbytes: 800_000, rateAt }, { resolution: 44 });
  const pieces = p.tiles.filter((t) => t.txid.startsWith('aggregate-'));
  assert.ok(rates.every((f) => f >= 0 && f <= 1), 'shares are fractions');
  assert.ok(rates[0] < rates[rates.length - 1], 'asked in order, richest share first');
  assert.ok(pieces[0].rate > pieces[pieces.length - 1].rate, 'so the first piece is the richest');
});

test('the Simple board takes the exact fill; Detailed keeps its per-transaction pack', () => {
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /packExact\(/, 'the render path calls it');
  const at = src.indexOf('packExact(');
  const around = src.slice(Math.max(0, at - 3000), at + 400);
  assert.match(around, /aggregate/, 'chosen by the presence of a summed tail -- the Simple board');
  assert.match(around, /dither/, 'and not for the dithered per-transaction Detailed board');
});
