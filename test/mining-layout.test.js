// The Mining page packs its cards instead of padding them (operator, 2026-09-11: "too much wasted
// space in this display"), fits one screen (2026-09-15: "Move Block flow up as the first thing along
// the top"), and since later that day follows mempool.space's mining dashboard ("try to implement
// this default layout at the very least. Notice the 'View more >>' that open up a panel to see a
// full screen view of just that panel"): two columns in its order, View more on four cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
// the section, not the nav button that carries the same data-page
const at = html.indexOf('<section class="page" data-page="mining">');
const mining = html.slice(at, html.indexOf('</section>', at));

test('the block flow first, then mempool.space\'s six cards in two columns, then our own', () => {
  const flowAt = mining.indexOf('id="mnFlow"'), twoAt = mining.indexOf('<div class="mn2">'), extraAt = mining.indexOf('<div class="mnextra">');
  assert.ok(flowAt > 0 && twoAt > flowAt && extraAt > twoAt, 'flow, then the two columns, then the extras');
  assert.match(mining.slice(0, twoAt), /class="card mnflow[^"]*"/, 'the flow spans the width');
  const two = mining.slice(twoAt, extraAt);
  const order = ['mnRewards', 'mnAdjust', 'mnPoolDonut', 'mnHashChart', 'mnRecent', 'mnAdjustments'].map((id) => two.indexOf(`id="${id}"`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `reward stats, difficulty, pools, hashrate, recent blocks, adjustments -- in that order: ${order}`);
  for (const kind of ['pools', 'hashrate', 'blocks', 'adjustments']) assert.ok(two.includes(`data-expand="${kind}"`), `View more on ${kind}`);
  assert.equal((two.match(/View more »/g) ?? []).length, 4, 'four View more links, as the reference');
  const extra = mining.slice(extraAt);
  for (const id of ['mnPackages', 'mnFeeLandscape', 'mnPools', 'mnCoverage']) assert.ok(extra.includes(`id="${id}"`), `${id} among our own panels`);
  assert.ok(!mining.includes('gnMempoolTreemap'), 'the Mempool space viewer is not on this page');
  assert.match(css, /\.mn2, \.mnextra \{[^}]*grid-template-columns: repeat\(2/, 'two columns');
  assert.match(css, /\.card\.mnflow \{[^}]*grid-column: 1 \/ -1/, 'the flow card spans the grid');
});

test('the full-screen panel exists once, outside the page, and closes three ways', () => {
  assert.equal((html.match(/id="expandWrap"/g) ?? []).length, 1);
  assert.ok(html.includes('id="expandScrim"') && html.includes('id="expandClose"') && html.includes('id="expandBody"'));
  const mining = readFileSync(new URL('../public/js/mining.js', import.meta.url), 'utf8');
  assert.match(mining, /e\.key === 'Escape' && EXPAND\.kind\) closeExpand\(\)/, 'Esc closes it');
  assert.match(mining, /getElementById\('expandScrim'\)\?\.addEventListener\('click', closeExpand\)/, 'so does the scrim');
  assert.match(mining, /renderExpand\(s, h\);/, 'and it is redrawn from every frame while open');
});

test('the Goggles reference text folds away until asked for', () => {
  assert.match(mining, /<details class="card mndetailed">\s*<summary><h3>Detailed/);
});
