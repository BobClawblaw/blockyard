// BLOCKOUT, the tab (operator, 2026-09-12: "take the classic Atari Breakout game, and make a clone
// of it, in another tab, using our engine, with mouse control for moving the pad left and right.
// Call it 'Blockout' and put it next to the Tetrust Tab. Also support keys for moving left and
// right").
//
// The rules live in breakout.js and know nothing of the screen. This file is the screen: the court
// is the same board3d the Block space and Tetrust boards use -- same oblique camera, same curved
// surface, same stones -- and the panel behind it is the same sky. The bricks are one grid cell
// each, so a brick is literally an engine tile.
import { board3d } from './details3d.js';
import {
  newGame, advance, step, movePaddle, nudge, launch, tiles, remaining,
  COLS, ROWS, LIVES,
} from './breakout.js';
import { loadSettings, setSetting, blockoutOptions } from './settings.js';
import * as sound from './tetsound.js';

const SCORES_KEY = 'bmc.blockout.scores';
const KEEP = 10;

// the court: the Block space look on a board as wide as it is tall enough to fall through.
// `still` so the ball is drawn exactly where the rules put it, every frame.
const COURT = {
  gridW: COLS, gridH: ROWS,
  oblique: { ox: 0.10, oy: 0.28, headroom: 3, flight: 0 },
  dome: 4,
  light: 'overhead',                    // the floor rows are where the paddle lives: no shade there
  gridStep: 1,
  space: true,
  background: 'rgba(0,0,0,0)',          // the panel's sky shows through
  spaceFloor: 'rgba(0,0,0,0.22)',
  neonCell: 'rgba(60,200,140,0.18)',
};
const SKY = { gridW: COLS, gridH: ROWS, oblique: COURT.oblique, dome: 0, space: false, grid: false, background: 'rgba(0,0,0,1)', idleFx: false, shadows: false, still: true, transition: { rise: 0, travel: 1, drop: 0 }, maxDpr: 1 };

const KEY_NUDGE = 1.15;                 // grid units per key press, before the repeat takes over

const G = {
  game: null, running: false, paused: false, why: '', raf: null, last: 0, dirty: true,
  bound: false, state: null, h: null, held: { left: false, right: false },
};

function opts(base) {
  const b = blockoutOptions(loadSettings());
  return {
    ...base,
    // the court draws the court: no sky on this canvas (the panel behind it has one), no idle
    // effects, no shadows, and every frame drawn exactly as laid -- a ball that lags the rules is
    // a ball you cannot aim
    space: true, stars: false, galaxy: false, idleFx: false, shadows: false,
    hover: false,                           // the pointer is holding the bat, not picking out a stone
    neonHalo: 'rgba(0,0,0,0)', gridGlow: 'rgba(0,0,0,0)',
    edges: true, facetPx: Infinity, crownPx: Infinity, sheen: false,
    neon: b.neon, neonSource: b.neonSource, neonColour: b.neonColour, neonBrightness: b.neonBrightness,
    still: true,
    transition: { rise: 0, travel: 1, drop: 0 },
  };
}

// ------------------------------------------------------------------ scores, this browser's
export function loadScores(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(SCORES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((r) => r && Number.isFinite(r.score)).slice(0, KEEP) : [];
  } catch { return []; }
}
export function recordScore(entry, storage = globalThis.localStorage) {
  const list = [...loadScores(storage), { score: entry.score, level: entry.level, at: entry.at ?? Date.now() }]
    .sort((a, b) => b.score - a.score || b.level - a.level)
    .slice(0, KEEP);
  try { storage?.setItem(SCORES_KEY, JSON.stringify(list)); } catch { /* private mode, quota */ }
  return list;
}
/** Where a score would land, 1-based, or null if it would not make the table. */
export function rankOf(score, list) {
  const i = list.findIndex((r) => score > r.score);
  if (i >= 0) return i + 1;
  return list.length < KEEP ? list.length + 1 : null;
}

// ------------------------------------------------------------------ the screen
const el = (id) => document.getElementById(id);

function overlay(msg, sub, button, dim = false) {
  const ov = el('boOver'), m = el('boMsg'), s = el('boSub'), b = el('boResume');
  if (!ov) return;
  ov.classList.toggle('hidden', !msg);
  ov.classList.toggle('dim', dim);
  if (m) m.textContent = msg ?? '';
  if (s) s.textContent = sub ?? '';
  if (b) b.textContent = button ?? 'play';
}

function drawStats() {
  const g = G.game, box = el('boStats');
  if (!box) return;
  const rows = g
    ? [['score', g.score.toLocaleString()], ['lives', '●'.repeat(Math.max(0, g.lives))], ['level', String(g.level)],
       ['bricks', String(g.bricks.length)], ['wall left', `${Math.round(remaining(g) * 100)}%`]]
    : [['score', '–'], ['lives', '●'.repeat(LIVES)], ['level', '–']];
  const html = rows.map(([k, v]) => `<i>${k}</i><b>${v}</b>`).join('');
  if (box.innerHTML !== html) box.innerHTML = html;
}

function drawScores(highlightAt = null) {
  const t = el('boScores');
  if (!t) return;
  const list = loadScores();
  const html = list.length
    ? `<tr><th>#</th><th>score</th><th>lvl</th><th>when</th></tr>` + list.map((r, i) =>
      `<tr${r.at === highlightAt ? ' class="now"' : ''}><td>${i + 1}</td><td>${r.score.toLocaleString()}</td><td>${r.level}</td><td>${new Date(r.at).toISOString().slice(0, 10)}</td></tr>`).join('')
    : `<tr><td class="faint">no bricks broken yet</td></tr>`;
  if (t.innerHTML !== html) t.innerHTML = html;
}

const SWITCHES = [['boStars', 'stars'], ['boGalaxy', 'galaxy'], ['boNeon', 'neon'], ['boSfx', 'sfx']];
function drawSwitches() {
  const b = blockoutOptions(loadSettings());
  for (const [id, key] of SWITCHES) {
    const btn = el(id);
    if (!btn) continue;
    btn.classList.toggle('on', !!b[key]);
    btn.setAttribute('aria-pressed', b[key] ? 'true' : 'false');
  }
  sound.setSfx(b.sfx);
}
function flip(key) {
  const cur = blockoutOptions(loadSettings())[key];
  setSetting(loadSettings(), `blockout.${key}`, !cur);
  sound.unlock();
  drawSwitches();
  if (key === 'stars' || key === 'galaxy') drawSky();
  G.dirty = true;
  draw();
}

function drawSky() {
  const sky = el('boSky');
  if (!sky) return;
  const b = blockoutOptions(loadSettings());
  board3d(sky, [], {
    ...SKY,
    stars: b.stars, galaxy: b.stars && b.galaxy, galaxyAt: b.galaxyAt,
    starDensity: b.starDensity, starBrightness: b.starBrightness,
    nebulae: b.nebulae, galaxies: b.galaxies, dust: b.dust, clusters: b.clusters,
    starColours: b.starColours, starGlints: b.starGlints,
  });
}

function draw() {
  const g = G.game;
  const court = el('boWell');
  el('boWellWrap')?.classList.toggle('idle', !g);
  if (court && g) board3d(court, tiles(g), opts(COURT));
  drawStats();
}

// ------------------------------------------------------------------ the loop
function frame(t) {
  G.raf = null;
  if (!G.running) return;
  if (document.hidden || G.state?.page !== 'blockout') { pause(document.hidden ? 'paused — you looked away' : 'paused — you changed tabs'); return; }
  const dt = G.last ? t - G.last : 0;
  G.last = t;
  const g = G.game;

  if (G.held.left) nudge(g, -KEY_NUDGE * Math.min(3, dt / 16));
  if (G.held.right) nudge(g, KEY_NUDGE * Math.min(3, dt / 16));

  const r = step(g, dt);
  for (const h of r.hits) {
    if (h.kind === 'brick') sound.play(h.points >= 5 ? 'brickhard' : 'brick');
    else if (h.kind === 'paddle') sound.play('paddle');
    else if (h.kind === 'wall') sound.play('wall');
    else if (h.kind === 'life') sound.play('life');
  }
  if (g.over) { gameOver(); return; }
  if (r.cleared) { levelDone(); return; }
  draw();
  G.raf = requestAnimationFrame(frame);
}

function start() {
  G.game = newGame();
  G.running = true; G.paused = false; G.last = 0; G.dirty = true;
  overlay(null);
  drawScores();
  sound.unlock();
  drawSwitches();
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function pause(why) {
  if (!G.running || G.paused) return;
  G.paused = true; G.why = why;
  overlay(why, 'the ball is holding', 'resume', true);
  G.h?.toast?.(why);
}

function resume() {
  if (!G.running) { start(); return; }
  if (!G.paused) return;
  G.paused = false; G.last = 0;
  overlay(null);
  sound.unlock();
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function levelDone() {
  const g = G.game;
  sound.play('levelup');
  advance(g);
  draw();
  overlay(`wall cleared — level ${g.level}`, `${g.score.toLocaleString()} points. The next wall is faster. Click the court or press space to serve.`, 'serve', true);
  G.paused = true;
  G.h?.toast?.(`level ${g.level}`);
}

function gameOver() {
  const g = G.game;
  G.running = false; G.paused = false;
  sound.play('over');
  draw();
  const list = loadScores();
  const rank = rankOf(g.score, list);
  const at = Date.now();
  if (rank) recordScore({ score: g.score, level: g.level, at });
  drawScores(rank ? at : null);
  overlay('out of balls',
    `${g.score.toLocaleString()} points at level ${g.level}${rank ? ` — #${rank} on this browser` : ''}.`,
    'play again', true);
}

// ------------------------------------------------------------------ input
function serve() {
  const g = G.game;
  if (!g || g.over) return;
  if (G.paused) { G.paused = false; overlay(null); G.last = 0; if (!G.raf) G.raf = requestAnimationFrame(frame); }
  // a little spread so a served ball is never perfectly predictable; the rules stay pure and take
  // the angle as an argument
  launch(g, (Math.random() - 0.5) * 0.7);
}

function onKey(e) {
  if (G.state?.page !== 'blockout') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Enter') { e.preventDefault(); resume(); return; }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { if (G.running) { e.preventDefault(); G.paused ? resume() : pause('paused'); } return; }
  if (!G.running || !G.game || G.game.over) return;
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': G.held.left = true; nudge(G.game, -KEY_NUDGE); break;
    case 'ArrowRight': case 'd': case 'D': G.held.right = true; nudge(G.game, KEY_NUDGE); break;
    case ' ': serve(); break;
    default: return;
  }
  e.preventDefault();
  if (G.paused) draw();
}
function onKeyUp(e) {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') G.held.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') G.held.right = false;
}

// THE MOUSE (operator: "mouse control for moving the pad left and right"). The pointer's position
// across the canvas maps straight to the paddle's centre across the board. The board is drawn under
// an oblique camera, so a pixel is not exactly a grid unit -- but a paddle wants to be WHERE THE
// POINTER IS, not where a projection says the pointer would be on the floor, and this is the
// mapping that feels direct.
function onPointer(e) {
  const g = G.game;
  const court = el('boWell');
  if (!g || !court || g.over) return;
  const r = court.getBoundingClientRect();
  if (!r.width) return;
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  movePaddle(g, f * COLS);
  if (!G.running || G.paused) draw();
}

function bind() {
  if (G.bound) return;
  G.bound = true;
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.running && !G.paused) pause('paused — you looked away'); });
  el('boResume')?.addEventListener('click', () => resume());
  const court = el('boWell');
  court?.addEventListener('pointermove', onPointer);
  court?.addEventListener('pointerdown', (e) => { onPointer(e); serve(); });
  for (const [id, key] of SWITCHES) el(id)?.addEventListener('click', () => flip(key));
}

export function renderBlockout(s, state, h) {
  G.state = state; G.h = h;
  bind();
  drawSwitches();
  drawSky();
  if (!G.game) {
    overlay('Blockout', 'the wall is the block space, and you are holding the bat. Move with the mouse or ← →, serve with the court or space.', 'play');
    drawStats(); drawScores(); draw();
    return;
  }
  if (G.running && G.paused) overlay(G.why, 'the ball is holding', 'resume', true);
  if (G.running && !G.paused && !G.raf) { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else draw();
}
