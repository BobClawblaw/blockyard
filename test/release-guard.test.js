// NOTHING SHIPS THE WALLET (operator, 2026-09-18: "Nobody should ever use the wallet build
// for now, and we should exclude it from shipping entirely. It will need a lot of work
// before it's ready to ship publicly.")
//
// The administrative suite can spend money and has not had its security review
// (docs/PLAN-ADMIN-SUITE.md M8). Until it has, no artifact this project produces may carry
// it — and "we remembered not to" is not a mechanism. There are four ways a release leaves
// this repository, each with its own exclusion, and each is checked here:
//
//   npm tarball      package.json `files`, with ! negations
//   container image  .dockerignore (Docker has never heard of `files`, and umbrel/Dockerfile
//                    does `COPY server ./server`, which would otherwise take it whole)
//   built edition    scripts/build-edition.js, which refuses to build the admin edition at
//                    all without --unreleased, and marks what it does build `private`
//   the registry     `private: true` on the admin artifact, so npm publish refuses it
//
// The point of this file is that those four lists cannot drift apart: ADMIN_PATHS is the
// one definition, and everything else is checked against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEdition, ADMIN_PATHS } from '../scripts/build-edition.js';
import { EDITIONS } from '../server/edition.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-release-'));

test('nothing admin-shaped exists outside ADMIN_PATHS', () => {
  // Deliberately NOT "every listed path exists": the client half of the suite lives on its
  // own branch until it is fit to merge, so main legitimately carries some of these paths
  // and not others. Listing a path that does not exist yet is harmless -- it excludes
  // nothing. A path that exists and is NOT listed is the dangerous direction, and that is
  // what this looks for.
  // And nothing admin-shaped may exist outside the list.
  const strays = [];
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (['node_modules', '.git', 'data', 'worklog', 'games', 'test', 'build'].includes(r)) continue;
      const full = `${dir}/${entry.name}`.replace(/^\.\//, '');
      if (entry.isDirectory()) walk(full, r);
      else if (/(^|\/)admin(\/|-|\.)/.test(r) && !ADMIN_PATHS.some((a) => r === a || r.startsWith(`${a}/`))) {
        // server/admin-gate.js is core on purpose: a read-only build needs it to explain
        // that the suite is not in this build. It is the one deliberate exception.
        if (r !== 'server/admin-gate.js') strays.push(r);
      }
    }
  };
  walk('.');
  assert.deepEqual(strays, [], 'these look like suite files but are not in ADMIN_PATHS, so nothing excludes them');
});

test('the npm tarball excludes every one of them', () => {
  const files = JSON.parse(read('package.json')).files;
  for (const p of ADMIN_PATHS) {
    // npm wants a trailing slash on a directory and none on a file; guessing by extension
    // rather than by a hard-coded list, since the list grows.
    const isFile = /\.[a-z0-9]+$/i.test(p);
    const negation = isFile ? `!${p}` : `!${p}/`;
    assert.ok(files.includes(negation), `package.json files must carry ${negation}`);
    // npm honours a negation only after the pattern it carves out of.
    const parent = p.split('/')[0] + '/';
    assert.ok(files.indexOf(negation) > files.indexOf(parent), `${negation} must come after ${parent}`);
  }
});

test('container images exclude them too, which package.json cannot do', () => {
  const ignored = read('.dockerignore').split('\n').map((l) => l.trim());
  for (const p of ADMIN_PATHS) {
    assert.ok(ignored.includes(p), `.dockerignore must exclude ${p} — Docker does not read package.json's files list`);
  }
  // And the Dockerfile still copies the parent directories, which is why the above matters.
  assert.match(read('umbrel/Dockerfile'), /^COPY server \.\/server$/m);
});

test('the read-only build carries none of it, checked on disk', () => {
  const dir = tmp();
  try {
    const out = buildEdition({ edition: EDITIONS.READONLY, outDir: dir, root: ROOT });
    assert.deepEqual(out.adminFiles, []);
    // Not just the named paths: nothing anywhere in the artifact may mention them.
    const found = [];
    const walk = (d, rel = '') => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else if (ADMIN_PATHS.some((a) => r === a || r.startsWith(`${a}/`))) found.push(r);
      }
    };
    walk(dir);
    assert.deepEqual(found, [], 'the read-only artifact contains suite files');
    // The monitor itself is whole: this is a complete product, not a crippled one.
    for (const p of ['server/main.js', 'public/js/app.js', 'bin/blockyard.js']) {
      assert.ok(fs.existsSync(path.join(dir, p)), `${p} missing from the read-only build`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the admin edition refuses to build unless somebody says the word', () => {
  const dir = tmp();
  try {
    assert.throws(
      () => buildEdition({ edition: EDITIONS.ADMIN, outDir: dir, root: ROOT }),
      /not fit to ship/,
      'building a wallet edition must take a deliberate flag',
    );
    const out = buildEdition({ edition: EDITIONS.ADMIN, outDir: dir, root: ROOT, unreleased: true });
    assert.ok(out.adminFiles.length >= 1);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    // The backstop: npm publish refuses a private package, whatever anyone types.
    assert.equal(pkg.private, true, 'the admin artifact must be unpublishable');
    assert.equal(pkg.blockyardUnreleased, true);
    assert.equal(pkg.name, 'blockyard-admin', 'and must not install over the read-only package');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the tarball advertises no wallet, and explains its absence', () => {
  const files = JSON.parse(read('package.json')).files;
  // The plan describes a feature this build does not contain; shipping it would promise
  // users a wallet they do not have and should not go looking for.
  assert.ok(files.includes('!docs/PLAN-ADMIN-SUITE.md'), 'the plan must not ship with the read-only build');
  // server/admin-gate.js and server/edition.js DO ship, on purpose: together they are what
  // tells someone who sets BLOCKYARD_ADMIN=1 that the suite is not in this build and what
  // to install instead. Without them that setting would be silently ignored, which is the
  // worse failure -- a person concluding the switch is broken rather than absent.
  assert.ok(!files.includes('!server/admin-gate.js'));
  assert.ok(!files.includes('!server/edition.js'));
  assert.match(read('server/edition.js'), /read-only build of BlockYard/,
    'the read-only build must be able to say what it is');
  assert.match(read('server/admin-gate.js'), /does not carry the administrative suite|NOT IN THIS BUILD/);
});

test('the shipped package is not marked private, so releases still work', () => {
  // The other half of the previous test: this must not be the change that quietly stops
  // the real product from publishing.
  const pkg = JSON.parse(read('package.json'));
  assert.notEqual(pkg.private, true, 'the repository package must stay publishable');
  assert.equal(pkg.name, 'blockyard');
  assert.equal(pkg.blockyardEdition, undefined, 'a checkout is a source tree, not an edition');
});
