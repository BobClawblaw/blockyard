// THE SUITE, LOADED (docs/PLAN-ADMIN-SUITE.md, M0).
//
// Separate file from admin-disabled.test.js on purpose: that one asserts
// globalThis.__blockyardAdminLoaded is undefined, and node runs each test FILE in its own
// process but a file's tests in one. Loading the suite here would make the absence proof
// there depend on which file ran first, which is not a proof at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.js';

// allowInsecure, because the helper serves plain HTTP; the HTTPS gate itself is tested in
// admin-disabled.test.js against the gate function, where no listener is needed.
const ON = { admin: { enabled: true, allowInsecure: true, wallets: ['hot'], elevationMs: 300_000, spend: { capSat: 50_000 } } };

test('the gate opens, the module loads, and the route exists', async () => {
  await withApp({ nodes: 1, config: ON }, async ({ app, client }) => {
    assert.equal(app.adminEnabled, true);
    assert.equal(globalThis.__blockyardAdminLoaded, true, 'the entry module is evaluated only once the gate opens');
    assert.ok(app.adminRoutes.length >= 1);

    await client.login('admin', client.adminPassword);
    const res = await client.get('/api/admin/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.gates.walletsNamed, 1);
    assert.equal(res.body.gates.spendCapSat, 50_000);
    // The UI reads the capability list rather than guessing from a version number which
    // milestones this build carries. M0 shipped none; M1 added elevation.
    assert.deepEqual(res.body.capabilities, ['elevation', 'wallet.read', 'wallet.receive', 'wallet.spend']);
  });
});

test('the status route is for admins, not for anyone signed in', async () => {
  await withApp({ nodes: 1, config: ON }, async ({ app, client }) => {
    const admin = await client.login('admin', client.adminPassword);
    const made = await client.post('/api/users', { username: 'watcher', password: 'a-long-enough-password-92', role: 'viewer' }, { csrf: admin.csrf });
    assert.equal(made.status, 200, `could not create the viewer: ${JSON.stringify(made.body)}`);
    await client.post('/api/logout', {}, { csrf: admin.csrf });
    const viewer = await client.login('watcher', 'a-long-enough-password-92');
    assert.equal(viewer.status, 200, 'the viewer must be able to sign in');
    const res = await client.get('/api/admin/status');
    assert.equal(res.status, 403, 'a viewer must not read the administrative state');
  });
});

test('the suite refuses to load when a gate is shut, and the route is absent with it', async () => {
  // Public bind, no acknowledgement: the gate refuses, so the module is never imported and
  // the route never exists -- the same end state as the suite being off entirely.
  await withApp({ nodes: 1, config: { admin: { ...ON.admin, allowPublicBind: false }, server: { hosts: ['127.0.0.1', '192.0.2.10'] } } }, async ({ app, client }) => {
    assert.equal(app.adminEnabled, false);
    assert.equal(app.adminGate.off, false, 'it was asked for');
    assert.match(app.adminGate.reasons.join(' '), /bound to an address other than this machine/);
    await client.login('admin', client.adminPassword);
    assert.equal((await client.get('/api/admin/status')).status, 404);
  });
});
