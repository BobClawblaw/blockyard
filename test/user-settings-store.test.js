// UserSettingsStore (server/store/user-settings.js): the per-account twin of UserStore/SessionStore
// -- same atomic-write pattern (tmp file, fsync, rename, 0600), same "a corrupt file refuses to
// start rather than reading as empty" stance. These are unit tests against the class directly;
// test/settings-mine.test.js covers it through the HTTP routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserSettingsStore } from '../server/store/user-settings.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-user-settings-'));

test('a fresh store has nothing, and load() says so without creating a file', async () => {
  const dir = tmp();
  const store = new UserSettingsStore(path.join(dir, 'user-settings.json'));
  const r = await store.load();
  assert.deepEqual(r, { loaded: false, count: 0 });
  assert.equal(fs.existsSync(store.file), false);
  assert.equal(store.get('anyone'), null);
});

test('set/get round-trips, and save() writes an atomic, 0600 file', async () => {
  const dir = tmp();
  const store = new UserSettingsStore(path.join(dir, 'user-settings.json'));
  await store.load();
  await store.set('u1', { version: 3, space: { dome: 4 } });

  assert.deepEqual(store.get('u1'), { version: 3, space: { dome: 4 } });
  assert.equal(fs.existsSync(store.file), true);
  assert.equal(fs.existsSync(`${store.file}.tmp`), false, 'the tmp file must not survive a save');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  }

  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.users.u1.settings.space.dome, 4);
  assert.ok(typeof raw.users.u1.updatedAt === 'number');
});

test('a second save replaces one user\'s record without touching another\'s', async () => {
  const dir = tmp();
  const store = new UserSettingsStore(path.join(dir, 'user-settings.json'));
  await store.load();
  await store.set('u1', { version: 3, space: { dome: 1 } });
  await store.set('u2', { version: 3, space: { dome: 2 } });
  await store.set('u1', { version: 3, space: { dome: 9 } });

  assert.deepEqual(store.get('u1'), { version: 3, space: { dome: 9 } });
  assert.deepEqual(store.get('u2'), { version: 3, space: { dome: 2 } });
  assert.equal(store.count, 2);
});

test('a fresh instance loads back exactly what an earlier one saved', async () => {
  const dir = tmp();
  const file = path.join(dir, 'user-settings.json');
  const a = new UserSettingsStore(file);
  await a.load();
  await a.set('u1', { version: 3, space: { dome: 5 } });

  const b = new UserSettingsStore(file);
  const r = await b.load();
  assert.deepEqual(r, { loaded: true, count: 1 });
  assert.deepEqual(b.get('u1'), { version: 3, space: { dome: 5 } });
});

test('remove() drops the record and rewrites the file; removing an absent id is a no-op', async () => {
  const dir = tmp();
  const store = new UserSettingsStore(path.join(dir, 'user-settings.json'));
  await store.load();
  await store.set('u1', { version: 3 });

  await store.remove('nobody');           // must not throw, must not touch u1
  assert.deepEqual(store.get('u1'), { version: 3 });

  await store.remove('u1');
  assert.equal(store.get('u1'), null);
  assert.equal(store.count, 0);

  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.deepEqual(raw.users, {}, 'the removal must be persisted to disk, not just in memory');
});

test('a corrupt file refuses to load rather than reading as empty', async () => {
  const dir = tmp();
  const file = path.join(dir, 'user-settings.json');
  fs.writeFileSync(file, '{ not json');
  const store = new UserSettingsStore(file);
  await assert.rejects(() => store.load(), /unreadable/);
});
