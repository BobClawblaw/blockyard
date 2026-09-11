// Log follower for the node's log.
//
// Correctness concerns, all of them real on this box (logrotate rotates
// bitcoin.main.log to .1 and gzips older ones):
//   - rotation: the file we hold moves to .1 and a NEW file appears at the same
//     name. Reading the new file from byte 0 while the old inode still has
//     unread lines would lose them; following the old inode forever would stall
//     at EOF. So: drain the old inode to EOF, then switch.
//   - truncation: size < position means the file was cut in place. Restart at 0.
//   - a partial last line must be carried to the next read, not parsed and lost.
//   - polling is the primary mechanism (an append-heavy log makes fs.watch
//     unreliable); the watcher is only a nudge to reduce latency.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { splitLines } from './logparse.js';

export class LogTail extends EventEmitter {
  constructor(file, { pollMs = 1000, tailBytes = 2 * 1024 * 1024, maxBytes = 256 * 1024, log = () => {} } = {}) {
    super();
    this.file = file;
    this.pollMs = pollMs;
    this.tailBytes = tailBytes;
    this.maxBytes = maxBytes;
    this.log = log;
    this.fd = null;
    this.ino = null;
    this.pos = 0;
    this.carry = { carry: '' };
    this.timer = null;
    this.watcher = null;
    this.stopped = false;
    this.busy = false;
    this.state = {
      file, exists: false, inode: null, size: 0, pos: 0, lagBytes: 0,
      openedAt: null, lastReadAt: null, lines: 0, events: 0, rotations: 0, truncations: 0,
      readErrors: 0, backfilled: false,
    };
  }

  async start() {
    await this._openInitial();
    this._watch();
    const tick = () => {
      if (this.stopped) return;
      this._read().catch((err) => {
        this.state.readErrors += 1;
        this.log({ level: 'warn', msg: `log tail read failed: ${err.message}` });
      }).finally(() => { if (!this.stopped) this.timer = setTimeout(tick, this.pollMs); });
    };
    this.timer = setTimeout(tick, this.pollMs);
    return this;
  }

  async _openInitial() {
    let st;
    try {
      st = await fsp.stat(this.file);
    } catch {
      this.state.exists = false;
      return; // may appear later; the poll loop retries
    }
    this.state.exists = true;
    try {
      this.fd = await fsp.open(this.file, 'r');
    } catch (err) {
      this.log({ level: 'warn', msg: `cannot open ${this.file}: ${err.message}` });
      return;
    }
    const s = await this.fd.stat();
    this.ino = s.ino;
    this.state.inode = s.ino;
    // Backfill the tail, starting on a line boundary so the first parsed line is
    // not a fragment of a stack trace.
    this.pos = s.size > this.tailBytes ? await this._firstLineOffset(s.size - this.tailBytes) : 0;
    this.state.openedAt = Date.now();
    this.state.backfilled = false;
  }

  async _firstLineOffset(from) {
    if (from <= 0) return 0;
    const buf = Buffer.alloc(8192);
    try {
      const { bytesRead } = await this.fd.read(buf, 0, buf.length, from);
      const nl = buf.indexOf(0x0a, 0, bytesRead);
      return nl >= 0 ? from + nl + 1 : from;
    } catch {
      return from;
    }
  }

  _watch() {
    try {
      this.watcher = fs.watch(path.dirname(this.file), (evt, name) => {
        if (!name || path.join(path.dirname(this.file), name) === this.file) this._read().catch(() => {});
      });
      this.watcher.on('error', () => { try { this.watcher.close(); } catch { /* already gone */ } });
    } catch {
      // Directory not watchable (network mount, permissions). Polling still works.
    }
  }

  async _read() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (this.fd == null) { await this._openInitial(); if (this.fd == null) return; }

      let s = await this.fd.stat();

      if (s.size < this.pos) { // truncated in place
        this.state.truncations += 1;
        this.pos = 0;
        this.carry.carry = '';
      }
      if (s.size > this.pos) await this._drain();

      // Rotation: has the name moved on to a different inode?
      let nameStat = null;
      try { nameStat = await fsp.stat(this.file); } catch { nameStat = null; }
      if (nameStat && nameStat.ino !== this.ino) {
        await this._drain(); // whatever is left of the old inode first
        await this.fd.close().catch(() => {});
        this.fd = null;
        this.state.rotations += 1;
        this.carry.carry = '';
        try {
          this.fd = await fsp.open(this.file, 'r');
          const ns = await this.fd.stat();
          this.ino = ns.ino;
          this.pos = 0;
          this.state.inode = ns.ino;
          this.state.size = ns.size;
          this.state.exists = true;
        } catch {
          this.ino = null;
          this.state.exists = false;
        }
      } else if (!nameStat && !this.state.exists) {
        this.state.exists = false;
      } else if (nameStat) {
        this.state.exists = true;
        this.state.size = nameStat.size;
      }

      this.state.pos = this.pos;
      this.state.size = s.size;
      this.state.lagBytes = Math.max(0, s.size - this.pos);
      this.state.lastReadAt = Date.now();
      if (!this.state.backfilled) {
        this.state.backfilled = true;
        this.emit('backfilled', this.state);
      }
    } finally {
      this.busy = false;
    }
  }

  async _drain() {
    for (;;) {
      const s = await this.fd.stat();
      if (s.size <= this.pos) return;
      const len = Math.min(this.maxBytes, s.size - this.pos);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await this.fd.read(buf, 0, len, this.pos);
      if (bytesRead <= 0) return;
      this.pos += bytesRead;
      this.state.lines += bytesRead;
      const events = splitLines(buf.toString('utf8', 0, bytesRead), this.carry);
      if (events.length) {
        this.state.events += events.length;
        this.emit('events', events);
      }
      if (bytesRead < len) return;
    }
  }

  status() {
    return { ...this.state, lagBytes: this.state.lagBytes };
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    if (this.fd) { await this.fd.close().catch(() => {}); this.fd = null; }
  }
}
