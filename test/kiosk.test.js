// THE KIOSK IS PART OF THE TEST CYCLE (operator, 2026-09-15: "add test suites for kiosk mode as
// part of the test cycle" -- after the supernova's white-out filled the Kiosk's Markets panel,
// which nothing here had ever rendered at that size). Three things the Kiosk needs of an effect:
// it plays through the frame loop on a panel a quarter the size of its own page without
// throwing; its size is bounded by the board's width, so a small panel is never covered; and the
// soft fills it is built from add up to the opacity they claim, so nothing goes solid white.
import test from 'node:test';
import assert from 'node:assert/strict';
import { board3d, triggerIdle, FX_KINDS, SPACE_FX, MARKET_FX, softStops, boundedRadius } from '../public/js/details3d.js';

// the Kiosk's two panels, as the shots measured them: Markets 778x587, Block space 778x610
const KIOSK = { markets: [778, 587], space: [778, 610] };

function harness(w, h) {
  let rafPending = null; let T = 0;
  const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, perf: globalThis.performance, win: globalThis.window, mm: globalThis.matchMedia, st: globalThis.setTimeout };
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => T };
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 42; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  globalThis.document = globalThis.document ?? {};
  globalThis.setTimeout = () => 1;
  const ctx = new Proxy({ canvas: {}, lineWidth: 1 }, {
    get(tg, k) { if (k in tg) return tg[k]; if (k === 'measureText') return (s) => ({ width: String(s).length * 6 }); if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} }); return () => tg.canvas; },
    set(tg, k, v) { tg[k] = v; return true; },
  });
  const canvas = { clientWidth: w, clientHeight: h, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: () => {}, setPointerCapture: () => {}, isConnected: true };
  const step = (t) => { const fn = rafPending; rafPending = null; T = t; if (fn) fn(t); };
  const restore = () => { globalThis.requestAnimationFrame = saved.raf; globalThis.cancelAnimationFrame = saved.caf; globalThis.performance = saved.perf; globalThis.window = saved.win; globalThis.matchMedia = saved.mm; globalThis.setTimeout = saved.st; };
  return { canvas, step, restore, setT: (t) => { T = t; } };
}

test('KIOSK: every Markets effect plays through the frame loop on the Kiosk-sized candle board', () => {
  const h = harness(...KIOSK.markets);
  try {
    const tiles = [], line = [];
    for (let i = 0; i < 24; i++) { const z0 = 10 + 6 * Math.sin(i / 4); tiles.push({ txid: `b:${i}`, x: i * 2 + 0.3, y: 3, s: 1.4, floor: z0, tall: 2, color: '#3c9' }); tiles.push({ txid: `v:${i}`, x: i * 2 + 0.3, y: 0.5, s: 1.4, tall: 1, color: '#3c9' }); line.push({ x: i * 2 + 1, z: z0 + 1 }); }
    board3d(h.canvas, tiles, { gridW: 48, gridH: 8, axes: { y: 3.7, zTop: 40, z: [], x: [], line }, space: true, stars: false, idleFx: true, oblique: { ox: 0.07, oy: 0.95, dy: 0.3, headroom: 36, flight: 10, anchor: 'bottom' }, transition: { rise: 0, travel: 1, drop: 0 } });
    for (let i = 1; i <= 30; i++) h.step(i * 16);
    for (const kind of MARKET_FX) {
      const t0 = 5000 + MARKET_FX.indexOf(kind) * 40000;
      h.setT(t0);
      assert.equal(triggerIdle(h.canvas, kind), true, `${kind} triggers on the Kiosk board`);
      for (let i = 1; i <= 40; i++) assert.doesNotThrow(() => h.step(t0 + i * 700), `${kind}: frame ${i} on the Kiosk's Markets panel`);
    }
  } finally { h.restore(); }
});

test('KIOSK: every Block space effect plays through the frame loop on the Kiosk-sized block board', () => {
  const h = harness(...KIOSK.space);
  try {
    const tiles = [];
    for (let x = 0; x < 44; x += 2) for (let y = 0; y < 44; y += 2) tiles.push({ txid: `t${x}_${y}`, x, y, s: 2, tall: 1 + ((x * y) % 5), rate: x + y, color: '#3c9' });
    board3d(h.canvas, tiles, { gridW: 44, gridH: 44, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } });
    for (let i = 1; i <= 30; i++) h.step(i * 16);
    for (const kind of SPACE_FX) {
      const t0 = 5000 + SPACE_FX.indexOf(kind) * 40000;
      h.setT(t0);
      assert.equal(triggerIdle(h.canvas, kind), true, `${kind} triggers on the Kiosk block board`);
      for (let i = 1; i <= 30; i++) assert.doesNotThrow(() => h.step(t0 + i * 700), `${kind}: frame ${i} on the Kiosk's Block space panel`);
    }
  } finally { h.restore(); }
});

test('KIOSK: the big effects are bounded by the board, so a small panel is never covered', () => {
  // the caps the supernova, the black hole and the fireworks use, with the shares they use
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (${a} vs ${b})`);
  near(boundedRadius(3.4, 0.07, 48), 3.36, 'a 24 h board: the share binds just under the unit size');
  near(boundedRadius(3.4, 0.07, 336), 3.4, 'a 7 d board: the unit size binds');
  near(boundedRadius(6, 0.09, 30), 2.7, 'a small board: the share binds hard');
  for (const gridW of [24, 48, 96, 336]) {
    assert.ok(boundedRadius(3.4, 0.07, gridW) * 4.7 <= gridW * 0.33 + 1e-9, `supernova at its largest shell (4.7 R0) stays within a third of a ${gridW}-unit board`);
    assert.ok(boundedRadius(2.3, 0.047, gridW) * 5 <= gridW * 0.24 + 1e-9, `the black hole's disk (5 horizons) stays within a quarter of a ${gridW}-unit board`);
    assert.ok(boundedRadius(4.5, 0.09, gridW) * 1.3 * 2 <= gridW * 0.24 + 1e-9, `a firework's largest shell stays within a quarter of a ${gridW}-unit board`);
  }
  // every kind exists on one list or the other, so nothing escapes these checks by being unlisted
  assert.deepEqual([...new Set([...SPACE_FX, ...MARKET_FX])].sort(), [...FX_KINDS].sort());
});

test('KIOSK: softStops\' nested discs add up to the stop\'s opacity, never to solid', () => {
  // (2026-09-15: "far too much solid white" -- each disc carried the whole alpha, and a point at
  // radius t lies under every disc of radius >= t, so 220 discs at 0.08 stacked to opaque)
  const fills = [];
  let fillStyle = '';
  const ctx = { beginPath() {}, fill() { fills.push({ r: this._r, a: Number(String(fillStyle).match(/,([^,]+)\)$/)[1]) }); }, arc(x, y, r) { this._r = r; }, set fillStyle(v) { fillStyle = v; }, get fillStyle() { return fillStyle; } };
  const stops = [[0, 'rgba(255,255,255,0.4)'], [0.5, 'rgba(255,255,255,0.2)'], [1, 'rgba(255,255,255,0)']];
  softStops(ctx, 0, 0, 300, stops);
  const opacityAt = (t) => 1 - fills.filter((f) => f.r >= 300 * t - 1e-9).reduce((p, f) => p * (1 - f.a), 1);
  assert.ok(Math.abs(opacityAt(0.005) - 0.4) < 0.02, `at the centre the discs stack to the stop's 0.4, not to solid (${opacityAt(0.005).toFixed(3)})`);
  assert.ok(Math.abs(opacityAt(0.5) - 0.2) < 0.02, `halfway out they stack to 0.2 (${opacityAt(0.5).toFixed(3)})`);
  assert.ok(opacityAt(0.99) < 0.03, `at the rim, nearly nothing (${opacityAt(0.99).toFixed(3)})`);
  assert.ok(fills.length >= 16, 'and there are enough of them to be smooth');
});
