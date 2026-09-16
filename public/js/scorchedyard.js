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
import { paintBlasts, paintDeaths, paintDust, paintAim, paintSolution, paintShells } from './scorchedfx.js';
import { makeFlow, stepFlow, paintFlow, plasmaCells, paintPlasma, airClock, advanceAir, traceStreamlines, paintStreamlines } from './scorchedwind.js';
import {
  newGame, current, aim, fire, step, settled, nextRound, cycleWeapon, useItem, drive, landTiles, actorTiles, leader, buy,
  trajectory, dirtAt, shellLook,
  WEAPONS, ITEMS, COLS, ROWS, TANK_W,
} from './scorched.js';
import { SHOP } from './scorchedshop.js';
import { decide, prepare, shop as aiShop } from './scorchedai.js';
import { loadSettings, setSetting, scorchedOptions, nextSky, SKY_LABELS } from './settings.js';
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
  // THE FRONT OF THE BOARD IS THE PICTURE (operator, 2026-09-16: "We really need better
  // illumination of the front of the board, it's dull and looks muted"). Overhead lit the tops of
  // the cubes and left every face the player actually looks at on one flat shade. The lamp stands
  // at the viewer, low, so the front faces carry the light and the strata separate.
  light: 'front', lightHeight: 'low',
  // and a hard lamp: the shipped range put every face within half a stop of every other and the
  // board read as tinted dirt rather than lit dirt (operator: "too washed out")
  // 1.7, not the 2.15 tried first: with the lamp at the viewer the front face comes out at about
  // 1.1 of its own colour, and the face turned away at under 0.2. Higher pushed the front past
  // 1.25, where a channel clips and a saturated colour goes pale -- which is the "washed out" the
  // operator kept seeing. Vibrance is the strata's own saturation; the lamp only shades them.
  lightGain: 1.7, topLight: 0.55,
  gridStep: 4,
  space: true,
  background: 'rgba(0,0,0,0)',
  spaceFloor: 'rgba(0,0,0,0.22)',
  neonCell: 'rgba(60,200,140,0.14)',
};
const ACTORS = { ...FIELD, grid: false, spaceFloor: 'rgba(0,0,0,0)', neonCell: 'rgba(0,0,0,0)', overlay: paintOver };
const SKY = { gridW: COLS, gridH: ROWS, oblique: { ox: 0.10, oy: 0.30, headroom: 3, flight: 0 }, dome: 0, space: false, grid: false, background: 'rgba(0,0,0,1)', idleFx: false, shadows: false, still: true, transition: { rise: 0, travel: 1, drop: 0 }, maxDpr: 1 };

const AI_THINK_MS = 700;               // a computer player's pause before it fires
const FALL_MS_PER_CELL = 55;           // how long a run of dirt takes to fall each cell (plus a base)
const FALL_BASE_MS = 180;
const BLAST_MS = 650;
const SMOKE_MS = 2400;                 // the smoke after a blast, rising and drifting on the wind
const DEATH_MS = 1100;                 // a tank's pieces and sparks
const DUST_MS = 700;                   // dust where fallen dirt lands
const TALK_MS = 2400;
const FIRE_MS = 2600;                  // how long napalm burns on screen
const BEAM_MS = 420;                   // how long a laser's line stays
const WIND_MS = 33;                    // the wind redraws at 30 a second whatever else is happening
const DEMO_ROUND_MS = 4200;            // attract mode: how long the round's scoreboard stands before the next
const DEMO_WAR_MS = 7000;              // and how long the war's result stands before a fresh one

const G = {
  game: null, running: false, paused: false, why: '', raf: null, last: 0, dirty: true, bound: false,
  state: null, h: null,
  html: {},                             // what each panel last had written into it, so it is not rewritten every frame
  rep: null,                            // the held key's ramp: { key, n, at }
  lastShot: null,                       // what the human fired last, for R
  editing: null,                        // 'angle' | 'power' while a number is being typed
  paintNow: 0,                          // the instant the overlay layer paints at
  flow: null, flowW: 0, flowH: 0,       // the advected particles of the air, and the size they were made for
  flowAt: 0,                            // the last frame's clock, for the step
  air: null,                            // the air's own integrated clock { t, drift }
  streams: null, streamsAt: 0, streamsW: 0, airTravel: 0,   // the currents, and how far the air has run
  windEased: undefined,                 // the wind the flow is actually blowing at: it bends into a change
  windShown: undefined,                 // the last wind the game reported, to date a change
  windAtChange: 0,                      // when it changed, for the banner's brightness
  windAt: 0,                            // when the wind layer last moved, so it keeps blowing while the board is idle
  aiAt: 0,                              // when the computer's turn began, for the pause before it fires
  settleT0: 0, settleMs: 0,             // the fall on screen
  landKey: '',                          // what the land canvas last drew: the land version and whether dirt is falling
  blasts: [],                           // { id, x, y, r, t0, big } pictures of the blasts, drained as they end
  deaths: [],                           // { id, x, y, colour, t0 } a tank going up
  dusts: [],                            // { id, x, y, t0 } where fallen dirt landed
  falls: new Map(),                     // tank id -> { from, to, t0, ms, chute } a tank on its way down
  talkTimer: null,
  demoTimer: null,                      // attract mode's wait between a round and the next, and between wars
  fires: [],                            // { cells, t0 } napalm on the ground, drained as it burns out
  beams: [],                            // { x0, y0, x1, y1, t0 } laser lines
  drag: null,                           // a mouse aim in progress
  dragClickAt: 0,                       // when the drag last clicked, so it ticks rather than machine-guns
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

const mixHex = (a, b, k) => {
  const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const x = p(a), y = p(b);
  return `#${x.map((v, i) => Math.max(0, Math.min(255, Math.round(v + (y[i] - v) * k))).toString(16).padStart(2, '0')).join('')}`;
};
const hash = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/** What is left of a tank on the tile layer once its fire is painted: three pieces of hull, tumbling. */
export function deathTiles(deaths, now, ms = DEATH_MS) {
  const out = [];
  for (const d of deaths) {
    const t = Math.min(1, Math.max(0, (now - d.t0) / ms));
    if (t >= 1) continue;
    for (let i = 0; i < 3; i++) {
      const h = (k) => hash(d.id * 23 + i * 11 + k);
      const a = Math.PI * (0.25 + 0.5 * h(1)), sp = 4 + h(2) * 6;
      const x = d.x + Math.cos(a) * sp * t * (i - 1), y = d.y + 0.6 + Math.sin(a) * sp * t - 9 * t * t;
      if (y < 0) continue;
      out.push({ txid: `piece${d.id}_${i}`, x: x - 0.4, y: y - 0.4, s: 0.8, tall: 0.01, color: shadeTo(d.colour, 0.8), poly: [[-0.4, -0.2], [0.35, -0.3], [0.4, 0.2], [-0.3, 0.35]], rot: t * (4 + i * 3) * (i % 2 ? 1 : -1) });
    }
  }
  return out;
}


/** Where each falling tank is at `now`: from its old height to its new, by gravity or under a parachute. */
export function fallingTanks(falls, now) {
  const tankY = new Map(), chutes = new Set();
  for (const [id, f] of falls) {
    const t = Math.min(1, Math.max(0, (now - f.t0) / f.ms));
    const e = f.chute ? t : t * t;
    tankY.set(id, f.from + (f.to - f.from) * e);
    if (f.chute && t < 1) chutes.add(id);
  }
  return { tankY, chutes };
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

/**
 * THE WIND MADE VISIBLE (operator, 2026-09-16: "some sort of effects that reflect the change in
 * wind speed"; then "the dots don't convey enough motion"; then "it's swaying back and forth and
 * clipping vs the terrain. It should be drawn behind everything else on a flat plane").
 *
 * Three tries. Dots in the scene said nothing about speed. Streaks in the scene said it, but they
 * were tiles in a 3D board: they bobbed as they crossed, and a tile at a cell the land also
 * occupies is drawn over the dirt, so they cut into the hills. Both faults come from putting the
 * air in the same space as the ground.
 *
 * So the wind is its OWN FLAT LAYER, a plain 2D canvas between the sky and the land. It knows
 * nothing about cells, the camera or the terrain: streaks run dead level from one side to the
 * other, and the land canvas in front of them hides whatever passes behind a hill, which is
 * exactly what should happen. Nothing sways; nothing clips.
 *
 * A streak is a tapered dash whose LENGTH is the speed -- a breeze draws short marks, a gale long
 * ones -- and they run in three bands of depth: the far ones short, dim and slow, the near ones
 * long, pale and quick, so the air has thickness. A slow gust wave lengthens and quickens them
 * together. Nothing at all in still air.
 */
const hashAt = (i) => (k) => { const x = Math.sin((i * 7 + k) * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
// Three depths. The far band is short, dim and slow; the near one longer, paler and quicker. The
// colours are mid greys on purpose: pale enough to read against a night sky, dark enough to read
// against the Living sky's blue, and never so bright that a streak looks like a tracer round.
// THE BANNER: the wind written on the field itself, at the top, so the answer to "which way, how
// hard" is there the moment the turn begins rather than after the air has drifted enough to read.
// Chevrons pointing downwind, as many as the wind is strong, bright while it is new.
export function windBanner(wind, w, h, fresh = 0) {
  const strength = Math.min(1, Math.abs(wind ?? 0) / 10);
  if (!w || !h || strength < 0.03) return [];
  const dir = wind < 0 ? -1 : 1;
  const n = 1 + Math.round(strength * 6);
  const size = Math.max(7, Math.min(16, w * 0.011));
  const y = Math.max(10, h * 0.045);
  const gap = size * 1.5;
  const x0 = w / 2 - ((n - 1) * gap) / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const lead = 1 - i / (n + 1);                       // the leading chevron is the brightest
    out.push({ x: x0 + i * gap, y, size, dir, alpha: (0.3 + 0.45 * lead) * (0.55 + 0.45 * fresh) });
  }
  return out;
}

export function paintBanner(ctx, chevrons) {
  for (const c of chevrons) {
    const back = -c.dir * c.size * 0.5, front = c.dir * c.size * 0.5;
    ctx.strokeStyle = `rgba(236,240,248,${c.alpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(1.4, c.size * 0.18);
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.moveTo(c.x + back, c.y - c.size * 0.45);
    ctx.lineTo(c.x + front, c.y);
    ctx.lineTo(c.x + back, c.y + c.size * 0.45);
    ctx.stroke();
  }
}

function drawWind(now) {
  const c = el('syWind');
  if (!c) return;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; G.flow = null; }
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const wind = G.game?.wind ?? 0;
  // THE WIND EASES INTO ITS NEW VALUE rather than being swapped for it (operator: "the old wind
  // needs to fade out when ending, and new wind needs to draw in"). The field is advected, so the
  // streaks BEND into the new speed and direction over about half a second instead of jumping --
  // which is what a change of wind looks like, and it needs no crossfade of two layers.
  const dt = G.flowAt ? Math.min(120, now - G.flowAt) : 16;
  G.flowAt = now;
  if (G.windEased === undefined) G.windEased = wind;
  else G.windEased += (wind - G.windEased) * Math.min(1, dt / 420);
  if (Math.abs(wind - G.windEased) < 0.02) G.windEased = wind;
  if (wind !== G.windShown) { G.windShown = wind; G.windAtChange = now; }
  // the particles live as long as the canvas does
  if (!G.flow || G.flowW !== w || G.flowH !== h) {
    G.flow = makeFlow(Math.round(Math.min(420, 150 + w * 0.22)), w, h, 7, now);
    G.flowW = w; G.flowH = h;
  }
  // the air's own clock, integrated at the eased wind's rate: a change of wind changes how fast it
  // runs from here on and nothing else (scorchedwind.js, advanceAir)
  G.air ??= airClock();
  advanceAir(G.air, dt, G.windEased);
  // the currents, re-traced every few hundred milliseconds and run along by their dash offset;
  // `travel` is how far the air has gone, in pixels, and the dashes go with it
  G.airTravel = (G.airTravel ?? 0) + (dt / 1000) * w * (0.035 + 0.42 * Math.min(1, Math.abs(G.windEased) / 10));
  if (!G.streams || now - (G.streamsAt ?? 0) > 280 || G.streamsW !== w) { G.streams = traceStreamlines(G.air, { wind: G.windEased, w, h }); G.streamsAt = now; G.streamsW = w; }
  ctx.clearRect(0, 0, w, h);
  paintPlasma(ctx, plasmaCells(w, h, G.air, G.windEased));
  paintStreamlines(ctx, G.streams, G.airTravel);
  paintFlow(ctx, stepFlow(G.flow, dt, { wind: G.windEased, w, h, now, clock: G.air }));
  paintBanner(ctx, windBanner(wind, w, h, Math.max(0, 1 - (now - (G.windAtChange ?? 0)) / 2500)));
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
export function actorLayer(g, now, { settleT0 = 0, settleMs = 1, blasts = [], fires = [], beams = [], deaths = [], dusts = [], falls = new Map() } = {}) {
  const { tankY, chutes } = fallingTanks(falls, now);
  const out = actorTiles(g, { tankY, chutes });
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
  out.push(...fireTiles(fires, now), ...beamTiles(beams, now), ...deathTiles(deaths, now));
  return out;
}

// ------------------------------------------------------------------ the painted layer
// The fire, the smoke and the aim gauge are not tiles: they are drawn over the board through the
// renderer's own projector (details3d's `overlay` hook), with the same primitives the fireworks
// use. scorchedfx.js holds the drawing; this is the bridge -- what is burning, where, and when.
function paintOver(ctx, view, hx) {
  const g = G.game;
  if (!g) return;
  const now = G.paintNow;
  const P = (x, y, z = 1.2) => hx.project(x, y, z, view);
  const o0 = P(0, 0), ox = P(1, 0), oy = P(0, 1);
  const U = { x: Math.abs(ox.x - o0.x) || 8, y: Math.abs(oy.y - o0.y) || 8 };
  const S = hx.softStops;
  paintDust(ctx, P, U, G.dusts, now, { softStops: S, ms: DUST_MS });
  paintBlasts(ctx, P, U, G.blasts, now, { wind: g.wind ?? 0, softStops: S, ms: BLAST_MS, smokeMs: SMOKE_MS });
  paintDeaths(ctx, P, U, G.deaths, now, { softStops: S, ms: DEATH_MS });
  paintShells(ctx, P, U, g.shells, now, { softStops: S, looks: shellLook });
  // CHEAT MODE: the firing solution, redrawn every frame the aim moves. Clipped where the shell
  // would meet the dirt or leave the field, so what is drawn is the shot, not a parabola over it.
  const t = current(g);
  if (t && g.phase === 'aim' && !G.shopping && scorchedOptions(loadSettings()).cheat) {
    const sol = solutionOf(g, t);
    if (sol) paintSolution(ctx, P, U, sol.pts, { colour: '255,224,140', impact: sol.impact });
  }
  // the gauge belongs to whoever is aiming, and only while they are aiming
  if (t && g.phase === 'aim' && !G.shopping) {
    paintAim(ctx, P, U, {
      x: t.x + TANK_W / 2, y: t.y, angle: t.angle, power: t.power,
      colour: t.colour,
      dim: t.kind !== 'human',
    });
  }
}

/**
 * The path the shell would take from where the barrel points now: the rules' own `trajectory`,
 * stopped at the first cell of dirt it would enter or at the edge of the field. Answers the points
 * and where it lands, or null when it flies off the board.
 */
export function solutionOf(g, tank, secs = 12) {
  const pts = trajectory(g, tank, secs);
  const out = [];
  for (const p of pts) {
    if (p.x < 0 || p.x > COLS || p.y > ROWS + 40) { return out.length > 1 ? { pts: out, impact: null } : null; }
    out.push(p);
    if (p.y <= 0) return { pts: out, impact: { x: p.x, y: 0 } };
    if (p.y < ROWS && dirtAt(g, Math.floor(p.x), Math.floor(p.y))) return { pts: out, impact: p };
  }
  return out.length > 1 ? { pts: out, impact: null } : null;
}

// ------------------------------------------------------------------ the screen
const el = (id) => document.getElementById(id);

// WRITING A PANEL ONLY WHEN IT CHANGED (2026-09-16: "i can't buy anything in the shop between
// rounds"). Each of these compared the markup it was about to write with `box.innerHTML` -- but the
// browser gives that back NORMALISED (`disabled` comes out as `disabled=""`, entities are re-coded),
// so the comparison never matched and the panel was rebuilt on every draw. Harmless while the board
// only drew on events; fatal once the wind made it draw thirty times a second, because a button
// replaced between the press and the release is a button that never gets clicked. The shop was
// unusable and the two typed readouts would have gone the same way.
//
// So each panel remembers the string IT wrote, and the scrolling one keeps its place.
export function setHtml(box, html, key) {
  if (!box || G.html[key] === html) return false;
  const top = box.scrollTop;
  box.innerHTML = html;
  G.html[key] = html;
  if (top) box.scrollTop = top;
  return true;
}


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
    // WHILE THE SHOP IS OPEN THE PANEL IS YOURS (operator, 2026-09-16: "my cash doesn't get
    // subtracted when I purchase stuff"). The purchase always took the money; the panel was
    // showing the tank whose turn it was when the round ended, and when that was a computer
    // player its cash sat there unmoved while yours went down in the shop's own header. Between
    // rounds the panel shows the human, who is the one shopping.
    const you = g.tanks.find((k) => k.kind === 'human');
    const t = G.shopping && you ? you : current(g);
    const w = WEAPONS[t.weapon];
    const count = t.weapon === 'babyMissile' ? '∞' : String(t.inventory[t.weapon] ?? 0);
    rows = [
      ['round', `${g.round} of ${g.rounds}`],
      ['turn', G.shopping && you ? `${t.name} · shopping` : t.name],
      ['wind', `${windArrow(g.wind)} ${Math.abs(g.wind).toFixed(1)}`],
      ['angle', `${t.angle}°`],
      ['power', String(t.power)],
      ['weapon', `${w.name} × ${count}`],
      ['cash', money(t.cash)],
    ];
  }
  if (G.editing) return;                        // a number is being typed: leave the panel alone
  const html = rows.map(([k, v]) => `<i>${k}</i><b${k === 'angle' || k === 'power' ? ` class="syval" data-edit="${k}" title="click to type it"` : ''}>${v}</b>`).join('');
  setHtml(box, html, 'stats');
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
  setHtml(box, html, 'items');
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
  setHtml(box, html, 'tanks');
}

function drawScores(highlightAt = null) {
  const t = el('syScores');
  if (!t) return;
  const list = loadScores();
  const html = list.length
    ? `<tr><th>#</th><th>score</th><th>kills</th><th>won</th><th>when</th></tr>` + list.map((r, i) =>
      `<tr${r.at === highlightAt ? ' class="now"' : ''}><td>${i + 1}</td><td>${r.score.toLocaleString()}</td><td>${r.kills}</td><td>${r.won ? 'yes' : 'no'}</td><td>${new Date(r.at).toISOString().slice(0, 10)}</td></tr>`).join('')
    : `<tr><td class="faint">no battles yet — fire the first shot</td></tr>`;
  setHtml(t, html, 'scores');
}

// THE SHOP, between rounds: every weapon and item with its price and pack, what you own, and a
// buy button while you can afford it. Drawn into the overlay; the overlay's button goes on.
function drawShop() {
  const g = G.game, box = el('syShop');
  if (!box) return;
  if (!G.shopping || !g) { box.classList.add('hidden'); G.html.shop = null; return; }
  const you = g.tanks.find((t) => t.kind === 'human');
  if (!you) { box.classList.add('hidden'); G.html.shop = null; return; }
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
  setHtml(box, html, 'shop');
}

const SWITCHES = [['syMusic', 'music'], ['sySfx', 'sfx'], ['syTalkSw', 'talk'], ['syFast', 'fast'], ['syCheat', 'cheat'], ['syDemo', 'demo']];
function drawSwitches() {
  const t = scorchedOptions(loadSettings());
  // ONE SKY BUTTON (docs/PLAN-SKIES.md): Galaxy, Earth or none, round the ring, in place of the old
  // star field and galaxy pair -- the same setting the Sky tab's table shows for this board
  const sb = el('sySkySw');
  if (sb) { sb.textContent = `\u2600 ${SKY_LABELS[t.sky.sky] ?? t.sky.sky}`; sb.classList.toggle('on', t.sky.sky !== 'none'); sb.setAttribute('aria-pressed', t.sky.sky !== 'none' ? 'true' : 'false'); }
  for (const [id, key] of SWITCHES) {
    const b = el(id);
    if (!b) continue;
    b.classList.toggle('on', !!t[key]);
    b.setAttribute('aria-pressed', t[key] ? 'true' : 'false');
  }
  sound.setSfx(t.sfx);
  // the march plays while a game runs; a pause holds it; the switch off stops it
  sound.setMusic(t.music && G.running && !G.paused, 'scorched');
}
function flip(key) {
  const cur = scorchedOptions(loadSettings())[key];
  setSetting(loadSettings(), `scorched.${key}`, !cur);
  sound.unlock();
  drawSwitches();
  if (key === 'demo') { clearTimeout(G.demoTimer); G.demoTimer = null; if (G.running) { start(); return; } }
  G.dirty = true;
  if (!G.running || G.paused) draw();
}

function drawSky() {
  const sky = el('sySky');
  if (!sky) return;
  const t = scorchedOptions(loadSettings());
  const earth = t.sky.skyType === 'earth';
  board3d(sky, [], {
    ...SKY,
    ...t.sky,          // which sky this board chose, and what it is made of (settings.js skyFor)
    // the horizon is where the land is, not the bottom of the panel: the hills fill the lower
    // third, so the sun and the moon set behind them rather than under them
    skyHorizon: 0.58,
    // the clouds of the Living sky drift with this round's wind, and turn with it
    skyWind: G.game ? Math.sign(G.game.wind || 1) * (0.4 + Math.abs(G.game.wind) / 4) : 1,
    // and each round draws its own hour of the Living sky (the original's sky changed each round)
    ...(G.game && t.roundSky && earth ? { skyClock: 'fixed', skyHour: ROUND_HOURS[(G.game.seed + G.game.round * 7) % ROUND_HOURS.length] } : {}),
  });
}
const ROUND_HOURS = [6.6, 9, 12, 15, 17.8, 19, 21.5, 1];

function draw(now = performance.now()) {
  const g = G.game;
  G.paintNow = now;                       // the overlay paints at the frame's own instant
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
    drawWind(now);
    if (field) board3d(field, actorLayer(g, now, { settleT0: G.settleT0, settleMs: G.settleMs, blasts: G.blasts, fires: G.fires, beams: G.beams, deaths: G.deaths, dusts: G.dusts, falls: G.falls }), opts(ACTORS));
  }
  drawStats();
  drawTanks();
  drawShop();
}

// ------------------------------------------------------------------ what the tanks say
// (M4; the original's tanks talked, "Nuke 'em" and the rest) -- a bubble over the field at the
// tank's place, for a couple of seconds, picked by a hash so the same moment says the same thing
const SAY = {
  fire: ['Fire in the hole!', 'Eat this.', 'Incoming!', 'Say hello.', "Nuke 'em!", "This one's for you.", 'Watch this.', 'Bombs away.', 'Take that.'],
  hurt: ['Ouch!', 'Hey!', "Is that all you've got?", "I'm hit!", "You'll pay for that.", 'Cheap shot.', "Just wait 'til my turn.", 'Missed the good bits.'],
  death: ['Tell my wife…', 'I regret nothing.', 'Oops.', 'Argh!', 'Not like this.', 'Well played.', 'See you next round.'],
  miss: ['Missed me!', 'Close.', 'Try again.', 'Ha!'],
};
function say(tank, kind, salt = 0) {
  const box = el('syTalk');
  if (!box || !tank || !scorchedOptions(loadSettings()).talk) return;
  const lines = SAY[kind] ?? SAY.fire;
  box.textContent = lines[Math.floor(hash(tank.id * 31 + (G.game?.shots ?? 0) * 7 + salt) * lines.length)];
  box.style.setProperty('--x', `${((tank.x + TANK_W / 2) / COLS) * 100}%`);
  box.style.setProperty('--y', `${(1 - (tank.y + 3.2) / ROWS) * 100}%`);
  box.classList.remove('hidden');
  if (G.talkTimer) clearTimeout(G.talkTimer);
  G.talkTimer = setTimeout(() => box.classList.add('hidden'), TALK_MS);
}

// ------------------------------------------------------------------ what the rules report
function onEvents(events, now) {
  const g = G.game;
  for (const e of events) {
    switch (e.kind) {
      case 'fire': sound.play('syFire'); say(g.tanks[e.tank], 'fire'); break;
      case 'blast':
        G.blasts.push({ id: ++G.seq, x: e.x, y: e.y, r: e.radius, t0: now, big: e.radius >= 4, riot: !!e.riot });
        sound.play(e.radius >= 4 ? 'syBig' : 'syBlast');
        break;
      case 'dirt': G.blasts.push({ id: ++G.seq, x: e.x, y: e.y, r: e.radius * 0.6, t0: now, riot: true }); sound.play('syDirt'); break;
      case 'napalm': G.fires.push({ id: ++G.seq, cells: e.cells, t0: now }); sound.play('syBlast'); break;
      case 'laser': G.beams.push({ id: ++G.seq, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, t0: now }); sound.play('syHit'); break;
      case 'hit': if (e.damage > 0) sound.play('syHit'); if (e.damage >= 20 && g.tanks[e.tank].alive) say(g.tanks[e.tank], 'hurt', 1); break;
      case 'fall': {
        if (e.damage > 0) sound.play('syHit');
        const tk = g.tanks[e.tank];
        if (e.cells > 0.5) G.falls.set(e.tank, { from: tk.y + e.cells, to: tk.y, t0: now, ms: FALL_BASE_MS + FALL_MS_PER_CELL * e.cells, chute: false });
        break;
      }
      case 'chute': {
        sound.play('rotate');
        const tk = g.tanks[e.tank];
        G.falls.set(e.tank, { from: tk.y + e.cells, to: tk.y, t0: now, ms: 300 + 260 * e.cells, chute: true });
        break;
      }
      case 'disrupt': sound.play('syDirt'); break;
      case 'shield': sound.play('levelup'); break;
      case 'shieldDown': sound.play('life'); break;
      case 'battery': sound.play('clear'); break;
      case 'death': { sound.play('syDeath'); const tk = g.tanks[e.tank]; G.deaths.push({ id: ++G.seq, x: tk.x + TANK_W / 2, y: tk.y, colour: tk.colour, t0: now }); say(tk, 'death', 2); G.h?.toast?.(`${tk.name} is destroyed`);
        // knocked out with rounds still to play: say what the ways out are, rather than leaving a
        // dead player watching the computer finish (operator, 2026-09-16)
        if (tk.kind === 'human' && g.round < g.rounds) G.h?.toast?.('you are out for this round — restart (F2) for a new war, or watch it out');
        break; }
      case 'bounce': sound.play('wall'); break;
      case 'turn': G.aiAt = now; sound.play('syTurn'); drawSky(); break;
      case 'round': drawSky(); break;
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
      for (const f of g.falling.slice(0, 14)) if (f.from - f.y >= 2) G.dusts.push({ id: ++G.seq, x: f.x, y: f.y + f.len, t0: t });
      settled(g);
      onEvents(step(g, 0), t);                 // the turn event, or the round's end
    }
  }
  if (g.phase === 'aim') {
    const cur = current(g);
    if (cur.kind !== 'human' && t - G.aiAt >= AI_THINK_MS) {
      prepare(g, cur);                           // a battery, a shield, before the shot
      aim(g, cur, decide(g, cur));
      fire(g, cur);
      onEvents(step(g, 0), t);
      if (g.phase === 'settle') startSettle(t);   // the laser is over at once
      G.dirty = true;
    }
  }
  if (G.blasts.length) { G.blasts = G.blasts.filter((b) => t - b.t0 < SMOKE_MS); G.dirty = true; }
  if (G.deaths.length) { G.deaths = G.deaths.filter((d) => t - d.t0 < DEATH_MS); G.dirty = true; }
  if (G.dusts.length) { G.dusts = G.dusts.filter((d) => t - d.t0 < DUST_MS); G.dirty = true; }
  if (G.falls.size) { for (const [id, f] of G.falls) if (t - f.t0 >= f.ms) G.falls.delete(id); G.dirty = true; }
  if (G.fires.length) { G.fires = G.fires.filter((f) => t - f.t0 < FIRE_MS); G.dirty = true; }
  if (G.beams.length) { G.beams = G.beams.filter((b) => t - b.t0 < BEAM_MS); G.dirty = true; }
  // THE WIND NEVER STOPS (operator: "the wind effects stop when nothing is animating"). The loop
  // only drew when something had changed, so on your own turn -- the longest part of the game --
  // the air froze mid-gust. The wind layer is its own reason to redraw, at its own rate, and the
  // land canvas is cached, so this repaints the actors and nothing else.
  if (Math.abs(g.wind ?? 0) >= 0.3 && t - G.windAt >= WIND_MS) { G.windAt = t; G.dirty = true; }
  if (before !== g.phase) G.dirty = true;
  if (G.dirty) { draw(t); G.dirty = false; }
  if (g.phase !== 'over') G.raf = requestAnimationFrame(frame);
}

// THE OPPONENTS (M3): a mix climbs from the easy ones -- Shooter, Tosser, Chooser, Spoiler,
// Cyborg -- or every seat the one kind the setting names. Named for what they are, the manual's way.
const MIX = ['shooter', 'tosser', 'chooser', 'spoiler', 'cyborg', 'poolshark'];
const NAMES = { moron: 'Moron', shooter: 'Shooter', poolshark: 'Poolshark', tosser: 'Tosser', chooser: 'Chooser', spoiler: 'Spoiler', cyborg: 'Cyborg', unknown: 'Unknown' };
/**
 * The seats. ATTRACT MODE (M5): with `demo` on there is no human seat -- the human's chair is
 * taken by another computer player, so the war plays itself on a wall. Everything else is the
 * same game: the same shop, the same rounds, the same rules.
 */
export function players(t = scorchedOptions(loadSettings())) {
  const list = t.demo ? [] : [{ name: 'You', kind: 'human' }];
  const seen = {};
  const seats = t.opponents + (t.demo ? 1 : 0);
  for (let i = 0; i < seats; i++) {
    const kind = t.opponentKind === 'mix' ? MIX[i % MIX.length] : t.opponentKind;
    seen[kind] = (seen[kind] ?? 0) + 1;
    list.push({ name: seen[kind] > 1 ? `${NAMES[kind] ?? kind} ${seen[kind]}` : (NAMES[kind] ?? kind), kind });
  }
  return list;
}

/** Attract mode is on and this game has nobody at the keys. */
const demoing = () => !!G.game && !G.game.tanks.some((t) => t.kind === 'human');
function demoWait(ms, go) {
  clearTimeout(G.demoTimer);
  G.demoTimer = setTimeout(() => { G.demoTimer = null; if (demoing()) go(); }, ms);
}

function start() {
  const t = scorchedOptions(loadSettings());
  clearTimeout(G.demoTimer); G.demoTimer = null;
  // THE LAND CANVAS FORGETS THE OLD GAME (operator, 2026-09-16: "more than 2 opponents are placed
  // in mid air and in ground"). The land is redrawn only when its version moves, and a fresh game
  // starts back at the same version as the last one did -- so a restart before a shot, or a new
  // game after a change of opponents, placed the new tanks over the OLD terrain: some in the air,
  // some buried. The key is cleared here, so the first draw of a game always draws its own land.
  G.landKey = '';
  G.game = newGame(players(t), { rounds: t.rounds, walls: t.walls, wind: t.wind, gravity: t.gravity, land: t.land, cash: t.cash, interest: t.interest / 100 });
  G.blasts = []; G.fires = []; G.beams = []; G.deaths = []; G.dusts = []; G.falls = new Map(); G.shopping = false;
  G.running = true; G.paused = false; G.last = 0; G.dirty = true; G.aiAt = performance.now();
  overlay(null);
  drawScores();
  sound.unlock();
  drawSwitches();
  onEvents(step(G.game, 0), performance.now());
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

/** A fresh war, from round one, whatever the board is doing. */
function restart() {
  clearTimeout(G.demoTimer); G.demoTimer = null;
  sound.unlock();
  sound.holdMusic(false);
  start();
  G.h?.toast?.('a new war');
}

function pause(why) {
  if (!G.running || G.paused) return;
  G.paused = true; G.why = why;
  overlay(why, 'the guns are holding', 'resume', true);
  sound.holdMusic(true);
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
  sound.holdMusic(false);
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
  if (demoing()) demoWait(DEMO_ROUND_MS, nextRoundNow);      // nobody to shop: the attract mode plays on
}

function nextRoundNow() {
  const g = G.game;
  if (!g || g.phase !== 'roundOver') return;
  for (const t of g.tanks) aiShop(g, t);                 // the computer shops as the round turns
  G.shopping = false;
  nextRound(g);
  G.landKey = '';                                        // new land: never trust the old canvas
  G.blasts = []; G.fires = []; G.beams = []; G.last = 0; G.dirty = true; G.aiAt = performance.now();
  overlay(null);
  onEvents(step(g, 0), performance.now());
  if (!G.raf) G.raf = requestAnimationFrame(frame);
}

function gameOver() {
  const g = G.game;
  G.running = false; G.paused = false; G.shopping = false;
  g.phase = 'over';
  sound.setMusic(false);
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
  if (demoing()) demoWait(DEMO_WAR_MS, start);               // and the next war begins by itself
}

// ------------------------------------------------------------------ input
// THE HELD KEY'S STEP. The browser repeats a held key for us; what it cannot do is accelerate.
// Presses of the same key closer together than RAMP_GAP are counted as one hold: the first four
// move by one, the next six by two, and after that by five. Any other key, or a pause, starts over.
const RAMP_GAP = 260;
export function rampStep(n) { return n < 4 ? 1 : n < 10 ? 2 : 5; }
function repeatStep(key, now = performance.now()) {
  const r = G.rep;
  if (r && r.key === key && now - r.at < RAMP_GAP) { r.n += 1; r.at = now; } else G.rep = { key, n: 1, at: now };
  return rampStep(G.rep.n);
}

/** The last shot again, exactly: the original's most missed convenience. */
function repeatShot(g, t) {
  const last = G.lastShot;
  if (!last) { G.h?.toast?.('no shot to repeat yet'); return; }
  aim(g, t, { angle: last.angle, power: last.power });
  if (last.weapon && (t.inventory[last.weapon] ?? 0) > 0) t.weapon = last.weapon;
  sound.play('rotate');
}

// THE WHEEL, over the field: power, and with Shift the angle. The pointer is already there, and a
// wheel is the one input that gives a hundred units without a hundred presses.
function onWheel(e) {
  if (!humanTurn()) return;
  const g = G.game, t = current(g);
  const dir = e.deltaY < 0 ? 1 : -1;
  e.preventDefault();
  if (e.shiftKey) { aim(g, t, { angle: t.angle + dir }); sound.play('move'); }
  else { aim(g, t, { power: t.power + dir * (e.ctrlKey ? 50 : 10) }); sound.play('soft'); }
  G.dirty = true;
  if (!G.raf) draw();
}

// TYPED NUMBERS. A player reading a solution off the last shot wants to enter it, not walk to it:
// clicking the angle or the power on the HUD turns that value into a box. drawStats leaves the
// panel alone while one is open, so the number under the cursor does not move as it is typed.
function onStatsClick(e) {
  const b = e.target?.closest?.('b[data-edit]');
  if (!b || !humanTurn()) return;
  const which = b.dataset.edit;
  const g = G.game, t = current(g);
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'syedit';
  input.value = String(which === 'angle' ? t.angle : t.power);
  input.min = '0';
  input.max = which === 'angle' ? '180' : '1000';
  G.editing = which;
  b.replaceChildren(input);
  input.focus();
  input.select();
  const done = (commit) => {
    if (G.editing !== which) return;
    G.editing = null;
    const v = Number(input.value);
    if (commit && Number.isFinite(v)) aim(g, t, which === 'angle' ? { angle: v } : { power: v });
    G.dirty = true;
    draw();
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); done(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
  });
  input.addEventListener('blur', () => done(true));
}

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
  // A WAY OUT WHEN YOU ARE DEAD (operator, 2026-09-16: "There is no way to restart the game if I
  // die. I have to wait for the AI to finish the game"). A war is five rounds; a player knocked out
  // in round one had nothing to do but watch. F2 and the button start a fresh one from round one.
  if (e.key === 'F2') { e.preventDefault(); restart(); return; }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { if (G.running && g?.phase !== 'roundOver') { e.preventDefault(); G.paused ? resume() : pause('paused'); } return; }
  if (!humanTurn()) return;
  const t = current(g);
  // THE RAMP (the control scope's C1): a held arrow steps 1, then 2, then 5 -- crossing 180
  // degrees is a second and a half, and the last degree is still one press. Shift and Ctrl keep
  // their fixed fine and coarse steps, so a player who knows the number can still land on it.
  const ramp = repeatStep(e.key);
  const big = e.shiftKey ? 5 : ramp;
  const pstep = e.ctrlKey ? 100 : e.shiftKey ? 1 : 10 * ramp;
  let used = true;
  switch (e.key) {
    case 'ArrowLeft': aim(g, t, { angle: t.angle + big }); sound.play('move'); break;
    case 'ArrowRight': aim(g, t, { angle: t.angle - big }); sound.play('move'); break;
    case 'ArrowUp': aim(g, t, { power: t.power + pstep }); sound.play('soft'); break;
    case 'ArrowDown': aim(g, t, { power: t.power - pstep }); sound.play('soft'); break;
    case ',': case '<': aim(g, t, { power: t.power - 1 }); sound.play('soft'); break;
    case '.': case '>': aim(g, t, { power: t.power + 1 }); sound.play('soft'); break;
    case 'r': case 'R': repeatShot(g, t); break;
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
  const me = current(g);
  G.lastShot = { angle: me.angle, power: me.power, weapon: me.weapon };   // R fires it again
  if (fire(g, me)) {
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
  const wasAngle = Math.round(t.angle), wasPower = Math.round(t.power);
  aim(g, t, { angle: Math.max(0, Math.min(180, angle)), power: Math.min(1000, Math.hypot(dx, dy) * 28) });
  // THE CLICKS (operator, 2026-09-16: "I'm not hearing the adjustment clicks when I move with the
  // mouse"). The keys and the wheel clicked; the drag was silent. It clicks now on every whole
  // degree and every ten of power it crosses, no more than a few times a frame's worth apart, so
  // a slow drag ticks and a fast one whirs rather than machine-gunning.
  const now = performance.now();
  if (now - (G.dragClickAt ?? 0) >= 45) {
    if (Math.round(t.angle) !== wasAngle) { sound.play('move'); G.dragClickAt = now; }
    else if (Math.round(t.power / 10) !== Math.round(wasPower / 10)) { sound.play('soft'); G.dragClickAt = now; }
  }
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
  el('syRestart')?.addEventListener('click', () => restart());
  el('syShop')?.addEventListener('click', onShopClick);
  el('syStats')?.addEventListener('click', onStatsClick);
  el('syField')?.addEventListener('wheel', onWheel, { passive: false });
  const field = el('syField');
  field?.addEventListener('pointerdown', onPointerDown);
  field?.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  for (const [id, key] of SWITCHES) el(id)?.addEventListener('click', () => flip(key));
  el('sySkySw')?.addEventListener('click', () => { const s = loadSettings(); setSetting(s, 'scorched.sky', nextSky(scorchedOptions(s).sky.sky)); sound.unlock(); drawSwitches(); drawSky(); G.dirty = true; if (!G.raf) draw(); });
}

/** The game on screen, for a tool or a test that drives the page (never the rules' way in). */
export function currentGame() { return G.game; }

export function renderScorchedYard(s, state, h) {
  G.state = state; G.h = h;
  bind();
  drawSwitches();
  drawSky();
  if (!G.game) {
    overlay('Scorched Yard', 'the block space is the battlefield. You against the computer: ← → angle, ↑ ↓ power, [ ] weapon, space fires; or drag on the field to aim. Enter or the button to play.', 'play');
    drawStats(); drawTanks(); drawScores(); draw();
    return;
  }
  if (G.running && G.paused) overlay(G.why, 'the guns are holding', 'resume', true);
  if (G.running && !G.paused && !G.raf && G.game.phase !== 'over') { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else { G.dirty = true; draw(); }
}
