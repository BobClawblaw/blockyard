// THE LIVING SKY (operator, 2026-09-16: "suggest a new sky background type we can add to
// blockyard. I would like for it to be something realistic with blue skies, clouds, the sun,
// change of day, night with the moon coming out, just something fucking beautiful"; then "do it").
//
// A second sky type beside the star field: a real day, drawn from the machine's clock, over every
// board that has a sky. The sun climbs and sets, the dome goes through night, dawn, day and dusk
// by the sun's altitude, clouds drift lit from the sun's side, the moon rises at its real phase
// and the star field (the one details3d already draws) comes out as the sun goes down.
//
// It obeys the canvas rules the rest of the renderer lives by (test/viewer-canvas-rules.test.js):
// no gradients, no globalAlpha, no composite modes, no shadowBlur. The dome is ONE huge soft disc
// centred far below the horizon, so its rings become gently curved horizontal bands -- which is
// how a sky dome looks -- and it is cached on an offscreen canvas that is repainted only when the
// colours move. Clouds are clusters of soft discs, the way the supernova's gas is built. The sun
// and the moon are discs with halos. Rain is lines. Nothing here needs a dependency.
//
// `drawLivingSky` takes the two helpers it needs from details3d as arguments (softStops, and a
// drawStars bound to the canvas) rather than importing them, so the two files do not import each
// other. Everything else here is pure, and the tests hold the astronomy to known dates.

// ------------------------------------------------------------------- the clock
/**
 * The hour the sky is drawn at, 0..24, by the clock setting: 'real' (this machine's local time),
 * 'cycle' (a whole day every 24 minutes), 'fixed' (an hour to admire). The date is today's for
 * the moon's phase whatever the clock says.
 */
export function skyTime(opts = {}, nowMs = Date.now()) {
  const d = new Date(nowMs);
  const mode = opts.skyClock ?? 'real';
  let hour;
  if (mode === 'cycle') hour = ((nowMs / 60000) % 24 + 24) % 24;                  // a minute an hour
  else if (mode === 'fixed') hour = Math.max(0, Math.min(24, Number(opts.skyHour) || 0)) % 24;
  else hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d - start) / 86400000);
  return { hour, dayOfYear, date: d, mode };
}

// ------------------------------------------------------------------- the sun
const RAD = Math.PI / 180;
/**
 * Where the sun is: altitude in degrees and its progress across the sky, 0 at rising and 1 at
 * setting. With no latitude, a symmetric day from six to six that reaches 62° at noon. With one,
 * the standard formula: declination from the day of the year, the hour angle from the clock
 * (the machine's local hour is taken as solar time), altitude from both.
 */
export function sunPosition(hour, dayOfYear = 172, lat = null) {
  if (lat == null || !Number.isFinite(lat)) {
    const alt = 62 * Math.sin(((hour - 6) / 12) * Math.PI);
    return { alt, frac: (hour - 6) / 12, rise: 6, set: 18 };
  }
  const phi = Math.max(-89, Math.min(89, lat)) * RAD;
  const decl = 23.44 * RAD * Math.sin(((284 + dayOfYear) / 365) * Math.PI * 2);
  const H = (hour - 12) * 15 * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H)) / RAD;
  const c = -Math.tan(phi) * Math.tan(decl);
  const half = c <= -1 ? 12 : c >= 1 ? 0 : Math.acos(c) / RAD / 15;   // hours from noon to the horizon
  const rise = 12 - half, set = 12 + half;
  const frac = half > 0 ? (hour - rise) / (2 * half) : (hour - 12) / 12 + 0.5;
  return { alt, frac, rise, set };
}

/** The sun's place on a canvas: left to right over the day, up by altitude; below the bottom edge at night. */
export function sunScreen(sun, pw, ph, maxAlt = 62) {
  const x = pw * (0.06 + 0.88 * Math.max(-0.25, Math.min(1.25, sun.frac)));
  const k = Math.max(-0.6, Math.min(1, sun.alt / maxAlt));
  const y = ph - (0.10 + 0.80 * k) * ph;
  return { x, y };
}

// ------------------------------------------------------------------- the moon
const SYNODIC = 29.530588853;                              // days
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);             // a known new moon
/** The moon's phase for a date: 0 new, 0.5 full, 1 new again; the lit fraction; waxing or not. */
export function moonPhase(date = new Date()) {
  const days = (date.getTime() - NEW_MOON) / 86400000;
  const p = ((days / SYNODIC) % 1 + 1) % 1;
  return { p, lit: (1 - Math.cos(p * Math.PI * 2)) / 2, waxing: p < 0.5 };
}
/** The moon rides the sun's track a share of a day behind: opposite the sun when full, beside it when new. */
export function moonPosition(hour, phase, dayOfYear = 172, lat = null) {
  const h = ((hour - 24 * phase.p) % 24 + 24) % 24;
  return sunPosition(h, dayOfYear, lat);
}

// ------------------------------------------------------------------- the dome's colours
// keyframes by the sun's altitude: [alt, zenith, horizon, glow, glow strength]
export const KEYFRAMES = Object.freeze([
  [-90, [3, 5, 16], [8, 11, 28], [20, 24, 60], 0],
  [-18, [3, 5, 16], [8, 11, 28], [20, 24, 60], 0],
  [-12, [6, 9, 26], [16, 20, 48], [50, 40, 80], 0.15],
  [-6, [12, 20, 54], [56, 46, 84], [150, 80, 90], 0.45],
  [-3, [26, 46, 108], [150, 90, 90], [240, 130, 70], 0.8],
  [0, [52, 92, 168], [232, 140, 84], [255, 160, 70], 1],
  [4, [82, 132, 206], [246, 186, 128], [255, 200, 120], 0.7],
  [12, [66, 134, 224], [196, 220, 242], [255, 235, 200], 0.25],
  [30, [44, 112, 222], [200, 224, 244], [255, 250, 235], 0.08],
  [90, [30, 92, 210], [206, 228, 246], [255, 255, 245], 0],
]);
const lerp = (a, b, k) => a + (b - a) * k;
const mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const rgb = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

/** The dome's colours at a sun altitude: zenith, horizon, the glow at the sun's side, and how strong. */
export function skyColours(alt) {
  const a = Math.max(-90, Math.min(90, alt));
  let i = 0;
  while (i < KEYFRAMES.length - 2 && KEYFRAMES[i + 1][0] <= a) i++;
  const [a0, z0, h0, g0, s0] = KEYFRAMES[i], [a1, z1, h1, g1, s1] = KEYFRAMES[i + 1];
  const k = a1 > a0 ? Math.max(0, Math.min(1, (a - a0) / (a1 - a0))) : 0;
  return { zenith: mix3(z0, z1, k), horizon: mix3(h0, h1, k), glow: mix3(g0, g1, k), glowStrength: lerp(s0, s1, k), dayness: Math.max(0, Math.min(1, (a + 6) / 18)) };
}
/** How much of the star field shows: all of it below -12°, none above -1°. */
export const starVisibility = (alt) => Math.max(0, Math.min(1, (-1 - alt) / 11));

// ------------------------------------------------------------------- clouds
const hash = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
/**
 * A seeded field of cumulus: each a cluster of puffs at a height band, with its own drift. The
 * same seed always gives the same sky, so a screenshot and a test agree.
 */
export function cloudField(seed = 3, count = 8) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash(seed * 97 + i * 13 + k);
    const puffs = [];
    const n = 4 + Math.floor(h(1) * 5);
    for (let j = 0; j < n; j++) puffs.push({ dx: (j / (n - 1) - 0.5) * 1.6 + (h(10 + j) - 0.5) * 0.3, dy: -(0.35 * Math.sin((j / (n - 1)) * Math.PI)) - h(20 + j) * 0.15, r: 0.32 + h(30 + j) * 0.3 });
    out.push({ u: h(2), v: 0.10 + h(3) * 0.42, s: 0.55 + h(4) * 0.9, speed: 0.004 + h(5) * 0.006, puffs });
  }
  return out;
}
/** Long thin cirrus streaks, high up. */
export function cirrusField(seed = 5, count = 4) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash(seed * 131 + i * 17 + k);
    out.push({ u: h(1), v: 0.05 + h(2) * 0.2, len: 0.18 + h(3) * 0.25, tilt: (h(4) - 0.5) * 0.12, speed: 0.0015 + h(5) * 0.002, thick: 0.006 + h(6) * 0.008 });
  }
  return out;
}

export const WEATHER = Object.freeze({
  clear: { cover: 0.12, clouds: 3, grey: 0, rain: false, storm: false },
  scattered: { cover: 0.4, clouds: 8, grey: 0.08, rain: false, storm: false },
  overcast: { cover: 0.85, clouds: 16, grey: 0.35, rain: false, storm: false },
  storm: { cover: 1, clouds: 18, grey: 0.6, rain: true, storm: true },
});

// ------------------------------------------------------------------- drawing
const CACHE = new WeakMap();                              // canvas -> { dome, key, w, h }

function domeLayer(ctx, pw, ph, key, paint) {
  const cv = ctx.canvas;
  if (!cv || typeof ctx.drawImage !== 'function' || typeof document === 'undefined' || !document.createElement) return false;
  let c = CACHE.get(cv);
  if (!c || c.w !== pw || c.h !== ph) {
    const canvas = document.createElement('canvas'); canvas.width = pw; canvas.height = ph;
    const c2 = canvas.getContext?.('2d');
    if (!c2) return false;
    c = { canvas, ctx: c2, key: null, w: pw, h: ph };
    CACHE.set(cv, c);
  }
  if (c.key !== key) { c.ctx.setTransform(1, 0, 0, 1, 0, 0); c.ctx.clearRect(0, 0, pw, ph); paint(c.ctx); c.key = key; }
  ctx.drawImage(c.canvas, 0, 0);
  return true;
}

function paintDome(ctx, pw, ph, cols) {
  // OPAQUE DISCS FROM THE OUTSIDE IN. The dome is one circle centred well below the bottom edge,
  // so its rings curve gently like a sky's; each disc is painted whole in the colour of its own
  // height, largest (the zenith) first, so what is left showing between two radii is the colour
  // of the smaller -- the horizon's at the bottom, the zenith's at the top. Not softStops: that
  // helper composes translucent discs for a bright centre fading OUTWARD, and a sky is the other
  // way round (the first cut came out one flat zenith blue for exactly that reason).
  const cy = ph * 2.4, R = cy;
  const tH = (cy - ph) / R;                                 // the horizon's radius, as a share of R
  // the zenith colour under everything: the corners above the dome's crown are the top of the
  // sky, and a first cut that left them unpainted showed the board's black as a dark arc
  ctx.fillStyle = rgb(cols.zenith);
  ctx.fillRect(0, 0, pw, ph);
  const N = 140;
  for (let i = 0; i <= N; i++) {
    const t = 1 - (i / N) * (1 - tH) - (i === N ? 0.002 : 0);
    const k = Math.pow(Math.max(0, (t - tH) / (1 - tH)), 0.75);   // 1 at the zenith, 0 at the horizon; the haze holds the low sky
    ctx.fillStyle = rgb(mix3(cols.horizon, cols.zenith, k));
    ctx.beginPath(); ctx.arc(pw / 2, cy, Math.max(1, R * t), 0, Math.PI * 2); ctx.fill();
  }
  // the ground line: the horizon colour fills what the smallest disc leaves at the very bottom
  ctx.fillStyle = rgb(cols.horizon);
  ctx.fillRect(0, ph - 2, pw, 2);
}

function paintTwilight(ctx, pw, ph, sunX, cols, softStops) {
  if (cols.glowStrength <= 0.02) return;
  const R = pw * 0.62;
  softStops(ctx, sunX, ph + ph * 0.12, R, [
    [0, rgb(cols.glow, 0.62 * cols.glowStrength)], [0.35, rgb(cols.glow, 0.32 * cols.glowStrength)], [1, rgb(cols.glow, 0)],
  ], 90);
}

function paintSun(ctx, pw, ph, s, sun, cols, softStops) {
  if (sun.alt < -8) return;
  const k = Math.max(0, Math.min(1, sun.alt / 30));
  const c = mix3([255, 120, 60], [255, 250, 232], k);
  const r = ph * 0.02 * (1 + 0.7 * (1 - k));
  const glow = 0.3 + 0.35 * (1 - k);
  const vis = sun.alt < 0 ? Math.max(0, 1 + sun.alt / 8) : 1;
  softStops(ctx, s.x, s.y, ph * 0.5, [[0, rgb(c, glow * 0.7 * vis)], [0.08, rgb(c, glow * 0.45 * vis)], [0.3, rgb(c, glow * 0.12 * vis)], [1, rgb(c, 0)]], 90);
  // the disc, with a soft edge: a few rings from the rim in
  softStops(ctx, s.x, s.y, r * 1.5, [[0, rgb(c, vis)], [0.6, rgb(c, vis)], [1, rgb(c, 0)]], 12);
  softStops(ctx, s.x, s.y, r * 0.9, [[0, rgb([255, 255, 250], 0.9 * k * vis)], [1, rgb([255, 255, 250], 0)]], 8);
}

function paintMoon(ctx, pw, ph, m, moon, phase, night, cols, softStops) {
  if (moon.alt < -3 || phase.lit < 0.03) return;
  const r = ph * 0.03;
  // faint by day (a daytime moon is there, but it is not a lamp), and a thin crescent by day is invisible
  const show = Math.max(0, Math.min(1, (moon.alt + 3) / 6)) * (0.12 + 0.88 * night);
  if (show <= 0.02 || (night < 0.3 && phase.lit < 0.25)) return;
  if (night > 0.3) softStops(ctx, m.x, m.y, r * 5, [[0, rgb([220, 228, 245], 0.25 * night * show)], [0.3, rgb([220, 228, 245], 0.08 * night * show)], [1, rgb([220, 228, 245], 0)]], 40);
  ctx.fillStyle = rgb([236, 238, 244], show);
  ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill();
  // the seas, faint
  ctx.fillStyle = rgb([196, 200, 212], show * 0.6);
  for (const [dx, dy, rr] of [[-0.3, -0.2, 0.28], [0.2, 0.1, 0.2], [-0.05, 0.4, 0.15]]) { ctx.beginPath(); ctx.arc(m.x + dx * r, m.y + dy * r, rr * r, 0, Math.PI * 2); ctx.fill(); }
  // the phase: a disc of sky over the dark part, offset by the lit fraction (waxing: lit on the right)
  const skyHere = mix3(cols.horizon, cols.zenith, Math.max(0, Math.min(1, 1 - m.y / ph)));
  const d = 2 * r * phase.lit;
  const off = (phase.waxing ? -1 : 1) * d;
  ctx.fillStyle = rgb(skyHere, 0.93 * show);
  ctx.beginPath(); ctx.arc(m.x + off, m.y, r * 1.02, 0, Math.PI * 2); ctx.fill();
}

function paintClouds(ctx, pw, ph, now, opts, sun, s, cols, weather, softStops) {
  const cover = Number.isFinite(opts.skyCover) ? Math.max(0, Math.min(1, opts.skyCover)) : weather.cover;
  if (cover <= 0.01) return;
  const count = Math.max(1, Math.round(2 + cover * 16));
  const clouds = cloudField(3, count);
  const grey = weather.grey + Math.max(0, cover - 0.6) * 0.5;
  const day = cols.dayness;
  const sunk = Math.max(0, Math.min(1, sun.alt / 25));
  // lit from the sun's side by day, warm at the horizon, silver by moonlight at night
  const litBase = mix3(mix3([70, 80, 110], [250, 252, 255], day), [255, 205, 150], (1 - sunk) * day * 0.7);
  const lit = mix3(litBase, [120, 125, 140], grey);
  const shade = mix3(lit, mix3([20, 26, 48], [110, 120, 140], day), 0.45 + grey * 0.3);
  const t = now / 1000;
  const wind = (opts.skyWind ?? 1);
  for (let i = 0; i < clouds.length; i++) {
    const c = clouds[i];
    const u = ((c.u + t * c.speed * wind * 0.5) % 1.3 + 1.3) % 1.3 - 0.15;
    const cx = u * pw, cy = c.v * ph;
    const S = ph * 0.11 * c.s;
    const a = 0.55 + 0.4 * cover;
    const toSun = s.x > cx ? 1 : -1;
    for (const p of c.puffs) {
      const px = cx + p.dx * S, py = cy + p.dy * S, r = p.r * S;
      softStops(ctx, px, py + r * 0.35, r * 1.15, [[0, rgb(shade, a * 0.9)], [0.6, rgb(shade, a * 0.6)], [1, rgb(shade, 0)]], 24);
      softStops(ctx, px, py, r, [[0, rgb(lit, a)], [0.55, rgb(lit, a * 0.75)], [1, rgb(lit, 0)]], 24);
      // the bright rim on the sun's side
      if (day > 0.2) softStops(ctx, px + toSun * r * 0.25, py - r * 0.25, r * 0.55, [[0, rgb([255, 255, 255], a * 0.35 * day)], [1, rgb([255, 255, 255], 0)]], 16);
    }
  }
  // cirrus, high and slow, by day
  if (day > 0.3 && !weather.storm) {
    const wisps = cirrusField(5, 3 + Math.round(cover * 3));
    for (const w of wisps) {
      const u = ((w.u + t * w.speed * wind) % 1.4 + 1.4) % 1.4 - 0.2;
      const x0 = u * pw, y0 = w.v * ph;
      const n = Math.max(8, Math.round(w.len * pw / 14));
      for (let k = 0; k <= n; k++) {
        const f = k / n;
        const x = x0 + f * w.len * pw, y = y0 + f * w.tilt * ph + Math.sin(f * Math.PI * 2 + w.u * 9) * ph * 0.006;
        const r = w.thick * ph * (0.5 + Math.sin(f * Math.PI)) * 2.2;
        ctx.fillStyle = rgb([255, 255, 255], 0.05 * day);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

function paintRays(ctx, pw, ph, s, sun, cols) {
  if (sun.alt < 1 || sun.alt > 28) return;
  const a = 0.045 * (1 - sun.alt / 28) * cols.dayness;
  if (a <= 0.004) return;
  ctx.fillStyle = rgb(cols.glow, a);
  for (let i = 0; i < 7; i++) {
    const ang = -Math.PI / 2 + (i - 3) * 0.22 + Math.sin(i * 1.7) * 0.05;
    const w = 0.05 + (i % 3) * 0.02;
    const L = ph * 1.6;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + Math.cos(ang - w) * L, s.y - Math.sin(ang - w) * L);
    ctx.lineTo(s.x + Math.cos(ang + w) * L, s.y - Math.sin(ang + w) * L);
    ctx.closePath(); ctx.fill();
  }
}

function paintRain(ctx, pw, ph, now, dpr) {
  const n = Math.round((pw * ph) / 3500);
  const fall = (now / 1000) * ph * 1.4;
  ctx.strokeStyle = 'rgba(200,212,232,0.28)';
  ctx.lineWidth = Math.max(1, dpr * 0.8);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = ((hash(i * 7 + 1) * pw + (now / 1000) * 30 * (0.5 + hash(i * 3 + 9))) % (pw + 40)) - 20;
    const y = ((hash(i * 11 + 2) * ph + fall * (0.7 + hash(i * 5 + 4) * 0.6)) % (ph + 30)) - 15;
    ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 14 * dpr);
  }
  ctx.stroke();
}

/** A bolt: midpoint displacement from a cloud base to the ground, seeded, with a branch. */
export function boltPoints(seed, x0, y0, x1, y1, depth = 5) {
  let pts = [{ x: x0, y: y0 }, { x: x1, y: y1 }];
  let k = 0;
  for (let d = 0; d < depth; d++) {
    const next = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const off = (hash(seed * 31 + k++) - 0.5) * len * 0.5;
      next.push({ x: mx + off, y: my + (hash(seed * 37 + k++) - 0.5) * len * 0.12 }, b);
    }
    pts = next;
  }
  return pts;
}

function paintLightning(ctx, pw, ph, now, dpr) {
  const slot = Math.floor(now / 5000);
  if (hash(slot * 3 + 0.5) > 0.35) return;                       // most slots are quiet
  const at = slot * 5000 + hash(slot * 5 + 0.25) * 4000;
  const age = now - at;
  if (age < 0 || age > 220) return;
  const k = 1 - age / 220;
  ctx.fillStyle = `rgba(220,228,255,${(0.28 * k).toFixed(3)})`;
  ctx.fillRect(0, 0, pw, ph);
  const x0 = pw * (0.15 + hash(slot * 7 + 0.75) * 0.7);
  const pts = boltPoints(slot, x0, ph * 0.2, x0 + (hash(slot * 9 + 0.1) - 0.5) * pw * 0.2, ph * 0.98);
  for (const [w, a] of [[9, 0.18], [4, 0.45], [1.6, 0.95]]) {
    ctx.strokeStyle = `rgba(236,240,255,${(a * k).toFixed(3)})`;
    ctx.lineWidth = w * dpr;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
}

function paintRainbow(ctx, pw, ph, s, sun, dpr) {
  if (sun.alt < 4 || sun.alt > 38) return;
  const k = 1 - Math.abs(sun.alt - 15) / 25;
  const a = 0.16 * Math.max(0, k);
  if (a <= 0.01) return;
  const cx = pw - s.x, cy = ph + ph * 0.55;
  const R = ph * 1.05;
  const bands = [[255, 70, 60], [255, 150, 50], [250, 230, 70], [90, 210, 90], [70, 150, 255], [90, 80, 220], [150, 70, 200]];
  ctx.lineWidth = Math.max(2, ph * 0.011);
  bands.forEach((c, i) => {
    ctx.strokeStyle = rgb(c, a);
    ctx.beginPath(); ctx.arc(cx, cy, R - i * ph * 0.011, Math.PI, Math.PI * 2); ctx.stroke();
  });
}

function paintShootingStar(ctx, pw, ph, now, night, dpr) {
  if (night < 0.5) return;
  const slot = Math.floor(now / 14000);
  if (hash(slot * 13 + 0.35) > 0.5) return;
  const at = slot * 14000 + hash(slot * 17 + 0.65) * 12000;
  const age = now - at;
  if (age < 0 || age > 800) return;
  const f = age / 800;
  const x0 = pw * (0.1 + hash(slot * 19 + 0.2) * 0.8), y0 = ph * (0.05 + hash(slot * 23 + 0.4) * 0.35);
  const dx = pw * 0.18 * (hash(slot * 29 + 0.8) > 0.5 ? 1 : -1), dy = ph * 0.12;
  const hx = x0 + dx * f, hy = y0 + dy * f;
  const tail = Math.min(1, f * 3) * 0.7;
  const a = (1 - f) * night;
  ctx.strokeStyle = `rgba(255,255,255,${(a * 0.8).toFixed(3)})`;
  ctx.lineWidth = 1.2 * dpr;
  ctx.beginPath(); ctx.moveTo(hx - dx * tail, hy - dy * tail); ctx.lineTo(hx, hy); ctx.stroke();
  ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
  ctx.beginPath(); ctx.arc(hx, hy, 1.4 * dpr, 0, Math.PI * 2); ctx.fill();
}

/**
 * The whole sky at `now` (an animation clock, ms) onto `ctx`, `pw` x `ph` device pixels.
 * `helpers.softStops(ctx, x, y, r, stops, N)` and `helpers.drawStars(opts)` come from details3d.
 * Returns what it drew, for a test: the sun's altitude, whether the sun, the moon and the stars
 * showed, the weather.
 */
export function drawLivingSky(ctx, pw, ph, dpr, now, opts, helpers) {
  const { softStops, drawStars } = helpers;
  const t = skyTime(opts, opts.skyNowMs ?? Date.now());
  const lat = Number.isFinite(opts.skyLat) ? opts.skyLat : null;
  const sun = sunPosition(t.hour, t.dayOfYear, lat);
  const cols = skyColours(sun.alt);
  const night = starVisibility(sun.alt);
  const weather = WEATHER[opts.skyWeather] ?? WEATHER.scattered;
  const s = sunScreen(sun, pw, ph, lat == null ? 62 : 90);
  // the dome, cached until the sun has moved half a degree
  const key = `${pw}x${ph}|${Math.round(sun.alt * 2) / 2}`;
  const painted = domeLayer(ctx, pw, ph, key, (c2) => paintDome(c2, pw, ph, cols));
  if (!painted) paintDome(ctx, pw, ph, cols);
  // the stars, fading in as the sun goes down (the star field details3d already keeps)
  if (night > 0.01 && drawStars) drawStars({ ...opts, stars: true, starBrightness: (Number.isFinite(opts.starBrightness) ? opts.starBrightness : 1) * night });
  paintTwilight(ctx, pw, ph, s.x, cols, softStops);
  if (opts.skyShooting !== false) paintShootingStar(ctx, pw, ph, now, night, dpr);
  const phase = moonPhase(t.date);
  const moon = moonPosition(t.hour, phase, t.dayOfYear, lat);
  const m = sunScreen(moon, pw, ph, lat == null ? 62 : 90);
  paintMoon(ctx, pw, ph, m, moon, phase, night, cols, softStops);
  paintSun(ctx, pw, ph, s, sun, cols, softStops);
  if (opts.skyRays !== false) paintRays(ctx, pw, ph, s, sun, cols);
  paintClouds(ctx, pw, ph, now, opts, sun, s, cols, weather, softStops);
  if (opts.skyRainbow && opts.skyWeather === 'scattered') paintRainbow(ctx, pw, ph, s, sun, dpr);
  if (weather.rain) { paintRain(ctx, pw, ph, now, dpr); if (weather.storm) paintLightning(ctx, pw, ph, now, dpr); }
  return { hour: t.hour, alt: sun.alt, sun: sun.alt >= -8, moon: moon.alt >= -3 && phase.lit >= 0.03, stars: night, weather: opts.skyWeather ?? 'scattered', phase: phase.p };
}
