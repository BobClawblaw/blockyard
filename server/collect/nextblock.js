// The block being built right now, and the packages inside it.
//
// This module is pure: it takes the reply of `getblocktemplate` and turns it into the
// numbers the block-flow's "next block" card and the Goggles charts need. No I/O, so the
// cluster math is testable against a frozen real reply.
//
// WHAT THIS REPLACED, and a claim I got wrong. The Mining page used to say Goggles-style
// cluster analysis was impossible on this node, because `getrawmempool` verbose on this
// build returns `vsize` and `fees.base` with no `depends` and no `ancestorcount`. That
// half was measured; the conclusion drawn from it was not. The dependency graph IS
// published -- by `getblocktemplate`, where every selected transaction carries
// `depends: [indices into this same array]`. Measured 2026-09-09 on height 966265:
//   1,496 transactions selected, 1,475 ancestor packages, 19 of them multi-transaction,
//   40 transactions (2.7%) inside a package, largest package 3 transactions.
//   One package: child at 38.1 sat/vB, parent at 0.5 sat/vB, package feerate 10.93
//   sat/vB -- a textbook child-pays-for-parent, visible rather than inferred.
//
// COST, which is why it is polled once a minute and never during initial download:
//   getblocktemplate(rules:[segwit]) = 1,790,010 bytes and 1.29-1.48 s per call on this
//   node, whose RPC server serves one connection at a time on one thread. That is the
//   node's time, not ours, so the caller owns the cadence and the coalescing; and the
//   `data` field (full transaction hex, the reason for the 1.79 MB) is dropped at the
//   door -- nothing downstream reads it, and keeping it would put megabytes in every
//   snapshot frame.

const VBYTES = 4;                       // weight units per virtual byte

/** sat/vB of one selected transaction, or null when it cannot be computed. */
function feeRate(tx) {
  const w = tx?.weight;
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(tx?.fee)) return null;
  return +(tx.fee / (w / VBYTES)).toFixed(2);
}

const pctOf = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

/**
 * The header numbers for the next-block card, plus a fixed-bucket feerate histogram so
 * 1,496 transactions never have to travel to the browser.
 */
export function summarizeTemplate(t, { at = Date.now(), previous = null } = {}) {
  const txs = Array.isArray(t?.transactions) ? t.transactions : [];
  const rates = txs.map(feeRate).filter((v) => v != null).sort((a, b) => a - b);
  const weight = txs.reduce((n, x) => n + (Number.isFinite(x?.weight) ? x.weight : 0), 0);
  const limit = Number.isFinite(t?.weightlimit) && t.weightlimit > 0 ? t.weightlimit : 4_000_000;
  const fees = txs.reduce((n, x) => n + (Number.isFinite(x?.fee) ? x.fee : 0), 0);
  return {
    height: t?.height ?? null,
    previous: t?.previousblockhash ?? previous,
    txCount: txs.length,
    weight,
    weightLimit: limit,
    weightPct: +((100 * weight) / limit).toFixed(1),
    totalFeesSat: fees,
    coinbaseSat: Number.isFinite(t?.coinbasevalue) ? t.coinbasevalue : null,
    feeRate: {
      min: rates[0] ?? null,
      p50: pctOf(rates, 0.5),
      p75: pctOf(rates, 0.75),
      p90: pctOf(rates, 0.9),
      max: rates[rates.length - 1] ?? null,
      median: rates.length % 2 ? rates[(rates.length - 1) / 2] : (rates[rates.length / 2 - 1] + rates[rates.length / 2]) / 2,
    },
    // Log buckets from 0.1 to 1000 sat/vB. They carry the WEIGHT in each bucket, not
    // just the count, because the useful question -- "what feerate still gets into the
    // next block?" -- is about weight, and a histogram of counts cannot answer it.
    feeRateHistogram: bucketize(txs.map((t) => ({ rate: feeRate(t), weight: Number.isFinite(t?.weight) ? t.weight : 0 }))),
    mintime: t?.mintime ?? null,
    bits: t?.bits ?? null,
    sigopLimit: t?.sigoplimit ?? null,
    sizeLimit: t?.sizelimit ?? null,
    version: t?.version ?? null,
    signal: t?.vbavailable && Object.keys(t.vbavailable).length
      ? Object.entries(t.vbavailable).map(([k, v]) => ({ bit: k, available: v, required: (t.vbrequired ?? 0) & (1 << Number(k)) ? 1 : 0 }))
      : null,
    at,
  };
}

const BUCKET_EDGES = [0.1, 0.5, 1, 2, 3, 4, 6, 8, 12, 20, 30, 50, 100, 250, 1000];

function bucketize(txs) {
  const out = BUCKET_EDGES.map((hi, i) => ({ hi, lo: i ? BUCKET_EDGES[i - 1] : 0, n: 0, weight: 0 }));
  for (const t of txs) {
    if (t.rate == null) continue;
    const i = BUCKET_EDGES.findIndex((hi) => t.rate <= hi);
    const b = out[i < 0 ? out.length - 1 : i];
    b.n++;
    b.weight += t.weight;
  }
  return out;
}

/**
 * What the next block can still take, and what spills past it.
 *
 * Walk the selected transactions from the highest feerate down until the remaining
 * weight is gone; the bucket it runs out in is the marginal rate -- the thing a wallet
 * actually needs to know. Anything below that is the spill, and the spill has to fit in
 * a later block, which is where the ghost cards get their content.
 *
 * Everything here is arithmetic on what the node reported. `estimate: true` marks the
 * forward-looking numbers, because "the backlog is about 1.3 blocks deep" is a shape of
 * the queue, not a claim that anyone is building block 3 from here.
 */
export function blockEconomy({ template, mempool, avgWeightMined = null, maxAhead = 3 } = {}) {
  const limit = Number.isFinite(template?.weightLimit) && template.weightLimit > 0 ? template.weightLimit : 4_000_000;
  const used = Number.isFinite(template?.weight) ? template.weight : 0;
  const remaining = Math.max(0, limit - used);
  const buckets = (template?.feeRateHistogram ?? []).slice().reverse();   // richest first

  let marginal = null;
  let spillWeight = 0;
  let spillCount = 0;
  let acc = 0;
  for (const b of buckets) {
    if (!b?.n) continue;
    if (acc + b.weight <= remaining) { acc += b.weight; continue; }
    marginal = { rate: b.hi, lo: b.lo, bandUnresolved: true };
    spillWeight += (b.weight - Math.max(0, remaining - acc)) + 0;
    spillCount += b.n;
    break;
  }
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (!b?.n) continue;
    if (marginal && b.hi >= marginal.rate) continue;
    spillWeight += b.weight;
    spillCount += b.n;
  }
  if (marginal == null && remaining > 0) marginal = { rate: null, bandUnresolved: false, note: 'the template did not fill the block' };

  // The queue, in blocks. getmempoolinfo.bytes is serialized bytes, and a mined block
  // is ~1M vB, so the ratio is honest as an order of magnitude and no more precise than
  // that -- which the card says.
  const poolBytes = Number.isFinite(mempool?.bytes) ? mempool.bytes : null;
  const blockBytes = avgWeightMined != null ? avgWeightMined / 4 : 1_000_000;
  const fitsNext = poolBytes != null ? Math.min(1, (remaining / 4) / Math.max(1, poolBytes)) : null;
  const depth = poolBytes != null ? poolBytes / blockBytes : null;

  const ahead = [];
  for (let k = 2; k <= maxAhead + 1; k++) {
    const leftAfterNext = poolBytes != null ? Math.max(0, poolBytes - remaining / 4) : null;
    const bytesHere = leftAfterNext == null ? null : Math.min(blockBytes, leftAfterNext - (k - 2) * blockBytes > 0 ? leftAfterNext - (k - 2) * blockBytes : 0);
    ahead.push({
      offset: k,
      estimate: true,
      assembled: false,
      bytes: bytesHere && bytesHere > 0 ? Math.round(bytesHere) : null,
      spillRate: marginal?.rate ?? null,
    });
  }

  return {
    remainingWeight: Math.round(remaining),
    remainingPct: +((100 * remaining) / limit).toFixed(1),
    marginal,
    spillCount,
    spillWeight: Math.round(spillWeight),
    poolBytes,
    poolFitsNextPct: fitsNext != null ? +(100 * fitsNext).toFixed(1) : null,
    backlogBlocks: depth != null ? +depth.toFixed(2) : null,
    blockBytesEstimate: Math.round(blockBytes),
    ahead,
    note: 'marginal and spill come from the node\'s own template selection; the queue depth is getmempoolinfo.bytes against ~1M vB per block, which is an order of magnitude, not a schedule.',
  };
}

/**
 * Cells for the block visualiser: one entry per transaction, sized by vbytes and
 * coloured by its own feerate, richest first.
 *
 * Bounded, because a template holds ~1,500 transactions and a browser cannot draw that
 * usefully: cells are kept until they cover `coverPct` of the selected weight and the
 * rest becomes ONE aggregate cell. The aggregate is labelled as an aggregate rather than
 * dropped -- a picture that quietly omits a fifth of the weight is a picture of
 * something else. Richest-first is not styling: it is the rule the miner used, and the
 * cut where the block runs out is only visible in that order.
 */
export function templateCells(txs, { maxCells = 400, coverPct = 0.97 } = {}) {
  const list = (txs ?? [])
    .map((t) => ({ vbytes: Math.max(1, Math.round((Number(t.weight) || 0) / 4)), rate: feeRate(t), txid: t.txid ?? t.hash ?? null }))
    .filter((c) => Number.isFinite(c.vbytes) && c.rate != null)
    .sort((a, b) => b.rate - a.rate);

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
  if (tail.length) {
    const w = tail.reduce((n, c) => n + c.vbytes, 0);
    const r = tail.reduce((n, c) => n + c.rate * c.vbytes, 0) / Math.max(1, w);
    cells.push({ vbytes: w, rate: +r.toFixed(2), aggregate: tail.length });
  }
  return { cells: cells.sort((a, b) => b.rate - a.rate), totalVbytes: total, tailCount: tail.length };
}

/**
 * Ancestor packages -- what Goggles calls clusters -- from `depends`.
 *
 * `depends` entries are indices into the same `transactions` array, measured
 * ('depends': [6] on a transaction whose own position is higher). A package is a root and
 * everything reachable from it through children. Package feerate is the whole package's
 * fees over the whole package's weight, which is the only number that means anything for
 * a child paying for a parent: the child's own 38 sat/vB says nothing about the chain
 * until the parent's 0.5 is folded in and the answer becomes 10.93.
 */
export function packagesFromTemplate(txs, { keepTop = 20 } = {}) {
  const list = Array.isArray(txs) ? txs : [];
  const n = list.length;
  const children = new Map();
  for (let i = 0; i < n; i++) {
    for (const d of list[i]?.depends ?? []) {
      if (Number.isInteger(d) && d >= 0 && d < n) {
        if (!children.has(d)) children.set(d, []);
        children.get(d).push(i);
      }
    }
  }
  const seen = new Set();
  const packs = [];
  for (let i = 0; i < n; i++) {
    if (seen.has(i)) continue;
    const stack = [i];
    const members = [];
    seen.add(i);
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      for (const c of children.get(cur) ?? []) if (!seen.has(c)) { seen.add(c); stack.push(c); }
    }
    packs.push(members);
  }

  const described = packs.map((members) => {
    const txs2 = members.map((i) => list[i]).filter(Boolean);
    const fee = txs2.reduce((x, t) => x + (Number.isFinite(t.fee) ? t.fee : 0), 0);
    const weight = txs2.reduce((x, t) => x + (Number.isFinite(t.weight) ? t.weight : 0), 0);
    const rates = txs2.map(feeRate).filter((v) => v != null);
    return {
      size: members.length,
      feesSat: fee,
      weight,
      packageFeeRate: weight > 0 ? +(fee / (weight / VBYTES)).toFixed(2) : null,
      childRate: rates.length ? Math.max(...rates) : null,
      parentRate: rates.length ? Math.min(...rates) : null,
      // The thing a human looks at first: does the child carry the parent?
      cpfp: members.length > 1 && rates.length > 1 && Math.max(...rates) > Math.min(...rates) * 2,
      txids: txs2.slice(0, 6).map((t) => t.txid ?? t.hash ?? null).filter(Boolean),
    };
  });

  const sizeHistogram = {};
  for (const p of described) sizeHistogram[p.size] = (sizeHistogram[p.size] ?? 0) + 1;
  const multi = described.filter((p) => p.size > 1).sort((a, b) => b.size - a.size || (b.packageFeeRate ?? 0) - (a.packageFeeRate ?? 0));

  return {
    total: described.length,
    multiTx: multi.length,
    txsInPackages: multi.reduce((n2, p) => n2 + p.size, 0),
    largest: multi[0]?.size ?? 1,
    cpfpCandidates: described.filter((p) => p.cpfp).length,
    sizeHistogram,
    top: (keepTop ? multi.slice(0, keepTop) : multi).map((p) => ({ ...p, txids: p.txids.slice(0, 4) })),
  };
}

/** The honest note that travels with this data, so cost and cadence are never invisible. */
export const TEMPLATE_NOTE = 'getblocktemplate(rules:[segwit]) costs this node roughly 1.3-1.5 s of its single RPC thread and 1.79 MB per call; it is polled once a minute, skipped during initial download, and its transaction hex is dropped before the snapshot is built.';
