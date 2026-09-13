// THE BOOTSTRAP CREDENTIAL'S RANDOMNESS.
//
// randomPassword() drew characters as randomBytes()[i] % alphabet.length. The alphabet is 66 long
// and 256 % 66 = 58, so the first 58 characters came up slightly more often than the last 8 --
// a modest bias, in the one function whose whole job is to be unguessable. (Audit, 2026-09-13.)
//
// The distribution assertion below is deliberately a real measurement rather than a source grep:
// a test that only checked for the string "randomInt" would pass against any implementation that
// mentioned it, including a broken one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomPassword } from '../server/auth/users.js';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%*-+=';

test('the password uses the stated alphabet and length, and never repeats itself', () => {
  const a = randomPassword(20);
  assert.equal(a.length, 20);
  for (const ch of a) assert.ok(ALPHABET.includes(ch), `"${ch}" is not in the alphabet`);
  const many = new Set(Array.from({ length: 200 }, () => randomPassword(20)));
  assert.equal(many.size, 200, 'two identical 20-character draws means the source is not random');
});

test('every character of the alphabet is reachable, and none is systematically favoured', () => {
  // 66 symbols over 40k draws is ~606 expected each. The old modulo form over-drew the first 58
  // by a factor of 2/1 at the extreme (two chances per 256 vs one); that shows up far outside
  // these bounds, while flat sampling sits comfortably inside them.
  const N = 40_000;
  const counts = new Map([...ALPHABET].map((c) => [c, 0]));
  let drawn = 0;
  while (drawn < N) {
    for (const ch of randomPassword(20)) {
      counts.set(ch, counts.get(ch) + 1);
      drawn += 1;
      if (drawn >= N) break;
    }
  }
  const expected = N / ALPHABET.length;
  const missing = [...counts].filter(([, n]) => n === 0).map(([c]) => c);
  assert.deepEqual(missing, [], `these characters never appeared: ${missing.join('')}`);

  // A generous band: this is a randomness smoke test, not a chi-squared suite, and it must not
  // fail on an unlucky run. The bias it exists to catch is ~2x on a third of the alphabet.
  for (const [ch, n] of counts) {
    assert.ok(n > expected * 0.6 && n < expected * 1.4,
      `"${ch}" appeared ${n} times against an expected ~${Math.round(expected)} -- the draw is not flat`);
  }
});
