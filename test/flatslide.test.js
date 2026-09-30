// SIMPLE'S SLIDE (public/js/flatslide.js; operator, 2026-09-30: "1s slide with the row wave"). The module
// is pure, so its geometry is held here directly; what it costs in FRAMES is held through the real
// render3d in the second half, with the recording context test/renderer-25d.test.js uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSlide, sampleSlide, easeInOutCubic, SLIDE_MS, WAVE_MS, ENTER_ROWS } from '../public/js/flatslide.js';
import { render3d, board3d, viewerIdle, flatSlideOf } from '../public/js/details3d.js';
import { DEFAULTS, PANEL, normalise } from '../public/js/settings.js';

// a "cube" of one face: a unit square at (x, y), in op space
const sq = (txid, x, y, s = 1, fill = 'rgba(1,2,3,1)') => ({ txid, face: 'top', fill, points: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }] });
const cen = (op) => ({ x: op.points.reduce((n, p) => n + p.x, 0) / op.points.length, y: op.points.reduce((n, p) => n + p.y, 0) / op.points.length });
const byId = (ops, id) => ops.filter((o) => o.txid === id);

test('the slide takes one second, wave included, and eases', () => {
  assert.equal(SLIDE_MS, 1000);
  assert.ok(WAVE_MS > 0 && WAVE_MS < SLIDE_MS);
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  const plan = planSlide([sq('a', 0, 0)], [sq('a', 10, 0)], { now: 500 });
  assert.equal(sampleSlide(plan, 500 + SLIDE_MS - 1).done, false);
  assert.equal(sampleSlide(plan, 500 + SLIDE_MS).done, true);
});

test('a moved tile slides point by point from where it was to where it goes', () => {
  const plan = planSlide([sq('a', 0, 0)], [sq('a', 10, 4)], { now: 0 });
  const at = (t) => cen(byId(sampleSlide(plan, t).ops, 'a')[0]);
  assert.deepEqual(at(0), { x: 0.5, y: 0.5 }, 'it starts where it was');
  const end = at(SLIDE_MS - 0.001);
  assert.ok(Math.abs(end.x - 10.5) < 1e-3 && Math.abs(end.y - 4.5) < 1e-3, 'and ends where it goes');
  const mid = at(SLIDE_MS / 2);
  assert.ok(mid.x > 0.5 && mid.x < 10.5, 'in the plane, on the way');
  // the colour is the settled frame's from the first frame (a recolour is not motion)
  const moved = planSlide([sq('a', 0, 0, 1, 'red')], [sq('a', 1, 0, 1, 'blue')], { now: 0 });
  assert.equal(sampleSlide(moved, 0).ops[0].fill, 'blue');
});

test('the row wave: the bottom row sets off first, the top row WAVE_MS later', () => {
  const rows = new Map([['low', 0], ['high', 10]]);
  const plan = planSlide([sq('low', 0, 0), sq('high', 0, 10)], [sq('low', 5, 0), sq('high', 5, 10)], { rows, gridH: 10, now: 0 });
  const x = (t, id) => cen(byId(sampleSlide(plan, t).ops, id)[0]).x;
  assert.ok(x(WAVE_MS / 2, 'low') > 0.5, 'the bottom row is moving');
  assert.equal(x(WAVE_MS / 2, 'high'), 0.5, 'the top row has not left yet');
  assert.ok(x(WAVE_MS + 50, 'high') > 0.5, 'and follows after the wave');
  assert.ok(Math.abs(x(SLIDE_MS - 0.001, 'high') - 5.5) < 1e-3, 'yet lands inside the second');
});

test('an arrival drops in from above its slot, growing; a departure shrinks away', () => {
  const up = { x: 0, y: -2 };
  const plan = planSlide([sq('old', 0, 0)], [sq('new', 20, 20)], { up, now: 0, gridH: 10 });
  const f0 = sampleSlide(plan, 0).ops;
  const n0 = byId(f0, 'new')[0];
  const c = cen(n0);
  assert.ok(Math.abs(c.x - 20.5) < 1e-9 && Math.abs(c.y - (20.5 + up.y * ENTER_ROWS)) < 1e-9, 'ENTER_ROWS above its place');
  assert.ok(n0.points.every((p) => Math.abs(p.x - c.x) < 1e-9 && Math.abs(p.y - c.y) < 1e-9), 'at no size');
  assert.equal(cen(byId(f0, 'old')[0]).x, 0.5, 'the departure is still whole at the start');
  const late = sampleSlide(plan, SLIDE_MS - 1).ops;
  assert.ok(byId(late, 'old').length === 0 || byId(late, 'old')[0].points.every((p) => Math.abs(p.x - 0.5) < 0.01), 'gone, or a point');
});

test('a tile that did not move is the settled op itself, and a board with nothing moving has no slide', () => {
  const to = [sq('a', 0, 0), sq('b', 3, 0)];
  const plan = planSlide([sq('a', 0, 0), sq('b', 1, 0)], to, { now: 0 });
  assert.ok(sampleSlide(plan, 100).ops.includes(to[0]), 'a holder is not copied');
  assert.equal(planSlide([sq('a', 0, 0)], [sq('a', 0, 0)], { now: 0 }), null);
  assert.equal(planSlide([], [sq('a', 0, 0)]), null, 'nothing on screen: nothing to slide from');
});

test('a running slide can be the start of the next one: its points are copied, not shared', () => {
  const p1 = planSlide([sq('a', 0, 0)], [sq('a', 10, 0)], { now: 0 });
  const mid = sampleSlide(p1, SLIDE_MS / 2).ops;
  const x = cen(mid[0]).x;
  const p2 = planSlide(mid, [sq('a', 0, 0)], { now: SLIDE_MS / 2 });
  sampleSlide(p1, SLIDE_MS - 1);                  // the old slide keeps writing its own points
  assert.equal(cen(sampleSlide(p2, SLIDE_MS / 2).ops[0]).x, x, 'the new one starts where the old one was');
});

test('paint order is the old frame\'s at the start and the new frame\'s at the end', () => {
  const from = [sq('a', 0, 0), sq('b', 1, 0)];
  const to = [sq('b', 5, 0), sq('a', 6, 0)];
  const plan = planSlide(from, to, { now: 0 });
  assert.deepEqual(sampleSlide(plan, 0).ops.map((o) => o.txid), ['a', 'b']);
  assert.deepEqual(sampleSlide(plan, SLIDE_MS - 1).ops.map((o) => o.txid), ['b', 'a']);
});

test('the setting: Slide ships, Off is offered, only the Simple renderer honours it', () => {
  assert.equal(DEFAULTS.appearance.flatSlide, 'slide');
  const row = PANEL.find((g) => g.group === 'appearance').rows.find((r) => r.key === 'flatSlide');
  assert.deepEqual(row.options.map((o) => o[0]), ['slide', 'off']);
  assert.equal(row.dimWhen({ appearance: { renderer: 'software' } }), true);
  assert.equal(row.dimWhen({ appearance: { renderer: '2.5d' } }), false);
  assert.equal(normalise({ appearance: { flatSlide: 'off' } }).appearance.flatSlide, 'off');
  assert.equal(normalise({ appearance: { flatSlide: 'wobble' } }).appearance.flatSlide, 'slide');
  assert.equal(flatSlideOf({ flatSlide: 'off' }), 'off');
  assert.equal(flatSlideOf({ flatSlide: 'slide' }), 'slide');
});

// ---- through render3d: what the slide costs in frames ----

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
      return (...a) => { ops.push(String(k)); return t.canvas; };
    },
    set(t, k, v) { ops.push('set:' + k + '=' + String(v).slice(0, 24)); t[k] = v; return true; },
  });
  const canvas = {
    clientWidth: 640, clientHeight: 640, width: 0, height: 0, style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 640 }),
    addEventListener: () => {}, setPointerCapture: () => {},
  };
  ctx.canvas = canvas;
  const paints = () => ops.filter((o) => o === 'clearRect').length;
  return { canvas, ops, paints, pump: (n = 200) => { let g = 0; while (rafPending && g++ < n) { const fn = rafPending; rafPending = null; harness.t += 16; fn(harness.t); } return g; }, pending: () => !!rafPending };
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
const SIMPLE = { renderer: '2.5d', stars: true, galaxy: true, idleFx: true, flatSky: 'off', flatSlide: 'slide' };

test('render3d: new data slides for one second, then the board parks and paints nothing', () => {
  const h = harness();
  render3d(h.canvas, cells, SIMPLE);
  assert.equal(h.pending(), false, 'a first paint does not slide');
  harness.t += 30000;
  const r = render3d(h.canvas, cells2, SIMPLE);
  assert.equal(r.settled, false, 'a slide is running');
  assert.equal(h.pending(), true, 'and asked for frames');
  assert.equal(viewerIdle(h.canvas), false, 'the refresh button waits for it');
  const before = h.paints();
  const frames = h.pump();
  assert.ok(frames >= SLIDE_MS / 16 - 2 && frames <= SLIDE_MS / 16 + 2, `about a second of frames (${frames})`);
  assert.equal(h.paints() - before, frames, 'each one painted');
  assert.equal(h.pending(), false, 'then parked');
  assert.equal(viewerIdle(h.canvas), true);
  const n = h.ops.length;
  for (let i = 0; i < 3; i++) { harness.t += 1000; render3d(h.canvas, cells2, SIMPLE); }
  assert.equal(h.ops.length, n, 'the same data again: not one call on the context');
  assert.equal(h.pump(), 0);
});

test('render3d: the frames are plain fills, like every Simple frame', () => {
  const h = harness();
  render3d(h.canvas, cells, SIMPLE);
  harness.t += 30000;
  render3d(h.canvas, cells2, SIMPLE);
  const n = h.ops.length;
  h.pump(20);
  const mid = h.ops.slice(n);
  for (const f of ['clip', 'createRadialGradient', 'createLinearGradient', 'createPattern', 'drawImage']) assert.ok(!mid.includes(f), `no ${f}`);
  assert.ok(!mid.some((o) => o.startsWith('set:globalAlpha') || o.startsWith('set:globalCompositeOperation')));
});

test('render3d: no slide with the setting off, under reduced motion, on a laid board, or on a look change', () => {
  let h = harness();
  const OFF = { ...SIMPLE, flatSlide: 'off' };
  render3d(h.canvas, cells, OFF); harness.t += 30000; render3d(h.canvas, cells2, OFF);
  assert.equal(h.pending(), false, 'off: lands at once');

  h = harness();
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.window.matchMedia = globalThis.matchMedia;
  render3d(h.canvas, cells, SIMPLE); harness.t += 30000; render3d(h.canvas, cells2, SIMPLE);
  assert.equal(h.pending(), false, 'reduced motion: lands at once');

  h = harness();
  const laid = (x) => [{ txid: 'k1', x, y: 0, s: 1, color: '#ff0000' }, { txid: 'k2', x: 3, y: 0, s: 1, color: '#00ff00' }];
  board3d(h.canvas, laid(0), { ...SIMPLE, gridW: 8, gridH: 8 }); harness.t += 30000; board3d(h.canvas, laid(1), { ...SIMPLE, gridW: 8, gridH: 8 });
  assert.equal(h.pending(), false, 'a laid-out board (Markets) lands at once: its axes would not slide with it');

  h = harness();
  render3d(h.canvas, cells, SIMPLE); harness.t += 30000; render3d(h.canvas, cells, { ...SIMPLE, edges: false });
  assert.equal(h.pending(), false, 'a look change on the same tiles repaints once');
});

test('render3d: new data mid-slide starts the next slide from where the tiles are', () => {
  const h = harness();
  render3d(h.canvas, cells, SIMPLE);
  harness.t += 30000;
  render3d(h.canvas, cells2, SIMPLE);
  h.pump(20);
  const r = render3d(h.canvas, cells, SIMPLE);
  assert.equal(r.deferred, undefined, 'nothing is parked behind the running slide');
  const frames = h.pump();
  assert.ok(frames <= SLIDE_MS / 16 + 2, `one more second at most (${frames})`);
  assert.equal(h.pending(), false);
});
