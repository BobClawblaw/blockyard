// THE EXPLORER (operator, 2026-09-11: "we need to completely rip off the mempool space block and
// transaction explorers. I want us to be a complete superior replacement for mempool space").
//
// Our own implementation over this node's RPC -- no mempool.space code. What the node gives, measured the same day:
//   * getrawtransaction <txid> 2 carries the fee and every input's prevout -- value, address
//     (in the descriptor), the height it was created -- so one call is a whole transaction page;
//   * gettxspendingprevout answers for CONFIRMED outputs too (a spent-by index), many
//     outpoints per call;
//   * getaddressbalance / getaddresstxids are an address index (insight-style arguments).
//
// Every call goes through the serialized lane like everything else (rule 1), and a page is ONE
// batched request: the lane spaces requests 250 ms apart, so 25 transactions fetched one by one
// would take six seconds. Explorer requests queue at priority 3 (ahead of the heavy tiers) and
// may wait 45 s rather than being dropped as stale. Decoded confirmed transactions are cached.
// Handlers answer { ok: false, error, hint } rather than throwing, so a bad query is a sentence.

const HEX64 = /^[0-9a-fA-F]{64}$/;
export const PAGE = 25;
const OPTS = (key) => ({ key, priority: 3, maxWaitMs: 45_000 });

const txCache = new Map();          // txid -> summary; confirmed transactions only, LRU
const CACHE_MAX = 3000;
function remember(txid, summary) {
  if (!summary || !(summary.confirmations > 0)) return;
  txCache.delete(txid);
  txCache.set(txid, summary);
  if (txCache.size > CACHE_MAX) txCache.delete(txCache.keys().next().value);
}
export function _resetCache() { txCache.clear(); }

const bad = (message, hint = null) => ({ ok: false, error: { message }, hint });
const sat = (btc) => (Number.isFinite(btc) ? Math.round(btc * 1e8) : null);
const addrOf = (spk) => spk?.address ?? spk?.addresses?.[0] ?? spk?.desc?.match(/^addr\(([^)]+)\)/)?.[1] ?? null;
const pageOf = (q) => Math.max(0, Math.min(1_000_000, Math.floor(Number(q?.page) || 0)));

// One transaction as the pages use it. Pure: the verbose (verbosity 2) reply in, a summary out.
export function txSummary(tx, height = null) {
  const vin = (tx?.vin ?? []).map((v) => (v.coinbase != null
    ? { coinbase: true, sequence: v.sequence ?? null }
    : {
      txid: v.txid ?? null, vout: v.vout ?? null, sequence: v.sequence ?? null,
      value: sat(v.prevout?.value), address: addrOf(v.prevout?.scriptPubKey),
      type: v.prevout?.scriptPubKey?.type ?? null, height: v.prevout?.height ?? null,
      witness: Array.isArray(v.txinwitness) && v.txinwitness.length > 0,
    }));
  const vout = (tx?.vout ?? []).map((o) => ({
    n: o.n ?? null, value: sat(o.value), address: addrOf(o.scriptPubKey), type: o.scriptPubKey?.type ?? null, spentBy: null,
  }));
  const coinbase = vin.length > 0 && vin[0].coinbase === true;
  const known = vin.every((v) => v.coinbase || v.value != null);
  const inSat = coinbase || !known ? null : vin.reduce((a, v) => a + v.value, 0);
  const outSat = vout.reduce((a, o) => a + (o.value ?? 0), 0);
  const fee = coinbase ? 0 : Number.isFinite(tx?.fee) ? sat(tx.fee) : inSat != null ? inSat - outSat : null;
  const vsize = tx?.vsize ?? null;
  const features = [];
  if (vin.some((v) => v.witness)) features.push('segwit');
  if (vin.some((v) => v.type === 'witness_v1_taproot') || vout.some((o) => o.type === 'witness_v1_taproot')) features.push('taproot');
  if (!coinbase && vin.some((v) => Number.isFinite(v.sequence) && v.sequence < 0xfffffffe)) features.push('rbf');
  if (!coinbase && vin.length >= 5 && vout.length <= 2) features.push('consolidation');
  if (vout.some((o) => o.type === 'nulldata')) features.push('op_return');
  const confirmations = tx?.confirmations ?? 0;
  return {
    txid: tx?.txid ?? null, hash: tx?.hash ?? null, version: tx?.version ?? null, locktime: tx?.locktime ?? null,
    size: tx?.size ?? null, vsize, weight: tx?.weight ?? null,
    fee, feerate: fee != null && vsize ? Math.round((fee / vsize) * 100) / 100 : null,
    coinbase, inSat, outSat, vin, vout, features,
    blockhash: tx?.blockhash ?? null, confirmations, time: tx?.blocktime ?? tx?.time ?? null, height,
  };
}

// the row a block or address page lists
const brief = (s) => (s.missing ? s : {
  txid: s.txid, fee: s.fee, feerate: s.feerate, vsize: s.vsize, outSat: s.outSat, coinbase: s.coinbase,
  inCount: s.vin.length, outCount: s.vout.length, features: s.features, height: s.height, time: s.time,
  confirmations: s.confirmations,
});

async function batch(m, calls, key) {
  try { return await m.rpc.batch(calls, OPTS(key)); } catch (err) { return calls.map((c) => ({ ok: false, method: c.method, error: { message: err.message } })); }
}

// Fetch the transactions a page lists: cached ones free, the rest in ONE batch.
async function fetchTxs(m, txids, blockhash, height, key) {
  const need = txids.filter((t) => !txCache.has(t));
  const fresh = new Map();
  if (need.length) {
    const got = await batch(m, need.map((t) => ({ method: 'getrawtransaction', params: blockhash ? [t, 2, blockhash] : [t, 2] })), key);
    got.forEach((g, i) => {
      if (!g.ok || !g.result) return;
      const conf = g.result.confirmations ?? 0;
      const tip = m.state?.chainInfo?.blocks ?? null;
      const h = height ?? (conf > 0 && tip != null ? tip - conf + 1 : null);
      const s = txSummary(g.result, h);
      fresh.set(need[i], s);
      remember(need[i], s);
    });
  }
  return txids.map((t) => txCache.get(t) ?? fresh.get(t) ?? { txid: t, missing: true });
}

export async function xSearch(m, q) {
  const s = String(q?.q ?? '').trim();
  if (!s) return bad('type a block height, a block hash, a transaction id or an address');
  if (/^\d{1,9}$/.test(s)) return { ok: true, type: 'block', id: s };
  if (HEX64.test(s)) {
    const [h] = await batch(m, [{ method: 'getblockheader', params: [s, true] }], `${m.id}:x:find:${s}`);
    return { ok: true, type: h.ok ? 'block' : 'tx', id: s.toLowerCase() };
  }
  if (/^[A-Za-z0-9]{14,100}$/.test(s)) {
    const [va] = await batch(m, [{ method: 'validateaddress', params: [s] }], `${m.id}:x:find:${s}`);
    if (va.ok && va.result?.isvalid) return { ok: true, type: 'address', id: s };
  }
  return bad(`nothing on this node matches "${s}"`, 'a height is digits; a block hash or txid is 64 hex characters; an address starts 1, 3 or bc1');
}

export async function xTx(m, q) {
  const txid = String(q?.txid ?? '').trim().toLowerCase();
  if (!HEX64.test(txid)) return bad(`"${txid}" is not a 64-hex-character transaction id`);
  const [r] = await batch(m, [{ method: 'getrawtransaction', params: [txid, 2] }], `${m.id}:x:tx:${txid}`);
  if (!r.ok || !r.result) {
    const msg = r.error?.message ?? 'the node refused';
    return bad(msg, /not found|No such|information available/i.test(msg) ? 'not in this node\'s mempool or chain' : null);
  }
  const tx = r.result;
  // one more turn: the block's height, and who spent each output
  const calls = [];
  if (tx.blockhash) calls.push({ method: 'getblockheader', params: [tx.blockhash, true] });
  const outs = (tx.vout ?? []).slice(0, 500).map((o) => ({ txid, vout: o.n }));
  if (outs.length) calls.push({ method: 'gettxspendingprevout', params: [outs] });
  let height = null, spends = null;
  for (const x of calls.length ? await batch(m, calls, `${m.id}:x:txmore:${txid}`) : []) {
    if (!x.ok) continue;
    if (x.method === 'getblockheader') height = x.result?.height ?? null;
    if (x.method === 'gettxspendingprevout') spends = x.result;
  }
  const s = txSummary(tx, height);
  if (Array.isArray(spends)) {
    for (const sp of spends) {
      const o = s.vout.find((v) => v.n === sp.vout);
      if (o && sp.spendingtxid) o.spentBy = { txid: sp.spendingtxid, blockhash: sp.blockhash ?? null };
    }
  }
  remember(txid, s);
  return { ok: true, node: m.id, tx: s, tip: m.state?.chainInfo?.blocks ?? null, outputsShown: Math.min(s.vout.length, 500) };
}

export async function xBlock(m, q) {
  const id = String(q?.id ?? '').trim();
  const page = pageOf(q);
  let hash = id.toLowerCase();
  if (/^\d{1,9}$/.test(id)) {
    const [r] = await batch(m, [{ method: 'getblockhash', params: [Number(id)] }], `${m.id}:x:bh:${id}`);
    if (!r.ok) return bad(r.error?.message ?? `no block at height ${id}`, 'past the tip, or not stored on this node');
    hash = r.result;
  } else if (!HEX64.test(id)) return bad(`"${id}" is not a block height or a 64-hex-character block hash`);
  const [b, st] = await batch(m, [{ method: 'getblock', params: [hash, 1] }, { method: 'getblockstats', params: [hash] }], `${m.id}:x:block:${hash}`);
  if (!b.ok || !b.result) return bad(b.error?.message ?? 'the node refused', 'not stored on this node');
  const blk = b.result;
  const txids = Array.isArray(blk.tx) ? blk.tx : [];
  const slice = txids.slice(page * PAGE, page * PAGE + PAGE);
  const txs = (await fetchTxs(m, slice, blk.hash ?? hash, blk.height ?? null, `${m.id}:x:btx:${hash}:${page}`)).map(brief);
  const row = m.mining?.rows?.get?.(blk.height) ?? null;
  return {
    ok: true, node: m.id,
    block: {
      hash: blk.hash ?? hash, height: blk.height ?? null, confirmations: blk.confirmations ?? null, time: blk.time ?? null,
      mediantime: blk.mediantime ?? null, size: blk.size ?? null, strippedsize: blk.strippedsize ?? null, weight: blk.weight ?? null,
      version: blk.version ?? null, versionHex: blk.versionHex ?? null, merkleroot: blk.merkleroot ?? null, bits: blk.bits ?? null,
      nonce: blk.nonce ?? null, difficulty: blk.difficulty ?? null, chainwork: blk.chainwork ?? null, nTx: blk.nTx ?? txids.length,
      previousblockhash: blk.previousblockhash ?? null, nextblockhash: blk.nextblockhash ?? null,
    },
    stats: st.ok ? st.result : null,
    pool: row ? { label: row.poolLabel ?? null, tag: row.tagText ?? null } : null,
    page, pages: Math.max(1, Math.ceil(txids.length / PAGE)), txs,
    tip: m.state?.chainInfo?.blocks ?? null,
  };
}

export async function xAddress(m, q) {
  const addr = String(q?.addr ?? '').trim();
  const page = pageOf(q);
  if (!/^[A-Za-z0-9]{14,100}$/.test(addr)) return bad(`"${addr}" is not an address`);
  const [va, bal, ids] = await batch(m, [
    { method: 'validateaddress', params: [addr] },
    { method: 'getaddressbalance', params: [{ addresses: [addr] }] },
    { method: 'getaddresstxids', params: [{ addresses: [addr] }] },
  ], `${m.id}:x:addr:${addr}`);
  if (va.ok && va.result?.isvalid === false) return bad(`"${addr}" is not a valid address`);
  // the index answers oldest first; a page reads newest first
  const txids = ids.ok && Array.isArray(ids.result) ? ids.result.slice().reverse() : [];
  const slice = txids.slice(page * PAGE, page * PAGE + PAGE);
  const txs = (await fetchTxs(m, slice, null, null, `${m.id}:x:atx:${addr}:${page}`)).map((s) => {
    if (s.missing) return s;
    const delta = s.vout.reduce((a, o) => a + (o.address === addr ? o.value ?? 0 : 0), 0)
      - s.vin.reduce((a, v) => a + (!v.coinbase && v.address === addr ? v.value ?? 0 : 0), 0);
    return { ...brief(s), delta };
  });
  return {
    ok: true, node: m.id, address: addr,
    type: va.ok ? (va.result?.iswitness ? `witness v${va.result.witness_version ?? '?'}` : va.result?.isscript ? 'script' : 'legacy') : null,
    scriptType: null,
    balance: bal.ok ? bal.result : null, balanceError: bal.ok ? null : bal.error?.message ?? null,
    txCount: txids.length, indexError: ids.ok ? null : ids.error?.message ?? null,
    page, pages: Math.max(1, Math.ceil(txids.length / PAGE)), txs, tip: m.state?.chainInfo?.blocks ?? null,
  };
}
