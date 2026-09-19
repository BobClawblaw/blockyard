// ALL OF BMC'S LOG, CLAIMED (2026-09-19). The operator: "Why don't we read 100% of BMC
// logs? We should make sure we are 100% on that." Before this, run 27 parsed at 99.11%,
// run 26 at 94.88% and the production log at 93-94%: 4,643 lines in 186 shapes unread
// across the four current logs. MEASUREMENTS §42 has the numbers after.
//
// Fixtures are real lines -- one or more per rule this change added or widened -- from
// run 27, run 26, the production log and its rotated archives. Scrubbed: the home
// directory is /home/USER/, the node's public address is 203.0.113.7 (TEST-NET-3), this
// box's LAN address is 192.0.2.242 (TEST-NET-1), and the node's own onion and i2p names are
// replaced by `example…` strings of the same shape. Peer addresses are left as the node
// logged them, as in every other fixture. The worker's start line ends in a NUL byte in the
// real log; the fixture spells it `\0` so the file stays text, and the loader puts it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, RULE_KEYS_FOR_TEST } from '../server/collect/logparse.js';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const load = (f) => fs.readFileSync(path.join(FIX, f), 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/\\0$/, '\0'));
const LINES = load('log-samples-100.txt');
const lineFor = (re) => {
  const l = LINES.find((x) => re.test(x));
  assert.ok(l, 'the fixture has no line matching ' + re);
  return l;
};
const ALL_RULES = [...new Set([...RULE_KEYS_FOR_TEST.byKey.values()].flat().concat(RULE_KEYS_FOR_TEST.any))];

test('every frozen line parses to something better than raw', () => {
  const raw = LINES.filter((l) => parseLine(l).kind === 'raw');
  assert.deepEqual(raw, [], 'these lines match no parser rule');
});

test('every rule in the parser has at least one real line frozen somewhere', () => {
  // The census working in the other direction: a rule nothing exercises is a rule whose
  // drift nothing would catch (§39's `orphan drops`).
  const seen = new Set();
  for (const f of fs.readdirSync(FIX)) for (const l of load(f)) { const ev = parseLine(l); if (ev?.rule) seen.add(ev.rule); }
  // `txRelayBare` is the no-legs relay line: no log on this box has ever carried one
  // (checked 2026-09-19 against all 26 logs), so it has no real line to freeze.
  const missing = ALL_RULES.map((r) => r.name).filter((n) => !seen.has(n) && n !== 'txRelayBare');
  assert.deepEqual(missing, []);
});

test('rules are dispatched by tag, and the untagged ones are anchored', () => {
  for (const rule of RULE_KEYS_FOR_TEST.any) {
    assert.ok(rule.re.source.startsWith('^'), `${rule.name} is tried on every line, so it must be anchored`);
  }
  for (const [key, rules] of RULE_KEYS_FOR_TEST.byKey) {
    for (const rule of rules) assert.ok(rule.re.source.startsWith('\\['), `${rule.name} (key ${key}) must open with its tag`);
  }
  // `[dlc w5]` and `[coinstats-hist]` are not tags TAG_RE claims, and still find their rules.
  assert.equal(parseLine(lineFor(/\[dlc w\d\] \S+ dead weight/)).rule, 'dlcWorkerDrop');
  assert.equal(parseLine(lineFor(/\[coinstats-hist\] DONE/)).rule, 'coinstatsHistDone');
  // Two lines the node wrote with no newline between them: the second one's tag is found
  // mid-line, which the every-rule loop this replaced also did.
  const joined = '2026-09-02 11:59:59.781 [dlc] headers from 23.242.53.182:8333 fork from our chain at height 961632 -- discarding\\n2026-09-02 11:59:59.781 [dial] 172.233.59.201:8333 lacks NODE_WITNESS (services=0xc05) -- dropping';
  assert.equal(parseLine(joined).rule, 'dialReject');
});

test('a new shape under a known tag is still unread: no rule claims a whole tag', () => {
  for (const l of [
    '2026-09-19 12:00:00.000 [config] newsection: alpha=1 beta=2',
    '2026-09-19 12:00:00.000 [dlc] the pool announces something else entirely',
    '2026-09-19 12:00:00.000 [mempool]          a continuation nobody has seen before',
    '2026-09-19 12:00:00.000 [rpc] a new endpoint on 127.0.0.1:1',
    '===== something new in the banner',
    'serving on port 8462 differently',
  ]) assert.equal(parseLine(l).kind, 'raw', l);
});

test('existing rules the node\'s newer spellings had slipped past read both spellings now', () => {
  // `invalid (last: "…")`: 85 lines of the current logs, silently raw.
  const acc = parseLine(lineFor(/invalid \(last: "p2wpkh/));
  assert.equal(acc.kind, 'tx_accept');
  assert.deepEqual([acc.accepted, acc.mempool, acc.rejectInvalid, acc.rejectPolicy, acc.alreadyConfirmed, acc.lastInvalid], [84, 14737, 1, 99, 0, 'p2wpkh signature invalid']);
  // `[block] stored … (pushed compact block + blocktxn from A)`: no tx count, a delivery.
  const blk = parseLine(lineFor(/pushed compact block \+ blocktxn/));
  assert.deepEqual([blk.kind, blk.height, blk.bytes, blk.txs, blk.viaHost, blk.delivery], ['block_stored', 967441, 1565590, null, '86.127.254.44', 'compact block + blocktxn']);
  assert.equal(parseLine(lineFor(/pushed compact block from/)).delivery, 'compact block');
  // The background dialer's `filled outbound` is peer identity like `outbound`.
  const id = parseLine(lineFor(/filled outbound 7 = 141/));
  assert.deepEqual([id.kind, id.direction, id.index, id.userAgent, id.peerHeight, id.filled, id.via], ['peer_identify', 'outbound', 7, '/Satoshi:31.1.0/', 967440, true, 'background dial']);
});

test('who closed a leg, why, and after how long', () => {
  const theirs = parseLine(lineFor(/closed theirs \(revents 0x2019\) after 90s/));
  assert.deepEqual([theirs.kind, theirs.leg, theirs.host, theirs.by, theirs.revents, theirs.ageSec, theirs.unread], ['leg_closed', 2, '3.146.133.93', 'theirs', '0x2019', 90, []]);
  const eof = parseLine(lineFor(/EOF on the first read/));
  assert.deepEqual([eof.reason, eof.revents], ['EOF on the first read', null]);
  const ping = parseLine(lineFor(/ours\/ping-timeout/));
  assert.deepEqual([ping.by, ping.reason, ping.ageSec, ping.note], ['ours', 'ping-timeout', 1258, 'no pong in 20 min']);
  const failed = parseLine(lineFor(/ours\/sync-failed-3x/));
  assert.equal(failed.reason, 'sync-failed-3x');
  assert.equal(failed.severity, 'info', 'a leg closing is routine, not a warning');
});

test('the download: a ban is a warning, a lost socket is not, a failed block is', () => {
  const stall = parseLine(lineFor(/is stalling the window: .*BANNED/));
  assert.deepEqual([stall.kind, stall.worker, stall.chunkFrom, stall.window, stall.droppedAfterSec, stall.newlyBanned, stall.severity], ['window_stall', 6, 188041, 4096, 2, true, 'warn']);
  const drop = parseLine(lineFor(/\[dlc w6\] .* stalling the window \(held/));
  assert.deepEqual([drop.kind, drop.reason, drop.rate, drop.chunks, drop.action], ['worker_drop', 'stalling the window', 113500, 0, 'dropping for a fresh peer']);
  const sock = parseLine(lineFor(/socket read failed/));
  assert.deepEqual([sock.kind, sock.attempt, sock.ms, sock.code, sock.verifyFailed, sock.severity], ['chunk_failed', 3, 794, -4, false, 'info']);
  const verify = parseLine(lineFor(/cons_verify/));
  assert.deepEqual([verify.verifyFailed, verify.severity], [true, 'warn']);
  const below = parseLine(lineFor(/still below -minimumchainwork/));
  assert.deepEqual([below.state, below.pages, below.headers, below.bytes, below.secs, below.rate], ['below', 50, 100000, 7700000, 4, 1800000]);
  const shape = parseLine(lineFor(/Core's shape: 8 of 117/));
  assert.deepEqual([shape.parallel, shape.live, shape.cap, shape.span, shape.window, shape.stallTimeoutSec], [8, 117, 8, 967592, 4096, 2]);
});

test('the UTXO engine, zmq, rejections and the mempool across a restart', () => {
  const init = parseLine(lineFor(/\[utxo_live\] init dir=\/mnt/));
  assert.deepEqual([init.kind, init.mode, init.appliedHeight, init.live, init.slots], ['utxo_init', 'fresh', -1, 0, 2 ** 25]);
  assert.ok(!('dir' in init), 'the directory is not carried, as in bootConfig');
  const timing = parseLine(lineFor(/catchup timing/));
  assert.deepEqual([timing.blocks, timing.from, timing.to, timing.secs, timing.phases.flush, timing.msPerBlk], [673, 433048, 433720, 22.4, 61, 33.34]);
  const zmq = parseLine(lineFor(/ring overrun: 24/));
  assert.deepEqual([zmq.kind, zmq.dropped, zmq.total, zmq.severity], ['zmq_overrun', 24, 70892, 'warn']);
  const rej = parseLine(lineFor(/too-long-mempool-chain/));
  assert.deepEqual([rej.kind, rej.class, rej.reason, rej.repeatsMuted], ['tx_reject', 'policy', 'too-long-mempool-chain', true]);
  const loaded = parseLine(lineFor(/loaded mempool\.dat: 1 of 1/));
  assert.deepEqual([loaded.state, loaded.txs, loaded.admitted, loaded.refused, loaded.refusedBy.missing_inputs, loaded.refusedBy.then_accepted, loaded.arrivalTimes], ['loaded', 1, 1, 0, 0, 0, 1]);
  const pkg = parseLine(lineFor(/1p1c accepted/));
  assert.deepEqual([pkg.feeSat, pkg.vsize, pkg.satPerVb], [350, 318, 1.1]);
});

test('configuration: every section read, and a setting the node misread is a warning', () => {
  const mpol = parseLine(lineFor(/\[config\] mpol/));
  assert.equal(mpol.kind, 'config_section');
  assert.deepEqual(mpol.settings, { minrelay: '100', inc: '100', anc: '25/101kvB', desc: '25/101kvB', fullrbf: '1' });
  const bind = parseLine(lineFor(/bind=192\.0\.2\.242 is not a usable number/));
  assert.deepEqual([bind.kind, bind.setting, bind.value, bind.readAs, bind.severity], ['config_rejected', 'bind', '192.0.2.242', '0', 'warn']);
  const loaded = parseLine(lineFor(/\[config\] loaded .*: 17 setting/));
  assert.deepEqual([loaded.file, loaded.applied, loaded.someRejected], ['bitcoin.conf', 17, false]);
});

test('lines with no timestamp of their own say so', () => {
  // The banner, the worker's start line and the fold worker's exit are written without the
  // node's timestamp. They are read -- and every one is marked, never silently stamped now.
  const banner = parseLine(lineFor(/^===== bmcbitcoind +LOG START/));
  assert.deepEqual([banner.kind, banner.program, banner.tsFallback], ['node_build', 'bmcbitcoind', true]);
  assert.equal(banner.loggedAtUtc, Date.UTC(2026, 8, 19, 11, 50, 10), 'the banner\'s own UTC time is a figure, not the event time');
  const build = parseLine(lineFor(/^=====\s+pid/));
  assert.deepEqual([build.version, build.built, build.mode, build.pid, build.tsFallback], ['0.0.1', 'Sep 19 2026 09:08:09', 'serve', 1362025, true]);
  const worker = parseLine(lineFor(/^INFO node start/));
  assert.deepEqual([worker.kind, worker.subsystem, worker.facts.started, worker.tsFallback], ['node_fact', 'worker', 'serve mode / download worker', true]);
  const exiting = parseLine(lineFor(/^\[coinstats\] fold worker exiting/));
  assert.deepEqual([exiting.folded, exiting.height, exiting.tsFallback], [240158840, 321800, true]);
  const stamped = parseLine(lineFor(/\[coinstats\] fold worker pid 1655732 is gone/));
  assert.equal(stamped.tsFallback, undefined);
});

test('set aside: exactly the continuation and separator lines, each by name', () => {
  const noted = LINES.map(parseLine).filter((ev) => ev.kind === 'noted');
  assert.deepEqual([...new Set(noted.map((ev) => ev.rule))].sort(), ['bannerRule', 'mempoolLockContinued', 'torInboundOnly']);
  assert.equal(noted.length, 6, 'four mempool continuations, one [tor] aside, one banner rule');
  for (const ev of noted) assert.ok(ev.why, 'a set-aside line carries the reason it was set aside');
});

test('the monitor: state by default, the feed only for news', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-log100-'));
  const store = { ringCapacity: 500, maxEventLog: 400, retentionHours: 1, snapshotEveryMs: 1e9 };
  const logger = () => {}; logger.child = () => logger;
  const m = new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {} });
  const fed = [];
  m.on('events', (rows) => fed.push(...rows));
  const evs = LINES.map(parseLine);
  m.onLogEvents(evs);

  // Every kind in the fixture that reached the feed is one of these; the chatty ones
  // (leg_closed, tip_on_connect, leg_sync, pool_tip_claim, zmq_overrun, tx_reject, the
  // config and node facts, the worker's start, the UTXO sizing) never do.
  const NEWS = new Set([
    // already feed before this change
    'block_stored', 'peer_identify', 'peer_unreachable', 'peer_reject', 'feeler_dead', 'peer_dial', 'reject_filter', 'tx_accept', 'utxo_compaction', 'index_run_built',
    // added here: a failure, a stall, a ban, a phase finishing, a start that did not happen
    'window_stall', 'chunk_failed', 'ban_amnesty', 'chunk_retry', 'headers_minwork', 'headers_rejected', 'dl_catchup_done', 'dl_committer_restart',
    'tx_broadcast', 'tip_stale', 'utxo_caught_up', 'utxo_failure', 'coinstats_repair', 'coinstats_state', 'coinstats_hist', 'mempool_lock_recovered',
    'archive_integrity', 'config_rejected', 'node_fatal', 'boot_aborted', 'reorg', 'index_disabled', 'index_rolled_back',
  ]);
  const kinds = new Set(fed.map((r) => r.kind));
  assert.deepEqual([...kinds].filter((k) => !NEWS.has(k)), [], 'these kinds reached the feed without being news');
  for (const quiet of ['leg_closed', 'tip_on_connect', 'leg_sync', 'pool_tip_claim', 'zmq_overrun', 'tx_reject', 'node_fact', 'config_section', 'worker_step', 'utxo_sizing', 'noted', 'self_address', 'worker_drop']) {
    assert.ok(evs.some((ev) => ev.kind === quiet), `the fixture exercises ${quiet}`);
    assert.ok(!kinds.has(quiet), `${quiet} is state, not feed`);
  }
  // The feed takes the ban but not the stall by a peer already banned, and the failed
  // block but not the lost socket.
  assert.equal(fed.filter((r) => r.kind === 'window_stall').length, 1);
  assert.equal(fed.filter((r) => r.kind === 'chunk_failed').length, 1);
  assert.ok(fed.length < evs.length / 3, `${fed.length} of ${evs.length} lines reached the feed`);

  const ls = m.state.logState;
  assert.equal(ls.nodeBuild.version, '0.0.1');
  assert.equal(ls.nodeFacts.rpc.auth, 'cookie');
  assert.equal(ls.nodeFacts.zmq.hashblock, 'tcp://127.0.0.1:28332');
  assert.equal(ls.nodeConfig.sections.mpol.fullrbf, '1');
  assert.equal(ls.legClosures.total, 8);
  assert.equal(ls.zmq.overrunTotal, 300, 'the last total the node printed (298), then two single messages a subscriber could not take');
  assert.equal(ls.txRejects['policy: txn-already-in-mempool'], 2);
  assert.equal(ls.indexes.addrindex.covered, 431427, 'the address index reports into the same record as the other three');
  const snap = m.snapshot({}).log.node;
  assert.equal(snap.build.version, '0.0.1');
  assert.ok(!JSON.stringify(snap).includes('203.0.113.7'), 'the node\'s own public address is not sent to viewers');
  await m.stop();
});
