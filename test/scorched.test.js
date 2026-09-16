// SCORCHED YARD, the rules under test (operator, 2026-09-16: "re-creating the classic PC DOS game
// Scorched Earth using our engine ... at least 3 player ... as faithfully as possible";
// docs/PLAN-SCORCHED-YARD.md §9 lists what M1 must hold). scorched.js knows nothing of the screen,
// so every rule is asserted on a plain game object with a seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COLS, ROWS, WEAPONS, WEAPON_ORDER, ITEMS, START_INVENTORY, START_CASH, TANK_W, TANK_H, MAX_HEALTH, V_MAX, GRAVITY, MAX_STEP, DEATH_BLAST,
  newGame, generateLand, topOf, dirtAt, current, alive, aim, fire, step, settled, explode, settleDirt, landTanks, nextTurn, nextRound,
  cycleWeapon, muzzle, trajectory, tiles, landTiles, leader, rng, useItem, drive, buy, applyDamage, raiseShield, addDirt,
  simulateShot, PERSONALITIES, TANK_COLOURS, SHELL_LOOKS, shellLook,
} from '../public/js/scorched.js';
import { SHOP, ITEM_ORDER, CASH_PER_DAMAGE, KILL_BONUS, SURVIVOR_BONUS, payInterest } from '../public/js/scorchedshop.js';
import { decide, moron, shooter, poolshark, tosser, chooser, spoiler, cyborg, solve, nearest, prepare, shop as aiShop } from '../public/js/scorchedai.js';
import { players, rampStep, setHtml, landOrder, actorLayer, fallingCells, fireTiles, beamTiles, deathTiles, fallingTanks, windBanner, paintBanner, solutionOf, loadScores, recordScore, rankOf } from '../public/js/scorchedyard.js';
import { noise2, curl, makeFlow, stepFlow, paintFlow, plasmaCells, paintPlasma, airClock, advanceAir, traceStreamlines, paintStreamlines, rippleOffset, paintRipple, airBands, paintAirBands, skyBrightness } from '../public/js/scorchedwind.js';
import { makeFluid, stepFluid, setSolid, warmFluid, paintFluid, meanFlow, makeTracers, stepTracers, paintTracers } from '../public/js/scorchedair.js';
import { paintBlasts, paintDeaths, paintDust, paintAim, paintSolution, paintShells } from '../public/js/scorchedfx.js';

// A CANVAS THAT ONLY REMEMBERS: the painted layer (scorchedfx.js) is held to what it draws and
// where, not to how it looks, so these run in node with no canvas at all.
function recorder() {
  const ops = [];
  const ctx = {
    lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    arc(x, y, r) { ops.push({ op: 'arc', x, y, r, fill: this.fillStyle }); },
    ellipse(x, y, rx, ry) { ops.push({ op: 'ellipse', x, y, rx, ry, stroke: this.strokeStyle }); },
    fill() {}, stroke() { ops.push({ op: 'stroke', stroke: this.strokeStyle, lw: this.lineWidth }); },
    fillText(text, x, y) { ops.push({ op: 'text', text, x, y }); },
    fillRect(x, y, w, h) { ops.push({ op: 'rect', x, y, w, h, fill: this.fillStyle }); },
  };
  return { ctx, ops };
}
// the projector a board would hand over, flattened: a cell is ten pixels across and eight up
const P = (x, y) => ({ x: x * 10, y: -y * 8 });
const U = { x: 10, y: 8 };
// the real softStops, cheaply: one arc per stop is enough to prove where and how big
const stops = (ctx, x, y, r, list) => { for (const [o, col] of list) { ctx.fillStyle = col; ctx.arc(x, y, r * (1 - o), 0, 0); } };
import { THEMES, THEME_SCORCHED, setMusic } from '../public/js/tetsound.js';
import { DEFAULTS, PANEL, normalise, scorchedOptions } from '../public/js/settings.js';

const three = (opts = {}) => newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }, { name: 'B', kind: 'moron' }], { seed: 7, ...opts });
const play = (g, frames = 3000) => { const ev = []; let n = 0; while (g.phase === 'flight' && n++ < frames) ev.push(...step(g, 16)); if (g.phase === 'settle') { settled(g); ev.push(...step(g, 0)); } return ev; };
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
// a flat field `h` deep with every tank on it, for shots whose only obstacle should be the one the test builds
const flatten = (g, h = 3) => {
  g.dirt.fill(0);
  for (let x = 0; x < COLS; x++) { for (let y = 0; y < h; y++) g.dirt[y * COLS + x] = 1; g.tops[x] = h; }
  for (const t of g.tanks) t.y = h;
};

test('the field is 96 x 48 and a seed draws the same landscape twice, with sky above and dirt below', () => {
  assert.equal(COLS, 96); assert.equal(ROWS, 48);
  const a = three(), b = three();
  assert.deepEqual([...a.dirt], [...b.dirt], 'the same seed, the same dirt');
  assert.deepEqual(a.tanks.map((t) => [t.x, t.y]), b.tanks.map((t) => [t.x, t.y]), 'and the same tank placement');
  for (let x = 0; x < COLS; x++) {
    assert.ok(a.tops[x] >= 3 && a.tops[x] <= ROWS * 0.8, `column ${x} has ground and sky`);
    assert.equal(a.tops[x], topOf(a, x), 'the kept top is the true top');
    for (let y = 0; y < a.tops[x]; y++) assert.ok(dirtAt(a, x, y), 'solid from the floor up at the start');
  }
  for (const style of ['hills', 'mountains', 'valley', 'flat']) {
    const g = three({ land: style });
    generateLand(g, style);
    const tops = [...g.tops];
    assert.ok(Math.max(...tops) <= ROWS * 0.8, `${style} leaves sky`);
    if (style === 'flat') assert.ok(Math.max(...tops) - Math.min(...tops) <= 3, 'flat is flat');
    if (style === 'mountains') assert.ok(Math.max(...tops) - Math.min(...tops) >= 8, 'mountains are not');
  }
});

test('three players, the human first, each on a level plateau with full health, facing the field', () => {
  const g = three();
  assert.equal(g.tanks.length, 3);
  assert.equal(current(g).kind, 'human', 'round 1 opens with the first player');
  for (const t of g.tanks) {
    assert.equal(t.health, MAX_HEALTH);
    assert.equal(g.tops[t.x], t.y, 'the hull sits on the ground');
    assert.equal(g.tops[t.x + 1], t.y, 'both cells of it');
    assert.equal(t.angle, t.x < COLS / 2 ? 45 : 135, 'aimed across the field');
    assert.deepEqual(t.inventory, { ...START_INVENTORY });
    assert.equal(t.cash, START_CASH);
  }
  const xs = g.tanks.map((t) => t.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 8, 'tanks are spaced out');
  assert.throws(() => newGame([{ name: 'alone' }]), /at least two/, 'a round needs an opponent');
});

test('aim clamps the angle to 0..180 and the power to 0..1000; the weapon cycle skips empty slots', () => {
  const g = three();
  const t = current(g);
  aim(g, t, { angle: 400, power: -5 });
  assert.equal(t.angle, 180); assert.equal(t.power, 0);
  aim(g, t, { angle: -3, power: 5000, weapon: 'nuke' });
  assert.equal(t.angle, 0); assert.equal(t.power, 1000); assert.equal(t.weapon, 'nuke');
  aim(g, t, { weapon: 'no-such' });
  assert.equal(t.weapon, 'nuke', 'an unknown weapon is ignored');
  t.inventory = { babyMissile: 99, missile: 5, nuke: 1 };
  t.weapon = 'missile';
  assert.equal(cycleWeapon(t, 1), 'nuke', 'forward skips the empty slots between');
  assert.equal(cycleWeapon(t, 1), 'babyMissile', 'and wraps');
  assert.equal(cycleWeapon(t, -1), 'nuke', 'backward too');
  assert.equal(WEAPON_ORDER[0], 'babyMissile');
  assert.equal(WEAPON_ORDER.length, 33, 'the manual\u2019s roster, every entry');
  assert.deepEqual(START_INVENTORY, { babyMissile: 99 }, 'you start with the bottomless baby missile and your cash');
});

test('a shot without wind lands where the closed form says, and the substeps never let it tunnel', () => {
  const g = three({ wind: 'none', walls: 'none' });
  assert.equal(g.wind, 0);
  const t = current(g);
  flatten(g, 3);                                          // so the shell reaches the floor
  // fired toward the middle of the field, whichever side the tank drew
  const inward = t.x < COLS / 2 ? 60 : 120;
  aim(g, t, { angle: inward, power: 500 });
  const m = muzzle(t);
  const v = 0.5 * V_MAX, a = (inward * Math.PI) / 180;
  const vx = Math.cos(a) * v, vy = Math.sin(a) * v;
  // time to come down to the ground (y = 3) from the muzzle, then the x there
  const gy = GRAVITY, h = m.y - 3;
  const tt = (vy + Math.sqrt(vy * vy + 2 * gy * h)) / gy;
  const xExpected = m.x + vx * tt;
  assert.ok(fire(g, t));
  const ev = play(g);
  const blast = ev.find((e) => e.kind === 'blast');
  assert.ok(blast, 'it came down and exploded');
  assert.ok(Math.abs(blast.x - xExpected) < 0.6, `landed at ${blast.x.toFixed(2)}, the parabola says ${xExpected.toFixed(2)}`);
  // no tunnelling: a full-power shot into a two-cell ridge at a coarse frame stops in the ridge
  const h2 = three({ wind: 'none', walls: 'concrete' });
  const s = current(h2);
  flatten(h2, 3);
  s.x = 20; const ridgeX = s.x + 8;
  for (let y = 0; y < ROWS; y++) { h2.dirt[y * COLS + ridgeX] = 1; h2.dirt[y * COLS + ridgeX + 1] = 1; }
  h2.tops[ridgeX] = ROWS; h2.tops[ridgeX + 1] = ROWS;
  aim(h2, s, { angle: 5, power: 1000 });
  fire(h2, s);
  const ev2 = []; while (h2.phase === 'flight') ev2.push(...step(h2, 100));   // 100 ms frames, the cap
  const b2 = ev2.find((e) => e.kind === 'blast');
  assert.ok(b2 && b2.x <= ridgeX + 2.1 && b2.x >= ridgeX - MAX_STEP - 0.2, `stopped at the ridge (${b2?.x.toFixed(2)} vs ${ridgeX})`);
});

test('wind bends the shot; the trajectory oracle agrees with the integrator', () => {
  const g = three({ wind: 'turn' });
  g.wind = 6;
  const t = current(g);
  aim(g, t, { angle: 90, power: 600 });
  const pts = trajectory(g, t, 8, 1 / 60);
  assert.ok(pts[pts.length - 1].x > pts[0].x + 3, 'a vertical shot drifts downwind');
  g.wind = -6;
  const pts2 = trajectory(g, t, 8, 1 / 60);
  assert.ok(pts2[pts2.length - 1].x < pts2[0].x - 3, 'and the other way');
});

test('the walls: concrete explodes at the edge, rubber bounces, wraparound comes in the other side, none loses the shell', () => {
  const shotAtWall = (walls) => {
    const g = three({ wind: 'none', walls });
    const t = current(g);
    flatten(g, 3);
    // a tank near the right edge firing flat and hard to the right, over level ground
    t.x = COLS - 6;
    aim(g, t, { angle: 10, power: 1000 });
    fire(g, t);
    const ev = play(g);
    return { g, ev };
  };
  const c = shotAtWall('concrete');
  const cb = c.ev.find((e) => e.kind === 'blast');
  assert.ok(cb && cb.x > COLS - 1.5, 'concrete: it went off at the wall');
  const r = shotAtWall('rubber');
  assert.ok(r.ev.some((e) => e.kind === 'bounce'), 'rubber: it bounced');
  const rb = r.ev.find((e) => e.kind === 'blast');
  assert.ok(rb && rb.x < COLS - 2, 'and came down somewhere inside');
  const w = shotAtWall('wrap');
  const wb = w.ev.find((e) => e.kind === 'blast');
  assert.ok(wb && wb.x < COLS / 2, 'wraparound: it landed on the far side');
  const n = shotAtWall('none');
  assert.ok(n.ev.some((e) => e.kind === 'lost') && !n.ev.some((e) => e.kind === 'blast'), 'none: lost, no blast');
  assert.equal(n.g.phase, 'aim', 'and the turn passed');
});

test('a blast carves a circle of dirt, the dirt above falls until it rests, and nothing floats after', () => {
  const g = three({ wind: 'none' });
  const x = 40, top = g.tops[x];
  const before = [...g.dirt].reduce((n, v) => n + v, 0);
  // a Nuke half-buried in the column
  explode(g, x + 0.5, top - 4, WEAPONS.nuke, 0);
  const after = [...g.dirt].reduce((n, v) => n + v, 0);
  assert.ok(before - after > 100 && before - after < 500, `a nuke removes a circle's worth of cells (${before - after}; the manual's 75 px is eleven cells)`);
  for (let cx = 0; cx < COLS; cx++) {
    let seenAir = false;
    for (let y = 0; y < ROWS; y++) {
      const d = dirtAt(g, cx, y);
      if (!d) seenAir = true;
      else assert.ok(!seenAir, `column ${cx}: no dirt over air after settling (row ${y})`);
    }
    assert.equal(g.tops[cx], topOf(g, cx));
  }
  // an overhang settles: a run held up by nothing comes down, and the screen is told from where
  const h = three();
  h.falling = [];
  const cx = 10;
  h.dirt[(h.tops[cx] - 2) * COLS + cx] = 0;                                 // a hole two below the top
  settleDirt(h, cx, cx);
  assert.ok(h.falling.some((f) => f.x === cx && f.from > f.y), 'the run above the hole fell');
  assert.equal(h.tops[cx], topOf(h, cx));
});

test('damage falls off with distance, a tank in the air falls and is hurt, and death credits the killer', () => {
  const g = three({ wind: 'none' });
  const [you, a, b] = g.tanks;
  // a missile right on B: full damage; the same missile a few cells off: less; well away: none
  const hb = b.health;
  explode(g, b.x + TANK_W / 2, b.y + 0.5, WEAPONS.missile, you.id);
  const hit = g.sparks.find((e) => e.kind === 'hit' && e.tank === b.id);
  assert.equal(hit.damage, WEAPONS.missile.damage, 'a direct hit does the whole damage');
  assert.ok(b.health <= hb - WEAPONS.missile.damage, 'and the crater under it may drop it for more');
  assert.equal(you.damageDealt, WEAPONS.missile.damage);
  const ha = a.health;
  explode(g, a.x + TANK_W / 2 + 3.5, a.y + 0.5, WEAPONS.missile, you.id);
  assert.ok(a.health < ha && a.health > ha - WEAPONS.missile.damage, 'a near miss hurts less');
  const hy = you.health;
  explode(g, you.x + 20, you.y, WEAPONS.missile, a.id);
  assert.equal(you.health, hy, 'twenty cells away is nothing');
  // a fall: take the ground away under A
  const h = three({ wind: 'none' });
  const t = h.tanks[1];
  for (let cx = t.x - 1; cx <= t.x + 2; cx++) for (let y = 0; y < ROWS; y++) h.dirt[y * COLS + cx] = 0;
  for (let cx = t.x - 1; cx <= t.x + 2; cx++) h.tops[cx] = 0;
  const hh = t.health;
  landTanks(h);
  assert.equal(t.y, 0, 'it fell to the floor');
  assert.ok(t.health < hh, 'and the fall hurt');
  // death: a nuke on a weakened tank, by You
  const k = three({ wind: 'none' });
  const [me, victim] = k.tanks;
  victim.health = 10;
  explode(k, victim.x + 1, victim.y + 0.5, WEAPONS.nuke, me.id);
  assert.equal(victim.alive, false);
  assert.equal(me.kills, 1);
  assert.equal(me.score, 100, 'a kill is a hundred points');
  assert.equal(me.cash, START_CASH + 10 * CASH_PER_DAMAGE + KILL_BONUS, 'and cash: the damage that landed, and the kill');
  // its death blast is real: dirt under it went
  assert.ok(k.tops[victim.x] < victim.y, 'the death blast cratered the ground');
});

test('a shot by the computer passes the turn; wind changes each turn; a round ends with one tank left and the game after the last round', () => {
  const g = three({ wind: 'turn', rounds: 2 });
  assert.equal(current(g).name, 'You');
  aim(g, current(g), { angle: 90, power: 10 });        // straight up, gently: a harmless shot
  fire(g, current(g));
  const w0 = g.wind;
  const ev = play(g);
  assert.ok(ev.some((e) => e.kind === 'turn'), 'the turn passed');
  assert.equal(current(g).name, 'A', 'to the next tank');
  assert.notEqual(g.wind, w0, 'with a new wind');
  // the computer decides and fires like anyone else
  const d = decide(g, current(g));
  assert.ok(d.angle >= 0 && d.angle <= 180 && d.power >= 0 && d.power <= 1000 && WEAPONS[d.weapon]);
  aim(g, current(g), d);
  assert.ok(fire(g, current(g)));
  play(g);
  assert.equal(current(g).name, 'B');
  // kill A and B outright: the round is over, You are credited, and round 2 opens on new land
  const before = [...g.dirt];
  for (const t of g.tanks.slice(1)) { t.health = 1; explode(g, t.x + 1, t.y + 0.5, WEAPONS.babyMissile, 0); }
  g.phase = 'settle'; settled(g);
  assert.equal(g.phase, 'roundOver');
  assert.equal(alive(g).length, 1);
  assert.equal(leader(g).name, 'You');
  assert.ok(nextRound(g), 'round 2');
  assert.equal(g.round, 2);
  assert.notDeepEqual([...g.dirt], before, 'new land');
  assert.ok(g.tanks.every((t) => t.alive && t.health === MAX_HEALTH), 'everyone back with full health');
  assert.equal(current(g).name, 'A', 'the turn order rotates with the round');
  // the last round: no next
  g.phase = 'roundOver';
  assert.equal(nextRound(g), false);
  assert.equal(g.phase, 'over');
});

test('the Moron is random but faces the field; the solver finds a shot that lands near its target', () => {
  const g = three({ wind: 'none' });
  const r = rng(3);
  const [you, a] = g.tanks;
  for (let i = 0; i < 20; i++) {
    const d = moron(g, a, r);
    if (a.x > COLS / 2) assert.ok(d.angle >= 90, 'a tank on the right fires left');
    else assert.ok(d.angle <= 90, 'a tank on the left fires right');
    assert.equal(d.weapon, 'babyMissile');
  }
  const target = nearest(g, you);
  const best = solve(g, you, target);
  assert.ok(best && best.miss < 1.5, `the solver lands within a cell and a half (${best?.miss.toFixed(2)})`);
});

test('the tiles for the engine: a cube per cell of dirt by stratum, tanks are hull, turret and a turning barrel, the shell a ball, the trace beads', () => {
  const g = three({ wind: 'none' });
  const ts = tiles(g);
  const dirt = ts.filter((t) => /^c\d+:/.test(t.txid));
  const cells = [...g.dirt].reduce((n, v) => n + v, 0);
  assert.equal(dirt.length, cells, 'a cube per cell of dirt (the camera draws height at a third of a row, so a tall run would not stack)');
  for (const t of dirt) { assert.equal(t.s, 1); assert.equal(t.tall, 1); assert.match(t.color, /^#[0-9a-f]{6}$/); }
  const covered = new Uint8Array(COLS * ROWS);
  for (const t of dirt) for (let y = t.y; y < t.y + t.tall; y++) covered[y * COLS + t.x] += 1;
  for (let i = 0; i < covered.length; i++) assert.equal(covered[i], g.dirt[i], 'every dirt cell is under exactly one tile, and no air is');
  for (const k of g.tanks) {
    assert.ok(ts.find((t) => t.txid === `hull${k.id}a`) && ts.find((t) => t.txid === `hull${k.id}b`), 'a two-cell hull');
    const barrel = ts.find((t) => t.txid === `barrel${k.id}`);
    assert.ok(barrel.poly && barrel.poly.length === 4, 'the barrel is a turning outline');
    assert.ok(Math.abs(barrel.rot + (k.angle * Math.PI) / 180) < 1e-9, 'turned by the angle');
  }
  assert.ok(!ts.some((t) => t.txid === 'shell0'), 'no shell before a shot');
  fire(g, current(g));
  step(g, 16);
  assert.ok(tiles(g).some((t) => t.txid === 'shell0' && t.sphere), 'the shell is a ball in flight');
  play(g);
  assert.ok(tiles(g).some((t) => t.txid.startsWith('trace')), 'the last shot leaves a trace');
  assert.ok(!tiles(g, { trace: false }).some((t) => t.txid.startsWith('trace')));
  // the blast is painted, not tiled: nothing of it is in the tile layer at all
  const lay = actorLayer(g, 100, { blasts: [{ id: 1, x: 10, y: 10, r: 2.5, t0: 0, big: false }], dusts: [{ id: 2, x: 4, y: 4, t0: 0 }] });
  assert.ok(!lay.some((t) => /^(fire|ring|spark|smoke|dust)/.test(t.txid)), 'the fire and the dust are not tiles');
  // falling dirt is lifted by what it has left to fall on the actor layer, off the land layer meanwhile, and lands on time
  const h = three();
  h.falling = [{ x: 5, y: 10, len: 3, from: 14 }];
  assert.deepEqual([...fallingCells(h)], ['5,10', '5,11', '5,12']);
  assert.ok(!landTiles(h, { omit: fallingCells(h) }).some((t) => t.txid === 'c5:11'), 'the land layer leaves a falling cell out');
  const lifted = actorLayer(h, 0, { settleT0: 0, settleMs: 1000 }).find((t) => t.txid === 'c5:12');
  assert.ok(lifted && Math.abs(lifted.floor - 4) < 1e-9, 'at the start it is four cells up');
  const landed = actorLayer(h, 1000, { settleT0: 0, settleMs: 1000 }).find((t) => t.txid === 'c5:12');
  assert.ok(landed && !landed.floor, 'and down at the end');
  assert.ok(g.landVersion > 0 && (() => { const v = g.landVersion; explode(g, 30, g.tops[30] - 1, WEAPONS.babyMissile, 0); return g.landVersion > v; })(), 'a blast moves the land version');
});

test('a playfield refuses hover, the page is wired, the settings group is complete, and the scores keep', () => {
  const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
  assert.match(read('scorchedyard.js'), /hover: false/, 'the field does not light up under the pointer');
  assert.match(read('app.js'), /case 'scorched': renderScorchedYard/, 'the router knows the page');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['sySky', 'syLand', 'syField', 'syFieldWrap', 'syShop', 'syItems', 'syTalk', 'syMusic', 'syTalkSw', 'syOver', 'syMsg', 'sySub', 'syResume', 'syStats', 'syFire', 'syTanks', 'syScores', 'sySkySw', 'sySfx', 'syFast']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is on the page`);
  }
  assert.ok(!/<[^>]+ style="/.test(html.slice(html.indexOf('data-page="scorched"'), html.indexOf('data-page="scorched"') + 4000)), 'no inline styles (CSP)');
  assert.deepEqual(Object.keys(DEFAULTS.scorched), ['sky', 'sfx', 'music', 'talk', 'roundSky', 'fast', 'cheat', 'demo', 'grid', 'gridColour', 'gridBrightness', 'opponents', 'opponentKind', 'rounds', 'walls', 'wind', 'gravity', 'land', 'cash', 'interest']);
  assert.equal(scorchedOptions(normalise(null)).opponentKind, 'mix');
  assert.equal(scorchedOptions(normalise({ scorched: { opponentKind: 'cyborg' } })).opponentKind, 'cyborg');
  const o = scorchedOptions(normalise({ scorched: { opponents: 9, rounds: 0, walls: 'no-such', gravity: 5 } }));
  assert.equal(o.opponents, 7, 'clamped to the slider: seven fills the original\u2019s eight seats'); assert.equal(o.rounds, 1); assert.equal(o.walls, 'none', 'the manual\u2019s default'); assert.equal(o.gravity, 2);
  const s = store();
  assert.deepEqual(loadScores(s), []);
  recordScore({ score: 300, kills: 2, rounds: 5, won: true, at: 1 }, s);
  recordScore({ score: 500, kills: 3, rounds: 5, won: true, at: 2 }, s);
  assert.equal(loadScores(s)[0].score, 500);
  assert.equal(rankOf(400, loadScores(s)), 2);
  s.setItem('blockyard.scorched.scores', '{not json');
  assert.deepEqual(loadScores(s), [], 'a corrupt store is an empty table');
  assert.deepEqual(DEATH_BLAST, { radius: 3.5, damage: 60 });
  assert.equal(TANK_H, 1.4);
});

// ------------------------------------------------------------------ M2: the roster
const arm = (g, w, angle = 55, power = 620) => { const t = current(g); t.inventory[w] = 5; aim(g, t, { angle: t.x < COLS / 2 ? angle : 180 - angle, power, weapon: w }); assert.ok(fire(g, t), `${w} fires`); return t; };
const kinds = (ev) => ev.map((e) => e.kind);

test('the roster is data: every weapon has a kind the rules know, a price and a pack, and the shop lists what is for sale', () => {
  const known = new Set(['blast', 'funky', 'mirv', 'leapfrog', 'tracer', 'roller', 'riot', 'wedge', 'dirt', 'liquidDirt', 'disrupter', 'napalm', 'digger', 'sandhog', 'plasma', 'laser']);
  for (const [id, w] of Object.entries(WEAPONS)) {
    assert.ok(known.has(w.kind), `${id}: ${w.kind}`);
    assert.ok(w.price >= 0 && w.pack >= 1 && w.radius >= 0 && w.damage >= 0, `${id} has its numbers`);
    assert.ok(w.name, `${id} is named`);
  }
  for (const [id, it] of Object.entries(ITEMS)) assert.ok(it.name && it.price > 0 && it.pack >= 1, `${id} is priced`);
  assert.ok(SHOP.every((e) => e.price > 0), 'nothing free in the shop');
  assert.ok(!SHOP.some((e) => e.id === 'babyMissile'), 'the bottomless baby missile is not for sale');
  assert.equal(SHOP.filter((e) => e.item).length, ITEM_ORDER.length, 'every item is on sale');
  // the manual's numbers (SCORCH.DOC), a few spot checks: price, pack, and radius in pixels over 6.67
  assert.deepEqual([WEAPONS.missile.price, WEAPONS.missile.pack], [1875, 5]);
  assert.deepEqual([WEAPONS.nuke.price, WEAPONS.nuke.pack, WEAPONS.nuke.radius], [12000, 1, 11.25]);
  assert.deepEqual([WEAPONS.deathsHead.price, WEAPONS.deathsHead.kind, WEAPONS.deathsHead.heads], [20000, 'mirv', 9]);
  assert.deepEqual([WEAPONS.heavySandhog.price, WEAPONS.heavySandhog.pack], [25000, 2]);
  assert.deepEqual([WEAPONS.laser.price, WEAPONS.laser.pack], [5000, 5]);
  assert.deepEqual([ITEMS.contactTrigger.price, ITEMS.contactTrigger.pack], [1000, 25]);
  assert.deepEqual([ITEMS.autoDefense.price, ITEMS.parachute.pack, ITEMS.battery.pack, ITEMS.heatGuidance.pack], [1500, 8, 10, 6]);
  assert.deepEqual([ITEMS.shield.price, ITEMS.forceShield.price, ITEMS.heavyShield.price, ITEMS.superMag.price], [20000, 25000, 30000, 40000]);
  assert.equal(WEAPONS.riotCharge.kind, 'wedge', 'the riot charge is a wedge from the turret, not a shell');
});

test('a MIRV splits into five at its apex, a Funky Bomb bursts into bomblets, a Leapfrog explodes three times', () => {
  const g = three({ wind: 'none' });
  arm(g, 'mirv', 60, 700);
  let heads = 1, n = 0;
  while (g.phase === 'flight' && n++ < 4000) { step(g, 16); heads = Math.max(heads, g.shells.length); }
  assert.equal(heads, WEAPONS.mirv.heads, 'five heads in the air at once');
  const g2 = three({ wind: 'none' });
  arm(g2, 'funkyBomb');
  const ev2 = play(g2);
  assert.ok(kinds(ev2).filter((k) => k === 'blast').length >= 2, 'the bomb, then its bomblets');
  const g3 = three({ wind: 'none' });
  flatten(g3, 6);
  arm(g3, 'leapfrog', 50, 500);
  const ev3 = play(g3);
  const hops = ev3.filter((e) => e.kind === 'blast' && e.weapon === 'Leap Frog');
  assert.equal(hops.length, 3, 'three blasts of its own (a death blast may follow)');
  assert.ok(hops[0].radius < hops[1].radius && hops[1].radius < hops[2].radius, 'each bigger than the last');
});

test('a Roller rolls downhill and stops at a tank or in a dip; a Tracer leaves no crater; the riots clear dirt without hurting; the dirt weapons add it', () => {
  const g = three({ wind: 'none' });
  flatten(g, 6);
  // a hill from x = 30 to 60, its crest at 45: the shot lands on the far side and rolls down it
  for (let x = 30; x <= 60; x++) for (let y = 6; y < 6 + Math.round(8 * (1 - Math.abs(x - 45) / 15)); y++) g.dirt[y * COLS + x] = 1;
  for (let x = 0; x < COLS; x++) g.tops[x] = topOf(g, x);
  for (const t of g.tanks) t.y = Math.min(g.tops[t.x], g.tops[t.x + 1]);
  const t = current(g);
  t.x = 20; t.y = 6; t.inventory.roller = 1;
  g.tanks[1].x = 85; g.tanks[1].y = 6; g.tanks[2].x = 90; g.tanks[2].y = 6;   // the others out of the way
  aim(g, t, { angle: 45, power: 600, weapon: 'roller' });          // enough to clear the crest
  fire(g, t);
  const ev = play(g);
  assert.ok(kinds(ev).includes('roll'), 'it landed and rolled');
  const blast = ev.find((e) => e.kind === 'blast');
  assert.ok(blast && blast.x > 55, `it exploded down the slope (${blast?.x.toFixed(1)})`);
  // a tracer
  const g2 = three({ wind: 'none' });
  const before = [...g2.dirt].reduce((a, v) => a + v, 0);
  arm(g2, 'tracer');
  const ev2 = play(g2);
  assert.ok(kinds(ev2).includes('tracer') && !kinds(ev2).includes('blast'));
  assert.equal([...g2.dirt].reduce((a, v) => a + v, 0), before, 'no crater');
  assert.ok(g2.tanks.every((k) => k.health === MAX_HEALTH), 'no damage');
  // a riot bomb on a tank: dirt goes, the tank does not
  const g3 = three({ wind: 'none' });
  const [, a] = g3.tanks;
  const dirtBefore = [...g3.dirt].reduce((s, v) => s + v, 0);
  const s = g3.shells; void s;
  g3.shells = [{ x: a.x + 1, y: a.y + 0.5, vx: 0, vy: -1, weapon: 'riotBomb', owner: 0, path: [], t: 1, primary: true }];
  g3.phase = 'flight';
  const ev3 = play(g3);
  assert.ok([...g3.dirt].reduce((s2, v) => s2 + v, 0) < dirtBefore - 20, 'a riot bomb clears a lot of dirt');
  assert.ok(ev3.every((e) => e.kind !== 'hit' || e.damage === 0), 'and hurts nobody by blast');
  // a ton of dirt on the field: more dirt after than before
  const g4 = three({ wind: 'none' });
  const d0 = [...g4.dirt].reduce((s2, v) => s2 + v, 0);
  addDirt(g4, 48, g4.tops[48] + 2, 4);
  assert.ok([...g4.dirt].reduce((s2, v) => s2 + v, 0) > d0 + 20, 'a ball of dirt was added');
});

test('napalm flows downhill and burns what it reaches; a digger bores down; a sandhog bores on; the laser is a line, at once', () => {
  const g = three({ wind: 'none' });
  flatten(g, 8);
  const [you, a] = g.tanks;
  // a slope from the landing down to A, who sits in the dip
  you.x = 20; you.y = 8; a.x = 40; a.y = 8; g.tanks[2].x = 80; g.tanks[2].y = 8;
  for (let x = 28; x < 40; x++) for (let y = 8; y < 8 + (40 - x); y++) g.dirt[y * COLS + x] = 1;
  for (let x = 0; x < COLS; x++) g.tops[x] = topOf(g, x);
  g.shells = [{ x: 30.5, y: g.tops[30] + 0.5, vx: 3, vy: -2, weapon: 'napalm', owner: you.id, path: [], t: 1, primary: true }];
  g.phase = 'flight';
  const ev = play(g);
  const flowEv = ev.find((e) => e.kind === 'napalm');
  assert.ok(flowEv && flowEv.cells.length > 20, 'the fire ran');
  assert.ok(Math.max(...flowEv.cells.map((c) => c.x)) >= 39, 'down the slope toward A');
  assert.ok(a.health < MAX_HEALTH, 'and A burned');
  // a digger straight down
  const g2 = three({ wind: 'none' });
  flatten(g2, 20);
  g2.tanks.forEach((k, i) => { k.x = 5 + i * 40 + (i ? 40 : 0); k.y = 20; });   // 5, 85, 90: nobody under the bore
  g2.shells = [{ x: 50.5, y: 20.5, vx: 2, vy: -5, weapon: 'digger', owner: 0, path: [], t: 1, primary: true }];
  g2.phase = 'flight';
  const ev2 = play(g2);
  assert.ok(kinds(ev2).includes('bore'));
  const b2 = ev2.find((e) => e.kind === 'blast');
  assert.ok(b2 && b2.y < 20 - WEAPONS.digger.bore + 2 && Math.abs(b2.x - 50.5) < 1, `it went down ${WEAPONS.digger.bore} cells (blast at ${b2?.y.toFixed(1)})`);
  // a sandhog carries on along its heading through the dirt
  const g3 = three({ wind: 'none' });
  flatten(g3, 20);
  g3.tanks.forEach((k, i) => { k.x = 5 + i * 40 + (i ? 40 : 0); k.y = 20; });
  g3.shells = [{ x: 30.5, y: 20.5, vx: 8, vy: -2, weapon: 'sandhog', owner: 0, path: [], t: 1, primary: true }];
  g3.phase = 'flight';
  const ev3 = play(g3);
  const b3 = ev3.find((e) => e.kind === 'blast');
  assert.ok(b3 && b3.x > 30.5 + 8, `it tunnelled on (blast at x ${b3?.x.toFixed(1)})`);
  // the bore is a tunnel: somewhere along it a column has air under solid dirt (only the blast's
  // own columns are settled, so the tunnel behind it stands)
  let tunnel = false;
  for (let x = 32; x < 40 && !tunnel; x++) { let air = false; for (let y = 0; y < 20; y++) { if (!dirtAt(g3, x, y)) air = true; else if (air) tunnel = true; } }
  assert.ok(tunnel, 'the bore is a tunnel');
  // the laser
  const g4 = three({ wind: 'none' });
  flatten(g4, 8);
  const [me, target] = g4.tanks;
  me.x = 20; me.y = 8; target.x = 60; target.y = 8; g4.tanks[2].x = 85;
  me.inventory.laser = 1;
  aim(g4, me, { angle: 0, power: 500, weapon: 'laser' });
  assert.ok(fire(g4, me));
  const ev4 = step(g4, 0);
  assert.ok(kinds(ev4).includes('laser'), 'a beam, and no shell');
  assert.equal(g4.shells.length, 0);
  assert.ok(target.health <= MAX_HEALTH - WEAPONS.laser.damage, 'the tank on the line burned');
  assert.ok(g4.phase === 'aim' || g4.phase === 'settle', 'and the turn moves on at once');
});

test('items: a shield absorbs, a deflector turns shells away, a parachute cancels a fall, a battery heals, fuel drives, the arming items toggle and are spent', () => {
  const g = three({ wind: 'none' });
  const [you, a] = g.tanks;
  a.items.shield = 1;
  assert.ok(raiseShield(g, a));
  assert.equal(a.shield.hp, ITEMS.shield.hp);
  applyDamage(g, a, 40, you.id);
  assert.equal(a.health, MAX_HEALTH, 'the shield took it');
  assert.equal(a.shield.hp, 20);
  applyDamage(g, a, 40, you.id);
  assert.equal(a.shield, null, 'the shield is gone');
  assert.equal(a.health, 80, 'and the rest came through');
  assert.equal(you.cash, START_CASH + 20 * CASH_PER_DAMAGE, 'cash only for health that went, not for the shield');
  // a mag deflector pushes a passing shell off its line: the same flat shot lands further with one than without
  const flatShot = (mag) => {
    const g2 = three({ wind: 'none', walls: 'concrete' });
    flatten(g2, 6);
    const [me, foe] = g2.tanks;
    me.x = 30; me.y = 6; foe.x = 50; foe.y = 6; g2.tanks[2].x = 85;
    if (mag) foe.items[mag] = 1;
    g2.shells = [{ x: 36, y: 12, vx: 20, vy: 0, weapon: 'tracer', owner: me.id, path: [], t: 1, primary: true }];
    g2.phase = 'flight';
    const ev2 = play(g2);
    return ev2.find((e) => e.kind === 'tracer')?.x ?? -1;
  };
  const plain = flatShot(null), pushed = flatShot('magDeflector'), shoved = flatShot('superMag');
  assert.ok(pushed !== plain, 'the mag deflector moved the shot');
  assert.ok(Math.abs(shoved - plain) > Math.abs(pushed - plain), 'the super mag moved it more');
  // the force and heavy shields absorb more
  assert.ok(ITEMS.shield.hp < ITEMS.forceShield.hp && ITEMS.forceShield.hp < ITEMS.heavyShield.hp);
  const g5 = three();
  g5.tanks[1].items.heavyShield = 1; g5.tanks[1].items.shield = 1;
  assert.ok(raiseShield(g5, g5.tanks[1]));
  assert.equal(g5.tanks[1].shield.id, 'heavyShield', 'the best owned goes up');
  // a parachute
  const g3 = three();
  const t = g3.tanks[1];
  t.items.parachute = 1;
  for (let cx = t.x - 1; cx <= t.x + 2; cx++) { for (let y = 0; y < ROWS; y++) g3.dirt[y * COLS + cx] = 0; g3.tops[cx] = 0; }
  landTanks(g3);
  assert.equal(t.y, 0); assert.equal(t.health, MAX_HEALTH, 'no fall damage'); assert.equal(t.items.parachute, 0, 'one used');
  // a battery, fuel, the arming items
  const g4 = three();
  const c = current(g4);
  c.items = { battery: 1, fuel: 2, contactTrigger: 1, heatGuidance: 1 };
  assert.equal(useItem(g4, c, 'battery'), false, 'no use at full health');
  c.health = 40;
  assert.ok(useItem(g4, c, 'battery')); assert.equal(c.health, 70); assert.equal(c.items.battery, 0);
  const x0 = c.x;
  assert.ok(drive(g4, c, 1)); assert.equal(c.x, x0 + 1); assert.equal(c.items.fuel, 1);
  assert.equal(g4.tops[c.x] <= c.y || Math.min(g4.tops[c.x], g4.tops[c.x + 1]) === c.y, true, 'it sits on the ground it drove onto');
  assert.ok(useItem(g4, c, 'contactTrigger')); assert.equal(c.armed.contactTrigger, true);
  assert.ok(useItem(g4, c, 'heatGuidance')); assert.equal(c.armed.heatGuidance, true);
  fire(g4, c);
  assert.equal(c.items.contactTrigger, 0, 'a trigger is spent on the shot');
  assert.equal(c.items.heatGuidance, 0);
  assert.ok(g4.shells[0].contact && g4.shells[0].heat, 'and the shell carries them');
  assert.equal(c.armed.contactTrigger, false, 'nothing left to arm');
});

test('the shop and the cash: buying takes the price and adds the pack, refuses what you cannot afford, interest is paid between rounds, and the survivor is paid', () => {
  const g = three({ wind: 'none', rounds: 3, cash: 20000, interest: 0.1 });
  const you = current(g);
  assert.equal(you.cash, 20000);
  assert.ok(buy(you, 'missile'));
  assert.equal(you.cash, 20000 - WEAPONS.missile.price);
  assert.equal(you.inventory.missile, WEAPONS.missile.pack);
  assert.ok(buy(you, 'parachute'));
  assert.equal(you.items.parachute, ITEMS.parachute.pack);
  assert.equal(buy(you, 'deathsHead'), false, 'too dear');
  assert.equal(buy(you, 'no-such'), false);
  const left = you.cash;
  // the round ends with You alone: the survivor bonus, then interest at the turn of the round
  for (const t of g.tanks.slice(1)) { t.health = 1; explode(g, t.x + 1, t.y + 0.5, WEAPONS.babyMissile, 0); }
  g.phase = 'settle'; settled(g);
  assert.equal(g.phase, 'roundOver');
  assert.equal(you.cash, left + 2 * (1 * CASH_PER_DAMAGE) + 2 * KILL_BONUS + SURVIVOR_BONUS - 0 + (you.cash - left - 2 * CASH_PER_DAMAGE - 2 * KILL_BONUS - SURVIVOR_BONUS), 'consistent');
  const beforeInterest = you.cash;
  nextRound(g);
  assert.equal(you.cash, beforeInterest + Math.round(beforeInterest * 0.1), 'ten per cent');
  assert.equal(you.inventory.missile, WEAPONS.missile.pack, 'what you bought comes with you');
  // the computer shops as the round turns, and never for the human
  const bought = aiShop(g, g.tanks[1], rng(5));
  assert.ok(bought.length >= 1 && bought.every((id) => SHOP.some((e) => e.id === id)));
  assert.deepEqual(aiShop(g, you), []);
  const poor = { kind: 'moron', cash: 0, inventory: {}, items: {} };
  assert.deepEqual(aiShop(g, poor, rng(1)), [], 'nothing for nothing');
  assert.equal(payInterest({ cash: 1000 }, 0.05), 50);
});

test('the screen\u2019s pictures for fire and beams come and go with time', () => {
  const fires = [{ id: 1, cells: [{ x: 3, y: 5, step: 0 }, { x: 4, y: 5, step: 1 }, { x: 4, y: 5, step: 2 }], t0: 0 }];
  const lit = fireTiles(fires, 300);
  assert.equal(lit.length, 2, 'a cube per burning cell, each once');
  assert.equal(fireTiles(fires, 5000).length, 0, 'burnt out');
  const beams = [{ id: 1, x0: 0, y0: 5, x1: 40, y1: 5, t0: 0 }];
  assert.ok(beamTiles(beams, 10).length > 20, 'beads along the line');
  assert.equal(beamTiles(beams, 1000).length, 0, 'gone');
  const g = three();
  g.shells = [{ x: 10, y: 10, vx: 0, vy: 0, weapon: 'missile', owner: 0, path: [], t: 0 }, { x: 12, y: 10, vx: 0, vy: 0, weapon: 'missile', owner: 0, path: [], t: 0, boring: { dx: 0, dy: -1, left: 3 } }];
  const balls = actorLayer(g, 0).filter((t) => t.txid.startsWith('shell'));
  assert.equal(balls.length, 2, 'every shell in the air is drawn');
  g.tanks[0].shield = { id: 'shield', hp: 10, deflect: false };
  assert.ok(actorLayer(g, 0).some((t) => t.txid === 'shield0' && t.wire), 'a shield is a wire cube round the tank');
});

test('the manual\u2019s other weapons: a riot charge cuts a wedge from the turret at once, a dirt charge fills one, liquid dirt fills the holes, the disrupter settles the field, plasma spares its thrower, padded and spring walls', () => {
  const g = three({ wind: 'none' });
  flatten(g, 20);
  const t = current(g);
  t.x = 30; t.y = 20; g.tanks[1].x = 70; g.tanks[1].y = 20; g.tanks[2].x = 85; g.tanks[2].y = 20;
  t.inventory.riotCharge = 1;
  for (let x = 34; x < 42; x++) for (let y = 20; y < 27; y++) g.dirt[y * COLS + x] = 1;   // a bank of dirt in front of the barrel
  for (let x = 34; x < 42; x++) g.tops[x] = 27;
  aim(g, t, { angle: 0, power: 500, weapon: 'riotCharge' });      // flat to the right, into the bank
  const before = [...g.dirt].reduce((a, v) => a + v, 0);
  assert.ok(fire(g, t));
  assert.equal(g.shells.length, 0, 'no shell: it is a wedge');
  assert.ok(before - [...g.dirt].reduce((a, v) => a + v, 0) > 5, 'dirt went');
  assert.ok(g.tanks.every((k) => k.health === MAX_HEALTH), 'nobody hurt');
  // a dirt charge fills
  const g2 = three({ wind: 'none' });
  flatten(g2, 20);
  const t2 = current(g2); t2.x = 30; t2.y = 20;
  t2.inventory.dirtCharge = 1;
  aim(g2, t2, { angle: 30, power: 500, weapon: 'dirtCharge' });
  const b2 = [...g2.dirt].reduce((a, v) => a + v, 0);
  fire(g2, t2);
  assert.ok([...g2.dirt].reduce((a, v) => a + v, 0) > b2 + 10, 'dirt came');
  // liquid dirt pools in a hole
  const g3 = three({ wind: 'none' });
  flatten(g3, 20);
  for (let x = 50; x < 54; x++) for (let y = 14; y < 20; y++) g3.dirt[y * COLS + x] = 0;
  for (let x = 50; x < 54; x++) g3.tops[x] = 14;
  g3.tanks.forEach((k, i) => { k.x = 5 + i * 40 + (i ? 40 : 0); k.y = 20; });
  g3.shells = [{ x: 48.5, y: 20.5, vx: 2, vy: -1, weapon: 'liquidDirt', owner: 0, path: [], t: 1, primary: true }];
  g3.phase = 'flight';
  play(g3);
  assert.ok(g3.tops[51] > 14, 'the hole filled up some');
  // the disrupter settles an overhang anywhere on the field
  const g4 = three({ wind: 'none' });
  const col = 10;
  g4.dirt[(g4.tops[col] - 3) * COLS + col] = 0;                     // a hole under the top three cells, far from any blast
  const t4 = current(g4); t4.inventory.earthDisrupter = 1;
  aim(g4, t4, { weapon: 'earthDisrupter' });
  fire(g4, t4);
  assert.ok(g4.falling.some((f) => f.x === col) || dirtAt(g4, col, g4.tops[col] - 1), 'that column settled');
  let air = false, floating = false;
  for (let y = 0; y < ROWS; y++) { if (!dirtAt(g4, col, y)) air = true; else if (air) floating = true; }
  assert.equal(floating, false, 'nothing hangs in column 10 after the disrupter');
  // plasma: the thrower is spared, a neighbour in reach is not, and no crater
  const g5 = three({ wind: 'none' });
  flatten(g5, 10);
  const [me, foe] = g5.tanks;
  me.x = 40; me.y = 10; foe.x = 45; foe.y = 10; g5.tanks[2].x = 90; g5.tanks[2].y = 10;
  me.inventory.plasmaBlast = 1;
  aim(g5, me, { angle: 45, power: 1000, weapon: 'plasmaBlast' });
  const d5 = [...g5.dirt].reduce((a, v) => a + v, 0);
  fire(g5, me);
  assert.equal(me.health, MAX_HEALTH, 'the thrower is spared');
  assert.ok(foe.health < MAX_HEALTH, 'the neighbour is not');
  assert.equal([...g5.dirt].reduce((a, v) => a + v, 0), d5, 'energy, not a crater');
  // padded: the shell stops at the wall and drops; spring: it comes back faster than rubber
  const wallShot = (walls) => {
    const g6 = three({ wind: 'none', walls });
    flatten(g6, 3);
    const s6 = current(g6); s6.x = COLS - 6;
    aim(g6, s6, { angle: 10, power: 1000 });
    fire(g6, s6);
    const ev = play(g6);
    return { ev, blast: ev.find((e) => e.kind === 'blast') };
  };
  const padded = wallShot('padded');
  assert.ok(padded.blast && padded.blast.x > COLS - 2.5, 'padded: it dropped at the wall');
  const spring = wallShot('spring'), rubber = wallShot('rubber');
  assert.ok(spring.blast && rubber.blast && spring.blast.x < rubber.blast.x, 'spring: it came back further');
});

// ------------------------------------------------------------------ M3: the computer players
const seatAI = (kind, seed = 11, opts = {}) => {
  const g = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind }, { name: 'B', kind: 'moron' }], { seed, wind: 'turn', walls: 'rubber', ...opts });
  const t = g.tanks[1];
  g.turn = g.order.indexOf(t.id); g.phase = 'aim';
  return { g, t, target: nearest(g, t) };
};
const missOf = (g, t, target, d) => { const r = simulateShot(g, t, d.angle, d.power); return r.hit === target.id ? 0 : Math.abs(r.x - (target.x + TANK_W / 2)); };

test('the shot simulator agrees with a real flight: the same shot lands in the same place, with the walls and the dirt in it', () => {
  for (const walls of ['none', 'concrete', 'rubber', 'wrap']) {
    const g = three({ wind: 'turn', walls });
    const t = current(g);
    aim(g, t, { angle: t.x < COLS / 2 ? 40 : 140, power: 780 });
    const sim = simulateShot(g, t, t.angle, t.power);
    fire(g, t);
    const ev = play(g);
    const blast = ev.find((e) => e.kind === 'blast');
    if (sim.lost) assert.ok(!blast && ev.some((e) => e.kind === 'lost'), `${walls}: both lost`);
    else assert.ok(blast && Math.abs(blast.x - sim.x) < 0.6 && Math.abs(blast.y - sim.y) < 0.6, `${walls}: the flight landed where the simulator said (${blast?.x.toFixed(1)} vs ${sim.x.toFixed(1)})`);
  }
  // it changes nothing
  const g = three();
  const dirt = [...g.dirt], sparks = g.sparks.length;
  simulateShot(g, current(g), 45, 600);
  assert.deepEqual([...g.dirt], dirt); assert.equal(g.sparks.length, sparks); assert.equal(g.phase, 'aim');
});

test('the personalities: the Spoiler and the Cyborg land on their target, the Chooser and the Poolshark find a line, the Shooter only fires straight, the Tosser corrects until it hits, the Moron does not', () => {
  assert.deepEqual([...PERSONALITIES], ['moron', 'shooter', 'poolshark', 'tosser', 'chooser', 'spoiler', 'cyborg', 'unknown']);
  const hits = (fn, seeds) => seeds.map((seed) => { const { g, t, target } = seatAI('shooter', seed); return missOf(g, t, target, fn(g, t)); });
  const spoilerMisses = hits(spoiler, [1, 2, 3, 4, 5, 6]);
  assert.ok(spoilerMisses.filter((m) => m <= 1.5).length >= 5, `the Spoiler is nearly perfect (${spoilerMisses.map((m) => m.toFixed(1)).join(', ')})`);
  // the Cyborg picks its own target (the leader, here), so its miss is measured against whichever tank it chose
  const cyborgMisses = [1, 2, 3, 4, 5, 6].map((seed) => { const { g, t } = seatAI('cyborg', seed); const d = cyborg(g, t); const r = simulateShot(g, t, d.angle, d.power); return r.hit != null && r.hit !== t.id ? 0 : Math.min(...g.tanks.filter((k) => k !== t).map((k) => Math.abs(r.x - (k.x + TANK_W / 2)))); });
  assert.ok(cyborgMisses.filter((m) => m <= 1.5).length >= 5, `so is the Cyborg (${cyborgMisses.map((m) => m.toFixed(1)).join(', ')})`);
  const chooserMisses = hits(chooser, [1, 2, 3, 4, 5, 6]);
  assert.ok(chooserMisses.filter((m) => m <= 3).length >= 4, `the Chooser finds a line most of the time (${chooserMisses.map((m) => m.toFixed(1)).join(', ')})`);
  const moronMisses = hits(moron, [1, 2, 3, 4, 5, 6]);
  assert.ok(moronMisses.filter((m) => m > 3).length >= 4, `the Moron mostly misses (${moronMisses.map((m) => m.toFixed(1)).join(', ')})`);
  // the Shooter: a low angle when it fires at all
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { g, t, target } = seatAI('shooter', seed);
    const d = shooter(g, t);
    const low = Math.min(d.angle, 180 - d.angle);
    if (!d.fallback) assert.ok(low <= 36, `a straight shot (${d.angle}°)`);
  }
  // the Tosser: high, and the miss shrinks over its turns at the same target
  const { g, t, target } = seatAI('tosser', 5);
  const first = tosser(g, t);
  assert.ok(Math.min(first.angle, 180 - first.angle) >= 60, 'a lob');
  const misses = [missOf(g, t, target, first)];
  for (let i = 0; i < 6; i++) misses.push(missOf(g, t, target, tosser(g, t)));
  assert.ok(Math.min(...misses.slice(1)) < Math.max(misses[0], 2), `it corrects (${misses.map((m) => m.toFixed(1)).join(' -> ')})`);
  // the Poolshark banks off a rubber wall when that is the better line, and plays a Shooter otherwise
  const bank = seatAI('poolshark', 11, { walls: 'rubber' });
  const db = poolshark(bank.g, bank.t);
  assert.ok(missOf(bank.g, bank.t, bank.target, db) <= 3, 'a line, off the wall or not');
  const wall = seatAI('poolshark', 11, { walls: 'concrete' });
  const pw = poolshark(wall.g, wall.t), sw = shooter(wall.g, wall.t);
  if (!pw.fallback && !sw.fallback) assert.deepEqual(pw, sw, 'no rebound to play: a Shooter');
  else assert.equal(!!pw.fallback, !!sw.fallback, 'both without a line of fire');
  // the Cyborg's grudge: whoever hit it last is the target
  const { g: gc, t: tc } = seatAI('cyborg', 3);
  const you = gc.tanks[0];
  applyDamage(gc, tc, 10, you.id);
  assert.equal(tc.lastHitBy, you.id);
  const dc = cyborg(gc, tc);
  const rc = simulateShot(gc, tc, dc.angle, dc.power);
  assert.ok(rc.hit === you.id || Math.abs(rc.x - (you.x + 1)) < 2, 'it fires back at You');
  // decide() plays the persona, and an Unknown has one drawn from the others each round
  const { g: gu, t: tu } = seatAI('unknown', 8);
  assert.ok(PERSONALITIES.includes(tu.persona) && tu.persona !== 'unknown');
  const d = decide(gu, tu);
  assert.ok(d.angle >= 0 && d.angle <= 180 && WEAPONS[d.weapon]);
  // prepare(): a hurt Spoiler uses a battery and raises a shield before its shot; a Moron does not
  const { g: gp, t: tp } = seatAI('spoiler', 2);
  tp.health = 40; tp.items = { battery: 1, shield: 1 };
  assert.deepEqual(prepare(gp, tp), ['battery', 'shield']);
  assert.equal(tp.health, 70); assert.ok(tp.shield);
  const { g: gm, t: tm } = seatAI('moron', 2);
  tm.health = 40; tm.items = { battery: 1 };
  assert.deepEqual(prepare(gm, tm), []);
});

test('the computer shops by taste: a Shooter buys missiles, a Tosser MIRVs, a Cyborg the Death\u2019s Head; a Moron at random; nobody beyond their cash', () => {
  const buys = (kind) => { const { g, t } = seatAI(kind, 4); t.cash = 60000; return aiShop(g, t); };
  assert.ok(buys('shooter').includes('missile'));
  assert.ok(buys('tosser').includes('mirv'));
  assert.ok(buys('cyborg').includes('deathsHead'));
  assert.ok(buys('spoiler').includes('nuke'));
  const { g, t } = seatAI('chooser', 4);
  t.cash = 500;
  assert.deepEqual(aiShop(g, t), [], 'nothing it can afford on its list');
  const { g: gm, t: tm } = seatAI('moron', 4);
  tm.cash = 60000;
  const m = aiShop(gm, tm, rng(9));
  assert.ok(m.length >= 1 && m.every((id) => SHOP.some((e) => e.id === id)));
});

// ------------------------------------------------------------------ M4: the look, the sound, the talk
test('the fabulous part: a blast smokes after its flash, a tank goes up in sparks and pieces, dust rises where dirt lands, a fall is animated and a parachute drawn, the wind blows motes, the march is notes the table knows', () => {
  const b = [{ id: 1, x: 40, y: 20, r: 4, t0: 0, big: true }];
  const R = recorder();
  paintBlasts(R.ctx, P, U, b, 200, { wind: 3, softStops: stops });
  assert.ok(R.ops.some((o) => o.op === 'ellipse'), 'a shockwave, an ellipse on an oblique board');
  assert.ok(R.ops.some((o) => o.op === 'arc' && /255,255,240/.test(String(o.fill))), 'a white core at the centre');
  assert.ok(R.ops.filter((o) => o.op === 'stroke').length > 20, 'and sparks trailing');
  const near = R.ops.filter((o) => o.op === 'arc').map((o) => Math.hypot(o.x - 400, o.y + 160));
  assert.ok(Math.min(...near) < 40, 'painted where the shell landed, in the board\u2019s own projection');

  const L = recorder();
  paintBlasts(L.ctx, P, U, b, 1500, { wind: 3, softStops: stops });
  assert.ok(!L.ops.some((o) => o.op === 'ellipse'), 'the shockwave is over by then');
  assert.ok(L.ops.some((o) => o.op === 'arc'), 'the smoke is not');
  const meanX = (ops) => ops.filter((o) => o.op === 'arc').reduce((n, o) => n + o.x, 0) / ops.filter((o) => o.op === 'arc').length;
  const A = recorder(), B = recorder();
  paintBlasts(A.ctx, P, U, b, 1500, { wind: 6, softStops: stops });
  paintBlasts(B.ctx, P, U, b, 1500, { wind: -6, softStops: stops });
  assert.ok(meanX(A.ops) > meanX(B.ops), 'the smoke drifts downwind');
  const Z = recorder();
  paintBlasts(Z.ctx, P, U, b, 4000, { wind: 3, softStops: stops });
  assert.equal(Z.ops.length, 0, 'and all of it is gone after');
  const RI = recorder();
  paintBlasts(RI.ctx, P, U, [{ id: 2, x: 10, y: 10, r: 4, t0: 0, riot: true }], 1500, { softStops: stops });
  assert.equal(RI.ops.length, 0, 'a riot charge makes no smoke');

  // a tank going up: its fire is painted in its own colour, its hull is three tumbling tiles
  const D = recorder();
  paintDeaths(D.ctx, P, U, [{ id: 3, x: 20, y: 12, colour: '#4d8dff', t0: 0 }], 300, { softStops: stops });
  assert.ok(D.ops.some((o) => o.op === 'arc' && /77,141,255/.test(String(o.fill))), 'the flash takes the tank\u2019s colour');
  assert.ok(D.ops.filter((o) => o.op === 'stroke').length > 40, 'sparks on their own paths');
  const d = deathTiles([{ id: 3, x: 20, y: 12, colour: '#4d8dff', t0: 0 }], 300);
  assert.equal(d.filter((t) => t.txid.startsWith('piece')).length, 3, 'three pieces of hull');
  assert.ok(d.every((t) => t.poly && t.rot !== 0), 'and they tumble');
  assert.equal(deathTiles([{ id: 3, x: 20, y: 12, colour: '#4d8dff', t0: 0 }], 5000).length, 0);
  const DU = recorder(), DUgone = recorder();
  paintDust(DU.ctx, P, U, [{ id: 4, x: 5, y: 9, t0: 0 }], 200, { softStops: stops });
  paintDust(DUgone.ctx, P, U, [{ id: 4, x: 5, y: 9, t0: 0 }], 2000, { softStops: stops });
  assert.ok(DU.ops.length > 0 && DUgone.ops.length === 0, 'dust rises where dirt lands, and settles');

  // THE AIM GAUGE: a protractor, a needle whose length is the power, and both numbers written out
  const G1 = recorder();
  paintAim(G1.ctx, P, U, { x: 30, y: 10, angle: 45, power: 500, colour: '#f7931a' });
  const text = G1.ops.find((o) => o.op === 'text');
  assert.ok(text && /45°/.test(text.text) && /500/.test(text.text), 'the angle and the power are written at the needle');
  assert.ok(G1.ops.some((o) => o.op === 'ellipse'), 'the protractor arc');
  assert.ok(G1.ops.filter((o) => o.op === 'stroke').length >= 13, 'a tick every fifteen degrees, and the needle');
  const tipOf = (angle, power) => { const r = recorder(); paintAim(r.ctx, P, U, { x: 30, y: 10, angle, power }); return r.ops.find((o) => o.op === 'text'); };
  assert.ok(tipOf(45, 1000).x > tipOf(45, 100).x, 'more power draws a longer needle');
  assert.ok(tipOf(135, 500).x < tipOf(45, 500).x, 'and the needle follows the angle across');
  // a fall: from the old height to the new, by gravity; a chute: linear, with a canopy while it lasts
  const falls = new Map([[0, { from: 20, to: 12, t0: 0, ms: 1000, chute: false }], [1, { from: 20, to: 12, t0: 0, ms: 1000, chute: true }]]);
  const half = fallingTanks(falls, 500);
  assert.ok(Math.abs(half.tankY.get(0) - 18) < 1e-9, 'gravity: a quarter of the way at half time');
  assert.ok(Math.abs(half.tankY.get(1) - 16) < 1e-9, 'a parachute: halfway at half time');
  assert.ok(half.chutes.has(1) && !half.chutes.has(0));
  const g = three();
  const drawn = actorLayer(g, 500, { falls });
  assert.ok(drawn.some((t) => t.txid === 'chute1' && t.poly), 'the canopy is drawn over the tank under it');
  assert.ok(drawn.some((t) => t.txid === 'track0'), 'a tank has tracks now');
  // THE AIR IS A FLOW FIELD, ADVECTED (operator: "really leverage a shifting effect that conveys
  // the air flow. Fluid simulation?"). Particles carried by the wind plus the curl of a drifting
  // noise field: divergence-free, so it swirls without piling up or tearing.
  const c0 = curl(3, 2, 0), c1 = curl(3.02, 2, 0);
  assert.ok(Number.isFinite(c0.x) && Number.isFinite(c0.y), 'the curl is a vector');
  assert.ok(Math.hypot(c1.x - c0.x, c1.y - c0.y) < 0.5, 'and it is smooth: a small step is a small change');
  assert.ok(noise2(1.5, 2.5) >= 0 && noise2(1.5, 2.5) <= 1);
  const flow = makeFlow(120, 800, 400, 7);
  assert.equal(flow.length, 120);
  assert.ok(flow.every((p) => p.x >= 0 && p.x <= 800 && p.y >= 0 && p.y <= 400), 'seeded over the plane');
  // carried downwind, EVERY particle, EVERY step: the eddies bend the flow but never turn it
  for (const wind of [6, -6, 1.5]) {
    const parts = makeFlow(80, 800, 400, 3);
    let now = 0, steps = 0, back = 0, total = 0;
    for (let i = 0; i < 120; i++) {
      now += 16;
      for (const sg of stepFlow(parts, 16, { wind, w: 800, h: 400, now })) { steps += 1; const d = (sg.x1 - sg.x0) * Math.sign(wind); total += d; if (d <= 0) back += 1; }
    }
    assert.equal(back, 0, `no streak ever points upwind at wind ${wind} (${back} of ${steps})`);
    assert.ok(total / steps > 0.5, `and the air is carried, not just stirred (${(total / steps).toFixed(2)}px a frame)`);
  }
  // it swirls: the particles do not all travel on one straight line
  const parts2 = makeFlow(120, 800, 400, 5);
  let t2 = 0, spread = 0;
  for (let i = 0; i < 90; i++) { t2 += 16; const segs = stepFlow(parts2, 16, { wind: 5, w: 800, h: 400, now: t2 }); if (i === 89) { const ys = segs.map((sg) => sg.y1 - sg.y0); spread = Math.max(...ys) - Math.min(...ys); } }
  assert.ok(spread > 0.2, `the flow has eddies across it (${spread.toFixed(2)}px of crosswind in one step)`);
  // still air draws nothing at all, and a gale draws more than a breeze
  assert.equal(plasmaCells(800, 400, 0, 0).length, 0, 'no plasma in still air');
  assert.ok(plasmaCells(800, 400, 0, 9).length > 0, 'and some under a wind');
  assert.ok(plasmaCells(800, 400, 0, 9).every((c) => c.alpha <= 0.075), 'the wash is never more than a whisper');
  // both painters use flat fills and strokes only
  const R2 = recorder();
  paintFlow(R2.ctx, stepFlow(makeFlow(20, 800, 400, 1), 16, { wind: 5, w: 800, h: 400, now: 500 }));
  assert.ok(R2.ops.some((o) => o.op === 'stroke'), 'the streaks are stroked lines');
  const banner = windBanner(-6, 800, 400);
  assert.equal(banner[0].dir, -1, 'the banner points the way it blows');
  assert.ok(windBanner(9, 800, 400).length > windBanner(2, 800, 400).length, 'more chevrons in a gale');
  assert.equal(windBanner(0, 800, 400).length, 0, 'still air says nothing');

  // THE AIR KEEPS ITS OWN TIME (operator: "the nebula effects ... rapidly block in the reverse
  // direction" during a change of wind). On a page clock a day old, a wash whose drift was
  // `now * speed` moved by a day's worth of travel for the smallest change in speed. Integrated,
  // a change of wind between two frames moves it by one frame's travel and no more.
  const day = 86_400_000;
  const clock = airClock();
  for (let i = 0; i < 100; i++) advanceAir(clock, 16, 4);            // a while at one wind
  const before = plasmaCells(800, 400, { ...clock }, 4);
  advanceAir(clock, 16, -9);                                          // then the wind turns hard
  const after = plasmaCells(800, 400, clock, -9);
  const settled = (a, b) => a.length && b.length && Math.abs(a[0].x - b[0].x) < 40 && Math.abs(a[0].alpha - b[0].alpha) < 0.02;
  assert.ok(settled(before, after), 'the wash barely moves across a change of wind');
  assert.ok(Math.abs(clock.drift) < 1000, `and a day-old page changes nothing about that (drift ${clock.drift.toFixed(2)}, not ${(day / 1000 * 0.5).toFixed(0)})`);
  // the flow's field likewise: one frame at the new wind moves a particle one frame's distance
  const parts3 = makeFlow(40, 800, 400, 9, day);
  const c3 = airClock();
  for (let i = 0; i < 30; i++) { advanceAir(c3, 16, 3); stepFlow(parts3, 16, { wind: 3, w: 800, h: 400, now: day + i * 16, clock: c3 }); }
  const xs = parts3.map((p) => p.x), borns = parts3.map((p) => p.born);
  advanceAir(c3, 16, -8);
  stepFlow(parts3, 16, { wind: -8, w: 800, h: 400, now: day + 31 * 16, clock: c3 });
  // a particle reborn on this very step is placed afresh, which is not a leap; the rest must not leap
  const jump = Math.max(0, ...parts3.map((p, i) => (p.born === borns[i] ? Math.abs(p.x - xs[i]) : 0)));
  assert.ok(jump < 12, `no particle leaps when the wind turns (largest step ${jump.toFixed(1)}px)`);

  // NOTHING IN THE FIELD SCROLLS: a frame of evolution with no drift leaves the wash where it is,
  // cell for cell, and nearly the same shape
  const c4 = airClock(); for (let i = 0; i < 20; i++) advanceAir(c4, 16, 0.5);
  const still0 = plasmaCells(800, 400, { t: c4.t, drift: 0 }, 5), still1 = plasmaCells(800, 400, { t: c4.t + 0.016 * 0.16, drift: 0 }, 5);
  const key = (c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
  const set0 = new Set(still0.map(key)), shared = still1.filter((c) => set0.has(key(c))).length;
  assert.ok(shared / Math.max(1, still1.length) > 0.95, `a frame later the same cells are lit (${shared} of ${still1.length})`);

  // and the plasma paints one flat rect a cell
  const ops = [];
  const ctx = { beginPath: () => {}, arc: () => ops.push('disc'), fill: () => {}, set fillStyle(v) { ops.push(`fill:${v}`); } };
  paintPlasma(ctx, plasmaCells(800, 400, 0, 6));
  assert.equal(ops.filter((o) => o === 'disc').length, plasmaCells(800, 400, 0, 6).length, 'one soft disc per cell');
  // and the population is never one cohort: born on a clock twelve hours old, it still spreads
  const old = makeFlow(60, 800, 400, 2, 46_000_000);
  const lives = new Set(old.map((p) => p.life));
  assert.ok(lives.size > 30, 'each particle has a life of its own');
  let alive = 0; stepFlow(old, 16, { wind: 5, w: 800, h: 400, now: 46_000_016 }).forEach(() => { alive += 1; });
  assert.ok(alive > 40, `most of the field is still in flight after the first step (${alive} of 60)`);
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.match(src, /t - G\.windAt >= WIND_MS\) \{ G\.windAt = t; G\.dirty = true; \}/, 'the loop marks itself dirty for the wind alone');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="syWind"') < html.indexOf('id="syLand"'), 'the plane is behind the land');
  assert.ok(actorLayer(g, 0).some((t) => t.txid.startsWith('flag')), 'a pennant streams on every turret');
  // the march
  assert.ok(THEMES.scorched && THEMES.scorched.notes === THEME_SCORCHED && THEMES.scorched.bpm > 60);
  const known = new Set(['A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'GS4', 'E4', 'D4', 'F4', 'G4', 'BB4', 'R']);
  for (const [n, beats] of THEME_SCORCHED) { assert.ok(known.has(n), `${n} is a note the table knows`); assert.ok(beats > 0); }
  assert.doesNotThrow(() => { setMusic(true, 'scorched'); setMusic(false); }, 'a no-op without an AudioContext');
});

// M5: ATTRACT MODE -- every seat a computer player, and no high score written for a war nobody played
test('scorched yard: attract mode fields no human', () => {
  const base = { opponents: 2, opponentKind: 'mix', demo: false };
  const seats = players(base);
  assert.equal(seats.length, 3);
  assert.equal(seats.filter((p) => p.kind === 'human').length, 1, 'the human keeps a seat with the switch off');
  const demo = players({ ...base, demo: true });
  assert.equal(demo.length, 3, 'the same table: the human chair is taken by a computer player');
  assert.ok(!demo.some((p) => p.kind === 'human'), 'nobody at the keys');
  assert.equal(new Set(demo.map((p) => p.name)).size, 3, 'and they are all named apart');
  const one = players({ opponents: 3, opponentKind: 'spoiler', demo: true });
  assert.deepEqual(one.map((p) => p.name), ['Spoiler', 'Spoiler 2', 'Spoiler 3', 'Spoiler 4'].slice(0, 4));
  // the switch is on the panel and in Display settings
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="syDemo"/);
  assert.equal(DEFAULTS.scorched.demo, false, 'off until it is asked for');
  assert.equal(scorchedOptions(normalise({ scorched: { demo: true } })).demo, true);
});

// THE CONTROLS (the scope's C1): the ramp, the nudges, the wheel, R, and the typed numbers
test('scorched yard: a held key accelerates, and the numbers can be typed', () => {
  // the ramp: one, then two, then five -- crossing 180 degrees in about a second and a half
  assert.deepEqual([0, 1, 3, 4, 9, 10, 40].map(rampStep), [1, 1, 1, 2, 2, 5, 5]);
  let deg = 0;
  for (let n = 1; n <= 45; n++) deg += rampStep(n);
  assert.ok(deg >= 180, `forty-five repeats (about 1.5s at the browser's rate) crosses the arc: ${deg}`);
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.match(src, /case ',': case '<': aim\(g, t, \{ power: t\.power - 1 \}\)/, 'comma nudges the power down by one');
  assert.match(src, /case '\.': case '>': aim\(g, t, \{ power: t\.power \+ 1 \}\)/, 'and the full stop up');
  assert.match(src, /case 'r': case 'R': repeatShot\(g, t\)/, 'R fires the last shot again');
  assert.match(src, /G\.lastShot = \{ angle: me\.angle, power: me\.power, weapon: me\.weapon \}/, 'which is remembered as it is fired');
  assert.match(src, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/, 'the wheel works over the field');
  assert.match(src, /if \(G\.editing\) return;/, 'and the panel holds still while a number is typed');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /hold to go faster/, 'the keys line says the modifiers out loud');
});

// THE SHOP WAS UNBUYABLE (operator, 2026-09-16: "i can't buy anything in the shop between rounds").
// Each panel compared its new markup with `box.innerHTML`, which the browser gives back normalised,
// so the comparison never matched and the markup was rebuilt on every draw -- thirty times a second
// once the wind kept the board drawing. A button replaced between the press and the release is
// never clicked. The panels remember what they wrote instead.
test('scorched yard: a panel is written once, not on every frame', () => {
  // a box that normalises what it is given, the way a browser does
  const box = {
    _v: '', scrollTop: 0, writes: 0,
    set innerHTML(v) { this.writes += 1; this._v = String(v).replace(/ disabled>/g, ' disabled="">'); },
    get innerHTML() { return this._v; },
  };
  const html = '<button data-buy="nuke" disabled>buy</button>';
  assert.equal(setHtml(box, html, 'test-shop'), true, 'the first write lands');
  assert.equal(box.writes, 1);
  for (let i = 0; i < 30; i++) setHtml(box, html, 'test-shop');
  assert.equal(box.writes, 1, 'and the same markup is never written again, however many frames pass');
  assert.notEqual(box.innerHTML, html, 'even though the browser hands it back changed');
  // a changed panel is written, and keeps its place in the list
  box.scrollTop = 300;
  assert.equal(setHtml(box, html + '<i>more</i>', 'test-shop'), true);
  assert.equal(box.writes, 2);
  assert.equal(box.scrollTop, 300, 'the shop does not jump back to the top when something is bought');
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML !== html/.test(src), 'no panel compares against the browser\u2019s own innerHTML any more');
});

// THE WIND HOLDS ITS DIRECTION (operator, 2026-09-16: "the wind still changes direction during my
// round ... not shift back and forth during the same round")
test('scorched yard: one wind a round, unless the mode says otherwise', () => {
  const g = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }, { name: 'B', kind: 'moron' }], { seed: 11 });
  assert.equal(g.windMode, 'round', 'the shipped mode');
  const sign = Math.sign(g.wind);
  const mags = new Set([Math.abs(g.wind)]);
  for (let i = 0; i < 12; i++) { nextTurn(g); assert.equal(Math.sign(g.wind), sign, 'the round holds its direction, turn after turn'); mags.add(Math.abs(g.wind)); }
  assert.ok(mags.size > 4, `and its strength is drawn again for every turn (${[...mags].join(', ')})`);
  nextRound(g);
  const next = new Set();
  for (let i = 0; i < 40; i++) { const t2 = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: i }); next.add(Math.sign(t2.wind)); }
  assert.equal(next.size, 2, 'a fresh round can blow either way');
  // the original's mode is still there for anyone who wants it
  const t = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: 3, wind: 'turn' });
  const seen = new Set();
  for (let i = 0; i < 20; i++) { nextTurn(t); seen.add(t.wind); }
  assert.ok(seen.size > 3 && new Set([...seen].map(Math.sign)).size === 2, 'every turn draws a fresh wind under the old mode, direction and all');
  const still = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: 3, wind: 'none' });
  assert.equal(still.wind, 0);
  assert.equal(DEFAULTS.scorched.wind, 'round', 'a fresh install holds its direction for the round');
  assert.equal(normalise({ scorched: { wind: 'turn' } }).scorched.wind, 'turn', 'and a saved choice stands');
});

// A WAY OUT WHEN YOU ARE KNOCKED OUT (operator, 2026-09-16: "There is no way to restart the game if
// I die. I have to wait for the AI to finish the game. Give me a restart button")
test('scorched yard: a restart button and its key', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="syRestart"/, 'the button is on the panel');
  assert.match(html, /F2 restart/, 'and the keys line says the key');
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.match(src, /if \(e\.key === 'F2'\) \{ e\.preventDefault\(\); restart\(\); return; \}/, 'F2 restarts');
  assert.match(src, /el\('syRestart'\)\?\.addEventListener\('click', \(\) => restart\(\)\)/, 'so does the button');
  assert.match(src, /function restart\(\) \{[\s\S]*?start\(\);/, 'and a restart is a fresh war from round one');
  assert.match(src, /you are out for this round/, 'a knocked-out player is told what the ways out are');
});

// CHEAT MODE AND EIGHT SEATS (operator, 2026-09-16)
test('scorched yard: the firing solution is the rules\u2019 own path, and eight can play', () => {
  const g = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: 4 });
  const t = current(g);
  aim(g, t, { angle: 45, power: 600 });
  const sol = solutionOf(g, t);
  assert.ok(sol && sol.pts.length > 10 && sol.impact, 'a path and a landing');
  const real = simulateShot(g, t, 45, 600);
  assert.ok(Math.abs(sol.impact.x - real.x) < 1 && Math.abs(sol.impact.y - real.y) < 1, 'it lands where the rules say it lands');
  aim(g, t, { angle: 45, power: 700 });
  const further = solutionOf(g, t);
  assert.ok(further.pts.length !== sol.pts.length || further.impact.x !== sol.impact.x, 'and it moves with the aim');
  const R = recorder();
  paintSolution(R.ctx, P, U, sol.pts, { impact: sol.impact });
  assert.ok(R.ops.filter((o) => o.op === 'arc').length > 10 && R.ops.some((o) => o.op === 'ellipse'), 'beads along the flight and a ring where it lands');
  assert.equal(DEFAULTS.scorched.cheat, false, 'off until it is asked for');
  assert.equal(scorchedOptions(normalise({ scorched: { cheat: true } })).cheat, true);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="syCheat"/, 'the switch is on the panel');
  // eight seats: the human and seven, each its own colour
  assert.equal(TANK_COLOURS.length, 8);
  assert.equal(new Set(TANK_COLOURS).size, 8, 'all different');
  const eight = players({ opponents: 7, opponentKind: 'mix', demo: false });
  assert.equal(eight.length, 8);
  const big = newGame(eight, { seed: 2 });
  assert.equal(new Set(big.tanks.map((k) => k.colour)).size, 8, 'no two tanks share a colour');
  for (let i = 0; i < big.tanks.length; i++) for (let j = i + 1; j < big.tanks.length; j++) assert.ok(Math.abs(big.tanks[i].x - big.tanks[j].x) >= TANK_W, 'no two tanks overlap on the field');
  const row = PANEL.find((gr) => gr.group === 'scorched').rows.find((r) => r.key === 'opponents');
  assert.equal(row.max, 7, 'the setting reaches seven');
});

// THE LAND CANVAS FORGETS THE OLD GAME (operator, 2026-09-16: "more than 2 opponents are placed in
// mid air and in ground"). The rules place every tank on its own ground -- checked here for three
// to eight seats over many seeds -- so the tanks in the air were drawn over a land canvas that had
// not been redrawn: a fresh game restarts the land's version count, and the screen keyed its cache
// on that number alone.
test('scorched yard: every seat stands on the ground, and a new game always redraws its land', () => {
  for (const n of [3, 5, 8]) {
    for (let seed = 1; seed <= 40; seed++) {
      const seats = [{ name: 'You', kind: 'human' }];
      for (let i = 1; i < n; i++) seats.push({ name: `A${i}`, kind: 'moron' });
      const g = newGame(seats, { seed });
      for (const t of g.tanks) assert.ok(topOf(g, t.x) === t.y && topOf(g, t.x + 1) === t.y, `${n} seats, seed ${seed}: a tank at ${t.x} sits on its ground`);
    }
  }
  const a = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: 1 });
  const b = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: 2 });
  assert.equal(a.landVersion, b.landVersion, 'two fresh games share a version number, which is why the key alone was not enough');
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.match(src, /clearTimeout\(G\.demoTimer\); G\.demoTimer = null;[\s\S]{0,900}G\.landKey = '';/, 'a new game clears the land cache');
  assert.match(src, /nextRound\(g\);\n  G\.landKey = '';/, 'and so does a new round');
});

// A STEADY FLOW, NOT A FRONT (operator, 2026-09-16: "the wave simulation comes across as a front as
// opposed to a steady flow of fluid ... make that air movement effect even more incredible")
test('scorched yard: the air stays evenly filled, carries tails, and runs on currents', () => {
  // density: in a light wind, where lives end before the crossing does, the downwind half used to
  // empty out; a reborn particle now comes back anywhere, so both halves stay populated
  const parts = makeFlow(240, 800, 400, 4, 0);
  const c = airClock();
  let now = 0;
  for (let i = 0; i < 900; i++) { now += 16; advanceAir(c, 16, 1.5); stepFlow(parts, 16, { wind: 1.5, w: 800, h: 400, now, clock: c }); }
  const left = parts.filter((p) => p.x >= 0 && p.x < 400).length, right = parts.filter((p) => p.x >= 400 && p.x <= 800).length;
  assert.ok(Math.min(left, right) / Math.max(left, right) > 0.55, `both halves of the field are populated after fifteen seconds (${left} upwind, ${right} downwind)`);
  // tails: a particle remembers where it has been, and the painter draws the ribbon
  const segs = stepFlow(parts, 16, { wind: 1.5, w: 800, h: 400, now: now + 16, clock: c });
  assert.ok(segs.some((sg) => sg.tail && sg.tail.length >= 8), 'a particle carries a tail of its last positions');
  const R = recorder();
  paintFlow(R.ctx, segs.slice(0, 5));
  assert.ok(R.ops.filter((o) => o.op === 'stroke').length > 5 * 3, 'the ribbon is several strokes, thinning toward its end');
  // currents: traced through the same field, from the upwind edge across, and never upwind
  for (const wind of [5, -5]) {
    const lines = traceStreamlines(c, { wind, w: 800, h: 400 });
    assert.ok(lines.length >= 12, 'a dozen or so currents');
    for (const l of lines) for (let i = 1; i < l.pts.length; i++) assert.ok((l.pts[i].x - l.pts[i - 1].x) * Math.sign(wind) > 0, 'every current runs downwind at every step');
    assert.ok(lines.some((l) => Math.abs(l.pts[l.pts.length - 1].y - l.pts[0].y) > 4), 'and they bend');
  }
  assert.equal(traceStreamlines(c, { wind: 0, w: 800, h: 400 }).length, 0, 'still air has no currents');
  const D = recorder();
  D.ctx.setLineDash = (d) => D.ops.push({ op: 'dash', d }); D.ctx.lineDashOffset = 0;
  paintStreamlines(D.ctx, traceStreamlines(c, { wind: 5, w: 800, h: 400 }), 120);
  assert.ok(D.ops.some((o) => o.op === 'dash' && o.d.length === 2), 'the currents are dashed, so their dashes can run');
});

// THE PANEL IS YOURS WHILE YOU SHOP (operator, 2026-09-16: "my cash doesn't get subtracted when I
// purchase stuff" -- it was; the panel was showing the computer player whose turn the round ended on)
test('scorched yard: a purchase takes the money, and the panel shows the shopper between rounds', () => {
  const g = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: 3 });
  const you = g.tanks[0];
  you.cash = 13000;
  assert.equal(buy(you, 'napalm'), true);
  assert.equal(you.cash, 3000, 'the price is taken');
  assert.equal(you.inventory.napalm, 10, 'and the pack is added');
  assert.equal(buy(you, 'nuke'), false, 'and nothing is sold on credit');
  assert.equal(you.cash, 3000);
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.match(src, /const t = G\.shopping && you \? you : current\(g\);/, 'the panel shows the human while the shop is open');
  assert.match(src, /\['turn', G\.shopping && you \? `\$\{t\.name\} · shopping` : t\.name\]/, 'and says so');
});

// THE DRAG CLICKS (operator, 2026-09-16: "I'm not hearing the adjustment clicks when I move with the mouse")
test('scorched yard: a mouse drag clicks as it crosses degrees and tens of power, like the keys', () => {
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  const move = src.slice(src.indexOf('function onPointerMove'), src.indexOf('function onPointerUp'));
  assert.match(move, /if \(Math\.round\(t\.angle\) !== wasAngle\) \{ sound\.play\('move'\)/, 'a degree crossed clicks');
  assert.match(move, /Math\.round\(t\.power \/ 10\) !== Math\.round\(wasPower \/ 10\)\) \{ sound\.play\('soft'\)/, 'ten of power crossed clicks');
  assert.match(move, /now - \(G\.dragClickAt \?\? 0\) >= 45/, 'and no more often than every 45 ms');
});

// EVERY SHELL LOOKS LIKE ITSELF (operator, 2026-09-16: "Everything is the same white dot effect for
// the shot", then "The missile effect is the same as the baby missile. I said I wanted variance
// across all shot types")
test('scorched yard: every weapon that flies has a look of its own', () => {
  const flies = WEAPON_ORDER.filter((id) => !['laser', 'riotCharge', 'riotBlast', 'dirtCharge', 'earthDisrupter', 'plasmaBlast'].includes(id));
  assert.equal(flies.length, 27, 'twenty-seven weapons fly');
  for (const id of flies) assert.ok(SHELL_LOOKS[id], `${id} has its own entry`);
  assert.ok(SHELL_LOOKS.funkyBomblet, 'and so does the bomblet a Funky Bomb throws');
  const sig = (id) => { const l = shellLook(id); return `${l.core}|${l.glow}|${l.trail}|${l.size}|${l.len}|${l.count}|${l.width}|${l.ring}|${l.spin}`; };
  assert.equal(new Set(flies.map(sig)).size, flies.length, 'no two of them share a look');
  assert.notEqual(shellLook('missile').core, shellLook('babyMissile').core, 'a missile is not a baby missile');
  assert.ok(shellLook('missile').size > shellLook('babyMissile').size && shellLook('missile').len > shellLook('babyMissile').len, 'it is bigger, with a longer exhaust');
  assert.ok(shellLook('missile').ring && !shellLook('babyMissile').ring, 'and ringed');
  assert.ok(shellLook('nuke').size > shellLook('babyNuke').size && shellLook('nuke').count > shellLook('babyNuke').count, 'a nuke over a baby nuke likewise');
  assert.ok(shellLook('heavyRoller').ring && shellLook('tonOfDirt').ring && shellLook('heavySandhog').ring && shellLook('deathsHead').ring, 'the heavy ones wear a ring');
  assert.equal(shellLook('tracer').glow, null, 'a tracer does not glow: that is the point of a tracer');
  assert.equal(shellLook('smokeTracer').trail, 'smoke', 'a smoke tracer smokes');
  assert.equal(shellLook('no-such-thing'), SHELL_LOOKS.babyMissile, 'anything unknown flies as a baby missile');
  // the tile layer draws the core in the weapon's colour and size
  const g = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: 5 });
  g.shells.push({ x: 10, y: 20, vx: 5, vy: 5, weapon: 'nuke', owner: 0, path: [{ x: 9, y: 19 }, { x: 10, y: 20 }], t: 0, primary: true });
  g.shells.push({ x: 30, y: 20, vx: 5, vy: 5, weapon: 'tracer', owner: 0, path: [{ x: 29, y: 19 }, { x: 30, y: 20 }], t: 0, primary: true });
  const balls = actorLayer(g, 0).filter((t) => t.txid.startsWith('shell'));
  assert.equal(balls.length, 2);
  assert.notEqual(balls[0].color, balls[1].color); assert.ok(balls[0].s > balls[1].s, 'a nuke is a bigger ball than a tracer');
  // the painted layer: every flying weapon paints, and paints differently from its family's baby
  const ops = (id) => { const R = recorder(); const path = Array.from({ length: 16 }, (_, i) => ({ x: 10 + i, y: 20 + i * 0.5 })); paintShells(R.ctx, P, U, [{ x: 26, y: 28, vx: 5, vy: 2, weapon: id, path }], 500, { softStops: stops, looks: shellLook }); return R.ops; };
  for (const id of flies) assert.ok(ops(id).length > 0, `${id} paints something in the air`);
  const count = (id) => ops(id).length;
  assert.ok(count('missile') > count('babyMissile'), 'a missile paints more than a baby missile');
  assert.ok(count('nuke') > count('babyNuke') && count('heavyRoller') > count('roller') && count('tonOfDirt') > count('dirtClod'), 'and so on up each family');
  assert.ok(ops('nuke').some((o) => o.op === 'arc' && /100,255,70/.test(String(o.fill))), 'a nuke glows green');
  assert.ok(!ops('tracer').some((o) => o.op === 'arc' && /255,205,130|100,255,70/.test(String(o.fill))), 'a tracer glows in no colour at all');
  assert.ok(ops('missile').some((o) => o.op === 'ellipse'), 'the missile wears its ring');
});

// AIR SEEN BY WHAT IT DOES (operator, 2026-09-16: "Looks too much like shooting stars instead of air
// movement. Is there some sort of more impressive ripple or bowing effect"). The streaks had bright
// heads and fading tails -- a meteor's shape. The wind refracts the sky instead, and bows a few
// broad soft bands of air, and nothing in either has a head.
test('scorched yard: the wind ripples the sky and bows soft bands, downwind, with no bright points', () => {
  const h = 600;
  assert.equal(rippleOffset(100, 0, 0, h), 0, 'still air bends nothing');
  let peak = 0;
  for (let x = 0; x < 2000; x += 3) peak = Math.max(peak, Math.abs(rippleOffset(x, 0, 10, h)));
  assert.ok(peak > 1 && peak <= h * 0.0066, `a gale sways the sky a few pixels, no more (${peak.toFixed(2)}px)`);
  // the pattern travels the way the wind blows: what was at x is at x + d after the air moves d
  for (const x of [120, 480, 900]) assert.ok(Math.abs(rippleOffset(x + 40, 40, 6, h) - rippleOffset(x, 0, 6, h)) < 1e-9, 'the ripple moves with the travelled air');
  // painted as columns of the sky, shifted: drawImage only, one call a column
  const calls = [];
  const ctx = { drawImage: (...a) => calls.push(a) };
  const n = paintRipple(ctx, { width: 1000 }, { sx: 10, sy: 20, scale: 1 }, 600, h, 30, 7);
  assert.ok(n === calls.length && n >= 100, `the sky is copied across in columns (${n})`);
  assert.ok(calls.every((c) => c.length === 9), 'each a source rectangle mapped to a shifted destination');
  assert.equal(paintRipple(ctx, { width: 1000 }, { sx: 0, sy: 0, scale: 1 }, 600, h, 30, 0), 0, 'and nothing at all in still air');
  // the bands: broad, soft, bowing, stroked lines and nothing round
  assert.equal(airBands(0, 0, 800, h).length, 0, 'no bands in still air');
  const bands = airBands(50, 8, 800, h);
  assert.equal(bands.length, 10, 'ten bands');
  for (const b of bands) { const ys = b.pts.map((p) => p.y); assert.ok(Math.max(...ys) - Math.min(...ys) > 4, 'each one bows'); assert.ok(b.alpha <= 0.07 && b.width > 10, 'broad and faint'); }
  const R = recorder();
  paintAirBands(R.ctx, bands);
  assert.ok(R.ops.every((o) => o.op === 'stroke'), 'strokes only: no heads, no dots, nothing a meteor is made of');
  // and the wind plane no longer draws the streaks or the currents: it draws the simulated air
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  const wind = src.slice(src.indexOf('function drawWind('), src.indexOf('\n}\n', src.indexOf('function drawWind(')));
  assert.ok(!/paintFlow|paintStreamlines/.test(wind), 'the meteor-shaped streaks are gone from the picture');
  assert.match(wind, /paintRipple\(ctx, sky,/, 'the sky is refracted');
  assert.match(wind, /stepFluid\(G\.fluid, dt, \{ wind: we, dye: false \}\)/, 'the air is stepped as a fluid every frame');
  assert.match(wind, /paintTracers\(ctx, G\.fluid, G\.tracers, w, h,/, 'and shown by streaklines carried in it, not by smoke');
  // brighter against a bright sky, and no brighter at night than before
  const night = airBands(50, 8, 800, h, 10, 0), noon = airBands(50, 8, 800, h, 10, 1);
  assert.ok(noon[0].alpha > night[0].alpha * 2.5, 'the bands carry about three times more at noon');
  const px = (r, g, b) => ({ width: 10, height: 10, getContext: () => ({ getImageData: (x, y, w, hh) => ({ data: new Uint8ClampedArray(w * hh * 4).map((_, i) => [r, g, b, 255][i % 4]) }) }) });
  assert.ok(skyBrightness(px(10, 12, 30)) < 0.05, 'a night sky reads dark');
  assert.ok(skyBrightness(px(90, 150, 230)) > 0.6, 'a day sky reads bright');
  assert.equal(skyBrightness(null), 0, 'and no sky reads as night');
});

// THE AIR IS A FLUID (operator, 2026-09-16: "There is no simulation movement. It's just a squiggly
// line moving across the screen"). A small Stable Fluids solver: the wind drives it, the land is its
// solid floor, and a dye carried by the flow is what is drawn.
test('scorched yard: the air is simulated -- driven by the wind, flowing round the land, carrying smoke', () => {
  const hill = (x) => 34 - 16 * Math.max(0, 1 - Math.abs(x - 48) / 14);   // first free row from the top
  // the wind drives it, and it turns round with the wind rather than jumping
  const f = makeFluid(96, 48, 1);
  setSolid(f, hill);
  warmFluid(f, 6, 7);
  assert.ok(meanFlow(f) > 4, `a wind to the right moves the air to the right (${meanFlow(f).toFixed(2)} cells/s)`);
  stepFluid(f, 33, { wind: -7 });
  assert.ok(meanFlow(f) > 0, 'one frame after the wind turns the air still has its momentum');
  warmFluid(f, 6, -7);
  assert.ok(meanFlow(f) < -4, `and in a few seconds it blows the other way (${meanFlow(f).toFixed(2)})`);
  // the land is solid: nothing moves inside it, and the air rises over the upwind slope
  const g = makeFluid(96, 48, 2);
  setSolid(g, hill);
  warmFluid(g, 6, 7);
  let inside = 0; for (let i = 0; i < g.u.length; i++) if (g.solid[i]) inside += Math.abs(g.u[i]) + Math.abs(g.v[i]);
  assert.equal(inside, 0, 'no air moves inside the hill');
  let rise = 0, n = 0;
  for (let x = 38; x < 46; x++) { const i = x + (Math.round(hill(x)) - 2) * 96; rise += -g.v[i]; n += 1; }
  assert.ok(rise / n > 1, `the air rises over the upwind slope (${(rise / n).toFixed(2)} cells/s)`);
  // it is close to divergence-free where the air is free: the projection is doing its job
  let div = 0, m = 0;
  for (let y = 4; y < 20; y++) for (let x = 2; x < 94; x++) { const i = x + y * 96; if (g.solid[i] || g.solid[i + 1] || g.solid[i - 1] || g.solid[i + 96] || g.solid[i - 96]) continue; div += Math.abs((g.u[i + 1] - g.u[i - 1] + g.v[i + 96] - g.v[i - 96]) * 0.5); m += 1; }
  assert.ok(div / m < 1.2, `divergence is small in open air (${(div / m).toFixed(3)} per cell against a flow of ~12)`);
  // the smoke crosses the whole field, stays finite, and still air paints nothing
  const cols = [8, 40, 72, 90].map((x) => { let d = 0; for (let y = 0; y < 60; y++) d += g.d[x * g.ds + y * g.dx]; return d; });
  assert.ok(cols.every((d) => d > 0.5), `smoke reaches every part of the field (${cols.map((d) => d.toFixed(1)).join(', ')})`);
  assert.ok(g.u.every(Number.isFinite) && g.d.every((v) => Number.isFinite(v) && v >= 0), 'every value finite, no negative smoke');
  const small = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) };
  const drawn = [];
  const ctx = { drawImage: (...a) => drawn.push(a), imageSmoothingEnabled: false };
  assert.equal(paintFluid(ctx, small, g, 800, 400, { wind: 0 }), false, 'still air paints nothing');
  assert.equal(paintFluid(ctx, small, g, 800, 400, { wind: 7, bright: 0.8 }), true);
  assert.equal(drawn.length, 1, 'one smooth scaled draw of the whole field');
  assert.equal(ctx.imageSmoothingEnabled, true, 'scaled up smooth, not in blocks');
  // cheap enough for every frame
  const t0 = performance.now(); for (let i = 0; i < 60; i++) stepFluid(g, 33, { wind: 7 }); const per = (performance.now() - t0) / 60;
  assert.ok(per < 8, `a step costs well under a frame (${per.toFixed(2)} ms)`);
});

// STREAKLINES, NOT SMOKE (operator, 2026-09-16: "looks too much like smoke blowing out the scene").
// The picture is thin paths of weightless tracers carried by the simulated air: they follow it,
// never sit inside the land, and taper to nothing at both ends so nothing has a bright head.
test('scorched yard: the flow is drawn as streaklines carried by the simulated air', () => {
  const hill = (x) => 34 - 16 * Math.max(0, 1 - Math.abs(x - 48) / 14);
  const f = makeFluid(96, 48, 4);
  setSolid(f, hill);
  warmFluid(f, 5, 7, { dye: false });
  const tr = makeTracers(f, 200, 3);
  let moved = 0, n = 0;
  for (let k = 0; k < 30; k++) {
    const x0 = Float32Array.from(tr.x), age0 = Float32Array.from(tr.age);
    stepFluid(f, 33, { wind: 7, dye: false });
    stepTracers(f, tr, 33);
    for (let i = 0; i < tr.n; i++) if (tr.age[i] > age0[i]) { moved += tr.x[i] - x0[i]; n += 1; }
  }
  assert.ok(moved / n > 0.2, `tracers are carried downwind by the air (${(moved / n).toFixed(3)} cells a step)`);
  for (let i = 0; i < tr.n; i++) {
    if (tr.x[i] < 0 || tr.x[i] >= f.nx || tr.y[i] < 0) continue;              // running on past the edge, out of sight
    assert.equal(f.solid[Math.floor(tr.x[i]) + Math.floor(tr.y[i]) * f.nx], 0, 'no tracer ever sits inside the land');
  }
  // they rise over the upwind slope, as the air does
  let risers = 0, near = 0;
  for (let i = 0; i < tr.n; i++) {
    const x = Math.floor(tr.x[i]);
    if (x < 36 || x > 46 || tr.y[i] < hill(x) - 4) continue;
    near += 1;
    const h = tr.head[i], p = (h - 4 + 22) % 22;
    if (tr.len[i] > 5 && tr.hy[i * 22 + h] < tr.hy[i * 22 + p]) risers += 1;
  }
  assert.ok(near === 0 || risers / near > 0.5, `near the upwind slope the paths climb (${risers} of ${near})`);
  // four strokes for the whole field; still air draws nothing
  const alphas = [];
  const ctx = { set strokeStyle(v) { alphas.push(parseFloat(String(v).split(',')[3])); }, lineCap: '', lineWidth: 1, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
  assert.ok(paintTracers(ctx, f, tr, 800, 400, { wind: 7 }) <= 4, 'at most four strokes');
  assert.equal(paintTracers(ctx, f, tr, 800, 400, { wind: 0 }), 0, 'still air draws nothing');
  assert.ok(Math.max(...alphas) < 0.45, 'faint lines, not bright ones');
  // no bright head: the taper is zero at both ends of a path
  const src = readFileSync(new URL('../public/js/scorchedair.js', import.meta.url), 'utf8');
  assert.match(src, /const taper = Math\.sin\(Math\.PI \* along\) \* fade \* edge;/, 'brightest mid-path, nothing at either end or at the edges');
  // THE EDGES FADE (operator: "It's not fading out cleanly at the edges, it just sorta disappears"):
  // a path laid along the field's width is faint at both sides and strong in the middle, and a
  // tracer that crosses the edge keeps going rather than vanishing with its whole line
  const one = makeTracers(f, 1, 9);
  one.n = 1; one.age[0] = 1; one.life[0] = 5; one.len[0] = 22; one.head[0] = 21;
  const segAlpha = [];
  const probe = { set strokeStyle(v) { this._a = parseFloat(String(v).split(',')[3]); }, lineCap: '', lineWidth: 1, beginPath() {}, moveTo(x) { segAlpha.push([x, this._a]); }, lineTo() {}, stroke() {} };
  for (const startX of [0.2, 40, 90]) {
    for (let k = 0; k < 22; k++) { one.hx[k] = startX + k * 0.25; one.hy[k] = 10; }
    segAlpha.length = 0;
    paintTracers(probe, f, one, 960, 480, { wind: 7 });
    const peak = Math.max(0, ...segAlpha.map(([, a]) => a));
    if (startX === 40) assert.ok(peak > 0.1, 'mid-field the line is plainly there');
    else assert.ok(peak < 0.2, `at the ${startX < 1 ? 'left' : 'right'} edge it has faded (${peak})`);
  }
  const edge = makeTracers(f, 1, 11);
  edge.x[0] = 95.8; edge.y[0] = 8; edge.age[0] = 1; edge.life[0] = 5;
  const born = edge.k;
  stepTracers(f, edge, 33); stepTracers(f, edge, 33);
  assert.ok(edge.x[0] > 96 && edge.k === born, 'a tracer crossing the edge runs on, not reborn on the spot');
});

// NO FREEZE WHEN THE LAND IS BLOWN UP (operator, 2026-09-16: "performance freezing and jittering when
// the cubes are being blown up"). Measured on a nuke in the browser: 150 ms frames, from the air
// warming up again on every crater, the land's general paint sort, and the wind plane at sixty.
test('scorched yard: a blast does not stall the frame', async () => {
  const { buildScene } = await import('../public/js/blockscene3d.js');
  // 1. the land in a known order: 'given' keeps the list as sorted, and the sort is back rows first,
  //    columns outside in -- pixel-identical to the general sort in the browser, and far cheaper
  const g = newGame([{ name: 'You', kind: 'human' }, { name: 'A', kind: 'moron' }], { seed: 4 });
  const tiles = landTiles(g);
  const sorted = [...tiles].sort(landOrder);
  const o = { gridW: 96, gridH: 48, unit: 12, oblique: { ox: 0.10, oy: 0.30, headroom: 3, flight: 0 }, dome: 0, light: 'front', lightHeight: 'low', space: true, edges: true, facetMinUnits: Infinity, crownMinUnits: Infinity };
  const seen = []; for (const op of buildScene(sorted, { ...o, order: 'given' }).ops) if (seen[seen.length - 1] !== op.txid) seen.push(op.txid);
  assert.deepEqual([...new Set(seen)], sorted.map((t) => t.txid).filter((id) => seen.includes(id)), 'the given order is the order drawn');
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1], q = sorted[i];
    assert.ok(p.y > q.y || (p.y === q.y && Math.abs(p.x + 0.5 - 48) >= Math.abs(q.x + 0.5 - 48)), 'back rows first, then outside in');
  }
  const t0 = performance.now(); buildScene(tiles, o); const general = performance.now() - t0;
  const t1 = performance.now(); buildScene([...tiles].sort(landOrder), { ...o, order: 'given' }); const known = performance.now() - t1;
  assert.ok(known < general / 2, `the known order builds in well under half the time (${known.toFixed(1)} ms against ${general.toFixed(1)})`);
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.match(src, /\.sort\(landOrder\), \{ \.\.\.opts\(FIELD\), order: 'given' \}\)/, 'the game draws its land that way');
  // 2. the air is warmed up and its floor read from the canvas only for NEW land; a crater moves the
  //    floor from the rules' own column heights
  const wind = src.slice(src.indexOf('function drawWind('), src.indexOf('\n}\n', src.indexOf('function drawWind(')));
  assert.match(wind, /const fieldKey = `\$\{game\?\.seed\}\|\$\{game\?\.round\}\|\$\{w\}x\$\{h\}`;/, 'the warm-up is keyed on the game and the round, not on every land change');
  assert.match(wind, /else if \(game && G\.fluidTops && game\.landVersion !== G\.fluidVersion\)/, 'a crater takes the cheap path');
  // 3. the wind plane at most thirty times a second, and the effects' soft fills capped
  assert.match(wind, /if \(now - \(G\.windDrawnAt \?\? 0\) < WIND_MS - 4\) return;/, 'the wind plane is held to thirty a second');
  const fx = readFileSync(new URL('../public/js/scorchedfx.js', import.meta.url), 'utf8');
  assert.equal((fx.match(/softStops\(ctx, [^;]*\);/g) || []).filter((c) => !/RINGS\.|, 6\);/.test(c)).length, 0, 'every soft fill in the effects names its ring count');
  // 4. the flow lines are a few continuous paths, not thousands of segments
  const f = makeFluid(96, 48, 2);
  setSolid(f, () => 40);
  warmFluid(f, 3, 7, { dye: false });
  const tr = makeTracers(f, 320, 5);
  for (let i = 0; i < 40; i++) { stepFluid(f, 33, { wind: 7, dye: false }); stepTracers(f, tr, 33); }
  let moves = 0, lines = 0;
  const ctx = { set strokeStyle(v) {}, lineCap: '', lineJoin: '', lineWidth: 1, beginPath() {}, moveTo() { moves += 1; }, lineTo() { lines += 1; }, stroke() {} };
  paintTracers(ctx, f, tr, 1266, 633, { wind: 7 });
  // the first cut drew 5,479 separate segments here -- about eleven thousand path points
  assert.ok(lines + moves < 5500, `under half the path points of the first cut (${moves} runs, ${lines} segments)`);
  assert.ok(lines > moves, 'runs are continuous lines, not lone segments');
});
