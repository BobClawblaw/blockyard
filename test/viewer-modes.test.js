// Viewer modes: Mode 1 (the viewer as it was) and Mode 2 (every transaction, dense slabs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { denseBlock } from '../server/collect/monitor.js';
import { diagonalOrder } from '../public/js/blockscene3d.js';
import { viewerSetup, VIEWER_MODES, DENSE_OPTS } from '../public/js/mining.js';

test('the dense block: every transaction of the next block\'s worth, richest first, one block and no more', () => {
  const raw = {};
  for (let i = 0; i < 9000; i++) raw[`${String(i).padStart(4, '0')}${'a'.repeat(60)}`] = { vsize: 150 + (i % 50), fees: { base: ((i % 97) + 1) * 150e-8 } };
  raw.nofee = { vsize: 300 };
  const d = denseBlock(raw);
  assert.ok(d.n > 4000 && d.n < 9000, String(d.n));
  assert.ok(d.vsize <= 1_000_000 && d.vsize > 990_000, 'one block, filled');
  for (let i = 1; i < d.r.length; i++) assert.ok(d.r[i] <= d.r[i - 1], 'richest first');
  assert.equal(d.id[0].length, 64, 'full txids: a click opens the transaction');
  assert.equal(d.unranked, 1, 'a transaction with no fee is counted, not ranked');
  assert.equal(d.v.length, d.n);
  assert.equal(denseBlock({}).n, 0);
});

test('the diagonal order: far corner first, then in; the airborne after, lowest first', () => {
  const t = (id, x, y, s, z = 0) => ({ txid: id, x, y, s, z });
  const o = diagonalOrder([t('near', 0, 0, 1), t('far', 10, 10, 1), t('mid', 5, 5, 1), t('high', 1, 1, 1, 5), t('low', 2, 2, 1, 1)]).map((x) => x.txid);
  assert.deepEqual(o, ['far', 'mid', 'near', 'low', 'high']);
});

test('viewer modes: Mode 1 is the viewer as it was; Mode 2 draws every transaction dense, and never a blank board', () => {
  assert.deepEqual(VIEWER_MODES.map((m) => m.id), ['1', '2']);
  const s = { mempool: { cells: [{ vbytes: 1000, rate: 5 }] } };
  const one = viewerSetup(s, { viewerMode: '1' });
  assert.equal(one.mode, '1');
  assert.deepEqual(one.opts, {}, 'mode 1 keeps the defaults it always had');
  const waiting = viewerSetup(s, { viewerMode: '2' });
  assert.equal(waiting.mode, '2-waiting');
  assert.equal(waiting.args.cells.length, 1, 'the mode 1 picture until the dense block arrives');
  const two = viewerSetup(s, { viewerMode: '2', denseBlock: { v: [200, 150], r: [9, 3], id: ['aa', 'bb'], vsize: 350 } });
  assert.equal(two.mode, '2');
  assert.deepEqual(two.args.cells, [{ vbytes: 200, rate: 9, txid: 'aa' }, { vbytes: 150, rate: 3, txid: 'bb' }]);
  assert.equal(two.opts, DENSE_OPTS);
  assert.equal(DENSE_OPTS.resolution, 24);
  assert.equal(DENSE_OPTS.order, 'diagonal');
});

test('viewer modes are wired: the endpoint, the switch, the remembered choice', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../server/http/api.js'), /path: '\/api\/mempool\/dense'/);
  const app = read('../public/js/app.js');
  assert.match(app, /closest\?\.\('\[data-vmode\]'\)/);
  assert.match(app, /localStorage\.setItem\('bmc\.viewerMode'/);
  assert.match(app, /\/api\/mempool\/dense/);
  assert.match(read('../public/js/mining.js'), /data-vmode="\$\{m\.id\}"/);
});

import { packBlock } from '../public/js/blockpack.js';

import { bundleSmall } from '../public/js/blockpack.js';

test('Detailed packs a realistic block with no holes, in feerate order, at full scale', () => {
  // the live shape (2026-09-11): nearly all 139-141 vB, a large transaction every 97th. Operator, on
  // 5x5 bundles on the 96-unit board: "YOU ARE GETTING WORSE AND WORSE!" -- 4.9% holes, a stagger.
  const txs = [];
  let used = 0, i = 0;
  while (used < 1_000_000) {
    const v = i % 97 === 0 ? 1200 + (i % 7) * 900 : 139 + (i % 3);
    if (used + v > 1_000_000) break;
    txs.push({ txid: i.toString(16).padStart(64, '0'), vsize: v, fee: v * (60 - i / 60) });
    used += v; i++;
  }
  const R = DENSE_OPTS.resolution;
  const vpu = vbytesPerUnit(1_000_000, R);
  const p = packBlock(bundleSmall(txs, vpu, DENSE_OPTS.bundleSide), { resolution: R, blockLimit: 1_000_000, dither: DENSE_OPTS.dither });
  const tallest = p.tiles.reduce((m, t) => Math.max(m, t.y + t.s), 0);
  assert.ok(tallest <= R, `fits at full scale (${tallest} of ${R} rows)`);
  const occ = new Uint8Array(R * R);
  let area = 0;
  for (const t of p.tiles) for (let y = t.y; y < t.y + t.s; y++) for (let x = t.x; x < t.x + t.s; x++) { occ[y * R + x] = 1; area++; }
  let holes = 0;
  for (let x = 0; x < R; x++) { let top = -1; for (let y = 0; y < R; y++) if (occ[y * R + x]) top = y; for (let y = 0; y < top; y++) if (!occ[y * R + x]) holes++; }
  assert.equal(holes, 0, 'no holes: every gap below the surface is filled');
  assert.ok(area / (R * R) > 0.85, `nearly full (${(area / (R * R) * 100).toFixed(1)}%)`);
  // feerate order: rows go up as feerates go down (Spearman rank correlation)
  const ts = p.tiles.map((t) => ({ r: t.rate, y: t.y + t.s / 2 }));
  const rank = (key, desc) => { const idx = ts.map((_, k) => k).sort((a, b) => (desc ? ts[b][key] - ts[a][key] : ts[a][key] - ts[b][key])); const rk = []; idx.forEach((k, n) => { rk[k] = n; }); return rk; };
  const rr = rank('r', true), ry = rank('y', false), n = ts.length;
  const rho = 1 - (6 * rr.reduce((a, v, k) => a + (v - ry[k]) ** 2, 0)) / (n * (n * n - 1));
  assert.ok(rho > 0.99, `in feerate order (rho ${rho.toFixed(4)})`);
  const bundles = p.tiles.filter((t) => t.txid.startsWith('bundle:'));
  assert.ok(bundles.length > 200 && bundles.every((t, k) => t.s === 1 || k === bundles.length - 1 || t.s === DENSE_OPTS.bundleSide), 'bundles are single units');
});

test('both modes name a transaction the same way, so a switch moves tiles instead of refilling the board', () => {
  const full = 'f'.repeat(64);
  const one = viewerSetup({ mempool: { cells: [{ vbytes: 500, rate: 9, txid: full }, { vbytes: 9e5, rate: 1, aggregate: 3000 }] } }, { viewerMode: '1' });
  assert.equal(one.args.cells[0].txid, full, 'full txids in both modes');
  assert.equal(one.args.cells[1].aggregate, 3000, 'the aggregate is untouched');
});

test('the kiosk: the 3D Markets board and the Block space board side by side, full screen on a click', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const html = read('../public/index.html');
  assert.match(html, /<button data-page="kiosk">Kiosk<\/button>/);
  const k = html.slice(html.indexOf('data-page="kiosk"'), html.indexOf('MARKETS -->'));
  assert.match(k, /id="kMarkets"/);
  assert.match(k, /id="kSpace"/);
  assert.match(k, /class="viewer-ctl"/, 'the Block space panel keeps its mode switch and countdown');
  assert.match(k, /id="kFull"/);
  const app = read('../public/js/app.js');
  assert.match(app, /case 'kiosk'/);
  assert.match(app, /POOL_VIEWER_PAGES = new Set\(\[[^\]]*'kiosk'/, 'the pool viewer is fed on the kiosk');
  assert.match(read('../public/js/kiosk.js'), /renderMarketsBoard\('kMarkets', h\)/);
  assert.match(read('../public/js/markets.js'), /export function renderMarketsBoard\(id, h\)/);
});

test('the kiosk keeps markets, price and block space in three panels of their own', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const k = html.slice(html.indexOf('id="kiosk"'), html.indexOf('MARKETS -->'));
  assert.equal((k.match(/<div class="kpanel /g) ?? []).length, 4, 'markets, price, block space, block flow');
  const mk = k.indexOf('id="kMarkets"'), pr = k.indexOf('id="kPrice"'), sp = k.indexOf('id="kSpace"');
  assert.ok(mk < pr && pr < sp);
  assert.match(k.slice(mk, pr), /<div class="kpanel kpp">/, 'the price text is not inside the markets panel');
});

test('the kiosk shows the chain: a Block flow panel under Block space, fed like the Overview', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const html = read('../public/index.html');
  const k = html.slice(html.indexOf('id="kiosk"'), html.indexOf('MARKETS -->'));
  assert.ok(k.indexOf('id="kSpace"') < k.indexOf('id="kTrain"'), 'Block flow comes after Block space');
  assert.match(k, /<div class="kpanel kbf">[^]*id="kTrain" class="flowwrap"/);
  const kiosk = read('../public/js/kiosk.js');
  assert.match(kiosk, /blockFlow\(train, flowArgs\(s, state\), h\.fmt\)/);
  assert.match(kiosk, /h\.nextBlock\?\.\(\)/, 'the block being built is asked for');
  assert.match(read('../public/js/app.js'), /TEMPLATE_PAGES = new Set\(\[[^\]]*'kiosk'/);
});

test('the viewer modes are called Simple and Detailed; their ids never change', () => {
  assert.deepEqual(VIEWER_MODES.map((m) => [m.id, m.label]), [['1', 'Simple'], ['2', 'Detailed']]);
});

test('the kiosk is two independent columns, and Block flow is a fixed strip that cannot grow', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const k = html.slice(html.indexOf('id="kiosk"'), html.indexOf('MARKETS -->'));
  const cols = k.split('<div class="kcol">').slice(1);
  assert.equal(cols.length, 2);
  assert.ok(/id="kMarkets"/.test(cols[0]) && /id="kPrice"/.test(cols[0]), 'markets over price');
  assert.ok(/id="kSpace"/.test(cols[1]) && /id="kTrain"/.test(cols[1]), 'block space over block flow');
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.kcol > \.kbf \{ flex: 0 0 auto; height: 240px; \}/);
  assert.match(css, /\.kbf \.flowwrap \{[^}]*overflow-y: hidden/);
  assert.match(css, /\.kbf \.flownote, \.kbf \.tiplegend \{ display: none; \}/);
});

test('the viewer controls move off the board into the panel heading, and refresh still finds its board', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const mining = read('../public/js/mining.js');
  assert.match(mining, /head\.appendChild\(ctl\); ctl\.classList\?\.add\('in-head'\)/);
  assert.match(mining, /ctl\.__canvas = canvas/);
  const app = read('../public/js/app.js');
  assert.equal((app.match(/viewerIdle\(viewerCanvasFor\(b\)\)/g) ?? []).length, 2, 'the click and the enable check both use it');
  assert.match(read('../public/css/app.css'), /\.viewer-ctl\.in-head \{ position: static;/);
});

import { vbytesPerUnit } from '../public/js/blockpack.js';

test('Detailed draws the block at its true area: a full block fills the board instead of stopping short', () => {
  // the live block of 2026-09-11: 6,699 transactions, 80% of them 139-140 vB. Drawn at the nearest
  // side a 140 vB transaction (1.27 units) was ONE unit, and the full block covered 82% of its area
  const txs = [];
  let used = 0, i = 0;
  while (used < 1_000_000) {
    const v = i % 97 === 0 ? 1200 + (i % 7) * 900 : 139 + (i % 3);
    if (used + v > 1_000_000) break;
    txs.push({ txid: i.toString(16).padStart(64, '0'), vsize: v, fee: v * (60 - i / 60) });
    used += v; i++;
  }
  const R = 96;   // the packer's own rounding, on a fine grid where it bites
  const trueUnits = used / vbytesPerUnit(1_000_000, R);
  const areaOf = (p) => p.tiles.reduce((a, t) => a + t.s * t.s, 0);
  const nearest = packBlock(txs, { resolution: R, blockLimit: 1_000_000 });
  const exact = packBlock(txs, { resolution: R, blockLimit: 1_000_000, dither: DENSE_OPTS.dither });
  assert.equal(DENSE_OPTS.dither, true, 'Detailed asks for area-true sides');
  assert.ok(areaOf(nearest) / trueUnits < 0.92, `nearest-side rounding loses area (${(areaOf(nearest) / trueUnits).toFixed(3)})`);
  assert.ok(Math.abs(areaOf(exact) / trueUnits - 1) < 0.03, `area-true (${(areaOf(exact) / trueUnits).toFixed(3)})`);
  const ones = exact.tiles.filter((t) => t.s === 1).length / exact.tiles.length;
  assert.ok(ones > 0.8 && ones < 0.97, `mostly one unit, some two (${ones.toFixed(3)})`);
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /blockLimit: opts\.blockVbytes \* k, dither: !!opts\.dither/, 'the renderer passes it to the packer');
});

test('Detailed bundles small transactions into larger squares, and says so on hover', () => {
  assert.equal(DENSE_OPTS.bundleSide, 1);
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /opts\.bundleSide \? bundleSmall\(toTxs\(cells, vpu\), vpu, opts\.bundleSide\)/);
  assert.match(src, /small transactions\`/);
});
