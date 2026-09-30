// SPDX-License-Identifier: Apache-2.0
//
// poolmirror.js -- the node's mempool kept here, up to date between full reads (operator, 2026-09-30:
// "How do we get more granularity, like mempool does over websocket, pushing changes" -- "go ahead,
// bmc first").
//
// WHY. Everything the pool pictures show -- the viewer's cells, the feerate histogram, the projected
// blocks, the Detailed board, the block being built -- is computed from ONE verbose mempool map
// (getrawmempool true). That map was read whole every 20 s, and measured 2026-09-30 it is no longer
// small: 77,525 transactions, 47 MB of JSON, 0.6-0.67 s of Core's RPC and 142 ms to parse; bmc 35 MB
// in 0.66 s. Reading it every 5 s would be 13% of Core's RPC time on one call. So it is read whole
// rarely (poll.poolResyncMs, 10 min) and kept current in between from what CHANGED:
//
//   zmq   the node's `sequence` notifications (zmq.js): A added, R removed, C a block connected, D one
//         disconnected. A new transaction's entry is fetched with getmempoolentry (200 batched: 5.5 ms,
//         95 KB on Core); a connected block's transactions are dropped by getblock <hash> 1. bmc
//         publishes this topic (pubsequence, 127.0.0.1:28334); Core as configured here does not.
//   poll  getrawmempool false true -- the txids and the mempool's sequence number, 0.08-0.1 s and 5 MB
//         on Core, 0.009 s and 4 MB on bmc -- every tick, diffed against the map; unchanged sequence,
//         nothing to do.
//
// SYNC. A full read gives the entries; `getrawmempool false true` right after gives the ids and the
// sequence S the map is true at. Entries not in the ids are dropped, ids with no entry are fetched, and
// notifications buffered while that ran are applied from S on (the RPC's number is the next one to be
// used: measured on bmc, the last notification seen before the call carried S - 1). After that a lost
// notification is noticed by ZMQ's own per-topic counter, which goes up by one per message, and asks
// for a full read; so does a disconnected block. The mempool's sequence is not checked message to
// message: a block's removals are not published, so it jumps at every block by design.
//
// Pure of timers and sockets: the monitor drives it (load, onSequence, tick). `rpc` is { call, batch }.

export const ADDS_PER_TICK = 4000;

/**
 * The txids and sequence from `getrawmempool false true`. A node that ignores the second argument
 * answers with the plain list: the ids, no sequence. Anything else: { ids: null } -- never an empty
 * list, which would empty the map.
 */
export function idsOf(r) {
  if (Array.isArray(r)) return { ids: r, sequence: null };
  if (r && Array.isArray(r.txids)) { const q = Number(r.mempool_sequence); return { ids: r.txids, sequence: Number.isFinite(q) ? q : null }; }
  return { ids: null, sequence: null };
}      // more new transactions than this in one tick: a full read is cheaper

export class PoolMirror {
  constructor({ rpc, id = 'node', mode = 'poll', priority = 6 } = {}) {
    this.rpc = rpc;
    this.id = id;
    this.mode = mode;                     // 'zmq' | 'poll'
    this.priority = priority;
    this.raw = null;                      // txid -> getrawmempool verbose entry: THE map the pictures are made from
    this.seq = null;                      // the mempool sequence the map is true at (poll mode's "anything new?")
    this.synced = false;
    this.needResync = true;
    this.buffer = [];                     // notifications that arrived before the map was loaded
    this.lastZmqSeq = null;
    this.pendingAdds = new Set();
    this.pendingBlocks = [];
    this.dirty = false;
    this.stats = { adds: 0, removes: 0, blocks: 0, fetched: 0, gone: 0, resyncs: 0, lastReason: null, lastTickMs: 0 };
  }

  /** Something is wrong with the map: the monitor will do a full read. */
  resync(reason) {
    if (!this.needResync) this.stats.lastReason = reason;
    this.needResync = true;
    this.synced = false;
  }

  /** A full read (`raw`, verbose) and the ids+sequence read right after it (`ids`, `sequence`). */
  load(raw, ids, sequence) {
    const map = raw && typeof raw === 'object' ? raw : {};
    if (ids != null && !Array.isArray(ids)) ids = null;
    const keep = new Set(Array.isArray(ids) ? ids : Object.keys(map));
    for (const k of Object.keys(map)) if (!keep.has(k)) delete map[k];
    this.pendingAdds = new Set();
    for (const k of keep) if (!(k in map)) this.pendingAdds.add(k);
    this.raw = map;
    this.seq = Number.isFinite(sequence) ? sequence : null;
    this.synced = true;
    this.needResync = false;
    this.stats.resyncs += 1;
    const buffered = this.buffer;
    this.buffer = [];
    for (const e of buffered) {
      // before the snapshot: already in it (A/R carry the mempool sequence; a C or D has none and is replayed)
      if (e.mempoolSeq != null && this.seq != null && e.mempoolSeq < this.seq) continue;
      this.apply(e);
    }
    this.dirty = true;
  }

  /** One `sequence` notification (zmq.js parseSequence), with ZMQ's per-topic counter. */
  onSequence(e, zmqSeq = null) {
    if (!e) return;
    if (zmqSeq != null && this.lastZmqSeq != null && zmqSeq !== ((this.lastZmqSeq + 1) >>> 0)) {
      const was = this.lastZmqSeq;
      this.lastZmqSeq = zmqSeq;
      this.buffer = [];
      this.resync(`a notification was lost (counter ${zmqSeq} after ${was})`);
      return;
    }
    this.lastZmqSeq = zmqSeq;
    if (!this.synced) {
      if (this.buffer.length < 50_000) this.buffer.push(e);
      else { this.buffer = []; this.resync('too many notifications while loading'); }
      return;
    }
    this.apply(e);
  }

  /** The connection to the notifications dropped: whatever came in meanwhile is unknown. */
  onDisconnected() {
    this.lastZmqSeq = null;
    this.resync('the notification socket closed');
  }

  apply(e) {
    if (e.label === 'A') {
      if (!(e.hash in this.raw)) { this.pendingAdds.add(e.hash); this.stats.adds += 1; }
    } else if (e.label === 'R') {
      this.pendingAdds.delete(e.hash);
      if (e.hash in this.raw) { delete this.raw[e.hash]; this.dirty = true; }
      this.stats.removes += 1;
    } else if (e.label === 'C') {
      this.pendingBlocks.push(e.hash);
    } else if (e.label === 'D') {
      // a block's transactions going back into the pool: a full read is the honest answer
      this.resync('a block was disconnected');
    }
  }

  /** Bring the map up to date. Returns { changed }. Throws what the RPC throws. */
  async tick() {
    const t0 = Date.now();
    if (!this.synced || this.needResync) return { changed: false, resync: true };
    if (this.mode === 'poll') await this.pollIds();
    // a connected block: its transactions are no longer in the pool, published or not
    while (this.pendingBlocks.length) {
      const hash = this.pendingBlocks.shift();
      const blk = await this.rpc.call('getblock', [hash, 1], { key: `${this.id}:mirror-block`, priority: this.priority });
      for (const txid of blk?.tx ?? []) {
        this.pendingAdds.delete(txid);
        if (txid in this.raw) { delete this.raw[txid]; this.dirty = true; }
      }
      this.stats.blocks += 1;
    }
    if (this.pendingAdds.size > ADDS_PER_TICK) {
      this.resync(`${this.pendingAdds.size} new transactions at once`);
      return { changed: false, resync: true };
    }
    if (this.pendingAdds.size) {
      const want = [...this.pendingAdds];
      const replies = await this.rpc.batch(want.map((txid) => ({ method: 'getmempoolentry', params: [txid] })), { key: `${this.id}:mirror-adds`, priority: this.priority });
      replies.forEach((r, i) => {
        const txid = want[i];
        if (!this.pendingAdds.has(txid)) return;      // removed while the batch was out
        this.pendingAdds.delete(txid);
        if (r?.ok && r.result && typeof r.result === 'object') { this.raw[txid] = r.result; this.dirty = true; this.stats.fetched += 1; }
        else this.stats.gone += 1;                    // left the pool before we asked: nothing to add
      });
    }
    this.stats.lastTickMs = Date.now() - t0;
    const changed = this.dirty;
    this.dirty = false;
    return { changed };
  }

  async pollIds() {
    const r = await this.rpc.call('getrawmempool', [false, true], { key: `${this.id}:mirror-ids`, priority: this.priority });
    const { ids, sequence: seq } = idsOf(r);
    if (!ids) { this.resync('getrawmempool false true answered with neither txids nor a list'); return; }
    if (Number.isFinite(seq) && seq === this.seq) return;
    const now = new Set(ids);
    for (const k of Object.keys(this.raw)) if (!now.has(k)) { delete this.raw[k]; this.dirty = true; this.stats.removes += 1; }
    for (const k of ids) if (!(k in this.raw) && !this.pendingAdds.has(k)) { this.pendingAdds.add(k); this.stats.adds += 1; }
    this.seq = Number.isFinite(seq) ? seq : null;
  }

  view() {
    return {
      mode: this.mode, synced: this.synced,
      pending: this.pendingAdds.size, ...this.stats,
    };
  }
}
