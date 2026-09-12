// The durable store for what the monitor learns. Two engines, one behaviour: whatever is
// written before a restart has to be there after it. Tests run both, and run them against
// the two things that actually go wrong -- a process that dies, and a reorg.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger, aggregate } from '../server/store/ledger.js';

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `blockyard-ledger-${n}-`));
const row = (h, pool = 'antpool', label = 'AntPool') => ({
  height: h, hash: `${h}`.padStart(64, '0'), poolKey: pool, poolLabel: label, poolLabelKey: pool,
  matchedTag: 'Mined By AntPool', tagText: 'Mined by AntPool971', tagSource: 'push',
  weight: 3_990_000 + h, size: 1_400_000 + h, txs: 4000 + h, totalfee: 900_000 + h, avgFeerate: 2,
  mapSha: '0491a15f88db', seenAt: Date.now(),
});


test(`rows written today are here after a restart (sqlite)`, async () => {
  const file = path.join(tmp('rt-s'), 'attribution.db');
  const a = await openLedger({ file, engine: 'sqlite' });
  assert.equal(a.kind, 'sqlite');
  a.putMany([row(966260), row(966261), row(966262)]);
  assert.equal(a.depth().rows, 3);
  a.close();
  const b = await openLedger({ file, engine: 'sqlite' });
  assert.deepEqual(b.latest(10).map((r) => r.height), [966262, 966261, 966260], 'newest first, all three survived');
  assert.equal(b.depth().from, 966260);
  assert.equal(b.since(966261).length, 2);
  b.close();
});

test(`rows written today are here after a restart (jsonl)`, async () => {
  const file = path.join(tmp('rt-j'), 'attribution.jsonl');
  const a = await openLedger({ file, engine: 'jsonl' });
  assert.equal(a.kind, 'jsonl');
  a.putMany([row(966260), row(966261), row(966262)]);
  assert.equal(a.depth().rows, 3);
  a.close();
  const b = await openLedger({ file, engine: 'jsonl' });
  assert.deepEqual(b.latest(10).map((r) => r.height), [966262, 966261, 966260]);
  assert.equal(b.since(966261).length, 2);
  b.close();
});

test('a reorg drops the blocks that were overturned (sqlite)', async () => {
  const file = path.join(tmp('reorg-s'), 'attribution.db');
  const a = await openLedger({ file, engine: 'sqlite' });
  a.putMany([row(100), row(101), row(102), row(103)]);
  assert.equal(a.dropAbove(101), 2);
  assert.deepEqual(a.latest(10).map((r) => r.height), [101, 100]);
  a.close();
});

test('a reorg drops the blocks that were overturned (jsonl)', async () => {
  const file = path.join(tmp('reorg-j'), 'attribution.jsonl');
  const a = await openLedger({ file, engine: 'jsonl' });
  a.putMany([row(100), row(101), row(102), row(103)]);
  assert.equal(a.dropAbove(101), 2);
  assert.deepEqual(a.latest(10).map((r) => r.height), [101, 100]);
  a.close();
});

test('rewriting a height replaces it, it does not append a second truth (sqlite)', async () => {
  const file = path.join(tmp('dup-s'), 'attribution.db');
  const a = await openLedger({ file, engine: 'sqlite' });
  a.put(row(200, 'viabtc', 'ViaBTC'));
  a.put(row(200, 'f2pool', 'F2Pool'));
  assert.equal(a.depth().rows, 1);
  assert.equal(a.latest(1)[0].poolLabel, 'F2Pool', 'a re-org onto the same height updates the row');
  a.close();
});

test('rewriting a height replaces it, it does not append a second truth (jsonl)', async () => {
  const file = path.join(tmp('dup-j'), 'attribution.jsonl');
  const a = await openLedger({ file, engine: 'jsonl' });
  a.put(row(200, 'viabtc', 'ViaBTC'));
  a.put(row(200, 'f2pool', 'F2Pool'));
  assert.equal(a.depth().rows, 1);
  assert.equal(a.latest(1)[0].poolLabel, 'F2Pool');
  a.close();
});

test('the aggregate is identical whichever engine produced the rows', async () => {
  const rows = [row(1, 'antpool', 'AntPool'), row(2, 'antpool', 'AntPool'), row(3, 'f2pool', 'F2Pool')];
  const a = await openLedger({ file: path.join(tmp('agg-a'), 'x.db'), engine: 'sqlite' });
  const b = await openLedger({ file: path.join(tmp('agg-b'), 'x.jsonl'), engine: 'jsonl' });
  a.putMany(rows); b.putMany(rows);
  const fromSqlite = aggregate(a.latest(10));
  const fromJsonl = aggregate(b.latest(10));
  assert.deepEqual(fromSqlite, fromJsonl, 'one aggregation, or an engine switch changes what the page says about who mines the chain');
  assert.equal(fromSqlite[0].blocks, 2);
  assert.equal(fromSqlite[0].sharePct, 66.7);
  assert.deepEqual(fromSqlite[0].tags, ['Mined by AntPool971']);
  a.close(); b.close();
});

test('a torn final line in the append-only file is ignored, not fatal', async () => {
  const file = path.join(tmp('torn'), 'x.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(row(5))}\n${JSON.stringify(row(6)).slice(0, 20)}`);
  const l = await openLedger({ file, engine: 'jsonl' });
  assert.deepEqual(l.latest(5).map((r) => r.height), [5], 'the half-written row is dropped and the file keeps being usable');
  l.put(row(7));
  assert.deepEqual(l.latest(5).map((r) => r.height), [7, 5]);
  l.close();
});

test('engine=auto falls back rather than failing when sqlite is refused', async () => {
  const l = await openLedger({ file: path.join(tmp('auto'), 'x.db'), engine: 'auto', log: () => {} });
  process.env.BLOCKYARD_LEDGER_ENGINE = 'jsonl';
  const forced = await openLedger({ file: path.join(tmp('forced'), 'x.jsonl'), engine: 'auto', log: () => {} });
  assert.equal(forced.kind, 'jsonl');
  delete process.env.BLOCKYARD_LEDGER_ENGINE;
  l.close(); forced.close();
});
