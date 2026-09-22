// THE FORMATION, GPU LAYER v3 (2026-09-21; operator, with the film in front of them: "We need to
// dramatically improve the formation background display. It looks nothing like the reference
// material in the video ... The main background with the pinks, purples, oranges, not the inset
// panel effects").
//
// v1 and v2 were PARTICLES -- forty thousand specks, then six thousand cloud sprites -- coloured
// cobalt and steel, because that is what I guessed a gas simulation looks like. The film (RAS /
// TNG50, "Formation of a single massive galaxy through time") is not particles and is not blue. Its
// main view is a continuous GAS DENSITY FIELD drawn through a magma colour ramp: black where there
// is nothing, deep violet where the gas is thin, magenta, then orange where it is dense, and a pale
// yellow-white only at the galaxy itself. A vast soft halo fills the frame, full of turbulent wisps;
// brighter streams run in toward the middle along the cosmic web's filaments; the galaxy at the
// centre is small, white-hot and visibly a spiral, turning; and satellite clumps -- each a little
// knot of orange in its own haze -- fall in and merge.
//
// So this version is a FIELD, evaluated per pixel in one fragment shader over one full-screen
// triangle. Density is a sum of what the film shows:
//   the halo       a broad soft envelope that grows as the galaxy assembles
//   the wisps      ridged noise through a domain warp that drifts: the turbulence in the halo
//   the streams    the same noise stretched ALONG the radius (sampled at direction * r^0.35), so
//                  it reads as filaments pointing at the centre, sliding inward with time
//   the galaxy     a tilted disc: log-spiral arms turning at their own rate, and a hard core
//   satellites     knots on decaying spiral orbits, stretched along their motion, each gone when
//                  it reaches the middle (and the core brightens as it arrives)
// and colour is `magma(tone(density))`, nothing else: there is no lighting, as there is none in
// the film. It is drawn at a capped pixel count (FORM_MAX_PIXELS) and stretched by CSS -- the
// picture is soft by nature, and a Retina panel at full size would be thirty noise lookups for
// each of five million pixels.
//
// The loop (FORM_CYCLE, the fade at both ends, the hold at speed 0) is galform.js's, which remains
// the fallback where there is no WebGL2. Math.random stays banned; the same `now` paints the same
// frame. Canvas-rules note: the 2D-context bans do not apply to a WEBGL context.

// ------------------------------------------------------------------- the constants
export const FORM_CONST = Object.freeze({
  FORM_CYCLE: 140,            // galform.js FORM_CYCLE: the fallback's loop, and here the time base of the spiral's turning
  FORM_HOLD: 0.86,            // where speed 0 holds (galform.js FORM_HOLD)
  HALO_R0: 0.8,              // the halo's reach at the start, in half-panel units...
  HALO_R1: 1.25,              // ...and at the end: the gas the galaxy has gathered fills the frame
  GALAXY_R0: 0.03,           // the disc's radius at the start...
  GALAXY_R1: 0.11,           // ...and grown
  GALAXY_TILT: -0.32,         // galform.js FORM_TILT
  GALAXY_SQUASH: 0.62,        // how flat the tilted disc is seen
  ARMS: 2,
  ARM_WIND: 5.5,              // how tightly the log-spiral winds
  SPIN: 4,                    // turns of the spiral PATTERN a loop (rigid: a differential turn wound the arms into rings)
  STREAM_POW: 0.6,           // r^this: how hard the stream noise is stretched along the radius
  INFLOW: 0.55,               // how far the streams slide inward over a loop
  SATELLITES: 5,
  WIDE: 0.92,                 // the halo is as wide as the PANEL: its reach across is this share of the panel's aspect
  TURB: 0.30,                 // rad/s the small-scale jostle circles at: the gas is turbulent, not just carried
  TURB_AMP: 0.055,            // ...and how far it throws a filament, in half-panel units
  RUN: 4.5,                   // how far the clumps run down a stream over one flow life (noise cells)
  BURST_PERIOD: 9,            // seconds between a galaxy's outbursts: shells of hot gas blown out and fading
  WAKE: 14,                   // samples of a satellite's own past, drawn as the gas stripped off it
  WAKE_STEP: 0.026,           // how far back each sample is, as a share of the satellite's life
  SAT_LIFE: 78,               // seconds a satellite takes from the edge to the merger, give or take a third
  SAT_R0: 1.45,               // where a life begins, in half-panel units: beyond the frame's edge, so it DRIFTS in
  SAT_HAZE_IN: 0.45,          // the share of its life over which its gas cloud fades up...
  SAT_KNOT_IN: 0.60,          // ...and by when the bright knot has condensed out of that cloud
  STIR: 1.6,                  // how hard a satellite turns the gas round itself as it passes...
  DRAG: 1.1,                  // ...and how far it drags the gas along its own path
  BREATHE: 300,               // seconds of the galaxy's slow swell and ebb, now that nothing resets it
  FLOW_PERIOD: 17,            // seconds a flow layer lives: drawn in and swirled, then faded out as the next fades in
  FLOW_PULL: 0.85,            // how far in a layer is drawn over its life (features end at e^-this of their radius)
  FLOW_SWIRL: 1.5,            // radians a layer is turned at the middle over its life, falling off with radius
  FLOW_CHURN: 0.011,          // how fast the warp itself evolves, per second: the filaments writhe, they do not slide
  ZOOM0: 0.86,                // the slow push-in over the loop
  ZOOM1: 1.12,
});
/**
 * WHERE THE GALAXY SITS (operator, 2026-09-21: "We need to be able to put the formation center either in
 * the center like it is now, or the corners like the other options"): the Galaxy sky's own five places
 * and its own fractions of the panel (details3d GALAXY_PLACEMENTS), and how much bigger the whole scene
 * is drawn there -- in a corner the halo has the panel's full diagonal to reach across, and at its
 * centred size it would leave the far half of the panel empty.
 */
export const FORM_PLACEMENTS = Object.freeze({
  'center': [0.50, 0.50, 1.0],
  'top-left': [0.22, 0.22, 1.55],
  'top-right': [0.78, 0.22, 1.55],
  'bottom-left': [0.22, 0.78, 1.55],
  'bottom-right': [0.78, 0.78, 1.55],
});
export const FORM_AT_DEFAULT = 'bottom-left';            // (operator, 2026-09-22: "make formation the default 3d background view for markets. default position bottom left"; top-left before, also the operator's own choice, as are the three defaults below: settings.js)
/** How bright it ships (sky.formBrightness): 1, the full picture. In magma that threatened to overpower the chart and
 * shipped at 0.8; in the blues it does not (the operator's own setting, 2026-09-22). */
export const FORM_BRIGHTNESS_DEFAULT = 1;
/** The gas's pace and the galaxy's, as shipped (sky.formFlow, sky.formSpeed). */
export const FORM_FLOW_DEFAULT = 0.5;
export const FORM_SPEED_DEFAULT = 0.4;

/**
 * THE FILM'S COLOUR RAMP, once: black, indigo, violet, magenta, salmon, orange, pale yellow -- [where
 * on the ramp, [r, g, b] 0..1]. The shader's magma() is GENERATED from this, and the 2D fallback
 * (galform.js) tints its specks through formRamp(), so the two engines cannot drift apart in colour.
 */
const RAMP_T = [0.00, 0.14, 0.34, 0.54, 0.70, 0.85, 1.00];
const ramp = (...rgb) => Object.freeze(rgb.map((c, i) => Object.freeze([RAMP_T[i], Object.freeze(c.map((v) => v / 255))])));
/**
 * THE PALETTES (operator, 2026-09-21: "Suggest a dozen different color schemes we can use for the galaxy
 * formation, in addition to the current default. Make sure it doesn't clash with the chart too badly. The
 * chart is the most important visual"). Seven stops each, at the same places on the ramp: nothing, thin
 * gas, gas, dense gas, denser, the densest gas there is (gas tops out HERE, at 0.85), and the pale end
 * that only the galaxy and the satellites' knots reach.
 *
 * WHAT THE CHART IS: candles #1fc98a and #ef4d5e (wicks mint and pink), and a yellow neon line (255,236,70).
 * So a palette is judged by how far its GAS stays from those three at a similar lightness, and by how
 * bright its gas gets at all -- scripts/form-palettes.mjs measures both. The shipped magma is the film's,
 * and it is the WORST of these for the chart: its dense gas is the candles' red and the line's orange.
 */
export const FORM_PALETTES = Object.freeze({
  magma: ramp([0, 0, 0], [19, 8, 56], [66, 22, 122], [143, 41, 133], [219, 77, 102], [251, 143, 84], [255, 240, 199]),      // the film's own
  abyss: ramp([0, 0, 0], [4, 12, 40], [8, 32, 88], [16, 66, 140], [36, 110, 182], [84, 158, 214], [214, 238, 255]),       // deep ocean blues
  ultraviolet: ramp([0, 0, 0], [16, 6, 46], [44, 18, 104], [84, 40, 156], [126, 72, 192], [168, 120, 222], [236, 222, 255]), // indigo to lilac, no warm end
  glacier: ramp([0, 0, 0], [8, 14, 24], [24, 40, 62], [50, 78, 108], [88, 124, 156], [140, 174, 200], [236, 246, 255]),    // slate and ice: nearly no colour
  silver: ramp([0, 0, 0], [12, 12, 14], [34, 35, 40], [66, 68, 76], [104, 107, 117], [150, 154, 166], [244, 246, 250]),     // the film's inset panel: grey
  cobaltGold: ramp([0, 0, 0], [5, 10, 44], [12, 28, 98], [26, 56, 150], [48, 92, 190], [92, 140, 222], [255, 232, 176]),    // all-blue gas, a warm galaxy
  indigoDusk: ramp([0, 0, 0], [12, 8, 36], [34, 24, 78], [68, 46, 112], [108, 76, 138], [156, 118, 164], [240, 224, 236]),  // dusty violet to mauve
  borealis: ramp([0, 0, 0], [3, 14, 30], [6, 38, 66], [10, 70, 100], [22, 104, 132], [60, 146, 164], [214, 250, 248]),     // midnight to deep teal-cyan
  rose: ramp([0, 0, 0], [24, 6, 26], [58, 16, 56], [96, 32, 84], [134, 58, 112], [176, 100, 146], [255, 228, 240]),         // plum to dusty rose
  ember: ramp([0, 0, 0], [22, 6, 8], [52, 14, 14], [84, 28, 18], [116, 48, 24], [150, 76, 36], [255, 226, 186]),            // coals: warm, but held DARK
  sepia: ramp([0, 0, 0], [16, 11, 6], [40, 29, 17], [70, 53, 33], [104, 82, 54], [144, 118, 84], [250, 240, 220]),          // an old plate: brown to cream
  electric: ramp([0, 0, 0], [14, 4, 50], [30, 16, 112], [28, 56, 170], [24, 112, 206], [60, 172, 230], [224, 250, 255]),    // violet through blue to cyan
  midnight: ramp([0, 0, 0], [4, 7, 18], [10, 17, 40], [18, 30, 64], [28, 46, 88], [44, 68, 116], [200, 220, 246]),          // the quiet one: never more than dusk
});
// THE SHIPPED PALETTE IS THE OPERATOR'S CHOICE (2026-09-22, after living with all thirteen: "make Cyan and
// Gold the new default" -- their saved setting was cobaltGold): all-blue gas, which is far from every colour
// on the chart, and the one warm thing in it is the galaxy itself. The film's magma stays in the list.
export const FORM_PALETTE_DEFAULT = 'cobaltGold';
/** What the Settings picker calls each one, in the order it lists them: the shipped one first, then coolest to warmest. */
export const FORM_PALETTE_LABELS = Object.freeze([
  ['cobaltGold', 'Cobalt & gold'], ['midnight', 'Midnight'], ['abyss', 'Abyss'], ['ultraviolet', 'Ultraviolet'],
  ['electric', 'Electric'], ['indigoDusk', 'Indigo dusk'], ['glacier', 'Glacier'], ['silver', 'Silver'], ['borealis', 'Borealis'],
  ['rose', 'Ros\u00e9'], ['sepia', 'Sepia'], ['ember', 'Ember'], ['magma', 'Magma'],
]);
/** The shipped ramp, by its old name: [where on the ramp, [r, g, b] 0..1]. */
export const FORM_RAMP = FORM_PALETTES[FORM_PALETTE_DEFAULT];
/** The ramp at t (0..1) as [r, g, b] 0..255. Pure. */
export function formRamp(t, palette = FORM_PALETTE_DEFAULT) {
  const FORM_RAMP = FORM_PALETTES[palette] ?? FORM_PALETTES[FORM_PALETTE_DEFAULT];   // (shadows the export: this call's ramp)
  const x = Math.max(0, Math.min(1, t));
  let k = 0;
  while (k < FORM_RAMP.length - 2 && x >= FORM_RAMP[k + 1][0]) k++;
  const [t0, a] = FORM_RAMP[k], [t1, b] = FORM_RAMP[k + 1], u = Math.max(0, Math.min(1, (x - t0) / (t1 - t0)));
  return [0, 1, 2].map((i) => Math.round((a[i] + (b[i] - a[i]) * u) * 255));
}

export const FORM_MAX_PIXELS = 1_000_000;

/** Is this WebGL renderer string a SOFTWARE rasteriser (no graphics card behind it)? Pure. */
export function isSoftwareGl(renderer) { return /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(String(renderer ?? '')); }

const C = FORM_CONST;
const F = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;       // the hash is 32-bit arithmetic: a fragment shader's ints are mediump unless told
uniform vec2 uPanel;      // canvas pixels
uniform vec3 uPlace;       // where the galaxy sits, as fractions of the panel from its top left, and the scene's scale there
uniform float uGrow;      // how grown the galaxy is: a slow breath between 0.8 and 1 -- nothing resets, nothing fades
uniform float uSpin;      // the spiral pattern's angle
uniform vec2 uSat[${C.SATELLITES}];   // each satellite: how far through its life (0..1), and which life this is
uniform float uBright;    // sky.formBrightness: 1 is the picture as it was first made, and what it ships at
uniform vec4 uFlow;       // the two flow layers: phase of each (0..1), and each one's cycle number
uniform float uChurn;     // the warp's own clock
uniform float uTurb;      // the jostle's clock (an angle)
uniform float uBurst;     // the outbursts' clock, in bursts (wrapped on the CPU)
out vec4 o;

// ---- noise: a seeded integer hash (fract(sin) bands on some GPUs), value noise, fbm
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h2(vec2 i) {
  ivec2 c = ivec2(i);
  uint n = (uint(c.x) * 1597334677u) ^ (uint(c.y) * 3812015801u);
  n ^= n >> 16; n *= 0x7feb352du; n ^= n >> 15; n *= 0x846ca68bu; n ^= n >> 16;
  return float(n >> 8) / 16777216.0;
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), u.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), u.x), u.y);
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec2 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int k = 0; k < 6; k++) { if (k >= oct) break; s += a * vnoise(p); p = ROT * p * 2.03 + 17.3; a *= 0.5; }
  return s;
}
// ridged: the creases of the noise are the filaments
float ridged(vec2 p, int oct) {
  float a = 0.5, s = 0.0, w = 1.0;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    n *= n; s += a * n * w; w = clamp(n * 1.6, 0.0, 1.0);
    p = ROT * p * 2.07 + 9.1; a *= 0.55;
  }
  return s;
}

// ---- the film's colour ramp: black, indigo, violet, magenta, salmon, orange, pale yellow
uniform vec4 uRamp[7];    // the palette: where on the ramp, then r, g, b (formgl.js FORM_PALETTES) -- a uniform, so a palette is a setting, not a recompile
vec3 magma(float t) {
  t = clamp(t, 0.0, 1.0);
  for (int i = 1; i < 7; i++) if (t < uRamp[i].x || i == 6) return mix(uRamp[i - 1].yzw, uRamp[i].yzw, clamp((t - uRamp[i - 1].x) / (uRamp[i].x - uRamp[i - 1].x), 0.0, 1.0));
  return uRamp[6].yzw;
}

float hash1(float n) { return float(pcg(uint(n * 8191.0 + 3.0))) / 4294967296.0; }

// where satellite k is, a of the way through life n: in from the panel's edge on a decaying
// spiral. Each life is another orbit (n is in every hash), so the sky never repeats itself.
void satAt(float fk, float n, float a, float wide, out vec2 c, out vec2 tang) {
  float h0 = hash1(fk * 7.0 + n * 13.0 + 17.0), h1 = hash1(fk * 7.0 + n * 13.0 + 23.0), h2s = hash1(fk * 7.0 + n * 13.0 + 29.0);
  float R = ${F(C.SAT_R0)} * (0.88 + 0.24 * h2s) * pow(1.0 - a, 1.35) + 0.012;
  float turn = h1 < 0.5 ? -1.0 : 1.0;
  float ph = 6.2832 * h0 + turn * (1.0 + 0.9 * h1) * a * 2.0 / (0.35 + R);
  float sx = 1.0 + 0.6 * (wide - 1.0);
  c = R * vec2(cos(ph) * sx, sin(ph) * 0.85);
  tang = normalize(vec2(-sin(ph) * sx, cos(ph) * 0.85) * turn - 0.6 * normalize(c + 1e-5));   // round, and IN
}

// the gas's texture at a (flowed) position: the wisps, the finer tangle, the streams
void smoke(vec2 p, vec2 off, float ph, out float wisps, out float fine, out float streams) {
  float r = length(p);
  vec2 dir = p / max(r, 1e-4);
  // THE WISPS: ridged noise through a warp that EVOLVES (its two fields circle through the noise on
  // uChurn, in different directions, so the warp changes shape instead of translating)
  vec2 q = p * 1.55 + off;
  vec2 ch = 0.9 * vec2(cos(uChurn), sin(uChurn)), ch2 = 0.9 * vec2(cos(uChurn * 1.3 + 2.0), sin(uChurn * 1.3 + 2.0));
  vec2 warp = vec2(fbm(q + ch, 4), fbm(q + vec2(5.2, 1.3) - ch2, 4)) - 0.5;
  wisps = ridged(q * 1.25 + 1.9 * warp, 5);
  // ...and a finer, more tangled layer through a second warp: the film's gas is smoke at every scale
  vec2 warp2 = vec2(fbm(q * 2.3 + 1.7 * warp + vec2(9.0, 0.0) + ch2, 3), fbm(q * 2.3 - 1.7 * warp + vec2(-4.0, 2.0) - ch, 3)) - 0.5;
  fine = ridged(q * 3.4 + 2.6 * warp2 + 1.2 * warp, 4);
  // THE STREAMS: the same kind of noise, sampled at direction * r^k so it barely changes along a
  // radius and changes fast across one -- filaments aimed at the galaxy -- and bent hard by the warp:
  // the film's filaments are tangled and only LOOSELY aimed at the middle (sampled straight down the
  // radius they drew a sunburst of thin rays round a dark hole)
  float rk = pow(r + 0.015, ${F(C.STREAM_POW)});
  vec2 sp = dir * (rk * 2.2 + ph * ${F(C.INFLOW)} * 2.2) + 1.5 * warp + 0.6 * warp2 + off * 0.37;
  streams = pow(ridged(sp * 1.7 + vec2(11.0, 4.0), 5), 1.5);
  // GAS RUNS DOWN THE FILAMENTS: a lumpiness sampled at direction * (radius + how far this layer has
  // run), so the lumps keep their place across a stream and travel IN along it -- the thing in the
  // film that most says "this is flowing", and that a carried pattern alone does not give
  float run = fbm(dir * (rk * 5.0 + ph * ${F(C.RUN)}) * 1.6 + off * 0.71 + 0.8 * warp, 3);
  streams *= 0.35 + 1.5 * run * run;
}

void main() {
  float grow = uGrow;
  float zoom = mix(${F(C.ZOOM0)}, ${F(C.ZOOM1)}, grow);
  vec2 p = (gl_FragCoord.xy - vec2(uPlace.x, 1.0 - uPlace.y) * uPanel) / (0.5 * min(uPanel.x, uPanel.y)) / (zoom * uPlace.z);
  p.y = -p.y;
  // AS WIDE AS THE PANEL (operator, 2026-09-21: "it needs to take up more horizontal space ... extend
  // to the extents of the larger display"): everything was measured against the panel's SHORT side,
  // so on a wide board the gas was a disc in the middle with empty sides. The halo, the streams'
  // reach and the dark corners are measured in pe, which is p squeezed by the panel's own aspect;
  // the galaxy and the satellites keep true circles.
  float wide = max(1.0, ${F(C.WIDE)} * uPanel.x / uPanel.y);
  // THE JOSTLE: a small displacement field circling through its noise -- it throws every filament
  // about a little, coherently, on top of being carried: turbulence, which a smooth flow is not
  vec2 tj = 0.8 * vec2(cos(uTurb), sin(uTurb));
  // (the GAS only: pj feeds the smoke; the galaxy and the satellites are not thrown about with it)
  vec2 pj = p + ${F(C.TURB_AMP)} * (vec2(fbm(p * 2.4 + tj, 3), fbm(p * 2.4 + vec2(7.3, 1.9) - tj, 3)) - 0.5) * 2.0;
  // THE SATELLITES STIR THE GAS (operator, 2026-09-21: "The satelites still don't leave enough trails
  // or perturb the flow they interact with"). A knot drawn OVER the smoke passes through it like a
  // ghost. So each one moves the gas itself: the smoke is sampled at a place turned round the
  // satellite and dragged back along its path -- which on screen is gas wrapped round it and pulled
  // along behind -- and the same, weaker, at three places it has just been, so the lane it came down
  // stays torn for a while after it has gone by.
  for (int k = 0; k < ${C.SATELLITES}; k++) {
    float fk = float(k), a = uSat[k].x, n = uSat[k].y;
    float fadeK = smoothstep(0.0, ${F(C.SAT_HAZE_IN)}, a) * (1.0 - smoothstep(0.92, 1.0, a));
    float size = 0.008 + 0.010 * hash1(fk + 31.0 + n);
    for (int j = 0; j < 4; j++) {
      float aj = a - float(j) * 0.035;
      if (aj <= 0.0) break;
      vec2 c, tg; satAt(fk, n, aj, wide, c, tg);
      vec2 d = pj - c;
      float sg = size * (7.0 + 3.0 * float(j));
      float g = exp(-dot(d, d) / (sg * sg)) * fadeK / (1.0 + 0.8 * float(j));
      pj += (vec2(-d.y, d.x) * ${F(C.STIR)} - tg * sg * ${F(C.DRAG)}) * g;
    }
  }
  vec2 pe = p / vec2(wide, 1.0);
  float r = length(p), re = length(pe);
  vec2 dir = p / max(r, 1e-4);

  // THE HALO: broad, a little taller than wide as the film's is, its edge broken by the noise below
  float haloR = mix(${F(C.HALO_R0)}, ${F(C.HALO_R1)}, grow);
  float lump = fbm(p * 1.1 + vec2(3.1, -7.7) + 0.6 * vec2(cos(uChurn * 0.5), sin(uChurn * 0.5)), 3);
  float halo = exp(-pow(length(pe * vec2(1.0, 0.82)) / (haloR * (0.75 + 0.6 * lump)), 1.7));

  // THE SMOKE FLOWS (operator, 2026-09-21: "I'm not seeing any shifting of the filaments. Just some
  // orange blobs rotating around the center"). The first cut slid its noise at a hundredth of a
  // cell a second -- frozen, and a sliding pattern is not gas moving anyway. Now the gas is
  // ADVECTED: every point is drawn toward the middle and turned round it (faster close in), which
  // is what the film's gas is doing. A flow that runs for ever winds a pattern into rings and
  // shrinks it to nothing, so there are TWO layers half a life apart, each run from rest to its
  // full pull and swirl and cross-faded out as the other comes in, each life on fresh noise.
  // And the warp has its own clock, so the filaments writhe as they go rather than riding rigidly.
  float wisps = 0.0, fine = 0.0, streams = 0.0;
  for (int L = 0; L < 2; L++) {
    float ph = L == 0 ? uFlow.x : uFlow.y, cyc = L == 0 ? uFlow.z : uFlow.w;
    float wgt = 1.0 - abs(2.0 * ph - 1.0);                 // in from nothing, out to nothing
    if (wgt <= 0.001) continue;
    float f = ph - 0.5;                                    // (centred: at mid-life the layer is undistorted)
    float ang = ${F(C.FLOW_SWIRL)} * f / (0.22 + r * 1.6);
    float ca = cos(ang), sa = sin(ang);
    vec2 pf = vec2(ca * pj.x - sa * pj.y, sa * pj.x + ca * pj.y) * exp(${F(C.FLOW_PULL)} * f);
    vec2 off = vec2(cyc * 13.7, cyc * -7.3);               // another life, other smoke
    float w1, f1, s1;
    smoke(pf, off, ph, w1, f1, s1);
    wisps += wgt * w1; fine += wgt * f1; streams += wgt * s1;
  }
  streams *= exp(-re * 1.0) * smoothstep(0.02, 0.22, r) * (0.55 + 0.75 * grow);

  // THE GALAXY: a tilted disc, log-spiral arms turning, the middle lapping the rim, a hard core
  float gR = mix(${F(C.GALAXY_R0)}, ${F(C.GALAXY_R1)}, grow);
  float ct = cos(${F(C.GALAXY_TILT)}), st = sin(${F(C.GALAXY_TILT)});
  vec2 d = vec2(ct * p.x + st * p.y, (-st * p.x + ct * p.y) / ${F(C.GALAXY_SQUASH)}) / gR;
  float dr = length(d), th = atan(d.y, d.x);
  float spin = uSpin;
  float arms = 0.5 + 0.5 * cos(${F(C.ARMS)} * (th + spin) - ${F(C.ARM_WIND)} * log(dr + 0.08));
  arms = pow(arms, 1.8) * (0.55 + 0.6 * fbm(d * 2.4 + 3.0, 3));
  float disc = exp(-dr * 1.35) * (0.35 + 1.25 * arms);
  float core = exp(-dr * dr * 9.0);
  float galaxy = (disc * 0.95 + core * 1.5) * (0.35 + 0.65 * grow);

  // SATELLITES: knots falling in on decaying spirals, each in its own haze, stretched along its path
  float sats = 0.0, satGas = 0.0, arrive = 0.0;
  for (int k = 0; k < ${C.SATELLITES}; k++) {
    float fk = float(k), a = uSat[k].x, n = uSat[k].y;
    // the merger's flash: up over the last of a life, down over the start of the next -- one swell,
    // with no step where the life number turns over
    arrive += a < 0.5 ? exp(-a * 14.0) : smoothstep(0.93, 1.0, a);
    vec2 c, tang; satAt(fk, n, a, wide, c, tang);
    vec2 e = p - c;
    float along = dot(e, tang), across = dot(e, vec2(tang.y, -tang.x));
    float size = 0.008 + 0.010 * hash1(fk + 31.0 + n);
    float trail = along < 0.0 ? 1.0 : 1.7;                 // the gas it sheds lies BEHIND it, a little
    float knot = exp(-(along * along / (size * size * trail * trail) + across * across / (size * size)));
    float haze = exp(-length(e) / (size * 9.0));
    // THEY ARRIVE, THEY DO NOT APPEAR (operator, 2026-09-21: "the gas satellites pop into view at the
    // edges and it looks bad. They need to gradually fade in instead"). A life began INSIDE the frame,
    // against its darkest part, and the knot came up in six seconds: a bright point out of nothing.
    // Now a life begins beyond the frame's edge and drifts in; its gas cloud comes up first, slowly
    // and eased (so there is no moment it starts), and the knot condenses out of that cloud later.
    float out_ = 1.0 - smoothstep(0.92, 1.0, a);
    float hazeIn = smoothstep(0.0, ${F(C.SAT_HAZE_IN)}, a); hazeIn *= hazeIn;
    float fade = hazeIn * out_;                             // the cloud, the wake, the shells
    float knotFade = smoothstep(0.18, ${F(C.SAT_KNOT_IN)}, a) * out_;
    sats += knot * 0.8 * knotFade;
    satGas += haze * 0.45 * (0.35 + 1.1 * wisps * wisps + 0.5 * fine) * fade;
    // ITS WAKE (operator, 2026-09-21: "The rotating satellites do not emit any plasma or other
    // shifting effects like the video does"): the gas the halo strips off it as it ploughs in, laid
    // along where it HAS BEEN -- each sample further back is broader, fainter, and torn by the smoke
    vec2 prev = c;
    for (int j = 1; j <= ${C.WAKE}; j++) {
      float fj = float(j), aj = a - fj * ${F(C.WAKE_STEP)};
      if (aj <= 0.0) break;
      vec2 cj, tj2; satAt(fk, n, aj, wide, cj, tj2);
      // (a little off the path, by the smoke: a wake is torn, not ruled)
      cj += (vec2(wisps, fine) - 0.45) * size * (0.8 + 0.5 * fj);
      // (never narrower than the gap to the last sample: far out, where a satellite moves fast, the
      // samples were further apart than they were wide and the wake was a string of beads)
      float sj = max(size * (1.7 + 0.75 * fj), 0.85 * length(cj - prev));
      prev = cj;
      float wk = exp(-dot(p - cj, p - cj) / (sj * sj));
      satGas += wk * (0.95 / (1.0 + 0.22 * fj)) * (0.30 + 1.5 * fine * wisps + 0.7 * wisps) * fade;
      if (j <= 3) sats += wk * wk * 0.10 * knotFade;        // the freshest of it is still hot
    }
    // ITS OUTBURSTS: a shell of hot gas blown off it, swelling and fading, its rim ragged
    float bt = fract(uBurst * (0.7 + 0.5 * hash1(fk + 41.0)) + hash1(fk + 43.0));
    // (broad, ragged and torn by the smoke: a thin even ring round a knot read as a little donut)
    float rim = length(e) * (1.0 + 0.9 * (fbm(normalize(e + 1e-5) * 2.0 + fk * 3.1 + n + floor(uBurst), 3) - 0.5));
    float shellR = size * (1.5 + 16.0 * bt);
    satGas += exp(-pow((rim - shellR) / (size * (2.2 + 5.0 * bt)), 2.0)) * 0.42 * (1.0 - bt) * (1.0 - bt) * smoothstep(0.0, 0.15, bt) * (0.3 + 1.5 * wisps * fine + 0.5 * wisps) * fade;
  }

  // THE GALAXY'S OUTBURSTS: what the film's middle keeps doing -- shells of hot gas thrown out along
  // the disc's minor axis, swelling, tearing on the halo, fading -- two in the air at once
  float blast = 0.0;
  vec2 axis = vec2(-st, ct);                                // the disc's minor axis (its tilt, turned a quarter)
  for (int b = 0; b < 2; b++) {
    float bt = fract(uBurst * 0.5 + 0.5 * float(b));
    float n = floor(uBurst * 0.5 + 0.5 * float(b));
    float ragged = 1.0 + 0.45 * (fbm(dir * 2.2 + n * 5.3 + float(b) * 9.0, 3) - 0.5);
    float shellR = gR * 1.5 + (0.10 + 0.55 * grow) * bt;
    float polar = 0.30 + 0.70 * pow(abs(dot(dir, axis)), 1.5);
    blast += exp(-pow((r * ragged - shellR) / (0.018 + 0.10 * bt), 2.0)) * polar * (1.0 - bt) * (1.0 - bt) * smoothstep(0.0, 0.08, bt);
  }
  blast *= (0.35 + 0.65 * grow) * (0.5 + 1.2 * wisps);

  // density -> tone. The halo gates the turbulence (no gas, no wisps); the streams and the galaxy
  // ride over it. A soft shoulder keeps the orange from clipping to the core's yellow.
  float cusp = exp(-r / (0.13 + 0.08 * grow));           // the gas piles up where the galaxy is
  float smoke = 0.55 * wisps * wisps + 0.30 * wisps + 0.35 * fine * fine;
  float gas = halo * (0.10 + 0.62 * smoke) + streams * (0.25 + 0.60 * halo) + cusp * (0.18 + 1.0 * smoke) + satGas + blast * 0.9;
  gas *= 0.62 + 0.38 * grow;
  // GAS TOPS OUT AT ORANGE; ONLY STARS REACH THE PALE YELLOW. In the film the ramp's last sixth is
  // the galaxy and the satellites' knots and nothing else -- however dense the gas, it is orange.
  // One tone curve over the summed density let a satellite's haze over the central cusp burn a
  // pale blob the size of the galaxy's whole neighbourhood.
  float tGas = (1.0 - exp(-gas * 1.45)) * 0.84;
  float tStars = 1.0 - exp(-(galaxy + sats + arrive * core * 0.8) * 1.6);
  float tone = tGas + (1.0 - tGas) * tStars;
  // the corners fall to black, as the film's do: the halo is a thing IN the frame, not the frame
  tone *= 1.0 - 0.55 * smoothstep(1.0, 1.75, length(pe * vec2(0.8, 1.0)));
  tone = pow(tone, 0.95);
  // DIMMED AS A COLOUR, NOT AS A DENSITY (operator, 2026-09-21: "A slider for dimming things"). Scaling
  // the tone slides every pixel DOWN the ramp -- half of orange is magenta, half of magenta is indigo
  // -- and the picture changes colour as it dims. Scaling the colour keeps the film's hues at any level.
  vec3 col = magma(tone) * clamp(uBright, 0.0, 1.5);
  // under one 8-bit step of noise: a ramp this smooth bands without it
  col += (h2(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(max(col, 0.0), 1.0);
}`;

/**
 * Attach the layer to `canvas`. Answers a controller, or null where WebGL2 or the shader cannot be
 * had (the caller falls back to galform.js's 2D renderer) -- never throws.
 *   opts.onCompileError(log)   the shader log, for a headless bring-up
 *   opts.onLost()              the context died: the caller goes back to the fallback
 *   opts.preserve              keep the drawing buffer (a test page reading pixels back)
 */
export function formGlAttach(canvas, opts = {}) {
  let gl = null;
  try { gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: opts.preserve === true }); } catch { gl = null; }
  if (!gl) return null;
  // NOT ON A SOFTWARE RASTERISER. This field is about a hundred and forty hash lookups a pixel:
  // measured 2026-09-21, 0.11 ms a frame on an RTX 5090 and 64 ms on SwiftShader at 1280x720. A
  // browser with no graphics card still offers WebGL2, drawn on the processor, and there the 2D
  // fallback (galform.js) is the faster sky by far -- so the layer declines, as if there were no GL.
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
    if (opts.onCompileError) opts.onCompileError(e.message);
    return null;
  }
  // a VAO even with no attributes: some drivers require one bound
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);                                     // one opaque field: nothing to blend with
  const un = {};
  for (const n of ['uPanel', 'uPlace', 'uGrow', 'uSpin', 'uBright', 'uFlow', 'uChurn', 'uTurb', 'uBurst']) un[n] = gl.getUniformLocation(prog, n);
  const uSat = []; for (let k = 0; k < C.SATELLITES; k++) uSat.push(gl.getUniformLocation(prog, `uSat[${k}]`));
  const uRampLoc = gl.getUniformLocation(prog, 'uRamp[0]');
  const st = { dead: false, at: null, life: 0, flow: 0, pal: null, ramp: null };
  canvas.addEventListener?.('webglcontextlost', (e) => { e.preventDefault?.(); st.dead = true; opts.onLost?.(); });
  return {
    /** One frame. pw/ph in CSS pixels, dpr the device ratio, now the sky's clock (ms). */
    draw(pw, ph, dpr, now, o = {}) {
      if (st.dead) return false;
      // the field is soft: past FORM_MAX_PIXELS it is drawn smaller and stretched by the canvas's CSS box
      let W = Math.max(1, Math.round(pw * dpr)), H = Math.max(1, Math.round(ph * dpr));
      const k = Math.min(1, Math.sqrt(FORM_MAX_PIXELS / (W * H)));
      W = Math.max(1, Math.round(W * k)); H = Math.max(1, Math.round(H * k));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      const speed = Number.isFinite(o.formSpeed) ? Math.max(0, Math.min(4, o.formSpeed)) : FORM_SPEED_DEFAULT;
      // PERPETUAL (operator, 2026-09-21: "have the scene perpetually evolving. don't fade it out").
      // There is no loop any more and no envelope: the galaxy is grown and stays grown, breathing a
      // little; each satellite lives its own life on the wall clock -- in from the edge, round, merged,
      // and born again on ANOTHER orbit -- five of them out of step, so something is always arriving;
      // and the gas never stops. `formSpeed` is how fast the galaxy and its satellites live (0 holds
      // them where they are; the gas still flows, below). All phases are worked out here in doubles.
      const bright = Number.isFinite(o.formBrightness) ? Math.min(1.5, Math.max(0, o.formBrightness)) : FORM_BRIGHTNESS_DEFAULT;
      const flow = Number.isFinite(o.formFlow) ? Math.max(0, Math.min(4, o.formFlow)) : FORM_FLOW_DEFAULT;
      // THE TWO CLOCKS ARE INTEGRATED, NOT MULTIPLIED (operator, 2026-09-21: "another slider to speed up or
      // slow down the current animation"). `now x speed` is a clock that JUMPS when the speed changes --
      // at an hour of uptime, nudging a slider from 1.0 to 1.1 throws the scene six minutes forward, on
      // every tick of the drag. Each clock instead adds (time passed) x (its speed now), so a slider
      // changes the PACE and nothing else. A fresh layer starts both at now x speed, so the first
      // frame is still a pure function of the clock (the preview script and the tests lean on that).
      const nowS = now / 1000;
      if (st.at == null || nowS < st.at) { st.life = nowS * speed; st.flow = nowS * flow; }
      else { const dt = nowS - st.at; st.life += dt * speed; st.flow += dt * flow; }
      st.at = nowS;
      const life = st.life;
      const grow = 0.9 + 0.1 * Math.sin((life / C.BREATHE) * Math.PI * 2);
      const spin = ((life / C.FORM_CYCLE) * C.SPIN * Math.PI * 2) % (Math.PI * 2);
      const sats = [];
      for (let k = 0; k < C.SATELLITES; k++) {
        const span = C.SAT_LIFE * (0.75 + 0.5 * ((k * 0.618) % 1));
        const tt = speed > 0 ? life / span + k / C.SATELLITES + 0.37 * k : C.FORM_HOLD * 0.6 + k / C.SATELLITES;
        sats.push([tt % 1, Math.floor(tt) % 97]);
      }
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(un.uPanel, W, H);
      const place = FORM_PLACEMENTS[o.formAt] ?? FORM_PLACEMENTS[FORM_AT_DEFAULT];
      gl.uniform3f(un.uPlace, place[0], place[1], place[2]);
      gl.uniform1f(un.uGrow, grow);
      gl.uniform1f(un.uSpin, spin);
      for (let k = 0; k < C.SATELLITES; k++) gl.uniform2f(uSat[k], sats[k][0], sats[k][1]);
      gl.uniform1f(un.uBright, bright);
      const pal = FORM_PALETTES[o.formPalette] ? o.formPalette : FORM_PALETTE_DEFAULT;
      if (st.pal !== pal) { st.pal = pal; st.ramp = new Float32Array(FORM_PALETTES[pal].flatMap(([t, c]) => [t, c[0], c[1], c[2]])); }
      gl.uniform4fv(uRampLoc, st.ramp);
      // THE FLOW RUNS ON THE WALL CLOCK, whatever the loop is doing (speed 0 holds the galaxy's
      // moment; the gas must still move, or the sky is a photograph). Phases are worked out here in
      // doubles and handed over as fractions: a float32 on the card never sees a big clock.
      // (sky.formFlow is THIS clock's pace: the gas's inward flow, its swirl, its turbulence and the
      // outbursts. It is its own slider: formSpeed is how fast the galaxy and satellites LIVE.)
      const sec = st.flow, tau = sec / C.FLOW_PERIOD;
      const tauB = tau + 0.5;
      gl.uniform4f(un.uFlow, tau % 1, tauB % 1, Math.floor(tau) % 64, (Math.floor(tauB) % 64) + 0.5);
      gl.uniform1f(un.uChurn, (sec * C.FLOW_CHURN) % (Math.PI * 2 * 100));
      gl.uniform1f(un.uTurb, (sec * C.TURB) % (Math.PI * 2));
      gl.uniform1f(un.uBurst, (sec / C.BURST_PERIOD) % 1024);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/** Feature probe without keeping a context: answers true where the layer can run. */
let SUPPORT = null;
export function formGlSupported() {
  if (SUPPORT != null) return SUPPORT;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    SUPPORT = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { SUPPORT = false; }
  return SUPPORT;
}
