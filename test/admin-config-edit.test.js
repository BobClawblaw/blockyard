// THE CONFIG EDITORS (docs/PLAN-ADMIN-SUITE.md §7, M7).
//
// The property that matters most here is a refusal, not a feature: **this suite cannot
// edit the block that restrains it.** Everything else — the backup, the diff, the
// acknowledgement of settings that can lock an operator out — is damage limitation around
// an editor doing what it was asked. The `admin` block carve-out is the one place where
// doing what it was asked would be the bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withApp } from './helpers/http.js';
import { __resetElevations } from '../server/admin/elevation.js';
import { parseConf, renderConf, applyChanges, confSettings, diffText, WEIGHTY_KEYS, REFUSED_KEYS, LOCKED_BLOCKS } from '../server/admin/config-edit.js';

const SAMPLE = [
  '# a node someone actually configured',
  'server=1',
  'txindex=1',
  '',
  '# peers',
  'maxconnections=40',
  '[main]',
  'rpcport=8332',
  'dbcache=4096',
  '',
].join('\n');

const ON = { admin: { enabled: true, allowInsecure: true, wallets: [], elevationMs: 60_000, spend: { capSat: 1000 } } };

async function ready(fn, { elevate = true, conf = SAMPLE } = {}) {
  __resetElevations();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-conf-'));
  fs.writeFileSync(path.join(dir, 'bitcoin.conf'), conf);
  try {
    return await withApp({
      nodes: 1,
      config: { admin: ON.admin },
    }, async (h) => {
      // Point the node at the temp datadir so the editor finds a real file to edit.
      [...h.app.monitors.values()][0].cfg.datadir = dir;
      const s = await h.client.login('admin', h.client.adminPassword);
      if (elevate) await h.client.post('/api/admin/elevate', { password: h.client.adminPassword }, { csrf: s.csrf });
      return fn({ ...h, csrf: s.csrf, dir, file: path.join(dir, 'bitcoin.conf') });
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ the parser

test('a config file round-trips byte for byte when nothing changed', () => {
  // Comments, blank lines, ordering and sections are the operator's file, not noise to be
  // regenerated away by a parser that only understood the settings.
  assert.equal(renderConf(parseConf(SAMPLE)), SAMPLE);
});

test('settings carry their section, so [main] rpcport is not the global one', () => {
  const rows = confSettings(parseConf(SAMPLE));
  const rpcport = rows.find((r) => r.key === 'rpcport');
  assert.equal(rpcport.section, 'main');
  assert.equal(rows.find((r) => r.key === 'server').section, null);
  // rpcport was weighty-and-acknowledged until 2026-09-19; it is refused outright now
  // (operator decision (1): no RPC binding from the web), so the row says it is not editable.
  assert.equal(rpcport.editable, false, 'rpcport moves the door, and is edited by hand');
  assert.equal(rows.find((r) => r.key === 'txindex').weighty, true, 'txindex can cost a resync');
  assert.equal(rows.find((r) => r.key === 'dbcache').weighty, false, 'a cache size is a performance knob, not a lockout risk');
});

test('a change edits in place and leaves everything else alone', () => {
  const { entries, touched } = applyChanges(parseConf(SAMPLE), [{ key: 'maxconnections', value: '125' }]);
  const out = renderConf(entries);
  assert.match(out, /^maxconnections=125$/m);
  assert.equal(out.split('\n').length, SAMPLE.split('\n').length, 'no lines added or removed');
  assert.match(out, /# a node someone actually configured/);
  assert.deepEqual(touched, [{ key: 'maxconnections', from: '40', to: '125', section: null }]);
  // and the diff is small enough to read
  assert.deepEqual(diffText(SAMPLE, out), [
    { sign: '-', line: 'maxconnections=40', n: 6 },
    { sign: '+', line: 'maxconnections=125', n: 6 },
  ]);
});

test('a new setting lands inside its section, not at the end of the file', () => {
  const { entries } = applyChanges(parseConf(SAMPLE), [{ key: 'prune', value: '550', section: 'main' }]);
  const lines = renderConf(entries).split('\n');
  const sectionAt = lines.indexOf('[main]');
  const pruneAt = lines.findIndex((l) => l === 'prune=550');
  assert.ok(pruneAt > sectionAt, 'a [main] setting written outside [main] would apply to a different network');
});

test('a section that does not exist yet is created for the setting', () => {
  // Was rpcport until 2026-09-19, which the editor now refuses; dbcache exercises the same path.
  const { entries } = applyChanges(parseConf(SAMPLE), [{ key: 'dbcache', value: '512', section: 'test' }]);
  const out = renderConf(entries);
  assert.match(out, /\[test\]\ndbcache=512/);
  assert.match(out, /\[main\]\nrpcport=8332\ndbcache=4096/, 'the mainnet one is untouched');
});

test('removing a setting removes the line, and removing a missing one is not an error', () => {
  const { entries } = applyChanges(parseConf(SAMPLE), [{ key: 'txindex', remove: true }, { key: 'nosuch', remove: true }]);
  assert.ok(!renderConf(entries).includes('txindex'));
});

test('a value with a line break in it is refused, not written', () => {
  // Otherwise one setting becomes two, and the second is whatever the browser sent.
  // (The key was rpcauth until 2026-09-19; that is refused outright now, before its value is looked at.)
  assert.throws(() => applyChanges(parseConf(SAMPLE), [{ key: 'uacomment', value: 'a\nrpcallowip=0.0.0.0/0' }]), /line break/);
  assert.throws(() => applyChanges(parseConf(SAMPLE), [{ key: 'bad key', value: '1' }]), /not a setting name/);
});

// ----------------------------------------------------------------- the routes

test('reading the node config lists what is in it', async () => {
  await ready(async ({ client }) => {
    const res = await client.get('/api/admin/config/node');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.file, /bitcoin\.conf$/);
    assert.ok(res.body.settings.some((s) => s.key === 'txindex'));
  });
});

test('a write takes a backup first, and says what changed', async () => {
  await ready(async ({ client, csrf, file, dir }) => {
    const res = await client.post('/api/admin/config/node', {
      changes: [{ key: 'maxconnections', value: '125' }],
    }, { csrf });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.needsRestart, true, 'nothing takes effect until the node restarts, and the UI must say so');
    assert.match(fs.readFileSync(file, 'utf8'), /^maxconnections=125$/m);

    const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
    assert.equal(backups.length, 1, 'the previous file is kept');
    assert.match(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), /^maxconnections=40$/m);
    assert.deepEqual(res.body.diff.map((d) => d.sign), ['-', '+']);
  });
});

test('a setting that can cut the node off needs naming, one by one', async () => {
  // Was rpcallowip until 2026-09-19. That one is refused outright now, acknowledged or not
  // (test/admin-config-edit-hardening.test.js); bind is the P2P door and still acknowledged.
  await ready(async ({ client, csrf, file }) => {
    const refused = await client.post('/api/admin/config/node', {
      changes: [{ key: 'bind', value: '0.0.0.0' }, { key: 'maxconnections', value: '10' }],
    }, { csrf });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'acknowledge-required');
    assert.match(refused.body.error.message, /bind/);
    assert.ok(!refused.body.error.message.includes('maxconnections'), 'only the weighty ones need naming');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('bind='), 'nothing was written');

    const ok = await client.post('/api/admin/config/node', {
      changes: [{ key: 'bind', value: '0.0.0.0' }],
      acknowledge: ['bind'],
    }, { csrf });
    assert.equal(ok.status, 200);
  });
});

test('the audit records which keys changed and never their values', async () => {
  await ready(async ({ client, csrf }) => {
    // rpcpassword until 2026-09-19, which cannot be written from the web any more; the
    // property is the same for any key -- the audit carries names, not values.
    await client.post('/api/admin/config/node', {
      changes: [{ key: 'uacomment', value: 'hunter2-the-real-one' }],
    }, { csrf });
    const audit = await client.get('/api/audit?limit=50');
    const text = JSON.stringify(audit.body);
    assert.match(text, /admin-node-conf-write/);
    assert.match(text, /uacomment/, 'the key is recorded');
    assert.ok(!text.includes('hunter2-the-real-one'), 'the VALUE must never reach the audit trail');
  });
});

test('editing the node config needs the password', async () => {
  await ready(async ({ client, csrf, file }) => {
    const res = await client.post('/api/admin/config/node', { changes: [{ key: 'maxconnections', value: '9' }] }, { csrf });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'elevation-required');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('maxconnections=9'));
  }, { elevate: false });
});

// -------------------------------------------------- the block it may not edit

test('the suite cannot edit the block that restrains it', async () => {
  await ready(async ({ client, csrf, app }) => {
    for (const patch of [
      { admin: { enabled: true, spend: { capSat: 999_999_999 } } },
      { admin: { allowPublicBind: true } },
      { admin: {} },
    ]) {
      const res = await client.post('/api/admin/config/self', { patch }, { csrf });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'block-locked');
      assert.match(res.body.error.message, /not editable from the web interface/);
    }
    // and nothing in force changed
    assert.equal(app.cfg.admin.allowPublicBind, false);
    assert.equal(app.cfg.admin.spend.capSat, 1000);
  });
});

test('the locked block is still SHOWN, so the operator can see what is in force', async () => {
  await ready(async ({ client }) => {
    const res = await client.get('/api/admin/config/self');
    assert.equal(res.status, 200);
    assert.equal(res.body.locked.admin.enabled, true);
    assert.match(res.body.lockedNote, /widen its own gates/);
    assert.deepEqual(LOCKED_BLOCKS, ['admin']);
    // and the editable half never carries a password back to a browser. Until 2026-09-19 it
    // held every node with the password masked; nodes are not editable from the web now
    // (operator decision (4)), so they are not in it at all -- and neither is the mask.
    assert.equal(res.body.editable.nodes, undefined);
    assert.ok(!JSON.stringify(res.body).includes('********'));
  });
});

test('every weighty key is one the operator would want to be asked about', () => {
  // Not an exhaustive list of dangerous settings — a judgement about which ones can end
  // with a node nobody can reach, a node everybody can reach, or a resync.
  for (const k of ['bind', 'listen', 'onlynet', 'proxy', 'prune', 'txindex', 'wallet']) {
    assert.ok(WEIGHTY_KEYS.has(k), `${k} should require acknowledgement`);
  }
  // rpcauth, rpcallowip, rpcbind and datadir were here until 2026-09-19. They are refused
  // outright now (operator decision (1)), and a key that is refused is not also acknowledgeable.
  for (const k of ['rpcauth', 'rpcallowip', 'rpcbind', 'datadir']) {
    assert.ok(REFUSED_KEYS.has(k) && !WEIGHTY_KEYS.has(k), `${k} is refused, not acknowledged`);
  }
  for (const k of ['maxuploadtarget', 'dbcache', 'maxconnections', 'par']) {
    assert.ok(!WEIGHTY_KEYS.has(k), `${k} is a performance knob; asking about it teaches people to click through`);
  }
});
