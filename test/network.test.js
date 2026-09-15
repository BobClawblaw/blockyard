// THE NETWORK OVER A WEEK AND A YEAR (2026-09-15): the arithmetic behind the Mining tab's new row,
// held to hand-computed values, and the collector against a scripted RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rewardStats, difficultyEstimate, halvingInfo, hashrateSeries, adjustments, poolShares, NetworkStats, EPOCH } from '../server/collect/network.js';

test('rewardStats sums subsidy and fees and averages the fee per non-coinbase transaction', () => {
  const rows = [
    { height: 100, totalfee: 1_000_000, subsidy: 312_500_000, txs: 3 },   // two paying transactions
    { height: 101, totalfee: 3_000_000, subsidy: 312_500_000, txs: 5 },   // four
  ];
  const r = rewardStats(rows);
  assert.equal(r.blocks, 2);
  assert.equal(r.minersRewardSat, 629_000_000);
  assert.equal(r.avgBlockFeeSat, 2_000_000);
  assert.equal(r.avgTxFeeSat, Math.round(4_000_000 / 6));
  assert.equal(r.txs, 6);
  assert.deepEqual([r.from, r.to], [100, 101]);
  assert.equal(rewardStats([]).blocks, 0);
  assert.equal(rewardStats([{ height: 1, totalfee: null, subsidy: 5 }]).blocks, 0, 'a row without a fee figure is not counted');
});

test('difficultyEstimate: the pace so far, projected over the period, against the ten-minute target', () => {
  const start = 1_700_000_000;
  // 1000 blocks into a period in 9.5 minutes each: faster than target, so difficulty rises
  const e = difficultyEstimate({ height: EPOCH * 479 + 1000, tipTime: start + 1000 * 570, epochStartTime: start, difficulty: 127e12, prevDifficulty: 125.8e12, now: 0 });
  assert.equal(e.epochStart, EPOCH * 479);
  assert.equal(e.into, 1000);
  assert.equal(e.remaining, 1016);
  assert.ok(Math.abs(e.estimatePct - (600 / 570 - 1) * 100) < 1e-9, `estimate ${e.estimatePct}`);
  assert.ok(Math.abs(e.previousPct - (127 / 125.8 - 1) * 100) < 1e-9);
  assert.equal(e.etaSec, 1016 * 570, 'the rest of the period at the pace so far');
  // slower than target: the estimate is negative; the clamp holds at four times either way
  assert.ok(difficultyEstimate({ height: 1000, tipTime: start + 1000 * 700, epochStartTime: start, difficulty: 1 }).estimatePct < 0);
  assert.equal(difficultyEstimate({ height: 1000, tipTime: start + 1000 * 6000, epochStartTime: start, difficulty: 1 }).estimatePct, -75);
  assert.equal(difficultyEstimate({ height: 1000, tipTime: start + 1000 * 10, epochStartTime: start, difficulty: 1 }).estimatePct, 300);
  // too early in the period for a pace
  const early = difficultyEstimate({ height: EPOCH * 3 + 4, tipTime: start + 2400, epochStartTime: start, difficulty: 1 });
  assert.equal(early.estimatePct, null);
  assert.equal(early.etaSec, (EPOCH - 4) * 600, 'the ETA falls back to the target spacing');
  assert.equal(difficultyEstimate({ height: 5, tipTime: null, epochStartTime: start }), null);
});

test('halvingInfo: the next multiple of 210,000 and the blocks to it', () => {
  const h = halvingInfo(967_141, { now: 0 });
  assert.equal(h.nextHeight, 1_050_000);
  assert.equal(h.blocksLeft, 82_859);
  assert.equal(h.etaSec, 82_859 * 600);
  assert.equal(h.era, 4);
  assert.equal(halvingInfo(840_000).nextHeight, 1_050_000, 'a block at a halving height counts toward the next one');
});

test('hashrateSeries: difficulty times 2^32 over the mean interval between samples', () => {
  const d = 100e12;
  const s = [
    { height: 1000, time: 0, difficulty: d },
    { height: 1144, time: 144 * 600, difficulty: d },        // exactly on target: hashrate = d * 2^32 / 600
    { height: 1288, time: 144 * 600 + 144 * 300, difficulty: d },   // twice as fast: double
    { height: 1300, time: 144 * 600 + 144 * 300 - 5, difficulty: d },   // clock went backwards: skipped
  ];
  const out = hashrateSeries(s);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].hashrate - d * 4294967296 / 600) < 1e6);
  assert.ok(Math.abs(out[1].hashrate - 2 * d * 4294967296 / 600) < 1e6);
  assert.equal(out[0].t, 144 * 600 * 1000, 'stamped at the later sample, in milliseconds');
  assert.deepEqual(hashrateSeries([]), []);
});

test('adjustments: each period start against the one before, newest first', () => {
  const rows = adjustments([
    { height: 0, time: 1, difficulty: 100 },
    { height: 2016, time: 2, difficulty: 110 },
    { height: 4032, time: 3, difficulty: 99 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].height, 4032);
  assert.ok(Math.abs(rows[0].changePct - (-10)) < 1e-9);
  assert.ok(Math.abs(rows[1].changePct - 10) < 1e-9);
});

test('poolShares: the window by time, shares of it, and luck against the target spacing', () => {
  const now = 1_800_000_000_000;
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ height: 500 + i, time: now / 1000 - 3600 * i, poolKey: i % 3 === 0 ? 'a' : 'b', name: i % 3 === 0 ? 'A' : 'B', labelled: true });
  rows.push({ height: 400, time: now / 1000 - 8 * 86400, poolKey: 'c', name: 'C' });   // outside the week
  const s = poolShares(rows, { now, windowSec: 7 * 86400 });
  assert.equal(s.blocks, 10);
  assert.equal(s.count, 2);
  assert.equal(s.pools[0].name, 'B'); assert.equal(s.pools[0].blocks, 6); assert.ok(Math.abs(s.pools[0].sharePct - 60) < 1e-9);
  assert.equal(s.spanSec, 9 * 3600, 'the span covered: the oldest block read, not the whole week');
  assert.equal(s.expected, 54);
  assert.ok(Math.abs(s.luckPct - (10 / 54) * 100) < 1e-9);
  assert.equal(poolShares([], { now }).luckPct, null);
});

test('NetworkStats gathers from a scripted node: rewards, periods, samples, and the week of coinbases', async () => {
  // a chain of 3000 blocks, one every 600 s, difficulty 100T, every coinbase tagged "/Fake Pool/"
  const T0 = 1_700_000_000, tip = 2999, D = 100e12;
  const calls = [];
  const rpc = {
    async batch(list) {
      calls.push(...list.map((c) => c.method));
      return list.map((c) => {
        const [p0] = c.params ?? [];
        switch (c.method) {
          case 'getnetworkhashps': return { ok: true, result: 1e21 };
          case 'getblockstats': return { ok: true, result: { height: p0, time: T0 + p0 * 600, totalfee: 1_000_000, subsidy: 312_500_000, txs: 11 } };
          case 'getblockhash': return { ok: true, result: `hash${p0}` };
          case 'getblockheader': return { ok: true, result: { time: T0 + Number(String(p0).slice(4)) * 600, difficulty: D } };
          case 'getblock': return { ok: true, result: { time: T0 + Number(String(p0).slice(4)) * 600, tx: [`cb${p0}`] } };
          case 'getrawtransaction': return { ok: true, result: { vin: [{ coinbase: '03' + 'e70b00' + Buffer.from('/Fake Pool/').toString('hex') }] } };
          default: return { ok: false, error: { message: 'no' } };
        }
      });
    },
  };
  const ns = new NetworkStats({ rpc, now: () => (T0 + tip * 600) * 1000, windowDays: 1, sampleDays: 10 });
  await ns.refresh({ blocks: tip, difficulty: D, time: T0 + tip * 600 });
  const v = ns.view();
  assert.equal(v.rewards.blocks, 144);
  assert.equal(v.rewards.avgTxFeeSat, 100_000);
  assert.equal(v.adjustment.epochStart, 2016);
  assert.equal(v.adjustment.into, 983);
  assert.ok(Math.abs(v.adjustment.estimatePct) < 1e-9, 'exactly on target: no change');
  assert.ok(Math.abs(v.adjustment.previousPct) < 1e-9);
  assert.equal(v.adjustments[0].height, 2016);
  assert.equal(v.hashrate.networkHashPs, 1e21);
  assert.ok(v.hashrate.series.length >= 10, `daily samples: ${v.hashrate.series.length}`);
  assert.ok(Math.abs(v.hashrate.series[0].hashrate - D * 4294967296 / 600) < 1e6);
  // the coinbases fill in the background: let the pump run a few rounds
  ns.poolTimer && clearTimeout(ns.poolTimer);
  while (ns.poolTodo.length) await ns.fetchPools(ns.poolTodo.splice(0, 8));
  const after = ns.view();
  assert.equal(after.pools.blocks, 145, 'a day: the tip and the 144 before it');
  assert.equal(after.pools.count, 1);
  assert.equal(after.pools.pools[0].name, 'fake', 'unlabelled: the cleaned tag\'s first token, the ledger\'s own key rule');
  assert.ok(calls.includes('getblockstats') && calls.includes('getblockheader') && calls.includes('getrawtransaction'));
  ns.stop();
});
