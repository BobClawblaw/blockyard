// THE BOARD'S SHAPE ... These tests pin the packer side of that contract: whatever aspect the
// panel asks for, the shape reaches the grid as width x height, the area law holds, and the
// layout packs flush exactly as the square one always has.
import test from 'node:test';
import assert from 'node:assert/strict';

import { packExact, packExactStable, packBlock, vbytesPerUnit } from '../public/js/blockpack.js';

const pool = () => {
  const txs = [];
  for (let i = 0; i < 400; i++) {
    const vbytes = 66 + Math.round(600 * Math.pow(1 - i / 400, 2));
    txs.push({ txid: `t${String(i).padStart(4, '0')}`, vsize: vbytes, rate: 8.5 + 51.5 * (1 - i / 400) });
  }
  return txs;
};
const tail = { vbytes: 800000, rateAt: (f) => 0.5 + f };

// every aspect the shape solver can produce, hoisted flat (doc-counts cannot see an indented
// test() declaration): the square, the wide landscape shapes, and a deep portrait clamp
const SHAPE_CASES = [
  ['the square 44x44', 44, 44],
  ['wide landscape 65x30 (1920x1080)', 65, 30],
  ['landscape 54x36', 54, 36],
  ['deep 50x39', 50, 39],
];
for (const [name, w, h] of SHAPE_CASES) {
test(`packExact packs flush inside ${name}`, () => {
    assert.ok(Math.abs(w * h - 44 * 44) / (44 * 44) < 0.05, 'rect keeps the square area');
    const p = packExact(pool(), tail, { resolution: w, boardH: h });
    assert.equal(p.gridWidth, w);
    assert.equal(p.gridHeight, h);
    const grid = new Uint8Array(w * h);
    for (const t of p.tiles) {
      assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.s <= w && t.y + t.s <= h, `tile ${t.txid} outside ${w}x${h}`);
      for (let y = t.y; y < t.y + t.s; y++) for (let x = t.x; x < t.x + t.s; x++) assert.equal(grid[y * w + x], 0, 'overlap');
    }
  });
}

// THE KEPT LAYOUT CARRIES THE SHAPE TOO: a rect prev re-packs rect or returns null -- never a
// square layout at rect widths with rect rows assumed.
test('packExactStable keeps a rect board rect', () => {
  const first = packExact(pool(), tail, { resolution: 54, boardH: 36 });
  const again = packExactStable(first, pool(), tail, { resolution: 54, boardH: 36 });
  assert.ok(again, 'the stable pack should keep a fresh, matching layout');
  assert.equal(again.gridWidth, 54);
  assert.equal(again.gridHeight, 36);
  for (const t of again.tiles) assert.ok(t.y + t.s <= 36, 'kept tile below the rect top');
  // a shape change is a new board: the rect prev must not survive a square request
  const square = packExactStable(first, pool(), tail, { resolution: 44 });
  if (square) assert.equal(square.gridWidth, 44);
});

// the Detailed board's packer takes the shape as well
test('packBlock dithered honours the rect grid', () => {
  const p = packBlock(pool().map((t) => ({ ...t })), { resolution: 54, boardH: 36, blockLimit: 1000000, dither: true });
  assert.equal(p.gridWidth, 54);
  for (const t of p.tiles) assert.ok(t.x + t.s <= 54, 'inside the width');
});
