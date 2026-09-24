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
