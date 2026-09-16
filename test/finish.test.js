// THE FINISH: neon edges and a metallic sheen, each a switch (operator, 2026-09-12: "consider
// neon-izing each of teh blocks, and adding an optional specular metallic sheen to the blocks.
// Have it toggle. I want to be able to apply the sheen onto simple cube mode if I want. think
// maximum configuration options").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildScene, lampOf } from '../public/js/blockscene3d.js';
import { board3d } from '../public/js/details3d.js';
import { spaceOptions, DEFAULTS, loadSettings } from '../public/js/settings.js';

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
  assert.ok(hot.length >= TILES.length && hot.every((op) => alpha(op.fill) >= 0.8), 'a white-hot specular core on the lit edge');
  // GRADED, NOT STEPPED (2026-09-12: "have the gradient be less coarse"). The bands are nested and
  // painted widest-first, so the opacity ACCUMULATES toward the edge -- which means the right
  // things to assert are how much it accumulates to, and that no single band is big enough to be
  // seen as an edge. The old assertion demanded every dark band be >= 0.25 on its own, which a
  // graded ramp can never satisfy: it was a pin that only a coarse gradient could pass.
  const stack = (ops) => 1 - ops.reduce((acc, op) => acc * (1 - alpha(op.fill)), 1);
  const bigDark = dark.filter((op) => op.txid === 'big');
  const bigRamp = s.filter((op) => op.txid === 'big' && !op.fill.startsWith('rgba(0,0,0') && !op.fill.startsWith('rgba(255,255,255'));
  assert.ok(bigDark.length >= 6, `the roll-off is a ramp, not a stripe (${bigDark.length} bands)`);
  assert.ok(bigRamp.length >= 12, `and so is the highlight (${bigRamp.length} bands)`);
  assert.ok(stack(bigDark) >= 0.25, `the roll-off still reaches the far edge (${stack(bigDark).toFixed(2)})`);
  assert.ok(stack(bigRamp) >= 0.35, `and the highlight is worth seeing (${stack(bigRamp).toFixed(2)})`);
  for (const op of [...bigDark, ...bigRamp]) {
    assert.ok(alpha(op.fill) <= 0.12, `no single band may read as a step: ${op.fill}`);
  }
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
  // the outline's weight is a setting (operator: "a slider to configure neon ghost line thickness")
  const widths = (w) => buildScene([{ txid: 'g', x: 3, y: 3, s: 1, z: 0, color: '#ef5a5a', wire: '#3d8bff' }], { ...O, edges: false, wireWidth: w }).ops.map((op) => op.lw);
  const thin = widths(0.4), fat = widths(2);
  assert.ok(Math.max(...thin) < Math.max(...ops.map((op) => op.lw)), 'a lower setting draws thinner');
  assert.ok(Math.max(...fat) > Math.max(...ops.map((op) => op.lw)), 'and a higher one heavier');
  assert.ok(Math.min(...thin) > 0, 'never to nothing');
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
  // six places at three heights (2026-09-16): the height reaches the scene, low rakes the sides harder than high
  assert.equal(spaceOptions({ space: { light: 'bottom-right', lightHeight: 'low' } }).lightHeight, 'low');
  assert.equal(spaceOptions({ space: { lightHeight: 'nowhere' } }).lightHeight, 'middle');
  const spread = (h) => { const v = sidesOf({ light: 'bottom-left', lightHeight: h }); return Math.max(...v) - Math.min(...v); };
  assert.ok(spread('low') > spread('high'), 'a low lamp tells the sides apart more than a high one');
  assert.deepEqual(lampOf({ light: 'upper-left' }), lampOf({ light: 'top-left' }), 'the old names still answer: upper-left is top-left');
  assert.notDeepEqual(lampOf({ light: 'viewer' }), lampOf({ light: 'front' }), "'viewer' is the Markets board's flat finish, not a placement: it falls to the default lamp");
  assert.deepEqual(lampOf({ light: 'viewer' }), lampOf({ light: 'top-left' }));
  // a store from before the rename comes forward: front is the viewer, upper-left the top left
  const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  st.setItem('blockyard.settings', JSON.stringify({ version: 4, space: { light: 'front' } }));
  assert.equal(loadSettings(st).space.light, 'front', 'v4 front stays front');
  st.setItem('blockyard.settings', JSON.stringify({ version: 4, space: { light: 'upper-left' } }));
  assert.equal(loadSettings(st).space.light, 'top-left');
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /light: opts\.light,/, 'render3d hands it to the scene (the finishes were once left out of that object)');
});

test('the neon tubes take one colour and a brightness when asked, the block\'s own colour otherwise', () => {
  const rgb = (col) => col.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)/).slice(1).map(Number);
  const tubes = (extra) => buildScene(TILES, { ...O, neon: true, ...extra }).ops.filter((op) => op.face === 'neon' && op.txid === 'big' && op.lw > 2.5 && op.lw < 6);   // the tube: between the core and the halo at any brightness
  const own = rgb(tubes({})[0].stroke), one = rgb(tubes({ neonSource: 'colour', neonColour: '#ff2020' })[0].stroke);
  assert.ok(own[1] > own[0], 'the block\'s green');
  assert.ok(one[0] > 200 && one[1] < 120, `the one colour, red: ${tubes({ neonSource: 'colour', neonColour: '#ff2020' })[0].stroke}`);
  assert.deepEqual(rgb(tubes({ neonSource: 'colour', neonColour: 'nope' })[0].stroke), own, 'a bad colour falls back to the block\'s own');
  const dim = tubes({ neonBrightness: 0.3 })[0], loud = tubes({ neonBrightness: 2 })[0];
  assert.ok(rgb(dim.stroke)[3] < rgb(loud.stroke)[3] && dim.lw < loud.lw, 'brightness into alpha and width');
});

test('a sphere tile is drawn round: nested discs, no cube faces', () => {
  // (operator, 2026-09-12: "Can we have a ball for blockout instead of a block for the bouncing
  // dot?") -- Blockout's ball. The op format has no arcs and the canvas rules forbid gradients, so
  // roundness is polygons: enough sides to read as a circle, and three of them for shading.
  const ops = buildScene([{ txid: 'ball', x: 4, y: 4, s: 0.84, tall: 0.84, z: 0, color: '#f2f7ff', sphere: true }], O).ops;
  assert.ok(ops.length > 0);
  assert.ok(ops.every((op) => op.face === 'ball'), `only ball ops: ${[...new Set(ops.map((o) => o.face))]}`);
  assert.equal(ops.length, 3, 'a rim, a body and a highlight');
  for (const op of ops) {
    assert.ok(op.points.length >= 16, `${op.points.length} sides is not a circle`);
    assert.ok(op.fill.startsWith('rgba('), 'a plain rgba fill, like every other op');
    assert.ok(!op.stroke, 'and no outline: a ball has no edges to seam');
    // every vertex the same distance from the centre, which is what makes it round
    const cx = op.points.reduce((n, p) => n + p.x, 0) / op.points.length;
    const cy = op.points.reduce((n, p) => n + p.y, 0) / op.points.length;
    const rs = op.points.map((p) => Math.hypot(p.x - cx, p.y - cy));
    assert.ok(Math.max(...rs) - Math.min(...rs) < 1e-6, 'every vertex on one circle');
  }
  const radius = (op) => Math.hypot(op.points[0].x - op.points[12].x, op.points[0].y - op.points[12].y) / 2;
  assert.ok(radius(ops[0]) > radius(ops[1]) && radius(ops[1]) > radius(ops[2]), 'rim, then body, then a smaller highlight');
  // and an ordinary tile is still a cube
  const cube = buildScene([{ txid: 'c', x: 4, y: 4, s: 1, tall: 1, z: 0, color: '#f2f7ff' }], O).ops;
  assert.ok(cube.some((op) => op.face === 'top'), 'a tile without the flag keeps its faces');
  assert.ok(!cube.some((op) => op.face === 'ball'));
});

test('CHROME mirrors a horizon that differs from cube to cube and moves with the cube, and keeps the fee colour', () => {
  // (operator, 2026-09-14: "make the specular metallic effect more prominent. Maybe give it a chrome
  // or faux reflective effect ... really improve the metallic look")
  const alpha = (fill) => Number(fill.match(/,([\d.]+)\)$/)[1]);
  const chrome = (tiles) => buildScene(tiles, { ...O, sheen: true, sheenStyle: 'chrome' }).ops.filter((op) => op.face === 'sheen');
  const s = chrome(TILES);
  assert.ok(s.length > faces({ sheen: true }, 'sheen').length * 0.5, 'a real finish, not a token one');
  // the horizon: a near-opaque white line across the top face
  const horizonOf = (ops, id) => ops.find((op) => op.txid === id && op.fill.startsWith('rgba(255,255,255') && alpha(op.fill) > 0.85 && op.points.length === 4);
  assert.ok(horizonOf(s, 'big') && horizonOf(s, 'small'), 'every cube carries a hard horizon line');
  // ...placed by where the cube is, so neighbours do not line up into one stripe across the board
  const yOf = (op) => op.points.reduce((acc, p) => acc + p.y, 0) / 4;
  const at = (x, y) => horizonOf(chrome([{ txid: 'c', x, y, s: 3, z: 0, color: '#33cc99' }]), 'c');
  const q = (op, tile) => { const top = buildScene([tile], O).ops.find((o2) => o2.face === 'top').points; const ys = top.map((p) => p.y); return (yOf(op) - Math.min(...ys)) / (Math.max(...ys) - Math.min(...ys)); };
  const t1 = { txid: 'c', x: 4, y: 6, s: 3, z: 0 }, t2 = { txid: 'c', x: 9, y: 6, s: 3, z: 0 };
  assert.ok(Math.abs(q(at(4, 6), t1) - q(at(9, 6), t2)) > 0.05, 'the horizon sits at a different depth on a cube five columns along');
  // ...and it slides as the cube climbs: the reflection travels across a flying cube's face
  const flying = (z) => horizonOf(chrome([{ txid: 'c', x: 4, y: 6, s: 3, z, color: '#33cc99' }]), 'c');
  assert.notDeepEqual(flying(0).points, flying(12).points);
  // the fee colour is the data: the sky reflection is the cube's own hue lifted, not a neutral grey
  const sky = s.filter((op) => op.txid === 'small' && /^rgba\(2\d\d,\d+,\d+/.test(op.fill) && !op.fill.startsWith('rgba(255,255,255'));
  assert.ok(sky.some((op) => { const [r, g, b] = op.fill.match(/\d+/g).map(Number); return r > g + 20 && r > b + 20; }), 'a red cube reflects a red-tinted sky');
  // satin is untouched, and the setting reaches the renderer
  assert.deepEqual(faces({ sheen: true, sheenStyle: 'satin' }, 'sheen'), faces({ sheen: true }, 'sheen'));
  assert.equal(DEFAULTS.space.sheenStyle, 'chrome');
  assert.equal(spaceOptions({ space: { sheen: true, sheenStyle: 'satin' } }).sheenStyle, 'satin');
  assert.equal(spaceOptions({ space: { sheenStyle: 'mirror' } }).sheenStyle, 'chrome', 'an unknown finish falls back to chrome');
});

// HOW HARD THE LAMP IS (operator, 2026-09-16: "we need better lighting on the front of the blocks.
// Still looks too washed out and not illuminated well enough")
test('a board can ask for a harder lamp, and 1 is what every board drew before', () => {
  const tiles = [{ txid: 'a', x: 2, y: 2, s: 1, tall: 1, color: '#8a6a44' }];
  const base = { gridW: 8, gridH: 8, unit: 12, light: 'front', lightHeight: 'low', oblique: { ox: 0.1, oy: 0.3, headroom: 3, flight: 0 } };
  const litOf = (o) => buildScene(tiles, { ...base, ...o }).ops.filter((p) => p.face === 'side' || p.face === 'top').map((p) => p.fill);
  const plain = litOf({}), gained = litOf({ lightGain: 1.8, topLight: 0.66 });
  assert.equal(plain.length, gained.length, 'the same faces either way');
  assert.deepEqual(plain, litOf({ lightGain: 1 }), 'a gain of 1 is exactly the shipped look');
  const value = (fill) => { const m = String(fill).match(/rgba?\(([^)]+)\)/); if (!m) return 0; const v = m[1].split(',').map(Number); return v[0] + v[1] + v[2]; };
  const spread = (list) => Math.max(...list.map(value)) - Math.min(...list.map(value));
  assert.ok(spread(gained) > spread(plain) * 1.4, `a harder lamp tells the faces further apart (${spread(plain)} -> ${spread(gained)})`);
});
