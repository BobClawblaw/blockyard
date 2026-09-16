// Named time series + crash-safe persistence.
//
// Snapshots are written tmp+fsync+rename, i.e. a reader sees the old file or the
// new one and never a half-written one. That is the same discipline the node's
// own writers use (its docs repeat the rule: "header written last, so a crash
// leaves a file that reads as absent rather than a partial one that looks
// whole"), and it is the only sane answer when the process can be SIGKILLed
// mid-flush by a system OOM killer this box has actually triggered before.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { Ring } from './ring.js';

// The single schema both the collectors and the HTTP layer use. Field names here
// are what the browser receives; adding a field means adding it here first.
export const SERIES = {
  node: ['t', 'blocks', 'headers', 'progress', 'difficulty', 'sizeOnDisk', 'ibd', 'connections',
    'peersIn', 'peersOut', 'uptimeMs', 'txRate', 'chainTxCount', 'txouts', 'totalAmount', 'muhash'],
  mempool: ['t', 'count', 'bytes', 'usage', 'maxUsage', 'totalFee', 'minFee', 'minRelayFee', 'unbroadcast',
    'ingestRate', 'acceptedDelta', 'rejectMissing', 'rejectPolicy', 'rejectInvalid', 'confirmedDrain',
    'pendingAncestors', 'replaceable', 'avgFee', 'avgVsize'],
  net: ['t', 'inBps', 'outBps', 'diskWriteBps', 'inTotal', 'outTotal', 'diskTotal', 'avgRecvBps', 'avgWriteBps',
    'floorBps', 'poolMedianBps'],
  fees: ['t', 'f1', 'f2', 'f6', 'f24', 'f144', 'mempoolmin', 'priority', 'estimatorOk'],
  peers: ['t', 'connections', 'in', 'out', 'relayPeers', 'servedBlocks', 'txRelayPeers', 'wanted', 'banned',
    'rankingLive', 'rankingAnswered', 'rankingMedianKbps'],
  blocks: ['t', 'height', 'time', 'mediantime', 'totalfee', 'txs', 'size', 'weight', 'medianTxSize', 'avgTxSize', 'swtotalSize', 'swtxs', 'avgFeerate', 'subsidy',
    'utxoIncrease', 'ins', 'outs', 'avgfee', 'medianfee', 'maxfee', 'p0', 'p1', 'p2', 'p3', 'p4', 'gapSec', 'viaPeer', 'source'],
  txflow: ['t', 'accepted', 'relayAccepted', 'rejectMissing', 'rejectPolicy', 'rejectInvalid', 'alreadyConfirmed',
    'orphansHeld', 'orphansParked', 'orphansResolved', 'orphansDropped', 'inFlight', 'oneP1C', 'oneP1CFailed', 'windowSec'],
  rpc: ['t', 'latencyMs', 'avgLatencyMs', 'ratePerSec', 'queued', 'errors', 'breakerTrips', 'busyMsPerSec'],
  self: ['t', 'rssMb', 'heapMb', 'sseClients', 'usersActive', 'cpuPct', 'eventRate'],
};

export class History {
  constructor(dir, cfg, { log = () => {} } = {}) {
    this.dir = dir;
    this.cfg = cfg;
    this.log = log;
    this.rings = new Map();
    for (const [name] of Object.entries(SERIES)) this.rings.set(name, new Ring(cfg.ringCapacity));
    this.events = []; // newest first, capped
    this.eventsSeq = 0;
    this.file = path.join(dir, 'history.json');
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.saving = false;
    this.lastSavedAt = null;
    this.lastSaveError = null;
    this.dirtySince = 0;
  }

  ring(name) {
    if (!this.rings.has(name)) throw new Error(`unknown series ${name}`);
    return this.rings.get(name);
  }

  // A node-scoped view of the same store. Series rings are shared by every
  // configured node, so writes are stamped and reads are filtered; without this,
  // a two-node deployment draws one line that averages two daemons (measured:
  // 2,308 production rows against 1,816 bench rows in the `peers` ring).
  //
  // Deliberately still ONE ring per series rather than one per node: capacity and
  // retention are configured per series and shared, and per-node rings would double
  // the memory of every added node while making a removed node's history unreachable.
  // If capacity ever becomes the constraint, say so here rather than discovering it
  // in a chart that quietly stopped reaching back 24 h.
  forNode(nodeId) {
    if (!nodeId) throw new Error('forNode needs a node id');
    const history = this;
    return {
      __perNode: true,
      node: nodeId,
      ring(name) {
        const ring = history.ring(name);
        return {
          node: nodeId,
          get length() { return ring.length; },
          first: () => ring.first(),
          last: (opts = {}) => ring.tail(50).filter((r) => r.node === nodeId).pop() ?? null,
          since: (t, o = {}) => ring.since(t).filter((r) => (o.node === undefined ? r.node === nodeId : o.node === r.node)),
          tail: (n, o = {}) => ring.tail(n * 4).filter((r) => (o.node === undefined ? r.node === nodeId : o.node === r.node)).slice(-n),
          series: (field, opts = {}) => ring.series(field, { ...opts, node: opts.node ?? nodeId }),
          stats: (field, opts = {}) => ring.stats(field, { ...opts, node: opts.node ?? nodeId }),
          raw: ring,
        };
      },
      record(name, row) { return history.record(name, { ...row, node: nodeId }); },
      addEvent(ev) { return history.addEvent({ ...ev, node: nodeId }); },
      addEvents(evs) { return evs.map((e) => this.addEvent(e)); },
      eventsSinceSeq: (seq, limit) => history.eventsSinceSeq(seq, limit),
      forNode: () => history.forNode(nodeId),
    };
  }

  record(name, row) {
    const ring = this.ring(name);
    ring.push({ t: row.t ?? Date.now(), ...row });
    this.dirtySince ||= Date.now();
    return ring.last();
  }

  addEvent(ev) {
    this.eventsSeq += 1;
    const row = { seq: this.eventsSeq, ...ev };
    this.events.unshift(row);
    if (this.events.length > this.cfg.maxEventLog) this.events.length = this.cfg.maxEventLog;
    this.dirtySince ||= Date.now();
    return row;
  }

  addEvents(evs) { return evs.map((e) => this.addEvent(e)); }

  // Newest-first events with a sequence above `seq` (this.events is maintained
  // newest-first, so a plain filter already yields the right order).
  eventsSinceSeq(seq, limit = 500) {
    return this.events.filter((e) => e.seq > seq).slice(0, limit);
  }

  prune() {
    const cutoff = Date.now() - this.cfg.retentionHours * 3600 * 1000;
    for (const ring of this.rings.values()) ring.pruneBefore(cutoff);
  }

  summary() {
    const out = {};
    for (const [name, ring] of this.rings) {
      out[name] = {
        points: ring.length,
        firstAt: ring.first()?.t ?? null,
        lastAt: ring.last()?.t ?? null,
        // Rows written before per-node tagging, and which nodes are represented.
        // Stated because a node-filtered chart legitimately cannot draw them, and
        // silence about that would look like missing history.
        unattributed: ring.unattributed(),
        nodes: ring.nodes(),
      };
    }
    return out;
  }

  async save() {
    if (this.saving) return { skipped: true };
    this.saving = true;
    try {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const payload = {
        version: 1,
        savedAt: Date.now(),
        retentionHours: this.cfg.retentionHours,
        rings: Object.fromEntries([...this.rings].map(([k, r]) => [k, r.toJSON()])),
        events: this.events.slice(0, this.cfg.maxEventLog),
        eventsSeq: this.eventsSeq,
      };
      const tmp = `${this.file}.tmp`;
      // node-derived detail: owner-only, like users and sessions. The temporary name is unlinked and
      // created with O_EXCL, so a symlink planted there is never followed (audit 2026-09-16, L10)
      await fsp.unlink(tmp).catch((err) => { if (err.code !== 'ENOENT') throw err; });
      const fh = await fsp.open(tmp, 'wx', 0o600);
      await fh.writeFile(JSON.stringify(payload));
      await fh.sync();
      await fh.close();
      await fsp.rename(tmp, this.file);
      this.lastSavedAt = Date.now();
      this.lastSaveError = null;
      this.dirtySince = 0;
      return { saved: true, bytes: JSON.stringify(payload).length };
    } catch (err) {
      this.lastSaveError = { at: Date.now(), message: err.message };
      this.log({ level: 'error', msg: `history snapshot failed: ${err.message}` });
      return { saved: false, error: err.message };
    } finally {
      this.saving = false;
    }
  }

  async load() {
    await fchmodOwnerOnly(this.file);   // a snapshot written before the mode was passed (audit 2026-09-16, L10)
    let raw;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch {
      return { loaded: false, reason: 'no snapshot yet' };
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      // A corrupt snapshot is not a reason to refuse to start; it is a reason to
      // say so and fall back to an empty history.
      this.log({ level: 'warn', msg: `history snapshot unparseable (${err.message}); starting empty` });
      return { loaded: false, reason: `unparseable: ${err.message}` };
    }
    const cutoff = Date.now() - this.cfg.retentionHours * 3600 * 1000;
    for (const name of Object.keys(SERIES)) {
      const r = Ring.fromJSON(data.rings?.[name], this.cfg.ringCapacity);
      r.pruneBefore(cutoff);
      this.rings.set(name, r);
    }
    this.events = (data.events ?? []).filter((e) => e.ts >= cutoff).slice(0, this.cfg.maxEventLog);
    this.eventsSeq = Math.max(data.eventsSeq ?? 0, this.events[0]?.seq ?? 0);
    return { loaded: true, points: [...this.rings.values()].reduce((a, r) => a + r.length, 0), savedAt: data.savedAt ?? null };
  }

  startAutosave() {
    this.timer = setInterval(() => {
      if (!this.dirtySince) return;
      if (Date.now() - this.dirtySince < this.cfg.snapshotEveryMs) return;
      this.prune();
      this.save().catch(() => {});
    }, Math.min(60_000, this.cfg.snapshotEveryMs));
    this.timer.unref?.();
    return this;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.dirtySince) await this.save();
  }
}

// Atomic append-only text sink, used by the audit log.
export async function appendJsonl(file, row) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.appendFile(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });   // who did what: owner-only (audit 2026-09-14, L4)
}

// An existing file made owner-only through its own descriptor (audit 2026-09-16, L10). O_NOFOLLOW
// where the platform has it, so a symlink's target is never re-moded; a missing file, or a platform
// that keeps no modes (Windows), is not an error.
export async function fchmodOwnerOnly(file) {
  let fh;
  try {
    fh = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    await fh.chmod(0o600);
  } catch { /* absent, a symlink, or modes not kept here */ } finally { await fh?.close().catch(() => {}); }
}
