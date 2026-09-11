// The block, drawn as an area. A treemap has exactly one obligation: a rectangle that is
// twice the area must be twice the vbytes. Everything else about it is presentation, and
// a picture that breaks that rule is not a chart, it is decoration with numbers next to it.
// So the geometry is tested here, against the shape of real template data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTreemap, rateColor, cutVbytes, blockFillFraction } from '../public/js/goggles.js';
import { templateCells } from '../server/collect/nextblock.js';

const cells = [
  { vbytes: 600, rate: 40, txid: 'a' },
  { vbytes: 300, rate: 12, txid: 'b' },
  { vbytes: 300, rate: 3, txid: 'c' },
  { vbytes: 150, rate: 1, txid: 'd' },
  { vbytes: 75, rate: 0.5, txid: 'e' },
];
const W = 600;
const H = 240;

test('area is proportional to vbytes, within a pixel of rounding', () => {
  const rects = layoutTreemap(cells, W, H);
  const total = cells.reduce((n, c) => n + c.vbytes, 0);
  const box = W * H;
  for (const r of rects) {
    const want = r.vbytes / total * box;
    assert.ok(Math.abs(r.w * r.h - want) / want < 0.05,
      `cell ${r.txid}: area ${Math.round(r.w * r.h)} should be ~${Math.round(want)} (${r.vbytes} vB of ${total})`);
  }
});

test('nothing escapes the box and nothing overlaps', () => {
  const rects = layoutTreemap(cells, W, H);
  for (const r of rects) {
    assert.ok(r.x >= 0 && r.y >= 0, `${r.txid} starts inside`);
    assert.ok(r.x + r.w <= W + 0.5, `${r.txid} fits horizontally (${r.x}+${r.w})`);
    assert.ok(r.y + r.h <= H + 0.5, `${r.txid} fits vertically`);
    assert.ok(r.w > 0 && r.h > 0, `${r.txid} has a positive area`);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(overlap <= 0.6 || overlapY <= 0.6, `${a.txid} and ${b.txid} overlap by ${overlap.toFixed(1)}x${overlapY.toFixed(1)}`);
    }
  }
});

test('the picture survives the shapes that break greedy layouts', () => {
  // One cell that dwarfs the rest, all-equal cells, and a single cell: the cases where a
  // naive layout either overflows the box or silently drops the small end.
  for (const set of [
    [{ vbytes: 1e6, rate: 9, txid: 'big' }, ...cells],
    Array.from({ length: 24 }, (_, i) => ({ vbytes: 100, rate: i + 1, txid: `t${i}` })),
    [{ vbytes: 500, rate: 2, txid: 'only' }],
  ]) {
    const rects = layoutTreemap(set, W, H);
    assert.ok(rects.length > 0, 'draws something');
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= W + 1 && r.y + r.h <= H + 1, `${r.txid} stays inside for ${set.length}-cell input`);
    }
  }
});

test('empty and malformed input draws nothing rather than guessing', () => {
  assert.deepEqual(layoutTreemap([], W, H), []);
  assert.deepEqual(layoutTreemap([{ vbytes: 0, rate: 1 }, { vbytes: null }], W, H), []);
  assert.deepEqual(layoutTreemap([{ vbytes: 10 }], 0, 0), []);
});

test('rate-ordered input — the shape the server actually ships — still squares', () => {
  // The bug this guard exists for: squarify's row-greedy requires DESCENDING areas,
  // but every fixture above was already size-sorted, so the suite stayed green while
  // the live Mining page painted garbage. templateCells and poolCells both sort by
  // FEE RATE, richest first — measured 2026-09-10 against the live 433px map with a
  // real 401-cell template, that order fed the rows directly produced 45 rects over
  // 10:1 aspect (worst 49:1) and 30 sub-2px slivers on the block view; the mempool's
  // real cells (one 4.7M-vB aggregate against a 110-vB tx) reached 273:1. A treemap
  // of 1px strips does not render block space; it decorates nothing.
  const rate = (i) => Math.max(0.1, +(40 * Math.exp(-i / 90) + (i % 7) * 0.01).toFixed(2));
  const ascending = Array.from({ length: 300 }, (_, i) => ({ vbytes: 100 + i * 2, rate: rate(i), txid: `r${i}` }));
  const mixed = Array.from({ length: 300 }, (_, i) => ({ vbytes: 100 + ((i * 614889307) % 1900), rate: rate(i), txid: `m${i}` }));
  // The real live shapes, replayed: a block template whose tail is one aggregate,
  // and a pool where the aggregate dwarfs every individual cell.
  const blockLike = [
    ...Array.from({ length: 400 }, (_, i) => ({ vbytes: 99 + ((i * 7919) % 2400), rate: rate(i), txid: `b${i}` })),
    { vbytes: 283_634, rate: 1.18, aggregate: 860 },
  ];
  const poolLike = [
    ...Array.from({ length: 400 }, (_, i) => ({ vbytes: 100 + ((i * 614889307) % 4000), rate: rate(i), txid: `p${i}` })),
    { vbytes: 4_674_003, rate: 0.1, aggregate: 23_404 },
  ];
  for (const [name, set] of [['ascending', ascending], ['mixed', mixed], ['block-like', blockLike], ['pool-like', poolLike]]) {
    const rects = layoutTreemap(set, 433, 433);
    assert.equal(rects.length, set.length, `${name}: every cell lands`);
    let bad = 0, tiny = 0, maxAr = 0;
    for (const r of rects) {
      const ar = Math.max(r.w, r.h) / Math.min(r.w, r.h);
      if (ar > 10) bad++;
      if (r.w < 2 || r.h < 2) tiny++;
      maxAr = Math.max(maxAr, ar);
    }
    assert.equal(bad, 0, `${name}: ${bad} rects over 10:1 (worst ${maxAr.toFixed(1)}:1) — the layout is emitting slivers`);
    assert.ok(maxAr < 10, `${name}: worst aspect ratio ${maxAr.toFixed(1)}:1 must stay under 10:1`);
    // Sub-2px rects are legitimate ONLY where the data itself is sub-pixel: the real
    // pool view measured 39 cells below 2px on 2026-09-10, every one of them a tx
    // smaller than its share of 401 cells in a 433px box. A layout bug slivers the
    // BIG cells too, so the cap is generous but it is not unlimited.
    assert.ok(tiny <= 60, `${name}: ${tiny} sub-2px rects — data-sized smalls are fine, mass slivering is this bug's signature`);
  }
  // The order that fixed it must not move the numbers: sort of a working list only,
  // so the miner order still reaches the rects themselves.
  const out = layoutTreemap(ascending, W, H);
  assert.ok(out.some((r) => r.txid === 'r0'), 'cells survive the sort with their identity');
});

test('the cut line is the block limit less what is still free, in vbytes', () => {
  assert.equal(cutVbytes({ weightLimit: 4_000_000, remainingWeight: 1_000_000 }), 750_000);
  assert.equal(cutVbytes({ weightLimit: 4_000_000, remainingWeight: null }), 1_000_000, 'unknown remainder still shows the cap');
});

const lumaOf = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('colour: one dim grey at the floor, a bright continuous ramp above it', () => {
  // The floor is ONE flat grey on purpose -- "nobody is racing for this" is a category,
  // not a spectrum. Above it the ramp is continuous and gets hotter per sat/vB, which is
  // the whole point: measured 2026-09-10, the old discrete buckets put ~60% of the
  // mempool and ~90% of the block into one bucket and both maps read as a flat colour
  // field. HOTTER, not BRIGHTER: the measured luminance along this ramp is 101 -> 113 ->
  // 151 -> 174 -> 203 -> 207 -> 139 -> 102 (grey -> blue -> cyan -> green -> lime ->
  // amber -> orange -> crimson), and a strictly-increasing-brightness assertion fails at
  // the hot end, where crimson genuinely sits lower than amber. The hue rotation IS the
  // ordering; luma only carries the first three-quarters of it. (Measured here: the floor
  // grey is #525b68, and 0.5/1.0 interpolate below the first stop toward blue — they are
  // all "sub-floor" and read as one colour at cell sizes; the assertion pins the floor
  // anchor and the absent case, not a continuum nobody can see at 3px.)
  assert.equal(rateColor(0), rateColor(null), 'the floor anchor is what absent renders as');
  assert.equal(rateColor(null), rateColor(0), 'absent is the floor, not an invention');
  const ladder = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96];
  let prevHex = rateColor(ladder[0]);
  for (const r of ladder.slice(1)) {
    const c = rateColor(r);
    assert.notEqual(c, prevHex, `feerate ${r} is distinguishable from the tier below`);
    prevHex = c;
  }
  assert.ok(lumaOf(rateColor(4)) > 130, 'the mempool median (~4 sat/vB measured today) is a BRIGHT colour');
  assert.ok(lumaOf(rateColor(16)) > 180, 'the upper-middle of the range is luminous');
  assert.notEqual(rateColor(96), rateColor(64), 'the very top runs toward crimson');
});

test('an aggregate tail cell has its own animation key', () => {
  // The aggregate cell carries no txid, and every pool's tail sits at the pool's cut
  // feerate — keying tails by rate gave ALL tails one key, so two tails fought over one
  // animation slot and the frontier drew the wrong shape. Two tails, two keys.
  const cells = [
    { vbytes: 5000, rate: 6, txid: 'a' },
    { vbytes: 400, rate: 2, aggregate: 9 },
    { vbytes: 300, rate: 2, aggregate: 7 },   // same rounded rate, a different tail
  ];
  const rects = layoutTreemap(cells, W, H);
  assert.equal(rects.length, 3);
  // The same contract the draw path relies on: distinct txids, distinct keys; distinct
  // aggregates, distinct keys. Assert through the map's own bookkeeping.
  const keys = new Set();
  for (const r of rects) keys.add(r.txid ? `t:${r.txid}` : `a:${r.aggregate}:${Math.round(r.rate)}`);
  assert.equal(keys.size, 3, 'each tail is its own animated thing');
});

test('the map keeps animating between snapshots, and stops when it is settled', async () => {
  // "Everything is too static" was the report. The loop has to actually keep painting
  // between snapshots (that is where the reshuffle is visible), AND it has to stop once
  // settled — a loop kept alive only by a marching dash is 60 fps spent on decoration.
  const { blockTreemap } = await import('../public/js/goggles.js');
  const clock = { t: 0 };
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => clock.t };
  let pending = null;
  let scheduled = 0;
  const frame = () => { const fn = pending; pending = null; scheduled += 1; fn?.(clock.t); };
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return scheduled + 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  const ops = [];
  const mkCanvas = () => ({
    clientWidth: 800, clientHeight: 200, width: 0, height: 0, style: {},
    parentElement: { querySelector: () => null }, addEventListener() {},
    getContext: () => new Proxy({ canvas: {} }, {
      get: (t, k) => (k === 'canvas' ? t.canvas : () => { ops.push(String(k)); return t.canvas; }),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
  });
  const canvas = mkCanvas();
  const cellsA = [
    { vbytes: 500_000, rate: 8, txid: 'a' },
    { vbytes: 300_000, rate: 2, txid: 'b' },
    { vbytes: 200_000, rate: 0.5, txid: 'c' },
  ];
  const full = { remainingWeight: 0 };
  const lim = { weightLimit: 4_000_000 };
  blockTreemap(canvas, { cells: cellsA, totalVbytes: 1_000_000 }, full, lim);
  assert.ok(ops.length > 0, 'the first frame is drawn synchronously, not deferred to a callback');
  const firstPaint = ops.length;

  // Between snapshots the loop must keep running: advance the clock one "frame" at a
  // time; ops grow while the chase lives.
  clock.t += 16; frame();
  assert.ok(ops.length > firstPaint, 'a frame was painted between snapshots with nothing new');

  // A second snapshot that REORDERS the cells retargets the chase — the picture moves.
  const cellsB = [cellsA[2], cellsA[0], cellsA[1]];   // c (repriced) now ranks first
  const beforeSnap = ops.length;
  blockTreemap(canvas, { cells: cellsB, totalVbytes: 1_000_000 }, full, lim);
  assert.ok(canvas.__anim.size >= 3, 'the animated cells live on the canvas between snapshots');
  let paintedWhileMoving = 0;
  for (let f = 0; f < 60 && canvas.__raf; f++) { clock.t += 16; const n = ops.length; frame(); if (ops.length > n) paintedWhileMoving += 1; }
  assert.ok(paintedWhileMoving > 5, `the reshuffle was painted over ${paintedWhileMoving} frames, not one`);
  assert.ok(ops.length > beforeSnap, 'the second snapshot led to many frames of motion');

  // Once settled, the loop parks: no more frames are requested while nothing moves.
  assert.ok(!canvas.__raf, `the loop parked itself once settled (raf=${canvas.__raf})`);
  const parkedAt = ops.length;
  clock.t += 1000; frame();
  assert.equal(ops.length, parkedAt, 'a parked loop paints nothing');

  // And a stalled clock must not spin it forever (hidden tab / inline host): every frame
  // is a frame, budget or park.
  clock.t = 0;
  const canvas2 = mkCanvas();
  blockTreemap(canvas2, { cells: cellsA, totalVbytes: 1_000_000 }, full, lim);
  let spun = 0;
  while (canvas2.__raf && spun < 500) { spun += 1; frame(); }   // clock NEVER advances
  assert.ok(spun <= 260, `the stalled-clock run ended on its budget (${spun} frames)`);
});

test('cells are bounded, and what is dropped becomes ONE labelled aggregate', () => {
  const txs = Array.from({ length: 900 }, (_, i) => ({ weight: 4 * (100 + (i % 50)), fee: 500 + i, txid: `x${i}` }));
  const v = templateCells(txs, { maxCells: 120 });
  assert.ok(v.cells.length <= 121, `bounded (${v.cells.length})`);
  const tail = v.cells.find((c) => c.aggregate);
  assert.ok(tail, 'an aggregate cell exists');
  assert.equal(v.tailCount + v.cells.length - 1, 900, 'every transaction is accounted for: drawn cells plus the aggregate');
  const sum = v.cells.reduce((n, c) => n + c.vbytes, 0);
  assert.ok(Math.abs(sum - v.totalVbytes) / v.totalVbytes < 0.02, 'the aggregated block is still the whole block');
});

test('cells come out richest first, because that is the miner rule the cut depends on', () => {
  const v = templateCells([
    { weight: 1000, fee: 500, txid: 'low' },
    { weight: 1000, fee: 50000, txid: 'high' },
    { weight: 1000, fee: 5000, txid: 'mid' },
  ]);
  assert.deepEqual(v.cells.map((c) => c.txid), ['high', 'mid', 'low']);
});

test('a half-empty block looks half-empty, not full', () => {
  // The canvas is a block. Rescaling the selection to fill it is how a block that is
  // 16% full gets photographed as a busy one.
  assert.equal(blockFillFraction(160_000, 4_000_000), 0.16);       // 160k vB of 1M vB
  assert.equal(blockFillFraction(1_000_000, 4_000_000), 1);         // exactly full
  assert.equal(blockFillFraction(1_400_000, 4_000_000), 1, 'never overflows the box');
  assert.equal(blockFillFraction(1_000, 4_000_000), 0.02, 'a hairline still has a floor');
  assert.equal(blockFillFraction(0, 4_000_000), 0.02);
  assert.equal(blockFillFraction(null, null), 0.02, 'no data is not 100% full');
});

test('the mempool cells follow the same rule as the block cells', async () => {
  const { summarizeMempool } = await import('../server/collect/monitor.js');
  // getrawmempool verbose shape: this node reports vsize, time and fees.base only.
  const raw = {};
  for (let i = 0; i < 900; i++) {
    raw[`t${String(i).padStart(4, '0')}`] = { vsize: 150 + (i % 60), time: 1788000000 + i, fees: { base: (0.5 + (i % 40)) * 150 / 1e8 } };
  }
  const d = summarizeMempool(raw);
  const cells = d.cells ?? [];
  assert.ok(cells.length > 0 && cells.length <= 401, `bounded (${cells.length})`);
  const agg = cells.filter((c) => c.aggregate);
  assert.ok(agg.length <= 1, 'at most one aggregate cell');
  const drawn = cells.filter((c) => !c.aggregate);
  assert.ok(drawn.length + (agg[0]?.aggregate ?? 0) >= 900 - 30,
    'the tail is aggregated, not dropped: drawn + aggregate accounts for the pool');
  const sum = cells.reduce((n, c) => n + c.vbytes, 0);
  assert.ok(Math.abs(sum - d.totalVsize) / d.totalVsize < 0.03,
    `cells add up to the pool (${sum} vs ${d.totalVsize})`);
  const rates = cells.map((c) => c.rate);
  assert.deepEqual(rates, [...rates].sort((a, b) => b - a), 'richest first — the miner order');
});

test('an empty mempool produces no cells rather than an empty picture of something', async () => {
  const { summarizeMempool } = await import('../server/collect/monitor.js');
  const d = summarizeMempool({});
  assert.equal(d.count, 0);
  assert.equal(d.cells.length, 0);
});

test('the drawing path actually runs, not just the layout', async () => {
  // The geometry was tested for a while and the DRAWING was not -- and the drawing was
  // broken: drawFrame referenced `label` without destructuring it, so every partly-filled
  // block threw at paint time and the canvas stayed blank. A test that only checks maths
  // cannot see a crash in the code that puts pixels on screen, so this one drives the
  // real entry point with a recording context and asserts nothing threw.
  const { blockTreemap, mempoolTreemap } = await import('../public/js/goggles.js');
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: true }) };
  globalThis.matchMedia = () => ({ matches: true });
  const ops = [];
  const mkCanvas = () => ({
    clientWidth: 800, clientHeight: 200, width: 0, height: 0, style: {},
    parentElement: { querySelector: () => null },
    addEventListener() {}, querySelector: () => null,
    getContext: () => new Proxy({ canvas: {} }, {
      get: (t, k) => (k === 'canvas' ? t.canvas : (...a) => { ops.push(`${String(k)}:${a.map((x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : x)).join(',')}`); return t.canvas; }),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
  });

  const cells = [
    { vbytes: 500_000, rate: 8, txid: 'a' },
    { vbytes: 300_000, rate: 1, txid: 'b' },
    { vbytes: 200_000, rate: 0.5, aggregate: 10 },
  ];
  let threw = null;
  try {
    blockTreemap(mkCanvas(), { cells, totalVbytes: 1_000_000, tailCount: 10 }, { remainingWeight: 2_700_000 }, { weightLimit: 4_000_000 });
    mempoolTreemap(mkCanvas(), { cells, totalVsize: 1_000_000 }, { blockVbytes: 1_000_000 });
  } catch (e) { threw = e; }
  assert.equal(threw, null, `the draw path must not throw: ${threw?.message}`);
  assert.ok(ops.some((o) => o.startsWith('fillRect')), 'it painted rectangles');
  assert.ok(ops.some((o) => o.includes('unfilled') || o.includes('fits in one block') || o.includes('selection ends')), 'it wrote its own legend text');
  assert.ok(!ops.some((o) => o.includes('block capacity')), 'it does not call the selection edge a capacity it is not');
});

test('the animation loop cannot run away from the page', async () => {
  // A tween that only stops when the clock advances will re-request frames forever on a
  // hidden/throttled tab, or on any host whose requestAnimationFrame runs inline. The
  // frame budget ends the run no matter what the clock does, and the settled layout is
  // drawn. (2026-09-10: the budget lives inside step(); the guard is that the REQUESTED
  // count stays bounded even when the clock never moves.)
  const { blockTreemap } = await import('../public/js/goggles.js');
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => 0 };              // a clock that never moves
  let requests = 0;
  globalThis.requestAnimationFrame = (fn) => { requests += 1; fn(0); return requests; };
  globalThis.cancelAnimationFrame = () => {};
  const ops = [];
  const canvas = {
    clientWidth: 800, clientHeight: 200, width: 0, height: 0, style: {},
    parentElement: { querySelector: () => null }, addEventListener() {},
    getContext: () => new Proxy({ canvas: {} }, {
      get: (t, k) => (k === 'canvas' ? t.canvas : () => { ops.push(String(k)); return t.canvas; }),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
  };
  blockTreemap(canvas, { cells: [{ vbytes: 500, rate: 3, txid: 'a' }, { vbytes: 900, rate: 1, txid: 'b' }], totalVbytes: 1400 }, { remainingWeight: 2e6 }, { weightLimit: 4e6 });
  // ...and when it ends, the LAST frame must be the settled layout, not a half-chased
  // one: with the clock frozen, easeOutCubic never reaches 1, so the step's `done`
  // branch is what has to snap every tracked cell to its target before the last paint.
  const seen = (canvas.__view?.items ?? []).filter((it) => !it.departing);
  assert.ok(seen.length >= 2, 'the loop tracked its cells');
  const settled = seen.every((it) => Math.abs((it.x ?? it.tx) - it.tx) < 0.01 && Math.abs((it.y ?? it.ty) - it.ty) < 0.01);
  assert.ok(settled, 'the final frame is at the settled layout');
  assert.ok(ops.includes('fillRect'), 'and it still drew');
});

test('the map is never left blank: no clearRect is the last thing that touched the canvas', async () => {
  // The complaint was "the block space view disappears after the first update" — and a
  // frozen-clock host (an inline rAF stub, a throttled tab) reproduced it in code: the
  // chase cleared the canvas, then drawFrame threw for an unrelated reason, and the
  // blank was all that survived. The loop must always END on a painted frame. This
  // asserts the last canvas op of a full run is a paint, not a clear — the exact
  // signature the disappearance left behind.
  const { blockTreemap } = await import('../public/js/goggles.js');
  const clock = { t: 0 };
  let pending = null;
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => clock.t };
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 2; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {}, createPattern: () => null }) }) };
  const ops = [];
  const mkCtx = () => new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      return (...a) => { ops.push(String(k)); return t.canvas; };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = {
    clientWidth: 430, clientHeight: 430, width: 0, height: 0, style: {},
    parentElement: { querySelector: () => null }, addEventListener() {},
    getContext: () => mkCtx(),
  };
  const cells = [
    { vbytes: 120_000, rate: 20, txid: 'a' },
    { vbytes: 80_000, rate: 5, txid: 'b' },
    { vbytes: 400_000, rate: 0.4, aggregate: 3200 },
  ];
  const snap = (j) => blockTreemap(canvas, { cells, totalVbytes: 600_000 }, { remainingWeight: 0 }, { weightLimit: 4_000_000 });
  snap(0);
  for (let f = 0; f < 300 && pending; f++) {
    clock.t += 16;
    const fn = pending; pending = null;
    try { fn(clock.t); } catch { /* the loop must survive a bad frame */ }
    if (f % 7 === 6) snap(f);           // snapshots land mid-chase, as they do live
  }
  const last = ops[ops.length - 1];
  assert.notEqual(last, 'clearRect', `the last thing painted was "${last}" — a settled canvas must end on a paint, never on a clear`);
});
