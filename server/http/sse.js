// Server-Sent Events hub.
//
// SSE over plain HTTP rather than WebSockets because Node's stdlib has no WS
// server and one-way node->browser updates do not need a second protocol, a
// handshake, or a dependency. It also survives the proxy/LAN setups that break
// upgrades, and reconnects itself in the browser via EventSource.
//
// Backpressure matters here: a snapshot with chart series is 20-150 KB, and a
// laptop on Wi-Fi with a throttled tab will eventually stop draining. So writes
// are coalesced per client -- at most one snapshot in flight, latest wins -- and
// the event feed is batched. A client that cannot keep up sees a coarser stream,
// never an unbounded queue that takes the process down.
//
// THAT LAST SENTENCE WAS NOT TRUE UNTIL 2026-09-16 (audit H1). Coalescing only helps if nothing is
// written while the socket is full, and flush() wrote every pending frame regardless: `write()`
// noted `backpressured` and nothing ever read it. The reaper removed a client only if it had been
// sent zero bytes, which no client ever has. So a reader that stopped reading kept every snapshot
// queued in Node's socket buffer: 400 stalled connections took a test instance from 73 MB to 1.5 GB
// in three minutes. Now a backpressured client is sent nothing (its pending snapshot keeps being
// replaced, latest wins) until the socket drains; one whose buffer passes a ceiling, or that stays
// blocked past a deadline, is dropped; and one address holds a bounded number of streams.
export const SSE_LIMITS = Object.freeze({
  maxBufferedBytes: 4 * 1024 * 1024,   // well above one snapshot; a client this far behind is not reading
  maxBlockedMs: 60_000,                // blocked for a minute: an EventSource reconnects on its own
  maxPerKey: 16,                       // streams per address (open mode) or per account
});
class Client {
  constructor(res, user, id) {
    this.res = res;
    this.user = user;
    this.id = id;
    this.pendingSnapshot = null; // latest wins
    this.pendingSeries = null;
    this.eventBatch = [];
    this.writing = false;
    this.dropped = { snapshot: 0, series: 0, events: 0 };
    this.bytes = 0;
    this.connectedAt = Date.now();
    this.alive = true;
    this.lastWriteAt = Date.now();
    this.nodeId = null;
    this.key = null;
    this.backpressured = false;
    this.blockedSince = 0;
  }

  get dead() { return !this.alive || this.res.writableEnded || this.res.destroyed; }
}

export class StreamHub {
  constructor({ log = () => {}, limits = {} } = {}) {
    this.limits = { ...SSE_LIMITS, ...limits };
    this.clients = new Set();
    this.log = log;
    this.seq = 0;
    this.heartbeatMs = 15000;
    this.timer = null;
  }

  /** How many open streams share this key (an address in open mode, an account otherwise). */
  countFor(key) {
    let n = 0;
    for (const c of this.clients) if (c.key === key && !c.dead) n += 1;
    return n;
  }

  add(req, res, { user = null, nodeId = null, key = null, headers = {} } = {}) {
    const id = ++this.seq;
    const client = new Client(res, user, id);
    client.nodeId = nodeId;
    client.key = key;
    // SECURITY HEADERS ON EVERY RESPONSE, SSE INCLUDED (audit 2026-09-22, M4). This was the one
    // response class the app's CSP/X-Frame-Options/nosniff/Referrer-Policy/Permissions-Policy
    // policy did not reach -- HTML, JSON, error pages and the games route all carry it, this
    // route only carried its own stream headers. `headers` is server.js's own securityHeaders()
    // result, so it is the exact same policy, not a second copy that can drift from the first.
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: do not buffer this into oblivion
    });
    res.write(': stream open\n\n');
    this.clients.add(client);
    const close = () => this.remove(client);
    req.on('close', close);
    req.on('aborted', close);
    res.on('error', close);
    res.on('drain', () => {
      client.backpressured = false;
      client.blockedSince = 0;
      this.flush();
    });
    if (!this.timer) this.startHeartbeat();
    return client;
  }

  remove(client) {
    client.alive = false;
    this.clients.delete(client);
    if (!this.clients.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    try { client.res.end(); } catch { /* already gone */ }
  }

  startHeartbeat() {
    const tick = () => {
      for (const c of [...this.clients]) {
        if (c.dead) { this.remove(c); continue; }
        if (this.stalled(c)) continue;
        // A comment frame keeps intermediaries from reaping an idle stream and
        // lets us notice a dead socket on our own terms. Never onto a full socket.
        if (!c.backpressured) this.write(c, ': ping\n\n');
      }
    };
    this.timer = setInterval(tick, this.heartbeatMs);
    this.timer.unref?.();
  }

  /** Drop a client that is too far behind, or blocked too long; true if it was dropped. */
  stalled(client) {
    const buffered = client.res.writableLength ?? 0;
    const blockedFor = client.backpressured && client.blockedSince ? Date.now() - client.blockedSince : 0;
    if (buffered <= this.limits.maxBufferedBytes && blockedFor <= this.limits.maxBlockedMs) return false;
    this.log({ level: 'warn', msg: `sse #${client.id} dropped: not reading (${Math.round(buffered / 1024)} KB buffered, blocked ${Math.round(blockedFor / 1000)}s)` });
    this.remove(client);
    try { client.res.destroy(); } catch { /* already gone */ }
    return true;
  }

  write(client, frame) {
    if (client.dead) return false;
    try {
      const ok = client.res.write(frame);
      client.bytes += frame.length;
      client.lastWriteAt = Date.now();
      if (!ok && !client.backpressured) { client.backpressured = true; client.blockedSince = Date.now(); }
      if (!ok) this.stalled(client);
      return ok;
    } catch (err) {
      this.log({ level: 'debug', msg: `sse write failed: ${err.message}` });
      this.remove(client);
      return false;
    }
  }

  // Latest-snapshot-wins: the newest state is always the most useful one, so an
  // in-flight backlog is discarded rather than replayed.
  pushSnapshot(state, { nodeId } = {}) {
    for (const c of this.clients) {
      if (c.dead || (nodeId && c.nodeId && c.nodeId !== nodeId)) continue;
      if (c.pendingSnapshot !== null) c.dropped.snapshot += 1;
      c.pendingSnapshot = state;
    }
    this.flush();
  }

  pushSeries(series, { nodeId } = {}) {
    for (const c of this.clients) {
      if (c.dead || (nodeId && c.nodeId !== nodeId)) continue;
      if (c.pendingSeries !== null) c.dropped.series += 1;
      c.pendingSeries = series;
    }
    this.flush();
  }

  pushEvent(row, { nodeId } = {}) {
    for (const c of this.clients) {
      if (c.dead || (nodeId && c.nodeId !== nodeId)) continue;
      if (c.eventBatch.length > 800) { c.eventBatch.splice(0, 400); c.dropped.events += 1; }
      c.eventBatch.push(row);
    }
    this.flush();
  }

  send(client, event, data, id = null) {
    const parts = [];
    if (id != null) parts.push(`id: ${id}`);
    parts.push(`event: ${event}`);
    parts.push(`data: ${JSON.stringify(data)}`);
    parts.push('');
    parts.push('');
    return this.write(client, parts.join('\n'));
  }

  flush() {
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      for (const c of [...this.clients]) {
        if (c.dead) { this.remove(c); continue; }
        // A full socket gets nothing more: what is pending stays pending (and is replaced by
        // newer state) until 'drain' flushes again.
        if (c.backpressured) { this.stalled(c); continue; }
        if (c.pendingSnapshot !== null) {
          const snap = c.pendingSnapshot;
          c.pendingSnapshot = null;
          this.send(c, 'snapshot', snap, snap?.seq ?? null);
        }
        if (c.pendingSeries !== null) {
          const s = c.pendingSeries;
          c.pendingSeries = null;
          this.send(c, 'series', s);
        }
        if (c.eventBatch.length) {
          const rows = c.eventBatch.splice(0, c.eventBatch.length);
          this.send(c, 'events', rows);
        }
      }
    });
  }

  stats() {
    return {
      clients: this.clients.size,
      perClient: [...this.clients].map((c) => ({
        id: c.id, user: c.user?.username ?? null, seconds: Math.round((Date.now() - c.connectedAt) / 1000),
        kb: Math.round(c.bytes / 1024), dropped: { ...c.dropped }, node: c.nodeId,
        backpressured: c.backpressured, bufferedKb: Math.round((c.res.writableLength ?? 0) / 1024),
      })),
    };
  }

  closeAll() {
    for (const c of [...this.clients]) this.remove(c);
  }
}
