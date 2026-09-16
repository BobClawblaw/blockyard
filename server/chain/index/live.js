// THE ADDRESS INDEX FOLLOWS THE CHAIN (operator, 2026-09-14: "keep the index current as new blocks
// arrive"). The base index is immutable and covers the chain up to the block it was built at; this
// carries it forward, and back again when the chain reorganises.
//
//   poll      ask the node for its tip; if a block we hold is no longer on the node's chain, roll back
//             to the fork; then fetch each block past our tip with getblock <hash> 3 (every input's
//             prevout included, so it works for a node whose block files are elsewhere) and turn it
//             into rows -- verboseBlockRows, checked row for row against the file builder
//   log       every block is appended to <index>/live.log BEFORE it is served, and so is every
//             rollback. A record is [magic][type][length][payload][crc32]; replay stops at the first
//             record that is short or fails its checksum, which is exactly a write the process did
//             not finish, and the log is truncated there
//   tail      blocks not yet folded live in memory: their rows, and a key -> rows map for lookups
//   fold      once FOLD_BLOCKS blocks are at least CONFIRMATIONS deep, they are sorted into an
//             immutable layer (layers/L<from>-<to>) and the log is rewritten without them. A block
//             that deep is past any reorganisation this code will follow
//   merge     more than MAX_LAYERS layers are merged into one, so a lookup's cost stays bounded
//
// A reorganisation deeper than the tail -- into a layer or the base -- is not repaired: the index
// says it is stale and a rebuild is needed, rather than serving a history for a chain that is gone.
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, fsyncSync, existsSync } from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { IndexStore } from './store.js';
import { ROW, RowSink, verboseBlockRows } from './rows.js';
import { BLOCK_ROWS, openTempFile } from './build.js';

export const CONFIRMATIONS = 100;
export const FOLD_BLOCKS = 144;
export const MAX_LAYERS = 32;
const MAGIC = 0x42594c47;            // 'BYLG'
const T_BLOCK = 1, T_ROLLBACK = 2;

// Sort rows by (key, height, position) and build the sparse index -- the same order the base uses.
export function sortRows(buf, blockRows = BLOCK_ROWS) {
  const n = buf.length / ROW;
  const sub = (i) => (buf[i * ROW] << 8) | buf[i * ROW + 1];
  const counts = new Uint32Array(65537);
  for (let i = 0; i < n; i++) counts[sub(i) + 1]++;
  for (let s = 0; s < 65536; s++) counts[s + 1] += counts[s];
  const order = new Uint32Array(n), fill = counts.slice(0, 65536);
  for (let i = 0; i < n; i++) order[fill[sub(i)]++] = i;
  const hi = new Float64Array(n), lo = new Float64Array(n);
  for (let i = 0; i < n; i++) { const at = i * ROW; hi[i] = buf.readUIntBE(at + 2, 6); lo[i] = buf.readUIntBE(at + 8, 3) * 65536 + buf.readUInt16BE(at + 11); }
  for (let s = 0; s < 65536; s++) {
    const part = order.subarray(counts[s], counts[s + 1]);
    if (part.length > 1) part.sort((x, y) => hi[x] - hi[y] || lo[x] - lo[y]);
  }
  const out = Buffer.allocUnsafe(buf.length);
  const sparse = [];
  let w = 0;
  for (let k = 0; k < n; k++) {
    const at = order[k] * ROW;
    if (w > 0 && buf.compare(out, w - ROW, w - ROW + 13, at, at + 13) === 0) continue;
    if ((w / ROW) % blockRows === 0) sparse.push(buf.readBigUInt64BE(at));
    buf.copy(out, w, at, at + ROW);
    w += ROW;
  }
  return { rows: out.subarray(0, w), idx: Buffer.from(new BigUint64Array(sparse).buffer) };
}

// The temporary name is unlinked and created afresh with O_EXCL, owner-only: a symlink planted at
// live.log.tmp or tips.json.tmp is never followed (audit 2026-09-16, L10)
function writeAtomic(file, data) {
  const fd = openTempFile(file + '.tmp');
  try { for (let o = 0; o < data.length;) o += writeSync(fd, data, o, data.length - o); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(file + '.tmp', file);
}

function record(type, payload) {
  const head = Buffer.alloc(9);
  head.writeUInt32LE(MAGIC, 0); head.writeUInt8(type, 4); head.writeUInt32LE(payload.length, 5);
  const tail = Buffer.alloc(4); tail.writeUInt32LE(crc32(payload), 0);
  return Buffer.concat([head, payload, tail]);
}

export class LiveIndex {
  /**
   * @param dir   a built index directory
   * @param rpc   { batch(calls, opts) } -- the node that tells us about new blocks
   */
  constructor(dir, { rpc, nodeId = null, log = null, confirmations = CONFIRMATIONS, foldBlocks = FOLD_BLOCKS, maxLayers = MAX_LAYERS, maxBlocksPerPoll = 50 } = {}) {
    this.dir = dir; this.rpc = rpc; this.nodeId = nodeId; this.log = log;
    this.confirmations = confirmations; this.foldBlocks = foldBlocks; this.maxLayers = maxLayers; this.maxBlocksPerPoll = maxBlocksPerPoll;
    this.store = new IndexStore(dir, { log });
    this.blocks = new Map();             // height -> { hash, rows: Buffer }
    this.byKey = new Map();              // key hex (16) -> [Buffer, offset, Buffer, offset, ...]
    this.stale = null;                   // a reason, once the chain has left us behind
    this.lastError = null; this.lastPollAt = null; this.polling = false;
    this.logFile = path.join(dir, 'live.log');
    this.store.tail = this;
    this.#replay();
  }

  get tip() { return this.blocks.size ? Math.max(...this.blocks.keys()) : this.store.sortedTip; }

  status() {
    return { baseTip: this.store.manifest.tip.height, sortedTip: this.store.sortedTip, tip: this.tip, tailBlocks: this.blocks.size, layers: this.store.layers.length, stale: this.stale, lastError: this.lastError, lastPollAt: this.lastPollAt };
  }

  // --- the tail -------------------------------------------------------------------------------
  scan(key, visit) {
    const list = this.byKey.get(key.toString(16).padStart(16, '0'));
    if (!list) return;
    for (let i = 0; i < list.length; i += 2) visit(list[i], list[i + 1]);
  }

  #add(height, hash, rows) {
    this.blocks.set(height, { hash, rows });
    for (let at = 0; at < rows.length; at += ROW) {
      const k = rows.toString('hex', at, at + 8);
      const list = this.byKey.get(k);
      if (list) list.push(rows, at); else this.byKey.set(k, [rows, at]);
    }
  }

  #drop(height) {
    const b = this.blocks.get(height);
    if (!b) return;
    for (let at = 0; at < b.rows.length; at += ROW) {
      const k = b.rows.toString('hex', at, at + 8);
      const list = this.byKey.get(k);
      if (!list) continue;
      const kept = [];
      for (let i = 0; i < list.length; i += 2) if (list[i] !== b.rows) kept.push(list[i], list[i + 1]);
      if (kept.length) this.byKey.set(k, kept); else this.byKey.delete(k);
    }
    this.blocks.delete(height);
  }

  // --- the log --------------------------------------------------------------------------------
  #replay() {
    if (!existsSync(this.logFile)) return;
    const buf = readFileSync(this.logFile);
    let pos = 0, good = 0;
    while (pos + 13 <= buf.length) {
      if (buf.readUInt32LE(pos) !== MAGIC) break;
      const type = buf.readUInt8(pos + 4), len = buf.readUInt32LE(pos + 5);
      if (pos + 9 + len + 4 > buf.length) break;
      const payload = buf.subarray(pos + 9, pos + 9 + len);
      if (crc32(payload) !== buf.readUInt32LE(pos + 9 + len)) break;
      // A RECORD WHOSE CHECKSUM HOLDS BUT WHOSE SHAPE DOES NOT is treated like a torn one: the log is cut
      // there (audit 2026-09-16, I4). A block record shorter than its height and hash, or with rows
      // that are not whole 21-byte rows, threw from this constructor and the follower never started.
      if (type === T_BLOCK && (len < 36 || (len - 36) % ROW !== 0)) break;
      if (type === T_ROLLBACK && len < 4) break;
      if (type === T_BLOCK) {
        const height = payload.readUInt32LE(0), hash = payload.toString('hex', 4, 36);
        if (height === this.tip + 1) this.#add(height, hash, Buffer.from(payload.subarray(36)));
      } else if (type === T_ROLLBACK) {
        const to = payload.readUInt32LE(0);
        for (const h of [...this.blocks.keys()]) if (h > to) this.#drop(h);
      }
      pos += 9 + len + 4; good = pos;
    }
    if (good < buf.length) {
      // a record the process did not finish writing: cut it off so the next append follows good data
      this.log?.warn?.(`live index log: dropping ${buf.length - good} bytes after the last complete record`);
      writeAtomic(this.logFile, buf.subarray(0, good));
    }
  }

  #append(rec) {
    const fd = openSync(this.logFile, 'a', 0o600);                // owner-only (audit 2026-09-16, L10)
    try { writeSync(fd, rec); fsyncSync(fd); } finally { closeSync(fd); }
  }

  // --- following the node ---------------------------------------------------------------------
  async #call(method, params, timeoutMs = 120_000) {
    const [r] = await this.rpc.batch([{ method, params }], { key: `live-index:${method}:${params[0]}`, timeoutMs, maxWaitMs: 300_000, priority: 6 });
    if (!r?.ok) throw new Error(`${method}: ${r?.error?.message ?? 'no reply'}`);
    return r.result;
  }

  /** One round: detect a reorg, catch up to the node's tip (at most maxBlocksPerPoll blocks), fold. */
  async poll() {
    if (this.polling || this.stale) return this.status();
    this.polling = true;
    try {
      const nodeTip = await this.#call('getblockcount', []);
      // REORG: walk down from our tip while our block is not the node's block at that height
      let top = this.tip;
      while (top > this.store.sortedTip && top <= nodeTip + 0 && this.blocks.has(top)) {
        const theirs = await this.#call('getblockhash', [top]).catch(() => null);
        if (theirs === this.blocks.get(top).hash) break;
        top--;
      }
      // a tip above the node's (the node rolled back past it) is also a fork
      while (top > nodeTip && top > this.store.sortedTip) top--;
      // WALKED DOWN TO WHAT IS FOLDED: that block must still be the node's too, or the reorganisation
      // went below the tail. Checked every poll -- a tail can be empty, with everything folded.
      if (top === this.store.sortedTip) {
        const known = this.#foldedHash(top);
        const theirs = top <= nodeTip ? await this.#call('getblockhash', [top]).catch(() => null) : null;
        if (known && theirs !== known) { this.stale = `the chain reorganised at or below block ${top}, which is already folded into the index; rebuild the index`; return this.status(); }
        if (!known) top = Math.min(top, this.store.sortedTip);
      }
      if (top < this.tip) {
        if (top < this.store.sortedTip) { this.stale = `the chain reorganised below block ${this.store.sortedTip}, which is already folded; rebuild the index`; return this.status(); }
        const payload = Buffer.alloc(4); payload.writeUInt32LE(top, 0);
        this.#append(record(T_ROLLBACK, payload));
        for (const h of [...this.blocks.keys()]) if (h > top) this.#drop(h);
        this.log?.info?.(`live index: rolled back to block ${top}`);
      }
      // CATCH UP
      for (let h = this.tip + 1, n = 0; h <= nodeTip && n < this.maxBlocksPerPoll; h++, n++) {
        const hash = await this.#call('getblockhash', [h]);
        const block = await this.#call('getblock', [hash, 3], 300_000);
        if (block.height !== h) throw new Error(`getblock ${hash} answered height ${block.height}, expected ${h}`);
        if (h > 0 && this.blocks.has(h - 1) && block.previousblockhash !== this.blocks.get(h - 1).hash) break;   // a reorg mid-catch-up: next poll rolls back
        const sink = new RowSink(1 << 14);
        verboseBlockRows(block, h, sink);
        const rows = Buffer.from(sink.bytes());
        const head = Buffer.alloc(36); head.writeUInt32LE(h, 0); Buffer.from(hash, 'hex').copy(head, 4);
        this.#append(record(T_BLOCK, Buffer.concat([head, rows])));
        this.#add(h, hash, rows);
      }
      this.#fold(nodeTip);
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      this.log?.warn?.(`live index: ${err.message}`);
    } finally {
      this.polling = false;
      this.lastPollAt = Date.now();
    }
    return this.status();
  }

  // The hash of the highest folded block: the base's from its manifest, a layer's from layers/tips.json
  // (written with the layer, since a layer file carries rows and no block hashes).
  #foldedHash(height) {
    if (height === this.store.manifest.tip.height) return this.store.manifest.tip.hash;
    try { return JSON.parse(readFileSync(path.join(this.dir, 'layers', 'tips.json'), 'utf8'))[height] ?? null; } catch { return null; }
  }

  // --- folding --------------------------------------------------------------------------------
  #fold(nodeTip) {
    const deep = [...this.blocks.keys()].filter((h) => h <= nodeTip - this.confirmations).sort((a, b) => a - b);
    if (deep.length < this.foldBlocks) return;
    const from = deep[0], to = deep[deep.length - 1];
    const { rows, idx } = sortRows(Buffer.concat(deep.map((h) => this.blocks.get(h).rows)), this.store.blockRows);
    const dir = path.join(this.dir, 'layers');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = path.join(dir, `L${from}-${to}`);
    // the top block's hash first, so a layer is never on disk without it
    let tips = {};
    try { tips = JSON.parse(readFileSync(path.join(dir, 'tips.json'), 'utf8')); } catch { /* the first layer */ }
    tips[to] = this.blocks.get(to).hash;
    writeAtomic(path.join(dir, 'tips.json'), Buffer.from(JSON.stringify(tips)));
    writeAtomic(base + '.idx', idx);
    writeAtomic(base + '.rows', rows);
    this.store.reloadLayers();
    // the log keeps only what is still in memory: rewritten, then swapped in whole
    for (const h of deep) this.#drop(h);
    const keep = [...this.blocks.keys()].sort((a, b) => a - b).map((h) => {
      const b = this.blocks.get(h);
      const head = Buffer.alloc(36); head.writeUInt32LE(h, 0); Buffer.from(b.hash, 'hex').copy(head, 4);
      return record(T_BLOCK, Buffer.concat([head, b.rows]));
    });
    writeAtomic(this.logFile, Buffer.concat(keep));
    this.log?.info?.(`live index: folded blocks ${from}..${to} (${rows.length / ROW} rows) into a layer`);
    if (this.store.layers.length > this.maxLayers) this.#merge();
  }

  #merge() {
    const layers = this.store.layers;
    const from = layers[0].from, to = layers[layers.length - 1].to;
    const dir = path.join(this.dir, 'layers');
    const parts = layers.map((l) => readFileSync(path.join(dir, `L${l.from}-${l.to}.rows`)));
    const { rows, idx } = sortRows(Buffer.concat(parts), this.store.blockRows);
    const base = path.join(dir, `L${from}-${to}`);
    // the merged layer under its final name first, then the old ones removed. A crash in between leaves
    // the old layers AND the merged one on disk; the store ignores a layer whose range lies inside
    // another's (IndexStore.reloadLayers), so nothing is counted twice, and the next merge tidies up.
    writeAtomic(base + '.idx', idx);
    writeAtomic(base + '.rows', rows);
    for (const l of layers) { unlinkSync(path.join(dir, `L${l.from}-${l.to}.rows`)); unlinkSync(path.join(dir, `L${l.from}-${l.to}.idx`)); }
    this.store.reloadLayers();
    this.log?.info?.(`live index: merged ${layers.length} layers into L${from}-${to}`);
  }
}
