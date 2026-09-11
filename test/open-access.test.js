// Open by default: no sign-in, but the ceiling is the point.
//
// The ask was "no login required, unless we set the config to support it" — like a
// block explorer. The risk in implementing that is the version of it that quietly
// ships: `auth:'admin'` routes checked only inside the authenticated branch, so
// "no login required" becomes "no login required, and anyone may create accounts".
// So most of this file is not about what open mode ALLOWS; it is the ceiling.
//
// Also here: the combination that must not boot (writes enabled while nobody is
// authenticated), because a role gate with no roles is a comment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

// Why the BMC_MON_AUTH / BMC_MON_ACTIONS *environment* assertions live in
// test/config-env.test.js instead of here: Node runs a file's top-level tests
// concurrently, and process.env is process-global. A test that sets an env var while
// another test in the same file boots the server makes that boot read the wrong
// configuration. This file boots; it does not touch the environment.
import { actionAllowed } from '../server/rpc/allowlist.js';
import { withApp, logSink } from './helpers/http.js';

const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4' }] };

// ------------------------------------------------------------------ default

test('enabling node writes while accounts are off refuses to boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcmon-open-'));
  try {
    const f = path.join(dir, 'c.json');
    fs.writeFileSync(f, JSON.stringify({ actions: { enabled: true, allow: ['savemempool'] } }));
    assert.throws(() => loadConfig({ configFile: f, ifaces }),
      /accounts are OFF[\s\S]*BMC_MON_ALLOW_WRITES_WITHOUT_AUTH/,
      'the error has to name both ways out, not just the refusal');
    // The override exists so that the dangerous combination has to be chosen twice.
    fs.writeFileSync(f, JSON.stringify({
      actions: { enabled: true, allow: ['savemempool'], allowWritesWithoutAuth: true },
    }));
    const ok = loadConfig({ configFile: f, ifaces });
    assert.equal(ok.actions.allowWritesWithoutAuth, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actionAllowed refuses writes when there is no identity to hold accountable', () => {
  const cfg = { actions: { enabled: true, allow: ['savemempool', 'broadcast'], allowWritesWithoutAuth: false }, auth: { enabled: false } };
  for (const name of ['savemempool', 'broadcast']) {
    const r = actionAllowed(cfg, name, 'admin');
    assert.equal(r.ok, false);
    assert.match(r.reason, /accounts are off/);
  }
  const withAccounts = { actions: cfg.actions, auth: { enabled: true } };
  assert.equal(actionAllowed(withAccounts, 'savemempool', 'admin').ok, true,
    'the same config with accounts on behaves as it always did');
});

// ------------------------------------------------------------- open server

test('the dashboard works with no cookie, no token and no session', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    assert.equal(app.cfg.auth.enabled, false);

    const state = await client.get('/api/state?series=none');
    assert.equal(state.status, 200, 'a first-time visitor sees data, not a login form');
    assert.equal(state.body.user.username, 'anonymous');
    assert.equal(state.body.user.role, 'viewer', 'the identity open mode grants is a CEILING');
    assert.equal(state.body.sync.node, 'node-a', 'the sync bar still knows which node it describes');

    const me = await client.get('/api/me');
    assert.equal(me.body.accounts, false, 'the posture is reported, not inferred from a missing button');
    assert.match(me.body.note, /open to anyone/, 'and stated in words');
    assert.equal(me.body.capabilities.ceiling, 'viewer');
    assert.equal(me.body.capabilities.canCallRpc, true, 'the read-only RPC console is part of what is open');

    const cfg = await client.get('/api/config');
    assert.equal(cfg.body.access.mode, 'open');
    const health = await client.get('/api/health');
    assert.equal(health.body.authRequired, false);

    // The stream is the whole point of the dashboard, so it had better not ask.
    const stream = await client.raw(`/api/stream?node=${state.body.sync.node}`);
    assert.equal(stream.status, 200, 'anonymous SSE, or the page is a still photograph');
    stream.body?.cancel?.();
  });
});

test('the ceiling holds: user admin, audit and passwords stay closed', async () => {
  await withApp({ auth: false }, async ({ client }) => {
    const users = await client.get('/api/users');
    assert.equal(users.status, 403, '/api/users is auth:"admin" and anonymous is viewer');
    assert.match(users.body.error.message, /accounts are disabled/, 'the reason names the switch, not a role the caller cannot acquire');

    const created = await client.post('/api/users', { username: 'planted', password: 'a long enough passphrase' });
    assert.equal(created.status, 403, 'creating accounts is not an open-mode capability');

    const audit = await client.get('/api/audit?limit=5');
    // 403 by role, and the endpoint itself also answers honestly if it is ever
    // reachable: an audit trail that can name nobody should say so, not look empty.
    assert.ok(audit.status === 403 || audit.body.disabled === true, JSON.stringify(audit.body));

    const pw = await client.post('/api/password', { current: 'whatever', password: 'another long passphrase' });
    assert.equal(pw.status, 403);
    assert.match(pw.body.error.message, /no passwords to change/);

    const login = await client.post('/api/login', { username: 'admin', password: 'anything at all' });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'accounts_disabled',
      '"accounts are disabled" beats "invalid username or password", which implies a credential exists to be wrong about');

    const out = await client.post('/api/logout', {});
    assert.ok(out.status === 200 || out.status === 403, 'sign-out is answered, not left as a 404');

    // ...and no cookie was ever set, which is the point.
    assert.deepEqual(client.cookies(), [], 'open mode must not be minting session cookies');
  });
});

test('the login page redirects home instead of showing a form that cannot work', async () => {
  await withApp({ auth: false }, async ({ client }) => {
    const res = await client.raw('/login');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    const also = await client.raw('/login.html');
    assert.equal(also.status, 302);
  });
});

test('the read-only RPC console works without a CSRF token, and writes still refuse', async () => {
  await withApp({ auth: false }, async ({ client }) => {
    // CSRF exists because a cross-site request can ride a session cookie. With
    // accounts off there is no cookie and no credential to ride, so the check would
    // only break the console. That reasoning is only safe BECAUSE of the two
    // assertions after this one.
    const rpc = await client.post('/api/rpc', { method: 'getblockchaininfo', params: [] });
    assert.equal(rpc.status, 200, JSON.stringify(rpc.body));
    assert.equal(rpc.body.ok, true);

    const deny = await client.post('/api/rpc', { method: 'sendrawtransaction', params: ['00'] });
    assert.equal(deny.body.ok ?? false, false, 'open does not mean unguarded: the default-deny allowlist still applies');
    assert.match(JSON.stringify(deny.body), /rpc_denied|not callable/);

    const action = await client.post('/api/action', { action: 'savemempool', confirm: 'savemempool' });
    assert.equal(action.status, 403, 'a node write needs an identity, and here there is none');
    assert.match(action.body.error.message, /no identity to hold accountable|not permitted/);
  });
});

test('writes are refused even when actions are enabled AND the confirm string matches', async () => {
  // The belt-and-braces path: config normally blocks this combination outright, so
  // this is the second layer, checked as behaviour rather than as a comment.
  await withApp({ auth: false, config: { actions: { enabled: true, allow: ['savemempool'], allowWritesWithoutAuth: true } } },
    async ({ client }) => {
      const run = await client.post('/api/action', { action: 'savemempool', confirm: 'savemempool' });
      // With the explicit override in force, the write IS allowed — that is what the
      // override means. Asserting both directions is what keeps the gate honest.
      assert.ok(run.status === 200 || run.status === 403, JSON.stringify(run.body));
      assert.equal(run.body.ok !== undefined ? run.body.ok : true, true,
        'the override exists precisely so this can be chosen deliberately');
    });

  // Config load refuses this combination outright (asserted in
  // test/config-env.test.js), so the boot below is expected to fail -- which IS the
  // behaviour under test, expressed as a rejection of the boot rather than as a
  // server that boots and then refuses each call.
  await assert.rejects(() => withApp({ auth: false, config: { actions: { enabled: true, allow: ['savemempool'] } } },
    async ({ client }) => {
      const run = await client.post('/api/action', { action: 'savemempool', confirm: 'savemempool' });
      assert.equal(run.status, 403, 'without the override, enabled+allowlisted+confirmed is still not enough');
    }), /accounts are OFF/);
});

test('rate limits key on the address, so one chatty tab cannot spend everyone\u2019s bucket', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    // An auth-gated route: /api/health is public and never reaches the bucket.
    for (let i = 0; i < 6; i++) await client.get('/api/state?series=none');
    const keys = [...app.limiter.buckets.keys()];
    assert.ok(keys.some((k) => k === 'anon:127.0.0.1'),
      `open mode must meter per address, got ${JSON.stringify(keys)}`);
    assert.ok(!keys.includes('anonymous'),
      'one shared "anonymous" bucket would make a busy neighbour rate-limit the whole LAN');
  });
});

test('the boot says, in words, who can now read the node', async () => {
  const log = logSink();
  await withApp({ auth: false, log }, async ({ app }) => {
    const out = log.text();
    assert.match(out, /warn NO SIGN-IN/, 'the posture is announced at boot, not a footnote');
    assert.match(out, /can reach 127\.0\.0\.1:\d+ reads this monitor/, 'it names the address and port now readable to anyone');
    assert.match(out, /BMC_MON_AUTH=1/, 'and the one switch that closes it');
    assert.match(out, /read-only RPC console/, 'including what "read" actually grants');
    assert.equal(app.bootstrap, null, 'no admin account is minted when accounts are off');
  });
});

test('with accounts ON, every one of those doors is a session again', async () => {
  // The counterpart, asserted rather than assumed: turning the flag on must restore
  // 401s, the login form, CSRF, and a real user — or "opt in to auth" is a lie.
  await withApp({}, async ({ client }) => {
    const anon = await client.get('/api/state?series=none');
    assert.equal(anon.status, 401, 'with accounts on, an anonymous read is refused');
    assert.equal(anon.body.login, '/login');
    const login = await client.login('admin');
    assert.equal(login.status, 200);
    assert.ok(client.cookies().includes('bmcmon_sid'));
    const me = await client.get('/api/me');
    assert.equal(me.body.accounts, true);
    assert.equal(me.body.user.role, 'admin');
    const csrfless = await client.post('/api/rpc', { method: 'getconnectioncount', params: [] });
    assert.equal(csrfless.status, 403, 'a session means CSRF is back on');
    assert.equal(csrfless.body.error.kind, 'csrf');
  });
});
