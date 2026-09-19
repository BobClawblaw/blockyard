// Bitcoin Core JSON-RPC client with deliberate etiquette.
//
// Why this is more than a fetch wrapper: a dashboard with N tabs each polling M methods is an
// accidental denial-of-service against the very node we exist to monitor. Whatever the node's
// threading, the monitor must be a good guest.
//
// HOW MANY CONNECTIONS THE NODE CAN ACTUALLY USE DEPENDS ON THE NODE, and the default here was
// written for one that services ONE connection at a time on a single thread
// (docs/RPC_LIVE_NODE.md slice 11 -- also why its `waitforblock` refuses to wait indefinitely,
// and why `rescanblockchain` blocks every other RPC). That is NOT true of Bitcoin Core, which
// defaults to four RPC threads: measured 2026-09-13 against an Umbrel running Core 31.1.0, four
// concurrent getblockchaininfo calls finished in 158 ms wall against 157 ms each. The line that
// used to sit below -- "maxInFlight = 1 (the server cannot use more anyway)" -- was false there,
// and the cost was real: a 3.9 s getblocktemplate held the only slot while every other tier
// queued, giving avgLatency 1715 ms and repeated 90 s timeouts on a node answering single calls
// in ~106 ms. A node entry can now carry its own `rpc` block (see monitor.js), so this is a
// default, not an assumption.
//
// So every request from every user and every poll tier goes through ONE lane per node with:
//   - at most `maxInFlight` calls in flight. This was advisory until 2026-09-18 -- the lane gated
//     on a boolean and never read it (measured 2026-09-13 at 1, 4 and 8: peak concurrency 1 every
//     time). It is read now (operator, 2026-09-18: "Didn't we dramatically improve concurrency for
//     RPC?"): measured that day, 8 getblockstats at once took 33 ms on BMC run 26 against 20 ms
//     for one -- 4.9x the throughput of one at a time -- and 4.5x on Core 31.1, whose default is
//     four RPC threads (docs/MEASUREMENTS.md section 40). A node that really is single-threaded
//     sets `"rpc": { "maxInFlight": 1 }` on its own entry and gets the old lane back exactly.
//   - a floor between request STARTS (minIntervalMs): concurrency does not raise the call rate
//     this monitor asks of a node, it only stops one slow call from holding everything behind it
//   - a global calls/second ceiling
//   - a circuit breaker that backs off instead of pile-driving a busy node
//
// Batching is the other half of the answer. Slice 11 records that a top-level
// JSON array is a batch answered on ONE connection ("Batches never throw HTTP
// errors"). Verified against the live node: a 3-method batch round-tripped in
// 3ms, where three separate calls cost three single-connection handoffs. Ten
// methods per tier therefore cost ~1 connection, not 10.
import http from 'node:http';
import https from 'node:https';
import { resolveCookie } from '../config.js';


/**
 * A file path as it may be shown to a viewer (audit 2026-09-16, L11): its last two parts, which say
 * which cookie or log it is (`main/.cookie`, `bitcoin/debug.log`) without the directories above --
 * a home directory in them names the account the node runs as, and in open mode anyone who can
 * reach the port reads these responses.
 */
export function shortPath(p) {
  if (typeof p !== 'string' || !p) return p ?? null;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`;
}

/**
 * The RPC URL as it may be shown to a viewer (audit 2026-09-16, L3): never with a username or
 * password in it. `http://user:pass@host:8332` is a valid rpcUrl, and the endpoint is shown on the
 * Node page and in the node picker's tooltip to everyone who can read the monitor.
 */
export function displayUrl(u) {
  if (typeof u !== 'string' || !u) return u ?? null;
  try {
    const url = new URL(u);
    if (!url.username && !url.password) return u;
    url.username = ''; url.password = '';
    return url.toString();
  } catch { return u.replace(/\/\/[^@/]*@/, '//'); }
}

export class RpcError extends Error {
  constructor(message, { code = null, httpStatus = null, kind = 'rpc' } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.kind = kind; // rpc | transport | timeout | auth | breaker | parse
  }
}

// A lane: up to `maxInFlight` calls at a time, their starts spaced, rate-capped, with a breaker.
export class Lane {
  constructor(cfg) {
    this.cfg = cfg;
    // Honour the rate ceiling for real: spacing between STARTS is the lever that sets
    // calls/second, whatever the concurrency, so take whichever floor is stricter.
    this.spacingMs = Math.max(cfg.minIntervalMs, cfg.maxRatePerSec ? Math.ceil(1000 / cfg.maxRatePerSec) : 0);
    this.maxInFlight = Math.max(1, Math.floor(Number(cfg.maxInFlight) || 1));
    this.pending = new Map();
    this.active = 0;                     // calls started and not yet settled
    this.peakInFlight = 0;
    this.lastStartAt = 0;
    this.openUntil = 0;
    this.consecutive = 0;
    this.recent = []; // {ts, ms, methods} over a sliding 60s window
    this.stats = {
      calls: 0, batches: 0, methods: 0, errors: 0, timeouts: 0, authRetries: 0,
      breakerTrips: 0, lastLatencyMs: null, avgLatencyMs: null, maxLatencyMs: 0,
      ratePerSec: 0, busyMsPerSec: 0, staleDropped: 0,
    };
  }

  get breakerOpen() { return Date.now() < this.openUntil; }
  get busy() { return this.active >= this.maxInFlight; }

  // `priority` orders the queue, lowest first. Without it every tier shared one
  // FIFO lane, and a measured 69-second getchaintxstats batch left the cheap
  // getblockchaininfo poll starved behind it -- so the sync bar received about
  // one height sample per two minutes on exactly the node that most needed it.
  //
  // `ignoreBreaker` sends the call through an open breaker. It exists for exactly one caller
  // -- the administrative suite's `walletlock` after a spend (server/admin/wallet.js,
  // relockWallet) -- because the breaker protects a busy node from questions, and "lock the
  // wallet I just unlocked" is not a question that may wait out a cooldown. Anything else
  // passing it is a mistake.
  submit(job, { weight = 1, key = null, maxWaitMs = null, priority = 5, label = null, ignoreBreaker = false } = {}) {
    if (this.breakerOpen && !ignoreBreaker) {
      const e = new RpcError(
        `RPC circuit breaker open; retry in ${Math.ceil((this.openUntil - Date.now()) / 1000)}s${this.openedBy ? ` (opened by ${this.openedBy.label}, ${this.openedBy.kind} after ${this.openedBy.ms}ms)` : ''}`,
        { kind: 'breaker' },
      );
      return Promise.reject(e);
    }
    const enqueuedAt = Date.now();
    const budget = maxWaitMs ?? this.cfg.staleDropMs ?? 15000;

    // Coalesce by key. A poll job asks "what is the state NOW", so a second
    // identical request queued behind the first is not new information -- and on
    // a node whose RPC was measured at 40.4s for a bare getblockcount during
    // initial block download, a 4-second tier would otherwise stack up dozens of
    // questions about a moment that had already passed. Newest wins; the
    // superseded job is rejected as stale, which is a deliberate drop.
    if (key && this.pending.has(key)) {
      const old = this.pending.get(key);
      this.pending.delete(key);
      old.reject(new RpcError('superseded by a newer poll of the same tier', { kind: 'stale' }));
      this.stats.staleDropped += 1;
    }

    return new Promise((resolve, reject) => {
      const mapKey = key ?? `anon:${enqueuedAt}:${Math.random().toString(36).slice(2, 10)}`;
      const entry = { job, weight, key, mapKey, enqueuedAt, budget, settled: false, label };
      entry.resolve = (v) => { if (!entry.settled) { entry.settled = true; resolve(v); } };
      entry.reject = (e) => { if (!entry.settled) { entry.settled = true; reject(e); } };
      entry.priority = priority;
      entry.ignoreBreaker = ignoreBreaker;
      this.pending.set(mapKey, entry);
      setImmediate(() => this._drain());
    });
  }

  _drain() {
    // one start per free slot, each through the same checks
    while (this.active < this.maxInFlight && this.pending.size) this._startNext();
  }

  _startNext() {
    // Highest priority first, insertion order within a priority (Map preserves
    // it, and the filter keeps that order).
    let first = null;
    for (const e of this.pending.values()) if (!first || e.priority < first.priority) first = e;
    if (!first) return;
    this.pending.delete(first.mapKey);
    const now = Date.now();

    // The breaker is respected at dequeue as well as at submit. Without this, work
    // that was already queued when the breaker opened still fired at the node, so
    // "back off for 30 s" meant "back off for new questions only" -- which is not
    // what protects a single-threaded server. The measured shape (2026-09-08) was a
    // fast-tier poll sitting in the lane behind three slow-tier failures and running
    // anyway after the breaker opened.
    if (now < this.openUntil && !first.ignoreBreaker) {
      first.reject(new RpcError(
        `RPC circuit breaker open; retry in ${Math.ceil((this.openUntil - now) / 1000)}s${this.openedBy ? ` (opened by ${this.openedBy.label}, ${this.openedBy.kind})` : ''} — this call was already queued when it opened`,
        { kind: 'breaker' },
      ));
      return;
    }

    // Stale-on-dequeue: if the lane could not get to it inside its freshness
    // budget, asking now is worse than not asking, because the answer would be
    // served as current state while describing an older moment.
    if (now - first.enqueuedAt > first.budget) {
      first.reject(new RpcError(`dropped: waited ${now - first.enqueuedAt}ms for a lane free enough to answer meaningfully`, { kind: 'stale' }));
      this.stats.staleDropped += 1;
      return;
    }

    // spaced from the previous START, which may itself still be waiting for its turn
    const wait = Math.max(0, this.spacingMs - (now - this.lastStartAt));
    this.active += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.active);
    this.lastStartAt = now + wait;

    setTimeout(() => {
      Promise.resolve()
        .then(() => first.job())
        .then((v) => { this.consecutive = 0; first.resolve(v); })
        .catch((err) => {
          if (err.kind === 'stale') { first.reject(err); return; }
          this.stats.errors += 1;
          if (err.kind === 'timeout') this.stats.timeouts += 1;
          this.consecutive += 1;
          this.lastFailure = { at: Date.now(), label: first.label ?? 'call', kind: err.kind ?? 'rpc', ms: this.stats.lastLatencyMs ?? null, message: String(err.message ?? '').slice(0, 160) };
          // A stale drop is this module choosing not to ask; only a real failure
          // may open the breaker.
          if (err.kind !== 'rpc' && this.consecutive >= this.cfg.breakerThreshold) {
            this.openUntil = Date.now() + this.cfg.breakerCooldownMs;
            // Which method did this, and what was queued behind it. The breaker is
            // per-node on purpose, so "a slow tier blinds the fast one" is a real
            // property of this design; recording the trigger is what makes the next
            // occurrence answerable instead of arguable.
            this.openedBy = { ...this.lastFailure, at: Date.now(), blocked: [...this.pending.values()].map((e) => e.label ?? 'call') };
            this.stats.breakerTrips += 1;
            this.consecutive = 0;
          }
          first.reject(err);
        })
        .finally(() => {
          this.active -= 1;
          if (this.pending.size) this._drain();
        });
    }, wait);
  }

  // A timeout has to be timed too. Latency was previously only sampled on
  // success, so a node that answered nothing at all for 90 s produced an empty
  // latency history: the adaptive cadence saw a healthy node, the "RPC is slow"
  // quality flag never fired, and the heavy-tier skip never engaged. The lane WAS
  // busy for those 90 seconds; the telemetry has to say so.
  noteFailure(ms, methodCount) {
    const s = this.stats;
    s.calls += 1;
    s.failedCalls = (s.failedCalls ?? 0) + 1;
    s.lastLatencyMs = ms;
    s.avgLatencyMs = s.avgLatencyMs == null ? ms : Math.round(s.avgLatencyMs * 0.8 + ms * 0.2);
    s.maxLatencyMs = Math.max(s.maxLatencyMs, ms);
    this.recent.push({ ts: Date.now(), ms, methods: methodCount });
    const cutoff = Date.now() - 60_000;
    while (this.recent.length && this.recent[0].ts < cutoff) this.recent.shift();
    s.ratePerSec = +(this.recent.length / 60).toFixed(2);
    s.busyMsPerSec = +(this.recent.reduce((a, r) => a + r.ms, 0) / 60).toFixed(1);
  }

  note(ms, methodCount, wasBatch) {
    const s = this.stats;
    s.calls += 1;
    if (wasBatch) s.batches += 1;
    s.methods += methodCount;
    s.lastLatencyMs = ms;
    s.avgLatencyMs = s.avgLatencyMs == null ? ms : Math.round(s.avgLatencyMs * 0.8 + ms * 0.2);
    s.maxLatencyMs = Math.max(s.maxLatencyMs, ms);
    const cutoff = Date.now() - 60_000;
    this.recent.push({ ts: Date.now(), ms, methods: methodCount });
    while (this.recent.length && this.recent[0].ts < cutoff) this.recent.shift();
    if (this.recent.length > 2000) this.recent.splice(0, this.recent.length - 2000);
    s.ratePerSec = +(this.recent.reduce((a, r) => a + 1, 0) / 60).toFixed(2);
    s.busyMsPerSec = +(this.recent.reduce((a, r) => a + r.ms, 0) / 60).toFixed(1);
  }

  get queued() { return this.pending.size; }

  /**
   * The breaker as a fact rather than a symptom: open or not, how long remains,
   * what opened it, and what is being blocked while it is open.
   *
   * This is the answer to the question that could not be answered on 2026-09-08,
   * when `online false (breaker open, retry in 26s)` alternated with `online true`
   * while a direct getblockcount answered in 1 ms. Whether per-tier granularity
   * would help is still unmeasured (docs/DEFECTS.md); whether the breaker is to
   * blame for a given flap is now checkable from the telemetry panel.
   */
  breakerState() {
    const now = Date.now();
    return {
      open: now < this.openUntil,
      openForMs: this.openedBy && now < this.openUntil ? Math.max(0, this.cfg.breakerCooldownMs - (now - this.openedBy.at)) : 0,
      retryInMs: now < this.openUntil ? this.openUntil - now : 0,
      openedBy: this.openedBy ?? null,
      lastFailure: this.lastFailure ?? null,
      consecutive: this.consecutive,
      threshold: this.cfg.breakerThreshold,
      cooldownMs: this.cfg.breakerCooldownMs,
    };
  }
}

function parseUrl(u) { return new URL(u); }

export class RpcClient {
  constructor(node, rpcCfg, { log } = {}) {
    this.node = node;
    this.cfg = rpcCfg;
    this.log = log ?? (() => {});
    this.lane = new Lane(rpcCfg);
    this.url = parseUrl(node.rpcUrl);
    this._cookieSource = null;
    this._auth = null;
    this.lastGoodAt = null;
    this.lastError = null;
  }

  get id() { return this.node.id; }

  // The cookie is regenerated on every boot and deleted on shutdown, so we
  // resolve it lazily and re-resolve on 401 rather than caching a credential
  // that a restart has already invalidated.
  _credentials(forceRefresh = false) {
    if (this._auth && !forceRefresh) return this._auth;
    this._auth = resolveCookie(this.node);
    this._cookieSource = this._auth?.source ?? null;
    return this._auth;
  }

  _transport() {
    const mod = this.url.protocol === 'https:' ? https : http;
    return { mod, port: this.url.port ? Number(this.url.port) : (this.url.protocol === 'https:' ? 443 : 80) };
  }

  // Raw HTTP. Deliberately no keep-alive: holding the socket would hold one of the
  // server's RPC service slots between our own requests (on a node that serves one
  // connection at a time, its only one).
  _raw(bodyStr, { timeoutMs, allowRetry = true, walletPath = '' } = {}) {
    const { mod, port } = this._transport();
    // With no credential we still send (some setups run RPC without auth), but a
    // 401 below is then reported as "no credential found", not as a mystery.
    const auth = this._credentials();
    const headers = {
      'Content-Type': 'text/plain', // Core's httprpc accepts any; plain matches bitcoin-cli
      'Content-Length': Buffer.byteLength(bodyStr),
      Connection: 'close',
      'User-Agent': 'BlockYard/0.1',
    };
    if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.password}`).toString('base64');

    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: this.url.hostname,
        port,
        method: 'POST',
        // WHICH WALLET (2026-09-18, the administrative suite). Bitcoin Core addresses a
        // loaded wallet by URL path -- POST /wallet/<name> -- and with no path the call
        // lands on the node's DEFAULT wallet, whichever that happens to be. A suite that
        // means to read one wallet and silently reads another is a bug; a suite that
        // means to SPEND from one and spends from another is a different word. So the
        // path is per call, the caller names the wallet, and nothing here guesses.
        //
        // It goes through the same client, and therefore the same lane, breaker and rate
        // limit: a second client per wallet would bypass the concurrency control that
        // exists because this node services one RPC at a time.
        path: (this.url.pathname === '/' ? '' : this.url.pathname) + walletPath || '/',
        agent: false,
        headers,
        setNoDelay: true,
      }, (res) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        res.on('data', (c) => {
          size += c.length;
          // A mempool verbose map is megabytes; an unbounded accumulation is a
          // memory leak with our name on it.
          if (size > 512 * 1024 * 1024) { aborted = true; res.destroy(); reject(new RpcError('response too large', { kind: 'transport' })); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          if (aborted) return;
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (e) => reject(new RpcError(e.message, { kind: 'transport' })));
      });
      req.on('error', (e) => reject(new RpcError(e.message, { kind: 'transport' })));
      req.setTimeout(timeoutMs ?? this.cfg.timeoutMs, () => {
        req.destroy();
        reject(new RpcError(`rpc timeout after ${timeoutMs ?? this.cfg.timeoutMs}ms`, { kind: 'timeout' }));
      });
      req.end(bodyStr);
    });
  }

  // One connection, one or many methods. Returns an array of
  // {ok, result|error} in request order.
  // `key` makes this poll-coalescable: pass the same key for a recurring tier so
  // a fresh request supersedes one still waiting. Never pass a key for a
  // user-initiated call -- those must each be answered.
  async batch(calls, { timeoutMs, heavy = false, key = null, maxWaitMs = null, priority = 5, walletPath = '', ignoreBreaker = false } = {}) {
    if (!calls.length) return [];
    const idOf = (i) => `c${i}`;
    const payload = calls.map((c, i) => ({ jsonrpc: '1.0', id: idOf(i), method: c.method, params: c.params ?? [] }));
    const single = calls.length === 1;
    const body = single ? JSON.stringify(payload[0]) : JSON.stringify(payload);

    const job = async () => {
      const t0 = performance.now();
      const to = timeoutMs ?? (heavy ? this.cfg.heavyTimeoutMs : this.cfg.timeoutMs);
      let res;
      try {
        res = await this._raw(body, { timeoutMs: to, walletPath });
      } catch (err) {
        this.lastError = { at: Date.now(), message: err.message, kind: err.kind };
        this.lane.noteFailure(Math.round(performance.now() - t0), calls.length);
        throw err;
      }
      if (res.status === 401) {
        this.lane.stats.authRetries += 1;
        // Cookie likely rotated under us (a restart). Re-read once, then retry.
        const fresh = this._credentials(true);
        if (fresh) {
          const retry = await this._raw(body, { timeoutMs: to, walletPath });
          if (retry.status !== 401) { res = retry; }
          else {
            this.lastError = { at: Date.now(), message: 'RPC 401 unauthorized (cookie rejected after refresh)', kind: 'auth' };
            throw new RpcError('RPC authentication failed (cookie rejected)', { kind: 'auth', httpStatus: 401 });
          }
        } else {
          this.lastError = { at: Date.now(), message: 'RPC 401 and no credential found', kind: 'auth' };
          throw new RpcError('RPC 401 and no credential found (checked cookie paths)', { kind: 'auth', httpStatus: 401 });
        }
      }
      if (res.status >= 400 && res.status !== 500) {
        // Core answers parse errors at 500 with a JSON-RPC body; other 4xx/5xx
        // are transport-level and carry no usable envelope.
        this.lastError = { at: Date.now(), message: `RPC HTTP ${res.status}`, kind: 'transport' };
        throw new RpcError(`RPC HTTP ${res.status}: ${res.body.slice(0, 200)}`, { kind: 'transport', httpStatus: res.status });
      }
      let parsed;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        this.lastError = { at: Date.now(), message: 'RPC returned non-JSON', kind: 'parse' };
        throw new RpcError(`RPC returned non-JSON (${res.body.slice(0, 120)})`, { kind: 'parse' });
      }
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const byId = new Map(items.map((it) => [String(it.id), it]));
      const out = calls.map((c, i) => {
        const it = byId.get(idOf(i)) ?? byId.get('0') ?? (single ? items[0] : undefined);
        if (!it) return { ok: false, method: c.method, error: { code: null, message: 'no reply for this method in batch' } };
        if (it.error) return { ok: false, method: c.method, error: it.error };
        return { ok: true, method: c.method, result: it.result };
      });
      this.lastGoodAt = Date.now();
      this.lastError = null;
      this.lane.note(Math.round(performance.now() - t0), calls.length, !single);
      return out;
    };

    return this.lane.submit(job, { key, maxWaitMs, priority, ignoreBreaker, label: calls.map((c) => c.method).join('+').slice(0, 120) });
  }

  async call(method, params = [], opts = {}) {
    const [r] = await this.batch([{ method, params }], opts);
    if (!r.ok) {
      throw new RpcError(r.error?.message ?? `${method} failed`, { code: r.error?.code, kind: 'rpc' });
    }
    return r.result;
  }

  telemetry() {
    return {
      nodeId: this.id,
      url: displayUrl(this.node.rpcUrl),
      cookieSource: shortPath(this._cookieSource),
      online: !!this.lastGoodAt && !this.lane.breakerOpen && (!this.lastError || (this.lastGoodAt > this.lastError.at)),
      lastGoodAt: this.lastGoodAt,
      lastError: this.lastError,
      breakerOpen: this.lane.breakerOpen,
      breaker: this.lane.breakerState(),
      queued: this.lane.queued,
      inFlight: this.lane.active,
      maxInFlight: this.lane.maxInFlight,
      peakInFlight: this.lane.peakInFlight,
      recent: this.recent,
      ...this.lane.stats,
    };
  }
}
