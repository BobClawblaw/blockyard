// Environment-variable config, asserted in a file that boots nothing.
//
// Node runs a file's top-level tests CONCURRENTLY, and process.env is process-global:
// a test here that sets BLOCKYARD_AUTH while another test in the same file boots the
// server makes *that* boot read the wrong configuration (observed as a 401 in an
// open-access test and as "Invalid configuration" in an innocent one). So env
// assertions live apart from boots, in this file, which only ever calls loadConfig().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4' }] };

/** Set env vars for one test and put the previous values back. */
async function withEnv(vars, fn) {
  const had = Object.keys(vars).map((k) => [k, process.env[k]]);
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of had) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('accounts are OFF by default, and BLOCKYARD_AUTH is the switch back', () => {
  assert.equal(loadConfig({ configFile: '/nonexistent.json', ifaces }).auth.enabled, false,
    'the default posture: open reads, no sign-in');
  assert.equal(loadConfig({ configFile: '/nonexistent.json', ifaces, env: undefined }).auth.enabled, false);
  return withEnv({ BLOCKYARD_AUTH: '1' }, () => {
    assert.equal(loadConfig({ configFile: '/nonexistent.json', ifaces }).auth.enabled, true);
  }).then(() => withEnv({ BLOCKYARD_AUTH: '0' }, () => {
    assert.equal(loadConfig({ configFile: '/nonexistent.json', ifaces }).auth.enabled, false);
  }));
});

test('the writes-while-open guard is a boot error with both ways out named', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-env-'));
  try {
    const f = path.join(dir, 'c.json');
    fs.writeFileSync(f, JSON.stringify({}));
    return withEnv({ BLOCKYARD_ENABLE_ACTIONS: '1', BLOCKYARD_ACTIONS: 'savemempool' }, () => {
      assert.throws(() => loadConfig({ configFile: f, ifaces }),
        /accounts are OFF[\s\S]*BLOCKYARD_AUTH=1[\s\S]*BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH/);
      // The override exists so the dangerous combination has to be chosen twice.
      return withEnv({ BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH: '1' }, () => {
        const cfg = loadConfig({ configFile: f, ifaces });
        assert.equal(cfg.actions.enabled, true);
        assert.deepEqual(cfg.actions.allow, ['savemempool']);
        assert.equal(cfg.actions.allowWritesWithoutAuth, true);
      });
    }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});

test('a node reached over BLOCKYARD_NODE_URL is not still called the built-in node', () =>
  // Operator, 2026-09-12, looking at a second instance pointed at Bitcoin Core:
  // "we're not on [the other node's] Mainnet. We're using Core Mainnet there". The header said
  // "[the other node] mainnet (production)" while the endpoint was Core on :8335 answering
  // /Satoshi:31.99.0/ -- because BLOCKYARD_NODE_URL, DATADIR and COOKIE all existed
  // and there was no way to say the node's NAME. The line whose only job is to say
  // which node you are looking at must not be the line that is wrong.
  withEnv({ BLOCKYARD_NODE_URL: 'http://127.0.0.1:8335' }, () => {
    const cfg = loadConfig({ configFile: '/nonexistent.json', ifaces });
    assert.equal(cfg.nodes[0].label, 'node @ 127.0.0.1:8335',
      'a redirected node is named by the endpoint it actually answers on');
    return withEnv({ BLOCKYARD_NODE_LABEL: 'Core mainnet (oracle)' }, () => {
      assert.equal(loadConfig({ configFile: '/nonexistent.json', ifaces }).nodes[0].label,
        'Core mainnet (oracle)', 'an explicit label is the operator speaking, and wins');
    });
  }));

test('restating the built-in address is not redirecting the node, so the name stands', () =>
  // Regression, 2026-09-12, caught on the running deployment within minutes of the fallback
  // shipping: systemd/blockyard.service carried Environment=BLOCKYARD_NODE_URL pointing at the SAME address,
  // the SAME address as the built-in default. Production booted with __urlOverridden true and
  // renamed ITSELF "node @ 127.0.0.1:8331". The flag says the variable was set, never that it
  // points anywhere new -- and the test that was supposed to cover this used :8335, which differs
  // from the default, so it sailed straight past the case that actually runs in production.
  withEnv({ BLOCKYARD_NODE_URL: 'http://127.0.0.1:8332' }, () => {
    assert.equal(loadConfig({ configFile: '/nonexistent.json', ifaces }).nodes[0].label,
      'Bitcoin Core (mainnet)', 'same address, same node, same name');
  }));

test('a label in the file survives a URL override, and an untouched node keeps its built-in name', () => {
  assert.equal(loadConfig({ configFile: '/nonexistent.json', ifaces }).nodes[0].label,
    'Bitcoin Core (mainnet)', 'nobody redirected this node, so nothing renames it');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-label-'));
  try {
    const f = path.join(dir, 'c.json');
    fs.writeFileSync(f, JSON.stringify({
      nodes: [{ id: 'mine', label: 'my node', rpcUrl: 'http://127.0.0.1:8331', datadir: dir, chainHint: 'main' }],
    }));
    return withEnv({ BLOCKYARD_NODE_URL: 'http://127.0.0.1:8335' }, () => {
      const cfg = loadConfig({ configFile: f, ifaces });
      assert.equal(cfg.nodes[0].rpcUrl, 'http://127.0.0.1:8335', 'the URL override still applies');
      assert.equal(cfg.nodes[0].label, 'my node', 'a name the operator typed is not overwritten');
    }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});

test('BLOCKYARD_DATA and the node sentinels still arrive as the types config expects', () =>
  // Regression cover for rule 20 (env vars are strings until code decides otherwise),
  // extended to the variables the open-by-default change made more visible.
  withEnv({ BLOCKYARD_DATA: '/tmp/blockyard-env-store', BLOCKYARD_PORT: '18123', BLOCKYARD_TRUST_PROXY: '1' }, () => {
    const cfg = loadConfig({ configFile: '/nonexistent.json', ifaces });
    assert.equal(cfg.store.dir, '/tmp/blockyard-env-store');
    assert.equal(cfg.server.port, 18123, 'a port that arrived as a string would fail listen() later, not here');
    assert.equal(cfg.server.trustProxy, true);
    assert.equal(typeof cfg.server.trustProxy, 'boolean');
  }));
