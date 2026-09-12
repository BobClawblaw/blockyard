// Projected blocks beyond the one being assembled (operator, 2026-09-11: "Why can't we
// forecast at least one block ahead of current work, like mempool space app does?").
import test from 'node:test';
import assert from 'node:assert/strict';

const { projectBlocks } = await import('../server/collect/monitor.js');

test('the mempool is cut into blocks by feerate, the one being assembled skipped', () => {
  const v = [500e3, 500e3, 400e3, 700e3, 300e3, 200e3, 50e3];
  const r = [50, 40, 30, 20, 10, 5, NaN];                       // the last has no known fee
  const f = v.map((x, i) => (Number.isFinite(r[i]) ? x * r[i] : 0));
  const p = projectBlocks(v, r, f, { skip: 1, count: 2 });
  assert.deepEqual(p.skipped && [p.skipped.n, p.skipped.maxRate, p.skipped.minRate], [2, 50, 40], 'the first 1,000,000 vB is the block being built');
  assert.equal(p.blocks.length, 2);
  assert.deepEqual([p.blocks[0].n, p.blocks[0].vsize, p.blocks[0].medianRate], [1, 400e3, 30], '+1 closes when the next would overflow');
  assert.deepEqual([p.blocks[1].n, p.blocks[1].minRate, p.blocks[1].maxRate], [2, 10, 20], '+2');
  assert.deepEqual(p.rest, { n: 1, vsize: 200e3, feeSat: 1e6, maxRate: 5, minRate: 5, blocks: 1 }, 'and the rest is summed, the fee-less transaction left out');
  assert.equal(projectBlocks([], [], []).blocks.length, 0, 'an empty pool projects nothing');
});

test('projected blocks sit left of the one being built, furthest future first', async () => {
  const { blockFlow } = await import('../public/js/mining.js');
  const FMT = { num: (n) => String(n ?? '-'), bytes: (n) => String(n ?? '-'), esc: (s) => String(s ?? ''), ago: () => '-', rate: (x) => String(x ?? '-'), satPerVb: (x) => String(x ?? '-'), ageSec: () => '-', pct: (n) => String(n ?? '-') };
  const projected = {
    blockVsize: 1e6,
    blocks: [{ n: 2857, vsize: 999e3, feeSat: 1.8e6, minRate: 1.01, maxRate: 140, medianRate: 1.2 }, { n: 4062, vsize: 998e3, feeSat: 1e6, minRate: 0.39, maxRate: 1, medianRate: 0.8 }],
    rest: { n: 7000, vsize: 2.5e6, feeSat: 5e5, maxRate: 0.39, minRate: 0.1, blocks: 3 },
  };
  const el = { clientWidth: 900, innerHTML: '' };
  const next = { height: 966295, txCount: 3, weight: 1.2e6, weightLimit: 4e6, weightPct: 30, totalFeesSat: 9e4, at: Date.now(), ms: 10, economy: {} };
  blockFlow(el, { tipHeight: 966294, recent: [{ height: 966294, time: 1788000000, at: 1788000000000, tagText: 'p', txs: 1, weight: 3e6, totalfee: 1, hash: 'h' }], next, mempool: { dist: { projected } }, avgGapSec: 600, tipAgeSec: 60 }, FMT);
  const todo = el.innerHTML.slice(el.innerHTML.indexOf('flowside todo'), el.innerHTML.indexOf('flowsep'));
  const at = ['+3…', '+2', '+1'].map((l) => todo.indexOf(`<div class="ph">${l}</div>`));
  assert.ok(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])), 'furthest future on the far left');
  assert.ok(todo.lastIndexOf('class="bcard proj') < todo.lastIndexOf('class="bcard next'), 'the block being built stays against the divider');
  for (const s of ['~1.20 sat/vB', '1.01 – 140', '0.018 ₿', '2857 tx', 'in ~19 min', '≈ 3 more blocks']) assert.ok(todo.includes(s), `shows ${s}`);
  assert.ok(!/style="/.test(todo), 'colour by a number, never a style attribute');
  assert.ok(/data-pfee="1\.2"/.test(todo) && !/ data-fee=/.test(todo), 'its own attribute -- [data-fee] is the fee swatches\', whose style pass paints the whole background');
});

test('the block being built and the projected blocks show how full they are, bottom to top', async () => {
  // Operator, 2026-09-12: "I want a subtle transparent background fill from bottom to top across
  // the current and estimated blocks, that visualize how full they are. A full block should have
  // the entire subtle 'full background' applied, where the building blocks should obviously show
  // lesser fill rates". .bstack is the element a MINED card already uses for exactly this; these
  // two were the only cards without it, so the one row where fullness changes while you watch was
  // the one row not drawing it.
  const { blockFlow } = await import('../public/js/mining.js');
  const FMT = { num: (n) => String(n ?? '-'), bytes: (n) => String(n ?? '-'), esc: (s) => String(s ?? ''), ago: () => '-', rate: (x) => String(x ?? '-'), satPerVb: (x) => String(x ?? '-'), ageSec: () => '-', pct: (n) => String(n ?? '-') };
  const projected = {
    blockVsize: 1e6,
    blocks: [{ n: 2857, vsize: 999e3, feeSat: 1.8e6, minRate: 1.01, maxRate: 140, medianRate: 1.2 },
      { n: 400, vsize: 250e3, feeSat: 1e6, minRate: 0.39, maxRate: 1, medianRate: 0.8 }],
    rest: { n: 7000, vsize: 2.5e6, feeSat: 5e5, maxRate: 0.39, minRate: 0.1, blocks: 3 },
  };
  const el = { clientWidth: 900, innerHTML: '' };
  const next = { height: 966295, txCount: 3, weight: 1.2e6, weightLimit: 4e6, weightPct: 30, totalFeesSat: 9e4, at: Date.now(), ms: 10, economy: {} };
  blockFlow(el, { tipHeight: 966294, recent: [], next, mempool: { dist: { projected } }, avgGapSec: 600, tipAgeSec: 60 }, FMT);
  const html = el.innerHTML;

  const built = html.slice(html.indexOf('class="bcard next'));
  assert.match(built.slice(0, 400), /<i class="bstack" data-h="30\.0"/,
    'the block being built fills to the same weightPct its own "full" row prints');

  // furthest future first (the row is reversed), each against the projection's OWN blockVsize
  const fills = [...html.matchAll(/class="bcard proj[^>]*>\s*<i class="bstack" data-h="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(fills, [25, 99.9], 'a half-packed projection reads short, a packed one nearly solid');

  const rest = html.slice(html.indexOf('class="bcard proj rest'));
  assert.ok(!rest.slice(0, 300).includes('bstack'),
    'the rest card is several blocks summed, so a fill across one card would be measuring nothing');
  assert.ok(!/style="/.test(html), 'height by a number and the CSSOM pass, never a style attribute');
});

test('the row opens with the nearest projected blocks on screen, not scrolled off the left', async () => {
  // measured on the Overview: five projected cards in the page, none visible, because the row
  // parked the divider 28% in and only the block being built fitted left of it
  const { blockFlow } = await import('../public/js/mining.js');
  const FMT = { num: (n) => String(n ?? '-'), bytes: (n) => String(n ?? '-'), esc: (s) => String(s ?? ''), ago: () => '-', rate: (x) => String(x ?? '-'), satPerVb: (x) => String(x ?? '-'), ageSec: () => '-', pct: (n) => String(n ?? '-') };
  const projected = { blockVsize: 1e6, blocks: [{ n: 1, vsize: 1e6, feeSat: 1e6, minRate: 1, maxRate: 2, medianRate: 1.5 }, { n: 1, vsize: 1e6, feeSat: 5e5, minRate: 0.5, maxRate: 1, medianRate: 0.8 }], rest: null };
  const parkOn = (clientWidth) => {
    const scrolls = [];
    const card = (left) => ({ getBoundingClientRect: () => ({ left }) });
    const el = {
      clientWidth, innerHTML: '', scrollLeft: 0,
      scrollTo: (o) => scrolls.push(o.left),
      getBoundingClientRect: () => ({ left: 0 }),
      querySelector: (sel) => (sel === '.flowsep' ? card(700) : null),
      querySelectorAll: (sel) => (sel === '.bcard.proj' ? [card(200), card(330)] : []),  // +2, +1 (furthest first)
    };
    blockFlow(el, { tipHeight: 966294, recent: [], next: { height: 966295, txCount: 3, weight: 1e6, weightLimit: 4e6, weightPct: 25, totalFeesSat: 1, at: Date.now(), ms: 1, economy: {} }, mempool: { dist: { projected } }, avgGapSec: 600 }, FMT);
    return scrolls.at(-1);
  };
  assert.equal(parkOn(900), 188, 'a wide row parks on +2, 12 px in');
  assert.equal(parkOn(400), 700 - 112, 'a narrow one keeps the divider rule (the divider would leave the left 70%)');
});
