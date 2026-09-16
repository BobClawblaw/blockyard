// SCORCHED YARD, the computer players (docs/PLAN-SCORCHED-YARD.md §6; the manual's own words
// for each are quoted there). Each personality is a function of the game and its tank that
// answers `{ angle, power, weapon }`; the screen applies it through `aim()` and `fire()` like a
// key press, so the AI shares nothing with the DOM and a test can hold each one to its habit.
//
// They plan with `simulateShot`, the rules' own physics run without side effects: the walls, the
// wind, the dirt and the tanks in the way are all in it, so a Poolshark's rebound and a
// Spoiler's "perfect shot almost every time" are the same search over different angles.
import { WEAPON_ORDER, WEAPONS, ITEMS, alive, simulateShot, buy, useItem, COLS, TANK_W, MAX_HEALTH } from './scorched.js';
import { SHOP } from './scorchedshop.js';

const centreX = (t) => t.x + TANK_W / 2;
const toward = (tank, target, a) => (centreX(target) > centreX(tank) ? a : 180 - a);

/** The nearest living tank other than this one. */
export function nearest(g, tank) {
  return alive(g).filter((t) => t !== tank).sort((a, b) => Math.abs(a.x - tank.x) - Math.abs(b.x - tank.x))[0] ?? null;
}
/** The tank with the highest score (ties by health), other than this one. */
export function leaderOf(g, tank) {
  return alive(g).filter((t) => t !== tank).sort((a, b) => b.score - a.score || b.health - a.health)[0] ?? null;
}
/** The weakest living tank other than this one. */
export function weakest(g, tank) {
  return alive(g).filter((t) => t !== tank).sort((a, b) => a.health - b.health)[0] ?? null;
}

/**
 * How far a simulated shot ends from the target: the horizontal miss, with a hit on the target
 * counted as zero and a hit on someone else, or a lost shell, as a poor result.
 */
function missOf(g, tank, target, angle, power) {
  const r = simulateShot(g, tank, angle, power);
  if (r.hit === target.id) return 0;
  if (r.lost) return 1000;
  const dx = Math.abs(r.x - centreX(target));
  const dy = Math.abs(r.y - target.y);
  return dx + dy * 0.5 + (r.hit != null ? 10 : 0);
}

/**
 * The search: every angle in `angles` (relative to the target's side) at every power step, the
 * shot with the smallest miss. `step` is the power grid; the Spoiler searches finer.
 */
export function solve(g, tank, target, angles = [35, 45, 55, 65, 75], step = 25) {
  let best = null;
  for (const a0 of angles) {
    const angle = toward(tank, target, a0);
    for (let power = 100; power <= 1000; power += step) {
      const miss = missOf(g, tank, target, angle, power);
      if (!best || miss < best.miss) best = { angle, power, miss };
      if (miss === 0) return best;
    }
  }
  return best;
}

/** Refine a solution around it: a few degrees and a few units of power either way. */
function refine(g, tank, target, best) {
  let out = best;
  for (const da of [-3, -1.5, 0, 1.5, 3]) {
    for (const dp of [-20, -10, 0, 10, 20]) {
      const angle = Math.max(0, Math.min(180, best.angle + da)), power = Math.max(0, Math.min(1000, best.power + dp));
      const miss = missOf(g, tank, target, angle, power);
      if (miss < out.miss) out = { angle, power, miss };
      if (miss === 0) return out;
    }
  }
  return out;
}

/** The biggest blast the tank owns that suits the target's health, or the baby missile. */
function pickWeapon(tank, target, { thrifty = false } = {}) {
  const owned = WEAPON_ORDER.filter((w) => (tank.inventory[w] ?? 0) > 0 && WEAPONS[w].kind === 'blast');
  if (!owned.length) return 'babyMissile';
  if (thrifty || target.health <= 30) return owned[0];
  return owned.sort((a, b) => WEAPONS[b].damage - WEAPONS[a].damage)[0];
}

// ------------------------------------------------------------------- the personalities
/** The Moron: "pick an angle and power, and shoot". Whatever it happens to own. */
export function moron(g, tank, rnd = g.rnd) {
  const left = tank.x > COLS / 2;
  const angle = left ? 95 + Math.round(rnd() * 65) : 20 + Math.round(rnd() * 65);
  const power = 300 + Math.round(rnd() * 700);
  const owned = WEAPON_ORDER.filter((w) => (tank.inventory[w] ?? 0) > 0);
  const weapon = owned[Math.floor(rnd() * owned.length)] ?? 'babyMissile';
  return { angle, power, weapon };
}

/** The Shooter: "significantly deadlier … only if they have a straight line of fire": low, direct shots. */
export function shooter(g, tank, rnd = g.rnd) {
  const target = nearest(g, tank);
  if (!target) return moron(g, tank, rnd);
  const best = solve(g, tank, target, [12, 20, 28, 36], 25);
  if (!best || best.miss > 12) return { ...moron(g, tank, rnd), weapon: 'babyMissile', fallback: true };   // no line of fire: a Moron's shot
  return { angle: best.angle, power: best.power, weapon: pickWeapon(tank, target, { thrifty: best.miss > 4 }) };
}

/** The Poolshark: a Shooter, unless the walls rebound -- then it looks for the bank shot as well. */
export function poolshark(g, tank, rnd = g.rnd) {
  if (g.walls !== 'rubber' && g.walls !== 'spring') return shooter(g, tank, rnd);
  const target = nearest(g, tank);
  if (!target) return moron(g, tank, rnd);
  // the direct low shots and the ones off the wall behind it (angles past 90 face the wall)
  const direct = solve(g, tank, target, [12, 20, 28, 36], 25);
  const bank = solve(g, tank, target, [110, 125, 140, 155], 25);
  const best = [direct, bank].filter(Boolean).sort((a, b) => a.miss - b.miss)[0];
  if (!best || best.miss > 12) return { ...moron(g, tank, rnd), weapon: 'babyMissile', fallback: true };
  return { angle: best.angle, power: best.power, weapon: pickWeapon(tank, target, { thrifty: best.miss > 4 }) };
}

/**
 * The Tosser: "start out like Morons, but they'll refine their aim … until they hit". A high lob
 * at the nearest tank, then the power corrected from the last shot's miss, by halves.
 */
export function tosser(g, tank, rnd = g.rnd) {
  const target = nearest(g, tank);
  if (!target) return moron(g, tank, rnd);
  const m = tank.memory;
  let angle, power;
  if (!m || m.target !== target.id) {
    angle = toward(tank, target, 60 + Math.round(rnd() * 15));
    power = 350 + Math.round(rnd() * 400);
  } else {
    angle = m.angle;
    const r = simulateShot(g, tank, m.angle, m.power);
    const short = Math.abs(r.x - centreX(tank)) < Math.abs(centreX(target) - centreX(tank));
    const stepP = Math.max(8, Math.round((m.step ?? 160) / 2));
    power = Math.max(50, Math.min(1000, m.power + (short ? stepP : -stepP)));
    tank.memory = { ...m, step: stepP };
  }
  tank.memory = { ...(tank.memory ?? {}), target: target.id, angle, power, step: tank.memory?.step ?? 160 };
  return { angle, power, weapon: pickWeapon(tank, target, { thrifty: true }) };
}

/** The Chooser: "all the above methods available … decide which one will be most effective". */
export function chooser(g, tank, rnd = g.rnd) {
  const target = nearest(g, tank);
  if (!target) return moron(g, tank, rnd);
  const low = solve(g, tank, target, [12, 20, 28, 36], 25);
  const lob = solve(g, tank, target, [55, 65, 75], 25);
  const bank = (g.walls === 'rubber' || g.walls === 'spring') ? solve(g, tank, target, [115, 135, 155], 25) : null;
  const best = [low, lob, bank].filter(Boolean).sort((a, b) => a.miss - b.miss)[0];
  if (!best) return moron(g, tank, rnd);
  return { angle: best.angle, power: best.power, weapon: pickWeapon(tank, target) };
}

/** The Spoiler: "taking into account the wind factor and gravity, they will get a perfect shot almost every time". */
export function spoiler(g, tank, rnd = g.rnd, target = nearest(g, tank)) {
  if (!target) return moron(g, tank, rnd);
  const coarse = solve(g, tank, target, [15, 25, 35, 45, 55, 65, 75], 20);
  const best = coarse ? refine(g, tank, target, coarse) : null;
  if (!best) return moron(g, tank, rnd);
  // "almost": a degree or two of error, drawn from the game's own stream
  const wobble = rnd() < 0.15 ? (rnd() - 0.5) * 4 : 0;
  return { angle: Math.max(0, Math.min(180, best.angle + wobble)), power: best.power, weapon: pickWeapon(tank, target) };
}

/** The Cyborg: a Spoiler that "attacks tanks who are weakened, winning, or have attacked them". */
export function cyborg(g, tank, rnd = g.rnd) {
  const grudge = tank.lastHitBy != null ? g.tanks[tank.lastHitBy] : null;
  const weak = weakest(g, tank);
  const lead = leaderOf(g, tank);
  const target = (grudge?.alive && grudge !== tank) ? grudge : (weak && weak.health <= 40) ? weak : lead ?? nearest(g, tank);
  return spoiler(g, tank, rnd, target);
}

const PERSONALITIES = { moron, shooter, poolshark, tosser, chooser, spoiler, cyborg };

/**
 * What this tank does this turn. The persona is what the rules drew for it this round (an Unknown
 * plays as one of the others); unknown kinds play as the Moron. A battery is used first when it
 * is worth it.
 */
export function decide(g, tank) {
  const play = PERSONALITIES[tank.persona] ?? PERSONALITIES[tank.kind] ?? moron;
  const d = play(g, tank);
  if (!WEAPONS[d.weapon] || (tank.inventory[d.weapon] ?? 0) <= 0) d.weapon = 'babyMissile';
  return d;
}

/** Before firing: the items a computer player uses on its turn (a battery when hurt, a shield when threatened). */
export function prepare(g, tank) {
  const used = [];
  if (tank.persona !== 'moron' && tank.health <= 50 && (tank.items.battery ?? 0) > 0 && useItem(g, tank, 'battery')) used.push('battery');
  if (tank.persona !== 'moron' && !tank.shield && tank.health < MAX_HEALTH && useItem(g, tank, 'shield')) used.push('shield');
  return used;
}

// ------------------------------------------------------------------- the shop, by taste
const TASTES = {
  moron: null,                                                        // random
  shooter: ['missile', 'babyNuke', 'nuke', 'battery', 'shield'],
  poolshark: ['missile', 'babyNuke', 'heavyRoller', 'battery', 'shield'],
  tosser: ['mirv', 'funkyBomb', 'babyNuke', 'parachute', 'battery'],
  chooser: ['nuke', 'babyNuke', 'mirv', 'shield', 'parachute', 'battery', 'missile'],
  spoiler: ['nuke', 'deathsHead', 'heatGuidance', 'shield', 'forceShield', 'battery', 'contactTrigger'],
  cyborg: ['deathsHead', 'nuke', 'heavyShield', 'forceShield', 'heatGuidance', 'battery', 'parachute'],
};

/**
 * Between rounds the computer shops. The Moron buys at random until it cannot afford the next
 * thing it points at; the others go down their list of tastes, buying what they can, up to
 * `picks` packs. Returns what was bought, in order.
 */
export function shop(g, tank, rnd = g.rnd, picks = 3) {
  const bought = [];
  if (tank.kind === 'human') return bought;
  const taste = TASTES[tank.persona] ?? TASTES[tank.kind] ?? null;
  for (let i = 0; i < picks; i++) {
    let pick = null;
    if (taste) {
      pick = taste.map((id) => SHOP.find((e) => e.id === id)).find((e) => e && tank.cash >= e.price && ((e.item ? tank.items[e.id] : tank.inventory[e.id]) ?? 0) < e.pack * 2) ?? null;
    } else {
      const affordable = SHOP.filter((e) => tank.cash >= e.price);
      pick = affordable.length ? affordable[Math.floor(rnd() * affordable.length)] : null;
    }
    if (!pick || !buy(tank, pick.id)) break;
    bought.push(pick.id);
  }
  return bought;
}
