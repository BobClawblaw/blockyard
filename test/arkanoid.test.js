// BLOCKANOID, the rules under test (operator, 2026-09-12: "Take blockout, and make rip off of
// Arkanoid using our engine, and make it a new Diversion called 'Blockanoid'").
//
// arkanoid.js knows nothing of the screen, takes its launch angle as an argument, and decides which
// brick carries a capsule with a HASH rather than a roll -- so a whole run is reproducible here and
// "this wall drops a laser from that brick" is an assertable fact rather than a hope.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLS, ROWS, LIVES, PADDLE_W, PADDLE_W_WIDE, PADDLE_Y, PADDLE_D, PADDLE_H, BALL_R,
  LEVELS, CAPSULES, CAPSULE_POINTS, GOLD, SILVER,
  newGame, advance, step, movePaddle, nudge, launch, fire, tiles, remaining, powers,
  speed, resetBall, resetVaus, setOptions, breakable, silverHits, capsuleFor, hash01,
  layoutFor, applyCapsule, capsuleTiles,
} from '../public/js/arkanoid.js';

/** Put a ball just under a brick, travelling up hard enough to reach it in one step. */
const aimAt = (g, k, v = speed(g.level)) => {
  const b = g.balls[0];
  b.stuck = false;
  b.x = k.x + 0.5;
  b.y = k.y - BALL_R - 0.05;
  b.vx = 0; b.vy = v;
  return b;
};

test('a new game: the level-1 wall, three lives, Vaus centred and the ball resting on it', () => {
  const g = newGame();
  const rows = layoutFor(1);
  const wanted = rows.join('').split('').filter((c) => c !== '.').length;
  assert.equal(g.bricks.length, wanted, 'every cell the layout names is a brick');
  assert.equal(g.lives, LIVES);
  assert.equal(g.score, 0);
  assert.equal(g.paddle.w, PADDLE_W, 'Vaus starts at stock width');
  assert.equal(g.paddle.x + g.paddle.w / 2, COLS / 2, 'and in the middle');
  assert.equal(g.balls.length, 1);
  assert.equal(g.balls[0].stuck, true, 'the ball waits to be served');
  assert.equal(g.balls[0].y - BALL_R, PADDLE_Y + PADDLE_D,
    'it rests exactly ON the bat, as Blockout learned the hard way: no overlap');
  assert.ok(PADDLE_H < PADDLE_D, 'the bat\'s height and its depth are still different things');
  assert.ok(g.bricks.every((b) => b.y > PADDLE_Y + 4), 'the wall is well clear of Vaus');
});

test('every shipped wall fits the court and leaves something to break', () => {
  for (let i = 0; i < LEVELS.length; i++) {
    const rows = LEVELS[i];
    for (const line of rows) assert.ok(line.length <= COLS, `level ${i + 1} row fits in ${COLS} columns`);
    const g = newGame(i + 1);
    assert.ok(breakable(g).length > 0, `level ${i + 1} can actually be cleared`);
    assert.ok(g.bricks.every((b) => b.y >= 0 && b.y < ROWS), `level ${i + 1} is on the board`);
  }
  assert.equal(layoutFor(LEVELS.length + 1), LEVELS[0], 'past the last wall the levels cycle');
});

test('gold never breaks, and never stands between you and the next level', () => {
  const g = newGame(2);                                  // level 2 carries gold
  const gold = g.bricks.find((b) => b.kind === 'gold');
  assert.ok(gold, 'this wall has gold in it');
  aimAt(g, gold);
  const hits = step(g, 16).hits;
  assert.ok(hits.some((h) => h.kind === 'gold'), 'it rings');
  assert.ok(g.bricks.includes(gold), 'and it is still standing');
  assert.equal(g.score, 0, 'gold pays nothing');
  assert.equal(gold.color, GOLD.color);
  // The level ends when the BREAKABLE bricks are gone; gold is scenery. The survivor has to be
  // PLAIN, not merely "not gold": silver takes two hits by design, so leaving a silver brick and
  // striking it once leaves it standing and the wall legitimately uncleared -- which would be a
  // fact about silver, not about gold. (It is exactly what the first version of this test did.)
  const plain = g.bricks.find((b) => b.kind === 'plain');
  g.bricks = g.bricks.filter((b) => b.kind === 'gold' || b === plain);
  aimAt(g, plain);
  const r = step(g, 16);
  assert.equal(r.cleared, true, 'cleared with gold still on the board');
  assert.ok(g.bricks.some((b) => b.kind === 'gold'), 'which it is');
});

test('silver takes more than one hit, and shows its wear', () => {
  const g = newGame(2);
  const silver = g.bricks.find((b) => b.kind === 'silver');
  assert.ok(silver, 'this wall has silver in it');
  assert.equal(silver.hits, silverHits(2));
  assert.equal(silver.color, SILVER.color);
  const before = g.bricks.length;
  aimAt(g, silver);
  const first = step(g, 16).hits;
  assert.ok(first.some((h) => h.kind === 'silver'), 'the first hit rings rather than breaks');
  assert.equal(g.bricks.length, before, 'still standing');
  assert.equal(g.score, 0, 'and pays nothing yet');
  const worn = tiles(g).find((t) => t.txid === `b${silver.id}`);
  assert.ok(worn.tall < 1, 'a damaged silver brick stands lower: the wall shows its own wear');
  // finish it off
  while (g.bricks.includes(silver)) { aimAt(g, silver); step(g, 16); }
  assert.ok(g.score >= SILVER.points, 'and pays when it finally goes');
  assert.ok(silverHits(5) > silverHits(1), 'silver gets harder as the levels climb');
});

test('which brick carries a capsule is a HASH, not a roll: the same wall drops the same letters', () => {
  const a = newGame(1), b = newGame(1);
  const capsA = a.bricks.map((k) => capsuleFor(k, 1));
  const capsB = b.bricks.map((k) => capsuleFor(k, 1));
  assert.deepEqual(capsA, capsB, 'twice the same wall, twice the same capsules');
  assert.notDeepEqual(capsA, a.bricks.map((k) => capsuleFor(k, 2)), 'a different level, different capsules');
  const carried = capsA.filter(Boolean);
  assert.ok(carried.length > 0, 'some bricks carry one');
  assert.ok(carried.length < a.bricks.length, 'and most do not');
  assert.ok(carried.every((c) => CAPSULES.includes(c)), 'and every one is a real capsule');
  assert.ok(hash01('x') >= 0 && hash01('x') < 1, 'the hash is a unit interval');
  assert.equal(hash01('x'), hash01('x'), 'and stable');
});

test('each capsule keeps its own promise', () => {
  const wide = newGame(); applyCapsule(wide, 'enlarge');
  assert.equal(wide.paddle.w, PADDLE_W_WIDE, 'E widens Vaus');
  assert.ok(wide.paddle.x >= 0 && wide.paddle.x + wide.paddle.w <= COLS, 'and it stays on the board');

  const life = newGame(); applyCapsule(life, 'player');
  assert.equal(life.lives, LIVES + 1, 'P is a life');

  const laser = newGame(); applyCapsule(laser, 'laser');
  assert.equal(laser.laser, true);
  applyCapsule(laser, 'catch');
  assert.equal(laser.laser, false, 'C puts the laser away: Vaus does one thing at a time');
  assert.equal(laser.catch, true);

  const slow = newGame(); launch(slow, 0); const fast = Math.hypot(slow.balls[0].vx, slow.balls[0].vy);
  applyCapsule(slow, 'slow');
  assert.ok(Math.hypot(slow.balls[0].vx, slow.balls[0].vy) < fast, 'S slows the ball already in play');

  const three = newGame(); launch(three, 0.2); applyCapsule(three, 'disrupt');
  assert.equal(three.balls.length, 3, 'D puts three on the court');
  assert.ok(three.balls.every((b) => Math.abs(Math.hypot(b.vx, b.vy) - Math.hypot(three.balls[0].vx, three.balls[0].vy)) < 1e-6),
    'all at the same speed: a split, not a slow-down');

  const skip = newGame(); applyCapsule(skip, 'break');
  assert.equal(skip.cleared, true, 'B ends the wall');

  const paid = newGame(); const s0 = paid.score; applyCapsule(paid, 'player');
  assert.equal(paid.score, s0 + CAPSULE_POINTS, 'and taking one always pays');
});

test('a capsule falls, and is caught only by Vaus', () => {
  const g = newGame();
  g.capsules = [{ id: 1, kind: 'player', x: g.paddle.x, y: 10 }];
  const y0 = g.capsules[0].y;
  step(g, 60);
  assert.ok(g.capsules[0].y < y0, 'it falls');
  // drop it onto Vaus
  g.capsules[0].y = PADDLE_Y + PADDLE_D + 0.05;
  const hits = step(g, 60).hits;
  assert.ok(hits.some((h) => h.kind === 'capsule' && h.capsule === 'player'), 'caught');
  assert.equal(g.capsules.length, 0);
  assert.equal(g.lives, LIVES + 1, 'and it did what it says');

  const miss = newGame();
  movePaddle(miss, 1);                                   // Vaus hard left
  miss.capsules = [{ id: 2, kind: 'player', x: COLS - 2, y: 1 }];
  for (let i = 0; i < 40 && miss.capsules.length; i++) step(miss, 60);
  assert.equal(miss.capsules.length, 0, 'a missed capsule leaves the court');
  assert.equal(miss.lives, LIVES, 'and gives nothing');
});

test('the laser fires, cools down, and breaks what it hits', () => {
  const g = newGame();
  assert.deepEqual(fire(g), [], 'no laser, no shot');
  applyCapsule(g, 'laser');
  const shot = fire(g);
  assert.equal(shot.length, 2, 'two bolts, one from each edge of Vaus');
  assert.deepEqual(fire(g), [], 'and it has to cool down');
  step(g, 60); step(g, 60); step(g, 60); step(g, 60); step(g, 60);
  assert.equal(fire(g).length, 2, 'then it fires again');

  const hit = newGame();
  applyCapsule(hit, 'laser');
  const target = hit.bricks.reduce((lo, b) => (b.y < lo.y ? b : lo));
  movePaddle(hit, target.x + 0.5);
  hit.bolts = [{ id: 99, x: target.x + 0.5, y: target.y - 0.5 }];
  const before = hit.bricks.length;
  step(hit, 60);
  assert.ok(hit.bricks.length < before, 'a bolt breaks a brick');
  assert.equal(hit.bolts.length, 0, 'and is spent doing it');

  const red = tiles(hit).find((t) => t.paddle);
  assert.notEqual(red.color, tiles(newGame()).find((t) => t.paddle).color,
    'Vaus is a different colour while the laser is up: the bat says what it can do');
});

test('a life is lost only when EVERY ball is gone', () => {
  const g = newGame();
  launch(g, 0.2);
  applyCapsule(g, 'disrupt');
  assert.equal(g.balls.length, 3);
  movePaddle(g, 0.5);                                    // Vaus out of the way, hard left
  // kill two of them
  g.balls[0].y = 0.05; g.balls[0].x = COLS - 1; g.balls[0].vy = -40; g.balls[0].vx = 0;
  g.balls[1].y = 0.05; g.balls[1].x = COLS - 1; g.balls[1].vy = -40; g.balls[1].vx = 0;
  const r1 = step(g, 60);
  assert.equal(r1.lost, false, 'two down is not a life: one is still in play');
  assert.equal(g.lives, LIVES);
  assert.equal(g.balls.length, 1);
  const last = g.balls[0];
  last.stuck = false; last.y = 0.05; last.x = COLS - 1; last.vy = -40; last.vx = 0;
  const r2 = step(g, 60);
  assert.equal(r2.lost, true, 'the last one is');
  assert.equal(g.lives, LIVES - 1);
  assert.equal(g.paddle.w, PADDLE_W, 'and Vaus goes back to stock');
});

test('losing the last life ends it, and nothing moves afterwards', () => {
  const g = newGame();
  const drop = () => {
    const b = g.balls[0];
    b.stuck = false; b.x = COLS - 0.5; b.y = 0.05; b.vx = 0; b.vy = -40;
    return step(g, 60).hits.some((h) => h.kind === 'life');
  };
  movePaddle(g, 0.5);
  assert.equal(drop(), true);
  assert.equal(g.lives, LIVES - 1);
  drop(); drop();
  assert.equal(g.lives, 0);
  assert.equal(g.over, true);
  assert.deepEqual(step(g, 16).hits, [], 'nothing happens after the end');
  assert.equal(launch(g, 0), false, 'and it cannot be served again');
});

test('a fast ball cannot tunnel through the wall, however coarse the frame', () => {
  const g = newGame();
  const target = g.bricks.reduce((lo, b) => (b.y < lo.y ? b : lo));
  const b = g.balls[0];
  b.stuck = false;
  b.x = target.x + 0.5;
  b.y = target.y - 1.2;
  b.vx = 0; b.vy = 90;
  const before = g.bricks.length;
  const hits = step(g, 60).hits;
  assert.ok(g.bricks.length < before || hits.some((h) => h.kind === 'silver' || h.kind === 'gold'),
    'it struck the wall instead of stepping over it');
  assert.ok(b.y <= ROWS, 'still on the board');
});

test('the switches bite: capsules and minions can be turned off, in play', () => {
  // (a setting nothing reads is a dead control, which is why these live on the game and not in the
  // renderer's options -- they change the RULES)
  const off = newGame(1, { capsules: false, enemies: false });
  assert.equal(off.opts.capsules, false);
  for (const k of [...off.bricks]) {
    const i = off.bricks.indexOf(k);
    if (i >= 0 && k.kind === 'plain') { off.bricks.splice(i, 1); }
  }
  assert.equal(off.capsules.length, 0, 'nothing dropped with capsules off');
  // minions never arrive, however long it runs
  const quiet = newGame(1, { enemies: false });
  for (let i = 0; i < 400; i++) step(quiet, 60);
  assert.equal(quiet.enemies.length, 0, 'and no minions arrive');
  // on, they do
  const loud = newGame(1, { enemies: true });
  launch(loud, 0.2);
  let seen = false;
  for (let i = 0; i < 400 && !seen; i++) seen = step(loud, 60).hits.some((h) => h.kind === 'enemyin');
  assert.equal(seen, true, 'with minions on, they turn up');
  // and flipping it off mid-game clears the court
  setOptions(loud, { capsules: true, enemies: false });
  assert.equal(loud.enemies.length, 0, 'turning them off takes the ones already here away');
});

test('the tiles for the engine: a brick IS a grid cell, and every colour is a hex', () => {
  const g = newGame(2);
  launch(g, 0.1);
  applyCapsule(g, 'laser');
  fire(g);
  g.capsules = [{ id: 7, kind: 'laser', x: 3, y: 9 }];
  g.enemies = [{ id: 8, x: 5, y: 14, phase: 0, t: 0 }];
  const t = tiles(g);
  const bricks = t.filter((x) => x.txid.startsWith('b') && !x.txid.startsWith('ball') && !x.txid.startsWith('bolt'));
  assert.ok(bricks.every((b) => b.s === 1), 'one grid cell wide: no translation layer');
  assert.equal(t.filter((x) => x.paddle).length, Math.round(g.paddle.w), 'Vaus is one stone per unit of width');
  assert.ok(t.find((x) => x.capsule), 'the capsule is drawn');
  assert.ok(t.find((x) => x.bolt), 'so are the bolts');
  const foe = t.find((x) => x.enemy);
  assert.ok(foe && foe.sphere === true, 'a minion is drawn ROUND, like the ball');
  assert.ok(t.find((x) => x.ball)?.sphere === true, 'and so is the ball');
  assert.ok(t.every((x) => /^#[0-9a-f]{6}$/i.test(x.color)), 'every colour is a six-digit hex, as the engine requires');
  assert.ok(t.every((x) => x.x >= -0.5 && x.x <= COLS && x.y >= -1 && x.y <= ROWS), 'and everything is on the board');
});

test('every capsule has its OWN silhouette, not just its own colour', () => {
  // (operator, 2026-09-12: "Blockanoid needs unique block graphics and styling for each of the
  // different powerups that drop down".) Colour alone is a poor signal on a small moving object,
  // and useless to a colourblind player, so the shapes must differ in a way that survives
  // monochrome. This asserts that as a property rather than trusting my eye.
  const sig = (kind) => {
    const parts = capsuleTiles({ id: 1, kind, x: 3, y: 9 });
    // a shape signature that ignores colour entirely: part count, and each part's box and flags
    return JSON.stringify(parts
      .map((p) => [+(p.x - 3).toFixed(2), +(p.y - 9).toFixed(2), p.s, p.tall, +(p.floor ?? 0), !!p.sphere, !!p.wire])
      .sort());
  };
  const sigs = new Map();
  for (const kind of CAPSULES) {
    const s = sig(kind);
    assert.ok(!sigs.has(s), `${kind} and ${sigs.get(s)} are the same shape: colour is doing all the work`);
    sigs.set(s, kind);
  }
  assert.equal(sigs.size, CAPSULES.length, 'all seven are distinct in monochrome');

  // and each is well formed: inside its own footprint, real hexes, its own tile ids
  for (const kind of CAPSULES) {
    const parts = capsuleTiles({ id: 42, kind, x: 3, y: 9 });
    assert.ok(parts.length >= 2, `${kind} is built from several parts, not one slab`);
    const ids = parts.map((p) => p.txid);
    assert.equal(new Set(ids).size, ids.length, `${kind}: every part has its own id, or the engine's paint order collapses them`);
    assert.ok(ids.every((i) => i.startsWith('cap42')), `${kind}: parts belong to their capsule`);
    for (const p of parts) {
      assert.match(p.color, /^#[0-9a-f]{6}$/i, `${kind}: every colour is a six-digit hex`);
      assert.ok(p.s > 0 && p.s <= 1, `${kind}: a part stays within a grid cell`);
      assert.ok(p.x >= 3 - 0.1 && p.x + p.s <= 3 + 1.05, `${kind}: stays inside its own footprint (hit box is ${0.9})`);
      assert.equal(p.capsule, true, `${kind}: parts are still flagged as capsule`);
    }
  }

  // the distinguishing features, named individually so a redesign cannot quietly lose one
  const has = (kind, pred) => capsuleTiles({ id: 1, kind, x: 0, y: 0 }).some(pred);
  assert.ok(has('slow', (p) => p.wire), 'slow is the hollow one');
  assert.ok(!has('laser', (p) => p.wire), 'and the only hollow one');
  assert.equal(capsuleTiles({ id: 1, kind: 'disrupt', x: 0, y: 0 }).filter((p) => p.sphere).length, 3,
    'disrupt shows three balls, because that is what it gives you');
  assert.ok(has('catch', (p) => p.sphere), 'catch cradles a ball');
  const top = (kind) => Math.max(...capsuleTiles({ id: 1, kind, x: 0, y: 0 }).map((p) => (p.floor ?? 0) + p.tall));
  assert.ok(top('player') > top('enlarge'), 'the extra life stands tallest');
  assert.ok(top('enlarge') < top('laser'), 'and the wide bar is the flattest');
  assert.ok(!capsuleTiles({ id: 1, kind: 'break', x: 0, y: 0 }).some((p) => (p.floor ?? 0) === 0 && p.s === 0.9),
    'break is a doorway: no full-width base');
});

test('Vaus reports what it is carrying, and a cleared wall advances', () => {
  const g = newGame();
  assert.deepEqual(powers(g), [], 'stock Vaus carries nothing');
  applyCapsule(g, 'laser'); applyCapsule(g, 'enlarge');
  const on = powers(g);
  assert.ok(on.includes('laser') && on.includes('wide'));
  assert.equal(remaining(newGame()), 1, 'a full wall is all of it');

  const h = newGame();
  h.score = 400;
  h.bricks = h.bricks.filter((b) => b.kind !== 'plain').concat(h.bricks.find((b) => b.kind === 'plain'));
  const last = h.bricks.find((b) => b.kind === 'plain');
  aimAt(h, last);
  const r = step(h, 16);
  assert.equal(r.cleared, true);
  assert.ok(h.balls.every((b) => b.stuck), 'the balls are parked');
  const lvl = h.level;
  advance(h);
  assert.equal(h.level, lvl + 1);
  assert.ok(h.score >= 400, 'the score carries over');
  assert.equal(h.cleared, false);
  assert.equal(h.paddle.w, PADDLE_W, 'and Vaus starts the new wall at stock width');
  assert.ok(speed(h.level) > speed(lvl), 'with a quicker ball');
  assert.deepEqual(h.opts, { capsules: true, enemies: true }, 'the switches survive the level change');
});

test('resetVaus and resetBall put the court back to stock', () => {
  const g = newGame();
  applyCapsule(g, 'laser'); applyCapsule(g, 'enlarge'); applyCapsule(g, 'slow');
  resetVaus(g);
  assert.equal(g.laser, false);
  assert.equal(g.slow, false);
  assert.equal(g.paddle.w, PADDLE_W);
  resetBall(g);
  assert.equal(g.balls.length, 1);
  assert.equal(g.balls[0].stuck, true);
  nudge(g, -3);
  assert.ok(g.paddle.x >= 0, 'and Vaus cannot be shoved off the court');
  movePaddle(g, COLS + 5);
  assert.equal(g.paddle.x, COLS - g.paddle.w, 'nor off the other side');
});
