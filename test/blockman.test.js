// BLOCKMAN'S RULES (docs/PLAN-BLOCKMAN.md, M2), played by script rather than looked at.
//
// Every test here drives `stepGame` with frame lengths, the way the screen does, so what is held is
// the game's behaviour at any frame rate: movement into walls, a turn queued before a junction and
// taken early (cornering), the tunnel's wrap, the eat penalty, the scoring, a pellet turning the
// pursuers round, a life lost on contact, and a level that ends when the last dot goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, stepGame, place, nextLevel, restart, remaining, exitsFrom, chooseExit, targetFor, penReleased, elroyGain, wavesFor, speedsFor, frightenedMsFor, DIRS, SCORE, LIVES, CORNER, EAT_PENALTY_MS, ELROY, PEN_DOTS, PEN_IDLE_MS } from '../public/js/blockman.js';
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
  // wherever he ends up, the tile ahead of him is open or he is standing still on a centre
  const ahead = { x: t.x + g.man.dir.x, y: t.y + g.man.dir.y };
  assert.ok(maze.at(ahead.x, ahead.y) === OPEN || g.man.stopped, 'he never walks into a wall');
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
  // it wears off, and they go back to the chase (he is held still, or he eats the next pellet)
  g.speeds = { ...g.speeds, man: 0, pursuer: 0, frightened: 0 };   // nobody moves: this is about the clock
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
    assert.ok(Math.abs(p.y - maze.door.y) <= 4, 'in it, or in the shaft above it');
    assert.equal(maze.atG(Math.floor(p.x), Math.floor(p.y)), OPEN, `${p.id} starts on a tile it may stand on`);
    assert.ok(['pen', 'chase', 'scatter'].includes(p.state));
  }
  assert.equal(g.pursuers.filter((p) => p.state !== 'pen').length, 1, 'one is out to start with');
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

// ------------------------------------------------------------------ M3: the four rules and the waves
const out = (g) => { for (const p of g.pursuers) { p.state = g.mode; p.penMs = 0; } return g; };

test('M3: each of the four heads somewhere different, and each rule is its own', () => {
  const g = started();
  out(g);
  for (const p of g.pursuers) p.state = 'chase';
  g.man.x = 14; g.man.y = 19.5; g.man.dir = DIRS.left;
  const tile = { x: Math.floor(g.man.x), y: Math.floor(g.man.y) };
  const chaser = g.pursuers.find((p) => p.id === 'chaser');
  chaser.x = 6.5; chaser.y = 6.5;
  const t = Object.fromEntries(g.pursuers.map((p) => [p.id, targetFor(g, p)]));
  assert.deepEqual(t.chaser, tile, 'Chaser: straight at his tile');
  assert.deepEqual(t.ambusher, { x: tile.x - 4, y: tile.y }, 'Ambusher: four tiles ahead of him');
  // Flanker: two ahead of him, doubled from Chaser's tile
  assert.deepEqual(t.flanker, { x: (tile.x - 2) * 2 - 6, y: tile.y * 2 - 6 }, 'Flanker: the doubled line');
  // Wanderer: at him from afar, its own corner from close by
  const wanderer = g.pursuers.find((p) => p.id === 'wanderer');
  wanderer.x = 1.5; wanderer.y = 1.5;
  assert.deepEqual(targetFor(g, wanderer), tile, 'far away: at him');
  wanderer.x = tile.x + 2.5; wanderer.y = tile.y + 0.5;
  assert.deepEqual(targetFor(g, wanderer), wanderer.corner, 'close by: off to its corner');
  // no two rules give the same answer here, which is the point of having four
  assert.equal(new Set(Object.values(t).map((v) => `${v.x},${v.y}`)).size, 4);
  // scattering, each heads for its own corner; frightened, nowhere
  for (const p of g.pursuers) { p.state = 'scatter'; assert.deepEqual(targetFor(g, p), p.corner); }
  for (const p of g.pursuers) { p.state = 'frightened'; assert.equal(targetFor(g, p), null); }
});

test('M3: at a junction it takes the exit that ends up nearest its target, never straight back', () => {
  const junction = maze.dots.find((d) => exitsFrom(maze, d, DIRS.left).length >= 2);
  const exits = exitsFrom(maze, junction, DIRS.left);
  // a target beyond each exit in turn is chosen
  for (const e of exits) {
    const far = { x: junction.x + e.x * 6, y: junction.y + e.y * 6 };
    assert.deepEqual(chooseExit(maze, junction, DIRS.left, far), e, 'it walks toward the target');
  }
  assert.equal(chooseExit(maze, junction, DIRS.left, null), exits[0], 'no target: the first way out');
  for (const e of exits) assert.equal(e.x === 1 && e.y === 0, false, 'never straight back');
  // the tunnel's wrap counts: a target just past the left edge is reached by going left
  const t = maze.tunnels.find((x) => x.x < 3);
  const tile = { x: 1, y: t.y };
  if (exitsFrom(maze, tile, DIRS.up).some((d) => d === DIRS.left)) {
    assert.deepEqual(chooseExit(maze, tile, DIRS.up, { x: maze.w - 2, y: t.y }), DIRS.left, 'the near way round');
  }
});

test('M3: the waves alternate scatter and chase, and every change turns them round', () => {
  const g = started();
  out(g);
  const table = wavesFor(1);
  assert.equal(table[0].mode, 'scatter');
  assert.equal(table[1].mode, 'chase');
  assert.equal(table[table.length - 1].ms, Infinity, 'the last chase never ends');
  assert.ok(wavesFor(10)[0].ms < table[0].ms, 'the scatter shortens by level');
  const dirs = g.pursuers.map((p) => ({ ...p.dir }));
  g.waveMs = 20;                                  // on the brink of the change
  g.events.length = 0;
  stepGame(g, 30);
  assert.equal(g.mode, 'chase', 'into the chase');
  assert.equal(g.events.filter((e) => e.kind === 'wave').length, 1);
  for (const [i, p] of g.pursuers.entries()) {
    assert.equal(p.state, 'chase', 'and each one is chasing');
    assert.equal(p.turnedBy, 'wave');
    assert.ok(p.dir.x !== dirs[i].x || p.dir.y !== dirs[i].y, 'each one turned round');
  }
  // a fright pauses the wave clock: a long fright must not swallow a whole chase
  const was = g.waveMs;
  g.frightenedMs = 3000;
  stepGame(g, 60);
  assert.equal(g.waveMs, was, 'the clock held while they were frightened');
});

test('M3: each one leaves the pen on its own dot counter, or when he stops eating', () => {
  const g = started();
  assert.deepEqual(Object.keys(PEN_DOTS).sort(), ['ambusher', 'chaser', 'flanker', 'wanderer']);
  assert.ok(PEN_DOTS.flanker > 0 && PEN_DOTS.wanderer > PEN_DOTS.flanker, 'they come out in order');
  const flanker = g.pursuers.find((p) => p.id === 'flanker');
  flanker.state = 'pen';
  g.eaten = PEN_DOTS.flanker - 1; g.sinceDotMs = 0;
  assert.equal(penReleased(g, flanker), false, 'not yet');
  g.eaten = PEN_DOTS.flanker;
  assert.equal(penReleased(g, flanker), true, 'its counter is met');
  // or the idle timer, for a player who stops eating to wait them out
  g.eaten = 0;
  assert.equal(penReleased(g, flanker), false);
  g.sinceDotMs = PEN_IDLE_MS + 1;
  assert.equal(penReleased(g, flanker), true, 'waiting does not keep them in');
  // and coming out puts it at the door, heading up, in the wave's own mode
  flanker.state = 'pen'; flanker.penMs = 0;
  g.events.length = 0;
  stepGame(g, 16);
  assert.equal(flanker.state, g.mode);
  assert.equal(g.events.filter((e) => e.kind === 'out' && e.who === 'flanker').length, 1);
});

test('M3: Chaser speeds up in two steps as the board empties, and only Chaser', () => {
  const g = started();
  const chaser = g.pursuers.find((p) => p.id === 'chaser');
  const other = g.pursuers.find((p) => p.id === 'ambusher');
  assert.equal(elroyGain(g, chaser), 1, 'a full board: no hurry');
  const keys = [...g.dots];
  g.dots = new Set(keys.slice(0, ELROY[0].left));
  g.pellets = new Set();
  assert.equal(elroyGain(g, chaser), ELROY[0].gain, 'the first step');
  g.dots = new Set(keys.slice(0, ELROY[1].left));
  assert.equal(elroyGain(g, chaser), ELROY[1].gain, 'the second');
  assert.equal(elroyGain(g, other), 1, 'the others keep their pace');
  assert.ok(ELROY[1].gain > ELROY[0].gain && ELROY[1].gain < 1.25, 'a tenth faster at the end, not double');
});

test('M3: a frightened pursuer that recovers joins the wave, not always the chase', () => {
  const g = started();
  out(g);
  g.mode = 'scatter';
  for (const p of g.pursuers) { p.state = 'frightened'; p.frightenedLeftMs = 40; }
  g.frightenedMs = 40;
  stepGame(g, 60);
  assert.equal(g.frightenedMs, 0);
  for (const p of g.pursuers) assert.equal(p.state, 'scatter', 'back to whatever the wave says');
});

test('M3: they actually close in, and nothing ends up inside a wall', () => {
  const g = started();
  out(g);
  for (const p of g.pursuers) p.state = 'chase';
  g.man.x = 14; g.man.y = 19.5; g.man.dir = DIRS.left;
  const chaser = g.pursuers.find((p) => p.id === 'chaser');
  chaser.x = 1.5; chaser.y = 1.5;
  const before = Math.hypot(chaser.x - g.man.x, chaser.y - g.man.y);
  for (let t = 0; t < 4000; t += 16) {
    g.man.want = null;                       // he stands still: this is about the hunt
    const wasPhase = g.phase;
    stepGame(g, 16);
    if (g.phase !== wasPhase) break;         // caught, which is itself the proof
    for (const p of g.pursuers) {
      const tl = { x: Math.floor(p.x), y: Math.floor(p.y) };
      // a pursuer's own idea of open: the pen and its gate are theirs to cross, not his
      assert.equal(maze.atG(tl.x, tl.y), OPEN, `${p.id} walked into a wall at ${tl.x},${tl.y}`);
    }
  }
  const after = Math.hypot(chaser.x - g.man.x, chaser.y - g.man.y);
  assert.ok(after < before || g.phase === 'dying', `Chaser closed in (${before.toFixed(1)} -> ${after.toFixed(1)})`);
});
