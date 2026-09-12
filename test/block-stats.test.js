// The Block size chart on the Chain page was empty for a day. The cause was not the
// node and not the UI: the monitor asked getblockstats for 'size', 'weight' and
// 'strippedsize', which are getblock fields and have never been getblockstats
// statistics. An endpoint answers a request for a statistic it does not have by
// omitting it, so every other figure on the row filled in and this one never did.
// Measured 2026-09-09 (MEASUREMENTS 24): the fictional request returns 31 keys with no
// size in them; total_size / total_weight return 1,579,815 B and 3,991,545 WU.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeMonitor, BLOCKSTATS_FIELDS } from '../server/collect/monitor.js';
import { History } from '../server/store/history.js';

function makeMonitor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-blockstats-'));
  const store = { ringCapacity: 500, maxEventLog: 200, retentionHours: 1, snapshotEveryMs: 1e9, auditMaxBytes: 1 << 20, auditKeep: 2 };
  const logger = () => {}; logger.child = () => logger;
  return new NodeMonitor(
    { id: 't', label: 't', rpcUrl: 'http://127.0.0.1:1', datadir: dir, chainHint: 'main', logFile: null },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 1000, slowLatencyMs: 5000 },
      poll: { fastMs: 4000, midMs: 15000, slowMs: 60000, rareMs: 900000 },
      store, log: logger, history: new History(dir, store, { log: logger }), logCfg: {} });
}

/** A reply shaped like this node's, from the real RPC console at height 966253. */
const NODE_REPLY = {
  height: 966253, blockhash: '00'.repeat(32), time: 1788977562, mediantime: 1788977400,
  txs: 5631, totalfee: 1328314, total_size: 1579815, total_weight: 3991545,
  mediantxsize: 221, avgtxsize: 280, swtotal_size: 1403359, swtxs: 4103,
  subsidy: 312500000, ins: 5700, outs: 6100, avgfee: 235, medianfee: 180, maxfee: 40210,
  feerate_percentiles: [0, 0, 0, 1, 4], utxo_increase: 400,
};

function withRpc(reply) {
  const m = makeMonitor();
  m.rpc = {
    batch: async (calls) => calls.map((c) => ({ ok: true, result: reply ? { ...reply } : undefined })),
    telemetry: () => ({ ratePerSec: 0, queued: 0, errors: 0, breakerTrips: 0, busyMsPerSec: 0, avgLatencyMs: null, latencyMs: null }),
  };
  return m;
}

test('the field list asks for statistics the endpoint actually has', () => {
  // The guard against the specific mistake, because the mistake was invisible: a batch
  // of unanswered names returns no error, just a missing key forever.
  assert.ok(BLOCKSTATS_FIELDS.includes('total_size'), "size comes from 'total_size'");
  assert.ok(BLOCKSTATS_FIELDS.includes('total_weight'), "weight comes from 'total_weight'");
  for (const fiction of ['size', 'weight', 'strippedsize']) {
    assert.ok(!BLOCKSTATS_FIELDS.includes(fiction), `'${fiction}' is a getblock field, not a getblockstats statistic`);
  }
});

test('a block row carries size, its basis, and the figures this node publishes', async () => {
  const m = withRpc(NODE_REPLY);
  const rows = await m.fetchBlockStats([966253]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.size, 1579815, "total_size is mapped to size");
  assert.equal(row.weight, 3991545);
  assert.match(row.sizeBasis, /sum of transaction sizes/, 'the basis travels with the number');
  assert.match(row.sizeBasis, /header/, 'and says what is excluded');
  assert.equal(row.sizeMissing, null);
  assert.equal(row.medianTxSize, 221, 'fields the node publishes are stored, not dropped');
  assert.equal(row.swtotalSize, 1403359);
  assert.equal(row.swtxs, 4103);
  await m.stop();
});

test('a reply without total_size reports the hole, it does not draw a zero', async () => {
  const noSize = { ...NODE_REPLY }; delete noSize.total_size; delete noSize.total_weight;
  const m = withRpc(noSize);
  const [row] = await m.fetchBlockStats([966253]);
  assert.equal(row.size, null, 'absent is absent');
  assert.equal(row.weight, null);
  assert.match(row.sizeMissing, /without total_size/, 'and the absence names itself');
  assert.equal(row.sizeBasis, null);
  await m.stop();
});

test('the snapshot exposes the newest row so the panel can state the basis', async () => {
  const m = withRpc(NODE_REPLY);
  await m.fetchBlockStats([966253]);
  const s = m.snapshot({ seriesRanges: {} });
  assert.equal(s.blocks.recent[0].size, 1579815);
  assert.match(s.blocks.recent[0].sizeBasis, /getblockstats total_size/);
  await m.stop();
});
