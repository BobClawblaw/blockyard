// The block, drawn as the space it is: a treemap of the transactions the node selected,
// each rectangle sized by its vbytes and coloured by the feerate it paid, richest first.
//
// Why this shape: a list of 1,500 transactions tells you nothing about the one thing that
// matters -- that a block is a fixed budget and every transaction spends some of it. A
// treemap makes the budget the canvas. The big rectangles are the fat transactions; the
// coloured strip at the right edge is where the block ran out of room, which is the same
// line as "what feerate still got in".
//
// The order is the miner's rule, not a styling choice: highest feerate first, so the cut
// line means something. Rectangles animate between refreshes because the point of watching
// it is to see the ordering shift as the landscape moves -- with prefers-reduced-motion the
// same layout is drawn instantly and nothing is lost but the motion.
//
// The animation runs as a loop on the canvas, not as one draw per snapshot, for the same
// reason a mempool.space-style view works: the picture only reads as "alive" if it is
// actually in motion between snapshots. A new snapshot RETARGETS the loop (it never
// restarts it); the loop also keeps drawing so that time-linked effects — the marching
// cut line, the ring on cells that actually changed, the frontier creeping as the block
// assembles — have a frame to happen in. Everything that could be mistaken for data is
// anchored: areas are the layout's, colours are the palette's, pulses mark real churn,
// and the loop parks itself once the picture has settled. Nothing twinkles on its own
// authority.

import { paint, COL } from './charts.js';

function mix(a, b, t) {
  return a.map((v, k) => v + (b[k] - v) * t);
}

// The feerate ramp, tuned against the colours the live node's cells actually get
// (see test/floor-colour.test.js — the rates below are today's, from /api/mempool and
// /api/nextblock, not a guess). Two design facts from that data decide the shape:
//
// 1. The POOL's mass and the BLOCK's mass live in different halves of the range.
//    Pool: p50 4.1, p90 10.0, max 100. Block: max 8.4, median 0.4. A ramp that saves
//    its brightest third for 30-100 sat/vB leaves the entire BLOCK grey — so the
//    green/lime band starts where the block's top rates actually are (8-14), not where
//    a whale once paid.
// 2. The pool's floor aggregate (the majority by area) sits at 0.2-0.6. It must not be
//    a void (luma ~90 read as empty space); it is a visible, saturated steel-blue
//    "nobody paid" category, one colour across the band.
//
// Order is carried by warmth (cool -> warm) and saturation, not by luminance alone:
// luminance peaks at amber then falls toward crimson, so an assertion of "brighter per
// sat/vB" is false at the hot end, and was removed rather than the palette bent to it.
const RAMP = [
  { at: 0,   rgb: [92, 132, 228] },      // the relay floor: saturated steel-blue — a visible "unpaid" category
  { at: 1.6, rgb: [56, 158, 255] },      // above the floor at last
  { at: 3.4, rgb: [0, 194, 255] },       // electric cyan: the mempool median lives here
  { at: 7,   rgb: [21, 224, 132] },      // neon green: comfortably above it
  { at: 14,  rgb: [154, 230, 46] },      // lime: a real race (and the block's top end starts here)
  { at: 28,  rgb: [255, 209, 46] },      // amber: paying properly
  { at: 52,  rgb: [255, 124, 26] },      // orange: near the top of the day
  { at: 96,  rgb: [255, 68, 77] },       // red: racing the next block
  { at: 1e9, rgb: [255, 43, 111] },      // hot pink: paying handsomely (today's max: 100)
];

const hexOf = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * The palette, in one place, so the legend strip and the hover readout cannot drift from
 * what the cells are actually painted with.
 */
export function rateColor(rate) {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 0;
  let i = 0;
  while (i < RAMP.length - 2 && r > RAMP[i + 1].at) i++;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  const span = b.at - a.at;
  const t = span > 0 ? Math.max(0, Math.min(1, (r - a.at) / span)) : 0;
  return hexOf(mix(a.rgb, b.rgb, t));
}

/**
 * Squarified treemap. Pure: cells in, rectangles out, so the geometry can be tested
 * without a browser -- which matters because the one thing a treemap must never do is
 * lie about area. If a 2x-wide rectangle isn't 2x the vbytes, the picture is decoration.
 */
export function layoutTreemap(cells, w, h) {
  const items = (cells ?? [])
    .filter((c) => Number.isFinite(c?.vbytes) && c.vbytes > 0)
    .map((c) => ({ ...c }));
  const total = items.reduce((n, c) => n + c.vbytes, 0);
  if (!items.length || !(w > 0) || !(h > 0) || total <= 0) return [];

  // Scale every cell into the box once, in pixel area. From here on the only law is
  // "rect area == cell area", because a treemap that breaks that is decoration.
  const scale = (w * h) / total;
  for (const c of items) c.area = c.vbytes * scale;

  // Squarify's row-greedy needs the AREAS in descending order — that is the
  // classic algorithm's one real requirement, and the reason a hand-written
  // version of it can look correct while painting garbage. The input here is
  // the MINER's order (templateCells/poolCells sort by feerate, richest first,
  // and the note under the chart promises that order). Fed to the row loop
  // as-is, each row receives a size-ASCENDING run, the worst-ratio test flushes
  // after nearly every cell, and the map degenerates into slivers. Measured
  // 2026-09-10 against the live 433x433 map with a real template's 401 cells:
  // 45 rects with aspect ratio > 10 (worst 49:1) and 30 sub-2px rects on the
  // block view; 138 > 10:1 (worst 273:1) and 348 sub-2px on the mempool view.
  // Sorting a WORKING LIST only is deliberate: `items` keeps the miner order,
  // the rects below carry their cells' data wherever they land, and the paint
  // layer still draws aggregates first and real transactions on top. Fixed
  // with the live data: 0 rects over 10:1 on both maps (worst 2.6 / 4.6), and
  // the area law is untouched — it never depended on the order.
  const rowsrc = [...items].sort((a, b) => b.area - a.area);

  const rects = [];
  let x = 0;
  let y = 0;
  let rw = w;
  let rh = h;
  let row = [];

  const worst = (list, side) => {
    const s = list.reduce((n, c) => n + c.area, 0);
    if (s <= 0 || side <= 0) return Infinity;
    const mx = Math.max(...list.map((c) => c.area));
    const mn = Math.min(...list.map((c) => c.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };

  const flush = () => {
    if (!row.length || rw <= 0 || rh <= 0) { row = []; return; }
    const s = row.reduce((n, c) => n + c.area, 0);
    const side = Math.min(rw, rh);          // the row runs along the short edge
    const thickness = s / side;             // ...and this is how deep it is
    let offset = 0;
    for (const c of row) {
      const len = c.area / s * side;
      if (rw >= rh) rects.push({ ...c, x, y: y + offset, w: thickness, h: len });
      else rects.push({ ...c, x: x + offset, y, w: len, h: thickness });
      offset += len;
    }
    if (rw >= rh) { x += thickness; rw = Math.max(0, rw - thickness); }
    else { y += thickness; rh = Math.max(0, rh - thickness); }
    row = [];
  };

  for (const c of rowsrc) {
    if (row.length) {
      const side = Math.min(rw, rh);
      if (worst([...row, c], side) > worst(row, side)) flush();
    }
    row.push(c);
  }
  flush();

  // Greedy layouts can land the last cells a hair outside on degenerate input. Clamp --
  // overflow is the same class of error as a rectangle whose area is not its share.
  return rects.map((r) => {
    const cw = Math.max(0.001, Math.min(r.w, w - r.x));
    const ch = Math.max(0.001, Math.min(r.h, h - r.y));
    return { ...r, x: Math.max(0, r.x), y: Math.max(0, r.y), w: cw, h: ch };
  });
}

/**
 * The mempool picture: the whole waiting set, and where a single block's worth of space
 * would cut through it. On a pool smaller than one block the line sits past the right
 * edge -- and saying so is the honest result, because "everything currently waiting fits
 * in one block" is information, not a missing chart.
 */
export function mempoolTreemap(canvas, dist, opts = {}) {
  const cells = dist?.cells ?? [];
  const capacity = (opts.blockVbytes ?? 1_000_000);
  const total = Number.isFinite(dist?.totalVsize) ? dist.totalVsize : cells.reduce((n, c) => n + (c.vbytes || 0), 0);
  return drawMap(canvas, cells, {
    total,
    // Where one block's worth of space falls inside the pool. Beyond 100% means the whole
    // pool fits, and the note says that instead of drawing a line off-canvas.
    cutFrac: capacity > 0 && total > 0 ? Math.min(1, capacity / total) : 0,
    labelLine: capacity > 0 && total > capacity ? 'one block of space ends here' : null,
  });
}

/**
 * How much of the canvas the selection is allowed to claim, given that the canvas is a
 * whole block. A block that is 16% full must look 16% full -- rescaling the chosen
 * transactions to fill the box is how a half-empty block gets photographed as a busy one.
 */
export function blockFillFraction(totalVbytes, weightLimit = 4_000_000) {
  const capacity = (Number.isFinite(weightLimit) && weightLimit > 0 ? weightLimit : 4_000_000) / 4;
  const total = Number.isFinite(totalVbytes) ? totalVbytes : 0;
  if (capacity <= 0 || total <= 0) return 0.02;
  // A floor of 2% so a nearly-empty block still draws its cells instead of a hairline.
  return Math.max(0.02, Math.min(1, total / capacity));
}

/** Where the block ran out of room, in the same vbytes the cells are measured in. */
export function cutVbytes({ weightLimit = 4_000_000, remainingWeight = null }) {
  const cap = weightLimit / 4;
  return remainingWeight != null ? cap - remainingWeight / 4 : cap;
}

// An aggregate cell has no txid. Keying it by its feerate made every pool's tail cell
// share ONE key (they all sit at the pool's cut feerate), so two tails fought over the
// same animation slot and the frontier drew the wrong shape. Key by rank + mean rate:
// unique per snapshot, and stable enough that a tail that merely grew tweens.
const keyOf = (r, i) => (r.txid ? `t:${r.txid}` : `a:${i}:${Math.round(r.rate)}`);

const EASE = 0.18;            // frontier easing: ~150 ms to close the gap between cuts
const SETTLE_MS = 900;        // one reshuffle reads as ~600-900 ms of movement
const LEAVE_MS = 450;         // a departed cell fades out over this
const PULSE_MS = 1400;        // how long a cell that just changed stays ringed
const PARK_MS = 400;          // settled picture repaints at this cadence (marching line only)

// A tiny canvas tile, patterned once and reused: the hatched void is what "the block is
// not full" LOOKS like, and it costs one pattern fill instead of a per-cell loop.
const paintState = new WeakMap();   // one ctx -> its cached patterns, whatever a proxy says

function cachedPattern(ctx, key, makeTile) {
  let bag = paintState.get(ctx);
  if (!bag) { bag = {}; paintState.set(ctx, bag); }
  if (bag[key]) return bag[key];
  // makeTile itself can fail on a host with no `document` (a bare unit-test global);
  // that is the same "no pattern host" case as a missing createPattern, so it is caught
  // in the same breath rather than escaping into the draw path.
  const mk = (c) => {
    if (!c || typeof c.createPattern !== 'function') return null;
    const tile = makeTile();
    return tile ? c.createPattern(tile, 'repeat') : null;
  };
  let pat = null;
  try { pat = mk(ctx); } catch { pat = null; }
  if (!pat) {
    try {
      const off = new OffscreenCanvas(8, 8);
      pat = mk(off.getContext('2d'));
    } catch { /* no pattern host here — no texture is acceptable, a throw is not */ }
  }
  if (pat) bag[key] = pat;
  return pat;
}

function hatchPattern(ctx) { return cachedPattern(ctx, 'hatch', tileOf); }

// Map-context pattern cache for the crowd: ctx -> (tile canvas -> pattern). Patterns
// belong to the context that will paint them, and the crowd tiles are shared objects, so
// the cache key is the tile itself. A null result is cached too — a host whose
// createPattern is null should be asked exactly once per tile, not once per frame.
const patternByCtx = new WeakMap();
function crowdPatternFor(ctx, tile) {
  if (!tile) return null;
  let bag = patternByCtx.get(ctx);
  if (!bag) { bag = new Map(); patternByCtx.set(ctx, bag); }
  if (bag.has(tile)) return bag.get(tile);
  let pat = null;
  try { pat = typeof ctx.createPattern === 'function' ? ctx.createPattern(tile, 'repeat') : null; } catch { pat = null; }
  bag.set(tile, pat);
  return pat;
}

// The crowd's slow path: when a host cannot make a usable pattern (the measured-null
// headless case), the tiles are drawn straight onto the map, one fillRect per aggregated
// transaction. Correct everywhere; the pattern path is what makes it cheap.
function crowdTiles(ctx, it, x, y, rw, rh, n) {
  const side = Math.sqrt((rw * rh) / n);
  if (side >= 1.4) {
    const cols = Math.max(1, Math.floor(rw / side));
    const rows = Math.max(1, Math.floor(rh / side));
    ctx.fillStyle = 'rgba(233, 240, 250, 0.16)';
    const gap = Math.max(0.5, side * 0.22);
    const dot = Math.max(1, side - gap);
    for (let rI = 0; rI < rows; rI++) {
      const py = y + rI * side + gap / 2;
      for (let cI = 0; cI < cols; cI++) ctx.fillRect(x + cI * side + gap / 2, py, dot, dot);
    }
  } else {
    const tp = tilePattern(ctx);
    if (tp) { ctx.fillStyle = tp; ctx.fillRect(x, y, rw, rh); }
  }
}
function tileOf() {
  const tile = document.createElement('canvas');
  tile.width = 8; tile.height = 8;
  const tc = tile.getContext('2d');
  tc.strokeStyle = 'rgba(160, 176, 200, 0.11)';
  tc.lineWidth = 1.2;
  tc.beginPath();
  tc.moveTo(-2, 6); tc.lineTo(6, -2);
  tc.moveTo(2, 10); tc.lineTo(10, 2);
  tc.stroke();
  return tile;
}

// The aggregate cell's micro-grid: a 7px grid of faint dark lines over its colour, so a
// rect holding thousands of floor-rate transactions LOOKS like a crowd instead of a
// slab. Same pattern-host fallbacks as the hatch (a stub that cannot createPattern just
// loses the texture).
function tilePattern(ctx) { return cachedPattern(ctx, 'tile', gridTile); }

// The crowd texture at 60 fps. The first version built a bitmap the SIZE OF THE AGGREGATE
// (898x898 backing on this box, 1796x1798 on a retina client — 3.2 megapixels) and
// drawImage'd it every chase frame. That is the bug that made "the block space view
// disappear on update": a source that large, blitted dozens of times per second, crosses
// Chromium's GPU raster budget and the canvas surface gets dropped from the compositor —
// the map vanishes on screen (the readback probe saw its signature: transparent black at
// the aggregate's centre, while the force-rasterising screenshot path still showed it
// painted). A texture is never worth a megapixel source.
//
// The crowd is a pure grid, so it needs no bitmap at all — it needs ONE TILE and a
// repeat pattern. Tile side is derived from the measured density (one aggregated
// transaction = one cell of the grid), capped to 1..24 px; the tile canvas itself is
// fixed at 24x24, 576 pixels, whatever the pool or the display. A host that returns a
// null pattern falls back to drawing the tiles directly (the slow path, tested), never
// to a large bitmap.
const crowdCache = new Map();   // "count|colour" -> {tile, pattern} (tile is always <= 24x24)
const CROWD_TILE = 24;          // the tile canvas; its cells carry the density, see below
function crowdLayer(n, w, h, base) {
  const key = `${n}|${base}`;
  const hit = crowdCache.get(key);
  if (hit) return hit;
  let made = null;
  try {
    // The grid's cell size: one aggregated transaction per cell, at THIS rect's density
    // — but computed from the rect, then baked into a tile whose dimensions are a whole
    // number of cells, so the pattern repeats seamlessly at any rect size.
    const side = Math.sqrt((w * h) / Math.max(1, n));
    if (side >= 1.4) {
      const cell = Math.max(1, Math.min(CROWD_TILE, side));
      const reps = Math.max(1, Math.round(CROWD_TILE / cell));
      const tile = document.createElement('canvas');
      tile.width = cell * reps; tile.height = cell * reps;   // always <= 24*? but capped below
      if (tile.width > CROWD_TILE) tile.width = CROWD_TILE;
      if (tile.height > CROWD_TILE) tile.height = CROWD_TILE;
      const tc = tile.getContext('2d');
        if (tc) {
          tc.fillStyle = 'rgba(233, 240, 250, 0.16)';
          const gap = Math.max(0.5, cell * 0.22);
          const dot = Math.max(1, cell - gap);
          const repsX = Math.floor(tile.width / cell);
          const repsY = Math.floor(tile.height / cell);
          for (let r = 0; r < repsY; r++) {
            for (let q = 0; q < repsX; q++) tc.fillRect(q * cell + gap / 2, r * cell + gap / 2, dot, dot);
          }
          // The pattern itself is made on the MAP's context at paint time (crowdTiles/
          // the fill below), because contexts are host-specific. If this host's
          // createPattern is the measured-null kind, paint falls to crowdTiles.
          made = { tile, pattern: null, cell };
        }
    } else {
      // Sub-pixel crowd: the micro-grid carries it where individual tiles would alias
      // into noise. Made the same small-tile way — a 7x7 tile, patterned on the map's
      // own context — and never a large bitmap. If createPattern is null (the measured
      // headless case), crowdTiles falls through and paints the grid directly.
      const micro = gridTile();
      made = { tile: micro, pattern: null, cell: 0 };
    }
  } catch { made = null; }
  if (made) crowdCache.set(key, made);
  return made;
}

// A pattern made on the crowd layer's own context (never on the map's — the map's
// context is the one measured null in headless).
function cachedLayerPattern(lc, makeTile) {
  try {
    const t = makeTile();
    return t && typeof lc.createPattern === 'function' ? lc.createPattern(t, 'repeat') : null;
  } catch { return null; }
}
function gridTile() {
  const tile = document.createElement('canvas');
  tile.width = 7; tile.height = 7;
  const tc = tile.getContext('2d');
  tc.strokeStyle = 'rgba(4, 8, 14, 0.55)';
  tc.lineWidth = 1;
  tc.strokeRect(0.5, 0.5, 6, 6);
  return tile;
}

function easeOutCubic(t) { return 1 - (1 - t) * (1 - t) * (1 - t); }
const nowMs = () => (Number.isFinite(globalThis.performance?.now?.()) ? globalThis.performance.now() : Date.now());

// Gradients are cosmetic here (a frontier glow, the legend ramp), and every host that
// cannot build one must degrade to "that band/strip is not painted", never to a throw
// that takes the whole frame with it. A recording stub that returns a bare object from
// createLinearGradient once turned a green unit suite into a page that painted nothing —
// rule 14's shape again: a feature the real browser always has cannot be assumed.
//
// The pattern twins (hatchPattern, tilePattern) follow the same doctrine one level
// deeper, and the cache line is load-bearing: `ctx.__hatch = pat` LOOKS harmless, but a
// Proxy-backed recording context forwards the set to its target and then reports
// `ctx.__hatch` as undefined on every later frame — so the cache silently misses,
// createPattern runs per frame, and any test that counts pattern calls sees zero.
// defineProperty with enumerable:false draws no `set` trap, and the get trap's own
// target lookup finds the value. Cache on the raw object, degrade to no texture, never
// throw.
function gradient(ctx, build, stops, fallback) {
  try {
    const g = build();
    if (!g || typeof g.addColorStop !== 'function') return fallback;
    for (const [o, c] of stops) g.addColorStop(o, c);
    return g;
  } catch { return fallback; }
}

// One complete frame of the map, painted straight onto the live canvas. History of
// this function is the history of the disappearance: the offscreen-composite version
// it replaced was measured (headless swiftshader — the same fallback chain a VM or
// blocklisted-GPU browser hits) to ACCEPT the blit into the live surface and never
// land it, while the identical frame drawn directly lands in full. One draw path has
// no host that can lie about which pixels exist.
function paintComposited(ctx, c, w, h, dpr, geom, view) {
  drawFrame(ctx, geom, view);
}

/**
 * One frame of the map. `view` is the live animation state the loop owns; everything
 * time-linked reads `view.now` so a frame is a pure function of (layout, view, clock).
 */
function drawFrame(ctx, geom, view) {
  const { w, h, unused = 0, label = null, labelLine = null } = geom;
  const now = view.now;
  const cut = view.cutNow;

  // --- the cells ------------------------------------------------------------
  // Geometry interpolates with eased wall-clock time; a settled size is ALWAYS the
  // layout's, never a tween artifact — the law the old grow-from-zero tween broke
  // (401 rects on paper, zero painted pixels found in the real browser).
  //
  // Frontier handling WITHOUT ctx.clip(): swiftshader (headless, and real GPUs on a
  // blocklist/VM) silently DROPS fills drawn through a clip — no error, ops recorded,
  // nothing lands — which is the mechanism behind every "map blank but line and legend
  // painted" reading this project has ever taken. The frontier band to the right of the
  // cut is repainted over any cell that overshoots it (below, the unfilled band paints
  // after the cells), so cells need no clip to stay honest: worst case a chase frame
  // overshoots the line for one frame and the band repaint covers it. Zero clip
  // calls = one rasteriser that cannot silently eat the map.

  // Aggregates paint FIRST, so the individual transactions always land on top of them
  // (painting order must never let a tail hide a real transaction).
  const ordered = view.items.some((it) => it.aggregate)
    ? [...view.items.filter((it) => it.aggregate), ...view.items.filter((it) => !it.aggregate)]
    : view.items;
  for (const it of ordered) {
    const span = Math.max(1, it.t1 - it.t0);
    const a = Math.max(0, Math.min(1, (now - it.t0) / span));
    const e = easeOutCubic(a);
    const x = it.sx + (it.tx - it.sx) * e;
    const y = it.sy + (it.ty - it.sy) * e;
    // A cell that just arrived fades in AT its real size (the old rule, kept); a cell
    // that merely moved keeps its size and moves. Departing cells shrink away to make
    // the vacated gap visible.
    const sizeE = it.sw > 0 && it.sh > 0 ? 1 : e;
    // Arrival fade is done through the COLOUR's alpha, never ctx.globalAlpha: the
    // software rasteriser ignores globalAlpha for texture fills (measured headless:
    // globalAlpha 0.06 painted the crowd at full opacity). A cell that just arrived
    // fades in at its real size via a softened fill; everything else is opaque.
    const arrived = it.sw > 0 && it.sh > 0;
    const rw = Math.max(1, it.sw + (it.tw - it.sw) * (it.departing ? e : sizeE));
    const rh = Math.max(1, it.sh + (it.th - it.sh) * (it.departing ? e : sizeE));
    const cellAlpha = arrived ? 1 : Math.max(0.06, e);
    if (it.aggregate) {
      // The tail cell — hundreds or thousands of floor-rate transactions in one rect
      // (measured 2026-09-10: 76% of a real block's area, and 88% of the mempool's).
      // It keeps its EXACT area (the area law is this chart's only obligation) but it
      // must not read as one flat slab. The texture is not decoration — it is the
      // crowd itself: one micro-tile per aggregated transaction, laid out inside the
      // rect at the exact scale (tile side = sqrt(rect area / count)), so the density
      // you see IS the count, and the count label says it in words. The base colour
      // stays the aggregate's own feerate.
      const base = rateColor(it.rate);
      ctx.fillStyle = base;
      ctx.fillRect(x, y, rw, rh);
      const n = Number(it.aggregate) || 0;
      if (n > 0 && rw > 16 && rh > 16) {
        // The crowd, painted as a REPEAT PATTERN of the small tile — never as a blit of
        // a large bitmap (that is what dropped the canvas from the GPU and blanked the
        // view; see crowdLayer). A pattern fill is one small source regardless of rect
        // size. During a tween the pattern cell stays screen-sized while the rect
        // settles, which reads correctly: the crowd is not moving, its border is.
        const crowd = crowdLayer(n, it.tw, it.th, base);
        // Patterns are host-context objects, so the pattern lives on the MAP's context,
        // cached there by tile identity — a WeakMap of ctx -> (tile -> pattern). If the
        // host's createPattern is the measured-null kind, the entry stays null and every
        // paint takes the direct-tiles path; nothing ever blits a big source.
        const pat = crowd ? crowdPatternFor(ctx, crowd.tile) : null;
        if (pat) {
          ctx.fillStyle = pat;
          ctx.fillRect(x, y, rw, rh);
        } else {
          // No pattern host: draw the tiles directly. crowdTiles also covers the
          // sub-pixel case with the 7x7 micro-grid.
          crowdTiles(ctx, it, x, y, rw, rh, n);
        }
      }
      if (rw >= 4 && rh >= 4) {
        ctx.fillStyle = 'rgba(248, 252, 255, 0.22)';
        ctx.fillRect(x, y, rw, 1);
        ctx.fillRect(x, y, 1, rh);
      }
    } else {
      // Arrival fade through the fill colour itself (see cellAlpha): the software
      // rasteriser is unreliable with ctx.globalAlpha, but rgba() is universal.
      const base = rateColor(it.rate);
      ctx.fillStyle = cellAlpha < 1
        ? `rgba(${parseInt(base.slice(1, 3), 16)},${parseInt(base.slice(3, 5), 16)},${parseInt(base.slice(5, 7), 16)},${cellAlpha.toFixed(3)})`
        : base;
      ctx.fillRect(x, y, rw, rh);
      // One light bevel per cell: this is what makes each transaction's SHAPE readable —
      // without it a 400-cell map is a colour field, with it every rectangle has edges.
      if (rw >= 4 && rh >= 4) {
        ctx.fillStyle = 'rgba(248, 252, 255, 0.30)';
        ctx.fillRect(x, y, rw, 1);
        ctx.fillRect(x, y, 1, rh);
      }
    }
    // The churn ring: a cell that changed at the last snapshot (arrived, or its feerate
    // moved) wears a fading white frame. This is the honest "something happened HERE"
    // channel — it fires on real deltas only, never on decoration. The ring draws at
    // any cell size (a 2px cell can still fire, and its frame is the only part of it
    // that can read), so the frame is what the eye catches, not the fill.
    if (it.pulse > 0) {
      const age = (now - it.pulse) / PULSE_MS;
      if (age >= 1) it.pulse = 0;
      else {
        ctx.strokeStyle = `rgba(255, 255, 255, ${(0.95 * (1 - age)).toFixed(3)})`;
        ctx.lineWidth = 1 + 2 * (1 - age);
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, rw - 1), Math.max(1, rh - 1));
      }
    }
    if (it.aggregate && rw > 24 && rh > 12) {
      // The count fits inside most aggregate rects; when the rect is smaller than the
      // count needs, fall back to the compact rate/vbytes pair — the hover carries the
      // full identity either way.
      // Whether the count fits is a measurement, not an assumption: dom-stub's context
      // answers measureText with `() => {}`, so the result can be undefined on a host
      // that has no text engine. No measurement, no claim — fall back to the compact
      // label rather than dereference a width nobody gave us.
      const m = ctx.measureText(`${it.aggregate} more transactions`);
      const wide = Number.isFinite(m?.width) ? m.width : Infinity;
      if (rw > wide + 16) {
        ctx.fillStyle = 'rgba(210, 222, 240, 0.9)';
        ctx.font = 'bold 11px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${it.aggregate.toLocaleString('en-US')} more transactions`, x + 8, y + 12);
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(170, 185, 205, 0.85)';
        ctx.fillText(`mean ${it.rate} sat/vB · ${Math.round(it.vbytes / 1000)}k vB`, x + 8, y + 26);
      } else {
        ctx.fillStyle = '#04060ac9';
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${it.aggregate} tx`, x + 3, y + Math.min(rh / 2, 8));
      }
    } else if (rw > 26 && rh > 12) {
      ctx.fillStyle = '#04060ac9';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${it.rate}`, x + 3, y + Math.min(rh / 2, 8));
      if (rh > 26) ctx.fillText(`${Math.round(it.vbytes / 100) / 10}k`, x + 3, y + 19);
    }
  }

  // --- the unfilled part of the block -----------------------------------------
  if (unused > 0.005 && cut < w - 0.5) {
    // The part of the block the mempool could not fill. Blank, not scaled away: a block
    // that is 16% full should look 16% full. The hatch reads as capacity-with-nothing-in-
    // it; the glow at the frontier reads as "assembly is happening right here".
    const band = Math.max(0, w - cut);
    ctx.fillStyle = '#0d1015';
    ctx.fillRect(cut, 0, band, h);
    const hp = hatchPattern(ctx);
    if (hp) { ctx.fillStyle = hp; ctx.fillRect(cut, 0, band, h); }
    const gl = gradient(ctx, () => ctx.createLinearGradient(cut, 0, cut + Math.min(56, band), 0),
      [[0, 'rgba(0, 200, 255, 0.16)'], [1, 'rgba(0, 200, 255, 0)']], 'rgba(0, 200, 255, 0.07)');
    ctx.fillStyle = gl;
    ctx.fillRect(cut, 0, Math.min(56, band), h);
    ctx.fillStyle = COL.textDim;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label || `${Math.round(unused * 100)}% unfilled`, cut + 8, h / 2);
    ctx.fillText('nothing above the cut was left to put here', cut + 8, h / 2 + 14);
  }

  // --- the cut line --------------------------------------------------------------
  if (cut > 0 && geom.total > 0) {
    // Where the selection ends. Right of this line is space, not money. It MARCHES:
    // a static dash could be mistaken for a static block, and the one thing this panel
    // is for is watching the assembly move. The march is tied to wall-clock time, so it
    // has a real cadence and no animation of its own pretending to be data.
    const dashOff = -(Math.floor(now / 240) * 3) % 24;
    ctx.strokeStyle = '#ffffffe6';
    ctx.setLineDash([3, 3]);
    ctx.lineDashOffset = dashOff;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.55)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(cut, 0);
    ctx.lineTo(cut, h);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.fillStyle = '#ffffffd9';
    ctx.font = '9px ui-monospace, monospace';
    // Label what the line actually is. It sits where the SELECTION ends; the canvas edge
    // is the capacity. Calling this 'block capacity' is a claim the geometry does not
    // support, and on a pool smaller than a block it is simply false.
    ctx.fillText(labelLine || (unused <= 0.005 ? 'everything fits in one block' : 'selection ends'), Math.max(2, Math.min(w - 132, cut - 82)), 7);
  }

  // --- the live legend strip --------------------------------------------------------
  // The exact ramp the cells are painted with, so "brighter" is never a guess.
  if (w >= 220 && h >= 110) {
    const lw = Math.min(132, w - 24);
    const lx = 8;
    const ly = h - 15;
    const rampStops = [];
    // The ramp's own alpha rides on the stop colours, not on ctx.globalAlpha (the
    // software rasteriser is inconsistent with texture alpha; the rgba() is universal).
    for (let g = 0; g <= 16; g++) {
      const hex = rateColor(Math.pow(g / 16, 1.7) * 100);
      rampStops.push([g / 16, `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},0.92)`]);
    }
    const grad = gradient(ctx, () => ctx.createLinearGradient(lx, 0, lx + lw, 0), rampStops, 'rgba(0,186,255,0.92)');
    ctx.fillStyle = grad;
    ctx.fillRect(lx, ly, lw, 7);
    ctx.fillStyle = 'rgba(190, 203, 220, 0.9)';
    ctx.font = '8px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('0', lx, ly - 4);
    ctx.fillText('100+ sat/vB', lx + lw - 50, ly - 4);
  }

  // --- the hover crosshair -----------------------------------------------------------
  if (view.hover) {
    const r = view.hover;
    ctx.strokeStyle = '#ffffffcc';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3);
    ctx.setLineDash([]);
  }
}

/**
 * The visualiser itself. `visual` is {cells, totalVbytes, tailCount} from the node's own
 * template; `economy` supplies where the block actually ran out.
 */
export function blockTreemap(canvas, visual, economy, opts = {}) {
  const cells = visual?.cells ?? [];
  const total = visual?.totalVbytes || cells.reduce((n, c) => n + (c.vbytes || 0), 0);
  const capacity = (opts.weightLimit ?? 4_000_000) / 4;
  const used = Math.min(1, total / capacity);
  return drawMap(canvas, cells, {
    total,
    // Cells occupy the left `used` fraction; the band to its right is the block space
    // nothing was found to fill it with.
    cutFrac: used,
    unused: Math.max(0, 1 - used),
    label: `${Math.round((1 - used) * 100)}% of the block unfilled`,
    placeholder: visual?.unavailable
      ? `no template: ${visual.unavailable}`
      : 'no block template yet — this page asks the node for one on load and every 20 s while it is open',
  });
}

/** Shared layout + chase + hover for both maps. */
function drawMap(canvas, cells, map) {
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  paint(canvas, {
    when: cells.length > 0,
    placeholder: map.placeholder ?? 'nothing to draw yet',
    draw: (c) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth || 600;
      const h = c.clientHeight || 220;
      // RESIZE ONLY ON CHANGE. Assigning canvas.width — even to the value it already
      // has — reallocates the backing store in some Chromium/SwiftShader combinations,
      // and a surface reallocated mid-chase is the "view disappears after the first
      // refresh" the operator reported: the first paint works, the next update
      // reallocates, and the page shows the hole. Size is idempotent when guarded;
      // unguarded, it is a teardown every frame. (charts.js prep() has guarded this the
      // same way all along; the map was the one surface that didn't.)
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (c.width !== bw || c.height !== bh) {
        c.width = bw;
        c.height = bh;
      }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const now = nowMs();
      const total = map.total > 0 ? map.total : cells.reduce((n, x) => n + (x.vbytes || 0), 0);
      const frac = Math.max(0.02, Math.min(1, map.cutFrac ?? 1));
      // Cells are laid out across the WHOLE canvas; the cut then decides how much of
      // them is allowed to show. The frontier easing between snapshot cuts is what makes
      // the block visibly CREEP toward full — with a per-region relayout (the old way) a
      // 65% block filled 100% of its region and the fill never moved.
      const targetRects = layoutTreemap(cells, w, h);
      const targetCut = map.unused != null ? w * Math.max(0.02, 1 - map.unused) : w * frac;
      const geom = { w, h, total, unused: map.unused ?? 0, label: map.label, labelLine: map.labelLine };
      const byKey = new Map(targetRects.map((r, i) => [keyOf(r, i), r]));

      if (reduce) {
        paintComposited(ctx, c, w, h, dpr, geom, {
          now, cutNow: targetCut, hover: null,
          items: targetRects.map((r) => ({
            rate: r.rate, vbytes: r.vbytes, aggregate: r.aggregate,
            sx: r.x, sy: r.y, sw: r.w, sh: r.h,
            tx: r.x, ty: r.y, tw: r.w, th: r.h, t0: now, t1: now, pulse: 0,
          })),
        });
        c.__rects = byKey;
        c.__hasData = true;
        return;
      }

      // The chase. Animated state lives ON THE CANVAS between snapshots; a new snapshot
      // retargets it — each cell keeps where it is and starts easing toward where the
      // block now says it belongs — it never restarts the loop from zero. Three laws,
      // all learned the hard way on this canvas: never clear to a zero-size state, never
      // restart the motion per snapshot (it left the chart mostly blank more often than
      // whole), and the loop always ends on its own budget even if the host clock never
      // advances (a throttled tab, or a test harness whose rAF runs inline).
      const anim = c.__anim instanceof Map ? c.__anim : new Map();
      const prevByKey = c.__prevByKey instanceof Map ? c.__prevByKey : new Map();
      const prevSeen = c.__seen === true;

      const items = [];
      const seen = new Set();
      let i = 0;
      for (const [k, tr] of byKey) {
        i++;
        seen.add(k);
        const was = anim.get(k);
        const prev = prevByKey.get(k);
        // Churn = arrived since the last frame, or its feerate moved. The ring fires on
        // these two real events only. On a page's FIRST snapshot everything is new; the
        // map is alive then too, but ringing 400 borders at once reads as a glitch, so
        // the first paint pulses nothing.
        const churned = prevSeen && (!prev || (prev.rate !== tr.rate));
        items.push({
          key: k, rate: tr.rate, vbytes: tr.vbytes, aggregate: tr.aggregate,
          sx: was ? was.x : tr.x, sy: was ? was.y : tr.y,
          sw: prev ? (was ? was.w : tr.w) : 0, sh: prev ? (was ? was.h : tr.h) : 0,
          tx: tr.x, ty: tr.y, tw: tr.w, th: tr.h,
          t0: now, t1: now + SETTLE_MS,
          pulse: churned ? now : 0,
        });
      }
      // Cells the block dropped leave from where they were and shrink away — the gap a
      // departed transaction vacates is half of what a reshuffle is.
      for (const [k, it] of anim) {
        if (seen.has(k)) continue;
        items.push({
          key: k, rate: it.rate, vbytes: it.vbytes, aggregate: it.aggregate,
          sx: it.x ?? it.tx, sy: it.y ?? it.ty, sw: it.w ?? it.tw, sh: it.h ?? it.th,
          tx: it.tx, ty: it.ty, tw: 0, th: 0,
          t0: now, t1: now + LEAVE_MS, pulse: 0, departing: true,
        });
      }

      const view = {
        now,
        cutNow: prevSeen && Number.isFinite(c.__cutNow) ? c.__cutNow : targetCut,
        targetCut,
        hover: c.__view?.hover ?? null,
        items,
        geom,
      };
      c.__view = view;
      const first = !prevSeen;

      const step = () => {
        if (c.__destroyed) { c.__raf = 0; return; }
        const clock = nowMs();
        view.now = clock;
        // A stalled clock (hidden tab, an inline stub) must not spin the loop forever:
        // a frame budget ends the run no matter what the clock does.
        view.frames = (view.frames ?? 0) + 1;
        const budgetOut = view.frames > 200;
        if (budgetOut) { c.__parked = true; c.__raf = 0; }
        // The frontier eases toward its target so the block visibly FILLS between
        // snapshots (the node's template gains transactions with every refresh).
        view.cutNow += (view.targetCut - view.cutNow) * EASE;
        if (Math.abs(view.targetCut - view.cutNow) < 0.3) view.cutNow = view.targetCut;

        // Keep the animation state honest BEFORE the frame is painted, so the frame on
        // screen always matches the state the next snapshot will chase from — and so the
        // final frame of a run (budget or settle) is the settled layout, never a half-
        // chased one.
        let moving = false;
        for (const it of items) {
          const done = budgetOut || clock >= it.t1;
          if (!done) moving = true;
          const e = done ? 1 : easeOutCubic(Math.max(0, Math.min(1, (clock - it.t0) / Math.max(1, it.t1 - it.t0))));
          it.x = it.sx + (it.tx - it.sx) * e;
          it.y = it.sy + (it.ty - it.sy) * e;
          if (it.departing) { if (!done) anim.set(it.key, it); else anim.delete(it.key); }
          else anim.set(it.key, it);
        }
        c.__anim = anim;
        c.__cutNow = view.cutNow;

        paintComposited(ctx, c, w, h, dpr, geom, view);
        if (budgetOut) return;

        // Termination. When the picture has settled, the ONLY thing left in motion is
        // the marching cut line — a decoration, and no frame is justified at 60 fps for
        // it. The loop parks itself: the settled map stays on screen, the next snapshot
        // unparks it, and a hidden tab that never receives a snapshot never burns frames.
        // A stalled clock never spins either: the frame budget above ends the run no
        // matter what the clock does.
        if (!moving && view.cutNow === view.targetCut) {
          c.__parked = true;
          c.__raf = 0;
          return;
        }
        c.__raf = requestAnimationFrame(step);
      };

      // First frame drawn synchronously — never deferred to a callback another canvas's
      // render could cancel (see the header note on shared handles). Then, once the
      // settled map is on screen, kick off the chase so the snapshot that produced THIS
      // frame is the one that visibly arrives.
      const settledView = {
        now: now + SETTLE_MS + 1,
        cutNow: targetCut,
        hover: view.hover,
        items: items.map((it) => ({ ...it, pulse: 0, sw: it.tw, sh: it.th, sx: it.tx, sy: it.ty, t1: now })),
      };
      paintComposited(ctx, c, w, h, dpr, geom, settledView);
      for (const it of items) if (!it.departing) anim.set(it.key, it);
      c.__anim = anim;
      c.__prevByKey = byKey;
      c.__seen = true;
      c.__cutNow = first ? targetCut : c.__cutNow;

      if (first) {
        // The page's first paint: nothing to chase yet, but the loop still has to exist
        // so the cut line marches. Run it; it parks itself once the clock settles.
        c.__raf = requestAnimationFrame(step);
      } else {
        // Unpark: a snapshot arrived while the loop was parked (or in flight); retarget
        // and resume. A loop that is mid-flight continues with its new `items` naturally.
        if (!c.__raf || c.__parked) { c.__parked = false; view.frames = 0; c.__raf = requestAnimationFrame(step); }
      }

      c.__rects = byKey;
      c.__geom = geom;
      c.__hasData = true;
      bindTreemapHover(canvas);
    },
  });
}

function bindTreemapHover(canvas) {
  if (canvas.__gogglesBound) return;
  canvas.__gogglesBound = true;
  const show = (ev) => {
    const map = canvas.__rects;
    if (!map) return;
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    let hit = null;
    for (const rect of map.values()) {
      if (mx >= rect.x && mx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h) { hit = rect; break; }
    }
    if (canvas.__view) canvas.__view.hover = hit ?? null;
    const el = canvas.parentElement?.querySelector('.goggles-tip');
    if (!hit) { el?.classList.add('hidden'); return; }
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = hit.aggregate
      ? `${hit.aggregate} more transactions · ${Math.round(hit.vbytes / 1000)}k vB · weighted mean ${hit.rate} sat/vB (aggregated so the block stays whole)`
      : `${(hit.txid ?? '').slice(0, 16)}… · ${hit.vbytes} vB · ${hit.rate} sat/vB`;
  };
  canvas.addEventListener('mousemove', show);
  canvas.addEventListener('mouseleave', () => {
    if (canvas.__view) canvas.__view.hover = null;
    canvas.parentElement?.querySelector('.goggles-tip')?.classList.add('hidden');
  });
}
