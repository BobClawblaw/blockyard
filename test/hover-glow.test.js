// Block space hover glow and click-through (details3d setHover/glowLevel, blockscene3d buildScene).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { glowLevel } from '../public/js/details3d.js';
import { buildScene } from '../public/js/blockscene3d.js';

test('a hovered tile lights up quickly and fades out slowly when released', () => {
  const g = { on: 1000, off: null, from: 0 };
  assert.equal(glowLevel(g, 1000), 0);
  assert.ok(glowLevel(g, 1060) > 0.4 && glowLevel(g, 1060) < 0.6, 'rising');
  assert.equal(glowLevel(g, 1200), 1, 'fully lit within ~0.12 s');
  g.off = 2000;
  assert.equal(glowLevel(g, 2000), 1);
  assert.ok(Math.abs(glowLevel(g, 2300) - 0.5) < 1e-9, 'half gone after 0.3 s');
  assert.equal(glowLevel(g, 2600), 0, 'gone after 0.6 s');
  // re-hovered mid-fade: it resumes from where it was, not from dark
  const back = { on: 2300, off: null, from: glowLevel(g, 2300) };
  assert.ok(glowLevel(back, 2300) >= 0.5);
  assert.equal(glowLevel(null, 5), 0);
});

test('a glowing tile is brighter, outlined and washed with light; the others are untouched', () => {
  const tile = { txid: 'a'.repeat(64), x: 2, y: 2, s: 3, color: '#2e9e3a' };
  const other = { txid: 'b'.repeat(64), x: 8, y: 8, s: 3, color: '#2e9e3a' };
  const o = { unit: 10, oblique: { ox: 0.13, oy: 0.32 }, gridW: 14, gridH: 14 };
  const plain = buildScene([tile, other], o).ops;
  const lit = buildScene([tile, other], { ...o, hoverGlow: new Map([[tile.txid, 1]]) }).ops;
  const mine = (ops, id) => ops.filter((x) => x.txid === id);
  assert.ok(mine(lit, tile.txid).some((x) => x.face === 'outline' && /rgba\(175,255,225/.test(x.stroke)));
  assert.ok(mine(lit, tile.txid).some((x) => x.face === 'glow'));
  const top = (ops) => ops.find((x) => x.txid === tile.txid && x.face === 'top').fill.match(/\d+/g).slice(0, 3).map(Number).reduce((p, q) => p + q, 0);
  assert.ok(top(lit) > top(plain), 'brighter');
  assert.deepEqual(mine(lit, other.txid), mine(plain, other.txid), 'the neighbours do not change');
});

test('a click on a transaction opens it in the explorer; the loop wakes only while a glow changes', () => {
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /canvas\.addEventListener\('click'/);
  assert.match(src, /location\.hash = `#explorer\/tx\/\$\{String\(hit\.txid\)\.toLowerCase\(\)\}`/);
  assert.match(src, /!glowAnimating\(st, t\)/);
});
