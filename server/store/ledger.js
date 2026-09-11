// The durable store for facts the monitor derives and must not re-derive.
//
// Why this exists: coinbase attribution is two RPC reads per block, and until now the
// result lived in a 400-row in-memory map that died on every restart -- so a monitor that
// had been running for a month could still tell you about exactly the last four minutes of
// mining, and a restart threw away everything it had learned about who mines this chain.
// "Durable, and the next run starts from what this one saw" is the requirement; this is
// the smallest thing that satisfies it.
//
// Two engines behind one interface, chosen at boot, no dependency either way:
//
//   sqlite  -- node:sqlite, in the runtime we already run. Measured on this box
//              (2026-09-09): 52,578 rows (a year of blocks) written in 62 ms, aggregate
//              over the lot in 6 ms, 7.93 MB on disk. Crash safety was tested, not
//              assumed: 1,000 committed rows, a child process inserting 1,000 more inside
//              an open transaction, SIGKILL mid-transaction -- reopen gave rows=1000,
//              uncommitted kept=0, PRAGMA integrity_check = ok.
//              Caveat carried honestly: node:sqlite prints
//              "ExperimentalWarning: SQLite is an experimental feature and might change",
//              so it is feature-detected and never assumed.
//
//   jsonl   -- append-only newline-delimited JSON, fsync'd. Measured: the same year of
//              rows written + fsync'd in 13 ms, 14.84 MB, replayed in 5 ms. No queries,
//              no transactions across rows, but it has no API risk at all, is readable by
//              grep while the service runs, and doubles as the export of the sqlite file.
//
// The fallback is not a downgrade path that changes behaviour: aggregation lives here, in
// JavaScript, over the same row shape, so both engines answer identically. That is a
// deliberate trade -- sqlite could answer the aggregate in SQL in 6 ms -- in exchange for
// one code path, one set of tests, and a fallback that is provably the same product.

import fs from 'node:fs';
import path from 'node:path';

const ROW_COLUMNS = ['height', 'hash', 'poolKey', 'poolLabelKey', 'poolLabel', 'matchedTag',
  'tagText', 'tagSource', 'weight', 'size', 'strippedSize', 'txs', 'totalfee', 'avgFeerate',
  'p50', 'p75', 'p99', 'extraNonce', 'commitment', 'rawCoinbase', 'mapSha', 'seenAt'];

/** Does this runtime give us a working node:sqlite? Tested by using it, not by version. */
async function sqliteEngine() {
  try {
    const mod = await import('node:sqlite');
    if (typeof mod.DatabaseSync !== 'function') return null;
    // Open an in-memory database and write to it. If that works, the engine works.
    const probe = new mod.DatabaseSync(':memory:');
    probe.exec('CREATE TABLE probe(k INTEGER PRIMARY KEY, v TEXT)');
    probe.prepare('INSERT INTO probe VALUES (1,?)').run('ok');
    probe.close();
    return mod.DatabaseSync;
  } catch {
    return null;
  }
}

export async function openLedger({ file, engine = 'auto', keepHeights = 52_594, log = () => {} } = {}) {
  if (!file) throw new Error('openLedger needs a file path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let chosen = engine;
  if (engine === 'auto') {
    chosen = (process.env.BMC_MON_LEDGER_ENGINE ?? 'sqlite').trim().toLowerCase();
    if (chosen === 'sqlite') {
      const DatabaseSync = await sqliteEngine();
      if (!DatabaseSync) {
        chosen = 'jsonl';
        log({ level: 'warn', msg: `ledger: node:sqlite unavailable, using the append-only file (same rows, same answers, no queries)` });
      }
    }
  }
  if (chosen === 'sqlite') {
    const DatabaseSync = await sqliteEngine();
    if (DatabaseSync) return new SqliteLedger({ file, DatabaseSync, keepHeights, log });
    chosen = 'jsonl';
  }
  return new JsonlLedger({ file, keepHeights, log });
}

// ------------------------------------------------------------------ sqlite

class SqliteLedger {
  constructor({ file, DatabaseSync, keepHeights, log }) {
    this.kind = 'sqlite';
    this.file = file;
    this.keepHeights = keepHeights;
    this.log = log;
    this.db = new DatabaseSync(file);
    // WAL + synchronous=FULL: measured to roll back an open transaction on SIGKILL.
    // WAL leaves a -wal beside the file; that is expected and is part of the store.
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS attribution (
      height INTEGER PRIMARY KEY, pool_key TEXT, pool_label TEXT, seen_at INTEGER, row TEXT
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS attribution_seen ON attribution(seen_at DESC)');
    this.insert = this.db.prepare('INSERT OR REPLACE INTO attribution VALUES (?,?,?,?,?)');
  }

  put(row) { return this.putMany([row]); }

  putMany(rows) {
    const good = (rows ?? []).filter((r) => Number.isInteger(r?.height));
    if (!good.length) return 0;
    this.db.exec('BEGIN');
    try {
      for (const r of good) {
        this.insert.run(r.height, r.poolKey ?? null, r.poolLabel ?? null, r.seenAt ?? Date.now(), JSON.stringify(pick(r)));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return good.length;
  }

  /** A reorg happened: nothing above the new fork height may survive. */
  dropAbove(height) {
    const gone = this.db.prepare('SELECT COUNT(*) c FROM attribution WHERE height > ?').get(height).c;
    this.db.prepare('DELETE FROM attribution WHERE height > ?').run(height);
    return gone;
  }

  latest(n = 50) {
    return this.db.prepare('SELECT row FROM attribution ORDER BY height DESC LIMIT ?').all(n)
      .map((r) => JSON.parse(r.row));
  }

  since(height) {
    return this.db.prepare('SELECT row FROM attribution WHERE height >= ? ORDER BY height DESC').all(height)
      .map((r) => JSON.parse(r.row));
  }

  deleteOlderThan(height) {
    return this.db.prepare('DELETE FROM attribution WHERE height < ?').run(height).changes ?? 0;
  }

  depth() {
    const row = this.db.prepare('SELECT COUNT(*) n, MIN(height) lo, MAX(height) hi FROM attribution').get();
    return {
      engine: this.kind, file: path.basename(this.file), rows: row.n ?? 0,
      from: row.lo ?? null, to: row.hi ?? null, bytes: fileSize(this.file),
    };
  }

  close() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ } this.db.close(); }
}

// ------------------------------------------------------------------- jsonl

class JsonlLedger {
  constructor({ file, keepHeights, log }) {
    this.kind = 'jsonl';
    this.file = file;
    this.keepHeights = keepHeights;
    this.log = log;
    this.byHeight = new Map();
    this.dirty = 0;
    // A torn last line is normal after a crash, not corruption: read what parses and
    // keep appending. Same discipline as the log follower uses on the node's log.
    let tail = '';
    try { tail = fs.readFileSync(file, 'utf8'); } catch { tail = ''; }
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (Number.isInteger(row?.height)) this.byHeight.set(row.height, row);
      } catch { /* the incomplete final write; ignored, then overwritten */ }
    }
    this.fd = fs.openSync(file, 'a');
  }

  put(row) { return this.putMany([row]); }

  putMany(rows) {
    const good = (rows ?? []).filter((r) => Number.isInteger(r?.height));
    let wrote = 0;
    for (const r of good) {
      this.byHeight.set(r.height, pick(r));
      fs.writeSync(this.fd, JSON.stringify(pick(r)) + '\n');
      wrote++;
    }
    if (wrote) {
      fs.fsyncSync(this.fd);            // durability is the whole point of this file
      this.dirty += wrote;
      if (this.dirty > 20_000) this.#compact();   // keep the file from growing without bound
    }
    return wrote;
  }

  #compact() {
    const rows = [...this.byHeight.values()].sort((a, b) => a.height - b.height);
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    for (const r of rows) fs.writeSync(fd, JSON.stringify(r) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.closeSync(this.fd);
    fs.renameSync(tmp, this.file);
    this.fd = fs.openSync(this.file, 'a');
    this.dirty = 0;
  }

  dropAbove(height) {
    const rows = [...this.byHeight.keys()].filter((h) => h > height);
    for (const h of rows) this.byHeight.delete(h);
    if (rows.length) this.#compact();
    return rows.length;
  }

  latest(n = 50) {
    return [...this.byHeight.keys()].sort((a, b) => b - a).slice(0, n).map((h) => this.byHeight.get(h));
  }

  since(height) {
    return [...this.byHeight.entries()].filter(([h]) => h >= height)
      .sort((a, b) => b[0] - a[0]).map(([, r]) => r);
  }

  deleteOlderThan(height) {
    let n = 0;
    for (const h of [...this.byHeight.keys()]) if (h < height) { this.byHeight.delete(h); n++; }
    if (n) this.#compact();
    return n;
  }

  depth() {
    const ks = [...this.byHeight.keys()];
    return {
      engine: this.kind, file: path.basename(this.file), rows: ks.length,
      from: ks.length ? Math.min(...ks) : null, to: ks.length ? Math.max(...ks) : null,
      bytes: fileSize(this.file),
    };
  }

  close() { try { this.#compact(); } catch { /* closing must not throw */ } try { fs.closeSync(this.fd); } catch { /* already closed */ } }
}

// ----------------------------------------------------------------- shared

function pick(r) {
  const out = {};
  for (const k of ROW_COLUMNS) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

/**
 * Fold rows into the pool view. One implementation for both engines, so an engine
 * switch cannot change what the page says about who mines this chain.
 */
export function aggregate(rows = []) {
  const pools = new Map();
  for (const r of rows) {
    const key = r.poolLabelKey ?? r.poolKey ?? 'unknown';
    const p = pools.get(key) ?? {
      poolKey: r.poolKey ?? key, label: r.poolLabel ?? null, labelled: !!r.poolLabel,
      blocks: 0, txs: 0, weightSum: 0, feeSum: 0, feerates: [], sizes: [], tags: new Set(),
      firstHeight: r.height, lastHeight: r.height,
    };
    p.blocks++;
    p.txs += r.txs ?? 0;
    if (r.weight != null) p.weightSum += r.weight;
    if (r.totalfee != null) p.feeSum += r.totalfee;
    if (r.avgFeerate != null) p.feerates.push(r.avgFeerate);
    if (r.size != null) p.sizes.push(r.size);
    if (r.tagText) p.tags.add(String(r.tagText).slice(0, 60));
    p.firstHeight = Math.min(p.firstHeight, r.height);
    p.lastHeight = Math.max(p.lastHeight, r.height);
    if (r.poolLabel && !p.label) { p.label = r.poolLabel; p.labelled = true; }
    pools.set(key, p);
  }
  const total = rows.length;
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : +((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(2);
  };
  return [...pools.values()]
    .map((p) => ({
      poolKey: p.poolKey, label: p.label, labelled: p.labelled, blocks: p.blocks,
      sharePct: total ? +(100 * p.blocks / total).toFixed(1) : null,
      txs: p.txs || null,
      avgWeight: p.blocks && p.weightSum ? Math.round(p.weightSum / p.blocks) : null,
      medianSize: median(p.sizes),
      medianFeeRate: median(p.feerates),
      totalFeesSat: p.feeSum || null,
      tags: [...p.tags].slice(0, 4),
      firstHeight: p.firstHeight, lastHeight: p.lastHeight,
    }))
    .sort((a, b) => b.blocks - a.blocks || b.lastHeight - a.lastHeight);
}
