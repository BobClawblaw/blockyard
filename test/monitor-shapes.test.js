// Monitor behaviours that are invisible until they are wrong.
//
// Each of these is a figure that can be *correct and misleading*: a hashrate derived
// from a gap measured during IBD, a block map whose oldest entry has no predecessor,
// nine true alarms that read as a broken monitor, a coverage ratio that says "less
// parsed" without saying what arrived instead. Rule 3 says the answer is to withhold
// or to explain, never to round it off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

function makeMonitor({ blockMapCap, state = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcmon-shape-'));
  const store = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9, blockMapCap, auditMaxBytes: 1 << 20, auditKeep: 2 };
  const logger = () => {}; logger.child = () => logger;
  const m = new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {} });
  Object.assign(m.state, state ?? {});
  return m;
}

/** Fill the block map with `n` blocks `gap` seconds apart, newest last. */
function fillBlocks(m, n, { gap = 600, endHeight = 1000, endAt = Date.now() } = {}) {
  for (let i = 0; i < n; i++) {
    const height = endHeight - n + 1 + i;
    m.state.blocks.set(height, {
      height, hash: `${height}`.padStart(64, '0'), time: Math.floor((endAt - (n - i) * gap * 1000) / 1000),
      gapSec: i === 0 ? null : gap, txs: 100, size: 400000, totalfee: 10000,
    });
  }
}

// ------------------------------------------------------ hashrate during IBD

test('the hashrate estimate is withheld during IBD, with the reason attached', () => {
  const m = makeMonitor({ state: {
    chainInfo: { blocks: 500000, headers: 965000, initialblockdownload: true, difficulty: 9e22, verificationprogress: 0.4 },
  } });
  fillBlocks(m, 40);
  const s = m.snapshot({ seriesRanges: {} });
  assert.equal(s.hashrateEstEh, null, 'difficulty ÷ a gap measured while applying hundreds of blocks per second measures the apply rate, not the network');
  assert.match(s.hashrateNote, /initial block download/);
  assert.ok(s.hashrateNote.length > 40, 'the note has to be a sentence an operator can act on');
});

test('the hashrate is also withheld when the node trails its own headers', () => {
  const m = makeMonitor({ state: {
    chainInfo: { blocks: 964990, headers: 965000, initialblockdownload: false, difficulty: 9e22 },
  } });
  fillBlocks(m, 40);
  const s = m.snapshot({ seriesRanges: {} });
  assert.equal(s.hashrateEstEh, null);
  assert.match(s.hashrateNote, /10 block\(s\) behind its own headers/);
});

test('a synced node still gets a hashrate, because the figure is honest there', () => {
  const m = makeMonitor({ state: {
    chainInfo: { blocks: 965000, headers: 965000, initialblockdownload: false, difficulty: 1.2745e14 },
  } });
  fillBlocks(m, 40, { gap: 600 });
  const s = m.snapshot({ seriesRanges: {} });
  assert.equal(s.hashrateNote, null);
  // difficulty / mean gap = 1.2745e14 / 600 = 2.124e11 H/s
  assert.ok(s.hashrateEstEh > 2e-7 && s.hashrateEstEh < 3e-7, `EH/s of the right order: ${s.hashrateEstEh}`);
});

test('a node that has not answered yet says so rather than showing zero', () => {
  const m = makeMonitor();
  const s = m.snapshot({ seriesRanges: {} });
  assert.equal(s.hashrateEstEh, null);
  assert.match(s.hashrateNote, /difficulty or a block-gap sample is missing/);
});

// ------------------------------------------------------------- block map cap

test('the block map is bounded, keeps the newest heights, and counts what it dropped', () => {
  const m = makeMonitor({ blockMapCap: 1000 });
  fillBlocks(m, 1400, { endHeight: 1400 });
  const r = m.trimBlockMap();
  // cap 1000 trims down to 90% of the cap, so it does not thrash on the next block.
  assert.equal(m.state.blocks.size, 900, `size after trim: ${m.state.blocks.size}`);
  assert.equal(r.dropped, m.blockMapEvicted);
  assert.equal(m.blockMapEvicted, 500);
  const heights = [...m.state.blocks.keys()];
  assert.equal(Math.min(...heights), 501, 'the oldest survivors are the newest kept heights');
  assert.equal(Math.max(...heights), 1400, 'the tip is never evicted');
  const snap = m.snapshot({ seriesRanges: {} }).blocks;
  assert.equal(snap.count, m.state.blocks.size);
  assert.ok(m.quality.some((q) => q.key === 'block-map-trimmed'), 'the eviction is visible in the quality list');
  // A second trim at the new size is a no-op, not a cascade.
  const before = m.state.blocks.size;
  assert.equal(m.trimBlockMap().dropped, 0);
  assert.equal(m.state.blocks.size, before);
});

test('the cap comes from configuration, not a constant, and is published', () => {
  const m = makeMonitor({ blockMapCap: 5000 });
  assert.equal(m.blockMapCap, 5000);
  const b = m.snapshot({ seriesRanges: {} }).blocks ?? {};
  void b;
  const s = m.snapshot({ seriesRanges: {} });
  assert.equal(s.log.blockMap.cap, 5000, 'the Node panel can state the cap and how full the map is');
  assert.equal(s.log.blockMap.size, 0);
  assert.equal(s.log.blockMap.evicted, 0);
  assert.equal(s.log.blockMap.oldestHeight, null, 'an empty map reports no oldest height rather than height 0');
});

test('the default cap is measured, not a round number (the number in config.js)', (t) => {
  // config.js claims 12,000 rows cost ~12.6 MB. This asserts the claim stays inside
  // an order of magnitude of what the machine says today and prints the figure, so
  // the comment cannot rot into fiction. If rows grow much fatter, the cap and the
  // comment both have to change together.
  const m = makeMonitor({ blockMapCap: 12000 });
  const before = process.memoryUsage().heapUsed;
  fillBlocks(m, 12000, { endHeight: 12000 });
  const after = process.memoryUsage().heapUsed;
  const mb = Math.max(0, after - before) / 1048576;
  assert.equal(m.state.blocks.size, 12000);
  assert.ok(mb < 60, `12,000 block rows must stay well under 60 MB (measured ${mb.toFixed(1)} MB)`);
  t.diagnostic(`12,000 block rows: ${mb.toFixed(1)} MB of heap`);
});

// ---------------------------------------------------------- restart clustering

function shutdownEvent(ts, signal = 15, tip = 965000) {
  return { kind: 'node_shutdown', severity: 'warn', tag: 'serve', ts, text: `[serve] shutting down (signal ${signal}): tip=${tip}`, signal, tipAtShutdown: tip };
}

test('one restart raises the flag only when it is fresh, and never claims a storm', () => {
  const m = makeMonitor();
  const now = Date.now();
  m.absorb(shutdownEvent(now), now);
  assert.ok(m.quality.some((q) => q.key === 'node-restarting'), 'a shutdown happening now is a flag');
  assert.equal(m.quality.find((q) => q.key === 'node-restart-storm'), undefined);
  assert.equal(m.restarts.length, 1);
});

test('a shutdown replayed from the backfill is an event, not a flag', () => {
  const m = makeMonitor();
  const now = Date.now();
  m.absorb(shutdownEvent(now - 4 * 3600_000), now);
  assert.equal(m.quality.find((q) => q.key === 'node-restarting'), undefined,
    'the tail replays hours of history; a four-hour-old shutdown must not claim the node is going down now');
  assert.equal(m.restarts.length, 0,
    'and it is pruned from the census rather than queued to alarm later: the window runs on the log\'s timestamps, so a backfill of eighteen archived shutdowns cannot read as eighteen restarts happening now');
});

test('three restarts in an hour are named as a deploy, not as nine alarms', () => {
  const m = makeMonitor();
  const now = Date.now();
  for (const minsAgo of [50, 30, 10]) m.absorb(shutdownEvent(now - minsAgo * 60_000), now);
  const storm = m.quality.find((q) => q.key === 'node-restart-storm');
  assert.ok(storm, 'the shape has to be said out loud, or the monitor reads as flapping');
  assert.match(storm.text, /3 restarts in the last 60 min/);
  assert.match(storm.text, /deploying/);
  assert.equal(storm.severity, 'warn');
});

test('restarts age out of the window instead of accumulating forever', () => {
  const m = makeMonitor();
  const now = Date.now();
  for (const hrsAgo of [9, 8, 7]) m.absorb(shutdownEvent(now - hrsAgo * 3600_000), now);
  assert.equal(m.quality.find((q) => q.key === 'node-restart-storm'), undefined,
    'a busy morning four hours ago is not this hour\'s alarm');
  assert.ok(m.restarts.length <= 2, `old entries are pruned: ${m.restarts.length}`);
});

// ------------------------------------------------------------- unseen log tags

test('lines no rule claims are counted by tag, with a sample', () => {
  const m = makeMonitor();
  const now = Date.now();
  for (let i = 0; i < 30; i++) m.onLogEvents([{ rule: null, kind: 'raw', severity: 'info', ts: now - i * 100, text: `[migratetx] sweeping 484 indexes (pass ${i})` }]);
  const census = m.tagCensus();
  const top = census.tags[0];
  assert.equal(top.tag, '[migratetx]');
  assert.equal(top.lines, 30);
  assert.match(top.sample, /sweeping 484 indexes/, 'a sample line is what makes the tag identifiable from the dashboard');
  const flag = m.quality.find((q) => q.key === 'log-new-tag');
  assert.ok(flag, '25+ lines of one unknown tag while the rest parses is a node feature, not noise');
  assert.match(flag.text, /looks like a node feature/);
});

test('an untagged format change is counted too, not dropped', () => {
  const m = makeMonitor();
  const now = Date.now();
  for (let i = 0; i < 5; i++) m.onLogEvents([{ rule: null, kind: 'raw', severity: 'info', ts: now, text: 'no tag at all, new format' }]);
  assert.equal(m.tagCensus().tags[0].tag, '(untagged)');
  assert.equal(m.tagCensus().tags[0].lines, 5);
});

test('a single unknown line does not raise a flag', () => {
  const m = makeMonitor();
  const now = Date.now();
  m.onLogEvents([{ rule: null, kind: 'raw', severity: 'info', ts: now, text: '[novelty] one line' }]);
  assert.equal(m.quality.find((q) => q.key === 'log-new-tag'), undefined,
    'one line is not a subsystem; the gate exists so the flag means something');
});

test('the log block carries the census so the panel can draw it', () => {
  const m = makeMonitor();
  m.onLogEvents([{ rule: null, kind: 'raw', severity: 'info', ts: Date.now(), text: '[weird] hi' }]);
  const s = m.snapshot({ seriesRanges: {} });
  assert.ok(Array.isArray(s.log.unclaimed.tags));
  assert.equal(s.log.unclaimed.tags[0].tag, '[weird]');
});
