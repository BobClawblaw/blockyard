// THE WALLET, READ-ONLY (docs/PLAN-ADMIN-SUITE.md, M2).
//
// Three properties, in descending order of how much they cost if wrong:
//
//   1. no path through this suite reaches a private key (listdescriptors true, gethdkeys);
//   2. a read of wallet "a" is addressed to wallet "a" -- Core routes by URL path, and a
//      call with no path lands on the node's DEFAULT wallet, so "which wallet am I looking
//      at" is a question with a wrong answer available;
//   3. the grant and the opt-in list are both enforced, and enforced BEFORE the RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';
import { adminCallAllowed, ADMIN_METHODS } from '../server/rpc/admin-allowlist.js';
import { toSats } from '../server/admin/wallet.js';

const WALLETS = {
  hot: {
    balance: 1.5, pending: 0.002, immature: 0, encrypted: true, unlockedUntil: 0,
    utxos: [
      { txid: 'a'.repeat(64), vout: 0, address: 'bcrt1qexampleaddressone', label: 'cold', amount: 1.5, confirmations: 12, spendable: true, solvable: true, safe: true },
      { txid: 'b'.repeat(64), vout: 1, address: 'bcrt1qexampleaddresstwo', label: '', amount: 0.002, confirmations: 0, spendable: true, solvable: true, safe: false },
    ],
    transactions: [
      { txid: 'c'.repeat(64), category: 'receive', address: 'bcrt1qexampleaddressone', label: 'cold', amount: 1.5, confirmations: 12, time: 1789700000, 'bip125-replaceable': 'no' },
      { txid: 'd'.repeat(64), category: 'send', address: 'bcrt1qsomewhereelse', amount: -0.01, fee: -0.00000141, confirmations: 0, time: 1789700600, 'bip125-replaceable': 'yes' },
    ],
    labels: { cold: ['bcrt1qexampleaddressone'] },
    descriptors: [{ desc: 'wpkh([abcd1234/84h/1h/0h]xpub6EXAMPLE/0/*)#checksum' }],
  },
  // Loaded on the node but NOT named in admin.wallets: the suite must not touch it.
  savings: { balance: 99, utxos: [], transactions: [], labels: {}, descriptors: [] },
};

const ON = { admin: { enabled: true, allowInsecure: true, wallets: ['hot'], elevationMs: 60_000, spend: { capSat: 1000 } } };

async function withWallet(fn, { config = ON, grant = true } = {}) {
  __resetElevations();
  return withApp({ nodes: 1, config, wallets: WALLETS }, async (h) => {
    const s = await h.client.login('admin', h.client.adminPassword);
    if (grant) {
      await h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
      await h.client.post('/api/admin/users/admin/wallet-access', { walletAccess: true }, { csrf: s.csrf });
    }
    return fn({ ...h, csrf: s.csrf });
  });
}

test('no route can ask for a private descriptor', () => {
  // The argument, not the method, is what makes listdescriptors dangerous.
  assert.equal(adminCallAllowed('wallet.read', 'listdescriptors', []).ok, true);
  const refused = adminCallAllowed('wallet.read', 'listdescriptors', [true]);
  assert.equal(refused.ok, false);
  assert.match(refused.why, /PRIVATE descriptors/);
  // And the methods that only ever return keys are not in any capability at all.
  for (const m of ['dumpprivkey', 'dumpwallet', 'gethdkeys', 'sethdseed', 'importprivkey', 'backupwallet']) {
    assert.equal(ADMIN_METHODS.has(m), false, `${m} must not be reachable from the suite`);
  }
});

test('the descriptors a screen gets carry no xprv', async () => {
  await withWallet(async ({ client, fakes }) => {
    const res = await client.get('/api/admin/wallet/descriptors?wallet=hot');
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('xprv'), 'a private descriptor reached the browser');
    assert.match(text, /xpub/);
    // The fake returns xprvs when passed `true`, so this passing means the argument was
    // never sent rather than that the fake was polite.
    assert.equal(fakes[0].walletPaths.filter(Boolean).every((w) => w === 'hot'), true);
  });
});

test('a read of one wallet is addressed to that wallet', async () => {
  await withWallet(async ({ client, fakes }) => {
    fakes[0].walletPaths.length = 0;
    const res = await client.get('/api/admin/wallet?wallet=hot');
    assert.equal(res.status, 200);
    assert.equal(res.body.wallet, 'hot');
    const addressed = fakes[0].walletPaths.filter((p) => p !== null);
    assert.ok(addressed.length >= 2, 'the overview makes at least two wallet calls');
    assert.deepEqual([...new Set(addressed)], ['hot'],
      'every wallet call must carry /wallet/hot -- with no path Core answers from the DEFAULT wallet');
  });
});

test('a wallet the operator did not name is refused before any RPC happens', async () => {
  await withWallet(async ({ client, fakes }) => {
    fakes[0].walletPaths.length = 0;
    const res = await client.get('/api/admin/wallet?wallet=savings');
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /not in admin\.wallets/);
    assert.equal(res.body.error.code, 'wallet-not-named');
    assert.equal(fakes[0].walletPaths.length, 0,
      'refused before the call, not filtered after it -- the node must not even be asked');
  });
});

test('without the grant there is no wallet, whatever your role', async () => {
  await withWallet(async ({ client }) => {
    const res = await client.get('/api/admin/wallet?wallet=hot');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'wallet-access-required');
    assert.match(res.body.error.message, /being an administrator is not enough/);
  }, { grant: false });
});

test('with no wallet named at all, the suite says so rather than guessing', async () => {
  await withWallet(async ({ client }) => {
    const res = await client.get('/api/admin/wallet');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'no-wallets');
  }, { config: { admin: { ...ON.admin, wallets: [] } } });
});

test('balances are sats, and the awkward BTC decimals survive the trip', async () => {
  await withWallet(async ({ client }) => {
    const res = await client.get('/api/admin/wallet?wallet=hot');
    assert.equal(res.body.balances.trustedSat, 150_000_000);
    assert.equal(res.body.balances.untrustedPendingSat, 200_000);
    assert.equal(res.body.balances.totalSat, 150_200_000);
    assert.equal(res.body.encrypted, true, 'an encrypted wallet has an unlock step and the UI must know');
    assert.equal(res.body.canSpend, true);
  });
  // The conversion itself, where floats would lie: 0.1 + 0.2 arithmetic never happens
  // because the decimal string is read digit by digit.
  assert.equal(toSats(0.1), 10_000_000);
  assert.equal(toSats('0.00000001'), 1);
  assert.equal(toSats(21_000_000), 2_100_000_000_000_000);
  assert.equal(toSats(-0.00000141), -141);
  assert.equal(toSats(1.5), 150_000_000);
});

test('UTXOs carry what a coin-control screen must not get wrong', async () => {
  await withWallet(async ({ client }) => {
    const res = await client.get('/api/admin/wallet/utxos?wallet=hot');
    assert.equal(res.status, 200);
    const unsafe = res.body.utxos.find((u) => u.confirmations === 0);
    assert.equal(unsafe.safe, false, 'Core marks what it will not vouch for, and the flag must survive');
    assert.equal(unsafe.amountSat, 200_000);
    const confirmed = res.body.utxos.find((u) => u.confirmations === 12);
    assert.equal(confirmed.label, 'cold');
  });
});

test('history keeps the fee, the sign and the replaceability', async () => {
  await withWallet(async ({ client }) => {
    const res = await client.get('/api/admin/wallet/history?wallet=hot');
    const send = res.body.transactions.find((t) => t.category === 'send');
    assert.equal(send.amountSat, -1_000_000, 'a send is negative and stays negative');
    assert.equal(send.feeSat, -141);
    assert.equal(send.bip125Replaceable, 'yes', 'the fee-bump screen keys off this');
  });
});

test('labels come back with their addresses', async () => {
  await withWallet(async ({ client }) => {
    const res = await client.get('/api/admin/wallet/labels?wallet=hot');
    assert.deepEqual(res.body.labels, [{ label: 'cold', addresses: ['bcrt1qexampleaddressone'] }]);
  });
});

test('reads need no elevation: a password prompt to look at a balance is a bad habit', async () => {
  await withWallet(async ({ client, csrf }) => {
    await client.post('/api/admin/elevate/drop', {}, { csrf });
    const res = await client.get('/api/admin/wallet?wallet=hot');
    assert.equal(res.status, 200, 'reading must not require the password that authorises spending');
  });
});
