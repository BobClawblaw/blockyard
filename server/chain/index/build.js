// BUILD THE ADDRESS INDEX from the node's own block and undo files (docs/MEASUREMENTS.md §28-30).
//
//   1. heights  the active chain's block hashes, 0..tip, from getblockhash in batches, into a table
//               every worker shares -- a block not in it (stale, or newer than the build) is skipped
//   2. scan     every blk/rev pair on a worker pool; each file's rows come back partitioned by the
//               key's first byte and are appended to 256 bucket files
//   3. check    every height 0..tip indexed exactly once, or the build stops rather than publish a hole
//   4. sort     each bucket sorted (and de-duplicated) on the pool into seg-XX.rows + seg-XX.idx
//   5. manifest written last, atomically: an index without one is an unfinished build
//
// The node's files are only read. Output goes to `out`, which should be on a different device from
// the block files if one is available: the build reads ~880 GB and writes ~120 GB.
import { Worker } from 'node:worker_threads';
import { openSync, writeSync, closeSync, mkdirSync, readdirSync, rmSync, renameSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HeightTable } from './heights.js';
import { xorKey } from '../blockfile.js';
import { ROW } from './rows.js';

export const FORMAT = 1;
export const BLOCK_ROWS = 4096;

async function chainHashes(rpc, tip, onProgress) {
  const table = new HeightTable(1 << 21);
  const hashes = new Array(tip + 1);
  const BATCH = 5000;
  for (let from = 0; from <= tip; from += BATCH) {
    const calls = [];
    for (let h = from; h <= Math.min(tip, from + BATCH - 1); h++) calls.push({ method: 'getblockhash', params: [h] });
    const got = await rpc.batch(calls, { key: `index:hashes:${from}`, timeoutMs: 120_000, maxWaitMs: 300_000, priority: 6 });
    got.forEach((g, i) => {
      if (!g.ok) throw new Error(`getblockhash ${from + i}: ${g.error?.message}`);
      hashes[from + i] = g.result;
      table.set(g.result, from + i);
    });
    onProgress?.({ phase: 'heights', done: Math.min(tip + 1, from + BATCH), total: tip + 1 });
  }
  return { table, hashes };
}

class Pool {
  constructor(size, workerData) {
    this.workers = Array.from({ length: size }, () => new Worker(new URL('./worker.js', import.meta.url), { workerData }));
  }
  // run jobs, at most one per worker; onResult may be async (it is awaited before that worker's next job)
  async run(jobs, onResult) {
    let next = 0, failed = null;
    await Promise.all(this.workers.map((w) => new Promise((resolve) => {
      const go = () => {
        if (failed || next >= jobs.length) { resolve(); return; }
        const job = jobs[next++];
        w.once('message', async (msg) => {
          if (msg.type === 'error') { failed = new Error(`${JSON.stringify(msg.job)}: ${msg.message}`); resolve(); return; }
          try { await onResult(msg); } catch (err) { failed = err; resolve(); return; }
          go();
        });
        w.postMessage(job);
      };
      go();
    })));
    if (failed) throw failed;
  }
  close() { return Promise.all(this.workers.map((w) => w.terminate())); }
}

export async function buildIndex({ rpc, blocksDir, out, workers = Math.max(2, Math.min(16, os.cpus().length - 4)), files = null, onProgress = () => {} }) {
  const t0 = performance.now();
  const stats = { format: FORMAT, workers, phases: {} };
  const info = await rpc.batch([{ method: 'getblockchaininfo', params: [] }], { key: 'index:info', timeoutMs: 60_000 });
  if (!info[0].ok) throw new Error(`getblockchaininfo: ${info[0].error?.message}`);
  const { chain, blocks: tip } = info[0].result;
  if (chain !== 'main') throw new Error(`only mainnet block files are framed here so far (the node is on ${chain})`);

  let t = performance.now();
  const { table, hashes } = await chainHashes(rpc, tip, onProgress);
  stats.phases.heightsSec = (performance.now() - t) / 1000;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const all = readdirSync(blocksDir).filter((f) => /^blk\d{5}\.dat$/.test(f)).map((f) => Number(f.slice(3, 8))).sort((a, b) => a - b);
  const fileList = files ?? all;
  const pool = new Pool(workers, { blocksDir, key: xorKey(blocksDir), heightsBuffer: table.buffer, heightsCapacity: table.capacity, blockRowsPerIndex: BLOCK_ROWS });

  try {
    // --- scan -------------------------------------------------------------------
    t = performance.now();
    const fds = new Array(256).fill(null);
    const bucketFile = (b) => path.join(out, `bucket-${b.toString(16).padStart(2, '0')}.unsorted`);
    const seen = new Uint8Array(tip + 1);
    let rows = 0, scanned = 0, readMs = 0, workMs = 0, stale = 0, missingUndo = 0, dupHeights = 0;
    await pool.run(fileList.map((file) => ({ type: 'scan', file })), (msg) => {
      const data = Buffer.from(msg.data);
      for (const [b, from, to] of msg.parts) {
        fds[b] ??= openSync(bucketFile(b), 'a');
        for (let o = from; o < to;) o += writeSync(fds[b], data, o, to - o);
      }
      for (const h of msg.heights) { if (seen[h]) dupHeights++; seen[h] = 1; }
      rows += msg.rows; scanned++; readMs += msg.readMs; workMs += msg.ms; stale += msg.stale; missingUndo += msg.missingUndo;
      onProgress({ phase: 'scan', done: scanned, total: fileList.length, rows, file: msg.file });
    });
    for (const fd of fds) if (fd !== null) closeSync(fd);
    stats.phases.scanSec = (performance.now() - t) / 1000;
    stats.scan = { files: scanned, rawRows: rows, workerReadSec: readMs / 1000, workerCpuSec: workMs / 1000, staleBlocks: stale, missingUndo, duplicateHeights: dupHeights };

    // --- check ------------------------------------------------------------------
    let missing = 0, firstMissing = -1;
    for (let h = 0; h <= tip; h++) if (!seen[h]) { missing++; if (firstMissing < 0) firstMissing = h; }
    stats.check = { tip, missingHeights: missing, firstMissing };
    if (!files && missing) throw new Error(`${missing} heights were not indexed (first ${firstMissing}); refusing to publish an index with holes`);

    // --- sort -------------------------------------------------------------------
    t = performance.now();
    const buckets = [];
    for (let b = 0; b < 256; b++) { try { if (statSync(bucketFile(b)).size) buckets.push(b); } catch { /* an empty bucket */ } }
    const counts = new Array(256).fill(0);
    let sortedRows = 0, dupes = 0, sortCpu = 0;
    await pool.run(buckets.map((bucket) => ({ type: 'sort', bucket, dir: out })), (msg) => {
      counts[msg.bucket] = msg.rows; sortedRows += msg.rows; dupes += msg.dupes; sortCpu += msg.ms;
      onProgress({ phase: 'sort', done: buckets.indexOf(msg.bucket) + 1, total: buckets.length, rows: sortedRows });
    });
    stats.phases.sortSec = (performance.now() - t) / 1000;
    stats.sort = { rows: sortedRows, duplicateRowsDropped: dupes, workerCpuSec: sortCpu / 1000 };

    // --- manifest ---------------------------------------------------------------
    let bytes = 0;
    for (const f of readdirSync(out)) bytes += statSync(path.join(out, f)).size;
    stats.totalSec = (performance.now() - t0) / 1000;
    const manifest = {
      format: FORMAT, rowBytes: ROW, blockRows: BLOCK_ROWS, chain,
      tip: { height: tip, hash: hashes[tip] }, files: files ? fileList : 'all',
      rows: sortedRows, bucketRows: counts, bytes, builtAt: new Date().toISOString(), stats,
    };
    writeFileSync(path.join(out, 'manifest.json.tmp'), JSON.stringify(manifest, null, 1) + '\n');
    renameSync(path.join(out, 'manifest.json.tmp'), path.join(out, 'manifest.json'));
    return manifest;
  } finally {
    await pool.close();
  }
}
