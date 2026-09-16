// THE LIVING SKY (operator, 2026-09-16: "something realistic with blue skies, clouds, the sun,
// change of day, night with the moon coming out, just something fucking beautiful"). What is held
// here: the clock's three modes; the sun's altitude by the plain six-to-six day and by the real
// formula at a latitude; the moon's phase at known full and new moons; the dome's colours in
// order from night to noon; the star field fading with the sun; the clouds seeded; a frame drawn
// on a stub context without a gradient, a blend mode or a throw; and the settings reaching every
// board that draws a sky.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  skyTime, sunPosition, sunScreen, moonPhase, moonPosition, skyColours, starVisibility, cloudField, cirrusField,
  boltPoints, drawLivingSky, KEYFRAMES, WEATHER,
} from '../public/js/livingsky.js';
import { normalise, spaceOptions, marketsOptions, tetrustOptions, blockoutOptions, blockanoidOptions, scorchedOptions, skyExtras, DEFAULTS, PANEL } from '../public/js/settings.js';

const stubCtx = () => {
  const calls = { arc: 0, fillRect: 0, lineTo: 0, drawImage: 0, gradients: 0 };
  const ctx = {
    canvas: { width: 800, height: 400 },
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    setTransform() {}, clearRect() {}, fillRect() { calls.fillRect++; }, beginPath() {}, closePath() {}, fill() {}, stroke() {},
    arc() { calls.arc++; }, moveTo() {}, lineTo() { calls.lineTo++; }, drawImage() { calls.drawImage++; },
    createLinearGradient() { calls.gradients++; return { addColorStop() {} }; },
    createRadialGradient() { calls.gradients++; return { addColorStop() {} }; },
  };
  return { ctx, calls };
};
const stops = (ctx, x, y, r, list, N) => { for (let i = 0; i < (N || 8); i++) { ctx.beginPath(); ctx.arc(x, y, r, 0, 1); ctx.fill(); } };

test('the clock: real time is the machine’s hour, the cycle is a day every 24 minutes, fixed holds the hour', () => {
  const at = new Date(2026, 8, 16, 17, 30, 0).getTime();          // 17:30 local
  assert.ok(Math.abs(skyTime({ skyClock: 'real' }, at).hour - 17.5) < 1e-6);
  assert.equal(skyTime({ skyClock: 'fixed', skyHour: 6.25 }, at).hour, 6.25);
  assert.equal(skyTime({ skyClock: 'fixed', skyHour: 24 }, at).hour, 0, 'twenty-four is midnight');
  const c0 = skyTime({ skyClock: 'cycle' }, 0).hour, c1 = skyTime({ skyClock: 'cycle' }, 6 * 60000).hour;
  assert.equal(c0, 0); assert.equal(c1, 6, 'six minutes on is six in the morning');
  assert.equal(skyTime({ skyClock: 'cycle' }, 24 * 60000).hour, 0, 'and the day wraps');
  assert.equal(skyTime({}, at).dayOfYear, 259, 'the 16th of September is day 259');
});

test('the sun: six to six with 62° at noon without a latitude; the real formula with one', () => {
  const noon = sunPosition(12), dawn = sunPosition(6), dusk = sunPosition(18), night = sunPosition(0);
  assert.ok(Math.abs(noon.alt - 62) < 1e-9); assert.ok(Math.abs(dawn.alt) < 1e-9); assert.ok(Math.abs(dusk.alt) < 1e-9); assert.ok(night.alt < -60);
  assert.equal(noon.frac, 0.5, 'halfway across at noon');
  // the equator at the equinox: overhead at noon, the day twelve hours
  const eq = sunPosition(12, 80, 0);
  assert.ok(eq.alt > 89, `overhead at the equinox on the equator (${eq.alt.toFixed(1)})`);
  assert.ok(Math.abs(eq.rise - 6) < 0.05 && Math.abs(eq.set - 18) < 0.05);
  // London at midsummer: a long day, the sun about 62° at noon
  const ldn = sunPosition(12, 172, 51.5);
  assert.ok(ldn.alt > 60 && ldn.alt < 63, `London midsummer noon (${ldn.alt.toFixed(1)})`);
  assert.ok(ldn.rise < 4.5 && ldn.set > 19.5, 'a long day');
  // and midwinter: low, and short
  const win = sunPosition(12, 355, 51.5);
  assert.ok(win.alt > 13 && win.alt < 17, `London midwinter noon (${win.alt.toFixed(1)})`);
  assert.ok(win.rise > 7.5 && win.set < 16.5, 'a short day');
  // the polar night: never up
  assert.ok(sunPosition(12, 355, 80).alt < 0);
  // on the screen: left at dawn, right at dusk, higher the higher the sun, below the bottom at night
  const w = 1000, h = 500;
  assert.ok(sunScreen(sunPosition(6.5), w, h).x < w * 0.2 && sunScreen(sunPosition(17.5), w, h).x > w * 0.8);
  assert.ok(sunScreen(sunPosition(12), w, h).y < sunScreen(sunPosition(9), w, h).y);
  assert.ok(sunScreen(sunPosition(0), w, h).y > h, 'under the horizon at midnight');
});

test('the moon: full on 2000-01-21, new on 2000-01-06, first quarter half lit; it rides opposite the sun when full', () => {
  const full = moonPhase(new Date(Date.UTC(2000, 0, 21, 4, 40)));
  assert.ok(Math.abs(full.p - 0.5) < 0.02 && full.lit > 0.99, `full (${full.p.toFixed(3)})`);
  const nw = moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14)));
  assert.ok(nw.p < 0.001 || nw.p > 0.999, 'new'); assert.ok(nw.lit < 0.001);
  const q = moonPhase(new Date(Date.UTC(2000, 0, 14, 13)));
  assert.ok(Math.abs(q.lit - 0.5) < 0.06 && q.waxing, `first quarter (${q.lit.toFixed(2)})`);
  const later = moonPhase(new Date(Date.UTC(2026, 8, 16)));
  assert.ok(later.p >= 0 && later.p < 1);
  // a full moon is high at midnight and down at noon; a new moon keeps the sun's hours
  assert.ok(moonPosition(0, full).alt > 50 && moonPosition(12, full).alt < -50);
  assert.ok(moonPosition(12, nw).alt > 50);
});

test('the dome’s colours run from night to noon in order, and the stars fade with the sun', () => {
  for (let i = 1; i < KEYFRAMES.length; i++) assert.ok(KEYFRAMES[i][0] > KEYFRAMES[i - 1][0], 'keyframes by rising altitude');
  const night = skyColours(-30), dawn = skyColours(-3), day = skyColours(45);
  assert.ok(night.zenith[2] < 30 && night.dayness === 0, 'night is dark');
  assert.ok(dawn.horizon[0] > dawn.horizon[2], 'the dawn horizon is warm');
  assert.ok(day.zenith[2] > 180 && day.zenith[0] < 80, 'the day zenith is blue');
  assert.ok(day.horizon[2] > day.zenith[2] * 0.8 && day.horizon[0] > day.zenith[0], 'the horizon is paler than the zenith by day');
  assert.equal(starVisibility(-20), 1); assert.equal(starVisibility(5), 0);
  assert.ok(starVisibility(-6) > 0.3 && starVisibility(-6) < 0.6, 'half through nautical twilight');
  assert.deepEqual(Object.keys(WEATHER), ['clear', 'scattered', 'overcast', 'storm']);
  assert.ok(WEATHER.storm.rain && WEATHER.storm.storm && !WEATHER.clear.rain);
});

test('clouds and bolts are seeded: the same seed, the same sky', () => {
  const a = cloudField(3, 6), b = cloudField(3, 6), c = cloudField(4, 6);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 6);
  for (const cl of a) { assert.ok(cl.v > 0.05 && cl.v < 0.6, 'in the upper half'); assert.ok(cl.puffs.length >= 4); }
  assert.deepEqual(cirrusField(5, 3), cirrusField(5, 3));
  const bolt = boltPoints(7, 100, 20, 120, 400);
  assert.deepEqual(bolt, boltPoints(7, 100, 20, 120, 400));
  assert.ok(bolt.length > 20 && bolt[0].y === 20 && bolt[bolt.length - 1].y === 400, 'from the cloud to the ground');
});

test('a frame draws on a stub context at day, at dusk and at a stormy night without a gradient, a blend mode or a throw, and reports what it drew', () => {
  const at = new Date(2026, 8, 16, 12, 0, 0).getTime();
  const day = stubCtx();
  let stars = 0;
  const r1 = drawLivingSky(day.ctx, 800, 400, 1, 1000, { skyClock: 'real', skyNowMs: at, skyWeather: 'scattered' }, { softStops: stops, drawStars: () => { stars++; } });
  assert.ok(r1.sun && r1.stars === 0 && Math.abs(r1.alt - 62) < 1e-6, 'noon: the sun, no stars');
  assert.equal(stars, 0, 'the star field is not drawn by day');
  assert.equal(day.calls.gradients, 0, 'no gradients');
  assert.ok(day.calls.arc > 100, 'the dome, the sun and the clouds are discs');
  const dusk = stubCtx();
  const r2 = drawLivingSky(dusk.ctx, 800, 400, 1, 1000, { skyClock: 'fixed', skyHour: 18.6 }, { softStops: stops, drawStars: () => { stars++; } });
  assert.ok(r2.alt < 0 && r2.alt > -12 && r2.stars > 0 && r2.stars < 1, 'dusk: the stars are coming out');
  assert.ok(stars > 0, 'and the star field was asked for');
  const storm = stubCtx();
  const r3 = drawLivingSky(storm.ctx, 800, 400, 1, 3000, { skyClock: 'fixed', skyHour: 1, skyWeather: 'storm', skyNowMs: new Date(Date.UTC(2000, 0, 21, 4, 40)).getTime() }, { softStops: stops, drawStars: () => { stars++; } });
  assert.equal(r3.stars, 1, 'full night');
  assert.ok(r3.moon, 'a full moon is up at one in the morning');
  assert.ok(storm.calls.lineTo > 50, 'rain');
  // with no helpers for the stars it still draws
  const bare = stubCtx();
  assert.doesNotThrow(() => drawLivingSky(bare.ctx, 400, 200, 2, 0, { skyType: 'living', skyClock: 'fixed', skyHour: 3 }, { softStops: stops, drawStars: null }));
  // the source keeps the canvas rules
  const src = readFileSync(new URL('../public/js/livingsky.js', import.meta.url), 'utf8');
  for (const bad of [/\.globalAlpha\s*=/, /globalCompositeOperation\s*=/, /shadowBlur\s*=/, /createLinearGradient\(/, /createRadialGradient\(/, /\.clip\(/]) assert.ok(!bad.test(src), `no ${bad}`);
});

test('the settings reach every board that draws a sky, and each board chooses its own', () => {
  const n = normalise(null);
  assert.equal(n.sky.type, undefined, 'there is no global sky any more: each board has a `sky` (docs/PLAN-SKIES.md)');
  assert.deepEqual(Object.keys(skyExtras(n)), ['skyClock', 'skyHour', 'skyWeather', 'skyCover', 'skyLat', 'skyRays', 'skyRainbow', 'skyShooting', 'skyMoon']);
  assert.equal(skyExtras(n).skyCover, undefined, '-1 leaves the cover to the weather');
  assert.equal(skyExtras(n).skyLat, undefined, 'no latitude by default');
  const l = normalise({ space: { sky: 'earth' }, markets: { sky: 'earth' }, tetrust: { sky: 'earth' }, blockout: { sky: 'earth' }, blockanoid: { sky: 'earth' }, scorched: { sky: 'earth' }, sky: { clock: 'fixed', hour: 7, weather: 'storm', cover: 0.5, lat: 40 } });
  for (const o of [spaceOptions(l), marketsOptions(l)]) { assert.equal(o.skyType, 'earth'); assert.equal(o.skyHour, 7); assert.equal(o.skyWeather, 'storm'); assert.equal(o.skyCover, 0.5); assert.equal(o.skyLat, 40); }
  for (const o of [tetrustOptions(l), blockoutOptions(l), blockanoidOptions(l), scorchedOptions(l)]) { assert.equal(o.sky.skyType, 'earth'); assert.equal(o.sky.skyClock, 'fixed'); }
  assert.equal(normalise({ space: { sky: 'no-such' } }).space.sky, 'galaxy');
  assert.equal(normalise({ sky: { hour: 30 } }).sky.hour, 24, 'clamped to the slider');
  const rows = PANEL.find((g) => g.group === 'sky').rows.map((r) => r.key);
  for (const k of ['clock', 'hour', 'weather', 'cover', 'lat', 'rays', 'rainbow', 'shooting']) assert.ok(rows.includes(k), `${k} has a row`);
  // the Space effects go off under the Earth, and the switches are kept for the Galaxy
  const withFx = normalise({ space: { sky: 'earth', idleFx: true }, effects: { nova: true, ripple: true } });
  assert.equal(spaceOptions(withFx).idleFx, false, 'no idle effects over a blue afternoon');
  assert.deepEqual(spaceOptions(withFx).fxKinds, [], 'none in the rotation');
  assert.equal(withFx.effects.nova, true, 'the switch itself is untouched');
  const back = normalise({ ...withFx, space: { ...withFx.space, sky: 'galaxy' } });
  assert.equal(spaceOptions(back).idleFx, true, 'the Galaxy gets them back');
  assert.ok(spaceOptions(back).fxKinds.includes('nova'));
  assert.deepEqual(marketsOptions(normalise({ markets: { sky: 'earth' }, marketEffects: { firework: true } })).fxKinds, [], 'and the market effects likewise');
  // one board at a time: the artillery under the Earth while the candles keep the Galaxy
  const mixed = normalise({ scorched: { sky: 'earth' }, markets: { sky: 'galaxy' } });
  assert.equal(scorchedOptions(mixed).sky.skyType, 'earth'); assert.equal(marketsOptions(mixed).skyType, 'galaxy'); assert.equal(marketsOptions(mixed).galaxy, true);
  // the renderer draws it in the star field's place and the games pass it to their sky canvases
  const engine = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(engine, /earthSky\(opts\)\) drawLivingSky/);
  for (const f of ['tetrust.js', 'blockout.js', 'blockanoid.js', 'scorchedyard.js']) assert.match(readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8'), /\.\.\.[tb]\.sky,/, `${f} passes the sky`);
});

// THE SUN AND THE MOON ARE THERE TO BE SEEN (operator, 2026-09-16: "so sun and moon any more?")
test('the horizon can be raised, the discs go over the clouds, and the moon is up every night unless asked otherwise', () => {
  const w = 800, h = 400;
  // a board whose land fills the lower third raises the horizon: the same sun sits higher
  const noon = sunPosition(12);
  assert.ok(sunScreen(noon, w, h, 62, 0.6).y < sunScreen(noon, w, h, 62, 1).y, 'a raised horizon lifts the whole track');
  assert.ok(Math.abs(sunScreen(sunPosition(18), w, h, 62, 0.6).y - h * 0.6) < h * 0.12, 'and the sun sets at the horizon the board named, not at the panel\u2019s bottom');
  // the discs are painted after the clouds: the sun's glow before them, its disc after
  const src = readFileSync(new URL('../public/js/livingsky.js', import.meta.url), 'utf8');
  const glow = src.indexOf("paintSun(ctx, pw, ph, s, sun, cols, softStops, 'glow')"), clouds = src.indexOf('paintClouds(ctx, pw, ph, now, opts, sun, s, cols, weather, softStops);'), disc = src.indexOf("paintSun(ctx, pw, ph, s, sun, cols, softStops, 'disc')");
  assert.ok(glow > 0 && clouds > glow && disc > clouds, 'glow, then clouds, then the disc');
  assert.ok(src.indexOf('paintMoon(ctx, pw, ph, m, moon, shown, night, cols, softStops);') > clouds, 'the moon over the clouds too');
  // a new moon at one in the morning: none on the real track, a fat crescent up in the shipped mode
  const stops = () => {};
  const ctx = () => ({ fillStyle: '', strokeStyle: '', lineWidth: 1, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fillRect() {}, clearRect() {}, ellipse() {} });
  const newMoon = new Date(Date.UTC(2000, 0, 6, 18, 14)).getTime();
  const real = drawLivingSky(ctx(), w, h, 1, 0, { skyClock: 'fixed', skyHour: 1, skyMoon: 'real', skyNowMs: newMoon }, { softStops: stops, drawStars: null });
  const nightly = drawLivingSky(ctx(), w, h, 1, 0, { skyClock: 'fixed', skyHour: 1, skyNowMs: newMoon }, { softStops: stops, drawStars: null });
  assert.equal(real.moon, false, 'the real new moon is not there to be seen');
  assert.equal(nightly.moon, true, 'the shipped moon is up at one in the morning whatever the calendar says');
  const noonNightly = drawLivingSky(ctx(), w, h, 1, 0, { skyClock: 'fixed', skyHour: 12, skyNowMs: newMoon }, { softStops: stops, drawStars: null });
  assert.equal(noonNightly.moon, false, 'and down by day');
  assert.equal(drawLivingSky(ctx(), w, h, 1, 0, { skyClock: 'fixed', skyHour: 12, skyHorizon: 0.58 }, { softStops: stops, drawStars: null }).horizon, 0.58, 'the horizon the board asked for is the one it drew');
  const game = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.match(game, /skyHorizon: 0\.58,/, 'Scorched Yard sets its horizon where its land is');
});

// THE MOON'S PHASES AND ITS GLOW (operator, 2026-09-16: "Can we give the moon a glow effect as
// well? Is it ever a full moon? Does it go through phases?")
test('the moon runs through its phases on the real calendar, a month in twelve hours under the cycle clock, and glows more the fuller it is', () => {
  const full = moonPhase(new Date(Date.UTC(2000, 0, 21, 4, 40))), nw = moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14)));
  assert.ok(full.lit > 0.98 && nw.lit < 0.02, 'full and new on their dates');
  assert.ok(moonPhase(new Date(Date.UTC(2000, 0, 14))).lit > 0.4 && moonPhase(new Date(Date.UTC(2000, 0, 14))).lit < 0.6, 'a quarter halfway between');
  // under the cycle clock the calendar advances a day per 24-minute day
  const t0 = skyTime({ skyClock: 'cycle' }, 0), t1 = skyTime({ skyClock: 'cycle' }, 24 * 60000 * 15);
  assert.equal(t0.cycleDays, 0); assert.equal(t1.cycleDays, 15, 'fifteen cycle days six hours later');
  assert.equal(skyTime({ skyClock: 'real' }, 24 * 60000 * 15).cycleDays, 0, 'the real clock keeps the real calendar');
  const src = readFileSync(new URL('../public/js/livingsky.js', import.meta.url), 'utf8');
  assert.match(src, /moonPhase\(t\.mode === 'cycle' \? new Date\(t\.date\.getTime\(\) \+ t\.cycleDays \* 86400000\) : t\.date\)/, 'the phase is taken from the cycle\u2019s own calendar');
  // the glow: two layers, stronger for a fuller moon
  const halo = src.slice(src.indexOf('THE HALO (operator'), src.indexOf('ONLY THE LIT PART IS PAINTED'));
  assert.ok((halo.match(/softStops\(ctx, m\.x, m\.y, r \* /g) || []).length === 2, 'a wide corona and a tight one');
  assert.match(halo, /0\.35 \+ 0\.65 \* Math\.max\(0, Math\.min\(1, phase\.lit\)\)/, 'scaled by the lit fraction');
});
