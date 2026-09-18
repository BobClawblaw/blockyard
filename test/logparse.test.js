import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine, parseSize, parseRate, parseUptime } from '../server/collect/logparse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Frozen real lines lifted from the live node's log (2026-09-07/08), one per
// shape. If a rule is wrong, this test says so before the UI does.
const SAMPLES = fs.readFileSync(path.join(HERE, 'fixtures', 'log-samples.txt'), 'utf8').trim().split('\n');

test('every fixture line parses to an event with a timestamp and tag', () => {
  for (const line of SAMPLES) {
    const ev = parseLine(line);
    assert.ok(ev, `no event for: ${line}`);
    assert.ok(Number.isFinite(ev.ts) && ev.ts > 1700000000000, `bad ts for: ${line}`);
    assert.ok(ev.text && ev.text.length > 0, `no text for: ${line}`);
    assert.ok(['info', 'warn', 'error'].includes(ev.severity), `bad severity for: ${line}`);
  }
});

test('the timestamp is read as local wall-clock time, not a guess', () => {
  const ev = parseLine(SAMPLES[0]);
  const d = new Date(ev.ts);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8); // September
  assert.equal(d.getDate(), 7);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 24);
  assert.equal(d.getSeconds(), 39);
  assert.equal(d.getMilliseconds(), 281);
});

test('the bandwidth tick carries rates and running totals', () => {
  const ev = parseLine(SAMPLES.find((l) => l.includes('network recv this tick')));
  assert.equal(ev.kind, 'bandwidth');
  assert.equal(ev.netThisTick, 6600);           // "6.6KB" is decimal
  assert.equal(ev.netRate, 674.1);
  assert.equal(ev.netTotal, 1800000);           // "1.8MB"
  assert.equal(ev.diskThisTick, 0);
  assert.equal(ev.diskTotal, 1700000);
});

test('heartbeat decodes tip, peer allocation, txout count and uptime', () => {
  const ev = parseLine(SAMPLES.find((l) => l.includes('heartbeat')));
  assert.equal(ev.kind, 'heartbeat');
  assert.equal(ev.tip, 965913);
  assert.equal(ev.peersInUse, 4);
  assert.equal(ev.peersWanted, 4);
  assert.equal(ev.txouts, 165316904);
  assert.equal(ev.uptime, 64_000);              // 00:00:01:04
});

test('the per-leg relay line names peers and counts -- getpeerinfo does not', () => {
  const ev = parseLine(SAMPLES.find((l) => l.includes('tx accepted via legs')));
  assert.equal(ev.kind, 'tx_relay');
  assert.equal(ev.accepted, 240);
  assert.equal(ev.mempool, 2741);
  assert.equal(ev.legs.length, 3);
  assert.deepEqual(ev.legs[1], { leg: 1, addr: '51.81.57.2:8333', host: '51.81.57.2', accepted: 185 });
  assert.equal(ev.relayRate, 4);                // 240 over 60s
});

test('a block store line records which peer served it', () => {
  const ev = parseLine(SAMPLES.find((l) => l.includes('[block] stored')));
  assert.equal(ev.kind, 'block_stored');
  assert.equal(ev.height, 965915);
  assert.equal(ev.bytes, 1558613);
  assert.equal(ev.txs, 5109);
  assert.equal(ev.via, '193.223.81.8:8333');
});

test('orphan accounting parses both the summary and the detail line', () => {
  const sum = parseLine(SAMPLES.find((l) => l.includes('orphans:')));
  assert.equal(sum.kind, 'orphans');
  assert.equal(sum.held, 259);
  assert.equal(sum.parked, 289);
  assert.deepEqual(sum.oneP1C, { accepted: 0, failed: 0 });

  const det = parseLine(SAMPLES.find((l) => l.includes('orphan drops')));
  assert.equal(det.kind, 'orphan_detail');
  assert.equal(det.requested, 325);
  assert.equal(det.notfound, 93);
  assert.equal(det.inFlight, 106);
  assert.equal(det.syncDeferred, 18);
});

test('peer lifecycle events decode address and reason', () => {
  const ok = parseLine(SAMPLES.find((l) => l.includes('connected over')));
  assert.equal(ok.kind, 'peer_connect');
  assert.equal(ok.addr, '155.186.231.61:8333');
  assert.equal(ok.transport, 'v1');

  const rej = parseLine(SAMPLES.find((l) => l.includes('lacks NODE_WITNESS')));
  assert.equal(rej.kind, 'peer_reject');
  assert.equal(rej.services, '0xc05');

  const drop = parseLine(SAMPLES.find((l) => l.includes('connection dropped')));
  assert.equal(drop.kind, 'peer_drop');
  assert.equal(drop.leg, 6);
  assert.equal(drop.host, '186.226.151.18');

  const replaced = parseLine(SAMPLES.find((l) => l.includes('leg replaced')));
  assert.equal(replaced.kind, 'peer_connect');
  assert.equal(replaced.addr, '79.154.41.211:8333');
  assert.equal(replaced.addrv2, true);
});

test('peer ranking, dead-weight floor and ban counters decode', () => {
  const rank = parseLine(SAMPLES.find((l) => l.includes('ranked')));
  assert.equal(rank.kind, 'peer_ranking');
  assert.equal(rank.live, 119);
  assert.equal(rank.answered, 37);
  assert.equal(rank.best, 78000);
  assert.equal(rank.silent, 82);
  assert.equal(rank.severity, 'warn', 'silent-majority ranking should be visible as a warning');

  const dw = parseLine(SAMPLES.find((l) => l.includes('dead-weight')));
  assert.equal(dw.kind, 'deadweight');
  assert.equal(dw.floor, 32000);

  const banned = parseLine(SAMPLES.find((l) => l.includes('peers banned')));
  assert.equal(banned.kind, 'ban_count', 'the log says "peers banned this run: N of M"');
  assert.equal(banned.banned, 95);
  assert.equal(banned.of, 123);
});

test('chain and mempool progression lines decode', () => {
  const nb = parseLine(SAMPLES.find((l) => l.includes('new block:')));
  assert.equal(nb.kind, 'new_block');
  assert.equal(nb.height, 965914);

  const ann = parseLine(SAMPLES.find((l) => l.includes('announced tip')));
  assert.equal(ann.kind, 'tip_announce');
  assert.deepEqual([ann.legsReached, ann.legsTotal], [3, 3]);

  const drain = parseLine(SAMPLES.find((l) => l.includes('removed 66 pool tx')));
  assert.equal(drain.kind, 'mempool_block_drain');
  assert.equal(drain.removed, 66);

  const arch = parseLine(SAMPLES.find((l) => l.includes('parallel downloader wrote')));
  assert.equal(arch.kind, 'archive_write');
  assert.equal(arch.archiveHeight, 966013);
});

test('an archive layout hole is surfaced as a warning, not buried', () => {
  const ev = parseLine(SAMPLES.find((l) => l.includes('NOT laid out')));
  assert.equal(ev.kind, 'archive_hole');
  assert.equal(ev.height, 964924);
  assert.equal(ev.severity, 'warn');
});

test('unrecognised lines are kept, not dropped', () => {
  const unknown = '2026-09-07 09:57:34.397 [tx_accept] WAL is 7536083 bytes -- sizing the validation snapshot at 2^18 slots';
  const ev = parseLine(unknown);
  assert.equal(ev.kind, 'raw');
  assert.equal(ev.tag, 'tx_accept');
  assert.match(ev.text, /WAL is 7536083 bytes/);
});

test('a line with no timestamp still yields an event dated roughly now', () => {
  const before = Date.now();
  const ev = parseLine('[boot] listener bound on 0.0.0.0:8332');
  const after = Date.now();
  assert.equal(ev.kind, 'raw');
  assert.equal(ev.tag, 'boot');
  assert.ok(ev.ts >= before && ev.ts <= after + 5);
});

test('blank and whitespace-only lines parse to nothing', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('   '), null);
  assert.equal(parseLine('\r'), null);
});

test('size and rate decoding use the node\'s decimal units', () => {
  assert.equal(parseSize('0.0B'), 0);
  assert.equal(parseSize('4.0KB'), 4000);
  assert.equal(parseSize('128 KB'), 128000);
  assert.equal(parseSize('2.3MB'), 2300000);
  assert.equal(parseSize('1GB'), 1e9);
  assert.equal(parseSize('not a size'), null);
  assert.equal(parseRate('405.0B/s'), 405);
  assert.equal(parseRate('32.0 KB/s'.replace(' ', ' ')), 32000);
  assert.equal(parseRate('78 KB/s'), 78000);
  assert.equal(parseRate('78 KB'), null, 'a rate needs the /s');
});

test('uptime DD:HH:MM:SS converts to milliseconds', () => {
  assert.equal(parseUptime('00:00:01:04'), 64_000);
  assert.equal(parseUptime('00:14:15:21'), (14 * 3600 + 15 * 60 + 21) * 1000); // 51321s, matching the node's uptime RPC
  assert.equal(parseUptime('nonsense'), null);
});

// THE TAG GRAMMAR IS A CONTRACT WITH THE NODE, and this is BlockYard's half of it.
//
// A tag this reader cannot claim does not merely look odd: no rule can key on it, the
// line falls into the unstructured bucket, keeps no figures, and takes a timestamp at
// read time. The subsystem disappears from every panel fed by the log, silently.
//
// `[coinstats-hist]` was found that way on 2026-09-18 while measuring what the index
// rules left unread. It went upstream, where it turned out to be seven tags rather than
// one (bitcoinmachinecode PR #263: cmpct-dbg, coinstats-hist, get-miss,
// get-slen-anomaly, server-test, txr-dump, walk-miss -- 7 hyphenated out of 105 in that
// source, and 0 of the 48 in a real log, so they were outliers in their own codebase).
// They were renamed to underscores there, which is why nothing changed here.
//
// The tempting alternative was to widen this reader to accept a hyphen. It is not done,
// deliberately: the node owns its grammar, one reader quietly tolerating a drift is how
// the other six went unreported for as long as they did, and a tag that no longer
// matches is a fact worth surfacing rather than absorbing.
test('the seven renamed tags are claimable, and their old spellings are not', () => {
  const renamed = ['cmpct_dbg', 'coinstats_hist', 'get_miss', 'get_slen_anomaly', 'server_test', 'txr_dump', 'walk_miss'];
  for (const t of renamed) {
    const ev = parseLine(`2026-09-18 03:00:00.000 [${t}] something the node had to say`);
    assert.equal(ev.tag, t, `[${t}] must be claimable by a rule`);
    assert.equal(ev.text, 'something the node had to say', 'the tag is stripped from the text');
  }
  for (const t of renamed) {
    const ev = parseLine(`2026-09-18 03:00:00.000 [${t.replace(/_/g, '-')}] something the node had to say`);
    assert.equal(ev.tag, null, `[${t.replace(/_/g, '-')}] is unclaimable -- if this ever passes, the reader was widened and the docs in both repositories are stale`);
  }
});

test('a worker suffix is part of the tag, not a break in it', () => {
  // [dl:0] and [mux:10] are the same subsystem per worker, and PR #263 checked this
  // form against the grammar too. tagBase is what a rule groups on.
  const ev = parseLine('2026-09-18 03:00:00.000 [mux:10] leg replaced: connected next pool peer 192.0.2.10:8333 (fd 30) addrv2=1');
  assert.equal(ev.tag, 'mux:10');
  assert.equal(ev.tagBase, 'mux');
});
