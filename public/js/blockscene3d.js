// blockscene3d.js -- the block as a field of uniform slabs on a plane, and a
// Tetris-inspired, collision-free choreography that moves them between layouts.
//
// THE DESIGN, as specified by the operator 2026-09-10:
//   * Every tile on the plane has the SAME height. Feerate is carried by
//     COLOUR alone (the feerate bands of feepalette.js). An earlier cut varied height
//     by feerate, which made the resting plane a skyline; that is not this.
//     Height is reserved entirely for motion.
//   * On a refresh a tile lifts OFF the plane, travels, and descends into its
//     new slot, never passing through another tile on the way.
//   * The movement is TETRIS: lateral travel happens in whole grid steps, and
//     the arrival is a gravity drop that accelerates and locks. Nothing
//     drifts smoothly on a diagonal, because that is not how a piece moves.
//   * Slow enough to read: >= 5 s against a 10 s refresh.
//
// HOW THE NO-COLLISION GUARANTEE WORKS. Every mover shares the same three
// phase boundaries, and that is the whole trick:
//
//   phase 1  RISE     each tile lifts straight up out of its OWN slot. The
//                     packer guarantees resting slots never overlap, so two
//                     tiles cannot meet while going straight up.
//   phase 2  TRAVEL   each tile shifts at its OWN ALTITUDE, in grid steps.
//                     Altitudes are distinct and separated by more than a
//                     slab is thick, so no two tiles can share space whatever
//                     routes they take -- no path planning, no pairwise
//                     checks.
//   phase 3  DROP     each tile falls straight down into its NEW slot. New
//                     slots are non-overlapping too, so again no meeting.
//
// The alternative -- staggered departures with tiles routing around each
// other -- needs pairwise path checks and still promises little. Phase
// separation is provable in three sentences, and is tested by sampling the
// whole flight and intersecting every pair of boxes.
//
// CONSTRAINTS (test/never-clip.test.js and the incident behind it): no
// ctx.clip(), no ctx.globalAlpha, zero dependencies. Pure geometry and time,
// no canvas, so all of it is testable headless.

// EVERY TILE IS THE SAME HEIGHT (operator, 2026-09-10): a block's volume must
// track its transaction's vbytes, and vbytes is an AREA on this grid. Briefly
// these were true cubes with height = side; that cubed the volume, so a tile
// twice as wide looked eight times the transaction instead of four, and the
// small ones vanished. Uniform height restores the proportion: footprint
// carries the size, and the height is a constant that only gives the tile
// enough body to catch the light.
export const TILE_H = 1.0;   // the unit slab: the clearance lanes keep, and a fallback height
// ACTUAL CUBES (operator, 2026-09-11: "They need to be actual cubes"). This
// reverses the 2026-09-10 decision above on the operator's call. The honest
// part is unchanged -- the FOOTPRINT is the vbytes, exactly as on
// mempool.space -- but a block now stands as tall as it is wide, so a large
// transaction is a tower and a small one a pebble, and seen through the camera
// a cube shows the sides that face it. Everything that assumed one slab height
// now asks cubeHeight(): the lanes (so flight stays collision-free), the paint
// order, the growth policing and the edge hold.
// A tile laid out by a caller (board3d -- the market towers) may stand taller than its
// footprint: `tall` is its height. Transactions never set it and stay cubes.
export function cubeHeight(tile) {
  if (tile && Number.isFinite(tile.tall)) return tile.tall;
  return tile && Number.isFinite(tile.s) ? tile.s : TILE_H;
}
export const SLAB_H = TILE_H;

// --- projection --------------------------------------------------------
// A SQUARE GRID, straight on. Not isometric (operator, 2026-09-10: "Don't
// make it a diamond any more. Make it a square grid up and down. we should
// get rid of rotation if it helps the animation").
//
// Screen x is the grid column, screen y is the grid row MINUS the height, so
// a block that rises moves straight up the screen and nothing skews. The grid
// is therefore a true square, every cell is a square, and a tile's footprint
// lands exactly on cell boundaries -- which is what "grid aligned" can
// actually mean once the diamond is gone.
//
// Rotation is gone with it. Orbiting a square grid only turns it back into a
// diamond, and dropping it removes a whole axis from the depth sort, the face
// selection and the hit testing.
// flipY puts row 0 at the BOTTOM of the screen. The packer lays the richest
// transactions down first, at row 0, so without this the expensive end sits
// at the top; the operator wants it bottom-left, where a miner's "what fits"
// line reads naturally upward.
// THE SPHERE (operator, 2026-09-11: "A dome is the right analog for this. In
// fact, I want the entire sphere to be textured as it is, and I want our grid
// centered within the view-space" / "grid surface fills the panel" / "sphere
// continues rendering off the screen, textured ... viewport only obviously").
// The board is a patch of a real sphere: its centre raised by o.dome, its four
// corners on the plane, and the same sphere carrying on past the board to
// every edge of the panel. The radius follows from those two facts. No dome
// (or no grid), no sphere: the plane.
export function sphereOf(o = {}) {
  const { dome = 0, gridW = 0, gridH = 0 } = o;
  if (!(dome > 0) || !gridW || !gridH) return null;
  const R = ((gridW / 2) ** 2 + (gridH / 2) ** 2 + dome * dome) / (2 * dome);
  return { cx: gridW / 2, cy: gridH / 2, R, sink: R - dome };
}

// the sphere's height above the plane at a grid point
export function capZ(gx, gy, o = {}) {
  const s = sphereOf(o);
  if (!s) return 0;
  const dx = gx - s.cx, dy = gy - s.cy;
  return Math.sqrt(Math.max(0, s.R * s.R - dx * dx - dy * dy)) - s.sink;
}

// "straight up relative to their position on the sphere" (operator,
// 2026-09-11): the outward normal there, in grid units -- radial from the
// sphere's centre, so blocks leaving the board fan outward from its middle.
// The direction a block travels, as drawn. Under the oblique camera project() adds ox per unit
// of height, which is a constant rightward push on every block whatever its place on the board;
// taking it out of the path leaves motion that is symmetric about the middle -- what the sphere's
// normal was meant to give. Off the oblique camera there is no such term and this is the normal.
export function flightDir(gx, gy, o = {}) {
  // The oblique lean is radial now (obliqueLean), so the camera's own push already fans from the
  // middle: the flight is the sphere's normal again, and subtracting the lean here as well would
  // count that fan twice and tip every flight to the left.
  return surfaceNormal(gx, gy, o);
}

export function surfaceNormal(gx, gy, o = {}) {
  const s = sphereOf(o);
  if (!s) return { x: 0, y: 0, z: 1 };
  const dx = gx - s.cx, dy = gy - s.cy;
  return { x: dx / s.R, y: dy / s.R, z: Math.sqrt(Math.max(0, s.R * s.R - dx * dx - dy * dy)) / s.R };
}

// How far a unit of height pushes a cube sideways, at gx. Zero over the middle of the board and
// +/- oblique.ox at its edges: the fan of a camera standing over the centre. Without a board width
// (a bare projection in a test) it falls back to the old constant, so nothing that does not know
// about a board changes shape.
export function obliqueLean(gx, o = {}) {
  const ox = o.oblique?.ox ?? 0.15;
  const W = o.gridW || 0;
  if (!(W > 0)) return ox;
  const half = W / 2;
  return ox * Math.max(-1, Math.min(1, (gx - half) / half));
}

export function project(gx, gy, gz, o = {}) {
  const {
    unit = 12, zUnit = 10, originX = 0, originY = 0, flipY = true,
    persp = 0.55, vanishX = 0, vanishY = 0, risePerUnit = 0.075,
  } = o;
  // gz is HEIGHT TOWARD THE VIEWER (operator, 2026-09-10: "receding is not
  // working well. Make them rise toward the viewer at different heights").
  //
  // A rising block grows and moves OUTWARD from the vanishing point, which is
  // the opposite of the receding version and reads as coming at you. It can
  // therefore push past the board's edge, so the renderer reserves a constant
  // margin for the tallest lane -- constant, so the zoom still does not
  // breathe during a transition.
  //
  // It remains a real spatial axis, so the no-collision proof is unchanged:
  // two blocks at different heights cannot occupy the same space.
  const x0 = originX + gx * unit;
  // A LOWER CAMERA (operator, 2026-09-11: "Adjust the view even lower than currently, so that we
  // see more of the side view, than from above"): oblique.dy draws the board's depth shorter than
  // its width while height keeps its full oy, so the rows recede and the front faces of the cubes
  // take the screen. 1 (the default) is the straight-down board the block viewer uses.
  const dS = o.oblique?.dy ?? 1;
  const y0 = originY + (flipY ? -gy : gy) * unit * dS;
  // THE CURVED BOARD (operator, 2026-09-11: "adjusting the grid surface to be
  // a partial spherical segment would give us an entirely new dimension to
  // work with"): a patch of a real sphere, capZ above. It was a "pillow",
  // pinned to zero on every edge, while the board had to sit flush with its
  // frame; the board is centred on a sphere that fills the panel now, so the
  // true cap is back. Off (flat) without o.dome.
  const z = (gz || 0) + capZ(gx, gy, o);
  if (!z) return { x: x0, y: y0 };
  // THE OBLIQUE CAMERA (2026-09-11). Height is a FIXED screen offset -- up
  // and a little right, a camera off the lower-left of the screen -- instead
  // of the overhead pinhole's swell. Operator, in order: "offset something
  // outside the screen bounds so things aren't dropping directly down from
  // the viewer's perspective"; "Are they even proper cubes like I asked for?"
  // (overhead, a two-unit cube showed a sliver of side and read as a tile);
  // "Blocks bouncing around during movements and z-fighting in a weird way"
  // (the pinhole grew blocks with height and a growth rule re-limited them
  // every frame). Here every cube shows its top and its west and south faces,
  // a fall is visible motion up and down the screen, and nothing ever changes
  // size -- so there is no growth to police and nothing to flicker.
  if (o.oblique) return { x: x0 + z * (o.leanFixed ?? obliqueLean(gx, o)) * unit, y: y0 - (flipY ? 1 : -1) * z * o.oblique.oy * unit };
  const k = 1 + z * risePerUnit * persp;       // > 1: nearer, and larger
  return { x: vanishX + (x0 - vanishX) * k, y: vanishY + (y0 - vanishY) * k };
}

// kept under the old name so callers and tests need not all change at once
export const isoProject = project;

// OUTWARD, THROUGH A REAL CAMERA (operator, 2026-09-11, the latest of several
// rounds: "I think we need to have blocks moving outwards instead of directly
// up. Having issues really selling the 3D-ness of it"). An airborne block is
// projected by a true pinhole about the vanishing point: position AND size
// scale together by liftBoost(z), so a rising block travels out along the ray
// from the board's centre as it grows, and falls back in along that ray onto
// its slot. Two blocks at the same height scale APART together, so they cannot
// run into each other (which the own-centre growth below the next heading did,
// and which settleGrowth had to police). The swell is 7% per unit, capped at
// 2x, so the outward travel mostly stays inside the board; the edge hold in
// airTop catches the rest. History of the rounds, oldest first:
//
// STRAIGHT UP, TOWARD THE VIEWER. The asks, in order:
// "consider having the 3d blocks moving more towards the center, not away
// from the center"; then "rise to and come from a centerpoint"; then, of the
// centre pull that produced, "I don't mean for shit to get pulled directly to
// the center, or spawn from the center. I mean just pull or spawn it towards
// the viewer directly up until it fades out."
//
// What that means geometrically: the pinhole above scales every point about
// the vanishing point, so a risen block both GROWS and SLIDES OUTWARD -- the
// slide is what carried rim blocks off the panel and read as "away from the
// center". An airborne block is therefore drawn about its OWN centre instead:
// the centre stays exactly where a resting block's would be, and only the
// size changes with height.
//
// And the size has to change VISIBLY. The pinhole alone swells a block by
// r * persp per unit -- about 1.5% for a one-unit bounce -- so a bounce did
// not come toward the viewer at all, while its shadow spread into a dark ring
// round it, and that read as sinking into a hole (operator: "It looks like the
// cubes are bouncing from below, not from above. They need to obviously bounce
// towards the viewer"). liftBoost swells it by 12% per unit of height, capped
// at 3x. A first cut saturated at 30% and the operator still saw "they always
// stay the same size despite height off the grid" -- most hops are under a
// unit, so a saturating swell was worth 1-2% where it mattered.
//
// At z -> 0 both terms go to 1 and this is exactly the resting projection, so
// nothing jumps at touchdown. A centre-gather pull was built and removed the
// same day; recorded so it is not re-added. Pure rendering: world positions --
// and so the no-collision proof -- are untouched.
// capped at 1.5x (was 2x): a doubled block covered four of its neighbours.
// No swell at all below the height settleGrowth counts as airborne (0.02): a
// block in the last instant of its landing is policed as RESTING, so it must
// also be DRAWN at resting size -- measured, one at z = 0.006 overlapped its
// neighbour by a hundredth of a pixel because the two disagreed.
export function liftBoost(z) { return z > 0.02 ? Math.min(1.5, 1 + 0.07 * z) : 1; }

// HELD INSIDE THE BOARD (operator: "I want the grid bounds flush with the
// viewport"). A swollen block near the rim would cross the edge, so its whole
// drawing is nudged inward by exactly as much as its swollen top would
// overhang, and no more: an interior block still goes straight up over its
// own slot. The board spans x in [0, 2 vanishX] and y between 0 and 2 vanishY
// (the vanishing point is its centre); with no vanishing point given there is
// no board to hold it in.
// The screen box of an airborne block's top face at growth g, after the edge
// hold: centre and half-size. The hold's bounds are the board WIDENED to
// wherever the block's resting top already reaches, so the hold only ever
// answers for the growth -- at g = 1 nothing moves, and nothing jumps at
// touchdown.
export function airTop(tile, g, o = {}) {
  const { risePerUnit = 0.075, persp = 0.55, unit = 12, vanishX = 0, vanishY = 0 } = o;
  const cTop = project(tile.x + tile.s / 2, tile.y + tile.s / 2, cubeHeight(tile), o);
  // true perspective: the centre goes out along the ray from the vanishing point
  const px = vanishX + (cTop.x - vanishX) * g, py = vanishY + (cTop.y - vanishY) * g;
  const rest = (tile.s * unit / 2) * (1 + cubeHeight(tile) * risePerUnit * persp);
  const half = rest * g;
  const hold = (v, c, a, b) => {
    const lo = Math.min(a, c - rest), hi = Math.max(b, c + rest);
    return hi - lo < 2 * half ? (lo + hi) / 2 : Math.max(lo + half, Math.min(hi - half, v));
  };
  // The board's own bounds, given explicitly now that the vanishing point can
  // sit off the board (camera options, 2026-09-11); without them the board is
  // assumed centred on the vanishing point, as it always was.
  const W = o.boardW ?? Math.abs(2 * vanishX);
  const H = o.boardH ?? Math.abs(2 * vanishY);
  const yLo = o.flipY === false ? 0 : -H, yHi = o.flipY === false ? H : 0;
  const x = W ? hold(px, cTop.x, 0, W) : px;
  const y = H ? hold(py, cTop.y, yLo, yHi) : py;
  return { x, y, half, dx: x - px, dy: y - py };
}

// With the oblique camera a flight altitude is drawn COMPRESSED into the
// headroom above the board, so however high the lanes stack (cube lanes are
// intervals and can climb) a block in the air never leaves the frame; the
// cube's own height is drawn true. Near the plane the compression is the
// identity, so touchdown is seamless.
//
// The cube's own height counts against that headroom (2026-09-11). Only the
// BASE used to be compressed, into 8 units, and a 12-unit cube drawn true on
// top of it reached 20 units into a 13-unit strip -- the big ones flew off
// the top of the canvas. Each cube now gets what is left above its own
// height (headroom + dome - side), so its top never leaves the frame.
export function altitudeView(z, o = {}, h = 0) {
  const H = Math.max(1.5, (o.oblique?.headroom ?? 10) + (o.dome || 0) - h);
  return z > 0 ? H * (1 - Math.exp(-z / H)) : 0;
}

// Where a cube's base is DRAWN under the oblique camera: its flight altitude
// compressed into the headroom, plus `entry` -- the share of the height that
// puts it wholly outside the canvas (1), for an arrival still falling in or a
// departure flying off -- see offscreenLift. Used by the projector and by the paint order alike.
export function visualBase(tile, o = {}) {
  const z = tile.z ?? 0;
  let zv = 0;
  if (z > 0) {
    if (o.oblique && o.viewRect) {
      // HIGHER (operator, 2026-09-11: "the blocks can rise higher than they do
      // during reshuffling ... it will help sell the depth and shadows more").
      // Flights were squeezed into one fixed band (headroom + dome - side) so
      // that the tallest cube at the back edge stayed in frame. With the board
      // centred on the sphere most cubes have far more room than that: each
      // flight now gets the room at ITS spot -- the height at which its own
      // top would reach the panel's edge along its flight direction
      // (flightRoom) -- up to oblique.flight. Front and centre climb high,
      // the back rows stay in frame, and nothing is ever cut off.
      // The room is measured for the SPOT (a point at the cube's centre), not
      // the cube: a size-dependent room drew a big cube that was really above a
      // small one LOWER than it, and the pair flickered (see obliqueOrder). The
      // cube's own room then only clips the biggest at the ceiling, so none
      // leaves the frame.
      const H = Math.max(0, Math.min(o.oblique.flight ?? 120, flightRoom({ x: tile.x + tile.s / 2, y: tile.y + tile.s / 2, s: 0 }, o)));
      const view = (zz) => (H > 0 ? Math.min(Math.max(0, flightRoom(tile, o)), H * (1 - Math.exp(-zz / H))) : 0);
      // A LANDING RUNS IN DRAWN SPACE (operator, 2026-09-11: "The items slowly start
      // dropping. They need to drop like they were just let go, immediately succumb
      // to gravity, and bounce to a stop, following real physics"). Mapped point by
      // point through the compression above, a fall's real parabola was drawn slow
      // at the top -- where the compression is strongest -- and plunging at the
      // bottom: a hover, then a lurch. Now the DRAWN height is the gravity curve
      // itself: the release height as drawn, times bounceDrop's profile (1 - u^2 to
      // the floor, then rebounds of e^2 of it, each e as long). The real height --
      // the collision proof, the paint order -- keeps the same profile.
      zv = tile.landV != null && tile.fallFrom > 0 ? view(tile.fallFrom) * Math.max(0, tile.landV) : view(z);
    } else zv = altitudeView(z, o, cubeHeight(tile));
  }
  if (o.oblique && tile.entry > 0) zv += tile.entry * offscreenLift(tile, o);
  return zv;
}

// OFF SCREEN (operator, 2026-09-11: "I can see the new blocks spawning on
// screen. Have the spawning happen off-screen for new blocks being dropped
// in"). Under the oblique camera height goes up AND right, so a cube lifted
// high enough leaves over the top edge or the right one, whichever comes
// first; this is the height that takes its nearest corner past that edge,
// with two units to spare. viewUp / viewRight are the canvas's extent in grid
// units, from the renderer's constant fit; without them (tests, no panel) the
// board plus its reserved strip stands in.
//
// Since flight follows the sphere's normal (2026-09-11) a block's path can
// leave through ANY edge -- up-right at the middle of the board, out to the
// left near its left side -- so this finds the height at which the whole cube
// has passed whichever edge its path meets first, one unit beyond it.
// o.viewRect is the panel's extent in grid units, from the renderer's
// constant fit; without it (tests, no panel) the board plus the reserved
// margin on every side stands in.
export function offscreenLift(tile, o = {}) {
  const { v, dX, dY, x0, x1, up0, up1 } = flightFrame(tile, o);
  let h = Infinity;
  if (dX > 1e-6) h = Math.min(h, (v.x1 + 1 - x0) / dX);
  if (dX < -1e-6) h = Math.min(h, (x1 - (v.x0 - 1)) / -dX);
  if (dY > 1e-6) h = Math.min(h, (v.y1 + 1 - up0) / dY);
  if (dY < -1e-6) h = Math.min(h, (up1 - (v.y0 - 1)) / -dY);
  return Number.isFinite(h) ? Math.max(0, h) : 0;
}

// A cube's drawn extent at rest, the panel, and how far the cube moves across
// (dX) and up (dY) the panel per unit of flight along the sphere's normal.
function flightFrame(tile, o = {}) {
  const { ox = 0.15, oy = 0.36, headroom = 10 } = o.oblique || {};
  const head = headroom + (o.dome || 0);
  const W = o.gridW || 0, H = o.gridH || 0;
  const v = o.viewRect ?? { x0: -head * ox, x1: W + head * ox, y0: -head * oy, y1: H + head * oy };
  const cx = tile.x + tile.s / 2, cy = tile.y + tile.s / 2;
  const n = flightDir(cx, cy, o);
  const flip = o.flipY === false ? -1 : 1;
  // the lean where it stands, and the most it can have by the end of the flight (obliqueLean is
  // bounded by +/-ox), taken in the direction it is travelling: the conservative case
  const leanRest = obliqueLean(cx, o);
  const lean = n.x + leanRest * n.z >= 0 ? ox : -ox;
  const dX = n.x + lean * n.z, dY = flip * n.y + oy * n.z;
  const c = capZ(cx, cy, o), s = tile.s, reach = cubeHeight(tile);
  const x0 = tile.x + Math.min(c * lean, (c + reach) * lean);
  const x1 = tile.x + s + Math.max(c * lean, (c + reach) * lean);
  const up0 = (flip > 0 ? tile.y : -(tile.y + s)) + c * oy, up1 = up0 + s + reach * oy;
  return { v, dX, dY, x0, x1, up0, up1 };
}

// How high a cube can fly at its spot before any part of it reaches the
// panel's edge (half a unit short of it): the ceiling visualBase compresses
// its flight into, so a flight is as high as the panel allows and no higher.
export function flightRoom(tile, o = {}) {
  const { v, dX, dY, x0, x1, up0, up1 } = flightFrame(tile, o);
  const M = 0.5;
  let h = Infinity;
  if (dX > 1e-6) h = Math.min(h, (v.x1 - M - x1) / dX);
  if (dX < -1e-6) h = Math.min(h, (x0 - (v.x0 + M)) / -dX);
  if (dY > 1e-6) h = Math.min(h, (v.y1 - M - up1) / dY);
  if (dY < -1e-6) h = Math.min(h, (up0 - (v.y0 + M)) / -dY);
  return h;
}

export function liftProjector(tile, o = {}) {
  const z = tile.z ?? 0;
  // the camera's lean belongs to the block, not to each corner of it: settle it once per cube so
  // it stays rigid however wide it is, and take it where the cube IS -- a block in flight has
  // moved along the sphere's normal, and a lean from the slot it left is the wrong lean (see
  // obliqueLean)
  const cxRest = tile.x + tile.s / 2, cyRest = tile.y + tile.s / 2;
  if (o.oblique) {
    const zv = z > 0 ? visualBase(tile, o) : 0;
    const drift = zv * flightDir(cxRest, cyRest, o).x;       // along the sphere's normal
    const height = zv + capZ(cxRest + drift, cyRest, o) + (tile.floor ?? 0) + cubeHeight(tile) / 2;
    let lean = obliqueLean(cxRest + drift, o);
    for (let i = 0; i < 2; i++) lean = obliqueLean(cxRest + drift + height * lean, o);
    o = { ...o, leanFixed: lean };
  }
  if (!(z > 0)) return (gx, gy, gz) => project(gx, gy, gz, o);
  if (o.oblique) {
    // flight goes along the sphere's normal at the block's centre, so the
    // board's blocks leave and arrive fanned out from its middle; the cube
    // itself stays upright. project() adds the sphere's height where a point
    // is DRAWN, so the difference to where it stands is put back: the flight
    // is measured from the block's own spot on the sphere.
    const zv = visualBase(tile, o);
    const n = flightDir(tile.x + tile.s / 2, tile.y + tile.s / 2, o);
    const sx = zv * n.x, sy = zv * n.y, sz = zv * n.z;
    if (!sx && !sy) return (gx, gy, gz) => project(gx, gy, sz + (gz - z), o);
    return (gx, gy, gz) => project(gx + sx, gy + sy, sz + (gz - z) + capZ(gx, gy, o) - capZ(gx + sx, gy + sy, o), o);
  }
  const { risePerUnit = 0.075, persp = 0.55 } = o;
  const { vanishX = 0, vanishY = 0 } = o;
  const boost = Number.isFinite(tile.boost) ? tile.boost : liftBoost(z);
  const { dx, dy } = airTop(tile, boost, o);
  return (gx, gy, gz) => {
    const h = gz - z;                        // height within the block: 0 at its base, its side on top
    const f = project(gx, gy, 0, o);
    // a real pinhole: position AND size scale about the vanishing point; at
    // boost 1 this is exactly the resting projection, so touchdown is seamless
    const k = (1 + h * risePerUnit * persp) * boost;
    return { x: vanishX + (f.x - vanishX) * k + dx, y: vanishY + (f.y - vanishY) * k + dy };
  };
}

// AIRBORNE BLOCKS DO NOT GROW INTO EACH OTHER (operator: "the large bouncing
// blocks intersect each other when growing in size. We need to find a
// mitigation for that"). Growing each block about its own centre is what
// keeps it straight over its slot, but it is not a real projection: under a
// true pinhole two blocks at the same height scale APART together and never
// meet, while two neighbours swelling in place run into each other. So each
// frame the airborne blocks are placed highest first, and each one grows only
// as far as it can without touching a block already placed -- never below its
// true size, which is always clear, because in the drop every block is in its
// own column. A pair whose FOOTPRINTS overlap (a high lane crossing a low one
// in travel) is exempt: there one really is above the other, and the paint
// order already says so. Growing over RESTING blocks is left alone: that is
// what something above them looks like, and the offset shadow says so.
export function settleGrowth(tiles, o = {}) {
  const air = tiles.filter((t) => (t.z ?? 0) > 0.02).sort((p, q) => (q.z - p.z) || String(p.txid).localeCompare(String(q.txid)));
  const out = new Map();
  if (air.length < 2) { for (const t of air) out.set(t, liftBoost(t.z)); return out; }
  const feet = (p, q) => p.x < q.x + q.s && q.x < p.x + p.s && p.y < q.y + q.s && q.y < p.y + p.s;
  const hits = (A, B) => Math.abs(A.x - B.x) < A.half + B.half - 1e-9 && Math.abs(A.y - B.y) < A.half + B.half - 1e-9;
  // Everyone starts at TRUE size, which is always clear: at g = 1 an airborne
  // top is exactly a resting top, and resting tops of disjoint footprints do
  // not overlap. Each block, highest first, then grows as far as it can
  // without touching any other -- the ones already placed at their grown
  // size, the rest at true size -- so every later block still has its true
  // size to fall back on. (A first cut only looked at blocks already placed;
  // the highest then grew freely over a lower one that could not shrink.)
  // resting blocks are obstacles too, at their true size, for blocks near the plane
  const ground = tiles.filter((t) => !((t.z ?? 0) > 0.02));
  const box = new Map([...air, ...ground].map((t) => [t, airTop(t, 1, o)]));
  // With CUBES, true size is not always clear: a taller cube's top is nearer
  // the camera and drawn larger, so it covers the edge of a shorter neighbour.
  // That is correct occlusion, painted in the right order by top height. What
  // is policed is overlap that GROWTH adds, so a pair already overlapping at
  // true size is exempt, like a crossing.
  const rest1 = new Map(box);
  for (const t of air) {
    const want = liftBoost(t.z);
    const A1 = box.get(t);
    const Aw = airTop(t, want, o);
    // Through a real camera a growing block also TRAVELS, out along its ray,
    // so a neighbour can be touched at true size, passed through on the way,
    // and clear again at full growth. The first cut only checked full growth,
    // missed exactly that neighbour, and was measured overlapping it at
    // g = 1.07. So the watch list is everything touching the whole SWEPT box
    // (the centre moves monotonically and the size grows, so the boxes in
    // between stay inside the bounds of the two ends, edge hold included).
    const sw = {
      x0: Math.min(A1.x - A1.half, Aw.x - Aw.half), x1: Math.max(A1.x + A1.half, Aw.x + Aw.half),
      y0: Math.min(A1.y - A1.half, Aw.y - Aw.half), y1: Math.max(A1.y + A1.half, Aw.y + Aw.half),
    };
    const inSweep = (B) => B.x + B.half > sw.x0 + 1e-9 && B.x - B.half < sw.x1 - 1e-9 && B.y + B.half > sw.y0 + 1e-9 && B.y - B.half < sw.y1 - 1e-9;
    // EVERY airborne pair is policed, whatever their heights. Letting a block
    // more than a slab higher overlap a lower one (true occlusion, in
    // principle) was measured at ~750 overlapping pairs per frame on a
    // realistic refresh, and read as a heap (operator: "There is way too much
    // shit overlapping in 3D space"). And near the plane it is policed against
    // RESTING blocks too: a low bounce swelling over its neighbours reads as
    // sinking into them. Only a pair whose footprints genuinely overlap -- one
    // crossing over the other in travel -- is exempt; nothing can separate those.
    const obstacles = t.z < 2 ? [...air, ...ground] : air;
    const near = obstacles.filter((q) => q !== t && !feet(t, q) && !hits(A1, rest1.get(q)) && inSweep(box.get(q)));
    let g = want;
    if (near.length) {
      // Grow only up to the FIRST contact, never beyond it even where it would
      // be clear again: otherwise a block could pop over its neighbour from one
      // frame to the next as its height changes. Stepped, then refined.
      const clear = (k) => { const B = airTop(t, k, o); return near.every((q) => !hits(B, box.get(q))); };
      const STEPS = 32;
      let lo = 1, hi = null;
      for (let i = 1; i <= STEPS; i++) {
        const k = 1 + ((want - 1) * i) / STEPS;
        if (clear(k)) lo = k; else { hi = k; break; }
      }
      if (hi !== null) for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (clear(mid)) lo = mid; else hi = mid; }
      g = lo;
    }
    box.set(t, airTop(t, g, o));
    out.set(t, g);
  }
  return out;
}

// Painter's depth: rows draw back to front, so a nearer block's lip overlaps
// the one behind it. One axis, because there is only one now.
export function depthOf(tile, o = {}) {
  // nearer the viewer means lower on screen: with the rows flipped that is
  // the SMALLER row index, so the order reverses with the axis
  return (o.flipY === false) ? (tile.y + tile.s) : -tile.y;
}

export function depthSort(tiles, o = {}) {
  return [...tiles]
    .map((t) => ({ t, d: depthOf(t, o), z: t.z ?? 0 }))
    // lowest paints first: a block risen toward the viewer is in front of
    // everything still on the plane
    .sort((a, b) => (a.z - b.z) || (a.d - b.d) || String(a.t.txid).localeCompare(String(b.t.txid)))
    .map((e) => e.t);
}

// --- shading -----------------------------------------------------------
// Alpha rides inside rgba(), never through globalAlpha.
export function shade(hex, k, alpha = 1) {
  const h = String(hex).replace('#', '');
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = cl(parseInt(h.slice(0, 2), 16) * k);
  const g = cl(parseInt(h.slice(2, 4), 16) * k);
  const b = cl(parseInt(h.slice(4, 6), 16) * k);
  return `rgba(${r},${g},${b},${alpha})`;
}

// --- one slab ----------------------------------------------------------
// With a free yaw we cannot know in advance which sides face the camera, so
// all four are emitted and sorted back-to-front within the tile. The
// overdraw is two quads and it removes a whole class of bug.
// --- one block ---------------------------------------------------------
//
// THE BLOCK IS A TETRIS CELL WITH A CYBER FINISH (operator, 2026-09-11: "That
// bejewelled shit with the sparkles isn't working out for me. Consider a more
// tetris look for our blocks, but think cyber/futuristic. maybe even metallic
// sheens"). The gem cut tried earlier the same day -- chamfered octagons,
// crown facets, glints and stars -- is gone; recorded so it is not re-added
// as a flourish. All of this is solid polygons in paint order:
//
//   lip      the front face along the near edge, in shadow
//   top      the square, with the dark seam stroked round it
//   bevel    the raised frame of a Tetris cell, lit from the upper left:
//            far edge brightest, left lit, right dim, near edge darkest
//   face     the cell's face, in its feerate colour
//   well     the hollow in the middle of the face: four walls lit the OTHER
//            way round (the far wall in its own shadow, the near wall
//            catching the light) around a darker floor -- the inner square
//            of the Tetris reference (operator: "The blocks don't have that
//            hollow inner area")
//   rim      a thin line round the well's lip in a lifted tint: the neon edge
// Diagonal sheen streaks and a gloss band were tried the same day and removed
// ("I don't like the diagonal lines in our large block design").
//
// A mid-sized block has the frame and face; a tiny one is a plain slab. The
// feerate colour is untouched -- every layer is derived from it, or is white
// at low alpha laid over it.
export function blockBevel(s) { return Math.min(0.7, Math.max(0.12, s * 0.15)); }

export function tileFaces(tile, o = {}, cut = false) {
  const { x, y, s } = tile;
  // the plane or the flight altitude, plus a resting altitude (`floor`: a market candle floats at
  // its price) and any idle-effect lift
  const base = (tile.z ?? 0) + (tile.floor ?? 0) + (tile.fxz ?? 0);
  const top = base + cubeHeight(tile);
  const P = liftProjector(tile, o);

  // A CUBE SHOWS THE SIDES THAT FACE THE CAMERA. The camera is a pinhole over
  // the vanishing point, so a cube's top is pushed outward from it and the
  // side faces turned TOWARD the vanishing point come into view -- up to two
  // of them, none for a cube dead under the camera. A side is drawn when its
  // outward normal on screen points at the vanishing point.
  const topQuad = [P(x, y, top), P(x + s, y, top), P(x + s, y + s, top), P(x, y + s, top)];
  const foot = [P(x, y, base), P(x + s, y, base), P(x + s, y + s, base), P(x, y + s, base)];
  const vx = o.vanishX ?? 0, vy = o.vanishY ?? 0;
  const fcx = (foot[0].x + foot[2].x) / 2, fcy = (foot[0].y + foot[2].y) / 2;
  const sides = [];
  for (const [i, j, key] of [[0, 1, 'near'], [1, 2, 'right'], [2, 3, 'far'], [3, 0, 'left']]) {
    const A = foot[i], B = foot[j];
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    let nx = B.y - A.y, ny = A.x - B.x;
    if ((mx - fcx) * nx + (my - fcy) * ny < 0) { nx = -nx; ny = -ny; }   // make it point outward
    const len = Math.hypot(nx, ny) || 1;
    // A side is seen when the top edge has been displaced AGAINST the side's
    // outward normal -- the face then spans the gap between footprint and top.
    // Under the pinhole that is exactly "faces the vanishing point"; under the
    // oblique camera it is the west and south faces. One rule for both.
    const tmx = (topQuad[i].x + topQuad[j].x) / 2, tmy = (topQuad[i].y + topQuad[j].y) / 2;
    if (nx * (tmx - mx) + ny * (tmy - my) < -1e-9) {
      sides.push({ key, nx: nx / len, ny: ny / len, points: [topQuad[i], topQuad[j], B, A] });
    }
  }
  const out = { top: topQuad, sides, base, topZ: top, P };
  if (!cut) return out;
  const b = blockBevel(s);
  out.bevel = b;
  out.innerG = [[x + b, y + b], [x + s - b, y + b], [x + s - b, y + s - b], [x + b, y + s - b]];
  out.inset = out.innerG.map(([gx, gy]) => P(gx, gy, top));
  return out;
}

// Blend a hex colour toward white by t, alpha riding inside the rgba() --
// never through globalAlpha.
export function lift(hex, t, alpha = 1) {
  const h = String(hex).replace('#', '');
  const ch = (i) => parseInt(h.slice(i, i + 2), 16);
  const m = (v) => Math.max(0, Math.min(255, Math.round(v + (255 - v) * t)));
  return `rgba(${m(ch(0))},${m(ch(2))},${m(ch(4))},${alpha})`;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const flipOf = (o) => (o.flipY === false ? -1 : 1);

// On the curved board each block is lit by the SLOPE of the surface under it
// -- light from the upper left and above -- which is what makes a curve read
// as a curve. 1 on a flat board, so nothing changes when the dome is off.
// WHERE THE LAMP IS (operator, 2026-09-12: "The bottom of the tetrust board is too [dark]. We
// need direct overhead lighting in teh 3d scene for the game" ... "Move the block space light to
// be directly above the board centered ... we should add configurable light locations in
// settings"). Each lamp is a direction over the board for the dome's slope shading (grid x,
// screen-up rows, up) and a direction across the screen for the side faces (x right, y down);
// `overhead` is straight above, so no slope is in shade and every side takes the same light.
export const LIGHTS = Object.freeze({
  'overhead': { L: [0, 0, 1], side: [0, 0] },
  'upper-left': { L: [-0.55, 0.55, 0.63], side: [-0.7071, -0.7071] },
  'upper-right': { L: [0.55, 0.55, 0.63], side: [0.7071, -0.7071] },
  'front': { L: [0, -0.55, 0.63], side: [0, 0.9] },
});
export const LIGHT_DEFAULT = 'upper-left';
const NEON_HEX = /^#[0-9a-f]{6}$/i;
export function lightOf(o = {}) {
  return LIGHTS[o.light] ? o.light : o.overheadLight === true ? 'overhead' : LIGHT_DEFAULT;
}
export function domeLight(t, o = {}) {
  const { dome = 0, gridW = 0, gridH = 0 } = o;
  if (!dome || !gridW || !gridH) return 1;
  const lamp = LIGHTS[lightOf(o)];
  // straight above: the slope shades nothing -- the bottom rows, which lean away from a corner
  // lamp and sat at the 0.6 floor, read as bright as the middle
  if (lamp.L[0] === 0 && lamp.L[1] === 0) return 1;
  const u = (2 * (t.x + t.s / 2)) / gridW - 1, v = (2 * (t.y + t.s / 2)) / gridH - 1;
  const gx = (dome * -2 * u * (1 - v * v) * 2) / gridW;      // dz/dx in grid units
  const gy = (dome * (1 - u * u) * -2 * v * 2) / gridH;      // dz/dy
  const up = o.flipY === false ? -1 : 1;                     // screen-up in grid rows
  const L = [lamp.L[0], lamp.L[1] * up, lamp.L[2]];
  const d = (-gx * L[0] + -gy * L[1] + L[2]) / Math.hypot(gx, gy, 1);
  return Math.max(0.6, Math.min(1.35, d / L[2]));
}

// THE BOARD AT REST (operator, 2026-09-11: "There needs to be an occasional
// energy ripple or other effect that sweeps the grid when the blocks are at
// rest", then "add varied effects. More than a pulse. Maybe add an energy pulse
// that travels along from one side of the board to another via block outlines.
// Be creative and varied"). One effect at a time, chosen by the renderer:
//
//   ripple   a ring of light spreading from a point
//   outline  an energy front crossing the board, lighting each cube's OUTLINE
//            as it passes and leaving a fading trail
//   tide     a wave that LIFTS the cubes as it passes
//   cascade  a gold flash running from the richest transaction to the cheapest
//            -- the effect is also a reading of the fee structure
//   twinkle  scattered cubes glint, each at its own moment
//   scan     a bright line sweeping across the board
//
// fx = { kind, u (progress 0..1), amp (fade in/out), gridW, gridH, dx, dy,
//        rank (cascade), seed (twinkle), x, y, r, w (ripple) }.
// Returns { glow 0..1, outline 0..1, lift (units), color [r,g,b] }. Pure, so it
// is tested directly; only resting blocks are touched.
export const FX_NONE = Object.freeze({ glow: 0, outline: 0, lift: 0, color: null });

// where a sweeping front is, along (dx, dy), in grid units -- entering from
// just outside one side of the board and leaving past the other
export function fxFront(fx) {
  const qs = [0, fx.gridW * fx.dx, fx.gridH * fx.dy, fx.gridW * fx.dx + fx.gridH * fx.dy];
  const lo = Math.min(...qs) - 4, hi = Math.max(...qs) + 4;
  return lo + fx.u * (hi - lo);
}

// a deterministic 0..1 from an integer: where a firework bursts, which cube flares. Hashed, not
// random, so an effect draws the same picture every time it replays -- which is what lets the
// tests above assert on it at all.
export function fxHash(n) {
  const x = Math.sin((n | 0) * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function fxAt(t, fx) {
  if (!fx) return FX_NONE;
  const A = fx.amp ?? 1;
  const cx = t.x + t.s / 2, cy = t.y + t.s / 2;
  const g = (k) => Math.exp(-k * k);
  const along = () => cx * fx.dx + cy * fx.dy;
  switch (fx.kind) {
    case 'ripple': {
      const k = (Math.hypot(cx - fx.x, cy - fx.y) - fx.r) / Math.max(0.5, fx.w);
      return { glow: A * g(k), outline: 0.6 * A * g(k), lift: 0, color: [120, 255, 210] };
    }
    case 'outline': {
      const q = along(), p = fxFront(fx);
      const lead = g((q - p) / 3);
      const trail = q < p ? 0.6 * Math.exp(-(p - q) / 9) : 0;
      return { glow: 0.45 * A * lead, outline: A * Math.min(1, lead + trail), lift: 0, color: [90, 230, 255] };
    }
    case 'tide': {
      const w = g((along() - fxFront(fx)) / 3.2);
      return { glow: 0.6 * A * w, outline: 0.35 * A * w, lift: 2.2 * A * w, color: [140, 255, 180] };
    }
    case 'cascade': {
      const r = fx.rank?.get(t.txid);
      if (r == null) return FX_NONE;
      const w = g((r - (fx.u * 1.25 - 0.1)) / 0.12);
      return { glow: A * w, outline: 0.9 * A * w, lift: 0.6 * A * w, color: [255, 214, 120] };
    }
    case 'twinkle': {
      if (jitterOf(t.txid, 'tw' + fx.seed) > 0.45) return FX_NONE;
      const w = g((fx.u - 0.05 - jitterOf(t.txid, 'tt' + fx.seed) * 0.85) / 0.05);
      return { glow: A * w, outline: 0.8 * A * w, lift: 0, color: [255, 255, 255] };
    }
    case 'scan': {
      const w = g((along() - fxFront(fx)) / 1.6);
      return { glow: 0.8 * A * w, outline: 0.5 * A * w, lift: 0, color: [120, 220, 255] };
    }
    case 'ball': {
      // "illuminating everything it comes near": brightest right under the ball, gone ~5 units off
      const b = fx.ball;
      if (!b) return FX_NONE;
      const ddx = Math.max(t.x - b.x, 0, b.x - (t.x + t.s)), ddy = Math.max(t.y - b.y, 0, b.y - (t.y + t.s));
      const w = g(Math.hypot(ddx, ddy) / 2.6);
      return w > 0.02 ? { glow: 0.95 * w, outline: 0.9 * w, lift: 0, color: [170, 225, 255] } : FX_NONE;
    }
    // ---------------------------------------------------------------------------------------
    // THE ARCADE (operator, 2026-09-12: "Think of many more other video-game inspired effects ...
    // at least 25 total different effects, all toggleable"). Every one below is a PURE function of
    // the tile and the effect's clock -- no state is kept, nothing is allocated per frame, and the
    // board-level choices (where a firework bursts, which tile flares) are hashed out of fx.seed,
    // so an effect replays identically and can be asserted here rather than watched.
    //
    // `reach` is the distance from the effect's origin to the farthest corner: a radial effect
    // that covers the board in the time it is given, whatever the board's shape.
    case 'shockwave': {
      // Smash-style: a hard ring that throws the cubes it passes UP, not a soft glow
      const reach = Math.hypot(Math.max(fx.x, fx.gridW - fx.x), Math.max(fx.y, fx.gridH - fx.y));
      const r = reach * (1 - Math.pow(1 - fx.u, 1.7));
      const k = (Math.hypot(cx - fx.x, cy - fx.y) - r) / 1.7;
      const w = g(k);
      return { glow: 0.85 * A * w, outline: A * w, lift: 4.5 * A * w, color: [255, 240, 190] };
    }
    case 'nova': {
      // an implosion that snaps back out: the ring races IN to the middle over the first half,
      // then out again, brighter and whiter, over the second
      const reach = Math.hypot(Math.max(fx.x, fx.gridW - fx.x), Math.max(fx.y, fx.gridH - fx.y));
      const inward = fx.u < 0.5;
      const v = inward ? fx.u / 0.5 : (fx.u - 0.5) / 0.5;
      const r = inward ? reach * (1 - Math.pow(v, 0.7)) : reach * Math.pow(v, 0.6);
      const w = g((Math.hypot(cx - fx.x, cy - fx.y) - r) / (inward ? 2.2 : 1.5));
      const hot = inward ? 0.55 : 1;
      return { glow: hot * A * w, outline: 0.8 * hot * A * w, lift: (inward ? 0.4 : 3.2) * A * w,
        color: inward ? [150, 190, 255] : [255, 255, 245] };
    }
    case 'firework': {
      // three bursts, each at its own moment and place, each a ring that expands and dies
      let glow = 0, outline = 0, lift = 0, col = [255, 200, 120];
      for (let i = 0; i < 3; i++) {
        const t0 = 0.05 + 0.26 * i, life = 0.45;
        const v = (fx.u - t0) / life;
        if (!(v > 0 && v < 1)) continue;
        const bx = fxHash(fx.seed + i * 31 + 1) * fx.gridW, by = fxHash(fx.seed + i * 31 + 2) * fx.gridH;
        const r = 9 * Math.pow(v, 0.55);
        const w = g((Math.hypot(cx - bx, cy - by) - r) / 1.4) * (1 - v);
        if (w > glow) {
          glow = w; outline = 0.9 * w; lift = 1.8 * w;
          col = [[255, 170, 110], [140, 220, 255], [220, 160, 255]][i];
        }
      }
      return glow > 0.02 ? { glow: A * glow, outline: A * outline, lift: A * lift, color: col } : FX_NONE;
    }
    case 'flare': {
      // one cube goes supernova and lights its neighbourhood -- the same hashed cube every replay
      const fxp = fxHash(fx.seed + 7) * fx.gridW, fyp = fxHash(fx.seed + 8) * fx.gridH;
      const bell = Math.sin(Math.PI * fx.u);
      const d = Math.hypot(cx - fxp, cy - fyp);
      const w = g(d / (1.2 + 7 * bell)) * bell;
      return w > 0.02 ? { glow: A * w, outline: 0.8 * A * w, lift: 1.4 * A * w, color: [255, 245, 205] } : FX_NONE;
    }
    case 'wave': {
      // a swell rolling across the board: the cubes rise and fall with it, several crests at once
      const d = along() - fxFront(fx);
      const env = g(d / 7);
      const phase = Math.sin(d * 0.75);
      const up = Math.max(0, phase);
      return { glow: 0.45 * A * env * up, outline: 0.3 * A * env * up, lift: 3 * A * env * up, color: [120, 200, 255] };
    }
    case 'quake': {
      // the board shakes: every cube jumps on its own beat, hardest at the start, dying out
      const decay = Math.pow(1 - fx.u, 2);
      const j = jitterOf(t.txid, 'qk' + fx.seed);
      const shake = Math.sin(fx.u * 60 + j * 6.28);
      const up = Math.max(0, shake) * decay;
      return { glow: 0.3 * A * up, outline: 0.5 * A * up, lift: 2.4 * A * up, color: [255, 180, 140] };
    }
    case 'rain': {
      // code rain: each column has its own drop, falling from the top of the board to the floor,
      // with a white head and a fading green tail behind it
      const col = Math.floor(cx);
      const ph = fxHash(fx.seed + col * 17);
      const head = fx.gridH + 3 - (fx.u * 1.35 - ph * 0.35) * (fx.gridH + 8);
      const d = cy - head;                                  // above the head: the tail
      if (d < -1.2) return FX_NONE;
      const w = d < 1.2 ? 1 : Math.exp(-(d - 1.2) / 3.5);
      const white = d < 1.2 ? 1 : 0;
      return { glow: A * w, outline: 0.7 * A * w, lift: 0,
        color: white ? [225, 255, 235] : [60, 235, 140] };
    }
    case 'sparkle': {
      // a constellation lighting up a few cubes at a time, each in its own colour
      const pick = jitterOf(t.txid, 'sp' + fx.seed);
      if (pick > 0.3) return FX_NONE;
      const when = jitterOf(t.txid, 'st' + fx.seed);
      const w = g((fx.u - 0.08 - when * 0.8) / 0.07);
      const hue = jitterOf(t.txid, 'sc' + fx.seed);
      const col = hue < 0.34 ? [255, 230, 160] : hue < 0.67 ? [170, 220, 255] : [235, 175, 255];
      return { glow: A * w, outline: 0.85 * A * w, lift: 0.5 * A * w, color: col };
    }
    case 'checker': {
      // the board flips like a chessboard: black squares up while white squares are down
      const dark = (Math.floor(cx) + Math.floor(cy)) & 1;
      const beat = Math.sin(fx.u * Math.PI * 4 + (dark ? Math.PI : 0));
      const up = Math.max(0, beat) * Math.sin(Math.PI * fx.u);
      // (the first cut peaked at 0.26 of full brightness -- a flip nobody would notice across a
      // board of small cubes; the squares have to actually read as lifting against each other)
      return { glow: 0.85 * A * up, outline: 0.75 * A * up, lift: 2.8 * A * up,
        color: dark ? [140, 255, 210] : [255, 210, 130] };
    }
    case 'radar': {
      // a sweep hand turning once round the board, the cubes behind it fading like phosphor
      const ang = Math.atan2(cy - fx.y, cx - fx.x);
      const hand = -Math.PI + fx.u * Math.PI * 2;
      let d = ang - hand;
      while (d < 0) d += Math.PI * 2;                       // 0 at the hand, 2pi just before it
      const w = d < 0.18 ? 1 : Math.exp(-(d - 0.18) * 1.6);
      return { glow: 0.8 * A * w, outline: 0.5 * A * w, lift: 0, color: [110, 255, 170] };
    }
    case 'vortex': {
      // the radar's hand, wound into a spiral: the arms turn and the whole board drains inward
      const ang = Math.atan2(cy - fx.y, cx - fx.x);
      const rad = Math.hypot(cy - fx.y, cx - fx.x);
      const arm = ang + rad * 0.42 - fx.u * Math.PI * 4;
      const d = Math.abs(((arm % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
      const w = g((Math.PI - d) / 0.55) * Math.sin(Math.PI * fx.u);
      return { glow: 0.9 * A * w, outline: 0.6 * A * w, lift: 1.2 * A * w, color: [165, 150, 255] };
    }
    case 'laser': {
      // a cutting beam: a hard white line with a thin coloured bloom, crossing in one pass
      const d = along() - fxFront(fx);
      const core = g(d / 0.55), bloom = g(d / 2.6);
      return { glow: A * Math.min(1, core + 0.35 * bloom), outline: A * core, lift: 0,
        color: core > 0.35 ? [255, 255, 255] : [255, 90, 120] };
    }
    case 'powerup': {
      // the board charges from the floor up, gold, with a bright lip at the top of the fill
      const fill = fx.u * (fx.gridH + 4) - 2;
      const below = fill - cy;
      if (below < -1) return FX_NONE;
      const lip = g(below / 1.1);
      const held = below > 0 ? Math.min(0.55, 0.55 * Math.pow(1 - fx.u, 0.6)) : 0;
      const w = Math.min(1, lip + held);
      return { glow: A * w, outline: A * lip, lift: 1.6 * A * lip,
        color: lip > 0.4 ? [255, 250, 220] : [255, 200, 90] };
    }
    case 'combo': {
      // a chain reaction running the diagonal, each link popping as it is reached
      const q = (cx + cy) / (fx.gridW + fx.gridH);
      const v = fx.u * 1.2 - 0.1;
      const w = g((q - v) / 0.05);
      const step = Math.floor(q * 12);
      const col = [[255, 120, 90], [255, 190, 80], [120, 255, 160], [110, 200, 255]][step & 3];
      return { glow: A * w, outline: A * w, lift: 2.2 * A * w, color: col };
    }
    case 'aurora': {
      // slow curtains of colour drifting over the board, brightest where they fold
      const band = Math.sin(cx * 0.24 + fx.u * 5) + Math.sin(cy * 0.17 - fx.u * 3.4);
      const w = Math.max(0, band) * 0.5 * Math.sin(Math.PI * fx.u);
      const mix = (band + 2) / 4;
      const col = [Math.round(80 + 60 * mix), Math.round(200 + 40 * mix), Math.round(255 - 70 * mix)];
      return { glow: 0.8 * A * w, outline: 0.25 * A * w, lift: 0.8 * A * w, color: col };
    }
    case 'plasma': {
      // the demoscene plasma: three sines over the board, the colour cycling with the clock
      const v = Math.sin(cx * 0.32) + Math.sin(cy * 0.29) + Math.sin((cx + cy) * 0.19 + fx.u * 7);
      const w = Math.max(0, v / 3) * Math.sin(Math.PI * fx.u);
      const ph = (v + 3) / 6;
      const col = [Math.round(140 + 115 * ph), Math.round(90 + 140 * (1 - ph)), Math.round(190 + 60 * ph)];
      return { glow: 0.85 * A * w, outline: 0.2 * A * w, lift: 0, color: col };
    }
    case 'glitch': {
      // data corruption: a different handful of cubes tears every eighth of the effect, hard on
      // and hard off -- no easing, because a glitch that fades in is not a glitch
      const frame = Math.floor(fx.u * 9);
      const pick = jitterOf(t.txid, 'gl' + fx.seed + ':' + frame);
      if (pick > 0.13) return FX_NONE;
      const hard = pick < 0.05;
      return { glow: A * (hard ? 1 : 0.6), outline: A, lift: hard ? 1.2 * A : 0,
        color: hard ? [255, 60, 210] : [70, 255, 245] };
    }
    case 'lightcycle':
    case 'packets': {
      // the cubes a head is riding over flash in its colour (see cyclePath)
      let best = FX_NONE, bw = 0;
      for (const hd of fx.heads ?? []) {
        const ddx = Math.max(t.x - hd.x, 0, hd.x - (t.x + t.s)), ddy = Math.max(t.y - hd.y, 0, hd.y - (t.y + t.s));
        const w = (hd.alpha ?? 1) * g(Math.hypot(ddx, ddy) / 0.8);
        if (w > bw && w > 0.02) { bw = w; best = { glow: 0.85 * w, outline: 0.8 * w, lift: 0, color: hd.color }; }
      }
      return best;
    }
    default: return FX_NONE;
  }
}

// --- the scene ---------------------------------------------------------
//
// Level of detail: `facetMinUnits` (frame + face) and `crownMinUnits` (gloss,
// sheen, rim) are grid-unit sides below which a block is drawn plainer. The
// renderer derives both from the constant board transform, so a block's detail
// cannot change between frames.
//
// SHADOWS FROM ABOVE (operator: "consider casting shadows from above on the
// movements"). Every airborne block casts a soft shadow straight down onto
// the plane at its TRUE footprint -- not where the gathered, swollen block is
// drawn -- so the shadow says which slot a block is over. The umbra is dark
// and tight just above the plane and spreads and pales as the block climbs;
// an arrival's shadow therefore sharpens on the very slot it is about to hit.
// Shadows paint after every resting block and before every airborne one:
// they fall ON the board, and under what casts them.
//
// Fades carry into the outline. The seam used to be stroked in one fixed
// colour whatever the tile's alpha, so a departing block's fill faded while
// its black frame stayed at full strength until the tile was dropped (operator:
// "the black outlines for disappearing blocks do not fade out"). The stroke
// now travels on the op as rgba scaled by the same alpha.
// THE DENSE BOARD'S ORDER (Viewer Mode 2): thousands of low slabs whose footprints never overlap.
// Under the oblique camera a slab's height leans up and to the right, so it can only cover what
// lies further along that diagonal: resting slabs paint from the far corner in, the airborne
// after them, lowest first. Linear-log where obliqueOrder's pairwise tests are quadratic -- at
// 4,000 transactions that is the difference between a frame and a stall.
export function diagonalOrder(tiles) {
  return tiles.map((t) => ({ t, air: (t.z ?? 0) > 0.02 ? 1 : 0, z: t.z ?? 0, d: t.x + t.y + t.s }))
    .sort((p, q) => (p.air - q.air) || (p.air ? p.z - q.z : 0) || (q.d - p.d) || String(p.t.txid).localeCompare(String(q.t.txid)))
    .map((e) => e.t);
}

export function buildScene(tiles, o = {}) {
  // the oblique camera never swells a block, so there is no growth to police
  const growth = o.oblique ? new Map() : settleGrowth(tiles, o);
  // PAINT ORDER FOR CUBES: seen from above, a higher surface is nearer the
  // camera, so blocks paint by the height of their TOP, lowest first, and
  // among equals the one further from the vanishing point first (its sides
  // lean outward, away from its nearer neighbours).
  const vx0 = o.vanishX ?? 0, vy0 = o.vanishY ?? 0;
  const ordered = o.oblique && o.order === 'diagonal' ? diagonalOrder(tiles) : o.oblique ? obliqueOrder(tiles, o) : tiles.map((t) => (growth.has(t) ? { ...t, boost: growth.get(t) } : t))
    .map((t) => { const c = project(t.x + t.s / 2, t.y + t.s / 2, 0, o); return { t, top: (t.z ?? 0) + (t.floor ?? 0) + cubeHeight(t), d: Math.hypot(c.x - vx0, c.y - vy0) }; })
    // Under the oblique camera a cube reaches up and to the right of its
    // footprint, so it can only cover blocks further up-right: paint along the
    // diagonal from the far corner, the airborne after the resting and lowest
    // first. A fixed order -- nothing flips as blocks rise and fall past each
    // other at nearly the same height, which was the "z-fighting".
    .sort((p, q) => (p.top - q.top) || (q.d - p.d) || String(p.t.txid).localeCompare(String(q.t.txid)))
    .map((e) => e.t);
  const ground = [];
  const air = [];
  const shadows = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const note = (p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };
  const facetMin = o.facetMinUnits ?? 0;
  const crownMin = o.crownMinUnits ?? 0;
  const seam = o.seamAlpha ?? 0.35;
  // LIT FROM THE VIEWER (the Markets board; operator, 2026-09-11: "move the lighting to the viewer
  // position for the market view. I want everything bright and clear on the faces"). The light
  // sits at the camera: the faces turned toward it are the brightest, the edges are drawn light
  // instead of dark, the cell bevel (made for a light from the upper left) is left off, and
  // nothing casts a shadow -- a shadow from a light at the eye falls behind what casts it.
  const viewerLit = o.light === 'viewer';
  // ...then "offset the light at 45 degrees to the right so older stuff gets dimmer": the lamp
  // stands to the front-right, so a face turned left falls toward shadow, and the light reaching
  // a cube falls off leftward across the board -- the newest hours (on the right) brightest,
  // the oldest at half
  const reachOf = (t) => (viewerLit && o.gridW ? 0.5 + 0.5 * Math.min(1, Math.max(0, (t.x + t.s / 2) / o.gridW)) : 1);
  const flip = flipOf(o);
  // CUBES SHADOW CUBES (operator, 2026-09-11: "can we get the cubes casting shadows
  // against other cubes during movement?"). A cube in flight throws its shadow
  // straight down -- the same light as its floor shadow -- onto the TOP of every cube
  // beneath it: the overlap of its footprint (a penumbra and a core) with that cube's
  // top square, a rectangle in grid space, so a plain rgba quad and no clip. It is
  // drawn straight after the lower cube's own faces, so everything nearer -- the flyer
  // included -- paints over it. Darker the nearer the flyer, and fading exactly as
  // its floor shadow does: across the last 1.5 units of a landing, and with it as it
  // flies off (or falls in from) off screen.
  const casters = o.shadows !== false && o.oblique && !viewerLit && o.order !== 'diagonal' ? tiles.filter((c) => (c.z ?? 0) > 0.02).map((c) => ({
    c, x0: c.x, y0: c.y, x1: c.x + c.s, y1: c.y + c.s, z0: c.z,
    k: (c.alpha ?? 1) * Math.min(1, c.z / 1.5) * (1 - (c.entry ?? 0)),
  })).filter((e) => e.k > 0.01) : [];
  // the lamp's direction across the screen, for the side faces (LIGHTS); under the overhead
  // lamp every side takes the same light, a shade under the top
  const lampSide = LIGHTS[lightOf(o)].side;
  for (const t of ordered) {
    const fxv = (t.z ?? 0) > 0.02 ? FX_NONE : fxAt(t, o.fx);
    // NEON is a flat cube: no facets, no crown -- solid faces and the tubes on their edges
    const f = tileFaces(fxv.lift > 0.001 ? { ...t, fxz: fxv.lift } : t, o, t.s >= facetMin && o.neon !== true);
    const a = t.alpha ?? 1;
    const airborne = (t.z ?? 0) > 0.02;
    const out = airborne && !o.oblique ? air : ground;
    // A tile that just locked flashes brighter for a moment -- the Tetris
    // lock, and the only cue that says "this one just arrived".
    const lock = t.lock ?? 0;
    // an idle effect (see fxAt) lights the cubes it passes
    const pulse = fxv.glow;
    // the pointer's glow (details3d setHover): lit up, outlined, fading when released
    const hover = o.hoverGlow?.get(t.txid) ?? 0;
    // NEON (o.neon, below) is a dim SOLID body in the block's own colour under bright tubes: the
    // faces keep their hue -- the feerate -- at a constant half light, no dome or lamp shading
    // (2026-09-12: the first cut dimmed the lit shading and the faces went near black, "don't
    // have any suitable color fill for their temperature. Need solid dim neon colored faces")
    const lit = o.neon === true
      ? 0.55 * (1 + 0.55 * lock + 0.45 * pulse + 0.6 * hover)
      : (1 + 0.55 * lock + 0.45 * pulse + 0.6 * hover) * domeLight(t, o) * reachOf(t);
    const c = t.color;
    // A WIREFRAME (Tetrust's ghost, operator 2026-09-12: "wireframes on teh bottom of the tetrust
    // playfield ... The solid dark colored stuff is too difficult to see"): the cube's
    // outline in `t.wire` and nothing else -- no fill, so what is behind shows through, and a wide
    // faint halo under a bright line so it reads as a lit tube. `always`: the seam switch (Stone
    // edges) does not govern it, the outline IS the tile.
    if (t.wire) {
      const halo = lift(t.wire, 0.2, round3(0.3 * a)), tube = lift(t.wire, 0.1, round3(0.98 * a));
      for (const poly of [...f.sides.map((sd) => sd.points), f.top]) {
        out.push({ txid: t.txid, face: 'wire', points: poly, fill: 'rgba(0,0,0,0)', stroke: halo, lw: 9, always: true });
        out.push({ txid: t.txid, face: 'wire', points: poly, fill: 'rgba(0,0,0,0)', stroke: tube, lw: 3, always: true });
        poly.forEach(note);
      }
      continue;
    }
    // A BALL, NOT A BLOCK (operator, 2026-09-12: "Can we have a ball for blockout instead of a
    // block for the bouncing dot?"). An op is a filled polygon -- there are no arcs in the format,
    // and gradients and shadows are forbidden here (see the rules at the head of details3d.js) --
    // so a sphere is three nested many-sided discs: a dark rim, the body, and a highlight offset
    // toward the light. At the size a ball is actually drawn, 24 sides is a circle.
    if (t.sphere) {
      const bcx = t.x + t.s / 2, bcy = t.y + t.s / 2;
      const zc = (t.z ?? 0) + (t.floor ?? 0) + cubeHeight(t) / 2;
      const mid = f.P(bcx, bcy, zc);
      const rim = f.P(bcx + t.s / 2, bcy, zc);
      const R = Math.hypot(rim.x - mid.x, rim.y - mid.y) || 1;
      const disc = (r, dx, dy, fill) => {
        const pts = [];
        for (let i = 0; i < 24; i++) {
          const ang = (i / 24) * Math.PI * 2;
          pts.push({ x: mid.x + dx + Math.cos(ang) * r, y: mid.y + dy + Math.sin(ang) * r });
        }
        out.push({ txid: t.txid, face: 'ball', points: pts, fill });
        return pts;
      };
      disc(R, 0, 0, shade(c, 0.5 * lit, a)).forEach(note);
      disc(R * 0.84, -R * 0.08, -R * 0.1, shade(c, 1.0 * lit, a));
      disc(R * 0.4, -R * 0.24, -R * 0.28, lift(c, 0.7, a));
      continue;
    }
    for (const side of f.sides) {
      // lit from the upper left of the screen: a side turned that way is
      // brighter, one turned away falls into shadow
      const d = side.nx * lampSide[0] + side.ny * lampSide[1];
      // from the viewer: a face pointing down the screen (toward the camera) takes the most light
      const k = viewerLit ? 0.6 + 0.42 * Math.max(0, side.ny) + 0.3 * Math.max(0, side.nx) - 0.16 * Math.max(0, -side.nx) : 0.34 + 0.26 * (d + 1);
      out.push({ txid: t.txid, face: 'side', key: side.key, points: side.points, fill: shade(c, k * lit, a), ...(viewerLit ? { stroke: lift(c, 0.45, round3(0.5 * a)) } : {}) });
      side.points.forEach(note);
    }
    out.push({ txid: t.txid, face: 'top', points: f.top, fill: shade(c, (viewerLit ? 1.02 : 0.8) * lit, a), stroke: viewerLit ? lift(c, 0.55, round3(0.6 * a)) : `rgba(0,0,0,${round3(seam * a)})` });
    f.top.forEach(note);

    if (f.innerG && !viewerLit) {
      const [BL, BR, TR, TL] = f.top;
      const [bl, br, tr, tl] = f.inset;
      // the screen-top edge is row y+s with the rows flipped, row y without
      const farE = flip > 0 ? [TL, TR, tr, tl] : [BL, BR, br, bl];
      const nearE = flip > 0 ? [BR, BL, bl, br] : [TR, TL, tl, tr];
      out.push({ txid: t.txid, face: 'bevel', points: farE, fill: lift(c, 0.5 + 0.3 * lock, a) });
      out.push({ txid: t.txid, face: 'bevel', points: [BL, TL, tl, bl], fill: lift(c, 0.2 + 0.3 * lock, a) });
      out.push({ txid: t.txid, face: 'bevel', points: [TR, BR, br, tr], fill: shade(c, 0.62 * lit, a) });
      out.push({ txid: t.txid, face: 'bevel', points: nearE, fill: shade(c, 0.4 * lit, a) });
      out.push({ txid: t.txid, face: 'face', points: f.inset, fill: shade(c, lit, a) });
      if (t.s >= crownMin) {
        const w = t.s - 2 * f.bevel;
        const x0 = t.x + f.bevel;
        const at = ([p, q]) => f.P(x0 + p * w, flip > 0 ? (t.y + t.s - f.bevel - q * w) : (t.y + f.bevel + q * w), f.topZ);
        // the well: its lip at 20% in from the face's edge, its floor at 30%,
        // in (p, q) face coordinates with q running DOWN the screen
        const E = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]].map(at);   // lip: TL, TR, BR, BL on screen
        const F = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]].map(at);   // floor
        out.push({ txid: t.txid, face: 'wall', points: [E[0], E[1], F[1], F[0]], fill: shade(c, 0.5 * lit, a) });
        out.push({ txid: t.txid, face: 'wall', points: [E[3], E[0], F[0], F[3]], fill: shade(c, 0.66 * lit, a) });
        out.push({ txid: t.txid, face: 'wall', points: [E[1], E[2], F[2], F[1]], fill: lift(c, 0.16 + 0.3 * lock, a) });
        out.push({ txid: t.txid, face: 'wall', points: [E[2], E[3], F[3], F[2]], fill: lift(c, 0.34 + 0.3 * lock, a) });
        out.push({ txid: t.txid, face: 'floor', points: F, fill: shade(c, 0.84 * lit, a) });
        out.push({ txid: t.txid, face: 'rim', points: E, fill: 'rgba(0,0,0,0)', stroke: lift(c, 0.7, round3(0.7 * a)) });
      }
    }
    // THE FINISH (operator, 2026-09-12: "consider neon-izing each of teh blocks, and adding an
    // optional specular metallic sheen to the blocks. Have it toggle. I want to be able to apply
    // the sheen onto simple cube mode if I want"). Both are laid over the top face every tile
    // has, so they work at every level of detail. What was tried and rejected before is recorded
    // at the head of this section -- diagonal streaks -- and neither of these is a streak.
    if (o.sheen === true) {
      // a specular band hugging the LIT edge of the top: the far edge under the upper-left lamp,
      // the near edge when the light sits at the viewer. Two nested bands, the inner one hotter:
      // a metallic gleam along an edge, not a gloss stripe across the face.
      const [BL, BR, TR, TL] = f.top;
      const litFar = !viewerLit;
      const e0 = litFar ? (flip > 0 ? TL : BL) : (flip > 0 ? BL : TL);
      const e1 = litFar ? (flip > 0 ? TR : BR) : (flip > 0 ? BR : TR);
      const o0 = litFar ? (flip > 0 ? BL : TL) : (flip > 0 ? TL : BL);
      const o1 = litFar ? (flip > 0 ? BR : TR) : (flip > 0 ? TR : BR);
      const L = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
      const band = (k) => [e0, e1, L(e1, o1, k), L(e0, o0, k)];
      // A RAMP, NOT STEPS (2026-09-12, operator: "we need more specular on the metallic sheen, and
      // have the gradient be less coarse"). The first cut was two bands, the second three, and three
      // wide bands read as three stripes because that is what they are.
      //
      // The bands are NESTED and all anchored on the lit edge, so drawing them widest-first lets
      // each narrower one lay over the last and the alpha ACCUMULATE toward the edge: n translucent
      // quads are an n-step ramp, and the fineness of the gradient is just n. Each step is kept
      // under a tenth of full opacity so no single one of them can be seen as an edge. (A real
      // canvas gradient is not forbidden here -- the rules ban clip, globalAlpha, composite modes
      // and shadowBlur, not gradients -- but an op's `fill` is a plain rgba STRING that paintFrame
      // assigns straight to fillStyle, and which the recording-canvas tests read; a CanvasGradient
      // would need a new op shape and would blind them. Layered fills are the house idiom.)
      const SHEEN_STEPS = 14;
      for (let k = 0; k < SHEEN_STEPS; k++) {
        const t2 = 1 - k / SHEEN_STEPS;                 // 1 (widest) down to one step's width
        const w = 0.5 * Math.pow(t2, 1.5);              // bunched toward the lit edge
        const hot = 1 - t2;                             // 0 at the sheen's inner edge, 1 at the lit one
        out.push({ txid: t.txid, face: 'sheen', points: band(w),
          fill: lift(c, 0.4 + 0.55 * hot, round3((0.03 + 0.075 * Math.pow(hot, 1.8)) * a)) });
      }
      // THE SPECULAR ITSELF: a tight near-white sliver right on the edge, which is the part that
      // reads as polished metal rather than as a lit surface
      out.push({ txid: t.txid, face: 'sheen', points: band(0.055), fill: `rgba(255,255,255,${round3(0.9 * a)})` });
      out.push({ txid: t.txid, face: 'sheen', points: band(0.022), fill: `rgba(255,255,255,${round3(0.96 * a)})` });
      // and the roll-off into shadow on the far edge, graded the same way
      const dark = (k) => [o0, o1, L(o1, e1, k), L(o0, e0, k)];
      const DARK_STEPS = 8;
      for (let k = 0; k < DARK_STEPS; k++) {
        const t2 = 1 - k / DARK_STEPS;
        const w = 0.34 * Math.pow(t2, 1.4);
        const deep = 1 - t2;
        out.push({ txid: t.txid, face: 'sheen', points: dark(w), fill: `rgba(0,0,0,${round3((0.035 + 0.06 * deep) * a)})` });
      }
      for (const side of f.sides) {
        // the side turned to the lamp carries the same ramp up its outer edge
        const d = viewerLit ? Math.max(0, side.ny) : Math.max(0, side.nx * lampSide[0] + side.ny * lampSide[1]);
        if (d < 0.3) continue;
        const [p0, p1, p2, p3] = side.points;
        const SIDE_STEPS = 6;
        for (let k = 0; k < SIDE_STEPS; k++) {
          const t2 = 1 - k / SIDE_STEPS;
          const w = 0.32 * Math.pow(t2, 1.4);
          const hot = 1 - t2;
          out.push({ txid: t.txid, face: 'sheen', points: [p0, L(p0, p1, w), L(p3, p2, w), p3],
            fill: lift(c, 0.55 + 0.4 * hot, round3((0.05 + 0.12 * hot) * d * a)) });
        }
      }
    }
    if (o.neon === true) {
      // every edge the camera sees, stroked in the block's own colour lit up: a wide faint halo
      // under a thin bright line, the way a neon tube reads. `always`: drawn even with the dark
      // seam (Stone edges) switched off, because it is the seam's replacement, not its companion.
      // (2026-09-12, second cut: the first stroked a 1.4 x tube over a 0.6-pixel base line --
      // under a pixel, and half of it under the next cube's fill -- "I don't see neon blocks
      // working". `lw` multiplies paintFrame's base width, so these are device pixels x 1.7.)
      // tuned (settings.js neonSource / neonColour / neonBrightness): the tube in the block's own
      // colour or one chosen colour, glowing as hard as asked -- brightness into alpha and width
      const nc = o.neonSource === 'colour' && NEON_HEX.test(o.neonColour || '') ? o.neonColour : c;
      const nb = Math.max(0.2, Math.min(2, Number(o.neonBrightness) || 1));
      const halo = lift(nc, 0.25, round3(Math.min(1, 0.3 * nb) * a)), tube = lift(nc, 0.3, round3(Math.min(1, nb) * a)), core = lift(nc, 0.75, round3(Math.min(1, 0.7 * nb) * a));   // the tube keeps the hue; only the thin core goes toward white
      for (const poly of [f.top, ...f.sides.map((sd) => sd.points)]) {
        out.push({ txid: t.txid, face: 'neon', points: poly, fill: 'rgba(0,0,0,0)', stroke: halo, lw: round3(11 * (0.6 + 0.4 * nb)), always: true });
        out.push({ txid: t.txid, face: 'neon', points: poly, fill: 'rgba(0,0,0,0)', stroke: tube, lw: round3(4 * (0.7 + 0.3 * nb)), always: true });
        out.push({ txid: t.txid, face: 'neon', points: poly, fill: 'rgba(0,0,0,0)', stroke: core, lw: 1.6, always: true });
      }
    }
    // the lock: the whole cell flashes white for a moment, then settles
    if (pulse > 0.03) out.push({ txid: t.txid, face: 'glow', points: f.top, fill: `rgba(${fxv.color.join(',')},${round3(0.5 * pulse * a)})` });
    if (fxv.outline > 0.03) {
      const col = fxv.color.join(',');
      out.push({ txid: t.txid, face: 'outline', points: f.top, fill: 'rgba(0,0,0,0)', stroke: `rgba(${col},${round3(0.95 * fxv.outline * a)})`, lw: 1 + 4 * fxv.outline });
      // and round the sides the camera sees, so the whole cube is traced
      if (fxv.outline > 0.15) for (const side of f.sides) {
        out.push({ txid: t.txid, face: 'outline', points: side.points, fill: 'rgba(0,0,0,0)', stroke: `rgba(${col},${round3(0.7 * fxv.outline * a)})`, lw: 1 + 2 * fxv.outline });
      }
    }
    if (hover > 0.01) {
      out.push({ txid: t.txid, face: 'glow', points: f.top, fill: `rgba(215,255,235,${round3(0.38 * hover * a)})` });
      out.push({ txid: t.txid, face: 'outline', points: f.top, fill: 'rgba(0,0,0,0)', stroke: `rgba(175,255,225,${round3(0.95 * hover * a)})`, lw: 1 + 3 * hover });
      for (const side of f.sides) out.push({ txid: t.txid, face: 'outline', points: side.points, fill: 'rgba(0,0,0,0)', stroke: `rgba(175,255,225,${round3(0.7 * hover * a)})`, lw: 1 + 2 * hover });
    }
    if (lock > 0.02) out.push({ txid: t.txid, face: 'flash', points: f.top, fill: `rgba(255,255,255,${round3(0.18 * lock * a)})` });
    if (casters.length) {
      const bTop = (t.z ?? 0) + (t.floor ?? 0) + cubeHeight(t) + (fxv.lift > 0.001 ? fxv.lift : 0);
      for (const e of casters) {
        if (e.c === t) continue;
        const gap = e.z0 - bTop;
        if (gap < -1e-6) continue;                      // only onto cubes whose top it is above
        for (const [grow, share] of [[Math.min(1.2, 0.1 + gap * 0.06), 0.16], [0, 0.34]]) {
          const x0 = Math.max(t.x, e.x0 - grow), x1 = Math.min(t.x + t.s, e.x1 + grow);
          const y0 = Math.max(t.y, e.y0 - grow), y1 = Math.min(t.y + t.s, e.y1 + grow);
          if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) continue;
          const dk = share * e.k * Math.min(1, 1.6 / (1 + gap * 0.05));
          if (dk < 0.01) continue;
          out.push({ txid: t.txid, face: 'cast', points: [f.P(x0, y0, f.topZ), f.P(x1, y0, f.topZ), f.P(x1, y1, f.topZ), f.P(x0, y1, f.topZ)], fill: `rgba(0,0,0,${round3(dk)})` });
        }
      }
    }
    // SHADOWS FADE, THEY DO NOT SWITCH (operator, 2026-09-11: "the shadows just
    // disappear. they need to fade out"). A departure kept a full shadow on its
    // slot until the frame it was gone, and lift-off and touchdown swapped one
    // shadow for another. Under the oblique camera the resting shadow now
    // fades out over the first 1.5 units of a lift (and in over the last 1.5
    // of a landing), the flight shadow fades in and out across the same band,
    // and a block flying off screen -- or falling in from it -- takes its
    // shadow with it as it goes: (1 - entry).
    const zt = t.z ?? 0;
    // SHADOWS ARE OPTIONAL (operator, 2026-09-12: "remove shadows ... anything to make it run
    // faster"). They are the most expensive thing on a full board -- one quad per stone at rest,
    // more in flight -- so a machine that struggles can have the scene without them. Paint order
    // is unchanged: an empty shadow list still comes first.
    if (o.shadows !== false) {
      if (airborne && !viewerLit) shadows.push(...shadowOps(t, a * (o.oblique ? Math.min(1, zt / 1.5) * (1 - (t.entry ?? 0)) : 1), o));
      if (o.oblique && !viewerLit && zt < 1.5) shadows.push(...restingShadowOps(t, o, 1 - zt / 1.5));
    }
  }
  const ops = o.oblique ? [...shadows, ...ground] : [...ground, ...shadows, ...air];
  return { ops, bounds: ops.length ? { minX, maxX, minY, maxY } : null, count: ordered.length };
}

// PAINT ORDER UNDER THE OBLIQUE CAMERA (operator, 2026-09-11: "Blocks
// bouncing around during movements and z-fighting in a weird way" / "new
// blocks landing and bouncing is totally broken visually"). The fixed rule
// was "the far corner first, everything airborne last", and with cubes of
// real height that is wrong: a small cube bouncing a unit off the floor
// BEHIND a tall resting one was painted over it, so landings looked like
// cubes sliding through each other.
//
// The real rule, for two cubes whose pictures overlap: find an axis that
// separates them and paint the one on the viewer's side of it later. Height
// first -- the planner keeps any two flights that pass over each other in
// disjoint altitude intervals, so a pair one above the other always splits
// here, and the higher paints later -- then the row (the camera sits past
// row 0 when rows are flipped), then the column (it sits past column 0).
// Those pairwise facts are sorted topologically; the old diagonal key only
// breaks ties, so a still board paints exactly as before.
export function obliqueOrder(tiles, o = {}) {
  const n = tiles.length;
  const flipped = flipOf(o) > 0;
  // A cube's outline on screen: the convex hull of its eight corners as drawn.
  const hullOf = (pts) => {
    const s = pts.slice().sort((p, q) => p.x - q.x || p.y - q.y);
    const cross = (a, p, q) => (p.x - a.x) * (q.y - a.y) - (p.y - a.y) * (q.x - a.x);
    const lo = [], hi = [];
    for (const p of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  };
  // Do two outlines overlap by more than `tol` on every axis? (separating axis
  // theorem for convex polygons)
  const overlaps = (A, B, tol) => {
    for (const poly of [A, B]) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        let nx = q.y - p.y, ny = p.x - q.x;
        const L = Math.hypot(nx, ny);
        if (!L) continue;
        nx /= L; ny /= L;
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const v of A) { const d = v.x * nx + v.y * ny; if (d < a0) a0 = d; if (d > a1) a1 = d; }
        for (const v of B) { const d = v.x * nx + v.y * ny; if (d < b0) b0 = d; if (d > b1) b1 = d; }
        if (Math.min(a1, b1) - Math.max(a0, b0) < tol) return false;
      }
    }
    return true;
  };
  const info = tiles.map((t, i) => {
    const z0 = (t.z ?? 0) + (t.floor ?? 0), h = cubeHeight(t);
    const P = liftProjector(t, o);
    const pts = [];
    for (const gx of [t.x, t.x + t.s]) for (const gy of [t.y, t.y + t.s]) for (const gz of [z0, z0 + h]) pts.push(P(gx, gy, gz));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    return { t, i, zv0: z0, zv1: z0 + h, hull: hullOf(pts), bx0: x0, bx1: x1, by0: y0, by1: y1,
      fx0: t.x, fx1: t.x + t.s, fy0: t.y, fy1: t.y + t.s, key: String(t.txid), diag: t.x + t.y + t.s };
  });
  // The priority among cubes nothing constrains, and where a cycle is cut: the
  // old diagonal order, by FOOTPRINT only. It used to include the current height
  // and whether a cube was airborne, which change every frame, so a cycle was cut
  // in a different place each frame and the picture flickered (2026-09-11).
  const rank = new Array(n);
  info.slice().sort((p, q) => (q.diag - p.diag) || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0))
    .forEach((e, k) => { rank[e.i] = k; });
  const EPS = 1e-6;
  // IN REAL SPACE, footprint first, height only when the footprints overlap: in
  // real space the planner guarantees no two cubes intersect, so some axis always
  // separates a pair, and a bouncing cube (which keeps crossing its neighbour's
  // top) stays decided by the footprints.
  const nearer = (a, b) => {
    if (a.fy1 <= b.fy0 + EPS) return flipped ? 1 : -1;
    if (b.fy1 <= a.fy0 + EPS) return flipped ? -1 : 1;
    if (a.fx1 <= b.fx0 + EPS) return 1;
    if (b.fx1 <= a.fx0 + EPS) return -1;
    if (a.zv0 >= b.zv1 - EPS) return 1;
    if (b.zv0 >= a.zv1 - EPS) return -1;
    // overlapping even in real space (not in a planned flight): the axis of least overlap
    const oz = Math.min(a.zv1, b.zv1) - Math.max(a.zv0, b.zv0);
    const oy = Math.min(a.fy1, b.fy1) - Math.max(a.fy0, b.fy0);
    const ox = Math.min(a.fx1, b.fx1) - Math.max(a.fx0, b.fx0);
    if (oz <= oy && oz <= ox) return a.zv0 + a.zv1 > b.zv0 + b.zv1 ? 1 : -1;
    if (oy <= ox) return (a.fy0 + a.fy1 < b.fy0 + b.fy1) === flipped ? 1 : -1;
    return a.fx0 + a.fx1 < b.fx0 + b.fx1 ? 1 : -1;
  };
  // CONSTRAINTS ONLY WHERE THE PICTURES TRULY OVERLAP. A padded bounding box
  // added one for every pair within ~11 px of each other; between cubes whose
  // outlines do not actually overlap those constraints are free to contradict
  // one another, and the cycles they formed were cut arbitrarily -- replayed, the
  // final order contradicted a pairwise decision in 1267 of 1452 frames while no
  // decision itself ever changed. Now: outlines overlapping by over half a unit.
  const TOL = 0.5;
  const after = Array.from({ length: n }, () => []);
  const indeg = new Array(n).fill(0);
  // A LEANING FACE OVER A SHORTER NEIGHBOUR (operator, 2026-09-12: "Height sorting issue on bottom
  // left larger blocks next to smaller blocks"). Measured on the live Simple board: 6 of 33
  // same-row tall/short pairs painted the short one AFTER the tall one, clipping the tall cube's
  // side face -- every one of them on the LEFT half. Two things together: the pair rule below
  // orders an x-overlap by column alone (left after right), which is right where faces lean
  // right and backwards where the radial lean points them left; and abutting neighbours never
  // reach that rule anyway, because the bounding-box check skips any pair closer than TOL while
  // a 2-tall face leans over its neighbour by ~0.18 units. So: for same-row neighbours of
  // unequal height, the taller paints after the one its face leans over, the side taken from the
  // lean at its own column. +1: i after j. -1: j after i. 0: not this case.
  // ON A SETTLED BOARD ONLY. A clipped face is a resting-board artefact -- a cube standing beside
  // a shorter one. Applied during a transition this rule made pairs flicker (the guard caught 21
  // of 785 overlapping pairs swapping mid-flight), and gating it per pair was not enough: an
  // extra edge changes the SHAPE of the constraint graph, so as third cubes fly past and their
  // hull edges come and go, the group a resting pair belongs to is re-cut differently from frame
  // to frame and the pair swaps without either of them moving. So while anything on the board is
  // in flight, no leaning-face edges at all: the graph is exactly what it was before this rule
  // existed, and the resting order takes over once, at settle -- a single change, not a swap.
  const flying = (t) => (t.z ?? 0) > 0 || (t.entry ?? 0) > 0;
  const settledBoard = !tiles.some(flying);
  const leanEdge = (p, q) => {
    if (!settledBoard) return 0;
    const hp = cubeHeight(p.t), hq = cubeHeight(q.t);
    if (hp === hq) return 0;
    const [tall, short, sign] = hp > hq ? [p.t, q.t, 1] : [q.t, p.t, -1];
    if (!(short.y < tall.y + tall.s && tall.y < short.y + short.s)) return 0;     // same rows
    const lean = obliqueLean(tall.x + tall.s / 2, o);
    const onLeanSide = (lean > 0 && short.x === tall.x + tall.s) || (lean < 0 && short.x + short.s === tall.x);
    return onLeanSide ? sign : 0;
  };
  for (let i = 0; i < n; i++) {
    const a = info[i];
    for (let j = i + 1; j < n; j++) {
      const c2 = info[j];
      const le = leanEdge(a, c2);
      if (le > 0) { after[j].push(i); indeg[i]++; continue; }
      if (le < 0) { after[i].push(j); indeg[j]++; continue; }
      if (a.bx1 - TOL < c2.bx0 || c2.bx1 - TOL < a.bx0 || a.by1 - TOL < c2.by0 || c2.by1 - TOL < a.by0) continue;
      if (!overlaps(a.hull, c2.hull, TOL)) continue;
      const c = nearer(a, c2);
      if (c > 0) { after[j].push(i); indeg[i]++; } else if (c < 0) { after[i].push(j); indeg[j]++; }
    }
  }
  // CYCLES ARE RESOLVED AS A GROUP, NOT CUT (2026-09-11). Even with constraints
  // only between truly overlapping outlines, a cube in flight can be tangled
  // with several others: the pair decisions are made in real space and the
  // outlines are drawn on the sphere, so a few groups contradict each other. The
  // old loop broke a cycle by forcing the lowest-ranked cube LEFT ANYWHERE --
  // often one outside the cycle -- and which cubes were left changed as others
  // moved, so the same tangle was cut differently from frame to frame (replayed:
  // 21 of the last 23 flickers, with the pair decision and the overlap both
  // unchanged). Now the tangles are found (strongly connected components), the
  // groups are ordered among themselves -- that order cannot cycle -- and inside
  // a group the cubes go by how near their drawn centre is to the camera, a
  // smooth measure that cannot be cut two ways.
  // the camera looks along (-ox, -oy/dy, 1): a squeezed depth weighs a row further back more
  const oby = (o.oblique?.oy ?? 0.36) / (o.oblique?.dy ?? 1);
  const depth = info.map((e2) => {
    const t = e2.t, h = cubeHeight(t), cxRest = t.x + t.s / 2, cy = t.y + t.s / 2;
    const zb = (t.z ?? 0) > 0 || t.entry > 0 ? visualBase(t, o) : 0;
    // where this cube is actually DRAWN: its slot, plus the flight along the sphere's normal,
    // plus the camera's own sideways push -- settled the same way liftProjector settles it, so
    // the order and the geometry are measured at the same point (obliqueLean is radial, so a
    // block that has travelled leans by where it has got to, not by the slot it left)
    const drift = zb * flightDir(cxRest, cy, o).x;
    const height = zb + capZ(cxRest + drift, cy, o) + (t.floor ?? 0) + h / 2;
    let lean = obliqueLean(cxRest + drift, o);
    for (let i = 0; i < 2; i++) lean = obliqueLean(cxRest + drift + height * lean, o);
    const cx = cxRest + drift;
    return -lean * cx - (flipped ? 1 : -1) * oby * cy + capZ(cx, cy, o) + zb + (t.floor ?? 0) + h / 2;
  });
  const index = new Array(n).fill(-1), low = new Array(n).fill(0), onStack = new Array(n).fill(false), comp = new Array(n).fill(-1);
  const stack = [];
  let idx = 0, nComp = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (index[s0] >= 0) continue;
    const work = [[s0, 0]];
    index[s0] = low[s0] = idx++; stack.push(s0); onStack[s0] = true;
    while (work.length) {
      const top = work[work.length - 1], v = top[0];
      if (top[1] < after[v].length) {
        const w = after[v][top[1]++];
        if (index[w] < 0) { index[w] = low[w] = idx++; stack.push(w); onStack[w] = true; work.push([w, 0]); }
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
        if (low[v] === index[v]) { let w; do { w = stack.pop(); onStack[w] = false; comp[w] = nComp; } while (w !== v); nComp++; }
      }
    }
  }
  const members = Array.from({ length: nComp }, () => []);
  for (let v = 0; v < n; v++) members[comp[v]].push(v);
  const cRank = members.map((m) => Math.min(...m.map((v) => rank[v])));
  const cAfter = Array.from({ length: nComp }, () => new Set());
  const cIn = new Array(nComp).fill(0);
  for (let v = 0; v < n; v++) for (const w of after[v]) {
    const p = comp[v], q = comp[w];
    if (p !== q && !cAfter[p].has(q)) { cAfter[p].add(q); cIn[q]++; }
  }
  // the groups, lowest-ranked ready group first (a DAG: nothing to cut)
  const heap = [];
  const push = (c) => { heap.push(c); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (cRank[heap[p]] <= cRank[c]) break; heap[k] = heap[p]; k = p; } heap[k] = c; };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; const vm = () => (m === k ? last : heap[m]); if (l < heap.length && cRank[heap[l]] < cRank[vm()]) m = l; if (r < heap.length && cRank[heap[r]] < cRank[vm()]) m = r; if (m === k) break; heap[k] = heap[m]; k = m; } heap[k] = last; } return top; };
  for (let c = 0; c < nComp; c++) if (cIn[c] === 0) push(c);
  // A TANGLE REMEMBERS ITS ORDER (2026-09-12, operator: "Still showing block z-fighting during
  // transitions"). Depth alone re-ordered a tangle every frame it was re-cut, so a pair whose
  // decision never changed still swapped whenever a bystander flying past pulled it into a
  // tangle or let it out (replayed: 18 of 19 flickers had the edge and the decision unchanged
  // and the final order flipped). With `orderMemo` (render3d keeps one per canvas) the cubes of
  // a tangle keep the relative order they had LAST frame -- the order the edges gave them before
  // the tangle formed -- and only cubes with no last frame fall in by depth. In and out of a
  // tangle the pair's order is then the same, so nothing can flicker; a cube genuinely passing
  // another is decided by the edges again the moment the tangle dissolves.
  const memo = o.orderMemo instanceof Map ? o.orderMemo : null;
  const prev = memo ? (v) => memo.get(String(tiles[v].txid)) : () => undefined;
  const out = [];
  while (heap.length) {
    const c = pop();
    const m = members[c];
    if (m.length > 1) m.sort((p, q) => {
      const a = prev(p), b = prev(q);
      if (a !== undefined && b !== undefined && a !== b) return a - b;
      if (a !== undefined && b === undefined) return -1;
      if (a === undefined && b !== undefined) return 1;
      return (depth[p] - depth[q]) || (rank[p] - rank[q]);
    });
    for (const v of m) out.push(tiles[v]);
    for (const d of cAfter[c]) if (--cIn[d] === 0) push(d);
  }
  if (memo) { memo.clear(); out.forEach((t, k) => memo.set(String(t.txid), k)); }
  return out;
}

// RESTING CUBES CAST SHADOWS TOO (operator, 2026-09-11: "a more interesting
// ground texture ... shows the shadows well"). Only flights cast one before,
// so at rest -- most of the time -- nothing on the ground showed a shadow. A
// standing cube throws a short one away from the light (upper left, above):
// down and to the right of its footprint, longer the taller the cube -- the
// hull of the footprint and its shifted copy -- with a fainter penumbra round
// it. It lies on the floor, so every cube paints over it (buildScene paints
// shadows first).
export function restingShadowOps(t, o = {}, k = 1) {
  if (!(k > 0.005)) return [];
  const flip = o.flipY === false ? -1 : 1;
  const d = Math.min(2.5, 0.2 + 0.28 * (cubeHeight(t) + (t.floor ?? 0)));
  const hull = (e, dd) => {
    const x0 = t.x - e, y0 = t.y - e, x1 = t.x + t.s + e, y1 = t.y + t.s + e, dy = -flip * dd;   // screen-down is -row
    return [[x0, y1], [x1, y1], [x1 + dd, y1 + dy], [x1 + dd, y0 + dy], [x0 + dd, y0 + dy], [x0, y0]].map(([gx, gy]) => project(gx, gy, 0, o));
  };
  return [
    { txid: t.txid, face: 'shadow', points: hull(0.15, d * 1.35), fill: `rgba(0,0,0,${round3(0.12 * k)})` },
    { txid: t.txid, face: 'shadow', points: hull(0, d), fill: `rgba(0,0,0,${round3(0.26 * k)})` },
  ];
}

// The shadow an airborne tile casts on the plane, as up to three nested
// rgba squares: a soft penumbra and a darker umbra, both at the tile's TRUE
// footprint on the tops of the resting stones.
export function shadowOps(t, a = 1, o = {}) {
  const z = t.z ?? 0;
  if (!(z > 0.02) || !(a > 0)) return [];
  const blur = Math.min(3, 0.15 + z * 0.13);            // spreads as it climbs (gentler since flights climb higher)
  const dark = Math.min(0.78, 0.78 / (1 + z * 0.05)) * a; // and pales -- slowly, so a high flight still marks its slot
  // Cast by a light above and to the upper left: the shadow slides down and to
  // the right of the slot as the block climbs, and that growing gap is what
  // says "lifted toward the viewer" (directly underneath, a spreading dark
  // ring read as the block sinking).
  const off = o.oblique ? 0 : Math.min(2, z * 0.3);   // oblique: the block itself is displaced, the shadow stays on its slot
  const ox = off, oy = (o.flipY === false ? off : -off);   // screen-down is -row when rows are flipped
  const P = (gx, gy) => project(gx + ox, gy + oy, 0, o);          // on the floor: resting cubes are of every height now
  const sq = (e) => [P(t.x - e, t.y - e), P(t.x + t.s + e, t.y - e), P(t.x + t.s + e, t.y + t.s + e), P(t.x - e, t.y + t.s + e)];
  const core = Math.min(t.s * 0.3, z * 0.04);
  return [
    { txid: t.txid, face: 'shadow', points: sq(blur), fill: `rgba(0,0,0,${round3(dark * 0.22)})` },
    { txid: t.txid, face: 'shadow', points: sq(blur * 0.45), fill: `rgba(0,0,0,${round3(dark * 0.3)})` },
    { txid: t.txid, face: 'shadow', points: sq(-core), fill: `rgba(0,0,0,${round3(dark * 0.5)})` },
  ];
}

// FILL the box, not fit inside it. The packing is rarely exactly square --
// sides round to whole units, so a block packs a few rows taller or shorter
// than it is wide (blockpack.js) -- and an aspect-preserving fit into a
// square panel left black bars down both sides -- "too much black ...
// wasted space".
//
// The cost, stated rather than hidden: scaling the axes separately makes a
// block up to about 10% off square. That is below the threshold where anyone reads
// it as a rectangle, and it buys the whole panel. Areas still track vbytes
// exactly, because both axes scale every block identically.
export function fitToBox(bounds, boxW, boxH, pad = 8) {
  if (!bounds) return { scaleX: 1, scaleY: 1, scale: 1, dx: 0, dy: 0 };
  const w = bounds.maxX - bounds.minX || 1;
  const h = bounds.maxY - bounds.minY || 1;
  const scaleX = (boxW - pad * 2) / w;
  const scaleY = (boxH - pad * 2) / h;
  return {
    scaleX, scaleY,
    scale: Math.min(scaleX, scaleY),      // for callers that want the uniform one
    dx: pad - bounds.minX * scaleX,
    dy: pad - bounds.minY * scaleY,
  };
}

// --- easing ------------------------------------------------------------
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
export function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
// Gravity: a piece does not ease into the floor, it accelerates into it.
export function gravity(t) { const c = Math.max(0, Math.min(1, t)); return c * c; }

// The landing, with real gravity and a decaying series of bounces. Returns
// the REMAINING height as a fraction of the drop: 1 at release, 0 at rest.
//
// The fall is h = 1 - u^2, which is gravity: the block covers three quarters
// of the distance in the second half of the fall, so it visibly accelerates
// into the floor. Each bounce afterwards is a parabola of decaying height
// (restitution 0.55) and correspondingly shorter duration, exactly as a
// dropped object behaves -- quick little hops at the end rather than one
// polite rebound.
//
// `bounces` is 1..5 per block, from its own hash, so no two settle the same
// way (operator: "Make every block bounce at least 1-5 times randomly before
// settling into place").
export function bounceDrop(t, bounce = 0.12, bounces = 3, rest = 0.55) {
  const c = Math.max(0, Math.min(1, t));
  const n = Math.max(1, Math.min(12, Math.round(bounces)));
  const REST = rest;

  const heights = [];
  let h = Math.max(bounce, 1e-6);
  for (let k = 0; k < n; k++) { heights.push(h); h *= REST; }

  // PHYSICS FOR THE TIMING (operator, 2026-09-11: "The bouncing needs to be
  // sinusoidal and apply physics so each bounce isn't the same length of
  // time"). Under constant gravity a fall from height 1 takes time T, and a
  // hop up to height h and back takes 2 T sqrt(h). The old weights were
  // 1.25 * sqrt(h / h0): relative to the FIRST hop, not to the fall, so the
  // first hop always lasted 1.25 falls whatever its height -- a 3% rebound
  // floated as long as a 22% one. With heights kept at REST = 0.55 per bounce,
  // each hop is now sqrt(0.55) = 0.74 as long as the one before it.
  const segs = [1, ...heights.map((v) => 2 * Math.sqrt(v))];
  const total = segs.reduce((a, b) => a + b, 0);

  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const w = segs[i] / total;
    const last = i === segs.length - 1;
    if (c < acc + w || last) {
      const u = w > 0 ? Math.min(1, Math.max(0, (c - acc) / w)) : 1;
      if (i === 0) return 1 - u * u;              // the fall: accelerating
      if (last && c >= 1) return 0;               // and it does come to rest
      return heights[i - 1] * Math.sin(Math.PI * u);   // a hop: a sine arc, lower and shorter each time
    }
    acc += w;
  }
  return 0;
}

// GRAVITY TIMES EVERY LANDING (operator, 2026-09-11: "I don't get any sense
// of blocks falling and bouncing ... Need much more randomness and
// variability"). Every block's landing used to be squeezed into the same
// fixed drop window whatever it fell from, so a block dropping one unit took
// as long as one dropping twelve and floated down. Now a fall from h takes
// sqrt(2h / g) -- a fall from 12 units takes 2.4 s -- and the whole landing
// is that fall plus its own hops (bounceDrop's segments are in the same
// proportions, so the curve and the clock agree). Low blocks land fast, high
// ones take longer, and no two finish together.
// 2026-09-11: a 12-unit fall took 1.6 s, which on this board read as slow
// motion (operator: "They bounce too slowly right now"); 0.7 s was then far
// too fast ("Holy shit the bouncing is too fast now. cut speed in half at
// least"). 1.4 s: half the speed of 0.7 s, every hop with it.
// ...and 1.4 s was STILL "way too fast. Calm that shit down": 2.4 s now, with
// deader rebounds (restitutionOf below).
// 12 units in 0.6 s since 2026-09-11 -- 2.4 s was "The items slowly start dropping.
// They need to drop like they were just let go, immediately succumb to gravity", and
// 1.2 s "gravity still doesn't seem strong enough"
export const GRAVITY = (2 * 12) / (600 * 600);            // grid units per ms^2
export function fallMs(h) { return Math.sqrt((2 * Math.max(0, h)) / GRAVITY); }
export function landingMs(h, bounce, bounces, rest = 0.55) {
  const n = Math.max(1, Math.min(12, Math.round(bounces)));
  let b = Math.max(bounce, 1e-6), hops = 0;
  for (let k = 0; k < n; k++) { hops += 2 * Math.sqrt(b); b *= rest; }
  return fallMs(h) * (1 + hops);
}

// One block's landing: where it falls from, how it bounces, and when it lets
// go and comes to rest. Deterministic from the block's own hashes, so it has
// the same character on every repaint.
export function landingOf(tw, plan) {
  const j = tw.jitter ?? 0;
  const jH = tw.jH ?? j;
  const spread = plan.cfg.bounceSpread;
  // MASS (operator, 2026-09-11: "Have the blocks obey the natural laws of
  // gravity with their bouncing ... Give the blocks actual weight/mass for
  // physics to simulate"). Mass does not change how fast a block falls
  // (Galileo); it changes how it BOUNCES, through its coefficient of
  // restitution e: a rebound reaches e^2 of the height it fell from, and each
  // hop lasts e as long as the one before. A heavy block (large area, i.e. many
  // vbytes) thuds and settles; a light one rebounds and keeps hopping.
  const e = restitutionOf(tw.to?.s ?? 1, tw.jR ?? jitterOf(tw.txid, 'r'));
  const rest = e * e;
  const bounce = rest;          // the first rebound is e^2 of the drop, like every one after it
  const nBounce = bouncesUntil(bounce, rest);
  // an arrival lets go from its own height, always above the flight stack
  const from = tw.kind === 'enter' ? plan.cfg.enterFrom * (1 + 0.9 * (tw.jA ?? 0)) : (tw.lane ?? 0);
  // Cube lanes can stack high over a busy board; gravity from forty units
  // would take seconds. The fall is TIMED as if from at most 24 units (~3.4 s;
  // it was forty for the 40 s transition, twelve and sixteen before that),
  // which the eye reads as the same drop -- the heights themselves are kept,
  // because the no-collision proof lives in them.
  const t0 = plan.phases.travel + j * (plan.cfg.dropStagger || 0);
  return { bounce, nBounce, rest, from, t0, t1: t0 + landingMs(Math.min(from, 24), bounce, nBounce, rest) };
}

// COMING TO REST THE WAY A DROPPED THING DOES (operator, 2026-09-11: "The
// blocks bouncing and coming to rest seems too abrupt. It needs to really look
// like physics is making it come to rest naturally"). A fixed 1-5 bounces
// stopped a block while its hops were still plainly visible. It now bounces
// until a hop would be under 0.4% of the drop -- each lower by e^2 and shorter
// by e, where e is the block's coefficient of restitution (from its mass, see
// restitutionOf) -- a converging series of ever quicker, ever smaller hops,
// which is how a real object comes to rest in finite time. Variety comes from
// mass and a small per-block share rather than a dice roll on the count.
// (2026-09-11, "come to rest sooner": the floor 0.4% -> 1% and one hop allowed,
// so a light block gets a small second hop and a heavy one settles after one)
export function bouncesUntil(bounce, rest, floor = 0.01) {
  const n = Math.ceil(Math.log(floor / Math.max(bounce, 1e-6)) / Math.log(rest));
  return Math.max(1, Math.min(8, n));
}

// Coefficient of restitution from mass. Mass goes as a block's AREA (its
// vbytes), and a heavier block is a deader bounce: e falls with log2 of the
// side, from ~0.78 for a one-unit block to ~0.4 for the largest, plus a +-0.05
// share from the block's own hash so two blocks of one size do not settle in
// lockstep.
export function restitutionOf(side, jitter = 0.5) {
  // calmer (2026-09-11): e in 0.28-0.6; then heavier still ("less bouncing.
  // Make them come to rest sooner. More weight to each block"): e in 0.15-0.36,
  // so a one-unit block keeps at most 13% of its fall and a big one ~3%
  return Math.max(0.15, Math.min(0.36, 0.36 - 0.05 * Math.log2(Math.max(1, side)) + (jitter - 0.5) * 0.06));
}

// how many times a given block bounces: 1..5, stable from its id (the old
// policy, kept for anything that still asks)
export function bouncesFor(jitter) { return 1 + Math.floor(Math.max(0, Math.min(0.999, jitter)) * 5); }

// Heavier (bigger) blocks barely bounce; small ones do. Bounded so nothing
// bounces absurdly and nothing is perfectly dead.
// 2026-09-11: raised from [0.03, 0.22] -- with a drop of a unit or two a 3%
// rebound is a few hundredths of a unit, and nobody saw a bounce at all.
export function bounceFor(side) { return Math.max(0.1, Math.min(0.4, 0.9 / Math.max(1, side))); }

// A stable per-block number in [0,1), from its id. DETERMINISTIC on purpose:
// a random draw per frame would make every block jitter its own landing, and
// the same block must get the same character on every repaint or the picture
// shimmers. FNV-1a, which is four lines and needs no dependency.
export function jitterOf(txid, salt = '') {
  let h = 2166136261;
  const s = salt + String(txid);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

// Whole-cell travel. A tetromino does not drift diagonally across the board;
// it occupies one cell, then the next. `cells` is the Chebyshev distance, so
// a move of 7 columns takes 7 visible steps however long the phase lasts.
export function steppedProgress(t, cells) {
  const c = Math.max(0, Math.min(1, t));
  const n = Math.max(1, Math.round(cells));
  if (c >= 1) return 1;
  return Math.floor(c * n) / n;
}

// --- the choreography --------------------------------------------------
// rise + travel + drop = 5.4 s by default: inside a 10 s refresh, and slow
// enough to follow one tile across the board.
// Thirty seconds end to end (operator, 2026-09-10), against a 20 s data
// refresh: a transition therefore overlaps the next poll, and the replan
// guard in the renderer is what keeps that from restarting it -- an unchanged
// layout leaves the running choreography alone.
export const TRANSITION = {
  // 40 s nominal (operator, 2026-09-11: "increase the animation time to at
  // least 40 seconds if it's refreshed every 60 seconds"); was 5 + 18.5 + 6.5
  // 20 s since the second 2026-09-11 change ("Faster refresh": the viewer
  // refreshes every 30 s now, so a 40 s transition would never finish)
  rise: 3000, travel: 11000, drop: 6000,
  // > a tile is thick, which IS the separation proof, and no higher: the fit
  // has to include the highest tile in flight, so a tall choreography zooms
  // the whole board out (operator: "it zooms out too much").
  laneGap: TILE_H * 1.35,
  // every mover lifts at least this far (2026-09-11: "the blocks can rise
  // higher ... it will help sell the depth and shadows"): a block with nothing
  // under its path used to skim a lane-gap above the board. Higher is always
  // safe -- lanes still stack as disjoint intervals above it.
  // 8 -> 24 (2026-09-11: "the blocks can rise even higher than they doing for a
  // reshuffle. Really make use of verticality within the viewport"): the lift
  // itself is higher, rather than height being stretched near the floor, which
  // would have inflated every bounce as well
  liftMin: 24,
  lockMs: 260,
  // Landings were all on the same frame, which read as machinery rather than
  // as objects (operator: "Everything is too uniform on landing"). Each block
  // now starts its drop somewhere inside this window and bounces to its own
  // height. Staggering only the DROP is safe: every block descends into its
  // OWN slot, and slots never overlap, so the no-collision proof is untouched.
  entryMs: 1300,       // (2.4 s until gravity went to 12 units in 0.6 s: an arrival's fall from off screen must keep pace)
        // an arrival's fall from off screen starts this long before its drop slot (2026-09-11)
  dropStagger: 3500,   // 1400 -> 4500 -> 6000 (2026-09-11: "much more randomness", then "at least 40 seconds")
  // Lift-offs stagger too, so the board does not heave all at once (operator:
  // "don't have to all move at once"). Bounded INSIDE the rise phase: every
  // block must be airborne before any block descends, or one could drop into
  // a slot its previous occupant has not vacated. That is exactly why rise and
  // travel keep shared boundaries while the drop does not.
  riseStagger: 1300,
  bounceSpread: 0.85,
  heightCap: 0.22,  // the flight stack may reach this fraction of the board
  // HOW FAR A BLOCK IN FLIGHT MAY SWELL, and it is the real lever for "moving
  // too high". In this projection height does NOT move a block up the screen
  // -- it only scales it outward from the vanishing point -- so a 42% swell
  // threw edge blocks well past the board while the raw lane number looked
  // irrelevant. 15% is a clear lift that stays near the grid.
  maxGrowth: 0.15,  // how much the nearest lane may swell; the fit reserves it
};

export function planTransition(prev, next, opts = {}) {
  const cfg = { ...TRANSITION, ...opts };
  const now = opts.now ?? 0;
  const byId = new Map((prev || []).map((t) => [t.txid, t]));
  const nextIds = new Set((next || []).map((t) => t.txid));

  const movers = [];
  const tweens = [];
  for (const t of next || []) {
    const from = byId.get(t.txid);
    if (!from) tweens.push({ kind: 'enter', txid: t.txid, to: t, from: t });
    else if (from.x !== t.x || from.y !== t.y || from.s !== t.s) movers.push({ from, to: t });
    else tweens.push({ kind: 'hold', txid: t.txid, from: t, to: t });
  }
  for (const t of prev || []) if (!nextIds.has(t.txid)) tweens.push({ kind: 'exit', txid: t.txid, from: t, to: t });
  for (const tw of tweens) if (tw.kind === 'enter') {
    tw.jitter = jitterOf(tw.txid);
    tw.jN = jitterOf(tw.txid, 'n');
    tw.jH = jitterOf(tw.txid, 'h');
    tw.jA = jitterOf(tw.txid, 'a');
    tw.jR = jitterOf(tw.txid, 'r');
  }

  // FLIGHT LANES. One lane per mover would be correct but absurd now that
  // tiles are cubes: a cube of side 10 is 10 units tall, so 100 movers would
  // stack a thousand units into the air and the fit would shrink the board to
  // a smudge. Two movers can share an altitude whenever their SWEPT
  // footprints are disjoint -- neither can ever be where the other is -- so
  // lanes are assigned greedily by overlap. A mostly-local rearrangement then
  // needs a handful of lanes instead of hundreds, and the guarantee is
  // unchanged: same lane implies disjoint sweeps, different lane implies
  // vertical separation.
  // BIGGEST FIRST, so the big blocks take the LOWEST lanes. Lanes are handed
  // out in order, and a large block on a high lane is exactly what leaves the
  // top of the panel (operator: "The big green squares are moving too high off
  // the display"). Distance breaks ties, so among equals short hops stay low.
  movers.sort((a, b) => {
    const sa = Math.max(a.from.s, a.to.s), sb = Math.max(b.from.s, b.to.s);
    if (sa !== sb) return sb - sa;
    const da = Math.max(Math.abs(a.to.x - a.from.x), Math.abs(a.to.y - a.from.y));
    const db = Math.max(Math.abs(b.to.x - b.from.x), Math.abs(b.to.y - b.from.y));
    return da - db;
  });
  // The swept region must contain the whole ROUTE. Now that travel is
  // L-shaped the block also passes through a corner -- (to.x, from.y) or
  // (from.x, to.y) -- and it may be at its LARGER size when it does. Taking
  // the endpoints only left that corner outside the box, two blocks were
  // given the same lane on the strength of it, and the pairwise collision
  // test failed on the next run.
  const swept = (m) => {
    const s = Math.max(m.from.s, m.to.s);
    const xs = [m.from.x, m.to.x], ys = [m.from.y, m.to.y];
    return {
      x0: Math.min(...xs), y0: Math.min(...ys),
      x1: Math.max(...xs) + s, y1: Math.max(...ys) + s,
    };
  };
  const hits = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  // CUBES STACK BY THEIR OWN HEIGHT. A mover at base altitude L occupies
  // [L, L + s], not a slab, so an altitude is an INTERVAL: movers whose swept
  // footprints overlap get disjoint intervals, first fit, biggest first; and
  // every mover travels clear of the tallest RESTING cube under its sweep
  // (the holds are the only cubes standing during travel). Same proof as
  // before, with the real heights in it -- and the pairwise collision test
  // uses cubeHeight, so it checks exactly this.
  const resting = tweens.filter((t) => t.kind === 'hold').map((t) => t.to);
  const flying = [];
  const CLEAR = 0.25 * cfg.laneGap;
  for (const m of movers) {
    const sw = swept(m);
    const h = Math.max(m.from.s, m.to.s);          // the tallest it can be in flight
    // each block its own lift, liftMin x 0.55..1.45: one shared minimum made
    // every drop 8-12 units, so every landing took nearly the same time
    let base = Math.max(cfg.laneGap, (cfg.liftMin ?? 0) * (0.55 + 0.9 * jitterOf(m.to.txid, 'lift')));
    for (const r of resting) {
      if (hits(sw, { x0: r.x, y0: r.y, x1: r.x + r.s, y1: r.y + r.s })) base = Math.max(base, cubeHeight(r) + CLEAR);
    }
    const busy = flying.filter((f2) => hits(sw, f2.sw)).sort((p, q) => p.lo - q.lo);
    for (const f2 of busy) {
      if (base + h + CLEAR <= f2.lo) break;          // fits in the gap below this one
      if (base < f2.hi + CLEAR) base = f2.hi + CLEAR; // otherwise go above it
    }
    flying.push({ sw, lo: base, hi: base + h });
    tweens.push({
      kind: 'move', txid: m.to.txid, from: m.from, to: m.to,
      lane: base,
      laneIndex: flying.length - 1,
      jitter: jitterOf(m.to.txid),
      // INDEPENDENT draws: one hash per property, each stable for its block.
      jN: jitterOf(m.to.txid, 'n'),
      jH: jitterOf(m.to.txid, 'h'),
      jR: jitterOf(m.to.txid, 'r'),
      cells: Math.max(Math.abs(m.to.x - m.from.x), Math.abs(m.to.y - m.from.y)),
    });
  }
  const gridN = Math.max(8, opts.gridN || 0);
  const ceiling = gridN * cfg.heightCap;
  cfg.maxLane = flying.length ? Math.max(...flying.map((f2) => f2.hi)) : cfg.laneGap;
  // THE CAMERA IS NOT ALLOWED TO CHANGE BETWEEN ROUNDS.
  //
  // This used to be derived from cfg.maxLane -- how tall THIS round's lane
  // stack happened to be. A quiet round with no movers has one lane and got
  // 0.075; a busy round with seven lanes got 0.028. Same board, two cameras
  // nearly 3x apart in depth scaling, swapped at the moment a plan was made.
  // The visible symptom was the first paint (operator: "the initial view on
  // load is buggy, it has dark triangles, but things return to normal on the
  // first animation"): the first plan is a no-op self-transition, so it took
  // the shallow-stack camera, drew every cube's dark front lip almost three
  // times too tall, and those lips read as dark wedges -- worst either side
  // of the vanishing line, where the lip flips from pointing up to pointing
  // down and passes through a degenerate triangle.
  //
  // Derived from the GRID and the height cap instead: both are constants, so
  // every plan on a given board produces the same camera, and the first
  // paint already looks like the steady state. The bound is still honest --
  // lanes are compressed to fit under `ceiling` just above, so the tallest
  // lane any round can reach is the value used here.
  // The bound is `ceiling`, the altitude lane compression aims for. While the
  // stack fits under it -- which is every round whose lane count leaves the
  // gap above its floor -- growth stays inside the reserved margin exactly as
  // before. A round needing more lanes than the floor gap allows under the
  // ceiling stacks past it and those blocks fly beyond the panel edge, which
  // is the licence blocks in flight already have and is far cheaper than a
  // camera that changes under the operator between rounds.
  cfg.risePerUnit = Math.min(0.075, cfg.maxGrowth / Math.max(1e-6, ceiling * 0.55));
  cfg.camCeiling = ceiling;


  // Parking altitudes for arrivals and departures must clear every travel
  // lane AND each other, or an invisible waiting tile would occupy the same
  // space as a departing one. Derived from the lane stack, not hard-coded.
  const maxLane = cfg.maxLane;
  cfg.exitTo = maxLane + cfg.laneGap;
  // ON SCREEN (operator, 2026-09-11: "keep as much movement on screen as
  // possible"). This used to be far enough that the projected block started
  // OUTSIDE the panel (2026-09-10: "drops in from off screen"); the newer ask
  // supersedes it. An arrival now lets go just above the flight stack, where
  // the gather pull holds it over the board, fades up as it falls, and its
  // shadow sharpens on the slot it is about to land in.
  cfg.enterFrom = maxLane + 2 * cfg.laneGap;

  const t0 = now;
  const phases = {
    t0,
    rise: t0 + cfg.rise,
    travel: t0 + cfg.rise + cfg.travel,
    end: t0 + cfg.rise + cfg.travel + cfg.drop,
  };
  const anyMotion = tweens.some((t) => t.kind !== 'hold');
  const plan = { tweens, phases, cfg, settleAt: now, duration: cfg.rise + cfg.travel + cfg.drop };
  if (anyMotion) {
    // settled when the LAST landing is done: landings are timed per block now
    let last = phases.end;
    for (const tw of tweens) if (tw.kind === 'move' || tw.kind === 'enter') last = Math.max(last, landingOf(tw, plan).t1);
    plan.settleAt = last + cfg.lockMs;
  }
  return plan;
}

// A tween at a moment. `z` is the slab's BASE above the plane; every resting
// tile has z = 0, which is what keeps the plane a plane.
export function sampleTween(tw, now, plan) {
  const p = plan.phases;
  // this block's own landing: when it lets go, and how hard it bounces
  const j = tw.jitter ?? 0;
  const L = (tw.kind === 'move' || tw.kind === 'enter') ? landingOf(tw, plan) : null;
  const dropT0 = L?.t0 ?? p.travel;
  const dropT1 = L?.t1 ?? p.end;
  const bounce = L?.bounce ?? 0;
  const nBounce = L?.nBounce ?? 1;
  const rest = L?.rest ?? 0.55;
  const lockOf = () => {
    const dt = now - dropT1;
    return dt >= 0 && dt < plan.cfg.lockMs ? 1 - dt / plan.cfg.lockMs : 0;
  };
  if (tw.kind === 'hold') return { ...tw.to, z: 0, alpha: 1, lock: 0 };

  if (tw.kind === 'enter') {
    // A NEW block drops in from OFF SCREEN and fades up as it comes (operator,
    // 2026-09-10). Not drawn at all before it starts: it has not arrived yet.
    // enterFrom is chosen so the projected block really is outside the panel
    // when it lets go, not merely high.
    // ...and since 2026-09-11 ("Have the spawning happen off-screen for new
    // blocks being dropped in") it FALLS IN from outside the canvas. One fall:
    // the off-screen height (entry, drawn by visualBase) comes off on a single
    // gravity parabola that starts entryMs before the drop slot and reaches
    // zero exactly at impact, so the block accelerates all the way down, hits
    // and goes straight into its weighted bounce. The first cut eased to a
    // stop at the top of the ordinary fall and then dropped from rest
    // (operator: "should hit the ground and start bouncing. Not pause and
    // then drop again").
    // Its real altitude is the top of the fall throughout -- above every
    // travel lane -- so the collision proof is untouched; only the drawing
    // adds the off-screen height (visualBase).
    const entryMs = plan.cfg.entryMs ?? 0;
    if (now < dropT0 - entryMs) return null;
    const impact = dropT0 + fallShare(bounce, nBounce, rest) * (dropT1 - dropT0);
    const since = (now - (dropT0 - entryMs)) / Math.max(1, impact - (dropT0 - entryMs));
    const entry = since < 1 ? 1 - since * since : 0;
    // its REAL altitude stays at the top of the fall until the drop slot --
    // above every travel lane, so the collision proof is untouched
    if (now < dropT0) return { ...tw.to, z: L.from, entry, alpha: 1, lock: 0 };
    const t = Math.max(0, Math.min(1, (now - dropT0) / Math.max(1, dropT1 - dropT0)));
    // SOLID (2026-09-11): it used to fade up, and a see-through cube over
    // solid ones read as a ghost sliding through them ("new blocks landing
    // and bouncing is totally broken visually"). Briefly it grew in from a
    // point instead; now it arrives whole, from off screen.
    const dv = bounceDrop(t, bounce, nBounce, rest);
    return { ...tw.to, z: L.from * dv, landV: dv, fallFrom: L.from, entry, alpha: 1, lock: lockOf() };
  }

  if (tw.kind === 'exit') {
    // A block that has left the pool rises away and fades as it goes. Its
    // slot is empty long before anyone lands, which is what the shared rise
    // phase buys. (Briefly this stayed opaque on the way up; the operator
    // asked for that and then recognised why the fade is there -- a block
    // that simply vanished at the top read worse than one that departs.)
    if (now >= p.rise) return null;
    // NOT IN UNISON (operator, 2026-09-11: "All the blocks are flying up and
    // away at a uniform rate. It looks strange. Mix it up a bit with speed").
    // Each departure leaves on its own beat -- a start somewhere in the first
    // 55% of the rise, the big ones tending earlier and so climbing slower
    // (more mass) -- and with its own acceleration: an exponent of 1.3-2.6 on
    // the off-screen share, so some drift and then bolt while others pull away
    // steadily. Every one is still gone by the end of the rise, before any
    // mover travels, so the collision proof is untouched.
    const R = p.rise - p.t0;
    const heavy = Math.min(1, (tw.from.s || 1) / 12);
    const go = p.t0 + 0.55 * R * jitterOf(tw.txid, 'xgo') * (1 - 0.4 * heavy);
    if (now <= go) return { ...tw.from, z: 0, entry: 0, alpha: 1, lock: 0 };
    const t = Math.min(1, (now - go) / Math.max(1, p.rise - go));
    const e = easeOutCubic(t);
    const acc = 1.3 + 1.3 * jitterOf(tw.txid, 'xacc');
    // UP AND OFF THE SCREEN (operator, 2026-09-11: "I want to see old blocks
    // flying up and off the screen instead of disappearing"). Whole and solid
    // -- a fading block was see-through over everything it passed, and the
    // shrink that replaced the fade read as vanishing. The off-screen height
    // arrivals fall from (entry, drawn by visualBase) is taken on as t^2, so
    // it lifts off from rest and accelerates away, wholly outside the canvas
    // by the end of the rise. Its REAL altitude still eases up to exitTo,
    // clear of every lane, so the collision proof is untouched.
    return { ...tw.from, z: plan.cfg.exitTo * e, entry: Math.pow(t, acc), alpha: 1, lock: 0 };
  }

  // move: lift out, shift in whole cells at the lane, then drop under gravity
  const liftAt = p.t0 + (1 - j) * (plan.cfg.riseStagger || 0);
  if (now <= liftAt) return { ...tw.from, z: 0, alpha: 1, lock: 0 };
  if (now < p.rise) {
    const e = easeOutCubic((now - liftAt) / Math.max(1, p.rise - liftAt));
    return { ...tw.from, z: tw.lane * e, alpha: 1, lock: 0 };
  }
  if (now < p.travel) {
    // TWO MOVEMENTS, not one diagonal glide. A tetromino shifts along one axis
    // and then the other; a straight diagonal is the one motion it never
    // makes, and a board full of them reads as linear drift (operator: "break
    // things up so they aren't so linear ... Can translate in two movements").
    // Which axis leads is per-block, from its own hash, so the board does not
    // all pivot together, and each leg eases separately so there is a real
    // beat where the block changes direction.
    const raw = Math.min(1, (now - p.rise) / Math.max(1, p.travel - p.rise));
    const xFirst = (tw.jitter ?? 0) < 0.5;
    const leg1 = easeInOutCubic(Math.min(1, raw / 0.5));
    const leg2 = easeInOutCubic(Math.max(0, (raw - 0.5) / 0.5));
    const ex = xFirst ? leg1 : leg2;
    const ey = xFirst ? leg2 : leg1;
    return {
      ...tw.to,
      x: tw.from.x + (tw.to.x - tw.from.x) * ex,
      y: tw.from.y + (tw.to.y - tw.from.y) * ey,
      s: tw.from.s + (tw.to.s - tw.from.s) * Math.max(ex, ey),
      z: tw.lane,                       // constant: this is the guarantee
      alpha: 1, lock: 0,
    };
  }
  if (now < dropT1) {
    const t = (now - dropT0) / Math.max(1, dropT1 - dropT0);
    // settles with its own weighted bounce, on its own beat
    const dv = bounceDrop(t, bounce, nBounce, rest);
    return { ...tw.to, z: tw.lane * dv, landV: dv, fallFrom: tw.lane, alpha: 1, lock: 0 };
  }
  return { ...tw.to, z: 0, alpha: 1, lock: lockOf() };   // landed flat, flashing
}

// The share of a bounceDrop() spent in the first fall, before the first
// impact -- the same segment weights bounceDrop uses.
export function fallShare(bounce = 0.12, bounces = 3, rest = 0.55) {
  const n = Math.max(1, Math.min(12, Math.round(bounces)));
  let h = Math.max(bounce, 1e-6), total = 1;
  for (let k = 0; k < n; k++) { total += 2 * Math.sqrt(h); h *= rest; }
  return 1 / total;
}

export function frameAt(plan, now, o = {}) {
  const live = [];
  for (const tw of plan.tweens) {
    const s = sampleTween(tw, now, plan);
    if (s) live.push(s);
  }
  const scene = buildScene(live, o);
  return { ...scene, settled: now >= plan.settleAt, tiles: live };
}

// LIGHT CYCLES (operator, 2026-09-11: "I was thinking like a TRON Light cycle or something
// navigating the block grid from one end of the board to another, and then the line begins
// to fade out quickly? ... moving at 90 degree turns along the blocks from one side to
// another"). A route is a walk along the grid LINES -- the cube edges -- from one edge of the
// board to the opposite one, in unit steps: a run of 2-7 along the way across, then a jink of
// 1-5 to one side, never doubling back and never off the board. Deterministic by seed.
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}
export function cyclePath(seed, W, H, from = 'left') {
  const rnd = lcg(seed);
  const horiz = from === 'left' || from === 'right';
  const sign = from === 'left' || from === 'bottom' ? 1 : -1;
  const lenMain = horiz ? W : H, lenSide = horiz ? H : W;
  let m = sign > 0 ? 0 : lenMain;
  let q = 2 + Math.floor(rnd() * Math.max(1, lenSide - 4));
  const pts = [];
  const push = () => pts.push(horiz ? { x: m, y: q } : { x: q, y: m });
  push();
  const done = () => (sign > 0 ? m >= lenMain : m <= 0);
  while (!done()) {
    const run = Math.min(2 + Math.floor(rnd() * 6), sign > 0 ? lenMain - m : m);
    for (let i = 0; i < run; i++) { m += sign; push(); }
    if (done()) break;
    let dir = rnd() < 0.5 ? -1 : 1;
    const jink = 1 + Math.floor(rnd() * 5);
    if (q + dir * jink < 1 || q + dir * jink > lenSide - 1) dir = -dir;
    const steps = Math.max(0, Math.min(jink, dir > 0 ? lenSide - 1 - q : q - 1));
    for (let i = 0; i < steps; i++) { q += dir; push(); }
  }
  return pts;
}

// LIGHT CYCLES CRASH (operator, 2026-09-11: "if one light cycle crashes into the tail of another
// light cycle, it should de-res (die with visual effects) and the winner keeps going"). Worked out
// once, when the race starts, from both routes and their timing: the race is stepped in small
// slices of the effect; a head that arrives on a grid node the other cycle's live wall covers dies
// there, and two heads on one node at once both die. A dead cycle's wall de-reses and is no
// longer solid, so the other rides on through it. Pure: paths [{ pts, lag }] in, per path
// { u, d, at } or null out.
// `trail`: how much of a cycle's wall is solid, counted back from its head. It is the whole wall
// now (operator, 2026-09-12: the tails last the entire board), so a rider dies on any part of a
// route another cycle has already laid -- which is what the walls look like.
export function cycleCrashes(paths, { trail = Infinity, step = 0.002, runShare = 0.8 } = {}) {
  const n = paths.length;
  const out = paths.map(() => null);
  const len = paths.map((p) => p.pts.length - 1);
  const headAt = (i, u) => { const v = Math.max(0, (u - paths[i].lag) / (1 - paths[i].lag)); return Math.min(1, v / runShare) * len[i]; };
  const key = (p) => `${p.x},${p.y}`;
  for (let s = 0; s * step <= 1 + 1e-9; s++) {
    const u = s * step;
    const d = paths.map((_, i) => (out[i] ? null : headAt(i, u)));
    const hits = [];
    for (let i = 0; i < n; i++) {
      if (d[i] == null || d[i] <= 0) continue;
      const hk = key(paths[i].pts[Math.floor(d[i] + 1e-9)]);
      let hit = false;
      for (let j = 0; j < n && !hit; j++) {
        if (j === i || d[j] == null || d[j] <= 0) continue;
        for (let k = Math.ceil(Math.max(0, d[j] - trail)); k <= Math.floor(d[j] + 1e-9); k++) if (key(paths[j].pts[k]) === hk) { hit = true; break; }
      }
      if (hit) hits.push(i);
    }
    for (const i of hits) { const k = Math.floor(d[i] + 1e-9); out[i] = { u, d: k, at: { ...paths[i].pts[k] } }; }
    if (out.every(Boolean)) break;
  }
  return out;
}

// THE LIGHTNING BALL's route (operator, 2026-09-11, of the data packets: "It comes off more as
// wandering lights. I was hoping for something that comes from off-screen along a grid line, and
// then starts tracing through the grid to the opposite side"). A light-cycle route from one edge
// to the opposite one, run in straight along its first grid line from E units OFF the board and
// out along its last one E units past the far edge, in unit steps throughout.
export function ballPath(seed, W, H, from = 'left', E = 16) {
  const core = cyclePath(seed, W, H, from);
  const a = core[0], b = core[core.length - 1];
  const dx = from === 'left' ? -1 : from === 'right' ? 1 : 0;
  const dy = from === 'bottom' ? -1 : from === 'top' ? 1 : 0;
  const lead = [];
  for (let k = E; k >= 1; k--) lead.push({ x: a.x + dx * k, y: a.y + dy * k });
  const tail = [];
  for (let k = 1; k <= E; k++) tail.push({ x: b.x - dx * k, y: b.y - dy * k });
  return [...lead, ...core, ...tail];
}

// DATA PACKETS: short walks along the grid lines from random points, turning now and then,
// each starting at its own moment (s0, a share of the effect).
export function packetPaths(seed, W, H, n = 8) {
  const rnd = lcg(seed ^ 0x5bd1e995);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const out = [];
  for (let k = 0; k < n; k++) {
    let x = 1 + Math.floor(rnd() * Math.max(1, W - 2)), y = 1 + Math.floor(rnd() * Math.max(1, H - 2));
    let d = dirs[Math.floor(rnd() * 4)];
    const pts = [{ x, y }];
    const len = 6 + Math.floor(rnd() * 9);
    const inside = (a, b) => a >= 0 && a <= W && b >= 0 && b <= H;
    for (let i = 0; i < len; i++) {
      if (i > 0 && rnd() < 0.3) d = rnd() < 0.5 ? [d[1], -d[0]] : [-d[1], d[0]];
      if (!inside(x + d[0], y + d[1])) { d = [-d[1], d[0]]; if (!inside(x + d[0], y + d[1])) break; }
      x += d[0]; y += d[1];
      pts.push({ x, y });
    }
    out.push({ pts, s0: rnd() * 0.55 });
  }
  return out;
}

// The top of the resting cube over each grid cell (0 for the floor): what a route rides on.
export function cellTops(tiles, W, H) {
  const tops = new Float32Array(Math.max(0, W * H));
  for (const t of tiles ?? []) {
    const top = (t.z ?? 0) + (t.floor ?? 0) + cubeHeight(t);
    for (let cy = Math.max(0, t.y); cy < Math.min(H, t.y + t.s); cy++) {
      for (let cx = Math.max(0, t.x); cx < Math.min(W, t.x + t.s); cx++) if (top > tops[cy * W + cx]) tops[cy * W + cx] = top;
    }
  }
  return tops;
}

// Each unit stretch of a route rides the TALLER of the two cells either side of the grid line
// it runs along; where two stretches meet at different heights the wall steps straight up or
// down, so every change -- of direction or of level -- is a right angle.
export function pathHeights(pts, tops, W, H) {
  const top = (cx, cy) => (cx >= 0 && cx < W && cy >= 0 && cy < H ? tops[cy * W + cx] : 0);
  const hs = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    const h = a.y === b.y
      ? Math.max(top(Math.min(a.x, b.x), a.y - 1), top(Math.min(a.x, b.x), a.y))
      : Math.max(top(a.x - 1, Math.min(a.y, b.y)), top(a.x, Math.min(a.y, b.y)));
    hs.push(h + 0.04);
  }
  return hs;
}
