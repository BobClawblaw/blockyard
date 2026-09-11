// An event kind in the feed is one word on one line (operator, 2026-09-11: "field text
// getting cut off and wrapped for event name" -- COLLECTOR_ERROR broke mid-word).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('the kind column never wraps a word, and names the whole kind on hover', () => {
  const rules = [...css.matchAll(/\.feed \.row \.tag \{([^}]*)\}/g)].map((m) => m[1]).join(';');
  assert.match(rules, /white-space:\s*nowrap/, 'one line');
  assert.match(rules, /text-overflow:\s*ellipsis/, 'trimmed, not broken, if ever too long');
  assert.doesNotMatch(rules, /overflow-wrap:\s*anywhere/, 'and never broken mid-word');
  const cols = css.match(/\.feed \.row \{[^}]*grid-template-columns:\s*(\d+)px (\d+)px/);
  assert.ok(cols && Number(cols[2]) >= 118, `the column holds COLLECTOR_ERROR (${cols?.[2]} px)`);
  assert.match(app, /<span class="tag" title="\$\{F\.esc\(r\.tagBase \?\? r\.kind/, 'the full kind is in the title');
});
