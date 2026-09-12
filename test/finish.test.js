// THE FINISH: neon edges and a metallic sheen, each a switch (operator, 2026-09-12: "consider
// neon-izing each of teh blocks, and adding an optional specular metallic sheen to the blocks.
// Have it toggle. I want to be able to apply the sheen onto simple cube mode if I want. think
// maximum configuration options").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildScene } from '../public/js/blockscene3d.js';
import { board3d } from '../public/js/details3d.js';
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

test('the sheen is a hot highlight and a dark roll-off on every top face, and it works on the plainest cube', () => {
  // (2026-09-12: two faint bands were "I don't see ... the metallic sheen"; metal is contrast)
  const s = faces({ sheen: true }, 'sheen');
  const perTile = (name) => s.filter((op) => op.txid === name);
  assert.ok(perTile('big').length >= 5 && perTile('small').length >= 5, 'three highlight bands and two dark bands per block, at least');
  assert.ok(s.every((op) => op.points.length === 4 && op.fill.startsWith('rgba(')), 'plain quads with alpha in the fill');
  // "I want to be able to apply the sheen onto simple cube mode": with the facets and the crown
  // gone, the sheen is still there -- it lives on the top face every tile has
  const flat = faces({ sheen: true, facetPx: Infinity, crownPx: Infinity }, 'sheen');
  assert.equal(flat.length, s.length, 'flat tiles carry it too');
  const alpha = (fill) => Number(fill.match(/,([\d.]+)\)$/)[1]);
  const hot = s.filter((op) => op.fill.startsWith('rgba(255,255,255'));
  const dark = s.filter((op) => op.fill.startsWith('rgba(0,0,0'));
  assert.ok(hot.length >= TILES.length && hot.every((op) => alpha(op.fill) >= 0.8), 'a white-hot core on the lit edge');
  assert.ok(dark.length >= TILES.length && dark.every((op) => alpha(op.fill) >= 0.25), 'and a dark roll-off on the far edge');
});

test('neon strokes every visible edge in the block\'s own colour, seam or no seam', () => {
  const n = faces({ neon: true }, 'neon');
  assert.ok(n.length >= TILES.length * 2, 'at least a halo and a tube per block');
  assert.ok(n.every((op) => op.stroke && op.fill === 'rgba(0,0,0,0)' && op.always === true), 'strokes only, and marked to draw even with Stone edges off');
  assert.ok(n.some((op) => op.lw >= 10) && n.some((op) => op.lw >= 3 && op.lw < 6) && n.some((op) => op.lw < 2), 'a wide halo, a tube, a thin bright core');
  // (2026-09-12: a 1.4 x tube over the 0.6-pixel base line was "I don't see neon blocks working")
  const alpha = (col) => Number(col.match(/,([\d.]+)\)$/)[1]);
  assert.ok(n.filter((op) => op.lw >= 3 && op.lw < 6).every((op) => alpha(op.stroke) >= 0.95), 'the tube is opaque');
  const tops = (opts) => buildScene(TILES, { ...O, ...opts }).ops.filter((op) => op.face === 'top');
  // ...but SOLID and in the block's colour (2026-09-12: "Need solid dim neon colored faces to the
  // block sides, and keep the brighter glow in the outline"): the hue is the feerate
  const rgb = (fill) => fill.match(/rgba\((\d+),(\d+),(\d+)/).slice(1).map(Number);
  const bigTop = tops({ neon: true }).find((op) => op.txid === 'big');
  const [r, g, b] = rgb(bigTop.fill);                            // #33cc99: green-dominant
  assert.ok(g > r * 2 && g > b && g >= 90, `a dim green, not black or grey: ${bigTop.fill}`);
  const sides = buildScene(TILES, { ...O, neon: true }).ops.filter((op) => op.face === 'side' && op.txid === 'big');
  assert.ok(sides.every((op) => { const [sr, sg] = rgb(op.fill); return sg > sr * 2 && sg >= 35; }), 'the sides too (the shadow side darkest, still green)');
  const flat = buildScene(TILES, { ...O, neon: true }).ops.map((op) => op.face);
  assert.ok(!flat.includes('bevel') && !flat.includes('rim'), 'a neon cube is flat: no facets or crown under the tubes');
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

test('a wire tile is an outline and nothing else: no fill, a halo under a bright line, drawn with the seam off', () => {
  // Tetrust's ghost (operator, 2026-09-12: "wireframes on teh bottom of the tetrust playfield ...
  // The solid dark colored stuff is too difficult to see")
  const ops = buildScene([{ txid: 'g', x: 3, y: 3, s: 1, z: 0, color: '#ef5a5a', wire: '#3d8bff' }], { ...O, edges: false }).ops;
  assert.ok(ops.length > 0);
  assert.ok(ops.every((op) => op.face === 'wire'), `nothing but wire ops: ${[...new Set(ops.map((op) => op.face))]}`);
  assert.ok(ops.every((op) => op.fill === 'rgba(0,0,0,0)' && op.stroke && op.always === true), 'strokes only, and they draw whether or not Stone edges is on');
  assert.ok(ops.some((op) => op.lw >= 8) && ops.some((op) => op.lw <= 3), 'a wide halo and a line');
  const rgb = (col) => col.match(/rgba\((\d+),(\d+),(\d+)/).slice(1).map(Number);
  assert.ok(ops.every((op) => { const [r, , b] = rgb(op.stroke); return b >= 200 && r < 160; }), `in the wire colour (blue), not the tile's (red): ${ops[0].stroke}`);
});

// END TO END, through render3d (2026-09-12: "I don't see neon blocks working, nor the metallic
// sheen" -- both were in buildScene and in the look signature, and render3d's view object left
// them out, so the settings switch repainted the same picture; the tests above, which call
// buildScene directly, could not see it)
function harness() {
  const ops = [];
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => 0 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = globalThis.document ?? {};
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      return () => { ops.push(String(k)); return t.canvas; };
    },
    set(t, k, v) { ops.push('set:' + k + '=' + String(v).slice(0, 40)); t[k] = v; return true; },
  });
  const canvas = { clientWidth: 600, clientHeight: 600, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: () => {}, setPointerCapture: () => {} };
  return { canvas, ops };
}
const E2E = [{ txid: 'a', x: 0, y: 0, s: 2, tall: 1, color: '#33cc99' }, { txid: 'b', x: 3, y: 1, s: 1, tall: 1, color: '#cc3333' }];
const paint = (extra) => {
  const h = harness();
  board3d(h.canvas, E2E, { gridW: 6, gridH: 6, space: true, stars: false, idleFx: false, still: true, transition: { rise: 0, travel: 1, drop: 0 }, ...extra });
  return h.ops;
};

test('the switches reach the picture: neon strokes more, the sheen paints white-hot, through render3d', () => {
  const plain = paint({});
  const neon = paint({ neon: true });
  const sheen = paint({ sheen: true });
  const strokes = (ops) => ops.filter((o) => o === 'stroke').length;
  assert.ok(strokes(neon) >= strokes(plain) + 3 * 2 * E2E.length, `neon strokes every tile three more times a face: ${strokes(plain)} -> ${strokes(neon)}`);
  assert.ok(!plain.some((o) => o.startsWith('set:fillStyle=rgba(255,255,255,0.9')), 'no white-hot band without the sheen');
  assert.ok(sheen.some((o) => o.startsWith('set:fillStyle=rgba(255,255,255,0.9')), 'the sheen paints its white-hot band');
});

test('maxDpr draws a canvas at fewer device pixels than the screen has (Tetrust\'s sky)', () => {
  const h = harness();                                    // window.devicePixelRatio = 2
  board3d(h.canvas, E2E, { gridW: 6, gridH: 6, still: true, transition: { rise: 0, travel: 1, drop: 0 } });
  assert.equal(h.canvas.width, 1200, 'at the screen\'s 2x by default');
  const k = harness();
  board3d(k.canvas, E2E, { gridW: 6, gridH: 6, still: true, transition: { rise: 0, travel: 1, drop: 0 }, maxDpr: 1 });
  assert.equal(k.canvas.width, 600, 'capped at 1x: a quarter of the pixels, and of the stars');
});

test('the lamp: overhead shades no slope, a corner does, and the choice reaches the picture through render3d', () => {
  // (Tetrust, operator 2026-09-12: "The bottom of the tetrust board is too [dark]. We need direct
  // overhead lighting in teh 3d scene for the game")
  const low = { txid: 'low', x: 4, y: 0, s: 1, z: 0, color: '#33cc99' }, mid = { txid: 'mid', x: 4, y: 9, s: 1, z: 0, color: '#33cc99' };
  const tops = (extra) => buildScene([low, mid], { ...O, gridW: 10, gridH: 20, ...extra }).ops.filter((op) => op.face === 'top');
  const g = (fill) => Number(fill.match(/rgba\((\d+),(\d+)/)[2]);
  const shaded = tops({ light: 'upper-left' });
  assert.ok(g(shaded.find((o) => o.txid === 'low').fill) < g(shaded.find((o) => o.txid === 'mid').fill), 'under the upper-left lamp the bottom row is darker than the middle');
  for (const flat of [tops({ overheadLight: true }), tops({ light: 'overhead' })]) {
    assert.equal(g(flat.find((o) => o.txid === 'low').fill), g(flat.find((o) => o.txid === 'mid').fill), 'under the overhead lamp they are the same');
  }
  const sidesOf = (extra) => buildScene([mid], { ...O, gridW: 10, gridH: 20, ...extra }).ops.filter((op) => op.face === 'side').map((op) => g(op.fill));
  assert.ok(new Set(sidesOf({ light: 'overhead' })).size === 1, 'overhead: every side the same light');
  assert.ok(new Set(sidesOf({ light: 'front' })).size > 1, 'a lamp at the viewer: the side facing it brighter than the one edge-on');
  assert.equal(DEFAULTS.space.light, 'overhead', 'the Block space lamp hangs straight above the board (operator, 2026-09-12)');
  assert.equal(spaceOptions({ space: { light: 'front' } }).light, 'front');
  assert.equal(spaceOptions({ space: { light: 'nowhere' } }).light, 'overhead', 'an unknown lamp is the default');
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /light: opts\.light,/, 'render3d hands it to the scene (the finishes were once left out of that object)');
});
