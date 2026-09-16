// SCORCHED YARD, the computer players (docs/PLAN-SCORCHED-YARD.md §6). Each personality is a
// function of the game and its tank that answers `{ angle, power, weapon }`; the screen applies it
// through `aim()` and `fire()` like a key press, so the AI shares nothing with the DOM and a test
// can hold each one to its habit. M1 shipped the Moron; M2 gives it a wallet; the rest arrive in M3.
import { WEAPON_ORDER, WEAPONS, alive, trajectory, buy, COLS, TANK_W } from './scorched.js';
import { SHOP } from './scorchedshop.js';

/** The Moron: a random angle and power, and whatever it happens to own. The original's easiest opponent. */
export function moron(g, tank, rnd = g.rnd) {
  const left = tank.x > COLS / 2;                       // face the field, at least
  const angle = left ? 95 + Math.round(rnd() * 65) : 20 + Math.round(rnd() * 65);
  const power = 300 + Math.round(rnd() * 700);
  const owned = WEAPON_ORDER.filter((w) => (tank.inventory[w] ?? 0) > 0);
  const weapon = owned[Math.floor(rnd() * owned.length)] ?? 'babyMissile';
  return { angle, power, weapon };
}

/**
 * The Shooter's aim (used from M3, exported now so its test can grow with it): aims at the
 * nearest living tank by searching power at a few angles for the landing nearest the target,
 * with this game's gravity and wind, then corrects from the last miss.
 */
export function solve(g, tank, target, angles = [35, 45, 55, 65, 75]) {
  let best = null;
  const tx = target.x + TANK_W / 2;
  for (const a0 of angles) {
    const angle = tx > tank.x ? a0 : 180 - a0;
    for (let power = 150; power <= 1000; power += 25) {
      const probe = { ...tank, angle, power };
      const pts = trajectory(g, probe, 8, 1 / 30);
      let land = pts[pts.length - 1];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        if (p.y <= target.y + 0.5 && pts[i - 1].y > target.y + 0.5 && Math.abs(p.x - tx) < Math.abs(land.x - tx)) land = p;
      }
      const miss = Math.abs(land.x - tx);
      if (!best || miss < best.miss) best = { angle, power, miss };
    }
  }
  return best;
}

/** The nearest living tank other than this one. */
export function nearest(g, tank) {
  return alive(g).filter((t) => t !== tank).sort((a, b) => Math.abs(a.x - tank.x) - Math.abs(b.x - tank.x))[0] ?? null;
}

const PERSONALITIES = { moron };

/** What this tank does this turn. Unknown kinds play as the Moron. */
export function decide(g, tank) {
  const play = PERSONALITIES[tank.kind] ?? moron;
  const d = play(g, tank);
  if (!WEAPONS[d.weapon] || (tank.inventory[d.weapon] ?? 0) <= 0) d.weapon = 'babyMissile';
  return d;
}

/**
 * Between rounds the computer shops. The Moron buys at random until it cannot afford the next
 * thing it points at, up to `picks` packs; the personalities of M3 will choose. Returns what was
 * bought, in order.
 */
export function shop(g, tank, rnd = g.rnd, picks = 3) {
  const bought = [];
  if (tank.kind === 'human') return bought;
  for (let i = 0; i < picks; i++) {
    const affordable = SHOP.filter((e) => tank.cash >= e.price);
    if (!affordable.length) break;
    const pick = affordable[Math.floor(rnd() * affordable.length)];
    if (buy(tank, pick.id)) bought.push(pick.id);
  }
  return bought;
}
