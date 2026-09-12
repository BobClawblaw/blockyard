// THE CHARGE TRAIL ON THE BOARD (operator, 2026-09-12: "We need the block space energy effect
// also emit a blue line and dust trail just like the markets view"). Read through a recording
// canvas: with a light cycle or the lightning ball running, the frame carries the pulse's blue
// puffs, its electric tube, and its motes -- and at rest it carries none of them.
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
      return () => { ops.push(String(k)); return t.canvas; };
    },
    set(t, k, v) { ops.push('set:' + k + '=' + String(v).slice(0, 32)); t[k] = v; return true; },
  });
  const canvas = { clientWidth: 900, clientHeight: 900, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: () => {}, setPointerCapture: () => {} };
  const step = (t) => { const fn = rafPending; rafPending = null; harness.t = t; if (fn) fn(t); return !!fn; };
  return { canvas, ops, step, pending: () => !!rafPending };
}
const TILES = [];
for (let y = 0; y < 12; y += 2) for (let x = 0; x < 12; x += 2) TILES.push({ txid: `c${x}_${y}`, x, y, s: 2, tall: 1, color: '#33cc99' });
const PUFF = 'set:fillStyle=rgba(70,130,255,';
const TUBE = 'set:strokeStyle=rgba(110,200,255,';
const MOTE = 'set:fillStyle=rgba(200,236,255,';

function carries(kind) {
    const h = harness();
    board3d(h.canvas, TILES, { gridW: 12, gridH: 12, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } });
    for (let i = 1; i <= 6; i++) h.step(i * 16);
    const rest = h.ops.length;
    assert.ok(!h.ops.some((o) => o.startsWith(PUFF)), 'no charge at rest');
    harness.t = 1000;
    assert.equal(triggerIdle(h.canvas, kind), true);
    let seen = { puff: 0, tube: 0, mote: 0 };
    for (let i = 1; i <= 40; i++) {
      const before = h.ops.length;
      h.step(1000 + i * 60);
      const frame = h.ops.slice(before);
      seen.puff += frame.filter((o) => o.startsWith(PUFF)).length;
      seen.tube += frame.filter((o) => o.startsWith(TUBE)).length;
      seen.mote += frame.filter((o) => o.startsWith(MOTE)).length;
    }
    void rest;
    assert.ok(seen.puff > 20, `puffs: ${seen.puff}`);
    assert.ok(seen.tube > 5, `tube: ${seen.tube}`);
    assert.ok(seen.mote > 20, `motes: ${seen.mote}`);
}

// one test each, spelled out: the documented count is scanned from the source
test('the light cycle carries the charge: blue puffs behind it, an electric tube, a spray of motes', () => carries('lightcycle'));
test('the lightning ball carries the charge: blue puffs behind it, an electric tube, a spray of motes', () => carries('ball'));
