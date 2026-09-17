// BLOCKMAN'S RULES (docs/PLAN-BLOCKMAN.md, M2), played by script rather than looked at.
//
// Every test here drives `stepGame` with frame lengths, the way the screen does, so what is held is
// the game's behaviour at any frame rate: movement into walls, a turn queued before a junction and
// taken early (cornering), the tunnel's wrap, the eat penalty, the scoring, a pellet turning the
// pursuers round, a life lost on contact, and a level that ends when the last dot goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, stepGame, place, nextLevel, restart, remaining, exitsFrom, speedsFor, frightenedMsFor, DIRS, SCORE, LIVES, CORNER, EAT_PENALTY_MS } from '../public/js/blockman.js';
import { parseMaze, OPEN } from '../public/js/blockmanmaze.js';

const maze = parseMaze();
const play = (g, ms, step = 16) => { for (let t = 0; t < ms; t += step) stepGame(g, step); return g; };
const started = (opts = {}) => { const g = newGame({ maze, ...opts }); play(g, 1700); return g; };
const tile = (a) => ({ x: Math.floor(a.x), y: Math.floor(a.y) });

test('a new game starts ready, with every dot on the board and three lives', () => {
  const g = newGame({ maze });
  assert.equal(g.phase, 'ready');
  assert.equal(g.lives, LIVES);
  assert.equal(g.score, 0);
  assert.equal(g.level, 1);
  assert.equal(g.dots.size, maze.dots.length);
  assert.equal(g.pellets.size, maze.pellets.length);
  assert.equal(g.man.x, maze.start.x, 'BlockMan on the seam below the pen');
  assert.equal(g.pursuers.length, 4);
  assert.deepEqual(g.pursuers.map((p) => p.name), ['Chaser', 'Ambusher', 'Flanker', 'Wanderer']);
  // the ready pause holds everyone still, then the game runs
  const where = { ...g.man };
  play(g, 400);
  assert.equal(g.man.x, where.x, 'nobody moves while the level is being read');
  play(g, 1600);
  assert.equal(g.phase, 'play');
});

test('BlockMan runs until a wall, and stops at the tile centre', () => {
  const g = started();
  g.man.want = DIRS.up;
  play(g, 3000);
  const t = tile(g.man);
  assert.equal(maze.at(t.x, t.y), OPEN, 'he never ends up inside a wall');
  assert.ok(g.man.stopped || g.man.dir !== DIRS.up, 'either stopped at a wall or turned away from it');
  // and he is on a tile centre when stopped
  if (g.man.stopped) {
    assert.ok(Math.abs(g.man.x - (t.x + 0.5)) < 0.02 && Math.abs(g.man.y - (t.y + 0.5)) < 0.02);
  }
});

test('a turn queued before a junction is taken early: cornering', () => {
  const g = started();
  // a tile with a free way up, and a free way on: he runs west along it and turns up early
  const here = maze.dots.find((d) => maze.at(d.x, d.y - 1) === OPEN && maze.at(d.x - 1, d.y) === OPEN && maze.at(d.x, d.y + 1) === OPEN);
  assert.ok(here, 'the maze has a junction to test on');
  g.man.x = here.x + 0.5 + CORNER * 0.8; g.man.y = here.y + 0.5;    // still short of its centre
  g.man.dir = DIRS.left;
  g.man.want = DIRS.up;
  g.man.eatMs = 0;
  stepGame(g, 16);
  assert.equal(g.man.dir, DIRS.up, 'the turn was taken before the centre');
  assert.ok(Math.abs(g.man.x - (here.x + 0.5)) < 0.02, 'and the off-axis coordinate snapped to the centre');
  assert.ok(CORNER > 0 && CORNER <= 0.6, 'the grace is about half a tile');
  // a turn into a wall is not taken, however early it is pressed
  const wall = maze.dots.find((d) => maze.at(d.x, d.y - 1) !== OPEN && maze.at(d.x - 1, d.y) === OPEN);
  g.man.x = wall.x + 0.5; g.man.y = wall.y + 0.5; g.man.dir = DIRS.left; g.man.want = DIRS.up; g.man.eatMs = 0;
  stepGame(g, 16);
  assert.equal(g.man.dir, DIRS.left, 'he keeps going');
});

test('a reversal is always legal, even mid-corridor', () => {
  const g = started();
  g.man.dir = DIRS.left;
  play(g, 200);
  const x0 = g.man.x;
  g.man.want = DIRS.right;
  play(g, 200);
  assert.equal(g.man.dir, DIRS.right);
  assert.ok(g.man.x > x0, 'he went back the way he came');
});

test('the tunnel wraps, and it is slower for a pursuer than open maze', () => {
  const g = started();
  const t = maze.tunnels[0];
  g.man.x = 0.5; g.man.y = t.y + 0.5; g.man.dir = DIRS.left; g.man.want = null;
  play(g, 200);
  assert.ok(g.man.x > maze.w - 3, `he came out of the other side (${g.man.x.toFixed(1)})`);
  const s = speedsFor(1);
  assert.ok(s.tunnel < s.pursuer, 'the tunnel holds a pursuer back');
});

test('a dot is eaten once, costs a frame, and scores ten', () => {
  const g = started();
  const before = g.dots.size;
  g.events.length = 0;
  g.man.dir = DIRS.left;
  play(g, 500);
  const dotEvents = g.events.filter((e) => e.kind === 'dot');
  assert.ok(dotEvents.length >= 2, 'he ate along the corridor');
  assert.equal(g.score, dotEvents.length * SCORE.dot);
  assert.equal(g.dots.size, before - dotEvents.length, 'each dot goes exactly once');
  assert.ok(EAT_PENALTY_MS > 0, 'and eating costs a little speed, so a full corridor is slower');
  // the same tile again scores nothing
  const score = g.score;
  const t = tile(g.man);
  g.man.x = t.x + 0.5; g.man.y = t.y + 0.5;
  play(g, 60);
  assert.ok(g.score - score <= SCORE.dot, 'no double counting');
});

test('a pellet scores fifty, frightens the pursuers and turns them round', () => {
  const g = started();
  const p = [...g.pellets][0].split(',').map(Number);
  g.pursuers.forEach((q, i) => { q.state = 'chase'; q.x = 6.5 + i; q.y = 1.5; q.dir = DIRS.right; });
  g.man.x = p[0] + 0.5; g.man.y = p[1] + 0.5;
  g.man.eatMs = 0;
  g.events.length = 0;
  stepGame(g, 16);                       // one frame: the reversal is what a pellet does at once
  assert.equal(g.score, SCORE.pellet);
  assert.equal(g.events.filter((e) => e.kind === 'pellet').length, 1);
  assert.ok(g.frightenedMs > 0);
  for (const q of g.pursuers) {
    assert.equal(q.state, 'frightened');
    assert.equal(q.turnedBy, 'pellet', 'each one was turned round by it');
  }
  // it wears off, and they go back to the chase
  play(g, g.frightenedMs + 100);
  assert.equal(g.frightenedMs, 0);
  assert.ok(g.pursuers.every((q) => q.state !== 'frightened'));
  // and by level 19 a pellet only scores
  assert.ok(frightenedMsFor(1) > frightenedMsFor(10) && frightenedMsFor(10) > frightenedMsFor(18));
  assert.equal(frightenedMsFor(19), 0);
});

test('a frightened pursuer is eaten for the 200-1600 ladder, and goes back to the pen', () => {
  const g = started();
  g.frightenedMs = 5000;
  for (const q of g.pursuers) { q.state = 'frightened'; q.frightenedLeftMs = 5000; }
  const scores = [];
  for (const q of g.pursuers) {
    q.x = g.man.x; q.y = g.man.y;                       // walk it into him
    g.events.length = 0;
    stepGame(g, 16);
    // the event, not the score: he may cross a dot on the same frame, and that is 10 of its own
    const ate = g.events.find((e) => e.kind === 'ate');
    assert.ok(ate, 'it was eaten');
    scores.push(ate.points);
    assert.equal(q.state, 'pen', 'and it is back inside');
  }
  assert.deepEqual(scores, SCORE.pursuer, 'the ladder doubles: 200, 400, 800, 1600');
});

test('a pursuer that catches him costs a life, and the third time is game over', () => {
  const g = started();
  g.events.length = 0;
  const hit = () => {
    const p = g.pursuers.find((q) => q.state !== 'pen') ?? g.pursuers[0];
    p.state = 'chase'; p.x = g.man.x; p.y = g.man.y;
    stepGame(g, 16);
  };
  hit();
  assert.equal(g.lives, LIVES - 1);
  assert.equal(g.phase, 'dying');
  assert.equal(g.events.filter((e) => e.kind === 'caught').length, 1);
  play(g, 1400);
  assert.equal(g.phase, 'ready', 'everyone back to their places');
  assert.equal(g.man.x, maze.start.x);
  play(g, 1700);
  hit();
  play(g, 1400 + 1700);
  assert.equal(g.lives, LIVES - 2);
  hit();
  assert.equal(g.lives, 0);
  play(g, 1400);
  assert.equal(g.phase, 'over');
  assert.equal(g.events.filter((e) => e.kind === 'over').length, 1);
  // and the game can be started again from level one
  restart(g);
  assert.equal(g.phase, 'ready');
  assert.equal(g.level, 1);
  assert.equal(g.lives, LIVES);
  assert.equal(g.dots.size, maze.dots.length);
});

test('the level ends when the last dot goes, and the next one is faster', () => {
  const g = started();
  const last = [...g.dots][0];
  g.dots = new Set([last]);
  g.pellets = new Set();
  const [x, y] = last.split(',').map(Number);
  g.man.x = x + 0.5; g.man.y = y + 0.5;
  g.events.length = 0;
  play(g, 40);
  assert.equal(g.phase, 'level');
  assert.equal(g.events.filter((e) => e.kind === 'level').length, 1);
  const was = g.speeds.man;
  play(g, 1500);
  assert.equal(g.level, 2);
  assert.equal(g.dots.size, maze.dots.length, 'the maze is filled again: one layout, harder');
  assert.ok(g.speeds.man >= was, 'and everyone is faster, or as fast');
  assert.equal(g.phase, 'ready');
});

test('an extra life at ten thousand, once', () => {
  const g = started();
  g.score = SCORE.extraLifeAt - SCORE.dot;
  g.man.dir = DIRS.left;
  play(g, 400);
  assert.equal(g.lives, LIVES + 1);
  assert.equal(g.events.filter((e) => e.kind === 'life').length, 1);
  g.score += SCORE.extraLifeAt;
  play(g, 200);
  assert.equal(g.lives, LIVES + 1, 'only the first time');
});

test('the ways out of a tile never double back, and never turn up where the maze forbids it', () => {
  const noUp = new Set(maze.noUp.map((t) => `${t.x},${t.y}`));
  const t = maze.noUp[0];
  const with_ = exitsFrom(maze, t, DIRS.left, { noUp });
  assert.equal(with_.some((d) => d === DIRS.up), false, 'no upward turn on a marked tile');
  const without = exitsFrom(maze, t, DIRS.left, {});
  assert.ok(without.length >= with_.length);
  // never straight back
  for (const dir of [DIRS.up, DIRS.down, DIRS.left, DIRS.right]) {
    for (const e of exitsFrom(maze, { x: 1, y: 1 }, dir)) {
      assert.equal(e.x === -dir.x && e.y === -dir.y, false);
    }
  }
});

test('a whole level can be cleared by script, and nothing ends up inside a wall', () => {
  const g = newGame({ maze });
  play(g, 1700);
  // drive him tile to tile along a route that visits every dot: a flood order is enough
  const order = remaining(g).dots.concat(remaining(g).pellets);
  for (const d of order) {
    g.man.x = d.x + 0.5; g.man.y = d.y + 0.5;
    stepGame(g, 16);
    for (const p of g.pursuers) p.state = 'pen';                 // this test is about the board, not the chase
    const t = tile(g.man);
    assert.equal(maze.at(t.x, t.y), OPEN);
  }
  assert.equal(g.dots.size + g.pellets.size, 0, 'the board is clear');
  assert.equal(g.phase, 'level');
  assert.equal(g.score, maze.dots.length * SCORE.dot + maze.pellets.length * SCORE.pellet);
});

test('place() puts everyone on a legal tile, and the pursuers start in or above the pen', () => {
  const g = newGame({ maze });
  place(g);
  const t = tile(g.man);
  assert.equal(maze.at(t.x, t.y), OPEN);
  for (const p of g.pursuers) {
    assert.ok(Math.abs(p.x - maze.door.x) <= 2, 'at the pen');
    assert.ok(Math.abs(p.y - maze.door.y) <= 2);
    assert.ok(['pen', 'chase'].includes(p.state));
  }
  assert.equal(g.pursuers.filter((p) => p.state === 'chase').length, 1, 'one is out to start with');
});

test('the speed table climbs from level one to five and then holds', () => {
  const a = speedsFor(1), b = speedsFor(5), c = speedsFor(20);
  assert.ok(a.man < b.man, 'level 5 is faster than level 1');
  assert.equal(b.man, c.man, 'and level 20 is level 5: the difficulty is the waves, not the speed');
  for (const s of [a, b, c]) {
    assert.ok(s.frightened < s.pursuer, 'frightened is slower');
    assert.ok(s.man > s.pursuer, 'BlockMan outruns them, just');
  }
});
