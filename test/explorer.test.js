// The explorer (block, transaction and address pages over this node's RPC): the server
// handlers against a fake node, and the pure page renderers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { txSummary, xTx, xBlock, xAddress, xSearch, PAGE, _resetCache, _setClock, INDEX_RECHECK_MS } from '../server/http/explorer.js';
import { addressToScript } from '../server/chain/tx.js';
import { scriptKey } from '../server/chain/index/rows.js';
import { parseRoute, blockHtml, txHtml, addressHtml, homeHtml, errorHtml } from '../public/js/explorer.js';
import * as fmt from '../public/js/fmt.js';

const H = (c) => c.repeat(64);
const TXA = H('a'), TXB = H('b'), BLK = H('c');

// a verbosity-2 transaction: 2 inputs with prevouts, 2 outputs
function rawTx(txid, extra = {}) {
  return {
    txid, hash: txid, version: 2, locktime: 0, size: 250, vsize: 200, weight: 800, fee: 0.00002,
    vin: [
      { txid: TXB, vout: 0, sequence: 0xfffffffd, txinwitness: ['00'], prevout: { value: 0.0005, height: 90, scriptPubKey: { type: 'witness_v0_keyhash', address: 'bc1qsenderexample' } } },
      { txid: TXB, vout: 1, sequence: 0xffffffff, prevout: { value: 0.00052, height: 90, scriptPubKey: { type: 'witness_v1_taproot', address: 'bc1psenderexample' } } },
    ],
    vout: [
      { n: 0, value: 0.001, scriptPubKey: { type: 'witness_v0_keyhash', address: 'bc1qpayeeexample' } },
      { n: 1, value: 0, scriptPubKey: { type: 'nulldata' } },
    ],
    confirmations: 3, blockhash: BLK, blocktime: 1_700_000_000,
    ...extra,
  };
}

function fakeNode(answer, log = []) {
  return {
    id: 'n1', state: { chainInfo: { blocks: 100 } }, mining: { rows: new Map([[98, { poolLabel: 'EXAMPLEPOOL' }]]) },
    rpc: {
      batch: async (calls, opts) => {
        log.push({ calls, opts });
        return calls.map((c) => {
          const r = answer(c);
          return r instanceof Error ? { ok: false, method: c.method, error: { message: r.message } } : { ok: true, method: c.method, result: r };
        });
      },
    },
  };
}

test('txSummary: fee from the node, value in and out, features read off the scripts', () => {
  const s = txSummary(rawTx(TXA), 98);
  assert.equal(s.fee, 2000);
  assert.equal(s.inSat, 102_000);
  assert.equal(s.outSat, 100_000);
  assert.equal(s.feerate, 10);
  assert.equal(s.vin[0].address, 'bc1qsenderexample');
  assert.equal(s.vin[0].height, 90);
  assert.deepEqual(s.features, ['segwit', 'taproot', 'rbf', 'op_return']);
  assert.equal(s.height, 98);
});

test('txSummary: without the node fee, the fee is value in minus value out; a coinbase pays none', () => {
  const s = txSummary({ ...rawTx(TXA), fee: undefined });
  assert.equal(s.fee, 2000);
  const cb = txSummary({ txid: TXA, vsize: 100, vin: [{ coinbase: '03aa', sequence: 0xffffffff }], vout: [{ n: 0, value: 3.125, scriptPubKey: { desc: 'addr(bc1qminer)#x', type: 'witness_v0_keyhash' } }] });
  assert.equal(cb.coinbase, true);
  assert.equal(cb.fee, 0);
  assert.equal(cb.vout[0].address, 'bc1qminer', 'the address read out of the descriptor');
  assert.ok(!cb.features.includes('rbf'));
});

test('xTx: one lane turn for the transaction, one for its block height and who spent each output', async () => {
  _resetCache();
  const log = [];
  const m = fakeNode((c) => {
    if (c.method === 'getrawtransaction') return rawTx(TXA);
    if (c.method === 'getblockheader') return { height: 98 };
    if (c.method === 'gettxspendingprevout') return [{ txid: TXA, vout: 0, spendingtxid: TXB, blockhash: BLK }, { txid: TXA, vout: 1 }];
    throw new Error(c.method);
  }, log);
  const d = await xTx(m, { txid: TXA.toUpperCase() });
  assert.equal(d.ok, true);
  assert.equal(log.length, 2, 'two batched requests, not one per call');
  assert.equal(d.tx.height, 98);
  assert.deepEqual(d.tx.vout[0].spentBy, { txid: TXB, blockhash: BLK });
  assert.equal(d.tx.vout[1].spentBy, null);
  assert.equal(log[0].opts.priority, 3, 'explorer requests queue ahead of the heavy tiers');
});

test('AN UNCONFIRMED TRANSACTION shows what its inputs spend and its fee, read from the parents', async () => {
  // (operator, 2026-09-14: a mempool transaction whose 858 inputs all read "unknown script"). Core puts
  // prevout in getrawtransaction <txid> 2 only for confirmed transactions.
  _resetCache();
  const unconfirmed = rawTx(TXA, { confirmations: undefined, blockhash: undefined, blocktime: undefined, fee: undefined });
  for (const v of unconfirmed.vin) delete v.prevout;
  const parent = { txid: TXB, confirmations: 7, vout: [
    { n: 0, value: 0.0005, scriptPubKey: { type: 'witness_v0_keyhash', address: 'bc1qsenderexample', hex: '0014' } },
    { n: 1, value: 0.00052, scriptPubKey: { type: 'witness_v1_taproot', address: 'bc1psenderexample', hex: '5120' } },
  ] };
  const asked = [];
  const m = fakeNode((c) => {
    asked.push(c.method + ':' + c.params[0] + ':' + c.params[1]);
    if (c.method === 'getrawtransaction' && c.params[0] === TXA) return unconfirmed;
    if (c.method === 'getrawtransaction' && c.params[0] === TXB && c.params[1] === 1) return parent;
    if (c.method === 'gettxspendingprevout') return [];
    return new Error(c.method);
  });
  const d = await xTx(m, { txid: TXA });
  assert.equal(d.ok, true);
  assert.deepEqual(d.tx.vin.map((v) => [v.address, v.value]), [['bc1qsenderexample', 50_000], ['bc1psenderexample', 52_000]], 'each input has its address and amount');
  assert.equal(d.tx.fee, 2_000, 'and the fee is inputs minus outputs');
  assert.equal(asked.filter((a) => a.startsWith(`getrawtransaction:${TXB}:1`)).length, 1, 'a parent spent twice is fetched once');
});

test('xTx: a malformed id and an unknown one are sentences, not throws', async () => {
  const m = fakeNode(() => new Error('No such mempool or blockchain transaction'));
  assert.equal((await xTx(m, { txid: 'zz' })).ok, false);
  const d = await xTx(m, { txid: TXA });
  assert.equal(d.ok, false);
  assert.match(d.hint, /not in this node/);
});

test('xBlock: a height resolves to its hash, and one page of transactions comes in one batch', async () => {
  _resetCache();
  const ids = Array.from({ length: PAGE * 2 + 3 }, (_, i) => i.toString(16).padStart(64, '0'));
  const log = [];
  const m = fakeNode((c) => {
    if (c.method === 'getblockhash') return BLK;
    if (c.method === 'getblock') return { hash: BLK, height: 98, confirmations: 3, tx: ids, nTx: ids.length, time: 1_700_000_000 };
    if (c.method === 'getblockstats') return { totalfee: 5000, subsidy: 312_500_000, feerate_percentiles: [1, 2, 3, 4, 5] };
    if (c.method === 'getrawtransaction') return rawTx(c.params[0]);
    throw new Error(c.method);
  }, log);
  const d = await xBlock(m, { id: '98', page: '1' });
  assert.equal(d.ok, true);
  assert.equal(d.pages, 3);
  assert.equal(d.txs.length, PAGE);
  assert.equal(d.txs[0].txid, ids[PAGE], 'page 1 starts after the first page');
  assert.equal(d.txs[0].height, 98);
  assert.equal(d.pool.label, 'EXAMPLEPOOL');
  const txBatches = log.filter((l) => l.calls[0].method === 'getrawtransaction');
  assert.equal(txBatches.length, 1);
  assert.equal(txBatches[0].calls.length, PAGE);
  assert.deepEqual(txBatches[0].calls[0].params, [ids[PAGE], 2, BLK], 'the block hash is passed, so no txindex is needed');
  // the same page again: the confirmed transactions are cached
  log.length = 0;
  await xBlock(m, { id: '98', page: '1' });
  assert.equal(log.filter((l) => l.calls[0].method === 'getrawtransaction').length, 0);
});

test('xAddress: newest first, with what each transaction did to this address', async () => {
  _resetCache();
  const m = fakeNode((c) => {
    if (c.method === 'validateaddress') return { isvalid: true, iswitness: true, witness_version: 0 };
    if (c.method === 'getaddressbalance') return { balance: 100_000, received: 150_000, utxos: 1 };
    if (c.method === 'getaddresstxids') return [TXB, TXA];      // the index answers oldest first
    if (c.method === 'getrawtransaction') return rawTx(c.params[0]);
    throw new Error(c.method);
  });
  const d = await xAddress(m, { addr: 'bc1qpayeeexample' });
  assert.equal(d.ok, true);
  assert.equal(d.type, 'witness v0');
  assert.deepEqual(d.txs.map((t) => t.txid), [TXA, TXB]);
  assert.equal(d.txs[0].delta, 100_000);
  const spender = await xAddress(m, { addr: 'bc1qsenderexample' });
  assert.equal(spender.txs[0].delta, -50_000);
});

test('AN ABSENT ADDRESS INDEX IS NOT AN EMPTY ONE', async () => {
  // (operator, 2026-09-13: "fix broken search".) Measured against both configured nodes the same
  // day: getaddressbalance and getaddresstxids answer "Method not found" -- they are insight-style
  // extensions Core has never had. validateaddress DOES answer on both, because it is script
  // parsing with no index behind it.
  //
  // The bug: a refused index became [], which became txCount 0 and one empty page, and the page
  // said "no transactions in this node's address index". Indistinguishable from a real address with
  // no history -- and a figure the node never reported. The existing test above passes a fake node
  // that ANSWERS those RPCs, which is why this went unnoticed; this one refuses them the way the
  // real nodes do.
  _resetCache();
  const m = fakeNode((c) => {
    if (c.method === 'validateaddress') return { isvalid: true, iswitness: true, witness_version: 0 };
    // RETURNED, not thrown: fakeNode maps a returned Error to { ok: false }, which is how a real
    // refusal arrives through rpc.batch. Throwing escapes the batch and kills validateaddress
    // alongside it -- which is what the first draft of this test did, and why it read null.
    if (c.method === 'getaddressbalance' || c.method === 'getaddresstxids') return new Error('Method not found');
    return new Error(c.method);
  });
  const d = await xAddress(m, { addr: 'bc1qpayeeexample' });
  assert.equal(d.ok, true, 'the page still answers: the address itself is confirmable');
  assert.equal(d.type, 'witness v0', 'and validateaddress still types it');
  assert.equal(d.indexed, false, 'the node has no address index, and says so');
  assert.equal(d.txCount, null, 'a count nobody can answer is null, NEVER zero');
  assert.deepEqual(d.txs, [], 'and no history is invented');

  // the page must not read as "this address is unused", nor print the raw refusal as a figure
  const html = addressHtml(d, fmt);
  assert.match(html, /no address index/i, 'it says plainly that the index is absent');
  assert.match(html, /not indexed/, 'and marks the unanswerable figures as such');
  assert.doesNotMatch(html, /Method not found/, 'the raw RPC refusal is not shown where a balance belongs');
  assert.doesNotMatch(html, /no transactions in this node/i, 'and it no longer implies an empty index');

  // the working half is untouched: a node WITH the index still lists history
  _resetCache();
  const withIndex = fakeNode((c) => {
    if (c.method === 'validateaddress') return { isvalid: true, iswitness: true, witness_version: 0 };
    if (c.method === 'getaddressbalance') return { balance: 100_000, received: 150_000, utxos: 1 };
    if (c.method === 'getaddresstxids') return [TXB, TXA];
    if (c.method === 'getrawtransaction') return rawTx(c.params[0]);
    throw new Error(c.method);
  });
  const ok = await xAddress(withIndex, { addr: 'bc1qpayeeexample' });
  assert.equal(ok.indexed, true);
  assert.equal(ok.txCount, 2, 'a real count where there is a real index');
});

test('A REFUSED ADDRESS INDEX IS NOT ASKED FOR AGAIN ON EVERY VIEW -- until the refusal expires', async () => {
  // (docs/DEFECTS.md: "xAddress still issues both dead RPCs on every address page view -- two
  // guaranteed failures per view against a single-threaded RPC server.")
  _resetCache();
  let now = 1_000_000;
  _setClock(() => now);
  try {
    const sent = [];
    const refusing = { code: -32601, message: 'Method not found' };
    const m = fakeNode((c) => {
      sent.push(c.method);
      if (c.method === 'validateaddress') return { isvalid: true, iswitness: true, witness_version: 0 };
      if (c.method === 'getaddressbalance' || c.method === 'getaddresstxids') return Object.assign(new Error(refusing.message), refusing);
      return new Error(c.method);
    });
    const index = (list) => list.filter((x) => x.startsWith('getaddress')).length;

    const first = await xAddress(m, { addr: 'bc1qpayeeexample' });
    assert.equal(index(sent), 2, 'the first view asks, and learns the node has no index');
    assert.equal(first.indexed, false);

    sent.length = 0;
    const second = await xAddress(m, { addr: 'bc1qsenderexample' });
    assert.equal(index(sent), 0, 'the next view does not send the two calls that are certain to fail');
    assert.deepEqual(sent, ['validateaddress'], 'only the call that can answer');
    assert.equal(second.indexed, false, 'and the page says the same thing it did');
    assert.equal(second.txCount, null);
    assert.equal(second.type, 'witness v0');

    // the node behind an id can change: the refusal expires and the next view asks again
    now += INDEX_RECHECK_MS + 1;
    sent.length = 0;
    await xAddress(m, { addr: 'bc1qpayeeexample' });
    assert.equal(index(sent), 2, 'after the recheck interval it asks again');

    // a node that is merely busy or slow has told us nothing about whether the method exists
    _resetCache();
    const flaky = fakeNode((c) => {
      sent.push(c.method);
      if (c.method === 'validateaddress') return { isvalid: true };
      if (c.method.startsWith('getaddress')) return new Error('request timed out');
      return new Error(c.method);
    });
    await xAddress(flaky, { addr: 'bc1qpayeeexample' });
    sent.length = 0;
    await xAddress(flaky, { addr: 'bc1qpayeeexample' });
    assert.equal(index(sent), 2, 'a timeout is not a refusal, so it is asked again next time');

    // and a node that HAS the index is never skipped
    _resetCache();
    const indexed = fakeNode((c) => {
      sent.push(c.method);
      if (c.method === 'validateaddress') return { isvalid: true };
      if (c.method === 'getaddressbalance') return { balance: 1, received: 1, utxos: 1 };
      if (c.method === 'getaddresstxids') return [];
      return new Error(c.method);
    });
    await xAddress(indexed, { addr: 'bc1qpayeeexample' });
    sent.length = 0;
    const again = await xAddress(indexed, { addr: 'bc1qpayeeexample' });
    assert.equal(index(sent), 2, 'a working index is asked every time');
    assert.equal(again.indexed, true);
  } finally {
    _setClock(null);
    _resetCache();
  }
});

test('WITH A LOCAL ADDRESS INDEX the page has history and a balance, and never asks Core for what it refuses', async () => {
  // (operator, 2026-09-14: "wire it into the address page"). The index answers (height, position,
  // net amount) rows; the node turns positions into txids and supplies the transactions.
  _resetCache();
  const addr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const key = scriptKey(addressToScript(addr));
  const rows = [                                         // newest first, as summaryForKey returns them
    { key, height: 99, pos: 1, value: -30_000 },
    { key, height: 98, pos: 0, value: 150_000 },
  ];
  const asked = [];
  const store = {
    manifest: { chain: 'main', tip: { height: 99 }, builtAt: '2026-09-14T06:00:00Z' },
    summaryForKey(k, { limit, skip, maxHeight }) {
      asked.push({ k, limit, skip, maxHeight });
      return { txCount: rows.length, balance: 120_000, received: 150_000, sent: 30_000, recent: k === key ? rows.slice(skip, skip + limit) : [] };
    },
    rowsForKey(k) { return k === key ? [...rows].reverse() : []; },   // oldest first, as the store gives them
  };
  const calls = [];
  const m = fakeNode((c) => {
    calls.push(c.method);
    if (c.method === 'validateaddress') return { isvalid: true, iswitness: true, witness_version: 0 };
    if (c.method === 'getblockhash') return H(String(c.params[0] % 10));
    if (c.method === 'getblock') return { hash: c.params[0], tx: c.params[0] === H('9') ? [TXB, TXA] : [TXB] };
    // TXB pays the address at output 0 (still unspent); TXA spends from it and pays someone else
    if (c.method === 'getrawtransaction') return c.params[0] === TXB ? rawTx(TXB, { vout: [{ n: 0, value: 0.0015, scriptPubKey: { type: 'witness_v0_keyhash', address: addr } }] }) : rawTx(c.params[0]);
    if (c.method === 'gettxout') return c.params[0] === TXB && c.params[1] === 0 ? { value: 0.0015, confirmations: 6 } : null;
    return new Error(c.method);
  });
  m.addressIndex = store;
  m.state.chainInfo = { blocks: 104, chain: 'main' };
  const d = await xAddress(m, { addr });
  assert.equal(d.ok, true);
  assert.equal(d.indexed, true, 'the page has an index to read');
  assert.equal(d.source, 'local-index');
  assert.ok(!calls.some((c) => c.startsWith('getaddress')), 'Core is never asked for the address RPCs it refuses');
  assert.equal(asked[0].k, key, 'looked up by the address\'s own script');
  assert.equal(d.txCount, 2);
  assert.deepEqual(d.balance, { balance: 120_000, received: 150_000, utxos: 1 }, 'the unspent outputs are counted');
  assert.deepEqual(d.utxos, [{ txid: TXB, n: 0, value: 150_000, height: 98 }], 'and listed: the output that pays the address and gettxout still has');
  assert.equal(d.utxoNote, null);
  assert.ok(calls.filter((c) => c === 'gettxout').length >= 1, 'asked of the node\'s UTXO set');
  assert.deepEqual(d.txs.map((t) => [t.txid, t.height, t.delta]), [[TXA, 99, -30_000], [TXB, 98, 150_000]], 'each position becomes its txid, with the index\'s own amount');
  assert.deepEqual(d.index, { tip: 99, behind: 5, builtAt: '2026-09-14T06:00:00Z', following: false, stale: null, postTip: 0 }, 'and the page knows how far the index reaches');
  assert.equal(asked[0].maxHeight, 104, 'and rows above the node\'s tip are asked to be left out (audit 2026-09-14, M2)');
  const html = addressHtml(d, fmt);
  assert.match(html, /complete through block/, 'the page says what the index covers');
  assert.match(html, /5 newer blocks not yet included/, 'and that it is behind the node, by how much');
  assert.match(html, /Unspent outputs<\/h2>/, 'the page has the unspent outputs section');
  assert.match(html, new RegExp(`${TXB}[^]*?:0[^]*?0\\.0015`), 'with the output and its value');
  // a long history is not walked: the page says so instead
  m.addressIndex = { ...store, summaryForKey: (k, o) => ({ ...store.summaryForKey(k, o), txCount: 101 }) };
  const long = await xAddress(m, { addr });
  assert.equal(long.utxos, null); assert.equal(long.balance.utxos, null);
  assert.match(long.utxoNote, /more than 100 transactions/);
  assert.match(addressHtml(long, fmt), /more than 100 transactions/, 'and the card says why');
  m.addressIndex = store;
  assert.doesNotMatch(html, /no address index/, 'and it no longer says there is no index');
  // page 2 skips the first PAGE rows
  await xAddress(m, { addr, page: 1 });
  assert.equal(asked.at(-1).skip, PAGE);
  // an address that does not decode is refused before any lookup
  const bad = await xAddress(m, { addr: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5' });
  assert.equal(bad.ok, false);
  assert.equal(asked.length, 2, 'no lookup for an invalid address');
});

test('xSearch: digits are a height, 64 hex is a block if the node knows the header else a tx, and addresses validate', async () => {
  const m = fakeNode((c) => {
    if (c.method === 'getblockheader') return c.params[0] === BLK ? { height: 98 } : new Error('Block not found');
    if (c.method === 'validateaddress') return { isvalid: c.params[0].startsWith('bc1') };
    throw new Error(c.method);
  });
  assert.deepEqual(await xSearch(m, { q: ' 98 ' }), { ok: true, type: 'block', id: '98' });
  assert.equal((await xSearch(m, { q: BLK })).type, 'block');
  assert.equal((await xSearch(m, { q: TXA })).type, 'tx');
  assert.equal((await xSearch(m, { q: 'bc1qpayeeexample00000000' })).type, 'address');
  assert.equal((await xSearch(m, { q: 'nothing-like-this' })).ok, false);
});

test('parseRoute: the route lives in the URL', () => {
  assert.deepEqual(parseRoute('block/98/2'), { kind: 'block', id: '98', page: 2 });
  assert.deepEqual(parseRoute(`tx/${TXA}`), { kind: 'tx', id: TXA });
  assert.deepEqual(parseRoute('address/bc1qx'), { kind: 'address', id: 'bc1qx', page: 0 });
  assert.deepEqual(parseRoute(''), { kind: 'home' });
  assert.deepEqual(parseRoute('tx'), { kind: 'home' });
});

test('the page renderers link everything and escape what the chain wrote', async () => {
  _resetCache();
  const m = fakeNode((c) => {
    if (c.method === 'getrawtransaction') return rawTx(TXA);
    if (c.method === 'getblockheader') return { height: 98 };
    if (c.method === 'gettxspendingprevout') return [{ txid: TXA, vout: 0, spendingtxid: TXB }];
    throw new Error(c.method);
  });
  const t = txHtml(await xTx(m, { txid: TXA }), fmt);
  assert.match(t, /href="#explorer\/block\/98"/);
  assert.match(t, /href="#explorer\/address\/bc1qsenderexample"/);
  assert.match(t, new RegExp(`class="xico-wrap out xspent" href="#explorer/tx/${TXB}" title="spent by ${TXB}"`), 'an output links to the transaction that spent it');
  assert.match(t, new RegExp(`class="xico-wrap in" href="#explorer/tx/${TXB}"`), 'an input links to the transaction that made it');
  assert.match(t, new RegExp(`data-copy="${TXA}"`), 'the id copies');
  assert.match(t, /unspendable/);
  assert.match(t, /xf-rbf/);
  const evil = { ...(await xTx(m, { txid: TXA })) };
  evil.tx = { ...evil.tx, vout: [{ n: 0, value: 1, address: '<img src=x>', type: 'x', spentBy: null }] };
  assert.doesNotMatch(txHtml(evil, fmt), /<img/);
  const b = blockHtml({ block: { hash: BLK, height: 98, nTx: 1, time: 1 }, stats: {}, pool: null, page: 0, pages: 2, txs: [{ txid: TXA, missing: true }], tip: 100 }, fmt);
  assert.match(b, /href="#explorer\/block\/97"/);
  assert.match(b, /href="#explorer\/block\/99"/);
  assert.match(b, /href="#explorer\/block\/98\/1"/, 'the pager');
  // A NODE WITH NO ADDRESS INDEX. This used to pass `balanceError: 'no index'` and assert that the
  // string appeared -- it was pinning the raw RPC refusal being printed where a balance belongs,
  // which is the misleading half of the old behaviour (2026-09-13, "fix broken search"). The
  // renderer no longer shows a node's error text as a figure, so the fixture now says what it means
  // and the assertion checks the contract instead of the leak.
  const a = addressHtml({ address: 'bc1q', indexed: false, balance: null, balanceError: 'Method not found', txs: [], page: 0, pages: 1, txCount: null }, fmt);
  assert.match(a, /no address index/i, 'the page states the index is absent');
  assert.doesNotMatch(a, /Method not found/, 'and never renders the raw refusal as a value');
  assert.match(homeHtml({ blocks: { recent: [{ height: 5, txs: 2, weight: 4e6, totalfee: 10 }] } }, fmt), /href="#explorer\/block\/5"/);
  assert.match(errorHtml({ error: { message: 'a<b' } }, fmt), /a&lt;b/);
  for (const html of [t, b, a]) assert.doesNotMatch(html, /style="/, 'the CSP forbids inline styles');
});

test('the explorer is wired: routes, a nav tab, a page section and a render case', () => {
  const api = readFileSync(new URL('../server/http/api.js', import.meta.url), 'utf8');
  for (const p of ['search', 'tx', 'block', 'address']) assert.match(api, new RegExp(`path: '/api/x/${p}'`));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<button data-page="explorer">/);
  assert.match(html, /id="xSearch"/);
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /case 'explorer'/);
  const client = readFileSync(new URL('../server/rpc/client.js', import.meta.url), 'utf8');
  assert.match(client, /lane\.submit\(job, \{[^}]*priority/, 'batch passes its priority to the lane');
});

import { flowSvg, FLOW_MAX } from '../public/js/explorer.js';

test('the flow: a band per input, per output and for the fee, each a link, sized by value', () => {
  const s = txSummary(rawTx(TXA), 98);
  const svg = flowSvg(s, fmt);
  assert.equal((svg.match(/<path /g) ?? []).length, 5, '2 inputs + 2 outputs + the fee');
  assert.match(svg, new RegExp(`<a href="#explorer/tx/${TXB}"><path class="xb-in"`));
  assert.match(svg, /<a href="#explorer\/address\/bc1qpayeeexample"><path class="xb-out"/);
  assert.match(svg, /class="xb-fee"/);
  assert.match(svg, /class="xb-nul"/, 'the OP_RETURN output is its own band, unlinked');
  assert.doesNotMatch(svg, /style=/);
  const many = flowSvg({ ...s, vin: Array.from({ length: 60 }, () => s.vin[0]) }, fmt);
  assert.equal((many.match(/class="xb-in"/g) ?? []).length, FLOW_MAX - 1);
  assert.match(many, /class="xb-more"[^>]*><title>37 more</);
  const cb = flowSvg(txSummary({ txid: TXA, vsize: 100, vin: [{ coinbase: '03aa' }], vout: [{ n: 0, value: 3.125, scriptPubKey: { address: 'bc1qminer' } }] }), fmt);
  assert.match(cb, /class="xb-cb"/);
  assert.doesNotMatch(cb, /xb-fee/, 'a coinbase pays no fee');
});

test('THE FLOW HAS NO SEAM: both banks of the trunk meet flush at the middle', () => {
  // (operator, 2026-09-13, of a live transaction: "how do we fix that broken seam in the middle so
  // it smoothly transitions".)
  //
  // The two halves meet at x = W/2 and each used to be centred on its OWN total -- the left on
  // sum(inputs), the right on sum(outputs) + the fee. Those are equal in VALUE (in = out + fee) but
  // not in PIXELS, because MIN floors every band to 2px. On the reported transaction -- one fat
  // input and three dust outputs whose true shares were 0.006px each -- the right bank gained
  // 5.98px of padding the left never got and the trunk stepped 3.7px at the join, on both edges.
  //
  // Nothing pinned the centring, which is why it shipped. This measures the rendered path data:
  // every band crosses x = 500, so the inputs' span there must equal the fee+outputs' span.
  const spanAt500 = (svg) => {
    const side = { in: [Infinity, -Infinity], out: [Infinity, -Infinity] };
    for (const [, cls, d] of svg.matchAll(/<path class="(xb-[a-z]+)" d="([^"]+)"/g)) {
      const ys = [...d.matchAll(/[ML]500 (-?[\d.]+)/g)].map((m) => Number(m[1]));
      if (!ys.length) continue;
      const k = cls === 'xb-in' || cls === 'xb-cb' || cls === 'xb-more' ? 'in' : 'out';
      side[k][0] = Math.min(side[k][0], ...ys);
      side[k][1] = Math.max(side[k][1], ...ys);
    }
    return side;
  };
  const tx = (outs, feeSat) => ({
    txid: TXA, vsize: 208, coinbase: false, fee: feeSat, outSat: outs.reduce((a, v) => a + v, 0),
    vin: [{ txid: TXB, value: 0.15268988, address: 'bc1qsender', type: 'witness_v0_keyhash' }],
    vout: outs.map((v, n) => ({ n, value: v, address: `bc1qout${n}`, type: 'witness_v0_keyhash' })),
  });
  // the shape that exposed it: dust outputs, each floored to MIN by the clamp
  const dusty = spanAt500(flowSvg(tx([0.1523, 0.000006, 0.000006, 0.000006], 9000), fmt));
  assert.ok(Math.abs(dusty.in[0] - dusty.out[0]) < 1e-6, `the trunk's top edge is flush (${dusty.in[0]} vs ${dusty.out[0]})`);
  assert.ok(Math.abs(dusty.in[1] - dusty.out[1]) < 1e-6, `and its bottom edge too (${dusty.in[1]} vs ${dusty.out[1]})`);
  // ...and the ordinary shapes, so the fix is not specific to dust
  for (const [label, outs] of [['even', [0.0005, 0.0004]], ['single', [0.0009]], ['many', Array.from({ length: 6 }, () => 0.00015)]]) {
    const s2 = spanAt500(flowSvg(tx(outs, 2000), fmt));
    assert.ok(Math.abs(s2.in[0] - s2.out[0]) < 1e-6, `${label}: top edge flush`);
    assert.ok(Math.abs(s2.in[1] - s2.out[1]) < 1e-6, `${label}: bottom edge flush`);
  }
  // the trunk is still a real height, not collapsed to nothing by the rescale
  assert.ok(dusty.in[1] - dusty.in[0] > 100, `the trunk still has body (${(dusty.in[1] - dusty.in[0]).toFixed(1)}px)`);
});

test('blocks and transactions elsewhere in the app link into the explorer', () => {
  const src = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
  assert.match(src('mining.js'), /href="#explorer\/block\/\$\{row\.height\}"/, 'the Block flow cards');
  assert.match(src('app.js'), /href="#explorer\/block\/\$\{b\.height\}"/, 'the Overview blocks table');
  assert.match(src('panels.js'), /href="#explorer\/tx\//, 'the Chain drill-down');
});

test('the flow: one current -- the shared gradient, notched tails, arrow tips, the fee rising away in gold', () => {
  const s = txSummary(rawTx(TXA), 98);
  const svg = flowSvg(s, fmt);
  for (const id of ['xg-flow', 'xg-cb', 'xg-nul', 'xg-more', 'xg-fee']) assert.match(svg, new RegExp(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse"`));
  assert.match(svg, /class="xb-in" d="M0 [^"]+" fill="url\(#xg-flow\)"/);
  assert.match(svg, /class="xb-out" d="[^"]+L1000 [^"]+" fill="url\(#xg-flow\)"/, 'an output ends in an arrow tip at the right edge');
  assert.match(svg, /class="xb-fee" d="[^"]+" fill="url\(#xg-fee\)"/);
  assert.match(svg, /class="xb-nul" d="[^"]+" fill="url\(#xg-nul\)"/);
  const H = Number(svg.match(/viewBox="0 0 1000 (\d+)"/)[1]);
  assert.ok(H >= 190, 'room to breathe');
});

test('dollar figures: the fee, the total and a coinbase reward, in green, when the server has a price', async () => {
  _resetCache();
  const m = fakeNode((c) => {
    if (c.method === 'getrawtransaction') return rawTx(TXA);
    if (c.method === 'getblockheader') return { height: 98 };
    if (c.method === 'gettxspendingprevout') return [];
    throw new Error(c.method);
  });
  const d = { ...(await xTx(m, { txid: TXA })), usd: 100_000 };
  const html = txHtml(d, fmt);
  assert.match(html, /2,000 <small>sats<\/small><b class="xusd">\$2\.00<\/b>/, 'a 2,000-sat fee at $100k');
  assert.match(html, /<span class="xtotusd">\$100<\/span>/, '0.001 BTC out');
  assert.doesNotMatch(txHtml({ ...d, usd: null }, fmt), /xusd/, 'no price, no dollars -- never a guess');
  assert.match(txHtml(d, fmt), /<span class="xpill ok">3 confirmations<\/span>/);
});

test('the explorer home shows the latest blocks as fee-coloured cubes', () => {
  const html = homeHtml({ blocks: { recent: [{ height: 7, txs: 3000, size: 1.6e6, p: [1, 2, 3, 6, 20], time: 1 }, { height: 6, txs: 10, p: [40, 50, 70, 90, 120] }] } }, fmt);
  assert.match(html, /<a class="xblk f2" href="#explorer\/block\/7">/);
  assert.match(html, /<a class="xblk f7" href="#explorer\/block\/6">/);
  assert.match(html, /~3 sat\/vB/);
  assert.doesNotMatch(html, /style="/);
});

test('the isometric block cubes have faces that meet: the corner cannot tear open', () => {
  // (operator, 2026-09-12: "rendering of the blocks here is broken AF"). The cube is a card with
  // two skewed pseudo-elements: a top face and a right face, both DEPTH deep. For them to meet
  // each other and the card, the top face's bottom edge must be the card's full top edge and the
  // right face's left edge its full right edge -- the skews then carry both to the same far
  // corner. They were inset 5px on two sides each, which left a sliver at the top left, a gap at
  // the bottom right, and a dark wedge at the top right where neither face reached.
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const face = (which) => {
    const m = css.match(new RegExp(`\\.xblk-face::${which} \\{([^}]*)\\}`));
    assert.ok(m, `.xblk-face::${which} exists`);
    return m[1];
  };
  const px = (decl, prop) => {
    // the unit is optional: CSS writes a bare `0`, and `left: 0` is the same edge as `left: 0px`
    const m = decl.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*(-?\\d+)(?:px)?\\s*;`));
    return m ? Number(m[1]) : null;
  };
  const top = face('before'), right = face('after');
  const depth = px(top, 'height');
  assert.ok(depth > 0, 'the top face has a depth');
  assert.equal(px(right, 'width'), depth, 'both faces are the same depth, or the cube is not a cube');

  // flush with the card on the axis each face spans
  assert.equal(px(top, 'left'), 0, 'the top face starts at the card\'s left edge');
  assert.equal(px(top, 'right'), 0, 'and ends at its right edge');
  assert.equal(px(right, 'top'), 0, 'the right face starts at the card\'s top edge');
  assert.equal(px(right, 'bottom'), 0, 'and ends at its bottom edge');

  // and each is pushed out by exactly the depth, so the skewed edges land on the same corner
  assert.equal(px(top, 'top'), -depth, 'the top face sits one depth above the card');
  assert.equal(px(right, 'right'), -depth, 'the right face one depth beside it');
  assert.match(top, /skewX\(-45deg\)/); assert.match(top, /transform-origin: bottom left/);
  assert.match(right, /skewY\(-45deg\)/); assert.match(right, /transform-origin: top left/);
});
