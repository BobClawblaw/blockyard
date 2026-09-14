// THE EXPLORER (operator, 2026-09-11: "we need to completely rip off the mempool space block and
// transaction explorers. I want us to be a complete superior replacement for mempool space").
//
// Our own implementation over this node's RPC -- no mempool.space code. What the node gives, measured the same day:
//   * getrawtransaction <txid> 2 carries the fee and every input's prevout -- value, address
//     (in the descriptor), the height it was created -- so one call is a whole transaction page;
//   * gettxspendingprevout answers for CONFIRMED outputs too (a spent-by index), many
//     outpoints per call;
//   * getaddressbalance / getaddresstxids are an address index (insight-style arguments) -- and
//     CORE DOES NOT HAVE THEM at any setting. Measured 2026-09-13 against both configured nodes,
//     an Umbrel and a local Core: "Method not found" from each. xAddress therefore reports
//     `indexed: false` with a NULL txCount rather than an empty list, because a refusal is not a
//     count of zero. validateaddress answers everywhere (script parsing, no index), so the address
//     is still confirmed and typed.
//
// Every call goes through the serialized lane like everything else (rule 1), and a page is ONE
// batched request: the lane spaces requests 250 ms apart, so 25 transactions fetched one by one
// would take six seconds. Explorer requests queue at priority 3 (ahead of the heavy tiers) and
// may wait 45 s rather than being dropped as stale. Decoded confirmed transactions are cached.
// Handlers answer { ok: false, error, hint } rather than throwing, so a bad query is a sentence.

import { statSync } from 'node:fs';
import path from 'node:path';
import { IndexStore } from '../chain/index/store.js';
import { scriptKey } from '../chain/index/rows.js';
import { addressToScript } from '../chain/tx.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;
export const PAGE = 25;
const OPTS = (key) => ({ key, priority: 3, maxWaitMs: 45_000 });

const txCache = new Map();          // txid -> summary; confirmed transactions only, LRU
const CACHE_MAX = 3000;
// a summary carries an object per input and output; a 20,000-output transaction is megabytes, and
// three thousand of those is not the cache this was meant to be (audit 2026-09-14, L2): the giants
// are decoded on demand and never kept
const CACHE_MAX_IO = 2000;
function remember(txid, summary) {
  if (!summary || !(summary.confirmations > 0)) return;
  if ((summary.vin?.length ?? 0) + (summary.vout?.length ?? 0) > CACHE_MAX_IO) return;
  txCache.delete(txid);
  txCache.set(txid, summary);
  if (txCache.size > CACHE_MAX) txCache.delete(txCache.keys().next().value);
}
export function _resetCache() { txCache.clear(); noIndex.clear(); }

// A NODE THAT HAS NO ADDRESS INDEX IS NOT ASKED AGAIN ON EVERY VIEW (docs/DEFECTS.md, "the explorer
// has no address index"). Core refuses getaddressbalance and getaddresstxids at every setting, and
// xAddress used to send both on every address page -- two guaranteed failures per view, queued on a
// serialized lane that spaces requests 250 ms apart. A refusal is now remembered per node and the
// two calls are skipped.
//
// REMEMBERED FOR A WHILE, NOT FOR EVER. What a node answers is a fact about the node behind that id
// today: the config can point it at a different daemon, or an operator can swap in one that has the
// index. So the refusal expires and the next view asks again (AGENTS.md: a cached answer is a
// staleness bug with documentation attached). Only a real "method not found" counts -- a timeout or
// a busy node says nothing about whether the method exists, and must not switch the lookup off.
export const INDEX_RECHECK_MS = 10 * 60_000;
const noIndex = new Map();                 // node id -> when its address index was last refused
let clock = () => Date.now();
export function _setClock(fn) { clock = fn ?? (() => Date.now()); }
const methodMissing = (r) => !r.ok && (r.error?.code === -32601 || /method not found/i.test(String(r.error?.message ?? '')));

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
    // validateaddress works on every node (script parsing, no index), so a valid address still
    // resolves -- but the page it lands on can only confirm the address, not list its history,
    // wherever the node has no address index. The search says so rather than implying a hit.
    if (va.ok && va.result?.isvalid) return { ok: true, type: 'address', id: s };
  }
  return bad(`nothing on this node matches "${s}"`, 'a height is digits; a block hash or txid is 64 hex characters; an address starts 1, 3 or bc1');
}

// AN UNCONFIRMED TRANSACTION HAS NO PREVOUTS IN ITS VERBOSE REPLY (operator, 2026-09-14, a mempool
// transaction with 858 inputs: every one "unknown script", no amounts, no fee). Core fills `prevout`
// from block undo data, which a transaction still in the mempool does not have yet, so
// getrawtransaction <txid> 2 answers those inputs with an outpoint and nothing else -- measured the same
// on both configured nodes. The spent outputs are read from the parents instead: one batch of
// getrawtransaction <parent> 1 (txindex for a confirmed parent, the mempool for an unconfirmed one),
// each distinct parent once. A parent the node cannot supply leaves its inputs as they were.
async function fillPrevouts(m, tx, key) {
  const need = (tx.vin ?? []).filter((v) => v.coinbase == null && v.txid && !v.prevout);
  if (!need.length) return tx;
  const parents = [...new Set(need.map((v) => v.txid))];
  const got = await batch(m, parents.map((p) => ({ method: 'getrawtransaction', params: [p, 1] })), key);
  const tip = m.state?.chainInfo?.blocks ?? null;
  const byId = new Map();
  got.forEach((g, i) => { if (g.ok && g.result) byId.set(parents[i], g.result); });
  for (const v of need) {
    const parent = byId.get(v.txid);
    const out = parent?.vout?.find((o) => o.n === v.vout);
    if (!out) continue;
    const conf = parent.confirmations ?? 0;
    v.prevout = { value: out.value, scriptPubKey: out.scriptPubKey, height: conf > 0 && tip != null ? tip - conf + 1 : null, generated: false };
  }
  return tx;
}

export async function xTx(m, q) {
  const txid = String(q?.txid ?? '').trim().toLowerCase();
  if (!HEX64.test(txid)) return bad(`"${txid}" is not a 64-hex-character transaction id`);
  const [r] = await batch(m, [{ method: 'getrawtransaction', params: [txid, 2] }], `${m.id}:x:tx:${txid}`);
  if (!r.ok || !r.result) {
    const msg = r.error?.message ?? 'the node refused';
    return bad(msg, /not found|No such|information available/i.test(msg) ? 'not in this node\'s mempool or chain' : null);
  }
  const tx = await fillPrevouts(m, r.result, `${m.id}:x:txprev:${txid}`);
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

// THE LOCAL ADDRESS INDEX (server/chain/index/, built by scripts/index-build.js from the node's own
// block files). Core has no address lookup at any setting, so without this the page can only confirm
// that an address is valid. A node gets one with `"addressIndex": "<dir>"` in its config; the same
// index serves any node on the same chain. Opened once, and reopened when a rebuild replaces its
// manifest. A missing or unreadable index is reported on the page, not fatal.
const indexes = new Map();                 // dir -> { store, error, mtimeMs }
// followers registered by main.js (server/chain/index/live.js): their store carries the live tail,
// so a page served through one includes every block the follower has taken in
const followers = new Map();
export function registerLiveIndex(dir, live) { followers.set(dir, live); }
function localIndex(m) {
  if (m.addressIndex) return { store: m.addressIndex, error: null };        // tests inject a store
  const dir = m.cfg?.addressIndex;
  if (!dir) return null;
  const live = followers.get(dir);
  if (live) return { store: live.store, error: null, live };
  let mtimeMs = null;
  try { mtimeMs = statSync(path.join(dir, 'manifest.json')).mtimeMs; } catch (err) { return { store: null, error: `no finished index at ${dir}` }; }
  const had = indexes.get(dir);
  if (had && had.mtimeMs === mtimeMs) return had;
  try { had?.store?.close(); } catch { /* already closed */ }
  let entry;
  try { entry = { store: new IndexStore(dir), error: null, mtimeMs }; } catch (err) { entry = { store: null, error: err.message, mtimeMs }; }
  indexes.set(dir, entry);
  return entry;
}
export function _resetIndexes() { for (const e of indexes.values()) { try { e.store?.close(); } catch { /* closed */ } } indexes.clear(); }

// block height -> its txids in order, for turning an index row (height, position) into a transaction
const blockTxids = new Map();
const BLOCK_TXIDS_MAX = 64;
// THE UNSPENT OUTPUTS of an address (operator, 2026-09-14: "Why don't we do this"): the index says
// which transactions touched it; each one's outputs paying the address are asked of `gettxout`,
// which answers from the UTXO set and the mempool (an output a pending transaction spends is
// already gone). That walk is the whole history, so it is done for an address with at most this
// many transactions and declined, in words, for a longer one.
const UTXO_MAX_TXS = 100;

// positions -> txids: the blocks' hashes in one batch and their txid lists in another, cached
async function blocksFor(m, heights, key) {
  const need = [...new Set(heights)].filter((h) => !blockTxids.has(h));
  if (!need.length) return;
  const hashes = await batch(m, need.map((h) => ({ method: 'getblockhash', params: [h] })), `${key}:hash:${need[0]}`);
  const blocks = await batch(m, hashes.map((h) => ({ method: 'getblock', params: [h.ok ? h.result : '', 1] })), `${key}:blk:${need[0]}`);
  blocks.forEach((b, i) => {
    if (!b.ok || !Array.isArray(b.result?.tx)) return;
    blockTxids.set(need[i], { hash: b.result.hash, tx: b.result.tx });
    if (blockTxids.size > BLOCK_TXIDS_MAX) blockTxids.delete(blockTxids.keys().next().value);
  });
}

async function unspentFor(m, store, key, addr, nodeTip) {
  const all = store.rowsForKey(key).filter((r) => nodeTip == null || r.height <= nodeTip);
  await blocksFor(m, all.map((r) => r.height), `${m.id}:x:utxo:${addr}`);
  const heightOf = new Map();
  for (const r of all) { const t = blockTxids.get(r.height)?.tx?.[r.pos]; if (t) heightOf.set(t, r.height); }
  const sums = await fetchTxs(m, [...heightOf.keys()], null, null, `${m.id}:x:utxotx:${addr}`);
  const cands = [];
  // the height is the index's own row, not inferred from a confirmation count
  for (const s of sums) if (!s.missing) for (const o of s.vout) if (o.address === addr && o.value != null) cands.push({ txid: s.txid, n: o.n, value: o.value, height: heightOf.get(s.txid) ?? s.height });
  if (!cands.length) return [];
  const got = await batch(m, cands.map((c) => ({ method: 'gettxout', params: [c.txid, c.n, true] })), `${m.id}:x:txout:${addr}`);
  return cands.filter((c, i) => got[i]?.ok && got[i].result);
}

async function addressFromIndex(m0, addr, page, store, live = null) {
  // THE BLOCKS AND TRANSACTIONS A PAGE NEEDS COME FROM THE FOLLOWER'S NODE when there is one. Confirmed
  // chain data is the same on every node, and the follower's node is the one the index was built
  // from -- here the local Core -- while the node selected on the page can be the slow one: measured
  // just after a restart, the Umbrel answered RPC in 18-33 s and an address page waited 108-265 s in
  // its queue, against ~1.5 s through the local node. The response names the node that answered.
  const m = live?.rpc ? { ...m0, id: live.nodeId ?? m0.id, rpc: live.rpc } : m0;
  const chain = m0.state?.chainInfo?.chain ?? m0.cfg?.chainHint ?? 'main';
  const script = addressToScript(addr, chain);
  const [va] = await batch(m, [{ method: 'validateaddress', params: [addr] }], `${m.id}:x:addr:${addr}`);
  if (!script || (va.ok && va.result?.isvalid === false)) return bad(`"${addr}" is not a valid ${chain === 'main' ? 'mainnet ' : ''}address`);
  if (store.manifest.chain && store.manifest.chain !== chain) return bad(`the address index on this node is for ${store.manifest.chain}, and this node is on ${chain}`);
  const nodeTip = m0.state?.chainInfo?.blocks ?? null;
  // rows above the node's tip are a reorganised-away tail the follower has not yet rolled back:
  // counted in index.postTip, shown nowhere as history (audit 2026-09-14, M2)
  const sum = store.summaryForKey(scriptKey(script), { limit: PAGE, skip: page * PAGE, maxHeight: nodeTip });
  await blocksFor(m, sum.recent.map((r) => r.height), `${m.id}:x:a:${addr}`);
  // the unspent outputs, for a history short enough to walk
  const listable = sum.txCount <= UTXO_MAX_TXS;
  const utxos = listable ? await unspentFor(m, store, scriptKey(script), addr, nodeTip) : null;
  const txids = sum.recent.map((r) => blockTxids.get(r.height)?.tx?.[r.pos] ?? null);
  const summaries = await fetchTxs(m, txids.filter(Boolean), null, null, `${m.id}:x:atx:${addr}:${page}`);
  const byId = new Map(summaries.map((t) => [t.txid, t]));
  const txs = sum.recent.map((r, i) => {
    const s = txids[i] ? byId.get(txids[i]) : null;
    // the amount is the index's own: what this transaction paid to the address minus what it spent
    // from it, which the page shows even when the transaction itself could not be fetched
    if (!s || s.missing) return { txid: txids[i], missing: true, height: r.height, delta: r.value };
    return { ...brief(s), height: r.height, delta: r.value };
  });
  return {
    ok: true, node: m0.id, dataNode: m.id, address: addr,
    type: va.ok ? (va.result?.iswitness ? `witness v${va.result.witness_version ?? '?'}` : va.result?.isscript ? 'script' : 'legacy') : null,
    scriptType: null,
    indexed: true, source: 'local-index',
    // received and sent are sums of each transaction's NET for this address (see IndexStore)
    balance: { balance: sum.balance, received: sum.received, utxos: utxos ? utxos.length : null },
    utxos, utxoNote: listable ? null : `not listed for an address with more than ${UTXO_MAX_TXS} transactions`,
    txCount: sum.txCount,
    // `tip` is how far the index reaches: the base, its layers and a follower's live tail together
    index: {
      tip: store.tip ?? store.manifest.tip.height, behind: nodeTip != null ? Math.max(0, nodeTip - (store.tip ?? store.manifest.tip.height)) : null,
      builtAt: store.manifest.builtAt, following: !!live, stale: live?.stale ?? null, postTip: sum.postTip ?? 0,
    },
    page, pages: Math.max(1, Math.ceil(sum.txCount / PAGE)), txs, tip: nodeTip,
  };
}

export async function xAddress(m, q) {
  const addr = String(q?.addr ?? '').trim();
  const page = pageOf(q);
  if (!/^[A-Za-z0-9]{14,100}$/.test(addr)) return bad(`"${addr}" is not an address`);
  const local = localIndex(m);
  if (local?.store) return addressFromIndex(m, addr, page, local.store, local.live);
  const now = clock();
  const knownMissing = noIndex.has(m.id) && now - noIndex.get(m.id) < INDEX_RECHECK_MS;
  let va, bal, ids;
  if (knownMissing) {
    [va] = await batch(m, [{ method: 'validateaddress', params: [addr] }], `${m.id}:x:addr:${addr}`);
    // the refusal the node gave last time, marked as remembered rather than freshly asked
    bal = ids = { ok: false, error: { code: -32601, message: 'Method not found', remembered: true } };
  } else {
    [va, bal, ids] = await batch(m, [
      { method: 'validateaddress', params: [addr] },
      { method: 'getaddressbalance', params: [{ addresses: [addr] }] },
      { method: 'getaddresstxids', params: [{ addresses: [addr] }] },
    ], `${m.id}:x:addr:${addr}`);
    if (methodMissing(ids) && methodMissing(bal)) noIndex.set(m.id, now);
    else if (ids.ok) noIndex.delete(m.id);
  }
  if (va.ok && va.result?.isvalid === false) return bad(`"${addr}" is not a valid address`);
  // AN ABSENT INDEX IS NOT AN EMPTY ONE (operator, 2026-09-13: "fix broken search"). Measured
  // against both configured nodes on 2026-09-13: getaddressbalance and getaddresstxids answer
  // "Method not found" -- they are insight-style extensions that Core has never had, which
  // docs/MEASUREMENTS.md already recorded as "Core has no such methods". validateaddress DOES
  // answer on both (it is script parsing, no index), so the address itself can still be confirmed.
  //
  // The bug was here: a refused index became `[]`, which became txCount 0 and one empty page. The
  // page then said "no transactions in this node's address index" -- indistinguishable from a real
  // address with no history, and a figure this node never reported. A count nobody can answer is
  // null, never zero.
  const indexed = ids.ok && Array.isArray(ids.result);
  const txids = indexed ? ids.result.slice().reverse() : [];   // the index answers oldest first
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
    // `indexed` is the honest flag the page renders from; txCount stays NULL when nothing can
    // answer it, so no figure on screen is invented from a refusal
    indexed,
    txCount: indexed ? txids.length : null,
    indexError: ids.ok ? null : ids.error?.message ?? null,
    // a configured local index that could not be opened says why, rather than looking unconfigured
    localIndexError: local?.error ?? null,
    page, pages: indexed ? Math.max(1, Math.ceil(txids.length / PAGE)) : 1, txs, tip: m.state?.chainInfo?.blocks ?? null,
  };
}
