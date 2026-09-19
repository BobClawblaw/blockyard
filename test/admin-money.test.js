// MONEY SAFETY WITHOUT A NODE (review of M4/M5, 2026-09-19).
//
// The findings of that review that are about this suite's own arithmetic, bookkeeping and
// gates rather than about what Core does: amounts Core prints in exponent form, the
// rolling-cap reservation, the per-wallet lock, fee rates that are not numbers, a paste
// with more outputs than anybody sends, which wallet on which node a request means, and
// two small leaks. The ones that need Core are in test/admin-money-regtest.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';
import { toSats, withWalletLock, namedWallets, requireNamedWallet } from '../server/admin/wallet.js';
import { reserveSpend, checkCaps, confirmationPhrase, __resetSpent } from '../server/admin/send.js';
import { previewBump, confirmBump, netLeaving, MAX_TX_ENTRIES } from '../server/admin/txtools.js';
import { Lane } from '../server/rpc/client.js';

// ------------------------------------------------------------------ finding 8: toSats

test('amounts Core prints in exponent form convert exactly', () => {
  // JSON.parse turns Core's 0.00000011 into the number 1.1e-7, whose String() is
  // "1.1e-7" -- and BigInt("1") of the part before the dot silently lost the exponent,
  // or BigInt threw on "1e-7". Fees under 100 sat are ordinary at 0.1 sat/vB relay.
  assert.equal(toSats(1e-7), 10);
  assert.equal(toSats(1.1e-7), 11);
  assert.equal(toSats(-9.9e-7), -99);
  assert.equal(toSats(7e-7), 70);
  assert.equal(toSats(1e-8), 1);
  assert.equal(toSats(21e6), 2_100_000_000_000_000);
  assert.equal(toSats('1.1e-7'), 11);
  assert.equal(toSats('-2.5E-6'), -250);
  assert.equal(toSats(0.1 + 0.2), 30_000_000);
  assert.equal(toSats('0.00000001'), 1);
  assert.equal(toSats(-0.0000282), -2820);
  assert.equal(toSats(null), null);
  for (const bad of ['abc', '', '1.2.3', NaN, Infinity]) {
    assert.throws(() => toSats(bad), /not an amount/, `${String(bad)} must be refused`);
  }
});

// -------------------------------------------------------- finding 1: check AND reserve

test('the rolling cap is checked and reserved in one step', () => {
  __resetSpent();
  const app = { cfg: { admin: { spend: { capSat: 200_000, capSat24h: 250_000 } } } };
  const a = reserveSpend(app, { sendingSat: 150_000, feeSat: 0 });
  // The second arrives before the first has finished: it must see the first already.
  assert.throws(() => reserveSpend(app, { sendingSat: 150_000, feeSat: 0 }), (e) => e.code === 'over-cap-24h');
  a.release();   // failed before broadcast: the sats never left, so they do not count
  const b = reserveSpend(app, { sendingSat: 150_000, feeSat: 0 });
  b.keep();      // went out (or may have): counts
  assert.throws(() => checkCaps(app, { sendingSat: 150_000, feeSat: 0 }), (e) => e.code === 'over-cap-24h');
  b.release();   // too late: a kept reservation stays kept
  assert.throws(() => checkCaps(app, { sendingSat: 150_000, feeSat: 0 }), (e) => e.code === 'over-cap-24h');
  __resetSpent();
});

// ------------------------------------------------------------ decision 2: one signer at a time

test('signing operations on one wallet run one at a time, and other wallets do not wait', async () => {
  const order = [];
  const slow = (tag, ms) => async () => { order.push(`${tag}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}-`); return tag; };
  const results = await Promise.all([
    withWalletLock([['n', 'hot']], slow('a', 40)),
    withWalletLock([['n', 'hot']], slow('b', 5)),
    withWalletLock([['n', 'cold']], slow('c', 5)),
  ]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  // b started only after a finished; c did not wait for either.
  assert.ok(order.indexOf('b+') > order.indexOf('a-'), order.join(' '));
  assert.ok(order.indexOf('c+') < order.indexOf('a-'), order.join(' '));
  // A throw releases the lock.
  await assert.rejects(withWalletLock([['n', 'hot']], async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withWalletLock([['n', 'hot']], async () => 'after'), 'after');
});

// ------------------------------------------------------------------ finding 7: the relock

test('an open breaker refuses every call except one that says it must not be refused', async () => {
  const lane = new Lane({ minIntervalMs: 0, maxRatePerSec: 1000, staleDropMs: 5000, breakerThreshold: 3, breakerCooldownMs: 60_000, maxInFlight: 1 });
  lane.openUntil = Date.now() + 60_000;
  await assert.rejects(lane.submit(async () => 'poll'), /circuit breaker open/);
  assert.equal(await lane.submit(async () => 'locked', { ignoreBreaker: true, priority: 0 }), 'locked');
});

// ---------------------------------------------------------------- finding 10: fee rates

test('a fee rate that is not a positive number is refused before anything is asked of the node', async () => {
  const app = { monitors: new Map(), cfg: { admin: { spend: { capSat: 1000 } } } };
  const txid = 'a'.repeat(64);
  for (const feeRate of [NaN, 'abc', 0, -1, Infinity, '']) {
    await assert.rejects(previewBump(app, {}, { node: 'n', wallet: 'hot', txid, feeRate }), (e) => e.code === 'fee-rate-invalid', `preview ${String(feeRate)}`);
    await assert.rejects(confirmBump(app, {}, { node: 'n', wallet: 'hot', txid, feeRate, passphrase: 'x' }), (e) => e.code === 'fee-rate-invalid', `confirm ${String(feeRate)}`);
  }
});

// ------------------------------------------------------------- finding 11: output fan-out

function stubApp(handler) {
  const calls = [];
  const rpc = { call: async (method, args, opts) => { calls.push({ method, args, walletPath: opts?.walletPath ?? '' }); return handler(method, args, opts); } };
  return { calls, app: { monitors: new Map([['n', { rpc }]]), cfg: { nodes: [{ id: 'n' }], admin: { wallets: [{ node: 'n', wallet: 'hot' }] } } } };
}

test('the paste box asks about each address once, and refuses a transaction too wide to check', async () => {
  const parent = 'e'.repeat(64);
  const { app, calls } = stubApp((method, args) => {
    if (method === 'gettransaction') {
      return { decoded: { vout: [{ n: 0, value: 1, scriptPubKey: { address: 'bcrt1qours' } }] }, details: [] };
    }
    if (method === 'getaddressinfo') return { ismine: args[0] === 'bcrt1qours' };
    throw new Error(`unexpected ${method}`);
  });
  const outputs = Array.from({ length: 300 }, (_, i) => ({ address: i % 2 ? 'bcrt1qtheirs' : 'bcrt1qours', amountSat: 1000 }));
  const out = await netLeaving(app, { node: 'n', inputs: [{ txid: parent, vout: 0 }], outputs });
  assert.equal(out.oursSat, 100_000_000);
  assert.equal(out.changeSat, 150 * 1000);
  const asked = calls.filter((c) => c.method === 'getaddressinfo').map((c) => c.args[0]);
  assert.deepEqual([...new Set(asked)].sort(), asked.slice().sort(), 'no address was asked about twice');

  const wide = Array.from({ length: MAX_TX_ENTRIES + 1 }, () => ({ address: 'bcrt1qtheirs', amountSat: 1 }));
  await assert.rejects(netLeaving(app, { node: 'n', inputs: [{ txid: parent, vout: 0 }], outputs: wide }), (e) => e.code === 'tx-too-wide');
});

test('a named wallet the node cannot answer for is not assumed to be somebody else\'s', async () => {
  const { app } = stubApp((method) => {
    if (method === 'gettransaction') { const e = new Error('Requested wallet does not exist or is not loaded'); e.code = -18; e.kind = 'rpc'; throw e; }
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(netLeaving(app, { node: 'n', inputs: [{ txid: 'e'.repeat(64), vout: 0 }], outputs: [] }), (e) => e.code === 'ownership-unknown');
});

// --------------------------------------------------------------- finding 9: mainnetPhrase

test('admin.spend.mainnetPhrase decides the mainnet sentence', () => {
  assert.equal(confirmationPhrase('main'), 'SEND REAL BITCOIN');
  assert.equal(confirmationPhrase('main', { mainnetPhrase: true }), 'SEND REAL BITCOIN');
  assert.equal(confirmationPhrase('main', { mainnetPhrase: false }), 'send on main');
  assert.equal(confirmationPhrase('regtest', { mainnetPhrase: true }), 'send on regtest');
  assert.equal(confirmationPhrase('main', { addressBook: true }), null);
});

// ------------------------------------------------------ decision 3: a wallet names its node

test('admin.wallets entries name their node; a bare name stands only when there is one node', () => {
  const one = { monitors: new Map([['a', {}]]), cfg: { admin: { wallets: ['hot', { node: 'a', wallet: 'cold' }] } } };
  assert.deepEqual(namedWallets(one), [{ node: 'a', wallet: 'hot' }, { node: 'a', wallet: 'cold' }]);
  assert.deepEqual(requireNamedWallet(one, 'a', 'hot'), { node: 'a', wallet: 'hot' });

  const two = { monitors: new Map([['a', {}], ['b', {}]]), cfg: { admin: { wallets: ['hot', { node: 'b', wallet: 'cold' }] } } };
  assert.deepEqual(namedWallets(two), [{ node: null, wallet: 'hot' }, { node: 'b', wallet: 'cold' }]);
  assert.throws(() => requireNamedWallet(two, 'a', 'hot'), (e) => e.code === 'wallet-node-unnamed' && /"node"/.test(e.message));
  assert.deepEqual(requireNamedWallet(two, 'b', 'cold'), { node: 'b', wallet: 'cold' });
  // The pair, not the name: "cold" is named for node b, and that is not permission on a.
  assert.throws(() => requireNamedWallet(two, 'a', 'cold'), (e) => e.code === 'wallet-not-named');
  assert.throws(() => requireNamedWallet(two, null, 'cold'), (e) => e.code === 'node-required');
});

const FAKE_WALLETS = { hot: { balance: 1, utxos: [], transactions: [], labels: {}, descriptors: [] } };
const ON = { enabled: true, allowInsecure: true, elevationMs: 60_000, spend: { capSat: 1000 } };

test('status reports wallets as { node, wallet } pairs', async () => {
  __resetElevations();
  await withApp({ nodes: 1, config: { admin: { ...ON, wallets: ['hot'] } }, wallets: FAKE_WALLETS }, async ({ client }) => {
    await client.login('admin', client.adminPassword);
    const res = await client.get('/api/admin/status');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.wallets, [{ node: 'node-a', wallet: 'hot' }]);
  });
});

test('with two nodes, a bare wallet name is refused at use and the message says how to name the node', async () => {
  __resetElevations();
  await withApp({ nodes: 2, config: { admin: { ...ON, wallets: ['hot'] } }, wallets: FAKE_WALLETS }, async ({ client }) => {
    const s = await client.login('admin', client.adminPassword);
    await client.post('/api/admin/elevate', { password: client.adminPassword }, { csrf: s.csrf });
    await client.post('/api/admin/users/admin/wallet-access', { walletAccess: true }, { csrf: s.csrf });
    const res = await client.get('/api/admin/wallet?wallet=hot&node=node-a');
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'wallet-node-unnamed');
    assert.match(res.body.error.message, /\{ "node": "<node id>", "wallet": "hot" \}/);
    // And with no node in the request there is nothing to default to.
    const noNode = await client.get('/api/admin/wallet?wallet=hot');
    assert.equal(noNode.status, 403);
    assert.equal(noNode.body.error.code, 'node-required');
  });
});

test('a wallet entry naming a node that is not configured is refused at boot', async () => {
  await assert.rejects(
    withApp({ nodes: 1, config: { admin: { ...ON, wallets: [{ node: 'nope', wallet: 'hot' }] } } }, async () => {}),
    /admin\.wallets.*nope/,
  );
});

// ---------------------------------------------------------------- finding 12: two leaks

test('the address book needs the wallet grant, like everything else about the wallet', async () => {
  __resetElevations();
  await withApp({ nodes: 1, config: { admin: { ...ON, wallets: ['hot'], addressBook: ['bcrt1qsomebody'] } } }, async ({ client }) => {
    await client.login('admin', client.adminPassword);
    const res = await client.get('/api/admin/addressbook');
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'wallet-access-required');
    assert.ok(!JSON.stringify(res.body).includes('bcrt1qsomebody'));
  });
});

test('a failed elevation is audited without the length of what was typed', async () => {
  __resetElevations();
  await withApp({ nodes: 1, config: { admin: { ...ON, wallets: ['hot'] } } }, async ({ client }) => {
    const s = await client.login('admin', client.adminPassword);
    await client.post('/api/admin/elevate', { password: ' not-it ' }, { csrf: s.csrf });
    const audit = await client.get('/api/audit?limit=50');
    const rec = (audit.body?.entries ?? []).find((e) => e.type === 'admin-elevate-failed');
    assert.ok(rec, JSON.stringify(audit.body).slice(0, 400));
    assert.equal('chars' in rec, false);
    assert.equal('trimmedChars' in rec, false);
    assert.equal(rec.empty, false);
    assert.equal(rec.hadSurroundingWhitespace, true);
  });
});
