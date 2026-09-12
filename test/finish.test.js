// THE FINISH: neon edges and a metallic sheen, each a switch (operator, 2026-09-12: "consider
// neon-izing each of teh blocks, and adding an optional specular metallic sheen to the blocks.
// Have it toggle. I want to be able to apply the sheen onto simple cube mode if I want. think
// maximum configuration options").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildScene } from '../public/js/blockscene3d.js';
import { spaceOptions, DEFAULTS } from '../public/js/settings.js';

const TILES = [
  { txid: 'big', x: 2, y: 2, s: 5, z: 0, color: '#33cc99' },
  { txid: 'small', x: 10, y: 3, s: 1, z: 0, color: '#cc3333' },
];
const O = { unit: 6, zUnit: 6, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5, gridW: 20, gridH: 20 };
const faces = (opts, name) => buildScene(TILES, { ...O, ...opts }).ops.filter((op) => op.face === name);

test('neither finish is drawn until asked for', () => {
  assert.equal(faces({}, 'sheen').length, 0);
  assert.equal(faces({}, 'neon').length, 0);
  assert.equal(DEFAULTS.space.neon, false, 'opt-in: the shipped look is the deliberate one');
  assert.equal(DEFAULTS.space.sheen, false);
});

test('the sheen is two bands on every top face, and it works on the plainest cube', () => {
  const s = faces({ sheen: true }, 'sheen');
  assert.equal(s.length, TILES.length * 2, 'an outer and an inner band per block');
  assert.ok(s.every((op) => op.points.length === 4 && op.fill.startsWith('rgba(')), 'plain quads with alpha in the fill');
  // "I want to be able to apply the sheen onto simple cube mode": with the facets and the crown
  // gone, the sheen is still there -- it lives on the top face every tile has
  const flat = faces({ sheen: true, facetPx: Infinity, crownPx: Infinity }, 'sheen');
  assert.equal(flat.length, TILES.length * 2, 'flat tiles carry it too');
  // the inner band is hotter than the outer: a gleam, not a wash
  const [outer, inner] = s;
  const alpha = (fill) => Number(fill.match(/,([\d.]+)\)$/)[1]);
  assert.ok(alpha(inner.fill) > alpha(outer.fill), `inner ${inner.fill} brighter than outer ${outer.fill}`);
});

test('neon strokes every visible edge in the block\'s own colour, seam or no seam', () => {
  const n = faces({ neon: true }, 'neon');
  assert.ok(n.length >= TILES.length * 2, 'at least a halo and a tube per block');
  assert.ok(n.every((op) => op.stroke && op.fill === 'rgba(0,0,0,0)' && op.always === true), 'strokes only, and marked to draw even with Stone edges off');
  assert.ok(n.some((op) => op.lw > 4) && n.some((op) => op.lw < 2), 'a wide faint halo under a thin bright tube');
  // the paint pass honours `always`: the seam gate used to swallow every stroke when edges were off
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /op\.stroke && \(opts\.edges \|\| op\.always\)/, 'neon draws whether or not the dark seam is on');
});

test('the switches reach the board and repaint at once', () => {
  const on = spaceOptions({ space: { neon: true, sheen: true } });
  assert.equal(on.neon, true); assert.equal(on.sheen, true);
  const off = spaceOptions({});
  assert.equal(off.neon, false); assert.equal(off.sheen, false);
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const sig = src.slice(src.indexOf('const optSig = ['), src.indexOf('const lookChanged'));
  assert.ok(sig.includes('opts.neon') && sig.includes('opts.sheen'), 'both are part of the look, so flipping one repaints without a poll');
});
