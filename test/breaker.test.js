// The circuit breaker, made answerable rather than re-argued.
//
// The design is deliberately crude: one lane, one request in flight, and three
// consecutive failures stop everything for 30 s. On a node whose RPC server accepts
// one connection at a time on one thread, blocking everything is also the thing that
// protects it from a client that will not stop asking — so per-tier granularity is
// NOT implemented here, and the register entry says so.
//
// What was missing is the ability to answer "who opened this, and what did it
// block?" during a flap. On 2026-09-08 the dashboard alternated `online false
// (breaker open, retry in 26s)` with `online true` while a direct getblockcount
// answered in 1 ms, and there was no way to say which method did it. Now the lane
// records the trigger and the queue it froze, and refuses later work citing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lane, RpcError } from '../server/rpc/client.js';

const cfg = { minIntervalMs: 0, maxRatePerSec: 1000, staleDropMs: 5000, breakerThreshold: 3, breakerCooldownMs: 200 };

const fail = (kind = 'transport', message = 'boom') => () => {
  const e = new Error(message);
  e.kind = kind;
  throw e;
};

test('three consecutive transport failures open the breaker, and it says who did it', async () => {
  const lane = new Lane(cfg);
  for (const [i, m] of ['getchaintxstats', 'getmempool', 'getrawmempool'].entries()) {
    await assert.rejects(() => lane.submit(fail(), { key: `tier-${i}`, label: m }), /boom|breaker/);
  }
  assert.equal(lane.breakerOpen, true, 'open after the threshold');

  const st = lane.breakerState();
  assert.equal(st.open, true);
  assert.equal(st.threshold, 3);
  assert.equal(st.cooldownMs, 200);
  assert.ok(st.retryInMs > 0 && st.retryInMs <= 200, `a countdown, not a boolean: ${st.retryInMs}`);
  assert.equal(st.openedBy.label, 'getrawmempool', 'the method that tripped it');
  assert.equal(st.openedBy.kind, 'transport');
  assert.equal(lane.stats.breakerTrips, 1);

  // Later work is refused, and the refusal carries the diagnosis rather than a shrug.
  await assert.rejects(() => lane.submit(() => 1, { label: 'getblockchaininfo' }), (err) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.kind, 'breaker');
    assert.match(err.message, /opened by getrawmempool/, 'the message has to name the culprit');
    assert.match(err.message, /retry in \d+s/);
    return true;
  });
});

test('it closes again after the cooldown and clears the count', async () => {
  const lane = new Lane(cfg);
  for (let i = 0; i < 3; i++) await assert.rejects(() => lane.submit(fail(), { key: `k${i}` }));
  assert.equal(lane.breakerOpen, true);
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(lane.breakerOpen, false);
  assert.equal(lane.breakerState().open, false);
  assert.equal(await lane.submit(() => 'ok', { key: 'after' }), 'ok');
});

test('a single success resets the consecutive count', async () => {
  const lane = new Lane(cfg);
  await assert.rejects(() => lane.submit(fail(), { key: 'a' }));
  await assert.rejects(() => lane.submit(fail(), { key: 'b' }));
  await lane.submit(() => 'ok', { key: 'c' });
  // Two more failures must not open it: the counter was reset, not accumulated.
  await assert.rejects(() => lane.submit(fail(), { key: 'd' }));
  await assert.rejects(() => lane.submit(fail(), { key: 'e' }));
  assert.equal(lane.breakerOpen, false, 'three CONSECUTIVE failures, not three failures');
});

test('a stale drop is this module choosing not to ask, and cannot open the breaker', async () => {
  const lane = new Lane({ ...cfg, staleDropMs: 0 });
  // An impossible freshness budget: the job is rejected at dequeue time, which is a
  // deliberate drop rather than a node fault.
  await assert.rejects(() => lane.submit(() => 'late', { key: 'slow', maxWaitMs: -1 }), /dropped|waited/);
  assert.equal(lane.breakerOpen, false, 'dropping our own question is not the node failing');
  assert.ok(lane.stats.staleDropped >= 1, 'and it is counted as a drop, not as an error');
  assert.equal(lane.stats.errors, 0);
});

test('an rpc-level error (the node answered, with an error) does not open the breaker', async () => {
  const lane = new Lane(cfg);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => lane.submit(fail('rpc', 'method not found'), { key: `r${i}` }));
  }
  assert.equal(lane.breakerOpen, false,
    'the node is alive and answering; refusing a method is not a transport reason to stop polling it');
});

test('the breaker records what it froze, so the blindness is measurable', async () => {
  const lane = new Lane(cfg);
  // A cheap fast-tier poll queued BEHIND three failing slow-tier calls: the drain
  // takes lowest priority first, so the fast poll is still in the lane when the
  // breaker opens -- which is precisely the "a slow tier blinds the fast one"
  // property the register asks about.
  // All four are submitted before the lane drains anything: if the fast poll were
  // submitted first and awaited, it would simply run (nothing else is queued yet),
  // and the test would be asserting nothing.
  const fast = lane.submit(() => 'fast', { key: 'fast', label: 'getblockchaininfo', priority: 9 });
  const failing = [0, 1, 2].map((i) => lane.submit(fail(), { key: `t${i}`, label: 'slowTier', priority: 1 }));
  await Promise.all(failing.map((p) => assert.rejects(() => p)));
  await assert.rejects(() => fast, /breaker/, 'the queued call is refused rather than fired at a node the lane has given up on');
  const st = lane.breakerState();
  assert.ok(st.openedBy, 'the trigger is recorded');
  assert.ok(Array.isArray(st.openedBy.blocked), 'and so is the list of calls that were in the lane when it opened');
  assert.ok(st.openedBy.blocked.includes('getblockchaininfo'),
    'this is the "a slow tier blinds the fast one" question from the register, now answerable from telemetry');
});

test('lastFailure is published even when the breaker stays closed', async () => {
  const lane = new Lane(cfg);
  await assert.rejects(() => lane.submit(fail('timeout', 'rpc timeout after 90000ms'), { key: 'x', label: 'getblockstats' }));
  assert.equal(lane.breakerOpen, false);
  assert.equal(lane.breakerState().lastFailure.label, 'getblockstats');
  assert.equal(lane.breakerState().lastFailure.kind, 'timeout');
  assert.equal(lane.breakerState().consecutive, 1, 'how close to tripping, as a number');
});
