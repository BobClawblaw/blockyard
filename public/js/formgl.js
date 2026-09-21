// THE FORMATION, GPU LAYER v2 (2026-09-21; operator, on v1: "no color, no filaments, no
// volumetric effects. The formation effect looks nothing like the reference video").
//
// Three defects, three fixes:
//   1. COLOUR. v1's palette averaged to neutral grey wherever the warm core mixed with the
//      blue web (measured: web annulus RGB 96,96,96 at mid-cycle). v2 keeps the temperature
//      ramp SATURATED end to end: the cosmic web is deep cobalt, infall gas is cyan-steel,
//      the disc is electric blue-white, and the hot inner disc burns amber where stars form.
//      Grey is a bug now.
//   2. FILAMENTS. v1's ribbons died 30% into the cycle, so nothing streamed after the web
//      phase. v2's filaments persist to 75% of the cycle: they keep feeding the disc from
//      six directions, and each gas parcel SLIDES ALONG its curve, so the ribbons visibly
//      carry gas inward instead of merely sitting there.
//   3. VOLUMETRIC. Points read as sand. v2's gas draws as cloud SPRITES: instanced quads
//      carrying 3-octave value-noise fbm in the fragment shader, so every cloud has interior
//      structure -- wisps, holes, filaments at the texel level. Dark dust lanes ride a
//      second kind of sprite whose rgb goes out NEGATIVE and subtracts light under additive
//      blending -- the multiplicative darkening the film's lanes need, impossible on 2D.
//
// The physics (filament curves, settle times, differential rotation, cooling, fountain
// windows, the loop envelope) is unchanged from v1 and galform.js, and stays pinned by
// test/formgl.test.js's constant-sharing test and test/galform.test.js. Math.random stays
// banned; the same `now` paints the same frame. Canvas-rules note: the 2D-context bans do
// not apply to a WEBGL context -- the silently-dropped-fill problem they guard is a 2D
// problem, and GL blending is the pipeline's own way of accumulating density.

// ------------------------------------------------------------------- the constants
export const FORM_CONST = Object.freeze({
  FORM_CYCLE: 140,
  FORM_ZOOM_IN: 0.55,
  ZOOM0: 0.52,
  DISC_SHARE: 0.55,
  RIBBONS: 6,
  RIBBON_BOW: 1.7,
  RIBBON_WIDTH0: 0.22,
  RIBBON_WIDTH1: 0.15,
  RIBBON_ANCHOR_R: 0.30,
  RIBBON_NARROW: 0.55,
  RIBBON_LIFE: 0.75,          // v2: the streams run to 75% of the cycle, not 30%
  SPINE_SHARE: 0.60,
  SPINE_HALF: 0.30,
  FLOW_RATE: 0.10,            // along-ribbon flow, cycle fractions per cycle fraction
  TURB0: 0.24,
  TURB_DECAY: 0.75,
  TURB_WIN: 0.30,
  TURB_SPAN: 0.40,
  COOL0: 0.25,
  COOL_SPAN: 0.35,
  DISC_RATIO0: 0.85,
  DISC_RATIO1: 0.40,
  VZ0: 0.22,
  VZ1: 0.05,
  BULGE_SHARE: 0.30,
  BULGE_POW: 2.2,
  DISC_POW: 0.62,
  W_CYCLE: 0.075,
  W_EXP: 0.55,
  W_EPS: 0.18,
  FOUNTAIN_COUNT: 900,
  DUST_SHARE: 0.16,           // the share of gas sprites that draw as dark lanes
});

const C = FORM_CONST;
const F = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** The seeded hash (the same constants hash01 uses in JS) plus the value-noise fbm. */
const GLSL_HASH = `
float hash01(float n) {
  return fract(sin(n * 12.9898 + 78.233) * 43758.5453);
}
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// 3-octave fbm: the interior structure of every cloud sprite
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 3; k++) { v += a * vnoise(p); p = p * 2.13 + 17.7; a *= 0.5; }
  return v;
}
// the fragment stages share the easing helpers with the vertex stage
float clamp01(float x) { return clamp(x, 0.0, 1.0); }
float sm(float x) { float t = clamp01(x); return t * t * (3.0 - 2.0 * t); }`;

const GLSL_HEAD = `
precision highp float;
uniform vec2 uPanel;      // canvas pixels
uniform float uU;         // cycle fraction 0..1
uniform float uBright;    // starBrightness
uniform float uEnv;       // the loop's fade envelope (envAt(u), computed on the CPU)
uniform float uR;         // disc scale in px (min(pw,ph) * DISC_SHARE * zoom)
uniform float uCs, uSn;   // the disc tilt's cos/sin
uniform float uDpr;       // the device pixel ratio, sizing the sprites
${GLSL_HASH}
`;

// ------------------------------------------------------------------- the gas pass
/**
 * GAS, vertex stage. One cloud per 6 vertices (two triangles of an instanced quad); every
 * cloud's place, colour and fbm seed derive from its vertex id with the same hash streams
 * formField draws, in the same order.
 */
const VS_GAS = `#version 300 es
${GLSL_HEAD}
const float FORM_CYCLE = ${F(C.FORM_CYCLE)};
const float RIBBONS = ${F(C.RIBBONS)};
const float RIBBON_BOW = ${F(C.RIBBON_BOW)};
const float RIBBON_WIDTH0 = ${F(C.RIBBON_WIDTH0)};
const float RIBBON_WIDTH1 = ${F(C.RIBBON_WIDTH1)};
const float ANCHOR_R = ${F(C.RIBBON_ANCHOR_R)};
const float NARROW = ${F(C.RIBBON_NARROW)};
const float RIBBON_LIFE = ${F(C.RIBBON_LIFE)};
const float SPINE_SHARE = ${F(C.SPINE_SHARE)};
const float SPINE_HALF = ${F(C.SPINE_HALF)};
const float FLOW = ${F(C.FLOW_RATE)};
const float TURB0 = ${F(C.TURB0)};
const float TURB_DECAY = ${F(C.TURB_DECAY)};
const float TURB_WIN = ${F(C.TURB_WIN)};
const float TURB_SPAN = ${F(C.TURB_SPAN)};
const float COOL0 = ${F(C.COOL0)};
const float COOL_SPAN = ${F(C.COOL_SPAN)};
const float RATIO0 = ${F(C.DISC_RATIO0)};
const float RATIO1 = ${F(C.DISC_RATIO1)};
const float VZ0 = ${F(C.VZ0)};
const float VZ1 = ${F(C.VZ1)};
const float BULGE_SHARE = ${F(C.BULGE_SHARE)};
const float BULGE_POW = ${F(C.BULGE_POW)};
const float DISC_POW = ${F(C.DISC_POW)};
const float W_CYCLE = ${F(C.W_CYCLE)};
const float W_EXP = ${F(C.W_EXP)};
const float W_EPS = ${F(C.W_EPS)};
const float ZOOM0 = ${F(C.ZOOM0)};
const float ZOOM_IN = ${F(C.FORM_ZOOM_IN)};

out vec2 vUv;
out vec4 vColor;      // rgb premultiplied by alpha; a < 0 marks a dust sprite
out float vFbmSeed;
out float vFbmScale;

void main() {
  float vid = floor(float(gl_VertexID) / 6.0);       // one cloud per 6 vertices
  float corner = float(gl_VertexID) - vid * 6.0;
  vec2 quad = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
                      vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0))[int(corner)];
  vUv = quad * 0.5 + 0.5;

  // the same hash streams formField draws, in the same order
  float h1 = hash01(11.0 * 131.0 + vid * 17.31 + 1.0);
  float h3 = hash01(11.0 * 131.0 + vid * 17.31 + 3.0);
  float h5 = hash01(11.0 * 131.0 + vid * 17.31 + 5.0);
  float h6 = hash01(11.0 * 131.0 + vid * 17.31 + 6.0);
  float h7 = hash01(11.0 * 131.0 + vid * 17.31 + 7.0);
  float h8 = hash01(11.0 * 131.0 + vid * 17.31 + 8.0);
  float h9 = hash01(11.0 * 131.0 + vid * 17.31 + 9.0);
  float h10 = hash01(11.0 * 131.0 + vid * 17.31 + 10.0);
  float h11 = hash01(11.0 * 131.0 + vid * 17.31 + 11.0);
  float h12 = hash01(11.0 * 131.0 + vid * 17.31 + 12.0);
  float h13 = hash01(11.0 * 131.0 + vid * 17.31 + 13.0);
  float h16 = hash01(11.0 * 131.0 + vid * 17.31 + 16.0);
  float h17 = hash01(11.0 * 131.0 + vid * 17.31 + 17.0);
  float h18 = hash01(11.0 * 131.0 + vid * 17.31 + 18.0);
  float h19 = hash01(11.0 * 131.0 + vid * 17.31 + 19.0);
  float h20 = hash01(11.0 * 131.0 + vid * 17.31 + 20.0);
  float h21 = hash01(11.0 * 131.0 + vid * 17.31 + 21.0);
  float h22 = hash01(11.0 * 131.0 + vid * 17.31 + 22.0);
  float h23 = hash01(11.0 * 131.0 + vid * 17.31 + 23.0);
  float h24 = hash01(11.0 * 131.0 + vid * 17.31 + 24.0);
  float h25 = hash01(11.0 * 131.0 + vid * 17.31 + 25.0);
  float h26 = hash01(11.0 * 131.0 + vid * 17.31 + 26.0);
  float h27 = hash01(11.0 * 131.0 + vid * 17.31 + 27.0);

  float f = floor(h1 * RIBBONS);
  float bulge = step(h18, BULGE_SHARE);
  float spine = step(h19, SPINE_SHARE);
  float lo = (h3 - 0.5) * 2.0 * mix(1.0, SPINE_HALF, spine);
  float u0 = h20;
  float ph1 = h16 * 6.2831853;
  float w1 = 0.6 + 0.8 * h22;
  float r0 = pow(h5, mix(DISC_POW, BULGE_POW, bulge));
  float th0 = h6 * 6.2831853;
  float s0 = mix(0.16 + 0.38 * h7, 0.10 + 0.30 * h7, bulge);
  float jd = 0.10 + 0.06 * h8;
  float z0 = (h9 + h10 + h11 - 1.5) / 1.5;
  z0 = mix(z0, z0 * 0.25, bulge);
  float size = mix(0.55 + 0.85 * h12, 0.8 + 1.0 * h12, bulge);
  float b = 0.30 + 0.35 * h13;
  float dust = step(h27, ${F(C.DUST_SHARE)}) * (1.0 - bulge);  // dark lanes: never in the core
  float width0 = RIBBON_WIDTH0 + RIBBON_WIDTH1 * h25;
  float bow = (h26 - 0.5) * RIBBON_BOW;

  // THE FILAMENT (persistent, v2): the ribbon's geometry from its index
  float phi0 = f * 6.2831853 / RIBBONS + (hash01(11.0 * 211.0 + f * 29.7 + 1.0) - 0.5) * 0.7;
  float d0 = 1.5 + 1.0 * hash01(11.0 * 211.0 + f * 29.7 + 2.0);
  float anchor = f * 6.2831853 / RIBBONS + (hash01(11.0 * 211.0 + f * 29.7 + 4.0) - 0.5) * 2.4;
  float curl = (hash01(11.0 * 211.0 + f * 29.7 + 6.0) - 0.5) * 0.5;
  float ax = cos(phi0) * d0, ay = sin(phi0) * d0;
  float ex = cos(anchor) * ANCHOR_R, ey = sin(anchor) * ANCHOR_R;
  float mx = (ax + ex) * 0.5 + cos(phi0 + 1.5707963) * bow;
  float my = (ay + ey) * 0.5 + sin(phi0 + 1.5707963) * bow;

  // THE RIDE, v2: while the filament lives the parcels SLIDE ALONG it, so the ribbons
  // visibly carry gas inward; after the web dissolves everything is on the disc.
  float alive = 1.0 - sm((uU - RIBBON_LIFE) / 0.10);
  float travel = fract(u0 + uU * FLOW);
  float s = mix(sm(clamp01(uU / max(0.05, s0)) * (0.75 + 0.5 * u0)), travel, alive * 0.85);
  s = clamp(s, 0.0, 1.0);
  float it = 1.0 - s;
  float px = it * it * ax + 2.0 * it * s * mx + s * s * ex;
  float py = it * it * ay + 2.0 * it * s * my + s * s * ey;
  float s2 = max(0.0, s - 0.02), s3 = min(1.0, s + 0.02);
  float it2 = 1.0 - s2, it3 = 1.0 - s3;
  float qx = it2 * it2 * ax + 2.0 * it2 * s2 * mx + s2 * s2 * ex;
  float qy = it2 * it2 * ay + 2.0 * it2 * s2 * my + s2 * s2 * ey;
  float rx = it3 * it3 * ax + 2.0 * it3 * s3 * mx + s3 * s3 * ex;
  float ry = it3 * it3 * ay + 2.0 * it3 * s3 * my + s3 * s3 * ey;
  float tx = rx - qx, ty = ry - qy;
  float tl = length(vec2(tx, ty)) + 1e-6;
  float nx = -ty / tl, ny = tx / tl;

  float w = width0 * (1.0 - NARROW * s);
  float turb = TURB0 * (1.0 - 0.5 * s) * (1.0 - TURB_DECAY * sm((uU - TURB_WIN) / TURB_SPAN));
  float dx = turb * (sin(uU * 7.0 * w1 + ph1) + 0.6 * sin(uU * 13.0 * (0.6 + 0.8 * h23) + h21 * 6.2831853));
  float dy = turb * (cos(uU * 7.0 * (0.6 + 0.8 * h23) + h21 * 6.2831853) + 0.6 * cos(uU * 13.0 * w1 + ph1));
  float rot = uU * curl;
  float cr = cos(rot), sr = sin(rot);
  float lx = px + nx * lo * w + dx;
  float ly = py + ny * lo * w + dy;
  float bx = lx * cr - ly * sr;
  float by = lx * sr + ly * cr;

  // THE ORBIT
  float joined = sm((uU - s0) / jd);
  float sec = max(0.0, uU - s0) * FORM_CYCLE;
  float W = W_CYCLE / (pow(max(0.05, r0), W_EXP) + W_EPS);
  float th = th0 + W * sec;
  float ox = cos(th) * r0, oy = sin(th) * r0;
  float cool = sm((uU - COOL0) / COOL_SPAN);
  float ratio = mix(RATIO0, RATIO1, cool);
  float vzAmp = mix(VZ0, VZ1, cool);
  float gx = mix(bx, ox, joined);
  float gy = mix(by, oy * ratio, joined);
  float vz = z0 * vzAmp * joined;

  // to the panel: tilt, scale (the zoom rides u), centre
  float zoom = mix(ZOOM0, 1.0, sm(uU / ZOOM_IN));
  float R = uR / ZOOM0 * zoom;
  float sx = gx * uCs - gy * uSn;
  float sy = gx * uSn + gy * uCs;
  float X = uPanel.x * 0.5 + sx * R;
  float Y = uPanel.y * 0.5 + sy * R + vz * R * 0.9;

  // the sprite: radius in px, squashed with the disc plane for the joined clouds.
  // CALIBRATED against readback (v2 first pass washed the frame to white: 24k sprites of
  // up to 90px pile additively to saturation): 6000 clouds, 4..40px, alpha ceiling 0.35.
  float prad = size * R * (0.020 + 0.016 * h17) * (1.0 + 0.35 * (1.0 - joined));
  prad = clamp(prad, 4.0, 40.0);
  vec2 quadPx = quad * prad;
  quadPx.y *= mix(1.0, ratio, joined * 0.8);
  X += quadPx.x * uCs - quadPx.y * uSn;
  Y += quadPx.x * uSn + quadPx.y * uCs;
  gl_Position = vec4((X / uPanel.x) * 2.0 - 1.0, 1.0 - (Y / uPanel.y) * 2.0, 0.0, 1.0);

  // THE PALETTE, saturated (v2: grey was the defect): web deep cobalt, infall cyan-steel,
  // disc electric blue-white, the hot inner disc amber where stars form.
  float hot = 1.0 - clamp(r0 * 2.2, 0.0, 1.0);
  vec3 web = vec3(0.16, 0.32, 0.78);
  vec3 steel = vec3(0.36, 0.62, 0.92);
  vec3 disc = vec3(0.62, 0.78, 1.0);
  vec3 warm = vec3(1.0, 0.72, 0.36);
  vec3 col = mix(web, steel, sm(s * 1.6));
  col = mix(col, disc, joined * 0.85);
  col = mix(col, warm, hot * hot * joined * 0.9);
  float alpha = b * 0.55 * uEnv * uBright;
  alpha *= s < 0.45 ? 0.55 : 0.85;
  alpha *= 1.05 - 0.25 * abs(lo);
  alpha *= mix(1.0, mix(0.85, 1.0, joined) * (1.15 - 0.35 * min(1.0, r0)), step(0.001, joined));
  alpha *= 1.0 + 0.4 * hot * joined;
  alpha = min(alpha, 0.35);
  vColor = vec4(col * alpha, alpha);
  vFbmSeed = vid * 0.173 + uU * 0.6;                  // the clouds drift with the cycle
  vFbmScale = 3.0 + 3.0 * h17;
  if (dust > 0.5) { vColor.a = -1.0; }                // the fragment stage reads the sign
}`;

/**
 * GAS, fragment stage: the fbm IS the cloud -- density shaped by noise, filaments inside
 * the sprite. vColor.a < 0 marks a DUST sprite: its rgb goes out NEGATIVE, and under
 * additive blending subtracting light is the dark lane.
 */
const FS_GAS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in float vFbmSeed;
in float vFbmScale;
out vec4 frag;
${GLSL_HASH}
void main() {
  vec2 d = vUv - 0.5;
  float rr = length(d) * 2.0;
  float edge = 1.0 - sm((rr - 0.55) / 0.45);
  if (edge <= 0.003) discard;
  float n = fbm(vUv * vFbmScale + vFbmSeed * 7.31);
  n = mix(n, 1.0 - abs(2.0 * n - 1.0) * 0.55 + n * 0.45, 0.5);   // a little ridged
  float dens = clamp((n - 0.40) / 0.60, 0.0, 1.0);
  float body = edge * dens;
  if (vColor.a < 0.0) {
    // DUST: subtract a fraction of what is behind, faintly brown -- the dark lane
    float k = body * 0.55;
    frag = vec4(vec3(-0.30, -0.24, -0.16) * k, 0.0);
  } else {
    frag = vec4(vColor.rgb * body, body);
  }
}`;

// ------------------------------------------------------------------- the fountains
/** The fountains: fbm cloud sprites riding the two ballistic cones. */
const VS_WIND = `#version 300 es
${GLSL_HEAD}
out vec2 vUv;
out vec4 vColor;
out float vFbmSeed;
out float vFbmScale;
void main() {
  float vid = floor(float(gl_VertexID) / 6.0);
  float corner = float(gl_VertexID) - vid * 6.0;
  vec2 quad = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
                      vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0))[int(corner)];
  vUv = quad * 0.5 + 0.5;
  float pid = vid;
  float h1 = hash01(29.0 * 173.0 + pid * 19.17 + 1.0);
  float h2 = hash01(29.0 * 173.0 + pid * 19.17 + 2.0);
  float h3 = hash01(29.0 * 173.0 + pid * 19.17 + 3.0);
  float h4 = hash01(29.0 * 173.0 + pid * 19.17 + 4.0);
  float h5 = hash01(29.0 * 173.0 + pid * 19.17 + 5.0);
  float h6 = hash01(29.0 * 173.0 + pid * 19.17 + 6.0);
  float h7 = hash01(29.0 * 173.0 + pid * 19.17 + 7.0);
  float h8 = hash01(29.0 * 173.0 + pid * 19.17 + 8.0);
  // the windows, duplicated from galform.js and pinned by the test
  float starts[2] = float[2](0.60, 0.84);
  float durs[2] = float[2](0.20, 0.14);
  float win = floor(h1 * 2.0);
  float start = starts[0] + win * (starts[1] - starts[0]);
  float dur = durs[0] + win * (durs[1] - durs[0]);
  float l = h2 * 0.5;
  float sigma = h3 < 0.5 ? 1.0 : -1.0;
  float alpha = (h4 - 0.5) * 0.5;
  float s = 0.7 + 0.6 * h5;
  float Hmax = 0.55 + 0.5 * h6;
  float size = 0.5 + 0.7 * h7;
  float b = 0.18 + 0.2 * h8;
  float q = (uU - (start + l * dur)) / (dur * 0.9);
  float live = step(0.0, q) * step(q, 1.0);
  float hh = sin(3.14159265 * pow(clamp(q, 0.0, 1.0), 0.8)) * Hmax * s;
  float a = sm(q / 0.10) * sm((1.0 - q) / 0.25) * b * live;
  if (a <= 0.004) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vColor = vec4(0.0); return; }
  float X = uPanel.x * 0.5 + sin(alpha) * hh * 0.6 * uR;
  float Y = uPanel.y * 0.5 - sigma * cos(alpha) * hh * uR;
  float prad = clamp(size * uR * 0.03 * uDpr, 4.0, 34.0);
  vec2 quadPx = quad * prad;
  X += quadPx.x; Y += quadPx.y;
  gl_Position = vec4((X / uPanel.x) * 2.0 - 1.0, 1.0 - (Y / uPanel.y) * 2.0, 0.0, 1.0);
  vec3 col = vec3(0.72, 0.84, 1.0);                   // the wind is blue-white
  vColor = vec4(col * a * uEnv * uBright, a * uEnv * uBright);
  vFbmSeed = pid * 0.211 + q * 1.3;
  vFbmScale = 2.5 + 2.0 * h7;
}`;

const FS_WIND = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in float vFbmSeed;
in float vFbmScale;
out vec4 frag;
${GLSL_HASH}
void main() {
  vec2 d = vUv - 0.5;
  float rr = length(d) * 2.0;
  float edge = 1.0 - sm((rr - 0.55) / 0.45);
  if (edge <= 0.003) discard;
  float n = fbm(vUv * vFbmScale + vFbmSeed * 5.17);
  float dens = clamp((n - 0.30) / 0.70, 0.0, 1.0);
  frag = vec4(vColor.rgb * edge * dens, vColor.a * edge * dens);
}`;

// ------------------------------------------------------------------- the attach
/**
 * Attach the GL layer to a canvas. `canvas` is a DEDICATED webgl2 canvas stacked over the
 * 2D one. Three passes per frame: gas clouds (additive), dust lanes (subtractive -- the
 * same program; the dust sprites' rgb goes negative), fountains (additive). Answers a
 * controller or null; null means "no webgl2 here, run the 2D fallback".
 */
export function formGlAttach(canvas, opts = {}) {
  let gl = null;
  try { gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: opts.preserve === true }); } catch { gl = null; }
  if (!gl) return null;
  const prog = (vs, fs) => {
    const make = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    return p;
  };
  let gas, wind;
  try {
    gas = prog(VS_GAS, FS_GAS);
    wind = prog(VS_WIND, FS_WIND);
  } catch (e) {
    if (opts.onCompileError) opts.onCompileError(e.message);
    return null;
  }
  // a VAO even with no attributes: some drivers require one bound
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);          // additive; the dust subtracts by rgb sign
  const uni = (p) => ({
    panel: gl.getUniformLocation(p, 'uPanel'),
    u: gl.getUniformLocation(p, 'uU'),
    bright: gl.getUniformLocation(p, 'uBright'),
    env: gl.getUniformLocation(p, 'uEnv'),
    r: gl.getUniformLocation(p, 'uR'),
    cs: gl.getUniformLocation(p, 'uCs'),
    sn: gl.getUniformLocation(p, 'uSn'),
    dpr: gl.getUniformLocation(p, 'uDpr'),
  });
  const ug = uni(gas), uw = uni(wind);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); st.dead = true; opts.onLost?.(); });
  const CLOUDS = opts.gasCount ?? 6000;  // clouds (not points): each is a textured quad
  const st = { gl, gas, wind, ug, uw, vao, dead: false };
  return {
    /** One frame. pw/ph in CSS pixels, dpr the device ratio, now the sky's clock (ms). */
    draw(pw, ph, dpr, now, o = {}) {
      if (st.dead) return false;
      const W = Math.max(1, Math.round(pw * dpr)), H = Math.max(1, Math.round(ph * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const speed = Number.isFinite(o.formSpeed) ? Math.max(0, Math.min(4, o.formSpeed)) : 1;
      const u = speed > 0 ? ((now * speed) / (1000 * C.FORM_CYCLE)) % 1 : 0.86;
      const env = Math.pow(Math.max(0, Math.min(1, Math.min(u, 1 - u) / 0.05)), 2);
      const bright = Number.isFinite(o.starBrightness) ? Math.min(1.5, Math.max(0, o.starBrightness)) : 1;
      const zoom = 0.52 + (1 - 0.52) * (function (t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); })(u / C.FORM_ZOOM_IN);
      const R = Math.min(pw, ph) * C.DISC_SHARE * zoom;
      const tilt = -0.32;
      const common = (p, un) => {
        gl.useProgram(p);
        gl.uniform2f(un.panel, W, H);
        gl.uniform1f(un.u, u);
        gl.uniform1f(un.bright, bright);
        gl.uniform1f(un.env, env);
        gl.uniform1f(un.r, R);
        gl.uniform1f(un.cs, Math.cos(tilt));
        gl.uniform1f(un.sn, Math.sin(tilt));
        gl.uniform1f(un.dpr, dpr);
      };
      common(gas, ug);
      gl.drawArrays(gl.TRIANGLES, 0, CLOUDS * 6);
      common(wind, uw);
      gl.drawArrays(gl.TRIANGLES, 0, C.FOUNTAIN_COUNT * 6);
      return true;
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/** Feature probe without keeping a context: answers true where the layer can run. */
export function formGlSupported() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    return true;
  } catch { return false; }
}
