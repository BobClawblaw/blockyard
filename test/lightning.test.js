// The Block space board's lightning ball (details3d idle effect 'ball').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ballPath, fxAt } from '../public/js/blockscene3d.js';

test('the lightning ball runs in from off-screen along a grid line, through the grid, and out the far side', () => {
  const W = 44, H = 44;
  const off = (q) => q.x < 0 || q.x > W || q.y < 0 || q.y > H;
  for (const side of ['left', 'right', 'bottom', 'top']) {
    const p = ballPath(42, W, H, side, 20);
    assert.ok(off(p[0]) && off(p.at(-1)), `${side}: starts and ends off the board`);
    for (let i = 1; i < p.length; i++) assert.equal(Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y), 1, 'unit steps along grid lines');
    if (side === 'left') assert.ok(p[0].x < 0 && p.at(-1).x > W);
    if (side === 'right') assert.ok(p[0].x > W && p.at(-1).x < 0);
    if (side === 'bottom') assert.ok(p[0].y < 0 && p.at(-1).y > H);
    if (side === 'top') assert.ok(p[0].y > H && p.at(-1).y < 0);
    assert.ok(p.some((q) => !off(q)), 'and it crosses the board');
  }
});

test('everything the ball comes near lights up; far cubes stay dark', () => {
  const fx = { kind: 'ball', ball: { x: 10, y: 10, z: 1 }, amp: 1 };
  const near = fxAt({ x: 9, y: 9, s: 2, txid: 'a' }, fx);
  const mid = fxAt({ x: 13, y: 10, s: 2, txid: 'b' }, fx);
  const far = fxAt({ x: 30, y: 30, s: 2, txid: 'c' }, fx);
  assert.ok(near.glow > 0.9 && near.outline > 0.8);
  assert.ok(mid.glow > 0.05 && mid.glow < near.glow);
  assert.equal(far.glow, 0);
});

test('the ball replaced the data packets among the idle effects', () => {
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  // the ball stays; `pulse` joined the list after it (2026-09-12, the price-line pulse on the
  // markets board), so the literal's tail moved -- this pins that the ball is still in the set,
  // not that it is last. Later the same day FX_MS became a 26-entry table, one effect a line
  // (the arcade), so the closing brace no longer follows the ball on its line either.
  assert.match(src, /lightcycle: 6500, ball: 5600, pulse: 9000,/);   // pulse 7000 -> 9000 (2026-09-14: slower)
  assert.doesNotMatch(src, /packets: 5200/);
  assert.match(src, /function drawBall\(ctx, view, lw\)/);
});
