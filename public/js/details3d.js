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
import { planTransition, frameAt, fitToBox, project, fxFront, TRANSITION, SLAB_H, TILE_H, surfaceNormal, cellTops, fxHash } from './blockscene3d.js';
// THE AGENTS (agents.js): the effects that are something happening rather than a pattern.
// This module keeps three seams and nothing else -- build here in startFx, frame in fxNow,
// draw in paintFrame -- so fifty agents do not become fifty `if`s in the renderer.
import { AGENTS, isAgent, rng, lensFlare, saucerAbove } from './agents.js';
import { drawLivingSky } from './livingsky.js';
import { drawGalaxyForm } from './galform.js';
import { formGlAttach, formGlSupported } from './formgl.js';
import { drawGalaxyFlight } from './galflight.js';
import { createGl2d, gl2dSupported } from './gl2d.js';
import { loadSettings } from './settings.js';

const STATE = new WeakMap();
// The Formation's WebGL layer, one per 2D context: the GL canvas rides over the board's own
// canvas and is created lazily on the first frame this sky draws (formgl.js). Cleared when
// the sky changes -- see switchSky in the options block below.
const FORM_GL = new WeakMap();
const FORM_DEAD = new WeakSet();          // contexts whose Formation layer declined: the 2D fallback from then on
// A CANVAS LAID DIRECTLY UNDER ANOTHER, for a GL layer (a 2D and a GL context cannot share an
// element). "Directly" is the point: it goes in the SAME stacking layer as `el`, immediately
// before it in the document, so document order alone puts it beneath -- and nothing else on the
// page changes places. Raising `el` with a z-index instead was tried for the Formation and is
// wrong in general: Tetrust's sky canvas, lifted over its siblings, would sit (transparent, but
// taking every click) on top of the well, the title and the play button. It is glued to el's own
// BOX (glueUnder, every frame), never inset:0 of the parent: a parent can be a whole page section
// (operator, 2026-09-21, of the first cut: "It's drawing on top of the price chart"), and it
// copies el's CSS transform, which Scorched Yard's canvases carry.
function layerUnder(el) {
  const c = document.createElement('canvas');
  const cs = getComputedStyle(el);
  if (cs.position === 'static') el.style.position = 'relative';   // positioned, so document order decides
  c.style.position = 'absolute';
  c.style.pointerEvents = 'none';
  c.style.zIndex = cs.zIndex;
  if (cs.transform && cs.transform !== 'none') { c.style.transform = cs.transform; c.style.transformOrigin = cs.transformOrigin; }
  (el.parentElement || el).insertBefore(c, el);
  return c;
}
function glueUnder(c, el) {
  c.style.left = `${el.offsetLeft}px`; c.style.top = `${el.offsetTop}px`;
  c.style.width = `${el.offsetWidth}px`; c.style.height = `${el.offsetHeight}px`;
}
function dropFormGl(ctx) {
  const st = FORM_GL.get(ctx);
  if (!st) return;
  if (ctx.canvas?.style) { ctx.canvas.style.background = st.bg; ctx.canvas.style.position = st.pos; }
  st.canvas.remove();
  st.ctl?.dispose();
  FORM_GL.delete(ctx);
}

// THE TWO RENDERERS (2026-09-21; operator: "a second rendering option to blockyard for WebGL
// rendering, and port all existing effects over to the new system. Supporting either WebGL or
// Software rendering"). Everything in this file draws through the context paintFrame is handed,
// so the choice is made in exactly one place -- surfaceFor, below -- and what it returns is either
// the board canvas's own 2D context (Software, as it always was) or gl2d.js's look-alike on a
// WebGL2 canvas laid UNDER the board canvas (a 2D and a GL context cannot share an element). The
// board canvas stays where it is, transparent, and keeps the pointer: hover and clicks never
// learn which renderer drew the frame.
//
// The choice is appearance.renderer in settings.js, read through loadSettings (memoised on the
// stored string) every frame so the switch is live; `options.renderer` overrides it for a canvas
// whose PIXELS are read back by its owner (Scorched Yard's land and sky), which only the 2D
// canvas can answer. No WebGL2, a failed compile or a lost context is Software, silently and for
// good on that canvas: a board must never be blank because a GPU was blocklisted.
export const RENDERERS = Object.freeze(['software', 'webgl']);
const GL_LAYER = new WeakMap();           // the board canvas -> its GL layer
export function rendererOf(opts) {
  let want = opts?.renderer;
  if (want !== 'software' && want !== 'webgl') { try { want = loadSettings().appearance.renderer; } catch { want = 'software'; } }
  return want === 'webgl' ? 'webgl' : 'software';
}
function dropGlLayer(canvas) {
  const L = GL_LAYER.get(canvas);
  if (!L || !L.ctx) return;
  dropFormGl(L.ctx);
  L.ctx.dispose();
  L.ctx = null;
  L.canvas.remove();
  canvas.style.background = L.bg; canvas.style.position = L.pos;
}
/** The context this frame draws on: the GL look-alike when WebGL is chosen and works, else `ctx2d`. */
function surfaceFor(canvas, ctx2d, geom, opts) {
  let L = GL_LAYER.get(canvas);
  const wantGl = rendererOf(opts) === 'webgl' && !L?.gone && typeof document !== 'undefined' && !!canvas.style && !!canvas.parentElement && gl2dSupported();
  if (!wantGl) {
    if (L?.ctx) dropGlLayer(canvas);
    return ctx2d;
  }
  if (!L || !L.ctx) {
    L = { canvas: null, ctx: null, gone: false, bg: canvas.style.background, pos: canvas.style.position };
    GL_LAYER.set(canvas, L);
    // the layer goes directly under the board canvas (layerUnder), and the board canvas lets go
    // of its CSS background (app.css paints one): a canvas's clear pixels show ITS background,
    // not what is behind the element
    L.canvas = layerUnder(canvas);
    // (a shader that will not compile falls back by itself, and SILENTLY -- right for a user, wrong for whoever
    // wrote the shader. The log goes to the console, and to a list a test page can put on the window.)
    L.ctx = createGl2d(L.canvas, { onLost: () => { L.gone = true; }, onCompileError: (log) => { try { globalThis.__blockyardGlErrors?.push(String(log)); console.warn?.(`[blockyard] WebGL: ${log}`); } catch { /* a log must not break a frame */ } } });
    if (!L.ctx) { L.gone = true; L.canvas.remove(); canvas.style.position = L.pos; return ctx2d; }
    dropFormGl(ctx2d);                       // the Formation's overlay re-attaches under the GL canvas
    canvas.style.background = 'transparent';
    // what Software last painted must not sit over the GL frame
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (L.gone) { dropGlLayer(canvas); return ctx2d; }
  const gc = L.canvas;
  if (gc.width !== geom.pw) gc.width = geom.pw;
  if (gc.height !== geom.ph) gc.height = geom.ph;
  glueUnder(gc, canvas);
  // the finish only this renderer has (gl2d.js POST_FS): bloom and dither, by appearance.glow
  let glow = opts.glow;
  if (!(glow >= 0)) { try { glow = loadSettings().appearance.glow; } catch { glow = 0; } }
  L.ctx.bloom = glow;
  return L.ctx;
}
// ---- THE FRAME RATE (operator, 2026-09-21: "we need to add an option to show FPS in the top right
// corner of the display in any 3D view"). What is counted is FRAMES THIS CANVAS ACTUALLY PAINTED in
// the last second -- so a board at rest under a sky reads its resting cadence (about 30), and a
// parked board with no sky, which paints nothing, keeps the last figure it earned. Beside it, the
// processor's share of a frame (building and submitting it; the graphics card's own time is not
// visible from here) and which renderer drew it. The figure changes twice a second, not every frame.
const clockMs = () => (globalThis.performance?.now ? performance.now() : 0);
export function fpsWanted(opts) {
  if (opts?.showFps === true || opts?.showFps === false) return opts.showFps;
  try { return loadSettings().appearance.showFps === true; } catch { return false; }
}
/** Count this frame; answers the text to show. Pure but for `st.fps`. */
export function fpsTick(st, t, ms) {
  const f = (st.fps ??= { times: [], ms: 0, text: '', at: -1e9 });
  f.times.push(t);
  while (f.times.length && t - f.times[0] > 1000) f.times.shift();
  f.ms = f.ms ? f.ms * 0.9 + ms * 0.1 : ms;
  if (t - f.at >= 500 || !f.text) { f.at = t; f.text = `${f.times.length} fps  ${f.ms.toFixed(1)} ms`; }
  return f.text;
}
function drawFps(ctx, geom, text, renderer) {
  if (typeof ctx.fillText !== 'function' || typeof ctx.save !== 'function') return;
  const { pw, dpr } = geom, k = dpr || 1, label = `${text}  ${renderer}`;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.emissive = false;                                     // (the GL renderer's bloom: a readout is read, not lit)
  ctx.font = `${Math.round(11 * k)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'top';
  const w = (ctx.measureText?.(label)?.width ?? label.length * 7 * k), pad = 5 * k, m = 6 * k, h = 11 * k;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(pw - m - w - pad * 2, m, w + pad * 2, h + pad * 2);
  ctx.fillStyle = 'rgba(170,255,210,0.95)';
  ctx.fillText(label, pw - m - pad, m + pad);
  ctx.restore();
  ctx.emissive = true;
}

/** Which renderer drew this canvas's last frame ('webgl' | 'software'), for the panel and the tests. */
export function rendererIn(canvas) { return GL_LAYER.get(canvas)?.ctx ? 'webgl' : 'software'; }
/** The GL renderer's running counts on this canvas (draw calls, vertices, stencil passes, frames), or null. */
export function rendererStats(canvas) { const c = GL_LAYER.get(canvas)?.ctx; return c ? { ...c.stats } : null; }

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
// plays (see fxAt in blockscene3d.js), chosen at random and never one played
// within the no-repeat window (chooseIdleFx). The loop wakes for the effect and parks again, so a still
// board costs nothing between them. Only with a real DOM (the unit harness and
// the DOM stub never get one), never under prefers-reduced-motion, never while
// a transition runs, and it retries later while the board is not on screen.
// THE THIRTY -- twenty-six at the time (operator, 2026-09-12: "Think of many more other video-game inspired effects ...
// at least 25 total different effects, all toggleable"). Nine were here; seventeen more live in
// fxAt (blockscene3d) as pure per-tile functions. Each is one entry here -- how long it runs --
// and one toggle in settings.js (the `effects` and `marketEffects` groups), and the lists are checked against each other
// by a test, so an effect cannot ship without a switch or a switch without an effect.
const FX_MS = {
  ripple: 5200, outline: 4400, tide: 5200, cascade: 5600, twinkle: 3800, scan: 8400,   // 8400 -> 16800 when the top-down scan panned OUT AND BACK; one pass again (2026-09-20), so 16800 -> 8400 -- the duration follows the span
  xray: 6500,                                  // the board goes x-ray behind a sweeping front, and develops back
  lightcycle: 6500, ball: 5600, pulse: 9000,   // pulse 7000 -> 9000 (2026-09-14: "make it a bit slower")
  bulge: 16000,                                // a sphere rolling through the price line; half speed (was 8000)
  breathe: 9000,                               // the price line breathes: three slow swells between the wire and the pulse's heat
  saber: 8000,                                 // the price line ignites as a light saber, hums, and retracts
  blackhole: 26000,                            // the chart collapses into a black hole and is let go again
  shockwave: 4200, nova: 5200, firework: 5600, flare: 16000, wave: 6000, quake: 3200,   // flare 3600 -> 8000 -> 16000 (2026-09-15: it is a supernova now, and the cloud disperses slowly)
  rain: 6400, sparkle: 4600, checker: 4400, radar: 6000, vortex: 6400, powerup: 5000, combo: 4800, aurora: 7200, plasma: 6400,
  pulsar: 26000,                               // a passage through a stellar wind, in four acts (XRISM / BP Crucis, NASA SVS 15099) -- long, like the black hole, because the story needs the time
  // THE AGENTS (agents.js): effects that are a thing MOVING rather than a pattern over the board.
  // Longer than the fields, because something that travels needs time to be watched -- a field
  // reads at a glance, an agent has to arrive, do something, and leave.
  // Most of these were removed on the operator's call after seeing them on the board. The seven
  // that stayed are the ones worth the second animation loop: two riders (lightcycle, ball), a
  // splitter, a thief, an interception, a collapse and a gateway. The count is deliberately not
  // written as a number here -- it went stale twice as effects were culled.
  // tractor 6800 -> 8000 (2026-09-14): the drop is timed by real gravity now and needs the room
  centipede: 7400, tractor: 8000, missile: 7400,
  // stormball replaced portal (2026-09-14); slow on purpose -- it drifts across the whole view
  boulderdash: 6400, stormball: 11000,};
export const FX_KINDS = Object.keys(FX_MS);
/** How long an effect runs on the block board, in ms (the price board's own lengths are MARKET_MS). */
export const fxMs = (kind) => FX_MS[kind] ?? 0;
// the price board's own lengths, where they differ: ball lightning crosses it at a third of the
// block board's speed -- 11 s there; a third slower (16.5 s, operator 2026-09-15: "cut the speed
// by 33% now that it's slower"), then 40% slower again (27.5 s: "Slow it down movement by 40%")
// THE DURATION FOLLOWS THE SPAN, or widening the travel speeds up the picture (operator,
// 2026-09-15: "why does it transit the market view so quick? I didn't ask for that"). When the
// sweep was made to start and end beyond the panel, the distance grew but the clock did not, so
// the part you actually watch -- the crossing of the board -- got 1.52x faster on Markets and
// 1.40x on Block space. These restore the crossing to the speed it had: measured, 9145 ms and
// 8400 ms for the two boards. Markets needs the longer one because its panel is wide and its board
// is shallow, so proportionally more of the journey happens off-screen.
// ...and then slower still on Markets (operator, 2026-09-15: "It's still way too fast on the
// markets display. Slow it down at least 50%"). 9150 restored the pacing the effect had BEFORE the
// travel change, which turns out not to have been slow enough either -- restoring a speed is not
// the same as it being right. 14600 makes the on-screen crossing 8451 ms against 5297, i.e. 60%
// slower, which clears the "at least 50%" asked for.
// AN EFFECT'S SIZE ON A SMALL BOARD (2026-09-15, the Kiosk): a radius in grid units, capped at a
// share of the board's width, so the same effect on a small panel never covers it
export function boundedRadius(units, share, gridW) { return Math.min(units, share * gridW); }
// effects that read as the same thing: never one right after the other
const FX_KIN = { scan: ['tractor'], tractor: ['scan'] };
export const MARKET_MS = { stormball: 27500, firework: 14000, flare: 24000, scan: 29200 };   // and a fireworks display of five shells, each with its smoke, needs the time
// The longest a refresh will ever wait for an effect to finish, plus a second of slack. Taken from
// the table rather than written as a number, so culling or adding an effect cannot leave the cap
// shorter than the effect it is meant to outlast. See the deferral in render3d.
const FX_DEFER_MAX = Math.max(...Object.values(FX_MS)) + 1000;
// A BREATH BETWEEN AN EFFECT AND THE REFRESH IT HELD BACK (operator, 2026-09-15, of the black
// hole: "snapping into place on last frame to drop in"): the parked layout took the stage on the
// very frame the effect ended, so the board's cubes were seen arriving home and, in the same
// instant, lifting off for the refresh -- one motion read as the other's last frame. The layout
// now waits a moment and a half after the effect, with the board whole and still
const FX_REST_MS = 1500;
const fxResting = (st, t) => st.fxEndedAt != null && t - st.fxEndedAt < FX_REST_MS;
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
// THE BEAM'S AIM (operator, 2026-09-20: "I want the ufo scanner panning back and forth
// perpendicular to it's line of travel, to the extend of each side of the board and back", then,
// of the craft: "The saucer stays in it's movement position ... the saucer always flies through
// the vertical or horizontal center of the grid"). The front keeps its single straight pass down
// the board's centreline; the beam it throws swings along the front's OWN axis -- perpendicular
// to travel -- from one side of the board to the other and back, one full swing per pass,
// sine-eased so it rests a moment at each edge. The seed only chooses which side is visited
// first. The signed offset in grid units rides on the effect record: fxAt lights the tiles under
// the panned pool and drawScanCurtain aims cone, pool and sparks with it, so light and geometry
// cannot disagree. The price board's curtain stays centred (fxNow never sets scanPan there).
export function scanPanOf(u, dx, dy, gridW, gridH, seed = 0) {
  const ax = -dy, ay = dx;                                         // along the front line
  const span = gridW / 2 * Math.abs(ax) + gridH / 2 * Math.abs(ay); // centreline to the board's side
  const side = hash01(seed + 91) < 0.5 ? 1 : -1;
  return side * Math.sin(u * Math.PI * 2) * span;
}
// A SINE TABLE, for the one place in this file that needs tens of thousands of them a frame: the
// pulsar's wind advects fifteen thousand particles through a two-octave curl field, which is eight
// trig calls each. Linear interpolation between 2048 samples is visually exact for a flow field
// (the error is under a thousandth) and several times quicker. Nothing else should need this --
// everywhere else in here, Math.sin is called a few dozen times a frame and is perfectly fine.
const SIN_N = 2048, SIN_TAB = new Float64Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN_TAB[i] = Math.sin((i / SIN_N) * Math.PI * 2);
const TAU = Math.PI * 2;
function fastSin(t) {
  let u = (t / TAU) % 1;
  if (u < 0) u += 1;
  const f = u * SIN_N, i = f | 0, k = f - i;
  return SIN_TAB[i] + (SIN_TAB[i + 1] - SIN_TAB[i]) * k;
}
const fastCos = (t) => fastSin(t + Math.PI / 2);
// A board with a price line is not a grid to sweep across. The straight-front effects (outline,
// scan, tide), the light cycles and the lightning ball all travel the FLOOR, which on the candle
// board is empty space -- which is what "through space on an invisible grid" describes. Where a
// line exists, the effects that run are the ones with something to run along.
// ...and ball lightning crosses the price board too (operator, 2026-09-14: "Add rare ball lightning
// travelling the 3D Markets from one side to the other and electrifying any elements it comes
// near. Same rarity as the other effects for the markets")
// LIGHT CYCLES AND THE LIGHTNING BALL RIDE THE CANDLE GRID TOO (operator, 2026-09-14: "Lightcycles
// don't work anymore on the market view" -- the line-only list had cut them, while the Markets
// switch still promised them)
// EVERY EFFECT PLAYS ON THE PRICE BOARD except the two that ALTER the board (operator, 2026-09-14:
// "a lot of effects that don't work on the market display"): the fields are light patterns over
// tiles and light candles as well as cubes; boulder dash collapses tiles and the tractor beam
// lifts one, and a candle is a price, not a thing to move. The line effects stay the board's own.
// THE MARKETS LIST IS THE TWELVE THAT TRANSLATE (operator, 2026-09-14: "I think the selection I
// have made for the market effects is what we should ship with, and remove all the unchecked
// options from selection. Many of the effects don't translate over to the market chart"). The
// board is eight units deep and as wide as the hours: what works on it runs along the hours
// (the fronts, the wave), spreads from the candle row (ripple, the bursts), lights candles
// where they stand (cascade, twinkle, the flare), or is the price line's own (pulse, bulge, ball
// lightning). The rest -- riders and walkers, the field patterns, anything that falls down the
// depth or turns in place, anything that moves a tile -- stays on the block board.
const ON_CANDLES = new Set(['ripple', 'outline', 'tide', 'cascade', 'twinkle', 'scan', 'xray', 'pulse', 'bulge', 'breathe', 'saber', 'blackhole', 'firework', 'flare', 'wave', 'stormball', 'pulsar']);
/**
 * THE PULSAR'S PASSAGE, AS A HEIGHT AT EACH END (a pure function, so the two things that have
 * gone wrong with it are testable rather than eyeballed -- test/effects.test.js holds both).
 *
 * `h6`/`h7` are the two ends, `h8` picks the lane. Three lanes, because a passage that always
 * ran inside the price line's own range bent the line every single time and made the bend the
 * rule rather than the occasion (operator, 2026-09-20: "Don't always have it moving so close to
 * the line"): a third go through the band, most pass clear above it, the rest skim below.
 *
 * AND EVERY ONE IS CLAMPED INTO THE BOARD'S OWN HEIGHT (operator, the same day: "Don't have the
 * pulsar off-screen ... Always make sure it's travelling inside the viewport"). The lanes are
 * measured in multiples of the LINE's range, which says nothing about where the panel ends -- on
 * a chart with a tall price range the high lane went clean off the top. `zTop` (the top of the
 * price axis, what the board fits to the panel) is the ceiling, less a margin for the star's own
 * halo; the floor keeps it above the deck. The lane is as far from the line as there is room for
 * and no further.
 */
export function pulsarHeights(lo, hi, zTop, h6, h7, h8) {
  const R = Math.max(1, hi - lo);
  const top = Number.isFinite(zTop) ? zTop : hi + R;
  const floor = 0.8, ceil = Math.max(floor + 1, top * 0.82);
  const clamp = (v) => Math.max(floor, Math.min(ceil, v));
  const loC = clamp(lo), hiC = clamp(hi);
  // EACH LANE IS MEASURED IN THE ROOM IT ACTUALLY HAS, not in multiples of the line's range.
  // Measured against the range and then clamped, every high passage on a chart whose prices fill
  // its axis landed on the ceiling and flew dead flat at the same height; spread through the
  // headroom instead, they vary as much as the panel allows, which on a full chart is a little
  // and on a quiet one is a lot.
  // A LANE NEEDS ROOM TO BE A LANE. On the Markets board the price band fills most of its axis
  // (zBase 6, zMax 28), so above the line there is often nothing left once the ceiling takes its
  // margin -- and a lane with no room collapses on to the ceiling and flies dead flat. When the
  // room is not there the passage takes the other side, and only falls back to crossing the line
  // when neither side has any.
  const enough = Math.max(1.5, R * 0.15);
  const roomAbove = ceil - hiC, roomBelow = loC - floor;
  let lane = h8 < 0.34 ? 'through' : h8 < 0.8 ? 'above' : 'below';
  if (lane === 'above' && roomAbove < enough) lane = roomBelow >= enough ? 'below' : 'through';
  if (lane === 'below' && roomBelow < enough) lane = roomAbove >= enough ? 'above' : 'through';
  const span = lane === 'through' ? [loC + (hiC - loC) * 0.15, hiC]
    : lane === 'above' ? [hiC + (ceil - hiC) * 0.15, ceil]
      : [floor, loC - (loC - floor) * 0.15];
  const at = (h) => clamp(span[0] + (span[1] - span[0]) * h);
  let za = at(h6), zb = at(h7);
  // A SKEW WORTH SEEING: two draws from the same band land close together as often as not, and a
  // passage that arrives and leaves at the same height is a horizontal rule across the panel. The
  // far end is pushed out to at least a third of the lane's span, on whichever side it already
  // favoured (2026-09-20, with the wander below: "a bit of vertical skew between the start and
  // end point").
  const wide = Math.abs(span[1] - span[0]);
  if (wide > 0.2 && Math.abs(zb - za) < wide * 0.33) {
    const away = zb >= za ? 1 : -1;
    zb = clamp(za + away * wide * 0.33);
    if (Math.abs(zb - za) < wide * 0.2) zb = clamp(za - away * wide * 0.33);   // the other way, at a wall
  }
  return { za, zb, lane, floor, ceil };
}
/**
 * WHERE THE PASSAGE IS AT `travel` (0 at the near edge, 1 at the far one). Inspired by the way
 * the lightning ball crosses -- it wanders rather than ruling a line (operator, 2026-09-20:
 * "Have it moving more like the lightning ball ... It always seems to move in a straight line").
 * Not the ball's own path: that one walks the grid and turns at cells, which on a chart would
 * read as a staircase. This is the straight run between the two ends with two slow swells laid
 * over it, enveloped to nothing at both ends so the arrival and the exit still happen where the
 * heights say, and clamped to the same bounds, so wandering can never carry it off the panel.
 */
/**
 * WHICH WAY THIS PASSAGE TURNS: +1 or -1, from the seed and from nothing else.
 *
 * It takes the seed ALONE on purpose (operator, 2026-09-20: "It should always spin in one
 * constant direction and never change direction"). Twice now the sign has been derived from
 * something that moves during the run -- first from whichever disk weighed more, then from a
 * deliberate flip at the halfway mark -- and both read as the wind changing its mind. A function
 * of the seed cannot drift, and the missing `u` parameter is the guard: making it change through
 * a run would mean changing this signature, which is a decision rather than an accident.
 */
export function pulsarSpin(seed) { return hash01(seed + 116) < 0.5 ? 1 : -1; }
export function pulsarZ(h, travel, h10 = 0.5, h11 = 0.5, h12 = 0.5, h13 = 0.5) {
  const base = h.za + (h.zb - h.za) * travel;
  // the room on the roomier side: a lane that hugs the ceiling has none above it, and sizing the
  // swell by the tighter side would leave those passages flying the ruled line the wander exists
  // to break. The result is clamped either way, so such a passage simply bows the one way it can.
  const room = Math.max(h.ceil - Math.max(h.za, h.zb), Math.min(h.za, h.zb) - h.floor);
  const amp = Math.max(0, Math.min(room * 0.75, (h.ceil - h.floor) * 0.16));
  if (amp <= 0.01) return base;
  const env = Math.sin(Math.PI * Math.max(0, Math.min(1, travel)));          // nothing at either end
  const w = Math.sin(travel * Math.PI * (1.4 + h10 * 1.2) + h11 * 6.283) * 0.72
    + Math.sin(travel * Math.PI * (2.9 + h12 * 2.2) + h13 * 6.283) * 0.28;
  return Math.max(h.floor, Math.min(h.ceil, base + amp * env * w));
}
// effects that are drawn on the price line and nowhere else: never offered to a board of blocks
// the black hole is back on the price board only (operator, 2026-09-15, after a day of it hovering
// over the block board: "still snapping into place. Just remove the black hole effect from block
// space if you can't fix it")
// the pulsar wind joined them on 2026-09-20 ("remove it from the block space view"): on a board
// of cubes the passage was a small bright knot crossing a big grid, and the gas it stirs has
// nothing to do with what the cubes are; on the chart it has the whole sky to cross
const LINE_ONLY = new Set(['pulse', 'bulge', 'breathe', 'saber', 'blackhole', 'pulsar']);
// EACH BOARD ITS OWN LIST (operator, 2026-09-14: "I want the markets tab to have a separate effects
// list ... the Block Space effects specific to that panel, and settings specific to market panel"):
// settings.js keeps one group of switches per list (`effects` for the block board, `marketEffects`
// for the price board), and test/effects.test.js holds each group to its list here.
export const SPACE_FX = FX_KINDS.filter((k) => !LINE_ONLY.has(k));
export const MARKET_FX = FX_KINDS.filter((k) => ON_CANDLES.has(k));
const DEREZ_MS = 800;   // how long a crashed light cycle takes to shatter and fade

/** A board with a price line: the Markets board (and Kiosk's), never the block board. */
export const onPriceBoard = (st) => (st?.axes?.line?.length ?? 0) > 1;
/** Which way a front (outline, scan, tide, wave) travels: any of seven ways on the block board; along the hours, either way, on the price board. */
export function fxDirection(kind, st, rnd = Math.random) {
  if (onPriceBoard(st)) return rnd() < 0.5 ? [1, 0] : [-1, 0];
  const dirs = kind === 'scan' ? [[0, 1], [0, -1], [1, 0], [-1, 0]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, -0.7071], [0.7071, -0.7071]];
  return dirs[(rnd() * dirs.length) | 0];
}
/** Where a ring (ripple, shockwave, nova) starts: anywhere on the block board; on the candles' own row on the price board, so it spreads along them. */
export function fxOrigin(st, rnd = Math.random) {
  const x = rnd() * st.gridW;
  if (onPriceBoard(st)) return { x, y: Number.isFinite(st.axes.y) ? st.axes.y : st.gridH / 2 };
  return { x, y: rnd() * st.gridH };
}

function startFx(st, kind, now) {
  const d = fxDirection(kind, st);
  const origin = fxOrigin(st);
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
  st.fx = { kind, t0: now, ms: (onPriceBoard(st) ? MARKET_MS[kind] : null) ?? FX_MS[kind] ?? 4500, x: origin.x, y: origin.y, dx: d[0], dy: d[1], rank, seed, agent,
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
  if (f.kind === 'scan' && !onPriceBoard(st)) out.scanPan = scanPanOf(u, f.dx, f.dy, st.gridW, st.gridH, f.seed);
  if (f.kind === 'ripple') {
    const reach = Math.hypot(Math.max(f.x, st.gridW - f.x), Math.max(f.y, st.gridH - f.y));
    Object.assign(out, { x: f.x, y: f.y, r: reach * (1 - Math.pow(1 - u, 2)), w: 2.2 + 2.4 * u });
  }
  // THE FIREWORKS LIGHT THEIR SURROUNDINGS IN THEIR OWN COLOUR (operator, 2026-09-15: "emissive
  // colored lighting illuminating the explosion area in the explosion color"): every live shell is a
  // head at its burst point, in its colour, as wide as the shell has spread, fading as it dies
  if (f.kind === 'firework') {
    const price = (st.axes?.line?.length ?? 0) > 1;
    const heads = [];
    for (const sh of fireworkShells(f.seed, st.gridW, st.gridH, price, 1, price ? (st.axes?.zTop ?? 34) : 16)) {
      const v = (u - sh.t0) / sh.life;
      if (!(v > 0.2 && v < 1.15)) continue;
      const s2 = Math.min(1, (v - 0.2) / 0.8);
      const spread = 1 - Math.exp(-3.4 * s2);
      heads.push({ x: sh.bx, y: sh.by, color: sh.cols[0], alpha: Math.pow(Math.max(0, 1 - s2), 1.2) * (v < 0.28 ? 1 : 0.85), r: (price ? 7 : 8) * sh.size * (0.5 + 0.9 * spread) });
    }
    out.heads = heads;
  }
  // THE BLACK HOLE (2026-09-15): where it sits on the chart, how big its horizon is this frame,
  // and -- through a head that HIDES -- which candles it has swallowed; the tiles near it glow the
  // disk's orange. Everything the renderer needs rides on `out.blackhole`.
  if (f.kind === 'blackhole' && st.axes?.line?.length > 1) {
    const line = st.axes.line;
    // IT CROSSES (operator, 2026-09-15: "get the black hole effect on the market display to slowly
    // move from one side to the other"): from a fifth of the way in on one side to a fifth from
    // the other, the way the front effects go (f.dx), easing in and out so it is still while it
    // opens and while it closes; the candles' orbits ride along with it
    // ...AND IT STOPS BEFORE IT LETS GO (operator, 2026-09-15: "the front faces of the lowest
    // blocks just snap into place instead of dropping"): the crossing ran to 0.9 while the release
    // began at 0.82, so a cube was let go not by the release curve but by the hole moving out of
    // reach of it -- dropped in a few frames as the hole passed. The crossing is done by 0.8 now,
    // and the release is the only thing that lets anything go
    const travel = u < 0.1 ? 0 : u > 0.8 ? 1 : (() => { const t = (u - 0.1) / 0.7; return t * t * (3 - 2 * t); })();
    const dir = (f.dx || 0) !== 0 ? Math.sign(f.dx) : hash01(f.seed + 5) < 0.5 ? 1 : -1;
    const xa = st.gridW * (dir > 0 ? 0.18 : 0.82), xb = st.gridW * (dir > 0 ? 0.82 : 0.18);
    const hx = xa + (xb - xa) * travel;
    let hy, hz, lo = 0, hi = 0;
    if (line) {
      // THROUGH SPACE, NOT ALONG THE LINE (operator, 2026-09-15: "I don't want the black hole
      // moving along the yellow line. I want it moving through space from point A to point B, and
      // have everything warp around it ... riding the line hides that amazing effect"): a straight
      // run from one height to another, both drawn from the seed inside the line's own range, so
      // the hole crosses the line's path rather than sitting on it and the line is seen bending
      // round the shadow as it passes
      lo = Infinity; hi = -Infinity; for (const p of line) { lo = Math.min(lo, p.z); hi = Math.max(hi, p.z); }
      const R = Math.max(1, hi - lo);
      const za = lo + R * (0.15 + 0.85 * hash01(f.seed + 6)), zb = lo + R * (0.15 + 0.85 * hash01(f.seed + 7));
      hz = za + (zb - za) * travel;
      hy = st.axes.y ?? st.gridH / 2;
    }
    // ...AND ALL THE WAY HOME BEFORE THE END (operator, 2026-09-15: "still snapping into place on
    // last frame to drop in"): the release curve reached zero only at u = 1, so on the last frame
    // a cube was still a few pixels off home at nine tenths size, and the effect's end put it
    // there in one step. It is a smoothstep now, done by 0.97 -- zero speed as it arrives -- and
    // the last three hundredths draw nothing at all
    const growIn = u < 0.22 ? Math.pow(u / 0.22, 1.6) : 1;
    const growOut = u <= 0.82 ? 1 : u >= 0.97 ? 0 : (() => { const t = 1 - (u - 0.82) / 0.15; return t * t * (3 - 2 * t); })();
    const grow = growIn * growOut;
    const rs = boundedRadius(2.3, 0.047, st.gridW) * grow;                 // the horizon, in grid units (4.8 on 2026-09-15 -- "double the size" -- then 3.4: "obscuring too much" -- then 2.3: "shrink up the black hole by 33%"), and never more than 4.7% of the board
    out.blackhole = { x: hx, y: hy, z: hz, rs, grow, lo, hi };
    // SWALLOWED SMOOTHLY (operator, 2026-09-15: "the candles just blinking out of existence looks
    // bad"): not `hide`, which is a threshold, but `scale: 0`, which fxAt applies by reach -- a
    // candle shrinks toward nothing as it nears the horizon and grows back as the hole recedes
    const reach = 1.5;
    // LIFTED OUT WHOLE, NOT SHEARED, on the block board (operator, 2026-09-15: "too much bad
    // shearing of the blocks around the black hole on the block space page. instead of stretching,
    // can it just lift the blocks out?"): no corner lean there (lean 0 -- buildScene's orbit
    // carries the cube toward the hole as one piece, its own shape, and it shrinks away into it).
    // Not `lift` either: that extrudes a cube into a column from the floor, which read as an even
    // longer stretch
    // ...and `shrink` on the block board: the scale alone flattens a cube into a plate (it is a
    // height override), and a plate sliding toward the hole was the "shearing"; shrunk in
    // footprint as well it stays a cube, a smaller one, all the way in
    // LET GO SMOOTHLY (operator, 2026-09-15: "The boxes are snapping into view when they come to
    // rest on the board"): the release used to come from the head's reach shrinking with the
    // hole, which let go of the outer cubes gently and the ones right under it all at once in the
    // last frames -- they stayed on their rings at nothing, then popped home full size. The reach
    // now holds its full size through the release and `release` (growOut) fades the pull and the
    // scale themselves, so every cube glides home and grows back over the whole last fifth
    const R = boundedRadius(2.3, 0.047, st.gridW) * reach;
    out.heads = grow > 0.02 ? [{ x: hx, y: hy, z: hz, color: [255, 160, 60], alpha: grow, r: R * growIn, rPeak: R, scale: 0, pull: 1, release: growOut, lean: line ? 1 : 0, shrink: !line }] : [];
  }
  // THE PULSAR IN THE WIND (2026-09-20, modelled on NASA SVS 15099 -- XRISM's view of BP Crucis /
  // GX 301-2): the pulsar makes one passage through the companion's plasma stream. Four acts, as
  // the mission observed them: entering the stream a messy accretion disk forms and plasma
  // spirals INWARD; deeper in, the flow lacks angular momentum, the disk BREAKS UP and plasma
  // falls straight on -- the X-ray flare's peak; near the far side the disk REBUILDS; then the
  // pulsar exits and the board is quiet again. The X-ray brightness follows the same curve,
  // peaking in the direct-accretion act. The rebuilt disk turns the SAME way as the first one
  // (operator, 2026-09-20): the mission's own reversal was in here for a day and it reads as a
  // glitch rather than as physics, so the acts are told by the swirl's strength and the infall.
  // Everything is hashed off the seed, so a replay is the same passage. The lighting rides on
  // `heads` (the pulsar itself, and the wind where it is disturbed) -- the same machinery the
  // fireworks and the black hole light with; there is no pull: the operator took the black
  // hole's shearing off the block board once, and the wind lights, it does not drag.
  if (f.kind === 'pulsar') {
    const line = st.axes?.line;
    const H = (k) => hash01(f.seed + 100 + k);
    // the crossing: a fifth of the way in from each edge, easing at both ends, so the arrival
    // and the exit are watched, not cut (the black hole's travel, the same shape)
    const travel = u < 0.1 ? 0 : u > 0.9 ? 1 : (() => { const t = (u - 0.1) / 0.8; return t * t * (3 - 2 * t); })();
    const dir = (f.dx || 0) !== 0 ? Math.sign(f.dx) : H(9) < 0.5 ? 1 : -1;
    const px = st.gridW * (0.14 + 0.72 * travel) * (dir > 0 ? 1 : 0) + st.gridW * (0.86 - 0.72 * travel) * (dir > 0 ? 0 : 1);
    // the wind: a diagonal swath of gas across the board, its own height at each edge; the
    // pulsar's path runs through it, wobbling a little, entering one side and leaving the other
    const sa = st.gridH * (0.12 + 0.66 * H(1)), sb = st.gridH * (0.12 + 0.66 * H(2));
    const sw = Math.max(1.6, st.gridH * 0.16);                    // the stream's half-width
    // it drifts across the board's depth as it goes, too -- a small one, since the depth is eight
    // units against the hours' width, but enough that the crossing is not a ruled line in y either
    const wob = (Math.sin(travel * Math.PI * (1.6 + H(14)) + H(3) * 6.283) * 0.7
      + Math.sin(travel * Math.PI * 3.3 + H(15) * 6.283) * 0.3) * sw * 0.42;
    const py = sa + (sb - sa) * (px / st.gridW) + wob;
    // THROUGH SPACE, NOT ALONG THE LINE (operator, 2026-09-20: "I don't want it riding the line.
    // I want it moving randomly across the screen like the black hole does"), NOT ALWAYS CLOSE TO
    // IT (the lanes in pulsarHeights), and NOT IN A RULED LINE ("Have it moving more like the
    // lightning ball, in a random horizontal direction, with a bit of vertical skew between the
    // start and end point. It always seems to move in a straight line") -- the wander in pulsarZ.
    // The horizontal direction is the board's own random one (fxDirection gives the price board
    // either way along the hours); the skew and the wander are the seed's.
    let pz;
    {
      let lo = 4, hi = 18;
      if (line && line.length > 1) { lo = Infinity; hi = -Infinity; for (const p of line) { lo = Math.min(lo, p.z); hi = Math.max(hi, p.z); } }
      const hgt = pulsarHeights(lo, hi, st.axes?.zTop, H(6), H(7), H(8));
      pz = pulsarZ(hgt, travel, H(10), H(11), H(12), H(13));
    }
    // inside the stream: soft edges either side of the passage (0.13..0.87 of the run)
    const edge = (a, b, v) => Math.max(0, Math.min(1, (v - a) / (b - a)));
    const inStream = edge(0.08, 0.16, u) * (1 - edge(0.84, 0.92, u));
    // the acts, as WEIGHTS on the swirl and the infall -- never as a change of direction: disk1
    // builds after entry, breaks at the middle, disk2 rebuilds, all gone on exit
    const disk1 = inStream * (1 - edge(0.4, 0.5, u));             // the disk spins up, then goes
    const direct = inStream * edge(0.42, 0.52, u) * (1 - edge(0.56, 0.66, u));   // no disk: straight in
    const disk2 = inStream * edge(0.56, 0.68, u);                 // and the rebuild, the same way round
    // X-ray brightness: low on approach, flaring through the breakdown, easing off on exit --
    // the shape of GX 301-2's light curve every four days
    const bright = 0.3 + 0.35 * inStream + 0.9 * direct * (0.7 + 0.3 * Math.sin(u * 60)) + 0.25 * disk1 + 0.3 * disk2;
    // A PLACE TO KEEP THE GAS: fxNow builds a FRESH object every frame, so anything with state --
    // and the wind is a particle simulation now -- cannot live on it (the first cut of the
    // particles did, and re-seeded 1500 of them 60 times a second, which draws as a faint even
    // haze and nothing else). `f` is the run's own record: it lives as long as the effect does.
    // ONE SENSE OF ROTATION FOR THE WHOLE PASSAGE (operator, 2026-09-20: "It should always spin
    // in one constant direction and never change direction"). The seed picks clockwise or
    // counter-clockwise when the effect starts and that is the end of it -- nothing else votes,
    // and in particular the acts do not: the original reading took its sign from which disk
    // weighed more, which reversed the gas at the break-up, and a later cut flipped it at the
    // halfway mark on purpose. Both were wrong. The disk still breaks up and rebuilds -- that is
    // the accretion story, and it is told by the swirl's STRENGTH and the infall, not by turning
    // the wind around.
    const spin = pulsarSpin(f.seed);
    out.pulsar = { px, py, pz, sa, sb, sw, travel, inStream, disk1, disk2, direct, bright, dir, spin, store: f };
    // the lighting: the pulsar itself, and a wake of wind behind it and gusts ahead -- five
    // points, offset along the path, the stream disturbed where the pulsar has been
    const heads = [];
    // A LIGHT, NOT A FLOODLIGHT (2026-09-20): at full alpha the tiles under the star went solid
    // white on the block board and the picture was a white brick instead of a star in the gas
    if (bright > 0.05) heads.push({ x: px, y: py, color: [225, 242, 255], alpha: Math.min(0.72, bright * 0.72), r: 2.4 });
    for (const off of [-5, -2.5, 0, 2.5, 5]) {
      const sx = px + off * dir, sy = sa + (sb - sa) * (sx / st.gridW);
      const w = 0.34 * inStream * Math.exp(-(off * off) / 22);
      if (w > 0.03) heads.push({ x: sx, y: sy, color: [140, 195, 255], alpha: w, r: 3.4 });
    }
    out.heads = heads;
  }
  // THE PULSE LIGHTS WHAT IT PASSES (operator, 2026-09-15: "interfering with the affected areas"):
  // its head is a light on the board, so the candles under it glow warm as it goes by (fxAt's
  // heads branch, as the agents do)
  if (f.kind === 'pulse' && st.axes?.line?.length > 1) {
    const line = st.axes.line, headAt = u / PULSE_TRAVEL;
    const k = Math.max(0, Math.min(1, headAt)) * (line.length - 1), i = Math.min(line.length - 2, Math.floor(k)), fr = k - i;
    const x = line[i].x + (line[i + 1].x - line[i].x) * fr;
    const fade = headAt <= 1 ? 1 : Math.max(0, 1 - (headAt - 1) / 0.34);
    out.heads = [{ x, y: st.axes.y ?? st.gridH / 2, color: [255, 225, 150], alpha: fade, r: 3.2 }];
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

// WHICH EFFECT PLAYS NEXT. Pure apart from `st` (recentFx) and `rnd`, so the tests
// drive the real rule instead of a copy of it.
//
// NO EFFECT WAITS ITS TURN. There was a rare set here -- the pulse, the bulge and ball lightning
// on the price board each held to a clock of 2.5-6 minutes between plays (operator, 2026-09-14:
// "much too often", then "should be rare") -- and it is gone (operator, later that day: "Make the
// pipe 'special rare' effects no longer special, and bake them into the regular round of choosing
// effects for the market"). The price board has its own list now, and the operator trims it;
// rarity is the no-repeat window and the length of the list, the same as on the block board.
//
// NO EFFECT REPEATS WITHIN THE LAST `noRepeat` PLAYED (operator, 2026-09-14: "add a config field that
// defaults to 12 ... never pick one that has been played in the last 12 sequences"). This replaces
// "not the same one twice running", which was the same rule with a window of one. `st.recentFx` keeps
// the kinds played, newest last. Where fewer kinds are switched on than the window, no kind can be
// twelve plays clear, so the pick is among those that have waited longest: the rule degrades to
// taking turns, never to a repeat while something else is waiting.
export function chooseIdleFx(kinds, st, now, rnd = Math.random, noRepeat = 12) {
  void now;   // the clock was the rare set's; kept in the signature so the callers and tests read the same
  if (!kinds.length) return null;
  const recent = st.recentFx ?? (st.recentFx = []);
  const window = Math.max(0, Math.min(Math.floor(noRepeat), kinds.length - 1));
  // FROM THE START, NOT FROM THE END (operator, 2026-09-15: "I keep seeing the same effect being
  // played before new ones"). This was `recent.slice(recent.length - window)`, and while fewer
  // effects had played than the window is wide that index was negative -- which slice counts from
  // the END: nine plays under a window of eleven blocked only the last two. The rule was weakest
  // right after the page opened, which is exactly when anyone is watching. Measured before the
  // fix on the Markets list: a repeat at the tenth pick; after it: every effect plays once before
  // any comes round again.
  const blocked = new Set(recent.slice(Math.max(0, recent.length - window)));
  // KINDS THAT LOOK ALIKE SHARE THE WINDOW (operator, 2026-09-15: "I just saw the UFO effect get
  // triggered twice in a row on the block space" -- the scan's searchlight and the tractor beam
  // fly the same saucer, so one after the other read as a repeat though the rule saw two kinds)
  for (const k of [...blocked]) for (const kin of FX_KIN[k] ?? []) blocked.add(kin);
  let pool = kinds.filter((k) => !blocked.has(k));
  if (!pool.length) {
    // every kind is inside the window: the ones played least recently
    const lastSeen = (k) => recent.lastIndexOf(k);
    const oldest = Math.min(...kinds.map(lastSeen));
    pool = kinds.filter((k) => lastSeen(k) === oldest);
  }
  // NO FAVOURITES (operator, 2026-09-13: "the tron lightcycles effect happens way too often").
  // There used to be a rule here: the first effect after the board came to rest was a light-cycle
  // race HALF THE TIME. That was written when there were nine effects and it read as a flourish.
  // Measured with fifty-six: 33.2% of every first-after-landing pick was the light cycles,
  // against 1.8% for an even split -- an eighteenfold bias. And the block-space board re-lays on
  // every pool refresh, so `soon` fires constantly, which is why it felt relentless.
  //
  // A hardcoded favourite also contradicts the scheduling the operator actually chose (flat, so
  // any one effect is a genuine surprise), so it is gone rather than merely reduced.
  const from = pool.length ? pool : kinds;
  const kind = from[(rnd() * from.length) | 0];
  recent.push(kind);
  if (recent.length > 64) recent.splice(0, recent.length - 64);
  return kind;
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
    const kinds = (onALine ? MARKET_FX : SPACE_FX).filter((k) => !allowed || allowed.has(k));
    if (!kinds.length) return;
    const kind = chooseIdleFx(kinds, st, now, Math.random, opts.fxNoRepeat ?? 12);
    if (!kind) { scheduleFx(canvas, st, opts); return; }   // only the pulse is on, and it is still waiting
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
// `pale`: the lightning ball's charge (operator, 2026-09-14: "The energy ball blue plasma is way too
// dark. Need to make it way subtler like the ball lightning stuff"). The cloud below is 22 puffs of
// deep blue (48,110,255) per segment over sixteen segments, which stacks into a dark blue mass with
// the ball lost in it; the ball asks for the same cloud in the stormball's pale tones and at a
// fraction of the alpha, so it reads as a haze the ball lights rather than a shadow it drags.
function chargeTrail(ctx, segs, lw, now, seedBase = 0, pale = false) {
  if (!segs.length) return;
  const body = pale ? '150,200,255' : '48,110,255', core = pale ? '215,238,255' : '120,180,255', dim = pale ? 0.45 : 1;
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
      const al = 0.2 * dim * g.tint * (1 - 0.6 * g.age) * (0.5 + 0.5 * hash01(i * 3 + k * 23 + 97));
      const px = mx + Math.cos(a1) * spread, py = my + Math.sin(a1) * spread;
      ctx.fillStyle = `rgba(${body},${al.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
      if (k % 2 === 0) {
        ctx.fillStyle = `rgba(${core},${(al * 0.7).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(px, py, rad * 0.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  const line = (g, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = lw * w; ctx.beginPath(); ctx.moveTo(g.a.x, g.a.y); ctx.lineTo(g.b.x, g.b.y); ctx.stroke(); };
  for (const g of segs) {
    if (g.tint < 0.04) continue;
    line(g, 14 * (1 + 0.8 * g.tint), `rgba(${pale ? '140,200,255' : '30,130,255'},${(0.16 * dim * g.tint).toFixed(3)})`);
    line(g, 5 * (1 + 0.8 * g.tint), `rgba(${pale ? '170,222,255' : '110,200,255'},${(0.7 * g.tint).toFixed(3)})`);
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

// A FIREWORKS DISPLAY (operator, 2026-09-15: "the fireworks effect doesn't work at all on the
// market screen", then "Make the fireworks much more impressive with further effects. Make them
// Arc. instead of just going straight up. Add the nebula smoke effect that fades out as it
// disperses ... Make a visually stunning fireworks display for the markets page"). The effect
// only ever LIT tiles -- fxAt's ring over the cubes was the picture on the block board, and on
// eight rows of candles it was a candle blinking. Every shell is drawn now, on both boards:
//   * the LAUNCH is an arc, not a line: the rocket leaves the floor to one side and climbs a
//     parabola to its burst point, a comet with a glowing tail and exhaust sparks falling behind;
//   * the BURST is a white flash and a shockwave ring racing out and thinning;
//   * the SHELL is one of four kinds by turn -- peony (round, two colours), chrysanthemum (long
//     glittering trails that crackle white late), willow (heavy droop under gravity, long
//     trails), ring (a hoop that keeps its shape as it falls) -- sixty to ninety sparks, each a
//     curved trail of the last few positions, slowing and pulled down, twinkling, fading;
//   * the SMOKE is a nebula: soft gradient blobs that leave the burst outward, growing, drifting
//     up, in the shell's colour gone grey, and fade as they disperse -- on after the sparks;
//   * up to ten shells on the price board, five on the block board (fireworkShells), overlapping,
//     of every size, at every height of the picture, each lighting the candles under it in its
//     own colour. Deterministic in fx.seed, as every effect is, so it replays and can be tested;
//     only the twinkle reads the clock.
const SHELL_COLS = [[[255, 170, 110], [255, 235, 160]], [[140, 220, 255], [220, 245, 255]], [[220, 160, 255], [255, 200, 240]], [[130, 255, 190], [235, 255, 220]], [[255, 120, 150], [255, 210, 120]], [[255, 215, 90], [255, 250, 210]], [[120, 200, 255], [255, 140, 200]]];

// THE SHELLS OF A DISPLAY, from the seed: where and when each bursts, how big, what kind, what
// colour. Shared by the drawing (drawFireworks) and the lighting (fxNow's heads), so the candles
// glow in a shell's own colour exactly where and when it bursts. Up to ten on the price board
// (operator, 2026-09-15: "have more than 1 firework going off at a time. 10 max. Vary the size ...
// vary the height. Use the entire vertical viewport"), five on the block board; each launches at
// its own moment in the first half of the run and lives long enough to overlap the next.
export const FIREWORK_KINDS = ['peony', 'chrysanthemum', 'willow', 'ring', 'crossette', 'strobe'];   // no pinwheel: sparks fly straight (2026-09-15)
export function fireworkShells(seed, gridW, gridH, price, zLo, zHi) {
  const count = price ? 10 : 5, life = price ? 0.28 : 0.33, SMOKE = 1.35;
  const out = [];
  for (let i = 0; i < count; i++) {
    const H = (k) => hash01(seed + i * 131 + k);
    out.push({
      i, life, smoke: SMOKE,
      t0: 0.02 + H(0) * (price ? 0.5 : 0.4),
      bx: 0.08 * gridW + H(1) * 0.84 * gridW, by: H(2) * gridH,
      zc: zLo + (zHi - zLo) * (0.15 + 0.8 * H(3)),
      size: 0.45 + 0.85 * H(4),                                // of the board's shell radius: small to big
      kind: FIREWORK_KINDS[Math.floor(H(8) * FIREWORK_KINDS.length)],
      cols: SHELL_COLS[Math.floor(H(9) * SHELL_COLS.length)],
      drift: (H(5) < 0.5 ? -1 : 1) * (0.12 + 0.2 * H(6)) * gridW,
      H,
    });
  }
  return out;
}
// THE SHELL KINDS, by turn: how the sparks fly. (operator, 2026-09-15: "Make more varied
// explosions. More effects. Lensflare? Really think stunning to see.")
//   peony          round, two colours
//   chrysanthemum  long glittering trails that crackle white late
//   willow         heavy droop under gravity, the longest trails
//   ring           a hoop that keeps its shape as it falls
//   crossette      a peony whose sparks each split four ways partway out
//   strobe         the sparks blink in unison, white, on a beat
//   pinwheel       every spark curls the same way -- a spiral opening out
const SHELL_KINDS = ['peony', 'chrysanthemum', 'willow', 'ring', 'crossette', 'strobe'];   // pinwheel is gone (2026-09-15: "a spiral effect ... defies physics of fireworks")
// SMOOTH BY LAYERING, NOT BY GRADIENT (operator, 2026-09-15: "gradient visible! We need smooth
// fills. no gradient shit!" -- then, of the block board: "what is still with the gradient fill
// shit?!"). createRadialGradient bands on this rasteriser: the rings are plainly visible, and
// worst on exactly the large soft blobs the effects are made of. Nested flat discs do not band --
// each is a plain rgba fill and the SUM is the curve.
//
// Takes the same `stops` a radial gradient would, so a conversion is mechanical and the colours
// are unchanged: it walks outward-in, interpolating the stop list, painting N flat rings.
export function softStops(ctx, x, y, r, stops, N = 0) {
  // THE STEP MUST LAND UNDER A PIXEL, or the cure is the disease (operator, 2026-09-15: "What is
  // with the gradient garbage?" -- of fills I had already converted). Twenty flat discs over a
  // 300px radius is a 15px step: concentric rings, which is exactly the banding a gradient makes,
  // only coarser. The layer count therefore comes from the RADIUS, not from a constant: about one
  // ring per 1.2px, floored so a small sprite is not wasteful and capped so a huge nebula cannot
  // cost thousands of fills.
  // ON THE GL RENDERER THIS IS ONE FILL. The nested discs below exist because a software
  // rasteriser bands a gradient; a fragment shader evaluates it per pixel, and the cumulative
  // opacity the discs are built to reach at each radius IS the stop's alpha -- so the same stops
  // on a radial gradient are the same picture, without two hundred fans to tessellate.
  if (ctx.gl2d === true && stops.every((st) => /^rgba?\(/.test(String(st[1])))) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.5, Math.abs(r)));
    for (const [o, c] of stops) g.addColorStop(Math.max(0, Math.min(1, o)), c);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, Math.abs(r)), 0, Math.PI * 2); ctx.fill();
    return;
  }
  if (!N) N = Math.max(16, Math.min(220, Math.round(Math.abs(r) / 1.2)));
  const at = (t) => {
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    const span = b[0] - a[0], k = span > 1e-6 ? (t - a[0]) / span : 0;
    const pa = String(a[1]).match(/rgba?\(([^)]+)\)/), pb = String(b[1]).match(/rgba?\(([^)]+)\)/);
    if (!pa || !pb) return String(a[1]);
    const va = pa[1].split(',').map(Number), vb = pb[1].split(',').map(Number);
    const m = (i, d) => (va[i] ?? d) + (((vb[i] ?? d) - (va[i] ?? d)) * k);
    return `rgba(${Math.round(m(0, 0))},${Math.round(m(1, 0))},${Math.round(m(2, 0))},${m(3, 1).toFixed(4)})`;
  };
  // THE DISCS ADD UP (2026-09-15: "far too much solid white" on the Kiosk -- the supernova's pool
  // and glow were opaque discs). Each nested disc was painted at the stop's whole alpha, and a
  // point at radius t lies under EVERY disc of radius >= t: two hundred discs at 0.08 stack to
  // solid. What the caller means by a stop is the opacity of everything painted at that radius,
  // so each disc carries only the INCREMENT -- painted from the outside in, the disc at t adds
  // 1 - (1 - a(t)) / (1 - a(t_outer)), and the cumulative opacity at every radius is exactly a(t).
  const alphaAt = (t) => { const m = at(t).match(/rgba\([^,]+,[^,]+,[^,]+,([^)]+)\)/); return m ? Math.min(0.999, Math.max(0, Number(m[1]))) : 1; };
  let outer = 0;                                              // the cumulative opacity just outside the current disc
  for (let i = N; i >= 1; i--) {
    const t = i / N, want = alphaAt(t);
    const inc = want > outer ? 1 - (1 - want) / (1 - outer) : 0;
    if (want > outer) outer = want;
    if (inc < 0.0005) continue;
    ctx.fillStyle = at(t).replace(/,([^,]+)\)$/, `,${inc.toFixed(4)})`);
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r * t), 0, Math.PI * 2); ctx.fill();
  }
}

function drawFireworks(ctx, view, lw) {
  const fx = view.fx;
  if (!fx || fx.kind !== 'firework') return;
  const U = view.unit ?? 8;
  const P = (x, y, z) => project(x, y, z, view);
  const line = view.axes?.line;
  const price = line?.length > 1;
  // THE WHOLE HEIGHT of the picture: the floor to the chart's top on the price board, the floor
  // to well above the cubes on the block board
  const zLo = 1, zHi = price ? (view.axes?.zTop ?? 34) : 16;
  const gf = Math.min(1, (1 - fx.u) / 0.1);                  // the run's own fade-out
  // still a real gradient maker, because gasCloud() takes one as a callback and uses it for the
  // smoke puffs; every FILL in this function is layered flat discs now (softStops)
  const gradientOf = (x, y, r, stops) => {
    const g = typeof ctx.createRadialGradient === 'function' ? ctx.createRadialGradient(x, y, 0, x, y, r) : null;
    if (!g || typeof g.addColorStop !== 'function') return stops[0][1];
    for (const [o, col] of stops) g.addColorStop(o, col);
    return g;
  };
  const linearOf = (x0, y0, x1, y1, stops) => {
    const g = typeof ctx.createLinearGradient === 'function' ? ctx.createLinearGradient(x0, y0, x1, y1) : null;
    if (!g || typeof g.addColorStop !== 'function') return stops[Math.floor(stops.length / 2)][1];
    for (const [o, col] of stops) g.addColorStop(o, col);
    return g;
  };
  const disc = (x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); ctx.fill(); };
  const seg = (a, b, col, w) => { ctx.strokeStyle = col; ctx.lineWidth = Math.max(lw * 0.8, w); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  const now = view.now ?? 0;
  const cx0 = (view.boardW ?? 0) / 2, cy0 = -(view.boardH ?? 0) / 4;
  for (const sh of fireworkShells(fx.seed, fx.gridW, fx.gridH, price, zLo, zHi)) {
    const { H, life, smoke: SMOKE, kind } = sh;
    const v = (fx.u - sh.t0) / life;
    if (!(v > 0 && v < SMOKE)) continue;
    const [col, col2] = sh.cols;
    const c1 = col.join(','), c2 = col2.join(',');
    const top = P(sh.bx, sh.by, sh.zc);
    const R0 = U * boundedRadius(price ? 4.5 : 6, 0.09, fx.gridW) * sh.size;   // 7 and 8 until 2026-09-15 ("same with fireworks" -- on the Kiosk's panel ten shells carpeted it); never more than 9% of the board
    // --- the launch: a parabola from the floor, off to one side, to the burst point
    const RISE = 0.2;
    const arc = (f) => P(sh.bx - sh.drift * (1 - f), sh.by, zLo + (sh.zc - zLo) * (1 - (1 - f) * (1 - f)));
    if (v < RISE) {
      const f = v / RISE;
      const head = arc(f);
      const tail = [];
      for (let k = 0; k <= 8; k++) tail.push(arc(Math.max(0, f - (k / 8) * 0.22)));
      for (let k = 0; k < 8; k++) {
        const a = (1 - k / 8) * gf;
        seg(tail[k], tail[k + 1], `rgba(${c1},${(0.35 * a).toFixed(3)})`, U * 0.26 * a * sh.size);
        seg(tail[k], tail[k + 1], `rgba(255,240,210,${(0.9 * a).toFixed(3)})`, U * 0.08 * a);
      }
      for (let k = 0; k < 10; k++) {
        const age = ((f * 6 + k / 10) % 1), back = arc(Math.max(0, f - age * 0.18));
        const sx = back.x + (H(50 + k) - 0.5) * U * 0.8, sy = back.y + age * U * 1.6;
        disc(sx, sy, U * 0.06 * (1 - age), `rgba(255,220,160,${(0.8 * (1 - age) * gf).toFixed(3)})`);
      }
      softStops(ctx, head.x, head.y, U * 0.32, [[0, `rgba(255,255,255,${gf.toFixed(3)})`], [0.4, `rgba(${c2},${(0.9 * gf).toFixed(3)})`], [1, `rgba(${c1},0)`]]);
      continue;
    }
    const s = Math.min(1, (v - RISE) / (1 - RISE));          // 0 at the burst, 1 when the sparks are out
    const ss = (v - RISE) / (SMOKE - RISE);                   // the smoke's own clock, 0..1 over the longer life
    // --- THE DISSIPATION (operator: "The dissipation effects need to be more detailed"): a nebula
    // of sixteen lumps, each two gradient discs offset so it is not round, leaving the burst
    // outward and curling as it goes, the shell's colour gone grey with the colour still in its
    // heart; embers falling slowly through it, flickering; ash sinking after them; all of it
    // fading as it disperses and gone before the run ends
    const smokeRc = [Math.round(col[0] * 0.45 + 95), Math.round(col[1] * 0.45 + 95), Math.round(col[2] * 0.45 + 105)];
    const smokeCol = smokeRc.join(',');
    // THE SMOKE IS A VOLUME OF GAS (operator, 2026-09-15: "Use the gas cloud for the fireworks
    // smoke too"): the supernova's renderer, smaller -- a sphere of soft blobs carried out from
    // the burst, drifting up, going from the shell's colour toward grey as it disperses
    {
      const sr = R0 * (0.3 + 1.1 * (1 - Math.exp(-2.2 * ss))), rise = R0 * 0.3 * ss;
      // TONED DOWN (operator, 2026-09-15: "the fireworks nebulas are too prominent. they need to be
      // toned down by half at least. Too opaque for too long"): half the alpha, a steeper fade,
      // fewer blobs, and the smoke lives 1.35 shell-lives rather than 1.7
      const sa = 0.45 * Math.pow(1 - ss, 2.2) * (0.4 + 0.6 * Math.min(1, ss * 6)) * gf;
      if (sa > 0.01) gasCloud(ctx, top.x, top.y - rise, sr, ss, now, fx.seed + sh.i * 977, sa * 1.1, smokeRc, gradientOf, disc, 60, [50, 50, 58]);
    }
    if (ss > 0.15) {
      const em = (ss - 0.15) / 0.85;
      for (let k = 0; k < 18; k++) {
        const ang = H(300 + k) * Math.PI * 2, d = R0 * (0.25 + 0.75 * H(320 + k));
        const x = top.x + Math.cos(ang) * d + Math.sin(now * 0.002 + k) * U * 0.35, y = top.y + Math.sin(ang) * d * 0.7 + R0 * (0.15 + 1.2 * em) * (0.5 + 0.5 * H(340 + k));
        const flick = 0.5 + 0.5 * Math.sin(now * 0.02 + k * 2.3);
        const a = (1 - em) * gf;
        if (a > 0.02) {
          softStops(ctx, x, y, U * 0.11 * (1 - 0.5 * em), [[0, `rgba(255,255,255,${(0.9 * a * flick).toFixed(3)})`], [0.5, `rgba(${c2},${(0.7 * a * flick).toFixed(3)})`], [1, `rgba(${c1},0)`]]);
          if (k % 3 === 0) disc(x + U * 0.2, y + U * 0.5 * em, U * 0.03, `rgba(${smokeCol},${(0.6 * a).toFixed(3)})`);   // ash
        }
      }
    }
    if (v >= 1) continue;                                     // only the dissipation is left
    // --- the burst: a flash, a lens flare, and a shockwave ring racing out and thinning
    if (s < 0.14) {
      const f = (1 - s / 0.14) * gf;
      const r = R0 * 0.5 * (1.3 - f * 0.6);
      softStops(ctx, top.x, top.y, r, [[0, `rgba(255,255,255,${(0.95 * f).toFixed(3)})`], [0.3, `rgba(${c2},${(0.7 * f).toFixed(3)})`], [1, `rgba(${c1},0)`]]);
    }
    if (s < 0.35) {
      const f = Math.pow(1 - s / 0.35, 1.5) * gf;
      const L = R0 * 2.6;
      ctx.strokeStyle = linearOf(top.x - L, top.y, top.x + L, top.y, [[0, `rgba(${c2},0)`], [0.35, `rgba(${c2},${(0.35 * f).toFixed(3)})`], [0.5, `rgba(255,255,255,${(0.9 * f).toFixed(3)})`], [0.65, `rgba(${c2},${(0.35 * f).toFixed(3)})`], [1, `rgba(${c2},0)`]]);
      ctx.lineWidth = Math.max(lw, U * 0.09); ctx.beginPath(); ctx.moveTo(top.x - L, top.y); ctx.lineTo(top.x + L, top.y); ctx.stroke();
      ctx.lineWidth = Math.max(lw * 3, U * 0.3); ctx.strokeStyle = linearOf(top.x - L, top.y, top.x + L, top.y, [[0, `rgba(${c1},0)`], [0.5, `rgba(${c1},${(0.25 * f).toFixed(3)})`], [1, `rgba(${c1},0)`]]);
      ctx.beginPath(); ctx.moveTo(top.x - L * 0.7, top.y); ctx.lineTo(top.x + L * 0.7, top.y); ctx.stroke();
      const rays = 4, spin = now * 0.0004 + H(11) * Math.PI;
      for (let k = 0; k < rays; k++) {
        const ang = spin + (k / rays) * Math.PI, rl = R0 * (0.9 + 0.5 * H(12 + k));
        const x0 = top.x - Math.cos(ang) * rl, y0 = top.y - Math.sin(ang) * rl, x1 = top.x + Math.cos(ang) * rl, y1 = top.y + Math.sin(ang) * rl;
        ctx.strokeStyle = linearOf(x0, y0, x1, y1, [[0, 'rgba(255,255,255,0)'], [0.5, `rgba(255,255,255,${(0.5 * f).toFixed(3)})`], [1, 'rgba(255,255,255,0)']]);
        ctx.lineWidth = Math.max(lw * 0.8, U * 0.03); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      for (let k = 1; k <= 5; k++) {
        const t = k * 0.35, gx = top.x + (cx0 - top.x) * t, gy = top.y + (cy0 - top.y) * t;
        const gr = R0 * (0.08 + 0.1 * H(20 + k)) * (0.6 + t), ga = 0.16 * f * (1 - k / 7);
        softStops(ctx, gx, gy, gr, [[0, `rgba(${k % 2 ? c1 : c2},${(ga * 0.5).toFixed(3)})`], [0.7, `rgba(${k % 2 ? c1 : c2},${ga.toFixed(3)})`], [1, `rgba(${k % 2 ? c1 : c2},0)`]]);
      }
    }
    if (s < 0.4) {
      const f = s / 0.4;
      ctx.strokeStyle = `rgba(255,255,255,${(0.55 * (1 - f) * gf).toFixed(3)})`; ctx.lineWidth = Math.max(lw, U * 0.12 * (1 - f));
      ctx.beginPath(); ctx.arc(top.x, top.y, R0 * 1.25 * f, 0, Math.PI * 2); ctx.stroke();
    }
    // --- EMISSIVE LIGHT on the explosion's surroundings (operator: "emissive colored lighting
    // illuminating the explosion area in the explosion color"): a wide soft pool of the shell's
    // colour over everything near the burst, strongest at the burst and fading with the shell
    // (the candles under it glow in the colour too, through fxNow's heads)
    {
      const f = Math.pow(1 - s, 1.3) * gf, r = R0 * 2.4;
      softStops(ctx, top.x, top.y + R0 * 0.2 * s, r, [[0, `rgba(${c1},${(0.32 * f).toFixed(3)})`], [0.4, `rgba(${c1},${(0.14 * f).toFixed(3)})`], [1, `rgba(${c1},0)`]]);
    }
    // --- the shell
    const N = kind === 'ring' ? 60 : kind === 'crossette' ? 36 : 84;
    const fade = Math.pow(1 - s, kind === 'willow' ? 0.8 : 1.2) * gf;
    const spreadAt = (sq) => (kind === 'ring' ? Math.min(1, sq * 3) : 1 - Math.exp(-3.4 * sq));
    const gscale = kind === 'willow' ? 1.9 : kind === 'ring' ? 0.7 : 1;
    const pos = (k, sq, scale) => {
      const jitter = kind === 'ring' ? 0.03 : 0.25;
      const curl = kind === 'pinwheel' ? 2.4 * sq : 0;
      const ang = (k / N) * Math.PI * 2 + (H(100 + k) - 0.5) * jitter + curl;
      const len = R0 * (kind === 'ring' ? 0.9 : 0.6 + 0.5 * H(200 + k)) * scale;
      const sp = spreadAt(sq);
      return { x: top.x + Math.cos(ang) * len * sp, y: top.y + Math.sin(ang) * len * sp * (kind === 'ring' ? 0.55 : 1) + R0 * 0.9 * gscale * sq * sq };
    };
    const blink = kind === 'strobe' ? (Math.sin(now * 0.03) > 0.2 ? 1 : 0.15) : 1;
    for (let k = 0; k < N; k++) {
      const inner = k % 3 === 0;
      const c = inner ? c2 : c1;
      const scale = inner ? 0.62 : 1;
      const long = kind === 'chrysanthemum' || kind === 'willow';
      const steps = long ? 5 : 3, back = long ? 0.22 : 0.12;
      let prev = null;
      for (let q = steps; q >= 0; q--) {
        const p = pos(k, Math.max(0, s - (q / steps) * back), scale);
        if (prev) {
          const a = (1 - q / (steps + 1)) * blink;
          seg(prev, p, `rgba(${c},${(0.28 * fade * a).toFixed(3)})`, U * 0.2 * a * sh.size);
          seg(prev, p, `rgba(${c},${(0.95 * fade * a).toFixed(3)})`, U * 0.07 * a);
        }
        prev = p;
      }
      const tw = 0.55 + 0.45 * Math.sin(now * 0.02 + k * 1.7);
      const pop = kind === 'chrysanthemum' && s > 0.3 && hash01(fx.seed + k * 7 + Math.floor(now / 50)) < 0.12;
      disc(prev.x, prev.y, U * (pop ? 0.2 : 0.075) * scale, `rgba(255,255,255,${(fade * blink * (pop ? 1 : 0.9 * tw)).toFixed(3)})`);
      if (kind === 'crossette' && s > 0.42) {
        const s2 = (s - 0.42) / 0.58, f2 = Math.pow(1 - s2, 1.3) * gf;
        for (let m = 0; m < 4; m++) {
          const ang = (m / 4) * Math.PI * 2 + H(400 + k) * 1.5, d = R0 * 0.22 * (1 - Math.exp(-3 * s2));
          const e = { x: prev.x + Math.cos(ang) * d, y: prev.y + Math.sin(ang) * d + R0 * 0.2 * s2 * s2 };
          seg(prev, e, `rgba(${c2},${(0.8 * f2).toFixed(3)})`, U * 0.05);
          disc(e.x, e.y, U * 0.06, `rgba(255,255,255,${(0.9 * f2).toFixed(3)})`);
        }
      }
    }
    disc(top.x, top.y + R0 * 0.25 * s, U * 0.16 * fade, `rgba(255,255,255,${(0.7 * fade).toFixed(3)})`);
  }
  ctx.lineWidth = lw;
}

// THE SCAN IS A LIGHT CURTAIN (operator, 2026-09-15: "Suggest a way to drastically improve the
// visuals on the scan line effect. Again, create new render tools" -- then "do it"). The front
// was a tight line on the floor that lit each tile for a frame. Now it is a vertical SHEET of
// light standing on the board, floor to the chart's top, sweeping across: a hard white core
// with soft cyan falloff on both faces, faint raster lines rippling down it on the clock, a bar
// of light along its top edge it hangs from with glints at the ends, a glowing foot on the floor
// with a green-cyan phosphor tail fading behind it, motes drifting in the beam, sparks thrown up
// from the foot, and a thin volumetric haze inside its thickness. The tiles keep lighting through
// fxAt as before, and the price line flares white where the curtain crosses it (scanFlare).
function curtainEnds(fx, z) {
  // the front is the set of board points with x*dx + y*dy = p; its ends are where that line
  // leaves the board, at height z
  const n = fx.gridW, rows = fx.gridH, p = fxFront(fx);
  const c0x = n / 2 + (p - (n / 2) * fx.dx - (rows / 2) * fx.dy) * fx.dx;
  const c0y = rows / 2 + (p - (n / 2) * fx.dx - (rows / 2) * fx.dy) * fx.dy;
  const L = Math.hypot(n, rows);
  let a = null, b = null;
  for (let i = -60; i <= 60; i++) {
    const gx = c0x - fx.dy * (L * i) / 60, gy = c0y + fx.dx * (L * i) / 60;
    if (gx >= -0.01 && gx <= n + 0.01 && gy >= -0.01 && gy <= rows + 0.01) { if (!a) a = { x: gx, y: gy, z }; b = { x: gx, y: gy, z }; }
  }
  return a && b && (a.x !== b.x || a.y !== b.y) ? [a, b] : null;
}
// THE LINE UNDER THE CURTAIN: the stretch the scan is crossing flares white and rings out
// either side, so the wire reads as struck by the sheet of light as it passes
function scanFlare(ctx, pts, axes, view, lw) {
  const fx = view.fx, line = axes.line ?? [];
  if (!fx || fx.dx === 0 || line.length !== pts.length) return;
  const xf = fxFront(fx) * fx.dx;                                       // the front's x on the board (dy is 0 on the price board)
  for (let i = 0; i < pts.length - 1; i++) {
    const mx = (line[i].x + line[i + 1].x) / 2, d = Math.abs(mx - xf);
    const k = Math.exp(-(d * d) / 6);
    if (k < 0.03) continue;
    ctx.strokeStyle = `rgba(160,230,255,${(0.6 * k).toFixed(3)})`; ctx.lineWidth = lw * 14 * k;
    ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${(0.95 * k).toFixed(3)})`; ctx.lineWidth = lw * 4;
    ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.stroke();
  }
}
// THE BEAM'S ALTITUDE AND WIDTH, decided once. fxAt lights the swath while buildScene runs, and
// drawScanCurtain draws the cone afterwards; if each worked its own numbers out they would drift
// apart and the lit blocks would not be the ones under the light.
function scanBeamGeom(view) {
  const price = (view.axes?.line?.length ?? 0) > 1;
  const top = price ? (view.axes?.zTop ?? 34) : 9;
  const line = view.axes?.line ?? [];
  const peak = line.length > 1 ? line.reduce((h, q) => Math.max(h, q.z ?? 0), 0) : top * 0.8;
  const clearance = Math.max(2.5, top * 0.1);
  const z = Math.max(peak + 1, Math.min(peak + clearance, top * 0.95));
  const spread = price ? Math.max(3, Math.min(11, z * 0.32)) : Math.max(2, Math.min(5, z * 0.45));
  return { price, top, z, spread };
}

function drawScanCurtain(ctx, view, lw) {
  const fx = view.fx;
  if (!fx || fx.kind !== 'scan') return;
  const U = view.unit ?? 8, now = view.now ?? 0;
  const { price, top } = scanBeamGeom(view);
  const P = (q) => project(q.x, q.y, q.z, view);
  // NO FADE WHILE IT IS IN SIGHT (operator, 2026-09-15: "it still fades in and out ... with the
  // effects properly transitioning before being killed"). fx.amp is the shared envelope every
  // effect dims by at its start and end -- which for a thing that TRAVELS means it materialises in
  // the middle of the picture and dissolves there. The craft and its beam now hold full strength
  // and let POSITION do the transition: the front enters and leaves beyond the panel's edge
  // (fxFront's margin), so there is nothing on screen to fade.
  const amp = 1;
  void fx.amp;
  // IT MUST LEAVE THE VIEWPORT, NOT BLINK OUT AT THE EDGE (operator, 2026-09-15: "it disappears at
  // the edge of the screen. Have it move entirely off the viewport before you delete it").
  // curtainEnds returns null the moment the front stops crossing the board, so everything below --
  // the craft included -- simply stopped being drawn while it was still in frame. The craft's
  // position comes from the front itself now, which fxFront carries four units past each edge, so
  // the saucer flies in from off-board and out the far side under its own power.
  const fp = fxFront(fx);
  const fcx = fx.gridW / 2 + (fp - (fx.gridW / 2) * fx.dx - (fx.gridH / 2) * fx.dy) * fx.dx;
  const fcy = fx.gridH / 2 + (fp - (fx.gridW / 2) * fx.dx - (fx.gridH / 2) * fx.dy) * fx.dy;
  // (fcx/fcy is the BOARD CENTRE projected onto the front line, so the craft always flies the
  // grid's vertical or horizontal centre -- operator, 2026-09-20: "the saucer always flies
  // through the vertical or horizontal center of the grid")
  const ends = curtainEnds(fx, 0);
  const [A, B] = ends ?? [{ x: fcx, y: fcy, z: 0 }, { x: fcx, y: fcy, z: 0 }];

  // A CONE, NOT A STACK OF SHEETS (operator, 2026-09-15: "that leaning portion and the
  // cross-hatching is not working. Can we make it a conical beam. instead, and do something
  // volumetric effect?").
  //
  // WHY THE OLD ONE HATCHED. The curtain was twenty-one PARALLEL flat quads (k = -10..10, each
  // offset k*0.5 along the sweep) with fourteen raster lines drawn across them. Under the oblique
  // camera parallel sheets project to parallelograms offset by a constant, so their translucent
  // edges land on near-parallel screen lines and read as a lattice -- a leaning cross-hatch. No
  // amount of alpha tuning fixes that; the geometry itself is a grid.
  //
  // A cone has no parallel edges. Its body is a fan of triangles that all converge on the apex,
  // so overlap -- and therefore density -- rises smoothly toward the axis on its own. That is the
  // volumetric part: nothing is faked with a gradient across a flat face, the light is thick where
  // the geometry is thick. Three nested shells give the falloff depth, a bright pool marks where
  // it lands, and motes drift inside the volume rather than on a sheet.
  // THE BEAM'S AIM (operator, 2026-09-20: "I want the ufo scanner panning back and forth
  // perpendicular to it's line of travel, to the extend of each side of the board and back", and
  // "The saucer stays in it's movement position"). The craft holds the front's own line; the beam
  // it throws swings ALONG the front -- perpendicular to travel -- from one side of the board to
  // the other and back, the sweep computed once in fxNow (fx.scanPan) so the tiles fxAt lights and
  // the cone drawn here cannot disagree. The price chart's curtain stays centred (no scanPan).
  const pan = fx.scanPan ?? 0;
  const ax = -fx.dy, ay = fx.dx;                          // unit vector ALONG the front
  const px = fcx + ax * pan, py = fcy + ay * pan;         // where the beam is aimed this frame
  const mx = px, my = py;
  const SPREAD = scanBeamGeom(view).spread;
  // A SPOTLIGHT, NOT A CURTAIN, on the block board: the pool is the beam's footprint, so the base
  // ellipse is sized to the beam itself (fxAt lights that same disc); the price chart keeps its
  // full-width curtain.
  const half = price ? Math.hypot(B.x - A.x, B.y - A.y) / 2 : SPREAD * 1.25;
  const sx = fx.dx, sy = fx.dy;                           // unit vector along the SWEEP
  // PROPORTIONS ARE THE WHOLE EFFECT (operator, 2026-09-15: the first cut "is fucked"). It put the
  // apex at top*1.5 -- z = 51 on the price board -- over a base barely 5 units across, which draws
  // 49px wide by 147px tall: a needle, not a beam. A spotlight reads as a spotlight when its height
  // and the width where it lands are comparable, so the apex sits just under the chart's own top
  // and the pool is wide enough to look like something landed in it.
  // ABOVE THE PEAK, not level with it (operator, 2026-09-15: "It needs to fly a bit higher than
  // the price line peak"). `top` is the chart's axis ceiling, which the line can come close to --
  // a craft at 0.9 of it flies through the high candles. So the ceiling is the taller of the axis
  // top and the line's own highest point, and the saucer clears it by 15%.
  // ABOVE THE PEAK, BUT UNDER THE CEILING (operator, 2026-09-15: "It needs to fly a bit higher
  // than the price line peak", then -- when I raised it past the chart's own top -- "It's flying at
  // the top of teh screen. don't do that ... set it lower with some above tolerances").
  //
  // Both mistakes were the same one: taking a single bound and scaling it. Too low and the craft
  // flies through the high candles; too high and it leaves the frame. It wants a clearance over the
  // line AND a hard ceiling under the chart's top, so it rides above the price wherever the price
  // happens to be and never reaches the edge.
  const apex = { x: mx, y: my, z: scanBeamGeom(view).z };
  const RING = 44;
  // a point on the base ellipse: `f` scales the shell, `th` runs around it
  const ring = (th, f) => ({
    x: mx + Math.cos(th) * half * f * ax + Math.sin(th) * SPREAD * f * sx,
    y: my + Math.cos(th) * half * f * ay + Math.sin(th) * SPREAD * f * sy,
    z: 0,
  });
  const tri = (a, b, c, fill) => {
    const p0 = P(a), p1 = P(b), p2 = P(c);
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.closePath(); ctx.fill();
  };
  const seg = (a, b, col, w) => { const p = P(a), q = P(b); ctx.strokeStyle = col; ctx.lineWidth = Math.max(lw * 0.8, w); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); };
  // SMOOTH BY LAYERING, NOT BY GRADIENT (operator, 2026-09-15: "gradient visible! We need smooth
  // fills. no gradient shit!"). A radial gradient bands on this rasteriser -- the rings are
  // plainly visible, and worst on a large fill like the beam's pool. Many nested flat discs do not
  // band: each is a plain rgba fill and the SUM is the curve. Same doctrine as bloom() in
  // agents.js, with far more steps because the pool is large.
  // one ring per ~1.2px, same rule as softStops: a fixed count bands on a large pool
  const soft = (x, y, r, rgb, a) => {
    const N = Math.max(16, Math.min(220, Math.round(Math.abs(r) / 1.2)));
    for (let i = N; i >= 1; i--) {
      ctx.fillStyle = `rgba(${rgb},${(a / N).toFixed(4)})`;
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r * (i / N)), 0, Math.PI * 2); ctx.fill();
    }
  };
  const disc = (x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); ctx.fill(); };

  // off the board there is nothing to light, so the beam is not drawn -- but the craft still is,
  // which is what carries it out of the viewport
  const onBoard = !!ends;
  // --- the volume: nested cone shells, widest and faintest first
  // DIMMER (operator, 2026-09-15: "the brightness of the scanner cone in the block space view needs
  // to be toned down. It's too bright. Actually tone down beam brightness on both"): the shells,
  // the axis, the pool and the rim all at a little over half of what they were
  const DIM = 0.55;
  if (onBoard) for (const [f, a] of [[1, 0.018], [0.88, 0.019], [0.76, 0.021], [0.64, 0.023], [0.53, 0.026], [0.43, 0.029], [0.34, 0.033], [0.26, 0.038], [0.19, 0.044], [0.13, 0.05]]) {
    const fill = `rgba(120,220,255,${(a * DIM * amp).toFixed(3)})`;
    for (let i = 0; i < RING; i++) {
      tri(apex, ring((i / RING) * Math.PI * 2, f), ring(((i + 1) / RING) * Math.PI * 2, f), fill);
    }
  }
  // the hot axis: a thin cone down the middle, and the shaft itself
  if (onBoard) for (let i = 0; i < RING; i++) {
    tri(apex, ring((i / RING) * Math.PI * 2, 0.08), ring(((i + 1) / RING) * Math.PI * 2, 0.08), `rgba(235,250,255,${(0.10 * DIM * amp).toFixed(3)})`);
  }

  // --- where it lands: a pool on the floor, brightest at the axis
  if (onBoard) {
    const c = P({ x: mx, y: my, z: 0 });
    const r = U * Math.max(half, SPREAD) * 1.35;
    soft(c.x, c.y, r, '150,225,255', 1.5 * DIM * amp);
    soft(c.x, c.y, r * 0.42, '225,248,255', 1.1 * DIM * amp);
  }
  // the rim of the pool, so the cone reads as landing on something
  if (onBoard) for (let i = 0; i < RING; i++) {
    seg(ring((i / RING) * Math.PI * 2, 1), ring(((i + 1) / RING) * Math.PI * 2, 1), `rgba(170,235,255,${(0.28 * DIM * amp).toFixed(3)})`, U * 0.05);
  }

  // --- the source: the UFO, flying the beam (operator, 2026-09-15: "The top-down view in block
  // space coming from a sphere does not look good. Can we re-purpose the UFO"). A glowing ball
  // seen from directly above is just a blob -- it has no orientation, so top-down it reads as a
  // smudge where the light starts. The saucer has a rim and a dome, so it stays a craft at any
  // camera angle. Same craft the tractor beam flies (agents.js saucer()), so the board has one
  // ship rather than two unrelated light sources.
  {
    const p = P(apex);
    // (no glow round the craft: operator, 2026-09-15, "remove the light around the UFO. We have
    // enough lights for that effect")
    // TOP-DOWN (operator, 2026-09-15: "We need a top-down rendering of the UFO for this scene").
    // The board's camera looks DOWN, so a dome-and-rim craft drawn edge-on is a smear; from above
    // a saucer is concentric, and `squash` is the camera's own depth foreshortening so its circles
    // are the ellipses everything else on the board is drawn in.
    saucerAbove(ctx, p.x, p.y, U * 1.9, amp, view.oblique?.dy ?? 1, now * 0.0009);
  }

  // --- motes INSIDE the volume: placed by angle and depth, so they sit in the cone rather than
  // on a face. Each drifts up the shaft and is reseeded by its own hash, never by Math.random.
  // ...and only while the beam is on the board (operator, 2026-09-15: "I don't like how the
  // particles are kept when the scanner is off"): off it, the craft flies alone
  if (onBoard) for (let k = 0; k < 30; k++) {
    const H = (q) => hash01(fx.seed + 700 + k * 13 + q);
    const climb = ((H(1) + now * 0.00007 * (0.5 + H(2))) % 1);       // 0 at the floor, 1 at the apex
    const th = H(3) * Math.PI * 2, rad = Math.sqrt(H(4)) * (1 - climb);
    const b = ring(th, rad);
    const q = { x: b.x + (apex.x - b.x) * climb, y: b.y + (apex.y - b.y) * climb, z: apex.z * climb };
    const p = P(q), tw = 0.5 + 0.5 * Math.sin(now * 0.008 + k * 1.7);
    disc(p.x, p.y, U * 0.06 * (1 - 0.5 * climb), `rgba(230,250,255,${(0.75 * tw * (1 - climb) * amp).toFixed(3)})`);
  }

  // --- sparks thrown from where it lands, as before: the beam is doing something to the board
  const STEP = 160, LIFE = 900, kNow = Math.floor(now / STEP);
  if (onBoard) for (let k = kNow - Math.ceil(LIFE / STEP); k <= kNow; k++) {
    if (hash01(fx.seed + k * 5) > 0.5) continue;
    const age = (now - k * STEP) / LIFE;
    if (age < 0 || age >= 1) continue;
    const t = hash01(fx.seed + k * 5 + 1);
    // on the block board the beam is a panning spotlight, so the sparks scatter inside its
    // FOOTPRINT (the disc fxAt lights), not along the front line the craft flies
    const q = (!price && fx.panAt)
      ? (() => { const rr = Math.sqrt(hash01(fx.seed + k * 5 + 3)) * SPREAD * 1.2, th2 = hash01(fx.seed + k * 5 + 4) * Math.PI * 2;
          return { x: mx + Math.cos(th2) * rr, y: my + Math.sin(th2) * rr, z: 0 }; })()
      : { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, z: 0 };
    const p = P(q), rise = U * 2.2 * age * (1 - age) * 4, drift = (hash01(fx.seed + k * 5 + 2) - 0.5) * U * 1.2 * age;
    disc(p.x + drift, p.y - rise, U * 0.07 * (1 - age), `rgba(255,255,255,${(0.9 * (1 - age) * amp).toFixed(3)})`);
  }
  ctx.lineWidth = lw;
}

// THE BLACK HOLE (operator, 2026-09-15: "Simulate the price chart turning into a black hole",
// reference svs.gsfc.nasa.gov/14576 -- NASA's visualisation: an orange accretion disk of hot gas
// spiralling in, brighter on the side coming toward us, a photon ring inside it, the far side of
// the disk lensed into an arch over the top of the shadow and a thinner one under it, the sky
// behind bent into arcs). On the chart:
//   collapse   0    - 0.22  a point of darkness opens on the price line; the line bends round it
//                            (lensPoints) and the candles nearest are swallowed (fxNow's head hides
//                            them) as the horizon grows
//   accretion  0.22 - 0.82  the disk: the chart's own colours -- gold, and the candles' green and
//                            red -- spiralling in, Keplerian (faster inside), Doppler-bright on
//                            the approaching side; the far side arched over and under the shadow;
//                            the photon ring; lensed starlight in arcs round the horizon; the
//                            shadow, black, soft-edged
//   release    0.82 - 1     the hole shrinks to nothing, the disk spins away, the line straightens
//                            and the candles come back
// Screen-space, gradients and strokes under transforms, no clip or composite modes.
function holeOnScreen(view) {
  const b = view.fx?.blackhole;
  if (!b) return null;
  const c = project(b.x, b.y, b.z, view);
  const U = view.unit ?? 8;
  return { c, U, rs: b.rs * U, grow: b.grow };
}
function lensPoints(pts, view) {
  const h = holeOnScreen(view);
  if (!h || h.rs <= 0.5) return pts;
  const rE = h.rs * 1.9;
  return pts.map((p) => {
    const dx = p.x - h.c.x, dy = p.y - h.c.y, r = Math.hypot(dx, dy) || 1e-6;
    const r2 = Math.sqrt(r * r + rE * rE);
    return { x: h.c.x + (dx / r) * r2, y: h.c.y + (dy / r) * r2 };
  });
}
// THE LINE LEANS TOWARD THE PULSAR (operator, 2026-09-20: "Can we have the yellow price line
// bending towards the pulsar if it gets near?"). The black hole's lens pushes the line OUT, away
// from the shadow, because that is what a lens does to a background image; a pulsar is a mass
// passing close by, so this pulls the line IN, toward it -- the same machinery, the opposite
// sign, and it only says anything while the star is actually near the line.
//
// The pull is zero at the star itself, peaks about one star-radius out and dies away beyond --
// so the line bows toward it in a smooth hump rather than kinking at the nearest point -- and
// each point moves at most most of the way to the star, so no part of the line can be dragged
// through it and out the other side.
// THE PASSAGE'S ONE SCALE, in one place: the gas field, the disk, the star's halo, the beam's
// thickness and the bend it puts in the price line are all multiples of this, and the bend lives
// in a different function from the drawing -- so when the operator asks for it bigger (3.2 units
// on 2026-09-20, then 6.4 "at least 2x larger", then 8.5, another third) exactly one number
// moves. Still a share of the board's width, never units alone: the Kiosk's panel is narrower.
const pulsarR = (U, gridW) => U * boundedRadius(8.5, 0.186, gridW);
function pulsarBend(pts, view) {
  const fx = view.fx, p = fx?.pulsar;
  if (!p) return pts;
  const u = fx.u;
  const vis = Math.max(0, Math.min(1, (u - 0.015) / 0.075)) * (1 - Math.max(0, Math.min(1, (u - 0.9) / 0.09)));
  if (vis <= 0.01) return pts;
  const U = view.unit ?? 8;
  const R = pulsarR(U, fx.gridW);
  const c = project(p.px, p.py, p.pz, view);
  // it leans hardest while the star is at its brightest -- the flare's peak drags the most line
  const k = R * 1.15 * vis * Math.min(1.15, 0.55 + 0.6 * Math.min(1, p.bright));
  return pts.map((q) => {
    const dx = c.x - q.x, dy = c.y - q.y, r = Math.hypot(dx, dy);
    if (r < 1e-6) return q;
    const t = r / R;
    const d = Math.min(r * 0.85, k * t / (1 + t * t * t));
    return { x: q.x + (dx / r) * d, y: q.y + (dy / r) * d };
  });
}
function drawBlackHole(ctx, view, lw) {
  const fx = view.fx;
  if (!fx || fx.kind !== 'blackhole') return;
  const h = holeOnScreen(view);
  if (!h || h.rs <= 0.5) return;
  const { c, U, rs, grow } = h;
  const now = view.now ?? 0;
  const disc = (x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); ctx.fill(); };
  const canT = typeof ctx.save === 'function' && typeof ctx.rotate === 'function' && typeof ctx.scale === 'function';
  // THE LOOK OF THE REFERENCE (operator, 2026-09-15, with NASA's still of the disk: "Is there any
  // way we can get it looking closer to this?"): the disk seen well above its plane, not edge-on;
  // a broad continuous body, white-yellow at its inner edge through orange to a dark red rim that
  // fades to nothing; FIBROUS -- hundreds of thin streaks spiralling inward over it, sheared by
  // the Keplerian flow, brightest on the approaching side; the shadow in the middle with a thin
  // photon ring, a gap, and the far side's thin lensed arch hugging it over the top.
  // ...then the Interstellar view (operator, with a second still: "need it to look more like this"):
  // the disk nearly edge-on, a thin band crossing in front of the shadow, the far side thrown
  // into a great arch over the top and a smaller one beneath
  const TILT = 0.04, SQUASH = 0.17;
  const inner = rs * 1.5, outer = rs * 5;     // 6.4 horizons at the largest ("twice as large"), then 5 ("obscuring too much")
  const doppler = (ang) => 0.55 + 0.75 * Math.max(0, Math.cos(ang - Math.PI));   // the left side comes toward us: brightest at ang = pi
  const H = (k) => hash01(fx.seed + k);
  softStops(ctx, c.x, c.y, outer * 1.15, [[0, `rgba(255,170,70,${(0.22 * grow).toFixed(3)})`], [0.5, `rgba(255,130,50,${(0.08 * grow).toFixed(3)})`], [1, 'rgba(255,100,40,0)']]);
  const toScreen = (rr, ang) => {
    const px = rr * Math.cos(ang), py = rr * Math.sin(ang) * SQUASH;
    return { x: c.x + px * Math.cos(TILT) - py * Math.sin(TILT), y: c.y + px * Math.sin(TILT) + py * Math.cos(TILT) };
  };
  // the fibres: thin streaks spiralling inward, each sheared along the flow, in the disk's plane
  const streaks = [];
  for (let k = 0; k < 520; k++) {
    const hk = (q) => hash01(fx.seed + 400 + k * 13 + q);
    const r0 = inner + (outer - inner) * Math.pow(hk(1), 1.3);
    const omega = 0.0016 * Math.pow(inner / r0, 1.5);
    const a0 = hk(2) * Math.PI * 2 + now * omega;
    const span = (0.25 + 0.9 * hk(3)) * Math.pow(inner / r0, 0.4), heat = 1 - (r0 - inner) / (outer - inner);
    streaks.push({ r0, a0, span, heat, w: rs * (0.02 + 0.045 * hk(4)), bright: 0.4 + 0.6 * hk(5), kind: hk(6), k });
  }
  const drawStreaks = (far) => {
    if (!canT) return;
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(TILT); ctx.scale(1, SQUASH); ctx.lineCap = 'round';
    for (const st of streaks) {
      const mid = st.a0 + st.span / 2, isFar = Math.sin(mid) < 0;
      if (isFar !== far) continue;
      const dop = doppler(mid), heat = st.heat;
      const col = st.kind < 0.06 ? '120,240,170' : st.kind < 0.12 ? '255,110,110' : heat > 0.7 ? '255,250,225' : heat > 0.35 ? '255,215,120' : '255,120,50';
      ctx.strokeStyle = `rgba(${col},${(0.7 * grow * st.bright * Math.min(1.2, dop) / 1.2 * (0.35 + 0.65 * heat)).toFixed(3)})`; ctx.lineWidth = st.w * (0.8 + 0.6 * heat);
      ctx.beginPath();
      for (let i = 0; i <= 10; i++) { const t = i / 10, rr = st.r0 * (1 - 0.07 * t), ang = st.a0 + st.span * t; const x = rr * Math.cos(ang), y = rr * Math.sin(ang); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    }
    ctx.restore();
  };
  // --- THE FAR HALF, LIFTED INTO THE ARCH (operator, 2026-09-15: "the disc above is not merging
  // with the sides, and looks really bad" -- the arch was a circle drawn round the shadow while
  // the disk is an ellipse in its own plane, two surfaces that met by accident). The arch IS the
  // far half of the disk now: every point keeps its x on the disk (rr cos ang) and is raised over
  // the top by an amount that grows with its radius -- 1.1 horizons at the inner edge, 2.7 at the
  // outer -- so at the sides, where sin ang -> 0, the arch comes down exactly onto the flat band.
  // The second image under the hole is the same, mirrored, smaller and dimmer.
  const lift = (rr) => rs * (1.1 + 1.6 * (rr - inner) / (outer - inner));
  const farPt = (rr, ang, under) => {
    // the second image is a MIRROR, x as well as y: it turns with the band above it, not against
    // (2026-09-15: "the two discs are spinning in opposite directions")
    // CONTINUOUS INTO THE BAND (2026-09-15: "The transition between the two discs is not steady
    // or continuous"): the arch's height starts at the flat band's own slope (rr * SQUASH per
    // radian) and the lift takes over with |sin|^2.4, so the surface bends smoothly up from the
    // band rather than kinking where the two meet
    const sn = Math.abs(Math.sin(ang)), top = under ? rs * (1.05 + 0.45 * (rr - inner) / (outer - inner)) : lift(rr);
    const sx = Math.cos(ang) * rr * (under ? -0.78 : 1), sy = rr * SQUASH * sn + Math.max(0, top - rr * SQUASH) * Math.pow(sn, 2.4);
    return { x: c.x + sx * Math.cos(TILT) - sy * (under ? 1 : -1) * Math.sin(TILT), y: c.y + sx * Math.sin(TILT) + (under ? sy : -sy) * Math.cos(TILT) };
  };
  // ONE SET OF STRIPS FOR THE WHOLE DISK (operator, 2026-09-15, of a hard line across the middle:
  // "that harsh line does not work"): the near half was a radial gradient in the disk's plane
  // and the arch forty colour strips, and where they met at the midline the two disagreed. The
  // near half is the same strips now, laid on the flat ellipse, so the colour at any radius is
  // the same on both sides of the line and there is no line.
  const archBody = (mode) => {
    // 'ring': ONE CLOSED POLYGON PER STRIP round the whole disk -- the flat mapping over the near
    // half, the lifted mapping over the far -- so there is no interior edge at the midline at all
    // (2026-09-15: "still see harsh line bisecting" -- two fills sharing an edge draw that edge,
    // antialiased twice, however well their colours agree). 'under' is the second image alone.
    const under = mode === 'under';
    const STRIPS = under ? 16 : 40, dim = under ? 0.55 : 1;
    const at = (rr, ang) => (under ? farPt(rr, ang, true) : ang <= Math.PI ? toScreen(rr, ang) : farPt(rr, ang, false));
    const a0 = under ? Math.PI : 0, aSpan = under ? Math.PI : Math.PI * 2, N = under ? 24 : 72;
    // the second image FADES IN FROM THE MIDLINE (2026-09-15: "Still seeing the gradient" -- its
    // top edge lay exactly on the disk's midline): it is drawn in sectors, each at an alpha that
    // rises with |sin| from nothing at the line, so it has no edge there
    const SECT = under ? N : 1;
    for (let k = 0; k < STRIPS; k++) {
      const t0 = k / STRIPS, t1 = (k + 1) / STRIPS, r0 = inner + (outer - inner) * t0, r1 = inner + (outer - inner) * t1, heat = 1 - (t0 + t1) / 2;
      for (let sct = 0; sct < SECT; sct++) {
      const s0 = a0 + (aSpan * sct) / SECT, s1 = a0 + (aSpan * (sct + 1)) / SECT, n = under ? 1 : N;
      const fadeIn = under ? Math.pow(Math.abs(Math.sin((s0 + s1) / 2)), 0.8) : 1;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) { const ang = s0 + ((s1 - s0) * i) / n; const p = at(r1, ang); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
      for (let i = n; i >= 0; i--) { const ang = s0 + ((s1 - s0) * i) / n; const p = at(r0, ang); ctx.lineTo(p.x, p.y); }
      ctx.closePath();
      // bright, never brown: the rim stays a saturated orange rather than a dark red at low alpha
      const R = 255, G = Math.round(95 + 160 * Math.pow(heat, 0.7)), B = Math.round(25 + 200 * Math.pow(heat, 2.2));
      const alpha = grow * dim * fadeIn * (0.55 + 0.42 * Math.pow(heat, 0.8));
      // the Doppler side across the strip: a linear gradient, bright left, dark right
      const dg = typeof ctx.createLinearGradient === 'function' ? ctx.createLinearGradient(c.x - outer, 0, c.x + outer, 0) : null;
      if (dg && typeof dg.addColorStop === 'function') { dg.addColorStop(0, `rgba(${Math.min(255, R)},${Math.min(255, G + 50)},${Math.min(255, B + 70)},${alpha.toFixed(3)})`); dg.addColorStop(0.5, `rgba(${R},${G},${B},${(alpha * 0.85).toFixed(3)})`); dg.addColorStop(1, `rgba(${Math.round(R * 0.7)},${Math.round(G * 0.45)},${Math.round(B * 0.4)},${(alpha * 0.7).toFixed(3)})`); ctx.fillStyle = dg; }
      else ctx.fillStyle = `rgba(${R},${G},${B},${alpha.toFixed(3)})`;
      ctx.fill();
      }
    }
  };
  const archStreaks = (under) => {
    ctx.lineCap = 'round';
    for (const st of streaks) {
      const mid = st.a0 + st.span / 2;
      if (Math.sin(mid) >= 0) continue;                                  // the far half only
      const dop = doppler(mid), heat = st.heat;
      const col = st.kind < 0.06 ? '120,240,170' : st.kind < 0.12 ? '255,110,110' : heat > 0.7 ? '255,250,225' : heat > 0.35 ? '255,215,120' : '255,120,50';
      const fadeIn = under ? Math.pow(Math.abs(Math.sin(mid)), 0.8) : 1;
      ctx.strokeStyle = `rgba(${col},${(0.7 * grow * (under ? 0.5 : 1) * fadeIn * st.bright * Math.min(1.2, dop) / 1.2 * (0.35 + 0.65 * heat)).toFixed(3)})`; ctx.lineWidth = Math.max(lw * 0.8, st.w * (0.8 + 0.6 * heat) * 1.6);
      ctx.beginPath();
      for (let i = 0; i <= 10; i++) { const t = i / 10, rr = st.r0 * (1 - 0.07 * t), ang = st.a0 + st.span * t; const p = farPt(rr, ang, under); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
      ctx.stroke();
    }
  };
  archBody('under'); archStreaks(true);                                 // the second image, under
  // the shadow, then the whole disk over it -- the far half is lifted clear of the shadow, the
  // near half crosses in front of it -- then the fibres, then the photon ring over everything
  softStops(ctx, c.x, c.y, rs * 1.1, [[0, 'rgba(0,0,0,1)'], [0.88, 'rgba(0,0,0,1)'], [1, 'rgba(0,0,0,0)']]);
  archBody('ring');
  archStreaks(false);
  drawStreaks(false);
  ctx.strokeStyle = `rgba(255,245,215,${(0.95 * grow).toFixed(3)})`; ctx.lineWidth = Math.max(lw, rs * 0.045);
  ctx.beginPath(); ctx.arc(c.x, c.y, rs * 1.07, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = `rgba(255,190,100,${(0.45 * grow).toFixed(3)})`; ctx.lineWidth = Math.max(lw * 2, rs * 0.14);
  ctx.beginPath(); ctx.arc(c.x, c.y, rs * 1.11, 0, Math.PI * 2); ctx.stroke();
  // --- lensed starlight: short arcs of white round the horizon, the sky behind bent into rings
  for (let k = 0; k < 26; k++) {
    const hk = (q) => hash01(fx.seed + 800 + k * 7 + q);
    const rr = rs * (1.15 + 1.6 * hk(1)), a0 = hk(2) * Math.PI * 2 + now * 0.00008 * (hk(3) - 0.5), span = 0.08 + 0.35 * hk(4);
    ctx.strokeStyle = `rgba(255,255,255,${(0.45 * grow * (0.4 + 0.6 * hk(5))).toFixed(3)})`; ctx.lineWidth = Math.max(lw * 0.8, U * 0.03);
    ctx.beginPath(); ctx.arc(c.x, c.y, rr, a0, a0 + span); ctx.stroke();
  }
  ctx.lineWidth = lw;
}

// THE PULSAR IN THE WIND, AS THE REFERENCE FILM SHOWS IT (operator, 2026-09-20, of the first
// cut: "the effect is terrible. It needs to look like this" -- NASA's XRISM / BP Crucis concept
// film). What that film actually shows, layer by layer, and what the first cut drew instead:
//
//   the wind    GAS IN MOTION round the star, in thousands of pieces. Two cuts got this wrong
//               before it was a simulation: the first scattered gasCloud spheres and read as grey
//               fog, the second drew sine-shaped polylines and read as wire ribbons (operator:
//               "the winds don't look enough like a particle simulation"). It is particles
//               advected through a flow field now -- see the block below for the field and why
//               each term is the strength it is.
//   the disk    SPIRAL ARMS wound round the star, turning. Not drawn, and not painted on either:
//               each particle carries its own brightness from the lane it entered on, so the
//               bright sheets are made OF the gas and the star's swirl winds them into arms. At
//               the flare's peak the swirl gives way to a radial pull and the arms become infall
//               streaks dropping straight on to the star, which is the break-up XRISM saw -- the
//               gas never turns round, it only stops being able to hold its orbit.
//   the beam    ONE THIN PALE-CYAN RAY threading the star and running off both edges, SWINGING
//               (operator: "The pulsar beam is not swinging back and forth"). A ray on a rotating
//               star: it sweeps, foreshortens as it turns toward us, and flashes as it comes
//               over. The star's beat is that same number, so the two cannot drift apart.
//   the star    a tiny crisp white point in a tight blue-white bloom.
//
// The palette is the film's: indigo gas lit lavender and blue-white where the pulsar reaches it,
// the beam and the core white-cyan. Sizes are bounded by the board's width (boundedRadius),
// because every one of these plays on the Kiosk's small panels too. Soft round fills go through
// softStops (the house rule: no banded gradients); the gas and the beam are plain strokes, which
// do not band. The four acts and the light curve stay in fxNow, which also lights the tiles.
// A frame costs about 2 ms on the Kiosk's candle panel, against the supernova's 23.
// THE PULSAR'S WIND AS GLSL, for the GL renderer's particles (gl2d.js). It is drawPulsar's particle
// block term for term -- the stream, the vortex, the infall, the shock, the two-octave curl field,
// accretion and the wrap, the lanes and the carried banding -- so a change to one is a change to
// both. State: s0 = (x, y, pace m, life ms), s1 = (brightness b, banding f, respawn count, -).
let W_DONE = false;
const PULSAR_GLSL = `
uniform float uR0, uCurl, uSeed, uWind;
uniform vec4 uAxis, uK;              // axis: along (x,y), across (x,y).  K: drift, swirl, pull, shock
uniform vec3 uEddy;                  // strength, phase a, phase b
uniform vec2 uCentre;
float rnd(float id, float n, float k) { return hash3(id, n + uSeed * 4099.0, k); }
void spawn(inout vec4 s0, inout vec4 s1, float id, bool seeded) {
  float n = s1.z + 1.0, Rf = uR0 * 7.0;
  float along = seeded ? (rnd(id, n, 1.0) * 2.0 - 1.0) * Rf : -Rf * (0.95 + 0.25 * rnd(id, n, 1.0));
  float bunch = (rnd(id, n, 2.0) + rnd(id, n, 3.0) + rnd(id, n, 4.0)) / 1.5 - 1.0;
  float lane = floor(bunch * 40.0 + 0.5) / 40.0;
  float across = lane * Rf * 0.6 + (rnd(id, n, 5.0) - 0.5) * Rf * 0.02;
  s0.xy = uAxis.xy * along + uAxis.zw * across;
  s0.z = 0.55 + 0.9 * rnd(id, n, 6.0);
  s0.w = 0.0;
  float band = 0.5 + 0.5 * sin(lane * 47.0 + rnd(id, n, 8.0) * 0.5);
  s1 = vec4(0.35 + 0.65 * rnd(id, n, 7.0), 0.12 + 0.88 * band * band, n, 0.0);
}
void simulate(inout vec4 s0, inout vec4 s1, float id, float dt, bool init) {
  if (init) { spawn(s0, s1, id, true); return; }
  float R0 = uR0, Rf = R0 * 7.0, L1 = R0 * 1.15, L2 = R0 * 3.1;
  vec2 q = s0.xy;
  float r = max(length(q), 0.001);
  float g = R0 * R0 / (r * r + R0 * R0 * 1.6), g3 = g * g * g;
  vec2 u = q / r;
  float ex = -(sin(q.x / L1 + uEddy.y) * sin(q.y / L1 + uEddy.z)) / L1 - 0.7 * (sin(q.x / L2 - uEddy.z) * sin(q.y / L2 + uEddy.y)) / L2;
  float ey = (cos(q.x / L1 + uEddy.y) * cos(q.y / L1 + uEddy.z)) / L1 + 0.7 * (cos(q.x / L2 - uEddy.z) * cos(q.y / L2 + uEddy.y)) / L2;
  float eddy = uEddy.x * R0;
  vec2 v = uAxis.xy * uK.x + eddy * vec2(ex, ey) + vec2(-u.y, u.x) * uCurl * uK.y * g - u * uK.z * g + u * uK.w * g3;
  q += v * s0.z * dt;
  s0.w += dt;
  if (length(q) < R0 * 0.16 || s0.w > 90000.0) { spawn(s0, s1, id, false); return; }
  float along = dot(q, uAxis.xy), across = dot(q, uAxis.zw);
  if (abs(along) > Rf) along -= sign(along) * 2.0 * Rf;
  if (abs(across) > Rf * 0.75) across -= sign(across) * 1.5 * Rf;
  s0.xy = uAxis.xy * along + uAxis.zw * across;
}
vec4 look(vec4 s0, vec4 s1, int pass, out vec2 centre, out float radius) {
  float R0 = uR0, Rf = R0 * 7.0;
  vec2 q = s0.xy;
  float near = 1.0 / (1.0 + pow(length(q) / (R0 * 2.4), 2.0));
  float la = abs(dot(q, uAxis.xy)) / Rf, lc = abs(dot(q, uAxis.zw)) / (Rf * 0.75);
  float edge = max(0.0, (1.0 - la * la) * (1.0 - lc * lc * lc));
  float b = clamp(s1.x * s1.y * edge * (0.2 + 0.8 * near) * uWind * 1.9, 0.0, 0.999);
  centre = uCentre + q;
  if (b < 0.03) { radius = 0.0; return vec4(0.0); }
  vec3 col = vec3(58.0 + 150.0 * b, 64.0 + 152.0 * b, 142.0 + 106.0 * b) / 255.0;
  // two passes, as the strokes are: the broad dim halo that gives the gas volume, then its grain
  if (pass == 0) { radius = R0 * (0.04 + 0.09 * b) * 0.5; return vec4(col, 0.025 + 0.09 * b); }
  radius = max(0.8, R0 * (0.009 + 0.018 * b)) * 0.5;
  return vec4(col, 0.18 + 0.72 * b);
}`;

function drawPulsar(ctx, view, lw) {
  const fx = view.fx;
  if (!fx || fx.kind !== 'pulsar' || !fx.pulsar) return;
  const p = fx.pulsar, U = view.unit ?? 8, now = view.now ?? 0, u = fx.u;
  const c = project(p.px, p.py, p.pz, view);
  const H = (k) => hash01(fx.seed + 100 + k);
  // the star and its beam are there for the whole crossing -- they fly in, pass through the
  // stream and leave; the wind and the disk only exist while the pulsar is inside the stream
  const vis = edge01(u, 0.015, 0.09) * (1 - edge01(u, 0.9, 0.99));
  const wind = p.inStream * vis;
  if (vis <= 0.01) return;
  // the star's scale, and with it the whole passage (pulsarR): 3.2 units at first, then "at
  // least 2x larger in size on the markets view", then a third again on top (2026-09-20)
  const R0 = pulsarR(U, fx.gridW);
  // THE GAS DOUBLED, THE STAR DID NOT: a pulsar is a point, and a bloom drawn at twice the scale
  // is a white ball with a ray through it. The star's own halo and the beam's thickness keep
  // close to the size they had, so the passage grew without the thing at the middle of it
  // turning into a blob. (Its LENGTH is unchanged -- the beam always crossed the board.)
  const Rs = R0 * 0.62;
  // THE FLOW, TAKEN FROM THE BOARD, NOT ASSUMED: the stream runs from one edge's height to the
  // other's, so its direction on screen is the projection of two points along it. Everything in
  // the wind lies on this axis; the beam does not (in the film the ray and the wind plainly do
  // not share an orientation).
  const streamY = (gx) => p.sa + (p.sb - p.sa) * (gx / (fx.gridW || 1));
  const a0 = project(p.px - 3, streamY(p.px - 3), p.pz, view);
  const a1 = project(p.px + 3, streamY(p.px + 3), p.pz, view);
  let ax = a1.x - a0.x, ay = a1.y - a0.y;
  const alen = Math.hypot(ax, ay) || 1; ax /= alen; ay /= alen;
  const qx = -ay, qy = ax;                                          // across the stream
  // A THREAD IS A CURVE, NOT A ZIG-ZAG: the first pass of this rewrite drew the strands as plain
  // polylines and they came out as EKG traces -- every sample point a visible corner. The samples
  // are control points instead, the line running through their midpoints as quadratics, which is
  // the cheap standard way to get a smooth curve out of a sampled path and costs nothing here.
  const stroke = (pts, w, col, a) => {
    if (!(a > 0.004) || pts.length < 2) return;
    ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${a.toFixed(3)})`;
    ctx.lineWidth = Math.max(0.35, w); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2 || typeof ctx.quadraticCurveTo !== 'function') {
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    } else {
      for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
      ctx.quadraticCurveTo(pts[pts.length - 2].x, pts[pts.length - 2].y, pts[pts.length - 1].x, pts[pts.length - 1].y);
    }
    ctx.stroke();
  };
  // THE WIND IS A PARTICLE SIMULATION, NOT A DRAWING OF ONE (operator, 2026-09-20: "the winds
  // don't look enough like a particle simulation"). The pass before this drew the threads as
  // sine-shaped polylines -- a picture of a flow, which reads as ribbons however finely it is
  // stroked, because nothing in it is actually moving through a field. So the gas is particles
  // now: a few thousand of them, held on the effect (`fx._wind`, the way the plume layer is
  // held), each ADVECTED every frame through the flow field the pulsar makes in the wind:
  //
  //   the stream     a steady drift along the board's stream axis -- the companion's wind
  //   the vortex     a tangential term round the star, falling off with distance, turning the
  //                  way the act turns: one way as the disk spins up, the other after it rebuilds
  //   the infall     a radial pull, gentle while there is a disk and overwhelming at the flare's
  //                  peak, which is exactly the break-up XRISM saw: the gas stops orbiting and
  //                  drops straight in
  //   the shock      a short outward push very close in, so the flow parts round the star
  //                  instead of every particle piling on to the point
  //
  // The spiral arms are not drawn either: each particle carries the brightness of the lane it
  // entered on, so the bright sheets are made OF the gas and the swirl winds them into arms. A
  // particle dies when it reaches the star (accreted) or leaves the field, and is respawned
  // upstream, so the count is steady. The swirl's SIGN is fixed for the whole passage (fxNow's
  // `spin`): the acts change how hard it turns and how hard it falls in, never which way.
  //
  // COST: the particles are stroked in BRIGHTNESS BUCKETS -- one path per bucket, a few thousand
  // little motion-blur segments in a dozen strokes -- because a stroke per particle is what would
  // actually cost something. The state is kept in the star's own frame (offsets from it), so the
  // pulsar flies through the gas rather than towing it along.
  {
    const curl = p.spin || 1;                                       // one direction, flipped at the middle
    const Rf = R0 * 7;                                              // how far the gas is simulated
    // THE COUNT IS THE PICTURE. Drawn as streaks, a few thousand of these filled the frame and
    // what you saw was the shape of each streak; drawn as dots, what you see is where the dots
    // are DENSE -- and density needs numbers. Fifteen thousand, which is affordable because the
    // field they move through is evaluated off a sine table (`fastSin`) rather than Math.sin,
    // and because they are stroked as one path per brightness bucket.
    const N = 27000;                                                // 20000 + 35% (2026-09-20, operator)
    const keep = p.store || fx;                                     // the run's record: it outlives the frame
    // ON THE GL RENDERER THE GAS LIVES ON THE CARD (gl2d.js particles; PULSAR_GLSL below is this
    // block's physics, term for term): nothing per particle happens here, and nothing is uploaded.
    // Same field, same lanes, same carried banding; its dice are the card's own, so it is the same
    // wind and not the same dots. The numbers the field needs each frame are all it is sent.
    if (ctx.gl2d === true) {
      const G = (keep._windGl ??= { t: now });
      const dtG = Math.max(0, Math.min(48, now - G.t)); G.t = now;
      const Ug = U;
      if (ctx.particles({
        key: keep, count: N, glsl: PULSAR_GLSL, passes: 2, dt: dtG, draw: wind > 0.02,
        uniforms: {
          uR0: R0, uAxis: [ax, ay, qx, qy], uCentre: [c.x, c.y], uCurl: curl, uSeed: (fx.seed % 1000) + 1,
          uK: [Ug * 0.0045, Ug * 0.022 * (0.55 + 0.95 * Math.max(p.disk1, p.disk2)) * p.inStream, Ug * 0.012 * (1 + 2.5 * p.direct), Ug * 0.007],
          uEddy: [Ug * 0.0026, now * 0.00021 + H(11) * 6.3, now * -0.00014 + H(12) * 6.3], uWind: wind,
        },
      })) W_DONE = true;
    }
    if (W_DONE) { W_DONE = false; } else {
    let W = keep._wind;
    if (!W || W.R0 !== R0) W = keep._wind = { t: now, R0, n: 0, ps: [] };
    const hw = () => { W.n = (W.n + 1) >>> 0; return hash01(fx.seed + 1300 + W.n * 7.7); };
    // upstream, anywhere across the field: where the gas comes in from
    const spawn = (q, seeded) => {
      const along = seeded ? (hw() * 2 - 1) * Rf : -Rf * (0.95 + 0.25 * hw());
      // ON STREAMLINES, NOT SCATTERED: everything spawned on a lane follows the same path, so the
      // dots string out nose to tail along it and the eye reads a filament rather than noise --
      // which is what the film's wind is made of.
      // THE PULSAR PLOUGHS THROUGH THE WIND; IT DOES NOT FLY DOWN A CORRIDOR OF IT (operator,
      // 2026-09-20: "the winds are too far away from the pulsar at times ... not having them
      // running across the top and bottom"). Spread evenly across the field, the gas nearest the
      // star is the gas that gets eaten, so the middle empties and what is left are two bands
      // along the top and bottom with the pulsar flying between them. The lanes are bunched
      // toward the middle instead -- three draws averaged, which piles them on the star's own
      // path -- so the densest gas is exactly the gas it is flying into.
      const bunch = (hw() + hw() + hw()) / 1.5 - 1;                   // -1..1, heaped at 0
      const lane = Math.round(bunch * 40) / 40;                       // still on shared streamlines
      const across = lane * Rf * 0.6 + (hw() - 0.5) * Rf * 0.02;
      q.x = ax * along + qx * across; q.y = ay * along + qy * across;
      q.m = 0.55 + 0.9 * hw();                                      // its own pace through the field
      q.b = 0.35 + 0.65 * hw();                                     // and its own brightness
      // THE BANDING IS CARRIED, NOT PAINTED ON. Lighting the gas by a pattern in SPACE draws that
      // pattern -- the flow slides through it and the bands stay put, which is how a ring ends up
      // round the star and blotches end up in the wind. This is a property of the particle
      // itself, fixed when it enters: neighbours on a lane share it, so the bright sheets are
      // made of gas, and when the star winds that gas up the sheets wind up with it. Dye in a
      // fluid, not a stencil over it.
      q.f = 0.12 + 0.88 * (0.5 + 0.5 * Math.sin(lane * 47 + hw() * 0.5)) ** 2;
      q.life = 0;
      return q;
    };
    if (!W.ps.length) for (let i = 0; i < N; i++) W.ps.push(spawn({}, true));
    // THE CLOCK IS CLAMPED: a test steps this loop in 700 ms jumps and a backgrounded tab in
    // whole seconds; an unclamped dt would teleport every particle through the star in one step
    const dt = Math.max(0, Math.min(48, now - W.t)); W.t = now;
    const drift = U * 0.0045;                                       // the stream, px/ms
    // FAST GAS IS THIN GAS: a steady flow's density goes as one over its speed, so the first
    // swirl -- eighteen times the drift speed close in -- scoured a clean hole round the star and
    // left the disk as a ring of void. The swirl is a few times the drift now, and it comes with
    // a steady inward pull, so the gas spirals IN and piles up where the film is brightest.
    // and the pull has to keep up with the swirl, or the gas simply ORBITS: at a tenth of the
    // tangential speed it circled the star at a fixed radius and drew a hard bright annulus, a
    // marble rather than an accretion. It spirals in and is eaten now, which is also why there is
    // always room for the wind behind it.
    // and the swirl never goes all the way out, or the gas stops turning at the break-up and the
    // eddies decide which way it goes instead -- which is what made the rotation look as though
    // it changed its mind. It drops to a little over half through the break-up rather than to
    // nothing, with the infall laid over the top of it.
    const swirlK = U * 0.022 * (0.55 + 0.95 * Math.max(p.disk1, p.disk2)) * p.inStream;
    const pullK = U * 0.012 * (1 + 2.5 * p.direct);
    // THE SHOCK IS A NUDGE, NOT A WALL: at the strength the first cut used (and falling off as
    // slowly as the swirl) it swept a clean round bubble out of the gas and the star sat in a
    // hole. It falls off as the cube of the reach now, so it only parts the flow that is nearly
    // on top of the star.
    const shockK = U * 0.007;
    // THE EDDIES ARE A CURL FIELD NOW, NOT TWO SINES ADDED TO THE DRIFT. Sines pushed the gas
    // about but left its PATH locally straight -- a particle crossing one is deflected, not
    // turned -- so the wisps stayed dashes (operator: "too much like lines instead of curving
    // paths"). A curl field is the perpendicular gradient of a stream function: its flow lines
    // are closed loops, every one of them curved, and a particle in it is always turning. Two
    // octaves, both slowly drifting, so the wind is a field of soft rolling eddies the pulsar
    // flies through.
    // and it is a SECOND-ORDER term, about a third of the drift: at the strength the first curl
    // cut used, the eddies stopped bending the wind and started BEING the wind -- the gas piled
    // into the rolls and left the pulsar sitting in a clean void, which is the opposite of what it
    // is for. The wind still blows through; it just does not blow straight.
    const eddyK = U * 0.0026, L1 = R0 * 1.15, L2 = R0 * 3.1;
    const eA = now * 0.00021 + H(11) * 6.3, eB = now * -0.00014 + H(12) * 6.3;
    // the buckets: ten bands of brightness, each stroked once
    const BK = 10, paths = [];
    for (let i = 0; i < BK; i++) paths.push([]);
    for (const q of W.ps) {
      const r = Math.hypot(q.x, q.y) || 0.001;
      const g = R0 * R0 / (r * r + R0 * R0 * 1.6);                  // the star's reach, softened at the core
      const ux = q.x / r, uy = q.y / r;
      const g3 = g * g * g;
      // the curl of the two-octave stream function psi = sin(x/L + a)cos(y/L + b): the velocity
      // is (dpsi/dy, -dpsi/dx), which cannot diverge -- it can only roll
      const s1x = fastSin(q.x / L1 + eA), c1x = fastCos(q.x / L1 + eA);
      const s1y = fastSin(q.y / L1 + eB), c1y = fastCos(q.y / L1 + eB);
      const s2x = fastSin(q.x / L2 - eB), c2x = fastCos(q.x / L2 - eB);
      const s2y = fastSin(q.y / L2 + eA), c2y = fastCos(q.y / L2 + eA);
      const ex = -(s1x * s1y) / L1 - 0.7 * (s2x * s2y) / L2;
      const ey = (c1x * c1y) / L1 + 0.7 * (c2x * c2y) / L2;
      const eddy = eddyK * R0;                                       // the field's own scale
      const vx = ax * drift + eddy * ex + (-uy) * curl * swirlK * g - ux * pullK * g + ux * shockK * g3;
      const vy = ay * drift + eddy * ey + (ux) * curl * swirlK * g - uy * pullK * g + uy * shockK * g3;
      q.px = q.x; q.py = q.y;
      q.x += vx * q.m * dt; q.y += vy * q.m * dt;
      q.life += dt;
      // ACCRETED, OR ROUND AGAIN: gas that reaches the star is gone (respawned upstream, which is
      // the only place new gas comes from); gas that simply leaves the field WRAPS to the far
      // side, because a stellar wind is not a puff -- it keeps blowing, and respawning the
      // stragglers one by one instead left the upstream half of the board visibly empty.
      let r2 = Math.hypot(q.x, q.y);
      if (r2 < R0 * 0.16 || q.life > 90000) { spawn(q, false); continue; }
      let along = q.x * ax + q.y * ay, across = q.x * qx + q.y * qy;
      if (Math.abs(along) > Rf || Math.abs(across) > Rf * 0.75) {
        if (Math.abs(along) > Rf) along -= Math.sign(along) * 2 * Rf;
        if (Math.abs(across) > Rf * 0.75) across -= Math.sign(across) * 1.5 * Rf;
        q.x = ax * along + qx * across; q.y = ay * along + qy * across;
        r2 = Math.hypot(q.x, q.y);
      }
      if (wind <= 0.02) continue;                                   // simulated on, drawn only in the stream
      const near = 1 / (1 + (r2 / (R0 * 2.4)) ** 2);
      // THE BOX MUST NOT SHOW: the gas wraps in a rectangle around the flow, and a rectangle's
      // corners were plainly visible as straight edges in the wind. Every particle fades toward
      // the box's walls, so the seam it wraps across is already dark when it crosses.
      const la = Math.abs(q.x * ax + q.y * ay) / Rf, lc = Math.abs(q.x * qx + q.y * qy) / (Rf * 0.75);
      const edge = Math.max(0, (1 - la * la) * (1 - lc * lc * lc));
      // THE FILAMENTS ARE DENSITY, NOT SHAPE: a field of evenly lit dots is sand, whatever it is
      // doing. The carried banding (q.f) is what makes it fibrous -- structure drawn by WHICH
      // dots are lit, with not a line anywhere in it.
      const b = Math.max(0, Math.min(0.999, q.b * q.f * edge * (0.2 + 0.8 * near) * wind * 1.9));
      if (b < 0.03) continue;
      const path = paths[Math.min(BK - 1, Math.floor(b * BK))];
      // A PARTICLE IS A POINT. Every cut before this one drew it as a streak -- velocity times
      // seven, then two chasing points, then a curve through six breadcrumbs -- and every one of
      // them read as what it was (operator, three times over: "too much like lines", "line
      // segments when accreting", "Still looks too much like lines and not a particle field").
      // A motion-blur streak IS a line, however well it follows the path. So there are no trails
      // at all now: each particle is a dot, and there are enough of them that the STRUCTURE --
      // the filaments, the spiral, the infall -- is drawn by where the dots are dense, not by
      // what shape each one is. That is what a particle field looks like.
      path.push(c.x + q.x, c.y + q.y);
    }
    for (let i = 0; i < BK; i++) {
      const path = paths[i];
      if (!path.length) continue;
      const b = (i + 0.5) / BK;
      // cool indigo out in the wind, blue-white where the pulsar lights it. Two passes: a broad
      // dim halo that gives the gas volume, and the grain of the dust over it.
      // it never reaches white: gas lit by a pulsar is blue-violet, and a field of white specks
      // reads as a starfield sitting on top of the board rather than as something in front of it
      const col = [Math.round(58 + 150 * b), Math.round(64 + 152 * b), Math.round(142 + 106 * b)];
      // A DOT IS A ZERO-LENGTH SEGMENT WITH A ROUND CAP, and thousands of them go into ONE path
      // and one stroke. Drawing each as its own arc or fillRect is thousands of canvas calls a
      // frame; this is two, and the cap makes every one of them a circle of exactly lineWidth.
      ctx.lineCap = 'round';
      for (const [wide, al] of [[R0 * (0.04 + 0.09 * b), 0.025 + 0.09 * b], [Math.max(0.8, R0 * (0.009 + 0.018 * b)), 0.18 + 0.72 * b]]) {
        ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${al.toFixed(3)})`;
        ctx.lineWidth = wide;
        ctx.beginPath();
        for (let k = 0; k < path.length; k += 2) { ctx.moveTo(path[k], path[k + 1]); ctx.lineTo(path[k] + 0.01, path[k + 1]); }
        ctx.stroke();
      }
    }
    }
  }
  // THE BEAM SWINGS (operator, 2026-09-20: "The pulsar beam is not swinging back and forth"). A
  // pulsar's beam is a searchlight on a rotating star, and the first cut pinned it at one fixed
  // diagonal, which is the one thing about a pulsar everybody already knows is wrong.
  //
  // It is a ray turning in THREE dimensions here, not an angle wobbling in two: the axis sweeps
  // round a cone, so on screen the ray swings across the board, FORESHORTENS as it turns toward
  // us (a long ray becomes a short stub), and FLASHES as it comes over -- the lighthouse. The
  // star's own beat is the same number, so the point flares exactly when the beam points at us
  // instead of ticking to a clock of its own.
  const spin = now * 0.0016 + H(5) * 6.3;
  const cone = 0.62;                                                // how far off the spin axis the beam sits
  const b3x = Math.cos(spin), b3y = cone, b3z = Math.sin(spin);     // in the spin axis's own frame
  const tiltA = (0.22 + 0.56 * H(4)) * Math.PI * (H(9) < 0.5 ? 1 : -1);   // where that axis lies on the board
  const cta = Math.cos(tiltA), sta = Math.sin(tiltA);
  const bnx = b3x * cta - b3y * sta, bny = b3x * sta + b3y * cta;
  const bscreen = Math.hypot(bnx, bny) || 1e-6;
  const bx = bnx / bscreen, by = bny / bscreen;
  const facing = Math.abs(b3z);                                     // 1 when it points at us (or away)
  const flash = 0.3 + 0.7 * Math.pow(facing, 4);
  {
    const L = U * boundedRadius(30, 1.05, fx.gridW) * (0.25 + 0.75 * bscreen);   // foreshortened
    const lit = Math.min(1.2, p.bright) * (0.45 + 0.75 * flash) * vis;
    const SEG = 9;
    for (const side of [-1, 1]) {
      for (let i = 0; i < SEG; i++) {
        const d0 = (i / SEG) * L, d1 = ((i + 1) / SEG) * L;
        const fade = Math.pow(1 - i / SEG, 1.3);
        const pts = [{ x: c.x + bx * d0 * side, y: c.y + by * d0 * side }, { x: c.x + bx * d1 * side, y: c.y + by * d1 * side }];
        stroke(pts, Rs * 0.62 * (0.3 + 0.7 * fade), [76, 126, 196], 0.09 * lit * fade);
        stroke(pts, Rs * 0.2 * (0.35 + 0.65 * fade), [150, 200, 246], 0.22 * lit * fade);
        stroke(pts, Math.max(0.8, Rs * 0.055), [236, 248, 255], 0.8 * lit * fade);
      }
    }
  }
  // THE PULSAR: a tiny crisp white point in a tight blue-white bloom, its brightness the light
  // curve with the lighthouse beat riding on it
  const beat = flash;                                                 // the beam coming over, not a clock of its own
  const glow = Math.min(1, p.bright) * (0.5 + 0.5 * beat) * vis;
  if (glow > 0.02) {
    softStops(ctx, c.x, c.y, Rs * (2 + 0.5 * beat), [[0, `rgba(150,190,240,${(0.12 * glow).toFixed(3)})`], [1, 'rgba(96,140,210,0)']]);
    softStops(ctx, c.x, c.y, Rs * (1.5 + 0.35 * beat), [[0, `rgba(206,232,255,${(0.6 * glow).toFixed(3)})`], [0.28, `rgba(150,190,240,${(0.26 * glow).toFixed(3)})`], [1, 'rgba(110,150,215,0)']]);
    // THE POINT IS NEVER DIMMER THAN ITS OWN RAY: on the approach the light curve is at its floor,
    // and with the core scaled by it too the frame was a hairline of beam with no star at the end
    // of it. The core holds a crisp white whenever the pulsar is on screen at all.
    const core = vis * Math.min(1, 0.55 + 0.45 * glow);
    softStops(ctx, c.x, c.y, Rs * (0.34 + 0.16 * beat), [[0, `rgba(255,255,255,${core.toFixed(3)})`], [0.5, `rgba(226,242,255,${(0.7 * core).toFixed(3)})`], [1, 'rgba(190,220,255,0)']]);
  }
  ctx.lineWidth = lw;
}
// an edge fade (0 at a, 1 at b), used by the pulsar's passage
function edge01(v, a, b) { return Math.max(0, Math.min(1, (v - a) / (b - a))); }

// A STAR'S GLINT (for the supernova's progenitor; 2026-09-15, operator: "The flashing dot as a
// supernova looks bad. The star is blue-shifted before it blows up. Can we have a better glint
// effect there?"). A soft halo, a hot core, four long diffraction spikes and two shorter
// diagonals, each a gradient fading to its tip, all of it twinkling on the clock; `col` is the
// star's colour and `f` its strength. Gradients only.
function starGlint(ctx, x, y, size, col, f, now, lw) {
  if (f <= 0.003) return;
  const c = col.join(','), tw = 0.85 + 0.15 * Math.sin(now * 0.017) * Math.sin(now * 0.031 + 1);
  const grad = (r, stops) => { const g = typeof ctx.createRadialGradient === 'function' ? ctx.createRadialGradient(x, y, 0, x, y, r) : null; if (!g || typeof g.addColorStop !== 'function') return stops[0][1]; for (const [o, cc] of stops) g.addColorStop(o, cc); return g; };
  const lin = (x0, y0, x1, y1, stops) => { const g = typeof ctx.createLinearGradient === 'function' ? ctx.createLinearGradient(x0, y0, x1, y1) : null; if (!g || typeof g.addColorStop !== 'function') return stops[1][1]; for (const [o, cc] of stops) g.addColorStop(o, cc); return g; };
  ctx.fillStyle = grad(size * 3, [[0, `rgba(255,255,255,${(0.9 * f * tw).toFixed(3)})`], [0.12, `rgba(${c},${(0.7 * f * tw).toFixed(3)})`], [0.4, `rgba(${c},${(0.18 * f).toFixed(3)})`], [1, `rgba(${c},0)`]]);
  ctx.beginPath(); ctx.arc(x, y, size * 3, 0, Math.PI * 2); ctx.fill();
  const spikes = [[0, 1, 0.09], [Math.PI / 2, 1, 0.09], [Math.PI / 4, 0.45, 0.05], [-Math.PI / 4, 0.45, 0.05]];
  for (const [ang, len, w] of spikes) {
    const L = size * 9 * len * tw, x0 = x - Math.cos(ang) * L, y0 = y - Math.sin(ang) * L, x1 = x + Math.cos(ang) * L, y1 = y + Math.sin(ang) * L;
    ctx.strokeStyle = lin(x0, y0, x1, y1, [[0, `rgba(${c},0)`], [0.5, `rgba(255,255,255,${(0.85 * f * tw).toFixed(3)})`], [1, `rgba(${c},0)`]]);
    ctx.lineWidth = Math.max(lw * 0.8, size * w); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = lin(x0, y0, x1, y1, [[0, `rgba(${c},0)`], [0.5, `rgba(${c},${(0.4 * f).toFixed(3)})`], [1, `rgba(${c},0)`]]);
    ctx.lineWidth = Math.max(lw * 2, size * w * 3.5); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.fillStyle = `rgba(255,255,255,${(f * tw).toFixed(3)})`; ctx.beginPath(); ctx.arc(x, y, size * 0.45, 0, Math.PI * 2); ctx.fill();
}

// A VOLUME OF GAS (for the supernova's debris, the fireworks' smoke, the pulsar's wind; 2026-09-15).
// `n` blobs with fixed places in the unit sphere -- radius biased toward the rim, so the limb reads
// brighter, the way a shell does when seen through -- projected with the sphere's depth kept: the
// blobs are drawn back to front, the back ones darker, the front ones paler and hotter. The whole
// thing expands homologously (every blob's distance in proportion to its own), grows, boils
// slowly on the clock, and cools from `rc` toward `dark` as `f` runs 0..1. No strokes: gradients.
// ORGANIC, NOT CIRCULAR (operator, 2026-09-15: "Everything is too circular RN. It needs to look
// more organic like the video"): the blobs gather in CLUMPS rather than spreading evenly, each is
// an ELLIPSE stretched along its own radial line (a streak of gas blown outward) and turned to
// it, and the sphere's silhouette is LUMPY -- every blob's radius carries a low-order wobble by
// its direction, so the cloud has lobes and bays rather than an outline. `colorAt(front, f, H)`,
// if given, decides each blob's colour from its depth, the run and its own hashes.
const GAS_BLOBS = new Map();
function gasBlobs(seed, n, stretchMax) {
  const key = `${seed}|${n}|${stretchMax}`;
  const had = GAS_BLOBS.get(key);
  if (had) return had;
  const blobs = [];
  const clumps = Math.max(4, Math.round(n / 14));
  const cdir = [];
  for (let q = 0; q < clumps; q++) { const H = (k) => hash01(seed + 900 + q * 17 + k); cdir.push({ th: H(1) * Math.PI * 2, ph: Math.acos(2 * H(2) - 1), w: 0.35 + 0.5 * H(3) }); }
  const lumpA = hash01(seed + 77) * Math.PI * 2, lumpB = hash01(seed + 78) * Math.PI * 2;
  for (let k = 0; k < n; k++) {
    const H = (q) => hash01(seed + 5000 + k * 37 + q);
    const cl = cdir[Math.floor(H(6) * clumps)];
    // a gaussian-ish scatter round the clump's direction, wider for some clumps
    const th = cl.th + (H(2) + H(7) - 1) * cl.w * 1.6, ph = Math.max(0.05, Math.min(Math.PI - 0.05, cl.ph + (H(3) + H(8) - 1) * cl.w * 1.2));
    const lump = 1 + 0.22 * Math.sin(3 * th + lumpA) * Math.sin(2 * ph + lumpB) + 0.14 * Math.sin(5 * th - lumpB) + 0.1 * Math.cos(4 * ph + lumpA);
    const rho = (0.3 + 0.7 * Math.sqrt(H(1))) * lump;
    blobs.push({ x: rho * Math.sin(ph) * Math.cos(th), y: rho * Math.sin(ph) * Math.sin(th), z: rho * Math.cos(ph), s: 0.16 + 0.2 * H(4), w: H(5) * Math.PI * 2, stretch: 1 + (stretchMax - 1) * (0.3 + 0.7 * H(9)), H, k });
  }
  blobs.sort((a, b) => a.z - b.z);                                       // back to front
  if (GAS_BLOBS.size >= 64) GAS_BLOBS.delete(GAS_BLOBS.keys().next().value);
  GAS_BLOBS.set(key, blobs);
  return blobs;
}
function gasCloud(ctx, cx, cy, shell, f, now, seed, bright, rc, grad, disc, n = 150, dark = [90, 20, 25], colorAt = null, blobScale = 1, stretchMax = 2.4) {
  // THE CLOUD'S SHAPE IS ITS SEED'S: where each puff sits, how big, how stretched, in what order --
  // none of it moves with the clock, and it was being hashed out and sorted again every frame for
  // every cloud on screen (8% of a supernova's frame). Made once a seed, kept a while.
  const blobs = gasBlobs(seed, n, stretchMax);
  const canTransform = typeof ctx.save === 'function' && typeof ctx.rotate === 'function' && typeof ctx.scale === 'function';
  for (const b of blobs) {
    const wob = 0.035 * Math.sin(now * 0.0013 + b.w) + 0.02 * Math.sin(now * 0.0029 + b.k);
    const x = cx + (b.x + wob) * shell, y = cy + (b.y - wob * 0.6) * shell * 0.85;
    const r = shell * b.s * (0.8 + 0.7 * f) * blobScale;
    const front = (b.z + 1) / 2;                                         // 0 at the back, 1 at the front
    let col, core;
    if (colorAt) { col = colorAt(front, f, b.H); core = col.map((v) => Math.round(v + (255 - v) * 0.45)); }
    else {
      const heat = Math.max(0, Math.min(1, 0.5 + 0.55 * front - 0.45 * f));
      col = rc.map((v, i) => Math.round(dark[i] + (v - dark[i]) * heat));
      core = col.map((v) => Math.round(v + (255 - v) * 0.5 * heat));
    }
    const a = bright * (0.32 + 0.3 * front) * (1 - 0.25 * f);
    if (a < 0.004) continue;
    // (on the GL renderer a stop's colour goes over as numbers -- gl2d.js addColorStop -- instead of
    // being printed as a string for it to read back, three times a puff)
    const C = ctx.gl2d === true ? (c3, al) => [c3[0], c3[1], c3[2], Math.max(0, Math.min(1, al))] : (c3, al) => `rgba(${c3.join(',')},${al.toFixed(3)})`;
    if (canTransform) {
      const ang = Math.atan2(y - cy, x - cx);                            // stretched along its own radial line
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.scale(b.stretch, 1 / Math.sqrt(b.stretch));
      ctx.fillStyle = grad(0, 0, r, [[0, C(core, a)], [0.45, C(col, a * 0.7)], [1, C(col, 0)]]);
      ctx.beginPath(); ctx.arc(0, 0, Math.max(0.5, r), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else softStops(ctx, x, y, r, [[0, `rgba(${core.join(',')},${a.toFixed(3)})`], [0.45, `rgba(${col.join(',')},${(a * 0.7).toFixed(3)})`], [1, `rgba(${col.join(',')},0)`]]);
  }
  // the limb: a soft brightening at the sphere's edge
  const R = shell * 1.02;
  softStops(ctx, cx, cy, R, [[0, `rgba(${rc.join(',')},0)`], [0.78, `rgba(${rc.join(',')},0)`], [0.92, `rgba(${rc.join(',')},${(0.16 * bright).toFixed(3)})`], [1, `rgba(${rc.join(',')},0)`]]);
}

// A SUPERNOVA (operator, 2026-09-15: "build the supernova" -- the solar flare only ever lit a cube
// and its neighbours, and on a chart of candles that was one candle blinking). MODELLED ON NASA
// GODDARD'S ANIMATION (svs.gsfc.nasa.gov/20413, the operator's reference, 2026-09-15: "Look at
// this video of the explosive supernova. Model something similar"): a star, a blinding flash
// that whites out the whole picture, a turbulent debris cloud of knots and filaments expanding
// and reddening as it dims, and, as the cloud thins, a PULSAR -- a point of light pulsing at the
// centre inside a small blue pulsar-wind nebula that grows. Drawn on both boards, on the same
// star fxAt lights (fxHash(seed + 7, 8)), whose shockwave throws the candles it crosses:
//   ignition     0    - 0.12  the star swells white-hot, crackle rising over it
//   breakout     0.12 - 0.34  the white-out: the whole picture goes white and comes back (no flare)
//   debris       0.14 - 1     the cloud: a volume of gas (gasCloud), a sphere of soft blobs
//                             carried out by the expansion, white-gold, orange, then deep red,
//                             the shock band at its leading edge
//   pulsar       0.45 - 1     the point pulsing at the centre, its blue nebula growing
// Everything is a function of fx.u, the seed and the clock; the run fades in its last tenth.
// a radial-gradient maker and a disc filler bound to a given context (gasCloud takes both)
function gradFor(c) {
  return (x, y, r, stops) => {
    const g = typeof c.createRadialGradient === 'function' ? c.createRadialGradient(x, y, 0, x, y, r) : null;
    if (!g || typeof g.addColorStop !== 'function') return stops[0][1];
    for (const [o, col] of stops) g.addColorStop(o, col);
    return g;
  };
}
function discFor(c) { return (x, y, r, fill) => { c.fillStyle = fill; c.beginPath(); c.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); c.fill(); }; }
// a half-size offscreen layer matching the board's canvas and transform, cleared for this frame;
// null where there is no real canvas to make one from
function plumeLayer(ctx, fx) {
  // the half-size layer is a SOFTWARE economy (a quarter of the pixels to fill). On the GL renderer it
  // is the opposite: a 2D canvas rasterised on the processor and uploaded as a texture every frame,
  // which was the supernova's stall there (operator, 2026-09-21: "major performance issues on the GL
  // path"). Null draws the plumes straight onto the board, which the graphics card does not notice.
  if (ctx.gl2d === true) return null;
  const cv = ctx.canvas;
  if (!cv || !cv.width || typeof ctx.getTransform !== 'function' || typeof ctx.drawImage !== 'function' || typeof document === 'undefined') return null;
  const w = Math.ceil(cv.width / 2), h = Math.ceil(cv.height / 2);
  let L = fx._plumes;
  if (!L || L.canvas.width !== w || L.canvas.height !== h) {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const c2 = canvas.getContext('2d');
    if (!c2) return null;
    L = fx._plumes = { canvas, ctx: c2 };
  }
  const m = ctx.getTransform();
  L.ctx.setTransform(1, 0, 0, 1, 0, 0); L.ctx.clearRect(0, 0, w, h);
  L.ctx.setTransform(m.a / 2, m.b / 2, m.c / 2, m.d / 2, m.e / 2, m.f / 2);
  return L;
}
// THE SUPERNOVA'S DEBRIS CLOUD AS A SHADER (operator, 2026-09-22, with NASA's animation open -- svs.gsfc.nasa.gov/20413:
// "the supernova really needs to be improved to look more like this source material -- It's close, but needs more
// work in WebGL at the very least"). I pulled the film and looked at it frame by frame. What it has that a heap
// of soft round blobs cannot: FINE CONTINUOUS TURBULENCE -- smoke, at every scale -- in three depths of colour:
//   OUTER GAS flung ahead, soft deep-blue billows (the first cut drew this as RIDGED noise -- thin bright creases --
//     and the operator asked what the blue squiggly lines were: there is no ridged noise in it now);
//   a BODY, a full lumpy volume, white-hot cyan at the breakout (the film's 13-16 s: a ball plainly not round),
//     then lavender and violet, the tops of its puffs lit;
//   a MAGENTA HEART deep inside it, with the pulsar at the middle.
// The texture EXPANDS WITH THE CLOUD (a remnant expands in proportion: every part keeps its place in the whole),
// and churns slowly on the clock. Every size, weight and moment here is drawSupernova's own -- the shell radii,
// `bright`, the blue shell's fade, the heart's rise -- so what the operator settled about how big it is, how
// thin ("reads as gas the chart shows through") and how long it lingers still holds. Only what DRAWS it changed.
const NOVA_GLSL = `
uniform vec4 uA;     // x: the main shell's radius, y: the blue shell's, as shares of the quad's half-side; z: f, how far through the expansion; w: a seed
uniform vec4 uB;     // x: bright, y: the blue shell's brightness, z: the heart's rise (0..1), w: the clock (s)
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h2(vec2 i) { ivec2 c = ivec2(i); uint n = (uint(c.x) * 1597334677u) ^ (uint(c.y) * 3812015801u); n ^= n >> 16; n *= 0x7feb352du; n ^= n >> 15; n *= 0x846ca68bu; n ^= n >> 16; return float(n >> 8) / 16777216.0; }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), u.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), u.x), u.y); }
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
// BAND-LIMITED: 'cell' is how many PIXELS one cell of the first octave covers, and an octave whose cells are under
// about six pixels is left out (faded, not cut). The cloud is a hundred pixels across on the Markets board and six
// hundred on a wall display: without this the small one is five octaves of sub-pixel noise, which through a warp
// and a threshold draws as thin bright scribbles -- the "blue squiggly lines" were that as much as the ridges.
float fbm(vec2 p, int oct, float cell) { float a = 0.5, s = 0.0, tot = 0.0; for (int k = 0; k < 6; k++) { if (k >= oct) break; float w = a * (k == 0 ? 1.0 : smoothstep(3.0, 9.0, cell)); s += w * vn(p); tot += w; p = ROT * p * 2.03 + 17.3; a *= 0.5; cell /= 2.03; } return s / max(tot, 1e-4); }
vec4 shade(vec2 uv) {
  float r = length(uv);
  float C = uA.x / 1.25 / max(fwidth(uv.x), 1e-5);                    // pixels to one unit of q (before any early return: a derivative)
  if (r > 1.0) return vec4(0.0);
  float f = uA.z, seed = uA.w * 37.0, t = uB.w;
  // LUSH AND GASSY, AND NOT ONE LINE IN IT (operator, 2026-09-22: "We still aren't looking as lush and gassy as the
  // nasa footage. What's with the blue squigly lines coming out of the explosion?"). The lines were mine: the flame
  // shell was RIDGED noise, whose whole character is thin bright creases -- right for lightning, wrong for an
  // explosion. The film's cloud is soft thick VOLUME: billows, with lit tops, its colour changing through its depth.
  // So: no ridged() anywhere below. Billows are fbm through TWO warps (smoke's look); the cloud is a full volume,
  // not a thin shell; colour is a function of DEPTH INTO IT, bent by the billows so it never rings; and a second
  // field lights the tops of the puffs.
  vec2 q = uv / max(uA.x, 1e-3) * 1.25 + seed;                       // the cloud's own coordinates: it expands in proportion
  vec2 w1 = vec2(fbm(q * 0.85 + vec2(0.0, t * 0.045), 4, C / 0.85), fbm(q * 0.85 + vec2(5.2, 1.3 - t * 0.04), 4, C / 0.85)) - 0.5;
  vec2 w2 = vec2(fbm(q * 1.7 + 2.2 * w1 + vec2(t * 0.03, 2.0), 4, C / 1.7), fbm(q * 1.7 + 2.2 * w1 + vec2(8.3, -t * 0.03), 4, C / 1.7)) - 0.5;
  float billow = fbm(q * 1.35 + 1.8 * w2, 5, C / 1.35);                          // 0..1, soft, puffy
  float puff = fbm(q * 2.4 + 1.6 * w2 + 11.0, 4, C / 2.4);                      // a finer one: the lit tops
  float lump = fbm(q * 0.6 + 1.5 * w1 + 4.0, 3, C / 0.6);                       // a slow one: the cloud's lumpy outline
  float rs = r / max(uA.x, 1e-3), rb = r / max(uA.y, 1e-3);
  float early = 1.0 - smoothstep(0.08, 0.42, f);                       // the breakout: a white-hot lumpy ball
  // THE MAIN CLOUD: a full volume to its lumpy edge, puffy toward the rim and solid toward the middle
  float edgeR = 0.78 + 0.55 * lump;
  // THE BREAKOUT (the film's 13-16 s; operator, 2026-09-22: "fix the breakout frame next"): ONE SMOOTH LUMP, plainly
  // not round, white-hot to a crisp cyan rim, a blue glow standing off it. It was the blob plumes' grainy grey ball.
  // So while it is early the edge is tight, there are no gaps in it, and it is solid.
  float inside = 1.0 - smoothstep(edgeR - mix(0.30, 0.10, early), edgeR + mix(0.10, 0.04, early), rs);
  float holes = mix(smoothstep(0.20, 0.52, billow + 0.60 * (1.0 - rs)), 1.0, early);   // gaps open only out near the rim, and only later
  float aMain = inside * mix(holes, 1.0, 0.45 * (1.0 - smoothstep(0.0, 0.7, rs))) * (0.86 + 0.14 * early) * uB.x;
  // depth into the cloud, bent by the billows: magenta heart, violet-lavender body, cyan-blue out at the rim
  float depth = clamp(rs / max(edgeR, 0.3) + 0.55 * (billow - 0.5) + 0.2 * (puff - 0.5), 0.0, 1.3);
  vec3 heartC = vec3(1.00, 0.16, 0.60), bodyC = mix(vec3(0.62, 0.50, 1.00), vec3(0.50, 0.24, 0.98), smoothstep(0.2, 0.9, f));
  vec3 rimC = mix(vec3(0.20, 0.42, 1.00), vec3(0.32, 0.92, 1.00), 1.0 - smoothstep(0.0, 0.6, f));   // cyan at first, electric blue later
  float heartIn = uB.z * (1.0 - smoothstep(0.10, 0.50, depth));
  vec3 col = mix(bodyC, rimC, smoothstep(0.55, 0.98, depth));
  col = mix(col, heartC, heartIn);
  // the lit tops of the puffs: toward white, tinted by where they are
  float lit = smoothstep(0.42, 0.85, puff) * (0.35 + 0.65 * billow);
  col = mix(col, mix(vec3(1.0, 0.86, 0.95), vec3(0.86, 1.0, 1.0), smoothstep(0.3, 0.9, depth)), 0.55 * lit);
  float rimE = smoothstep(edgeR - 0.34, edgeR - 0.02, rs);                                               // toward the lump's own edge
  vec3 hotC = mix(vec3(1.0, 1.0, 1.0), vec3(0.45, 0.96, 1.0), rimE * rimE);                              // white-hot, cyan only at the rim
  hotC = mix(hotC, vec3(0.80, 0.97, 1.0), 0.22 * (1.0 - billow) * (1.0 - rimE));                         // the faintest mottling: a surface, not a sticker
  col = mix(col, hotC, early);
  // THE OUTER GAS, flung ahead of the cloud: the same soft billows, thinner, deep blue -- haze, never lines
  float outer = (1.0 - smoothstep(0.55 + 0.45 * lump, 1.02 + 0.35 * lump, rb)) * smoothstep(0.30, 0.78, billow * 0.75 + 0.45 * puff);
  float aOut = outer * 0.62 * uB.y * (1.0 - 0.6 * early);
  // the glow standing off the breakout: smooth, deep blue, following the lump's outline, gone as the cloud opens
  float halo = early * uB.x * 0.55 * (1.0 - smoothstep(edgeR, edgeR + 1.1, rs)) * smoothstep(edgeR - 0.2, edgeR, rs);
  vec3 outC = mix(vec3(0.06, 0.16, 0.95), vec3(0.22, 0.62, 1.00), 0.6 * lit + 0.4 * (1.0 - smoothstep(0.0, 0.5, f)));
  // back to front: the outer gas, then the cloud over it
  vec3 rgb = outC * aOut; float a = aOut;
  rgb = rgb * (1.0 - halo) + vec3(0.16, 0.50, 1.0) * halo; a = a + halo * (1.0 - a);
  rgb = rgb * (1.0 - aMain) + col * aMain; a = a + aMain * (1.0 - a);
  a *= 1.0 - smoothstep(0.90, 1.0, r);                                // (the quad's own edge is never seen)
  rgb *= 1.0 - smoothstep(0.90, 1.0, r);
  float luma = dot(rgb, vec3(0.30, 0.55, 0.15));
  rgb = max(mix(vec3(luma), rgb, 1.35), 0.0);                         // vivid: beside the film the first cut was grey
  return vec4(min(rgb, vec3(a)) * step(0.001, a), a);
}`;

function drawSupernova(ctx, view, lw) {
  const fx = view.fx;
  if (!fx || fx.kind !== 'flare') return;
  const U = view.unit ?? 8, u = fx.u, now = view.now ?? 0;
  const line = view.axes?.line, price = line?.length > 1;
  const sx = fxHash(fx.seed + 7) * fx.gridW, sy = price ? (view.axes.y ?? fx.gridH / 2) : fxHash(fx.seed + 8) * fx.gridH;
  let sz = 3;
  if (price) {   // the star sits on the price line at that hour
    let best = line[0]; for (const p of line) if (Math.abs(p.x - sx) < Math.abs(best.x - sx)) best = p;
    sz = best.z;
  }
  const c = project(sx, sy, sz, view);
  // BOUNDED (operator, 2026-09-15: "supernova and black hole nebula effects take up too much
  // screen space ... it's obscuring too much"): the shell was sized at half the board and the
  // white-out was the whole frame, which on the Kiosk's panel was the whole panel; the shell is
  // about a third of the board now and the flash a soft disc round the star
  // ...and never more than 7% of the board's width, whatever the board (the Kiosk's block-space
  // panel is 44 units across and small on screen: at 4.5 units the cloud covered most of it)
  const R0 = U * boundedRadius(price ? 3.4 : 4.5, 0.07, fx.gridW);
  const gf = Math.min(1, (1 - u) / 0.1);
  // still a real gradient maker, because gasCloud() takes one as a callback for its puffs; every
  // FILL drawn directly by this function is layered flat discs now (softStops)
  const grad = (x, y, r, stops) => {
    const g = typeof ctx.createRadialGradient === 'function' ? ctx.createRadialGradient(x, y, 0, x, y, r) : null;
    if (!g || typeof g.addColorStop !== 'function') return stops[0][1];
    for (const [o, col] of stops) g.addColorStop(o, col);
    return g;
  };
  const disc = (x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); ctx.fill(); };
  const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  // the cloud's colour with the run, as in the reference (operator: "the cloud is white at the
  // start, shifting towards blue, then purple/violet"): white, blue, then violet
  const cool = Math.max(0, Math.min(1, (u - 0.14) / 0.86));
  const rc = cool < 0.3 ? mixc([255, 255, 255], [150, 195, 255], cool / 0.3) : mixc([150, 195, 255], [175, 110, 255], (cool - 0.3) / 0.7);
  const rcs = rc.join(',');
  let shadedCloud = false, shellNow = 0;                 // (the GL renderer's shader cloud drew this frame, and how big)
  // --- ignition: a white nebula, not a ball (operator, 2026-09-15: "Don't use a white ball visual
  // at the beginning of the animation. Use white nebula effects"): a small cloud of white gas
  // gathering and brightening round the star, blue-shifting as the blast nears
  if (u < 0.14) {
    const f = Math.min(1, u / 0.12), ease = f * f;
    const col = [Math.round(255 - 70 * ease), Math.round(255 - 30 * ease), 255];
    gasCloud(ctx, c.x, c.y, R0 * (0.35 + 0.9 * ease), 0.2, now, fx.seed + 555, 0.25 + 0.75 * ease, col, grad, disc, 70, [120, 150, 230]);
  }
  // --- THE DEBRIS CLOUD AS A VOLUME OF GAS (operator, 2026-09-15: "Overall it needs to look
  // more like the NASA video. I don't think the ejecta/fireworks is working well ... The thin
  // white lines shifting at the edges does not hold up well"). No lines of any kind. The cloud
  // is gasCloud: a sphere of soft gradient blobs, each with a fixed place in the unit sphere
  // (denser toward the rim, so the limb is brighter, as a shell seen through is), carried
  // outward by the expansion -- every blob at a radius in proportion to its own, as a real
  // remnant expands -- growing as it goes, the front ones hotter and paler than the ones behind,
  // the whole cooling white-gold -> orange -> red as it dims, its surface boiling on the clock.
  const band = (r, w, col, a) => {
    if (r <= 0 || a <= 0.003) return;
    const R = r + w;
    softStops(ctx, c.x, c.y, R, [[0, `rgba(${col},0)`], [Math.max(0, (r - w) / R), `rgba(${col},0)`], [Math.max(0, (r - w * 0.35) / R), `rgba(${col},${a.toFixed(3)})`], [r / R, `rgba(240,245,255,${(a * 0.8).toFixed(3)})`], [Math.min(1, (r + w * 0.5) / R), `rgba(${col},${(a * 0.6).toFixed(3)})`], [1, `rgba(${col},0)`]]);
  };
  if (u >= 0.14) {
    const f = (u - 0.14) / 0.86;
    const shell = R0 * (0.5 + 4.2 * (1 - Math.exp(-1.3 * f)));           // the cloud's radius: slower than the first cut (operator: "the cloud dispersion is too fast")
    // LINGERING (operator, 2026-09-15: "make the violet nebula linger longer into the blink
    // phase"): the cloud holds full weight until four fifths of the run -- well into the pulsar's
    // beat -- and only thins over the last fifth, so the purple stays round the blinking star
    const bright = (f < 0.08 ? f / 0.08 : f < 0.8 ? 1 : Math.pow(1 - (f - 0.8) / 0.2, 1.2)) * gf;
    // THE MORPHING (operator, 2026-09-15: "as it shifts from blue to white initially, then the
    // purples and violets start appearing, as the blue clouds continue to disperse ahead of
    // everything else"): three clouds. The BLUE one is out in front, expanding fastest and
    // thinning first; the MAIN one behind it is white at the start, and violet grows into it
    // patch by patch, each blob turning on its own schedule, until the whole is purple; the
    // INNER one is the deep violet heart that shows as the others thin.
    const blueShell = R0 * (0.6 + 4.6 * (1 - Math.exp(-1.9 * f)));
    const blueBright = bright * 0.7 * Math.pow(1 - f, 1.6);
    // SMOOTH (operator, 2026-09-15: "We see too much of the radial texture. Lets try to smoothen
    // that up"): more and larger blobs at a lower weight, barely stretched, so they melt into one
    // another instead of reading as radial streaks
    // ON THE GL RENDERER THE CLOUD IS ONE SHADER QUAD (NOVA_GLSL, above): the same radii, the same weights, the
    // same moments -- fine turbulence where the blobs below are soft discs. Where it cannot run, the blobs.
    const Q = Math.max(shell, blueShell) * 1.6;
    const inner0 = f > 0.2 ? Math.min(1, (f - 0.2) / 0.18) : 0;
    const shaded = ctx.gl2d === true && typeof ctx.shade === 'function' && ctx.shade({
      glsl: NOVA_GLSL, x: c.x - Q, y: c.y - Q, w: Q * 2, h: Q * 2,
      uniforms: { uA: [shell / Q, blueShell / Q, f, (fx.seed % 97) + 1], // (the BLOB blue cloud thins to nothing early -- the operator's "as the blue clouds continue to disperse ahead"
      // -- but the film's blue tendrils are there to the last frame, dispersed and dim: never under 0.55 of the cloud)
      uB: [bright, Math.max(0.55 * bright, Math.min(1, blueBright / Math.max(0.001, gf))), inner0, now / 1000] },
    });
    if (!shaded) {
      gasCloud(ctx, c.x, c.y, blueShell, f, now, fx.seed + 31337, blueBright * 0.32, [150, 195, 255], grad, disc, 140, [70, 110, 220], (front, ff, H) => {
        const t = Math.min(1, ff / 0.5);
        return [Math.round(215 - 65 * t), Math.round(235 - 40 * t), 255].map((v, i) => Math.round(v * (0.75 + 0.25 * front) + (i === 2 ? 0 : 0)));
      }, 0.85, 1.25);
      // THIN, NOT SOLID (2026-09-15, the Kiosk: "far too much solid white"): overlapping discs sum
      // toward opaque however faint each is -- 320 blobs saturated, and 170 at a third still did --
      // so the cloud is ninety blobs at an eighth of the weight, which peaks near half opacity at the
      // centre and reads as gas the chart shows through
      gasCloud(ctx, c.x, c.y, shell, f, now, fx.seed, bright * 0.17, rc, grad, disc, 220, [60, 30, 120], (front, ff, H) => {
        // SOONER (operator, 2026-09-15: "we need more of the third stage purple and violet nebula
        // becoming prominent as it starts the blink phase"): the patches turn violet between a tenth
        // and four tenths of the run, so the cloud is mostly purple by the time the pulsar wakes
        const start = 0.1 + 0.3 * H(11), on = Math.max(0, Math.min(1, (ff - start) / 0.2));   // when this patch turns violet
        const white = [225, 235, 255], violet = [170, 105, 255], deep = [95, 45, 170];   // blue-white, not solid white (2026-09-15)
        const c1 = white.map((v, i) => v + (violet[i] - v) * on);
        const shade = 0.55 + 0.45 * front;
        return c1.map((v, i) => Math.round(deep[i] + (v - deep[i]) * shade));
      }, 0.85, 1.25);
      if (f > 0.2) {
        // the violet heart, sooner and heavier (the same request): rising from a fifth of the run,
        // full by the blink, and a second wider violet cloud behind it that keeps growing
        const inner = Math.min(1, (f - 0.2) / 0.18);
        gasCloud(ctx, c.x, c.y, shell * 0.7, f, now, fx.seed + 777, bright * 0.3 * inner, [160, 90, 255], grad, disc, 90, [60, 25, 130], null, 0.9, 1.25);
        gasCloud(ctx, c.x, c.y, shell * 1.05, f, now, fx.seed + 778, bright * 0.16 * inner, [175, 115, 255], grad, disc, 90, [70, 30, 140], null, 1.1, 1.3);
      }
    }
    shadedCloud = !!shaded; shellNow = shell;
    // and the interior glow: the cloud lit from within
    // (the shader's cloud carries its own light: the pale pools below, made to give the BLOBS a glow, washed it to grey)
    const pool = shaded ? 0 : 1;
    softStops(ctx, c.x, c.y, shell * 0.8, [[0, `rgba(${rcs},${(0.1 * bright * pool).toFixed(3)})`], [0.6, `rgba(${rcs},${(0.05 * bright * pool).toFixed(3)})`], [1, `rgba(${rcs},0)`]]);
    // the shock band at the cloud's leading edge, soft, in the cloud's colour
    if (u < 0.6) {
      const fr = (u - 0.14) / 0.46, r = R0 * 4.5 * (1 - Math.pow(1 - fr, 2.2));
      // (with the shader's cloud the shock is a thin CYAN ring, as the film's breakout rim is -- the grey-white disc
      // that stood in for it filled the whole cloud with haze)
      if (shaded) band(r, R0 * (0.18 + 0.3 * (1 - fr)), '110,235,255', 0.5 * (1 - fr) * gf);
      else {
        softStops(ctx, c.x, c.y, r, [[0, 'rgba(235,240,255,0)'], [0.7, `rgba(235,240,255,${(0.05 * (1 - fr) * gf).toFixed(3)})`], [1, `rgba(240,245,255,${(0.14 * (1 - fr) * gf).toFixed(3)})`]]);
        band(r, R0 * (0.3 + 0.6 * (1 - fr)), rcs, 0.4 * (1 - fr) * gf);
      }
    }
    // a wide pool of the cloud's colour on everything near
    softStops(ctx, c.x, c.y, shell * 1.9, [[0, `rgba(${rcs},${(0.08 * bright * pool).toFixed(3)})`], [1, `rgba(${rcs},0)`]]);
  }
  // --- the breakout: the whole picture goes white and comes back
  if (u >= 0.12 && u < 0.4) {
    const t = (u - 0.12) / 0.28, f = t < 0.1 ? t / 0.1 : Math.pow(1 - (t - 0.1) / 0.9, 1.5);
    // THE FLASH ITSELF (operator, 2026-09-15: "It's missing the bright white flash!"): a bright,
    // brief one -- full white at the heart for an instant, gone in a third of the breakout -- so
    // it reads as a flash, not as a solid glow that sits on the Kiosk's panel
    const fl = t < 0.04 ? t / 0.04 : t < 0.12 ? 1 : Math.pow(Math.max(0, 1 - (t - 0.12) / 0.3), 2);
    // WHITE-HOT (operator, 2026-09-15: "We need to add the white-hot-flash to the explosion
    // again"): the heart goes fully white and holds for a moment, and a wide veil of light
    // washes twice as far out for the same instant -- bounded to the star's neighbourhood, so
    // the Kiosk's panel flashes bright but never sits solid
    if (fl > 0) {
      const V = R0 * 8;
      disc(c.x, c.y, V, grad(c.x, c.y, V, [[0, `rgba(255,255,252,${(0.45 * fl).toFixed(3)})`], [0.4, `rgba(255,252,246,${(0.18 * fl).toFixed(3)})`], [1, 'rgba(255,248,240,0)']]));
    }
    // a soft flash round the star, not the whole frame -- and NOT SOLID (operator, 2026-09-15, via
    // his wife on the Kiosk: "far too much solid white"): a modest disc, at most half opaque at its
    // heart, thin by three shells out, and the white gas thrown with it at a third of the weight
    const W = R0 * 4;
    // PRESENCE BACK (operator, 2026-09-15: "We've removed so much of the initial white nebula
    // emission that it's lost much of its presence and intensity") -- now that the discs add up
    // honestly, the flash and the white gas can carry weight again without going solid
    disc(c.x, c.y, W, grad(c.x, c.y, W, [[0, `rgba(255,255,252,${Math.min(1, 0.3 * f + 1.0 * fl).toFixed(3)})`], [0.35, `rgba(255,252,244,${Math.min(1, 0.15 * f + 0.6 * fl).toFixed(3)})`], [0.7, `rgba(255,248,235,${(0.05 * f + 0.06 * fl).toFixed(3)})`], [1, 'rgba(255,245,230,0)']]));
    // MORE GAS OFF THE FLASH (operator, 2026-09-15: "Opening white flash needs more dispersing
    // nebula gas"): two clouds thrown with it -- a dense one at the flash and a wider, thinner
    // one racing ahead of it -- both flying out faster than the flash fades, so the white
    // disperses into the dark rather than shrinking back into the star
    // A BURST OF PLUMES, not two clouds (operator, 2026-09-15: "need much more than two clouds of
    // white gas in the initial explosion"): the dense cloud at the flash, and the plumes of
    // white gas thrown from it in every direction (below), each its own cloud flying outward on
    // its own speed and growing as it goes, the fast ones out ahead and thinning first
    // (not over the shader's cloud: eighty grey-white blobs on a smooth white lump are the grain in it)
    if (!shadedCloud) gasCloud(ctx, c.x, c.y, R0 * (1.0 + 2.2 * t), t, now, fx.seed + 999, 0.1 * f, [255, 255, 255], grad, disc, 80, [200, 210, 240], null, 0.9, 1.25);
    // (no lens flare here: its turning rays were the "opening rotating glints" the operator had
    // taken out on 2026-09-15; the white-out alone is the breakout)
  }
  // FURTHER AND LONGER (operator, 2026-09-15: "the plumes need to disperse further out and linger
  // longer ... Double the amount"): thirty-two plumes on their own clock, outliving the flash by
  // half again -- they reach nine star radii, keep flying after the flash has gone, and only
  // thin out slowly, so the white gas is still drifting outward when the blue debris rises
  // AND AGAIN (operator, 2026-09-15: "the white plumes still fade too fast, make them linger
  // longer. Double the amount again" -- then "Double the white ejecta again. We're getting
  // closer!"): a hundred and twenty-eight plumes, holding full for the first fifth of
  // their flight and thinning slowly over the rest, still drifting at nine tenths of the effect
  if (u >= 0.12 && u < 0.9) {
    const t = (u - 0.12) / 0.78, g = t < 0.04 ? t / 0.04 : t < 0.2 ? 1 : Math.pow(1 - (t - 0.2) / 0.8, 0.7);
    // AT HALF RESOLUTION: a hundred and twenty-eight clouds of soft gradient discs is the costliest
    // thing any effect draws, so the plumes go onto a half-size layer (a quarter of the pixels to
    // fill) and are blitted up -- gas is blurry to begin with, so nothing is lost; where there is
    // no offscreen canvas (the tests' stub context) they draw straight onto the board
    const layer = plumeLayer(ctx, fx), pc = layer ? layer.ctx : ctx;
    const pgrad = layer ? gradFor(pc) : grad, pdisc = layer ? discFor(pc) : disc;
    for (let k = 0; k < 128; k++) {
      const H = (q) => hash01(fx.seed + 4400 + k * 19 + q);
      const ang = (k / 128) * Math.PI * 2 + (H(1) - 0.5) * 0.2, sp = 0.4 + 1.2 * H(2);
      const reach = R0 * (0.6 + 9 * t) * sp, ease = 1 - Math.exp(-2.2 * t);
      const px = c.x + Math.cos(ang) * reach * ease, py = c.y + Math.sin(ang) * 0.75 * reach * ease;
      const shell = R0 * (0.5 + 2.8 * t) * (0.7 + 0.6 * H(3));
      // THE PLUMES ARE THE OPERATOR'S ("white gas in the initial explosion ... disperse further out and linger") and
      // they stay. But over the shader's vivid cloud, plumes that stay WHITE as they thin read as grey smoke beside
      // it -- and in the film what is flung furthest out is blue. On the GL renderer they leave white and COOL to
      // blue as they go, so late on they are the film's outer wisps and not a haze.
      const cool = ctx.gl2d === true ? Math.min(1, t * 1.6) : 0;
      const hot = [245, 248, 255].map((v, i) => Math.round(v + ([70, 140, 255][i] - v) * cool));
      const cold = [180, 195, 235].map((v, i) => Math.round(v + ([30, 70, 220][i] - v) * cool));
      // ...and a plume is seen once it has LEFT the shader's lump, not while it is still inside it: they are painted
      // over the cloud, and a hundred and twenty-eight of them piled on the breakout made a smooth white ball grainy
      const dist = Math.hypot(px - c.x, (py - c.y) / 0.75);
      const clear = shadedCloud ? Math.max(0, Math.min(1, (dist - shellNow * 0.75) / (shellNow * 0.5))) : 1;
      if (clear <= 0) continue;
      gasCloud(pc, px, py, shell, t, now, fx.seed + 5000 + k * 131, 0.09 * g * (1 - 0.3 * sp) * clear, hot, pgrad, pdisc, 10, cold, null, 1.3, 1.3);
    }
    if (layer) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(layer.canvas, 0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore(); }
  }
  // --- the pulsar: as the cloud dims, a point pulsing at the centre, its blue nebula growing
  if (u >= 0.45) {
    const f = (u - 0.45) / 0.55, on = Math.min(1, f / 0.1) * gf;
    const period = 140, ph = ((now % period) / period), pulse = Math.pow(Math.max(0, 1 - Math.abs(ph - 0.5) * 6), 2);   // a sharp beat, seven a second (operator: "Pulsar needs to pulse quicker")
    const neb = R0 * (0.25 + 1.1 * f);
    // THE WIND NEBULA IS A GAS CLOUD TOO (operator, 2026-09-15: "The pulsar nebula needs the gas
    // cloud too"): a small blue-white sphere of blobs blown outward from the pulsar, growing with
    // it, lit from the centre, the pulsar's beat showing in its brightness
    softStops(ctx, c.x, c.y, neb, [[0, `rgba(190,225,255,${(0.28 * on).toFixed(3)})`], [0.5, `rgba(120,175,255,${(0.12 * on).toFixed(3)})`], [1, 'rgba(80,130,255,0)']]);
    gasCloud(ctx, c.x, c.y, neb, f, now, fx.seed + 4242, on * (0.75 + 0.25 * pulse), [170, 215, 255], grad, disc, 70, [40, 70, 170]);
    const rp = R0 * (0.12 + 0.25 * pulse);
    softStops(ctx, c.x, c.y, rp * 2.4, [[0, `rgba(255,255,255,${((0.5 + 0.5 * pulse) * on).toFixed(3)})`], [0.3, `rgba(200,235,255,${(0.55 * pulse * on).toFixed(3)})`], [1, 'rgba(140,200,255,0)']]);
    disc(c.x, c.y, rp * 0.5, `rgba(255,255,255,${on.toFixed(3)})`);
    // the beam: two thin rays sweeping round with the beat
    const sweep = now * 0.004;
    for (const side of [0, Math.PI]) {
      const ang = sweep + side, L = neb * (0.8 + 0.8 * pulse);
      ctx.strokeStyle = `rgba(220,240,255,${(0.35 * pulse * on).toFixed(3)})`; ctx.lineWidth = Math.max(lw, U * 0.04);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + Math.cos(ang) * L, c.y + Math.sin(ang) * L); ctx.stroke();
    }
  }
  ctx.lineWidth = lw;
}

// THE PLASMA BALL (`ball`), over the cubes: the grid line it has traced burning behind it and cooling
// over 16 units, a plasma ball of one pale gradient with a white-hot heart. It throws no bolts: those are
// the storm ball's (agents.js). Plain rgba fills and strokes only.
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
    // the burn behind it is pale too: a wide wash of the ball's own light, not a dark blue bar
    stroke(seg, 12, `rgba(150,200,255,${(0.09 * heat).toFixed(3)})`);
    stroke(seg, 4, `rgba(170,222,255,${(0.5 * heat).toFixed(3)})`);
    stroke(seg, 1.6, `rgba(235,248,255,${(0.95 * heat).toFixed(3)})`);
    charged.push({ a: seg[0], b: seg[1], tint: heat, age: 1 - heat, i: k });
  }
  // the dust and the crackle behind the ball, the same charge the light cycles and the Markets
  // pulse carry (chargeTrail)
  chargeTrail(ctx, charged, lw, view.now ?? 0, 977, true);
  const c = P(b.x, b.y, b.z);
  // ONE GRADIENT, NOT STACKED DISCS (operator, 2026-09-14: "The energy ball blue plasma is way too
  // dark. Need to make it way subtler like the ball lightning stuff"). Five discs of deepening blue
  // read as a dark blue blot with a dot in it; this is the stormball's recipe -- a white-hot heart
  // falling off through pale cyan to nothing, one radial gradient -- with the blue kept pale and
  // thin so the ball is light on the board rather than a shadow over it.
  const flick = 0.85 + 0.15 * Math.random();
  const R = 4.2 * U;
  // layered flat discs, not a radial gradient: this is the biggest soft blob on the board and it
  // banded visibly (operator, 2026-09-15: "what is still with the gradient fill shit?!")
  softStops(ctx, c.x, c.y, R, [
    [0, 'rgba(255,255,255,1)'],
    [0.1, 'rgba(240,250,255,1)'],
    [0.22, 'rgba(200,236,255,0.85)'],
    [0.4, `rgba(170,220,255,${(0.32 * flick).toFixed(3)})`],
    [0.68, `rgba(160,205,255,${(0.1 * flick).toFixed(3)})`],
    [1, 'rgba(160,200,255,0)'],
  ], 26);
  // NO BOLTS HERE (operator, 2026-09-22: "We need to remove the lightning effect on the plasma ball. Only the
  // lightning ball should emit lightning bolts" -- and, shown the other one, "this is the one that needs to emit
  // lightning bolts, not the other effect"). THE NAMES ARE CROSSED: this effect is `ball`, which Settings used to
  // call "Lightning ball", and the operator calls it the PLASMA ball; what he calls the lightning ball is the storm
  // ball in agents.js ("Ball lightning"), which draws lightning.js's channels on both boards. This one is the
  // sphere, the grid line burning behind it, and its charge trail.
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
    // (the GL renderer's bloom: the ground's LINES are neon and throw light; its FILLS -- the floor,
    // the wide soft haze -- are surfaces, and lit the whole background when they bloomed)
    ctx.emissive = !l.fill;
    if (l.fill) ctx.fillStyle = l.fill;
    else { ctx.strokeStyle = l.stroke; ctx.lineWidth = lw * (l.lw ?? 1); }
    if (ctx.gl2d === true) {
      // the GL renderer's own recorded path (gl2d.js): a native Path2D cannot be read back
      if (!l.glPath) { l.glPath = ctx.createPath(); trace(l.glPath, l); }
      if (l.fill) ctx.fill(l.glPath); else ctx.stroke(l.glPath);
    } else if (P2) {
      if (!l.path) { l.path = new Path2D(); trace(l.path, l); }
      if (l.fill) ctx.fill(l.path); else ctx.stroke(l.path);
    } else {
      ctx.beginPath();
      trace(ctx, l);
      if (l.fill) ctx.fill(); else ctx.stroke();
    }
  }
  ctx.emissive = true;
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
  if (fx && (fx.kind === 'outline' || fx.kind === 'tide')) {   // the scan draws its own foot (drawScanCurtain)
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

// THE PIPE BULGE (operator, 2026-09-14: "Add a new effect on the markets yellow line. Moves along the
// yellow bar from left to right. I want it to look like a sphere is moving through the pipe, and the
// pipe bulges outward as the sphere moves through the pipe, and contracts back into shape when it
// moves onward. Have it cleanly roll in and roll out with no pops, and limit it to within the limits
// of the yellow price line").
//
// SECOND CUT (the same day: "slow it down to half the current speed. The bulge does not look like
// it's passing a large sphere being forced through the tube, deforming a spherical bulge as it moves.
// Also, make the spawn in and fade out bulge up much sooner on the line, and last longer before it
// shrinks. the bulge and shrink effects should take 1 second each at the extents"). The first cut
// was a Gaussian swell -- a soft hump, not a ball -- that eased in and out over 18% of the run at each
// end. Now:
//   * the tube's wall is the SHAPE A BALL MAKES in a hose: round over the ball (a circle of radius
//     R), then an ARC of stretched skin, tangent to the ball and tangent to the tube (bulgeProfile)
//   * the ball travels the WHOLE line at constant speed, and its size is whatever fits: at the
//     line's first point the tube is exactly the tube, the ball grows as fast as its own bulge can
//     stay on the line, is full size for everything between, and shrinks back to exactly the tube
//     at the last point (bulgeFit). No clock: the size is a function of where the ball is.
// The timing went through 1000 ms ramps, 3000 ("time it so the ball shrinks to normal tube size at
// the last movement frame"), 500, 100, and then geometry (operator, 2026-09-14: "the bulge is
// appearing/disappearing too far from the edge, I want to time it so that it's exactly normal pipe
// sized starts and finishes. Have the bulge last as long as possible before it's no longer
// discernable"): full for as long as a ball that enters and leaves at the line's ends can be.
// The tapering was straight flanks off the ball at 24 degrees (an oval), then 58 (a sphere with a
// hard edge: "Now the sphere is too obvious. Can we arc the tapering?"), now a concave arc: the skin
// leaving the ball and easing down onto the tube, the way a stretched hose does.
const BULGE_FILLET = 1.6;                                // the skin arc's radius, in ball radii
const BULGE_BALL = 4.2;                                  // the ball's radius, in tube radii (of the core)

// At effect progress u of an `ms`-long run: travel 0..1 along the line. (The size is bulgeFit's.)
export function bulgeAt(u, ms = FX_MS.bulge) {
  return { t: Math.max(0, Math.min(1, u)) };
}

// the arc's geometry: its centre sits rf above the tube wall and R + rf from the ball's centre, so
// it touches both
function fillet(R, r0) {
  const rf = R * BULGE_FILLET, cy = r0 + rf;
  const cx = Math.sqrt((R + rf) * (R + rf) - cy * cy);
  return { rf, cx, cy, xt: (cx * R) / (R + rf) };
}

// The wall's distance from the axis at d pixels from the ball's centre, for a ball of radius R in a
// tube of radius r0. Continuous, with a continuous slope: round over the ball, then the arc, then
// the tube.
export function bulgeProfile(d, R, r0) {
  const x = Math.abs(d);
  if (R <= r0) return r0;
  const { rf, cx, cy, xt } = fillet(R, r0);
  if (x <= xt) return Math.sqrt(R * R - x * x);
  if (x >= cx) return r0;
  return cy - Math.sqrt(rf * rf - (x - cx) * (x - cx));
}
// how far from the ball's centre the bulge reaches, in pixels
export const bulgeReach = (R, r0) => (R <= r0 ? 0 : fillet(R, r0).cx);
// the largest ball, up to Rfull, whose bulge stays within `room` pixels of its centre
export function bulgeFit(room, Rfull, r0) {
  if (room <= 0 || Rfull <= r0) return r0;
  if (bulgeReach(Rfull, r0) <= room) return Rfull;
  let lo = r0, hi = Rfull;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (bulgeReach(mid, r0) <= room) lo = mid; else hi = mid; }
  return lo;
}

// A point on the drawn curve, and its unit normal: the same Catmull-Rom Beziers traceCurve strokes, so
// the swell is laid on exactly the line the eye sees and never separates from it at a candle.
function curveAt(pts, s) {
  const n = pts.length - 1;
  const d = Math.max(0, Math.min(n, s * n));
  const i = Math.min(n - 1, Math.floor(d)), t = d - i;
  const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
  const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
  const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
  const mt = 1 - t;
  const x = mt * mt * mt * p1.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p2.x;
  const y = mt * mt * mt * p1.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p2.y;
  const dx = 3 * mt * mt * (c1.x - p1.x) + 6 * mt * t * (c2.x - c1.x) + 3 * t * t * (p2.x - c2.x);
  const dy = 3 * mt * mt * (c1.y - p1.y) + 6 * mt * t * (c2.y - c1.y) + 3 * t * t * (p2.y - c2.y);
  const len = Math.hypot(dx, dy) || 1;
  return { x, y, nx: -dy / len, ny: dx / len };
}

// GRAVITY (operator, 2026-09-14: "Can we have gravity working against it? Faster to drop down on the
// pipe and slower to rise up the pipe?"). The ball's speed along the pipe follows the pipe's slope
// on screen: a run downhill (screen y increasing) is quicker, a climb slower, the level pipe at the
// base speed. The speed is averaged over a stretch of pipe either side, so the ball carries some
// momentum through a candle rather than snapping to each new slope; and the whole trip still takes
// the effect's time, so a steep line simply spends more of it climbing than falling.
//   v = 1 + BULGE_GRAVITY * (dy/ds), held within BULGE_SPEED   (dy/ds: +1 straight down, -1 straight up)
const BULGE_GRAVITY = 1.6;
const BULGE_SPEED = [0.35, 2.6];
const BULGE_MOMENTUM = 0.03;                                     // averaged over this much of the line each way

/**
 * Where a ball is at time t (0..1) along a line sampled as [{ y, len }] (screen y, and distance along
 * the line), given gravity: returns a distance in the same units as `len`, 0 at t=0, the full length
 * at t=1, never going backwards.
 */
export function bulgeTravel(table) {
  const n = table.length - 1;
  if (n < 1) return () => 0;
  const total = table[n].len;
  const raw = [];
  for (let k = 0; k < n; k++) {
    const a = table[k], b = table[k + 1], ds = b.len - a.len;
    const slope = ds > 0 ? Math.max(-1, Math.min(1, (b.y - a.y) / ds)) : 0;
    raw.push(Math.max(BULGE_SPEED[0], Math.min(BULGE_SPEED[1], 1 + BULGE_GRAVITY * slope)));
  }
  const win = Math.max(0, Math.round(n * BULGE_MOMENTUM));
  const T = [0];
  for (let k = 0; k < n; k++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, k - win); j <= Math.min(n - 1, k + win); j++) { sum += raw[j]; cnt++; }
    T.push(T[k] + (table[k + 1].len - table[k].len) / (sum / cnt));
  }
  const span = T[n] || 1;
  return (t) => {
    const want = Math.max(0, Math.min(1, t)) * span;
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] < want) lo = mid; else hi = mid; }
    const f = T[hi] > T[lo] ? (want - T[lo]) / (T[hi] - T[lo]) : 0;
    return Math.min(total, table[lo].len + (table[hi].len - table[lo].len) * f);
  };
}

// The curve by arc length, sampled once per draw: `at(px)` is the point that far along the line,
// `travel(t)` how far along a ball under gravity has got at time t (0..1).
function curveByLength(pts, samples = 400) {
  const table = [{ s: 0, len: 0, ...curveAt(pts, 0) }];
  for (let k = 1; k <= samples; k++) {
    const p = curveAt(pts, k / samples), q = table[k - 1];
    table.push({ s: k / samples, len: q.len + Math.hypot(p.x - q.x, p.y - q.y), ...p });
  }
  const total = table[samples].len;
  const at = (px) => {
    const L = Math.max(0, Math.min(total, px));
    let lo = 0, hi = samples;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (table[mid].len < L) lo = mid; else hi = mid; }
    const a = table[lo], b = table[hi], f = b.len > a.len ? (L - a.len) / (b.len - a.len) : 0;
    // never exactly 1: curveAt's last segment is pts[n-1]..pts[n], and s = 1 would ask for pts[n+1]
    // (the pulse's head bulge sits at the very end of the line once the head has run off it)
    return curveAt(pts, Math.min(0.999999, a.s + (b.s - a.s) * f));
  };
  // the length along the curve at parameter s (0..1 by point index, as headPoint and curveAt count):
  // the pulse's bulge is placed with this, so it sits ON the head rather than a share of the length
  // along -- which drifted from the head wherever the candles' hops were unequal (operator,
  // 2026-09-15: "the bulge effect is lagging behind the energy. They should be on top of each other")
  const lenAt = (sv) => {
    const S = Math.max(0, Math.min(1, sv));
    let lo = 0, hi = samples;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (table[mid].s < S) lo = mid; else hi = mid; }
    const a = table[lo], b = table[hi], f = b.s > a.s ? (S - a.s) / (b.s - a.s) : 0;
    return a.len + (b.len - a.len) * f;
  };
  return { total, at, lenAt, travel: bulgeTravel(table) };
}

function drawBulge(ctx, pts, lw0, u, layers, ms = FX_MS.bulge) {
  const lw = Number.isFinite(lw0) && lw0 > 0 ? lw0 : 1;         // a canvas that will not say: one pixel
  const { t } = bulgeAt(u, ms);
  const coreR = (lw * 5.5) / 2;
  const curve = curveByLength(pts);
  // the ball's centre travels the whole line, quicker downhill and slower up (bulgeTravel); the ball
  // is as big as fits between it and the nearer end
  drawBulgeAt(ctx, pts, lw, curve.travel(t), coreR * BULGE_BALL, layers, curve);
}
/** The swell itself, at `centre` along the curve with a full radius of `Rfull`: the pulse's head borrows it. */
function drawBulgeAt(ctx, pts, lw0, centre, Rfull, layers, curve = curveByLength(pts)) {
  const lw = Number.isFinite(lw0) && lw0 > 0 ? lw0 : 1;         // a canvas that will not say: one pixel
  const coreR = (lw * 5.5) / 2;
  const R = bulgeFit(Math.min(centre, curve.total - centre), Rfull, coreR);
  const amp = (R - coreR) / (Rfull - coreR || 1);
  if (amp < 0.002) return;
  const span = bulgeReach(R, coreR);
  const STEPS = 72;
  const samples = [];
  for (let k = 0; k <= STEPS; k++) {
    const d = -span + (2 * span * k) / STEPS;
    samples.push({ ...curve.at(centre + d), r: bulgeProfile(d, R, coreR) });
  }
  // NO SPHERE, ONLY THE TUBE (operator, 2026-09-14: "I don't want to see the sphere. I want to see the
  // obvious deformation of the tube"). What sells a hose being forced wide is the hose: its skin
  // stretches into the round profile and thins, its hot core keeps running straight through the
  // middle, and light catches the stretched outline.
  //   glow layers    follow the swollen wall at their own constant offset (the skin keeps its halo)
  //   the outer core the WALL: filled out to the profile, as solid as the rest of the line
  //   inner cores    MAGNIFIED with the wall, as through a fish-eye lens: each keeps its share of the
  //                  tube's width, so the bright thread swells out through the middle of the bulge
  //                  (operator: "the yellow line running through the center of the bulge needs to
  //                  fish-eye lense distort out instead of staying uniformly thin")
  // Only the part beyond the tube already stroked is filled, so translucent layers never double up.
  const band = (rOf, fill, side) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    samples.forEach((q, k) => { const r = rOf(q); const x = q.x + q.nx * side * r, y = q.y + q.ny * side * r; if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    return (r0) => { for (let k = samples.length - 1; k >= 0; k--) { const q = samples[k]; ctx.lineTo(q.x + q.nx * side * r0, q.y + q.ny * side * r0); } ctx.closePath(); ctx.fill(); };
  };
  for (const [w, c, a, kind] of layers) {
    const r0 = (lw * w) / 2;
    const isWall = kind === 'core' && w === Math.max(...layers.filter((l) => l[3] === 'core').map((l) => l[0]));
    if (kind === 'core' && !isWall) {
      const lens = (q) => r0 * (q.r / coreR);
      for (const side of [1, -1]) band(lens, `rgba(${c[0]},${c[1]},${c[2]},${a})`, side)(r0);
      continue;
    }
    const off = r0 - coreR;
    // OPAQUE (operator: "Get rid of the transparency effect and keep the yellow line opaque, not clear"):
    // the swollen wall is filled solid, where it had been drawn as thinner see-through skin
    const alpha = isWall ? 1 : a;
    for (const side of [1, -1]) band((q) => q.r + off, `rgba(${c[0]},${c[1]},${c[2]},${alpha})`, side)(r0);
  }
  // the stretched outline catching the light, brightest where it is stretched furthest, and on the
  // upper side a highlight running along the swell, on the lower a faint shadow -- the roundness
  const liftOf = (q) => Math.max(0, (q.r - coreR) / (R - coreR || 1));
  const upSide = samples[samples.length >> 1].ny < 0 ? 1 : -1;       // the side whose normal points up the screen
  const trace = (side, rOf, colOf, width) => {
    for (let k = 0; k < samples.length - 1; k++) {
      const q = samples[k], r = samples[k + 1], lift = liftOf(q);
      if (lift < 0.02) continue;
      ctx.strokeStyle = colOf(lift);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(q.x + q.nx * side * rOf(q), q.y + q.ny * side * rOf(q));
      ctx.lineTo(r.x + r.nx * side * rOf(r), r.y + r.ny * side * rOf(r));
      ctx.stroke();
    }
  };
  for (const side of [1, -1]) trace(side, (q) => q.r, (lift) => `rgba(255,250,215,${(0.95 * lift * amp).toFixed(3)})`, Math.max(0.8, lw * 1.4));
  trace(upSide, (q) => coreR + (q.r - coreR) * 0.62, (lift) => `rgba(255,255,240,${(0.55 * lift * amp).toFixed(3)})`, Math.max(0.8, lw * 1.8));
  trace(-upSide, (q) => coreR + (q.r - coreR) * 0.7, (lift) => `rgba(110,70,0,${(0.3 * lift * amp).toFixed(3)})`, Math.max(0.8, lw * 2.2));
}

// THE LINE, ELECTRIFIED where ball lightning passes: every segment within reach of the ball takes
// a blue charge that fades with distance, plus a few sparks jumping off it -- the line is one of
// the "elements it comes near"
function electrifyLine(ctx, pts, view, lw) {
  const s = view.fx.stormball;
  const U = view.unit ?? 8;
  const c = project(s.at.x, s.at.y, s.at.z, view);
  const reach = U * 9;
  const charged = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    const d = Math.hypot(mx - c.x, my - c.y);
    if (d < reach) charged.push([i, 1 - d / reach]);
  }
  if (!charged.length) return;
  const seg = (i, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.stroke(); };
  for (const [i, k] of charged) {
    const a = k * k;
    seg(i, lw * 16, `rgba(40,120,255,${(0.28 * a).toFixed(3)})`);
    seg(i, lw * 7, `rgba(90,190,255,${(0.7 * a).toFixed(3)})`);
    seg(i, lw * 2.4, `rgba(220,245,255,${(0.95 * a).toFixed(3)})`);
    // sparks off the charged wire, new every frame
    if (a > 0.35 && Math.random() < 0.6) {
      const p = pts[i], ang = Math.random() * Math.PI * 2, len = U * (0.6 + Math.random() * 1.4);
      ctx.strokeStyle = `rgba(200,240,255,${(0.9 * a).toFixed(3)})`; ctx.lineWidth = Math.max(lw, U * 0.05);
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(ang) * len * 0.5 + (Math.random() - 0.5) * U, p.y + Math.sin(ang) * len * 0.5);
      ctx.lineTo(p.x + Math.cos(ang) * len, p.y + Math.sin(ang) * len);
      ctx.stroke();
    }
  }
}


// A LIGHT SABER (operator, 2026-09-15: "add another markets effect that really rips off a star wars
// light saber visual somehow"). The price line is the blade. It IGNITES from the left end -- the
// blade extends along the line with a flash at the hilt and a bright tip -- HUMS for most of the
// run (the glow breathes on two fast sines, the core shimmers, and now and then a spark spits off
// the blade), and RETRACTS to the hilt. One of four colours a run, hashed from the seed: blue,
// green, red, purple. The unlit rest of the line stays as the faint wire. Nothing here is the
// price line's resting look, which is the steady neon glow (markets.test.js keeps it so).
const SABER_COLS = [[80, 170, 255], [90, 255, 130], [255, 70, 70], [200, 100, 255]];
function drawSaberLine(ctx, pts, lw, fx, view, GLOW, CORE) {
  const u = fx.u, now = view.now ?? 0;
  const col = SABER_COLS[Math.floor(hash01(fx.seed + 7) * SABER_COLS.length)];
  const c = col.join(',');
  const pale = col.map((v) => Math.round(v + (255 - v) * 0.55)).join(',');
  const IGN = 0.14, RET = 0.86;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const ext = u < IGN ? ease(u / IGN) : u > RET ? 1 - ease((u - RET) / (1 - RET)) : 1;
  // the faint wire under it all
  const stroke = (w, colour, path) => { ctx.strokeStyle = colour; ctx.lineWidth = lw * w; ctx.beginPath(); path(); ctx.stroke(); };
  const wire = () => traceCurve(ctx, pts);
  for (const [w, cc, a] of [...GLOW, ...CORE]) stroke(w, `rgba(${cc[0]},${cc[1]},${cc[2]},${(a * 0.3).toFixed(3)})`, wire);
  if (ext <= 0.002) return;
  // the lit part: the curve up to `ext` of its length
  const curve = curveByLength(pts);
  const len = curve.total * ext;
  const N = Math.max(2, Math.ceil(64 * ext));
  const blade = [];
  for (let k = 0; k <= N; k++) blade.push(curve.at((len * k) / N));
  const along = () => { ctx.moveTo(blade[0].x, blade[0].y); for (let k = 1; k < blade.length; k++) ctx.lineTo(blade[k].x, blade[k].y); };
  // the hum: the glow breathes on two fast sines, never still
  const hum = 1 + 0.06 * Math.sin(now * 0.05) + 0.035 * Math.sin(now * 0.131 + 1);
  const bright = 0.9 + 0.1 * Math.sin(now * 0.021);
  // a third thicker than the first cut (operator, 2026-09-15: "make the saber effect a bit thicker")
  stroke(44 * hum, `rgba(${c},${(0.11 * bright).toFixed(3)})`, along);
  stroke(27 * hum, `rgba(${c},${(0.24 * bright).toFixed(3)})`, along);
  stroke(15 * hum, `rgba(${c},${(0.58 * bright).toFixed(3)})`, along);
  stroke(8.8, `rgba(${pale},0.92)`, along);
  stroke(4.4, `rgba(255,255,255,${(0.95 * bright).toFixed(3)})`, along);
  // the core shimmers: a thin white thread whose brightness runs along the blade
  for (let k = 0; k < blade.length - 1; k++) {
    const f = 0.5 + 0.5 * Math.sin(now * 0.03 + k * 0.9);
    ctx.strokeStyle = `rgba(255,255,255,${(0.35 * f).toFixed(3)})`; ctx.lineWidth = lw * 1.9;
    ctx.beginPath(); ctx.moveTo(blade[k].x, blade[k].y); ctx.lineTo(blade[k + 1].x, blade[k + 1].y); ctx.stroke();
  }
  // the tip: a bright point with the colour's bloom round it
  const tip = blade[blade.length - 1];
  for (const [r, colour, a] of [[12, c, 0.25], [6.8, pale, 0.7], [3.2, '255,255,255', 1]]) {
    ctx.fillStyle = `rgba(${colour},${a})`; ctx.beginPath(); ctx.arc(tip.x, tip.y, lw * r, 0, Math.PI * 2); ctx.fill();
  }
  // the hilt flashes at ignition and again as the blade comes home
  const flash = u < IGN ? 1 - u / IGN : u > RET ? (u - RET) / (1 - RET) : 0;
  if (flash > 0) {
    const h = blade[0];
    for (const [r, colour, a] of [[26, c, 0.18], [14, pale, 0.45], [6, '255,255,255', 0.9]]) {
      ctx.fillStyle = `rgba(${colour},${(a * flash).toFixed(3)})`; ctx.beginPath(); ctx.arc(h.x, h.y, lw * r * (0.6 + 0.4 * flash), 0, Math.PI * 2); ctx.fill();
    }
  }
  // now and then a spark spits off the blade: a few short lines from one point, gone in a beat
  const beat = Math.floor(now / 90);
  if (ext >= 1 && hash01(fx.seed + beat) < 0.3) {
    const at = curve.at(curve.total * hash01(fx.seed + beat * 3 + 1));
    const srnd = (k) => hash01(fx.seed + beat * 7 + k);
    for (let k = 0; k < 6; k++) {
      const ang = srnd(k) * Math.PI * 2, r = lw * (6 + 12 * srnd(k + 20));
      ctx.strokeStyle = `rgba(${pale},${(0.8 * (0.5 + 0.5 * srnd(k + 40))).toFixed(3)})`; ctx.lineWidth = lw * 1.2;
      ctx.beginPath(); ctx.moveTo(at.x, at.y); ctx.lineTo(at.x + Math.cos(ang) * r, at.y + Math.sin(ang) * r); ctx.stroke();
    }
  }
}
const WIRE_SIG = new WeakMap();           // the GL context -> the wire it last drew (priceLine's retained segment)
function priceLine(ctx, view, axes) {
  let pts = (axes.line ?? []).map((q) => project(q.x, axes.y ?? 0, q.z, view));
  if (pts.length < 2) return;
  // THE LINE BENDS ROUND THE BLACK HOLE (2026-09-15): every point is pushed out from the hole's
  // centre the way a lens pushes a background image -- r' = sqrt(r^2 + rE^2), the Einstein
  // radius rE growing with the hole -- so the chart warps into an arc round the shadow, and
  // the stretch inside the horizon is drawn under the shadow, which covers it
  if (view.fx?.kind === 'blackhole' && view.fx.blackhole) pts = lensPoints(pts, view);
  // and it leans toward the pulsar as that passes (pulsarBend)
  let warp = '';
  if (view.fx?.kind === 'pulsar' && view.fx.pulsar) {
    pts = pulsarBend(pts, view);
    // THE CACHED CURVE MUST KNOW THE LINE MOVED. The key below is the ends and the middle, which
    // is enough while the shape only changes with the series or the camera -- but a bend that
    // travels along the line can leave all three untouched and freeze the warp in place. The
    // star's own position goes in the key, so the path is retraced exactly as often as it bends.
    const b = view.fx.pulsar;
    warp = `|p${b.px.toFixed(2)},${b.py.toFixed(2)},${(b.bright ?? 0).toFixed(2)},${view.fx.u.toFixed(3)}`;
  }
  const lw = ctx.lineWidth;
  const join = ctx.lineJoin, cap = ctx.lineCap;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // ON THE GL RENDERER THE LINE'S HALO IS A GLOW, NOT THREE BANDS (operator, 2026-09-22: "The yellow line on
  // the markets chart looks banded in WebGL. Can we not give it a subtle emissive glow instead of the
  // banding?"). GLOW below is three flat strokes, 30 / 18 / 10 wide: a fall-off in three steps, which the 2D
  // canvas's antialiasing smears and this renderer's crisp edges do not. From here to done(), any stroke at
  // least as wide as the narrowest of them and FAINT (the cores are not) fades across itself in the shader
  // (gl2d.js softStrokeMin); it is emissive too, so the bloom lights the chart round it. Every effect that
  // draws the line through this function gets it -- the breath, the saber, the bulge.
  // (`softGlow: false` keeps the three flat strokes on WebGL too: the parity check compares the same picture)
  if (ctx.gl2d === true && view.softGlow !== false) ctx.softStrokeMin = lw * 9.5;
  // Built once and CACHED, not rebuilt every frame. All six layers stroke the same shape, and the
  // shape only changes when the projected closes do -- which is when the series or the camera
  // changes, not when a frame ticks. drawGround caches its Path2D the same way (l.path); doing it
  // per frame here would allocate and re-trace thirty Beziers sixty times a second underneath an
  // effect that is already the expensive thing on screen.
  const P2 = ctx.gl2d === true || typeof Path2D === 'function';
  let path = null;
  if (P2) {
    const key = `${ctx.gl2d === true ? 'gl' : '2d'}|${pts.length}|${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}|${pts[pts.length - 1].x.toFixed(2)},${pts[pts.length - 1].y.toFixed(2)}|${pts[(pts.length / 2) | 0].y.toFixed(2)}${warp}`;
    if (CURVE.key === key && CURVE.path) path = CURVE.path;
    else {
      try { path = ctx.gl2d === true ? ctx.createPath() : new Path2D(); traceCurve(path, pts); CURVE.key = key; CURVE.path = path; }
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
  const done = () => { ctx.lineWidth = lw; ctx.lineJoin = join; ctx.lineCap = cap; if (ctx.gl2d === true) ctx.softStrokeMin = 0; };
  const HOT = [255, 255, 215];                               // the flash: whiter than the wire
  // THE LINE BREATHES (operator, 2026-09-15: "an effect for the markets page that makes the line
  // breathe in-and-out between those two extents"): three slow swells over the run, each easing
  // the tube from the plain wire to the pulse's heat -- wider, whiter, brighter -- and back.
  if (view.fx?.kind === 'breathe') {
    const bre = 0.5 - 0.5 * Math.cos(view.fx.u * Math.PI * 2 * 3);
    const env = Math.sin(Math.PI * view.fx.u);               // in from nothing and out to nothing over the run
    const k = bre * env;
    for (const [w, c, a] of [...GLOW, ...CORE]) {
      const mix = (j) => Math.round(c[j] + (HOT[j] - c[j]) * 0.8 * k);
      stroke(w * (1 + 0.9 * k), `rgba(${mix(0)},${mix(1)},${mix(2)},${Math.min(1, a * (1 + 0.6 * k))})`);
    }
    done();
    return;
  }
  if (view.fx?.kind === 'saber') { drawSaberLine(ctx, pts, lw, view.fx, view, GLOW, CORE); done(); return; }
  if (view.fx?.kind === 'scan') {
    for (const [w, c, a] of [...GLOW, ...CORE]) stroke(w, `rgba(${c[0]},${c[1]},${c[2]},${a})`);
    scanFlare(ctx, pts, axes, view, lw);
    done();
    return;
  }
  if (view.fx?.kind === 'bulge') {
    for (const [w, c, a] of [...GLOW, ...CORE]) stroke(w, `rgba(${c[0]},${c[1]},${c[2]},${a})`);
    drawBulge(ctx, pts, lw, view.fx.u, [...GLOW, ...CORE], view.fx.ms);
    done();
    return;
  }
  if (!fx) {
    // THE PLAIN WIRE, KEPT ON THE CARD (gl2d.js retained): six strokes of one curve in fixed
    // colours are the same triangles every frame until the curve, the pen or the panel changes --
    // and the curve's cache key above says exactly when it has. Same as last frame: nothing is
    // built and nothing is uploaded. (The lens and the pulsar's bend go in that key already.)
    const wire = () => { for (const [w, c, a] of [...GLOW, ...CORE]) stroke(w, `rgba(${c[0]},${c[1]},${c[2]},${a})`); };
    if (ctx.gl2d === true && path) {
      const sig = `${CURVE.key}|${lw}`, was = WIRE_SIG.get(ctx);
      WIRE_SIG.set(ctx, sig);
      ctx.retained('wire', was === sig, wire);
    } else wire();
    if (view.fx?.kind === 'stormball' && view.fx.stormball) electrifyLine(ctx, pts, view, lw);
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
  // NO BLUE (operator, 2026-09-15: "during the energy pulse, I don't like the blue shift/tint it's
  // adding on everything. Get rid of that, and add a bulge effect around the energy pulse"). The
  // surge is heat now: behind the head the tube goes white-hot through hot gold and cools back to
  // the wire, the cloud behind it is warm, the crackle and the motes are gold and white, and the
  // head is a swell in the pipe (drawBulgeAt) with a white-hot core, not a blue dot.
  const BLUE = [255, 255, 235];                              // the core behind the head: white-hot
  const DEEP = [255, 205, 90];                               // the bloom behind the head: hot gold
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
  // SMALLER AND FAINTER (operator, 2026-09-14: "tune the nebula tails down a bit. They are too
  // large"). Puffs spread about half as far from the line (4 + 78 * age line-widths -> 3 + 38), are
  // a bit over half the radius and grow less with age, and sit at three-quarters of the alpha, so the
  // cloud hugs the wire instead of billowing over the chart. Fewer of them, since each covers less.
  // THE MIST, NOT A PATH OF CIRCLES (operator, 2026-09-15: "the energy pulse effect trail looks
  // really bad. it looks like a path of circles rather than emissive nebula/mist"). The cloud was
  // 160 flat discs, and flat discs of one alpha have edges the eye joins into circles however they
  // are scattered. Each puff is a radial gradient now -- bright at its heart, gone at its rim, so
  // no puff has an edge -- larger, fewer, and laid so they overlap into one glowing haze behind
  // the head that thins and cools down the tail. Hashed, so it holds its shape frame to frame.
  const MIST = 54;
  for (let k = 0; k < MIST; k++) {
    const u = hash01(k * 7 + 13);                         // how far back down the tail it sits
    const at = headAt - u * PULSE_TAIL;
    if (at < 0) continue;
    const off = at > 1 ? (at - 1) / 0.34 : 0;
    if (off >= 1) continue;
    const tint = Math.pow(1 - u, 1.3) * (1 - off);
    const hp = headPoint(pts, at, 0.34);
    if (!hp) continue;
    const a1 = hash01(k * 31 + 101) * Math.PI * 2;
    const spread = lw * (2 + 22 * u) * (0.2 + 0.8 * hash01(k * 17 + 5));
    const rad = lw * (9 + 16 * hash01(k * 13 + 67)) * (1 + 0.9 * u);
    const al = 0.16 * tint * (0.5 + 0.5 * hash01(k * 5 + 29));
    const px = hp.x + Math.cos(a1) * spread, py = hp.y + Math.sin(a1) * spread;
    const warm = u < 0.35 ? '255,236,170' : '255,185,70';
    ctx.fillStyle = gradientOr(ctx, () => ctx.createRadialGradient(px, py, 0, px, py, rad),
      [[0, `rgba(${warm},${al.toFixed(3)})`], [0.4, `rgba(255,185,70,${(al * 0.55).toFixed(3)})`], [1, 'rgba(255,150,40,0)']],
      `rgba(255,185,70,${(al * 0.5).toFixed(3)})`);
    ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
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
    // NO WHOLE-LINE SWELL (operator, 2026-09-15: "the energy pulse effect makes the yellow line
    // entirely grow at the start of the animation, and instantly snap back into the prior size.
    // I want the energy pulse effect growing the thickness of the yellow line in an arced radius
    // around it"). One stroke has one width, so a swell here was the whole wire jumping fat at
    // the start and thin at the end; the swell is the head's bulge (drawBulgeAt), round the head
    // and nowhere else, and the wire keeps its width.
    ctx.lineWidth = lw * w;
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
  // THE BULGE AT THE HEAD: the pipe swells round the surge as it passes, the same stretched skin
  // and fish-eyed core as the bulge effect, at a smaller radius, in the heat's own colours
  {
    const headFrac = Math.max(0, Math.min(1, headAt));
    const curve = curveByLength(pts);
    const coreR = (lw * 5.5) / 2;
    const hotLayers = [...GLOW, ...CORE].map(([w, c, a, kind]) => [w, c.map((v, j) => Math.round(v + (HOT[j] - v) * 0.75)), a, kind]);
    const fadeIn = headAt < 0 ? 0 : headAt > 1 ? Math.max(0, 1 - (headAt - 1) / 0.2) : 1;
    // PROMINENT (operator, 2026-09-15: "the bulging effect is not prominent enough ... It needs a
    // lot more vibrance, presence, and effect"): the swell is the bulge effect's own full size now
    // ...then THREE TIMES THAT (operator: "make the bulge 3 times larger for the energy pulse. It's
    // not obvious the line is being deformed"), then half of that ("reduce the bulge by half")
    // ...then a third bigger ("the bulge effect on the energy pulse is getting lost in the animation.
    // Increase in size by 33%")
    if (fadeIn > 0) drawBulgeAt(ctx, pts, lw, curve.lenAt(headFrac), (Number.isFinite(coreR) && coreR > 0 ? coreR : 2.75) * (1 + 2 * (BULGE_BALL - 1) * fadeIn), hotLayers, curve);
  }
  // THE HAZE (operator, 2026-09-15: "haze effects of some sort for the energy blurring and
  // interfering with the affected areas"): three ghost copies of the charged stretch, each thrown
  // off the wire by a slow wave that runs along it and drifts with the clock, faint and warm, so
  // the wire seems to shimmer through hot air -- and a wide soft light over the whole stretch
  {
    const now0 = view.now ?? 0;
    const i0 = Math.max(0, Math.floor((headAt - PULSE_TAIL) * n)), i1 = Math.min(n, Math.ceil(Math.min(1, headAt) * n));
    if (i1 - i0 >= 1) {
      for (let g = 0; g < 3; g++) {
        ctx.strokeStyle = `rgba(255,220,140,${(0.10 + 0.04 * g).toFixed(3)})`; ctx.lineWidth = lw * (7 - 2 * g);
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const passed = headAt - i / n;
          const tint = passed >= 0 && passed < PULSE_TAIL ? Math.pow(1 - passed / PULSE_TAIL, 1.4) : 0;
          const wob = lw * (3.5 + 2 * g) * tint * Math.sin(now0 * (0.004 + 0.0015 * g) + i * 0.9 + g * 2.1);
          const p = pts[i];
          if (i === i0) ctx.moveTo(p.x, p.y + wob); else ctx.lineTo(p.x, p.y + wob);
        }
        ctx.stroke();
      }
      // the light over the affected area: a wide soft warm glow along the charged stretch
      const mid = pts[Math.floor((i0 + i1) / 2)], span = Math.hypot(pts[i1].x - pts[i0].x, pts[i1].y - pts[i0].y) * 0.7 + lw * 20;
      ctx.fillStyle = gradientOr(ctx, () => ctx.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, span), [[0, 'rgba(255,225,160,0.14)'], [0.5, 'rgba(255,200,110,0.06)'], [1, 'rgba(255,180,80,0)']], 'rgba(255,215,140,0.04)');
      ctx.beginPath(); ctx.arc(mid.x, mid.y, span, 0, Math.PI * 2); ctx.fill();
    }
  }
  // SHIMMER on the charged stretch: a thin white-gold core whose brightness flickers per segment
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
    ctx.strokeStyle = `rgba(255,250,225,${(0.9 * tint * flick).toFixed(3)})`;
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
      arc(legs, 2.4, `rgba(255,170,60,${(0.3 * tint).toFixed(3)})`);
      arc(legs, 0.95, `rgba(255,225,150,${(0.92 * tint).toFixed(3)})`);
      arc(Math.max(1, legs - 1), 0.5, `rgba(255,255,240,${(0.95 * tint).toFixed(3)})`);
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
      ctx.fillStyle = `rgba(255,235,190,${(0.75 * tint * (1 - 0.5 * age)).toFixed(3)})`;
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
      ctx.fillStyle = `rgba(255,235,190,${a.toFixed(3)})`;
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
      // AN UNSTABLE, CRACKLING BALL OF PLASMA (operator, 2026-09-15: "It needs a lot more vibrance,
      // presence, and effect. An unstable crackling ball of plasma"): a sphere of one gradient,
      // white-hot heart through gold to a rim that is not quite there, breathing on two quick
      // sines; three warm wisps of nebula wobbling round it; filaments of discharge skittering over
      // its surface, re-rolled on a 60 ms beat; and every so often it SPITS -- a few sparks thrown
      // up and out that arc under gravity, slow, and fade (their flights are pure functions of the
      // clock and the moment they were spat, so nothing is kept between frames).
      const nowH = view.now ?? 0;
      const breathe = 1 + 0.08 * Math.sin(nowH * 0.011) + 0.05 * Math.sin(nowH * 0.023 + 1);
      const RB = lw * 16 * (0.6 + 0.4 * f) * breathe;
      const wispsH = [['255,170,60', 0.34, 1.0], ['255,120,80', 0.26, -0.7], ['255,230,150', 0.22, 0.5]];
      wispsH.forEach(([wc, wa, spin], k) => {
        const t = nowH * 0.0011;
        const wx = hp.x + Math.cos(t * spin * 0.6 + k * 2.1) * RB * 0.5, wy = hp.y + Math.sin(t * spin * 0.45 + k * 1.3) * RB * 0.4;
        const base = RB * (1.7 + 0.4 * k);
        ctx.beginPath();
        for (let i = 0; i <= 36; i++) {
          const th = (i / 36) * Math.PI * 2;
          const wob = 1 + 0.26 * Math.sin(th * 3 + t * spin * 3 + k) + 0.15 * Math.sin(th * 5 - t * 2.4 * spin + k * 3);
          const rr = base * wob, x = wx + Math.cos(th) * rr, y = wy + Math.sin(th) * rr;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = gradientOr(ctx, () => ctx.createRadialGradient(wx, wy, 0, wx, wy, base * 1.4), [[0, `rgba(${wc},${(wa * f).toFixed(3)})`], [0.4, `rgba(${wc},${(wa * 0.6 * f).toFixed(3)})`], [1, `rgba(${wc},0)`]], `rgba(${wc},${(wa * 0.3 * f).toFixed(3)})`);
        ctx.fill();
      });
      ctx.fillStyle = gradientOr(ctx, () => ctx.createRadialGradient(hp.x, hp.y, 0, hp.x, hp.y, RB * 1.35), [
        [0, `rgba(255,255,255,${f.toFixed(3)})`], [0.16, `rgba(255,250,225,${f.toFixed(3)})`], [0.38, `rgba(255,232,150,${(0.95 * f).toFixed(3)})`],
        [0.6, `rgba(255,190,80,${(0.8 * f).toFixed(3)})`], [0.82, `rgba(255,140,50,${(0.4 * f).toFixed(3)})`], [1, 'rgba(255,120,40,0)'],
      ], `rgba(255,232,150,${(0.95 * f).toFixed(3)})`);
      ctx.beginPath(); ctx.arc(hp.x, hp.y, RB * 1.35, 0, Math.PI * 2); ctx.fill();
      // the discs the tests know the head by: its hot centre and its white point, over the sphere
      for (const [r, c0, a0] of [[7, '255,232,150', 0.95], [3, '255,252,225', 1]]) {
        ctx.fillStyle = `rgba(${c0},${(a0 * f).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(hp.x, hp.y, lw * r * (0.55 + 0.45 * f), 0, Math.PI * 2); ctx.fill();
      }
      // the crackle over its surface: short filaments between two points on and just off the ball
      {
        const beat = Math.floor(nowH / 60);
        let x = ((fx.seed ?? 1) ^ (beat * 2654435761)) >>> 0 || 1;
        const rr = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296);
        for (let i = 0; i < 12; i++) {
          const ang = rr() * Math.PI * 2, r0 = RB * (0.35 + 0.5 * rr()), r1 = RB * (1.05 + 0.6 * rr());
          const p = { x: hp.x + Math.cos(ang) * r0, y: hp.y + Math.sin(ang) * r0 };
          const q = { x: hp.x + Math.cos(ang + (rr() - 0.5) * 0.9) * r1, y: hp.y + Math.sin(ang + (rr() - 0.5) * 0.9) * r1 };
          const mid = { x: (p.x + q.x) / 2 + (rr() - 0.5) * RB * 0.35, y: (p.y + q.y) / 2 + (rr() - 0.5) * RB * 0.35 };
          for (const [w, col] of [[2.2, `rgba(255,170,60,${(0.55 * f).toFixed(3)})`], [0.9, `rgba(255,250,225,${(0.95 * f).toFixed(3)})`]]) {
            ctx.strokeStyle = col; ctx.lineWidth = lw * w; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(mid.x, mid.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          }
        }
      }
      // THE SPIT: every 140 ms there is a one-in-three chance the ball throws three sparks; each
      // flight is (birth, angle, speed) and the clock, so it is drawn from those alone
      {
        const STEP = 140, LIFE = 1500;
        const t0 = nowH - (fx.u ?? 0) * (fx.ms ?? FX_MS.pulse);
        const kNow = Math.floor(nowH / STEP);
        for (let k = kNow - Math.ceil(LIFE / STEP); k <= kNow; k++) {
          if (hash01((fx.seed ?? 1) + k * 3) > 0.33) continue;
          const born = k * STEP, age = (nowH - born) / LIFE;
          if (age < 0 || age >= 1) continue;
          const uk = (born - t0) / (fx.ms ?? FX_MS.pulse);
          const bp = headPoint(pts, uk / PULSE_TRAVEL, OVERRUN);
          if (!bp) continue;
          for (let m = 0; m < 3; m++) {
            const hh = (q) => hash01((fx.seed ?? 1) + k * 31 + m * 7 + q);
            const ang = -Math.PI / 2 + (hh(1) - 0.5) * 2.2, sp = lw * (14 + 16 * hh(2));
            const ease = 1 - Math.exp(-3 * age);
            const sx = bp.x + Math.cos(ang) * sp * ease * 2.2, sy = bp.y + Math.sin(ang) * sp * ease * 2.2 + lw * 34 * age * age;
            const px = bp.x + Math.cos(ang) * sp * Math.max(0, ease - 0.12) * 2.2, py = bp.y + Math.sin(ang) * sp * Math.max(0, ease - 0.12) * 2.2 + lw * 34 * Math.max(0, age - 0.08) ** 2;
            const al = (1 - age) * f;
            ctx.strokeStyle = `rgba(255,200,100,${(0.7 * al).toFixed(3)})`; ctx.lineWidth = lw * 1.6;
            ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(sx, sy); ctx.stroke();
            ctx.fillStyle = `rgba(255,250,225,${(0.95 * al).toFixed(3)})`;
            ctx.beginPath(); ctx.arc(sx, sy, lw * 1.3 * (1 - 0.5 * age), 0, Math.PI * 2); ctx.fill();
          }
        }
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
        bolt(legs, 2.4, `rgba(255,170,60,${(0.32 * f).toFixed(3)})`);
        bolt(legs, 0.95, `rgba(255,225,150,${(0.9 * f).toFixed(3)})`);
        bolt(Math.max(1, legs - 1), 0.5, `rgba(255,255,245,${(0.95 * f).toFixed(3)})`);
      }
    }
  }
  done();
}

/** Is this tag colour (#rrggbb or rgb()) light enough that dark figures read better on it than white? Pure. */
export function tagIsLight(colour) {
  const c = String(colour ?? '');
  let v = null;
  const h = c.match(/^#([0-9a-f]{6})/i);
  if (h) v = [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16));
  else { const m = c.match(/rgba?\(([^)]+)\)/); if (m) v = m[1].split(',').slice(0, 3).map(Number); }
  if (!v || v.some((x) => !Number.isFinite(x))) return false;
  const lin = v.map((x) => { const u = x / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (L + 0.05) / 0.0533 > 1.05 / (L + 0.05);        // near-black's contrast against white's
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
    // the figures take whichever ink reads on the tag: white on the rising price's green measures
    // 2.2:1 (WCAG asks 4.5 for text), near-black on it 9:1. The tag's colour is the caller's, so
    // the choice is made from its luminance rather than assumed
    ctx.fillStyle = t.strong ? (tagIsLight(t.color) ? 'rgba(4,16,10,1)' : 'rgba(255,255,255,1)') : 'rgba(185,255,220,1)';
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
// THE LIVING SKY IS NOT THE STAR FIELD (operator, 2026-09-16: "The sky is not drawing for me ...
// The background is all black for me"). With the living sky chosen and the Star field switch off,
// this gate turned off the day as well: a blue afternoon and a moonrise were being hidden by a
// switch about stars. A board that asks for the living sky draws it whatever that switch says;
// `stars` still decides the star field, which the living sky brings out at night by itself.
// the Earth sky (settings.js calls it 'earth'; 'living' was its name for a day and still answers)
const earthSky = (o) => o.skyType === 'earth' || o.skyType === 'living';
const starsOn = (o) => earthSky(o) || !!(o.stars ?? o.space);
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
/** The most the rotation slider multiplies that by (sky.galaxySpin): a turn in under a minute. */
export const GALAXY_SPIN_MAX = 20;
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
    out.push({ gr: rad, ga: ang, tint, size, puffs });
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
    out.push({ gr: rad, ga: ang, size, puffs });
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
  const fit = (Math.min(pw, ph / GALAXY_FLATTEN) / 2) * reach;
  // TO THE FAR CORNER, WHATEVER THE SHAPE (operator, 2026-09-18: "Can we extend galaxy rendering
  // for the entire background in the markets 3d view? It gets cut of on the right side"). `fit`
  // is sized off the SHORT side, so on a panel much wider than it is tall -- the Markets board,
  // ~3.5:1 -- the disc ended two thirds of the way across and left the right side bare. The disc
  // now reaches at least the panel's farthest corner (measured in the unflattened disc, where the
  // stars live), and the star count grows by the area it gained, so the density slider still means
  // the same thing on a wide panel as on a squarer one.
  const far = Math.hypot(Math.max(fx, 1 - fx) * pw, (Math.max(fy, 1 - fy) * ph) / GALAXY_FLATTEN);
  const maxR = Math.max(fit, far);
  const grow = maxR / fit;
  return { cx: pw * fx, cy: ph * fy, maxR, inner: maxR * 0.08, oversample: oversample * grow * grow };
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
  if (!nebulae && !dust && !opts.__glCtx) return null;      // (on WebGL there is still the arms' haze to bake)
  const key = `${bright.toFixed(3)}|${nebulae}|${dust}`;
  if (f.gas && f.gas.key === key && f.gas.ctx === (opts.__glCtx ?? null)) return f.gas;
  // ON THE GL RENDERER THE GAS IS BAKED BY A SHADER (gasLayerGl, below): real clouds. It falls
  // through to the bitmap of ellipses where the card cannot, and on the 2D canvas always.
  if (opts.__glCtx) {
    const baked = gasLayerGl(opts.__glCtx, f, pw, ph, bright, nebulae, dust, key);
    if (baked) return baked;
    if (!nebulae && !dust) return null;                     // (no card to bake the haze, and nothing else to bake)
  }
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
  bmp.__v = (bmp.__v | 0) + 1;          // the GL renderer uploads a stamped bitmap once per stamp (gl2d.js textureOf)
  f.gas = { key, bmp, q, D, ctx: null };
  return f.gas;
}

// THE GAS AS GAS (operator, 2026-09-21: "Can we fix up the nebulas at least so they are not overlapping
// circles, and make them proper gas clouds?"). The bitmap above is what a 2D canvas can fill: each
// nebula two or three dozen flat translucent ellipses, and however they are shuffled the eye finds the
// rims. A fragment shader has no rims to find. The same clouds -- same places on the arms, same sizes,
// same tints, from the same seeded lists -- are each a soft envelope laid ALONG its spiral arm, broken
// into billows and filaments by warped noise, whiter where they are dense, with a second hue riding the
// filaments (the pink of hydrogen on a blue cloud, the blue of reflected starlight on a rose one). The
// dust is ragged ribbons that ABSORB what is under them, not black ovals. Baked once (gl2d.js bake) into
// a texture the size the bitmap was, and drawn the way the bitmap is: one turned quad a frame.
const GAS_GLSL = `
uniform vec4 uGeo;                  // the picture's size in px, px per disc unit, the log-spiral's pitch angle
uniform vec4 uOpt;                  // brightness, nebulae on, dust on
uniform vec4 uArm;                  // the spiral: inner radius, outer radius, arms, twist (disc units)
uniform vec4 uNeb[9];               // x, y (disc units), size, the angle it lies at
uniform vec4 uTint[9];              // r, g, b (0..1), a seed
uniform vec4 uDust[14];             // x, y, size, angle
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h2(vec2 i) { ivec2 c = ivec2(i); uint n = (uint(c.x) * 1597334677u) ^ (uint(c.y) * 3812015801u); n ^= n >> 16; n *= 0x7feb352du; n ^= n >> 15; n *= 0x846ca68bu; n ^= n >> 16; return float(n >> 8) / 16777216.0; }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), u.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), u.x), u.y); }
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec2 p, int oct) { float a = 0.5, s = 0.0; for (int k = 0; k < 6; k++) { if (k >= oct) break; s += a * vn(p); p = ROT * p * 2.03 + 17.3; a *= 0.5; } return s; }
float ridged(vec2 p, int oct) { float a = 0.5, s = 0.0, w = 1.0; for (int k = 0; k < 6; k++) { if (k >= oct) break; float n = 1.0 - abs(vn(p) * 2.0 - 1.0); n *= n; s += a * n * w; w = clamp(n * 1.6, 0.0, 1.0); p = ROT * p * 2.07 + 9.1; a *= 0.55; } return s; }
vec4 bake(vec2 px) {
  vec2 P = (px - 0.5 * uGeo.xy) / uGeo.z;                  // disc units, the middle of the picture the middle of the disc
  vec3 rgb = vec3(0.0); float alpha = 0.0;
  // THE LIGHT BETWEEN THE STARS: a real spiral's arms are luminous -- unresolved young stars and the gas
  // they light -- and its middle is a warm glow of old ones. The field of separate stars alone reads as
  // a scatter with a shape; this is what makes it read as a GALAXY. The arms are the same log spiral the
  // stars, the clouds and the lanes are laid on (theta = arm + ln(r / inner) / twist), blue-white, patchy,
  // fading outward; the bulge is warm and sits over them.
  {
    float r = length(P), th = atan(P.y, P.x);
    float phase = uArm.z * (th - log(max(r, 1e-3) / uArm.x) / uArm.w);
    float arm = pow(0.5 + 0.5 * cos(phase), 2.4);
    float reachOut = exp(-r / (uArm.y * 0.33)) * smoothstep(uArm.x * 0.6, uArm.x * 2.2, r);
    vec2 np = P / uArm.y * 9.0;
    float patchy = 0.35 + 1.1 * fbm(np + 3.0 * (vec2(fbm(np * 0.7, 3), fbm(np * 0.7 + 4.1, 3)) - 0.5), 5);
    float a = clamp(arm * reachOut * patchy * 0.17 * uOpt.x, 0.0, 0.4);
    vec3 c = mix(vec3(0.36, 0.52, 1.00), vec3(0.95, 0.55, 0.75), 0.35 * smoothstep(0.55, 0.9, fbm(np * 2.3 + 7.0, 3)));   // blue-white, with the pink of star-forming knots
    rgb = c * a; alpha = a;
    // (kept small and under half strength: this sky stands BEHIND a chart, and the first cut's bulge was a lamp)
    float bulge = exp(-r / (uArm.x * 1.25)) * 0.8 + exp(-r * r / (uArm.x * uArm.x * 0.35)) * 0.45;
    float ab = clamp(bulge * 0.36 * uOpt.x, 0.0, 0.6);
    vec3 cb = mix(vec3(1.00, 0.80, 0.55), vec3(1.0, 0.95, 0.85), smoothstep(0.3, 0.9, bulge));
    rgb = rgb * (1.0 - ab) + cb * ab; alpha = alpha + ab * (1.0 - alpha);
  }
  if (uOpt.y > 0.5) for (int i = 0; i < 9; i++) {
    vec4 nb = uNeb[i]; if (nb.z <= 0.0) continue;
    vec2 v = P - nb.xy;
    if (dot(v, v) > nb.z * nb.z * 9.0) continue;
    float ca = cos(nb.w), sa = sin(nb.w);
    vec2 l = vec2(ca * v.x + sa * v.y, -sa * v.x + ca * v.y) / nb.z;      // along the arm, across it; 1 = the cloud's size
    float seed = uTint[i].a * 57.0;
    vec2 warp = vec2(fbm(l * 1.3 + seed, 4), fbm(l * 1.3 + seed + 5.2, 4)) - 0.5;
    vec2 lw = l + 0.9 * warp;                              // the ENVELOPE is warped too: a cloud has no oval outline
    float env = exp(-(lw.x * lw.x / 0.85 + lw.y * lw.y / 0.30));
    float billow = fbm(l * 2.1 + 2.2 * warp + seed * 1.7, 5);
    float fil = ridged(l * 3.0 + 2.6 * warp + seed * 0.9, 5);
    float d = env * smoothstep(0.18, 0.95, billow * 1.25 + 0.30 * fil) * 1.7 + env * env * 0.25;
    d *= 0.75 + 0.5 * fil;
    // hollows: the dark globules and bays every real nebula has
    d *= 1.0 - 0.75 * smoothstep(0.55, 0.78, fbm(l * 1.7 - 1.5 * warp + seed * 2.3, 4));
    d = clamp(d, 0.0, 1.6);
    // (the tints are dark paint -- 48,122,196 is a deep blue made to be laid on thinly, thirty times over.
    // Here a cloud is laid ONCE, so its colour is the tint at full strength; the first bake used them as
    // they were and whitened the dense parts, and the clouds came out grey)
    vec3 tint = uTint[i].rgb / max(uTint[i].r, max(uTint[i].g, uTint[i].b));
    tint = mix(vec3(dot(tint, vec3(0.3, 0.5, 0.2))), tint, 1.25);      // and a little past it: gas is vivid
    vec3 other = tint.b > tint.r ? vec3(0.92, 0.36, 0.52) : vec3(0.40, 0.58, 0.95);   // hydrogen's pink on the cold ones, reflected blue on the warm
    vec3 c = mix(tint, other, 0.40 * smoothstep(0.45, 0.85, fil) * (1.0 - 0.5 * env));
    c = mix(c, vec3(1.0, 0.96, 0.92), 0.30 * smoothstep(1.0, 1.6, d));              // only the densest knots glow toward white
    float a = (1.0 - exp(-d * 0.62)) * 0.62 * uOpt.x;
    rgb = rgb * (1.0 - a) + c * a; alpha = alpha + a * (1.0 - alpha);
  }
  if (uOpt.z > 0.5) for (int i = 0; i < 14; i++) {
    vec4 du = uDust[i]; if (du.z <= 0.0) continue;
    vec2 v = P - du.xy;
    if (dot(v, v) > du.z * du.z * 16.0) continue;
    float ca = cos(du.w), sa = sin(du.w);
    vec2 l = vec2(ca * v.x + sa * v.y, -sa * v.x + ca * v.y) / du.z;
    float seed = float(i) * 13.0 + 3.0;
    vec2 warp = vec2(fbm(l * 1.1 + seed, 3), fbm(l * 1.1 + seed + 3.7, 3)) - 0.5;
    vec2 lw = l + 0.8 * warp;
    float env = exp(-(lw.x * lw.x / 1.9 + lw.y * lw.y / 0.11));                      // a ribbon: long, thin
    float tear = ridged(l * vec2(1.6, 4.0) + 2.0 * warp + seed, 4);
    float a = clamp(env * (0.25 + 1.2 * tear) * 0.62, 0.0, 0.85);
    rgb *= 1.0 - a; alpha = alpha + a * (1.0 - alpha);      // it darkens what is under it, the gas and the sky alike
  }
  rgb += (h2(px) - 0.5) / 255.0 * step(0.001, alpha);       // (where the target is 8-bit, a faint gas bands without this)
  return vec4(max(rgb, 0.0), alpha);
}`;
function gasLayerGl(ctx, f, pw, ph, bright, nebulae, dust, key) {
  if (typeof ctx.bake !== 'function' || f.gasGlFailed === ctx) return null;
  const { cx, cy } = f;
  const reach = Math.max(Math.hypot(cx, cy), Math.hypot(pw - cx, cy), Math.hypot(cx, ph - cy), Math.hypot(pw - cx, ph - cy)) / GALAXY_FLATTEN + 64;
  const q = Math.min(1, GAS_MAX / (2 * reach));
  const D = Math.ceil(2 * reach * q);
  const pitch = Math.atan2(1, GALAXY_TWIST);                // a log spiral crosses every radius at this one angle
  const geo = galaxyGeometry(pw, ph, f.galaxy === true ? GALAXY_AT_DEFAULT : f.galaxy);
  const neb = new Float32Array(9 * 4), tint = new Float32Array(9 * 4), du = new Float32Array(14 * 4);
  (f.nebulae ?? []).slice(0, 9).forEach((c, i) => {
    const t = String(c.tint).split(',').map(Number);
    neb.set([c.gr * Math.cos(c.ga), c.gr * Math.sin(c.ga), c.size * 1.25, c.ga + pitch], i * 4);
    tint.set([t[0] / 255, t[1] / 255, t[2] / 255, (i + 1) / 10], i * 4);
  });
  (f.dust ?? []).slice(0, 14).forEach((d, i) => du.set([d.gr * Math.cos(d.ga), d.gr * Math.sin(d.ga), d.size * 1.3, d.ga + pitch], i * 4));
  const bmp = ctx.bake({ width: D, height: D, glsl: GAS_GLSL, uniforms: { uGeo: [D, D, q, pitch], uOpt: [bright, nebulae ? 1 : 0, dust ? 1 : 0, 0], uArm: [geo.inner, geo.maxR, GALAXY_ARMS, GALAXY_TWIST], 'uNeb[0]': neb, 'uTint[0]': tint, 'uDust[0]': du } });
  if (!bmp) { f.gasGlFailed = ctx; return null; }
  if (f.gas?.bmp?.free) f.gas.bmp.free();                   // the last bake's texture, given back
  f.gas = { key, bmp, q, D, ctx };
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
  // ON THE GL RENDERER THE FIELD LIVES ON THE CARD (gl2d.js starField): the stars' constants are
  // sent once and the turning, the twinkle and the shade are the vertex shader's -- no loop here,
  // no buckets, one draw. Only the giants' glints below still need a place, and there are a few
  // hundred of them, so theirs is worked out alone. `bk` is the key: it is rebuilt exactly when the
  // stars or their colours are.
  const soft = opts.__softStars === true;
  if (ctx.gl2d === true && ctx.starField({ key: bk, stars, soft, galaxy: !!galaxy, cx: f.cx, cy: f.cy, flatten: GALAXY_FLATTEN, colourOf: (s) => (colours || !s.c0 ? s.c : s.c0) }, spin, now, bright)) {
    // (soft stars carry their own halo and spikes, in the shader: the giants' glints are not drawn twice)
    if (!glints || soft) return;
    const bigs = (bk.bigs ??= stars.reduce((l, s, i) => { if (s.big) l.push(i); return l; }, []));
    const cs = Math.cos(spin), sn = Math.sin(spin);
    for (const i of bigs) {
      const s = stars[i];
      if (galaxy) { const ca = Math.cos(s.ga), sa = Math.sin(s.ga); px[i] = f.cx + s.gr * (ca * cs - sa * sn); py[i] = f.cy + s.gr * GALAXY_FLATTEN * (sa * cs + ca * sn); bucket[i] = (px[i] < -4 || px[i] > pw + 4 || py[i] < -4 || py[i] > ph + 4) ? -1 : 0; }
      else { px[i] = s.x; py[i] = s.y; bucket[i] = 0; }
    }
    drawGlints(ctx, stars, bigs, bk, now, bright, colours, dpr);
    return;
  }
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
  drawGlints(ctx, stars, null, bk, now, bright, colours, dpr);
}
// the giants' halo and cross, one by one: a few hundred at most (`only`: their indices, when known)
function drawGlints(ctx, stars, only, bk, now, bright, colours, dpr) {
  const { px, py, bucket } = bk, n = only ? only.length : stars.length;
  for (let k = 0; k < n; k++) {
    const i = only ? only[k] : k;
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
  // THE GL RENDERER'S OWN SKY (operator, 2026-09-21: "how can we improve the visuals on the spiral galaxy
  // background for webgl?" ... "do all 3"): gas baked by a shader with a haze along the arms and a glow at
  // the bulge, stars as points of light, far galaxies as soft smudges. `glSky: false` draws the sky as the
  // 2D canvas does, on WebGL too -- the parity check in scripts/gl-compare.mjs compares the two renderers
  // on the SAME picture, and this one is different on purpose.
  const glSky = ctx.gl2d === true && opts.glSky !== false;
  ctx.__starBright = bright;
  // HOW FAST IT TURNS is a setting (operator, 2026-09-21: "we should add a rotation slider speed for that
  // too"): sky.galaxySpin, in multiples of the shipped turn in fifteen minutes; 0 holds the disc still.
  // The angle is INTEGRATED on the field (as the Formation's clocks are): now x rate would swing the whole
  // disc round on every tick of a drag -- an hour in, 1 -> 1.5 is two turns at once.
  const rate = Number.isFinite(opts.galaxySpin) ? Math.max(0, Math.min(GALAXY_SPIN_MAX, opts.galaxySpin)) : 1;
  if (f.spinAt == null || now < f.spinAt) f.spinAngle = now * GALAXY_SPIN * rate;
  else f.spinAngle += (now - f.spinAt) * GALAXY_SPIN * rate;
  f.spinAt = now;
  const spin = galaxy ? f.spinAngle : 0;
  // the deep field first: distant galaxies, small and still
  if (f.far && opts.galaxies !== false && glSky) {
    // SMUDGES OF LIGHT WITH A SHAPE TO THEM: a soft disc that fades to nothing, a brighter elongated
    // bar or bulge inside it a little off its axis, and a core -- three gradient fills each, where the
    // 2D canvas stacks four flat ellipses whose rims show. (One quad a fill: gl2d.js discs.)
    const glowAt = (x, y, rot, rx, ry, stops) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, ry / rx);
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      for (const [o, c] of stops) gr.addColorStop(o, c);
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    f.far.forEach((g, i) => {
      const R = g.rx * dpr * 1.35, t = g.tint, b = bright;
      const A = (v) => [...String(t).split(',').map(Number), Math.min(1, v * b)];
      glowAt(g.x, g.y, g.rot, R, R * g.ratio, [[0, A(0.20)], [0.35, A(0.085)], [0.7, A(0.025)], [1, A(0)]]);
      glowAt(g.x, g.y, g.rot + 0.5 + 0.4 * ((i * 0.618) % 1), R * 0.55, R * 0.55 * Math.min(1, g.ratio * 0.55), [[0, A(0.16)], [0.6, A(0.05)], [1, A(0)]]);
      glowAt(g.x, g.y, g.rot, R * 0.16, R * 0.16 * Math.max(0.6, g.ratio), [[0, [255, 250, 235, Math.min(1, 0.55 * b)]], [0.5, A(0.18)], [1, A(0)]]);
    });
  } else if (f.far && opts.galaxies !== false && typeof ctx.ellipse === 'function') {
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
  const gas = galaxy ? gasLayer(f, pw, ph, bright, glSky ? { ...opts, __glCtx: ctx } : opts) : null;
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
  drawStarField(ctx, f, pw, ph, dpr, now, spin, galaxy, bright, glSky ? { ...opts, __softStars: true } : opts);
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

// Is the board this frame the board of the last frame on this context? Everything the ground, the
// grid and the cubes are drawn from: the ops themselves (a hover glow, an effect's tint or lift all
// arrive as different fills or points), the options object (one per render3d call), the panel, the
// grid, and no effect that the grid itself draws a part of. Pure but for its memory.
const LAST_BOARD = new WeakMap();
function sameBoard(ctx, ops, opts, view, geom, gridN, gridH, blockRows) {
  const was = LAST_BOARD.get(ctx);
  const now = { ops, opts, pw: geom.pw, ph: geom.ph, gridN, gridH, blockRows, rise: view.risePerUnit,
    // only what the GRID draws of an effect counts here (drawGrid: the ripple's ring, the outline's and
    // the tide's front, the ball's glow); what an effect does to the cubes arrives in the ops, and
    // what it draws over the board is drawn after it -- so a supernova plays over a kept board
    fx: !!view.fx && (view.fx.kind === 'ripple' || view.fx.kind === 'outline' || view.fx.kind === 'tide' || !!view.fx.ball) };
  LAST_BOARD.set(ctx, now);
  if (!was || now.fx || was.fx || was.opts !== opts || was.pw !== now.pw || was.ph !== now.ph || was.gridN !== gridN || was.gridH !== gridH
    || was.blockRows !== blockRows || was.rise !== now.rise || was.ops.length !== ops.length) return false;
  for (let i = 0; i < ops.length; i++) {
    const a = was.ops[i], b = ops[i];
    if (a === b) continue;
    if (a.fill !== b.fill || a.stroke !== b.stroke || a.lw !== b.lw || a.always !== b.always || a.face !== b.face || a.points.length !== b.points.length) return false;
    for (let k = 0; k < a.points.length; k++) if (a.points[k].x !== b.points[k].x || a.points[k].y !== b.points[k].y) return false;
  }
  return true;
}

function paintFrame(ctx, geom, frame, opts, view, gridN, blockRows, gridH = gridN) {
  const { pw, ph, dpr } = geom;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // THE GL SKY DREW THIS FRAME -> THE BOARD CANVAS STAYS TRANSPARENT. The GL layer lives
  // UNDER this canvas (form: the overlay is glued to the board's box below); the board's
  // usual opaque background fill would hide it entirely. The GL clear supplies the black,
  // the gas draws on it, and everything after this point (tiles, grid, labels) paints over
  // the transparent canvas onto the GL sky beneath. Any other sky: the 2D canvas paints
  //   its own background as always.
  ctx.clearRect(0, 0, pw, ph);
  if (!(opts.skyType === 'form' && !opts.formNoGl && !FORM_DEAD.has(ctx) && formGlSupported())) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, pw, ph);
  }
  // THE SKY: the star field, the living sky (livingsky.js: a real day from the clock, with the
  // star field coming out at night through the same drawStars), the galaxy flight
  // (galflight.js: the camera flying through a wrapping chain of galaxies, after NASA SVS 14950),
  // or the Formation (galform.js: a galaxy assembling on a loop, after the TNG50 film --
  // white-on-black gas density, filaments to disc to twin fountains). The Formation runs on
  // WEBGL where the browser offers it (formgl.js: 40k additive-blended GPU particles, the
  // film's coloured plasma look), and falls back to the 2D speck renderer where it does not:
  // headless browsers, VMs, blocklisted GPUs. The GL canvas sits OVER the 2D one (a 2D and a
  // GL context cannot share an element) and only exists while this sky is chosen.
  ctx.emissive = !earthSky(opts);           // the stars throw light; a day sky, bright all over, must not
  if (starsOn(opts)) {
    if (earthSky(opts)) drawLivingSky(ctx, pw, ph, dpr || 1, view.now ?? 0, opts, { softStops, drawStars: (o) => drawStars(ctx, pw, ph, dpr || 1, view.now ?? 0, o) });
    else if (opts.skyType === 'flight') drawGalaxyFlight(ctx, pw, ph, dpr || 1, view.now ?? 0, opts, { drawStars: (o) => drawStars(ctx, pw, ph, dpr || 1, view.now ?? 0, { ...o, galaxy: false, galaxies: false, nebulae: false, dust: false, clusters: false }) });
    else if (opts.skyType === 'form') {
      let drew = false;
      if (!opts.formNoGl && !FORM_DEAD.has(ctx) && formGlSupported()) {
        let st = FORM_GL.get(ctx);
        if (!st) {
          // the GL canvas goes directly under this one, glued to its box (layerUnder, above)
          const el = ctx.canvas;
          // THE CANVAS'S OWN CSS BACKGROUND BLOCKS THE GL LAYER (the price-chart board
          // carries `background: #020906` in app.css): a canvas's transparent pixels show
          // its CSS background, not what sits behind the element. While the GL sky runs,
          // the CSS background must be transparent -- saved here, restored on dispose.
          st = { canvas: null, ctl: null, gone: false, bg: el.style.background, pos: el.style.position };
          st.canvas = layerUnder(el);
          el.style.background = 'transparent';
          FORM_GL.set(ctx, st);
        }
        glueUnder(st.canvas, ctx.canvas);     // layouts shift it around
        if (!st.ctl && !st.gone) {
          st.ctl = formGlAttach(st.canvas, { onLost: () => { st.gone = true; } });
          if (!st.ctl) st.gone = true;
        }
        if (st.ctl) drew = st.ctl.draw(pw, ph, dpr || 1, view.now ?? 0, opts);
        // THE LAYER DECLINED (no shader, a lost context, a software rasteriser -- formgl.js): it
        // stands down for good on this board, its canvas and the CSS background given back, and
        // THIS frame -- which skipped its background fill expecting a sky under it -- paints one.
        // Without this a declined layer left the board canvas clear over nothing at all.
        if (!drew) {
          FORM_DEAD.add(ctx); dropFormGl(ctx);
          ctx.fillStyle = opts.background; ctx.fillRect(0, 0, pw, ph);
        }
      }
      // the fallback paints the 2D layer alone when there is no GL
      if (!drew) drawGalaxyForm(ctx, pw, ph, dpr || 1, view.now ?? 0, opts);
    }
    else {
      // ANY OTHER SKY: the Formation's GL apparatus, if this board ever ran it, must stand
      // down -- the CSS background restored, the GL canvas removed -- or it would keep
      // drawing behind (and, with its own clear, blank out) every other sky.
      dropFormGl(ctx);
      if (earthSky(opts)) drawLivingSky(ctx, pw, ph, dpr || 1, view.now ?? 0, opts, { softStops, drawStars: (o) => drawStars(ctx, pw, ph, dpr || 1, view.now ?? 0, o) });
      else if (opts.skyType === 'flight') drawGalaxyFlight(ctx, pw, ph, dpr || 1, view.now ?? 0, opts, { drawStars: (o) => drawStars(ctx, pw, ph, dpr || 1, view.now ?? 0, { ...o, galaxy: false, galaxies: false, nebulae: false, dust: false, clusters: false }) });
      else drawStars(ctx, pw, ph, dpr || 1, view.now ?? 0, opts);
    }
  }
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
  frame.__fit = { scaleX: fit.scaleX, scaleY: fit.scaleY, tx: fit.tx, ty: fit.ty, ph, pw, unit: opts.unit };
  ctx.lineWidth = Math.max(0.5, 0.6 / Math.min(fit.scaleX, fit.scaleY));
  ctx.lineJoin = 'round';

  // The ground first, then the shadows lying on it, then the glowing layer
  // (drawGrid returns it) -- light, so no shadow dims it -- then the cubes.
  // THE BOARD ITSELF -- the ground, the grid, the wall and every cube -- is the same drawing frame
  // after frame while nothing moves, and on the GL renderer it is then kept on the graphics card
  // instead of being built again (gl2d.js retained): sameBoard compares this frame's ops with the
  // last frame's, value for value, so "the same" is measured, never assumed.
  const board = () => {
    ctx.emissive = true;
    let glow = opts.grid ? drawGrid(ctx, view, opts, gridN, blockRows, gridH) : null;
    let wall = opts.axes ? () => drawAxes(ctx, view, opts.axes, gridN) : null;
    // (ctx.emissive is the GL renderer's: what throws light in its bloom. The cubes do NOT -- their
    // colour is the feerate -- so it is off round them and on for the neon, the line and the effects.
    // On the 2D context it is a property nobody reads.)
    for (const op of frame.ops) {
      if (glow && op.face !== 'shadow') { ctx.emissive = true; glow(); glow = null; }
      if (wall && op.face !== 'shadow') { ctx.emissive = true; wall(); wall = null; }
      ctx.emissive = op.always === true;       // a neon tube's edge is a lamp; a stone is not
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
    ctx.emissive = true;
    if (glow) glow();   // a board with no cubes on it
    if (wall) wall();
  };
  if (ctx.gl2d === true) ctx.retained('board', sameBoard(ctx, frame.ops, opts, view, geom, gridN, gridH, blockRows), board);
  else board();
  ctx.emissive = true;                       // (a replayed board never ran the line that leaves it on)
  if (opts.axes?.line) { priceLine(ctx, view, opts.axes); if (ctx.gl2d === true) ctx.softStrokeMin = 0; }   // (whichever way priceLine left: the glow rule is the line's alone)
  // THE LABELS ARE READ, NOT LIT (operator, 2026-09-21, of the current price on the WebGL board with
  // the glow on: "blue is background is hard to read for current price"). The tag's box is a flat
  // bright fill, and drawn as a lamp its own bloom poured back over it: the green of a rising
  // price washed out to a pale blue under white figures. A label throws no light.
  if (opts.axes) { ctx.emissive = false; axisLabels(ctx, view, opts.axes, gridN, fit.scaleX, dpr || 1); ctx.emissive = true; }
  // THE AGENT'S OWN GEOMETRY, dispatched from the registry (agents.js). The light cycles' walls
  // and the lightning ball were two hard-coded calls here; with fifty agents this is the seam.
  // drawCycles and drawBall stay in this module -- lightcycle-crash.test.js imports drawCycles by
  // name and calls it with a hand-built view -- and the registry simply points at them.
  const agentDraw = view.fx?.kind ? AGENTS[view.fx.kind]?.draw : null;
  if (agentDraw) agentDraw(ctx, view, ctx.lineWidth, { drawCycles, drawBall, project });
  else { drawCycles(ctx, view, ctx.lineWidth); drawBall(ctx, view, ctx.lineWidth); drawFireworks(ctx, view, ctx.lineWidth); drawSupernova(ctx, view, ctx.lineWidth); drawBlackHole(ctx, view, ctx.lineWidth); drawPulsar(ctx, view, ctx.lineWidth); drawScanCurtain(ctx, view, ctx.lineWidth); }
  // A CALLER'S OWN LAYER, over the board and in the board's own projection (operator, 2026-09-16:
  // "We have fucking firework and nebula effects and you're doing shitty block and sprite
  // explosions?"). The effects above are the renderer's, chosen by cadence and seed; a game needs
  // to draw ITS events -- a shell landing here, at this instant -- with the same primitives. The
  // hook hands over the projector and softStops, so an explosion is built the way the fireworks
  // are rather than out of tiles, and lands exactly where the cell it destroyed was.
  if (typeof opts.overlay === 'function') opts.overlay(ctx, view, { project, softStops, lw: ctx.lineWidth });
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
  st.axes = opts.axes ?? null;   // the price board's axes and line, so an agent's build() knows which board it is on
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
    opts.starDensity, opts.starBrightness, opts.galaxy === true, opts.galaxyAt, opts.galaxySpin,
    opts.nebulae !== false, opts.galaxies !== false, opts.dust !== false, opts.clusters !== false,
    opts.starColours !== false, opts.starGlints !== false,
    opts.skyType, opts.skyClock, opts.skyHour, opts.skyWeather, opts.skyCover, opts.skyLat, opts.skyRays !== false, opts.skyRainbow === true, opts.skyShooting !== false, opts.skyHorizon, opts.skyMoon, opts.formSpeed, opts.formAt, opts.formBrightness, opts.formFlow, opts.formPalette,
    rendererOf(opts),                     // a parked board repaints when the renderer is switched
    fpsWanted(opts),                      // ...and when the frame-rate figure is switched on or off
    opts.neon === true, opts.sheen === true, opts.sheenStyle, opts.overheadLight === true, opts.light,
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
  // the cap runs from the later of the parking and the effect's own start: a layout parked
  // before an effect was forced (triggerIdle) must still wait that effect out, not lift off
  // under it because the clock started early
  const heldSince = st.pendingAt == null ? null : Math.max(st.pendingAt, st.fx?.t0 ?? 0);
  const fxHolding = (!!fxNow(st, now) || fxResting(st, now)) && sig !== st.sig
    && (heldSince == null || now - heldSince < FX_DEFER_MAX);
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
      // the camera, plus settings.js space.perspective folded in: `rise` is how much height
      // foreshortens, and 0 (the default) is the parallel camera this board has always drawn
      seamAlpha: opts.seamAlpha, fx: fxNow(st, t), now: t, light: opts.light, order: opts.order, hoverGlow: glowMap(st, t),
      axes: opts.axes ?? null,   // the price board's axes: buildScene lights candle sides where these exist
      oblique: opts.obliqueRise ? { ...opts.oblique, rise: opts.obliqueRise } : opts.oblique,
      // the departure path (settings.js space.departures): it reaches the geometry AND the paint
      // order through the same view object, which is the only way those two can agree
      departures: opts.departures,
      facetMinUnits: opts.facetPx / pxPerUnit, crownMinUnits: opts.crownPx / pxPerUnit,
      shadows: opts.shadows !== false,   // settings.js: the board can be drawn without them
      // the finishes (settings.js space.neon / space.sheen). They were in the look signature and
      // in buildScene from the first cut, but not HERE, so a flipped switch repainted the same
      // picture (2026-09-12: "I don't see neon blocks working, nor the metallic sheen")
      neon: opts.neon === true, sheen: opts.sheen === true, sheenStyle: opts.sheenStyle,
      overheadLight: opts.overheadLight === true,   // the lamp straight above (Tetrust)
      light: opts.light,                            // or wherever settings.js space.light puts it
      lightHeight: opts.lightHeight,
      lightGain: opts.lightGain, topLight: opts.topLight,   // how hard the lamp is, and how bright the tops sit under it
      neonSource: opts.neonSource, neonColour: opts.neonColour, neonBrightness: opts.neonBrightness,
      wireWidth: opts.wireWidth,
      // the paint order's memory across frames (blockscene3d obliqueOrder): a tangle keeps the
      // relative order it had last frame, so nothing flickers in and out of one
      softGlow: opts.softGlow,                  // (priceLine: the line's halo as a soft glow on WebGL)
      orderMemo: (st.orderMemo ??= new Map()),
    };
    // the panel's extent in grid units, from the same constant fit paintFrame
    // uses: the textured sphere is laid over all of it (drawGrid), and an
    // arrival starts wholly outside it (offscreenLift)
    if (opts.oblique) view.viewRect = obliqueFit(geom.pw, geom.ph, st.gridW, st.gridH, opts).rect;
    // how far the PANEL reaches beyond the board, so a sweeping front enters and leaves out of
    // sight instead of appearing in the middle of the picture (fxFront)
    if (view.fx && view.viewRect) {
      const r = view.viewRect;
      view.fx.margin = Math.max(0 - r.x0, r.x1 - st.gridW, 0 - r.y0, r.y1 - st.gridH, 4) + 3;
      // the scan's beam: its half-width, so fxAt lights exactly the swath the cone covers
      // (its old `pan` out-and-back motion is gone -- one pass, 2026-09-20), and -- on the block
      // board -- the beam's AIM: the pan rides along from fxNow (fx.scanPan), but the landing
      // point is built HERE, after the margin above is known, so it sits on the same front line
      // the saucer flies (fxNow cannot know the margin yet). fxAt lights the tiles under it;
      // drawScanCurtain draws the cone onto it. One record, two consumers, no drift.
      if (view.fx.kind === 'scan') {
        const g = scanBeamGeom(view);
        view.fx.beamR = g.spread;
        if (!g.price && view.fx.scanPan != null) {
          const fp2 = fxFront(view.fx);
          const ax2 = -view.fx.dy, ay2 = view.fx.dx;
          view.fx.panAt = { x: view.fx.gridW / 2 + (fp2 - (view.fx.gridW / 2) * view.fx.dx - (view.fx.gridH / 2) * view.fx.dy) * view.fx.dx + ax2 * view.fx.scanPan,
            y: view.fx.gridH / 2 + (fp2 - (view.fx.gridW / 2) * view.fx.dx - (view.fx.gridH / 2) * view.fx.dy) * view.fx.dy + ay2 * view.fx.scanPan };
        }
      }
    }
    const tA = clockMs();
    const frame = frameAt(st.plan, t, view);
    const surface = surfaceFor(canvas, ctx, geom, opts);
    paintFrame(surface, geom, frame, opts, view, st.gridW, st.blockRows, st.gridH);
    // THE FRAME RATE, top right, where it is asked for (appearance.showFps). On a canvas that has a
    // board on it: a game's sky canvas behind its well is the same view, and one figure is enough.
    if (frame.ops.length && fpsWanted(opts)) drawFps(surface, geom, fpsTick(st, t, clockMs() - tA), surface.gl2d === true ? 'WebGL' : 'Software');
    surface.flush?.();                       // the GL renderer batches; the 2D context has no such call
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
    if (starsOn(opts) && frame.settled && st.pending && !fxNow(st, t) && !fxResting(st, t)) { const p = st.pending; st.pending = null; st.pendingAt = null; st.raf = null; render3d(canvas, p.cells, p.options); return; }
    // keep the loop alive while the choreography runs OR the camera is moving;
    // park otherwise, because repainting a still picture is a heater
    if (frame.settled && !st.dirty && !fxNow(st, t)) {
      // the board is at rest: arm the next effect whether or not the loop is about to park --
      // but ONCE, on the frame it arrives, or a running loop would re-arm the timer for ever
      if (!st.atRest) {
        const afterEffect = st.fx != null;   // an effect just ended -- or it has only now settled
        if (afterEffect) st.fxEndedAt = t;   // the rest before a held refresh runs from here
        st.fx = null;
        st.atRest = true;
        scheduleFx(canvas, st, opts, !afterEffect);
      }
      if (!starsOn(opts) && !glowAnimating(st, t)) {
        st.raf = null;
        if (st.pending) {
          // the loop parks here (no stars to keep it running), so the rest is kept by a timer
          if (fxResting(st, t)) { setTimeout(() => { if (st.pending && st.raf == null) { const p = st.pending; st.pending = null; st.pendingAt = null; render3d(canvas, p.cells, p.options); } }, FX_REST_MS - (t - st.fxEndedAt) + 20); return; }
          const p = st.pending; st.pending = null; st.pendingAt = null; render3d(canvas, p.cells, p.options); return;
        }
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
