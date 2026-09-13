// THE NODE-CONNECTION FORM'S TEETH.
//
// An audit on 2026-09-13 found, and proved with a working exploit, that POST /api/config/node/test
// would send the monitor's own node RPC credential to any URL the caller named -- on a request
// that needed no session and no CSRF token, because with accounts off (the shipped default) there
// is no session, and the double-submit check only runs when there is one.
//
// Three things were wrong at once, so there are three sets of tests here:
//   1. the probe inherited `nodes[0]`, whose datadir resolveCookie() reads the real .cookie from;
//   2. the route is reachable without an account by design (configWriteAllowed only demands admin
//      when accounts are ON);
//   3. a cross-site HTML form reaches it -- readBody accepts x-www-form-urlencoded, so the post is
//      a "simple request" with no preflight to stop it.
//
// The first test below is the original proof of concept, inverted into an assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { withApp } from './helpers/http.js';

/** A stand-in for the attacker's collector: records what the monitor sends it. */
async function collector() {
  let seen = null;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization ?? null, body: b.slice(0, 300) };
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen: () => seen, stop: () => new Promise((r) => srv.close(r)) };
}

test('the probe never sends the node credential to an endpoint it was merely asked about', async () => {
  // THE REGRESSION THIS FILE EXISTS FOR. Before the fix this assertion failed: the collector
  // received `Authorization: Basic <the planted cookie>`.
  const sink = await collector();
  try {
    await withApp({ auth: false }, async ({ client, dir }) => {
      fs.mkdirSync(path.join(dir, 'main'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'main', '.cookie'), 'realuser:SUPER-SECRET-COOKIE-VALUE\n');

      const r = await client.post('/api/config/node/test', { rpcUrl: `http://127.0.0.1:${sink.port}/`, datadir: dir });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      await new Promise((res) => setTimeout(res, 400));
      const seen = sink.seen();
      assert.ok(seen, 'the probe should still reach the endpoint -- the point is WHAT it sends');
      assert.equal(seen.auth, null,
        `the monitor sent a credential to an endpoint it is not configured for: ${seen.auth}`);
      assert.equal(r.body.authenticated, false, 'and it must say that authentication was not tested');
    });
  } finally { await sink.stop(); }
});

test('a datadir named by the caller cannot be used to resolve a credential for somewhere else', async () => {
  // Dropping the `...nodes[0]` spread alone would NOT have been enough: candidateNode falls back to
  // the configured datadir, and the caller may name one outright. The rule is about the
  // destination, so naming the real datadir must not change the answer.
  const sink = await collector();
  try {
    await withApp({ auth: false }, async ({ client, dir }) => {
      fs.mkdirSync(path.join(dir, 'main'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'main', '.cookie'), 'realuser:SUPER-SECRET-COOKIE-VALUE\n');
      await client.post('/api/config/node/test', { rpcUrl: `http://127.0.0.1:${sink.port}/`, datadir: dir, chainHint: 'main' });
      await new Promise((res) => setTimeout(res, 400));
      assert.equal(sink.seen()?.auth ?? null, null, 'naming the datadir must not unlock the cookie for a foreign endpoint');
    });
  } finally { await sink.stop(); }
});

test('probing the endpoint the monitor IS configured for still authenticates', async () => {
  // The fix must not break the thing the form is for: re-testing the connection you already have.
  await withApp({ auth: false }, async ({ client, app }) => {
    const node = app.cfg.nodes[0];
    const r = await client.post('/api/config/node/test', { rpcUrl: node.rpcUrl, datadir: node.datadir, chainHint: 'main' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, 'the fake node should answer');
    assert.equal(r.body.authenticated, true, 'the configured endpoint is the one credentials are for');
  });
});

// ------------------------------------------------------- cross-site, with accounts OFF

const CROSS = { Origin: 'http://evil.example', 'Content-Type': 'application/json' };

test('a cross-site Origin is refused on every state-changing route, even with accounts off', async () => {
  await withApp({ auth: false }, async ({ base, app }) => {
    for (const [p, body] of [
      ['/api/config/node/test', { rpcUrl: 'http://127.0.0.1:1', datadir: '/tmp' }],
      ['/api/config/node', { rpcUrl: 'http://127.0.0.1:1', datadir: '/tmp', confirm: 'save' }],
      ['/api/settings', { settings: { version: 3 } }],
    ]) {
      const res = await fetch(base + p, { method: 'POST', headers: CROSS, body: JSON.stringify(body) });
      assert.equal(res.status, 403, `${p} accepted a cross-site POST`);
      const j = await res.json().catch(() => null);
      assert.equal(j?.error?.kind, 'csrf', `${p} refused for the wrong reason: ${JSON.stringify(j)}`);
    }
    assert.ok(app, 'app booted');
  });
});

test('Sec-Fetch-Site alone is enough to refuse, when a browser sends no Origin', async () => {
  await withApp({ auth: false }, async ({ base }) => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ settings: { version: 3 } }),
    });
    assert.equal(res.status, 403);
  });
});

test('a same-origin request still works, and so does a non-browser client', async () => {
  // The check must not break the app itself, nor curl: a client that sends neither header is not
  // the threat this addresses -- it can already reach the port.
  await withApp({ auth: false }, async ({ base, client }) => {
    const same = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ settings: { version: 3, space: { dome: 5 } } }),
    });
    assert.equal(same.status, 200, 'the app posting to itself must still work');

    const bare = await client.post('/api/settings', { settings: { version: 3, space: { dome: 6 } } });
    assert.equal(bare.status, 200, 'a client sending neither header is unaffected');
  });
});
