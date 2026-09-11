// Who mined a block, from the coinbase bytes -- and the three decoding traps that real
// blocks on this node put in front of us, each with the block it was measured on
// (2026-09-09). Attribution is the kind of wrong that gets quoted: a block credited to
// the wrong pool is worse than one credited to nobody, so every path here either reads
// the bytes or says it could not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCoinbase, cleanTag, matchPool, printableRuns, minerRow, ledgerApply, ledgerRows } from '../server/collect/mining.js';

// Real coinbase scriptSigs, frozen verbatim from the node's own getrawtransaction output.
const VIA_966257 = '0371be0e182f5669614254432f4d696e6564206279206563676274632f2cfabe6d6d45e41fb06b52616e8dd47f3fa758b8dbaa8391007ca039ee26f82af0539aef4b1000000000000000109e74ee03707b21e119abff70a7d5000000000000';
const ANTDPOOL_966253 = '036dbe0e1b4d696e656420627920416e74506f6f6c39373115002200e1367b6dfabe6d6db59741b432ad63c8cdb051f195c1ff163c30a08895c4812a';
// Foundry's 50-byte scriptSig declares a 47-byte push it does not have room for, so the
// strict push walk ends with no tag even though the name is plain ASCII in the block.
const FOUNDRY_966258 = '0372be0e056f02bbab002f466f756e6472792055534120506f6f6c202364726f70676f6c642f145afc22000079ecfa9d01';

test('BIP34 height is read little-endian and agrees with the block', () => {
  assert.equal(decodeCoinbase(VIA_966257).height, 966257);
  assert.equal(decodeCoinbase(FOUNDRY_966258).height, 966258);
});

test('a tag sharing its frame with the extra nonce still reads', () => {
  const d = decodeCoinbase(ANTDPOOL_966253);
  assert.equal(d.tagText, 'Mined by AntPool971', 'printable prefix, not the whole frame');
  assert.equal(d.tag, 'antpool971');
  assert.equal(d.tagSource, 'push');
});

test('a scriptSig with a broken push length falls back to a run scan, and says so', () => {
  const d = decodeCoinbase(FOUNDRY_966258);
  assert.match(d.tagText, /Foundry USA Pool #dropgold/);
  assert.equal(d.tag, 'foundry');
  assert.equal(d.tagSource, 'scan', 'the weaker method must be identifiable in the row');
  assert.ok(printableRuns(FOUNDRY_966258, 4).some((r) => /Foundry/.test(r.text)));
});

test('the witness commitment is recovered from the unparsed tail, and its absence is not invented', () => {
  // ViaBTC's commitment sits past where the strict walk stops; Foundry's 50-byte
  // scriptSig genuinely contains no fabe6d6d at all -- the pool's own bytes end mid-push
  // -- so the honest answer for that block is null, not a recovered value.
  assert.equal(decodeCoinbase(VIA_966257).commitment, 'fabe6d6d');
  assert.equal(decodeCoinbase(VIA_966257).commitmentData.startsWith('45e41fb0'), true);
  assert.equal(decodeCoinbase(FOUNDRY_966258).commitment, null);
});

test('a coinbase that is not pushes at all is reported unparseable, not guessed', () => {
  const d = decodeCoinbase('ffff00ff');
  assert.equal(d.tag, null);
  assert.equal(d.tagText, null);
  assert.ok(!d.parseable || d.tagSource == null, 'no tag without a source');
});

test('cleanTag skips the verbs, and an unreadable tag stays countable', () => {
  assert.equal(cleanTag('/ViaBTC/Mined by ecgbtc/'), 'viabtc');
  assert.equal(cleanTag('Mined by AntPool971'), 'antpool971');
  const row = minerRow({ height: 1, decoded: { parseable: true, raw: 'ff' }, stats: { height: 1 } });
  assert.match(row.poolKey, /^unknown:/, 'no name is better than a wrong one, but it still counts');
});

const MAP = {
  matchers: [
    { tagNorm: 'foundry usa pool', key: 'foundry usa', name: 'Foundry USA', tag: 'Foundry USA Pool' },
    { tagNorm: 'mined by antpool', key: 'antpool', name: 'AntPool', tag: 'Mined By AntPool' },
    { tagNorm: '/viabtc/', key: 'viabtc', name: 'ViaBTC', tag: '/ViaBTC/' },
  ],
};

test('curated labels match on literal coinbase text, longest first, unknown stays unknown', () => {
  assert.equal(matchPool(MAP, { rawHex: FOUNDRY_966258 }).name, 'Foundry USA');
  assert.equal(matchPool(MAP, { tagText: 'Mined by AntPool971' }).name, 'AntPool', 'a sub-pool id folds into its curated label');
  assert.equal(matchPool(MAP, { tagText: 'Mined by AntPool971' }).matchedTag, 'Mined By AntPool', 'which tag matched is recorded');
  assert.equal(matchPool(MAP, { tagText: '/ViaBTC/Mined by ecgbtc/' }).name, 'ViaBTC');
  assert.equal(matchPool(MAP, { tagText: 'some pool nobody listed' }), null, 'no match means no label');
  assert.equal(matchPool(null, { tagText: 'x' }), null);
});

test('the ledger counts what it saw and keeps the raw tags a row was built from', () => {
  const ledger = new Map();
  const seen = [[10, 'Mined by AntPool971'], [11, 'Mined by AntPool971'], [12, '/F2Pool/abc']];
  for (const [h, tag] of seen) {
    ledgerApply(ledger, minerRow({
      height: h, decoded: { parseable: true, raw: '00', tagText: tag, tag: cleanTag(tag) },
      stats: { height: h, weight: 4e6, avgFeerate: 2 },
    }));
  }
  const rows = ledgerRows(ledger);
  assert.equal(rows.length, 2, 'two distinct tag keys, no silent merging');
  const antpool = rows.find((r) => r.poolKey === 'antpool971');
  assert.equal(antpool.blocks, 2);
  assert.equal(antpool.sharePct, 66.7, 'a share of the observed window, which the window makes meaningful');
  assert.deepEqual(antpool.tags, ['Mined by AntPool971'], 'the bytes behind a count, so a grouping can be audited');
  assert.ok(rows.every((r) => r.avgWeight === 4e6 && r.medianFeeRate === 2));
});
