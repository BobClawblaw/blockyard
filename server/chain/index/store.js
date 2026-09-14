// READING THE ADDRESS INDEX (server/chain/index/build.js writes the base; live.js adds to it).
//
// Three kinds of source, read in height order so a history comes out oldest first:
//   base    256 immutable segments from the full build: seg-XX.rows sorted 21-byte rows, seg-XX.idx
//           the first key of every BLOCK_ROWS-th row (a few megabytes in all, held in memory)
//   layers  layers/L<from>-<to>.rows + .idx: the same sorted rows for a run of later blocks, folded
//           out of the live tail once they are deep enough never to be reorganised away
//   tail    the newest blocks, in memory (live.js), handed in as an object with scan(key, visit)
// A lookup binary-searches each sorted source's sparse keys and reads only the row blocks that can
// hold its key.
import { openSync, readSync, closeSync, readFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROW, scriptKey, readRow } from './rows.js';
import { FORMAT } from './build.js';

const LAYER = /^L(\d+)-(\d+)\.rows$/;
const RING_MAX_BLIND = 4096;   // rows (86 KB) a page may keep without first counting the history

// NO FILE IS HELD OPEN (2026-09-14): a store used to keep one descriptor per segment and layer --
// 256 and more -- for the life of the process, which is the whole soft limit on a stock macOS
// (`ulimit -n` 256) before the server has opened a socket. A lookup opens the one file it reads
// and closes it: three syscalls on a 0.25 ms lookup.
function openSorted(rowsFile, idxFile) {
  const raw = readFileSync(idxFile);
  const idx = new BigUint64Array(raw.buffer, raw.byteOffset, raw.length / 8).slice();
  return { idx, file: rowsFile, rows: statSync(rowsFile).size / ROW };
}

export class IndexStore {
  constructor(dir) {
    this.dir = dir;
    this.manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (this.manifest.format !== FORMAT) throw new Error(`index format ${this.manifest.format}, this code reads ${FORMAT}`);
    this.blockRows = this.manifest.blockRows;
    this.segments = Array.from({ length: 256 }, (_, b) => {
      const hex = b.toString(16).padStart(2, '0');
      try { return openSorted(path.join(dir, `seg-${hex}.rows`), path.join(dir, `seg-${hex}.idx`)); } catch { return null; }
    });
    this.layers = [];
    this.reloadLayers();
    this.tail = null;
    this.scratch = Buffer.allocUnsafe(ROW * this.blockRows);
  }

  /** Re-read layers/ (live.js calls this after folding or merging). */
  reloadLayers() {
    const old = this.layers;
    const dir = path.join(this.dir, 'layers');
    let names = [];
    try { names = readdirSync(dir).filter((f) => LAYER.test(f)); } catch { /* no layers yet */ }
    // a layer whose blocks lie inside another layer's range is a leftover from a merge that was
    // interrupted after the merged layer was written: skipped, or its rows would be counted twice
    const ranges = names.map((f) => { const [, from, to] = f.match(LAYER); return { f, from: Number(from), to: Number(to) }; });
    const live = ranges.filter((r) => !ranges.some((o) => o !== r && o.from <= r.from && o.to >= r.to && (o.to - o.from) > (r.to - r.from)));
    const idxOf = (f) => path.join(dir, f.replace(/\.rows$/, '.idx'));
    this.layers = live.filter((r) => { try { readFileSync(idxOf(r.f), { flag: 'r' }); return true; } catch { return false; } })
      .map((r) => ({ from: r.from, to: r.to, ...openSorted(path.join(dir, r.f), idxOf(r.f)) }))
      .sort((a, b) => a.from - b.from);
  }

  /** The highest block the base and its contiguous layers cover (the tail, if any, continues it). */
  get sortedTip() {
    let tip = this.manifest.tip.height;
    for (const l of this.layers) if (l.from === tip + 1) tip = l.to;
    return tip;
  }

  get tip() {
    return this.tail?.tip != null && this.tail.tip > this.sortedTip ? this.tail.tip : this.sortedTip;
  }

  close() { /* nothing is held open; kept for callers */ }

  // Visit every row for a key in one sorted source, without allocating per row. Keys are compared as
  // two unsigned 32-bit halves read straight from the page -- a BigInt per row was most of a lookup's
  // time for an address with many rows.
  #scanSorted(src, key, visit) {
    if (!src || !src.idx.length) return;
    let lo = 0, hi = src.idx.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (src.idx[mid] < key) lo = mid; else hi = mid - 1; }
    const kh = Number(key >> 32n), kl = Number(key & 0xffffffffn);
    const fd = openSync(src.file, 'r');
    try {
      for (let block = lo; block < src.idx.length; block++) {
        const start = block * this.blockRows;
        const want = Math.min(this.blockRows, src.rows - start) * ROW;
        const got = readSync(fd, this.scratch, 0, want, start * ROW);
        for (let at = 0; at < got; at += ROW) {
          const h = this.scratch.readUInt32BE(at);
          if (h < kh) continue;
          if (h > kh) return;
          const l = this.scratch.readUInt32BE(at + 4);
          if (l < kl) continue;
          if (l > kl) return;
          visit(this.scratch, at);
        }
      }
    } finally { closeSync(fd); }
  }

  /** Every row for a key across base, layers and tail, oldest block first. */
  forEachRow(key, visit) {
    this.#scanSorted(this.segments[Number(key >> 56n)], key, visit);
    for (const l of this.layers) this.#scanSorted(l, key, visit);
    this.tail?.scan(key, visit);
  }

  /** Every row for a key (a BigInt from scriptKey), oldest first. */
  rowsForKey(key) {
    const out = [];
    this.forEachRow(key, (buf, at) => out.push(readRow(buf, at)));
    return out;
  }

  rowsForScript(script) { return this.rowsForKey(scriptKey(script)); }

  /**
   * What an address page needs: transaction count, balance, and `limit` rows newest first after
   * skipping the newest `skip` (a page). Balance is the sum of every row's net; `received` and `sent`
   * are sums of those nets by sign, so a transaction that both paid and spent a script counts once,
   * by its net -- not the gross figures an explorer that stores every output separately would show.
   */
  summaryForKey(key, { limit = 25, skip = 0, maxHeight = null } = {}) {
    let txCount = 0, balance = 0, received = 0, sent = 0, postTip = 0;
    // ROWS ABOVE maxHeight ARE NOT HISTORY (audit 2026-09-14, M2): after a reorganisation the tail
    // can hold blocks the node no longer has until the follower's next poll; the caller passes the
    // node's tip and those rows are counted in `postTip`, never in the balance or the page
    const above = (buf, at) => maxHeight != null && buf.readUIntBE(at + 8, 3) > maxHeight;
    // the newest skip+limit rows in a ring of raw bytes: no object per row, whatever the address's
    // size; a page deep into a huge history keeps skip+limit rows, never the whole history.
    // THE RING IS NEVER LARGER THAN THE HISTORY (audit 2026-09-14, M1: a page number is a request
    // parameter, and `page=999999` sized a 525 MB ring for an address with two rows). A deep page
    // counts the rows first, which is the same walk again, and sizes the ring to what exists.
    let keep = Math.max(0, skip) + Math.max(0, limit);
    if (keep > RING_MAX_BLIND) {
      let n = 0;
      this.forEachRow(key, (buf, at) => { if (!above(buf, at)) n++; });
      keep = Math.min(keep, n);
    }
    const ring = Buffer.allocUnsafe(Math.max(1, keep) * ROW);
    this.forEachRow(key, (buf, at) => {
      if (above(buf, at)) { postTip++; return; }
      const hi = buf.readInt32BE(at + 13), lo = buf.readUInt32BE(at + 17);
      const v = hi * 4294967296 + lo;
      txCount++; balance += v; if (v > 0) received += v; else sent -= v;
      if (keep > 0) buf.copy(ring, ((txCount - 1) % keep) * ROW, at, at + ROW);
    });
    const recent = [];
    for (let k = skip; k < Math.min(keep, txCount); k++) recent.push(readRow(ring, ((((txCount - 1 - k) % keep) + keep) % keep) * ROW));
    return { txCount, balance, received, sent, recent, postTip };
  }

  summary(script, opts) { return this.summaryForKey(scriptKey(script), opts); }
}
