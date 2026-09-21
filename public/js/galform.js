// THE FORMATION (operator, 2026-09-21: "suggest a way to replicate" the RAS TNG50 film
// "Formation of a single massive galaxy through time", then "implement 2 as a new sky"):
// the procedural route -- a galaxy assembling itself on a loop. Gas streams in along
// filaments, boils into a turbulent clump, settles into a thin differentially-rotating
// disc, and in the late epochs breathes out along two polar cones that stall and rain
// back -- the galactic fountain of the TNG papers. Thirteen billion years in FORM_CYCLE
// seconds -- and then, since 2026-09-21, it STAYS: mature, turning, its fountains cycling (the operator:
// "have the scene perpetually evolving. don't fade it out"). It used to fade to black and begin again.
//
// COLOUR (2026-09-21): this was white-on-black, under a standing rule of the day -- "desaturated slate,
// never vivid". The operator, with the film open, overruled it for this sky: "the pinks, purples,
// oranges". The specks are tinted through the film's ramp now (formgl.js formRamp); everything else
// below about grain and density stands.
// The look was the film's inset panel: gas DENSITY rendered white-on-black. There is no painted glow
// anywhere -- every cloud is a heap of tiny seeded specks and the brightness of the core
// is nothing but how many specks overlap there (operator, standing rule: gas is grain,
// density does the work; desaturated slate, never vivid).
//
// It obeys the canvas rules the rest of the renderer lives by
// (test/viewer-canvas-rules.test.js): no clip, no globalAlpha, no composite modes, no
// shadowBlur, no gradients. Every fill is a plain rgba.
//
// Everything is a pure function of the clock: the same `now` paints the same frame, so a
// replay test can hold the whole film still. No Math.random -- seeded hashes only, the
// same discipline galflight.js keeps.

import { FORM_PLACEMENTS, FORM_AT_DEFAULT, FORM_SPEED_DEFAULT, formRamp } from './formgl.js';

// ------------------------------------------------------------------- the constants
/** Seconds of wall clock for one pass through 13.8 Gyr at speed 1. The RAS film runs two minutes. */
export const FORM_CYCLE = 140;
/** The frame speed 0 holds: the mature disc, fountain up -- the film's best still. */
export const FORM_HOLD = 0.86;
/** The disc plane's tilt on screen, radians: inclined like the film's view, not face-on flat. */
export const FORM_TILT = -0.32;

/** The fountain's burst windows as [start, duration] fractions of the cycle. Two of them:
 * quiet late assembly is punctuated, not continuous -- and the second runs into the wrap
 * fade, so the outflow is still breathing when the loop closes. */
export const FORM_WINDOWS = [[0.60, 0.20], [0.84, 0.14]];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** A seeded hash in [0,1): the only randomness anywhere in this file. */
export function hash01(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ------------------------------------------------------------------- the physics
/**
 * The disc's angular speed at radius r (disc radius 1), rad/s of CYCLE time. DIFFERENTIAL,
 * as a real gas disc turns: the inside laps the outside. Inner edge ~ one turn in 50 s,
 * the rim ~ one in 100 s -- visible over a minute of watching, slow enough to be calm.
 */
export function formW(r) {
  return 0.075 / (Math.pow(Math.max(0.05, r), 0.55) + 0.18);
}

const RAMP_CACHE = {};
/** The way IN: the web comes up out of black over the first 5% of the assembly, and that is the only fade there is. */
export function envIn(u) {
  const s = clamp01(u / 0.05);
  return s * s;
}

/** The OLD loop's envelope (black at both ends). Kept for its test and for whoever wants a loop; the sky no longer uses it. */
export function envAt(u) {
  const s = clamp01(Math.min(u, 1 - u) / 0.05);
  return s * s;
}

/**
 * One gas particle, built once: its birth on a filament (which of six, how far out, how far
 * off the filament's spine), its infall rate and turbulent wiggle, and the orbit it will
 * join -- radius (concentrated inward: pow < 1 piles particles toward the centre, which is
 * where the film's core brightness comes from), angle, and WHEN in the cycle it settles
 * (staggered: the disc assembles from the inside out, the way the film's does).
 */
export function formField(seed = 11, count = 9000) {
  const NF = 6;
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 131 + i * 17.31 + k);
    const f = Math.floor(h(1) * NF);
    // THE BULGE: 30% of the gas concentrates hard on the centre (r^2.2 distribution) and
    // settles early -- the core's white is these thousands of specks overlapping, never a
    // painted glow. The rest lays the disc with a mild inward lean (r^0.62).
    const bulge = h(18) < 0.30;
    const d0 = 0.9 + 1.6 * h(2);                        // birth distance, disc radii
    const j0 = (h(3) - 0.5) * 0.5;                      // off-spine jitter
    const phi0 = (f * Math.PI * 2) / NF + (h(14) - 0.5) * 0.5 + j0 / d0;
    const sRate = 0.55 + 0.45 * h(4);                   // how fast it falls in
    const swirl = (h(15) - 0.5) * 1.2;                  // the filament's slow curl
    const ph = h(16) * Math.PI * 2;                     // the wiggle's phase
    const r0 = Math.pow(h(5), bulge ? 2.2 : 0.62);      // orbital radius, inward-heavy
    const th0 = h(6) * Math.PI * 2;
    const s0 = bulge ? 0.10 + 0.30 * h(7) : 0.16 + 0.38 * h(7); // when it joins the disc
    const jd = 0.10 + 0.06 * h(8);                      // how long the join takes
    const z0 = (h(9) + h(10) + h(11) - 1.5) / 1.5;      // disc-plane thickness, +/-1
    // the bulge rides much closer to the plane -- a fat vertical smear over a bright core
    // read as a bar, not a galaxy (measured on the first headless render, 2026-09-21)
    const zb = bulge ? z0 * 0.25 : z0;
    const size = bulge ? 0.8 + 1.0 * h(12) : 0.55 + 0.85 * h(12);
    const b = 0.30 + 0.35 * h(13);                      // per-speck alpha ceiling
    const soft = h(17) < 0.10;                          // a minority of big dim haze specks
    out.push({ d0, j0, phi0, sRate, swirl, ph, r0, th0, s0, jd, z0: zb, size, b, soft });
  }
  return out;
}

/**
 * Where one gas particle is at cycle fraction u: {x, y, vz, joined}. x and y are DISC-plane
 * coordinates in disc radii (y already carries the disc's inclination squash, which tightens
 * as the disc cools); vz is the height off the plane, which thins with it. Before its settle
 * time the particle is still on its filament, drifting inward with a turbulent wiggle; the
 * join blends it onto the orbit over its own short span.
 */
export function gasAt(p, u, extraSec = 0) {
  // ON THE FILAMENT: distance shrinks as the cycle runs (never below the clump's core radius),
  // the whole web curling slowly, each particle with its own wiggle on the spine.
  const prog = clamp01(u / 0.6);
  const d = Math.max(0.10, p.d0 * (1 - 0.8 * prog * p.sRate));
  const wig = Math.sin(u * 9 + p.ph) * 0.10 * (1 - prog);
  const phi = p.phi0 + u * p.swirl;
  const cx = Math.cos(phi), cy = Math.sin(phi);
  const off = p.j0 + wig;
  const ix = cx * d + cx * off, iy = cy * d + cy * off;
  // ON THE ORBIT: angle advances only with time already served on the disc, so the picture
  // is a pure function of u and the disc visibly turns.
  const joined = smooth((u - p.s0) / p.jd);
  // (extraSec: the seconds lived SINCE the disc matured -- the picture holds its moment, the disc goes on turning)
  const sec = Math.max(0, u - p.s0) * FORM_CYCLE + extraSec;
  const th = p.th0 + formW(p.r0) * sec;
  const ox = Math.cos(th) * p.r0, oy = Math.sin(th) * p.r0;
  // THE DISC COOLS: squash tightens from a round blob toward the film's thin inclined disc,
  // and the scale height collapses with it -- the settles-into-a-disc arc in two numbers.
  // Cooling starts EARLY (0.25): by mid-cycle the picture must already read as a disc.
  const cool = smooth((u - 0.25) / 0.35);
  const ratio = lerp(0.85, 0.40, cool);
  const vzAmp = lerp(0.22, 0.05, cool);
  return {
    x: lerp(ix, ox, joined),
    y: lerp(iy, oy * ratio, joined),
    vz: p.z0 * vzAmp * joined,
    joined,
  };
}

/**
 * One fountain particle, built once: which burst window it rides, when in the window it
 * launches, which cone (upper or lower), how far off the pole, how energetic.
 */
export function windField(seed = 29, count = 700) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 173 + i * 19.17 + k);
    const win = Math.floor(h(1) * FORM_WINDOWS.length);
    const l = h(2) * 0.5;                                // launch spread over the window's first half
    const sigma = h(3) < 0.5 ? 1 : -1;                   // cone sign: up or down
    const alpha = (h(4) - 0.5) * 0.5;                    // off-pole angle, radians
    const s = 0.7 + 0.6 * h(5);                          // energy
    const Hmax = 0.55 + 0.5 * h(6);                      // apex height, disc radii
    const size = 0.5 + 0.7 * h(7);
    const b = 0.18 + 0.2 * h(8);
    out.push({ win, l, sigma, alpha, s, Hmax, size, b });
  }
  return out;
}

/**
 * Where one fountain particle is at cycle fraction u, or null when it does not exist:
 * ballistic in shape (rises, decelerates, stalls, falls back into the disc -- a fountain,
 * not a jet), faded in at launch and out as it stalls. x and y are SCREEN-relative offsets
 * in disc radii from the galaxy's centre, the pole taken as screen-vertical, which the disc's
 * shallow tilt makes honest.
 */
export function windAt(p, u) {
  const [start, dur] = FORM_WINDOWS[p.win];
  const q = (u - (start + p.l * dur)) / (dur * 0.9);
  if (q <= 0 || q >= 1) return null;
  const h = Math.sin(Math.PI * Math.pow(q, 0.8)) * p.Hmax * p.s;
  const a = smooth(q / 0.10) * smooth((1 - q) / 0.25) * p.b;
  if (a <= 0.004) return null;
  return { x: Math.sin(p.alpha) * h * 0.6, y: -p.sigma * Math.cos(p.alpha) * h, a };
}

/** The distant field: a sparse static backdrop of faint stars, the sky the film's black sits behind. */
export function farStars(seed = 41, count = 150) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 191 + i * 23.7 + k);
    out.push({ x: h(1), y: h(2), r: 0.35 + 0.55 * h(3), b: 0.03 + 0.06 * h(4) });
  }
  return out;
}

// ------------------------------------------------------------------- the draw
let GASL = null, WINDL = null, FARL = null;

/**
 * The Formation sky, where there is no graphics card to draw formgl.js's field. Plain rgba specks
 * only; the core's brightness is density.
 *
 * BROUGHT ALONG WITH THE GL LAYER (operator, 2026-09-21: "bring it along"). Three things are shared:
 *   - it is PERPETUAL: the galaxy assembles once -- web, infall, disc -- and then STAYS, the disc
 *     still turning (gasAt's extraSec) and the fountains still cycling through their two bursts. It
 *     used to loop back to the empty web through a fade to black every 140 s.
 *   - its galaxy sits where `opts.formAt` says (formgl.js FORM_PLACEMENTS: the middle or a corner,
 *     drawn larger in a corner), as the GL layer's does.
 *   - its COLOURS are the film's, through the same ramp the shader is generated from (formRamp):
 *     the far web violet, infalling gas magenta, the disc orange, the core pale yellow. It was
 *     white on black.
 * It has no satellites and no smoke: those are a per-pixel field's, and this is nine thousand dots.
 * `opts.formSpeed` scales the clock (0 holds FORM_HOLD, a still frame).
 */
export function drawGalaxyForm(ctx, pw, ph, dpr, now, opts = {}, helpers = {}) {
  if (!GASL) GASL = formField(11, opts.gasCount ?? 9000);
  if (!WINDL) WINDL = windField(29, 700);
  if (!FARL) FARL = farStars(41, 150);
  const speed = Number.isFinite(opts.formSpeed) ? Math.max(0, Math.min(4, opts.formSpeed)) : FORM_SPEED_DEFAULT;
  const life = (now * speed) / 1000;                               // seconds lived
  const grown = FORM_HOLD * FORM_CYCLE;                            // ...of which this many are the assembly
  const u = speed > 0 ? Math.min(FORM_HOLD, life / FORM_CYCLE) : FORM_HOLD;
  const extra = speed > 0 ? Math.max(0, life - grown) : 0;
  // the fountains: through the assembly they follow it; after it they go round their two windows for ever
  // (both ends of that stretch lie outside a window, so the turn-over shows nothing)
  const W0 = FORM_WINDOWS[0][0], W1 = FORM_WINDOWS[1][0] + FORM_WINDOWS[1][1];
  const uWind = extra > 0 ? W0 + ((FORM_HOLD - W0) + extra / FORM_CYCLE) % (W1 - W0) : u;
  const env = envIn(u);
  // (sky.formBrightness, as the GL layer reads it: 1 is the picture as first made, and it ships at half)
  const bright = Number.isFinite(opts.formBrightness) ? Math.min(1.5, Math.max(0, opts.formBrightness)) : (Number.isFinite(opts.starBrightness) ? Math.min(1.5, Math.max(0, opts.starBrightness)) : 1);
  const place = FORM_PLACEMENTS[opts.formAt] ?? FORM_PLACEMENTS[FORM_AT_DEFAULT];
  const R = Math.min(pw, ph) * 0.55 * place[2];
  const cx = pw * place[0], cy = ph * place[1];
  const cs = Math.cos(FORM_TILT), sn = Math.sin(FORM_TILT);
  const dp = dpr || 1;
  // (the palette is the GL layer's -- formgl.js FORM_PALETTES -- so the two engines wear the same colours)
  const pal = opts.formPalette ?? '';
  const cache = (RAMP_CACHE[pal] ??= []);
  const rgb = (t) => (cache[Math.round(t * 64)] ??= formRamp(Math.round(t * 64) / 64, opts.formPalette).join(','));

  // the distant field, dimmest of all
  for (const s of FARL) {
    const a = s.b * env * bright;
    if (a <= 0.006) continue;
    ctx.fillStyle = `rgba(${rgb(0.42)},${a.toFixed(4)})`;       // the far field: thin gas, violet
    ctx.beginPath();
    ctx.arc(s.x * pw, s.y * ph, s.r * dp, 0, Math.PI * 2);
    ctx.fill();
  }

  // THE GAS: filaments, infall, disc. Unjoined (still on the web) first and dimmer and
  // bluer-slate; the joined disc over it, brighter, and inward-heavy so the core saturates
  // by nothing but overlap.
  for (const p of GASL) {
    const g = gasAt(p, u, extra);
    const px = g.x * cs - g.y * sn;
    const py = g.x * sn + g.y * cs;
    const X = cx + px * R, Y = cy + py * R + g.vz * R * 0.9;
    if (X < -4 || X > pw + 4 || Y < -4 || Y > ph + 4) continue;
    const r = (p.soft ? p.size * 2.2 : p.size) * dp;
    // WHERE ON THE RAMP: the web is thin gas (violet to magenta, the brighter specks further along);
    // joining the disc it runs up through orange, and only the innermost orbits reach the pale end
    const web = 0.34 + 0.22 * p.b, disc = 0.98 - 0.42 * Math.pow(Math.min(1, p.r0), 0.55);
    const tint = rgb(lerp(web, disc, g.joined));
    let a = p.b * (p.soft ? 0.35 : 1) * env * bright;
    if (g.joined > 0) a *= lerp(0.85, 1, g.joined) * (1.15 - 0.35 * Math.min(1, p.r0));
    if (a <= 0.006) continue;
    ctx.fillStyle = `rgba(${tint},${a.toFixed(4)})`;
    ctx.beginPath();
    ctx.arc(X, Y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // THE FOUNTAINS: two cones of wind out of the pole, rising, stalling, raining back.
  for (const p of WINDL) {
    const w = windAt(p, uWind);
    if (!w) continue;
    const X = cx + w.x * R, Y = cy + w.y * R;
    if (X < -4 || X > pw + 4 || Y < -4 || Y > ph + 4) continue;
    const a = w.a * env * bright;
    if (a <= 0.006) continue;
    ctx.fillStyle = `rgba(${rgb(0.66)},${a.toFixed(4)})`;        // hot gas thrown out: salmon
    ctx.beginPath();
    ctx.arc(X, Y, p.size * dp, 0, Math.PI * 2);
    ctx.fill();
  }
}
