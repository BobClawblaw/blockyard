// Block hash -> height for the chain an index build covers, in a SharedArrayBuffer so every build
// worker reads the same table without a copy (966,000 entries is ~70 MB as a Map of hex strings,
// and there are sixteen workers). Open addressing on the first 8 bytes of the block hash; a hash
// prefix collision among a million blocks is odds of ~1 in 3.7e7, and a collision would put two
// blocks at one height -- which the build checks for, since it counts every height exactly once.
// The LAST 16 hex digits of the displayed hash, not the first: a displayed hash begins with the
// proof of work, so a recent block's first 16 digits are all zero and every one of them would collide.
//
// THE TABLE IS SIZED FROM THE TIP, AND NEVER LOOPS WHEN FULL (audit 2026-09-16, L7). The capacity was
// fixed at 2^21 and nothing checked the load, so the 2,097,153rd block -- mainnet reaches it around
// 2046 -- sent `set` round the table forever, on the server's main thread. Now a build sizes it at
// least twice the heights it will hold (HeightTable.forTip), `set` refuses past a load of 0.75, and
// both `set` and `get` give up after one lap of the table whatever its state.
export const MAX_LOAD = 0.75;

export class HeightTable {
  constructor(capacity = 1 << 21) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 2 ** 30 || (capacity & (capacity - 1)) !== 0) throw new RangeError(`height table capacity must be a power of two, not ${capacity}`);
    this.capacity = capacity;
    this.buffer = new SharedArrayBuffer(capacity * 12);
    this.count = 0;
    this._bind();
  }
  /** A table for heights 0..tip: at least twice tip + 1 slots, a power of two, never under 1,024. */
  static forTip(tip) {
    if (!Number.isSafeInteger(tip) || tip < 0) throw new RangeError(`a height table needs a tip height, not ${tip}`);
    let capacity = 1024;
    while (capacity < 2 * (tip + 1)) capacity *= 2;
    return new HeightTable(capacity);
  }
  static attach(buffer, capacity) {
    const t = Object.create(HeightTable.prototype);
    t.capacity = capacity; t.buffer = buffer; t.count = null; t._bind();
    return t;
  }
  _bind() {
    this.keys = new BigUint64Array(this.buffer, 0, this.capacity);
    this.values = new Int32Array(this.buffer, this.capacity * 8, this.capacity);
  }
  static #prefix(hashHex) { return BigInt('0x' + hashHex.slice(-16)) | 1n; }     // never the empty 0
  set(hashHex, height) {
    const k = HeightTable.#prefix(hashHex);
    let i = Number(k % BigInt(this.capacity));
    for (let probes = 0; this.keys[i] !== 0n && this.keys[i] !== k; probes++) {
      if (probes >= this.capacity) throw new RangeError(`the height table is full (${this.capacity} slots)`);
      i = (i + 1) % this.capacity;
    }
    if (this.keys[i] === 0n) {
      // an attached table counts what it holds the first time it is written to
      if (this.count == null) { let n = 0; for (let j = 0; j < this.capacity; j++) if (this.keys[j] !== 0n) n++; this.count = n; }
      if (this.count + 1 > this.capacity * MAX_LOAD) throw new RangeError(`the height table is too small: ${this.count + 1} heights would load its ${this.capacity} slots past ${MAX_LOAD} (size it with HeightTable.forTip)`);
      this.count++;
    }
    this.keys[i] = k; this.values[i] = height;
  }
  get(hashHex) {
    const k = HeightTable.#prefix(hashHex);
    let i = Number(k % BigInt(this.capacity));
    for (let probes = 0; probes < this.capacity && this.keys[i] !== 0n; probes++) { if (this.keys[i] === k) return this.values[i]; i = (i + 1) % this.capacity; }
    return -1;
  }
}
