// THE REST BETWEEN EFFECTS HOLDS WITH THE POOL PUSHED (2026-09-30; operator: "Space timers are not properly working
// for Between effects at least, and at most seconds. It's triggering way to often in Block Space effects"). Every
// 5 s push lands a trickle; each landing used to arm "the first effect after landing" (about a second) over the
// between-effects timer. Simulated here: a fake clock, fake timers, frames at 60 Hz, a small update every 5 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render3d, fxPlaying } from '../public/js/details3d.js';

function world() {
  let now = 0, raf = null;
  const timers = [];
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = { hidden: false };
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (fn) => { raf = fn; return 7; };
  globalThis.cancelAnimationFrame = () => { raf = null; };
  globalThis.setTimeout = (fn, ms) => { const h = { at: now + Math.max(0, ms || 0), fn, unref() {} }; timers.push(h); return h; };
  globalThis.clearTimeout = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const ctx = new Proxy({ canvas: {} }, { get(t, k) { if (k === 'canvas') return t.canvas; if (k === 'measureText') return () => ({ width: 10 }); return () => t.canvas; }, set(t, k, v) { t[k] = v; return true; } });
  const canvas = { clientWidth: 300, clientHeight: 300, width: 0, height: 0, style: {}, isConnected: true, offsetParent: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 300 }), addEventListener: () => {} };
  ctx.canvas = canvas;
  const step = (ms) => {
    const end = now + ms;
    while (now < end) {
      const next = now + 1000 / 60;
      for (;;) { const due = timers.filter((h) => h.at <= next).sort((a, b) => a.at - b.at)[0]; if (!due) break; timers.splice(timers.indexOf(due), 1); now = Math.max(now, due.at); due.fn(); }
      now = next;
      if (raf) { const fn = raf; raf = null; fn(now); }
    }
  };
  return { canvas, step, clock: () => now, restore: () => { globalThis.setTimeout = real.set; globalThis.clearTimeout = real.clear; } };
}

test('with a small update every 5 s, effects keep the between-effects rest (20-30 s here)', () => {
  const w = world();
  try {
    const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({ txid: `${tag}${i}`.padEnd(64, 'x'), vbytes: 3000 + i * 50, rate: 60 - i }));
    // (as the Simple board's data is: the richest few, and ONE aggregate for the tail -- a board without it takes
    // the fresh-pack path, and every push is then a full reshuffle, not a trickle)
    const tail = { vbytes: 400_000, rate: 0.9, aggregate: 20_000 };
    let cells = mk(40, 'a').concat([tail]);
    const o = { renderer: 'software', stars: false, idleFx: true, fxKinds: ['ripple'], idleEvery: [20_000, 30_000], idleFirst: [800, 1600] };
    render3d(w.canvas, cells, o);
    const starts = [], ends = [];
    let playing = false;
    for (let s = 0; s < 180_000; s += 100) {
      if (s % 5000 === 0 && s > 0) {                    // the push: two leave, two arrive
        cells = cells.slice(2, -1).concat(mk(2, `n${s}-`), [tail]);
        render3d(w.canvas, cells, o);
      }
      w.step(100);
      const now = fxPlaying(w.canvas) != null;
      if (now && !playing) starts.push(w.clock());
      if (!now && playing) ends.push(w.clock());
      playing = now;
    }
    assert.ok(starts.length >= 2, `effects still play (${starts.length} in three minutes)`);
    assert.ok(starts.length <= 8, `but not after every push: ${starts.length} in three minutes`);
    for (let i = 1; i < starts.length; i++) {
      const rest = starts[i] - ends[i - 1];
      assert.ok(rest >= 19_900, `rest before effect ${i + 1}: ${Math.round(rest)} ms`);
    }
  } finally { w.restore(); }
});
