// MARKETS (operator, 2026-09-11: "I also want us to have another tab that basically rips off
// bitcoinity.org entirely"; asked where prices should come from: "Add exchange prices").
//
// THE ONE OUTBOUND CONNECTION THAT IS NOT THE NODE. Everything else in this monitor reads the
// node's RPC; this module fetches the public, unauthenticated REST endpoints of six exchanges
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
    fineUrl: (sec) => `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${sec}`,
    // [time s, low, high, open, close, volume], newest first
    parseCandles: (j) => tidy((Array.isArray(j) ? j : []).map((r) => candle(r[0] * 1000, r[3], r[2], r[1], r[4], r[5]))),
  },
  {
    id: 'kraken', name: 'Kraken', pair: 'XBT/USD', quote: 'USD',
    tickerUrl: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    parseTicker: (j) => { const r = krakenResult(j); return { last: num(r?.c?.[0]), bid: num(r?.b?.[0]), ask: num(r?.a?.[0]), vol24: num(r?.v?.[1]) }; },
    candleUrl: 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60',
    fineUrl: (sec) => `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${sec / 60}`,
    // [time s, open, high, low, close, vwap, volume, count], oldest first
    parseCandles: (j) => tidy((krakenResult(j) ?? []).map((r) => candle(r[0] * 1000, r[1], r[2], r[3], r[4], r[6]))),
  },
  {
    id: 'bitstamp', name: 'Bitstamp', pair: 'BTC/USD', quote: 'USD',
    tickerUrl: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    parseTicker: (j) => ({ last: num(j?.last), bid: num(j?.bid), ask: num(j?.ask), vol24: num(j?.volume) }),
    candleUrl: 'https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=3600&limit=168',
    fineUrl: (sec, n) => `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=${sec}&limit=${n}`,
    parseCandles: (j) => tidy((j?.data?.ohlc ?? []).map((r) => candle(Number(r.timestamp) * 1000, r.open, r.high, r.low, r.close, r.volume))),
  },
  {
    id: 'bitfinex', name: 'Bitfinex', pair: 'BTC/USD', quote: 'USD',
    tickerUrl: 'https://api-pub.bitfinex.com/v2/ticker/tBTCUSD',
    // [BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_RELATIVE, LAST_PRICE, VOLUME, HIGH, LOW]
    parseTicker: (j) => { const a = bitfinexRows(j); return { last: num(a[6]), bid: num(a[0]), ask: num(a[2]), vol24: num(a[7]) }; },
    candleUrl: 'https://api-pub.bitfinex.com/v2/candles/trade:1h:tBTCUSD/hist?limit=168',
    fineUrl: (sec, n) => `https://api-pub.bitfinex.com/v2/candles/trade:${sec / 60}m:tBTCUSD/hist?limit=${n}`,
    // [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME], newest first
    parseCandles: (j) => tidy(bitfinexRows(j).map((r) => candle(r[0], r[1], r[3], r[4], r[2], r[5]))),
  },
  // GEMINI (operator, 2026-09-22: "why don't we include prices from Gemini or cex.io", then "Don't forget to add gemini
  // exchange"). Probed from this host the same day: v1 pubticker carries bid, ask, last and the 24 h BTC volume in
  // one reply; v2 candles are [ms, o, h, l, c, v], newest first, at 1m/5m/15m/1hr (and lag -- the newest hourly bar
  // was 1.7 h old -- so the live bar is the ticker's or nobody's); the whole book is about 300 KB.
  // CEX.IO was probed too and left out: its candle endpoint answers [] and its market was 0.35 BTC in 24 hours.
  {
    id: 'gemini', name: 'Gemini', pair: 'BTC/USD', quote: 'USD',
    tickerUrl: 'https://api.gemini.com/v1/pubticker/btcusd',
    parseTicker: (j) => ({ last: num(j?.last), bid: num(j?.bid), ask: num(j?.ask), vol24: num(j?.volume?.BTC) }),
    candleUrl: 'https://api.gemini.com/v2/candles/btcusd/1hr',
    fineUrl: (sec) => `https://api.gemini.com/v2/candles/btcusd/${sec / 60}m`,
    parseCandles: (j) => { if (!Array.isArray(j)) throw new Error(String(j?.message ?? j?.reason ?? 'not a candle list')); return tidy(j.map((r) => candle(r[0], r[1], r[2], r[3], r[4], r[5]))); },
  },
  {
    id: 'okx', name: 'OKX', pair: 'BTC-USDT', quote: 'USDT',
    tickerUrl: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
    parseTicker: (j) => { const d = okxData(j)[0]; return { last: num(d?.last), bid: num(d?.bidPx), ask: num(d?.askPx), vol24: num(d?.vol24h) }; },
    candleUrl: 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=168',
    fineUrl: (sec, n) => `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${sec / 60}m&limit=${n}`,
    // [ts ms, o, h, l, c, vol, volCcy, volCcyQuote, confirm], newest first
    parseCandles: (j) => tidy(okxData(j).map((r) => candle(r[0], r[1], r[2], r[3], r[4], r[5]))),
  },
];

// FINER BARS (operator, 2026-09-22: "bitcoinity.org/markets has 10m 1h 3h and 12h charts. Why don't we? ... Why don't
// we fetch finer bars like bitcoinity does?"). There was no reason: hourly candles were the first day's
// simplification. Every exchange here serves 1-, 5- and 15-minute candles from the same endpoint as its hourly ones
// (probed from this host 2026-09-22; each entry's `fineUrl`). A short chart is about sixty bars of the grain that
// fits it -- 1 h of 1 m, 3 h of 5 m, 12 h of 15 m -- and ONLY THE GRAIN SOMEBODY IS LOOKING AT IS POLLED, on the same
// on-demand rule as everything else in this file: asking for it is what keeps it coming, and it stops ten minutes
// after the last ask. The hourly series is always kept: the 24 h figures in the table are made from it.
export const GRAINS = Object.freeze({
  '1m': Object.freeze({ sec: 60, keep: 120, everyMs: 20_000 }),
  '5m': Object.freeze({ sec: 300, keep: 120, everyMs: 60_000 }),
  '15m': Object.freeze({ sec: 900, keep: 120, everyMs: 120_000 }),
});
export const grainOf = (v) => (Object.hasOwn(GRAINS, String(v)) ? String(v) : null);

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
  // [{ price, amount, timestamp }]; limit 0 is the whole book
  gemini: { url: 'https://api.gemini.com/v1/book/btcusd?limit_bids=0&limit_asks=0', parse: (j) => ({ bids: pairs((j?.bids ?? []).map((r) => [r.price, r.amount])), asks: pairs((j?.asks ?? []).map((r) => [r.price, r.amount])) }) },
  okx: { url: 'https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT&sz=5000', parse: (j) => { const d = okxData(j)[0]; return { bids: pairs(d?.bids), asks: pairs(d?.asks) }; } },
};

export const DEPTH_STEP = 50;     // dollars a level on the depth grid: fixed, so snapshots compare as the price moves
export const DEPTH_SPAN = 0.12;   // how far either side of the mid the grid reaches
export const DEPTH_AGOS = [60, 300, 600, 1800, 3600];
// BOUNDS ON WHAT AN EXCHANGE CAN MAKE US DO (2026-09-16, audit L5). The grid size was
// ceil(mid x 0.24 / 50) with the mid taken from the books themselves, so one absurd book --
// bid 60,000, ask 2e10, answering alone -- made 48 million levels, blocked pollBooks for
// 10 s and held 5 GB for the hour the snapshot is kept. None of that takes a malicious
// exchange, only a broken, compromised or intercepted one. So:
//   - a book whose mid is more than DEPTH_SANE from the median of every other book and
//     every recent ticker is not drawn; its row says why (an exchange answering nonsense
//     is reported, never silently dropped -- rule 8);
//   - the grid never exceeds DEPTH_MAX_LEVELS (at $50 a level that is a mid near $400,000
//     before it bites; today's is about 370 levels);
//   - a reply body is read up to MAX_BODY_BYTES and no further (Coinbase's whole book, the
//     largest, measured 1.1 MB on 2026-09-11), and a redirect is an error, not a new host.
export const DEPTH_SANE = 0.2;
export const DEPTH_MAX_LEVELS = 2000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const TICKER_REF_MS = 600_000;    // how old a ticker may be and still vouch for a book's price
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

const UA = 'BlockYard (self-hosted Bitcoin node monitor)';

// A reply body, read no further than `limit` bytes (2026-09-16, audit L5). A declared
// Content-Length past the limit is refused before reading; otherwise the stream is read
// chunk by chunk and cancelled the moment it passes the limit, so a hostile or broken
// endpoint costs at most `limit` bytes of memory, not whatever it cares to send inside
// the 8 s timeout. A reply object with no stream (the tests' stubs) falls back to json().
export async function readJsonCapped(r, limit = MAX_BODY_BYTES) {
  const declared = Number(r.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`reply of ${declared} bytes is over the ${limit}-byte limit`);
  const reader = r.body?.getReader?.();
  if (!reader) return r.json();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new Error(`reply over the ${limit}-byte limit`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8'));
}
const median = (xs) => (xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : null);

export class MarketFeed {
  constructor(cfg = {}, { log = () => {}, fetchImpl = globalThis.fetch, now = Date.now, exchanges = EXCHANGES } = {}) {
    this.cfg = { tickerMs: 15_000, candleMs: 300_000, bookMs: 30_000, idleAfterMs: 600_000, timeoutMs: 8_000, candles: 168, maxBodyBytes: MAX_BODY_BYTES, ...cfg };
    this.log = log;
    this.fetch = fetchImpl;
    this.now = now;
    this.exchanges = exchanges;
    this.rows = new Map(exchanges.map((ex) => [ex.id, { ticker: null, candles: [], candlesAt: null, tickerError: null, candleError: null, fine: {} }]));
    this.fineWanted = new Map();    // grain -> when it was last asked for
    this.fineAt = new Map();        // grain -> when it was last polled
    this.timers = null;
    this.lastTouch = 0;
    this.depthHist = [];          // an hour of depth snapshots, for the change bars
  }

  get running() { return this.timers != null; }
  idle() { return this.now() - this.lastTouch > this.cfg.idleAfterMs; }

  // Someone is looking: poll now if we were parked, and keep polling until nobody has asked
  // for idleAfterMs.
  touch(grain = null) {
    this.lastTouch = this.now();
    const g = grainOf(grain);
    if (g) {
      const fresh = !this.fineWanted.has(g) || this.now() - this.fineWanted.get(g) > this.cfg.idleAfterMs;
      this.fineWanted.set(g, this.now());
      if (fresh && this.timers) this.pollFine().catch(() => {});      // a timeframe just chosen: do not make it wait for the next tick
    }
    if (this.timers) return;
    this.log({ level: 'info', msg: `markets: polling ${this.exchanges.length} exchanges while the Markets tab is open` });
    const run = (fn) => { fn().catch(() => {}); };
    run(() => this.pollTickers());
    run(() => this.pollCandles());
    run(() => this.pollBooks());
    run(() => this.pollFine());
    const t1 = setInterval(() => {
      if (this.idle()) { this.stop(); this.log({ level: 'info', msg: 'markets: nobody watching; exchange polling parked' }); return; }
      run(() => this.pollTickers());
      run(() => this.pollFine());             // (it fetches only a grain that is wanted AND due: most ticks it does nothing)
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
    // redirect 'error' (2026-09-16, audit L5): every URL above is the exchange's own API
    // host; a 3xx pointing somewhere else is not followed.
    const r = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return readJsonCapped(r, this.cfg.maxBodyBytes);
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

  // The finer grains: each one only while it has been asked for within idleAfterMs, and no oftener than its own
  // cadence (a one-minute bar is worth re-reading every 20 s, a fifteen-minute one every two minutes).
  async pollFine() {
    const now = this.now();
    const due = [];
    for (const [g, asked] of this.fineWanted) {
      if (now - asked > this.cfg.idleAfterMs) { this.fineWanted.delete(g); continue; }
      if (now - (this.fineAt.get(g) ?? -Infinity) >= GRAINS[g].everyMs - 1000) due.push(g);
    }
    await Promise.all(due.map(async (g) => {
      this.fineAt.set(g, now);
      const { sec, keep } = GRAINS[g];
      await Promise.all(this.exchanges.map(async (ex) => {
        const row = this.rows.get(ex.id);
        const slot = (row.fine[g] ??= { candles: [], at: null, error: null });
        if (typeof ex.fineUrl !== 'function') { slot.error = { message: 'this exchange has no finer candles here', at: this.now() }; return; }
        try {
          const c = ex.parseCandles(await this.get(ex.fineUrl(sec, keep))).slice(-keep);
          if (!c.length) throw new Error('no candles in the reply');
          slot.candles = c; slot.at = this.now(); slot.error = null;
        } catch (err) {
          slot.error = { message: String(err?.message ?? err), at: this.now() };
        }
      }));
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
    const midOf = (b) => {
      let bb = -Infinity, ba = Infinity;
      for (const [p] of b.bids) if (p > bb) bb = p;
      for (const [p] of b.asks) if (p < ba) ba = p;
      return (bb + ba) / 2;
    };
    const bookMids = new Map([...books].map(([id, b]) => [id, midOf(b)]));
    // Sanity (2026-09-16, audit L5): each book against everyone else -- the other books'
    // mids and every ticker younger than ten minutes. With one book answering, the tickers
    // are the check; with nothing to compare against, the book stands as before.
    const tickers = this.exchanges.map((ex) => this.rows.get(ex.id)?.ticker)
      .filter((t) => t?.last > 0 && this.now() - t.at <= TICKER_REF_MS).map((t) => t.last);
    for (const [id, m] of bookMids) {
      const others = [...[...bookMids].filter(([k]) => k !== id).map(([, v]) => v), ...tickers].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
      const ref = median(others);
      const bad = !(Number.isFinite(m) && m > 0) ? 'no usable mid price'
        : ref != null && Math.abs(m - ref) / ref > DEPTH_SANE ? `mid ${Math.round(m)} is more than ${DEPTH_SANE * 100}% from the other exchanges (${Math.round(ref)}); book not drawn`
          : null;
      if (bad) {
        books.delete(id);
        const row = this.rows.get(id);
        if (row) row.bookError = { message: bad, at: this.now() };
      }
    }
    if (!books.size) return;
    const mids = [...books.keys()].map((id) => bookMids.get(id)).sort((a, b) => a - b);
    const mid = median(mids);
    let p0 = Math.floor((mid * (1 - DEPTH_SPAN)) / DEPTH_STEP) * DEPTH_STEP;
    let n = Math.ceil((mid * 2 * DEPTH_SPAN) / DEPTH_STEP) + 1;
    if (n > DEPTH_MAX_LEVELS) {
      // Clamped: keep the mid in the middle of the grid rather than letting the grid stop
      // short of it.
      n = DEPTH_MAX_LEVELS;
      p0 = Math.max(0, Math.floor((mid - (n / 2) * DEPTH_STEP) / DEPTH_STEP) * DEPTH_STEP);
    }
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

  view(grain = null) {
    const now = this.now();
    const g = grainOf(grain);
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
        // the finer bars, when a short chart asked for them (stale ones keep their age; an error is reported, never hidden)
        ...(g ? { bars: { grain: g, sec: GRAINS[g].sec, candles: r.fine[g]?.candles ?? [], at: r.fine[g]?.at ?? null, error: r.fine[g]?.error?.message ?? null } } : {}),
      };
    });
    const usd = exchanges.filter((e) => e.quote === 'USD' && e.last != null && !e.stale).map((e) => e.last).sort((a, b) => a - b);
    return {
      ok: true, enabled: true, at: now, running: this.running, interval: '1h', grain: g, grains: Object.keys(GRAINS), tickerMs: this.cfg.tickerMs,
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
