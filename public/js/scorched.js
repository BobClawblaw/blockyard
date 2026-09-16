// SCORCHED YARD, the rules (operator, 2026-09-16: "Scope out a plan for re-creating the classic PC
// DOS game Scorched Earth using our engine. I suggest using blocks to generate the deformable
// landscape ... Make it at least 3 player. 1 Human Player and 2 AI Players. Try to reproduce it as
// faithfully as possible, but make it look fabulous"; then "go with 96x48, start on M1", "start on
// M2"). docs/PLAN-SCORCHED-YARD.md is the plan; this is its M1 and M2: the landscape, the tanks,
// the whole roster of shells and items, craters, falling dirt, damage, death, turns, rounds, cash.
//
// This file knows nothing of the screen: no DOM, no canvas, no clock. A game is a plain object; a
// shot is a function of it; the screen (scorchedyard.js) asks for the tiles when it wants to draw.
// Every random choice comes from the game's own seeded stream, so a round replays exactly in a
// test. The roster itself is data in scorchedshop.js; the behaviours are here.
//
// THE FIELD is W x H cells (96 x 48: the original's 640 x 350 EGA screen was about 2:1, so a cell
// stands in for six or seven of its pixels). The dirt is a BITMAP over those cells, not a height
// per column, so that a tunnel or an overhang exists once a digger has been through; a column's
// top is kept beside it for the fast questions. Grid y runs UP from the floor, as the engine
// draws it.
//
// UNITS: grid cells, and seconds inside the integrator (the screen hands it milliseconds). Power
// 0..1000 is the original's scale; 1000 throws a shell at V_MAX cells a second, which on Earth
// gravity carries a 45° shot across the whole field and no further -- the original's feel.
import {
  WEAPONS, WEAPON_ORDER, ITEMS, ITEM_ORDER, START_INVENTORY, START_ITEMS, START_CASH,
  CASH_PER_DAMAGE, KILL_BONUS, SURVIVOR_BONUS, buy, payInterest,
} from './scorchedshop.js';
export { WEAPONS, WEAPON_ORDER, ITEMS, ITEM_ORDER, START_INVENTORY, START_ITEMS, START_CASH, buy, payInterest };

export const COLS = 96;
export const ROWS = 48;

// the tanks' colours, in the order players are added (the original's palette, roughly)
export const PERSONALITIES = Object.freeze(['moron', 'shooter', 'poolshark', 'tosser', 'chooser', 'spoiler', 'cyborg', 'unknown']);
const UNKNOWN_POOL = Object.freeze(['moron', 'shooter', 'poolshark', 'tosser', 'chooser', 'spoiler', 'cyborg']);
export const TANK_COLOURS = Object.freeze(['#f7931a', '#4d8dff', '#2ecc8f', '#ef5a5a', '#c78bff', '#f0c419']);
export const MAX_HEALTH = 100;
export const V_MAX = 56;              // cells/s at power 1000
export const GRAVITY = 30;            // cells/s² at the Earth setting (1)
export const WIND_ACCEL = 1.2;        // cells/s² per unit of wind
export const WIND_MAX = 10;
export const MAX_STEP = 0.25;         // a shell never moves more than this in one substep: no tunnelling
export const FALL_DAMAGE = 4;         // per cell fallen beyond the first
export const DEATH_BLAST = Object.freeze({ radius: 3.5, damage: 60 });
export const TANK_W = 2;              // the hull: two cells wide
export const TANK_H = 1.4;            // hull and turret, for the hitbox
export const ROLL_SPEED = 14;         // cells/s along the ground
export const BORE_SPEED = 16;         // cells/s through dirt
export const HEAT_PULL = 14;          // cells/s² toward the nearest tank, heat-guided and falling
const clampX = (x) => Math.max(0, Math.min(COLS - 1e-3, x));
const BOMBLET = Object.freeze({ name: 'bomblet', kind: 'blast', radius: 1.5, damage: 30 });   // a Funky Bomb's pieces, which the shop does not sell

// the strata: from the floor up, as a fraction of a column's own height, with a colour each
export const STRATA = Object.freeze([
  Object.freeze({ to: 0.12, color: '#7a2f2a' }),   // magma, at the very bottom
  Object.freeze({ to: 0.40, color: '#4b4652' }),   // rock
  Object.freeze({ to: 0.72, color: '#6f4b32' }),   // clay
  Object.freeze({ to: 0.97, color: '#8a6a3f' }),   // soil
  Object.freeze({ to: 1.00, color: '#5fae4a' }),   // the grass cap
]);

// ------------------------------------------------------------------- randomness, seeded
/** A small LCG (the same constants agents.js uses), so a game replays from its seed. */
export function rng(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; };
}
const hash01 = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

// ------------------------------------------------------------------- the dirt
const idx = (x, y) => y * COLS + x;
export const dirtAt = (g, x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS && g.dirt[idx(x, y)] === 1;
/** The top of a column: one above its highest dirt cell (0 for a bare column). */
export function topOf(g, x) {
  if (x < 0 || x >= COLS) return 0;
  for (let y = ROWS - 1; y >= 0; y--) if (g.dirt[idx(x, y)]) return y + 1;
  return 0;
}
function retop(g, x0 = 0, x1 = COLS - 1) {
  for (let x = Math.max(0, x0); x <= Math.min(COLS - 1, x1); x++) g.tops[x] = topOf(g, x);
}

/**
 * The landscape: a sum of low sines with seeded phases, clamped to leave sky above and dirt below.
 * `style` picks the amplitude: 'hills' (the default), 'mountains', 'flat', 'valley'.
 */
export function generateLand(g, style = 'hills') {
  const r = g.rnd;
  const p = [r(), r(), r(), r()].map((v) => v * Math.PI * 2);
  const amp = { hills: 0.22, mountains: 0.34, flat: 0.04, valley: 0.26 }[style] ?? 0.22;
  const base = style === 'mountains' ? 0.42 : 0.36;
  g.dirt.fill(0);
  for (let x = 0; x < COLS; x++) {
    const u = x / COLS;
    let h = base
      + amp * 0.55 * Math.sin(u * Math.PI * 2 * 1.3 + p[0])
      + amp * 0.30 * Math.sin(u * Math.PI * 2 * 2.9 + p[1])
      + amp * 0.15 * Math.sin(u * Math.PI * 2 * 5.7 + p[2])
      + amp * 0.08 * Math.sin(u * Math.PI * 2 * 11 + p[3]);
    if (style === 'valley') h -= 0.18 * Math.cos((u - 0.5) * Math.PI * 2);
    const cells = Math.round(Math.max(3, Math.min(ROWS * 0.78, h * ROWS)));
    for (let y = 0; y < cells; y++) g.dirt[idx(x, y)] = 1;
  }
  retop(g);
  g.landVersion = (g.landVersion ?? 0) + 1;
}

/** Clear every dirt cell inside a circle. Returns how many went. */
export function crater(g, cx, cy, r) {
  let removed = 0;
  for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(COLS - 1, Math.ceil(cx + r + 1)); x++) {
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(ROWS - 1, Math.ceil(cy + r + 1)); y++) {
      if (!g.dirt[idx(x, y)]) continue;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) { g.dirt[idx(x, y)] = 0; removed += 1; }
    }
  }
  if (removed) g.landVersion += 1;
  return removed;
}

/** Fill every cell inside a circle with dirt (the dirt weapons). Returns how many were added. */
export function addDirt(g, cx, cy, r) {
  let added = 0;
  for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(COLS - 1, Math.ceil(cx + r + 1)); x++) {
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(ROWS - 1, Math.ceil(cy + r + 1)); y++) {
      if (g.dirt[idx(x, y)]) continue;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) { g.dirt[idx(x, y)] = 1; added += 1; }
    }
  }
  if (added) g.landVersion += 1;
  return added;
}

/**
 * Dirt above a hole falls until it rests: each column in x0..x1 is compacted downward, run by
 * run, and every run that moved is recorded in `g.falling` for the screen to animate.
 */
export function settleDirt(g, x0 = 0, x1 = COLS - 1) {
  for (let x = Math.max(0, x0); x <= Math.min(COLS - 1, x1); x++) {
    let write = 0;
    let y = 0;
    while (y < ROWS) {
      if (!g.dirt[idx(x, y)]) { y++; continue; }
      const start = y;
      while (y < ROWS && g.dirt[idx(x, y)]) y++;
      const len = y - start;
      if (start !== write) {
        for (let k = 0; k < len; k++) g.dirt[idx(x, start + k)] = 0;
        for (let k = 0; k < len; k++) g.dirt[idx(x, write + k)] = 1;
        g.falling.push({ x, y: write, len, from: start });
      }
      write += len;
    }
    g.tops[x] = write;
  }
  g.landVersion += 1;
}

// ------------------------------------------------------------------- the game
/**
 * A new game. `players` is a list of `{ name, kind: 'human' | 'moron' | ..., colour? }`; the
 * first human plays from the keyboard, the rest are decided by scorchedai.js. Options: `seed`,
 * `gravity` (1 = Earth), `wind` ('round' | 'turn' | 'shot' | 'none'), `walls` ('concrete' | 'rubber' |
 * 'wrap' | 'none'), `land` (a landscape style), `rounds`, `cash` (to start), `interest` (a rate).
 */
export function newGame(players, opts = {}) {
  const seed = Number.isFinite(opts.seed) ? opts.seed : (Date.now() >>> 0);
  const g = {
    seed, rnd: rng(seed),
    W: COLS, H: ROWS,
    dirt: new Uint8Array(COLS * ROWS), tops: new Int16Array(COLS),
    gravity: Number.isFinite(opts.gravity) ? opts.gravity : 1,
    windMode: opts.wind ?? 'round', walls: opts.walls ?? 'concrete', land: opts.land ?? 'hills',
    interest: Number.isFinite(opts.interest) ? opts.interest : 0.05,
    wind: 0,
    tanks: (players ?? []).map((p, i) => ({
      id: i, name: p.name ?? `Player ${i + 1}`, kind: p.kind ?? 'human', colour: p.colour ?? TANK_COLOURS[i % TANK_COLOURS.length],
      x: 0, y: 0, health: MAX_HEALTH, alive: true, angle: 45, power: 500, weapon: 'babyMissile',
      inventory: { ...START_INVENTORY }, items: { ...START_ITEMS },
      shield: null,                       // { id, hp, deflect } while one is up
      armed: { contactTrigger: false, heatGuidance: false },
      kills: 0, score: 0, cash: Number.isFinite(opts.cash) ? opts.cash : START_CASH, damageDealt: 0,
      lastHitBy: null,                    // who hurt this tank last (the Cyborg holds a grudge)
      memory: null,                       // a computer player's last shot at its target, for correcting
      persona: p.kind ?? 'human',         // what an Unknown is playing as this round
    })),
    round: 1, rounds: Math.max(1, Math.round(opts.rounds ?? 5)),
    turn: 0,                              // index into `order`
    order: [],                            // tank ids, this round's turn order
    phase: 'aim',                         // 'aim' | 'flight' | 'settle' | 'roundOver' | 'over'
    shells: [],                           // in flight: { x, y, vx, vy, weapon, owner, path, t, ... }
    lastPath: [],                         // the last shot's trace, for the screen
    falling: [],                          // dirt runs on their way down, for the screen
    sparks: [],                           // events the screen makes sounds and pictures of, drained by it
    shots: 0,
    landVersion: 0,                       // bumped whenever the dirt changes: the screen redraws its land layer only then
  };
  if (g.tanks.length < 2) throw new RangeError('a round needs at least two tanks');
  startRound(g);
  return g;
}

/** Fresh land, every tank placed with full health, the turn order rotated, the wind set. */
export function startRound(g) {
  generateLand(g, g.land);
  placeTanks(g);
  for (const t of g.tanks) {
    t.health = MAX_HEALTH; t.alive = true; t.shield = null; t.armed = { contactTrigger: false, heatGuidance: false };
    t.lastHitBy = null; t.memory = null;
    // an Unknown is one of the others, drawn each round and never announced (the manual)
    t.persona = t.kind === 'unknown' ? UNKNOWN_POOL[Math.floor(g.rnd() * UNKNOWN_POOL.length)] : t.kind;
  }
  const n = g.tanks.length;
  g.order = g.tanks.map((t) => t.id).map((_, i, a) => a[(i + g.round - 1) % n]);
  g.turn = 0;
  g.phase = 'aim';
  g.shells = []; g.lastPath = []; g.falling = [];
  newWind(g);
  g.sparks.push({ kind: 'round', round: g.round });
  autoDefend(g, current(g));
}

function placeTanks(g) {
  const n = g.tanks.length;
  // evenly spaced slots with a seeded jitter, shuffled, so the same seed places the same tanks
  const slotW = (COLS - 8) / n;
  const slots = g.tanks.map((_, i) => Math.round(4 + slotW * i + slotW * (0.25 + 0.5 * g.rnd())));
  for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(g.rnd() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  g.tanks.forEach((t, i) => {
    const x = Math.max(1, Math.min(COLS - TANK_W - 1, slots[i]));
    // a level plateau under the hull: the columns it stands on take the lower of their tops
    const top = Math.min(g.tops[x], g.tops[x + 1]);
    for (let cx = x; cx < x + TANK_W; cx++) {
      for (let y = top; y < ROWS; y++) g.dirt[idx(cx, y)] = 0;
      for (let y = 0; y < top; y++) g.dirt[idx(cx, y)] = 1;
    }
    t.x = x; t.y = top;
    t.angle = x < COLS / 2 ? 45 : 135;
    t.power = 500;
  });
  retop(g);
  g.landVersion += 1;
}

/**
 * A NEW WIND. It is drawn at the start of every round; whether it is drawn again inside the round
 * is the mode's business (operator, 2026-09-16: "the wind still changes direction during my round
 * ... it needs to consistently move in one direction, not shift back and forth during the same
 * round"). `round` -- the shipped mode -- draws it once and leaves it, so the air over a round
 * blows one way and every shot in that round is read against the same gauge. `turn` is the
 * original's: a fresh wind, direction and all, for every tank's turn. `shot` redraws it at each
 * shot, and `none` is still air.
 */
function newWind(g) {
  if (g.windMode === 'none') { g.wind = 0; return; }
  g.wind = Math.round((g.rnd() * 2 - 1) * WIND_MAX * 10) / 10;
}

export const current = (g) => g.tanks[g.order[g.turn]];
export const alive = (g) => g.tanks.filter((t) => t.alive);
const enemiesOf = (g, id) => g.tanks.filter((t) => t.alive && t.id !== id);
const centre = (t) => ({ x: t.x + TANK_W / 2, y: t.y + 0.7 });

/** Aim: angle 0..180 (90 straight up), power 0..1000, clamped. */
export function aim(g, tank, { angle, power, weapon } = {}) {
  if (angle != null) tank.angle = Math.max(0, Math.min(180, Math.round(angle)));
  if (power != null) tank.power = Math.max(0, Math.min(1000, Math.round(power)));
  if (weapon != null && WEAPONS[weapon]) tank.weapon = weapon;
}

/** The next weapon in the cycle that the tank still has, `dir` +1 or -1. */
export function cycleWeapon(tank, dir = 1) {
  const i = WEAPON_ORDER.indexOf(tank.weapon);
  const n = WEAPON_ORDER.length;
  for (let k = 1; k <= n; k++) {
    const w = WEAPON_ORDER[(((i + dir * k) % n) + n) % n];
    if ((tank.inventory[w] ?? 0) > 0) { tank.weapon = w; return w; }
  }
  return tank.weapon;
}

/** The barrel's muzzle, where a shell starts. */
export function muzzle(tank) {
  const a = (tank.angle * Math.PI) / 180;
  const cx = tank.x + TANK_W / 2, cy = tank.y + 1.1;
  return { x: cx + Math.cos(a) * 1.3, y: cy + Math.sin(a) * 1.3 };
}

// ------------------------------------------------------------------- items, on your turn
const SHIELD_PREFERENCE = ['heavyShield', 'forceShield', 'shield'];

/**
 * Use an item on your turn: a battery heals, a shield goes up (the named one, or the best owned
 * for 'shield'), the two arming items toggle for the next shot. Returns false when the tank has
 * none, or it is not the moment.
 */
export function useItem(g, tank, id) {
  if (g.phase !== 'aim' || tank !== current(g) || !tank.alive) return false;
  const item = ITEMS[id];
  if (!item) return false;
  if (item.kind === 'arm') {
    if ((tank.items[id] ?? 0) <= 0) return false;
    tank.armed[id] = !tank.armed[id];
    return true;
  }
  if (item.kind === 'battery') {
    if ((tank.items.battery ?? 0) <= 0 || tank.health >= MAX_HEALTH) return false;
    tank.items.battery -= 1;
    tank.health = Math.min(MAX_HEALTH, tank.health + item.heal);
    g.sparks.push({ kind: 'battery', tank: tank.id });
    return true;
  }
  if (item.kind === 'shield') return raiseShield(g, tank, (tank.items[id] ?? 0) > 0 ? id : null);
  return false;
}

/** Put up a shield: the named one, or the best the tank owns. */
export function raiseShield(g, tank, id = null) {
  if (tank.shield) return false;
  const pick = id ?? SHIELD_PREFERENCE.find((k) => (tank.items[k] ?? 0) > 0);
  if (!pick || (tank.items[pick] ?? 0) <= 0) return false;
  tank.items[pick] -= 1;
  tank.shield = { id: pick, hp: ITEMS[pick].hp };
  g.sparks.push({ kind: 'shield', tank: tank.id, item: pick });
  return true;
}

function autoDefend(g, tank) {
  if (tank?.alive && (tank.items.autoDefense ?? 0) > 0 && !tank.shield) raiseShield(g, tank);
}

/** Drive a cell left or right with a unit of fuel, following the ground; a cliff is a fall. */
export function drive(g, tank, dir) {
  if (g.phase !== 'aim' || tank !== current(g) || !tank.alive) return false;
  if ((tank.items.fuel ?? 0) <= 0) return false;
  const nx = tank.x + (dir < 0 ? -1 : 1);
  if (nx < 0 || nx + TANK_W > COLS) return false;
  const ground = Math.min(g.tops[nx], g.tops[nx + 1]);
  if (ground - tank.y > 2) return false;                 // too steep to climb
  tank.items.fuel -= 1;
  tank.x = nx;
  tank.y = Math.max(tank.y, ground);
  landTanks(g);                                          // off a cliff: it falls, and may be hurt
  g.sparks.push({ kind: 'drive', tank: tank.id, x: tank.x });
  return true;
}

// ------------------------------------------------------------------- firing
/**
 * Fire the current tank's weapon. Returns false if it is not the moment (a shell in flight, a
 * dead tank, an empty slot). The shell then flies through `step()`; the laser is over at once.
 */
export function fire(g, tank = current(g)) {
  if (g.phase !== 'aim' || !tank?.alive || tank !== current(g)) return false;
  if ((tank.inventory[tank.weapon] ?? 0) <= 0) { cycleWeapon(tank, 1); if ((tank.inventory[tank.weapon] ?? 0) <= 0) return false; }
  const w = WEAPONS[tank.weapon];
  if (tank.weapon !== 'babyMissile') tank.inventory[tank.weapon] -= 1;   // the baby missile is the original's bottomless one
  if (g.windMode === 'shot') newWind(g);
  g.shots += 1;
  g.sparks.push({ kind: 'fire', tank: tank.id, weapon: tank.weapon });
  // the arming items, one of each spent per shot they are armed for
  const armed = {};
  for (const k of ['contactTrigger', 'heatGuidance']) {
    if (tank.armed[k] && (tank.items[k] ?? 0) > 0) { tank.items[k] -= 1; armed[k] = true; }
    if ((tank.items[k] ?? 0) <= 0) tank.armed[k] = false;
  }
  if (w.kind === 'laser' || w.kind === 'wedge' || w.kind === 'disrupter' || w.kind === 'plasma') {
    if (w.kind === 'laser') laser(g, tank, w);
    else if (w.kind === 'wedge') wedge(g, tank, w);
    else if (w.kind === 'disrupter') disrupt(g, tank);
    else plasma(g, tank, w);
    g.lastPath = [];
    g.phase = 'settle';
    if (!g.falling.length) settled(g);
    return true;
  }
  const a = (tank.angle * Math.PI) / 180;
  const v = (tank.power / 1000) * V_MAX;
  const m = muzzle(tank);
  g.shells = [{
    x: m.x, y: m.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, weapon: tank.weapon, owner: tank.id, path: [{ x: m.x, y: m.y }], t: 0,
    hops: w.hops ?? 0, contact: !!armed.contactTrigger, heat: !!armed.heatGuidance, primary: true,
  }];
  g.phase = 'flight';
  return true;
}

/** The shell's positions with no walls in the way (the AI's oracle, and a test's). */
export function trajectory(g, tank, secs = 8, dt = 1 / 60) {
  const a = (tank.angle * Math.PI) / 180;
  const v = (tank.power / 1000) * V_MAX;
  const m = muzzle(tank);
  let x = m.x, y = m.y, vx = Math.cos(a) * v, vy = Math.sin(a) * v;
  const pts = [{ x, y }];
  const gy = GRAVITY * g.gravity, wx = g.wind * WIND_ACCEL;
  for (let t = 0; t < secs; t += dt) {
    vx += wx * dt; vy -= gy * dt; x += vx * dt; y += vy * dt;
    pts.push({ x, y });
    if (y < 0) break;
  }
  return pts;
}

/**
 * Where a plain shell fired now would end up, with the walls, the dirt and the tanks in the way,
 * and nothing changed: the computer players plan with this (docs/PLAN-SCORCHED-YARD.md §6).
 * Returns `{ x, y, hit }` -- the impact, and the id of the tank it struck, if any -- and `lost`
 * when the shell left the field or flew for longer than `secs`.
 */
export function simulateShot(g, tank, angle, power, secs = 14) {
  const a = (angle * Math.PI) / 180;
  const v = (Math.max(0, Math.min(1000, power)) / 1000) * V_MAX;
  const m = muzzle({ ...tank, angle });
  let x = m.x, y = m.y, vx = Math.cos(a) * v, vy = Math.sin(a) * v, t = 0;
  const gy = GRAVITY * g.gravity, wx = g.wind * WIND_ACCEL;
  const h = 1 / 120;
  while (t < secs) {
    vx += wx * h; vy -= gy * h; x += vx * h; y += vy * h; t += h;
    if (x < 0 || x >= COLS) {
      if (g.walls === 'rubber') { x = x < 0 ? -x : 2 * COLS - x - 1e-3; vx = -vx * 0.8; }
      else if (g.walls === 'spring') { x = x < 0 ? -x : 2 * COLS - x - 1e-3; vx = -vx * 1.15; }
      else if (g.walls === 'padded') { x = clampX(x); vx = 0; }
      else if (g.walls === 'wrap') { x = ((x % COLS) + COLS) % COLS; }
      else if (g.walls === 'none') return { x, y, hit: null, lost: true };
      else return { x: clampX(x), y, hit: null, lost: false };
    }
    if (y < 0) return { x, y: 0, hit: null, lost: false };
    if (y < ROWS && dirtAt(g, Math.floor(x), Math.floor(y))) return { x, y, hit: null, lost: false };
    const hit = tankAt(g, x, y, t < 0.12 ? tank.id : -1, 0.2);
    if (hit) return { x, y, hit: hit.id, lost: false };
  }
  return { x, y, hit: null, lost: true };
}

/**
 * Advance the game by dtMs. Returns the events of the step (the screen makes sounds and pictures
 * of them). Substepped so a shell never crosses more than MAX_STEP a hop, whatever the frame.
 */
export function step(g, dtMs) {
  const events = [];
  if (g.phase === 'flight') {
    const dt = Math.min(100, Math.max(0, dtMs)) / 1000;   // a frame, capped: a tab that slept catches up in hops, not a leap
    const fastest = Math.max(1, ...g.shells.map((s) => Math.hypot(s.vx, s.vy)), ROLL_SPEED, BORE_SPEED);
    const n = Math.max(1, Math.ceil((fastest * dt) / MAX_STEP) + 1);
    const h = dt / n;
    for (let i = 0; i < n && g.phase === 'flight'; i++) {
      for (const s of [...g.shells]) flightStep(g, s, h, events);
      if (!g.shells.length) endFlight(g);
    }
  }
  if (g.sparks.length) { events.push(...g.sparks); g.sparks = []; }
  return events;
}

const weaponOf = (id) => WEAPONS[id] ?? (id === 'funkyBomblet' ? BOMBLET : WEAPONS.babyMissile);
const removeShell = (g, s) => { const i = g.shells.indexOf(s); if (i >= 0) g.shells.splice(i, 1); if (s.primary) g.lastPath = s.path; };

function flightStep(g, s, h, events) {
  const w = weaponOf(s.weapon);
  // ---- rolling along the ground (a Roller after it lands)
  if (s.rolling) {
    const col = Math.max(0, Math.min(COLS - 1, Math.floor(s.x)));
    const ground = g.tops[col];
    s.x += s.dir * ROLL_SPEED * h; s.rollLeft -= ROLL_SPEED * h; s.t += h;
    const nc = Math.floor(s.x);
    if (nc < 0 || nc >= COLS) { blastAt(g, s, clampX(s.x), ground); return; }
    s.y = g.tops[nc] + 0.3;
    if (s.path.length < 600) s.path.push({ x: s.x, y: s.y });
    if (tankAt(g, s.x, s.y, s.owner, 0.3)) { blastAt(g, s, s.x, s.y); return; }
    if (nc !== col) {
      const next = g.tops[nc];
      if (next > ground + 1) { blastAt(g, s, col + 0.5, ground); return; }        // a wall in the way: it stops there
      const ahead = g.tops[Math.max(0, Math.min(COLS - 1, nc + s.dir))];
      if (ahead > next && ground > next) { blastAt(g, s, nc + 0.5, next); return; }   // the bottom of a dip
    }
    if (s.rollLeft <= 0) blastAt(g, s, s.x, s.y);
    return;
  }
  // ---- boring through dirt (a Digger or a Sandhog after it lands)
  if (s.boring) {
    const d = BORE_SPEED * h;
    s.x += s.boring.dx * d; s.y += s.boring.dy * d; s.boring.left -= d; s.t += h;
    if (s.path.length < 600) s.path.push({ x: s.x, y: s.y });
    if (s.x >= 0 && s.x < COLS && s.y >= 0) crater(g, s.x, s.y, w.radius * 0.7);
    if (s.x < 0 || s.x >= COLS || s.y < 0.5 || s.boring.left <= 0 || tankAt(g, s.x, s.y, s.owner, 0.2)) {
      blastAt(g, s, clampX(s.x), Math.max(0, s.y));
    }
    return;
  }
  // ---- in the air
  s.vx += g.wind * WIND_ACCEL * h;
  s.vy -= GRAVITY * g.gravity * h;
  if (s.heat && s.vy < 0) {
    const target = nearestEnemy(g, s.owner, s.x);
    if (target) s.vx += Math.sign(centre(target).x - s.x) * HEAT_PULL * h;
  }
  for (const t of enemiesOf(g, s.owner)) {
    const mag = (t.items.superMag ?? 0) > 0 ? ITEMS.superMag : (t.items.magDeflector ?? 0) > 0 ? ITEMS.magDeflector : null;
    if (!mag) continue;
    const c = centre(t);
    const d = Math.hypot(s.x - c.x, s.y - c.y);
    if (d < mag.reach && d > 0.1) { const k = mag.push * (1 - d / mag.reach) * h; s.vx += ((s.x - c.x) / d) * k; s.vy += ((s.y - c.y) / d) * k; }
  }
  s.x += s.vx * h; s.y += s.vy * h; s.t += h;
  if (s.path.length < 600) s.path.push({ x: s.x, y: s.y });
  // a MIRV splits at its apex
  if (w.kind === 'mirv' && !s.split && s.vy <= 0 && s.t > 0.2) {
    const n = w.heads;
    for (let i = 0; i < n; i++) {
      const spread = (i - (n - 1) / 2) * (n > 5 ? 2 : 3);
      g.shells.push({ ...s, path: [{ x: s.x, y: s.y }], vx: s.vx + spread, primary: false, split: true });
    }
    removeShell(g, s);
    return;
  }
  // the walls, by mode
  if (s.x < 0 || s.x >= COLS) {
    if (g.walls === 'rubber') { s.x = s.x < 0 ? -s.x : 2 * COLS - s.x - 1e-3; s.vx = -s.vx * 0.8; events.push({ kind: 'bounce' }); }
    else if (g.walls === 'spring') { s.x = s.x < 0 ? -s.x : 2 * COLS - s.x - 1e-3; s.vx = -s.vx * 1.15; events.push({ kind: 'bounce' }); }
    else if (g.walls === 'padded') { s.x = clampX(s.x); s.vx = 0; events.push({ kind: 'bounce' }); }   // it stops dead and drops
    else if (g.walls === 'wrap') { s.x = ((s.x % COLS) + COLS) % COLS; }
    else if (g.walls === 'none') { g.sparks.push({ kind: 'lost' }); removeShell(g, s); return; }
    else { s.x = clampX(s.x); impact(g, s, s.x, s.y); return; }
  }
  // a contact trigger goes off within reach of a tank
  if (s.contact) {
    for (const t of enemiesOf(g, s.owner)) {
      const c = centre(t);
      if (Math.hypot(s.x - c.x, s.y - c.y) < 2) { impact(g, s, s.x, s.y); return; }
    }
  }
  if (s.y < 0) { impact(g, s, s.x, 0); return; }
  if (s.y < ROWS && dirtAt(g, Math.floor(s.x), Math.floor(s.y))) { impact(g, s, s.x, s.y); return; }
  if (tankAt(g, s.x, s.y, s.t < 0.12 ? s.owner : -1, 0.2)) impact(g, s, s.x, s.y);
}

/** The living tank whose hull box (grown by `pad`) holds the point, skipping `skipId`. */
function tankAt(g, x, y, skipId, pad = 0) {
  for (const t of g.tanks) {
    if (!t.alive || t.id === skipId) continue;
    if (x >= t.x - pad && x <= t.x + TANK_W + pad && y >= t.y - pad && y <= t.y + TANK_H + pad) return t;
  }
  return null;
}
function nearestEnemy(g, ownerId, x) {
  return enemiesOf(g, ownerId).sort((a, b) => Math.abs(centre(a).x - x) - Math.abs(centre(b).x - x))[0] ?? null;
}

/** A shell has arrived somewhere: what its kind does there. */
function impact(g, s, x, y) {
  const w = weaponOf(s.weapon);
  switch (w.kind) {
    case 'tracer':
      g.sparks.push({ kind: 'tracer', x, y, smoke: !!w.smoke });
      removeShell(g, s);
      return;
    case 'riot':
      crater(g, x, y, w.radius);
      g.sparks.push({ kind: 'blast', x, y, radius: w.radius, weapon: w.name, riot: true });
      settleDirt(g, Math.floor(x - w.radius - 1), Math.ceil(x + w.radius + 1));
      landTanks(g);
      afterBlast(g, s.owner, 0);
      removeShell(g, s);
      return;
    case 'dirt': {
      const added = addDirt(g, x, y, w.radius);
      g.sparks.push({ kind: 'dirt', x, y, radius: w.radius, added });
      settleDirt(g, Math.floor(x - w.radius - 1), Math.ceil(x + w.radius + 1));
      landTanks(g);
      afterBlast(g, s.owner, 0);
      removeShell(g, s);
      return;
    }
    case 'napalm':
      flow(g, x, y, w, s.owner);
      removeShell(g, s);
      return;
    case 'roller': {
      const col = Math.max(0, Math.min(COLS - 1, Math.floor(x)));
      const left = g.tops[Math.max(0, col - 1)], right = g.tops[Math.min(COLS - 1, col + 1)];
      s.rolling = true; s.dir = left < right ? -1 : right < left ? 1 : (s.vx < 0 ? -1 : 1);
      s.rollLeft = 60; s.y = g.tops[col] + 0.3; s.x = col + 0.5;
      g.sparks.push({ kind: 'roll', x: s.x, y: s.y });
      return;
    }
    case 'digger':
      s.boring = { dx: 0, dy: -1, left: w.bore }; s.vx = 0; s.vy = 0;
      g.sparks.push({ kind: 'bore', x, y });
      return;
    case 'sandhog': {
      const sp = Math.hypot(s.vx, s.vy) || 1;
      s.boring = { dx: s.vx / sp, dy: Math.min(-0.15, s.vy / sp), left: w.bore };
      g.sparks.push({ kind: 'bore', x, y });
      return;
    }
    case 'funky': {
      blastAt(g, s, x, y, { keep: true, scale: 0.6 });
      for (let i = 0; i < w.bomblets; i++) {
        const vx = (g.rnd() * 2 - 1) * 10, vy = 8 + g.rnd() * 10;
        g.shells.push({ x, y: y + 0.5, vx, vy, weapon: 'funkyBomblet', owner: s.owner, path: [{ x, y }], t: 0, primary: false, hops: 0 });
      }
      removeShell(g, s);
      return;
    }
    case 'leapfrog': {
      const hop = (w.radii?.length ?? 0) - s.hops;            // 0, 1, 2
      const r = w.radii?.[Math.max(0, Math.min((w.radii?.length ?? 1) - 1, hop))] ?? w.radius;
      blastAt(g, s, x, y, { keep: s.hops > 1, radius: r });
      if (s.hops > 1) {
        s.hops -= 1;
        const col = Math.max(0, Math.min(COLS - 1, Math.floor(x)));
        s.y = g.tops[col] + 0.6; s.vy = Math.abs(s.vy) * 0.55 + 6; s.vx *= 0.85; s.t = 0;
      }
      return;
    }
    case 'liquidDirt':
      ooze(g, x, y, w, s.owner);
      removeShell(g, s);
      return;
    default:
      blastAt(g, s, x, y);
  }
}

function blastAt(g, s, x, y, { keep = false, scale = 1, radius = null } = {}) {
  const w = weaponOf(s.weapon);
  explode(g, x, y, { name: w.name, radius: (radius ?? w.radius) * scale, damage: w.damage * scale }, s.owner);
  if (!keep) removeShell(g, s);
}

/**
 * Liquid dirt: drops that ooze downhill along the surface and set where they pool, filling the
 * holes. Simulated at once, like napalm; the dirt it leaves is real.
 */
function ooze(g, x, y, w, ownerId) {
  const drops = [];
  for (let i = 0; i < w.drops; i++) drops.push({ x: Math.max(0, Math.min(COLS - 1, Math.floor(x + (g.rnd() * 2 - 1) * 1.5))), alive: true });
  let added = 0;
  let lo = COLS, hi = 0;
  for (let stepN = 0; stepN < w.steps; stepN++) {
    for (const d of drops) {
      if (!d.alive) continue;
      const top = g.tops[d.x];
      const l = d.x > 0 ? g.tops[d.x - 1] : Infinity, r = d.x < COLS - 1 ? g.tops[d.x + 1] : Infinity;
      if (l < top && l <= r) d.x -= 1;
      else if (r < top) d.x += 1;
      else if (top < ROWS - 1) {                              // pooled: it sets here
        g.dirt[idx(d.x, top)] = 1; g.tops[d.x] = top + 1; added += 1; d.alive = false;
        lo = Math.min(lo, d.x); hi = Math.max(hi, d.x);
      } else d.alive = false;
    }
  }
  if (added) g.landVersion += 1;
  g.sparks.push({ kind: 'dirt', x, y, radius: 1.5, added, ooze: true });
  landTanks(g);
  afterBlast(g, ownerId, 0);
}

/**
 * A wedge from the turret, at once (Riot Charge, Riot Blast; Dirt Charge with `dig` false):
 * every cell within `radius` of the muzzle and within `spread` degrees of the barrel's line is
 * cleared, or filled.
 */
function wedge(g, tank, w) {
  const m = muzzle(tank);
  const a = (tank.angle * Math.PI) / 180;
  const spread = (w.spread * Math.PI) / 180;
  let changed = 0;
  for (let x = Math.max(0, Math.floor(m.x - w.radius - 1)); x <= Math.min(COLS - 1, Math.ceil(m.x + w.radius + 1)); x++) {
    for (let y = Math.max(0, Math.floor(m.y - w.radius - 1)); y <= Math.min(ROWS - 1, Math.ceil(m.y + w.radius + 1)); y++) {
      const dx = x + 0.5 - m.x, dy = y + 0.5 - m.y;
      const d = Math.hypot(dx, dy);
      if (d > w.radius || d < 0.3) continue;
      let da = Math.atan2(dy, dx) - a;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      if (Math.abs(da) > spread) continue;
      if (w.dig && g.dirt[idx(x, y)]) { g.dirt[idx(x, y)] = 0; changed += 1; }
      else if (!w.dig && !g.dirt[idx(x, y)]) { g.dirt[idx(x, y)] = 1; changed += 1; }
    }
  }
  if (changed) g.landVersion += 1;
  g.sparks.push({ kind: w.dig ? 'blast' : 'dirt', x: m.x + Math.cos(a) * w.radius * 0.5, y: m.y + Math.sin(a) * w.radius * 0.5, radius: w.radius * 0.6, weapon: w.name, riot: true, wedge: true, removed: changed, added: changed });
  settleDirt(g, Math.floor(m.x - w.radius - 1), Math.ceil(m.x + w.radius + 1));
  landTanks(g);
  afterBlast(g, tank.id, 0);
}

/** The Earth Disrupter: every hanging piece of dirt on the field settles. */
function disrupt(g, tank) {
  settleDirt(g, 0, COLS - 1);
  g.sparks.push({ kind: 'disrupt', tank: tank.id, fell: g.falling.length });
  landTanks(g);
  afterBlast(g, tank.id, 0);
}

/** The Plasma Blast: energy thrown from the tank itself, its reach set by the power; the thrower is spared. */
function plasma(g, tank, w) {
  const r = w.minRadius + (w.radius - w.minRadius) * (tank.power / 1000);
  const c = centre(tank);
  explode(g, c.x, c.y, { name: w.name, radius: r, damage: w.damage }, tank.id, { spare: tank.id, dig: false });   // energy, not a crater
}

function endFlight(g) {
  g.shells = [];
  g.phase = 'settle';
  if (!g.falling.length) settled(g);
}

/** The laser: a straight line from the muzzle, at once; dirt along it goes, tanks on it burn. */
function laser(g, tank, w) {
  const a = (tank.angle * Math.PI) / 180;
  const m = muzzle(tank);
  const dx = Math.cos(a), dy = Math.sin(a);
  let x = m.x, y = m.y, d = 0;
  const burnt = new Set();
  while (x >= 0 && x < COLS && y >= 0 && y < ROWS + 2 && d < 200) {
    crater(g, x, y, w.radius);
    const t = tankAt(g, x, y, tank.id, 0.2);
    if (t && !burnt.has(t.id)) { burnt.add(t.id); applyDamage(g, t, w.damage, tank.id); }
    x += dx * 0.25; y += dy * 0.25; d += 0.25;
  }
  g.sparks.push({ kind: 'laser', x0: m.x, y0: m.y, x1: x, y1: y });
  settleDirt(g, Math.floor(Math.min(m.x, x)) - 1, Math.ceil(Math.max(m.x, x)) + 1);
  landTanks(g);
  afterBlast(g, tank.id, 0);
}

/**
 * Napalm: drops that run downhill along the surface and burn whatever they sit on, spent when
 * they pool in a dip. Simulated at once; the screen animates the cells it is told about.
 */
function flow(g, x, y, w, ownerId) {
  const cells = [];
  const drops = [];
  for (let i = 0; i < w.drops; i++) drops.push({ x: Math.max(0, Math.min(COLS - 1, Math.floor(x + (g.rnd() * 2 - 1) * 1.5))), alive: true });
  const burnt = new Map();
  for (let stepN = 0; stepN < w.steps; stepN++) {
    for (const d of drops) {
      if (!d.alive) continue;
      const top = g.tops[d.x];
      cells.push({ x: d.x, y: top, step: stepN });
      const t = tankAt(g, d.x + 0.5, top + 0.5, -1, 0.6);
      if (t) {
        const so = burnt.get(t.id) ?? 0;
        if (so < w.damage * 6) { applyDamage(g, t, w.damage, ownerId); burnt.set(t.id, so + w.damage); }
      }
      const l = d.x > 0 ? g.tops[d.x - 1] : Infinity, r = d.x < COLS - 1 ? g.tops[d.x + 1] : Infinity;
      if (l < top && l <= r) d.x -= 1;
      else if (r < top) d.x += 1;
      else if (g.rnd() < 0.35) d.alive = false;                // pooled: it burns out
    }
  }
  g.sparks.push({ kind: 'napalm', cells, x, y });
  landTanks(g);
  afterBlast(g, ownerId, 0);
}

/**
 * A blast: the dirt inside the circle goes, tanks in reach take damage by distance, the dirt
 * above the crater falls, tanks left in the air fall with it. Deaths are handled, and can chain.
 */
export function explode(g, cx, cy, weapon, ownerId, { chain = 0, spare = -1, dig = true } = {}) {
  const r = weapon.radius;
  const removed = dig ? crater(g, cx, cy, r) : 0;
  g.sparks.push({ kind: 'blast', x: cx, y: cy, radius: r, weapon: weapon.name, removed });
  // damage: full inside half the radius, falling to nothing a cell beyond the rim
  for (const t of g.tanks) {
    if (!t.alive || t.id === spare) continue;
    const d = distToTank(cx, cy, t);
    if (d > r + 1) continue;
    const k = d <= r * 0.5 ? 1 : Math.max(0, 1 - (d - r * 0.5) / (r * 0.5 + 1));
    const dmg = Math.round(weapon.damage * k);
    if (dmg > 0) applyDamage(g, t, dmg, ownerId);
  }
  settleDirt(g, Math.floor(cx - r - 1), Math.ceil(cx + r + 1));
  landTanks(g);
  afterBlast(g, ownerId, chain);
}

/** Damage through a shield first; cash to the attacker for every point of health that went. */
export function applyDamage(g, t, dmg, byId) {
  let left = dmg;
  let absorbed = 0;
  if (t.shield) {
    absorbed = Math.min(t.shield.hp, left);
    t.shield.hp -= absorbed;
    left -= absorbed;
    if (t.shield.hp <= 0) { t.shield = null; g.sparks.push({ kind: 'shieldDown', tank: t.id }); }
  }
  const before = t.health;
  t.health = Math.max(0, t.health - left);
  const lost = before - t.health;
  const by = g.tanks[byId] ?? null;
  if (by && by !== t) { by.damageDealt += lost; by.cash += lost * CASH_PER_DAMAGE; if (lost > 0) t.lastHitBy = byId; }
  g.sparks.push({ kind: 'hit', tank: t.id, damage: lost, absorbed, by: byId });
}

function afterBlast(g, ownerId, chain) {
  for (const t of g.tanks) if (t.alive && t.health <= 0) kill(g, t, ownerId, chain);
}

function distToTank(cx, cy, t) {
  const nx = Math.max(t.x, Math.min(t.x + TANK_W, cx)), ny = Math.max(t.y, Math.min(t.y + TANK_H, cy));
  return Math.hypot(cx - nx, cy - ny);
}

/** Tanks left in the air fall to the ground under them; a fall of more than a cell hurts, unless a parachute opens. */
export function landTanks(g) {
  for (const t of g.tanks) {
    if (!t.alive) continue;
    const ground = Math.min(g.tops[t.x], g.tops[Math.min(COLS - 1, t.x + 1)]);
    if (ground >= t.y) {
      if (ground > t.y) t.y = ground;                  // buried by dirt that landed on it: dug out to the surface
      continue;
    }
    const drop = t.y - ground;
    t.y = ground;
    if (drop > 1 && (t.items.parachute ?? 0) > 0) {
      t.items.parachute -= 1;
      g.sparks.push({ kind: 'chute', tank: t.id, cells: drop });
      continue;
    }
    const dmg = Math.max(0, Math.round((drop - 1) * FALL_DAMAGE));
    if (dmg > 0) t.health = Math.max(0, t.health - dmg);
    g.sparks.push({ kind: 'fall', tank: t.id, cells: drop, damage: dmg });
  }
}

function kill(g, t, byId, chain) {
  t.alive = false;
  t.health = 0;
  t.shield = null;
  const by = g.tanks[byId] ?? null;
  if (by && by !== t) { by.kills += 1; by.score += 100; by.cash += KILL_BONUS; }
  else t.score -= 50;                    // by its own shot, or the fall
  g.sparks.push({ kind: 'death', tank: t.id, by: byId });
  // the death blast, which can take a neighbour with it (chained at most as deep as there are tanks)
  if (chain < g.tanks.length) explode(g, t.x + TANK_W / 2, t.y + 0.5, DEATH_BLAST, t.id, { chain: chain + 1 });
}

/** The screen has finished animating the fall (or a test skips it): the turn passes. */
export function settled(g) {
  g.falling = [];
  if (g.phase !== 'settle') return;
  const living = alive(g);
  if (living.length <= 1) {
    g.phase = 'roundOver';
    const w = living[0] ?? null;
    if (w) { w.score += 200; w.cash += SURVIVOR_BONUS; }
    g.sparks.push({ kind: 'roundOver', winner: w?.id ?? null, round: g.round, last: g.round >= g.rounds });
    return;
  }
  nextTurn(g);
}

export function nextTurn(g) {
  const n = g.order.length;
  for (let k = 1; k <= n; k++) {
    const i = (g.turn + k) % n;
    if (g.tanks[g.order[i]].alive) { g.turn = i; break; }
  }
  if (g.windMode === 'turn') newWind(g);
  g.phase = 'aim';
  const t = current(g);
  autoDefend(g, t);
  g.sparks.push({ kind: 'turn', tank: t.id });
}

/** After a round: interest is paid, then the next one, or the game is over. */
export function nextRound(g) {
  if (g.phase !== 'roundOver') return false;
  if (g.round >= g.rounds) { g.phase = 'over'; g.sparks.push({ kind: 'over', winner: leader(g)?.id ?? null }); return false; }
  for (const t of g.tanks) payInterest(t, g.interest);
  g.round += 1;
  startRound(g);
  return true;
}

export function leader(g) {
  return [...g.tanks].sort((a, b) => b.score - a.score || b.kills - a.kills || b.health - a.health)[0] ?? null;
}

// ------------------------------------------------------------------- the picture
const strataColour = (y, top, x) => {
  const f = top > 0 ? (y + 0.5) / top : 0;
  let s = STRATA[STRATA.length - 1], i = STRATA.length - 1;
  for (let b = 0; b < STRATA.length; b++) if (f <= STRATA[b].to) { s = STRATA[b]; i = b; break; }
  // a nudge per column and stratum so the face is not flat colour
  const k = 0.9 + 0.2 * hash01(x * 7 + i * 131);
  return shade(s.color, k);
};
function shade(hex, k) {
  const h = hex.replace('#', '');
  const ch = (i) => Math.max(0, Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) * k)));
  return `#${[ch(0), ch(2), ch(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The land as tiles for the engine: A CUBE PER CELL, coloured by stratum. Not one tall tile per
 * run: under the oblique camera a tile's height climbs the screen at 0.3 of a grid row, so a run
 * of twelve cells stood four rows tall and the next stratum began twelve rows up -- the land drew
 * as floating ribbons. Tetrust's well is cells for the same reason. About 1,800 cubes on a fresh
 * field; the screen draws them on their own canvas and redraws it only when `landVersion` moves,
 * so they cost nothing while a shell flies. `omit` (a Set of "x,y") leaves cells out -- the ones
 * the screen is animating on its actor layer while they fall.
 */
export function landTiles(g, { omit = null } = {}) {
  const out = [];
  for (let x = 0; x < COLS; x++) {
    const top = g.tops[x];
    for (let y = 0; y < ROWS; y++) {
      if (!g.dirt[idx(x, y)]) continue;
      if (omit?.has(`${x},${y}`)) continue;
      out.push({ txid: `c${x}:${y}`, x, y, s: 1, tall: 1, color: strataColour(y, top, x) });
    }
  }
  return out;
}

/**
 * The actors: the tanks as a hull, a turret and a barrel (and a shield as a wire cube round them),
 * every shell as a ball, and the last shot's trace as a string of dim beads. Ids are stable, so a
 * tank that has not moved is the same tile frame after frame.
 */
export function actorTiles(g, { trace = true, tankY = null, chutes = null } = {}) {
  const out = [];
  for (const t of g.tanks) {
    if (!t.alive) continue;
    const c = t.colour;
    const y = tankY?.get(t.id) ?? t.y;                 // the screen may still be lowering it after a fall
    out.push({ txid: `track${t.id}`, x: t.x - 0.15, y: y - 0.05, s: 1.15, tall: 0.35, color: shade(c, 0.45) });
    out.push({ txid: `track${t.id}b`, x: t.x + 1, y: y - 0.05, s: 1.15, tall: 0.35, color: shade(c, 0.45) });
    out.push({ txid: `hull${t.id}a`, x: t.x, y: y + 0.3, s: 1, tall: 0.9, color: c, label: t.name });
    out.push({ txid: `hull${t.id}b`, x: t.x + 1, y: y + 0.3, s: 1, tall: 0.9, color: c, label: t.name });
    out.push({ txid: `turret${t.id}`, x: t.x + 0.65, y: y + 0.55, s: 0.7, tall: 1.6, color: shade(c, 1.15) });
    // the barrel: a bar in unit space pointing right, turned by the angle (screen y is down, so
    // a counter-clockwise angle on the field is a negative rotation on the screen)
    out.push({
      txid: `barrel${t.id}`, x: t.x + TANK_W / 2 - 0.5, y: y + 0.6, s: 1, tall: 1.4, color: shade(c, 0.85),
      poly: [[0, -0.06], [0.75, -0.06], [0.75, 0.06], [0, 0.06]], rot: -(t.angle * Math.PI) / 180,
    });
    // a pennant on the turret, streaming downwind and lifting with the strength (the wind made visible)
    const w = g.wind;
    if (Math.abs(w) > 0.05) {
      const len = 0.45 + 0.5 * Math.min(1, Math.abs(w) / WIND_MAX), lift = 0.35 * (1 - Math.min(1, Math.abs(w) / WIND_MAX));
      const dir = w > 0 ? 1 : -1;
      out.push({
        txid: `flag${t.id}`, x: t.x + TANK_W / 2 - 0.5, y: y + 1.9, s: 1, tall: 0.01, color: shade(c, 1.2),
        poly: [[0, 0], [dir * len, -lift * 0.5 - 0.06], [dir * len * 0.85, -lift * 0.5 + 0.06]], rot: 0,
      });
    }
    if (chutes?.has(t.id)) {
      // a canopy over a tank coming down under its parachute: a half-disc, and the lines to the hull
      const pts = [];
      for (let i = 0; i <= 8; i++) { const a = Math.PI + (i / 8) * Math.PI; pts.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5 - 0.1]); }
      pts.push([0.5, -0.1], [0.15, 0.45], [-0.15, 0.45], [-0.5, -0.1]);
      out.push({ txid: `chute${t.id}`, x: t.x + TANK_W / 2 - 1.4, y: y + 2.4, s: 2.8, tall: 0.01, color: '#f2efe6', poly: pts, rot: 0 });
    }
    if (t.shield) {
      const k = t.shield.id === 'heavyShield' ? '#7ad7ff' : t.shield.id === 'forceShield' ? '#8fe0ff' : '#9ce8ff';
      out.push({ txid: `shield${t.id}`, x: t.x - 0.6, y: y - 0.4, s: TANK_W + 1.2, tall: 1.6, wire: k, color: k });
    }
  }
  g.shells.forEach((s, i) => {
    out.push({ txid: `shell${i}`, x: s.x - 0.25, y: s.y - 0.25, s: 0.5, tall: 0.5, sphere: true, color: s.boring ? '#ffb347' : '#fff2c8' });
  });
  if (trace && g.lastPath.length > 2) {
    const every = Math.max(1, Math.floor(g.lastPath.length / 40));
    for (let i = 0; i < g.lastPath.length; i += every) {
      const p = g.lastPath[i];
      if (p.y < 0 || p.y > ROWS + 4) continue;
      out.push({ txid: `trace${i}`, x: p.x - 0.1, y: p.y - 0.1, s: 0.2, tall: 0.2, sphere: true, color: '#7a8699' });
    }
  }
  return out;
}

/** The whole picture: the land and the actors (the screen draws them on two canvases; a test wants both). */
export function tiles(g, opts = {}) {
  return [...landTiles(g, opts), ...actorTiles(g, opts)];
}
