// The 2026-09-08 bench build (v0.0.1, built 03:02) rewrote the node's log lines.
// Against that run's real log the pre-existing rules matched 30 of 1,702 lines,
// and 1 of its 1,006 `[dlc]` lines -- so "the log is a primary source" became a
// sentence about a source that was not being read. These fixtures are real lines
// lifted from that run (archived as console.run17c.log), and this file is what
// fails when the node changes grammar again rather than when a regex is wrong.
//
// Two fixtures, two jobs:
//   fixtures/log-samples-bench.txt  one line per shape  -> must parse 100%
//   fixtures/bench-log-sample.txt   every 12th line of the run (representative)
//                                   -> the ratio canary below
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseLine, parseClock } from '../server/collect/logparse.js';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8').split('\n').filter(Boolean);
const SHAPES = read('log-samples-bench.txt');
const SAMPLE = read('bench-log-sample.txt');

const lineFor = (re) => {
  const l = SHAPES.find((x) => re.test(x));
  assert.ok(l, 'fixture is missing a line matching ' + re);
  return l;
};

const taggedRatio = (lines) => {
  let tagged = 0;
  let matched = 0;
  for (const l of lines) {
    const ev = parseLine(l);
    if (!ev || !/^\S+ \S+ \[[a-z0-9_]+/.test(l)) continue;
    tagged += 1;
    if (ev.kind !== 'raw') matched += 1;
  }
  return { tagged, matched, ratio: tagged ? matched / tagged : 0 };
};

// ---------------------------------------------------------------- the canary

test('every frozen bench-build line parses to something better than raw', () => {
  const raw = SHAPES.filter((l) => parseLine(l).kind === 'raw');
  assert.deepEqual(raw, [], 'these real node lines match no parser rule');
});

test('a representative slice of the run still parses: the grammar-drift canary', () => {
  const { tagged, matched, ratio } = taggedRatio(SAMPLE);
  assert.ok(tagged > 100, `sample too small to mean anything: ${tagged} tagged lines`);
  // Measured on the frozen run: 0.958. The drift this test exists for measured
  // 0.018, so the bar is nowhere near the pass/fail line in either direction.
  // Rules deliberately do not parse the one-shot [config]/[boot] lines, which is
  // why this is 0.96 and not 1.0.
  assert.ok(ratio >= 0.85, `only ${matched}/${tagged} (${(ratio * 100).toFixed(1)}%) of real lines parsed -- the node changed its log format`);
});

test('the old production shapes still parse (the new rules did not eat them)', () => {
  const prod = read('log-samples.txt');
  const { ratio } = taggedRatio(prod);
  // Two of the 22 production fixtures are unknown lines on purpose -- one test
  // asserts an unrecognised line survives as `raw` -- so this is 0.90, not 1.0.
  assert.ok(ratio >= 0.85, `production grammar regressed: ${(ratio * 100).toFixed(1)}%`);
});

// ---------------------------------------------------------------- the numbers

test('the new bandwidth tick decodes to the same kind as the old one', () => {
  const ev = parseLine(lineFor(/\[dlc\] -- recv /));
  assert.equal(ev.kind, 'bandwidth', 'consumers must not need to know which build printed it');
  assert.equal(ev.netRate, 11100000);       // "11.1MB/s", decimal units
  assert.equal(ev.avgNetRate, 10600000);
  assert.equal(ev.diskRate, 10900000);
  assert.equal(ev.floor, 32000);
  assert.equal(ev.banned, 6);
  assert.equal(ev.bannedOf, 121);
  assert.equal(ev.severity, 'warn', 'a nonzero ban count on a line that fires every 10s still has to stand out');

  // The old line has no running totals. Absent stays absent -- a zero here would
  // read as "0 bytes received this run" on a node that had moved 47 GB.
  assert.equal(ev.netTotal ?? null, null);
  assert.equal(ev.diskTotal ?? null, null);
});

test('the median the node prints without a unit is kept as text, not converted', () => {
  const ev = parseLine(lineFor(/\[dlc\] -- recv /));
  assert.equal(ev.poolMedianText, '353.4');
  assert.equal(ev.poolMedian ?? null, null, 'no unit is printed, so no unit may be invented');
});

test('banned=0 on the same grammar does not warn', () => {
  const ev = parseLine('2026-09-08 04:24:55.389 [dlc] -- recv 11.1MB/s (avg 10.5MB/s) | write 11.2MB/s (avg 10.7MB/s) | floor 32.0 KB/s (median 450.6) | banned 0/121 | events 0 rot 0 wait 0 help 0 fail 0 abandon (run 204/100/10/102/0) --');
  assert.equal(ev.kind, 'bandwidth');
  assert.equal(ev.banned, 0);
  assert.equal(ev.severity, 'info');
  assert.deepEqual(ev.worker, { events: 0, rot: 0, wait: 0, help: 0, fail: 0 });
});

test('the download worker progress line decodes its own elapsed and eta widths', () => {
  const ev = parseLine(lineFor(/\[dlc\] == elapsed/));
  assert.equal(ev.kind, 'dlc_progress');
  assert.equal(ev.elapsedMs, 5302000);      // "1:28:22" -- H:MM:SS, three fields
  assert.equal(ev.nodeEtaMs, 31099000);     // "00:08:38:19" -- DD:HH:MM:SS, four
  assert.equal(ev.stored, 397852);
  assert.equal(ev.storedOf, 966011);
  assert.equal(ev.storedPct, 41.19);
  assert.equal(ev.windowSize, 4096);
  assert.equal(ev.landedPct, 99.92);
  assert.equal(ev.appliedLag, 0);
});

test('parseClock handles both printed widths and refuses nonsense', () => {
  assert.equal(parseClock('1:22:01'), 4921000);      // 1h22m01s, not 1 day 22 min
  assert.equal(parseClock('00:07:54:27'), 28467000); // 7h54m27s
  assert.equal(parseClock('30'), null);
  assert.equal(parseClock('nonsense'), null);
  assert.equal(parseClock('1:2:3:4:5'), null);
});

test('the catchup line decodes ms/blk from the printed value, not a shifted group', () => {
  const ev = parseLine(lineFor(/catchup progress:/));
  assert.equal(ev.kind, 'catchup_progress');
  assert.equal(ev.height, 396273);
  assert.equal(ev.blkPerSec, 23.8);
  assert.equal(ev.msPerBlk, 42.3);
  assert.equal(ev.samples, 1);
  assert.deepEqual(ev.phases, { read: 0, idx: 3, verify: 1, get: 17, put: 21, ckpt: 58, flush: 0, csi: 0, other: 0 });
  // The first cut of this rule read capture groups 9/10 instead of 8/9 and
  // returned msPerBlk 155 for a line printing "42.30 ms/blk". Off-by-one in a
  // group list is invisible to a grep and obvious in a number, so pin the number.
  assert.notEqual(ev.msPerBlk, 155);
});

test('a compaction that never stalled block validation does not warn', () => {
  const ev = parseLine(lineFor(/compaction done/));
  assert.equal(ev.kind, 'utxo_compaction');
  assert.equal(ev.applyWaited, false);
  assert.equal(ev.severity, 'info');
  assert.equal(ev.manifestFrom, 12);
  assert.equal(ev.manifestTo, 4);
  const waited = parseLine('2026-09-08 04:00:00.000 [utxo_live] compaction done in 9.0s (11 run(s) [1..12) of 12, mid-catchup, newest runs, tombstones kept; started at height 400000): manifest_n 12 -> 4, merged into run 6000, 2 flushed meanwhile, 11 input run(s) unlinked; apply waited 3.1s');
  assert.equal(waited.applyWaited, true);
  assert.equal(waited.severity, 'warn', 'compaction stalling validation is the one thing here an operator must see');
});

test('the worker line names the peer and its rate, which no RPC call carries', () => {
  const ok = parseLine(lineFor(/chunks=\d+\s+blocks=\d+/));
  assert.equal(ok.kind, 'peer_throughput');
  assert.equal(ok.host, '93.25.150.155');
  assert.equal(ok.rate, 404800);
  assert.equal(ok.banned, false);

  const banned = parseLine(lineFor(/peer BANNED/));
  assert.equal(banned.banned, true);
  assert.equal(banned.severity, 'warn');
  assert.match(banned.note, /early-kill/);

  const dragging = parseLine(lineFor(/Dragging/));
  assert.equal(dragging.banned, false);
  assert.match(dragging.note, /Dragging: 2 of 3/);
});

test('per-peer identity comes from the log with user agent and peer height', () => {
  const ev = parseLine(lineFor(/\[dl\] outbound \d+ =/));
  assert.equal(ev.kind, 'peer_identify');
  assert.equal(ev.addr, '24.9.164.99:8333');
  assert.equal(ev.userAgent, '/Satoshi:31.0.0/');
  assert.equal(ev.peerHeight, 966010);
  assert.equal(ev.addrv2, true);
});

test('the IBD shapes the node prints once each decode', () => {
  const behind = parseLine(lineFor(/blocks behind --/));
  assert.equal(behind.kind, 'ibd_behind');
  assert.equal(behind.behind, 829849);
  assert.equal(behind.workers, 16);

  const conn = parseLine(lineFor(/connected \d+\/\d+ peer\(s\); downloading/));
  assert.deepEqual([conn.connected, conn.wanted], [5, 8]);

  const paused = parseLine(lineFor(/per-block lines and tip announcements are off/));
  assert.equal(paused.kind, 'relay_paused');
  assert.match(paused.reason, /initial block download/);

  const drop = parseLine(lineFor(/dropped for lacking NODE_WITNESS/));
  assert.equal(drop.dropped, 22);
  assert.equal(drop.severity, 'warn');

  const rank = parseLine(lineFor(/\[dlc\]\s+#\d/));
  assert.equal(rank.kind, 'peer_speed');
  assert.equal(rank.rate, 789000);

  const headers = parseLine(lineFor(/headers \+\d+ from /));
  assert.equal(headers.total, 966011);
});

test('a checklevel run that found problems is a warning', () => {
  const ev = parseLine(lineFor(/checklevel=\d+ over/));
  assert.equal(ev.kind, 'checklevel');
  assert.equal(ev.problems, 1);
  assert.equal(ev.holes, 5);
  assert.equal(ev.severity, 'warn');
});

// --------------------------------------------------- what reaches the feed

function makeMonitor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcmon-test-'));
  const storeCfg = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9 };
  const nodeCfg = { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null };
  // The app passes a logger with .child(); the monitor calls log.child({node}).
  const logger = () => {}; logger.child = () => logger;
  const m = new NodeMonitor(nodeCfg, {
    rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 1000, slowLatencyMs: 5000 },
    poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
    store: storeCfg,
    log: logger,
    history: new History(dir, storeCfg, { log: logger }),
    logCfg: { staleMs: 1800000, healthMs: 30000 },
  });
  return m;
}

test('the chatty IBD lines update state but do not flood the event feed', () => {
  const m = makeMonitor();
  let fed = 0;
  m.on('events', (rows) => { fed += rows.length; });
  // One minute of IBD at the real rate: 6 progress, 6 ticks, 6 catchup lines plus
  // 12 worker lines, i.e. exactly what the node emits every ~10s.
  const evs = [];
  const pick = (re) => parseLine(lineFor(re));
  for (let i = 0; i < 6; i++) { evs.push(pick(/\[dlc\] == elapsed/), pick(/\[dlc\] -- recv /), pick(/catchup progress:/)); }
  for (let i = 0; i < 12; i++) evs.push(pick(/chunks=\d+\s+blocks=\d+/));
  m.onLogEvents(evs);

  assert.ok(evs.length >= 24, 'sanity: the batch should be sizable');
  assert.equal(fed, 0, 'a feed full of ticks pushes every real event off the screen');
  // ...while the figures themselves are kept, separately labelled.
  const s = m.state.logState;
  assert.equal(s.dlcProgress.stored, 397852);
  assert.equal(s.catchup.blkPerSec, 23.8);
  assert.ok(s.dlcProgress.nodeEtaMs > 0 && s.catchup.nodeEtaMs > 0);
  assert.notEqual(s.dlcProgress.nodeEtaMs, s.catchup.nodeEtaMs, 'the two are different measurements and must not converge');
});

test('a banned worker does reach the feed', () => {
  const m = makeMonitor();
  const seen = [];
  m.on('events', (rows) => seen.push(...rows));
  m.onLogEvents([parseLine(lineFor(/peer BANNED/))]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'peer_throughput');
});

test('per-peer figures land on the same record the peer table renders', () => {
  const m = makeMonitor();
  m.onLogEvents([parseLine(lineFor(/chunks=\d+\s+blocks=\d+/)), parseLine(lineFor(/\[dl\] outbound \d+ =/))]);
  const rec = [...m.perPeerRelay.entries()].find(([host]) => host === '93.25.150.155');
  assert.ok(rec, 'the worker line did not create a peer record');
  assert.equal(rec[1].downBps, 404800);
  // Identity from a different line, same peer table row: the table is assembled
  // from several lines that each name the same host.
  const named = [...m.perPeerRelay.values()].find((r) => r.userAgent);
  assert.equal(named.userAgent, '/Satoshi:31.0.0/');
});

// ------------------------------------------------------------- log health

test('a tail whose file stopped moving is flagged, and cleared when it moves', async () => {
  const m = makeMonitor();
  let size = 1000;
  m.tail = { status: () => ({ file: '/tmp/fake.log', exists: true, size, pos: size, lines: 0, events: 0, rotations: 0, truncations: 0, readErrors: 0 }) };
  Object.defineProperty(m, 'staleAfterMs', { value: 1000, configurable: true });

  await m.checkLogHealth();
  // log-source-disabled is present because this probe monitor has no logFile; the
  // three keys under test are the ones that must be silent.
  const seen = () => m.quality.map((q) => q.key).filter((k) => k !== 'log-source-disabled');
  assert.deepEqual(seen(), [], 'a first check must not claim a stall it has not observed');

  await new Promise((r) => setTimeout(r, 1100));
  await m.checkLogHealth();
  const stalled = m.quality.find((q) => q.key === 'log-silent');
  assert.ok(stalled, 'a file frozen for 1.1s against a 1s gate should be flagged');
  assert.equal(stalled.severity, 'warn');
  assert.match(stalled.text, /frozen, not current/);

  size = 2000; // the file moves again
  await m.checkLogHealth();
  assert.equal(m.quality.find((q) => q.key === 'log-silent'), undefined, 'the flag must clear itself once bytes arrive');
});

test('a silent log alongside a racing chain says the tail is wrong, not that the node is idle', async () => {
  const m = makeMonitor();
  m.tail = { status: () => ({ file: '/tmp/fake.log', exists: true, size: 2719, pos: 2719 }) };
  Object.defineProperty(m, 'staleAfterMs', { value: 20, configurable: true });

  m.state.chainInfo = { blocks: 400000 };
  await m.checkLogHealth();                 // establishes the baseline tip
  await new Promise((r) => setTimeout(r, 40));
  m.state.chainInfo = { blocks: 415000 };   // chain raced ahead, file did not move
  await m.checkLogHealth();

  const q = m.quality.find((x) => x.key === 'log-silent');
  assert.ok(q);
  // Measured on the bench node 2026-09-08: ~15,000 blocks in 18 frozen minutes,
  // because the node block-buffers stdout when it is a file. "The node is idle"
  // would have been the wrong thing to say about that.
  assert.match(q.text, /advanced 15000 block\(s\) \(400000 -> 415000\)/);
  assert.match(q.text, /block-buffered|writing somewhere else/);
  assert.equal(m.logHealthStats.advancedWhileQuiet, 15000);
});

test('a silent log with a silent chain offers idleness instead', async () => {
  const m = makeMonitor();
  m.tail = { status: () => ({ file: '/tmp/fake.log', exists: true, size: 500, pos: 500 }) };
  Object.defineProperty(m, 'staleAfterMs', { value: 20, configurable: true });

  m.state.chainInfo = { blocks: 966000 };
  await m.checkLogHealth();
  await new Promise((r) => setTimeout(r, 40));
  await m.checkLogHealth();

  const q = m.quality.find((x) => x.key === 'log-silent');
  assert.ok(q);
  assert.match(q.text, /idle node is the likelier reading/);
  assert.doesNotMatch(q.text, /block-buffered/);
});

test('a missing log file is flagged as no source, not as zero', async () => {
  const m = makeMonitor();
  m.tail = { status: () => ({ file: '/tmp/nope.log', exists: false, size: 0, pos: 0 }) };
  await m.checkLogHealth();
  const q = m.quality.find((x) => x.key === 'log-missing');
  assert.ok(q);
  assert.match(q.text, /no source at all, not a zero value/);
});

test('lines that arrive but match nothing are flagged as a format change', async () => {
  const m = makeMonitor();
  m.tail = { status: () => ({ file: '/tmp/fake.log', exists: true, size: 10, pos: 10 }) };
  for (let i = 0; i < 250; i++) m.logLines += 1;      // 250 lines, none claimed
  await m.checkLogHealth();
  const q = m.quality.find((x) => x.key === 'log-unparsed');
  assert.ok(q, '250 unread lines should be reported, not averaged away');
  assert.match(q.text, /match no parser rule/);

  // and the counters restart: a healthy window after a bad one must clear it
  for (let i = 0; i < 250; i++) { m.logLines += 1; m.logParsed += 1; }
  await m.checkLogHealth();
  assert.equal(m.quality.find((x) => x.key === 'log-unparsed'), undefined);
});
