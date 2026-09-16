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
import { decide, prepare, shop as aiShop } from './scorchedai.js';
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

/**
 * THE BLAST, IN BLOCKS (operator, 2026-09-16: "the bubble sprites look terrible on the terrain
 * explosions"). The first cut drew the fireball, the shockwave, the sparks and the smoke as
 * spheres, and the engine draws a sphere with a rim and a glint: at any size a cloud of them is a
 * cloud of BUBBLES sitting on the dirt. Nothing about that belongs in a game whose land, tanks and
 * shells are all cubes.
 *
 * So the explosion is made of the same thing as everything else -- blocks, on the field's own grid.
 * The fireball is a disc of them, coarse at the centre of a nuke and fine for a baby missile, hot
 * in the middle and darker at the rim; the shockwave is a ring of small ones racing out; the
 * sparks are single blocks thrown on ballistic paths; and the smoke is blocks that rise, spread,
 * drift downwind, grow, darken and thin away (their alpha, not their size, is what fades, so they
 * never shrink to glints). Alpha is a tile field the renderer already carries.
 */
const HOT = Object.freeze(['#fff3cd', '#ffc457', '#f3813a', '#a83a20']);
const RIOT = Object.freeze(['#e8f7ff', '#a8dcff', '#6fb6e8', '#3f7fae']);

export function blastTiles(blasts, now, ms = BLAST_MS, { wind = 0 } = {}) {
  const out = [];
  for (const b of blasts) {
    const age = now - b.t0;
    const t = Math.min(1, Math.max(0, age / ms));
    if (t < 1) {
      const palette = b.riot ? RIOT : HOT;
      // the fireball: a disc of blocks on a grid coarse enough that a nuke costs about a hundred
      const fr = b.r * (0.55 + 0.8 * t);
      const step = Math.max(0.55, fr / 5.5);
      const fade = t < 0.3 ? 1 : Math.max(0, 1 - (t - 0.3) / 0.7);
      for (let dy = -fr; dy <= fr + 1e-6; dy += step) {
        for (let dx = -fr; dx <= fr + 1e-6; dx += step) {
          const d = Math.hypot(dx, dy);
          if (d > fr) continue;
          const y = b.y + dy;
          if (y < 0) continue;
          const k = fr > 0 ? d / fr : 0;
          const col = palette[Math.min(palette.length - 1, Math.floor(k * 3 + t * 0.8))];
          out.push({
            txid: `fire${b.id}_${dx.toFixed(2)}_${dy.toFixed(2)}`,
            x: b.x + dx - step / 2, y: y - step / 2, s: step * 0.92, tall: step * 0.92,
            color: col, alpha: Math.max(0, fade * (1 - 0.55 * k)),
          });
        }
      }
      // the shockwave: a ring of small blocks racing out and thinning
      if (t < 0.45 && !b.riot) {
        const rr = b.r * (0.4 + 3.2 * t), nb = 26, sz = Math.max(0.22, b.r * 0.1);
        for (let i = 0; i < nb; i++) {
          const a = (i / nb) * Math.PI * 2;
          const x = b.x + Math.cos(a) * rr, y = b.y + Math.sin(a) * rr;
          if (y < 0) continue;
          out.push({ txid: `ring${b.id}_${i}`, x: x - sz / 2, y: y - sz / 2, s: sz, tall: sz, color: '#ffe9b8', alpha: Math.max(0, 1 - t / 0.45) });
        }
      }
      // what the blast throws
      const n = b.big ? 22 : 12;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + b.id * 0.7;
        const sp = (0.8 + ((i * 7) % 5) / 5) * b.r * 2.2;
        const x = b.x + Math.cos(a) * sp * t, y = b.y + Math.sin(a) * sp * t - 6 * t * t;
        if (y < 0) continue;
        const sz = 0.14 + (i % 3) * 0.06;
        out.push({ txid: `spark${b.id}_${i}`, x: x - sz / 2, y: y - sz / 2, s: sz, tall: sz, color: t < 0.4 ? '#ffb74d' : '#e2601f', alpha: Math.max(0, 1 - t * 0.9) });
      }
    }
    // the smoke: blocks, rising and fanning, drifting downwind, growing and thinning
    if (!b.riot && b.r >= 1.4 && age < SMOKE_MS && age > 80) {
      const u = age / SMOKE_MS;
      const np = Math.min(64, 14 + Math.round(b.r * 4.5));
      for (let i = 0; i < np; i++) {
        const h = (k) => hash(b.id * 13 + i * 7 + k);
        const a = Math.PI * (0.12 + 0.76 * h(1));                       // upward, fanned
        const rise = (0.8 + h(2) * 1.5) * b.r * Math.sqrt(u);
        const x = b.x + Math.cos(a) * rise * 0.75 + wind * 0.25 * age / 1000 + (h(3) - 0.5) * b.r * 0.8 * u;
        const y = b.y + Math.sin(a) * rise + 0.3 + Math.sin(age / 400 + h(5) * 6) * 0.15;
        const life = 0.8 + h(6) * 0.2;
        if (y < 0 || u > life) continue;                                // each block thins out on its own time
        const s = (0.45 + h(4) * 0.4) * (0.75 + 1.1 * u) * Math.min(1.7, 0.85 + b.r * 0.075);
        const col = mixHex(u < 0.3 ? '#a3a1ab' : '#6f6e79', '#403f49', Math.max(0, (u - 0.35) / 0.65));
        out.push({ txid: `smoke${b.id}_${i}`, x: x - s / 2, y: y - s / 2, s, tall: s * 0.8, color: col, alpha: Math.max(0, 0.55 * (1 - u / life)) });
      }
    }
  }
  return out;
}

/** A tank going up: sparks in its colour flung out and falling, and three pieces of hull tumbling away. */
export function deathTiles(deaths, now, ms = DEATH_MS) {
  const out = [];
  for (const d of deaths) {
    const t = Math.min(1, Math.max(0, (now - d.t0) / ms));
    if (t >= 1) continue;
    for (let i = 0; i < 26; i++) {
      const h = (k) => hash(d.id * 17 + i * 5 + k);
      const a = Math.PI * (0.05 + 0.9 * h(1)), sp = 6 + h(2) * 10;
      const x = d.x + Math.cos(a) * sp * t, y = d.y + 0.5 + Math.sin(a) * sp * t - 10 * t * t;
      if (y < 0) continue;
      out.push({ txid: `dspark${d.id}_${i}`, x: x - 0.11, y: y - 0.11, s: 0.22, tall: 0.22, sphere: true, color: shadeTo(t < 0.4 ? '#fff0c0' : d.colour, 1 - t * 0.6) });
    }
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

/** Dust where fallen dirt landed: a few puffs that rise and thin. */
export function dustTiles(dusts, now, ms = DUST_MS) {
  const out = [];
  for (const d of dusts) {
    const t = Math.min(1, Math.max(0, (now - d.t0) / ms));
    if (t >= 1) continue;
    for (let i = 0; i < 4; i++) {
      const h = (k) => hash(d.id * 19 + i * 3 + k);
      const x = d.x + 0.5 + (h(1) - 0.5) * 1.6 * (0.3 + t), y = d.y + 0.2 + t * (0.6 + h(2) * 0.8);
      const s = 0.3 + t * 0.5;
      out.push({ txid: `dust${d.id}_${i}`, x: x - s / 2, y: y - s / 2, s, tall: s * 0.5, sphere: true, color: mixHex('#a08a68', '#6a5d48', t) });
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
const BANDS = Object.freeze([
  Object.freeze({ speed: 0.55, len: 0.5, th: 0.7, near: '#6f7278', far: '#5d6066' }),
  Object.freeze({ speed: 0.82, len: 0.78, th: 1.0, near: '#8e8c84', far: '#7b7972' }),
  Object.freeze({ speed: 1.15, len: 1.1, th: 1.4, near: '#b3ada0', far: '#9e9890' }),
]);

/**
 * The streaks for a canvas `w` x `h` CSS pixels at `now`, as plain geometry: `{ x, y, len, th,
 * colour }` with x the centre. Pure, so a test can hold the wind to its speed and its shape.
 */
export function windStreaks(wind, now, w, h) {
  const strength = Math.min(1, Math.abs(wind ?? 0) / 10);
  if (!w || !h || strength < 0.03) return [];
  const dir = wind < 0 ? -1 : 1;
  const t = now / 1000;
  // THE GUST NEVER PULLS BACKWARDS (operator: "the wind switches directions when idle"). A gust
  // that multiplies `t * speed` moves a streak BACK whenever it eases off, because the whole
  // elapsed time is rescaled. So the gust is a rate, and the distance travelled is its integral:
  // t + (a/w)*(1 - cos(w*t)) rises for every t while a < 1, so the air only ever goes one way.
  const GA = 0.3, GW = 0.55;
  const phase = t + (GA / GW) * (1 - Math.cos(GW * t));
  const gustLen = 1 + GA * Math.sin(GW * t);                 // the same wave, for the length alone
  const n = Math.round(18 + 54 * strength);
  const out = [];
  for (let i = 0; i < n; i++) {
    const h6 = hashAt(i);
    const band = BANDS[i % BANDS.length];
    const len = w * (0.011 + 0.062 * strength) * band.len * (0.55 + h6(6) * 0.9) * gustLen;
    const speed = w * (0.05 + 0.5 * strength) * band.speed * (0.7 + h6(1) * 0.6);
    const span = w + len * 2;
    const x = ((((h6(2) * span + phase * speed * dir) % span) + span) % span) - len;
    out.push({ x, y: Math.round(h6(3) * h) + 0.5, len, th: band.th * (0.8 + h6(4) * 0.6), colour: h6(5) > 0.5 ? band.near : band.far, dir });
  }
  return out;
}

/** Paint them: a tapered quad each, flat colour, nothing else -- the canvas rules hold here too. */
export function paintWind(ctx, streaks, w, h) {
  ctx.clearRect(0, 0, w, h);
  for (const s of streaks) {
    const tail = s.x - (s.len / 2) * s.dir, head = s.x + (s.len / 2) * s.dir;
    const waist = s.x - (s.len * 0.2) * s.dir;
    ctx.fillStyle = s.colour;
    ctx.beginPath();
    ctx.moveTo(head, s.y);
    ctx.lineTo(waist, s.y - s.th);
    ctx.lineTo(tail, s.y);
    ctx.lineTo(waist, s.y + s.th);
    ctx.closePath();
    ctx.fill();
  }
}

function drawWind(now) {
  const c = el('syWind');
  if (!c) return;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintWind(ctx, windStreaks(G.game?.wind ?? 0, now, w, h), w, h);
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
  out.push(...fireTiles(fires, now), ...beamTiles(beams, now), ...dustTiles(dusts, now), ...blastTiles(blasts, now, BLAST_MS, { wind: g.wind ?? 0 }), ...deathTiles(deaths, now));
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

const SWITCHES = [['syStars', 'stars'], ['syGalaxy', 'galaxy'], ['syMusic', 'music'], ['sySfx', 'sfx'], ['syTalkSw', 'talk'], ['syFast', 'fast'], ['syDemo', 'demo']];
function drawSwitches() {
  const t = scorchedOptions(loadSettings());
  const living = t.sky.skyType === 'living';
  for (const [id, key] of SWITCHES) {
    const b = el(id);
    if (!b) continue;
    // a switch that does nothing is worse than no switch: the star field's two go away while the
    // living sky is drawing the day
    if (key === 'stars' || key === 'galaxy') b.classList.toggle('hidden', living);
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
  if (key === 'stars' || key === 'galaxy') drawSky();
  if (key === 'demo') { clearTimeout(G.demoTimer); G.demoTimer = null; if (G.running) { start(); return; } }
  G.dirty = true;
  if (!G.running || G.paused) draw();
}

function drawSky() {
  const sky = el('sySky');
  if (!sky) return;
  const t = scorchedOptions(loadSettings());
  // Under the LIVING SKY the star field's two switches do not apply: the day draws whatever they
  // say (the sky was going black with them off), and a spiral galaxy does not belong over it.
  const living = t.sky.skyType === 'living';
  board3d(sky, [], {
    ...SKY,
    stars: living || t.stars, galaxy: !living && t.stars && t.galaxy, galaxyAt: t.galaxyAt,
    starDensity: t.starDensity, starBrightness: t.starBrightness,
    nebulae: t.nebulae, galaxies: t.galaxies, dust: t.dust, clusters: t.clusters, starColours: t.starColours, starGlints: t.starGlints,
    ...t.sky,
    // the clouds of the Living sky drift with this round's wind, and turn with it
    skyWind: G.game ? Math.sign(G.game.wind || 1) * (0.4 + Math.abs(G.game.wind) / 4) : 1,
    // and each round draws its own hour of the Living sky (the original's sky changed each round)
    ...(G.game && t.roundSky && t.sky.skyType === 'living' ? { skyClock: 'fixed', skyHour: ROUND_HOURS[(G.game.seed + G.game.round * 7) % ROUND_HOURS.length] } : {}),
  });
}
const ROUND_HOURS = [6.6, 9, 12, 15, 17.8, 19, 21.5, 1];

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
      case 'death': { sound.play('syDeath'); const tk = g.tanks[e.tank]; G.deaths.push({ id: ++G.seq, x: tk.x + TANK_W / 2, y: tk.y, colour: tk.colour, t0: now }); say(tk, 'death', 2); G.h?.toast?.(`${tk.name} is destroyed`); break; }
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
    overlay('Scorched Yard', 'the block space is the battlefield. You against the computer: ← → angle, ↑ ↓ power, [ ] weapon, space fires; or drag on the field to aim. Enter or the button to play.', 'play');
    drawStats(); drawTanks(); drawScores(); draw();
    return;
  }
  if (G.running && G.paused) overlay(G.why, 'the guns are holding', 'resume', true);
  if (G.running && !G.paused && !G.raf && G.game.phase !== 'over') { G.last = 0; G.raf = requestAnimationFrame(frame); }
  else { G.dirty = true; draw(); }
}
