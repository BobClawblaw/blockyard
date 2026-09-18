// TWO BUILDS, NOT ONE BUILD WITH A SWITCH (docs/PLAN-ADMIN-SUITE.md §2a).
//
// Operator, 2026-09-18: "two different builds entirely that get loaded ... It should
// default to the read only build by default." The property under test is physical: on the
// read-only edition the suite's code is not on the disk. Everything else in this file
// exists to stop that property being quietly lost — by an npm `files` edit, by a new admin
// file landing outside the listed paths, or by a marker that says one thing while the
// directory says another.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEdition, ADMIN_PATHS } from '../scripts/build-edition.js';
import { edition, declaredEdition, adminFilesPresent, EDITIONS, __resetEditionCache } from '../server/edition.js';
import { adminGate, adminGateLine } from '../server/admin-gate.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-edition-'));

test('the repository itself is a source tree, which is why the suite can be developed', () => {
  assert.equal(declaredEdition(ROOT), EDITIONS.SOURCE, 'the checked-in package.json must carry no edition marker');
  assert.equal(adminFilesPresent(ROOT), true);
  __resetEditionCache();
  assert.equal(edition(ROOT).canLoad, true);
});

test('npm pack cannot ship the suite by accident', () => {
  // The `files` list is what `npm publish` honours. If someone drops the negations, the
  // read-only package on the registry would silently start carrying wallet code.
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
  assert.ok(files.includes('!server/admin/'), 'package.json files must exclude server/admin/');
  assert.ok(files.includes('!public/js/admin/'), 'package.json files must exclude public/js/admin/');
  // And the negation has to come after the directory it carves out of, or npm ignores it.
  assert.ok(files.indexOf('!server/admin/') > files.indexOf('server/'));
  assert.ok(files.indexOf('!public/js/admin/') > files.indexOf('public/'));
});

test('the read-only build does not contain the suite, at all', () => {
  const dir = tmp();
  try {
    const out = buildEdition({ edition: EDITIONS.READONLY, outDir: dir, root: ROOT });
    assert.deepEqual(out.adminFiles, [], 'no file of the suite may be copied');
    for (const p of ADMIN_PATHS) {
      assert.equal(fs.existsSync(path.join(dir, p)), false, `${p} must not exist in the read-only build`);
    }
    // The monitor itself is all there: this is a whole product, not a crippled one.
    for (const p of ['server/main.js', 'server/collect/monitor.js', 'public/js/app.js', 'bin/blockyard.js']) {
      assert.equal(fs.existsSync(path.join(dir, p)), true, `${p} is missing from the read-only build`);
    }
    // And it knows what it is.
    __resetEditionCache();
    const ed = edition(dir);
    assert.equal(ed.declared, EDITIONS.READONLY);
    assert.equal(ed.present, false);
    assert.equal(ed.canLoad, false);
    assert.match(ed.note, /read-only build/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); __resetEditionCache(); }
});

test('the administrative build contains it, and says so', () => {
  const dir = tmp();
  try {
    const out = buildEdition({ edition: EDITIONS.ADMIN, outDir: dir, root: ROOT });
    assert.ok(out.adminFiles.length >= 1);
    assert.equal(fs.existsSync(path.join(dir, 'server/admin/index.js')), true);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.blockyardEdition, EDITIONS.ADMIN);
    assert.equal(pkg.name, 'blockyard-admin', 'two artifacts must not install to the same name');
    __resetEditionCache();
    assert.equal(edition(dir).canLoad, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); __resetEditionCache(); }
});

test('neither build ships a deployment\'s secrets, state or somebody else\'s games', () => {
  const dir = tmp();
  try {
    buildEdition({ edition: EDITIONS.ADMIN, outDir: dir, root: ROOT });
    for (const p of ['config/local.json', 'config/blockyard.json', 'data', 'worklog', 'games', 'test', '.git']) {
      assert.equal(fs.existsSync(path.join(dir, p)), false, `${p} must never be in an artifact`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); __resetEditionCache(); }
});

test('on the read-only build the gate refuses before it even looks at the settings', () => {
  const dir = tmp();
  try {
    buildEdition({ edition: EDITIONS.READONLY, outDir: dir, root: ROOT });
    __resetEditionCache();
    // Every other gate wide open: enabled, HTTPS, accounts on, loopback. Still refused,
    // and the refusal says what is actually wrong rather than "it is disabled".
    const gate = adminGate(
      { admin: { enabled: true, allowInsecure: true }, auth: { enabled: true }, server: { hosts: ['127.0.0.1'] } },
      { tls: true, root: dir },
    );
    assert.equal(gate.ok, false);
    assert.equal(gate.edition, EDITIONS.READONLY);
    assert.match(gate.reasons[0], /read-only build/);
    assert.match(gate.reasons[0], /blockyard-admin/, 'the refusal must say what to install instead');
    assert.match(adminGateLine(gate, {}), /NOT IN THIS BUILD/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); __resetEditionCache(); }
});

test('a build that claims the suite but lacks the files is called broken, not disabled', () => {
  const dir = tmp();
  try {
    buildEdition({ edition: EDITIONS.ADMIN, outDir: dir, root: ROOT });
    fs.rmSync(path.join(dir, 'server/admin'), { recursive: true, force: true });
    __resetEditionCache();
    const ed = edition(dir);
    assert.equal(ed.canLoad, false);
    assert.match(ed.note, /incomplete/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); __resetEditionCache(); }
});

test('every admin path the split names is real, so the list cannot rot', () => {
  // A path listed here that no longer exists would exclude nothing, and the read-only
  // build would start carrying whatever moved.
  for (const p of ADMIN_PATHS) {
    if (p === 'public/js/admin') continue; // arrives with the M1 UI
    assert.equal(fs.existsSync(path.join(ROOT, p)), true, `ADMIN_PATHS names ${p}, which does not exist`);
  }
});
