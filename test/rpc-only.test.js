// RPC-only mode (log.enabled = false). Turning the log off is not a neutral
// switch: measured 2026-09-08, the build deployed to production answers
// getnettotals 0/0 and getpeerinfo [] while getconnectioncount says 16, and the
// build then running the bench node answered 2,116,236,872 bytes with 21 named
// peers. Both report subversion /BitcoinMachineCode:0.0.1/. So the mode has to
// announce what it lost, and the flags have to describe the two different failure
// shapes (no rows at all, versus rows that do not add up).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';
import { loadConfig } from '../server/config.js';
import { classifyMethod } from '../server/rpc/allowlist.js';
import { routes, netView } from '../server/http/api.js';

function makeMonitor({ logFile = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcmon-rpconly-'));
  const store = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  return new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {} });
}

test('BMC_MON_LOG_SOURCE=0 turns the log source off in config', () => {
  process.env.BMC_MON_LOG_SOURCE = '0';
  try {
    const cfg = loadConfig({ configFile: '/nonexistent-local.json' });
    assert.equal(cfg.log.enabled, false);
  } finally { delete process.env.BMC_MON_LOG_SOURCE; }
  const dflt = loadConfig({ configFile: '/nonexistent-local.json' });
  // The posture flipped on 2026-09-09: the UI reads RPC only, so the default is OFF.
  // Tailing a file the node rewrites between releases is a grammar dependency that has
  // already produced two silent-outage incidents, and every panel that needed it has
  // been removed rather than left showing dashes. BMC_MON_LOG_SOURCE=1 still turns it on.
  assert.equal(dflt.log.enabled, false, 'RPC only by default');
  process.env.BMC_MON_LOG_SOURCE = '1';
  try {
    assert.equal(loadConfig({ configFile: '/nonexistent-local.json' }).log.enabled, true, 'still switchable for parser work');
  } finally { delete process.env.BMC_MON_LOG_SOURCE; }
});

test('a monitor with no logFile has no tail and says which figures lose their source', async () => {
  const m = makeMonitor({ logFile: null });
  assert.equal(m.logEnabled, false);
  assert.equal(m.tail, null, 'RPC-only mode must not open a log file at all');
  const q = m.quality.find((x) => x.key === 'log-source-disabled');
  assert.ok(q, 'the mode has to be stated, not inferred from empty panels');
  for (const what of ['served a block', 'disk-write rate', 'banned-peer count', 'own ETA', 'sync_failing']) {
    assert.match(q.text, new RegExp(what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the flag must name ${what}`);
  }
  assert.equal(m.snapshot({}).log.source, 'disabled', "the UI distinguishes 'disabled' from 'missing'");
  await m.stop();
});

test('a monitor with a logFile does not claim the mode is on', async () => {
  const file = path.join(fs.mkdtempSync('/tmp/bmcmon-log-'), 'bitcoin.main.log');
  fs.writeFileSync(file, '2026-09-08 05:45:47.799 [dlc] -- recv 81.2MB/s (avg 108.7MB/s) | write 62.8MB/s (avg 80.4MB/s) | floor 32.0 KB/s (median 5.1) | banned 8/114 | staged 1 --\n');
  const m = makeMonitor({ logFile: file });
  assert.equal(m.logEnabled, true);
  assert.ok(m.tail);
  await m.start();
  assert.equal(m.quality.find((x) => x.key === 'log-source-disabled'), undefined);
  await m.stop();
});

test('getpeerinfo moving to the mid tier is conditional on the mode', async () => {
  // The mid tier's call list is positional, so assert the append on the real
  // batch call rather than trusting a read of the code: getpeerinfo must be in
  // the list when the log is off, absent when it is on.
  const off = makeMonitor({ logFile: null });
  const on = makeMonitor({ logFile: '/tmp/definitely-not-really.log' });
  const callsFor = async (mon) => {
    const seen = [];
    mon.rpc.batch = async (calls) => {
      seen.push(...calls.map((c) => c.method));
      return calls.map(() => ({ ok: false, error: { message: 'stub' } }));
    };
    await mon.tier_mid();
    return seen;
  };
  const offCalls = await callsFor(off);
  const onCalls = await callsFor(on);
  assert.equal(offCalls.filter((x) => x === 'getpeerinfo').length, 1, 'RPC-only mode must poll the peer table itself');
  assert.equal(offCalls[offCalls.length - 1], 'getpeerinfo', 'appended last, so the positional unwrapping above still lines up');
  assert.equal(onCalls.includes('getpeerinfo'), false, 'with the log on, peerinfo stays on the rare tier');
  await off.stop(); await on.stop();
});

test('empty peer rows and partial peer rows are different flags', () => {
  const m = makeMonitor({ logFile: null });
  m.state.peers.connections = 16;
  m.state.net.totalRecv = 2_116_236_872;

  // Shape 1: the deployed production build. [] with 16 connections.
  m.absorbPeerInfo([]);
  const empty = m.quality.find((x) => x.key === 'peerinfo-empty');
  assert.ok(empty, '[] with connections>0 is a publish gap, not an idle node');
  assert.match(empty.text, /unavailable in RPC-only mode/);
  assert.equal(m.quality.find((x) => x.key === 'peerinfo-partial'), undefined);

  // Shape 2: the 03:02 bench build. 21 rows, but summing to 70.29% of the total.
  const rows = [{ addr: '88.198.52.249:8333', bytesrecv: 201_608_074 }, { addr: '103.47.203.40:8333', bytesrecv: 191_737_917 }];
  let sum = 0;
  const many = [];
  for (let i = 0; i < 21; i++) { const b = i === 0 ? 1_487_577_968 : 0; many.push({ addr: `p${i}:8333`, bytesrecv: b }); sum += b; }
  m.absorbPeerInfo(many);
  assert.equal(m.state.peers.byteCoverage, 0.7029, 'measured: 1,487,577,978 of 2,116,236,872');
  const partial = m.quality.find((x) => x.key === 'peerinfo-partial');
  assert.ok(partial, 'rows that do not add up must be labelled a subset');
  assert.match(partial.text, /70\.3% of what getnettotals reports/);
  assert.equal(m.quality.find((x) => x.key === 'peerinfo-empty'), undefined, 'the empty flag must clear once rows exist');

  // And a table that does add up warns about nothing.
  m.state.net.totalRecv = sum;
  m.absorbPeerInfo(many);
  assert.equal(m.quality.find((x) => x.key === 'peerinfo-partial'), undefined);
  void rows;
});

test('the new RPC sources are allowed reads, not holes', () => {
  for (const m of ['getaddrmaninfo', 'listbanned', 'getchainstates', 'uptime']) {
    assert.equal(classifyMethod(m).allowed, true, `${m} must be callable`);
  }
  // The neighbours that must stay shut: ban mutation and the log switch.
  for (const m of ['setban', 'clearbanned', 'logging', 'addnode']) {
    assert.equal(classifyMethod(m).allowed, false, `${m} must stay denied`);
  }
});

test("the node's own bmc* commands are admitted by read verb, not by the bmc marker alone", () => {
  // 2026-09-10: this node prefaces every command of its own with bmc*. Its
  // first one, bmcgetdownloadinfo, was DENIED here because "bmc..." matched no
  // read-shaped prefix. Admitting a bare "bmc" would have been the hole this
  // file's header warns about, so the rule is the marker PLUS a read verb.
  for (const m of ['bmcgetdownloadinfo', 'bmclistsomething', 'bmcestimatesomething']) {
    assert.equal(classifyMethod(m).allowed, true, `${m} is read-shaped and must be callable`);
  }
  // A bare bmc prefix would have let all of these through. They must not pass.
  for (const m of ['bmcsetban', 'bmcimportmempool', 'bmcsendrawtransaction', 'bmcloadtxoutset', 'bmcgeneratetoaddress', 'bmcsignrawtransaction']) {
    assert.equal(classifyMethod(m).allowed, false, `${m} mutates and must stay denied`);
  }
  // ...and an unrecognised bmc shape is denied by default, not allowed.
  assert.equal(classifyMethod('bmcfrobnicate').allowed, false, 'an unknown bmc* shape must be denied by default');
});

test('a build that counts nothing yields an absent rate, never 0 B/s', async () => {
  // Rule 3, on the exact path RPC-only mode now depends on: getnettotals answers
  // 0/0 forever on the deployed build while the same node moved 11 MB/s. A rate
  // computed from two zeros would render as a confident "0 B/s".
  const m = makeMonitor({ logFile: null });
  const totals = [{ totalbytesrecv: 0, totalbytessent: 0, timemillis: 1, uploadtarget: { target: 0 } }];
  m.callList = async () => new Map([
    ['getblockchaininfo', { blocks: 1, headers: 1, verificationprogress: 0, chain: 'main' }],
    ['getmempoolinfo', { size: 0 }],
    ['getconnectioncount', 16],
    ['getnettotals', totals[0]],
    ['uptime', 100],
  ]);
  await m.tier_fast();
  await m.tier_fast();
  assert.equal(m.state.net.inBps, null, 'two zero samples must not become a 0 B/s reading');
  assert.equal(m.state.net.outBps, null);
  const q = m.quality.find((x) => x.key === 'nettotals-zero');
  assert.ok(q);
  assert.match(q.text, /has no source at all in RPC-only mode/, 'with no log there is no "instead" to point at');

  // And a build that does count them gets a real rate.
  let n = 0;
  m.callList = async () => new Map([
    ['getblockchaininfo', { blocks: 2, headers: 2, verificationprogress: 0, chain: 'main' }],
    ['getmempoolinfo', { size: 0 }],
    ['getconnectioncount', 16],
    ['getnettotals', { totalbytesrecv: 1_000_000 + (++n) * 5_000_000, totalbytessent: 1000, timemillis: 2, uploadtarget: { target: 0 } }],
    ['uptime', 100],
  ]);
  await m.tier_fast();
  await new Promise((r) => setTimeout(r, 20));
  await m.tier_fast();
  assert.ok(m.state.net.inBps > 0, `expected a positive rate, got ${m.state.net.inBps}`);
  assert.equal(m.quality.find((x) => x.key === 'nettotals-zero'), undefined, 'the flag must clear once the counters move');
});

test('an impossible in/out ratio withholds the upload rate instead of publishing 0 B/s', async () => {
  // Measured on the bench build in RPC-only mode: 12,896,531,244 in against 1,129
  // B out with 21 peers connected. That ratio is not a fact about traffic, it is a
  // fact about a counter that misses the download worker.
  const m = makeMonitor({ logFile: null });
  m.state.peers.connections = 21;
  let recv = 12_896_531_244;
  m.callList = async () => new Map([
    ['getblockchaininfo', { blocks: 2, headers: 2, verificationprogress: 0, chain: 'main' }],
    ['getmempoolinfo', { size: 0 }],
    ['getconnectioncount', 21],
    ['getnettotals', { totalbytesrecv: (recv += 5_000_000), totalbytessent: 1129, timemillis: 2, uploadtarget: { target: 0 } }],
    ['uptime', 100],
  ]);
  await m.tier_fast();
  await new Promise((r) => setTimeout(r, 20));
  await m.tier_fast();
  assert.ok(m.state.net.inBps > 0, 'the down rate is real on this build and must still be shown');
  assert.equal(m.state.net.outBps, null, 'the up rate must be withheld, not 0');
  const q = m.quality.find((x) => x.key === 'upload-unmeasurable');
  assert.ok(q);
  assert.match(q.text, /impossible ratio/);
  assert.equal(m.snapshot({}).net.uploadMeasured, false, 'the UI gate on showing any upload figure');
});

test('the provenance table answers per mode, and never claims a log source in RPC-only mode', () => {
  const cfgRoute = routes.find((r) => r.path === '/api/config');
  const appOf = (logEnabled) => {
    const cfg = loadConfig({ configFile: '/nonexistent-local.json' });
    cfg.log.enabled = logEnabled;
    return { cfg, monitors: new Map(), auth: { sessionTtlMs: 1 } };
  };
  const both = [true, false].map((on) => cfgRoute.handler({ user: {}, query: new URLSearchParams(), ip: 'x' }, appOf(on)).sources);
  const [withLog, rpcOnly] = both;
  const bw = (list) => list.find((x) => x.panel === 'bandwidth');
  assert.match(bw(withLog).source, /node log/);
  assert.match(bw(rpcOnly).source, /getnettotals/);
  // The point of the whole table: in RPC-only mode no row may name the log as if
  // it were still feeding a panel, and every panel that lost its source has to say
  // so in words a reader can act on.
  assert.equal(rpcOnly.some((x) => /node log/.test(x.source)), false, 'no row may name a log source while the log is off');
  assert.ok(rpcOnly.filter((x) => /none \(RPC-only mode\)/.test(x.source)).length >= 4,
    'disk write, ingest/rejects, the node\'s own eta and validation stalls must be named as sourceless');
  assert.ok(rpcOnly.every((x) => x.panel && x.source && x.note), 'every row keeps all three fields');
});

test('a flat-zero getnettotals total is reported as unmeasured, never as 0 B/s', async () => {
  // The deployed build answers totalbytesrecv 0 for its whole uptime (the counters live
  // in the forked download worker) while the same node's log moved ~47 GB. Rendering
  // that as 0 B/s draws a chart that says "idle node" — a claim about the network, not
  // an absence. Rule 3: withhold, in words. Symmetric with the upload side, which has
  // carried uploadMeasured for a while; the download side was still printing a zero.
  const m = makeMonitor({ logFile: null });
  Object.assign(m.state.net, { totalRecv: 0, totalSent: 0, inBps: 0, outBps: 0, uploadtarget: null });
  const s = m.snapshot({});
  assert.equal(s.net.inBps, null, 'an uncounted download must be absent, not zero');
  assert.equal(s.net.downloadMeasured, false);
  assert.equal(s.net.uploadMeasured, false);
  assert.match(s.peers.throughputSource, /log source is off/,
    'per-peer throughput must not name a source the process refused to open');
  await m.stop();
});

test('a real byte counter still measures, so the guard does not swallow data', async () => {
  // The other half of the rule: the withholding above must not become a way to hide
  // numbers that exist. Measured on the 03:02 bench build: getnettotals answered
  // 2,116,236,872 bytes, so the rate is real and has to reach the chart.
  const m = makeMonitor({ logFile: null });
  Object.assign(m.state.net, { totalRecv: 2_116_236_872, totalSent: 40_000_000, inBps: 11.56e6, outBps: 2e5, uploadtarget: null });
  const s = m.snapshot({});
  assert.equal(s.net.inBps, 11.56e6);
  assert.equal(s.net.downloadMeasured, true);
  assert.equal(s.net.uploadMeasured, true);
  await m.stop();
});

test('netView names the mode it is in and grows its gap list as sources close', async () => {
  const snap = (over = {}) => ({
    net: {
      totalRecvRpc: 0, totalSentRpc: 0, inBps: null, outBps: null, uploadtarget: null,
      downloadMeasured: false, uploadMeasured: false, diskWriteBps: null, netTotalLog: null,
      diskTotal: null, avgRecv: null, avgWrite: null, floor: null, poolMedian: null,
    },
    peers: { connections: 13, in: 0, out: 13, wanted: null },
    series: { net: {} },
    ...over,
  });
  const off = netView({ id: 't', logEnabled: false, snapshot: () => snap() });
  assert.ok(!/node log/.test(off.measured.source), 'provenance cannot name a closed source');
  assert.match(off.measured.source, /getnettotals/);
  const gaps = off.unavailable.join(' | ');
  assert.match(gaps, /inbound bytes/i, 'the download gap has to be named, not just the upload one');
  assert.match(gaps, /log-only figures/i, 'RPC-only mode loses a dozen figures at once');
  assert.match(gaps, /sync_failing/, 'the list has to name the figures, not the mode');

  const on = netView({
    id: 't', logEnabled: true,
    snapshot: () => snap({ net: { ...snap().net, inBps: 11.56e6, netTotalLog: 47e9, downloadMeasured: true, uploadMeasured: true } }),
  });
  assert.match(on.measured.source, /node log \[dlc\] tick lines/);
  assert.deepEqual(on.unavailable, [], 'with every source open there is nothing to apologise for');
});

test('provenance strings describe the mode and the gate, never what a build will do', () => {
  // Written after the row it replaces: /api/net used to say "the deployed build counts
  // 0 bytes", which was false within the hour — the same process read 0/0 at 09:36 and
  // 23,955,131 bytes received at 17:36 with no restart between (MEASUREMENTS 23). A
  // provenance line that predicts node behaviour is a rotting claim on a dashboard; the
  // honest content is the mode, plus the gate that decides whether a field is filled.
  const off = netView({
    id: 't', logEnabled: false,
    snapshot: () => ({
      net: { totalRecvRpc: 0, totalSentRpc: 0, inBps: null, outBps: null, uploadtarget: null, downloadMeasured: false, uploadMeasured: false, diskWriteBps: null, netTotalLog: null, diskTotal: null, avgRecv: null, avgWrite: null, floor: null, poolMedian: null },
      peers: { connections: 0, in: 0, out: 0, wanted: null }, series: { net: {} },
    }),
  });
  assert.match(off.measured.source, /while that counter moves/, 'names the gate, not a prophecy');
  assert.doesNotMatch(off.measured.source, /deployed build counts|0 bytes, so/, 'no assertion about what this build will answer');
});
