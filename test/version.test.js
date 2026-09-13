// THE VERSION IS ONE FACT, AND IT MUST BE WRITTEN DOWN ONCE.
//
// On 2026-09-13 it was written down twice and the two disagreed: server/main.js carried
// `const VERSION = '0.0.9'` while CHANGELOG.md's newest release was [0.9.0]. Nothing broke,
// because nothing compared versions -- until the auto-update design (docs/AUTO-UPDATE.md), whose
// whole job is to answer "is this release newer than the one I am running". A comparison against
// the wrong field answers wrongly, and would do so silently.
//
// The fix was to make package.json the authority and have main.js read it. These tests exist so
// the next person cannot reintroduce the second copy without being told.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('package.json carries a valid semver version', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `"${pkg.version}" is not a semver string, and the update check compares it`);
});

test('the server reports package.json version, not a second copy of it', async () => {
  // A literal here is the bug this file exists for. Read the source rather than booting: booting
  // needs a config and a node, and the property under test is textual.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'main.js'), 'utf8');
  const literal = src.match(/const VERSION = '([^']+)'/);
  assert.equal(literal, null,
    `server/main.js hardcodes the version as "${literal?.[1]}"; it must read package.json so the two cannot drift`);
  assert.match(src, /const VERSION = JSON\.parse\(fs\.readFileSync\(path\.join\(ROOT, 'package\.json'\)/,
    'the version should come from package.json');
});

test('the newest released CHANGELOG section matches the shipped version', () => {
  // Keep a Changelog puts unreleased work under [Unreleased]; the newest `## [x.y.z]` heading is
  // therefore what was last released, and that is what the app should be calling itself.
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const releases = [...log.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  assert.ok(releases.length >= 1, 'CHANGELOG.md should carry at least one released version');
  assert.equal(releases[0], pkg.version,
    `CHANGELOG's newest release is ${releases[0]} but package.json says ${pkg.version}; `
    + 'an update check comparing these would be wrong');
});

test('the documented version in the README matches too', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const m = readme.match(/Version \*\*(\d+\.\d+\.\d+)\*\*/);
  assert.ok(m, 'README should state the version in its Status section');
  assert.equal(m[1], pkg.version, `README says ${m[1]}, package.json says ${pkg.version}`);
});

test('versions sort the way an update check would need them to', () => {
  // The 0.0.9 / 0.9.0 trap: string comparison gets this backwards, and that is the exact pair this
  // project had. Any future update logic must use a numeric compare, so pin the expectation here.
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
    return 0;
  };
  assert.ok(cmp('0.9.0', '0.0.9') > 0, '0.9.0 is newer than 0.0.9');
  assert.ok(cmp('0.10.0', '0.9.0') > 0, '0.10.0 is newer than 0.9.0 -- string compare says otherwise');
  assert.ok('0.10.0' < '0.9.0', 'and this is why: string order is not version order');
  assert.equal(cmp('0.9.0', '0.9.0'), 0);
});
