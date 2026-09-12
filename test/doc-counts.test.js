// The documented test count, checked against the suite rather than against itself.
//
// Two failures this closes:
//
// 1. README/AGENTS drift. On 2026-09-08 the count went out of sync three times
//    because each fix was a sed over a string a previous fix had already rewritten
//    — the replacement matched nothing, so the edit "succeeded" and the number
//    stayed stale. A guard that compared README with AGENTS.md then passed while
//    both were wrong (measured 2026-09-09: docs said 180, `npm test` printed 183).
//    Self-consistency is not truth; the only fix is to compare against the suite.
//
// 2. A decorative scanner. The count here is derived by scanning `test(` at line
//    start, which equals what `node --test` reports ONLY while no test declares a
//    subtest. That is an assumption about a file this test does not otherwise
//    read, so the scanner is validated against a real `node --test` run of three
//    real files, and any nested declaration fails the suite outright. An
//    assertion that can only pass is the same bug as the sed that matched nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { scanTests, docCounts, ROOT } from '../scripts/doc-counts.js';

const scan = scanTests({ root: ROOT });

// `node --test` sets NODE_TEST_CONTEXT=child-v8 in a worker's environment, and a
// child that inherits it refuses to run files at all:
//   "node:test run() is being called recursively within a test file. skipping
//    running files."  -> stdout empty, exit status 0
// That is a child process that *succeeds* while having measured nothing, so the
// variable is removed deliberately and the parse below stays strict enough to
// fail on an empty stream rather than default to zero.
//
// ASK FOR TAP; DO NOT TAKE THE DEFAULT. The default reporter is not a stable interface: it is
// TAP on Node 22 and the spec reporter on Node 24, which prints "i tests 34" and a tick per
// test instead of "# tests 34". This function used to take whatever the default was, so the
// parse below found nothing on Node 24 and the test failed there while passing on 22 --
// caught by the CI matrix on its second run ever. `--test-reporter=tap` pins the format to
// the one the parse was written against, on every major.
function runFile(file) {
  const env = { ...process.env, BLOCKYARD_CONFIG: 'none' };
  delete env.NODE_TEST_CONTEXT;
  return execFileSync(
    process.execPath,
    ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', file],
    { cwd: ROOT, encoding: 'utf8', env, timeout: 60_000 },
  );
}

test('the scanner counts the same tests `node --test` runs', (t) => {
  // Proves the derivation is the real thing, not a plausible-looking regex.
  for (const f of ['test/sync.test.js', 'test/node-series.test.js', 'test/logparse.test.js']) {
    const tap = runFile(f);
    const ran = Number(tap.match(/^# tests (\d+)$/m)?.[1] ?? NaN);
    assert.ok(Number.isFinite(ran), `${f}: could not read "# tests N" from the reporter output`);
    const declared = scan.perFile[f];
    assert.equal(ran, declared, `${f}: \`node --test\` ran ${ran} but the scanner declared ${declared} — the doc count would silently be wrong`);
    t.diagnostic(`${f}: ${ran} run, ${declared} declared`);
  }
});

test('no test declares a subtest, which the scanner cannot see', () => {
  assert.deepEqual(scan.nested, [],
    'a nested `test()` makes the declared count smaller than the reported count; either hoist it or teach scripts/doc-counts.js to count subtests');
});

test('the suite is not empty and every test file contributes', () => {
  assert.ok(scan.files >= 10, `expected the suite to span many files, found ${scan.files}`);
  assert.ok(scan.total > 100, `${scan.total} tests is fewer than this suite has had since 2026-09-08`);
  const empty = Object.entries(scan.perFile).filter(([, n]) => n === 0).map(([f]) => f);
  assert.deepEqual(empty, [], 'a *.test.js with no declarations is dead weight that still passes CI');
});

test('every documented test count equals the number the suite actually declares', () => {
  const docs = docCounts({ root: ROOT });
  assert.ok(docs.length >= 2, 'README and AGENTS should each quote a count; a doc with none cannot drift and should not silently gain that property');
  const wrong = docs.filter((d) => d.count !== scan.total);
  assert.deepEqual(wrong, [],
    `documented test count is stale: the suite declares ${scan.total}. Offenders: `
    + `${wrong.map((w) => `${w.file} ("${w.match}")`).join(', ')} -- run \`node scripts/doc-counts.js --fix\``);
  // And say the number out loud, so a passing run records what it agreed to.
  assert.ok(docs.every((d) => d.count === scan.total));
});

test('the count in the docs is stated once per file, not paraphrased elsewhere', () => {
  const perFile = {};
  for (const d of docCounts({ root: ROOT })) perFile[d.file] = (perFile[d.file] ?? 0) + 1;
  for (const [file, n] of Object.entries(perFile)) {
    assert.ok(n <= 3, `${file} quotes the test count ${n} times; each one is another thing to update in lockstep — collapse them to one mention`);
  }
});
