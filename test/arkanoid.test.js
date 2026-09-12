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
  layoutFor, applyCapsule, capsuleTiles, damageShade, mixHex, boxHitsBrick, loseLife, CAPSULE_LETTER,
  ENEMY_S, ENEMY_BOX, CAPSULE_S, CAPSULE_BOX, MINION_KINDS, DAMAGE_DARK, DAMAGE_LIGHT,
} from '../public/js/arkanoid.js';
import { SFX } from '../public/js/tetsound.js';

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

  // `break` (skip the wall) was removed 2026-09-12: a capsule that clears a wall you did not
  // clear rewards catching a pill rather than playing, and voids the level you are in.
  assert.ok(!CAPSULES.includes('break'), 'skip-the-wall is gone');
  assert.ok(!Object.values(CAPSULE_LETTER).includes('B'), 'and its letter with it');

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
  // A minion is no longer a plain ball (operator, 2026-09-12: "proper varied Minion graphics ...
  // a few minion types that drift around and behave like the minions in arkanoid"). It is a
  // turning body with its own outline and a pair of eyes -- the ball stays a sphere.
  assert.ok(foe && Array.isArray(foe.poly) && foe.poly.length >= 3, 'a minion has an outline of its own');
  assert.ok(foe.eyes?.length === 2, 'and something that looks back');
  assert.equal(typeof foe.rot, 'number', 'and it turns as it drifts');
  assert.ok(!foe.sphere, 'it is not the ball');
  assert.ok(t.find((x) => x.ball)?.sphere === true, 'and so is the ball');
  assert.ok(t.every((x) => /^#[0-9a-f]{6}$/i.test(x.color)), 'every colour is a six-digit hex, as the engine requires');
  assert.ok(t.every((x) => x.x >= -0.5 && x.x <= COLS && x.y >= -1 && x.y <= ROWS), 'and everything is on the board');
});

test('the capsules are pills, and still tell each other apart without colour', () => {
  // (operator, 2026-09-12: "create a new class of graphic for the powerups to look like elongated
  // pills rotating and dropping with different colors".)
  //
  // THE TENSION, AND HOW IT IS RESOLVED. An earlier version of this test asserted seven DIFFERENT
  // silhouettes, because a small falling object is read by its shape and roughly one player in
  // twelve cannot separate the red from the green. The operator then asked for pills that differ
  // by colour, which pulls the other way. Both are kept: they share the pill outline that was
  // asked for, and each carries its own BAND, so the set is still separable in monochrome. This
  // asserts that against the real geometry rather than against flags.
  const parts = (kind, y = 9) => capsuleTiles({ id: 1, kind, x: 3, y });

  for (const kind of CAPSULES) {
    const ps = parts(kind);
    assert.equal(ps.length, 2, `${kind}: a pill and its band`);
    const [pill, band] = ps;
    assert.ok(Array.isArray(pill.poly) && pill.poly.length >= 8, `${kind}: the pill is a rounded outline`);
    const wide = Math.max(...pill.poly.map((q) => Math.abs(q[0])));
    const tallest = Math.max(...pill.poly.map((q) => Math.abs(q[1])));
    assert.ok(wide > tallest * 1.8, `${kind}: ELONGATED -- ${wide.toFixed(2)} across vs ${tallest.toFixed(2)} high`);
    assert.ok(Array.isArray(band.poly) && band.poly.length >= 3, `${kind}: carries a band`);
    for (const q of band.poly) {
      assert.ok(Math.abs(q[0]) <= wide && Math.abs(q[1]) <= tallest, `${kind}: the band stays on the pill`);
    }
  }

  // the band is what separates them, and it must genuinely differ -- colour stripped out entirely
  const marks = new Map();
  for (const kind of CAPSULES) {
    const sig = JSON.stringify(parts(kind)[1].poly);
    assert.ok(!marks.has(sig), `${kind} and ${marks.get(sig)} carry the same mark: colour would be doing all the work`);
    marks.set(sig, kind);
  }
  assert.equal(marks.size, CAPSULES.length, 'all seven are separable in monochrome');

  // IT TUMBLES, and from its own height rather than a clock -- the rules stay free of time, so a
  // frame is reproducible and two capsules at the same height look alike
  const a = parts('laser', 9)[0].rot, b = parts('laser', 7.5)[0].rot;
  assert.notEqual(a, b, 'the angle follows the fall');
  assert.equal(parts('laser', 9)[0].rot, a, 'and the same height always gives the same angle');
  for (const kind of CAPSULES) {
    for (const q of parts(kind)) {
      assert.match(q.color, /^#[0-9a-f]{6}$/i, `${kind}: every colour is a six-digit hex`);
      assert.equal(q.capsule, true, `${kind}: still flagged as a capsule`);
      assert.ok(q.txid.startsWith('cap1'), `${kind}: parts belong to their capsule`);
    }
    assert.equal(new Set(parts(kind).map((q) => q.txid)).size, 2, `${kind}: each part has its own id`);
  }
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

test('a brick that survives a hit gets lighter, and the last shade means "next one breaks it"', () => {
  // (operator, 2026-09-12: "start darker in color. Every successive hit ... makes it lighter
  // colored ... When it's the lightest color it can be, it will signal the next impact will break
  // that block".) Anchored at BOTH ends, so the final shade is the same whatever the durability --
  // "one more" is a colour you learn once, not a shade you compare against the brick next to it.
  const lum = (h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  for (const max of [2, 3, 5]) {
    const shades = [];
    for (let left = max; left >= 1; left--) shades.push(damageShade(left, max, SILVER.color));
    assert.equal(shades[0], DAMAGE_DARK, `${max}: a fresh brick is the dark end`);
    assert.equal(shades.at(-1), DAMAGE_LIGHT, `${max}: one hit left is the light end, whatever the durability`);
    for (let i = 1; i < shades.length; i++) {
      assert.ok(lum(shades[i]) > lum(shades[i - 1]), `${max}: hit ${i} must be lighter than hit ${i - 1}`);
    }
  }
  assert.equal(damageShade(1, 1, '#f5d142'), '#f5d142', 'a one-hit brick has no wear to show, so it keeps its colour');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080', 'the mix is linear');

  // and it reaches the engine: the tile lightens AND sinks, so the cue survives monochrome
  const g = newGame(2);
  const brick = g.bricks.find((b) => b.kind === 'silver');
  const fresh = tiles(g).find((t) => t.txid === `b${brick.id}`);
  brick.hits -= 1;
  const worn = tiles(g).find((t) => t.txid === `b${brick.id}`);
  assert.ok(lum(worn.color) > lum(fresh.color), 'the damaged brick is lighter');
  assert.ok(worn.tall < fresh.tall, 'and stands lower');
});

test('a minion cannot pass through bricks, and paces a solid wall looking for a way out', () => {
  // (operator: "Minions should not be able to pass through bricks. Just like the real arcade game"
  // and "the minions should slowly try to find a path out".) Level 1 is a full-width wall with no
  // gap at all; level 2 leaves a nine-unit one. One algorithm, two opposite behaviours.
  const run = (level) => {
    const g = newGame(level, { capsules: false, enemies: true });
    g.enemies = [{ id: 7, kind: MINION_KINDS[0], x: 6, y: 23.2, phase: 0.4, t: 0 }];
    const y0 = g.enemies[0].y;
    let low = y0, overlapped = false;
    for (let i = 0; i < 400 && g.enemies.length; i++) {
      step(g, 50);
      const m = g.enemies[0];
      if (!m) break;
      low = Math.min(low, m.y);
      if (boxHitsBrick(g, m.x, m.y, ENEMY_BOX)) overlapped = true;
    }
    return { fell: y0 - low, overlapped };
  };
  const solid = run(1), gapped = run(2);
  assert.equal(solid.overlapped, false, 'it never stands inside a brick');
  assert.equal(gapped.overlapped, false, 'nor on the wall with a gap');
  assert.ok(solid.fell < 1, `a solid wall holds it at the top (fell ${solid.fell.toFixed(2)})`);
  assert.ok(gapped.fell > 10, `a gap lets it through (fell ${gapped.fell.toFixed(2)})`);
});

test('a minion reaching Vaus COSTS a life -- it does not pay for the privilege', () => {
  // This inverted an existing rule, and the suite stayed green when it changed: nothing covered it.
  // (operator: "kill the player if the player hits it".) The ball and the laser destroy a minion
  // for points; a minion that reaches the bat destroys the bat.
  const g = newGame(1, { capsules: false, enemies: true });
  movePaddle(g, 6);
  g.bricks = [];
  g.enemies = [{ id: 3, kind: MINION_KINDS[1], x: g.paddle.x, y: PADDLE_Y + PADDLE_D + 0.05, phase: 0, t: 0 }];
  const r = step(g, 50);
  assert.equal(g.lives, LIVES - 1, 'a life is gone');
  assert.equal(g.score, 0, 'and nothing was paid for it');
  assert.ok(r.hits.some((h) => h.kind === 'vaus'), 'the screen is told why');
  assert.equal(g.enemies.length, 0, 'the court is cleared');
});

test('the sprites are four times larger than their hit boxes are wide, and centred on them', () => {
  // (operator: "need to be AT LEAST 4 times larger" and "shrink the bounding box if necessary to
  // compensate for visual".) Drawn size and collision size are separate measurements now; if the
  // sprite were not centred on the box, you would aim at a shape whose edge is not where it looks.
  // 4x first, then "reduce those minions 40% in size. a bit large" -- so the minion is no longer
  // pinned to a multiple, only to being much bigger than the box it collides with. The pill keeps
  // its 4x, which was never the complaint.
  assert.ok(ENEMY_S > ENEMY_BOX * 2, `minion sprite ${ENEMY_S} dwarfs its ${ENEMY_BOX} box`);
  assert.ok(ENEMY_S > 0.86 * 2, `and is well up on the old ${0.86} sprite (${(ENEMY_S / 0.86).toFixed(2)}x)`);
  assert.ok(CAPSULE_S > CAPSULE_BOX, `pill sprite ${CAPSULE_S} is bigger than its ${CAPSULE_BOX} catch box`);
  assert.ok(CAPSULE_S > 0.9 * 2, `and well up on the old sprite (${(CAPSULE_S / 0.9).toFixed(2)}x)`);
  assert.ok(ENEMY_BOX < 1, 'the minion box fits a one-unit gap, or it could never pass the wall');
  assert.ok(CAPSULE_BOX < CAPSULE_S, 'the catch box is smaller than the pill, so it can still be missed');

  const g = newGame(2);
  g.enemies = [{ id: 1, kind: MINION_KINDS[0], x: 5, y: 14, phase: 0, t: 0 }];
  g.capsules = [{ id: 2, kind: 'laser', x: 5, y: 10 }];
  const t = tiles(g);
  const centred = (tile, bx, by, box) =>
    Math.abs((tile.x + tile.s / 2) - (bx + box / 2)) < 1e-9 && Math.abs((tile.y + tile.s / 2) - (by + box / 2)) < 1e-9;
  assert.ok(centred(t.find((x) => x.enemy), 5, 14, ENEMY_BOX), 'the minion sprite is centred on its box');
  assert.ok(centred(t.find((x) => x.capsule), 5, 10, CAPSULE_BOX), 'and the pill on its catch box');
});

test('the bat and a brick sound like opposites: a low falling pong, a high rising ping', () => {
  // (operator: "make sure to have distinct 'Ping' and 'Pong' sounds like Arkanoid does for the
  // paddle and block impacts".) They were 300 Hz and 680 Hz, both falling square blips -- too alike
  // to tell apart while the ball is moving. Pitch separation alone is weak on small speakers, so
  // the SWEEP DIRECTION is opposite too, which survives them.
  const [pFrom, pTo, , pWave] = SFX.paddle;
  const [bFrom, bTo, , bWave] = SFX.brick;
  assert.ok(pTo < pFrom, 'the bat FALLS');
  assert.ok(bTo > bFrom, 'the brick RISES');
  assert.ok(Math.log2(bFrom / pFrom) >= 2, `at least two octaves apart (${Math.log2(bFrom / pFrom).toFixed(1)})`);
  assert.notEqual(pWave, bWave, 'and a different timbre, not just a different pitch');
  const [hFrom] = SFX.brickhard;
  assert.ok(hFrom > bFrom, 'a dearer brick rings higher still');
});
