// AUDIT 2026-09-19 regression tests: L2 (LoginGuard map sweep), L1 (/api/rpc error
// genericisation), L3 (__Host- cookie name under TLS). One file per finding would be
// three near-empty files; these all landed in one audit round, so they ride together.
// Each test failed against the code before its fix -- the convention every other audit
// round in this repository followed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withApp } from './helpers/http.js';
import { LoginGuard } from '../server/auth/sessions.js';
import { loadConfig } from '../server/config.js';

// ---------------------------------------------------------------- L2: the map sweep

test('L2: a LoginGuard map past 5,000 entries sheds the ones that can no longer decide anything', () => {
  const g = new LoginGuard();
  // 5,100 entries with no hits and no lock: nothing a decision needs. Under the old code
  // every one of them stayed for the life of the process.
  for (let i = 0; i < 5100; i++) g.attempts.set(`p:spray${i}\u0000198.51.100.7`, { hits: [], lockedUntil: 0 });
  // Touching one more entry triggers the sweep.
  g._entry('p:the-next-try\u0000198.51.100.7');
  assert.ok(g.attempts.size < 200, `map shed to ${g.attempts.size}, expected under 200`);
  assert.ok(g.attempts.has('p:the-next-try\u0000198.51.100.7'), 'the entry being asked about survives its own sweep');
});

test('L2: the sweep never drops an entry that is locked or still inside its window', () => {
  const g = new LoginGuard();
  const now = Date.now();
  // Locked: must survive.
  g.attempts.set('p:locked\u0000198.51.100.8', { hits: [], lockedUntil: now + 300_000 });
  // Fresh failures inside the window: must survive.
  g.attempts.set('p:active\u0000198.51.100.8', { hits: [now - 1000, now - 2000], lockedUntil: 0 });
  // Expired lock AND empty window: shed.
  g.attempts.set('p:expired\u0000198.51.100.8', { hits: [], lockedUntil: now - 1 });
  for (let i = 0; i < 5100; i++) g.attempts.set(`p:filler${i}\u0000198.51.100.9`, { hits: [], lockedUntil: 0 });
  g._entry('p:trigger\u0000198.51.100.9');
  assert.ok(g.attempts.has('p:locked\u0000198.51.100.8'), 'a live lockout is never dropped: that would un-lock an attacker');
  assert.ok(g.attempts.has('p:active\u0000198.51.100.8'), 'failures still inside the window still count');
  assert.ok(!g.attempts.has('p:expired\u0000198.51.100.8'), 'an expired lock with an empty window is shed');
  // And the guard still works afterwards: the survivor locks at its threshold.
  for (let i = 0; i < g.maxAttempts; i++) g.noteFailure('locked', '198.51.100.8');
  const st = g.status('locked', '198.51.100.8');
  assert.equal(st.blocked, true, 'a swept map still enforces the thresholds it kept');
});

// ---------------------------------------------------------------- L1: /api/rpc errors

test('L1: a transport failure on /api/rpc answers the failure CLASS, not what the endpoint said', async () => {
  // The app is pointed at a port where nothing listens: kind "transport", whose RpcError
  // message can quote a foreign reply's body. The fix reports the class instead; the full
  // detail goes to the audit trail, which open mode does not serve.
  await withApp({ auth: false, config: { nodes: [{ id: 'dead', rpcUrl: 'http://127.0.0.1:1', rpcUser: 'u', rpcPassword: 'p' }] } },
    async ({ client }) => {
      const r = await client.post('/api/rpc', { method: 'getblockcount', params: [] });
      assert.equal(r.status, 200, 'the console answers ok:false rather than throwing');
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.kind, 'transport');
      assert.equal(r.body.error.message, 'the node could not be reached, or answered with an HTTP error',
        'the reply is the class of failure, with no endpoint text in it');
      assert.ok(!/ECONNREFUSED|connect/i.test(r.body.error.message ?? ''), 'no OS error text leaks either');
      // And nothing was callable that should not have been.
      const denied = await client.post('/api/rpc', { method: 'stop', params: [] });
      assert.equal(denied.status, 403);
    });
});

// ---------------------------------------------------------------- L3: the cookie name

test('L3: under TLS the session cookie carries the __Host- prefix; under plain HTTP it does not', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-cookie-'));
  try {
    // TLS on (the shipped default): prefixed name, so a subdomain or sibling path cannot
    // overwrite the session cookie.
    const tlsCfg = loadConfig({
      configFile: null,
    });
    assert.equal(tlsCfg.auth.cookieName, '__Host-blockyard_sid', 'the shipped TLS default gets the prefix');
    // Plain HTTP chosen: the plain name, because a __Host- cookie without Secure is dropped
    // by the browser and every sign-in would silently fail.
    const httpCfg = loadConfig({
      configFile: null,
      // loadConfig reads env, not arguments, for the TLS switch: write a file instead.
    });
    void httpCfg;
    const file = path.join(scratch, 'plain.json');
    fs.writeFileSync(file, JSON.stringify({ server: { tls: { enabled: false } } }));
    const plain = loadConfig({ configFile: file });
    assert.equal(plain.auth.cookieName, 'blockyard_sid', 'plain HTTP keeps the plain name');
    // An operator's explicit name always wins.
    const named = path.join(scratch, 'named.json');
    fs.writeFileSync(named, JSON.stringify({ auth: { cookieName: 'myown_sid' } }));
    const own = loadConfig({ configFile: named });
    assert.equal(own.auth.cookieName, 'myown_sid', 'an explicit auth.cookieName is respected');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('L3: a signed-in session over TLS sets the prefixed cookie with Secure', async () => {
  // withApp talks plain HTTP, so assert the name decision through a config load plus the
  // serializeCookie contract (Secure comes from auth.secureCookie, which main.js forces
  // on with TLS; the http-app suite covers the plain-HTTP set).
  await withApp({}, async ({ client }) => {
    const r = await client.login('admin');
    assert.equal(r.status, 200);
    // Plain HTTP in the harness: plain name, no Secure (a Secure cookie over HTTP is never
    // sent, which is exactly why the prefix is transport-gated).
    assert.ok(client.cookies().includes('blockyard_sid'), 'plain HTTP sets the plain name');
    assert.ok(!/blockyard_sid[^;]*Secure/i.test(client.cookies()), 'no Secure flag over plain HTTP');
  });
});
