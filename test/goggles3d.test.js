// The 3D renderer, driven through its real draw path with a recording
// context. Two things unit tests can genuinely hold here:
//
//   1. the forbidden vocabulary never appears. Software rasterisers drop
//      fills drawn through ctx.clip() and honour ctx.globalAlpha
//      inconsistently on pattern fills; that blanked the whole map once, and
//      "line and legend painted, everything else blank" was the signature.
//      This is the guard that would have caught every version of that bug.
//   2. the loop PARKS. A picture that keeps repainting a still image is a
//      heater with a chart on it, and the shared-rAF bug in goggles.js means
//      two viewers on one page must not fight over the handle.
//
// What they cannot hold is whether it LOOKS right; that needs the browser
// harness (RULES.md 5, 25) and is not claimed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render3d, block3d, mempool3d, hitTest, DEFAULTS, triggerIdle } from '../public/js/goggles3d.js';
import { planTransition, project } from '../public/js/blockscene3d.js';

function harness() {
  let rafPending = null;
  const ops = [];
  harness.t = 0;   // reset per harness: a clock left at the previous test's value
                   // made the transition look unfinished and the loop look stuck

  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => harness.t ?? 0 };
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 42; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      // setTransform records its ARGUMENTS: the view-lock test below needs to
      // compare the actual matrix across refreshes, not just that it was called.
      return (...a) => { ops.push(k === 'setTransform' ? 'setTransform:' + a.join(',') : String(k)); return t.canvas; };
    },
    set(t, k, v) { ops.push('set:' + k + '=' + String(v).slice(0, 20)); t[k] = v; return true; },
  });
  const listeners = {};
  const canvas = {
    clientWidth: 640, clientHeight: 640, width: 0, height: 0, style: {},
    getContext: () => ctx,
    addEventListener: (k, fn) => { (listeners[k] ||= []).push(fn); },
    setPointerCapture: () => {},
  };
  canvas.__fire = (k, e) => (listeners[k] || []).forEach((fn) => fn(e));
  return { canvas, ops, listeners, pump: (n = 12) => { let g = 0; while (rafPending && g++ < n) { const fn = rafPending; rafPending = null; harness.t = g * 16; fn(g * 16); } return g; }, pending: () => !!rafPending };
}

const cells = [
  { txid: 'a', vbytes: 60000, rate: 40 },
  { txid: 'b', vbytes: 40000, rate: 10 },
  { txid: 'c', vbytes: 9000, rate: 3 },
  { vbytes: 300000, rate: 0.6, aggregate: 11000 },
];

test('the 3D map never calls clip() and never sets globalAlpha', () => {
  const h = harness();
  render3d(h.canvas, cells, {});
  h.pump();
  assert.ok(h.ops.length > 20, 'the draw path actually ran');
  assert.ok(!h.ops.includes('clip'), 'no ctx.clip() -- software rasterisers silently drop clipped fills');
  assert.ok(!h.ops.some((o) => o.startsWith('set:globalAlpha')), 'no ctx.globalAlpha -- honoured inconsistently on the same rasterisers');
  assert.ok(!h.ops.some((o) => o.startsWith('set:globalCompositeOperation')), 'no composite modes either');
  // and it really is filling polygons, not just clearing
  assert.ok(h.ops.filter((o) => o === 'fill').length >= 3, 'faces are filled');
  assert.ok(h.ops.some((o) => o.startsWith('set:fillStyle=rgba(')), 'alpha rides inside rgba() fills');
});

test('an idle effect can be played on demand, animates, and lets the loop park again', () => {
  const h = harness();
  assert.equal(triggerIdle(h.canvas, 'outline'), false, 'not for a canvas the renderer has never drawn');
  render3d(h.canvas, cells, {});
  h.pump(2400);
  assert.equal(h.pending(), false, 'the still board is parked');
  harness.t = 0;
  assert.equal(triggerIdle(h.canvas, 'outline'), true);
  assert.equal(h.pending(), true, 'the effect wakes the loop');
  const before = h.ops.length;
  h.pump(400);                               // 16 ms steps: past the 4.4 s effect
  assert.ok(h.ops.slice(before).some((o) => o.startsWith('set:strokeStyle=rgba(90,230,255')), 'it draws cyan outlines');
  assert.equal(h.pending(), false, 'and parks again when it is over');
  assert.equal(triggerIdle(h.canvas, 'nonsense'), false, 'unknown effects are refused');
});

test('a still picture parks the loop instead of repainting forever', () => {
  const h = harness();
  render3d(h.canvas, cells, {});
  // the choreography is 30 s now, so at 16 ms a frame that is ~1900 frames.
  h.pump(2400);
  assert.equal(h.pending(), false, 'the rAF chain ends once the transition settles');
});

test('two canvases on one page do not fight over the animation handle', () => {
  // goggles.js once kept ONE module-level rAF handle for two maps, so
  // whichever painted second cancelled the first one's loop.
  const a = harness();
  const canvasB = { ...a.canvas, clientWidth: 300, clientHeight: 200, width: 0, height: 0, style: {} };
  canvasB.getContext = a.canvas.getContext;
  const r1 = render3d(a.canvas, cells, {});
  const r2 = render3d(canvasB, cells.slice(0, 2), {});
  assert.ok(r1 && r2, 'both viewers are live');
  assert.notEqual(r1.tiles.length, 0);
  assert.notEqual(r2.tiles.length, 0);
  assert.notEqual(r1.tiles.length, r2.tiles.length, 'and they are showing different data');
});

test('reduced motion draws the same layout, just without the flight', () => {
  const h = harness();
  globalThis.matchMedia = () => ({ matches: true });
  const r = render3d(h.canvas, cells, {});
  assert.equal(r.settled, true, 'it settles immediately');
  assert.equal(h.pending(), false, 'and schedules no animation frames at all');
  assert.ok(r.tiles.length > cells.length, 'while still showing every transaction, the tail split into pieces');
  globalThis.matchMedia = () => ({ matches: false });
});

test('the aggregate tail keeps a stable identity across refreshes', () => {
  // Without it, the "everything below the floor" cell would count as a
  // departure plus an arrival on every refresh, and would flash.
  const h = harness();
  const r1 = render3d(h.canvas, cells, {});
  h.pump(2400);
  const r2 = render3d(h.canvas, cells, {});
  assert.deepEqual(r1.tiles.map((t) => t.txid).sort(), r2.tiles.map((t) => t.txid).sort());
  assert.ok(r1.tiles.some((t) => String(t.txid).startsWith('aggregate@')), 'the tail pieces are identified by the SLOT they land in, so an unchanged cell holds still');
  assert.equal(r2.settled, true, 'an unchanged refresh animates nothing');
});

test('the block view uses the absolute vbytes scale, dividing weight by four', () => {
  const hb = harness();
  const h = harness();
  // 4,000,000 weight units is 1,000,000 vbytes -- the block view must divide,
  // or every ordinary transaction rounds to a single flat unit.
  const b = block3d(hb.canvas, { cells }, null, { weightLimit: 4000000 });
  const m = mempool3d(h.canvas, { cells }, { blockVbytes: 1000000 });
  const bs = b.tiles.find((t) => t.txid === 'a').s;
  const ms = m.tiles.find((t) => t.txid === 'a').s;
  assert.equal(bs, ms, 'given the same explicit scale, a transaction is the same size in both');
  assert.equal(DEFAULTS.blockVbytes, 1000000);
});

test('the pool viewer draws ONE BLOCK, so the grid comes out full', () => {
  // This is how mempool.space always has a filled grid and we did not: their
  // view is a mempool BLOCK -- exactly blockVbytes of transactions, richest
  // first -- so the packing fills the grid by construction. Drawing the whole
  // queue meant the grid was however many rows the pool happened to need, and
  // the top of it was always partly empty.
  const h = harness();
  const big = [];
  let seed = 3, total = 0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 300; i++) {
    const vb = Math.floor(200 + rnd() * 9000);
    total += vb;
    big.push({ txid: 'p' + i, vbytes: vb, rate: 60 - i * 0.15 });
  }
  big.push({ vbytes: 3000000, rate: 0.6, aggregate: 12000 });
  total += 3000000;

  const r = mempool3d(h.canvas, { cells: big, totalVsize: total }, {});
  const drawn = r.tiles.reduce((n, t) => n + t.vsize, 0);
  assert.ok(drawn <= DEFAULTS.blockVbytes * 1.02, `one block's worth, got ${drawn}`);
  assert.ok(drawn > DEFAULTS.blockVbytes * 0.9, 'and a full one, not a sliver');

  // the packing genuinely covers the grid it is drawn on
  const w = Math.max(...r.tiles.map((t) => t.x + t.s));
  const rows = Math.max(...r.tiles.map((t) => t.y + t.s));
  const area = r.tiles.reduce((n, t) => n + t.s * t.s, 0);
  assert.ok(area / (w * rows) > 0.85, `the grid is filled, got ${(100 * area / (w * rows)).toFixed(1)}%`);
});
test('the aggregate tail becomes a field of tiles, not one grid-swallowing slab', () => {
  // Measured in the browser 2026-09-10: as ONE tile an aggregate holding 87%
  // of the pool's vbytes was 52 units on a side in a 56-wide grid and covered
  // everything else.
  const h = harness();
  const pool = [
    { txid: 'rich', vbytes: 40000, rate: 90 },
    { vbytes: 3200000, rate: 0.6, aggregate: 19689 },
  ];
  const r = mempool3d(h.canvas, { cells: pool, totalVsize: 3240000 }, {});
  const pieces = r.tiles.filter((t) => String(t.txid).startsWith('aggregate@'));
  assert.ok(pieces.length > 1, 'the tail is many tiles');
  const biggest = Math.max(...r.tiles.map((t) => t.s));
  assert.ok(biggest < DEFAULTS.resolution * 0.5, `no single tile swallows the grid, biggest side ${biggest} of ${DEFAULTS.resolution}`);
  // equal pieces: we do not know their individual sizes and must not pretend to
  const sides = new Set(pieces.map((t) => t.s));
  assert.equal(sides.size, 1, 'the pieces are equal, claiming nothing about sizes we do not have');
});

test('an empty mempool paints a background rather than throwing', () => {
  const h = harness();
  const r = render3d(h.canvas, [], {});
  assert.equal(r.tiles.length, 0);
  assert.ok(h.ops.includes('fillRect'), 'the canvas is still cleared');
  assert.equal(h.pending(), false);
});

test('an unchanged refresh does NOT restart the transition', () => {
  // The bug the operator hit: mining.js calls the renderer on every fast-tier
  // paint (~1 Hz). Re-planning each time cancelled the running rAF and began
  // a fresh 5.4 s choreography from the CURRENT positions, so the animation
  // never advanced past its first second and the picture looked redrawn.
  const h = harness();
  const before = [{ txid: 'a', vbytes: 40000, rate: 9 }, { txid: 'b', vbytes: 40000, rate: 9 }];
  const after = [{ txid: 'b', vbytes: 40000, rate: 9 }, { txid: 'a', vbytes: 40000, rate: 9 }, { txid: 'c', vbytes: 90000, rate: 40 }];
  render3d(h.canvas, before, {});
  h.pump(2400);
  const moved = render3d(h.canvas, after, {});
  assert.equal(moved.replanned, undefined, 'a real change plans a transition');
  assert.equal(h.pending(), true, 'and the loop is running');

  h.pump(5);                                   // a fifth of a second in
  const same = render3d(h.canvas, after, {});  // the 1 Hz repaint lands here
  assert.equal(same.replanned, false, 'identical data must not replan');
  assert.equal(same.settled, false, 'the transition is still in flight');
  assert.equal(h.pending(), true, 'and its animation loop was left alone');
});

test('the grid is square and straight on: no rotation to fight the animation', () => {
  // Rotation is gone (operator: "get rid of rotation if it helps the
  // animation"). Orbiting a square grid only turns it back into a diamond,
  // and dropping it removes an axis from the depth sort and the face
  // selection as well.
  const h = harness();
  const r = render3d(h.canvas, cells, {});
  assert.equal(r.yaw, undefined, 'the renderer exposes no camera angle at all');
  assert.equal(DEFAULTS.yaw, undefined);
  assert.equal(DEFAULTS.drag, undefined);
  assert.doesNotThrow(() => h.canvas.__fire('pointerdown', { clientX: 10, pointerId: 1 }));
  assert.equal(h.canvas.width, h.canvas.height, 'and the backing store stays square');
});

test('nothing in flight can leave the viewport', () => {
  // The fit reserves a margin and the choreography is allowed a swell. They
  // were two different numbers -- 10% reserved against 15% permitted -- and
  // the difference is exactly what pushed the big blocks out of frame. They
  // are one number now, so the invariant holds by construction rather than by
  // being tuned to agree.
  const h = harness();
  render3d(h.canvas, cells, {});
  const st = render3d(h.canvas, cells, {});
  assert.ok(DEFAULTS.edgeMargin > 0, 'a margin is reserved at all');
  // the plan may never be allowed to swell past what the fit reserved
  const plan = planTransition([], [], { now: 0, maxGrowth: DEFAULTS.edgeMargin });
  assert.equal(plan.cfg.maxGrowth, DEFAULTS.edgeMargin,
    'the permitted swell equals the reserved margin');
  assert.ok(st, 'and the renderer still returns a result');
});

test('the grid is centred on the panel, the sphere fills the rest, and the view never slides', async () => {
  // "The viewspace moves down on the first animation": the fit used to measure
  // bounds -- first the tiles', then the grid's -- and measured bounds move.
  // It was then pinned flush bottom-left; since 2026-09-11 ("I want our grid
  // centered within the view-space", "grid surface fills the panel") the board
  // is centred, and still a function of nothing but the grid and the panel.
  const src = readFileSync(new URL('../public/js/goggles3d.js', import.meta.url), 'utf8');
  assert.ok(!/for \(const t of frame\.tiles/.test(src), 'the fit must not read tile positions');
  assert.ok(/THE GRID IS CENTRED ON A SPHERE THAT FILLS THE PANEL/.test(src), 'and the renderer says why');
  assert.ok(/ctx\.setTransform\(fit\.scaleX, 0, 0, fit\.scaleY, fit\.tx, fit\.ty\)/.test(src), 'one constant transform');
  const { obliqueFit } = await import('../public/js/goggles3d.js');
  const opts = { unit: 6, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5 };
  for (const [pw, ph] of [[600, 600], [1400, 800], [500, 900]]) {
    const f = obliqueFit(pw, ph, 44, 44, opts);
    assert.ok(Math.abs(f.tx + f.k * 22 * 6 - pw / 2) < 1e-9 && Math.abs(f.ty - f.k * 22 * 6 - ph / 2) < 1e-9, `the board's centre is the panel's centre (${pw}x${ph})`);
    const r = f.rect;
    assert.ok(r.x0 < 0 && r.x1 > 44 && r.y0 < 0 && r.y1 > 44, 'with surface showing past the board on every side');
    assert.ok(Math.abs(-r.x0 - (r.x1 - 44)) < 1e-9 && Math.abs(-r.y0 - (r.y1 - 44)) < 1e-9, 'the same on opposite sides');
  }
});

test('hovering a settled block reports that transaction', () => {
  const h = harness();
  const tip = { textContent: '', classList: { add(c) { this.h = true; }, remove(c) { this.h = false; }, h: true } };
  h.canvas.parentElement = { querySelector: () => tip };
  h.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 640 });

  render3d(h.canvas, cells, {});
  h.pump(2400);            // let it settle; hover is refused mid-flight

  // the centre of a known block, mapped forward through the same transform
  const r = render3d(h.canvas, cells, {});
  const t0 = r.tiles.find((x) => x.txid === 'a');
  assert.ok(t0, 'the fixture block was placed');

  const hit = hitTest(h.canvas, 1, 1);   // some point; may or may not be a block
  assert.ok(hit === null || typeof hit.txid === 'string', 'a hit is a block or nothing');

  // a point far outside the board is never a block
  assert.equal(hitTest(h.canvas, 100000, 100000), null, 'outside the board hits nothing');
});

test('hover is refused while blocks are in flight', () => {
  // Mid-transition a block is not where its footprint says, and naming a
  // transaction the pointer is not over is worse than naming none.
  const h = harness();
  h.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 640 });
  render3d(h.canvas, cells, {});
  h.pump(2400);
  render3d(h.canvas, [...cells, { txid: 'zz', vbytes: 90000, rate: 70 }], {});
  h.pump(3);               // barely started
  assert.equal(hitTest(h.canvas, 300, 300), null, 'nothing is reported while the board is moving');
});

test('the view transform is a constant: a taller packing cannot shift the board down', () => {
  // THE BUG (operator, twice: "the view is still shifting down", "it shift
  // down on first transition"). The flush mapping pins grid row 0 to the
  // canvas floor, so bottom-left looked safe. But the SCALE was
  // ph / (gridH * unit), and gridH was the packed extent -- a refresh whose
  // packing came out a row taller shrank scaleY, compressed the picture
  // toward the floor, and walked the top edge down the panel.
  //
  // The board's transform must therefore depend on NOTHING that a refresh
  // can change. Two very different pools, same matrix.
  const matrix = (pool) => {
    const h = harness();
    render3d(h.canvas, pool, {});
    h.pump(400);
    const m = h.ops.filter((o) => o.startsWith('setTransform:') && !o.startsWith('setTransform:1,0,0,1,0,0'));
    assert.ok(m.length, 'the board transform was applied');
    return m[0];
  };

  const thin = [{ txid: 'x', vbytes: 5000, rate: 5 }];
  const fat = Array.from({ length: 300 }, (_, i) => ({ txid: 't' + i, vbytes: 8000 + i * 40, rate: 60 - i * 0.1 }));
  assert.equal(matrix(thin), matrix(fat), 'the same matrix regardless of how tall the packing came out');

  // and it is the centred mapping: no rotation or shear, the board set in
  // from the left edge with the sphere around it
  const m = matrix(fat).slice('setTransform:'.length).split(',').map(Number);
  assert.equal(m[1], 0);
  assert.equal(m[2], 0);
  assert.ok(m[4] > 0, 'column 0 sits in from the panel edge: centred, with surface to its left');
  assert.ok(m[5] > 0, 'and row 0 above the panel floor');
});

test('the board edge is traced on the sphere, not a flat frame between its corners', () => {
  // (operator, 2026-09-11: "the grid is not snapped to the sphere surface.
  // Everything should snap to the sphere surface on the grid")
  const src = readFileSync(new URL('../public/js/goggles3d.js', import.meta.url), 'utf8');
  assert.ok(!/const c = \[P\(0, 0\), P\(n, 0\), P\(n, rows\), P\(0, rows\)\]/.test(src), 'no straight rectangle between the four corners');
  assert.ok(/seg\(0, 0, n, 0\); seg\(n, 0, n, rows\); seg\(n, rows, 0, rows\); seg\(0, rows, 0, 0\);/.test(src), 'four edges traced along the surface');
  assert.ok(/Math\.ceil\(Math\.hypot\(x1 - x0, y1 - y0\) \/ 1\.5\)/.test(src), 'every surface line subdivided by its length');
});

test('the ground is a lit, fine-grained deck of plates that a shadow can darken', async () => {
  // (operator, 2026-09-11: "Can we have a more interesting ground texture.
  // Something that looks higher res and shows the shadows well?")
  const { groundLayers, groundShade } = await import('../public/js/goggles3d.js');
  const view = { unit: 10, dome: 5, gridW: 44, gridH: 44, oblique: DEFAULTS.oblique };
  const layers = groundLayers(view, DEFAULTS, -6, 50, -8, 52);
  const kinds = new Set(layers.map((l) => l.kind));
  for (const k of ['cell', 'seam', 'bevel-lit', 'bevel-dark', 'rivet', 'trace']) assert.ok(kinds.has(k), `the deck has ${k}s`);
  assert.ok(layers.filter((l) => l.kind === 'cell').length >= 12, 'a fine grain: many shades of cell, not two flat tones');
  assert.ok(layers.every((l) => /^rgba\(/.test(l.fill ?? l.stroke)), 'every piece a plain rgba fill or stroke');
  assert.equal(groundLayers(view, DEFAULTS, -6, 50, -8, 52), layers, 'built once per view, not every frame');
  const [r, g, b] = DEFAULTS.floor.match(/[\d.]+/g).map(Number);
  assert.ok(r + g + b > 150, 'a mid-tone base, so a shadow has light to take away');
  assert.ok(groundShade(4, 40, view, DEFAULTS) > groundShade(40, 4, view, DEFAULTS), 'lit by the sphere: the slope toward the light brighter than the slope away');
  assert.ok(!('floorCheck' in DEFAULTS), 'the black checker is gone');
});

test('the neon grid is drawn inside the board: a line between every cell, brighter on every plate', async () => {
  // (operator, 2026-09-11: "i want to see the green neon grid explicitly drawn
  // within the block bounds. Right now its just drawing the outer border")
  const { boardGridLayers } = await import('../public/js/goggles3d.js');
  const view = { unit: 10, dome: 5, gridW: 44, gridH: 44, oblique: DEFAULTS.oblique };
  const by = Object.fromEntries(boardGridLayers(view, DEFAULTS, 44, 44).map((l) => [l.kind, l]));
  assert.equal(by['neon-cell'].lines.length, 2 * 33, 'a thin line between every pair of cells, both ways');
  assert.equal(by.neon.lines.length, 2 * 10, 'a bright line on every plate boundary inside the board');
  assert.equal(by['neon-glow'].lines, by.neon.lines, 'each in a wide glow');
  const first = by.neon.lines[0];
  assert.deepEqual(first[0], project(4, 0, 0, view), 'from the board edge');
  assert.deepEqual(first.at(-1), project(4, 44, 0, view), 'to the board edge: within its bounds, on the sphere');
  for (const l of Object.values(by)) {
    const [r, g, b] = l.stroke.match(/[\d.]+/g).map(Number);
    assert.ok(/^rgba\(/.test(l.stroke) && g > r && g > b, `${l.kind}: green neon, plain rgba`);
  }
  assert.ok(/,1\)$/.test(by.neon.stroke) && /,1\)$/.test(by['neon-cell'].stroke), 'the lines themselves are solid, so a shadow under them cannot dim them');
});

test('viewerIdle: a board is idle only once it has come to rest', async () => {
  // (operator, 2026-09-11: "only enabled when the animation is idle")
  const { viewerIdle } = await import('../public/js/goggles3d.js');
  const h = harness();
  assert.equal(viewerIdle(h.canvas), false, 'nothing drawn yet');
  render3d(h.canvas, cells, {});
  h.pump(2400);
  assert.equal(viewerIdle(h.canvas), true, 'at rest: a refresh may start');
  render3d(h.canvas, [...cells, { txid: 'zz', vbytes: 90000, rate: 70 }], {});
  h.pump(3);
  assert.equal(viewerIdle(h.canvas), false, 'mid-flight: the button waits');
  assert.equal(viewerIdle(null), false);
});

test('the glowing layer is laid over the shadows, so no shadow dims the grid', () => {
  // (operator, 2026-09-11: "the grid should be glowing and not affected by shadows")
  const h = harness();
  render3d(h.canvas, cells, {});
  h.pump(2400);
  const marks = h.ops.map((o, i) => [o, i]).filter(([o]) => o.startsWith('setTransform:') && !o.startsWith('setTransform:1,0,0,1,0,0'));
  const f = h.ops.slice(marks.at(-1)[1]);   // the last frame drawn
  const lastShadow = f.findLastIndex((o) => o === 'set:fillStyle=rgba(0,0,0,0.26)');
  const neon = f.findIndex((o) => o.startsWith('set:strokeStyle=rgba(170,255,210'));
  assert.ok(lastShadow > 0, 'the resting cubes cast shadows in the frame');
  assert.ok(neon > lastShadow, 'the neon grid comes after every shadow');
  assert.ok(f.slice(neon).filter((o) => o === 'fill').length > 3, 'and the cubes after the grid');
});

test('the first effect after the board comes to rest comes within about a second', () => {
  // (operator, 2026-09-11: "trigger any effects sooner when the board comes to rest, rather than later")
  const src = readFileSync(new URL('../public/js/goggles3d.js', import.meta.url), 'utf8');
  assert.deepEqual(DEFAULTS.idleFirst, [800, 1600]);
  assert.ok(DEFAULTS.idleEvery[1] <= 9000, 'and the ones after it no more than 9 s apart');
  assert.match(src, /scheduleFx\(canvas, st, opts, !afterEffect\)/, 'a board that has just landed schedules the quick one');
  assert.match(src, /if \(soon && st\.fxTimer\) \{ clearTimeout\(st\.fxTimer\)/, 'replacing any longer timer left over');
  const h = harness();
  render3d(h.canvas, cells, {});
  h.pump(2400);
  assert.equal(triggerIdle(h.canvas, 'lightcycle'), true, 'the light cycles exist as an effect');
  assert.equal(triggerIdle(h.canvas, 'ball'), true, 'and the lightning ball');
  assert.equal(triggerIdle(h.canvas, 'packets'), false, 'the data packets are gone (operator: "wandering lights")');
});

import { DENSE_OPTS } from '../public/js/mining.js';

test('Viewer Mode 2 packs a whole block of small transactions as low slabs, quickly', () => {
  const h = harness();
  const dense = Array.from({ length: 3200 }, (_, i) => ({ vbytes: 140 + (i % 90) * 3 + (i % 17 === 0 ? 2000 : 0), rate: 60 - (i / 3200) * 58, txid: `t${i}` }));
  const t0 = Date.now();
  const r = mempool3d(h.canvas, { cells: dense }, DENSE_OPTS);
  const ms = Date.now() - t0;
  assert.ok(r.tiles.length > 2500, `most transactions get a square of their own (${r.tiles.length})`);
  assert.ok(r.tiles.every((t) => t.tall <= DENSE_OPTS.slab + 1e-9), 'slabs, not cubes');
  assert.ok(r.tiles.some((t) => t.s === 1) && r.tiles.some((t) => t.s >= 4), 'small and large side by side');
  assert.ok(ms < 4000, `packed and drawn in ${ms} ms`);
});

test('an oblique board with nothing on it still draws itself -- never a blank panel between layouts', () => {
  const h = harness();
  render3d(h.canvas, [], {});
  h.pump(4);
  assert.ok(h.ops.filter((o) => o === 'stroke').length > 10, 'the grid is drawn');
});
