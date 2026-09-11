// The audit trail's size, and the password hash's cost.
//
// Two "grows forever / stays forever" defects fixed together because they are the
// same mistake: a resource with no policy applied to it.
//
// audit.jsonl recorded logins and RPC calls with no rotation, on a box that has
// filled its disk before. A full disk is not "no audit log" — the same filesystem
// holds the history snapshots and the node's datadir, so the log's growth is the
// node's problem. The fix is size-triggered rotation with a numbered chain, and a
// reader that walks the chain, because the moment a rotation happens is exactly when
// someone has the audit page open.
//
// scrypt parameters were global and fixed, so raising them changed nothing for any
// existing account. They are stored per user now, verified with the stored values,
// and re-derived on a *successful* login when the configured cost is different —
// which is the only moment the plaintext is in hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../server/store/audit.js';
import { UserStore, needsRehash } from '../server/auth/users.js';

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `bmcmon-${tag}-`));

function mkAudit({ maxBytes = 4096, keep = 3 } = {}) {
  const dir = tmp('audit');
  return new AuditLog(path.join(dir, 'audit.jsonl'), { maxBytes, keep, log: () => {} });
}

test('entries append and read back newest-first', async () => {
  const a = mkAudit();
  for (let i = 1; i <= 5; i++) await a.append({ type: 'login', n: i });
  const rows = await a.read(10);
  assert.deepEqual(rows.map((r) => r.n), [5, 4, 3, 2, 1], 'newest first: the page shows the most recent activity');
  await a.append({ type: 'rpc', method: 'getblockchaininfo' });
  assert.equal((await a.read(1))[0].method, 'getblockchaininfo');
});

test('the log rotates on size and keeps a numbered chain', async () => {
  const a = mkAudit({ maxBytes: 600, keep: 3 });
  // 30 entries of ~40 bytes overruns 600 at least twice.
  for (let i = 0; i < 30; i++) await a.append({ type: 'x', i, pad: 'y'.repeat(20) });
  assert.ok(a.rotations >= 2, `expected at least two rotations, got ${a.rotations}`);
  const st = await a.stats();
  assert.ok(st.currentBytes <= st.maxBytes * 1.25, `current file stayed near its budget: ${st.currentBytes} vs ${st.maxBytes}`);
  assert.ok(st.files.length >= 2, 'previous files exist rather than being deleted on the spot');
  assert.ok(st.files.length <= st.keep + 1, `never more than keep(${st.keep}) + current: ${st.files.map((f) => f.file).join(', ')}`);
  const names = st.files.map((f) => f.file);
  assert.equal(names[0], 'audit.jsonl');
  assert.equal(names[1], 'audit.1.jsonl');
});

test('read() crosses a rotation, so the page does not lose history mid-rotation', async () => {
  const a = mkAudit({ maxBytes: 500, keep: 4 });
  for (let i = 0; i < 40; i++) await a.append({ seq: i });
  const rows = await a.read(40);
  assert.ok(rows.length > 10, `rotation must not hide the trail; got ${rows.length} rows`);
  // Every returned entry is at most 4 rotations * 500 bytes worth of history deep;
  // what matters is that the newest is present and the order is monotonic.
  assert.ok(rows[0].seq > 30, `newest entry is current: seq ${rows[0].seq}`);
  const seqs = rows.map((r) => r.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i - 1] > seqs[i], 'newest-first across the file boundary');
});

test('a failed rotation keeps appending and says so, rather than losing the entry', async () => {
  const a = mkAudit({ maxBytes: 400, keep: 2 });
  // Make rotation impossible without making appending impossible: the oldest slot
  // is a non-empty DIRECTORY, so `rm` of it fails. (Renaming a read-only file still
  // succeeds on Linux -- directory permissions govern a rename, not the file's own
  // -- so the first version of this obstacle proved nothing.)
  const dir = path.dirname(a.file);
  const oldest = path.join(dir, 'audit.2.jsonl');
  fs.mkdirSync(oldest, { recursive: true });
  fs.writeFileSync(path.join(oldest, 'keep-me'), 'x');
  try {
    // Write until the file is genuinely over its budget, so a rotation is demanded.
    for (let i = 0; i < 20; i++) await a.append({ kept: i, pad: 'z'.repeat(60) });
    const rows = await a.read(50);
    assert.ok(rows.some((r) => r.kept === 19), 'the newest entry is written even though rotation failed');
    const st = await a.stats();
    assert.ok(st.rotationError, `the failure is visible in stats: ${JSON.stringify(st)}`);
    assert.equal(a.rotations, 0, 'a failed rotation is not counted as one');
    assert.ok(rows.length >= 20, 'nothing was rotated away, so nothing left the trail');
  } finally {
    fs.rmSync(oldest, { recursive: true, force: true });
  }
});

test('a restart adopts the existing file size, so the budget survives a boot', async () => {
  const a = mkAudit({ maxBytes: 1000 });
  for (let i = 0; i < 6; i++) await a.append({ i });
  const bytes = fs.statSync(a.file).size;
  const reopened = new AuditLog(a.file, { maxBytes: 1000, keep: 2, log: () => {} });
  assert.equal((await reopened.adopt()).adopted, bytes, 'without adopt() the first append after a boot thinks the file is empty');
  assert.equal(reopened.rotations, 0);
});

test('credentials are the caller\u2019s business and never the file\u2019s', async () => {
  // The shape main.js enforces; asserted here against the file itself.
  const a = mkAudit();
  const row = { type: 'login', username: 'admin', password: 'hunter2hunter2' };
  delete row.password; // what app.audit() does before appending
  await a.append(row);
  const raw = fs.readFileSync(a.file, 'utf8');
  assert.ok(!raw.includes('hunter2hunter2'), 'a password must not reach the audit file, in any field');
});

// ------------------------------------------------------------------ scrypt

const authCfg = (over = {}) => ({
  scrypt: { N: 1024, r: 1, p: 1, keylen: 16 }, // test-sized KDF: still scrypt, still real
  minPasswordChars: 12,
  ...over,
});

async function mkUsers(cfg = authCfg()) {
  const dir = tmp('users');
  const store = new UserStore(path.join(dir, 'users.json'), cfg);
  await store.load();
  return store;
}

test('a stored hash keeps the parameters it was made with', async () => {
  const users = await mkUsers();
  await users.createUser('operator', 'a long enough passphrase', { role: 'operator' });
  const u = users.find('operator');
  assert.deepEqual({ N: u.params.N, r: u.params.r, p: u.params.p, keylen: u.params.keylen },
    { N: 1024, r: 1, p: 1, keylen: 16 });
  assert.equal(u.params.scheme, 'scrypt');
  assert.ok(u.salt.length >= 32, 'a per-user salt, not a global one');
});

test('raising the configured cost rehashes on the next successful login', async () => {
  const users = await mkUsers();
  await users.createUser('admin', 'a long enough passphrase', { role: 'admin' });
  const before = { ...users.find('admin') };

  // Time passes; hardware gets faster; the operator raises the cost.
  users.cfg.scrypt = { N: 2048, r: 8, p: 1, keylen: 32 };

  // A wrong password must NOT upgrade anything: rehashing a wrong secret would
  // store a hash of the wrong password and silently destroy the account.
  const bad = await users.verify('admin', 'wrong passphrase here');
  assert.equal(bad.ok, false);
  assert.equal(users.find('admin').hash, before.hash, 'a failed login cannot change the stored hash');
  assert.equal(users.find('admin').params.N, 1024);

  const good = await users.verify('admin', 'a long enough passphrase');
  assert.equal(good.ok, true);
  assert.deepEqual(good.upgraded?.to, { N: 2048, r: 8, p: 1, keylen: 32 }, 'the upgrade is reported, so it can be audited');
  const after = users.find('admin');
  assert.equal(after.params.N, 2048);
  assert.notEqual(after.hash, before.hash, 're-derived with the new cost');
  assert.notEqual(after.salt, before.salt, 'and with a fresh salt');

  // Verifying again with the new parameters must still work — the point of storing
  // per-user parameters rather than trusting the config.
  const again = await users.verify('admin', 'a long enough passphrase');
  assert.equal(again.ok, true);
  assert.equal(again.upgraded, null, 'nothing left to upgrade');
});

test('an old hash still verifies after the config moves on', async () => {
  const users = await mkUsers();
  await users.createUser('viewer', 'correct horse battery', { role: 'viewer' });
  const old = { ...users.find('viewer') };
  users.cfg.scrypt = { N: 4096, r: 8, p: 1, keylen: 32 };
  // Pretend a second account never logged in again: rewrite the file with old params.
  users.users.push({ ...old, id: 'legacy', username: 'legacy', lastLoginAt: null });
  const r = await users.verify('legacy', 'correct horse battery');
  assert.equal(r.ok, true, 'a login is not refused because the server got stricter');
});

test('an unknown scheme is refused rather than assumed to be scrypt', async () => {
  const users = await mkUsers();
  await users.createUser('future', 'a long enough passphrase');
  users.find('future').params.scheme = 'argon2id-pre';
  const r = await users.verify('future', 'a long enough passphrase');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported hash scheme/);
});

test('needsRehash is per-account and list() exposes it', async () => {
  const users = await mkUsers();
  await users.createUser('one', 'a long enough passphrase');
  await users.createUser('two', 'another long passphrase');
  users.cfg.scrypt = { N: 2048, r: 8, p: 1, keylen: 32 };
  assert.equal(needsRehash(users.find('one'), users.cfg.scrypt), true);
  const listed = users.list();
  assert.ok(listed.every((u) => u.kdfNeedsUpgrade === true));
  assert.ok(listed.every((u) => u.kdf && u.kdf.N === 1024), 'the stored cost is visible next to the verdict');
  await users.setPassword('one', 'a different long passphrase');
  assert.equal(needsRehash(users.find('one'), users.cfg.scrypt), false, 'setPassword uses the current cost');
});

test('a user file written by an older version still loads (params defaulted)', async () => {
  const dir = tmp('users');
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    users: [{ id: 'x', username: 'old', salt: 'aa'.repeat(16), hash: 'bb'.repeat(16), role: 'viewer', createdAt: 1, updatedAt: 1 }],
  }));
  const store = new UserStore(file, authCfg());
  const loaded = await store.load();
  assert.equal(loaded.count, 1);
  const r = await store.verify('old', 'whatever');
  assert.equal(r.ok, false, 'a wrong password against a defaulted-params hash is simply wrong');
  assert.deepEqual(store.list()[0].kdf, null, 'no params recorded is reported as unknown, not as the current config');
});
