// THE SPHERE REACHES EVERY EDGE (operator, 2026-09-11: "The surface of the sphere is not being
// drawn high enough. You can see black when there should be at least another grid row").
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, obliqueFit, groundExtent } from '../public/js/goggles3d.js';
import { project } from '../public/js/blockscene3d.js';

const PANELS = [[1450, 780, 40, 32], [2900, 1100, 96, 96], [1200, 1200, 48, 40], [3000, 900, 64, 60], [900, 1400, 30, 30]];

function uncovered(view, vr, { X0, X1, Y0, Y1 }) {
  const u = view.unit, dS = view.oblique.dy ?? 1;
  const L = vr.x0 * u, R = vr.x1 * u, T = -vr.y1 * u * dS, B = -vr.y0 * u * dS;
  const P = (x, y) => project(x, y, 0, view);
  const bad = [];
  for (let x = X0; x <= X1; x += 0.25) {
    if (P(x, Y1).y > T) bad.push(`far edge at x ${x}`);
    if (P(x, Y0).y < B) bad.push(`near edge at x ${x}`);
  }
  for (let y = Y0; y <= Y1; y += 0.25) {
    if (P(X1, y).x < R) bad.push(`right edge at y ${y}`);
    if (P(X0, y).x > L) bad.push(`left edge at y ${y}`);
  }
  return bad;
}

test('the textured sphere covers the whole panel, the far edge included', () => {
  let oldFailed = 0;
  for (const [pw, ph, W, H] of PANELS) {
    const vr = obliqueFit(pw, ph, W, H, DEFAULTS).rect;
    const view = { unit: DEFAULTS.unit ?? 12, oblique: DEFAULTS.oblique, dome: DEFAULTS.dome, gridW: W, gridH: H };
    const ext = groundExtent(view, vr);
    assert.deepEqual(uncovered(view, vr, ext), [], `${pw}x${ph} on a ${W}x${H} grid`);
    assert.equal(groundExtent(view, vr), ext, 'cached per view');
    const old = { X0: Math.floor(vr.x0) - 3, X1: Math.ceil(vr.x1) + 3, Y0: Math.floor(vr.y0) - 3, Y1: Math.ceil(vr.y1) + 3 };
    if (uncovered(view, vr, old).length) oldFailed++;
  }
  assert.ok(oldFailed > 0, 'the fixed three-unit margin left part of the panel bare (the reported black strip)');
});

test('drawGrid lays the ground over the extent, not a fixed margin', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/goggles3d.js', import.meta.url), 'utf8');
  assert.match(src, /const \{ X0, X1, Y0, Y1 \} = vr \? groundExtent\(view, vr\)/);
  assert.doesNotMatch(src, /Math\.ceil\(vr\.y1\) \+ 3/);
});
