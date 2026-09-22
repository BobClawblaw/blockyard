// WHICH STORE THIS BROWSER READS (public/js/settings.js settingsMode/setSettingsMode/SETTINGS_MODES;
// operator, 2026-09-22: "per-user options for storing configs on either the browser, or server ...
// allow per-user settings also on server side"). Meta, not one of DEFAULTS -- its own localStorage
// key, its own tiny test file, deliberately kept away from settings.test.js's "every PANEL row
// names a real setting" assertion, since this control is never a PANEL row.
import test from 'node:test';
import assert from 'node:assert/strict';
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
