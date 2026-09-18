// THE UMBREL PACKAGE (umbrel/README.md).
//
// The package is a wrapper around this server: a container image, an entrypoint that
// renders the node's credentials into a config file, and a compose file naming the
// environment the server reads. Every one of those is a promise about code in here, and
// nothing in the app's own tests would notice when one of them stopped being true --
// the failure would appear on somebody's Raspberry Pi instead.
//
// So: the entrypoint's rendering is tested like any other code, and the package files are
// checked against what server/config.js actually reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderConfig, MOUNT } from '../umbrel/entrypoint.js';
import os from 'node:os';
import { logSink, freePort } from './helpers/http.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const UMBREL_ENV = {
  APP_BITCOIN_NODE_IP: '192.0.2.10',
  APP_BITCOIN_RPC_PORT: '8332',
  APP_BITCOIN_RPC_USER: 'umbrel',
  APP_BITCOIN_RPC_PASS: 'secret',
  APP_BITCOIN_NETWORK: 'mainnet',
};

test('the entrypoint renders a config the server can load', () => {
  const cfg = JSON.parse(renderConfig(UMBREL_ENV));
  assert.equal(cfg.nodes.length, 1);
  const n = cfg.nodes[0];
  assert.equal(n.rpcUrl, 'http://192.0.2.10:8332');
  assert.equal(n.rpcUser, 'umbrel');
  assert.equal(n.rpcPassword, 'secret');
  assert.equal(n.datadir, MOUNT);
  assert.equal(n.chainHint, 'main');
  // The log follower does not understand Core's log and would misdate every event
  // (AGENTS.md); the package must not hand it one to follow.
  assert.equal(n.logFile, null);
  // 124 GB of writes is not something to start unasked on a Pi.
  assert.equal(n.addressIndexBuild, 'manual');
});

test('an RPC password with a quote or a backslash in it still renders valid JSON', () => {
  // Umbrel generates these; one that broke the file would look like a credentials
  // problem and be debugged as one.
  const cfg = JSON.parse(renderConfig({ ...UMBREL_ENV, APP_BITCOIN_RPC_PASS: 'a"b\\c\nd' }));
  assert.equal(cfg.nodes[0].rpcPassword, 'a"b\\c\nd');
});

test('every network but mainnet points datadir at the chain subdirectory', () => {
  // blocks/ is directly under the datadir on mainnet and one level down everywhere
  // else, and the index build reads <datadir>/blocks.
  for (const [network, sub] of [['testnet', 'testnet3'], ['signet', 'signet'], ['regtest', 'regtest']]) {
    const cfg = JSON.parse(renderConfig({ ...UMBREL_ENV, APP_BITCOIN_NETWORK: network }));
    assert.equal(cfg.nodes[0].datadir, `${MOUNT}/${sub}`, network);
  }
});

test('a missing bitcoin app is named, not rendered as an empty string', () => {
  let err = null;
  try { renderConfig({ ...UMBREL_ENV, APP_BITCOIN_RPC_PASS: '' }); } catch (e) { err = e; }
  assert.ok(err, 'an unset export must stop the start');
  assert.deepEqual(err.missing, ['APP_BITCOIN_RPC_PASS']);
  assert.match(err.message, /APP_BITCOIN_RPC_PASS/);
});

test('the compose file sets only environment variables the server reads', () => {
  const compose = read('umbrel/blockyard/docker-compose.yml');
  const set = [...compose.matchAll(/^ {6}(BLOCKYARD_[A-Z_]+):/gm)].map((m) => m[1]);
  assert.ok(set.length >= 8, `expected the BLOCKYARD_* block, found ${set.length}`);
  const known = new Set([
    ...[...read('server/config.js').matchAll(/BLOCKYARD_[A-Z_]+/g)].map((m) => m[0]),
    ...[...read('server/main.js').matchAll(/BLOCKYARD_[A-Z_]+/g)].map((m) => m[0]),
  ]);
  for (const name of set) assert.ok(known.has(name), `${name} is set in the compose file but no code reads it`);
  // The three that are not defaults and would each break the app in its own way.
  assert.match(compose, /BLOCKYARD_BIND: "0\.0\.0\.0"/);   // app_proxy cannot reach 127.0.0.1
  assert.match(compose, /BLOCKYARD_TLS: "0"/);             // app_proxy speaks HTTP to the app
  assert.match(compose, /BLOCKYARD_LOG_SOURCE: "0"/);      // Core's log is not parseable here
});

test('the package keeps everything it writes inside the Umbrel data volume', () => {
  const compose = read('umbrel/blockyard/docker-compose.yml');
  // An app that wrote outside ${APP_DATA_DIR} would lose the lot on an update, and the
  // store review asks about exactly this.
  for (const p of [/BLOCKYARD_DATA: \/app\/data\//, /BLOCKYARD_CONFIG: \/app\/data\//]) assert.match(compose, p);
  // The node's own directory is mounted read-only: the index reads block files and
  // BlockYard writes nothing back to a node, ever.
  assert.match(compose, /\$\{APP_BITCOIN_DATA_DIR\}:\/var\/lib\/bitcoind:ro/);
  assert.equal(JSON.parse(renderConfig(UMBREL_ENV)).nodes[0].addressIndex.startsWith('/app/data/'), true);
});

test('the image ships nobody\'s config, and no deployment\'s state', () => {
  const ignored = read('.dockerignore').split('\n').map((l) => l.trim());
  // config/local.json holds an RPC password; data/ is one deployment's users, sessions
  // and history; worklog/ is notes that are never published at all.
  for (const p of ['config/local.json', 'config/blockyard.json', 'data', 'worklog']) {
    assert.ok(ignored.includes(p), `.dockerignore should exclude ${p}`);
  }
});

test('the image DOES ship the Diversions, each package whole with its own licence', () => {
  // The shareware terms permit free electronic redistribution of the package as a whole,
  // and Quake's section 6 requires its agreement to travel with it. That condition is met
  // by copying each game directory entire -- so nothing here may start filtering them.
  assert.match(read('umbrel/Dockerfile'), /^COPY games \.\/games$/m);
  const ignored = read('.dockerignore').split('\n').map((l) => l.trim());
  assert.ok(!ignored.some((l) => l === 'games' || l.startsWith('games/')), 'games/ must not be excluded from the image');
  assert.ok(fs.existsSync(path.join(ROOT, 'games/quake_dos/SLICNSE.TXT')), "Quake's licence must be in the tree that gets copied");
});

test('the manifest names the port the store gave us, and the container keeps its own', () => {
  const manifest = read('umbrel/blockyard/umbrel-app.yml');
  // 21000, BlockYard's usual port, is taken in the store by `datum`. The host-facing
  // port has to be unique; the internal one does not.
  assert.match(manifest, /^port: 21010$/m);
  assert.match(read('umbrel/blockyard/docker-compose.yml'), /APP_PORT: 21000/);
  // The version in the manifest is the version of this package.
  const version = JSON.parse(read('package.json')).version;
  assert.match(manifest, new RegExp(`^version: "${version.replace(/\./g, '\\.')}"$`, 'm'));
  assert.match(manifest, /^ {2}- bitcoin$/m); // the node it depends on
});

test('a node whose datadir is missing still runs on the credentials in its config', async () => {
  // The Umbrel case: the credentials come from the bitcoin app's exports and the datadir
  // is a read-only mount that exists only for the address index. A mount that has not
  // appeared must cost the index, not the node -- until 2026-09-17 it took the node with
  // it, and the monitor came up with no nodes at all.
  const { boot } = await import('../server/main.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-umbrel-'));
  const gone = path.join(dir, 'not-mounted');
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    server: { host: '127.0.0.1', port: await freePort(), tls: { enabled: false } },
    auth: { enabled: false, dataDir: path.join(dir, 'auth') },
    store: { dir: path.join(dir, 'store'), retentionHours: 1, snapshotEveryMs: 3_600_000 },
    log: { level: 'error', enabled: false },
    nodes: [{
      id: 'main', label: 'Bitcoin Core', rpcUrl: 'http://127.0.0.1:1',
      rpcUser: 'umbrel', rpcPassword: 'secret',
      datadir: gone, chainHint: 'main', cookieFile: null, logFile: null,
      addressIndex: path.join(dir, 'index'), addressIndexBuild: 'manual',
    }],
  }));
  const sink = logSink();
  const app = await boot({ configFile: cfgFile, log: sink });
  try {
    assert.equal(app.monitors.size, 1, 'the node is kept: resolveCookie falls through to rpcUser');
    assert.match(sink.text(), /datadir .*not-mounted does not exist -- RPC works/);
    // and it says what was actually lost
    assert.match(sink.text(), /address index/);
  } finally {
    await app.shutdown({ saveHistory: false }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a node with no credentials and no datadir is still skipped, with a reason', async () => {
  // The old behaviour, which is right when cookie auth is the only way in: a benchmark
  // directory that got cleaned up should not leave a permanently-offline panel.
  const { boot } = await import('../server/main.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-umbrel-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    server: { host: '127.0.0.1', port: await freePort(), tls: { enabled: false } },
    auth: { enabled: false, dataDir: path.join(dir, 'auth') },
    store: { dir: path.join(dir, 'store'), retentionHours: 1, snapshotEveryMs: 3_600_000 },
    log: { level: 'error', enabled: false },
    nodes: [{ id: 'bench', label: 'Bench', rpcUrl: 'http://127.0.0.1:1', datadir: path.join(dir, 'gone'), chainHint: 'main' }],
  }));
  const sink = logSink();
  const app = await boot({ configFile: cfgFile, log: sink });
  try {
    assert.equal(app.monitors.size, 0);
    assert.match(sink.text(), /skipping node "bench"/);
  } finally {
    await app.shutdown({ saveHistory: false }).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
