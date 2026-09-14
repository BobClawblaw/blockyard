// The slab field and its Tetris choreography.
//
// The obligation that dominates everything else: NO TWO SLABS EVER INTERSECT.
// There is no z-buffer and no clip here (the software-rasteriser incident
// forbids both), so overlap is not merely ugly -- two transactions would
// occupy the same space and the picture would be a lie. The design earns the
// guarantee by phase separation rather than path planning, and the test below
// checks it the only way worth checking: sample the whole flight and
// intersect every pair of boxes at every moment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SLAB_H, TILE_H, cubeHeight, project, depthOf, depthSort, shade, tileFaces,
  buildScene, fitToBox, planTransition, sampleTween, frameAt, airTop, fxAt, fxFront, landingOf, fallMs, bouncesUntil, restitutionOf,
  gravity, bounceDrop, bounceFor, bouncesFor, easeOutCubic, TRANSITION, altitudeView, visualBase, fallShare, capZ, sphereOf, surfaceNormal, flightRoom,
} from '../public/js/blockscene3d.js';
import { packBlock } from '../public/js/blockpack.js';
import { feeColor } from '../public/js/feepalette.js';
import { jitterOf as jitterOfTest } from '../public/js/blockscene3d.js';

const o = { unit: 10, zUnit: 8 };

function layout(seed, n = 60) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const txs = [];
  for (let i = 0; i < n; i++) txs.push({ txid: 't' + i, vsize: Math.floor(300 + rnd() * 9000), fee: Math.floor(rnd() * 30000) });
  return packBlock(txs, { resolution: 28 }).tiles;
}

const boxesOverlap = (a, b) =>
  a.x < b.x + b.s && b.x < a.x + a.s &&
  a.y < b.y + b.s && b.y < a.y + a.s &&
  a.z < b.z + cubeHeight(b) && b.z < a.z + cubeHeight(a);

test('every block is an actual cube: as tall as it is wide, its footprint still the vbytes', () => {
  // (operator, 2026-09-11: "They need to be actual cubes.") This reverses the
  // 2026-09-10 uniform-height slab on the operator's call. The footprint is
  // what carries the vbytes, exactly as before; the height is now its side.
  const small = { x: 0, y: 0, s: 2, color: feeColor(0), z: 0 };
  const big = { x: 8, y: 0, s: 5, color: feeColor(0), z: 0 };
  const hOf = (t) => tileFaces(t, o).topZ - tileFaces(t, o).base;
  assert.equal(hOf(small), 2, 'a two-unit block stands two units tall');
  assert.equal(hOf(big), 5, 'and a five-unit block five');
  assert.equal(cubeHeight(big), big.s);
  // the footprint -- the honest quantity -- is still the area on the grid; the
  // top is that footprint, drawn larger by the camera for being nearer it
  const f = tileFaces({ ...big, z: 0 }, { unit: 10 }).top;
  const k = 1 + big.s * 0.075 * 0.55;          // the default camera, at the cube's height
  assert.ok(Math.abs((f[1].x - f[0].x) / 10 - big.s * k) < 1e-9, 'the top is the footprint, scaled by the camera for its height');
});

test('every mover travels clear of the resting cubes under its path', () => {
  // A cube standing on the board is as tall as it is wide, so a block flying
  // over it must fly higher than it: the lanes start above the tallest resting
  // cube under each sweep. (The pairwise collision test checks it frame by frame.)
  const plan = planTransition(layout(5), layout(9), { now: 0 });
  const holds = plan.tweens.filter((t) => t.kind === 'hold').map((t) => t.to);
  const movers = plan.tweens.filter((t) => t.kind === 'move');
  assert.ok(movers.length > 5 && holds.length > 0, 'the fixture has both');
  for (const m of movers) {
    const s2 = Math.max(m.from.s, m.to.s);
    const x0 = Math.min(m.from.x, m.to.x), y0 = Math.min(m.from.y, m.to.y);
    const x1 = Math.max(m.from.x, m.to.x) + s2, y1 = Math.max(m.from.y, m.to.y) + s2;
    for (const r of holds) {
      const under = r.x < x1 && x0 < r.x + r.s && r.y < y1 && y0 < r.y + r.s;
      if (under) assert.ok(m.lane >= cubeHeight(r), `${m.txid} flies at ${m.lane.toFixed(2)}, clear of the ${r.s}-unit cube ${r.txid} under its path`);
    }
  }
});

test('the drop is gravity, and a block bounces until it comes to rest', () => {
  assert.equal(bounceDrop(0, 0.12, 3), 1, 'released at full height');
  assert.equal(bounceDrop(1, 0.12, 3), 0, 'and comes to rest exactly on the plane');
  // ACCELERATING, not easing: the second stretch of the fall covers more ground
  const d1 = bounceDrop(0, 0.12, 3) - bounceDrop(0.15, 0.12, 3);
  const d2 = bounceDrop(0.15, 0.12, 3) - bounceDrop(0.30, 0.12, 3);
  assert.ok(d2 > d1, `it speeds up into the floor (${d1.toFixed(3)} then ${d2.toFixed(3)})`);
  // (operator: "The blocks bouncing and coming to rest seems too abrupt. It
  // needs to really look like physics is making it come to rest naturally")
  // It keeps bouncing until the next hop would be imperceptible.
  for (const [b, r] of [[0.3, 0.55], [0.1, 0.42], [0.4, 0.68]]) {
    const n = bouncesUntil(b, r);
    assert.ok(n >= 1 && n <= 8, `between 1 and 8 hops, got ${n}`);
    assert.ok(n === 8 || b * r ** n <= 0.01 + 1e-12, 'and it stops once the next hop would be under 1% of the drop (heavier: "come to rest sooner")');
  }
  assert.ok(bouncesUntil(0.4, 0.68) > bouncesUntil(0.1, 0.42), 'a livelier block bounces more times');
  // the rebounds really happen, all the way down
  const rebounds = (n, r) => {
    let ups = 0, prev = bounceDrop(0, 0.3, n, r), rising = false;
    for (let i = 1; i <= 40000; i++) {
      const v = bounceDrop(i / 40000, 0.3, n, r);
      if (v > prev + 1e-12 && !rising) { ups++; rising = true; }
      if (v < prev - 1e-12) rising = false;
      prev = v;
    }
    return ups;
  };
  assert.equal(rebounds(9, 0.55), 9, 'nine hops means nine rebounds');
  assert.ok(bounceFor(12) < bounceFor(2), 'a big block bounces less than a small one');
  assert.ok(bounceFor(1) <= 0.4 && bounceFor(40) >= 0.1, 'bounded at both ends, and big enough to see');
});

test('each bounce is a sine arc, lower AND shorter than the last, as gravity says', () => {
  // (operator: "The bouncing needs to be sinusoidal and apply physics so each
  // bounce isn't the same length of time")
  const n = 4, first = 0.2, REST = 0.55;
  const N = 40000;
  const trace = Array.from({ length: N + 1 }, (_, i) => bounceDrop(i / N, first, n));
  // find each hop between successive touchdowns. A touchdown is a LOCAL
  // MINIMUM of the trace: sampled on a grid, it almost never lands on an
  // exact zero, so "the trace reached 0" finds nothing (the first version of
  // this test did exactly that and counted no hops at all).
  const touch = [];
  for (let i = 1; i < N; i++) if (trace[i] <= trace[i - 1] && trace[i] < trace[i + 1]) touch.push(i);
  const ends = [...touch.slice(1), N];
  const hops = touch.map((s, k) => ({ len: ends[k] - s, peak: Math.max(...trace.slice(s, ends[k] + 1)) }));
  const floorAt = touch[0];
  assert.equal(hops.length, n, `${n} hops`);
  for (let k = 1; k < hops.length; k++) {
    assert.ok(Math.abs(hops[k].peak / hops[k - 1].peak - REST) < 0.01, `each hop keeps ${REST} of the height (got ${(hops[k].peak / hops[k - 1].peak).toFixed(3)})`);
    assert.ok(Math.abs(hops[k].len / hops[k - 1].len - Math.sqrt(REST)) < 0.01, `and lasts sqrt(${REST}) = 0.74 as long (got ${(hops[k].len / hops[k - 1].len).toFixed(3)})`);
  }
  // the first hop is timed against the FALL: a rebound to 20% takes 2*sqrt(0.2) falls
  assert.ok(Math.abs(hops[0].len / floorAt - 2 * Math.sqrt(first)) < 0.01, `first hop = 2*sqrt(h) falls (got ${(hops[0].len / floorAt).toFixed(3)})`);
  // and a hop is a sine arc: at a quarter of its time it stands at sin(pi/4) of its peak
  const h0 = floorAt + 1;
  const q = trace[h0 + Math.round(hops[0].len / 4)];
  assert.ok(Math.abs(q / hops[0].peak - Math.SQRT1_2) < 0.01, `sine-shaped (quarter point ${(q / hops[0].peak).toFixed(3)})`);
});

test('gravity times each landing, so a higher drop takes longer and no two blocks finish together', () => {
  // (operator: "I don't get any sense of blocks falling and bouncing ... Need
  // much more randomness and variability in the sequences"). Every landing
  // used to be squeezed into one fixed window, so a one-unit drop floated down
  // as slowly as a twelve-unit one.
  assert.ok(Math.abs(fallMs(12) - 600) < 1e-6, 'a fall from 12 units takes 0.6 s (1.2 s "still doesn\'t seem strong enough", 2.4 s "slowly start dropping")');
  assert.ok(Math.abs(fallMs(3) / fallMs(12) - 0.5) < 1e-9, 'and a quarter of the height takes half the time: sqrt, as gravity says');
  const plan = planTransition(layout(5, 200), layout(9, 200), { now: 0, gridN: 44 });
  const landings = plan.tweens.filter((x) => x.kind === 'move' || x.kind === 'enter').map((tw) => ({ tw, L: landingOf(tw, plan) }));
  assert.ok(landings.length > 50, 'enough landings to judge');
  const lengths = landings.map(({ L }) => L.t1 - L.t0);
  // 2x until 2026-09-11; heavier blocks ("less bouncing ... more weight") settle
  // in one or two small hops, so the spread now comes mostly from the height
  assert.ok(Math.max(...lengths) / Math.min(...lengths) > 1.4, `landings differ in length (${(Math.max(...lengths) / Math.min(...lengths)).toFixed(2)}x)`);
  // 10 ms buckets: landings are fast since gravity went to 0.7 s per 12 units,
  // and ~200 of them in 50 ms buckets over a 6 s stagger must collide by pigeonhole
  const ends = landings.map(({ L }) => Math.round(L.t1 / 10));
  assert.ok(new Set(ends).size > landings.length * 0.6, 'and they finish at scattered moments');
  const spanMs = Math.max(...landings.map(({ L }) => L.t1)) - Math.min(...landings.map(({ L }) => L.t1));
  assert.ok(spanMs > 3000, `spread over ${(spanMs / 1000).toFixed(1)} s, not all at once`);
  const arrivals = landings.filter(({ tw }) => tw.kind === 'enter');
  if (arrivals.length > 1) assert.ok(new Set(arrivals.map(({ L }) => L.from.toFixed(2))).size > 1, 'arrivals fall from different heights');
  for (const { L } of landings) assert.ok(plan.settleAt >= L.t1, 'and the plan waits for the last one');
});

test('airborne blocks never grow into each other on screen, unless one is really above the other', () => {
  // (operator: "the large bouncing blocks intersect each other when growing in
  // size. We need to find a mitigation for that")
  const n = 28, unit = 6;
  const plan = planTransition(layout(5), layout(9), { now: 0, gridN: n });
  const v = { unit, risePerUnit: plan.cfg.risePerUnit, vanishX: n * unit / 2, vanishY: -n * unit / 2, persp: 0.55 };
  let checked = 0, grownFrames = 0;
  const trueHit = (p, q) => { const A = airTop(p, 1, v), B = airTop(q, 1, v); return Math.abs(A.x - B.x) < A.half + B.half - 1e-6 && Math.abs(A.y - B.y) < A.half + B.half - 1e-6; };
  for (let now = plan.phases.travel; now <= plan.settleAt; now += 120) {
    const fr = frameAt(plan, now, v);
    const air = fr.tiles.filter((t) => (t.z ?? 0) > 0.02);
    if (air.length < 2) continue;
    const boxOf = new Map();
    for (const op of fr.ops) if (op.face === 'top') {
      const xs = op.points.map((p) => p.x), ys = op.points.map((p) => p.y);
      boxOf.set(op.txid, { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
    for (let i = 0; i < air.length; i++) for (let j = i + 1; j < air.length; j++) {
      const a = air[i], b = air[j];
      const feet = a.x < b.x + b.s && b.x < a.x + a.s && a.y < b.y + b.s && b.y < a.y + a.s;
      if (feet) continue;   // one crossing over the other in travel: nothing can separate those
      if (trueHit(a, b)) continue;   // cubes: a taller top covers a shorter neighbour's edge at true size -- occlusion
      // (an exemption for pairs more than a slab apart in height was measured
      // at ~750 overlapping pairs a frame, and read as a heap)
      const A = boxOf.get(a.txid), B = boxOf.get(b.txid);
      const hit = A.x0 < B.x1 - 1e-6 && B.x0 < A.x1 - 1e-6 && A.y0 < B.y1 - 1e-6 && B.y0 < A.y1 - 1e-6;
      assert.ok(!hit, `${a.txid} (z=${a.z.toFixed(2)}) and ${b.txid} (z=${b.z.toFixed(2)}) overlap on screen at t=${now}`);
      checked++;
    }
    // near the plane, a block must not swell over its RESTING neighbours either:
    // a low bounce spilling over them reads as sinking into them
    const ground = fr.tiles.filter((t) => !((t.z ?? 0) > 0.02));
    for (const a of air) if (a.z < 2) for (const g of ground) {
      const feet = a.x < g.x + g.s && g.x < a.x + a.s && a.y < g.y + g.s && g.y < a.y + a.s;
      if (feet || trueHit(a, g)) continue;
      const A = boxOf.get(a.txid), G = boxOf.get(g.txid);
      const hit = A.x0 < G.x1 - 1e-6 && G.x0 < A.x1 - 1e-6 && A.y0 < G.y1 - 1e-6 && G.y0 < A.y1 - 1e-6;
      assert.ok(!hit, `${a.txid} (z=${a.z.toFixed(2)}) spills over resting ${g.txid} at t=${now}`);
    }
    if (air.some((t) => (t.z ?? 0) > 1)) grownFrames++;
  }
  assert.ok(checked > 500, `enough pairs were checked (${checked})`);
  assert.ok(grownFrames > 10, 'while blocks were genuinely up in the air and growing');
});

test('the oblique camera: height is a fixed offset, cubes keep their size, and they show their west and south faces', () => {
  // (operator: "offset something outside the screen bounds so things aren't
  // dropping directly down"; "Are they even proper cubes like I asked for?")
  const ob = { ox: 0.28, oy: 0.55, headroom: 10 };
  const v = { unit: 10, oblique: ob };
  const c = { x: 4, y: 4, s: 3, z: 0 };
  const f = tileFaces(c, v);
  assert.deepEqual(f.sides.map((x) => x.key).sort(), ['left', 'near'], 'every cube shows its west and south faces');
  assert.ok(Math.abs(f.top[0].x - (40 + 3 * ob.ox * 10)) < 1e-9 && Math.abs(f.top[0].y - (-40 - 3 * ob.oy * 10)) < 1e-9, 'its top sits its own height up and to the right');
  const w = (q) => q.top[1].x - q.top[0].x;
  const up = tileFaces({ ...c, z: 6 }, v);
  assert.ok(Math.abs(w(up) - w(f)) < 1e-9, 'in flight it keeps its size: nothing swells, so nothing is policed or flickers');
  assert.ok(up.top[0].y < f.top[0].y - 10, 'and rises visibly up the screen');
  const high = tileFaces({ ...c, z: 500 }, v);
  assert.ok(f.top[0].y - high.top[0].y <= ob.headroom * ob.oy * 10 + 1e-6, 'however high it flies, it stays inside the headroom');
});

test('the board is a patch of one real sphere, which carries on past it', () => {
  // (operator: "it would be more compelling if it was a partial spherical
  // board", then "A dome is the right analog for this. In fact, I want the
  // entire sphere to be textured as it is")
  const o2 = { unit: 10, dome: 12, gridW: 20, gridH: 20, oblique: { ox: 0.28, oy: 0.55, headroom: 10 } };
  for (const [gx, gy] of [[0, 0], [20, 0], [0, 20], [20, 20]]) {
    assert.ok(Math.abs(capZ(gx, gy, o2)) < 1e-9, `corner (${gx}, ${gy}) sits on the plane`);
  }
  const c = project(10, 10, 0, o2), flat = project(10, 10, 0, { unit: 10 });
  assert.ok(Math.abs(c.y - (flat.y - 12 * 0.55 * 10)) < 1e-9, 'the centre is raised by the full dome');
  const mid = capZ(0, 10, o2);
  assert.ok(mid > 0 && mid < 12, 'an edge midpoint in between: a cap, not a pillow');
  // past the board, on the shipped shape (a 40-unit board domed 5: radius 82.5)
  const o3 = { unit: 10, dome: 5, gridW: 40, gridH: 40, oblique: { ox: 0.13, oy: 0.32, headroom: 10 } };
  const s = sphereOf(o3);
  for (const [gx, gy] of [[3, 17], [20, 20], [-10, 20], [50, -5]]) {   // on the board and past it
    const d = Math.hypot(gx - s.cx, gy - s.cy, capZ(gx, gy, o3) + s.sink);
    assert.ok(Math.abs(d - s.R) < 1e-9, `(${gx}, ${gy}) lies on the one sphere`);
  }
  assert.ok(capZ(-10, 20, o3) < 0 && capZ(50, -5, o3) < capZ(-10, 20, o3), 'and past the board it curves away below the plane, further the further out');
  assert.equal(sphereOf({ unit: 10 }), null, 'no dome, no sphere: the plane');
});

test('blocks fly along the sphere\'s normal: straight out from where they sit', () => {
  // (operator: "Why do the blocks drift up and towards the right, and not
  // straight up relative to their position on the sphere?" -> "1. A dome is
  // the right analog for this")
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5, gridW: 40, gridH: 40 };
  assert.deepEqual(surfaceNormal(20, 20, v), { x: 0, y: 0, z: 1 }, 'at the top of the dome, straight up');
  const n = surfaceNormal(2, 30, v);
  assert.ok(n.x < 0 && n.y > 0 && Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-12, 'elsewhere tilted out, away from the middle');
  const move = (x, y) => {
    const a = tileFaces({ x, y, s: 2, z: 0.001 }, v).top[0], b = tileFaces({ x, y, s: 2, z: 8 }, v).top[0];
    return { dx: b.x - a.x, dy: b.y - a.y };
  };
  const left = move(1, 19), mid = move(19, 19), right = move(37, 19);
  assert.ok(left.dx < mid.dx && mid.dx < right.dx, 'across the board they fan out: the left side leans left, the right side right');
  assert.ok(move(19, 37).dy < mid.dy && mid.dy < move(19, 1).dy, 'and the far side leans further up the panel than the near side');
});

test('with the oblique camera, cubes that do not overlap paint back to front along the diagonal', () => {
  // (airborne-last was only ever a tie-break for cubes whose pictures do not
  // overlap, where the order is invisible; since 2026-09-11 the priority is the
  // footprint alone, so it cannot change from frame to frame)
  const v = { unit: 10, oblique: { ox: 0.28, oy: 0.55, headroom: 10 } };
  const near = { txid: 'near', x: 0, y: 0, s: 3, z: 0, color: feeColor(5) };
  const far = { txid: 'far', x: 10, y: 10, s: 3, z: 0, color: feeColor(5) };
  const flying = { txid: 'fly', x: 20, y: 20, s: 2, z: 4, color: feeColor(5) };
  const order = [...new Set(buildScene([near, flying, far], v).ops.filter((x) => x.face !== "shadow").map((x) => x.txid))];
  assert.ok(order.indexOf('far') < order.indexOf('near'), 'the far corner first, the near one after it');
  assert.equal(order.length, 3);
});

test('with the oblique camera a cube bouncing low BEHIND a tall one paints before it, not over it', () => {
  // (operator: "new blocks landing and bouncing is totally broken visually")
  // The old rule painted everything airborne last; the order now comes from
  // an axis that separates each overlapping pair.
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 8 } };
  const tall = { txid: 'tall', x: 0, y: 0, s: 6, z: 0, color: feeColor(5) };
  const low = { txid: 'low', x: 2, y: 7, s: 2, z: 0.5, color: feeColor(5) };       // rows flipped: y 7 is behind y 0..6
  const over = { txid: 'over', x: 1, y: 1, s: 2, z: 7, color: feeColor(5) };       // right above the tall one
  const order = [...new Set(buildScene([over, low, tall], v).ops.filter((x) => x.face !== 'shadow').map((x) => x.txid))];
  assert.deepEqual(order, ['low', 'tall', 'over'], 'behind it first, the one above it last');
  const ops = buildScene([over, low, tall], v).ops;
  assert.ok(ops.findLastIndex((x) => x.face === 'shadow') < ops.findIndex((x) => x.face !== 'shadow'), 'shadows lie on the floor, under every cube');
});

test('under the oblique camera a resting cube casts a short shadow down and to the right, on the floor', () => {
  // (operator, 2026-09-11: "a more interesting ground texture ... shows the shadows well")
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10 } };
  const t = { txid: 'r', x: 10, y: 10, s: 4, z: 0, color: feeColor(5) };
  const ops = buildScene([t], v).ops;
  const sh = ops.filter((x) => x.face === 'shadow');
  assert.ok(sh.length >= 1, 'a resting cube casts one');
  const cen = (pts) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });
  const foot = cen([project(10, 10, 0, v), project(14, 10, 0, v), project(14, 14, 0, v), project(10, 14, 0, v)]);
  const c = cen(sh.at(-1).points);
  assert.ok(c.x > foot.x && c.y > foot.y, 'away from the light: right of and below its footprint on screen');
  const reach = (s) => { const p = buildScene([{ ...t, s }], v).ops.filter((x) => x.face === 'shadow').at(-1).points; return Math.max(...p.map((q) => q.x)) - project(10 + s, 10, 0, v).x; };
  assert.ok(reach(8) > reach(2), 'longer the taller the cube');
  assert.ok(ops.findLastIndex((x) => x.face === 'shadow') < ops.findIndex((x) => x.face !== 'shadow'), 'and on the floor, under the cube');
});

test('an arrival starts wholly outside the canvas and comes down as its entry runs out', () => {
  // (operator, 2026-09-11: "I can see the new blocks spawning on screen. Have
  // the spawning happen off-screen for new blocks being dropped in")
  // THE RECT MUST BE A REAL ONE, AND EVERY SIZE MUST CLEAR IT. This guard passed for a year while
  // small blocks visibly materialised in view (operator, 2026-09-14), for two reasons: its viewRect
  // was invented with y1 = 44.8 where obliqueFit really returns 32.8 -- a panel far taller than any
  // that exists, so cubes cleared an edge that was not there -- and it only ever tried s = 2. The
  // lift is size-dependent, and 1x1 is the size that failed: measured 49px INSIDE the panel, against
  // 20px for a 2x2 and clear for a 6x6. A fixture more generous than the product tests nothing.
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5, gridW: 28, gridH: 28, viewRect: { x0: -14.2, x1: 42.2, y0: -4.8, y1: 32.8 } };
  for (const [x, y, s] of [[0, 0, 1], [26, 0, 1], [0, 26, 1], [26, 26, 1], [14, 14, 1],
                           [0, 0, 2], [26, 26, 2], [14, 14, 3], [10, 10, 6]]) {
    const t = { txid: 'n', x, y, s, z: 10, entry: 1, color: feeColor(5) };
    const pts = (tile) => { const f = tileFaces(tile, v); return [...f.top, ...f.sides.flatMap((q) => q.points)]; };
    // the panel: x x0..x1 across, rows y0..y1 up (flipped: screen y is -row)
    const r = v.viewRect;
    const inside = pts(t).some((p) => p.x >= r.x0 * v.unit && p.x <= r.x1 * v.unit && p.y >= -r.y1 * v.unit && p.y <= -r.y0 * v.unit);
    assert.ok(!inside, `a ${s}x${s} cube over (${x}, ${y}) starts off screen`);
    // "comes IN", not "comes down": flight follows the sphere's normal, so a front-corner cube leaves
    // through the side and slightly DOWN the screen (measured: (0,0) goes x -39 -> -217, y 0 -> 16).
    // Screen y alone was only ever true of the fixture's old centre-ish cubes.
    const at = (entry) => tileFaces({ ...t, entry }, v).top[0];
    const away = (entry) => Math.hypot(at(entry).x - at(0).x, at(entry).y - at(0).y);
    assert.ok(away(1) > away(0.5) && away(0.5) > 0, `and a ${s}x${s} cube over (${x}, ${y}) comes in as the entry runs out`);
  }
});

test('in a panel, a flight climbs the same at every spot and carries on past the edge', () => {
  // (operator, 2026-09-11: "the blocks can rise higher than they do during reshuffling") -- and then
  // (2026-09-14: "the blocks are wrapping at the viewport extents. They need to move off-screen
  // instead of bunching up at the extents"). Height used to stop at the panel's edge, so on a
  // narrow panel the rim cubes piled up along it. Now nothing in a flight's height comes from the
  // canvas: a cube over the back row flies exactly as high as one at the front, and one near an
  // edge at a travel lane's height is drawn past that edge.
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 }, dome: 5, gridW: 44, gridH: 44, viewRect: { x0: -4.8, x1: 48.8, y0: -4.8, y1: 48.8 } };
  const front = { txid: 'f', x: 20, y: 2, s: 2, z: 40 }, back = { txid: 'b', x: 20, y: 40, s: 2, z: 40 };
  assert.ok(visualBase(front, v) > 30, `a flight climbs high (${visualBase(front, v).toFixed(1)})`);
  assert.equal(visualBase(front, v), visualBase(back, v), 'and the same over the back row as the front: the panel does not cap it');
  const narrow = { ...v, viewRect: { x0: -2, x1: 46, y0: -4.8, y1: 48.8 } };
  assert.equal(visualBase(front, narrow), visualBase(front, v), 'nor does a narrower panel');
  const r = v.viewRect;
  for (const t of [{ txid: 'rim-left', x: 0, y: 20, s: 1 }, { txid: 'rim-right', x: 43, y: 20, s: 1 }, { txid: 'back', x: 20, y: 43, s: 1 }]) {
    const f = tileFaces({ ...t, z: 58 }, v);
    const pts = [...f.top, ...f.sides.flatMap((q) => q.points)];
    const inside = pts.some((p) => p.x >= r.x0 * 10 && p.x <= r.x1 * 10 && p.y >= -r.y1 * 10 && p.y <= -r.y0 * 10);
    assert.ok(!inside, `${t.txid}: at a high lane it is off the panel, not parked on its edge`);
  }
});

test('every mover lifts well clear of the board', () => {
  // a block with nothing under its path used to skim a lane-gap above the board
  const plan = planTransition(layout(5), layout(9), { now: 0 });
  const movers = plan.tweens.filter((t) => t.kind === 'move');
  assert.ok(movers.length > 5, 'the fixture has movers');
  assert.ok(plan.cfg.liftMin >= 6, 'a real lift');
  for (const m of movers) assert.ok(m.lane >= 0.55 * plan.cfg.liftMin - 1e-9, `${m.txid} lifts to ${m.lane.toFixed(1)}`);
  assert.ok(new Set(movers.map((m) => m.lane.toFixed(2))).size > movers.length / 2, 'each to a height of its own, so no two drops are alike');
});

test('with the oblique camera a cube in flight never leaves the frame, however big', () => {
  // A 12-unit cube with only its base compressed reached 20 units into a
  // 13-unit strip and flew off the top of the canvas.
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 8 }, dome: 5 };
  for (const s of [1, 4, 12]) for (const z of [1, 10, 40, 400]) {
    assert.ok(altitudeView(z, v, s) + s <= 8 + 5 + 1.5 + 1e-9, `side ${s} at ${z}: top within the headroom`);
  }
  assert.ok(Math.abs(altitudeView(0.01, v, 1) - 0.01) < 1e-4, 'and near the floor it is the identity');
});

test('idle effects: the outline pulse crosses the board lighting outlines, with a trail behind it', () => {
  // (operator: "Maybe add an energy pulse that travels along from one side of
  // the board to another via block outlines. Be creative and varied")
  const fx = { kind: 'outline', u: 0.5, amp: 1, gridW: 40, gridH: 40, dx: 1, dy: 0 };
  const p = fxFront(fx);
  const at = (x) => fxAt({ txid: 'q', x: x - 1, y: 10, s: 2 }, fx);
  assert.ok(at(p).outline > 0.9, 'a cube on the front is outlined');
  assert.ok(at(p + 12).outline < 0.01, 'one far ahead of it is not');
  const behind = at(p - 4).outline;
  assert.ok(behind > 0.05 && behind < at(p).outline, 'one it has passed keeps a fading trail');
  assert.deepEqual(at(p).color, [90, 230, 255]);
  assert.ok(fxFront({ ...fx, u: 0 }) < 0 && fxFront({ ...fx, u: 1 }) > 40, 'it enters from outside one side and leaves past the other');
});

test('idle effects: the tide lifts cubes, the cascade runs richest to cheapest, twinkles are scattered', () => {
  const tide = { kind: 'tide', u: 0.5, amp: 1, gridW: 40, gridH: 40, dx: 0, dy: 1 };
  const onFront = { txid: 'a', x: 10, y: fxFront(tide) - 1, s: 2 };
  assert.ok(fxAt(onFront, tide).lift > 0.8, 'the tide lifts a cube it passes under');
  const lifted = tileFaces({ ...onFront, fxz: 0.9 }, { unit: 10 }), flat = tileFaces(onFront, { unit: 10 });
  assert.ok(lifted.topZ > flat.topZ, 'and tileFaces raises it');

  const rank = new Map([['rich', 0], ['cheap', 1]]);
  const casc = (u) => ({ kind: 'cascade', u, amp: 1, gridW: 40, gridH: 40, rank });
  const g = (id, u) => fxAt({ txid: id, x: 0, y: 0, s: 2 }, casc(u)).glow;
  assert.ok(g('rich', 0.1) > g('cheap', 0.1), 'early on the richest is lit');
  assert.ok(g('cheap', 0.85) > g('rich', 0.85), 'late on the cheapest');

  const tw = { kind: 'twinkle', u: 0.5, amp: 1, gridW: 40, gridH: 40, seed: 7 };
  let twinkling = 0;
  for (let i = 0; i < 400; i++) if (jitterOfTest('t' + i, 'tw7') <= 0.45) twinkling++;
  assert.ok(twinkling > 120 && twinkling < 240, `a bit under half the cubes take part (${twinkling} of 400)`);
  // `hide` and `scale` joined the shape on 2026-09-13 so an agent may eat or collapse a cube and
  // have it snap back (they are applied per frame onto a COPY of the tile, never to the tile).
  // The literal shape is still worth pinning: this is what "nothing is happening to this cube"
  // means, and a wrong default here would hide the board while any effect ran.
  assert.deepEqual(fxAt({ txid: 'x', x: 0, y: 0, s: 1 }, null),
    { glow: 0, outline: 0, lift: 0, color: null, hide: 0, scale: 1 }, 'no effect, no change');
});

test('an idle effect draws glowing outlines as thick rgba strokes, and never touches blocks in the air', () => {
  const fx = { kind: 'outline', u: 0.5, amp: 1, gridW: 40, gridH: 40, dx: 1, dy: 0 };
  const x = fxFront(fx) - 1;
  const ops = buildScene([{ txid: 'r', x, y: 5, s: 2, z: 0, color: feeColor(5) }, { txid: 'f', x, y: 20, s: 2, z: 3, color: feeColor(5) }], { unit: 10, fx }).ops;
  const outline = ops.find((o2) => o2.face === 'outline');
  assert.ok(outline && outline.txid === 'r', 'the resting cube is outlined');
  assert.match(outline.stroke, /^rgba\(90,230,255,[\d.]+\)$/);
  assert.ok(outline.lw > 2, 'thicker than the seam');
  assert.ok(!ops.some((o2) => o2.txid === 'f' && (o2.face === 'outline' || o2.face === 'glow')), 'the airborne one is left alone');
});

test('no two slabs ever intersect, at any moment of the whole transition', () => {
  const a = layout(5);
  const b = layout(9);
  const plan = planTransition(a, b, { now: 0 });
  const end = plan.settleAt + 200;
  let sampled = 0, airborne = 0;
  for (let now = -50; now <= end; now += 40) {
    const live = plan.tweens.map((tw) => sampleTween(tw, now, plan)).filter(Boolean);
    sampled++;
    if (live.some((t) => (t.z ?? 0) > 0.01)) airborne++;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        assert.equal(boxesOverlap(live[i], live[j]), false,
          `${live[i].txid} and ${live[j].txid} intersect at t=${now}`);
      }
    }
  }
  assert.ok(sampled > 100, 'the flight was actually sampled densely');
  assert.ok(airborne > 20, 'and tiles genuinely left the plane during it');
});

test('everything starts and ends flat on the plane', () => {
  const a = layout(5), b = layout(9);
  const plan = planTransition(a, b, { now: 0 });
  for (const tw of plan.tweens) {
    const s0 = sampleTween(tw, plan.phases.t0, plan);
    if (s0 && tw.kind !== 'enter') assert.equal(s0.z, 0, `${tw.txid} starts on the plane`);
    const s1 = sampleTween(tw, plan.settleAt, plan);
    if (s1) assert.ok(Math.abs(s1.z) < 1e-9, `${tw.txid} ends flat on the plane, got z=${s1.z}`);
  }
});

test('the transition lasts at least five seconds', () => {
  const plan = planTransition(layout(5), layout(9), { now: 0 });
  // 30 s end to end (operator, 2026-09-10). That is LONGER than the 20 s data
  // refresh, so a transition overlaps the next poll on purpose; the renderer's
  // replan guard is what stops an unchanged layout restarting it.
  // 40 s since 2026-09-11 ("at least 40 seconds if it's refreshed every 60 seconds")
  // 20 s since the viewer refreshes every 30 s ("Faster refresh")
  assert.equal(plan.duration, 20000);
  assert.ok(plan.settleAt >= 20000, 'and nothing settles before it');
  assert.ok(plan.settleAt < 30000, `and it has landed before the next refresh (${plan.settleAt} ms)`);
});

test('translation is smooth, and still arrives exactly on the grid', () => {
  // Whole-cell stepping WAS the jitter: at 20 s of travel a ten-cell move is
  // a jump every two seconds, which reads as teleporting. It glides now.
  const from = { txid: 'p', x: 0, y: 0, s: 2, rate: 5, color: feeColor(5) };
  const to = { txid: 'p', x: 8, y: 3, s: 2, rate: 5, color: feeColor(5) };
  const plan = planTransition([from], [to], { now: 0 });
  const tw = plan.tweens.find((x) => x.kind === 'move');
  const xs = [];
  for (let n = plan.phases.rise; n < plan.phases.travel; n += 200) xs.push(sampleTween(tw, n, plan).x);
  const distinct = new Set(xs.map((v) => v.toFixed(4))).size;
  assert.ok(distinct > 20, `it moves continuously, saw ${distinct} distinct positions`);
  // monotonic: no backtracking, which is what a jitter would look like
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] - 1e-9, 'and never jitters backwards');
  // and the RESTING positions -- the ones that must line up with the drawn
  // grid -- are exact
  const end = sampleTween(tw, plan.settleAt, plan);
  assert.deepEqual({ x: end.x, y: end.y, z: end.z }, { x: 8, y: 3, z: 0 }, 'it lands exactly on its cell');
});
test('the block is still high early in the drop, because it is accelerating', () => {
  // With a bounce SERIES the fall is only the first stretch of the drop
  // phase -- the rest is hops -- so the old "halfway down at the halfway
  // mark" reading no longer describes the motion. Check inside the fall.
  const plan = planTransition(layout(5), layout(9), { now: 0 });
  const mover = plan.tweens.find((x) => x.kind === 'move');
  const { t0, t1 } = landingOf(mover, plan);
  const at = (f) => sampleTween(mover, t0 + (t1 - t0) * f, plan).z;
  assert.ok(at(0.05) > mover.lane * 0.85, 'barely moved a twentieth of the way in');
  assert.ok(at(0.99) < mover.lane * 0.2, 'and near the floor by the end');
  assert.equal(sampleTween(mover, plan.settleAt, plan).z, 0, 'coming to rest exactly');
});
test('a landed block flashes its lock, briefly, on its OWN beat', () => {
  const plan = planTransition(layout(5), layout(9), { now: 0 });
  const mover = plan.tweens.find((t) => t.kind === 'move');
  // each block lands at its own moment now, so the lock is keyed to that
  const landsAt = landingOf(mover, plan).t1;
  assert.equal(sampleTween(mover, landsAt - 1, plan).lock, 0, 'not before it lands');
  assert.ok(sampleTween(mover, landsAt, plan).lock > 0.9, 'bright the instant it locks');
  assert.equal(sampleTween(mover, landsAt + plan.cfg.lockMs + 1, plan).lock, 0, 'and over quickly');
});

test('landings are staggered and bounce to different heights', () => {
  // "Everything is too uniform on landing": they all touched down on the same
  // frame and rebounded by the same amount.
  const plan = planTransition(layout(5), layout(9), { now: 0 });
  const movers = plan.tweens.filter((x) => x.kind === 'move');
  assert.ok(movers.length > 5, 'the fixture moves enough blocks to compare');

  const lands = movers.map((m) => (m.jitter ?? 0) * plan.cfg.dropStagger);
  assert.ok(new Set(lands.map((v) => v.toFixed(1))).size > 3, 'they land at different moments');
  assert.ok(Math.max(...lands) - Math.min(...lands) > 200, 'and the spread is visible, not a rounding difference');
  assert.ok(Math.max(...lands) <= plan.cfg.dropStagger + 1e-9, 'inside the stagger window');

  // the same block must get the SAME beat every time, or it shimmers
  const again = planTransition(layout(5), layout(9), { now: 5000 });
  for (const m of movers) {
    const twin = again.tweens.find((x) => x.txid === m.txid && x.kind === 'move');
    if (twin) assert.equal(twin.jitter, m.jitter, `${m.txid} keeps its character across replans`);
  }

  // heights differ too, and everything still comes to rest exactly on the plane
  const zs = movers.map((m) => sampleTween(m, landingOf(m, plan).t1 - 60, plan).z);
  assert.ok(new Set(zs.map((v) => v.toFixed(3))).size > 3, 'and rebound to different heights');
  for (const m of movers) {
    assert.equal(sampleTween(m, plan.settleAt, plan).z, 0, `${m.txid} still ends flat on the plane`);
  }
});

test('movers whose paths overlap fly in disjoint altitude intervals, each as tall as the cube', () => {
  // PER LEG (2026-09-14). Travel is two legs, every first leg in the first half of the phase and every
  // second leg in the second, so a first leg can only meet another mover's first leg. The rule used to
  // be one box round the whole L, which on the live pool stacked 201 movers 110 units up; per leg it
  // is 58. The geometric proof is the test above -- no two slabs intersect at any sampled moment --
  // and this pins the bookkeeping that makes it true.
  const plan = planTransition(layout(5), layout(9), { now: 0 });
  const movers = plan.tweens.filter((t) => t.kind === 'move');
  assert.ok(movers.length > 3, 'the fixture actually moves things');
  const box = (x0, y0, x1, y1, s2) => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1) + s2, y1: Math.max(y0, y1) + s2 });
  const legs = (m) => {
    const s2 = Math.max(m.from.s, m.to.s);
    const xFirst = (m.jitter ?? 0) < 0.5;              // sampleTween's own choice of which axis leads
    const cx = xFirst ? m.to.x : m.from.x, cy = xFirst ? m.from.y : m.to.y;
    return { legs: [box(m.from.x, m.from.y, cx, cy, s2), box(cx, cy, m.to.x, m.to.y, s2)], lo: m.lane, hi: m.lane + s2 };
  };
  const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  let pairs = 0;
  for (let i = 0; i < movers.length; i++) for (let j = i + 1; j < movers.length; j++) {
    const a = legs(movers[i]), b = legs(movers[j]);
    if (!hit(a.legs[0], b.legs[0]) && !hit(a.legs[1], b.legs[1])) continue;
    pairs++;
    assert.ok(a.hi <= b.lo + 1e-9 || b.hi <= a.lo + 1e-9, `${movers[i].txid} [${a.lo.toFixed(2)}, ${a.hi.toFixed(2)}] and ${movers[j].txid} [${b.lo.toFixed(2)}, ${b.hi.toFixed(2)}] share altitude`);
  }
  assert.ok(pairs > 0, 'some paths do overlap, so the rule was exercised');
  // and the parking altitudes clear every interval
  const top = Math.max(...movers.map((m) => m.lane + Math.max(m.from.s, m.to.s)));
  assert.ok(plan.cfg.exitTo >= top - 1e-9 && plan.cfg.enterFrom > plan.cfg.exitTo, 'departures and arrivals park above them all');
});

test('a cube shows the sides that face the camera, and none directly under it', () => {
  const v = { unit: 10, vanishX: 200, vanishY: -200, risePerUnit: 0.03, persp: 0.55 };
  const keys = (t) => tileFaces(t, v).sides.map((x) => x.key).sort();
  // left of and below the vanishing point (screen y runs down, rows up): its
  // right side and its far (upper) side face the camera
  assert.deepEqual(keys({ x: 0, y: 0, s: 6, z: 0 }), ['far', 'right']);
  // right of and above it: the left side and the near (lower) side
  assert.deepEqual(keys({ x: 30, y: 30, s: 6, z: 0 }), ['left', 'near']);
  // straddling the vanishing point: no side faces it
  assert.deepEqual(keys({ x: 17, y: 17, s: 6, z: 0 }), [], 'dead under the camera, only the top shows');
  // a side is drawn between the top edge and the footprint edge, as a quad
  for (const sd of tileFaces({ x: 0, y: 0, s: 6, z: 0 }, v).sides) assert.equal(sd.points.length, 4);
});

test('the grid is a SQUARE, straight on -- no diamond, no rotation', () => {
  // A step across is purely horizontal, a step back is purely vertical, and
  // height moves a block straight up the screen. That is what makes the grid
  // a true square and every cell square with it.
  const a = project(0, 0, 0, o);
  assert.deepEqual(project(1, 0, 0, o), { x: a.x + 10, y: a.y }, '+x is purely horizontal');
  // rows run UP the screen: row 0 is the bottom, where the richest sit
  assert.deepEqual(project(0, 1, 0, o), { x: a.x, y: a.y - 10 }, '+y is purely vertical, upward');
  // the third axis is height TOWARD the viewer: a risen block grows outward
  const up = project(0, 0, 1, { ...o, vanishX: 100, vanishY: 100 });
  assert.ok(Math.abs(up.x - 100) > Math.abs(a.x - 100), 'the third axis brings a block TOWARD the viewer, growing outward');
  // the four corners of a square grid are an axis-aligned square on screen
  const c = [[0, 0], [8, 0], [8, 8], [0, 8]].map(([x, y]) => project(x, y, 0, o));
  assert.equal(c[0].y, c[1].y, 'the bottom edge is level');
  assert.equal(c[0].x, c[3].x, 'left edge is plumb');
  assert.equal(c[1].x - c[0].x, Math.abs(c[3].y - c[0].y), 'and the grid is square, not a rhombus');
});

test('a risen block comes toward the viewer, and the growth is bounded', () => {
  const v = { ...o, vanishX: 200, vanishY: 200 };
  const dist = (p) => Math.hypot(p.x - 200, p.y - 200);
  assert.ok(dist(project(0, 0, 10, v)) > dist(project(0, 0, 0, v)), 'rising moves outward from the vanishing point');
  assert.ok(dist(project(0, 0, 40, v)) > dist(project(0, 0, 10, v)), 'monotonically');

  // Growth is what the renderer has to reserve margin for, so the plan bounds
  // it by shrinking the perspective as the lane stack grows -- NOT by wrapping
  // lanes, which would put conflicting movers at one altitude (it did, once,
  // and the pairwise collision test caught it).
  const plan = planTransition(layout(5), layout(9), { now: 0, gridN: 44 });
  const lanes = plan.tweens.filter((x) => x.kind === 'move').map((x) => x.lane);
  assert.equal(new Set(lanes).size >= 1, true);
  const growth = Math.min(plan.cfg.maxLane, plan.cfg.camCeiling) * plan.cfg.risePerUnit * 0.55;
  assert.ok(growth <= plan.cfg.maxGrowth + 1e-9, `growth ${growth.toFixed(3)} within the reserved ${plan.cfg.maxGrowth}`);
});

test('the camera is a constant of the board, not of the round', () => {
  // THE BUG (operator: "the initial view on load is buggy, it has dark
  // triangles, but things return to normal on the first animation").
  // risePerUnit was derived from THIS round's lane stack. The first paint is
  // a no-op self-transition with one lane, so it got the shallow-stack value
  // -- nearly 3x the depth scaling of a busy round -- and drew every cube's
  // dark front lip that much too tall. Either side of the vanishing line the
  // lip flips from pointing up to pointing down through a degenerate
  // triangle, and at that size the wedges were plainly visible.
  const quiet = planTransition(layout(9), layout(9), { now: 0, gridN: 44 });
  const busy = planTransition(layout(2), layout(30), { now: 0, gridN: 44 });
  assert.ok(busy.tweens.filter((x) => x.kind === 'move').length > 0, 'the busy plan really moves things');
  assert.equal(quiet.cfg.risePerUnit, busy.cfg.risePerUnit, 'same board, same camera');

  // and it really is a function of the board: a different grid, a different
  // camera, but still one value for every round on it
  const small = planTransition(layout(9), layout(9), { now: 0, gridN: 16 });
  assert.notEqual(small.cfg.risePerUnit, quiet.cfg.risePerUnit);
});
test('a block is a Tetris cell with a hollow well -- all rgba, in paint order', () => {
  // 2026-09-11 (operator: "Consider a more tetris look for our blocks, but
  // think cyber/futuristic", then "The blocks don't have that hollow inner
  // area. I don't like the diagonal lines in our large block design"). Built
  // from solid polygons in paint ORDER -- the only depth mechanism allowed
  // here -- so the order is the thing to pin.
  const { ops } = buildScene([{ txid: 'a', x: 0, y: 0, s: 6, z: 0, color: feeColor(40), alpha: 0.5 }], o);
  assert.deepEqual(ops.map((x) => x.face).filter((x) => x !== 'side'),   // sides depend on where the camera is
    ['top', 'bevel', 'bevel', 'bevel', 'bevel', 'face', 'wall', 'wall', 'wall', 'wall', 'floor', 'rim'],
    'the lip, the square, its raised frame, the face, then the well sunk into it');
  assert.equal(ops.find((x) => x.face === 'top').points.length, 4, 'a square cell');
  assert.ok(!ops.some((x) => ['crown', 'glint', 'star', 'sparkle', 'sheen', 'gloss'].includes(x.face)), 'no gem cut, no diagonal sheen');
  for (const op of ops) {
    assert.match(op.fill, /^rgba\(\d+,\d+,\d+,[\d.]+\)$/);
    assert.equal(op.alpha, undefined, 'no bare alpha a renderer could push through globalAlpha');
  }
  const lum = (f) => { const [r, g, b] = f.match(/[\d.]+/g).map(Number); return r + g + b; };
  // the raised frame is lit from the upper left: far, left, right, near in falling brightness
  const bev = ops.filter((x) => x.face === 'bevel').map((x) => lum(x.fill));
  assert.ok(bev[0] > bev[1] && bev[1] > bev[2] && bev[2] > bev[3], `frame: far > left > right > near, got ${bev.join(' ')}`);
  // the well is lit the OTHER way round -- that inversion is what reads as a hollow
  const wall = ops.filter((x) => x.face === 'wall').map((x) => lum(x.fill));
  assert.ok(wall[0] < wall[1] && wall[1] < wall[2] && wall[2] < wall[3], `well: far < left < right < near, got ${wall.join(' ')}`);
  const face = lum(ops.find((x) => x.face === 'face').fill);
  assert.ok(lum(ops.find((x) => x.face === 'floor').fill) < face, 'and its floor sits darker than the face');
  const rim = ops.find((x) => x.face === 'rim');
  assert.equal(rim.fill, 'rgba(0,0,0,0)', 'the rim is a line, not a fill');
  assert.match(rim.stroke, /^rgba\(\d+,\d+,\d+,[\d.]+\)$/, 'stroked in a lifted tint round the lip of the well');
  // and the face is the feerate
  const other = buildScene([{ txid: 'a', x: 0, y: 0, s: 6, z: 0, color: feeColor(2), alpha: 0.5 }], o).ops;
  assert.notEqual(other.find((x) => x.face === 'face').fill, ops.find((x) => x.face === 'face').fill);
  // the lock is a flash across the cell, not a sparkle
  const locked = buildScene([{ txid: 'a', x: 0, y: 0, s: 6, z: 0, color: feeColor(40), lock: 0.8 }], o).ops.map((x) => x.face);
  assert.ok(locked.includes('flash') && !locked.includes('sparkle'));
});

test('detail comes in by size, so a tiny block is not a smear of polygons', () => {
  const cut = (s) => buildScene([{ txid: 'a', x: 0, y: 0, s, z: 0, color: feeColor(40) }], { ...o, facetMinUnits: 3, crownMinUnits: 5 }).ops.map((x) => x.face);
  assert.deepEqual(cut(2).filter((x) => x !== 'side'), ['top'], 'below the frame size: a plain cube');
  assert.ok(cut(4).includes('bevel') && cut(4).includes('face') && !cut(4).includes('wall'), 'a frame and face, no well yet');
  assert.ok(cut(6).includes('wall') && cut(6).includes('floor') && cut(6).includes('rim'), 'a large block gets the well');
});

test('outlines fade with their tile', () => {
  // THE BUG (operator: "the black outlines for disappearing blocks do not fade
  // out"): the seam was stroked in one fixed colour whatever the tile's alpha,
  // so a departing block's fill faded while its black frame stayed at full
  // strength until the tile was dropped.
  const stroke = (alpha) => buildScene([{ txid: 'a', x: 0, y: 0, s: 2, z: 0, color: feeColor(40), alpha }], { ...o, seamAlpha: 0.4 })
    .ops.find((x) => x.face === 'top').stroke;
  assert.equal(stroke(1), 'rgba(0,0,0,0.4)');
  assert.equal(stroke(0.25), 'rgba(0,0,0,0.1)', 'a quarter-faded tile has a quarter-strength seam');
  assert.equal(stroke(0), 'rgba(0,0,0,0)', 'and a gone one has none');
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.ok(/ctx\.strokeStyle = op\.stroke/.test(src), 'the renderer strokes with the op\'s own colour');
  assert.ok(!/edgeColor/.test(src), 'and the fixed seam colour is gone');
});

test('an airborne block casts a shadow at its TRUE footprint, between the board and the air', () => {
  // (operator: "consider casting shadows from above on the movements")
  const resting = { txid: 'r', x: 0, y: 0, s: 3, z: 0, color: feeColor(5) };
  const low = { txid: 'l', x: 10, y: 10, s: 3, z: 0.5, color: feeColor(40) };
  const high = { txid: 'h', x: 20, y: 4, s: 3, z: 8, color: feeColor(90) };
  const v = { ...o, vanishX: 150, vanishY: -150, risePerUnit: 0.03 };
  const { ops } = buildScene([resting, low, high], v);
  const firstShadow = ops.findIndex((x) => x.face === 'shadow');
  const lastRestingOp = ops.map((x) => x.txid).lastIndexOf('r');
  const firstAir = ops.findIndex((x) => x.txid !== 'r' && x.face !== 'shadow');
  assert.ok(firstShadow > lastRestingOp, 'shadows fall ON the resting stones');
  assert.ok(firstAir > firstShadow && ops.slice(firstAir).every((x) => x.face !== 'shadow'), 'and UNDER everything in the air');
  assert.equal(ops.filter((x) => x.face === 'shadow' && x.txid === 'r').length, 0, 'a resting stone casts none');
  // the shadow falls just down-right of its slot (light from above, upper
  // left), further the higher the block: that gap is what reads as LIFTED
  // toward the viewer. Straight under, a spreading shadow read as a dark ring
  // round a block sinking into a hole (operator: "It looks like the cubes are
  // bouncing from below, not from above").
  const centre = (id) => { const p = ops.filter((x) => x.face === 'shadow' && x.txid === id).at(-1).points; return { x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length }; };
  const drift = (t) => { const c = centre(t.txid), s = project(t.x + t.s / 2, t.y + t.s / 2, 0, v); return { dx: c.x - s.x, dy: c.y - s.y }; };
  assert.ok(drift(high).dx > 0 && drift(high).dy > 0, 'cast down and to the right of its slot');
  assert.ok(drift(high).dx > drift(low).dx, 'and further from it the higher the block');
  assert.ok(drift(high).dx < v.unit * 2.5, 'but still beside the slot, not somewhere else');
  // and it pales as the block climbs
  const alphaOf = (id) => Number(ops.filter((x) => x.face === 'shadow' && x.txid === id).at(-1).fill.match(/[\d.]+\)$/)[0].slice(0, -1));
  assert.ok(alphaOf('l') > alphaOf('h'), 'darker just above the plane than high in the air');
});

test('a lifted block moves OUTWARD and grows, through a real camera, and stays on the board', () => {
  // (operator: "I think we need to have blocks moving outwards instead of
  // directly up. Having issues really selling the 3D-ness of it")
  const plan = planTransition(layout(5), layout(9), { now: 0, gridN: 44 });
  const unit = 6, n = 44;
  const v = { unit, risePerUnit: plan.cfg.risePerUnit, vanishX: n * unit / 2, vanishY: -n * unit / 2, persp: 0.55 };
  const box = (t) => { const f = tileFaces(t, v); const xs = f.top.map((p) => p.x), ys = f.top.map((p) => p.y); return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, w: Math.max(...xs) - Math.min(...xs) }; };
  const fromV = (c) => Math.hypot(c.x - v.vanishX, c.y - v.vanishY);
  for (const corner of [{ x: 0, y: 0 }, { x: n - 4, y: 0 }, { x: 0, y: n - 4 }, { x: n - 4, y: n - 4 }, { x: 14, y: 26 }]) {
    const rest = box({ ...corner, s: 4, z: 0 });
    const rt = tileFaces({ ...corner, s: 4, z: 0 }, v).top;
    const lo = { x: Math.min(0, ...rt.map((p) => p.x)), y: Math.min(-n * unit, ...rt.map((p) => p.y)) };
    const hi = { x: Math.max(n * unit, ...rt.map((p) => p.x)), y: Math.max(0, ...rt.map((p) => p.y)) };
    let prevW = rest.w, prevD = fromV(rest);
    for (const z of [0.5, 3, plan.cfg.maxLane, plan.cfg.exitTo, plan.cfg.enterFrom]) {
      const up = box({ ...corner, s: 4, z });
      const f = tileFaces({ ...corner, s: 4, z }, v);
      // held inside the board (or the block's own resting top, whichever reaches further)
      for (const p of [...f.top, ...f.sides.flatMap((x) => x.points)]) {
        assert.ok(p.x >= lo.x - 1e-6 && p.x <= hi.x + 1e-6 && p.y >= lo.y - 1e-6 && p.y <= hi.y + 1e-6, `every corner stays on the board at z=${z.toFixed(1)}`);
      }
      assert.ok(up.w >= prevW - 1e-9, 'never smaller the higher it is');
      if (corner.x === 14) {
        // an interior block has room: it goes OUT along the ray from the centre, as a real camera shows it
        const cross = (rest.x - v.vanishX) * (up.y - v.vanishY) - (rest.y - v.vanishY) * (up.x - v.vanishX);
        assert.ok(Math.abs(cross) / (fromV(rest) * fromV(up)) < 1e-9, `on the ray from the centre at z=${z.toFixed(1)}`);
        // never nearer the higher it is, and strictly further until the 2x cap on the swell is reached
        assert.ok(fromV(up) >= prevD - 1e-9, `and never nearer the centre the higher it is (z=${z.toFixed(1)})`);
        if (z === 3) assert.ok(fromV(up) > fromV(rest) + 1, 'and plainly further out than at rest');
        if (z === 0.5) assert.ok(up.w / rest.w > 1.03, 'even a half-unit hop is visibly nearer');
      }
      prevW = up.w; prevD = fromV(up);
    }
  }
});

test('arrivals fall in along the camera ray onto their slot; departures rise back out along it and fade', () => {
  const unit = 6, n = 44;
  const A = { txid: 'a', x: 1, y: 1, s: 3, rate: 10, color: feeColor(10) };
  const B = { txid: 'b', x: 14, y: 26, s: 3, rate: 60, color: feeColor(60) };   // interior, off-centre
  const enterPlan = planTransition([A], [A, B], { now: 0, gridN: n });
  const exitPlan = planTransition([A, B], [A], { now: 0, gridN: n });
  const v = { unit, risePerUnit: enterPlan.cfg.risePerUnit, vanishX: n * unit / 2, vanishY: -n * unit / 2, persp: 0.55 };
  const centreOf = (t) => { const f = tileFaces(t, v); const xs = f.top.map((p) => p.x), ys = f.top.map((p) => p.y); return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }; };
  const slot = centreOf({ ...B, z: 0 });
  const fromV = (c) => Math.hypot(c.x - v.vanishX, c.y - v.vanishY);
  const onRay = (c) => Math.abs((slot.x - v.vanishX) * (c.y - v.vanishY) - (slot.y - v.vanishY) * (c.x - v.vanishX)) / (fromV(slot) * Math.max(1e-9, fromV(c))) < 1e-9;

  const enter = enterPlan.tweens.find((x) => x.txid === 'b');
  const { t0, t1 } = landingOf(enter, enterPlan);
  const born = sampleTween(enter, t0 + 1, enterPlan);
  assert.ok(born.z > enterPlan.cfg.maxLane, 'it lets go from above the flight lanes');
  assert.ok(onRay(centreOf(born)) && fromV(centreOf(born)) > fromV(slot), 'out along the camera ray: nearer the viewer, over its slot');
  for (let f = 0.02; f <= 1; f += 0.02) {
    const c = centreOf(sampleTween(enter, t0 + (t1 - t0) * f, enterPlan));
    assert.ok(onRay(c) && fromV(c) >= fromV(slot) - 1e-6, 'it only ever moves along that ray, never past its slot');
  }
  const landed = centreOf(sampleTween(enter, enterPlan.settleAt, enterPlan));
  assert.ok(Math.hypot(landed.x - slot.x, landed.y - slot.y) < 1e-6, 'and lands on it');

  const gone = exitPlan.tweens.find((x) => x.txid === 'b');
  let prevE = -1, prevD = fromV(slot);
  for (let f = 0.05; f < 1; f += 0.05) {
    const s = sampleTween(gone, exitPlan.phases.t0 + (exitPlan.phases.rise - exitPlan.phases.t0) * f, exitPlan);
    const c = centreOf(s);
    assert.ok(onRay(c) && fromV(c) >= prevD - 1e-9, 'a departure rises back out along the ray');
    assert.equal(s.alpha, 1, 'solid all the way: a see-through cube read as a ghost');
    // (operator: "I want to see old blocks flying up and off the screen instead of disappearing")
    assert.equal(s.s, gone.from.s, 'whole all the way: it flies off, it does not shrink');
    assert.ok(s.entry >= prevE - 1e-12, 'heading further off screen as it goes');
    prevE = s.entry; prevD = fromV(c);
  }
  assert.ok(sampleTween(gone, exitPlan.phases.rise - 1, exitPlan).entry > 0.99, 'and off the screen by the end of the rise');
  assert.equal(sampleTween(gone, exitPlan.phases.rise, exitPlan), null, 'and is gone at the top');
});

test('departures do not leave in unison: each has its own start and its own acceleration', () => {
  // (operator: "All the blocks are flying up and away at a uniform rate. It
  // looks strange. Mix it up a bit with speed")
  const plan = planTransition(layout(5, 60), layout(5, 30), { now: 0 });
  const exits = plan.tweens.filter((t) => t.kind === 'exit');
  assert.ok(exits.length >= 15, `the fixture has departures (${exits.length})`);
  const R = plan.phases.rise - plan.phases.t0;
  const at = (f) => exits.map((tw) => sampleTween(tw, plan.phases.t0 + R * f, plan));
  const early = at(0.15);
  assert.ok(early.some((s) => s.z === 0) && early.some((s) => s.z > 0), 'early on, some have gone and some are still waiting');
  const mid = at(0.8).map((s) => s.entry ?? 0);
  assert.ok(new Set(mid.map((v) => v.toFixed(3))).size > exits.length / 2, 'late in the rise, they are at many different heights');
  assert.ok(Math.max(...mid) - Math.min(...mid) > 0.3, `and well spread (${Math.min(...mid).toFixed(2)}..${Math.max(...mid).toFixed(2)})`);
  for (const tw of exits) {
    assert.ok(sampleTween(tw, plan.phases.rise - 1, plan).entry > 0.99, 'yet every one is off the screen by the end of the rise');
    assert.equal(sampleTween(tw, plan.phases.rise, plan), null);
  }
});

test('a new block falls in from off screen and bounces; a departing one flies up and off it', () => {
  // 2026-09-10 this pinned arrivals starting OFF screen ("drops in from off
  // screen"). 2026-09-11 the operator asked to "keep as much movement on
  // screen as possible", which supersedes it: an arrival lets go just above
  // the flight stack, directly above its own slot (see the arrivals test).
  const A = { txid: 'a', x: 0, y: 0, s: 2, rate: 10, color: feeColor(10) };
  const B = { txid: 'b', x: 6, y: 6, s: 1, rate: 60, color: feeColor(60) };

  const plan = planTransition([A], [A, B], { now: 0 });
  const enter = plan.tweens.find((x) => x.txid === 'b');
  assert.equal(enter.kind, 'enter');
  assert.equal(sampleTween(enter, plan.phases.t0, plan), null, 'not drawn before it arrives');

  // its drop starts on its own beat, not at the phase boundary
  const dropT0 = plan.phases.travel + (enter.jitter ?? 0) * plan.cfg.dropStagger;
  const first = sampleTween(enter, dropT0 + 1, plan);
  assert.ok(first.alpha === 1 && first.s === enter.to.s && first.entry > 0, 'solid and whole, and still coming in from off screen: one fall, no hover');
  // (operator, 2026-09-11: "Have the spawning happen off-screen for new blocks being dropped in")
  const coming = sampleTween(enter, dropT0 - plan.cfg.entryMs / 2, plan);
  assert.ok(coming && coming.entry > 0 && coming.entry < 1 && Math.abs(coming.z - first.z) < 0.01, 'before its drop it is lowered in, its real altitude held at the top of the fall');
  assert.equal(sampleTween(enter, dropT0 - plan.cfg.entryMs - 1, plan), null, 'and not drawn before that');
  // (operator: "The new blocks spawning in should hit the ground and start
  // bouncing. Not pause and then drop again") -- the DRAWN height falls
  // without a single pause or rise from the first frame to the first impact,
  // and then it bounces
  const vo = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 8 }, dome: 5, gridW: 40, gridH: 40 };
  let prev = Infinity, rose = false, prevEntry = 1;
  for (let at = dropT0 - plan.cfg.entryMs + 20; at < plan.settleAt; at += 20) {
    const s = sampleTween(enter, at, plan);
    const vb = visualBase(s, vo);
    if (!rose && vb > prev + 1e-9) { rose = true; assert.equal(prevEntry, 0, 'the first time it goes up is a bounce, after the off-screen height is spent'); }
    if (!rose) assert.ok(vb < prev - 1e-6, `falling every frame until it hits, never hovering (at ${at - dropT0} ms)`);
    prev = vb; prevEntry = s.entry ?? 0;
  }
  assert.ok(rose, 'and it bounces');
  assert.ok(fallShare(0.3, 3, 0.4) > 0 && fallShare(0.3, 3, 0.4) < 1);
  assert.ok(first.z > plan.cfg.maxLane, 'from above every travel lane, so it cannot meet a mover');
  assert.ok(plan.cfg.enterFrom <= plan.cfg.maxLane + 2 * plan.cfg.laneGap + 1e-9, 'but no higher than it needs to be');
  const landed = sampleTween(enter, plan.settleAt, plan);
  assert.equal(landed.alpha, 1, 'and is solid once it lands');
  assert.equal(landed.z, 0, 'flat on the plane');
  assert.equal(landed.s, enter.to.s, 'at full size');

  const p2 = planTransition([A, B], [A], { now: 0 });
  const gone = p2.tweens.find((x) => x.txid === 'b');
  assert.equal(gone.kind, 'exit');
  const s1 = sampleTween(gone, p2.phases.t0 + 1, p2);
  const s2 = sampleTween(gone, p2.phases.rise - 1, p2);
  assert.ok(s1.s === s2.s && s2.entry > s1.entry && s1.alpha === 1 && s2.alpha === 1, 'a departing block flies up and off the screen, whole and solid');
  assert.equal(sampleTween(gone, p2.phases.rise, p2), null, 'and is gone at the top');
});

test('the board FILLS its panel rather than fitting inside it', () => {
  // "Too much black ... wasted space": the packing comes out ~10% taller than
  // wide, so an aspect-preserving fit into a square panel left bars down both
  // sides. Filling costs a small, deliberate distortion.
  const bounds = { minX: 0, maxX: 440, minY: 0, maxY: 490 };
  const f = fitToBox(bounds, 600, 600, 3);
  const coverX = (440 * f.scaleX) / 600;
  const coverY = (490 * f.scaleY) / 600;
  assert.ok(coverX > 0.97 && coverY > 0.97, `both axes fill the panel, got ${(coverX * 100).toFixed(0)}% x ${(coverY * 100).toFixed(0)}%`);

  // the distortion is real but small, and must stay small
  const distortion = Math.abs(f.scaleX / f.scaleY - 1);
  assert.ok(distortion < 0.2, `blocks stay near square, off by ${(distortion * 100).toFixed(1)}%`);

  // AREA still tracks vbytes exactly: both axes scale every block the same,
  // so the relationship the whole picture rests on is untouched
  const areaOf = (s) => s * f.scaleX * s * f.scaleY;
  assert.ok(Math.abs(areaOf(4) / areaOf(2) - 4) < 1e-9, 'twice the side is still four times the area');

  // a square panel with a square board needs no distortion at all
  const square = fitToBox({ minX: 0, maxX: 100, minY: 0, maxY: 100 }, 400, 400, 0);
  assert.equal(square.scaleX, square.scaleY);
});

test('each block has its own restitution, independent of when it lands, so no two settle alike', () => {
  const plan = planTransition(layout(5, 200), layout(9, 200), { now: 0 });
  const movers = plan.tweens.filter((x) => x.kind === 'move');
  assert.ok(movers.length > 50, 'enough movers to judge a distribution');
  const L = movers.map((mv) => landingOf(mv, plan));
  const rests = L.map((l) => l.rest);
  assert.ok(Math.min(...rests) >= 0.15 ** 2 - 1e-9 && Math.max(...rests) <= 0.36 ** 2 + 1e-9, 'a rebound keeps e^2 of the height, e in 0.15-0.36 ("more weight to each block")');
  assert.ok(Math.max(...rests) - Math.min(...rests) > 0.04, `and genuinely spread across the heavier range (${(Math.max(...rests) - Math.min(...rests)).toFixed(3)})`);
  // MASS: a heavier block is a deader bounce ("Give the blocks actual weight/mass")
  assert.ok(restitutionOf(1) > restitutionOf(4) && restitutionOf(4) > restitutionOf(16), 'restitution falls with mass');
  for (const l of L) assert.ok(Math.abs(l.bounce - l.rest) < 1e-12, 'the first rebound is e^2 of the drop, like every one after it');
  assert.ok(new Set(L.map((l) => l.nBounce)).size >= 2, 'so the number of visible hops varies with it (one or two, since "less bouncing")');
  // and it must not track the landing time
  const d = movers.map((mv) => mv.jitter);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const md = mean(d), mr = mean(rests);
  const cov = mean(d.map((x, i) => (x - md) * (rests[i] - mr)));
  const sd = Math.sqrt(mean(d.map((x) => (x - md) ** 2))), sr = Math.sqrt(mean(rests.map((x) => (x - mr) ** 2)));
  assert.ok(Math.abs(cov / (sd * sr)) < 0.25, 'when a block lands says nothing about how it bounces');
  // stable per block, or the picture shimmers between repaints
  const again = planTransition(layout(5, 200), layout(9, 200), { now: 9000 });
  for (const mv of movers.slice(0, 40)) {
    const twin = again.tweens.find((x) => x.txid === mv.txid && x.kind === 'move');
    if (twin) assert.equal(landingOf(twin, again).rest, landingOf(mv, plan).rest, `${mv.txid} keeps its restitution`);
  }
});

test('shadows fade: a departure takes its shadow with it, an arrival brings its own in, and nothing switches', () => {
  // (operator, 2026-09-11: "the shadows just disappear. they need to fade out")
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10 } };
  const A = { txid: 'a', x: 0, y: 0, s: 2, rate: 10, color: feeColor(10) };
  const B = { txid: 'b', x: 6, y: 6, s: 2, rate: 60, color: feeColor(60) };
  // the total darkness a tile lays on the floor
  const ink = (s) => (s ? buildScene([s], v).ops.filter((x) => x.face === 'shadow').reduce((n, x) => n + Number(x.fill.match(/,([\d.]+)\)$/)[1]), 0) : 0);
  const run = (plan, tw, t0, t1) => { const out = []; for (let at = t0; at <= t1; at += 20) out.push(ink(sampleTween(tw, at, plan))); return out; };
  const exitPlan = planTransition([A, B], [A], { now: 0 });
  const gone = exitPlan.tweens.find((x) => x.txid === 'b');
  const e = run(exitPlan, gone, exitPlan.phases.t0, exitPlan.phases.rise - 1);
  assert.ok(e[0] > 0.3, 'at rest it casts its shadow');
  assert.ok(e.at(-1) < 0.02, `by the time it has flown off, its shadow has faded to nothing (${e.at(-1).toFixed(3)})`);
  for (let i = 1; i < e.length; i++) assert.ok(Math.abs(e[i] - e[i - 1]) < 0.2, `no jump as it leaves (${e[i - 1].toFixed(3)} -> ${e[i].toFixed(3)})`);
  const enterPlan = planTransition([A], [A, B], { now: 0 });
  const enter = enterPlan.tweens.find((x) => x.txid === 'b');
  const L = landingOf(enter, enterPlan);
  const a = run(enterPlan, enter, L.t0 - enterPlan.cfg.entryMs + 1, enterPlan.settleAt);
  assert.ok(a[0] < 0.02, 'an arrival\'s shadow starts from nothing');
  assert.ok(Math.abs(a.at(-1) - e[0]) < 1e-9, 'and ends as the resting shadow');
  for (let i = 1; i < a.length; i++) assert.ok(Math.abs(a[i] - a[i - 1]) < 0.2, `no jump as it lands (${a[i - 1].toFixed(3)} -> ${a[i].toFixed(3)})`);
});

test('a block flying just behind a tall one never pops in front of it', () => {
  // (operator, 2026-09-11: "theres still sorting issues with blocks behind other
  // blocks popping to forefront"). On the sphere a low flight leans outward, so
  // its DRAWN footprint can slide into a nearer cube's while its real one does
  // not; judged by real height and drawn footprint the pair tied, and the tie
  // painted the flyer last. Swept across the tall cube, it must stay behind.
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 8 }, dome: 5, gridW: 40, gridH: 40 };
  const tall = { txid: 'T', x: 10, y: 2, s: 6, z: 0, color: feeColor(5) };
  const orderAt = (x) => [...new Set(buildScene([tall, { txid: 'F', x, y: 8.1, s: 2, z: 4, color: feeColor(5) }], v).ops.filter((q) => q.face !== 'shadow').map((q) => q.txid))];
  // wherever it overlaps the tall cube side to side (the old rule put it in front from x = 10 to 16)
  for (let x = 9.5; x <= 15.5; x += 0.5) assert.deepEqual(orderAt(x), ['F', 'T'], `at x=${x} the flyer behind stays behind the tall cube`);

});

// a picture's outline (convex hull of its points) and whether two overlap by more than tol
function outline(pts) {
  const s = pts.slice().sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (a, p, q) => (p.x - a.x) * (q.y - a.y) - (p.y - a.y) * (q.x - a.x);
  const lo = [], hi = [];
  for (const p of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function outlinesOverlap(A, B, tol) {
  for (const poly of [A, B]) for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    let nx = q.y - p.y, ny = p.x - q.x; const L = Math.hypot(nx, ny); if (!L) continue; nx /= L; ny /= L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const v of A) { const d = v.x * nx + v.y * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
    for (const v of B) { const d = v.x * nx + v.y * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
    if (Math.min(a1, b1) - Math.max(a0, b0) < tol) return false;
  }
  return true;
}

test('A TRAVELLING CUBE IS RE-RENDERED, not carried: its faces follow where it IS', () => {
  // (operator, 2026-09-13: "if it starts on the left side, I would expect to see it's right face.
  // if it translates right all the way, at the end of the movement, I should see the left side of
  // the face ... I want to see blocks being redrawn every frame with proper perspective adjusting.")
  //
  // This is the property, pinned on the REAL transition path rather than on a scalar: replay a cube
  // crossing the whole board and watch which faces are drawn.
  const W = 44;
  const V = { unit: 10, zUnit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 }, dome: 5,
    gridW: W, gridH: W, viewRect: { x0: -4, x1: W + 4, y0: -4, y1: W + 4 }, departures: 'normal' };
  const before = [{ txid: 'mover', x: 2, y: 20, s: 3, tall: 3, color: '#33cc99', rate: 9 },
                  { txid: 'anchor', x: 20, y: 2, s: 2, tall: 2, color: '#cc9933', rate: 5 }];
  const after = [{ txid: 'mover', x: 38, y: 20, s: 3, tall: 3, color: '#33cc99', rate: 9 },
                 { txid: 'anchor', x: 20, y: 2, s: 2, tall: 2, color: '#cc9933', rate: 5 }];
  const plan = planTransition(before, after, { now: 0, gridN: W });
  const seen = [];
  for (let t = 0; t <= plan.settleAt; t += 200) {
    const f = frameAt(plan, t, V);
    const tile = (f.tiles ?? []).find((q) => q.txid === 'mover');
    if (!tile) continue;
    const keys = tileFaces(tile, V).sides.map((sd) => sd.key).sort().join('+');
    if (keys !== seen[seen.length - 1]?.keys) seen.push({ t, x: tile.x + tile.s / 2, keys });
  }
  // it starts on the left half showing its RIGHT face...
  assert.match(seen[0].keys, /right/, `starts showing its right face (${seen[0].keys} at x=${seen[0].x})`);
  assert.doesNotMatch(seen[0].keys, /left/, 'and not its left one');
  // ...and ends on the right half showing its LEFT face
  const last = seen[seen.length - 1];
  assert.match(last.keys, /left/, `ends showing its left face (${last.keys} at x=${last.x})`);
  assert.doesNotMatch(last.keys, /right/, 'and not its right one');
  // the change happens WHILE IT TRAVELS, not at the moment it lands
  const flip = seen.find((r) => /left/.test(r.keys));
  assert.ok(flip.t < plan.phases.travel, `the faces swap during travel (t=${flip.t} of ${plan.phases.travel})`);
  assert.ok(flip.x > 10 && flip.x < W - 10, `and near the middle of the board, where the lean changes sign (x=${flip.x})`);
});

test('HOW MUCH A TRAVELLING CUBE RESHAPES -- and why per-corner projection is NOT the fix', () => {
  // The faces flip (test above), but the cube is still essentially CARRIED across the board rather
  // than re-rendered: its SHAPE -- the top face measured about the cube's own centre, with position
  // divided out -- changes by under two pixels over a full crossing, and the visible side face is a
  // 0.6-3.4px sliver at its narrowest. That is why it reads as static in motion even though the
  // face-set is correct.
  //
  // PER-CORNER PROJECTION WAS TRIED TWICE AND DOES NOT FIX IT. Measured on this exact fixture with
  // one variable changed:
  //
  //     per-corner   shape drift 1.78px, top width 32.3..34.1px (wobbles by 1.83)
  //     pinned lean  shape drift 1.77px, top width 30.0px flat
  //
  // A hundredth of a pixel, bought at the price of a visibly wobbling cube. It also regressed the
  // flicker test below from clean to 25 -- and that 25 is a FLOOR: replayed with that test's own
  // hull and gate, the count was 198 flickers over 95 distinct pairs, 39 of them between cubes BOTH
  // AT REST, which is the standing board churning rather than a departure artefact.
  //
  // THE 7.6px FIGURE THAT JUSTIFIED IT WAS MEASURING SOMETHING ELSE: a 6-unit cube at z=80 against
  // a differently-centred reference, not anything a travelling cube does. It was quoted in a commit
  // message and twice in conversation before anyone checked what it described. Recorded so the next
  // person does not rediscover it as evidence.
  //
  // WHAT ACTUALLY MAKES IT STATIC: a travelling cube holds a CONSTANT lane height for the whole
  // travel phase (measured: z=16.98, unchanging, for eleven seconds). Height is the only input the
  // lean turns into visible change, so no amount of correctness in how corners lean can matter
  // while z never moves. To make a cube visibly reshape as it crosses, vary its HEIGHT along the
  // path -- an arc through travel instead of a flat lane. That makes the existing per-cube lean do
  // real work and touches no ordering code, which is where the risk lives.
  //
  // This records the shipped number rather than asserting it is good, so a change that makes the
  // cube MORE static fails loudly.
  const W = 44;
  const V = { unit: 10, zUnit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 }, dome: 5,
    gridW: W, gridH: W, viewRect: { x0: -4, x1: W + 4, y0: -4, y1: W + 4 }, departures: 'normal' };
  const before = [{ txid: 'mover', x: 2, y: 20, s: 3, tall: 3, color: '#33cc99', rate: 9 },
                  { txid: 'anchor', x: 20, y: 2, s: 2, tall: 2, color: '#cc9933', rate: 5 }];
  const after = [{ txid: 'mover', x: 38, y: 20, s: 3, tall: 3, color: '#33cc99', rate: 9 },
                 { txid: 'anchor', x: 20, y: 2, s: 2, tall: 2, color: '#cc9933', rate: 5 }];
  const plan = planTransition(before, after, { now: 0, gridN: W });
  const shapeOf = (tile) => {
    const f = tileFaces(tile, V);
    const c = f.top.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    return f.top.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
  };
  let first = null, drift = 0;
  for (let t = plan.phases.rise; t <= plan.phases.travel; t += 200) {
    const f = frameAt(plan, t, V);
    const tile = (f.tiles ?? []).find((q) => q.txid === 'mover');
    if (!tile) continue;
    const sh = shapeOf(tile);
    first ??= sh;
    drift = Math.max(drift, ...sh.map((p, i) => Math.hypot(p.x - first[i].x, p.y - first[i].y)));
  }
  // the shipped value is ~1.8px. Held loosely on both sides: it must not silently collapse toward
  // zero (a cube that never reshapes at all), and the ceiling is here so that when per-corner
  // projection lands, this assertion is what has to be rewritten -- deliberately, with a new number.
  assert.ok(drift > 0.5, `a travelling cube does reshape somewhat (${drift.toFixed(2)}px)`);
  assert.ok(drift < 4, `and the shipped shear is small -- this is the number to beat (${drift.toFixed(2)}px)`);
});

test('the paint order does not flicker: no overlapping pair swaps back and forth', () => {
  // (operator, 2026-09-11: "still too much z fighting with smaller blocks rendering
  // behind larger blocks"). Replay a whole transition through the panel's camera
  // and, for every pair of cubes whose pictures overlap, count the times their
  // order changes and changes back within half a second. Ordering as drawn gave
  // hundreds; ordering in real space gives none.
  const plan = planTransition(layout(5, 90), layout(9, 90), { now: 0, gridN: 28 });
  // the panel's camera
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 }, dome: 5, gridW: 28, gridH: 28, viewRect: { x0: -3, x1: 31, y0: -5, y1: 33 } };
  const seq = new Map();
  let frame = 0;
  for (let t = 0; t <= plan.settleAt; t += 32, frame++) {
    const f = frameAt(plan, t, v);
    const box = new Map(), pos = new Map();
    let k = 0;
    for (const op of f.ops) {
      if (op.face === 'shadow') continue;
      if (!pos.has(op.txid)) pos.set(op.txid, k++);
      const bb = box.get(op.txid) ?? [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of op.points) { bb[0] = Math.min(bb[0], p.x); bb[1] = Math.min(bb[1], p.y); bb[2] = Math.max(bb[2], p.x); bb[3] = Math.max(bb[3], p.y); }
      box.set(op.txid, bb);
    }
    const ids = [...box.keys()].sort();
    const hull = new Map(ids.map((id) => [id, outline(f.ops.filter((q) => q.txid === id && q.face !== 'shadow').flatMap((q) => q.points))]));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = box.get(ids[i]), b = box.get(ids[j]);
      if (Math.min(a[2], b[2]) - Math.max(a[0], b[0]) < 2 || Math.min(a[3], b[3]) - Math.max(a[1], b[1]) < 2) continue;
      if (!outlinesOverlap(hull.get(ids[i]), hull.get(ids[j]), 2)) continue;   // the pictures themselves overlap
      const key = ids[i] + '|' + ids[j];
      (seq.get(key) ?? seq.set(key, []).get(key)).push([frame, pos.get(ids[i]) < pos.get(ids[j])]);
    }
  }
  assert.ok(seq.size > 100, `enough overlapping pairs to judge (${seq.size})`);
  let flicker = 0;
  const who = [];
  for (const [key, s] of seq) {
    let last = null;
    for (let i = 1; i < s.length; i++) {
      if (s[i][0] !== s[i - 1][0] + 1 || s[i][1] === s[i - 1][1]) continue;
      if (last !== null && s[i][0] - last <= 15) { flicker++; who.push(key); }
      last = s[i][0];
    }
  }
  // Replayed on this scenario (2026-09-11): 185 flickers with the order judged as
  // drawn and cycles cut anywhere; 11 (9 of 850 pairs) with real-space decisions,
  // constraints only between truly overlapping outlines, and tangles ordered as a
  // group by nearness to the camera. What remains is cubes inside one tangle whose
  // nearness crosses while one of them bounces. Held under 2% of overlapping pairs.
  const pairs = new Set(who).size;
  assert.ok(pairs <= Math.ceil(seq.size * 0.02), `${pairs} of ${seq.size} overlapping pairs flicker (${[...new Set(who)].slice(0, 5).join(', ')})`);
});

test('NOTHING POPS OVER ANYTHING WHILE THE BOARD LANDS: an overlapping pair keeps its order', () => {
  // (operator, 2026-09-14: "shit popping over other shit at end of movements"). The flicker test
  // above only counts a swap that swaps BACK, so a pair that flips once -- on the frame the last
  // cube lands, or as a bouncing cube's outline touches a neighbour -- passed it every time.
  // Measured before the fix, from the drop to settle, on these three boards: 42, 66 and 67 swaps
  // between cubes whose pictures overlapped on both frames, among them the whole left half's
  // leaning faces changing hands on the settle frame. Two causes: across columns the order was
  // "left after right" whatever the lean (right only on the right half; leanEdge put the left half
  // right on a SETTLED board, hence the jump on landing), and an overlap tolerance that a bouncing
  // cube's outline crossed on every hop. Swaps are counted only between pictures that overlapped
  // on the previous frame too, so a cube arriving beside another is not a pop -- it is a new pair.
  // BOTH DEPARTURE PATHS. settings.js ships 'normal' (along the board's curve); a test that only ran
  // the module default would pass while the board people look at popped. Under 'normal' one swap
  // remains across the three boards (layout 5 -> 9, at the start of the drop, not at touchdown): a
  // three-cube tangle at the rim dissolving, where the group's remembered order and the pair's own
  // edge disagree for one frame. Held at exactly that, so a regression cannot hide inside it.
  for (const departures of ['normal', 'arcing']) {
  const allowed = departures === 'normal' ? 1 : 0;
  let total = 0;
  const seen = [];
  for (const [a, b, n] of [[5, 9, 90], [3, 4, 120], [11, 12, 100]]) {
    const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 }, dome: 5, gridW: 28, gridH: 28,
      viewRect: { x0: -10.17, x1: 38.17, y0: -4.8, y1: 32.8 }, orderMemo: new Map(), departures };
    const plan = planTransition(layout(a, n), layout(b, n), { now: 0, gridN: 28 });
    let prev = null;
    const swaps = [];
    for (let t = plan.phases.travel; t <= plan.settleAt + 32; t += 16) {
      const f = frameAt(plan, t, v);
      const pos = new Map(), pts = new Map();
      for (const op of f.ops) {
        if (op.face !== 'top' && op.face !== 'side') continue;
        if (!pos.has(op.txid)) pos.set(op.txid, pos.size);
        (pts.get(op.txid) ?? pts.set(op.txid, []).get(op.txid)).push(...op.points);
      }
      // sorted, so a pair has the same key whichever of them is painted first
      const ids = [...pts.keys()].sort();
      const hull = new Map(ids.map((id) => [id, outline(pts.get(id))]));
      const box = new Map(ids.map((id) => { const h = hull.get(id); return [id, [Math.min(...h.map((p) => p.x)), Math.min(...h.map((p) => p.y)), Math.max(...h.map((p) => p.x)), Math.max(...h.map((p) => p.y))]]; }));
      const over = new Set();
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const A = box.get(ids[i]), B = box.get(ids[j]);
        if (A[2] < B[0] || B[2] < A[0] || A[3] < B[1] || B[3] < A[1]) continue;
        if (outlinesOverlap(hull.get(ids[i]), hull.get(ids[j]), 0)) over.add(ids[i] + '|' + ids[j]);
      }
      if (prev) for (const k of over) {
        if (!prev.over.has(k)) continue;
        const [p, q] = k.split('|');
        if ((pos.get(p) < pos.get(q)) !== (prev.pos.get(p) < prev.pos.get(q))) swaps.push(`${k}@${t}`);
      }
      prev = { over, pos };
    }
    total += swaps.length;
    seen.push(...swaps.map((sw) => `${a}->${b} ${sw}`));
  }
  assert.ok(total <= allowed, `${departures}: ${total} pops while landing, ${allowed} allowed (${seen.slice(0, 5).join(', ')})`);
  }
});

test('a landing falls under gravity AS DRAWN: no hover at the top, no lurch at the bottom', () => {
  // (operator, 2026-09-11: "The items slowly start dropping. They need to drop like they
  // were just let go, immediately succumb to gravity, and bounce to a stop")
  const plan = planTransition(layout(5), layout(9), { now: 0, gridN: 28 });
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 }, dome: 5, gridW: 28, gridH: 28, viewRect: { x0: -3, x1: 31, y0: -5, y1: 33 } };
  const mv = plan.tweens.find((x) => x.kind === 'move' && x.lane > 10);
  assert.ok(mv, 'a mover with a real fall');
  const L = landingOf(mv, plan);
  const fall = fallShare(L.bounce, L.nBounce, L.rest) * (L.t1 - L.t0);
  const V = (u) => visualBase(sampleTween(mv, L.t0 + u * fall, plan), v);
  const V0 = V(0);
  assert.ok(V0 > 3, `released from a visible height (${V0.toFixed(1)})`);
  for (const u of [0.1, 0.2, 0.4, 0.6, 0.8, 0.95]) {
    assert.ok(Math.abs(V(u) / V0 - (1 - u * u)) < 0.01, `at ${u} of the fall the drawn height is free fall (${(V(u) / V0).toFixed(3)} vs ${(1 - u * u).toFixed(3)})`);
  }
  assert.ok(V(1) < 0.05, 'and it meets the floor');
  // then it rebounds, lower each time, and comes to rest
  let peak = 0;
  for (let at = L.t0 + fall + 10; at < L.t1; at += 10) peak = Math.max(peak, visualBase(sampleTween(mv, at, plan), v));
  assert.ok(peak > 0 && peak < V0 * 0.2, `a rebound of a small share of the drop (${(peak / V0).toFixed(3)})`);
  assert.equal(visualBase(sampleTween(mv, L.t1 + 1, plan), v), 0, 'and at rest on the floor');
});

test('a cube in flight shadows the tops of the cubes beneath it', () => {
  // (operator, 2026-09-11: "can we get the cubes casting shadows against other cubes during movement?")
  const v = { unit: 10, oblique: { ox: 0.13, oy: 0.32, headroom: 10 } };
  const under = { txid: 'u', x: 0, y: 0, s: 6, z: 0, color: feeColor(5) };
  const aside = { txid: 'w', x: 20, y: 0, s: 4, z: 0, color: feeColor(5) };
  const fly = (z, x = 2) => ({ txid: 'f', x, y: 2, s: 2, z, color: feeColor(5) });
  const ops = buildScene([under, aside, fly(9)], v).ops;
  const cast = ops.filter((x) => x.face === 'cast');
  assert.ok(cast.length > 0 && cast.every((x) => x.txid === 'u'), 'it darkens the cube under it, and only that one');
  assert.ok(ops.findIndex((x) => x.face === 'cast') > ops.findIndex((x) => x.txid === 'u' && x.face === 'top'), 'on its top, drawn after it');
  // (the flyer's own FLOOR shadow is drawn before every cube, so look at its faces)
  assert.ok(ops.findIndex((x) => x.txid === 'f' && x.face !== 'shadow') > ops.findLastIndex((x) => x.face === 'cast'), 'and under the flyer');
  const ink = (z) => buildScene([under, fly(z)], v).ops.filter((x) => x.face === 'cast').reduce((n, x) => n + Number(x.fill.match(/,([\d.]+)\)$/)[1]), 0);
  assert.ok(ink(7) > ink(20) && ink(20) > 0, `darker the nearer it flies (${ink(7).toFixed(3)} at 1 unit over, ${ink(20).toFixed(3)} at 14)`);
  assert.equal(buildScene([under, fly(9, 10)], v).ops.filter((x) => x.face === 'cast').length, 0, 'nothing when it is not over a cube');
  assert.equal(buildScene([under, aside], v).ops.filter((x) => x.face === 'cast').length, 0, 'resting cubes cast none on each other');
  assert.equal(buildScene([under, { ...fly(9), entry: 1 }], v).ops.filter((x) => x.face === 'cast').length, 0, 'and one still off screen casts none');
});

test('a light cycle crosses the board edge to edge along the grid lines, turning only at right angles', async () => {
  // (operator, 2026-09-11: "a TRON Light cycle ... navigating the block grid from one end of
  // the board to another ... moving at 90 degree turns along the blocks")
  const { cyclePath } = await import('../public/js/blockscene3d.js');
  for (const [side, W, H] of [['left', 44, 44], ['right', 44, 44], ['bottom', 30, 44], ['top', 44, 30]]) {
    for (const seed of [1, 7, 99, 4242]) {
      const p = cyclePath(seed, W, H, side);
      const first = p[0], last = p.at(-1);
      if (side === 'left') assert.ok(first.x === 0 && last.x === W, 'left edge to right edge');
      if (side === 'right') assert.ok(first.x === W && last.x === 0, 'right edge to left edge');
      if (side === 'bottom') assert.ok(first.y === 0 && last.y === H, 'bottom edge to top edge');
      if (side === 'top') assert.ok(first.y === H && last.y === 0, 'top edge to bottom edge');
      let turns = 0;
      for (let i = 1; i < p.length; i++) {
        const dx = p[i].x - p[i - 1].x, dy = p[i].y - p[i - 1].y;
        assert.equal(Math.abs(dx) + Math.abs(dy), 1, 'one grid unit, along one axis');
        assert.ok(p[i].x >= 0 && p[i].x <= W && p[i].y >= 0 && p[i].y <= H, 'on the board');
        if (i > 1) {
          const px = p[i - 1].x - p[i - 2].x, py = p[i - 1].y - p[i - 2].y;
          assert.ok(!(dx === -px && dy === -py), 'never doubling back');
          if (dx !== px || dy !== py) turns++;
        }
      }
      assert.ok(turns >= 2, `it turns (${turns} turns)`);
    }
  }
  assert.deepEqual(cyclePath(5, 44, 44, 'left'), cyclePath(5, 44, 44, 'left'), 'the same seed, the same route');
});

test('the cycle rides the block tops, stepping straight up and down between them', async () => {
  const { cellTops, pathHeights, packetPaths } = await import('../public/js/blockscene3d.js');
  const tops = cellTops([{ x: 2, y: 0, s: 4, z: 0 }], 10, 10);   // a 4-cube over cells x 2..5, y 0..3
  const pts = Array.from({ length: 8 }, (_, x) => ({ x, y: 2 }));  // along the grid line y = 2
  const hs = pathHeights(pts, tops, 10, 10);
  assert.ok(Math.abs(hs[0] - 0.04) < 1e-6 && Math.abs(hs[1] - 0.04) < 1e-6, 'on the floor before the cube');
  for (const k of [2, 3, 4, 5]) assert.ok(Math.abs(hs[k] - 4.04) < 1e-6, 'on its top across it');
  assert.ok(Math.abs(hs[6] - 0.04) < 1e-6, 'and down again after it');
  const packets = packetPaths(3, 44, 44, 8);
  assert.equal(packets.length, 8);
  for (const p of packets) {
    assert.ok(p.s0 >= 0 && p.s0 < 0.56 && p.pts.length >= 2, 'each packet hops from its own moment');
    for (let i = 1; i < p.pts.length; i++) assert.equal(Math.abs(p.pts[i].x - p.pts[i - 1].x) + Math.abs(p.pts[i].y - p.pts[i - 1].y), 1);
  }
});

test('the cubes under a racing head flash in its colour', () => {
  const fx = { kind: 'lightcycle', heads: [{ x: 3, y: 2, color: [80, 220, 255], alpha: 1 }] };
  const under = fxAt({ txid: 'a', x: 2, y: 1, s: 2 }, fx), far = fxAt({ txid: 'b', x: 20, y: 20, s: 2 }, fx);
  assert.ok(under.glow > 0.8 && under.color[0] === 80, 'the cube it rides over lights in TRON blue');
  assert.equal(far.glow, 0, 'and one far away does not');
});
