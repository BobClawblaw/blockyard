// SCORCHED YARD'S AIR (operator, 2026-09-16: "The wind effects need to be much better. Consider
// maybe adding subtle plasma? We need to really leverage a shifting effect that conveys the air
// flow. Fluid simulation?").
//
// The first three cuts were kinematic: motes, then dashes, then dashes in bands, each one a sprite
// told where to be at time t. Air does not work like that, and it does not look like that -- what
// reads as wind is MATERIAL BEING CARRIED: something enters upwind, is pushed along, is pulled
// aside by an eddy, slows in a lee and leaves downwind.
//
// So this is a flow field, advected. A scalar field of smooth noise drifts downwind, and the
// velocity is its CURL -- the perpendicular gradient, which is divergence-free, so the flow neither
// piles material up nor tears holes in it, which is the thing that makes curl noise read as fluid
// rather than as wobble. The base wind is added to it, and the curl is held to a fraction of that
// base, so every particle still nets downwind however much it swirls on the way: the direction is
// never in doubt (operator, earlier: "it needs to consistently move in one direction").
//
// Over it, a PLASMA: the same field, drawn as a very faint wash on a coarse grid, so the air has
// body between the streaks. Subtle by construction -- no cell is ever more than a few per cent
// opaque, and the whole wash is one flat fill per cell, which the rasteriser is happy with.
//
// Nothing here reads the DOM or the clock: the caller passes the size, the wind and the time.

// ------------------------------------------------------------------ the field
const hash2 = (x, y) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
const smooth = (t) => t * t * (3 - 2 * t);

/** Value noise: smooth, seamless enough, and cheap -- four hashes and three blends per sample. */
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Two octaves of it, which is enough structure for eddies at two sizes. Time MORPHS the field in
 * place: each octave is a blend of two samples that trade places on a slow cosine. The first cut
 * scrolled the octaves instead, one up and one down, and two layers sliding against each other
 * read as motion in whatever direction the eye picks -- against the wind as often as not. Nothing
 * here travels; the drift the caller subtracts from x is the only translation there is.
 */
export function field(x, y, t) {
  const k = 0.5 - 0.5 * Math.cos(t * 0.9), k2 = 0.5 - 0.5 * Math.cos(t * 1.3 + 1.1);
  const a = noise2(x, y) * (1 - k) + noise2(x + 37.3, y + 19.1) * k;
  const b = noise2(x * 2.3 + 11, y * 2.3) * (1 - k2) + noise2(x * 2.3 + 53.7, y * 2.3 + 29.9) * k2;
  return a * 0.68 + b * 0.32;
}

/**
 * The curl of that field at a point: `{ x, y }`, of order 1. Divergence-free by construction --
 * this is what makes the flow look like a fluid and not like a heat haze.
 */
export function curl(x, y, t, e = 0.09) {
  const dy = (field(x, y + e, t) - field(x, y - e, t)) / (2 * e);
  const dx = (field(x + e, y, t) - field(x - e, y, t)) / (2 * e);
  return { x: dy, y: -dx };
}

// ------------------------------------------------------------------ the air's own clock
/**
 * THE AIR KEEPS ITS OWN TIME (operator, 2026-09-16: "the nebula effects ... do something really
 * jarring during wind transitions. it's like they rapidly block in the reverse direction before
 * calming down"). The first cut took the page's clock and multiplied it by a rate that depended on
 * the wind: field time = now * rate, drift = now * speed. On a page a day old `now` is tens of
 * thousands of seconds, so the smallest change in the wind -- and the eased wind changes by a hair
 * every frame of a transition -- moved the wash by tens of thousands of seconds' worth of travel,
 * and flipped it end to end when the direction flipped.
 *
 * So the clock is INTEGRATED: each frame adds this frame's `dt` at this frame's rate. A change of
 * wind changes how fast the clock runs from here on, and nothing else. `advanceAir` is the whole
 * of it; the caller keeps the object.
 */
export function airClock() { return { t: 0, drift: 0 }; }
export function advanceAir(clock, dt, wind) {
  const strength = Math.min(1, Math.abs(wind ?? 0) / 10);
  const dir = wind < 0 ? -1 : 1;
  const s = Math.max(0, dt) / 1000;
  clock.t += s * (0.1 + 0.12 * strength);
  clock.drift += s * (0.06 + 0.5 * strength) * dir;
  return clock;
}

// ------------------------------------------------------------------ what is carried
const RESEED = 7000;                                     // a particle's life, ms: nothing lives in a lee for ever
export const SWIRL_CAP = 0.34;                          // the eddies' share of the base wind, at most

/**
 * A field of particles, in CSS pixels, seeded evenly so nothing starts in a clump. `now` is the
 * caller's clock, and it matters: births are dated from it, and each particle gets a LIFE OF ITS
 * OWN. The first cut dated every birth from zero on a page clock that was twelve hours old, so the
 * whole population died on its first step, came back in at the upwind edge together, and crossed
 * the field as one cohort for ever after -- a dense wall of streaks, then nothing, then the wall.
 */
export function makeFlow(n, w, h, seed = 1, now = 0) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const r = (k) => hash2(i * 7.31 + k, seed * 3.7 + k * 1.3);
    const life = RESEED * (0.55 + 0.9 * r(5));
    parts.push({ x: r(1) * w, y: r(2) * h, px: 0, py: 0, born: now - r(3) * life, life, sz: 0.55 + r(4) * 0.9, band: i % 3 });
  }
  for (const p of parts) { p.px = p.x; p.py = p.y; }
  return parts;
}

/**
 * Carry them for `dt` milliseconds and answer the segments to draw: each particle's last step,
 * which is its own short streak. `wind` is the game's gauge value; the base speed across the panel
 * comes from it, the curl is a fraction of that base, and a particle that leaves downwind (or
 * outlives RESEED) comes back in upwind at a fresh height.
 */
export function stepFlow(parts, dt, { wind = 0, w = 800, h = 400, now = 0, scale = 0.0042, clock = null } = {}) {
  const strength = Math.min(1, Math.abs(wind) / 10);
  const dir = wind < 0 ? -1 : 1;
  const base = w * (0.035 + 0.42 * strength);              // px a second downwind
  const swirl = base * (0.16 + 0.2 * (1 - strength));      // a light wind wanders more than a gale
  const t = clock ? clock.t : now / 1000 * 0.16;           // the field's own time, integrated by the caller
  const s = dt / 1000;
  const segs = [];
  for (const p of parts) {
    const c = curl(p.x * scale, p.y * scale, t);
    // THE EDDY NEVER WINS. The curl is unbounded, and where it ran against the wind the particles
    // stalled into a standing column and could even drift upwind. The swirl is capped at a third
    // of the base, so a particle bends, slows and speeds up on its way -- but its way is always
    // downwind, which is the one thing about this air that must never be in doubt.
    let sx = c.x * swirl, sy = c.y * swirl * 0.8;
    const sm = Math.hypot(sx, sy), cap = base * SWIRL_CAP;
    if (sm > cap) { sx *= cap / sm; sy *= cap / sm; }
    const vx = base * dir + sx;
    const vy = sy;
    p.px = p.x; p.py = p.y;
    p.x += vx * s;
    p.y += vy * s;
    const dead = now - p.born > p.life;
    const out = p.x < -w * 0.06 || p.x > w * 1.06 || p.y < -h * 0.08 || p.y > h * 1.08;
    if (dead || out) {
      // back in upwind, at a fresh height: the field is fed from the edge the wind comes from
      p.x = dir > 0 ? -w * 0.04 * hash2(p.y, now) : w * (1 + 0.04 * hash2(p.y, now));
      p.y = hash2(now * 0.37 + p.sz * 91, p.x) * h;
      p.born = now;
      p.px = p.x; p.py = p.y;
      continue;                                            // no streak across the wrap
    }
    const age = (now - p.born) / p.life;
    const fade = Math.min(1, age * 6) * Math.min(1, (1 - age) * 3.2);   // in at birth, out at death
    const speed = Math.hypot(vx, vy) / Math.max(1, base);
    if (fade <= 0.01) continue;
    segs.push({
      x0: p.px, y0: p.py, x1: p.x, y1: p.y,
      alpha: (0.1 + 0.3 * strength) * fade * (0.5 + 0.7 * speed) * (0.55 + 0.45 * p.band / 2),
      th: p.sz * (0.7 + 0.8 * (p.band / 2)),
    });
  }
  return segs;
}

/** The streaks: one stroked line each, flat colour, no gradients. */
export function paintFlow(ctx, segs, colour = '218,224,234') {
  ctx.lineCap = 'round';
  for (const s of segs) {
    ctx.strokeStyle = `rgba(${colour},${Math.min(0.75, s.alpha).toFixed(3)})`;
    ctx.lineWidth = s.th;
    ctx.beginPath();
    ctx.moveTo(s.x0, s.y0);
    ctx.lineTo(s.x1, s.y1);
    ctx.stroke();
  }
}

// ------------------------------------------------------------------ the plasma under it
/**
 * The same field as a faint wash on a coarse grid: cells of `cell` pixels, each a flat fill whose
 * opacity is the field's value there. It gives the air body between the streaks without ever being
 * a thing you look at -- the strongest cell is four per cent opaque at a full gale.
 */
export function plasmaCells(w, h, clock, wind, cell = 30) {
  const strength = Math.min(1, Math.abs(wind ?? 0) / 10);
  if (!w || !h || strength < 0.03) return [];
  // the clock is the air's own (advanceAir): a plain number is taken as seconds of still time
  const t = typeof clock === 'number' ? clock / 1000 * 0.16 : clock.t;
  const drift = typeof clock === 'number' ? 0 : clock.drift;
  const out = [];
  const cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = field(i * 0.16 - drift, j * 0.16, t);
      const a = (v - 0.45) * (0.05 + 0.03 * strength);
      if (a <= 0.004) continue;
      // a staggered grid of overlapping discs, not squares: on a dark sky a grid of squares is a
      // grid, and a blotch that overlaps its neighbours is weather
      // jittered off the lattice as well, so a black sky does not show the honeycomb underneath
      const jx = (hash2(i * 3.1, j * 7.7) - 0.5) * cell * 0.7, jy = (hash2(i * 5.3, j * 2.9) - 0.5) * cell * 0.7;
      out.push({ x: i * cell + (j % 2 ? cell / 2 : 0) + jx, y: j * cell + jy, r: cell * (0.9 + 0.35 * hash2(j, i)), alpha: Math.min(0.045, a) });
    }
  }
  return out;
}

export function paintPlasma(ctx, cells, colour = '196,214,238') {
  for (const c of cells) {
    ctx.fillStyle = `rgba(${colour},${c.alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
