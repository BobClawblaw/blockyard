// BLOCKOUT, the rules (operator, 2026-09-12: "take the classic Atari Breakout game, and make a
// clone of it, in another tab, using our engine, with mouse control for moving the pad left and
// right. Call it 'Blockout'").
//
// Like tetris.js, this file is the RULES and nothing else: no DOM, no canvas, no clock, and no
// Math.random -- a launch angle is an argument. A game is a plain object and every move is a
// function on it, so the whole of it runs under node:test and a rally can be asserted step by
// step. What is drawn, and when, is blockout.js's business.
//
// Coordinates follow the engine's board: x runs left to right, y runs UP from row 0 on the floor.
// The paddle sits near the floor and the bricks are stacked at the top, so the ball travels toward
// +y to break something -- the opposite of most Breakout code, and on purpose: the engine draws
// row 0 at the bottom of the screen, so the rules speak the renderer's language.

export const COLS = 16;
export const ROWS = 24;

export const PADDLE_W = 4;        // grid units; drawn as four 1x1 stones
export const PADDLE_Y = 1;        // the row the paddle stands on
export const PADDLE_H = 0.55;
export const BALL_S = 0.84;       // the ball is a small cube, like everything else here
export const BALL_R = BALL_S / 2;
export const LIVES = 3;

// Six rows, cheap at the bottom and dear at the top -- the classic pay-out, and the reason to dig
// a channel up one side and let the ball loose in the roof. Index 0 is the LOWEST row.
export const ROW_SPEC = Object.freeze([
  Object.freeze({ color: '#f5d142', points: 1 }),
  Object.freeze({ color: '#f5d142', points: 1 }),
  Object.freeze({ color: '#2ecc8f', points: 3 }),
  Object.freeze({ color: '#2ecc8f', points: 3 }),
  Object.freeze({ color: '#f7931a', points: 5 }),
  Object.freeze({ color: '#ef5a5a', points: 7 }),
]);
export const BRICK_ROWS = ROW_SPEC.length;
export const BRICK_TOP = ROWS - 3;              // the top row sits three under the ceiling

export const PADDLE_COLOR = '#3ec9ff';
export const BALL_COLOR = '#f2f7ff';

const BASE_SPEED = 11;            // grid units a second at level 1
const LEVEL_SPEEDUP = 1.09;
const MAX_BOUNCE = 1.05;          // radians off vertical at the very edge of the paddle
const MAX_STEP = 0.3;             // the furthest the ball may move in one substep (see step)

/** How fast the ball travels at this level, in grid units a second. */
export function speed(level) { return BASE_SPEED * Math.pow(LEVEL_SPEEDUP, Math.max(0, level - 1)); }

function layout(g) {
  g.bricks = [];
  for (let r = 0; r < BRICK_ROWS; r++) {
    const spec = ROW_SPEC[r];
    const y = BRICK_TOP - (BRICK_ROWS - 1) + r;          // r = 0 is the lowest row
    for (let x = 0; x < COLS; x++) g.bricks.push({ id: g.nextId++, x, y, color: spec.color, points: spec.points });
  }
}

/** Park the ball on the paddle, waiting for a launch. */
export function resetBall(g) {
  g.ball = { x: g.paddle.x + g.paddle.w / 2, y: PADDLE_Y + PADDLE_H + BALL_R + 0.05, vx: 0, vy: 0, r: BALL_R, stuck: true };
  return g.ball;
}

export function newGame(level = 1) {
  const g = {
    cols: COLS, rows: ROWS,
    level, score: 0, lives: LIVES, over: false, cleared: false,
    paddle: { x: (COLS - PADDLE_W) / 2, w: PADDLE_W },
    ball: null, bricks: [], nextId: 1,
  };
  layout(g);
  resetBall(g);
  return g;
}

/** The next level: the same wall again, a faster ball, the score and lives carried over. */
export function advance(g) {
  g.level++;
  g.cleared = false;
  layout(g);
  resetBall(g);
  return g;
}

/** Put the paddle's CENTRE here, clamped to the board. A stuck ball rides along with it. */
export function movePaddle(g, centreX) {
  if (g.over) return g.paddle.x;
  const half = g.paddle.w / 2;
  g.paddle.x = Math.max(0, Math.min(COLS - g.paddle.w, centreX - half));
  if (g.ball?.stuck) g.ball.x = g.paddle.x + half;
  return g.paddle.x;
}

/** Shove the paddle by dx units (the keyboard). */
export function nudge(g, dx) { return movePaddle(g, g.paddle.x + g.paddle.w / 2 + dx); }

/**
 * Send the ball on its way. `angle` is radians off straight up, positive to the right -- an
 * argument rather than a random, so a test can play a whole rally and know where the ball went.
 */
export function launch(g, angle = 0.3) {
  if (g.over || !g.ball?.stuck) return false;
  const s = speed(g.level);
  const a = Math.max(-MAX_BOUNCE, Math.min(MAX_BOUNCE, angle));
  g.ball.vx = Math.sin(a) * s;
  g.ball.vy = Math.cos(a) * s;
  g.ball.stuck = false;
  return true;
}

// The ball leaves the paddle at an angle set by WHERE it lands: dead centre goes straight up, the
// edges fire off at MAX_BOUNCE. That single rule is what makes Breakout a game of aim rather than
// a game of waiting, so it is worth stating plainly.
function offPaddle(g) {
  const b = g.ball, p = g.paddle;
  const off = Math.max(-1, Math.min(1, (b.x - (p.x + p.w / 2)) / (p.w / 2)));
  const s = Math.hypot(b.vx, b.vy) || speed(g.level);
  const a = off * MAX_BOUNCE;
  b.vx = Math.sin(a) * s;
  b.vy = Math.abs(Math.cos(a) * s);        // always upward: a graze must never drag it down
  b.y = PADDLE_Y + PADDLE_H + b.r;
}

function hitBrick(g, hits) {
  const b = g.ball;
  for (let i = 0; i < g.bricks.length; i++) {
    const k = g.bricks[i];
    const ox = Math.min(b.x + b.r, k.x + 1) - Math.max(b.x - b.r, k.x);
    const oy = Math.min(b.y + b.r, k.y + 1) - Math.max(b.y - b.r, k.y);
    if (ox <= 0 || oy <= 0) continue;
    // out on the axis it is least buried in, so a corner clip does not send it back the way it came
    if (ox < oy) { b.vx = b.x < k.x + 0.5 ? -Math.abs(b.vx) : Math.abs(b.vx); b.x += b.vx > 0 ? ox : -ox; }
    else { b.vy = b.y < k.y + 0.5 ? -Math.abs(b.vy) : Math.abs(b.vy); b.y += b.vy > 0 ? oy : -oy; }
    g.bricks.splice(i, 1);
    g.score += k.points;
    hits.push({ kind: 'brick', x: k.x, y: k.y, color: k.color, points: k.points });
    return true;                            // one brick a substep: two reflections in one step is a jitter
  }
  return false;
}

function substep(g, h, hits) {
  const b = g.ball;
  b.x += b.vx * h;
  b.y += b.vy * h;

  if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); hits.push({ kind: 'wall' }); }
  else if (b.x + b.r > COLS) { b.x = COLS - b.r; b.vx = -Math.abs(b.vx); hits.push({ kind: 'wall' }); }
  if (b.y + b.r > ROWS) { b.y = ROWS - b.r; b.vy = -Math.abs(b.vy); hits.push({ kind: 'wall' }); }

  const p = g.paddle;
  if (b.vy < 0 && b.y - b.r <= PADDLE_Y + PADDLE_H && b.y + b.r >= PADDLE_Y
      && b.x + b.r >= p.x && b.x - b.r <= p.x + p.w) {
    offPaddle(g);
    hits.push({ kind: 'paddle' });
  }

  hitBrick(g, hits);

  if (b.y + b.r < 0) {                      // through the floor: a life
    g.lives -= 1;
    hits.push({ kind: 'life' });
    if (g.lives <= 0) { g.over = true; g.ball.stuck = true; g.ball.vx = 0; g.ball.vy = 0; }
    else resetBall(g);
    return true;
  }
  return false;
}

/**
 * Advance the rally by dtMs. Returns what happened, for the screen to make noises about.
 *
 * SUBSTEPPED, because a ball moving eleven units a second crosses a one-unit brick in 90 ms and
 * would tunnel clean through the wall on a slow frame. The move is cut into hops of at most
 * MAX_STEP units and each is resolved on its own, so the collisions do not depend on the frame
 * rate -- which is also what lets a test run a rally at one big dt and get the same answer.
 */
export function step(g, dtMs) {
  const hits = [];
  if (g.over || !g.ball || g.ball.stuck) return { hits, lost: false, cleared: g.cleared };
  // was the wall still standing when this step began? "Cleared" is the TRANSITION -- a court that
  // was already empty was never cleared, it was just empty, and treating the two alike parks the
  // ball for ever (and would loop the level-done screen on a wall that somehow started bare)
  const standing = g.bricks.length > 0;
  const dt = Math.min(60, Math.max(0, dtMs)) / 1000;
  const sp = Math.hypot(g.ball.vx, g.ball.vy) || 1;
  const n = Math.max(1, Math.ceil((sp * dt) / MAX_STEP));
  const h = dt / n;
  let lost = false;
  for (let i = 0; i < n && !lost && !g.over; i++) lost = substep(g, h, hits);
  if (standing && !g.bricks.length) { g.cleared = true; g.ball.stuck = true; }
  return { hits, lost, cleared: g.cleared };
}

/**
 * The board as tiles for the 3D engine: every brick a stone in its row's colour, the paddle as
 * four low stones, and the ball a small cube. Bricks are exactly one grid cell, so a brick IS a
 * tile -- which is the whole reason this game fits the engine without a translation layer.
 */
export function tiles(g) {
  const out = [];
  for (const k of g.bricks) out.push({ txid: `b${k.id}`, x: k.x, y: k.y, s: 1, tall: 1, color: k.color });
  const p = g.paddle;
  for (let i = 0; i < Math.round(p.w); i++) {
    out.push({ txid: `pad${i}`, x: p.x + i, y: PADDLE_Y, s: 1, tall: PADDLE_H, color: PADDLE_COLOR, paddle: true });
  }
  const b = g.ball;
  // `sphere`: the engine draws this one round instead of as a cube (operator: "Can we have a ball
  // for blockout instead of a block for the bouncing dot?")
  if (b) out.push({ txid: 'ball', x: b.x - BALL_R, y: b.y - BALL_R, s: BALL_S, tall: BALL_S, color: BALL_COLOR, ball: true, sphere: true });
  return out;
}

/** How much of the wall is left, 0..1 — the HUD's progress figure. */
export function remaining(g) { return g.bricks.length / (BRICK_ROWS * COLS); }
