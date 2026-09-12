// A STILL BOARD STILL HAS A SKY (2026-09-12, operator: "why can't we get the galaxy smoothly
// animating in the background for tetrust?").
//
// Measured on the live page before this: the Tetrust sky canvas repainted ZERO times in three
// seconds. It was not slow, it was frozen. `still` -- which a caller sets to say "land the tiles
// where they are, no flight" -- also returned out of render3d before requestAnimationFrame, and
// the wake that revives a parked loop was gated behind `!still` as well. So a board with a star
// field and no choreography drew its stars once and never again, and the galaxy only moved when
// something else happened to call board3d.
//
// The rule this pins: `still` governs the TILES. Stars are motion in their own right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { board3d } from '../public/js/details3d.js';

function harness() {
  const raf = [];
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => 0 };
  globalThis.requestAnimationFrame = (fn) => { raf.push(fn); return raf.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = globalThis.document ?? {};
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) { if (k === 'canvas') return t.canvas; if (k === 'measureText') return () => ({ width: 6 }); return () => t.canvas; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = { clientWidth: 400, clientHeight: 400, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() {}, setPointerCapture() {}, isConnected: true, offsetParent: {} };
  return { canvas, raf };
}
const BASE = { gridW: 8, gridH: 8, transition: { rise: 0, travel: 1, drop: 0 } };

test('a still board with a star field keeps its animation loop: the galaxy turns', () => {
  const h = harness();
  board3d(h.canvas, [], { ...BASE, still: true, space: false, grid: false, stars: true, galaxy: true });
  assert.ok(h.raf.length > 0, 'the loop was started for the stars, not parked');
});

test('a still board with no sky still parks: a fixed picture is not worth a heater', () => {
  const h = harness();
  board3d(h.canvas, [{ txid: 'a', x: 0, y: 0, s: 4, color: '#33cc99' }], { ...BASE, still: true, stars: false });
  assert.equal(h.raf.length, 0, 'nothing moves, so nothing repaints');
});

test('drawing a still sky again keeps the running loop instead of restarting it', () => {
  // the page calls board3d on every render; the cheap unchanged path used to be closed to still
  // boards, so each call fell through to a full replan
  const h = harness();
  const opts = { ...BASE, still: true, space: false, grid: false, stars: true, galaxy: true };
  board3d(h.canvas, [], opts);
  const started = h.raf.length;
  assert.ok(started > 0);
  const again = board3d(h.canvas, [], opts);
  assert.equal(again.replanned, false, 'the same sky is not re-planned');
  assert.equal(h.raf.length, started, 'and no second loop is started alongside the first');
});
