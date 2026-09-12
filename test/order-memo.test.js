// THE PAINT ORDER REMEMBERS (2026-09-12, operator: "Still showing block z-fighting during
// transitions"). Replayed, 18 of 19 flickers were pairs whose decision never changed, swapped
// when a bystander in flight pulled them into a tangle or let them out: inside a tangle the order
// was by depth alone. With the memo a tangle keeps the relative order its cubes had last frame.
// The replay (a 634-frame transition of 90 cubes, 785 overlapping pairs) went from 19 flickers
// to none; it is too slow for the suite, so this pins the mechanism and the wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildScene } from '../public/js/blockscene3d.js';

const O = { unit: 6, zUnit: 6, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5, gridW: 20, gridH: 20 };
const order = (ops) => { const seen = []; for (const op of ops) if (op.face !== 'shadow' && !seen.includes(op.txid)) seen.push(op.txid); return seen; };

test('the memo is filled with each cube\'s paint index, and a still board keeps its order through it', () => {
  const tiles = [
    { txid: 'a', x: 2, y: 2, s: 3, z: 0, color: '#33cc99' }, { txid: 'b', x: 5, y: 2, s: 2, z: 0, color: '#cc3333' },
    { txid: 'c', x: 3, y: 5, s: 2, z: 2.5, color: '#3333cc' }, { txid: 'd', x: 8, y: 8, s: 1, z: 0, color: '#cccc33' },
  ];
  const memo = new Map();
  const first = order(buildScene(tiles, { ...O, orderMemo: memo }).ops);
  assert.equal(memo.size, tiles.length, 'every cube has an index');
  assert.deepEqual([...memo.entries()].sort((p, q) => p[1] - q[1]).map(([id]) => id), first, 'the index is the paint order');
  const second = order(buildScene(tiles, { ...O, orderMemo: memo }).ops);
  assert.deepEqual(second, first, 'the same board, the same order');
  const bare = order(buildScene(tiles, { ...O }).ops);
  assert.deepEqual(bare, first, 'and without a memo the order is the same: the memo only settles tangles');
});

test('render3d gives each canvas one memo for the life of the board', () => {
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /orderMemo: \(st\.orderMemo \?\?= new Map\(\)\)/, 'the view carries the canvas\'s memo into buildScene');
  const scene = readFileSync(new URL('../public/js/blockscene3d.js', import.meta.url), 'utf8');
  assert.match(scene, /const memo = o\.orderMemo instanceof Map \? o\.orderMemo : null;/, 'and obliqueOrder reads it');
});
