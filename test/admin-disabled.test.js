// THE SUITE IS OFF, AND OFF MEANS ABSENT (docs/PLAN-ADMIN-SUITE.md §2, M0).
//
// The operator's requirement, 2026-09-18: "if it's disabled at blockyard start, the wallet
// modules never ever get loaded into blockyard". Not loaded and refusing — absent. This
// file is the standing proof of that, and of every gate refusing on its own, and it is
// deliberately the first thing the suite shipped: no capability exists yet, so there is
// nothing here that could be passing for the wrong reason.
//
// The sentinel is how absence is proved rather than asserted. `server/admin/index.js` sets
// globalThis.__blockyardAdminLoaded at module scope, so if anything — a stray static
// import from a core file, a future refactor, a test that imported it earlier — pulls that
// module into the process, the first test below fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp, logSink } from './helpers/http.js';
import { adminGate, adminGateLine, boundPublicly } from '../server/admin-gate.js';

test('a default monitor never loads the suite, and says so with its absence', async () => {
  assert.equal(globalThis.__blockyardAdminLoaded, undefined,
    'server/admin/ was evaluated before any boot -- something imports it statically, which undoes the whole property');

  await withApp({ nodes: 1 }, async ({ app, client }) => {
    assert.equal(app.adminEnabled, false);
    assert.equal(app.adminRoutes, undefined, 'no route table, because the module that builds it was never imported');
    assert.equal(globalThis.__blockyardAdminLoaded, undefined, 'a default boot must not evaluate server/admin/index.js');

    await client.login('admin', client.adminPassword);
    const res = await client.get('/api/admin/status');
    assert.equal(res.status, 404, 'the route does not exist, rather than existing and refusing');
  });
});

test('the suite\'s client code is not served either', async () => {
  await withApp({ nodes: 1 }, async ({ client }) => {
    await client.login('admin', client.adminPassword);
    // /css/admin.css joined the list on 2026-09-19: it was served with the gate shut.
    for (const p of ['/js/admin/wallet.js', '/js/admin/suite.js', '/css/admin.css', '/admin', '/admin/wallet']) {
      const res = await client.get(p);
      assert.equal(res.status, 404, `${p} must 404 while the suite is off`);
    }
  });
});

// ------------------------------------------------------------------ the gates, one by one

const base = {
  admin: { enabled: true, allowInsecure: false, allowWithoutAuth: false, allowPublicBind: false, wallets: [], elevationMs: 300_000, spend: { capSat: null } },
  auth: { enabled: true },
  server: { host: '127.0.0.1', hosts: ['127.0.0.1'] },
};
const gateOf = (over = {}, opts = {}) => adminGate({
  ...base,
  ...over,
  admin: { ...base.admin, ...(over.admin ?? {}) },
  auth: { ...base.auth, ...(over.auth ?? {}) },
  server: { ...base.server, ...(over.server ?? {}) },
}, opts);

test('off is the default, and it is reported as off rather than as refused', () => {
  const gate = adminGate({ admin: { enabled: false } });
  assert.equal(gate.ok, false);
  assert.equal(gate.off, true);
  assert.match(adminGateLine(gate, {}), /OFF \(the default\).*not loaded/);
});

test('plain HTTP refuses, and names what would cross the wire', () => {
  const gate = gateOf({}, { tls: false });
  assert.equal(gate.ok, false);
  assert.equal(gate.reasons.length, 1);
  assert.match(gate.reasons[0], /passphrase.*in the clear/);
  assert.match(gate.reasons[0], /admin\.allowInsecure/);
  // TLS this server terminates, or a terminator in front of it, both satisfy it: the
  // question is whether the password crosses the wire in the clear, not whose cert it is.
  assert.equal(gateOf({}, { tls: true }).ok, true);
  assert.equal(gateOf({}, { trustProxy: true }).ok, true);
  assert.equal(gateOf({ admin: { allowInsecure: true } }, { tls: false }).ok, true);
});

test('accounts off refuses, because there is nobody to elevate', () => {
  const gate = gateOf({ auth: { enabled: false } }, { tls: true });
  assert.equal(gate.ok, false);
  assert.match(gate.reasons[0], /no role to check and nobody to ask for a password/);
  assert.equal(gateOf({ auth: { enabled: false }, admin: { allowWithoutAuth: true } }, { tls: true }).ok, true);
});

test('a public bind refuses: a wallet interface on the network is its own decision', () => {
  const gate = gateOf({ server: { hosts: ['0.0.0.0'] } }, { tls: true });
  assert.equal(gate.ok, false);
  assert.match(gate.reasons[0], /bound to an address other than this machine/);
  assert.equal(gateOf({ server: { hosts: ['0.0.0.0'] }, admin: { allowPublicBind: true } }, { tls: true }).ok, true);
  // loopback spellings are all this machine
  for (const h of ['127.0.0.1', '::1', 'localhost']) assert.equal(boundPublicly({ server: { hosts: [h] } }), false, h);
  assert.equal(boundPublicly({ server: { hosts: ['127.0.0.1', '192.0.2.10'] } }), true, 'one public host is enough to count');
});

test('every failing gate is reported at once, not one per restart', () => {
  const gate = gateOf({ auth: { enabled: false }, server: { hosts: ['0.0.0.0'] } }, { tls: false });
  assert.equal(gate.reasons.length, 3, 'HTTP, no accounts, public bind -- all three');
  assert.equal(gate.ok, false);
});

test('the banner names what is open, including the cap that is not set', () => {
  const cfg = { admin: { enabled: true, wallets: ['hot'], elevationMs: 300_000, spend: { capSat: null } } };
  const line = adminGateLine({ ok: true, off: false, reasons: [] }, cfg);
  assert.match(line, /ON/);
  assert.match(line, /wallets hot/);
  assert.match(line, /elevation 300s/);
  assert.match(line, /spend cap NOT SET \(sends are refused/);
  const capped = adminGateLine({ ok: true, off: false, reasons: [] }, { admin: { ...cfg.admin, spend: { capSat: 50_000 } } });
  assert.match(capped, /spend cap 50000 sat/);
  const noWallet = adminGateLine({ ok: true, off: false, reasons: [] }, { admin: { ...cfg.admin, wallets: [] } });
  assert.match(noWallet, /no wallet named/);
});

// N1 (audit 2026-09-19 round 2): admin.allowWithoutAuth is a gate condition, not a role.
// It lets the suite LOAD with accounts off; it does not make its routes reachable, because
// in open mode the only identity is the frozen viewer, and the viewer ceiling applies to
// admin routes whether or not the switch is set (measured against the pre-fix server: with
// accounts off and the switch on, /api/admin/status answered 403). The disclosure must say
// exactly that -- the switch by name, and what the switch does and does not do.

test('N1: with accounts off, the ON line names admin.allowWithoutAuth, and says the routes still refuse', () => {
  const cfg = { auth: { enabled: false }, admin: { enabled: true, allowWithoutAuth: true, wallets: ['hot'], elevationMs: 300_000, spend: { capSat: null } } };
  const line = adminGateLine({ ok: true, off: false, reasons: [] }, cfg);
  assert.match(line, /admin\.allowWithoutAuth/);
  assert.match(line, /still refuse/);
  assert.match(line, /no admin role to grant/);
  // With accounts on the gate passes without the switch, so the line does not claim a
  // role the switch does not play; and the existing ON wording is untouched otherwise.
  const on = adminGateLine({ ok: true, off: false, reasons: [] }, { auth: { enabled: true }, admin: { ...cfg.admin } });
  assert.doesNotMatch(on, /allowWithoutAuth/);
  assert.match(on, /ON -- wallets hot/);
});

test('N1: the disclosure is what the server does -- boot with the switch on, accounts off', async () => {
  const log = logSink();
  await withApp({
    auth: false, log,
    config: {
      log: { level: 'warn' },
      admin: { enabled: true, allowInsecure: true, allowWithoutAuth: true, wallets: [], elevationMs: 60_000, spend: { capSat: 1000 } },
    },
  }, async ({ app, client }) => {
    assert.equal(app.adminEnabled, true, 'the switch loads the suite');
    const boot = log.entries.filter((e) => String(e.msg).includes('administrative suite')).map((e) => e.msg).join('\n');
    assert.ok(boot.length, 'the boot banner reports the suite');
    assert.match(boot, /admin\.allowWithoutAuth/);
    assert.match(boot, /still refuse/);
    // ...and the routes the disclosure says refuse do refuse: no accounts means no admin
    // role to grant, so the suite is in this process but not reachable over HTTP.
    const st = await client.get('/api/admin/status');
    assert.equal(st.status, 403);
    assert.equal(st.body.accounts, false);
  });
});

test('N1: the status report carries the switch by name, in both states', async () => {
  for (const withSwitch of [true, false]) {
    await withApp({ nodes: 1, config: { admin: { enabled: true, allowInsecure: true, ...(withSwitch ? { allowWithoutAuth: true } : {}), wallets: [], elevationMs: 60_000, spend: { capSat: 1000 } } } }, async ({ client }) => {
      await client.login('admin', client.adminPassword);
      const st = await client.get('/api/admin/status');
      assert.equal(st.status, 200);
      assert.equal(st.body.gates.accounts, true);
      assert.equal(st.body.gates.allowWithoutAuth, withSwitch, 'the switch is named in the status payload, in both states');
    });
  }
});

test('the RPC console still refuses every wallet method (audit M4 is untouched by all this)', async () => {
  const { classifyMethod } = await import('../server/rpc/allowlist.js');
  for (const m of ['getbalance', 'listdescriptors', 'gethdkeys', 'sendtoaddress', 'walletpassphrase', 'dumpprivkey']) {
    const verdict = classifyMethod(m);
    assert.equal(verdict.allowed, false, `${m} must stay denied in the console`);
  }
});
