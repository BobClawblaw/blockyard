// MONEY SAFETY, AGAINST A REAL BITCOIN CORE (review of M4/M5, 2026-09-19).
//
// Every test here is a finding of that review, written to fail against the code it was
// found in and pass against the fix. Most were reproduced on regtest before a line was
// changed: 305,640 sat out under a 250,000 sat rolling cap from two sessions confirming
// at once; 10 BTC out of the paste box uncapped because the coin it spent was already
// spent by one of the wallet's own unconfirmed transactions; 49.999 BTC out of it because
// the coin was locked. A fake node cannot show any of these -- each depends on what Core's
// wallet does and does not list -- so each is run against Core itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BITCOIND, CANDIDATES, PASSPHRASE, regtest, withSuite, fundWallet, signedTx, coins } from './helpers/regtest.js';

const describe = BITCOIND ? test : test.skip;

test('there is a bitcoind to drive the money-safety tests', { skip: BITCOIND ? false : `no bitcoind found (looked in ${CANDIDATES.join(', ')})` }, () => {
  assert.equal(fs.existsSync(BITCOIND), true);
});

const build = (client, csrf, body) => client.post('/api/admin/wallet/send/build', { wallet: 'hot', node: 'rt', ...body }, { csrf });
const confirm = (client, csrf, body) => client.post('/api/admin/wallet/send/confirm', body, { csrf });
const broadcast = (client, csrf, body) => client.post('/api/admin/tx/broadcast', { wallet: 'hot', node: 'rt', ...body }, { csrf });

// ------------------------------------------------------------------ finding 1: the cap race

describe('two sessions confirming at once cannot both pass the rolling cap', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, { admin: { spend: { capSat: 200_000, capSat24h: 250_000 } } }, async ({ client, csrf, session }) => {
      const other = await session();
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const a = await build(client, csrf, { address: to, amountSat: 150_000 });
      const b = await build(other.client, other.csrf, { address: to, amountSat: 150_000 });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(b.status, 200, JSON.stringify(b.body));

      // Each alone is under both caps; together they are over the rolling one. Before the
      // fix both confirms passed the check, both awaited the node, and both recorded the
      // spend afterwards -- 305,640 sat out under a 250,000 sat cap.
      const [ra, rb] = await Promise.all([
        confirm(client, csrf, { id: a.body.build.id, phrase: a.body.build.phrase, passphrase: PASSPHRASE }),
        confirm(other.client, other.csrf, { id: b.body.build.id, phrase: b.body.build.phrase, passphrase: PASSPHRASE }),
      ]);
      const codes = [ra, rb].map((r) => r.status).sort();
      assert.deepEqual(codes, [200, 403], `${JSON.stringify(ra.body)} / ${JSON.stringify(rb.body)}`);
      const refused = [ra, rb].find((r) => r.status === 403);
      assert.equal(refused.body.error.code, 'over-cap-24h');
      assert.equal(rt.mempool().length, 1, 'exactly one transaction went out');
    });
  } finally { await rt.stop(); }
});

// ------------------------------------------------------------ finding 2: one elevation, one action

describe('one elevation cannot carry two concurrent consuming actions', async () => {
  const rt = await regtest();
  try {
    fundWallet(rt, 'other', 2);
    await withSuite(rt, {}, async ({ client, csrf }) => {
      // Two unrelated transactions of somebody else's: no cap, no phrase, no passphrase --
      // only the elevation stands between them and the network.
      const theirs = coins(rt, 'other');
      const dest = rt.cli('-rpcwallet=other', 'getnewaddress');
      const hex = theirs.slice(0, 2).map((c) => signedTx(rt, 'other', [{ txid: c.txid, vout: c.vout }], { [dest]: +(c.amount - 0.001).toFixed(8) }));
      const [r1, r2] = await Promise.all(hex.map((raw) => broadcast(client, csrf, { raw })));
      const codes = [r1, r2].map((r) => r.status).sort();
      assert.deepEqual(codes, [200, 403], `${JSON.stringify(r1.body)} / ${JSON.stringify(r2.body)}`);
      assert.equal([r1, r2].find((r) => r.status === 403).body.error.code, 'elevation-required');
      assert.equal(rt.mempool().length, 1);
    });
  } finally { await rt.stop(); }
});

// ------------------------------------------------------------ finding 3: whose coin is it

describe('a pasted double spend of a coin our own unconfirmed transaction spent is still ours', async () => {
  const rt = await regtest();
  try {
    fundWallet(rt, 'other', 1);
    await withSuite(rt, { admin: { spend: { capSat: 1_000_000 } } }, async ({ client, csrf }) => {
      const [coin] = coins(rt);
      const out = rt.cli('-rpcwallet=other', 'getnewaddress');
      const change = rt.cli('-rpcwallet=hot', 'getrawchangeaddress');
      // A: a small payment, broadcast outside the suite and sitting in the mempool. From
      // here on `listunspent` no longer lists the coin -- which is what made B look foreign.
      const a = signedTx(rt, 'hot', [coin], { [out]: 0.001, [change]: +(coin.amount - 0.0011).toFixed(8) });
      rt.cli('sendrawtransaction', a);
      // B: the same coin again, paying 10 BTC away with a higher fee: a valid replacement.
      const b = signedTx(rt, 'hot', [coin], { [out]: 10, [change]: +(coin.amount - 10.01).toFixed(8) });

      const res = await broadcast(client, csrf, { raw: b, acceptSpendingOurs: true, phrase: 'send on regtest', passphrase: PASSPHRASE });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'over-cap');
      const pool = rt.mempool();
      assert.equal(pool.length, 1, 'the replacement did not go out');
    });
  } finally { await rt.stop(); }
});

describe('a pasted spend of a LOCKED coin of ours is still ours', async () => {
  const rt = await regtest();
  try {
    fundWallet(rt, 'other', 1);
    await withSuite(rt, { admin: { spend: { capSat: 1_000_000 } } }, async ({ client, csrf }) => {
      const [coin] = coins(rt);
      rt.cli('-rpcwallet=hot', 'lockunspent', 'false', JSON.stringify([{ txid: coin.txid, vout: coin.vout }]));
      const out = rt.cli('-rpcwallet=other', 'getnewaddress');
      const hex = signedTx(rt, 'hot', [coin], { [out]: +(coin.amount - 0.001).toFixed(8) });
      const res = await broadcast(client, csrf, { raw: hex, acceptSpendingOurs: true, phrase: 'send on regtest', passphrase: PASSPHRASE });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'over-cap');
      assert.deepEqual(rt.mempool(), []);
    });
  } finally { await rt.stop(); }
});

describe('a coin of the second named wallet is ours even with the first one selected', async () => {
  const rt = await regtest();
  try {
    fundWallet(rt, 'cold', 1);
    rt.cli('-named', 'createwallet', 'wallet_name=stranger');
    await withSuite(rt, {
      admin: { wallets: [{ node: 'rt', wallet: 'hot' }, { node: 'rt', wallet: 'cold' }], spend: { capSat: 1_000_000 } },
    }, async ({ client, csrf }) => {
      const [coin] = coins(rt, 'cold');
      const out = rt.cli('-rpcwallet=stranger', 'getnewaddress');
      const hex = signedTx(rt, 'cold', [coin], { [out]: 10, [rt.cli('-rpcwallet=cold', 'getrawchangeaddress')]: +(coin.amount - 10.001).toFixed(8) });

      const refused = await broadcast(client, csrf, { raw: hex });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.error.code, 'spends-ours');
      assert.match(refused.body.error.message, /cold/);

      const capped = await broadcast(client, csrf, { raw: hex, acceptSpendingOurs: true, phrase: 'send on regtest' });
      assert.equal(capped.status, 403, JSON.stringify(capped.body));
      assert.equal(capped.body.error.code, 'over-cap');
      assert.deepEqual(rt.mempool(), []);
    });
  } finally { await rt.stop(); }
});

// -------------------------------------------------- finding 4 and decision 2: the paste box's words

describe('a pasted spend of ours needs the phrase and the passphrase that Send would', async () => {
  const rt = await regtest();
  try {
    fundWallet(rt, 'other', 1);
    await withSuite(rt, {}, async ({ client, csrf, elevate }) => {
      const [coin] = coins(rt);
      const out = rt.cli('-rpcwallet=other', 'getnewaddress');
      const change = rt.cli('-rpcwallet=hot', 'getrawchangeaddress');
      const hex = signedTx(rt, 'hot', [coin], { [out]: 0.01, [change]: +(coin.amount - 0.0101).toFixed(8) });

      const noPhrase = await broadcast(client, csrf, { raw: hex, acceptSpendingOurs: true, passphrase: PASSPHRASE });
      assert.equal(noPhrase.status, 400, JSON.stringify(noPhrase.body));
      assert.equal(noPhrase.body.error.code, 'phrase-required');
      assert.match(noPhrase.body.error.message, /send on regtest/);

      const noPass = await broadcast(client, csrf, { raw: hex, acceptSpendingOurs: true, phrase: 'send on regtest' });
      assert.equal(noPass.status, 400, JSON.stringify(noPass.body));
      assert.equal(noPass.body.error.code, 'passphrase-required');

      const wrongPass = await broadcast(client, csrf, { raw: hex, acceptSpendingOurs: true, phrase: 'send on regtest', passphrase: 'nope' });
      assert.notEqual(wrongPass.status, 200, 'a wrong passphrase does not broadcast');
      assert.deepEqual(rt.mempool(), []);
      assert.equal(rt.unlockedUntil(), 0);

      await elevate();
      const ok = await broadcast(client, csrf, { raw: hex, acceptSpendingOurs: true, phrase: 'send on regtest', passphrase: PASSPHRASE });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(rt.unlockedUntil(), 0, 'the passphrase check leaves the wallet locked');

    });
  } finally { await rt.stop(); }
});

describe('a pasted spend of ours to an address-book destination needs no phrase', async () => {
  const rt = await regtest();
  try {
    fundWallet(rt, 'other', 1);
    const out = rt.cli('-rpcwallet=other', 'getnewaddress');
    await withSuite(rt, { admin: { addressBook: [{ address: out, label: 'the other one' }] } }, async ({ client, csrf }) => {
      const [coin] = coins(rt);
      const change = rt.cli('-rpcwallet=hot', 'getrawchangeaddress');
      const hex = signedTx(rt, 'hot', [coin], { [out]: 0.01, [change]: +(coin.amount - 0.0101).toFixed(8) });
      const ok = await broadcast(client, csrf, { raw: hex, acceptSpendingOurs: true, passphrase: PASSPHRASE });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    });
  } finally { await rt.stop(); }
});

// ------------------------------------------------------ decision 2: the passphrase, every time

describe('a send from an encrypted wallet needs the passphrase even when the wallet is already unlocked', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const b = await build(client, csrf, { address: to, amountSat: 100_000 });
      assert.equal(b.status, 200, JSON.stringify(b.body));
      // Somebody else -- another session mid-confirm, or the operator at a terminal --
      // has the wallet unlocked right now. Before the fix a confirm with no passphrase
      // signed with THEIR unlock and sent.
      rt.cli('-rpcwallet=hot', 'walletpassphrase', PASSPHRASE, '60');
      try {
        const res = await confirm(client, csrf, { id: b.body.build.id, phrase: b.body.build.phrase });
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error.code, 'passphrase-required');
        assert.deepEqual(rt.mempool(), []);
      } finally { rt.cli('-rpcwallet=hot', 'walletlock'); }

      // Neither the build nor the elevation was spent on a refusal that happened before
      // anything irreversible: the same build confirms with the passphrase.
      const ok = await confirm(client, csrf, { id: b.body.build.id, phrase: b.body.build.phrase, passphrase: PASSPHRASE });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    });
  } finally { await rt.stop(); }
});

describe('a fee bump from an encrypted wallet needs the passphrase too', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      rt.cli('-rpcwallet=hot', 'walletpassphrase', PASSPHRASE, '60');
      try {
        const txid = rt.cli('-rpcwallet=hot', '-named', 'sendtoaddress', `address=${to}`, 'amount=0.001', 'fee_rate=1', 'replaceable=true');
        const res = await client.post('/api/admin/tx/bump/confirm', { wallet: 'hot', node: 'rt', txid, feeRate: 20 }, { csrf });
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error.code, 'passphrase-required');
        assert.ok(rt.mempool().includes(txid), 'the original is untouched');
      } finally { rt.cli('-rpcwallet=hot', 'walletlock'); }
    });
  } finally { await rt.stop(); }
});

// ------------------------------------------------ finding 5: a pending build holds its coins

describe('a second pending build cannot replace a send already reported sent', async () => {
  // ONE spendable coin, as in the review's reproduction: with two, coin selection may
  // happen to pick different coins and the test passes by luck.
  const rt = await regtest({ mature: 1 });
  try {
    await withSuite(rt, {}, async ({ client, csrf, elevate }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const a = await build(client, csrf, { address: to, amountSat: 100_000 });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      // Before the fix this built on the same coin at a higher fee rate: a valid RBF
      // replacement of A, confirmable after A was reported sent.
      const b = await build(client, csrf, { address: to, amountSat: 200_000, feeRate: 50 });
      assert.equal(b.status, 409, JSON.stringify(b.body));
      assert.equal(b.body.error.code, 'build-failed');
      assert.match(b.body.error.message, /pending build/);

      const sentA = await confirm(client, csrf, { id: a.body.build.id, phrase: a.body.build.phrase, passphrase: PASSPHRASE });
      assert.equal(sentA.status, 200, JSON.stringify(sentA.body));

      // Built again after A went out, B spends A's change -- a child of A, not a rival.
      await elevate();
      const b2 = await build(client, csrf, { address: to, amountSat: 200_000, feeRate: 50 });
      assert.equal(b2.status, 200, JSON.stringify(b2.body));
      const sentB = await confirm(client, csrf, { id: b2.body.build.id, phrase: b2.body.build.phrase, passphrase: PASSPHRASE });
      assert.equal(sentB.status, 200, JSON.stringify(sentB.body));
      const pool = rt.mempool();
      assert.ok(pool.includes(sentA.body.txid), 'the send reported as sent is still in the mempool');
      assert.ok(pool.includes(sentB.body.txid));
    });
  } finally { await rt.stop(); }
});

describe('coin control cannot name a coin another pending build holds', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const [coin] = coins(rt);
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const pick = [{ txid: coin.txid, vout: coin.vout }];
      const a = await build(client, csrf, { address: to, amountSat: 100_000, inputs: pick });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      const b = await build(client, csrf, { address: to, amountSat: 100_000, inputs: pick });
      assert.equal(b.status, 409, JSON.stringify(b.body));
      assert.equal(b.body.error.code, 'coins-held');

      // Cancelling A releases the coin, and the same coin can be built again.
      const cancel = await client.post('/api/admin/wallet/send/cancel', { id: a.body.build.id }, { csrf });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      assert.deepEqual(rt.json('-rpcwallet=hot', 'listlockunspent'), []);
      const c = await build(client, csrf, { address: to, amountSat: 100_000, inputs: pick });
      assert.equal(c.status, 200, JSON.stringify(c.body));
    });
  } finally { await rt.stop(); }
});

describe('a build whose coins were spent elsewhere is refused at confirm', async () => {
  const rt = await regtest();
  try {
    fundWallet(rt, 'other', 1);
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const [coin] = coins(rt);
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const a = await build(client, csrf, { address: to, amountSat: 100_000, inputs: [{ txid: coin.txid, vout: coin.vout }] });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      // Spent at a terminal, which does not care about the lock.
      const out = rt.cli('-rpcwallet=other', 'getnewaddress');
      const spent = rt.cli('sendrawtransaction', signedTx(rt, 'hot', [coin], { [out]: +(coin.amount - 0.001).toFixed(8) }));

      const res = await confirm(client, csrf, { id: a.body.build.id, phrase: a.body.build.phrase, passphrase: PASSPHRASE });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'inputs-spent');
      assert.match(res.body.error.message, /spent by another transaction/);
      assert.deepEqual(rt.mempool(), [spent], 'the replacement did not go out');
    });
  } finally { await rt.stop(); }
});

describe('a failed confirm releases the coins it held', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const a = await build(client, csrf, { address: to, amountSat: 100_000 });
      assert.equal(rt.json('-rpcwallet=hot', 'listlockunspent').length, 1, 'the build holds its coin');
      const res = await confirm(client, csrf, { id: a.body.build.id, phrase: a.body.build.phrase, passphrase: 'wrong' });
      assert.notEqual(res.status, 200);
      assert.deepEqual(rt.json('-rpcwallet=hot', 'listlockunspent'), []);
      assert.equal(rt.unlockedUntil(), 0);
    });
  } finally { await rt.stop(); }
});

// -------------------------------------------------- finding 6: a broadcast that timed out

describe('a broadcast whose answer was lost after Core accepted it is reported as sent', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ app, client, csrf }) => {
      const rpc = app.monitors.get('rt').rpc;
      const real = rpc.call.bind(rpc);
      rpc.call = async (method, params, opts) => {
        if (method !== 'sendrawtransaction') return real(method, params, opts);
        await real(method, params, opts);   // Core took it...
        const err = new Error('rpc timeout after 30000ms');   // ...and the answer never came
        err.kind = 'timeout';
        throw err;
      };
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const b = await build(client, csrf, { address: to, amountSat: 100_000 });
      const res = await confirm(client, csrf, { id: b.body.build.id, phrase: b.body.build.phrase, passphrase: PASSPHRASE });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.match(res.body.txid, /^[0-9a-f]{64}$/);
      assert.ok(rt.mempool().includes(res.body.txid));
    });
  } finally { await rt.stop(); }
});

describe('a broadcast that may or may not have gone out says so, names the txid, and keeps the cap', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, { admin: { spend: { capSat: 200_000, capSat24h: 250_000 } } }, async ({ app, client, csrf, elevate }) => {
      const rpc = app.monitors.get('rt').rpc;
      const real = rpc.call.bind(rpc);
      let failNext = true;
      rpc.call = async (method, params, opts) => {
        if (method === 'sendrawtransaction' && failNext) {
          failNext = false;
          const err = new Error('socket hang up');
          err.kind = 'transport';
          throw err;
        }
        return real(method, params, opts);
      };
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const b = await build(client, csrf, { address: to, amountSat: 150_000 });
      const res = await confirm(client, csrf, { id: b.body.build.id, phrase: b.body.build.phrase, passphrase: PASSPHRASE });
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'broadcast-uncertain');
      assert.match(res.body.error.message, /may have been broadcast: [0-9a-f]{64}/);

      const audit = await client.get('/api/audit?limit=50');
      assert.match(JSON.stringify(audit.body), /admin-spend-attempt/);

      // The 150,000 sat stays counted: a second 150,000 is over the 250,000 rolling cap.
      await elevate();
      const again = await build(client, csrf, { address: to, amountSat: 150_000 });
      assert.equal(again.status, 403, JSON.stringify(again.body));
      assert.equal(again.body.error.code, 'over-cap-24h');
    });
  } finally { await rt.stop(); }
});

describe('an audit that fails after the broadcast still returns the txid', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ app, client, csrf }) => {
      const realAudit = app.audit.bind(app);
      app.audit = async (rec) => {
        if (rec?.type === 'admin-spend') throw new Error('disk full');
        return realAudit(rec);
      };
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const b = await build(client, csrf, { address: to, amountSat: 100_000 });
      const res = await confirm(client, csrf, { id: b.body.build.id, phrase: b.body.build.phrase, passphrase: PASSPHRASE });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(rt.mempool().includes(res.body.txid));
    });
  } finally { await rt.stop(); }
});

// ------------------------------------------------------------ finding 7: the relock

describe('the wallet is locked again even when the breaker opens mid-send', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ app, client, csrf }) => {
      const rpc = app.monitors.get('rt').rpc;
      const real = rpc.call.bind(rpc);
      rpc.call = async (method, params, opts) => {
        const out = await real(method, params, opts);
        // Signed, and then the node's lane gives up on it for a minute.
        if (method === 'walletprocesspsbt') rpc.lane.openUntil = Date.now() + 60_000;
        return out;
      };
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const b = await build(client, csrf, { address: to, amountSat: 100_000 });
      const res = await confirm(client, csrf, { id: b.body.build.id, phrase: b.body.build.phrase, passphrase: PASSPHRASE });
      assert.notEqual(res.status, 200);
      assert.equal(rt.unlockedUntil(), 0, 'walletlock must get through an open breaker');
      rpc.lane.openUntil = 0;
    });
  } finally { await rt.stop(); }
});

// ---------------------------------------------------- finding 9: which chain, asked of the node

describe('the chain is asked of the node, not read from a cache or a hint', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, { node: { chainHint: 'main' } }, async ({ app, client, csrf }) => {
      app.monitors.get('rt').state.chainInfo = { chain: 'signet' };   // stale, and wrong
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const b = await build(client, csrf, { address: to, amountSat: 100_000 });
      assert.equal(b.status, 200, JSON.stringify(b.body));
      assert.equal(b.body.build.chain, 'regtest');
      assert.equal(b.body.build.phrase, 'send on regtest');
    });
  } finally { await rt.stop(); }
});
