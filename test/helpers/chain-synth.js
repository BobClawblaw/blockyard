// A SYNTHETIC CHAIN for the address index tests: real transaction and block bytes, the undo records
// Core would write for them, and the `getblock <hash> 3` shape the live follower reads -- all from a
// seeded generator, so a run is the same every time.
//
// What it makes on purpose, because each is a way an index can go wrong:
//   - seven script types, plus an uncompressed-key P2PK (the undo compressor's point-decompression case)
//   - addresses reused many times (a skewed pick), and one HOT address that most transactions touch,
//     so its history outgrows the store's page ring and its sparse row blocks
//   - transactions spending outputs made earlier in the same block
//   - many inputs and many outputs, two outputs to one script, OP_RETURN outputs
//   - a transaction that pays a script exactly what it spends from it (a net-zero row)
//
// The generator keeps its own coin pool to build inputs and undo records. It shares nothing with the
// index (server/chain/index/) and nothing with the reference implementation (reference-index.js).
import { hash256, decodeBlock } from '../../server/chain/tx.js';
import { MAGIC } from '../../server/chain/blockfile.js';

export function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.state = () => s;
  next.int = (n) => Math.floor(next() * n);
  next.bytes = (n) => Buffer.from(Array.from({ length: n }, () => next.int(256)));
  return next;
}

const compact = (n) => {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b;
};
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };

// Core's serialize.h WriteVarInt, compressor.cpp CompressAmount and CompressScript
const coreVarint = (n) => { const t = []; for (let len = 0; ; len++) { t.push((n % 128) | (len ? 0x80 : 0)); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; } return Buffer.from(t.reverse()); };
const compressAmount = (n) => { if (n === 0) return 0; let e = 0; while (n % 10 === 0 && e < 9) { n /= 10; e++; } if (e < 9) { const d = n % 10; n = Math.floor(n / 10); return 1 + (n * 9 + d - 1) * 10 + e; } return 1 + (n - 1) * 10 + 9; };
function compressScript(s) {
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) return Buffer.concat([coreVarint(0), s.subarray(3, 23)]);
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return Buffer.concat([coreVarint(1), s.subarray(2, 22)]);
  if (s.length === 35 && s[0] === 0x21 && (s[1] === 2 || s[1] === 3) && s[34] === 0xac) return Buffer.concat([coreVarint(s[1]), s.subarray(2, 34)]);
  if (s.length === 67 && s[0] === 0x41 && s[1] === 4 && s[66] === 0xac) return Buffer.concat([coreVarint(4 | (s[65] & 1)), s.subarray(2, 34)]);
  return Buffer.concat([coreVarint(s.length + 6), s]);
}

// the secp256k1 generator point, uncompressed: a P2PK the undo compressor stores as size 4 or 5
const G = '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';

export const TYPES = ['p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr', 'p2pk', 'multisig'];
function makeScript(type, r) {
  switch (type) {
    case 'p2pkh': return Buffer.concat([Buffer.from('76a914', 'hex'), r.bytes(20), Buffer.from('88ac', 'hex')]);
    case 'p2sh': return Buffer.concat([Buffer.from('a914', 'hex'), r.bytes(20), Buffer.from('87', 'hex')]);
    case 'p2wpkh': return Buffer.concat([Buffer.from('0014', 'hex'), r.bytes(20)]);
    case 'p2wsh': return Buffer.concat([Buffer.from('0020', 'hex'), r.bytes(32)]);
    case 'p2tr': return Buffer.concat([Buffer.from('5120', 'hex'), r.bytes(32)]);
    case 'p2pk': return Buffer.concat([Buffer.from([0x21, 2 + r.int(2)]), r.bytes(32), Buffer.from('ac', 'hex')]);
    default: return Buffer.concat([Buffer.from('5121', 'hex'), Buffer.from([2]), r.bytes(32), Buffer.from('21', 'hex'), Buffer.from([3]), r.bytes(32), Buffer.from('52ae', 'hex')]);
  }
}

function serializeTx({ inputs, outputs, segwit }) {
  const ins = inputs.map((i) => Buffer.concat([Buffer.from(i.txid, 'hex').reverse(), u32(i.vout), compact(i.scriptSig.length), i.scriptSig, u32(0xffffffff)]));
  const outs = outputs.map((o) => Buffer.concat([u64(o.value), compact(o.script.length), o.script]));
  const base = Buffer.concat([u32(2), compact(inputs.length), ...ins, compact(outputs.length), ...outs]);
  const lock = u32(0);
  const txid = hash256(Buffer.concat([base, lock])).reverse().toString('hex');
  if (!segwit) return { txid, bytes: Buffer.concat([base, lock]) };
  const wit = inputs.map((i) => Buffer.concat([compact(i.witness.length), ...i.witness.map((w) => Buffer.concat([compact(w.length), w]))]));
  return { txid, bytes: Buffer.concat([u32(2), Buffer.from([0, 1]), base.subarray(4), ...wit, lock]) };
}

/**
 * The chain generator. `addresses` scripts are made up front; `block()` makes the next block.
 * `snapshot()` / `ChainGen.resume(snap, salt)` fork it: the same coins, a different future.
 */
export class ChainGen {
  constructor(seed, { addresses = 400, txsPerBlock = [10, 30], hotShare = 0.5 } = {}) {
    const r = rng(seed);
    this.addresses = [];
    for (let i = 0; i < addresses; i++) this.addresses.push(makeScript(TYPES[i % TYPES.length], r));
    this.addresses.splice(4, 0, Buffer.from(`41${G}ac`, 'hex'));      // low in the list: reused often
    this.hot = this.addresses[2];                       // a p2wpkh
    this.txsPerBlock = txsPerBlock; this.hotShare = hotShare;
    this.seed = seed; this.salt = 0;
    this.r = rng(seed ^ 0x5eed);
    this.pool = [];                                     // { txid, vout, value, script, height, coinbase }
    this.blocks = [];                                   // height -> { hash, prev, body, undo, verbose }
  }

  snapshot() { return { pool: this.pool.slice(), blocks: this.blocks.slice(), state: this.r.state() }; }

  static resume(from, snap, salt) {
    const g = Object.create(ChainGen.prototype);
    Object.assign(g, from, { pool: snap.pool.slice(), blocks: snap.blocks.slice(), salt, r: rng(snap.state ^ (salt * 0x9e3779b1)) });
    return g;
  }

  _pickScript() {
    const r = this.r;
    if (r() < this.hotShare) return this.hot;
    // skewed: low indices reused far more than high ones
    return this.addresses[Math.floor(this.addresses.length * r() * r())];
  }

  _split(total, n) {
    const cuts = Array.from({ length: n - 1 }, () => this.r.int(total + 1)).sort((a, b) => a - b);
    return [...cuts, total].map((c, i) => c - (i ? cuts[i - 1] : 0));
  }

  block() {
    const r = this.r, height = this.blocks.length;
    const prev = height ? this.blocks[height - 1].hash : '00'.repeat(32);
    const txs = [], spentByTx = [];
    let fees = 0;
    const fresh = [];                                   // coins made in this block, spendable in it
    const ntx = height === 0 ? 0 : this.txsPerBlock[0] + r.int(this.txsPerBlock[1] - this.txsPerBlock[0] + 1);
    for (let t = 0; t < ntx && this.pool.length + fresh.length > 0; t++) {
      const nin = Math.min(1 + r.int(r() < 0.2 ? 6 : 2), this.pool.length + fresh.length);
      const inputs = [];
      for (let k = 0; k < nin; k++) {
        // a third of the time, a coin made earlier in this very block
        const src = fresh.length && (r() < 0.35 || !this.pool.length) ? fresh : this.pool;
        const at = r.int(src.length);
        inputs.push(src[at]);
        src[at] = src[src.length - 1]; src.pop();
      }
      const inTotal = inputs.reduce((a, c) => a + c.value, 0);
      const segwit = r() < 0.5;
      const outputs = [];
      let budget = inTotal;
      // a net-zero row: pay the first input's script back exactly what it spent
      if (inputs.length >= 2 && r() < 0.08) { outputs.push({ value: inputs[0].value, script: inputs[0].script }); budget -= inputs[0].value; }
      const fee = Math.min(budget, r.int(5000));
      budget -= fee; fees += fee;
      const nout = 1 + r.int(r() < 0.2 ? 8 : 3);
      const values = this._split(budget, nout);
      for (let o = 0; o < nout; o++) {
        const script = o > 0 && r() < 0.1 ? outputs[outputs.length - 1].script : this._pickScript();   // two outputs, one script
        outputs.push({ value: values[o], script });
      }
      if (r() < 0.07) outputs.splice(r.int(outputs.length + 1), 0, { value: 0, script: Buffer.concat([Buffer.from('6a08', 'hex'), r.bytes(8)]) });
      const tx = serializeTx({
        segwit,
        inputs: inputs.map((c) => ({ txid: c.txid, vout: c.vout, scriptSig: segwit ? Buffer.alloc(0) : r.bytes(1 + r.int(40)), witness: [r.bytes(1 + r.int(72)), r.bytes(33)] })),
        outputs,
      });
      txs.push(tx.bytes); spentByTx.push(inputs);
      outputs.forEach((o, n) => { if (o.script[0] !== 0x6a) fresh.push({ txid: tx.txid, vout: n, value: o.value, script: o.script, height, coinbase: false }); });
    }
    // the coinbase: its height in the scriptSig (BIP34, so no two coinbases share a txid)
    const reward = 50e8 + fees;
    const cbOuts = r() < 0.5 ? [{ value: reward, script: this._pickScript() }] : (() => { const a = r.int(reward + 1); return [{ value: a, script: this._pickScript() }, { value: reward - a, script: this._pickScript() }]; })();
    cbOuts.push({ value: 0, script: Buffer.concat([Buffer.from('6a24aa21a9ed', 'hex'), r.bytes(32)]) });
    const cb = serializeTx({ segwit: false, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: Buffer.concat([u32(height), u32(this.salt)]) }], outputs: cbOuts });
    // genesis coins are never spent (as in Core)
    const cbCoins = height === 0 ? [] : cbOuts.flatMap((o, n) => (o.script[0] === 0x6a ? [] : [{ txid: cb.txid, vout: n, value: o.value, script: o.script, height, coinbase: true }]));

    const header = Buffer.alloc(80);
    header.writeUInt32LE(0x20000000, 0);
    Buffer.from(prev, 'hex').reverse().copy(header, 4);
    r.bytes(32).copy(header, 36);
    header.writeUInt32LE(1700000000 + height * 600, 68);
    header.writeUInt32LE(0x1d00ffff, 72);
    header.writeUInt32LE((height * 7919 + this.salt * 104729) >>> 0, 76);
    const hash = hash256(header).reverse().toString('hex');
    const body = Buffer.concat([header, compact(txs.length + 1), cb.bytes, ...txs]);

    const undo = Buffer.concat([compact(spentByTx.length), ...spentByTx.map((ins) => Buffer.concat([compact(ins.length), ...ins.map((c) =>
      Buffer.concat([coreVarint(c.height * 2 + (c.coinbase ? 1 : 0)), ...(c.height > 0 ? [coreVarint(0)] : []), coreVarint(compressAmount(c.value)), compressScript(c.script)]))]))]);

    this.pool.push(...fresh, ...cbCoins);
    const b = { height, hash, prev, body, undo, spentByTx };
    this.blocks.push(b);
    return b;
  }

  /** Blocks until the chain's tip is `height`. */
  extendTo(height) { while (this.blocks.length <= height) this.block(); return this; }
}

/** Core's checksum trailer on an undo record. */
export const undoChecksum = (prevHash, undo) => hash256(Buffer.concat([Buffer.from(prevHash, 'hex').reverse(), undo]));

/** [magic][size][body][trailer], XOR-obfuscated from `offset` by `key` as Core v28 writes it. */
export function frame(body, trailer = Buffer.alloc(0)) {
  const h = Buffer.alloc(8); h.writeUInt32LE(MAGIC.main, 0); h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body, trailer]);
}
/** A block as `getblock <hash> 3` answers it: amounts in BTC, every input's prevout. */
export function verboseBlock(b) {
  const d = decodeBlock(b.body);
  return {
    hash: b.hash, height: b.height, ...(b.height ? { previousblockhash: b.prev } : {}),
    tx: d.tx.map((tx, p) => ({
      txid: tx.txid,
      vin: tx.vin.map((v, i) => (p === 0 ? { coinbase: v.coinbase } : { txid: v.txid, vout: v.vout, prevout: { value: b.spentByTx[p - 1][i].value / 1e8, scriptPubKey: { hex: b.spentByTx[p - 1][i].script.toString('hex') } } })),
      vout: tx.vout.map((o) => ({ value: o.value_sat / 1e8, n: o.n, scriptPubKey: { hex: o.scriptPubKey.hex } })),
    })),
  };
}

export const xor = (buf, key) =>{ const out = Buffer.from(buf); for (let i = 0; i < out.length; i++) out[i] ^= key[i % key.length]; return out; };
