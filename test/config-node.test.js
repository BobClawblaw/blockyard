// THE NODE CONNECTION FORM (operator, 2026-09-12: "Still left to do is a config connection in the
// web settings. We have no way for users to configure a connection to their rpc backend").
//
// Two routes: one that tests a candidate connection and writes nothing, and one that saves. The
// tests below exist because every interesting failure here is silent:
//
//   * a save that DROPS fields the form does not show (logFile, systemdUnit) -- config.js merges
//     with deepMerge, which REPLACES arrays outright, so writing {nodes:[{four keys}]} quietly
//     unconfigures the log tail and the service name. Measured before it was written, not feared.
//   * a save that writes a file the next boot then REFUSES to load, leaving a monitor that will
//     not start and a form that said "saved".
//   * a "saved" that the environment silently overrides, because config.js applies env AFTER the
//     file -- which is exactly the case on a box whose systemd drop-in sets BLOCKYARD_NODE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withApp } from './helpers/http.js';
import { loadConfig } from '../server/config.js';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('a candidate connection can be tested without writing anything', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    const before = fs.readFileSync(app.configFile, 'utf8');
    const node = app.cfg.nodes[0];
    const r = await client.post('/api/config/node/test', { rpcUrl: node.rpcUrl, datadir: node.datadir, chainHint: 'main' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, `the fake node should answer: ${JSON.stringify(r.body)}`);
    assert.ok(Number.isFinite(r.body.ms), 'it reports how long the answer took');
    assert.equal(fs.readFileSync(app.configFile, 'utf8'), before, 'a TEST must not write the config');
  });
});

test('an unreachable endpoint is an answer, not a server error', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    // port 1 is reserved and nothing listens there; the route must report the failure rather
    // than throw, because the form needs the reason to show it
    const r = await client.post('/api/config/node/test', { rpcUrl: 'http://127.0.0.1:1', datadir: app.cfg.nodes[0].datadir });
    assert.equal(r.status, 200, 'a refused connection is a result, not a 500');
    assert.equal(r.body.ok, false);
    assert.ok(r.body.error?.message, 'and it says why');
  });
});

test('a malformed rpcUrl is refused by the same rule the boot validator uses', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    for (const bad of ['', 'localhost:8332', 'ftp://127.0.0.1:8332', 'not a url']) {
      const r = await client.post('/api/config/node/test', { rpcUrl: bad, datadir: app.cfg.nodes[0].datadir });
      assert.equal(r.status, 400, `"${bad}" should be refused`);
      assert.equal(r.body.error?.code, 'bad_rpc_url');
    }
  });
});

test('saving needs a typed confirmation, so a stray click cannot rewrite the config', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    const node = app.cfg.nodes[0];
    const r = await client.post('/api/config/node', { rpcUrl: node.rpcUrl, datadir: node.datadir });
    assert.equal(r.status, 400);
    assert.equal(r.body.error?.code, 'confirm_required');
  });
});

test('a save KEEPS the fields the form does not show, and still loads afterwards', async () => {
  // THE REGRESSION THIS FILE EXISTS FOR. deepMerge replaces arrays whole, so a naive write of
  // {nodes:[{id,label,rpcUrl,datadir,chainHint}]} drops logFile and anything else on the node.
  await withApp({ auth: false }, async ({ client, app }) => {
    const before = app.cfg.nodes[0];
    // SEED THE MARKERS OURSELVES rather than lean on whatever the harness happens to configure.
    // These are precisely the keys the form never shows and a naive write would drop; writing them
    // here makes the assertion about the ROUTE instead of about the test harness.
    const seeded = read(app.configFile);
    seeded.nodes[0] = {
      ...seeded.nodes[0],
      logFile: '/tmp/blockyard-marker.log', systemdUnit: 'marker.service', color: '#abcdef',
    };
    fs.writeFileSync(app.configFile, JSON.stringify(seeded, null, 2));

    const r = await client.post('/api/config/node', {
      rpcUrl: 'http://127.0.0.1:18443', datadir: before.datadir, chainHint: 'regtest',
      label: 'Renamed node', confirm: 'save',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.restartRequired, true, 'the change is not live in this process');
    assert.equal(r.body.file, app.configFile, 'it names the file it wrote');

    const written = read(app.configFile).nodes[0];
    assert.equal(written.rpcUrl, 'http://127.0.0.1:18443', 'the new endpoint is saved');
    assert.equal(written.chainHint, 'regtest');
    assert.equal(written.label, 'Renamed node');
    assert.equal(written.id, before.id, 'the id survives');
    assert.equal(written.logFile, '/tmp/blockyard-marker.log', 'the log file must NOT be dropped by the save');
    assert.equal(written.systemdUnit, 'marker.service', 'nor the service name');
    assert.equal(written.color, '#abcdef', 'nor anything else the form does not show');

    // and the file must still be loadable, or the operator has saved themselves into a monitor
    // that will not boot
    const reloaded = loadConfig({ configFile: app.configFile, ifaces: { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] } });
    assert.equal(reloaded.nodes[0].rpcUrl, 'http://127.0.0.1:18443');
    assert.equal(reloaded.nodes[0].logFile, '/tmp/blockyard-marker.log');
  });
});

test('a blank datadir keeps the configured one rather than clearing it', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    const before = app.cfg.nodes[0];
    const r = await client.post('/api/config/node', { rpcUrl: before.rpcUrl, datadir: '', confirm: 'save' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(read(app.configFile).nodes[0].datadir, before.datadir,
      'the form leaves datadir blank when it does not know it; blank must mean "unchanged"');
  });
});

test('the save says so when the environment will override it', async () => {
  // config.js applies env AFTER the file, so on a box whose unit sets BLOCKYARD_NODE_URL the file
  // is written and then ignored. Reporting a bare "saved" there is a lie the operator only finds
  // out about after a restart.
  const prev = process.env.BLOCKYARD_NODE_URL;
  await withApp({ auth: false }, async ({ client, app }) => {
    process.env.BLOCKYARD_NODE_URL = 'http://127.0.0.1:9999';
    try {
      const r = await client.post('/api/config/node', { rpcUrl: app.cfg.nodes[0].rpcUrl, datadir: app.cfg.nodes[0].datadir, confirm: 'save' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.envOverrides, ['BLOCKYARD_NODE_URL']);
      assert.match(r.body.note, /environment|beats the file/i, 'and it says it in words');
    } finally {
      if (prev === undefined) delete process.env.BLOCKYARD_NODE_URL; else process.env.BLOCKYARD_NODE_URL = prev;
    }
  });
});

test('with accounts ON the connection is an admin setting, not something any viewer may change', async () => {
  await withApp({ auth: true }, async ({ client, app }) => {
    const node = app.cfg.nodes[0];
    // unauthenticated: the route is reachable but must not act
    const r = await client.post('/api/config/node', { rpcUrl: node.rpcUrl, datadir: node.datadir, confirm: 'save' });
    assert.ok(r.status === 401 || r.status === 403, `expected a refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

test('credentials are not accepted by this endpoint at all', async () => {
  // The form asks for no password and the route takes none: authentication is the node's own
  // .cookie, read from the datadir. Accepting one over an endpoint that is open access by
  // default would be a quiet way to introduce a credential sink.
  await withApp({ auth: false }, async ({ client, app }) => {
    const before = app.cfg.nodes[0];
    const r = await client.post('/api/config/node', {
      rpcUrl: before.rpcUrl, datadir: before.datadir, confirm: 'save',
      rpcUser: 'attacker', rpcPassword: 'hunter2', cookieFile: '/etc/shadow',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const written = read(app.configFile).nodes[0];
    assert.notEqual(written.rpcUser, 'attacker', 'rpcUser must not be settable from the web');
    assert.notEqual(written.rpcPassword, 'hunter2', 'nor rpcPassword');
    assert.notEqual(written.cookieFile, '/etc/shadow', 'nor a pointer to an arbitrary file to read');
  });
});
