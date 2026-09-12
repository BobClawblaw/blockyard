// A LEANING FACE OVER A SHORTER NEIGHBOUR (operator, 2026-09-12: "Height sorting issue on bottom
// left larger blocks next to smaller blocks"). Under the radial oblique camera a tall cube's side
// face leans over the neighbour on one side -- left on the left half of the board, right on the
// right -- and that neighbour, if shorter, must be painted BEFORE the tall cube or it clips the
// face. Measured live before the fix: 6 of 33 such pairs painted the wrong way, all on the left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScene, obliqueLean } from '../public/js/blockscene3d.js';

const O = { unit: 6, zUnit: 6, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5, gridW: 44, gridH: 44, edges: true, shadows: false };
const firstOp = (scene, id) => scene.ops.findIndex((op) => op.txid === id);

test('on the left half a tall cube paints after the shorter neighbour on its LEFT', () => {
  // the exact case from the live board: a 2x2 at column 6, row 0, with 1x1s at column 5
  const tiles = [
    { txid: 'tall', x: 6, y: 0, s: 2, z: 0, tall: 2, color: '#33cc99' },
    { txid: 'left0', x: 5, y: 0, s: 1, z: 0, tall: 1, color: '#cc9933' },
    { txid: 'left1', x: 5, y: 1, s: 1, z: 0, tall: 1, color: '#cc9933' },
    { txid: 'right0', x: 8, y: 0, s: 1, z: 0, tall: 1, color: '#cc9933' },
  ];
  assert.ok(obliqueLean(7, O) < 0, 'the face leans left here');
  const sc = buildScene(tiles, O);
  assert.ok(firstOp(sc, 'left0') < firstOp(sc, 'tall'), 'the left neighbour is under the leaning face: painted first');
  assert.ok(firstOp(sc, 'left1') < firstOp(sc, 'tall'));
});

test('on the right half the same shape leans right, and the RIGHT neighbour paints first', () => {
  const tiles = [
    { txid: 'tall', x: 36, y: 0, s: 2, z: 0, tall: 2, color: '#33cc99' },
    { txid: 'right0', x: 38, y: 0, s: 1, z: 0, tall: 1, color: '#cc9933' },
    { txid: 'right1', x: 38, y: 1, s: 1, z: 0, tall: 1, color: '#cc9933' },
    { txid: 'left0', x: 35, y: 0, s: 1, z: 0, tall: 1, color: '#cc9933' },
  ];
  assert.ok(obliqueLean(37, O) > 0, 'the face leans right here');
  const sc = buildScene(tiles, O);
  assert.ok(firstOp(sc, 'right0') < firstOp(sc, 'tall'), 'the right neighbour is under the leaning face: painted first');
  assert.ok(firstOp(sc, 'right1') < firstOp(sc, 'tall'));
});

test('the near/far order is untouched: a tile wholly in front still paints after a taller cube behind it', () => {
  const tiles = [
    { txid: 'far', x: 6, y: 3, s: 2, z: 0, tall: 2, color: '#33cc99' },
    { txid: 'near', x: 6, y: 0, s: 1, z: 0, tall: 1, color: '#cc9933' },
  ];
  const sc = buildScene(tiles, O);
  assert.ok(firstOp(sc, 'near') > firstOp(sc, 'far'), 'nearer paints later, as before');
});

test('equal heights side by side get no leaning-face constraint', () => {
  const tiles = [
    { txid: 'a', x: 6, y: 0, s: 1, z: 0, tall: 1, color: '#33cc99' },
    { txid: 'b', x: 7, y: 0, s: 1, z: 0, tall: 1, color: '#cc9933' },
  ];
  const sc = buildScene(tiles, O);
  assert.ok(firstOp(sc, 'a') >= 0 && firstOp(sc, 'b') >= 0, 'both drawn; no rule applies, no error');
});
