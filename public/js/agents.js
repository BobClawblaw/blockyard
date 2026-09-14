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
  // the board's OWN gravity, for the tractor beam's release. A dropped cube must fall the way every
  // other cube on this board falls -- a second hand-rolled parabola beside the real one would land
  // differently from the transition happening next to it.
  bounceDrop, bouncesUntil, landingMs, fallShare,
} from './blockscene3d.js';
// The tetris drop points the real rules at the board instead of a well: pure, and already
// tested in its own right, so the piece shapes and their rotations are not reinvented here.
import { PIECES, cellsOf } from './tetris.js';

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





// --- 10. TRACTOR BEAM -----------------------------------------------------
//
// DATA-AWARE, and the only agent that uses `lift`: a ship stops over the TALLEST cube on the
// board, opens a beam, and draws it up. The cube rises, thins and vanishes -- then comes back when
// the effect ends, because nothing here mutates the board (see the hide/scale note in
// blockscene3d.js).
defineAgent('tractor', {
  build({ tiles, W, H, rnd }) {
    const target = tallestTile(tiles) ?? { x: W / 2, y: H / 2, h: 1, tile: null };
    // where it leaves for, picked now so the exit replays identically (operator, 2026-09-14: "After
    // it drops them, have it fly up and away in a random direction")
    const away = rnd() * Math.PI * 2;
    return { target, from: { x: rnd() < 0.5 ? -4 : W + 4, y: target.y }, away: { dx: Math.cos(away), dy: Math.sin(away) }, W, H };
  },
  // IT PUTS THE BLOCK DOWN AND LEAVES (operator, 2026-09-13: "rather than just abruptly finish,
  // have the UFO drop the blocks causing them to slightly bounce, and then quickly flies off
  // screen"). Before this the beam simply stopped: the cube was still four and a half units in the
  // air, the saucer still parked over it, and the whole thing blinked out mid-abduction.
  //
  // HIGHER STILL, AND A REAL FALL (operator, 2026-09-14: "have it flying even higher off the board.
  // and lift the blocks higher. When it lets go of the blocks, allow gravity to make them fall, and
  // bounce before coming to rest"). The drop used to be squeezed into a fixed share of the effect,
  // so its speed came from the effect's length, not from gravity. It is now timed by the board's
  // own GRAVITY -- the constant every refresh landing falls under -- so a 24-unit fall takes
  // fallMs(24) = 849 ms whatever the effect's duration, and the cube bounces with a coefficient of
  // restitution of 0.5: hops of 6, 1.5 and 0.4 units, each shorter by sqrt(0.25), before it rests.
  // Livelier than a refresh landing (e 0.15-0.36, hops of a few percent) on purpose: those barely
  // leave the floor, and the ask was for a bounce you can see.
  //
  //   IN       0.00-0.22  the saucer flies in from one side
  //   HOLD     0.22-0.50  the beam comes on and draws the cube up, easing to a stop at the top
  //   RELEASE  0.50       the beam cuts; the cube falls from rest under gravity and bounces
  //   AWAY     first impact -> 1.00  the saucer climbs off along its own heading while it bounces
  //
  // Still grounded well before the end: `lift` is a per-frame OVERRIDE on a copy of the tile, so a
  // cube still in the air when the effect stops would snap to the floor instead of landing on it.
  // If the effect is ever made too short to hold the whole landing, the landing is compressed to
  // fit rather than cut -- an honest fall that ends in a snap is worse than a quicker one.
  frame(a, u, ctx = {}) {
    const ms = ctx.ms ?? 8000;
    const IN = 0.22, HOLD = 0.5;
    const LIFT = 24;
    // three times the old 5-over-the-top altitude, and never less than 6 over the lifted cube
    const alt = Math.max(3 * (a.target.h + 5), a.target.h + LIFT + 6);
    const E2 = 0.25;                                   // restitution 0.5, squared: each hop's share of the last
    const hops = bouncesUntil(E2, E2);
    const landU = Math.min(0.9 - HOLD, landingMs(LIFT, E2, hops, E2) / ms);
    const impactU = HOLD + landU * fallShare(E2, hops, E2);
    const dir = a.away ?? { dx: a.from.x < a.target.x ? -1 : 1, dy: 0 };
    const reach = Math.max(a.W, a.H) + 8;

    // the saucer: in, parked over the cube, then away from the moment the cube first hits the floor
    let ship, leaving = false, shipAlpha = 0.9;
    if (u < IN) {
      const v = u / IN;
      ship = { x: a.from.x + (a.target.x - a.from.x) * v, y: a.target.y, z: alt };
    } else if (u < impactU) {
      ship = { x: a.target.x, y: a.target.y, z: alt };
    } else {
      // up and off along its own heading, t^2 so it pulls away rather than drifting
      const v = Math.min(1, (u - impactU) / Math.max(1e-6, 1 - impactU));
      ship = { x: a.target.x + dir.dx * reach * v * v, y: a.target.y + dir.dy * reach * v * v, z: alt + 30 * v * v };
      leaving = true;
      shipAlpha = Math.max(0, 1 - v);
    }

    // the cube
    let lift = 0, beam = 0, dropped = false;
    if (u >= IN && u < HOLD) {
      const v = (u - IN) / (HOLD - IN);
      beam = Math.sin(Math.min(1, v * 1.2) * Math.PI) * 0.6 + 0.4;
      lift = LIFT * (1 - Math.cos(Math.PI * v)) / 2;    // eases to a stop at the top, so the fall starts from rest
    } else if (u >= HOLD && u < HOLD + landU) {
      // RELEASED. The beam is off the instant it lets go -- a beam still drawn over a falling cube
      // reads as the ship dropping something it is still holding.
      lift = LIFT * bounceDrop((u - HOLD) / landU, E2, hops, E2);
      dropped = true;
    }

    const heads = [{ x: ship.x, y: ship.y, color: [180, 220, 255], alpha: shipAlpha, r: 1.6 }];
    if (u >= IN && u < HOLD + landU) {
      heads.push({ x: a.target.x, y: a.target.y, color: [190, 235, 255], alpha: 1, r: 2.4, lift });
      if (beam > 0) heads.push({ x: a.target.x, y: a.target.y, color: [140, 200, 255], alpha: 0.5 * beam, r: 4 });
      // a flash of dust on each impact, and only then
      if (dropped && lift < 0.05) heads.push({ x: a.target.x, y: a.target.y, color: [255, 240, 200], alpha: 0.7, r: 3 });
    }
    return {
      tractor: { ship, beam, lift, ...(u >= IN && !leaving ? { target: a.target } : {}), ...(dropped ? { dropped: true } : {}), ...(leaving ? { leaving: true } : {}) },
      heads,
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



// ================================================================ BATCH THREE
//
// Six that change the board rather than crossing it, and two that ADD INFORMATION -- which is the
// rarest thing an effect here can do. Every one is still a per-frame override: nothing below
// mutates a tile (see hide/scale in blockscene3d.js).

/** Flood fill over the grid from a seed, stopping at cells a predicate refuses. Pure. */
export function floodFrom(x0, y0, W, H, blocked, limit = 900) {
  const seen = new Set();
  const order = [];
  const key = (x, y) => y * W + x;
  const q = [[x0 | 0, y0 | 0]];
  seen.add(key(x0 | 0, y0 | 0));
  while (q.length && order.length < limit) {
    const [x, y] = q.shift();
    order.push({ x, y, d: order.length });
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      if (blocked(nx, ny)) continue;      // seen, so it is never revisited, but not entered
      q.push([nx, ny]);
    }
  }
  return order;
}













// ================================================================= BATCH FOUR
//
// The family that could not be built until heads carried `hide` and `scale` (see the commit that
// wired them through). Three of these ALTER THE BOARD -- absorbing, collapsing, digging -- which
// the operator allowed on the condition that it snaps back: "Allow it, it snaps back". It does,
// by construction, because none of them touches a tile. They publish an override per frame and
// the renderer applies it to a copy; when the effect ends, or a transition takes the stage, or
// the tab is hidden, the override simply stops being computed.



// --- 20. BOULDER DASH -----------------------------------------------------
//
// A column gives way and the cubes above it COLLAPSE, each shrinking to nothing in turn, the
// cascade spreading outward from where it started.
defineAgent('boulderdash', {
  build({ W, H, rnd, tiles }) {
    const at = { x: Math.floor(rnd() * W), y: Math.floor(rnd() * H) };
    void tiles;
    return { at, W, H, reach: 7 + Math.floor(rnd() * 5) };
  },
  frame(a, u) {
    // the cascade front, spreading out from the collapse
    const front = u * a.reach * 1.5;
    const heads = [];
    for (let r = 0; r <= Math.min(a.reach, Math.ceil(front)); r++) {
      const age = (front - r) / 2.2;
      if (age < 0 || age > 1.6) continue;
      const shrink = Math.max(0, 1 - age);      // full height at the front, gone behind it
      const n = Math.max(1, r * 4);
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        heads.push({
          x: a.at.x + Math.cos(ang) * r, y: a.at.y + Math.sin(ang) * r,
          // THE RING MUST STILL BE VISIBLE WHERE IT IS WIDEST. alpha was 0.8 * shrink, and shrink
          // goes to zero as a cube finishes collapsing -- so at u=0.9, with the front at its
          // furthest, every head was alpha 0.00 and the collapse happened in the dark. Measured.
          // A floor keeps the rim lit; `scale` carries the collapse, and it is gated on reach now
          // rather than on alpha, so the two are properly separate.
          color: [255, 190, 110], alpha: 0.35 + 0.55 * shrink, r: 1.1,
          scale: 0.12 + 0.88 * shrink,
        });
      }
    }
    return { boulderdash: { at: a.at, front }, heads };
  },
  draw(ctx, view, lw) {
    const b = view.fx?.boulderdash;
    if (!b) return;
    const U = view.unit ?? 8;
    // dust where the front is passing, so a collapse has debris
    for (let i = 0; i < 28; i++) {
      const ang = hash01(i * 13 + 5) * Math.PI * 2;
      const rad = b.front * (0.6 + 0.5 * hash01(i * 7 + 11));
      const c = project(b.at.x + Math.cos(ang) * rad, b.at.y + Math.sin(ang) * rad, 0.5 + hash01(i) * 1.5, view);
      const r = U * (0.18 + 0.3 * hash01(i * 3 + 19));
      ctx.fillStyle = `rgba(210,190,150,${(0.28 * (1 - Math.min(1, b.front / 11))).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
    }
    void lw;
  },
});



// --- 24. BALL LIGHTNING ---------------------------------------------------
//
// (operator, 2026-09-14: "Remove the Portal effect, and replace it with a bright electric blue neon
// sphere of slow moving ball lightning that crackles with energy, and random arcs of energy burst out
// from the ball lightning and electrifies the blocks the arcs touch. Have it move from one end of the
// view space to the other disappearing off-screen.")
//
// The route and every arc are decided at build, from the seeded rnd -- the board is still while an
// effect runs -- so a frame only asks where the ball is and which arcs are alive. An arc is aimed at a
// real block near the ball, never at empty floor: the ask is that arcs electrify what they touch.
// The crackle on the sphere itself is re-rolled every frame (Math.random, as this file allows for
// sparkle that is never asserted frame to frame): electrical precisely because it never repeats.
defineAgent('stormball', {
  build({ W, H, tiles, tops, rnd }) {
    tops ??= cellTops(tiles ?? [], W, H);
    const top = (cx, cy) => (cx >= 0 && cx < W && cy >= 0 && cy < H ? tops[cy * W + cx] : 0);
    let highest = 0;
    for (let i = 0; i < W * H; i++) highest = Math.max(highest, tops[i] ?? 0);
    // across the board the long way round, far enough past both edges to start and end off-screen
    const leftToRight = rnd() < 0.5;
    const margin = Math.max(W, H) * 0.55 + 6;
    const from = { x: leftToRight ? -margin : W + margin, y: H * (0.22 + 0.56 * rnd()) };
    const to = { x: leftToRight ? W + margin : -margin, y: H * (0.22 + 0.56 * rnd()) };
    const weave = { amp: 1.5 + 2 * rnd(), cycles: 1 + rnd() * 1.5, phase: rnd() * Math.PI * 2 };
    const alt = highest + 3.5;
    // bursts of arcs: a few a second, one to three at a time, each alive for a moment
    const arcs = [];
    for (let u = 0.03; u < 0.97; u += 0.016 + 0.035 * rnd()) {
      const n = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) arcs.push({ u0: u + rnd() * 0.01, life: 0.02 + 0.035 * rnd(), ang: rnd() * Math.PI * 2, reach: 3.5 + 8 * rnd(), seed: Math.floor(rnd() * 1e9) });
    }
    return { from, to, weave, alt, arcs, W, H, top };
  },
  frame(a, u) {
    const at = (uu) => {
      const x = a.from.x + (a.to.x - a.from.x) * uu;
      const y = a.from.y + (a.to.y - a.from.y) * uu + a.weave.amp * Math.sin(uu * Math.PI * 2 * a.weave.cycles + a.weave.phase);
      return { x, y, z: a.alt + 0.6 * Math.sin(uu * 17) };
    };
    const ball = at(u);
    // where it just was: the nebula it leaves behind is drawn there, fading
    const trail = [0.01, 0.022, 0.036, 0.052, 0.07, 0.09].map((d) => (u - d >= 0 ? at(u - d) : null)).filter(Boolean);
    const live = [];
    const heads = [{ x: ball.x, y: ball.y, color: [70, 180, 255], alpha: 0.7, r: 4.5 }];
    for (const arc of a.arcs) {
      const age = (u - arc.u0) / arc.life;
      if (age < 0 || age > 2.2) continue;                         // alive, then an afterglow on the block
      const p = at(arc.u0);
      // the block the arc strikes: the tallest cell near where it is thrown, and none if the floor is bare
      const aimX = p.x + Math.cos(arc.ang) * arc.reach, aimY = p.y + Math.sin(arc.ang) * arc.reach;
      let hit = null;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const cx = Math.floor(aimX) + dx, cy = Math.floor(aimY) + dy, h = a.top(cx, cy);
        if (h > 0 && (!hit || h > hit.z)) hit = { x: cx + 0.5, y: cy + 0.5, z: h };
      }
      if (!hit) continue;
      if (age <= 1) live.push({ to: hit, seed: arc.seed, strength: 1 - age * 0.6 });
      // THE BLOCK IT TOUCHES IS ELECTRIFIED: a hard blue flare that flickers while the arc lives and
      // dies away after it -- lit through fxAt's heads, so only the cubes actually struck light up
      const flicker = 0.7 + 0.3 * Math.sin(u * 900 + arc.seed);
      const glow = age <= 1 ? flicker : Math.max(0, 1 - (age - 1) / 1.2) * 0.7;
      heads.push({ x: hit.x, y: hit.y, color: [60, 190, 255], alpha: Math.min(1, glow * 1.25), r: 1.2 });
    }
    return { stormball: { at: ball, arcs: live, trail, t: u }, heads };
  },
  draw(ctx, view, lw) {
    const s = view.fx?.stormball;
    if (!s) return;
    const U = view.unit ?? 8;
    const c = project(s.at.x, s.at.y, s.at.z, view);
    // sized in grid units, so it reads as the same bright object on every board (bloom's note above)
    const R = U * 3.4;   // bigger than the first cut: it is the one thing on the board (operator: "visually stunning")
    // a jagged bolt between two screen points, `kink` pixels of wander, re-rolled each frame
    const bolt = (p, q, kink, steps) => {
      const pts = [p];
      for (let i = 1; i < steps; i++) {
        const f = i / steps, nx = -(q.y - p.y), ny = q.x - p.x, L = Math.hypot(nx, ny) || 1;
        const off = (Math.random() - 0.5) * 2 * kink * Math.sin(Math.PI * f);
        pts.push({ x: p.x + (q.x - p.x) * f + (nx / L) * off, y: p.y + (q.y - p.y) * f + (ny / L) * off });
      }
      pts.push(q);
      return pts;
    };
    // the arcs first, so the sphere sits over the roots of its own lightning
    for (const arc of s.arcs) {
      const end = project(arc.to.x, arc.to.y, arc.to.z, view);
      const main = bolt(c, end, Math.hypot(end.x - c.x, end.y - c.y) * 0.18, 9);
      line(ctx, main, `rgba(30,120,255,${(0.3 * arc.strength).toFixed(3)})`, Math.max(lw * 8, U * 1.1));
      line(ctx, main, `rgba(60,170,255,${(0.6 * arc.strength).toFixed(3)})`, Math.max(lw * 4, U * 0.45));
      line(ctx, main, `rgba(140,220,255,${(0.95 * arc.strength).toFixed(3)})`, Math.max(lw * 2, U * 0.2));
      line(ctx, main, `rgba(245,252,255,${arc.strength.toFixed(3)})`, Math.max(lw, U * 0.08));
      // a fork off the main channel, and a spark where it lands
      const k = 3 + Math.floor(Math.random() * 4);
      const fork = main[k], forkEnd = { x: fork.x + (Math.random() - 0.5) * U * 3, y: fork.y + (Math.random() - 0.5) * U * 3 };
      line(ctx, bolt(fork, forkEnd, U * 0.5, 4), `rgba(130,215,255,${(0.6 * arc.strength).toFixed(3)})`, Math.max(lw, U * 0.08));
      bloom(ctx, end.x, end.y, U * 2.2, [90, 200, 255], arc.strength);
    }
    // THE SPHERE IS ONE SMOOTH THING (operator, 2026-09-14: "needs a smooth gradient, not different
    // discs around it. It needs to be visually stunning. Consider adding nebula effects"). Radial
    // gradients, which the canvas rules never forbade -- clip, globalAlpha, composite modes and
    // shadowBlur are the calls software rasterisers drop; a gradient fill is a fill. A harness
    // without them gets the old shells.
    // a gradient fill, or the first stop's colour where the canvas cannot make one (a test harness)
    const gradientOf = (x, y, r, stops) => {
      const g = typeof ctx.createRadialGradient === 'function' ? ctx.createRadialGradient(x, y, 0, x, y, r) : null;
      if (!g || typeof g.addColorStop !== 'function') return stops[0][1];
      for (const [o, col] of stops) g.addColorStop(o, col);
      return g;
    };
    const radial = (x, y, r, stops) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = gradientOf(x, y, r, stops); ctx.fill();
    };
    const t = (s.t ?? 0) * 11;                                   // seconds into the run, for the drift
    // THE NEBULA: three slow wisps of plasma around the ball, each a blob whose edge wanders with
    // a few sines, turning at its own rate, in violet, magenta and cyan -- faint, wide, and drawn
    // first so the sphere burns through them
    const wisps = [[170, 70, 255, 0.42, 1.0], [255, 60, 190, 0.38, -0.7], [40, 220, 255, 0.28, 0.5], [255, 130, 80, 0.22, -1.3]];
    wisps.forEach(([r, g, b, a, spin], k) => {
      const cxk = c.x + Math.cos(t * spin * 0.6 + k * 2.1) * R * 0.5, cyk = c.y + Math.sin(t * spin * 0.45 + k * 1.3) * R * 0.4;
      const base = R * (2.1 + 0.45 * k);
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const th = (i / 40) * Math.PI * 2;
        const wobble = 1 + 0.28 * Math.sin(th * 3 + t * spin + k) + 0.17 * Math.sin(th * 5 - t * 0.8 * spin + k * 3) + 0.09 * Math.sin(th * 8 + t * 1.7);
        const rr = base * wobble;
        const x = cxk + Math.cos(th) * rr, y = cyk + Math.sin(th) * rr;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = gradientOf(cxk, cyk, base * 1.4, [[0, `rgba(${r},${g},${b},${a})`], [0.35, `rgba(${r},${g},${b},${(a * 0.7).toFixed(3)})`], [0.7, `rgba(${r},${g},${b},${(a * 0.25).toFixed(3)})`], [1, `rgba(${r},${g},${b},0)`]]);
      ctx.fill();
    });
    // the nebula it leaves behind: where the ball just was, each older and fainter
    (s.trail ?? []).forEach((p, i) => {
      const q = project(p.x, p.y, p.z, view);
      const f = 1 - (i + 1) / ((s.trail?.length ?? 1) + 1);
      radial(q.x, q.y, R * (1.8 + i * 0.6), [[0, `rgba(140,150,255,${(0.28 * f).toFixed(3)})`], [0.5, `rgba(120,60,230,${(0.16 * f).toFixed(3)})`], [1, 'rgba(60,20,160,0)']]);
    });
    // the corona: wide, electric, breathing
    const breath = 1 + 0.06 * Math.sin(t * 5.3) + 0.04 * Math.sin(t * 8.9);
    radial(c.x, c.y, R * 3.6 * breath, [[0, 'rgba(60,160,255,0.5)'], [0.3, 'rgba(40,120,255,0.22)'], [0.6, 'rgba(90,50,230,0.08)'], [1, 'rgba(90,50,230,0)']]);
    // sparks in orbit: motes of light circling at their own speeds and radii, each a tiny gradient
    for (let i = 0; i < 26; i++) {
      const sp = 0.6 + (i % 7) * 0.23, ph = i * 2.399, rr = R * (1.5 + ((i * 37) % 11) / 11 * 2.2);
      const ang = t * sp + ph, wob = 1 + 0.18 * Math.sin(t * 3.1 + i);
      const x = c.x + Math.cos(ang) * rr * wob, y = c.y + Math.sin(ang) * rr * 0.55 * wob;
      const tone = i % 3 === 0 ? '255,120,230' : i % 3 === 1 ? '120,200,255' : '200,160,255';
      radial(x, y, Math.max(1.5, U * 0.22), [[0, `rgba(${tone},0.95)`], [0.4, `rgba(${tone},0.45)`], [1, `rgba(${tone},0)`]]);
    }
    // the ball: white-hot centre through cyan to a violet rim, one gradient
    radial(c.x, c.y, R * 1.35 * breath, [
      [0, 'rgba(255,255,255,1)'], [0.18, 'rgba(235,250,255,1)'], [0.4, 'rgba(150,225,255,0.95)'],
      [0.62, 'rgba(60,170,255,0.8)'], [0.82, 'rgba(90,80,255,0.45)'], [1, 'rgba(120,60,255,0)'],
    ]);
    // THE CRACKLE: short filaments skittering over and just off the surface, new every frame
    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * Math.PI * 2, r0 = R * (0.35 + 0.5 * Math.random()), r1 = R * (1.05 + 0.55 * Math.random());
      const p = { x: c.x + Math.cos(ang) * r0, y: c.y + Math.sin(ang) * r0 };
      const q = { x: c.x + Math.cos(ang + (Math.random() - 0.5) * 0.9) * r1, y: c.y + Math.sin(ang + (Math.random() - 0.5) * 0.9) * r1 };
      const pts = bolt(p, q, R * 0.22, 4);
      line(ctx, pts, 'rgba(90,190,255,0.55)', Math.max(lw * 2.2, U * 0.12));
      line(ctx, pts, 'rgba(230,248,255,0.95)', Math.max(lw, U * 0.04));
    }
  },
});

// ================================================================= BATCH FIVE
//
// The last six, and with them every effect in the catalogue that was worth building. Two use the
// skyline as TERRAIN rather than as an obstacle, one is deliberately rare, and one de-reses the
// board and puts it back.












