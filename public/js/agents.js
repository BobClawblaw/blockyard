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
