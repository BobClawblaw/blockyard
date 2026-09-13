// HOW A CUBE LEAVES AND ARRIVES: three paths, and the measurement that chose them.
//
// (operator, 2026-09-13: "Notice how it looks like all the left and right side blocks are arcing
// towards/away from the sides instead of just traveling straight up? Can we fix this make it a
// toggle", then "Give me 3 choices to see and toggle between in the settings".)
//
// WHY THIS FILE MEASURES RATHER THAN DESCRIBES. The first diagnosis was wrong, and only a probe
// caught it: the complaint was that the path CURVES, and there is real curvature in the shipped
// look -- the lean is re-settled as a cube climbs -- but sampling the drawn path showed the bend is
// about 2% (dx/dy runs 0.7335 -> 0.7481 over a whole climb at the left edge). The path was already
// nearly straight. What reads as "arcing towards the sides" is that the straight line is STEEP:
// three pixels sideways for every four up at the rim, against -0.017 over the middle column.
//
// Had that not been measured, "make it linear" would have shipped as a change that removed the 2%
// and looked identical -- a fix that is really a no-op. So every claim below is a number taken from
// the real projector, and the modes are pinned by what they DO, not by what they are called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liftProjector, buildScene, obliqueLean, departMode } from '../public/js/blockscene3d.js';
import { DEFAULTS, PANEL, spaceOptions, normalise } from '../public/js/settings.js';

const BASE = {
  unit: 9, zUnit: 10, originX: 0, originY: 0, flipY: true, gridW: 96, gridH: 96, dome: 5,
  oblique: { ox: 0.13, oy: 0.32, headroom: 10, flight: 120 },
  viewRect: { x0: -12, x1: 108, y0: -12, y1: 108 },
};

// where a cube's centre is DRAWN at flight height z, through the real projector
function at(gx, z, mode) {
  const o = mode == null ? BASE : { ...BASE, departures: mode };
  const t = { txid: 't', x: gx, y: 40, s: 2, tall: 2, z, color: '#33cc99' };
  return liftProjector(t, o)(t.x + t.s / 2, t.y + t.s / 2, z);
}
// screen dx per unit of dy: the slope of the drawn path. 0 is straight up the screen.
function slope(gx, z, mode) {
  const b = at(gx, 0, mode), p = at(gx, z, mode);
  return p.y - b.y ? (p.x - b.x) / (p.y - b.y) : 0;
}

test('STRAIGHT UP really is straight up: no sideways travel at either edge', () => {
  // The complaint itself, as a number. At the rim the shipped path moves ~90px sideways over a
  // flight; this must move none, or the setting does not do what its label says.
  for (const gx of [2, 48, 93]) {
    for (const z of [5, 20, 80]) {
      const b = at(gx, 0, 'vertical'), p = at(gx, z, 'vertical');
      assert.ok(Math.abs(p.x - b.x) < 1e-6, `gx=${gx} z=${z}: drifts ${(p.x - b.x).toFixed(3)}px sideways`);
    }
    // and it still RISES -- a mode that pinned the cube in place would also pass the check above
    assert.ok(at(gx, 80, 'vertical').y < at(gx, 0, 'vertical').y - 50, `gx=${gx} still climbs`);
  }
});

test('ALONG THE CURVE is a straight line, and ARCING is not', () => {
  // The distinction the operator asked to see. `normal` holds its lean at the resting value, so the
  // slope is identical at every height; `arcing` re-settles it as the cube climbs, so it drifts.
  for (const gx of [2, 93]) {
    const n5 = slope(gx, 5, 'normal'), n80 = slope(gx, 80, 'normal');
    assert.ok(Math.abs(n5 - n80) < 1e-6, `normal is straight at gx=${gx} (${n5.toFixed(4)} vs ${n80.toFixed(4)})`);
    // both still fan: that is what makes them different from vertical, and it is the thing the
    // screenshot was objecting to
    assert.ok(Math.abs(n80) > 0.5, `normal still fans at gx=${gx} (${n80.toFixed(4)})`);
  }
  // WHERE THE BEND ACTUALLY IS. The first draft asserted arcing bends at the rim and failed there
  // (gx=93 bends by 6.5e-4). Measured across the board the bend is strongly position-dependent --
  // gx=2: 8.8e-3, gx=20: 7.6e-2, gx=76: 8.2e-2, gx=93: 6.5e-4 -- because obliqueLean CLAMPS at the
  // edges, so once a cube's lean has saturated it stops changing as it climbs and the path
  // straightens out. The curve lives in the middle third of the board, not at the sides. Asserted
  // where the signal is, rather than loosening the threshold until the edges scraped through: a
  // bound below the float noise would have pinned nothing at all.
  for (const gx of [20, 76]) {
    const a5 = slope(gx, 5, 'arcing'), a80 = slope(gx, 80, 'arcing');
    assert.ok(Math.abs(a5 - a80) > 1e-2, `arcing bends at gx=${gx} (${a5.toFixed(4)} vs ${a80.toFixed(4)})`);
    const n5 = slope(gx, 5, 'normal'), n80 = slope(gx, 80, 'normal');
    assert.ok(Math.abs(n5 - n80) < 1e-6, `and normal does not, at the same place (${n5.toFixed(4)} vs ${n80.toFixed(4)})`);
  }
  // over the middle column every mode goes essentially straight up -- which is why the complaint
  // was only ever about the left and right sides
  assert.ok(Math.abs(slope(48, 80, 'arcing')) < 0.05, 'the middle column barely leans, even arcing');
});

test('NOTHING SNAPS AT TOUCHDOWN, in any mode', () => {
  // The trap in this change. The lean is not only the sideways push, it is also what makes a cube's
  // side faces lean -- so `vertical` cannot simply zero it, or an airborne cube would be drawn
  // unleaned and then JUMP to its resting shape as it landed. It subtracts the flight altitude's
  // share instead, which goes to zero as the cube lands. Checked as a limit, at the rim where the
  // lean is strongest.
  for (const mode of ['arcing', 'normal', 'vertical']) {
    const xs = [2, 1, 0.5, 0.2, 0.05, 0.01, 0].map((z) => at(2, z, mode).x);
    for (let i = 1; i < xs.length; i++) {
      const step = Math.abs(xs[i] - xs[i - 1]);
      assert.ok(step < 2.2, `${mode}: a ${step.toFixed(2)}px step approaching the ground`);
    }
    // and the last approach is smooth: the final hundredth of a unit must not move it visibly
    assert.ok(Math.abs(xs[xs.length - 1] - xs[xs.length - 2]) < 0.05, `${mode}: continuous at touchdown`);
  }
  // vertical is the strong case: its drawn x is the resting x throughout the whole flight
  const rest = at(2, 0, 'vertical').x;
  for (const z of [0.01, 1, 20, 80]) assert.ok(Math.abs(at(2, z, 'vertical').x - rest) < 1e-6, `vertical holds its column at z=${z}`);
});

test('the paint order is measured at the same point as the geometry, in every mode', () => {
  // obliqueOrder used to re-derive the lean with six lines copied out of liftProjector, and the
  // comment there warned they must agree. With a mode to honour, a copy is a latent flicker: the
  // cube would be DRAWN by one rule and SORTED by another. Both now call flightGeom. This pins the
  // shipped order against the signature measured before the change, so `arcing` is provably
  // untouched, and checks the other two produce a complete, stable order rather than throwing.
  const O = {
    unit: 6, zUnit: 6, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5,
    gridW: 44, gridH: 44, edges: true, shadows: false, viewRect: { x0: -6, x1: 50, y0: -6, y1: 50 },
  };
  const tiles = [];
  let i = 0;
  for (const x of [2, 10, 21, 32, 41]) for (const y of [2, 12, 22, 32]) {
    tiles.push({ txid: `t${i}`, x, y, s: 2, tall: 1 + (i % 4), z: (i % 3) * 4, color: '#33cc99' });
    i++;
  }
  const orderOf = (mode) => {
    const sc = buildScene(tiles, mode == null ? O : { ...O, departures: mode });
    const seen = [];
    for (const op of sc.ops) if (op.txid && !seen.includes(op.txid)) seen.push(op.txid);
    return seen;
  };
  // captured from the shipped renderer BEFORE this change
  const BASELINE = 't19 t15 t18 t14 t11 t17 t13 t10 t16 t7 t12 t3 t9 t6 t2 t8 t5 t1 t4 t0';
  assert.equal(orderOf('arcing').join(' '), BASELINE, 'the shipped order is unchanged');
  assert.equal(orderOf(null).join(' '), BASELINE, 'and a caller that names no mode still gets it');
  for (const mode of ['normal', 'vertical']) {
    const ord = orderOf(mode);
    assert.equal(ord.length, tiles.length, `${mode}: every cube is painted exactly once`);
    assert.deepEqual(orderOf(mode), ord, `${mode}: the order is stable between builds`);
  }
});

test('THE RESTING BOARD IS UNTOUCHED: this changes flight, never how a cube stands', () => {
  // obliqueLean also leans every RESTING cube's faces outward from the middle (lean-order.test.js,
  // settings.test.js). If a departure mode reached that, every cube on the board would change
  // shape -- which is not what was asked for. A resting cube is projected identically in all three.
  const O = { ...BASE };
  assert.ok(obliqueLean(0, O) < 0 && obliqueLean(95, O) > 0, 'the resting fan is still radial');
  // THIS CAUGHT A REAL DEFECT, and it is worth saying what, because the tolerance is the test. The
  // first cut let the mode take effect at zv = 0, so a RESTING rim cube was drawn at 23.945640
  // under arcing and 23.976709 under the other two -- 0.031px, far above float noise. A departure
  // setting had changed how the standing board is drawn, and it would have snapped the moment a
  // cube landed. flightGeom now only honours the mode once a cube is airborne. Kept at 1e-9 so a
  // reappearance fails rather than hides: the modes must agree EXACTLY at rest.
  for (const gx of [2, 48, 93]) {
    const a = at(gx, 0, 'arcing'), n = at(gx, 0, 'normal'), v = at(gx, 0, 'vertical');
    assert.ok(Math.abs(a.x - n.x) < 1e-9 && Math.abs(a.x - v.x) < 1e-9,
      `gx=${gx}: a resting cube sits in one place (arcing ${a.x.toFixed(6)}, normal ${n.x.toFixed(6)}, vertical ${v.x.toFixed(6)})`);
    assert.ok(Math.abs(a.y - n.y) < 1e-9 && Math.abs(a.y - v.y) < 1e-9);
  }
});

test('the setting exists, ships as Straight up, and reaches the renderer', () => {
  assert.equal(DEFAULTS.space.departures, 'vertical', 'it ships as the mode that was asked for');
  const row = PANEL.find((g) => g.group === 'space')?.rows.find((r) => r.key === 'departures');
  assert.ok(row, 'and it has a control, or it cannot be toggled');
  assert.equal(row.kind, 'choice');
  assert.equal(row.options.length, 3, 'three choices to compare');
  assert.deepEqual(row.options.map(([v]) => v), ['vertical', 'normal', 'arcing']);
  // normalise reads its allowed values from the panel row, so a junk value must fall back rather
  // than reach the geometry and be read as "arcing" by accident
  assert.equal(normalise({ space: { departures: 'sideways' } }).space.departures, 'vertical');
  assert.equal(normalise({ space: { departures: 'arcing' } }).space.departures, 'arcing');
  // and it is actually handed to the board
  assert.equal(spaceOptions(null).departures, 'vertical');
  assert.equal(spaceOptions({ space: { departures: 'arcing' } }).departures, 'arcing');
});

test('an option nobody sets behaves exactly as the board always did', () => {
  // Every caller written before this -- and every test -- must draw what it drew. The default lives
  // in the geometry, not only in settings.js, so a bare projection is unchanged.
  assert.equal(departMode({}), 'arcing');
  assert.equal(departMode({ departures: 'vertical' }), 'vertical');
  for (const gx of [2, 93]) for (const z of [5, 80]) {
    assert.equal(at(gx, z, undefined).x, at(gx, z, 'arcing').x, `gx=${gx} z=${z}: unchanged for callers that say nothing`);
  }
});
