import test from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../server/http/api.js';

// Behaviour, not pattern-matching. The previous version of this check grepped
// api.js for the right-looking expression and passed while `optional` was missing
// from the node mapping -- so `required` saw `undefined` on every node, treated
// every node as required, and the fix did nothing at all. Rule 14 again, in the
// mirror direction: assert what the code DOES, not what it resembles.

const health = routes.find((r) => r.path === '/api/health' && r.method === 'GET');

const monitor = (id, { online, optional = false, chain = 'main', tip = 100 }) => ({
  id,
  label: id,
  cfg: { optional },
  state: { chain, chainInfo: { blocks: tip }, lastError: null },
  rpc: { telemetry: () => ({ online }) },
});

const app = (...monitors) => ({
  monitors: new Map(monitors.map((m) => [m.id, m])),
  version: 'test',
  startedAt: Date.now() - 1000,
  cfg: { auth: { enabled: true } },
});

test('health stays ok when only an optional node is down', () => {
  const h = health.handler({}, app(
    monitor('prod', { online: true }),
    monitor('bench', { online: false, optional: true }),
  ));
  assert.equal(h.ok, true, 'a benchmark that went away is not an application outage');
  assert.deepEqual(h.degraded, ['bench'], 'but it is still reported');
  assert.equal(h.nodes.find((n) => n.id === 'bench').optional, true);
});

test('health goes false when a required node is down', () => {
  const h = health.handler({}, app(
    monitor('prod', { online: false }),
    monitor('bench', { online: true, optional: true }),
  ));
  assert.equal(h.ok, false);
  assert.deepEqual(h.degraded, ['prod']);
});

test('all healthy is ok with an empty degraded list', () => {
  const h = health.handler({}, app(
    monitor('prod', { online: true }),
    monitor('bench', { online: true, optional: true }),
  ));
  assert.equal(h.ok, true);
  assert.deepEqual(h.degraded, []);
});

test('no nodes configured at all is not "ok", because that is a misconfiguration', () => {
  const h = health.handler({}, app());
  assert.equal(h.ok, false, 'an empty node list must not read as healthy');
});

test('two required nodes both down is false, and one required down is false', () => {
  const bothDown = health.handler({}, app(monitor('a', { online: false }), monitor('b', { online: false })));
  assert.equal(bothDown.ok, false);
  assert.deepEqual(bothDown.degraded, ['a', 'b']);
  const oneUp = health.handler({}, app(monitor('a', { online: true }), monitor('b', { online: false })));
  assert.equal(oneUp.ok, false, 'a required node down must not be tolerated just because another is up');
});
