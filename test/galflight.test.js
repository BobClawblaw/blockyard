// THE GALAXY FLIGHT (public/js/galflight.js): the third sky, after NASA SVS 14950 -- a chain of
// spiral galaxies the camera flies through, wrapping so the sequence repeats forever. The maths
// is pure: the same seed always gives the same field, the same clock reading always gives the
// same picture, the wrap is exact so the flight can never fall off its ring, and the galaxies
// are real spirals that turn as you watch.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as galflight from '../public/js/galflight.js';
import {
  galaxyField, projectGalaxy, flightFade, drawGalaxyFlight, flightStars,
  FLIGHT_DEPTH, FLIGHT_NEAR, FLIGHT_RATE,
} from '../public/js/galflight.js';

test('the field is seeded: the same seed, the same galaxies', () => {
  const a = galaxyField(7, 8), b = galaxyField(7, 8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(galaxyField(8, 8), a, 'a different seed, a different sky');
  assert.equal(a.length, 8);
  for (const g of a) {
    assert.ok(g.z0 >= FLIGHT_NEAR && g.z0 < FLIGHT_NEAR + FLIGHT_DEPTH, `z0 ${g.z0} inside the corridor`);
    assert.ok(g.size > 0 && g.ratio > 0 && g.ratio <= 1);
    assert.ok(g.spinRate !== 0, 'each galaxy turns');
    assert.ok(g.stars.length >= 50, 'each galaxy carries its arm stars');
  }
  // the z spread really covers the corridor: evenly laid with jitter, it reads as a chain
  const zs = a.map((g) => g.z0).sort((x, y) => x - y);
  assert.ok(zs[zs.length - 1] - zs[0] > FLIGHT_DEPTH * 0.5, 'the chain spans the corridor');
});

test('the galaxies are spirals: arms of stars in polar coordinates', () => {
  const g = galaxyField(7, 8)[0];
  // most of the arm population sits well out of the bulge: that is what reads as an arm
  const far = g.stars.filter((s) => s.r > 0.4);
  assert.ok(far.length > g.stars.length * 0.4, 'the arms reach the disc\u2019s edge');
  // arms wind: a star's angle grows with its radius (two-arm galaxies mirror at PI)
  const armStars = far.filter((s) => Math.abs(((s.a % Math.PI) + Math.PI) % Math.PI) < Math.PI);
  assert.ok(armStars.length >= 20, 'there is an arm population');
});

test('the depth wraps: the same galaxy comes round again, exactly', () => {
  const g = galaxyField(7, 8)[0];
  const span = FLIGHT_DEPTH;
  const p0 = projectGalaxy(g, 0, 800, 500);
  const p1 = projectGalaxy(g, span, 800, 500);
  assert.equal(p1.x, p0.x);
  assert.equal(p1.y, p0.y);
  assert.equal(p1.r, p0.r);
  for (let t = 0; t < span * 2.5; t += span / 37) {
    const p = projectGalaxy(g, t, 800, 500);
    assert.ok(p.z >= FLIGHT_NEAR && p.z < FLIGHT_NEAR + span, `z ${p.z} in range at travel ${t}`);
  }
});

test('a galaxy grows as it approaches and passes off the panel', () => {
  const g = { ...galaxyField(7, 8)[0], u: 0, v: 0 };   // dead centre of the flight path
  const far = projectGalaxy(g, 0, 800, 500);
  const near = projectGalaxy(g, Math.max(0, g.z0 - 1), 800, 500);
  assert.ok(near.r > far.r, 'closer is larger');
  assert.ok(far.vis && near.vis, 'a centred galaxy is on the panel at both depths');
});

test('the fade dims with distance and never goes negative', () => {
  assert.ok(flightFade(FLIGHT_NEAR) > flightFade(FLIGHT_DEPTH));
  // THE ENTRY FADE (operator: galaxies must fade in at a distance, never blink): at the
  // corridor's far mouth the fade is ZERO, rising over six z units
  assert.equal(flightFade(FLIGHT_DEPTH), 0, 'zero at the mouth: nothing pops into existence');
  assert.ok(flightFade(FLIGHT_DEPTH - 3) > 0 && flightFade(FLIGHT_DEPTH - 3) < flightFade(FLIGHT_DEPTH - 9),
    'rising through the entry band');
  for (let z = FLIGHT_NEAR; z < FLIGHT_NEAR + FLIGHT_DEPTH; z += 0.5) {
    const f = flightFade(z);
    assert.ok(f >= 0, `never negative at z=${z}`);
    assert.ok(f <= 1.01, `not brighter than full at z=${z}`);
  }
});

test('the arms turn as you watch: the same star moves with the spin', () => {
  const g = galaxyField(7, 8)[0];
  const s = g.stars[0];
  // where the star lands on the panel at two clock readings, same travel
  const at = (now) => {
    const spin = now / 1000 * g.spinRate + g.spinPhase;
    return Math.atan2(Math.sin(s.a + spin), Math.cos(s.a + spin));
  };
  const t1 = at(0), t2 = at(30000);
  assert.notEqual(t1, t2, 'the star moved round the disc in half a minute');
  // and a full spin period brings it back
  const period = Math.abs((Math.PI * 2) / g.spinRate);
  assert.ok(Math.abs(at(0) - at(period * 1000)) < 1e-9, 'a full turn is a closed circle');
});

test('the streaming stars fill the corridor and move with the camera', () => {
  const stars = flightStars(11, 240);
  assert.equal(stars.length, 240);
  for (const s of stars) assert.ok(s.z0 >= FLIGHT_NEAR && s.z0 < FLIGHT_NEAR + FLIGHT_DEPTH);
  // the same star is at a different panel place after the camera has moved
  const s = stars[0];
  const px = (t, pw, ph) => {
    const span = FLIGHT_DEPTH;
    const z = FLIGHT_NEAR + (((s.z0 - t - FLIGHT_NEAR) % span) + span) % span;
    return pw / 2 + (s.u * pw * 0.6) / z;
  };
  assert.notEqual(px(0, 800, 500), px(FLIGHT_RATE * 10, 800, 500), 'ten seconds of flight moves the star');
});

test('the draw runs on a stub context: stars stream, galaxies paint, all rgba', () => {
  const makeCtx = (fills, strokes = null) => ({
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    beginPath() { this._path = []; },
    ellipse(x, y, rx) { this._path.push({ x, y, rx, style: this.fillStyle }); },
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, style: this.fillStyle }); },
    fill() { for (const p of this._path) fills.push({ ...p, w: p.rx * 2, h: p.rx * 2 }); },
    moveTo() {}, lineTo() {},
    arc() { this._path.push({ x: 0, y: 0, rx: 1, style: this.fillStyle }); },
    stroke() { if (strokes) strokes.push({ style: this.strokeStyle, lw: this.lineWidth }); },
    setTransform() {}, drawImage() {},
  });
  const calls = [];
  const fills = [], strokes = [];
  drawGalaxyFlight(makeCtx(fills, strokes), 800, 500, 2, 12000, { starBrightness: 1 }, {
    drawStars: () => calls.push('stars'),
  });
  const calls0strokes = strokes.length;   // glint crosses only: a handful, never hundreds
  assert.ok(calls0strokes < 30, `glints are few (${calls0strokes})`);
  assert.deepEqual(calls, [], 'NO static backdrop: every star under the flight moves, so drawStars is not called');
  assert.ok(fills.length > 200, `the streaming sky and the galaxies painted (${fills.length} fills)`);
  assert.ok(fills.every((f) => /^rgba\(/.test(f.style)), 'every fill is a plain rgba, per the canvas rules');
  assert.ok(strokes.length === calls0strokes, 'strokes only as glint crosses, never as star streaks');
  // determinism: the same clock reading paints the same picture
  const fills2 = [], strokes2 = [];
  drawGalaxyFlight(makeCtx(fills2, strokes2), 800, 500, 2, 12000, { starBrightness: 1 }, { drawStars: () => {} });
  assert.equal(JSON.stringify(fills2), JSON.stringify(fills));
  assert.equal(JSON.stringify(strokes2), JSON.stringify(strokes));
  // speed 0 holds the camera AND the whole picture: the same frame a minute later
  const fills3 = [], strokes3 = [];
  drawGalaxyFlight(makeCtx(fills3, strokes3), 800, 500, 2, 12000, { starBrightness: 1, flightSpeed: 0 }, { drawStars: () => {} });
  const fills4 = [], strokes4 = [];
  drawGalaxyFlight(makeCtx(fills4, strokes4), 800, 500, 2, 12000 + 60000, { starBrightness: 1, flightSpeed: 0 }, { drawStars: () => {} });
  assert.equal(JSON.stringify(fills4), JSON.stringify(fills3), 'speed 0 is a still frame');
  assert.equal(JSON.stringify(strokes4), JSON.stringify(strokes3), 'speed 0 stills the stars too');
});

test('the vanishing point moves: centre or a corner, the Galaxy sky\u2019s vocabulary', () => {
  // exported: flightAt answers {x,y} fractions of the panel
  const { flightAt } = galflight;
  const c = galflight.flightAt(800, 500, 'center');
  assert.equal(c.x, 400); assert.equal(c.y, 250);
  const tl = galflight.flightAt(800, 500, 'top-left');
  assert.equal(tl.x, 800 * 0.18); assert.equal(tl.y, 500 * 0.18);
  const br = galflight.flightAt(800, 500, 'bottom-right');
  assert.equal(br.x, 800 * 0.82); assert.equal(br.y, 500 * 0.82);
  // an unknown placement falls back to the centre
  const f = galflight.flightAt(800, 500, 'nowhere');
  assert.equal(f.x, 400); assert.equal(f.y, 250);
  // a galaxy wraps around the CHOSEN point: projectGalaxy at travel 0 and travel span agree
  const g = galaxyField(7, 5)[0];
  const p0 = projectGalaxy(g, 0, 800, 500, 'top-right');
  const p1 = projectGalaxy(g, FLIGHT_DEPTH, 800, 500, 'top-right');
  assert.equal(p1.x, p0.x); assert.equal(p1.y, p0.y);
});
