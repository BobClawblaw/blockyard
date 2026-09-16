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
// An interrupted build resumes: build-journal.json records the block files scanned and the buckets
// sorted, and nothing it cannot prove (THE BUILD JOURNAL, below).
//
// The node's files are only read. Output goes to `out`, which should be on a different device from
// the block files if one is available: the build reads ~880 GB and writes ~120 GB.
import { Worker } from 'node:worker_threads';
import { openSync, writeSync, closeSync, mkdirSync, readdirSync, rmSync, renameSync, statSync, readFileSync, fsyncSync, ftruncateSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { HeightTable } from './heights.js';
import { xorKey } from '../blockfile.js';
import { ROW } from './rows.js';

export const FORMAT = 1;
export const BLOCK_ROWS = 4096;

async function chainHashes(rpc, tip, onProgress, pace = null) {
  const table = new HeightTable(1 << 21);
  const hashes = new Array(tip + 1);
  // small batches at the lowest priority: the monitor's own polls interleave between them, and
  // on a machine shared with the node a 5,000-call batch held the lane for seconds (2026-09-14)
  const BATCH = 1000;
  for (let from = 0; from <= tip; from += BATCH) {
    if (pace) await pace();   // the batches load the node too: hold while it is slow (2026-09-14)
    const calls = [];
    for (let h = from; h <= Math.min(tip, from + BATCH - 1); h++) calls.push({ method: 'getblockhash', params: [h] });
    const got = await rpc.batch(calls, { key: `index:hashes:${from}`, timeoutMs: 120_000, maxWaitMs: 600_000, priority: 9 });
    got.forEach((g, i) => {
      if (!g.ok) throw new Error(`getblockhash ${from + i}: ${g.error?.message}`);
      hashes[from + i] = g.result;
      table.set(g.result, from + i);
    });
    onProgress?.({ phase: 'heights', done: Math.min(tip + 1, from + BATCH), total: tip + 1 });
  }
  return { table, hashes };
}

export class Pool {
  constructor(size, workerData, script = new URL('./worker.js', import.meta.url)) {
    this.closing = false;
    this.lost = null;
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(script, { workerData });
      w.on('exit', (code) => { if (!this.closing) this.lost ??= `exited with code ${code}`; });
      return w;
    });
  }
  // run jobs, at most one per worker; onResult may be async (it is awaited before that worker's next
  // job); `pace`, if given, is awaited before each job is handed out -- the server's background build
  // uses it to hold the workers while the node's RPC is slow, since they share its disk
  //
  // A WORKER THAT DIES FAILS THE RUN (2026-09-15, the first Mac install: the build sat at "scan
  // 5,720 of 5,721, about 1 s left" for an hour and a half). Only `message` was listened for, so a
  // worker killed outright -- out of memory is the way on a machine with four of them beside the
  // node -- answered nothing, its job was never finished and never reported, and the other workers
  // drained the list and left the run waiting for a reply that could not come. `exit` and `error`
  // are the reply now: the run rejects, naming the job and the way to run again.
  //
  // A worker that exits BETWEEN jobs fails the run too: it was waited on for a reply to a job it was
  // about to be given, and a later run on the same pool (the sort, after the scan) would hand it one.
  async run(jobs, onResult, pace = null) {
    if (this.lost) throw new Error(`an index worker ${this.lost} between jobs -- if the machine ran out of memory, run again with fewer workers (addressIndexWorkers in config/local.json; each needs about 2.5 GB)`);
    let next = 0, failed = null;
    await Promise.all(this.workers.map((w) => new Promise((resolve) => {
      let current = null;
      const die = (why) => {
        if (failed) { resolve(); return; }
        failed = new Error(`an index worker ${why} while on ${current ? JSON.stringify(current) : 'no job'} -- if the machine ran out of memory, run again with fewer workers (addressIndexWorkers in config/local.json; each needs about 2.5 GB)`);
        resolve();
      };
      w.on('exit', (code) => { if (!this.closing) die(`exited with code ${code}`); });
      w.on('error', (err) => die(`threw: ${err?.message ?? err}`));
      const go = async () => {
        if (failed || next >= jobs.length) { current = null; resolve(); return; }
        const job = jobs[next++];
        if (pace) { try { await pace(); } catch (err) { failed ??= err; resolve(); return; } }
        if (failed) { resolve(); return; }
        current = job;
        w.once('message', async (msg) => {
          current = null;
          if (msg.type === 'error') { failed ??= new Error(`${JSON.stringify(msg.job)}: ${msg.message}`); resolve(); return; }
          try { await onResult(msg); } catch (err) { failed ??= err; resolve(); return; }
          go();
        });
        w.postMessage(job);
      };
      go();
    })));
    if (failed) throw failed;
  }
  close() { this.closing = true; return Promise.all(this.workers.map((w) => w.terminate())); }
}

/** Workers for a build on this machine: four cores left for the node, ~2.5 GB of memory each, sixteen at most. */
export function defaultWorkers(cpus = os.cpus().length, totalMem = os.totalmem()) {
  return Math.max(1, Math.min(16, cpus - 4, Math.floor(totalMem / 2.5e9)));
}

/**
 * A pace for a build that shares its machine with the node (every build does now): before each
 * file is handed to a worker, wait while the node's RPC is failing, its breaker is open, or its
 * answers average more than `slowMs`; ease off (one file per `easeMs`) while they are merely slow.
 * Reads from the lane's own telemetry, so it costs the node nothing to ask. (2026-09-14, the first
 * Mac install: a build at full speed on the node's disk turned its RPC into 18 s answers and
 * 90 s timeouts.)
 */
// `slowMs` is the monitor's own idea of slow (rpc.slowLatencyMs, 5 s by default): a node whose
// heavy reads take a second when perfectly well -- the first Mac -- was being held at one second
// and eased at a quarter of it, and a healthy build ran at a sixth of its speed (2026-09-14)
export function rpcPacer(rpc, { slowMs = 5000, easeMs = 250, holdMs = 10_000, onChange = null } = {}) {
  let held = false;
  return async () => {
    for (;;) {
      const t = rpc?.telemetry?.() ?? {};
      const failing = !!t.breakerOpen || (t.lastError && (!t.lastGoodAt || t.lastError.at > t.lastGoodAt) && Date.now() - t.lastError.at < 60_000);
      const avg = Number.isFinite(t.avgLatencyMs) ? t.avgLatencyMs : 0;
      if (failing || avg > slowMs) {
        if (!held) { held = true; onChange?.(true, t); }
        await new Promise((r) => setTimeout(r, holdMs));
        continue;
      }
      if (held) { held = false; onChange?.(false, t); }
      if (avg > slowMs * 0.4) await new Promise((r) => setTimeout(r, easeMs));
      return;
    }
  };
}

// ---------------------------------------------------------------------------------------------------
// THE BUILD JOURNAL: an interrupted build resumes (2026-09-16). The build reads ~880 GB and runs for
// hours, and a stop used to throw all of it away. `build-journal.json`, next to the partial output,
// records what is PROVEN done, and nothing else:
//
//   scan   per block file. After a file's rows are appended, the bucket files hold exactly the rows of
//          the files finished so far -- the main thread appends one whole file at a time -- so a
//          checkpoint is: fsync every bucket written since the last one, then write the journal with
//          the set of finished files, each bucket's length and a running CRC-32 of its bytes, the
//          heights seen and the counters. On resume every bucket is cut back to its journaled length,
//          which removes whatever an unfinished file had appended; that file is scanned again.
//   sort   per bucket. The worker writes seg-XX.rows/.idx to a temporary name, fsyncs and renames;
//          the journal then records the bucket sorted, and only after that is the unsorted input
//          deleted. A bucket not in the journal is sorted again from its unsorted file, which the
//          worker first checks against the journaled length and CRC -- corrupt input is never sorted.
//
// A checkpoint is written at most once a `checkpointMs` (a minute by default: an fsync of 256 files
// for every one of 5,700 block files would cost more than it saves), at the end of the scan, after
// every sorted bucket and when the scan fails in an orderly way. The journal is written to a temporary
// file, fsynced and renamed, and carries a SHA-256 of its own body: a torn or edited journal is not
// trusted. It identifies the build it belongs to -- journal version, index format, row and block
// sizes, chain, tip height and hash, the --files selection -- and a resume that does not match all of
// them, whose tip the node no longer has on its active chain, or whose files on disk disagree with it,
// discards the partial output and starts over, saying why. The build's tip is the journal's, not the
// node's newer one: the resumed index is the index an uninterrupted build started then would have
// written, row for row, and the follower catches it up to the node as it does any finished build.
//
// The manifest is still written last and atomically, and the journal is removed after it: readers
// never see an index without a manifest, and a manifest is never beside a journal that is still needed.
export const JOURNAL = 'build-journal.json';
const JOURNAL_VERSION = 1;

function syncDir(dir) {
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* a directory cannot be fsynced everywhere */ }
}

/** Write a file durably and atomically: a temporary name, fsync, rename, fsync the directory. */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const fd = openSync(tmp, 'w');
  try { for (let o = 0; o < buf.length;) o += writeSync(fd, buf, o, buf.length - o); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  syncDir(path.dirname(file));
}

// a sorted set of integers as [first, last] runs: the files scanned are thousands of numbers but a few runs
const toRuns = (sorted) => { const r = []; for (const n of sorted) { if (r.length && r[r.length - 1][1] === n - 1) r[r.length - 1][1] = n; else r.push([n, n]); } return r; };
const fromRuns = (runs) => { const out = []; for (const [a, b] of runs) for (let n = a; n <= b; n++) out.push(n); return out; };
const isInt = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const isRuns = (r, max) => Array.isArray(r) && r.every((x, i) => Array.isArray(x) && x.length === 2 && isInt(x[0]) && isInt(x[1]) && x[0] <= x[1] && x[1] <= max && (i === 0 || x[0] > r[i - 1][1] + 1));

/** A journal body as the file holds it: the body's JSON text and the SHA-256 of that text. */
export function journalText(body) {
  const text = JSON.stringify(body);
  return JSON.stringify({ sha256: createHash('sha256').update(text).digest('hex'), body: text }) + '\n';
}

/**
 * The journal in `out`, checked: { journal } when it is whole and well formed, { none } when there is
 * none, { bad: why } when it cannot be trusted. Whether it belongs to THIS build is buildIndex's question.
 */
export function readJournal(out) {
  let raw;
  try { raw = readFileSync(path.join(out, JOURNAL), 'utf8'); } catch (err) { return err.code === 'ENOENT' ? { none: true } : { bad: `the journal could not be read (${err.code ?? err.message})` }; }
  let j;
  try {
    const outer = JSON.parse(raw);
    if (typeof outer?.body !== 'string' || typeof outer.sha256 !== 'string') return { bad: 'the journal is not a journal' };
    if (createHash('sha256').update(outer.body).digest('hex') !== outer.sha256) return { bad: 'the journal\'s checksum does not match its contents (a torn or edited write)' };
    j = JSON.parse(outer.body);
  } catch (err) { return { bad: `the journal is not readable JSON (${err.message}) -- a torn write` }; }
  const tipH = j?.tip?.height;
  const ok = !!j && j.journal === JOURNAL_VERSION && isInt(j.format, 1) && isInt(j.rowBytes, 1) && isInt(j.blockRows, 1)
    && typeof j.chain === 'string' && isInt(tipH) && /^[0-9a-f]{64}$/.test(j.tip.hash ?? '')
    && (j.files === 'all' || (Array.isArray(j.files) && j.files.every((f) => isInt(f))))
    && Array.isArray(j.fileList) && j.fileList.every((f) => isInt(f))
    && (j.phase === 'scan' || j.phase === 'sort') && isRuns(j.scanned, 99999) && isRuns(j.seen, tipH)
    && Array.isArray(j.buckets) && j.buckets.length === 256 && j.buckets.every((b) => Array.isArray(b) && b.length === 2 && isInt(b[0]) && b[0] % j.rowBytes === 0 && isInt(b[1]) && b[1] <= 0xffffffff)
    && Array.isArray(j.sorted) && j.sorted.length === 256 && j.sorted.every((s, b) => s === null || (j.phase === 'sort' && Array.isArray(s) && s.length === 3 && isInt(s[0]) && isInt(s[1]) && Number.isFinite(s[2]) && (s[0] + s[1]) * j.rowBytes === j.buckets[b][0]))
    && !!j.counters && ['rows', 'stale', 'missingUndo', 'dupHeights', 'readMs', 'workMs'].every((k) => Number.isFinite(j.counters[k]) && j.counters[k] >= 0)
    && isInt(j.resumes);
  return ok ? { journal: j } : { bad: 'the journal is whole but not in the shape this code writes' };
}

/**
 * Build the index into `out`, resuming an interrupted build there when its journal proves it can.
 * `log(text)` hears why a journal was discarded or where a build resumed. `hook(point, info)` is for
 * tests: it is called at the points where an interruption matters, and a throw there stops the build
 * as a crash would.
 */
export async function buildIndex({ rpc, blocksDir, out, workers = defaultWorkers(), files = null, onProgress = () => {}, pace = null, log = () => {}, checkpointMs = 60_000, hook = null }) {
  const t0 = performance.now();
  const stats = { format: FORMAT, workers, phases: {} };
  const info = await rpc.batch([{ method: 'getblockchaininfo', params: [] }], { key: 'index:info', timeoutMs: 60_000 });
  if (!info[0].ok) throw new Error(`getblockchaininfo: ${info[0].error?.message}`);
  const { chain, blocks: nodeTip } = info[0].result;
  if (chain !== 'main') throw new Error(`only mainnet block files are framed here so far (the node is on ${chain})`);
  const selection = files ? [...files] : 'all';
  const discarding = (why) => log(`address index build: discarding the interrupted build in ${out} and starting over: ${why}`);

  // --- resume? --------------------------------------------------------------
  // The journal's identity is checked here, cheaply (one getblockhash); the files on disk are checked
  // against it after the heights phase, where a fresh build clears the directory.
  let journal = null;
  let hasManifest = false;
  try { statSync(path.join(out, 'manifest.json')); hasManifest = true; } catch { /* no finished index */ }
  const found = hasManifest ? { none: true } : readJournal(out);
  if (found.bad) discarding(found.bad);
  else if (found.journal) {
    const j = found.journal;
    let why = null;
    if (j.format !== FORMAT || j.rowBytes !== ROW || j.blockRows !== BLOCK_ROWS) why = `the journal is for index format ${j.format} (${j.rowBytes}-byte rows, ${j.blockRows} to a block) and this code writes format ${FORMAT} (${ROW}, ${BLOCK_ROWS})`;
    else if (j.chain !== chain) why = `the journal is for chain ${j.chain} and the node is on ${chain}`;
    else if (JSON.stringify(j.files) !== JSON.stringify(selection)) why = `the journal is for files ${JSON.stringify(j.files)} and this build is for ${JSON.stringify(selection)}`;
    else if (nodeTip < j.tip.height) why = `the journal's tip is block ${j.tip.height} and the node is at ${nodeTip} (a reindex, or a different node)`;
    else {
      const got = await rpc.batch([{ method: 'getblockhash', params: [j.tip.height] }], { key: 'index:resume', timeoutMs: 60_000, maxWaitMs: 600_000, priority: 9 });
      if (!got[0].ok) throw new Error(`getblockhash ${j.tip.height}: ${got[0].error?.message}`);
      if (got[0].result !== j.tip.hash) why = `block ${j.tip.height} is ${got[0].result} on the node's chain now, not the journal's ${j.tip.hash} (a reorganisation below the build's tip)`;
    }
    if (why) discarding(why); else journal = j;
  }
  const tip = journal ? journal.tip.height : nodeTip;

  let t = performance.now();
  const { table, hashes } = await chainHashes(rpc, tip, onProgress, pace);
  stats.phases.heightsSec = (performance.now() - t) / 1000;
  if (journal && hashes[tip] !== journal.tip.hash) { discarding(`block ${tip} changed on the node's chain while its hashes were read`); journal = null; }

  const hex2 = (b) => b.toString(16).padStart(2, '0');
  const bucketName = (b) => `bucket-${hex2(b)}.unsorted`;
  const bucketFile = (b) => path.join(out, bucketName(b));
  const sizeOf = (f) => { try { return statSync(path.join(out, f)).size; } catch { return -1; } };

  // the files on disk must be what the journal says, or the journal is not trusted either
  if (journal) {
    const keep = new Set([JOURNAL]);
    let why = null;
    for (let b = 0; b < 256 && !why; b++) {
      const len = journal.buckets[b][0], sorted = journal.sorted[b];
      if (sorted) {
        const rows = sorted[0];
        if (sizeOf(`seg-${hex2(b)}.rows`) !== rows * ROW || sizeOf(`seg-${hex2(b)}.idx`) !== Math.ceil(rows / BLOCK_ROWS) * 8) why = `bucket ${hex2(b)} is journaled as sorted but its segment files are not the journaled size`;
        keep.add(`seg-${hex2(b)}.rows`); keep.add(`seg-${hex2(b)}.idx`);
      } else if (len > 0) {
        const size = sizeOf(bucketName(b));
        if (size < len) why = `bucket ${hex2(b)} holds ${Math.max(0, size)} bytes and the journal proves ${len}`;
        else if (journal.phase === 'sort' && size !== len) why = `bucket ${hex2(b)} grew after its scan was finished`;
        keep.add(bucketName(b));
      }
    }
    if (why) { discarding(why); journal = null; }
    else {
      // cut every bucket back to what is proven, and drop everything not proven: rows an unfinished
      // file appended, a segment the journal never recorded, a temporary file, an input already sorted
      for (let b = 0; b < 256; b++) {
        if (journal.sorted[b] || journal.buckets[b][0] === 0) continue;
        const fd = openSync(bucketFile(b), 'r+');
        try { ftruncateSync(fd, journal.buckets[b][0]); fsyncSync(fd); } finally { closeSync(fd); }
      }
      for (const f of readdirSync(out)) if (!keep.has(f)) rmSync(path.join(out, f), { recursive: true, force: true });
      syncDir(out);
    }
  }
  if (!journal) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
  }

  const all = readdirSync(blocksDir).filter((f) => /^blk\d{5}\.dat$/.test(f)).map((f) => Number(f.slice(3, 8))).sort((a, b) => a - b);
  // a resume scans the files it listed and did not finish, and any file that has appeared since: its
  // blocks above the tip are skipped as in any build, and a block at or below it that is stored twice
  // is de-duplicated by the sort
  const fileList = journal ? [...new Set([...journal.fileList, ...(files ? [] : all)])].sort((a, b) => a - b) : (files ?? all);
  const scannedSet = new Set(journal ? fromRuns(journal.scanned) : []);
  const state = {
    phase: journal?.phase ?? 'scan',
    bucketLen: journal ? journal.buckets.map((b) => b[0]) : new Array(256).fill(0),
    bucketCrc: journal ? journal.buckets.map((b) => b[1]) : new Array(256).fill(0),
    sorted: journal ? journal.sorted.slice() : new Array(256).fill(null),
    counters: journal ? { ...journal.counters } : { rows: 0, stale: 0, missingUndo: 0, dupHeights: 0, readMs: 0, workMs: 0 },
    resumes: journal ? journal.resumes + 1 : 0,
  };
  const seen = new Uint8Array(tip + 1);
  if (journal) for (const [a, b] of journal.seen) seen.fill(1, a, b + 1);
  const writeJournal = () => {
    const seenRuns = [];
    for (let h = 0; h <= tip; h++) if (seen[h]) { const last = seenRuns[seenRuns.length - 1]; if (last && last[1] === h - 1) last[1] = h; else seenRuns.push([h, h]); }
    writeFileAtomic(path.join(out, JOURNAL), journalText({
      journal: JOURNAL_VERSION, format: FORMAT, rowBytes: ROW, blockRows: BLOCK_ROWS, chain,
      tip: { height: tip, hash: hashes[tip] }, files: selection, fileList, phase: state.phase,
      scanned: toRuns([...scannedSet].sort((a, b) => a - b)), seen: seenRuns,
      buckets: state.bucketLen.map((len, b) => [len, state.bucketCrc[b]]), sorted: state.sorted,
      counters: state.counters, resumes: state.resumes, writtenAt: new Date().toISOString(),
    }));
    hook?.('journal', { phase: state.phase, scanned: scannedSet.size, sorted: state.sorted.filter(Boolean).length });
  };
  if (journal) {
    log(`address index build: resuming the interrupted build in ${out} at block ${tip} -- ${state.phase === 'scan' ? `${scannedSet.size} of ${fileList.length} block files already scanned` : `scan finished, ${state.sorted.filter(Boolean).length} buckets already sorted`}`);
    stats.resumed = { times: state.resumes, filesSkipped: scannedSet.size, bucketsSkipped: state.sorted.filter(Boolean).length };
  } else writeJournal();

  const pool = new Pool(workers, { blocksDir, key: xorKey(blocksDir), heightsBuffer: table.buffer, heightsCapacity: table.capacity, blockRowsPerIndex: BLOCK_ROWS });
  const c = state.counters;
  hook?.('pool', { pool });

  try {
    // --- scan -------------------------------------------------------------------
    t = performance.now();
    if (state.phase === 'scan') {
      // AT MOST 64 BUCKET FILES OPEN AT ONCE (2026-09-14): 256 held open for the whole scan is the
      // entire soft limit on a stock macOS (`ulimit -n` 256). The least recently written is closed
      // and reopened for append when a 65th is needed -- a few thousand extra opens over a build.
      const fds = new Array(256).fill(null), lru = [];
      const MAX_OPEN = 64;
      const fdFor = (b) => {
        if (fds[b] === null) {
          if (lru.length >= MAX_OPEN) { const old = lru.shift(); closeSync(fds[old]); fds[old] = null; }
          fds[b] = openSync(bucketFile(b), 'a');
        } else lru.splice(lru.indexOf(b), 1);
        lru.push(b);
        return fds[b];
      };
      const dirty = new Set();
      // AN APPEND THAT FAILED PART WAY POISONS THE SCAN: the lengths in memory then include part of a
      // file that is not finished, and no checkpoint may be written from them
      let poisoned = false, lastCheckpoint = Date.now();
      const checkpoint = () => {
        if (poisoned) return;
        for (const b of dirty) {
          if (fds[b] !== null) fsyncSync(fds[b]);
          else { const fd = openSync(bucketFile(b), 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
        }
        dirty.clear();
        syncDir(out);
        writeJournal();
        lastCheckpoint = Date.now();
      };
      const todo = fileList.filter((f) => !scannedSet.has(f));
      const from = scannedSet.size;
      onProgress({ phase: 'scan', done: from, from, total: fileList.length, rows: c.rows });
      try {
        await pool.run(todo.map((file) => ({ type: 'scan', file })), (msg) => {
          if (poisoned) throw new Error(`block file ${msg.file} was scanned after an append failed`);
          poisoned = true;
          const data = Buffer.from(msg.data);
          msg.parts.forEach(([b, lo, hi], i) => {
            const fd = fdFor(b);
            for (let o = lo; o < hi;) o += writeSync(fd, data, o, hi - o);
            state.bucketLen[b] += hi - lo;
            state.bucketCrc[b] = crc32(data.subarray(lo, hi), state.bucketCrc[b]);
            dirty.add(b);
            hook?.('scan-part', { file: msg.file, part: i, parts: msg.parts.length });
          });
          for (const h of msg.heights) { if (seen[h]) c.dupHeights++; seen[h] = 1; }
          c.rows += msg.rows; c.readMs += msg.readMs; c.workMs += msg.ms; c.stale += msg.stale; c.missingUndo += msg.missingUndo;
          scannedSet.add(msg.file);
          poisoned = false;
          onProgress({ phase: 'scan', done: scannedSet.size, from, total: fileList.length, rows: c.rows, file: msg.file });
          if (Date.now() - lastCheckpoint >= checkpointMs) checkpoint();
          hook?.('scanned', { file: msg.file, done: scannedSet.size, total: fileList.length });
        }, pace);
      } catch (err) {
        // an orderly failure (a worker that died, a node that went away) keeps the files finished so far
        try { checkpoint(); } catch { /* the error that stopped the scan is the one to report */ }
        throw err;
      } finally {
        for (let b = 0; b < 256; b++) if (fds[b] !== null) { closeSync(fds[b]); fds[b] = null; }
      }

      // --- check ------------------------------------------------------------------
      let missing = 0, firstMissing = -1;
      for (let h = 0; h <= tip; h++) if (!seen[h]) { missing++; if (firstMissing < 0) firstMissing = h; }
      if (!files && missing) {
        // nothing to resume: the same files would leave the same holes, so the next start scans afresh
        rmSync(path.join(out, JOURNAL), { force: true });
        throw new Error(`${missing} heights were not indexed (first ${firstMissing}); refusing to publish an index with holes`);
      }
      state.phase = 'sort';
      checkpoint();
    }
    stats.phases.scanSec = (performance.now() - t) / 1000;
    stats.scan = { files: scannedSet.size, rawRows: c.rows, workerReadSec: c.readMs / 1000, workerCpuSec: c.workMs / 1000, staleBlocks: c.stale, missingUndo: c.missingUndo, duplicateHeights: c.dupHeights };
    let missing = 0, firstMissing = -1;
    for (let h = 0; h <= tip; h++) if (!seen[h]) { missing++; if (firstMissing < 0) firstMissing = h; }
    stats.check = { tip, missingHeights: missing, firstMissing };

    // --- sort -------------------------------------------------------------------
    t = performance.now();
    const nonEmpty = [];
    for (let b = 0; b < 256; b++) if (state.bucketLen[b] > 0) nonEmpty.push(b);
    const todo = nonEmpty.filter((b) => !state.sorted[b]);
    const from = nonEmpty.length - todo.length;
    let sortedDone = from;
    const sortedRows = () => state.sorted.reduce((a, s) => a + (s ? s[0] : 0), 0);
    onProgress({ phase: 'sort', done: sortedDone, from, total: nonEmpty.length, rows: sortedRows() });
    try {
      await pool.run(todo.map((bucket) => ({ type: 'sort', bucket, dir: out, size: state.bucketLen[bucket], crc: state.bucketCrc[bucket] })), (msg) => {
        hook?.('sort-result', { bucket: msg.bucket });              // segments renamed, not yet journaled
        state.sorted[msg.bucket] = [msg.rows, msg.dupes, msg.ms];
        writeJournal();                                            // proven sorted, and only then...
        rmSync(bucketFile(msg.bucket), { force: true });           // ...is its input removed
        sortedDone++;
        onProgress({ phase: 'sort', done: sortedDone, from, total: nonEmpty.length, rows: sortedRows() });
        hook?.('sorted', { bucket: msg.bucket, done: sortedDone, total: nonEmpty.length });
      });
    } catch (err) {
      if (/does not hold what the scan wrote/.test(err.message)) {
        // the proven input is not on the disk any more: nothing the journal says can be trusted
        rmSync(path.join(out, JOURNAL), { force: true });
        discarding(err.message.split('\n')[0]);
      }
      throw err;
    }
    const counts = state.sorted.map((s) => (s ? s[0] : 0));
    stats.phases.sortSec = (performance.now() - t) / 1000;
    stats.sort = { rows: sortedRows(), duplicateRowsDropped: state.sorted.reduce((a, s) => a + (s ? s[1] : 0), 0), workerCpuSec: state.sorted.reduce((a, s) => a + (s ? s[2] : 0), 0) / 1000 };

    // --- manifest ---------------------------------------------------------------
    hook?.('manifest', {});
    let bytes = 0;
    for (const f of readdirSync(out)) if (f !== JOURNAL) bytes += statSync(path.join(out, f)).size;
    stats.totalSec = (performance.now() - t0) / 1000;
    const manifest = {
      format: FORMAT, rowBytes: ROW, blockRows: BLOCK_ROWS, chain,
      tip: { height: tip, hash: hashes[tip] }, files: files ? fileList : 'all',
      rows: sortedRows(), bucketRows: counts, bytes, builtAt: new Date().toISOString(), stats,
    };
    writeFileAtomic(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
    rmSync(path.join(out, JOURNAL), { force: true });
    syncDir(out);
    return manifest;
  } finally {
    await pool.close();
  }
}
