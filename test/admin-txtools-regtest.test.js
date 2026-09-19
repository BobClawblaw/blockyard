// TRANSACTION TOOLS (docs/PLAN-ADMIN-SUITE.md, M5), against a real node.
//
// The test this file exists for is the paste box: a transaction that was built and signed
// by this wallet somewhere else, pasted in here, spends this wallet's coins while
// sidestepping every limit the Send screen enforces. A paste-and-broadcast that does not
// notice is a hole beside a locked door.
//
// Fee bumping is the other half, and its cap question is different: what a bump costs is
// the DIFFERENCE in fee, not the amount again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';
import { __resetPending, __resetSpent } from '../server/admin/send.js';
import { sniffTx } from '../server/admin/txtools.js';

const PASSPHRASE = 'correct-horse-battery';
const CANDIDATES = [
  process.env.BITCOIND,
  '/mnt/nvme8tb/core-build/bitcoin-v31.1/build/bin/bitcoind',
  '/usr/local/bin/bitcoind', '/usr/bin/bitcoind',
].filter(Boolean);
const BITCOIND = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
const CLI = BITCOIND ? path.join(path.dirname(BITCOIND), 'bitcoin-cli') : null;

async function regtest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-tx-'));
  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const conf = path.join(dir, 'bitcoin.conf');
  fs.writeFileSync(conf, ['regtest=1', 'server=1', 'rpcuser=rt', 'rpcpassword=rtpass', 'fallbackfee=0.0002',
    '[regtest]', `rpcport=${port}`, 'listen=0', 'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1'].join('\n'));
  const cli = (...args) => execFileSync(CLI, [`-datadir=${dir}`, `-conf=${conf}`, ...args], { encoding: 'utf8' }).trim();
  const child = spawn(BITCOIND, [`-datadir=${dir}`, `-conf=${conf}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { cli('getblockchaininfo'); break; } catch (err) {
      if (child.exitCode != null || Date.now() > deadline) throw new Error(`regtest node did not come up: ${stderr || err.message}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  cli('-named', 'createwallet', 'wallet_name=hot', `passphrase=${PASSPHRASE}`);
  const addr = cli('-rpcwallet=hot', 'getnewaddress');
  cli('generatetoaddress', '101', addr);
  return {
    dir, cli, addr, url: `http://127.0.0.1:${port}`,
    async stop() {
      try { cli('stop'); } catch { /* gone */ }
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withSuite(rt, admin, fn) {
  __resetElevations(); __resetPending(); __resetSpent();
  return withApp({
    nodes: 1,
    config: {
      nodes: [{ id: 'rt', label: 'regtest', rpcUrl: rt.url, rpcUser: 'rt', rpcPassword: 'rtpass', chainHint: 'regtest', datadir: rt.dir, logFile: null }],
      admin: {
        enabled: true, allowInsecure: true, wallets: ['hot'], elevationMs: 60_000, addressBook: [],
        ...admin,
        spend: { capSat: 5_000_000, capSat24h: null, mainnetPhrase: true, ...(admin?.spend ?? {}) },
      },
    },
  }, async (h) => {
    const s = await h.client.login('admin', h.client.adminPassword);
    const elevate = () => h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
    await elevate();
    await h.client.post('/api/admin/users/admin/wallet-access', { walletAccess: true }, { csrf: s.csrf });
    return fn({ ...h, csrf: s.csrf, elevate });
  });
}

const describe = BITCOIND ? test : test.skip;
test('there is a bitcoind to drive the transaction-tool tests', { skip: BITCOIND ? false : 'no bitcoind found' }, () => {
  assert.equal(fs.existsSync(BITCOIND), true);
});

// -------------------------------------------------------------- no node needed

test('the paste box knows hex from a PSBT from nonsense', () => {
  assert.deepEqual(sniffTx('  02000000 0001  '), { kind: 'hex', text: '020000000001' });
  assert.equal(sniffTx('cHNidP8BAHECAAAAAf...').kind, 'psbt');
  assert.throws(() => sniffTx(''), /paste a transaction/);
  assert.throws(() => sniffTx('hello there'), /neither transaction hex nor a base64 PSBT/);
  assert.throws(() => sniffTx('abc'), /neither/, 'odd-length hex is not hex');
  assert.throws(() => sniffTx('ab'.repeat(500_000)), /larger than any standard transaction/);
});

// ------------------------------------------------------------- against a node

describe('decoding tells you what you are holding, and changes nothing', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const funded = JSON.parse(rt.cli('-rpcwallet=hot', '-named', 'walletcreatefundedpsbt',
        'outputs=' + JSON.stringify([{ [to]: 0.001 }]), 'options=' + JSON.stringify({ fee_rate: 5 })));

      const res = await client.post('/api/admin/tx/decode', { wallet: 'hot', raw: funded.psbt }, { csrf });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.kind, 'psbt');
      assert.ok(res.body.outputs.some((o) => o.address === to && o.amountSat === 100_000));
      assert.equal(res.body.complete, false, 'an unsigned PSBT still needs work, and says which');
      assert.match(String(res.body.next), /signer|updater/);
      assert.ok(res.body.feeSat > 0);
      // Still in the mempool of nobody: decoding is not sending.
      assert.deepEqual(JSON.parse(rt.cli('getrawmempool')), []);
    });
  } finally { await rt.stop(); }
});

describe('a pasted transaction that spends our own coins is treated as a send', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf, elevate }) => {
      // Build and sign OUTSIDE the suite entirely -- this is the window the paste box
      // would otherwise be: a transaction of ours, complete, never seen by the caps.
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      rt.cli('-rpcwallet=hot', 'walletpassphrase', PASSPHRASE, '60');
      const funded = JSON.parse(rt.cli('-rpcwallet=hot', '-named', 'walletcreatefundedpsbt',
        'outputs=' + JSON.stringify([{ [to]: 0.002 }]), 'options=' + JSON.stringify({ fee_rate: 5 })));
      const processed = JSON.parse(rt.cli('-rpcwallet=hot', 'walletprocesspsbt', funded.psbt));
      const final = JSON.parse(rt.cli('finalizepsbt', processed.psbt));
      rt.cli('-rpcwallet=hot', 'walletlock');
      assert.equal(final.complete, true);

      // Pasted in, it is refused until it is confirmed AS a send.
      const refused = await client.post('/api/admin/tx/broadcast', { wallet: 'hot', raw: final.hex }, { csrf });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.error.code, 'spends-ours');
      assert.match(refused.body.error.message, /That is a send, not a broadcast/);
      assert.deepEqual(JSON.parse(rt.cli('getrawmempool')), [], 'nothing went out');

      // Confirmed deliberately, with the wallet's passphrase, it goes -- and it counted. The
      // passphrase was not asked for here until 2026-09-19; the operator's decision that
      // day is that broadcasting this wallet's coins asks for it the way a send does, so
      // this test asserted the unsafe shape and was changed. (The payment is to our own
      // address, so no typed phrase: nothing leaves but the fee.)
      const sent = await client.post('/api/admin/tx/broadcast', { wallet: 'hot', raw: final.hex, acceptSpendingOurs: true, passphrase: PASSPHRASE }, { csrf });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(sent.body.spendsOurs, true);
      assert.ok(sent.body.oursSat > 0);
      assert.ok(JSON.parse(rt.cli('getrawmempool')).includes(sent.body.txid));

      const audit = await client.get('/api/audit?limit=20');
      assert.match(JSON.stringify(audit.body), /admin-broadcast/);
    });
  } finally { await rt.stop(); }
});

describe('the cap applies to the paste box too', async () => {
  const rt = await regtest();
  try {
    // THE DESTINATION IS SOMEBODY ELSE'S, which is what makes this a spend at all. An
    // earlier version of this test paid one of our own addresses and expected the cap to
    // refuse it because the INPUT was a 50 BTC coinbase -- and it did, until the cap was
    // corrected to measure what actually leaves. Paying yourself 50 BTC out of 50 BTC
    // costs the fee, and a cap that refuses it is a cap nobody can live with.
    rt.cli('-named', 'createwallet', 'wallet_name=elsewhere');
    await withSuite(rt, { spend: { capSat: 1_000_000 } }, async ({ client, csrf }) => {
      const to = rt.cli('-rpcwallet=elsewhere', 'getnewaddress');
      rt.cli('-rpcwallet=hot', 'walletpassphrase', PASSPHRASE, '60');
      // 0.02 BTC out of the wallet against a 0.01 BTC cap.
      const funded = JSON.parse(rt.cli('-rpcwallet=hot', '-named', 'walletcreatefundedpsbt',
        'outputs=' + JSON.stringify([{ [to]: 0.02 }]), 'options=' + JSON.stringify({ fee_rate: 5 })));
      const processed = JSON.parse(rt.cli('-rpcwallet=hot', 'walletprocesspsbt', funded.psbt));
      const final = JSON.parse(rt.cli('finalizepsbt', processed.psbt));
      rt.cli('-rpcwallet=hot', 'walletlock');

      const res = await client.post('/api/admin/tx/broadcast', { wallet: 'hot', raw: final.hex, acceptSpendingOurs: true }, { csrf });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'over-cap');
      assert.deepEqual(JSON.parse(rt.cli('getrawmempool')), [], 'a capped paste sends nothing');
    });
  } finally { await rt.stop(); }
});

describe('paying yourself out of a large coin costs the fee, not the coin', async () => {
  // The correction that the test above was written before: what the cap measures is what
  // LEAVES. A 50 BTC input that returns 49.99999 BTC as change has spent the fee.
  const rt = await regtest();
  try {
    await withSuite(rt, { spend: { capSat: 10_000 } }, async ({ client, csrf }) => {
      const mine = rt.cli('-rpcwallet=hot', 'getnewaddress');
      rt.cli('-rpcwallet=hot', 'walletpassphrase', PASSPHRASE, '60');
      const funded = JSON.parse(rt.cli('-rpcwallet=hot', '-named', 'walletcreatefundedpsbt',
        'outputs=' + JSON.stringify([{ [mine]: 0.002 }]), 'options=' + JSON.stringify({ fee_rate: 5 })));
      const processed = JSON.parse(rt.cli('-rpcwallet=hot', 'walletprocesspsbt', funded.psbt));
      const final = JSON.parse(rt.cli('finalizepsbt', processed.psbt));
      rt.cli('-rpcwallet=hot', 'walletlock');

      // The passphrase: required since 2026-09-19 for any broadcast of this wallet's coins.
      const res = await client.post('/api/admin/tx/broadcast', { wallet: 'hot', raw: final.hex, acceptSpendingOurs: true, passphrase: PASSPHRASE }, { csrf });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.netSat < 10_000, `only the fee left the wallet: ${res.body.netSat} sat`);
      assert.ok(res.body.changeSat > 4_900_000_000, 'the coin came back');
    });
  } finally { await rt.stop(); }
});

describe('a transaction of somebody else\'s is broadcast without cap talk', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      // A second wallet on the same node stands in for "not ours".
      rt.cli('-named', 'createwallet', 'wallet_name=other');
      const theirs = rt.cli('-rpcwallet=other', 'getnewaddress');
      rt.cli('generatetoaddress', '101', theirs);
      const to = rt.cli('-rpcwallet=other', 'getnewaddress');
      const funded = JSON.parse(rt.cli('-rpcwallet=other', '-named', 'walletcreatefundedpsbt',
        'outputs=' + JSON.stringify([{ [to]: 0.003 }]), 'options=' + JSON.stringify({ fee_rate: 5 })));
      const processed = JSON.parse(rt.cli('-rpcwallet=other', 'walletprocesspsbt', funded.psbt));
      const final = JSON.parse(rt.cli('finalizepsbt', processed.psbt));

      const res = await client.post('/api/admin/tx/broadcast', { wallet: 'hot', raw: final.hex }, { csrf });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.spendsOurs, false, 'none of the inputs belong to the named wallet');
      assert.ok(JSON.parse(rt.cli('getrawmempool')).includes(res.body.txid));
    });
  } finally { await rt.stop(); }
});

describe('a fee bump costs the difference, and only the difference', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf, elevate }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      // A deliberately cheap, replaceable transaction to rescue.
      rt.cli('-rpcwallet=hot', 'walletpassphrase', PASSPHRASE, '60');
      const txid = rt.cli('-rpcwallet=hot', '-named', 'sendtoaddress', `address=${to}`, 'amount=0.001', 'fee_rate=1', 'replaceable=true');
      rt.cli('-rpcwallet=hot', 'walletlock');

      // The preview is arithmetic -- no wallet unlock, because typing a passphrase to look
      // at a number is the habit this suite exists to avoid.
      const built = await client.post('/api/admin/tx/bump', { wallet: 'hot', txid, feeRate: 20 }, { csrf });
      assert.equal(built.status, 200, JSON.stringify(built.body));
      assert.equal(built.body.stage, 'preview');
      assert.ok(built.body.deltaSat > 0, 'the replacement pays more');
      assert.ok(built.body.newFeeSat > built.body.oldFeeSat);
      assert.match(built.body.note, /the node computes the real/);
      assert.equal(JSON.parse(rt.cli('-rpcwallet=hot', 'getwalletinfo')).unlocked_until, 0,
        'pricing a bump must not have unlocked the wallet');

      await elevate();
      const done = await client.post('/api/admin/tx/bump/confirm', {
        wallet: 'hot', txid, feeRate: 20, passphrase: PASSPHRASE,
      }, { csrf });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.match(done.body.txid, /^[0-9a-f]{64}$/);
      assert.notEqual(done.body.txid, txid, 'a replacement is a different transaction');
      assert.equal(done.body.replaced, txid);
      assert.ok(done.body.deltaSat > 0);

      const pool = JSON.parse(rt.cli('getrawmempool'));
      assert.ok(pool.includes(done.body.txid));
      assert.ok(!pool.includes(txid), 'the original was replaced');

      // and the wallet did not stay unlocked
      assert.equal(JSON.parse(rt.cli('-rpcwallet=hot', 'getwalletinfo')).unlocked_until, 0);
    });
  } finally { await rt.stop(); }
});

describe('what cannot be bumped is refused with the reason', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      rt.cli('-rpcwallet=hot', 'walletpassphrase', PASSPHRASE, '60');
      const txid = rt.cli('-rpcwallet=hot', '-named', 'sendtoaddress', `address=${to}`, 'amount=0.001', 'replaceable=false');
      rt.cli('-rpcwallet=hot', 'walletlock');

      const res = await client.post('/api/admin/tx/bump', { wallet: 'hot', txid }, { csrf });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'not-replaceable');
      assert.match(res.body.error.message, /did not signal replaceability/);

      const bad = await client.post('/api/admin/tx/bump', { wallet: 'hot', txid: 'not-a-txid' }, { csrf });
      assert.equal(bad.body.error.code, 'txid-invalid');
    });
  } finally { await rt.stop(); }
});

describe('coin control spends the coins you named and no others', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const utxos = await client.get('/api/admin/wallet/utxos?wallet=hot&node=rt');
      const pick = utxos.body.utxos.filter((u) => u.confirmations > 0).slice(0, 1);
      assert.equal(pick.length, 1);

      const to = rt.cli('-rpcwallet=hot', 'getnewaddress');
      const built = await client.post('/api/admin/wallet/send/build', {
        wallet: 'hot', node: 'rt', address: to, amountSat: 100_000,
        inputs: pick.map((u) => ({ txid: u.txid, vout: u.vout })),
      }, { csrf });
      assert.equal(built.status, 200, JSON.stringify(built.body));
      assert.equal(built.body.build.inputs, 1, 'exactly the coin that was named');
      assert.deepEqual(built.body.build.coinControl, pick.map((u) => ({ txid: u.txid, vout: u.vout })));
    });
  } finally { await rt.stop(); }
});
