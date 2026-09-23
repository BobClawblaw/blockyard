// WHICH STORE THIS BROWSER READS (public/js/settings.js settingsMode/setSettingsMode/SETTINGS_MODES;
// operator, 2026-09-22: "per-user options for storing configs on either the browser, or server ...
// allow per-user settings also on server side"). Meta, not one of DEFAULTS -- its own localStorage
// key, its own tiny test file, deliberately kept away from settings.test.js's "every PANEL row
// names a real setting" assertion, since this control is never a PANEL row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settingsMode, setSettingsMode, SETTINGS_MODE_KEY, SETTINGS_MODES } from '../public/js/settings.js';

function store() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('the shipped mode is "shared" -- the only behaviour that existed before this setting did', () => {
  const s = store();
  assert.equal(settingsMode(s), 'shared');
});

test('an unset, corrupt or unrecognised value falls back to "shared" rather than throwing', () => {
  const s = store();
  s.setItem(SETTINGS_MODE_KEY, 'nonsense');
  assert.equal(settingsMode(s), 'shared');
  s.setItem(SETTINGS_MODE_KEY, '');
  assert.equal(settingsMode(s), 'shared');
});

test('setSettingsMode persists a valid mode and settingsMode reads it back', () => {
  const s = store();
  for (const m of SETTINGS_MODES) {
    setSettingsMode(m, s);
    assert.equal(settingsMode(s), m);
  }
});

test('setSettingsMode refuses an unknown mode, and leaves the stored value untouched', () => {
  const s = store();
  setSettingsMode('account', s);
  assert.throws(() => setSettingsMode('bogus', s), TypeError);
  assert.equal(settingsMode(s), 'account', 'a rejected write must not clobber the last valid one');
});

test('SETTINGS_MODES names exactly the three stores this feature offers', () => {
  assert.deepEqual([...SETTINGS_MODES], ['shared', 'browser', 'account']);
});

// SWITCHING MODES USED TO DISCARD SILENTLY (operator, 2026-09-23, of the answer to "does a
// 'This browser' edit survive a switch to Shared": it did not -- the click handler pulled the
// newly active store's value over the local cache unconditionally, so an edit made only in
// 'This browser' vanished the moment someone switched to 'Shared', with nothing said about it).
// These are source-level assertions (app.js has no DOM test harness; every other test of its
// button wiring in this suite -- settings.test.js's "the gear opens a panel", market-polling.test.js's
// "a FRESH server starts..." -- reads the file as text for the same reason) rather than a
// behavioural replay, but they pin the shape of the fix: pull-then-compare-then-confirm, and
// 'browser' itself never pulls or confirms, since it has nothing to lose by keeping what is there.
test('switching to Shared or My account asks before discarding a real difference', () => {
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const handler = app.slice(app.indexOf("cfgStorage?.addEventListener('click'"), app.indexOf('const openSettings ='));
  assert.match(handler, /window\.confirm\(/, 'a real difference is confirmed, not silently applied');
  assert.match(handler, /JSON\.stringify\(loadSettings\(\)\)\s*!==\s*JSON\.stringify\(pulled\)/,
    'the confirm is gated on an actual difference, not asked on every switch');
  // the confirm sits inside the branch that pulls from the server (shared/account); 'browser'
  // never reaches it, since there is nothing pulled to compare against
  const confirmIndex = handler.indexOf('window.confirm(');
  const pullBranchStart = handler.indexOf("m === 'shared' || m === 'account'");
  assert.ok(pullBranchStart >= 0 && confirmIndex > pullBranchStart,
    'the confirm must be inside the shared/account pull branch');
});
