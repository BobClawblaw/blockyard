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
  bounceDrop,
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
  // Four phases now, and the last two are the ask:
  //   IN    0.00-0.30  the saucer flies in from one side
  //   HOLD  0.30-0.62  the beam comes on and the cube rises
  //   DROP  0.62-0.80  the beam CUTS and the cube falls, bouncing as it lands
  //   AWAY  0.80-1.00  the saucer climbs and accelerates off in a direction of its own
  //
  // The fall is the board's own bounceDrop, not a parabola written here: a cube dropped by the
  // saucer lands exactly as a cube dropped by a refresh does, which is the only way the two read as
  // the same world. It is called with a small bounce and few hops, because the ask was "slightly".
  //
  // The cube is back at lift 0 by the end of DROP, with the whole of AWAY to spare. That matters:
  // `lift` is a per-frame OVERRIDE applied to a copy of the tile, so when the effect ends the
  // override simply stops being computed -- a cube still in the air at that moment would snap to
  // the ground rather than land on it.
  frame(a, u) {
    const IN = 0.3, HOLD = 0.62, DROP = 0.8;
    // HIGHER, AND IT LIFTS HIGHER (operator, 2026-09-14: "I want the ufo effect flying at least 2 x
    // higher than it current is, and lift the blocks up much higher"). The saucer flew 5 over the
    // cube's top and drew it up 4.5; now twice that altitude and a 12-unit lift -- and never lower
    // than 4 units above the lifted cube's top, so a short cube is not pulled up through the ship.
    const LIFT = 12;
    const alt = Math.max(2 * (a.target.h + 5), a.target.h + LIFT + 4);
    if (u < IN) {
      const v = u / IN;
      const x = a.from.x + (a.target.x - a.from.x) * v;
      return { tractor: { ship: { x, y: a.target.y, z: alt }, beam: 0, lift: 0 },
        heads: [{ x, y: a.target.y, color: [180, 220, 255], alpha: 0.9, r: 1.6 }] };
    }
    if (u < HOLD) {
      const v = (u - IN) / (HOLD - IN);
      const beam = Math.sin(Math.min(1, v * 1.2) * Math.PI);
      const lift = v * LIFT;
      return {
        tractor: { ship: { x: a.target.x, y: a.target.y, z: alt }, beam, lift, target: a.target },
        // the beam lights the cube it is pulling, and lifts it
        heads: [
          { x: a.target.x, y: a.target.y, color: [190, 235, 255], alpha: 1, r: 2.4, lift },
          { x: a.target.x, y: a.target.y, color: [140, 200, 255], alpha: 0.5 * beam, r: 4 },
        ],
      };
    }
    if (u < DROP) {
      // RELEASED. The beam is off the instant it lets go -- a beam still drawn over a falling cube
      // reads as the ship dropping something it is still holding.
      const v = (u - HOLD) / (DROP - HOLD);
      const lift = LIFT * bounceDrop(v, 0.10, 2, 0.5);
      return {
        tractor: { ship: { x: a.target.x, y: a.target.y, z: alt }, beam: 0, lift, target: a.target, dropped: true },
        heads: [
          { x: a.target.x, y: a.target.y, color: [200, 240, 255], alpha: 1, r: 2.2, lift },
          // a flash of dust at the moment of impact, and only then
          { x: a.target.x, y: a.target.y, color: [255, 240, 200], alpha: lift < 0.05 ? 0.7 : 0, r: 3 },
        ],
      };
    }
    // AWAY: up and off along its own heading, t^2 so it pulls away rather than drifting. Far enough
    // to clear the board from wherever it was working, whichever way it points.
    const v = (u - DROP) / (1 - DROP);
    const dir = a.away ?? { dx: a.from.x < a.target.x ? -1 : 1, dy: 0 };
    const reach = Math.max(a.W, a.H) + 8;
    const x = a.target.x + dir.dx * reach * v * v, y = a.target.y + dir.dy * reach * v * v;
    return {
      tractor: { ship: { x, y, z: alt + 24 * v * v }, beam: 0, lift: 0, leaving: true },
      heads: [{ x, y, color: [180, 220, 255], alpha: Math.max(0, 1 - v), r: 1.6 }],
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



// --- 24. PORTAL -----------------------------------------------------------
//
// Two portals open on opposite edges; an agent enters one and leaves the other, CARRYING ITS TRAIL
// THROUGH the discontinuity -- which is a visual nothing else here can make.
defineAgent('portal', {
  build({ W, H, rnd }) {
    const horiz = rnd() < 0.5;
    const inAt = horiz ? { x: 0.5, y: 1 + rnd() * (H - 2) } : { x: 1 + rnd() * (W - 2), y: 0.5 };
    const outAt = horiz ? { x: W - 0.5, y: 1 + rnd() * (H - 2) } : { x: 1 + rnd() * (W - 2), y: H - 0.5 };
    return { horiz, inAt, outAt, W, H };
  },
  frame(a, u) {
    const THROUGH = 0.5;
    const heads = [
      { x: a.inAt.x, y: a.inAt.y, color: [120, 170, 255], alpha: 0.9, r: 2.2 },
      { x: a.outAt.x, y: a.outAt.y, color: [255, 150, 60], alpha: 0.9, r: 2.2 },
    ];
    // before halfway it runs toward the blue one; after, it comes out of the orange
    let at;
    if (u < THROUGH) {
      const v = u / THROUGH;
      const from = a.horiz ? { x: a.W * 0.72, y: a.inAt.y } : { x: a.inAt.x, y: a.H * 0.72 };
      at = { x: from.x + (a.inAt.x - from.x) * v, y: from.y + (a.inAt.y - from.y) * v };
    } else {
      const v = (u - THROUGH) / (1 - THROUGH);
      const to = a.horiz ? { x: a.W * 0.28, y: a.outAt.y } : { x: a.outAt.x, y: a.H * 0.28 };
      at = { x: a.outAt.x + (to.x - a.outAt.x) * v, y: a.outAt.y + (to.y - a.outAt.y) * v };
    }
    // the traveller lights the cubes in its own yellow, so the board glows with it rather than
    // in a colour the ball is not (operator, 2026-09-13: "a glowing yellow neon ball")
    heads.push({ x: at.x, y: at.y, color: [255, 225, 90], alpha: 1, r: 1.5 });
    return { portal: { inAt: a.inAt, outAt: a.outAt, at, through: u >= THROUGH }, heads };
  },
  draw(ctx, view, lw) {
    const p = view.fx?.portal;
    if (!p) return;
    const U = view.unit ?? 8;
    const W2 = Math.max(lw * 2, U * 0.16);
    const gate = (g, rgb) => {
      const c = project(g.x, g.y, 1.8, view);
      const rx = U * 1.1, ry = U * 2.2;
      const oval = [];
      for (let i = 0; i <= 24; i++) {
        const ang = (i / 24) * Math.PI * 2;
        oval.push({ x: c.x + Math.cos(ang) * rx, y: c.y + Math.sin(ang) * ry });
      }
      poly(ctx, oval, `rgba(${rgb.join(',')},0.22)`);
      wire(ctx, oval, `rgba(${rgb.join(',')},0.95)`, W2);
      bloom(ctx, c.x, c.y, rx * 1.4, rgb, 0.4);
    };
    gate(p.inAt, [110, 165, 255]);
    gate(p.outAt, [255, 150, 60]);
    // A GLOWING YELLOW NEON BALL (operator, 2026-09-13: "Have the Portal effect rendering a glowing
    // yellow neon ball"). It was a single bloom in white-blue going in and pale orange coming out,
    // which read as a smudge rather than an object. Now a real ball: a wide soft corona, three
    // stacked bodies and a hot pale centre, all plain rgba fills -- no shadowBlur, no globalAlpha,
    // no composite modes, the same rules the rest of this file is scanned for.
    const c = project(p.at.x, p.at.y, 1.3, view);
    const R = U * 0.78;
    bloom(ctx, c.x, c.y, R * 2.8, [255, 210, 40], 0.9);
    for (const [rr, col] of [
      [1.95, 'rgba(255,185,15,0.30)'],
      [1.30, 'rgba(255,215,55,0.58)'],
      [0.85, 'rgba(255,238,130,0.93)'],
      [0.48, 'rgba(255,252,205,1)'],
    ]) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(c.x, c.y, R * rr, 0, Math.PI * 2); ctx.fill();
    }
  },
});

// ================================================================= BATCH FIVE
//
// The last six, and with them every effect in the catalogue that was worth building. Two use the
// skyline as TERRAIN rather than as an obstacle, one is deliberately rare, and one de-reses the
// board and puts it back.












