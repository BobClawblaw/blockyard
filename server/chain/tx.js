// RAW TRANSACTIONS AND BLOCKS, DECODED HERE (docs/DEFECTS.md: "the explorer pays roughly 3-5x for
// verbose RPC it re-parses anyway" and "we can read the block files after all").
//
// One decoder for two jobs. The explorer asks the node for `getrawtransaction <txid> 2` and
// `getblock <hash> 2`, and the node spends most of that reply serializing JSON it could have sent as
// bytes -- measured on the Umbrel, 1,843 ms at verbosity 2 against 373 ms at verbosity 0 for the same
// block. And an address index has to be built from the block files, which hold exactly these bytes.
// Both are this module: bytes in, the fields Core's verbose reply carries out, named the way Core
// names them so a caller can switch source without switching vocabulary.
//
// WHAT IT IS NOT. Raw bytes do not say what an input spends: no prevout value, no prevout address, so
// no fee. Verbosity 2 carries those because Core looks them up in its UTXO/undo data. A caller that
// needs them still has to find the spent outputs -- from the parent transactions, or from an index
// built over the chain. Deciding that is the next step; decoding is this one.
//
// Pure and dependency-free (Rule 1): node:crypto for SHA-256, everything else by hand. Checked
// field-for-field against Core's own verbose output on real blocks (test/chain-tx.test.js carries the
// fixtures; scripts/decode-check.js replays whole blocks from a live node).
import { createHash } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
export const hash256 = (b) => sha256(sha256(b));
const rev = (b) => Buffer.from(b).reverse().toString('hex');

// --- networks ------------------------------------------------------------
// the address encodings of each chain Core names in getblockchaininfo.chain
export const NETWORKS = Object.freeze({
  main: { hrp: 'bc', p2pkh: 0x00, p2sh: 0x05 },
  test: { hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 },
  testnet4: { hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 },
  signet: { hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 },
  regtest: { hrp: 'bcrt', p2pkh: 0x6f, p2sh: 0xc4 },
});
const netOf = (network) => NETWORKS[network] ?? NETWORKS.main;

// --- reading -------------------------------------------------------------
export class Reader {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  need(n) {
    if (this.pos + n > this.buf.length) throw new RangeError(`truncated: need ${n} bytes at ${this.pos} of ${this.buf.length}`);
  }
  u8() { this.need(1); return this.buf[this.pos++]; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`amount ${v} is past the safe integer range`);
    return Number(v);
  }
  varint() {
    const b = this.u8();
    if (b < 0xfd) return b;
    if (b === 0xfd) { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
    if (b === 0xfe) return this.u32();
    return this.u64();
  }
  bytes(n) { this.need(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
}

// --- addresses -----------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58check(version, payload) {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const full = Buffer.concat([body, hash256(body).subarray(0, 4)]);
  let n = BigInt('0x' + full.toString('hex'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of full) { if (byte !== 0) break; out = '1' + out; }
  return out;
}

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
// BIP173 for witness v0, BIP350 (bech32m) for v1 and up
export function segwitAddress(hrp, version, program) {
  const data = [version];
  let acc = 0, bits = 0;
  for (const b of program) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); }
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 31);
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const constant = version === 0 ? 1 : 0x2bc830a3;
  const mod = polymod([...expand, ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
  const check = [];
  for (let i = 0; i < 6; i++) check.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...check].map((d) => CHARSET[d]).join('');
}

// --- addresses back to scripts -------------------------------------------
// The inverse of the encoders above, for lookups that start from an address someone typed. Returns
// the scriptPubKey an address pays, or null for anything that is not a valid address on `network`
// -- a checksum that fails is null, never a best guess.
function base58decode(str) {
  let n = 0n;
  for (const ch of str) { const v = B58.indexOf(ch); if (v < 0) return null; n = n * 58n + BigInt(v); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const lead = str.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')]);
}
function bech32decode(addr) {
  const lower = addr.toLowerCase();
  if (addr !== lower && addr !== addr.toUpperCase()) return null;           // mixed case is invalid
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length || lower.length > 90) return null;
  const hrp = lower.slice(0, sep);
  const data = [];
  for (const ch of lower.slice(sep + 1)) { const v = CHARSET.indexOf(ch); if (v < 0) return null; data.push(v); }
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...expand, ...data]);
  const version = data[0];
  const constant = version === 0 ? 1 : 0x2bc830a3;
  if (mod !== constant) return null;
  let acc = 0, bits = 0;
  const program = [];
  for (const v of data.slice(1, -6)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; program.push((acc >>> bits) & 255); }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 255)) return null;                  // non-zero padding
  return { hrp, version, program: Buffer.from(program) };
}
export function addressToScript(address, network = 'main') {
  const net = netOf(network);
  const a = String(address ?? '').trim();
  const sw = a.toLowerCase().startsWith(net.hrp + '1') ? bech32decode(a) : null;
  if (sw) {
    if (sw.hrp !== net.hrp || sw.version > 16 || sw.program.length < 2 || sw.program.length > 40) return null;
    if (sw.version === 0 && sw.program.length !== 20 && sw.program.length !== 32) return null;
    return Buffer.concat([Buffer.from([sw.version === 0 ? 0 : 0x50 + sw.version, sw.program.length]), sw.program]);
  }
  const raw = base58decode(a);
  if (!raw || raw.length !== 25) return null;
  if (!hash256(raw.subarray(0, 21)).subarray(0, 4).equals(raw.subarray(21))) return null;
  const hash = raw.subarray(1, 21);
  if (raw[0] === net.p2pkh) return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, 0xac])]);
  if (raw[0] === net.p2sh) return Buffer.concat([Buffer.from([0xa9, 0x14]), hash, Buffer.from([0x87])]);
  return null;
}

// --- scripts -------------------------------------------------------------
// Core's Solver (script/solver.cpp), in its order, with its names.
const OP_0 = 0x00, OP_PUSHDATA1 = 0x4c, OP_PUSHDATA2 = 0x4d, OP_PUSHDATA4 = 0x4e, OP_1 = 0x51, OP_16 = 0x60;
const OP_RETURN = 0x6a, OP_DUP = 0x76, OP_EQUAL = 0x87, OP_EQUALVERIFY = 0x88, OP_HASH160 = 0xa9;
const OP_CHECKSIG = 0xac, OP_CHECKMULTISIG = 0xae;

// Walk a script's opcodes; null if a push runs past the end (Core's GetOp failing).
function ops(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const op = s[i++];
    let len = 0;
    if (op > OP_0 && op < OP_PUSHDATA1) len = op;
    else if (op === OP_PUSHDATA1) { if (i + 1 > s.length) return null; len = s[i]; i += 1; }
    else if (op === OP_PUSHDATA2) { if (i + 2 > s.length) return null; len = s.readUInt16LE(i); i += 2; }
    else if (op === OP_PUSHDATA4) { if (i + 4 > s.length) return null; len = s.readUInt32LE(i); i += 4; }
    if (i + len > s.length) return null;
    out.push({ op, data: len ? s.subarray(i, i + len) : null });
    i += len;
  }
  return out;
}
const validPubkeySize = (k) => (k.length === 33 && (k[0] === 2 || k[0] === 3)) || (k.length === 65 && (k[0] === 4 || k[0] === 6 || k[0] === 7));
const smallInt = (op) => (op === OP_0 ? 0 : op >= OP_1 && op <= OP_16 ? op - OP_1 + 1 : null);

export function classifyScript(s, network = 'main') {
  const net = netOf(network);
  // P2SH first, exactly as Core checks it
  if (s.length === 23 && s[0] === OP_HASH160 && s[1] === 0x14 && s[22] === OP_EQUAL) {
    return { type: 'scripthash', address: base58check(net.p2sh, s.subarray(2, 22)) };
  }
  // witness programs: a version opcode then one direct push of 2..40 bytes, 4..42 in all
  if (s.length >= 4 && s.length <= 42 && (s[0] === OP_0 || (s[0] >= OP_1 && s[0] <= OP_16)) && s[1] + 2 === s.length) {
    const version = smallInt(s[0]);
    const program = s.subarray(2);
    if (version === 1 && program.length === 2 && program[0] === 0x4e && program[1] === 0x73) {
      return { type: 'anchor', address: segwitAddress(net.hrp, 1, program) };
    }
    if (version === 0 && program.length === 20) return { type: 'witness_v0_keyhash', address: segwitAddress(net.hrp, 0, program) };
    if (version === 0 && program.length === 32) return { type: 'witness_v0_scripthash', address: segwitAddress(net.hrp, 0, program) };
    if (version === 1 && program.length === 32) return { type: 'witness_v1_taproot', address: segwitAddress(net.hrp, 1, program) };
    if (version !== 0) return { type: 'witness_unknown', address: segwitAddress(net.hrp, version, program) };
    return { type: 'nonstandard', address: null };
  }
  // OP_RETURN followed by nothing but pushes
  if (s.length >= 1 && s[0] === OP_RETURN) {
    const rest = ops(s.subarray(1));
    if (rest && rest.every((o) => o.op <= OP_16)) return { type: 'nulldata', address: null };
  }
  // pay to a bare public key
  if ((s.length === 35 || s.length === 67) && s[0] === s.length - 2 && s[s.length - 1] === OP_CHECKSIG && validPubkeySize(s.subarray(1, s.length - 1))) {
    return { type: 'pubkey', address: null };
  }
  if (s.length === 25 && s[0] === OP_DUP && s[1] === OP_HASH160 && s[2] === 0x14 && s[23] === OP_EQUALVERIFY && s[24] === OP_CHECKSIG) {
    return { type: 'pubkeyhash', address: base58check(net.p2pkh, s.subarray(3, 23)) };
  }
  // bare multisig: OP_m <keys...> OP_n OP_CHECKMULTISIG, 1 <= m <= n, every key a valid size
  if (s.length >= 1 && s[s.length - 1] === OP_CHECKMULTISIG) {
    const o = ops(s);
    if (o && o.length >= 4) {
      const m = smallInt(o[0].op), n = smallInt(o[o.length - 2].op);
      const keys = o.slice(1, -2);
      if (m != null && n != null && m >= 1 && keys.length === n && m <= n
        && keys.every((k) => k.data && k.op < OP_PUSHDATA1 && validPubkeySize(k.data))) {
        return { type: 'multisig', address: null };
      }
    }
  }
  return { type: 'nonstandard', address: null };
}

// --- transactions --------------------------------------------------------
/**
 * Decode one transaction from `r` (a Reader positioned at its first byte). Returns Core's verbose
 * shape -- txid, hash, version, size, vsize, weight, locktime, vin, vout -- with amounts in SATOSHIS
 * as integers (`value_sat`), never floating BTC: a decoder is not the place to lose a satoshi.
 */
export function readTx(r, network = 'main') {
  const start = r.pos;
  const version = r.i32();
  let segwit = false;
  // BIP144: a zero where the input count belongs, then a flag of 1
  if (r.buf[r.pos] === 0x00 && r.buf[r.pos + 1] === 0x01) { segwit = true; r.pos += 2; }
  const afterMarker = r.pos;
  const nin = r.varint();
  const vin = [];
  for (let i = 0; i < nin; i++) {
    const prev = r.bytes(32), vout = r.u32();
    const script = r.bytes(r.varint());
    const sequence = r.u32();
    const coinbase = vout === 0xffffffff && prev.every((b) => b === 0);
    vin.push(coinbase
      ? { coinbase: script.toString('hex'), sequence }
      : { txid: rev(prev), vout, scriptSig: { hex: script.toString('hex') }, sequence });
  }
  const nout = r.varint();
  const vout = [];
  for (let n = 0; n < nout; n++) {
    const value_sat = r.u64();
    const script = r.bytes(r.varint());
    const { type, address } = classifyScript(script, network);
    vout.push({ value_sat, n, scriptPubKey: { hex: script.toString('hex'), type, ...(address ? { address } : {}) } });
  }
  const witnessStart = r.pos;
  if (segwit) {
    for (const input of vin) {
      const items = r.varint();
      const stack = [];
      for (let k = 0; k < items; k++) stack.push(r.bytes(r.varint()).toString('hex'));
      if (stack.length) input.txinwitness = stack;
    }
  }
  const witnessEnd = r.pos;
  const locktime = r.u32();
  const end = r.pos;
  const full = r.buf.subarray(start, end);
  // the txid hashes the transaction WITHOUT marker, flag and witness
  const base = segwit
    ? Buffer.concat([r.buf.subarray(start, start + 4), r.buf.subarray(afterMarker, witnessStart), r.buf.subarray(witnessEnd, end)])
    : full;
  const size = full.length, weight = base.length * 3 + size;
  return {
    txid: rev(hash256(base)), hash: rev(hash256(full)),
    version, size, vsize: Math.ceil(weight / 4), weight, locktime, vin, vout,
  };
}

export function decodeTx(hexOrBuf, network = 'main') {
  const buf = Buffer.isBuffer(hexOrBuf) ? hexOrBuf : Buffer.from(String(hexOrBuf), 'hex');
  const r = new Reader(buf);
  const tx = readTx(r, network);
  if (r.pos !== buf.length) throw new RangeError(`${buf.length - r.pos} trailing bytes after the transaction`);
  return tx;
}

// --- blocks --------------------------------------------------------------
export function readHeader(r) {
  const start = r.pos;
  const version = r.i32();
  const previousblockhash = rev(r.bytes(32));
  const merkleroot = rev(r.bytes(32));
  const time = r.u32(), bits = r.u32(), nonce = r.u32();
  return {
    hash: rev(hash256(r.buf.subarray(start, start + 80))),
    version, previousblockhash, merkleroot, time, bits: bits.toString(16).padStart(8, '0'), nonce,
  };
}

export function decodeBlock(hexOrBuf, network = 'main') {
  const buf = Buffer.isBuffer(hexOrBuf) ? hexOrBuf : Buffer.from(String(hexOrBuf), 'hex');
  const r = new Reader(buf);
  const header = readHeader(r);
  const n = r.varint();
  const tx = [];
  for (let i = 0; i < n; i++) tx.push(readTx(r, network));
  if (r.pos !== buf.length) throw new RangeError(`${buf.length - r.pos} trailing bytes after the block`);
  return { ...header, size: buf.length, nTx: n, tx };
}
