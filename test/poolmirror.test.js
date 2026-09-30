// THE POOL, PUSHED (2026-09-30; operator: "How do we get more granularity, like mempool does over
// websocket, pushing changes" -- "go ahead, bmc first"). Three layers, each held here:
//   zmq.js         the ZMTP 3.0 SUB socket: framing, the `sequence` body, and a real socket against a
//                  publisher written the way libzmq speaks
//   poolmirror.js  the kept map: loading, notifications, blocks, gaps, the ids poll
//   monitor.js     end to end against the fake node: the pool picture follows the pool between full reads
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrames, parseSequence, readyCommand, subscribeFrame, subscribe } from '../server/collect/zmq.js';
import { PoolMirror, idsOf, ADDS_PER_TICK } from '../server/collect/poolmirror.js';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';
import { startFakeNode } from '../scripts/fake-node.js';

const H = (c) => c.repeat(64 / c.length);
const seqBody = (hash, label, mempoolSeq = null) => {
  const b = Buffer.alloc(mempoolSeq == null ? 33 : 41);
  Buffer.from(hash, 'hex').copy(b, 0);
  b[32] = label.charCodeAt(0);
  if (mempoolSeq != null) b.writeBigUInt64LE(BigInt(mempoolSeq), 33);
  return b;
};
const frameOf = (body, more = false, command = false) => {
  const long = body.length > 255;
  const head = Buffer.alloc(long ? 9 : 2);
  head[0] = (more ? 1 : 0) | (long ? 2 : 0) | (command ? 4 : 0);
  if (long) head.writeBigUInt64BE(BigInt(body.length), 1); else head[1] = body.length;
  return Buffer.concat([head, body]);
};

// ---- zmq.js ----

test('frames: short and long, MORE and COMMAND flags, a partial frame carried over', () => {
  const big = Buffer.alloc(300, 7);
  const bytes = Buffer.concat([frameOf(Buffer.from('seq'), true), frameOf(big), frameOf(Buffer.from('READY'), false, true)]);
  const { frames, rest } = parseFrames(bytes);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => [f.more, f.command, f.body.length]), [[true, false, 3], [false, false, 300], [false, true, 5]]);
  assert.equal(rest.length, 0);
  const cut = parseFrames(bytes.subarray(0, 10));
  assert.equal(cut.frames.length, 1, 'the whole first frame');
  assert.equal(cut.rest.length, 10 - 5, 'and the start of the long one, kept for the next chunk');
});

test('the sequence body: hash as RPC prints it, label, and the mempool sequence on A and R', () => {
  assert.deepEqual(parseSequence(seqBody(H('ab'), 'A', 73777)), { hash: H('ab'), label: 'A', mempoolSeq: 73777 });
  assert.deepEqual(parseSequence(seqBody(H('cd'), 'R', 5)), { hash: H('cd'), label: 'R', mempoolSeq: 5 });
  assert.deepEqual(parseSequence(seqBody(H('ef'), 'C')), { hash: H('ef'), label: 'C', mempoolSeq: null });
  assert.equal(parseSequence(Buffer.alloc(10)), null);
  const bad = seqBody(H('01'), 'A', 1); bad[32] = 'X'.charCodeAt(0);
  assert.equal(parseSequence(bad), null);
});

test('the handshake a SUB socket sends: READY with Socket-Type SUB, then 0x01 + topic', () => {
  const r = parseFrames(readyCommand('SUB')).frames[0];
  assert.equal(r.command, true);
  assert.equal(r.body.subarray(1, 6).toString(), 'READY');
  assert.match(r.body.toString('latin1'), /Socket-Type\0\0\0\x03SUB$/);
  const s = parseFrames(subscribeFrame('sequence')).frames[0];
  assert.equal(s.body[0], 1);
  assert.equal(s.body.subarray(1).toString(), 'sequence');
});

// a publisher that speaks as libzmq does: 3.1 greeting, READY as PUB, then three-frame notifications
function fakePublisher() {
  const conns = [];
  const got = [];
  const server = net.createServer((c) => {
    conns.push(c);
    const g = Buffer.alloc(64); g[0] = 0xff; g[9] = 0x7f; g[10] = 3; g[11] = 1; g.write('NULL', 12);
    c.write(g);
    const k = Buffer.from('Socket-Type'), v = Buffer.from('PUB'), vl = Buffer.alloc(4); vl.writeUInt32BE(3);
    c.write(frameOf(Buffer.concat([Buffer.from([5]), Buffer.from('READY'), Buffer.from([k.length]), k, vl, v]), false, true));
    let buf = Buffer.alloc(0), greeted = false;
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!greeted) { if (buf.length < 64) return; greeted = true; got.push({ greeting: buf.subarray(0, 64) }); buf = buf.subarray(64); }
      const { frames, rest } = parseFrames(buf); buf = Buffer.from(rest);
      for (const f of frames) got.push(f);
    });
    c.on('error', () => {});
  });
  let counter = 0;
  return {
    got, conns,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    send(body, { skip = 0 } = {}) {
      counter += 1 + skip;
      const n = Buffer.alloc(4); n.writeUInt32LE(counter);
      for (const c of conns) if (!c.destroyed) c.write(Buffer.concat([frameOf(Buffer.from('sequence'), true), frameOf(body, true), frameOf(n)]));
    },
    close: () => { for (const c of conns) c.destroy(); server.close(); },
  };
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

test('a real socket: handshake, subscription, notifications with their counter, and a reconnect', async () => {
  const pub = fakePublisher();
  const port = await pub.listen();
  const msgs = [], states = [];
  const sub = subscribe(`tcp://127.0.0.1:${port}`, ['sequence'], { onMessage: (t, b, s) => msgs.push([t, parseSequence(b), s]), onState: (s) => states.push(s.up), minDelay: 50 });
  try {
    await until(() => states.includes(true));
    await until(() => pub.got.some((f) => f.body && f.body[0] === 1));
    const g = pub.got[0].greeting;
    assert.equal(g[10], 3, 'announced ZMTP 3');
    assert.equal(g.subarray(12, 16).toString(), 'NULL');
    const subFrame = pub.got.find((f) => f.body && !f.command && f.body[0] === 1);
    assert.equal(subFrame.body.subarray(1).toString(), 'sequence', 'subscribed to the topic');
    pub.send(seqBody(H('aa'), 'A', 10));
    pub.send(seqBody(H('bb'), 'R', 11));
    await until(() => msgs.length === 2);
    assert.deepEqual(msgs.map(([t, e, s]) => [t, e.label, e.hash.slice(0, 2), s]), [['sequence', 'A', 'aa', 1], ['sequence', 'R', 'bb', 2]]);
    // the publisher goes away and comes back on the same port: the socket says so and reconnects
    for (const c of pub.conns) c.destroy();
    await until(() => states.includes(false));
    await until(() => states.filter((u) => u).length >= 2);
  } finally { sub.close(); pub.close(); }
});

// ---- poolmirror.js ----

function fakeRpc(pool, { blocks = {}, seq = { n: 100 } } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push(method);
      if (method === 'getrawmempool') return { txids: Object.keys(pool), mempool_sequence: seq.n };
      if (method === 'getblock') return { tx: blocks[params[0]] ?? [] };
      throw new Error(`unexpected ${method}`);
    },
    async batch(list) {
      calls.push(...list.map((c) => c.method));
      return list.map((c) => (pool[c.params[0]] ? { ok: true, result: pool[c.params[0]] } : { ok: false, error: { code: -5 } }));
    },
  };
}
const entry = (vsize) => ({ vsize, weight: vsize * 4, time: 1790000000, fees: { base: vsize * 1e-8 } });

test('idsOf: the sequence form, the plain list from a node that ignores it, and nothing else', () => {
  assert.deepEqual(idsOf({ txids: ['a'], mempool_sequence: 9 }), { ids: ['a'], sequence: 9 });
  assert.deepEqual(idsOf(['a', 'b']), { ids: ['a', 'b'], sequence: null });
  assert.deepEqual(idsOf(null), { ids: null, sequence: null }, 'never an empty list: that would empty the map');
  assert.deepEqual(idsOf({ foo: 1 }), { ids: null, sequence: null });
});

test('load: the full read reconciled with the ids read after it; notifications from S on applied', async () => {
  const pool = { [H('01')]: entry(100), [H('02')]: entry(200), [H('03')]: entry(300) };
  const m = new PoolMirror({ rpc: fakeRpc(pool), mode: 'zmq' });
  // notifications that arrive while the full read runs are buffered
  m.onSequence({ hash: H('09'), label: 'A', mempoolSeq: 49 }, 1);   // before S: in the snapshot already
  m.onSequence({ hash: H('03'), label: 'R', mempoolSeq: 50 }, 2);   // from S on: applied
  assert.equal(m.synced, false);
  // the full read had 01 and 02 and a stale 08; the ids read says 01, 02, 03
  const raw = { [H('01')]: entry(100), [H('02')]: entry(200), [H('08')]: entry(800) };
  m.load(raw, [H('01'), H('02'), H('03')], 50);
  assert.equal(m.synced, true);
  assert.ok(!(H('08') in m.raw), 'gone from the node: dropped');
  assert.ok(!m.pendingAdds.has(H('03')), 'in the ids but removed by a notification after S');
  assert.ok(!m.pendingAdds.has(H('09')), 'a notification before S is already in the snapshot');
  assert.deepEqual(Object.keys(m.raw).sort(), [H('01'), H('02')]);
});

test('notifications: an add is fetched on the next tick, a removal is immediate, one removed mid-fetch stays out', async () => {
  const pool = { [H('01')]: entry(100), [H('02')]: entry(200) };
  const rpc = fakeRpc(pool);
  const m = new PoolMirror({ rpc, mode: 'zmq' });
  m.load({ [H('01')]: entry(100) }, [H('01')], 10);
  await m.tick();
  m.onSequence({ hash: H('02'), label: 'A', mempoolSeq: 10 }, 1);
  assert.ok(!(H('02') in m.raw), 'not until its entry is fetched');
  const r = await m.tick();
  assert.equal(r.changed, true);
  assert.deepEqual(m.raw[H('02')], entry(200));
  m.onSequence({ hash: H('01'), label: 'R', mempoolSeq: 11 }, 2);
  assert.ok(!(H('01') in m.raw));
  assert.equal((await m.tick()).changed, true, 'a removal is a change');
  assert.equal((await m.tick()).changed, false, 'and then nothing is');
  // added, then removed before its entry comes back: not added
  pool[H('03')] = entry(300);
  m.onSequence({ hash: H('03'), label: 'A', mempoolSeq: 12 }, 3);
  const slow = rpc.batch;
  rpc.batch = async (list) => { m.onSequence({ hash: H('03'), label: 'R', mempoolSeq: 13 }, 4); return slow(list); };
  await m.tick();
  assert.ok(!(H('03') in m.raw), 'removed while the batch was out');
  // an entry that is gone by the time it is asked for is not an error
  m.onSequence({ hash: H('04'), label: 'A', mempoolSeq: 14 }, 5);
  rpc.batch = slow;
  await m.tick();
  assert.ok(!(H('04') in m.raw));
  assert.equal(m.stats.gone, 1);
});

test('a connected block takes its transactions out, published or not; a disconnected one asks for a full read', async () => {
  const blocks = { [H('bb')]: [H('01'), H('0c')] };
  const m = new PoolMirror({ rpc: fakeRpc({}, { blocks }), mode: 'zmq' });
  m.load({ [H('01')]: entry(1), [H('02')]: entry(2) }, [H('01'), H('02')], 5);
  m.onSequence({ hash: H('bb'), label: 'C', mempoolSeq: null }, 1);
  await m.tick();
  assert.deepEqual(Object.keys(m.raw), [H('02')]);
  m.onSequence({ hash: H('bb'), label: 'D', mempoolSeq: null }, 2);
  assert.equal(m.needResync, true);
  assert.equal((await m.tick()).resync, true);
});

test('a lost notification (the ZMQ counter skips) or a dropped socket asks for a full read', () => {
  const m = new PoolMirror({ rpc: fakeRpc({}), mode: 'zmq' });
  m.load({}, [], 1);
  m.onSequence({ hash: H('01'), label: 'A', mempoolSeq: 1 }, 7);
  m.onSequence({ hash: H('02'), label: 'A', mempoolSeq: 2 }, 8);
  assert.equal(m.needResync, false);
  m.onSequence({ hash: H('03'), label: 'A', mempoolSeq: 3 }, 10);
  assert.equal(m.needResync, true);
  assert.match(m.stats.lastReason, /lost/);
  m.load({}, [], 4);
  m.onDisconnected();
  assert.equal(m.needResync, true);
  // the counter wraps at 2^32 without calling it a gap
  const w = new PoolMirror({ rpc: fakeRpc({}), mode: 'zmq' });
  w.load({}, [], 1);
  w.onSequence({ hash: H('01'), label: 'A', mempoolSeq: 1 }, 0xffffffff);
  w.onSequence({ hash: H('02'), label: 'A', mempoolSeq: 2 }, 0);
  assert.equal(w.needResync, false);
});

test('the ids poll: nothing when the sequence has not moved; otherwise the difference, fetched', async () => {
  const pool = { [H('01')]: entry(1), [H('02')]: entry(2) };
  const seq = { n: 7 };
  const rpc = fakeRpc(pool, { seq });
  const m = new PoolMirror({ rpc, mode: 'poll' });
  m.load({ [H('01')]: entry(1), [H('02')]: entry(2) }, [H('01'), H('02')], 7);
  await m.tick();                       // (the load itself is a change: the pictures are made from it)
  rpc.calls.length = 0;
  assert.equal((await m.tick()).changed, false);
  assert.deepEqual(rpc.calls, ['getrawmempool'], 'one cheap call, and the entries are not asked for');
  delete pool[H('01')]; pool[H('03')] = entry(3); seq.n = 9;
  assert.equal((await m.tick()).changed, true);
  assert.deepEqual(Object.keys(m.raw).sort(), [H('02'), H('03')]);
});

test('too many new transactions at once: a full read is cheaper than fetching them', async () => {
  const m = new PoolMirror({ rpc: fakeRpc({}), mode: 'zmq' });
  m.load({}, [], 1);
  for (let i = 0; i <= ADDS_PER_TICK; i++) m.onSequence({ hash: i.toString(16).padStart(64, '0'), label: 'A', mempoolSeq: i + 1 }, i + 1);
  assert.equal((await m.tick()).resync, true);
});

// ---- end to end: the monitor against the fake node ----

test('the monitor: the pool picture follows the node between full reads, every poolPushMs', async () => {
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const fake = await startFakeNode({ port, ibd: false });
  clearInterval(fake.timer);            // the pool changes only when this test changes it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-poolpush-'));
  const cookie = path.join(dir, '.cookie');
  fs.writeFileSync(cookie, `${fake.authUser}:${fake.authPass}`);
  const store = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  const mon = new NodeMonitor(
    { id: 'p', label: 'p', rpcUrl: `http://127.0.0.1:${port}`, cookieFile: cookie, datadir: dir, chainHint: 'main' },
    { rpc: { maxInFlight: 4, minIntervalMs: 0, timeoutMs: 5000, slowLatencyMs: 5000 },
      poll: { fastMs: 60000, midMs: 60000, poolMs: 60000, slowMs: 600000, rareMs: 900000, poolPushMs: 1000, poolResyncMs: 600000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {} });
  try {
    await mon.startPoolPush();
    assert.equal(mon.poolMirror.mode, 'poll', 'the fake node publishes no ZMQ: it polls for changes');
    await mon.runTier('pool');
    assert.equal(mon.poolMirror.synced, true);
    const first = mon.state.mempoolDist;
    const unique = () => new Set(fake.mempool.map((t) => t.txid)).size;   // (the fake node's seed can repeat a txid; a node cannot)
    assert.equal(first.count, unique());
    assert.equal(first.source, 'poll');
    // the node's pool changes; the next push tick follows it without a full read
    const gone = fake.mempool.splice(0, 5).map((t) => t.txid);
    fake.mempool.push({ txid: H('7a'), vsize: 250, feeBtc: 0.0005, time: Math.floor(Date.now() / 1000) });
    fake.mempoolSeq += 1;
    await mon.poolPushTick();
    const next = mon.state.mempoolDist;
    assert.notEqual(next, first);
    assert.equal(next.count, unique());
    assert.ok(next.at >= first.at);
    assert.ok(H('7a') in mon.mempoolRaw && !gone.some((t) => t in mon.mempoolRaw));
    assert.equal(mon.effectiveTierMs('pool') >= 600000, true, 'while the map is kept, the full read is only a check');
    const snap = mon.snapshot({});
    assert.deepEqual(snap.mempool.push, { mode: 'poll', everyMs: 1000 });
    assert.equal(snap.mempool.dist.at, next.at, 'the frame carries the fresh picture');
  } finally { await mon.stop(); await fake.stop?.(); }
});

test('mempoolPush off: no mirror, the full read every poolMs as before', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-poolpush-'));
  const store = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  const mon = new NodeMonitor(
    { id: 'q', label: 'q', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', mempoolPush: 'off' },
    { rpc: { maxInFlight: 1, minIntervalMs: 0, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, poolMs: 20000, slowMs: 60000, rareMs: 900000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {} });
  await mon.startPoolPush();
  assert.equal(mon.poolMirror, null);
  assert.equal(mon.effectiveTierMs('pool'), 20000);
  await mon.stop();
});
