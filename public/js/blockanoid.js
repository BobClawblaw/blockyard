// BLOCKANOID, the tab (operator, 2026-09-12: "Take blockout, and make rip off of Arkanoid using our
// engine, and make it a new Diversion called 'Blockanoid'").
//
// The rules live in arkanoid.js and know nothing of the screen. This file is the screen, and it is
// deliberately Blockout's shape: the court is the same board3d the Block space, Tetrust and Blockout
// boards use, and the panel behind it is the same sky. What differs is what there is to draw --
// capsules falling, bolts climbing, minions drifting -- and the fact that a brick can survive.
import { board3d } from './details3d.js';
import {
  newGame, advance, step, movePaddle, nudge, launch, fire, tiles, remaining, powers, setOptions,
  COLS, ROWS, LIVES, CAPSULE_LETTER, layoutFor,
} from './arkanoid.js';
import { loadSettings, setSetting, blockanoidOptions } from './settings.js';
import * as sound from './tetsound.js';

const SCORES_KEY = 'blockyard.blockanoid.scores';
const KEEP = 10;

const COURT = {
  gridW: COLS, gridH: ROWS,
  oblique: { ox: 0.10, oy: 0.28, headroom: 3, flight: 0 },
  dome: 4,
  light: 'overhead',
  gridStep: 1,
  space: true,
  background: 'rgba(0,0,0,0)',
  spaceFloor: 'rgba(0,0,0,0.22)',
  neonCell: 'rgba(60,200,140,0.18)',
};
const SKY = { gridW: COLS, gridH: ROWS, oblique: COURT.oblique, dome: 0, space: false, grid: false, background: 'rgba(0,0,0,1)', idleFx: false, shadows: false, still: true, transition: { rise: 0, travel: 1, drop: 0 }, maxDpr: 1 };

const KEY_NUDGE = 1.15;

// A BROKEN BRICK LEAVES, as in Blockout: the same launch Tetrust's cleared lines take.
const DEBRIS_MS = 900;
const DEBRIS_RISE = 70;

const G = {
  game: null, running: false, paused: false, why: '', raf: null, last: 0,
  bound: false, state: null, h: null, held: { left: false, right: false },
  debris: [], nextDebris: 1,
};

export function debrisTiles(debris, now, ms = DEBRIS_MS) {
  const out = [];
  for (const d of debris) {
    const t = Math.min(1, Math.max(0, (now - d.t0) / ms));
    if (t >= 1) continue;
    const e = t * t * (3 - 2 * t) * 0.35 + t * t * 0.65;
    const k = t < 0.82 ? 1 : 1 - (t - 0.82) / 0.18;
    out.push({ txid: `k${d.id}`, x: d.x + d.dx * e, y: d.y, s: 1, tall: 1,
      floor: DEBRIS_RISE * e, color: fadeHex(d.color, k) });
  }
  return out;
}
function fadeHex(hex, k) {
  const h = hex.replace('#', '');
  const ch = (i) => Math.max(0, Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) * k)));
  return `#${[ch(0), ch(2), ch(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function opts(base) {
  const b = blockanoidOptions(loadSettings());
  return {
    ...base,
    space: true, stars: false, galaxy: false, idleFx: false, shadows: false,
    hover: false,                           // the pointer is holding Vaus, not picking out a stone
    // the grid is the operator's now; spread after `base` so it overrides COURT's own neonCell
    ...b.gridOpts, grid: b.grid,
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
export function rankOf(score, list) {
  const i = list.findIndex((r) => score > r.score);
  if (i >= 0) return i + 1;
  return list.length < KEEP ? list.length + 1 : null;
}

// ------------------------------------------------------------------ the screen
const el = (id) => document.getElementById(id);

function overlay(msg, sub, button, dim = false) {
  const ov = el('baOver'), m = el('baMsg'), s = el('baSub'), b = el('baResume');
  if (!ov) return;
  ov.classList.toggle('hidden', !msg);
  ov.classList.toggle('dim', dim);
  if (m) m.textContent = msg ?? '';
  if (s) s.textContent = sub ?? '';
  if (b) b.textContent = button ?? 'play';
}

function drawStats() {
  const g = G.game, box = el('baStats');
  if (!box) return;
  const rows = g
    ? [['score', g.score.toLocaleString()], ['lives', '●'.repeat(Math.max(0, g.lives))], ['level', String(g.level)],
       ['wall left', `${Math.round(remaining(g) * 100)}%`], ['vaus', powers(g).join(', ') || 'stock']]
    : [['score', '–'], ['lives', '●'.repeat(LIVES)], ['level', '–'], ['vaus', 'stock']];
  const html = rows.map(([k, v]) => `<i>${k}</i><b>${v}</b>`).join('');
  if (box.innerHTML !== html) box.innerHTML = html;
}

function drawScores(highlightAt = null) {
  const t = el('baScores');
  if (!t) return;
  const list = loadScores();
  const html = list.length
    ? `<tr><th>#</th><th>score</th><th>lvl</th><th>when</th></tr>` + list.map((r, i) =>
      `<tr${r.at === highlightAt ? ' class="now"' : ''}><td>${i + 1}</td><td>${r.score.toLocaleString()}</td><td>${r.level}</td><td>${new Date(r.at).toISOString().slice(0, 10)}</td></tr>`).join('')
    : `<tr><td class="faint">no walls broken yet</td></tr>`;
  if (t.innerHTML !== html) t.innerHTML = html;
}

const SWITCHES = [['baStars', 'stars'], ['baGalaxy', 'galaxy'], ['baNeon', 'neon'], ['baSfx', 'sfx']];
function drawSwitches() {
  const b = blockanoidOptions(loadSettings());
  for (const [id, key] of SWITCHES) {
    const btn = el(id);
    if (!btn) continue;
    btn.classList.toggle('on', !!b[key]);
    btn.setAttribute('aria-pressed', b[key] ? 'true' : 'false');
  }
  sound.setSfx(b.sfx);
}
function flip(key) {
  const cur = blockanoidOptions(loadSettings())[key];
  setSetting(loadSettings(), `blockanoid.${key}`, !cur);
  sound.unlock();
  drawSwitches();
  if (key === 'stars' || key === 'galaxy') drawSky();
  // capsules and minions change the RULES, so a flip must reach the game IN PLAY, not just the
  // next one -- otherwise the switch does nothing until you lose, which reads as a broken control
  if (G.game) { const b = blockanoidOptions(loadSettings()); setOptions(G.game, { capsules: b.capsules, enemies: b.enemies }); }
  draw();
}

function drawSky() {
  const sky = el('baSky');
  if (!sky) return;
  const b = blockanoidOptions(loadSettings());
  board3d(sky, [], {
    ...SKY,
    stars: b.stars, galaxy: b.stars && b.galaxy, galaxyAt: b.galaxyAt,
    starDensity: b.starDensity, starBrightness: b.starBrightness,
    nebulae: b.nebulae, galaxies: b.galaxies, dust: b.dust, clusters: b.clusters,
    starColours: b.starColours, starGlints: b.starGlints,
  });
}

function draw(now = performance.now()) {
  const g = G.game;
  const court = el('baWell');
  el('baWellWrap')?.classList.toggle('idle', !g);
  if (court && g) board3d(court, [...tiles(g), ...debrisTiles(G.debris, now)], opts(COURT));
  drawStats();
}

// ------------------------------------------------------------------ the loop
function frame(t) {
  G.raf = null;
  if (!G.running) return;
  if (document.hidden || G.state?.page !== 'blockanoid') { pause(document.hidden ? 'paused — you looked away' : 'paused — you changed tabs'); return; }
  const dt = G.last ? t - G.last : 0;
  G.last = t;
  const g = G.game;

  if (G.held.left) nudge(g, -KEY_NUDGE * Math.min(3, dt / 16));
  if (G.held.right) nudge(g, KEY_NUDGE * Math.min(3, dt / 16));
  // IT FIRES ITSELF while armed (operator, 2026-09-12: "laser doesn't auto fire when in laser
  // mode"). Holding a key to use a power-up you already caught is friction: the capsule IS the
  // decision, and `fire()` has its own cooldown, so this is a rate, not a stream. The keys still
  // work and simply arrive inside the same cooldown.
  if (g.laser && fire(g).length) sound.play('laser');

  const r = step(g, dt);
  for (const h of r.hits) {
    if (h.kind === 'brick') {
      sound.play(h.points >= 100 ? 'brickhard' : 'brick');
      G.debris.push({ id: G.nextDebris++, x: h.x, y: h.y, color: h.color,
        dx: (h.x - (COLS - 1) / 2) * 0.10, t0: t });
    } else if (h.kind === 'silver') sound.play('silver');
    else if (h.kind === 'gold') sound.play('gold');
    else if (h.kind === 'capsule') { sound.play('capsule'); G.h?.toast?.(`${CAPSULE_LETTER[h.capsule]} — ${h.capsule}`); }
    else if (h.kind === 'enemy') sound.play('enemy');
    else if (h.kind === 'paddle') sound.play('paddle');
    else if (h.kind === 'wall') sound.play('wall');
    else if (h.kind === 'life') sound.play('life');
  }
  if (G.debris.length) G.debris = G.debris.filter((d) => t - d.t0 < DEBRIS_MS);
  if (g.over) { gameOver(); return; }
  if (r.cleared) { levelDone(); return; }
  draw(t);
  G.raf = requestAnimationFrame(frame);
}

function start() {
  const b = blockanoidOptions(loadSettings());
  G.game = newGame(1, { capsules: b.capsules, enemies: b.enemies });
  G.debris = [];
  G.running = true; G.paused = false; G.last = 0;
  overlay(null);
  drawScores();
  sound.unlock();
  drawSwitches();
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function pause(why) {
  if (!G.running || G.paused) return;
  G.paused = true; G.why = why;
  overlay(why, 'Vaus is holding', 'resume', true);
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
  overlay(`wall cleared — level ${g.level}`,
    `${g.score.toLocaleString()} points. A new wall, and a faster ball. Click the court or press space to serve.`, 'serve', true);
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
  launch(g, (Math.random() - 0.5) * 0.7);
}

function onKey(e) {
  if (G.state?.page !== 'blockanoid') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Enter') { e.preventDefault(); resume(); return; }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { if (G.running) { e.preventDefault(); G.paused ? resume() : pause('paused'); } return; }
  if (!G.running || !G.game || G.game.over) return;
  switch (e.key) {
    case 'ArrowLeft': case 'a': case 'A': G.held.left = true; nudge(G.game, -KEY_NUDGE); break;
    case 'ArrowRight': case 'd': case 'D': G.held.right = true; nudge(G.game, KEY_NUDGE); break;
    case 'ArrowUp': case 'w': case 'W': if (fire(G.game).length) sound.play('laser'); break;
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

function onPointer(e) {
  const g = G.game;
  const court = el('baWell');
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
  el('baResume')?.addEventListener('click', () => resume());
  const court = el('baWell');
  court?.addEventListener('pointermove', onPointer);
  court?.addEventListener('pointerdown', (e) => {
    onPointer(e);
    // the right button fires, the left serves -- so a laser run needs no second hand
    if (e.button === 2 || e.shiftKey) { if (fire(G.game).length) sound.play('laser'); }
    else serve();
  });
  court?.addEventListener('contextmenu', (e) => { if (G.running) e.preventDefault(); });
  for (const [id, key] of SWITCHES) el(id)?.addEventListener('click', () => flip(key));
}

export function renderBlockanoid(s, state, h) {
  G.state = state; G.h = h;
  bind();
  drawSwitches();
  drawSky();
  if (!G.game) {
    overlay('Blockanoid',
      `${layoutFor(1).length} rows of wall, silver that takes two hits and gold that never breaks. Catch a capsule: L laser, E wide, C catch, S slow, D three balls, P a life, B skip. Mouse or ← →, space serves, ↑ fires.`,
      'play');
    drawStats(); drawScores(); draw();
    return;
  }
  if (G.running && G.paused) overlay(G.why, 'Vaus is holding', 'resume', true);
  if (G.running && !G.paused && !G.raf) { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else draw();
}
