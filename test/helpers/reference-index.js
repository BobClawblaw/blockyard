// A DELIBERATELY NAIVE SECOND ADDRESS INDEX, to check the real one (server/chain/index/) against.
//
// It shares no indexing code with the real index -- only the byte decoders (server/chain/tx.js),
// which are checked on their own against Core. Where the real index is lean and clever, this is
// plain on purpose:
//
//   - the UTXO set is replayed in a Map (txid:vout -> coin). The real index never replays it: it reads
//     the spent side from undo records (files) or from prevouts (RPC). A disagreement between the two
//     is exactly the bug either could hide.
//   - scripts are kept as their full hex, not an 8-byte hash prefix
//   - a reorganisation is not undone: the reference is simply built again over the new chain
//
// The rules it implements are the index's documented contract (server/chain/index/rows.js), stated
// independently here:
//   - an address is an output script; OP_RETURN outputs (first byte 0x6a) are not addresses
//   - a history row is one (address, transaction) the transaction paid or spent from, carrying the
//     net: paid minus spent, which can be zero or negative; oldest first by height, then position
//   - a balance is what the address's unspent outputs hold
import { Reader, readHeader, readTx } from '../../server/chain/tx.js';

export class ReferenceIndex {
  constructor() {
    this.utxo = new Map();          // `${txid}:${vout}` -> { script (hex), value }
    this.history = new Map();       // script hex -> [{ height, pos, value }]
    this.height = -1;
    this.tipHash = null;
  }

  /** Replay one block's raw bytes. Blocks must come in chain order, genesis first. */
  apply(body, height) {
    if (height !== this.height + 1) throw new Error(`reference: block ${height} after ${this.height}`);
    const r = new Reader(body);
    const header = readHeader(r);
    if (this.tipHash !== null && header.previousblockhash !== this.tipHash) throw new Error(`reference: block ${height} does not follow ${this.tipHash}`);
    const n = r.varint();
    for (let pos = 0; pos < n; pos++) {
      const tx = readTx(r);
      const net = new Map();
      for (const input of tx.vin) {
        if (input.coinbase != null) continue;
        const k = `${input.txid}:${input.vout}`;
        const coin = this.utxo.get(k);
        if (!coin) throw new Error(`reference: block ${height} tx ${pos} spends ${k}, which is not unspent`);
        this.utxo.delete(k);
        net.set(coin.script, (net.get(coin.script) ?? 0) - coin.value);
      }
      for (const out of tx.vout) {
        const script = out.scriptPubKey.hex;
        if (script.startsWith('6a')) continue;
        this.utxo.set(`${tx.txid}:${out.n}`, { script, value: out.value_sat });
        net.set(script, (net.get(script) ?? 0) + out.value_sat);
      }
      for (const [script, value] of net) {
        let list = this.history.get(script);
        if (!list) this.history.set(script, (list = []));
        list.push({ height, pos, value });
      }
    }
    if (r.pos !== body.length) throw new Error(`reference: block ${height} has trailing bytes`);
    this.height = height;
    this.tipHash = header.hash;
  }

  static over(bodies) {
    const ref = new ReferenceIndex();
    bodies.forEach((b, h) => ref.apply(b, h));
    return ref;
  }

  /** Every address's balance, counted from the unspent outputs -- not from the history. */
  balances() {
    const out = new Map();
    for (const { script, value } of this.utxo.values()) out.set(script, (out.get(script) ?? 0) + value);
    return out;
  }
}
