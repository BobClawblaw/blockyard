// DAEMON CONTROL (docs/PLAN-ADMIN-SUITE.md §6, M6).
//
// The interesting case is not the happy one. It is the node that stops and does not come
// back — because BlockYard does not start it, cannot see the unit file, and has only the
// operator's word that anything will. A suite that reported "restarted" there would have
// lied about the one thing that mattered, so that is what most of this file tests.
//
// The stop itself runs against a real regtest node, since "did the process actually go
// away" is not a question a fake can answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';
import { daemonActions, supervisorOf } from '../server/admin/daemon.js';

const CANDIDATES = [
  process.env.BITCOIND,
  '/mnt/nvme8tb/core-build/bitcoin-v31.1/build/bin/bitcoind',
  '/usr/local/bin/bitcoind',
  '/usr/bin/bitcoind',
].filter(Boolean);
const BITCOIND = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
const CLI = BITCOIND ? path.join(path.dirname(BITCOIND), 'bitcoin-cli') : null;

async function regtest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-daemon-'));
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
  return {
    dir, port, cli, child, url: `http://127.0.0.1:${port}`,
    running: () => child.exitCode == null,
    async stop() {
      try { cli('stop'); } catch { /* already gone */ }
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 5000); });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withSuite(rt, nodeExtra, fn) {
  __resetElevations();
  return withApp({
    nodes: 1,
    config: {
      nodes: [{ id: 'rt', label: 'regtest', rpcUrl: rt.url, rpcUser: 'rt', rpcPassword: 'rtpass', chainHint: 'regtest', datadir: rt.dir, logFile: null, ...nodeExtra }],
      admin: { enabled: true, allowInsecure: true, wallets: [], elevationMs: 60_000, spend: { capSat: 1000 } },
    },
  }, async (h) => {
    const s = await h.client.login('admin', h.client.adminPassword);
    const elevate = () => h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
    await elevate();
    return fn({ ...h, csrf: s.csrf, elevate });
  });
}

const describe = BITCOIND ? test : test.skip;
test('there is a bitcoind to drive the daemon tests', { skip: BITCOIND ? false : 'no bitcoind found' }, () => {
  assert.equal(fs.existsSync(BITCOIND), true);
});

// ------------------------------------------------------------- no node needed

test('a node with no supervisor is not offered a Restart button', () => {
  const app = { monitors: new Map([['n', { cfg: {} }]]) };
  const actions = daemonActions(app, 'n');
  assert.equal(actions.restart.allowed, false);
  assert.match(actions.restart.note, /no supervisor is configured/);
  // And the stop is labelled for what it is.
  assert.equal(actions.stop.label, 'Shut down');
  assert.match(actions.stop.note, /STAYS stopped/);
});

test('a node with a supervisor is, and the note says who', () => {
  const app = { monitors: new Map([['n', { cfg: { supervisor: 'systemd:bitcoind' } }]]) };
  const actions = daemonActions(app, 'n');
  assert.equal(actions.restart.allowed, true);
  assert.match(actions.restart.note, /systemd:bitcoind/);
  assert.match(actions.stop.note, /starts it again/);
  assert.deepEqual(supervisorOf(app, 'n'), { raw: 'systemd:bitcoind', kind: 'systemd', unit: 'bitcoind', restarts: true });
});

test('docker and supervisor count; a typo does not', () => {
  const mk = (supervisor) => daemonActions({ monitors: new Map([['n', { cfg: { supervisor } }]]) }, 'n');
  assert.equal(mk('docker:bitcoin').restart.allowed, true);
  assert.equal(mk('supervisor:bitcoind').restart.allowed, true);
  assert.equal(mk('systemdd:bitcoind').restart.allowed, false, 'an unrecognised supervisor must not be assumed to restart anything');
  assert.equal(mk('none').restart.allowed, false);
  assert.equal(mk(undefined).restart.allowed, false);
});

// -------------------------------------------------------------- against a node

describe('stopping a node actually stops it, and says it will stay stopped', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const actions = await client.get('/api/admin/node/actions?node=rt');
      assert.equal(actions.body.restart.allowed, false, 'no supervisor configured for this node');

      // The confirmation is the node's own id, typed.
      const unconfirmed = await client.post('/api/admin/node/stop', { node: 'rt' }, { csrf });
      assert.equal(unconfirmed.status, 400);
      assert.equal(unconfirmed.body.error.code, 'confirm-required');

      const wrong = await client.post('/api/admin/node/stop', { node: 'rt', confirm: 'yes' }, { csrf });
      assert.equal(wrong.status, 400, 'anything but the id is not a confirmation');

      // Neither refusal above may have cost the elevation: a mistyped confirmation must
      // not make the operator type their password again (and again, until they stop
      // reading the prompt).
      const still = await client.get('/api/admin/status');
      assert.equal(still.body.elevation.elevated, true, 'a refused confirmation must not consume the elevation');

      const res = await client.post('/api/admin/node/stop', { node: 'rt', confirm: 'rt' }, { csrf });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.state, 'stopped');
      assert.equal(res.body.action, 'stop');
      assert.ok(res.body.downInMs >= 0, 'it watched the node actually go');
      assert.match(res.body.message, /STAYS stopped/);
      assert.equal(typeof res.body.heightBefore, 'number');

      // The process really is gone, which is the thing a fake could not have shown. Waited for,
      // not slept for: RPC goes quiet before bitcoind has flushed and exited, and under the full
      // suite's load that took longer than the fixed 500 ms this used to sleep (2026-09-19: failed
      // once in two full runs, passed 8/8 alone). The claim is that it exits, not how fast.
      if (rt.running()) await new Promise((r) => { rt.child.once('exit', r); setTimeout(r, 30_000); });
      assert.equal(rt.running(), false, 'the bitcoind process exited');

      // and the successful one DID consume it
      const after = await client.get('/api/admin/status');
      assert.equal(after.body.elevation.elevated, false, 'one password, one stop');
    });
  } finally { await rt.stop(); }
});

describe('a restart of a node nothing restarts is refused, not attempted', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      const res = await client.post('/api/admin/node/stop', { node: 'rt', confirm: 'rt', restart: true }, { csrf });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'no-supervisor');
      assert.match(res.body.error.message, /stopping it would simply stop it/);
      // And it is still running: a refused restart must not have stopped anything.
      assert.equal(rt.running(), true, 'the node was not stopped by a refused restart');
    });
  } finally { await rt.stop(); }
});

describe('a restart whose node never comes back says so, rather than claiming success', async () => {
  // The node is CONFIGURED as if systemd would restart it; nothing actually will. That is
  // the operator's mistake this report exists to make visible.
  const rt = await regtest();
  try {
    await withSuite(rt, { supervisor: 'systemd:not-really' }, async ({ client, csrf }) => {
      const res = await client.post('/api/admin/node/stop', { node: 'rt', confirm: 'rt', restart: true, waitMs: 3000 }, { csrf });
      assert.equal(res.status, 200, 'the call completes: this is a report, not an error');
      assert.equal(res.body.ok, false);
      assert.equal(res.body.state, 'did-not-return');
      assert.match(res.body.message, /has NOT come back/);
      assert.match(res.body.message, /systemd:not-really/, 'it names who was supposed to start it');
    });
  } finally { await rt.stop(); }
});

describe('stopping a node needs the password, and consumes it', async () => {
  const rt = await regtest();
  try {
    await withSuite(rt, {}, async ({ client, csrf }) => {
      await client.post('/api/admin/elevate/drop', {}, { csrf });
      const refused = await client.post('/api/admin/node/stop', { node: 'rt', confirm: 'rt' }, { csrf });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.code, 'elevation-required');
      assert.equal(rt.running(), true, 'refused before anything happened to the node');
    });
  } finally { await rt.stop(); }
});
