// AGENTS: the idle effects that are SOMETHING HAPPENING rather than a pattern.
//
// (operator, 2026-09-13: "no more per-tile stuff. Think more tron lightcycles stuff", then
// "Build all of them with amazing effects", and "we can even add flying ships or other
// pixel-graphic inspired art".)
//
// THE DISTINCTION THIS MODULE EXISTS FOR. Seventeen of the board's effects are FIELDS: pure
// functions of a tile's position and the effect's clock, evaluated everywhere at once
// (`fxAt` in blockscene3d.js). A field is wallpaper -- plasma, aurora, checker, ripple. Three
// were AGENTS: a thing with a position, a route it has already travelled, and a future. You can
// watch an agent and wonder what it will do, and that is the whole difference.
//
// Those three (`lightcycle`, `ball`, and the retired `packets`) were built as `if` branches inside
// details3d.js's startFx and fxNow, with their drawing hard-wired into paintFrame. Fifty of them
// cannot be fifty `if`s in a 2,400-line renderer, so this module holds the registry and every
// agent's three parts, and details3d.js keeps only the seams.
//
// THE CONTRACT. An agent is `{ ms, build, frame, draw }`:
//
//   build(ctx)   once, when the effect starts, with { st, seed, W, H, tops, tiles, rnd }.
//                The board is STILL while an effect runs, so a route, a formation or a sprite's
//                path is decided here and a frame only moves along it. Returns whatever the
//                agent wants to keep; it lands on `fx.agent`.
//   frame(a, u)  every frame, with the built state and progress 0..1. Returns the per-frame
//                shape: `{ heads, ... }`. `heads` is how an agent LIGHTS THE BOARD -- see below.
//   draw(ctx, view, lw)  the agent's own geometry over the cubes, reading `view.fx`.
//
// EVERY AGENT MUST PUBLISH `heads`. effects.test.js plays every registered kind through fxAt and
// demands it light something (`worst > 0.3`); only `pulse` is exempt, because it draws on the
// price line. That test is not an obstacle to work around -- it is what stops an effect being
// painted OVER the board rather than interacting with it. `heads` is
// `[{ x, y, color: [r,g,b], alpha }]` in grid units, and the cubes near one flash in its colour.
//
// DETERMINISM. Board-level choices come from `fxHash(seed)` or the seeded `rnd` handed to
// `build`, never Math.random, so an effect replays identically and a test can assert on it.
// Per-frame sparkle (a crackle re-rolled every frame) may use Math.random because it is never
// asserted frame to frame -- electrical precisely because it never draws twice.
//
// CANVAS RULES. No ctx.clip(), no globalAlpha, no composite modes, no shadowBlur
// (viewer-canvas-rules.test.js scans this file's siblings; every glow here is layered plain rgba).
import {
  project, fxHash, cubeHeight,
  cyclePath, ballPath, cycleCrashes, cellTops, pathHeights,
} from './blockscene3d.js';

// a cheap deterministic 0..1 from an integer. details3d.js keeps its own copy for the price-line
// pulse; duplicating six lines is better than widening that module's public surface for a helper.
export const hash01 = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };

/** A seeded stream, so a build() makes the same board every replay. */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

// ---------------------------------------------------------------- helpers shared by agents

/** Point `d` units along a polyline of grid points, and the index it sits in. */
export function alongPath(pts, d) {
  const end = pts.length - 1;
  const k = Math.max(0, Math.min(end - 1, Math.floor(d)));
  const f = Math.max(0, Math.min(1, d - k));
  const a = pts[k], b = pts[k + 1] ?? a;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, k };
}

/**
 * The tallest resting cube on the board, and its centre. What a data-aware agent aims at.
 *
 * The board is transactions: height is vbytes and `rate` is sat/vB. An agent that heads for the
 * tallest cube is eating the biggest transaction in the block, which is worth more than an agent
 * that wanders -- the picture it draws is then a reading of the data, the way `cascade` is.
 */
export function tallestTile(tiles) {
  let best = null, bh = -1;
  for (const t of tiles ?? []) {
    const h = (t.floor ?? 0) + cubeHeight(t);
    if (h > bh) { bh = h; best = t; }
  }
  return best ? { x: best.x + best.s / 2, y: best.y + best.s / 2, h: bh, tile: best } : null;
}

/** The richest resting cube (highest feerate), for agents that read the fee structure. */
export function richestTile(tiles) {
  let best = null, br = -Infinity;
  for (const t of tiles ?? []) {
    const r = Number(t.rate);
    if (Number.isFinite(r) && r > br) { br = r; best = t; }
  }
  return best ? { x: best.x + best.s / 2, y: best.y + best.s / 2, rate: br, tile: best } : null;
}

// ---------------------------------------------------------------- the registry

/**
 * Every agent, by kind. details3d.js reads this in three places and nowhere else:
 * startFx (build), fxNow (frame) and paintFrame (draw).
 *
 * `lightcycle` and `ball` are migrated here first, unchanged in behaviour, so the contract is
 * proven against the tests that already exist (lightcycle-crash.test.js calls drawCycles with a
 * hand-built view; details3d.test.js asserts triggerIdle accepts both and still REFUSES
 * `packets`, the retired one). New agents are added as data below them.
 */
export const AGENTS = Object.create(null);

/** Register one agent. Kinds are added to FX_MS, settings and the panel separately, in order. */
export function defineAgent(kind, spec) {
  AGENTS[kind] = spec;
  return spec;
}

/** Is this kind an agent (rather than a per-tile field)? */
export const isAgent = (kind) => Object.prototype.hasOwnProperty.call(AGENTS, kind);

// ---------------------------------------------------------------- light cycles
//
// (operator, 2026-09-11: "add an energy pulse that travels along from one side of the board to
// another via block outlines. Be creative and varied", then 2026-09-12 "the lightcycles shouldn't
// have the electricity effect" -- a rider whose point is a clean light wall is not a storm.)
//
// Two riders from opposite edges, each laying a wall along the grid LINES, until one crosses the
// other's wall and de-reses. The routes and the height of every stretch are fixed at build time
// because the board is still; a frame only advances the heads.
defineAgent('lightcycle', {
  draw(ctx, view, lw, api) { api.drawCycles(ctx, view, lw); },
  build({ st, seed, W, H, tiles, rnd }) {
    const tops = cellTops(tiles, W, H);
    const sides = rnd() < 0.5 ? ['left', 'right'] : ['bottom', 'top'];
    const paths = sides.map((side, i) => {
      const pts = cyclePath(seed + i * 7919, W, H, side);
      return { pts, hs: pathHeights(pts, tops, W, H), color: i ? [255, 150, 40] : [80, 220, 255], lag: i * 0.06 };
    });
    void st;
    return { paths, crashes: cycleCrashes(paths) };
  },
  frame(a, u, { ms, derezMs }) {
    const cycles = a.paths.map((p, i) => {
      const len = p.pts.length - 1;
      const c = a.crashes?.[i];
      if (c && u >= c.u) {
        // DE-RES: stopped dead where it hit; the draw shatters its wall and fades it
        return { ...p, d: c.d, from: 0, alpha: 0, trail: Infinity, derez: Math.min(1, ((u - c.u) * ms) / derezMs), crash: c };
      }
      const v = Math.max(0, (u - p.lag) / (1 - p.lag));
      const run = Math.min(1, v / 0.8), after = Math.max(0, (v - 0.8) / 0.2);
      // the whole wall, from the start of the route: it is what the cycle has drawn on the board,
      // and it stands until the effect is over (alpha fades it out at the very end)
      return { ...p, d: run * len, from: 0, alpha: 1 - 0.75 * after, trail: Infinity };
    });
    const heads = cycles
      .filter((c) => c.alpha > 0.05 && c.d > 0 && c.d < c.pts.length - 1)
      .map((c) => { const p = alongPath(c.pts, c.d); return { x: p.x, y: p.y, color: c.color, alpha: c.alpha }; });
    // the crash flashes white and lights the cubes round it
    for (const c of cycles) {
      if (c.derez != null && c.derez < 0.6) heads.push({ x: c.crash.at.x, y: c.crash.at.y, color: [255, 255, 255], alpha: 1 - c.derez / 0.6 });
    }
    return { cycles, heads };
  },
});

// ---------------------------------------------------------------- the lightning ball
//
// (operator, 2026-09-11, of the data packets that were here: "It comes off more as wandering
// lights. I was hoping for something that comes from off-screen along a grid line, and then starts
// tracing through the grid to the opposite side. Some high-effects version of a lightning ball
// moving along the grid, illuminating everything it comes near".)
defineAgent('ball', {
  draw(ctx, view, lw, api) { api.drawBall(ctx, view, lw); },
  build({ W, H, seed, tiles, rnd }) {
    const tops = cellTops(tiles, W, H);
    const side = ['left', 'right', 'bottom', 'top'][(rnd() * 4) | 0];
    const pts = ballPath(seed, W, H, side, Math.ceil(Math.max(W, H) * 0.35) + 8);
    return { paths: [{ pts, hs: pathHeights(pts, tops, W, H), color: [150, 215, 255] }] };
  },
  frame(a, u) {
    // the ball runs the whole route at one speed; it carries its own light, so no sweep envelope
    const p = a.paths[0], len = p.pts.length - 1;
    const d = Math.max(0, Math.min(1, (u - 0.02) / 0.96)) * len;
    const at = alongPath(p.pts, d);
    const ball = { x: at.x, y: at.y, z: (p.hs[at.k] ?? 0) + 0.9, d, pts: p.pts, hs: p.hs };
    return { ball, amp: 1, heads: [{ x: at.x, y: at.y, color: p.color, alpha: 1 }] };
  },
});

export { project, fxHash };

// ================================================================= BATCH ONE
//
// Six agents, chosen to cover five different motion vocabularies rather than six variations on
// one: a strider, a ricochet, a seeker, a hopper, a formation, and an explosion shaped by the
// board. Three of them READ THE DATA -- the board is transactions, and an effect that answers
// "which is biggest" or "how dense is this block" is worth more than one that ignores what it
// crosses (docs/EFFECTS-AGENTS.md).

// --- shared drawing -------------------------------------------------------
// Plain rgba fills and strokes, layered. No clip, no globalAlpha, no composite modes, no
// shadowBlur -- same rules as the renderer, and viewer-canvas-rules.test.js now scans this file.

/** A filled polygon in screen space. */
function poly(ctx, pts, fill) {
  if (pts.length < 3) return;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
}

/** A polyline in screen space. */
function line(ctx, pts, col, w) {
  if (pts.length < 2) return;
  ctx.strokeStyle = col; ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

/**
 * Nested discs: this renderer's only way to make something glow.
 *
 * `r` is in PIXELS -- callers size it from view.unit, never from lw. lw is about one device pixel,
 * so a sprite measured in line-widths comes out the same tiny size on every board; measured in
 * grid units it is the same size relative to the BOARD, which is what reads.
 */
function bloom(ctx, x, y, r, rgb, a = 1) {
  for (const [k, m] of [[1, 0.10], [0.62, 0.22], [0.34, 0.55], [0.16, 0.95]]) {
    ctx.fillStyle = `rgba(${rgb.join(',')},${(m * a).toFixed(3)})`;
    ctx.beginPath(); ctx.arc(x, y, r * k, 0, Math.PI * 2); ctx.fill();
  }
}

/** A square standing at grid (x, y) at height z, as screen points. */
const quad = (view, x, y, z, r) => [
  project(x - r, y - r, z, view), project(x + r, y - r, z, view),
  project(x + r, y + r, z, view), project(x - r, y + r, z, view),
];

// --- 1. RECOGNIZER --------------------------------------------------------
//
// Tron's marching gantry: two legs and a crossbar striding the board on a straight line, lighting
// a WIDE swath beneath it. Why this one first: the light cycles' real weakness on a dense board is
// that a one-unit wall is a scratch across thousands of slabs. A gantry is wide, slow and heavy,
// and it reads at any board size.
defineAgent('recognizer', {
  build({ W, H, rnd, tiles }) {
    const horiz = rnd() < 0.5;
    const lane = horiz ? 2 + rnd() * Math.max(1, H - 4) : 2 + rnd() * Math.max(1, W - 4);
    const span = Math.max(4, Math.min(horiz ? H : W, 3 + Math.round((horiz ? H : W) * 0.22)));
    const tops = cellTops(tiles, W, H);
    let peak = 0;
    for (const t of tiles ?? []) peak = Math.max(peak, (t.floor ?? 0) + cubeHeight(t));
    void tops;
    return { horiz, lane, span, W, H, deck: peak + 3.2, back: rnd() < 0.5 ? -1 : 1 };
  },
  frame(a, u) {
    // in from off-board and out the far side, at a constant march
    const along = -6 + u * ((a.horiz ? a.W : a.H) + 12);
    const at = a.back < 0 ? (a.horiz ? a.W : a.H) - along : along;
    const half = a.span / 2;
    const foot = (o) => (a.horiz ? { x: at, y: a.lane + o } : { x: a.lane + o, y: at });
    const legs = [foot(-half), foot(half)];
    // the legs light what they stride over, and the span between them gets a softer wash
    const heads = legs.map((p) => ({ x: p.x, y: p.y, color: [150, 215, 255], alpha: 1, r: 2.2 }));
    heads.push({ x: (legs[0].x + legs[1].x) / 2, y: (legs[0].y + legs[1].y) / 2, color: [90, 170, 255], alpha: 0.55, r: half });
    return { recognizer: { at, legs, half, deck: a.deck, horiz: a.horiz }, heads };
  },
  draw(ctx, view, lw) {
    const r = view.fx?.recognizer;
    if (!r) return;
    const P = (x, y, z) => project(x, y, z, view);
    const U = view.unit ?? 8;           // pixels per grid unit: the only honest scale on this board
    const [l0, l1] = r.legs;
    const COL = [120, 200, 255];
    // two legs: tapered columns from the deck to the board, a grid unit and a half wide at the top
    for (const f of r.legs) {
      const top = P(f.x, f.y, r.deck), bot = P(f.x, f.y, 0);
      poly(ctx, [
        { x: top.x - U * 0.75, y: top.y }, { x: top.x + U * 0.75, y: top.y },
        { x: bot.x + U * 0.42, y: bot.y }, { x: bot.x - U * 0.42, y: bot.y },
      ], `rgba(${COL.join(',')},0.5)`);
      line(ctx, [top, bot], 'rgba(210,240,255,0.9)', lw * 2);
      bloom(ctx, bot.x, bot.y, U * 1.4, COL, 0.5);
    }
    // the crossbar: the body of the thing, a slab spanning the legs
    const a0 = P(l0.x, l0.y, r.deck), a1 = P(l1.x, l1.y, r.deck);
    const h = U * 1.9;
    poly(ctx, [
      { x: a0.x, y: a0.y - h }, { x: a1.x, y: a1.y - h },
      { x: a1.x, y: a1.y }, { x: a0.x, y: a0.y },
    ], `rgba(${COL.join(',')},0.62)`);
    line(ctx, [{ x: a0.x, y: a0.y - h }, { x: a1.x, y: a1.y - h }], 'rgba(235,250,255,0.95)', lw * 2.4);
    // the eye: a bright bar under the crossbar's middle
    const mid = { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 };
    bloom(ctx, mid.x, mid.y - h * 0.45, U * 1.7, [255, 240, 200], 0.85);
  },
});

// --- 2. IDENTITY DISC -----------------------------------------------------
//
// Thrown from one edge, ricocheting off the board's walls, each bounce flashing the cubes where it
// lands. Why: ricochet geometry gives ANTICIPATION -- you can see where it will hit before it
// does, which no field effect can offer.
defineAgent('disc', {
  build({ W, H, rnd }) {
    let x = rnd() * W, y = 0.001;
    let vx = (rnd() - 0.5) * 2.2, vy = 0.9 + rnd() * 0.5;
    if (Math.abs(vx) < 0.25) vx = vx < 0 ? -0.25 : 0.25;
    const pts = [{ x, y }];
    const hits = [];
    // trace the whole ricochet up front: the board is still, so the route is knowable
    for (let step = 0; step < 900 && pts.length < 240; step++) {
      x += vx * 0.35; y += vy * 0.35;
      if (x < 0) { x = -x; vx = -vx; hits.push({ x: 0, y, i: pts.length }); }
      if (x > W) { x = 2 * W - x; vx = -vx; hits.push({ x: W, y, i: pts.length }); }
      if (y < 0) { y = -y; vy = -vy; hits.push({ x, y: 0, i: pts.length }); }
      if (y > H) { y = 2 * H - y; vy = -vy; hits.push({ x, y: H, i: pts.length }); }
      pts.push({ x, y });
      if (hits.length >= 5) break;
    }
    return { pts, hits };
  },
  frame(a, u) {
    const d = Math.max(0, Math.min(1, u)) * (a.pts.length - 1);
    const at = alongPath(a.pts, d);
    const heads = [{ x: at.x, y: at.y, color: [255, 245, 210], alpha: 1, r: 1.4 }];
    // a bounce flashes hard, briefly, where it struck
    for (const hit of a.hits) {
      const age = (d - hit.i) / 12;
      if (age > 0 && age < 1) heads.push({ x: hit.x, y: hit.y, color: [255, 255, 255], alpha: 1 - age, r: 3.5 * age + 1 });
    }
    return { disc: { at, d, pts: a.pts, spin: u * 40 }, heads };
  },
  draw(ctx, view, lw) {
    const d = view.fx?.disc;
    if (!d) return;
    const P = (x, y, z) => project(x, y, z, view);
    // the trail it has already flown, cooling behind it
    const TR = 26, from = Math.max(0, d.d - TR);
    for (let k = Math.floor(from); k < d.d && k < d.pts.length - 1; k++) {
      const heat = Math.pow(Math.max(0, 1 - (d.d - k) / TR), 1.7);
      const a = P(d.pts[k].x, d.pts[k].y, 0.7), b = P(d.pts[k + 1].x, d.pts[k + 1].y, 0.7);
      line(ctx, [a, b], `rgba(120,200,255,${(0.35 * heat).toFixed(3)})`, lw * 7 * heat);
      line(ctx, [a, b], `rgba(240,252,255,${(0.85 * heat).toFixed(3)})`, lw * 2 * heat);
    }
    // the disc itself: a ring seen edge-on, turning as it flies
    const c = P(d.at.x, d.at.y, 0.9);
    const R = (view.unit ?? 8) * 1.1;   // a disc about a cube wide, not thirteen pixels
    const squash = Math.abs(Math.cos(d.spin)) * 0.75 + 0.25;
    const ring = [];
    for (let i = 0; i <= 20; i++) {
      const ang = (i / 20) * Math.PI * 2;
      ring.push({ x: c.x + Math.cos(ang) * R, y: c.y + Math.sin(ang) * R * squash });
    }
    poly(ctx, ring, 'rgba(90,180,255,0.30)');
    line(ctx, ring, 'rgba(245,252,255,0.95)', lw * 2.2);
    bloom(ctx, c.x, c.y, R * 1.8, [160, 220, 255], 0.5);
  },
});

// --- 3. SNAKE -------------------------------------------------------------
//
// DATA-AWARE. It heads for the TALLEST cube on the board, eats it, grows, and picks the next --
// so it is working down the block's biggest transactions in order, and the length of its own body
// is the readout. The cube it eats is hidden for the duration and comes back when the effect ends
// (operator: "Allow it, it snaps back"); nothing mutates the board's tiles.
defineAgent('snake', {
  build({ tiles, W, H, rnd }) {
    const byHeight = [...(tiles ?? [])]
      .map((t) => ({ t, h: (t.floor ?? 0) + cubeHeight(t), x: t.x + t.s / 2, y: t.y + t.s / 2 }))
      .sort((a, b) => b.h - a.h)
      .slice(0, 7);
    const start = { x: rnd() * W, y: rnd() * H };
    const route = [start, ...byHeight.map((m) => ({ x: m.x, y: m.y }))];
    return { route, meals: byHeight.map((m) => String(m.t.txid)), W, H };
  },
  frame(a, u) {
    const legs = a.route.length - 1;
    if (legs < 1) return { heads: [] };
    const d = Math.max(0, Math.min(1, u)) * legs;
    const at = alongPath(a.route, d);
    // the body: segments trailing the head down the route it has already run
    const body = [];
    for (let k = 1; k <= 9; k++) {
      const bd = d - k * 0.13;
      if (bd < 0) break;
      const p = alongPath(a.route, bd);
      body.push({ x: p.x, y: p.y, k });
    }
    const eaten = new Set(a.meals.slice(0, Math.floor(d)));
    const heads = [{ x: at.x, y: at.y, color: [120, 255, 170], alpha: 1, r: 1.6 }];
    for (const b of body) heads.push({ x: b.x, y: b.y, color: [70, 210, 130], alpha: 0.8 - b.k * 0.06, r: 1.1 });
    return { snake: { at, body, d }, eaten, heads };
  },
  draw(ctx, view, lw) {
    const s = view.fx?.snake;
    if (!s) return;
    const P = (x, y, z) => project(x, y, z, view);
    const U = view.unit ?? 8;
    for (let i = s.body.length - 1; i >= 0; i--) {
      const b = s.body[i];
      const c = P(b.x, b.y, 0.9);
      const r = U * (0.95 - b.k * 0.05);
      bloom(ctx, c.x, c.y, r, [60, 210, 130], 0.55);
    }
    const h = P(s.at.x, s.at.y, 1.1);
    bloom(ctx, h.x, h.y, U * 1.3, [150, 255, 190], 0.95);
    // two eyes, so it reads as alive
    for (const o of [-0.35, 0.35]) {
      ctx.fillStyle = 'rgba(10,30,20,0.95)';
      ctx.beginPath(); ctx.arc(h.x + o * U * 0.5, h.y - U * 0.2, U * 0.2, 0, Math.PI * 2); ctx.fill();
    }
  },
});

// --- 4. Q*BERT ------------------------------------------------------------
//
// The closest match in the whole catalogue between a real arcade board and ours: Q*bert's board IS
// an isometric stack of cubes. A small agent hops cube to cube on the diagonal, each landing
// recolouring what it lands on for a moment.
defineAgent('qbert', {
  build({ W, H, rnd }) {
    const hops = [];
    let x = 1 + rnd() * (W - 2), y = 1 + rnd() * (H - 2);
    hops.push({ x, y });
    for (let i = 0; i < 13; i++) {
      const dx = rnd() < 0.5 ? -1.6 : 1.6, dy = rnd() < 0.5 ? -1.6 : 1.6;
      x = Math.max(0.5, Math.min(W - 0.5, x + dx));
      y = Math.max(0.5, Math.min(H - 0.5, y + dy));
      hops.push({ x, y });
    }
    return { hops };
  },
  frame(a, u) {
    const n = a.hops.length - 1;
    const d = Math.max(0, Math.min(1, u)) * n;
    const i = Math.min(n - 1, Math.floor(d));
    const f = d - i;
    const p0 = a.hops[i], p1 = a.hops[i + 1] ?? p0;
    const x = p0.x + (p1.x - p0.x) * f, y = p0.y + (p1.y - p0.y) * f;
    const z = Math.sin(Math.PI * f) * 2.6;           // the hop: a clean arc, every time
    const landed = f > 0.92 || f < 0.08;
    const heads = [{ x, y, color: landed ? [255, 240, 180] : [255, 150, 90], alpha: 1, r: landed ? 2.4 : 1.3 }];
    return { qbert: { x, y, z, f }, heads };
  },
  draw(ctx, view, lw) {
    const q = view.fx?.qbert;
    if (!q) return;
    const c = project(q.x, q.y, q.z + 0.8, view);
    const sh = project(q.x, q.y, 0.05, view);
    // its shadow tightens as it falls, which is what sells the hop
    const near = 1 - Math.min(1, q.z / 2.6);
    ctx.fillStyle = `rgba(0,0,0,${(0.30 * near).toFixed(3)})`;
    const U = view.unit ?? 8;
    ctx.beginPath(); ctx.ellipse(sh.x, sh.y, U * 0.9 * (1.4 - 0.5 * near), U * 0.36 * (1.4 - 0.5 * near), 0, 0, Math.PI * 2); ctx.fill();
    bloom(ctx, c.x, c.y, U * 1.15, [255, 150, 80], 0.9);
    // a snout, so it has a facing
    ctx.fillStyle = 'rgba(255,235,200,0.95)';
    ctx.beginPath(); ctx.arc(c.x + U * 0.45, c.y + U * 0.18, U * 0.3, 0, Math.PI * 2); ctx.fill();
    for (const o of [-0.4, 0.4]) {
      ctx.fillStyle = 'rgba(20,12,10,0.95)';
      ctx.beginPath(); ctx.arc(c.x + o * U * 0.5, c.y - U * 0.28, U * 0.18, 0, Math.PI * 2); ctx.fill();
    }
  },
});

// --- 5. SPACE INVADERS ----------------------------------------------------
//
// The formation is the thing this board has never done: many agents moving as ONE. A rank and file
// stepping sideways, dropping a row at the edge, and accelerating as their numbers fall. Drawn as
// pixel-art silhouettes (operator: "flying ships or other pixel-graphic inspired art").
const INVADER = Object.freeze([
  // a classic 11x8 crab, as unit-space cells
  '..X.....X..', '...X...X...', '..XXXXXXX..', '.XX.XXX.XX.',
  'XXXXXXXXXXX', 'X.XXXXXXX.X', 'X.X.....X.X', '...XX.XX...',
]);
defineAgent('invaders', {
  build({ W, H, rnd }) {
    // SIZED AND PLACED IN GRID UNITS. The first cut hung the rank at `H - 2` and stepped it DOWN,
    // which on the 96-unit dense board started it off the top edge and marched it further off;
    // and its sprite cell was a fraction of a line-width, so what did survive was sub-pixel.
    // The rank now occupies the middle half of the board and descends through it.
    const cols = Math.max(3, Math.min(7, Math.round(W / 14)));
    const rows = 3;
    const gapX = (W * 0.72) / cols;
    const gapY = Math.max(2.5, H * 0.075);
    const ships = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ships.push({ c, r, x0: W * 0.14 + gapX * (c + 0.5), y0: H * 0.80 - r * gapY });
      }
    }
    return { ships, cols, rows, W, H, dir: rnd() < 0.5 ? 1 : -1, amp: gapX * 0.45, drop: H * 0.55 };
  },
  frame(a, u) {
    // six steps sideways, dropping each time the rank reverses -- and faster as it goes
    const steps = 7;
    const k = Math.floor(u * steps);
    const swing = ((k % 2) ? -1 : 1) * a.dir;
    const within = (u * steps) - k;
    const dx = swing * a.amp * (0.35 + 0.65 * within);
    const dy = -(a.drop / steps) * (k + within);      // descends through the board, not off it
    const alive = Math.max(1, a.ships.length - Math.floor(u * a.ships.length * 0.35));
    const heads = [];
    const ships = [];
    a.ships.slice(0, alive).forEach((s, i) => {
      const x = s.x0 + dx, y = s.y0 + dy;
      ships.push({ x, y, r: s.r, i });
      // not every ship needs its own head: the board only has so many cubes under them
      if (i % 2 === 0) heads.push({ x, y, color: [130, 255, 160], alpha: 0.9, r: 1.5 });
    });
    // the shot: one descending bolt, re-aimed each step
    const shooter = ships[(k * 3) % Math.max(1, ships.length)];
    const shot = shooter ? { x: shooter.x, y: shooter.y - within * 6 } : null;
    if (shot) heads.push({ x: shot.x, y: shot.y, color: [255, 240, 160], alpha: 1, r: 1 });
    return { invaders: { ships, shot, phase: k }, heads };
  },
  draw(ctx, view, lw) {
    const inv = view.fx?.invaders;
    if (!inv) return;
    // each ship about three grid units across: the sprite is eleven cells wide, so one cell is
    // 3/11 of a grid unit -- 2px on the dense board, 4.4px on the simple one, and it scales with
    // the board rather than with the line width (which is one device pixel, always)
    const cell = (view.unit ?? 8) * (3 / 11);
    const W = INVADER[0].length, H2 = INVADER.length;
    for (const s of inv.ships) {
      const c = project(s.x, s.y, 2.2, view);
      const col = s.r === 0 ? [150, 255, 170] : s.r === 1 ? [120, 220, 255] : [255, 180, 120];
      // the sprite, cell by cell -- pixel art drawn as pixels
      for (let ry = 0; ry < H2; ry++) {
        for (let rx = 0; rx < W; rx++) {
          if (INVADER[ry][rx] !== 'X') continue;
          ctx.fillStyle = `rgba(${col.join(',')},0.92)`;
          ctx.fillRect(c.x + (rx - W / 2) * cell, c.y + (ry - H2 / 2) * cell, cell * 0.92, cell * 0.92);
        }
      }
      bloom(ctx, c.x, c.y, cell * 8, col, 0.28);
    }
    if (inv.shot) {
      const p = project(inv.shot.x, inv.shot.y, 1.6, view);
      const U = view.unit ?? 8;
      line(ctx, [{ x: p.x, y: p.y - U * 0.6 }, { x: p.x, y: p.y + U * 0.6 }], 'rgba(255,245,170,0.95)', lw * 2.6);
      bloom(ctx, p.x, p.y, U * 0.6, [255, 240, 150], 0.6);
    }
  },
});

// --- 6. BOMBERMAN ---------------------------------------------------------
//
// DATA-AWARE, and the most honest of the six: the walker drops a bomb and the blast runs in four
// straight lines until a TALL CUBE stops it. The cross it draws is therefore a picture of the
// block's density -- a sparse block gives long arms, a full one gives a stub.
defineAgent('bomberman', {
  build({ W, H, tiles, rnd }) {
    const tops = cellTops(tiles, W, H);
    const at = { x: Math.floor(2 + rnd() * Math.max(1, W - 4)), y: Math.floor(2 + rnd() * Math.max(1, H - 4)) };
    const walk = [{ x: at.x - 3, y: at.y }, { x: at.x, y: at.y }];
    const top = (x, y) => (x >= 0 && x < W && y >= 0 && y < H ? tops[(y | 0) * W + (x | 0)] : 99);
    // A WALL IS A SPIKE, NOT A HEIGHT. Two wrong rules preceded this one, and both were measured:
    //
    //   a flat 1.2       the dense block-space board packs ~3,700 slabs that are ALL exactly 1.2
    //                    tall, so every neighbour was a wall, every arm was length zero, and the
    //                    blast drew a dot on the board the operator was looking at.
    //   the 70th pct     fixed that, and broke the meaning: on a uniform board the 70th percentile
    //                    sits just above every cube whatever its absolute height, so a field of
    //                    0.2s and a field of 6s gave identical arms (26 vs 26, caught by the test
    //                    below). Density became unreadable, which is the whole point of the effect.
    //
    // What should stop a blast is a cube that stands out from ITS NEIGHBOURS. So: the median of the
    // skyline plus a real margin. A uniformly flat board -- at any height -- has no outliers and
    // lets the blast run the whole way; a board with scattered towers stops it at the first one.
    // The cross is then a picture of how SPIKY the block is, which is what a mempool actually
    // varies in: a block of even little transactions against one carrying a few giants.
    const heights = [];
    for (let i = 0; i < tops.length; i++) if (tops[i] > 0) heights.push(tops[i]);
    heights.sort((a, b) => a - b);
    const median = heights.length ? heights[Math.floor(0.5 * (heights.length - 1))] : 1;
    const WALL = Math.max(0.35, median * 1.6 + 0.25);
    const arms = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => {
      let n = 0;
      while (n < 9) {
        const nx = at.x + dx * (n + 1), ny = at.y + dy * (n + 1);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
        if (top(nx, ny) > WALL) break;      // a tall transaction is a wall
        n++;
      }
      return { dx, dy, n };
    });
    return { at, walk, arms };
  },
  frame(a, u) {
    // three acts: walk in, the fuse, the blast
    const WALK = 0.35, FUSE = 0.62;
    if (u < WALK) {
      const p = alongPath(a.walk, (u / WALK) * (a.walk.length - 1));
      return { bomberman: { phase: 'walk', at: p }, heads: [{ x: p.x, y: p.y, color: [255, 220, 140], alpha: 1, r: 1.4 }] };
    }
    if (u < FUSE) {
      const f = (u - WALK) / (FUSE - WALK);
      return { bomberman: { phase: 'fuse', at: a.at, f },
        heads: [{ x: a.at.x, y: a.at.y, color: [255, 160, 90], alpha: 0.6 + 0.4 * Math.sin(f * 30), r: 1.6 }] };
    }
    const b = (u - FUSE) / (1 - FUSE);
    const reach = Math.min(1, b * 2.2);
    const fade = Math.max(0, 1 - Math.max(0, (b - 0.45) / 0.55));
    const heads = [{ x: a.at.x, y: a.at.y, color: [255, 255, 230], alpha: fade, r: 2 }];
    for (const arm of a.arms) {
      for (let k = 1; k <= Math.round(arm.n * reach); k++) {
        heads.push({ x: a.at.x + arm.dx * k, y: a.at.y + arm.dy * k,
          color: [255, 190 - k * 8, 90], alpha: fade, r: 1.5 });
      }
    }
    return { bomberman: { phase: 'blast', at: a.at, arms: a.arms, reach, fade }, heads };
  },
  draw(ctx, view, lw) {
    const b = view.fx?.bomberman;
    if (!b) return;
    const P = (x, y, z) => project(x, y, z, view);
    const U = view.unit ?? 8;
    if (b.phase === 'walk') {
      const c = P(b.at.x, b.at.y, 1);
      bloom(ctx, c.x, c.y, U * 1.1, [255, 225, 150], 0.85);
      return;
    }
    if (b.phase === 'fuse') {
      const c = P(b.at.x, b.at.y, 0.8);
      const sw = 1 + 0.25 * Math.sin(b.f * 30);
      bloom(ctx, c.x, c.y, U * 1.15 * sw, [40, 40, 50], 0.9);
      bloom(ctx, c.x, c.y - U * 0.9, U * 0.32 * sw, [255, 200, 80], 1);
      return;
    }
    // the blast: four arms of fire, each stopped where the skyline stopped it
    for (const arm of b.arms) {
      const n = arm.n * b.reach;
      if (n < 0.2) continue;
      const a0 = P(b.at.x, b.at.y, 0.6);
      const a1 = P(b.at.x + arm.dx * n, b.at.y + arm.dy * n, 0.6);
      // the arms are a grid unit thick, so the cross reads at any board size
      line(ctx, [a0, a1], `rgba(255,140,50,${(0.45 * b.fade).toFixed(3)})`, U * 1.5);
      line(ctx, [a0, a1], `rgba(255,220,120,${(0.8 * b.fade).toFixed(3)})`, U * 0.7);
      line(ctx, [a0, a1], `rgba(255,255,235,${(0.95 * b.fade).toFixed(3)})`, U * 0.22);
      bloom(ctx, a1.x, a1.y, U * 0.9, [255, 190, 110], b.fade * 0.8);
    }
    const c = P(b.at.x, b.at.y, 0.8);
    bloom(ctx, c.x, c.y, U * 2.4, [255, 240, 200], b.fade);
  },
});

// ================================================================= BATCH TWO
//
// Six more, from the same catalogue: a splitter, four personalities, a formation that breaks up,
// a thief, two populations that fight, and drifting debris. Between them they add the three things
// batch one had no example of -- an agent that DIVIDES, agents with different rules from each
// other, and two populations that interact.

/** A closed wireframe outline in screen space -- Asteroids' whole visual language. */
function wire(ctx, pts, col, w) {
  if (pts.length < 3) return;
  ctx.strokeStyle = col; ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
}

/** An expanding ring, for a detonation. Cheap: one stroke, no fill. */
function ring(ctx, x, y, r, col, w) {
  ctx.strokeStyle = col; ctx.lineWidth = w;
  ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); ctx.stroke();
}

// --- 7. CENTIPEDE ---------------------------------------------------------
//
// A column of segments weaving down the board, dropping a row each time it reaches an edge, and
// SPLITTING in two partway through -- the split is the thing everyone remembers about Centipede,
// and no other agent here divides. Our board is a grid of obstacles, which is the mushroom field
// the original needs.
defineAgent('centipede', {
  build({ W, H, rnd }) {
    // a boustrophedon: across, drop, back across -- the route the whole body follows in file
    const pts = [];
    const rows = 6;
    const dropEvery = Math.max(2, Math.floor(H / (rows + 1)));
    let dir = rnd() < 0.5 ? 1 : -1;
    let x = dir > 0 ? 1 : W - 1;
    let y = H - 2;
    pts.push({ x, y });
    for (let r = 0; r < rows; r++) {
      const end = dir > 0 ? W - 1 : 1;
      const steps = Math.max(1, Math.abs(end - x));
      for (let i = 0; i < steps; i++) { x += dir; pts.push({ x, y }); }
      for (let d = 0; d < dropEvery && y > 1; d++) { y -= 1; pts.push({ x, y }); }
      dir = -dir;
    }
    return { pts, len: 11, splitAt: 0.45 + rnd() * 0.2, splitSeg: 4 + Math.floor(rnd() * 3) };
  },
  frame(a, u) {
    const total = a.pts.length - 1;
    const lead = Math.max(0, Math.min(1, u)) * total;
    const split = u >= a.splitAt;
    const heads = [];
    const body = [];
    for (let i = 0; i < a.len; i++) {
      // after the split the tail half drops back and travels on its own, a little behind
      const lag = i * 1.6 + (split && i >= a.splitSeg ? 6 + (u - a.splitAt) * 26 : 0);
      const d = lead - lag;
      if (d < 0) continue;
      const p = alongPath(a.pts, d);
      const isHead = i === 0 || (split && i === a.splitSeg);
      body.push({ x: p.x, y: p.y, i, head: isHead });
      heads.push({
        x: p.x, y: p.y, r: isHead ? 1.9 : 1.4,
        color: isHead ? [255, 230, 120] : [120, 235, 140],
        alpha: isHead ? 1 : 0.85,
      });
    }
    return { centipede: { body, split }, heads };
  },
  draw(ctx, view, lw) {
    const c = view.fx?.centipede;
    if (!c) return;
    const U = view.unit ?? 8;
    // BIG ENOUGH TO BE A BODY, not a row of lit cubes. The first cut drew each segment at about
    // one cube wide in the board's own green, so on a field of 3,700 green cubes it read as
    // highlighting rather than as a creature crawling over them -- verified on the live board.
    // Now: segments half again as large, a SPINE joining them so the body is one thing, and a
    // magenta-red that nothing else on this board wears.
    const pts = c.body.map((b) => project(b.x, b.y, 1.2, view));
    for (let i = 1; i < pts.length; i++) {
      // the spine only joins segments that are actually adjacent -- after the split the two halves
      // are far apart, and a line between them would draw the creature back together
      const gap = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (gap > U * 3.5) continue;
      line(ctx, [pts[i - 1], pts[i]], 'rgba(180,60,120,0.55)', U * 1.15);
    }
    for (let i = c.body.length - 1; i >= 0; i--) {
      const b = c.body[i];
      const p = pts[i];
      const r = U * (b.head ? 1.75 : 1.25);
      bloom(ctx, p.x, p.y, r, b.head ? [255, 210, 90] : [235, 90, 150], b.head ? 1 : 0.9);
      // a hard rim, so a segment has an edge against a bright cube instead of dissolving into it
      ring(ctx, p.x, p.y, r * 0.55, b.head ? 'rgba(255,245,210,0.9)' : 'rgba(255,190,225,0.75)', lw * 2);
      if (b.head) {
        for (const o of [-0.34, 0.34]) {
          ctx.fillStyle = 'rgba(25,10,20,0.95)';
          ctx.beginPath(); ctx.arc(p.x + o * U * 0.62, p.y - U * 0.26, U * 0.22, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  },
});

// --- 8. PAC-MAN -----------------------------------------------------------
//
// Four agents with DIFFERENT RULES on one board -- chase, ambush, scatter and random -- which is
// the most legible "something is happening" this engine can show, and the thing no single-agent
// effect can do. The routes are right angles, which is what our grid already is.
const GHOSTS = Object.freeze([
  { name: 'chase', color: [255, 90, 80] },     // straight at him
  { name: 'ambush', color: [255, 180, 220] },  // aims where he WILL be
  { name: 'scatter', color: [110, 230, 255] }, // holds a corner, drifts in
  { name: 'random', color: [255, 175, 90] },   // wanders
]);
defineAgent('pacman', {
  build({ W, H, seed, rnd }) {
    const route = cyclePath(seed, W, H, rnd() < 0.5 ? 'left' : 'bottom');
    const corners = [{ x: 1, y: 1 }, { x: W - 1, y: 1 }, { x: 1, y: H - 1 }, { x: W - 1, y: H - 1 }];
    const ghosts = GHOSTS.map((g, i) => ({ ...g, home: corners[i], lag: 0.06 + i * 0.05, wob: rnd() * 6.28 }));
    return { route, ghosts, W, H };
  },
  frame(a, u) {
    const total = a.route.length - 1;
    const d = Math.max(0, Math.min(1, u)) * total;
    const me = alongPath(a.route, d);
    // where he will be in a moment: the ambusher aims there instead of at him
    const ahead = alongPath(a.route, Math.min(total, d + 6));
    const heads = [{ x: me.x, y: me.y, color: [255, 240, 90], alpha: 1, r: 1.8 }];
    const ghosts = a.ghosts.map((g) => {
      const v = Math.max(0, (u - g.lag) / Math.max(0.05, 1 - g.lag));
      let tx = me.x, ty = me.y;
      if (g.name === 'ambush') { tx = ahead.x; ty = ahead.y; }
      else if (g.name === 'scatter') { tx = g.home.x; ty = g.home.y; }
      else if (g.name === 'random') { tx = me.x + Math.sin(g.wob + u * 7) * 9; ty = me.y + Math.cos(g.wob + u * 5) * 9; }
      // each starts at its corner and eases toward its own target: four rules, four paths
      const x = g.home.x + (tx - g.home.x) * v;
      const y = g.home.y + (ty - g.home.y) * v;
      heads.push({ x, y, color: g.color, alpha: 0.95, r: 1.5 });
      return { x, y, color: g.color, name: g.name };
    });
    // the mouth opens and shuts on its own clock, not the effect's
    return { pacman: { me, ghosts, chomp: Math.abs(Math.sin(u * 26)) }, heads };
  },
  draw(ctx, view, lw) {
    const p = view.fx?.pacman;
    if (!p) return;
    const U = view.unit ?? 8;
    // him: a disc with a wedge taken out, facing along his route
    const c = project(p.me.x, p.me.y, 1.1, view);
    const R = U * 1.25;
    const gap = 0.12 + 0.5 * p.chomp;
    const pts = [{ x: c.x, y: c.y }];
    for (let i = 0; i <= 22; i++) {
      const ang = gap + (i / 22) * (Math.PI * 2 - gap * 2);
      pts.push({ x: c.x + Math.cos(ang) * R, y: c.y + Math.sin(ang) * R });
    }
    poly(ctx, pts, 'rgba(255,240,90,0.95)');
    bloom(ctx, c.x, c.y, R * 1.5, [255, 230, 80], 0.35);
    // the four: a dome and a ragged skirt, each in its own colour, with eyes that look at him
    for (const g of p.ghosts) {
      const q = project(g.x, g.y, 1.1, view);
      const r = U * 1.05;
      const body = [];
      for (let i = 0; i <= 14; i++) { const ang = Math.PI + (i / 14) * Math.PI; body.push({ x: q.x + Math.cos(ang) * r, y: q.y + Math.sin(ang) * r * 0.95 }); }
      for (let i = 0; i <= 4; i++) { const fx2 = q.x + r - (i / 4) * 2 * r; body.push({ x: fx2, y: q.y + r * 0.75 + (i % 2 ? 0 : r * 0.3) }); }
      poly(ctx, body, `rgba(${g.color.join(',')},0.92)`);
      bloom(ctx, q.x, q.y, r * 1.6, g.color, 0.25);
      const look = Math.atan2(c.y - q.y, c.x - q.x);
      for (const o of [-0.36, 0.36]) {
        const ex = q.x + o * r, ey = q.y - r * 0.22;
        ctx.fillStyle = 'rgba(250,252,255,0.98)';
        ctx.beginPath(); ctx.arc(ex, ey, r * 0.28, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(20,30,80,0.98)';
        ctx.beginPath(); ctx.arc(ex + Math.cos(look) * r * 0.12, ey + Math.sin(look) * r * 0.12, r * 0.14, 0, Math.PI * 2); ctx.fill();
      }
    }
    void lw;
  },
});

// --- 9. GALAGA ------------------------------------------------------------
//
// A formation that BREAKS UP: two ships peel off in Lissajous dives and rejoin. The dive curve is
// two sines, so it costs nothing and looks far more expensive than it is.
defineAgent('galaga', {
  build({ W, H, rnd }) {
    const cols = Math.max(4, Math.min(8, Math.round(W / 12)));
    const ships = [];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < cols; c++) {
        ships.push({ c, r, x0: W * 0.18 + ((W * 0.64) / cols) * (c + 0.5), y0: H * 0.78 - r * Math.max(2.2, H * 0.06) });
      }
    }
    const divers = [ships[(rnd() * ships.length) | 0], ships[(rnd() * ships.length) | 0]]
      .map((sh, i) => ({ sh, t0: 0.18 + i * 0.28, ax: 2 + i, ay: 3 - i, amp: W * 0.3 }));
    return { ships, divers, W, H };
  },
  frame(a, u) {
    const sway = Math.sin(u * Math.PI * 2) * (a.W * 0.03);
    const heads = [];
    const drawn = [];
    for (const sh of a.ships) {
      const dive = a.divers.find((d) => d.sh === sh);
      let x = sh.x0 + sway, y = sh.y0, diving = false;
      if (dive) {
        const v = (u - dive.t0) / 0.42;
        if (v > 0 && v < 1) {
          diving = true;
          // a Lissajous loop away from the rank and back into it
          const s = Math.sin(Math.PI * v);
          x = sh.x0 + sway + Math.sin(v * Math.PI * dive.ax) * dive.amp * s;
          y = sh.y0 - Math.abs(Math.sin(v * Math.PI * dive.ay)) * (a.H * 0.5) * s;
        }
      }
      drawn.push({ x, y, r: sh.r, diving });
      heads.push({ x, y, color: diving ? [255, 200, 90] : [150, 210, 255], alpha: diving ? 1 : 0.8, r: diving ? 2.2 : 1.6 });
    }
    return { galaga: { ships: drawn }, heads };
  },
  draw(ctx, view, lw) {
    const g = view.fx?.galaga;
    if (!g) return;
    const U = view.unit ?? 8;
    for (const sh of g.ships) {
      const c = project(sh.x, sh.y, 2, view);
      const col = sh.diving ? [255, 200, 90] : [150, 210, 255];
      const r = U * (sh.diving ? 1.25 : 1);
      // a blunt arrowhead: a hull, two wings and a canopy
      poly(ctx, [
        { x: c.x, y: c.y - r }, { x: c.x + r * 0.8, y: c.y + r * 0.7 },
        { x: c.x, y: c.y + r * 0.3 }, { x: c.x - r * 0.8, y: c.y + r * 0.7 },
      ], `rgba(${col.join(',')},0.95)`);
      ctx.fillStyle = 'rgba(250,252,255,0.9)';
      ctx.beginPath(); ctx.arc(c.x, c.y - r * 0.1, r * 0.24, 0, Math.PI * 2); ctx.fill();
      if (sh.diving) bloom(ctx, c.x, c.y + r, r * 1.4, [255, 160, 70], 0.6);
    }
    void lw;
  },
});

// --- 10. TRACTOR BEAM -----------------------------------------------------
//
// DATA-AWARE, and the only agent that uses `lift`: a ship stops over the TALLEST cube on the
// board, opens a beam, and draws it up. The cube rises, thins and vanishes -- then comes back when
// the effect ends, because nothing here mutates the board (see the hide/scale note in
// blockscene3d.js).
defineAgent('tractor', {
  build({ tiles, W, H, rnd }) {
    const target = tallestTile(tiles) ?? { x: W / 2, y: H / 2, h: 1, tile: null };
    return { target, from: { x: rnd() < 0.5 ? -4 : W + 4, y: target.y }, W, H };
  },
  frame(a, u) {
    const IN = 0.3, HOLD = 0.78;
    const alt = a.target.h + 5;
    if (u < IN) {
      const v = u / IN;
      const x = a.from.x + (a.target.x - a.from.x) * v;
      return { tractor: { ship: { x, y: a.target.y, z: alt }, beam: 0, lift: 0 },
        heads: [{ x, y: a.target.y, color: [180, 220, 255], alpha: 0.9, r: 1.6 }] };
    }
    const v = Math.min(1, (u - IN) / (HOLD - IN));
    const beam = Math.sin(Math.min(1, v * 1.2) * Math.PI);
    const lift = v * 4.5;
    return {
      tractor: { ship: { x: a.target.x, y: a.target.y, z: alt }, beam, lift, target: a.target },
      // the beam lights the cube it is pulling, and lifts it
      heads: [
        { x: a.target.x, y: a.target.y, color: [190, 235, 255], alpha: 1, r: 2.4, lift },
        { x: a.target.x, y: a.target.y, color: [140, 200, 255], alpha: 0.5 * beam, r: 4 },
      ],
    };
  },
  draw(ctx, view, lw) {
    const t = view.fx?.tractor;
    if (!t) return;
    const U = view.unit ?? 8;
    const c = project(t.ship.x, t.ship.y, t.ship.z, view);
    if (t.beam > 0.02) {
      // the cone, as stacked translucent quads: no gradients needed, and none allowed on a fill
      const base = project(t.ship.x, t.ship.y, 0, view);
      const w0 = U * 0.5, w1 = U * 2.2 * t.beam;
      poly(ctx, [
        { x: c.x - w0, y: c.y }, { x: c.x + w0, y: c.y },
        { x: base.x + w1, y: base.y }, { x: base.x - w1, y: base.y },
      ], `rgba(150,210,255,${(0.18 * t.beam).toFixed(3)})`);
      poly(ctx, [
        { x: c.x - w0 * 0.4, y: c.y }, { x: c.x + w0 * 0.4, y: c.y },
        { x: base.x + w1 * 0.45, y: base.y }, { x: base.x - w1 * 0.45, y: base.y },
      ], `rgba(220,245,255,${(0.3 * t.beam).toFixed(3)})`);
    }
    // the saucer: a flattened dome with a lit rim
    const r = U * 1.6;
    const dome = [];
    for (let i = 0; i <= 20; i++) { const ang = Math.PI + (i / 20) * Math.PI; dome.push({ x: c.x + Math.cos(ang) * r, y: c.y + Math.sin(ang) * r * 0.42 }); }
    poly(ctx, dome, 'rgba(120,180,255,0.9)');
    poly(ctx, [
      { x: c.x - r, y: c.y }, { x: c.x + r, y: c.y },
      { x: c.x + r * 0.7, y: c.y + r * 0.25 }, { x: c.x - r * 0.7, y: c.y + r * 0.25 },
    ], 'rgba(200,230,255,0.95)');
    bloom(ctx, c.x, c.y + r * 0.2, r * 0.8, [180, 230, 255], 0.5);
    void lw;
  },
});

// --- 11. MISSILE COMMAND --------------------------------------------------
//
// TWO POPULATIONS THAT INTERACT, which nothing else here does: arcs rain toward the board while
// interceptors rise to meet them, and each interception is an expanding ring that stops what it
// catches.
defineAgent('missile', {
  build({ W, H, rnd }) {
    const n = 5;
    const incoming = [];
    for (let i = 0; i < n; i++) {
      const from = { x: rnd() * W, y: H + 3 };
      const to = { x: rnd() * W, y: 1 + rnd() * (H * 0.4) };
      const t0 = rnd() * 0.35;
      // the interceptor leaves later and meets it partway: worked out now, so a frame only moves
      const meet = 0.45 + rnd() * 0.3;
      incoming.push({ from, to, t0, meet, up: { x: to.x + (rnd() - 0.5) * 8, y: 0 } });
    }
    return { incoming, W, H };
  },
  frame(a, u) {
    const heads = [];
    const shots = [];
    const bursts = [];
    for (const m of a.incoming) {
      const v = (u - m.t0) / 0.7;
      if (v <= 0) continue;
      const caught = v >= m.meet;
      const k = Math.min(caught ? m.meet : v, 1);
      const x = m.from.x + (m.to.x - m.from.x) * k;
      const y = m.from.y + (m.to.y - m.from.y) * k;
      if (!caught) {
        shots.push({ x, y, from: m.from, k, kind: 'down' });
        heads.push({ x, y, color: [255, 120, 90], alpha: 1, r: 1.2 });
      } else {
        const age = (v - m.meet) / 0.35;
        if (age < 1) {
          bursts.push({ x, y, age });
          heads.push({ x, y, color: [255, 240, 180], alpha: 1 - age, r: 1.5 + age * 5 });
        }
      }
      // the interceptor climbing to the meeting point
      const iv = Math.min(1, Math.max(0, (v - m.meet * 0.45) / (m.meet * 0.55)));
      if (iv > 0 && !caught) {
        const ix = m.up.x + (x - m.up.x) * iv, iy = m.up.y + (y - m.up.y) * iv;
        shots.push({ x: ix, y: iy, from: m.up, k: iv, kind: 'up' });
        heads.push({ x: ix, y: iy, color: [140, 255, 200], alpha: 1, r: 1 });
      }
    }
    return { missile: { shots, bursts }, heads };
  },
  draw(ctx, view, lw) {
    const m = view.fx?.missile;
    if (!m) return;
    const U = view.unit ?? 8;
    for (const s of m.shots) {
      const a0 = project(s.from.x, s.from.y, 0.8, view);
      const a1 = project(s.x, s.y, 0.8, view);
      const col = s.kind === 'down' ? '255,120,90' : '140,255,200';
      line(ctx, [a0, a1], `rgba(${col},0.35)`, lw * 3);
      line(ctx, [a0, a1], `rgba(${col},0.9)`, lw * 1.2);
      bloom(ctx, a1.x, a1.y, U * 0.45, s.kind === 'down' ? [255, 150, 110] : [170, 255, 210], 0.9);
    }
    for (const b of m.bursts) {
      const c = project(b.x, b.y, 0.9, view);
      const r = U * (0.5 + b.age * 3.4);
      const fade = 1 - b.age;
      ring(ctx, c.x, c.y, r, `rgba(255,220,150,${(0.8 * fade).toFixed(3)})`, lw * 3);
      ring(ctx, c.x, c.y, r * 0.65, `rgba(255,255,240,${(0.9 * fade).toFixed(3)})`, lw * 1.6);
      bloom(ctx, c.x, c.y, r * 0.5, [255, 235, 190], fade * 0.7);
    }
  },
});

// --- 12. ASTEROIDS --------------------------------------------------------
//
// Pure vector art, which is what this renderer draws natively: tumbling wireframe polygons
// drifting across, each splitting into two smaller ones partway. Nothing else here is line-only.
defineAgent('asteroids', {
  build({ W, H, rnd }) {
    const rocks = [];
    for (let i = 0; i < 4; i++) {
      const shape = [];
      const n = 7 + ((rnd() * 4) | 0);
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const rad = 0.62 + rnd() * 0.38;
        shape.push([Math.cos(ang) * rad, Math.sin(ang) * rad]);
      }
      rocks.push({
        shape,
        x: rnd() * W, y: rnd() * H,
        vx: (rnd() - 0.5) * W * 0.5, vy: (rnd() - 0.5) * H * 0.5,
        spin: (rnd() - 0.5) * 5, size: 2.4 + rnd() * 1.6,
        splitAt: 0.42 + rnd() * 0.25,
      });
    }
    return { rocks, W, H };
  },
  frame(a, u) {
    const out = [];
    const heads = [];
    for (const r of a.rocks) {
      const wrap = (v, m) => ((v % m) + m) % m;
      const push = (x, y, size, spin) => {
        const px = wrap(x, a.W), py = wrap(y, a.H);
        out.push({ x: px, y: py, size, rot: spin, shape: r.shape });
        heads.push({ x: px, y: py, color: [190, 210, 235], alpha: 0.85, r: size * 0.8 });
      };
      if (u < r.splitAt) {
        push(r.x + r.vx * u, r.y + r.vy * u, r.size, u * r.spin);
      } else {
        // it broke: two halves going their own ways from where it was
        const bx = r.x + r.vx * r.splitAt, by = r.y + r.vy * r.splitAt;
        const d = u - r.splitAt;
        push(bx + (r.vx * 0.6 + r.vy * 0.5) * d, by + (r.vy * 0.6 - r.vx * 0.5) * d, r.size * 0.6, u * r.spin * 1.6);
        push(bx + (r.vx * 0.6 - r.vy * 0.5) * d, by + (r.vy * 0.6 + r.vx * 0.5) * d, r.size * 0.6, -u * r.spin * 1.6);
      }
    }
    return { asteroids: { rocks: out }, heads };
  },
  draw(ctx, view, lw) {
    const a = view.fx?.asteroids;
    if (!a) return;
    const U = view.unit ?? 8;
    for (const r of a.rocks) {
      const c = project(r.x, r.y, 1.4, view);
      const ca = Math.cos(r.rot), sa = Math.sin(r.rot);
      const pts = r.shape.map(([sx, sy]) => ({
        x: c.x + (sx * ca - sy * sa) * U * r.size,
        y: c.y + (sx * sa + sy * ca) * U * r.size * 0.72,
      }));
      // a faint fill so it occludes a little, then the wire: Asteroids was a vector display
      poly(ctx, pts, 'rgba(20,30,45,0.45)');
      wire(ctx, pts, 'rgba(120,150,190,0.55)', lw * 4);
      wire(ctx, pts, 'rgba(225,238,255,0.95)', lw * 1.4);
    }
  },
});
