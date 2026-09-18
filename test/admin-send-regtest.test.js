// SEND, AGAINST A REAL BITCOIN CORE (docs/PLAN-ADMIN-SUITE.md, M4).
//
// The fake node is enough to test gates and shapes. It is NOT enough to test a spend: the
// things that go wrong in a send are Core's things — coin selection, the change output,
// the fee the node actually charged, an encrypted wallet that must be unlocked and locked
// again, a PSBT that has to round-trip through process/finalize, and policy rules that
// only the real mempool knows. A spend path tested only against a fake is not tested.
//
// So this file drives a throwaway REGTEST node: its own datadir under the OS temp
// directory, its own port, an encrypted wallet, and coins that are worth nothing. It
// never touches a wallet on this machine, and it skips itself entirely when no bitcoind
// is available, so the suite still runs anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';
import { __resetPending, __resetSpent, satToBtcString, checkAmountSat } from '../server/admin/send.js';

const PASSPHRASE = 'correct-horse-battery';
const CANDIDATES = [
  process.env.BITCOIND,
  '/mnt/nvme8tb/core-build/bitcoin-v31.1/build/bin/bitcoind',
  '/usr/local/bin/bitcoind',
  '/usr/bin/bitcoind',
].filter(Boolean);
const BITCOIND = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
const CLI = BITCOIND ? path.join(path.dirname(BITCOIND), 'bitcoin-cli') : null;

/** A regtest node with an encrypted, funded wallet. Returns how to reach it and how to stop it. */
async function regtest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-regtest-'));
  // Port 0 is not an option for bitcoind, so take one the OS says is free and race
  // nothing else on this machine for it.
  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const conf = path.join(dir, 'bitcoin.conf');
  fs.writeFileSync(conf, [
    'regtest=1', 'server=1', 'rpcuser=rt', 'rpcpassword=rtpass',
    // Regtest has no fee estimation, and a wallet that cannot estimate a fee cannot fund
    // a transaction at all.
    'fallbackfee=0.0002',
    // `listen=0` and `bind=` together are refused by Core ("Cannot set -bind or -whitebind
    // together with -listen=0"), and a node that will not start is a test that fails with
    // a connection error rather than a reason -- which is exactly how this line was found.
    '[regtest]', `rpcport=${port}`, 'listen=0', 'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1',
  ].join('\n'));

  const cli = (...args) => execFileSync(CLI, [`-datadir=${dir}`, `-conf=${conf}`, ...args], { encoding: 'utf8' }).trim();
  // stderr is kept, not ignored: a node that refuses to start says why on it, and
  // throwing that text is the difference between a fixable test and a mystery.
  const child = spawn(BITCOIND, [`-datadir=${dir}`, `-conf=${conf}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try { cli('getblockchaininfo'); break; } catch (err) {
      if (child.exitCode != null || Date.now() > deadline) {
        throw new Error(`regtest node did not come up${stderr ? `: ${stderr.trim().split('\n')[0]}` : `: ${err.message}`}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  cli('-named', 'createwallet', 'wallet_name=hot', `passphrase=${PASSPHRASE}`);
  const addr = cli('-rpcwallet=hot', 'getnewaddress');
  cli('generatetoaddress', '101', addr);   // 100 for maturity, 1 to spend

  return {
    dir, port, cli, addr,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      try { cli('stop'); } catch { /* already gone */ }
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Boot BlockYard pointed at the regtest node, signed in, granted and elevated. */
async function withSuite(rt, config, fn) {
  __resetElevations(); __resetPending(); __resetSpent();
  // `...config` FIRST, then the computed blocks. The other order spread the caller's
  // partial `admin` over the complete one and dropped `enabled: true` with it -- which
  // showed up as a 404 on every admin route, i.e. as the suite not being there at all.
  return withApp({
    nodes: 1,
    config: {
      ...config,
      nodes: [{
        id: 'rt', label: 'regtest', rpcUrl: rt.url, rpcUser: 'rt', rpcPassword: 'rtpass',
        chainHint: 'regtest', datadir: rt.dir, logFile: null,
      }],
      admin: {
        enabled: true, allowInsecure: true, wallets: ['hot'], elevationMs: 60_000,
        addressBook: [],
        ...(config.admin ?? {}),
        spend: { capSat: 500_000, capSat24h: null, mainnetPhrase: true, ...(config.admin?.spend ?? {}) },
      },
    },
  }, async (h) => {
    const s = await h.client.login('admin', h.client.adminPassword);
    await h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
    await h.client.post('/api/admin/users/admin/wallet-access', { walletAccess: true }, { csrf: s.csrf });
    return fn({ ...h, csrf: s.csrf, elevate: () => h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf }) });
  });
}

const describe = BITCOIND ? test : test.skip;

// Top level and unconditional: a `test()` inside an `if` reads as a nested subtest to the
// scanner behind doc-counts, which counts the suite by reading the source.
test('there is a bitcoind to drive the send tests', { skip: BITCOIND ? false : `no bitcoind found (looked in ${CANDIDATES.join(', ')}; set BITCOIND=/path/to/bitcoind)` }, () => {
  assert.equal(fs.existsSync(BITCOIND), true);
  assert.equal(fs.existsSync(CLI), true, 'bitcoin-cli lives beside bitcoind');
});

describe('a send, end to end, against a real node', async (t) => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf, elevate }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');   // paying ourselves, on regtest

      // ---- the wallet reads, against Core's real answers
      const overview = await client.get('/api/admin/wallet?wallet=hot&node=rt');
      assert.equal(overview.status, 200, JSON.stringify(overview.body));
      assert.equal(overview.body.encrypted, true, 'an encrypted wallet must report an unlock step');
      assert.equal(overview.body.canSpend, true);
      assert.ok(overview.body.balances.trustedSat >= 4_000_000_000, 'regtest coinbase matured');

      // ---- build
      const built = await client.post('/api/admin/wallet/send/build', {
        wallet: 'hot', node: 'rt', address: to, amountSat: 100_000,
      }, { csrf });
      assert.equal(built.status, 200, JSON.stringify(built.body));
      const b = built.body.build;

      // THE POINT OF THE TWO-STEP SHAPE: everything below comes from the transaction the
      // node built, not from the request. The fee in particular is Core's, computed from
      // the inputs it chose, and nothing in this suite could have known it in advance.
      assert.equal(b.to, to);
      assert.equal(b.sendingSat, 100_000);
      assert.ok(b.feeSat > 0, 'the node charged a real fee');
      assert.equal(b.totalSat, b.sendingSat + b.feeSat);
      assert.ok(b.changeSat > 0, 'spending a 50 BTC coinbase leaves change');
      assert.ok(b.inputs >= 1);
      assert.ok(b.vsize > 0 && b.feeRateSatPerVb > 0);
      assert.equal(b.chain, 'regtest');
      assert.equal(b.addressBook, false);
      assert.equal(b.phrase, 'send on regtest', 'a destination outside the book needs the phrase');

      // ---- confirm, with everything wrong first
      const noPhrase = await client.post('/api/admin/wallet/send/confirm', { id: b.id, passphrase: PASSPHRASE }, { csrf });
      assert.equal(noPhrase.status, 400);
      assert.equal(noPhrase.body.error.code, 'phrase-required');

      const wrongPhrase = await client.post('/api/admin/wallet/send/confirm', { id: b.id, phrase: 'SEND REAL BITCOIN', passphrase: PASSPHRASE }, { csrf });
      assert.equal(wrongPhrase.status, 400, 'the mainnet phrase must not work on regtest');

      const badPass = await client.post('/api/admin/wallet/send/confirm', { id: b.id, phrase: b.phrase, passphrase: 'not-the-passphrase' }, { csrf });
      assert.notEqual(badPass.status, 200, 'a wrong wallet passphrase cannot send');
      // and the wallet is not left unlocked by the failure
      const after = JSON.parse(rt.cli('-rpcwallet=hot', 'getwalletinfo'));
      assert.equal(after.unlocked_until, 0, 'the wallet must be locked again after a failed send');

      // A failed confirm consumed the build (one build, one attempt) and the elevation.
      await elevate();
      const rebuilt = await client.post('/api/admin/wallet/send/build', {
        wallet: 'hot', node: 'rt', address: to, amountSat: 100_000,
      }, { csrf });
      const b2 = rebuilt.body.build;

      // ---- the real thing
      const sent = await client.post('/api/admin/wallet/send/confirm', {
        id: b2.id, phrase: b2.phrase, passphrase: PASSPHRASE,
      }, { csrf });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.match(sent.body.txid, /^[0-9a-f]{64}$/);

      // The node has it, and it pays what the confirmation screen said it would.
      const mempool = JSON.parse(rt.cli('getrawmempool'));
      assert.ok(mempool.includes(sent.body.txid), 'the transaction is in the node mempool');
      const tx = JSON.parse(rt.cli('-rpcwallet=hot', 'gettransaction', sent.body.txid));
      assert.equal(Math.round(Math.abs(tx.fee) * 1e8), b2.feeSat, 'the fee shown is the fee charged');

      // The wallet is locked again after a SUCCESSFUL send too.
      const locked = JSON.parse(rt.cli('-rpcwallet=hot', 'getwalletinfo'));
      assert.equal(locked.unlocked_until, 0);

      // The elevation was consumed: one password, one spend.
      const replay = await client.post('/api/admin/wallet/send/build', {
        wallet: 'hot', node: 'rt', address: to, amountSat: 1000,
      }, { csrf });
      assert.equal(replay.status, 403);
      assert.equal(replay.body.error.code, 'elevation-required');

      // And the spent build cannot be confirmed twice.
      await elevate();
      const doubleSpend = await client.post('/api/admin/wallet/send/confirm', {
        id: b2.id, phrase: b2.phrase, passphrase: PASSPHRASE,
      }, { csrf });
      assert.equal(doubleSpend.status, 410, 'a confirmed build is gone, not replayable');
    });
  } finally { await rt.stop(); }
});

describe('the cap is enforced against the built transaction, not the request', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, { admin: { spend: { capSat: 100_500 } } }, async ({ client, csrf }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      // 100,000 sat is under the cap; 100,000 + the node's fee is not. A cap checked
      // against the REQUEST would let this through and a cap checked against the
      // TRANSACTION refuses it, which is the difference this test exists for.
      const res = await client.post('/api/admin/wallet/send/build', {
        wallet: 'hot', node: 'rt', address: to, amountSat: 100_000,
      }, { csrf });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'over-cap');
      assert.match(res.body.error.message, /including fee/);
    });
  } finally { await rt.stop(); }
});

describe('with no cap configured, nothing sends at all', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, { admin: { spend: { capSat: null } } }, async ({ client, csrf }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const res = await client.post('/api/admin/wallet/send/build', {
        wallet: 'hot', node: 'rt', address: to, amountSat: 1000,
      }, { csrf });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'no-spend-cap');
      assert.match(res.body.error.message, /decision to make deliberately rather than discover/);
    });
  } finally { await rt.stop(); }
});

describe('a destination in the address book needs no phrase', async () => {
  const rt = await regtest();
  try {
    const known = rt.cli('-rpcwallet=hot', 'getnewaddress');
    await withSuite(rt, { admin: { addressBook: [known] } }, async ({ client, csrf }) => {
      const built = await client.post('/api/admin/wallet/send/build', {
        wallet: 'hot', node: 'rt', address: known, amountSat: 50_000,
      }, { csrf });
      assert.equal(built.body.build.addressBook, true);
      assert.equal(built.body.build.phrase, null);
      const sent = await client.post('/api/admin/wallet/send/confirm', {
        id: built.body.build.id, passphrase: PASSPHRASE,
      }, { csrf });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.match(sent.body.txid, /^[0-9a-f]{64}$/);
    });
  } finally { await rt.stop(); }
});

// ---------------------------------------------------------------- no node needed

test('amounts are whole satoshis or they are refused', () => {
  assert.equal(checkAmountSat(100_000), 100_000);
  assert.equal(checkAmountSat('100000'), 100_000);
  for (const bad of [0, -1, 1.5, '1.5', '1e5', ' 100 ', 'abc', null, undefined, NaN, Infinity, {}]) {
    assert.throws(() => checkAmountSat(bad), /amount|dust/, `${JSON.stringify(bad)} must be refused`);
  }
  assert.throws(() => checkAmountSat(293), /dust/);
  assert.throws(() => checkAmountSat(21_000_000 * 100_000_000 + 1), /more than there will ever be/);
});

test('sats become the decimal string Core wants, without a float in the middle', () => {
  assert.equal(satToBtcString(100_000), '0.00100000');
  assert.equal(satToBtcString(1), '0.00000001');
  assert.equal(satToBtcString(100_000_000), '1.00000000');
  assert.equal(satToBtcString(2_100_000_000_000_000), '21000000.00000000');
  // The value that makes naive float arithmetic wrong.
  assert.equal(satToBtcString(10_000_000 + 20_000_000), '0.30000000');
});
