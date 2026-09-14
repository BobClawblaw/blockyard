// READING THE ADDRESS INDEX (server/chain/index/build.js writes it).
//
// 256 immutable segments, one per first key byte: seg-XX.rows holds sorted 21-byte rows, seg-XX.idx
// the first key of every BLOCK_ROWS-th row. All the idx files together are a few megabytes and are
// held in memory; a lookup binary-searches them and reads only the row blocks that can hold its key.
import { openSync, readSync, closeSync, readFileSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { ROW, scriptKey, readRow } from './rows.js';
import { FORMAT } from './build.js';

export class IndexStore {
  constructor(dir) {
    this.dir = dir;
    this.manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (this.manifest.format !== FORMAT) throw new Error(`index format ${this.manifest.format}, this code reads ${FORMAT}`);
    this.blockRows = this.manifest.blockRows;
    this.segments = Array.from({ length: 256 }, (_, b) => {
      const hex = b.toString(16).padStart(2, '0');
      let idx;
      try { const raw = readFileSync(path.join(dir, `seg-${hex}.idx`)); idx = new BigUint64Array(raw.buffer, raw.byteOffset, raw.length / 8).slice(); } catch { return null; }
      const fd = openSync(path.join(dir, `seg-${hex}.rows`), 'r');
      return { idx, fd, rows: fstatSync(fd).size / ROW };
    });
    this.scratch = Buffer.allocUnsafe(ROW * this.blockRows);
  }

  close() { for (const s of this.segments) if (s) closeSync(s.fd); }

  // Visit every row for a key, oldest first: visit(buf, at) for each, without allocating per row.
  // Keys are compared as two unsigned 32-bit halves read straight from the page -- a BigInt per row
  // was most of a lookup's time for an address with many rows.
  #scan(key, visit) {
    const seg = this.segments[Number(key >> 56n)];
    if (!seg) return;
    let lo = 0, hi = seg.idx.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (seg.idx[mid] < key) lo = mid; else hi = mid - 1; }
    const kh = Number(key >> 32n), kl = Number(key & 0xffffffffn);
    for (let block = lo; block < seg.idx.length; block++) {
      const start = block * this.blockRows;
      const want = Math.min(this.blockRows, seg.rows - start) * ROW;
      const got = readSync(seg.fd, this.scratch, 0, want, start * ROW);
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
  }

  /** Every row for a key (a BigInt from scriptKey), oldest first. */
  rowsForKey(key) {
    const out = [];
    this.#scan(key, (buf, at) => out.push(readRow(buf, at)));
    return out;
  }

  rowsForScript(script) { return this.rowsForKey(scriptKey(script)); }

  /**
   * What an address page needs: transaction count, balance, and the newest `limit` rows. Balance is
   * the sum of every row's net; `received` and `sent` are sums of those nets by sign, so a transaction
   * that both paid and spent a script counts once, by its net -- not the gross figures an explorer
   * that stores every output separately would show.
   */
  summaryForKey(key, { limit = 25 } = {}) {
    let txCount = 0, balance = 0, received = 0, sent = 0;
    // the newest `limit` rows in a ring of raw bytes: no object per row, whatever the address's size
    const ring = Buffer.allocUnsafe(Math.max(1, limit) * ROW);
    this.#scan(key, (buf, at) => {
      const hi = buf.readInt32BE(at + 13), lo = buf.readUInt32BE(at + 17);
      const v = hi * 4294967296 + lo;
      txCount++; balance += v; if (v > 0) received += v; else sent -= v;
      if (limit > 0) buf.copy(ring, ((txCount - 1) % limit) * ROW, at, at + ROW);
    });
    const recent = [];
    for (let k = 0; k < Math.min(limit, txCount); k++) recent.push(readRow(ring, (((txCount - 1 - k) % limit) + limit) % limit * ROW));
    return { txCount, balance, received, sent, recent };
  }

  summary(script, opts) { return this.summaryForKey(scriptKey(script), opts); }
}
