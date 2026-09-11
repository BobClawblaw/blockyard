import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSync, STATE, stateLabel } from '../server/collect/sync.js';

const NOW = Date.now();
const sec = (n) => Math.floor(NOW / 1000) - n;

test('a fully synced node reads 100% with a fresh tip', () => {
  const s = computeSync({
    now: NOW, blocks: 965993, headers: 965993, ibd: false, verificationProgress: 1,
    tipTime: sec(40), blockRatePerSec: null, avgBlockGapSec: 540,
  });
  assert.equal(s.state, STATE.SYNCED);
  assert.equal(s.pct, 100);
  assert.equal(s.verificationProgress, 100);
  assert.equal(s.behind, 0);
  assert.equal(s.eta, null, 'nothing to catch up to, so no ETA');
  assert.equal(s.height, 965993);
});

test('sync from genesis starts the bar at 0%', () => {
  const s = computeSync({
    now: NOW, blocks: 0, headers: 965993, ibd: true, verificationProgress: 0, tipTime: sec(40),
  });
  assert.equal(s.pct, 0);
  assert.equal(s.state, STATE.IBD);
  assert.equal(s.behind, 965993);
  assert.equal(s.targetHeight, 965993);
});

test('mid-sync the bar is the height ratio and the ETA uses the measured rate', () => {
  const s = computeSync({
    now: NOW, blocks: 482996, headers: 965993, ibd: true, verificationProgress: 0.61,
    tipTime: sec(40), blockRatePerSec: 4, // 4 blocks/s
  });
  assert.ok(Math.abs(s.pct - 50) < 0.01, `expected ~50%, got ${s.pct}`);
  assert.equal(s.behind, 482997);
  assert.equal(s.etaSec, Math.round(482997 / 4));
  assert.match(s.eta, /^\d{2}:\d{2}:\d{2}:\d{2}$/, 'ETA is DD:HH:MM:SS like the node prints it');
  assert.match(s.etaBasis, /measured 4\.00 blocks\/s over 2 minutes/, 'the ETA must name the window it came from');
});

test('the two progress figures are never merged, and their divergence is reported', () => {
  const s = computeSync({
    now: NOW, blocks: 900000, headers: 965993, ibd: true, verificationProgress: 0.99, tipTime: sec(40),
  });
  assert.equal(s.pct, +(900000 / 965993 * 100).toFixed(4));
  assert.equal(s.verificationProgress, 99);
  assert.ok(s.caveats.some((c) => /difficulty-weighted/.test(c)), 'a caveat must explain the two numbers differ');
});

test('an unknown header count yields no percentage at all, not 0%', () => {
  const s = computeSync({ now: NOW, blocks: 500, headers: 0, ibd: true, tipTime: sec(10) });
  assert.equal(s.pct, null, '0% would claim we know the target height and are at the start of it');
  assert.equal(s.behind, null);
  assert.ok(s.caveats.some((c) => /no header count/i.test(c)));
});

test('no chaininfo at all is unknown, not zero-height-synced', () => {
  const s = computeSync({ now: NOW });
  assert.equal(s.state, STATE.UNKNOWN);
  assert.equal(s.pct, null);
  assert.equal(s.height, null);
});

test('blocks ahead of headers cannot push the bar past 100%', () => {
  const s = computeSync({ now: NOW, blocks: 100, headers: 90, ibd: false, tipTime: sec(30) });
  assert.equal(s.pct, 100);
  assert.equal(s.behind, 0, 'never a negative gap');
});

test('catching up after a restart is its own state, not "synced"', () => {
  const s = computeSync({
    now: NOW, blocks: 965990, headers: 965993, ibd: false, verificationProgress: 0.9999, tipTime: sec(120), blockRatePerSec: 0.05,
  });
  assert.equal(s.state, STATE.CATCHING_UP);
  assert.equal(s.behind, 3);
  assert.equal(s.etaSec, 60);
});

test('a node holding an old tip with no gap is stalled, not synced', () => {
  const s = computeSync({
    now: NOW, blocks: 965993, headers: 965993, ibd: false, verificationProgress: 1, tipTime: sec(7200),
  });
  assert.equal(s.state, STATE.STALLED);
  assert.ok(s.caveats.some((c) => /over 40 minutes/i.test(c)));
});

test('a fresh reorg outranks a full bar', () => {
  const s = computeSync({
    now: NOW, blocks: 965993, headers: 965993, ibd: false, verificationProgress: 1,
    tipTime: sec(20), reorgEvents: 2, reorgAt: NOW - 30_000,
  });
  assert.equal(s.state, STATE.REORG);
  assert.equal(s.reorgs, 2);
});

test('an old reorg does not keep the panel in "reorganising" forever', () => {
  const s = computeSync({
    now: NOW, blocks: 965993, headers: 965993, ibd: false, verificationProgress: 1,
    tipTime: sec(20), reorgEvents: 2, reorgAt: NOW - 3600_000,
  });
  assert.equal(s.state, STATE.SYNCED);
  assert.equal(s.reorgs, 2, 'the historical count is still reported');
});

test('near the tip, with no measured rate, the cadence estimate is offered and labelled', () => {
  const s = computeSync({
    now: NOW, blocks: 900000, headers: 965993, ibd: false, tipTime: sec(30), avgBlockGapSec: 600,
  });
  assert.equal(s.etaSec, 65993 * 600);
  assert.match(s.etaBasis, /10-minute target cadence/);
  assert.ok(s.caveats.some((c) => /optimistic/i.test(c)));
});

test('during IBD no rate means NO ETA, never a cadence-derived figure', () => {
  // Real case from the bench node on 2026-09-08: 296,325 blocks behind, no rate
  // sample yet. The cadence fallback produced "1432 days" -- a number ~100x
  // larger than the truth, because a syncing node applies blocks far faster
  // than the network makes them. Silence is correct; that was not.
  const s = computeSync({
    now: NOW, blocks: 669628, headers: 965953, ibd: true, verificationProgress: 0.693231,
    tipTime: sec(60), avgBlockGapSec: 600,
  });
  assert.equal(s.eta, null);
  assert.equal(s.etaSec, null);
  assert.equal(s.pct.toFixed(4), '69.3230');
  assert.ok(s.caveats.some((c) => /would be wildly wrong during initial block download/.test(c)));
  assert.ok(!s.caveats.some((c) => /optimistic/.test(c)), 'the optimistic-cadence note must not appear during IBD');
});

test('rate zero does not produce an infinite ETA', () => {
  const s = computeSync({ now: NOW, blocks: 900000, headers: 965993, ibd: true, tipTime: sec(30), blockRatePerSec: 0 });
  assert.equal(s.eta, null);
  assert.equal(s.etaSec, null);
});

test('the height ratio is monotonic in blocks for a fixed header count', () => {
  const headers = 1000;
  const pcts = [0, 250, 500, 750, 1000].map((b) => computeSync({ now: NOW, blocks: b, headers, ibd: true, tipTime: sec(5) }).pct);
  assert.deepEqual(pcts, [0, 25, 50, 75, 100]);
});

test('states have human labels for the UI badge', () => {
  assert.equal(stateLabel(STATE.IBD), 'Initial block download');
  assert.equal(stateLabel(STATE.SYNCED), 'Synced');
  assert.equal(stateLabel('weird'), 'weird', 'an unknown state falls through rather than throwing');
});

test('warnings from the node are carried into the sync view', () => {
  const s = computeSync({ now: NOW, blocks: 1, headers: 1, ibd: false, tipTime: sec(5), warnings: ['Large chain reorganisation detected'] });
  assert.deepEqual(s.warnings, ['Large chain reorganisation detected']);
});

test('a tip old enough that headers may themselves be stale is flagged', () => {
  const s = computeSync({ now: NOW, blocks: 900000, headers: 900000, ibd: false, tipTime: sec(50000) });
  assert.equal(s.headersMayLag, true, 'blocks==headers cannot prove we are at the network tip');
});

// ---- numbers below are the real bench-node readings from 2026-09-08, taken
// ---- while it was doing initial block download on mainnet.

const IBD_HEADERS = 965953;

test('the observed live IBD state renders as a real percentage', () => {
  const s = computeSync({
    now: NOW, blocks: 650266, headers: IBD_HEADERS, ibd: true,
    verificationProgress: 0.673186, tipTime: sec(90000),
  });
  assert.equal(s.state, STATE.IBD);
  assert.ok(Math.abs(s.pct - 67.32) < 0.01, `expected ~67.32%, got ${s.pct}`);
  assert.equal(s.behind, 315687);
});

test('a bursty sync gives a range, not one confident number', () => {
  // Observed on the bench node the same evening: +955 blocks in 92 s (10.4 blk/s),
  // then +4 per 25 s (0.16 blk/s). Any single figure is a guess about which
  // phase you sampled, so both bounds are reported.
  const s = computeSync({
    now: NOW, blocks: 650266, headers: IBD_HEADERS, ibd: true, tipTime: sec(90000),
    blockRatePerSec: 0.12, blockRateFastSpanMs: 120_000,
    blockRateSlowPerSec: 16, blockRateSlowSpanMs: 600_000,
  });
  assert.equal(s.rateTrend, 'decelerating');
  assert.equal(s.etaSec, Math.round(315687 / 16), 'the headline ETA rides the LONGEST trustworthy window: completion depends on the average, not the last trough');
  assert.equal(s.etaWorstSec, Math.round(315687 / 0.12), 'the trough rate is still shown, as the pessimistic bound');
  assert.equal(s.etaBestSec, Math.round(315687 / 16));
  assert.ok(s.caveats.some((c) => /downloads in bursts/.test(c)), 'burstiness must be said out loud');
  assert.ok(s.caveats.some((c) => /will get LONGER/.test(c)));
});

test('a rate from a window too young to characterize a bursty process is not used', () => {
  // The exact condition that produced the 23-day ETA against a node that
  // finished in ~8 h: 40 s of history, sampled inside a trough.
  const s = computeSync({
    now: NOW, blocks: 670718, headers: IBD_HEADERS, ibd: true, tipTime: sec(60),
    blockRatePerSec: 0.1477, blockRateFastSpanMs: 40_000,
    blockRateSlowPerSec: 0.1477, blockRateSlowSpanMs: 40_000,
  });
  assert.equal(s.eta, null, 'no ETA from a 40-second window');
  assert.equal(s.blockRatePerSec, null, 'and no rate claimed either');
  assert.deepEqual(s.rateWindows, []);
  // The distinction that matters to whoever is reading the panel: this is not
  // "no rate measured", it is "measured too recently to trust".
  assert.ok(s.caveats.some((c) => /not been watching long enough/.test(c)));
  assert.ok(!s.caveats.some((c) => /no download rate measured yet/.test(c)));
});

test('the same rate becomes usable once the window has real span', () => {
  const s = computeSync({
    now: NOW, blocks: 670718, headers: IBD_HEADERS, ibd: true, tipTime: sec(60),
    blockRatePerSec: 0.1477, blockRateFastSpanMs: 120_000,
  });
  assert.equal(s.etaSec, Math.round((IBD_HEADERS - 670718) / 0.1477));
  assert.match(s.etaBasis, /over 2 minutes/);
});

test('an accelerating sync says so', () => {
  const s = computeSync({
    now: NOW, blocks: 100000, headers: IBD_HEADERS, ibd: true, tipTime: sec(90000),
    blockRatePerSec: 40, blockRateSlowPerSec: 8,
  });
  assert.equal(s.rateTrend, 'accelerating');
  assert.ok(s.caveats.some((c) => /will shorten/.test(c)));
});

test('a steady rate gets no trend caveat', () => {
  const s = computeSync({
    now: NOW, blocks: 500000, headers: IBD_HEADERS, ibd: true, tipTime: sec(90000),
    blockRatePerSec: 15, blockRateSlowPerSec: 15.4,
  });
  assert.equal(s.rateTrend, 'steady');
  assert.equal(s.etaWorstSec, null, 'no range when the two windows agree');
  assert.ok(!s.caveats.some((c) => /LONGER|shorten/.test(c)));
});

test('a completely stalled download yields no ETA rather than Infinity', () => {
  const s = computeSync({
    now: NOW, blocks: 650266, headers: IBD_HEADERS, ibd: true, tipTime: sec(90000),
    blockRatePerSec: 0, blockRateSlowPerSec: 16,
  });
  assert.equal(s.eta, null);
  assert.equal(s.etaSec, null);
  assert.match(s.etaBasis, /no blocks arrived in the most recent window/);
});

test('a zero in the freshest window outranks a flattering older average', () => {
  // 16 blk/s over ten minutes says "8 hours"; nothing arriving for two minutes
  // says "something is wrong". The second must win.
  const s = computeSync({
    now: NOW, blocks: 650266, headers: IBD_HEADERS, ibd: true, tipTime: sec(90000),
    blockRatePerSec: 0, blockRateFastSpanMs: 120_000,
    blockRateSlowPerSec: 16, blockRateSlowSpanMs: 600_000,
  });
  assert.equal(s.eta, null, 'the older average must not paper over the stall');
  assert.ok(s.caveats.some((c) => /no ETA is offered/.test(c) || /hide the stall/.test(c)));
});

test('on this node verificationprogress tracks the height ratio, so no spurious caveat', () => {
  // Live reading: blocks/headers = 67.05% and verificationprogress = 0.670517.
  // They agree, and the UI should not be lecturing the user about two figures
  // that are the same.
  const s = computeSync({
    now: NOW, blocks: 647688, headers: IBD_HEADERS, ibd: true,
    verificationProgress: 0.670517, tipTime: sec(60),
  });
  assert.ok(!s.caveats.some((c) => /difficulty-weighted/.test(c)), 'no divergence, no lecture');
});

// ---- instrument-strip contract ----------------------------------------
// The operator asked for the sync section to lose at least half its height and
// show every blockchain stat on one or two formatted lines. These assert the data
// side of that: one ordered list, all states, nothing invented.
import { stripFacts } from '../server/collect/sync.js';

const byLabel = (facts) => Object.fromEntries(facts.map((f) => [f.label, f.value]));

test('a mid-IBD strip carries every stat the old hero did, in one list', () => {
  const f = byLabel(stripFacts({
    state: STATE.IBD, chain: 'main', height: 684612, headers: 965953, behind: 281341,
    blockRatePerSec: 10.13, rateTrend: 'steady', eta: '00:07:42:46', tipAgeSec: 90000,
    sizeOnDisk: 329349032446, txouts: 165316904, peers: 12,
  }));
  assert.equal(f.chain, 'main');
  assert.equal(f.height, '684,612 / 965,953', 'grouped thousands, height over headers');
  assert.equal(f.behind, '281,341');
  // (height/behind/eta/utxos asserted here; the abbreviated tip-age formatting is
  // exercised on the states that actually show it.)
  assert.equal(f.rate, '10 blk/s');
  assert.equal(f.eta, '00:07:42:46');
  assert.ok(!('tip' in f), 'tip age is withheld during IBD (covered in its own test below)');
  assert.equal(f['on disk'], '329GB', 'decimal units, matching the node');
  assert.equal(f.utxos, '165.3M');
  assert.equal(f.peers, '12');
});

test('a synced strip is the same shape, minus the stats that no longer apply', () => {
  const f = byLabel(stripFacts({ state: STATE.SYNCED, chain: 'main', height: 966008, headers: 966008, behind: 0, tipAgeSec: 42, peers: 16, sizeOnDisk: 767120450950 }));
  assert.equal(f.height, '966,008', 'equal headers are not repeated as "x / x"');
  assert.ok(!('behind' in f), 'behind 0 is not a stat, it is the absence of one');
  assert.ok(!('eta' in f), 'no ETA when there is nothing to catch up to');
  assert.equal(f.tip, '42s');
  assert.equal(f.peers, '16');
});

test('a decelerating rate is visible in the strip without a paragraph', () => {
  const facts = stripFacts({ state: STATE.IBD, height: 1, headers: 2, behind: 1, blockRatePerSec: 0.1477, rateTrend: 'decelerating' });
  const rate = facts.find((f) => f.label === 'rate');
  assert.equal(rate.value, '0.15 blk/s \u2198', 'arrow rather than the word "decelerating"');
  assert.equal(rate.tone, 'bad', 'colour carries the warning so the text does not have to');
  assert.match(rate.title, /throughput is decelerating/);
});

test('a rate of zero is reported, not hidden as falsy', () => {
  const f = byLabel(stripFacts({ state: STATE.IBD, height: 1, headers: 2, behind: 1, blockRatePerSec: 0 }));
  assert.equal(f.rate, '0.00 blk/s', 'zero throughput is information');
});

test('nothing known means an empty strip, not a row of dashes', () => {
  assert.deepEqual(stripFacts({ state: STATE.UNKNOWN }), []);
});

test('an unanswerable node states its reason inside the strip', () => {
  const f = byLabel(stripFacts({ state: STATE.UNKNOWN, reason: 'code -28: Loading block index...' }));
  assert.equal(f['node says'], 'code -28: Loading block index...');
  assert.equal(stripFacts({ state: STATE.IBD, reason: 'stale earlier failure' })
    .find((x) => x.label === 'node says'), undefined, 'a past refusal is not shown once we have data');
});


test('tip age is withheld during IBD, where an old tip block is the expected state', () => {
  // Live: the bench node displayed "tip 4929.1d" while downloading 10 blocks per
  // second, because it is replaying 2013-era history. That number is not a fact
  // about responsiveness, and it read like a thirteen-year stall.
  const ibd = byLabel(stripFacts({ state: STATE.IBD, height: 225272, headers: 966010, behind: 740738, tipAgeSec: 425899000 }));
  assert.ok(!('tip' in ibd), 'no tip age during initial block download');
  const catchUp = byLabel(stripFacts({ state: STATE.CATCHING_UP, height: 966000, headers: 966010, behind: 10, tipAgeSec: 300 }));
  assert.equal(catchUp.tip, '5m', 'near the tip the same figure is genuinely useful');
  const stalled = byLabel(stripFacts({ state: STATE.STALLED, height: 1, headers: 1, tipAgeSec: 7200 }));
  assert.equal(stalled.tip, '2.0h', 'a stalled node must still show how stale its tip is');
});
