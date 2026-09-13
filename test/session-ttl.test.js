// SESSION LIFETIME SEMANTICS.
//
// An audit on 2026-09-13 found the two TTLs inverted: sessionTtlMs (absolute) was 8 h and
// idleTtlMs (idle ceiling) was 72 h, so the idle check in SessionStore.get() could never fire --
// no session survived long enough to be 72 h idle. The effect was "every session is 8 h, whatever
// you do", while docs/SECURITY.md described the intended relationship instead of the shipped one.
//
// The invariant is the point: an idle ceiling longer than the absolute lifetime is dead code, and
// dead code that looks like a security control is worse than no control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };

test('the idle ceiling is not longer than the absolute session lifetime', () => {
  const cfg = loadConfig({ configFile: '/nonexistent.json', ifaces });
  assert.ok(cfg.auth.idleTtlMs <= cfg.auth.sessionTtlMs,
    `idleTtlMs (${cfg.auth.idleTtlMs}) must not exceed sessionTtlMs (${cfg.auth.sessionTtlMs}), `
    + 'or the idle check can never fire and the shorter value silently becomes the only rule');
});

test('both ceilings are actually reachable, so neither is decoration', () => {
  const cfg = loadConfig({ configFile: '/nonexistent.json', ifaces });
  assert.ok(cfg.auth.idleTtlMs > 0 && cfg.auth.sessionTtlMs > 0, 'both must be positive');
  // A session idle for longer than the idle ceiling must die BEFORE the absolute one would take
  // it -- that is what makes the idle rule do any work at all.
  assert.ok(cfg.auth.idleTtlMs < cfg.auth.sessionTtlMs,
    'with the two equal the idle rule never decides anything on its own');
});

test('the shipped values are the documented ones: 8 h idle, 72 h absolute', () => {
  const cfg = loadConfig({ configFile: '/nonexistent.json', ifaces });
  assert.equal(cfg.auth.idleTtlMs, 8 * 3600 * 1000);
  assert.equal(cfg.auth.sessionTtlMs, 72 * 3600 * 1000);
});
