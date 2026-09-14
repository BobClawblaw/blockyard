// The raw transaction and block decoder (server/chain/tx.js), against Bitcoin Core's own answers.
//
// The fixtures are real mainnet transactions, one for every script type Core reported across blocks
// sampled from height 170 to the tip, captured with their `getblock <hash> 2` decoding. The decoder
// has also been replayed over whole blocks against a live node (scripts/decode-check.js): on
// 2026-09-14, 26 blocks from 170 to 930,000 and the 3 at the tip -- 47,507 transactions, 124,129
// outputs -- with every field matching. These fixtures keep that true without a node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeTx, decodeBlock, classifyScript, segwitAddress, base58check, Reader } from '../server/chain/tx.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-tx.json', import.meta.url), 'utf8'));

test('every fixture transaction decodes exactly as Core decoded it', () => {
  const covered = new Set();
  for (const f of FX.txs) {
    const got = decodeTx(f.hex);
    const want = f.expect;
    const at = `${want.txid.slice(0, 12)} (height ${f.height})`;
    for (const k of ['txid', 'hash', 'version', 'size', 'vsize', 'weight', 'locktime']) assert.equal(got[k], want[k], `${at} ${k}`);
    assert.equal(got.vin.length, want.vin.length, `${at} input count`);
    want.vin.forEach((w, i) => {
      const g = got.vin[i];
      if (w.coinbase != null) assert.equal(g.coinbase, w.coinbase, `${at} vin ${i} coinbase`);
      else {
        assert.equal(g.txid, w.txid, `${at} vin ${i} txid`);
        assert.equal(g.vout, w.vout, `${at} vin ${i} vout`);
        assert.equal(g.scriptSig.hex, w.scriptSig, `${at} vin ${i} scriptSig`);
      }
      assert.equal(g.sequence, w.sequence, `${at} vin ${i} sequence`);
      assert.deepEqual(g.txinwitness ?? null, w.txinwitness ?? null, `${at} vin ${i} witness`);
    });
    assert.equal(got.vout.length, want.vout.length, `${at} output count`);
    want.vout.forEach((w, i) => {
      const g = got.vout[i];
      assert.equal(g.value_sat, w.value_sat, `${at} vout ${i} value`);
      assert.equal(g.n, w.n, `${at} vout ${i} n`);
      assert.equal(g.scriptPubKey.hex, w.hex, `${at} vout ${i} script`);
      assert.equal(g.scriptPubKey.type, w.type, `${at} vout ${i} type`);
      assert.equal(g.scriptPubKey.address ?? null, w.address ?? null, `${at} vout ${i} address`);
      covered.add(w.type);
    });
  }
  // the fixture set must keep covering every type the decoder claims to know, or this test weakens
  for (const t of ['pubkey', 'pubkeyhash', 'scripthash', 'multisig', 'nulldata', 'witness_v0_keyhash', 'witness_v0_scripthash', 'witness_v1_taproot', 'anchor', 'nonstandard']) {
    assert.ok(covered.has(t), `a real ${t} output is in the fixtures`);
  }
  assert.ok(FX.txs.some((f) => f.expect.vin[0].coinbase != null && f.expect.vin[0].txinwitness), 'and a segwit coinbase');
  assert.ok(FX.txs.some((f) => f.expect.vin[0].coinbase != null && !f.expect.vin[0].txinwitness), 'and a legacy one');
});

test('the genesis block decodes: header, hash and its one transaction', () => {
  const g = decodeBlock(FX.genesis.hex);
  const want = FX.genesis.expect;
  for (const k of ['hash', 'version', 'merkleroot', 'time', 'bits', 'nonce', 'size', 'nTx']) assert.equal(g[k], want[k], k);
  assert.equal(g.previousblockhash, '0'.repeat(64));
  assert.equal(g.tx[0].txid, want.txid);
  assert.equal(g.tx[0].txid, g.merkleroot, 'a one-transaction block: the merkle root is that transaction');
});

test('addresses: the published BIP173/BIP350 and base58 vectors', () => {
  const hex = (h) => Buffer.from(h, 'hex');
  // BIP173: P2WPKH and P2WSH
  assert.equal(segwitAddress('bc', 0, hex('751e76e8199196d454941c45d1b3a323f1433bd6')), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.equal(segwitAddress('tb', 0, hex('1863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262')),
    'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
  // BIP350: witness v1 (bech32m), v16, and a taproot output
  assert.equal(segwitAddress('bc', 1, hex('751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6')),
    'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y');
  assert.equal(segwitAddress('bc', 16, hex('751e')), 'bc1sw50qgdz25j');
  assert.equal(segwitAddress('tb', 1, hex('000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433')),
    'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c');
  // base58check: the address the genesis coinbase key hashes to
  assert.equal(base58check(0x00, hex('62e907b15cbf27d5425399ebf6f0fb50ebb88f18')), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  // a future witness version is still an address (Core reports witness_unknown with one)
  const unknown = classifyScript(hex('5214751e76e8199196d454941c45d1b3a323f1433bd6'));
  assert.equal(unknown.type, 'witness_unknown');
  assert.equal(unknown.address, segwitAddress('bc', 2, hex('751e76e8199196d454941c45d1b3a323f1433bd6')));
});

test('scripts Core refuses to name are nonstandard, and nothing is guessed', () => {
  const hex = (h) => Buffer.from(h, 'hex');
  assert.equal(classifyScript(hex('0015751e76e8199196d454941c45d1b3a323f1433bd6')).type, 'nonstandard', 'v0 with a 21-byte program');
  assert.equal(classifyScript(hex('6a4c')).type, 'nonstandard', 'OP_RETURN with a push that runs off the end');
  assert.equal(classifyScript(hex('6aac')).type, 'nonstandard', 'OP_RETURN followed by a non-push opcode');
  assert.equal(classifyScript(hex('6a')).type, 'nulldata', 'a bare OP_RETURN is data');
  assert.equal(classifyScript(hex('')).type, 'nonstandard', 'an empty script');
  // testnet encodings where the chain says so
  assert.match(classifyScript(hex('0014751e76e8199196d454941c45d1b3a323f1433bd6'), 'regtest').address, /^bcrt1q/);
  assert.match(classifyScript(hex('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'), 'testnet4').address, /^[mn]/);
});

test('a truncated or padded transaction is an error, never a partial decode', () => {
  const f = FX.txs.find((x) => x.expect.vin[0].txinwitness && x.expect.vin[0].coinbase == null);
  assert.throws(() => decodeTx(f.hex.slice(0, -10)), /truncated/);
  assert.throws(() => decodeTx(f.hex + '00'), /trailing/);
  assert.throws(() => new Reader(Buffer.alloc(8)).bytes(9), RangeError);
});
