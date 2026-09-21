// LIGHTNING (2026-09-22; operator: "we need to dramatically improve the lightning effect for the lightning
// ball in WebGL", with volcanic lightning over Fuego for the look).
//
// What was here before, in drawBall: four to seven bolts, each a six-point zig-zag, RE-RANDOMISED EVERY
// FRAME. At sixty frames a second that is not lightning, it is fuzz: no channel exists long enough to be
// seen, nothing forks, nothing flashes. Lightning is the opposite of noise in every one of those ways:
//
//   a channel HOLDS ITS SHAPE for a fifth of a second. What changes is its BRIGHTNESS: it slams on (the
//       return stroke), flickers through one to three re-strikes down the same path, and dies away.
//   it is tortuous AT EVERY SCALE -- a big kink, smaller kinks along that, smaller still along those --
//       which is midpoint displacement, the amplitude halving as the pieces do.
//   it FORKS: side channels leave it at a sharp angle, mostly early on, shorter and fainter than their
//       parent, some forking again, all of them petering out in the air.
//   several are alive at once, out of step, with dark gaps between: a staccato, never a steady state.
//
// So this file is two pure things, tested as numbers: the SHAPE of a bolt from a seed (boltShape), and
// the LIFE of a stroke from the clock (strokesAt, strokeLight). Nothing here draws, keeps state, or asks
// Math.random for anything -- the same clock paints the same storm, on either renderer.

/** A small seeded generator (mulberry32): the only randomness in this file. */
export function seeded(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One channel from A to B by midpoint displacement: flat [x, y, ...], 2^levels segments. Pure. */
function channel(rnd, ax, ay, bx, by, levels, rough) {
  let pts = [ax, ay, bx, by];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let amp = len * rough;
  for (let l = 0; l < levels; l++) {
    const out = [pts[0], pts[1]];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
      const dx = x1 - x0, dy = y1 - y0, sl = Math.hypot(dx, dy) || 1;
      // sideways off the piece it splits, by an amount that halves as the pieces do -- and a little
      // ALONG it too, so the kinks are not evenly spaced (an even zig-zag reads as a saw, not a spark)
      const off = (rnd() * 2 - 1) * amp, slip = (rnd() - 0.5) * 0.3;
      out.push((x0 + x1) / 2 + dx * slip - (dy / sl) * off, (y0 + y1) / 2 + dy * slip + (dx / sl) * off, x1, y1);
    }
    pts = out;
    amp *= 0.52;
  }
  return pts;
}

/**
 * The shape of one bolt from (ax, ay) to (bx, by): its main channel and every fork, each
 * { pts: flat [x, y, ...], level (0 the main channel, 1 a fork, 2 a fork of a fork), weight (1 down to ~0.2:
 * how thick and bright beside the main channel), at (where along its parent it leaves, 0..1) }.
 * The same seed is the same bolt. Pure.
 */
export function boltShape(seed, ax, ay, bx, by, { rough = 0.17, forks = 4, depth = 2 } = {}) {
  const rnd = seeded(seed);
  const out = [];
  const grow = (x0, y0, x1, y1, level, weight, at) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) return;
    const levels = Math.max(2, 6 - level * 2 - (len < 40 ? 1 : 0));
    const pts = channel(rnd, x0, y0, x1, y1, levels, rough * (1 + 0.25 * level));
    out.push({ pts, level, weight, at });
    if (level >= depth) return;
    const n = pts.length >> 1;
    const count = Math.max(0, Math.round(forks * (level === 0 ? 1 : 0.5) * (0.6 + 0.8 * rnd())));
    for (let f = 0; f < count; f++) {
      // mostly early along the parent: a channel sheds its forks on the way out, not at its foot
      const t = 0.08 + 0.72 * Math.pow(rnd(), 1.5);
      const i = Math.min(n - 2, Math.max(1, Math.round(t * (n - 1))));
      const px = pts[2 * i], py = pts[2 * i + 1];
      // off the parent's OVERALL heading (not the local kink's, which points anywhere) by a sharp angle
      const head = Math.atan2(y1 - y0, x1 - x0);
      const ang = head + (rnd() < 0.5 ? -1 : 1) * (0.35 + 0.75 * rnd());
      const reach = len * (0.18 + 0.34 * rnd()) * (1 - 0.55 * t);
      grow(px, py, px + Math.cos(ang) * reach, py + Math.sin(ang) * reach, level + 1, weight * (0.42 + 0.2 * rnd()), t);
    }
  };
  grow(ax, ay, bx, by, 0, 1, 0);
  return out;
}

/**
 * How bright a stroke is, `age` ms into a life of `life` ms: the return stroke's slam and fast fall, one to
 * three re-strikes down the same channel, a thin continuing current under them, and out. 0 when it is
 * not alive; about 1.3 at the first instant. Pure.
 */
export function strokeLight(age, life, seed) {
  if (!(age >= 0) || !(age < life)) return 0;
  const a = age / life, rnd = seeded(seed ^ 0x51ed27);
  let v = 1.3 * Math.exp(-a * 11) + 0.30 * (1 - a) * (1 - a);
  const again = 1 + Math.floor(rnd() * 3);
  for (let k = 0; k < again; k++) {
    const when = 0.18 + 0.6 * rnd(), how = 0.55 + 0.5 * rnd();
    const d = (a - when) / 0.035;
    if (d > -3 && d < 9) v += how * (d < 0 ? Math.exp(-d * d) : Math.exp(-d * 0.55));   // up in an instant, down slower
  }
  return v * (1 - Math.pow(a, 6));                       // and it ends at nothing, not at a step
}

/**
 * Which strokes are alive at `now` (ms): `slots` channels out of step with each other, each firing, going
 * dark, and firing again as ANOTHER bolt -- [{ slot, seed (this firing's: a new shape each time), age, life }].
 * A function of the clock alone: no state, the same `now` is the same storm. Pure.
 */
export function strokesAt(now, seed, slots = 5) {
  const out = [];
  for (let s = 0; s < slots; s++) {
    const r = seeded((seed * 7919 + s * 104729) >>> 0);
    const period = 260 + 520 * r();                       // ms between this slot's firings...
    const phase = period * r();
    const n = Math.floor((now + phase) / period);
    const mine = seeded((seed * 31 + s * 977 + n * 7) >>> 0);
    const life = Math.min(period * 0.85, 130 + 210 * mine());   // ...of which it is alight for this long: the rest is dark
    const age = (now + phase) - n * period;
    if (age < life) out.push({ slot: s, seed: ((seed * 131 + s * 8191 + n * 524287) >>> 0) || 1, age, life });
  }
  return out;
}
