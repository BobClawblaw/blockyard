// THE NETWORK OVER A WEEK AND A YEAR, from this node alone (operator, 2026-09-15, with a
// mempool.space screenshot of its mining dashboard: "Why don't we have this view in our mining
// tab?" -- "Do it", then the adjustments table: "add this too"). Nothing here is fetched from
// anyone but the node:
//
//   rewards      the last 144 blocks' subsidy, fees and transaction counts -- getblockstats, one
//                call per block, batched, rolled forward a block at a time
//   epochs       the start of each difficulty period back a year: its height, time and difficulty
//                (getblockhash + getblockheader, two in-memory lookups per epoch) -- the
//                adjustment table, the estimate for the current period, the chart's steps
//   samples      a block every 144 back a year, with its time and difficulty: the daily hashrate
//                estimate is difficulty * 2^32 / the mean interval across the day
//   pools        the coinbase of every block of the last week, attributed the way the ledger
//                does it (decodeCoinbase + the curated pool map) -- a week is ~1000 blocks at
//                two calls each, so it fills in the background at eight blocks every few seconds
//                and the view says how far it has got
//
// The arithmetic is in pure functions above the class, which is what the tests hold.
import { decodeCoinbase, matchPool, aliasFor, tagFingerprint } from './mining.js';

export const EPOCH = 2016;
export const TARGET_SPACING = 600;
export const HALVING_INTERVAL = 210_000;
const DAY_BLOCKS = 144;

/** Sum a window of getblockstats rows into the reward figures. Satoshis in, satoshis out. */
export function rewardStats(rows) {
  const r = rows.filter((x) => x && Number.isFinite(x.totalfee) && Number.isFinite(x.subsidy));
  if (!r.length) return { blocks: 0, minersRewardSat: 0, avgBlockFeeSat: null, avgTxFeeSat: null, txs: 0, from: null, to: null };
  const fees = r.reduce((a, x) => a + x.totalfee, 0);
  const subsidy = r.reduce((a, x) => a + x.subsidy, 0);
  const txs = r.reduce((a, x) => a + Math.max(0, (x.txs ?? 1) - 1), 0);   // the coinbase pays no fee
  const hs = r.map((x) => x.height);
  return {
    blocks: r.length,
    minersRewardSat: fees + subsidy,
    avgBlockFeeSat: Math.round(fees / r.length),
    avgTxFeeSat: txs ? Math.round(fees / txs) : null,
    txs,
    from: Math.min(...hs), to: Math.max(...hs),
  };
}

/**
 * Where the current difficulty period stands and what the next adjustment looks like, from the
 * tip's height and time, the period's first block time, and the two difficulties.
 * The estimate is what Core would compute if the rest of the period kept the pace so far,
 * clamped to the protocol's factor-of-four bounds. Before ten blocks there is no pace to speak
 * of, so the estimate is null.
 */
export function difficultyEstimate({ height, tipTime, epochStartTime, difficulty, prevDifficulty = null, now = Date.now() }) {
  if (!Number.isFinite(height) || !Number.isFinite(tipTime) || !Number.isFinite(epochStartTime)) return null;
  const epochStart = height - (height % EPOCH);
  const into = height - epochStart;                       // blocks mined since the period's first
  const remaining = EPOCH - into;
  const elapsed = Math.max(1, tipTime - epochStartTime);   // seconds over `into` intervals
  const pace = into >= 10 ? elapsed / into : null;
  let estimatePct = null;
  if (pace != null) {
    const projected = pace * EPOCH;
    const factor = Math.max(0.25, Math.min(4, (EPOCH * TARGET_SPACING) / projected));
    estimatePct = (factor - 1) * 100;
  }
  const previousPct = Number.isFinite(prevDifficulty) && prevDifficulty > 0 && Number.isFinite(difficulty) ? (difficulty / prevDifficulty - 1) * 100 : null;
  const etaSec = remaining * (pace ?? TARGET_SPACING);
  return { epochStart, into, remaining, elapsedSec: elapsed, paceSec: pace, estimatePct, previousPct, etaSec, at: now + etaSec * 1000 };
}

/** The next halving: its height, the blocks to go, and when at the target spacing. */
export function halvingInfo(height, { now = Date.now() } = {}) {
  if (!Number.isFinite(height)) return null;
  const nextHeight = (Math.floor(height / HALVING_INTERVAL) + 1) * HALVING_INTERVAL;
  const blocksLeft = nextHeight - height;
  const etaSec = blocksLeft * TARGET_SPACING;
  return { nextHeight, blocksLeft, etaSec, at: now + etaSec * 1000, era: Math.floor(height / HALVING_INTERVAL) };
}

/**
 * Hashrate estimates from block samples ({ height, time, difficulty }), any spacing: between two
 * consecutive samples the mean interval is (t1 - t0) / (h1 - h0), and the hashrate that produces
 * one block per that interval at the later sample's difficulty is difficulty * 2^32 / interval.
 * Ascending by height; a sample with a non-positive interval (clock skew) is skipped.
 */
export function hashrateSeries(samples) {
  const s = [...samples].filter((x) => x && Number.isFinite(x.height) && Number.isFinite(x.time) && Number.isFinite(x.difficulty)).sort((a, b) => a.height - b.height);
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const dh = s[i].height - s[i - 1].height, dt = s[i].time - s[i - 1].time;
    if (dh <= 0 || dt <= 0) continue;
    const interval = dt / dh;
    out.push({ t: s[i].time * 1000, height: s[i].height, hashrate: s[i].difficulty * 4294967296 / interval, difficulty: s[i].difficulty });
  }
  return out;
}

/** The adjustment table: each epoch start against the one before it. Newest first. */
export function adjustments(epochs) {
  const e = [...epochs].filter((x) => x && Number.isFinite(x.height) && Number.isFinite(x.difficulty)).sort((a, b) => a.height - b.height);
  const out = [];
  for (let i = 1; i < e.length; i++) {
    out.push({ height: e[i].height, time: e[i].time, difficulty: e[i].difficulty, changePct: e[i - 1].difficulty > 0 ? (e[i].difficulty / e[i - 1].difficulty - 1) * 100 : null });
  }
  return out.reverse();
}

/**
 * Pool shares over the window: blocks inside it grouped by pool, share of the window, and the
 * window's luck -- the blocks found against the number the target spacing would give.
 * rows: { height, time, poolKey, name, labelled }.
 */
export function poolShares(rows, { now = Date.now(), windowSec = 7 * 86_400 } = {}) {
  const since = now / 1000 - windowSec;
  const inWin = rows.filter((r) => r && Number.isFinite(r.time) && r.time >= since);
  const by = new Map();
  for (const r of inWin) {
    const k = r.poolKey ?? 'unknown';
    const e = by.get(k) ?? { key: k, name: r.name ?? k, labelled: !!r.labelled, blocks: 0 };
    e.blocks += 1;
    by.set(k, e);
  }
  const pools = [...by.values()].sort((a, b) => b.blocks - a.blocks || a.name.localeCompare(b.name));
  for (const p of pools) p.sharePct = inWin.length ? (p.blocks / inWin.length) * 100 : 0;
  // luck against the span actually covered: while the week is still being read, the oldest
  // block read bounds it, so a half-read week is not reported as half the luck
  const oldest = inWin.length ? Math.min(...inWin.map((r) => r.time)) : null;
  const spanSec = oldest == null ? windowSec : Math.min(windowSec, Math.max(TARGET_SPACING, now / 1000 - oldest));
  const expected = spanSec / TARGET_SPACING;
  return { blocks: inWin.length, expected, spanSec, luckPct: inWin.length ? (inWin.length / expected) * 100 : null, pools, count: pools.length, windowSec };
}

// ---------------------------------------------------------------------------- the collector
export class NetworkStats {
  /**
   * @param {object} o
   * @param {{batch: Function}} o.rpc       the node's RPC client (batch(calls, opts))
   * @param {Function} [o.log]
   * @param {Function} [o.poolMap]          () => the curated coinbase map, or null
   * @param {Function} [o.aliases]          () => the operator's alias table, or null
   * @param {Function} [o.now]
   */
  constructor({ rpc, log = () => {}, poolMap = () => null, aliases = () => null, now = Date.now, windowDays = 7, sampleDays = 366, rewardBlocks = 144 } = {}) {
    this.rpc = rpc; this.log = log; this.poolMapOf = poolMap; this.aliasesOf = aliases; this.now = now;
    this.windowDays = windowDays; this.sampleDays = sampleDays; this.rewardBlocks = rewardBlocks;
    this.rewards = new Map();     // height -> { height, time, totalfee, subsidy, txs }
    this.epochs = new Map();      // epoch start height -> { height, time, difficulty }
    this.samples = new Map();     // sample height -> { height, time, difficulty }
    this.pools = new Map();       // height -> { height, time, poolKey, name, labelled, tagText }
    this.tip = null; this.tipTime = null; this.difficulty = null; this.networkHashPs = null;
    this.busy = false; this.stopped = false; this.lastError = null; this.at = null;
    this.poolTimer = null; this.poolFilling = false; this.poolTodo = [];
  }

  stop() { this.stopped = true; if (this.poolTimer) clearTimeout(this.poolTimer); }

  /** Called by the monitor whenever fresh chain info lands; cheap when nothing changed. */
  async refresh(chainInfo) {
    if (this.stopped || this.busy || !chainInfo || !Number.isFinite(chainInfo.blocks)) return;
    if (chainInfo.initialblockdownload === true) return;
    const tip = chainInfo.blocks;
    this.busy = true;
    try {
      const tipChanged = tip !== this.tip;
      this.tip = tip; this.difficulty = chainInfo.difficulty ?? this.difficulty;
      // getblockchaininfo carries the tip's time on Core 24+; older builds get one header read
      if (Number.isFinite(chainInfo.time)) this.tipTime = chainInfo.time;
      else if (tipChanged || this.tipTime == null) { const h = await this.headers([tip]); this.tipTime = h.get(tip)?.time ?? this.tipTime; }
      if (tipChanged || this.networkHashPs == null) {
        const [hr] = await this.rpc.batch([{ method: 'getnetworkhashps', params: [DAY_BLOCKS * this.windowDays] }], { priority: 6 });
        if (hr?.ok) this.networkHashPs = hr.result;
      }
      await this.ensureRewards(tip);
      await this.ensureEpochs(tip);
      await this.ensureSamples(tip);
      this.queuePools(tip);
      this.at = this.now();
      this.lastError = null;
    } catch (err) {
      this.lastError = err?.message ?? String(err);
    } finally {
      this.busy = false;
    }
  }

  async ensureRewards(tip) {
    const want = [];
    for (let h = tip; h > tip - this.rewardBlocks && h > 0; h--) if (!this.rewards.has(h)) want.push(h);
    for (let i = 0; i < want.length; i += 24) {
      const chunk = want.slice(i, i + 24);
      const res = await this.rpc.batch(chunk.map((h) => ({ method: 'getblockstats', params: [h, ['height', 'time', 'totalfee', 'subsidy', 'txs']] })), { priority: 6, heavy: true });
      res.forEach((r, k) => { if (r?.ok && r.result) this.rewards.set(chunk[k], r.result); });
    }
    for (const h of [...this.rewards.keys()]) if (h <= tip - this.rewardBlocks - 10) this.rewards.delete(h);
  }

  /** height -> { height, time, difficulty } for a list of heights, two batched in-memory lookups each. */
  async headers(heights) {
    const out = new Map();
    for (let i = 0; i < heights.length; i += 50) {
      const chunk = heights.slice(i, i + 50);
      const hashes = await this.rpc.batch(chunk.map((h) => ({ method: 'getblockhash', params: [h] })), { priority: 6 });
      const withHash = chunk.map((h, k) => ({ h, hash: hashes[k]?.ok ? hashes[k].result : null })).filter((x) => x.hash);
      if (!withHash.length) continue;
      const hdrs = await this.rpc.batch(withHash.map((x) => ({ method: 'getblockheader', params: [x.hash] })), { priority: 6 });
      hdrs.forEach((r, k) => { if (r?.ok && r.result) out.set(withHash[k].h, { height: withHash[k].h, time: r.result.time, difficulty: r.result.difficulty }); });
    }
    return out;
  }

  async ensureEpochs(tip) {
    const epochStart = tip - (tip % EPOCH);
    const perYear = Math.ceil((this.sampleDays * DAY_BLOCKS) / EPOCH) + 1;
    const want = [];
    for (let i = 0; i <= perYear; i++) { const h = epochStart - i * EPOCH; if (h >= 0 && !this.epochs.has(h)) want.push(h); }
    // the block before the current period too, for the previous adjustment's base difficulty
    if (epochStart > 0 && !this.epochs.has(epochStart - 1)) want.push(epochStart - 1);
    if (!want.length) return;
    for (const [h, v] of await this.headers(want)) this.epochs.set(h, v);
  }

  async ensureSamples(tip) {
    const anchor = tip - (tip % DAY_BLOCKS);
    const want = [];
    for (let i = 0; i <= this.sampleDays; i++) { const h = anchor - i * DAY_BLOCKS; if (h >= 0 && !this.samples.has(h)) want.push(h); }
    if (want.length) for (const [h, v] of await this.headers(want)) this.samples.set(h, v);
    for (const h of [...this.samples.keys()]) if (h < anchor - (this.sampleDays + 2) * DAY_BLOCKS) this.samples.delete(h);
  }

  // ---- the week of coinbases, in the background
  queuePools(tip) {
    const floor = Math.max(1, tip - Math.ceil(this.windowDays * DAY_BLOCKS * 1.15));   // a little past a week, then the view trims by time
    const todo = [];
    for (let h = tip; h >= floor; h--) if (!this.pools.has(h)) todo.push(h);
    this.poolTodo = todo;
    for (const h of [...this.pools.keys()]) if (h < floor - 50) this.pools.delete(h);
    if (todo.length && !this.poolFilling) this.pumpPools();
  }

  pumpPools() {
    if (this.stopped) return;
    this.poolFilling = true;
    const chunk = this.poolTodo.splice(0, 8);
    if (!chunk.length) { this.poolFilling = false; return; }
    this.fetchPools(chunk)
      .catch((err) => { this.lastError = `pools: ${err?.message ?? err}`; this.poolTodo.unshift(...chunk); })
      .finally(() => {
        if (this.stopped) return;
        this.poolTimer = setTimeout(() => this.pumpPools(), this.lastError ? 15_000 : 3_000);
        this.poolTimer.unref?.();
      });
  }

  async fetchPools(heights) {
    const hashes = await this.rpc.batch(heights.map((h) => ({ method: 'getblockhash', params: [h] })), { priority: 7 });
    const withHash = heights.map((h, k) => ({ h, hash: hashes[k]?.ok ? hashes[k].result : null })).filter((x) => x.hash);
    const blocks = await this.rpc.batch(withHash.map((x) => ({ method: 'getblock', params: [x.hash, 1] })), { priority: 7, heavy: true });
    const withCb = withHash.map((x, k) => ({ ...x, block: blocks[k]?.ok ? blocks[k].result : null })).filter((x) => x.block?.tx?.length);
    const cbs = await this.rpc.batch(withCb.map((x) => ({ method: 'getrawtransaction', params: [x.block.tx[0], 2, x.hash] })), { priority: 7, heavy: true });
    const map = this.poolMapOf(), aliases = this.aliasesOf();
    withCb.forEach((x, k) => {
      const tx = cbs[k]?.ok ? cbs[k].result : null;
      const hex = tx?.vin?.[0]?.coinbase ?? '';
      const decoded = decodeCoinbase(hex);
      const tagText = decoded?.tagText ?? '';
      const matched = matchPool(map, { tagText, rawHex: hex });
      const rawKey = decoded?.tag ? decoded.tag : tagFingerprint(tagText);   // the ledger's own key rule (minerRow)
      const key = matched ? matched.key : rawKey;
      const name = matched ? matched.name : (aliasFor(aliases, rawKey) ?? rawKey);   // the ledger shows an unlabelled pool by its key
      this.pools.set(x.h, { height: x.h, time: x.block.time, poolKey: key, name, labelled: !!matched, tagText });
    });
    this.at = this.now();
  }

  view() {
    const now = this.now();
    const tip = this.tip;
    const epochStart = tip != null ? tip - (tip % EPOCH) : null;
    const cur = epochStart != null ? this.epochs.get(epochStart) : null;
    const prev = epochStart != null ? this.epochs.get(epochStart - 1) : null;
    const est = tip != null && cur ? difficultyEstimate({ height: tip, tipTime: this.tipTime, epochStartTime: cur.time, difficulty: this.difficulty, prevDifficulty: prev?.difficulty ?? null, now }) : null;
    const series = hashrateSeries([...this.samples.values(), ...(tip != null && this.tipTime != null && this.difficulty != null ? [{ height: tip, time: this.tipTime, difficulty: this.difficulty }] : [])]);
    const shares = poolShares([...this.pools.values()], { now, windowSec: this.windowDays * 86_400 });
    const windowFloor = tip != null ? tip - Math.ceil(this.windowDays * DAY_BLOCKS * 1.15) : null;
    return {
      at: this.at, lastError: this.lastError, tip,
      rewards: rewardStats([...this.rewards.values()]),
      difficulty: this.difficulty,
      adjustment: est,
      halving: tip != null ? halvingInfo(tip, { now }) : null,
      adjustments: adjustments([...this.epochs.values()].filter((e) => e.height % EPOCH === 0)).slice(0, 12),
      hashrate: { networkHashPs: this.networkHashPs, windowBlocks: DAY_BLOCKS * this.windowDays, series },
      pools: { ...shares, filled: this.pools.size, todo: this.poolTodo.length, filling: this.poolFilling, floor: windowFloor },
    };
  }
}
