// THE 2.5D RENDERER (operator, 2026-09-28: "add a '2d' only mode for our '3d' work. Make it another
// renderer along with software and webgl. Both paths consume way too much GPU processing, and I
// would like to have a low-fidelity version that doesn't stress the GPU at all" -- "Call it
// '2.5D'"). What a graphics card pays for is frames, so what is held here is FRAMES: a 2.5D board
// paints once per change and never on its own -- no sky loop, no effect, no transition, no fade --
// and the frame it paints is plain fills and strokes. Driven through the real render3d with the
// recording context test/details3d.test.js uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render3d, board3d, hitTest, triggerIdle, rendererOf, rendererIn, flatOptions, RENDERERS, viewerIdle } from '../public/js/details3d.js';
import { DEFAULTS, PANEL, normalise } from '../public/js/settings.js';

function harness() {
  let rafPending = null;
  const ops = [];
  harness.t = 0;
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => harness.t ?? 0 };
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 42; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      return (...a) => { ops.push(k === 'setTransform' ? 'setTransform:' + a.join(',') : String(k)); return t.canvas; };
    },
    set(t, k, v) { ops.push('set:' + k + '=' + String(v).slice(0, 24)); t[k] = v; return true; },
  });
  const listeners = {};
  const canvas = {
    clientWidth: 640, clientHeight: 640, width: 0, height: 0, style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 640 }),
    addEventListener: (k, fn) => { (listeners[k] ||= []).push(fn); },
    setPointerCapture: () => {},
  };
  ctx.canvas = canvas;
  canvas.__fire = (k, e) => (listeners[k] || []).forEach((fn) => fn(e));
  return { canvas, ops, pump: (n = 12) => { let g = 0; while (rafPending && g++ < n) { const fn = rafPending; rafPending = null; harness.t += 16; fn(harness.t); } return g; }, pending: () => !!rafPending };
}

const cells = [
  { txid: 'a'.repeat(64), vbytes: 60000, rate: 40 },
  { txid: 'b'.repeat(64), vbytes: 40000, rate: 10 },
  { txid: 'c'.repeat(64), vbytes: 9000, rate: 3 },
  { vbytes: 300000, rate: 0.6, aggregate: 11000 },
];
const cells2 = [
  { txid: 'a'.repeat(64), vbytes: 30000, rate: 40 },
  { txid: 'd'.repeat(64), vbytes: 70000, rate: 25 },
  { vbytes: 300000, rate: 0.6, aggregate: 11000 },
];
// the shipped Block space look: a sky, effects, shadows off, the finishes off
const SPACE = { renderer: '2.5d', stars: true, galaxy: true, idleFx: true };
const FORBIDDEN = ['clip', 'createRadialGradient', 'createLinearGradient', 'createPattern', 'drawImage', 'filter'];

test('the choice: a third renderer, offered by the panel, accepted by normalise, chosen per canvas', () => {
  assert.deepEqual([...RENDERERS], ['software', 'webgl', '2.5d']);
  assert.equal(DEFAULTS.appearance.renderer, 'software', 'the shipped renderer is unchanged');
  const row = PANEL.find((g) => g.group === 'appearance').rows.find((r) => r.key === 'renderer');
  assert.deepEqual(row.options.map((o) => o[0]), [...RENDERERS]);
  assert.equal(row.options.find((o) => o[0] === '2.5d')[1], '2.5D', 'named as the operator named it');
  assert.equal(normalise({ appearance: { renderer: '2.5d' } }).appearance.renderer, '2.5d');
  assert.equal(rendererOf({ renderer: '2.5d' }), '2.5d');
  assert.equal(rendererOf({ renderer: 'flat' }), 'software', 'an unknown override falls to the setting');
  // the resolution setting scales the SKY, and 2.5D draws none: dimmed there as on WebGL
  const res = PANEL.find((g) => g.group === 'appearance').rows.find((r) => r.key === 'softwareScale');
  assert.equal(res.dimWhen({ appearance: { renderer: '2.5d' } }), true);
  assert.equal(res.dimWhen({ appearance: { renderer: 'webgl' } }), true);
  assert.equal(res.dimWhen({ appearance: { renderer: 'software' } }), false);
});

test('flatOptions takes away everything that repaints on its own, and nothing else', () => {
  const o = flatOptions({ stars: true, skyType: 'galaxy', idleFx: true, shadows: true, neon: true, sheen: true, space: true, axes: { y: 0 }, edges: true, grid: true, unit: 6 });
  assert.equal(o.stars, false); assert.equal(o.skyType, 'none'); assert.equal(o.idleFx, false);
  assert.equal(o.shadows, false); assert.equal(o.neon, false); assert.equal(o.sheen, false);
  assert.equal(o.facetPx, Infinity); assert.equal(o.crownPx, Infinity);
  assert.equal(o.space, true, 'the Markets look stays: it is a board style, not a sky');
  assert.deepEqual(o.axes, { y: 0 }); assert.equal(o.edges, true); assert.equal(o.grid, true); assert.equal(o.unit, 6);
});

test('a 2.5D board paints once, plainly, and parks -- under the shipped sky and effects', () => {
  const h = harness();
  const r = render3d(h.canvas, cells, SPACE);
  assert.equal(r.settled, true, 'the first paint lands at once');
  assert.equal(h.pending(), false, 'no animation frame was asked for: nothing is going to move');
  assert.equal(rendererIn(h.canvas), '2.5d');
  assert.ok(h.ops.filter((o) => o === 'fill').length >= 3, 'faces are filled');
  assert.ok(h.ops.some((o) => o.startsWith('set:fillStyle=rgba(')), 'alpha rides inside rgba() fills');
  for (const f of FORBIDDEN) assert.ok(!h.ops.includes(f), `no ${f}: the frame is plain fills and strokes`);
  assert.ok(!h.ops.some((o) => o.startsWith('set:globalAlpha') || o.startsWith('set:globalCompositeOperation')));
  assert.equal(h.pump(), 0, 'and there is no loop to pump');
  assert.equal(viewerIdle(h.canvas), true);
});

test('the same data again paints nothing at all', () => {
  const h = harness();
  render3d(h.canvas, cells, SPACE);
  const n = h.ops.length;
  for (let i = 0; i < 5; i++) { harness.t += 1000; const r = render3d(h.canvas, cells, SPACE); assert.equal(r.settled, true); }
  assert.equal(h.ops.length, n, 'five polls with the same board: not one more call on the context');
  assert.equal(h.pending(), false);
});

test('new data lands at once: one frame, no flight, no deferral', () => {
  const h = harness();
  render3d(h.canvas, cells, SPACE);
  const n = h.ops.length;
  harness.t += 1000;
  const r = render3d(h.canvas, cells2, SPACE);
  assert.equal(r.settled, true, 'no transition to wait for');
  assert.equal(r.deferred, undefined, 'nothing was parked behind an effect');
  assert.ok(h.ops.length > n, 'it painted');
  assert.equal(h.pending(), false, 'and parked again');
  const n2 = h.ops.length;
  assert.equal(h.pump(), 0);
  assert.equal(h.ops.length, n2);
});

test('an idle effect cannot be started on it', () => {
  const h = harness();
  render3d(h.canvas, cells, SPACE);
  assert.equal(triggerIdle(h.canvas, 'ripple'), false);
  assert.equal(h.pending(), false, 'and nothing woke the loop');
});

test('hover: the tile lights in one frame and the board parks again; hit test as before', () => {
  const h = harness();
  render3d(h.canvas, cells, SPACE);
  // find a point over a block by walking the panel
  let hit = null, x = 0, y = 0;
  for (y = 40; y < 640 && !hit; y += 40) for (x = 40; x < 640 && !hit; x += 40) hit = hitTest(h.canvas, x, y);
  assert.ok(hit, 'some point of a 640px panel is over a block');
  const n = h.ops.length;
  h.canvas.__fire('pointermove', { clientX: x, clientY: y });
  assert.equal(h.pending(), true, 'a hover asks for exactly one frame');
  assert.equal(h.pump(), 1, 'one frame');
  assert.ok(h.ops.length > n, 'which painted');
  assert.equal(h.pending(), false, 'and there is no fade to run: the board is parked');
  // moving off: one frame more, then parked -- no 600 ms fade-out
  h.canvas.__fire('pointermove', { clientX: 100000, clientY: 100000 });
  assert.equal(h.pump(), 1);
  assert.equal(h.pending(), false);
});

test('a switch between renderers on the same tiles repaints without a flight, and back', () => {
  const h = harness();
  render3d(h.canvas, cells, { ...SPACE, renderer: 'software', idleFx: false, stars: false });
  h.pump(400);
  assert.equal(rendererIn(h.canvas), 'software');
  const n = h.ops.length;
  const r = render3d(h.canvas, cells, SPACE);
  assert.equal(r.settled, true);
  assert.equal(rendererIn(h.canvas), '2.5d');
  assert.ok(h.ops.length > n, 'a look change repaints at once');
  assert.equal(h.pending(), false);
  render3d(h.canvas, cells, { ...SPACE, renderer: 'software', idleFx: false, stars: false });
  assert.equal(rendererIn(h.canvas), 'software');
});

// the Markets board: a laid-out board with axes and a price line, the way markets.js hands it over
const MARKET = {
  renderer: '2.5d', space: true, floorLine: true, stars: true, idleFx: true, gridW: 12, gridH: 8,
  oblique: { ox: 0.13, oy: 0.32, headroom: 12, anchor: 'bottom', flight: 120 },
  axes: { y: 0, zTop: 8, z: [{ z: 2, label: '100 000' }, { z: 5, label: '100 500', strong: true, color: 'rgba(46,204,143,1)' }], x: [{ x: 2, label: '12:00' }, { x: 8, label: '18:00' }],
    line: [{ x: 0.5, z: 1 }, { x: 1.5, z: 2 }, { x: 2.5, z: 1.5 }, { x: 3.5, z: 3 }, { x: 4.5, z: 2.5 }] },
};
const CANDLES = [0, 1, 2, 3, 4].map((i) => ({ txid: `c${i}`, x: i, y: 3, s: 1, tall: 2 + (i % 3), floor: 1 + i * 0.5, color: i % 2 ? '#1fc98a' : '#ef4d5e', label: `bar ${i}` }));

test('the Markets board: the line is one stroke, the tags are written, and it costs far less than the 3D frame', () => {
  const flat = harness();
  board3d(flat.canvas, CANDLES, MARKET);
  assert.equal(flat.pending(), false, 'parked: no sky, no effect, no flight');
  assert.ok(flat.ops.filter((o) => o === 'fillText').length >= 4, 'the price tags and the hours are written');
  assert.ok(flat.ops.includes('bezierCurveTo'), 'the price line is the same curve');
  for (const f of FORBIDDEN) assert.ok(!flat.ops.includes(f), `no ${f}`);
  const soft = harness();
  board3d(soft.canvas, CANDLES, { ...MARKET, renderer: 'software' });
  soft.pump(1);
  const strokes = (h) => h.ops.filter((o) => o === 'stroke').length;
  assert.ok(strokes(flat) < strokes(soft) / 2, `far fewer strokes: ${strokes(flat)} against ${strokes(soft)}`);
  assert.ok(flat.ops.length < soft.ops.length / 2, `far fewer calls a frame: ${flat.ops.length} against ${soft.ops.length}`);
  const hit = hitTest(flat.canvas, 320, 400);
  assert.ok(hit === null || typeof hit.txid === 'string', 'the hit test runs on the flat frame');
});

test('the frame-rate readout names it', () => {
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.ok(/flat \? '2\.5D' : 'Software'/.test(src));
});

test('the docs and the changelog name the renderer', () => {
  const guide = readFileSync(new URL('../docs/USER-GUIDE.md', import.meta.url), 'utf8');
  assert.ok(/\*\*2\.5D\*\*/.test(guide), 'the user guide describes 2.5D beside Software and WebGL');
  const log = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(/2\.5D/.test(log.split('## [0.1')[0]), 'the Unreleased section carries it');
});

// THE PAGE HOLDS STILL WITH IT (operator, with 2.5D live: "still eating 50% of gpu on mac"). Measured on the
// live monitor with every board parked: the pages carrying an infinite CSS animation composited ~60 frames
// a second, the others under one. A running animation is a frame every vsync on the graphics card.
test('2.5D stamps the page still, and the stylesheet stops every infinite animation under it', async () => {
  const { applyTheme } = await import('../public/js/theme.js');
  const root = () => { const attrs = new Map(), props = new Map(); return { attrs, props, style: { setProperty: (k, v) => props.set(k, v) }, setAttribute: (k, v) => attrs.set(k, v) }; };
  const win = { matchMedia: () => ({ matches: false }) };
  let r = root(); applyTheme(normalise({ appearance: { renderer: '2.5d' } }), { root: r, win });
  assert.equal(r.attrs.get('data-motion'), 'still');
  r = root(); applyTheme(normalise({ appearance: { renderer: 'software' } }), { root: r, win });
  assert.equal(r.attrs.get('data-motion'), 'live');
  r = root(); applyTheme(normalise(null), { root: r, win });
  assert.equal(r.attrs.get('data-motion'), 'live', 'the shipped page moves');
  // every selector whose rule runs an infinite animation is named in the still block
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const still = css.match(/html\[data-motion="still"\][^}]*\{ animation: none \}/)?.[0];
  assert.ok(still, 'the still block exists');
  const chunks = css.split('}');
  const infinite = [];
  for (const ch of chunks) {
    const i = ch.indexOf('{'); if (i < 0) continue;
    const sel = ch.slice(0, i).trim(), body = ch.slice(i + 1);
    if (/animation:[^;]*\binfinite\b/.test(body) && !sel.startsWith('@') && !sel.startsWith('html[data-motion')) for (const s of sel.split(',')) infinite.push(s.trim());
  }
  assert.ok(infinite.length >= 6, `the stylesheet's infinite animations were found (${infinite.length})`);
  for (const s of infinite) assert.ok(still.includes(`html[data-motion="still"] ${s}`), `the still block names ${s}`);
});

// A GAME'S BOARD PAINTS ON EVERY CALL (operator, 2026-09-28: "scorched yard doesn't work in 2.5d mode"). Its
// tiles can be the same frame after frame while its blasts and fires -- drawn through `overlay` at the call's
// own instant -- are not, so the same-data shortcut above must not apply to a still board.
test('a still board (a game) repaints on every call under 2.5D, and its overlay runs each time', () => {
  const h = harness();
  let overlays = 0;
  const tiles = [{ txid: 'tank', x: 3, y: 2, s: 1, tall: 1, color: '#33cc99' }, { txid: 'shell', x: 5, y: 4, s: 1, sphere: true, color: '#ffffff' }];
  const opts = { renderer: '2.5d', gridW: 12, gridH: 8, still: true, hover: false, stars: false, idleFx: false, background: 'rgba(0,0,0,0)', grid: false, space: true, overlay: () => { overlays++; } };
  board3d(h.canvas, tiles, opts);
  assert.equal(overlays, 1);
  assert.ok(h.ops.filter((o) => o === 'fill').length >= 4, 'the tank and the ball are drawn');
  const n = h.ops.length;
  for (let i = 0; i < 3; i++) { harness.t += 16; board3d(h.canvas, tiles, opts); }
  assert.equal(overlays, 4, 'the same tiles again: the overlay still ran, once a call');
  assert.ok(h.ops.length > n, 'and the board was painted again');
  assert.equal(h.pending(), false, 'and still nothing runs between calls');
});
