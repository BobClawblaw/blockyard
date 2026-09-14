// Block hash -> height for the chain an index build covers, in a SharedArrayBuffer so every build
// worker reads the same table without a copy (966,000 entries is ~70 MB as a Map of hex strings,
// and there are sixteen workers). Open addressing on the first 8 bytes of the block hash; a hash
// prefix collision among a million blocks is odds of ~1 in 3.7e7, and a collision would put two
// blocks at one height -- which the build checks for, since it counts every height exactly once.
// The LAST 16 hex digits of the displayed hash, not the first: a displayed hash begins with the
// proof of work, so a recent block's first 16 digits are all zero and every one of them would collide.
export class HeightTable {
  constructor(capacity = 1 << 21) {
    this.capacity = capacity;
    this.buffer = new SharedArrayBuffer(capacity * 12);
    this._bind();
  }
  static attach(buffer, capacity) {
    const t = Object.create(HeightTable.prototype);
    t.capacity = capacity; t.buffer = buffer; t._bind();
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
    while (this.keys[i] !== 0n && this.keys[i] !== k) i = (i + 1) % this.capacity;
    this.keys[i] = k; this.values[i] = height;
  }
  get(hashHex) {
    const k = HeightTable.#prefix(hashHex);
    let i = Number(k % BigInt(this.capacity));
    while (this.keys[i] !== 0n) { if (this.keys[i] === k) return this.values[i]; i = (i + 1) % this.capacity; }
    return -1;
  }
}
