// THE GALAXY FLIGHT (operator, 2026-09-20: "add a new background type, in addition to the
// spiral galaxy, that is this sequence repeating infinitely travelling through the cosmos",
// pointing at NASA SVS 14950, "Flying Through Galaxies").
//
// A third sky beside the Galaxy and the Earth: the camera flies FORWARD through a line of
// spiral galaxies that recedes forever. Each galaxy is built the way the Galaxy sky's own
// spiral is -- stars laid on logarithmic arms around a bright bulge, carrying its own slow
// turn -- so what the camera passes is a real spinning spiral, not a blob. Each drifts from
// far and small to near and large, slides past, and wraps to the far end: the sequence is a
// closed ring, so the flight never ends. Stars stream past with the camera so the sky itself
// moves.
//
// SLOW BY DESIGN (operator, after the first cut: "We really need to slow it down, and show
// actual spinning rotating galaxies"): the travel is a drift, and the turn is the show --
// a galaxy takes the better part of a minute to pass and turns as it comes.
//
// It obeys the canvas rules the rest of the renderer lives by
// (test/viewer-canvas-rules.test.js): no clip, no globalAlpha, no composite modes, no
// shadowBlur -- and no gradients either, the way livingsky.js reads them. Every fill and
// stroke is a plain rgba.
//
// `drawGalaxyFlight` takes its helper from details3d as an argument (a drawStars bound to the
// canvas) rather than importing it, so the two files do not import each other, the same seam
// livingsky.js uses. Everything else here is pure and tested: the same seed always gives the
// same field, and the same clock reading always gives the same picture.

// ------------------------------------------------------------------- the field
/** A seeded hash in [0,1): the only randomness anywhere in this file. */
export function hash01(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export const FLIGHT_DEPTH = 30;          // z units of visible corridor
export const FLIGHT_NEAR = 0.55;         // culled nearer than this (it is past the wing by then)
export const FLIGHT_RATE = 0.03;         // z units per second at speed 1: a slow drift
const TINTS = Object.freeze([
  '255,244,214',   // warm old stars
  '214,228,255',   // blue-white young ones
  '255,224,196',   // amber
  '196,214,255',   // cold blue
]);

/**
 * One galaxy's stars, laid by the SAME maths the Galaxy sky lays them with (details3d.js
 * starField's galaxy branch): four arms winding as logarithmic spirals that TRAIL the disc's
 * turn, three populations -- warm bulge, blue-white arms, the faint field between the arms --
 * each with its own brightness. Polar coordinates around the disc; the galaxy TURNS by adding
 * its spin to `a` at draw time, so the arms rotate with the disc.
 */
export function galaxyStars(seed) {
  const h = (k) => hash01(seed * 131 + k);
  const stars = [];
  const ARMS = 4, TWIST = 0.30;
  const inner = 0.08;
  // the bulge: crowded, warm, at full brightness -- the middle on its own. It IS the core:
  // no painted ellipse could survive near sizes (they read as circles), a population cannot.
  for (let j = 0; j < 130; j++) {
    const a = h(190 + j) * Math.PI * 2, r = 0.26 * Math.sqrt(h(220 + j));
    stars.push({ a, r, b: 0.8 + h(250 + j) * 0.2, c: h(280 + j) < 0.55 ? '255,214,150' : '255,234,196' });
  }
  // the arms: young blue-white stars on logarithmic spirals, soft-edged and narrowing outward.
  // MANY of them -- the Galaxy sky's arms are a density contrast among thousands, and anything
  // less drowns (operator: "We've done so much amazing work on that; not being fully leveraged").
  for (let j = 0; j < 900; j++) {
    const t = Math.pow(h(100 + j), 0.62);
    const r = inner + (1 - inner) * t;
    const arm = Math.floor(h(110 + j) * ARMS) * ((Math.PI * 2) / ARMS);
    const width = 0.14 * (1.35 - 0.75 * r);
    const bell = h(120 + j) + h(121 + j) + h(122 + j) - 1.5;
    const a = arm + Math.log(r / inner) / TWIST + bell * width;
    const tint = h(130 + j);
    const glint = h(150 + j) < 0.012;
    const hz = glint ? s_haze(seed * 907 + j * 3).map((z) => ({ dx: z.dx * 1.6, dy: z.dy * 1.6, r: z.r, a: z.a * 0.9 })) : null;
    stars.push({ a, r, b: (0.85 - 0.25 * r) * (0.55 + h(140 + j) * 0.45), c: tint < 0.35 ? '160,198,255' : tint < 0.72 ? '205,224,255' : '242,246,255', glint, hz });
  }
  // between the arms: the faint field that keeps the disc from being a pinwheel on a void --
  // kept FEW and DIM next to the arms, so the arms carry the structure
  for (let j = 0; j < 140; j++) {
    const a = h(160 + j) * Math.PI * 2, r = 0.16 + 0.84 * h(170 + j);
    stars.push({ a, r, b: 0.3 * (0.4 + h(180 + j) * 0.4), c: '235,242,255' });
  }
  return stars;
}

/**
 * The nebulae of one galaxy: clouds of gas ON the arms, by the same logarithmic rule, in the
 * dusty magenta / cold blue / teal / warm rose of the Galaxy sky. Polar, so they turn with the
 * disc. Small counts -- these are drawn live, far smaller than the sky's baked layer.
 */
export function galaxyNebulae(seed) {
  const h = (k) => hash01(seed * 173 + k);
  const TINTS = ['142,88,214', '48,122,196', '58,168,156', '198,84,142'];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const t = 0.08 + 0.4 * h(1 + i * 20);
    const r = 0.08 + (1 - 0.08) * t;
    const arm = Math.floor(h(2 + i * 20) * 4) * (Math.PI / 2);
    const a = arm + Math.log(r / 0.08) / 0.30 + (h(3 + i * 20) - 0.5) * 0.5;
    const tint = TINTS[Math.floor(h(4 + i * 20) * TINTS.length)];
    const puffs = [];
    const n = 7 + Math.floor(h(5 + i * 20) * 5);
    for (let j = 0; j < n; j++) {
      puffs.push({
        dx: (h(10 + i * 20 + j) - 0.5) * 1.7,
        dy: (h(30 + i * 20 + j) - 0.5) * 1.2,
        rx: 0.14 + h(50 + i * 20 + j) * 0.2,        // share of the disc radius
        sq: 0.65 + h(70 + i * 20 + j) * 0.7,
        al: 0.05 + h(90 + i * 20 + j) * 0.06,
      });
    }
    out.push({ a, r, tint, puffs });
  }
  return out;
}

/**
 * The ring of galaxies: `count` of them spread over the corridor's depth, each with a lateral
 * and vertical place (shares of the half-width, kept modest so most stay near the flight path
 * and a few pass close), a size, a tilt and squash for the disc, a tint, its own spin rate and
 * phase, and the arm stars built above. Spread evenly in z with jitter -- evenly in z is what
 * makes the sequence read as a chain rather than a clump -- and the wrap below is what makes it
 * infinite.
 */
export function galaxyField(seed = 7, count = 5) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 101 + i * 17 + k);
    const u = (h(1) - 0.5) * 1.6;                       // lateral, shares of the half-width at z=1
    const v = (h(2) - 0.5) * 0.95;                      // vertical
    const z0 = ((i + h(3) * 0.8) / count) * FLIGHT_DEPTH + FLIGHT_NEAR;
    const size = 0.2 + h(4) * 0.16;                     // BIG: a spiral needs screen size to read
    const tilt = h(5) * Math.PI;
    const ratio = 0.16 + h(6) * 0.22;                   // SIDE-ON (operator, 2026-09-20): a disc
                                                        // seen from near its plane, not from above
    const tint = TINTS[Math.floor(h(7) * TINTS.length)];
    const core = 0.8 + h(8) * 0.6;
    // ARMS TRAIL (operator: "why are the flight galaxies spiraling clockwise? That goes
    // against astrophysics"): the arms wind outward in +theta, so the disc MUST turn in
    // -theta or the arms lead the rotation, which no disc galaxy does. One direction, no
    // random sign -- the Galaxy sky reached the same rule in 2026-09-12.
    const spinRate = -(0.045 + h(9) * 0.025); // SLOW but VISIBLE (operator: "aren't rotating any more" -- the last cut was too slow to perceive): a turn in a minute and a half to two and a half
    const spinPhase = h(13) * Math.PI * 2;
    const stars = galaxyStars(seed * 1000 + i);
    const nebulae = galaxyNebulae(seed * 1000 + i);
    out.push({ u, v, z0, size, tilt, ratio, tint, core, spinRate, spinPhase, stars, nebulae });
  }
  return out;
}

// one field and one streaming-star field per process: they carry no resolution and no time, so
// they are built once and shared; the projection below is where size and place come from
let FIELD = null;

/**
 * One galaxy at one moment, projected: the camera's `travel` in z units advances, the galaxy's
 * depth wraps over the corridor, and perspective maps its place to the panel. `z` is the wrapped
 * depth (so a test can hold the wrap), `vis` false when it is behind the near plane, off the
 * panel, or past the corridor's mouth.
 */
export function projectGalaxy(g, travel, pw, ph, at) {
  const span = FLIGHT_DEPTH;
  const raw = g.z0 - travel;
  // wrap into [FLIGHT_NEAR, FLIGHT_NEAR + span): the ring the flight goes round forever
  const z = FLIGHT_NEAR + (((raw - FLIGHT_NEAR) % span) + span) % span;
  const F = pw * 0.6;
  const vp = flightAt(pw, ph, at);
  const x = vp.x + (g.u * F) / z;
  const y = vp.y + (g.v * F) / z;
  const r = (g.size * F) / z;
  // vis with a GENEROUS margin (operator: "The spiral galaxies blink out of existence when they
  // hit the edge of the screen"): the arms and nebulae reach 1.25x the disc radius from the
  // centre, so a galaxy lives until 2.2 radii past the frame -- it leaves whole, or not at all.
  const vis = r > 1.5 && x > -r * 2.3 && x < pw + r * 2.3 && y > -r * 2.3 && y < ph + r * 2.3;
  return { x, y, r, z, vis };
}


// ------------------------------------------------------------------- the vanishing point
/**
 * WHERE the flight goes (operator, 2026-09-20: "Make an option to place the center point
 * either at the center as it currently is, or top left, top right, bottom left, bottom
 * right"): the vanishing point sits at the panel centre or in any corner. `at` is the same
 * vocabulary the Galaxy sky's galaxyAt speaks; the fractions match its placements.
 */
export function flightAt(pw, ph, at) {
  const T = {
    'center': [0.5, 0.5],
    'top-left': [0.18, 0.18],
    'top-right': [0.82, 0.18],
    'bottom-left': [0.18, 0.82],
    'bottom-right': [0.82, 0.82],
  }[at] ?? [0.5, 0.5];
  return { x: pw * T[0], y: ph * T[1] };
}

/** How bright a galaxy burns at depth z: near ones full, the corridor's far end still faintly there. */
export function flightFade(z) {
  const near = Math.min(1, 1.4 / z);                                   // perspective dimming
  const far = Math.max(0.12, Math.min(1, (FLIGHT_DEPTH + 3 - z) / 5)); // the mouth fades out
  // THE ENTRY FADE (operator, twice: "The galaxies blink in at a distance. They need to
  // slowly fade into view in the distance"): a galaxy that has just wrapped to the corridor's
  // far end rises from nothing over TWELVE z units -- two-fifths of the corridor -- so the
  // arrival takes minutes and is never a pop. It starts at literally zero.
  const enter = Math.max(0, Math.min(1, (FLIGHT_DEPTH - z) / 12));
  return near * far * enter * enter;                  // squared: gentler at the very start
}


/**
 * GAS SPECKS (operator, repeatedly: no stacked transparent circles, no ovals): the one way
 * gas is drawn in the flight -- a cloud of tiny grain specks heaped on the centre by a
 * gaussian. `n` specks, `R` the cloud radius in px, `alpha` the per-speck ceiling. Pure:
 * seeded, the same cloud every frame.
 */
function gasSpecks(ctx, x, y, R, tint, alpha, n, dpr, seed, fade, bright, pe) {
  for (let j = 0; j < n; j++) {
    const h = (k) => hash01(seed * 13.7 + j * 7.1 + k);
    const gx = (h(1) + h(2) + h(2)) / 3 - 0.5;
    const gy = (h(3) + h(4) + h(4)) / 3 - 0.5;
    const d = Math.hypot(gx, gy) * 2;
    const a = alpha * Math.max(0.1, 1 - d) * fade * bright;
    if (a <= 0.006) continue;
    const px = x + gx * 2.4 * R, py = y + gy * 2.0 * R;
    const pf = pe ? Math.min(pe(px), pe(pw2 - px), pe(py), pe(ph2 - py)) : 1;
    if (pf <= 0.02) continue;
    ctx.fillStyle = `rgba(${tint},${(a * pf).toFixed(4)})`;
    ctx.beginPath();
    ctx.arc(px, py, (0.35 + h(5) * 0.75) * (dpr || 1), 0, Math.PI * 2);
    ctx.fill();
  }
}
let pw2 = 0, ph2 = 0;   // the border-fade frame, set each draw

// ------------------------------------------------------------------- the streaming stars
/**
 * The stars that fly WITH the camera: a dense field in the same corridor as the galaxies,
 * wrapped by the same travel, so the whole sky streams past. These sit ON TOP of the board's
 * own static star field, which stays as the infinitely distant backdrop.
 */
/**
 * A star's haze: 7 tiny specks round its place, offsets fixed per star (seeded), radii and
 * distances varied. Drawn as grain -- the operator banned the stacked translucent circles.
 */
function s_haze(s) {
  const out = [];
  for (let j = 0; j < 7; j++) {
    const h = (k) => hash01(s * 17.3 + k);
    out.push({
      dx: (h(1) - 0.5) * 9,
      dy: (h(2) - 0.5) * 9,
      r: 0.3 + h(3) * 0.6,
      a: 0.10 + h(4) * 0.14,
    });
  }
  return out;
}

export function flightStars(seed = 11, count = 500) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 211 + i * 29 + k);
    out.push({
      u: (h(1) - 0.5) * 3.2,                       // near the flight path: these are the NEAR stars
      v: (h(2) - 0.5) * 2.1,
      z0: ((i + h(3)) / count) * FLIGHT_DEPTH + FLIGHT_NEAR,
      s: 0.45 + h(4) * 0.65,                        // brightness
      // TEMPERATURE (the Galaxy sky's star colours): a few warm, a few cool, most neutral --
      // so a star close up is coloured like a star, not a white dot
      tint: h(5) < 0.12 ? '255,226,180' : h(5) < 0.32 ? '180,205,255' : '235,242,255',
      // TWINKLE (operator: "add more twinkling stars in the flight sequence, just like The
      // Galaxy has twinkling stars in the spiral arms"): a third of the field twinkles, at the
      // Galaxy sky's own slow rates (a cycle every 10.5 to 39 seconds) with its own phase
      tw: h(6) < 0.75 ? 0.00016 + h(7) * 0.00044 : 0,
      tp: h(8) * Math.PI * 2,
      // HAZE, not a halo (operator: "ugly transparent halos around big stars... more
      // convincing haze"): a bright star carries a small cloud of tiny specks round it --
      // grain, the house style for gas -- offsets fixed per star
      haze: s_haze(seed * 31 + i * 3),
    });
  }
  return out;
}

/**
 * The DUST: an even, screen-space star field underneath the corridor stars. It moves RADIALLY
 * outward from the vanishing point (operator, 2026-09-20: "It's moving right to left. It needs
 * to move towards the viewer") -- each star has an angle and a radial phase; as the flight
 * advances the phase grows and the star slides outward, slowly at first and faster near the
 * edge, which is exactly how perspective reads. Wrapping at the edge keeps the coverage even
 * forever. `a` the angle, `p` the phase in [0,1) at travel 0.
 */
export function dustStars(seed = 23, count = 520) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 307 + i * 31 + k);
    out.push({
      a: h(1) * Math.PI * 2,
      p: h(2),
      s: 0.25 + h(3) * 0.75,                        // brightness
      r: 0.5 + h(4) * 0.9,                          // base dot radius in px at dpr 1
      // TWINKLE (operator: "more twinkling stars in the background"): over half the dust
      // field twinkles at the Galaxy sky's slow rates, phase per star
      tw: h(5) < 0.8 ? 0.00016 + h(6) * 0.00044 : 0,
      tp: h(7) * Math.PI * 2,
    });
  }
  return out;
}

let STARS3D = null;
let DUST = null;

// ------------------------------------------------------------------- the gas
// THE PALETTE IS NASA'S (operator: "You did a shitty job recreating the scene", after the
// reference was studied frame by frame): the fly-through's gas is DESATURATED slate gray-blue
// -- smoky, translucent, a depth layer rather than a coloured event. The saturated pink/teal
// of the first cut read as decoration; nothing in the reference is that vivid.
const GAS_TINTS = Object.freeze([
  '122,138,162',   // slate blue -- the reference's dominant wisp colour
  '104,118,140',   // deeper slate
  '140,150,168',   // pale smoke
  '96,104,124',    // charcoal-blue
]);

/**
 * The GAS of the flight, rebuilt from the reference: not discrete "clouds" but a handful of
 * long, curling FILAMENTS that weave across the whole corridor, the way the reference carries
 * smoke-like wisps in front of and behind the galaxy field. Each filament is a chain of soft
 * puffs along a wandering path (a seeded drift in direction), wide at the middle and tapering
 * at the ends -- a wisp, not a ball. They ride the same camera as everything else.
 */
export function gasField(seed = 31, count = 5) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 401 + i * 23 + k);
    const puffs = [];
    const n = 16 + Math.floor(h(1) * 10);        // a long chain, not a cluster
    let dx = h(2) * Math.PI * 2;                 // the path's heading, wandering as it goes
    let x = 0, y = 0;
    const step = 1.1;                            // spacing along the filament: OPEN, or the
                                                 // chain overlaps into a solid slab of haze
    for (let j = 0; j < n; j++) {
      dx += (h(10 + j) - 0.5) * 1.1;             // the curl: the heading wanders smoothly
      x += Math.cos(dx) * step;
      y += Math.sin(dx) * step * 0.6;
      const taper = Math.sin((j / (n - 1)) * Math.PI);   // wide in the middle, thin at the ends
      puffs.push({
        x, y,
        rx: (0.3 + h(50 + j) * 0.3) * (0.35 + 0.65 * taper),      // THIN: a wisp, not a blob
        sq: 0.5 + h(70 + j) * 0.45,
        a: (0.008 + h(90 + j) * 0.012) * (0.5 + 0.5 * taper),
      });
    }
    out.push({
      u: (h(3) - 0.5) * 2.8,
      v: (h(4) - 0.5) * 1.9,
      z0: ((i + h(5) * 0.9) / count) * FLIGHT_DEPTH + FLIGHT_NEAR,
      size: 0.55 + h(6) * 0.5,                     // filament scale at z=1, shares of the width
      spin: (h(7) - 0.5) * 0.6,                    // each wisp sits at its own angle
      tint: GAS_TINTS[Math.floor(h(8) * GAS_TINTS.length)],
      puffs,
    });
  }
  return out;
}

/**
 * The BANDS (operator: "We need the nebula bands like the video"): the reference also carries
 * broad veils -- very long, gently curved chains of large, very-dim puffs that cross the whole
 * corridor like sheets seen edge-on. Separate from the curling filaments; dimmer and wider.
 */
export function gasBands(seed = 71, count = 3) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 601 + i * 41 + k);
    const puffs = [];
    const n = 26 + Math.floor(h(1) * 8);
    let dx = h(2) * Math.PI * 2;
    let x = 0, y = 0;
    const step = 1.0;
    for (let j = 0; j < n; j++) {
      dx += (h(10 + j) - 0.5) * 0.28;            // a GENTLE curve: a band, not a curl
      x += Math.cos(dx) * step;
      y += Math.sin(dx) * step * 0.45;
      const taper = Math.sin((j / (n - 1)) * Math.PI);
      puffs.push({
        x, y,
        rx: (0.8 + h(50 + j) * 0.8) * (0.4 + 0.6 * taper),
        sq: 0.28 + h(70 + j) * 0.3,              // squashed: a sheet seen edge-on
        a: (0.012 + h(90 + j) * 0.014) * (0.4 + 0.6 * taper),
      });
    }
    out.push({
      u: (h(3) - 0.5) * 2.8,
      v: (h(4) - 0.5) * 1.9,
      // bands live in the NEAR half of the corridor: at depth the fade would erase them
      z0: NEAR_HALF_MIN + ((i + h(5) * 0.9) / count) * (FLIGHT_DEPTH - NEAR_HALF_MIN),
      size: 0.7 + h(6) * 0.6,
      spin: (h(7) - 0.5) * 0.9,
      tint: GAS_TINTS[Math.floor(h(8) * GAS_TINTS.length)],
      puffs,
    });
  }
  return out;
}

const NEAR_HALF_MIN = FLIGHT_NEAR + FLIGHT_DEPTH * 0.4;   // where the fade is strong enough

let GAS = null;
let BANDS = null;

// ------------------------------------------------------------------- the deep field
// THE DEEP FIELD (the reference's richest layer): a hundred-plus faint distant galaxies --
// warm elliptical smudges, thin edge-on slivers, tiny blue compacts, pink dwarfs -- carpeting
// the whole frame behind everything. THIS is what fills the reference's "empty" black with
// texture, and what our scene lacked (operator: "the galaxies are the only really interesting
// thing in view"). Static in the corridor (they are far); they do not stream.
export function deepField(seed = 47, count = 130) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 509 + i * 37 + k);
    const kind = h(1);
    out.push({
      u: h(2), v: h(3),                              // shares of the panel, fixed for life
      r: 2.5 + h(4) * 9,                             // radius in px at dpr 1
      kind: kind < 0.42 ? 'elliptical' : kind < 0.68 ? 'edgeon' : kind < 0.86 ? 'blue' : 'pink',
      rot: h(5) * Math.PI,
      b: 0.25 + h(6) * 0.55,
    });
  }
  return out;
}

let DEEP = null;

// ------------------------------------------------------------------- the milky way band
/**
 * THE BAND (operator: "the nebula bands, eg the Milky way, just like the reference video
 * has"): a broad diagonal swath across the whole frame -- a dense river of faint stars in a
 * soft slate haze -- like the band of our own galaxy thrown across a deep field. Static (it
 * is far), behind everything that moves. `angle` the band's direction, `width` its half-width
 * in shares of the panel diagonal; stars cluster toward the band's spine (gaussian-ish).
 */
export function milkyWay(seed = 59, count = 420) {
  const out = [];
  const angle = 0.5 + hash01(seed) * 0.4;             // a diagonal, never axis-aligned
  const ca = Math.cos(angle), sa = Math.sin(angle);
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 701 + i * 43 + k);
    const along = h(1) * 2.6 - 1.3;                   // along the band, past both corners
    const across = (h(2) + h(2) + h(2) + h(2) + h(2) + h(2)) / 6 - 0.5;   // heaped hard on the spine
    const u = 0.5 + along * ca * 0.5 - across * sa * 0.30;
    const v = 0.5 + along * sa * 0.5 + across * ca * 0.30;
    out.push({
      x: Math.max(-0.02, Math.min(1.02, u)),
      y: Math.max(-0.02, Math.min(1.02, v)),
      r: 0.5 + h(3) * 1.5,                            // px at dpr 1
      s: 0.35 + h(4) * 0.65,
      // twinkling: the band shimmers (operator: "twinkling stars ... across The Flight")
      tw: h(5) < 0.6 ? 0.00016 + h(6) * 0.00044 : 0,
      tp: h(7) * Math.PI * 2,
      rot: h(10) * Math.PI,
    });
  }
  return out;
}

let MILKY = null;

// ------------------------------------------------------------------- the nebula patches
/**
 * THE NEBULA PATCHES (operator: "Can't we use nebula or other gas effects for the milky-way
 * band? ... not seeing enough on the left side with the vanishing point in top right"): the
 * corridor gas clusters at the vanishing point by perspective, so whole regions never see gas.
 * These patches are SCREEN-SPACE and STATIC -- clouds of TINY SPECKS (operator: "fucking
 * overlapping ovals again and not gas clouds": no ellipse survives this test; a cloud is made
 * of grain, the way the wind and the band haze are). Each patch is 200-odd specks heaped on
 * its centre by a gaussian, spread over the whole panel and weighted AWAY from the vanishing
 * point, so the far half of the frame carries gas too.
 */
export function nebulaPatches(seed = 83, count = 20, vp = { x: 0.82, y: 0.18 }) {
  const out = [];
  // the direction AWAY from the vanishing point: patches heap on that side of the frame,
  // because perspective crowds the corridor gas round the vanishing point already
  const ax = 1 - vp.x, ay = 1 - vp.y;
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 907 + i * 53 + k);
    const t = h(2);
    // from near the vp out toward the far side: every patch on the vp->away diagonal,
    // spread broadly, so the far half is rich and the near half still carries some
    const cx = Math.max(0.03, Math.min(0.97, vp.x + (ax - vp.x) * t + (h(3) - 0.5) * 0.34));
    const cy = Math.max(0.03, Math.min(0.97, vp.y + (ay - vp.y) * t + (h(4) - 0.5) * 0.34));
    const R = 26 + h(5) * 70;                       // patch radius, px at dpr 1
    const tint = GAS_TINTS[Math.floor(h(7) * GAS_TINTS.length)];
    const n = 120 + Math.floor(h(8) * 120);
    const specks = [];
    for (let j = 0; j < n; j++) {
      // a gaussian heap: three averaged draws pile the specks on the centre
      const gx = (h(20 + j) + h(40 + j) + h(60 + j)) / 3 - 0.5;
      const gy = (h(80 + j) + h(100 + j) + h(120 + j)) / 3 - 0.5;
      const d = Math.hypot(gx, gy) * 2;             // 0 at the centre, ~1 at the rim
      specks.push({
        dx: gx * 2.6 * R,
        dy: gy * 2.0 * R,
        r: 0.35 + h(140 + j) * 0.75,                // TINY: grain, never a dot
        a: (0.10 + h(160 + j) * 0.12) * Math.max(0.15, 1 - d),
      });
    }
    out.push({ cx, cy, R, tint, specks });
  }
  return out;
}

let PATCHES = null;


// THE BAND'S HAZE IS DOTS, NOT ELLIPSES (operator: "the milky way looks like shitty ovals
// overlapping"): any translucent ellipse is an oval, and overlapping ovals are still ovals.
// So the band's gas is a NOISE FIELD sampled into hundreds of tiny specks: a smooth value
// field (sine mixtures, pure and seeded) says where the gas is dense, and the specks pile up
// there. Density is the picture -- the same principle the pulsar wind's 27000 particles live by.
export function bandHaze(seed = 61, count = 15000) {
  const angle = 0.5 + hash01(seed) * 0.4;             // matches milkyWay's spine direction
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = (k) => hash01(seed * 809 + i * 47 + k);
    const along = h(1) * 2.6 - 1.3;
    const across = (h(2) + h(2) + h(2) + h(2) + h(2) + h(2)) / 6 - 0.5;
    const u = 0.5 + along * ca * 0.5 - across * sa * 0.30;
    const v = 0.5 + along * sa * 0.5 + across * ca * 0.30;
    // the gas field at this speck's place: smooth sine mixtures, same value every time
    const n = 0.5
      + 0.28 * Math.sin(u * 9.1 + v * 4.3 + 1.7)
      + 0.22 * Math.sin(u * 4.7 - v * 11.3 + 0.6)
      + 0.18 * Math.sin(u * 15.7 + v * 8.9 + 2.9);
    if (n < 0.45) continue;                           // the field culls its own specks
    out.push({
      x: Math.max(-0.02, Math.min(1.02, u)),
      y: Math.max(-0.02, Math.min(1.02, v)),
      r: 0.4 + h(3) * 0.55,                           // TINY (operator: "fucking large dots"): a
                                                      // speck is grain, never a dot
      a: (n - 0.45) * 0.9,                            // low alpha; density does the work
      tw: h(4) < 0.3 ? 0.00016 + h(5) * 0.00044 : 0,
      tp: h(6) * Math.PI * 2,
    });
  }
  return out;
}

let HAZE = null;



/** One streaming star, projected by the same camera as the galaxies. */
function projectStar(s, travel, pw, ph, at) {
  const span = FLIGHT_DEPTH;
  const z = FLIGHT_NEAR + (((s.z0 - travel - FLIGHT_NEAR) % span) + span) % span;
  const F = pw * 0.6;
  const vp = flightAt(pw, ph, at);
  return { x: vp.x + (s.u * F) / z, y: vp.y + (s.v * F) / z, z };
}

// ------------------------------------------------------------------- the draw
/**
 * The flight sky. The board's own star field (drawStars, handed in from details3d) stands
 * behind as the infinitely distant backdrop; streaming stars and then the galaxies fly over
 * it, far ones first so a near one passes in front. `opts.flightSpeed` scales the camera: 1 is
 * the shipped drift, 0 holds the picture still.
 */
export function drawGalaxyFlight(ctx, pw, ph, dpr, now, opts = {}, helpers = {}) {
  if (!FIELD) FIELD = galaxyField(7, 8);
  if (!STARS3D) STARS3D = flightStars(11, 950);
  if (!DUST) DUST = dustStars(23, 950);
  if (!GAS) GAS = gasField(31, 6);
  if (!BANDS) BANDS = gasBands(71, 3);
  if (!DEEP) DEEP = deepField(47, 130);
  if (!MILKY) MILKY = milkyWay(59, 420);
  if (!HAZE) HAZE = bandHaze(61, 15000);
  const at = opts.flightAt;                    // where the flight goes: centre or a corner
  if (!PATCHES) PATCHES = nebulaPatches(83, 20, flightAt(pw, ph, at));
  // NO static backdrop here (operator, 2026-09-20: "the background stars are not moving at
  // all"): the board's own star field never moves, and under a flight it reads as a frozen
  // sky. The streaming field IS the sky -- every star in it travels with the camera and wraps,
  // so everything moves.
  const speed = Number.isFinite(opts.flightSpeed) ? Math.max(0, opts.flightSpeed) : 1;
  const bright = Number.isFinite(opts.starBrightness) ? Math.min(1.5, Math.max(0, opts.starBrightness)) : 1;
  const travel = (now / 1000) * FLIGHT_RATE * speed;   // z units of camera travel
  pw2 = pw; ph2 = ph;

  // THE DEEP FIELD, first of all: the carpet of faint distant galaxies -- warm ellipticals,
  // edge-on slivers, blue compacts, pink dwarfs -- that fills the reference's frame with
  // texture. Barely-there alphas; it is depth, not events. NO sideways drift (operator:
  // "Shit is scrolling right to left"): the reference's distant field is STATIC -- it is far
  // enough that forward flight barely moves it. The near layers carry all the motion.
  for (let di = 0; di < DEEP.length; di++) {
    const d = DEEP[di];
    const x = d.u * pw;
    const y = d.v * ph;
    const a = d.b * 0.85 * bright;
    if (d.kind === 'elliptical') {
      // a warm smudge: grain (operator banned stacked ellipses), a scaled speck cloud
      gasSpecks(ctx, x, y, d.r * 1.6, '228,206,168', a, 14, dpr, 500 + di, 1, bright, null);
    } else if (d.kind === 'edgeon') {
      // a thin sliver: one long thin ellipse, one tiny core dot (no stacked pair)
      ctx.fillStyle = `rgba(224,204,178,${(a * 0.4).toFixed(4)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, d.r * 2.1, d.r * 0.24, d.rot, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,238,205,${(a * 0.55).toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(x, y, d.r * 0.28 * (dpr || 1), 0, Math.PI * 2);
      ctx.fill();
    } else {
      // blue compact or pink dwarf: a single soft dot with a grain fringe (no ring stacks)
      const tint = d.kind === 'blue' ? '158,188,255' : '255,168,200';
      gasSpecks(ctx, x, y, d.r * 1.5, tint, a, 10, dpr, 700 + di, 1, bright, null);
      ctx.fillStyle = `rgba(${tint},${Math.min(1, a * 1.2).toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(x, y, d.r * 0.55 * (dpr || 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const spinClock = speed > 0 ? now * (0.55 + 0.45 * speed) : 12000;   // speed 0 holds the
  // picture; at speed the whole scene runs faster -- the spin TOO (operator, at speed 4: "the
  // galaxies did not rotate": the spin was pegged to wall time and ignored the throttle)

  // THE NEBULA PATCHES: clouds of tiny slate specks spread over the WHOLE frame, weighted
  // away from the vanishing point -- the far half of the sky carries gas too (operator's ask).
  for (const np of PATCHES) {
    const cx = np.cx * pw, cy = np.cy * ph;
    for (const s of np.specks) {
      const px = cx + s.dx, py = cy + s.dy;
      // the same border fade the other gas wears: a speck dims out smoothly at the frame
      const fall = Math.max(s.r * 2, 30);
      const pe = (d) => Math.max(0, Math.min(1, d / fall));
      const puffFade = Math.min(pe(px), pe(pw - px), pe(py), pe(ph - py));
      const a = s.a * bright * puffFade;
      if (a <= 0.008) continue;
      ctx.fillStyle = `rgba(${np.tint},${a.toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(px, py, s.r * (dpr || 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // THE BAND, before everything: a diagonal Milky Way of dense faint stars in slate haze,
  // static and far, the backdrop the reference carries behind its moving field. Twinkling.
  {
    const ca = Math.cos(0.7), sa = Math.sin(0.7);   // unused here; per-star rot only
    // the gas specks first: hundreds of tiny slate dots piled where the noise field is dense
  for (const s of HAZE) {
    let a = s.a * 0.55 * bright;
    if (s.tw) a *= 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(spinClock * s.tw + s.tp));
    if (a <= 0.012) continue;
    ctx.fillStyle = `rgba(122,136,160,${a.toFixed(4)})`;
    ctx.beginPath();
    ctx.arc(s.x * pw, s.y * ph, s.r * (dpr || 1), 0, Math.PI * 2);
    ctx.fill();
  }
  for (const m of MILKY) {
      const x = m.x * pw, y = m.y * ph;
      let a = m.s * 0.8 * bright;
      if (m.tw) a *= 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(spinClock * m.tw + m.tp));   // bright swing
      if (a <= 0.02) continue;
      ctx.fillStyle = `rgba(235,240,255,${Math.min(1, a * 1.3).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(x, y, m.r * (dpr || 1), 0, Math.PI * 2); ctx.fill();
    }
  }
  // THE DUST, first and lowest: an even screen-space star field streaming RADIALLY outward
  // from the vanishing point -- towards the viewer, like everything else in the sky. The
  // squared phase makes a star slow near the centre and fast at the edge, which is what
  // perspective looks like. NO POP AT THE WRAP (operator: "shit is still blinking out at the
  // edges"): a star's alpha is wrapped in a smooth envelope -- it fades out as it reaches the
  // frame's edge and fades back in as it is reborn at the centre, so nothing ever blinks.
  const vp = flightAt(pw, ph, at);
  const half = Math.hypot(pw, ph) / 2;
  for (const d of DUST) {
    const phase = ((d.p + travel * 0.05 * speed) % 1 + 1) % 1;
    const rad = phase * phase;                   // slow out of the centre, fast at the edge
    const x = vp.x + Math.cos(d.a) * rad * half;
    const y = vp.y + Math.sin(d.a) * rad * half;
    const env = Math.min(1, Math.min(phase, 1 - phase) * 5);   // the no-blink envelope
    let a = Math.min(1, d.s * (0.3 + 0.7 * phase) * env * bright);
    if (d.tw) a *= 0.3 + 0.9 * (0.5 + 0.5 * Math.sin(spinClock * d.tw + d.tp));   // swings both ways
    if (a <= 0.01) continue;
    // one clean dot (operator banned stacked translucent circles: no halo pair here)
    ctx.fillStyle = `rgba(220,228,248,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, d.r * (0.5 + phase) * (dpr || 1), 0, Math.PI * 2);
    ctx.fill();
  }
  // THE STREAMING SKY, over the dust: the same corridor, the same camera, so the near sky
  // rushes past. Plain round dots (operator, 2026-09-20, on the streaks: "What are the
  // lines supposed to be?") -- the motion reads from the field moving, not from smears.
  // CLOSE-UP QUALITY (operator: "The stars close up look like boring fucking dots"): each
  // star wears the Galaxy sky's temperature tints, and the bright ones carry the halo --
  // core under two wide dim rings -- so a near star is a STAR, not a dot. The same smooth
  // wrap envelope as the dust: a star fades out at the near plane and is reborn far away.
  for (const s of STARS3D) {
    const p = projectStar(s, travel, pw, ph, at);
    const born = (p.z - FLIGHT_NEAR) / FLIGHT_DEPTH;          // 0 at the near plane, 1 at the far
    const env = Math.min(1, Math.min(born, 1 - born) * 6);
    let fade = flightFade(p.z) * bright * s.s * Math.max(0, env);
    if (s.tw) fade *= 0.3 + 0.9 * (0.5 + 0.5 * Math.sin(spinClock * s.tw + s.tp));   // the twinkle swings BOTH ways: dimmer and BRIGHTER than base
    if (fade <= 0.01) continue;
    if (p.x < -6 || p.x > pw + 6 || p.y < -6 || p.y > ph + 6) continue;
    const q = Math.max(0.7, Math.min(1.6, 1.2 / p.z));
    const tint = s.tint;
    if (s.s > 0.88) {
      // a bright one wears its grain cloud (operator: "ugly transparent halos... more
      // convincing haze"): tiny specks round the core, fixed per star -- no stacked rings
      for (const hz of s.haze) {
        ctx.fillStyle = `rgba(${tint},${(fade * hz.a).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(p.x + hz.dx / p.z * 4, p.y + hz.dy / p.z * 4, hz.r * (dpr || 1), 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, fade * 1.2).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, q, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = `rgba(${tint},${Math.min(1, fade).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, q, 0, Math.PI * 2); ctx.fill();
    }
  }
  // THE GAS, between the stars and the galaxies: smoky slate filaments riding the same camera,
  // far wisps first. Faint -- in the reference the gas is a depth layer, never an event.
  // Filaments near the camera are CAPPED (the first near pass drew a giant teal haze): a wisp
  // close enough to fill the frame is behind the viewer, not in front of them.
  const gas = [];
  for (const c of [...GAS, ...BANDS]) {
    const p = projectStar(c, travel, pw, ph, at);
    let r = (c.size * pw * 0.6) / p.z;
    if (r < 4) continue;
    if (r > 90) continue;                        // too near: it would be a haze, not a wisp
    // a filament spans ~n*step*r from its centre, so it lives until well past the frame
    if (p.x < -r * 3.4 || p.x > pw + r * 3.4 || p.y < -r * 3.4 || p.y > ph + r * 3.4) continue;
    gas.push({ c, p, r });
  }
  gas.sort((a, b) => b.p.z - a.p.z);
  for (const { c, p, r } of gas) {
    const fade = flightFade(p.z) * bright;
    if (fade <= 0.02) continue;
    // EDGE FADE, PER PUFF (operator: "the nebula gasses need to dim out as they approach the
    // edges. Their transition needs improvement"): a whole-cloud factor cannot do it -- a big
    // cloud's centre sits far inside the frame while its puffs cross the border, so the cloud
    // factor is 1 and the puffs hard-clip. Each puff is dimmed by ITS OWN distance to every
    // border: a puff whose own extent touches a border is already fading, smoothly, and the
    // cloud dissolves from its edge inward exactly as gas should.
    const f2fade = fade;
    // WRAP ENVELOPE, same as the stars': the cloud dims as its cycle ends and is reborn dim
    const born = (p.z - FLIGHT_NEAR) / FLIGHT_DEPTH;
    const env = Math.max(0, Math.min(1, Math.min(born, 1 - born) * 4));
    if (fade * env <= 0.01) continue;
    // SOFT PUFFS along the filament, each now a SPECK CLOUD (operator: no stacked ellipses,
    // no ovals -- gas is grain): each puff scatters its own tiny specks, heaped on the centre
    const csf = Math.cos(c.spin), snf = Math.sin(c.spin);
    for (const pf of c.puffs) {
      const lx = pf.x * r, ly = pf.y * r;
      const px = p.x + lx * csf - ly * snf, py = p.y + lx * snf + ly * csf;
      const pr = pf.rx * r * 0.8;
      const fall = Math.max(pr * 1.2, 40);
      const pe = (d) => Math.max(0, Math.min(1, d / fall));
      const puffFade = Math.min(pe(px), pe(pw - px), pe(py), pe(ph - py));
      const pfA = pf.a * f2fade * env * puffFade;
      if (pfA <= 0.002) continue;
      gasSpecks(ctx, px, py, pr, c.tint, pfA * 3.2, 22, dpr, 900 + Math.round(pf.x * 97) + Math.round(pf.y * 53), fade, bright, null);
    }
  }
  const draw = [];
  for (const g of FIELD) {
    const p = projectGalaxy(g, travel, pw, ph, at);
    if (p.vis) draw.push({ g, p });
  }
  draw.sort((a, b) => b.p.z - a.p.z);          // far first, near last
  for (const { g, p } of draw) {
    const fade = flightFade(p.z) * bright;
    // EDGE FADE (operator: "The center needs to move 2/3's off the screen, and then slowly
    // start to fade out"): the galaxy burns at FULL brightness while its centre is anywhere
    // on the panel, and keeps burning until the centre has passed the border by two-thirds
    // of the disc radius; only then does a slow fade begin, over one-and-a-half radii.
    const off = 0.66 * p.r;                       // how far past the edge before the fade starts
    const fall = 1.5 * p.r;                       // the fade's length
    const e = (d) => Math.max(0, Math.min(1, (d + off) / fall));
    const edge = Math.min(
      e(p.x), e(pw - p.x),
      e(p.y), e(ph - p.y),
    );
    const fade2 = fade * Math.max(0, Math.min(1, edge));
    if (fade2 <= 0.01) continue;
    const cs = Math.cos(g.tilt), sn = Math.sin(g.tilt);
    const spin = spinClock / 1000 * g.spinRate + g.spinPhase;
    // TOO SMALL TO BE A SPIRAL (operator, on the first distant pass: the far galaxies drew
    // their arm specks as sub-pixel squiggles): below ~14 px of disc radius a galaxy is an
    // object, not a structure -- a soft elliptical smudge with a bright core, like the Galaxy
    // sky's distant galaxies. The spiral only starts when there is room for it.
    if (p.r < 14) {
      // the distant smudge, cross-faded against the structured draw: its alpha falls as the
      // disc approaches the 14px threshold, so the handoff to arms is invisible
      const k = Math.max(0, Math.min(1, (14 - p.r) / 5));
      ctx.fillStyle = `rgba(${g.tint},${(0.3 * fade2 * k).toFixed(4)})`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r * 1.4, p.r * 1.4 * g.ratio, g.tilt, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,248,230,${(0.55 * fade2 * k).toFixed(4)})`;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, Math.max(0.8, p.r * 0.3), Math.max(0.6, p.r * 0.22), g.tilt, 0, Math.PI * 2);
      ctx.fill();
      // the structured layers already show faintly through the last few px of approach
      if (k < 1) {
        const f3 = fade2 * (1 - k);
        ctx.fillStyle = `rgba(${g.tint},${(0.06 * f3).toFixed(4)})`;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.r * 0.62, p.r * 0.62 * g.ratio, g.tilt, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    // NO PAINTED CORE, NO HAZE RINGS (operator: "the spiral galaxies in the flight have
    // fucking circles in the middle of them"): painted ellipses are always circles in the end.
    // The Galaxy sky's bulge is a POPULATION -- crowded warm stars -- and that is what the
    // middle is here too: the bulge stars below carry it.
    // THE ARMS: the galaxy's own stars, turned by its spin, squashed and turned by the tilt.
    // The same stars every frame -- they carry the arms, so the spiral visibly rotates. Each
    // star wears the colour of its population: warm bulge, blue-white arms, faint field.
    for (const s of g.stars) {
      const a = s.a + spin;
      const lx = Math.cos(a) * s.r * p.r * 1.25;
      const ly = Math.sin(a) * s.r * p.r * g.ratio * 1.25;
      const dx = lx * cs - ly * sn;
      const dy = lx * sn + ly * cs;
      // ONE dot, sized against aliasing (the old two-fill halo ring read as a stacked
      // transparent circle -- operator, twice): slightly larger, still one fill
      const q = Math.max(0.8, Math.min(1.8, p.r * 0.024));
      ctx.fillStyle = `rgba(${s.c},${Math.min(1, s.b * fade2).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x + dx, p.y + dy, q, 0, Math.PI * 2);
      ctx.fill();
    }
    // THE NEBULAE, on the arms, turned with the disc: the gas that gives a spiral its colour,
    // puffed the way the corridor gas is -- three stacked fills a puff, no hard circle edges
    for (const n of g.nebulae) {
      const a = n.a + spin;
      const nx0 = Math.cos(a) * n.r * p.r * 1.25;
      const ny0 = Math.sin(a) * n.r * p.r * g.ratio * 1.25;
      const nx = p.x + nx0 * cs - ny0 * sn;
      const ny = p.y + nx0 * sn + ny0 * cs;
      for (const pf of n.puffs) {
        // CAPPED (operator: the near galaxy painted a giant teal haze): a nebula puff grows
        // with the disc only up to a sane screen size -- beyond that it is a featureless wash
        const pr = Math.min(pf.rx * p.r, 26);
        const pxn = nx + pf.dx * p.r * 0.3, pyn = ny + pf.dy * p.r * 0.3;
        const fall = Math.max(pr * 1.2, 40);
        const pe = (d) => Math.max(0, Math.min(1, d / fall));
        const puffFade = Math.min(pe(pxn), pe(pw - pxn), pe(pyn), pe(ph - pyn));
        // dimmer as the galaxy grows: at arm-star scale the nebulae are knots, not veils
        const knot = Math.min(1, 40 / p.r);
        // three stacked fills, wide-dim to small-bright: the soft-puff shape the gas wears
        for (const [k, w] of [[1, 0.4], [0.62, 0.55], [0.32, 0.8]]) {
          const nA = pf.al * fade2 * w * puffFade * knot;
          if (nA <= 0.002) continue;
          ctx.fillStyle = `rgba(${n.tint},${nA.toFixed(4)})`;
          ctx.beginPath();
          ctx.ellipse(pxn, pyn, pr * (1 / k), pr * pf.sq * (1 / k), 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    // GLINT STARS (the Galaxy sky's halo treatment, NOT a cross -- operator: "The star glints
    // look like + signs when near"): a glint star is a small core under two wide, dim halos,
    // which reads as a bright star without ever drawing a line.
    if (p.r > 40) {
      for (const s of g.stars) {
        if (!s.glint) continue;
        const a = s.a + spin;
        const lx = Math.cos(a) * s.r * p.r * 1.25;
        const ly = Math.sin(a) * s.r * p.r * g.ratio * 1.25;
        const dx = lx * cs - ly * sn;
        const dy = lx * sn + ly * cs;
        const gx = p.x + dx, gy = p.y + dy;
        const q = Math.max(0.8, Math.min(2.2, p.r * 0.022));
        // the glow is GRAIN (operator banned the stacked translucent circles): tiny specks
        // round the core, fixed per glint star (s.hz built in galaxyStars)
        for (const hz of s.hz) {
          ctx.fillStyle = `rgba(255,255,255,${(fade2 * hz.a).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(gx + hz.dx, gy + hz.dy, hz.r * (dpr || 1), 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = `rgba(255,255,255,${Math.min(1, fade2).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(gx, gy, q, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}
