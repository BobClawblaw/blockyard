// The Mining page packs its cards instead of padding them (operator, 2026-09-11:
// "too much wasted space in this display. Crunch down the panel sizes to fit more info").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
// the section, not the nav button that carries the same data-page
const at = html.indexOf('<section class="page" data-page="mining">');
const mining = html.slice(at, html.indexOf('</section>', at));

test('two independent stacks, so no card is stretched to its neighbour', () => {
  assert.ok(mining.includes('<div class="mncols">'), 'the page is two columns of stacks');
  const right = mining.slice(mining.lastIndexOf('<div class="ovcol">'));
  const left = mining.slice(mining.indexOf('<div class="ovcol">'), mining.lastIndexOf('<div class="ovcol">'));
  for (const id of ['mnFlow', 'mnPackages', 'mnFeeLandscape', 'mnPools']) assert.ok(left.includes(`id="${id}"`), `${id} in the wide stack`);
  for (const id of ['gnMempoolTreemap', 'mnCoverage']) assert.ok(right.includes(`id="${id}"`), `${id} in the narrow stack`);
  assert.ok(!/class="card w\d+"/.test(mining), 'no card spans grid columns (the old coupled rows)');
  assert.match(css, /\.mncols \{[^}]*align-items: start/, 'stacks align to the top rather than stretching');
  assert.match(css, /\.mnpair \{[^}]*align-items: start/, 'and so does the packages | landscape pair');
});

test('the Goggles reference text folds away until asked for', () => {
  assert.match(mining, /<details class="card mndetailed">\s*<summary><h3>Detailed/);
});
