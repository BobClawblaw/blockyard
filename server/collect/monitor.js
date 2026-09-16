// Per-node monitor: polls the node politely, follows its log, and turns both
// into time series plus a live event feed.
//
// Three rules govern everything in this file.
//
// 1. Never fabricate. A number we did not get from the node is absent, not zero.
//    This is the project's own documented ethos ("omitted rather than reported
//    low", "a short count that looks real is worse than an absent one"), and a
//    monitoring tool is exactly where a plausible fake does the most damage.
// 2. Never wedge the node. Its RPC server is single-connection/single-thread, so
//    tiers are staggered, everything goes through the serialized lane, and a
//    slow tier defers rather than overlapping.
// 3. Say which source a number came from. Two sources disagree here -- the log
//    carries bandwidth and per-peer relay counts that RPC reports as zero or
//    empty in this deployment -- so `health.quality` records every such gap
//    rather than silently preferring one.
import { EventEmitter } from 'node:events';
import { RpcClient, RpcError, displayUrl, shortPath } from '../rpc/client.js';
import { LogTail } from './logtail.js';
import { CounterRate } from '../store/ring.js';
import { computeSync, stripFacts } from './sync.js';
import { SHAPES, RULE_TO_SHAPE } from './logparse.js';
import { decodeCoinbase, minerRow, ledgerApply, ledgerRows, aliasFor, matchPool } from './mining.js';
import { NetworkStats } from './network.js';
import { summarizeTemplate, packagesFromTemplate, blockEconomy, templateCells } from './nextblock.js';
import { templateFromMempool, LOCAL_TEMPLATE_NOTE } from './gbt.js';
import fs from 'node:fs';

// The statistics getblockstats actually has. 'size', 'weight' and 'strippedsize' are
// getblock fields and have never been getblockstats statistics — asking for them by name
// is answered by omitting them, which is why the Chain page's Block size chart sat empty
// forever while every other figure on the same row filled in. The real names are
// total_size / total_weight (measured 2026-09-09, height 966253: asking for the three
// fictions returned 31 keys and none of them was size/weight/strippedsize; asking for
// total_size returned 1,579,815 bytes and total_weight 3,991,545 — a block just under the
// 4M weight cap, i.e. plausible). A field list is a claim about an endpoint, so it is a
// claim that can rot; the row that consumes it states its basis for that reason.
export const BLOCKSTATS_FIELDS = ['totalfee', 'txs', 'total_size', 'total_weight', 'avgfeerate', 'mediantxsize', 'avgtxsize',
  'swtotal_size', 'swtxs', 'subsidy', 'utxo_increase', 'ins', 'outs', 'avgfee', 'medianfee', 'maxfee',
  'feerate_percentiles', 'height', 'blockhash', 'time', 'mediantime'];


// WHAT THE NODE SAYS IS DATA OF A KNOWN SHAPE, OR NOTHING (audit 2026-09-16, L2). These fields went
// from the RPC reply to the page unchecked, and the page wrote some of them as markup: a node that
// answered `chain: "main<img src=x onerror=…>"` put an element on the Chain page. The page now
// escapes them too; the server also refuses to pass on a value that is not the type it names.
export const chainName = (v) => (typeof v === 'string' && /^[a-z0-9_-]{1,24}$/i.test(v) ? v : null);
export const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);
export const countOrNull = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

export class NodeMonitor extends EventEmitter {
  constructor(nodeCfg, { rpc, poll, store, log, history, logCfg, miningCfg }) {
    super();
    this.cfg = nodeCfg;
    this.poll = poll;
    // Node-scoped view of the shared store: series rings are shared across nodes,
    // so writes are stamped with this node's id and reads are filtered by it.
    // Without this a two-node deployment draws the average of two daemons (see
    // History.forNode for the measurement).
    this.history = history?.__perNode ? history : (history?.forNode ? history.forNode(nodeCfg.id) : history);
    this.log = log.child({ node: nodeCfg.id });
    // A node entry may carry its own `rpc` block to override lane TIMING (spacing, rate ceiling,
    // timeouts). It cannot buy concurrency: Lane runs one call at a time by construction and does
    // not read maxInFlight -- measured 2026-09-13 at 1, 4 and 8, peak concurrency was 1 every
    // time. An earlier version of this comment claimed the override fixed a starving node; it did
    // not, because nothing read it.
    this.rpc = new RpcClient(nodeCfg, { ...rpc, ...(nodeCfg.rpc ?? {}) }, { log: this.log });
    // The log *config* has to be passed in separately. It used to be read as
    // `log.tailBytes` off the logger function, which has no such property, so the
    // configured value was silently ignored and LogTail's own 2 MB default applied
    // -- the same number, so nothing looked wrong. A `staleMs` read that way would
    // have been silently undefined too. Found 2026-09-08.
    this.logCfg = logCfg || {};
    this.tail = nodeCfg.logFile ? new LogTail(nodeCfg.logFile, { pollMs: 1000, tailBytes: this.logCfg.tailBytes, log: this.log }) : null;
    // RPC-only mode (`log.enabled: false` / BLOCKYARD_LOG_SOURCE=0): no tail at all.
    // Measured 2026-09-08 on the build then running the bench node: getnettotals'
    // delta-rate was 11.56 MB/s against the node's own stated 11.2 MB/s over 90 s
    // (3% apart), and getpeerinfo answered 21 rows naming up to 201,608,074 bytes
    // per peer with a download-worker marker. On the deployed production
    // build the SAME two calls answer 0 bytes and [] rows with getconnectioncount
    // at 16 -- and both report the same non-Core subversion string. So RPC cannot
    // tell you whether RPC is complete; only the log's build banner can. That is
    // why turning the log off is a loud, per-node statement rather than a silence.
    this.logEnabled = Boolean(nodeCfg.logFile);
    // Who mined what: two cheap reads per block on the serialized lane, measured on
    // 2026-09-09 at getblock(hash,1) = 259,891 B in 8 ms and getrawtransaction(coinbase,2)
    // = 2,915 B in 63 ms. One block per tick, newest first, and nothing at all while the
    // node is in initial download -- a catch-up of tens of thousands of heights must not
    // spend the shared lane on attributions nobody is looking at (rule 1).
    this.miningCfg = { backfill: 36, perTick: 1, enabled: true, aliasesFile: null, poolMapFile: null, ...(miningCfg ?? {}) };
    this.mining = {
      rows: new Map(),        // height -> minerRow
      pools: new Map(),       // poolKey -> ledger entry
      aliases: null,          // loaded from aliasesFile, if a human wrote one
      // Curated coinbase-tag -> pool-name map, written out by scripts/pool-map.js from
      // mempool.space/mining-pools. Labels arrive with their provenance (source, content
      // sha, fetchedAt) and are shown as theirs, never as ours; no match keeps the raw
      // tag and an unknown fingerprint.
      poolMap: null,
      byPool: new Map(),      // grouping by curated label where one matched, else raw key
      fetched: 0, skippedIbd: 0, lastError: null, at: null,
      retryAt: 0, failures: 0,   // backoff after a failed attribution; cleared by the next success
    };
    this.miningQueue = [];
    this.miningBusy = false;
    // THE NETWORK OVER A WEEK AND A YEAR (2026-09-15; network.js): rewards, the difficulty
    // period, hashrate samples, a week of pool shares -- refreshed from the mid tier
    // (a thin handle on this.rpc -- the constructor's `rpc` argument is the lane TIMING block, not the client)
    this.network = new NetworkStats({ rpc: { batch: (calls, opts) => this.rpc.batch(calls, opts) }, log: this.log, poolMap: () => this.mining.poolMap, aliases: () => this.mining.aliases });
    // THE BLOCK BEING BUILT, assembled here from the mempool (2026-09-13; operator, on how
    // mempool.space manages this against a base Core install: "do it"). It used to be one
    // getblocktemplate call costing this node 1.3-1.5 s of its single RPC thread and 1.79 MB,
    // fetched on demand so a page nobody was reading did not pay it every minute. It now costs
    // the node NOTHING: the pool tier already reads getrawmempool(true) for the mempool view,
    // and Core publishes depends, the ancestor sizes and fees.chunk/chunkweight in it, which is
    // everything the selection needs. See gbt.js for the measured comparison against the node's
    // own template (0.03% apart on fees).
    this.nextBlock = null;
    this.nextBlockAt = 0;
    // The verbose mempool the pool tier last read, and when. The block being built is assembled
    // from it (gbt.js) rather than asked for, so the template is exactly as fresh as this is.
    this.mempoolRaw = null;
    this.mempoolRawAt = 0;
    this.nextBlockCfg = { freshMs: 15_000, enabled: this.miningCfg.template !== false };
    this.logHealthMs = this.logCfg.healthMs ?? 30_000;
    // Why 30 minutes and not 5: measured 2026-09-08, the synced production node's
    // own log went 1,182 s (~20 min) between lines at its quietest across 1,840
    // lines. A 15-minute gate cries wolf on a healthy idle node. A node doing IBD
    // writes every ~10 s and can ask for a tighter gate with `logStaleMs`.
    this.staleAfterMs = nodeCfg.logStaleMs ?? this.logCfg.staleMs ?? 1_800_000;
    this.logLines = 0;
    this.logParsed = 0;
    this.logLastSize = null;
    this.logGrowthAt = Date.now();
    this.logGrowthTip = null;
    this.logAdvancedWhileQuiet = null;
    this.logHealthStats = { lastGrowthAt: this.logGrowthAt, checkedAt: null, lines: 0, parsed: 0, ratio: null, quietMs: null };
    this.logHealthTimer = null;
    // Per-shape liveness (see SHAPES in logparse.js). A shape is armed the first
    // time one of its rules matches, which is how a build that never emits a given
    // line is excused without keeping a table of builds.
    this.shapeSeen = new Map();
    this.shapeGates = this.logCfg.shapeGatesMs || {};
    this.lastLineAt = null;
    this.addrGossip = null;
    this.dialFails = null;
    // Restart census (see noteRestartStorm) and the log's unclaimed tags (see
    // tagCensus). Both are "shape of the problem" figures: the individual events
    // are already in the feed, what was missing was the sentence that sums them up.
    this.restarts = [];
    this.unseenTags = new Map(); // "[tag]" -> {lines, firstAt, lastAt, sample}
    this.unseenLines = 0;
    this.storeCfg = store || {};
    this.blockMapCap = this.storeCfg.blockMapCap ?? 12000;
    this.blockMapEvicted = 0;

    this.state = {
      id: nodeCfg.id,
      label: nodeCfg.label || nodeCfg.id,
      color: nodeCfg.color || '#f7931a',
      startedAt: Date.now(),
      chain: null,
      chainInfo: null,
      networkInfo: null,
      mining: null,
      mempool: { loaded: false, count: null, bytes: null, usage: null, maxmempool: null, totalFee: null, mempoolminfee: null, minrelaytxfee: null, unbroadcast: null },
      mempoolDist: null,
      peers: { connections: null, in: null, out: null, list: [], listSource: null, listUpdatedAt: null },
      net: { totalRecv: null, totalSent: null, inBps: null, outBps: null, uploadtarget: null },
      fees: {},
      utxo: {},
      indexes: null,
      tips: [],
      deployments: null,
      rpcInfo: null,
      blocks: new Map(), // height -> stats
      logState: {},
      lastError: null,
      lastGoodAt: null,
      tierRunAt: {},
    };

    this.rateIn = new CounterRate(180000);
    this.rateOut = new CounterRate(180000);
    this.txCounters = new CounterRate(120000);
    // Height is itself a counter, so the same helper gives blocks/s for the sync
    // ETA. A 10-minute window: shorter ones swing wildly on a 2-5 block/s catch-up.
    this.blockRate = new CounterRate(600000);
    // ...and a 2-minute window beside it, so a decelerating sync is visible as a
    // trend rather than hidden inside a smooth average.
    this.blockRateFast = new CounterRate(120000);
    this.reorgAt = null;
    this.perPeerRelay = new Map(); // host -> {accepted, blocks, lastSeen}
    this.perPeerBlocks = new Map();
    this.peerEvents = [];
    this.lastTip = null;
    this.prevChainSize = null;
    this.reorgEvents = 0;
    this.quality = [];
    this.tierTimers = new Map();
    this.tierIntervalMs = {};
    this.lastTierMs = {};
    this.inflightTiers = new Set();
    this.stopped = false;
    this.logBackfilled = false;
    // Stated in the constructor, not in start(): whether the log is a source at all
    // is a configuration fact, and a panel must not have to wait for a poll to find
    // out it will never be filled.
    if (!this.logEnabled) {
      this.flagQuality('log-source-disabled', 'log tailing is off for this node, so these figures have no source and are shown as –: which peer served a block, per-peer relay legs, the mempool accept/reject breakdown, disk-write rate, the download worker\'s banned-peer count, the node\'s own ETA and stored/total, UTXO compaction and validation stalls, archive-layout holes, and sync_failing. Bandwidth and per-peer bytes work on builds that publish them (measured: 11.56 MB/s via getnettotals against 11.2 MB/s stated in the same node\'s log) and not on a build whose counters never move (measured 2026-09-08: 0 bytes with 16 connections, [] rows). Do not cache that answer either way: the same process that read 0/0 at 09:36 on 2026-09-09 had advanced to 23,955,131 bytes received by 17:36 with no restart, while getpeerinfo stayed [] -- so on this build bandwidth survives the switch and per-peer identity does not (MEASUREMENTS 23)', 'info');
    }
  }

  get id() { return this.cfg.id; }
  get label() { return this.state.label; }

  async start() {
    this.loadMiningAliases();
    this.loadPoolMap();
    if (this.tail) {
      this.tail.on('events', (evs) => this.onLogEvents(evs));
      this.tail.on('backfilled', () => { this.logBackfilled = true; this.emit('changed', 'log'); });
      await this.tail.start().catch((err) => this.log({ level: 'error', msg: `log tail failed: ${err.message}` }));
      this.logHealthTimer = setInterval(() => {
        this.checkLogHealth().catch((err) => this.log({ level: 'warn', msg: `log health check failed: ${err.message}` }));
      }, this.logHealthMs);
      this.logHealthTimer.unref?.();
    }
    // Stagger the first runs so boot is not a thundering herd on a
    // single-threaded server: fast, then mid, then slow, each offset.
    this.runTier('fast').finally(() => this.scheduleTier('fast'));
    setTimeout(() => this.runTier('mid').finally(() => this.scheduleTier('mid')), 700);
    setTimeout(() => this.runTier('pool').finally(() => this.scheduleTier('pool')), 1200);
    setTimeout(() => this.runTier('slow').finally(() => this.scheduleTier('slow')), 1600);
    setTimeout(() => this.runTier('rare').finally(() => this.scheduleTier('rare')), 2600);
    return this;
  }

  scheduleTier(name) {
    if (this.stopped) return;
    const ms = this.effectiveTierMs(name);
    if (!ms) return;
    this.tierIntervalMs[name] = ms;
    const t = setTimeout(() => {
      this.runTier(name).finally(() => this.scheduleTier(name));
    }, ms);
    t.unref?.();
    this.tierTimers.set(name, t);
  }

  // Adaptive cadence, and the reason for it is a measurement, not a hunch: the
  // bench node took 40.4s to answer a bare getblockcount while doing initial
  // block download. Polling it on a 4s tier is not monitoring, it is a queue
  // that grows forever (and, before the lane coalesced, load on a node that was
  // already the bottleneck). So each tier stretches to at least twice the
  // observed RPC latency, capped so it recovers automatically once the node
  // speeds up -- which it does, the moment the sync finishes.
  effectiveTierMs(name) {
    // (a config written before the pool tier existed has no poolMs: the pool then
    // keeps the slow tier's cadence, which is where it used to live)
    const base = this.poll[`${name}Ms`] ?? (name === 'pool' ? this.poll.slowMs : undefined);
    if (!base) return null;
    const avg = this.rpc.lane.stats.avgLatencyMs ?? 0;
    const lastMs = this.lastTierMs[name] ?? 0;
    const stretched = Math.max(avg * 2, lastMs * 1.5);
    // The cap matters: the lane already protects the node (one request in
    // flight, superseded-or-dropped polls), so cadence stretching is about not
    // asking questions nobody can answer twice -- not about node protection.
    // Left uncapped (base x 20) the fast tier ran once a minute and the sync
    // bar never accumulated the two height samples its rate needs.
    // The cap must never fall BELOW the configured base, or "stretching" would
    // poll MORE often than configured. Measured on the live node: the rare tier
    // (15 min, and the most expensive of them) was being clamped to 3 minutes --
    // five times the intended load on getpeerinfo/getdeploymentinfo/getrpcinfo.
    const stretchCap = Math.min(Math.max(base * 8, 30_000), 180_000);
    const cap = Math.max(base, stretchCap);
    return Math.min(cap, Math.max(base, Math.round(stretched / 500) * 500));
  }

  async runTier(name) {
    if (this.inflightTiers.has(name)) return { skipped: 'already running' };
    // On a node whose RPC is genuinely slow (this one measured 69 s for a heavy
    // batch), a slow-tier call occupies the single lane for more than a minute
    // and starves the cheap poll that feeds the sync bar. Skip the expensive
    // tiers while that is true, count the skips, and say so -- silently dropping
    // them would look like a monitor bug.
    const avg = this.rpc.lane.stats.avgLatencyMs ?? 0;
    const heavyTiers = ['pool', 'slow', 'rare'];
    const skipAbove = (this.rpc.cfg.slowLatencyMs ?? 5000) * 4;
    // Never skip forever: every 5th attempt goes through regardless, so a node
    // that is *permanently* busy still refreshes its mempool distribution and
    // index state instead of freezing that panel at whatever was last seen.
    this.heavyAttempts = this.heavyAttempts ?? {};
    const attempts = (this.heavyAttempts[name] = (this.heavyAttempts[name] ?? 0) + 1);
    if (heavyTiers.includes(name) && avg > skipAbove && attempts % 5 !== 0) {
      this.skippedHeavy = (this.skippedHeavy ?? 0) + 1;
      this.flagQuality('heavy-tiers-skipped', `the node's RPC is answering in ~${(avg / 1000).toFixed(0)}s, so the slow and rare tiers are being skipped to keep the sync bar and live counters fresh; mempool distribution, indexes and UTXO stats refresh less often as a result`, 'warn');
      return { skipped: 'rpc too slow for heavy tiers' };
    }
    if (this.skippedHeavy && heavyTiers.includes(name) && avg <= skipAbove) this.clearQuality('heavy-tiers-skipped');
    this.inflightTiers.add(name);
    const t0 = performance.now();
    try {
      const out = await this[`tier_${name}`]();
      this.state.tierRunAt[name] = Date.now();
      this.state.lastError = null;
      return out;
    } catch (err) {
      if (err.kind === 'stale') {
        // Dropped by our own lane because a fresher poll superseded it or the
        // answer could not arrive in time to be true. Not a node fault, so it is
        // counted and not logged as an error.
        this.staleDrops = (this.staleDrops ?? 0) + 1;
        return { dropped: 'stale' };
      }
      this.state.lastError = { at: Date.now(), tier: name, message: err.message, kind: err.kind ?? 'internal' };
      // A benchmark node that has been switched off is expected; logging its
      // failure at ERROR every few seconds buries the real errors.
      const level = this.cfg.optional ? 'warn' : (err.kind === 'timeout' ? 'warn' : 'error');
      if (err.kind !== 'breaker') this.log({ level, msg: `${name} tier failed: ${err.message}` });
      return { error: err.message };
    } finally {
      const dur = Math.round(performance.now() - t0);
      this.lastTierMs[name] = dur;
      this.tierStats = { name, ms: dur, at: Date.now() };
      this.inflightTiers.delete(name);
      this.recordRpc();
      this.emit('changed', name);
    }
  }

  async callList(calls, opts) {
    const results = await this.rpc.batch(calls, opts);
    const byMethod = new Map();
    for (const r of results) {
      if (r.ok) byMethod.set(r.method, r.result);
      else byMethod.set(r.method, new RpcError(r.error?.message ?? `${r.method} failed`, { code: r.error?.code, kind: 'rpc' }));
    }
    return byMethod;
  }

  // ---------------------------------------------------------------- tiers

  async tier_fast() {
    const m = await this.callList([
      { method: 'getblockchaininfo' },
      { method: 'getmempoolinfo' },
      { method: 'getconnectioncount' },
      { method: 'getnettotals' },
      { method: 'uptime' },
    ], { key: `${this.id}:fast`, priority: 0 });
    // A method can fail while the connection succeeds -- the node answers -28
    // "Loading block index..." from getblockchaininfo while getmempoolinfo works
    // fine. Swallowing that into a null is how the sync bar ends up showing a
    // bare "unknown": true, but with no reason, which reads as a broken monitor.
    const errors = {};
    const ok = (k) => {
      const v = m.get(k);
      if (v instanceof RpcError) { errors[k] = `code ${v.code ?? '?'}: ${v.message}`; return null; }
      if (v === undefined) { errors[k] = 'no reply for this method in the batch'; return null; }
      return v;
    };
    const bc = ok('getblockchaininfo');
    this.state.methodErrors = errors;
    if (errors.getblockchaininfo) {
      this.flagQuality('chaininfo-unavailable', `getblockchaininfo is refusing: ${errors.getblockchaininfo}. Height, headers and percentage stay unknown until the node answers -- shown as unknown rather than guessed from the log`, 'warn');
    } else {
      this.clearQuality('chaininfo-unavailable');
      // A node answering getblockchaininfo is, by definition, not mid-restart. This
      // closes node-restarting without waiting for a log line that may never come.
      this.clearQuality('node-restarting');
    }
    const mi = ok('getmempoolinfo');
    const cc = ok('getconnectioncount');
    const nt = ok('getnettotals');
    const up = ok('uptime');

    if (bc) {
      const prev = this.state.chainInfo;
      this.state.chain = bc.chain;
      this.state.chainInfo = bc;
      this.state.lastGoodAt = Date.now();
      if (bc.blocks != null) { this.blockRate.add(bc.blocks); this.blockRateFast.add(bc.blocks); }
      if (prev && bc.blocks != null) {
        if (this.lastTip == null) this.lastTip = bc.blocks;
        if (bc.blocks > this.lastTip) await this.onNewTip(this.lastTip + 1, bc.blocks);
        else if (bc.blocks < this.lastTip) {
          // The active chain moved backwards: a reorg. Count it and re-point.
          this.reorgEvents += 1;
          this.reorgAt = Date.now();
          this.blockRate.add(bc.blocks); // CounterRate treats the drop as a fresh baseline
          this.addEvent({ kind: 'reorg', severity: 'warn', tag: 'chain', ts: Date.now(), text: `active chain reorged: tip ${this.lastTip} -> ${bc.blocks}` });
          this.lastTip = bc.blocks;
        }
      } else if (bc.blocks != null) {
        this.lastTip = bc.blocks;
        if (this.state.blocks.size === 0) this.backfillBlocks(this.poll.blockBackfill).catch(() => {});
      }
      this.state.chainInfo = bc;
    }

    if (mi) {
      this.state.mempool = { ...this.state.mempool, ...mi };
      this.state.lastGoodAt = Date.now();
    }
    if (cc != null) {
      this.state.peers.connections = cc;
      if (this.state.networkInfo) {
        this.state.peers.in = this.state.networkInfo.connections_in;
        this.state.peers.out = this.state.networkInfo.connections_out;
      }
    }
    if (nt) {
      const prevRecv = this.state.net.totalRecv;
      this.state.net.totalRecv = nt.totalbytesrecv;
      this.state.net.totalSent = nt.totalbytessent;
      this.state.net.uploadtarget = nt.uploadtarget ?? null;
      this.state.net.timemillis = nt.timemillis;
      // Whether these counters mean anything is build-dependent, and the two
      // shapes need different handling. Measured 2026-09-08: the build deployed to
      // production answered 0/0 for its first eight hours (the byte counters live
      // in the download worker), then started counting mid-uptime with no restart:
      // 23,955,131 bytes received by 17:36 the same day (MEASUREMENTS 23). So the
      // question is 'what does it read now', never 'which build is this' -- and
      // never 'what did it read this morning'. The 03:02 bench build answered real
      // totals from the start -- 11.56 MB/s
      // from this delta against 11.2 MB/s stated in that node's own log, 3% apart.
      // When both read zero the rate is NOT recorded: a 0 B/s on a node that moved
      // 11 MB/s is a fabrication, so the figure stays absent and the flag says why.
      if (nt.totalbytesrecv === 0 && nt.totalbytessent === 0 && prevRecv === 0) {
        this.state.net.inBps = null;
        this.state.net.outBps = null;
        this.flagQuality('nettotals-zero', `getnettotals reports 0 bytes sent and received, so this build does not count the download worker's traffic; bandwidth${this.logEnabled ? ' comes from the node log instead' : ' has no source at all in RPC-only mode and is shown as –'}`, 'warn');
      } else {
        this.clearQuality('nettotals-zero');
        // One sample per poll. add() used to be called twice per value here, which
        // pushed a duplicate {t, value} pair: harmless to the rate (same t, same
        // value) but it doubled the sample buffer and made the first read depend on
        // which of the two calls happened to return the number.
        this.state.net.inBps = this.rateIn.add(nt.totalbytesrecv);
        this.rateOut.add(nt.totalbytessent);
        // The send half needs its own sanity check, and the arithmetic supplies it.
        // Measured on the bench build in RPC-only mode: 12,896,531,244 bytes in and
        // 1,129 bytes out over the same process lifetime, with 21 peers connected.
        // No node receives 11 million times what it sends -- a node pulling 12.9 GB
        // of blocks necessarily sent getdata for them -- so this build's sent counter
        // does not cover the download worker either. Publishing `0 B/s up` from it
        // would be the same sin as publishing a made-up number, so the rate is
        // withheld and the reason is named.
        const recvTotal = nt.totalbytesrecv ?? 0;
        const sentTotal = nt.totalbytessent ?? 0;
        const conns = this.state.peers.connections ?? 0;
        const sentBlind = recvTotal > 100e6 && sentTotal < 1e6 && conns > 0;
        this.state.net.outBps = sentBlind ? null : this.rateOut.rate();
        if (sentBlind) {
          this.flagQuality('upload-unmeasurable', `this build reports ${(recvTotal / 1e9).toFixed(1)} GB received against ${(sentTotal / 1e6).toFixed(3)} MB sent with ${conns} peer(s) connected -- an impossible ratio, so its sent counter misses the download worker and no upload rate can be derived; the figure is absent, not zero`, 'warn');
        } else {
          this.clearQuality('upload-unmeasurable');
        }
      }
    }
    if (up != null) this.state.uptimeSec = up;

    this.history.record('node', {
      blocks: bc?.blocks ?? null,
      headers: bc?.headers ?? null,
      progress: bc?.verificationprogress ?? null,
      difficulty: bc?.difficulty ?? null,
      sizeOnDisk: bc?.size_on_disk ?? null,
      ibd: bc?.initialblockdownload ?? null,
      connections: cc ?? null,
      peersIn: this.state.networkInfo?.connections_in ?? null,
      peersOut: this.state.networkInfo?.connections_out ?? null,
      uptimeMs: up != null ? up * 1000 : null,
      mempoolSize: mi?.size ?? null,
    });
    this.history.record('mempool', {
      count: mi?.size ?? null,
      bytes: mi?.bytes ?? null,
      usage: mi?.usage ?? null,
      maxUsage: mi?.maxmempool ?? null,
      totalFee: mi?.total_fee ?? null,
      minFee: mi?.mempoolminfee ?? null,
      minRelayFee: mi?.minrelaytxfee ?? null,
      unbroadcast: mi?.unbroadcastcount ?? null,
    });
    this.history.record('peers', {
      connections: cc ?? null,
      in: this.state.networkInfo?.connections_in ?? null,
      out: this.state.networkInfo?.connections_out ?? null,
      txRelayPeers: this.perPeerRelay.size,
      servedBlocks: this.perPeerBlocks.size,
    });
    this.history.record('net', {
      inBps: this.state.net.inBps, outBps: this.state.net.outBps,
      inTotal: this.state.net.totalRecv, outTotal: this.state.net.totalSent,
      diskWriteBps: this.state.logState.diskWriteBps ?? null,
      diskTotal: this.state.logState.diskTotal ?? null,
      avgRecvBps: this.state.logState.avgRecv ?? null,
      avgWriteBps: this.state.logState.avgWrite ?? null,
      floorBps: this.state.logState.floorBps ?? null,
      poolMedianBps: this.state.logState.poolMedianBps ?? null,
    });
    return { ok: true };
  }

  async tier_mid() {
    // Five estimatesmartfee targets in ONE batch. callList() keys by method name,
    // which would collapse the five into one, so this tier reads the batch
    // positionally instead.
    const targets = [1, 2, 6, 24, 144];
    const calls = [
      { method: 'getnetworkinfo' },
      { method: 'getmininginfo' },
      { method: 'getchaintips' },
      ...targets.map((t) => ({ method: 'estimatesmartfee', params: [t] })),
      // RPC-only mode: the peer table becomes the only peer source there, so it
      // moves up to the 15 s tier. Appended last, so the positional unwrapping
      // above is unaffected.
      ...(this.logEnabled ? [] : [{ method: 'getpeerinfo' }]),
    ];
    const res = await this.rpc.batch(calls, { key: `${this.id}:mid`, priority: 2 });
    const unwrap = (r) => (r && r.ok ? r.result : null);
    const ni = unwrap(res[0]);
    if (ni) {
      this.state.networkInfo = ni;
      this.state.peers.in = ni.connections_in;
      this.state.peers.out = ni.connections_out;
      this.state.peers.connections = ni.connections;
    }
    this.state.mining = unwrap(res[1]);
    // ...not in the first half minute: the boot's own backfills have the lane, and the network
    // row's first gathering (144 block stats, 400 headers) can wait for the live polls to settle
    if (this.miningCfg.enabled && this.state.chainInfo && Date.now() - this.state.startedAt > 30_000) this.network.refresh(this.state.chainInfo).catch(() => {});
    const tips = unwrap(res[2]);
    if (Array.isArray(tips)) {
      this.state.tips = tips;
      const side = tips.filter((t) => t.status !== 'active');
      if (side.length) this.flagQuality('side-tips', `${side.length} non-active chain tip(s) known to the node (deepest branch ${Math.max(...side.map((t) => t.branchlen || 0))} blocks)`, 'info');
      else this.clearQuality('side-tips');
    }

    const fees = {};
    let haveAny = false;
    for (let i = 0; i < targets.length; i++) {
      const key = `f${targets[i]}`;
      const v = res[3 + i];
      const ok = v && v.ok && v.result && typeof v.result === 'object' && v.result.feerate != null;
      fees[key] = ok ? v.result.feerate : null;
      if (ok) haveAny = true;
      // Core omits feerate and returns `errors` when the estimator has no data.
      // Recording which targets are cold is the honest answer, not a zero.
      if (v && !v.ok) fees[`${key}_error`] = v.error?.message ?? 'failed';
      else if (v && v.ok && v.result?.errors) fees[`${key}_error`] = (v.result.errors || []).map((e) => e.reason ?? JSON.stringify(e)).join(',');
    }
    this.state.fees = fees;
    if (!haveAny) this.flagQuality('fee-estimator-cold', 'estimatesmartfee returned no feerate for any target; a cold estimator answers "unset" and Core does the same, so nothing is shown rather than a made-up rate', 'info');
    else this.clearQuality('fee-estimator-cold');

    this.history.record('fees', {
      f1: fees.f1, f2: fees.f2, f6: fees.f6, f24: fees.f24, f144: fees.f144,
      mempoolmin: this.state.mempool.mempoolminfee ?? null,
      priority: this.state.mempool.mempoolminfee ?? null,
      estimatorOk: haveAny ? 1 : 0,
    });
    if (!this.logEnabled) this.absorbPeerInfo(unwrap(res[3 + targets.length]));
    return { ok: true, feesOk: haveAny };
  }

  // THE POOL TIER (2026-09-11, operator: "Faster refresh"). The verbose mempool
  // map (~0.7 MB at 4.7k tx, ~2.6 MB at the 19k this box has carried; 0.144 s to
  // answer) used to ride the 60 s slow tier with the UTXO-set summary, so the
  // block-space viewer could never be fresher than a minute. On its own tier it
  // refreshes every poll.poolMs (20 s); the lane still serialises it, and it is
  // skipped with the other heavy tiers when the node's RPC is struggling.
  async tier_pool() {
    const t0 = performance.now();
    let raw = null;
    try {
      raw = await this.rpc.call('getrawmempool', [true], { heavy: true, key: `${this.id}:pool-verbose`, priority: 6 });
      // A STREAK OF STALE DROPS IS ONE STORY, NOT A HUNDRED (2026-09-15: on a day the node answered
      // slowly for thirteen hours, this poll -- lowest priority, so last to the lane -- was dropped
      // as stale every four minutes and each drop was its own warn event: 188 of the feed's 200
      // rows, everything else pushed out). A drop now opens a quality flag that counts, one event
      // marks the streak's start, and one marks its end with the count and the span.
      if (this.poolDrops?.n) {
        const d = this.poolDrops;
        this.addEvent({ kind: 'collector_recovered', severity: 'info', tag: 'collector', ts: Date.now(), text: `getrawmempool verbose answers again: dropped as stale ${d.n} time${d.n === 1 ? '' : 's'} over ${Math.round((Date.now() - d.since) / 60000)} min (longest wait ${Math.round(d.maxWait / 1000)}s) -- the node's RPC was too slow for the lowest-priority poll to get a turn` });
        this.clearQuality('pool-poll-dropped');
        this.poolDrops = null;
      }
    } catch (err) {
      if (err?.kind === 'stale' && /dropped: waited/.test(err.message)) {
        const waited = Number((/waited (\d+)ms/.exec(err.message) ?? [])[1] ?? 0);
        const d = (this.poolDrops ??= { n: 0, since: Date.now(), maxWait: 0 });
        d.n += 1; d.maxWait = Math.max(d.maxWait, waited);
        if (d.n === 1) this.addEvent({ kind: 'collector_error', severity: 'warn', tag: 'collector', ts: Date.now(), text: `getrawmempool verbose dropped as stale (waited ${Math.round(waited / 1000)}s for the lane): the node's RPC is slow and this poll is the last in line; further drops are counted on the Node & RPC page until it answers again` });
        this.flagQuality('pool-poll-dropped', `the full-pool poll (getrawmempool verbose) has been dropped as stale ${d.n} time${d.n === 1 ? '' : 's'} since ${new Date(d.since).toISOString().slice(11, 16)} UTC (longest wait ${Math.round(d.maxWait / 1000)}s): the node's RPC is answering slowly and this lowest-priority poll waits behind the live ones; the mempool panels show their last reading meanwhile`, 'warn');
      } else {
        this.addEvent({ kind: 'collector_error', severity: 'warn', tag: 'collector', ts: Date.now(), text: `getrawmempool verbose failed: ${err.message}` });
      }
    }
    if (raw && typeof raw === 'object') {
      this.state.mempoolDist = summarizeMempool(raw);
      this.mempoolDense = denseBlock(raw);   // Viewer Mode 2; not part of the snapshot
      // THE TEMPLATE'S INPUT (2026-09-13). The block being built is assembled from this reply
      // rather than bought with a getblocktemplate call, so the verbose map is kept until the
      // next pool tier replaces it. Held on the monitor, never on `state`: it is tens of
      // thousands of entries and must not ride a snapshot frame to a browser.
      this.mempoolRaw = raw;
      this.mempoolRawAt = Date.now();
      this.state.lastGoodAt = Date.now();
    }
    if (this.state.mempoolDist) {
      this.history.record('mempool', {
        count: this.state.mempoolDist.count,
        bytes: this.state.mempool.bytes ?? null,
        usage: this.state.mempool.usage ?? null,
        maxUsage: this.state.mempool.maxmempool ?? null,
        totalFee: this.state.mempool.total_fee ?? null,
        minFee: this.state.mempool.mempoolminfee ?? null,
        avgFee: this.state.mempoolDist.avgFeeSat,
        avgVsize: this.state.mempoolDist.avgVsize,
        ingestRate: this.state.logState.relayRate ?? null,
      });
    }
    this.tierStats = { name: 'pool', ms: Math.round(performance.now() - t0), at: Date.now() };
    return { ok: true, mempool: this.state.mempoolDist?.count ?? 0 };
  }

  // COINSTATS IS AN INDEX, AND WITHOUT IT THE SUMMARY IS A FULL SCAN (2026-09-11, pointing this
  // app at Bitcoin Core v31.99 for the first time). `gettxoutsetinfo` with no argument means
  // hash_type "hash_serialized_3", which walks the whole UTXO set: measured 41.47 s on Core with
  // 165.2 M UTXOs, against 0.003 s for "muhash" and 0.002 s for the bare call on the production node.
  // One 41 s call in a lane that holds one request at a time is not one slow poll: it poisoned the
  // latency average, stretched every tier's cadence (60 s -> 75 s), dropped 43 polls as stale, and
  // switched off coinbase attribution and the block template with it -- while the page told the
  // operator the NODE was slow, which was false. So the hash type is always explicit.
  //
  // "muhash" is answered from the coinstats index on both node types and keeps the three fields
  // this app records (txouts, total_amount, muhash). Where that index is absent the same call is a
  // full scan again, so a node that says so in getindexinfo is not asked at all: the UTXO figures
  // read as unknown (the panel already draws "–") and the reason is stated, which is cheaper and
  // more honest than 41 s of someone else's node every minute.
  // NEVER A BLIND SCAN (2026-09-14, the first Mac install): "not known yet: ask once" put
  // gettxoutsetinfo in the SAME batch as the getindexinfo that would have said no, so a node with
  // no coinstatsindex was sent a full UTXO-set walk on its first slow tier -- minutes on that
  // machine, past the 90 s timeout, and Core kept walking after the client gave up, holding its
  // chain lock: every other call answered in 18 s, the mempool read was dropped, the board stayed
  // empty. And because the batch had failed, the indexes were still unknown and the next tier
  // asked again, every minute. The UTXO figures are asked only of a node that has SAID it keeps
  // the index; a node that has not answered yet, or does not report indexes, is not asked.
  utxoStatsWanted() {
    const ix = this.state.indexes;
    if (!ix || typeof ix !== 'object') return false;         // not known yet: getindexinfo first, alone
    return !!ix.coinstatsindex?.synced;
  }

  async tier_slow() {
    // The heavy reads: the UTXO-set summary, the indexes and the chain tx stats.
    // (The verbose mempool map moved to tier_pool on 2026-09-11.)
    const t0 = performance.now();
    // the indexes first, on their own, the first time: what they say decides the expensive call
    if (!this.state.indexes || typeof this.state.indexes !== 'object') {
      const first = await this.callList([{ method: 'getindexinfo' }], { key: `${this.id}:slow:indexes`, priority: 5 });
      const ix = first.get('getindexinfo');
      if (ix && !(ix instanceof RpcError)) this.state.indexes = ix;
    }
    const wantUtxo = this.utxoStatsWanted();
    const m = await this.callList([
      { method: 'getindexinfo' },
      ...(wantUtxo ? [{ method: 'gettxoutsetinfo', params: ['muhash'] }] : []),
      { method: 'getchaintxstats', params: [120] },
    ], { key: `${this.id}:slow`, priority: 5 });
    const ok = (k) => { const v = m.get(k); return v instanceof RpcError || v === undefined ? null : v; };
    this.state.indexes = ok('getindexinfo') ?? this.state.indexes;
    if (this.utxoStatsWanted()) this.clearQuality('utxo-unindexed');
    else {
      this.flagQuality('utxo-unindexed', 'UTXO-set figures (coins, total amount, muhash) are not read from this node: it reports no synced coinstatsindex, and without that index gettxoutsetinfo walks the whole UTXO set -- measured at 41 s on a 165 M-output chain, on an RPC server that answers one request at a time. Start the node with -coinstatsindex to have them; until then they are shown as unknown rather than bought at that price', 'info');
      this.state.utxo = null;
    }
    const txo = ok('gettxoutsetinfo');
    if (txo) this.state.utxo = txo;
    const stats = ok('getchaintxstats');
    if (stats) {
      this.state.chaintxstats = stats;
      // txrate is Core's own per-second average over the window; prefer it, and
      // only fall back to our own delta if the node omits the field.
      this.state.txRate = stats.txrate ?? null;
    }
    this.history.record('node', {
      txouts: txo?.txouts ?? null,
      totalAmount: txo?.total_amount ?? null,
      muhash: txo?.muhash ?? null,
      chainTxCount: stats?.txcount ?? null,
      txRate: stats?.txrate ?? null,
      blocks: this.state.chainInfo?.blocks ?? null,
    });
    this.tierStats = { name: 'slow', ms: Math.round(performance.now() - t0), at: Date.now() };
    return { ok: true };
  }

  async tier_rare() {
    const m = await this.callList([
      { method: 'getpeerinfo' },
      { method: 'getdeploymentinfo' },
      { method: 'getrpcinfo' },
      // Both are cheap (11 ms / 3 ms measured) and both say something the log
      // only hints at: getaddrmaninfo is the peer book by network (production:
      // 52,877 tried, ipv4 36,482 / ipv6 9,046 / onion 6,304 / i2p 1,045), and
      // listbanned is the node's own ban table.
      { method: 'getaddrmaninfo' },
      { method: 'listbanned' },
    ], { key: `${this.id}:rare`, priority: 7 });
    const ok = (k) => { const v = m.get(k); return v instanceof RpcError || v === undefined ? null : v; };
    this.absorbPeerInfo(ok('getpeerinfo'));
    const addrman = ok('getaddrmaninfo');
    if (addrman && addrman.all_networks) {
      this.state.peers.addrman = addrman;
      this.state.peers.addrmanUpdatedAt = Date.now();
    }
    const bans = ok('listbanned');
    if (Array.isArray(bans)) {
      this.state.peers.banTable = bans.length;
      // Measured on the bench node while its own log said `banned 8/114`:
      // listbanned answered []. The download worker's bans are not in the node's
      // ban table, so in RPC-only mode that count is simply unavailable -- say
      // which table this is rather than letting it read as "no peers are banned".
      this.state.peers.banTableNote = 'listbanned is the node\'s stored ban table; the download worker\'s per-run bans (its log\'s `banned N/M`) are not in it -- measured 8/114 in the log against [] here';
    }
    this.state.deployments = ok('getdeploymentinfo') ?? this.state.deployments;
    this.state.rpcInfo = ok('getrpcinfo') ?? this.state.rpcInfo;
    return { ok: true };
  }

  // Shared by the rare tier and, in RPC-only mode, the mid tier: with no log there
  // is nothing else naming a peer, so a 15-minute-old peer table is not a table.
  // Cost measured 2026-09-08: 3 ms empty, 4 ms with 21 rows including byte counts.
  absorbPeerInfo(peers) {
    if (!Array.isArray(peers)) return;
    const rated = withPeerRates(peers, this.peerRatePrev, Date.now());
    this.peerRatePrev = rated.prev;
    this.state.peers.list = rated.rows;
    this.state.peers.listSource = 'getpeerinfo';
    this.state.peers.listUpdatedAt = Date.now();
    const cc = this.state.peers.connections;
    if (peers.length === 0 && cc != null && cc > 0) {
      this.flagQuality('peerinfo-empty', `getpeerinfo returns no rows while getconnectioncount reports ${cc} connections; this build publishes no peer table, so peer identity and byte counts${this.logEnabled ? ' come from the node log' : ' are unavailable in RPC-only mode'}`, 'warn');
      this.clearQuality('peerinfo-partial');
    } else {
      this.clearQuality('peerinfo-empty');
      // The other failure shape: rows exist but do not account for the bytes the
      // node says it moved. Measured on the bench build: 1,487,577,978 summed
      // across 21 rows against getnettotals' 2,116,236,872 = 70.29%. The missing
      // 30% is traffic from peers no longer in the table. Render the table, but
      // do not let a sum of rows be mistaken for the total.
      const sumRecv = peers.reduce((a, p) => a + (p.bytesrecv || 0), 0);
      const total = this.state.net.totalRecv;
      const coverage = total ? sumRecv / total : null;
      this.state.peers.byteCoverage = coverage == null ? null : +coverage.toFixed(4);
      if (coverage != null && coverage < 0.9) {
        this.flagQuality('peerinfo-partial', `getpeerinfo names ${peers.length} peer(s) whose bytesrecv sums to ${(coverage * 100).toFixed(1)}% of what getnettotals reports received; the rest belongs to peers no longer in the table, so per-peer figures are a subset, not a breakdown`, 'info');
      } else {
        this.clearQuality('peerinfo-partial');
      }
    }
  }

  // ------------------------------------------------------------ blocks

  async onNewTip(from, to) {
    const span = to - from + 1;
    if (span <= 0) return;
    const cappedFrom = span > 24 ? to - 23 : from; // a catch-up burst: newest 24 only
    await this.fetchBlockStats(range(cappedFrom, to)).catch(() => {});
    this.enqueueMining(range(cappedFrom, to));
    this.lastTip = to;
    if (span > 1) {
      this.addEvent({
        kind: 'tip_jump', severity: 'info', tag: 'chain', ts: Date.now(),
        text: `tip advanced ${span} block(s) to ${to} between polls (fetched newest ${to - cappedFrom + 1})`,
      });
    }
  }

  // ---------------------------------------------------- who mined the block
  //
  // Enqueue only heights we can resolve a hash for, deduped, newest first, bounded.
  // The queue is deliberately small: an attribution lagging a block by a few polls is
  // invisible, while a queue that outruns the lane delays the sync bar everyone watches.
  enqueueMining(heights) {
    if (!this.miningCfg.enabled) return;
    if (this.state.chainInfo?.initialblockdownload === true) {
      this.mining.skippedIbd += heights.length;
      return;
    }
    for (let i = heights.length - 1; i >= 0; i--) {
      const h = heights[i];
      if (this.mining.rows.has(h) || this.miningQueue.includes(h)) continue;
      this.miningQueue.push(h);
    }
    this.miningQueue.sort((a, b) => b - a);
    if (this.miningQueue.length > 60) this.miningQueue.length = 60;
    setImmediate(() => { this.pumpMining().catch(() => {}); });
  }

  async pumpMining() {
    if (this.miningBusy || this.stopped || !this.miningQueue.length) return;
    // A failed round sets mining.retryAt. Honour it here rather than dropping the work, so the
    // queue survives a slow patch and drains when the node recovers.
    if (this.mining.retryAt && Date.now() < this.mining.retryAt) {
      const wait = this.mining.retryAt - Date.now();
      setTimeout(() => { if (!this.stopped) this.pumpMining().catch(() => {}); }, wait).unref?.();
      return;
    }
    this.miningBusy = true;
    try {
      for (let n = 0; n < this.miningCfg.perTick && this.miningQueue.length; n++) {
        const height = this.miningQueue.shift();
        if (this.mining.rows.has(height)) continue;
        const hash = this.state.blocks.get(height)?.hash;
        if (!hash) continue;                     // stats have not landed for it yet
        const row = await this.fetchMining(height, hash).catch((err) => {
          // A failed attribution is a gap, not a zero. Say so, stop asking THIS round -- and
          // keep the work.
          //
          // This used to do `this.miningQueue.length = 0`, which threw the backlog away. Nothing
          // ever put it back: enqueueMining is called only by onNewTip (the heights that just
          // arrived) and by backfillBlocks (once, at boot), and line ~737 skips anything already
          // in `rows` -- which these never reached. So one stale-dropped block discarded the
          // whole 36-block boot window permanently, and with perTick:1 the page then refilled one
          // block at a time as new ones were mined. Seen on an Umbrel 2026-09-13: a single
          // "waited 18068ms for a lane free enough" left windowBlocks=0 with a frozen lastError,
          // while the same code on a local node attributed 30 blocks across 9 pools.
          //
          // The height goes back to the front, the rest of the queue survives, and a backoff
          // decides when to try again -- so a busy node is not hammered and a recovering one
          // catches up by itself.
          this.mining.lastError = `${err?.message ?? err}`;
          this.mining.failures += 1;
          this.mining.retryAt = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(this.mining.failures - 1, 5));
          this.miningQueue.unshift(height);
          this.flagQuality('mining-unavailable', `coinbase attribution paused: getblock/getrawtransaction failed (${this.mining.lastError}); retrying in ${Math.round((this.mining.retryAt - Date.now()) / 1000)}s -- the block list keeps its sizes and fees, the miner column stays empty rather than guessed`, 'warn');
          return null;
        });
        if (!row) break;                 // stop this round; the queue and the backoff hold the rest
        this.mining.failures = 0;
        this.mining.retryAt = 0;
        this.clearQuality('mining-unavailable');
        // Curated label, if the map knows this coinbase. The raw tag is never replaced.
        const matched = matchPool(this.mining.poolMap, { tagText: row.tagText, rawHex: row.rawCoinbase });
        if (matched) {
          row.poolLabel = matched.name;
          row.poolLabelKey = matched.key;
          row.matchedTag = matched.matchedTag;
        }
        row.seenAt = Date.now();          // when WE read it, distinct from the block's own time
        this.mining.rows.set(height, row);
        ledgerApply(this.mining.pools, row);
        // Grouped view: by curated label where one matched, by raw key otherwise, so a
        // pool that writes three different tag strings is countable without pretending
        // we proved they are the same organisation.
        ledgerApply(this.mining.byPool, matched ? { ...row, poolKey: matched.key, poolLabel: matched.name } : row);
        this.mining.fetched += 1;
        this.mining.at = Date.now();
        const stats = this.state.blocks.get(height);
        this.history.record('blocks', {
          t: row.at ?? Date.now(), height, weight: row.weight, size: row.size, txs: row.txs,
          totalfee: row.totalfee, avgFeerate: row.avgFeerate, p0: stats?.p?.[0] ?? null,
          p1: stats?.p?.[1] ?? null, p2: stats?.p?.[2] ?? null, p3: stats?.p?.[3] ?? null, p4: stats?.p?.[4] ?? null,
        });
      }
      // Bounded, newest-first: the ledger is a window and is presented as one.
      if (this.mining.rows.size > 400) {
        const keep = [...this.mining.rows.keys()].sort((a, b) => b - a).slice(0, 360);
        this.mining.rows = new Map(keep.map((k) => [k, this.mining.rows.get(k)]));
      }
    } finally {
      this.miningBusy = false;
      if (this.miningQueue.length && this.miningCfg.perTick) {
        setTimeout(() => { if (!this.stopped) this.pumpMining().catch(() => {}); }, 2000).unref?.();
      }
    }
  }

  async fetchMining(height, hash) {
    const [gb, rt] = await Promise.all([
      // Step 1: the coinbase txid. verbosity 1 is the txid list plus the header, and it
      // also carries the exact serialized size/weight -- 260 KB measured, 8 ms.
      this.rpc.batch([{ method: 'getblock', params: [hash, 1] }], { priority: 3 }),
      Promise.resolve(null),
    ]);
    const block = gb?.[0]?.ok ? gb[0].result : null;
    if (!block) throw new Error(gb?.[0]?.error?.message ?? 'getblock unanswered');
    const cbTxid = Array.isArray(block.tx) ? block.tx[0] : null;
    if (!cbTxid) throw new Error('getblock returned no tx list');
    const rtRes = await this.rpc.batch([{ method: 'getrawtransaction', params: [cbTxid, 2] }], { priority: 3 });
    if (!rtRes?.[0]?.ok) throw new Error(rtRes?.[0]?.error?.message ?? 'getrawtransaction unanswered');
    const vin0 = rtRes[0].result?.vin?.[0] ?? {};
    const decoded = decodeCoinbase(vin0.coinbase ?? vin0.coinbaseHex ?? '');
    const stats = this.state.blocks.get(height) ?? {};
    const row = minerRow({
      height, hash,
      at: (stats.time ?? block.time ? (stats.time ?? block.time) * 1000 : null),
      decoded,
      stats: {
        height, weight: block.weight ?? stats.weight, size: block.size ?? stats.size,
        strippedSize: block.strippedsize ?? null, txs: stats.txs, totalfee: stats.totalfee,
        avgFeerate: stats.avgFeerate, p1: stats.p?.[1], p2: stats.p?.[2], p4: stats.p?.[4],
      },
    });
    if (decoded.height != null && block.height != null && decoded.height !== block.height) {
      // BIP34 says the coinbase carries the block height. A mismatch means we are
      // reading something other than this block's coinbase -- stop rather than
      // attribute a block to the wrong pool.
      this.flagQuality('mining-height-mismatch', `coinbase of ${height} declares ${decoded.height}; not attributed`, 'warn');
      return null;
    }
    return row;
  }

  /**
   * Ask the node what it would put in the next block, and what that says about the
   * mempool's shape (feerate landscape, ancestor packages).
   *
   * `staleMs` lets a caller say "serve me the cached one"; the Mining page refreshes on a
   * timer while it is visible, and a second viewer arriving inside the freshness window
   * shares the first one's call rather than paying the node again.
   */
  async fetchTemplate({ staleMs = this.nextBlockCfg.freshMs, force = false } = {}) {
    if (!this.nextBlockCfg.enabled) return { unavailable: 'disabled (BLOCKYARD_MINING_TEMPLATE=0)' };
    if (this.state.chainInfo?.initialblockdownload === true) {
      return { unavailable: 'node is in initial download; a block template would be built from a chain that is not there yet' };
    }
    if (!this.mempoolRaw) {
      // The pool tier has not answered yet. Saying so is better than assembling an empty block
      // and calling it the one being built.
      return this.nextBlock ?? { unavailable: 'the verbose mempool has not been read yet; the block being built is assembled from it' };
    }
    // ASSEMBLED, NOT FETCHED, so there is no call to coalesce and no lane to wait for: the
    // `nextBlockBusy` promise and the heavy/keyed batch this used to run are gone with the RPC.
    // What freshness means now is the age of the pool tier's last read (20 s by default), so the
    // cache is keyed on THAT rather than on wall-clock: re-assembling the same mempool would
    // produce the same block, and 25,000 entries is ~50 ms of our own CPU, not the node's.
    if (!force && this.nextBlock && this.nextBlockPoolAt === this.mempoolRawAt && Date.now() - this.nextBlockAt < staleMs) {
      return this.nextBlock;
    }

    const t0 = Date.now();
    try {
      const chain = this.state.chainInfo ?? {};
      const tipHeight = Number.isFinite(chain.blocks) ? chain.blocks : this.state.tip?.height ?? null;
      const template = templateFromMempool(this.mempoolRaw, {
        height: tipHeight == null ? null : tipHeight + 1,
        previousblockhash: chain.bestblockhash ?? this.state.tip?.hash ?? null,
        at: Date.now(),
      });
      const txs = template.transactions;
      const summary = summarizeTemplate(template, {
        at: Date.now(), previous: chain.bestblockhash ?? this.state.tip?.hash ?? null,
      });
      const packages = packagesFromTemplate(txs);
      const avgWeightMined = (() => {
        const rows = [...this.mining.rows.values()].filter((r) => Number.isFinite(r?.weight)).slice(0, 40);
        return rows.length ? rows.reduce((n, r) => n + r.weight, 0) / rows.length : null;
      })();
      const economy = blockEconomy({ template: summary, mempool: this.state.mempool, avgWeightMined });
      const visual = templateCells(txs);
      this.nextBlock = {
        ...summary,
        packages,
        economy,
        visual,
        ms: Date.now() - t0,
        at: Date.now(),
        note: LOCAL_TEMPLATE_NOTE,
        // provenance, so the page can say where this came from and how old its input is
        assembledLocally: true,
        source: 'getrawmempool',
        poolSize: template.poolSize,
        poolAgeMs: Date.now() - this.mempoolRawAt,
      };
      this.nextBlockAt = Date.now();
      this.nextBlockPoolAt = this.mempoolRawAt;
      this.clearQuality('template-unavailable');
      return this.nextBlock;
    } catch (err) {
      // Keep showing the last one, marked: a page that silently stops updating is the failure
      // mode this project keeps being called for.
      this.flagQuality('template-unavailable', `assembling the block being built failed (${err?.message ?? err}); the card keeps its last reading and says how old it is`, 'warn');
      if (this.nextBlock) this.nextBlock.lastError = `${err?.message ?? err}`;
      return this.nextBlock ?? { unavailable: `${err?.message ?? err}` };
    }
  }

  miningView() {
    const rows = [...this.mining.rows.values()].sort((a, b) => b.height - a.height);
    const named = (k) => aliasFor(this.mining.aliases, k);
    return {
      recent: rows.slice(0, 40).map((r) => ({ ...r, poolName: named(r.poolKey) })),
      pools: ledgerRows(this.mining.pools).map((p) => ({ ...p, name: named(p.poolKey) })),
      byPool: ledgerRows(this.mining.byPool).map((p) => ({ ...p, name: p.label ?? named(p.poolKey) ?? p.poolKey, labelled: !!p.label })),
      labelSource: this.mining.poolMap
        ? { source: this.mining.poolMap.source, sha256: this.mining.poolMap.sourceSha256, fetchedAt: this.mining.poolMap.fetchedAt, attribution: this.mining.poolMap.attribution }
        : null,
      nextBlock: this.nextBlock,
      nextBlockAgeMs: this.nextBlock ? Date.now() - this.nextBlockAt : null,
      windowBlocks: rows.length,
      windowHeights: rows.length ? { from: rows[rows.length - 1].height, to: rows[0].height } : null,
      fetched: this.mining.fetched, at: this.mining.at, lastError: this.mining.lastError,
      skippedIbd: this.mining.skippedIbd,
      aliasesLoaded: !!this.mining.aliases,
      enabled: this.miningCfg.enabled,
      note: 'shares are of the observed window only, and the window is stated beside them; a pool name appears only if data/pool-aliases.json says so -- otherwise the coinbase text is shown as the pool wrote it',
    };
  }

  loadPoolMap() {
    const f = this.miningCfg.poolMapFile;
    if (!f) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(parsed?.matchers) && parsed.matchers.length) this.mining.poolMap = parsed;
    } catch (err) {
      // An absent map is the normal state (nothing has been fetched yet) and must not be
      // an error; a corrupt one is, because silent half-loading would mislabel blocks.
      if (err?.code !== 'ENOENT') this.mining.lastError = `pool-map: ${err?.message}`;
    }
  }

  loadMiningAliases() {
    const f = this.miningCfg.aliasesFile;
    if (!f) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (parsed && typeof parsed === 'object') this.mining.aliases = parsed;
    } catch (err) {
      if (err?.code !== 'ENOENT') this.mining.lastError = `aliases: ${err?.message}`;
    }
  }

  async backfillBlocks(n) {
    const tip = this.state.chainInfo?.blocks;
    if (tip == null) return;
    const from = Math.max(1, tip - n + 1);
    await this.fetchBlockStats(range(from, tip));
    this.enqueueMining(range(Math.max(from, tip - this.miningCfg.backfill + 1), tip));
  }

  async fetchBlockStats(heights) {
    if (!heights.length) return [];
    const out = [];
    // Chunk the batch: a batch is one connection, but a 900-element batch is one
    // very long turn on a single-threaded server.
    for (const chunk of chunkBy(heights, 12)) {
      const calls = chunk.map((h) => ({ method: 'getblockstats', params: [h, BLOCKSTATS_FIELDS] }));
      const results = await this.rpc.batch(calls, { priority: 3 });
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const h = chunk[i];
        if (!r.ok) {
          // A height we cannot read is a hole, and a hole is a fact -- the node's
          // own docs refuse rather than report low, and so do we.
          this.flagQuality('blockstats-unreadable', `getblockstats failed for height ${h}: ${r.error?.message}`, 'warn');
          continue;
        }
        const s = r.result;
        if (!s || s.height == null) continue;
        const prev = this.state.blocks.get(s.height - 1);
        const row = {
          t: (s.time ?? Math.floor(Date.now() / 1000)) * 1000,
          height: s.height,
          hash: s.blockhash ?? null,
          time: s.time ?? null,
          mediantime: s.mediantime ?? null,
          totalfee: s.totalfee ?? null,
          txs: s.txs ?? null,
          // total_size is the sum of transaction sizes, NOT the serialized block: the
          // 80-byte header and the txid-count varint are not in it. The basis travels in
          // the payload so no chart, export or later reader can quietly read it as "the
          // block size" — the name-trusted-instead-of-checked mistake is what left this
          // figure empty for a day.
          size: s.total_size ?? null,
          weight: s.total_weight ?? null,
          sizeBasis: s.total_size != null
            ? 'sum of transaction sizes (getblockstats total_size); excludes the 80-byte header and the txid-count varint'
            : null,
          sizeMissing: s.total_size == null
            ? 'getblockstats answered without total_size, so no size is claimed — a hole is reported, not drawn as zero'
            : null,
          medianTxSize: s.mediantxsize ?? null,
          avgTxSize: s.avgtxsize ?? null,
          // Fee preference per block, which is the whole basis of a goggles-style view:
          // what feerate a pool actually put in the blocks it mined.
          avgFeerate: s.avgfeerate ?? null,
          swtotalSize: s.swtotal_size ?? null,
          swtxs: s.swtxs ?? null,
          subsidy: s.subsidy ?? null,
          utxoIncrease: s.utxo_increase ?? null,
          ins: s.ins ?? null,
          outs: s.outs ?? null,
          avgfee: s.avgfee ?? null,
          medianfee: s.medianfee ?? null,
          maxfee: s.maxfee ?? null,
          p: Array.isArray(s.feerate_percentiles) ? s.feerate_percentiles : null,
          viaPeer: this.perPeerBlocks.get(s.height) ?? null,
          source: 'getblockstats',
        };
        if (prev?.hash && row.hash) {
          const known = this.state.blocks.get(s.height);
          if (known && known.hash !== row.hash) this.reorgEvents += 1;
        }
        row.gapSec = prev?.time && s.time ? s.time - prev.time : null;
        this.state.blocks.set(s.height, row);
        this.history.record('blocks', { ...row, p0: row.p?.[0] ?? null, p1: row.p?.[1] ?? null, p2: row.p?.[2] ?? null, p3: row.p?.[3] ?? null, p4: row.p?.[4] ?? null });
        out.push(row);
      }
    }
    // Keep the in-memory map bounded; history keeps the long view. Extracted as
    // trimBlockMap() so the policy is callable (and testable) without an RPC round
    // trip, and so `fetchBlockStats([])` cannot skip the cap by returning early.
    this.trimBlockMap();
    if (out.length) this.emit('blocks', out);
    return out;
  }

  /**
   * Drop the oldest heights once the map exceeds store.blockMapCap.
   *
   * The cap is configured and measured, not a round number: 12,000 rows measured
   * 3.6 MB of heap on 2026-09-09 (test/monitor-shapes.test.js, ~310 B per row). The
   * previous 3,000-row cut threw away blocks the 72 h retention would have kept, to
   * save ~0.9 MB -- and `gapSec` for the oldest survivor silently described a block
   * whose predecessor had been dropped.
   */
  trimBlockMap() {
    const cap = this.blockMapCap ?? 12000;
    if (this.state.blocks.size <= cap) return { kept: this.state.blocks.size, dropped: 0, cap };
    const keep = new Set([...this.state.blocks.keys()].sort((a, b) => a - b).slice(-Math.floor(cap * 0.9)));
    let dropped = 0;
    for (const k of [...this.state.blocks.keys()]) if (!keep.has(k)) { this.state.blocks.delete(k); dropped += 1; }
    this.blockMapEvicted += dropped;
    // Say it once in a while rather than never: an eviction is the moment a chart
    // stops being able to reach back, and "the map is full" must not be invisible.
    this.flagQuality('block-map-trimmed', `the in-memory block map holds the newest ${keep.size} heights and has dropped ${this.blockMapEvicted} since start; older blocks come from the rings, and a gapSec computed against a dropped predecessor is not drawn`, 'info');
    return { kept: keep.size, dropped, cap };
  }

  // --------------------------------------------------------------- log

  onLogEvents(evs) {
    const now = Date.now();
    const rows = [];
    for (const ev of evs) {
      rows.push(...this.absorb(ev, now));
      this.logLines += 1;
      // `rule` is null only for a line no parser claimed, so this ratio is the
      // canary for the node changing its log grammar under us.
      if (ev.rule) this.logParsed += 1;
      else this.noteUnseenTag(ev, now);
      // Liveness bookkeeping per measurement, because a corpus ratio hides a dead
      // rule (rule 16). Event time, not wall clock: a backfill must not read as a
      // five-minute silence that just ended.
      if (ev.ts > (this.lastLineAt ?? 0)) this.lastLineAt = ev.ts;
      const shape = ev.rule ? RULE_TO_SHAPE.get(ev.rule) : null;
      if (shape) {
        const rec = this.shapeSeen.get(shape) ?? { lastAt: ev.ts, matches: 0 };
        rec.lastAt = Math.max(rec.lastAt, ev.ts);
        rec.matches += 1;
        this.shapeSeen.set(shape, rec);
      }
    }
    if (rows.length) {
      const logged = rows.map((r) => ({ ...r, source: 'log' }));
      this.history.addEvents(logged);
      this.emit('events', logged);
    }
    this.state.logState.lastEventAt = now;
    this.state.logState.eventCount = (this.state.logState.eventCount ?? 0) + evs.length;
  }

  // Three ways a log-backed panel goes quietly wrong, all three observed on this
  // box within hours of each other:
  //   * the file is not there (a benchmark datadir gets cleaned up);
  //   * the file is there and stopped moving -- on 2026-09-08 the bench node was
  //     configured as <datadir>/main/debug.log, a 144-byte stub written at boot,
  //     while the real log went to console.log. The monitor held that stub open on
  //     fd 22, read nothing, and said nothing: every log-derived panel simply
  //     stopped changing and looked like a quiet node.
  //   * the file moves and nothing matches any more -- the 2026-09-08 bench build
  //     rewrote [dlc] and 1 of its 1,006 tick lines parsed.
  // None of the three is visible in the data itself, which is why the flag exists.
  async checkLogHealth() {
    if (!this.tail) return this.logHealthStats;
    const st = this.tail.status();
    const now = Date.now();

    if (!st.exists) {
      this.flagQuality('log-missing', `no log file at ${st.file}; every panel that draws from the log (bandwidth, per-peer activity, ingest rate) has no source at all, not a zero value`, 'warn');
    } else {
      this.clearQuality('log-missing');
    }

    if (this.logLastSize == null || st.size !== this.logLastSize) {
      this.logGrowthAt = now;
      // Remember the chain height as it stood when the log last moved. A silent
      // log is ambiguous on its own; a silent log while the chain raced ahead is
      // not, and the difference is what the message below says out loud.
      this.logGrowthTip = this.state.chainInfo?.blocks ?? null;
    }
    this.logLastSize = st.size;
    const quietMs = now - this.logGrowthAt;
    const tipNow = this.state.chainInfo?.blocks ?? null;
    const advanced = tipNow != null && this.logGrowthTip != null ? tipNow - this.logGrowthTip : null;
    this.logAdvancedWhileQuiet = quietMs > this.staleAfterMs ? advanced : null;
    if (st.exists && quietMs > this.staleAfterMs) {
      // Measured on the bench node at 04:50: its chain advanced ~15,000 blocks in
      // the 18 minutes its console.log sat frozen at 2,719 bytes -- the node's own
      // stdout is block-buffered when it is a file rather than a tty, so a frozen
      // tail does not automatically mean the wrong file. Saying which of the two
      // it looks like is the point; a bare "log is stale" would be a guess.
      const why = advanced == null
        ? ': cannot tell whether the node is idle or the tail is wrong, because no chain height has been read yet'
        : advanced > 0
          ? `: this node's chain advanced ${advanced} block(s) (${this.logGrowthTip} -> ${tipNow}) while the file sat still, so the node is writing somewhere else, or its stdout is block-buffered because it is a file and not a tty`
          : ' and the chain has not advanced either, so an idle node is the likelier reading';
      this.flagQuality('log-silent', `${st.file} has produced nothing for ${(quietMs / 60000).toFixed(1)} min (stuck at ${st.size} bytes, threshold ${(this.staleAfterMs / 60000).toFixed(0)} min)${why} -- the bandwidth and per-peer figures are frozen, not current`, 'warn');
    } else if (st.exists) {
      this.clearQuality('log-silent');
    }

    // Ratio over the window just observed, then the counters restart: a cumulative
    // average from boot would hide a format change that arrived an hour in.
    const lines = this.logLines;
    const parsed = this.logParsed;
    this.logLines = 0;
    this.logParsed = 0;
    const ratio = lines ? parsed / lines : null;
    if (lines >= 200 && ratio < 0.05) {
      this.flagQuality('log-unparsed', `${st.file} is delivering lines but ${Math.round((1 - ratio) * 100)}% of them (${parsed}/${lines}) match no parser rule: the node's log format has changed and the log-derived panels are reading almost nothing`, 'warn');
    } else if (lines >= 200) {
      this.clearQuality('log-unparsed');
    }

    // Per-shape liveness. The question is not "is the parse ratio low" -- a corpus
    // ratio stayed at 24-74% today while three rules died outright (rule 16). The
    // question is "this measurement was arriving every N seconds, has not arrived for
    // 8x that, and the node is still writing other lines".
    // Trust the node's own answer about IBD when it has one. The first version of
    // this inferred IBD from log shapes, and within a minute of going live it flagged
    // a fully synced node (initialblockdownload=false, verificationprogress=1,
    // blocks==headers) for "bandwidth rate stopped arriving" -- because the tailed
    // history contained `[utxo_live] catchup progress` from the post-boot catch-up,
    // which is not the same thing as being behind. Log shapes are the fallback for
    // when the RPC has not answered, and when even that is unknown we do not watch.
    const ci = this.state.chainInfo;
    const behind = ci?.blocks != null && ci?.headers != null ? ci.headers - ci.blocks : null;
    const ibdKnown = ci != null && (ci.initialblockdownload != null || behind != null);
    const ibdish = ci?.initialblockdownload === true || (behind != null && behind > 100);
    const shapes = [];
    const dead = [];
    for (const spec of SHAPES) {
      const rec = this.shapeSeen.get(spec.shape);
      if (!rec) continue; // never armed: this build does not emit that line
      const gate = this.shapeGates[spec.shape] ?? spec.gateMs;
      if (spec.ibdOnly && !ibdish) {
        shapes.push({
          shape: spec.shape, armed: true, watching: false, lastAt: rec.lastAt, matches: rec.matches, gateMs: gate,
          reason: ibdKnown ? 'node is not in IBD, so this line is expected to stop'
            : 'IBD state unknown (no chainInfo yet); not watched on a guess',
        });
        continue;
      }
      const ageMs = (this.lastLineAt ?? now) - rec.lastAt;
      const silent = ageMs > gate;
      shapes.push({ shape: spec.shape, armed: true, watching: true, lastAt: rec.lastAt, ageSec: Math.round(ageMs / 1000), matches: rec.matches, gateMs: gate, silent });
      if (silent) dead.push(`${spec.shape} (last parsed ${(ageMs / 60000).toFixed(1)} min ago, expected more often than every ${(gate / 60000).toFixed(0)} min)`);
    }
    if (dead.length) {
      this.flagQuality('log-shape-silent', `a measurement this node was producing has stopped arriving while its log keeps moving: ${dead.join('; ')}. Almost always the node reworded that line. The figure is missing, not zero -- the parser has to follow it`, 'warn');
    } else {
      this.clearQuality('log-shape-silent');
    }

    this.logHealthStats = {
      checkedAt: now, lastGrowthAt: this.logGrowthAt, quietMs,
      staleAfterMs: this.staleAfterMs, lines, parsed, ratio: ratio == null ? null : +ratio.toFixed(4),
      advancedWhileQuiet: this.logAdvancedWhileQuiet ?? null,
      shapes,
      shapesWatched: shapes.filter((x) => x.watching).length,
      shapesSilent: dead.length,
    };
    return this.logHealthStats;
  }

  // Per-peer record, created on demand and keyed by host. The peer table is
  // assembled from several log lines that each name the same peer (identity, relay
  // counts, download rate), so every writer shares this accessor.
  peerRecord(host, addr, ts) {
    const rec = this.perPeerRelay.get(host) ?? { accepted: 0, blocks: 0, first: ts };
    if (addr) rec.addr = addr;
    rec.lastSeen = ts;
    this.perPeerRelay.set(host, rec);
    return rec;
  }

  absorb(ev, now) {
    const ls = this.state.logState;
    switch (ev.kind) {
      case 'bandwidth': {
        ls.inBps = ev.netRate ?? ls.inBps;
        ls.netTotal = ev.netTotal ?? ls.netTotal;
        ls.diskWriteBps = ev.diskRate ?? ls.diskWriteBps;
        ls.diskTotal = ev.diskTotal ?? ls.diskTotal;
        ls.lastBandwidthAt = ev.ts;
        // The 2026-09-08 bench build folds the extras into this one line: running
        // averages, the dead-weight floor, the ban counter, the worker's own
        // counters. Each is assigned only when the line actually carried it, so
        // the older production shape cannot null a figure the previous line gave.
        if (ev.avgNetRate != null) ls.avgRecv = ev.avgNetRate;
        if (ev.avgDiskRate != null) ls.avgWrite = ev.avgDiskRate;
        if (ev.floor != null) ls.floorBps = ev.floor;
        if (ev.poolMedianText != null) ls.poolMedianText = ev.poolMedianText;
        if (ev.worker) ls.workerCounters = ev.worker;
        // A field no rule knows is data, not noise: it is how the next format change
        // announces itself before it breaks something.
        if (Array.isArray(ev.extraFields) && ev.extraFields.length) {
          ls.tickExtraFields = { at: ev.ts, fields: ev.extraFields, values: ev.extraValues ?? null };
        }
        if (ev.banned != null) {
          ls.banned = ev.banned;
          ls.bannedOf = ev.bannedOf;
          this.history.record('peers', { banned: ev.banned, connections: this.state.peers.connections ?? null, in: this.state.peers.in ?? null, out: this.state.peers.out ?? null });
        }
        this.state.net.inBps = ev.netRate ?? this.state.net.inBps;
        this.state.net.logNetTotal = ev.netTotal;
        this.state.net.outBps = this.state.net.outBps ?? null;
        this.history.record('net', {
          inBps: ev.netRate ?? null, outBps: this.state.net.outBps ?? null,
          diskWriteBps: ev.diskRate ?? null, inTotal: ev.netTotal ?? null, diskTotal: ev.diskTotal ?? null,
        });
        return [];
      }
      case 'bw_average':
        ls.avgRecv = ev.avgRecv; ls.avgWrite = ev.avgWrite;
        return [];
      case 'deadweight':
        ls.floorBps = ev.floor; ls.poolMedianBps = ev.poolMedian;
        return [];
      case 'ban_count':
        ls.banned = ev.banned; ls.bannedOf = ev.of;
        this.history.record('peers', { banned: ev.banned, connections: this.state.peers.connections ?? null, in: this.state.peers.in ?? null, out: this.state.peers.out ?? null });
        return [];
      case 'peer_ranking':
        ls.ranking = { live: ev.live, answered: ev.answered, best: ev.best, median: ev.median, silent: ev.silent, at: ev.ts };
        this.history.record('peers', {
          rankingLive: ev.live, rankingAnswered: ev.answered, rankingMedianKbps: ev.median == null ? null : Math.round(ev.median / 1000),
          connections: this.state.peers.connections ?? null, in: this.state.peers.in ?? null, out: this.state.peers.out ?? null,
          txRelayPeers: this.perPeerRelay.size, servedBlocks: this.perPeerBlocks.size,
        });
        return [ev];
      case 'heartbeat': {
        ls.heartbeat = { tip: ev.tip, peersInUse: ev.peersInUse, peersWanted: ev.peersWanted, txouts: ev.txouts, uptime: ev.uptime, syncFailing: ev.syncFailing, at: ev.ts };
        ls.peersWanted = ev.peersWanted;
        if (ev.syncFailing != null && ev.syncFailing > 0) this.flagQuality('sync-failing', `node reports sync_failing=${ev.syncFailing} in its heartbeat`, 'warn');
        else this.clearQuality('sync-failing');
        this.history.record('peers', { wanted: ev.peersWanted, in: ev.peersInUse, out: null, connections: this.state.peers.connections ?? null });
        return [];
      }
      case 'conn_budget':
        ls.connBudget = { max: ev.max, outbound: ev.outbound, fullRelay: ev.fullRelay, blockRelay: ev.blockRelay, feeler: ev.feeler, inboundCap: ev.inboundCap };
        return [ev];
      case 'tx_relay': {
        ls.relayRate = ev.relayRate ?? 0;
        ls.relayWindow = ev.windowSec;
        let peers = 0;
        for (const leg of ev.legs) {
          const cur = this.perPeerRelay.get(leg.host) ?? { accepted: 0, blocks: 0, first: ev.ts };
          cur.accepted += leg.accepted;
          cur.window = leg.accepted;
          cur.lastSeen = ev.ts;
          cur.leg = leg.leg;
          cur.addr = leg.addr;
          this.perPeerRelay.set(leg.host, cur);
          peers += 1;
        }
        ls.relayPeers = peers;
        this.history.record('txflow', {
          relayAccepted: ev.accepted, windowSec: ev.windowSec, orphansHeld: ls.orphans?.held ?? null,
          orphansParked: ls.orphans?.parked ?? null, accepted: ls.lastTxAccept?.accepted ?? null,
          rejectMissing: ls.lastTxAccept?.rejectMissingInputs ?? null, rejectPolicy: ls.lastTxAccept?.rejectPolicy ?? null,
          rejectInvalid: ls.lastTxAccept?.rejectInvalid ?? null, inFlight: ls.orphanDetail?.inFlight ?? null,
        });
        return [ev];
      }
      case 'tx_accept': {
        ls.lastTxAccept = ev;
        ls.acceptRate = ev.acceptRate;
        this.history.record('txflow', {
          accepted: ev.accepted, windowSec: ev.windowSec,
          rejectMissing: ev.rejectMissingInputs, rejectPolicy: ev.rejectPolicy, rejectInvalid: ev.rejectInvalid,
          alreadyConfirmed: ev.alreadyConfirmed, relayAccepted: ls.relayAccepted ?? null,
          orphansHeld: ls.orphans?.held ?? null, orphansParked: ls.orphans?.parked ?? null,
          inFlight: ls.orphanDetail?.inFlight ?? null,
        });
        this.history.record('mempool', {
          count: ev.mempool ?? null,
          acceptedDelta: ev.accepted ?? null,
          ingestRate: ev.acceptRate ?? null,
          rejectMissing: ev.rejectMissingInputs, rejectPolicy: ev.rejectPolicy, rejectInvalid: ev.rejectInvalid,
          bytes: this.state.mempool.bytes ?? null, usage: this.state.mempool.usage ?? null,
          maxUsage: this.state.mempool.maxmempool ?? null, totalFee: this.state.mempool.total_fee ?? null,
          minFee: this.state.mempool.mempoolminfee ?? null,
        });
        return [ev];
      }
      case 'orphans':
        ls.orphans = { held: ev.held, parked: ev.parked, resolved: ev.resolved, dropped: ev.dropped, oneP1C: ev.oneP1C };
        this.history.record('txflow', {
          orphansHeld: ev.held, orphansParked: ev.parked, orphansResolved: ev.resolved, orphansDropped: ev.dropped,
          oneP1C: ev.oneP1C?.accepted ?? null, oneP1CFailed: ev.oneP1C?.failed ?? null,
        });
        return [ev];
      case 'orphan_detail':
        ls.orphanDetail = ev;
        this.history.record('txflow', { inFlight: ev.inFlight, orphansDropped: (ls.orphans?.dropped ?? null), windowSec: null });
        return [ev];
      case 'mempool_block_drain':
        ls.lastDrain = { height: ev.height, removed: ev.removed, at: ev.ts };
        this.history.record('mempool', {
          confirmedDrain: ev.removed, count: this.state.mempool.size ?? null,
          bytes: this.state.mempool.bytes ?? null, usage: this.state.mempool.usage ?? null,
          maxUsage: this.state.mempool.maxmempool ?? null, totalFee: this.state.mempool.total_fee ?? null,
          minFee: this.state.mempool.mempoolminfee ?? null,
        });
        return [ev];
      case 'block_stored': {
        // This line is the only place that names WHICH peer handed us the block.
        if (ev.viaHost) {
          this.perPeerBlocks.set(ev.height, ev.viaHost);
          this.perPeerHostBlocks(ev.viaHost, ev.height);
        }
        const known = this.state.blocks.get(ev.height);
        if (known) {
          known.viaPeer = ev.viaHost ?? known.viaPeer;
          if (ev.bytes != null && known.size == null) known.size = ev.bytes;
          if (ev.txs != null && known.txs == null) known.txs = ev.txs;
        }
        return [ev];
      }
      case 'new_block':
        ls.lastNewBlock = { height: ev.height, at: ev.ts, jump: ev.jump };
        return [ev];
      case 'archive_hole':
        this.flagQuality('archive-hole', `block data is not laid out monotonically (first break at height ${ev.height}); the node refuses truncation and pruning above it`, 'warn');
        return [ev];
      case 'peer_connect':
      case 'peer_drop':
      case 'peer_unreachable':
      case 'feeler_dead': {
        this.peerEvents.unshift({ ...ev });
        if (this.peerEvents.length > 400) this.peerEvents.length = 400;
        if (ev.kind === 'peer_connect') this.perPeerConnect(ev);
        return [ev];
      }
      case 'peer_reject': {
        // 323 inbound `v2 handshake failed` lines arrived in half an hour on the
        // production node, all from 127.0.0.1. Forwarding those one by one would
        // push every real event out of the feed and say less: the finding is the
        // rate and the source, not the individual dropped socket.
        if (/handshake failed/i.test(ev.reason ?? '')) {
          const w = (this.handshakeFails ??= { count: 0, hosts: new Map(), firstAt: ev.ts, lastAt: ev.ts });
          w.count += 1;
          w.hosts.set(ev.host ?? '?', (w.hosts.get(ev.host ?? '?') ?? 0) + 1);
          w.lastAt = ev.ts;
          const [topHost, topN] = [...w.hosts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['?', 0];
          this.flagQuality('inbound-handshake-failing', `${w.count} inbound connection(s) failed the ${ev.transport ?? 'BIP324'} handshake and were dropped, ${topN} of them from ${topHost}; these peers never reach the protocol layer, so getpeerinfo cannot show them`, 'warn');
          return [];
        }
        this.peerEvents.unshift({ ...ev });
        if (this.peerEvents.length > 400) this.peerEvents.length = 400;
        return [ev];
      }
      case 'dial_attempt':
        // 52 in the sampled window. A count is the useful form.
        this.dialAttempts = (this.dialAttempts ?? 0) + 1;
        this.dialAttemptLast = ev.ts;
        return [];
      case 'network_note':
        // A host capability, not a peer event: it explains an ipv6 peer count of
        // zero better than the count does, and it is worth one line per boot.
        this.flagQuality('ipv6-unreachable', `the node reports no global IPv6 route on this host, so ipv6 peers are unreachable${ev.caveat ? ` (${ev.caveat})` : ''}; the ipv6 peer count is a host capability, not a node fault`, 'info');
        return [ev];
      case 'addr_gossip': {
        // Median 22 s apart on production: aggregate, never per-line.
        const g = (this.addrGossip ??= { added: 0, updates: 0, firstAt: ev.ts, lastAt: ev.ts });
        g.added += ev.added ?? 0;
        g.updates += 1;
        g.lastAt = ev.ts;
        this.history.record('peers', { gossipAdded: ev.added ?? null, connections: this.state.peers.connections ?? null });
        return [];
      }
      case 'dial_failures': {
        const d = (this.dialFails ??= { failed: 0, events: 0, reasons: new Map(), firstAt: ev.ts, lastAt: ev.ts });
        d.failed += ev.failed ?? 0;
        d.events += 1;
        d.lastAt = ev.ts;
        if (ev.reason) d.reasons.set(ev.reason, (d.reasons.get(ev.reason) ?? 0) + (ev.failed ?? 1));
        // A node that cannot fill its outbound slots is a connectivity fact, but 130
        // lines an hour would bury everything else, so it is a flag with a reason
        // breakdown rather than a stream of events.
        const [topReason, topN] = [...d.reasons.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
        if (d.failed >= 20)
          this.flagQuality('outbound-dial-failing', `${d.failed} outbound dial attempt(s) failed across ${d.events} top-up round(s); most common reason "${topReason}" (${topN}) -- the outbound slots may stay short, which the peer count alone would not explain`, 'warn');
        else this.clearQuality('outbound-dial-failing');
        return [];
      }
      case 'utxo_apply':
        // Validation throughput. Stored as its own figure and never averaged with
        // the download rate or the catch-up rate (rule 9).
        ls.utxoApply = { at: ev.ts, blocks: ev.blocks, height: ev.height, utxoCount: ev.utxoCount, secs: ev.secs, blocksPerSec: ev.blocksPerSec };
        this.history.record('node', { applyBlkPerSec: ev.blocksPerSec, applyHeight: ev.height, applyUtxoCount: ev.utxoCount });
        return [];
      case 'header_mirror':
        ls.headerMirror = { at: ev.ts, added: ev.added, headersNow: ev.headersNow, archiveTip: ev.archiveTip, gap: ev.gap };
        return [];
      case 'node_shutdown':
        // The RPC vanishes moments after this line, so without it a restart reads as
        // a network fault. The tip it recorded is also the answer to "did it lose
        // blocks when it went down".
        //
        // Age-gated on purpose: the tail backfill replays hours of history, and a
        // shutdown from four hours ago re-raising "the node is restarting" on a node
        // that has been up since is exactly the kind of stale certainty this project
        // exists to avoid. The event still reaches the feed, where its timestamp is
        // visible; the flag only speaks for a shutdown that is happening now.
        if (now - ev.ts < 600_000) {
          this.flagQuality('node-restarting', `the node began shutting down (signal ${ev.signal}) with tip ${ev.tipAtShutdown}${ev.outboundLegs != null ? ` and ${ev.outboundLegs} outbound leg(s)` : ''}; anything that looks offline after this is the restart, not a network fault`, 'warn');
        }
        // Nine restarts before 10:39 on 2026-09-08, eighteen shutdown lines in one
        // log, from a concurrent deploying session: each one produced a correct
        // alarm, and nine correct alarms in an hour is indistinguishable from a
        // broken monitor -- to the operator it read as "the monitor is flapping",
        // which is the opposite of what a true-but-noisy signal should produce.
        // The individual events stay in the feed; this says the shape out loud.
        this.restarts.push({ at: now, ts: ev.ts, signal: ev.signal ?? null, tip: ev.tipAtShutdown ?? null });
        if (this.restarts.length > 50) this.restarts.shift();
        this.noteRestartStorm();
        return [ev];
      // The 2026-09-08 bench build (v0.0.1, built 03:02) rewrote these lines ----
      // Whether one of these reaches the event feed is a deliberate split. The IBD
      // shapes arrive every ~10 s (in the 90-minute run measured: 455 progress,
      // 455 tick, 478 compaction lines), so they update state and history and stay
      // out of the feed -- a feed full of them pushes everything else off screen.
      // Only the rare shapes and the bad ones are returned as events.
      case 'dlc_progress': {
        // The node's OWN progress and its OWN eta: stored beside the monitor's
        // measured rate, never merged with it (rules 4 and 9), always labelled.
        ls.dlcProgress = {
          at: ev.ts, elapsedMs: ev.elapsedMs, nodeEtaMs: ev.nodeEtaMs,
          stored: ev.stored, storedOf: ev.storedOf, storedPct: ev.storedPct,
          inFlight: ev.inFlight, windowSize: ev.windowSize, throughHeight: ev.throughHeight,
          oldestGapSec: ev.oldestGapSec, landedPct: ev.landedPct, applied: ev.applied, appliedLag: ev.appliedLag,
        };
        this.history.record('node', {
          dlcStored: ev.stored, dlcStoredOf: ev.storedOf, dlcApplied: ev.applied, dlcAppliedLag: ev.appliedLag,
          dlcInFlight: ev.inFlight, dlcNodeEtaMs: ev.nodeEtaMs,
        });
        return [];
      }
      case 'catchup_progress':
        // A third rate, from the thread applying state rather than the one
        // downloading blocks. Stored separately for the same reason as above.
        ls.catchup = { at: ev.ts, height: ev.height, of: ev.of, pct: ev.pct, blkPerSec: ev.blkPerSec, avgBlkPerSec: ev.avgBlkPerSec, nodeEtaMs: ev.nodeEtaMs, msPerBlk: ev.msPerBlk, phases: ev.phases };
        this.history.record('node', { catchupHeight: ev.height, catchupBlkPerSec: ev.blkPerSec, catchupEtaMs: ev.nodeEtaMs });
        return [];
      case 'ibd_behind':
        ls.ibdBehind = { at: ev.ts, archiveHeight: ev.archiveHeight, announcedTip: ev.announcedTip, behind: ev.behind, workers: ev.workers };
        return [ev];
      case 'relay_paused':
        // Kept because it is the *reason* the per-peer panels are empty during
        // IBD, and it came from the node rather than from us guessing.
        ls.relayPaused = { at: ev.ts, reason: ev.reason, resumes: ev.resumes };
        return [ev];
      case 'utxo_compaction':
        ls.lastCompaction = { at: ev.ts, secs: ev.secs, runsMerged: ev.runsMerged, manifestFrom: ev.manifestFrom, manifestTo: ev.manifestTo, applyWaited: ev.applyWaited };
        return ev.applyWaited ? [ev] : [];
      case 'checklevel':
        ls.lastCheck = { at: ev.ts, level: ev.level, examined: ev.examined, holes: ev.holes, problems: ev.problems };
        if (ev.problems > 0) this.flagQuality('check-problems', `checklevel=${ev.level} over ${ev.blocks} block(s) [${ev.from}..${ev.to}] found ${ev.problems} problem(s) and ${ev.holes} hole(s)`, 'warn');
        else this.clearQuality('check-problems');
        return ev.problems > 0 ? [ev] : [];
      case 'peer_identify': {
        // Identity that neither build's getpeerinfo gives in full: the peer's own
        // height, user agent and protocol, per peer.
        const rec = this.peerRecord(ev.host, ev.addr, ev.ts);
        rec.userAgent = ev.userAgent;
        rec.proto = ev.proto;
        rec.peerHeight = ev.peerHeight;
        rec.direction = ev.direction;
        rec.services = ev.services;
        return [ev];
      }
      case 'peer_throughput': {
        // The only per-peer download rate this node publishes anywhere (see
        // MEASUREMENTS 3: getpeerinfo's byte counters sum to getnettotals).
        const rec = this.peerRecord(ev.host, ev.addr, ev.ts);
        rec.downBps = ev.rate;
        rec.blkPerSec = ev.blkPerSec;
        rec.blocksDownloaded = ev.blocks;
        rec.chunks = ev.chunks;
        rec.worker = ev.worker;
        if (ev.note) rec.note = ev.note;
        if (ev.banned) rec.banned = true;
        this.history.record('peers', {
          downBpsMax: ev.rate, connections: this.state.peers.connections ?? null,
          in: this.state.peers.in ?? null, out: this.state.peers.out ?? null,
        });
        // 256 healthy ticks per run stay out of the feed; an early-killed or
        // banned worker does not.
        return ev.banned || /early-kill/i.test(ev.note ?? '') ? [ev] : [];
      }
      case 'peer_speed': {
        const rec = this.peerRecord(ev.host, ev.addr, ev.ts);
        rec.rank = ev.rank;
        rec.rankRate = ev.rate;
        return [];
      }
      case 'worker_status':
        ls.workerStatus = { at: ev.ts, active: ev.active, total: ev.total };
        return ev.active < ev.total ? [ev] : [];
      case 'peer_drop_count':
        ls.nWitnessDrops = { at: ev.ts, dropped: ev.dropped, redialsSkipped: ev.redialsSkipped };
        return ev.dropped > 0 ? [ev] : [];
      case 'dl_connected':
        ls.dlConnected = { at: ev.ts, connected: ev.connected, wanted: ev.wanted };
        return [ev];
      case 'peer_discovery':
        ls.peerBook = { at: ev.ts, book: ev.book };
        return [ev];
      case 'peer_candidates':
        ls.peerCandidates = { at: ev.ts, candidates: ev.candidates };
        return [ev];
      case 'peer_live_probe':
        ls.peerLive = { at: ev.ts, live: ev.live, probeRounds: ev.probeRounds };
        return [ev];
      case 'headers_from':
        ls.lastHeadersFrom = { at: ev.ts, host: ev.host, headers: ev.headers, total: ev.total };
        return [];
      default:
        return [ev];
    }
  }

  perPeerHostBlocks(host, height) {
    if (!host) return;
    const rec = this.perPeerRelay.get(host) ?? { accepted: 0, blocks: 0, first: Date.now() };
    rec.blocks = (rec.blocks ?? 0) + 1;
    rec.lastBlockAt = Date.now();
    rec.addr = rec.addr ?? host;
    this.perPeerRelay.set(host, rec);
  }

  perPeerConnect(ev) {
    const host = ev.host ?? ev.addr;
    if (!host) return;
    const rec = this.perPeerRelay.get(host) ?? { accepted: 0, blocks: 0, first: Date.now() };
    rec.connectedAt = Date.now();
    rec.transport = ev.transport ?? rec.transport;
    rec.addr = ev.addr ?? rec.addr;
    this.perPeerRelay.set(host, rec);
  }

  addEvent(ev) {
    // Every panel that reads the feed is RPC-derived or monitor-derived, and the
    // node's log is not a source the UI is allowed to cite. So events carry where
    // they came from, and /api/events serves only ours unless asked otherwise.
    const row = this.history.addEvent({ source: 'monitor', ...ev });
    this.emit('events', [row]);
    return row;
  }

  /**
   * Restarts counted in a window, and named when they cluster.
   *
   * The window runs on the LOG's timestamps, not on arrival. The tail replays hours
   * of history at startup, and a census keyed on arrival time would read eighteen
   * archived shutdowns as eighteen restarts happening now -- the exact stale
   * certainty the age-gated `node-restarting` flag was written to avoid.
   *
   * Threshold: 3 shutdowns in 60 minutes, taken from the one sample that exists
   * (nine in ~4 h 18 m on 2026-09-08, about one every 29 minutes) -- roughly 2x the
   * longest gap measured between those restarts, so a deploy storm trips it and a
   * node that reboots twice a day does not. It is a floor for "someone is deploying
   * this box", not a claim about healthy-node behaviour.
   */
  noteRestartStorm(windowMs = 3_600_000, threshold = 3) {
    const now = Date.now();
    this.restarts = this.restarts.filter((r) => now - r.ts <= windowMs);
    if (this.restarts.length >= threshold) {
      const when = this.restarts.map((r) => new Date(r.ts).toISOString().slice(11, 19)).join(', ');
      this.flagQuality('node-restart-storm', `${this.restarts.length} restarts in the last ${Math.round(windowMs / 60000)} min (${when}); each shutdown line is correct, so the reading is "something is deploying this node", not "this monitor is flapping"`, 'warn');
    } else {
      this.clearQuality('node-restart-storm');
    }
    return this.restarts.length;
  }

  /**
   * Name the log lines nothing parses.
   *
   * `log.health.ratio` says coverage fell; it does not say what arrived, which is
   * the difference between "go read 5,000 lines" and "the node started printing
   * `[migratetx]`". The tag is the first `[...]` on the line, kept verbatim, plus
   * one sample so a new node feature is identifiable from the dashboard. Lines with
   * no tag at all are counted under '(untagged)' rather than dropped -- an
   * untagged format change is exactly as much news as a new tag.
   */
  noteUnseenTag(ev, now) {
    const text = String(ev.text ?? '');
    const m = text.match(/^\s*\[([^\]]{1,24})\]/);
    const tag = m ? `[${m[1]}]` : '(untagged)';
    const rec = this.unseenTags.get(tag) ?? { tag, lines: 0, firstAt: ev.ts ?? now, lastAt: ev.ts ?? now, sample: text.slice(0, 160) };
    rec.lines += 1;
    rec.lastAt = Math.max(rec.lastAt, ev.ts ?? now);
    this.unseenTags.set(tag, rec);
    this.unseenLines += 1;
    if (this.unseenTags.size > 40) {
      // A log we understand nothing of is `log-unparsed`'s message, not 40 flags.
      const [oldest] = [...this.unseenTags.keys()];
      this.unseenTags.delete(oldest);
    }
  }

  /**
   * Top unclaimed tags, and the flag that fires when one is clearly a feature.
   *
   * Gate: >= 25 lines of one tag unmatched, while the parser is otherwise working
   * (ratio above 0.5). The second condition is what separates "the node added a
   * subsystem" from "the node rewrote everything", which log-unparsed already
   * covers and covers better.
   */
  tagCensus({ armAt = 25 } = {}) {
    const top = [...this.unseenTags.values()]
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 8)
      .map((r) => ({ tag: r.tag, lines: r.lines, firstAt: r.firstAt, lastAt: r.lastAt, sample: r.sample }));
    const ratio = this.logHealthStats?.ratio ?? null;
    for (const t of top) {
      if (t.lines >= armAt && (ratio == null || ratio >= 0.5)) {
        this.flagQuality('log-new-tag', `${t.tag} has ${t.lines} line(s) no rule claims (sample: "${t.sample}"), while the rest of the log still parses (${ratio == null ? 'ratio not yet measured' : `${Math.round(ratio * 100)}% claimed`}) -- this looks like a node feature the monitor has not been taught to read`, 'warn');
        break; // one flag names the biggest; the table shows the rest
      }
    }
    if (!top.some((t) => t.lines >= armAt && (ratio == null || ratio >= 0.5))) this.clearQuality('log-new-tag');
    return { unclaimed: this.unseenLines, tags: top };
  }

  flagQuality(key, text, severity = 'info') {
    const existing = this.quality.find((q) => q.key === key);
    const now = Date.now();
    // Update in place without re-logging: a heartbeat flag refires every minute,
    // and six identical WARN lines an hour makes the log useless for spotting the
    // one that is new.
    if (existing) { existing.at = now; existing.text = text; existing.severity = severity; return; }
    this.quality.push({ key, text, severity, at: now });
    this.log({ level: severity === 'warn' ? 'warn' : 'debug', msg: `[quality:${key}] ${text}` });
  }

  clearQuality(key) {
    const i = this.quality.findIndex((q) => q.key === key);
    if (i >= 0) this.quality.splice(i, 1);
  }

  recordRpc() {
    const t = this.rpc.telemetry();
    const slowAt = this.rpc.cfg.slowLatencyMs ?? 5000;
    if (t.failedCalls) {
      this.flagQuality('rpc-timeouts', `${t.failedCalls} RPC attempt(s) failed outright, most recently after ${t.lastLatencyMs ?? '?'}ms; ${this.indexBuild ? 'the address index build on this machine is competing for the disk (it pauses while the node is slow)' : 'the node is under load'}, so panels may lag or show no data`, 'warn');
    }
    if ((t.avgLatencyMs ?? 0) > slowAt) {
      this.flagQuality('rpc-slow', `the node's RPC is answering in ~${(t.avgLatencyMs / 1000).toFixed(1)}s (the lane this monitor gives it allows ${this.rpc.cfg.maxInFlight} call(s) in flight)${this.indexBuild ? ' -- the address index build on this machine is competing for the disk and pauses while this lasts' : ''}, so polling has slowed itself down rather than queueing up`, 'warn');
    } else {
      this.clearQuality('rpc-slow');
    }
    this.history.record('rpc', {
      latencyMs: t.lastLatencyMs, avgLatencyMs: t.avgLatencyMs, ratePerSec: t.ratePerSec,
      queued: t.queued, errors: t.errors, breakerTrips: t.breakerTrips, busyMsPerSec: t.busyMsPerSec,
    });
    return t;
  }

  // ---------------------------------------------------------- read model

  snapshot({ seriesRanges = null } = {}) {
    const s = this.state;
    const blocks = [...s.blocks.values()].sort((a, b) => a.height - b.height);
    const recent = blocks.slice(-120);
    const gaps = recent.map((b) => b.gapSec).filter((g) => g != null && g > 0 && g < 7200);
    const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
    const diff = s.chainInfo?.difficulty ?? s.mining?.difficulty ?? null;
    // HASHES PER SECOND, not difficulty per second (2026-09-12, operator: "Why is difficulty and
    // work showing 0 EH/s"). A difficulty-1 target expects 2^32 hashes, so the network's rate is
    // difficulty * 2^32 / seconds-per-block. Dividing difficulty by the gap alone is out by that
    // factor of 4.29 billion: it put 1112 EH/s on screen as "0.0 EH/s", and the test that should
    // have caught it asserted the wrong magnitude was "of the right order".
    // Checked against the node's own getnetworkhashps at the time -- 1.0979e21 H/s reported
    // against 1.112e21 estimated here, agreeing to about one per cent, which is what says this
    // constant is the right one rather than merely a bigger one.
    const hashrateRaw = diff != null && avgGap ? (diff * 2 ** 32) / avgGap : null;
    // "Network hashrate" here is difficulty divided by the mean gap between blocks
    // WE have. Far behind the tip that is not an estimate of anything: during IBD the
    // node applies hundreds of blocks per second, so the gap is milliseconds and the
    // "hashrate" comes out at thousands of EH/s. The number is not wrong, it is
    // answering a different question, and there is no honest way to label it. So it
    // is withheld during IBD with the reason, rather than drawn large and orange.
    const behindHeaders = s.chainInfo?.headers != null && s.chainInfo?.blocks != null
      ? s.chainInfo.headers - s.chainInfo.blocks : null;
    const ibdFlag = s.chainInfo?.initialblockdownload ?? null;
    const hashrateSuppressed = hashrateRaw == null ? null
      : ibdFlag === true ? 'initial block download: the node is applying blocks faster than the network produced them, so difficulty / observed gap measures the apply rate, not the network'
        : (behindHeaders != null && behindHeaders > 6) ? `the node is ${behindHeaders} block(s) behind its own headers, so the observed gap is not the network's`
          : null;
    const hashrate = hashrateSuppressed ? null : hashrateRaw;
    const mi = s.mempool;
    const usagePct = mi?.usage != null && mi?.maxmempool ? (mi.usage / mi.maxmempool) * 100 : null;

    const out = {
      id: s.id,
      label: s.label,
      color: s.color,
      online: this.rpc.telemetry().online,
      chain: chainName(s.chain),
      ibd: boolOrNull(s.chainInfo?.initialblockdownload),
      tip: {
        height: s.chainInfo?.blocks ?? null,
        headers: s.chainInfo?.headers ?? null,
        hash: s.chainInfo?.bestblockhash ?? null,
        time: s.chainInfo?.time ?? null,
        mediantime: s.chainInfo?.mediantime ?? null,
        ageSec: s.chainInfo?.time ? Math.max(0, Math.floor(Date.now() / 1000) - s.chainInfo.time) : null,
        behindHeaders: s.chainInfo?.headers != null && s.chainInfo?.blocks != null ? s.chainInfo.headers - s.chainInfo.blocks : null,
      },
      // The sync bar's whole data contract. See collect/sync.js for why the two
      // percentages stay apart instead of being merged into one number.
      //
      // The node's own label and endpoint are carried INTO the sync object, not
      // left beside it: "Synced" without saying which node is how a monitoring
      // tool manages to look wrong while reporting the truth.
      sync: computeSync({
        blocks: s.chainInfo?.blocks ?? null,
        headers: s.chainInfo?.headers ?? null,
        ibd: boolOrNull(s.chainInfo?.initialblockdownload),
        verificationProgress: s.chainInfo?.verificationprogress ?? null,
        tipTime: s.chainInfo?.time ?? null,
        bestHash: s.chainInfo?.bestblockhash ?? null,
        sizeOnDisk: s.chainInfo?.size_on_disk ?? null,
        chain: chainName(s.chain),
        warnings: s.chainInfo?.warnings ?? [],
        blockRatePerSec: this.blockRateFast.rate(),
        blockRateFastSpanMs: this.blockRateFast.span,
        blockRateSlowPerSec: this.blockRate.rate(),
        blockRateSlowSpanMs: this.blockRate.span,
        avgBlockGapSec: avgGap,
        reorgEvents: this.reorgEvents,
        reorgAt: this.reorgAt,
        peers: s.peers.connections ?? null,
        // the highest tip any peer reports: what tells a long gap from a stalled node
        peerBestHeight: (() => { const hs = (s.peers.list ?? []).map((p) => (Number.isFinite(p.synced_headers) && p.synced_headers >= 0 ? p.synced_headers : Number.isFinite(p.startingheight) ? p.startingheight : -1)).filter((h) => h >= 0); return hs.length ? Math.max(...hs) : null; })(),
        txouts: s.utxo?.txouts ?? s.logState.heartbeat?.txouts ?? null,
        difficulty: diff,
        reason: s.methodErrors?.getblockchaininfo
          ?? s.lastError?.message
          ?? this.rpc.telemetry().lastError?.message
          ?? null,
      }),
      progress: s.chainInfo?.verificationprogress ?? null,
      warnings: s.chainInfo?.warnings ?? [],
      difficulty: diff,
      hashrateEstEh: hashrate == null ? null : hashrate / 1e18,
      // Why there is no hashrate, when there is none. The figure is withheld rather
      // than shown-but-wrong, and the reason is part of the payload so the UI cannot
      // render `–` and leave the question open (rule 3).
      hashrateNote: hashrateSuppressed ?? (hashrateRaw == null ? 'difficulty or a block-gap sample is missing' : null),
      avgBlockGapSec: avgGap,
      sizeOnDisk: s.chainInfo?.size_on_disk ?? null,
      pruned: boolOrNull(s.chainInfo?.pruned),
      chainwork: s.chainInfo?.chainwork ?? null,
      uptimeSec: s.uptimeSec ?? null,
      network: s.networkInfo ? {
        version: s.networkInfo.version,
        subversion: s.networkInfo.subversion,
        protocol: s.networkInfo.protocolversion,
        services: s.networkInfo.localservices,
        servicesNames: s.networkInfo.localservicesnames ?? [],
        networkactive: s.networkInfo.networkactive,
        relayfee: s.networkInfo.relayfee,
        incrementalfee: s.networkInfo.incrementalfee,
        networks: s.networkInfo.networks ?? [],
        localaddresses: s.networkInfo.localaddresses ?? [],
      } : null,
      mempool: {
        loaded: mi.loaded ?? null,
        count: mi.size ?? null,
        bytes: mi.bytes ?? null,
        usage: mi.usage ?? null,
        maxUsage: mi.maxmempool ?? null,
        usagePct,
        totalFee: mi.total_fee ?? null,
        minFee: mi.mempoolminfee ?? null,
        minRelayFee: mi.minrelaytxfee ?? null,
        incrementalRelayFee: mi.incrementalrelayfee ?? null,
        unbroadcast: countOrNull(mi.unbroadcastcount),
        maxDataCarrier: mi.maxdatacarriersize ?? null,
        permitBareMultisig: mi.permitbaremultisig ?? null,
        ingestRate: s.logState.relayRate ?? s.logState.acceptRate ?? null,
        acceptWindow: s.logState.lastTxAccept?.windowSec ?? null,
        rejects: s.logState.lastTxAccept ? {
          missingInputs: s.logState.lastTxAccept.rejectMissingInputs,
          policy: s.logState.lastTxAccept.rejectPolicy,
          invalid: s.logState.lastTxAccept.rejectInvalid,
          alreadyConfirmed: s.logState.lastTxAccept.alreadyConfirmed,
          windowSec: s.logState.lastTxAccept.windowSec,
        } : null,
        lastDrain: s.logState.lastDrain ?? null,
        // Aggregates only. The age/feerate point cloud is a chart dataset -- 1500
        // points does not belong in a frame pushed once a second, so it is served
        // by /api/mempool and refreshed on the mempool panel's own cadence.
        dist: s.mempoolDist ? {
          ...s.mempoolDist,
          scatter: undefined,
          scatterPoints: s.mempoolDist.scatter ? s.mempoolDist.scatter.length : 0,
        } : null,
      },
      peers: {
        connections: s.peers.connections ?? s.networkInfo?.connections ?? null,
        in: s.peers.in ?? null,
        out: s.peers.out ?? null,
        wanted: s.logState.peersWanted ?? s.logState.heartbeat?.peersWanted ?? null,
        budget: s.logState.connBudget ?? null,
        banned: s.logState.banned ?? null,
        bannedOf: s.logState.bannedOf ?? null,
        ranking: s.logState.ranking ?? null,
        rpcRows: s.peers.list.length,
        rpcRowsUpdatedAt: s.peers.listUpdatedAt,
        addrGossip: this.addrGossip ? { added: this.addrGossip.added, updates: this.addrGossip.updates, lastAt: this.addrGossip.lastAt } : null,
        dialFailures: this.dialFails
          ? {
            failed: this.dialFails.failed, rounds: this.dialFails.events, lastAt: this.dialFails.lastAt,
            reasons: [...this.dialFails.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
              .map(([reason, n]) => ({ reason, count: n })),
          }
          : null,
        dialAttempts: this.dialAttempts ?? 0,
        // The RPC's own account of the peer set, kept separate from the log's
        // because on the deployed build one of the two is empty and the other
        // does not exist. `byteCoverage` is how much of getnettotals' received
        // bytes the listed peers actually account for (70.29% measured).
        addrman: s.peers.addrman ?? null,
        addrmanUpdatedAt: s.peers.addrmanUpdatedAt ?? null,
        banTable: s.peers.banTable ?? null,
        banTableNote: s.peers.banTableNote ?? null,
        byteCoverage: s.peers.byteCoverage ?? null,
        // Inbound connections that died in the handshake never exist as far as RPC
        // is concerned -- getpeerinfo cannot show a peer it never negotiated with.
        // Aggregated because 323 of them arrived in 30 minutes.
        handshakeFailures: this.handshakeFails
          ? {
            count: this.handshakeFails.count,
            hosts: [...this.handshakeFails.hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
              .map(([host, n]) => ({ host, count: n })),
            firstAt: this.handshakeFails.firstAt,
            lastAt: this.handshakeFails.lastAt,
          }
          : null,
        // Which source backs the peer table is a first-class fact here, not a
        // footnote: see the peerinfo-empty quality flag.
        identitySource: s.peers.list.length ? 'getpeerinfo' : 'node log (relay legs, block serving, connects/drops)',
        activity: [...this.perPeerRelay.entries()]
          .map(([host, r]) => ({ host, addr: r.addr ?? host, relayAccepted: r.accepted ?? 0, relayWindow: r.window ?? 0, blocksServed: r.blocks ?? 0, lastSeen: r.lastSeen ?? null, connectedAt: r.connectedAt ?? null, transport: r.transport ?? null, leg: r.leg ?? null,
            // Only the bench build prints these; absent means the node never
            // named a rate for this peer, which the UI renders as `–`.
            downBps: r.downBps ?? null, blkPerSec: r.blkPerSec ?? null, blocksDownloaded: r.blocksDownloaded ?? null,
            chunks: r.chunks ?? null, worker: r.worker ?? null, userAgent: r.userAgent ?? null,
            peerHeight: r.peerHeight ?? null, rank: r.rank ?? null, note: r.note ?? null, banned: r.banned ?? false }))
          .sort((a, b) => (b.relayAccepted + b.blocksServed) - (a.relayAccepted + a.blocksServed)),
        // Throughput, when the build prints it. On the production build there is no
        // per-peer rate line at all, so this stays an empty list rather than a
        // table of zeros.
        // Stated per mode. With the tail off, printing this string is a provenance
        // lie: it names a source the process refused to open, and there is no RPC
        // source to fall back to — neither build publishes a per-peer download rate
        // in getpeerinfo or getnettotals (measured 2026-09-08: [] rows / 0 bytes).
        throughputSource: this.logEnabled
          ? 'node log [dlc] worker lines (per-peer download rate; not in getpeerinfo or getnettotals)'
          : 'none — this figure exists only in the node log, and the log source is off',
        identity: [...this.perPeerRelay.values()].some((r) => r.userAgent)
          ? [...this.perPeerRelay.entries()].filter(([, r]) => r.userAgent).map(([host, r]) => ({ host, addr: r.addr ?? host, userAgent: r.userAgent, proto: r.proto ?? null, peerHeight: r.peerHeight ?? null, direction: r.direction ?? null }))
          : null,
        recentEvents: this.peerEvents.slice(0, 40),
      },
      net: {
        totalRecvRpc: s.net.totalRecv,
        totalSentRpc: s.net.totalSent,
        // A counter that has read 0 for the whole uptime is not a measurement of zero
        // traffic — it is the download worker's counters living in another process
        // (measured on the deployed build: totalbytesrecv 0 while the same node's log
        // moved ~47 GB). 0 B/s on a chart reads as "an idle node", which is a claim
        // about the network, not an absence. Symmetric with uploadMeasured below, and
        // the log rate still wins when the tail is on, because it is a real number.
        inBps: s.logState.inBps ?? ((s.net.totalRecv ?? 0) > 0 ? s.net.inBps : null),
        downloadMeasured: s.logState.inBps != null
          || (s.net.totalRecv != null && s.net.totalRecv > 0 && s.net.inBps != null),
        outBps: s.net.outBps ?? null,
        netTotalLog: s.net.logNetTotal ?? null,
        diskWriteBps: s.logState.diskWriteBps ?? null,
        diskTotal: s.logState.diskTotal ?? null,
        avgRecv: s.logState.avgRecv ?? null,
        avgWrite: s.logState.avgWrite ?? null,
        floor: s.logState.floorBps ?? null,
        poolMedian: s.logState.poolMedianBps ?? null,
        // The bench build prints `(median 499.6)` with no unit. Kept as the text
        // the node printed and never converted: if it is KB/s it is 1000x the
        // alternative reading, and the log does not say which. Rule 3.
        poolMedianText: s.logState.poolMedianText ?? null,
        workerCounters: s.logState.workerCounters ?? null,
        uploadtarget: s.net.uploadtarget ?? null,
        // Explicit: the node reports no usable sent-byte counter in this build (see
        // upload-unmeasurable), so the UI must not imply an upload figure it does not
        // have. `outBps === null` is the honest state, and it is now reachable both
        // when the counter is zero and when it is implausibly small.
        uploadMeasured: s.net.totalSent != null && s.net.totalSent > 0 && s.net.outBps != null,
      },
      attribution: this.miningView(),
      network: this.network.view(),
      blocks: {
        count: blocks.length,
        // 40 in the live frame; /api/blocks?limit= serves up to 400 for the chart.
        recent: recent.slice(-40).reverse(),
        backfilled: blocks.length > 0,
        reorgs: this.reorgEvents,
      },
      fees: s.fees,
      mining: s.mining,
      utxo: s.utxo,
      chaintxstats: s.chaintxstats ?? null,
      indexes: s.indexes,
      tips: s.tips,
      deployments: s.deployments,
      rpcInfo: s.rpcInfo ? { ...s.rpcInfo, logpath: shortPath(s.rpcInfo.logpath) } : null,   // no directories to viewers (audit 2026-09-16, L11)
      log: {
        ...(this.tail ? this.tail.status() : { exists: false, file: null }),
        // 'disabled' is a configuration decision; 'missing' would be a fault. The
        // UI must not render the two the same way.
        source: this.logEnabled ? 'file' : 'disabled',
        lastEventAt: s.logState.lastEventAt ?? null,
        heartbeat: s.logState.heartbeat ?? null,
        orphans: s.logState.orphans ?? null,
        orphanDetail: s.logState.orphanDetail ?? null,
        connBudget: s.logState.connBudget ?? null,
        backfilled: this.logBackfilled,
        // What the log-health timer concluded, not what we hope. `ratio` is the
        // share of lines a parser actually claimed over the last window, and
        // `quietMs` is how long the file has produced nothing against
        // `staleAfterMs` -- the two numbers that separate an idle node from a
        // misconfigured tail.
        health: this.logHealthStats,
        // Which lines nothing claims, by tag, with a sample. A ratio says coverage
        // fell; this says what turned up instead.
        unclaimed: this.tagCensus(),
        blockMap: {
          size: s.blocks.size,
          cap: this.blockMapCap,
          evicted: this.blockMapEvicted,
          oldestHeight: blocks.length ? blocks[0].height : null,
        },
        // Fields the node started printing that no rule claims yet, kept verbatim.
        // `staged` and `commit` arrived here on 2026-09-08.
        unrecognisedTickFields: s.logState.tickExtraFields ?? null,
        ibd: {
          // Three independent progress figures, deliberately not merged: ours
          // (blocks/headers + measured rate), the download worker's own
          // (dlcProgress), the applying thread's own (catchup). Rules 4 and 9.
          nodeProgress: s.logState.dlcProgress ?? null,
          nodeCatchup: s.logState.catchup ?? null,
          behind: s.logState.ibdBehind ?? null,
          relayPaused: s.logState.relayPaused ?? null,
          workerStatus: s.logState.workerStatus ?? null,
          lastCompaction: s.logState.lastCompaction ?? null,
          lastCheck: s.logState.lastCheck ?? null,
          // Validation throughput: a third rate, kept apart from the download rate and
          // the catch-up rate above (rule 9).
          applyRate: s.logState.utxoApply ?? null,
          headerMirror: s.logState.headerMirror ?? null,
        },
      },
      health: {
        rpc: this.rpc.telemetry(),
        // Which method opened the breaker, and what it is blocking. The policy is
        // deliberately still all-or-nothing per node (blocking everything for 30 s
        // after 3 consecutive failures is what protects a single-threaded node from
        // a client that will not stop asking); what was missing was the ability to
        // answer "who did this" when it flaps, which is what turned a 2026-09-08
        // investigation into guesswork. Per-tier breakers stay unwritten until the
        // data says the shared one hurts -- see docs/DEFECTS.md.
        // Configured vs actual, with the reason -- a stretched cadence must never
        // look like a broken poller.
        cadence: Object.fromEntries(Object.keys(this.poll)
          .filter((k) => k.endsWith('Ms'))
          .map((k) => {
            // The tier name is the key WITHOUT the "Ms" suffix -- tierIntervalMs is
            // written as ['fast'], so looking it up under 'fastMs' silently returned
            // the configured value and the panel reported an unstretched cadence
            // while the poller was in fact stretching. Found against the live node.
            const tier = k.slice(0, -2);
            const effective = this.tierIntervalMs[tier] ?? this.poll[k];
            return [tier, {
              configuredMs: this.poll[k],
              effectiveMs: effective,
              stretched: effective > this.poll[k],
              lastRunMs: this.lastTierMs[tier] ?? null,
            }];
          })),
        cadenceStretched: Object.keys(this.poll).some((k) => k.endsWith('Ms') && (this.tierIntervalMs[k.slice(0, -2)] ?? 0) > this.poll[k]),
        staleDrops: this.staleDrops ?? 0,
        heavyTierSkips: this.skippedHeavy ?? 0,
        lastError: s.lastError,
        lastGoodAt: s.lastGoodAt,
        tiers: s.tierRunAt,
        lastTier: this.tierStats ?? null,
        inFlightTiers: [...this.inflightTiers],
        quality: this.quality.slice(),
      },
      series: this.seriesView(seriesRanges),
    };
    // Identity lives inside `sync` rather than beside it, so no renderer can draw
    // the bar without drawing which node it belongs to.
    out.sync.node = s.id;
    out.sync.nodeLabel = s.label;
    out.sync.endpoint = displayUrl(this.cfg.rpcUrl);   // no userinfo to viewers (audit 2026-09-16, L3)
    // One dense row for every state; `strip` is the ordered facts to draw in it.
    out.sync.strip = stripFacts(out.sync);
    return out;
  }

  // An explicitly empty `ranges` means "no series please". The SSE snapshot uses
  // that: chart history changes slowly, and re-sending every series on every
  // 1-second snapshot was most of the payload for almost no benefit.
  seriesView(ranges) {
    // Three cases, and the null one is the common one: undefined/null means
    // "use the standard windows", an empty object means "give me none" (the SSE
    // snapshot path), and a populated object overrides specific ranges.
    if (ranges && typeof ranges === 'object' && !Object.keys(ranges).length) return {};
    const R = { hour: 3600_000, hours6: 6 * 3600_000, day: 86400_000, ...(ranges ?? {}) };
    const now = Date.now();
    const out = {};
    const want = (name, spec) => {
      const r = this.history.ring(name);
      out[name] = Object.fromEntries(Object.entries(spec).map(([key, { field, agg, range, points }]) => [
        key,
        r.series(field, { since: now - (range ?? 3600_000), bucketMs: bucketFor(range ?? 3600_000, points), agg: agg ?? 'last' }),
      ]));
    };
    want('mempool', {
      hour: { field: 'count', range: R.hour },
      hours6: { field: 'count', range: R.hours6 },
      day: { field: 'count', range: R.day },
      bytesHour: { field: 'bytes', range: 3600_000 },
      usageHour: { field: 'usage', range: 3600_000 },
      feeHour: { field: 'totalFee', range: 3600_000, agg: 'last' },
      ingestHour: { field: 'ingestRate', range: 3600_000 },
    });
    want('net', {
      inHour: { field: 'inBps', range: 3600_000 },
      outHour: { field: 'outBps', range: 3600_000 },
      diskHour: { field: 'diskWriteBps', range: 3600_000 },
      inDay: { field: 'inBps', range: 86400_000 },
    });
    want('fees', {
      f1: { field: 'f1', range: 86400_000 },
      f2: { field: 'f2', range: 86400_000 },
      f6: { field: 'f6', range: 86400_000 },
      f24: { field: 'f24', range: 86400_000 },
      f144: { field: 'f144', range: 86400_000 },
      min: { field: 'mempoolmin', range: 86400_000 },
    });
    want('blocks', {
      fee: { field: 'totalfee', range: 86400_000, agg: 'last', points: 300 },
      size: { field: 'size', range: 86400_000, agg: 'last', points: 300 },
      txs: { field: 'txs', range: 86400_000, agg: 'last', points: 300 },
      gap: { field: 'gapSec', range: 86400_000, agg: 'last', points: 300 },
      p1: { field: 'p1', range: 86400_000, agg: 'last', points: 300 },
      p2: { field: 'p2', range: 86400_000, agg: 'last', points: 300 },
      p3: { field: 'p3', range: 86400_000, agg: 'last', points: 300 },
    });
    want('peers', {
      connections: { field: 'connections', range: 86400_000 },
      in: { field: 'in', range: 86400_000 },
      out: { field: 'out', range: 86400_000 },
      relay: { field: 'txRelayPeers', range: 86400_000 },
    });
    want('node', {
      tip: { field: 'blocks', range: 86400_000, agg: 'last' },
      difficulty: { field: 'difficulty', range: 86400_000 * 7, agg: 'avg', points: 200 },
      txRate: { field: 'txRate', range: 86400_000, agg: 'avg' },
      txouts: { field: 'txouts', range: 86400_000 * 7, agg: 'avg', points: 200 },
      disk: { field: 'sizeOnDisk', range: 86400_000, agg: 'last' },
    });
    want('txflow', {
      accepted: { field: 'accepted', range: 3600_000, agg: 'avg' },
      rejectPolicy: { field: 'rejectPolicy', range: 3600_000, agg: 'avg' },
      orphansHeld: { field: 'orphansHeld', range: 86400_000, agg: 'last' },
      orphansParked: { field: 'orphansParked', range: 86400_000, agg: 'last' },
      inFlight: { field: 'inFlight', range: 86400_000, agg: 'last' },
    });
    want('rpc', {
      latency: { field: 'latencyMs', range: 3600_000 },
      rate: { field: 'ratePerSec', range: 3600_000 },
    });
    return out;
  }

  async stop() {
    this.stopped = true;
    this.network?.stop();
    for (const t of this.tierTimers.values()) clearTimeout(t);
    if (this.logHealthTimer) clearInterval(this.logHealthTimer);
    if (this.tail) await this.tail.stop();
  }
}

function bucketFor(rangeMs, points = 240) {
  return Math.max(1000, Math.round(rangeMs / points / 1000) * 1000);
}

function range(from, to) {
  const out = [];
  for (let h = from; h <= to; h++) out.push(h);
  return out;
}

function chunkBy(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Turn the verbose mempool map into aggregates. Everything the feerate panel
// shows is derived here so the browser never receives 4,700 transactions.
//
// Field note (verified against the live node): this node's entries carry
// vsize, weight, time and fees.base only -- no depends, no ancestorcount, no
// modifiedfees, no prioritisefee. Anything needing those is reported absent
// rather than inferred.
// THE DENSE BLOCK (Viewer Mode 2; operator, 2026-09-11, with mempool.space's Goggles beside ours:
// "The official mempool goggles seem to have so much more detail ... improve information density").
// Mode 1 is fed the richest 400 transactions and one aggregate for the rest, which it cuts into
// ~100 equal squares -- the uniform field across the top of our board. This is the next block's
// worth of the pool, richest first, EVERY transaction: sizes, feerates and the full txid (for the hover, and a click into the explorer)
// (for the hover), about 3-5k entries and ~100 KB, served on its own endpoint and kept off the
// 1 Hz snapshot. Transactions with no fee reported cannot be ranked and are left out, counted.
export function denseBlock(raw, { blockVsize = 1_000_000 } = {}) {
  const list = [];
  let unranked = 0;
  for (const [txid, e] of Object.entries(raw ?? {})) {
    const vsize = typeof e?.vsize === 'number' ? e.vsize : (typeof e?.weight === 'number' ? Math.ceil(e.weight / 4) : 0);
    const fee = e?.fees && typeof e.fees.base === 'number' ? e.fees.base * 1e8 : null;
    if (!(vsize > 0) || fee == null) { unranked++; continue; }
    list.push([vsize, fee / vsize, txid]);
  }
  list.sort((a, b) => b[1] - a[1]);
  const v = [], r = [], id = [];
  let used = 0;
  for (const [vsize, rate, txid] of list) {
    if (used + vsize > blockVsize && used > 0) break;
    v.push(Math.round(vsize)); r.push(Math.round(rate * 100) / 100); id.push(String(txid));
    used += vsize;
  }
  return { at: Date.now(), blockVsize, n: v.length, vsize: used, poolCount: list.length + unranked, unranked, v, r, id };
}

export function summarizeMempool(raw) {
  const txs = Object.entries(raw);
  const n = txs.length;
  // Empty is a state with a shape of its own: `cells` must exist here too, or an empty
  // pool is indistinguishable from a pool that has not been polled yet -- and the client
  // would say "no detail yet" about a mempool that is genuinely, provably empty.
  if (!n) return { count: 0, hist: [], ageHist: [], scatter: [], cells: [], totalVsize: 0, totalFeeSat: 0, maxFeerate: 0, p50Feerate: 0, p90Feerate: 0, avgFeerate: 0, oldestSec: 0, pendingAncestors: null, replaceable: null };
  const nowSec = Date.now() / 1000;
  const feerates = new Float64Array(n);
  const ages = new Float64Array(n);
  const vsizes = new Float64Array(n);
  const fees = new Float64Array(n);
  let totalVsize = 0;
  let totalFeeSat = 0;
  let oldest = 0;
  let withFee = 0;
  let ageUnknown = 0;

  for (let i = 0; i < n; i++) {
    const e = txs[i][1] ?? {};
    const vsize = typeof e.vsize === 'number' ? e.vsize : (typeof e.weight === 'number' ? Math.ceil(e.weight / 4) : 0);
    const feeSat = e.fees && typeof e.fees.base === 'number' ? e.fees.base * 1e8 : null;
    vsizes[i] = vsize;
    totalVsize += vsize;
    if (feeSat != null) {
      fees[i] = feeSat;
      totalFeeSat += feeSat;
      feerates[i] = vsize > 0 ? feeSat / vsize : 0;
      withFee += 1;
    } else feerates[i] = NaN;
    // A time of 0 is NOT a timestamp. Measured 2026-09-11 on deploy-20260910ag:
    // 94 of 19,014 entries carried time = 0, which read as an age of ~20,707
    // days (since 1970), stretched the scatter's age axis to 56 years and
    // crushed every real transaction into one vertical line at its left edge.
    // Anything that cannot be a unix time is an UNKNOWN age: left out of the
    // age figures and counted, never charted as ancient.
    if (typeof e.time === 'number' && e.time > 1e9) {
      const age = Math.max(0, nowSec - e.time);
      ages[i] = age;
      if (age > oldest) oldest = age;
    } else {
      ages[i] = NaN;
      ageUnknown++;
    }
  }

  // Feerate histogram on a log axis: a linear one puts 95% of the mass in the
  // first bar and tells you nothing.
  const hist = histogramLog(feerates, { lo: 0.5, hi: 2000, buckets: 40 });
  const ageHist = histogramLinear(ages.filter((a) => !Number.isNaN(a)), { lo: 0, hi: Math.max(600, oldest), buckets: 30 });

  // Scatter, capped so a 17k-tx pool does not turn into a 17k-point canvas job.
  const cap = 1500;
  const stride = Math.max(1, Math.ceil(n / cap));
  const scatter = [];
  for (let i = 0; i < n; i += stride) {
    if (Number.isNaN(feerates[i]) || Number.isNaN(ages[i])) continue;
    scatter.push([Math.round(ages[i]), +feerates[i].toFixed(3), Math.round(vsizes[i])]);
  }

  const sorted = Float64Array.from(feerates.subarray(0, withFee)).sort();
  const sortedFeerates = sorted.length ? sorted : null;

  return {
    count: n,
    totalVsize,
    totalFeeSat: Math.round(totalFeeSat),
    avgFeerate: sortedFeerates ? round(sortedFeerates.reduce((a, b) => a + b, 0) / sortedFeerates.length, 3) : null,
    p50Feerate: sortedFeerates ? round(q(sortedFeerates, 0.5), 3) : null,
    p90Feerate: sortedFeerates ? round(q(sortedFeerates, 0.9), 3) : null,
    maxFeerate: sortedFeerates ? round(sortedFeerates[sortedFeerates.length - 1], 2) : null,
    avgVsize: Math.round(totalVsize / n),
    oldestSec: Math.round(oldest),
    ageUnknown,
    hist,
    ageHist,
    scatter,
    // Cells for the mempool treemap -- the same bounded, aggregate-tailed rule as the
    // block's own cells, so the two pictures are comparable rather than one of them
    // quietly hiding its long tail. Richest first, because the question this answers is
    // "who would make the next block, and who does not".
    cells: poolCells(vsizes, feerates, txs),
    // How many transactions the cells describe. getrawmempool is polled on its own tier,
    // so the live header count and the picture differ by whatever arrived in between;
    // naming that is a detail, hiding it makes 400 + 8,838 read as a bug next to a header
    // saying 6,359.
    cellCount: n,
    pendingAncestors: null, // not reported by this node's getrawmempool
    replaceable: null, // no "replaceable" flag in this node's entries
    // the blocks after the one being assembled, as the mempool stands (projectBlocks)
    projected: projectBlocks(vsizes, feerates, fees),
  };
}

// PROJECTED BLOCKS (operator, 2026-09-11: "Why can't we forecast at least one block ahead of
// current work, like mempool space app does?"). The whole mempool is read on the 20 s pool
// tier, so the blocks after the one being assembled can be projected from it: every
// transaction with a known fee, richest feerate first, cut into blocks of `blockVsize`
// (1,000,000 vB -- 4M weight units). The first block's worth is skipped: the node itself is
// assembling it (getblocktemplate, the "being built" card), and this sort is only an
// approximation of that. Then `count` blocks, each with its transaction count, size, fees,
// feerate range and median; everything beyond them is summed as `rest`. An inference, and
// labelled as one on the page: this node's getrawmempool carries no ancestor data, so a child
// paying for its parent is placed by its own feerate and can be projected a block late.
export function projectBlocks(vsizes, feerates, fees, { blockVsize = 1_000_000, skip = 1, count = 6 } = {}) {
  const idx = [];
  for (let i = 0; i < feerates.length; i++) if (Number.isFinite(feerates[i]) && vsizes[i] > 0) idx.push(i);
  idx.sort((a, b) => feerates[b] - feerates[a]);
  const done = [];
  let cur = null;
  const open = () => { cur = { n: 0, vsize: 0, feeSat: 0, rates: [] }; };
  open();
  let rest = null;
  for (const i of idx) {
    if (done.length >= skip + count) {
      rest = rest ?? { n: 0, vsize: 0, feeSat: 0, maxRate: feerates[i], minRate: feerates[i] };
      rest.n++; rest.vsize += vsizes[i]; rest.feeSat += fees[i]; rest.minRate = feerates[i];
      continue;
    }
    if (cur.n > 0 && cur.vsize + vsizes[i] > blockVsize) { done.push(cur); open(); if (done.length >= skip + count) { rest = { n: 1, vsize: vsizes[i], feeSat: fees[i], maxRate: feerates[i], minRate: feerates[i] }; continue; } }
    cur.n++; cur.vsize += vsizes[i]; cur.feeSat += fees[i]; cur.rates.push(feerates[i]);
  }
  if (cur.n && done.length < skip + count) done.push(cur);
  const r = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const shape = (b) => ({
    n: b.n, vsize: b.vsize, feeSat: Math.round(b.feeSat),
    maxRate: r(b.rates[0]), minRate: r(b.rates[b.rates.length - 1]),
    medianRate: r(b.rates[Math.floor((b.rates.length - 1) / 2)]),
  });
  return {
    blockVsize,
    skipped: done.length ? shape(done[0]) : null,
    blocks: done.slice(skip).map(shape),
    rest: rest ? { n: rest.n, vsize: rest.vsize, feeSat: Math.round(rest.feeSat), maxRate: r(rest.maxRate), minRate: r(rest.minRate), blocks: Math.ceil(rest.vsize / blockVsize) } : null,
  };
}

/**
 * Bounded cells for the mempool view, mirroring templateCells so the block picture and
 * the pool picture obey one rule: draw the richest `maxCells`, collapse everything else
 * into ONE aggregate cell that carries their weight and their weighted-mean feerate.
 * Dropping the tail instead would make a crowded pool look like the transactions that
 * matter, which is the opposite of what the view is for.
 */
function poolCells(vsizes, feerates, entries, { maxCells = 400, coverPct = 0.97 } = {}) {
  const list = [];
  for (let i = 0; i < vsizes.length; i++) {
    const vbytes = vsizes[i];
    const rate = feerates[i];
    if (!Number.isFinite(vbytes) || vbytes <= 0 || !Number.isFinite(rate)) continue;
    list.push({ vbytes: Math.round(vbytes), rate: round(rate, 2), txid: entries[i]?.[0] ?? null });
  }
  list.sort((a, b) => b.rate - a.rate);
  const total = list.reduce((n, c) => n + c.vbytes, 0);
  const want = total * coverPct;
  const cells = [];
  let acc = 0;
  for (const c of list) {
    if (cells.length >= maxCells || acc >= want) break;
    cells.push(c);
    acc += c.vbytes;
  }
  const tail = list.slice(cells.length);
  poolCells.tailCount = tail.length;
  if (tail.length) {
    const w = tail.reduce((n, c) => n + c.vbytes, 0);
    const r = tail.reduce((n, c) => n + c.rate * c.vbytes, 0) / Math.max(1, w);
    cells.push({ vbytes: w, rate: round(r, 2), aggregate: tail.length, strata: tailStrata(tail) });
  }
  return cells;
}

// THE TAIL IN COLOUR (operator, 2026-09-11: "why can't we do 128 colors in simple mode as well?").
// Measured that day: the aggregate held 17,118 transactions and 96% of the Simple board's space
// under ONE weighted-mean feerate (0.49 sat/vB), so however many colours the palette had, almost
// the whole board was one of them. The cell stays ONE aggregate -- the 2D maps and everything
// that counts cells are unchanged -- and carries its make-up: the tail (richest first, as sorted
// above) grouped in geometric feerate steps as wide as the 3D palette's bands (from 0.1 sat/vB,
// ~8% a step; public/js/feepalette.js), merged down to STRATA_MAX by joining the lightest
// neighbouring pair. The 3D board colours its equal pieces from these; nothing is claimed about
// any individual transaction.
const STRATA_MAX = 32;
const STRATUM_STEP = Math.log(2000 / 0.1) / 126;
function tailStrata(tail) {
  const key = (rate) => (rate < 0.1 ? -1 : Math.floor(Math.log(rate / 0.1) / STRATUM_STEP + 1e-9));
  const out = [];
  for (const c of tail) {
    const k = key(c.rate);
    const last = out.at(-1);
    if (last && last.k === k) { last.vbytes += c.vbytes; last.fee += c.rate * c.vbytes; last.n++; }
    else out.push({ k, vbytes: c.vbytes, fee: c.rate * c.vbytes, n: 1 });
  }
  while (out.length > STRATA_MAX) {
    let best = 0;
    for (let i = 1; i < out.length - 1; i++) if (out[i].vbytes + out[i + 1].vbytes < out[best].vbytes + out[best + 1].vbytes) best = i;
    const a = out[best], b = out[best + 1];
    out.splice(best, 2, { k: a.k, vbytes: a.vbytes + b.vbytes, fee: a.fee + b.fee, n: a.n + b.n });
  }
  return out.map((s) => ({ vbytes: s.vbytes, rate: round(s.fee / Math.max(1, s.vbytes), 2), n: s.n }));
}

function q(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i];
}

function round(v, dp = 2) {
  const f = 10 ** dp;
  return v == null ? null : Math.round(v * f) / f;
}

function histogramLog(values, { lo, hi, buckets }) {
  const l0 = Math.log10(lo);
  const l1 = Math.log10(hi);
  const step = (l1 - l0) / buckets;
  const counts = new Array(buckets).fill(0);
  let under = 0;
  let over = 0;
  for (const v of values) {
    if (Number.isNaN(v) || v <= 0) { under += 1; continue; }
    const b = Math.floor((Math.log10(Math.max(lo, v)) - l0) / step);
    if (b < 0) under += 1;
    else if (b >= buckets) over += 1;
    else counts[b] += 1;
  }
  return {
    kind: 'log',
    lo, hi, buckets,
    edges: counts.map((_, i) => round(10 ** (l0 + step * i), 3)),
    counts,
    under, over,
  };
}

function histogramLinear(values, { lo, hi, buckets }) {
  const step = (hi - lo) / buckets;
  const counts = new Array(buckets).fill(0);
  for (const v of values) {
    const b = Math.floor((v - lo) / step);
    if (b < 0 || b >= buckets) continue;
    counts[b] += 1;
  }
  return { kind: 'linear', lo, hi, buckets, step, edges: counts.map((_, i) => Math.round(lo + step * i)), counts };
}

// PER-PEER RATES (2026-09-11, operator: "Doesn't the node's rpc pull more info for peers
// now?"). getpeerinfo publishes cumulative bytessent / bytesrecv per connection -- summing
// to 99.99% of getnettotals on this build (MEASUREMENTS 27) -- so a rate is the change in
// one peer's counters between two samples over the time between them. A peer seen for the
// first time, or whose counter went backwards (an id reused by a new connection), has no
// rate yet: null, not zero. A second read within a second (the mid and rare tiers can land
// together) keeps the last rate rather than dividing by almost nothing.
export function withPeerRates(rows, prev = new Map(), now = Date.now()) {
  const next = new Map();
  const out = rows.map((p) => {
    const key = String(p.id);
    const was = prev.get(key);
    if (was && now - was.t < 1000) {
      next.set(key, was);
      return { ...p, recvRate: was.recvRate ?? null, sentRate: was.sentRate ?? null };
    }
    let recvRate = null, sentRate = null;
    if (was) {
      const dt = (now - was.t) / 1000;
      if (Number.isFinite(p.bytesrecv) && Number.isFinite(was.recv) && p.bytesrecv >= was.recv) recvRate = (p.bytesrecv - was.recv) / dt;
      if (Number.isFinite(p.bytessent) && Number.isFinite(was.sent) && p.bytessent >= was.sent) sentRate = (p.bytessent - was.sent) / dt;
    }
    next.set(key, { t: now, recv: p.bytesrecv, sent: p.bytessent, recvRate, sentRate });
    return { ...p, recvRate, sentRate };
  });
  return { rows: out, prev: next };
}
