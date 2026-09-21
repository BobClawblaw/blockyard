// THE SUN SKY, milestone 1: the disk (docs/PLAN-SUN-SKY.md; operator, 2026-09-21: "a new 3D background for blockyard
// that is an animated simulation of our sun ... rotating very slowly").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sunOmega, sunPeriodDays, limbDarkening, SUN_LIMB_U, SUN_TILT, SUN_RAMP, sunRamp, sunDisk, sunPhases, SUN_CONST,
  SUN_PLACEMENTS, SUN_PLACEMENT_LABELS, SUN_AT_DEFAULT, SUN_BRIGHTNESS_DEFAULT, SUN_SPIN_DEFAULT, SUN_SPIN_MAX, SUN_SIZE_DEFAULT, SUN_SIZE_MIN, SUN_SIZE_MAX,
  isSoftwareGl, sunGlAttach, drawSunSky,
} from '../public/js/sunsky.js';
import { DEFAULTS, PANEL, SKIES, SKY_CHOICES, SKY_LABELS, normalise, skyFor, nextSky } from '../public/js/settings.js';

const rad = (d) => (d * Math.PI) / 180;

test('it turns the way the sun does: faster at the equator than toward the poles, by the measured law', () => {
  assert.ok(Math.abs(sunPeriodDays(0) - 24.47) < 0.05, `the equator in about twenty-four and a half days (${sunPeriodDays(0).toFixed(2)})`);
  assert.ok(sunPeriodDays(rad(60)) > 27.5 && sunPeriodDays(rad(60)) < 28.5, `latitude 60 in about twenty-eight (${sunPeriodDays(rad(60)).toFixed(2)})`);
  for (let lat = 0; lat < 85; lat += 5) assert.ok(sunOmega(rad(lat + 5)) < sunOmega(rad(lat)), 'slower at every step toward the pole');
  assert.equal(sunOmega(rad(30)), sunOmega(rad(-30)), 'the same in both hemispheres');
  assert.ok(Math.abs(SUN_TILT - rad(7.25)) < 1e-12, 'about an axis 7.25 degrees off');
});

test('a hot opaque ball darkens toward its limb: I = 1 - u (1 - mu), u = 0.6', () => {
  assert.equal(limbDarkening(1), 1);
  assert.ok(Math.abs(limbDarkening(0) - (1 - SUN_LIMB_U)) < 1e-12, 'four tenths at the very edge');
  assert.ok(Math.abs(limbDarkening(Math.sqrt(1 - 0.81)) - (1 - 0.6 * (1 - Math.sqrt(0.19)))) < 1e-12, 'at nine tenths of the radius');
  let last = Infinity;
  for (let r = 0; r <= 1; r += 0.05) { const v = limbDarkening(Math.sqrt(Math.max(0, 1 - r * r))); assert.ok(v <= last); last = v; }
  assert.equal(limbDarkening(7), 1); assert.equal(limbDarkening(-1), 1 - SUN_LIMB_U);
});

test('the 171 gold: one ramp, dark bronze to white-hot, read by the shader and the fallback alike', () => {
  assert.equal(SUN_RAMP.length, 7, 'seven stops: the shader declares uRamp[7]');
  assert.deepEqual(SUN_RAMP.map(([t]) => t), [...SUN_RAMP.map(([t]) => t)].sort((a, b) => a - b));
  assert.equal(SUN_RAMP[0][0], 0); assert.equal(SUN_RAMP.at(-1)[0], 1);
  const lum = (c) => 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) { const c = sunRamp(t); assert.ok(lum(c) > prev, 'brighter all the way up'); prev = lum(c); assert.ok(c[0] >= c[1] && c[1] >= c[2], `gold: red over green over blue (${c.map((v) => v.toFixed(2))})`); }
  assert.deepEqual(sunRamp(-3), [...SUN_RAMP[0][1]]); assert.deepEqual(sunRamp(9), [...SUN_RAMP.at(-1)[1]]);
  const src = readFileSync(new URL('../public/js/sunsky.js', import.meta.url), 'utf8');
  assert.match(src, /uniform vec4 uRamp\[7\];/); assert.match(src, /gl\.uniform4fv\(uRampLoc, ramps\[o\.sunChannel\] \?\? ramps\[SUN_CHANNEL_DEFAULT\]\);/);
});

test('the differential shear never winds up: two layers on a sawtooth, cross-faded, their weights summing to one', () => {
  // (advect a texture by omega(lat) for ever and after a few turns it is hairlines along the parallels)
  let maxShear = 0;
  for (let turn = 0; turn < 5000; turn += 7.3) {
    const p = sunPhases(turn);
    assert.ok(Math.abs(p.a[1] + p.b[1] - 1) < 1e-9, 'weights sum to one');
    assert.ok(p.a[1] >= 0 && p.b[1] >= 0);
    assert.ok(p.spin >= 0 && p.spin < Math.PI * 2, 'the turn is wrapped: a float32 never sees a big clock');
    maxShear = Math.max(maxShear, Math.abs(p.a[0]), Math.abs(p.b[0]));
  }
  assert.ok(maxShear < 0.45, `the shear at the pole stays a fraction of a radian (${maxShear.toFixed(3)})`);
  // a layer is at zero weight exactly when it resets, so the reset is never seen
  const atReset = sunPhases(SUN_CONST.SHEAR_PERIOD * 3);
  assert.ok(atReset.a[1] < 1e-9 && Math.abs(atReset.b[1] - 1) < 1e-9);
  // and the poles lag the equator (the law's B is negative): over a layer's life the shear runs from + to -
  const early = sunPhases(SUN_CONST.SHEAR_PERIOD * 3.1).a[0], late = sunPhases(SUN_CONST.SHEAR_PERIOD * 3.9).a[0];
  assert.ok(early > 0 && late < 0, 'the high latitudes fall behind as the layer ages');
  assert.equal(sunPhases(SUN_CONST.TURN_SECONDS).spin < 1e-9 || Math.abs(sunPhases(SUN_CONST.TURN_SECONDS).spin - Math.PI * 2) < 1e-9, true, 'one turn in TURN_SECONDS at sunSpin 1');
});

test('where it sits and how big: behind the board or in a corner, from a small disk to the surface as the whole background', () => {
  // (operator, 2026-09-22, of the first cut: "The sun needs to fill WAY MORE OF THE FRAME! ... we need a slider to be able
  // to make the sun take up the entire screen if we want, and have the entire surface as a background")
  assert.deepEqual(Object.keys(SUN_PLACEMENTS), SUN_PLACEMENT_LABELS.map(([v]) => v));
  const c = sunDisk(1600, 900, 'center', 1);
  assert.deepEqual([c.cx, c.cy], [800, 450]); assert.ok(Math.abs(c.r - 900 * SUN_CONST.RADIUS) < 1e-9, 'sized by the SHORT side: at 1 the whole disk fits with room round it');
  assert.ok(c.r * 2 < 900);
  // the far corner of the panel is inside the disk: the surface covers the panel edge to edge
  const covers = (at, size, w = 1600, h = 900) => { const d = sunDisk(w, h, at, size); return Math.max(...[[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => Math.hypot(x - d.cx, y - d.cy))) < d.r; };
  assert.ok(!covers('center', 1) && covers('center', 4), 'from about 4, behind the board');
  for (const at of Object.keys(SUN_PLACEMENTS)) assert.ok(covers(at, SUN_SIZE_MAX), `${at}: the slider's top covers the panel from anywhere`);
  assert.ok(covers('top-right', SUN_SIZE_MAX, 2560, 1300) && covers('center', SUN_SIZE_MAX, 900, 1600), 'on a wide panel and a tall one');
  assert.ok(!covers('top-right', SUN_SIZE_DEFAULT), 'as shipped it is a great limb across the frame, not yet the whole of it');
  assert.ok(sunDisk(1600, 900, SUN_AT_DEFAULT).r > 900 * 0.8, `and it FILLS the frame: a radius of ${Math.round(sunDisk(1600, 900, SUN_AT_DEFAULT).r)} px on a 900-high panel`);
  assert.deepEqual(sunDisk(1600, 900, 'nowhere', NaN), sunDisk(1600, 900, SUN_AT_DEFAULT, SUN_SIZE_DEFAULT), 'an unknown place or size is the shipped one');
  assert.equal(sunDisk(1600, 900, 'center', 999).r, sunDisk(1600, 900, 'center', SUN_SIZE_MAX).r); assert.equal(sunDisk(1600, 900, 'center', -1).r, sunDisk(1600, 900, 'center', SUN_SIZE_MIN).r);
  // a closer sun shows finer structure, it is not a blown-up picture: the granulation comes in with the pixels
  const src = readFileSync(new URL('../public/js/sunsky.js', import.meta.url), 'utf8');
  assert.match(src, /float gf = freq \* 5\.5, gw = smoothstep\(4\.0, 12\.0, px \/ gf\);/);
});

test('it is a sky like the others: in the pickers, with its three controls, and its shipped numbers pinned to the module', () => {
  assert.ok(SKIES.includes('sun') && SKY_CHOICES.some(([v, l]) => v === 'sun' && l === 'Sun') && SKY_LABELS.sun === 'Sun');
  assert.deepEqual(SKIES, SKY_CHOICES.map(([v]) => v));
  let v = 'galaxy'; const ring = []; for (let i = 0; i < SKIES.length; i++) { ring.push(v); v = nextSky(v); }
  assert.ok(ring.includes('sun') && v === 'galaxy', 'the games\' one-button switch reaches it and comes back round');
  assert.deepEqual([DEFAULTS.sky.sunAt, DEFAULTS.sky.sunBrightness, DEFAULTS.sky.sunSpin, DEFAULTS.sky.sunSize], [SUN_AT_DEFAULT, SUN_BRIGHTNESS_DEFAULT, SUN_SPIN_DEFAULT, SUN_SIZE_DEFAULT]);
  const size = PANEL.find((g) => g.group === 'sky').rows.find((r) => r.key === 'sunSize');
  assert.deepEqual([size.kind, size.min, size.max], ['range', SUN_SIZE_MIN, SUN_SIZE_MAX]);
  assert.equal(SUN_BRIGHTNESS_DEFAULT, 0.6, 'the operator\'s answer to the plan: "Ship dimmer ... so the chart always wins"');
  const rows = PANEL.find((g) => g.group === 'sky').rows;
  const spin = rows.find((r) => r.key === 'sunSpin'), br = rows.find((r) => r.key === 'sunBrightness'), at = rows.find((r) => r.key === 'sunAt');
  assert.ok(spin.kind === 'range' && spin.min === 0 && spin.max === SUN_SPIN_MAX && br.kind === 'range' && at.kind === 'choice');
  assert.deepEqual(at.options.map(([o]) => o), Object.keys(SUN_PLACEMENTS));
  // a control that skyFor does not pass on is a dead control
  const n = normalise({ sky: { sunAt: 'bottom-left', sunBrightness: 0.9, sunSpin: 3, sunSize: 7 }, markets: { sky: 'sun' } });
  const o = skyFor(n, 'markets');
  assert.deepEqual([o.sky, o.skyType, o.stars, o.sunAt, o.sunBrightness, o.sunSpin, o.sunSize], ['sun', 'sun', true, 'bottom-left', 0.9, 3, 7]);
  const bad = normalise({ sky: { sunAt: 'bogus', sunBrightness: 99, sunSpin: -4 } });
  assert.deepEqual([bad.sky.sunAt, bad.sky.sunBrightness, bad.sky.sunSpin], [SUN_AT_DEFAULT, 1.5, 0], 'nonsense is clamped or sent home');
});

test('the shader: 32-bit hashes told to be 32-bit, band-limited, no backtick in it, and loud when it will not compile', () => {
  const src = readFileSync(new URL('../public/js/sunsky.js', import.meta.url), 'utf8');
  const fs = src.slice(src.indexOf('const FS = `') + 12, src.indexOf('}`;', src.indexOf('const FS = `')));
  assert.equal((fs.match(/`/g) || []).length, 0, 'a backtick in a GLSL comment ends the template (it has, three times)');
  assert.match(fs, /precision highp int;/, 'or the hash is mediump and the picture is static');
  assert.ok(!/\bfloat (patch|sample|filter|input|output|common|partition|active)\b/.test(fs), 'no GLSL reserved word as a name');
  assert.match(fs, /smoothstep\(2\.5, 8\.0, px\)/, 'an octave under a few pixels a cell is faded out');
  assert.match(fs, /float net = smoothstep\(2\.0, 6\.0, px \/ freq\);/, 'and the network is drawn only where a cell is more than a few pixels');
  assert.match(fs, /float limb = 1\.0 - \$\{F\(SUN_LIMB_U\)\} \* \(1\.0 - z\);/, 'the limb law, in the shader FROM the same constant limbDarkening() uses');
  assert.match(fs, /shear\.x \* s2/, 'the shear goes with sin^2 of the latitude');
  assert.match(src, /globalThis\.__blockyardGlErrors\?\.push\(log\); console\.warn/, 'a failed compile is logged, not only fallen back from');
  assert.match(src, /if \(st\.at == null \|\| nowS < st\.at\) st\.turn = nowS \* spin; else st\.turn \+= \(nowS - st\.at\) \* spin;/, 'the clock is integrated: a slider changes the pace, never the place');
  assert.ok(isSoftwareGl('Google SwiftShader') && isSoftwareGl('llvmpipe (LLVM 15)') && !isSoftwareGl('ANGLE (NVIDIA, Vulkan ...)'));
  assert.equal(sunGlAttach({ getContext: () => null }), null, 'no WebGL2: null, and the caller draws the fallback');
  assert.equal(sunGlAttach({ getContext: () => { throw new Error('blocklisted'); } }), null);
});

test('the fallback is the same disk in the same gold, in plain fills; and the renderer hosts it on the Formation\'s seam', () => {
  const calls = [];
  const grads = [];
  const ctx = {
    set fillStyle(v) { calls.push(['fillStyle', v]); }, beginPath() {}, fill() { calls.push(['fill']); },
    arc(x, y, r) { calls.push(['arc', x, y, r]); },
    createRadialGradient(...a) { const g = { a, stops: [], addColorStop(t, c) { this.stops.push([t, c]); } }; grads.push(g); return g; },
  };
  let starred = null;
  drawSunSky(ctx, 1600, 900, 1, 0, { sunAt: 'center', sunBrightness: 1, sunSize: 1, sunActivity: false }, { drawStars: (o) => { starred = o; } });
  assert.ok(starred && starred.galaxy === false && starred.nebulae === false, 'the star field first, without the galaxy');
  const d = sunDisk(1600, 900, 'center', 1);
  const arcs = calls.filter((c) => c[0] === 'arc');
  assert.deepEqual(arcs.map((c) => Math.round(c[3])), [Math.round(d.r * SUN_CONST.CORONA), Math.round(d.r)], 'the glow, then the disk over it');
  const disk = grads[1].stops, rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
  const lum = (c) => 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2];
  // (darkening out to seven tenths of the radius; then the thin hot atmosphere, seen edge-on, BRIGHTENS the rim -- as it
  // does in the 171 channel, and in the shader)
  for (let i = 1; i <= 7; i++) assert.ok(lum(rgb(disk[i][1])) <= lum(rgb(disk[i - 1][1])) + 1, 'darkening toward the limb');
  assert.ok(lum(rgb(disk[10][1])) > lum(rgb(disk[7][1])), 'and a bright rim');
  assert.ok(grads[0].stops.at(-1)[1].endsWith(',0)'), 'the glow ends at nothing');
  // with activity on, the fallback has the active regions too, as soft glows where sunRegions puts them (no loops: those are the shader's)
  { const n0 = calls.filter((c) => c[0] === 'arc').length; drawSunSky(ctx, 1600, 900, 1, 250000, { sunAt: 'center', sunBrightness: 1, sunSize: 1 }, {});
    assert.ok(calls.filter((c) => c[0] === 'arc').length > n0 + 2, 'glows over the disk'); }
  // a context with no gradients (a test stub) gets flat fills, not a throw
  drawSunSky({ set fillStyle(v) {}, beginPath() {}, arc() {}, fill() {} }, 800, 600, 1, 0, {});
  const d3 = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(d3, /sun: \{ attach: sunGlAttach, supported: sunGlSupported, dead: SUN_DEAD,/);
  assert.match(d3, /if \(st && st\.kind !== opts\.skyType\) \{ dropFormGl\(ctx\); st = null; \}/, 'switching between the two field skies drops the other\'s layer first');
  assert.match(d3, /opts\.sunAt, opts\.sunActivity !== false, opts\.sunEruptions !== false, opts\.sunProminences !== false, opts\.sunCycle, opts\.sunChannel, opts\.sunDetail, opts\.sunSize, opts\.sunBrightness, opts\.sunSpin,/, 'and a parked board repaints when a Sun setting changes');
});

test('SOLAR ACTIVITY: regions in the activity belts, carried round at their own latitude, living and flaring out of step', async () => {
  // (operator, 2026-09-22, with NASA SVS 5268 open: "Where is all the solar activity in ours?!" -- beside SDO's frame the
  // first cut was an evenly lit ball; the real 171 sun is a dark disk with a handful of blazing regions)
  const { sunRegions, SUN_REGIONS, SUN_ROT_A } = await import('../public/js/sunsky.js');
  const a = sunRegions(1234.5, 99), b = sunRegions(1234.5, 99);
  assert.deepEqual(a, b, 'a function of the two clocks alone: no state, no dice');
  assert.equal(a.length, SUN_REGIONS);
  let north = 0, alive = 0;
  for (let turn = 0; turn < 20000; turn += 137) for (const g of sunRegions(turn, turn)) {
    const deg = Math.abs(g.lat) * 180 / Math.PI;
    assert.ok(deg >= 5 - 1e-9 && deg <= 32 + 1e-9, `in the belts (${deg.toFixed(1)})`);
    assert.ok(Math.abs(Math.hypot(...g.dir) - 1) < 1e-9);
    assert.ok(g.strength >= 0 && g.strength <= 1 && g.flare >= 0 && g.flare <= 1.61 && g.size >= 0.07 && g.size < 0.17);
    assert.ok(Math.sign(g.tilt) === -Math.sign(g.lat), 'tilted toward the equator (Joy\'s law)');
    if (g.lat > 0) north++; if (g.strength > 0.3) alive++;
  }
  const total = Math.ceil(20000 / 137) * SUN_REGIONS;
  assert.ok(north / total > 0.3 && north / total < 0.7, 'both hemispheres');
  assert.ok(alive / total > 0.5, `most of them lit at any moment: there is always activity (${(100 * alive / total).toFixed(0)}%)`);
  // carried by the rotation law at ITS latitude: over a short step the longitude advances by omega(lat)/omega(0) of the turn
  const t0 = 5000, dt = 3;
  for (let k = 0; k < SUN_REGIONS; k++) {
    const p = sunRegions(t0, 0)[k], q = sunRegions(t0 + dt, 0)[k];
    if (p.lat !== q.lat) continue;                                  // it was reborn in between
    const want = (dt / SUN_CONST.TURN_SECONDS) * Math.PI * 2 * (sunOmega(p.lat) / SUN_ROT_A);
    const got = ((q.lon - p.lon) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    assert.ok(Math.abs(got - want) < 1e-9, `region ${k} turns at its latitude's rate`);
    assert.ok(want < (dt / SUN_CONST.TURN_SECONDS) * Math.PI * 2, 'which is slower than the equator\'s');
  }
  // a life begins and ends at nothing (nothing pops), and flares run on the WALL clock: a sun held still still flares
  let minS = 1; for (let turn = 0; turn < 40000; turn += 11) minS = Math.min(minS, sunRegions(turn, 0)[0].strength);
  assert.ok(minS < 0.01);
  const held = new Set(); for (let w = 0; w < 200; w += 0.5) held.add(sunRegions(777, w)[3].flare.toFixed(3));
  assert.ok(held.size > 50, 'the flare level moves with the wall clock at a fixed turn');
  let big = 0, n = 0; for (let w = 0; w < 6000; w += 0.7) for (const g of sunRegions(0, w)) { n++; if (g.flare > 0.8) big++; }
  assert.ok(big > 0 && big / n < 0.06, `large flares happen, and are rare (${(100 * big / n).toFixed(1)}% of samples)`);
  // the shader draws them as dipoles seen from above, and the switch reaches it
  const src = readFileSync(new URL('../public/js/sunsky.js', import.meta.url), 'utf8');
  // NOT the dipole's circles (operator, with a screenshot of them: "What is that looping shit supposed to be? It's coming
  // across looking really flat and strange" -- complete rings through both footpoints, a bar magnet's diagram): an arcade
  // of arches that LEAN toward the limb by their height, and fans of threads that curve away from each footpoint and fade
  assert.ok(!/float cc = \(rr - 1\.0\)/.test(src), 'no closed field-line circles');
  // THE LOOPS ARE THREE-DIMENSIONAL (the goal, 2026-09-22: "do the entire list. Make this sun ... beautiful. Equal to NASA
  // footage at least"): half-ellipses standing off the sphere, their pictures found per pixel by the nearest point on
  // the projected ellipse -- NOT by meeting the ray with the loop's plane, which has no answer for an upright loop seen
  // from above (the commonest loop on the disk); hidden by the sun, softly; splayed, not a ladder
  assert.match(src, /vec2 loops3d\(vec2 p, float zs\)/);
  assert.match(src, /vec2 cx = Rsh\.xy, cy = eRuh\.xy;/, 'the arch\'s picture is the same ellipse in x and y alone');
  assert.match(src, /th = clamp\(th - clamp\(dot\(X, X1\) \/ /, 'Newton on (X - p) . X\' = 0, with a bounded step (unbounded it notched the apexes)');
  assert.ok(!/float nz = /.test(src), 'no ray-plane intersection left: it is singular edge-on');
  assert.match(src, /if \(zs >= 0\.0\) vis \*= smoothstep\(-0\.03, 0\.01, z - zs\);/, 'behind the sun\'s front surface it is hidden, softly (a hard test stair-stepped the limb)');
  assert.match(src, /\(far \? 1\.6 : 2\.1\)/, 'the arcade\'s arches lean each their own way (in sunLoops, on the CPU)');
  // SUNSPOTS under the footpoints: a dark umbra, a striated penumbra, the light ROUND them
  assert.match(src, /float umbra = max\(1\.0 - smoothstep\(0\.17, 0\.25, r1\)/);
  assert.match(src, /float core = plage \* \(1\.0 - spot\) \* /, 'the plage is a ring, and grainy: no light on the umbra itself');
  assert.match(src, /float arx = 0\.92 \* \(1\.0 - exp\(/, 'a region\'s light is compressed, not clipped: at full-screen size a flare was a flat white blob');
  assert.match(src, /float edgeK = smoothstep\(0\.70, 0\.82, cd\);/, 'and reaches nothing before its cut-off (it drew a straight seam)');
  assert.match(src, /float w2 = smoothstep\(2\.5, 7\.0, px \/ 41\.0\), w3 = smoothstep\(2\.5, 7\.0, px \/ 127\.0\)/, 'fine structure at every scale the pixels allow');
  assert.match(src, /vec3 arl = regions\(nl\);/, 'and on the limb plane, so a region on the limb stands off it');
  assert.match(src, /const act = o\.sunActivity === false \? 0 : 1,/);
  assert.equal(DEFAULTS.sky.sunActivity, true);
  assert.equal(skyFor(normalise({ sky: { sunActivity: false }, space: { sky: 'sun' } }), 'space').sunActivity, false);
  assert.equal(PANEL.find((g) => g.group === 'sky').rows.find((r) => r.key === 'sunActivity').kind, 'toggle');
});

test('FILAMENT ERUPTIONS AND CMEs: a slow rise then a fast one, about half of them failing and falling back, nothing popping', async () => {
  // (operator, 2026-09-22: "build the filament eruptions and CMEs next", with NASA SVS 5268 and 5239; modelled on the
  // films' own frames: dark filament -> lights and lifts -> flung off as a red arch behind a front -> ribbons, arcade, dimming)
  const { sunEruption, sunEruptionHeight, SUN_ERUPTION: E, sunToScreen, sunRegions, SUN_REGIONS } = await import('../public/js/sunsky.js');
  // the height: slow, then fast, accelerating all the way, continuous where the two meet
  assert.equal(sunEruptionHeight(0), 0);
  const slowEnd = sunEruptionHeight(E.SLOW - 1e-9), fastStart = sunEruptionHeight(E.SLOW + 1e-9);
  assert.ok(Math.abs(slowEnd - fastStart) < 1e-6, 'no jump between the slow rise and the fast one');
  assert.ok(slowEnd < 0.06, `the slow rise is small (${slowEnd.toFixed(3)} radii)`);
  let last = -1, lastV = 0;
  for (let t = E.SLOW; t <= 1; t += 0.02) { const h = sunEruptionHeight(t); assert.ok(h > last); if (last >= 0 && t > E.SLOW + 0.05) { assert.ok(h - last >= lastV - 1e-9, 'accelerating'); } lastV = h - last; last = h; }
  assert.ok(Math.abs(sunEruptionHeight(1) - (0.045 + E.REACH)) < 1e-9, 'and it leaves: further than the shader draws it');
  // a failed one goes up a fifth of a radius and comes back down to nothing
  let peak = 0; for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, sunEruptionHeight(t, true));
  assert.ok(Math.abs(peak - E.FAIL_HEIGHT) < 1e-3); assert.ok(sunEruptionHeight(0.6, true) < 1e-9 && sunEruptionHeight(0.9, true) < 1e-9);
  // the schedule: pure, about 46% failing, active about half the time, and the filament re-forms GRADUALLY in the quiet
  assert.deepEqual(sunEruption(3, 1234.5), sunEruption(3, 1234.5));
  let fails = 0, events = 0, active = 0, n = 0, maxStep = 0;
  for (let k = 0; k < SUN_REGIONS; k++) {
    let prev = null, prevFil = null;
    for (let w = 0; w < 20000; w += 0.25) {
      const e = sunEruption(k, w); n++;
      if (e.phase >= 0) { active++; assert.ok(e.phase <= 1 && e.height >= 0); }
      if (e.phase >= 0 && (prev == null || prev < 0)) { events++; if (e.fails) fails++; }
      assert.ok(e.filament >= 0 && e.filament <= 1);
      if (prevFil != null && e.phase < 0 && prev < 0) maxStep = Math.max(maxStep, Math.abs(e.filament - prevFil));
      prev = e.phase; prevFil = e.filament;
    }
  }
  assert.ok(events > 1500 && Math.abs(fails / events - E.FAIL) < 0.05, `about ${Math.round(E.FAIL * 100)}% fail (${(100 * fails / events).toFixed(0)}% of ${events})`);
  assert.ok(active / n > 0.35 && active / n < 0.75, `dense: an eruption under way on a region ${(100 * active / n).toFixed(0)}% of the time`);
  assert.ok(maxStep < 0.05, 'the dark filament comes back gradually');
  assert.equal(sunEruption(2, 50, 0.2).phase, -1, 'a region that has barely emerged does not erupt');
  // the picture's frame is the exact inverse of what the shader does to a pixel
  const ct = Math.cos(SUN_TILT), st = Math.sin(SUN_TILT);
  const s0 = sunToScreen([0, 0, 1]);
  assert.ok(Math.abs(Math.hypot(...s0) - 1) < 1e-12 && s0[2] > 0.99 && Math.abs(s0[2] - ct) < 1e-12, 'the sub-observer point faces the viewer, tipped by the axis');
  assert.ok(Math.abs(sunToScreen([0, 1, 0])[2] + st) < 1e-12, 'and the north pole leans AWAY by the same 7.25 degrees (B0 swings both ways over a year; this is one end of it)');
  // ...and it undoes the shader's own two rotations: roll in the picture, then the tip
  { const c = [0.3, 0.5, Math.sqrt(1 - 0.09 - 0.25)], p2 = sunToScreen(c), cr = Math.cos(11 * Math.PI / 180), sr = Math.sin(11 * Math.PI / 180);
    const n1 = [cr * p2[0] + sr * p2[1], -sr * p2[0] + cr * p2[1], p2[2]], n2 = [n1[0], ct * n1[1] - st * n1[2], st * n1[1] + ct * n1[2]];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(n2[i] - c[i]) < 1e-12, 'round trip'); }
  for (const g of sunRegions(900, 900)) { assert.equal(g.screen.length, 3); assert.ok(g.phase >= -1 && typeof g.fails === 'boolean'); }
  // the shader: three parts, a rope and not a pattern, hidden behind the disk, faded over a long way, and switchable
  const src = readFileSync(new URL('../public/js/sunsky.js', import.meta.url), 'utf8');
  assert.match(src, /float ropeX = -Hh \* yy \* yy;/, 'the core is an ARCH of plasma: a parabola, its legs trailing sunward');
  assert.match(src, /float side = clamp\(length\(cs\.xy\), 0\.12, 1\.0\);/, 'foreshortened when it comes straight at the viewer');
  assert.match(src, /float seen = cs\.z < 0\.0 \? smoothstep\(0\.98, 1\.03, r\) : 1\.0;/, 'behind the limb, the disk hides it');
  assert.match(src, /float fade = \(1\.0 - smoothstep\(1\.2, \$\{F\(SUN_ERUPTION\.REACH\)\}, h\)\)/, 'it fades over a long way: nothing pops');
  assert.match(src, /float born = smoothstep\(0\.0, 0\.22, et\) \* smoothstep\(0\.0, 0\.05, h\);/, 'it GROWS out of the filament ("The red flares sorta appear out of nowhere... they need to grow"): size and light from nothing');
  assert.ok(!/if \(h < 0\.012\) continue;/.test(src), 'no height at which it switches on');
  assert.match(src, /cavity = max\(cavity,/); assert.match(src, /col = col \* \(1\.0 - ej\.w\) \+ ej\.xyz;/, 'front and core add light, the cavity takes it away');
  assert.match(src, /erupt = act === 1 && o\.sunEruptions !== false;/);
  assert.equal(DEFAULTS.sky.sunEruptions, true);
  assert.equal(skyFor(normalise({ sky: { sunEruptions: false }, space: { sky: 'sun' } }), 'space').sunEruptions, false);
});

test('QUIET PROMINENCES: at the measured heights, above the active belts, turning with the surface, born and ended at nothing', async () => {
  // (the goal's item three; the operator's answer to the plan: "171 gold with RED prominences")
  const { sunProminences, SUN_PROMINENCES } = await import('../public/js/sunsky.js');
  assert.deepEqual(sunProminences(4321), sunProminences(4321));
  let minS = 1, maxS = 0;
  for (let turn = 0; turn < 60000; turn += 97) for (const g of sunProminences(turn)) {
    assert.ok(g.height >= 0.035 - 1e-9 && g.height <= 0.095 + 1e-9, `0.03-0.09 of a radius, as measured stereoscopically (${g.height.toFixed(3)})`);
    const deg = Math.abs(g.lat) * 180 / Math.PI; assert.ok(deg >= 18 - 1e-9 && deg <= 55 + 1e-9);
    assert.ok(Math.abs(Math.hypot(...g.a) - 1) < 1e-9 && Math.abs(Math.hypot(...g.b) - 1) < 1e-9, 'both feet on the surface');
    const span = Math.hypot(g.a[0] - g.b[0], g.a[1] - g.b[1], g.a[2] - g.b[2]); assert.ok(span > 0.15 && span < 0.65, 'long and low');
    minS = Math.min(minS, g.strength); maxS = Math.max(maxS, g.strength);
  }
  assert.ok(minS < 0.01 && maxS > 0.99);
  assert.equal(sunProminences(0).length, SUN_PROMINENCES);
  const src = readFileSync(new URL('../public/js/sunsky.js', import.meta.url), 'utf8');
  assert.match(src, /absorb = max\(absorb, 0\.52 \* min\(1\.0, dens \* 1\.3\) \* front\);/, 'in front of the disk it ABSORBS: a dark filament');
  assert.match(src, /col \*= 1\.0 - pm\.y;/); assert.match(src, /mix\(vec3\(0\.85, 0\.10, 0\.02\), vec3\(1\.0, 0\.55, 0\.22\), e2\) \* e2;/, 'against the sky it glows red');
  assert.equal(DEFAULTS.sky.sunProminences, true);
  assert.equal(skyFor(normalise({ sky: { sunProminences: false }, space: { sky: 'sun' } }), 'space').sunProminences, false);
});

test('THE REST OF THE LIST: rain that condenses, a flare with its flash and cross and wave, a writhing eruption, a corona with architecture, the cycle, the channels, and a shader a laptop can run', async () => {
  // (the goal, 2026-09-22: "do the entire list. Make this sun ... beautiful. Equal to NASA footage at least")
  const m = await import('../public/js/sunsky.js');
  const src = readFileSync(new URL('../public/js/sunsky.js', import.meta.url), 'utf8');
  // RAIN ("The rain effects still look too much like dots appearing out of nowhere"): it condenses, streaks, goes out
  assert.match(src, /float life = smoothstep\(0\.0, 0\.30, ph\) \* \(1\.0 - smoothstep\(0\.80, 1\.0, ph\)\);/, 'no knot is born bright or dies bright');
  assert.match(src, /float tail = 0\.05 \+ 0\.34 \* speed,/, 'a streak that lengthens as it gathers speed');
  assert.match(src, /float pulse = pow\(0\.5 \+ 0\.5 \* sin\(t \* 8\.0/, 'and the surface\'s bright points swell and fade rather than blink');
  // THE FLARE: flash at the loop tops, the telescope's diffraction cross on the big ones, a wave over the disk
  assert.match(src, /col = mix\(col, vec3\(0\.80, 1\.0, 1\.0\), clamp\(0\.85 \* flash, 0\.0, 0\.9\)\);/);
  assert.match(src, /float an = m == 0 \? 0\.70 : 2\.27;/, 'two crossed spikes at about forty and a hundred and thirty degrees');
  let waves = 0, n = 0; for (let w = 0; w < 4000; w += 0.5) for (const g of m.sunRegions(0, w)) { n++; if (g.wave >= 0) { waves++; assert.ok(g.wave <= 1); } }
  assert.ok(waves > 0 && waves / n < 0.2, 'only the large flares send a wave');
  // THE ERUPTION: writhe, draining legs, dimming from the footpoints
  assert.match(src, /float writhe = \(seed < 0\.5 \? -1\.0 : 1\.0\) \* 1\.05 \* smoothstep\(0\.10, 0\.62, et\)/, 'the arch\'s axis rotates as it rises, always the way its twist was wound');
  assert.match(src, /float twin = max\(exp\(-dot\(u - vec2\(0\.0, 2\.2\)/, 'twin dimmings at the rope\'s feet, spreading');
  // THE CORONA: helmets that thin to stalks, polar plumes, wind moving outward
  assert.match(src, /float helmet = smoothstep\(0\.44 \+ 0\.22 \* min\(h, 1\.4\)/, 'the threshold rises with height: a bulb thins to a stalk by itself');
  assert.match(src, /h \* 4\.0 - uBoil \* 2\.2\)\);  \/\/ moving OUT/);
  // THE CYCLE
  assert.deepEqual([0, 0.5, 1].map(m.sunRegionCount), [1, 6, 10]);
  const live = (c) => { let k = 0; for (let t = 0; t < 8000; t += 40) k += m.sunRegions(t, t, c).filter((g) => g.strength > 0.3).length; return k; };
  assert.ok(live(1) > live(0.5) && live(0.5) > live(0) * 2, 'more regions toward maximum');
  const maxLat = (c) => { let v = 0; for (let t = 0; t < 30000; t += 50) for (const g of m.sunRegions(t, t, c)) v = Math.max(v, Math.abs(g.lat)); return v * 180 / Math.PI; };
  assert.ok(maxLat(0) < 10 && maxLat(1) > 28, `near the equator at minimum (${maxLat(0).toFixed(0)}), out to the thirties at maximum (${maxLat(1).toFixed(0)})`);
  assert.equal(DEFAULTS.sky.sunCycle, m.SUN_CYCLE_DEFAULT);
  // THE CHANNELS: same seven stops each (the shader's array is one size), each rising in brightness
  for (const [id, ramp] of Object.entries(m.SUN_CHANNELS)) {
    assert.equal(ramp.length, 7, id);
    let prev = -1; for (let t = 0; t <= 1.0001; t += 0.1) { const c = m.sunRamp(t, id), l = 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2]; assert.ok(l > prev, `${id} brightens`); prev = l; }
  }
  assert.deepEqual(m.SUN_CHANNEL_LABELS.map(([v]) => v), Object.keys(m.SUN_CHANNELS).sort((a, b) => m.SUN_CHANNEL_LABELS.findIndex(([v]) => v === a) - m.SUN_CHANNEL_LABELS.findIndex(([v]) => v === b)));
  assert.ok(m.sunRamp(0.6, '304')[0] > m.sunRamp(0.6, '304')[2] * 5 && m.sunRamp(0.6, '131')[2] > m.sunRamp(0.6, '131')[0] * 3, '304 is red, 131 is teal');
  assert.equal(normalise({ sky: { sunChannel: 'x-ray' } }).sky.sunChannel, m.SUN_CHANNEL_DEFAULT);
  // THE COST: the loops' geometry is worked out once a frame on the CPU and read from a float texture; the fine
  // structure is computed once, not once a shear layer; and the pixel budget is a setting
  const loops = m.sunLoops(m.sunRegions(200, 200), 3);
  assert.equal(loops.length, m.SUN_REGIONS * m.SUN_LOOPS * 16);
  let real = 0;
  for (let i = 0; i < loops.length; i += 16) {
    if (loops[i] === 99) continue; real++;
    const mid = [loops[i], loops[i + 1], loops[i + 2]], Rsh = [loops[i + 4], loops[i + 5], loops[i + 6]];
    const A = mid.map((v, q) => v + Rsh[q]), B = mid.map((v, q) => v - Rsh[q]);
    assert.ok(Math.abs(Math.hypot(...A) - 1) < 1e-6 && Math.abs(Math.hypot(...B) - 1) < 1e-6, 'both feet of every loop are ON the sphere');
    assert.ok(loops[i + 3] >= Math.hypot(...Rsh), 'and the bounding radius covers it');
  }
  assert.ok(real > 56, `${real} loops standing`);
  assert.match(src, /vec4 t0 = texelFetch\(uLoops, ivec2\(0, row\), 0\);/);
  assert.match(src, /vec2 sA = surface\(n, uShearA, px, true\), sB = surface\(n, uShearB, px, false\);/);
  assert.deepEqual(Object.keys(m.SUN_DETAIL), ['low', 'medium', 'high']); assert.ok(m.SUN_DETAIL.low < m.SUN_DETAIL.medium && m.SUN_DETAIL.medium < m.SUN_DETAIL.high);
  assert.equal(DEFAULTS.sky.sunDetail, m.SUN_DETAIL_DEFAULT);
  for (const key of ['sunCycle', 'sunChannel', 'sunDetail', 'sunProminences']) assert.ok(PANEL.find((g) => g.group === 'sky').rows.some((r) => r.key === key), key);
  const o = skyFor(normalise({ sky: { sunCycle: 0.3, sunChannel: '304', sunDetail: 'low' }, space: { sky: 'sun' } }), 'space');
  assert.deepEqual([o.sunCycle, o.sunChannel, o.sunDetail], [0.3, '304', 'low']);
});
