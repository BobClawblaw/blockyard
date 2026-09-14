// Core's block and undo files (server/chain/blockfile.js). The pieces are checked against Core's own
// encodings here, offline; whole files were checked against a live node with
// scripts/blockfile-measure.js --verify (every prevout of a block per sampled file, against
// getblock <hash> 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hash256, classifyScript } from '../server/chain/tx.js';
import { unxor, records, decompressAmount, decodeBlockUndo, undoShape, undoChecksumMatches, MAGIC } from '../server/chain/blockfile.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-tx.json', import.meta.url), 'utf8'));

// Core's WriteVarInt (serialize.h), so the test builds records the way Core writes them
function varint(n) {
  const tmp = [];
  for (let len = 0; ; len++) {
    tmp.push((n % 128) | (len ? 0x80 : 0));
    if (n <= 0x7f) break;
    n = Math.floor(n / 128) - 1;
  }
  return Buffer.from(tmp.reverse());
}
// Core's CompressAmount (compressor.cpp), the inverse the decoder must undo
function compressAmount(n) {
  if (n === 0) return 0;
  let e = 0;
  while (n % 10 === 0 && e < 9) { n /= 10; e++; }
  if (e < 9) { const d = n % 10; n = Math.floor(n / 10); return 1 + (n * 9 + d - 1) * 10 + e; }
  return 1 + (n - 1) * 10 + 9;
}

test('amounts decompress exactly as Core compresses them (compress_tests.cpp values)', () => {
  const COIN = 100_000_000, CENT = 1_000_000;
  for (const [amount, compressed] of [[0, 0x0], [1, 0x1], [CENT, 0x7], [COIN, 0x9], [50 * COIN, 0x32], [21_000_000 * COIN, 0x1406f40]]) {
    assert.equal(compressAmount(amount), compressed, `Core compresses ${amount} to ${compressed.toString(16)}`);
    assert.equal(decompressAmount(compressed), amount, `and ${compressed.toString(16)} decompresses to ${amount}`);
  }
  for (let v = 0; v < 200_000; v += 7) assert.equal(decompressAmount(compressAmount(v)), v);
});

test('an undo record decodes every coin: the special script templates, raw scripts, heights and the coinbase flag', () => {
  // the genesis output pays an uncompressed public key; undo data stores it as 33 bytes and the
  // reader has to rebuild the other 32 from the curve
  const g = Buffer.from('4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac', 'hex');   // the genesis output script
  const x = g.subarray(2, 34), yOdd = g[65] & 1;              // byte 65 is the key's last; 66 is OP_CHECKSIG
  const p2pkh = Buffer.from('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac', 'hex');
  const raw = Buffer.from('5120' + '11'.repeat(32), 'hex');                  // a taproot output, stored raw
  const coin = (height, coinbase, amount, scriptBytes) => Buffer.concat([
    varint(height * 2 + (coinbase ? 1 : 0)), ...(height > 0 ? [varint(0)] : []), varint(compressAmount(amount)), scriptBytes,
  ]);
  const body = Buffer.concat([
    Buffer.from([2]),                                                        // two non-coinbase transactions
    Buffer.from([2]),                                                        // the first spends two coins
    coin(9, true, 50 * 1e8, Buffer.concat([varint(4 + yOdd), x])),           // uncompressed-key P2PK, compressed
    coin(170, false, 1e8, Buffer.concat([varint(0), p2pkh.subarray(3, 23)])), // P2PKH template
    Buffer.from([1]),                                                        // the second spends one
    coin(900_000, false, 12_345, Buffer.concat([varint(raw.length + 6), raw])),
  ]);
  const undo = decodeBlockUndo(body);
  assert.deepEqual(undoShape(body), [2, 1], 'the cheap shape read agrees with the full decode');
  assert.equal(undo[0][0].script.toString('hex'), g.toString('hex'), 'the full 65-byte key is rebuilt from the curve');
  assert.equal(undo[0][0].coinbase, true);
  assert.equal(undo[0][0].height, 9);
  assert.equal(undo[0][0].value_sat, 50e8);
  assert.equal(undo[0][1].script.toString('hex'), p2pkh.toString('hex'));
  assert.equal(classifyScript(undo[0][1].script).address, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  assert.equal(undo[1][0].script.toString('hex'), raw.toString('hex'));
  assert.equal(undo[1][0].height, 900_000);
  assert.equal(undo[1][0].value_sat, 12_345);
  assert.throws(() => decodeBlockUndo(Buffer.concat([body, Buffer.from([0])])), /left after/, 'trailing bytes are an error');
});

test('records frame blk and rev files, stop at the preallocated tail, and XOR by absolute offset', () => {
  const key = Buffer.from('e58d6b71eda23569', 'hex');
  const block = Buffer.from(FX.genesis.hex, 'hex');
  const frame = (body, trailer = Buffer.alloc(0)) => {
    const h = Buffer.alloc(8); h.writeUInt32LE(MAGIC.main, 0); h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body, trailer]);
  };
  const file = Buffer.concat([frame(block), frame(block), Buffer.alloc(64)]);   // two blocks, then zeroes
  const onDisk = unxor(Buffer.from(file), key, 0);
  assert.notEqual(onDisk.readUInt32LE(0), MAGIC.main, 'obfuscated, the magic is not visible');
  const back = unxor(Buffer.from(onDisk), key, 0);
  const got = [...records(back, MAGIC.main)];
  assert.equal(got.length, 2, 'both blocks framed, and the zero tail ignored');
  assert.equal(got[1].offset, 8 + block.length);
  assert.ok(got[0].body.equals(block));
  // a record cut off by the end of a file still being written is not returned
  assert.equal([...records(back.subarray(0, 8 + block.length + 20), MAGIC.main)].length, 1);
  // THE LIVE FILE'S TAIL IS RAW ZEROS: Core preallocates without obfuscating, so once the whole file
  // is de-obfuscated that tail reads as the key (found on blk05755.dat: "bad magic 716b8de5")
  const live = Buffer.concat([unxor(Buffer.from(frame(block)), key, 0), Buffer.alloc(64)]);
  const opened = unxor(Buffer.from(live), key, 0);
  assert.throws(() => [...records(opened, MAGIC.main)], /bad magic/, 'without the key the tail looks like garbage');
  assert.equal([...records(opened, MAGIC.main, 0, key)].length, 1, 'with it, the raw zeros are the end of the file');

  // a rev record carries Core's checksum: hash256(previous block hash || undo bytes)
  const undoBody = Buffer.from([0]);
  const prevHex = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
  const checksum = hash256(Buffer.concat([Buffer.from(prevHex, 'hex').reverse(), undoBody]));
  const [rec] = records(frame(undoBody, checksum), MAGIC.main, 32);
  assert.ok(undoChecksumMatches(rec, prevHex), 'the right previous block matches');
  assert.ok(!undoChecksumMatches(rec, '00'.repeat(32)), 'and any other does not');
});

test('undo records pair with their blocks in chain order, even when the blk file holds them out of order', async () => {
  // (the first two pairings were quadratic: 35 minutes and then 230 s on file 0, where thousands of
  // blocks hold only a coinbase and every undo record is the same empty byte)
  const { pairBlocksWithUndo } = await import('../server/chain/blockfile.js');
  const hashOf = (n) => n.toString(16).padStart(64, '0');
  // a chain of 2,000 blocks, every one with an identical empty undo record, stored in the blk file in
  // a shuffled order the way headers-first download leaves them
  const chain = Array.from({ length: 2000 }, (_, h) => ({ hash: hashOf(h + 1), previousblockhash: hashOf(h), ntx: 1 }));
  const body = Buffer.from([0]);
  const undos = chain.map((b) => ({ body, checksum: hash256(Buffer.concat([Buffer.from(b.previousblockhash, 'hex').reverse(), body])) }));
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const inFile = chain.slice().sort(() => rnd() - 0.5);
  const t0 = performance.now();
  const pairs = pairBlocksWithUndo(inFile, undos);
  const took = performance.now() - t0;
  assert.equal(pairs.size, chain.length, 'every block found its record');
  for (const [i, u] of pairs) assert.ok(undoChecksumMatches(u, inFile[i].previousblockhash), 'and every pairing is proven by the checksum');
  assert.ok(took < 2000, `in linear time, not quadratic (${took.toFixed(0)} ms for 2,000 identical records)`);
  // a block with no undo record (stale, or never connected) is left out rather than mis-paired
  const stale = { hash: hashOf(99999), previousblockhash: hashOf(5), ntx: 1 };
  assert.equal(pairBlocksWithUndo([...inFile, stale], undos).size, chain.length);
});
