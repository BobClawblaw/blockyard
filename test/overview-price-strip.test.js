// THE PRICE STRIP ON OVERVIEW, and the network promise it must not break.
//
// (operator, 2026-09-13: "We really need to squeeze this line into the top of the Overview,
// between Sync status and Block Flow" -- then, asked how to resolve the outbound cost:
// "Make it a setting, default off".)
//
// The four figures come from the full exchange feed, which the server parks unless someone is on
// Markets or Kiosk. Overview is the page the app OPENS on, so a strip that fetched unconditionally
// would mean every deployment contacts five exchanges the moment anyone looks at it -- which is
// what docs/SECURITY.md promises it does not do. Hence: off by default, and the fetch gated.
//
// These tests pin the promise, not the pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, PANEL, loadSettings, normalise } from '../public/js/settings.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const store = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};

test('the strip is ON by default, and the outbound promise says so', () => {
  // It shipped OFF, and the reason was good: Overview is the landing page, so defaulting this true
  // means every deployment contacts five exchanges the moment anyone looks at it. The operator
  // turned it on anyway (2026-09-13: "enable 'Price Line on Overview' checked as default"), which
  // is their call -- but the code must not then disagree with the documented promise. So this test
  // pins BOTH halves together: the default, and the security note that admits what it costs.
  assert.equal(DEFAULTS.markets.overviewSummary, true);
  assert.equal(loadSettings(store()).markets.overviewSummary, true, 'and a fresh browser agrees');

  // ...and since 2026-09-15 market polling itself ships OFF ("true zero telemetry out of the
  // box": the Enable market polling checkbox), so the promise is now two-part: polling is off by
  // default, and with it on, the landing page reaches out too. The table row must say both.
  const sec = fs.readFileSync(path.join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
  const row = sec.split('\n').find((l) => /^\| .*\*\*Markets\*\*/.test(l));
  assert.ok(row, 'the outbound-connections table should still carry that row');
  assert.match(row, /off by default/, 'SECURITY.md must say polling ships off');
  assert.match(row, /Enable market polling/, 'and where the switch is');
});

test('it has a control, so it is not a hidden preference', () => {
  const rows = PANEL.find((g) => g.group === 'markets')?.rows ?? [];
  const row = rows.find((r) => r.key === 'overviewSummary');
  assert.ok(row, 'markets panel should offer the toggle');
  assert.equal(row.kind, 'toggle');
  assert.match(row.hint, /exchange|Overview/i, 'and the hint should say what turning it on costs');
});

test('turning it on is remembered', () => {
  assert.equal(normalise({ markets: { overviewSummary: true } }).markets.overviewSummary, true);
});

test('THE PROMISE: the markets fetch is gated on the setting, not on the page rendering', () => {
  // The regression this file exists for. render() runs on every SSE frame (~1 Hz); a fetch on that
  // path would poll the exchanges once a second. The fetch must live on its own timer AND check
  // the setting, or switching the strip off would leave the server's feed awake indefinitely.
  const gate = appSrc.match(/const pullMarketsStrip = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(gate, 'expected a dedicated pullMarketsStrip() rather than a fetch inside render()');
  const body = gate[0];
  assert.match(body, /loadSettings\(\)\.markets\?\.overviewSummary/,
    'the fetch must consult the setting every time, so turning it off stops the traffic');
  assert.match(body, /document\.hidden/, 'and must not poll a backgrounded tab');
  assert.match(body, /api\('\/api\/markets'\)/, 'it is /api/markets that carries the summary');

  // renderOverview must NOT fetch.
  const ov = appSrc.match(/function renderOverview\(s\) \{[\s\S]*?\n\}/);
  assert.ok(ov, 'renderOverview should be findable');
  assert.equal(/api\('\/api\/markets'\)/.test(ov[0]), false,
    'renderOverview runs every SSE frame; a fetch there would poll five exchanges at 1 Hz');
});

test('the strip sits between the sync hero and Block flow, and starts hidden', () => {
  const hero = html.indexOf('data-sync-hero="overview"');
  const strip = html.indexOf('id="ovMkSummary"');
  const flow = html.indexOf('id="ovTrain"');
  assert.ok(hero > 0 && strip > 0 && flow > 0, 'all three landmarks should exist');
  assert.ok(hero < strip, 'the strip goes after the sync hero');
  assert.ok(strip < flow, 'and before Block flow');
  assert.match(html.slice(strip - 120, strip + 80), /hidden/,
    'it must ship hidden, since the setting is off by default');
});

test('it spans the grid, because a twelfth of it is a column not a strip', () => {
  // THE FAILURE THIS CATCHES. The first cut had no grid-column, so it took one of .grid's twelve
  // 1fr tracks (~120px) and .mksum's flex-wrap stacked the four figures vertically -- a tall narrow
  // box, not a line. The check that passed at the time asserted only the vertical ORDER of the
  // hero, the strip and Block flow, which is true of a 120px column just as much as a full-width
  // strip. Width was the dimension that was wrong, so width is what gets pinned.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
  const rule = css.match(/\.ovmksum \{[^}]*\}/);
  assert.ok(rule, '.ovmksum should have a rule of its own');
  assert.match(rule[0], /grid-column:\s*1\s*\/\s*-1/,
    'the strip must span every column, or it wraps into a narrow stack');
  assert.match(css, /\.ovmksum > span \{[^}]*white-space:\s*nowrap/,
    'and each figure stays on one line, so "MEDIAN (USD)" cannot break in half');
});

test('the documented outbound promise mentions Overview', () => {
  // If the code can contact exchanges from Overview, the security document may not say otherwise.
  const sec = fs.readFileSync(path.join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
  const row = sec.split('\n').find((l) => /^\| .*\*\*Markets\*\*/.test(l));
  assert.ok(row, 'the outbound-connections table should still carry that row');
  assert.match(row, /Overview/,
    'the table must name Overview now that its price line can wake the exchange feed');
});
