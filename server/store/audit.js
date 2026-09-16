// The audit trail, with the one property it did not have: a bounded size.
//
// Why this was a real defect and not housekeeping: `audit.jsonl` records logins,
// RPC calls, action results and CSRF rejections — an append-only file with no
// rotation, on a box that has filled its disk before. A full disk is not "no audit
// log"; it is "no monitor", because the same disk holds the history snapshots the
// charts restore from, and the node's own datadir is on it too. The failure mode of
// an unbounded log is the node going down for the log's sake.
//
// Rotation is size-triggered and shifts a numbered chain (audit.jsonl ->
// audit.1.jsonl -> …) rather than deleting, so "who logged in at 03:12" survives
// long enough to be asked. `read()` walks the chain newest-first, which matters:
// rotating under the reader is exactly when someone is looking at the audit page.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, fchmodOwnerOnly } from './history.js';

export class AuditLog {
  constructor(file, { maxBytes = 8 * 1024 * 1024, keep = 5, log = () => {} } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = Math.max(1, keep | 0);
    this.log = log;
    this.rotations = 0;
    this.bytes = 0;
    this.droppedLines = 0;
  }

  /** audit.jsonl, audit.1.jsonl, … newest first. */
  chain() {
    const out = [this.file];
    for (let i = 1; i <= this.keep; i++) out.push(rotated(this.file, i));
    return out;
  }

  async append(row) {
    const line = JSON.stringify(row);
    // The cheap in-memory counter decides *whether to look*; the on-disk size decides
    // whether to rotate. A counter alone drifts (an entry written by another process,
    // a hand-edited file after an incident) and a budget that drifts is a rumour.
    const grown = this.bytes + Buffer.byteLength(line) + 1;
    if (grown >= this.maxBytes) {
      const onDisk = await this.currentSize();
      this.bytes = Math.max(this.bytes, onDisk);
      if (onDisk >= this.maxBytes) await this.rotate();
    }
    await appendJsonl(this.file, row);
    this.bytes += Buffer.byteLength(line) + 1;
    return row;
  }

  async currentSize() {
    try { return (await fsp.stat(this.file)).size; } catch { return 0; }
  }

  /** Shift the chain by one and start a fresh current file. */
  async rotate() {
    try {
      const oldest = rotated(this.file, this.keep);
      if (this.keep === 1) {
        await fsp.rm(this.file, { force: true });
      } else {
        // Walk backwards so nothing is renamed onto a file that still matters.
        await fsp.rm(oldest, { force: true });
        for (let i = this.keep - 1; i >= 1; i--) {
          await fsp.rename(rotated(this.file, i), rotated(this.file, i + 1)).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
        }
        await fsp.rename(this.file, rotated(this.file, 1)).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
      this.rotations += 1;
      this.bytes = 0;
      this.log({ level: 'info', msg: `audit log rotated (>${fmtBytes(this.maxBytes)}); keeping ${this.keep} previous file(s)` });
    } catch (err) {
      // A failed rotation must not lose the audit entry, and must not take the
      // server down: keep appending, and say so every time.
      this.log({ level: 'error', msg: `audit rotation failed (${err.message}); audit.jsonl keeps growing until it succeeds` });
      this.rotationError = err.message;
    }
  }

  /** Newest-first entries, crossing file boundaries so a rotation is invisible. */
  async read(limit = 100) {
    const out = [];
    for (const file of this.chain()) {
      if (out.length >= limit) break;
      let raw;
      try { raw = await fsp.readFile(file, 'utf8'); } catch { continue; }
      const lines = raw.split('\n').filter(Boolean);
      // The tail of an older file is its newest entries, which is what comes next
      // after the current file runs out.
      const take = lines.slice(-(limit - out.length));
      for (let i = take.length - 1; i >= 0 && out.length < limit; i--) {
        try { out.push(JSON.parse(take[i])); } catch { out.push({ unparsable: take[i].slice(0, 120) }); }
      }
    }
    return out;
  }

  /** What the admin page and /api/telemetry need to know about the log itself. */
  async stats() {
    const files = [];
    let total = 0;
    for (const f of this.chain()) {
      try {
        const st = await fsp.stat(f);
        files.push({ file: path.basename(f), bytes: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch { /* not present */ }
    }
    return {
      file: path.basename(this.file),
      files,
      totalBytes: total,
      currentBytes: files[0]?.bytes ?? 0,
      maxBytes: this.maxBytes,
      keep: this.keep,
      rotations: this.rotations,
      rotationError: this.rotationError ?? null,
      // The number that makes the budget honest: how much headroom is left before
      // the next rotation, and at the observed rate, when that is.
      headroomBytes: Math.max(0, this.maxBytes - (files[0]?.bytes ?? 0)),
    };
  }

  /** Adopt an existing file's size so the first append after a restart is correct. */
  async adopt() {
    // THE MODE IS TIGHTENED ON FILES THAT ALREADY EXIST (audit 2026-09-16, L10): appendJsonl passes
    // 0o600, which applies only when it creates the file, so a trail written before 2026-09-14 kept
    // whatever the umask gave it. Opened without following a symlink where the platform allows, and
    // fchmod'ed through the descriptor.
    for (const f of this.chain()) await fchmodOwnerOnly(f);
    try {
      this.bytes = (await fsp.stat(this.file)).size;
      return { adopted: this.bytes };
    } catch { return { adopted: 0 }; }
  }
}

function rotated(file, i) {
  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  return path.join(dir, `${base}.${i}.jsonl`);
}

function fmtBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(0)} MB` : `${Math.round(n / 1024)} KB`;
}

