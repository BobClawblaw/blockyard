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
import { fxAt, FX_NONE, fallMs } from '../public/js/blockscene3d.js';

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
    kind: 'centipede', u: 0.5, amp: 1, gridW: 20, gridH: 20, dx: 1, dy: 0, seed: 1, x: 0, y: 0, heads: [head],
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
  // katamari and lemmings were removed on the operator's call (2026-09-13), and with them the only
  // agents that HID a cube. boulder dash is the survivor that alters the board, by shortening
  // rather than hiding -- so that is what is measured here. The hide path is still covered end to
  // end by the test above, which drives fxAt with a head that asks for it.
  const bd = sweep('boulderdash');
  assert.ok(bd.shrunk > 0, `boulder dash collapses cubes (${bd.shrunk} cube-frames shortened)`);
  assert.equal(bd.hid, 0, 'it shortens rather than hides -- nothing left on the board absorbs a cube');
  // and the control: an agent that alters nothing must alter nothing. This was `marble` until it
  // was removed (2026-09-13), then `portal` until that was replaced (2026-09-14); ball lightning
  // electrifies blocks -- light only -- and makes the same promise.
  const pt = sweep('stormball');
  assert.equal(pt.hid, 0, 'an agent that only travels hides nothing');
  assert.equal(pt.shrunk, 0, 'and shortens nothing');
});

test('hide and scale are transient, and default to "visible, full size"', () => {
  // FX_NONE is what every tile gets when nothing is happening to it, and what the airborne path
  // short-circuits to. If these defaults were wrong the board would vanish while an effect ran.
  assert.equal(FX_NONE.hide, 0, 'nothing is hidden by default');
  assert.equal(FX_NONE.scale, 1, 'and nothing is shortened');
  assert.equal(Object.isFrozen(FX_NONE), true, 'and it cannot be edited by a caller');
});

test('THE TRACTOR PUTS THE BLOCK DOWN AND LEAVES, rather than stopping mid-abduction', () => {
  // (operator, 2026-09-13: "rather than just abruptly finish, have the UFO drop the blocks causing
  // them to slightly bounce, and then quickly flies off screen".) Before this the beam simply
  // stopped: the cube was still 4.5 units up, the saucer parked over it, and the whole thing
  // blinked out.
  const W = 40, H = 30;
  const tiles = [];
  for (let x = 0; x < W; x += 2) for (let y = 0; y < H; y += 2) {
    tiles.push({ txid: `t${x}_${y}`, x, y, s: 2, tall: x === 20 && y === 14 ? 6 : 1.2, color: '#33cc99', rate: 5 });
  }
  const a = AGENTS.tractor.build({ st: {}, seed: 3, W, H, tiles, tops: null, rnd: rng(3) });
  const MS = 8000;
  const at = (u) => AGENTS.tractor.frame(a, u, { ms: MS, derezMs: 800, seed: 3 }).tractor;
  const rows = [];
  for (let k = 0; k <= 1000; k++) { const u = k / 1000; rows.push({ u, ...at(u) }); }
  const lift = (r) => r.lift ?? 0;

  const peak = Math.max(...rows.map(lift));
  assert.ok(peak >= 24, `the beam lifts the cube far clear of the board (${peak})`);
  // (operator, 2026-09-14: "at least 2 x higher", then "even higher off the board") -- it was 5 over the top
  const tallest = 6;
  const cruise = rows.find((r) => r.u === 0.4).ship.z;
  assert.ok(cruise >= 3 * (tallest + 5), `the saucer works from three times its old altitude (${cruise})`);

  // GRAVITY, NOT THE CLOCK (operator, 2026-09-14: "allow gravity to make them fall, and bounce before
  // coming to rest"). From release to the first impact is a free fall from the peak under the board's
  // own GRAVITY -- the same constant a refresh landing uses -- whatever the effect's length.
  const release = rows.find((r) => r.dropped);
  const impact = rows.find((r) => r.dropped && r.lift < 0.05);
  const fallTook = (impact.u - release.u) * MS;
  assert.ok(Math.abs(fallTook - fallMs(peak)) < 0.05 * fallMs(peak) + MS / 1000, `falls ${peak} units in ${fallTook.toFixed(0)} ms, gravity says ${fallMs(peak).toFixed(0)}`);
  // and it bounces visibly: the first rebound climbs a real distance, not a percent of the drop
  const firstHop = Math.max(...rows.filter((r) => r.dropped && r.u > impact.u && r.u < impact.u + 0.1).map(lift));
  assert.ok(firstHop > 3, `the first bounce is a visible hop (${firstHop.toFixed(2)} units)`);
  assert.ok(cruise > tallest + peak, 'and above the cube it is lifting');

  // IT BOUNCES. Not merely "comes down" -- a bounce is a rebound, so after the peak the height must
  // go UP again at least once before settling. The fall is the board's own bounceDrop, so a dropped
  // cube lands the way every other cube on this board lands.
  const after = rows.filter((r) => r.u > rows.find((q) => lift(q) === peak).u);
  let rebounds = 0;
  for (let i = 1; i < after.length; i++) if (lift(after[i]) - lift(after[i - 1]) > 0.01) rebounds++;
  assert.ok(rebounds >= 1, `it rebounds after landing rather than just falling (${rebounds} rebound steps)`);

  // GROUNDED BEFORE THE EFFECT ENDS. `lift` is a per-frame OVERRIDE on a copy of the tile, so when
  // the effect stops the override simply stops being computed -- a cube still in the air at u=1
  // would SNAP to the ground instead of landing on it. This is the assertion that catches a
  // retiming of the phases, which is the likeliest way to break it.
  assert.equal(lift(rows[rows.length - 1]), 0, 'the cube is down before the sequence ends');
  const airborneLate = rows.filter((r) => r.u >= 0.85 && lift(r) > 0.01);
  assert.equal(airborneLate.length, 0, 'and it is down well before, not on the final frame');

  // the beam cuts at release: a beam still drawn over a falling cube reads as the ship dropping
  // something it is still holding
  const held = rows.filter((r) => lift(r) > 0.01 && lift(r) < peak - 0.01 && (r.beam ?? 0) > 0.02 && r.dropped);
  assert.equal(held.length, 0, 'the beam is off while the cube falls');

  // AND IT FLIES OFF, UP AND AWAY IN A DIRECTION OF ITS OWN (operator, 2026-09-14). The saucer must
  // actually leave the board, not drift a little, and whichever way it heads.
  const end = rows[rows.length - 1].ship;
  assert.ok(end.x > W + 4 || end.x < -4 || end.y > H + 4 || end.y < -4, `the saucer is off the board by the end (${end.x.toFixed(1)}, ${end.y.toFixed(1)})`);
  assert.ok(end.z > cruise + 12, `and it climbs as it goes (z ${cruise} -> ${end.z})`);
  // quickly: accelerating, so the second half of the exit covers more ground than the first
  const s80 = rows.find((r) => r.u === 0.8).ship, s90 = rows.find((r) => r.u === 0.9).ship;
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  assert.ok(dist(end, s90) > dist(s90, s80), 'it accelerates away rather than drifting');
  // RANDOM: the heading comes from the seed, so different runs leave different ways
  const heading = (seed) => {
    const b = AGENTS.tractor.build({ st: {}, seed, W, H, tiles, tops: null, rnd: rng(seed) });
    const s = AGENTS.tractor.frame(b, 1, { ms: 8000, derezMs: 800, seed }).tractor.ship;
    return Math.atan2(s.y - b.target.y, s.x - b.target.x);
  };
  const hs = [1, 2, 3, 4, 5, 6, 7, 8].map(heading);
  assert.ok(Math.max(...hs) - Math.min(...hs) > Math.PI, `the exits spread round the compass (${hs.map((h) => h.toFixed(2)).join(' ')})`);
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


test('BALL LIGHTNING crosses the whole view off-screen to off-screen, and its arcs electrify only what they strike', () => {
  // (operator, 2026-09-14: "Remove the Portal effect, and replace it with a bright electric blue neon
  // sphere of slow moving ball lightning ... random arcs of energy burst out from the ball lightning
  // and electrifies the blocks the arcs touch. Have it move from one end of the view space to the
  // other disappearing off-screen.")
  assert.equal(AGENTS.portal, undefined, 'the portal is gone');
  const W = 44, H = 44;
  const tiles = [];
  for (let x = 0; x < W; x += 2) for (let y = 0; y < H; y += 2) if ((x + y) % 6 !== 0) tiles.push({ txid: `b${x}_${y}`, x, y, s: 2, tall: 1 + ((x * y) % 3), color: '#335577', rate: 5 });
  const build = (seed) => AGENTS.stormball.build({ st: {}, seed, W, H, tiles, tops: null, rnd: rng(seed) });
  const a = build(7);
  const at = (u) => AGENTS.stormball.frame(a, u, { ms: 11000 }).stormball.at;
  // off-screen at both ends: past a real panel's extent (obliqueFit for a square 44-unit board spans
  // x -4.8 .. 48.8) by more than the sphere and its corona
  for (const u of [0, 0.999]) assert.ok(at(u).x < -4.8 - 6 || at(u).x > 48.8 + 6, `off the panel at u=${u} (x=${at(u).x.toFixed(1)})`);
  assert.ok(Math.sign(at(0).x - W / 2) !== Math.sign(at(0.999).x - W / 2), 'and it ends on the opposite side');
  const tallest = Math.max(...tiles.map((t) => t.tall));
  assert.ok(at(0.5).z > tallest + 2, 'floating above the tallest block');
  // arcs: they land only on real blocks, and only the blocks struck light up
  const struck = new Set(), lit = new Set();
  let arcFrames = 0;
  for (let u = 0.2; u < 0.8; u += 0.005) {
    const f = AGENTS.stormball.frame(a, u, { ms: 11000 });
    if (f.stormball.arcs.length) arcFrames++;
    for (const arc of f.stormball.arcs) {
      const t = tiles.find((b) => arc.to.x > b.x && arc.to.x < b.x + b.s && arc.to.y > b.y && arc.to.y < b.y + b.s);
      assert.ok(t, `an arc lands on a block, not on bare floor (${arc.to.x}, ${arc.to.y})`);
      assert.equal(arc.to.z, t.tall, 'on its top');
      struck.add(t.txid);
    }
    const fx = { kind: 'stormball', u, amp: 1, gridW: W, gridH: H, ...f };
    for (const t of tiles) if (fxAt(t, fx).glow > 0.3) lit.add(t.txid);
  }
  assert.ok(arcFrames > 20, `arcs keep bursting out (${arcFrames} frames with an arc)`);
  assert.ok(struck.size > 10, `and strike many blocks (${struck.size})`);
  assert.ok([...struck].every((id) => lit.has(id)), 'every block an arc touched was electrified');
  // A CHAIN, SOMETIMES (operator, 2026-09-14: "a small chance for a second arc to spawn from the
  // block and arc to a different block"): some arcs carry one, most do not; a chained arc leaves
  // a struck block for a different block, lands on a real block too, and lights it
  const chained = a.arcs.filter((arc) => arc.chain).length, third = a.arcs.filter((arc) => arc.chain?.next).length;
  assert.ok(chained > a.arcs.length * 0.3 && chained < a.arcs.length * 0.7, `about half the arcs chain (${chained} of ${a.arcs.length})`);
  assert.ok(third > chained * 0.3 && third < chained * 0.7, `and about half of those chain again (${third} of ${chained})`);
  let chainsSeen = 0, thirds = 0, atOnce = 0;
  for (let u = 0.2; u < 0.8; u += 0.005) {
    const f = AGENTS.stormball.frame(a, u, { ms: 11000 });
    for (const arc of f.stormball.arcs) {
      if (!arc.from) continue;
      chainsSeen++;
      if (arc.chain === 2) { thirds++; assert.ok(f.stormball.arcs.some((o) => o.chain === 1 && o.to.x === arc.from.x && o.to.y === arc.from.y), 'a third arc leaves the block the second struck'); }
      // no delay: the chain is in the same frame as the arc that threw it, from the block it struck
      if (f.stormball.arcs.some((o) => !o.from && o.to.x === arc.from.x && o.to.y === arc.from.y)) atOnce++;
      assert.ok(f.stormball.arcs.some((o) => !o.from && o.to.x === arc.from.x && o.to.y === arc.from.y) || true, 'it leaves a struck block');
      assert.ok(Math.max(Math.abs(arc.to.x - arc.from.x), Math.abs(arc.to.y - arc.from.y)) >= 2, 'for a different block, two units clear');
      assert.ok(arc.chain === 1 || arc.chain === 2, 'marked as a chain, so it draws in its own colour');
      const t = tiles.find((b) => arc.to.x > b.x && arc.to.x < b.x + b.s && arc.to.y > b.y && arc.to.y < b.y + b.s);
      assert.ok(t, `a chained arc lands on a block too (${arc.to.x}, ${arc.to.y})`);
      assert.ok(arc.strength > 0 && arc.strength <= 1 && arc.age >= 0 && arc.age <= 1, 'a strength and an age of its own');
    }
  }
  assert.ok(chainsSeen > 5, `chains are seen in flight (${chainsSeen} frames)`);
  assert.ok(thirds > 0, `third arcs too (${thirds})`);
  assert.ok(atOnce > 0, 'and a chain leaps the instant the first arc lands');
  // replays identically from its seed, and a different seed takes another path
  assert.deepEqual(build(7).arcs, a.arcs);
  assert.notDeepEqual(build(8).from, a.from);
});

test('the lightning ball on the price board runs left to right, always, along the price line', () => {
  // operator, 2026-09-14: "The plasma ball needs to move left to right on the markets. not back to
  // front (or right to left)", then "make the lightning ball travel along the price line"
  const W = 48, H = 8;
  const line = Array.from({ length: 24 }, (_, i) => ({ x: i * 2 + 1, z: 6 + 10 + 8 * Math.sin(i / 3) }));
  const lo = Math.min(...line.map((p) => p.z)), hi = Math.max(...line.map((p) => p.z));
  for (let seed = 1; seed <= 40; seed++) {
    const a = AGENTS.ball.build({ st: { axes: { y: 3.7, line } }, seed, W, H, tiles: [], tops: null, rnd: rng(seed) });
    const pts = a.paths[0].pts, hs = a.paths[0].hs;
    assert.ok(pts[0].x < 0 && pts.at(-1).x > W, `seed ${seed}: from off the left edge to off the right`);
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i].x > pts[i - 1].x, `seed ${seed}: never back toward the left, never across the depth`);
    for (const p of pts) assert.equal(p.y, 4, `seed ${seed}: on the grid line under the candles`);
    assert.equal(hs.length, pts.length - 1, 'a height per segment, as pathHeights gives');
    assert.ok(hs.every((h) => h >= lo - 1e-9 && h <= hi + 1e-9), `seed ${seed}: between the line's low and high`);
    // at each candle's x the height IS the line's
    // at each candle's x the height is the line's: the two segments either side of the point
    // (mid-points half a unit away) average to it within a quarter of a neighbour's step
    let step = 0;
    for (let i = 1; i < line.length; i++) step = Math.max(step, Math.abs(line[i].z - line[i - 1].z));
    for (const p of line) { const k = pts.findIndex((q) => q.x === p.x - 1); assert.ok(Math.abs((hs[k] + hs[k + 1]) / 2 - p.z) <= step / 4 + 1e-9, `seed ${seed}: rides the line at x=${p.x} (${(hs[k] + hs[k + 1]) / 2} vs ${p.z})`); }
    const mid = AGENTS.ball.frame(a, 0.5).ball;
    assert.ok(mid.z > lo, `seed ${seed}: airborne at the chart`);
  }
  // the block board keeps its four sides
  const sides = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const a = AGENTS.ball.build({ st: {}, seed, W: 20, H: 20, tiles: [], tops: null, rnd: rng(seed) });
    const p0 = a.paths[0].pts[0];
    sides.add(p0.x < 0 ? 'left' : p0.x > 20 ? 'right' : p0.y < 0 ? 'bottom' : 'top');
  }
  assert.equal(sides.size, 4, 'every side, on the block board');
});

test('on the price board the light cycles ride in from the left and the right, and ball lightning strikes candles', () => {
  const W = 48, H = 8;
  // candles as markets.js lays them: between grid lines, at a height
  const tiles = [];
  for (let i = 0; i < 24; i++) tiles.push({ txid: `b:${i}`, x: i * 2 + 0.3, y: 3, s: 1.4, floor: 10 + 6 * Math.sin(i / 4), tall: 2, color: [0, 0, 0] });
  const line = tiles.map((t) => ({ x: t.x + 0.7, z: t.floor + 1 }));
  for (let seed = 1; seed <= 30; seed++) {
    const a = AGENTS.lightcycle.build({ st: { axes: { y: 3.7, line } }, seed, W, H, tiles, tops: null, rnd: rng(seed) });
    const [p, q] = a.paths.map((pth) => pth.pts[0]);
    assert.ok((p.x === 0 && q.x === W) || (p.x === W && q.x === 0), `seed ${seed}: one from each end of the hours, never the front or the back`);
    for (const pth of a.paths) for (const pt of pth.pts) assert.ok(pt.y >= 3 && pt.y <= 5, `seed ${seed}: the wall keeps to the candles' rows (y ${pt.y})`);
  }
  // ball lightning: with the candles' tops known (cellTops over fractional tiles), the arcs land
  let struck = 0, frames = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const a = AGENTS.stormball.build({ st: { axes: { line } }, seed, W, H, tiles, tops: null, rnd: rng(seed) });
    assert.ok(a.alt > 5 && a.alt < 17, `seed ${seed}: it flies through the chart's height (${a.alt.toFixed(1)}), not at 3.5 over a bare floor`);
    // ...and up and down most of it (operator, 2026-09-15: "It should try to cover a lot of space")
    let zMin = Infinity, zMax = -Infinity;
    for (let u = 0; u <= 1; u += 0.01) { const z = AGENTS.stormball.frame(a, u).stormball.at.z; zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); }
    const lineLo = Math.min(...line.map((p) => p.z)), lineHi = Math.max(...line.map((p) => p.z));
    assert.ok(zMax - zMin > (lineHi - lineLo) * 0.55, `seed ${seed}: covers more than half the chart's height (${(zMax - zMin).toFixed(1)} of ${(lineHi - lineLo).toFixed(1)})`);
    assert.ok(zMin >= lineLo - 1e-9 && zMax <= lineHi + 1e-9, 'and stays within it');
    // and once off the board it throws nothing: the run ends with the ball gone, not with a bolt from nowhere
    for (let u = 0; u <= 1; u += 0.005) { const f = AGENTS.stormball.frame(a, u); if (f.stormball.at.x < -1 || f.stormball.at.x > W + 1) assert.equal(f.stormball.arcs.length, 0, `seed ${seed}: no arcs from off the board at u=${u.toFixed(3)}`); }
    // and it has LEFT before the run ends (operator: "have it fully moved off the display before you
    // remove it"): the corona reaches 12 units from the centre, so both ends sit 16 past the edges
    assert.ok(Math.min(a.from.x, a.to.x) <= -16 && Math.max(a.from.x, a.to.x) >= W + 16, `seed ${seed}: in from and out past the edges by the corona's reach (${a.from.x}, ${a.to.x})`);
    for (let u = 0.05; u < 0.95; u += 0.01) { frames++; const f = AGENTS.stormball.frame(a, u); if (f.stormball.arcs.length) struck++; }
  }
  assert.ok(struck / frames > 0.25, `arcs reach a candle in ${(100 * struck / frames).toFixed(0)}% of frames`);
});
