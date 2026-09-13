// THE AGENTS, AND THE CONTRACT THEY ALL KEEP.
//
// (operator, 2026-09-13: "no more per-tile stuff. Think more tron lightcycles stuff", then
// "Build all of them with amazing effects".)
//
// WHY THIS FILE EXISTS SEPARATELY FROM effects.test.js. That file plays every kind through fxAt
// with a HAND-BUILT fx object -- including a stub `heads` array -- so it proves the per-tile
// lighting maths, and nothing at all about whether an agent's build/frame/draw work. An agent
// could throw on its first frame and that suite would stay green. It nearly did: `rng` was called
// in startFx without being imported, the module parsed, and only running an effect found it.
//
// So this drives the REAL path: build a board, trigger each registered agent by name, and pump
// frames through the actual renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { board3d, triggerIdle, FX_KINDS } from '../public/js/details3d.js';
import { AGENTS, isAgent, alongPath, tallestTile, richestTile, rng } from '../public/js/agents.js';
import { DEFAULTS, PANEL } from '../public/js/settings.js';
import { fxAt, FX_NONE } from '../public/js/blockscene3d.js';

function harness() {
  let raf = null;
  const ops = [];
  harness.t = 0;
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => harness.t ?? 0 };
  globalThis.requestAnimationFrame = (fn) => { raf = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { raf = null; };
  globalThis.document = globalThis.document ?? {};
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      return () => { ops.push(String(k)); return t.canvas; };
    },
    set(t, k, v) { ops.push(`set:${String(k)}`); t[k] = v; return true; },
  });
  const canvas = { clientWidth: 900, clientHeight: 600, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() {}, setPointerCapture() {} };
  const step = (t) => { const fn = raf; raf = null; harness.t = t; if (fn) fn(t); return !!fn; };
  return { canvas, ops, step };
}

// a board with a real skyline: heights vary, so the agents that read it (bomberman's walls,
// snake's targets) have something to find
const TILES = [];
for (let x = 0; x < 20; x += 2) {
  for (let y = 0; y < 14; y += 2) {
    TILES.push({ txid: `t${x}_${y}`, x, y, s: 2, tall: 0.5 + ((x * 7 + y) % 9) * 0.4, color: '#33cc99', rate: (x + y) % 40 });
  }
}
const OPTS = { gridW: 20, gridH: 14, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } };

test('every registered agent is a real effect: in FX_KINDS, with a switch and a panel row', () => {
  const rows = PANEL.find((g) => g.group === 'effects')?.rows.map((r) => r.key) ?? [];
  for (const kind of Object.keys(AGENTS)) {
    assert.ok(FX_KINDS.includes(kind), `${kind} must be in FX_MS or the scheduler can never pick it`);
    assert.equal(DEFAULTS.effects[kind], true, `${kind} needs a switch`);
    assert.ok(rows.includes(kind), `${kind} needs a row in the panel, or it cannot be turned off`);
  }
  // and the retired one is still retired
  assert.equal(isAgent('packets'), false, 'the data packets stay gone (operator: "wandering lights")');
});

test('THE REAL PATH: every agent builds, frames and draws without throwing', () => {
  // The regression this file exists for. effects.test.js hands fxAt a stub `heads` and never
  // touches build/frame/draw, so an agent that throws on its first frame passes it.
  for (const kind of Object.keys(AGENTS)) {
    const h = harness();
    board3d(h.canvas, TILES, OPTS);
    for (let i = 1; i <= 4; i++) h.step(i * 16);
    harness.t = 1000;
    assert.equal(triggerIdle(h.canvas, kind), true, `${kind} is triggerable`);
    const before = h.ops.length;
    let frames = 0;
    for (let i = 1; i <= 20; i++) { if (h.step(1000 + i * 300)) frames++; }
    assert.ok(frames > 0, `${kind} animates`);
    assert.ok(h.ops.length > before, `${kind} draws something`);
  }
});

test('every agent publishes heads, and the heads light the board', () => {
  // `heads` is the whole reason an agent is part of the board rather than painted over it.
  for (const kind of Object.keys(AGENTS)) {
    const spec = AGENTS[kind];
    const agent = spec.build({
      st: {}, seed: 4242, W: 20, H: 14, tiles: TILES,
      tops: new Float32Array(20 * 14), rnd: rng(4242),
    });
    let sawHead = false, lit = 0;
    for (let u = 0.02; u < 1; u += 0.02) {
      const f = spec.frame(agent, u, { ms: 6500, derezMs: 800, seed: 4242 });
      const heads = f?.heads ?? [];
      if (heads.length) sawHead = true;
      for (const hd of heads) {
        assert.ok(Number.isFinite(hd.x) && Number.isFinite(hd.y), `${kind}: a head has a place (${hd.x},${hd.y})`);
        assert.ok(Array.isArray(hd.color) && hd.color.length === 3, `${kind}: a head has a colour`);
        assert.ok(hd.alpha == null || (hd.alpha >= -0.001 && hd.alpha <= 1.001), `${kind}: alpha in range (${hd.alpha})`);
      }
      // the lighting maths the renderer will run
      const fx = { kind, u, amp: 1, gridW: 20, gridH: 14, dx: 1, dy: 0, seed: 4242, x: 10, y: 7, ...f };
      for (const t of TILES) {
        const v = fxAt(t, fx);
        if (v !== FX_NONE && Math.max(v.glow, v.outline) > 0.05) lit++;
      }
    }
    assert.ok(sawHead, `${kind} publishes heads`);
    assert.ok(lit > 0, `${kind} lights cubes through those heads (${lit})`);
  }
});

test('an agent replays identically from the same seed', () => {
  // Board-level choices come from the seeded stream, never Math.random, so a test can assert on
  // an agent at all and a replay does not drift.
  for (const kind of Object.keys(AGENTS)) {
    const build = () => AGENTS[kind].build({
      st: {}, seed: 99, W: 20, H: 14, tiles: TILES, tops: new Float32Array(20 * 14), rnd: rng(99),
    });
    const a = build(), b = build();
    const fa = AGENTS[kind].frame(a, 0.4, { ms: 6500, derezMs: 800, seed: 99 });
    const fb = AGENTS[kind].frame(b, 0.4, { ms: 6500, derezMs: 800, seed: 99 });
    assert.deepEqual(
      (fa.heads ?? []).map((h) => [Math.round(h.x * 100), Math.round(h.y * 100)]),
      (fb.heads ?? []).map((h) => [Math.round(h.x * 100), Math.round(h.y * 100)]),
      `${kind} replays identically`,
    );
  }
});

test('the board is never mutated: an effect that eats a cube leaves the tiles alone', () => {
  // (operator, asked whether effects may alter the board: "Allow it, it snaps back".) The only
  // safe version of that is a per-frame OVERRIDE -- buildScene applies hide/scale/lift onto a COPY
  // of the tile -- so an interrupted effect cannot leave the board wrong. Here: the tiles handed
  // in come back untouched, whatever ran over them.
  const snapshot = JSON.stringify(TILES);
  for (const kind of Object.keys(AGENTS)) {
    const h = harness();
    board3d(h.canvas, TILES, OPTS);
    for (let i = 1; i <= 4; i++) h.step(i * 16);
    harness.t = 1000;
    triggerIdle(h.canvas, kind);
    for (let i = 1; i <= 10; i++) h.step(1000 + i * 300);
    assert.equal(JSON.stringify(TILES), snapshot, `${kind} did not mutate the tiles it ran over`);
  }
});

test('hide and scale are transient, and default to "visible, full size"', () => {
  // FX_NONE is what every tile gets when nothing is happening to it, and what the airborne path
  // short-circuits to. If these defaults were wrong the board would vanish while an effect ran.
  assert.equal(FX_NONE.hide, 0, 'nothing is hidden by default');
  assert.equal(FX_NONE.scale, 1, 'and nothing is shortened');
  assert.equal(Object.isFrozen(FX_NONE), true, 'and it cannot be edited by a caller');
});

test('the helpers agents are built on do what they say', () => {
  assert.deepEqual(alongPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.5), { x: 5, y: 0, k: 0 });
  assert.deepEqual(alongPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], 5), { x: 10, y: 0, k: 0 }, 'past the end clamps');
  const tiles = [{ txid: 'a', x: 0, y: 0, s: 2, tall: 3, rate: 5 }, { txid: 'b', x: 4, y: 4, s: 2, tall: 9, rate: 1 }];
  assert.equal(tallestTile(tiles).tile.txid, 'b', 'tallest is by height');
  assert.equal(richestTile(tiles).tile.txid, 'a', 'richest is by feerate');
  assert.equal(tallestTile([]), null, 'an empty board has no target');
  assert.equal(richestTile([]), null);
});

test('bomberman reads the skyline: its blast is stopped by tall transactions', () => {
  // THE DATA-AWARE CLAIM, checked rather than asserted in a comment. A board of tall cubes must
  // give shorter arms than a board of flat ones -- that is what makes the cross a picture of the
  // block's density instead of decoration.
  const flat = [];
  const tall = [];
  for (let x = 0; x < 20; x++) {
    for (let y = 0; y < 14; y++) {
      flat.push({ txid: `f${x}_${y}`, x, y, s: 1, tall: 0.2, color: '#333', rate: 1 });
      tall.push({ txid: `t${x}_${y}`, x, y, s: 1, tall: 6, color: '#333', rate: 1 });
    }
  }
  const reach = (tiles) => {
    const a = AGENTS.bomberman.build({ st: {}, seed: 7, W: 20, H: 14, tiles, tops: null, rnd: rng(7) });
    return a.arms.reduce((n, arm) => n + arm.n, 0);
  };
  const open = reach(flat), blocked = reach(tall);
  assert.ok(open > blocked, `a sparse block gives longer arms than a full one (${open} vs ${blocked})`);
  assert.equal(blocked, 0, 'walled in on every side, the blast goes nowhere');
});
