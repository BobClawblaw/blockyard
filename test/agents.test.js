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
import { AGENTS, isAgent, alongPath, tallestTile, richestTile, rng, floodFrom } from '../public/js/agents.js';
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

test('A HEAD CAN ACTUALLY HIDE AND SHRINK A CUBE, end to end from the caller', () => {
  // THE DEAD-MACHINERY REGRESSION. `hide` and `scale` were added to fxAt's result so an effect
  // could eat or collapse a cube -- and the heads branch then hardcoded `hide: 0, scale: 1`, so no
  // agent could reach them. Three batches shipped with that dead, and it was only caught when the
  // effects that need it were about to be written on top. A defaults check on FX_NONE (below) does
  // NOT catch this: the capability has to be asserted from the side that uses it.
  const tile = { txid: 'a', x: 4, y: 4, s: 1 };
  const at = (head) => fxAt(tile, {
    kind: 'snake', u: 0.5, amp: 1, gridW: 20, gridH: 20, dx: 1, dy: 0, seed: 1, x: 0, y: 0, heads: [head],
  });
  const on = at({ x: 4.5, y: 4.5, color: [1, 2, 3], alpha: 1, r: 1, hide: 1 });
  assert.equal(on.hide, 1, 'a head ON the cube hides it');
  const away = at({ x: 14, y: 14, color: [1, 2, 3], alpha: 1, r: 1, hide: 1 });
  assert.equal(away.hide, 0, 'a head far away does not -- reach decides, not intent');
  const shrunk = at({ x: 4.5, y: 4.5, color: [1, 2, 3], alpha: 1, r: 1, scale: 0.2 });
  assert.ok(shrunk.scale < 0.25, `a head over it shortens it (${shrunk.scale})`);
  const partly = at({ x: 5.6, y: 4.5, color: [1, 2, 3], alpha: 1, r: 1, scale: 0.2 });
  assert.ok(partly.scale > shrunk.scale && partly.scale < 1, `and eases in with reach (${partly.scale})`);
  const plain = at({ x: 4.5, y: 4.5, color: [1, 2, 3], alpha: 1, r: 1 });
  assert.equal(plain.hide, 0, 'a head that asks for neither changes neither');
  assert.equal(plain.scale, 1);
  assert.ok(plain.glow > 0.5, 'but it still lights the cube');

  // THE CONTROL: an unregistered kind falls to FX_NONE, which is how the first version of this
  // probe fooled me -- every case came back identical because none of them ran at all.
  const unknown = fxAt(tile, { kind: 'not-a-kind', u: 0.5, amp: 1, gridW: 20, gridH: 20, dx: 1, dy: 0, heads: [{ x: 4.5, y: 4.5, color: [1, 2, 3], alpha: 1, r: 1, hide: 1 }] });
  assert.equal(unknown.glow, 0, 'an unregistered kind lights nothing, so identical results mean the test did not run');
});

test('an agent that alters the board actually alters it, on a REAL board', () => {
  // THE SECOND DEAD-WIRE REGRESSION, and the reason this is measured on a real board rather than
  // with a hand-placed head. The end-to-end test above passes a head sitting exactly on a tile, so
  // it proved the pass-through and NOT that any agent reaches the threshold in situ. Measured on
  // the live board, katamari and boulder dash hid zero cubes across a whole run: `w` folds the
  // head's alpha into its falloff, and boulder dash fades its ring out AS it collapses, so the
  // very fade that meant it was working cancelled the hiding. Alteration is gated on proximity
  // now; alpha still governs lighting.
  const W = 40, H = 30;
  const board = [];
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) board.push({ txid: `a${x}_${y}`, x, y, s: 1, tall: 1.2, color: '#333', rate: (x + y) % 40 });
  const sweep = (kind) => {
    const a = AGENTS[kind].build({ st: {}, seed: 5, W, H, tiles: board, tops: null, rnd: rng(5) });
    let hid = 0, shrunk = 0;
    for (let u = 0.02; u < 1; u += 0.02) {
      const f = AGENTS[kind].frame(a, u, { ms: 8000, derezMs: 800, seed: 5 });
      const fx = { kind, u, amp: 1, gridW: W, gridH: H, dx: 1, dy: 0, seed: 5, x: 0, y: 0, ...f };
      for (const t of board) {
        const v = fxAt(t, fx);
        if (v.hide) hid++;
        else if (v.scale < 0.9) shrunk++;
      }
    }
    return { hid, shrunk };
  };
  const kat = sweep('katamari');
  assert.ok(kat.hid > 0, `katamari absorbs cubes (${kat.hid} cube-frames hidden)`);
  const bd = sweep('boulderdash');
  assert.ok(bd.shrunk > 0, `boulder dash collapses cubes (${bd.shrunk} cube-frames shortened)`);
  const lem = sweep('lemmings');
  assert.ok(lem.shrunk > 0, `a lemming digs through one (${lem.shrunk} cube-frames shortened)`);
  // and the control: an agent that alters nothing must alter nothing
  const gr = sweep('gradius');
  assert.equal(gr.hid, 0, 'an agent that only travels hides nothing');
  assert.equal(gr.shrunk, 0, 'and shortens nothing');
});

test('hide and scale are transient, and default to "visible, full size"', () => {
  // FX_NONE is what every tile gets when nothing is happening to it, and what the airborne path
  // short-circuits to. If these defaults were wrong the board would vanish while an effect ran.
  assert.equal(FX_NONE.hide, 0, 'nothing is hidden by default');
  assert.equal(FX_NONE.scale, 1, 'and nothing is shortened');
  assert.equal(Object.isFrozen(FX_NONE), true, 'and it cannot be edited by a caller');
});

test('floodFrom spreads, stops at what blocks it, and never revisits', () => {
  // New machinery for the minesweeper sweep, and the only thing in batch three nobody else
  // exercises. A flood is not a radius: it goes AROUND an obstacle, which is what makes the shape
  // it draws a map of where the expensive transactions sit.
  const open = floodFrom(5, 5, 12, 12, () => false);
  assert.equal(open.length, 144, 'an empty grid floods entirely');
  assert.equal(new Set(open.map((c) => `${c.x},${c.y}`)).size, 144, 'and no cell twice');
  assert.equal(open[0].x, 5, 'it starts where it was told to');
  assert.equal(open[0].y, 5);
  // a wall down the middle, with one gap: the far side is reachable only through the gap, so it
  // must be reached LATER than the near side rather than not at all
  const wall = (x, y) => x === 6 && y !== 0;
  const around = floodFrom(2, 5, 12, 12, wall);
  const far = around.filter((c) => c.x > 6);
  assert.ok(far.length > 0, 'it finds the way around the wall');
  const nearest = Math.min(...far.map((c) => c.d));
  assert.ok(nearest > 12, `and gets there the long way (first far cell at step ${nearest})`);
  assert.equal(around.some((c) => c.x === 6 && c.y !== 0), false, 'it never enters the wall itself');
  // bounded, so a huge board cannot make one effect allocate without limit
  assert.equal(floodFrom(0, 0, 200, 200, () => false, 50).length, 50, 'the limit is honoured');
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

test('NO AGENT IS BLINDED BY A FLAT BOARD -- the guard for a bug found three times', () => {
  // Three agents that read the skyline have now done nothing on a board with no skyline:
  //   bomberman  a flat wall threshold made every neighbour a wall -> the blast drew a dot
  //   marble     greedy descent stops when no neighbour is lower   -> a two-point route
  //   sonic      no rise means no ramp                             -> parked at the left edge
  // The dense block-space board packs thousands of slabs at EXACTLY the same height, so "flat" is
  // not a corner case here, it is the common case. Rather than wait for a fourth, every agent is
  // played on a perfectly uniform board and must still move something.
  const W = 40, H = 30;
  const flat = [];
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) flat.push({ txid: `f${x}_${y}`, x, y, s: 1, tall: 1.2, color: '#333', rate: (x + y) % 40 });
  for (const kind of Object.keys(AGENTS)) {
    const a = AGENTS[kind].build({ st: {}, seed: 11, W, H, tiles: flat, tops: null, rnd: rng(11) });
    const seen = new Set();
    let frames = 0;
    for (let u = 0.04; u < 1; u += 0.04) {
      const f = AGENTS[kind].frame(a, u, { ms: 7000, derezMs: 800, seed: 11 });
      for (const hd of f?.heads ?? []) seen.add(`${Math.round(hd.x)},${Math.round(hd.y)}`);
      if ((f?.heads ?? []).length) frames++;
    }
    assert.ok(frames > 4, `${kind} publishes heads through its run on a flat board (${frames} frames)`);
    assert.ok(seen.size > 3, `${kind} MOVES on a flat board rather than parking (${seen.size} distinct places)`);
  }
});

test('marble rolls somewhere on ANY board, flat or sloped', () => {
  // The second skyline-reading agent to do nothing on a board with no skyline. Greedy descent
  // stops the instant no neighbour is lower, and the dense block-space board packs thousands of
  // slabs at exactly the same height -- so the route was two points long and the marble sat still
  // for its whole run. A flat board is still a board.
  const board = (tall) => {
    const out = [];
    for (let x = 0; x < 40; x++) for (let y = 0; y < 30; y++) out.push({ txid: `m${x}_${y}`, x, y, s: 1, tall: tall(x, y), color: '#333', rate: (x + y) % 40 });
    return out;
  };
  const route = (tiles) => AGENTS.marble.build({ st: {}, seed: 5, W: 40, H: 30, tiles, tops: null, rnd: rng(5) }).pts;
  const flat = route(board(() => 1.2));
  assert.ok(flat.length > 6, `a flat board still gives it somewhere to go (${flat.length} points)`);
  const moved = Math.hypot(flat.at(-1).x - flat[0].x, flat.at(-1).y - flat[0].y);
  assert.ok(moved > 5, `and it actually travels (${moved.toFixed(1)} grid units)`);
  const sloped = route(board((x, y) => 6 - (x + y) * 0.08));
  assert.ok(sloped.length > 6, 'a sloped board too');
  // the point of the effect: on a real slope it goes DOWNHILL, which a drift would not guarantee
  const heights = (p) => 6 - (p.x + p.y) * 0.08;
  assert.ok(heights(sloped.at(-1)) < heights(sloped[0]), 'and on a slope it ends lower than it started');
});

test('bomberman reads the skyline: a spiky block stops the blast, a flat one does not', () => {
  // THE DATA-AWARE CLAIM, checked rather than asserted in a comment -- and this test has already
  // earned its place twice by rejecting two wrong rules:
  //
  //   a flat threshold (1.2)  made every cube on the dense board a wall, because that board's
  //                           slabs are all exactly 1.2 tall: the blast drew a dot.
  //   the 70th percentile     made a field of 0.2s and a field of 6s identical (26 vs 26), because
  //                           on a UNIFORM board the percentile sits just above everything at any
  //                           absolute height. Density became unreadable.
  //
  // So the comparison that means something is not low-vs-tall, which is two flat boards; it is
  // FLAT vs SPIKY. A wall is a cube that stands out from its neighbours.
  const board = (h) => {
    const out = [];
    for (let x = 0; x < 20; x++) for (let y = 0; y < 14; y++) out.push({ txid: `b${x}_${y}`, x, y, s: 1, tall: h(x, y), color: '#333', rate: 1 });
    return out;
  };
  const reach = (tiles) => {
    const a = AGENTS.bomberman.build({ st: {}, seed: 7, W: 20, H: 14, tiles, tops: null, rnd: rng(7) });
    return a.arms.reduce((n, arm) => n + arm.n, 0);
  };
  const flatLow = reach(board(() => 0.2));
  const flatTall = reach(board(() => 6));
  const spiky = reach(board((x, y) => (((x * 7 + y) % 7 === 0) ? 7 : 0.6)));
  const verySpiky = reach(board((x, y) => (((x * 3 + y) % 3 === 0) ? 7 : 0.6)));

  assert.ok(flatLow > spiky, `a flat block lets the blast run; a spiky one stops it (${flatLow} vs ${spiky})`);
  assert.ok(spiky >= verySpiky, `and the spikier it is, the sooner (${spiky} vs ${verySpiky})`);
  assert.equal(flatLow, flatTall,
    'absolute height must NOT matter: a field of little transactions and a field of giants are both flat');
  assert.ok(flatLow > 0, 'a flat board does not wall the blast in at the origin');
});
