// SCORCHED YARD'S AIR, SIMULATED (operator, 2026-09-16, with a night capture: "There is no
// simulation movement. It's just a squiggly line moving across the screen").
//
// That was fair. Every earlier cut was kinematic: sprites, dashes and finally sine curves, each
// told where to be at time t. None of them could flow round anything, because nothing in them knew
// what was there. This is an actual fluid: a small grid solved the way Jos Stam's "Stable Fluids"
// does it -- velocity advected semi-Lagrangian, made divergence-free by a pressure projection,
// with vorticity confinement to keep the eddies alive -- and a dye field carried by that velocity,
// which is what you see.
//
//   * THE WIND is a body force pulling the air toward the gauge's speed and direction. A change of
//     wind is not a fade: the air has momentum and turns round.
//   * THE LAND IS SOLID. Cells under the terrain are walls, so the air rises over the hills, speeds
//     up across the crests and rolls into eddies in their lee. That is the bowing.
//   * TURBULENCE is a few small vortex impulses a step, stronger in a strong wind, which the solver
//     carries, stretches and tears apart on its own.
//   * THE DYE comes in on the upwind edge in filaments and thins as it goes. It is drawn as a soft,
//     faint wash: a grid of cells written to a tiny canvas and scaled up smooth.
//
// Cheap by construction: 96 x 48 cells, fourteen Jacobi iterations a step, all typed arrays. Nothing
// here reads the DOM; the caller hands over the size, the wind, the solid mask and a canvas.

const IX = (f, x, y) => x + y * f.nx;
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hash = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const smooth = (t) => t * t * (3 - 2 * t);
function noise1(x) { const i = Math.floor(x), f = x - i; return hash(i) * (1 - smooth(f)) + hash(i + 1) * smooth(f); }

/** A fluid of `nx` by `ny` cells, still, with a little dye already in it so the first frame is not empty. */
export function makeFluid(nx = 96, ny = 48, seed = 1) {
  const n = nx * ny;
  const f = {
    nx, ny, t: 0, seed,
    u: new Float32Array(n), v: new Float32Array(n), u0: new Float32Array(n), v0: new Float32Array(n),
    d: new Float32Array(n), d0: new Float32Array(n), p: new Float32Array(n), div: new Float32Array(n),
    w: new Float32Array(n), solid: new Uint8Array(n),
  };
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) f.d[IX(f, x, y)] = inflowAt(f, y, x * 0.37);
  return f;
}

/**
 * The filaments the upwind edge breathes in. A thin even haze has nothing in it for the eye to
 * follow (the first live read: dye everywhere at a third, painted at seven per cent, invisible), so
 * the inflow is a few distinct streams with clear air between them, each one pulsing -- and it is
 * the streams being bent over the hills and torn into eddies that shows the flow.
 */
function inflowAt(f, y, t) {
  const band = noise1(y * 0.36 + f.seed * 3.1 + t * 0.22);
  const edge = band < 0.58 ? 0 : band > 0.7 ? 1 : smooth((band - 0.58) / 0.12);
  const pulse = noise1(t * 1.1 + y * 0.09 + f.seed * 5.3);
  return edge * (0.55 + 0.9 * pulse);
}

/** Mark the cells the land fills. `topOf(x)` answers the first free row, from the top, of column x. */
export function setSolid(f, topOf) {
  f.solid.fill(0);
  for (let x = 0; x < f.nx; x++) {
    const top = clampI(Math.round(topOf(x)), 0, f.ny);
    for (let y = top; y < f.ny; y++) f.solid[IX(f, x, y)] = 1;
  }
}

function sample(f, a, x, y) {
  // x wraps (the field is a strip of sky), y clamps
  x = ((x % f.nx) + f.nx) % f.nx;
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
  const { nx, ny, u, v, u0, v0, d, d0, p, div, w, solid } = f;
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

  // --- the dye: carried by the air, breathed in on the upwind edge, thinning as it goes
  d0.set(d);
  const decay = 1 - Math.min(1, 0.02 * s);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx;
    if (solid[i]) { d[i] = 0; continue; }
    const bx = x - u[i] * s, by = y - v[i] * s;
    // a backtrace that leaves the strip on the upwind side comes from outside: fresh inflow
    const fromOutside = dir > 0 ? bx < 0 : bx > nx - 1;
    d[i] = (fromOutside ? inflowAt(f, y, f.t) : sample(f, d0, bx, by)) * decay;
  }
  return f;
}

/**
 * Draw the dye onto `small` (a canvas of nx by ny pixels) as a pale wash, then scale it up smooth
 * onto the main context. `bright` is how light the sky is, 0..1: pale air on a pale sky needs more
 * to be seen, and on a night sky less is plenty.
 */
export function paintFluid(ctx, small, f, w, h, { bright = 0, wind = 0 } = {}) {
  const strength = Math.min(1, Math.abs(wind) / 10);
  if (!small || strength < 0.03) return false;
  const sc = small.getContext('2d');
  if (!sc) return false;
  if (small.width !== f.nx || small.height !== f.ny) { small.width = f.nx; small.height = f.ny; }
  const img = sc.createImageData(f.nx, f.ny);
  const px = img.data;
  // opacity from the dye through a compressing curve: 1 - e^(-3.2d). The smoke thins to about a
  // third as it crosses (it spreads and mixes on a coarse grid), and a knee that hid thin smoke left
  // a dense wall at the upwind edge and nothing downstream; this keeps thin smoke visible and stops
  // the dense streams from dominating. The ceiling is lower on a dark sky, where pale is loud.
  const lit = Math.max(0, Math.min(1, bright));
  const peak = (82 + 46 * lit) * (0.65 + 0.35 * strength);
  for (let i = 0, j = 0; i < f.d.length; i++, j += 4) {
    const dv = Math.max(0, f.d[i] - 0.02);
    const a = peak * (1 - Math.exp(-3.2 * dv));
    px[j] = 228; px[j + 1] = 236; px[j + 2] = 250; px[j + 3] = a;
  }
  sc.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, f.nx, f.ny, 0, 0, w, h);
  return true;
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
