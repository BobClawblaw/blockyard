// TETRUST, the tab (operator, 2026-09-12: "Add a new tab called 'Tetrust' - I want it to be a
// playable tetris game using our 3d Engine. Pauses when you tab away, and has a Resume play
// button. Make the Tetris game absolutely beautiful leveraging our framework ... Add score. Add a
// high score table").
//
// The rules live in tetris.js and know nothing of the screen. This file is the screen: the well
// is the same board3d the Markets and Block space boards use, with the same oblique camera, the
// same stones, and every finish the display settings offer -- stars, the galaxy, neon edges, the
// sheen -- because it spreads spaceOptions(loadSettings()) exactly as the Block space board does.
// The game inherits the whole framework rather than imitating it.
import { board3d } from './details3d.js';
import { loadSettings, spaceOptions } from './settings.js';
import { newGame, tick, move, rotate, softDrop, hardDrop, tiles, previewTiles, peekNext, gravityMs, COLS, ROWS } from './tetris.js';

const SCORES_KEY = 'bmc.tetrust.scores';
const KEEP = 10;

// the well's camera: the Block space look (an oblique board, cubes with height) on a flat,
// tall well. `still` so a key press lands where you pressed it; no idle effects while playing.
const WELL = {
  gridW: COLS, gridH: ROWS,
  oblique: { ox: 0.10, oy: 0.30, headroom: 3, flight: 0 },
  dome: 1,
  gridStep: 1,
  space: true,
  background: 'rgba(2,6,10,1)',
  neonCell: 'rgba(60,200,140,0.18)',
};
const PREVIEW = { gridW: 4, gridH: 4, oblique: { ox: 0.10, oy: 0.30, headroom: 2, flight: 0 }, dome: 0, gridStep: 1, space: false, background: 'rgba(2,6,10,1)', grid: false };

const G = { game: null, running: false, paused: false, why: '', raf: null, last: 0, acc: 0, dirty: true, bound: false, state: null, h: null, celebrate: 0 };

function opts(base) {
  // the operator's display settings, then the game's own non-negotiables on top
  return { ...base, ...spaceOptions(loadSettings()), transition: { rise: 0, travel: 1, drop: 0 }, idleFx: false, dome: base.dome, gridStep: base.gridStep, grid: base.grid ?? true };
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
  const list = [...loadScores(storage), { score: entry.score, lines: entry.lines, level: entry.level, at: entry.at ?? Date.now() }]
    .sort((a, b) => b.score - a.score || b.lines - a.lines)
    .slice(0, KEEP);
  try { storage?.setItem(SCORES_KEY, JSON.stringify(list)); } catch { /* private mode, quota */ }
  return list;
}
/** Where a score would land in the table, 1-based, or null if it would not make it. */
export function rankOf(score, list) {
  const i = list.findIndex((r) => score > r.score);
  if (i >= 0) return i + 1;
  return list.length < KEEP ? list.length + 1 : null;
}

// ------------------------------------------------------------------ the screen
const el = (id) => document.getElementById(id);

function overlay(msg, sub, button) {
  const ov = el('tetOver'), m = el('tetMsg'), s = el('tetSub'), b = el('tetResume');
  if (!ov) return;
  ov.classList.toggle('hidden', !msg);
  if (m) m.textContent = msg ?? '';
  if (s) s.textContent = sub ?? '';
  if (b) b.textContent = button ?? 'play';
}

function drawStats() {
  const g = G.game, box = el('tetStats');
  if (!box) return;
  const rows = g
    ? [['score', g.score.toLocaleString()], ['lines', String(g.lines)], ['level', String(g.level)], ['pieces', String(g.pieces)], ['gravity', `${gravityMs(g.level)} ms`]]
    : [['score', '–'], ['lines', '–'], ['level', '–']];
  const html = rows.map(([k, v]) => `<i>${k}</i><b>${v}</b>`).join('');
  if (box.innerHTML !== html) box.innerHTML = html;
}

function drawScores(highlightAt = null) {
  const t = el('tetScores');
  if (!t) return;
  const list = loadScores();
  const html = list.length
    ? `<tr><th>#</th><th>score</th><th>lines</th><th>lvl</th><th>when</th></tr>` + list.map((r, i) =>
      `<tr${r.at === highlightAt ? ' class="now"' : ''}><td>${i + 1}</td><td>${r.score.toLocaleString()}</td><td>${r.lines}</td><td>${r.level}</td><td>${new Date(r.at).toISOString().slice(0, 10)}</td></tr>`).join('')
    : `<tr><td class="faint">no verified blocks yet — clear a line</td></tr>`;
  if (t.innerHTML !== html) t.innerHTML = html;
}

function draw() {
  const g = G.game;
  const well = el('tetWell');
  if (well && g) board3d(well, tiles(g), opts(WELL));
  const nx = el('tetNext');
  if (nx) board3d(nx, previewTiles(g ? peekNext(g) : null), opts(PREVIEW));
  drawStats();
}

// ------------------------------------------------------------------ the loop
function frame(t) {
  G.raf = null;
  if (!G.running) return;
  // PAUSE WHEN YOU LOOK AWAY: another browser tab, or another tab of this app. A game that keeps
  // falling while you read the Mempool page is a game you come back to lost.
  if (document.hidden || G.state?.page !== 'tetrust') { pause(document.hidden ? 'paused — you looked away' : 'paused — you changed tabs'); return; }
  const dt = G.last ? Math.min(250, t - G.last) : 0;
  G.last = t;
  G.acc += dt;
  const g = G.game;
  const ms = gravityMs(g.level);
  while (G.acc >= ms && !g.over) { G.acc -= ms; if (tick(g)) G.dirty = true; else G.dirty = true; }
  if (g.cleared?.length) { G.celebrate = 6; g.cleared = []; }
  if (g.over) { gameOver(); return; }
  if (G.dirty) { draw(); G.dirty = false; }
  G.raf = requestAnimationFrame(frame);
}

function start() {
  G.game = newGame();
  G.running = true; G.paused = false; G.acc = 0; G.last = 0; G.dirty = true;
  overlay(null);
  drawScores();
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function pause(why) {
  if (!G.running || G.paused) return;
  G.paused = true; G.why = why;
  overlay(why, 'the stack is holding', 'resume');
  G.h?.toast?.(why);
}

function resume() {
  if (!G.running) { start(); return; }
  if (!G.paused) return;
  G.paused = false; G.last = 0; G.dirty = true;
  overlay(null);
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function gameOver() {
  const g = G.game;
  G.running = false; G.paused = false;
  draw();
  const list = loadScores();
  const rank = rankOf(g.score, list);
  const at = Date.now();
  if (rank) recordScore({ score: g.score, lines: g.lines, level: g.level, at });
  drawScores(rank ? at : null);
  overlay(
    `verified ${g.lines} line${g.lines === 1 ? '' : 's'}`,
    `${g.score.toLocaleString()} points at level ${g.level}${rank ? ` — #${rank} on this browser` : ''}. Trust, but verify.`,
    'play again',
  );
}

// ------------------------------------------------------------------ input
function onKey(e) {
  if (G.state?.page !== 'tetrust') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Enter') { e.preventDefault(); resume(); return; }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { if (G.running) { e.preventDefault(); G.paused ? resume() : pause('paused'); } return; }
  if (!G.running || G.paused || !G.game || G.game.over) return;
  const g = G.game;
  let used = true;
  switch (e.key) {
    case 'ArrowLeft': move(g, -1); break;
    case 'ArrowRight': move(g, 1); break;
    case 'ArrowUp': case 'x': case 'X': rotate(g, 1); break;
    case 'z': case 'Z': rotate(g, -1); break;
    case 'ArrowDown': softDrop(g); break;
    case ' ': hardDrop(g); break;
    default: used = false;
  }
  if (used) { e.preventDefault(); G.dirty = true; if (g.over) gameOver(); }
}

function bind() {
  if (G.bound) return;
  G.bound = true;
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.running && !G.paused) pause('paused — you looked away'); });
  el('tetResume')?.addEventListener('click', () => resume());
}

export function renderTetrust(s, state, h) {
  G.state = state; G.h = h;
  bind();
  if (!G.game) { overlay('Tetrust', 'trust, but verify — every line you clear is a block you verified. Enter or the button to play; arrows move, ↑ rotates, space drops.', 'play'); drawStats(); drawScores(); draw(); return; }
  if (G.running && G.paused) overlay(G.why, 'the stack is holding', 'resume');
  // a render while we are the page and not paused: keep the loop alive
  if (G.running && !G.paused && !G.raf) { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else G.dirty = true, draw();
}
