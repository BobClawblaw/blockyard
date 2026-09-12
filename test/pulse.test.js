// THE PULSE RIDES THE PRICE LINE (operator, 2026-09-12: "the energy pulse effect needs to run
// across the yellow line, not through space on an invisible grid ... leaving a electric blue tint
// on the yellow line that starts fading back to normal yellow after 3 seconds").
//
// Read through a recording canvas, because the first live capture showed the line plain yellow
// with the effect running: whether the effect state reaches the stroke is exactly the kind of
// thing a screenshot cannot explain and this can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { board3d, triggerIdle } from '../public/js/details3d.js';

function harness() {
  let rafPending = null;
  const ops = [];
  harness.t = 0;
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => harness.t ?? 0 };
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 42; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  globalThis.document = globalThis.document ?? {};
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      return (...a) => { ops.push(String(k)); return t.canvas; };
    },
    set(t, k, v) { ops.push('set:' + k + '=' + String(v).slice(0, 32)); t[k] = v; return true; },
  });
  const canvas = { clientWidth: 900, clientHeight: 500, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: () => {}, setPointerCapture: () => {} };
  // drive the loop at a clock of OUR choosing: the shared harness resets to 16, 32... on every
  // pump, which would put a frame BEHIND an effect started later and make fxNow return null
  const step = (t) => { const fn = rafPending; rafPending = null; harness.t = t; if (fn) fn(t); return !!fn; };
  return { canvas, ops, step, pending: () => !!rafPending };
}

const LINE = [{ x: 1, z: 2 }, { x: 3, z: 4 }, { x: 5, z: 3 }, { x: 7, z: 5 }];
const AXES = { y: 1, zTop: 6, z: [], x: [], line: LINE };
const TILES = [{ txid: 'c1', x: 0, y: 0, s: 2, tall: 2, color: '#33cc99' }, { txid: 'c2', x: 4, y: 0, s: 2, tall: 3, color: '#cc3333' }];

test('a board with a price line draws it plain yellow at rest', () => {
  const h = harness();
  board3d(h.canvas, TILES, { axes: AXES, gridW: 8, gridH: 8, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } });
  for (let i = 1; i <= 6; i++) h.step(i * 16);
  assert.ok(h.ops.some((o) => o.startsWith('set:strokeStyle=rgba(255,236,70,0.78)')), 'the yellow tube is stroked');
  assert.ok(!h.ops.some((o) => o.startsWith('set:strokeStyle=rgba(110,200,255')), 'and nothing is blue before any pulse');
});

test('triggering the pulse tints the line electric blue behind the head', () => {
  const h = harness();
  board3d(h.canvas, TILES, { axes: AXES, gridW: 8, gridH: 8, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } });
  for (let i = 1; i <= 6; i++) h.step(i * 16);
  const before = h.ops.length;
  harness.t = 1000;                                       // the effect starts here...
  assert.equal(triggerIdle(h.canvas, 'pulse'), true, 'the canvas is known to the renderer and pulse is a kind');
  assert.ok(h.pending(), 'triggering woke the loop');
  h.step(1400);                                           // ...and this frame is 400 ms into it
  const after = h.ops.slice(before);
  // a TAIL, not a hold (operator: "it should fade out blue and fade back into yellow"): the segment
  // just behind the head is bluer than yellow, and the blend is a gradient, so the exact head
  // colour is not what to look for -- a stroke whose blue channel beats its red is
  const tube = after.filter((o) => o.startsWith('set:strokeStyle=rgba(') && o.endsWith(',0.78)'))
    .map((o) => o.match(/rgba\((\d+),(\d+),(\d+),/)).filter(Boolean).map((m) => m.slice(1, 4).map(Number));
  assert.ok(tube.length >= 3, `the tube is stroked per segment (${tube.length})`);
  assert.ok(tube.some(([r, , b]) => b > r), `a segment behind the head is tinted blue (${tube.map((c) => c.join('/')).join(' ')})`);
  assert.ok(tube.some(([r, , b]) => r > b), 'and a segment ahead of it is still yellow: the tint is a tail, not the whole line');
  assert.ok(after.some((o) => o.startsWith('set:fillStyle=rgba(235,250,255')), 'and the head bead is drawn');
});
