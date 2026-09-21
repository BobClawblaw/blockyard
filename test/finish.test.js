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

test('SATIN is brushed metal: a broad sheen across every face, machined bevels, the fee colour kept -- and it works on the plainest cube', () => {
  // (2026-09-12: two faint bands were "I don't see ... the metallic sheen"; 2026-09-22, of the edge gleam that
  // followed: "It's still too muted and not metallic enough" -- beside the plain board the difference was a sliver.)
  const s = faces({ sheen: true, sheenStyle: 'satin' }, 'sheen');
  assert.deepEqual(faces({ sheen: true }, 'sheen').map((op) => op.points.length), s.map((op) => op.points.length), 'satin is what a bare `sheen` means');
  assert.ok(s.every((op) => op.ramp && op.ramp.stops.length >= 3 && op.ramp.stops.length <= 32), 'every piece one gradient fill, within what a prepared gradient holds');
  const lum = (c) => 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];
  const per = (id) => s.filter((op) => op.txid === id);
  // the sheen lies ACROSS the face, from the board's one room -- so a band runs on from cube to cube
  const rooms = s.filter((op) => op.ramp.room);
  assert.equal(rooms.length, TILES.length, 'one on every tile');
  for (const k of ['x0', 'y0', 'x1', 'y1']) assert.equal(rooms[0].ramp[k], rooms[1].ramp[k], `one gradient line for the board (${k})`);
  const ls = rooms[0].ramp.stops.map((sp) => lum(sp[1]));
  assert.ok(Math.max(...ls) - Math.min(...ls) > 90, `metal is contrast (${Math.round(Math.min(...ls))}..${Math.round(Math.max(...ls))})`);
  assert.ok(Math.max(...ls) < 250 && Math.min(...ls) > 25, 'but satin is never blown out and never black: that is chrome');
  // the fee colour is the data: a red cube is still plainly red in every tone
  const red = s.find((op) => op.txid === 'small' && op.ramp.room).ramp.stops.map((sp) => sp[1]);
  assert.ok(red.every(([r, g, b]) => r > g + 15 && r > b + 15), 'toward steel a little, and no further');
  // machined bevels where a cube has them: the rim facing the lamp white-hot at its corner, the far rims deep
  const rims = per('big').filter((op) => !op.ramp.room && op.grain === true && op.ramp.stops.length === 3);   // (a side's sheen is grained too: the room's sixteen stops)
  assert.equal(rims.length, 4, 'four rim strips on a bevelled cube');
  assert.equal(rims.filter((op) => lum(op.ramp.stops[0][1]) > 245).length, 2, 'two of them lit along the corner');
  assert.equal(rims.filter((op) => lum(op.ramp.stops[0][1]) < 90).length, 2, 'and two deep');
  // "I want to be able to apply the sheen onto simple cube mode": the plainest cube carries the sheen and a gleam
  const flat = faces({ sheen: true, facetMinUnits: Infinity, crownMinUnits: Infinity }, 'sheen');   // (the scene's own switches; facetPx is render3d's)
  assert.ok(flat.filter((op) => op.ramp.room).length === TILES.length, 'flat tiles carry it too');
  assert.ok(flat.some((op) => op.txid === 'big' && lum(op.ramp.stops[0][1]) > 245 && op.ramp.stops.at(-1)[1][3] === 0), 'with a gleam along the lit edge that fades to nothing');
  // the grain is asked for on the metal, not on the soft fall-off laid over it
  assert.ok(rooms.every((op) => op.grain === true) && s.some((op) => !op.grain));
});

test('neon strokes every visible edge in the block\'s own colour, seam or no seam', () => {
  const n = faces({ neon: true }, 'neon');
  assert.ok(n.length >= TILES.length * 2, 'at least a halo and a tube per block');
  assert.ok(n.every((op) => op.stroke && op.fill === 'rgba(0,0,0,0)' && op.always === true), 'strokes only, and marked to draw even with Stone edges off');
  // the GL renderer draws a halo, tube and core as ONE stroke: the halo names the tube's colour (just under opaque --
  // an opaque stroke is never drawn soft, and came out as flat bands), the other two say they are parts
  const halos = n.filter((op) => op.neonTube), parts = n.filter((op) => op.neonPart === true);
  assert.ok(halos.length > 0 && parts.length === 2 * halos.length && halos.length + parts.length === n.length);
  assert.ok(halos.every((op) => { const al = Number(op.neonTube.match(/,([\d.]+)\)$/)[1]); return al > 0.5 && al < 0.999; }));
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
  // (the finishes are gradient fills since 2026-09-22; this stub context's gradients take no stops, which the
  // painter must survive -- it threw 'g.addColorStop is not a function' on the first cut)
  const grads = (ops) => ops.filter((o) => o === 'createLinearGradient').length;
  assert.equal(grads(plain), 0, 'no ramp without the sheen');
  assert.ok(grads(sheen) >= 2 * E2E.length, `the sheen paints its ramps (${grads(sheen)})`);
  assert.ok(grads(paint({ sheen: true, sheenStyle: 'chrome' })) >= 2 * E2E.length, 'and so does chrome');
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

test('CHROME is a room\'s lights in polished steel: soft bands laid across the whole board, two fills a face, the fee colour kept', () => {
  // (operator, 2026-09-14: "give it a chrome or faux reflective effect"; 2026-09-22: "The chrome effect is too expensive
  // and honestly doesn't look very good ... Start the chrome effect from scratch"; and of the second cut, a hard tilted
  // horizon per cube: "looks terrible with the slanted areas that move", with pictures of soft-banded polished steel.)
  const chrome = (tiles, extra = {}) => buildScene(tiles, { ...O, sheen: true, sheenStyle: 'chrome', ...extra }).ops.filter((op) => op.face === 'sheen');
  const s = chrome(TILES);
  const per = (id) => s.filter((op) => op.txid === id);
  assert.ok(per('big').filter((op) => !op.lamp).length <= 2 * 4 + 1, `cheap: two ramps a face and the polished edge (${per('big').length} ops; the first chrome was thirty-seven)`);
  // THE GLINT (operator, 2026-09-22: "the glints look terrible on the chrome board. either remove or drastically improve
  // them", then "Try the improved glint you recommend"). Not a star stuck on one cube in five by a hash: a soft flare
  // exactly where one of the room's blown-out strips crosses the cube's far edge -- solved, so it cannot be anywhere else.
  const board = []; for (let x = 0; x < 20; x += 2) for (let y = 0; y < 20; y += 2) board.push({ txid: `g${x}_${y}`, x, y, s: 2, z: 0, color: '#33cc99' });
  const full = chrome(board);
  assert.ok(full.every((op) => op.ramp || op.stroke), 'ramps and edges only: no hard white diamonds');
  const glows = full.filter((op) => op.lamp && op.ramp.r > 0), streaks = full.filter((op) => op.lamp && !(op.ramp.r > 0));
  assert.ok(glows.length > 0 && glows.length < board.length && streaks.length === glows.length, `on the cubes a strip crosses, and only those (${glows.length} of ${board.length})`);
  for (const gl of glows) {
    const room = full.find((op) => op.txid === gl.txid && op.ramp.room).ramp, dx = room.x1 - room.x0, dy = room.y1 - room.y0;
    const t = ((gl.ramp.x0 - room.x0) * dx + (gl.ramp.y0 - room.y0) * dy) / (dx * dx + dy * dy);
    assert.ok(Math.min(Math.abs(t - 0.33), Math.abs(t - 0.82)) < 1e-6, `the flare sits ON a blown-out strip (t = ${t.toFixed(4)})`);
    assert.equal(gl.ramp.stops.at(-1)[1][3], 0, 'and fades to nothing');
    assert.ok(gl.ramp.r <= O.unit * 1.3 + 1e-9, 'a small thing, whatever the cube');
  }
  assert.ok(streaks.every((op) => op.ramp.stops[0][1][3] === 0 && op.ramp.stops.at(-1)[1][3] === 0), 'the streak along the edge fades out both ways');
  // it slides along the edge as a cube flies under the light, and comes in from the ends rather than popping
  const gx = (z) => chrome([{ txid: 'c', x: 6, y: 6, s: 3, z, color: '#33cc99' }]).filter((op) => op.lamp && op.ramp.r > 0).map((op) => op.ramp.x0);
  const zs = []; for (let z = 0; z <= 40; z += 0.5) zs.push(gx(z));
  const seen = zs.filter((v) => v.length).map((v) => v[0]);
  assert.ok(seen.length > 3 && new Set(seen.map((v) => v.toFixed(3))).size === seen.length, 'a different place at every height it is seen at');
  const lum = (c) => 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];
  const roomOf = (ops, id) => ops.find((op) => op.txid === id && op.ramp?.room);
  const big = roomOf(s, 'big'), small = roomOf(s, 'small');
  assert.ok(big && small && big.points.length === 4, 'the whole top face, uncut: nothing slanted across it');
  // THE BANDS BELONG TO THE ROOM: every resting cube is filled from the SAME line across the board, so a band runs
  // on from one cube to the next and nothing on a resting board differs by whim or moves
  for (const k of ['x0', 'y0', 'x1', 'y1']) assert.equal(big.ramp[k], small.ramp[k], `one gradient line for the board (${k})`);
  assert.ok(Math.abs(big.ramp.x1 - big.ramp.x0) > 40 * O.unit * 0.0 + 1 && Math.abs(big.ramp.y1 - big.ramp.y0) < Math.abs(big.ramp.x1 - big.ramp.x0) * 0.3, 'upright bands, leaning a fixed few degrees');
  // soft, all of it (the GL renderer's ramps are 64 texels: a hard line in one came out as a smear), and contrasty
  const offs = big.ramp.stops.map((sp) => sp[0]);
  for (let i = 1; i < offs.length; i++) assert.ok(offs[i] - offs[i - 1] >= 0.025, 'no feature finer than a texel or two');
  const ls = big.ramp.stops.map((sp) => lum(sp[1]));
  assert.ok(Math.max(...ls) > 245 && Math.min(...ls) < 40, 'from a blown-out light to the dark between the lights');
  let turns = 0; for (let i = 2; i < ls.length; i++) if ((ls[i] - ls[i - 1]) * (ls[i - 1] - ls[i - 2]) < 0) turns++;
  assert.ok(turns >= 8, `several strip lights, not one gradient (${turns} turns)`);
  assert.ok(big.ramp.stops.every((sp) => sp[1][3] >= 0.6), 'a reflection, not a wash');
  // a cube that FLIES passes under the lights: its reflection slides by its height, and only then
  const flying = (z) => roomOf(chrome([{ txid: 'c', x: 4, y: 6, s: 3, z, color: '#33cc99' }]), 'c').ramp;
  assert.ok(flying(12).x0 > flying(0).x0 && flying(12).y0 === flying(0).y0, 'sideways, with height');
  // one memoised ramp a colour, however many cubes
  assert.equal(flying(0).stops, flying(12).stops);
  // the fee colour is the data: a red cube's mid-tones and darks are red
  const red = small.ramp.stops.map((sp) => sp[1]).filter((c) => lum(c) < 200);
  assert.ok(red.length > 4 && red.every(([r, g, b]) => r >= g && r >= b) && red.some(([r, g, b]) => r > g + 20 && r > b + 20), 'the hue is in the reflection');
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

