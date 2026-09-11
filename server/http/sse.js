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
  }

  get dead() { return !this.alive || this.res.writableEnded || this.res.destroyed; }
}

export class StreamHub {
  constructor({ log = () => {} } = {}) {
    this.clients = new Set();
    this.log = log;
    this.seq = 0;
    this.heartbeatMs = 15000;
    this.timer = null;
  }

  add(req, res, { user = null, nodeId = null } = {}) {
    const id = ++this.seq;
    const client = new Client(res, user, id);
    client.nodeId = nodeId;
    res.writeHead(200, {
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
        // A comment frame keeps intermediaries from reaping an idle stream and
        // lets us notice a dead socket on our own terms.
        if (this.write(c, ': ping\n\n')) {
          if (Date.now() - c.lastWriteAt > 120_000 && c.bytes === 0) this.remove(c);
        }
      }
    };
    this.timer = setInterval(tick, this.heartbeatMs);
    this.timer.unref?.();
  }

  write(client, frame) {
    if (client.dead) return false;
    try {
      const ok = client.res.write(frame);
      client.bytes += frame.length;
      client.lastWriteAt = Date.now();
      if (!ok) client.backpressured = true;
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
      })),
    };
  }

  closeAll() {
    for (const c of [...this.clients]) this.remove(c);
  }
}
