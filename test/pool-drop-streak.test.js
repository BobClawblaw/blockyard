// A streak of stale drops of the full-pool poll is one story, not a hundred events (2026-09-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMonitor } from '../server/collect/monitor.js';
import { RpcError } from '../server/rpc/client.js';

// a plain object as `this`: NodeMonitor's `id` is a getter, and the tier only needs these
function monitorWith(callImpl) {
  const m = {
    id: 'n', events: [], quality: [], log: () => {},
    state: { blocks: new Map(), mempool: {}, mempoolDist: null, logState: {} },
    rpc: { call: callImpl }, history: { record() {} },
    flagQuality: NodeMonitor.prototype.flagQuality, clearQuality: NodeMonitor.prototype.clearQuality,
  };
  m.addEvent = (e) => m.events.push(e);
  return m;
}

test('drops open one flag that counts, one event at the start, one at the recovery', async () => {
  let calls = 0;
  const m = monitorWith(async () => {
    calls += 1;
    if (calls <= 3) throw new RpcError(`dropped: waited ${70_000 + calls * 1000}ms for a lane free enough to answer meaningfully`, { kind: 'stale' });
    return {};
  });
  for (let i = 0; i < 3; i++) await NodeMonitor.prototype.tier_pool.call(m);
  const errs = m.events.filter((e) => e.kind === 'collector_error');
  assert.equal(errs.length, 1, 'one event for the streak, not three');
  assert.match(errs[0].text, /dropped as stale \(waited 71s/);
  const flag = m.quality.find((q) => q.key === 'pool-poll-dropped');
  assert.ok(flag, 'the quality flag is up');
  assert.match(flag.text, /dropped as stale 3 times/);
  assert.match(flag.text, /longest wait 73s/);
  await NodeMonitor.prototype.tier_pool.call(m);   // the node answers again
  assert.equal(m.quality.find((q) => q.key === 'pool-poll-dropped'), undefined, 'the flag clears on recovery');
  const rec = m.events.filter((e) => e.kind === 'collector_recovered');
  assert.equal(rec.length, 1);
  assert.match(rec[0].text, /dropped as stale 3 times/);
  assert.equal(m.poolDrops, null);
});

test('a failure that is not a stale drop is still its own event', async () => {
  const m = monitorWith(async () => { throw new RpcError('RPC HTTP 500: boom', { kind: 'transport' }); });
  await NodeMonitor.prototype.tier_pool.call(m);
  await NodeMonitor.prototype.tier_pool.call(m);
  assert.equal(m.events.filter((e) => e.kind === 'collector_error').length, 2);
  assert.equal(m.quality.length, 0);
});
