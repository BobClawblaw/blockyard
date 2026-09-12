// SETTINGS THE VIEWER KEEPS (operator, 2026-09-12: "We need to add a configuration panel, allow
// persistent settings for our app ... tweaking the visual effects of the Block space. eg: remove
// shadows, simple cubes, lower level of detail etc... anything to make it run faster ... settings
// that affect the star field").
//
// Every switch here maps to an option the renderer already honours, or to one added for it
// (`shadows`, `starDensity`, `starBrightness`). Nothing in this file draws: it holds the values,
// clamps them, persists them per browser, and hands the renderers their options. A setting that
// did not change what is drawn would be a lie told in a checkbox.
//
// Stored per browser under `bmc.settings` (like `bmc.viewerMode`), because these are view
// preferences, not node state: a kiosk screen and a laptop looking at the same monitor want
// different answers, and neither should need an account to have one.

export const SETTINGS_KEY = 'bmc.settings';

// [value, ...allowed] for enums; [value, min, max] for numbers; booleans are themselves.
export const DEFAULTS = Object.freeze({
  space: Object.freeze({
    shadows: true,        // cube-on-cube and resting shadows (blockscene3d shadowOps)
    idleFx: true,         // the effects at rest: ripples, light cycles, the lightning ball
    edges: true,          // the dark seam around each stone
    grid: true,           // the neon grid on the board
    stars: false,         // opt-in: a star field twinkles, so the board never stops repainting
    dome: 5,              // how far the board bows toward the viewer, 0 = flat
    detail: 'full',       // 'full' | 'simple' | 'flat' -- facet and crown thresholds below
    motion: 'full',       // 'full' | 'quick' | 'still' -- the refresh choreography
  }),
  markets: Object.freeze({
    stars: true,
    starDensity: 1,       // multiplies the star count (0.2 .. 3)
    starBrightness: 1,    // multiplies each star's alpha (0.2 .. 1.5)
    glow: true,           // the neon halo under the grid lines
  }),
});

const DETAIL = {
  // facetPx/crownPx are "draw this extra detail only when a stone is at least this many device
  // pixels across". Raising them is the cheap way to simplify: the same scene, fewer polygons.
  full: { facetPx: 9, crownPx: 18 },
  simple: { facetPx: 26, crownPx: 64 },
  flat: { facetPx: 1e9, crownPx: 1e9, edges: false, seamAlpha: 0 },
};

const MOTION = {
  full: null,                                              // the shipped 20 s choreography
  quick: { rise: 900, travel: 3200, drop: 1800 },
  still: { rise: 0, travel: 1, drop: 0 },                  // lands immediately; no flight
};

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

/** Merge anything (a parsed store, a patch) onto the defaults, clamping every value. */
export function normalise(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const sp = s.space && typeof s.space === 'object' ? s.space : {};
  const mk = s.markets && typeof s.markets === 'object' ? s.markets : {};
  return {
    space: {
      shadows: bool(sp.shadows, DEFAULTS.space.shadows),
      idleFx: bool(sp.idleFx, DEFAULTS.space.idleFx),
      edges: bool(sp.edges, DEFAULTS.space.edges),
      grid: bool(sp.grid, DEFAULTS.space.grid),
      stars: bool(sp.stars, DEFAULTS.space.stars),
      dome: clamp(sp.dome, 0, 12, DEFAULTS.space.dome),
      detail: pick(sp.detail, ['full', 'simple', 'flat'], DEFAULTS.space.detail),
      motion: pick(sp.motion, ['full', 'quick', 'still'], DEFAULTS.space.motion),
    },
    markets: {
      stars: bool(mk.stars, DEFAULTS.markets.stars),
      starDensity: clamp(mk.starDensity, 0.2, 3, DEFAULTS.markets.starDensity),
      starBrightness: clamp(mk.starBrightness, 0.2, 1.5, DEFAULTS.markets.starBrightness),
      glow: bool(mk.glow, DEFAULTS.markets.glow),
    },
  };
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    return normalise(raw ? JSON.parse(raw) : null);
  } catch {
    return normalise(null);          // unreadable or corrupt: the defaults, never a crash
  }
}

export function saveSettings(next, storage = globalThis.localStorage) {
  const s = normalise(next);
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode, quota: keep it in memory */ }
  return s;
}

/** Set one value by "group.key" and persist the result. Returns the whole settled object. */
export function setSetting(current, path, value, storage = globalThis.localStorage) {
  const [group, key] = String(path).split('.');
  const base = normalise(current);
  if (!base[group] || !(key in base[group])) return base;    // unknown key: ignored, not stored
  return saveSettings({ ...base, [group]: { ...base[group], [key]: value } }, storage);
}

export function resetSettings(storage = globalThis.localStorage) {
  try { storage?.removeItem(SETTINGS_KEY); } catch { /* nothing to remove */ }
  return normalise(null);
}

/** True when nothing has been changed from the shipped defaults. */
export function isDefault(s) {
  return JSON.stringify(normalise(s)) === JSON.stringify(normalise(null));
}

/**
 * The renderer options for a block-space board (mining.js: Overview, Block space, Mempool, Kiosk).
 * Merged OVER the caller's own options, so a mode's resolution and slab still win where they are
 * the point of the mode; these are the user's preferences about how it is drawn.
 */
export function spaceOptions(s) {
  const sp = normalise(s).space;
  const d = DETAIL[sp.detail] ?? DETAIL.full;
  const out = {
    shadows: sp.shadows,
    idleFx: sp.idleFx,
    grid: sp.grid,
    space: sp.stars,
    dome: sp.dome,
    facetPx: d.facetPx,
    crownPx: d.crownPx,
  };
  if (d.edges === false) out.edges = false;
  else out.edges = sp.edges;
  if (d.seamAlpha != null) out.seamAlpha = d.seamAlpha;
  else if (!sp.edges) out.seamAlpha = 0;
  const motion = MOTION[sp.motion];
  if (motion) out.transition = motion;
  return out;
}

/** The renderer options for the markets board (markets.js board3d). */
export function marketsOptions(s) {
  const mk = normalise(s).markets;
  return {
    space: mk.stars,
    starDensity: mk.starDensity,
    starBrightness: mk.starBrightness,
    ...(mk.glow ? {} : { neonHalo: 'rgba(0,0,0,0)', gridGlow: 'rgba(0,0,0,0)' }),
  };
}

// What the panel draws. Kept beside the values so a new setting cannot be added without a
// control, or a control without a value.
export const PANEL = Object.freeze([
  Object.freeze({
    group: 'space',
    title: 'Block space',
    note: 'The 3D board on Overview, Block space, Mempool and Kiosk. Turn things off here if the board is heavy on this machine.',
    rows: Object.freeze([
      Object.freeze({ key: 'shadows', label: 'Shadows', kind: 'toggle', hint: 'Cubes casting shadows on the board and on each other' }),
      Object.freeze({ key: 'idleFx', label: 'Idle effects', kind: 'toggle', hint: 'Ripples, scans, light cycles and the lightning ball while the board rests' }),
      Object.freeze({ key: 'edges', label: 'Stone edges', kind: 'toggle', hint: 'The dark seam around each stone' }),
      Object.freeze({ key: 'grid', label: 'Neon grid', kind: 'toggle', hint: 'The glowing grid on the board' }),
      Object.freeze({ key: 'stars', label: 'Star field', kind: 'toggle', hint: 'Stars behind the board. They twinkle, so the board keeps repainting while they are on' }),
      Object.freeze({
        key: 'detail', label: 'Level of detail', kind: 'choice', hint: 'Simpler cubes draw fewer polygons at the same size',
        options: Object.freeze([['full', 'Full'], ['simple', 'Simple cubes'], ['flat', 'Flat tiles']]),
      }),
      Object.freeze({
        key: 'motion', label: 'Refresh animation', kind: 'choice', hint: 'How blocks travel when the board refreshes',
        options: Object.freeze([['full', 'Full flight'], ['quick', 'Quick'], ['still', 'None']]),
      }),
      Object.freeze({ key: 'dome', label: 'Board curve', kind: 'range', min: 0, max: 12, step: 1, hint: 'How far the board bows toward you; 0 is flat' }),
    ]),
  }),
  Object.freeze({
    group: 'markets',
    title: 'Markets & Price',
    note: 'The candle board on Markets and Kiosk.',
    rows: Object.freeze([
      Object.freeze({ key: 'stars', label: 'Star field', kind: 'toggle', hint: 'The twinkling sky behind the candles' }),
      Object.freeze({ key: 'starDensity', label: 'Star density', kind: 'range', min: 0.2, max: 3, step: 0.1, hint: 'How many stars, against the shipped number' }),
      Object.freeze({ key: 'starBrightness', label: 'Star brightness', kind: 'range', min: 0.2, max: 1.5, step: 0.1, hint: 'How brightly they burn' }),
      Object.freeze({ key: 'glow', label: 'Grid glow', kind: 'toggle', hint: 'The neon halo under the grid lines' }),
    ]),
  }),
]);
