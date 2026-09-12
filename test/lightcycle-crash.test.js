// Light cycles crash into each other's walls and de-res (blockscene3d cycleCrashes, details3d drawCycles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleCrashes, cyclePath } from '../public/js/blockscene3d.js';
import { drawCycles } from '../public/js/details3d.js';

const line = (x0, y0, x1, y1) => {
  const pts = [];
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= n; i++) pts.push({ x: x0 + Math.sign(x1 - x0) * i, y: y0 + Math.sign(y1 - y0) * i });
  return pts;
};

test('a cycle that rides into the other\'s wall dies there; the other rides on', () => {
  const across = { pts: line(0, 5, 20, 5), lag: 0 };     // reaches x=10 at d=10
  const up = { pts: line(10, 0, 10, 20), lag: 0 };       // passes (10,5) at d=5, long before
  const [a, b] = cycleCrashes([across, up]);
  assert.ok(a, 'the one arriving second hits the wall');
  assert.deepEqual(a.at, { x: 10, y: 5 });
  assert.equal(a.d, 10);
  assert.equal(b, null, 'the winner keeps going');
});

test('head to head, both de-res; parallel routes never crash', () => {
  const [a, b] = cycleCrashes([{ pts: line(0, 5, 20, 5), lag: 0 }, { pts: line(20, 5, 0, 5), lag: 0 }]);
  assert.ok(a && b, 'both heads on one node at once');
  assert.deepEqual([cycleCrashes([{ pts: line(0, 2, 20, 2), lag: 0 }, { pts: line(20, 8, 0, 8), lag: 0 }])].flat(), [null, null]);
});

test('the whole wall is solid: a rider dies on a route laid long before it got there', () => {
  // operator, 2026-09-12: the tails last the entire board, so there is no stale part of a wall to
  // ride through. The early cycle laid (10,5) well before the late one crosses it.
  const early = { pts: line(10, 0, 10, 40), lag: 0 };
  const late = { pts: line(0, 5, 20, 5), lag: 0.55 };
  const [lateOut, earlyOut] = cycleCrashes([late, early]);
  assert.ok(lateOut, 'the crosser dies on the older wall');
  assert.deepEqual(lateOut.at, { x: 10, y: 5 }, 'exactly where the two routes meet');
  assert.equal(earlyOut, null, 'the one that laid the wall rides on');
});

test('a de-resed wall stops being solid: the survivor rides through what is left of it', () => {
  // the other half of the same rule, and the reason a crash does not simply kill everyone: once a
  // cycle de-reses, its wall is no longer in play.
  const a = { pts: line(0, 5, 30, 5), lag: 0 };
  const b = { pts: line(5, 0, 5, 30), lag: 0 };
  const c = { pts: line(20, 0, 20, 30), lag: 0.9 };      // crosses a's route much later
  const out = cycleCrashes([a, b, c]);
  assert.ok(out[0] || out[1], 'the early pair meet and at least one de-reses');
  assert.ok(out.filter(Boolean).length < 3, 'not everyone dies: a de-resed wall is not a weapon');
});

test('real routes: a crash, when there is one, is on both routes', () => {
  for (let seed = 1; seed < 60; seed++) {
    const a = { pts: cyclePath(seed, 44, 44, 'left'), lag: 0 };
    const b = { pts: cyclePath(seed + 7919, 44, 44, 'right'), lag: 0.06 };
    cycleCrashes([a, b]).forEach((c, i) => {
      if (!c) return;
      const other = i ? a : b;
      assert.ok(other.pts.some((p) => p.x === c.at.x && p.y === c.at.y), 'it hit a node of the other route');
    });
  }
});

test('a de-resing cycle draws its flash, ring and shards without error', () => {
  const ops = [];
  const ctx = new Proxy({}, { get: (_, k) => (k in ctx ? undefined : (...a) => ops.push(String(k))), set: (t, k, v) => { ops.push(`set:${String(k)}`); return true; } });
  const pts = line(0, 5, 20, 5);
  const view = { unit: 6, fx: { cycles: [{ pts, hs: pts.map(() => 0), color: [80, 220, 255], d: 10, from: 0, alpha: 0, trail: 12, derez: 0.3, crash: { u: 0.4, d: 10, at: { x: 10, y: 5 } } }] } };
  drawCycles(ctx, view, 1);
  assert.ok(ops.filter((o) => o === 'fill').length > 20, 'shards and the flash are filled');
  assert.ok(ops.filter((o) => o === 'stroke').length >= 2, 'the ring is stroked');
});
