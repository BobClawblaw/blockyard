// ADDRESS INDEX ROWS, straight from block and undo bytes (docs/MEASUREMENTS.md §28-29).
//
// One row per (script, transaction that touched it), 21 bytes, big-endian so that byte order IS sort
// order:
//
//   sh8     8   the first 8 bytes of sha256(scriptPubKey) -- an address, whatever its type
//   height  3   the block
//   pos     2   the transaction's position in that block
//   value   8   signed satoshis: what the transaction paid to the script, minus what it spent from it
//
// A transaction that both pays and spends one script is ONE row with the net, not two. A script
// paid by an output is taken from the block; a script spent by an input is taken from the undo
// record, which is how the spending side is known without replaying the UTXO set.
//
// LEAN ON PURPOSE. server/chain/tx.js builds Core's verbose shape -- hex strings, classified types,
// encoded addresses -- and measured, that was 5.9 of the 9.5 single-core hours (§28). The index needs
// none of it: only each output's value and script bytes, and each spent coin's. So this walks the
// transaction bytes itself and hashes script bytes where they lie. It is checked row-for-row against
// rows built from the full decoder (test/chain-index.test.js), so lean never means different.
//
// OP_RETURN outputs are skipped: provably unspendable, never an address. Core names only the
// push-only ones `nulldata`; the rest are `nonstandard` there, and just as unspendable.
import { createHash } from 'node:crypto';
import { decodeBlockUndo } from '../blockfile.js';

export const ROW = 21;
export const MAX_POS = 0xffff;
export const MAX_HEIGHT = 0xffffff;

function varint(buf, st) {
  const b = buf[st.pos++];
  if (b < 0xfd) return b;
  if (b === 0xfd) { const v = buf.readUInt16LE(st.pos); st.pos += 2; return v; }
  if (b === 0xfe) { const v = buf.readUInt32LE(st.pos); st.pos += 4; return v; }
  const v = Number(buf.readBigUInt64LE(st.pos)); st.pos += 8; return v;
}

/** sha256(script)'s first 8 bytes, as an unsigned BigInt. */
export function scriptKey(script) {
  return createHash('sha256').update(script).digest().readBigUInt64BE(0);
}

/**
 * Walk one transaction at st.pos: calls onOutput(value_sat, scriptSubarray) per output, returns the
 * number of inputs. Leaves st.pos after the transaction.
 */
function walkTx(buf, st, onOutput) {
  st.pos += 4;                                                   // version
  let segwit = false;
  if (buf[st.pos] === 0 && buf[st.pos + 1] === 1) { segwit = true; st.pos += 2; }
  const nin = varint(buf, st);
  for (let i = 0; i < nin; i++) { st.pos += 36; const len = varint(buf, st); st.pos += len + 4; }
  const nout = varint(buf, st);
  for (let o = 0; o < nout; o++) {
    const value = Number(buf.readBigUInt64LE(st.pos)); st.pos += 8;
    const len = varint(buf, st);
    onOutput(value, buf.subarray(st.pos, st.pos + len));
    st.pos += len;
  }
  if (segwit) for (let i = 0; i < nin; i++) { const items = varint(buf, st); for (let k = 0; k < items; k++) { const len = varint(buf, st); st.pos += len; } }
  st.pos += 4;                                                   // locktime
  return nin;
}

/**
 * Index rows for one block. `body` is the raw block, `undoBody` its undo record (null for genesis,
 * whose coinbase spends nothing). Appends rows to `out` (a RowSink) and returns the row count.
 */
export function blockRows(body, undoBody, height, out) {
  if (height > MAX_HEIGHT) throw new RangeError(`height ${height} does not fit the row format`);
  const undo = undoBody ? decodeBlockUndo(undoBody) : [];
  const st = { pos: 80 };
  const ntx = varint(body, st);
  if (ntx - 1 > MAX_POS) throw new RangeError(`block ${height} has ${ntx} transactions, past the row format's position field`);
  let rows = 0;
  const moved = new Map();
  for (let p = 0; p < ntx; p++) {
    moved.clear();
    walkTx(body, st, (value, script) => {
      if (script.length > 0 && script[0] === 0x6a) return;       // OP_RETURN: unspendable, not an address
      const k = scriptKey(script);
      moved.set(k, (moved.get(k) ?? 0) + value);
    });
    if (p > 0) {
      const coins = undo[p - 1];
      if (!coins) throw new Error(`block ${height}: no undo for transaction ${p}`);
      for (const c of coins) {
        const k = scriptKey(c.script);
        moved.set(k, (moved.get(k) ?? 0) - c.value_sat);
      }
    }
    for (const [k, v] of moved) { out.push(k, height, p, v); rows++; }
  }
  if (st.pos !== body.length) throw new RangeError(`block ${height}: ${body.length - st.pos} bytes left after the last transaction`);
  return rows;
}

/** Packs rows into a growable Buffer of 21-byte records. */
export class RowSink {
  constructor(initialRows = 1 << 16) { this.buf = Buffer.allocUnsafe(initialRows * ROW); this.n = 0; }
  push(key, height, pos, value) {
    const at = this.n * ROW;
    if (at + ROW > this.buf.length) { const next = Buffer.allocUnsafe(this.buf.length * 2); this.buf.copy(next, 0, 0, at); this.buf = next; }
    this.buf.writeBigUInt64BE(key, at);
    this.buf.writeUIntBE(height, at + 8, 3);
    this.buf.writeUInt16BE(pos, at + 11);
    this.buf.writeBigInt64BE(BigInt(value), at + 13);
    this.n++;
  }
  bytes() { return this.buf.subarray(0, this.n * ROW); }
}

export function readRow(buf, at = 0) {
  return { key: buf.readBigUInt64BE(at), height: buf.readUIntBE(at + 8, 3), pos: buf.readUInt16BE(at + 11), value: Number(buf.readBigInt64BE(at + 13)) };
}
