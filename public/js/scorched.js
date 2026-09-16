// SCORCHED YARD, the rules (operator, 2026-09-16: "Scope out a plan for re-creating the classic PC
// DOS game Scorched Earth using our engine. I suggest using blocks to generate the deformable
// landscape ... Make it at least 3 player. 1 Human Player and 2 AI Players. Try to reproduce it as
// faithfully as possible, but make it look fabulous"; then "go with 96x48, start on M1").
//
// This file knows nothing of the screen: no DOM, no canvas, no clock. A game is a plain object; a
// shot is a function of it; the screen (scorchedyard.js) asks for `tiles(g)` when it wants to
// draw. Every random choice comes from the game's own seeded stream, so a round replays exactly in
// a test (docs/PLAN-SCORCHED-YARD.md is the plan; this is its M1: the landscape, the tanks, four
// missiles, craters, falling dirt, damage, death, turns and a round).
//
// THE FIELD is W x H cells (96 x 48: the original's 640 x 350 EGA screen was about 2:1, so a cell
// stands in for six or seven of its pixels). The dirt is a BITMAP over those cells, not a height
// per column, so that a tunnel or an overhang exists once the diggers arrive (M2); a column's top
// is kept beside it for the fast questions. Grid y runs UP from the floor, as the engine draws it.
//
// UNITS: grid cells, and seconds inside the integrator (the screen hands it milliseconds). Power
// 0..1000 is the original's scale; 1000 throws a shell at V_MAX cells a second, which on Earth
// gravity carries a 45° shot across the whole field and no further -- the original's feel.

export const COLS = 96;
export const ROWS = 48;

// what a shot does (M1: four missiles; the roster grows in M2 -- docs/PLAN-SCORCHED-YARD.md §4)
export const WEAPONS = Object.freeze({
  babyMissile: Object.freeze({ name: 'Baby Missile', radius: 1.5, damage: 30, price: 0, pack: 99 }),
  missile: Object.freeze({ name: 'Missile', radius: 2.5, damage: 55, price: 1875, pack: 5 }),
  babyNuke: Object.freeze({ name: 'Baby Nuke', radius: 4, damage: 80, price: 10000, pack: 3 }),
  nuke: Object.freeze({ name: 'Nuke', radius: 6.5, damage: 100, price: 12000, pack: 1 }),
});
export const WEAPON_ORDER = Object.freeze(['babyMissile', 'missile', 'babyNuke', 'nuke']);
export const START_INVENTORY = Object.freeze({ babyMissile: 99, missile: 5, babyNuke: 2, nuke: 1 });

// the tanks' colours, in the order players are added (the original's palette, roughly)
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
export const MIN_SPACING = 12;        // columns between tanks at placement

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

// ------------------------------------------------------------------- the game
/**
 * A new game. `players` is a list of `{ name, kind: 'human' | 'moron' | ..., colour? }`; the
 * first human plays from the keyboard, the rest are decided by scorchedai.js. Options: `seed`,
 * `gravity` (1 = Earth), `wind` ('turn' | 'shot' | 'none'), `walls` ('concrete' | 'rubber' |
 * 'wrap' | 'none'), `land` (a landscape style), `rounds`.
 */
export function newGame(players, opts = {}) {
  const seed = Number.isFinite(opts.seed) ? opts.seed : (Date.now() >>> 0);
  const g = {
    seed, rnd: rng(seed),
    W: COLS, H: ROWS,
    dirt: new Uint8Array(COLS * ROWS), tops: new Int16Array(COLS),
    gravity: Number.isFinite(opts.gravity) ? opts.gravity : 1,
    windMode: opts.wind ?? 'turn', walls: opts.walls ?? 'concrete', land: opts.land ?? 'hills',
    wind: 0,
    tanks: (players ?? []).map((p, i) => ({
      id: i, name: p.name ?? `Player ${i + 1}`, kind: p.kind ?? 'human', colour: p.colour ?? TANK_COLOURS[i % TANK_COLOURS.length],
      x: 0, y: 0, health: MAX_HEALTH, alive: true, angle: 45, power: 500, weapon: 'babyMissile',
      inventory: { ...START_INVENTORY }, kills: 0, score: 0, cash: 0, damageDealt: 0,
    })),
    round: 1, rounds: Math.max(1, Math.round(opts.rounds ?? 5)),
    turn: 0,                              // index into `order`
    order: [],                            // tank ids, this round's turn order
    phase: 'aim',                         // 'aim' | 'flight' | 'settle' | 'roundOver' | 'over'
    shell: null,                          // { x, y, vx, vy, weapon, owner, path: [] } while in flight
    lastPath: [],                         // the last shot's trace, for the screen
    falling: [],                          // dirt runs on their way down, for the screen: { x, y0, y1, from }
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
  for (const t of g.tanks) { t.health = MAX_HEALTH; t.alive = true; }
  const n = g.tanks.length;
  g.order = g.tanks.map((t) => t.id).map((_, i, a) => a[(i + g.round - 1) % n]);
  g.turn = 0;
  g.phase = 'aim';
  g.shell = null; g.lastPath = []; g.falling = [];
  newWind(g);
  g.sparks.push({ kind: 'round', round: g.round });
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

function newWind(g) {
  if (g.windMode === 'none') { g.wind = 0; return; }
  g.wind = Math.round((g.rnd() * 2 - 1) * WIND_MAX * 10) / 10;
}

export const current = (g) => g.tanks[g.order[g.turn]];
export const alive = (g) => g.tanks.filter((t) => t.alive);

/** Aim: angle 0..180 (90 straight up), power 0..1000, clamped. */
export function aim(g, tank, { angle, power, weapon } = {}) {
  if (angle != null) tank.angle = Math.max(0, Math.min(180, Math.round(angle)));
  if (power != null) tank.power = Math.max(0, Math.min(1000, Math.round(power)));
  if (weapon != null && WEAPONS[weapon]) tank.weapon = weapon;
}

/** The next weapon in the cycle that the tank still has, `dir` +1 or -1. */
export function cycleWeapon(tank, dir = 1) {
  const i = WEAPON_ORDER.indexOf(tank.weapon);
  for (let k = 1; k <= WEAPON_ORDER.length; k++) {
    const w = WEAPON_ORDER[(i + dir * k + WEAPON_ORDER.length * k) % WEAPON_ORDER.length];
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

/**
 * Fire the current tank's weapon. Returns false if it is not the moment (a shell in flight, a
 * dead tank, an empty slot). The shell then flies through `step()`.
 */
export function fire(g, tank = current(g)) {
  if (g.phase !== 'aim' || !tank?.alive || tank !== current(g)) return false;
  if ((tank.inventory[tank.weapon] ?? 0) <= 0) { cycleWeapon(tank, 1); if ((tank.inventory[tank.weapon] ?? 0) <= 0) return false; }
  if (tank.weapon !== 'babyMissile') tank.inventory[tank.weapon] -= 1;   // the baby missile is the original's bottomless one
  const a = (tank.angle * Math.PI) / 180;
  const v = (tank.power / 1000) * V_MAX;
  const m = muzzle(tank);
  g.shell = { x: m.x, y: m.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, weapon: tank.weapon, owner: tank.id, path: [{ x: m.x, y: m.y }], t: 0 };
  g.phase = 'flight';
  g.shots += 1;
  g.sparks.push({ kind: 'fire', tank: tank.id, weapon: tank.weapon });
  return true;
}

/** The shell's position `t` seconds from now with no walls in the way (the AI's oracle, and a test's). */
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
 * Advance the game by dtMs. Returns the events of the step (the screen makes sounds and pictures
 * of them). Substepped so a shell never crosses more than MAX_STEP a hop, whatever the frame.
 */
export function step(g, dtMs) {
  const events = [];
  if (g.phase === 'flight' && g.shell) {
    const dt = Math.min(100, Math.max(0, dtMs)) / 1000;   // a frame, capped: a tab that slept catches up in hops, not a leap
    const s = g.shell;
    const sp = Math.hypot(s.vx, s.vy) + 1e-6;
    const n = Math.max(1, Math.ceil((sp * dt) / MAX_STEP) + 1);
    const h = dt / n;
    for (let i = 0; i < n && g.phase === 'flight'; i++) flightStep(g, h, events);
  }
  if (g.phase === 'settle') {
    // the dirt has settled and the tanks have landed in `explode`; the screen animates the fall
    // from `g.falling` and calls `settled()` when the last run is down. A test calls it directly.
  }
  if (g.sparks.length) { events.push(...g.sparks); g.sparks = []; }
  return events;
}

function flightStep(g, h, events) {
  const s = g.shell;
  s.vx += g.wind * WIND_ACCEL * h;
  s.vy -= GRAVITY * g.gravity * h;
  s.x += s.vx * h; s.y += s.vy * h; s.t += h;
  if (s.path.length < 600) s.path.push({ x: s.x, y: s.y });
  // the walls, by mode
  if (s.x < 0 || s.x >= COLS) {
    if (g.walls === 'rubber') { s.x = s.x < 0 ? -s.x : 2 * COLS - s.x - 1e-3; s.vx = -s.vx * 0.8; events.push({ kind: 'bounce' }); }
    else if (g.walls === 'wrap') { s.x = ((s.x % COLS) + COLS) % COLS; }
    else if (g.walls === 'none') { g.sparks.push({ kind: 'lost' }); endFlight(g, null); return; }
    else { s.x = Math.max(0, Math.min(COLS - 1e-3, s.x)); explode(g, s.x, s.y, WEAPONS[s.weapon], s.owner); endFlight(g, null); return; }
  }
  if (s.y < 0) { explode(g, s.x, 0, WEAPONS[s.weapon], s.owner); endFlight(g, null); return; }
  if (s.y < ROWS && dirtAt(g, Math.floor(s.x), Math.floor(s.y))) { explode(g, s.x, s.y, WEAPONS[s.weapon], s.owner); endFlight(g, null); return; }
  for (const t of g.tanks) {
    if (!t.alive) continue;
    if (s.x >= t.x - 0.2 && s.x <= t.x + TANK_W + 0.2 && s.y >= t.y - 0.2 && s.y <= t.y + TANK_H) {
      // the shooter's own hull is passed on the way out of the barrel
      if (t.id === s.owner && s.t < 0.12) continue;
      explode(g, s.x, s.y, WEAPONS[s.weapon], s.owner);
      endFlight(g, null);
      return;
    }
  }
}

function endFlight(g, at) {
  g.lastPath = g.shell?.path ?? [];
  g.shell = null;
  g.phase = 'settle';
  if (at) g.sparks.push(at);
  if (!g.falling.length) settled(g);
}

/**
 * A blast: the dirt inside the circle goes, tanks in reach take damage by distance, the dirt
 * above the crater falls, tanks left in the air fall with it. Deaths are handled, and can chain.
 */
export function explode(g, cx, cy, weapon, ownerId, { chain = 0 } = {}) {
  const r = weapon.radius;
  const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(COLS - 1, Math.ceil(cx + r + 1));
  let removed = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(ROWS - 1, Math.ceil(cy + r + 1)); y++) {
      if (!g.dirt[idx(x, y)]) continue;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) { g.dirt[idx(x, y)] = 0; removed += 1; }
    }
  }
  g.landVersion += 1;
  g.sparks.push({ kind: 'blast', x: cx, y: cy, radius: r, weapon: weapon.name, removed });
  // damage: full inside half the radius, falling to nothing a cell beyond the rim
  const owner = g.tanks[ownerId] ?? null;
  for (const t of g.tanks) {
    if (!t.alive) continue;
    const d = distToTank(cx, cy, t);
    if (d > r + 1) continue;
    const k = d <= r * 0.5 ? 1 : Math.max(0, 1 - (d - r * 0.5) / (r * 0.5 + 1));
    const dmg = Math.round(weapon.damage * k);
    if (dmg <= 0) continue;
    t.health = Math.max(0, t.health - dmg);
    if (owner && owner !== t) owner.damageDealt += dmg;
    g.sparks.push({ kind: 'hit', tank: t.id, damage: dmg, by: ownerId });
  }
  settleDirt(g, x0, x1);
  landTanks(g);
  for (const t of g.tanks) {
    if (t.alive && t.health <= 0) kill(g, t, ownerId, chain);
  }
  // (the flight ends in flightStep, after the outermost blast and its chain have all landed)
}

function distToTank(cx, cy, t) {
  const nx = Math.max(t.x, Math.min(t.x + TANK_W, cx)), ny = Math.max(t.y, Math.min(t.y + TANK_H, cy));
  return Math.hypot(cx - nx, cy - ny);
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
        for (let k = 0; k < len; k++) { g.dirt[idx(x, start + k)] = 0; }
        for (let k = 0; k < len; k++) { g.dirt[idx(x, write + k)] = 1; }
        g.falling.push({ x, y: write, len, from: start });
      }
      write += len;
    }
    g.tops[x] = write;
  }
  g.landVersion += 1;
}

/** Tanks left in the air fall to the ground under them; a fall of more than a cell hurts. */
export function landTanks(g) {
  for (const t of g.tanks) {
    if (!t.alive) continue;
    const ground = Math.min(g.tops[t.x], g.tops[Math.min(COLS - 1, t.x + 1)]);
    if (ground >= t.y) {
      // buried by dirt that landed on it (M2's dirt weapons): dig it out to the surface
      if (ground > t.y) { t.y = ground; }
      continue;
    }
    const drop = t.y - ground;
    t.y = ground;
    const dmg = Math.max(0, Math.round((drop - 1) * FALL_DAMAGE));
    if (dmg > 0) { t.health = Math.max(0, t.health - dmg); g.sparks.push({ kind: 'fall', tank: t.id, cells: drop, damage: dmg }); }
    else g.sparks.push({ kind: 'fall', tank: t.id, cells: drop, damage: 0 });
  }
}

function kill(g, t, byId, chain) {
  t.alive = false;
  t.health = 0;
  const by = g.tanks[byId] ?? null;
  if (by && by !== t) { by.kills += 1; by.score += 100; }
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
    if (w) w.score += 200;
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
  g.sparks.push({ kind: 'turn', tank: current(g).id });
}

/** After a round: the next one, or the game is over. */
export function nextRound(g) {
  if (g.phase !== 'roundOver') return false;
  if (g.round >= g.rounds) { g.phase = 'over'; g.sparks.push({ kind: 'over', winner: leader(g)?.id ?? null }); return false; }
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
  // a nudge per column and stratum so the face is not flat colour -- per column, not per row, so a
  // run stays one tile (a nudge every few rows made eight hundred tiles of a field of four hundred)
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
 * The actors: the tanks as a hull, a turret and a barrel, the shell as a ball, and the last
 * shot's trace as a string of dim beads. Ids are stable, so a tank that has not moved is the same
 * tile frame after frame.
 */
export function actorTiles(g, { trace = true } = {}) {
  const out = [];
  for (const t of g.tanks) {
    if (!t.alive) continue;
    const c = t.colour;
    out.push({ txid: `hull${t.id}a`, x: t.x, y: t.y, s: 1, tall: 1.2, color: c, label: t.name });
    out.push({ txid: `hull${t.id}b`, x: t.x + 1, y: t.y, s: 1, tall: 1.2, color: c, label: t.name });
    out.push({ txid: `turret${t.id}`, x: t.x + 0.65, y: t.y + 0.55, s: 0.7, tall: 1.6, color: shade(c, 1.15) });
    // the barrel: a bar in unit space pointing right, turned by the angle (screen y is down, so
    // a counter-clockwise angle on the field is a negative rotation on the screen)
    out.push({
      txid: `barrel${t.id}`, x: t.x + TANK_W / 2 - 0.5, y: t.y + 0.6, s: 1, tall: 1.4, color: shade(c, 0.85),
      poly: [[0, -0.06], [0.7, -0.06], [0.7, 0.06], [0, 0.06]], rot: -(t.angle * Math.PI) / 180,
    });
  }
  if (g.shell) {
    out.push({ txid: 'shell', x: g.shell.x - 0.25, y: g.shell.y - 0.25, s: 0.5, tall: 0.5, sphere: true, color: '#fff2c8' });
  }
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
