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
      // A STEADY FLOW, NOT A FRONT (operator, 2026-09-16: "the wave simulation comes across as a
      // front as opposed to a steady flow of fluid"). Every reborn particle used to come back in at
      // the upwind edge -- so in a light wind, where a life ends long before the crossing does, the
      // field was dense at that edge and empty downwind, and the density itself read as a wave
      // rolling in. Now only a particle that LEFT the field comes back at the edge it is fed from;
      // one that simply ran out of life is reborn anywhere, and the density stays even.
      p.x = out ? (dir > 0 ? -w * 0.04 * hash2(p.y, now) : w * (1 + 0.04 * hash2(p.y, now))) : hash2(now * 0.11 + p.sz * 37, p.y) * w;
      p.y = hash2(now * 0.37 + p.sz * 91, p.x) * h;
      p.born = now;
      p.px = p.x; p.py = p.y;
      p.tail = null;
      continue;                                            // no streak across the wrap
    }
    const age = (now - p.born) / p.life;
    const fade = Math.min(1, age * 6) * Math.min(1, (1 - age) * 3.2);   // in at birth, out at death
    const speed = Math.hypot(vx, vy) / Math.max(1, base);
    // THE TAIL (operator: "think about transparency or other type motion effects"): the last few
    // places the particle has been, kept on it and drawn as a ribbon that thins and fades toward
    // its end. A streak the length of one frame's step says "a dot moved"; a ribbon a quarter of a
    // second long says "something is being carried", and its curve shows the eddy it went round.
    p.tail = p.tail ?? [];
    p.tail.push({ x: p.px, y: p.py });
    if (p.tail.length > TAIL) p.tail.shift();
    if (fade <= 0.01) continue;
    segs.push({
      x0: p.px, y0: p.py, x1: p.x, y1: p.y, tail: p.tail,
      // twice the presence at half the count (operator, 2026-09-16: "They are too subtle now")
      alpha: (0.24 + 0.5 * strength) * fade * (0.5 + 0.7 * speed) * (0.55 + 0.45 * p.band / 2),
      th: p.sz * (1.1 + 1.1 * (p.band / 2)),
    });
  }
  return segs;
}
const TAIL = 11;                                           // positions kept: over a third of a second

/** The streaks: one stroked line each, flat colour, no gradients. */
export function paintFlow(ctx, segs, colour = '218,224,234') {
  ctx.lineCap = 'round';
  for (const s of segs) {
    const pts = s.tail && s.tail.length ? [...s.tail, { x: s.x1, y: s.y1 }] : [{ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }];
    const n = pts.length - 1;
    for (let i = 0; i < n; i++) {
      const k = (i + 1) / n;                               // 0 at the tail's end, 1 at the head
      ctx.strokeStyle = `rgba(${colour},${Math.min(0.92, s.alpha * (0.15 + 0.85 * k * k)).toFixed(3)})`;
      ctx.lineWidth = Math.max(0.5, s.th * (0.35 + 0.65 * k));
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
      ctx.stroke();
    }
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
      const a = (v - 0.45) * (0.08 + 0.05 * strength);
      if (a <= 0.004) continue;
      // a staggered grid of overlapping discs, not squares: on a dark sky a grid of squares is a
      // grid, and a blotch that overlaps its neighbours is weather
      // jittered off the lattice as well, so a black sky does not show the honeycomb underneath
      const jx = (hash2(i * 3.1, j * 7.7) - 0.5) * cell * 0.7, jy = (hash2(i * 5.3, j * 2.9) - 0.5) * cell * 0.7;
      out.push({ x: i * cell + (j % 2 ? cell / 2 : 0) + jx, y: j * cell + jy, r: cell * (0.9 + 0.35 * hash2(j, i)), alpha: Math.min(0.075, a) });
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

// ------------------------------------------------------------------ the currents
/**
 * STREAMLINES (operator: "make that air movement effect even more incredible ... new effects for
 * wind flow?"). The particles show what is carried; these show the CURRENTS it is carried on: a
 * few dozen curves traced through the same field, from the upwind edge across, bending round the
 * same eddies the particles do. They are re-traced only now and then -- the field morphs slowly --
 * and animated by a dashed stroke whose offset runs downwind at the wind's speed, so the dashes
 * flow along the curves like beads on a wire. Nearly free per frame, and there is no particle
 * state in them to age, reseed or synchronise.
 */
export function traceStreamlines(clock, { wind = 0, w = 800, h = 400, count = 28, steps = 44, scale = 0.0042 } = {}) {
  const strength = Math.min(1, Math.abs(wind) / 10);
  if (!w || !h || strength < 0.03) return [];
  const dir = wind < 0 ? -1 : 1;
  const base = w * (0.035 + 0.42 * strength);
  const swirl = base * (0.16 + 0.2 * (1 - strength));
  const cap = base * SWIRL_CAP;
  const step = (w * 1.12) / steps;                         // in pixels along the curve
  const lines = [];
  for (let i = 0; i < count; i++) {
    const y0 = ((i + 0.5) / count) * h + (hash2(i * 1.7, 3.3) - 0.5) * (h / count);
    let x = dir > 0 ? -w * 0.06 : w * 1.06, y = y0;
    const pts = [{ x, y }];
    for (let k = 0; k < steps; k++) {
      const c = curl(x * scale, y * scale, clock.t);
      let sx = c.x * swirl, sy = c.y * swirl * 0.8;
      const sm = Math.hypot(sx, sy);
      if (sm > cap) { sx *= cap / sm; sy *= cap / sm; }
      const vx = base * dir + sx, vy = sy, vm = Math.hypot(vx, vy) || 1;
      x += (vx / vm) * step; y += (vy / vm) * step;
      pts.push({ x, y });
    }
    lines.push({ pts, alpha: 0.12 + 0.22 * strength * (0.6 + 0.4 * hash2(i, 9.1)) });
  }
  return lines;
}

/** Draw them dashed, the dash offset carrying the pattern downwind: `travel` is pixels of drift so far. */
export function paintStreamlines(ctx, lines, travel, colour = '206,220,240') {
  if (!lines.length) return;
  ctx.lineCap = 'butt';
  ctx.setLineDash([20, 14]);
  for (const l of lines) {
    ctx.lineDashOffset = -travel;                          // the dashes run the way the curve was traced: downwind
    ctx.strokeStyle = `rgba(${colour},${l.alpha.toFixed(3)})`;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(l.pts[0].x, l.pts[0].y);
    for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i].x, l.pts[i].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}
