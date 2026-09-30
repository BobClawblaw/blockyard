// THE RETAINED LAYER UNDER AN EFFECT (2026-09-30; operator: "build the retained layer for unmoved tiles"). While an
// effect that only tints or lights cubes plays over a board at rest, the board drawn is the RESTING one -- kept on the
// card, or in Software's layer -- and only the cubes the effect touches are drawn over it. Measured on the Detailed
// board at 2560x1300 on WebGL (scripts/gl-compare.mjs --dense): rain 54 -> 14 ms a frame, xray 31 -> 14, radar
// 56 -> 40. An effect that lifts, hides, shrinks or pulls a cube, or draws a ring into the grid under them, is drawn
// whole, as before -- a resting copy under a lifted cube would show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render3d, triggerIdle } from '../public/js/details3d.js';
import { buildScene, FX_NONE } from '../public/js/blockscene3d.js';

function stage() {
  let now = 1000, raf = null;
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (fn) => { raf = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { raf = null; };
  const live = [];
  const ctxOf = (sink) => new Proxy({ canvas: {} }, { get(t, k) { if (k === 'canvas') return t.canvas; if (k === 'measureText') return () => ({ width: 10 }); if (k === 'drawImage') return (src) => sink.push(`drawImage:${src?.__id ?? '?'}`); return () => { sink.push(String(k)); return t.canvas; }; }, set(t, k, v) { t[k] = v; return true; } });
  const made = [];
  globalThis.document = { hidden: false, createElement: () => { const c = { __id: `off${made.length}`, width: 0, height: 0, ops: [] }; c.getContext = () => ctxOf(c.ops); made.push(c); return c; } };
  const canvas = { clientWidth: 600, clientHeight: 400, width: 0, height: 0, style: {}, isConnected: true, offsetParent: {}, addEventListener: () => {}, parentElement: { querySelector: () => null, querySelectorAll: () => [] } };
  const c2 = ctxOf(live);
  canvas.getContext = () => c2;
  return { canvas, live, pump: (n) => { for (let i = 0; i < n && raf; i++) { const f = raf; raf = null; now += 50; f(now); } } };
}
const dense = Array.from({ length: 900 }, (_, i) => ({ txid: `d${i}`.padEnd(64, 'x'), vbytes: 150 + ((i * 7919) % 1300), rate: 60 - i * 0.05 }));
const OPTS = { resolution: 96, slab: 1.2, order: 'diagonal', gridStep: 8, dither: true, idleFx: false, renderer: 'software', stars: true, oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 } };
const fillsPerFrame = (ops) => ops.join('\n').split('clearRect').slice(1).map((f) => f.split('\n').filter((o) => o === 'fill').length);

test('buildScene reports which cubes an effect touches, and whether any is lifted or hidden', () => {
  const tiles = [{ txid: 'a', x: 0, y: 0, s: 1, color: '#33aa66' }, { txid: 'b', x: 5, y: 5, s: 1, color: '#33aa66' }];
  const o = { oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, order: 'diagonal', unit: 6, zUnit: 6 };
  const calm = buildScene(tiles, o);
  assert.equal(calm.touched.size, 0);
  assert.equal(calm.liveOnly, false);
  assert.ok(FX_NONE);
});

test('under a tint-only effect the resting board is kept and only the touched cubes are drawn over it (rain; not the see-through x-ray)', () => {
  const s = stage();
  render3d(s.canvas, dense, OPTS);
  s.pump(10);                                          // at rest: the board goes into Software's kept layer
  const restFills = Math.max(...fillsPerFrame(s.live));
  assert.ok(restFills > 900, `a full board is ${restFills} fills`);
  assert.equal(triggerIdle(s.canvas, 'rain'), true);
  const at = s.live.length;
  s.pump(40);
  const during = fillsPerFrame(s.live.slice(at)).filter((n) => n > 0);
  assert.ok(during.length > 10, 'the effect drew frames');
  const most = during.sort((a, b) => a - b)[Math.floor(during.length / 2)];
  assert.ok(most < restFills / 3, `a typical rain frame fills ${most} faces, not the board's ${restFills}`);
  assert.ok(s.live.slice(at).some((o) => o.startsWith('drawImage:off')), 'the kept layer is blitted under them');
});

test('an effect that lifts cubes draws the whole board, as before', () => {
  const s = stage();
  render3d(s.canvas, dense, OPTS);
  s.pump(10);
  assert.equal(triggerIdle(s.canvas, 'cascade'), true);
  const at = s.live.length;
  s.pump(40);
  const during = fillsPerFrame(s.live.slice(at)).filter((n) => n > 0);
  assert.ok(during.some((n) => n > 900), 'a lifted cube needs the board drawn live around it');
});

test('a see-through effect (the x-ray) is drawn whole: its cubes over their resting copies would come out solid', () => {
  const s = stage();
  render3d(s.canvas, dense, OPTS);
  s.pump(10);
  assert.equal(triggerIdle(s.canvas, 'xray'), true);
  const at = s.live.length;
  s.pump(40);
  const during = fillsPerFrame(s.live.slice(at)).filter((n) => n > 0);
  assert.ok(during.some((n) => n > 900), 'drawn live');
});

test('a Detailed flight is drawn over a kept board of the tiles that do not move', () => {
  const s = stage();
  render3d(s.canvas, dense, OPTS);
  s.pump(10);
  const restFills = Math.max(...fillsPerFrame(s.live));
  // a small update, as the live pool makes them: a few leave, a few cheap ones arrive at the top (a rich arrival that
  // would sit above cheaper ones trips the order re-sort, a whole re-pack -- that flight is every tile)
  const next = dense.slice(0, -12).concat(Array.from({ length: 8 }, (_, i) => ({ txid: `n${i}`.padEnd(64, 'x'), vbytes: 400, rate: 5 })));
  render3d(s.canvas, next, OPTS);
  const at = s.live.length;
  s.pump(30);
  const during = fillsPerFrame(s.live.slice(at)).filter((n) => n > 0);
  assert.ok(during.length > 10, `it animates (${during.length} frames)`);
  const most = during.sort((a, b) => a - b)[Math.floor(during.length / 2)];
  assert.ok(most < restFills / 3, `a typical flight frame fills ${most} faces, not the board's ${restFills}`);
});
