// details3d.js -- the renderer. Owns the canvas, the loop, the camera and the
// per-canvas state; the geometry and choreography are blockscene3d.js.
//
// THE RULES THIS FILE EXISTS UNDER, all three learned the hard way here:
//
//  1. NO ctx.clip(), NO ctx.globalAlpha, no composite modes. Software
//     rasterisers (headless swiftshader, a VM, a blocklisted GPU) silently
//     DROP fills drawn through a clip and honour globalAlpha inconsistently.
//     That blanked the entire map once. Every fill is a closed path with a
//     solid rgba() colour; depth is paint ORDER alone.
//  2. Per-canvas state, never module-level. goggles.js once kept ONE rAF
//     handle for two maps, so whichever painted second cancelled the first
//     one's loop.
//  3. Zero dependencies, no CDN.

import { packBlock, packExact, vbytesPerUnit, vsizeForSide } from './blockpack.js';
import { planTransition, frameAt, fitToBox, project, fxFront, TRANSITION, SLAB_H, TILE_H, surfaceNormal, cellTops } from './blockscene3d.js';
// THE AGENTS (agents.js): the effects that are something happening rather than a pattern.
// This module keeps three seams and nothing else -- build here in startFx, frame in fxNow,
// draw in paintFrame -- so fifty agents do not become fifty `if`s in the renderer.
import { AGENTS, isAgent, rng } from './agents.js';

const STATE = new WeakMap();

// The tail cell stands for thousands of small transactions the backend does
// not send individually. As ONE tile it is a disaster: measured in the
// browser 2026-09-10, an aggregate of 19,689 transactions carried ~87% of the
// pool's vbytes and packed to a square 52 units on a side in a 56-wide grid,
// swallowing everything else. Split into equal pieces instead -- honest,
// because it really is many transactions and equal pieces claim nothing about
// individual sizes we do not have.
const AGG_PIECES = 96;

// ONE BLOCK'S WORTH, richest first -- which is how mempool.space always has a
// full grid and we did not. Their view is a mempool BLOCK: exactly
// blockVbytes of transactions, so the packing fills resolution x resolution
// by construction and the last row is never ragged. Ours drew the entire
// queue, so the grid was however many rows the pool happened to need and the
// top of it was always partly empty.
//
// Cells arrive richest first (the miner's order), so this is a prefix: take
// transactions until the block is full, and split the cell that straddles the
// boundary rather than dropping it -- that cell is what makes the fill exact.
function takeOneBlock(cells, blockVbytes) {
  const out = [];
  let used = 0;
  for (const c of cells || []) {
    const vb = Math.max(1, Number(c.vbytes ?? c.vsize) || 0);
    const room = blockVbytes - used;
    if (room <= 0) break;
    if (vb <= room) { out.push(c); used += vb; continue; }
    // the straddling cell: keep the part that fits, scaled down
    const count = Number(c.aggregate) || 0;
    out.push({ ...c, vbytes: room, aggregate: count ? Math.max(2, Math.round(count * (room / vb))) : c.aggregate });
    used = blockVbytes;
    break;
  }
  return out;
}

// THE TAIL, CUT TO WHOLE SQUARES (2026-09-11). A square's side is rounded to
// whole grid units, and 96 equal pieces rounded UP carried up to ~25% more
// area than their vbytes: the block overflowed the grid. Shrinking the scale
// to make it fit did nothing until every equal piece dropped a unit at once
// (4 -> 3 is 44% of their area), which left a quarter of the board as bare
// floor across the top -- measured on the live Overview. So the tail is cut
// into however many pieces make each one an EXACT k-unit square, with k no
// larger than the 96-piece side: the rounding then adds nothing and the block
// packs flush at full scale. The count is free -- the pieces stand for
// thousands of transactions we were never sent -- and equal pieces still
// claim nothing about individual sizes.
function aggregatePieces(vsize, count, vpu) {
  const base = Math.max(1, Math.min(AGG_PIECES, count));
  if (!(vpu > 0)) return base;
  // k: the whole side of a 1/base share of the tail, allowed 10% of vbytes'
  // slack before it rounds down a unit
  const k = Math.max(1, Math.floor(Math.sqrt((1.1 * (vsize / base)) / vpu)));
  const exact = vsizeForSide(k, vpu);                // a vsize blockpack's sideFor turns into exactly k
  return Math.max(1, Math.min(count, 600, Math.round(vsize / exact)));
}

// The tail's pieces take the feerate of the stratum they fall in, richest first (the server's
// strata, 2026-09-11: one mean feerate painted 96% of the Simple board one colour). The number and
// size of the pieces are exactly as before, so a layout is unchanged; only the colours are new.
function strataRates(strata, fallback) {
  if (!Array.isArray(strata) || strata.length < 2) return () => fallback;
  const total = strata.reduce((a, s) => a + (Number(s.vbytes) || 0), 0);
  if (!(total > 0)) return () => fallback;
  return (frac) => {
    const want = frac * total;
    let acc = 0;
    for (const s of strata) {
      acc += Number(s.vbytes) || 0;
      if (want < acc) return Math.max(0, Number(s.rate) || 0);
    }
    return Math.max(0, Number(strata.at(-1).rate) || 0);
  };
}

export function toTxs(cells, vpu = 0) {
  const out = [];
  let i = 0;
  for (const c of cells || []) {
    const vsize = Math.max(1, Number(c.vbytes ?? c.vsize) || 0);
    const rate = Math.max(0, Number(c.rate) || 0);
    const count = Number(c.aggregate) || 0;
    if (count > 1) {
      const n = aggregatePieces(vsize, count, vpu);
      const each = Math.max(1, vsize / n);
      // stable ids, or a refresh treats the whole field as departing and
      // arriving and it flashes
      const rateAt = strataRates(c.strata, rate);
      for (let k = 0; k < n; k++) out.push({ txid: `aggregate-${k}`, vsize: each, fee: rateAt((k + 0.5) / n) * each });
      i++;
      continue;
    }
    out.push({ txid: c.txid || `cell-${i}`, vsize, fee: rate * vsize });
    i++;
  }
  return out;
}

function sizeCanvas(canvas, maxDpr = Infinity) {
  // maxDpr: a canvas that may draw at fewer device pixels than the screen has -- Tetrust's sky,
  // where the star count follows the pixel count and a panel-sized galaxy at 2x was a slow game
  const dpr = Math.min(maxDpr, (globalThis.window && window.devicePixelRatio) || 1);
  const w = canvas.clientWidth || canvas.width || 0;
  const h = canvas.clientHeight || canvas.height || 0;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  return { w, h, dpr, pw, ph };
}

// THE BOARD AT REST: every 7-13 s while nothing is moving, one idle effect
// plays (see fxAt in blockscene3d.js), chosen at random and never the same one
// twice in a row. The loop wakes for the effect and parks again, so a still
// board costs nothing between them. Only with a real DOM (the unit harness and
// the DOM stub never get one), never under prefers-reduced-motion, never while
// a transition runs, and it retries later while the board is not on screen.
// THE TWENTY-SIX (operator, 2026-09-12: "Think of many more other video-game inspired effects ...
// at least 25 total different effects, all toggleable"). Nine were here; seventeen more live in
// fxAt (blockscene3d) as pure per-tile functions. Each is one entry here -- how long it runs --
// and one toggle in settings.js (the `effects` group), and the two are checked against each other
// by a test, so an effect cannot ship without a switch or a switch without an effect.
const FX_MS = {
  ripple: 5200, outline: 4400, tide: 5200, cascade: 5600, twinkle: 3800, scan: 4200,
  lightcycle: 6500, ball: 5600, pulse: 7000,
  shockwave: 4200, nova: 5200, firework: 5600, flare: 3600, wave: 6000, quake: 3200,
  rain: 6400, sparkle: 4600, checker: 4400, radar: 6000, vortex: 6400, powerup: 5000, combo: 4800, aurora: 7200, plasma: 6400,
  // THE AGENTS (agents.js): effects that are a thing MOVING rather than a pattern over the board.
  // Longer than the fields, because something that travels needs time to be watched -- a field
  // reads at a glance, an agent has to arrive, do something, and leave.
  // Most of these were removed on the operator's call after seeing them on the board. The seven
  // that stayed are the ones worth the second animation loop: two riders (lightcycle, ball), a
  // splitter, a thief, an interception, a collapse and a gateway. The count is deliberately not
  // written as a number here -- it went stale twice as effects were culled.
  centipede: 7400, tractor: 6800, missile: 7400,
  boulderdash: 6400, portal: 7200,};
export const FX_KINDS = Object.keys(FX_MS);
// The longest a refresh will ever wait for an effect to finish, plus a second of slack. Taken from
// the table rather than written as a number, so culling or adding an effect cannot leave the cap
// shorter than the effect it is meant to outlast. See the deferral in render3d.
const FX_DEFER_MAX = Math.max(...Object.values(FX_MS)) + 1000;
// THE PULSE RIDES THE PRICE LINE (operator, 2026-09-12: "the energy pulse effect needs to run
// across the yellow line, not through space on an invisible grid ... travel the yellow line from
// one end to the other leaving a electric blue tint on the yellow line that starts fading back to
// normal yellow after 3 seconds"), then, watching it: "the blue line just changes color back to
// yellow, it doesn't fade out along a path from left to right. Shorten the blue tail ... it should
// fade out blue and fade back into yellow".
//
// So the tint is a TAIL, not a timer. The first cut held every segment blue for three seconds
// after the head passed -- and the head crosses the line in under three, so the whole line went
// blue together and snapped back together. Now the blue is strongest at the head and fades to
// yellow over the quarter of the line behind it, and the head takes most of the effect to cross
// so the tail can be watched sliding along. The head runs on past the far end until its tail has
// left too, which is why PULSE_TRAVEL is less than 1 -- and 1/PULSE_TRAVEL must exceed
// 1 + PULSE_TAIL or the tail is cut off at the edge.
//
// Then: "Make the tail at least 2 seconds before it fades out and back towards yellow". 0.66 of
// 7000 ms is a 4.6 s crossing; a tail 0.45 of the line long therefore lasts 2.1 s at any point.
const PULSE_TRAVEL = 0.66;
const PULSE_TAIL = 0.45;
// a cheap deterministic 0..1 from an integer, for the pulse's particle motes
const hash01 = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
// A board with a price line is not a grid to sweep across. The straight-front effects (outline,
// scan, tide), the light cycles and the lightning ball all travel the FLOOR, which on the candle
// board is empty space -- which is what "through space on an invisible grid" describes. Where a
// line exists, the effects that run are the ones with something to run along.
const LINE_FX = ['pulse', 'twinkle'];
const DEREZ_MS = 800;   // how long a crashed light cycle takes to shatter and fade

function startFx(st, kind, now) {
  const dirs = kind === 'scan' ? [[0, 1], [0, -1], [1, 0], [-1, 0]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, -0.7071], [0.7071, -0.7071]];
  const d = dirs[(Math.random() * dirs.length) | 0];
  let rank = null;
  if (kind === 'cascade') {
    const byRate = [...(st.restTiles || [])].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
    rank = new Map(byRate.map((t, i) => [t.txid, byRate.length > 1 ? i / (byRate.length - 1) : 0]));
  }
  const seed = Math.floor(Math.random() * 1e6);
  // LIGHT CYCLES and DATA PACKETS (see cyclePath): the routes and the height of every
  // stretch are fixed when the effect starts -- the board is still -- so a frame only moves
  // the heads along them. Two cycles in TRON's blue and orange from opposite edges.
  // AGENTS BUILD THEIR OWN WORLD, once, here (agents.js). The board is STILL while an effect
  // runs, so a route, a formation or a sprite's flight is decided now and a frame only moves
  // along it -- which is what makes these cheap enough to have fifty of.
  let agent = null;
  const spec = AGENTS[kind];
  if (spec?.build) {
    const W = st.gridW, H = st.gridH;
    const tiles = st.restTiles || [];
    agent = spec.build({ st, seed, W, H, tiles, tops: cellTops(tiles, W, H), rnd: rng(seed) });
  }
  st.fx = { kind, t0: now, ms: FX_MS[kind] ?? 4500, x: Math.random() * st.gridW, y: Math.random() * st.gridH, dx: d[0], dy: d[1], rank, seed, agent,
    // `paths`/`crashes` stay on the record because drawCycles reads view.fx.cycles, which the
    // agent's frame() produces from them; nothing outside agents.js builds them any more.
    paths: agent?.paths ?? null, crashes: agent?.crashes ?? null };
  st.lastFx = kind;
}

function fxNow(st, t) {
  const f = st.fx;
  if (!f) return null;
  const u = (t - f.t0) / f.ms;
  if (!(u >= 0 && u < 1)) return null;
  // `ms` rides along: a consumer that needs wall-clock age (the price-line pulse holds its tint
  // for three SECONDS, not for a share of the effect) has to know how long the effect is. It was
  // missing, so the pulse computed NaN colours and the canvas kept the yellow it already had.
  // x and y -- where the effect is centred -- ride along for EVERY kind: the radial arrivals
  // (shockwave, nova, radar, vortex) need an origin, and they were once ripple's alone.
  const out = { kind: f.kind, u, ms: f.ms, gridW: st.gridW, gridH: st.gridH, dx: f.dx, dy: f.dy, rank: f.rank, seed: f.seed,
    x: f.x, y: f.y, amp: Math.min(1, u * 6) * Math.pow(1 - u, 0.8) };
  if (f.kind === 'ripple') {
    const reach = Math.hypot(Math.max(f.x, st.gridW - f.x), Math.max(f.y, st.gridH - f.y));
    Object.assign(out, { x: f.x, y: f.y, r: reach * (1 - Math.pow(1 - u, 2)), w: 2.2 + 2.4 * u });
  }
  // AN AGENT'S FRAME comes from its own spec (agents.js). Everything it publishes lands on the
  // frame object: `heads` (how it lights the cubes -- fxAt's heads branch), plus whatever its
  // draw reads, such as `cycles` for the light walls or `ball` for the plasma ball.
  if (f.agent && isAgent(f.kind)) {
    const spec = AGENTS[f.kind];
    if (spec?.frame) Object.assign(out, spec.frame(f.agent, u, { ms: f.ms, derezMs: DEREZ_MS, seed: f.seed }) ?? {});
  }
  return out;
}

// SOONER (operator, 2026-09-11: "trigger any effects sooner when the board comes to rest,
// rather than later"): the first effect after a transition lands -- or on a board already
// still when first drawn -- comes within opts.idleFirst (about a second), and replaces any
// longer timer left over from before; the ones after it keep opts.idleEvery.
function scheduleFx(canvas, st, opts, soon = false) {
  if (soon && st.fxTimer) { clearTimeout(st.fxTimer); st.fxTimer = null; }
  if (!opts.idleFx || st.fxTimer || !globalThis.document || typeof setTimeout !== 'function' || reducedMotion()) return;
  const [a, b] = soon ? (opts.idleFirst ?? [800, 1600]) : opts.idleEvery;
  st.fxTimer = setTimeout(() => {
    st.fxTimer = null;
    if (canvas.isConnected === false) return;
    const now = (globalThis.performance && performance.now()) || 0;
    const busy = (st.plan && now < st.plan.settleAt) || st.dirty || !!st.pending;
    if (busy || !canvas.clientWidth) { scheduleFx(canvas, st, opts, soon); return; }
    // a board with a price line gets the effects that follow it; every other board gets the grid
    const onALine = (opts.axes?.line?.length ?? 0) > 1;
    // every effect is switchable (settings.js `effects`): opts.fxKinds is the operator's list, and
    // an empty one means the board rests in peace -- idleFx off is not the only way to say so
    const allowed = Array.isArray(opts.fxKinds) ? new Set(opts.fxKinds) : null;
    const kinds = (onALine ? LINE_FX : FX_KINDS.filter((k) => k !== 'pulse')).filter((k) => !allowed || allowed.has(k));
    if (!kinds.length) return;
    let pool = kinds.filter((k) => k !== st.lastFx);
    // THE PULSE COMES ROUND LESS OFTEN (operator, 2026-09-13: "cut down the occurance of the
    // energy pulse on the 3D yellow bar"). The price board has only two effects that follow the
    // line, so a straight random pick ran the surge every other time -- roughly every 14 s, which
    // on a board someone is reading prices off is too much. Three times in four it is dropped from
    // the running when there is anything else to play, so twinkle carries the quiet stretches and
    // the pulse stays an event. Never dropped to nothing: if it is the only effect left switched
    // on, it still plays.
    // ...AND THE GUARD WAS DEAD ON THE ONLY BOARD IT WAS FOR (operator, 2026-09-13: the energy
    // ball must ride the line "MUCH LESS OFTEN"). The price board's whole list is LINE_FX --
    // pulse and twinkle -- so `pool` after dropping lastFx is ALWAYS length 1, and the
    // `pool.length > 1` test could never pass there. Measured: a strict alternation,
    // twinkle pulse twinkle pulse, 50% pulse for ever. The rule only ever fired on the grid
    // boards, which do not play the pulse at all.
    //
    // So the skip no longer depends on there being something else in the pool: when the pulse
    // comes up and the roll says skip, the board plays whatever else is switched on -- repeating
    // twinkle if that is all there is, which is a quiet board rather than a surge every 14 s.
    // It still plays if the operator has turned everything else off.
    // ...AND THEN IT WAS TOO RARE (operator, 2026-09-13: "I'm not seeing the energy pulse riding
    // the yellow tube on the 3D Chart any more"). 82% skip left it 9% of picks, and that is only
    // half the story: the live hour's candle tracks the ticker, so its close moves on EVERY 15 s
    // poll, the layout signature changes, the board re-lays and `st.fx = null` -- a 7 s pulse is
    // interrupted nearly every time it is chosen. Selection and attrition multiplied to something
    // the operator simply never saw finish. 50% puts selection back to a quarter of picks, which
    // against the same attrition is a completed surge around once a minute.
    if (pool.includes('pulse') && pool.length + kinds.length > 2 && Math.random() < 0.5) {
      const without = pool.filter((k) => k !== 'pulse');
      const fallback = without.length ? without : kinds.filter((k) => k !== 'pulse');
      if (fallback.length) pool = fallback;
    }
    // NO FAVOURITES (operator, 2026-09-13: "the tron lightcycles effect happens way too often").
    // There used to be a rule here: the first effect after the board came to rest was a light-cycle
    // race HALF THE TIME. That was written when there were nine effects and it read as a flourish.
    // Measured with fifty-six: 33.2% of every first-after-landing pick was the light cycles,
    // against 1.8% for an even split -- an eighteenfold bias. And the block-space board re-lays on
    // every pool refresh, so `soon` fires constantly, which is why it felt relentless.
    //
    // A hardcoded favourite also contradicts the scheduling the operator actually chose (flat and
    // rare, so any one effect is a genuine surprise), so it is gone rather than merely reduced.
    const kind = (pool.length ? pool : kinds)[(Math.random() * (pool.length ? pool.length : kinds.length)) | 0];
    startFx(st, kind, now);
    st.wake?.();
  }, a + Math.random() * (b - a));
  st.fxTimer?.unref?.();
}

// Play one idle effect now -- for the demo page and the tests, which cannot
// wait on a timer. Returns false for a canvas the renderer has not seen.
export function triggerIdle(canvas, kind = 'ripple') {
  const st = STATE.get(canvas);
  if (!st || !FX_MS[kind]) return false;
  startFx(st, kind, (globalThis.performance && performance.now()) || 0);
  st.wake?.();
  return true;
}

function reducedMotion() {
  try { return !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch { return false; }
}

// The block template, drawn on the ground as a white grid. This is the
// reference the whole picture hangs off: one block is `n` x `n` cells at this
// resolution, so a transaction sitting inside the square is one that fits in
// the next block and anything beyond it is queued behind. It is drawn FIRST,
// at z = 0, so every tile stands on it -- and because the tiles are packed on
// exactly this grid, they line up with it cell for cell.
// A GROUND WORTH CASTING A SHADOW ON (operator, 2026-09-11: "Can we have a more
// interesting ground texture. Something that looks higher res and shows the
// shadows well?"). A lit deck of tiled plates, every piece a solid rgba polygon
// or stroke laid through the projection, so all of it lies on the sphere:
//   * a slate-teal cell grain -- each cell a fixed shade of its own, lit by the
//     sphere's slope toward the light (upper left, above), so the curve reads
//     and the base is light enough for a shadow to darken (the old floor was
//     near black under a black checker, and a shadow had nothing to take away);
//   * dark hairline seams between cells: the "higher res";
//   * 4x4 plates, each a touch different in tone, bevelled -- lit along the
//     edges facing the light, shaded along the others -- with corner rivets;
//   * on some plates a circuit trace running to a pad.
// Its geometry cannot change while the view does not, so it is built once into
// Path2D objects and a frame is a couple of dozen fills; without Path2D (node
// tests) the same polygons are drawn directly. Batched by colour, the ground is
// painted without a far-to-near order -- safe because at the shipped curvature
// (radius several views wide) no part of the surface hides another.
const GROUND = new Map();
const GROUND_LIGHT = (() => { const v = [-0.5, 0.5, 1], l = Math.hypot(...v); return v.map((c) => c / l); })();
function hash2(a, b, salt = 0) {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(salt | 0, 83492791)) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function rgbOf(c) { const m = String(c).match(/rgba?\(([^)]+)\)/); return m ? m[1].split(',').slice(0, 3).map(Number) : [40, 82, 70]; }

// a cell's brightness: the sphere's light on it, its plate's tone, its own grain
export function groundShade(cx, cy, view, opts) {
  const nrm = surfaceNormal(cx + 0.5, cy + 0.5, view);
  const L = GROUND_LIGHT;
  const lit = 1 + 1.6 * (nrm.x * L[0] + nrm.y * L[1] + nrm.z * L[2] - L[2]);
  const plate = opts.gridStep || 4;
  return lit * (1 + 0.09 * (hash2(Math.floor(cx / plate), Math.floor(cy / plate), 1) - 0.5)) * (1 + 0.12 * (hash2(cx, cy, 2) - 0.5));
}

// THE SPHERE REACHES EVERY EDGE (operator, 2026-09-11: "The surface of the sphere is not being
// drawn high enough. You can see black when there should be at least another grid row"). The
// panel's rect is in FLAT grid units, but the ground is drawn on the cap: near the middle it rises
// toward the viewer (up and right on screen), and past the cap it lies `sink` below the flat plane
// (down and left) -- so a fixed three-unit margin left the far edge short of the top of the panel.
// Each edge is pushed outward until every point along it projects outside the panel, then one
// more unit for good measure. Cached per view: it depends on nothing that moves.
const EXTENT = new Map();
export function groundExtent(view, vr) {
  const u = view.unit ?? 12, dS = view.oblique?.dy ?? 1;
  const key = [vr.x0, vr.x1, vr.y0, vr.y1, view.dome, view.gridW, view.gridH, u, view.flipY, view.oblique?.ox, view.oblique?.oy, dS].join('|');
  const hit = EXTENT.get(key);
  if (hit) return hit;
  const P = (gx, gy) => project(gx, gy, 0, view);
  // the panel in the board's drawing units (rows flipped: the far edge is the top, y grows downward)
  const L = vr.x0 * u, R = vr.x1 * u, T = -vr.y1 * u * dS, B = -vr.y0 * u * dS;
  let X0 = Math.floor(vr.x0) - 1, X1 = Math.ceil(vr.x1) + 1, Y0 = Math.floor(vr.y0) - 1, Y1 = Math.ceil(vr.y1) + 1;
  const any = (a, b, f) => { for (let t = a; t < b; t += 0.5) if (f(t)) return true; return f(b); };
  for (let i = 0; i < 120; i++) {
    let grew = false;
    if (any(X0, X1, (x) => P(x, Y1).y > T)) { Y1++; grew = true; }
    if (any(X0, X1, (x) => P(x, Y0).y < B)) { Y0--; grew = true; }
    if (any(Y0, Y1, (y) => P(X1, y).x < R)) { X1++; grew = true; }
    if (any(Y0, Y1, (y) => P(X0, y).x > L)) { X0--; grew = true; }
    if (!grew) break;
  }
  const ext = { X0: X0 - 1, X1: X1 + 1, Y0: Y0 - 1, Y1: Y1 + 1 };
  if (EXTENT.size > 8) EXTENT.delete(EXTENT.keys().next().value);
  EXTENT.set(key, ext);
  return ext;
}

export function groundLayers(view, opts, X0, X1, Y0, Y1) {
  const key = [X0, X1, Y0, Y1, view.dome, view.gridW, view.gridH, view.unit, view.flipY, view.oblique?.ox, view.oblique?.oy, view.oblique?.dy, opts.floor, opts.gridStep].join('|');
  const hit = GROUND.get(key);
  if (hit) return hit;
  const P = (gx, gy) => project(gx, gy, 0, view);
  const W = X1 - X0 + 1;
  const lat = new Array(W * (Y1 - Y0 + 1));
  const L = (gx, gy) => lat[(gy - Y0) * W + (gx - X0)] ??= P(gx, gy);   // integer lattice points, shared
  const layers = [];
  const layer = (kind, style) => { const l = { kind, ...style, polys: [], lines: [] }; layers.push(l); return l; };

  // the cells, grouped by quantised shade
  const base = rgbOf(opts.floor);
  const shades = new Map();
  for (let cy = Y0; cy < Y1; cy++) {
    for (let cx = X0; cx < X1; cx++) {
      const q = Math.round(groundShade(cx, cy, view, opts) * 40);
      let l = shades.get(q);
      if (!l) { l = layer('cell', { fill: `rgba(${base.map((c) => Math.max(0, Math.min(255, Math.round((c * q) / 40)))).join(',')},1)` }); shades.set(q, l); }
      l.polys.push([L(cx, cy), L(cx + 1, cy), L(cx + 1, cy + 1), L(cx, cy + 1)]);
    }
  }
  // hairline seams between cells (the plate edges are the phosphor lines)
  const plate = opts.gridStep || 4;
  const seams = layer('seam', { stroke: 'rgba(0,0,0,0.32)', lw: 0.7 });
  for (let i = X0; i <= X1; i++) if (((i % plate) + plate) % plate) { const pts = []; for (let j = Y0; j <= Y1; j++) pts.push(L(i, j)); seams.lines.push(pts); }
  for (let j = Y0; j <= Y1; j++) if (((j % plate) + plate) % plate) { const pts = []; for (let i = X0; i <= X1; i++) pts.push(L(i, j)); seams.lines.push(pts); }
  // the plates: bevels, rivets, traces
  const lit = layer('bevel-lit', { fill: 'rgba(190,255,225,0.10)' });
  const dark = layer('bevel-dark', { fill: 'rgba(0,0,0,0.24)' });
  const rivet = layer('rivet', { fill: 'rgba(0,0,0,0.40)' });
  const glint = layer('rivet-glint', { fill: 'rgba(210,255,235,0.32)' });
  const trace = layer('trace', { fill: 'rgba(110,255,210,0.14)' });
  const pad = layer('pad', { fill: 'rgba(130,255,215,0.24)' });
  const core = layer('pad-core', { fill: 'rgba(0,0,0,0.36)' });
  const sq = (cx, cy, r) => [P(cx - r, cy - r), P(cx + r, cy - r), P(cx + r, cy + r), P(cx - r, cy + r)];
  const bw = 0.16, e = plate;
  for (let py = Math.ceil(Y0 / plate) * plate; py + plate <= Y1; py += plate) {
    for (let px = Math.ceil(X0 / plate) * plate; px + plate <= X1; px += plate) {
      // rows are flipped: the far edge (py + e) is the top of the screen, toward the light
      lit.polys.push([P(px, py), P(px + bw, py + bw), P(px + bw, py + e - bw), P(px, py + e)]);                    // left
      lit.polys.push([P(px, py + e), P(px + bw, py + e - bw), P(px + e - bw, py + e - bw), P(px + e, py + e)]);    // far
      dark.polys.push([P(px + e, py + e), P(px + e - bw, py + e - bw), P(px + e - bw, py + bw), P(px + e, py)]);    // right
      dark.polys.push([P(px + e, py), P(px + e - bw, py + bw), P(px + bw, py + bw), P(px, py)]);                    // near
      for (const [rx, ry] of [[0.55, 0.55], [e - 0.55, 0.55], [e - 0.55, e - 0.55], [0.55, e - 0.55]]) {
        rivet.polys.push(sq(px + rx, py + ry, 0.13));
        glint.polys.push(sq(px + rx - 0.04, py + ry + 0.04, 0.055));
      }
      if (hash2(px, py, 3) < 0.4) {
        const r = 1 + Math.floor(hash2(px, py, 4) * (e - 1)), c = 1 + Math.floor(hash2(px, py, 5) * (e - 1));
        let r2 = 1 + Math.floor(hash2(px, py, 6) * (e - 1));
        if (r2 === r) r2 = r > 1 ? r - 1 : r + 1;
        const w = 0.05;
        trace.polys.push([P(px, py + r - w), P(px + c + w, py + r - w), P(px + c + w, py + r + w), P(px, py + r + w)]);
        trace.polys.push([P(px + c - w, Math.min(r, r2) + py - w), P(px + c + w, Math.min(r, r2) + py - w), P(px + c + w, Math.max(r, r2) + py + w), P(px + c - w, Math.max(r, r2) + py + w)]);
        pad.polys.push(sq(px + c, py + r2, 0.2));
        core.polys.push(sq(px + c, py + r2, 0.08));
      }
    }
  }
  if (GROUND.size > 8) GROUND.delete(GROUND.keys().next().value);
  GROUND.set(key, layers);
  return layers;
}

// THE NEON GRID ON THE BOARD (operator, 2026-09-11: "i want to see the green
// neon grid explicitly drawn within the block bounds. Right now its just
// drawing the outer border"). The phosphor lines ran over the whole sphere at
// the ground's own faint strength, so on the lighter deck only the bright outer
// edge still read. Inside the board the grid is neon now: a thin green line
// between every pair of cells, a bright line in a wide glow on every plate
// boundary. Outside it the ground keeps its quieter texture, so the board reads
// as a lit template set into the deck. On the floor, so cubes cover it: it
// shows in every gap and round the edges. Built once per view, like the ground.
export function boardGridLayers(view, opts, n, rows) {
  const key = ['board', n, rows, view.dome, view.gridW, view.gridH, view.unit, view.flipY, view.oblique?.ox, view.oblique?.oy, view.oblique?.dy, opts.gridStep, opts.neonCell, opts.neonHalo, opts.neonGlow, opts.neonLine].join('|');
  const hit = GROUND.get(key);
  if (hit) return hit;
  const P = (gx, gy) => project(gx, gy, 0, view);
  const step = opts.gridStep || 4;
  const col = (i) => { const pts = []; for (let j = 0; j <= rows; j++) pts.push(P(i, j)); return pts; };
  const row = (j) => { const pts = []; for (let i = 0; i <= n; i++) pts.push(P(i, j)); return pts; };
  const cell = { kind: 'neon-cell', stroke: opts.neonCell, lw: 0.8, polys: [], lines: [] };
  const line = { kind: 'neon', stroke: opts.neonLine, lw: 1.3, polys: [], lines: [] };
  for (let i = 1; i < n; i++) (i % step ? cell : line).lines.push(col(i));
  for (let j = 1; j < rows; j++) (j % step ? cell : line).lines.push(row(j));
  const halo = { kind: 'neon-halo', stroke: opts.neonHalo, lw: 11, polys: [], lines: line.lines };
  const glow = { kind: 'neon-glow', stroke: opts.neonGlow, lw: 5, polys: [], lines: line.lines };
  const layers = [cell, halo, glow, line];
  if (GROUND.size > 8) GROUND.delete(GROUND.keys().next().value);
  GROUND.set(key, layers);
  return layers;
}

// LIGHT CYCLES AND DATA PACKETS, drawn over the cubes (see startFx / cyclePath). Each trail
// is stroked unit stretch by unit stretch -- a wide glow, a hot core, white near the head --
// brightest at the head and gone a trail-length behind it. A stretch rides at its own height
// and a change of height at a corner is a vertical wall, so every turn is a right angle, over
// the blocks as well as across them. The head is a small glowing data block. Plain rgba
// strokes and fills only: no composite modes, no shadowBlur.
export function drawCycles(ctx, view, lw) {
  const fx = view.fx;
  if (!fx?.cycles) return;
  const P = (x, y, z) => project(x, y, z, view);
  const line = (a, b, color, alpha, width) => {
    ctx.strokeStyle = `rgba(${color.join(',')},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
    ctx.lineWidth = lw * width;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  };
  const fill = (q, color, alpha) => {
    ctx.fillStyle = `rgba(${color.join(',')},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
    ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath(); ctx.fill();
  };
  // DE-RES: the crashed cycle's wall breaks into shards that burst up and out under gravity and
  // fade, with a white flash and an expanding ring where it hit. Deterministic per crash.
  const sqAt = (pt, z, r) => [P(pt.x - r, pt.y - r, z), P(pt.x + r, pt.y - r, z), P(pt.x + r, pt.y + r, z), P(pt.x - r, pt.y + r, z)];
  for (const c of fx.cycles) {
    if (c.derez == null || c.derez >= 1 || !c.crash) continue;
    const t = c.derez, fade = 1 - t;
    let seed = ((c.crash.d * 7919 + c.crash.at.x * 131 + c.crash.at.y * 17) >>> 0) || 1;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const at = c.crash.at;
    const hz = (c.hs[Math.max(0, Math.min(c.hs.length - 1, c.crash.d - 1))] ?? 0) + 1;
    const ring = [];
    for (let k = 0; k <= 28; k++) { const a = (k / 28) * Math.PI * 2; ring.push(P(at.x + Math.cos(a) * (0.5 + 4 * t), at.y + Math.sin(a) * (0.5 + 4 * t), hz)); }
    const loop = (w, rgb, alpha) => {
      ctx.strokeStyle = `rgba(${rgb.join(',')},${Math.max(0, alpha).toFixed(3)})`;
      ctx.lineWidth = lw * w;
      ctx.beginPath(); ring.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    };
    loop(9, c.color, 0.5 * fade);
    loop(2.4, [255, 255, 255], 0.9 * fade);
    if (t < 0.35) fill(sqAt(at, hz + 0.5, 0.3 + 1.6 * (1 - t / 0.35)), [255, 255, 255], 0.9 * (1 - t / 0.35));
    const shardFrom = Math.max(0, c.crash.d - 120);          // the whole wall, bounded so a long route cannot flood the frame
    for (let k = shardFrom; k < c.crash.d && k < c.pts.length - 1; k++) {
      const a = c.pts[k], b = c.pts[k + 1], h = c.hs[k] ?? 0;
      for (let q = 0; q < 3; q++) {
        const f0 = (q + rnd()) / 3;
        const vx = (rnd() - 0.5) * 6, vy = (rnd() - 0.5) * 6, vz = 2 + rnd() * 6, r = 0.18 + rnd() * 0.22;
        const pt = { x: a.x + (b.x - a.x) * f0 + vx * t, y: a.y + (b.y - a.y) * f0 + vy * t };
        const z = h + 1.5 + vz * t - 4 * t * t;
        fill(sqAt(pt, z, r), c.color, 0.95 * fade);
        fill(sqAt(pt, z, r * 0.45), [255, 255, 255], 0.8 * fade);
      }
    }
  }
  ctx.lineWidth = lw;
  for (const c of fx.cycles) {
    const end = c.pts.length - 1;
    if (!(c.alpha > 0.01) || !(c.d > c.from) || end < 1) continue;
    // in world units; the camera draws height at about a third (oblique.oy), so a 0.95-unit
    // wall came out ~5 px tall and read as a scratch -- 3 units stands ~16 px off the blocks
    const wallH = c.small ? 1.4 : 3;
    const at = (dist) => {
      const k = Math.max(0, Math.min(end - 1, Math.floor(dist)));
      const f = Math.min(1, dist - k), a = c.pts[k], b = c.pts[k + 1];
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, k };
    };
    const segs = [];
    for (let k = Math.floor(c.from); k < Math.ceil(c.d) && k < end; k++) {
      const s0 = Math.max(k, c.from), s1 = Math.min(k + 1, c.d);
      if (s1 <= s0) continue;
      const a = at(s0), b = at(s1), h = c.hs[k];
      // a wall that holds: full strength along its length, with the stretch nearest the head
      // brighter still, rather than a 12-unit fade that erased the route behind the rider
      const back = c.d - (s0 + s1) / 2;
      const near = Math.pow(Math.max(0, 1 - back / 6), 1.5);          // the hot end, just behind the head
      const bright = Math.min(1, 0.62 + 0.38 * near) * c.alpha;
      if (k > 0 && s0 === k && c.hs[k - 1] !== h) segs.push({ step: true, a: P(a.x, a.y, c.hs[k - 1]), b: P(a.x, a.y, h), top: P(a.x, a.y, Math.max(h, c.hs[k - 1]) + wallH), br: bright });
      segs.push({ a: P(a.x, a.y, h), b: P(b.x, b.y, h), at: P(a.x, a.y, h + wallH), bt: P(b.x, b.y, h + wallH), br: bright });
    }
    // THE LIGHT WALL: a translucent ribbon standing up off the route, bright along its top
    // and glowing along its foot -- the first cut was a bare line and read as a scratch
    // across the blocks, not a light cycle's wall
    for (const g of segs) if (!g.step) fill([g.a, g.b, g.bt, g.at], c.color, 0.42 * g.br);
    for (const g of segs) line(g.a, g.b, c.color, 0.26 * g.br, c.small ? 8 : 14);
    for (const g of segs) if (g.step) line(g.a, g.top, c.color, 0.9 * g.br, c.small ? 2.2 : 3.6);
    for (const g of segs) if (!g.step) line(g.at, g.bt, c.color, 0.95 * g.br, c.small ? 2.2 : 3.6);
    for (const g of segs) if (!g.step) line(g.a, g.b, c.color, 0.8 * g.br, c.small ? 1.4 : 2.2);
    for (const g of segs) if (!g.step && g.br > 0.5) line(g.at, g.bt, [255, 255, 255], 1.6 * (g.br - 0.5), 1.4);
    // NO CHARGE ON A LIGHT CYCLE (operator, 2026-09-12: "the lightcycles shouldn't have the
    // electricity effect"). It was given the Markets pulse's blue -- puffs, crackle, motes -- along
    // with the lightning ball the same day; on a rider whose whole point is a clean light wall it
    // read as static. The ball keeps it (drawBall): it IS electricity.
    if (c.d < end && c.alpha > 0.3) {
      const hd = at(c.d), hz = (c.hs[hd.k] ?? 0) + wallH * 0.5, r = c.small ? 0.75 : 1.25;
      const sq = (q, z) => [P(hd.x - q, hd.y - q, z), P(hd.x + q, hd.y - q, z), P(hd.x + q, hd.y + q, z), P(hd.x - q, hd.y + q, z)];
      fill(sq(1.1 * r, hz + 0.3), c.color, 0.22 * c.alpha);
      fill(sq(0.42 * r, hz + 0.45), c.color, 0.95 * c.alpha);
      fill(sq(0.2 * r, hz + 0.5), [255, 255, 255], 0.9 * c.alpha);
    }
  }
  ctx.lineWidth = lw;
}

// THE CHARGE TRAIL (operator, 2026-09-12: "We need the block space energy effect also emit a
// blue line and dust trail just like the markets view"). What the Markets pulse leaves on the
// price line, for the board's own riders: the light cycles' wall tops and the lightning ball's
// trace. `segs` are screen-space stretches just behind a head, each with its `tint` (1 at the
// head, 0 at the trail's end) and `age` (0..1 the other way). Drawn as the pulse is drawn --
// an emitter of soft blue puffs behind, a fat electric-blue tube over the stretch, a flickering
// white-blue core with crackle forks re-rolled every frame, and a spray of hashed motes -- so
// the two effects are visibly the same energy.
function chargeTrail(ctx, segs, lw, now, seedBase = 0) {
  if (!segs.length) return;
  for (const g of segs) {
    if (g.tint < 0.04) continue;
    const i = g.i + seedBase;
    const mx = (g.a.x + g.b.x) / 2, my = (g.a.y + g.b.y) / 2;
    // A CLOUD WITH SOMETHING IN IT (operator, 2026-09-13: "the nebula emissions are not
    // substantial enough"). Ten puffs at 0.09 alpha over a 7-21 line-width radius is a haze you
    // have to look for. Now: 22 puffs, half again as wide, at more than double the alpha, and in
    // TWO tones -- a deep blue body with a lighter core drawn over its inner half -- so the cloud
    // has depth rather than being one flat wash. Alpha stays low per puff because the substance
    // comes from LAYERING; a single fat translucent disc reads as a bubble.
    for (let k = 0; k < 22; k++) {
      const a1 = hash01(i * 47 + k * 11 + 3) * Math.PI * 2;
      const spread = lw * (5 + 46 * g.age) * (0.35 + 0.65 * hash01(i * 13 + k * 5 + 29));
      const rad = lw * (9 + 22 * hash01(i * 7 + k * 17 + 61)) * (1 + 1.35 * g.age);
      const al = 0.2 * g.tint * (1 - 0.6 * g.age) * (0.5 + 0.5 * hash01(i * 3 + k * 23 + 97));
      const px = mx + Math.cos(a1) * spread, py = my + Math.sin(a1) * spread;
      ctx.fillStyle = `rgba(48,110,255,${al.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
      if (k % 2 === 0) {
        ctx.fillStyle = `rgba(120,180,255,${(al * 0.7).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(px, py, rad * 0.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  const line = (g, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = lw * w; ctx.beginPath(); ctx.moveTo(g.a.x, g.a.y); ctx.lineTo(g.b.x, g.b.y); ctx.stroke(); };
  for (const g of segs) {
    if (g.tint < 0.04) continue;
    line(g, 14 * (1 + 0.8 * g.tint), `rgba(30,130,255,${(0.16 * g.tint).toFixed(3)})`);
    line(g, 5 * (1 + 0.8 * g.tint), `rgba(110,200,255,${(0.7 * g.tint).toFixed(3)})`);
  }
  for (const g of segs) {
    if (g.tint < 0.08) continue;
    const i = g.i + seedBase;
    const flick = 0.55 + 0.45 * Math.abs(Math.sin(now * 0.023 + i * 1.7) * Math.sin(now * 0.041 + i * 0.9));
    line(g, 2.2, `rgba(210,240,255,${(0.9 * g.tint * flick).toFixed(3)})`);
    // LIGHTNING THAT LOOKS LIKE LIGHTNING (operator, 2026-09-13: "the lightning still looks
    // terrible"). What was here scattered 1-3 forks at a uniformly random ANGLE off the wire and
    // let each leg wander +-0.8 rad, which is a random walk, not a discharge: legs doubled back,
    // crossed the wire, and the whole thing read as scribble at a constant width.
    //
    // A real arc has direction and it tapers. So: every fork leaves the wire roughly PERPENDICULAR
    // (+-0.55 rad off the normal, sign picked per fork), holds that heading with only a small
    // per-leg deviation, and is drawn in three passes -- a wide dim halo, the arc, and a hot thin
    // core -- each shorter and brighter than the last, so it comes to a point instead of ending in
    // a stub. Still re-rolled every frame: electrical precisely because it never draws twice.
    const forks = 1 + ((Math.random() * 4 * g.tint) | 0);
    const nx = -(g.b.y - g.a.y), ny = g.b.x - g.a.x;
    const nlen = Math.hypot(nx, ny) || 1;
    for (let k = 0; k < forks; k++) {
      const f0 = Math.random();
      const ox = g.a.x + (g.b.x - g.a.x) * f0, oy = g.a.y + (g.b.y - g.a.y) * f0;
      const side = Math.random() < 0.5 ? 1 : -1;
      const base = Math.atan2((ny / nlen) * side, (nx / nlen) * side) + (Math.random() - 0.5) * 1.1;
      const reach = lw * (10 + Math.random() * 9) * (0.45 + 0.55 * g.tint);
      // SHORT AND JAGGED. Five legs, each shorter than the last, with a hard alternating zig of
      // +-0.9 rad about the heading -- a discharge kinks, it does not curve. The first cut held a
      // heading over four long smooth legs and drew whiskers halfway across the board.
      const legs = 5;
      const pts = [{ x: ox, y: oy }];
      let x = ox, y = oy, ang = base;
      for (let m = 0; m < legs; m++) {
        ang = base + (m % 2 ? -1 : 1) * (0.35 + Math.random() * 0.55) + (Math.random() - 0.5) * 0.3;
        const step = (reach / legs) * (1 - 0.15 * m);
        x += Math.cos(ang) * step; y += Math.sin(ang) * step;
        pts.push({ x, y });
      }
      const arc = (upto, w, col) => {
        ctx.strokeStyle = col; ctx.lineWidth = lw * w;
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
        for (let m = 1; m <= upto; m++) ctx.lineTo(pts[m].x, pts[m].y);
        ctx.stroke();
      };
      arc(legs, 2.2, `rgba(90,170,255,${(0.3 * g.tint).toFixed(3)})`);
      arc(legs, 0.9, `rgba(185,230,255,${(0.92 * g.tint).toFixed(3)})`);
      arc(Math.max(1, legs - 1), 0.5, `rgba(245,252,255,${(0.95 * g.tint).toFixed(3)})`);
    }
    // SPARKS, NOT BLOBS (operator, 2026-09-13: "the particles are too fat"). They were discs of
    // 1.4-4.2 line-widths, which at this line width read as a spray of dots rather than a spray of
    // sparks. Halved in radius, doubled in number, and each one now flies FURTHER as it ages, so
    // the trail is a fine mist that thins out instead of a clump of fat circles.
    for (let k = 0; k < 16; k++) {
      const f0 = hash01(i * 31 + k * 7);
      const bx = g.a.x + (g.b.x - g.a.x) * f0, by = g.a.y + (g.b.y - g.a.y) * f0;
      const ang = hash01(i * 17 + k * 13 + 101) * Math.PI * 2;
      const dist = lw * (3 + 52 * g.age) * (0.6 + 0.4 * hash01(i + k * 3 + 7));
      const r = lw * (0.55 + 1.15 * hash01(i * 5 + k + 41)) * (1 - 0.45 * g.age);
      ctx.fillStyle = `rgba(200,236,255,${(0.75 * g.tint * (1 - 0.5 * g.age)).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(bx + Math.cos(ang) * dist, by + Math.sin(ang) * dist, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.lineWidth = lw;
}

// THE LIGHTNING BALL, over the cubes: the grid line it has traced burning behind it and cooling
// over 16 units, a plasma ball of stacked glows with a white-hot heart, and bolts jumping from it
// to the grid crossings round it, new every frame. Plain rgba fills and strokes only.
function drawBall(ctx, view, lw) {
  const b = view.fx?.ball;
  if (!b) return;
  const P = (x, y, z) => project(x, y, z, view);
  const U = view.unit ?? 6;
  const stroke = (pts, w, col) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = col; ctx.lineWidth = lw * w;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  };
  const at = (s) => {
    const i = Math.max(0, Math.min(b.pts.length - 2, Math.floor(s))), f = s - i, a = b.pts[i], c = b.pts[i + 1];
    return { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f };
  };
  const TR = 16, from = Math.max(0, b.d - TR);
  const charged = [];
  for (let k = Math.floor(from); k < b.d && k < b.pts.length - 1; k++) {
    const s0 = Math.max(k, from), s1 = Math.min(k + 1, b.d);
    if (s1 <= s0) continue;
    const a = at(s0), c = at(s1), h = b.hs[k] ?? 0;
    const heat = Math.pow(Math.max(0, 1 - (b.d - (s0 + s1) / 2) / TR), 1.6);
    const seg = [P(a.x, a.y, h), P(c.x, c.y, h)];
    stroke(seg, 12, `rgba(90,170,255,${(0.16 * heat).toFixed(3)})`);
    stroke(seg, 4, `rgba(140,210,255,${(0.6 * heat).toFixed(3)})`);
    stroke(seg, 1.6, `rgba(235,248,255,${(0.95 * heat).toFixed(3)})`);
    charged.push({ a: seg[0], b: seg[1], tint: heat, age: 1 - heat, i: k });
  }
  // the dust and the crackle behind the ball, the same charge the light cycles and the Markets
  // pulse carry (chargeTrail)
  chargeTrail(ctx, charged, lw, view.now ?? 0, 977);
  const c = P(b.x, b.y, b.z);
  const disc = (r, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x, c.y, r * U, 0, Math.PI * 2); ctx.fill(); };
  const flick = 0.85 + 0.15 * Math.random();
  disc(4.2, `rgba(70,140,255,${(0.05 * flick).toFixed(3)})`);
  disc(2.8, `rgba(100,170,255,${(0.1 * flick).toFixed(3)})`);
  disc(1.7, `rgba(140,205,255,${(0.28 * flick).toFixed(3)})`);
  disc(1.0, 'rgba(190,230,255,0.78)');
  disc(0.55, 'rgba(255,255,255,1)');
  const z0 = b.z - 0.9;
  const bolts = 4 + ((Math.random() * 4) | 0);
  for (let i = 0; i < bolts; i++) {
    const end = P(Math.round(b.x + (Math.random() - 0.5) * 7), Math.round(b.y + (Math.random() - 0.5) * 7), z0);
    const pts = [c];
    for (let s = 1; s < 5; s++) {
      const f = s / 5;
      pts.push({ x: c.x + (end.x - c.x) * f + (Math.random() - 0.5) * U * 1.1, y: c.y + (end.y - c.y) * f + (Math.random() - 0.5) * U * 1.1 });
    }
    pts.push(end);
    stroke(pts, 5, 'rgba(110,180,255,0.18)');
    stroke(pts, 1.8, 'rgba(170,220,255,0.7)');
    stroke(pts, 0.8, 'rgba(255,255,255,0.95)');
    ctx.fillStyle = 'rgba(200,235,255,0.5)';
    ctx.beginPath(); ctx.arc(end.x, end.y, 0.35 * U, 0, Math.PI * 2); ctx.fill();
  }
  ctx.lineWidth = lw;
}

function drawGround(ctx, layers, lw) {
  const P2 = typeof Path2D === 'function';
  const trace = (t, l) => {
    for (const q of l.polys) { t.moveTo(q[0].x, q[0].y); for (let i = 1; i < q.length; i++) t.lineTo(q[i].x, q[i].y); t.closePath(); }
    for (const q of l.lines) { t.moveTo(q[0].x, q[0].y); for (let i = 1; i < q.length; i++) t.lineTo(q[i].x, q[i].y); }
  };
  for (const l of layers) {
    if (!l.polys.length && !l.lines.length) continue;
    if (l.fill) ctx.fillStyle = l.fill;
    else { ctx.strokeStyle = l.stroke; ctx.lineWidth = lw * (l.lw ?? 1); }
    if (P2) {
      if (!l.path) { l.path = new Path2D(); trace(l.path, l); }
      if (l.fill) ctx.fill(l.path); else ctx.stroke(l.path);
    } else {
      ctx.beginPath();
      trace(ctx, l);
      if (l.fill) ctx.fill(); else ctx.stroke();
    }
  }
  ctx.lineWidth = lw;
}

function drawGrid(ctx, view, opts, n, blockRows, rows = n) {
  const P = (gx, gy) => project(gx, gy, 0, view);
  // on a curved board a grid line is a curve, so it is drawn as a polyline
  // (one segment every 1.5 units, so a long line on the sphere follows it)
  const seg = (x0, y0, x1, y1) => {
    const S = view.dome ? Math.max(8, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 1.5)) : 1;
    ctx.beginPath();
    for (let i = 0; i <= S; i++) {
      const p = P(x0 + ((x1 - x0) * i) / S, y0 + ((y1 - y0) * i) / S);
      if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
  };
  const lw = ctx.lineWidth;
  // SPACE (the Markets board; operator, 2026-09-11: "make the floor transparent black against a
  // twinkling star field. Get rid of the texture entirely for the markets page"). No deck, no
  // plates, no sphere past the board: the board alone, a sheet of translucent black the stars
  // show through (paintFrame draws them first), with its neon grid and its glowing edge.
  if (opts.space && opts.floorLine) {
    // ONE LINE (operator, 2026-09-11: "lets get rid of the green ground grid for the markets view.
    // Just draw the one single line between the candles and the date/time"): no floor, no grid,
    // no frame -- a single neon line along the front edge of the board, under the volume and over
    // the hours.
    return () => {
      ctx.strokeStyle = 'rgba(40,255,140,0.07)'; ctx.lineWidth = lw * 12; seg(0, 0, n, 0);
      ctx.strokeStyle = opts.neonGlow; ctx.lineWidth = lw * 5; seg(0, 0, n, 0);
      ctx.strokeStyle = opts.gridEdgeColor; ctx.lineWidth = lw * 1.6; seg(0, 0, n, 0);
      ctx.lineWidth = lw;
    };
  }
  if (opts.space) {
    const S = 24, ring = [];
    for (let i = 0; i <= S; i++) ring.push(P((n * i) / S, 0));
    for (let i = 1; i <= S; i++) ring.push(P(n, (rows * i) / S));
    for (let i = S - 1; i >= 0; i--) ring.push(P((n * i) / S, rows));
    for (let i = S - 1; i > 0; i--) ring.push(P(0, (rows * i) / S));
    ctx.fillStyle = opts.spaceFloor ?? 'rgba(0,0,0,0.62)';
    ctx.beginPath();
    ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    return () => {
      drawGround(ctx, boardGridLayers(view, opts, n, rows), lw);
      ctx.strokeStyle = opts.neonGlow;
      ctx.lineWidth = lw * 6;
      seg(0, 0, n, 0); seg(n, 0, n, rows); seg(n, rows, 0, rows); seg(0, rows, 0, 0);
      ctx.lineWidth = lw;
      ctx.strokeStyle = opts.gridEdgeColor;
      seg(0, 0, n, 0); seg(n, 0, n, rows); seg(n, rows, 0, rows); seg(0, rows, 0, 0);
    };
  }
  // The floor: a SURFACE, not a void (operator, 2026-09-11: "make the grid
  // surface have some texture/non-black area so we can properly see shadows
  // on the grid"). A dim green was still too near black for a shadow to have
  // anything to darken. Now a lighter base, a faint checker between cells,
  // and 4x4 plates in two tones -- floor panels under the phosphor lines. All
  // solid rgba quads (no pattern fills), each drawn through the projection, so
  // on a curved board the texture curves with it.
  const quad = (x0, y0, x1, y1, fill) => {
    const q = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
    ctx.closePath();
    ctx.fill();
  };
  // THE SPHERE CARRIES ON PAST THE BOARD (operator, 2026-09-11: "grid surface
  // fills the panel", "sphere continues rendering off the screen, textured
  // ... viewport only obviously"). Under the oblique camera the same texture
  // covers everything the panel can see (view.viewRect, pushed out by
  // groundExtent until the curve covers it); otherwise it is the board alone.
  const vr = view.oblique && view.viewRect;
  const { X0, X1, Y0, Y1 } = vr ? groundExtent(view, vr) : { X0: 0, X1: n, Y0: 0, Y1: rows };
  drawGround(ctx, groundLayers(view, opts, X0, X1, Y0, Y1), lw);
  // Phosphor glow: the same lines once wide and faint, then thin and bright.
  // Two strokes of plain rgba -- no shadowBlur, which a software rasteriser
  // may skip, and no composite mode.
  const lines = () => {
    for (let i = Math.ceil(X0 / opts.gridStep) * opts.gridStep; i <= X1; i += opts.gridStep) seg(i, Y0, i, Y1);
    for (let i = Math.ceil(Y0 / opts.gridStep) * opts.gridStep; i <= Y1; i += opts.gridStep) seg(X0, i, X1, i);
  };
  ctx.strokeStyle = opts.gridGlow;
  ctx.lineWidth = lw * 5;
  lines();
  ctx.lineWidth = lw;
  ctx.strokeStyle = opts.gridColor;
  lines();
  // THE GLOWING LAYER is returned, not drawn: paintFrame lays it after the
  // shadows and before the cubes, so the neon grid, the board edge, the block
  // line and the idle-effect marks are light on the floor that no shadow dims
  // (operator, 2026-09-11: "the grid should be glowing and not affected by
  // shadows"). Everything above this line is the ground the shadows fall on.
  return () => {
  drawGround(ctx, boardGridLayers(view, opts, n, rows), lw);
  // the edge glows too
  ctx.strokeStyle = opts.neonGlow;
  ctx.lineWidth = lw * 6;
  seg(0, 0, n, 0); seg(n, 0, n, rows); seg(n, rows, 0, rows); seg(0, rows, 0, 0);
  ctx.lineWidth = lw;
  // the template's own edge, brighter: this is where one block ends
  // ...traced ON the sphere, edge by edge. It was a straight rectangle between
  // the four corners -- the only points of the edge that lie on the plane -- so
  // it floated flat over the bulging surface (operator, 2026-09-11: "the grid
  // is not snapped to the sphere surface. Everything should snap to the
  // sphere surface on the grid").
  ctx.strokeStyle = opts.gridEdgeColor;
  seg(0, 0, n, 0); seg(n, 0, n, rows); seg(n, rows, 0, rows); seg(0, rows, 0, 0);
  // the idle effect's mark on the floor, under the blocks it lights
  const fx = view.fx;
  const polyline = (pts, w, color) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw * w;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  };
  if (fx && fx.kind === 'ripple') {
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(P(Math.max(0, Math.min(n, fx.x + Math.cos(a) * fx.r)), Math.max(0, Math.min(rows, fx.y + Math.sin(a) * fx.r))));
    }
    polyline(pts, 16, `rgba(80,255,190,${(0.12 * fx.amp).toFixed(3)})`);
    polyline(pts, 3, `rgba(180,255,230,${(0.45 * fx.amp).toFixed(3)})`);
  }
  if (fx && (fx.kind === 'outline' || fx.kind === 'scan' || fx.kind === 'tide')) {
    // the front itself, drawn across the floor where it is
    const p = fxFront(fx);
    const L = Math.hypot(n, rows);
    const c0x = n / 2 + (p - (n / 2) * fx.dx - (rows / 2) * fx.dy) * fx.dx;
    const c0y = rows / 2 + (p - (n / 2) * fx.dx - (rows / 2) * fx.dy) * fx.dy;
    const pts = [];
    for (let i = -40; i <= 40; i++) {
      const gx = c0x - fx.dy * (L * i) / 40, gy = c0y + fx.dx * (L * i) / 40;
      if (gx >= 0 && gx <= n && gy >= 0 && gy <= rows) pts.push(P(gx, gy));
    }
    const col = fx.kind === 'tide' ? '140,255,180' : (fx.kind === 'scan' ? '120,220,255' : '90,230,255');
    polyline(pts, 18, `rgba(${col},${(0.10 * fx.amp).toFixed(3)})`);
    polyline(pts, 3, `rgba(${col},${(0.55 * fx.amp).toFixed(3)})`);
  }
  if (fx && fx.ball) {
    const b = fx.ball;
    for (const [r, col] of [[5, 'rgba(80,160,255,0.10)'], [3, 'rgba(120,195,255,0.16)'], [1.5, 'rgba(190,230,255,0.24)']]) {
      ctx.fillStyle = col;
      ctx.beginPath();
      for (let i = 0; i <= 32; i++) { const a = (i / 32) * Math.PI * 2; const p = P(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.lineWidth = lw;
  // one block's worth: everything below this line fits in the next block
  if (blockRows > 0 && blockRows < n) {
    ctx.strokeStyle = opts.blockLineColor;
    seg(0, blockRows, n, blockRows);
  }
  ctx.lineWidth = lw;
  };
}

// THE GRID IS CENTRED ON A SPHERE THAT FILLS THE PANEL (operator, 2026-09-11:
// "I want our grid centered within the view-space", "grid surface fills the
// panel", "sphere continues rendering off the screen, textured ... viewport
// only obviously"). This supersedes "Bottom left should be absolutely flush
// with bottom left of the panel" for the oblique camera: the board is centred
// with the same margin on opposite sides -- headroom + dome, room for the
// tallest cube and for flight -- and drawGrid carries the textured sphere on
// past the board to every edge. Still a function of nothing but the fixed
// grid and the panel, so the view cannot slide between frames or refreshes.
// `rect` is the panel's extent in grid units (x0..x1 across, y0..y1 up).
export function obliqueFit(pw, ph, gridW, gridH, opts) {
  const ob = opts.oblique;
  const head = ob.headroom + (opts.dome || 0);
  const u = opts.unit;
  // anchor 'bottom' (the market chart, facing the board): the board along the bottom with the
  // headroom above it only, and room on the right for the price labels the axes draw there
  const low = ob.anchor === 'bottom';
  const dS = ob.dy ?? 1;             // the board's depth as drawn (a lower camera draws it shorter)
  const extra = low ? 9 : 0;
  // the strip under the front edge where the axes write the hours: a share of the panel, not a
  // number of grid units -- in a short panel 2.4 units was ~14 px and the labels were cut off
  // (operator, 2026-09-11: "The bottom of the chart is getting cut off by the text")
  const foot = low ? 0.055 * ph : 0;
  const k = low
    ? Math.min(pw / ((gridW + extra + 2 * head * ob.ox) * u), (ph - foot) / ((gridH * dS + head * ob.oy + 1.2) * u))
    : Math.min(pw / ((gridW + 2 * head * ob.ox) * u), ph / ((gridH * dS + 2 * head * ob.oy) * u));
  const tx = pw / 2 - (k * (gridW + extra) * u) / 2;
  const ty = low ? ph - foot : ph / 2 + (k * gridH * dS * u) / 2;
  return { k, tx, ty, rect: { x0: -tx / (k * u), x1: (pw - tx) / (k * u), y0: (ty - ph) / (k * u * dS), y1: ty / (k * u * dS) } };
}

// AXES ON THE BOARD (the market chart; operator: "we can alter the perspective"). The price
// levels are lines across the board at the candles' own depth, drawn after the glowing grid and
// before the cubes so the candles stand in front of them; the labels go on last, at the right
// end, and the hours along the front edge -- every point through the same projection as the
// cubes, so a level and a candle at the same price meet. axes = { y, zTop, z: [{ z, label,
// color?, strong? }], x: [{ x, label }] }.
function drawAxes(ctx, view, axes, n) {
  const y = axes.y ?? 0;
  const lw = ctx.lineWidth;
  const line = (a, b, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = lw * w; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  for (const t of axes.x ?? []) line(project(t.x, y, 0, view), project(t.x, y, axes.zTop ?? 0, view), 1, 'rgba(120,255,190,0.12)');
  for (const t of axes.z ?? []) {
    const a = project(0, y, t.z, view), b = project(n, y, t.z, view);
    line(a, b, 6, t.strong ? 'rgba(255,255,255,0.06)' : 'rgba(40,255,140,0.05)');
    line(a, b, t.strong ? 1.6 : 1, t.strong ? (t.color ?? 'rgba(255,255,255,0.9)') : 'rgba(120,255,190,0.3)');
  }
  ctx.lineWidth = lw;
}

// THE PRICE LINE (operator, 2026-09-11: "we need a bright neon yellow line running in 3D showing
// the price chart in the Markets display"). The close, hour by hour, at the candles' own depth and
// through the same projection, drawn after them in the grid's light style -- a wide faint halo,
// a glow, then a bright core -- so it cuts through the scene the way the neon grid does.
// ONE CONTINUOUS PIPE, not a run of segments (operator, 2026-09-13: "the yellow price line is
// made of line segments. Make it one continuous curved pipe").
//
// WHAT WAS WRONG. Every layer was stroked as a polyline through the projected closes and, worse,
// during the pulse each SEGMENT was stroked separately so it could carry its own colour. Six
// layers x forty segments is 240 strokes whose translucent ends overlap at every join: the line
// beaded at each candle and the corners came to points. It read as forty things, because it was.
//
// WHAT IT IS NOW. The closes are a monotonic, evenly-spaced series in x (markets.js builds
// `axes.line` at each candle's centre), so they interpolate cleanly: a centripetal-ish
// Catmull-Rom through the points, converted to cubic Beziers, gives one smooth curve that passes
// exactly through every close -- the data is not smoothed away, only the path between the readings
// is. Each layer is then ONE stroke of that curve with round joins and caps, so a layer overlaps
// itself nowhere and the whole thing reads as a tube.
//
// THE TAIL, which is why this needed a gradient. A single stroke cannot change colour along its
// length without one, and the pulse's whole point is blue at the head easing back to yellow. The
// canvas rules here forbid clip, globalAlpha, composite modes and shadowBlur -- gradients are not
// on that list, and charts.js has used them all along. Because x is monotonic, a linear gradient
// across the line's x-extent IS distance along the line, so the tint becomes continuous instead of
// forty discrete steps.
//
// AND IT DEGRADES. A context that cannot build a gradient (every recording stub in test/, and any
// software rasteriser that refuses) gets a flat colour instead of a throw -- goggles.js learned
// that the hard way: "createLinearGradient once turned a green unit suite into a page that painted
// nothing". Same doctrine here.
function gradientOr(ctx, build, stops, fallback) {
  try {
    const g = build();
    if (!g || typeof g.addColorStop !== 'function') return fallback;
    for (const [o, c] of stops) g.addColorStop(o, c);
    return g;
  } catch { return fallback; }
}

/**
 * The closes as one smooth curve, traced into `t` (a Path2D or the context itself).
 *
 * Catmull-Rom with a tension of 1/6 converted to cubic Beziers. The curve passes THROUGH every
 * point -- an approximating spline would quietly redraw the prices -- and the ends duplicate the
 * terminal points so the first and last stretches curve like the rest.
 */
function traceCurve(t, pts) {
  t.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) { t.lineTo(pts[1].x, pts[1].y); return; }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    t.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y,
    );
  }
}

// The price curve, kept between frames: one entry, because there is one price line on screen.
const CURVE = { key: null, path: null };

/**
 * Where the pulse's head is, INCLUDING its flight past the end of the line.
 *
 * `at` is 0..1 along the line and then beyond. Up to 1 it interpolates the points as before. Past
 * 1 it continues along the direction of the FINAL SEGMENT -- the last vector -- for `overrun` of
 * the line's length, fading linearly to nothing. Returns null once it is gone, so the caller draws
 * nothing rather than drawing something transparent.
 */
function headPoint(pts, at, overrun) {
  const n = pts.length - 1;
  if (at < 0) return null;
  if (at <= 1) {
    const d = at * n;
    const k = Math.min(n - 1, Math.floor(d)), fr = d - k;
    return { x: pts[k].x + (pts[k + 1].x - pts[k].x) * fr, y: pts[k].y + (pts[k + 1].y - pts[k].y) * fr, fade: 1 };
  }
  const past = at - 1;
  if (past >= overrun) return null;                     // faded out before the edge
  const a = pts[n - 1], b = pts[n];
  const vx = b.x - a.x, vy = b.y - a.y;
  const len = Math.hypot(vx, vy) || 1;
  // the whole line's length, so the overrun is a share of the line and not of one candle
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  const travel = past * total;
  return { x: b.x + (vx / len) * travel, y: b.y + (vy / len) * travel, fade: 1 - past / overrun };
}

function priceLine(ctx, view, axes) {
  const pts = (axes.line ?? []).map((q) => project(q.x, axes.y ?? 0, q.z, view));
  if (pts.length < 2) return;
  const lw = ctx.lineWidth;
  const join = ctx.lineJoin, cap = ctx.lineCap;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Built once and CACHED, not rebuilt every frame. All six layers stroke the same shape, and the
  // shape only changes when the projected closes do -- which is when the series or the camera
  // changes, not when a frame ticks. drawGround caches its Path2D the same way (l.path); doing it
  // per frame here would allocate and re-trace thirty Beziers sixty times a second underneath an
  // effect that is already the expensive thing on screen.
  const P2 = typeof Path2D === 'function';
  let path = null;
  if (P2) {
    const key = `${pts.length}|${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}|${pts[pts.length - 1].x.toFixed(2)},${pts[pts.length - 1].y.toFixed(2)}|${pts[(pts.length / 2) | 0].y.toFixed(2)}`;
    if (CURVE.key === key && CURVE.path) path = CURVE.path;
    else {
      try { path = new Path2D(); traceCurve(path, pts); CURVE.key = key; CURVE.path = path; }
      catch { path = null; CURVE.key = null; CURVE.path = null; }
    }
  }
  const stroke = (w, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = lw * w;
    if (path) { ctx.stroke(path); return; }
    ctx.beginPath(); traceCurve(ctx, pts); ctx.stroke();
  };
  // A BRIGHT NEON GLOW (operator, 2026-09-11, of the crackling light saber that was here: "that
  // effect is terrible. Remove it. I was hoping for a bright neon glow"). Steady -- no pulses, no
  // crackle, no flicker: a wide soft bloom, a hot yellow tube and a white core.
  // the bloom, the tube and the core -- ALL of which the pulse tints. The first cut turned only
  // the thin core blue and left the fat yellow bloom round it untouched, so the surge read as a
  // faint whitening of the line (operator: "much too small on the yellow line, it's not obvious
  // it's a large energy pulse travelling the line"). The bloom goes a deep saturated blue, the
  // core an electric one, and every pass SWELLS behind the head.
  const GLOW = [[30, [255, 225, 40], 0.05, 'glow'], [18, [255, 228, 45], 0.10, 'glow'], [10, [255, 232, 55], 0.22, 'glow']];
  const CORE = [[5.5, [255, 236, 70], 0.78, 'core'], [3, [255, 246, 150], 1, 'core'], [1.3, [255, 255, 240], 1, 'core']];
  const fx = view.fx && view.fx.kind === 'pulse' ? view.fx : null;
  const done = () => { ctx.lineWidth = lw; ctx.lineJoin = join; ctx.lineCap = cap; };
  if (!fx) {
    for (const [w, c, a] of [...GLOW, ...CORE]) stroke(w, `rgba(${c[0]},${c[1]},${c[2]},${a})`);
    done();
    return;
  }
  const n = pts.length - 1;
  const headAt = fx.u / PULSE_TRAVEL;                        // 0..1 along the line, then past it
  // BRIGHT NEON BLUE (operator, 2026-09-13: "make the energy pulse bright neon blue as it travels
  // along the line"). Neon is saturation and luminance TOGETHER, so both move: the core goes
  // brighter and further toward cyan, and the bloom drops its red channel to nothing so the
  // surround reads as pure blue instead of the washed periwinkle it was. The tail's shape is
  // untouched -- every pass still blends wire-yellow through these to HOT at the overshoot; only
  // how blue "blue" is has changed.
  const BLUE = [120, 225, 255];                              // the core: electric neon
  const DEEP = [0, 120, 255];                                // the bloom: pure saturated blue
  const HOT = [255, 255, 215];                               // the flash: whiter than the wire
  // THE NEBULA BEHIND THE SURGE (operator, 2026-09-12: "like a blue nebula behind the energy pulse
  // that starts expanding and fading out to black"). Drawn FIRST, so it sits behind the wire: soft
  // nested discs on every charged segment, their radius growing with that stretch's age and their
  // alpha falling with it -- tight and bright just behind the head, spread wide and gone to black
  // by the tail's end. Plain fills, layered, as every glow in this renderer is.
  // A TRUE EMITTER (operator, 2026-09-12: "make the nebula an emitter; still seeing concentric
  // circles when the nebula's/trails are drawn behind the energy ball"). Emitting PER SEGMENT was
  // the cause: neighbouring segments are almost the same age, so their puffs shared a distance and
  // a radius and lined up into arcs -- rings made of many little circles are still rings. The
  // cloud is emitted over the charged SPAN instead. Each puff picks its own place along the trail,
  // its own angle, its own distance and its own size from four INDEPENDENT hashes, so no two share
  // a centre or a radius and there is no common edge for the eye to join up. Hashed, not random,
  // so a puff keeps its place from frame to frame instead of boiling.
  // (operator, 2026-09-13: "the nebula emissions are not substantial enough") -- more puffs, wider,
  // and at more than double the alpha, with a lighter core on every other one so the cloud reads as
  // having depth. Layering is what makes it substantial; a single fat translucent disc is a bubble.
  const PUFFS = 210;
  for (let k = 0; k < PUFFS; k++) {
    const u = hash01(k * 7 + 13);                         // how far back down the tail it sits
    const at = headAt - u * PULSE_TAIL;
    if (at < 0) continue;
    // PAST THE END IT FADES, IT DOES NOT VANISH (operator: "The nebula effects should also fade out
    // instead of just disappearing"). This was `at > 1 -> continue`, so the cloud was culled the
    // instant its stretch ran off the last candle and the whole trail blinked out together.
    const off = at > 1 ? (at - 1) / 0.34 : 0;
    if (off >= 1) continue;
    const edge = 1 - off;
    const tint = Math.pow(1 - u, 1.4) * edge;
    const age = u;
    // positioned along the same flight the head takes, so the cloud follows it off the end
    // instead of piling up on the last candle
    const hp = headPoint(pts, at, 0.34);
    if (!hp) continue;
    const mx = hp.x, my = hp.y;
    const a1 = hash01(k * 31 + 101) * Math.PI * 2;
    const spread = lw * (4 + 78 * age) * (0.2 + 0.8 * hash01(k * 17 + 5));
    const rad = lw * (9 + 34 * hash01(k * 13 + 67)) * (1 + 1.3 * age);
    const al = 0.17 * tint * (1 - 0.5 * age) * (0.45 + 0.55 * hash01(k * 5 + 29));
    const px = mx + Math.cos(a1) * spread, py = my + Math.sin(a1) * spread;
    ctx.fillStyle = `rgba(48,110,255,${al.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fill();
    if (k % 2 === 0) {
      ctx.fillStyle = `rgba(120,180,255,${(al * 0.7).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(px, py, rad * 0.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  // THE TUBE, AS ONE STROKE PER LAYER WITH A GRADIENT ALONG IT.
  //
  // This is what the operator's "one continuous curved pipe" costs and buys. Each layer used to be
  // stroked segment by segment so a segment could carry its own colour -- that is how the blue tail
  // was built, and it is also why the line beaded at every candle. Because the closes are evenly
  // spaced and monotonic in x, a linear gradient across the line's x-extent IS distance along the
  // line, so the same tail can be expressed as colour stops on ONE stroke of the curve.
  //
  // The stops are placed at the head, a short way behind it, and at the tail's end, with the same
  // easing the per-segment version used (pow(1 - passed/TAIL, 1.4)) sampled at those places -- plus
  // the overshoot to a hotter, whiter yellow just past the tail, which was a sine bump per segment
  // and is a stop here. Fewer than forty steps, and continuous between them instead of stepped.
  const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
  // where the head and the tail's end fall as a fraction of the x-extent, clamped into 0..1 so a
  // head that has run off the far end still anchors its stops legally
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const headStop = clamp01(headAt);
  const tailStop = clamp01(headAt - PULSE_TAIL);
  for (const [w, c, a, kind] of [...GLOW, ...CORE]) {
    const B = kind === 'glow' ? DEEP : BLUE;
    // the charged stretch is FAT: a pulse is a thing travelling the line, not a colour on it.
    // One width for the whole stroke now, so it swells while the head is on the line.
    const onLine = headAt >= 0 && headAt <= 1 + PULSE_TAIL;
    ctx.lineWidth = lw * w * (1 + (onLine ? 0.9 : 0));
    const at = (passed) => {
      const tint = passed >= 0 && passed < PULSE_TAIL ? Math.pow(1 - passed / PULSE_TAIL, 1.4) : 0;
      const past = passed - PULSE_TAIL * 0.55;
      const hot = past > 0 && past < PULSE_TAIL ? Math.sin((past / PULSE_TAIL) * Math.PI) * (1 - tint) : 0;
      const mix = (j) => c[j] + (B[j] - c[j]) * tint + (HOT[j] - c[j]) * hot * 0.85;
      return `rgba(${Math.round(Math.min(255, mix(0)))},${Math.round(Math.min(255, mix(1)))},${Math.round(Math.min(255, mix(2)))},${a})`;
    };
    const yellow = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    const col = gradientOr(
      ctx,
      () => ctx.createLinearGradient(x0, pts[0].y, x1, pts[pts.length - 1].y),
      [
        [0, yellow],                                       // far behind the tail: plain wire again
        [Math.max(0, tailStop - 0.001), at(PULSE_TAIL)],
        [tailStop, at(PULSE_TAIL * 0.999)],
        [clamp01(tailStop + (headStop - tailStop) * 0.45), at(PULSE_TAIL * 0.55)],
        [clamp01(tailStop + (headStop - tailStop) * 0.8), at(PULSE_TAIL * 0.2)],
        [headStop, at(0)],
        [Math.min(1, headStop + 0.001), yellow],           // ahead of the head: untouched wire
        [1, yellow],
      ].filter(([o], i, arr) => i === 0 || o >= arr[i - 1][0]),   // stops must not go backwards
      // no gradient available: the flat wire, which is what every recording stub records
      yellow,
    );
    ctx.strokeStyle = col;
    if (path) ctx.stroke(path);
    else { ctx.beginPath(); traceCurve(ctx, pts); ctx.stroke(); }
  }
  // SHIMMER on the charged stretch: a thin white-blue core whose brightness flickers per segment
  // on the frame clock, scaled by that segment's tint so it dies out exactly as the blue does.
  //
  // These were removed on 2026-09-12 ("the particle effects ... looks terrible ... get rid of the
  // lightning bolts effect") and asked for again the same day ("we need to add the energy and
  // crackle and particle effects back to the electrical pulse that travels the market screen"), so
  // they are back as they were. The nebula behind them keeps its span emitter -- that part of the
  // rework stands, because it is what stopped the trail reading as concentric rings.
  const now = view.now ?? 0;
  for (let i = 0; i < n; i++) {
    const at = n > 1 ? i / (n - 1) : 0;
    const passed = headAt - at;
    const tint = passed >= 0 && passed < PULSE_TAIL ? Math.pow(1 - passed / PULSE_TAIL, 1.4) : 0;
    if (tint < 0.08) continue;
    const p = pts[i], q = pts[i + 1];
    const flick = 0.55 + 0.45 * Math.abs(Math.sin(now * 0.023 + i * 1.7) * Math.sin(now * 0.041 + i * 0.9));
    ctx.strokeStyle = `rgba(210,240,255,${(0.9 * tint * flick).toFixed(3)})`;
    ctx.lineWidth = lw * 2.4;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();

    // CRACKLE: short jagged branches off the wire, re-rolled EVERY frame -- electrical precisely
    // because it never draws the same twice. Reach is in line-widths; the line is under a pixel
    // wide, so 5-14 was invisible when this was first tried.
    // LIGHTNING WITH A DIRECTION (operator, 2026-09-13: "the lightning still looks terrible").
    // Forks now leave the wire near-perpendicular and hold their heading, tapering over four legs,
    // drawn halo/arc/core so they come to a point. The old version picked a uniformly random angle
    // and let each leg wander +-0.8 rad, which doubled back across the wire and read as scribble.
    const forks = 1 + ((Math.random() * 4 * tint) | 0);
    const nx = -(q.y - p.y), ny = q.x - p.x;
    const nlen = Math.hypot(nx, ny) || 1;
    for (let k = 0; k < forks; k++) {
      const f0 = Math.random();
      const ox = p.x + (q.x - p.x) * f0, oy = p.y + (q.y - p.y) * f0;
      const side = Math.random() < 0.5 ? 1 : -1;
      let ang = Math.atan2((ny / nlen) * side, (nx / nlen) * side) + (Math.random() - 0.5) * 1.1;
      const reach = lw * (11 + Math.random() * 10) * (0.45 + 0.55 * tint);
      // SHORT AND JAGGED (see chargeTrail): five kinked legs close to the wire, not four long
      // smooth ones. The screenshot of the first cut showed pale whiskers curving off the board.
      const legs = 5;
      const base = ang;
      const pl = [{ x: ox, y: oy }];
      let x = ox, y = oy;
      for (let m = 0; m < legs; m++) {
        ang = base + (m % 2 ? -1 : 1) * (0.35 + Math.random() * 0.55) + (Math.random() - 0.5) * 0.3;
        const step = (reach / legs) * (1 - 0.15 * m);
        x += Math.cos(ang) * step; y += Math.sin(ang) * step;
        pl.push({ x, y });
      }
      const arc = (upto, w, col) => {
        ctx.strokeStyle = col; ctx.lineWidth = lw * w;
        ctx.beginPath(); ctx.moveTo(pl[0].x, pl[0].y);
        for (let m = 1; m <= upto; m++) ctx.lineTo(pl[m].x, pl[m].y);
        ctx.stroke();
      };
      arc(legs, 2.4, `rgba(90,170,255,${(0.3 * tint).toFixed(3)})`);
      arc(legs, 0.95, `rgba(185,230,255,${(0.92 * tint).toFixed(3)})`);
      arc(Math.max(1, legs - 1), 0.5, `rgba(245,252,255,${(0.95 * tint).toFixed(3)})`);
    }
    // PARTICLES: a spray of motes streaming off the charged wire, each on its own heading,
    // spreading wider and fading as its stretch of the line ages. Placed by a HASH of segment and
    // mote plus the age -- not Math.random -- so a mote moves coherently frame to frame instead of
    // jittering in place.
    const age = passed / PULSE_TAIL;
    // SPARKS, NOT BLOBS (operator, 2026-09-13: "the particles are too fat"): half the radius,
    // more of them, thrown further as the stretch ages -- a mist that thins, not a clump of discs.
    for (let k = 0; k < 18; k++) {
      const f0 = hash01(i * 31 + k * 7);
      const bx = p.x + (q.x - p.x) * f0, by = p.y + (q.y - p.y) * f0;
      const ang = hash01(i * 17 + k * 13 + 101) * Math.PI * 2;
      const dist = lw * (4 + 62 * age) * (0.6 + 0.4 * hash01(i + k * 3 + 7));
      const r = lw * (0.6 + 1.3 * hash01(i * 5 + k + 41)) * (1 - 0.45 * age);
      ctx.fillStyle = `rgba(200,236,255,${(0.75 * tint * (1 - 0.5 * age)).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(bx + Math.cos(ang) * dist, by + Math.sin(ang) * dist, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  // THE SMOKE LEAVES WITH IT (operator, 2026-09-13: "The ball just disappears as does the smoke
  // particles"). The spray above is placed per wire SEGMENT, so it can only exist where the wire
  // does -- at the last candle it stops, which is half of what the operator saw vanish. This is
  // the same mist, positioned along the head's flight instead, so it follows the ball off the end
  // and thins out with it.
  {
    const OVERRUN = 0.34;
    for (let m = 0; m < 26; m++) {
      const back = hash01(m * 11 + 7) * PULSE_TAIL * 0.5;       // how far behind the head it trails
      const hp = headPoint(pts, headAt - back, OVERRUN);
      if (!hp || hp.fade >= 1) continue;                        // only past the end: the wire has its own
      const ang = hash01(m * 17 + 41) * Math.PI * 2;
      const spread = lw * (5 + 40 * (back / (PULSE_TAIL * 0.5))) * (0.4 + 0.6 * hash01(m * 5 + 3));
      const r = lw * (0.6 + 1.3 * hash01(m * 7 + 19));
      const a = 0.7 * hp.fade * (1 - back / (PULSE_TAIL * 0.6));
      if (a <= 0.01) continue;
      ctx.fillStyle = `rgba(200,236,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(hp.x + Math.cos(ang) * spread, hp.y + Math.sin(ang) * spread, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // THE HEAD FLIES ON (operator, 2026-09-13: "When the ball gets to the end of the line, it should
  // keep going along it's last vector, and fade out before reaching the edge of the screen").
  // It used to be `if (headAt < 1)` and nothing else -- the bead simply stopped existing at the
  // last candle, which is the disappearance the operator saw. Past the end it now carries on along
  // the direction of the final segment and fades, so it leaves rather than blinks out.
  //
  // OFF THE END, NOT OFF THE SCREEN: the flight is capped at a fraction of the line's own length,
  // so on any board width it goes dark before the edge rather than sailing into the panel border.
  {
    const OVERRUN = 0.34;                       // of the line's length, past the last point
    const hp = headPoint(pts, headAt, OVERRUN);
    if (hp) {
      // a head you cannot miss: a wide blue corona, a bright core, a white point -- all of it
      // scaled and faded together once it is off the wire
      const f = hp.fade;
      // THE BALL ITSELF IS BLUE, not just the tint behind it (operator, 2026-09-13: "The 3d Price
      // chart still doesn't have a neon blue leading pulse like I asked for. It's white").
      //
      // The earlier pass turned the TAIL neon blue and left this stack alone -- and this stack is
      // the head: four discs, of which the inner two were rgba(235,250,255,0.92) over pure
      // rgba(255,255,255,1). A white disc at full alpha painted on top of a blue corona is a white
      // ball with a blue halo, which is exactly what was reported. Every layer is blue-dominant
      // now, the hot centre included -- it is the brightest, palest blue rather than white, so the
      // head still reads as the hottest point on the line without going colourless.
      for (const [r, c0, a0] of [[28, '0,150,255', 0.20], [15, '40,190,255', 0.48], [7, '80,220,255', 0.95], [3, '150,240,255', 1]]) {
        ctx.fillStyle = `rgba(${c0},${(a0 * f).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(hp.x, hp.y, lw * r * (0.55 + 0.45 * f), 0, Math.PI * 2); ctx.fill();
      }
      // THE HEAD CRACKLES (operator, 2026-09-13: "Did you copy the energy crackle from the grid
      // effect, and add to the head of the energy ball travelling along the yellow price line?").
      // It had not been. The crackle above is emitted per wire SEGMENT, gated on that segment's
      // tint, so it lights the charged stretch BEHIND the head and -- this is the part that shows --
      // cannot exist at all once the head runs off the last candle, because out there is no wire to
      // hang it on. The ball spent its entire flight past the end as four bare discs.
      //
      // So this is the grid lightning ball's own vocabulary (drawBall, which strikes bolts from the
      // ball to the crossings round it): bolts thrown OUTWARD from the head, re-rolled every frame,
      // each drawn in the same three passes the wire crackle uses -- a wide dim halo, the arc, then
      // a hot core stopping one leg short so it tapers to a point rather than ending in a stub.
      // Struck from the rim of the bright core, not the centre, so the ball does not swallow them.
      const R = lw * 7;
      const bolts = 3 + ((Math.random() * 4 * f) | 0);
      for (let k = 0; k < bolts; k++) {
        const out = Math.random() * Math.PI * 2;
        const reach = lw * (9 + Math.random() * 14) * (0.45 + 0.55 * f);
        const legs = 5;
        const bp = [{ x: hp.x + Math.cos(out) * R * 0.5, y: hp.y + Math.sin(out) * R * 0.5 }];
        let bx = bp[0].x, by = bp[0].y;
        for (let m = 0; m < legs; m++) {
          // the same hard alternating zig as the wire's forks: a discharge kinks, it does not curve
          const a = out + (m % 2 ? -1 : 1) * (0.3 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.3;
          const step = (reach / legs) * (1 - 0.15 * m);
          bx += Math.cos(a) * step; by += Math.sin(a) * step;
          bp.push({ x: bx, y: by });
        }
        const bolt = (upto, w, col) => {
          ctx.strokeStyle = col; ctx.lineWidth = lw * w;
          ctx.beginPath(); ctx.moveTo(bp[0].x, bp[0].y);
          for (let m = 1; m <= upto; m++) ctx.lineTo(bp[m].x, bp[m].y);
          ctx.stroke();
        };
        bolt(legs, 2.4, `rgba(70,190,255,${(0.32 * f).toFixed(3)})`);
        bolt(legs, 0.95, `rgba(160,235,255,${(0.9 * f).toFixed(3)})`);
        bolt(Math.max(1, legs - 1), 0.5, `rgba(250,255,255,${(0.95 * f).toFixed(3)})`);
      }
    }
  }
  done();
}

function axisLabels(ctx, view, axes, n, k, dpr) {
  const px = (v) => (v * dpr) / k;
  const y = axes.y ?? 0;
  ctx.font = `${px(11)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const t of axes.z ?? []) {
    const p = project(n + 0.8, y, t.z, view);
    const w = ctx.measureText(t.label).width;
    ctx.fillStyle = t.strong ? (t.color ?? 'rgba(40,60,50,1)') : 'rgba(2,12,8,0.78)';
    ctx.fillRect(p.x - px(4), p.y - px(8), w + px(8), px(16));
    ctx.fillStyle = t.strong ? 'rgba(255,255,255,1)' : 'rgba(185,255,220,1)';
    ctx.fillText(t.label, p.x, p.y);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(160,235,205,1)';
  for (const t of axes.x ?? []) { const p = project(t.x, 0, 0, view); ctx.fillText(t.label, p.x, p.y + px(13)); }
}

// THE STAR FIELD behind a space board. A seeded scatter per canvas size, so the sky never
// reshuffles between frames; each star twinkles on its own slow period (2-10 s), a few bright
// ones carry a halo and a cross glint. Plain rgba fills and strokes, in device pixels.
const STARS = new WeakMap();
const NO_CANVAS = {};

// IS THE SKY DRAWN? Not the same question as "is this a space board", though one option used to
// answer both (operator, 2026-09-12: "I don't think the star field toggle works properly for
// markets and price"). `space` also decides the deck texture, the translucent floor and the floor
// line, so turning the stars off through it RESTYLED THE WHOLE BOARD -- which is not what a switch
// labelled "Star field" should do. `stars` gates the sky alone; where it is absent the old
// meaning stands, so every caller that never heard of it behaves exactly as before.
const starsOn = (o) => !!(o.stars ?? o.space);
// THE GALAXY (operator, 2026-09-12: "I want all the starts slowly rotating to form a spiral
// galaxy in the background ... Make it a toggle").
//
// Off, this is the shipped uniform scatter, untouched down to the order the random numbers are
// drawn in. On, the same stars are laid on logarithmic arms and carry POLAR coordinates, so the
// sky turns by advancing ONE angle at draw time rather than by being rebuilt: the field stays
// seeded, the cache stays valid, and each star's own twinkle is unaffected.
//
// The rotation is RIGID -- the whole pattern turns as one. Differential rotation (inner stars
// faster, as a real disc moves) shears spiral arms apart within a few minutes of real time, which
// would destroy the one thing being asked for.
// Every number here was chosen by rendering the variants side by side and looking at them, after
// the first attempt shipped structure without a picture: the tests said the stars clustered on
// arms (they did) while the screen showed a faint streak. What the comparison settled:
//   - FLATTEN 0.42 was the single biggest fault. Edge-on, a spiral reads as a smear across the
//     frame; from well above the disc it reads as a spiral. 0.80.
//   - Two arms at that angle fold into one S through the middle. Four are unmistakable.
//   - The arms were far too wide (+/-0.55 rad of scatter). A wide arm is a smudge; 0.18, and
//     narrowing outward, draws a line.
//   - An arm is drawn BY its stars, and at the scattered sky's count there were not enough of
//     them to make one. Hence GALAXY_BOOST.
export const GALAXY_FLATTEN = 0.80;                    // seen from above the disc, not along it
// NEGATIVE, so the arms TRAIL (operator, 2026-09-12: "galaxy is rotating in wrong direction for
// the astrophysics to work"). The arms wind outward in +theta -- ang = arm + ln(r/inner)/TWIST --
// so an arm's outer end sits ahead of its root in +theta. Turning the disc in +theta as well put
// the tips in FRONT of the rotation: leading arms, which is not what disc galaxies do. A density
// wave leaves the arms trailing, so the disc has to turn against the way they wind.
export const GALAXY_SPIN = -(Math.PI * 2) / 900_000;   // one turn in fifteen minutes: "slowly"
export const GALAXY_ARMS = 4;
export const GALAXY_TWIST = 0.30;                      // how tightly the arms wind
const GALAXY_BOOST = 7;                                // an arm needs many more stars than a scatter
// LOW AND LEFT (operator, 2026-09-12: "We should have the spiral galaxy centers on the lower left
// grid location. That should cluster things up enough to be interesting"). The nucleus sits down
// in that corner and the arms sweep up across the panel, which crowds the interesting part of the
// picture into one place instead of spreading it evenly around the middle.
// [x, y, reach, oversample] as fractions of the panel. A corner placement REACHES past the panel
// so the arms cross it; the centred one stays inside, so the whole spiral is visible behind the
// board.
//
// `oversample` is how many stars must be MADE for each one that lands on the panel, and it has to
// be per placement or the density setting means two different things: measured, a centred disc
// puts all of itself on screen while a corner one puts about 40% off it, so generating the same
// number either way made the centred galaxy twice as dense for the same slider position.
// REACH 3.0 (operator, 2026-09-12: "The spiral galaxy arms need to extend out way farther than
// they do, I want to see long arms on the far side of the board"). Measured on a 1265px board with
// the middle in a corner: at 1.6 the arm tips died at x=876, well short of the far edge; at 3.0
// they carry to x=1400, across it and out. 3.8 was tried and overshoots -- three quarters of the
// stars then live off-panel for no more picture.
//
// The number of WINDINGS does not change with reach, because `inner` scales with maxR: a bigger
// disc shows less than one full winding across the panel, which is what makes the arcs read as
// long sweeps rather than a tight coil.
//
// The oversample figures are the measured inverse of "what fraction of this disc lands on the
// panel", per placement -- 36% centred, 34% from a corner.
export const GALAXY_PLACEMENTS = Object.freeze({
  'center': [0.50, 0.50, 3.00, 2.76],
  'top-left': [0.22, 0.22, 3.00, 2.95],
  'top-right': [0.78, 0.22, 3.00, 2.95],
  'bottom-left': [0.22, 0.78, 3.00, 2.97],
  'bottom-right': [0.78, 0.78, 3.00, 2.97],
});
export const GALAXY_AT_DEFAULT = 'bottom-left';
// An off-centre disc puts much of itself off-panel, and it must still be generated there: a
// rotating field cannot be sampled to the visible rectangle, or turning it would drag bare gaps
// into view. So more stars are made than are ever drawn (see `oversample` above, which is per
// placement), and the draw loop skips the ones outside.
const GALAXY_MAX = 40000;                              // the count scales with area; 4K must not run away

/**
 * NEBULAE (operator, 2026-09-12: "We need to improve the star fields. nebulas, more stars between
 * arms. I needs to look awe-inspiring at the majesty and grandness of the universe with all it's
 * details").
 *
 * Clouds of gas sit ON the arms, because that is where they are: a spiral's colour comes from the
 * star-forming lanes, so placing them by the same logarithmic rule as the arm stars makes the
 * colour follow the structure instead of floating over it.
 *
 * Each cloud is a heap of overlapping low-alpha ellipses. The natural way to draw a nebula is one
 * soft radial gradient, and this renderer cannot: no globalAlpha, no composite modes, no
 * shadowBlur (viewer-canvas-rules.test.js). Many faint fills add up to the same soft edge and
 * cannot be silently dropped by a software rasteriser -- the same reason the star halos are built
 * this way, and the reason the painted galactic core had to be deleted rather than tuned.
 *
 * They carry polar coordinates like the stars, so they turn with the disc for free.
 */
export function nebulaClouds(pw, ph, at = GALAXY_AT_DEFAULT, seed = 11) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const { maxR, inner } = galaxyGeometry(pw, ph, at);
  // dusty magenta, cold blue, teal, warm rose: a sky of one colour looks painted
  const TINTS = [[142, 88, 214], [48, 122, 196], [58, 168, 156], [198, 84, 142]];
  const out = [];
  // Nine clouds, kept to the inner half of the disc: the disc reaches three times past the panel
  // (GALAXY_PLACEMENTS), so a cloud laid anywhere on it was mostly laid off-screen -- the first cut
  // put six out to the rim and the panel got a faint smudge in one corner. And bright enough to
  // be SEEN: the first alphas (0.009-0.024) sat a hair above the background.
  for (let i = 0; i < 9; i++) {
    const t = 0.05 + 0.45 * rnd();
    const rad = inner + (maxR - inner) * t;
    const arm = Math.floor(rnd() * GALAXY_ARMS) * ((Math.PI * 2) / GALAXY_ARMS);
    const ang = arm + Math.log(rad / inner) / GALAXY_TWIST + (rnd() - 0.5) * 0.5;
    const size = maxR * (0.07 + 0.09 * rnd());
    const tint = TINTS[Math.floor(rnd() * TINTS.length)].join(',');
    const puffs = [];
    const n = 22 + Math.floor(rnd() * 14);
    for (let k = 0; k < n; k++) {
      puffs.push({
        dx: (rnd() - 0.5) * size * 2.0,
        dy: (rnd() - 0.5) * size * 1.3,
        rx: size * (0.30 + 0.55 * rnd()),
        sq: 0.65 + 0.7 * rnd(),               // not circles: a cloud has a shape
        a: 0.020 + 0.030 * rnd(),
      });
    }
    out.push({ gr: rad, ga: ang, tint, puffs });
  }
  return out;
}

/**
 * DISTANT GALAXIES (operator, 2026-09-12: "Add whatever other universe / galaxy effects to the
 * scene that you think will make it look even more visually stunning ... A beautiful rendering of
 * our reaility"). A real deep field is not one galaxy on black: it has others in it, small and
 * faint and far. Five of them, scattered over the panel, drawn first so everything else stands in
 * front, and STATIC -- they do not turn with the disc, because they are not part of it. Each is a
 * few concentric ellipses, tilted, in cool white or the faint blue of distance.
 */
export function farGalaxies(pw, ph, seed = 23) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const out = [];
  for (let i = 0; i < 5; i++) {
    out.push({
      x: rnd() * pw, y: rnd() * ph,
      rx: 7 + rnd() * 15,
      ratio: 0.32 + rnd() * 0.5,            // a disc seen at some angle
      rot: rnd() * Math.PI,
      tint: rnd() < 0.5 ? '222,218,240' : '200,222,255',
    });
  }
  return out;
}

/**
 * DUST LANES. The most recognisable thing about a real spiral after the arms themselves: a dark
 * ribbon runs along the INNER (concave) edge of each arm, where the gas is thickest and hides
 * the stars behind it. Drawn over the nebulae and under the stars, as heaps of faint black
 * ellipses -- the same layered-fill technique everything else in this sky uses, for the same
 * canvas-rules reason. Polar, so they turn with the disc.
 */
export function dustLanes(pw, ph, at = GALAXY_AT_DEFAULT, seed = 17) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const { maxR, inner } = galaxyGeometry(pw, ph, at);
  const out = [];
  for (let i = 0; i < 14; i++) {
    const t = 0.06 + 0.5 * rnd();
    const rad = inner + (maxR - inner) * t;
    const arm = Math.floor(rnd() * GALAXY_ARMS) * ((Math.PI * 2) / GALAXY_ARMS);
    // a little INSIDE the arm's centre line: the concave edge, trailing the rotation
    const ang = arm + Math.log(rad / inner) / GALAXY_TWIST - 0.16 + (rnd() - 0.5) * 0.08;
    const size = maxR * (0.05 + 0.06 * rnd());
    const puffs = [];
    const n = 12 + Math.floor(rnd() * 8);
    for (let k = 0; k < n; k++) {
      puffs.push({ dx: (rnd() - 0.5) * size * 2.6, dy: (rnd() - 0.5) * size * 0.8, rx: size * (0.25 + 0.4 * rnd()), sq: 0.5 + 0.5 * rnd(), a: 0.05 + 0.06 * rnd() });
    }
    out.push({ gr: rad, ga: ang, puffs });
  }
  return out;
}

/**
 * STAR CLUSTERS. Globular clusters live in the halo: tight, ancient knots of a few hundred
 * thousand stars, seen as a dense speck with a fuzzy edge. Six of them, out past the arms, each
 * a heap of tiny warm-white points crowded to the middle. Drawn over the stars, turning with the
 * disc, and NOT twinkling -- a cluster is too far for its stars to scintillate one by one.
 */
export function starClusters(pw, ph, at = GALAXY_AT_DEFAULT, seed = 29) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const { maxR } = galaxyGeometry(pw, ph, at);
  const out = [];
  for (let i = 0; i < 6; i++) {
    const rad = maxR * (0.28 + 0.6 * rnd());
    const ang = rnd() * Math.PI * 2;
    const size = 6 + rnd() * 9;
    const stars = [];
    const n = 26 + Math.floor(rnd() * 22);
    for (let k = 0; k < n; k++) {
      // crowded to the middle: radius drawn as the square of a uniform, angle uniform
      const rr = size * rnd() * rnd(), aa = rnd() * Math.PI * 2;
      stars.push({ dx: Math.cos(aa) * rr, dy: Math.sin(aa) * rr, r: 0.35 + rnd() * 0.5, b: 0.35 + rnd() * 0.5 });
    }
    out.push({ gr: rad, ga: ang, size, stars });
  }
  return out;
}

/** Where the disc sits and how big it is. One source, so the renderer and the tests agree. */
export function galaxyGeometry(pw, ph, at = GALAXY_AT_DEFAULT) {
  const [fx, fy, reach, oversample] = GALAXY_PLACEMENTS[at] ?? GALAXY_PLACEMENTS[GALAXY_AT_DEFAULT];
  const maxR = (Math.min(pw, ph / GALAXY_FLATTEN) / 2) * reach;
  return { cx: pw * fx, cy: ph * fy, maxR, inner: maxR * 0.08, oversample };
}
export function starField(pw, ph, dpr = 1, seed = 7, density = 1, galaxy = false) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  // density: the operator's multiplier on the shipped count (settings.js sky.density, which both
  // this board and the markets board read -- it used to live under `markets` and reach only one)
  // 8, not 3 (operator, 2026-09-12: "we need to be able to up the star density even more"). The
  // slider's ceiling lives in settings.js PANEL; this is the renderer's own guard behind it.
  const d = Number.isFinite(density) ? Math.min(8, Math.max(0, density)) : 1;
  const base = ((pw * ph) / (2400 * dpr * dpr)) * d;
  // `galaxy` is false, or WHERE the galaxy goes: a placement key. Carrying the placement in the
  // same argument keeps it part of what the field is built from, so moving the galaxy rebuilds
  // the field exactly the way turning it on does.
  const { cx, cy, maxR, inner, oversample } = galaxy
    ? galaxyGeometry(pw, ph, galaxy === true ? GALAXY_AT_DEFAULT : galaxy)
    : { cx: 0, cy: 0, maxR: 0, inner: 0, oversample: 1 };
  const n = Math.round(galaxy ? Math.min(GALAXY_MAX, base * GALAXY_BOOST * oversample) : base);
  const out = [];
  for (let i = 0; i < n; i++) {
    const big = rnd() > 0.965;
    const tint = rnd();
    const star = {
      x: rnd() * pw, y: rnd() * ph,
      r: (big ? 1.1 + rnd() * 0.9 : 0.35 + rnd() * 0.6) * dpr,
      b: big ? 0.85 + rnd() * 0.15 : 0.25 + rnd() * 0.55,
      // TWINKLE RATE, in radians per millisecond (operator, 2026-09-12: "Some of the large stars
      // are pulsing relatively quickly. Need to slow all that shit down"). It was 0.0006-0.0030,
      // which is a cycle every 2.1 to 10.5 seconds -- at the fast end that is a blink, not a
      // twinkle, and the big stars wear a halo and a cross glint that make it impossible to miss.
      // Now 10.5 to 39 seconds, and a big star runs slower still.
      f: (0.00016 + rnd() * 0.00044) * (big ? 0.6 : 1),
      p: rnd() * Math.PI * 2,
      c: tint < 0.12 ? [255, 226, 180] : tint < 0.3 ? [180, 205, 255] : [235, 242, 255],
      big,
    };
    if (galaxy) {
      // Three populations, because arms alone read as a pinwheel drawn on black: a crowded bulge,
      // the arms themselves, and a thin halo that keeps the outskirts from going empty. Each
      // carries its own brightness, so the density difference becomes a BRIGHTNESS difference --
      // without that the arms were only slightly-closer dots of the same value as everything else.
      const roll = rnd();
      let rad, ang, lit;
      if (roll < 0.12) {
        // the nucleus. Crowded and bright enough to be the middle on its own: the painted core
        // this replaced was six stacked ellipses that read as hard grey banding, because the
        // gradient that would have smoothed them is exactly what the canvas rules forbid.
        rad = maxR * 0.17 * Math.sqrt(rnd());
        ang = rnd() * Math.PI * 2;
        lit = 1;
        // OLD STARS: a bulge is warm. The colour of a real spiral is not one colour -- its middle
        // is yellow with age and its arms are blue with youth, and giving each population its own
        // temperature is most of what makes the picture read as a galaxy rather than a pattern.
        star.c0 = star.c;                                 // the neutral colour, for the switch
        star.c = tint < 0.55 ? [255, 214, 150] : [255, 234, 196];
      } else if (roll < 0.78) {
        const t = Math.pow(rnd(), 0.62);                 // crowded toward the middle
        rad = inner + (maxR - inner) * t;
        const arm = Math.floor(rnd() * GALAXY_ARMS) * ((Math.PI * 2) / GALAXY_ARMS);
        // three rolls make a rough bell: an arm with soft edges rather than a hard stripe,
        // narrowing outward so the arm stays a line instead of fanning into a smudge
        const width = 0.18 * (1.35 - 0.75 * (rad / maxR));
        ang = arm + Math.log(rad / inner) / GALAXY_TWIST + (rnd() + rnd() + rnd() - 1.5) * width;
        lit = 1.2 - 0.35 * (rad / maxR);
        // YOUNG STARS: the arms are where stars are born, and they burn blue-white
        star.c0 = star.c;
        star.c = tint < 0.35 ? [160, 198, 255] : tint < 0.72 ? [205, 224, 255] : [242, 246, 255];
      } else {
        // BETWEEN THE ARMS (operator, 2026-09-12: "more stars between arms. I needs to look
        // awe-inspiring at the majesty and grandness of the universe"). This population was 6% of
        // the sky and it showed: the space between the arms went to black, which reads as a
        // pinwheel on a void rather than a galaxy standing in a star field. 22% now (operator,
        // again: "I want to see more twinkling of stuff between each of teh spiral arms"), and
        // bright enough that their twinkle -- the full swing, since they are small -- actually
        // shows, while still sitting back so the arms carry.
        rad = maxR * (0.16 + 0.84 * rnd());
        ang = rnd() * Math.PI * 2;
        lit = 0.46;
      }
      // fewer haloed giants than an even sky: at seven times the stars they read as clutter
      star.big = star.big && rnd() < 0.4;
      star.r *= 0.85;
      star.b = Math.min(1, star.b * lit);
      star.gr = rad;
      star.ga = ang;
      star.x = cx + rad * Math.cos(ang);
      star.y = cy + rad * GALAXY_FLATTEN * Math.sin(ang);
    }
    out.push(star);
  }
  return out;
}
// THE GAS, BAKED (operator, 2026-09-12: "It really slows down rendering when enabled, I have to
// turn galaxy off to get decent framerate"). The nebulae are a few hundred translucent ellipses
// hundreds of pixels across, and the dust lanes a few hundred more; filled afresh every frame
// they were tens of megapixels of blending -- THAT was the frame, not the stars. The galaxy turns
// as a rigid body, so the gas is painted ONCE into an offscreen bitmap in the disc's own
// coordinates (unturned, unflattened) and each frame is one drawImage through a matrix that
// turns, squashes and places it. The bitmap covers only the part of the disc that can ever
// reach the panel (centre to the farthest corner), at a scale that keeps it under GAS_MAX
// pixels a side -- the gas is soft, and a quarter-scale bitmap of it drawn up is the same gas.
// Rebuilt when the field is (a new f), and when the brightness or a layer switch changes.
// A canvas that cannot make an offscreen one (the tests' recording canvas) gets the live loops.
const GAS_MAX = 2048;
function gasLayer(f, pw, ph, bright, opts) {
  const nebulae = opts.nebulae !== false && !!f.nebulae, dust = opts.dust !== false && !!f.dust;
  if (!nebulae && !dust) return null;
  const key = `${bright.toFixed(3)}|${nebulae}|${dust}`;
  if (f.gas && f.gas.key === key) return f.gas;
  if (f.gas === null) return null;                        // tried once and could not
  let bmp = null;
  try {
    bmp = typeof globalThis.document?.createElement === 'function' ? document.createElement('canvas') : null;
    if (!bmp && typeof globalThis.OffscreenCanvas === 'function') bmp = new OffscreenCanvas(1, 1);
  } catch { bmp = null; }
  const g = bmp?.getContext?.('2d');
  if (!g || typeof g.ellipse !== 'function') { f.gas = null; return null; }
  const { cx, cy } = f;
  const reach = Math.max(Math.hypot(cx, cy), Math.hypot(pw - cx, cy), Math.hypot(cx, ph - cy), Math.hypot(pw - cx, ph - cy)) / GALAXY_FLATTEN + 64;
  const q = Math.min(1, GAS_MAX / (2 * reach));
  const D = Math.ceil(2 * reach * q);
  bmp.width = D; bmp.height = D;
  g.setTransform(q, 0, 0, q, D / 2, D / 2);
  if (nebulae) {
    for (const c of f.nebulae) {
      const nx = c.gr * Math.cos(c.ga), ny = c.gr * Math.sin(c.ga);
      for (const p of c.puffs) {
        g.fillStyle = `rgba(${c.tint},${(p.a * bright).toFixed(4)})`;
        g.beginPath();
        g.ellipse(nx + p.dx, ny + p.dy, p.rx, p.rx * p.sq, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  if (dust) {
    for (const d of f.dust) {
      const dx0 = d.gr * Math.cos(d.ga), dy0 = d.gr * Math.sin(d.ga);
      for (const p of d.puffs) {
        g.fillStyle = `rgba(0,0,0,${p.a.toFixed(3)})`;
        g.beginPath();
        g.ellipse(dx0 + p.dx, dy0 + p.dy, p.rx, p.rx * p.sq, d.ga, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  f.gas = { key, bmp, q, D };
  return f.gas;
}

// THE STARS, BATCHED (operator, 2026-09-12: "is there any way to improve the galaxy speed behind
// the game? ... I have to turn galaxy off to get decent framerate. nothing we can optimize
// there?"). There was. The first cut set ctx.fillStyle once PER STAR -- a colour string built
// and parsed forty thousand times a frame -- and that, not the arithmetic, was the frame. Now a
// star's brightness is rounded to one of STAR_LEVELS steps (a thirtieth of the range, under any
// eye's notice on a one-pixel point) and the field is sorted into colour x level BUCKETS with a
// counting sort over preallocated typed arrays (no allocation a frame), so the canvas hears one
// fillStyle and one fill() per bucket -- a few hundred at most -- with every star of that shade
// as one rect() in the path. The picture is the same; the giants keep their halo and glint drawn
// one by one, since there are few of them.
const STAR_LEVELS = 48;
function starBuckets(f, colours) {
  // built once per field (and once per colour switch): the palette, each star's palette index,
  // and the scratch arrays the per-frame sort runs in
  const key = colours ? 'ci' : 'ci0';
  if (f.bk?.key === key) return f.bk;
  const pal = [], idx = new Map();
  const ci = new Int16Array(f.stars.length);
  f.stars.forEach((s, i) => {
    const c = (colours || !s.c0 ? s.c : s.c0).join(',');
    let k = idx.get(c);
    if (k === undefined) { k = pal.length; idx.set(c, k); pal.push(c); }
    ci[i] = k;
  });
  const B = pal.length * STAR_LEVELS;
  const styles = new Array(B);
  for (let b = 0; b < B; b++) styles[b] = `rgba(${pal[b / STAR_LEVELS | 0]},${((b % STAR_LEVELS) / (STAR_LEVELS - 1)).toFixed(3)})`;
  const n = f.stars.length;
  f.bk = { key, pal, ci, styles, B, px: new Float32Array(n), py: new Float32Array(n), bucket: new Int32Array(n), count: new Int32Array(B + 1), order: new Int32Array(n) };
  return f.bk;
}
function drawStarField(ctx, f, pw, ph, dpr, now, spin, galaxy, bright, opts) {
  const colours = opts.starColours !== false, glints = opts.starGlints !== false;
  const stars = f.stars, n = stars.length;
  const bk = starBuckets(f, colours);
  const { px, py, bucket, count, order, styles, ci, B } = bk;
  count.fill(0);
  const cs = Math.cos(spin), sn = Math.sin(spin);
  for (let i = 0; i < n; i++) {
    const s = stars[i];
    let x, y;
    if (galaxy) {
      // one rotation for the whole field: cos(a + spin) expanded, so no trig per star
      const ca = s.ca ?? (s.ca = Math.cos(s.ga)), sa = s.sa ?? (s.sa = Math.sin(s.ga));
      x = f.cx + s.gr * (ca * cs - sa * sn);
      y = f.cy + s.gr * GALAXY_FLATTEN * (sa * cs + ca * sn);
      // the disc reaches past the panel now that its middle is in the corner: most of it is off
      // screen at any moment, and the cheapest thing to do with those stars is nothing
      if (x < -4 || x > pw + 4 || y < -4 || y > ph + 4) { bucket[i] = -1; continue; }
    } else { x = s.x; y = s.y; }
    px[i] = x; py[i] = y;
    const a = Math.min(1, starAlpha(s, now) * bright);
    const b = ci[i] * STAR_LEVELS + Math.round(a * (STAR_LEVELS - 1));
    bucket[i] = b;
    count[b + 1]++;
  }
  for (let b = 0; b < B; b++) count[b + 1] += count[b];   // prefix sums: where each bucket starts
  const at = count.slice(0, B);
  for (let i = 0; i < n; i++) { const b = bucket[i]; if (b >= 0) order[at[b]++] = i; }
  for (let b = 0; b < B; b++) {
    const from = count[b], to = count[b + 1];
    if (from === to) continue;
    ctx.fillStyle = styles[b];
    ctx.beginPath();
    for (let k = from; k < to; k++) { const i = order[k]; const r = stars[i].r; ctx.rect(px[i] - r, py[i] - r, r * 2, r * 2); }
    ctx.fill();
  }
  if (!glints) return;
  // the giants' halo and cross, one by one: a few hundred at most
  for (let i = 0; i < n; i++) {
    const s = stars[i];
    if (!s.big || bucket[i] < 0) continue;
    const a = Math.min(1, starAlpha(s, now) * bright);
    const c = colours || !s.c0 ? s.c : s.c0;
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(a * 0.12).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(px[i], py[i], s.r * 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${(a * 0.5).toFixed(3)})`;
    ctx.lineWidth = dpr * 0.6;
    ctx.beginPath();
    ctx.moveTo(px[i] - s.r * 5, py[i]); ctx.lineTo(px[i] + s.r * 5, py[i]);
    ctx.moveTo(px[i], py[i] - s.r * 5); ctx.lineTo(px[i], py[i] + s.r * 5);
    ctx.stroke();
  }
}
export function starAlpha(star, now) {
  const w = 0.5 + 0.5 * Math.sin(now * star.f + star.p);
  // How DEEP the pulse goes, not just how fast. A small star may fade to a third of itself and
  // still read as a twinkle; a big one doing that reads as a light being switched on and off,
  // because its halo and glint swing with it. So the giants shimmer between roughly half and
  // full, and the faint ones keep the wider swing that makes a sky look alive.
  const floor = star.big ? 0.55 : 0.3;
  return star.b * (floor + (1 - floor) * w * w);
}
function drawStars(ctx, pw, ph, dpr, now, opts = {}) {
  const key = ctx.canvas ?? NO_CANVAS;
  const density = Number.isFinite(opts.starDensity) ? opts.starDensity : 1;
  const bright = Number.isFinite(opts.starBrightness) ? Math.min(1.5, Math.max(0, opts.starBrightness)) : 1;
  // false when off, otherwise WHERE it sits -- so the cache key below rebuilds the field when the
  // operator moves it, the same way it does when they turn it on
  const galaxy = opts.galaxy
    ? (GALAXY_PLACEMENTS[opts.galaxyAt] ? opts.galaxyAt : GALAXY_AT_DEFAULT)
    : false;
  let f = STARS.get(key);
  // the field is rebuilt when the density or the SHAPE changes as well as the size: it is a seeded
  // scatter, so the same density always gives the same sky back. Turning is NOT a rebuild -- the
  // stars carry polar coordinates and only the angle advances, once per frame for all of them.
  if (!f || f.pw !== pw || f.ph !== ph || f.density !== density || f.galaxy !== galaxy) {
    const g = galaxyGeometry(pw, ph, galaxy || undefined);
    f = {
      pw, ph, density, galaxy, cx: g.cx, cy: g.cy,
      stars: starField(pw, ph, dpr, 7, density, galaxy),
      // built once with the field, and turned with it: a cloud is placed in polar coordinates
      nebulae: galaxy ? nebulaClouds(pw, ph, galaxy === true ? GALAXY_AT_DEFAULT : galaxy) : null,
      // and the deep field behind everything, galaxy or not
      far: farGalaxies(pw, ph),
      dust: galaxy ? dustLanes(pw, ph, galaxy === true ? GALAXY_AT_DEFAULT : galaxy) : null,
      clusters: galaxy ? starClusters(pw, ph, galaxy === true ? GALAXY_AT_DEFAULT : galaxy) : null,
    };
    STARS.set(key, f);
  }
  ctx.__starBright = bright;
  const spin = galaxy ? now * GALAXY_SPIN : 0;
  // the deep field first: distant galaxies, small and still
  if (f.far && opts.galaxies !== false && typeof ctx.ellipse === 'function') {
    for (const g of f.far) {
      for (const [k, a] of [[1, 0.035], [0.72, 0.05], [0.48, 0.08], [0.22, 0.16]]) {
        ctx.fillStyle = `rgba(${g.tint},${(a * bright).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(g.x, g.y, g.rx * k * dpr, g.rx * k * g.ratio * dpr, g.rot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // then the gas: the stars stand IN it, not behind it. Baked to a bitmap where the page can
  // make one (gasLayer) and drawn turned in one call; the live loops below are the fallback.
  const gas = galaxy ? gasLayer(f, pw, ph, bright, opts) : null;
  if (gas) {
    const q = gas.q, cs = Math.cos(spin), sn = Math.sin(spin);
    // local (unflattened, unturned) disc -> panel: turn by the spin, squash y by the flatten,
    // scale up by 1/q, land on the centre -- the same map the stars go through, as one matrix
    ctx.setTransform(cs / q, (GALAXY_FLATTEN * sn) / q, -sn / q, (GALAXY_FLATTEN * cs) / q, f.cx, f.cy);
    ctx.drawImage(gas.bmp, -gas.D / 2, -gas.D / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (!gas && galaxy && f.nebulae && opts.nebulae !== false && typeof ctx.ellipse === 'function') {
    for (const c of f.nebulae) {
      const ang = c.ga + spin;
      const nx = f.cx + c.gr * Math.cos(ang);
      const ny = f.cy + c.gr * GALAXY_FLATTEN * Math.sin(ang);
      for (const p of c.puffs) {
        ctx.fillStyle = `rgba(${c.tint},${(p.a * bright).toFixed(4)})`;
        ctx.beginPath();
        ctx.ellipse(nx + p.dx, ny + p.dy * GALAXY_FLATTEN, p.rx, p.rx * GALAXY_FLATTEN * p.sq, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // the dust over the gas and under the stars: dark ribbons on the inner edge of each arm
  if (!gas && galaxy && f.dust && opts.dust !== false && typeof ctx.ellipse === 'function') {
    for (const d of f.dust) {
      const ang = d.ga + spin;
      const dx0 = f.cx + d.gr * Math.cos(ang), dy0 = f.cy + d.gr * GALAXY_FLATTEN * Math.sin(ang);
      for (const p of d.puffs) {
        ctx.fillStyle = `rgba(0,0,0,${p.a.toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(dx0 + p.dx, dy0 + p.dy * GALAXY_FLATTEN, p.rx, p.rx * GALAXY_FLATTEN * p.sq, ang, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  drawStarField(ctx, f, pw, ph, dpr, now, spin, galaxy, bright, opts);
  // the clusters last, over the field: dense specks with a fuzzy edge, steady (no twinkle)
  if (galaxy && f.clusters && opts.clusters !== false) {
    for (const k of f.clusters) {
      const ang = k.ga + spin;
      const kx = f.cx + k.gr * Math.cos(ang), ky = f.cy + k.gr * GALAXY_FLATTEN * Math.sin(ang);
      if (kx < -30 || kx > pw + 30 || ky < -30 || ky > ph + 30) continue;
      ctx.fillStyle = `rgba(255,240,215,${(0.05 * bright).toFixed(3)})`;
      ctx.fillRect(kx - k.size, ky - k.size, k.size * 2, k.size * 2);
      for (const q of k.stars) {
        ctx.fillStyle = `rgba(255,244,222,${Math.min(1, q.b * bright).toFixed(3)})`;
        ctx.fillRect(kx + q.dx - q.r, ky + q.dy - q.r, q.r * 2, q.r * 2);
      }
    }
  }
}

// There is deliberately NO painted core. The first cut stacked six faint ellipses at the middle,
// and rendered they read as hard grey rings rather than a glow -- the gradient that would smooth
// them is exactly what the canvas rules here forbid (no globalAlpha, no composite modes, no
// shadowBlur: viewer-canvas-rules.test.js). The nucleus is stars instead: the bulge population is
// dense and at full brightness, which looks like a core because it is one.

function paintFrame(ctx, geom, frame, opts, view, gridN, blockRows, gridH = gridN) {
  const { pw, ph, dpr } = geom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // cleared first, so a TRANSPARENT background (Tetrust's well, laid over its own sky canvas) shows
  // what is behind the canvas rather than the last frame
  ctx.clearRect(0, 0, pw, ph);
  ctx.fillStyle = opts.background;
  ctx.fillRect(0, 0, pw, ph);
  if (starsOn(opts)) drawStars(ctx, pw, ph, dpr || 1, view.now ?? 0, opts);
  // with nothing on the board -- every block in the air between two layouts (a viewer-mode switch)
  // -- the oblique board still draws itself: its transform is a constant, not fitted to the blocks
  if (!frame.bounds && !opts.oblique) return;

  // BOTTOM-LEFT IS FLUSH WITH THE PANEL, ALWAYS.
  //
  // No centring, no measured bounds, no padding: the board's own corner
  // (0,0) is mapped to the canvas's bottom-left corner and the far corner to
  // the top-right. That is why the view cannot slide. Fitting to MEASURED
  // bounds -- even the grid's -- still moved things, because with rows
  // flipped the projected y range is NEGATIVE while the vanishing point was
  // computed as positive, so the growth expansion skewed the bounds and
  // pushed the picture down.
  //
  // Blocks in flight reach past these edges and are drawn off-canvas. The
  // operator has accepted that twice; a locked view is worth more than
  // keeping every block inside the frame.
  const bw = Math.max(1, gridN * opts.unit);
  const bh = Math.max(1, gridH * opts.unit);
  // Under the oblique camera height is drawn up and to the right, so the
  // board keeps its bottom-left corner flush and a CONSTANT strip is left
  // along the top and right for the tallest cube, the dome and the flight --
  // constant, so the view still cannot move between frames or refreshes.
  const of = opts.oblique ? obliqueFit(pw, ph, gridN, gridH, opts) : null;
  const fit = of ? { scaleX: of.k, scaleY: of.k, tx: of.tx, ty: of.ty } : { scaleX: pw / bw, scaleY: ph / bh, tx: 0, ty: ph };
  //   pinhole: grid x 0..bw -> canvas 0..pw, grid y -bh..0 -> canvas ph..0 (row 0 on the floor)
  //   oblique: the board centred, the sphere filling the rest (obliqueFit)
  ctx.setTransform(fit.scaleX, 0, 0, fit.scaleY, fit.tx, fit.ty);
  frame.__fit = { scaleX: fit.scaleX, scaleY: fit.scaleY, tx: fit.tx, ty: fit.ty, ph, unit: opts.unit };
  ctx.lineWidth = Math.max(0.5, 0.6 / Math.min(fit.scaleX, fit.scaleY));
  ctx.lineJoin = 'round';

  // The ground first, then the shadows lying on it, then the glowing layer
  // (drawGrid returns it) -- light, so no shadow dims it -- then the cubes.
  let glow = opts.grid ? drawGrid(ctx, view, opts, gridN, blockRows, gridH) : null;
  let wall = opts.axes ? () => drawAxes(ctx, view, opts.axes, gridN) : null;
  for (const op of frame.ops) {
    if (glow && op.face !== 'shadow') { glow(); glow = null; }
    if (wall && op.face !== 'shadow') { wall(); wall = null; }
    const p = op.points;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.closePath();
    ctx.fillStyle = op.fill;
    ctx.fill();
    // The seam's colour comes from the op, already scaled by the tile's
    // alpha, so an outline fades exactly as its tile does. A fixed colour
    // here is what left black frames hanging where departing blocks had been.
    // `always`: an op whose stroke IS the point (the neon edge) draws whether or not the dark
    // seam (Stone edges) is on -- it replaces the seam rather than accompanying it
    if (op.stroke && (opts.edges || op.always)) {
      ctx.strokeStyle = op.stroke;
      if (op.lw) { const lw0 = ctx.lineWidth; ctx.lineWidth = lw0 * op.lw; ctx.stroke(); ctx.lineWidth = lw0; }
      else ctx.stroke();
    }
  }
  if (glow) glow();   // a board with no cubes on it
  if (wall) wall();
  if (opts.axes?.line) priceLine(ctx, view, opts.axes);
  if (opts.axes) axisLabels(ctx, view, opts.axes, gridN, fit.scaleX, dpr || 1);
  // THE AGENT'S OWN GEOMETRY, dispatched from the registry (agents.js). The light cycles' walls
  // and the lightning ball were two hard-coded calls here; with fifty agents this is the seam.
  // drawCycles and drawBall stay in this module -- lightcycle-crash.test.js imports drawCycles by
  // name and calls it with a hand-built view -- and the registry simply points at them.
  const agentDraw = view.fx?.kind ? AGENTS[view.fx.kind]?.draw : null;
  if (agentDraw) agentDraw(ctx, view, ctx.lineWidth, { drawCycles, drawBall, project });
  else { drawCycles(ctx, view, ctx.lineWidth); drawBall(ctx, view, ctx.lineWidth); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// THE LOOK (operator, 2026-09-11: "absolutely spectacular ... make them feel
// like they are in The Matrix"): a green-black field, a phosphor floor and
// grid, and Tetris cells with a metallic finish for transactions (see
// buildScene in blockscene3d.js). The blocks keep the feerate palette
// (feepalette.js) -- the environment is themed, the data colours are not.
// Digital rain was tried over the top the same day and removed at the
// operator's call ("looks stupid and adds nothing practical"): atmosphere that
// carries no data is not worth a second animation loop.
export const DEFAULTS = {
  resolution: 44,
  blockVbytes: 1000000,
  background: 'rgba(2,9,6,1)',
  edges: true,
  seamAlpha: 0.38,       // the dark seam round each stone; scaled by its fade
  idleFx: true,          // varied effects across the board at rest (see fxAt)
  idleEvery: [5000, 9000],   // between effects while the board stays still (7-13 s until 2026-09-11)
  idleFirst: [800, 1600],    // the first one after a transition lands ("trigger any effects sooner")
  // the block template, drawn on the ground
  grid: true,
  gridStep: 4,
  floor: 'rgba(40,82,70,1)',          // the deck's slate teal: mid-tone, so a shadow shows (groundLayers)
  vanish: { fx: 0.5, fy: 0.5 },   // (overhead camera only) where the pinhole sits
  // THE DEFAULT CAMERA IS OBLIQUE, ON A CURVED BOARD (2026-09-11; see
  // project()): height is an offset up and a little right, flight altitude is
  // compressed into `headroom`, and the board domes toward the viewer --
  // operator: "it would be more compelling if it was a partial spherical board,
  // instead of a flat surface. Would really help with the 3D". Zero on every
  // edge, so the board stays flush; set oblique: null for the overhead pinhole.
  // Tuned from photographs of four settings side by side (2026-09-11): 0.28 /
  // 0.55 with a 12-unit dome made the largest cubes towers and heaped the
  // board up off its own grid. A steeper camera still shows every cube's top
  // and two sides, foreshortened, and a 7-unit dome bows the board visibly.
  // ...and at full panel size 0.15 / 0.36 with a 7-unit dome still heaped
  // the tall cubes up the middle; the calmer 0.13 / 0.32 with a 5-unit dome
  // keeps the board reading as a board while it still visibly bows.
  // (headroom 8 -> 10 when the board was centred: the margin is now the same
  // on every side, and the tallest back-row cube on the curve needs 10)
  oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 },   // flight: the highest a reshuffle climbs, where the panel has room
  dome: 5,
  gridGlow: 'rgba(40,255,140,0.05)',
  gridColor: 'rgba(60,255,150,0.16)',
  gridEdgeColor: 'rgba(120,255,190,1)',
  // the neon grid inside the board (boardGridLayers)
  // SOLID cores (operator, 2026-09-11: "the glowing grid still has shadows cast on
  // it. I want that neon light cutting through darkness entirely"): a
  // see-through line reads dimmer wherever the floor under it is shadowed, and
  // additive blending is off the table (no composite modes), so the lines
  // themselves are opaque and read the same in light and shadow; only the halo
  // and glow round them are translucent.
  neonCell: 'rgba(50,190,125,1)',
  neonHalo: 'rgba(40,255,140,0.07)',    // a wide faint halo round each plate line: the glow
  neonGlow: 'rgba(40,255,140,0.2)',
  neonLine: 'rgba(170,255,210,1)',
  blockLineColor: 'rgba(200,255,120,0.95)',
  // level of detail, in DEVICE pixels of a stone's side: below facetPx a
  // stone is a plain slab, below crownPx it has facets but no crown or glint
  facetPx: 9,
  crownPx: 18,
  unit: 6,
  zUnit: 6,
  // how hard a receding block shrinks; the choreography drives `depth`
  persp: 0.55,
  edgeMargin: 0.06,   // reserved by the fit AND the ceiling on the flight swell
  pad: 3,             // canvas padding; small, because the board should fill the panel
};

// --- hover ---------------------------------------------------------------
// Which block is under the pointer. The transform is a plain scale plus a
// translate, so inverting it is arithmetic rather than a search: screen ->
// grid, then the one resting tile whose footprint contains that cell. Resting
// tiles never overlap (the packer guarantees it), so there is exactly one
// answer and no z-order to resolve.
//
// Only while the picture is SETTLED. Mid-flight a block is not where its
// footprint says, and reporting a transaction the pointer is not over is
// worse than reporting nothing.
// IS THE BOARD AT REST? (operator, 2026-09-11: "a button for 'Trigger Refresh
// Now' that is only enabled when the animation is idle"). True once a board
// has been drawn, its transition has landed, and no newer layout is waiting
// its turn; idle effects do not count as motion.
export function viewerIdle(canvas) {
  const st = canvas ? STATE.get(canvas) : null;
  return !!(st && st.plan && st.settled && !st.pending);
}

// The topmost face (not a shadow) whose polygon holds the point, by the even-odd rule. Pure.
export function hitOps(ops, x, y) {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    const p = op.points;
    if (op.face === 'shadow' || !p || p.length < 3) continue;
    let inside = false;
    for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
      if ((p[a].y > y) !== (p[b].y > y) && x < ((p[b].x - p[a].x) * (y - p[a].y)) / (p[b].y - p[a].y) + p[a].x) inside = !inside;
    }
    if (inside) return op.txid;
  }
  return null;
}

export function hitTest(canvas, clientX, clientY) {
  const st = STATE.get(canvas);
  if (!st || !st.lastFit || !st.restTiles || !st.settled) return null;
  const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: canvas.clientWidth, height: canvas.clientHeight };
  const dpr = (globalThis.window && window.devicePixelRatio) || 1;
  const px = (clientX - rect.left) * dpr;
  const py = (clientY - rect.top) * dpr;
  const f = st.lastFit;
  // WHAT IS DRAWN THERE, not whose footprint is under it: a market candle floats far above its
  // footprint, and a tall cube covers the floor behind it. The topmost face drawn at the pointer.
  if (st.lastOps) {
    const id = hitOps(st.lastOps, (px - (f.tx ?? 0)) / f.scaleX, (py - (f.ty ?? f.ph)) / f.scaleY);
    return id == null ? null : st.restTiles.find((t) => String(t.txid) === String(id)) ?? null;
  }
  const gx = ((px - (f.tx ?? 0)) / f.scaleX) / f.unit;
  const gy = -((py - (f.ty ?? f.ph)) / f.scaleY) / f.unit;
  for (const tile of st.restTiles) {
    if (gx >= tile.x && gx < tile.x + tile.s && gy >= tile.y && gy < tile.y + tile.s) return tile;
  }
  return null;
}

function fmtVb(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)} kvB` : `${Math.round(n)} vB`; }

// HOVER GLOW AND CLICK-THROUGH (operator, 2026-09-11: "when I mouse-over on a block in the block
// space, I want it to glow and then fade out when I move the mouse off it. if I click a glowing
// box, I want it to take me to the txid in the explorer view"). The tile under the pointer lights
// up over GLOW_IN ms and, released, fades over GLOW_OUT ms -- a re-hover mid-fade resumes from
// where it is. The loop runs only while a glow is changing; a steadily lit tile costs nothing.
const GLOW_IN = 120, GLOW_OUT = 600;
const TXID = /^[0-9a-f]{64}$/i;
const perfNow = () => (globalThis.performance && performance.now()) || 0;
export function glowLevel(g, t) {
  if (!g) return 0;
  const up = (on) => Math.min(1, (g.from ?? 0) + Math.max(0, on - g.on) / GLOW_IN);
  if (g.off == null) return up(t);
  return Math.max(0, up(g.off) * (1 - Math.max(0, t - g.off) / GLOW_OUT));
}
function setHover(st, id) {
  const now = perfNow();
  st.glow ??= new Map();
  if (st.hoverId) { const g = st.glow.get(st.hoverId); if (g && g.off == null) g.off = now; }
  st.hoverId = id;
  if (id) st.glow.set(id, { on: now, off: null, from: glowLevel(st.glow.get(id), now) });
  st.dirty = true;
  st.wake?.();
}
function glowMap(st, t) {
  if (!st.glow?.size) return null;
  const m = new Map();
  for (const [id, g] of st.glow) {
    const v = glowLevel(g, t);
    if (v > 0.005) m.set(id, v);
    else if (g.off != null) st.glow.delete(id);
  }
  return m.size ? m : null;
}
function glowAnimating(st, t) {
  for (const g of st.glow?.values() ?? []) {
    if (g.off != null ? glowLevel(g, t) > 0.005 : glowLevel(g, t) < 1) return true;
  }
  return false;
}

function bindHover(canvas, st) {
  if (st.hoverBound || !canvas.addEventListener) return;
  st.hoverBound = true;
  const tip = canvas.parentElement?.querySelector?.('.goggles-tip') ?? null;
  const hide = () => tip?.classList?.add('hidden');
  canvas.addEventListener('pointermove', (e) => {
    // A BOARD CAN REFUSE HOVER (`hover: false`; operator, 2026-09-12: "In blockout, don't highlite
    // the paddle block controller when I mouse over it"). On a data board the pointer picks out a
    // transaction; on a playfield it is holding the bat, so lighting whatever is under it -- and
    // offering a tooltip and a pointer cursor for it -- is noise. The flag is read from the state
    // rather than captured here, so it follows the option rather than whichever draw bound first.
    if (st.noHover) return;
    const hit = hitTest(canvas, e.clientX ?? 0, e.clientY ?? 0);
    const hid = hit ? String(hit.txid) : null;
    if (hid !== (st.hoverId ?? null)) setHover(st, hid);
    if (canvas.style) canvas.style.cursor = hit && TXID.test(hid) ? 'pointer' : '';
    if (!tip) return;
    if (!hit) { hide(); return; }
    if (hit.label) { tip.textContent = hit.label; tip.classList.remove('hidden'); return; }
    const rate = hit.rate ?? 0;
    const id = String(hit.txid);
    const label = id.startsWith('aggregate@')
      ? 'aggregated small transactions'
      : (id.length > 20 ? id.slice(0, 12) + '…' + id.slice(-6) : id);
    tip.textContent = `${label} · ${fmtVb(hit.vsize ?? 0)} · ${rate.toFixed(rate < 10 ? 2 : 1)} sat/vB`;
    tip.classList.remove('hidden');
  });
  canvas.addEventListener('pointerleave', () => { hide(); setHover(st, null); if (canvas.style) canvas.style.cursor = ''; });
  // a transaction opens in the explorer; aggregate pieces and market candles only glow
  canvas.addEventListener('click', (e) => {
    if (st.noHover) return;                 // a click on a playfield serves the ball, it does not navigate
    const hit = hitTest(canvas, e.clientX ?? 0, e.clientY ?? 0);
    if (hit && TXID.test(String(hit.txid)) && globalThis.location) globalThis.location.hash = `#explorer/tx/${String(hit.txid).toLowerCase()}`;
  });
  canvas.addEventListener('pointercancel', hide);
}

export function render3d(canvas, cells, options = {}) {
  if (!canvas || !canvas.getContext) return null;
  const opts = { ...DEFAULTS, ...options };
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  let st = STATE.get(canvas);
  if (!st) {
    st = { prev: [], raf: null, plan: null, dirty: false };
    STATE.set(canvas, st);
  }
  st.noHover = opts.hover === false;        // see bindHover: playfields do not light up under the pointer

  // FLUSH WITH THE VIEWPORT (operator, 2026-09-11: "Blocks are being shown
  // off the viewport. I want the grid bounds flush with the viewport"). One
  // block's worth packs to very nearly resolution x resolution, but square
  // sides round UP to whole units, so the packing can come out a row or two
  // taller than the grid, and the board transform (a constant, see below)
  // then draws the top of it past the edge. Dropping the overflow was tried
  // and cost over 10% of the block on a realistic pool, so the block is
  // re-packed at a slightly smaller scale instead -- every square shrinks
  // alike, so relative areas stay exact -- until it fits. The scale moves in
  // 5% steps and is remembered per canvas: similar data keeps the same scale
  // and does not set every tile moving on a refresh.
  // Stable where it can be (packStable keeps every surviving transaction in
  // its square), fresh where it must be -- and only at the scale the previous
  // layout was made at, since at another scale every square's side changes.
  const laid = Array.isArray(opts.laid) ? opts.laid : null;   // board3d: tiles the caller laid out
  // THE EXACT FILL for the Simple board (operator, 2026-09-12: "Simple viewer mode is what I use
  // as default. It needs to be fucking perfect" ... "packer is still fucked up"). One block's
  // worth with a summed tail is packed to the last cell with the scale SOLVED (blockpack.js
  // packExact) instead of shrunk 5% at a time until it happened to fit -- which left the last row
  // partial by construction: measured, the top row 55% full and 92 cells stranded. Chosen by the
  // presence of the tail, which only the Simple board carries; the dithered per-transaction
  // Detailed board has no tail to fill with and keeps its own pack below, as does a board the
  // caller laid out (Markets).
  const agg = laid || opts.dither ? null : ((cells || []).find((c) => (Number(c?.aggregate) || 0) > 1) ?? null);
  const pack = (k) => {
    const txs = toTxs(cells, vbytesPerUnit(opts.blockVbytes * k, opts.resolution));
    const cfg = { resolution: opts.resolution, blockLimit: opts.blockVbytes * k, dither: !!opts.dither };   // dither: Detailed, area-true sides
    // Fresh every time. The stable packer (blockpack.js packStable) moved far
    // fewer blocks but left the resting board ragged -- columns half a cell
    // out of step, holes (operator: "I mean what even is this?"). Kept for
    // later; the oblique camera makes crossing paths read as depth instead.
    return packBlock(txs, cfg);
  };
  const tallest = (p) => p.tiles.reduce((m, t) => Math.max(m, t.y + t.s), 0);
  let fitK = st.fitK ?? 1;
  let packed;
  if (agg) {
    const plain = (cells || []).filter((c) => c !== agg).map((c, i) => ({
      txid: c.txid || `cell-${i}`, vsize: Math.max(1, Number(c.vbytes ?? c.vsize) || 0), rate: Math.max(0, Number(c.rate) || 0),
    }));
    // the tail's pieces take the feerate of the stratum they fall in, richest first -- the same
    // rule toTxs applies, so the colours are unchanged; only the layout is
    const tail = { vbytes: Math.max(1, Number(agg.vbytes ?? agg.vsize) || 0), rateAt: strataRates(agg.strata, Math.max(0, Number(agg.rate) || 0)) };
    packed = packExact(plain, tail, { resolution: opts.resolution, cap: 3 });
    fitK = 1;                                            // nothing to shrink: the scale was solved
  } else {
    packed = laid ? { tiles: laid, vbytesPerUnit: 0, gridWidth: 1 } : pack(fitK);
    while (!laid && tallest(packed) > opts.resolution && fitK < 2) { fitK *= 1.05; packed = pack(fitK); }
    while (!laid && fitK > 1.0001) {
      const smaller = pack(fitK / 1.05);
      if (tallest(smaller) > opts.resolution) break;
      fitK /= 1.05; packed = smaller;
    }
  }
  st.fitK = fitK;
  const tiles0 = laid ?? packed.tiles.filter((t) => t.y + t.s <= opts.resolution);
  // SLABS (Viewer Mode 2): with every transaction on the board, a cube as tall as it is wide
  // hides its neighbours, so each stands no taller than opts.slab
  const tiles = opts.slab ? tiles0.map((t) => ({ ...t, tall: Math.min(t.s, opts.slab) })) : tiles0;   // belt and braces past 2x
  // The grid must contain EVERY block and fill the space, so it spans the
  // packed extent rather than one block's worth. A tile outside its own grid
  // would be a transaction standing on nothing.
  // The tail pieces are interchangeable -- equal size, equal colour, and they
  // stand for transactions we were never sent individually. Numbering them by
  // ARRIVAL order meant one change early in the packing shifted every piece
  // after it, so the whole green field took flight on a round where nothing
  // about it had actually changed (operator: "if there is no movement
  // forecast for the larger green blocks, don't animate them"). Numbering
  // them by the SLOT they land in makes a piece in an unchanged cell the same
  // piece, so it holds still and only genuine churn moves.
  for (const t2 of tiles) if (String(t2.txid).startsWith('aggregate-')) t2.txid = `aggregate@${t2.x},${t2.y}`;
  // THE GRID IS A CONSTANT, AND THAT IS WHAT MAKES THE VIEW HOLD STILL.
  //
  // It used to be the EXACT packed extent -- gridH = packed.gridHeight. The
  // flush corner mapping below then maps grid row 0 to the canvas floor and
  // row gridH to the ceiling, so bottom-left is pinned... but the SCALE is
  // ph/(gridH*unit), and gridH changed on every refresh as the packing came
  // out a row taller or shorter. A taller packing shrinks scaleY, the whole
  // picture compresses toward the floor, and the top edge walks down the
  // panel. That is the "it shifts down on the first transition" the operator
  // kept seeing, and it survived both earlier attempts at the fit because
  // neither of them touched the thing that was actually varying.
  //
  // One block at this resolution packs to very nearly resolution x
  // resolution by construction (vbytesPerUnit is derived from exactly that),
  // so a fixed square grid is also the right grid: it is full, it is square
  // as asked, and it never moves. A packing that overflows it draws past the
  // top edge, the same licence blocks in flight already have.
  bindHover(canvas, st);
  st.restTiles = tiles;          // resting footprints, for the pointer
  st.gridW = Math.max(1, laid ? (opts.gridW ?? opts.resolution) : opts.resolution);
  st.gridH = laid ? Math.max(1, opts.gridH ?? st.gridW) : st.gridW;
  st.gridN = st.gridW;
  // where one block's worth of vbytes ends, as a row on this grid: the
  // template line, kept meaningful now that the grid is the whole pool
  st.blockRows = opts.blockVbytes > 0 && packed.vbytesPerUnit > 0
    ? Math.min(st.gridN, Math.round((1000000 / packed.vbytesPerUnit) / Math.max(1, packed.gridWidth)))
    : 0;

  const now = (globalThis.performance && performance.now()) || 0;
  // STILL, by request as well as by preference (Tetrust, 2026-09-12: "Treat as groupings of blocks
  // making up a shape that move in unison. not drop at different rates. This is a different
  // application of our engine"). The choreography schedules every tile on its own -- a stagger of
  // seconds between one cube's drop and the next is the whole point of the block board's
  // reshuffle -- so a tetromino handed to it came down one cell at a time. A still board is drawn
  // AS LAID, every frame, with nothing planned: a piece moves as one shape because nothing moves
  // it, the frame simply changes.
  const still = reducedMotion() || opts.still === true;

  // THE BUG THIS GUARDS (2026-09-10, operator: "redrawn instead of ...
  // smoothly moving"): mining.js calls this on every fast-tier paint, about
  // once a second. Re-planning on each call cancelled the running rAF and
  // started a fresh 5.4 s choreography from the CURRENT positions, so the
  // transition never got past its first second and the picture looked like a
  // redraw. A plan is only made when the layout actually differs; otherwise
  // the in-flight animation is left alone to finish.
  const sig = tiles.map((t) => `${t.txid}:${t.x},${t.y},${t.s}${t.tall != null ? `^${t.tall}${t.color}` : ''}${t.floor != null ? `_${t.floor}` : ''}`).join('|');
  // how it is DRAWN, not what is drawn: the display settings (settings.js). A change here has to
  // reach the board without waiting for the next poll, and without setting every block flying.
  // The sky belongs in here too. It was missing, so every star control was a latent dead control:
  // the field is cached on density and shape (drawStars), and nothing asked for a repaint when
  // either changed -- the galaxy toggle and both sliders would have sat there doing nothing until
  // some unrelated poll happened to replan the board, which reads exactly like a broken switch.
  const optSig = [opts.shadows !== false, opts.edges !== false, opts.grid !== false, !!opts.space,
    starsOn(opts),
    opts.seamAlpha, opts.facetPx, opts.crownPx, opts.dome, opts.idleFx !== false,
    opts.starDensity, opts.starBrightness, opts.galaxy === true, opts.galaxyAt,
    opts.nebulae !== false, opts.galaxies !== false, opts.dust !== false, opts.clusters !== false,
    opts.starColours !== false, opts.starGlints !== false,
    opts.neon === true, opts.sheen === true, opts.overheadLight === true, opts.light,
    opts.neonSource, opts.neonColour, opts.neonBrightness, opts.wireWidth,
    opts.transition ? `${opts.transition.rise}/${opts.transition.travel}/${opts.transition.drop}` : 'default'].join('|');
  const lookChanged = st.optSig !== undefined && st.optSig !== optSig;
  st.optSig = optSig;
  const unchanged = sig === st.sig && !lookChanged;
  // `still` governs the TILES, never the SKY (2026-09-12, operator: "why can't we get the galaxy
  // smoothly animating in the background for tetrust?" -- measured: zero repaints in three
  // seconds, frozen, not slow). A still board skipped this cheap path, and the park below
  // returned before requestAnimationFrame, so a board that asked for no choreography also got no
  // twinkle and no galaxy spin: it repainted only when its page happened to call board3d again.
  if (unchanged && st.plan && (!still || starsOn(opts))) {
    if (st.raf == null && (st.dirty || starsOn(opts) || !frameAt(st.plan, now, { unit: opts.unit, zUnit: opts.zUnit, vanishX: st.gridW * opts.unit / 2, vanishY: -st.gridH * opts.unit / 2, persp: opts.persp }).settled)) st.wake?.();
    return { tiles, settled: now >= st.plan.settleAt, yaw: st.yaw, replanned: false };
  }

  // A NEW LAYOUT WAITS FOR THE RUNNING ONE TO LAND (2026-09-11, with the
  // transition at 40 s). Replanning mid-flight starts the new plan from the
  // previous TARGETS, so every block in the air would jump to where it was
  // going and set off again. The newest layout is parked and planned the
  // moment the current one settles; a still newer one simply replaces it.
  //
  // ...AND IT NOW WAITS FOR THE RUNNING EFFECT TOO (operator, 2026-09-13: "for the block space
  // panel, we need to defer a refresh until the active effect has finished its sequence").
  // Accepting a layout does `st.fx = null` below -- a transition takes the stage -- so a refresh
  // arriving mid-effect cut the effect off wherever it had got to. On this board that was most of
  // them: the pool refreshes on a timer, the signature changes, and effects run 3.2-7.4 s. The
  // scheduler's own comment already recorded the damage from the other side ("a 7 s pulse is
  // interrupted nearly every time it is chosen").
  //
  // TWO LIMITS, so this cannot become its own bug:
  //   - only a TILE change waits. A look change (a switch flipped in settings) still applies at
  //     once, because a control that appears dead for seven seconds is worse than an interrupted
  //     effect. That is why this tests `sig !== st.sig` rather than `!unchanged`.
  //   - it waits at most FX_DEFER_MAX. fxNow is bounded by the effect's own `ms`, so an effect
  //     always ends on its own; the cap is there so that a bug in an effect cannot freeze the
  //     data on screen indefinitely. Deferring is a courtesy to the animation, never a reason to
  //     show stale figures for ever.
  //
  // Nothing can overtake the parked layout: scheduleFx treats a pending render as `busy` and
  // re-arms its timer instead of starting another effect, so an effect cannot chain ahead of a
  // refresh that is already waiting.
  const fxHolding = !!fxNow(st, now) && sig !== st.sig
    && (st.pendingAt == null || now - st.pendingAt < FX_DEFER_MAX);
  if (!unchanged && st.plan && !still && st.raf != null && (now < st.plan.settleAt || fxHolding)) {
    st.pending = { cells, options };
    st.pendingAt ??= now;
    return { tiles: st.prev, settled: false, deferred: true };
  }
  st.pending = null;
  st.pendingAt = null;
  st.atRest = false;                       // a new layout: the next settle arms the next effect

  // The FIRST paint never animates. With arrivals no longer drawn until they
  // fall, a first render treated as "everything is arriving" would leave the
  // board empty until the drop phase -- twenty-five seconds of blank canvas.
  // Nothing was there before, so nothing has moved.
  const firstPaint = !st.prev.length;
  // a look change on the same tiles is not a transition: land it where it already is
  const lookOnly = lookChanged && sig === st.sig;
  const plan = (still || firstPaint || lookOnly)
    // gridN matters even for a no-op plan: the camera constant is derived
    // from it, and a first paint on a different camera than every later
    // frame is exactly the load-time artefact this guards.
    ? planTransition(tiles, tiles, { now, gridN: st.gridN, maxGrowth: opts.edgeMargin, ...(opts.transition || {}) })
    : planTransition(st.prev, tiles, { now, gridN: st.gridN, maxGrowth: opts.edgeMargin, ...(opts.transition || {}) });

  st.prev = tiles;
  st.sig = sig;
  st.plan = plan;
  st.fx = null;              // a transition takes the stage; idle effects wait for rest

  if (st.raf != null && globalThis.cancelAnimationFrame) cancelAnimationFrame(st.raf);
  st.raf = null;

  const geom = sizeCanvas(canvas, Number.isFinite(opts.maxDpr) ? Math.max(0.5, opts.maxDpr) : Infinity);
  // Device pixels per grid unit, from the CONSTANT board transform (pw across
  // gridW units), so a stone's level of detail can never flicker mid-flight.
  const pxPerUnit = geom.pw / Math.max(1, st.gridW);
  const draw = (t) => {
    const view = {
      unit: opts.unit, zUnit: opts.zUnit, risePerUnit: st.plan?.cfg?.risePerUnit,
      // the camera: where the vanishing point sits, as fractions of the board
      // (0.5, 0.5 is straight overhead, as it always was), and how far the
      // surface domes toward the viewer (0 = flat). Both are options so the
      // placements can be compared on the same data before one is chosen.
      vanishX: st.gridW * opts.unit * opts.vanish.fx, vanishY: -st.gridH * opts.unit * (1 - opts.vanish.fy), persp: opts.persp,
      boardW: st.gridW * opts.unit, boardH: st.gridH * opts.unit, dome: opts.dome, gridW: st.gridW, gridH: st.gridH,
      seamAlpha: opts.seamAlpha, fx: fxNow(st, t), oblique: opts.oblique, now: t, light: opts.light, order: opts.order, hoverGlow: glowMap(st, t),
      // the departure path (settings.js space.departures): it reaches the geometry AND the paint
      // order through the same view object, which is the only way those two can agree
      departures: opts.departures,
      facetMinUnits: opts.facetPx / pxPerUnit, crownMinUnits: opts.crownPx / pxPerUnit,
      shadows: opts.shadows !== false,   // settings.js: the board can be drawn without them
      // the finishes (settings.js space.neon / space.sheen). They were in the look signature and
      // in buildScene from the first cut, but not HERE, so a flipped switch repainted the same
      // picture (2026-09-12: "I don't see neon blocks working, nor the metallic sheen")
      neon: opts.neon === true, sheen: opts.sheen === true,
      overheadLight: opts.overheadLight === true,   // the lamp straight above (Tetrust)
      light: opts.light,                            // or wherever settings.js space.light puts it
      neonSource: opts.neonSource, neonColour: opts.neonColour, neonBrightness: opts.neonBrightness,
      wireWidth: opts.wireWidth,
      // the paint order's memory across frames (blockscene3d obliqueOrder): a tangle keeps the
      // relative order it had last frame, so nothing flickers in and out of one
      orderMemo: (st.orderMemo ??= new Map()),
    };
    // the panel's extent in grid units, from the same constant fit paintFrame
    // uses: the textured sphere is laid over all of it (drawGrid), and an
    // arrival starts wholly outside it (offscreenLift)
    if (opts.oblique) view.viewRect = obliqueFit(geom.pw, geom.ph, st.gridW, st.gridH, opts).rect;
    const frame = frameAt(st.plan, t, view);
    paintFrame(ctx, geom, frame, opts, view, st.gridW, st.blockRows, st.gridH);
    st.lastFit = frame.__fit ?? st.lastFit;
    st.lastOps = frame.ops;
    st.settled = frame.settled;
    st.dirty = false;
    return frame;
  };

  const step = () => {
    const t = (globalThis.performance && performance.now()) || 0;
    // THE SKY keeps the loop alive for the twinkle -- about 24 frames a second once the board is
    // still -- and stops it while the canvas is hidden (another tab of the app); the next
    // render3d call wakes it (see the unchanged-layout branch). It is the STARS that need the
    // repaint, not the board style, so a space-styled board with the sky off parks like any other.
    if (starsOn(opts)) {
      // ABSENT COUNTS AS HIDDEN, and this is the sky loop's only exit: 2218 re-arms when the
      // frame is throttled, 2242 re-arms otherwise, and the park at 2234 is gated behind
      // !starsOn -- so a starry board that cannot answer "am I visible?" never unwinds. The
      // strict `=== false` / `=== null` form could only fire where the properties exist, and
      // the day space.stars shipped ON by default that turned an unreachable branch into an
      // infinite one (renderMining: Maximum call stack size exceeded, wherever rAF runs inline
      // rather than deferring to a real frame). In a browser this is a no-op: isConnected is
      // always a boolean and offsetParent always an Element or null.
      if (!canvas.isConnected || !canvas.offsetParent) { st.raf = null; return; }
      if (st.settled && !st.dirty && !st.pending && !fxNow(st, t) && t - (st.lastPaint ?? 0) < 33) { st.raf = requestAnimationFrame(step); return; }
      st.lastPaint = t;
    }
    const frame = draw(t);
    // THE FLUSH WAITS FOR THE EFFECT AS WELL. `frame.settled` is about the TRANSITION, not the
    // effect, so without the fxNow test this let a parked refresh through the moment the board
    // landed -- cutting the effect off exactly as before. It is also the live path: stars ship on
    // by default, so this is the branch a real board takes, and guarding only the entry above
    // would have looked correct and done nothing.
    if (starsOn(opts) && frame.settled && st.pending && !fxNow(st, t)) { const p = st.pending; st.pending = null; st.pendingAt = null; st.raf = null; render3d(canvas, p.cells, p.options); return; }
    // keep the loop alive while the choreography runs OR the camera is moving;
    // park otherwise, because repainting a still picture is a heater
    if (frame.settled && !st.dirty && !fxNow(st, t)) {
      // the board is at rest: arm the next effect whether or not the loop is about to park --
      // but ONCE, on the frame it arrives, or a running loop would re-arm the timer for ever
      if (!st.atRest) {
        const afterEffect = st.fx != null;   // an effect just ended -- or it has only now settled
        st.fx = null;
        st.atRest = true;
        scheduleFx(canvas, st, opts, !afterEffect);
      }
      if (!starsOn(opts) && !glowAnimating(st, t)) {
        st.raf = null;
        if (st.pending) { const p = st.pending; st.pending = null; st.pendingAt = null; render3d(canvas, p.cells, p.options); return; }
        return;
      }
      if (st.pending) { const p = st.pending; st.pending = null; st.pendingAt = null; st.raf = null; render3d(canvas, p.cells, p.options); return; }
    }
    else st.atRest = false;               // something is moving again: the next rest re-arms
    st.raf = requestAnimationFrame(step);
  };
  st.wake = () => {
    if (st.raf == null && globalThis.requestAnimationFrame) st.raf = requestAnimationFrame(step);
  };

  const first = draw(now);
  if (first.settled) { st.atRest = true; scheduleFx(canvas, st, opts, true); }   // at rest already, stars or not
  // Park when nothing is moving: a settled board, or one that asked for no choreography at all.
  // Stars are motion in their own right, so a sky keeps the loop whatever the tiles are doing.
  if (!globalThis.requestAnimationFrame || (!starsOn(opts) && (still || first.settled))) {
    return { tiles, settled: true };
  }
  st.raf = requestAnimationFrame(step);
  return { tiles, settled: false };
}

export function block3d(canvas, visual, economy, options = {}) {
  const weightLimit = options.weightLimit ?? 4000000;
  return render3d(canvas, visual?.cells ?? [], { ...options, blockVbytes: weightLimit / 4 });
}

// The pool scales to the POOL, not to a block. Measured 2026-09-10: a 3.4 MB
// pool drawn against a 1 MB block packs 44 wide by ~140 tall, which in
// isometric is a long thin diamond. Scaling to the pool's own total makes the
// grid square at any resolution. The cost, stated rather than hidden: a pool
// tile is then not comparable in size with a block tile.
export function mempool3d(canvas, dist, options = {}) {
  const block = options.blockVbytes ?? DEFAULTS.blockVbytes;
  const cells = takeOneBlock(dist?.cells ?? [], block);
  return render3d(canvas, cells, { ...options, blockVbytes: block });
}

export { TRANSITION, SLAB_H };

// THE BOARD FOR OTHER DATA (operator, 2026-09-11: "leverage the 3D view we have established with
// the block space panel ... If we're going to render a price chart, it would be good to see it on
// a similar grid structure, with similar effects, just tasked to show market data ... We should be
// flexible with how we can use that 3D view"). The same sphere, neon grid, cubes, shadows,
// choreography and idle effects; the caller lays the tiles out itself on a gridW x gridH board:
//   { txid (a stable id -- the same id is the same tile, so it moves rather than re-arrives),
//     x, y, s (footprint side), tall (height; default s), color (#rrggbb), label (hover text) }
export function board3d(canvas, tiles, options = {}) {
  return render3d(canvas, null, { ...options, laid: tiles ?? [] });
}
