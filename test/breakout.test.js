// BLOCKOUT, the rules under test (operator, 2026-09-12: "take the classic Atari Breakout game, and
// make a clone of it ... using our engine, with mouse control"). breakout.js knows nothing of the
// screen and takes its launch angle as an argument rather than rolling one, so a whole rally can be
// played here and asserted step by step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COLS, ROWS, LIVES, PADDLE_W, PADDLE_Y, PADDLE_D, PADDLE_H, BALL_R, BRICK_ROWS, ROW_SPEC,
  newGame, advance, step, movePaddle, nudge, launch, tiles, remaining, speed, resetBall,
} from '../public/js/breakout.js';
import { debrisTiles } from '../public/js/blockout.js';

const play = (g, ms, slice = 16) => { let out = []; for (let t = 0; t < ms; t += slice) out.push(...step(g, slice).hits); return out; };

test('a new game: a full wall, three lives, the bat centred and the ball resting on it', () => {
  const g = newGame();
  assert.equal(g.bricks.length, BRICK_ROWS * COLS, 'every row full');
  assert.equal(g.lives, LIVES);
  assert.equal(g.score, 0);
  assert.equal(g.paddle.x + g.paddle.w / 2, COLS / 2, 'the bat starts in the middle');
  assert.equal(g.ball.stuck, true, 'the ball waits to be served');
  assert.equal(g.ball.y - BALL_R, PADDLE_Y + PADDLE_D,
    'it rests exactly ON the bat: the near edge of the ball touches the far edge of the bat, with no overlap');
  assert.ok(PADDLE_H < PADDLE_D, 'the bat\'s height and its depth are different things; using the height as the depth sank the ball into it');
  assert.ok(g.bricks.every((b) => b.y > PADDLE_Y + 4), 'the wall is well clear of the bat');
  const rows = [...new Set(g.bricks.map((b) => b.y))].sort((a, b) => a - b);
  assert.equal(rows.length, BRICK_ROWS);
  const bottom = g.bricks.filter((b) => b.y === rows[0])[0];
  const top = g.bricks.filter((b) => b.y === rows.at(-1))[0];
  assert.equal(bottom.points, ROW_SPEC[0].points, 'cheap at the bottom');
  assert.equal(top.points, ROW_SPEC.at(-1).points, 'dear at the top');
  assert.ok(top.points > bottom.points);
});

test('the bat moves with a pointer and with keys, and cannot leave the court', () => {
  const g = newGame();
  movePaddle(g, 0);
  assert.equal(g.paddle.x, 0, 'hard against the left wall');
  movePaddle(g, COLS);
  assert.equal(g.paddle.x, COLS - PADDLE_W, 'and the right, still fully on the board');
  movePaddle(g, 8);
  assert.equal(g.paddle.x + g.paddle.w / 2, 8, 'the pointer sets the CENTRE of the bat');
  nudge(g, -2);
  assert.equal(g.paddle.x + g.paddle.w / 2, 6, 'a key shoves it by that many units');
  assert.equal(g.ball.x, g.paddle.x + g.paddle.w / 2, 'a resting ball rides along with the bat');
});

test('a served ball leaves the bat upward, and the angle is the caller\'s, never a random', () => {
  const g = newGame();
  assert.equal(step(g, 16).hits.length, 0, 'nothing happens while it is stuck');
  assert.equal(launch(g, 0.3), true);
  assert.ok(g.ball.vy > 0, 'upward, toward the wall');
  assert.ok(g.ball.vx > 0, 'and to the right, as asked');
  assert.equal(launch(g, 0.3), false, 'a ball already in play cannot be served again');
  const h = newGame();
  launch(h, -0.3);
  assert.ok(h.ball.vx < 0, 'the other way when asked the other way');
  assert.ok(Math.abs(Math.hypot(h.ball.vx, h.ball.vy) - speed(1)) < 1e-9, 'at the level\'s speed');
  assert.ok(speed(3) > speed(1), 'and later levels are faster');
});

test('the ball bounces off the walls and the ceiling, and keeps its speed', () => {
  const g = newGame();
  g.bricks = [];                                    // an empty court: only the walls can be hit
  launch(g, 0.9);
  const s0 = Math.hypot(g.ball.vx, g.ball.vy);
  const kinds = play(g, 3000).map((h) => h.kind);
  assert.ok(kinds.includes('wall'), 'it found a wall');
  assert.ok(g.ball.x >= BALL_R - 1e-6 && g.ball.x <= COLS - BALL_R + 1e-6, 'and never left the court');
  assert.ok(g.ball.y <= ROWS - BALL_R + 1e-6, 'nor went through the ceiling');
  assert.ok(Math.abs(Math.hypot(g.ball.vx, g.ball.vy) - s0) < 1e-6, 'a bounce does not change its speed');
});

test('where the ball lands on the bat decides where it goes: that is the whole game', () => {
  const hit = (offset) => {
    const g = newGame();
    g.bricks = [];
    movePaddle(g, 8);
    // drop it straight down onto the bat at `offset` units from the middle
    resetBall(g);
    g.ball.stuck = false;
    g.ball.x = 8 + offset;
    g.ball.y = PADDLE_Y + PADDLE_D + BALL_R + 0.2;
    g.ball.vx = 0; g.ball.vy = -speed(1);
    // step until it bounces: at eleven units a second it covers 0.18 of a unit in a 16 ms frame,
    // so a single frame does not carry it the last fifth of a unit onto the bat
    for (let i = 0; i < 40 && g.ball.vy < 0; i++) step(g, 16);
    return g.ball;
  };
  const left = hit(-1.8), middle = hit(0), right = hit(1.8);
  assert.ok(left.vy > 0 && middle.vy > 0 && right.vy > 0, 'every one comes back up');
  assert.ok(left.vx < -1, 'the left edge sends it left');
  assert.ok(Math.abs(middle.vx) < 1e-6, 'dead centre sends it straight up');
  assert.ok(right.vx > 1, 'and the right edge right');
});

test('a brick breaks, pays its row, and turns the ball around', () => {
  const g = newGame();
  const target = g.bricks.find((b) => b.y === Math.min(...g.bricks.map((k) => k.y)));
  const before = g.bricks.length;
  g.ball.stuck = false;
  g.ball.x = target.x + 0.5;
  g.ball.y = target.y - BALL_R - 0.05;
  g.ball.vx = 0; g.ball.vy = speed(1);
  const hits = step(g, 16).hits.filter((h) => h.kind === 'brick');
  assert.equal(hits.length, 1, 'exactly one brick a step: two reflections at once is a jitter');
  assert.equal(g.bricks.length, before - 1, 'it is gone from the wall');
  assert.equal(g.score, target.points, 'and paid its row');
  assert.ok(g.ball.vy < 0, 'the ball came back down');
  assert.equal(hits[0].color, target.color, 'the hit names the colour, for the screen to celebrate');
});

test('a fast ball cannot tunnel through the wall, however coarse the frame', () => {
  // step() already clamps a long frame to 60 ms, so the guarantee to prove is the one INSIDE that
  // clamp: at 80 units a second the ball covers 4.8 units in one frame, which would carry it clean
  // over a 1-unit brick in a single hop if the move were not cut into substeps.
  const g = newGame();
  const target = g.bricks.find((b) => b.y === Math.min(...g.bricks.map((k) => k.y)));
  g.ball.stuck = false;
  g.ball.x = target.x + 0.5;
  g.ball.y = target.y - 1.2;                          // just under the wall
  g.ball.vx = 0; g.ball.vy = 80;
  const before = g.bricks.length;
  const hits = step(g, 60).hits;
  assert.ok(g.bricks.length < before, 'it broke a brick instead of stepping over it');
  assert.ok(hits.some((h) => h.kind === 'brick'));
  assert.ok(g.ball.vy < 0, 'and came back down off it');
  assert.ok(g.ball.y <= ROWS, 'still on the board');
});

test('through the floor costs a life; the last one ends the game and the ball stops', () => {
  const g = newGame();
  const drop = () => {
    g.ball.stuck = false;
    g.ball.x = 0.5;                                   // away from the bat, which sits in the middle
    g.ball.y = 0.2;
    g.ball.vx = 0; g.ball.vy = -speed(1);
    return step(g, 60).hits.some((h) => h.kind === 'life');
  };
  assert.equal(drop(), true);
  assert.equal(g.lives, LIVES - 1);
  assert.equal(g.ball.stuck, true, 'the next ball waits on the bat');
  drop(); drop();
  assert.equal(g.lives, 0);
  assert.equal(g.over, true);
  assert.equal(g.ball.vx, 0); assert.equal(g.ball.vy, 0, 'and it stops dead');
  assert.deepEqual(step(g, 16).hits, [], 'nothing moves after the end');
  assert.equal(launch(g, 0), false, 'and it cannot be served again');
});

test('clearing the wall ends the level, and the next one is faster with the score kept', () => {
  const g = newGame();
  g.score = 400;
  g.bricks = [g.bricks[0]];
  g.ball.stuck = false;
  g.ball.x = g.bricks[0].x + 0.5;
  g.ball.y = g.bricks[0].y - BALL_R - 0.05;
  g.ball.vx = 0; g.ball.vy = speed(1);
  const r = step(g, 16);
  assert.equal(r.cleared, true, 'the wall is down');
  assert.equal(g.ball.stuck, true, 'and the ball is parked');
  const lvl = g.level;
  advance(g);
  assert.equal(g.level, lvl + 1);
  assert.equal(g.bricks.length, BRICK_ROWS * COLS, 'a fresh wall');
  assert.equal(g.score, 400 + ROW_SPEC[0].points, 'the score carries over');
  assert.equal(g.cleared, false);
  assert.ok(speed(g.level) > speed(lvl), 'and the ball is quicker');
});

test('the tiles for the engine: a brick IS a grid cell, the bat is four stones, the ball a small cube', () => {
  const g = newGame();
  movePaddle(g, 8);
  const t = tiles(g);
  const bricks = t.filter((x) => !x.paddle && !x.ball);   // 'ball' starts with a b as well
  const pad = t.filter((x) => x.paddle);
  const ball = t.find((x) => x.ball);
  assert.equal(bricks.length, g.bricks.length);
  assert.ok(bricks.every((b) => b.s === 1 && b.tall === 1), 'one grid cell each: no translation layer');
  assert.equal(pad.length, PADDLE_W, 'the bat is one stone per unit of its width');
  assert.ok(pad.every((p) => p.y === PADDLE_Y && p.tall < 1), 'lying flat on the floor row');
  assert.ok(ball && ball.s < 1 && ball.s === ball.tall, 'the ball is small and square-footed');
  assert.equal(ball.sphere, true, 'and asks the engine to draw it ROUND, not as a block');
  assert.ok(t.every((x) => typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color)), 'every colour is a six-digit hex, as the engine requires');
  assert.ok(t.every((x) => x.x >= -0.5 && x.x <= COLS && x.y >= 0 && x.y <= ROWS), 'and everything is on the board');
  assert.equal(remaining(newGame()), 1, 'a full wall is all of it');
  const h = newGame(); h.bricks = h.bricks.slice(0, h.bricks.length / 2);
  assert.equal(remaining(h), 0.5);
});

test('a playfield refuses hover: the pointer does not light the bat, tooltip it, or navigate', () => {
  // (operator, 2026-09-12: "In blockout, don't highlite the paddle block controller when I mouse
  // over it".) On a data board the pointer picks out a transaction and a click opens it in the
  // explorer; on a playfield the pointer is holding the bat and a click serves the ball, so the
  // whole hover behaviour is switched off for both games.
  const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
  const engine = read('details3d.js');
  assert.match(engine, /st\.noHover = opts\.hover === false;/, 'the engine reads the option onto the canvas state');
  // gated in the move handler AND the click handler, or the bat still glows / the board navigates
  const move = engine.match(/addEventListener\('pointermove'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  const click = engine.match(/addEventListener\('click'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  assert.match(move, /if \(st\.noHover\) return;/, 'no glow, no tooltip, no pointer cursor');
  assert.match(click, /if \(st\.noHover\) return;/, 'and no navigation off a playfield');
  for (const game of ['blockout.js', 'tetrust.js']) {
    assert.match(read(game), /hover: false/, `${game} asks for it`);
  }
});

test('a broken brick flies up and off the court instead of vanishing', () => {
  // (operator, 2026-09-12: "have the blocks fly up and off the screen when they are hit, instead
  // of disappearing") -- the same launch Tetrust's cleared lines take.
  const debris = [
    { id: 1, x: 2, y: 18, color: '#ef5a5a', dx: -0.6, t0: 1000 },
    { id: 2, x: 13, y: 18, color: '#ef5a5a', dx: 0.6, t0: 1000 },
  ];
  const at = (now) => debrisTiles(debris, now, 900);
  const start = at(1000), mid = at(1450), late = at(1800);
  assert.equal(start.length, 2);
  assert.equal(start[0].floor, 0, 'it starts where the brick was');
  assert.equal(start[0].color, '#ef5a5a', 'in the brick\'s own colour');
  assert.ok(mid[0].floor > 8, `halfway it is well off the wall (${mid[0].floor})`);
  assert.equal(mid[0].color, '#ef5a5a', 'and still full colour: it leaves, it does not dissolve in place');
  assert.ok(mid[0].x < 2 && mid[1].x > 13, 'each drifts to its own side of the court');
  assert.ok(late[0].floor > mid[0].floor && late[0].floor > 40, 'and keeps rising, past the top');
  assert.deepEqual(at(1900), [], 'gone at the end');
  assert.ok(start.every((t) => t.s === 1 && t.tall === 1 && t.txid.startsWith('k')), 'ordinary stones with their own ids');
});
