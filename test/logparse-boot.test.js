// THE BOOT SEQUENCE (2026-09-18). Run 27's first start wrote 25 `[boot]` lines, and the monitor
// flagged them: "[boot] has 25 line(s) no rule claims ... this looks like a node feature the
// monitor has not been taught to read". The fixture is those 25 lines exactly as the node wrote
// them (paths under /mnt/nvme8tb/bench/run27, no home directory, so nothing is scrubbed).
//
// One line of the 25 is news -- the boot finished, and in how long -- and goes to the feed; the
// rest becomes the node's boot record (ls.boot, and snapshot.log.boot). Each shape has its own
// rule, so a boot line the node adds later is still reported as unread rather than swallowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../server/collect/logparse.js';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINES = fs.readFileSync(path.join(HERE, 'fixtures', 'log-samples-boot.txt'), 'utf8').split('\n').filter(Boolean);
const lineFor = (re) => {
  const l = LINES.find((x) => re.test(x));
  assert.ok(l, `the fixture has no line matching ${re}`);
  return l;
};

test('all 25 boot lines are claimed, each by a rule of its own shape', () => {
  assert.equal(LINES.length, 25);
  const parsed = LINES.map(parseLine);
  assert.deepEqual(parsed.filter((e) => e.kind === 'raw').map((e) => e.text), [], 'no boot line is left unread');
  assert.ok(parsed.every((e) => e.kind.startsWith('boot_')), 'and each is read as part of the boot');
});

test('the boot lines give their figures', () => {
  const cfg = parseLine(lineFor(/\[boot\] config:/));
  assert.equal(cfg.kind, 'boot_config');
  assert.deepEqual(cfg.settings.catchup_workers, { value: '8', note: 'bmc.catchupworkers' });
  assert.deepEqual(cfg.settings.dialratelimit, { value: '0/s', note: 'off' });
  assert.equal(cfg.settings.datadir, undefined, 'the datadir path is left out');

  const loaded = parseLine(lineFor(/chain archive loaded/));
  assert.deepEqual([loaded.kind, loaded.step, loaded.tip, loaded.sec], ['boot_step', 'chain archive loaded', 0, 0]);
  const catchup = parseLine(lineFor(/catch-up check done/));
  assert.equal(catchup.blocksWritten, 0);
  const snap = parseLine(lineFor(/tx-validation snapshot ready/));
  assert.equal(snap.note, 'inbound peers inherit it');

  const done = parseLine(lineFor(/boot phase complete/));
  assert.deepEqual([done.kind, done.sec], ['boot_complete', 0.07], 'the total, not claimed as an ordinary step');

  const seed = parseLine(lineFor(/seed\.bitcoin\.sipa\.be/));
  assert.deepEqual([seed.kind, seed.seed, seed.peers], ['boot_dns_seed', 'seed.bitcoin.sipa.be', 25]);
  const disc = parseLine(lineFor(/discovered \+/));
  assert.deepEqual([disc.added, disc.file, disc.total], [143, 'peers2.dat', 143]);
  assert.equal(parseLine(lineFor(/public peer candidate/)).candidates, 64);
  assert.equal(parseLine(lineFor(/pid \d+ written/)).pid, 1394725);
  assert.equal(parseLine(lineFor(/bmc\.bootcatchup=/)).bootCatchup, false);
});

test('a boot is one record and one feed line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-boot-'));
  const store = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  const m = new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {} });
  const fed = [];
  m.on('events', (rows) => fed.push(...rows));
  m.onLogEvents(LINES.map(parseLine));
  assert.deepEqual(fed.map((r) => r.kind), ['boot_complete'], 'only the finished boot reaches the feed');
  const b = m.snapshot({}).log.boot;
  assert.ok(b, 'the snapshot carries the boot record');
  assert.equal(b.completeSec, 0.07);
  assert.equal(b.archiveTip, 0);
  assert.equal(b.chain, 'main');
  assert.equal(b.dnsSeeds.length, 8);
  assert.equal(b.candidates, 64);
  assert.equal(b.config.catchup_workers.value, '8');
  assert.ok(b.steps.length >= 5, 'the timed steps, in order');
  assert.equal(b.inProgress, null, 'nothing left half-done once the boot completed');
  await m.stop();
});
