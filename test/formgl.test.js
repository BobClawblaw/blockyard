// THE FORMATION'S GPU LAYER (public/js/formgl.js). v3 is a gas-density FIELD in one fragment
// shader, after the film's main view (black, violet, magenta, orange, pale yellow), not galform.js's
// particles re-expressed -- so what the two engines share is the LOOP (its length, its hold, its
// tilt), and that is what is pinned here, with the shader's structure and the attach contract:
// null when there is no webgl2, no compile, or no graphics card behind the GL; never a throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FORM_CONST, FORM_MAX_PIXELS, FORM_PLACEMENTS, FORM_AT_DEFAULT, FORM_BRIGHTNESS_DEFAULT, FORM_FLOW_DEFAULT, FORM_SPEED_DEFAULT, FORM_RAMP, FORM_PALETTES, FORM_PALETTE_DEFAULT, FORM_PALETTE_LABELS, formRamp, formGlAttach, formGlSupported, isSoftwareGl } from '../public/js/formgl.js';
import { GALAXY_PLACEMENTS } from '../public/js/details3d.js';
import { DEFAULTS, PANEL, skyFor, normalise } from '../public/js/settings.js';
import { FORM_CYCLE, FORM_TILT, FORM_WINDOWS, FORM_HOLD } from '../public/js/galform.js';

const glsl = readFileSync(new URL('../public/js/formgl.js', import.meta.url), 'utf8');

test('the loop is one loop: the GL layer\'s cycle, hold and tilt are galform\'s', () => {
  assert.equal(FORM_CONST.FORM_CYCLE, FORM_CYCLE, 'the cycle length is one number, not two');
  assert.equal(FORM_CONST.FORM_HOLD, FORM_HOLD, 'speed 0 holds the same moment on both engines');
  assert.equal(FORM_CONST.GALAXY_TILT, FORM_TILT, 'the disc leans the same way');
  assert.ok(Array.isArray(FORM_WINDOWS));
  // every tunable reaches the shader through the template, not as a second literal typed by hand
  for (const k of ['ZOOM0', 'ZOOM1', 'HALO_R0', 'HALO_R1', 'GALAXY_R0', 'GALAXY_R1', 'GALAXY_TILT', 'GALAXY_SQUASH', 'ARMS', 'ARM_WIND', 'SPIN', 'STREAM_POW', 'INFLOW', 'SATELLITES', 'FLOW_PULL', 'FLOW_SWIRL', 'STIR', 'DRAG', 'WAKE_STEP']) {
    assert.ok(glsl.includes(`C.${k}`), `${k} is injected into the GLSL`);
  }
  assert.ok(glsl.includes('C.FORM_HOLD'), 'speed 0 places the satellites from FORM_HOLD');
});

test('the shader is the film\'s picture: a density field through a magma ramp, in one full-screen pass', () => {
  assert.ok(glsl.includes('#version 300 es'), 'GLSL ES 3.0');
  assert.equal((glsl.match(/void main\(\) \{/g) || []).length, 2, 'one vertex stage, one fragment stage');
  assert.ok(glsl.includes('gl.drawArrays(gl.TRIANGLES, 0, 3)'), 'a single full-screen triangle, from gl_VertexID');
  // INTS ARE MEDIUMP IN A FRAGMENT SHADER UNLESS TOLD. The noise hash is 32-bit arithmetic; without
  // this line the first cut drew television static (2026-09-21), on a driver that honours mediump.
  assert.match(glsl, /precision highp float;\s*\n\s*precision highp int;/);
  // the ramp runs black -> indigo -> violet -> magenta -> salmon -> orange -> pale yellow: blue is
  // ahead of red at the dark end and red ahead of blue at the bright end, and it never goes grey
  // (ONE ramp: the shader's magma() is generated from FORM_RAMP, and the 2D fallback tints through formRamp)
  assert.match(glsl, /uniform vec4 uRamp\[7\];/, 'the ramp is a uniform fed from FORM_PALETTES: one definition, and a palette is a setting, not a recompile');
  // (the FILM'S ramp, magma -- which is no longer the shipped palette, but is still what this test describes)
  const stops = FORM_PALETTES.magma.map(([, c]) => c);
  assert.deepEqual(formRamp(0), [0, 0, 0]);
  assert.deepEqual(formRamp(1, 'magma'), FORM_PALETTES.magma.at(-1)[1].map((v) => Math.round(v * 255)));
  assert.deepEqual(formRamp(0.24, 'magma'), [0, 1, 2].map((i) => Math.round(((FORM_PALETTES.magma[1][1][i] + FORM_PALETTES.magma[2][1][i]) / 2) * 255)), 'halfway between two stops');
  assert.deepEqual(formRamp(1), FORM_RAMP.at(-1)[1].map((v) => Math.round(v * 255)), 'and with no palette named, the shipped one');
  assert.equal(stops.length, 7);
  assert.deepEqual(stops[0], [0, 0, 0], 'nothing is black');
  assert.ok(stops[1][2] > stops[1][0] * 2 && stops[2][2] > stops[2][0], 'thin gas is violet');
  assert.ok(stops[5][0] > 0.9 && stops[5][0] > stops[5][2] * 2, 'dense gas is orange');
  assert.ok(stops[6].every((v) => v > 0.75) && stops[6][0] >= stops[6][2], 'only the galaxy is pale yellow');
  for (let i = 1; i < 7; i++) assert.ok(stops[i][0] + stops[i][1] + stops[i][2] > stops[i - 1][0] + stops[i - 1][1] + stops[i - 1][2], 'and it only ever brightens');
  // gas tops out at orange; the ramp's pale end is for stars alone
  assert.match(glsl, /float tGas = \(1\.0 - exp\(-gas \* [\d.]+\)\) \* 0\.84;/);
  const code = glsl.replace(/\/\/.*$/gm, '');
  assert.ok(!code.includes('Math.random'), 'no Math.random in code');
  assert.ok(FORM_MAX_PIXELS <= 1_500_000, 'the field is drawn at a capped size and stretched');
});

test('the gas FLOWS: two cross-fading advection layers on the wall clock, whatever the loop does', () => {
  // (operator, 2026-09-21: "I'm not seeing any shifting of the filaments") -- the first cut slid its
  // noise at a hundredth of a cell a second. What is pinned: the smoke is sampled at a position that
  // is pulled in and swirled, in two layers half a life apart whose weights always sum to one, fed
  // from the CPU as fractions so the card never sees a big clock, and running at speed 0 too.
  assert.match(glsl, /for \(int L = 0; L < 2; L\+\+\)/);
  assert.match(glsl, /float wgt = 1\.0 - abs\(2\.0 \* ph - 1\.0\);/);
  assert.match(glsl, /exp\(\$\{F\(C\.FLOW_PULL\)\} \* f\)/);
  const uniforms = [], gl2f = [];
  const gl = new Proxy({}, { get: (_t, k) => (typeof k !== 'string' ? undefined : /^[A-Z_0-9]+$/.test(k) ? k
    : k === 'getShaderParameter' || k === 'getProgramParameter' ? () => true
    : k === 'getUniformLocation' ? (_p, n) => n
    : k === 'getExtension' ? () => null : k === 'getParameter' ? () => 'Apple M2'
    : (...a) => { if (k === 'uniform4f' || k === 'uniform1f') uniforms.push([k, ...a]); if (k === 'uniform2f' && String(a[0]).startsWith('uSat')) gl2f.push([a[1], a[2]]); return {}; }) });
  const canvas = { width: 0, height: 0, getContext: () => gl, addEventListener() {} };
  const ctl = formGlAttach(canvas);
  assert.ok(ctl);
  const flowAt = (now, formSpeed) => { uniforms.length = 0; ctl.draw(800, 450, 1, now, { formSpeed }); return uniforms.find((c) => c[1] === 'uFlow').slice(2); };
  for (const speed of [0, 1]) {
    const a = flowAt(3_600_000_000, speed), b = flowAt(3_600_002_000, speed);           // six weeks of uptime
    for (const f of [a, b]) {
      assert.ok(f[0] >= 0 && f[0] < 1 && f[1] >= 0 && f[1] < 1, 'phases are fractions');
      const w = (ph) => 1 - Math.abs(2 * ph - 1);
      assert.ok(Math.abs(w(f[0]) + w(f[1]) - 1) < 1e-9, 'the two layers\' weights sum to one: no pulse as they trade places');
      assert.ok(f[2] < 64 && f[3] < 65, 'the cycle numbers stay small');
    }
    assert.notEqual(a[0], b[0], `two seconds on, the flow has moved (speed ${speed})`);
  }
  // PERPETUAL (operator, 2026-09-21: "have the scene perpetually evolving. don't fade it out"): there
  // is no fade uniform at all, the galaxy is grown from the first millisecond, every satellite is
  // somewhere in a life of its own, out of step with the others, and its next life is another orbit
  assert.ok(!/uEnv|FORM_FADE/.test(glsl), 'no envelope');
  const satsAt = (now) => { uniforms.length = 0; gl2f.length = 0; ctl.draw(800, 450, 1, now, { formSpeed: 1 }); return gl2f.slice(); };
  const first = satsAt(0), later = satsAt(3_600_000_000), muchLater = satsAt(3_600_000_000 + 400_000);
  assert.equal(first.length, FORM_CONST.SATELLITES);
  assert.ok(new Set(first.map((v) => v[0].toFixed(3))).size === FORM_CONST.SATELLITES, 'out of step from the start');
  for (const v of [...first, ...later]) assert.ok(v[0] >= 0 && v[0] < 1 && v[1] >= 0 && v[1] < 97);
  assert.ok(later.some((v, i) => v[1] !== muchLater[i][1]), 'lives turn over: another orbit each time');
  uniforms.length = 0; ctl.draw(800, 450, 1, 0, { formSpeed: 1 });
  assert.ok(uniforms.find((c) => c[1] === 'uGrow')[2] >= 0.8, 'grown at time zero: nothing to fade in from');
  // the panel is capped and stretched
  ctl.draw(2560, 1300, 2, 1000, {});
  assert.ok(canvas.width * canvas.height <= FORM_MAX_PIXELS * 1.01);
});

test('it fills the panel, the satellites shed gas, the galaxies blow shells, and the gas is turbulent', () => {
  // (operator, 2026-09-21: "The rotating satellites do not emit any plasma ... it needs to take up
  // more horizontal space ... extend to the extents of the larger display. I'm not getting as much
  // sense of motion or turbulence like the video")
  // THE WIDTH: the halo, the streams' reach and the dark corners are measured against the panel's aspect
  assert.match(glsl, /float wide = max\(1\.0, \$\{F\(C\.WIDE\)\} \* uPanel\.x \/ uPanel\.y\);/);
  assert.match(glsl, /float halo = exp\(-pow\(length\(pe \*/);
  assert.match(glsl, /streams \*= exp\(-re \*/);
  // THE JOSTLE moves the gas and nothing else: the galaxy and the satellites are placed from p, the smoke from pj
  assert.match(glsl, /vec2 pj = p \+ \$\{F\(C\.TURB_AMP\)\}/);
  assert.match(glsl, /vec2 pf = vec2\(ca \* pj\.x - sa \* pj\.y/);
  assert.match(glsl, /vec2 e = p - c;/);
  // ...and THE SATELLITES MOVE THE GAS: the smoke's own sampling place is turned round each one and
  // dragged along its path (and, weaker, where it has just been) BEFORE the smoke is looked up
  assert.ok(glsl.indexOf('pj += (vec2(-d.y, d.x) * ${F(C.STIR)} - tg * sg * ${F(C.DRAG)}) * g;') > 0);
  assert.ok(glsl.indexOf('pj += (vec2(-d.y, d.x)') < glsl.indexOf('smoke(pf, off, ph, w1, f1, s1);'), 'stirred first, sampled after');
  // a wake sample is never narrower than the gap to the last one (it was a string of beads far out)
  assert.match(glsl, /float sj = max\(size \* \([\d.]+ \+ [\d.]+ \* fj\), [\d.]+ \* length\(cj - prev\)\);/);
  // clumps run DOWN the streams with the layer's phase; a wake of WAKE samples lies where a satellite has been;
  // every satellite and the galaxy itself blow ragged shells on the burst clock
  assert.match(glsl, /rk \* 5\.0 \+ ph \* \$\{F\(C\.RUN\)\}/);
  assert.match(glsl, /for \(int j = 1; j <= \$\{C\.WAKE\}; j\+\+\)/);
  assert.ok((glsl.match(/fract\(uBurst/g) || []).length >= 2, 'satellites and the galaxy both burst');
  assert.ok(FORM_CONST.WAKE >= 10 && FORM_CONST.TURB > 0 && FORM_CONST.BURST_PERIOD > 3);
});

test('a satellite ARRIVES: from beyond the frame, its cloud eased up slowly, its knot condensing later', () => {
  // (operator, 2026-09-21: "the gas satellites pop into view at the edges and it looks bad. They need
  // to gradually fade in instead")
  assert.ok(FORM_CONST.SAT_R0 >= 1.3, 'a life begins outside a 16:9 frame\'s short side, not inside it');
  assert.ok(FORM_CONST.SAT_HAZE_IN >= 0.3 && FORM_CONST.SAT_KNOT_IN > FORM_CONST.SAT_HAZE_IN, 'the cloud first, over a long stretch; the knot after');
  assert.ok(FORM_CONST.SAT_HAZE_IN * FORM_CONST.SAT_LIFE * 0.75 >= 20, 'twenty seconds at the least, for the quickest of them');
  assert.match(glsl, /float hazeIn = smoothstep\(0\.0, \$\{F\(C\.SAT_HAZE_IN\)\}, a\); hazeIn \*= hazeIn;/, 'eased: there is no moment it starts');
  assert.match(glsl, /sats \+= knot \* [\d.]+ \* knotFade;/);
  // the stir comes up with the cloud, or the gas would be wrenched by something not yet there
  assert.match(glsl, /float fadeK = smoothstep\(0\.0, \$\{F\(C\.SAT_HAZE_IN\)\}, a\)/);
  // and the merger's flash has no step where one life hands over to the next
  assert.match(glsl, /arrive \+= a < 0\.5 \? exp\(-a \* 14\.0\) : smoothstep\(0\.93, 1\.0, a\);/);
});

test('the galaxy sits in the middle or in any corner: the Galaxy sky\'s own five places', () => {
  // (operator, 2026-09-21: "We need to be able to put the formation center either in the center like
  // it is now, or the corners like the other options")
  assert.deepEqual(Object.keys(FORM_PLACEMENTS), Object.keys(GALAXY_PLACEMENTS), 'one vocabulary of places');
  for (const [k, v] of Object.entries(FORM_PLACEMENTS)) {
    assert.deepEqual(v.slice(0, 2), GALAXY_PLACEMENTS[k].slice(0, 2), `${k}: the same fractions of the panel`);
    assert.ok(k === 'center' ? v[2] === 1 : v[2] > 1.3, 'in a corner the scene is drawn larger: it has the diagonal to reach across');
  }
  // THE SHIPPED PLACE, PACE AND LEVEL ARE THE OPERATOR'S OWN (read from their saved settings, 2026-09-21:
  // "make those the default settings. It was originally too bright and was threatening to overpower the
  // chart"): in a corner, under full brightness, slow. The layer's own fall-backs are the same numbers.
  // (brightness was 0.8 while the palette was magma; on 2026-09-22, with Cobalt & gold, the operator set it to 1)
  assert.deepEqual([DEFAULTS.sky.formAt, DEFAULTS.sky.formBrightness, DEFAULTS.sky.formFlow, DEFAULTS.sky.formSpeed], ['bottom-left', 1, 0.5, 0.4]);
  assert.deepEqual([FORM_AT_DEFAULT, FORM_BRIGHTNESS_DEFAULT, FORM_FLOW_DEFAULT, FORM_SPEED_DEFAULT], ['bottom-left', 1, 0.5, 0.4], 'one set of numbers, not two');
  const row = PANEL.find((g) => g.group === 'sky').rows.find((r) => r.key === 'formAt');
  assert.deepEqual(row.options.map((o) => o[0]), Object.keys(FORM_PLACEMENTS), 'the panel offers exactly the places there are');
  assert.equal(skyFor(normalise({ sky: { formAt: 'top-right' } }), 'space').formAt, 'top-right', 'and it reaches the board');
  assert.equal(normalise({ sky: { formAt: 'the moon' } }).sky.formAt, 'bottom-left');
  // the place reaches the shader, top-left fractions turned to GL's bottom-left; an unknown place is the middle
  const sent = [];
  const gl = new Proxy({}, { get: (_t, k) => (typeof k !== 'string' ? undefined : /^[A-Z_0-9]+$/.test(k) ? k
    : k === 'getShaderParameter' || k === 'getProgramParameter' ? () => true : k === 'getUniformLocation' ? (_p, n) => n
    : k === 'getExtension' ? () => null : k === 'getParameter' ? () => 'Apple M2'
    : (...a) => { if (k === 'uniform3f') sent.push(a); return {}; }) });
  const ctl = formGlAttach({ width: 0, height: 0, getContext: () => gl, addEventListener() {} });
  ctl.draw(800, 450, 1, 5000, { formAt: 'top-right' }); ctl.draw(800, 450, 1, 5000, { formAt: 'nowhere' }); ctl.draw(800, 450, 1, 5000, {});
  assert.deepEqual(sent.map((a) => a.slice(1)), [[0.78, 0.22, 1.55], [0.22, 0.78, 1.55], [0.22, 0.78, 1.55]], 'an unknown place, or none, is the shipped one (bottom left)');
  assert.match(glsl, /vec2\(uPlace\.x, 1\.0 - uPlace\.y\) \* uPanel/);
});

test('two sliders: brightness (1 is the full picture, it ships under it) and the flow\'s own pace', () => {
  // (operator, 2026-09-21: "A slider for dimming things. the current brightness should be set at 1. I want
  // the current values cut half in brightness, and set the bar default to 0.5. Also, I want another slider
  // to speed up or slow down the current animation")
  assert.equal(DEFAULTS.sky.formBrightness, FORM_BRIGHTNESS_DEFAULT);
  assert.equal(DEFAULTS.sky.formFlow, FORM_FLOW_DEFAULT);
  const rows = PANEL.find((g) => g.group === 'sky').rows;
  const br = rows.find((r) => r.key === 'formBrightness'), fl = rows.find((r) => r.key === 'formFlow');
  assert.ok(br.kind === 'range' && br.min > 0 && br.min <= 0.1 && br.max >= 1, 'it can be dimmed nearly out and brought back to the full picture');
  assert.ok(fl.kind === 'range' && fl.min === 0 && fl.max >= 3, 'stilled, or several times as fast');
  const sky = skyFor(normalise({ sky: { formBrightness: 0.8, formFlow: 2.5 } }), 'markets');
  assert.equal(sky.formBrightness, 0.8); assert.equal(sky.formFlow, 2.5);
  // IT DIMS THE COLOUR, NOT THE DENSITY: halving the tone would slide orange down the ramp to magenta
  assert.match(glsl, /vec3 col = magma\(tone\) \* clamp\(uBright, 0\.0, 1\.5\);/);
  assert.ok(!/tone = pow\(tone, [\d.]+\) \* [^;]*uBright/.test(glsl));

  const sent = [];
  const gl = new Proxy({}, { get: (_t, k) => (typeof k !== 'string' ? undefined : /^[A-Z_0-9]+$/.test(k) ? k
    : k === 'getShaderParameter' || k === 'getProgramParameter' ? () => true : k === 'getUniformLocation' ? (_p, n) => n
    : k === 'getExtension' ? () => null : k === 'getParameter' ? () => 'Apple M2'
    : (...a) => { if (k === 'uniform1f' || k === 'uniform4f') sent.push([a[0], ...a.slice(1)]); return {}; }) });
  const mk = () => formGlAttach({ width: 0, height: 0, getContext: () => gl, addEventListener() {} });
  const frame = (ctl, now, o) => { sent.length = 0; ctl.draw(800, 450, 1, now, o); const f = sent.find((c) => c[0] === 'uFlow'); return { bright: sent.find((c) => c[0] === 'uBright')[1], tau: f[3] + f[1] }; };
  // brightness: what is asked for, clamped; nothing asked for is the shipped half
  let ctl = mk();
  assert.equal(frame(ctl, 1000, {}).bright, FORM_BRIGHTNESS_DEFAULT);
  assert.equal(frame(ctl, 1100, { formBrightness: 1 }).bright, 1);
  assert.equal(frame(ctl, 1200, { formBrightness: 9 }).bright, 1.5);
  // THE PACE CHANGES, THE SCENE DOES NOT JUMP: an hour in, the slider goes from 1 to 1.1 between two
  // frames a sixtieth of a second apart. A clock that is now x speed would leap six minutes of flow.
  ctl = mk();
  const HOUR = 3_600_000, P = FORM_CONST.FLOW_PERIOD;
  const a = frame(ctl, HOUR, { formFlow: 1 }), b = frame(ctl, HOUR + 16, { formFlow: 1.1 });
  const moved = (((b.tau - a.tau) % 64) + 64) % 64;
  assert.ok(Math.abs(moved - (0.016 * 1.1) / P) < 1e-6, `one frame's worth of flow, at the new pace (${moved * P} s)`);
  // stilled: the flow's clock stops, and starts again from where it was
  const c0 = frame(ctl, HOUR + 1016, { formFlow: 0 }), c1 = frame(ctl, HOUR + 61016, { formFlow: 0 });
  assert.equal(c1.tau, c0.tau, 'a minute at flow 0: not a hair');
  const d = frame(ctl, HOUR + 62016, { formFlow: 2 });
  assert.ok(Math.abs(((((d.tau - c1.tau) % 64) + 64) % 64) - 2 / P) < 1e-6, 'a second at flow 2 is two seconds of gas');
  // and a FRESH layer is a pure function of the clock (the preview script and these tests lean on it)
  assert.deepEqual(frame(mk(), 123456, { formFlow: 1.7 }), frame(mk(), 123456, { formFlow: 1.7 }));
});

test('the palettes: thirteen, the film\'s the default, and none of the twelve new ones is a chart colour', async () => {
  // (operator, 2026-09-21: "Suggest a dozen different color schemes ... Make sure it doesn't clash with the
  // chart too badly. The chart is the most important visual")
  const { scorePalette } = await import('../scripts/form-palettes.mjs');
  const names = Object.keys(FORM_PALETTES);
  // THE SHIPPED ONE IS THE OPERATOR'S (2026-09-22: "make Cyan and Gold the new default" -- cobaltGold in their saved
  // settings): it is among the farthest from every chart colour, where the film's magma is the nearest
  assert.equal(names.length, 13); assert.equal(FORM_PALETTE_DEFAULT, 'cobaltGold'); assert.equal(FORM_RAMP, FORM_PALETTES.cobaltGold);
  assert.ok(scorePalette(FORM_PALETTE_DEFAULT).worst >= 80, 'the default leaves the chart alone');
  for (const n of names) {
    const p = FORM_PALETTES[n];
    assert.equal(p.length, 7, n);
    assert.deepEqual(p.map((st) => st[0]), FORM_PALETTES.magma.map((st) => st[0]), `${n}: the same places on the ramp`);
    assert.deepEqual(p[0][1], [0, 0, 0], `${n}: nothing is black`);
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    for (let i = 1; i < 7; i++) assert.ok(lum(p[i][1]) > lum(p[i - 1][1]), `${n}: it only ever brightens (stop ${i})`);
  }
  // measured against the candles' green and red and the yellow line, in CIELAB, across the whole gas range
  assert.ok(scorePalette('magma').red < 25, 'the film\'s own ramp IS close to the candles\' red: that is the clash the operator saw');
  for (const n of names.filter((x) => x !== 'magma')) {
    const sc = scorePalette(n);
    assert.ok(sc.worst >= 40, `${n}: its gas stays well away from every chart colour (nearest ${sc.worst.toFixed(0)})`);
    assert.ok(sc.gasL <= 60, `${n}: and its densest gas is no lighter than the chart's own colours (L* ${sc.gasL.toFixed(0)})`);
  }
  // THE PICKER (operator, 2026-09-21: "I don't see a drop-down to change the pallete anywhere" -- it had been held
  // back for a shortlist nobody could draw up without trying them): every palette, no more, the film's first
  const row = PANEL.find((g) => g.group === 'sky').rows.find((r) => r.key === 'formPalette');
  assert.equal(row.kind, 'choice');
  assert.deepEqual(row.options.map((o) => o[0]).sort(), [...names].sort(), 'the picker lists exactly the palettes there are');
  assert.equal(row.options[0][0], FORM_PALETTE_DEFAULT, 'the shipped one first');
  assert.deepEqual(row.options.find((o) => o[0] === 'magma'), ['magma', 'Magma'], 'plain Magma: no "(the film)"');
  assert.deepEqual(FORM_PALETTE_LABELS.map((o) => o[0]), row.options.map((o) => o[0]));
  assert.equal(DEFAULTS.sky.formPalette, FORM_PALETTE_DEFAULT);
  assert.equal(skyFor(normalise({ sky: { formPalette: 'cobaltGold' } }), 'markets').formPalette, 'cobaltGold', 'and it reaches the board');
  assert.equal(normalise({ sky: { formPalette: 'beige' } }).sky.formPalette, 'cobaltGold');
  // the palette reaches the shader as a uniform, and an unknown one is the default
  const sent = [];
  const gl = new Proxy({}, { get: (_t, k) => (typeof k !== 'string' ? undefined : /^[A-Z_0-9]+$/.test(k) ? k
    : k === 'getShaderParameter' || k === 'getProgramParameter' ? () => true : k === 'getUniformLocation' ? (_p, n) => n
    : k === 'getExtension' ? () => null : k === 'getParameter' ? () => 'Apple M2'
    : (...a) => { if (k === 'uniform4fv' && a[0] === 'uRamp[0]') sent.push([...a[1]]); return {}; }) });
  const ctl = formGlAttach({ width: 0, height: 0, getContext: () => gl, addEventListener() {} });
  ctl.draw(800, 450, 1, 1000, { formPalette: 'abyss' }); ctl.draw(800, 450, 1, 1100, { formPalette: 'no such' }); ctl.draw(800, 450, 1, 1200, {});
  assert.equal(sent[0].length, 28);
  assert.ok(Math.abs(sent[0][4 * 5 + 3] - 214 / 255) < 1e-6, 'abyss: its densest gas is blue');
  assert.deepEqual(sent[1], sent[2]); assert.ok(Math.abs(sent[1][4 * 5 + 3] - 222 / 255) < 1e-6, 'the default\'s densest gas is cobalt');
  assert.deepEqual(formRamp(0.85, 'abyss'), [84, 158, 214]);
});

test('a software rasteriser is not a graphics card: the layer declines and the 2D sky draws', () => {
  for (const n of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 17.0.6, 256 bits)', 'Microsoft Basic Render Driver']) assert.equal(isSoftwareGl(n), true, n);
  for (const n of ['ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA GeForce RTX 5090), NVIDIA)', 'Apple M2', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', '', undefined]) assert.equal(isSoftwareGl(n), false, String(n));
  let lostIt = false;
  const gl = { getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 1 } : n === 'WEBGL_lose_context' ? { loseContext() { lostIt = true; } } : null), getParameter: () => 'SwiftShader' };
  assert.equal(formGlAttach({ getContext: () => gl, addEventListener() {} }), null);
  assert.equal(lostIt, true, 'and it gives the context back');
});

test('attach answers null, never throws, where there is no webgl2', () => {
  // In this process there is no DOM at all: document is undefined, so the probe must not
  // even reach getContext. The contract: formGlSupported false, formGlAttach null.
  assert.equal(formGlSupported(), false, 'no webgl2 in a DOM-less node process');
  assert.equal(formGlAttach({ getContext: () => null, addEventListener() {} }), null, 'a null context is null, not a throw');
  assert.equal(
    formGlAttach({ getContext: () => { throw new Error('boom'); }, addEventListener() {} }),
    null,
    'a throwing context is null, not a throw',
  );
});

test('attach answers null when the shader fails to compile, and the fallback then runs', () => {
  // A stub GL whose getShaderParameter always says no: attach must swallow the failure and
  // answer null, which is the signal details3d reads to paint the 2D layer instead.
  const mk = () => ({
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => false,
    getShaderInfoLog: () => 'synthetic failure',
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => false,
    getProgramInfoLog: () => '',
    createVertexArray: () => ({}),
    bindVertexArray() {},
    disable() {},
    enable() {},
    blendFunc() {},
    addEventListener() {},
  });
  assert.equal(formGlAttach({ getContext: () => mk(), addEventListener() {} }), null);
});

test('the fallback sky still draws: galform.js stands behind the GL layer', async () => {
  // the 2D renderer is the engine of record wherever webgl2 is absent; its draw must run on
  // a stub context without a GL anything
  const { drawGalaxyForm } = await import('../public/js/galform.js');
  const fills = [];
  const ctx = {
    fillStyle: '',
    beginPath() {},
    arc() { fills.push(this.fillStyle); },
    fill() {},
    fillRect() {},
  };
  drawGalaxyForm(ctx, 800, 500, 1, 60000, { formNoGl: true });
  assert.ok(fills.length > 1200, `the 2D fallback painted (${fills.length} fills)`);
  assert.ok(fills.every((f) => /^rgba\(/.test(f.style ?? f)), 'plain rgba fills only');
});
