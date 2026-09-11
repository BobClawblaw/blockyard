// Which nodes this deployment watches is a decision, and it should be assertable.
// The benchmark node (`bmc-bench`) was removed from the defaults on 2026-09-08: the
// node's RPC services one connection on one thread, so polling a benchmark from the
// machine running it is load, and a monitor that shares a box with a benchmark is a
// load generator wearing a label. Multi-node support is intact and stays tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configProblems } from '../server/config.js';

// Hermetic interface set. loadConfig validates a bind address against the
// interfaces the box actually has, so without injecting one every test that names
// a bind address can only pass by naming THIS machine's real address -- fragile
// across leases, and a reason to commit a host address into a repository. The
// addresses below are RFC 5737 documentation ranges, present nowhere but here.
const IFACES = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '192.0.2.10', family: 'IPv4', internal: false }],
  tunnel0: [{ address: '198.51.100.7', family: 'IPv4', internal: false }],
};

const load = (obj, opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcmon-cfg-'));
  const file = path.join(dir, 'local.json');
  if (obj !== undefined) fs.writeFileSync(file, JSON.stringify(obj));
  return loadConfig({ configFile: file, ifaces: IFACES, ...opts });
};

test('the default configuration watches production and nothing else', () => {
  const cfg = load(undefined);
  assert.deepEqual(cfg.nodes.map((n) => n.id), ['bmc-main'],
    'the benchmark node must not be polled by default');
  assert.equal(cfg.nodes[0].rpcUrl, 'http://127.0.0.1:8331');
  assert.equal(cfg.nodes[0].logFile, '/storage/bitcoinmachinecode/logs/main/bitcoin.main.log');
  assert.equal(configProblems().length, 0, `config self-check complains: ${configProblems()}`);
});

test('the benchmark node is not reachable by accident (env overrides point nodes[0] only)', () => {
  // BMC_MON_NODE_URL/BMC_MON_DATADIR re-point the first node; they must not smuggle
  // a second one back in.
  process.env.BMC_MON_NODE_URL = 'http://127.0.0.1:8331';
  try {
    const cfg = load(undefined);
    assert.equal(cfg.nodes.length, 1);
    assert.equal(cfg.nodes[0].rpcUrl, 'http://127.0.0.1:8331');
  } finally { delete process.env.BMC_MON_NODE_URL; }
});

test('multi-node is a supported configuration, not a removed feature', () => {
  const cfg = load({
    nodes: [
      { id: 'bmc-main', label: 'production', rpcUrl: 'http://127.0.0.1:8331', datadir: '/tmp', chainHint: 'main' },
      { id: 'other', label: 'a second node', rpcUrl: 'http://127.0.0.1:9999', datadir: '/tmp', chainHint: 'main', optional: true },
    ],
  });
  assert.deepEqual(cfg.nodes.map((n) => n.id), ['bmc-main', 'other']);
  assert.equal(cfg.nodes[1].optional, true, 'an optional node reads as a note, not an outage');
  assert.equal(configProblems().length, 0);
});

test('an unusable node entry is refused at load, not half-watched at runtime', () => {
  // loadConfig throws, and the message names the node -- a typo in rpcUrl should not
  // boot a monitor that quietly polls nothing.
  assert.throws(
    () => load({ nodes: [{ id: 'broken', label: 'broken', rpcUrl: 'not-a-url', datadir: '/tmp' }] }),
    /node broken: rpcUrl must be http\(s\):\/\/host:port/,
  );

  // Emptying the list must not be a way to "watch nothing".
  assert.throws(() => load({ nodes: [] }), /nodes must be non-empty/);

  // And no config path resurrects the benchmark node implicitly.
  const cfg = load({ nodes: [{ id: 'solo', label: 'solo', rpcUrl: 'http://127.0.0.1:1', datadir: '/tmp' }] });
  assert.deepEqual(cfg.nodes.map((n) => n.id), ['solo']);
});

test("a hermetic run can opt out of this machine's config file", () => {
  // Regression, the day it mattered: scripts/smoke.sh pinned its data dir, ports and
  // admin password but not the bind, so a deployment choice in config/local.json
  // (bind LAN + tailnet) leaked into the run and the script curled 127.0.0.1 against a
  // server listening elsewhere. 2 assertions passed, 54 failed, and nothing said
  // "nothing is listening there".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcmon-cfgfile-'));
  const file = path.join(dir, 'local.json');
  fs.writeFileSync(file, JSON.stringify({ server: { hosts: ['192.0.2.10', '198.51.100.7'] } }));
  const withFile = loadConfig({ configFile: file, ifaces: IFACES });
  assert.deepEqual(withFile.server.hosts, ['192.0.2.10', '198.51.100.7']);

  const prev = process.env.BMC_MON_CONFIG;
  process.env.BMC_MON_CONFIG = 'none';
  try {
    const hermetic = loadConfig({ configFile: undefined, ifaces: IFACES });
    assert.deepEqual(hermetic.server.hosts, ['0.0.0.0'], 'BMC_MON_CONFIG=none must ignore the machine file entirely');
  } finally {
    if (prev === undefined) delete process.env.BMC_MON_CONFIG; else process.env.BMC_MON_CONFIG = prev;
  }

  // A non-regular file must not throw on parse either (the old /dev/null trap).
  assert.doesNotThrow(() => loadConfig({ configFile: '/dev/null', ifaces: IFACES }));
});

test('the smoke and dev scripts are hermetic about the bind, in their source', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const smoke = fs.readFileSync(path.join(root, 'scripts/smoke.sh'), 'utf8');
  assert.match(smoke, /BMC_MON_CONFIG=none/, 'smoke must not inherit this box config');
  assert.match(smoke, /BMC_MON_BIND=127\.0\.0\.1/, 'and must say where it expects the server');
  // The readiness loop must diagnose an unreachable port instead of cascading.
  assert.match(smoke, /never answered at/, 'a dead port is a wiring fact, not 54 contract failures');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.dev, /BMC_MON_CONFIG=none/);
  assert.match(pkg.scripts.dev, /BMC_MON_BIND=127\.0\.0\.1/);
});
