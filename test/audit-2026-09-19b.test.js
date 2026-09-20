// AUDIT 2026-09-19 ROUND 2 regression tests: the M2 follow-up gate on /api/events
// (open-mode log feed), N1 (admin.allowWithoutAuth named in the suite's own reporting),
// N2 (the shipped unit pins PATH) and N3 (the regtest helper skips with a reason instead
// of failing N tests on a host that cannot run regtest).
//
// Each test failed against the code before its fix -- the convention every other audit
// round in this repository followed. The report this round is docs/SECURITY-AUDIT-2026-09-19b.md
// and the remediation record docs/REMEDIATION-2026-09-19b.md; the "b" avoids clobbering
// the parallel 2026-09-19 report (docs/REMEDIATION-2026-09-19.md, a different audit).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, HttpError } from '../server/http/api.js';
import { loadConfig } from '../server/config.js';
import { withApp } from './helpers/http.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4' }] };

// ----------------------------------------------------------------- M2 follow-up: /api/events

// The feed's three shapes: what the monitor decided (source "monitor"), a structured row
// the log parser produced (source "log", kind "bandwidth"), and a raw, unparsed log line
// (source "log", kind "raw") -- the one that carries node-log text verbatim.
const FEED = [
  { seq: 1, source: 'monitor', kind: 'block', severity: 'info', text: 'block 850000 seen' },
  { seq: 2, source: 'log', kind: 'bandwidth', severity: 'info', text: 'download 11.56 MB/s' },
  { seq: 3, source: 'log', kind: 'raw', severity: 'info', text: '2026-09-19T01:00:00Z a line no rule claims' },
];
const eventsApp = ({ enabled = false, openEventsFromNetwork } = {}) => ({
  cfg: { auth: { enabled, openEventsFromNetwork } },
  history: { eventsSeq: 3, eventsSinceSeq: (seq, limit) => FEED.filter((r) => r.seq > seq).slice(0, limit) },
});
const eventsRoute = () => routes.find((r) => r.method === 'GET' && r.path === '/api/events');
function callEvents(app, query) {
  const ctx = { query, req: { socket: { remoteAddress: '198.51.100.7' } }, user: { username: 'anonymous', role: 'viewer' } };
  try { return { ok: eventsRoute().handler(ctx, app) }; } catch (err) { return { err }; }
}
const kinds = (r) => (r.ok ? r.ok.events.map((e) => e.kind).sort() : null);

test('M2-follow-up: with accounts off, ?source=all on /api/events is refused and names the switch', () => {
  for (const source of ['all', 'log,all', 'monitor,all']) {
    const r = callEvents(eventsApp(), { source });
    assert.ok(r.err instanceof HttpError, `?source=${source} must be refused, got ${r.ok ? JSON.stringify(r.ok) : 'no error'}`);
    assert.equal(r.err.status, 403);
    assert.equal(r.err.code, 'log_feed_closed');
    assert.match(r.err.message, /auth\.openEventsFromNetwork/);
  }
});

test('M2-follow-up: with accounts off, no ?source=all reaches the log and no raw row answers', () => {
  // The default source (what the UI asks for, no source at all) is the monitor's own rows.
  const def = callEvents(eventsApp(), {}).ok;
  assert.deepEqual(kinds({ ok: def }), ['block']);
  // ?source=log stays usable for the STRUCTURED log rows -- the parser's work is still
  // readable -- but the raw, unparsed lines are not part of the open read surface.
  const log = callEvents(eventsApp(), { source: 'log' }).ok;
  assert.deepEqual(kinds({ ok: log }), ['bandwidth'], 'structured log rows answer; raw rows do not');
  const mixed = callEvents(eventsApp(), { source: 'monitor,log' }).ok;
  assert.deepEqual(kinds({ ok: mixed }), ['bandwidth', 'block']);
  // A ?kind=raw ask cannot smuggle the row back: the source filter alone already excludes
  // it from "monitor", and the raw filter excludes it from "log".
  assert.deepEqual(kinds(callEvents(eventsApp(), { source: 'log', kind: 'raw' })), []);
});

test('M2-follow-up: auth.openEventsFromNetwork restores the old reach, and only in open mode', () => {
  const opted = callEvents(eventsApp({ openEventsFromNetwork: true }), { source: 'all' });
  assert.deepEqual(kinds(opted), ['bandwidth', 'block', 'raw'], 'the explicit opt-in restores ?source=all with the raw rows');
  // With accounts on the gate does not exist at all: the switch is open-mode only.
  const on = callEvents(eventsApp({ enabled: true }), { source: 'all' });
  assert.deepEqual(kinds(on), ['bandwidth', 'block', 'raw']);
  assert.deepEqual(kinds(callEvents(eventsApp({ enabled: true, openEventsFromNetwork: true }), { source: 'all' })), ['bandwidth', 'block', 'raw']);
});

test('M2-follow-up: the default config is the closed gate', () => {
  const cfg = loadConfig({ configFile: '/nonexistent.json', ifaces });
  assert.equal(cfg.auth.openEventsFromNetwork, false);
  assert.equal(cfg.auth.openNodeConfigFromNetwork, false, 'the sibling switch is untouched');
});

test('M2-follow-up: the gate is wired through the real server, not just the handler', async () => {
  await withApp({ auth: false, config: {} }, async ({ client, app }) => {
    // The UI's own call (no source) still answers.
    const def = await client.get('/api/events?limit=500');
    assert.equal(def.status, 200);
    assert.ok(Array.isArray(def.body.events));
    assert.ok(def.body.events.every((e) => e.kind !== 'raw'), 'no raw row in an open-mode answer');
    // The log feed is the part that is closed.
    const all = await client.get('/api/events?source=all');
    assert.equal(all.status, 403);
    assert.equal(all.body.error.code, 'log_feed_closed');
    assert.match(all.body.error.message, /auth\.openEventsFromNetwork/);
    assert.equal(app.cfg.auth.openEventsFromNetwork, false);
  });
});

// --------------------------------------------------------------------------- N2: the unit

test('N2: the shipped unit pins PATH instead of trusting systemd\'s default', () => {
  // ExecStart goes through /usr/bin/env node. The unit is sandboxed (the 09-16 M8 fix holds),
  // so a compromised process cannot swap the interpreter; what the pin protects against is
  // the ordinary case -- an install whose default PATH resolves node to something else. The
  // line was present but commented out; a commented directive is the pre-fix state.
  const unit = fs.readFileSync(path.join(ROOT, 'systemd', 'blockyard.service'), 'utf8');
  const lines = unit.split('\n');
  assert.ok(lines.some((l) => l.startsWith('Environment=PATH=')), 'Environment=PATH= must be an active directive');
  assert.ok(!lines.some((l) => l.trim().startsWith('#Environment=PATH=')), 'the commented-out form is the pre-fix state');
  assert.match(unit, /^Environment=PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/bin$/m, 'the pinned path keeps /usr/local/bin first, where the measured too-old and root-only interpreters live -- the pin documents the order, it does not guess a new one');
});
