// SCORCHED YARD'S AIR, SIMULATED (operator, 2026-09-16, with a night capture: "There is no
// simulation movement. It's just a squiggly line moving across the screen").
//
// (It first showed the flow with a dye -- smoke carried by the air -- which read as smoke blowing
// out of the scene. The dye is gone; the flow lines at the bottom of this module are the picture.)
//
// That was fair. Every earlier cut was kinematic: sprites, dashes and finally sine curves, each
// told where to be at time t. None of them could flow round anything, because nothing in them knew
// what was there. This is an actual fluid: a small grid solved the way Jos Stam's "Stable Fluids"
// does it -- velocity advected semi-Lagrangian, made divergence-free by a pressure projection,
// with vorticity confinement to keep the eddies alive -- and weightless tracers carried by that
// velocity, whose paths are what you see.
//
//   * THE WIND is a body force pulling the air toward the gauge's speed and direction. A change of
//     wind is not a fade: the air has momentum and turns round.
//   * THE LAND IS SOLID. Cells under the terrain are walls, so the air rises over the hills, speeds
//     up across the crests and rolls into eddies in their lee. That is the bowing.
//   * TURBULENCE is a few small vortex impulses a step, stronger in a strong wind, which the solver
//     carries, stretches and tears apart on its own.
//
// Cheap by construction: 96 x 48 cells, fourteen Jacobi iterations a step, all typed arrays. Nothing
// here reads the DOM; the caller hands over the size, the wind and the solid mask.

const IX = (f, x, y) => x + y * f.nx;
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hash = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const smooth = (t) => t * t * (3 - 2 * t);

/** A fluid of `nx` by `ny` cells, still. */
export function makeFluid(nx = 96, ny = 48, seed = 1) {
  const n = nx * ny;
  return {
    nx, ny, t: 0, seed,
    u: new Float32Array(n), v: new Float32Array(n), u0: new Float32Array(n), v0: new Float32Array(n),
    p: new Float32Array(n), div: new Float32Array(n), w: new Float32Array(n), solid: new Uint8Array(n),
  };
}

/** Mark the cells the land fills. `topOf(x)` answers the first free row, from the top, of column x. */
export function setSolid(f, topOf) {
  f.solid.fill(0);
  for (let x = 0; x < f.nx; x++) {
    const top = clampI(Math.round(topOf(x)), 0, f.ny);
    for (let y = top; y < f.ny; y++) f.solid[IX(f, x, y)] = 1;
  }
}

function sample(f, a, x, y, wrap = true) {
  // x wraps (the field is a strip of sky) for the solver; a tracer beyond the edge reads the edge
  x = wrap ? ((x % f.nx) + f.nx) % f.nx : (x < 0 ? 0 : x > f.nx - 1.001 ? f.nx - 1.001 : x);
  y = y < 0 ? 0 : y > f.ny - 1.001 ? f.ny - 1.001 : y;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = (x0 + 1) % f.nx, y1 = y0 + 1;
  const sx = x - x0, sy = y - y0;
  return (a[x0 + y0 * f.nx] * (1 - sx) + a[x1 + y0 * f.nx] * sx) * (1 - sy) + (a[x0 + y1 * f.nx] * (1 - sx) + a[x1 + y1 * f.nx] * sx) * sy;
}

/** One step of the solver: `dt` in ms, `wind` the gauge value (-10..10). */
export function stepFluid(f, dt, { wind = 0 } = {}) {
  const s = Math.min(0.05, Math.max(0, dt / 1000));
  if (!s) return f;
  f.t += s;
  const { nx, ny, u, v, u0, v0, p, div, w, solid } = f;
  const n = nx * ny;
  const strength = Math.min(1, Math.abs(wind) / 10);
  const dir = wind < 0 ? -1 : 1;
  const U = dir * (2.5 + 17 * strength);                   // cells a second at the gauge's speed: a gale crosses in five seconds

  // --- forces: the wind pulls the air toward its speed; a few vortex impulses stir it
  const pull = Math.min(1, 2.2 * s);
  for (let i = 0; i < n; i++) { if (solid[i]) { u[i] = 0; v[i] = 0; continue; } u[i] += (U - u[i]) * pull; v[i] *= 1 - Math.min(1, 0.35 * s); }
  const kicks = 1 + Math.round(3 * strength);
  for (let k = 0; k < kicks; k++) {
    const h = (q) => hash(f.t * 97.3 + k * 13.1 + q + f.seed);
    if (h(1) > 0.55) continue;                              // not every step
    const cx = h(2) * nx, cy = h(3) * ny * 0.85, r = 2.5 + h(4) * 4;
    const spin = (h(5) - 0.5) * (6 + 22 * strength);
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(ny - 1, Math.ceil(cy + r)); y++) {
      for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        const x = ((xx % nx) + nx) % nx;
        const dx = xx - cx, dy = y - cy, q = dx * dx + dy * dy;
        if (q > r * r) continue;
        const fall = (1 - q / (r * r)) * spin * s;
        const i = x + y * nx;
        if (solid[i]) continue;
        u[i] += -dy * fall; v[i] += dx * fall;
      }
    }
  }

  // --- advect the velocity by itself
  u0.set(u); v0.set(v);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx;
    if (solid[i]) { u[i] = 0; v[i] = 0; continue; }
    const bx = x - u0[i] * s, by = y - v0[i] * s;
    u[i] = sample(f, u0, bx, by); v[i] = sample(f, v0, bx, by);
  }

  // --- vorticity confinement: find where the air spins and push it to keep spinning
  for (let y = 1; y < ny - 1; y++) for (let x = 0; x < nx; x++) {
    const xl = (x - 1 + nx) % nx, xr = (x + 1) % nx;
    w[x + y * nx] = (v[xr + y * nx] - v[xl + y * nx] - u[x + (y + 1) * nx] + u[x + (y - 1) * nx]) * 0.5;
  }
  const eps = 1.4 + 2.2 * strength;
  for (let y = 2; y < ny - 2; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx;
    if (solid[i]) continue;
    const xl = (x - 1 + nx) % nx, xr = (x + 1) % nx;
    const gx = (Math.abs(w[xr + y * nx]) - Math.abs(w[xl + y * nx])) * 0.5;
    const gy = (Math.abs(w[x + (y + 1) * nx]) - Math.abs(w[x + (y - 1) * nx])) * 0.5;
    const len = Math.hypot(gx, gy) + 1e-5;
    u[i] += (gy / len) * w[i] * eps * s;
    v[i] -= (gx / len) * w[i] * eps * s;
  }

  // --- project: make it divergence-free, so it flows round the land instead of into it
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx;
    const xl = (x - 1 + nx) % nx, xr = (x + 1) % nx;
    const vu = y + 1 < ny ? v[x + (y + 1) * nx] : 0, vd = y > 0 ? v[x + (y - 1) * nx] : 0;
    div[i] = solid[i] ? 0 : -0.5 * (u[xr + y * nx] - u[xl + y * nx] + vu - vd);
    p[i] = 0;
  }
  for (let it = 0; it < 14; it++) {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + y * nx;
      if (solid[i]) continue;
      const xl = (x - 1 + nx) % nx, xr = (x + 1) % nx;
      const pc = p[i];
      const pl = solid[xl + y * nx] ? pc : p[xl + y * nx];
      const pr = solid[xr + y * nx] ? pc : p[xr + y * nx];
      const pu = y + 1 < ny && !solid[x + (y + 1) * nx] ? p[x + (y + 1) * nx] : pc;
      const pd = y > 0 && !solid[x + (y - 1) * nx] ? p[x + (y - 1) * nx] : pc;
      p[i] = (div[i] + pl + pr + pu + pd) * 0.25;
    }
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx;
    if (solid[i]) { u[i] = 0; v[i] = 0; continue; }
    const xl = (x - 1 + nx) % nx, xr = (x + 1) % nx;
    const pc = p[i];
    const pl = solid[xl + y * nx] ? pc : p[xl + y * nx];
    const pr = solid[xr + y * nx] ? pc : p[xr + y * nx];
    const pu = y + 1 < ny && !solid[x + (y + 1) * nx] ? p[x + (y + 1) * nx] : pc;
    const pd = y > 0 && !solid[x + (y - 1) * nx] ? p[x + (y - 1) * nx] : pc;
    u[i] -= 0.5 * (pr - pl);
    v[i] -= 0.5 * (pu - pd);
    if ((y === 0 && v[i] < 0) || (y === ny - 1 && v[i] > 0)) v[i] = 0;
  }

  return f;
}

/** The mean horizontal speed of the free air, for tests and for anyone curious. */
export function meanFlow(f) {
  let s = 0, k = 0;
  for (let i = 0; i < f.u.length; i++) if (!f.solid[i]) { s += f.u[i]; k += 1; }
  return k ? s / k : 0;
}

/**
 * Run the solver on its own for `seconds` of simulated time, so a new field -- a new game, a new
 * round's land -- opens on air that is already flowing round the hills rather than on a front of
 * smoke crawling in from one edge. About a quarter of a millisecond a step.
 */
export function warmFluid(f, seconds, wind) {
  const steps = Math.ceil((seconds * 1000) / 33);
  for (let i = 0; i < steps; i++) stepFluid(f, 33, { wind });
  return steps;
}

// ------------------------------------------------------------------ what the eye follows
/**
 * STREAKLINES THROUGH THE SIMULATED FLOW (operator, 2026-09-16: "looks too much like smoke blowing
 * out the scene"). Any soft density drifting across the sky reads as smoke, however it is tuned.
 * What reads as AIR is the wind map: many thin lines, each the recent path of a weightless tracer
 * carried by the simulated velocity, so they curve where the air curves -- up over a hill, into the
 * eddy behind it. Earlier lines read as shooting stars for two reasons, both absent here: they were
 * straight (told where to go, not carried), and bright at the head. These taper to nothing at BOTH
 * ends, brightest in the middle of their length, and there is no head to catch the eye.
 */
const TRAIL = 22;
const EDGE_RUN = 10;                                       // cells a tracer keeps going beyond the field before it is reborn
const EDGE_FADE = 0.09;                                    // the share of the width, and of the height at the top, over which lines fade out
export function makeTracers(f, n = 320, seed = 1) {
  const tr = { n, x: new Float32Array(n), y: new Float32Array(n), age: new Float32Array(n), life: new Float32Array(n), len: new Uint8Array(n), hx: new Float32Array(n * TRAIL), hy: new Float32Array(n * TRAIL), head: new Uint8Array(n), seed, k: 0 };
  for (let i = 0; i < n; i++) respawn(f, tr, i, true);
  return tr;
}

function respawn(f, tr, i, anywhere) {
  // a free cell, anywhere on the field: density stays even, nothing enters as a front
  for (let tries = 0; tries < 24; tries++) {
    tr.k += 1;
    const x = hash(tr.seed * 31.7 + tr.k * 1.618) * f.nx, y = hash(tr.seed * 17.3 + tr.k * 2.414) * f.ny;
    if (!f.solid[Math.floor(x) + Math.floor(y) * f.nx]) { tr.x[i] = x; tr.y[i] = y; break; }
  }
  tr.age[i] = 0;
  tr.life[i] = 2.5 + hash(tr.seed + tr.k * 0.77) * 3.5;
  tr.len[i] = 0;
  tr.head[i] = 0;
  if (anywhere) tr.age[i] = hash(tr.k * 3.3) * tr.life[i] * 0.6;
}

/** Carry every tracer `dt` ms through the fluid's velocity, keeping its recent path. */
export function stepTracers(f, tr, dt) {
  const s = Math.min(0.05, Math.max(0, dt / 1000));
  if (!s) return tr;
  for (let i = 0; i < tr.n; i++) {
    const ux = sample(f, f.u, tr.x[i], tr.y[i], false), vy = sample(f, f.v, tr.x[i], tr.y[i], false);
    let x = tr.x[i] + ux * s, y = tr.y[i] + vy * s;
    tr.age[i] += s;
    // A TRACER RUNS ON PAST THE EDGE (operator, 2026-09-16, with a capture of the right edge: "It's
    // not fading out cleanly at the edges, it just sorta disappears"). It was removed the moment it
    // crossed, so its whole line vanished at once. It now carries on for a stretch beyond the field,
    // where paintTracers has already faded it to nothing, and is only reborn once it is out of sight.
    const gone = x < -EDGE_RUN || x >= f.nx + EDGE_RUN || y < -EDGE_RUN;
    const inside = x >= 0 && x < f.nx && y >= 0 && y < f.ny;
    const cell = inside && f.solid[Math.floor(x) + Math.floor(y) * f.nx];
    if (gone || y >= f.ny || cell || tr.age[i] > tr.life[i]) { respawn(f, tr, i, false); continue; }
    tr.x[i] = x; tr.y[i] = y;
    const h = (tr.head[i] + 1) % TRAIL;
    tr.head[i] = h;
    tr.hx[i * TRAIL + h] = x; tr.hy[i * TRAIL + h] = y;
    if (tr.len[i] < TRAIL) tr.len[i] += 1;
  }
  return tr;
}

/**
 * Draw the paths as thin polylines. Segments are bucketed into four opacities by where they sit
 * along the path -- faint at both ends, full in the middle -- so the whole field is four strokes,
 * not thousands. A tracer fades in over its first half second and out over its last.
 */
export function paintTracers(ctx, f, tr, w, h, { bright = 0, wind = 0, colour = '240,246,255' } = {}) {
  const strength = Math.min(1, Math.abs(wind) / 10);
  if (strength < 0.03) return 0;
  const sx = w / f.nx, sy = h / f.ny;
  const lit = Math.max(0, Math.min(1, bright));
  const base = (0.2 + 0.2 * lit) * (0.7 + 0.3 * strength);
  const levels = [0.25, 0.5, 0.75, 1];
  // ONE CONTINUOUS PATH PER RUN, EVERY OTHER POINT, FLAT CAPS (operator, 2026-09-16: "performance
  // freezing and jittering when the cubes are being blown up"). Measured with each layer switched
  // off in turn during a nuke, these lines were the largest single cost: 5,500 separate round-capped
  // segments a frame. A tracer's consecutive points in the same opacity band are now one polyline,
  // at half the points -- the paths are smooth, so nothing shows -- with butt caps and round joins.
  const paths = levels.map(() => []);
  for (let i = 0; i < tr.n; i++) {
    const L = tr.len[i];
    if (L < 5) continue;
    const fade = Math.min(1, tr.age[i] / 0.5, (tr.life[i] - tr.age[i]) / 0.8);
    if (fade <= 0.05) continue;
    let run = null, runLv = -1;
    // point p of the path, 0 the oldest and L-1 the newest, lives at this slot of the ring
    const slot = (q) => (tr.head[i] - (L - 1) + q + TRAIL * 2) % TRAIL;
    for (let p0 = 0; p0 < L - 1; p0 += 2) {
      const p1 = Math.min(p0 + 2, L - 1);
      const a = slot(p0), b = slot(p1);
      const ax = tr.hx[i * TRAIL + a], ay = tr.hy[i * TRAIL + a], bx = tr.hx[i * TRAIL + b], by = tr.hy[i * TRAIL + b];
      const along = (p0 + p1) / 2 / (L - 1);                  // 0 at the tail, 1 at the head
      // and nothing at the edges of the field: each segment fades by how near it is to the left, the
      // right or the top, smoothly, so a line going out of the picture thins away rather than ending
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
      const ex = Math.min(mx / (f.nx * EDGE_FADE), (f.nx - mx) / (f.nx * EDGE_FADE)), ey = my / (f.ny * EDGE_FADE);
      const edge = smooth(Math.max(0, Math.min(1, Math.min(ex, ey))));
      const taper = Math.sin(Math.PI * along) * fade * edge;   // nothing at either end, nothing at the edges
      if (taper < 0.08) { run = null; runLv = -1; continue; }
      const lv = taper < 0.3 ? 0 : taper < 0.55 ? 1 : taper < 0.8 ? 2 : 3;
      if (lv !== runLv || !run) { run = [ax * sx, ay * sy]; paths[lv].push(run); runLv = lv; }
      run.push(bx * sx, by * sy);
    }
  }
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.3;
  let strokes = 0;
  paths.forEach((runs, lv) => {
    if (!runs.length) return;
    ctx.strokeStyle = `rgba(${colour},${(base * levels[lv]).toFixed(3)})`;
    ctx.beginPath();
    for (const r of runs) { ctx.moveTo(r[0], r[1]); for (let j = 2; j < r.length; j += 2) ctx.lineTo(r[j], r[j + 1]); }
    ctx.stroke();
    strokes += 1;
  });
  return strokes;
}
