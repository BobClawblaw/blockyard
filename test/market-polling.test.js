// THE MARKET SWITCH (operator, 2026-09-15: "disable markets by default so we can claim true zero
// telemetry out of the box" ... "an app wide 'Enable Market Polling' checkbox"): the exchange feed
// polls nobody until the Display setting markets.polling is on, and that ships off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, PANEL, normalise } from '../public/js/settings.js';
import { routes, marketsPollingOn } from '../server/http/api.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'by-polling-')), 'blockyard.json');
const fakeFeed = () => ({ touched: 0, stopped: 0, touch() { this.touched++; }, stop() { this.stopped++; }, view() { return { ok: true, exchanges: [] }; }, depthView() { return { ok: true, n: 0 }; } });
const route = (p) => routes.find((r) => r.path === p && r.method === 'GET');

test('market polling ships OFF, as the first row of Markets & Price', () => {
  assert.equal(DEFAULTS.markets.polling, false);
  assert.equal(normalise(null).markets.polling, false, 'a fresh browser agrees');
  assert.equal(normalise({ markets: { stars: true } }).markets.polling, false, 'and an older stored file, which never had the key, gets off');
  const rows = PANEL.find((g) => g.group === 'markets')?.rows ?? [];
  assert.equal(rows[0]?.key, 'polling');
  assert.equal(rows[0]?.label, 'Enable market polling');
  assert.match(rows[0]?.hint ?? '', /Off out of the box/);
});

test('marketsPollingOn reads the shared settings file, and follows its edits', async () => {
  const app = { settingsFile: tmpFile() };
  assert.equal(await marketsPollingOn(app), false, 'no file yet: off');
  fs.writeFileSync(app.settingsFile, JSON.stringify({ markets: { polling: true } }));
  assert.equal(await marketsPollingOn(app), true);
  fs.writeFileSync(app.settingsFile, JSON.stringify({ markets: { polling: false, stars: true, effects: true } }));
  assert.equal(await marketsPollingOn(app), false, 'unticked: off on the next call');
  fs.writeFileSync(app.settingsFile, '{ not json');
  assert.equal(await marketsPollingOn(app), false, 'a corrupt file is off, never a throw');
  assert.equal(await marketsPollingOn({}), false, 'no settings file at all: off');
});

test('the market endpoints answer "off" and PARK the feed until the switch is on', async () => {
  const app = { settingsFile: tmpFile(), markets: fakeFeed() };
  for (const p of ['/api/markets', '/api/markets/depth']) {
    const r = await route(p).handler({ query: {} }, app);
    assert.equal(r.ok, true);
    assert.equal(r.enabled, false);
    assert.equal(r.polling, false);
    assert.match(r.note, /Enable market polling/, 'and says where the switch is');
  }
  assert.equal(app.markets.touched, 0, 'nothing was polled');
  assert.equal(app.markets.stopped, 2, 'and the feed was parked on each call');
  fs.writeFileSync(app.settingsFile, JSON.stringify({ markets: { polling: true } }));
  const on = await route('/api/markets').handler({ query: {} }, app);
  assert.equal(on.enabled, undefined, 'ticked: the real view');
  assert.equal(app.markets.touched, 1);
  const depth = await route('/api/markets/depth').handler({ query: { ago: '60' } }, app);
  assert.equal(depth.n, 0);
  assert.equal(app.markets.touched, 2);
});

test('BLOCKYARD_MARKETS=0 is the hard off: the switch cannot turn it on', async () => {
  const app = { settingsFile: tmpFile(), markets: null };
  fs.writeFileSync(app.settingsFile, JSON.stringify({ markets: { polling: true } }));
  const r = await route('/api/markets').handler({ query: {} }, app);
  assert.equal(r.enabled, false);
  assert.equal(r.polling, undefined);
  assert.match(r.note, /cannot turn it on/);
});
