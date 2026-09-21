// LIGHTNING (public/js/lightning.js): the shape of a bolt and the life of a stroke, as numbers.
//
// The lightning ball used to re-randomise six-point zig-zags every frame, which at sixty frames a second is fuzz
// (operator, 2026-09-22: "we need to dramatically improve the lightning effect for the lightning ball", with
// footage of real strikes). What makes lightning read as lightning is held here: a channel keeps its SHAPE while
// its BRIGHTNESS slams on, re-strikes and dies; it is tortuous at every scale; it forks, thinner and fainter; and
// several are alive at once, out of step, with dark gaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boltShape, strokeLight, strokesAt, seeded } from '../public/js/lightning.js';

const lengthOf = (p) => { let l = 0; for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return l; };

test('a bolt is its seed: the same seed the same bolt, another seed another', () => {
  assert.deepEqual(boltShape(7, 0, 0, 200, 120), boltShape(7, 0, 0, 200, 120));
  assert.notDeepEqual(boltShape(7, 0, 0, 200, 120)[0].pts, boltShape(8, 0, 0, 200, 120)[0].pts);
  const r = seeded(3); const a = [r(), r(), r()]; const r2 = seeded(3);
  assert.deepEqual(a, [r2(), r2(), r2()]);
  assert.ok(a.every((v) => v >= 0 && v < 1));
});

test('the main channel runs from A to B, tortuous at every scale', () => {
  for (const seed of [1, 2, 3, 99, 12345]) {
    const main = boltShape(seed, 10, 20, 210, 140)[0];
    const p = main.pts, n = p.length >> 1;
    assert.equal(main.level, 0); assert.equal(main.weight, 1);
    assert.deepEqual([p[0], p[1]], [10, 20], 'it starts at A');
    assert.ok(Math.abs(p[2 * n - 2] - 210) < 1e-9 && Math.abs(p[2 * n - 1] - 140) < 1e-9, 'and ends at B');
    assert.ok(n >= 33, `dozens of kinks, not six (${n})`);
    const straight = Math.hypot(200, 120), path = lengthOf(p);
    assert.ok(path > straight * 1.08 && path < straight * 2.2, `longer than the straight line, but still GOING there (${(path / straight).toFixed(2)}x)`);
    // every scale: the path is rough when looked at coarsely AND when looked at finely
    const coarse = []; for (let i = 0; i < n; i += 8) coarse.push(p[2 * i], p[2 * i + 1]); coarse.push(p[2 * n - 2], p[2 * n - 1]);
    assert.ok(lengthOf(coarse) > straight * 1.03, 'big kinks');
    assert.ok(path > lengthOf(coarse) * 1.03, 'and small ones along them');
    // it never wanders off: no point further from the A-B line than a third of its length
    const ux = 200 / straight, uy = 120 / straight;
    for (let i = 0; i < n; i++) assert.ok(Math.abs((p[2 * i] - 10) * -uy + (p[2 * i + 1] - 20) * ux) < straight * 0.34);
  }
});

test('it forks: from the parent itself, mostly early, shorter, thinner and fainter, and forks fork', () => {
  let forks = 0, second = 0, early = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const shape = boltShape(seed, 0, 0, 300, 0, { forks: 6, depth: 2 });
    const main = shape[0], mainLen = lengthOf(main.pts);
    for (const ch of shape.slice(1)) {
      assert.ok(ch.level === 1 || ch.level === 2);
      assert.ok(ch.weight < 0.7 && ch.weight > 0.05, 'fainter than the channel it left');
      assert.ok(lengthOf(ch.pts) < mainLen * 0.75, 'and shorter');
      if (ch.level === 1) {
        forks++; if (ch.at < 0.5) early++;
        // it LEAVES the main channel: its first point is a point of the main channel
        let on = false; for (let i = 0; i < main.pts.length; i += 2) if (Math.abs(main.pts[i] - ch.pts[0]) < 1e-9 && Math.abs(main.pts[i + 1] - ch.pts[1]) < 1e-9) on = true;
        assert.ok(on, 'a fork starts ON its parent');
      } else second++;
    }
  }
  assert.ok(forks / 40 >= 3, `several forks a bolt (${(forks / 40).toFixed(1)})`);
  assert.ok(second > 0, 'and forks of forks');
  assert.ok(early / forks > 0.6, `shed on the way out, not at the foot (${(early / forks).toFixed(2)} in the first half)`);
  assert.equal(boltShape(5, 0, 0, 300, 0, { forks: 0 }).length, 1, 'no forks asked for: the channel alone');
});

test('a stroke\'s light: it slams on, re-strikes, and ends at nothing', () => {
  assert.equal(strokeLight(-1, 200, 9), 0); assert.equal(strokeLight(200, 200, 9), 0); assert.equal(strokeLight(500, 200, 9), 0);
  for (const seed of [1, 2, 3, 4, 5, 77]) {
    const at = (a) => strokeLight(a * 200, 200, seed);
    assert.ok(at(0) > 1.2, 'the return stroke is the brightest instant, at once');
    assert.ok(at(0.06) < at(0) * 0.75, 'and falls fast');
    assert.ok(at(0.999) < 0.05, 'no step at the end');
    // a re-strike: somewhere after the first fall the light RISES again
    // (a re-strike climbs over about a twentieth of the life: compare across that, not across one tiny step)
    let rises = 0; for (let a = 0.12; a < 0.85; a += 0.005) if (at(a + 0.04) > at(a) * 1.25 && at(a + 0.04) > 0.3) rises++;
    assert.ok(rises >= 1, `it re-strikes (seed ${seed})`);
    assert.deepEqual(at(0.4), at(0.4), 'and it is a function of its age alone');
  }
});

test('the storm: several slots out of step, dark gaps, a NEW bolt each firing, and no state', () => {
  const seen = new Map(); let dark = 0, frames = 0, most = 0;
  for (let t = 0; t < 30000; t += 16) {
    const alive = strokesAt(t, 4242, 5).filter((k) => strokeLight(k.age, k.life, k.seed) > 0.04);
    frames++; if (!alive.length) dark++; most = Math.max(most, alive.length);
    for (const k of alive) {
      assert.ok(k.age >= 0 && k.age < k.life && k.life >= 130 && k.life <= 340);
      const was = seen.get(k.slot); if (!was || !was.has(k.seed)) seen.set(k.slot, (was ?? new Set()).add(k.seed));
    }
  }
  assert.ok(dark / frames > 0.02 && dark / frames < 0.3, `a staccato: some frames are dark, most are not (${(100 * dark / frames).toFixed(1)}% dark)`);
  assert.ok(most >= 3, 'and at times several are alight together');
  for (const [slot, seeds] of seen) assert.ok(seeds.size > 20, `slot ${slot} fired many DIFFERENT bolts (${seeds.size})`);
  assert.deepEqual(strokesAt(12345, 7), strokesAt(12345, 7), 'the same clock is the same storm');
  // A STROKE HOLDS ITS SHAPE FOR ITS WHOLE LIFE: across consecutive frames an alive slot keeps its seed
  let held = 0;
  for (let t = 1000; t < 3000; t += 16) {
    const a = strokesAt(t, 4242), b = strokesAt(t + 16, 4242);
    for (const k of a) { const same = b.find((q) => q.slot === k.slot); if (same && same.age > k.age) { assert.equal(same.seed, k.seed); held++; } }
  }
  assert.ok(held > 100, 'frame after frame, the same channel');
});

test('ball lightning (the storm ball) draws it -- bolts, crackle and all -- and the plasma ball throws none', () => {
  // THE NAMES WERE CROSSED (operator, 2026-09-22: "We need to remove the lightning effect on the plasma ball. Only the
  // lightning ball should emit lightning bolts", and, shown the storm ball: "this is the one that needs to emit
  // lightning bolts, not the other effect"). His lightning ball is agents.js's storm ball; his plasma ball is `ball`.
  const d3 = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const ball = d3.slice(d3.indexOf('function drawBall(ctx, view, lw) {'), d3.indexOf('function drawGround(')).replace(/\/\/.*$/gm, '');
  assert.ok(!/boltShape|strokesAt|strokeLight/.test(ball), 'the plasma ball draws no lightning');
  assert.ok(!/from '\.\/lightning\.js'/.test(d3), 'and details3d.js no longer needs lightning.js at all');
  const ag = readFileSync(new URL('../public/js/agents.js', import.meta.url), 'utf8');
  const storm = ag.slice(ag.indexOf("defineAgent('stormball'"), ag.indexOf('BATCH FIVE'));
  assert.match(storm, /boltShape\(\(\(arc\.seed >>> 0\)/, 'its arcs are lightning.js channels, on either board');
  assert.match(storm, /for \(let u = 0\.03; u < 0\.97;/, 'and they are built for the block board as for the price board');
  // THE CRACKLE AND THE SPARKS (the same day: "we need to improve the energy crackles on it, as well as whatever those
  // dots are that are orbiting it"): held tendrils from the clock, not fourteen hairs re-rolled from Math.random a frame
  const crackle = storm.slice(storm.indexOf('// THE CRACKLE'));
  assert.ok(!/Math\.random/.test(crackle.replace(/\/\/.*$/gm, '')), 'no dice a frame in the crackle');
  assert.match(crackle, /for \(const k of strokesAt\(now, fseed, \d+\)\)/); assert.match(crackle, /boltShape\(k\.seed, x0, y0, x1, y1,/);
  assert.match(crackle, /strokeLight\(k\.age, k\.life, k\.seed\)/);
  // sized by the ball, which is sized by the board's unit: a small Kiosk panel gets a small crackle
  assert.match(crackle, /len = R \* \(/);
  const sparks = storm.slice(storm.indexOf('// THE SPARKS IN ORBIT'), storm.indexOf('// THE CRACKLE'));
  assert.match(sparks, /const PLANES = \[\[/, 'three tilted orbits');
  assert.match(sparks, /if \(back && Math\.hypot\(head\.x - c\.x, head\.y - c\.y\) < R \* 1\.0\) return;/, 'a spark behind the ball is not seen');
  assert.match(storm, /sparkAt\(i, true\);[\s\S]*\/\/ the ball:[\s\S]*sparkAt\(i, false\);/, 'the far ones under the ball, the near ones over it');
});
