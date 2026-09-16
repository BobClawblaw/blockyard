// THE 2026-09-16 AUDIT'S LOW FINDINGS IN THE BROWSER CODE, THE HTTP LAYER AND THE DOCS, AS ASSERTIONS
// (docs/SECURITY-AUDIT-2026-09-16.md: L1, L2, L3, L11, L13, L14, L16, I1, I2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withApp } from './helpers/http.js';
import * as fmt from '../public/js/fmt.js';
import { safeNext } from '../public/js/safenext.js';
import { kv, raw, init as initPanels } from '../public/js/panels.js';
import { nextHud } from '../public/js/mining.js';
import { parseRoute } from '../public/js/explorer.js';
import { depthNote } from '../public/js/depthchart.js';
import { chainName, boolOrNull, countOrNull } from '../server/collect/monitor.js';
import { displayUrl, shortPath } from '../server/rpc/client.js';
import { LoginGuard } from '../server/auth/sessions.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOSTILE = '"\'><img src=x onerror=alert(1)>';

test('L1: the post-sign-in redirect stays on this site', () => {
  const origin = 'https://monitor.example:21000';
  assert.equal(safeNext('/#peers', origin), '/#peers');
  assert.equal(safeNext('/explorer?x=1#tx/ab', origin), '/explorer?x=1#tx/ab');
  for (const evil of ['//evil.example/', '/\\evil.example/', '/\\/evil.example', 'https://evil.example/', 'javascript:alert(1)', '', null, undefined, '\\\\evil.example']) {
    assert.equal(safeNext(evil, origin), '/', `${JSON.stringify(evil)} must not leave the site`);
  }
  const login = fs.readFileSync(path.join(ROOT, 'public', 'js', 'login.js'), 'utf8');
  assert.ok(login.includes('safeNext('), 'the sign-in page uses the checked redirect');
  assert.ok(!/startsWith\('\/'\) \? back/.test(login), 'and the old check is gone');
});

test('L2: kv() writes values as text unless they are marked as markup built here', () => {
  initPanels(fmt);
  const out = kv([['chain', `main${HOSTILE}`], ['pruned', HOSTILE], ['n', 5], ['link', raw('<a href="#x">x</a>')]]);
  assert.ok(!out.includes('<img'), `a node string must not become an element: ${out}`);
  assert.ok(out.includes('&lt;img'), 'it is shown as text');
  assert.ok(out.includes('<a href="#x">x</a>'), 'markup this file built passes through raw()');
  const hud = nextHud({ height: HOSTILE, weight: 1, weightLimit: 4000000, txCount: 1, totalFeesSat: 1, feeRate: { p50: HOSTILE, max: 1 }, economy: { marginal: { rate: HOSTILE } }, at: Date.now() }, {}, fmt);
  assert.ok(!hud.includes('<img'), 'the mining panel escapes node values too');
});

test('L2: the server passes on chain, pruned, IBD and unbroadcast only in their own types', () => {
  assert.equal(chainName('main'), 'main');
  assert.equal(chainName('testnet4'), 'testnet4');
  assert.equal(chainName(`main${HOSTILE}`), null);
  assert.equal(chainName(42), null);
  assert.equal(boolOrNull(true), true);
  assert.equal(boolOrNull('true<img>'), null);
  assert.equal(countOrNull(3), 3);
  assert.equal(countOrNull('3<img>'), null);
  assert.equal(countOrNull(-1), null);
  const monitor = fs.readFileSync(path.join(ROOT, 'server', 'collect', 'monitor.js'), 'utf8');
  for (const use of ['chain: chainName(s.chain)', 'pruned: boolOrNull(s.chainInfo?.pruned)', 'ibd: boolOrNull(s.chainInfo?.initialblockdownload)', 'unbroadcast: countOrNull(mi.unbroadcastcount)']) {
    assert.ok(monitor.includes(use), `the snapshot uses ${use}`);
  }
});

test('L3: the RPC endpoint shown to viewers never carries a username or password', () => {
  assert.equal(displayUrl('http://user:secret@127.0.0.1:8332/'), 'http://127.0.0.1:8332/');
  assert.equal(displayUrl('http://127.0.0.1:8332'), 'http://127.0.0.1:8332');
  assert.equal(displayUrl('http://:secret@203.0.113.4:8332/wallet/x'), 'http://203.0.113.4:8332/wallet/x');
  assert.ok(!displayUrl('not a url//u:p@host').includes('u:p@'));
  assert.equal(displayUrl(null), null);
});

test('L11: paths shown to viewers keep the file and its folder, not the directories above', () => {
  assert.equal(shortPath('/home/someone/.bitcoin/.cookie'), '…/.bitcoin/.cookie');
  assert.equal(shortPath('C:\\Users\\someone\\AppData\\Roaming\\Bitcoin\\.cookie'), '…/Bitcoin/.cookie');
  assert.equal(shortPath('main/.cookie'), 'main/.cookie');
  assert.equal(shortPath(null), null);
});

test('L11: in open mode no anonymous response carries an absolute server path', async () => {
  await withApp({ auth: false }, async ({ client, dir }) => {
    const leaks = [];
    for (const p of ['/api/state', '/api/telemetry', '/api/settings', '/api/config', '/api/about', '/api/nodes', '/api/health']) {
      const r = await client.get(p);
      const text = JSON.stringify(r.body ?? '');
      if (text.includes(dir)) leaks.push(`${p} contains the data directory`);
    }
    assert.deepEqual(leaks, []);
  });
});

test('L13: a malformed percent escape in a route parameter is a 400, not a 500', async () => {
  await withApp({ auth: false }, async ({ port }) => {
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/users/%E0%A4%A/role', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      req.end('{}');
    });
    assert.equal(status, 400);
  });
});

test('L14: failures from one address cannot lock the account for another address', () => {
  const g = new LoginGuard({ maxAttempts: 8, windowMs: 60_000, lockoutMs: 60_000 });
  for (let i = 0; i < 8; i++) g.noteFailure('admin', '203.0.113.9');
  assert.equal(g.status('admin', '203.0.113.9').blocked, true, 'the guessing address is locked for that account');
  assert.equal(g.status('admin', '198.51.100.20').blocked, false, 'the owner signing in from elsewhere is not');
  assert.equal(g.status('alice', '203.0.113.9').blocked, false, 'and other accounts behind the same address are not');
  // a spray across many accounts from one address still locks that address
  const s = new LoginGuard({ maxAttempts: 8, windowMs: 60_000, lockoutMs: 60_000 });
  for (let i = 0; i < 40; i++) s.noteFailure(`user${i}`, '192.0.2.50');
  assert.equal(s.status('newuser', '192.0.2.50').blocked, true, 'a spray locks its address');
  assert.equal(s.status('newuser', '192.0.2.51').blocked, false);
  // a grind on one account from many addresses still locks the account, at a real attack's volume
  const d = new LoginGuard({ maxAttempts: 8, windowMs: 60_000, lockoutMs: 60_000 });
  for (let i = 0; i < 79; i++) d.noteFailure('admin', `198.51.100.${i % 200}`);
  assert.equal(d.status('admin', '203.0.113.200').blocked, false);
  d.noteFailure('admin', '198.51.100.99');
  assert.equal(d.status('admin', '203.0.113.200').blocked, true);
});

test('I1: a malformed explorer link routes home instead of throwing', () => {
  assert.deepEqual(parseRoute('tx/%E0'), { kind: 'home' });
  assert.deepEqual(parseRoute('block/%'), { kind: 'home' });
  assert.equal(parseRoute('tx/abc').kind, 'tx');
});

test('I2: the market depth note escapes a server note', () => {
  const note = depthNote({ enabled: false, note: HOSTILE }, fmt);
  assert.ok(!note.includes('<img'));
});

test('L16: the security docs match the code', () => {
  const policy = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  assert.ok(/\| 0\.1\.x \| yes \|/.test(policy), 'the supported version is the current line');
  assert.ok(!/never released/.test(policy), 'released versions are not called unreleased');
  const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'smoke.sh'), 'utf8');
  assert.ok(!/OFF by default/.test(smoke), 'the smoke script no longer says accounts are off by default');
  assert.ok(/BLOCKYARD_AUTH=0[^\n]*\\\n[^\n]*OPEN_DIR/.test(smoke), 'and its open-access instance actually opens access');
  const conf = fs.readFileSync(path.join(ROOT, 'docs', 'CONFIGURATION.md'), 'utf8');
  assert.ok(/\| `BLOCKYARD_AUTH` \| `auth\.enabled` \| boolean \| `true` \|/.test(conf));
  const sec = fs.readFileSync(path.join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
  assert.ok(!/has no\s+wallet access/.test(sec));
});
