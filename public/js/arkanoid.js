// BLOCKANOID, the rules (operator, 2026-09-12: "Take blockout, and make rip off of Arkanoid using
// our engine, and make it a new Diversion called 'Blockanoid'").
//
// Like breakout.js and tetris.js, this file is the RULES and nothing else: no DOM, no canvas, no
// clock, and NO Math.random. Arkanoid lives or dies on its capsules, and a capsule that fell at
// random could not be tested at all -- so which brick carries one is a pure hash of that brick's
// id and the level. The same wall always drops the same capsules, and a test can say which.
//
// Coordinates follow the engine's board: x runs left to right, y runs UP from row 0 on the floor.
// Vaus sits near the floor, the wall is at the top, so the ball travels toward +y to break
// something -- the renderer's language, as in breakout.js.
//
// What this takes from Arkanoid that Breakout has not got:
//   - a different WALL every level, not the same six rows again
//   - SILVER bricks that take two hits (and more as the levels climb) and GOLD that never breaks
//   - CAPSULES that fall out of broken bricks: laser, enlarge, catch, slow, disrupt, player, break
//   - three balls at once, a bat that shoots, and a bat that catches
//   - the DOH minions drifting down the court to spoil your aim

export const COLS = 13;
export const ROWS = 26;

export const PADDLE_Y = 1;
export const PADDLE_D = 1;          // the bat's DEPTH across the board (see breakout.js: not its height)
export const PADDLE_H = 0.55;       // how tall the bat's stones STAND
export const PADDLE_W = 3;          // Vaus is narrower than a Breakout bat
export const PADDLE_W_WIDE = 5;     // ... until the E capsule
export const BALL_S = 0.8;
export const BALL_R = BALL_S / 2;
export const LIVES = 3;

export const BRICK_TOP = ROWS - 4;

// ------------------------------------------------------------------ the bricks
// A colour is worth what it is worth, as in the arcade: the dearer the colour the higher it sits.
export const BRICK = Object.freeze({
  w: Object.freeze({ color: '#e8eefc', points: 50 }),
  o: Object.freeze({ color: '#f7931a', points: 60 }),
  c: Object.freeze({ color: '#3ec9ff', points: 70 }),
  g: Object.freeze({ color: '#2ecc8f', points: 80 }),
  r: Object.freeze({ color: '#ef5a5a', points: 90 }),
  b: Object.freeze({ color: '#4d7cff', points: 100 }),
  p: Object.freeze({ color: '#b07cff', points: 110 }),
  y: Object.freeze({ color: '#f5d142', points: 120 }),
});
export const SILVER = Object.freeze({ color: '#b9c4d4', points: 50 });
export const GOLD = Object.freeze({ color: '#d9a441', points: 0 });

// Six walls. '.' is empty, a letter is that colour, S is silver, G is gold. Written TOP ROW FIRST,
// the way you look at it; layout() flips them onto the engine's y-up board.
export const LEVELS = Object.freeze([
  Object.freeze(['wwwwwwwwwwwww', 'ooooooooooooo', 'ccccccccccccc', 'ggggggggggggg', 'rrrrrrrrrrrrr', 'bbbbbbbbbbbbb']),
  Object.freeze(['.SSSSSSSSSSS.', '.G.........G.', '.rrrrrrrrrrr.', '.ooooooooooo.', '.yyyyyyyyyyy.', '.ccccccccccc.']),
  Object.freeze(['r.r.r.r.r.r.r', '.o.o.o.o.o.o.', 'y.y.y.y.y.y.y', '.g.g.g.g.g.g.', 'S.S.S.S.S.S.S', '.b.b.b.b.b.b.']),
  Object.freeze(['......G......', '.....yyy.....', '....ooooo....', '...rrrrrrr...', '..bbbbbbbbb..', '.SSSSSSSSSSS.']),
  Object.freeze(['GGGGGGGGGGGGG', 'G...........G', 'G.SSSSSSSSS.G', 'G.S.ppppp.S.G', 'G.S.pyyyp.S.G', 'G.SSSSSSSSS.G']),
  Object.freeze(['S.G.S.G.S.G.S', '.wwwwwwwwwww.', '.w.c.c.c.c.w.', '.w.ccccccc.w.', '.wwwwwwwwwww.', 'S.G.S.G.S.G.S']),
]);

/** How many hits a silver brick takes at this level: two, and one more every four levels. */
export function silverHits(level) { return 2 + Math.floor(Math.max(0, level - 1) / 4); }

// ------------------------------------------------------------------ the capsules
// One capsule at a time is the arcade's rule and it matters: it is what makes "do I take it?" a
// decision rather than a reflex.
export const CAPSULES = Object.freeze(['laser', 'enlarge', 'catch', 'slow', 'disrupt', 'player', 'break']);
export const CAPSULE_COLOR = Object.freeze({
  laser: '#ef5a5a', enlarge: '#4d7cff', catch: '#2ecc8f', slow: '#f7931a',
  disrupt: '#3ec9ff', player: '#b07cff', break: '#e8eefc',
});
export const CAPSULE_LETTER = Object.freeze({
  laser: 'L', enlarge: 'E', catch: 'C', slow: 'S', disrupt: 'D', player: 'P', break: 'B',
});
export const CAPSULE_POINTS = 1000;
const CAPSULE_FALL = 6;             // grid units a second
const CAPSULE_S = 0.9;
const CAPSULE_ODDS = 0.28;          // of a broken brick

const BASE_SPEED = 12;
const LEVEL_SPEEDUP = 1.06;
const SLOW_FACTOR = 0.68;
const MAX_BOUNCE = 1.05;
const MAX_STEP = 0.3;
const LASER_SPEED = 26;
const LASER_COOLDOWN = 260;         // ms between shots
const ENEMY_SPEED = 2.4;
const ENEMY_EVERY = 9000;           // ms between arrivals while a level runs
const ENEMY_POINTS = 200;
const ENEMY_S = 0.86;
export const ENEMY_COLOR = '#7de3c8';

export const PADDLE_COLOR = '#3ec9ff';
export const PADDLE_LASER_COLOR = '#ef5a5a';
export const BALL_COLOR = '#f2f7ff';
export const BOLT_COLOR = '#ff8b6b';

/**
 * A stable 0..1 from a string. The same brick on the same level always yields the same number, so
 * "which bricks carry capsules" is a property of the wall rather than of the day you played it.
 * (The mix is the same shape as blockscene3d's fxHash: cheap, and well spread for short keys.)
 */
export function hash01(key) {
  let h = 2166136261;
  const s = String(key);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The capsule this brick carries, or null. Pure: the wall decides, not the moment. */
export function capsuleFor(brick, level) {
  const roll = hash01(`cap:${level}:${brick.id}:${brick.x},${brick.y}`);
  if (roll >= CAPSULE_ODDS) return null;
  const pick = hash01(`kind:${level}:${brick.id}`);
  return CAPSULES[Math.min(CAPSULES.length - 1, Math.floor(pick * CAPSULES.length))];
}

export function speed(level) { return BASE_SPEED * Math.pow(LEVEL_SPEEDUP, Math.max(0, level - 1)); }

/** The wall for a level; levels past the last one cycle round, harder silver each time. */
export function layoutFor(level) { return LEVELS[(Math.max(1, level) - 1) % LEVELS.length]; }

function layout(g) {
  g.bricks = [];
  const rows = layoutFor(g.level);
  const hits = silverHits(g.level);
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r];
    const y = BRICK_TOP - r;                       // row 0 of the layout is the TOP row on screen
    for (let x = 0; x < Math.min(COLS, line.length); x++) {
      const ch = line[x];
      if (ch === '.') continue;
      if (ch === 'G') g.bricks.push({ id: g.nextId++, x, y, kind: 'gold', color: GOLD.color, points: 0, hits: Infinity });
      else if (ch === 'S') g.bricks.push({ id: g.nextId++, x, y, kind: 'silver', color: SILVER.color, points: SILVER.points * g.level, hits });
      else {
        const spec = BRICK[ch];
        if (!spec) continue;
        g.bricks.push({ id: g.nextId++, x, y, kind: 'plain', color: spec.color, points: spec.points, hits: 1 });
      }
    }
  }
  g.breakableAtStart = breakable(g).length;
}

/** The bricks that can actually be destroyed -- gold is scenery, and never blocks a level. */
export function breakable(g) { return g.bricks.filter((b) => b.kind !== 'gold'); }

export function resetBall(g) {
  g.balls = [{ x: g.paddle.x + g.paddle.w / 2, y: PADDLE_Y + PADDLE_D + BALL_R, vx: 0, vy: 0, r: BALL_R, stuck: true }];
  return g.balls[0];
}

/** Vaus back to stock: normal width, no laser, no catch, no slow. */
export function resetVaus(g) {
  g.paddle.w = PADDLE_W;
  g.laser = false;
  g.catch = false;
  g.slow = false;
  g.cooldown = 0;
  g.paddle.x = Math.max(0, Math.min(COLS - g.paddle.w, g.paddle.x));
}

/**
 * The two switches that change the RULES rather than the look, so they live on the game and not in
 * the renderer's options. A setting nothing reads is a dead control; these are read in capsuleFor's
 * caller and in the minions' arrival, which is the only place they can bite.
 */
export function setOptions(g, opts = {}) {
  g.opts = { capsules: opts.capsules !== false, enemies: opts.enemies !== false };
  if (!g.opts.capsules) g.capsules = [];
  if (!g.opts.enemies) g.enemies = [];
  return g.opts;
}

export function newGame(level = 1, opts = {}) {
  const g = {
    cols: COLS, rows: ROWS,
    level, score: 0, lives: LIVES, over: false, cleared: false,
    paddle: { x: (COLS - PADDLE_W) / 2, w: PADDLE_W },
    balls: [], bricks: [], capsules: [], bolts: [], enemies: [],
    laser: false, catch: false, slow: false, cooldown: 0,
    sinceEnemy: 0, nextId: 1, breakableAtStart: 0,
    opts: { capsules: true, enemies: true },
  };
  setOptions(g, opts);
  layout(g);
  resetBall(g);
  return g;
}

/** The next wall: a new layout, a faster ball, Vaus back to stock, the score and lives carried. */
export function advance(g) {
  g.level++;
  g.cleared = false;
  g.capsules = []; g.bolts = []; g.enemies = []; g.sinceEnemy = 0;
  layout(g);
  resetVaus(g);
  resetBall(g);
  return g;
}

export function movePaddle(g, centreX) {
  if (g.over) return g.paddle.x;
  const half = g.paddle.w / 2;
  g.paddle.x = Math.max(0, Math.min(COLS - g.paddle.w, centreX - half));
  for (const b of g.balls) if (b.stuck) b.x = Math.max(g.paddle.x, Math.min(g.paddle.x + g.paddle.w, b.x));
  return g.paddle.x;
}
export function nudge(g, dx) { return movePaddle(g, g.paddle.x + g.paddle.w / 2 + dx); }

/** Send every waiting ball on its way. The angle is the caller's, never a roll. */
export function launch(g, angle = 0.3) {
  if (g.over) return false;
  const waiting = g.balls.filter((b) => b.stuck);
  if (!waiting.length) return false;
  const s = speed(g.level) * (g.slow ? SLOW_FACTOR : 1);
  const a = Math.max(-MAX_BOUNCE, Math.min(MAX_BOUNCE, angle));
  for (const b of waiting) { b.vx = Math.sin(a) * s; b.vy = Math.cos(a) * s; b.stuck = false; }
  return true;
}

/** Fire, if the laser is up and it has cooled. Returns the bolts created. */
export function fire(g) {
  if (g.over || !g.laser || g.cooldown > 0) return [];
  const p = g.paddle;
  const made = [
    { id: g.nextId++, x: p.x + 0.3, y: PADDLE_Y + PADDLE_D },
    { id: g.nextId++, x: p.x + p.w - 0.3, y: PADDLE_Y + PADDLE_D },
  ];
  g.bolts.push(...made);
  g.cooldown = LASER_COOLDOWN;
  return made;
}

function offPaddle(g, b) {
  const p = g.paddle;
  const off = Math.max(-1, Math.min(1, (b.x - (p.x + p.w / 2)) / (p.w / 2)));
  const s = Math.hypot(b.vx, b.vy) || speed(g.level);
  const a = off * MAX_BOUNCE;
  b.vx = Math.sin(a) * s;
  b.vy = Math.abs(Math.cos(a) * s);
  b.y = PADDLE_Y + PADDLE_D + b.r;
  if (g.catch) { b.stuck = true; b.vx = 0; b.vy = 0; }
}

/** Take a capsule. Each one is a different promise, so each is written out rather than table-driven. */
export function applyCapsule(g, kind) {
  g.score += CAPSULE_POINTS;
  switch (kind) {
    case 'laser': g.laser = true; g.catch = false; break;
    case 'enlarge': {
      const mid = g.paddle.x + g.paddle.w / 2;
      g.paddle.w = PADDLE_W_WIDE;
      g.paddle.x = Math.max(0, Math.min(COLS - g.paddle.w, mid - g.paddle.w / 2));
      break;
    }
    case 'catch': g.catch = true; g.laser = false; break;
    case 'slow': {
      g.slow = true;
      for (const b of g.balls) if (!b.stuck) { b.vx *= SLOW_FACTOR; b.vy *= SLOW_FACTOR; }
      break;
    }
    case 'disrupt': {
      // three on the court. The extra two leave at a fixed spread off the first, so a disrupted
      // rally is still a rally a test can follow.
      const live = g.balls.filter((b) => !b.stuck);
      const from = live[0] ?? g.balls[0];
      if (from && !from.stuck) {
        for (const turn of [0.45, -0.45]) {
          const c = Math.cos(turn), s = Math.sin(turn);
          g.balls.push({ x: from.x, y: from.y, vx: from.vx * c - from.vy * s, vy: from.vx * s + from.vy * c, r: BALL_R, stuck: false });
        }
      }
      break;
    }
    case 'player': g.lives += 1; break;
    case 'break': g.cleared = true; break;
    default: break;
  }
  return g;
}

function hitBrick(g, b, hits) {
  for (let i = 0; i < g.bricks.length; i++) {
    const k = g.bricks[i];
    const ox = Math.min(b.x + b.r, k.x + 1) - Math.max(b.x - b.r, k.x);
    const oy = Math.min(b.y + b.r, k.y + 1) - Math.max(b.y - b.r, k.y);
    if (ox <= 0 || oy <= 0) continue;
    if (ox < oy) { b.vx = b.x < k.x + 0.5 ? -Math.abs(b.vx) : Math.abs(b.vx); b.x += b.vx > 0 ? ox : -ox; }
    else { b.vy = b.y < k.y + 0.5 ? -Math.abs(b.vy) : Math.abs(b.vy); b.y += b.vy > 0 ? oy : -oy; }
    damage(g, k, i, hits);
    return true;
  }
  return false;
}

/** One hit on a brick. Gold rings and stands; silver counts down; anything else goes. */
function damage(g, k, i, hits) {
  if (k.kind === 'gold') { hits.push({ kind: 'gold', x: k.x, y: k.y, color: k.color }); return false; }
  k.hits -= 1;
  if (k.hits > 0) { hits.push({ kind: 'silver', x: k.x, y: k.y, color: k.color }); return false; }
  g.bricks.splice(i, 1);
  g.score += k.points;
  hits.push({ kind: 'brick', x: k.x, y: k.y, color: k.color, points: k.points, brickKind: k.kind });
  // one capsule on the court at a time, exactly as the arcade does it
  const cap = g.opts?.capsules === false ? null : capsuleFor(k, g.level);
  if (cap && !g.capsules.length) {
    g.capsules.push({ id: g.nextId++, kind: cap, x: k.x, y: k.y });
    hits.push({ kind: 'capsuleout', capsule: cap, x: k.x, y: k.y });
  }
  return true;
}

function moveCapsules(g, dt, hits) {
  const p = g.paddle;
  for (let i = g.capsules.length - 1; i >= 0; i--) {
    const c = g.capsules[i];
    c.y -= CAPSULE_FALL * dt;
    const caught = c.y <= PADDLE_Y + PADDLE_D && c.y + CAPSULE_S >= PADDLE_Y
      && c.x + CAPSULE_S >= p.x && c.x <= p.x + p.w;
    if (caught) {
      g.capsules.splice(i, 1);
      applyCapsule(g, c.kind);
      hits.push({ kind: 'capsule', capsule: c.kind });
    } else if (c.y + CAPSULE_S < 0) g.capsules.splice(i, 1);
  }
}

function moveBolts(g, dt, hits) {
  for (let i = g.bolts.length - 1; i >= 0; i--) {
    const z = g.bolts[i];
    z.y += LASER_SPEED * dt;
    if (z.y > ROWS) { g.bolts.splice(i, 1); continue; }
    let spent = false;
    for (let e = g.enemies.length - 1; e >= 0 && !spent; e--) {
      const m = g.enemies[e];
      if (z.x >= m.x && z.x <= m.x + ENEMY_S && z.y >= m.y && z.y <= m.y + ENEMY_S) {
        g.enemies.splice(e, 1); g.score += ENEMY_POINTS;
        hits.push({ kind: 'enemy', x: m.x, y: m.y });
        spent = true;
      }
    }
    for (let bi = 0; bi < g.bricks.length && !spent; bi++) {
      const k = g.bricks[bi];
      if (z.x >= k.x && z.x <= k.x + 1 && z.y >= k.y && z.y <= k.y + 1) {
        damage(g, k, bi, hits);
        spent = true;
      }
    }
    if (spent) g.bolts.splice(i, 1);
  }
}

function moveEnemies(g, dt, dtMs, hits) {
  if (g.opts?.enemies === false) { g.sinceEnemy = 0; return; }
  g.sinceEnemy += dtMs;
  if (g.sinceEnemy >= ENEMY_EVERY && g.enemies.length < 3 && breakable(g).length) {
    g.sinceEnemy = 0;
    const n = g.nextId++;
    // deterministic arrival: where it enters is a property of the level and the count, not a roll
    const lane = Math.floor(hash01(`enemy:${g.level}:${n}`) * (COLS - 1));
    g.enemies.push({ id: n, x: lane, y: ROWS - 1, phase: hash01(`ph:${n}`) * Math.PI * 2, t: 0 });
    hits.push({ kind: 'enemyin', x: lane });
  }
  const p = g.paddle;
  for (let i = g.enemies.length - 1; i >= 0; i--) {
    const m = g.enemies[i];
    m.t += dt;
    m.y -= ENEMY_SPEED * dt;
    m.x = Math.max(0, Math.min(COLS - ENEMY_S, m.x + Math.sin(m.phase + m.t * 2.2) * dt * 2.2));
    const onBat = m.y <= PADDLE_Y + PADDLE_D && m.y + ENEMY_S >= PADDLE_Y && m.x + ENEMY_S >= p.x && m.x <= p.x + p.w;
    if (onBat || m.y + ENEMY_S < 0) {
      g.enemies.splice(i, 1);
      if (onBat) { g.score += ENEMY_POINTS; hits.push({ kind: 'enemy', x: m.x, y: m.y }); }
    }
  }
}

function ballEnemy(g, b, hits) {
  for (let i = g.enemies.length - 1; i >= 0; i--) {
    const m = g.enemies[i];
    const ox = Math.min(b.x + b.r, m.x + ENEMY_S) - Math.max(b.x - b.r, m.x);
    const oy = Math.min(b.y + b.r, m.y + ENEMY_S) - Math.max(b.y - b.r, m.y);
    if (ox <= 0 || oy <= 0) continue;
    g.enemies.splice(i, 1);
    g.score += ENEMY_POINTS;
    b.vy = -Math.abs(b.vy);
    hits.push({ kind: 'enemy', x: m.x, y: m.y });
    return true;
  }
  return false;
}

function substepBall(g, b, h, hits) {
  b.x += b.vx * h;
  b.y += b.vy * h;
  if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); hits.push({ kind: 'wall' }); }
  else if (b.x + b.r > COLS) { b.x = COLS - b.r; b.vx = -Math.abs(b.vx); hits.push({ kind: 'wall' }); }
  if (b.y + b.r > ROWS) { b.y = ROWS - b.r; b.vy = -Math.abs(b.vy); hits.push({ kind: 'wall' }); }

  const p = g.paddle;
  if (b.vy < 0 && b.y - b.r <= PADDLE_Y + PADDLE_D && b.y + b.r >= PADDLE_Y
      && b.x + b.r >= p.x && b.x - b.r <= p.x + p.w) {
    offPaddle(g, b);
    hits.push({ kind: 'paddle' });
  }
  ballEnemy(g, b, hits);
  hitBrick(g, b, hits);
  return b.y + b.r < 0;                       // through the floor
}

/**
 * Advance the court by dtMs. Substepped for the same reason breakout.js is: a ball at twelve units
 * a second crosses a one-unit brick in 83 ms and would tunnel through the wall on a slow frame.
 */
export function step(g, dtMs) {
  const hits = [];
  if (g.over) return { hits, lost: false, cleared: g.cleared };
  const standing = breakable(g).length > 0;
  const dt = Math.min(60, Math.max(0, dtMs)) / 1000;
  g.cooldown = Math.max(0, g.cooldown - Math.min(60, Math.max(0, dtMs)));

  moveCapsules(g, dt, hits);
  moveBolts(g, dt, hits);
  moveEnemies(g, dt, Math.min(60, Math.max(0, dtMs)), hits);

  const moving = g.balls.filter((b) => !b.stuck);
  for (const b of moving) {
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const n = Math.max(1, Math.ceil((sp * dt) / MAX_STEP));
    const h = dt / n;
    let gone = false;
    for (let i = 0; i < n && !gone; i++) gone = substepBall(g, b, h, hits);
    if (gone) b.dead = true;
  }
  if (g.balls.some((b) => b.dead)) g.balls = g.balls.filter((b) => !b.dead);

  let lost = false;
  if (!g.balls.length) {                      // every ball gone: a life, and Vaus back to stock
    lost = true;
    g.lives -= 1;
    hits.push({ kind: 'life' });
    resetVaus(g);
    g.capsules = []; g.bolts = [];
    if (g.lives <= 0) { g.over = true; resetBall(g); g.balls[0].stuck = true; }
    else resetBall(g);
  }

  if (standing && !breakable(g).length) g.cleared = true;
  if (g.cleared) for (const b of g.balls) { b.stuck = true; b.vx = 0; b.vy = 0; }
  return { hits, lost, cleared: g.cleared };
}

/**
 * The board as tiles for the engine. A brick is exactly one grid cell, so a brick IS a tile -- the
 * same reason Blockout needed no translation layer. Vaus turns red while the laser is up, so the
 * bat itself says what it can do rather than only the HUD saying it.
 */
export function tiles(g) {
  const out = [];
  for (const k of g.bricks) {
    // a damaged silver brick stands lower: the wall shows its own wear
    const tall = k.kind === 'silver' && Number.isFinite(k.hits) && k.hits < silverHits(g.level) ? 0.7 : 1;
    out.push({ txid: `b${k.id}`, x: k.x, y: k.y, s: 1, tall, color: k.color });
  }
  const p = g.paddle;
  const padColor = g.laser ? PADDLE_LASER_COLOR : PADDLE_COLOR;
  for (let i = 0; i < Math.round(p.w); i++) {
    out.push({ txid: `pad${i}`, x: p.x + i, y: PADDLE_Y, s: 1, tall: PADDLE_H, color: padColor, paddle: true });
  }
  for (const c of g.capsules) {
    out.push({ txid: `cap${c.id}`, x: c.x, y: c.y, s: CAPSULE_S, tall: 0.42, color: CAPSULE_COLOR[c.kind], capsule: true });
  }
  for (const z of g.bolts) {
    out.push({ txid: `bolt${z.id}`, x: z.x - 0.09, y: z.y, s: 0.18, tall: 0.7, color: BOLT_COLOR, bolt: true });
  }
  for (const m of g.enemies) {
    out.push({ txid: `foe${m.id}`, x: m.x, y: m.y, s: ENEMY_S, tall: ENEMY_S, color: ENEMY_COLOR, enemy: true, sphere: true });
  }
  for (let i = 0; i < g.balls.length; i++) {
    const b = g.balls[i];
    out.push({ txid: `ball${i}`, x: b.x - b.r, y: b.y - b.r, s: BALL_S, tall: BALL_S, color: BALL_COLOR, ball: true, sphere: true });
  }
  return out;
}

/** How much of the breakable wall is left, 0..1. */
export function remaining(g) {
  return g.breakableAtStart ? breakable(g).length / g.breakableAtStart : 0;
}

/** What Vaus is carrying, for the HUD. */
export function powers(g) {
  const on = [];
  if (g.laser) on.push('laser');
  if (g.catch) on.push('catch');
  if (g.slow) on.push('slow');
  if (g.paddle.w > PADDLE_W) on.push('wide');
  if (g.balls.length > 1) on.push(`${g.balls.length} balls`);
  return on;
}
