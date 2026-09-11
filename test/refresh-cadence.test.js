// How fresh the block-space viewer can be (operator, 2026-09-11: "is 60 seconds the
// most granularity we have? Can't we get block updates more often?" -> "Faster refresh").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRANSITION } from '../public/js/blockscene3d.js';

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the server reads the pool on its own 20 s tier, not the heavy minute', () => {
  const mon = src('server/collect/monitor.js');
  const body = (name) => { const a = mon.indexOf(`async tier_${name}()`); return mon.slice(a, mon.indexOf('\n  async tier_', a + 10)); };
  assert.match(body('pool'), /rpc\.call\('getrawmempool', \[true\]/, 'the pool tier reads the verbose mempool');
  assert.doesNotMatch(body('slow'), /getrawmempool/, 'and the slow tier no longer does');
  assert.match(mon, /this\.runTier\('pool'\)\.finally\(\(\) => this\.scheduleTier\('pool'\)\)/, 'it is started and rescheduled like the others');
  assert.match(mon, /const heavyTiers = \['pool', 'slow', 'rare'\]/, 'and skipped with the heavy tiers when the node is struggling');
  assert.match(src('server/config.js'), /poolMs: 20000/);
});

test('the viewer refreshes every 30 s and its transition lands well inside that', () => {
  assert.match(src('public/js/app.js'), /const MEMPOOL_DETAIL_MS = 30_000;/);
  const total = TRANSITION.rise + TRANSITION.travel + TRANSITION.drop;
  assert.equal(total, 20000, 'a 20 s transition');
  assert.ok(TRANSITION.riseStagger < TRANSITION.rise, 'every block is airborne before any descends');
  assert.ok(!/60 s tier|every 60 s/.test(src('public/js/mining.js') + src('public/js/panels.js')), 'and no page still says 60 s');
});
