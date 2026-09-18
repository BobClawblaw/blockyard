// THE AUXILIARY INDEX FAMILY: [txindex], [txospender], [addr_hist]/[addrhist], [trail].
//
// 2,622 lines of one IBD run's log -- 6.5% of everything the node wrote -- and every
// one of them was `raw` before these rules: no fields, and for the untimestamped ones,
// the time we happened to read them. The fixtures beside this file are one real line
// per shape, from both this box's nodes, with the operator's home directory scrubbed
// out of the tool paths.
//
// The job here is the same as bench-log.test.js's: fail when the node changes its
// grammar, not when a regex is re-worded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, parseCountList } from '../server/collect/logparse.js';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHAPES = fs.readFileSync(path.join(HERE, 'fixtures', 'log-samples-index.txt'), 'utf8').split('\n').filter(Boolean);
const lineFor = (re) => {
  const l = SHAPES.find((x) => re.test(x));
  assert.ok(l, 'the fixture has no line matching ' + re);
  return l;
};

test('every frozen line of the index family parses to something better than raw', () => {
  const raw = SHAPES.filter((l) => parseLine(l).kind === 'raw');
  assert.deepEqual(raw, [], 'these real node lines match no parser rule');
});

test('all three indexes are represented, under both spellings the node uses', () => {
  const seen = new Set(SHAPES.map((l) => parseLine(l).index).filter(Boolean));
  assert.deepEqual([...seen].sort(), ['addr_hist', 'txindex', 'txospender']);
  // The child processes write `[addrhist]`; the daemon writes `[addr_hist]`. Both
  // must normalise to one index, or the page would show two.
  assert.equal(parseLine('[addrhist] DONE: 22 keys, 87 events (77 funds, 10 spends), to height 19999, 0.00 GB, 0s').index, 'addr_hist');
  assert.equal(parseLine('2026-09-16 21:12:36.640 [addr_hist] run [0,19999] built by pid 1669407 in 2s (1 runs so far)').index, 'addr_hist');
});

test('a run being built, and the run it produced', () => {
  const start = parseLine(lineFor(/\[txindex\] trail: building run/));
  assert.equal(start.kind, 'index_run_start');
  assert.deepEqual([start.index, start.from, start.to, start.pid], ['txindex', 0, 19999, 1669405]);
  assert.match(start.tool, /bmc_build_tx_index$/);

  const built = parseLine(lineFor(/\[txindex\] run \[0,19999\] built by pid/));
  assert.equal(built.kind, 'index_run_built');
  assert.deepEqual([built.from, built.to, built.secs, built.runs], [0, 19999, 2, 1]);
});

test('the run inventory, the tail, and the one number that says how far the index answers', () => {
  const listed = parseLine(lineFor(/run txindex\.r000000000-000019999\.dat/));
  assert.equal(listed.kind, 'index_run_listed');
  assert.deepEqual([listed.rows, listed.noun, listed.from, listed.to], [20136, 'records', 0, 19999]);

  const rotated = parseLine(lineFor(/\[txindex\] tail rotated/));
  assert.deepEqual([rotated.kind, rotated.folded, rotated.to, rotated.kept], ['index_tail_rotated', 20136, 19999, 965]);

  const active = parseLine(lineFor(/\[txindex\] tail active: base to=319999/));
  assert.deepEqual([active.baseTo, active.covered, active.backfilled], [319999, 321800, 0]);
});

test('base to=-1 is a real value: an index with no run yet', () => {
  // A `\d+` here read "base to=-1" as 1, which is a height, so an empty index
  // looked like one that had folded the first block.
  const ev = parseLine(lineFor(/tail active: base to=-1/));
  assert.equal(ev.baseTo, -1);
  assert.equal(ev.covered, 0);
  const none = parseLine(lineFor(/\[txindex\] no run yet/));
  assert.equal(none.kind, 'index_no_runs');
});

test('the count list reads any number-and-noun pair, including ones nobody has seen', () => {
  // The builders each report their own nouns (records, spends, funds, keys, events).
  // Rather than a regex per noun, the list is scanned pair by pair -- so a builder
  // that starts reporting a new one is read instead of dropped.
  const done = parseLine(lineFor(/\[addrhist\] DONE:/));
  assert.equal(done.kind, 'index_done');
  assert.deepEqual(done.counts, { keys: 22, events: 87, funds: 77, spends: 10 });
  assert.equal(done.height, 19999);
  assert.equal(done.bytes, 0);
  assert.equal(done.secs, 0);

  const tx = parseLine(lineFor(/\[txindex\] DONE:/));
  assert.deepEqual(tx.counts, { records: 20136, sparse: 79 });

  const invented = parseCountList('7 widgets, 3 sprockets, 1.50 GB, 12s');
  assert.deepEqual(invented.counts, { widgets: 7, sprockets: 3 });
  assert.deepEqual([invented.bytes, invented.secs], [1.5e9, 12]);
});

test('"pass1 done: 20136 transactions in 0s" and "pass1 done: 77 funds, 0 spendrefs, 0s" both give up their seconds', () => {
  // Two spellings of the same line, from two builders.
  const a = parseLine(lineFor(/\[txindex\] pass1 done:/));
  assert.deepEqual([a.counts.transactions, a.secs], [20136, 0]);
  const b = parseLine(lineFor(/\[addrhist\] pass1 done:/));
  assert.deepEqual([b.counts.funds, b.counts.spendrefs, b.secs], [77, 0, 0]);
});

test('a bucket pass is not a height pass', () => {
  const bucket = parseLine(lineFor(/pass3 bucket/));
  assert.deepEqual([bucket.pass, bucket.unit, bucket.done, bucket.of], [3, 'bucket', 0, 256]);
  const height = parseLine(lineFor(/\[txindex\] pass1 0\/19999/));
  assert.equal(height.unit, 'height');
});

test('a merge: what it read, and what it wrote', () => {
  const start = parseLine(lineFor(/\[txindex\] trail: merging 6 runs/));
  assert.deepEqual([start.kind, start.runs, start.pid], ['index_merge_start', 6, 1677449]);
  const rows = parseLine(lineFor(/\[txindex\] merge: 6 runs/));
  assert.deepEqual([rows.rows, rows.from, rows.to], [435480, 0, 119999]);
  assert.match(rows.file, /^txindex\.r/);
  const done = parseLine(lineFor(/\[txindex\] merge DONE:/));
  assert.deepEqual([done.counts.records, done.bytes], [435480, 1e7]);
  const merged = parseLine(lineFor(/\[txindex\] runs merged by pid/));
  assert.deepEqual([merged.kind, merged.merges, merged.secs], ['index_merged', 1, 3]);
});

test('a finished index reports its totals, which is all a synced node prints', () => {
  const a = parseLine(lineFor(/\[txindex\] 1425612630 records/));
  assert.equal(a.kind, 'index_summary');
  assert.deepEqual([a.counts.records, a.from, a.to], [1425612630, 0, 964174]);
  const b = parseLine(lineFor(/\[txospender\] 3486631449 records/));
  assert.deepEqual([b.counts.records, b.height], [3486631449, 966038]);
});

test('[trail] is one line about three indexes, and reads as a map', () => {
  const ev = parseLine(lineFor(/\[trail\] txindex: runs reach 179999/));
  assert.equal(ev.kind, 'index_trail');
  assert.deepEqual(ev.indexes.txindex, { state: 'waiting', reach: 179999, needMore: 7623 });
  assert.equal(ev.indexes.txospender.state, 'waiting');

  const mixed = parseLine(lineFor(/\[trail\] txindex: runs reach 719999/));
  assert.equal(mixed.indexes.txindex.state, 'waiting');
  assert.equal(mixed.indexes.txospender.state, 'merging');
  assert.equal(mixed.indexes.addr_hist.state, 'building');

  const building = parseLine(lineFor(/\[trail\] txindex: building run \[200000,219999\]/));
  assert.deepEqual(building.indexes.txindex, { state: 'building', from: 200000, to: 219999, pid: 1749251 });

  // A segment nobody has written a shape for is kept, not dropped: the line says
  // what the node said.
  const unknown = parseLine('2026-09-16 21:17:39.777 [trail] txindex: paused for a reason nobody has met yet');
  assert.deepEqual(unknown.indexes.txindex, { state: 'other', text: 'paused for a reason nobody has met yet' });
});

test('an untimestamped line is stamped now, and says so', () => {
  // Half of what these builders write is a child process's output with no timestamp
  // at all, redirected into the same file. Those events carry the time they were
  // READ, and before 2026-09-18 nothing in the event admitted it.
  const child = parseLine('[txindex] DONE: 20136 records, 79 sparse, 0.00 GB, 0s');
  assert.equal(child.tsFallback, true);
  assert.ok(Math.abs(child.ts - Date.now()) < 5000, 'the fallback is the clock');

  const daemon = parseLine('2026-09-16 21:12:36.637 [txindex] run [0,19999] built by pid 1669405 in 2s (1 runs so far)');
  assert.equal(daemon.tsFallback, undefined, 'a line the node dated must not be marked');
  assert.equal(new Date(daemon.ts).getFullYear(), 2026);

  // and the same for a line no rule claims
  assert.equal(parseLine('[nosuchtag] something new').tsFallback, true);
});

test('the monitor keeps one record per index, and only milestones reach the feed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-index-log-'));
  const storeCfg = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  const m = new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null },
    {
      rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
      store: storeCfg, log: logger, history: new History(dir, storeCfg, { log: logger }),
      logCfg: { staleMs: 1800000, healthMs: 30000 },
    },
  );
  const feed = [];
  for (const line of SHAPES) {
    const ev = parseLine(line);
    for (const out of m.absorb(ev, Date.now()) ?? []) feed.push(out.kind);
  }
  const idx = m.state.logState.indexes;
  assert.deepEqual(Object.keys(idx).sort(), ['addr_hist', 'txindex', 'txospender']);
  // The tail is what says how far the index can answer; the run inventory is not.
  // (The fixture holds lines from both of this box's nodes, so the last writer wins
  // here as it would on one node reading its own log in order.)
  assert.equal(idx.txindex.covered, 321800);
  assert.equal(idx.txindex.totals.counts.records, 1425612630);
  assert.equal(idx.txindex.runs, 1);
  assert.equal(idx.txospender.lastRun.to, 19999);
  assert.equal(idx.addr_hist.lastMerge.secs, 3);

  // 2,622 lines in one run: the chatty ones stay out of the feed or they ARE the feed.
  assert.ok(!feed.includes('index_run_listed'), 'the run inventory must not reach the feed');
  assert.ok(!feed.includes('index_pass'), 'pass progress must not reach the feed');
  assert.ok(!feed.includes('index_trail'), 'the trail line is state, not an event');
  assert.ok(feed.includes('index_run_built') && feed.includes('index_merge_done'), 'milestones must reach the feed');
});
