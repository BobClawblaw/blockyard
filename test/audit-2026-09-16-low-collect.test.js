// SECURITY AUDIT 2026-09-16, LOW FINDINGS IN THE COLLECTORS: L4, L5, L6.
//
//   L4  a coinbase ending in OP_PUSHDATA2/4 without its length bytes threw ERR_OUT_OF_RANGE,
//       and both attribution lanes retried that block forever with every later block behind it.
//   L5  one absurd order book set the depth grid's size on its own: 48 million levels, 5 GB.
//       Reply bodies had no size cap and redirects were followed.
//   L6  log rules that were cubic (legDown) or quadratic (the bandwidth tick) on a long run of
//       spaces, run on the main thread; the unterminated line in splitLines grew without limit.
//
// No real network: exchange replies are stubs or a local server on 127.0.0.1, and every peer
// address below is an RFC 5737 documentation address.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parsePushes, decodeCoinbase, decodeCoinbaseSafe } from '../server/collect/mining.js';
import { NodeMonitor } from '../server/collect/monitor.js';
import { NetworkStats } from '../server/collect/network.js';
import { History } from '../server/store/history.js';
import { MarketFeed, EXCHANGES, BOOKS, DEPTH_MAX_LEVELS, readJsonCapped } from '../server/collect/markets.js';
import { parseLine, splitLines, MAX_LINE } from '../server/collect/logparse.js';

// ---------------------------------------------------------------- L4

test('L4: a scriptSig ending on OP_PUSHDATA1/2/4 without its length decodes to what came before', () => {
  for (const hex of ['03aabbcc4c', '03aabbcc4d', '03aabbcc4d01', '03aabbcc4e', '03aabbcc4e0102', '03aabbcc4e010203']) {
    const d = decodeCoinbase(hex);                       // threw ERR_OUT_OF_RANGE before the fix
    assert.equal(d.parseable, true, hex);
    assert.equal(d.height, 0xccbbaa, `${hex}: the BIP34 height push survives`);
    assert.ok(d.truncatedAt > 0, `${hex}: the unread tail is reported`);
    const p = parsePushes(hex);
    assert.equal(p.pushes.length, 1, hex);
    assert.equal(p.consumed, 4, `${hex}: the walk stops at the truncated header`);
  }
});

test('L4: decodeCoinbase never throws on random bytes (fuzz, seeded)', () => {
  let seed = 0x20260916;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const special = [0x00, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0xff];
  for (let k = 0; k < 30_000; k++) {
    const n = Math.floor(rnd() * 110);
    let hex = '';
    for (let j = 0; j < n; j++) {
      const b = rnd() < 0.25 ? special[Math.floor(rnd() * special.length)] : Math.floor(rnd() * 256);
      hex += b.toString(16).padStart(2, '0');
    }
    if (rnd() < 0.05) hex += 'f';                          // odd length
    if (rnd() < 0.05) hex = hex.slice(0, 6) + 'zz' + hex.slice(6);   // not hex at all
    try { decodeCoinbase(hex); } catch (err) { assert.fail(`decodeCoinbase('${hex}') threw ${err.message}`); }
  }
  for (const v of [null, undefined, 42, {}, [], '4d', '4e', '4c']) assert.doesNotThrow(() => decodeCoinbase(v));
  const odd = decodeCoinbaseSafe({ toString() { throw new Error('boom'); } });
  assert.equal(odd.parseable, false);
  assert.match(odd.decodeError, /boom/);
});

function miningMonitor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-l4-'));
  const store = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9, blockMapCap: 500, auditMaxBytes: 1 << 20, auditKeep: 2 };
  const logger = () => {}; logger.child = () => logger;
  const m = new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null },
    { rpc: { maxInFlight: 1, minIntervalMs: 0, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {},
      miningCfg: { backfill: 36, perTick: 10, enabled: true } });
  m.state.chainInfo = { blocks: 1000, initialblockdownload: false };
  for (let h = 996; h <= 1000; h++) m.state.blocks.set(h, { height: h, hash: `hash${h}`, time: 1789000000 });
  return m;
}

test('L4: the monitor records an undecodable coinbase as unparseable and moves on; an RPC failure still retries', async () => {
  const m = miningMonitor();
  const good = '03a1b40c04deadbeef082f4d696e656420627920416e74506f6f6c2f';
  const coinbaseFor = {
    hash1000: '03aabbcc4d',                                              // truncated OP_PUSHDATA2
    hash999: { toString() { throw new Error('undecodable'); } },         // a decode that throws
  };
  let getblockFails = false;
  m.rpc.batch = async (calls) => {
    const c = calls[0];
    if (c.method === 'getblock') {
      if (getblockFails) throw new Error('dropped: lane busy');
      return [{ ok: true, result: { tx: [`cb-${c.params[0]}`], time: 1789000000, size: 1, weight: 4 } }];
    }
    if (c.method === 'getrawtransaction') {
      const hash = c.params[0].slice(3);
      return [{ ok: true, result: { vin: [{ coinbase: coinbaseFor[hash] ?? good }] } }];
    }
    return [{ ok: false, error: { message: 'unexpected' } }];
  };
  m.enqueueMining([996, 997, 998, 999, 1000]);
  await new Promise((r) => setTimeout(r, 20));
  await m.pumpMining();
  assert.equal(m.mining.rows.size, 5, 'every block attributed, the bad ones included');
  assert.deepEqual(m.miningQueue, [], 'nothing went back on the queue');
  assert.equal(m.mining.failures, 0);
  assert.equal(m.mining.rows.get(999).tagParseable, false);
  assert.match(m.mining.rows.get(999).decodeError, /undecodable/);
  assert.match(m.mining.rows.get(999).poolKey, /^unknown:/, 'an unknown pool, not a guess');
  assert.equal(m.mining.rows.get(1000).tagParseable, true);

  // An RPC failure is still transient: the height goes back and a retry is scheduled.
  m.state.blocks.set(1001, { height: 1001, hash: 'hash1001', time: 1789000600 });
  getblockFails = true;
  m.miningQueue.push(1001);
  await m.pumpMining();
  assert.deepEqual(m.miningQueue, [1001]);
  assert.ok(m.mining.retryAt > Date.now());
  m.stopped = true;
});

test('L4: the pool-history lane records a bad coinbase instead of retrying the chunk forever', async () => {
  const T0 = 1_700_000_000;
  const rpc = {
    async batch(list) {
      return list.map((c) => {
        const [p0] = c.params ?? [];
        switch (c.method) {
          case 'getblockhash': return { ok: true, result: `hash${p0}` };
          case 'getblock': return { ok: true, result: { time: T0 + Number(String(p0).slice(4)) * 600, tx: [`cb${p0}`] } };
          case 'getrawtransaction': {
            const h = Number(String(c.params[2]).slice(4));
            const tag = h === 5 ? '/Odd Pool/' : '/Fake Pool/';
            const coinbase = h === 3 ? '03aabbcc4e0102' : '03e70b00' + Buffer.from(tag).toString('hex');
            return { ok: true, result: { vin: [{ coinbase }] } };
          }
          default: return { ok: false, error: { message: 'no' } };
        }
      });
    },
  };
  // An alias table that throws on one pool's key stands in for any failure past the RPC calls.
  const aliases = new Proxy({}, { get(_, key) { if (key === 'odd') throw new Error('bad alias'); return undefined; } });
  const ns = new NetworkStats({ rpc, aliases: () => aliases, now: () => T0 * 1000 });
  await ns.fetchPools([1, 2, 3, 4, 5, 6, 7, 8]);             // rejected before the fix (height 3)
  assert.equal(ns.pools.size, 8, 'the whole chunk lands');
  assert.equal(ns.pools.get(3).unparseable, undefined, 'a truncated push still decodes');
  assert.equal(ns.pools.get(5).unparseable, true, 'a block that cannot be read is marked, not retried');
  assert.match(ns.pools.get(5).poolKey, /^unknown:/);

  // and through the pump: nothing is put back, no error is recorded
  ns.poolTodo = [9, 10, 11];
  ns.pumpPools();
  await new Promise((r) => setTimeout(r, 30));
  ns.stop();
  assert.equal(ns.lastError, null);
  assert.deepEqual(ns.poolTodo, []);
  assert.ok(ns.pools.has(9) && ns.pools.has(11));
});

// ---------------------------------------------------------------- L5

const reply = (body) => ({ ok: true, status: 200, json: async () => body });
const krakenBook = (bid, ask) => ({ error: [], result: { X: { bids: [[String(bid), '1']], asks: [[String(ask), '1']] } } });
const bitfinexBook = (bid, ask) => [[bid, 1, 1], [ask, 1, -1]];
const coinbaseBook = (bid, ask) => ({ bids: [[String(bid), '1', 1]], asks: [[String(ask), '1', 1]] });

function booksFeed(ids, books, { now = Date.UTC(2026, 8, 16, 12) } = {}) {
  const exchanges = EXCHANGES.filter((e) => ids.includes(e.id));
  const fetchImpl = async (url) => {
    const id = Object.keys(BOOKS).find((k) => BOOKS[k].url === url);
    return books[id] ? reply(books[id]) : { ok: false, status: 404, json: async () => ({}) };
  };
  return new MarketFeed({}, { fetchImpl, now: () => now, exchanges });
}

test('L5: one absurd book, alone, is checked against the tickers and not drawn', async () => {
  const feed = booksFeed(['kraken'], { kraken: krakenBook(60000, 2e10) });
  feed.rows.get('kraken').ticker = { last: 77000, bid: 76999, ask: 77001, at: feed.now() };
  const t = performance.now();
  await feed.pollBooks();
  assert.ok(performance.now() - t < 1000, 'no multi-second grid');
  assert.equal(feed.depthHist.length, 0, 'nothing drawn from it');
  assert.match(feed.rows.get('kraken').bookError.message, /more than 20% from the other exchanges/);
  assert.equal(feed.depthView().warming, true);
});

test('L5: one absurd book with nothing to compare against gets a clamped grid around its mid', async () => {
  const feed = booksFeed(['kraken'], { kraken: krakenBook(60000, 2e10) });
  await feed.pollBooks();
  const snap = feed.depthHist.at(-1);
  assert.equal(snap.n, DEPTH_MAX_LEVELS);
  assert.ok(snap.p0 <= snap.mid && snap.mid <= snap.p0 + snap.n * 50, 'the mid is on the grid');
  assert.equal(snap.ex.kraken.bids.length, DEPTH_MAX_LEVELS);
});

test('L5: among several books the outlier is dropped and the rest are drawn as before', async () => {
  const feed = booksFeed(['kraken', 'bitfinex', 'coinbase'], {
    kraken: krakenBook(77000, 77100),
    bitfinex: bitfinexBook(77010, 77090),
    coinbase: coinbaseBook(100000, 100100),             // 30% off
  });
  await feed.pollBooks();
  const snap = feed.depthHist.at(-1);
  assert.deepEqual(Object.keys(snap.ex).sort(), ['bitfinex', 'kraken']);
  assert.equal(snap.mid, 77050);
  assert.equal(snap.n, Math.ceil((77050 * 0.24) / 50) + 1, 'the usual grid, unclamped');
  assert.match(feed.rows.get('coinbase').bookError.message, /book not drawn/);
  assert.equal(feed.rows.get('kraken').bookError, null);
  const v = feed.depthView();
  assert.ok(v.exchanges.find((e) => e.id === 'coinbase').error);
});

test('L5: get() refuses redirects and caps the body it reads', async () => {
  const inits = [];
  const feed = new MarketFeed({}, { fetchImpl: async (url, init) => { inits.push(init); return reply({ a: 1 }); } });
  assert.deepEqual(await feed.get('https://example.invalid/'), { a: 1 });
  assert.equal(inits[0].redirect, 'error');
  assert.ok(inits[0].signal, 'the timeout is still there');

  const big = 6 * 1024 * 1024;
  const server = http.createServer((req, res) => {
    if (req.url === '/small') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/small' }); res.end(); return; }
    if (req.url === '/declared') { res.writeHead(200, { 'content-length': String(big) }); res.end(); return; }
    // chunked, no length: 6 MB of a JSON string, streamed
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('"');
    const chunk = 'x'.repeat(64 * 1024);
    let sent = 0;
    const pump = () => {
      while (sent < big) { sent += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } }
      res.end('"');
    };
    res.on('error', () => {});
    pump();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const real = new MarketFeed({}, {});
    assert.deepEqual(await real.get(`${base}/small`), { ok: true });
    await assert.rejects(real.get(`${base}/redirect`), 'a redirect is an error, not a new host');
    await assert.rejects(real.get(`${base}/declared`), /over the \d+-byte limit/);
    await assert.rejects(real.get(`${base}/stream`), /over the \d+-byte limit/);
    const small = new MarketFeed({ maxBodyBytes: 8 }, {});
    await assert.rejects(small.get(`${base}/small`), /over the 8-byte limit/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(await readJsonCapped(reply([1, 2])), [1, 2], 'a stub with no stream still reads');
});

// ---------------------------------------------------------------- L6

const LEG_DOWN = '2026-09-16 10:00:00.000 [mux:9] next peer 192.0.2.44:8333 unreachable: connect: Operation now in progress (leg stays down)';

test('L6: the legDown rule still decodes the real line', () => {
  const e = parseLine(LEG_DOWN);
  assert.equal(e.rule, 'legDown');
  assert.equal(e.leg, 9);
  assert.equal(e.addr, '192.0.2.44:8333');
  assert.equal(e.reason, 'connect: Operation now in progress');
  assert.equal(parseLine('[mux:2] next peer 198.51.100.7:8333 unreachable:    timed out    (leg stays down)').reason, 'timed out');
});

test('L6: a 20,000-space line through parseLine finishes well under 100 ms', () => {
  const S = ' '.repeat(20_000);
  const lines = {
    legDown: '[mux:1] next peer 203.0.113.9:8333 unreachable: ' + S + 'x',
    legDownEnd: '[mux:1] next peer 203.0.113.9:8333 unreachable: x' + S + '(leg stays',
    bandwidthTick: '[dlc] -- recv 1.0MB/s (avg 1.0MB/s) | write 1.0MB/s (avg 1.0MB/s) | floor' + S + 'x',
    bandwidthAvg: '[dlc] -- recv 1.0MB/s (avg' + S + 'x',
    bandwidthEvents: '[dlc] -- recv 1B/s (avg 1B/s) | write 1B/s (avg 1B/s) | floor 1 (median 2) | banned 1/2 | events' + S + 'x',
    fields: '[dlc] --' + S + 'x',
    progress: '[dlc] ==' + S + 'x',
    catchup: '[utxo_live] catchup progress: height=1/2 (1.0%) 1 blk/s (avg 1) eta 1 |' + S + 'x',
    ranking: '[dlc] ranked 116 live peer(s) by a 2000-header sample in 44.6s: 39 answered, best 94 KB/s, median 63 KB/s, slowest answering' + S,
    deadweight: '[dlc] -- dead-weight floor this tick: 32.0 KB/s (pool median 0.0 KB/s, absolute' + S,
    worker: '[dlc] w1 203.0.113.1:8333 chunks=4 blocks=160 (+0 blk/s,' + S,
    blockStored: '[block] stored height=1 hash=00 bytes=1 tx=1 (via' + S,
    rejectFilter: '[mempool] recent-rejects filter: 128' + S,
    dialFail: '[dial] 203.0.113.2:8333: background dial failed: x' + S + 'x',
    topUp: '[dl] outbound top-up: 3 dial(s) failed, first 203.0.113.3:8333: x' + S + 'x',
    digits: '[dlc] -- network recv this tick: ' + '0'.repeat(20_000) + 'x',
    bars: '[utxo_live] catchup progress: height=1/2 (1.0%) 1 blk/s (avg 1) eta ' + '|'.repeat(20_000),
  };
  for (const [name, line] of Object.entries(lines)) {
    const t = performance.now();
    const e = parseLine(line);
    const ms = performance.now() - t;
    assert.ok(ms < 100, `${name}: ${ms.toFixed(1)} ms`);
    assert.equal(e.truncated, line.length - MAX_LINE, `${name}: the cut is reported`);
  }
});

test('L6: lines are cut at MAX_LINE before matching; short lines carry no truncated field', () => {
  assert.equal(parseLine(LEG_DOWN).truncated, undefined);
  const long = '2026-09-16 10:00:00.000 [net] ' + 'y'.repeat(MAX_LINE * 2);
  const e = parseLine(long);
  assert.equal(e.kind, 'raw');
  assert.ok(e.text.length < MAX_LINE);
  assert.equal(e.truncated, long.length - MAX_LINE);
});

test('L6: splitLines keeps at most MAX_LINE of an unterminated line and counts the rest', () => {
  const state = { carry: '' };
  assert.deepEqual(splitLines('2026-09-16 10:00:00.000 [net] start ', state), []);
  for (let i = 0; i < 20; i++) splitLines('z'.repeat(64 * 1024), state);
  assert.equal(state.carry.length, MAX_LINE, 'bounded, however long the line runs');
  assert.ok(state.carry.startsWith('2026-09-16 10:00:00.000 [net] start'), 'the front of the line is what is kept');
  assert.equal(state.carryDropped, '2026-09-16 10:00:00.000 [net] start '.length + 20 * 64 * 1024 - MAX_LINE);
  const out = splitLines('tail\n' + LEG_DOWN + '\n', state);
  assert.equal(out.length, 2);
  assert.equal(out[0].tag, 'net');
  assert.equal(out[1].rule, 'legDown');
  assert.equal(state.carry, '');
});
