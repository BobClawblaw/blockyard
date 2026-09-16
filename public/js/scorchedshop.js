// SCORCHED YARD, the roster and the shop (docs/PLAN-SCORCHED-YARD.md §4, §5). Data, and the
// arithmetic of buying. Prices, pack sizes and effects follow Scorched Earth 1.5's defaults as
// remembered -- the original's SCORCH.DOC was not to hand when this was written, so any figure
// found wrong against it is a one-line fix here and nowhere else.
//
// A weapon is a shell with a BEHAVIOUR (`kind`): what it does on impact, at its apex, on a bounce,
// or every step. The physics in scorched.js is shared; this table is the whole roster.

export const WEAPONS = Object.freeze({
  // the blasts
  babyMissile: Object.freeze({ name: 'Baby Missile', kind: 'blast', radius: 1.5, damage: 30, price: 0, pack: 99, note: 'bottomless' }),
  missile: Object.freeze({ name: 'Missile', kind: 'blast', radius: 2.5, damage: 55, price: 1875, pack: 5 }),
  babyNuke: Object.freeze({ name: 'Baby Nuke', kind: 'blast', radius: 4, damage: 80, price: 10000, pack: 3 }),
  nuke: Object.freeze({ name: 'Nuke', kind: 'blast', radius: 6.5, damage: 100, price: 12000, pack: 1 }),
  deathsHead: Object.freeze({ name: "Death's Head", kind: 'blast', radius: 9, damage: 150, price: 20000, pack: 1 }),
  // the ones that do something first
  funkyBomb: Object.freeze({ name: 'Funky Bomb', kind: 'funky', radius: 2, damage: 45, bomblets: 6, price: 7000, pack: 2, note: 'bursts into six bomblets' }),
  mirv: Object.freeze({ name: 'MIRV', kind: 'mirv', radius: 2.5, damage: 55, heads: 5, price: 10000, pack: 3, note: 'splits into five at its apex' }),
  leapfrog: Object.freeze({ name: 'Leapfrog', kind: 'leapfrog', radius: 2.5, damage: 55, hops: 3, price: 10000, pack: 2, note: 'explodes three times, bouncing on' }),
  tracer: Object.freeze({ name: 'Tracer', kind: 'tracer', radius: 0, damage: 0, price: 10, pack: 20, note: 'no blast; shows the wind' }),
  smokeTracer: Object.freeze({ name: 'Smoke Tracer', kind: 'tracer', radius: 0, damage: 0, smoke: true, price: 500, pack: 10, note: 'a tracer that leaves smoke' }),
  roller: Object.freeze({ name: 'Roller', kind: 'roller', radius: 2.5, damage: 55, price: 6000, pack: 5, note: 'rolls downhill to a tank or a dip' }),
  heavyRoller: Object.freeze({ name: 'Heavy Roller', kind: 'roller', radius: 4, damage: 80, price: 6750, pack: 2 }),
  // dirt, off and on
  riotCharge: Object.freeze({ name: 'Riot Charge', kind: 'riot', radius: 3, damage: 0, price: 2000, pack: 10, note: 'clears dirt, hurts no one' }),
  riotBlast: Object.freeze({ name: 'Riot Blast', kind: 'riot', radius: 5, damage: 0, price: 5000, pack: 5 }),
  riotBomb: Object.freeze({ name: 'Riot Bomb', kind: 'riot', radius: 7, damage: 0, price: 5000, pack: 5 }),
  dirtClod: Object.freeze({ name: 'Dirt Clod', kind: 'dirt', radius: 2, damage: 0, price: 5000, pack: 10, note: 'adds a ball of dirt' }),
  dirtBall: Object.freeze({ name: 'Dirt Ball', kind: 'dirt', radius: 4, damage: 0, price: 5000, pack: 5 }),
  tonOfDirt: Object.freeze({ name: 'Ton of Dirt', kind: 'dirt', radius: 7, damage: 0, price: 6750, pack: 1 }),
  // fire, and the diggers
  napalm: Object.freeze({ name: 'Napalm', kind: 'napalm', radius: 0.5, damage: 4, drops: 12, steps: 40, price: 10000, pack: 10, note: 'flows downhill and burns' }),
  hotNapalm: Object.freeze({ name: 'Hot Napalm', kind: 'napalm', radius: 0.5, damage: 7, drops: 20, steps: 60, price: 20000, pack: 2 }),
  babyDigger: Object.freeze({ name: 'Baby Digger', kind: 'digger', radius: 1, damage: 20, bore: 6, price: 3000, pack: 10, note: 'digs straight down' }),
  digger: Object.freeze({ name: 'Digger', kind: 'digger', radius: 1.5, damage: 30, bore: 10, price: 3750, pack: 5 }),
  heavyDigger: Object.freeze({ name: 'Heavy Digger', kind: 'digger', radius: 2, damage: 40, bore: 16, price: 6750, pack: 2 }),
  sandhog: Object.freeze({ name: 'Sandhog', kind: 'sandhog', radius: 1.5, damage: 40, bore: 12, price: 16750, pack: 5, note: 'tunnels on along its heading' }),
  heavySandhog: Object.freeze({ name: 'Heavy Sandhog', kind: 'sandhog', radius: 2.5, damage: 60, bore: 20, price: 25000, pack: 2 }),
  laser: Object.freeze({ name: 'Laser', kind: 'laser', radius: 0.6, damage: 50, price: 15000, pack: 5, note: 'a straight line, at once' }),
});
export const WEAPON_ORDER = Object.freeze(Object.keys(WEAPONS));

export const ITEMS = Object.freeze({
  shield: Object.freeze({ name: 'Shield', kind: 'shield', hp: 60, price: 20000, pack: 3, note: 'absorbs 60 damage' }),
  deflector: Object.freeze({ name: 'Deflector Shield', kind: 'shield', hp: 60, deflect: true, price: 25000, pack: 1, note: 'absorbs 60 and bounces shells off' }),
  force: Object.freeze({ name: 'Force Shield', kind: 'shield', hp: 100, deflect: true, price: 30000, pack: 1, note: 'absorbs 100 and bounces shells off' }),
  parachute: Object.freeze({ name: 'Parachute', kind: 'parachute', price: 10000, pack: 3, note: 'opens when you fall; one per fall' }),
  battery: Object.freeze({ name: 'Battery', kind: 'battery', heal: 30, price: 5000, pack: 5, note: 'restores 30 health, used on your turn' }),
  magDeflector: Object.freeze({ name: 'Mag Deflector', kind: 'passive', price: 12000, pack: 2, note: 'pushes passing shells away' }),
  autoDefense: Object.freeze({ name: 'Auto Defense', kind: 'passive', price: 15000, pack: 1, note: 'raises a shield for you as your turn begins' }),
  fuel: Object.freeze({ name: 'Fuel', kind: 'fuel', price: 10000, pack: 10, note: 'drive a cell per unit, A and D' }),
  contactTrigger: Object.freeze({ name: 'Contact Trigger', kind: 'arm', price: 10000, pack: 5, note: 'the shell goes off within reach of a tank, before it buries' }),
  heatGuidance: Object.freeze({ name: 'Heat Guidance', kind: 'arm', price: 10000, pack: 3, note: 'the shell bends toward the nearest tank as it falls' }),
});
export const ITEM_ORDER = Object.freeze(Object.keys(ITEMS));

export const START_INVENTORY = Object.freeze({ babyMissile: 99 });
export const START_ITEMS = Object.freeze({});
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
