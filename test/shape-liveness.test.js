// Per-shape liveness, and the four production shapes that were arriving unparsed.
//
// The reason the canary exists is measured: on 2026-09-08 four grammars changed and
// the corpus parse ratio flagged none of them (it sat at 24-74% while individual
// rules matched 0 of 26, 0 of 30, 0 of 185 lines). An hour later the same ratio fell
// 16 points for the opposite, harmless reason -- `[txrelay] addrv2 gossip` chatter
// grew -- which is why that shape now has a rule of its own instead of being noise
// that drags the number down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, SHAPES } from '../server/collect/logparse.js';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROD = fs.readFileSync(path.join(HERE, 'fixtures', 'log-samples.txt'), 'utf8').split('\n').filter(Boolean);

const mk = ({ gates = null, logFile = null } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-shapes-'));
  logFile ??= path.join(dir, 'shapes-fake.log');   // never a fixed name in a shared /tmp (audit 2026-09-14, L3)
  fs.writeFileSync(logFile, '');
  const store = { ringCapacity: 500, maxEventLog: 100, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  return new NodeMonitor({ id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 500 }, poll: {}, store, log: logger,
      history: new History(dir, store, { log: logger }), logCfg: { shapeGatesMs: gates ?? undefined } });
};

// ------------------------------------------------------------------ new shapes

test('address gossip, dial failures, validation rate and header mirror all decode', () => {
  const gossip = parseLine(PROD.find((l) => l.includes('addrv2 gossip')));
  assert.equal(gossip.kind, 'addr_gossip');
  assert.ok(gossip.added >= 0);

  const dial = parseLine(PROD.find((l) => l.includes('outbound top-up')));
  assert.equal(dial.kind, 'dial_failures');
  assert.ok(dial.failed >= 1);
  assert.equal(dial.firstHost, '93.201.114.79');
  // The port belongs to the address, not to the reason: "8333: connect: ..." as a
  // reason would sort into a different bucket than "connect: ..." and quietly
  // fragment the breakdown that the flag is built from.
  assert.equal(dial.reason, 'connect: Operation now in progress');
  assert.equal(dial.severity, 'warn');

  const apply = parseLine(PROD.find((l) => l.includes('updating utxo')));
  assert.equal(apply.kind, 'utxo_apply');
  assert.equal(apply.blocksPerSec, +(apply.blocks / apply.secs).toFixed(2));

  const mirror = parseLine(PROD.find((l) => l.includes('header mirror')));
  assert.equal(mirror.kind, 'header_mirror');
  assert.equal(mirror.gap, mirror.headersNow - mirror.archiveTip);
});

test('the repetitive shapes aggregate instead of burying the feed', () => {
  // Measured cadence: gossip median 22 s (418 in the sampled window), top-up
  // failures median 59 s (130). At 1 s per frame that is a feed of nothing else.
  const m = mk();
  let fed = 0;
  m.on('events', (rows) => { fed += rows.length; });
  const g = PROD.find((l) => l.includes('addrv2 gossip'));
  const d = PROD.find((l) => l.includes('outbound top-up'));
  const events = [...Array(418).keys()].map(() => parseLine(g)).concat([...Array(130).keys()].map(() => parseLine(d)));
  m.onLogEvents(events);
  assert.equal(fed, 0, 'neither shape belongs in the event feed');

  assert.equal(m.addrGossip.updates, 418);
  assert.equal(m.addrGossip.added, 418 * 2);
  const snap = m.snapshot({}).peers;
  assert.equal(snap.addrGossip.updates, 418, 'kept as a figure, just not as 418 rows');

  assert.ok(m.quality.find((x) => x.key === 'outbound-dial-failing'), '130 rounds x 4 failures is a connectivity fact');
  const q = m.quality.find((x) => x.key === 'outbound-dial-failing').text;
  assert.match(q, /connect: Operation now in progress/, 'the reason is the finding, so it is in the flag');
  assert.equal(snap.dialFailures.rounds, 130);
});

test('validation throughput is a third rate and never joins the other two', () => {
  const m = mk();
  const line = PROD.find((l) => l.includes('updating utxo'));
  m.onLogEvents([parseLine(line)]);
  const view = m.snapshot({});
  const apply = view.log.ibd.applyRate;
  assert.ok(apply.blocksPerSec > 0);
  assert.equal(apply.height, apply.height);
  // Separate keys, untouched by each other: download rate, catch-up rate, apply rate.
  assert.equal(view.net.inBps ?? null, null, 'the apply rate must not leak into bandwidth');
  assert.equal(view.log.ibd.nodeCatchup ?? null, null, 'nor into the catch-up rate');
  // Via the node-scoped view, not the raw ring: the monitor's history handle is
  // per-node, and reaching past it would hide exactly the tagging this asserts.
  const applied = m.history.ring('node').series('applyBlkPerSec');
  assert.ok(applied.length && applied[0].v > 0, 'recorded as its own series, on this node');
  assert.equal(m.history.ring('node').last().node, 't', 'stamped with the node that measured it');
});

// ------------------------------------------------------------- liveness canary

test('a measurement that stops arriving while the log keeps moving is flagged', async () => {
  const m = mk({ gates: { heartbeat: 1000 } });
  const hb = '2026-09-08 09:00:00.000 [dl] heartbeat: tip=966036 peers=11/12 txouts=165336332 uptime=00:01:12:15';
  const now = Date.now();
  const old = now - 10 * 60_000;
  const stamp = (line, ts) => ({ ...parseLine(line), ts });

  m.onLogEvents([stamp(hb, old)]);                       // the shape armed itself here
  m.onLogEvents(Array.from({ length: 40 }, (_, i) => stamp(
    '2026-09-08 09:10:00.000 [txrelay] addrv2 gossip: +1 address(es) to the book', now - (40 - i) * 1000)));

  const stats = await m.checkLogHealth();
  const q = m.quality.find((x) => x.key === 'log-shape-silent');
  assert.ok(q, 'heartbeat went from every 65 s to nothing while 40 other lines arrived');
  assert.match(q.text, /heartbeat/);
  assert.match(q.text, /missing, not zero/);
  assert.ok(stats.shapesWatched >= 1);
  assert.equal(stats.shapes.find((s) => s.shape === 'heartbeat').silent, true);
  assert.equal(stats.shapes.find((s) => s.shape === 'address gossip').silent, false, 'the shape that kept arriving stays quiet');
});

test('a shape that keeps arriving produces no warning, and an unarmed shape is never watched', async () => {
  const m = mk({ gates: { heartbeat: 60_000 } });
  const hb = '2026-09-08 09:00:00.000 [dl] heartbeat: tip=966036 peers=11/12 txouts=165336332 uptime=00:01:12:15';
  const now = Date.now();
  m.onLogEvents([
    { ...parseLine(hb), ts: now - 30_000 },
    { ...parseLine(hb), ts: now - 10_000 },
  ]);
  await m.checkLogHealth();
  assert.equal(m.quality.find((x) => x.key === 'log-shape-silent'), undefined, '10 s old is inside a 60 s gate');
  assert.equal(m.quality.find((x) => x.key === 'relay legs'), undefined);
  const watched = m.logHealthStats.shapes.filter((s) => s.watching).map((s) => s.shape);
  assert.ok(watched.includes('heartbeat'));
  assert.equal(watched.includes('relay legs'), false, 'never seen on this build, so never watched -- no build table needed');
});

test('IBD state comes from the RPC, not from log shapes -- the false positive that proved it', async () => {
  // The first version inferred IBD from the presence of `[utxo_live] catchup
  // progress` in the tail. Within a minute of going live it flagged a fully synced
  // production node (initialblockdownload=false, verificationprogress=1,
  // blocks==headers) for "bandwidth rate stopped arriving", because a synced node
  // still emits post-boot catch-up lines. This test pins the corrected precedence.
  const m = mk({ gates: { 'bandwidth rate': 60_000 } });
  const tick = '2026-09-08 06:14:47.528 [dlc] -- recv 11.1MB/s (avg 11.1MB/s) | write 11.1MB/s (avg 11.0MB/s) | floor 32.0 KB/s (median 400.3) | banned 0/129 | staged 26 commit 6484 --';
  const now = Date.now();
  m.state.chainInfo = { blocks: 966055, headers: 966055, initialblockdownload: false, verificationprogress: 1 };
  // The log says "catching up"; the node says it is not. The node wins.
  m.state.logState.catchup = { at: now - 3_600_000, height: 966055, of: 966055 };
  m.onLogEvents([{ ...parseLine(tick), ts: now - 3_600_000 }]);
  m.onLogEvents(Array.from({ length: 30 }, (_, i) => ({ ...parseLine('2026-09-08 07:00:00.000 [dl] heartbeat: tip=966055 peers=11/12 txouts=165330000 uptime=00:02:00:00'), ts: now - (30 - i) * 1000 })));
  await m.checkLogHealth();
  assert.equal(m.quality.find((x) => x.key === 'log-shape-silent'), undefined,
    'a synced node stops emitting tick lines; that is a phase, not a lost measurement');
  const bw = m.logHealthStats.shapes.find((s) => s.shape === 'bandwidth rate');
  assert.equal(bw.watching, false);
  assert.match(bw.reason, /not in IBD/);
});

test('IBD-only shapes are excused outside IBD, with the reason recorded', async () => {
  const m = mk({ gates: { 'bandwidth rate': 1000 } });
  const tick = '2026-09-08 06:14:47.528 [dlc] -- recv 11.1MB/s (avg 11.1MB/s) | write 11.1MB/s (avg 11.0MB/s) | floor 32.0 KB/s (median 400.3) | banned 0/129 | staged 26 commit 6484 --';
  m.state.chainInfo = { initialblockdownload: false };
  m.onLogEvents([{ ...parseLine(tick), ts: Date.now() - 60_000 }]);
  await m.checkLogHealth();
  assert.equal(m.quality.find((x) => x.key === 'log-shape-silent'), undefined,
    'a synced node stops emitting tick lines; warning about that is crying wolf');
  const bw = m.logHealthStats.shapes.find((s) => s.shape === 'bandwidth rate');
  assert.equal(bw.watching, false);
  assert.match(bw.reason, /not in IBD/);
});

test('dial chatter aggregates, dial failures name a reason, and the IPv6 note is a host fact', () => {
  const m = mk();
  let fed = 0;
  m.on('events', (rows) => { fed += rows.length; });

  const attempts = PROD.filter((l) => l.includes('dialing in the background')).map(parseLine);
  m.onLogEvents(attempts);
  assert.equal(m.dialAttempts, attempts.length, 'counted, not streamed');
  assert.equal(fed, 0);

  const fail = parseLine(PROD.find((l) => l.includes('background dial failed')));
  assert.equal(fail.kind, 'peer_reject');
  assert.equal(fail.direction, 'outbound');
  assert.match(fail.reason, /Operation now in progress|NODE_WITNESS/);
  m.onLogEvents([fail]);
  assert.equal(fed, 1, 'one host, one reason, one row -- that is what the peer event list is for');

  const note = parseLine(PROD.find((l) => l.includes('no global IPv6 route')));
  assert.equal(note.kind, 'network_note');
  assert.equal(note.caveat, 'cjdns unaffected');
  m.onLogEvents([note]);
  const q = m.quality.find((x) => x.key === 'ipv6-unreachable');
  assert.ok(q, 'a missing IPv6 route explains an empty ipv6 peer count better than the count does');
  assert.match(q.text, /host capability, not a node fault/);
});

test('the production fixture corpus parses at 90% or better', () => {
  // A fixture-based canary rather than a live-file one, so the assertion is stable
  // and still fails when a rule is deleted or a shape stops being recognised.
  let tagged = 0, matched = 0;
  for (const l of PROD) {
    const e = parseLine(l);
    if (!e || !/^\S+ \S+ \[/.test(l)) continue;
    tagged += 1;
    if (e.kind !== 'raw') matched += 1;
  }
  assert.ok(tagged > 20, `sample too small: ${tagged}`);
  // One line is unknown on purpose: the suite asserts an unrecognised line survives
  // as `raw` rather than being force-fitted into a kind.
  assert.ok(matched / tagged >= 0.90, `${matched}/${tagged} = ${(100 * matched / tagged).toFixed(1)}%`);
});

test('a shutdown replayed from the tail does not claim the node is restarting now', async () => {
  // The tail backfill replays hours of history. A shutdown from four hours ago
  // raising "the node is restarting" on a node that has been up since is stale
  // certainty of exactly the kind this project exists to avoid.
  const m = mk();
  const shut = '2026-09-08 06:21:35.635 [serve] shutting down (signal 15): tip=965914 outbound_legs=0';
  const now = Date.now();
  let fed = 0;
  m.on('events', (rows) => { fed += rows.length; });

  m.onLogEvents([{ ...parseLine(shut), ts: now - 4 * 3600_000 }]);
  assert.equal(m.quality.find((x) => x.key === 'node-restarting'), undefined, 'four hours ago is not "restarting"');
  assert.equal(fed, 1, 'it still reaches the feed, where its timestamp speaks for itself');

  m.onLogEvents([{ ...parseLine(shut), ts: now - 30_000 }]);
  assert.ok(m.quality.find((x) => x.key === 'node-restarting'), 'thirty seconds ago is exactly when you want to be told');

  // And a node answering getblockchaininfo is by definition not mid-restart.
  m.callList = async () => new Map([
    ['getblockchaininfo', { blocks: 966055, headers: 966055, verificationprogress: 1, chain: 'main', initialblockdownload: false }],
    ['getmempoolinfo', { size: 10 }],
    ['getconnectioncount', 11],
    ['getnettotals', { totalbytesrecv: 5e9, totalbytessent: 2e8, timemillis: 1, uploadtarget: { target: 0 } }],
    ['uptime', 7000],
  ]);
  await m.tier_fast();
  assert.equal(m.quality.find((x) => x.key === 'node-restarting'), undefined, 'cleared by the node answering');
});

test('the gates are the measured ones, not round numbers', () => {
  // p95 x 8, clamped to [10, 30] min, from cadences measured on both live nodes.
  const byName = Object.fromEntries(SHAPES.map((s) => [s.shape, s]));
  assert.equal(byName.heartbeat.gateMs, 1_200_000, 'heartbeat p95 152 s');
  assert.equal(byName['relay legs'].gateMs, 960_000, 'relay legs p95 120 s');
  assert.equal(byName['accepts and rejects'].gateMs, 720_000, 'accepts p95 86 s -> 688 s -> floor 10 min');
  assert.ok(SHAPES.every((s) => s.gateMs >= 600_000 && s.gateMs <= 1_800_000), 'every gate inside the clamped band');
  assert.ok(SHAPES.some((s) => s.ibdOnly), 'the two IBD-only shapes stay conditional');
  // Bursty by measurement, so deliberately absent -- see the table in logparse.js.
  const watchedRules = SHAPES.flatMap((s) => s.rules);
  assert.equal(watchedRules.includes('utxoApply'), false, 'updating utxo is p95 1868 s, max 3669 s: irregular');
  assert.equal(watchedRules.includes('headerMirror'), false, 'header mirror is 502/2054/3669 s');
});
