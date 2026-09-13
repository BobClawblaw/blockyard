import test from 'node:test';
import assert from 'node:assert/strict';
import { Lane, RpcError } from '../server/rpc/client.js';

const cfg = { maxInFlight: 1, minIntervalMs: 0, maxRatePerSec: 1000, staleDropMs: 200, breakerThreshold: 3, breakerCooldownMs: 50, slowLatencyMs: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a long-running heavy call does not starve a cheap high-priority poll', async () => {
  const lane = new Lane(cfg);
  const order = [];
  // Simulate the measured condition: one batch holding the lane for ~60 ms while
  // cheap polls arrive behind it. Without priorities the cheap poll is last.
  // WAIT ON A SIGNAL, NOT A SLEEP. This used to `await sleep(5)` to "let it start", which is a
  // race: on a loaded machine (the full suite runs this alongside everything else) those 5 ms can
  // elapse before the heavy task reaches its first await, the lane is still free, and the cheap
  // poll runs first -- order comes out ['cheap','heavy'] and the assertion fails. Measured across
  // this session's logs: 4 failures in ~40 full-suite runs, 0 in 8 isolated runs. The heavy task
  // now tells us when it is genuinely holding the lane.
  let started; const holding = new Promise((r) => { started = r; });
  const heavy = lane.submit(async () => { started(); await sleep(60); order.push('heavy'); }, { key: 'slow', priority: 5 });
  await holding;
  const cheap1 = lane.submit(async () => { order.push('cheap-superseded'); }, { key: 'fast', priority: 0 });
  const cheap2 = lane.submit(async () => { order.push('cheap'); }, { key: 'fast', priority: 0 });
  await Promise.allSettled([heavy, cheap1, cheap2]);
  assert.deepEqual(order, ['heavy', 'cheap'], 'the newest cheap poll runs as soon as the lane frees');
});

test('the newest poll for the same tier wins and the older one reports itself superseded', async () => {
  const lane = new Lane(cfg);
  const seen = [];
  let began; const held = new Promise((r) => { began = r; });
  const blockers = lane.submit(async () => { began(); await sleep(40); return 'blocker'; }, { key: 'b', priority: 9 });
  await held;   // the same race as above: a sleep here is a coin flip under load
  const a = lane.submit(async () => seen.push('a'), { key: 'fast', priority: 0 });
  const b = lane.submit(async () => seen.push('b'), { key: 'fast', priority: 0 });
  await Promise.allSettled([blockers, a, b]);
  assert.deepEqual(seen, ['b'], 'only the fresh question is asked');
  const r = await Promise.allSettled([a, b]);
  assert.equal(r[0].status, 'rejected');
  assert.equal(r[0].reason.kind, 'stale');
  assert.match(r[0].reason.message, /superseded/);
});

test('a poll that cannot be answered inside its freshness budget is dropped, not run late', async () => {
  const lane = new Lane(cfg);
  const blocker = lane.submit(() => sleep(400), { key: 'x', priority: 0 });
  await sleep(5);
  const stale = await lane.submit(async () => 'should not run', { key: 'y', priority: 1, maxWaitMs: 30 }).catch((e) => e);
  assert.ok(stale instanceof RpcError);
  assert.equal(stale.kind, 'stale');
  assert.equal(lane.stats.staleDropped, 1, 'a deliberate drop is counted as a drop, not an error');
  assert.equal(lane.stats.errors, 0, 'dropping our own question must not look like a node failure');
  lane.pending.clear();
  await blocker.catch(() => {});
});

test('the breaker opens on real transport failures but not on stale drops', async () => {
  const lane = new Lane({ ...cfg, breakerThreshold: 2, staleDropMs: 5000 });
  await Promise.allSettled([
    lane.submit(() => Promise.reject(new RpcError('boom', { kind: 'transport' }))),
    lane.submit(() => Promise.reject(new RpcError('boom', { kind: 'transport' }))),
  ]);
  assert.ok(lane.breakerOpen, 'two transport failures should open the breaker');
  assert.equal(lane.stats.breakerTrips, 1);
  const blocked = await lane.submit(async () => 'x').catch((e) => e);
  assert.equal(blocked.kind, 'breaker');
});

test('unkeyed jobs are each removed from the pending map (the recursion bug)', async () => {
  // Regression: anonymous jobs were stored under a generated map key but deleted
  // by their null dedupe key, so _drain re-read the same stale entry forever and
  // blew the stack. Three stale anonymous jobs must settle, not recurse.
  const lane = new Lane(cfg);
  const blocker = lane.submit(() => sleep(300), { key: 'hold', priority: 0 });
  await sleep(5);
  const results = await Promise.allSettled([
    lane.submit(async () => 1, { maxWaitMs: 10 }),
    lane.submit(async () => 2, { maxWaitMs: 10 }),
    lane.submit(async () => 3, { maxWaitMs: 10 }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected']);
  for (const r of results) assert.equal(r.reason.kind, 'stale');
  assert.equal(lane.queued, 0, 'the pending map must be emptied, or _drain loops forever');
  lane.pending.clear();
  await blocker.catch(() => {});
});

// ---- adaptive cadence -------------------------------------------------
// effectiveTierMs is exercised on a monitor built just far enough to hold its
// config; nothing is started and no socket is opened.
import { NodeMonitor } from '../server/collect/monitor.js';

const noopLog = () => {};
noopLog.child = () => noopLog;
const monitorWith = (avgLatencyMs) => {
  const m = new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1' },
    {
      rpc: { maxInFlight: 1, minIntervalMs: 250, maxRatePerSec: 4, timeoutMs: 90000, heavyTimeoutMs: 300000, staleDropMs: 12000, slowLatencyMs: 5000, breakerThreshold: 3, breakerCooldownMs: 30000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000, blockBackfill: 30 },
      store: { tailBytes: 1024 },
      log: noopLog,
      history: { record: () => {}, ring: () => ({ series: () => [], tail: () => [] }) },
    },
  );
  m.rpc.lane.stats.avgLatencyMs = avgLatencyMs;
  return m;
};

test('cadence is exactly the configured interval while the node is responsive', () => {
  const m = monitorWith(10);
  assert.equal(m.effectiveTierMs('fast'), 4000);
  assert.equal(m.effectiveTierMs('mid'), 15000);
  assert.equal(m.effectiveTierMs('slow'), 60000);
  assert.equal(m.effectiveTierMs('rare'), 900000);
});

test('cadence stretches when the node is slow', () => {
  const m = monitorWith(8000); // 8s average
  assert.ok(m.effectiveTierMs('fast') > 4000);
  assert.ok(m.effectiveTierMs('mid') >= 16000, `expected >=16000, got ${m.effectiveTierMs('mid')}`);
});

test('the rare tier is never stretched BELOW its configured 15 minutes', () => {
  // Regression, found on the live node: a cap of min(base*8, 180s) clamped the
  // 900s tier DOWN to 180s, so the most expensive tier ran five times as often
  // as configured. A cap must be a ceiling, never a floor.
  const m = monitorWith(10);
  assert.equal(m.effectiveTierMs('rare'), 900_000);
  const slow = monitorWith(45_000);
  assert.equal(slow.effectiveTierMs('rare'), 900_000, 'even at 45s RPC latency the 15-min tier stays at 15 min');
});

test('the fast tier stretches but is capped, so a wedged node is not hammered', () => {
  const m = monitorWith(120_000); // pathological
  const fast = m.effectiveTierMs('fast');
  assert.ok(fast >= 4000 && fast <= 32_000, `fast cadence out of range: ${fast}`);
});

test('cadence recovers on its own once the node answers quickly again', () => {
  const m = monitorWith(70_000);
  assert.ok(m.effectiveTierMs('mid') > 15000);
  m.rpc.lane.stats.avgLatencyMs = 5;
  m.lastTierMs.mid = 0;
  assert.equal(m.effectiveTierMs('mid'), 15000);
});

test('an unknown tier asks for nothing', () => {
  assert.equal(monitorWith(10).effectiveTierMs('nonsense'), null);
});
