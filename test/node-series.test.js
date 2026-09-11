// One ring per series, shared by every configured node. Measured on 2026-09-08 with
// two live nodes: the `peers` ring held 2,308 rows from production interleaved with
// 1,816 from the bench node, no row saying which -- so the chart drew an average of
// two daemons and looked like a fact about one of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ring } from '../server/store/ring.js';
import { History } from '../server/store/history.js';
import { NodeMonitor } from '../server/collect/monitor.js';
import { routes } from '../server/http/api.js';

const mkHistory = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcmon-nodeseries-'));
  return new History(dir, { ringCapacity: 500, maxEventLog: 100, retentionHours: 24, snapshotEveryMs: 1e9 }, { log: () => {} });
};
const mkMonitor = (id, history) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcmon-nodeseries-m-'));
  const logger = () => {}; logger.child = () => logger;
  return new NodeMonitor({ id, label: id, rpcUrl: `http://127.0.0.1:1`, datadir: dir, chainHint: 'main', logFile: null },
    { rpc: { maxInFlight: 1, minIntervalMs: 250, timeoutMs: 500 }, poll: {}, store: { ringCapacity: 500, maxEventLog: 50, retentionHours: 1, snapshotEveryMs: 1e9 }, log: logger, history });
};

test('a node-filtered series never shows another node\'s points', () => {
  const h = mkHistory();
  const a = h.forNode('alpha');
  const b = h.forNode('beta');
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    a.record('net', { t: now - (10 - i) * 1000, inBps: 1000 });
    b.record('net', { t: now - (10 - i) * 1000 + 500, inBps: 900_000 });
  }
  const raw = h.ring('net').series('inBps');
  assert.equal(raw.length, 20, 'unfiltered still sees everything');

  const onlyA = a.ring('net').series('inBps');
  assert.equal(onlyA.length, 10);
  assert.ok(onlyA.every((p) => p.v === 1000), 'a production chart must not carry bench traffic');
  assert.ok(b.ring('net').series('inBps').every((p) => p.v === 900_000));
});

test('rows written before the tagging are excluded from a node view, not guessed', () => {
  const h = mkHistory();
  const now = Date.now();
  // What today's history.json actually looks like: no node field at all.
  for (let i = 0; i < 6; i++) h.record('net', { t: now - (6 - i) * 1000, inBps: 4242 });
  const view = h.forNode('alpha').ring('net');
  assert.equal(view.series('inBps').length, 0,
    'attributing legacy rows to whichever node asks would put unknown traffic on a named chart');

  const s = h.summary().net;
  assert.equal(s.points, 6);
  assert.equal(s.unattributed, 6, 'but the count is stated, so missing history is not mysterious');
  assert.deepEqual(s.nodes, []);
});

test('the store reports which nodes a series contains', () => {
  const h = mkHistory();
  const now = Date.now();
  h.forNode('alpha').record('node', { t: now - 2000, blocks: 100 });
  h.forNode('beta').record('node', { t: now - 1000, blocks: 200 });
  const s = h.summary().node;
  assert.deepEqual(s.nodes.sort(), ['alpha', 'beta']);
  assert.equal(s.unattributed, 0);
});

test('two monitors sharing a store keep separate series in their own snapshots', () => {
  const h = mkHistory();
  const m1 = mkMonitor('alpha', h);
  const m2 = mkMonitor('beta', h);
  const now = Date.now();
  m1.history.record('node', { t: now, blocks: 111, connections: 17 });
  m2.history.record('node', { t: now, blocks: 222, connections: 4 });

  const v1 = m1.snapshot({ seriesRanges: { day: 3600_000 } }).series;
  const v2 = m2.snapshot({ seriesRanges: { day: 3600_000 } }).series;
  const tips1 = v1.node.tip.map((p) => p.v);
  const tips2 = v2.node.tip.map((p) => p.v);
  assert.ok(tips1.includes(111), `alpha should see its own tip, got ${tips1}`);
  assert.equal(tips1.includes(222), false, 'and not beta\'s');
  assert.ok(tips2.includes(222) && !tips2.includes(111));

  // The monitor must not hand its raw ring to a caller that could bypass the filter
  // by accident; the view keeps `raw` for deliberate cases and defaults everywhere.
  assert.equal(m1.history.ring('node').last().blocks, 111);
  assert.equal(m2.history.ring('node').last().blocks, 222);
});

test('the /api/series endpoint scopes to the node it was asked about', () => {
  const route = routes.find((r) => r.path === '/api/series');
  const h = mkHistory();
  const now = Date.now();
  const m1 = mkMonitor('alpha', h);
  const m2 = mkMonitor('beta', h);
  m1.history.record('mempool', { t: now, count: 11 });
  m2.history.record('mempool', { t: now, count: 2222 });

  const app = { history: h, monitors: new Map([[m1.id, m1], [m2.id, m2]]), primary: m1, cfg: {} };
  // server.js builds ctx.query with Object.fromEntries(searchParams.entries()), i.e.
  // a plain object -- asserting with a URLSearchParams here would silently make
  // pickNode fall back to the primary node and "pass" while testing alpha twice.
  const ctx = (node) => ({ user: { username: 'u', role: 'admin' }, query: { node, range: '1h' }, ip: 'x' });

  const a = route.handler(ctx('alpha'), app);
  const b = route.handler(ctx('beta'), app);
  const av = Object.values(a.series.mempool).flat().map((p) => p.v);
  const bv = Object.values(b.series.mempool).flat().map((p) => p.v);
  assert.ok(av.includes(11) && !av.includes(2222), `alpha endpoint leaked: ${av}`);
  assert.ok(bv.includes(2222) && !bv.includes(11), `beta endpoint leaked: ${bv}`);
  assert.equal(a.node, 'alpha');
  assert.equal(b.node, 'beta', 'guards the stub above: if pickNode falls back to the primary, both halves of this assertion test the same node');
});

test('events carry the node they came from', () => {
  // The SSE hub already filters delivery per node; the rows themselves were silent,
  // which made the stored event log unreadable across two nodes.
  const h = mkHistory();
  const v = h.forNode('alpha');
  const row = v.addEvent({ kind: 'block_stored', height: 5, ts: Date.now() });
  assert.equal(row.node, 'alpha');
  assert.equal(h.events[0].node, 'alpha');
});

test('ring capacity is shared, and that trade-off is a stated decision', () => {
  // One ring per series (not per node) means two nodes halve each other's reach
  // back in time. Asserted so the choice stays visible: switching to per-node rings
  // would multiply memory by node count and orphan a removed node's history.
  const ring = new Ring(6);
  const now = Date.now();
  for (let i = 0; i < 6; i++) ring.push({ t: now + i * 1000, node: i % 2 ? 'a' : 'b', v: i });
  assert.equal(ring.length, 6);
  assert.equal(ring.series('v', { node: 'a' }).length, 3);
  assert.deepEqual(ring.nodes().sort(), ['a', 'b']);
  ring.push({ t: now + 6000, node: 'a', v: 99 });
  assert.equal(ring.length, 6, 'capacity evicts across both nodes, oldest first');
});
