// BLOCKMAN, THE RULES (docs/PLAN-BLOCKMAN.md, M2). No DOM, no canvas, no timers of its own: a
// state object and `stepGame(g, dtMs)`, so every rule in the genre can be held by a test that plays
// the game rather than by looking at it.
//
// WHAT IS REIMPLEMENTED HERE, AND WHY IT IS OURS TO REIMPLEMENT (§1). The mechanics of a maze chase
// are not anybody's property: clearing a maze of dots, a power-up that reverses the chase, a
// wrap-around tunnel, a pen the pursuers leave on a schedule, cornering, and the eat penalty that
// makes a full corridor slower than a cleared one. What belongs to the 1980 game's publisher is its
// expression -- the maze, the characters, the sounds, the name -- and none of that is in this file.
//
// Positions are in TILES, fractional, measured at tile centres: a tile (x, y) has its centre at
// (x + 0.5, y + 0.5). Speeds are tiles a second. The level tables are ours, tuned by play.
import { parseMaze, OPEN } from './blockmanmaze.js';

export const DIRS = Object.freeze({
  left: Object.freeze({ x: -1, y: 0 }), right: Object.freeze({ x: 1, y: 0 }),
  up: Object.freeze({ x: 0, y: -1 }), down: Object.freeze({ x: 0, y: 1 }),
});
const DIR_LIST = Object.freeze([DIRS.up, DIRS.left, DIRS.down, DIRS.right]);   // the genre's tie-break order

export const SCORE = Object.freeze({ dot: 10, pellet: 50, pursuer: [200, 400, 800, 1600], extraLifeAt: 10_000 });
export const LIVES = 3;

// A TURN MAY BE TAKEN EARLY, AND THAT IS THE GENRE'S FEEL: "cornering" lets a turn pressed before a
// junction cut the corner, which is how a player outruns a pursuer that takes the same corner square.
// Measured against the original's own behaviour as described publicly: about half a tile of grace.
export const CORNER = 0.5;
// Eating a dot costs a frame or two, so a corridor full of dots is slower than a cleared one.
export const EAT_PENALTY_MS = 25;
const CONTACT = 0.7;                 // tiles: how close a pursuer has to be to catch BlockMan
const READY_MS = 1600, DYING_MS = 1300, LEVEL_MS = 1400;

/** Our own speed table: level 1 gentle, level 5 onward full pace. Tiles a second. */
export function speedsFor(level, difficulty = 1) {
  const k = Math.min(1, 0.8 + (level - 1) * 0.05) * (Number.isFinite(difficulty) ? Math.max(0.6, Math.min(1.4, difficulty)) : 1);
  // `eaten` is the walk home, and it is fast: a pair of eyes crossing the maze is not a threat, and
  // watching it trundle back at chase speed is dead time in a game of seconds.
  return { man: 9.4 * k, pursuer: 8.8 * k, tunnel: 5.4 * k, frightened: 5.8 * k, eaten: 16 };
}

// THE FRUIT (M4). Twice a level, at these dot counts, for this long, worth this much: ours, in the
// genre's shape -- a reason to leave the safe corner twice a level, and the score that makes a
// dangerous run worth it. The colours are the board's own.
export const FRUIT_AT = Object.freeze([70, 170]);
export const FRUIT_MS = 9500;
export const FRUIT = Object.freeze([
  Object.freeze({ level: 1, points: 100, colour: '#ff5c7a' }),
  Object.freeze({ level: 2, points: 300, colour: '#ff9f43' }),
  Object.freeze({ level: 3, points: 500, colour: '#ffd23f' }),
  Object.freeze({ level: 5, points: 700, colour: '#6ce5b1' }),
  Object.freeze({ level: 7, points: 1000, colour: '#46d7e4' }),
  Object.freeze({ level: 9, points: 2000, colour: '#c78bff' }),
  Object.freeze({ level: 11, points: 3000, colour: '#ff8ccf' }),
  Object.freeze({ level: 13, points: 5000, colour: '#f2f6ff' }),
]);

/** What a fruit is worth at this level: the last entry the level has reached. */
export function fruitFor(level) {
  let out = FRUIT[0];
  for (const f of FRUIT) if (level >= f.level) out = f;
  return out;
}

const key = (x, y) => `${x},${y}`;
const tileOf = (a) => ({ x: Math.floor(a.x), y: Math.floor(a.y) });
const centred = (a, tol = 0.08) => Math.abs(a.x - (Math.floor(a.x) + 0.5)) < tol && Math.abs(a.y - (Math.floor(a.y) + 0.5)) < tol;

// THE WAVES (M3). Scatter, then chase, alternating; the scatter periods shorten by level until the
// chase is permanent. Ours, in the shape the genre uses: the numbers are what makes level 1 a
// stroll and level 15 a hunt, and they are tuned by play rather than copied.
export function wavesFor(level) {
  const k = Math.max(0.25, 1 - (level - 1) * 0.06);
  return Object.freeze([
    { mode: 'scatter', ms: Math.round(7000 * k) },
    { mode: 'chase', ms: 20_000 },
    { mode: 'scatter', ms: Math.round(7000 * k) },
    { mode: 'chase', ms: 20_000 },
    { mode: 'scatter', ms: Math.round(5000 * k) },
    { mode: 'chase', ms: 20_000 },
    { mode: 'scatter', ms: Math.round(5000 * k) },
    { mode: 'chase', ms: Infinity },
  ]);
}

// CHASER SPEEDS UP AS THE BOARD EMPTIES, in two steps: the genre's "cruise" behaviour, and the
// reason a nearly-clear level is frantic rather than a victory lap.
export const ELROY = Object.freeze([{ left: 20, gain: 1.05 }, { left: 10, gain: 1.11 }]);

// WHEN EACH ONE LEAVES THE PEN: its own dot counter, and a timer in case BlockMan stops eating.
export const PEN_DOTS = Object.freeze({ chaser: 0, ambusher: 0, flanker: 30, wanderer: 60 });
export const PEN_IDLE_MS = 4000;

/** The four pursuers: their names, colours and scatter corners. */
export const PURSUERS = Object.freeze([
  Object.freeze({ id: 'chaser', name: 'Chaser', colour: '#ef4b4b', corner: { x: 26, y: 1 } }),
  Object.freeze({ id: 'ambusher', name: 'Ambusher', colour: '#ff8ccf', corner: { x: 1, y: 1 } }),
  Object.freeze({ id: 'flanker', name: 'Flanker', colour: '#46d7e4', corner: { x: 26, y: 26 } }),
  Object.freeze({ id: 'wanderer', name: 'Wanderer', colour: '#ffa63d', corner: { x: 1, y: 26 } }),
]);

/** A new game. `maze` is parsed once and shared; the dots are this game's own. */
export function newGame({ level = 1, lives = LIVES, maze = parseMaze(), seed = 1, difficulty = 1, auto = false } = {}) {
  const g = {
    maze, level, lives, startLives: lives, score: 0, phase: 'ready', phaseMs: READY_MS,
    difficulty, auto,
    dots: new Set(maze.dots.map((d) => key(d.x, d.y))),
    pellets: new Set(maze.pellets.map((d) => key(d.x, d.y))),
    eaten: 0, chain: 0, frightenedMs: 0, events: [],
    fruit: null, fruitShown: 0,
    rnd: rng(seed), speeds: speedsFor(level, difficulty),
    man: null, pursuers: [],
  };
  place(g);
  return g;
}

function rng(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
}

/** Everyone back to their starting tile: a new level, and a life lost. */
export function place(g) {
  const m = g.maze;
  g.man = { x: m.start.x, y: m.start.y + 0.5, dir: DIRS.left, want: null, stopped: false, eatMs: 0 };
  // WHERE THEY START, AND IT HAS TO BE A TILE THEY MAY STAND ON (2026-09-17). The first cut put
  // Chaser at the door's height minus a tile and a half, which is the wall beside the shaft: it
  // began every level inside a wall and walked out through it. Chaser starts in the shaft above the
  // pen, the other three inside the pen, all of which are theirs to cross (gridG).
  const shaftTop = m.exit.length ? Math.min(...m.exit.map((t) => t.y)) : m.door.y - 2;
  const penRow = m.door.y + 1;
  const seats = [
    { x: m.door.x, y: shaftTop + 0.5 },
    { x: m.door.x, y: penRow + 0.5 },
    { x: m.door.x - 1.5, y: penRow + 0.5 },
    { x: m.door.x + 1.5, y: penRow + 0.5 },
  ];
  g.pursuers = PURSUERS.map((p, i) => ({
    ...p,
    x: seats[i].x, y: seats[i].y,
    dir: i === 0 ? DIRS.left : (i % 2 ? DIRS.right : DIRS.left),
    // Chaser starts outside; the others wait for their dot counter (PEN_DOTS) or the idle timer
    state: PEN_DOTS[p.id] === 0 && i === 0 ? 'scatter' : 'pen',
    patrol: i, frightenedLeftMs: 0, penMs: 0, target: null,
  }));
  g.wave = 0; g.waveMs = wavesFor(g.level)[0].ms; g.mode = 'scatter'; g.sinceDotMs = 0;
}

const free = (m, x, y) => m.at(((x % m.w) + m.w) % m.w, y) === OPEN;
// A PURSUER'S OWN IDEA OF FREE: the pen and its gate are open to it and solid to him
// (blockmanmaze.js keeps the second grid). Chaser began level one inside the wall beside the shaft
// before this existed, and walked out through it.
const freeG = (m, x, y) => m.atG(((x % m.w) + m.w) % m.w, y) === OPEN;
const wrap = (m, a) => { if (a.x < 0) a.x += m.w; else if (a.x >= m.w) a.x -= m.w; };
const opposite = (a, b) => a && b && a.x === -b.x && a.y === -b.y;

/** The ways out of a tile, in the genre's tie-break order, never straight back. */
export function exitsFrom(m, tile, dir, { noUp = null, ghost = false } = {}) {
  const banUp = noUp?.has?.(key(tile.x, tile.y));
  const open = ghost ? freeG : free;                 // `ghost` is a pursuer: the pen is its own
  return DIR_LIST.filter((d) => {
    if (opposite(d, dir)) return false;
    if (banUp && d === DIRS.up) return false;
    return open(m, tile.x + d.x, tile.y + d.y);
  });
}

/**
 * One frame. `dtMs` is the frame's own length, so the game runs at the same pace whatever the
 * display does. Events (a dot eaten, a life lost, a level cleared) are pushed onto `g.events` for
 * the screen to draw and the sound to play; the caller drains them.
 */
export function stepGame(g, dtMs, { input = null } = {}) {
  if (input) g.man.want = input;
  if (g.auto && g.phase === 'play') g.man.want = autoTurn(g) ?? g.man.want;
  const dt = Math.max(0, Math.min(60, dtMs));
  if (g.phase === 'ready' || g.phase === 'dying' || g.phase === 'level') {
    g.phaseMs -= dt;
    if (g.phaseMs > 0) return g;
    if (g.phase === 'ready') g.phase = 'play';
    else if (g.phase === 'dying') {
      if (g.lives <= 0) { g.phase = 'over'; g.events.push({ kind: 'over' }); }
      else { place(g); g.phase = 'ready'; g.phaseMs = READY_MS; }
    } else if (g.phase === 'level') nextLevel(g);
    return g;
  }
  if (g.phase !== 'play') return g;

  if (g.frightenedMs > 0) {
    g.frightenedMs = Math.max(0, g.frightenedMs - dt);
    for (const p of g.pursuers) {
      if (p.state === 'frightened') {
        p.frightenedLeftMs = g.frightenedMs;
        if (!g.frightenedMs) { p.state = g.mode; g.chain = 0; }
      }
    }
  }
  waves(g, dt);
  g.sinceDotMs = (g.sinceDotMs ?? 0) + dt;
  fruitClock(g, dt);
  moveMan(g, dt);
  for (const p of g.pursuers) movePursuer(g, p, dt);
  contact(g);
  if (!g.dots.size && !g.pellets.size) {
    g.phase = 'level'; g.phaseMs = LEVEL_MS;
    g.events.push({ kind: 'level', level: g.level });
  }
  return g;
}

/**
 * A QUEUED TURN, TAKEN EARLY (cornering): a perpendicular way that is free may be taken while still
 * within CORNER of the tile's centre, and the off-axis coordinate snaps to that centre. A reversal
 * is always legal, wherever he is. Returns true if the way changed.
 */
function tryTurn(g, man) {
  const m = g.maze, d = man.want;
  if (!d) return false;
  if (opposite(d, man.dir)) { man.dir = d; man.want = null; return true; }
  const tile = tileOf(man);
  const along = d.x ? Math.abs(man.y - (tile.y + 0.5)) : Math.abs(man.x - (tile.x + 0.5));
  if (!free(m, tile.x + d.x, tile.y + d.y) || along > CORNER) return false;
  man.dir = d; man.want = null;
  if (d.x) man.y = tile.y + 0.5; else man.x = tile.x + 0.5;
  return true;
}

/**
 * SCATTER AND CHASE (M3). The wave runs the clock only while they are chasing: a pellet's fright
 * pauses it, as the genre does, so a long fright does not eat a whole chase. On a change of wave
 * every pursuer outside the pen turns round where it stands -- that reversal is the tell that the
 * wave changed, and it is what gives a player the moment to escape a corner.
 */
function waves(g, dt) {
  if (g.frightenedMs > 0) return;
  const table = wavesFor(g.level);
  const w = table[Math.min(g.wave, table.length - 1)];
  g.waveMs -= dt;
  if (g.waveMs > 0) { g.mode = w.mode; return; }
  g.wave = Math.min(g.wave + 1, table.length - 1);
  const next = table[g.wave];
  g.mode = next.mode;
  g.waveMs = next.ms;
  for (const p of g.pursuers) {
    if (p.state === 'pen' || p.state === 'eaten' || p.state === 'frightened') continue;
    p.state = next.mode;
    p.dir = { x: -p.dir.x, y: -p.dir.y };
    p.turnedBy = 'wave'; p.justReversed = true;
  }
  g.events.push({ kind: 'wave', mode: next.mode, wave: g.wave });
}

/**
 * WHERE EACH ONE IS HEADED. One rule each, and the whole difference between them (§4):
 *   Chaser    straight at BlockMan's tile.
 *   Ambusher  four tiles ahead of him, the way he is facing.
 *   Flanker   the point twice as far as Chaser's line through two tiles ahead of him: it comes
 *             round the other side, and it is the one that traps a player in a corridor.
 *   Wanderer  at him while more than eight tiles away, to its own corner once closer -- so it
 *             drifts off exactly when it would have been dangerous.
 * Scattering, each heads for its own corner. Frightened, it has no target and wanders.
 */
export function targetFor(g, p) {
  const man = g.man, tile = tileOf(man);
  if (p.state === 'scatter') return { ...p.corner };
  if (p.state === 'eaten') return { x: Math.floor(g.maze.door.x), y: g.maze.door.y + 1 };
  if (p.state === 'frightened' || p.state === 'pen') return null;
  const ahead = (n) => ({ x: tile.x + man.dir.x * n, y: tile.y + man.dir.y * n });
  if (p.id === 'chaser') return { ...tile };
  if (p.id === 'ambusher') return ahead(4);
  if (p.id === 'flanker') {
    const a = ahead(2), chaser = g.pursuers.find((q) => q.id === 'chaser');
    const c = chaser ? tileOf(chaser) : { ...tile };
    return { x: a.x * 2 - c.x, y: a.y * 2 - c.y };
  }
  // Wanderer
  const dx = tile.x - Math.floor(p.x), dy = tile.y - Math.floor(p.y);
  return Math.hypot(dx, dy) > 8 ? { ...tile } : { ...p.corner };
}

/** The exit that ends up nearest the target, ties broken up, left, down, right (exitsFrom's order). */
export function chooseExit(m, tile, dir, target, opts = {}) {
  const exits = exitsFrom(m, tile, dir, opts);
  if (!exits.length) return null;
  if (!target) return exits[0];
  let best = null, bestD = Infinity;
  for (const d of exits) {
    const nx = tile.x + d.x, ny = tile.y + d.y;
    // the tunnel wraps, so the near way round is the one that counts
    const ddx = Math.min(Math.abs(target.x - nx), m.w - Math.abs(target.x - nx));
    const dd = ddx * ddx + (target.y - ny) * (target.y - ny);
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
}

/**
 * THE FRUIT APPEARS TWICE A LEVEL, at FRUIT_AT dots eaten, and keeps for FRUIT_MS. It sits on the
 * corridor below the pen -- reachable from anywhere, and exactly where the pursuers come out, which
 * is what makes going for it a decision rather than a free hundred points.
 */
/** Where the fruit sits: the first corridor tile below the pen, and never where he respawns. */
export function fruitTile(m) {
  const x = Math.floor(m.door.x);
  for (let y = m.door.y + 2; y < m.h - 1; y++) {
    if (m.at(x, y) !== OPEN) continue;
    if (Math.abs(y - m.start.y) < 1) continue;          // his own tile is not a shop window
    return { x, y };
  }
  return { x, y: Math.floor(m.start.y) - 2 };
}

function fruitClock(g, dt) {
  if (g.fruit) {
    g.fruit.leftMs -= dt;
    if (g.fruit.leftMs <= 0) { g.events.push({ kind: 'fruitGone' }); g.fruit = null; }
    return;
  }
  const next = FRUIT_AT[g.fruitShown];
  if (next == null || g.eaten < next) return;
  const f = fruitFor(g.level);
  const m = g.maze;
  // NOT ON HIS RESPAWN TILE (2026-09-17): the first cut put the fruit where he starts, so being
  // caught handed him a free fruit on the way back in. It sits on the corridor just below the pen.
  g.fruit = { ...fruitTile(m), points: f.points, colour: f.colour, leftMs: FRUIT_MS };
  g.fruitShown += 1;
  g.events.push({ kind: 'fruit', points: f.points, x: g.fruit.x, y: g.fruit.y });
}

function moveMan(g, dt) {
  const m = g.maze, man = g.man;
  // THE TILE HE IS ON IS EATEN WHETHER HE MOVES OR NOT. The first cut ate only after a step, so a
  // dot under a BlockMan stopped against a wall stayed there for ever (found by a test that put him
  // on a pellet in a dead end: score 0).
  eat(g, tileOf(man));
  // A QUEUED TURN IS TAKEN EVEN ON THE FRAME A DOT IS EATEN. The first cut returned from the eat
  // penalty before looking at the input, so a turn pressed while crossing a dot -- which is most of
  // them -- was dropped, and the corner was missed (found by the cornering test on a dotted tile).
  tryTurn(g, man);
  if (man.eatMs > 0) { man.eatMs = Math.max(0, man.eatMs - dt); return; }   // the eat penalty
  let left = g.speeds.man * dt / 1000;
  while (left > 1e-6) {
    const step = Math.min(left, 0.25);
    const tile = tileOf(man);
    tryTurn(g, man);
    const nx = man.x + man.dir.x * step, ny = man.y + man.dir.y * step;
    const ahead = { x: tile.x + man.dir.x, y: tile.y + man.dir.y };
    const pastCentre = man.dir.x ? (man.dir.x > 0 ? nx > tile.x + 0.5 : nx < tile.x + 0.5) : (man.dir.y > 0 ? ny > tile.y + 0.5 : ny < tile.y + 0.5);
    if (!free(m, ahead.x, ahead.y) && pastCentre) {
      man.x = tile.x + 0.5; man.y = tile.y + 0.5; man.stopped = true;      // a wall: stop at the centre
      break;
    }
    man.stopped = false;
    man.x = nx; man.y = ny;
    wrap(m, man);
    eat(g, tileOf(man));
    if (man.eatMs > 0) break;
    left -= step;
  }
}

function eat(g, tile) {
  const k = key(tile.x, tile.y);
  if (g.fruit && g.fruit.x === tile.x && Math.abs(g.fruit.y - (tile.y + 0.5)) < 1) {
    g.score += g.fruit.points;
    g.events.push({ kind: 'ateFruit', points: g.fruit.points, x: tile.x, y: tile.y });
    g.fruit = null;
    extraLife(g);
  }
  if (g.dots.delete(k)) {
    g.score += SCORE.dot;
    g.eaten += 1;
    g.sinceDotMs = 0;
    g.man.eatMs = EAT_PENALTY_MS;
    g.events.push({ kind: 'dot', x: tile.x, y: tile.y, left: g.dots.size + g.pellets.size });
    extraLife(g);
    return;
  }
  if (g.pellets.delete(k)) {
    g.score += SCORE.pellet;
    g.eaten += 1;
    g.sinceDotMs = 0;
    g.chain = 0;
    g.frightenedMs = frightenedMsFor(g.level);
    for (const p of g.pursuers) {
      if (p.state === 'chase' || p.state === 'scatter' || p.state === 'frightened') {   // never 'eaten'
        p.state = 'frightened';
        p.frightenedLeftMs = g.frightenedMs;
        p.dir = { x: -p.dir.x, y: -p.dir.y };                 // a pellet turns them round
        p.turnedBy = 'pellet'; p.justReversed = true;        // and says so, for the tests
      }
    }
    g.events.push({ kind: 'pellet', x: tile.x, y: tile.y, ms: g.frightenedMs });
    extraLife(g);
  }
}

/** How long a pellet frightens them, by level: it shortens, and by level 19 a pellet only scores. */
export function frightenedMsFor(level) {
  if (level >= 19) return 0;
  return Math.max(1000, Math.round(7000 - (level - 1) * 340));
}

function extraLife(g) {
  if (!g.gaveLife && g.score >= SCORE.extraLifeAt) {
    g.gaveLife = true; g.lives += 1;
    g.events.push({ kind: 'life', lives: g.lives });
  }
}

// EACH ONE WALKS TOWARD ITS OWN TARGET (M3). At a tile centre it takes the exit that ends up
// nearest the target, never straight back, and never upward on the marked tiles above the pen.
// Frightened, it has no target and picks at random. The patrol of M2 is gone.
function movePursuer(g, p, dt) {
  const m = g.maze;
  if (p.state === 'pen') {
    p.penMs = (p.penMs ?? 0) + dt;
    if (penReleased(g, p)) {
      p.state = g.mode; p.x = m.door.x; p.y = m.door.y + 0.5; p.dir = DIRS.up; p.penMs = 0;
      p.rejoin = false;
      g.events.push({ kind: 'out', who: p.id });
    }
    return;
  }
  p.target = targetFor(g, p);
  if (p.state === 'eaten' && atHome(m, p)) {
    // home: it waits a moment inside the pen and comes straight back out, whatever the counters say
    p.state = 'pen'; p.penMs = 0; p.rejoin = true;
    p.x = m.door.x; p.y = m.door.y + 1.5; p.dir = DIRS.up;
    g.events.push({ kind: 'home', who: p.id });
    return;
  }
  const speed = p.state === 'eaten' ? g.speeds.eaten
    : p.state === 'frightened' ? g.speeds.frightened
    : (inTunnel(m, p) ? g.speeds.tunnel : g.speeds.pursuer * elroyGain(g, p));
  let left = speed * dt / 1000;
  let guard = 0;
  // IT STOPS ON EVERY TILE CENTRE AND DECIDES THERE. The first cut stepped a quarter-tile at a time
  // and tested "am I near a centre", so at speed a junction could pass between two samples: an
  // Ambusher rose out of the shaft and walked into the wall above it, because the corridor it should
  // have turned into was never sampled. Now the step is cut short at the next centre, always.
  while (left > 1e-6 && guard++ < 64) {
    // THE WAY AHEAD IS CHECKED BEFORE MOVING, NOT ONLY AT CENTRES. A direction that points into a
    // wall -- after a reversal into a dead end, or whatever the caller set -- used to be walked
    // along regardless, and a pursuer ended up inside the border (found at tile 1,0).
    const at = { x: Math.floor(p.x), y: Math.floor(p.y) };
    if (!freeG(m, at.x + p.dir.x, at.y + p.dir.y)) {
      p.x = at.x + 0.5; p.y = at.y + 0.5;
      const noUp0 = g.noUpSet ?? (g.noUpSet = new Set(m.noUp.map((t) => key(t.x, t.y))));
      const pick0 = p.state === 'eaten'
        ? (stepHome(m, at, p.dir) ?? chooseExit(m, at, p.dir, p.target, { noUp: noUp0, ghost: true }))
        : chooseExit(m, at, p.dir, p.target, { noUp: noUp0, ghost: true });
      const back = { x: -p.dir.x, y: -p.dir.y };
      p.dir = pick0 ?? (freeG(m, at.x + back.x, at.y + back.y) ? back : p.dir);
      p.justReversed = false;
      if (!freeG(m, at.x + p.dir.x, at.y + p.dir.y)) break;      // walled in: stay put
    }
    const centre = { x: nextCentre(p.x, p.dir.x), y: nextCentre(p.y, p.dir.y) };
    const dist = Math.abs(p.dir.x ? centre.x - p.x : centre.y - p.y);
    const step = Math.min(left, dist);
    p.x += p.dir.x * step; p.y += p.dir.y * step;
    wrap(m, p);
    left -= step;
    if (step < dist - 1e-9) break;                       // short of the centre: next frame decides
    // on the centre: which way now
    const tile = { x: Math.floor(p.x), y: Math.floor(p.y) };
    p.x = tile.x + 0.5; p.y = tile.y + 0.5;
    if (p.justReversed) { p.justReversed = false; continue; }
    const noUp = g.noUpSet ?? (g.noUpSet = new Set(m.noUp.map((t) => key(t.x, t.y))));
    const how = { noUp, ghost: true };
    const pick = p.state === 'frightened'
      ? (() => { const es = exitsFrom(m, tile, p.dir, how); return es.length ? es[Math.floor(g.rnd() * es.length)] : null; })()
      : p.state === 'eaten'
        ? (stepHome(m, tile, p.dir) ?? chooseExit(m, tile, p.dir, p.target, how))
        : chooseExit(m, tile, p.dir, p.target, how);
    p.dir = pick ?? { x: -p.dir.x, y: -p.dir.y };        // a dead end: turn round
  }
}

/** The next tile centre along one axis, in the direction `d` (0 leaves the coordinate alone). */
export function nextCentre(pos, d) {
  if (!d) return pos;
  const here = Math.floor(pos) + 0.5;
  if (d > 0) return here > pos + 1e-9 ? here : here + 1;
  return here < pos - 1e-9 ? here : here - 1;
}

/**
 * THE WALK HOME FOLLOWS A DISTANCE FIELD, NOT THE GREEDY RULE (2026-09-17, M4). Choosing the exit
 * nearest the target is right for a hunt and wrong for a journey: a pair of eyes in the top corridor
 * flip-flopped between two tiles for ever, because both were equally far from the pen and neither
 * was a way down. So the distance to the pen's door is measured once per maze, by flood fill over
 * the pursuers' own grid, and an eaten pursuer simply steps downhill. It always arrives.
 */
export function homeField(m) {
  if (m.__home) return m.__home;
  const d = new Int32Array(m.w * m.h).fill(-1);
  const door = { x: Math.floor(m.door.x), y: m.door.y + 1 };
  const q = [door];
  d[door.y * m.w + door.x] = 0;
  while (q.length) {
    const { x, y } = q.shift();
    const here = d[y * m.w + x];
    for (const dir of DIR_LIST) {
      const nx = ((x + dir.x) % m.w + m.w) % m.w, ny = y + dir.y;
      if (ny < 0 || ny >= m.h) continue;
      if (m.atG(nx, ny) !== OPEN || d[ny * m.w + nx] >= 0) continue;
      d[ny * m.w + nx] = here + 1;
      q.push({ x: nx, y: ny });
    }
  }
  m.__home = d;
  return d;
}

/** The step an eaten pursuer takes from this tile: downhill on the distance field. */
export function stepHome(m, tile, dir) {
  const d = homeField(m);
  const here = d[tile.y * m.w + tile.x];
  let best = null, bestD = here < 0 ? Infinity : here;
  for (const cand of exitsFrom(m, tile, dir, { ghost: true })) {
    const nx = ((tile.x + cand.x) % m.w + m.w) % m.w, ny = tile.y + cand.y;
    if (ny < 0 || ny >= m.h) continue;
    const dd = d[ny * m.w + nx];
    if (dd >= 0 && dd < bestD) { bestD = dd; best = cand; }
  }
  return best;
}

/** True once an eaten pursuer has reached the pen's door on its way home. */
export function atHome(m, p) {
  return Math.abs(p.x - m.door.x) < 0.6 && Math.abs(p.y - (m.door.y + 1)) < 1.1;
}

/**
 * Out of the pen when its own dot counter is met, or BlockMan has stopped eating for long enough --
 * and at once (after a moment's pause) for one that has just been eaten and walked home, whose
 * counter is long past.
 */
export const REJOIN_MS = 900;
export function penReleased(g, p) {
  if (p.rejoin) return (p.penMs ?? 0) >= REJOIN_MS;
  if (g.eaten >= (PEN_DOTS[p.id] ?? 0)) return true;
  return g.sinceDotMs >= PEN_IDLE_MS;
}

/** Chaser's two speed steps, as the board empties (ELROY). One tenth faster at the end is plenty. */
export function elroyGain(g, p) {
  if (p.id !== 'chaser') return 1;
  const left = g.dots.size + g.pellets.size;
  let gain = 1;
  for (const step of ELROY) if (left <= step.left) gain = step.gain;
  return gain;
}

const inTunnel = (m, a) => m.tunnels.some((t) => t.y === Math.floor(a.y) && Math.abs(t.x - Math.floor(a.x)) < 1);

function contact(g) {
  for (const p of g.pursuers) {
    if (p.state === 'pen' || p.state === 'eaten') continue;
    if (Math.abs(p.x - g.man.x) + Math.abs(p.y - g.man.y) > CONTACT) continue;
    if (p.state === 'frightened') {
      // IT WALKS HOME AS A PAIR OF EYES (M4). Being eaten does not put it back in the pen: it has to
      // cross the maze to the pen's door at eye speed, which is the window a player has bought.
      g.chain = Math.min(g.chain + 1, SCORE.pursuer.length);
      const pts = SCORE.pursuer[g.chain - 1];
      g.score += pts;
      p.state = 'eaten'; p.frightenedLeftMs = 0; p.penMs = 0;
      g.events.push({ kind: 'ate', who: p.id, points: pts, x: p.x, y: p.y });
      extraLife(g);
      continue;
    }
    g.lives -= 1;
    g.phase = 'dying'; g.phaseMs = DYING_MS;
    g.events.push({ kind: 'caught', who: p.id, lives: g.lives });
    return;
  }
}

/** The next level: the same maze, filled again, and everyone faster. */
export function nextLevel(g) {
  g.level += 1;
  g.dots = new Set(g.maze.dots.map((d) => key(d.x, d.y)));
  g.pellets = new Set(g.maze.pellets.map((d) => key(d.x, d.y)));
  g.speeds = speedsFor(g.level, g.difficulty);
  g.frightenedMs = 0; g.chain = 0;
  g.fruit = null; g.fruitShown = 0; g.eaten = 0;
  place(g);
  g.phase = 'ready'; g.phaseMs = READY_MS;
  return g;
}

/** Start again from level one, keeping nothing but the maze. */
// A RESTART KEEPS WHAT THE GAME WAS SET UP WITH. It used to call newGame() bare, which quietly put
// the lives back to three, the difficulty back to normal and attract mode off -- so F2 in a hard
// five-life game handed you a normal three-life one (found in the browser, 2026-09-17).
export function restart(g) {
  const fresh = newGame({ maze: g.maze, lives: g.startLives ?? g.lives, difficulty: g.difficulty, auto: g.auto, seed: (Date.now() >>> 0) || 1 });
  Object.assign(g, fresh);
  return g;
}

/**
 * ATTRACT MODE'S PLAYER (M6). Nobody at the keys, so something has to choose: at each junction it
 * scores every way out and takes the best. Not a solver -- a plausible player, which is what an
 * attract screen needs:
 *
 *   * a way that leads into a pursuer within a few tiles is refused outright, unless they are
 *     frightened, in which case it is the best way there is;
 *   * otherwise the nearest dot along that way counts for it, and a nearby pursuer against it;
 *   * a pellet is worth going for when they are close, and worth little when they are not;
 *   * and it will not turn round unless every other way is refused, because a player that
 *     dithers on the spot looks broken rather than hunted.
 */
export function autoTurn(g) {
  const m = g.maze, man = g.man;
  const tile = tileOf(man);
  if (!centred(man, 0.3)) return null;                      // decide at junctions, not mid-corridor
  const ways = DIR_LIST.filter((d) => free(m, tile.x + d.x, tile.y + d.y));
  if (!ways.length) return null;
  const threat = g.pursuers.filter((p) => p.state === 'chase' || p.state === 'scatter');
  const prey = g.pursuers.filter((p) => p.state === 'frightened');
  let best = null, bestScore = -Infinity;
  for (const d of ways) {
    const nx = ((tile.x + d.x) % m.w + m.w) % m.w, ny = tile.y + d.y;
    let score = 0;
    const near = (list) => list.reduce((acc, p) => Math.min(acc, Math.hypot(((p.x - 0.5) - nx + m.w * 1.5) % m.w - m.w * 0.5, (p.y - 0.5) - ny)), Infinity);
    // DANGER IS A SLOPE, NOT A CLIFF. With a flat "closer than two tiles is refused", two bad ways
    // scored the same and the first one won -- which is how the attract player walked into a
    // pursuer standing next to it. Now every extra tile of distance is worth something.
    const danger = near(threat);
    if (danger < 1.2) score -= 4000;                        // touching one: never
    score -= Math.max(0, 6 - danger) ** 2 * 30;
    score += Math.min(danger, 10) * 6;
    const chase = near(prey);
    if (prey.length && chase < 9) score += (10 - chase) * 14;   // frightened: go and get them
    const dot = nearestDot(g, { x: nx, y: ny });
    score += dot == null ? 0 : (22 - Math.min(dot, 20)) * 2;
    if (g.pellets.size && threat.length && danger < 6) {
      const pellet = nearest(g.pellets, { x: nx, y: ny }, m);
      if (pellet != null) score += (18 - Math.min(pellet, 18)) * 3;
    }
    if (opposite(d, man.dir)) score -= 40;                  // dithering looks broken
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const nearestDot = (g, from) => {
  const a = nearest(g.dots, from, g.maze);
  const b = nearest(g.pellets, from, g.maze);
  return a == null ? b : (b == null ? a : Math.min(a, b));
};
function nearest(set, from, m) {
  let out = null;
  for (const k of set) {
    const [x, y] = k.split(',').map(Number);
    const dx = Math.abs(x - from.x), dy = Math.abs(y - from.y);
    const d = Math.min(dx, m.w - dx) + dy;
    if (out == null || d < out) out = d;
  }
  return out;
}

/** The dots and pellets still on the board, for the screen to paint. */
export function remaining(g) {
  const out = { dots: [], pellets: [] };
  for (const k of g.dots) { const [x, y] = k.split(',').map(Number); out.dots.push({ x, y }); }
  for (const k of g.pellets) { const [x, y] = k.split(',').map(Number); out.pellets.push({ x, y }); }
  return out;
}
