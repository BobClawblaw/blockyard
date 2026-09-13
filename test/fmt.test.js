// fmt.js -- the pure formatters. Covered here specifically for nodeWarnings(), the one place
// where the UI declines to show something the node said.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fmt from '../public/js/fmt.js';

// The exact string bmcbitcoind reports, read off the running node 2026-09-13.
const PRE = 'This is a pre-release test build - use at your own risk - do not use for mining or merchant applications';

test('the permanent pre-release notice is dropped from the banner', () => {
  // (operator, 2026-09-13, getting ready for release: "how do we get rid of the node warning?")
  // It is true, and it never goes away, so a red caveat sat across the hero for ever and stopped
  // carrying information.
  assert.deepEqual(fmt.nodeWarnings([PRE]), []);
  assert.deepEqual(fmt.nodeWarnings([PRE.toUpperCase()]), [], 'matched regardless of case');
});

test('EVERY OTHER node warning still reaches the banner', () => {
  // THE ASSERTION THIS FILE EXISTS FOR. "Hide the pre-release notice" must never quietly become
  // "hide node warnings": these are the ones an operator has to see.
  const real = [
    'Warning: unknown new rules activated (versionbit 28)',
    'Large chain reorganisation detected',
    'Warning: unsupported chainstate database format found',
    'Error: Disk space is critically low!',
  ];
  assert.deepEqual(fmt.nodeWarnings(real), real, 'a real warning is never filtered');
  for (const w of real) assert.deepEqual(fmt.nodeWarnings([w]), [w], w);
});

test('a mixed list keeps the real warning and drops only the notice', () => {
  assert.deepEqual(
    fmt.nodeWarnings([PRE, 'Large chain reorganisation detected']),
    ['Large chain reorganisation detected'],
    'the banner still fires, carrying only what matters',
  );
});

test('odd input is an empty list, not a crash', () => {
  // s.warnings is whatever the node handed over: absent on a node that reports none, a bare
  // string on older builds, null from a snapshot taken mid-failure.
  for (const bad of [undefined, null, '', 'a bare string', 0, {}, NaN]) {
    assert.deepEqual(fmt.nodeWarnings(bad), [], JSON.stringify(bad ?? null));
  }
  assert.deepEqual(fmt.nodeWarnings(['', '   ', null, 42, PRE]), [], 'blanks and non-strings drop out');
});

test('both banners filter: neither render site joins the raw array', () => {
  // The compact hero and the expanded `detail` view each render the warnings. Filtering one and
  // not the other would simply move the notice behind a button.
  const src = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const banners = [...src.matchAll(/Node warnings:<\/b> \$\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(banners.length, 2, `expected both warning banners, found ${banners.length}`);
  for (const b of banners) {
    assert.match(b, /nodeWarnings\(/, `a banner joins the raw array instead of the filtered one: ${b}`);
  }
  // and the raw join must be gone from both
  assert.equal(/F\.esc\(s\.warnings\.join/.test(src), false, 'the unfiltered join must not survive anywhere');
});
