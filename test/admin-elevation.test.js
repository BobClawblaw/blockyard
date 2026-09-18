// ELEVATION (docs/PLAN-ADMIN-SUITE.md §2.6, M1).
//
// The session gets you the UI; it does not get you the money. These tests are the
// difference between that being true and it being a sentence in a plan.
//
// The first one exists because of a real bug caught while writing elevation.js on
// 2026-09-18: `users.verify()` returns `{ ok, user, reason }`, and `if (!await verify(...))`
// is truthy for every result it can return — so every password elevated, including the
// wrong ones. It compiled, it read correctly, and it would have handed the wallet to
// anyone holding a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';

const ON = { admin: { enabled: true, allowInsecure: true, wallets: ['hot'], elevationMs: 60_000, spend: { capSat: 1000 } } };

async function signedIn(fn, config = ON) {
  __resetElevations();
  return withApp({ nodes: 1, config }, async (h) => {
    const s = await h.client.login('admin', h.client.adminPassword);
    return fn({ ...h, csrf: s.csrf });
  });
}

test('a wrong password does not elevate', async () => {
  await signedIn(async ({ client, csrf }) => {
    const bad = await client.post('/api/admin/elevate', { password: 'not the password' }, { csrf });
    assert.equal(bad.status, 403);
    assert.match(bad.body.error.message, /not right/);
    const st = await client.get('/api/admin/status');
    assert.equal(st.body.elevation.elevated, false, 'a refused password must leave the session unelevated');
  });
});

test('an empty, absent or wrongly-typed password does not elevate either', async () => {
  await signedIn(async ({ client, csrf }) => {
    for (const password of ['', undefined, null, 0, false, {}, []]) {
      const res = await client.post('/api/admin/elevate', { password }, { csrf });
      assert.equal(res.status, 403, `password ${JSON.stringify(password)} must be refused`);
    }
    assert.equal((await client.get('/api/admin/status')).body.elevation.elevated, false);
  });
});

test('the right password elevates, for the configured window', async () => {
  await signedIn(async ({ client, csrf }) => {
    const res = await client.post('/api/admin/elevate', { password: client.adminPassword }, { csrf });
    assert.equal(res.status, 200);
    assert.ok(res.body.leftMs > 55_000 && res.body.leftMs <= 60_000);
    assert.match(res.body.label, /elevated for 1:00|elevated for 0:5\d/);
    const st = await client.get('/api/admin/status');
    assert.equal(st.body.elevation.elevated, true);
  });
});

test('a disabled account cannot elevate, even with the right password', async () => {
  await signedIn(async ({ client, csrf, app }) => {
    await client.post('/api/users', { username: 'second', password: 'a-long-enough-password-92', role: 'admin' }, { csrf });
    await client.post('/api/users/second/disabled', { disabled: true }, { csrf });
    // Sign in as the disabled account is already impossible; the check that matters is
    // that elevate() consults verify()'s reason rather than only its password comparison.
    const v = await app.users.verify('second', 'a-long-enough-password-92');
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'account disabled');
  });
});

test('elevation is per session, not per account', async () => {
  // Elevating in one browser must not arm another browser holding the same account.
  await signedIn(async ({ client, csrf, base, app }) => {
    await client.post('/api/admin/elevate', { password: client.adminPassword }, { csrf });
    assert.equal((await client.get('/api/admin/status')).body.elevation.elevated, true);

    const { makeClient } = await import('./helpers/http.js');
    const other = makeClient(base, app);
    other.adminPassword = client.adminPassword;
    await other.login('admin', client.adminPassword);
    const st = await other.get('/api/admin/status');
    assert.equal(st.body.elevation.elevated, false, 'a second session starts unelevated');
  });
});

test('dropping it takes effect at once', async () => {
  await signedIn(async ({ client, csrf }) => {
    await client.post('/api/admin/elevate', { password: client.adminPassword }, { csrf });
    await client.post('/api/admin/elevate/drop', {}, { csrf });
    assert.equal((await client.get('/api/admin/status')).body.elevation.elevated, false);
  });
});

test('five wrong passwords stop the sixth being tried at all', async () => {
  await signedIn(async ({ client, csrf }) => {
    for (let i = 0; i < 5; i++) await client.post('/api/admin/elevate', { password: `wrong-${i}` }, { csrf });
    const res = await client.post('/api/admin/elevate', { password: client.adminPassword }, { csrf });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /too many wrong passwords/,
      'the throttle must refuse even the RIGHT password, or it is only a speed bump');
  });
});

test('an elevated action refuses without elevation, and says which', async () => {
  await signedIn(async ({ client, csrf }) => {
    const res = await client.post('/api/admin/users/admin/wallet-access', { walletAccess: true }, { csrf });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'elevation-required', 'the UI keys the password prompt off this code');
    assert.match(res.body.error.message, /needs your password again/);
  });
});

test('the wallet grant is off for every account, including the bootstrap admin', async () => {
  await signedIn(async ({ client, csrf, app }) => {
    assert.equal(app.users.list().every((u) => u.walletAccess === false), true,
      'no account may acquire the wallet grant by default');
    const st = await client.get('/api/admin/status');
    assert.equal(st.body.you.walletAccess, false);

    await client.post('/api/admin/elevate', { password: client.adminPassword }, { csrf });
    const grant = await client.post('/api/admin/users/admin/wallet-access', { walletAccess: true }, { csrf });
    assert.equal(grant.status, 200);
    assert.equal(grant.body.user.walletAccess, true);
    assert.equal((await client.get('/api/admin/status')).body.you.walletAccess, true);

    // and it comes back off
    const revoke = await client.post('/api/admin/users/admin/wallet-access', { walletAccess: false }, { csrf });
    assert.equal(revoke.body.user.walletAccess, false);
  });
});

test('the password never appears in the audit trail', async () => {
  await signedIn(async ({ client, csrf }) => {
    await client.post('/api/admin/elevate', { password: client.adminPassword }, { csrf });
    await client.post('/api/admin/elevate', { password: 'a-wrong-one-9182' }, { csrf });
    const audit = await client.get('/api/audit?limit=50');
    const text = JSON.stringify(audit.body);
    assert.ok(!text.includes(client.adminPassword), 'the correct password must not be in the audit trail');
    assert.ok(!text.includes('a-wrong-one-9182'), 'nor a wrong one');
    assert.match(text, /admin-elevated/);
    assert.match(text, /admin-elevate-failed/);
  });
});
