// The block being built, assembled HERE from the mempool the node already gave us.
//
// WHY THIS EXISTS. The next-block card used to come from `getblocktemplate`, which costs the
// operator's node 1.3-1.5 s of its single RPC thread and 1.79 MB per call (nextblock.js measured
// it on height 966265). That is a real tax on someone else's hardware, paid once a minute, for
// data we can derive: mempool.space does not call it either -- its mempool-blocks.ts makes no
// Core RPC call at all and builds templates from the mempool it already holds.
//
// WHAT MADE IT POSSIBLE, and a claim in nextblock.js that was true of the wrong node. That module
// says `getrawmempool` verbose "returns vsize and fees.base with no depends and no ancestorcount",
// so the dependency graph had to come from the template. That was measured against the
// experimental build. Measured against Bitcoin Core on an Umbrel, 2026-09-13, 29,742 entries:
//
//   depends[]        present, 24,796 entries in a package
//   ancestorcount    present, with ancestorsize and fees.ancestor
//   descendantcount  present, with descendantsize and fees.descendant
//   chunkweight      present, with fees.chunk  <- Core's own cluster linearization
//
// So Core publishes the whole graph, and more: `fees.chunk` over `chunkweight` is the feerate of
// the chunk the cluster-mempool linearization put this transaction in, which is the number Core's
// own miner sorts by. We do not have to reimplement the block assembler -- mempool.space wrote a
// Rust engine for that because it targets nodes that publish less. We sort by the node's own
// answer and take packages in order.
//
// THIS MODULE IS PURE. It takes a getrawmempool(true) reply and returns an object shaped like a
// getblocktemplate reply, so summarizeTemplate, templateCells, packagesFromTemplate and
// blockEconomy consume it unchanged. That is the whole seam: no consumer knows the difference.
//
// TWO CONVERSIONS THAT ARE EASY TO GET WRONG, and wrong silently:
//   1. `depends` in getrawmempool are TXIDs. In getblocktemplate they are INDICES into the
//      transactions array, and packagesFromTemplate walks them as indices. Passed through as
//      strings they are not integers, every `Number.isInteger(d)` test fails, and the package
//      analysis reports every transaction as a singleton -- a wrong answer that looks fine.
//   2. mempool fees are in BTC; template fees are in SATOSHIS. A factor of 1e8 in a feerate is
//      not a subtle graph.

const VBYTES = 4;                        // weight units per virtual byte
const SATS = 100_000_000;
/** BTC (a JSON number) to whole satoshis. */
const toSat = (btc) => (Number.isFinite(btc) ? Math.round(btc * SATS) : 0);

/**
 * The block subsidy at a height, in satoshis. Integer halving arithmetic -- 50e8 is exactly
 * representable and >> would overflow past 31 bits, so this divides.
 */
export function subsidyAt(height, { interval = 210_000 } = {}) {
  if (!Number.isFinite(height) || height < 0) return null;
  const halvings = Math.floor(height / interval);
  if (halvings >= 64) return 0;
  let sat = 50 * SATS;
  for (let i = 0; i < halvings; i++) sat = Math.floor(sat / 2);
  return sat;
}

/**
 * The feerate we sort by, in sat/vB.
 *
 * Core's cluster mempool has already worked out which transactions must travel together and in
 * what order: `fees.chunk` over `chunkweight` is that answer. Where it is absent (an older node,
 * or an entry that predates the index) the ancestor feerate is the next best thing, because it is
 * the number that accounts for a child paying for its parents. The transaction's own feerate is
 * the last resort and the one that gets CPFP wrong, so it is only used when nothing else is there.
 */
export function orderingRate(e) {
  const chunkW = Number(e?.chunkweight);
  const chunkF = Number(e?.fees?.chunk);
  if (Number.isFinite(chunkW) && chunkW > 0 && Number.isFinite(chunkF)) {
    return toSat(chunkF) / (chunkW / VBYTES);
  }
  const ancSize = Number(e?.ancestorsize);
  const ancFee = Number(e?.fees?.ancestor);
  if (Number.isFinite(ancSize) && ancSize > 0 && Number.isFinite(ancFee)) {
    return toSat(ancFee) / ancSize;                 // ancestorsize is already vbytes
  }
  const vs = Number(e?.vsize);
  const base = Number(e?.fees?.base);
  if (Number.isFinite(vs) && vs > 0 && Number.isFinite(base)) return toSat(base) / vs;
  return 0;
}

/**
 * Every in-mempool ancestor of `txid`, nearest last, or null when the graph is broken.
 *
 * Depth-first over `depends`. A parent that is not in the map is a parent that has been mined or
 * evicted between the node building the reply and us reading it; the child is then unselectable
 * this round rather than selectable with a missing parent, because a template that contains a
 * child without its parent is not a block anyone could mine.
 */
function ancestorsOf(txid, pool, cache) {
  if (cache.has(txid)) return cache.get(txid);
  const out = [];
  const seen = new Set();
  const walk = (id) => {
    const e = pool.get(id);
    if (!e) return false;
    for (const p of e.depends ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (!pool.has(p)) return false;
      if (!walk(p)) return false;
      out.push(p);                                   // parents before children
    }
    return true;
  };
  const ok = walk(txid);
  const res = ok ? out : null;
  cache.set(txid, res);
  return res;
}

/**
 * Assemble the next block from a getrawmempool(true) reply.
 *
 * Greedy over the node's own ordering feerate, taking each transaction with its unselected
 * ancestors as one indivisible package -- which is what makes a child carry its parent into the
 * block rather than being stranded above it.
 *
 * `reserveWeight` is the coinbase transaction's room. Core reserves 4,000 weight units by default
 * (-blockmaxweight leaves it), and a template that fills all 4,000,000 describes a block that
 * could not be mined.
 */
export function templateFromMempool(raw, {
  weightLimit = 4_000_000,
  reserveWeight = 4_000,
  height = null,
  previousblockhash = null,
  bits = null,
  version = null,
  at = Date.now(),
  maxTx = 0,                       // 0 = no cap; a guard for pathological pools
} = {}) {
  const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pool = new Map();
  for (const [txid, e] of Object.entries(entries)) {
    if (!e || typeof e !== 'object') continue;
    const weight = Number(e.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    pool.set(txid, {
      txid,
      weight,
      vsize: Number.isFinite(Number(e.vsize)) ? Number(e.vsize) : Math.ceil(weight / VBYTES),
      feeSat: toSat(Number(e.fees?.base)),
      wtxid: typeof e.wtxid === 'string' ? e.wtxid : null,
      depends: Array.isArray(e.depends) ? e.depends.filter((d) => typeof d === 'string') : [],
      rate: orderingRate(e),
      time: Number.isFinite(Number(e.time)) ? Number(e.time) : null,
    });
  }

  const budget = Math.max(0, weightLimit - reserveWeight);
  const order = [...pool.values()].sort((a, b) => b.rate - a.rate || a.txid.localeCompare(b.txid));
  const cache = new Map();
  const chosen = [];                 // txids, parents always before children
  const picked = new Set();
  let used = 0;
  let truncated = false;

  for (const tx of order) {
    if (picked.has(tx.txid)) continue;
    if (maxTx && chosen.length >= maxTx) { truncated = true; break; }
    const anc = ancestorsOf(tx.txid, pool, cache);
    if (anc == null) continue;                       // a parent left the pool: not mineable now
    const pkg = [];
    let w = 0;
    for (const id of anc) {
      if (picked.has(id)) continue;
      pkg.push(id);
      w += pool.get(id).weight;
    }
    pkg.push(tx.txid);
    w += tx.weight;
    if (used + w > budget) continue;                 // keep going: a smaller package may still fit
    for (const id of pkg) { picked.add(id); chosen.push(id); }
    used += w;
  }

  // TXIDS TO INDICES. packagesFromTemplate walks `depends` as positions in this same array, so
  // the remap happens once, here, against the array we just built. A parent that was not selected
  // cannot appear -- by construction it cannot happen, since a child is only taken with its
  // ancestors, but a dropped entry would otherwise become index -1 and corrupt the walk.
  const pos = new Map(chosen.map((id, i) => [id, i]));
  const transactions = chosen.map((id) => {
    const e = pool.get(id);
    return {
      txid: id,
      hash: e.wtxid ?? id,
      fee: e.feeSat,
      weight: e.weight,
      vsize: e.vsize,
      depends: e.depends.map((d) => pos.get(d)).filter((i) => Number.isInteger(i)),
    };
  });

  const feesSat = transactions.reduce((n, t) => n + t.fee, 0);
  const sub = subsidyAt(height);

  return {
    // the getblocktemplate field names, so every existing consumer reads this unchanged
    height,
    previousblockhash,
    weightlimit: weightLimit,
    sizelimit: null,
    sigoplimit: null,
    coinbasevalue: sub == null ? null : sub + feesSat,
    mintime: null,
    bits,
    version,
    curtime: Math.floor(at / 1000),
    transactions,
    // ...and our own provenance, so nothing downstream has to guess where this came from
    assembledLocally: true,
    source: 'getrawmempool',
    poolSize: pool.size,
    selected: transactions.length,
    weightUsed: used,
    reserveWeight,
    truncated,
    subsidySat: sub,
    feesSat,
  };
}

/** The honest note that travels with locally-assembled templates. */
export const LOCAL_TEMPLATE_NOTE = 'the block being built is assembled here from getrawmempool(true), '
  + 'which the monitor already reads for the mempool view: transactions are taken in the order of '
  + "the node's own cluster-mempool chunk feerate, each with its unselected ancestors, until the "
  + 'weight budget is spent. It costs the node no extra call. It is this software\'s reconstruction '
  + "of what a miner would choose, not the node's own getblocktemplate reply, so it can differ at "
  + 'the margin -- sigop limits and policy the mempool does not publish are not modelled.';
