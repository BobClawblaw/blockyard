// A throwaway Bitcoin Core REGTEST node, and BlockYard booted against it.
//
// The same scaffolding as test/admin-send-regtest.test.js and
// test/admin-txtools-regtest.test.js (which keep their own copies, written first), lifted
// here for the money-safety tests of 2026-09-19 because those needed three things the
// copies do not offer: more than one mature coin (two concurrent sends from one coinbase
// is a test of "insufficient funds", not of the cap), a second session, and a way to name
// several wallets.
//
// Everything lives under the OS temp directory, on a port the OS said was free, with
// coins worth nothing. It never touches a wallet on this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { withApp, makeClient } from './http.js';
import { __resetElevations } from '../../server/admin/elevation.js';
import { __resetPending, __resetSpent } from '../../server/admin/send.js';

export const PASSPHRASE = 'correct-horse-battery';
export const CANDIDATES = [
  process.env.BITCOIND,
  '/mnt/nvme8tb/core-build/bitcoin-v31.1/build/bin/bitcoind',
  '/usr/local/bin/bitcoind',
  '/usr/bin/bitcoind',
].filter(Boolean);
export const BITCOIND = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
const CLI = BITCOIND ? path.join(path.dirname(BITCOIND), 'bitcoin-cli') : null;

/**
 * A regtest node with an encrypted wallet `hot` holding `mature` spendable coinbases.
 *
 * `mature` defaults to 10: 100 blocks for maturity plus ten to spend, so two sends in
 * flight at once each have a coin of their own.
 */
export async function regtest({ mature = 10 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-money-'));
  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const conf = path.join(dir, 'bitcoin.conf');
  fs.writeFileSync(conf, ['regtest=1', 'server=1', 'rpcuser=rt', 'rpcpassword=rtpass', 'fallbackfee=0.0002',
    '[regtest]', `rpcport=${port}`, 'listen=0', 'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1'].join('\n'));
  const cli = (...args) => execFileSync(CLI, [`-datadir=${dir}`, `-conf=${conf}`, ...args], { encoding: 'utf8' }).trim();
  const json = (...args) => JSON.parse(cli(...args));
  const child = spawn(BITCOIND, [`-datadir=${dir}`, `-conf=${conf}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { cli('getblockchaininfo'); break; } catch (err) {
      if (child.exitCode != null || Date.now() > deadline) throw new Error(`regtest node did not come up: ${stderr.trim().split('\n')[0] || err.message}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  cli('-named', 'createwallet', 'wallet_name=hot', `passphrase=${PASSPHRASE}`);
  const addr = cli('-rpcwallet=hot', 'getnewaddress');
  cli('generatetoaddress', String(100 + mature), addr);
  return {
    dir, port, cli, json, addr, url: `http://127.0.0.1:${port}`,
    mempool: () => json('getrawmempool'),
    unlockedUntil: (w = 'hot') => json(`-rpcwallet=${w}`, 'getwalletinfo').unlocked_until,
    async stop() {
      try { cli('stop'); } catch { /* already gone */ }
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A second wallet on the node, unencrypted, with coins of its own. `named` is only a
 * label for the reader: whether BlockYard may touch it is admin.wallets' business.
 */
export function fundWallet(rt, name, blocks = 2) {
  rt.cli('-named', 'createwallet', `wallet_name=${name}`);
  const a = rt.cli(`-rpcwallet=${name}`, 'getnewaddress');
  rt.cli('generatetoaddress', String(blocks), a);
  // Bury them past maturity. The burying blocks pay `hot`, which has coins to spare and
  // whose balance no test here reads as a total.
  rt.cli('generatetoaddress', '100', rt.addr);
  return a;
}

/**
 * A signed transaction built outside the suite: these inputs, these outputs, signed by
 * `wallet` (unlocked for the purpose when it is `hot`). Replaceable, so a later one can
 * conflict with an earlier one the way an operator's double spend would.
 */
export function signedTx(rt, wallet, inputs, outputs) {
  const raw = rt.cli('createrawtransaction', JSON.stringify(inputs), JSON.stringify(outputs), '0', 'true');
  if (wallet === 'hot') rt.cli('-rpcwallet=hot', 'walletpassphrase', PASSPHRASE, '30');
  try {
    const signed = rt.json(`-rpcwallet=${wallet}`, 'signrawtransactionwithwallet', raw);
    if (!signed.complete) throw new Error(`could not sign: ${JSON.stringify(signed.errors)}`);
    return signed.hex;
  } finally {
    if (wallet === 'hot') rt.cli('-rpcwallet=hot', 'walletlock');
  }
}

/** Mature coins of a wallet, biggest first, as { txid, vout, amount }. */
export function coins(rt, wallet = 'hot') {
  return rt.json(`-rpcwallet=${wallet}`, 'listunspent', '100')
    .map((u) => ({ txid: u.txid, vout: u.vout, amount: u.amount }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * BlockYard pointed at the node, signed in, granted wallet access and elevated.
 *
 * `admin` is merged over a default admin block; `node` over the default node entry. The
 * callback gets `session()`, which opens ANOTHER signed-in, elevated session on the same
 * account -- a second browser, for the races.
 */
export async function withSuite(rt, { admin = {}, node = {} } = {}, fn) {
  __resetElevations(); __resetPending(); __resetSpent();
  return withApp({
    nodes: 1,
    config: {
      nodes: [{
        id: 'rt', label: 'regtest', rpcUrl: rt.url, rpcUser: 'rt', rpcPassword: 'rtpass',
        chainHint: 'regtest', datadir: rt.dir, logFile: null, ...node,
      }],
      admin: {
        enabled: true, allowInsecure: true, wallets: [{ node: 'rt', wallet: 'hot' }], elevationMs: 60_000, addressBook: [],
        ...admin,
        spend: { capSat: 5_000_000, capSat24h: null, mainnetPhrase: true, ...(admin.spend ?? {}) },
      },
    },
  }, async (h) => {
    const open = async (client) => {
      const s = await client.login('admin', h.client.adminPassword);
      const elevate = () => client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
      await elevate();
      return { client, csrf: s.csrf, elevate };
    };
    const first = await open(h.client);
    await h.client.post('/api/admin/users/admin/wallet-access', { walletAccess: true }, { csrf: first.csrf });
    const session = () => open(makeClient(h.base, h.app));
    return fn({ ...h, ...first, session });
  });
}
