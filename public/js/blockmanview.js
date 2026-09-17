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
import { paintDots, paintBlockMan, paintPursuers, paintPops, paintTargets, paintFruit, paintDeath, pulseMs } from './blockmanfx.js';
import { newGame, stepGame, restart, remaining, DIRS } from './blockman.js';
import { play, setSfx, setMusic, unlock } from './tetsound.js';

// ONE COLOUR A LEVEL (M5), round a ring of five: the maze is the same maze every level, and its
// colour is how a player knows how deep they are without reading the panel.
export const WALL_COLOURS = Object.freeze(['#2a3ac8', '#1f8f6b', '#a3357f', '#b4761c', '#3c3f8f']);
export const FLASH_COLOUR = '#f2f6ff';
export function wallColourFor(level) { return WALL_COLOURS[(Math.max(1, level) - 1) % WALL_COLOURS.length]; }
/** `#rrggbb` darkened, for the border's own shade of the level's colour. */
function shadeHex(hex, k) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k).toString(16).padStart(2, '0')).join('')}`;
}

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
  maze: null, game: null, board: { dots: [], pellets: [] }, pops: [],
  raf: null, last: 0, mazeKey: null, paused: false, bound: false, targets: false,
  death: null, dotFlip: false, pulseAt: 0, sfx: true, music: false,
  frames: 0, frameMs: [], paintNow: 0,
  h: null, state: null,
};

const el = (id) => document.getElementById(id);

/** Every wall tile as a cube for the scene builder; the pen's box included, its interior darker. */
export function wallTiles(m, level = 1, flash = false) {
  const out = [];
  const wall = flash ? FLASH_COLOUR : wallColourFor(level);
  const rim = flash ? FLASH_COLOUR : shadeHex(wall, 0.7);
  const penSet = new Set(m.pen.map((p) => `${p.x},${p.y}`));
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.at(x, y) === OPEN) continue;
      const pen = penSet.has(`${x},${y}`);
      const edge = x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1;
      out.push({
        txid: `w${x}:${y}`, x, y, s: 1, tall: pen ? 0.5 : 1,
        color: pen ? '#141a3c' : (edge ? rim : wall),
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

// ------------------------------------------------------------------------------ the game and keys
const KEYS = Object.freeze({
  ArrowLeft: DIRS.left, ArrowRight: DIRS.right, ArrowUp: DIRS.up, ArrowDown: DIRS.down,
  a: DIRS.left, d: DIRS.right, w: DIRS.up, s: DIRS.down,
});

function start() {
  G.game = newGame({ maze: G.maze ?? (G.maze = parseMaze()) });
  G.pops = []; G.paused = false; G.death = null; G.pulseAt = 0;
  setSfx(G.sfx);
  play('bmStart');
  refreshBoard();
  overlay(null);
}

function refreshBoard() { G.board = G.game ? remaining(G.game) : { dots: [], pellets: [] }; }

function overlay(msg, sub = '', button = null) {
  const box = el('bmOver'), m = el('bmMsg'), s2 = el('bmSub'), b = el('bmResume');
  if (!box) return;
  box.classList.toggle('hidden', !msg);
  if (m && msg) m.textContent = msg;
  if (s2) s2.textContent = msg ? sub : '';
  if (b) b.textContent = button ?? 'play';
}

function onKey(e) {
  if (!document.querySelector('section.page[data-page="blockman"]:not(.hidden)')) return;
  const want = KEYS[e.key] ?? KEYS[String(e.key).toLowerCase()];
  if (want && G.game) { G.game.man.want = want; e.preventDefault(); return; }
  if (e.key === 'p' || e.key === 'P') { G.paused = !G.paused; overlay(G.paused ? 'Paused' : null, 'P to go on', 'go on'); e.preventDefault(); }
  else if (e.key === 'F2') { if (G.game) restart(G.game); else start(); G.paused = false; refreshBoard(); overlay(null); e.preventDefault(); }
  else if (e.key === 'Enter' && (!G.game || G.game.phase === 'over')) { start(); e.preventDefault(); }
  else if (e.key === 't' || e.key === 'T') { setTargets(!G.targets); e.preventDefault(); }
  else if (e.key === 'm' || e.key === 'M') { setTune(!G.music); e.preventDefault(); }
}

/** The sound and the music switches; the panel buttons and the keys are the same thing. */
export function setSound(on) {
  G.sfx = !!on;
  setSfx(G.sfx);
  const b = typeof document === 'undefined' ? null : el('bmSfx');
  if (b) { b.setAttribute('aria-pressed', String(G.sfx)); b.classList.toggle('on', G.sfx); }
}
export function setTune(on) {
  G.music = !!on;
  setMusic(G.music, 'blockman');
  const b = typeof document === 'undefined' ? null : el('bmMusic');
  if (b) { b.setAttribute('aria-pressed', String(G.music)); b.classList.toggle('on', G.music); }
}

/** Cheat mode: draw each pursuer's target tile. The switch and the T key are the same thing. */
export function setTargets(on) {
  G.targets = !!on;
  const b = typeof document === 'undefined' ? null : el('bmTargets');   // the tests have no DOM
  if (b) { b.setAttribute('aria-pressed', String(G.targets)); b.classList.toggle('on', G.targets); }
}

function bind() {
  if (G.bound) return;
  G.bound = true;
  document.addEventListener('keydown', onKey);
  el('bmTargets')?.addEventListener('click', () => setTargets(!G.targets));
  el('bmSfx')?.addEventListener('click', () => { unlock(); setSound(!G.sfx); });
  el('bmMusic')?.addEventListener('click', () => { unlock(); setTune(!G.music); });
  document.addEventListener('keydown', () => unlock(), { once: true });      // audio needs a gesture
  el('bmResume')?.addEventListener('click', () => {
    if (!G.game || G.game.phase === 'over') start();
    else { G.paused = false; overlay(null); }
  });
}

// ------------------------------------------------------------------------------ the painted layer
function paintPlay(ctx, view, hx) {
  const m = G.maze;
  if (!m) return;
  const P = (x, y, z = 1.1) => hx.project(x, y, z, view);
  const o0 = P(0, 0), ox = P(1, 0), oy = P(0, 1);
  const U = { x: Math.abs(ox.x - o0.x) || 8, y: Math.abs(oy.y - o0.y) || 8 };
  const g = G.game;
  paintDots(ctx, P, U, { dots: G.board.dots, pellets: G.board.pellets, now: G.paintNow });
  if (!g) return;
  if (g.fruit) paintFruit(ctx, P, U, { x: g.fruit.x + 0.5, y: g.fruit.y + 0.5, colour: g.fruit.colour });
  paintPursuers(ctx, P, U, g.pursuers, { now: G.paintNow });
  if (G.targets) paintTargets(ctx, P, U, g.pursuers);
  if (g.phase === 'dying') paintDeath(ctx, P, U, G.death, G.paintNow);
  else paintBlockMan(ctx, P, U, g.man, { now: G.paintNow });
  paintPops(ctx, P, U, G.pops, G.paintNow);
}

function draw(now = performance.now()) {
  const m = G.maze;
  const maze = el('bmMaze'), play = el('bmPlay');
  if (!m || !maze || !play) return;
  const opts = { ...BOARD, gridW: m.w, gridH: m.h };
  // BUILT ONCE A LEVEL, and once per frame of the level-clear flash: 262 cubes at about 10 ms is
  // affordable a few times a second and not affordable sixty times.
  const level = G.game?.level ?? 1;
  const flash = G.game?.phase === 'level' && Math.floor(now / 180) % 2 === 0;
  const wantKey = `${m.w}x${m.h}:${level}:${flash ? 1 : 0}`;
  if (G.mazeKey !== wantKey) {
    board3d(maze, wallTiles(m, level, flash).sort(mazeOrder), { ...opts, order: 'given', background: '#05080f' });
    G.mazeKey = wantKey;
  }
  G.paintNow = now;
  board3d(play, [], { ...opts, background: 'rgba(0,0,0,0)', spaceFloor: 'rgba(0,0,0,0)', neonCell: 'rgba(0,0,0,0)', overlay: paintPlay });
  const hud = el('bmStats');
  const g = G.game;
  if (hud && g) {
    const fps = G.frameMs.length > 8 ? Math.round(1000 / (G.frameMs.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, G.frameMs.length))) : null;
    const html = `<dt>score</dt><dd>${g.score.toLocaleString('en-GB')}</dd>`
      + `<dt>lives</dt><dd>${'▮'.repeat(Math.max(0, g.lives))}${g.lives ? '' : '—'}</dd>`
      + `<dt>level</dt><dd>${g.level}</dd>`
      + `<dt>dots left</dt><dd>${g.dots.size + g.pellets.size}</dd>`
      + (g.frightenedMs ? `<dt>frightened</dt><dd>${(g.frightenedMs / 1000).toFixed(1)}s</dd>` : '')
      + (g.fruit ? `<dt>fruit</dt><dd>${g.fruit.points} · ${(g.fruit.leftMs / 1000).toFixed(1)}s</dd>` : '')
      + `<dt>frames</dt><dd>${G.frames}${fps ? ` · ${fps} fps` : ''}</dd>`;
    if (hud.__html !== html) { hud.innerHTML = html; hud.__html = html; }
  }
}

function frame(now) {
  const dt = G.last ? Math.min(60, now - G.last) : 16;
  if (G.last) G.frameMs.push(now - G.last);
  if (G.frameMs.length > 240) G.frameMs.shift();
  G.last = now;
  G.frames += 1;
  const g = G.game;
  if (g && !G.paused) {
    const before = g.dots.size + g.pellets.size;
    stepGame(g, dt);
    if (g.dots.size + g.pellets.size !== before) refreshBoard();
    drain(g, now);
    // THE PULSE: a low tick whose tempo follows how much is left on the board (blockmanfx.pulseMs)
    if (g.phase === 'play') {
      const total = G.maze.dots.length + G.maze.pellets.length;
      const every = pulseMs(g.dots.size + g.pellets.size, total);
      if (now - G.pulseAt >= every) { G.pulseAt = now; play('bmPulse'); }
    }
  }
  draw(now);
  G.raf = requestAnimationFrame(frame);
}

// WHAT EACH EVENT SOUNDS LIKE (M5, §6). Ours, on the tone generator the other games use: the dot
// alternates two blips so a corridor has a rhythm rather than one repeated note.
export const SOUND_OF = Object.freeze({
  dot: 'bmDotA', pellet: 'bmPellet', ate: 'bmAte', ateFruit: 'bmFruit',
  caught: 'bmDeath', level: 'bmLevel', life: 'bmLife',
});
function sound(e) {
  if (e.kind === 'dot') { play(G.dotFlip ? 'bmDotB' : 'bmDotA'); G.dotFlip = !G.dotFlip; return; }
  const name = SOUND_OF[e.kind];
  if (name) play(name);
}

/** What the rules said happened this frame: the screen's business. */
function drain(g, now) {
  if (!g.events.length) return;
  for (const e of g.events) {
    sound(e);
    if (e.kind === 'caught') G.death = { x: g.man.x, y: g.man.y, t0: now };
    if (e.kind === 'ate' || e.kind === 'ateFruit') G.pops.push({ x: e.x + (e.kind === 'ateFruit' ? 0.5 : 0), y: e.y, text: e.points, t0: now });
    else if (e.kind === 'level') { refreshBoard(); overlay(`Level ${e.level} cleared`, 'the maze fills again, and everyone is faster'); }
    else if (e.kind === 'caught') overlay(g.lives > 0 ? 'Caught' : 'Game over', g.lives > 0 ? `${g.lives} to go` : 'F2 or the button to play again', g.lives > 0 ? 'go on' : 'again');
    else if (e.kind === 'over') overlay('Game over', `${g.score.toLocaleString('en-GB')} · F2 or the button to play again`, 'again');
  }
  g.events.length = 0;
  G.pops = G.pops.filter((p) => now - p.t0 < 900);
  if (g.phase === 'play') overlay(null);
}

/** For the tests and the measurement script: the walk's state, and the frame times it has seen. */
export function currentPlay() { return { maze: G.maze, game: G.game, man: G.game?.man ?? null, pursuers: G.game?.pursuers ?? [], dots: G.board.dots, pellets: G.board.pellets }; }
export function currentGame() { return G.game; }
export function frameStats() {
  const ms = G.frameMs.slice().sort((a, b) => a - b);
  return { frames: G.frames, medianMs: ms.length ? ms[ms.length >> 1] : null, worstMs: ms.length ? ms[ms.length - 1] : null };
}
export function stop() { if (G.raf) cancelAnimationFrame(G.raf); G.raf = null; G.last = 0; }

export function renderBlockMan(s, state, h) {
  G.state = state; G.h = h;
  if (!G.maze) G.maze = parseMaze();
  bind();
  setTargets(G.targets);
  setSound(G.sfx);
  setTune(G.music);
  const wrap = el('bmWrap');
  if (wrap) wrap.classList.toggle('idle', !G.game);
  if (!G.game) overlay('BlockMan', 'clear the maze, keep away from the four: ← → ↑ ↓ or WASD to turn, P pauses, F2 starts again. Enter or the button to play.', 'play');
  if (!G.raf && globalThis.requestAnimationFrame) { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else draw();
}
