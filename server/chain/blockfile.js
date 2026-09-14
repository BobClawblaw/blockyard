// CORE'S BLOCK AND UNDO FILES, READ DIRECTLY (docs/DEFECTS.md: "we can read the block files after
// all -- -blocksxor, not an unknown format").
//
// blocks/blkNNNNN.dat holds blocks as Core received them: [magic][u32 size][block bytes], repeated.
// blocks/revNNNNN.dat holds the undo data Core wrote when it CONNECTED those blocks:
// [magic][u32 size][undo bytes][32-byte checksum]. Undo data is the one thing that turns a raw block
// into a full one -- for every input, the output it spent (value, script, height, coinbase or not).
// It is what `getblock <hash> 3` reads to report `prevout`, and it is what an address index needs for
// the spending side, without replaying the whole UTXO set.
//
// Since Core v28 both files are XOR-obfuscated at rest with the 8-byte key in blocks/xor.dat, applied
// by absolute file offset. An all-zero key is the old unobfuscated layout, so both read the same way.
//
// READ-ONLY, and it must stay so: these are the node's own files. Nothing here opens a file for
// writing, and the reader copes with the last file being appended to while it reads.
//
// Checked against the node: scripts/blockfile-measure.js --verify compares decoded undo coins with
// `getblock <hash> 3` prevouts for whole blocks.
import { openSync, readSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hash256, classifyScript } from './tx.js';

export const MAGIC = Object.freeze({ main: 0xd9b4bef9, test: 0x0709110b, testnet4: 0x283f161c, signet: 0x40cf030a, regtest: 0xdab5bffa });

export function xorKey(blocksDir) {
  try { return readFileSync(path.join(blocksDir, 'xor.dat')); } catch { return Buffer.alloc(8); }
}

// XOR `buf` in place as the bytes that start at absolute file offset `offset`
export function unxor(buf, key, offset = 0) {
  if (!key || key.every((b) => b === 0)) return buf;
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[(offset + i) % key.length];
  return buf;
}

/** A whole file, de-obfuscated, as one Buffer. Files are ~128 MB; reading whole is the fast path. */
export function readChainFile(file, key) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(size);
    let got = 0;
    while (got < size) { const n = readSync(fd, buf, got, size - got, got); if (n === 0) break; got += n; }
    return unxor(buf.subarray(0, got), key, 0);
  } finally { closeSync(fd); }
}

/**
 * The records in a de-obfuscated blk or rev file: { offset, size, body } for each, where body is a
 * subarray (no copy). `trailer` is 32 for rev files (the checksum after each record), 0 for blk.
 * A zero magic is the unwritten tail Core preallocates, so framing stops there.
 */
export function* records(buf, magic = MAGIC.main, trailer = 0) {
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const m = buf.readUInt32LE(pos);
    if (m === 0) return;                                    // preallocated, never written
    if (m !== magic) throw new Error(`bad magic ${m.toString(16)} at offset ${pos}`);
    const size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (start + size + trailer > buf.length) return;       // the file is still being written
    yield { offset: pos, size, body: buf.subarray(start, start + size), ...(trailer ? { checksum: buf.subarray(start + size, start + size + trailer) } : {}) };
    pos = start + size + trailer;
  }
}

// --- undo data -----------------------------------------------------------
// Core's VARINT (serialize.h), which is NOT CompactSize: MSB base-128 with an offset per byte.
function readVarInt(buf, st) {
  let n = 0;
  for (;;) {
    const b = buf[st.pos++];
    if (b === undefined) throw new RangeError('truncated VARINT');
    n = n * 128 + (b & 0x7f);
    if (b & 0x80) n += 1; else return n;
  }
}
function readCompactSize(buf, st) {
  const b = buf[st.pos++];
  if (b < 0xfd) return b;
  if (b === 0xfd) { const v = buf.readUInt16LE(st.pos); st.pos += 2; return v; }
  if (b === 0xfe) { const v = buf.readUInt32LE(st.pos); st.pos += 4; return v; }
  const v = Number(buf.readBigUInt64LE(st.pos)); st.pos += 8; return v;
}

// compressor.cpp DecompressAmount
export function decompressAmount(x) {
  if (x === 0) return 0;
  x -= 1;
  let e = x % 10;
  x = Math.floor(x / 10);
  let n;
  if (e < 9) { const d = (x % 9) + 1; x = Math.floor(x / 9); n = x * 10 + d; } else { n = x + 1; }
  while (e > 0) { n *= 10; e--; }
  return n;
}

// secp256k1 point decompression, for the two compressed forms of an uncompressed-key P2PK script
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
function decompressPubkey(prefix, x32) {
  const x = BigInt('0x' + x32.toString('hex'));
  let y = modpow((x * x * x + 7n) % P, (P + 1n) / 4n, P);
  if ((y & 1n) !== BigInt(prefix & 1)) y = P - y;
  return Buffer.concat([Buffer.from([0x04]), x32, Buffer.from(y.toString(16).padStart(64, '0'), 'hex')]);
}

// compressor.cpp: sizes 0-5 are special script templates, 6+ a raw script of (size - 6) bytes
function readCompressedScript(buf, st) {
  const size = readVarInt(buf, st);
  const take = (n) => { const v = buf.subarray(st.pos, st.pos + n); st.pos += n; return v; };
  switch (size) {
    case 0: return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), take(20), Buffer.from([0x88, 0xac])]);
    case 1: return Buffer.concat([Buffer.from([0xa9, 0x14]), take(20), Buffer.from([0x87])]);
    case 2: case 3: return Buffer.concat([Buffer.from([0x21, size]), take(32), Buffer.from([0xac])]);
    case 4: case 5: return Buffer.concat([Buffer.from([0x41]), decompressPubkey(size - 2, take(32)), Buffer.from([0xac])]);
    default: return Buffer.from(take(size - 6));
  }
}

/**
 * One block's undo record: for each non-coinbase transaction in block order, the coins its inputs
 * spent, in input order -- { height, coinbase, value_sat, script }.
 */
export function decodeBlockUndo(body) {
  const st = { pos: 0 };
  const ntx = readCompactSize(body, st);
  const txs = new Array(ntx);
  for (let i = 0; i < ntx; i++) {
    const nin = readCompactSize(body, st);
    const coins = new Array(nin);
    for (let j = 0; j < nin; j++) {
      const code = readVarInt(body, st);
      const height = Math.floor(code / 2);
      if (height > 0) readVarInt(body, st);                  // the legacy nVersion placeholder, always 0
      const value_sat = decompressAmount(readVarInt(body, st));
      const script = readCompressedScript(body, st);
      coins[j] = { height, coinbase: (code & 1) === 1, value_sat, script };
    }
    txs[i] = coins;
  }
  if (st.pos !== body.length) throw new RangeError(`${body.length - st.pos} bytes left after the undo record`);
  return txs;
}

/** The input counts an undo record describes, without building coins: cheap enough to match on. */
export function undoShape(body) {
  const st = { pos: 0 };
  const ntx = readCompactSize(body, st);
  const counts = new Array(ntx);
  for (let i = 0; i < ntx; i++) {
    const nin = readCompactSize(body, st);
    counts[i] = nin;
    for (let j = 0; j < nin; j++) {
      const height = Math.floor(readVarInt(body, st) / 2);
      if (height > 0) readVarInt(body, st);
      readVarInt(body, st);
      const size = readVarInt(body, st);
      st.pos += size === 0 || size === 1 ? 20 : size < 6 ? 32 : size - 6;
    }
  }
  return counts;
}

/** Core's checksum over an undo record: hash256(previous block hash || undo bytes). */
export function undoChecksumMatches(record, prevHashHex) {
  const prev = Buffer.from(prevHashHex, 'hex').reverse();
  return hash256(Buffer.concat([prev, record.body])).equals(record.checksum);
}

/**
 * Pair each block with its undo record. `blocks` are { hash, previousblockhash, ntx } in file order;
 * the result is a Map from block index to undo record. Blocks with no undo (never connected, or
 * stale) are simply absent. Every pairing is proven by Core's checksum, never assumed.
 *
 * IN CHAIN ORDER, NOT BY SEARCH. Core appends an undo record when it CONNECTS a block, so a rev file
 * lists its blocks in chain order, while the blk file lists them as they arrived. Two searches were
 * tried first and both were quadratic where the chain is dense with small blocks: trying every
 * candidate of the same transaction count ran file 0 for 35 minutes without finishing, and hashing
 * once per distinct body still took 230 s, because blocks of one or two ordinary transactions each
 * have a unique record. Here each file's blocks are put in chain order by their previous-block
 * links, the undo records are walked in their own order, and the next unpaired block of the right
 * shape is checked first -- almost always the one. A miss (a reorg, a stale block) looks a little
 * further ahead, and only then searches the whole shape group.
 */
export function pairBlocksWithUndo(blocks, undoRecords) {
  const byHash = new Map(blocks.map((b, i) => [b.hash, i]));
  // depth within this file along previous-block links: roots are blocks whose parent is elsewhere
  const depth = new Array(blocks.length).fill(-1);
  const depthOf = (i) => {
    const path = [];
    let j = i;
    while (j !== undefined && depth[j] === -1) { path.push(j); depth[j] = -2; j = byHash.get(blocks[j].previousblockhash); }
    let d = j === undefined || depth[j] < 0 ? -1 : depth[j];
    for (let k = path.length - 1; k >= 0; k--) depth[path[k]] = ++d;
    return depth[i];
  };
  for (let i = 0; i < blocks.length; i++) if (depth[i] === -1) depthOf(i);
  const groups = new Map();                        // non-coinbase tx count -> block indices in chain order
  const order = blocks.map((_, i) => i).sort((x, y) => depth[x] - depth[y] || x - y);
  for (const i of order) { const c = blocks[i].ntx - 1; (groups.get(c) ?? groups.set(c, { list: [], next: 0 }).get(c)).list.push(i); }
  const taken = new Uint8Array(blocks.length);
  const out = new Map();
  const prevBuf = (i) => Buffer.from(blocks[i].previousblockhash, 'hex').reverse();
  const matches = (i, u) => hash256(Buffer.concat([prevBuf(i), u.body])).equals(u.checksum);
  for (const u of undoRecords) {
    const g = groups.get(undoShape(u.body).length);
    if (!g) continue;
    while (g.next < g.list.length && taken[g.list[g.next]]) g.next++;
    let found = -1;
    for (let k = g.next, tried = 0; k < g.list.length && tried < 32; k++) {
      const i = g.list[k];
      if (taken[i]) continue;
      tried++;
      if (matches(i, u)) { found = i; break; }
    }
    if (found < 0) for (const i of g.list) if (!taken[i] && matches(i, u)) { found = i; break; }
    if (found >= 0) { taken[found] = 1; out.set(found, u); }
  }
  return out;
}

export { classifyScript };
