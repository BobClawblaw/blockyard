// BLOCKMAN, THE SCREEN (docs/PLAN-BLOCKMAN.md, M1).
//
// M1 is the measurement milestone: the maze as a block layer built once, and the dots, BlockMan and
// the four pursuers PAINTED over it every frame (blockmanfx.js). Nothing here is the game yet -- the
// actors walk a scripted wander so the layer can be driven at full rate and timed. The rules arrive
// in M2 (blockman.js) and this file keeps only the screen: canvases, the HUD, the keys.
//
// THE TWO LAYERS, AND WHY (§2, measured 2026-09-17):
//   * the maze is 230-odd cubes through the renderer's scene builder, built ONCE a level. Rebuilding
//     1,008 cubes a frame measured 15 fps, and one cube per arcade pixel 1.4 fps.
//   * everything that moves is painted in the renderer's own projection through its `overlay` hook,
//     which is what Scorched Yard does for shells and blasts.
import { board3d } from './details3d.js';
import { parseMaze, OPEN } from './blockmanmaze.js';
import { paintDots, paintBlockMan, paintPursuers } from './blockmanfx.js';

const WALL_COLOUR = '#2a3ac8';          // the maze's own blue; one colour a level later (M5)
const PURSUERS = Object.freeze([
  Object.freeze({ id: 'chaser', name: 'Chaser', colour: '#ef4b4b' }),
  Object.freeze({ id: 'ambusher', name: 'Ambusher', colour: '#ff8ccf' }),
  Object.freeze({ id: 'flanker', name: 'Flanker', colour: '#46d7e4' }),
  Object.freeze({ id: 'wanderer', name: 'Wanderer', colour: '#ffa63d' }),
]);

const BOARD = {
  // THE PLAY LAYER IS TRANSPARENT (2026-09-17): the renderer fills a board's canvas with
  // `background` before it draws, so the layer laid over the maze has to ask for nothing --
  // otherwise it paints the maze out, which is exactly what the first run did.
  oblique: { ox: 0.08, oy: 0.26, headroom: 0, flight: 0 },
  dome: 0,
  light: 'front', lightHeight: 'low', lightGain: 1.6, topLight: 0.5,
  grid: false, stars: false, still: true,
};

const G = {
  maze: null, dots: null, pellets: null,
  man: null, pursuers: [],
  raf: null, last: 0, mazeKey: null,
  frames: 0, frameMs: [], paintNow: 0,
  h: null, state: null,
};

const el = (id) => document.getElementById(id);

/** Every wall tile as a cube for the scene builder; the pen's box included, its interior darker. */
export function wallTiles(m) {
  const out = [];
  const penSet = new Set(m.pen.map((p) => `${p.x},${p.y}`));
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.at(x, y) === OPEN) continue;
      const pen = penSet.has(`${x},${y}`);
      const edge = x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1;
      out.push({
        txid: `w${x}:${y}`, x, y, s: 1, tall: pen ? 0.5 : 1,
        color: pen ? '#141a3c' : (edge ? '#1d2790' : WALL_COLOUR),
      });
    }
  }
  return out;
}

/** The order the renderer draws a resting grid in: back rows first, columns outside in. */
export function mazeOrder(a, b) {
  if (a.y !== b.y) return a.y - b.y;
  const m = G.maze?.w ? G.maze.w / 2 : 14;
  const da = Math.abs(a.x + 0.5 - m), db = Math.abs(b.x + 0.5 - m);
  if (da !== db) return db - da;
  return b.x - a.x;
}

// ------------------------------------------------------------------ the scripted walk (M1 only)
const DIRS = Object.freeze([{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]);
const free = (m, x, y) => m.at(((x % m.w) + m.w) % m.w, y) === OPEN;

function walk(a, m, dtMs, rnd) {
  const speed = a.speed * dtMs / 1000;
  let left = speed;
  while (left > 0) {
    const step = Math.min(left, 0.34);
    const nx = a.x + a.dir.x * step, ny = a.y + a.dir.y * step;
    const tile = { x: Math.round(nx - 0.5), y: Math.round(ny - 0.5) };
    const ahead = { x: tile.x + a.dir.x, y: tile.y + a.dir.y };
    const centred = Math.abs(nx - (tile.x + 0.5)) < 0.06 && Math.abs(ny - (tile.y + 0.5)) < 0.06;
    if (centred && !free(m, ahead.x, ahead.y)) {
      // a wall ahead: turn to a free way, preferring not to double back
      const options = DIRS.filter((d) => free(m, tile.x + d.x, tile.y + d.y) && !(d.x === -a.dir.x && d.y === -a.dir.y));
      a.dir = options.length ? options[Math.floor(rnd() * options.length)] : { x: -a.dir.x, y: -a.dir.y };
      a.x = tile.x + 0.5; a.y = tile.y + 0.5;
    } else if (centred && rnd() < 0.12) {
      const options = DIRS.filter((d) => free(m, tile.x + d.x, tile.y + d.y) && !(d.x === -a.dir.x && d.y === -a.dir.y));
      if (options.length > 1) a.dir = options[Math.floor(rnd() * options.length)];
      a.x = nx; a.y = ny;
    } else {
      a.x = nx; a.y = ny;
    }
    if (a.x < 0) a.x += m.w; else if (a.x >= m.w) a.x -= m.w;      // the tunnel wraps
    left -= step;
  }
}

let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function reset() {
  const m = G.maze ?? (G.maze = parseMaze());
  G.dots = m.dots.map((d) => ({ ...d }));
  G.pellets = m.pellets.map((p) => ({ ...p }));
  G.man = { x: m.start.x, y: m.start.y + 0.5, dir: { x: -1, y: 0 }, speed: 8 };
  G.pursuers = PURSUERS.map((p, i) => ({
    ...p, x: m.door.x + (i - 1.5) * 0.9, y: m.door.y + 1.5, dir: { x: i % 2 ? 1 : -1, y: 0 }, speed: 7.2, state: 'chase',
  }));
  G.frames = 0; G.frameMs = [];
}

// ------------------------------------------------------------------------------ the painted layer
function paintPlay(ctx, view, hx) {
  const m = G.maze;
  if (!m) return;
  const P = (x, y, z = 1.1) => hx.project(x, y, z, view);
  const o0 = P(0, 0), ox = P(1, 0), oy = P(0, 1);
  const U = { x: Math.abs(ox.x - o0.x) || 8, y: Math.abs(oy.y - o0.y) || 8 };
  paintDots(ctx, P, U, { dots: G.dots, pellets: G.pellets, now: G.paintNow });
  paintPursuers(ctx, P, U, G.pursuers, { now: G.paintNow });
  paintBlockMan(ctx, P, U, G.man, { now: G.paintNow });
}

function draw(now = performance.now()) {
  const m = G.maze;
  const maze = el('bmMaze'), play = el('bmPlay');
  if (!m || !maze || !play) return;
  const opts = { ...BOARD, gridW: m.w, gridH: m.h };
  if (G.mazeKey !== `${m.w}x${m.h}`) {                       // the maze is built once
    board3d(maze, wallTiles(m).sort(mazeOrder), { ...opts, order: 'given', background: '#05080f' });
    G.mazeKey = `${m.w}x${m.h}`;
  }
  G.paintNow = now;
  board3d(play, [], { ...opts, background: 'rgba(0,0,0,0)', spaceFloor: 'rgba(0,0,0,0)', neonCell: 'rgba(0,0,0,0)', overlay: paintPlay });
  const hud = el('bmStats');
  if (hud) {
    const fps = G.frameMs.length > 8 ? Math.round(1000 / (G.frameMs.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, G.frameMs.length))) : null;
    const html = `<dt>dots left</dt><dd>${G.dots.length}</dd><dt>pursuers</dt><dd>${G.pursuers.length}</dd><dt>frames</dt><dd>${G.frames}${fps ? ` · ${fps} fps` : ''}</dd>`;
    if (hud.__html !== html) { hud.innerHTML = html; hud.__html = html; }
  }
}

function frame(now) {
  const dt = G.last ? Math.min(60, now - G.last) : 16;
  if (G.last) G.frameMs.push(now - G.last);
  if (G.frameMs.length > 240) G.frameMs.shift();
  G.last = now;
  G.frames += 1;
  walk(G.man, G.maze, dt, rnd);
  for (const p of G.pursuers) walk(p, G.maze, dt, rnd);
  // the scripted walk eats what it drives over, so the dot layer shrinks the way a real game's does
  const mx = Math.floor(G.man.x), my = Math.floor(G.man.y);
  const before = G.dots.length;
  G.dots = G.dots.filter((d) => d.x !== mx || d.y !== my);
  G.pellets = G.pellets.filter((d) => d.x !== mx || d.y !== my);
  if (!G.dots.length && before) reset();                     // a cleared maze starts again
  draw(now);
  G.raf = requestAnimationFrame(frame);
}

/** For the tests and the measurement script: the walk's state, and the frame times it has seen. */
export function currentPlay() { return { maze: G.maze, man: G.man, pursuers: G.pursuers, dots: G.dots, pellets: G.pellets }; }
export function frameStats() {
  const ms = G.frameMs.slice().sort((a, b) => a - b);
  return { frames: G.frames, medianMs: ms.length ? ms[ms.length >> 1] : null, worstMs: ms.length ? ms[ms.length - 1] : null };
}
export function stop() { if (G.raf) cancelAnimationFrame(G.raf); G.raf = null; G.last = 0; }

export function renderBlockMan(s, state, h) {
  G.state = state; G.h = h;
  if (!G.maze) { G.maze = parseMaze(); reset(); }
  const wrap = el('bmWrap');
  if (wrap) wrap.classList.remove('idle');
  if (!G.raf && globalThis.requestAnimationFrame) { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else draw();
}
