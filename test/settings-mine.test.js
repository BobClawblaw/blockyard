// PER-ACCOUNT DISPLAY SETTINGS (operator, 2026-09-22: "We really need to add per-user options for
// storing configs on either the browser, or server" -- then, on being told the server side would be
// admin-only at first: "I take that back. Allow per-user settings also on server side").
//
// GET/POST /api/settings/mine (server/http/api.js) is the per-signed-in-user twin of the shared
// GET/POST /api/settings tested in settings-store.test.js: same shape, same size cap, but keyed by
// account (server/store/user-settings.js) rather than one file for the whole deployment, and open
// to any signed-in role rather than admin-only -- the operator's own walk-back, tested explicitly
// below because it is the one place this route disagrees with the shared one on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withApp } from './helpers/http.js';

test('open mode has no account to key a personal record by, so the route refuses', async () => {
  await withApp({ auth: false }, async ({ client }) => {
    const r = await client.get('/api/settings/mine');
    assert.equal(r.status, 403);
    assert.equal(r.body.error?.code, 'accounts_disabled');

    const w = await client.post('/api/settings/mine', { settings: { version: 3 } });
    assert.equal(w.status, 403);
    assert.equal(w.body.error?.code, 'accounts_disabled');
  });
});

test('a signed-in VIEWER -- not just an admin -- may read and write their own record', async () => {
  // This is the point of the feature: the shared /api/settings write is admin-only
  // (configWriteAllowed), but the operator explicitly asked for the per-account route to be open
  // to every role. A viewer succeeding here where they would 403 on the shared route is the
  // behaviour that distinguishes this route from the one it sits beside.
  await withApp({ auth: true }, async ({ client, app }) => {
    await app.users.createUser('vera', 'a long enough passphrase', { role: 'viewer' });
    const { csrf } = await client.login('vera', 'a long enough passphrase');

    const sharedWrite = await client.post('/api/settings', { settings: { version: 3 } }, { csrf });
    assert.ok(sharedWrite.status === 401 || sharedWrite.status === 403,
      `a viewer must still be refused on the shared route, got ${sharedWrite.status}`);

    const empty = await client.get('/api/settings/mine');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.stored, false);
    assert.equal(empty.body.settings, null);

    const settings = { version: 3, space: { dome: 7 } };
    const w = await client.post('/api/settings/mine', { settings }, { csrf });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.ok, true);

    const r = await client.get('/api/settings/mine');
    assert.equal(r.body.stored, true);
    assert.deepEqual(r.body.settings, settings);
  });
});

test('two accounts never see each others\' records', async () => {
  await withApp({ auth: true }, async ({ client, app, base }) => {
    await app.users.createUser('alice', 'a long enough passphrase', { role: 'viewer' });
    await app.users.createUser('bob', 'a long enough passphrase', { role: 'operator' });

    const { csrf: aliceCsrf } = await client.login('alice', 'a long enough passphrase');
    await client.post('/api/settings/mine', { settings: { version: 3, space: { dome: 1 } } }, { csrf: aliceCsrf });

    const { makeClient } = await import('./helpers/http.js');
    const bobClient = makeClient(base, app);
    const { csrf: bobCsrf } = await bobClient.login('bob', 'a long enough passphrase');
    const bobRead = await bobClient.get('/api/settings/mine');
    assert.equal(bobRead.body.stored, false, "bob must not inherit alice's record");

    await bobClient.post('/api/settings/mine', { settings: { version: 3, space: { dome: 2 } } }, { csrf: bobCsrf });
    const aliceAgain = await client.get('/api/settings/mine');
    assert.deepEqual(aliceAgain.body.settings, { version: 3, space: { dome: 1 } },
      "bob's write must not touch alice's record");
  });
});

test('a body that is not a settings object is refused, same as the shared route', async () => {
  await withApp({ auth: true }, async ({ client, app }) => {
    await app.users.createUser('vera', 'a long enough passphrase', { role: 'viewer' });
    const { csrf } = await client.login('vera', 'a long enough passphrase');
    for (const bad of [undefined, null, 'nope', 42, ['a', 'b']]) {
      const r = await client.post('/api/settings/mine', bad === undefined ? {} : { settings: bad }, { csrf });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} should be refused`);
      assert.equal(r.body.error?.code, 'bad_settings');
    }
  });
});

test('an oversized blob is refused rather than written to disk', async () => {
  await withApp({ auth: true }, async ({ client, app }) => {
    await app.users.createUser('vera', 'a long enough passphrase', { role: 'viewer' });
    const { csrf } = await client.login('vera', 'a long enough passphrase');
    const good = { version: 3, space: { dome: 9 } };
    await client.post('/api/settings/mine', { settings: good }, { csrf });

    const huge = { version: 3, filler: 'x'.repeat(300_000) };
    const r = await client.post('/api/settings/mine', { settings: huge }, { csrf });
    assert.ok(r.status === 413 || r.status === 400, `expected a refusal, got ${r.status}`);

    const after = await client.get('/api/settings/mine');
    assert.deepEqual(after.body.settings, good, 'the refusal must leave the previous record intact');
  });
});

test('a write without the CSRF token is refused', async () => {
  await withApp({ auth: true }, async ({ client, app }) => {
    await app.users.createUser('vera', 'a long enough passphrase', { role: 'viewer' });
    await client.login('vera', 'a long enough passphrase');
    const r = await client.post('/api/settings/mine', { settings: { version: 3 } }, { csrf: null });
    // the client helper never sends a CSRF header unless told to -- this exercises the same
    // csrf:true branch settings-store.test.js exercises for the shared route
    assert.equal(r.status, 403);
    assert.equal(r.body.error?.kind, 'csrf');
  });
});

test('an unauthenticated caller is refused before the accounts_disabled check ever runs', async () => {
  await withApp({ auth: true }, async ({ client }) => {
    const r = await client.get('/api/settings/mine');
    assert.equal(r.status, 401, 'no session at all, refused by the ordinary auth gate');
  });
});

test('the store is a file beside users.json/sessions.json, not beside the shared settings blob', async () => {
  await withApp({ auth: true }, async ({ client, app }) => {
    await app.users.createUser('vera', 'a long enough passphrase', { role: 'viewer' });
    const { csrf } = await client.login('vera', 'a long enough passphrase');
    await client.post('/api/settings/mine', { settings: { version: 3 } }, { csrf });

    const file = path.join(app.cfg.auth.dataDir, 'user-settings.json');
    assert.ok(fs.existsSync(file), 'the per-account store must land in auth.dataDir');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the file must not be world-readable');
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(raw.users && typeof raw.users === 'object', 'keyed by user id, not one shared blob');
  });
});

test('account deletion removes the settings record too (scripts/manage-users.js rm)', async () => {
  // There is no HTTP route for deleting an account (server/http/api.js has none) -- only the CLI
  // does, and it is the CLI's own job (not this route's) to drop the settings record with it, so a
  // reused username never inherits a stranger's saved look. Exercised directly against the same
  // UserSettingsStore class the running server uses, since scripts/manage-users.js is a separate
  // process this suite does not shell out to for every test.
  await withApp({ auth: true }, async ({ app }) => {
    const user = await app.users.createUser('vera', 'a long enough passphrase', { role: 'viewer' });
    await app.userSettings.set(user.id, { version: 3, space: { dome: 5 } });
    assert.notEqual(app.userSettings.get(user.id), null);

    await app.userSettings.remove(user.id);
    assert.equal(app.userSettings.get(user.id), null, 'the record must not outlive the account');
  });
});
