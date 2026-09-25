// Quality flags that outlived their cause (2026-09-24). A mainnet bmc at 93% of its sync, healthy
// and downloading at 11 MB/s, showed five warnings on the node page, none of them current:
// 48 RPC failures from a three-minute restart three hours earlier, a "tip stale" the chain had
// long since answered, an archive layout counted twice (once as a problem), and relay lines that
// stop because a node in IBD has no mempool to relay into.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLine } from '../server/collect/logparse.js';
import { NodeMonitor, RPC_FAIL_WINDOW_MS } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

const mk = ({ gates } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-quality-'));
  const logFile = path.join(dir, 'quality-fake.log');
  fs.writeFileSync(logFile, '');
  const store = { ringCapacity: 500, maxEventLog: 100, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  return new NodeMonitor({ id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 500 }, poll: {}, store, log: logger,
      history: new History(dir, store, { log: logger }), logCfg: { shapeGatesMs: gates } });
};
const flag = (m, key) => m.quality.find((q) => q.key === key);

test('rpc-timeouts counts failures in a window, and clears once they stop', () => {
  let failedCalls = 0;
  const m = {
    quality: [], log: () => {}, history: { record() {} },
    rpc: { cfg: { maxInFlight: 4 }, telemetry: () => ({ failedCalls, lastLatencyMs: 9, avgLatencyMs: 10 }) },
    flagQuality: NodeMonitor.prototype.flagQuality, clearQuality: NodeMonitor.prototype.clearQuality,
  };
  const record = () => NodeMonitor.prototype.recordRpc.call(m);
  failedCalls = 48;                 // the restart: ECONNREFUSED on every tier for three minutes
  record();
  assert.match(flag(m, 'rpc-timeouts').text, /^48 RPC attempt\(s\) failed outright in the last 10 min \(48 since/);
  record();                         // no new failures: still inside the window
  assert.ok(flag(m, 'rpc-timeouts'));
  m.rpcFails[0].at -= RPC_FAIL_WINDOW_MS + 1;   // ...and then the window passes
  record();
  assert.equal(flag(m, 'rpc-timeouts'), undefined, 'a lifetime total is not a current problem');
  failedCalls = 50;
  record();
  assert.match(flag(m, 'rpc-timeouts').text, /^2 RPC attempt\(s\) failed outright in the last 10 min \(50 since/);
});

// bmc's archive_check (asm/daemon/archive_verify.c) prints the layout line, then the summary,
// and counts the layout break as one of its problems.
const LAYOUT = '2026-09-24 18:41:52.693 [check] block data is NOT laid out monotonically (first break at height 1) -- truncation and pruning will refuse to run';
const CHECK = (problems) => `2026-09-24 18:41:52.693 [check] checklevel=3 over 6 block(s) [897475..897480]: 6 examined, 0 hole(s), ${problems} problem(s)`;

test('a layout break is an info fact, and not also a check problem', () => {
  const m = mk();
  const now = Date.now();
  m.onLogEvents([{ ...parseLine(LAYOUT), ts: now }, { ...parseLine(CHECK(1)), ts: now }]);
  assert.equal(flag(m, 'archive-hole').severity, 'info');
  assert.match(flag(m, 'archive-hole').text, /parallel download/);
  assert.equal(flag(m, 'check-problems'), undefined, 'the one problem was the layout break');
});

test('damage beyond the layout break is still a warning, counted without it', () => {
  const m = mk();
  const now = Date.now();
  m.onLogEvents([{ ...parseLine(LAYOUT), ts: now }, { ...parseLine(CHECK(3)), ts: now }]);
  const q = flag(m, 'check-problems');
  assert.equal(q.severity, 'warn');
  assert.match(q.text, /found 2 problem\(s\) in the block data itself/);
  // A later boot whose check is clean takes both down.
  m.onLogEvents([{ ...parseLine(CHECK(0)), ts: now + 60_000 }]);
  assert.equal(flag(m, 'check-problems'), undefined);
  assert.equal(flag(m, 'archive-hole'), undefined);
});

test('tip-stale clears when the chain advances, with no "tip fresh" line', async () => {
  const m = mk();
  m.onNewTip = async () => {};
  const info = (blocks) => new Map([
    ['getblockchaininfo', { blocks, headers: 968441, verificationprogress: 0.99, chain: 'main', initialblockdownload: true }],
    ['getmempoolinfo', { size: 0 }],
    ['getconnectioncount', 9],
    ['getnettotals', { totalbytesrecv: 5e9, totalbytessent: 2e8, timemillis: 1, uploadtarget: { target: 0 } }],
    ['uptime', 7000],
  ]);
  let blocks = 960000;
  m.callList = async () => info(blocks);
  await m.tier_fast();
  m.onLogEvents([{ ...parseLine('2026-09-24 18:53:56.667 [dial] tip stale for 30 min (no block seen): wanting 9 outbound'), ts: Date.now() - 5000 }]);
  assert.ok(flag(m, 'tip-stale'));
  await m.tier_fast();
  assert.ok(flag(m, 'tip-stale'), 'no new block: still stale');
  blocks += 170;
  await m.tier_fast();
  assert.equal(flag(m, 'tip-stale'), undefined, '170 blocks later the tip is not stale, whatever the log has said');
});

test('relay shapes are not watched while the node is in IBD', async () => {
  const accept = '2026-09-24 19:16:19.472 [tx_accept] last 38s: +0 accepted (mempool 0) | rejected: 4 missing-inputs, 0 invalid, 0 policy | 0 already confirmed';
  const hb = '2026-09-24 21:00:00.000 [dl] heartbeat: tip=960911 peers=9/12 txouts=165336332 uptime=00:02:30:00';
  const run = async (initialblockdownload) => {
    const m = mk({ gates: { 'accepts and rejects': 1000 } });
    const now = Date.now();
    m.state.chainInfo = { blocks: 960911, headers: initialblockdownload ? 968441 : 960911, initialblockdownload };
    m.onLogEvents([{ ...parseLine(accept), ts: now - 600_000 }]);
    m.onLogEvents(Array.from({ length: 20 }, (_, i) => ({ ...parseLine(hb), ts: now - (20 - i) * 1000 })));
    await m.checkLogHealth();
    return m;
  };
  const ibd = await run(true);
  assert.equal(flag(ibd, 'log-shape-silent'), undefined, 'no mempool to relay into: the silence is the phase');
  const acc = ibd.logHealthStats.shapes.find((s) => s.shape === 'accepts and rejects');
  assert.equal(acc.watching, false);
  assert.match(acc.reason, /in IBD/);
  const synced = await run(false);
  assert.match(flag(synced, 'log-shape-silent').text, /accepts and rejects/, 'a synced node going quiet is still news');
});

test('handshake failures warn at a rate, not on the first one, and clear when it passes', async () => {
  const m = mk();
  const now = Date.now();
  const fail = (host, ts) => ({ kind: 'peer_reject', reason: 'v2 handshake failed', transport: 'BIP324', host, ts });
  m.onLogEvents([fail('203.0.113.82', now - 60_000), fail('198.51.100.4', now - 50_000), fail('198.51.100.8', now - 40_000)]);
  assert.equal(flag(m, 'inbound-handshake-failing'), undefined, 'three is what any listening node draws');
  m.onLogEvents(Array.from({ length: 9 }, (_, i) => fail('127.0.0.1', now - 30_000 + i)));
  const q = flag(m, 'inbound-handshake-failing');
  assert.match(q.text, /^12 inbound connection\(s\) failed the BIP324 handshake and were dropped in the last 10 min \(12 since/);
  assert.match(q.text, /9 of them from 127\.0\.0\.1/);
  m.handshakeCheck(now + 11 * 60_000);
  assert.equal(flag(m, 'inbound-handshake-failing'), undefined, 'the window passed with no more');
  assert.equal(m.snapshot({}).peers.handshakeFailures.count, 12, 'the lifetime count is still there to read');
  await m.stop();
});

test('[dial-handoff] lines are claimed and aggregated, not a new tag and not the feed', async () => {
  const m = mk();
  let fed = 0;
  m.on('events', (rows) => { fed += rows.length; });
  const lines = [
    '2026-09-24 21:40:00.000 [dial-handoff] 203.0.113.61:8333: helper hands fd over 445ms after the dial began (v1) pend=0 first=- eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED',
    '2026-09-24 21:40:00.020 [dial-handoff] 203.0.113.61:8333: worker received fd 41 461ms after the dial began pend=1150 first=sendcmpct eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED',
    '2026-09-24 21:40:01.000 [dial-handoff] 198.51.100.4:8333: worker received fd 33 90ms after the dial began pend=0 first=- eof=1 hup=1 err=1 so_error=32 tcp=CLOSE',
  ];
  const evs = lines.map(parseLine);
  assert.deepEqual(evs.map((e) => e.kind), ['dial_handoff', 'dial_handoff', 'dial_handoff']);
  assert.equal(evs[1].first, 'sendcmpct');
  m.onLogEvents(Array.from({ length: 30 }, () => evs).flat());
  assert.equal(fed, 0);
  assert.equal(m.unseenTags.has('[dial-handoff]'), false);
  const d = m.snapshot({}).peers.dialHandoff;
  assert.deepEqual([d.handedOver, d.received, d.deadOnArrival], [30, 60, 30]);
  assert.equal(d.dialMaxMs, 461, 'dial time is the worker\'s line, from the start of the dial');
  assert.equal(d.waitMaxMs, 16, 'worker wait is 461 - 445 for the same host; the unmatched worker line adds no wait');
  assert.equal(d.waitMatched, 30);
  await m.stop();
});

test('a v2 leg\'s [dial-handoff] line parses, with no command name made up from its ciphertext', () => {
  // 2026-09-25: two of 33 worker lines went uncounted -- `first=` on a v2 socket is ciphertext,
  // and this one has a space in it.
  const ev = parseLine('2026-09-25 11:22:55.263 [dial-handoff] 203.0.113.51:8333: worker received fd 23 1011ms after the dial began pend=1138 first=g..{.>J3.| w eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED');
  assert.equal(ev.kind, 'dial_handoff');
  assert.deepEqual([ev.side, ev.ms, ev.pend, ev.first, ev.eof, ev.tcp], ['worker', 1011, 1138, null, 0, 'ESTABLISHED']);
  assert.equal(parseLine('2026-09-25 11:22:55.263 [dial-handoff] 203.0.113.51:8333: worker received fd 23 1011ms after the dial began pend=1150 first=sendcmpct eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED').first, 'sendcmpct');
});

test('dial-handoff figures describe the running process: a node start begins them again', async () => {
  // 2026-09-25: the card still read "slowest 10,820 ms" nine hours after bmc#301 went live,
  // because the monitor replays the whole log and that line predated the fix's restart.
  const m = mk();
  const at = (t) => `2026-09-24 ${t}`;
  const L = (t, rest) => parseLine(`${at(t)} ${rest}`);
  m.onLogEvents([
    L('22:53:09.130', '[dial-handoff] 203.0.113.12:8333: helper hands fd over 461ms after the dial began (v1) pend=0 first=- eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED'),
    L('22:53:19.488', '[dial-handoff] 203.0.113.12:8333: worker received fd 42 10820ms after the dial began pend=2075 first=sendcmpct eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED'),
  ]);
  let d = m.snapshot({}).peers.dialHandoff;
  assert.equal(d.waitMaxMs, 10359, 'the 5 s reap, twice: a ready socket waited 10.4 s');
  m.onLogEvents([
    L('23:57:49.909', '[boot] logging to /data/bmc/main/debug.log (debuglogfile) and to the console (printtoconsole=1)'),
    L('23:59:48.188', '[dial-handoff] 203.0.113.22:8333: helper hands fd over 423ms after the dial began (v1) pend=0 first=- eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED'),
    L('23:59:48.423', '[dial-handoff] 203.0.113.22:8333: worker received fd 32 657ms after the dial began pend=0 first=- eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED'),
  ]);
  d = m.snapshot({}).peers.dialHandoff;
  assert.equal(d.since, parseLine(`${at('23:57:49.909')} [boot] logging to /data/bmc/main/debug.log (debuglogfile)`).ts, 'since = the start line');
  assert.deepEqual([d.handedOver, d.received, d.waitMaxMs, d.dialMaxMs], [1, 1, 234, 657], 'nothing from before the restart');
  await m.stop();
});
