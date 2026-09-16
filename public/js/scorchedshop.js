// SCORCHED YARD, the roster and the shop (docs/PLAN-SCORCHED-YARD.md §4, §5). Data, and the
// arithmetic of buying. Prices, pack sizes and blast radii are Scorched Earth 1.5's, from the
// manual's weapons and accessories tables (SCORCH.DOC, read 2026-09-16 at abandonwaredos.com);
// a radius in the manual is pixels on a 640-wide screen, and a cell here is 640/96 of them, so
// every radius is the manual's over 6.67. Damage the manual does not number; ours grows with the
// radius. Anything found wrong against the manual is a one-line fix here and nowhere else.
//
// A weapon is a shell with a BEHAVIOUR (`kind`): what it does on impact, at its apex, on a bounce,
// every step -- or at once from the turret. The physics in scorched.js is shared; this table is
// the whole roster.
const cells = (px) => Math.round((px / 6.667) * 100) / 100;

export const WEAPONS = Object.freeze({
  // the blasts
  babyMissile: Object.freeze({ name: 'Baby Missile', kind: 'blast', radius: cells(10), damage: 30, price: 0, pack: 99, note: 'bottomless: you always have 99' }),
  missile: Object.freeze({ name: 'Missile', kind: 'blast', radius: cells(20), damage: 55, price: 1875, pack: 5 }),
  babyNuke: Object.freeze({ name: 'Baby Nuke', kind: 'blast', radius: cells(40), damage: 90, price: 10000, pack: 3 }),
  nuke: Object.freeze({ name: 'Nuke', kind: 'blast', radius: cells(75), damage: 130, price: 12000, pack: 1 }),
  // the ones that do something first
  leapfrog: Object.freeze({ name: 'Leap Frog', kind: 'leapfrog', radius: cells(20), radii: [cells(20), cells(25), cells(30)], damage: 55, hops: 3, price: 10000, pack: 2, note: 'three warheads, one after another, each bigger' }),
  funkyBomb: Object.freeze({ name: 'Funky Bomb', kind: 'funky', radius: cells(20), damage: 45, bomblets: 6, spread: cells(80), price: 7000, pack: 2, note: 'a multi-coloured chain reaction' }),
  mirv: Object.freeze({ name: 'MIRV', kind: 'mirv', radius: cells(20), damage: 55, heads: 5, price: 10000, pack: 3, note: 'five warheads, splitting at the apogee' }),
  deathsHead: Object.freeze({ name: "Death's Head", kind: 'mirv', radius: cells(35), damage: 90, heads: 9, price: 20000, pack: 1, note: 'nine large warheads, splitting at the apogee' }),
  napalm: Object.freeze({ name: 'Napalm', kind: 'napalm', radius: 0.5, damage: 4, drops: 12, steps: 40, price: 10000, pack: 10, note: 'splashes and bursts into flame that runs downhill' }),
  hotNapalm: Object.freeze({ name: 'Hot Napalm', kind: 'napalm', radius: 0.5, damage: 7, drops: 20, steps: 60, price: 20000, pack: 2, note: 'much hotter and more powerful' }),
  tracer: Object.freeze({ name: 'Tracer', kind: 'tracer', radius: 0, damage: 0, price: 10, pack: 20, note: 'no blast; shows the wind' }),
  smokeTracer: Object.freeze({ name: 'Smoke Tracer', kind: 'tracer', radius: 0, damage: 0, smoke: true, price: 500, pack: 10, note: 'a tracer with a coloured smoke trail' }),
  babyRoller: Object.freeze({ name: 'Baby Roller', kind: 'roller', radius: cells(10), damage: 30, price: 5000, pack: 10, note: 'rolls downhill until it meets a valley or a tank' }),
  roller: Object.freeze({ name: 'Roller', kind: 'roller', radius: cells(20), damage: 55, price: 6000, pack: 5, note: 'the same, with a stronger warhead' }),
  heavyRoller: Object.freeze({ name: 'Heavy Roller', kind: 'roller', radius: cells(45), damage: 95, price: 6750, pack: 2, note: 'more explosive than a Baby Nuke' }),
  // dirt, off and on
  riotCharge: Object.freeze({ name: 'Riot Charge', kind: 'wedge', dig: true, radius: cells(36), spread: 22, damage: 0, price: 2000, pack: 10, note: 'a wedge of dirt cut from the turret, at once' }),
  riotBlast: Object.freeze({ name: 'Riot Blast', kind: 'wedge', dig: true, radius: cells(60), spread: 32, damage: 0, price: 5000, pack: 5, note: 'a larger wedge, wider' }),
  riotBomb: Object.freeze({ name: 'Riot Bomb', kind: 'riot', radius: cells(30), damage: 0, price: 5000, pack: 5, note: 'a shell that clears a sphere of dirt and hurts no one' }),
  heavyRiotBomb: Object.freeze({ name: 'Heavy Riot Bomb', kind: 'riot', radius: cells(45), damage: 0, price: 4750, pack: 2 }),
  dirtClod: Object.freeze({ name: 'Dirt Clod', kind: 'dirt', radius: cells(20), damage: 0, price: 5000, pack: 10, note: 'a shell that bursts into a ball of dirt' }),
  dirtBall: Object.freeze({ name: 'Dirt Ball', kind: 'dirt', radius: cells(35), damage: 0, price: 5000, pack: 5 }),
  tonOfDirt: Object.freeze({ name: 'Ton of Dirt', kind: 'dirt', radius: cells(70), damage: 0, price: 6750, pack: 2, note: 'enough to bury a tank' }),
  liquidDirt: Object.freeze({ name: 'Liquid Dirt', kind: 'liquidDirt', radius: 0.5, damage: 0, drops: 16, steps: 50, price: 5000, pack: 10, note: 'oozes downhill and fills the holes' }),
  dirtCharge: Object.freeze({ name: 'Dirt Charge', kind: 'wedge', dig: false, radius: cells(40), spread: 26, damage: 0, price: 5000, pack: 5, note: 'a wedge of dirt thrown from the turret, at once' }),
  earthDisrupter: Object.freeze({ name: 'Earth Disrupter', kind: 'disrupter', radius: 0, damage: 0, price: 5000, pack: 10, note: 'every hanging piece of dirt on the field settles' }),
  // the diggers
  babyDigger: Object.freeze({ name: 'Baby Digger', kind: 'digger', radius: cells(8), damage: 20, bore: 6, price: 3000, pack: 10, note: 'tunnels straight down, a little' }),
  digger: Object.freeze({ name: 'Digger', kind: 'digger', radius: cells(10), damage: 30, bore: 10, price: 2500, pack: 5 }),
  heavyDigger: Object.freeze({ name: 'Heavy Digger', kind: 'digger', radius: cells(14), damage: 40, bore: 16, price: 6750, pack: 2 }),
  babySandhog: Object.freeze({ name: 'Baby Sandhog', kind: 'sandhog', radius: cells(8), damage: 30, bore: 8, price: 10000, pack: 10, note: 'burrows on under a shield and goes off there' }),
  sandhog: Object.freeze({ name: 'Sandhog', kind: 'sandhog', radius: cells(10), damage: 40, bore: 12, price: 16750, pack: 5 }),
  heavySandhog: Object.freeze({ name: 'Heavy Sandhog', kind: 'sandhog', radius: cells(16), damage: 60, bore: 20, price: 25000, pack: 2, note: 'can potentially destroy the world' }),
  // energy
  plasmaBlast: Object.freeze({ name: 'Plasma Blast', kind: 'plasma', radius: cells(75), minRadius: cells(10), damage: 90, price: 9000, pack: 5, note: 'radioactive energy thrown from the tank itself; the power sets its reach' }),
  laser: Object.freeze({ name: 'Laser', kind: 'laser', radius: 0.6, damage: 50, price: 5000, pack: 5, note: 'a high-intensity beam, cutting through at once' }),
});
export const WEAPON_ORDER = Object.freeze(Object.keys(WEAPONS));

export const ITEMS = Object.freeze({
  shield: Object.freeze({ name: 'Shield', kind: 'shield', hp: 60, price: 20000, pack: 3, note: 'absorbs 60 damage' }),
  forceShield: Object.freeze({ name: 'Force Shield', kind: 'shield', hp: 100, price: 25000, pack: 3, note: 'absorbs 100' }),
  heavyShield: Object.freeze({ name: 'Heavy Shield', kind: 'shield', hp: 150, price: 30000, pack: 2, note: 'absorbs 150' }),
  magDeflector: Object.freeze({ name: 'Mag Deflector', kind: 'passive', reach: 5, push: 30, price: 10000, pack: 2, note: 'pushes passing shells away' }),
  superMag: Object.freeze({ name: 'Super Mag', kind: 'passive', reach: 8, push: 60, price: 40000, pack: 2, note: 'pushes them away harder, from further' }),
  parachute: Object.freeze({ name: 'Parachute', kind: 'parachute', price: 10000, pack: 8, note: 'opens when you fall; one per fall' }),
  battery: Object.freeze({ name: 'Battery', kind: 'battery', heal: 30, price: 5000, pack: 10, note: 'restores 30 health, used on your turn' }),
  autoDefense: Object.freeze({ name: 'Auto Defense', kind: 'passive', price: 1500, pack: 1, note: 'raises a shield for you as your turn begins' }),
  fuel: Object.freeze({ name: 'Fuel Tank', kind: 'fuel', price: 10000, pack: 10, note: 'drive a cell per unit, A and D' }),
  contactTrigger: Object.freeze({ name: 'Contact Trigger', kind: 'arm', price: 1000, pack: 25, note: 'the shell goes off within reach of a tank, before it buries' }),
  heatGuidance: Object.freeze({ name: 'Heat Guidance', kind: 'arm', price: 10000, pack: 6, note: 'the shell bends toward the nearest tank as it falls' }),
});
export const ITEM_ORDER = Object.freeze(Object.keys(ITEMS));

export const START_INVENTORY = Object.freeze({ babyMissile: 99 });
export const START_ITEMS = Object.freeze({});
// the manual's default is $0 to start with 5% interest; ours starts with a little so the first
// shop has something to do (Display settings → Scorched Yard → Starting cash goes down to 0)
export const START_CASH = 10000;
export const CASH_PER_DAMAGE = 10;
export const KILL_BONUS = 2000;
export const SURVIVOR_BONUS = 1000;

/** Everything on sale, in the shop's order: the weapons, then the items. */
export const SHOP = Object.freeze([
  ...WEAPON_ORDER.filter((id) => WEAPONS[id].price > 0).map((id) => ({ id, item: false, ...WEAPONS[id] })),
  ...ITEM_ORDER.map((id) => ({ id, item: true, ...ITEMS[id] })),
]);

export const canBuy = (tank, entry) => tank.cash >= entry.price;

/**
 * Buy one pack. Returns false if the tank cannot afford it or the entry is unknown; the cash is
 * taken and the pack added otherwise.
 */
export function buy(tank, id) {
  const entry = SHOP.find((e) => e.id === id);
  if (!entry || !canBuy(tank, entry)) return false;
  tank.cash -= entry.price;
  const bag = entry.item ? tank.items : tank.inventory;
  bag[id] = (bag[id] ?? 0) + entry.pack;
  return true;
}

/** Interest on what is left, between rounds. */
export function payInterest(tank, rate) {
  const gain = Math.round(tank.cash * rate);
  tank.cash += gain;
  return gain;
}
