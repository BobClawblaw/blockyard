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
import crypto from 'node:crypto';
import { appendJsonl, fchmodOwnerOnly } from './history.js';

// HASH-CHAINED, SO EDITING ONE ENTRY BREAKS EVERY ONE AFTER IT (audit 2026-09-22, L5). Before this,
// audit.jsonl was plain newline-delimited JSON with filesystem permissions (0600) as its only
// protection -- nothing detected an entry edited or removed in place. Each row now carries `hash`,
// sha256 of the PREVIOUS row's hash plus this row's own canonical content; verifyChain() walks the
// file recomputing that and reports the first row that does not match.
//
// WHAT THIS DOES AND DOES NOT PROVE, STATED PLAINLY (never fabricate a guarantee, the same rule
// this file's own header follows for the log itself): there is no secret key, because a key stored
// on the same machine an attacker with data/ write access already reaches proves nothing extra --
// they could read it too. So this is tamper-EVIDENT, not tamper-PROOF: it detects a partial edit
// (one line changed or removed without regenerating everything after it, which is the realistic
// shape of accidental corruption, a bug elsewhere writing where it should not, or a lazy tamper
// attempt), and it does NOT stop someone with full read/write access to data/ from regenerating a
// self-consistent chain from scratch. That residual gap is inherent to any tamper-evidence scheme
// with no independent, externally-stored checkpoint -- closing it needs one (an operator copying a
// chain tip hash off-box periodically, or a remote log sink), which is a deployment choice, not
// something this file can manufacture on its own.
const GENESIS_HASH = '0'.repeat(64);
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
function chainHash(prevHash, row) {
  return crypto.createHash('sha256').update(prevHash).update(canonicalJson(row)).digest('hex');
}

export class AuditLog {
  constructor(file, { maxBytes = 8 * 1024 * 1024, keep = 5, log = () => {} } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = Math.max(1, keep | 0);
    this.log = log;
    this.rotations = 0;
    this.bytes = 0;
    this.droppedLines = 0;
    this.lastHash = GENESIS_HASH;
  }

  /** audit.jsonl, audit.1.jsonl, … newest first. */
  chain() {
    const out = [this.file];
    for (let i = 1; i <= this.keep; i++) out.push(rotated(this.file, i));
    return out;
  }

  async append(row) {
    const chained = { ...row, hash: chainHash(this.lastHash, row) };
    const line = JSON.stringify(chained);
    // The cheap in-memory counter decides *whether to look*; the on-disk size decides
    // whether to rotate. A counter alone drifts (an entry written by another process,
    // a hand-edited file after an incident) and a budget that drifts is a rumour.
    const grown = this.bytes + Buffer.byteLength(line) + 1;
    if (grown >= this.maxBytes) {
      const onDisk = await this.currentSize();
      this.bytes = Math.max(this.bytes, onDisk);
      if (onDisk >= this.maxBytes) await this.rotate();
    }
    await appendJsonl(this.file, chained);
    this.bytes += Buffer.byteLength(line) + 1;
    this.lastHash = chained.hash;
    return chained;
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
    // THE CHAIN CONTINUES ACROSS A RESTART, RATHER THAN RESTARTING ITSELF (audit 2026-09-22, L5): a
    // fresh process has no in-memory `lastHash`, and starting over from GENESIS_HASH on every boot
    // would make every restart look, to verifyChain(), exactly like the file had been replaced --
    // indistinguishable from real tampering. So the last entry actually on disk (there may be none
    // yet) supplies the hash the next append chains from.
    for (const f of this.chain()) {
      const last = await lastLine(f);
      if (last) { try { this.lastHash = JSON.parse(last).hash ?? GENESIS_HASH; } catch { /* corrupt tail: leave lastHash at genesis, verifyChain will say why */ } break; }
    }
    try {
      this.bytes = (await fsp.stat(this.file)).size;
      return { adopted: this.bytes };
    } catch { return { adopted: 0 }; }
  }

  /**
   * Walk the retained chain OLDEST TO NEWEST, recomputing each row's hash from the one before it.
   * Returns { ok: true, checked } or { ok: false, checked, brokenAt: { file, line, reason } } naming
   * the first row that does not match -- everything before it chains cleanly, everything from it
   * onward is now unverifiable against what came before (which is exactly what "the file was
   * edited here" means). The oldest row anywhere in the retained chain has nothing before it to
   * check against and is trusted as the starting point -- see the header note on what this can and
   * cannot prove.
   */
  async verifyChain() {
    let prev = null, checked = 0;
    for (const file of [...this.chain()].reverse()) {
      let raw;
      try { raw = await fsp.readFile(file, 'utf8'); } catch { continue; }
      const lines = raw.split('\n').filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        let row;
        try { row = JSON.parse(lines[i]); } catch { return { ok: false, checked, brokenAt: { file: path.basename(file), line: i + 1, reason: 'not valid JSON' } }; }
        const { hash, ...rest } = row;
        // A ROW FROM BEFORE THIS EXISTED HAS NO `hash` AT ALL, and every install that upgrades
        // into this has some: nothing to check it against, and nothing after it was chained from
        // it either. Treated as a fresh start, exactly as adopt() falls back to GENESIS_HASH when
        // the last entry actually on disk predates chaining -- so the first entry appended after
        // an upgrade verifies against GENESIS_HASH here too, matching how it was really computed.
        if (hash === undefined) { prev = GENESIS_HASH; checked++; continue; }
        if (prev !== null) {
          const want = chainHash(prev, rest);
          if (hash !== want) return { ok: false, checked, brokenAt: { file: path.basename(file), line: i + 1, reason: 'hash does not match the entry before it' } };
        }
        prev = hash;
        checked++;
      }
    }
    return { ok: true, checked };
  }
}

/** The last non-empty line of a file, or null. Reads the whole file -- audit files are bounded by maxBytes. */
async function lastLine(file) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

function rotated(file, i) {
  const dir = path.dirname(file);
  const base = path.basename(file, '.jsonl');
  return path.join(dir, `${base}.${i}.jsonl`);
}

function fmtBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(0)} MB` : `${Math.round(n / 1024)} KB`;
}

