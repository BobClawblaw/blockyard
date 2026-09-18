// WHAT RUN 26 LEFT UNREAD, now that bmc's log grammar has settled (2026-09-18).
//
// Five shapes carried 93% of the unread lines. The biggest, `[idx] fold`, was a quarter
// of the whole log — and the fix for THAT one went upstream rather than here: the node
// now throttles a fold that did nothing into a five-minute heartbeat carrying the count
// of quiet passes (bitcoinmachinecode PR #265, ~77% fewer fold lines in run 27). The
// shape is unchanged, with two new optional tails, both read below.
//
// Fixtures are real lines from run 26, scrubbed of the operator's home directory, EXCEPT
// the last five: two run-27 tails this box has never logged, a fold reporting trouble
// (err has been zero for 30 hours, so no real line exists), the malloc failure that has
// never happened, and the renamed `[coinstats_hist]` tag. Those five are built from the
// node's own format strings in asm/rpc_chain.c — which is stated here rather than left
// for someone to assume they were captured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../server/collect/logparse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHAPES = fs.readFileSync(path.join(HERE, 'fixtures', 'log-samples-run27.txt'), 'utf8').split('\n').filter(Boolean);
const lineFor = (re) => {
  const l = SHAPES.find((x) => re.test(x));
  assert.ok(l, 'the fixture has no line matching ' + re);
  return l;
};

test('every frozen line parses to something better than raw', () => {
  const raw = SHAPES.filter((l) => parseLine(l).kind === 'raw');
  assert.deepEqual(raw, [], 'these lines match no parser rule');
});

test('the fold line: the figures, and the two tails run 27 added', () => {
  const plain = parseLine(lineFor(/\[idx\] fold \d+\.\.\d+: read=1 /));
  assert.equal(plain.kind, 'index_fold');
  assert.deepEqual([plain.read, plain.present, plain.added, plain.dup, plain.foldedTo, plain.slots], [1, 1, 1, 0, 0, 65536]);
  assert.equal(plain.anomaly, false);
  assert.equal(plain.quietPasses, null);
  assert.equal(plain.severity, 'info');

  // The anomaly the trace exists to catch: records present, none inserted. Never
  // throttled by the node now, so one arriving means one happened.
  const odd = parseLine(lineFor(/PRESENT BUT NOT INSERTED/));
  assert.equal(odd.anomaly, true);
  assert.equal(odd.severity, 'warn');
  assert.deepEqual([odd.present, odd.added], [120, 0]);

  // The heartbeat: how many passes did nothing, and how much they read between them.
  const quiet = parseLine(lineFor(/quiet pass\(es\)/));
  assert.deepEqual([quiet.quietPasses, quiet.quietRead], [412, 1687552]);
  assert.equal(quiet.anomaly, false);

  // Trouble is a warning whether or not the anomaly marker is on the line.
  const bad = parseLine(lineFor(/short=2 err=1/));
  assert.deepEqual([bad.short, bad.err, bad.severity], [2, 1, 'warn']);
});

test('the chain view opening, growing, and failing to grow', () => {
  const open = parseLine(lineFor(/chain view open/));
  assert.deepEqual([open.kind, open.tip, open.slots], ['index_view_open', 0, 65536]);
  const grew = parseLine(lineFor(/table full; grew/));
  assert.deepEqual([grew.kind, grew.slots, grew.present, grew.foldedTo], ['index_table_grew', 131072, 67081, 67080]);
  const failed = parseLine(lineFor(/grow to \d+ slots FAILED/));
  assert.deepEqual([failed.kind, failed.slots, failed.why, failed.severity], ['index_grow_failed', 8388608, 'malloc', 'warn']);
});

test('why the run count sits above its threshold during catch-up', () => {
  const ev = parseLine(lineFor(/merge of \d+ run\(s\) deferred/));
  assert.equal(ev.kind, 'utxo_merge_deferred');
  assert.deepEqual([ev.runs, ev.applyLag, ev.waitsUnder], [2, 533584, 24]);
});

test('who announced a block first, and how', () => {
  // A different peer's credit from who served it, and RPC has neither.
  for (const [re, via] of [[/by headers/, 'headers'], [/by inv/, 'inv'], [/by a compact block/, 'a compact block off our tip']]) {
    const ev = parseLine(lineFor(re));
    assert.equal(ev.kind, 'tip_announced');
    assert.equal(ev.via, via);
    assert.match(ev.addr, /:\d+$/);
    assert.match(ev.hashPrefix, /^[0-9a-f]+$/, 'the truncated hash keeps no trailing dots');
  }
});

test('compact blocks: the peers, the bandwidth mode, and the mempool hit rate', () => {
  const accepts = parseLine(lineFor(/accepts compact blocks/));
  assert.equal(accepts.kind, 'cmpct_peer');

  const high = parseLine(lineFor(/delivered a block: high-bandwidth/));
  assert.deepEqual([high.kind, high.mode], ['cmpct_bandwidth', 'high']);
  const low = parseLine(lineFor(/back to low-bandwidth/));
  assert.deepEqual([low.mode, low.setSize], ['low', 3]);

  const recon = parseLine(lineFor(/reconstructed \d+ block\(s\)/));
  assert.deepEqual([recon.blocks, recon.roundTrips, recon.fellBack], [6, 6, 0]);

  const blk = parseLine(lineFor(/\[cmpct\] block \d+ \(/));
  assert.equal(blk.kind, 'cmpct_block');
  assert.deepEqual([blk.height, blk.txs, blk.fromMempool, blk.hitPct, blk.prefilled, blk.fetched], [967440, 26, 0, 0, 1, 25]);
  assert.equal(blk.fetchedBytes, 3889000, 'the node prints decimal KB');

  // The same line with a hash in it parses too -- one shape, one rule.
  const withHash = parseLine(lineFor(/\[cmpct\] block \d+ hash=/));
  assert.equal(withHash.kind, 'cmpct_block');
  assert.match(withHash.hashPrefix, /^[0-9a-f]{6,}$/);
});

test('the dial the node wanted and could not start', () => {
  const ev = parseLine(lineFor(/outbound top-up/));
  assert.equal(ev.kind, 'dial_failures');
  assert.equal(ev.notStarted, 1);
  assert.equal(ev.reason, 'no dial helper free');
});

test('the address book, by family', () => {
  const ev = parseLine(lineFor(/peer\(s\) sampled from the book/));
  assert.equal(ev.kind, 'pool_sample');
  assert.deepEqual(Object.keys(ev.byFamily), ['ipv4', 'ipv6', 'onion', 'i2p', 'cjdns']);
  assert.deepEqual(Object.keys(ev.dialable), ['ipv4', 'ipv6', 'onion', 'i2p', 'cjdns']);
});

test('coinstats history parses under both spellings of its tag', () => {
  // [coinstats-hist] until PR #263, [coinstats_hist] after. The hyphenated one is a tag
  // TAG_RE cannot claim, so it is still sitting in the line's text -- and the rule has
  // to match it there.
  for (const re of [/\[coinstats-hist\]/, /\[coinstats_hist\]/]) {
    const ev = parseLine(lineFor(re));
    assert.equal(ev.kind, 'coinstats_hist_pass');
    assert.deepEqual([ev.pass, ev.worker, ev.done, ev.of], [1, 0, 10000, 120922]);
  }
});

test('orphan drops: the node inserted a field and the rule had stopped matching', () => {
  // 498 lines of run 26, silently raw, because `drained N` arrived between
  // `retried on another peer N` and the parenthesis. Both spellings parse now.
  const ev = parseLine(lineFor(/orphan drops:/));
  assert.equal(ev.kind, 'orphan_detail');
  assert.equal(ev.drained, 4242);
  assert.deepEqual([ev.gaveUp, ev.inFlight, ev.syncDeferred], [3257, 34, 0]);

  const older = parseLine('2026-09-07 10:01:58.753 [txrelay] orphan drops: 0 ttl, 0 evicted, 0 rejected | parents requested 325, notfound 93, re-requested after timeout 0, retried on another peer 98 (gave up 44, in flight 106), sync deferred 18');
  assert.equal(older.kind, 'orphan_detail');
  assert.equal(older.drained, null, 'the older grammar still parses, with the field absent');
  assert.equal(older.gaveUp, 44);
});
