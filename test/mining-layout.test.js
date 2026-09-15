// The Mining page packs its cards instead of padding them (operator, 2026-09-11:
// "too much wasted space in this display. Crunch down the panel sizes to fit more info"), and
// since 2026-09-15 fits one screen: the block flow across the top, then three stacks, with the
// Mempool space viewer gone from this page ("remove the mempool space viewer from the mining
// tab. Move Block flow up as the first thing along the top").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
// the section, not the nav button that carries the same data-page
const at = html.indexOf('<section class="page" data-page="mining">');
const mining = html.slice(at, html.indexOf('</section>', at));

test('the block flow first, then three independent stacks, and no pool viewer', () => {
  const flowAt = mining.indexOf('id="mnFlow"'), threeAt = mining.indexOf('<div class="mn3">');
  assert.ok(flowAt > 0 && threeAt > flowAt, 'Block flow comes before the three stacks');
  assert.match(mining.slice(0, threeAt), /class="card mnflow[^"]*"/, 'and spans the width');
  const cols = mining.split('<div class="ovcol">').slice(1);
  assert.equal(cols.length, 3, 'three stacks');
  for (const id of ['mnRewards', 'mnAdjust', 'mnPackages']) assert.ok(cols[0].includes(`id="${id}"`), `${id} in the first stack`);
  for (const id of ['mnPoolDonut', 'mnFeeLandscape']) assert.ok(cols[1].includes(`id="${id}"`), `${id} in the second stack`);
  for (const id of ['mnHashChart', 'mnAdjustments', 'mnPools', 'mnCoverage']) assert.ok(cols[2].includes(`id="${id}"`), `${id} in the third stack`);
  assert.ok(!mining.includes('gnMempoolTreemap'), 'the Mempool space viewer is not on this page');
  assert.ok(!/class="card w\d+"/.test(mining), 'no card spans grid columns by the old w-classes');
  assert.match(css, /\.mn3 \{[^}]*align-items: start/, 'stacks align to the top rather than stretching');
  assert.match(css, /\.mnflow \{[^}]*grid-column: 1 \/ -1/, 'the flow card spans the grid');
});

test('the Goggles reference text folds away until asked for', () => {
  assert.match(mining, /<details class="card mndetailed">\s*<summary><h3>Detailed/);
});
