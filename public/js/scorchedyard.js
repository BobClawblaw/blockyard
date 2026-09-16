// SCORCHED YARD, the tab (operator, 2026-09-16: "re-creating the classic PC DOS game Scorched
// Earth using our engine ... at least 3 player. 1 Human Player and 2 AI Players ... as faithfully
// as possible, but make it look fabulous"). docs/PLAN-SCORCHED-YARD.md is the plan; this is M1
// and M2: the game, the roster, the items, and the shop between rounds.
//
// The rules live in scorched.js and know nothing of the screen; the computer players in
// scorchedai.js know nothing of it either. This file is the screen: the field is the same board3d
// the other games use, wide and low on the oblique camera, over the same sky canvas; the HUD beside
// it is the original's status line unrolled -- whose turn, angle, power, weapon, wind, cash, the
// items, and every tank's health -- and between rounds the overlay is the shop.
import { board3d } from './details3d.js';
import {
  newGame, current, aim, fire, step, settled, nextRound, cycleWeapon, useItem, drive, landTiles, actorTiles, leader, buy,
  WEAPONS, ITEMS, COLS, ROWS, TANK_W,
} from './scorched.js';
import { SHOP } from './scorchedshop.js';
import { decide, shop as aiShop } from './scorchedai.js';
import { loadSettings, setSetting, scorchedOptions } from './settings.js';
import * as sound from './tetsound.js';

const SCORES_KEY = 'blockyard.scorched.scores';
const KEEP = 10;

// TWO CANVASES OVER THE SKY. The land is 1,600-odd cubes (a cube per cell: scorched.js landTiles
// says why not a tile per run) and is redrawn only when the dirt changes; the actors -- tanks, the
// shells, the trace, falling dirt, fire, the blasts -- are a few dozen tiles on a transparent
// canvas over it, redrawn every frame of a flight. Same camera on both, so they register exactly.
// `still`, as every game here is: a key press lands where you pressed it, and nothing flies but
// what the rules say flies.
const FIELD = {
  gridW: COLS, gridH: ROWS,
  oblique: { ox: 0.10, oy: 0.30, headroom: 3, flight: 0 },
  dome: 0,
  light: 'overhead',
  gridStep: 4,
  space: true,
  background: 'rgba(0,0,0,0)',
  spaceFloor: 'rgba(0,0,0,0.22)',
  neonCell: 'rgba(60,200,140,0.14)',
};
const ACTORS = { ...FIELD, grid: false, spaceFloor: 'rgba(0,0,0,0)', neonCell: 'rgba(0,0,0,0)' };
const SKY = { gridW: COLS, gridH: ROWS, oblique: { ox: 0.10, oy: 0.30, headroom: 3, flight: 0 }, dome: 0, space: false, grid: false, background: 'rgba(0,0,0,1)', idleFx: false, shadows: false, still: true, transition: { rise: 0, travel: 1, drop: 0 }, maxDpr: 1 };

const AI_THINK_MS = 700;               // a computer player's pause before it fires
const FALL_MS_PER_CELL = 55;           // how long a run of dirt takes to fall each cell (plus a base)
const FALL_BASE_MS = 180;
const BLAST_MS = 650;
const FIRE_MS = 2600;                  // how long napalm burns on screen
const BEAM_MS = 420;                   // how long a laser's line stays

const G = {
  game: null, running: false, paused: false, why: '', raf: null, last: 0, dirty: true, bound: false,
  state: null, h: null,
  aiAt: 0,                              // when the computer's turn began, for the pause before it fires
  settleT0: 0, settleMs: 0,             // the fall on screen
  landKey: '',                          // what the land canvas last drew: the land version and whether dirt is falling
  blasts: [],                           // { id, x, y, r, t0, big } pictures of the blasts, drained as they end
  fires: [],                            // { cells, t0 } napalm on the ground, drained as it burns out
  beams: [],                            // { x0, y0, x1, y1, t0 } laser lines
  drag: null,                           // a mouse aim in progress
  shopping: false,                      // the shop is open between rounds
  seq: 0,
};

function opts(base) {
  const t = scorchedOptions(loadSettings());
  return {
    ...base,
    space: true, idleFx: false, shadows: false,
    hover: false,                           // a playfield does not light up under the pointer
    stars: false, galaxy: false,            // the sky is the panel's canvas behind the field
    ...t.gridOpts, grid: base.grid === false ? false : t.grid,
    edges: true, facetPx: Infinity, crownPx: Infinity, sheen: false,
    neon: false,
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
  const list = [...loadScores(storage), { score: entry.score, kills: entry.kills, rounds: entry.rounds, won: !!entry.won, at: entry.at ?? Date.now() }]
    .sort((a, b) => b.score - a.score || b.kills - a.kills)
    .slice(0, KEEP);
  try { storage?.setItem(SCORES_KEY, JSON.stringify(list)); } catch { /* private mode, quota */ }
  return list;
}
export function rankOf(score, list) {
  const i = list.findIndex((r) => score > r.score);
  if (i >= 0) return i + 1;
  return list.length < KEEP ? list.length + 1 : null;
}

// ------------------------------------------------------------------ the pictures
function shadeTo(hex, k) {
  const h = hex.replace('#', '');
  const ch = (i) => Math.max(0, Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) * k)));
  return `#${[ch(0), ch(2), ch(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A blast on screen: a flash that swells and fades, and sparks flung out and falling. Tiles, so
 * the engine draws them like everything else; gone after BLAST_MS.
 */
export function blastTiles(blasts, now, ms = BLAST_MS) {
  const out = [];
  for (const b of blasts) {
    const t = Math.min(1, Math.max(0, (now - b.t0) / ms));
    if (t >= 1) continue;
    const flash = t < 0.35 ? (0.5 + t / 0.35 * 0.5) : Math.max(0, 1 - (t - 0.35) / 0.65);
    const fr = b.r * (0.6 + 0.8 * t);
    const hot = b.riot ? '#9fd8ff' : t < 0.3 ? '#fff6d0' : t < 0.6 ? '#ffb347' : '#b8472a';
    out.push({ txid: `flash${b.id}`, x: b.x - fr, y: b.y - fr, s: fr * 2, tall: 0.05, sphere: true, color: shadeTo(hot, flash) });
    const n = b.big ? 22 : 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + b.id * 0.7;
      const sp = (0.8 + ((i * 7) % 5) / 5) * b.r * 2.2;
      const x = b.x + Math.cos(a) * sp * t, y = b.y + Math.sin(a) * sp * t - 6 * t * t;
      if (y < 0) continue;
      out.push({ txid: `spark${b.id}_${i}`, x: x - 0.12, y: y - 0.12, s: 0.24, tall: 0.24, sphere: true, color: shadeTo(t < 0.5 ? '#ffd27a' : '#ff7a3a', 1 - t * 0.7) });
    }
  }
  return out;
}

/** Napalm on screen: each burning cell a lit cube that flickers and dies down over FIRE_MS. */
export function fireTiles(fires, now, ms = FIRE_MS) {
  const out = [];
  for (const f of fires) {
    const age = now - f.t0;
    if (age >= ms) continue;
    const seen = new Set();
    for (const c of f.cells) {
      const key = `${c.x},${c.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lit = Math.min(1, age / 200) * Math.max(0, 1 - age / ms) * (0.75 + 0.25 * Math.sin(age / 60 + c.x * 1.7));
      if (lit <= 0.02) continue;
      out.push({ txid: `fire${f.id}_${key}`, x: c.x, y: c.y, s: 1, tall: 0.6 + 0.5 * lit, color: shadeTo(lit > 0.5 ? '#ffb03a' : '#c8401e', 0.5 + lit * 0.5) });
    }
  }
  return out;
}

/** A laser on screen: a string of hot beads along the line, fading over BEAM_MS. */
export function beamTiles(beams, now, ms = BEAM_MS) {
  const out = [];
  for (const b of beams) {
    const t = Math.min(1, Math.max(0, (now - b.t0) / ms));
    if (t >= 1) continue;
    const len = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
    const n = Math.max(2, Math.min(80, Math.round(len * 1.5)));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const x = b.x0 + (b.x1 - b.x0) * k, y = b.y0 + (b.y1 - b.y0) * k;
      if (y < 0 || y > ROWS + 2) continue;
      out.push({ txid: `beam${b.id}_${i}`, x: x - 0.2, y: y - 0.2, s: 0.4, tall: 0.4, sphere: true, color: shadeTo(i % 2 ? '#ff5a5a' : '#fff0f0', 1 - t) });
    }
  }
  return out;
}

/** The cells of the runs still falling, as "x,y" keys: left off the land canvas while the actor canvas animates them. */
export function fallingCells(g) {
  const set = new Set();
  for (const f of g.falling ?? []) for (let k = 0; k < f.len; k++) set.add(`${f.x},${f.y + k}`);
  return set;
}

/**
 * The actor layer at `now`: the tanks, the shells and the trace, the dirt still falling (each cell
 * a cube lifted by what it has left to fall, gathering speed), fire, beams, and the blasts over
 * everything.
 */
export function actorLayer(g, now, { settleT0 = 0, settleMs = 1, blasts = [], fires = [], beams = [] } = {}) {
  const out = actorTiles(g);
  const falling = g.falling ?? [];
  if (falling.length && settleMs > 0) {
    const t = Math.min(1, Math.max(0, (now - settleT0) / settleMs));
    const e = t * t;
    for (const f of falling) {
      const lift = (f.from - f.y) * (1 - e);
      for (let k = 0; k < f.len; k++) {
        const y = f.y + k;
        out.push({ txid: `c${f.x}:${y}`, x: f.x, y, s: 1, tall: 1, floor: lift, color: '#8a6a3f' });
      }
    }
  }
  out.push(...fireTiles(fires, now), ...beamTiles(beams, now), ...blastTiles(blasts, now));
  return out;
}

// ------------------------------------------------------------------ the screen
const el = (id) => document.getElementById(id);
const money = (n) => `$${Math.round(n).toLocaleString()}`;

function overlay(msg, sub, button, dim = false) {
  const ov = el('syOver'), m = el('syMsg'), s = el('sySub'), b = el('syResume');
  if (!ov) return;
  ov.classList.toggle('hidden', !msg);
  ov.classList.toggle('dim', dim);
  if (m) m.textContent = msg ?? '';
  if (s) s.textContent = sub ?? '';
  if (b) b.textContent = button ?? 'play';
}

const windArrow = (w) => (w > 0.05 ? '→' : w < -0.05 ? '←' : '·');

function drawStats() {
  const g = G.game, box = el('syStats');
  if (!box) return;
  let rows;
  if (!g) rows = [['round', '–'], ['turn', '–'], ['wind', '–'], ['angle', '–'], ['power', '–'], ['weapon', '–'], ['cash', '–']];
  else {
    const t = current(g);
    const w = WEAPONS[t.weapon];
    const count = t.weapon === 'babyMissile' ? '∞' : String(t.inventory[t.weapon] ?? 0);
    rows = [
      ['round', `${g.round} of ${g.rounds}`],
      ['turn', t.name],
      ['wind', `${windArrow(g.wind)} ${Math.abs(g.wind).toFixed(1)}`],
      ['angle', `${t.angle}°`],
      ['power', String(t.power)],
      ['weapon', `${w.name} × ${count}`],
      ['cash', money(t.cash)],
    ];
  }
  const html = rows.map(([k, v]) => `<i>${k}</i><b>${v}</b>`).join('');
  if (box.innerHTML !== html) box.innerHTML = html;
  const fireBtn = el('syFire');
  if (fireBtn) fireBtn.disabled = !humanTurn();
  drawItems();
}

// THE ITEMS LINE: what the tank on turn carries, the shield that is up, and what is armed for the
// shot. Each is a pill; the keys beside them do the same as the pills.
function drawItems() {
  const g = G.game, box = el('syItems');
  if (!box) return;
  const t = g ? current(g) : null;
  if (!t) { if (box.innerHTML !== '') box.innerHTML = ''; return; }
  const pills = [];
  if (t.shield) pills.push(`<span class="sypill on" title="${ITEMS[t.shield.id].name}, ${t.shield.hp} left">🛡 ${t.shield.hp}</span>`);
  for (const [id, n] of Object.entries(t.items)) {
    if (!n) continue;
    const it = ITEMS[id];
    const armed = t.armed?.[id];
    const key = { battery: 'B', shield: 'S', forceShield: 'S', heavyShield: 'S', fuel: 'A D', contactTrigger: 'T', heatGuidance: 'H' }[id];
    pills.push(`<span class="sypill${armed ? ' on' : ''}" title="${it.name}: ${it.note ?? ''}${key ? ` — ${key}` : ''}">${it.name} × ${n}${armed ? ' ✓' : ''}</span>`);
  }
  const html = pills.join('') || '<span class="faint">no items — the shop opens between rounds</span>';
  if (box.innerHTML !== html) box.innerHTML = html;
}

function drawTanks() {
  const g = G.game, box = el('syTanks');
  if (!box) return;
  const html = g ? g.tanks.map((t) => {
    const cur = g.phase !== 'over' && current(g) === t;
    return `<div class="sytank${t.alive ? '' : ' dead'}${cur ? ' now' : ''}"><i class="sydot sydot-${t.id}"></i><b>${t.name}</b>`
      + `<meter min="0" max="100" low="34" high="67" optimum="100" value="${t.health}" title="${t.health} health"></meter>`
      + `<span>${t.alive ? `${t.health}${t.shield ? '🛡' : ''}` : '☠'}</span><small>${t.score} pts · ${t.kills} kills · ${money(t.cash)}</small></div>`;
  }).join('') : '';
  if (box.innerHTML !== html) box.innerHTML = html;
}

function drawScores(highlightAt = null) {
  const t = el('syScores');
  if (!t) return;
  const list = loadScores();
  const html = list.length
    ? `<tr><th>#</th><th>score</th><th>kills</th><th>won</th><th>when</th></tr>` + list.map((r, i) =>
      `<tr${r.at === highlightAt ? ' class="now"' : ''}><td>${i + 1}</td><td>${r.score.toLocaleString()}</td><td>${r.kills}</td><td>${r.won ? 'yes' : 'no'}</td><td>${new Date(r.at).toISOString().slice(0, 10)}</td></tr>`).join('')
    : `<tr><td class="faint">no battles yet — fire the first shot</td></tr>`;
  if (t.innerHTML !== html) t.innerHTML = html;
}

// THE SHOP, between rounds: every weapon and item with its price and pack, what you own, and a
// buy button while you can afford it. Drawn into the overlay; the overlay's button goes on.
function drawShop() {
  const g = G.game, box = el('syShop');
  if (!box) return;
  if (!G.shopping || !g) { box.classList.add('hidden'); return; }
  const you = g.tanks.find((t) => t.kind === 'human');
  if (!you) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const row = (e) => {
    const owned = (e.item ? you.items[e.id] : you.inventory[e.id]) ?? 0;
    const can = you.cash >= e.price;
    return `<div class="syrow${can ? '' : ' poor'}"><b>${e.name}</b><span class="syhint">${e.note ?? ''}</span>`
      + `<span class="syprice">${money(e.price)} · ${e.pack}</span><span class="syown">${owned ? `have ${owned}` : ''}</span>`
      + `<button type="button" class="btn sybuy" data-buy="${e.id}"${can ? '' : ' disabled'}>buy</button></div>`;
  };
  const weapons = SHOP.filter((e) => !e.item).map(row).join('');
  const items = SHOP.filter((e) => e.item).map(row).join('');
  const html = `<div class="syshophead">the shop <span class="sp"></span><b>${money(you.cash)}</b></div>`
    + `<div class="sycols"><div><h4>Weapons</h4>${weapons}</div><div><h4>Items</h4>${items}</div></div>`;
  if (box.innerHTML !== html) box.innerHTML = html;
}

const SWITCHES = [['syStars', 'stars'], ['syGalaxy', 'galaxy'], ['sySfx', 'sfx'], ['syFast', 'fast']];
function drawSwitches() {
  const t = scorchedOptions(loadSettings());
  for (const [id, key] of SWITCHES) {
    const b = el(id);
    if (!b) continue;
    b.classList.toggle('on', !!t[key]);
    b.setAttribute('aria-pressed', t[key] ? 'true' : 'false');
  }
  sound.setSfx(t.sfx);
}
function flip(key) {
  const cur = scorchedOptions(loadSettings())[key];
  setSetting(loadSettings(), `scorched.${key}`, !cur);
  sound.unlock();
  drawSwitches();
  if (key === 'stars' || key === 'galaxy') drawSky();
  G.dirty = true;
  if (!G.running || G.paused) draw();
}

function drawSky() {
  const sky = el('sySky');
  if (!sky) return;
  const t = scorchedOptions(loadSettings());
  board3d(sky, [], {
    ...SKY,
    stars: t.stars, galaxy: t.stars && t.galaxy, galaxyAt: t.galaxyAt,
    starDensity: t.starDensity, starBrightness: t.starBrightness,
    nebulae: t.nebulae, galaxies: t.galaxies, dust: t.dust, clusters: t.clusters, starColours: t.starColours, starGlints: t.starGlints,
  });
}

function draw(now = performance.now()) {
  const g = G.game;
  const field = el('syField'), land = el('syLand');
  el('syFieldWrap')?.classList.toggle('idle', !g);
  if (g) {
    // the land, only when it changed: the version moves with every blast and settle, and the
    // falling cells come off it while they are on their way down on the actor canvas
    const settling = g.falling.length > 0;
    const key = `${g.landVersion}:${settling ? 1 : 0}`;
    if (land && key !== G.landKey) {
      board3d(land, landTiles(g, { omit: settling ? fallingCells(g) : null }), opts(FIELD));
      G.landKey = key;
    }
    if (field) board3d(field, actorLayer(g, now, { settleT0: G.settleT0, settleMs: G.settleMs, blasts: G.blasts, fires: G.fires, beams: G.beams }), opts(ACTORS));
  }
  drawStats();
  drawTanks();
  drawShop();
}

// ------------------------------------------------------------------ what the rules report
function onEvents(events, now) {
  const g = G.game;
  for (const e of events) {
    switch (e.kind) {
      case 'fire': sound.play('syFire'); break;
      case 'blast':
        G.blasts.push({ id: ++G.seq, x: e.x, y: e.y, r: e.radius, t0: now, big: e.radius >= 4, riot: !!e.riot });
        sound.play(e.radius >= 4 ? 'syBig' : 'syBlast');
        break;
      case 'dirt': G.blasts.push({ id: ++G.seq, x: e.x, y: e.y, r: e.radius * 0.6, t0: now, riot: true }); sound.play('syDirt'); break;
      case 'napalm': G.fires.push({ id: ++G.seq, cells: e.cells, t0: now }); sound.play('syBlast'); break;
      case 'laser': G.beams.push({ id: ++G.seq, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, t0: now }); sound.play('syHit'); break;
      case 'hit': if (e.damage > 0) sound.play('syHit'); break;
      case 'fall': if (e.damage > 0) sound.play('syHit'); break;
      case 'chute': sound.play('rotate'); G.h?.toast?.(`${g.tanks[e.tank].name}'s parachute opens`); break;
      case 'disrupt': sound.play('syDirt'); break;
      case 'shield': sound.play('levelup'); break;
      case 'shieldDown': sound.play('life'); break;
      case 'battery': sound.play('clear'); break;
      case 'death': sound.play('syDeath'); G.h?.toast?.(`${g.tanks[e.tank].name} is destroyed`); break;
      case 'bounce': sound.play('wall'); break;
      case 'turn': G.aiAt = now; sound.play('syTurn'); break;
      case 'roundOver': roundOver(e); break;
      default: break;
    }
  }
}

function startSettle(now) {
  const g = G.game;
  if (!g.falling.length) { settled(g); return; }
  const drop = Math.max(...g.falling.map((f) => f.from - f.y));
  G.settleT0 = now;
  G.settleMs = FALL_BASE_MS + FALL_MS_PER_CELL * drop;
  sound.play('syDirt');
}

// ------------------------------------------------------------------ the loop
function frame(t) {
  G.raf = null;
  if (!G.running) return;
  if (document.hidden || G.state?.page !== 'scorched') { pause(document.hidden ? 'paused — you looked away' : 'paused — you changed tabs'); return; }
  const dt = G.last ? Math.min(250, t - G.last) : 0;
  G.last = t;
  const g = G.game;
  const fast = scorchedOptions(loadSettings()).fast;
  const before = g.phase;
  if (g.phase === 'flight') {
    const events = step(g, fast ? dt * 3 : dt);
    onEvents(events, t);
    G.dirty = true;
    if (g.phase === 'settle') startSettle(t);
  }
  if (g.phase === 'settle') {
    G.dirty = true;
    if (!g.falling.length || t - G.settleT0 >= G.settleMs) {
      settled(g);
      onEvents(step(g, 0), t);                 // the turn event, or the round's end
    }
  }
  if (g.phase === 'aim') {
    const cur = current(g);
    if (cur.kind !== 'human' && t - G.aiAt >= AI_THINK_MS) {
      aim(g, cur, decide(g, cur));
      fire(g, cur);
      onEvents(step(g, 0), t);
      if (g.phase === 'settle') startSettle(t);   // the laser is over at once
      G.dirty = true;
    }
  }
  if (G.blasts.length) { G.blasts = G.blasts.filter((b) => t - b.t0 < BLAST_MS); G.dirty = true; }
  if (G.fires.length) { G.fires = G.fires.filter((f) => t - f.t0 < FIRE_MS); G.dirty = true; }
  if (G.beams.length) { G.beams = G.beams.filter((b) => t - b.t0 < BEAM_MS); G.dirty = true; }
  if (before !== g.phase) G.dirty = true;
  if (G.dirty) { draw(t); G.dirty = false; }
  if (g.phase !== 'over') G.raf = requestAnimationFrame(frame);
}

function players() {
  const t = scorchedOptions(loadSettings());
  const list = [{ name: 'You', kind: 'human' }];
  for (let i = 0; i < t.opponents; i++) list.push({ name: `Moron ${i + 1}`, kind: 'moron' });
  return list;
}

function start() {
  const t = scorchedOptions(loadSettings());
  G.game = newGame(players(), { rounds: t.rounds, walls: t.walls, wind: t.wind, gravity: t.gravity, land: t.land, cash: t.cash, interest: t.interest / 100 });
  G.blasts = []; G.fires = []; G.beams = []; G.shopping = false;
  G.running = true; G.paused = false; G.last = 0; G.dirty = true; G.aiAt = performance.now();
  overlay(null);
  drawScores();
  sound.unlock();
  drawSwitches();
  onEvents(step(G.game, 0), performance.now());
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function pause(why) {
  if (!G.running || G.paused) return;
  G.paused = true; G.why = why;
  overlay(why, 'the guns are holding', 'resume', true);
  G.h?.toast?.(why);
}

function resume() {
  const g = G.game;
  if (!G.running) { start(); return; }
  if (g?.phase === 'roundOver') { nextRoundNow(); return; }
  if (!G.paused) return;
  G.paused = false; G.last = 0; G.dirty = true;
  overlay(null);
  sound.unlock();
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function roundOver(e) {
  const g = G.game;
  const w = e.winner != null ? g.tanks[e.winner] : null;
  if (e.last) { draw(); gameOver(); return; }
  G.shopping = true;
  draw();
  overlay(
    w ? `${w.name} ${w.kind === 'human' ? 'hold' : 'holds'} the field` : 'nobody left standing',
    `round ${e.round} of ${g.rounds} is over. ${g.tanks.map((t) => `${t.name} ${t.score}`).join(' · ')}. Spend what you earned, then N or the button for the next round.`,
    'next round',
    true,
  );
}

function nextRoundNow() {
  const g = G.game;
  if (!g || g.phase !== 'roundOver') return;
  for (const t of g.tanks) aiShop(g, t);                 // the computer shops as the round turns
  G.shopping = false;
  nextRound(g);
  G.blasts = []; G.fires = []; G.beams = []; G.last = 0; G.dirty = true; G.aiAt = performance.now();
  overlay(null);
  onEvents(step(g, 0), performance.now());
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function gameOver() {
  const g = G.game;
  G.running = false; G.paused = false; G.shopping = false;
  g.phase = 'over';
  sound.play('over');
  draw();
  const you = g.tanks.find((t) => t.kind === 'human');
  const top = leader(g);
  const list = loadScores();
  const rank = you ? rankOf(you.score, list) : null;
  const at = Date.now();
  if (rank && you) recordScore({ score: you.score, kills: you.kills, rounds: g.rounds, won: top === you, at });
  drawScores(rank ? at : null);
  overlay(
    top ? `${top.name} ${top.kind === 'human' ? 'win' : 'wins'} the war` : 'a draw',
    `${g.tanks.map((t) => `${t.name} ${t.score} (${money(t.cash)})`).join(' · ')}${rank ? ` — #${rank} on this browser` : ''}.`,
    'play again',
    true,
  );
}

// ------------------------------------------------------------------ input
function humanTurn() {
  const g = G.game;
  return G.running && !G.paused && g && g.phase === 'aim' && current(g).kind === 'human';
}

function onKey(e) {
  if (G.state?.page !== 'scorched') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const g = G.game;
  if (e.key === 'Enter' && !humanTurn()) { e.preventDefault(); resume(); return; }
  if (e.key === 'n' || e.key === 'N') { if (g?.phase === 'roundOver') { e.preventDefault(); nextRoundNow(); } return; }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { if (G.running && g?.phase !== 'roundOver') { e.preventDefault(); G.paused ? resume() : pause('paused'); } return; }
  if (!humanTurn()) return;
  const t = current(g);
  const big = e.shiftKey ? 5 : 1;
  let used = true;
  switch (e.key) {
    case 'ArrowLeft': aim(g, t, { angle: t.angle + big }); sound.play('move'); break;
    case 'ArrowRight': aim(g, t, { angle: t.angle - big }); sound.play('move'); break;
    case 'ArrowUp': aim(g, t, { power: t.power + (e.ctrlKey ? 100 : e.shiftKey ? 1 : 10) }); sound.play('soft'); break;
    case 'ArrowDown': aim(g, t, { power: t.power - (e.ctrlKey ? 100 : e.shiftKey ? 1 : 10) }); sound.play('soft'); break;
    case 'PageUp': case ']': cycleWeapon(t, 1); sound.play('rotate'); break;
    case 'PageDown': case '[': cycleWeapon(t, -1); sound.play('rotate'); break;
    case 'a': case 'A': if (drive(g, t, -1)) { onEvents(step(g, 0), performance.now()); sound.play('move'); } break;
    case 'd': case 'D': if (drive(g, t, 1)) { onEvents(step(g, 0), performance.now()); sound.play('move'); } break;
    case 'b': case 'B': if (useItem(g, t, 'battery')) onEvents(step(g, 0), performance.now()); break;
    case 's': case 'S': if (useItem(g, t, 'shield')) onEvents(step(g, 0), performance.now()); break;
    case 't': case 'T': useItem(g, t, 'contactTrigger'); break;
    case 'h': case 'H': useItem(g, t, 'heatGuidance'); break;
    case ' ': case 'Enter': fireNow(); break;
    default: used = false;
  }
  if (used) { e.preventDefault(); G.dirty = true; if (!G.raf) draw(); }
}

function fireNow() {
  const g = G.game;
  if (!humanTurn()) return;
  if (fire(g, current(g))) {
    onEvents(step(g, 0), performance.now());
    if (g.phase === 'settle') startSettle(performance.now());   // the laser is over at once
    G.dirty = true;
  }
}

// THE MOUSE: drag anywhere on the field to aim -- the direction from your tank is the angle, the
// distance is the power -- and fire with the button or space. A click without a drag changes nothing.
function pointerGrid(e) {
  const field = el('syField');
  const r = field?.getBoundingClientRect();
  if (!r || !r.width || !r.height) return null;
  return { x: ((e.clientX - r.left) / r.width) * COLS, y: (1 - (e.clientY - r.top) / r.height) * ROWS };
}
function onPointerDown(e) {
  if (!humanTurn()) return;
  const p = pointerGrid(e);
  if (!p) return;
  G.drag = { x0: p.x, y0: p.y, moved: false };
}
function onPointerMove(e) {
  if (!G.drag || !humanTurn()) return;
  const p = pointerGrid(e);
  if (!p) return;
  const g = G.game, t = current(g);
  const cx = t.x + TANK_W / 2, cy = t.y + 1;
  const dx = p.x - cx, dy = p.y - cy;
  if (!G.drag.moved && Math.hypot(p.x - G.drag.x0, p.y - G.drag.y0) < 0.5) return;
  G.drag.moved = true;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  aim(g, t, { angle: Math.max(0, Math.min(180, angle)), power: Math.min(1000, Math.hypot(dx, dy) * 28) });
  G.dirty = true;
  if (!G.raf) draw();
}
function onPointerUp() { G.drag = null; }

function onShopClick(e) {
  const b = e.target.closest?.('[data-buy]');
  if (!b || !G.shopping || !G.game) return;
  const you = G.game.tanks.find((t) => t.kind === 'human');
  if (you && buy(you, b.dataset.buy)) { sound.play('brick'); draw(); }
}

function bind() {
  if (G.bound) return;
  G.bound = true;
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.running && !G.paused) pause('paused — you looked away'); });
  el('syResume')?.addEventListener('click', () => resume());
  el('syFire')?.addEventListener('click', () => fireNow());
  el('syShop')?.addEventListener('click', onShopClick);
  const field = el('syField');
  field?.addEventListener('pointerdown', onPointerDown);
  field?.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  for (const [id, key] of SWITCHES) el(id)?.addEventListener('click', () => flip(key));
}

/** The game on screen, for a tool or a test that drives the page (never the rules' way in). */
export function currentGame() { return G.game; }

export function renderScorchedYard(s, state, h) {
  G.state = state; G.h = h;
  bind();
  drawSwitches();
  drawSky();
  if (!G.game) {
    overlay('Scorched Yard', 'the block space is the battlefield. You against two Morons: ← → angle, ↑ ↓ power, [ ] weapon, space fires; or drag on the field to aim. Enter or the button to play.', 'play');
    drawStats(); drawTanks(); drawScores(); draw();
    return;
  }
  if (G.running && G.paused) overlay(G.why, 'the guns are holding', 'resume', true);
  if (G.running && !G.paused && !G.raf && G.game.phase !== 'over') { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else { G.dirty = true; draw(); }
}
