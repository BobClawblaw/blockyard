// The Markets tab: the exchange parsers, the on-demand feed, and the board layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXCHANGES, MarketFeed } from '../server/collect/markets.js';
import { tableHtml, summaryHtml, chart3d, C3, CAMERA_3D, MAX_3D_HOURS } from '../public/js/markets.js';
import { obliqueFit, DEFAULTS } from '../public/js/details3d.js';
import { cellTops } from '../public/js/blockscene3d.js';
import { cubeHeight, tileFaces } from '../public/js/blockscene3d.js';
import { board3d } from '../public/js/details3d.js';
import { loadConfig } from '../server/config.js';
import * as fmt from '../public/js/fmt.js';

const ex = (id) => EXCHANGES.find((e) => e.id === id);

test('each exchange parser reads its own candle layout into { t ms, o, h, l, c, v }, oldest first', () => {
  const cb = ex('coinbase').parseCandles([[1789146000, 77456.66, 77948.84, 77893.45, 77489.6, 252.3], [1789142400, 77363.14, 78042.65, 77691.97, 77893.44, 411.6]]);
  assert.deepEqual(cb[0], { t: 1789142400000, o: 77691.97, h: 78042.65, l: 77363.14, c: 77893.44, v: 411.6 });
  assert.equal(cb[1].t, 1789146000000);
  const kr = ex('kraken').parseCandles({ error: [], result: { XXBTZUSD: [[1786554000, '63421.3', '63476.7', '63340.1', '63409.3', '63403.2', '34.9', 1534]], last: 1786554000 } });
  assert.deepEqual(kr[0], { t: 1786554000000, o: 63421.3, h: 63476.7, l: 63340.1, c: 63409.3, v: 34.9 });
  const bs = ex('bitstamp').parseCandles({ data: { pair: 'BTC/USD', ohlc: [{ timestamp: '1789138800', open: '78776.75', high: '78816.55', low: '77312.14', close: '77709.92', volume: '186.9' }] } });
  assert.deepEqual(bs[0], { t: 1789138800000, o: 78776.75, h: 78816.55, l: 77312.14, c: 77709.92, v: 186.9 });
  const bf = ex('bitfinex').parseCandles([[1789146000000, 77880, 77517, 77932, 77455, 40.99]]);
  assert.deepEqual(bf[0], { t: 1789146000000, o: 77880, h: 77932, l: 77455, c: 77517, v: 40.99 });
  const ok = ex('okx').parseCandles({ code: '0', data: [['1789146000000', '77913.1', '77961.9', '77490.8', '77549.2', '177.09', 'x', 'x', '0']], msg: '' });
  assert.deepEqual(ok[0], { t: 1789146000000, o: 77913.1, h: 77961.9, l: 77490.8, c: 77549.2, v: 177.09 });
});

test('tickers parse, and an exchange reporting an error is an error, not a price of zero', () => {
  assert.deepEqual(ex('coinbase').parseTicker({ price: '77533.05', bid: '77533.0', ask: '77533.1', volume: '7132.6' }), { last: 77533.05, bid: 77533, ask: 77533.1, vol24: 7132.6 });
  assert.equal(ex('kraken').parseTicker({ error: [], result: { XXBTZUSD: { a: ['77526.2', '1', '1'], b: ['77526.1', '1', '1'], c: ['77528.5', '0.1'], v: ['2842.1', '3358.2'] } } }).last, 77528.5);
  assert.equal(ex('bitfinex').parseTicker([77516, 2.5, 77524, 2.9, 92, 0.001, 77521, 1552.4, 79948, 76043]).last, 77521);
  assert.equal(ex('okx').parseTicker({ code: '0', data: [{ last: '77550.3', bidPx: '77550.3', askPx: '77550.4', vol24h: '7678.5' }] }).ask, 77550.4);
  assert.throws(() => ex('kraken').parseTicker({ error: ['EGeneral:Too many requests'] }), /Too many/);
  assert.throws(() => ex('okx').parseCandles({ code: '50011', msg: 'Too Many Requests', data: [] }), /Too Many/);
  assert.throws(() => ex('bitfinex').parseTicker(['error', 10020, 'symbol: invalid']), /invalid/);
});

function stubFeed(fail = new Set()) {
  let T = Date.UTC(2026, 8, 11, 18, 30);
  const H = 3600e3;
  const hour0 = Math.floor(T / H) * H;
  const replies = new Map();
  for (const e of EXCHANGES) {
    const base = e.id === 'okx' ? 78000 : 77000;
    // 30 hourly candles, rising 10 an hour
    const cs = Array.from({ length: 30 }, (_, i) => ({ t: hour0 - (29 - i) * H, o: base + i * 10, c: base + i * 10 + 10 }));
    if (e.id === 'coinbase') replies.set(e.candleUrl, cs.map((k) => [k.t / 1000, k.o - 5, k.c + 5, k.o, k.c, 2]).reverse());
    if (e.id === 'kraken') replies.set(e.candleUrl, { error: [], result: { XXBTZUSD: cs.map((k) => [k.t / 1000, k.o, k.c + 5, k.o - 5, k.c, 0, 3, 1]), last: 1 } });
    if (e.id === 'bitstamp') replies.set(e.candleUrl, { data: { ohlc: cs.map((k) => ({ timestamp: String(k.t / 1000), open: k.o, high: k.c + 5, low: k.o - 5, close: k.c, volume: 4 })) } });
    if (e.id === 'bitfinex') replies.set(e.candleUrl, cs.map((k) => [k.t, k.o, k.c, k.c + 5, k.o - 5, 5]).reverse());
    if (e.id === 'gemini') replies.set(e.candleUrl, cs.map((k) => [k.t, k.o, k.c + 5, k.o - 5, k.c, 7]).reverse());
    if (e.id === 'okx') replies.set(e.candleUrl, { code: '0', data: cs.map((k) => [String(k.t), k.o, k.c + 5, k.o - 5, k.c, 6]).reverse() });
  }
  replies.set(ex('coinbase').tickerUrl, { price: '77300', bid: '77299', ask: '77301', volume: '100' });
  replies.set(ex('kraken').tickerUrl, { error: [], result: { X: { a: ['77310'], b: ['77308'], c: ['77309'], v: ['1', '200'] } } });
  replies.set(ex('bitstamp').tickerUrl, { last: '77320', bid: '77319', ask: '77321', volume: '300' });
  replies.set(ex('bitfinex').tickerUrl, [77330, 1, 77331, 1, 0, 0, 77330, 400, 0, 0]);
  replies.set(ex('gemini').tickerUrl, { bid: '77314.00', ask: '77316.00', last: '77315.00', volume: { BTC: '450.5', USD: '1', timestamp: 1 } });
  replies.set(ex('okx').tickerUrl, { code: '0', data: [{ last: '78300', bidPx: '78299', askPx: '78301', vol24h: '500' }] });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const id = EXCHANGES.find((e) => url === e.tickerUrl || url === e.candleUrl)?.id;
    if (fail.has(id)) return { ok: false, status: 451, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => replies.get(url) };
  };
  const feed = new MarketFeed({ idleAfterMs: 600_000 }, { fetchImpl, now: () => T });
  return { feed, calls, advance: (ms) => { T += ms; } };
}

test('the feed: every exchange polled, figures derived, one failure reported without costing the others', async () => {
  const { feed, calls } = stubFeed(new Set(['bitfinex']));
  await feed.pollTickers();
  await feed.pollCandles();
  assert.equal(calls.length, 2 * EXCHANGES.length, 'a ticker and a candle request an exchange');
  assert.equal(EXCHANGES.length, 6, 'Gemini since 2026-09-22 ("Don\'t forget to add gemini exchange")');
  assert.match(calls[0].init.headers['user-agent'], /BlockYard/);
  assert.ok(calls[0].init.signal, 'every request has a timeout');
  const v = feed.view();
  const cb = v.exchanges.find((e) => e.id === 'coinbase');
  assert.equal(cb.last, 77300);
  assert.equal(cb.spread, 2);
  assert.equal(cb.candles.length, 30);
  assert.ok(cb.change24 > 0, 'rising candles, a positive day');
  const bf = v.exchanges.find((e) => e.id === 'bitfinex');
  assert.equal(bf.error, 'HTTP 451');
  assert.equal(bf.last, null);
  assert.equal(bf.stale, true);
  assert.equal(v.summary.reporting, 4, 'four USD books: the failing one and the USDT one are out');
  assert.equal(v.summary.median, (77309 + 77315) / 2, 'of 77300, 77309, 77315, 77320');
  assert.equal(v.summary.spread, 20);
  // Gemini's own layouts: pubticker's volume is an object, its candles are [ms, o, h, l, c, v] newest first
  const gm = v.exchanges.find((e) => e.id === 'gemini');
  assert.deepEqual([gm.last, gm.bid, gm.ask, gm.vol24, gm.quote], [77315, 77314, 77316, 450.5, 'USD']);
  assert.equal(gm.candles.length, 30);
  assert.ok(gm.candles[0].t < gm.candles.at(-1).t && gm.candles.at(-1).h === gm.candles.at(-1).c + 5 && gm.candles.at(-1).v === 7, 'oldest first, high and volume in their places');
  assert.throws(() => ex('gemini').parseCandles({ result: 'error', message: 'Supplied value is not valid' }), /Supplied value is not valid/, 'an error reply is an error, not an empty chart');
  assert.match(ex('gemini').fineUrl(900, 120), /\/v2\/candles\/btcusd\/15m$/);
  const gb = BOOKS.gemini.parse({ bids: [{ price: '77314.00', amount: '0.5', timestamp: '1' }], asks: [{ price: '77316.00', amount: '0.25', timestamp: '1' }] });
  assert.deepEqual(gb, { bids: [[77314, 0.5]], asks: [[77316, 0.25]] });
});

test('the feed runs only while someone is looking', () => {
  const { feed, advance } = stubFeed();
  assert.equal(feed.running, false, 'nothing is fetched until the tab is opened');
  feed.touch();
  assert.equal(feed.running, true);
  advance(599_000);
  assert.equal(feed.idle(), false);
  advance(2_000);
  assert.equal(feed.idle(), true, 'ten minutes without a request');
  feed.stop();
  assert.equal(feed.running, false);
});

test('the table and summary say what failed and never style inline', () => {
  const { feed } = stubFeed(new Set(['kraken']));
  return Promise.all([feed.pollTickers(), feed.pollCandles()]).then(() => {
    const v = feed.view();
    const t = tableHtml(v, fmt);
    assert.match(t, /HTTP 451/);
    assert.match(t, /77,300\.00/);
    assert.doesNotMatch(t + summaryHtml(v, fmt), /style="/);
  });
});

test('a tile can stand taller than its footprint (the market towers)', () => {
  assert.equal(cubeHeight({ s: 2, tall: 7 }), 7);
  assert.equal(cubeHeight({ s: 2 }), 2, 'transactions are still cubes');
  assert.equal(tileFaces({ x: 0, y: 0, s: 1, tall: 5 }, {}).topZ, 5);
  assert.equal(typeof board3d, 'function');
});

test('markets are wired, on by default, and switch off with BLOCKYARD_MARKETS=0', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../server/http/api.js'), /path: '\/api\/markets'/);
  const html = read('../public/index.html');
  assert.match(html, /<button data-page="markets">/);
  assert.match(html, /id="mkBoard"/);
  assert.match(read('../public/js/app.js'), /case 'markets'/);
  // the feed is built by default (the POLLING switch, off out of the box, is a Display setting:
  // test/market-polling.test.js); BLOCKYARD_MARKETS=0 removes it altogether
  assert.equal(loadConfig({ configFile: '/nonexistent-local.json' }).markets.enabled, true);
  process.env.BLOCKYARD_MARKETS = '0';
  try { assert.equal(loadConfig({ configFile: '/nonexistent-local.json' }).markets.enabled, false); } finally { delete process.env.BLOCKYARD_MARKETS; }
});

import { layoutChart, timeTicks, readout } from '../public/js/pricechart.js';
import { chartSeries } from '../public/js/markets.js';

test('the price chart: the scale covers every high and low, hours run left to right, the pointer finds its hour', () => {
  const cs = Array.from({ length: 48 }, (_, i) => ({ t: Date.UTC(2026, 8, 10) + i * 3600e3, o: 100 + i, h: 105 + i, l: 95 + i, c: 101 + i, v: i }));
  const L = layoutChart(cs, [], 1000, 400);
  assert.ok(L.lo < 95 && L.hi > 152);
  assert.ok(L.Y(152) < L.Y(95), 'higher prices draw higher');
  assert.ok(L.X(0) < L.X(47));
  assert.equal(L.index(L.X(10)), 10);
  assert.equal(L.index(-50), 0);
  assert.equal(L.index(5000), 47);
  assert.ok(Math.abs(L.V(L.Y(120)) - 120) < 1e-9, 'the crosshair price inverts the scale');
});

test('time ticks sit on whole UTC hours, and midnight carries the date', () => {
  const t0 = Date.UTC(2026, 8, 10, 5), t1 = t0 + 47 * 3600e3;
  const ticks = timeTicks(t0, t1, 900);
  assert.ok(ticks.length >= 4 && ticks.length <= 12, String(ticks.length));
  for (const k of ticks) assert.equal(k.t % 3600e3, 0);
  assert.ok(ticks.some((k) => k.label === 'Sep 11'));
});

test('the readout says exactly what the hour did', () => {
  const r = readout({ t: Date.UTC(2026, 8, 11, 17), o: 77400, h: 77900, l: 77300, c: 77500, v: 412.4 }, 'Coinbase');
  assert.match(r, /Coinbase · Sep 11 17:00 UTC/);
  assert.match(r, /O 77,400\.00  H 77,900\.00  L 77,300\.00  C 77,500\.00/);
  assert.match(r, /\+0\.13%/);
  assert.match(r, /vol 412 BTC/);
});

test('the chart series: the chosen exchange as candles, the live hour at its ticker, the rest as lines', () => {
  const now = Date.UTC(2026, 8, 11, 18, 30);
  const mk = (id, last) => ({ id, name: id, pair: 'BTC/USD', last, candles: Array.from({ length: 60 }, (_, i) => ({ t: Date.UTC(2026, 8, 11, 18) - (59 - i) * 3600e3, o: 100, h: 110, l: 90, c: 105, v: 1 })) });
  const ser = chartSeries({ exchanges: [mk('a', 120), mk('b', 80)] }, 'b', 48, now);
  assert.equal(ser.base.id, 'b');
  assert.equal(ser.candles.length, 48);
  assert.deepEqual([ser.candles.at(-1).c, ser.candles.at(-1).l], [80, 80], 'the live hour follows the ticker');
  assert.equal(ser.overlays.length, 1);
  assert.equal(ser.overlays[0].candles.length, 48, 'overlays cover the same hours');
  assert.equal(chartSeries({ exchanges: [] }, 'a', 48), null);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
});

test('a tile can float: floor lifts it, and the top a light cycle rides on includes it', () => {
  const f = tileFaces({ x: 0, y: 0, s: 1, floor: 4, tall: 2 }, {});
  assert.equal(f.base, 4);
  assert.equal(f.topZ, 6);
  assert.equal(cellTops([{ x: 0, y: 0, s: 1, floor: 4, tall: 2 }], 2, 2)[0], 6);
});

test('the 3D chart: each hour a body floating open to close, wicks below and above it, volume in front', () => {
  const k = (i, o, c, h, l, v) => ({ t: Date.UTC(2026, 8, 11, i), o, c, h, l, v });
  const ser = { base: { id: 'cb', name: 'Coinbase', pair: 'BTC-USD' }, candles: [k(0, 100, 110, 115, 95, 2), k(1, 110, 105, 112, 100, 1), k(2, 105, 105, 105, 105, 0)] };
  const c = chart3d(ser);
  const Z = (p) => C3.zBase + ((p - c.lo) / (c.hi - c.lo)) * C3.zMax;
  const near = (a, b) => Math.abs(a - b) < 0.02;
  const t0 = ser.candles[0].t;
  const body = c.tiles.find((t) => t.txid === `b:cb:${t0}`);
  assert.ok(near(body.floor, Z(100)) && near(body.floor + body.tall, Z(110)), 'the body spans open to close');
  const wl = c.tiles.find((t) => t.txid === `wl:cb:${t0}`), wh = c.tiles.find((t) => t.txid === `wh:cb:${t0}`);
  assert.ok(near(wl.floor, Z(95)) && near(wl.floor + wl.tall, Z(100)), 'the low wick: low up to the body');
  assert.ok(near(wh.floor, Z(110)) && near(wh.floor + wh.tall, Z(115)), 'the high wick: the body up to the high');
  assert.ok(wh.x > body.x && wh.x + wh.s < body.x + body.s && wh.y > body.y && wh.y + wh.s < body.y + body.s, 'wicks inside the body footprint, at its depth');
  assert.equal(body.color, '#1fc98a');
  assert.equal(c.tiles.find((t) => t.txid === `b:cb:${ser.candles[1].t}`).color, '#ef4d5e');
  assert.equal(c.tiles.filter((t) => t.txid.startsWith('w') && t.txid.endsWith(`:${ser.candles[2].t}`)).length, 0, 'no wick where the hour never left its body');
  const vol = c.tiles.filter((t) => t.txid.startsWith('v:'));
  assert.equal(vol.length, 3);
  assert.ok(vol.every((t) => t.y + t.s < body.y && !t.floor), 'volume stands on the floor in front');
  assert.equal(c.gridW, 6);
  assert.ok(c.axes.z.some((a) => a.strong && a.label === '105.00'), 'the last price is marked on the axis');
  assert.ok(c.axes.z.every((a) => a.z >= C3.zBase && a.z <= C3.zBase + C3.zMax));
  assert.ok(vol.every((t) => t.tall <= C3.zBase), 'volume stays under the price band');
  assert.ok(c.tiles.every((t) => /^#[0-9a-f]{6}$/.test(t.color) && t.label.startsWith('Coinbase BTC-USD')));
  assert.equal(chart3d(null).tiles.length, 0);
  const week = { base: ser.base, candles: Array.from({ length: 168 }, (_, i) => k(i, 1, 2, 3, 0, 1)) };
  // CAPPED AT 72, and the number is asserted literally on purpose. Expressed only as
  // `MAX_3D_HOURS * C3.slot` this passes for ANY cap -- it guarded nothing, which is how the cap
  // could be raised to 168 with the suite staying green while the chart broke (zMax ran to 101 and
  // the bodies collapsed into the floor). The literal is the guard; the derived one checks the
  // board is built from it.
  assert.equal(chart3d(week).gridW, MAX_3D_HOURS * C3.slot, 'the board is built from the cap');
  assert.equal(chart3d(week).hours, 72, 'a week is drawn as its most recent 72 hours');
  assert.ok(MAX_3D_HOURS < 168, 'raising this needs fitZ fixed first: past ~72 h the price band stops describing the data');
});

test('the chart camera faces the board and parks it along the bottom of the panel', () => {
  const o = { ...DEFAULTS, ...CAMERA_3D };
  const f = obliqueFit(1280, 480, 96, C3.depth, o);
  const ku = f.k * o.unit;
  assert.ok(f.ty < 480 && f.ty > 480 - 40, 'row 0 near the bottom edge');
  assert.ok(f.ty - ku * (C3.depth * o.oblique.dy + (C3.zBase + C3.zMax) * o.oblique.oy) > 0, 'the highest price stays on the panel');
  assert.ok(ku * 96 > 1280 * 0.6, 'and the board spans most of the width');
  const centred = obliqueFit(1280, 480, 44, 44, DEFAULTS);
  assert.ok(Math.abs(centred.ty - (240 + (centred.k * DEFAULTS.unit * 44) / 2)) < 1e-6, 'the block board is still centred');
});

import { BOOKS, depthOf, DEPTH_STEP } from '../server/collect/markets.js';
import { depthSeries, depthSums, depthNote } from '../public/js/depthchart.js';

test('order books parse per exchange; Bitfinex signs its asks negative', () => {
  assert.deepEqual(BOOKS.coinbase.parse({ bids: [['77000.5', '0.5', 1]], asks: [['77001', '1.25', 2]] }), { bids: [[77000.5, 0.5]], asks: [[77001, 1.25]] });
  assert.deepEqual(BOOKS.kraken.parse({ error: [], result: { XXBTZUSD: { bids: [['77000.0', '0.2', 1]], asks: [['77010.0', '0.3', 1]] } } }).asks, [[77010, 0.3]]);
  assert.deepEqual(BOOKS.bitfinex.parse([[77000, 3, 1.5], [77100, 2, -2.5]]), { bids: [[77000, 1.5]], asks: [[77100, 2.5]] });
  assert.deepEqual(BOOKS.okx.parse({ code: '0', data: [{ bids: [['77000', '0.1', '0', '1']], asks: [['77001', '0.2', '0', '1']] }] }).bids, [[77000, 0.1]]);
  assert.throws(() => BOOKS.okx.parse({ code: '51000', msg: 'bad' }), /bad/);
});

test('depth on the grid: cumulative from the touch outward, null past either end of a book', () => {
  const d = depthOf({ bids: [[100, 1], [99, 2], [95, 1]], asks: [[101, 1], [102, 3]] }, 90, 21, 1);
  assert.equal(d.bids[10], 1, 'at the best bid');
  assert.equal(d.bids[9], 3);
  assert.equal(d.bids[5], 4, 'down to the lowest bid');
  assert.equal(d.bids[4], null, 'past the end of the book: unknown, not zero');
  assert.equal(d.bids[11], null, 'above the best bid there are no bids to count');
  assert.equal(d.asks[10], null);
  assert.equal(d.asks[11], 1);
  assert.equal(d.asks[12], 4);
  assert.equal(d.asks[13], null);
});

function bookFeed() {
  let T = Date.UTC(2026, 8, 11, 19);
  let extra = 0;
  const two = EXCHANGES.filter((e) => e.id === 'kraken' || e.id === 'bitfinex');
  const fetchImpl = async (url) => {
    if (url === BOOKS.kraken.url) return { ok: true, status: 200, json: async () => ({ error: [], result: { X: { bids: [['77000', String(1 + extra)], ['76900', '2']], asks: [['77100', '1.5'], ['77300', '2']] } } }) };
    if (url === BOOKS.bitfinex.url) return { ok: true, status: 200, json: async () => [[77000, 1, 1], [76500, 1, 4], [77100, 1, -1], [78000, 1, -3]] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const feed = new MarketFeed({}, { fetchImpl, now: () => T, exchanges: two });
  return { feed, advance: (ms) => { T += ms; }, more: (x) => { extra = x; } };
}

test('the depth view: both books on one grid, and the total an hour, ten minutes or a minute ago', async () => {
  const { feed, advance, more } = bookFeed();
  assert.equal(feed.depthView().warming, true);
  await feed.pollBooks();
  let v = feed.depthView(600);
  assert.equal(v.step, DEPTH_STEP);
  assert.equal(v.thenAt, null, 'nothing ten minutes old yet');
  const i77 = (77000 - v.p0) / v.step;
  assert.ok(Number.isInteger(i77));
  const kr = v.exchanges.find((e) => e.id === 'kraken');
  assert.equal(kr.bids[i77], 1);
  assert.equal(kr.bids[i77 - 2], 3, '76,900: both kraken levels');
  assert.equal(kr.bids[i77 - 3], null, 'kraken\'s book ends at 76,900');
  const ser = depthSeries(v);
  assert.equal(ser.bid[i77], 2, 'the total adds the books');
  assert.equal(ser.bid[i77 - 10], 8, "76,500: bitfinex 5, and kraken at least its last 3 (its book ends at 76,900)");
  assert.equal(ser.bidPart[i77 - 10], true, "flagged: at least");
  assert.equal(ser.bidPart[i77], false);
  for (let i = 1; i < ser.bid.length; i++) if (ser.bid[i] != null && ser.bid[i - 1] != null) assert.ok(ser.bid[i - 1] >= ser.bid[i], "bids never shrink going down");
  assert.equal(ser.change, null);
  assert.ok(ser.reach.find((r) => r.id === 'kraken').low === 76900);
  // no book in this fixture reaches 1% from the mid (kraken ends at 76,900, bitfinex at 76,500): half a percent
  const s = depthSums(ser, 0.005);
  assert.ok(s.bids > 0 && s.asks > 0);
  const far = depthSums(ser, 0.01);
  assert.equal(far.bids, 8, "past every book: at least what they reached");
  assert.equal(far.atLeast, true);
  assert.equal(s.atLeast, true, "kraken has ended by 0.5% too");
  advance(600_000); more(4);
  await feed.pollBooks();
  v = feed.depthView(600);
  assert.ok(v.thenAt != null, 'a snapshot ten minutes back');
  const ser2 = depthSeries(v);
  assert.equal(ser2.change[i77], 4, 'four more BTC bid at 77,000 than ten minutes ago');
  assert.equal(ser2.change[i77 - 2], 0);
  assert.match(depthNote(v, fmt), /compare with 19:00:00 UTC \(10m before\)/);
  assert.equal(feed.depthView(1234).ago, 600, 'only the offered windows');
});

test('the depth chart is wired: route, section, controls', () => {
  assert.match(readFileSync(new URL('../server/http/api.js', import.meta.url), 'utf8'), /path: '\/api\/markets\/depth'/);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="mkDepth"/);
  assert.match(html, /id="mkDepthBar"/);
});

import { fitZ } from '../public/js/markets.js';

test('the market feed gives a slow exchange longer than 250 ms to accept a connection', async () => {
  const net = await import('node:net');
  assert.ok((net.getDefaultAutoSelectFamilyAttemptTimeout?.() ?? 3000) >= 3000);
});

test('the 3D chart carries a neon close line, and its price height fills the panel it is given', () => {
  const k = (i, o, c) => ({ t: Date.UTC(2026, 8, 11, i), o, c, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, v: 1 });
  const ser = { base: { id: 'cb', name: 'Coinbase', pair: 'BTC-USD' }, candles: [k(0, 100, 110), k(1, 110, 104), k(2, 104, 120)] };
  const c = chart3d(ser, { zMax: 40 });
  assert.equal(c.axes.line.length, 3);
  assert.deepEqual(c.axes.line.map((p) => p.x), [1, 3, 5], 'through the centre of each candle');
  const Z = (p) => C3.zBase + ((p - c.lo) / (c.hi - c.lo)) * 40;
  assert.ok(c.axes.line.every((p, i) => Math.abs(p.z - Z(ser.candles[i].c)) < 0.02), 'at each close');
  assert.equal(c.axes.zTop, C3.zBase + 40);
  // a wide panel gets more price height than the fixed 28, and it still fits
  const z = fitZ(600 / 1280, 96);
  assert.ok(z > 28, String(z));
  const o = { ...DEFAULTS, ...CAMERA_3D, oblique: { ...CAMERA_3D.oblique, headroom: C3.zBase + z + 2 } };
  const f = obliqueFit(1280, 600, 96, C3.depth, o);
  const top = f.ty - f.k * o.unit * ((C3.row + C3.body) * o.oblique.dy + (C3.zBase + z) * o.oblique.oy);
  assert.ok(top > 0 && top < 600 * 0.2, `the highest price near the top of the panel, not halfway down (${top.toFixed(0)} px)`);
  assert.match(readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8'), /function priceLine/);
});

import { starField, starAlpha } from '../public/js/details3d.js';

test('the markets board is space: no deck texture, a translucent floor, a fixed twinkling star field', () => {
  assert.equal(CAMERA_3D.space, true);
  const a = starField(1280, 600, 1), b = starField(1280, 600, 1);
  assert.deepEqual(a, b, 'the same sky every frame');
  assert.ok(a.length > 200 && a.length < 500, String(a.length));
  assert.ok(a.every((s) => s.x >= 0 && s.x <= 1280 && s.y >= 0 && s.y <= 600));
  assert.ok(a.some((s) => s.big));
  const vals = [0, 500, 1000, 1500, 2000, 3000, 4000].map((t) => starAlpha(a[0], t));
  assert.ok(vals.every((v) => v > 0 && v <= 1));
  assert.ok(Math.max(...vals) - Math.min(...vals) > 0.05, 'it twinkles');
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /if \(opts\.space\) \{\n    const S = 24/, 'the deck texture is skipped on a space board');
  // ABSENT counts as hidden, not just an explicit null: the strict `=== null` form could only
  // fire where the property exists, so the day space.stars shipped ON the sky loop's only exit
  // became unreachable wherever rAF runs inline, and renderMining recursed until the stack went.
  assert.match(src, /!canvas\.offsetParent\) \{ st\.raf = null; return; \}/, 'the twinkle stops while hidden');
});

import { project } from '../public/js/blockscene3d.js';
import { hitOps } from '../public/js/details3d.js';

test('a lower camera: depth drawn shorter than width, height at full scale, and the fit agrees', () => {
  const ob = { ox: 0, oy: 1, dy: 0.3 };
  assert.equal(project(0, 10, 0, { unit: 10, oblique: ob }).y, -30, 'ten rows back rise 3 units, not 10');
  assert.equal(project(0, 0, 10, { unit: 10, oblique: ob }).y, -100, 'ten units up rise 10');
  assert.equal(project(0, 10, 0, { unit: 10, oblique: { ox: 0, oy: 1 } }).y, -100, 'without dy the board is drawn as before');
  const o = { ...DEFAULTS, ...CAMERA_3D };
  assert.equal(o.oblique.dy, 0.3);
  assert.equal(o.dome, 0, 'a flat board: price levels stay straight');
  const f = obliqueFit(1280, 600, 96, C3.depth, o);
  assert.ok(Math.abs(f.rect.y1 * f.k * o.unit * o.oblique.dy - f.ty) < 1e-6, 'the viewport rectangle is in board rows');
});

test('hover finds the face drawn under the pointer, topmost first, never a shadow', () => {
  const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
  const ops = [
    { txid: 'floor-shadow', face: 'shadow', points: sq(0, 0, 100) },
    { txid: 'back', face: 'top', points: sq(10, 10, 30) },
    { txid: 'front', face: 'side', points: sq(20, 20, 30) },
  ];
  assert.equal(hitOps(ops, 25, 25), 'front', 'the one painted last wins');
  assert.equal(hitOps(ops, 12, 12), 'back');
  assert.equal(hitOps(ops, 80, 80), null, 'a shadow is not a thing to hover');
});

import { buildScene } from '../public/js/blockscene3d.js';

test('lit from the viewer: the faces toward the camera bright, nothing cast behind', () => {
  const tile = { txid: 'a', x: 2, y: 2, s: 2, tall: 5, color: '#1fc98a' };
  const base = { unit: 10, oblique: { ox: 0.07, oy: 0.95, dy: 0.3 }, gridW: 10, gridH: 10 };
  const sun = buildScene([tile], base).ops, eye = buildScene([tile], { ...base, light: 'viewer' }).ops;
  assert.ok(sun.some((o) => o.face === 'shadow'), 'the block board still casts');
  assert.ok(!eye.some((o) => o.face === 'shadow' || o.face === 'cast'));
  const lum = (op) => op.fill.match(/[\d.]+/g).slice(0, 3).map(Number).reduce((x, y) => x + y, 0);
  const front = (ops) => ops.find((o) => o.face === 'side' && o.key === 'near');
  assert.ok(front(eye) && front(sun));
  assert.ok(lum(front(eye)) > lum(front(sun)) * 1.3, 'the face toward the camera is lit, not in shade');
  const at = (x) => buildScene([{ ...tile, x }], { ...base, light: 'viewer' }).ops;
  assert.ok(lum(front(at(8))) > lum(front(at(0))) * 1.4, 'the newest (right) brighter than the oldest (left)');
  const leftFace = eye.find((o) => o.face === 'side' && o.key === 'left');
  if (leftFace) assert.ok(lum(leftFace) < lum(front(eye)), 'a face turned left, away from the lamp, is dimmer');
  assert.ok(!eye.some((o) => o.face === 'bevel'), 'plain faces: the bevel belongs to the upper-left light');
  assert.equal(CAMERA_3D.light, 'viewer');
});

test('a spot price for the explorer: fresh tickers when the tab has them, else one read a minute', async () => {
  const { feed, calls } = stubFeed();
  const a = await feed.spot();
  assert.equal(a.source, 'spot');
  assert.equal(a.usd, (77300 + 77309) / 2, 'coinbase and kraken');
  const n = calls.length;
  await feed.spot();
  assert.equal(calls.length, n, 'cached for a minute');
  await feed.pollTickers();
  const b = await feed.spot();
  assert.equal(b.source, 'markets');
  assert.equal(b.usd, feed.view().summary.median);
});

test('the price line is a steady neon glow now -- the saber is gone', () => {
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /saberPulses|const crackle|polySpan/, "the saber code is gone");
  assert.match(src, /A BRIGHT NEON GLOW/);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // THE FIGURES LEAD NOW, then the board, then the flat chart. This asserted that the board came
  // first, from when it was the only view. With a selector -- and 2D the default -- the board no
  // longer leads, and the median/spread/volume line has to sit under the toolbar in BOTH views:
  // measured, it was 37px below the toolbar with the chart showing and 647px below it, stranded
  // under the picture, with the board showing (operator: "that line is also missing on the 3D
  // view"). It was never missing, only last. The board-before-chart half still holds and still
  // means something, so it stays.
  // EXISTENCE FIRST, then order. `indexOf` answers -1 for something that is not there, and -1 is
  // less than every real offset -- so "the summary comes first" would have passed with the summary
  // DELETED. Checked with a negative control, which is the only reason this is written this way.
  const at = (id) => {
    const i = html.indexOf(`id="${id}"`);
    assert.ok(i >= 0, `${id} must exist in the page`);
    return i;
  };
  assert.ok(at('mkSummary') < at('mkBoard'), 'the figures sit above whichever view is drawn');
  assert.ok(at('mkBoard') < at('mkChart'), 'and the 3D board still precedes the flat chart');
});

test('the markets board has no ground grid -- one line between the candles and the hours', () => {
  assert.equal(CAMERA_3D.floorLine, true);
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const i = src.indexOf('if (opts.space && opts.floorLine) {');
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('\n  }\n', i));
  assert.doesNotMatch(body, /boardGridLayers|fill\(\)/, 'no grid layers, no floor fill');
  assert.equal((body.match(/seg\(0, 0, n, 0\)/g) ?? []).length, 3, 'one line along the front edge (glow, halo, core)');
});

import { priceInfoHtml } from '../public/js/markets.js';

test('the kiosk price panel keeps the price and drops the 24 h book detail', async () => {
  const { feed } = stubFeed(new Set(['bitfinex']));
  await feed.pollTickers();
  await feed.pollCandles();
  const html = priceInfoHtml(feed.view(), fmt);
  // KEPT: the price itself, its day, and where the figure came from
  assert.match(html, /<b class="kp-price">\$77,312\.00<\/b>/, 'the median of the fresh USD books (77300, 77309, 77315, 77320 -- four, with Gemini)');
  assert.match(html, /median of 4 USD books/, 'and the provenance line');
  assert.doesNotMatch(html, /style="/);
  assert.match(priceInfoHtml(null, fmt), /asking the exchanges/);
  // DROPPED (operator, 2026-09-12: "swap out 24 hour order book spread and details, keep the
  // price, but change to market order depth chart that fits within the view"). Asserted as
  // absences so the table cannot creep back in.
  assert.doesNotMatch(html, /24 h high|24 h low|24 h volume|spread across books/, 'the 24 h block is gone');
  assert.doesNotMatch(html, /kp-stats|kp-ex/, 'and so is the per-exchange table');
  assert.doesNotMatch(html, /<td>Coinbase<\/td>/);
  const k = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(k, /id="kPrice"/);
  // the chart that replaced it, and the reason it is a SIBLING of #kPrice: renderPriceInfo
  // rewrites that element's innerHTML, which would destroy a canvas inside it
  assert.match(k, /id="kPrice"><\/div>[^]*?<canvas class="kdepth" id="kDepth">/, 'the depth canvas sits beside the price, not inside it');
  assert.match(readFileSync(new URL('../public/js/kiosk.js', import.meta.url), 'utf8'), /renderDepthInto\('kDepth', h\)/);
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.kdepthwrap \{[^}]*flex: 1 1 auto[^}]*min-height: 0?90px/, 'it takes the rest of the panel and can shrink');
});

test('a near-square panel gets the price height it can hold -- no empty top quarter', () => {
  assert.ok(fitZ(1.12, 96) > 90, String(fitZ(1.12, 96)));
});

test('a bottom-anchored board leaves a strip under its front edge for the hours', () => {
  const o = { ...DEFAULTS, ...CAMERA_3D };
  for (const ph of [300, 420, 560, 900]) {
    const f = obliqueFit(700, ph, 96, C3.depth, o);
    assert.ok(ph - f.ty >= 0.05 * ph, `${ph}: ${(ph - f.ty).toFixed(1)} px under the board`);
  }
});

test('the 3D board keeps its price fit across refreshes while the data stays inside it', () => {
  // operator, 2026-09-15: "when the black hole sequence finishes, it causes a strange redraw of
  // the entire market screen that snaps it into a new sized view" -- a parked refresh re-fitting
  // the range at the effect's end
  const mk = (lo, hi) => ({ base: { id: 'x', name: 'X', pair: 'BTC-USD' }, candles: Array.from({ length: 24 }, (_, i) => ({ t: i * 3600e3, o: lo + 1, c: hi - 1, h: hi, l: lo, v: 1 })) });
  const first = chart3d(mk(100, 200));
  assert.ok(first.lo < 100 && first.hi > 200, 'the first fit pads the data');
  const same = chart3d(mk(105, 195), { fit: { lo: first.lo, hi: first.hi } });
  assert.equal(same.lo, first.lo); assert.equal(same.hi, first.hi);
  assert.equal(same.axes.z[0].z, first.axes.z[0].z, 'the levels stay where they were: no re-scale on a refresh that still fits');
  const out = chart3d(mk(100, 230), { fit: { lo: first.lo, hi: first.hi } });
  assert.ok(out.hi > 230, 'data that leaves the range re-fits');
  const shrunk = chart3d(mk(140, 160), { fit: { lo: first.lo, hi: first.hi } });
  assert.ok(shrunk.hi - shrunk.lo < (first.hi - first.lo) * 0.5, 'and data that shrinks well inside it re-fits too, so the chart does not stay zoomed out');
});

// ---- FINER BARS (operator, 2026-09-22: "bitcoinity.org/markets has 10m 1h 3h and 12h charts. Why don't we? ... Why
// don't we fetch finer bars like bitcoinity does?")
import { GRAINS, grainOf as serverGrain } from '../server/collect/markets.js';
import { RANGES, barsOf, grainOf } from '../public/js/markets.js';

test('the short ranges are finer bars: 1 h of 1 m, 3 h of 5 m, 12 h of 15 m -- about sixty each', () => {
  assert.deepEqual(RANGES.map(([n]) => n), [1, 3, 12, 24, 48, 168]);
  assert.deepEqual([1, 3, 12, 24, 168].map(grainOf), ['1m', '5m', '15m', null, null]);
  assert.deepEqual(barsOf(1), { n: 60, sec: 60, grain: '1m' });
  assert.deepEqual(barsOf(3), { n: 36, sec: 300, grain: '5m' });
  assert.deepEqual(barsOf(12), { n: 48, sec: 900, grain: '15m' });
  assert.deepEqual(barsOf(48), { n: 48, sec: 3600, grain: null });
  for (const [n] of RANGES) assert.ok(barsOf(n).n <= 168 && (barsOf(n).grain ? barsOf(n).n <= MAX_3D_HOURS : true), 'a short chart fits the 3D board whole');
  // every grain the page can ask for is one the server knows, and every exchange can serve it
  for (const [n] of RANGES) if (grainOf(n)) assert.ok(GRAINS[grainOf(n)], grainOf(n));
  for (const ex of EXCHANGES) for (const g of Object.values(GRAINS)) assert.match(ex.fineUrl(g.sec, g.keep), /^https:\/\//, `${ex.id} ${g.sec}`);
  assert.equal(serverGrain('1m'), '1m'); assert.equal(serverGrain('2m'), null); assert.equal(serverGrain('__proto__'), null); assert.equal(serverGrain(undefined), null);
  // each exchange's own spelling of five minutes
  const url = (id) => EXCHANGES.find((e) => e.id === id).fineUrl(300, 120);
  assert.match(url('coinbase'), /granularity=300$/); assert.match(url('kraken'), /interval=5$/); assert.match(url('bitstamp'), /step=300&limit=120$/);
  assert.match(url('bitfinex'), /trade:5m:tBTCUSD\/hist\?limit=120$/); assert.match(url('okx'), /bar=5m&limit=120$/);
});

test('a finer grain is fetched ONLY while somebody asks for it, no oftener than its cadence, and says when it fails', async () => {
  let T = 1_790_000_000_000;
  const calls = [];
  const bar = (t) => [t / 1000, 100, 110, 90, 105, 2];                   // (Kraken's layout: time s, o, h, l, c, vwap, volume)
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('bitstamp')) return { ok: false, status: 503, json: async () => ({}) };
    if (url.includes('interval=1')) return { ok: true, status: 200, json: async () => ({ error: [], result: { X: Array.from({ length: 200 }, (_, i) => { const r = bar(T - (199 - i) * 60_000); return [r[0], r[1], r[2], r[3], r[4], 0, r[5], 1]; }) } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const two = EXCHANGES.filter((e) => e.id === 'kraken' || e.id === 'bitstamp');
  const feed = new MarketFeed({ idleAfterMs: 600_000 }, { fetchImpl, now: () => T, exchanges: two });
  await feed.pollFine();
  assert.equal(calls.length, 0, 'nobody asked: nothing is fetched');
  assert.equal(feed.view().exchanges[0].bars, undefined, 'and a plain view carries no bars');
  feed.fineWanted.set('1m', T);
  await feed.pollFine();
  assert.equal(calls.length, 2, 'one request an exchange, for the grain asked for and no other');
  const v = feed.view('1m');
  assert.equal(v.grain, '1m');
  const k = v.exchanges.find((e) => e.id === 'kraken').bars, b = v.exchanges.find((e) => e.id === 'bitstamp').bars;
  assert.equal(k.candles.length, GRAINS['1m'].keep, 'kept to what a chart can use');
  assert.equal(k.candles.at(-1).t - k.candles.at(-2).t, 60_000);
  assert.deepEqual([b.candles.length, b.error], [0, 'HTTP 503'], 'a failure is reported on that exchange, never hidden');
  assert.ok(v.exchanges.every((e) => Array.isArray(e.candles)), 'the hourly series is still there: the 24 h figures are made from it');
  T += 5_000; await feed.pollFine();
  assert.equal(calls.length, 2, 'not again inside its cadence');
  T += 20_000; await feed.pollFine();
  assert.equal(calls.length, 4, 'and again once it is due');
  T += 700_000; await feed.pollFine();
  assert.equal(calls.length, 4, 'ten minutes after the last ask it is dropped');
  assert.equal(feed.fineWanted.size, 0);
  assert.equal(feed.view('bogus').grain, null, 'an unknown grain is the hourly view');
});

test('the chart series for a short range is made of the bars the reply carries, the live BAR at the ticker', () => {
  const now = Date.UTC(2026, 8, 22, 18, 30, 20);
  const bars = (sec) => Array.from({ length: 120 }, (_, i) => ({ t: Math.floor(now / (sec * 1000)) * sec * 1000 - (119 - i) * sec * 1000, o: 100, h: 110, l: 90, c: 105, v: 1 }));
  const mk = (id, last, grain, sec) => ({ id, name: id, pair: 'BTC/USD', last, candles: bars(3600).slice(-48), bars: { grain, sec, candles: bars(sec) } });
  const ser = chartSeries({ exchanges: [mk('a', 120, '1m', 60), mk('b', 80, '1m', 60)] }, 'a', 1, now);
  assert.deepEqual([ser.candles.length, ser.sec, ser.grain], [60, 60, '1m']);
  assert.equal(ser.candles.at(-1).t - ser.candles.at(-2).t, 60_000);
  assert.equal(ser.candles.at(-1).c, 120, 'the live minute follows the ticker');
  assert.equal(ser.overlays[0].candles.length, 60, 'overlays cover the same minutes');
  // the reply still carries another grain (the range was just changed): nothing to draw yet, rather than the wrong bars
  assert.equal(chartSeries({ exchanges: [mk('a', 120, '1m', 60)] }, 'a', 3, now), null);
  // the 3D board takes them, labelled in minutes
  const c3 = chart3d(ser, { zMax: 20 });
  assert.equal(c3.hours, 60);
  assert.ok(c3.axes.x.length >= 4 && c3.axes.x.every((q) => /^\d\d:\d0$/.test(q.label)), c3.axes.x.map((q) => q.label).join(' '));
  // and the flat chart's ticks are round minutes
  const ticks = timeTicks(ser.candles[0].t, ser.candles.at(-1).t, 900);
  assert.ok(ticks.length >= 4 && ticks.every((q) => q.t % 300_000 === 0 && /^\d\d:\d\d$/.test(q.label)), ticks.map((q) => q.label).join(' '));
});

test('the Kiosk honours what the Markets page chose: the store is read every time, re-read while a page stays open, and the caption says the span', async () => {
  // (operator, 2026-09-22: "Kiosk is not honoring market settings selected in the market screen". Three causes: the
  // Markets module copied exchange/range/view ONCE and kept its own; settings were fetched from the server only at
  // boot, so a Kiosk on a wall never saw a change made elsewhere; and the caption counted candles as hours.)
  const src = readFileSync(new URL('../public/js/markets.js', import.meta.url), 'utf8');
  const prefs = src.slice(src.indexOf('function prefs() {'), src.indexOf('// ONE VIEW OR THE OTHER'));
  assert.ok(!/if \(M\.ex === null/.test(prefs), 'no read-once cache of the three settings');
  assert.match(prefs, /const mk = loadSettings\(\)\.markets;\s*\n\s*M\.ex = mk\.exchange;/);
  assert.match(src, /const bo = barsOf\(M\.range\), shown = b\.c3\.hours \* bo\.sec;/, 'the caption is the span in its own units, not the number of candles');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /setInterval\(refreshSettings, 15_000\);/);
  assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) refreshSettings\(\); \}\);/);
  assert.match(app, /if \(document\.hidden \|\| settingsPushPending\(\) \|\| document\.getElementById\('settingsWrap'\)\?\.classList\?\.contains\('hidden'\) === false\) return;/,
    'never while the panel is open here or a local change is still on its way up: the local edit is the newer one');
  assert.match(app, /if \(mine !== theirs\) \{ seedSettings\(got\.settings\); render\(\); \}/, 'and only when what came back differs');
  const st = await import('../public/js/settings.js');
  assert.equal(st.settingsPushPending(), false);
});


test('the price tags always fit beside the board, and the kept price line knows its panel', () => {
  // (operator, 2026-09-22, the Kiosk on a tablet: "Price getting cut off in market screen with 1h chart" -- the room
  // for the tags was nine GRID UNITS, and with sixty one-minute bars a unit is six pixels; and "Artifacting with old
  // price line visible after switching back and forth from market to kiosk" -- the kept segment is device pixels, and
  // its signature did not include the panel)
  for (const [pw, ph, bars] of [[1940, 1160, 60], [970, 580, 60], [970, 580, 36], [2560, 1300, 72], [720, 450, 24], [490, 290, 48]]) {
    const gridW = bars * C3.slot, zMax = fitZ(ph / pw, gridW);
    const opts = { ...DEFAULTS, ...CAMERA_3D, oblique: { ...CAMERA_3D.oblique, headroom: C3.zBase + zMax + 2 } };
    const f = obliqueFit(pw, ph, gridW, C3.depth, opts);
    const right = pw - (f.tx + f.k * gridW * opts.unit);
    assert.ok(right >= 0.088 * pw - 1e-6, `${pw}x${ph}, ${bars} bars: ${right.toFixed(0)} px beside the board`);
    assert.ok(f.tx >= -1e-6, 'and the board is not pushed off the left to make it');
  }
  const d3 = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(d3, /const extra = low \? Math\.max\(9, tagPx \/ \(k1 \* u\)\) : 0;/, 'a share of the panel, with the old nine units as the floor');
  assert.match(d3, /const sig = `\$\{CURVE\.key\}\|\$\{lw\}\|\$\{ctx\.canvas\?\.width\}x\$\{ctx\.canvas\?\.height\}\|/, 'the panel\'s pixels and the transform are part of what "the same line" means');
});
