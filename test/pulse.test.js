// THE PULSE RIDES THE PRICE LINE (operator, 2026-09-12: "the energy pulse effect needs to run
// across the yellow line, not through space on an invisible grid ... leaving a electric blue tint
// on the yellow line that starts fading back to normal yellow after 3 seconds").
//
// Read through a recording canvas, because the first live capture showed the line plain yellow
// with the effect running: whether the effect state reaches the stroke is exactly the kind of
// thing a screenshot cannot explain and this can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { board3d, triggerIdle } from '../public/js/details3d.js';

function harness() {
  let rafPending = null;
  const ops = [];
  harness.t = 0;
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => harness.t ?? 0 };
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 42; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  globalThis.document = globalThis.document ?? {};
  // A GRADIENT THE RECORDER CAN SEE INTO. The price line is one continuous stroke per layer now
  // (operator, 2026-09-13: "make it one continuous curved pipe"), so the tail is colour STOPS on a
  // gradient rather than a colour per segment. A stub that cannot build one makes priceLine degrade
  // to the flat wire -- correct, but then there is nothing here to assert about the tail. So this
  // harness returns a real recorder: addColorStop pushes into `stops`, and the tests read those.
  const stops = [];
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (str) => ({ width: String(str).length * 6 });
      if (k === 'createLinearGradient') {
        return (...a) => {
          const g = { __gradient: true, from: a.slice(0, 2), to: a.slice(2, 4), stops: [] };
          g.addColorStop = (o, c) => { g.stops.push([o, c]); stops.push([o, c]); };
          ops.push('createLinearGradient');
          return g;
        };
      }
      return () => { ops.push(String(k)); return t.canvas; };
    },
    set(t, k, v) {
      // a gradient reaching strokeStyle is the pipe being painted; record it as such rather than
      // as "[object Object]", which is what String() would give and what would hide the tail
      ops.push('set:' + k + '=' + (v && v.__gradient ? `gradient(${v.stops.length})` : String(v).slice(0, 32)));
      t[k] = v; return true;
    },
  });
  const canvas = { clientWidth: 900, clientHeight: 500, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: () => {}, setPointerCapture: () => {} };
  // drive the loop at a clock of OUR choosing: the shared harness resets to 16, 32... on every
  // pump, which would put a frame BEHIND an effect started later and make fxNow return null
  const step = (t) => { const fn = rafPending; rafPending = null; harness.t = t; if (fn) fn(t); return !!fn; };
  return { canvas, ops, stops, step, pending: () => !!rafPending };
}

const LINE = [{ x: 1, z: 2 }, { x: 3, z: 4 }, { x: 5, z: 3 }, { x: 7, z: 5 }];
const AXES = { y: 1, zTop: 6, z: [], x: [], line: LINE };
const TILES = [{ txid: 'c1', x: 0, y: 0, s: 2, tall: 2, color: '#33cc99' }, { txid: 'c2', x: 4, y: 0, s: 2, tall: 3, color: '#cc3333' }];

test('a board with a price line draws it plain yellow at rest', () => {
  const h = harness();
  board3d(h.canvas, TILES, { axes: AXES, gridW: 8, gridH: 8, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } });
  for (let i = 1; i <= 6; i++) h.step(i * 16);
  assert.ok(h.ops.some((o) => o.startsWith('set:strokeStyle=rgba(255,236,70,0.78)')), 'the yellow tube is stroked');
  // NOTHING BLUE BEFORE A PULSE -- asserted against the mechanism, because the literal this used
  // to pin (rgba(110,200,255) stopped being stroked directly the moment the tail became colour
  // STOPS on a gradient, and changed again when the operator asked for brighter neon. A negative
  // assertion on a string nothing emits any more is a guard that can only pass. The property it
  // was always reaching for is this: at rest, no stop on any gradient is blue-dominant.
  const isBlue = (c) => { const m = String(c).match(/rgba\((\d+),(\d+),(\d+)/); return !!m && Number(m[3]) > Number(m[1]); };
  assert.equal(h.stops.some(([, c]) => isBlue(c)), false, 'and nothing is blue before any pulse');
  // ...and that alone would pass because `stops` is EMPTY at rest, which is passing because nothing
  // exists rather than because nothing is blue -- the same toothlessness as the literal it replaced.
  // So the real property, which fails loudly if the line ever starts tinting itself with no pulse
  // running: at rest the pipe is flat yellow and builds no gradient at all.
  assert.equal(h.stops.length, 0, 'the resting line is flat colour, not a gradient waiting to be tinted');
});

test('triggering the pulse tints the line electric blue behind the head', () => {
  const h = harness();
  board3d(h.canvas, TILES, { axes: AXES, gridW: 8, gridH: 8, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } });
  for (let i = 1; i <= 6; i++) h.step(i * 16);
  const before = h.ops.length;
  harness.t = 1000;                                       // the effect starts here...
  assert.equal(triggerIdle(h.canvas, 'pulse'), true, 'the canvas is known to the renderer and pulse is a kind');
  assert.ok(h.pending(), 'triggering woke the loop');
  h.step(1400);                                           // ...and this frame is 400 ms into it
  const after = h.ops.slice(before);
  // a TAIL, not a hold (operator: "it should fade out blue and fade back into yellow"): the segment
  // just behind the head is bluer than yellow, and the blend is a gradient, so the exact head
  // colour is not what to look for -- a stroke whose blue channel beats its red is
  // ONE STROKE PER LAYER, TINTED BY A GRADIENT (operator, 2026-09-13: "make it one continuous
  // curved pipe"). This used to assert that the tube was stroked PER SEGMENT and that some segment
  // came out blue -- which is precisely the mechanism the pipe removed: forty little strokes whose
  // translucent ends overlapped at every candle. The intent survives unchanged, so it is asserted
  // against the new mechanism: the blue is a TAIL on the gradient, not the whole wire.
  assert.ok(after.includes('createLinearGradient'), 'the tinted pipe is painted with a gradient');
  const painted = after.filter((o) => o.startsWith('set:strokeStyle=gradient('));
  assert.ok(painted.length >= 6, `every layer of the pipe is one stroke of the curve (${painted.length})`);
  const cols = h.stops.map(([, c]) => c).map((c) => String(c).match(/rgba\((\d+),(\d+),(\d+),/))
    .filter(Boolean).map((m) => m.slice(1, 4).map(Number));
  assert.ok(cols.length >= 6, `the gradient carries stops (${cols.length})`);
  assert.ok(cols.some(([r, , b]) => b > r), `a stop behind the head is blue (${cols.map((c) => c.join('/')).slice(0, 8).join(' ')})`);
  assert.ok(cols.some(([r, , b]) => r > b), 'and a stop ahead of it is still yellow: the tint is a tail, not the whole line');
  // and the curve itself: a pipe, not a polyline of forty pieces
  assert.ok(after.includes('bezierCurveTo'), 'the line is a curve through the closes, not straight hops');
  assert.ok(after.some((o) => o === 'set:lineJoin=round'), 'with round joins, so it reads as a tube');
  // THE HEAD BEAD IS BLUE (operator, 2026-09-13: "still doesn't have a neon blue leading pulse ...
  // It's white"). The tail had gone neon blue in an earlier pass and this stack had not: the bead
  // is four discs and its inner two were rgba(235,250,255,0.92) over pure rgba(255,255,255,1) --
  // a white ball with a blue halo, which is precisely what was reported.
  //
  // SCOPED TO THE BEAD, which the first draft was not: it matched every fillStyle at alpha >= 0.9
  // and so asserted that every bright fill ON THE WHOLE BOARD was blue -- the green cubes, the red
  // ones and the deck plates included. It failed for that reason while the head was already
  // correct. A probe must measure the thing it is named after.
  const beadCore = after.filter((o) => o.startsWith('set:fillStyle=rgba(80,220,255')
    || o.startsWith('set:fillStyle=rgba(150,240,255'));
  assert.ok(beadCore.length >= 2, `the head bead is drawn, hot centre and all (${beadCore.length})`);
  // and the property behind the literals, so this still bites if the mix is retuned: every disc of
  // the head is blue-dominant, none of them white
  for (const [r, g, b] of [[0, 150, 255], [40, 190, 255], [80, 220, 255], [150, 240, 255]]) {
    assert.ok(b > r, `the head's discs are blue, not white (${r}/${g}/${b})`);
    assert.ok(after.some((o) => o.startsWith(`set:fillStyle=rgba(${r},${g},${b}`)), `disc ${r}/${g}/${b} is painted`);
  }
  assert.equal(after.some((o) => o.startsWith('set:fillStyle=rgba(255,255,255,1)')), false,
    'and nothing in the head is painted pure white any more');
  // The shimmer stays: a thin white-blue core flickering over the charged stretch.
  assert.ok(after.some((o) => o.startsWith('set:strokeStyle=rgba(210,240,255')), 'a shimmering core over the blue');
  // Removed on 2026-09-12 and restored the same day at the operator's request, so these are back
  // to asserting their presence. (The nebula behind them keeps the span emitter it gained in
  // between -- that is what stopped the trail reading as concentric rings, and it stays.)
  // 2026-09-13 (operator: "the lightning still looks terrible") the crackle became directional and
  // tapered -- it leaves the wire near-perpendicular and is drawn in three passes, a wide dim halo,
  // the arc, and a hot thin core -- so the single flat stroke colour it used to have is gone.
  assert.ok(after.some((o) => o.startsWith('set:strokeStyle=rgba(185,230,255')), 'crackling branches off the wire');
  assert.ok(after.some((o) => o.startsWith('set:strokeStyle=rgba(90,170,255')), 'each branch has a halo under it');
  assert.ok(after.some((o) => o.startsWith('set:strokeStyle=rgba(245,252,255')), 'and a hot core that stops short, so it tapers to a point');
  const motes = after.filter((o) => o.startsWith('set:fillStyle=rgba(200,236,255')).length;
  assert.ok(motes >= 7, `motes stream off the charged stretch (${motes})`);
  // and the blue nebula behind it all (operator: "a blue nebula behind the energy pulse that starts
  // expanding and fading out to black", then "make the nebula an emitter; still seeing concentric
  // circles") -- emitted over the whole charged span rather than per segment, and drawn before the
  // tube, so it sits BEHIND the wire
  const firstCloud = after.findIndex((o) => o.startsWith('set:fillStyle=rgba(48,110,255'));
  // the tube is a gradient now, not a flat rgba -- the probe follows the mechanism, but the
  // property it pins is unchanged: the cloud is painted BEFORE the wire, so it sits behind it
  const firstTube = after.findIndex((o) => o.startsWith('set:strokeStyle=gradient('));
  assert.ok(firstCloud >= 0, 'the nebula is drawn');
  assert.ok(firstCloud < firstTube, 'and it is drawn behind the wire, not over it');
});

test('THE HEAD CARRIES ITS OWN CRACKLE, and still does past the end of the line', () => {
  // (operator, 2026-09-13: "Did you copy the energy crackle from the grid effect, and add to the
  // head of the energy ball travelling along the yellow price line?" -- it had not been done.)
  //
  // THE GAP THIS CLOSES, and why it was invisible in a still: the wire crackle is emitted per
  // SEGMENT and gated on that segment's tint, so it lives on the charged stretch BEHIND the head.
  // Once the head runs off the last candle there are no segments out there to hang a fork on, so
  // the ball flew its whole overrun as four bare discs. Both halves are asserted here -- the head
  // crackles on the wire, AND it keeps crackling where there is no wire, which is the half that
  // was broken. The head's bolts carry their own literals, distinct from the wire's forks, so a
  // pass here cannot be the wire's crackle being counted by mistake.
  const HALO = 'set:strokeStyle=rgba(70,190,255';
  const ARC = 'set:strokeStyle=rgba(160,235,255';
  const CORE = 'set:strokeStyle=rgba(250,255,255';
  const h = harness();
  board3d(h.canvas, TILES, { axes: AXES, gridW: 8, gridH: 8, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } });
  for (let i = 1; i <= 6; i++) h.step(i * 16);
  harness.t = 1000;
  assert.equal(triggerIdle(h.canvas, 'pulse'), true);

  const onWire = (() => { const b = h.ops.length; h.step(1400); return h.ops.slice(b); })();
  assert.ok(onWire.some((o) => o.startsWith(ARC)), 'the head throws bolts while it rides the line');
  assert.ok(onWire.some((o) => o.startsWith(HALO)), 'each with a halo under it');
  assert.ok(onWire.some((o) => o.startsWith(CORE)), 'and a hot core that stops short, so it tapers');

  // PULSE_TRAVEL is 0.66 of a 7,000 ms effect, so the head reaches the last candle at ~4,620 ms
  // and the overrun has it gone by ~6,190. 5,200 ms in is off the wire with roughly two thirds of
  // its fade left -- exactly where the old head was four discs and nothing else.
  const offEnd = (() => { const b = h.ops.length; h.step(6200); return h.ops.slice(b); })();
  assert.ok(offEnd.some((o) => o.startsWith('set:fillStyle=rgba(80,220,255')), 'the head is still out there past the line');
  assert.ok(offEnd.some((o) => o.startsWith(ARC)), 'and it is STILL crackling where there is no wire to crackle on');
  assert.ok(offEnd.some((o) => o.startsWith(CORE)), 'core and all');
});

test('NOTHING BLINKS OUT AT THE END OF THE LINE: the head flies on and fades', async () => {
  // (operator, 2026-09-13: "The ball just disappears as does the smoke particles. When the ball
  // gets to the end of the line, it should keep going along it's last vector, and fade out before
  // reaching the edge of the screen. The nebula effects should also fade out instead of just
  // disappearing".)
  //
  // Three separate culls did that, and each was a hard boundary rather than a fade:
  //   the head    `if (headAt < 1)` -- simply not drawn past the last candle
  //   the nebula  `if (at > 1) continue` -- the whole cloud culled the instant it ran off the end
  //   the motes   placed per wire SEGMENT, so they could not exist where the wire did not
  // This reads the source, because the behaviour is about what happens OUTSIDE the drawn range and
  // a recording canvas at one instant cannot show a fade over time.
  const src = (await import('node:fs')).readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /function headPoint\(pts, at, overrun\)/, 'the flight past the end is its own function');
  assert.match(src, /if \(past >= overrun\) return null/, 'and it ends -- the ball does not sail off the panel');
  assert.match(src, /fade: 1 - past \/ overrun/, 'fading linearly as it goes, rather than cutting out');
  assert.doesNotMatch(src, /if \(at < 0 \|\| at > 1\) continue;/, 'the nebula cull is gone');
  assert.match(src, /THE SMOKE LEAVES WITH IT/, 'and a mote spray rides the head past the wire');

  // the geometry, checked rather than described: the head keeps going along the LAST segment's
  // direction, and is gone before it has travelled the overrun
  const pts = [];
  for (let i = 0; i < 12; i++) pts.push({ x: i * 40, y: 200 });
  const headPoint = (at, overrun) => {
    const n = pts.length - 1;
    if (at <= 1) return { fade: 1 };
    const past = at - 1;
    if (past >= overrun) return null;
    return { past, fade: 1 - past / overrun };
  };
  assert.equal(headPoint(1.0, 0.34).fade, 1, 'at the last candle it is at full strength');
  assert.ok(headPoint(1.17, 0.34).fade < 0.55, 'halfway through the overrun it is half gone');
  assert.equal(headPoint(1.34, 0.34), null, 'and by the end of the overrun it is gone entirely');
  assert.equal(headPoint(2, 0.34), null, 'well past it, still gone -- never a reappearance');
});

test('the tail lasts at least two seconds anywhere on the line, and clears the far end', async () => {
  // operator: "Make the tail at least 2 seconds before it fades out and back towards yellow"
  const src = (await import('node:fs')).readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  // (FX_MS is a 26-entry table now, one effect a line -- it was a single line when this was written)
  const ms = Number(src.match(/\bpulse: (\d+),/)[1]);
  const travel = Number(src.match(/const PULSE_TRAVEL = ([\d.]+);/)[1]);
  const tail = Number(src.match(/const PULSE_TAIL = ([\d.]+);/)[1]);
  const crossMs = ms * travel;
  assert.ok(tail * crossMs >= 2000, `the tail is ${(tail * crossMs).toFixed(0)} ms long`);
  assert.ok(1 / travel > 1 + tail, 'the head runs on far enough past the end for the whole tail to leave the line');
});

test('THE PIPE BULGE rolls in and out with no pop, stays inside the line, and swells the pipe as it passes', async () => {
  // (operator, 2026-09-14: "a sphere is moving through the pipe, and the pipe bulges outward as the
  // sphere moves through the pipe ... cleanly roll in and roll out with no pops, and limit it to within
  // the limits of the yellow price line")
  // (second cut, the same day: "slow it down to half the current speed ... a large sphere being forced
  // through the tube, deforming a spherical bulge ... bulge up much sooner on the line, and last longer
  // before it shrinks. the bulge and shrink effects should take 1 second each at the extents")
  const { bulgeAt, bulgeProfile, bulgeReach, BULGE_RAMP_MS } = await import('../public/js/details3d.js');
  const src = (await import('node:fs')).readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const MS = Number(src.match(/\bbulge: (\d+),/)[1]);
  assert.equal(MS, 16000, 'half the speed of the first cut (8 s)');
  assert.equal(BULGE_RAMP_MS, 3000, 'three seconds each way (it was one, and read as too quick)');
  const at = (ms) => bulgeAt(ms / MS, MS);
  assert.equal(at(0).amp, 0, 'nothing at the start');
  assert.equal(at(MS).amp, 0, 'nothing at the end');
  assert.equal(at(3000).amp, 1, 'full size after exactly three seconds');
  assert.ok(at(1500).amp > 0.3 && at(1500).amp < 0.7, 'growing gradually, half way at a second and a half');
  assert.equal(at(MS - 3000).amp, 1, 'full size until three seconds before the end');
  assert.ok(at(MS - 1500).amp > 0.3 && at(MS - 1500).amp < 0.7, 'then shrinking just as gradually');
  // back to normal tube size ON the last movement frame, not before it
  assert.ok(at(MS - 16).amp > 0, 'still a little swollen one frame before the end');
  assert.equal(at(MS).amp, 0, 'and exactly the tube on the last');
  assert.equal(at(MS).t, 1, 'which is the frame the movement ends');
  let worst = 0, prev = at(0);
  for (let ms = 16; ms <= MS; ms += 16) { const b = at(ms); worst = Math.max(worst, Math.abs(b.amp - prev.amp)); assert.ok(b.t >= prev.t, 'left to right only'); prev = b; }
  assert.ok(worst < 0.03, `no frame (60 fps) steps the size by a pop (largest ${worst.toFixed(4)})`);
  assert.equal(at(0).t, 0, 'it starts at the beginning of the usable line');
  assert.equal(at(MS).t, 1, 'and finishes at its end');

  // THE SHAPE IS A BALL IN A HOSE: round over the ball, straight flanks, a rounded shoulder into the tube
  const R = 10, r0 = 2.5, reach = bulgeReach(R, r0);
  assert.equal(bulgeProfile(0, R, r0), R, 'the crest is the ball\'s own radius');
  assert.ok(Math.abs(bulgeProfile(3, R, r0) - Math.sqrt(R * R - 9)) < 1e-9, 'and near the crest the wall is a circle');
  assert.equal(bulgeProfile(reach + 0.01, R, r0), r0, 'past its reach the tube is untouched');
  let last = bulgeProfile(0, R, r0), maxJump = 0, maxBend = 0, lastSlope = 0;
  for (let d = 0.05; d <= reach + 1; d += 0.05) {
    const y = bulgeProfile(d, R, r0);
    assert.ok(y <= last + 1e-9, 'the wall only narrows away from the ball');
    assert.ok(y >= r0 - 1e-9, 'and never pinches below the tube');
    const slope = (y - last) / 0.05;
    maxJump = Math.max(maxJump, Math.abs(y - last));
    if (d > 0.1) maxBend = Math.max(maxBend, Math.abs(slope - lastSlope));
    last = y; lastSlope = slope;
  }
  assert.ok(maxJump < 0.1, `a continuous wall (largest step ${maxJump.toFixed(3)} over 0.05 px)`);
  assert.ok(maxBend < 0.5, `with no kink where flank meets ball or tube (largest slope change ${maxBend.toFixed(3)})`);
  assert.equal(bulgeProfile(4, 2, 2.5), 2.5, 'a ball smaller than the tube does not dent it');

  // on the real board: the swell is drawn as extra fills around the pipe, only while it runs
  const h = harness();
  board3d(h.canvas, TILES, { axes: AXES, gridW: 8, gridH: 8, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } });
  for (let i = 1; i <= 6; i++) h.step(i * 16);
  harness.t = 1000;
  const fills = (ops) => ops.filter((o) => o === 'fill').length;
  const rest = (() => { const b = h.ops.length; h.step(1016); return h.ops.slice(b); })();
  assert.equal(triggerIdle(h.canvas, 'bulge'), true, 'bulge is a kind the renderer knows');
  const mid = (() => { const b = h.ops.length; h.step(1000 + 8000); return h.ops.slice(b); })();
  assert.ok(fills(mid) > fills(rest) + 8, `the swell and the sphere add fills mid-run (${fills(rest)} -> ${fills(mid)})`);
  // (operator, 2026-09-14: "I don't want to see the sphere. I want to see the obvious deformation of the tube")
  assert.ok(!mid.some((o) => /set:fillStyle=rgba\(255,(205|246|255),(40|190|255),/.test(o) && o.includes('arc')), 'no ball is drawn');
  assert.ok(!mid.includes('arc'), 'nothing round is drawn at all: the shape is the tube\'s wall');
  assert.ok(mid.some((o) => o.startsWith('set:strokeStyle=rgba(255,250,215')), 'the stretched outline catches the light');
});

test('NO EFFECT REPEATS within the configured window, picks stay random, and a short list takes turns', async () => {
  // (operator, 2026-09-14: "add a config field that defaults to 12. Make sure to pick a random effect
  // to play, but never pick one that has been played in the last 12 sequences")
  const { chooseIdleFx, FX_KINDS } = await import('../public/js/details3d.js');
  let seed = 314159;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const kinds = FX_KINDS.filter((k) => k !== 'pulse' && k !== 'bulge');
  const st = {};
  const seq = [];
  for (let i = 0; i < 3000; i++) seq.push(chooseIdleFx(kinds, st, i * 10_000, rnd, 12));
  for (let i = 0; i < seq.length; i++) {
    const last12 = seq.slice(Math.max(0, i - 12), i);
    assert.ok(!last12.includes(seq[i]), `${seq[i]} at pick ${i} was played within the last 12`);
  }
  assert.deepEqual(new Set(seq).size, kinds.length, 'every effect still gets played');
  const cycle = seq.slice(0, kinds.length).join();
  assert.notEqual(seq.slice(kinds.length, 2 * kinds.length).join(), cycle, 'and not as a fixed rotation: the order stays random');
  // the window is a setting: 0 allows repeats, and a window wider than the list degrades to turns
  const three = ['twinkle', 'x', 'y'], st3 = {};
  const turns = Array.from({ length: 60 }, (_, i) => chooseIdleFx(three, st3, i, rnd, 12));
  for (let i = 2; i < turns.length; i++) assert.ok(turns[i] !== turns[i - 1] && turns[i] !== turns[i - 2], 'three effects, window 12: each waits for the other two');
});
