// SPDX-License-Identifier: Apache-2.0
//
// feepalette.js -- feerate bands and their colours, for the block-space
// viewer, the block meter and the feerate legend.
//
// THE BANDS are a geometric series: from FLOOR_RATE to TOP_RATE in equal
// ratios, each threshold rounded to two significant figures so the legend
// reads in plain numbers. Everything below FLOOR_RATE is band 0. A geometric
// series is what a feerate scale wants: the difference between 1 and 2 sat/vB
// matters as much as the difference between 500 and 1000, so the bands sit
// close together near the floor and far apart near the ceiling.
//
// 128 BANDS FROM 0.1 sat/vB (operator, 2026-09-11: "we really need more color
// separation. at least 64 different colors and shades", then "we should try
// 128 colors"). The first palette began at 1 sat/vB with 36 bands, and this
// chain's blocks run from 0.1 to a few tens of sat/vB -- so most of a block
// fell into band 0 and the board was one green. Starting at 0.1 puts
// 0.1..30 sat/vB across some 73 bands, each step about 8% up the scale.
// Thresholds are two significant figures, three where two would repeat the
// band below (an 8% step is finer than two figures near the start of a decade).
//
// THE COLOURS are a ramp through a handful of anchors, interpolated in HSL
// with the hue unwrapped so it only ever travels one way: sky blue for the
// cheapest, through teal, green, yellow-green, yellow, amber, orange, red and
// crimson, to purple for the most expensive -- 280 degrees of hue. Band i takes
// the colour at i / (bands - 1) along the ramp, and its lightness steps
// through a three-band pattern (LIGHT_STEP), so two neighbouring bands differ
// in tone as well as hue and read as separate colours side by side.
//
// feeShade() then gives each tile its own tone of its band's colour: darker
// at the bottom of the band, brighter toward its top, plus a small fixed
// variation per transaction id so a field of equal feerates reads as a field
// of separate stones rather than one flat slab. Only the brightness moves;
// the hue is the band's.

const FLOOR_RATE = 0.1;    // sat/vB: the start of band 1 (below it is band 0)
const TOP_RATE = 2000;     // sat/vB: the start of the last band
const STEPS = 126;         // ratios between FLOOR_RATE and TOP_RATE: 128 bands in all

// n significant figures: figures(1.2505, 2) -> 1.3, figures(14.6, 2) -> 15, figures(1.049, 3) -> 1.05
function figures(v, n) {
  const mag = 10 ** (Math.floor(Math.log10(v)) - (n - 1));
  return Math.round(v / mag) * mag;
}
const tidy = (v) => Number(v.toPrecision(12));   // drop float dust (1.3000000000000003)

export const FEE_BANDS = Object.freeze((() => {
  const bands = [0];
  for (let i = 0; i <= STEPS; i++) {
    const v = FLOOR_RATE * (TOP_RATE / FLOOR_RATE) ** (i / STEPS);
    const two = tidy(figures(v, 2));
    bands.push(two > bands.at(-1) ? two : tidy(figures(v, 3)));
  }
  return bands;
})());

// [position along the ramp, hue (deg), saturation, lightness], with the rate
// that lands there. Hues are unwrapped (they fall from blue past 0 into
// negative = crimson/purple), so linear interpolation moves the hue one way.
const ANCHORS = [
  [0.00, 205, 0.62, 0.42],   // sky blue      under 0.1 sat/vB
  [0.12, 172, 0.60, 0.40],   // teal          ~0.3
  [0.24, 138, 0.58, 0.40],   // green         ~1
  [0.35, 96, 0.58, 0.45],    // yellow-green  ~3
  [0.47, 58, 0.72, 0.50],    // yellow        ~10
  [0.56, 40, 0.76, 0.51],    // amber         ~25
  [0.65, 24, 0.78, 0.51],    // orange        ~60
  [0.78, 2, 0.72, 0.50],     // red           ~250
  [0.89, -28, 0.70, 0.46],   // crimson       ~700
  [1.00, -75, 0.60, 0.46],   // purple        2000 and up
];
// lightness added band by band, in a repeating three-step pattern
const LIGHT_STEP = [0, 0.075, -0.06];

function hslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x]
    : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
}

function rampAt(t, dl = 0) {
  let i = 0;
  while (i < ANCHORS.length - 2 && t > ANCHORS[i + 1][0]) i++;
  const [t0, h0, s0, l0] = ANCHORS[i];
  const [t1, h1, s1, l1] = ANCHORS[i + 1];
  const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return hslToRgb(h0 + (h1 - h0) * f, s0 + (s1 - s0) * f, l0 + (l1 - l0) * f + dl);
}

const hex = (rgb) => '#' + rgb.map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('');

const BAND_RGB = FEE_BANDS.map((_, i) => rampAt(i / (FEE_BANDS.length - 1), LIGHT_STEP[i % LIGHT_STEP.length]));
const BAND_HEX = BAND_RGB.map(hex);

export function feeBandIndex(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return 0;
  // binary search: the highest band whose threshold is <= r
  let lo = 0, hi = FEE_BANDS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (FEE_BANDS[mid] <= r) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function feeColor(rate) {
  return BAND_HEX[feeBandIndex(rate)];
}

// Where a rate sits inside its band, 0 at the threshold and 1 at the next.
// The last band has no upper threshold; it is given one as wide as itself.
function inBand(rate, i) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return 0;
  const lo = FEE_BANDS[i];
  const hi = i + 1 < FEE_BANDS.length ? FEE_BANDS[i + 1] : lo * 2;
  return Math.min(1, Math.max(0, (r - lo) / (hi - lo)));
}

// FNV-1a, 32 bits: a stable number per key, the same in every browser
function hashKey(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SHADE_LOW = 0.84;    // brightness at the bottom of a band
const SHADE_SPAN = 0.26;   // added across the band (so 1.10 at its top)
const KEY_SPREAD = 0.06;   // +/- per-key variation

export function feeShade(rate, key = '') {
  const i = feeBandIndex(rate);
  const rgb = BAND_RGB[i];
  let k = SHADE_LOW + SHADE_SPAN * inBand(rate, i);
  const id = key == null ? '' : String(key);
  if (id) k += KEY_SPREAD * ((hashKey(id) % 1001) / 500 - 1);
  // never past full brightness in any channel: clipping one channel would
  // change the hue, and the hue is the band's
  k = Math.min(k, 255 / Math.max(1, ...rgb));
  return hex(rgb.map((v) => v * k));
}
