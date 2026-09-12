// TETRUST, the game (operator, 2026-09-12: "a playable tetris game using our 3d Engine ...
// 'Tetrust' is a play on words for Bitcoiners to always trust and verify").
//
// This file is the RULES and nothing else: no DOM, no canvas, no clock. A game is a plain object,
// every move is a function on it, and the random piece order comes from a seed -- so the whole of
// it runs under node:test and a board state can be asserted cell by cell. What is drawn (and when)
// is tetrust.js's business; it asks this file for the tiles and hands them to the 3D engine.
//
// Coordinates follow the engine's board: x runs left to right, y runs UP from row 0 on the floor.
// A piece falls toward y = 0. That is the opposite of most Tetris code, and it is on purpose --
// the engine draws row 0 at the bottom of the screen, so the rules speak the renderer's language
// rather than flipping on the way out.

export const COLS = 10;
export const ROWS = 20;

// Seven pieces, four orientations each, as cells in a 4x4 box (x right, y up). Spelled out rather
// than rotated by formula: a rotation table is a fact you can read, a matrix is a thing you debug.
export const PIECES = Object.freeze({
  I: { color: '#3ec9ff', rot: [[[0, 2], [1, 2], [2, 2], [3, 2]], [[2, 0], [2, 1], [2, 2], [2, 3]], [[0, 1], [1, 1], [2, 1], [3, 1]], [[1, 0], [1, 1], [1, 2], [1, 3]]] },
  O: { color: '#f5d142', rot: [[[1, 1], [2, 1], [1, 2], [2, 2]], [[1, 1], [2, 1], [1, 2], [2, 2]], [[1, 1], [2, 1], [1, 2], [2, 2]], [[1, 1], [2, 1], [1, 2], [2, 2]]] },
  T: { color: '#b06bff', rot: [[[0, 1], [1, 1], [2, 1], [1, 2]], [[1, 0], [1, 1], [1, 2], [2, 1]], [[0, 1], [1, 1], [2, 1], [1, 0]], [[1, 0], [1, 1], [1, 2], [0, 1]]] },
  S: { color: '#2ecc8f', rot: [[[1, 2], [2, 2], [0, 1], [1, 1]], [[1, 2], [1, 1], [2, 1], [2, 0]], [[1, 2], [2, 2], [0, 1], [1, 1]], [[1, 2], [1, 1], [2, 1], [2, 0]]] },
  Z: { color: '#ef5a5a', rot: [[[0, 2], [1, 2], [1, 1], [2, 1]], [[2, 2], [2, 1], [1, 1], [1, 0]], [[0, 2], [1, 2], [1, 1], [2, 1]], [[2, 2], [2, 1], [1, 1], [1, 0]]] },
  J: { color: '#3b82f6', rot: [[[0, 2], [0, 1], [1, 1], [2, 1]], [[1, 2], [2, 2], [1, 1], [1, 0]], [[0, 1], [1, 1], [2, 1], [2, 0]], [[1, 2], [1, 1], [1, 0], [0, 0]]] },
  L: { color: '#f7931a', rot: [[[2, 2], [0, 1], [1, 1], [2, 1]], [[1, 2], [1, 1], [1, 0], [2, 0]], [[0, 1], [1, 1], [2, 1], [0, 0]], [[0, 2], [1, 2], [1, 1], [1, 0]]] },
});
export const KINDS = Object.keys(PIECES);

// Scoring is the classic table, times the level: the reward for clearing four at once is well
// over four singles, which is the whole reason to leave a column open and wait for the I.
export const LINE_SCORE = [0, 100, 300, 500, 800];
export const LINES_PER_LEVEL = 10;

/** How long a piece rests on a row before gravity takes it down one, at this level. */
export function gravityMs(level) {
  // brisk from the first level (operator: "Smaller, faster, playable!"): 700 ms a row at level
  // one, 65 ms quicker each level, never under 80
  return Math.max(80, 700 - (level - 1) * 65);
}

// A small seeded generator, so a game's piece order is reproducible under test.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// THE SEVEN-BAG: every piece once, in a shuffled order, then a fresh bag. It is what keeps a game
// fair -- no run of five S pieces, and never more than twelve pieces between one I and the next.
function fillBag(g) {
  const bag = [...KINDS];
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(g.rnd() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  g.queue.push(...bag);
}

export function newGame(seed = Date.now()) {
  const g = {
    board: Array.from({ length: ROWS }, () => new Array(COLS).fill(null)),   // board[y][x] = kind | null
    queue: [], rnd: rng(seed), seed,
    cur: null,            // { kind, rot, x, y }
    score: 0, lines: 0, level: 1, pieces: 0,
    over: false,
    cleared: [],          // rows cleared by the last lock, for the renderer to celebrate
  };
  fillBag(g);
  spawn(g);
  return g;
}

/** The cells a piece occupies at a position and orientation, in board coordinates. */
export function cellsOf(kind, rot, x, y) {
  return PIECES[kind].rot[((rot % 4) + 4) % 4].map(([cx, cy]) => [x + cx, y + cy]);
}

/** True if any cell is outside the well or on a locked block. Above the well counts as blocked. */
export function collides(g, cells) {
  for (const [x, y] of cells) {
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return true;
    if (g.board[y][x]) return true;
  }
  return false;
}

export function spawn(g) {
  if (g.queue.length < 7) fillBag(g);
  const kind = g.queue.shift();
  const cur = { kind, rot: 0, x: 3, y: ROWS - 4 };
  g.cur = cur;
  g.pieces++;
  // GAME OVER is a piece that cannot even appear: the stack has reached the top of the well
  if (collides(g, cellsOf(kind, 0, cur.x, cur.y))) { g.over = true; g.cur = null; }
  return cur;
}

export function peekNext(g) { return g.queue[0]; }

/** Slide left or right; a blocked slide simply does not happen. */
export function move(g, dx) {
  if (!g.cur || g.over) return false;
  const c = g.cur;
  if (collides(g, cellsOf(c.kind, c.rot, c.x + dx, c.y))) return false;
  c.x += dx;
  return true;
}

/**
 * Rotate, with WALL KICKS: a rotation that lands in a wall or a block is tried again shifted one
 * then two cells either way, and one cell down. Without kicks a piece against the wall cannot
 * turn, which is the single most common "this game feels broken" in a Tetris.
 */
export function rotate(g, dir = 1) {
  if (!g.cur || g.over) return false;
  const c = g.cur;
  const rot = (((c.rot + dir) % 4) + 4) % 4;
  for (const [kx, ky] of [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1]]) {
    if (!collides(g, cellsOf(c.kind, rot, c.x + kx, c.y + ky))) { c.rot = rot; c.x += kx; c.y += ky; return true; }
  }
  return false;
}

/** Where the piece would come to rest if dropped: the row the ghost is drawn on. */
export function ghostY(g) {
  if (!g.cur) return null;
  const c = g.cur;
  let y = c.y;
  while (!collides(g, cellsOf(c.kind, c.rot, c.x, y - 1))) y--;
  return y;
}

function lock(g) {
  const c = g.cur;
  for (const [x, y] of cellsOf(c.kind, c.rot, c.x, c.y)) g.board[y][x] = c.kind;
  // LINES: every full row goes, and everything above it comes down one
  const full = [];
  for (let y = 0; y < ROWS; y++) if (g.board[y].every(Boolean)) full.push(y);
  for (const y of [...full].reverse()) { g.board.splice(y, 1); g.board.push(new Array(COLS).fill(null)); }
  g.cleared = full;
  if (full.length) {
    g.lines += full.length;
    g.score += LINE_SCORE[full.length] * g.level;
    g.level = 1 + Math.floor(g.lines / LINES_PER_LEVEL);
  }
  spawn(g);
}

/** One step of gravity. Returns true if the piece locked (and so the board changed shape). */
export function tick(g) {
  if (!g.cur || g.over) return false;
  const c = g.cur;
  if (!collides(g, cellsOf(c.kind, c.rot, c.x, c.y - 1))) { c.y--; g.cleared = []; return false; }
  lock(g);
  return true;
}

/** Soft drop: one row down now, and a point for it. */
export function softDrop(g) {
  if (!g.cur || g.over) return false;
  const c = g.cur;
  if (collides(g, cellsOf(c.kind, c.rot, c.x, c.y - 1))) { lock(g); return true; }
  c.y--; g.score += 1; g.cleared = [];
  return false;
}

/** Hard drop: straight to the floor, two points a row, and lock. */
export function hardDrop(g) {
  if (!g.cur || g.over) return 0;
  const c = g.cur;
  const y = ghostY(g);
  const fell = c.y - y;
  c.y = y;
  g.score += 2 * fell;
  lock(g);
  return fell;
}

/**
 * The board as tiles for the 3D engine (board3d): every locked cell a stone in its piece's
 * colour, the falling piece standing a little taller, and its GHOST -- where it will land -- as a
 * thin dim plate on the floor. Ids are positional for the stack and fixed for the piece, so the
 * renderer sees a still board that changes, not a board that reshuffles.
 */
export function tiles(g) {
  const out = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const k = g.board[y][x];
    if (k) out.push({ txid: `c${x}_${y}`, x, y, s: 1, tall: 1, color: PIECES[k].color });
  }
  if (g.cur && !g.over) {
    const c = g.cur;
    const gy = ghostY(g);
    if (gy !== c.y) {
      cellsOf(c.kind, c.rot, c.x, gy).forEach(([x, y], i) => out.push({ txid: `g${i}`, x, y, s: 1, tall: 0.14, color: dim(PIECES[c.kind].color) }));
    }
    cellsOf(c.kind, c.rot, c.x, c.y).forEach(([x, y], i) => out.push({ txid: `p${i}`, x, y, s: 1, tall: 1.18, color: PIECES[c.kind].color }));
  }
  return out;
}

/** The next piece alone, centred in a 4x4 box, for the preview. */
export function previewTiles(kind) {
  if (!kind) return [];
  return cellsOf(kind, 0, 0, 0).map(([x, y], i) => ({ txid: `n${i}`, x, y, s: 1, tall: 1, color: PIECES[kind].color }));
}

// a colour pulled most of the way to the dark floor, for the ghost
function dim(hex) {
  const h = hex.replace('#', '');
  const ch = (i) => Math.round(parseInt(h.slice(i, i + 2), 16) * 0.38 + 14);
  return `#${[ch(0), ch(2), ch(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
