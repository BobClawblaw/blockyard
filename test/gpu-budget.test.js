// THE GRAPHICS CARD'S BUDGET ON SOFTWARE AND WEBGL (2026-09-30; operator: "Is there no way to improve the
// performance of our software and webgl modes? They really eat all the GPU up" -- "yes, build all three").
// Three levers, each measured in chromium before it was built (settings.js, the comment above pagePulse):
//   the page's pulses TICK instead of animating (renderer-25d.test.js holds the stylesheet's side),
//   WebGL draws at a capped density (appearance.webglScale),
//   and a board paints at most appearance.frameCap frames a second -- waiting on a TIMER, never asking for
//   an animation frame it will not paint (a frame asked for is a frame the browser composites).
// Driven here on a simulated 120 Hz display: a fake clock, animation frames at every 8.33 ms, real ordering
// of timers against frames.
import './helpers/software-renderer.js';   // first: these draw the full picture, which Simple (shipped) switches off
import test from 'node:test';
import assert from 'node:assert/strict';
import { render3d, frameGapOf, webglScaleOf, SKY_GAP_MS } from '../public/js/details3d.js';
import { DEFAULTS, PANEL, normalise } from '../public/js/settings.js';

function display(hz = 120) {
  const period = 1000 / hz;
  let now = 0, raf = null, rafAsks = 0;
  const timers = [];
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (fn) => { raf = fn; rafAsks++; return 7; };
  globalThis.cancelAnimationFrame = () => { raf = null; };
  globalThis.setTimeout = (fn, ms) => { const h = { at: now + Math.max(0, ms || 0), fn, unref() {} }; timers.push(h); return h; };
  globalThis.clearTimeout = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  let paints = 0;
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) { if (k === 'canvas') return t.canvas; if (k === 'measureText') return (s) => ({ width: String(s).length * 6 }); return (...a) => { if (k === 'clearRect') paints++; return t.canvas; }; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = { clientWidth: 400, clientHeight: 400, width: 0, height: 0, style: {}, isConnected: true, offsetParent: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }), addEventListener: () => {}, setPointerCapture: () => {} };
  ctx.canvas = canvas;
  return {
    canvas,
    get paints() { return paints; }, get rafAsks() { return rafAsks; },
    // run the display for `ms`: timers fire when due, the frame callback at every vsync
    run(ms) {
      const end = now + ms;
      while (now < end) {
        const next = now + period;
        for (;;) { const due = timers.filter((h) => h.at <= next).sort((a, b) => a.at - b.at)[0]; if (!due) break; timers.splice(timers.indexOf(due), 1); now = Math.max(now, due.at); due.fn(); }
        now = next;
        if (raf) { const fn = raf; raf = null; fn(now); }
      }
    },
    restore() { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; },
  };
}
const cells = Array.from({ length: 40 }, (_, i) => ({ txid: `t${i}`.padEnd(64, 'x'), vbytes: 2000 + i * 300, rate: 50 - i }));
const moved = cells.map((c, i) => ({ ...c, vbytes: c.vbytes + (i % 2 ? 900 : 0) }));   // a re-pack: everything flies

test('the settings: tick, 1x and 60 ship; each is offered and survives normalise', () => {
  const a = DEFAULTS.appearance;
  assert.equal(a.pagePulse, 'tick');
  assert.equal(a.webglScale, '1');
  assert.equal(a.frameCap, '60');
  const rows = PANEL.find((g) => g.group === 'appearance').rows;
  assert.deepEqual(rows.find((r) => r.key === 'pagePulse').options.map((o) => o[0]), ['tick', 'smooth', 'still']);
  assert.deepEqual(rows.find((r) => r.key === 'webglScale').options.map((o) => o[0]), ['1', 'full', '0.75']);
  assert.deepEqual(rows.find((r) => r.key === 'frameCap').options.map((o) => o[0]), ['60', '30', 'full']);
  assert.equal(normalise({ appearance: { frameCap: '30' } }).appearance.frameCap, '30');
  assert.equal(normalise({ appearance: { frameCap: '144' } }).appearance.frameCap, '60', 'unknown: the default');
  assert.equal(frameGapOf({ frameCap: '60' }), 1000 / 60);
  assert.equal(frameGapOf({ frameCap: '30' }), 1000 / 30);
  assert.equal(frameGapOf({ frameCap: 'full' }), 0);
  assert.equal(webglScaleOf({ webglScale: '1' }), 1);
  assert.equal(webglScaleOf({ webglScale: '0.75' }), 0.75);
  assert.equal(webglScaleOf({ webglScale: 'full' }), Infinity);
});

function flightPaints(cap) {
  const d = display(120);
  try {
    const o = { renderer: 'software', stars: false, idleFx: false, frameCap: cap, transition: { rise: 3000, travel: 3000, drop: 3000 } };
    render3d(d.canvas, cells, o);
    d.run(200);
    render3d(d.canvas, moved, o);
    const p0 = d.paints, a0 = d.rafAsks;
    d.run(1000);                                      // one second inside the flight
    return { paints: d.paints - p0, asks: d.rafAsks - a0 };
  } finally { d.restore(); }
}
test('a flight on a 120 Hz display paints about 60 frames a second at frameCap 60, asking for no more', () => {
  const r = flightPaints('60');
  assert.ok(r.paints >= 55 && r.paints <= 62, `${r.paints} paints in one second`);
  assert.ok(r.asks <= r.paints + 2, `frames asked for: ${r.asks}`);
});
test('a flight on a 120 Hz display paints about 30 frames a second at frameCap 30', () => {
  const r = flightPaints('30');
  assert.ok(r.paints >= 27 && r.paints <= 32, `${r.paints} paints in one second`);
  assert.ok(r.asks <= r.paints + 2, `frames asked for: ${r.asks}`);
});
test('a flight on a 120 Hz display paints at every refresh at frameCap full', () => {
  const r = flightPaints('full');
  assert.ok(r.paints >= 110 && r.paints <= 121, `${r.paints} paints in one second`);
});

test('a resting board under a sky paints at most thirty a second, and asks for no frame in between', () => {
  const d = display(120);
  try {
    render3d(d.canvas, cells, { renderer: 'software', stars: true, idleFx: false, frameCap: '60' });
    d.run(3000);                                        // at rest by now
    const p0 = d.paints, a0 = d.rafAsks;
    d.run(1000);
    const n = d.paints - p0;
    assert.ok(n >= 27 && n <= 31, `${n} sky paints in a second (SKY_GAP_MS ${SKY_GAP_MS.toFixed(1)})`);
    assert.ok(d.rafAsks - a0 <= n + 2, `frames asked for: ${d.rafAsks - a0}, painted: ${n}`);
  } finally { d.restore(); }
});

test('WebGL draws at the capped density: 1x on a device-scale-2 screen is one pixel per CSS pixel', () => {
  // (a browser that HAS WebGL2: the cap applies only while WebGL is what draws -- software-speed.test.js holds the
  // other side, WebGL chosen where there is none: Software, every device pixel. The stub's context is not enough to
  // build a renderer on, so the board then falls back; the sizing is decided before that.)
  globalThis.document = { createElement: () => ({ getContext: (k) => (k === 'webgl2' ? { getExtension: () => null } : null), style: {} }) };
  for (const [scale, want] of [['1', 400], ['0.75', 300], ['full', 800]]) {
    const d = display(60);
    try {
      render3d(d.canvas, cells, { renderer: 'webgl', stars: false, idleFx: false, webglScale: scale });
      assert.equal(d.canvas.width, want, `webglScale ${scale}`);
    } finally { d.restore(); }
  }
  // Software keeps every device pixel whatever webglScale says
  const d = display(60);
  try { render3d(d.canvas, cells, { renderer: 'software', stars: false, idleFx: false, webglScale: '1' }); assert.equal(d.canvas.width, 800); } finally { d.restore(); }
});
