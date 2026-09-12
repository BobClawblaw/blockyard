// MARKETS (operator, 2026-09-11: "I also want us to have another tab that basically rips off
// bitcoinity.org entirely"; asked where prices should come from: "Add exchange prices").
//
// THE ONE OUTBOUND CONNECTION THAT IS NOT THE NODE. Everything else in this monitor reads the
// node's RPC; this module fetches the public, unauthenticated REST endpoints of five exchanges
// over HTTPS. It runs here, server-side, because the page's CSP lets the browser talk to this
// origin only (connect-src 'self'). What leaves the machine: this host's address and a
// User-Agent, sent to the hosts named below -- nothing about the node.
//
// ON DEMAND: polling starts when someone opens the Markets tab (GET /api/markets calls touch())
// and stops ten minutes after the last such request, so a monitor nobody is looking at makes no
// exchange traffic at all. BLOCKYARD_MARKETS=0 (or markets.enabled=false) turns it off entirely.
// Binance was tried and answers HTTP 451 from here (geo-blocked, 2026-09-11), so it is not listed.
//
// Every figure keeps its age, and an exchange that fails is reported failing with its error --
// never dropped or zero-filled (rule 8: stale must look stale).

import net from 'node:net';

// COINBASE AND OKX READ "fetch failed" (2026-09-11) while curl reached both from the same host.
// Node's fetch races a host's addresses (happy eyeballs) and gives each connect attempt 250 ms by
// default; this host has no IPv6 route, and the Cloudflare-fronted exchanges sometimes take longer
// than that to accept over IPv4, so every attempt was abandoned and the request failed outright.
// Three seconds an attempt; the process's only other connections are to the node on loopback.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(3000);

const num = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };
const candle = (t, o, h, l, c, v) => ({ t: num(t), o: num(o), h: num(h), l: num(l), c: num(c), v: num(v) });
const tidy = (rows) => rows.filter((k) => k.t != null && k.c != null).sort((a, b) => a.t - b.t);

function krakenResult(j) {
  if (Array.isArray(j?.error) && j.error.length) throw new Error(j.error.join('; '));
  return Object.values(j?.result ?? {}).find((v) => v !== null && typeof v === 'object') ?? null;
}
function okxData(j) {
  if (j?.code !== '0') throw new Error(j?.msg || `code ${j?.code ?? '?'}`);
  return Array.isArray(j.data) ? j.data : [];
}
function bitfinexRows(j) {
  if (Array.isArray(j) && j[0] === 'error') throw new Error(String(j[2] ?? j[1] ?? 'error'));
  return Array.isArray(j) ? j : [];
}

// Hourly candles from each: { t (ms, the hour's start), o, h, l, c, v (BTC) }, oldest first.
export const EXCHANGES = [
  {
    id: 'coinbase', name: 'Coinbase', pair: 'BTC-USD', quote: 'USD',
    tickerUrl: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    parseTicker: (j) => ({ last: num(j?.price), bid: num(j?.bid), ask: num(j?.ask), vol24: num(j?.volume) }),
    candleUrl: 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600',
    // [time s, low, high, open, close, volume], newest first
    parseCandles: (j) => tidy((Array.isArray(j) ? j : []).map((r) => candle(r[0] * 1000, r[3], r[2], r[1], r[4], r[5]))),
  },
  {
    id: 'kraken', name: 'Kraken', pair: 'XBT/USD', quote: 'USD',
    tickerUrl: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    parseTicker: (j) => { const r = krakenResult(j); return { last: num(r?.c?.[0]), bid: num(r?.b?.[0]), ask: num(r?.a?.[0]), vol24: num(r?.v?.[1]) }; },
    candleUrl: 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60',
    // [time s, open, high, low, close, vwap, volume, count], oldest first
    parseCandles: (j) => tidy((krakenResult(j) ?? []).map((r) => candle(r[0] * 1000, r[1], r[2], r[3], r[4], r[6]))),
  },
  {
    id: 'bitstamp', name: 'Bitstamp', pair: 'BTC/USD', quote: 'USD',
    tickerUrl: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    parseTicker: (j) => ({ last: num(j?.last), bid: num(j?.bid), ask: num(j?.ask), vol24: num(j?.volume) }),
    candleUrl: 'https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=3600&limit=168',
    parseCandles: (j) => tidy((j?.data?.ohlc ?? []).map((r) => candle(Number(r.timestamp) * 1000, r.open, r.high, r.low, r.close, r.volume))),
  },
  {
    id: 'bitfinex', name: 'Bitfinex', pair: 'BTC/USD', quote: 'USD',
    tickerUrl: 'https://api-pub.bitfinex.com/v2/ticker/tBTCUSD',
    // [BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_RELATIVE, LAST_PRICE, VOLUME, HIGH, LOW]
    parseTicker: (j) => { const a = bitfinexRows(j); return { last: num(a[6]), bid: num(a[0]), ask: num(a[2]), vol24: num(a[7]) }; },
    candleUrl: 'https://api-pub.bitfinex.com/v2/candles/trade:1h:tBTCUSD/hist?limit=168',
    // [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME], newest first
    parseCandles: (j) => tidy(bitfinexRows(j).map((r) => candle(r[0], r[1], r[3], r[4], r[2], r[5]))),
  },
  {
    id: 'okx', name: 'OKX', pair: 'BTC-USDT', quote: 'USDT',
    tickerUrl: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
    parseTicker: (j) => { const d = okxData(j)[0]; return { last: num(d?.last), bid: num(d?.bidPx), ask: num(d?.askPx), vol24: num(d?.vol24h) }; },
    candleUrl: 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=168',
    // [ts ms, o, h, l, c, vol, volCcy, volCcyQuote, confirm], newest first
    parseCandles: (j) => tidy(okxData(j).map((r) => candle(r[0], r[1], r[2], r[3], r[4], r[5]))),
  },
];

// ORDER BOOKS (operator, 2026-09-11, with a picture of bitcoinity's depth chart: "we are totally
// missing this view in the market info"). Each exchange's public book, as deep as it gives it
// free (measured 2026-09-11): Coinbase and Bitstamp the whole book (1.1 MB, 4 s; 160 KB);
// Bitfinex grouped to $100 levels, +-13%; Kraken 500 levels, about -2% / +3%; OKX 5000 levels
// (books-full), about +-1.2%. A book is never extended past where it ends.
const pairs = (rows) => (rows ?? []).map((r) => [num(r[0]), num(r[1])]).filter(([p, q]) => p > 0 && q > 0);
export const BOOKS = {
  coinbase: { url: 'https://api.exchange.coinbase.com/products/BTC-USD/book?level=2', parse: (j) => ({ bids: pairs(j?.bids), asks: pairs(j?.asks) }) },
  kraken: { url: 'https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=500', parse: (j) => { const r = krakenResult(j); return { bids: pairs(r?.bids), asks: pairs(r?.asks) }; } },
  bitstamp: { url: 'https://www.bitstamp.net/api/v2/order_book/btcusd/', parse: (j) => ({ bids: pairs(j?.bids), asks: pairs(j?.asks) }) },
  // [PRICE, COUNT, AMOUNT]: a positive amount is a bid, a negative one an ask
  bitfinex: {
    url: 'https://api-pub.bitfinex.com/v2/book/tBTCUSD/P2?len=100',
    parse: (j) => { const r = bitfinexRows(j); return { bids: pairs(r.filter((x) => x[2] > 0).map((x) => [x[0], x[2]])), asks: pairs(r.filter((x) => x[2] < 0).map((x) => [x[0], -x[2]])) }; },
  },
  okx: { url: 'https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT&sz=5000', parse: (j) => { const d = okxData(j)[0]; return { bids: pairs(d?.bids), asks: pairs(d?.asks) }; } },
};

export const DEPTH_STEP = 50;     // dollars a level on the depth grid: fixed, so snapshots compare as the price moves
export const DEPTH_SPAN = 0.12;   // how far either side of the mid the grid reaches
export const DEPTH_AGOS = [60, 300, 600, 1800, 3600];
const r3 = (v) => Math.round(v * 1000) / 1000;

// A book as cumulative depth on the grid p0 + i*step: bids[i] is the BTC bid at or above that
// price, asks[i] the BTC asked at or below it. null where that side has nothing to say -- above
// the best bid, below the best ask -- and past the end of a book the exchange cut short.
export function depthOf(book, p0, n, step = DEPTH_STEP) {
  let bestBid = -Infinity, lowBid = Infinity, bestAsk = Infinity, highAsk = -Infinity;
  for (const [p] of book.bids) { if (p > bestBid) bestBid = p; if (p < lowBid) lowBid = p; }
  for (const [p] of book.asks) { if (p < bestAsk) bestAsk = p; if (p > highAsk) highAsk = p; }
  const bids = book.bids.filter(([p]) => p >= p0 - step).sort((a, b) => b[0] - a[0]);
  const asks = book.asks.filter(([p]) => p <= p0 + n * step).sort((a, b) => a[0] - b[0]);
  const B = new Array(n).fill(null), A = new Array(n).fill(null);
  let j = 0, cum = 0;
  for (let i = n - 1; i >= 0; i--) {
    const p = p0 + i * step;
    if (p > bestBid || p < lowBid) continue;
    while (j < bids.length && bids[j][0] >= p) cum += bids[j++][1];
    B[i] = r3(cum);
  }
  j = 0; cum = 0;
  for (let i = 0; i < n; i++) {
    const p = p0 + i * step;
    if (p < bestAsk || p > highAsk) continue;
    while (j < asks.length && asks[j][0] <= p) cum += asks[j++][1];
    A[i] = r3(cum);
  }
  return { bids: B, asks: A };
}

const UA = 'Blockyard (self-hosted Bitcoin node monitor)';
const median = (xs) => (xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : null);

export class MarketFeed {
  constructor(cfg = {}, { log = () => {}, fetchImpl = globalThis.fetch, now = Date.now, exchanges = EXCHANGES } = {}) {
    this.cfg = { tickerMs: 15_000, candleMs: 300_000, bookMs: 30_000, idleAfterMs: 600_000, timeoutMs: 8_000, candles: 168, ...cfg };
    this.log = log;
    this.fetch = fetchImpl;
    this.now = now;
    this.exchanges = exchanges;
    this.rows = new Map(exchanges.map((ex) => [ex.id, { ticker: null, candles: [], candlesAt: null, tickerError: null, candleError: null }]));
    this.timers = null;
    this.lastTouch = 0;
    this.depthHist = [];          // an hour of depth snapshots, for the change bars
  }

  get running() { return this.timers != null; }
  idle() { return this.now() - this.lastTouch > this.cfg.idleAfterMs; }

  // Someone is looking: poll now if we were parked, and keep polling until nobody has asked
  // for idleAfterMs.
  touch() {
    this.lastTouch = this.now();
    if (this.timers) return;
    this.log({ level: 'info', msg: `markets: polling ${this.exchanges.length} exchanges while the Markets tab is open` });
    const run = (fn) => { fn().catch(() => {}); };
    run(() => this.pollTickers());
    run(() => this.pollCandles());
    run(() => this.pollBooks());
    const t1 = setInterval(() => {
      if (this.idle()) { this.stop(); this.log({ level: 'info', msg: 'markets: nobody watching; exchange polling parked' }); return; }
      run(() => this.pollTickers());
    }, this.cfg.tickerMs);
    const t2 = setInterval(() => run(() => this.pollCandles()), this.cfg.candleMs);
    const t3 = setInterval(() => run(() => this.pollBooks()), this.cfg.bookMs);
    t1.unref?.(); t2.unref?.(); t3.unref?.();
    this.timers = [t1, t2, t3];
  }

  stop() {
    for (const t of this.timers ?? []) clearInterval(t);
    this.timers = null;
  }

  async get(url) {
    const r = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async pollTickers() {
    await Promise.all(this.exchanges.map(async (ex) => {
      const row = this.rows.get(ex.id);
      try {
        const t = ex.parseTicker(await this.get(ex.tickerUrl));
        if (!(t.last > 0)) throw new Error('no price in the reply');
        row.ticker = { ...t, at: this.now() };
        row.tickerError = null;
      } catch (err) {
        row.tickerError = { message: String(err?.message ?? err), at: this.now() };
      }
    }));
  }

  async pollCandles() {
    await Promise.all(this.exchanges.map(async (ex) => {
      const row = this.rows.get(ex.id);
      try {
        const c = ex.parseCandles(await this.get(ex.candleUrl)).slice(-this.cfg.candles);
        if (!c.length) throw new Error('no candles in the reply');
        row.candles = c;
        row.candlesAt = this.now();
        row.candleError = null;
      } catch (err) {
        row.candleError = { message: String(err?.message ?? err), at: this.now() };
      }
    }));
  }

  async pollBooks() {
    const books = new Map();
    await Promise.all(this.exchanges.map(async (ex) => {
      const B = BOOKS[ex.id];
      if (!B) return;
      const row = this.rows.get(ex.id);
      try {
        const bk = B.parse(await this.get(B.url));
        if (!bk.bids.length || !bk.asks.length) throw new Error('an empty book');
        books.set(ex.id, bk);
        row.bookAt = this.now();
        row.bookError = null;
      } catch (err) {
        row.bookError = { message: String(err?.message ?? err), at: this.now() };
      }
    }));
    if (!books.size) return;
    const mids = [...books.values()].map((b) => {
      let bb = -Infinity, ba = Infinity;
      for (const [p] of b.bids) if (p > bb) bb = p;
      for (const [p] of b.asks) if (p < ba) ba = p;
      return (bb + ba) / 2;
    }).sort((a, b) => a - b);
    const mid = median(mids);
    const p0 = Math.floor((mid * (1 - DEPTH_SPAN)) / DEPTH_STEP) * DEPTH_STEP;
    const n = Math.ceil((mid * 2 * DEPTH_SPAN) / DEPTH_STEP) + 1;
    const snap = { at: this.now(), mid, p0, n, ex: {} };
    for (const [id, bk] of books) snap.ex[id] = depthOf(bk, p0, n);
    this.depthHist.push(snap);
    const keep = snap.at - 3700e3;
    while (this.depthHist.length && this.depthHist[0].at < keep) this.depthHist.shift();
  }

  // The latest depth, and the snapshot `ago` seconds before it (realigned onto the latest
  // grid, which follows the price) for the dashed line and the change bars.
  depthView(agoSec = 600) {
    const base = { ok: true, enabled: true, running: this.running, bookMs: this.cfg.bookMs };
    const cur = this.depthHist.at(-1);
    if (!cur) return { ...base, warming: true, exchanges: this.exchanges.map((ex) => ({ id: ex.id, name: ex.name, error: this.rows.get(ex.id).bookError?.message ?? null })) };
    const ago = DEPTH_AGOS.includes(agoSec) ? agoSec : 600;
    const want = cur.at - ago * 1000 + 5000;      // a poll's jitter either way
    let then = null;
    for (let i = this.depthHist.length - 2; i >= 0; i--) if (this.depthHist[i].at <= want) { then = this.depthHist[i]; break; }
    const shift = (arr) => { const k = Math.round((then.p0 - cur.p0) / DEPTH_STEP); return Array.from({ length: cur.n }, (_, i) => arr[i - k] ?? null); };
    return {
      ...base, at: cur.at, thenAt: then?.at ?? null, firstAt: this.depthHist[0].at, ago,
      mid: cur.mid, p0: cur.p0, n: cur.n, step: DEPTH_STEP,
      exchanges: this.exchanges.map((ex) => {
        const c = cur.ex[ex.id], t = then?.ex[ex.id], r = this.rows.get(ex.id);
        return {
          id: ex.id, name: ex.name, quote: ex.quote,
          bids: c?.bids ?? null, asks: c?.asks ?? null,
          thenBids: t ? shift(t.bids) : null, thenAsks: t ? shift(t.asks) : null,
          error: r.bookError?.message ?? null, bookAt: r.bookAt ?? null,
        };
      }),
    };
  }

  // A PRICE FOR THE EXPLORER'S DOLLAR FIGURES without starting the feed: the median of fresh
  // tickers when the Markets tab has them; otherwise one Coinbase and one Kraken ticker read,
  // cached a minute (two requests a minute at most while someone browses the explorer).
  async spot() {
    const v = this.view();
    if (v.summary.median != null) return { usd: v.summary.median, at: this.now(), source: 'markets' };
    if (this.spotCache && this.now() - this.spotCache.at < 60_000) return this.spotCache;
    if (this.spotBusy) return this.spotBusy;
    this.spotBusy = (async () => {
      const picks = this.exchanges.filter((e) => e.quote === 'USD').slice(0, 2);
      const got = await Promise.all(picks.map(async (ex) => { try { return ex.parseTicker(await this.get(ex.tickerUrl)).last; } catch { return null; } }));
      const xs = got.filter((x) => x > 0).sort((a, b) => a - b);
      this.spotCache = { usd: xs.length ? median(xs) : null, at: this.now(), source: 'spot' };
      return this.spotCache;
    })().finally(() => { this.spotBusy = null; });
    return this.spotBusy;
  }

  view() {
    const now = this.now();
    const day = now - 24 * 3600e3;
    const exchanges = this.exchanges.map((ex) => {
      const r = this.rows.get(ex.id);
      const t = r.ticker;
      const lastCandle = r.candles.at(-1) ?? null;
      const last = t?.last ?? lastCandle?.c ?? null;
      const inDay = r.candles.filter((k) => k.t >= day);
      const ref = inDay[0]?.o ?? null;             // the price as the first hour inside the last 24 h opened
      const highs = inDay.map((k) => k.h).filter((v) => v != null);
      const lows = inDay.map((k) => k.l).filter((v) => v != null);
      return {
        id: ex.id, name: ex.name, pair: ex.pair, quote: ex.quote,
        last, bid: t?.bid ?? null, ask: t?.ask ?? null,
        spread: t?.bid != null && t?.ask != null ? t.ask - t.bid : null,
        vol24: t?.vol24 ?? null,
        change24: last != null && ref ? (last - ref) / ref : null,
        high24: highs.length ? Math.max(...highs, last ?? -Infinity) : null,
        low24: lows.length ? Math.min(...lows, last ?? Infinity) : null,
        at: t?.at ?? null,
        stale: !t || now - t.at > 3 * this.cfg.tickerMs,
        error: r.tickerError?.message ?? r.candleError?.message ?? null,
        candles: r.candles, candlesAt: r.candlesAt,
      };
    });
    const usd = exchanges.filter((e) => e.quote === 'USD' && e.last != null && !e.stale).map((e) => e.last).sort((a, b) => a - b);
    return {
      ok: true, enabled: true, at: now, running: this.running, interval: '1h', tickerMs: this.cfg.tickerMs,
      warming: exchanges.every((e) => e.last == null),
      summary: {
        median: median(usd),
        spread: usd.length > 1 ? usd.at(-1) - usd[0] : null,
        vol24: exchanges.reduce((a, e) => a + (e.vol24 ?? 0), 0) || null,
        reporting: usd.length,
      },
      exchanges,
    };
  }
}
