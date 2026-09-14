// THE 41-SECOND CALL (2026-09-11, first run against Bitcoin Core v31.99): gettxoutsetinfo with no
// hash_type means "hash_serialized_3", a full walk of the UTXO set -- 41.47 s on Core with 165.2 M
// outputs, against 0.003 s for "muhash". In a lane that holds one request at a time that single
// call stretched every tier, dropped 43 polls as stale, and disabled coinbase attribution and the
// block template. These tests exist so it cannot come back unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../server/collect/monitor.js', import.meta.url), 'utf8');

test('gettxoutsetinfo is never called without an explicit hash_type', () => {
  const calls = [...src.matchAll(/method: 'gettxoutsetinfo'([^}]*)}/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, 'the call is still made somewhere');
  for (const args of calls) {
    assert.match(args, /params: \['muhash'\]/, `gettxoutsetinfo called without params: …${args}`);
  }
});

test('a node with no synced coinstatsindex is not asked for UTXO stats at all', async () => {
  const { NodeMonitor } = await import('../server/collect/monitor.js');
  const want = NodeMonitor.prototype.utxoStatsWanted;
  assert.equal(typeof want, 'function');
  const at = (indexes) => want.call({ state: { indexes } });
  assert.equal(at(undefined), false, 'not known yet: NOT asked -- getindexinfo goes first, alone (2026-09-14: the blind first ask was a full UTXO walk on a node without the index)');
  assert.equal(at({}), false, 'a node that reports no indexes is NOT asked: without the index the call is a full UTXO walk');
  assert.equal(at({ coinstatsindex: { synced: true, best_block_height: 966573 } }), true, 'indexed: ask');
  assert.equal(at({ coinstatsindex: { synced: false, best_block_height: 100 } }), false, 'still building: do not ask');
  assert.equal(at({ txindex: { synced: true } }), false, 'a node without the coinstatsindex key has no coinstatsindex -- this is what Core answers with it off, and what walked the Mac\'s UTXO set every minute');
});

test('the skip states its reason and is retracted when the index appears', () => {
  assert.match(src, /flagQuality\('utxo-unindexed'/, 'the skip is stated');
  assert.match(src, /-coinstatsindex/, 'and names the flag that fixes it');
  assert.match(src, /clearQuality\('utxo-unindexed'\)/, 'and is retracted once the index is there');
});
