// TETRUST, the tab (operator, 2026-09-12: "Add a new tab called 'Tetrust' - I want it to be a
// playable tetris game using our 3d Engine. Pauses when you tab away, and has a Resume play
// button. Make the Tetris game absolutely beautiful leveraging our framework ... Add score. Add a
// high score table").
//
// The rules live in tetris.js and know nothing of the screen. This file is the screen: the well
// is the same board3d the Markets and Block space boards use, with the same oblique camera and
// the same domed board ("Make it spherical like our default display"), and the panel behind it is
// the same sky (drawSky). The game inherits the framework rather than imitating it.
import { board3d } from './details3d.js';
import { newGame, tick, move, rotate, softDrop, hardDrop, tiles, previewTiles, peekNext, gravityMs, PIECES, COLS, ROWS } from './tetris.js';
import { loadSettings, setSetting, tetrustOptions } from './settings.js';
import * as sound from './tetsound.js';

const SCORES_KEY = 'bmc.tetrust.scores';
const KEEP = 10;

// the well's camera: the Block space look (an oblique board, cubes with height, the sphere) on a
// tall well. `still` so a key press lands where you pressed it; no idle effects while playing.
const WELL = {
  gridW: COLS, gridH: ROWS,
  oblique: { ox: 0.10, oy: 0.30, headroom: 3, flight: 0 },
  dome: 5,                              // the default board's sphere (operator: "spherical like our default display")
  gridStep: 1,
  space: true,
  background: 'rgba(0,0,0,0)',          // clear: the panel's sky shows through ("Fill the entire panel with black")
  spaceFloor: 'rgba(0,0,0,0.22)',       // and through the board itself ("The playfield needs to be transparent to show the stars and galaxy behind it")
  neonCell: 'rgba(60,200,140,0.18)',
};
const PREVIEW = { gridW: 4, gridH: 4, oblique: { ox: 0.10, oy: 0.30, headroom: 2, flight: 0 }, dome: 0, gridStep: 1, space: false, background: 'rgba(0,0,0,1)', grid: false };

// THE SKY (operator: "Have this entire panel filled black and rendering the spiral galaxy for this
// display. Have the text floating over the spiral galaxy, and then the playboard gets drawn when
// you hit play"): the panel's own canvas behind the title and the well, an empty board with no
// floor and no grid -- so nothing but black and the star field -- carrying the game's switches
// for the sky and the galaxy and the display's choices for what the sky is made of. Its own
// canvas, so the game's every-key-press repaint of the well never touches a star.
// `maxDpr: 1`: the sky is drawn at one device pixel per CSS pixel whatever the screen has. The
// star count follows the pixel count, so on a 2x screen that is a quarter of the stars a frame --
// and a panel-sized galaxy at 2x made the game stutter ("The galaxy rendering is really slow in
// teh game display. smooth that shit out"). Stars are points; nobody can tell.
const SKY = { gridW: COLS, gridH: ROWS, oblique: { ox: 0.10, oy: 0.30, headroom: 3, flight: 0 }, dome: 0, space: false, grid: false, background: 'rgba(0,0,0,1)', idleFx: false, shadows: false, still: true, transition: { rise: 0, travel: 1, drop: 0 }, maxDpr: 1 };

// THE DRIFT (operator: "have the block pieces drift up and away and completing lines"): a cleared
// line's cells rise off the board and fade to the black behind them over this long
const DRIFT_MS = 720;
const DRIFT_RISE = 9;                   // units of height at the end of the drift

const G = {
  game: null, running: false, paused: false, why: '', raf: null, last: 0, acc: 0, dirty: true, bound: false,
  state: null, h: null, nextKind: undefined,
  drift: [],                            // { id, x, y, color, dx, t0 } cells on their way up
};

function opts(base) {
  // FAST AND PLAIN (operator, 2026-09-12: "the movement is way too slow. We need to stop all
  // effects, and just treat the blocks differently ... Smaller, faster, playable! No effects for
  // in-motion blocks"). The first cut inherited every display setting, and a forty-thousand-star
  // galaxy behind a 2.4-megapixel well is not a game. The well draws the well and -- only when
  // the game's own switch says so -- the sky behind it: no idle effects, no shadows, flat cubes
  // with their edges, no finishes on the pieces, and every move lands at once.
  return {
    ...base,
    // `space: true` is the plain translucent floor (no deck texture, no dots). The first cut had
    // space off and got the textured deck back, and its per-cell neon glow turned the well into a
    // loud green lattice: the glow and the halo are silenced here, and the grid is a quiet line.
    space: true, idleFx: false, shadows: false,
    // no sky on the well itself: the sky is the panel's canvas behind it (drawSky)
    stars: false, galaxy: false,
    neonHalo: 'rgba(0,0,0,0)', gridGlow: 'rgba(0,0,0,0)', neonCell: 'rgba(60,200,140,0.06)',
    edges: true, facetPx: Infinity, crownPx: Infinity, neon: false, sheen: false,
    // STILL: drawn as laid, no choreography at all. A transition of zero was not enough -- the
    // planner's per-tile stagger (seconds between one cube's drop and the next) still applied,
    // and a piece's four cells came down one after another instead of as one shape.
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

// ------------------------------------------------------------------ the drift
/**
 * The tiles of the cells on their way up, at `now`: each rises on an ease-out, slides a little
 * to its own side, and darkens to the black behind it. The engine's still plan pins z and alpha
 * (a still board is a still board), so the rise is the tile's FLOOR and the fade is its colour.
 */
export function driftTiles(drift, now, ms = DRIFT_MS) {
  const out = [];
  for (const d of drift) {
    const t = Math.min(1, Math.max(0, (now - d.t0) / ms));
    if (t >= 1) continue;
    const e = 1 - (1 - t) * (1 - t);                  // ease out: quick off the board, slowing as it goes
    const k = 1 - t * t;                              // the fade: full colour on the way up, gone at the end
    out.push({ txid: `d${d.id}`, x: d.x + d.dx * e, y: d.y, s: 1, tall: 1, floor: DRIFT_RISE * e, color: fade(d.color, k) });
  }
  return out;
}
function fade(hex, k) {
  const h = hex.replace('#', '');
  const ch = (i) => Math.round(parseInt(h.slice(i, i + 2), 16) * k);
  return `#${[ch(0), ch(2), ch(4)].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}
function startDrift(cells, now) {
  for (const c of cells) G.drift.push({ id: c.id, x: c.x, y: c.y, color: PIECES[c.k].color, dx: (c.x - (COLS - 1) / 2) * 0.12, t0: now });
}

// ------------------------------------------------------------------ the screen
const el = (id) => document.getElementById(id);

function overlay(msg, sub, button, dim = false) {
  const ov = el('tetOver'), m = el('tetMsg'), s = el('tetSub'), b = el('tetResume');
  if (!ov) return;
  ov.classList.toggle('hidden', !msg);
  ov.classList.toggle('dim', dim);      // clear over the sky; dimmed over a held or finished board
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

// THE GAME'S OWN SWITCHES (operator: "Toggle for each in the game display"): three buttons on the
// HUD, the same settings the Display panel shows, so a flip in either place is a flip in both
const SWITCHES = [['tetStars', 'stars'], ['tetGalaxy', 'galaxy'], ['tetMusic', 'music'], ['tetSfx', 'sfx']];
function drawSwitches() {
  const t = tetrustOptions(loadSettings());
  for (const [id, key] of SWITCHES) {
    const b = el(id);
    if (!b) continue;
    b.classList.toggle('on', !!t[key]);
    b.setAttribute('aria-pressed', t[key] ? 'true' : 'false');
  }
  applySound(t);
}
function applySound(t) {
  sound.setSfx(t.sfx);
  // the tune plays while the game runs; a pause holds it; the switch off stops it
  sound.setMusic(t.music && G.running && !G.paused);
}
function flip(key) {
  const cur = tetrustOptions(loadSettings())[key];
  setSetting(loadSettings(), `tetrust.${key}`, !cur);
  sound.unlock();
  drawSwitches();
  if (key === 'stars' || key === 'galaxy') drawSky();
  G.dirty = true;
  if (!G.running || G.paused) draw();
}

function drawSky() {
  const sky = el('tetSky');
  if (!sky) return;
  const t = tetrustOptions(loadSettings());
  board3d(sky, [], {
    ...SKY,
    stars: t.stars, galaxy: t.stars && t.galaxy, galaxyAt: t.galaxyAt,
    starDensity: t.starDensity, starBrightness: t.starBrightness,
    nebulae: t.nebulae, galaxies: t.galaxies, dust: t.dust, clusters: t.clusters, starColours: t.starColours, starGlints: t.starGlints,
  });
}

function draw(now = performance.now()) {
  const g = G.game;
  const well = el('tetWell');
  el('tetWellWrap')?.classList.toggle('idle', !g);   // the board is drawn when you hit play
  if (well && g) board3d(well, [...tiles(g), ...driftTiles(G.drift, now)], opts(WELL));
  // the preview only when the next piece changes: it is a second board, and redrawing it on
  // every key press was paying for two scenes per move
  const nk = g ? peekNext(g) : null;
  if (nk !== G.nextKind) {
    G.nextKind = nk;
    const nx = el('tetNext');
    if (nx) board3d(nx, previewTiles(nk), opts({ ...PREVIEW, stars: false }));
  }
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
  const levelBefore = g.level;
  while (G.acc >= ms && !g.over) { G.acc -= ms; if (tick(g)) { G.dirty = true; afterLock(g, t); } else G.dirty = true; }
  if (g.level > levelBefore) sound.play('level');
  if (g.over) { gameOver(); return; }
  // the drift keeps the loop drawing until the last cell has gone
  if (G.drift.length) {
    G.drift = G.drift.filter((d) => t - d.t0 < DRIFT_MS);
    G.dirty = true;
  }
  if (G.dirty) { draw(t); G.dirty = false; }
  G.raf = requestAnimationFrame(frame);
}

// what happens when a piece locks: the sound of it, and the lines it made leaving
function afterLock(g, now) {
  if (g.cleared?.length) {
    startDrift(g.clearedCells ?? [], now);
    sound.play(g.cleared.length >= 4 ? 'tetris' : 'clear');
    g.cleared = []; g.clearedCells = [];
  } else sound.play('lock');
}

function start() {
  G.game = newGame();
  G.drift = [];
  G.running = true; G.paused = false; G.acc = 0; G.last = 0; G.dirty = true;
  overlay(null);
  drawScores();
  sound.unlock();
  drawSwitches();
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function pause(why) {
  if (!G.running || G.paused) return;
  G.paused = true; G.why = why;
  overlay(why, 'the stack is holding', 'resume', true);
  sound.holdMusic(true);
  G.h?.toast?.(why);
}

function resume() {
  if (!G.running) { start(); return; }
  if (!G.paused) return;
  G.paused = false; G.last = 0; G.dirty = true;
  overlay(null);
  sound.unlock();
  sound.holdMusic(false);
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function gameOver() {
  const g = G.game;
  G.running = false; G.paused = false;
  sound.setMusic(false);
  sound.play('over');
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
    true,
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
  // arrows or WASD (operator: "Add WASD for tetris controls as well")
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': if (move(g, -1)) sound.play('move'); break;
    case 'ArrowRight': case 'd': case 'D': if (move(g, 1)) sound.play('move'); break;
    case 'ArrowUp': case 'w': case 'W': case 'x': case 'X': if (rotate(g, 1)) sound.play('rotate'); break;
    case 'z': case 'Z': case 'q': case 'Q': if (rotate(g, -1)) sound.play('rotate'); break;
    case 'ArrowDown': case 's': case 'S': if (softDrop(g)) afterLock(g, performance.now()); else sound.play('soft'); break;
    case ' ': hardDrop(g); sound.play('drop'); afterLock(g, performance.now()); break;
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
  for (const [id, key] of SWITCHES) el(id)?.addEventListener('click', () => flip(key));
}

export function renderTetrust(s, state, h) {
  G.state = state; G.h = h;
  bind();
  drawSwitches();
  drawSky();
  if (!G.game) { overlay('Tetrust', 'trust, but verify — every line you clear is a block you verified. Enter or the button to play; arrows move, ↑ rotates, space drops.', 'play'); drawStats(); drawScores(); draw(); return; }
  if (G.running && G.paused) overlay(G.why, 'the stack is holding', 'resume', true);
  // a render while we are the page and not paused: keep the loop alive
  if (G.running && !G.paused && !G.raf) { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else G.dirty = true, draw();
}
