// RECEIVE (docs/PLAN-ADMIN-SUITE.md, M3): the first write in the suite.
//
// It cannot move money — an address belongs to the wallet that derived it — so the tests
// here are about the gates holding, the label not being a place to put anything into a
// browser or an audit line, and an address that is not ours being refused with a sentence
// somebody can act on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';
import { checkLabel, ADDRESS_TYPES } from '../server/admin/receive.js';
import { adminCallAllowed } from '../server/rpc/admin-allowlist.js';

const WALLETS = { hot: { balance: 0, utxos: [], transactions: [], labels: {}, descriptors: [], foreign: ['bcrt1qsomeoneelses'] } };
const ON = { admin: { enabled: true, allowInsecure: true, wallets: ['hot'], elevationMs: 60_000, spend: { capSat: 1000 } } };

async function ready(fn, { elevate = true } = {}) {
  __resetElevations();
  return withApp({ nodes: 1, config: ON, wallets: structuredClone(WALLETS) }, async (h) => {
    const s = await h.client.login('admin', h.client.adminPassword);
    await h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
    await h.client.post('/api/admin/users/admin/wallet-access', { walletAccess: true }, { csrf: s.csrf });
    if (!elevate) await h.client.post('/api/admin/elevate/drop', {}, { csrf: s.csrf });
    return fn({ ...h, csrf: s.csrf });
  });
}

test('deriving an address is a write, and needs the password', async () => {
  await ready(async ({ client, csrf }) => {
    const res = await client.post('/api/admin/wallet/address', { wallet: 'hot', label: 'donations' }, { csrf });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'elevation-required');
  }, { elevate: false });
});

test('an elevated derive returns a labelled address, and says which wallet made it', async () => {
  await ready(async ({ client, csrf, fakes }) => {
    fakes[0].walletPaths.length = 0;
    const res = await client.post('/api/admin/wallet/address', { wallet: 'hot', label: 'donations' }, { csrf });
    assert.equal(res.status, 200);
    assert.equal(res.body.wallet, 'hot');
    assert.equal(res.body.label, 'donations');
    assert.match(res.body.address, /^bcrt1qhot/);
    assert.deepEqual([...new Set(fakes[0].walletPaths.filter(Boolean))], ['hot'], 'derived on the wallet that was asked for');
  });
});

test('the label goes on at derivation, not in a second call afterwards', async () => {
  // Two calls means a window where a fresh address exists unlabelled, and the label is
  // often the only record of what the address was for.
  await ready(async ({ client, csrf }) => {
    await client.post('/api/admin/wallet/address', { wallet: 'hot', label: 'invoice-7' }, { csrf });
    const labels = await client.get('/api/admin/wallet/labels?wallet=hot');
    const row = labels.body.labels.find((l) => l.label === 'invoice-7');
    assert.ok(row, 'the address came back already labelled');
    assert.equal(row.addresses.length, 1);
  });
});

test('address types are a fixed list, not whatever the browser sends', async () => {
  await ready(async ({ client, csrf }) => {
    const ok = await client.post('/api/admin/wallet/address', { wallet: 'hot', type: 'bech32m' }, { csrf });
    assert.equal(ok.status, 200);
    const bad = await client.post('/api/admin/wallet/address', { wallet: 'hot', type: 'p2pk-or-something' }, { csrf });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'address-type');
    assert.match(bad.body.error.message, new RegExp(ADDRESS_TYPES[0]));
  });
});

test('a label cannot carry control characters or run to a kilobyte', () => {
  // It comes back out into a browser and into the audit trail.
  assert.equal(checkLabel('  tidy  '), 'tidy');
  assert.throws(() => checkLabel('a'.repeat(256)), /at most 255/);
  assert.throws(() => checkLabel(`line${String.fromCharCode(0)}break`), /control characters/);
  assert.throws(() => checkLabel(`bell${String.fromCharCode(7)}`), /control characters/);
  // Ordinary punctuation and non-Latin text are fine: this is a label, not an identifier.
  assert.equal(checkLabel('Café — rent, 2026'), 'Café — rent, 2026');
});

test('labelling an address the wallet does not own is refused, in a sentence', async () => {
  await ready(async ({ client, csrf }) => {
    const res = await client.post('/api/admin/wallet/label', { wallet: 'hot', address: 'bcrt1qsomeoneelses', label: 'theirs' }, { csrf });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'address-not-mine');
    assert.match(res.body.error.message, /not in this wallet/);
  });
});

test('a relabel moves the address rather than leaving it under both', async () => {
  await ready(async ({ client, csrf }) => {
    const made = await client.post('/api/admin/wallet/address', { wallet: 'hot', label: 'first' }, { csrf });
    await client.post('/api/admin/wallet/label', { wallet: 'hot', address: made.body.address, label: 'second' }, { csrf });
    const labels = (await client.get('/api/admin/wallet/labels?wallet=hot')).body.labels;
    const first = labels.find((l) => l.label === 'first');
    const second = labels.find((l) => l.label === 'second');
    assert.equal(second.addresses.includes(made.body.address), true);
    assert.equal(first?.addresses.includes(made.body.address) ?? false, false);
  });
});

test('receive cannot reach a spend method, and read cannot reach receive', () => {
  // The capabilities are separate lists for exactly this reason.
  assert.equal(adminCallAllowed('wallet.receive', 'sendrawtransaction', []).ok, false);
  assert.match(adminCallAllowed('wallet.receive', 'sendrawtransaction', []).why, /belongs to wallet\.spend/);
  assert.equal(adminCallAllowed('wallet.read', 'getnewaddress', []).ok, false);
  assert.equal(adminCallAllowed('wallet.receive', 'getnewaddress', []).ok, true);
});

test('every derive and relabel is in the audit trail', async () => {
  await ready(async ({ client, csrf }) => {
    const made = await client.post('/api/admin/wallet/address', { wallet: 'hot', label: 'audited' }, { csrf });
    const audit = await client.get('/api/audit?limit=50');
    const row = JSON.stringify(audit.body);
    assert.match(row, /admin-wallet-address/);
    assert.ok(row.includes(made.body.address), 'the address derived is in the record');
  });
});

test('a wallet not named in admin.wallets cannot be written to either', async () => {
  await ready(async ({ client, csrf, fakes }) => {
    fakes[0].walletPaths.length = 0;
    const res = await client.post('/api/admin/wallet/address', { wallet: 'savings', label: 'x' }, { csrf });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'wallet-not-named');
    assert.equal(fakes[0].walletPaths.length, 0, 'the node is not asked');
  });
});
