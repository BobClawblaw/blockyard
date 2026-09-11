// The node rewrote the `[dlc]` tick line twice in two hours on 2026-09-08.
//   05:42  … | banned 0/114 | staged 1 --
//   06:14  … | banned 5/129 | staged 38 commit 6288 | events 0 rot 0 … --
// The end-anchored rule matched 0 of 26, then 0 of 30, tick lines -- and the
// global log-unparsed gate stayed silent, because the run as a whole still parsed
// ~24%. So the tick line is now scanned one labelled field at a time: an added,
// removed or reordered field costs that field, not the measurement, and a field no
// rule knows is kept verbatim instead of being allowed to blank the chart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../server/collect/logparse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHAPES = fs.readFileSync(path.join(HERE, 'fixtures', 'log-samples-bench.txt'), 'utf8').split('\n').filter(Boolean);
const TICK = SHAPES.filter((l) => l.includes('[dlc] -- recv'));

// Three real tick lines, in the order they were captured: the grammar before the
// drift, then the two shapes after it. Indexing the fixture rather than searching
// for it keeps the assertions honest about which line produced which number.
assert.equal(TICK.length, 3, 'expected pre-drift plus two drifted tick lines');
const CLEAN = TICK[0];
const DRIFTED_ZERO_BANS = TICK[1];
const DRIFTED = TICK[2];

test('every frozen bench line still parses, including the two drifted tick shapes', () => {
  const raw = SHAPES.filter((l) => parseLine(l).kind === 'raw');
  assert.deepEqual(raw, [], `unparsed: ${raw.map((l) => l.slice(21, 70)).join(' ;; ')}`);
});

test('a tick line with unknown fields still yields rates, floor and bans', () => {
  const ev = parseLine(DRIFTED);
  assert.equal(ev.kind, 'bandwidth', 'the rule name may change; the kind must not');
  assert.equal(ev.netRate, 11100000);
  assert.equal(ev.avgNetRate, 11100000);
  assert.equal(ev.diskRate, 11100000);
  assert.equal(ev.floor, 32000);
  assert.equal(ev.banned, 5);
  assert.equal(ev.bannedOf, 129);
  assert.equal(ev.severity, 'warn', 'banned>0 on a line that fires every 10s must still stand out');
  // The median is printed with no unit; text in, no number out (rule 8).
  assert.equal(ev.poolMedianText, '400.3');
  assert.equal(ev.poolMedian ?? null, null);
});

test('unknown fields are reported as data, not as a line that failed', () => {
  const ev = parseLine(DRIFTED);
  // One segment carried two new fields; both are named, with their values kept
  // exactly as printed and interpreted as nothing at all.
  assert.deepEqual([...new Set(ev.extraFields)].sort(), ['commit', 'staged']);
  assert.equal(ev.extraValues.staged, '26');
  assert.equal(ev.extraValues.commit, '6484');
  assert.match(ev.unexpected, /fields no rule knows yet/);
  assert.ok(ev.worker, 'the events tail still decodes');
  assert.equal(ev.worker.rot, 0);
});

test('the drifted shape with zero bans does not warn', () => {
  const ev = parseLine(DRIFTED_ZERO_BANS);
  assert.equal(ev.kind, 'bandwidth');
  assert.equal(ev.netRate, 0, 'a genuine 0.0B/s reading is still a reading');
  assert.equal(ev.banned, 0);
  assert.equal(ev.severity, 'info');
  assert.equal(ev.worker.rot, 211, "the worker's own counters survive the new fields");
  assert.equal(ev.worker.help, 17);
  assert.ok(ev.extraFields.includes('staged'));
});

test('the pre-drift shape still takes the strict rule', () => {
  const ev = parseLine(CLEAN);
  assert.equal(ev.rule, 'bandwidthTick', 'the rigid rule is still first in line for the grammar it was written for');
  assert.equal(ev.kind, 'bandwidth');
  assert.equal(ev.banned, 6);
  assert.equal(ev.extraFields ?? null, null, 'a known grammar reports no unknown fields');
});

test('the scanner does not steal the other [dlc] banners', () => {
  // It claims a line only when it recognises two or more of its fields, so the
  // sibling banners keep the rules that already understood them.
  const cases = [
    ['2026-09-08 03:03:14.954 [dlc] -- peer status (16/16 worker(s) active) --', 'worker_status'],
    ['2026-09-08 03:04:19.931 [dlc] -- 1 peer(s) dropped for lacking NODE_WITNESS; 0 redial(s) skipped since --', 'peer_drop_count'],
    ['2026-09-07 09:24:39.281 [dlc] -- peers banned this run: 95 of 123 --', 'ban_count'],
    ['2026-09-07 09:24:39.281 [dlc] -- dead-weight floor this tick: 32.0 KB/s (pool median 0.0 KB/s, absolute 32.0 KB/s) --', 'deadweight'],
    ['2026-09-07 09:24:39.281 [dlc] -- average since start: 0.0B/s recv, 0.0B/s write --', 'bw_average'],
  ];
  for (const [line, kind] of cases) {
    const ev = parseLine(line);
    assert.equal(ev.kind, kind, `"${line.slice(21, 60)}" became ${ev.kind}, expected ${kind}`);
    assert.notEqual(ev.rule, 'bandwidthTickFields', 'the scanner must not claim this banner');
  }
});

test('the progress line survives a changed parenthetical and an unknown eta', () => {
  // (oldest gap 0s at 388878, 99.93% landed) -> (no gap, 100.00% landed), and eta
  // can be `--:--:--:--`. The rigid rule matched 185 of 185 on the old prose and 0
  // of 185 on the new; the field scan matched both runs completely.
  const drift = SHAPES.filter((l) => l.includes('[dlc] =='));
  assert.ok(drift.length >= 2, 'fixture should hold both progress grammars');
  for (const line of drift) {
    const ev = parseLine(line);
    assert.equal(ev.kind, 'dlc_progress', line.slice(21, 60));
    assert.ok(ev.stored > 0 && ev.storedOf > ev.stored, 'stored/storedOf must survive');
    assert.ok(Number.isFinite(ev.elapsedMs) && ev.elapsedMs > 0);
    assert.ok(Number.isFinite(ev.applied) && Number.isFinite(ev.appliedLag));
    assert.ok(ev.landedPct == null || (ev.landedPct >= 0 && ev.landedPct <= 100));
  }
  const noEta = drift.map(parseLine).find((e) => e.etaText === '--:--:--:--');
  assert.ok(noEta, 'fixture should include the no-estimate line');
  assert.equal(noEta.nodeEtaMs, null, 'an eta the node does not have stays absent');
  assert.ok(noEta.stored > 0, 'and the rest of the line still decodes');
});

test('[serve] inbound accept and handshake failure are peer events RPC never sees', () => {
  const acc = parseLine(SHAPES.find((l) => l.includes('accepted -> child pid')));
  assert.equal(acc.kind, 'peer_connect');
  assert.equal(acc.direction, 'inbound');
  assert.equal(acc.host, '127.0.0.1');
  assert.deepEqual([acc.inboundCount, acc.inboundCap], [2, 245]);
  assert.ok(acc.childPid > 0);

  const fail = parseLine(SHAPES.find((l) => l.includes('v2 handshake failed')));
  assert.equal(fail.kind, 'peer_reject');
  assert.equal(fail.transport, 'v2');
  assert.equal(fail.severity, 'warn');
  assert.match(fail.reason, /handshake failed/);
});

test('a node shutdown in the log is surfaced, not left to look like a network fault', () => {
  const ev = parseLine(SHAPES.find((l) => l.includes('[serve] shutting down')));
  assert.equal(ev.kind, 'node_shutdown');
  assert.equal(ev.signal, 15);
  assert.equal(ev.tipAtShutdown, 965914);
  assert.equal(ev.outboundLegs, 0);
  assert.equal(ev.severity, 'warn');
});

test('323 handshake failures aggregate instead of flooding the feed', async () => {
  const { NodeMonitor } = await import('../server/collect/monitor.js');
  const { History } = await import('../server/store/history.js');
  const dir = fs.mkdtempSync('/tmp/bmcmon-hs-');
  const store = { ringCapacity: 500, maxEventLog: 100, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  const m = new NodeMonitor({ id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 500 }, poll: {}, store, log: logger, history: new History(dir, store, { log: logger }) });
  let fed = 0;
  m.on('events', (rows) => { fed += rows.length; });
  const fail = SHAPES.find((l) => l.includes('v2 handshake failed'));
  const shut = SHAPES.find((l) => l.includes('[serve] shutting down'));
  m.onLogEvents(Array.from({ length: 323 }, () => parseLine(fail)));
  assert.equal(fed, 0, 'individual dropped handshakes do not belong in the feed');
  const q = m.quality.find((x) => x.key === 'inbound-handshake-failing');
  assert.ok(q);
  assert.match(q.text, /323 inbound connection\(s\)/);
  assert.match(q.text, /323 of them from 127\.0\.0\.1/);
  const view = m.snapshot({}).peers.handshakeFailures;
  assert.equal(view.count, 323);
  assert.equal(view.hosts[0].host, '127.0.0.1');

  // The shutdown line does belong in the feed: it happens once and explains an outage.
  // Stamped "now" because the flag is age-gated -- a shutdown replayed from hours of
  // backfilled tail must not claim the node is restarting (shape-liveness.test.js
  // covers the stale case on purpose).
  m.onLogEvents([{ ...parseLine(shut), ts: Date.now() - 5000 }]);
  assert.equal(fed, 1);
  assert.ok(m.quality.find((x) => x.key === 'node-restarting'));
  await m.stop();
});

test('an [dlc] banner of pure unknown fields stays raw rather than half-parsing', () => {
  const ev = parseLine('2026-09-08 06:14:47.528 [dlc] -- groop 3 blap 4 --');
  assert.equal(ev.kind, 'raw', 'inventing a bandwidth event from unknown labels is worse than admitting the miss');
});

test('log mode records the unknown field names for the read model', () => {
  // The point of keeping them: the next format change announces itself here rather
  // than showing up as a chart that quietly stopped moving.
  const monitor = fs.readFileSync(path.join(HERE, '..', 'server', 'collect', 'monitor.js'), 'utf8');
  assert.match(monitor, /tickExtraFields/);
  assert.match(monitor, /unrecognisedTickFields/);
});
