// THE SUN (docs/PLAN-SUN-SKY.md; operator, 2026-09-21: "a new 3D background for blockyard that is an animated
// simulation of our sun ... with its various flares, and movements, rotating very slowly ... It's going to be a rather
// serious simulation requiring lots of work"). Answers given to the plan's questions the same day: the look is SDO's
// 171 angstrom GOLD with red prominences; it ships DIM (0.6: "so the chart always wins"); activity runs dense; no Earth
// for scale.
//
// THIS FILE IS MILESTONE 1, THE DISK: a sphere of boiling plasma that turns the way the sun does -- faster at its
// equator than at its poles, about an axis tipped toward the viewer -- darkened toward its limb as a hot opaque ball
// is, with a thin bright atmosphere standing off it. Sunspots, loops, prominences, flares and CMEs are the later
// milestones and hang off the same sphere (the plan's section 4).
//
// BUILT LIKE THE FORMATION (formgl.js), which is this project's template: the numbers and the maths are pure and
// exported (the server loads settings.js, which reads the defaults here, so NOTHING at module level may touch the
// DOM); the picture is one fragment shader on its own GL canvas laid under the board; it declines on a software
// rasteriser; and the 2D fallback (drawSunSky) takes its colours from the same ramp.
//
// WHAT IS MEASURED AND WHAT IS CHOSEN. Measured (the plan cites each): the rotation law, the axis, the limb law, the
// sizes of the cells. Chosen, because a monitor is not a telescope: how fast the clock runs (the sun turns in 25
// days; this one in ten minutes at sunSpin 1), and the cells' size ON SCREEN -- a granule is a 1,400th of the sun's
// width and a supergranule a fiftieth, so on a disk three hundred pixels across the first is invisible and the second
// is six pixels. What the shader draws is the supergranular network, at about its real share of the disk, with finer
// cells inside it only where the pixels exist to show them.

/** Differential rotation, sidereal: omega(lat) = A + B sin^2(lat) degrees a day (sunpy / Beck 1999, the visible band). */
export const SUN_ROT_A = 14.713;
export const SUN_ROT_B = -2.396;
/** Degrees a day at a latitude (radians). The equator turns once in about 24.5 days, latitude 60 in about 28. Pure. */
export function sunOmega(lat) { const s = Math.sin(lat); return SUN_ROT_A + SUN_ROT_B * s * s; }
/** Days for one turn at a latitude. Pure. */
export function sunPeriodDays(lat) { return 360 / sunOmega(lat); }
/** The axis: 7.25 degrees to the ecliptic, seen as a tip toward the viewer (B0) -- and a fixed roll in the picture, so
 *  the equator runs at a slight angle across the disk instead of dead level. Radians. */
export const SUN_TILT = (7.25 * Math.PI) / 180;
export const SUN_ROLL = (11 * Math.PI) / 180;
/** Limb darkening, I(mu)/I(1) = 1 - u (1 - mu), mu the cosine of the angle from the disk's centre; u = 0.6 is the
 *  classic visible-light figure (SDO/HMI measures 0.65-0.69 at 0.9 of the disk). The single biggest "that is a ball,
 *  not the sun" tell, and it costs one multiply. Pure. */
export const SUN_LIMB_U = 0.6;
export function limbDarkening(mu, u = SUN_LIMB_U) { return 1 - u * (1 - Math.max(0, Math.min(1, mu))); }

export const SUN_CONST = Object.freeze({
  TURN_SECONDS: 600,      // one equatorial turn at sunSpin 1 (the real one is 24.5 days: "rotating very slowly")
  SHEAR_PERIOD: 240,      // seconds of the turn-clock between resets of the differential shear (two layers, cross-faded)
  CELLS: 32,              // supergranular cells across the disk's width (the real figure is about fifty)
  BOIL: 0.085,            // how fast the surface churns (0.035 at first: a still picture to the eye)
  RADIUS: 0.30,           // the disk's radius, as a share of the panel's SHORT side, at scale 1
  ATMOSPHERE: 0.055,      // how far the thin bright shell stands off the limb, in radii
  CORONA: 1.9,            // how far the faint outer glow reaches, in radii
  STARS: 0.0009,          // the share of pixels that are a star: sparse -- the sun is the foreground here
});

/** Where the disk sits and how big: fractions of the panel from its top left, and a scale on the radius. In a corner
 *  it is drawn larger and part out of frame -- a limb filling the corner, which is how the SDO close-ups look. (1.7 at
 *  first: on the Markets panel that put the disk over the right third of the chart. The chart is what the page is for.) */
export const SUN_PLACEMENTS = Object.freeze({
  'center': [0.50, 0.50, 1.0],
  'top-left': [0.09, 0.13, 1.3],
  'top-right': [0.91, 0.13, 1.3],
  'bottom-left': [0.09, 0.87, 1.3],
  'bottom-right': [0.91, 0.87, 1.3],
  // (operator, 2026-09-22: "Add middle left and middle right placement for the sun")
  'middle-left': [0.04, 0.50, 1.3],
  'middle-right': [0.96, 0.50, 1.3],
});
export const SUN_PLACEMENT_LABELS = Object.freeze([['center', 'Behind the board'], ['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right'], ['middle-left', 'Middle left'], ['middle-right', 'Middle right']]);
/** The shipped settings (settings.js DEFAULTS.sky pins these equal). 0.6: the operator's answer to the plan -- "ship
 *  dimmer ... so the chart always wins", the Formation's lesson applied from the start. */
export const SUN_AT_DEFAULT = 'top-right';
export const SUN_BRIGHTNESS_DEFAULT = 0.6;
export const SUN_SPIN_DEFAULT = 1;
export const SUN_SPIN_MAX = 8;
/** HOW BIG (sky.sunSize), a multiple of the disk's own size (operator, 2026-09-22, of the first cut: "The sun needs to
 *  fill WAY MORE OF THE FRAME! ... we need a slider to be able to make the sun take up the entire screen if we want, and
 *  have the entire surface as a background"). At 1 the whole disk fits the panel with room round it; from about 4 (in
 *  the middle) or 7 (from a corner) its surface covers the panel edge to edge and the sky IS the surface. The shader
 *  draws finer structure as the pixels appear, so a bigger sun is a closer one, not a blown-up one. */
export const SUN_SIZE_DEFAULT = 2.6;
export const SUN_SIZE_MIN = 0.3;
export const SUN_SIZE_MAX = 10;

/**
 * THE 171 ANGSTROM GOLD, once: [where on the ramp, [r, g, b] 0..1], from the dark of a cell's lane to the white of the
 * hottest plasma. SDO's 171 channel is a false colour -- iron at a million kelvin mapped to gold -- and it is the sun
 * of nearly every picture anyone has seen. The shader reads it as a uniform and the fallback through sunRamp(), so
 * the two cannot drift apart. (The red of the prominences is a second, narrow ramp: milestone 4.)
 */
export const SUN_RAMP = Object.freeze([
  [0.00, [0.012, 0.008, 0.000]],
  [0.18, [0.150, 0.100, 0.010]],
  [0.38, [0.400, 0.300, 0.040]],
  [0.58, [0.700, 0.580, 0.120]],
  [0.76, [0.930, 0.840, 0.330]],
  [0.90, [1.000, 0.960, 0.660]],
  [1.00, [1.000, 1.000, 0.940]],
].map(([t, c]) => Object.freeze([t, Object.freeze(c)])));
/**
 * THE OTHER CHANNELS (item nine; sky.sunChannel). SDO photographs the sun through ten filters and gives each its own
 * false colour; these are the famous ones, as palettes over the SAME picture (the structures each filter really shows
 * differ -- this is the look, not the physics): 171 gold (the quiet corona and its loops: what ships), 304 red-orange
 * (the chromosphere, where prominences live), 193 bronze (hotter corona, holes darkest), 211 violet (active regions),
 * 131 teal (flare plasma), and 'white', the visible-light sun. Same seven stops each, so the shader's array is one size.
 */
const ramp7 = (cols) => Object.freeze([0, 0.18, 0.38, 0.58, 0.76, 0.90, 1].map((t, i) => Object.freeze([t, Object.freeze(cols[i])])));
export const SUN_CHANNELS = Object.freeze({
  171: SUN_RAMP,
  304: ramp7([[0.015, 0.002, 0.0], [0.22, 0.03, 0.005], [0.52, 0.10, 0.01], [0.82, 0.24, 0.03], [0.97, 0.47, 0.10], [1.0, 0.74, 0.36], [1.0, 0.95, 0.80]]),
  193: ramp7([[0.012, 0.006, 0.002], [0.16, 0.085, 0.03], [0.40, 0.23, 0.09], [0.68, 0.43, 0.19], [0.90, 0.68, 0.38], [1.0, 0.88, 0.66], [1.0, 0.98, 0.92]]),
  211: ramp7([[0.008, 0.002, 0.012], [0.12, 0.04, 0.17], [0.32, 0.12, 0.42], [0.56, 0.27, 0.68], [0.80, 0.50, 0.88], [0.94, 0.78, 0.98], [1.0, 0.96, 1.0]]),
  131: ramp7([[0.0, 0.008, 0.010], [0.01, 0.10, 0.12], [0.04, 0.28, 0.32], [0.10, 0.52, 0.56], [0.30, 0.78, 0.80], [0.66, 0.94, 0.94], [0.94, 1.0, 1.0]]),
  white: ramp7([[0.02, 0.012, 0.004], [0.30, 0.19, 0.07], [0.62, 0.44, 0.20], [0.86, 0.70, 0.42], [0.98, 0.88, 0.66], [1.0, 0.96, 0.85], [1.0, 1.0, 0.97]]),
});
export const SUN_CHANNEL_DEFAULT = '171';
export const SUN_CHANNEL_LABELS = Object.freeze([['171', '171 \u00c5 \u2014 gold (the corona)'], ['304', '304 \u00c5 \u2014 red (the chromosphere)'], ['193', '193 \u00c5 \u2014 bronze'], ['211', '211 \u00c5 \u2014 violet'], ['131', '131 \u00c5 \u2014 teal (flare plasma)'], ['white', 'White light']]);
/** The ramp at t (0..1) in a channel: [r, g, b] 0..1. Pure. */
export function sunRamp(t, channel = SUN_CHANNEL_DEFAULT) {
  const SUN_RAMP = SUN_CHANNELS[channel] ?? SUN_CHANNELS[SUN_CHANNEL_DEFAULT];       // (shadows the gold above on purpose: the code below is unchanged)
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < SUN_RAMP.length; i++) {
    const [t1, c1] = SUN_RAMP[i], [t0, c0] = SUN_RAMP[i - 1];
    if (x <= t1) { const k = (x - t0) / Math.max(1e-9, t1 - t0); return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]; }
  }
  return [...SUN_RAMP.at(-1)[1]];
}

/** Where the disk is on a panel: its centre and radius in the panel's own pixels. Pure. */
export function sunDisk(pw, ph, at = SUN_AT_DEFAULT, size = SUN_SIZE_DEFAULT) {
  const p = SUN_PLACEMENTS[at] ?? SUN_PLACEMENTS[SUN_AT_DEFAULT];
  const k = Number.isFinite(size) ? Math.max(SUN_SIZE_MIN, Math.min(SUN_SIZE_MAX, size)) : SUN_SIZE_DEFAULT;
  return { cx: pw * p[0], cy: ph * p[1], r: Math.min(pw, ph) * SUN_CONST.RADIUS * p[2] * k };
}

/**
 * The turn-clock's phases, in doubles, from the integrated clock `turn` (seconds x sunSpin): the rigid turn (an angle,
 * wrapped), and the two SHEAR layers. Differential rotation winds a pattern up for ever -- after a few turns any
 * texture advected by omega(lat) is sheared into hairlines along the parallels -- so the shear alone runs on a
 * sawtooth, two layers half a period apart, each faded out as it resets (the weights sum to one: the Formation's
 * advected gas, the same trick). Returns { spin, a: [shear, weight, cycle], b: [...] }. Pure.
 */
export function sunPhases(turn) {
  const C = SUN_CONST;
  const spin = ((turn / C.TURN_SECONDS) * Math.PI * 2) % (Math.PI * 2);
  const tau = turn / C.SHEAR_PERIOD, tauB = tau + 0.5;
  const w = (f) => 1 - Math.abs(2 * f - 1);                       // 0 at a reset, 1 half way
  const fa = tau - Math.floor(tau), fb = tauB - Math.floor(tauB);
  const wa = w(fa), wb = w(fb), sum = wa + wb || 1;
  // (the shear an equatorial turn's worth of time has made, at the pole, is B/A of a turn: the layer's own age sets it)
  const k = (C.SHEAR_PERIOD / C.TURN_SECONDS) * Math.PI * 2 * (SUN_ROT_B / SUN_ROT_A);
  return { spin, a: [(fa - 0.5) * k, wa / sum, Math.floor(tau) % 64], b: [(fb - 0.5) * k, wb / sum, (Math.floor(tauB) % 64) + 0.5] };
}

// ACTIVE REGIONS (milestone 3's core, brought forward: operator, 2026-09-22, with NASA SVS 5268 open -- the double
// filament eruption of 21 March 2024 -- "Where is all the solar activity in ours?!"). Put beside that frame the first
// cut was an evenly lit ball. The real 171 sun is a DARK mottled disk carrying a handful of blazing active regions:
// two white-hot footpoint clusters of opposite polarity, a fan of coronal loops arching between them, bright moss
// round them; tufts of loop standing off the limb where a region is on it; and they FLARE.
//   * where: the activity belts, 8-32 degrees either side of the equator, alternating hemispheres (the butterfly
//     diagram's band at mid-cycle); tilted toward the equator, more so at higher latitude (Joy's law);
//   * how they move: each is carried round by the rotation law AT ITS OWN LATITUDE (sunOmega) -- a region at 30
//     degrees falls behind one at 10, as sunspots do;
//   * how they live: each grows, holds and decays over a few turns and is born again somewhere else, the ten of them
//     out of step, so there is always activity and never a reset;
//   * flares: each region on its own short cycle -- up in an instant, down slowly (GOES light curves have that
//     shape) -- mostly small, now and then a big one. Dense by the operator's answer to the plan ("near-constant
//     activity, maximum drama"); flares run on the WALL clock, so a sun held still (sunSpin 0) still flares.
// Everything is a function of the two clocks and the region's number: no state, no Math.random.
export const SUN_REGIONS = 10;
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const rnd01 = (a, b, c) => { let h = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b) ^ Math.imul(c + 13, 0xc2b2ae35)) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0; h ^= h >>> 15; return (h >>> 0) / 4294967296; };
/**
 * The regions at turn-clock `turn` (seconds x sunSpin) and wall clock `wall` (seconds):
 * [{ dir: [x, y, z] (unit, in the sun's frame: y its axis, z toward the viewer at longitude 0), lat, lon, size (half the
 * footpoints' separation, radians), tilt, strength 0..1, flare 0..~1.6, loops, seed }]. Pure.
 */
/** THE ACTIVITY CYCLE (item eight; sky.sunCycle, 0 = solar minimum .. 1 = maximum). The sun's eleven-year cycle is the
 *  difference between a nearly blank disk with great polar holes and a storm: it sets HOW MANY regions there are, how
 *  far from the equator they reach, how often they flare and erupt, and how big the polar coronal holes are. It ships
 *  high, by the operator's answer to the plan: "Dense: near-constant activity, maximum drama". */
export const SUN_CYCLE_DEFAULT = 0.8;
const cyc = (c) => (Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : SUN_CYCLE_DEFAULT);
/** How many of the ten regions the cycle allows. Pure. */
export function sunRegionCount(cycle) { return Math.round(1 + (SUN_REGIONS - 1) * cyc(cycle)); }
export function sunRegions(turn, wall = 0, cycle = SUN_CYCLE_DEFAULT) {
  const out = [];
  const cy = cyc(cycle), allowed = sunRegionCount(cy), pace = 1.7 - 0.9 * cy;      // (the periods of flares and eruptions stretch toward minimum)
  for (let k = 0; k < SUN_REGIONS; k++) {
    const span = SUN_CONST.TURN_SECONDS * (2.6 + 2.2 * rnd01(k, 0, 1));           // a life: a few turns
    const tt = turn / span + rnd01(k, 0, 2);
    const life = Math.floor(tt), f = tt - life;
    const R = (j) => rnd01(k, life, j);
    const north = (k + life) % 2 === 0;
    const lat = ((5 + (4 + 23 * cy) * R(3)) * Math.PI / 180) * (north ? 1 : -1);       // a narrow band at the equator at minimum, 5-32 degrees at maximum
    const lon0 = R(4) * Math.PI * 2;
    // carried round at its own latitude's rate (as a share of the equator's, which is what `turn` counts)
    const lon = (lon0 + (turn / SUN_CONST.TURN_SECONDS) * Math.PI * 2 * (sunOmega(lat) / SUN_ROT_A)) % (Math.PI * 2);
    const size = 0.07 + 0.09 * R(5) * R(5);
    const tilt = (north ? -1 : 1) * 0.5 * Math.abs(lat) * (0.5 + R(6));              // Joy's law: the leading spot nearer the equator, more so at higher latitude, with its scatter
    const grow = Math.min(1, f / 0.14), fade = Math.min(1, (1 - f) / 0.22);
    const strength = k < allowed ? Math.max(0, Math.min(grow * grow * (3 - 2 * grow), fade * fade * (3 - 2 * fade))) * (0.55 + 0.45 * R(7)) : 0;
    // the flare cycle: a sharp rise, a slow fall; its size drawn per flare, a few of them large
    const per = (14 + 26 * rnd01(k, 1, 8)) * pace, ft = wall / per + rnd01(k, 2, 9), fi = Math.floor(ft), ff = ft - fi;
    const mag = Math.pow(rnd01(k, fi, 10), 2.2) * 1.6;
    const flare = mag * (ff < 0.05 ? ff / 0.05 : Math.exp(-(ff - 0.05) * 6.5));
    // a LARGE flare sends a wave across the disk (an "EIT wave": a bright front spreading from the site at a few hundred
    // km/s, fading as it goes): how far through its crossing it is, or -1
    const wave = mag > 0.75 && ff > 0.04 && ff < 0.55 ? (ff - 0.04) / 0.51 : -1;
    const dir = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
    // the region's own axes in the plane touching the sphere at it -- x from the following polarity to the leading one,
    // y along the inversion line -- in the PICTURE's frame, for the loops that stand on it (loops3d in the shader)
    const e1 = norm3(cross3([0, 1, 0], dir)), e2 = cross3(dir, e1), ctl = Math.cos(tilt), stl = Math.sin(tilt);
    const ax = [0, 1, 2].map((i) => ctl * e1[i] + stl * e2[i]), ay = [0, 1, 2].map((i) => -stl * e1[i] + ctl * e2[i]);
    out.push({ dir, screen: sunToScreen(dir), axisX: sunToScreen(ax), axisY: sunToScreen(ay), lat, lon, size, tilt, strength, flare, wave, loops: 5 + Math.floor(6 * R(11)), seed: R(12), ...sunEruption(k, wall, strength, pace) });
  }
  return out;
}

// THE LOOPS' GEOMETRY, once a frame (the shader's loops3d reads it from a float texture). For each region, an ARCADE
// of thirteen arches from the leading polarity to the following one, side by side along the inversion line, each
// leaning its own way and its own height; and fifteen LONG loops from one polarity out to weak field far away (the
// fans). Twelve numbers a loop, in the PICTURE's frame: the chord's middle and a bounding radius; R x the chord's
// direction and the loop's brightness; e R x its up direction and whether it is a long one; four dice for the threads
// and the rain. `boil` is the shader's own slow clock: the loops sway on it.
export const SUN_LOOPS = 28;
const SUN_ARCADE = 13;
export function sunLoops(regions, boil = 0, out = new Float32Array(SUN_REGIONS * SUN_LOOPS * 16)) {
  const add = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  regions.forEach((g, k) => {
    const si = Math.floor(g.seed * 4096);
    for (let j = 0; j < SUN_LOOPS; j++) {
      const o = (k * SUN_LOOPS + j) * 16;
      if (!(g.strength > 0.001) || g.screen[2] < -0.5) { out.fill(0, o, o + 16); out[o] = 99; continue; }      // (parked far off: the bound test fails)
      const h = (c) => rnd01(k * 37 + c, j, si);
      const ha = [h(1), h(2), h(3)], hb = [h(4), h(5), h(6)], far = j >= SUN_ARCADE, a = g.size, cs = g.screen, ex = g.axisX, ey = g.axisY;
      let A, B, e, bright;
      if (!far) {
        const y = (j / (SUN_ARCADE - 1) * 2 - 1) * 1.25 + 0.12 * (ha[0] - 0.5);
        A = norm3(add(add(cs, ex, a * (1 + 0.30 * (ha[1] - 0.5))), ey, a * y));
        B = norm3(add(add(cs, ex, -a * (1 + 0.30 * (ha[2] - 0.5))), ey, a * (y + 0.5 * (hb[0] - 0.5))));
        e = 0.7 + 1.5 * hb[1] * hb[1]; bright = 0.55 + 0.45 * hb[2];
      } else {
        const sg = ha[0] < 0.5 ? 1 : -1, ang = (ha[1] * 2 - 1) * 1.7, reach = 2.5 + 7 * ha[2] * ha[2];
        A = norm3(add(add(cs, ex, a * sg * (1 + 0.2 * (hb[0] - 0.5))), ey, a * 0.8 * (hb[1] - 0.5)));
        B = norm3(add(add(cs, ex, a * sg * (1 + reach * Math.cos(ang))), ey, a * reach * Math.sin(ang)));
        e = 0.45 + 0.55 * hb[2]; bright = 0.35 + 0.5 * hb[0];
      }
      const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2], S = [A[0] - mid[0], A[1] - mid[1], A[2] - mid[2]];
      const R = Math.hypot(S[0], S[1], S[2]) || 1e-5, sh = [S[0] / R, S[1] / R, S[2] / R], up = norm3(mid), W = norm3(cross3(sh, up));
      const inc = (ha[1] - 0.5) * (far ? 1.6 : 2.1) + 0.10 * Math.sin(boil * 2 + ha[2] * 40);
      const uh = norm3([0, 1, 2].map((i) => up[i] * Math.cos(inc) + W[i] * Math.sin(inc)));
      out.set([mid[0], mid[1], mid[2], R * Math.max(1, e) + 3.3 * (a * 0.024), R * sh[0], R * sh[1], R * sh[2], bright,
        e * R * uh[0], e * R * uh[1], e * R * uh[2], far ? 1 : 0, ha[0], ha[2], hb[0], hb[2]], o);
    }
  });
  return out;
}

// QUIET PROMINENCES (item three of the list; the plan's milestone 4; the operator's answer to it: "171 gold with RED
// prominences"). Cool dense plasma -- ten thousand kelvin in a million-degree corona -- held up in the dips of the field
// along an inversion line, for days or weeks: against the sky at the limb it GLOWS (red, in hydrogen and helium light);
// against the disk the same thing is a dark FILAMENT, because it absorbs. Measured (stereoscopic SDO + STEREO study,
// arXiv 2103.07111): heights 21,000-60,000 km, which is 0.03-0.09 of a radius; lengths up to a radius and more.
//   Each is a long low arch in 3D -- two feet on the surface, a spine between them -- with a curtain of fine threads
//   hanging under the spine down to the surface (a "hedgerow"). They sit at higher latitudes than the active belts
//   (18-55 degrees), turn with the surface at their latitude, live for many turns, and come and go at nothing.
export const SUN_PROMINENCES = 7;
export function sunProminences(turn) {
  const out = [];
  for (let k = 0; k < SUN_PROMINENCES; k++) {
    const span = SUN_CONST.TURN_SECONDS * (4 + 4 * rnd01(k, 9, 40));
    const tt = turn / span + rnd01(k, 9, 41), life = Math.floor(tt), f = tt - life;
    const R = (j) => rnd01(k + 50, life, j);
    const lat = ((18 + 37 * R(1)) * Math.PI / 180) * ((k + life) % 2 ? 1 : -1);
    const lon = (R(2) * Math.PI * 2 + (turn / SUN_CONST.TURN_SECONDS) * Math.PI * 2 * (sunOmega(lat) / SUN_ROT_A)) % (Math.PI * 2);
    const c = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
    const east = norm3(cross3([0, 1, 0], c)), north = cross3(c, east);
    const ang = (R(3) - 0.5) * 1.2, half = 0.10 + 0.20 * R(4);                       // mostly east-west, as filament channels run
    const along = [0, 1, 2].map((i) => Math.cos(ang) * east[i] + Math.sin(ang) * north[i]);
    const A = norm3([0, 1, 2].map((i) => c[i] + half * along[i])), B = norm3([0, 1, 2].map((i) => c[i] - half * along[i]));
    const grow = Math.min(1, f / 0.12), fade = Math.min(1, (1 - f) / 0.15);
    const strength = Math.min(grow * grow * (3 - 2 * grow), fade * fade * (3 - 2 * fade));
    const height = 0.035 + 0.06 * R(5);                                              // radii: the measured 0.03-0.09
    out.push({ a: sunToScreen(A), b: sunToScreen(B), lat, lon, half, height, strength, seed: R(6), lean: (R(7) - 0.5) * 0.9 });
  }
  return out;
}

// FILAMENT ERUPTIONS AND MASS EJECTIONS (milestones 5 and 6; operator, 2026-09-22: "build the filament eruptions and
// CMEs next", with NASA SVS 5268 -- the double filament eruption of 21 March 2024 -- and 5239, the M7.4 flare of
// 10 March). Modelled on those films frame by frame (171 and 304, the eruption's quadrant, twelve frames each):
//   1. a FILAMENT lies beside the region along its polarity inversion line -- a dark sinuous thread, there for a
//      long time (cool dense plasma held in the dips of a twisted flux rope);
//   2. it ACTIVATES: brightens along its length, and rises slowly (the measured slow rise is ~10 km/s for an hour);
//   3. it ERUPTS: the fast rise (100-230 km/s measured) flings it off. What leaves is the three-part structure --
//      a bright leading FRONT, a dark CAVITY, a bright twisted CORE (the filament itself: red, as the operator asked
//      of the prominences) -- growing as it goes and fading over a long way, never popping;
//   ...or it FAILS (46% do not make a CME: of 1,225 prominence eruptions in cycle 24, 54% did): the material rises
//      a fifth of a radius, stalls, and falls back the way it came;
//   4. behind it two bright RIBBONS light where the filament was and move apart, an ARCADE of loops lighting between
//      them from the middle outward; and the corona round the site DIMS, where the ejection emptied it, and recovers.
// Each region runs this on its own period, out of step, on the WALL clock (a sun held still still erupts). Pure.
export const SUN_ERUPTION = Object.freeze({ PERIOD: [46, 84], ACTIVE: 34, SLOW: 0.16, FAIL: 0.46, FAIL_HEIGHT: 0.22, REACH: 2.8 });
export function sunEruption(k, wall, strength = 1, pace = 1) {
  const E = SUN_ERUPTION;
  const per = (E.PERIOD[0] + (E.PERIOD[1] - E.PERIOD[0]) * rnd01(k, 3, 30)) * pace;      // (the ACTIVE part stays 34 s: toward minimum it is the quiet between that grows)
  const et = wall / per + rnd01(k, 4, 31), ei = Math.floor(et), ef = et - ei, active = E.ACTIVE / per;
  const fails = rnd01(k, ei, 32) < E.FAIL;
  if (strength < 0.4) return { phase: -1, fails, height: 0, filament: Math.max(0, (strength - 0.15) / 0.25) * (ef < active ? 0 : 1) };
  if (ef >= active) { const back = (ef - active) / (1 - active); return { phase: -1, fails, height: 0, filament: Math.min(1, back / 0.5) }; }   // quiet: the filament re-forms
  const t = ef / active;
  return { phase: t, fails, height: sunEruptionHeight(t, fails), filament: fails ? 1 - 0.6 * Math.sin(Math.PI * Math.min(1, t / 0.6)) : Math.max(0, 1 - t / E.SLOW) };
}
/** How high the erupting material stands, in radii above the surface, `t` (0..1) through the event: the slow rise, then
 *  the fast one, accelerating all the way out -- or, failing, up to a fifth of a radius and back. Pure. */
export function sunEruptionHeight(t, fails = false) {
  const E = SUN_ERUPTION;
  if (!(t >= 0)) return 0;
  if (fails) return E.FAIL_HEIGHT * Math.sin(Math.PI * Math.min(1, t / 0.6));
  if (t < E.SLOW) return 0.045 * (t / E.SLOW);
  return 0.045 + E.REACH * Math.pow((t - E.SLOW) / (1 - E.SLOW), 1.8);
}
/** A direction in the sun's frame, in the PICTURE's (x right, y up, z toward the viewer): the inverse of what the shader
 *  does to a pixel (the roll in the picture, then the tip toward the viewer). Pure. */
export function sunToScreen(c) {
  const ct = Math.cos(SUN_TILT), st = Math.sin(SUN_TILT), cr = Math.cos(SUN_ROLL), sr = Math.sin(SUN_ROLL);
  const y1 = ct * c[1] + st * c[2], z1 = -st * c[1] + ct * c[2], x1 = c[0];
  return [cr * x1 - sr * y1, sr * x1 + cr * y1, z1];
}

// (1.4 million at first: on a big or high-density display the layer was drawn at a third of the panel's pixels and
// stretched, and the fine structure went soft. It is a fraction of a millisecond a frame on a graphics card.)
export const SUN_MAX_PIXELS = 4_200_000;
/** sky.sunDetail: how many pixels the layer may draw before it is drawn smaller and stretched. The shader is heavy for
 *  a laptop's graphics at full size, and a sky must never cost the board its frame rate. */
export const SUN_DETAIL = Object.freeze({ low: 900_000, medium: 2_200_000, high: SUN_MAX_PIXELS });
export const SUN_DETAIL_DEFAULT = 'medium';
export const SUN_DETAIL_LABELS = Object.freeze([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]);
export function isSoftwareGl(renderer) { return /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(String(renderer ?? '')); }

const C = SUN_CONST;
const F = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;       // the hash is 32-bit arithmetic: a fragment shader's ints are mediump unless told
uniform vec2 uPanel;       // canvas pixels
uniform vec3 uDisk;        // the disk: centre (pixels, from the top left) and radius
uniform float uSpin;       // the rigid turn, an angle
uniform vec3 uShearA;      // a shear layer: its shear at the pole (an angle), its weight, its cycle number
uniform vec3 uShearB;
uniform float uBoil;       // the cells' own clock
uniform float uBright;     // sky.sunBrightness
uniform float uCycle;      // sky.sunCycle: 0 solar minimum .. 1 maximum (here: how big the polar coronal holes are)
uniform vec4 uRamp[7];     // the 171 gold: t, r, g, b
uniform vec4 uARd[${SUN_REGIONS}];    // an active region: where it is (unit vector, the sun's frame), and half its footpoints' separation
uniform vec4 uARp[${SUN_REGIONS}];    // ...its tilt, its strength, its flare, and (loops + seed)
uniform vec4 uARe[${SUN_REGIONS}];    // ...its eruption: how far through (-1: none), failing (1) or not, how dark its filament lies, the height
uniform vec4 uARs[${SUN_REGIONS}];    // ...and where it is in the PICTURE's frame (x right, y up, z toward the viewer)
uniform vec4 uARx[${SUN_REGIONS}];    // ...its own x axis there (following polarity -> leading), in the picture's frame
uniform vec4 uARy[${SUN_REGIONS}];    // ...and its y axis (along the inversion line)
uniform highp sampler2D uLoops;       // every loop's geometry, four texels a loop (sunLoops): ${SUN_REGIONS} regions x ${SUN_LOOPS}
uniform vec4 uPrA[${SUN_PROMINENCES}];   // a quiet prominence: one foot (the picture's frame), and its height in radii
uniform vec4 uPrB[${SUN_PROMINENCES}];   // ...the other foot, and (strength + seed/2): strength in the integer-ish part
uniform vec4 uPrC[${SUN_PROMINENCES}];   // ...its lean, and spare
out vec4 o;

uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
vec3 h3(ivec3 c) {
  uint n = pcg(uint(c.x) * 1597334677u ^ pcg(uint(c.y) * 3812015801u ^ pcg(uint(c.z) * 2912667907u)));
  uint a = pcg(n), b = pcg(a);
  return vec3(float(n >> 8), float(a >> 8), float(b >> 8)) / 16777216.0;
}
float h1(vec2 p) { ivec2 c = ivec2(floor(p)); uint n = pcg(uint(c.x) * 1597334677u ^ pcg(uint(c.y) * 3812015801u)); return float(n >> 8) / 16777216.0; }

vec3 gold(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = uRamp[0].yzw;
  for (int i = 1; i < 7; i++) { float k = clamp((t - uRamp[i - 1].x) / max(uRamp[i].x - uRamp[i - 1].x, 1e-5), 0.0, 1.0); c = mix(c, uRamp[i].yzw, k); }
  return c;
}

// CELLS ON A SPHERE: Voronoi in 3D, sampled on the unit sphere's surface, so there is no seam and no pinching at the
// poles. Returns the distance to the nearest cell centre and to the second nearest: their difference is small on a
// LANE (the dark boundary where cool plasma sinks) and large in a cell's bright middle. Centres wander on the
// boil-clock, each on its own phase, so cells push each other about instead of blinking.
vec2 cells(vec3 p, float cycle) {
  ivec3 b = ivec3(floor(p));
  vec3 f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec3 g = ivec3(x, y, z);
    vec3 r = h3(b + g + ivec3(int(cycle), 0, 0));
    vec3 c = vec3(g) + 0.5 + 0.38 * sin(6.2831853 * (r + uBoil * (0.6 + 0.8 * r.zxy))) - f;
    float d = dot(c, c);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return sqrt(vec2(d1, d2));
}

// smooth noise in 3D (value noise, quintic), and a few octaves of it, BAND-LIMITED: px is how many pixels one unit of
// p covers, and an octave whose cells are under a few pixels is faded out -- through a ramp, sub-pixel noise is grit
float vn3(vec3 p) {
  ivec3 i = ivec3(floor(p)); vec3 f = fract(p); vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = h3(i).x, b = h3(i + ivec3(1, 0, 0)).x, c = h3(i + ivec3(0, 1, 0)).x, d = h3(i + ivec3(1, 1, 0)).x;
  float e = h3(i + ivec3(0, 0, 1)).x, g = h3(i + ivec3(1, 0, 1)).x, h = h3(i + ivec3(0, 1, 1)).x, k = h3(i + ivec3(1, 1, 1)).x;
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm3(vec3 p, float px) {
  float a = 0.5, s = 0.0, tot = 0.0;
  for (int k = 0; k < 4; k++) { float w = a * (k == 0 ? 1.0 : smoothstep(2.5, 8.0, px)); s += w * vn3(p); tot += w; p = p * 2.03 + 11.7; a *= 0.5; px /= 2.03; }
  return s / max(tot, 1e-4);
}

// The surface's brightness at a point on the sphere (unit vector, in the sun's own frame, the axis along y), for one
// shear layer: the point is carried back round the axis by the rigid turn and by that layer's shear at its latitude.
//
// WHAT 171 ANGSTROM SHOWS (the first cut drew the visible-light picture -- bright tiles with dark edges -- in gold, and
// it read as giraffe skin): million-degree plasma, which is MOTTLED, not tiled. Its structure is the magnetic
// NETWORK along the supergranular lanes, and in this channel the network is BRIGHT -- a fine irregular lace of
// light over a dimmer, cloudy ground, brightest where lanes meet. So: a cloudy ground (fbm), the lace laid over it
// (bright ON the lanes), both bent out of true by a slow warp so no edge is straight, and the lace itself patchy --
// strong in some regions and nearly absent in others, as the quiet sun's is.
// (returns x: the coarse picture for THIS shear layer; y: the fine structure, which is asked for from ONE layer only
// and is worked out in the RIGIDLY turning frame -- no shear, so nothing to wind up and nothing to reset. Computing it
// in both layers doubled the cost of the most expensive part of the shader for a difference nobody can see: measured
// 2026-09-22 at 1920x1080, size 3.2: 2.8 ms a frame on an RTX 5090, which is a slideshow on a laptop's graphics.)
vec2 surface(vec3 n, vec3 shear, float px, bool withFine) {
  float s2 = n.y * n.y;                                   // sin^2 of the latitude
  float ang = -(uSpin + shear.x * s2);
  float ca = cos(ang), sa = sin(ang);
  vec3 q = vec3(ca * n.x + sa * n.z, n.y, -sa * n.x + ca * n.z) + shear.z * 3.7;   // (each cycle of a layer is another sun's worth of pattern)
  float t = uBoil;
  vec3 warp = vec3(vn3(q * 2.6 + vec3(0.0, t * 0.7, 3.1)), vn3(q * 2.6 + vec3(7.3, 1.9, -t * 0.6)), vn3(q * 2.6 + vec3(-4.2, t * 0.5, 8.8))) - 0.5;
  float freq = ${F(C.CELLS)} * 0.5;
  vec3 qc = (q + 0.30 * warp) * freq;                      // (0.16 left the lace a regular honeycomb; the real network is ragged)
  vec2 d = cells(qc, 0.0);
  float lane = 1.0 - smoothstep(0.0, 0.26, d.y - d.x);      // 1 ON a lane
  float knot = 1.0 - smoothstep(0.0, 0.5, d.y - d.x + 0.9 * (0.62 - d.x));   // brighter where lanes meet (far from every centre)
  float cloudy = fbm3(q * 3.4 + vec3(t * 0.4, 0.0, 0.0) + 0.5 * warp, px / 3.4);
  float patchy = smoothstep(0.30, 0.72, fbm3(q * 1.7 + 21.0, px / 1.7));
  float net = smoothstep(2.0, 6.0, px / freq);             // the lace only where a cell is more than a few pixels
  // THE QUIET SUN IS DARK in this channel (beside SDO's own frame the first cut was an evenly lit ball): a dim cloudy
  // ground, the lace faint over it -- it is the active regions, below, that blaze.
  // (beside SDO's frame, again, 2026-09-22: still too bright and the lace still a HONEYCOMB -- every lane lit the same.
  // The real network is broken: bright in stretches, absent in others, so it never closes into tidy cells.)
  float broken = smoothstep(0.35, 0.75, vn3(q * 9.0 + 13.0)) * (0.35 + 0.9 * vn3(q * 23.0 + 5.0));
  float v = 0.09 + 0.30 * cloudy;
  v += net * (0.10 * lane + 0.12 * knot) * (0.10 + 0.90 * patchy) * broken * 1.5;
  // CORONAL HOLES and filament channels: large dark regions where the field opens into space, commonest at the poles
  float hole = smoothstep(0.56, 0.70, fbm3(q * 1.15 + 40.0, px / 1.15) + (0.10 + 0.42 * (1.0 - uCycle)) * s2 * s2);   // (great polar holes at minimum)
  v *= 1.0 - 0.62 * hole;
  if (!withFine) return vec2(v, 0.0);
  float coarse = v; v = 0.0;
  { float ar2 = -uSpin, c2 = cos(ar2), s3 = sin(ar2); q = vec3(c2 * n.x + s3 * n.z, n.y, -s3 * n.x + c2 * n.z); }
  warp = vec3(vn3(q * 2.6 + vec3(0.0, t * 0.7, 3.1)), vn3(q * 2.6 + vec3(7.3, 1.9, -t * 0.6)), vn3(q * 2.6 + vec3(-4.2, t * 0.5, 8.8))) - 0.5;
  qc = (q + 0.30 * warp) * freq;
  v *= 1.0;
  // GRANULATION, when the sun is close enough to show it (sky.sunSize: the surface as the whole background): the
  // convection cells themselves, several to a network cell, bright tops with dark lanes between -- the visible
  // surface's texture, faint under the corona's. Only where a granule is more than a few pixels across.
  float gf = freq * 5.5, gw = smoothstep(4.0, 12.0, px / gf);
  if (gw > 0.0) { vec2 g = cells((q + 0.05 * warp) * gf + 31.0, 0.0); v += gw * 0.07 * (smoothstep(0.02, 0.30, g.y - g.x) - 0.62); }   // (0.16 read as cracked mud)
  // FINE STRUCTURE AT EVERY SCALE THE PIXELS ALLOW (operator, 2026-09-22, at the shipped size: "I'm still not seeing
  // any surface activity or finer details on the sun" -- rendered at that size the surface was flat tiles). Fibrous,
  // cloudy detail two and three steps finer than the mottling, each let in only where its grain is a few pixels.
  float w2 = smoothstep(2.5, 7.0, px / 41.0), w3 = smoothstep(2.5, 7.0, px / 127.0), w4 = smoothstep(2.5, 7.0, px / 380.0);
  if (w2 > 0.0) v += w2 * 0.20 * (fbm3(q * 41.0 + 0.7 * warp + vec3(0.0, t * 0.9, 0.0), px / 41.0) - 0.5);
  if (w3 > 0.0) v += w3 * 0.15 * (fbm3(q * 127.0 + vec3(t * 1.7, 0.0, 5.0), px / 127.0) - 0.5);
  if (w4 > 0.0) v += w4 * 0.10 * (vn3(q * 380.0 + vec3(0.0, 9.0, t * 3.0)) - 0.5);
  // BRIGHT POINTS: small brightenings all over the quiet sun, along the network, that come up and go out in seconds --
  // the surface is never still, even where there is no active region
  vec2 bp = cells(qc * 2.3 + 53.0, 0.0);
  float tw = vn3(qc * 1.15 + 77.0);
  float pulse = pow(0.5 + 0.5 * sin(t * 8.0 + tw * 60.0), 2.5);        // (a sharp fast pulse -- x26, ^7 -- was dots blinking on and off: they SWELL and fade)
  v += net * 0.24 * pow(max(0.0, 1.0 - bp.x * 2.4), 2.0) * pulse * 0.65 * (1.0 - 0.6 * hole);   // (soft brightenings: at 0.55 and a tight core they were white specks)
  // finer mottling inside the network, where the pixels exist to show it
  v += 0.20 * (fbm3(q * 13.0 + 3.0 + warp, px / 13.0) - 0.5);       // fibrous, mottled: most of what the quiet sun's texture is
  return vec2(coarse, v);
}

const vec3 VIEW = vec3(0.0, -${F(Math.round(Math.sin(SUN_TILT) * 1e6) / 1e6)}, ${F(Math.round(Math.cos(SUN_TILT) * 1e6) / 1e6)});   // toward the viewer, in the sun's frame
// THE ACTIVE REGIONS at a point of the sphere (unit vector, the sun's frame): x how much light they add, y how much
// of it is white-hot, z how much of the surface's own light they take away (a filament, a dimming). Each region is
// worked out in the plane touching the sphere at it, with its two footpoints at (+-1, 0): their white-hot cores, the
// moss round them, the arcade of arches between them and the fans leaving them (below), and its filament.
vec3 regions(vec3 n) {
  float add = 0.0, hot = 0.0, dark = 0.0;
  for (int k = 0; k < ${SUN_REGIONS}; k++) {
    float s = uARp[k].y;
    if (s <= 0.001) continue;
    vec3 c = uARd[k].xyz;
    float cd = dot(n, c);
    if (cd < 0.70 && !(uARx[k].w >= 0.0 && cd > 0.25)) continue;
    float edgeK = smoothstep(0.70, 0.82, cd);                // (its light reaches nothing before the cut-off: at full-screen size the cut drew a straight seam)
    float a = uARd[k].w, fl = uARp[k].z;
    vec3 e1 = normalize(cross(vec3(0.0, 1.0, 0.0), c)), e2 = cross(c, e1);
    vec2 t = vec2(dot(n, e1), dot(n, e2)) / a;
    float ct = cos(uARp[k].x), st = sin(uARp[k].x);
    vec2 u = vec2(ct * t.x + st * t.y, -st * t.x + ct * t.y);
    // (real loops are not a textbook's circles: the field is bent by its neighbours -- a gentle warp, the region's own)
    u += 0.32 * (vec2(vn3(n * 9.0 + uARp[k].w), vn3(n * 9.0 + uARp[k].w + 5.3)) - 0.5) * (0.4 + 0.25 * sqrt(dot(u, u)));
    float r1 = length(u - vec2(1.0, 0.0)), r2 = length(u + vec2(1.0, 0.0)), rr = dot(u, u);
    float nl = floor(uARp[k].w), seed = fract(uARp[k].w);
    // SUNSPOTS (item two of the list): where the field is strongest it chokes the convection, and the surface there is
    // a thousand kelvin cooler and DARK -- an umbra, ringed by a penumbra of fine radial filaments. The LEADING polarity
    // is one compact spot; the FOLLOWING one is broken into smaller ones (as it is on the sun). The light is not ON the
    // spot but ROUND it: the plage, and the feet of the loops, which come down just outside the umbra.
    vec2 v1 = u - vec2(1.0, 0.0), v2a = u - vec2(-1.0, 0.24), v2b = u - vec2(-1.12, -0.26);
    float r2a = length(v2a) / 0.62, r2b = length(v2b) / 0.5;
    float umbra = max(1.0 - smoothstep(0.17, 0.25, r1), max(1.0 - smoothstep(0.17, 0.25, r2a), 1.0 - smoothstep(0.17, 0.25, r2b)));
    float pr = min(r1, min(r2a, r2b));
    vec2 pv = r1 <= min(r2a, r2b) ? v1 : (r2a <= r2b ? v2a : v2b);
    float stri = 0.5 + 0.5 * cos(atan(pv.y, pv.x) * 38.0 + seed * 40.0 + 7.0 * vn3(n * 55.0 + seed * 7.0));
    float penumbra = (1.0 - smoothstep(0.25, 0.47, pr)) * (1.0 - umbra);
    float spot = clamp(0.93 * umbra + penumbra * (0.42 + 0.22 * stri), 0.0, 1.0);
    float plage = exp(-pow((r1 - 0.72) / 0.34, 2.0)) + 0.8 * exp(-pow((min(r2a, r2b) * 0.56 - 0.62) / 0.36, 2.0));
    // (the plage is BRIGHT GOLD AND GRAINY, not white: mixed to white it was a flat wash round every flaring region)
    float core = plage * (1.0 - spot) * (0.5 + 0.95 * vn3(n * 70.0 + seed * 3.0 + vec3(0.0, uBoil * 0.6, 0.0)));
    float moss = exp(-rr / 7.5) * (1.0 - spot);
    // (the loops are not drawn here: they stand OFF the sphere, in three dimensions -- loops3d, below)
    float loops = 0.0;
    float lit = s * (1.0 + 1.3 * fl) * edgeK;
    add += lit * (0.95 * core + 0.28 * moss + 0.62 * loops);
    hot += lit * 0.12 * core + s * edgeK * fl * 0.9 * exp(-rr / 0.35) * (1.0 - 0.5 * spot);   // white-hot only at the flare's kernel, between the spots   // (a flare is white-hot at its HEART: spread wide it was a flat white blob at full-screen size)
    // THE FILAMENT, along the inversion line between the two polarities (u.x = 0), bent into an S: a dark thread while
    // it lies there; then the eruption's marks on the surface -- it brightens as it lifts, two ribbons light where it
    // was and move apart, an arcade of loops lights between them from the middle outward, and the corona round the
    // site dims and recovers.
    // the WAVE of a large flare: a bright front spreading over the surface from the site, fading as it goes
    float wv = uARx[k].w;
    if (wv >= 0.0) {
      float angd = acos(clamp(cd, -1.0, 1.0)), front = 0.10 + 1.15 * wv;
      add += s * 0.55 * (1.0 - wv) * (1.0 - wv) * exp(-pow((angd - front) / (0.035 + 0.05 * wv), 2.0)) * (0.6 + 0.8 * vn3(n * 14.0 + seed));
    }
    float et = uARe[k].x;
    float bend = 0.42 * sin(u.y * 1.15 + seed * 40.0), dx = u.x - bend;
    float along = smoothstep(3.0, 2.1, abs(u.y));
    dark = max(dark, s * edgeK * uARe[k].z * 0.72 * exp(-dx * dx / 0.035) * along);
    dark = max(dark, min(1.0, s * 1.6) * edgeK * spot * (1.0 - 0.6 * min(1.0, fl)));      // (a big flare's glare washes over the spots)
    if (et >= 0.0) {
      float failing = uARe[k].y;
      float wake = smoothstep(0.0, 0.10, et) * (1.0 - smoothstep(0.16, 0.34, et));          // the thread lights up as it goes
      float glow = wake * exp(-dx * dx / 0.06) * along;
      float on = smoothstep(0.14, 0.30, et) * (1.0 - smoothstep(0.72, 1.0, et)) * (1.0 - 0.75 * failing);
      float w = 0.22 + 1.05 * smoothstep(0.14, 0.95, et);                                  // the ribbons part
      float span = smoothstep(0.35 + 2.4 * smoothstep(0.14, 0.55, et), 0.0, abs(u.y) - 0.2);
      float rib = exp(-(dx - w) * (dx - w) / 0.03) + exp(-(dx + w) * (dx + w) / 0.03);
      float arch = pow(0.5 + 0.5 * cos(u.y * 8.0 + seed * 90.0), 3.0) * sqrt(max(0.0, 1.0 - (dx * dx) / (w * w)));
      float site = on * span * (0.9 * rib + 0.75 * arch);
      add += s * edgeK * (1.1 * glow + 1.2 * site);
      hot += s * edgeK * (0.8 * glow + 1.0 * site);
      float dim = smoothstep(0.18, 0.36, et) * (1.0 - smoothstep(0.7, 1.0, et)) * (1.0 - failing);
      // the DIMMING starts at the rope's two footpoints and spreads (that is where the corona was emptied FROM): twin
      // patches growing outward, not one blot fading in over the whole site
      float grow2 = 1.5 + 16.0 * smoothstep(0.18, 0.7, et);
      float twin = max(exp(-dot(u - vec2(0.0, 2.2), u - vec2(0.0, 2.2)) / grow2), exp(-dot(u + vec2(0.0, 2.2), u + vec2(0.0, 2.2)) / grow2));
      dark = max(dark, s * edgeK * 0.62 * dim * twin * (1.0 - min(1.0, site + glow)));
    }
  }
  return vec3(add, hot, dark);
}

// THE QUIET PROMINENCES: x the red light they give against the sky, y how much of the disk's light they take where
// they hang in front of it (a filament). The spine is a low 3D arch between the two feet; the picture of that arch is
// an ellipse in the screen, so a pixel's place UNDER the spine is two numbers -- how far along (al) and how far up
// (be) -- from one 2x2 solve, and the curtain is drawn in those: fine threads hanging down, denser toward the feet
// and the spine, ragged along its top.
vec2 prominences(vec2 p, float zs) {
  float emit = 0.0, absorb = 0.0;
  for (int k = 0; k < ${SUN_PROMINENCES}; k++) {
    float s = uPrB[k].w;
    if (s <= 0.002) continue;
    vec3 A = uPrA[k].xyz, B = uPrB[k].xyz;
    vec3 mid = 0.5 * (A + B);
    if (mid.z < -0.35) continue;
    vec3 S = A - mid; float R = length(S);
    vec2 dc = p - mid.xy;
    if (dot(dc, dc) > (R + 0.2) * (R + 0.2)) continue;
    vec3 sh = S / max(R, 1e-5), up = normalize(mid), W = normalize(cross(sh, up));
    float seed = uPrC[k].y, inc = uPrC[k].x + 0.06 * sin(uBoil * 1.3 + seed * 30.0);      // it leans, and sways slowly
    vec3 uh = normalize(up * cos(inc) + W * sin(inc));
    float Hh = uPrA[k].w + (1.0 - length(mid));                                          // the spine's height over the chord's middle
    vec2 cx = R * sh.xy, cy = Hh * uh.xy;
    float det = cx.x * cy.y - cx.y * cy.x;
    if (abs(det) < 1e-6) continue;                                                       // seen exactly along its length
    float al = (dc.x * cy.y - dc.y * cy.x) / det, be = (cx.x * dc.y - cx.y * dc.x) / det;
    if (abs(al) > 1.0 || be < -0.05) continue;
    float top = sqrt(max(0.0, 1.0 - al * al));                                           // the spine, at this place along it
    float ragged = top * (0.72 + 0.45 * vn3(vec3(al * 9.0 + seed * 20.0, uBoil * 0.5, seed * 7.0)));
    if (be > ragged + 0.08) continue;
    float body = (1.0 - smoothstep(ragged - 0.10, ragged + 0.06, be)) * smoothstep(-0.05, 0.04, be);
    // threads: fine, near-vertical, drifting slowly downward (the plasma drains)
    float fineT = smoothstep(2.5, 8.0, uDisk.z * R / 60.0);
    float thr = 0.45 + 0.75 * vn3(vec3(al * 26.0 + seed * 50.0, be * 2.2 + uBoil * 0.9, seed * 3.0));
    thr *= mix(1.0, 0.5 + 0.9 * vn3(vec3(al * 90.0, be * 5.0 + uBoil * 1.6, seed * 11.0)), fineT);
    float spine = exp(-pow((be - ragged * 0.92) / 0.10, 2.0));
    float dens = body * thr * (0.55 + 0.6 * spine + 0.35 * abs(al)) * s;
    // where is this bit of curtain in depth? on the chord's plane, lifted: good enough to ask if the sun hides it
    vec3 Pw = mid + al * R * sh + be * Hh * uh;
    if (zs >= 0.0) {
      float front = smoothstep(zs - 0.05, zs + 0.01, Pw.z);                              // (softly: a hard test drew a sawtooth along the limb)
      absorb = max(absorb, 0.52 * min(1.0, dens * 1.3) * front);                         // in front of the disk: a dark filament (0.78, close to the limb on a wall-sized panel, was a heavy black tree)
      emit += 0.10 * dens * front;                                                       // (it glows a little there too)
    } else emit += dens;
  }
  return vec2(emit, absorb);
}

// THE LOOPS, IN THREE DIMENSIONS (operator, 2026-09-22: "do the entire list. Make this sun ... beautiful. Equal to NASA
// footage at least"; item one of the list). Two flat constructions came before this -- the dipole's circles ("What is
// that looping shit supposed to be? ... really flat and strange"), then a leaning arcade with curved fans -- and both
// were marks on a surface. A coronal loop is an ARCH OF PLASMA STANDING IN SPACE, and nearly everything that makes
// SDO's pictures beautiful follows from that: it foreshortens as its region turns, arches cross in front of one
// another, the sun hides the ones behind it, and on the limb they stand up against the dark.
//   Each loop is half an ELLIPSE in a plane of its own: through its two footpoints, leaning off the vertical by its
//   own amount. The view is parallel, so for a pixel the ray meets that plane at ONE point, and how far that point
//   is from the ellipse is closed-form -- no marching, no segments: a few dozen operations a loop. The distance is
//   turned into a distance ON SCREEN by the gradient of the same expression, so a loop is the same few pixels wide
//   however its plane is turned.
//   Two kinds, as in the films: the ARCADE, short arches from the leading polarity to the following one, side by
//   side along the inversion line, brightest at their feet; and the long ones, from one polarity out to weak field
//   far away, which are what read as FANS -- bright at the root and fading along their length.
//   p: the pixel, in radii, y up. zs: the sphere's own z there (its front surface), or -1 off the disk.
vec2 loops3d(vec2 p, float zs) {
  float sum = 0.0, rain = 0.0;
  for (int k = 0; k < ${SUN_REGIONS}; k++) {
    float s = uARp[k].y;
    if (s <= 0.001) continue;
    vec3 cs = uARs[k].xyz;
    if (cs.z < -0.5) continue;                                  // well round the back
    float a = uARd[k].w;
    vec2 dc = p - cs.xy;
    if (dot(dc, dc) > a * a * 300.0) continue;                   // nowhere near this region (120 CUT its longest, tallest loops: a faint curved seam)
    float fl = uARp[k].z;
    // CORONAL RAIN (item four): plasma in a loop cools, condenses, and FALLS -- knots sliding down both legs from
    // near the top, faster as they go, the whole way to the surface. There is always a little; after a flare or an
    // eruption there is a lot (that is when the loops are full of hot plasma with nowhere to go but down).
    float et = uARe[k].x;
    float wet = 0.22 + 0.9 * min(1.0, fl) + (et > 0.3 ? 0.8 * (1.0 - smoothstep(0.8, 1.0, et)) : 0.0);
    for (int j = 0; j < ${SUN_LOOPS}; j++) {
      // (the loop's geometry comes from a small float texture, worked out ONCE A FRAME on the CPU -- sunLoops(). Built
      // here it was two hashes, five normalisations and a cross product for every loop of every pixel near a region:
      // more than half the frame.)
      int row = k * ${SUN_LOOPS} + j;
      vec4 t0 = texelFetch(uLoops, ivec2(0, row), 0);             // the middle of the chord, and the arch's bounding radius
      vec2 c0 = t0.xyz.xy - p;
      if (dot(c0, c0) > (t0.w + 0.02) * (t0.w + 0.02)) continue;  // this pixel is nowhere near this arch
      vec4 t1 = texelFetch(uLoops, ivec2(1, row), 0), t2 = texelFetch(uLoops, ivec2(2, row), 0), t3 = texelFetch(uLoops, ivec2(3, row), 0);
      vec3 mid = t0.xyz, Rsh = t1.xyz, eRuh = t2.xyz;             // X(t) = mid + cos t * Rsh + sin t * eRuh
      float bright = t1.w; bool far = t2.w > 0.5;
      vec3 ha = vec3(t3.x, 0.0, t3.y), hb = vec3(t3.z, 0.0, t3.w);
      // THE NEAREST POINT OF THE ARCH, ON SCREEN. The arch is X(t) = mid + R cos t * sh + e R sin t * uh, t in 0..pi,
      // and the view is parallel, so its picture is the same expression in x and y alone: half an ellipse in the
      // plane of the screen, whatever way the loop faces. (The first cut met the view ray with the loop's PLANE,
      // which is closed-form and has no answer when that plane is edge-on -- and an upright loop seen from straight
      // above, the commonest loop on the disk, is exactly edge-on. They came out as blunt half-arcs and white
      // dashes.) Five samples pick the stretch, three Newton steps on (X - p) . X' = 0 find the foot of the
      // perpendicular; the same t gives the point's depth, for the sun to hide it by.
      vec2 cx = Rsh.xy, cy = eRuh.xy;
      float best = 1e9, th = 1.5708;
      for (int q = 0; q < 5; q++) {
        float t0 = 0.3142 + 0.6283 * float(q);
        vec2 dq = c0 + cos(t0) * cx + sin(t0) * cy;
        float dd = dot(dq, dq);
        if (dd < best) { best = dd; th = t0; }
      }
      for (int q = 0; q < 4; q++) {
        float ct2 = cos(th), st2 = sin(th);
        vec2 X = c0 + ct2 * cx + st2 * cy, X1 = -st2 * cx + ct2 * cy, X2 = -ct2 * cx - st2 * cy;
        float f1 = dot(X1, X1) + dot(X, X2);
        th = clamp(th - clamp(dot(X, X1) / (f1 > 1e-6 ? f1 : dot(X1, X1) + 1e-6), -0.35, 0.35), 0.0, 3.14159265);   // (a bounded step: unbounded, it overshot near an apex and left a notch in the arch)
      }
      float cth = cos(th), sth = sin(th);
      vec2 dv2 = c0 + cth * cx + sth * cy;
      float d = length(dv2);                                     // how far from the loop, ON SCREEN, in radii
      float w = a * 0.024 + 1.1 / uDisk.z;
      if (d > w * 3.2) continue;
      vec3 Pw = mid + cth * Rsh + sth * eRuh;
      float z = Pw.z;                                              // that point's depth
      // hidden by the sun: inside it, or behind its front surface -- SOFTLY (a hard test cut each loop off in a
      // staircase of white pixels where it met the limb)
      float vis = smoothstep(0.965, 0.992, dot(Pw, Pw));          // (down to the surface: stopping short left every loop hanging in the air)
      if (zs >= 0.0) vis *= smoothstep(-0.03, 0.01, z - zs);
      if (vis <= 0.0) continue;
      float edgeOn = 1.0;
      float along = far ? exp(-th * 1.25) * (1.0 - smoothstep(2.3, 3.1, th)) : 0.30 + 0.70 * pow(abs(cos(th)), 1.6);
      float x = d / w;
      float thread = exp(-x * x) * (0.6 + 0.4 * cos(x * 4.2 + ha.x * 6.2831853));           // a bundle of threads, not a wire
      sum += s * (1.0 + 1.1 * fl) * bright * along * thread * vis * edgeOn * 1.7;
      if (!far) {
        float leg = abs(th - 1.5708) / 1.5708;                       // 0 at the top, 1 at a foot
        // (operator, 2026-09-22: "The rain effects still look too much like dots appearing out of nowhere". They were:
        // a tight knot switched on at full brightness at the top of a leg. Rain CONDENSES -- it comes up slowly out of
        // the loop's own light near the top, then falls, stretching into a streak as it gathers speed, and goes out
        // into the footpoint. Each fall has its own size, fixed for that fall, so nothing changes mid-air.)
        for (int m = 0; m < 2; m++) {
          float clock = uBoil * (0.55 + 0.45 * hb.x) + ha.z * 7.0 + float(m) * 0.53 + (th < 1.5708 ? 0.0 : 0.41);
          float ph = fract(clock), fall = floor(clock);
          float size = fract(sin(fall * 12.9898 + ha.x * 78.233 + float(m) * 3.1) * 43758.5453);   // this fall's own weight
          float at = 0.06 + 0.94 * ph * ph * (3.0 - 2.0 * ph) * ph;   // it hangs near the top, then goes
          float speed = ph * ph;
          float tail = 0.05 + 0.34 * speed, nose = 0.035 + 0.03 * speed;
          float shape = exp(-pow((leg - at) / (leg < at ? tail : nose), 2.0));
          float life = smoothstep(0.0, 0.30, ph) * (1.0 - smoothstep(0.80, 1.0, ph));       // condenses; goes out at the foot
          float knot = shape * life * size * size * 1.6;
          rain += s * wet * knot * exp(-x * x * 1.6) * vis * (0.5 + 0.5 * hb.z);
        }
      }
    }
  }
  return vec2(sum, rain);
}

// WHAT LEAVES: the erupting material, in the picture's own frame (p in radii, y up), drawn on the disk and off it.
// xyz: light to add (the front and the haze in the corona's gold, the core in the prominences' red going white-hot);
// w: how much of what is behind to take away (the cavity). It grows as it goes and fades over a long way.
vec4 ejecta(vec2 p, float r) {
  vec3 light = vec3(0.0); float cavity = 0.0;
  for (int k = 0; k < ${SUN_REGIONS}; k++) {
    float et = uARe[k].x, s = uARp[k].y;
    if (et < 0.0 || s <= 0.001) continue;
    vec3 cs = uARs[k].xyz;
    if (cs.z < -0.3) continue;                                  // well round the back: the sun is in the way
    float h = uARe[k].w, failing = uARe[k].y, seed = fract(uARp[k].w);
    vec2 pe = cs.xy * (1.0 + h);
    // behind the limb and in front of the disk: hidden by it
    float seen = cs.z < 0.0 ? smoothstep(0.98, 1.03, r) : 1.0;
    // IT GROWS (operator, 2026-09-22: "The red flares sorta appear out of nowhere... they need to grow"). The arch was
    // drawn at full size and full brightness from the first instant it had any height -- ninety pixels of red, switched
    // on. It comes up out of the filament now: from nothing, swelling and brightening through the whole slow rise; and
    // a failed one goes back down the same way, to nothing, as its height does.
    float born = smoothstep(0.0, 0.22, et) * smoothstep(0.0, 0.05, h);
    float fade = (1.0 - smoothstep(1.2, ${F(SUN_ERUPTION.REACH)}, h)) * seen * s * born;
    if (fade <= 0.001) continue;
    float Rb = 0.05 * born + 0.46 * h;
    vec2 dv = p - pe; float d = length(dv);
    vec2 out2 = length(cs.xy) > 0.05 ? normalize(cs.xy) : vec2(0.0, 1.0);
    float facing = length(cs.xy) > 0.05 ? smoothstep(-0.45, 0.55, dot(dv / max(d, 1e-4), out2)) : 1.0;   // a front leads; seen face-on it is a halo
    float rag = vn3(vec3(dv / Rb * 2.2, seed * 50.0 + uBoil * 0.4));
    float fw = 0.02 * born + 0.06 * h + 1e-4;                                            // a thin ragged shell, not a smoke ring
    float front = exp(-pow((d - Rb * (0.80 + 0.45 * rag)) / fw, 2.0)) * (0.45 + 0.9 * vn3(vec3(dv / Rb * 5.0, seed * 3.0))) * facing * (1.0 - failing);
    float haze = exp(-d * d / (Rb * Rb * 0.9)) * 0.10 * (1.0 - failing);
    // THE CORE IS AN ARCH OF PLASMA, NOT A PATTERN (the first cut striped a blob with a sine and drew sergeant's
    // chevrons). In the films the erupting filament is a ROPE: an arch whose apex leads and whose two legs trail back
    // toward the footpoints it tore from -- fibrous along its length, ragged, thinning as it stretches. So: the
    // distance from this pixel to a parabola (apex at the ejecta's centre, legs swept back toward the sun), a
    // gaussian across that distance for the rope's thickness, and the fibres as noise stretched ALONG the rope.
    vec2 q = vec2(dot(dv, out2), dot(dv, vec2(-out2.y, out2.x)));          // x: the way it is going; y: across
    // IT WRITHES (item six): a flux rope carries twist, and as it erupts the twist turns into WRITHE -- the arch's
    // axis itself rotates, by a good part of a right angle, always the way its twist was wound (the sign is the
    // region's own). Measured in the films' events: two to three turns of twist before eruption (the kink threshold
    // is about one and a quarter), and the apex visibly rotating as it rises.
    float writhe = (seed < 0.5 ? -1.0 : 1.0) * 1.05 * smoothstep(0.10, 0.62, et) * (1.0 - 0.5 * failing);
    q = vec2(cos(writhe) * q.x - sin(writhe) * q.y, sin(writhe) * q.x + cos(writhe) * q.y);
    // (seen from the side -- at the limb -- the legs trail a long way back; seen FACE-ON, from above, they are
    // foreshortened to nothing: the first cut drew a region at disk centre a thin red parabola right across the sun)
    float side = clamp(length(cs.xy), 0.12, 1.0);
    float Wd = 0.05 * born + 0.24 * h + 1e-4, Hh = (0.04 * born + 0.95 * h) * side;             // the arch's half-width, and how far back its legs reach
    float yy = clamp(q.y / Wd, -1.0, 1.0);
    float ropeX = -Hh * yy * yy;                                           // the parabola: apex at 0, legs trailing sunward
    float dr = length(vec2(q.x - ropeX, (q.y - yy * Wd) * 1.6));           // (past the legs' ends the rope stops)
    float th = (0.030 * born + 0.075 * h + 1e-4) * (1.0 + 0.7 * abs(yy)) * (0.75 + 0.5 * vn3(vec3(yy * 4.0 + seed * 11.0, h * 2.0, 4.4)));   // ragged, and thicker toward the legs, where the material is
    float fibre = vn3(vec3(yy * 3.0 + seed * 20.0, (q.x - ropeX) / th * 0.9, uBoil * 0.8 + seed * 7.0));
    float fine = vn3(vec3(yy * 11.0, (q.x - ropeX) / th * 2.4 + 3.0, seed * 13.0));
    float torn = smoothstep(0.15, 0.75, vn3(vec3(yy * 2.2 + seed * 5.0, h * 3.0, 1.7)) + 0.55 * (1.0 - h));   // it comes apart as it goes
    // ...the twist itself, as bright strands wound round the rope; and material DRAINING back down both legs -- knots
    // running sunward, which on a failed eruption is most of what there is to see
    float wound = 0.75 + 0.5 * cos(yy * 14.0 + (q.x - ropeX) / th * 2.6 + seed * 9.0);
    float drain = 0.6 + 0.9 * pow(0.5 + 0.5 * sin(abs(yy) * 11.0 + uBoil * 9.0 + seed * 5.0), 3.0) * smoothstep(0.15, 0.6, abs(yy));
    float core = exp(-dr * dr / (th * th)) * (0.35 + 1.1 * fibre * (0.5 + fine)) * wound * drain * torn * (failing > 0.5 ? 1.2 : 1.0);
    float heat = clamp(1.0 - h * 1.4, 0.0, 1.0);
    // (a front is thin plasma seen by its own faint light: against the DARK SKY it shows, against the bright disk it
    // does not -- a face-on eruption drew its front across the disk as a bright yellow worm)
    float sky = smoothstep(0.96, 1.04, r);
    light += fade * (gold(0.78) * (0.85 * front + haze) * (0.10 + 0.90 * sky) + mix(vec3(0.95, 0.20, 0.04), vec3(1.0, 0.86, 0.55), heat * heat) * 1.15 * core);
    cavity = max(cavity, fade * 0.55 * (0.25 + 0.75 * sky) * (1.0 - failing) * smoothstep(Rb * 0.95, Rb * 0.45, d) * (1.0 - min(1.0, core)));
  }
  return vec4(light, cavity);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uPanel.y - gl_FragCoord.y);
  vec2 p = (frag - uDisk.xy) / uDisk.z;                     // in radii, y down the screen
  p.y = -p.y;
  float r = length(p);
  vec3 col = vec3(0.0);
  // SPACE: sparse stars (the sun is the foreground) -- hidden near the disk by its own glare
  float star = h1(frag);
  if (star > 1.0 - ${F(C.STARS)}) col += vec3(0.75, 0.80, 0.95) * (0.25 + 0.75 * h1(frag + 91.0)) * smoothstep(1.3, 2.4, r);
  if (r < 1.0) {
    float z = sqrt(1.0 - r * r);                           // toward the viewer: also mu, the cosine from the disk's centre
    vec3 n = vec3(p, z);
    // into the sun's own frame: undo the roll in the picture, then the tip toward the viewer
    float cr = cos(${F(SUN_ROLL)}), sr = sin(${F(SUN_ROLL)});
    n = vec3(cr * n.x + sr * n.y, -sr * n.x + cr * n.y, n.z);
    float ct = cos(${F(SUN_TILT)}), st = sin(${F(SUN_TILT)});
    n = vec3(n.x, ct * n.y - st * n.z, st * n.y + ct * n.z);
    float px = uDisk.z * max(z, 0.25);                     // pixels to a radius, foreshortened toward the limb
    vec2 sA = surface(n, uShearA, px, true), sB = surface(n, uShearB, px, false);
    float v = sA.x * uShearA.y + sB.x * uShearB.y + sA.y;
    float limb = 1.0 - ${F(SUN_LIMB_U)} * (1.0 - z);         // I(mu) = 1 - u (1 - mu)
    // the active regions ride OVER the surface: hot thin plasma, which the limb law does not dim -- seen edge-on
    // there is more of it in the line of sight, so it brightens toward the limb instead
    vec3 ar = regions(n);
    // (the regions' light is COMPRESSED, not clipped: added straight, a flaring region at full-screen size was a flat
    // white blob with nothing in it; an exponential shoulder keeps the loops and the surface readable inside the glare)
    float arx = 0.92 * (1.0 - exp(-1.15 * ar.x * (1.0 + 0.5 * (1.0 - z))));
    float t = (v * limb + 0.06) * (1.0 - ar.z) * (1.0 - 0.45 * arx) + arx;
    t += 0.35 * arx * (v - 0.3);                                        // the surface's own texture shows through the glow
    col = mix(gold(t), vec3(1.0, 1.0, 0.96), clamp(1.0 - exp(-0.9 * ar.y), 0.0, 0.85));
    // the thin hot atmosphere seen edge-on: optically thin, so it BRIGHTENS toward the limb (the 171 channel's rim)
    col += gold(0.80) * 0.42 * pow(1.0 - z, 3.0);
    float edge = smoothstep(1.0, 1.0 - 1.5 / uDisk.z, r);   // one pixel of antialiasing at the limb
    col *= edge;
  }
  // THE ATMOSPHERE OFF THE LIMB: a thin bright shell, then a faint glow falling away (milestone 2 gives it structure)
  if (r >= 1.0 - 1.5 / uDisk.z) {
    float h = max(r - 1.0, 0.0);
    // the direction of this bit of sky from the sun's centre, in the sun's frame (the limb plane: z = 0)
    vec3 nl = vec3(p / max(r, 1e-4), 0.0);
    float cr2 = cos(${F(SUN_ROLL)}), sr2 = sin(${F(SUN_ROLL)});
    nl = vec3(cr2 * nl.x + sr2 * nl.y, -sr2 * nl.x + cr2 * nl.y, 0.0);
    float ct2 = cos(${F(SUN_TILT)}), st2 = sin(${F(SUN_TILT)});
    nl = vec3(nl.x, ct2 * nl.y, st2 * nl.y);
    // STREAMERS: the corona is not a smooth halo but rays and stalks -- brighter and longer over some position angles
    // THE CORONA HAS ARCHITECTURE (item seven), not just rays:
    //   HELMET STREAMERS over the activity belts -- a broad bright bulb over closed field, drawn up into a narrow STALK
    //     where the wind pulls it open. One noise field does both: the threshold it must pass RISES with height, so
    //     what is broad at the limb thins to a stalk further out, by itself;
    //   POLAR PLUMES over the poles' coronal holes: fine, straight, faint rays, fanning a little outward;
    //   and the WIND: brightness blobs carried outward along all of it, never still.
    float ray = fbm3(nl * 3.1 + vec3(uBoil * 0.15, 3.0, 0.0), 40.0);
    float fine = fbm3(nl * 17.0 + vec3(0.0, uBoil * 0.3, 9.0), 40.0);
    float belt = 1.0 - smoothstep(0.35, 0.75, abs(nl.y));                     // low latitudes, where the streamers live
    float helmet = smoothstep(0.44 + 0.22 * min(h, 1.4), 0.62 + 0.20 * min(h, 1.4), fbm3(nl * 1.9 + vec3(0.0, 7.0, uBoil * 0.05), 40.0)) * belt;
    float pole = smoothstep(0.72, 0.93, abs(nl.y));
    float plume = pole * pow(vn3(nl * vec3(46.0, 6.0, 46.0) + vec3(uBoil * 0.2, 0.0, 0.0)), 2.0);
    float wind = 0.75 + 0.5 * vn3(vec3(nl.xy * 9.0, h * 4.0 - uBoil * 2.2));  // moving OUT
    float reach = ${F(C.CORONA - 1)} * (0.35 + 1.5 * ray * ray) * (1.0 + 1.9 * helmet + 0.55 * plume);
    float shell = exp(-h / ${F(C.ATMOSPHERE)});
    float glow = pow(max(0.0, 1.0 - h / reach), 2.6) * (0.55 + 0.9 * fine) * (1.0 + 0.9 * helmet + 0.35 * plume) * wind;      // (plumes are FAINT: at 0.7 they outshone the streamers)
    // where an active region sits on the limb its loops stand off it: the regions, evaluated on the limb plane, lifted
    vec3 arl = regions(nl);
    float tuft = 0.45 * arl.x * exp(-h / 0.07);             // (the glow at a limb region's root; its LOOPS are loops3d's)
    vec3 air = gold(0.82) * 0.60 * shell + gold(0.55) * 0.30 * glow + gold(0.62 + 0.3 * clamp(arl.y, 0.0, 1.0)) * 0.9 * tuft;
    col += air * smoothstep(1.0 - 1.5 / uDisk.z, 1.0, r);
  }
  // the quiet prominences: red against the sky, dark against the disk
  { vec2 pm = prominences(p, r < 1.0 ? sqrt(1.0 - r * r) : -1.0);
    col *= 1.0 - pm.y;
    float e2 = 1.0 - exp(-1.6 * pm.x);
    col += mix(vec3(0.85, 0.10, 0.02), vec3(1.0, 0.55, 0.22), e2) * e2; }
  // the loops, standing off the sphere: over the disk and against the sky alike
  { vec2 L = loops3d(p, r < 1.0 ? sqrt(1.0 - r * r) : -1.0);
    float l = 1.0 - exp(-1.25 * L.x);
    col = col * (1.0 - 0.30 * l) + gold(0.66 + 0.30 * l) * l;
    float rn = 1.0 - exp(-2.2 * L.y);
    col += vec3(1.0, 0.80, 0.52) * rn; }                              // the rain: cooler than the loop it falls through, and bright
  // THE FLARE ITSELF (item five), in the picture's frame: a white-cyan flash at the loops' tops, where the field
  // reconnects (131 angstrom's teal: the ten-million-degree plasma); and on a LARGE flare the telescope's own
  // diffraction cross -- SDO's entrance filters sit on a fine wire mesh, and a bright enough point throws two crossed
  // lines of light at about forty and fifty degrees. It is an artefact, and it is in every famous flare picture.
  for (int k = 0; k < ${SUN_REGIONS}; k++) {
    float fl = uARp[k].z * uARp[k].y;
    if (fl < 0.05) continue;
    vec3 cs = uARs[k].xyz;
    if (cs.z < -0.15) continue;
    float a = uARd[k].w;
    vec2 tip = cs.xy * (1.0 + 0.75 * a) - p;                          // the loops' tops, lifted off the surface
    float seenK = cs.z < 0.0 ? smoothstep(0.98, 1.03, r) : 1.0;
    float flash = exp(-dot(tip, tip) / (a * a * 0.22)) * min(1.6, fl) * seenK;
    col = mix(col, vec3(0.80, 1.0, 1.0), clamp(0.85 * flash, 0.0, 0.9));
    float big = smoothstep(0.75, 1.3, fl) * seenK;
    if (big > 0.0) {
      vec2 dq = cs.xy - p;
      for (int m = 0; m < 2; m++) {
        float an = m == 0 ? 0.70 : 2.27;                              // ~40 and ~130 degrees
        vec2 ax = vec2(cos(an), sin(an));
        float along2 = abs(dot(dq, ax)), across = abs(dot(dq, vec2(-ax.y, ax.x)));
        float spike = exp(-across * uDisk.z / 1.6) * exp(-along2 / (0.9 * a + 0.35)) * (0.7 + 0.3 * sin(along2 * uDisk.z * 0.55));
        col += vec3(0.95, 1.0, 1.0) * 0.55 * big * spike;
      }
    }
  }
  // the eruptions, over everything: the cavity takes light away, the front and the core add it
  vec4 ej = ejecta(p, r);
  col = col * (1.0 - ej.w) + ej.xyz;
  // a gentle contrast curve, as SDO's own processed frames have: the darks a little darker, the lights held
  { vec3 c1 = clamp(col, 0.0, 1.0); col = mix(col, c1 * c1 * (3.0 - 2.0 * c1), 0.30); }
  col *= uBright;
  // a little ordered noise under one 8-bit step: the glow is a long faint gradient and would band
  col += (h1(frag + 7.0) - 0.5) / 255.0;
  o = vec4(max(col, 0.0), 1.0);
}`;

/**
 * Attach the layer to `canvas`. Answers a controller, or null where WebGL2 or the shader cannot be had (the caller
 * falls back to drawSunSky) -- never throws.
 *   opts.onCompileError(log)   the shader log (a shader that will not compile falls back SILENTLY otherwise)
 *   opts.onLost()              the context died
 *   opts.preserve              keep the drawing buffer (a test page reading pixels back)
 *   opts.allowSoftware         run even on a software rasteriser (a preview script)
 */
export function sunGlAttach(canvas, opts = {}) {
  let gl = null;
  try { gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: opts.preserve === true }); } catch { gl = null; }
  if (!gl) return null;
  if (!opts.allowSoftware) {
    let name = '';
    try { const e = gl.getExtension('WEBGL_debug_renderer_info'); name = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { name = ''; }
    if (isSoftwareGl(name)) { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* nothing to give back */ } return null; }
  }
  let prog = null;
  try {
    const make = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, make(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
  } catch (e) {
    const log = `the Sun sky's shader: ${e.message}`;
    try { globalThis.__blockyardGlErrors?.push(log); console.warn?.(`[blockyard] WebGL: ${log}`); } catch { /* no console */ }
    if (opts.onCompileError) opts.onCompileError(e.message);
    return null;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  const un = {};
  for (const n of ['uPanel', 'uDisk', 'uSpin', 'uShearA', 'uShearB', 'uBoil', 'uBright', 'uCycle']) un[n] = gl.getUniformLocation(prog, n);
  const uARd = gl.getUniformLocation(prog, 'uARd[0]'), uARp = gl.getUniformLocation(prog, 'uARp[0]'), uARe = gl.getUniformLocation(prog, 'uARe[0]'), uARs = gl.getUniformLocation(prog, 'uARs[0]'), uARx = gl.getUniformLocation(prog, 'uARx[0]'), uARy = gl.getUniformLocation(prog, 'uARy[0]');
  const uPrA = gl.getUniformLocation(prog, 'uPrA[0]'), uPrB = gl.getUniformLocation(prog, 'uPrB[0]'), uPrC = gl.getUniformLocation(prog, 'uPrC[0]');
  const pra = new Float32Array(SUN_PROMINENCES * 4), prb = new Float32Array(SUN_PROMINENCES * 4), prc = new Float32Array(SUN_PROMINENCES * 4);
  const ard = new Float32Array(SUN_REGIONS * 4), arp = new Float32Array(SUN_REGIONS * 4), are = new Float32Array(SUN_REGIONS * 4), ars = new Float32Array(SUN_REGIONS * 4), arx = new Float32Array(SUN_REGIONS * 4), ary = new Float32Array(SUN_REGIONS * 4);
  const uRampLoc = gl.getUniformLocation(prog, 'uRamp[0]');
  const ramps = Object.fromEntries(Object.entries(SUN_CHANNELS).map(([id, r]) => [id, new Float32Array(r.flatMap(([t, c]) => [t, c[0], c[1], c[2]]))]));
  const st = { dead: false, at: null, turn: 0 };
  // the loops' float texture: 4 texels wide, one row a loop (RGBA32F is sampled with texelFetch: no filtering, no extension)
  const loopTex = gl.createTexture(), loopData = new Float32Array(SUN_REGIONS * SUN_LOOPS * 16);
  gl.bindTexture(gl.TEXTURE_2D, loopTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, SUN_REGIONS * SUN_LOOPS, 0, gl.RGBA, gl.FLOAT, loopData);
  const uLoopsLoc = gl.getUniformLocation(prog, 'uLoops');
  canvas.addEventListener?.('webglcontextlost', (e) => { e.preventDefault?.(); st.dead = true; opts.onLost?.(); });
  return {
    /** One frame. pw/ph in CSS pixels, dpr the device ratio, now the sky's clock (ms). */
    draw(pw, ph, dpr, now, o = {}) {
      if (st.dead) return false;
      let W = Math.max(1, Math.round(pw * dpr)), H = Math.max(1, Math.round(ph * dpr));
      const k = Math.min(1, Math.sqrt((SUN_DETAIL[o.sunDetail] ?? SUN_DETAIL[SUN_DETAIL_DEFAULT]) / (W * H)));
      W = Math.max(1, Math.round(W * k)); H = Math.max(1, Math.round(H * k));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      const spin = Number.isFinite(o.sunSpin) ? Math.max(0, Math.min(SUN_SPIN_MAX, o.sunSpin)) : SUN_SPIN_DEFAULT;
      const bright = Number.isFinite(o.sunBrightness) ? Math.min(1.5, Math.max(0, o.sunBrightness)) : SUN_BRIGHTNESS_DEFAULT;
      // THE CLOCK IS INTEGRATED, NEVER now x speed (the Formation's lesson: that clock JUMPS when the slider moves).
      // A fresh layer starts at now x speed, so a first frame is a pure function of the clock.
      const nowS = now / 1000;
      if (st.at == null || nowS < st.at) st.turn = nowS * spin; else st.turn += (nowS - st.at) * spin;
      st.at = nowS;
      const ph0 = sunPhases(st.turn);
      const d = sunDisk(W, H, o.sunAt, o.sunSize);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(un.uPanel, W, H);
      gl.uniform3f(un.uDisk, d.cx, d.cy, d.r);
      gl.uniform1f(un.uSpin, ph0.spin);
      gl.uniform3f(un.uShearA, ph0.a[0], ph0.a[1], ph0.a[2]);
      gl.uniform3f(un.uShearB, ph0.b[0], ph0.b[1], ph0.b[2]);
      // (the boil runs on the WALL clock, a little, even at sunSpin 0: a sun that does not turn still boils)
      gl.uniform1f(un.uBoil, ((nowS * 0.25 + st.turn * 0.75) * C.BOIL) % 4096);   // (sunLoops sways on the same clock)
      gl.uniform1f(un.uBright, bright);
      gl.uniform4fv(uRampLoc, ramps[o.sunChannel] ?? ramps[SUN_CHANNEL_DEFAULT]);
      gl.uniform1f(un.uCycle, cyc(o.sunCycle));
      const act = o.sunActivity === false ? 0 : 1, erupt = act === 1 && o.sunEruptions !== false;
      const boil = ((nowS * 0.25 + st.turn * 0.75) * C.BOIL) % 4096;
      const regs = sunRegions(st.turn, nowS, o.sunCycle).map((g) => (act ? g : { ...g, strength: 0 }));
      sunLoops(regs, boil, loopData);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, loopTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, SUN_REGIONS * SUN_LOOPS, gl.RGBA, gl.FLOAT, loopData);
      gl.uniform1i(uLoopsLoc, 0);
      regs.forEach((g, k) => {
        ard.set([g.dir[0], g.dir[1], g.dir[2], g.size], k * 4);
        arp.set([g.tilt, g.strength * act, g.flare, g.loops + Math.min(0.999, g.seed)], k * 4);
        are.set([erupt ? g.phase : -1, g.fails ? 1 : 0, erupt ? g.filament : 0, erupt ? g.height : 0], k * 4);
        ars.set([g.screen[0], g.screen[1], g.screen[2], 0], k * 4);
        arx.set([...g.axisX, act ? g.wave : -1], k * 4); ary.set([...g.axisY, 0], k * 4);
      });
      const promOn = o.sunProminences === false ? 0 : 1;
      sunProminences(st.turn).forEach((g, k) => { pra.set([...g.a, g.height], k * 4); prb.set([...g.b, g.strength * promOn], k * 4); prc.set([g.lean, g.seed, 0, 0], k * 4); });
      gl.uniform4fv(uPrA, pra); gl.uniform4fv(uPrB, prb); gl.uniform4fv(uPrC, prc);
      gl.uniform4fv(uARd, ard); gl.uniform4fv(uARp, arp); gl.uniform4fv(uARe, are); gl.uniform4fv(uARs, ars); gl.uniform4fv(uARx, arx); gl.uniform4fv(uARy, ary);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },
    dispose() { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
  };
}

let SUPPORT = null;
/** Feature probe without keeping a context: true where the layer can be tried. */
export function sunGlSupported() {
  if (SUPPORT != null) return SUPPORT;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    SUPPORT = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { SUPPORT = false; }
  return SUPPORT;
}

/**
 * THE FALLBACK, where there is no graphics card: the same disk in the same gold, without the boiling cells -- a
 * limb-darkened ball (one radial gradient, its stops the limb law through the ramp), the bright rim, and the glow
 * off it. Plain fills only: no clip, no globalAlpha, no composite modes. `tools.drawStars` paints the star field
 * first when the caller hands one over.
 */
export function drawSunSky(ctx, pw, ph, dpr, now, opts = {}, tools = {}) {
  tools.drawStars?.({ ...opts, galaxy: false, galaxies: false, nebulae: false, dust: false });
  const bright = Number.isFinite(opts.sunBrightness) ? Math.min(1.5, Math.max(0, opts.sunBrightness)) : SUN_BRIGHTNESS_DEFAULT;
  const d = sunDisk(pw, ph, opts.sunAt, opts.sunSize);
  const sunRampC = (t) => sunRamp(t, opts.sunChannel);
  const css = (c, a) => `rgba(${Math.round(255 * Math.min(1, c[0] * bright))},${Math.round(255 * Math.min(1, c[1] * bright))},${Math.round(255 * Math.min(1, c[2] * bright))},${a})`;
  const grad = (r0, r1, stops) => {
    const g = typeof ctx.createRadialGradient === 'function' ? ctx.createRadialGradient(d.cx, d.cy, r0, d.cx, d.cy, r1) : null;
    if (!g || typeof g.addColorStop !== 'function') return stops[0][1];
    for (const [t, c] of stops) g.addColorStop(t, c);
    return g;
  };
  // the glow off the limb, then the disk over it
  const R = d.r * C.CORONA;
  ctx.fillStyle = grad(d.r * 0.98, R, [[0, css(sunRampC(0.8), 0.55)], [C.ATMOSPHERE * 2 / (C.CORONA - 1), css(sunRampC(0.6), 0.2)], [0.5, css(sunRampC(0.5), 0.06)], [1, css(sunRampC(0.5), 0)]]);
  ctx.beginPath(); ctx.arc(d.cx, d.cy, R, 0, Math.PI * 2); ctx.fill();
  const stops = [];
  for (let i = 0; i <= 10; i++) {
    const rr = i / 10, mu = Math.sqrt(Math.max(0, 1 - rr * rr));
    const c = sunRampC(0.34 * limbDarkening(mu) + 0.06), rim = sunRampC(0.80), k = 0.42 * Math.pow(1 - mu, 3);   // (as dark as the shader's quiet sun: at 0.66 the fallback was a bright yellow ball beside it)
    stops.push([rr, css([c[0] + rim[0] * k, c[1] + rim[1] * k, c[2] + rim[2] * k], 1)]);
  }
  ctx.fillStyle = grad(0, d.r, stops);
  ctx.beginPath(); ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2); ctx.fill();
  // the active regions, as soft glows where they are (the same sunRegions the shader draws: they turn with the sun and
  // flare) -- no loops, no eruptions: those are a fragment shader's
  if (opts.sunActivity === false) return;
  const spin = Number.isFinite(opts.sunSpin) ? Math.max(0, Math.min(SUN_SPIN_MAX, opts.sunSpin)) : SUN_SPIN_DEFAULT;
  for (const g of sunRegions((now / 1000) * spin, now / 1000, opts.sunCycle)) {
    if (!(g.strength > 0.05) || g.screen[2] < 0.12) continue;
    const x = d.cx + g.screen[0] * d.r, y = d.cy - g.screen[1] * d.r, rr = d.r * g.size * (2.6 + 1.2 * Math.min(1, g.flare)) * (0.45 + 0.55 * g.screen[2]);
    const a0 = Math.min(1, g.strength * (0.55 + 0.4 * Math.min(1, g.flare))).toFixed(3);
    const gg = typeof ctx.createRadialGradient === 'function' ? ctx.createRadialGradient(x, y, 0, x, y, rr) : null;
    if (!gg || typeof gg.addColorStop !== 'function') continue;
    gg.addColorStop(0, css(sunRampC(1), a0)); gg.addColorStop(0.35, css(sunRampC(0.85), (a0 * 0.5).toFixed(3))); gg.addColorStop(1, css(sunRampC(0.7), 0));
    ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
  }
}
