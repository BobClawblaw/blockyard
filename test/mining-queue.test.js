// THE ATTRIBUTION QUEUE MUST SURVIVE A FAILURE.
//
// (operator, 2026-09-13, looking at an Umbrel whose Mining page was empty: "ah yes fix that".)
//
// pumpMining used to do `this.miningQueue.length = 0` when one block's getblock or
// getrawtransaction failed. Nothing ever put that work back: enqueueMining is called only by
// onNewTip (the heights that just arrived) and by backfillBlocks (once, at boot), and the enqueue
// path skips heights already in `mining.rows` -- which a failed height never reaches. So a single
// stale-dropped call discarded the entire 36-block boot window permanently, and with perTick:1 the
// page refilled one block at a time as new blocks were mined.
//
// Observed on a real node: windowBlocks=0 with lastError frozen at "waited 18068ms for a lane free
// enough to answer meaningfully", while the same code against a local node attributed 30 blocks
// across 9 pools. The node was answering these calls in ~100-300 ms by then; the queue was simply
// empty and nothing refilled it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeMonitor } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

const COINBASE = '03a1b40c04deadbeef082f4d696e656420627920416e74506f6f6c2f';

function monitor({ perTick = 4 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-mq-'));
  const store = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9, blockMapCap: 500, auditMaxBytes: 1 << 20, auditKeep: 2 };
  const logger = () => {}; logger.child = () => logger;
  const m = new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null },
    { rpc: { maxInFlight: 1, minIntervalMs: 0, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {},
      miningCfg: { backfill: 36, perTick, enabled: true } });
  m.state.chainInfo = { blocks: 1000, initialblockdownload: false };
  for (let h = 995; h <= 1000; h++) m.state.blocks.set(h, { height: h, hash: `hash${h}`, time: 1789000000 });
  return m;
}

/** getblock + getrawtransaction answers, with `failFor` heights rejected once. */
function stubRpc(m, { failHashes = new Set(), onCall = () => {} } = {}) {
  m.rpc.batch = async (calls) => {
    const c = calls[0];
    onCall(c.method, c.params);
    if (c.method === 'getblock') {
      const hash = c.params[0];
      if (failHashes.has(hash)) throw new Error('dropped: waited 18068ms for a lane free enough to answer meaningfully');
      return [{ ok: true, result: { tx: [`cb-${hash}`], time: 1789000000, nTx: 2, strippedsize: 1, size: 1, weight: 4 } }];
    }
    if (c.method === 'getrawtransaction') {
      return [{ ok: true, result: { vin: [{ coinbase: COINBASE }], vout: [{ value: 3.125 }] } }];
    }
    return [{ ok: false, error: { message: `unexpected ${c.method}` } }];
  };
}

test('one failed block does not discard the rest of the queue', async () => {
  // THE REGRESSION THIS FILE EXISTS FOR. Before the fix, `attributed` came back as 0: the failure
  // emptied the queue and the five healthy heights were never attempted.
  const m = monitor({ perTick: 10 });
  stubRpc(m, { failHashes: new Set(['hash1000']) });     // newest height fails
  m.enqueueMining([995, 996, 997, 998, 999, 1000]);
  await new Promise((r) => setTimeout(r, 50));
  await m.pumpMining();

  assert.ok(m.miningQueue.length > 0 || m.mining.rows.size > 0,
    'the queue must not be emptied by a single failure');
  assert.ok(m.miningQueue.includes(1000), 'the failed height is put back, not dropped');
  assert.equal(m.mining.retryAt > Date.now(), true, 'and a retry is scheduled rather than abandoned');
});

test('the healthy heights attribute once the failing one stops failing', async () => {
  const m = monitor({ perTick: 10 });
  const failing = new Set(['hash1000']);
  stubRpc(m, { failHashes: failing });
  m.enqueueMining([995, 996, 997, 998, 999, 1000]);
  await new Promise((r) => setTimeout(r, 50));
  await m.pumpMining();                       // fails on 1000, requeues, backs off

  failing.clear();                            // the node recovers
  m.mining.retryAt = 0;                       // skip the wait rather than sleep in a test
  await m.pumpMining();

  assert.ok(m.mining.rows.size >= 5,
    `expected the window to attribute after recovery, got ${m.mining.rows.size} rows`);
  assert.equal(m.mining.lastError && m.mining.rows.size === 0, false, 'and it is not left frozen on the old error');
});

test('a persistent failure backs off instead of spinning', async () => {
  let calls = 0;
  const m = monitor({ perTick: 10 });
  stubRpc(m, { failHashes: new Set(['hash1000', 'hash999', 'hash998', 'hash997', 'hash996', 'hash995']), onCall: () => { calls += 1; } });
  m.enqueueMining([999, 1000]);
  await new Promise((r) => setTimeout(r, 50));
  await m.pumpMining();
  const afterFirst = calls;

  await m.pumpMining();                       // immediately again: the backoff must hold it off
  assert.equal(calls, afterFirst, 'a pump inside the backoff window must not call the node again');
  assert.ok(m.mining.failures >= 1, 'failures are counted');
  assert.ok(m.mining.retryAt > Date.now(), 'and a retry time is set');
});

test('a success clears the failure state, so the next slow patch starts from zero', async () => {
  const m = monitor({ perTick: 10 });
  const failing = new Set(['hash1000']);
  stubRpc(m, { failHashes: failing });
  m.enqueueMining([999, 1000]);
  await new Promise((r) => setTimeout(r, 50));
  await m.pumpMining();
  assert.ok(m.mining.failures >= 1);

  failing.clear();
  m.mining.retryAt = 0;
  await m.pumpMining();
  assert.equal(m.mining.failures, 0, 'a successful attribution resets the backoff');
  assert.equal(m.mining.retryAt, 0);
});
