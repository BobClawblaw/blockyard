// The pool viewer's countdown to its next refresh (operator, 2026-09-11: "we
// need to add a countdown to refresh somewhere in that panel").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refreshLabel } from '../public/js/mining.js';

test('the countdown reads minutes and seconds to the next refresh', () => {
  assert.deepEqual(refreshLabel(NaN, 0), { text: '', frac: 0 }, 'nothing scheduled yet: nothing shown');
  assert.equal(refreshLabel(61_000, 19_000).text, 'next refresh 0:42');
  assert.equal(refreshLabel(61_000, 60_500).text, 'next refresh 0:01', 'rounds UP: never says 0:00 while waiting');
  assert.equal(refreshLabel(121_000, 0).text, 'next refresh 2:01');
  assert.equal(refreshLabel(61_000, 61_000).text, 'refreshing…', 'due: says so rather than going negative');
  assert.equal(refreshLabel(61_000, 30_000, { paused: true }).text, 'refresh paused', 'frozen updates are named, not counted down');
  assert.ok(Math.abs(refreshLabel(61_000, 31_000).frac - 0.5) < 1e-9, 'the fill is the share of the minute gone');
  assert.equal(refreshLabel(61_000, 99_000).frac, 1);
});

test('every pool viewer panel carries the countdown, and the page drives it once a second', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['ovGnTreemap', 'spTreemap', 'mpTreemap', 'gnMempoolTreemap']) {
    assert.ok(html.includes(`id="${id}"></canvas><div class="viewer-ctl"><div class="refresh-in" data-refresh></div><button type="button" class="refresh-now" data-refresh-now disabled>`), `${id} has its countdown and its refresh-now button, disabled until the board is at rest`);
  }
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.ok(/querySelectorAll\('\[data-refresh\]'\)/.test(app), 'the ticker updates every countdown');
  assert.ok(/state\.poolFetchedAt = mempoolFetchedAt/.test(app), 'counting from the fetch that fed the viewer');
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.ok(/\.refresh-in:empty \{ display: none \}/.test(css), 'and an empty countdown takes no space');
});

test('"refresh now" fetches at once, and only while the board is at rest', () => {
  // (operator, 2026-09-11: "We should add a button for 'Trigger Refresh Now'
  // that is only enabled when the animation is idle")
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.ok(/import \{ viewerIdle \} from '\.\/details3d\.js';/.test(app), 'the page asks the renderer whether the board is at rest');
  assert.ok(/querySelectorAll\('\[data-refresh-now\]'\)/.test(app), 'every button is kept in step once a second');
  assert.ok(/const ok = !state\.paused && !poolRefreshing && viewerIdle\(/.test(app), 'enabled only when idle, unpaused and not already refreshing');
  assert.ok(/closest\?\.\('\[data-refresh-now\]'\)[\s\S]{0,300}viewerIdle\([\s\S]{0,200}mempoolFetchedAt = 0/.test(app), 'and a click re-checks, then makes the viewer due at once');
});
