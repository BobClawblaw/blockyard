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
export function speedsFor(level) {
  const k = Math.min(1, 0.8 + (level - 1) * 0.05);
  return { man: 9.4 * k, pursuer: 8.8 * k, tunnel: 5.4 * k, frightened: 5.8 * k };
}

const key = (x, y) => `${x},${y}`;
const tileOf = (a) => ({ x: Math.floor(a.x), y: Math.floor(a.y) });
const centred = (a, tol = 0.08) => Math.abs(a.x - (Math.floor(a.x) + 0.5)) < tol && Math.abs(a.y - (Math.floor(a.y) + 0.5)) < tol;

/** The four pursuers: their names, colours and scatter corners. Their rules arrive in M3. */
export const PURSUERS = Object.freeze([
  Object.freeze({ id: 'chaser', name: 'Chaser', colour: '#ef4b4b', corner: { x: 26, y: 1 } }),
  Object.freeze({ id: 'ambusher', name: 'Ambusher', colour: '#ff8ccf', corner: { x: 1, y: 1 } }),
  Object.freeze({ id: 'flanker', name: 'Flanker', colour: '#46d7e4', corner: { x: 26, y: 26 } }),
  Object.freeze({ id: 'wanderer', name: 'Wanderer', colour: '#ffa63d', corner: { x: 1, y: 26 } }),
]);

/** A new game. `maze` is parsed once and shared; the dots are this game's own. */
export function newGame({ level = 1, lives = LIVES, maze = parseMaze(), seed = 1 } = {}) {
  const g = {
    maze, level, lives, score: 0, phase: 'ready', phaseMs: READY_MS,
    dots: new Set(maze.dots.map((d) => key(d.x, d.y))),
    pellets: new Set(maze.pellets.map((d) => key(d.x, d.y))),
    eaten: 0, chain: 0, frightenedMs: 0, events: [],
    rnd: rng(seed), speeds: speedsFor(level),
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
  g.pursuers = PURSUERS.map((p, i) => ({
    ...p,
    x: m.door.x + (i - 1.5) * 1, y: m.door.y + (i === 0 ? -1.5 : 1.5),
    dir: i === 0 ? DIRS.left : (i % 2 ? DIRS.right : DIRS.left),
    state: i === 0 ? 'chase' : 'pen', patrol: i, frightenedLeftMs: 0,
  }));
}

const free = (m, x, y) => m.at(((x % m.w) + m.w) % m.w, y) === OPEN;
const wrap = (m, a) => { if (a.x < 0) a.x += m.w; else if (a.x >= m.w) a.x -= m.w; };
const opposite = (a, b) => a && b && a.x === -b.x && a.y === -b.y;

/** The ways out of a tile, in the genre's tie-break order, never straight back. */
export function exitsFrom(m, tile, dir, { noUp = null } = {}) {
  const banUp = noUp?.has?.(key(tile.x, tile.y));
  return DIR_LIST.filter((d) => {
    if (opposite(d, dir)) return false;
    if (banUp && d === DIRS.up) return false;
    return free(m, tile.x + d.x, tile.y + d.y);
  });
}

/**
 * One frame. `dtMs` is the frame's own length, so the game runs at the same pace whatever the
 * display does. Events (a dot eaten, a life lost, a level cleared) are pushed onto `g.events` for
 * the screen to draw and the sound to play; the caller drains them.
 */
export function stepGame(g, dtMs, { input = null } = {}) {
  if (input) g.man.want = input;
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
        if (!g.frightenedMs) { p.state = 'chase'; g.chain = 0; }
      }
    }
  }
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
  if (g.dots.delete(k)) {
    g.score += SCORE.dot;
    g.eaten += 1;
    g.man.eatMs = EAT_PENALTY_MS;
    g.events.push({ kind: 'dot', x: tile.x, y: tile.y, left: g.dots.size + g.pellets.size });
    extraLife(g);
    return;
  }
  if (g.pellets.delete(k)) {
    g.score += SCORE.pellet;
    g.eaten += 1;
    g.chain = 0;
    g.frightenedMs = frightenedMsFor(g.level);
    for (const p of g.pursuers) {
      if (p.state === 'chase' || p.state === 'scatter' || p.state === 'frightened') {
        p.state = 'frightened';
        p.frightenedLeftMs = g.frightenedMs;
        p.dir = { x: -p.dir.x, y: -p.dir.y };                 // a pellet turns them round
        p.turnedBy = 'pellet';                                // and says so, for the tests
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

// M2: THE PURSUERS WALK A PATROL. Their four rules are M3's; until then each takes the first way out
// in a fixed rotation, which is enough to make them move through the maze, leave the pen and be run
// into. The pen release is a simple stagger; the dot counters arrive with the rules.
function movePursuer(g, p, dt) {
  const m = g.maze;
  if (p.state === 'pen') {
    p.penMs = (p.penMs ?? 0) + dt;
    if (p.penMs > 900 * (p.patrol + 1)) { p.state = 'chase'; p.x = m.door.x; p.y = m.door.y + 0.5; p.dir = DIRS.up; }
    return;
  }
  const speed = p.state === 'frightened' ? g.speeds.frightened : (inTunnel(m, p) ? g.speeds.tunnel : g.speeds.pursuer);
  let left = speed * dt / 1000;
  while (left > 1e-6) {
    const step = Math.min(left, 0.25);
    const tile = tileOf(p);
    if (centred(p, 0.12)) {
      const exits = exitsFrom(m, tile, p.dir, { noUp: g.noUpSet ?? (g.noUpSet = new Set(m.noUp.map((t) => key(t.x, t.y)))) });
      if (exits.length) {
        const pick = p.state === 'frightened'
          ? exits[Math.floor(g.rnd() * exits.length)]
          : exits[(p.patrol + tile.x + tile.y) % exits.length];
        p.dir = pick;
      } else {
        p.dir = { x: -p.dir.x, y: -p.dir.y };
      }
      p.x = tile.x + 0.5; p.y = tile.y + 0.5;
    }
    const ahead = { x: tileOf(p).x + p.dir.x, y: tileOf(p).y + p.dir.y };
    if (!free(m, ahead.x, ahead.y) && centred(p, 0.12)) { left -= step; continue; }
    p.x += p.dir.x * step; p.y += p.dir.y * step;
    wrap(m, p);
    left -= step;
  }
}

const inTunnel = (m, a) => m.tunnels.some((t) => t.y === Math.floor(a.y) && Math.abs(t.x - Math.floor(a.x)) < 1);

function contact(g) {
  for (const p of g.pursuers) {
    if (p.state === 'pen' || p.state === 'eaten') continue;
    if (Math.abs(p.x - g.man.x) + Math.abs(p.y - g.man.y) > CONTACT) continue;
    if (p.state === 'frightened') {
      // M4 gives this its ladder and the walk home; M2 scores it and sends it back to the pen
      g.chain = Math.min(g.chain + 1, SCORE.pursuer.length);
      const pts = SCORE.pursuer[g.chain - 1];
      g.score += pts;
      p.state = 'pen'; p.penMs = 0; p.x = g.maze.door.x; p.y = g.maze.door.y + 1.5; p.frightenedLeftMs = 0;
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
  g.speeds = speedsFor(g.level);
  g.frightenedMs = 0; g.chain = 0;
  place(g);
  g.phase = 'ready'; g.phaseMs = READY_MS;
  return g;
}

/** Start again from level one, keeping nothing but the maze. */
export function restart(g) {
  const fresh = newGame({ maze: g.maze });
  Object.assign(g, fresh);
  return g;
}

/** The dots and pellets still on the board, for the screen to paint. */
export function remaining(g) {
  const out = { dots: [], pellets: [] };
  for (const k of g.dots) { const [x, y] = k.split(',').map(Number); out.dots.push({ x, y }); }
  for (const k of g.pellets) { const [x, y] = k.split(',').map(Number); out.pellets.push({ x, y }); }
  return out;
}
