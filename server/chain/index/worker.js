// A build worker (server/chain/index/build.js). Two jobs, chosen per message:
//
//   scan  one blk/rev file pair -> the file's index rows, partitioned by the key's first byte into
//         256 buffers (a counting sort), so the main thread only appends each to its bucket file
//   sort  one bucket file -> sorted, de-duplicated rows plus a sparse index, each written to a
//         temporary name, fsynced and renamed. The input is first checked against the length and
//         CRC-32 the scan journaled, and it is left in place: the main thread removes it once the
//         build journal records the bucket sorted (build.js, THE BUILD JOURNAL)
import { parentPort, workerData } from 'node:worker_threads';
import { openSync, readSync, writeSync, closeSync, fstatSync, fsyncSync, renameSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import path from 'node:path';
import { Reader, readHeader } from '../tx.js';
import { readChainFile, records, pairBlocksWithUndo, MAGIC } from '../blockfile.js';
import { blockRows, RowSink, ROW } from './rows.js';
import { HeightTable } from './heights.js';
import { openTempFile } from './build.js';

const { blocksDir, key, heightsBuffer, heightsCapacity, blockRowsPerIndex } = workerData;
const heights = HeightTable.attach(heightsBuffer, heightsCapacity);
const xor = Buffer.from(key);

function scan(file) {
  const t0 = performance.now();
  const id = String(file).padStart(5, '0');
  const blk = readChainFile(path.join(blocksDir, `blk${id}.dat`), xor);
  const rev = readChainFile(path.join(blocksDir, `rev${id}.dat`), xor);
  const readMs = performance.now() - t0;
  const blocks = [];
  for (const r of records(blk, MAGIC.main, 0, xor)) {
    const rd = new Reader(r.body);
    const h = readHeader(rd);
    blocks.push({ offset: r.offset, body: r.body, hash: h.hash, previousblockhash: h.previousblockhash, ntx: rd.varint() });
  }
  const pairs = pairBlocksWithUndo(blocks, [...records(rev, MAGIC.main, 32, xor)]);
  const sink = new RowSink(1 << 18);
  const indexed = [];
  let stale = 0, missingUndo = 0;
  blocks.forEach((b, i) => {
    const height = heights.get(b.hash);
    if (height < 0) { stale++; return; }                          // not on the chain this build covers
    const undo = pairs.get(i);
    if (!undo && height !== 0) { missingUndo++; return; }
    // A CORRUPT OR MISPAIRED RECORD FAILS THE FILE, AND SO THE BUILD -- fail-safe, and kept that way
    // (audit 2026-09-16, I4) -- but the message names the files and offsets to look at
    try { blockRows(b.body, undo ? undo.body : null, height, sink); } catch (err) {
      err.message = `blk${id}.dat offset ${b.offset}${undo ? `, rev${id}.dat offset ${undo.offset}` : ''} (block ${height} ${b.hash}): ${err.message}`;
      throw err;
    }
    indexed.push(height);
  });
  // counting sort by the first key byte: 256 buffers the main thread appends as they are
  const all = sink.bytes();
  const counts = new Uint32Array(257);
  for (let at = 0; at < all.length; at += ROW) counts[all[at] + 1]++;
  for (let b = 0; b < 256; b++) counts[b + 1] += counts[b];
  const out = Buffer.allocUnsafe(all.length);
  const fill = counts.slice(0, 256);
  for (let at = 0; at < all.length; at += ROW) { const b = all[at]; all.copy(out, fill[b]++ * ROW, at, at + ROW); }
  const parts = [];
  for (let b = 0; b < 256; b++) if (counts[b + 1] > counts[b]) parts.push([b, counts[b] * ROW, counts[b + 1] * ROW]);
  const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
  return {
    msg: { type: 'scanned', file, rows: sink.n, blocks: indexed.length, heights: indexed, stale, missingUndo, parts, readMs, ms: performance.now() - t0, data: ab },
    transfer: [ab],
  };
}

function sortBucket(bucket, dir, expectSize = null, expectCrc = null) {
  const t0 = performance.now();
  const name = (s) => path.join(dir, `bucket-${bucket.toString(16).padStart(2, '0')}${s}`);
  // fd CLOSED ON EVERY PATH, INCLUDING A READ ERROR (audit 2026-09-22, L7): fstatSync/readSync can
  // throw on a genuine disk fault, and this worker process is long-lived (a build can run for
  // hours, per docs/MEASUREMENTS.md 28-30) -- an uncaught throw here used to skip closeSync
  // entirely, leaking one fd per failure. readChainFile in blockfile.js already gets this right;
  // matching it here.
  const fd = openSync(name('.unsorted'), 'r');
  let size, buf;
  try {
    size = fstatSync(fd).size;
    buf = Buffer.allocUnsafe(size);
    for (let got = 0; got < size;) { const k = readSync(fd, buf, got, size - got, got); if (!k) break; got += k; }
  } finally { closeSync(fd); }
  const hex = bucket.toString(16).padStart(2, '0');
  if (expectSize != null && size !== expectSize) throw new Error(`bucket ${hex} does not hold what the scan wrote: ${size} bytes, and the scan wrote ${expectSize}`);
  if (expectCrc != null && crc32(buf) !== expectCrc) throw new Error(`bucket ${hex} does not hold what the scan wrote: its CRC-32 is ${crc32(buf)}, and the scan's was ${expectCrc}`);
  const n = size / ROW;
  // order by the next 16 key bits into sub-buckets, then compare the rest numerically:
  // hi = key bytes 3..7 (40 bits), lo = height (24 bits) and position (16 bits)
  const sub = (i) => (buf[i * ROW + 1] << 8) | buf[i * ROW + 2];
  const counts = new Uint32Array(65537);
  for (let i = 0; i < n; i++) counts[sub(i) + 1]++;
  for (let s = 0; s < 65536; s++) counts[s + 1] += counts[s];
  const order = new Uint32Array(n), fill = counts.slice(0, 65536);
  for (let i = 0; i < n; i++) order[fill[sub(i)]++] = i;
  const hi = new Float64Array(n), lo = new Float64Array(n);
  for (let i = 0; i < n; i++) { const at = i * ROW; hi[i] = buf.readUIntBE(at + 3, 5); lo[i] = buf.readUIntBE(at + 8, 3) * 65536 + buf.readUInt16BE(at + 11); }
  for (let s = 0; s < 65536; s++) {
    const part = order.subarray(counts[s], counts[s + 1]);
    if (part.length > 1) part.sort((x, y) => hi[x] - hi[y] || lo[x] - lo[y]);
  }
  const out = Buffer.allocUnsafe(size);
  const sparse = [];
  let w = 0, dupes = 0;
  for (let k = 0; k < n; k++) {
    const at = order[k] * ROW;
    // the same block can be stored twice in blk files; its rows are then identical and kept once
    if (w > 0 && buf.compare(out, w - ROW, w - ROW + 13, at, at + 13) === 0) { dupes++; continue; }
    if ((w / ROW) % blockRowsPerIndex === 0) sparse.push(buf.readBigUInt64BE(at));
    buf.copy(out, w, at, at + ROW);
    w += ROW;
  }
  const idx = Buffer.from(new BigUint64Array(sparse).buffer);
  // a temporary name is unlinked and created afresh, owner-only: never a planted symlink followed (audit 2026-09-16, L10)
  const write = (file, data) => { const f = openTempFile(file + '.tmp'); try { for (let o = 0; o < data.length;) o += writeSync(f, data, o, data.length - o); fsyncSync(f); } finally { closeSync(f); } renameSync(file + '.tmp', file); };
  write(path.join(dir, `seg-${hex}.rows`), out.subarray(0, w));
  write(path.join(dir, `seg-${hex}.idx`), idx);
  return { msg: { type: 'sorted', bucket, rows: w / ROW, dupes, ms: performance.now() - t0 }, transfer: [] };
}

parentPort.on('message', (job) => {
  try {
    const r = job.type === 'scan' ? scan(job.file) : sortBucket(job.bucket, job.dir, job.size, job.crc);
    parentPort.postMessage(r.msg, r.transfer);
  } catch (err) {
    parentPort.postMessage({ type: 'error', job, message: err.stack || err.message });
  }
});
