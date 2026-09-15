// The Chain & Sync page fits more (operator, 2026-09-11: "surely we can fit more info on here").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
const at = html.indexOf('<section class="page" data-page="chain">');
const sec = html.slice(at, html.indexOf('</section>', at));

test('charts three to a row, short, the flat tip chart last', () => {
  assert.ok(sec.includes('<div class="grid chgrid">'));
  const order = ['chGapChart', 'chSizeChart', 'chFeeChart', 'chTxChart', 'chTxRateChart', 'chTipChart'].map((id) => sec.indexOf(`id="${id}"`));
  assert.ok(order.every((v, k) => v > 0 && (k === 0 || v > order[k - 1])), 'interval, size, fees, txs, tx rate, then tip');
  assert.ok(!sec.includes('chart tall'), 'no tall charts');
  assert.equal((sec.match(/class="card w4"/g) || []).length, 9, 'nine cards three across');
  assert.match(css, /\.chgrid \.card\.w4 \{ grid-column: span 4 !important; \}/, 'held at three across under 1280 px');
  assert.match(css, /\.chgrid canvas\.chart \{ height: 110px; \}/);
});

test('long lists run in two columns', () => {
  assert.ok(sec.includes('<dl class="kv two" id="chState">') && sec.includes('id="chTxStats"') && /class="mksum mt-6 chtx" id="chTxStats"/.test(sec), 'the rate figures are one wrapping line since 2026-09-15 (a four-column grid overflowed a 330px card)');
  assert.match(css, /\.kv\.two \{ grid-template-columns: auto 1fr auto 1fr;/);
});

test('axis ticks keep to the count the height allows, and never repeat a label', async () => {
  const { niceTicks } = await import('../public/js/charts.js');
  const t = niceTicks(0, 160e6, 4);
  assert.ok(t.length <= 5, `0..160M in at most four intervals (${t.length} ticks: ${t.join(', ')})`);
  assert.ok(t.every((v) => (v / 50e6) % 1 === 0), 'on a nice step');
  assert.ok(niceTicks(0, 2e6, 2).length <= 3, 'a short chart gets two intervals');
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  const charts = readFileSync(new URL('../public/js/charts.js', import.meta.url), 'utf8');
  assert.ok((charts.match(/Math\.floor\(plotH \/ 22\)/g) || []).length >= 2, 'the count comes from the plot height');
  assert.ok((charts.match(/if \(label !== lastLabel\) ctx\.fillText/g) || []).length >= 2, 'and a label equal to the last is skipped');
});
