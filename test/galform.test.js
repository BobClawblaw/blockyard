// THE FORMATION (public/js/galform.js): the fourth sky, after the TNG50 film -- a galaxy
// assembling itself on a loop. The maths is pure: the same clock reading always gives the
// same picture, the loop fades to black at both ends so nothing pops at the wrap, the disc
// differentially rotates and visibly turns, and every drawn thing is a plain rgba speck
// (the canvas rules; gas is grain, density does the work).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hash01, formField, gasAt, windField, windAt, farStars,
  drawGalaxyForm, envAt, envIn, formW, FORM_CYCLE, FORM_HOLD, FORM_WINDOWS,
} from '../public/js/galform.js';
import { FORM_AT_DEFAULT } from '../public/js/formgl.js';

test('the field is seeded: the same seed, the same gas', () => {
  const a = formField(11, 500), b = formField(11, 500);
  assert.deepEqual(a, b);
  assert.notDeepEqual(formField(12, 500), a, 'a different seed, a different sky');
  assert.equal(a.length, 500);
  // birth distances reach off the disc (filaments come from outside) but orbital radii
  // concentrate inward -- that is where the core's density comes from
  for (const p of a) {
    assert.ok(p.d0 > 0.5 && p.d0 < 2.6, `birth ${p.d0} on a filament outside the disc`);
    assert.ok(p.r0 >= 0 && p.r0 <= 1, `orbit ${p.r0} inside the disc`);
    assert.ok(p.s0 >= 0.1 && p.s0 < 0.6, `settles at ${p.s0}, well before the late epochs`);
  }
  const meanR = a.reduce((s, p) => s + p.r0, 0) / a.length;
  assert.ok(meanR < 0.66, `orbital radii lean inward (mean ${meanR.toFixed(2)}; uniform would be 0.5 at pow 1)`);
  const far = farStars(41, 60);
  assert.equal(far.length, 60);
  assert.deepEqual(farStars(41, 60), far, 'the backdrop is seeded too');
});

test('the gas falls in and joins a turning disc: the arc of the film', () => {
  const p = formField(11, 40)[7];
  const early = gasAt(p, 0.02), mid = gasAt(p, 0.30), late = gasAt(p, 0.75);
  // early: far out on the filament; late: settled on the orbit
  const dist = (g) => Math.hypot(g.x, g.y);
  assert.ok(dist(early) > dist(late), 'the particle fell inward across the cycle');
  assert.equal(late.joined, 1, 'it has joined the disc by the late epochs');
  assert.ok(mid.joined < 1, 'and was still arriving in the middle');
  // the disc turns: the same settled particle advances round the orbit, and by the RIGHT
  // amount -- formW * served cycle-time seconds. The y coordinate carries the disc's squash
  // (ratio < 1), so the test unsquashes before comparing angles.
  const served = (0.75 - p.s0) * FORM_CYCLE;
  const expect = (p.th0 + formW(p.r0) * served) % (Math.PI * 2);
  const ratio = (function () { const t = Math.max(0, Math.min(1, (0.75 - 0.25) / 0.35)); const s = t * t * (3 - 2 * t); return 0.85 + (0.40 - 0.85) * s; })();
  const got = Math.atan2(late.y / ratio, late.x) - expect;
  assert.ok(Math.abs(Math.atan2(Math.sin(got), Math.cos(got))) < 1e-9, `the angle is formW*served`);
  // DIFFERENTIAL rotation: the inside laps the outside
  assert.ok(formW(0.2) > formW(0.8), 'the inner disc turns faster');
  // the disc cools: the squash tightens and the height off the plane thins
  const raw = gasAt(p, 0.30), cool = gasAt(p, 0.85);
  assert.ok(Math.abs(cool.y) / Math.max(1e-9, Math.abs(cool.x)) <= Math.abs(raw.y) / Math.max(1e-9, Math.abs(raw.x)) || cool.joined > raw.joined,
    'the later frame is squashed or more settled');
});

test('the loop fades to black at both ends: nothing pops at the wrap', () => {
  assert.equal(envAt(0), 0);
  assert.equal(envAt(1), 0, 'the wrap is black');
  assert.equal(envAt(0.5), 1, 'full in the middle');
  for (let u = 0; u <= 1; u += 0.01) {
    const e = envAt(u);
    assert.ok(e >= 0 && e <= 1, `envelope in range at u=${u.toFixed(2)}`);
  }
  assert.ok(envAt(0.03) < envAt(0.08), 'rising through the fade-in');
  assert.ok(envAt(0.97) < envAt(0.92), 'falling through the fade-out');
});

test('the fountains: two cones, ballistic, only inside their windows', () => {
  const W = windField(29, 200);
  assert.equal(W.length, 200);
  // both cones exist and no particle rides a window that does not exist
  const signs = new Set(W.map((p) => p.sigma));
  assert.ok(signs.has(1) && signs.has(-1), 'particles in both cones');
  for (const p of W) {
    assert.ok(p.win >= 0 && p.win < FORM_WINDOWS.length, `window ${p.win} exists`);
    const [start, dur] = FORM_WINDOWS[p.win];
    assert.ok(start + p.l * dur < start + dur, 'launch inside the window');
  }
  // life: null outside the flight, a rise-and-fall inside it
  const p = W.find((q) => windAt(q, 0.5)) ?? W[0];
  let seen = 0, apex = 0, rising = null, falling = null;
  for (let u = 0; u <= 1; u += 0.002) {
    const w = windAt(p, u);
    if (!w) continue;
    seen++;
    if (rising === null) rising = u;
    falling = u;
    apex = Math.max(apex, Math.abs(w.y));
    assert.ok(w.a > 0 && w.a <= 1.01, `alpha in range at u=${u.toFixed(3)}`);
  }
  assert.ok(seen > 20, `the particle lives a span (${seen} samples)`);
  assert.ok(rising > FORM_WINDOWS[p.win][0], 'it does not exist before its window');
  assert.ok(falling < FORM_WINDOWS[p.win][0] + FORM_WINDOWS[p.win][1] + 0.05, 'nor long after it');
  assert.ok(apex > 0.2, `it climbs (apex ${apex.toFixed(2)} disc radii)`);
  // determinism: the same clock, the same fountain
  assert.deepEqual(windAt(p, 0.7), windAt(p, 0.7));
});

test('the draw runs on a stub context: all specks, all rgba, deterministic', () => {
  const makeCtx = (fills) => ({
    canvas: null,
    fillStyle: '',
    beginPath() {},
    arc() { fills.push({ style: this.fillStyle }); },
    fill() {},
    fillRect() { fills.push({ style: this.fillStyle }); },
    ellipse() {},
  });
  const fills = [];
  drawGalaxyForm(makeCtx(fills), 800, 500, 2, 60000, { starBrightness: 1 });
  assert.ok(fills.length > 1200, `the gas painted (${fills.length} fills)`);   // (1488 at 800x500 from the bottom-left corner: more of the disc is off the panel there than from the top-left)
  assert.ok(fills.every((f) => /^rgba\(/.test(f.style)), 'every fill is a plain rgba, per the canvas rules');
  // determinism: the same clock reading paints the same picture
  const fills2 = [];
  drawGalaxyForm(makeCtx(fills2), 800, 500, 2, 60000, { starBrightness: 1 });
  assert.deepEqual(fills2, fills);
  // speed 0 holds the film's still frame: the same picture a minute later
  const fills3 = [];
  drawGalaxyForm(makeCtx(fills3), 800, 500, 2, 120000, { starBrightness: 1, formSpeed: 0 });
  const fills4 = [];
  drawGalaxyForm(makeCtx(fills4), 800, 500, 2, 120000 + 60000, { starBrightness: 1, formSpeed: 0 });
  assert.deepEqual(fills4, fills3, 'speed 0 is a still frame');
  // and the wrap is honest: the very first frame of a cycle draws NOTHING (the envelope is
  // zero, so every speck is skipped before it fills)
  const fills5 = [];
  drawGalaxyForm(makeCtx(fills5), 800, 500, 2, 0, { starBrightness: 1 });
  assert.equal(fills5.length, 0, 'the loop opens black: not one speck');
  // and mid-cycle the core saturates: somewhere the specks pile past 0.9 alpha -- density
  // doing the work of a painted glow
  const mid = [];
  drawGalaxyForm(makeCtx(mid), 800, 500, 2, (FORM_CYCLE / 2) * 1000, { starBrightness: 1 });
  const hot = mid.map((f) => Number(f.style.match(/,(0?\.\d+|1)\)$/)[1])).filter((a) => a > 0.05);
  assert.ok(hot.length > 200, `a bright core by overlap (${hot.length} specks above 0.05)`);
});

test('brought along with the GL layer: perpetual, placed, and in the film\'s colours', async () => {
  const { FORM_PLACEMENTS, formRamp } = await import('../public/js/formgl.js');
  const makeCtx = (fills) => ({ canvas: null, fillStyle: '', beginPath() {}, arc(x, y, r) { fills.push({ style: this.fillStyle, x, y, r }); }, fill() {}, fillRect() {}, ellipse() {} });
  // (the middle, at speed 1, unless a case says otherwise: the shipped place and pace are the operator's own)
  const at = (now, o = {}) => { const f = []; drawGalaxyForm(makeCtx(f), 800, 500, 1, now, { starBrightness: 1, formAt: 'center', formSpeed: 1, formPalette: 'magma', ...o }); return f; };   // (magma: the film's colours are what this test is about)
  // PERPETUAL: long after the assembly it is still there (it used to be fading to black every 140 s, and
  // at exactly 140 s and 280 s drew nothing at all) -- and the disc is still TURNING
  for (const s of [140, 280, 3600, 86400]) assert.ok(at(s * 1000).length > 1500, `drawn at ${s} s`);
  const a = at(600_000), b = at(620_000);
  assert.equal(a.length > 1500 && b.length > 1500, true);
  assert.notDeepEqual(a.map((f) => [f.x.toFixed(1), f.y.toFixed(1)]), b.map((f) => [f.x.toFixed(1), f.y.toFixed(1)]), 'twenty seconds on, the specks have moved');
  // the only fade is the way IN
  assert.equal(envIn(0), 0); assert.equal(envIn(0.05), 1); assert.equal(envIn(0.86), 1);
  // the fountains keep cycling: over one further cycle there are moments with wind and moments without
  // (the gas's count is fixed once mature, so what varies in the number of specks drawn IS the wind)
  const drawn = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130].map((sec) => at((1000 + sec) * 1000).length);
  assert.ok(Math.max(...drawn) - Math.min(...drawn) > 100, `bursts that come and go, not a steady state (${drawn})`);
  // PLACED: the brightest specks gather where formAt says, and a corner is drawn larger
  // (the CORE: the forty brightest specks. An average over all the bright ones is dragged inward in a
  // corner, because what falls outside the panel is never drawn.)
  const centreOf = (f) => { const hot = f.map((q) => [Number(q.style.match(/,([\d.]+)\)$/)[1]), q]).sort((x, y) => y[0] - x[0]).slice(0, 40).map((v) => v[1]); return [hot.reduce((t, q) => t + q.x, 0) / hot.length, hot.reduce((t, q) => t + q.y, 0) / hot.length]; };
  const mid = centreOf(at(400_000)), tr = centreOf(at(400_000, { formAt: 'top-right' }));
  assert.ok(Math.abs(mid[0] - 400) < 25 && Math.abs(mid[1] - 250) < 25, `the middle (${mid})`);
  assert.ok(Math.abs(tr[0] - 800 * FORM_PLACEMENTS['top-right'][0]) < 40 && Math.abs(tr[1] - 500 * FORM_PLACEMENTS['top-right'][1]) < 40, `top right (${tr})`);
  const tl = centreOf(at(400_000, { formAt: 'nowhere' }));
  assert.ok(Math.abs(tl[0] - 800 * FORM_PLACEMENTS[FORM_AT_DEFAULT][0]) < 40 && Math.abs(tl[1] - 500 * FORM_PLACEMENTS[FORM_AT_DEFAULT][1]) < 40, `an unknown place is the shipped one, bottom left (${tl})`);
  // DIMMED by the same slider as the GL layer (sky.formBrightness): every speck's alpha, its colour untouched
  const full = at(400_000, { formBrightness: 1 }), half = at(400_000, { formBrightness: 0.5 });
  const alphaOf = (f) => Number(f.style.match(/,([\d.]+)\)$/)[1]);
  const sumA = (f) => f.reduce((t, q) => t + alphaOf(q), 0);
  assert.ok(half.length <= full.length && Math.abs(sumA(half) / sumA(full) - 0.5) < 0.03, 'half the light');
  assert.deepEqual(new Set(half.map((f) => f.style.replace(/,[\d.]+\)$/, ''))).size <= new Set(full.map((f) => f.style.replace(/,[\d.]+\)$/, ''))).size, true, 'no new colours');
  // COLOURS: every tint is a colour of the shared ramp, the core is its pale end and the web its violet
  const ramp = new Set(); for (let i = 0; i <= 64; i++) ramp.add(formRamp(i / 64, 'magma').join(','));
  const tints = new Set(at(400_000).map((f) => f.style.replace(/^rgba\(/, '').replace(/,[\d.]+\)$/, '')));
  for (const t of tints) assert.ok(ramp.has(t), `${t} is on the ramp`);
  const [r, g, bl] = [...tints].map((t) => t.split(',').map(Number)).sort((x, y) => (y[0] + y[1] + y[2]) - (x[0] + x[1] + x[2]))[0];
  assert.ok(r > 240 && g > 200 && bl > 120, 'the core reaches the pale end');
  assert.ok([...tints].some((t) => { const [rr, gg, bb] = t.split(',').map(Number); return bb > rr && bb > gg; }), 'and thin gas is violet');
  assert.ok(![...tints].some((t) => { const [rr, gg, bb] = t.split(',').map(Number); return Math.abs(rr - gg) < 12 && Math.abs(gg - bb) < 25 && rr > 150; }), 'nothing is the old grey-white');
  // and with no palette named it wears the SHIPPED one, as the GL layer does: cobalt gas, not magma's violet-to-orange
  const shipped = new Set(); for (let i = 0; i <= 64; i++) shipped.add(formRamp(i / 64).join(','));
  const worn = new Set(at(400_000, { formPalette: undefined }).map((f) => f.style.replace(/^rgba\(/, '').replace(/,[\d.]+\)$/, '')));
  for (const t of worn) assert.ok(shipped.has(t), `${t} is on the shipped ramp`);
  assert.ok([...worn].every((t) => { const [rr, , bb] = t.split(',').map(Number); return bb >= rr || rr > 200; }), 'blue gas; only the core is warm');
});
