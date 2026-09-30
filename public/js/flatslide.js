// SPDX-License-Identifier: Apache-2.0
//
// flatslide.js -- the Simple renderer's slide between two layouts (operator, 2026-09-30: "I would
// like to incorporate a shifting tiles animation in 2D like mempool space app does ... that works well
// in simple mode" -- then "build it, Simple mode first, 1s slide with the row wave").
//
// WHY NOT THE CHOREOGRAPHY. The 3D renderers plan a flight per tile (planTransition) and rebuild the
// whole scene every frame (buildScene): measured in node on 2026-09-30, 8.6 ms for a 491-tile Simple
// board and 111 ms for a 3,000-tile Detailed one -- once per layout that is fine, sixty times a second
// it is not. So the slide never builds a scene. It takes the ops of the frame on screen and the ops of
// the settled frame to come, both built ONCE, pairs them by transaction, and each frame only moves
// points: a tile in both frames with the same faces has each point eased from where it was to where it
// goes; an arrival grows in from above its slot; a departure shrinks away where it stood. The move is
// in the plane -- nothing flies -- and each tile starts after a delay by its row, bottom row first (the
// row wave). The whole slide is SLIDE_MS, wave included.
//
// PAINT ORDER is the interpolated position in the two frames' own orders: at the start the frame on
// screen's order, at the end the settled frame's order, in between a blend. No camera maths, so it is
// exact at both ends whatever the camera is; mid-slide a tile passing a much taller one may cross it
// for a few frames.
//
// Pure: no DOM, no canvas, no clock. The ops are buildScene's ({ txid, face, points, fill, stroke }).
// Output ops are allocated once per slide and their points written in place each frame, so a frame
// allocates nothing but the sort.

export const SLIDE_MS = 1000;         // the whole slide, wave included
export const WAVE_MS = 300;           // the last row starts this long after the first
export const ENTER_ROWS = 4;          // an arrival starts this many rows above its slot

export function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

// group ops by txid, keeping each group's first index as its place in the paint order
function groupsOf(ops) {
  const m = new Map();
  const loose = [];
  ops.forEach((op, i) => {
    if (op?.txid == null) { loose.push(op); return; }
    const k = String(op.txid);
    let g = m.get(k);
    if (!g) m.set(k, (g = { ops: [], rank: i / Math.max(1, ops.length - 1) }));
    g.ops.push(op);
  });
  return { m, loose };
}
function centroid(ops) {
  let x = 0, y = 0, n = 0;
  for (const op of ops) for (const p of op.points || []) { x += p.x; y += p.y; n++; }
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}
const sameShape = (a, b) => a.length === b.length && a.every((op, i) => op.points?.length === b[i].points?.length);
const samePoints = (a, b) => a.every((op, i) => op.points.every((p, j) => p.x === b[i].points[j].x && p.y === b[i].points[j].y));
const copyOp = (op) => ({ ...op, points: op.points.map((p) => ({ x: p.x, y: p.y })) });

/**
 * Plan a slide. `from`: the ops on screen now (a settled frame, or a slide's current frame -- they are
 * copied, so a running slide's live ops may be passed). `to`: the settled frame's ops. `rows`: txid ->
 * the tile's grid row (to's row, or from's for a departure). `gridH`: rows on the board. `up`: one grid
 * row upward in op space ({x, y}). Returns null when there is nothing to slide.
 */
export function planSlide(from, to, { rows = new Map(), gridH = 1, up = { x: 0, y: -1 }, now = 0, ms = SLIDE_MS, wave = WAVE_MS } = {}) {
  if (!Array.isArray(from) || !Array.isArray(to) || !from.length || !to.length) return null;
  const A = groupsOf(from), B = groupsOf(to);
  const run = Math.max(1, ms - wave);
  const delayOf = (id) => wave * Math.max(0, Math.min(1, (Number(rows.get(id)) || 0) / Math.max(1, gridH)));
  const items = [];
  let moving = 0;
  for (const [id, g] of B.m) {
    const was = A.m.get(id);
    if (was && sameShape(was.ops, g.ops)) {
      if (samePoints(was.ops, g.ops)) { items.push({ kind: 'hold', ops: g.ops, r0: was.rank, r1: g.rank }); continue; }
      items.push({ kind: 'morph', a: was.ops.map(copyOp), b: g.ops, out: g.ops.map(copyOp), r0: was.rank, r1: g.rank, delay: delayOf(id) });
    } else if (was) {
      // the faces changed (a new size can change how many a cube has): the new cube, carried from the
      // old one's centre and scaled from its size
      const c0 = centroid(was.ops), c1 = centroid(g.ops);
      const s0 = spanOf(was.ops), s1 = spanOf(g.ops);
      items.push({ kind: 'carry', b: g.ops, out: g.ops.map(copyOp), c1, dx: c0.x - c1.x, dy: c0.y - c1.y, k0: s1 > 0 ? s0 / s1 : 1, r0: was.rank, r1: g.rank, delay: delayOf(id) });
    } else {
      const c1 = centroid(g.ops);
      items.push({ kind: 'carry', b: g.ops, out: g.ops.map(copyOp), c1, dx: up.x * ENTER_ROWS, dy: up.y * ENTER_ROWS, k0: 0, r0: g.rank, r1: g.rank, delay: delayOf(id) });
    }
    moving++;
  }
  for (const [id, g] of A.m) {
    if (B.m.has(id)) continue;
    const a = g.ops.map(copyOp);
    items.push({ kind: 'leave', a, out: a.map(copyOp), c0: centroid(a), r0: g.rank, r1: g.rank, delay: delayOf(id) });
    moving++;
  }
  if (!moving) return null;
  return { t0: now, run, ms, items, loose: B.loose, order: items.slice() };
}
function spanOf(ops) {
  let x0 = Infinity, x1 = -Infinity;
  for (const op of ops) for (const p of op.points || []) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; }
  return x1 > x0 ? x1 - x0 : 0;
}

/** The slide's frame at `now`: { ops, done }. When done, the ops are the settled frame's. */
export function sampleSlide(plan, now) {
  const t = now - plan.t0;
  if (t >= plan.ms) return { ops: null, done: true };
  const items = plan.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'hold') { it.k = 1; continue; }
    const u = Math.max(0, Math.min(1, (t - it.delay) / plan.run));
    const k = easeInOutCubic(u);
    it.k = k;
    if (it.kind === 'morph') {
      for (let j = 0; j < it.out.length; j++) {
        const pa = it.a[j].points, pb = it.b[j].points, po = it.out[j].points;
        for (let q = 0; q < po.length; q++) { po[q].x = pa[q].x + (pb[q].x - pa[q].x) * k; po[q].y = pa[q].y + (pb[q].y - pa[q].y) * k; }
      }
    } else if (it.kind === 'carry') {
      // the settled cube, offset back toward where it came from and scaled about its own centre
      const s = it.k0 + (1 - it.k0) * k, ox = it.dx * (1 - k), oy = it.dy * (1 - k), c = it.c1;
      for (let j = 0; j < it.out.length; j++) {
        const pb = it.b[j].points, po = it.out[j].points;
        for (let q = 0; q < po.length; q++) { po[q].x = c.x + (pb[q].x - c.x) * s + ox; po[q].y = c.y + (pb[q].y - c.y) * s + oy; }
      }
    } else {
      // a departure shrinks where it stood
      const s = 1 - k, c = it.c0;
      for (let j = 0; j < it.out.length; j++) {
        const pa = it.a[j].points, po = it.out[j].points;
        for (let q = 0; q < po.length; q++) { po[q].x = c.x + (pa[q].x - c.x) * s; po[q].y = c.y + (pa[q].y - c.y) * s; }
      }
    }
  }
  // paint order: each group's place, blended from the old frame's order to the new one's
  const order = plan.order;
  for (const it of order) it.key = it.r0 + (it.r1 - it.r0) * it.k;
  order.sort((p, q) => p.key - q.key);
  const ops = plan.loose.slice();
  for (const it of order) {
    if (it.kind === 'hold') { for (const op of it.ops) ops.push(op); continue; }
    if (it.kind === 'leave' && it.k >= 1) continue;
    for (const op of it.out) ops.push(op);
  }
  return { ops, done: false };
}
