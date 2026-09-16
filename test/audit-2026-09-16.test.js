// THE 2026-09-16 AUDIT'S HIGH AND MEDIUM FINDINGS, AS ASSERTIONS (docs/SECURITY-AUDIT-2026-09-16.md).
//
// Each test names its finding. The proofs of concept the auditors ran are kept here in the form
// that now has to fail: a stalled stream reader that held every snapshot, a script in open mode
// that repointed the node, a probe that read internal URLs back, an index build that deleted the
// directory it was pointed at, wallet RPCs that return private keys, a body that never arrived, an
// RPC method name the size of the audit log, private notes in the npm package, and a systemd unit
// whose sandbox existed only in its comment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withApp } from './helpers/http.js';
import { StreamHub, SSE_LIMITS } from '../server/http/sse.js';
import { REQUEST_TIMEOUT_MS } from '../server/http/server.js';
import { routes, isLoopbackAddress, HttpError } from '../server/http/api.js';
import { classifyMethod, WALLET_METHODS } from '../server/rpc/allowlist.js';
import { checkOutputDir, INDEX_ENTRY, buildIndex } from '../server/chain/index/build.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------------------------------ H1
/** A response that stops being read after `accept` bytes, the way a stalled client's socket does. */
function stalledResponse(accept = 64) {
  const res = new EventEmitter();
  res.writableLength = 0;
  res.writableEnded = false;
  res.destroyed = false;
  res.frames = 0;
  let taken = 0;
  res.writeHead = () => {};
  res.write = (frame) => {
    res.frames += 1;
    const room = Math.max(0, accept - taken);
    taken += Math.min(room, frame.length);
    res.writableLength += Math.max(0, frame.length - room);
    return res.writableLength === 0;
  };
  res.end = () => { res.writableEnded = true; };
  res.destroy = () => { res.destroyed = true; };
  res.drainAll = () => { res.writableLength = 0; taken = 0; res.emit('drain'); };
  return res;
}
const tick = () => new Promise((r) => setImmediate(r));

test('H1: a client whose socket is full is sent nothing more until it drains', async () => {
  const hub = new StreamHub();
  const req = new EventEmitter();
  const res = stalledResponse(64);
  const c = hub.add(req, res, { key: 'ip:198.51.100.7' });
  const big = { seq: 1, blob: 'x'.repeat(20_000) };
  hub.pushSnapshot(big); await tick();
  assert.equal(c.backpressured, true, 'the first snapshot fills the socket');
  const framesWhenBlocked = res.frames;
  const bufferedWhenBlocked = res.writableLength;
  for (let i = 2; i < 50; i++) { hub.pushSnapshot({ ...big, seq: i }); await tick(); }
  assert.equal(res.frames, framesWhenBlocked, 'nothing is written onto a full socket');
  assert.equal(res.writableLength, bufferedWhenBlocked, 'so the buffer does not grow');
  assert.equal(c.pendingSnapshot.seq, 49, 'the newest state waits, replacing the older ones');
  res.drainAll(); await tick();
  assert.ok(res.frames > framesWhenBlocked, 'a drain resumes the stream with the latest snapshot');
  hub.closeAll();
  clearInterval(hub.timer);
});

test('H1: a client too far behind, or blocked too long, is dropped', async () => {
  const hub = new StreamHub({ limits: { maxBufferedBytes: 50_000, maxBlockedMs: 30 } });
  // far behind: one write past the ceiling
  const r1 = stalledResponse(0);
  const c1 = hub.add(new EventEmitter(), r1, { key: 'a' });
  hub.send(c1, 'snapshot', { blob: 'y'.repeat(60_000) });
  assert.equal(hub.clients.has(c1), false, 'a buffer past the ceiling drops the client');
  assert.equal(r1.destroyed, true, 'and its socket is destroyed, releasing the buffer');
  // blocked too long: small buffer, never drains
  const r2 = stalledResponse(10);
  const c2 = hub.add(new EventEmitter(), r2, { key: 'b' });
  hub.pushSnapshot({ blob: 'z'.repeat(100) }); await tick();
  assert.equal(c2.backpressured, true);
  await new Promise((r) => setTimeout(r, 60));
  hub.pushSnapshot({ blob: 'z' }); await tick();
  assert.equal(hub.clients.has(c2), false, 'a client blocked past the deadline is dropped on the next flush');
  hub.closeAll();
  clearInterval(hub.timer);
});

test('H1: open streams are counted per address, and the server refuses past the cap', async () => {
  assert.ok(SSE_LIMITS.maxPerKey >= 4 && SSE_LIMITS.maxPerKey <= 64, 'a cap that allows a few tabs and a kiosk, not hundreds');
  await withApp({ auth: false }, async ({ app, port }) => {
    app.hub.limits = { ...app.hub.limits, maxPerKey: 3 };
    const open = [];
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const status = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => { open.push(res); resolve(res.statusCode); });
        req.on('error', () => resolve(0));
      });
      statuses.push(status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    for (const r of open) r.destroy();
  });
});

// ------------------------------------------------------------------------------------------ M5
test('M5: every request must arrive within a deadline, and the event stream is not cut by it', async () => {
  assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 120_000, 'a finite deadline for the whole request, body included');
  await withApp({ auth: false }, async ({ app }) => {
    for (const s of app.servers) assert.equal(s.requestTimeout, REQUEST_TIMEOUT_MS, 'each listener carries it');
  });
  // The reason it was 0 was the stream. requestTimeout bounds the REQUEST, which a GET has finished
  // sending when its headers arrive: a stream outlives a short deadline, a trickled body does not.
  const srv = http.createServer({ requestTimeout: 600, connectionsCheckingInterval: 100 }, (req, res) => {
    if (req.url === '/stream') { res.writeHead(200); const t = setInterval(() => res.write('.'), 100); req.on('close', () => clearInterval(t)); return; }
    req.resume(); req.on('end', () => res.end('ok'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    let got = 0;
    const stream = await new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/stream' }, r));
    stream.on('data', (d) => { got += d.length; });
    const slow = http.request({ host: '127.0.0.1', port, path: '/body', method: 'POST', headers: { 'Content-Length': 1000 } });
    const slowStatus = new Promise((resolve) => { slow.on('response', (res) => resolve(res.statusCode)); slow.on('error', () => resolve('reset')); });
    const trickle = setInterval(() => { if (!slow.destroyed) slow.write('a'); }, 150);
    await new Promise((r) => setTimeout(r, 1800));
    clearInterval(trickle);
    const status = await Promise.race([slowStatus, new Promise((r) => setTimeout(() => r('still open'), 200))]);
    assert.ok(status === 408 || status === 'reset', `a trickled body is cut off (got ${status})`);
    assert.equal(stream.destroyed, false, 'the stream is still open after three deadlines');
    assert.ok(got >= 10, 'and still delivering');
    stream.destroy(); slow.destroy();
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
});

// ------------------------------------------------------------------------------------ M1, M2
const nodeRoute = (p) => routes.find((r) => r.method === 'POST' && r.path === p);
async function callRoute(route, { remoteAddress, auth = false, trustProxy = false, openNodeConfigFromNetwork = false, body = {} }) {
  const app = { cfg: { auth: { enabled: auth, openNodeConfigFromNetwork }, server: { trustProxy }, nodes: [{ rpcUrl: 'http://127.0.0.1:1', datadir: '/nonexistent' }], rpc: { timeoutMs: 200 } }, configFile: null, audit: async () => {} };
  const ctx = { req: { socket: { remoteAddress } }, body, user: { username: 'anonymous', role: 'viewer' }, ip: remoteAddress };
  try { return { ok: await route.handler(ctx, app) }; } catch (err) { return { err }; }
}

test('M1/M2: with accounts off, the node connection form answers only this machine', async () => {
  for (const p of ['/api/config/node', '/api/config/node/test']) {
    const route = nodeRoute(p);
    for (const remoteAddress of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fd00::1', '100.64.0.9']) {
      const r = await callRoute(route, { remoteAddress, body: { rpcUrl: 'http://198.51.100.1:8332', datadir: '/x', confirm: 'save' } });
      assert.ok(r.err instanceof HttpError && r.err.status === 403 && r.err.code === 'local_only', `${p} from ${remoteAddress} must be refused (${r.err?.message ?? 'answered'})`);
    }
    // loopback gets past the gate (it then fails on the body or the missing config file, not on 403)
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const r = await callRoute(route, { remoteAddress, body: { rpcUrl: 'nope' } });
      assert.notEqual(r.err?.code, 'local_only', `${p} from ${remoteAddress} is local`);
    }
    // behind a trusted proxy every request looks local, so it is refused even from loopback
    const proxied = await callRoute(route, { remoteAddress: '127.0.0.1', trustProxy: true, body: { rpcUrl: 'nope' } });
    assert.equal(proxied.err?.code, 'local_only');
    // the explicit opt-in restores the old reach
    const opted = await callRoute(route, { remoteAddress: '192.168.1.20', openNodeConfigFromNetwork: true, body: { rpcUrl: 'nope' } });
    assert.notEqual(opted.err?.code, 'local_only');
  }
  assert.equal(isLoopbackAddress('127.3.4.5'), true);
  assert.equal(isLoopbackAddress('1270.0.0.1'), false);
  assert.equal(isLoopbackAddress('127.0.0.1.evil'), false);
});

test('M2: the probe reports the class of failure for a foreign endpoint, never what it answered', async () => {
  const secret = 'INTERNAL-ADMIN-PANEL secret-token=abc123';
  const internal = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<html>${secret}</html>`); });
  const failing = http.createServer((req, res) => { req.resume(); res.writeHead(500); res.end(`oops ${secret}`); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  await new Promise((r) => failing.listen(0, '127.0.0.1', r));
  try {
    await withApp({ auth: false }, async ({ client, dir }) => {
      for (const srv of [internal, failing]) {
        const r = await client.post('/api/config/node/test', { rpcUrl: `http://127.0.0.1:${srv.address().port}/internal`, datadir: dir });
        assert.equal(r.body.ok, false);
        assert.ok(!JSON.stringify(r.body).includes('secret-token'), `the reply must not carry the endpoint's body: ${JSON.stringify(r.body)}`);
        assert.ok(r.body.error.message.length > 0, 'but it still says what kind of failure it was');
      }
    });
  } finally {
    await new Promise((r) => internal.close(r));
    await new Promise((r) => failing.close(r));
  }
});

test('M1: a save that moves the node to another host drops the old endpoint\'s credentials', async () => {
  await withApp({ auth: false }, async ({ client, app, dir }) => {
    const file = JSON.parse(fs.readFileSync(app.configFile, 'utf8'));
    file.nodes[0] = { ...file.nodes[0], rpcUser: 'olduser', rpcPassword: 'old-password', cookieFile: path.join(dir, 'old.cookie') };
    fs.writeFileSync(app.configFile, JSON.stringify(file));
    const moved = await client.post('/api/config/node', { rpcUrl: 'http://198.51.100.9:8332', datadir: dir, confirm: 'save' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual([...moved.body.droppedCredentials].sort(), ['cookieFile', 'rpcPassword', 'rpcUser']);
    const written = JSON.parse(fs.readFileSync(app.configFile, 'utf8')).nodes[0];
    for (const k of ['rpcUser', 'rpcPassword', 'cookieFile']) assert.equal(k in written, false, `${k} must not follow the node to a new host`);
    assert.equal(written.datadir, dir, 'the datadir named by the form stays, so the new endpoint uses its own cookie');

    // the same host keeps them: renaming or relabelling a node is not a move
    const again = JSON.parse(fs.readFileSync(app.configFile, 'utf8'));
    again.nodes[0] = { ...again.nodes[0], rpcUser: 'u', rpcPassword: 'p' };
    fs.writeFileSync(app.configFile, JSON.stringify(again));
    const same = await client.post('/api/config/node', { rpcUrl: 'http://198.51.100.9:8332', datadir: dir, label: 'renamed', confirm: 'save' });
    assert.equal(same.status, 200);
    const kept = JSON.parse(fs.readFileSync(app.configFile, 'utf8')).nodes[0];
    assert.equal(kept.rpcUser, 'u');
    assert.equal(kept.rpcPassword, 'p');
  });
});

// ------------------------------------------------------------------------------------------ M3
test('M3: the index build refuses a directory that holds anything an index does not write, and deletes nothing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-out-'));
  try {
    const victim = path.join(tmp, 'home');
    fs.mkdirSync(path.join(victim, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(victim, '.ssh', 'id_x'), 'private');
    const blocks = path.join(tmp, 'blocks');
    fs.mkdirSync(blocks);
    const rpc = { batch: async (calls) => calls.map((c) => ({ ok: true, result: c.method === 'getblockchaininfo' ? { chain: 'main', blocks: 0 } : '00'.repeat(32) })) };
    // THE PROOF OF CONCEPT: before the fix this threw "1 heights were not indexed" AFTER deleting id_x
    await assert.rejects(buildIndex({ rpc, blocksDir: blocks, out: victim, workers: 1 }), /holds files an index does not write/);
    assert.equal(fs.readFileSync(path.join(victim, '.ssh', 'id_x'), 'utf8'), 'private', 'nothing in the directory was touched');

    // a symlink is refused, and neither it nor its target is touched
    const target = path.join(tmp, 'target');
    fs.mkdirSync(target);
    const link = path.join(tmp, 'link');
    fs.symlinkSync(target, link, 'dir');
    assert.throws(() => checkOutputDir(link), /symlink/);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);

    // the blocks directory, anything containing it, the home and working directories
    assert.throws(() => checkOutputDir(blocks, { blocksDir: blocks }), /blocks directory/);
    assert.throws(() => checkOutputDir(tmp, { blocksDir: blocks }), /blocks directory|holds files/);
    assert.throws(() => checkOutputDir(os.homedir()), /home directory|holds files/);
    assert.throws(() => checkOutputDir(process.cwd()), /working directory|holds files/);

    // missing, empty, and an existing index are all accepted
    assert.doesNotThrow(() => checkOutputDir(path.join(tmp, 'new', 'index')));
    const idx = path.join(tmp, 'idx');
    fs.mkdirSync(path.join(idx, 'layers'), { recursive: true });
    for (const f of ['manifest.json', 'live.log', 'seg-00.rows', 'seg-ff.idx', 'bucket-3a.unsorted', 'build-journal.json', 'manifest.json.tmp']) fs.writeFileSync(path.join(idx, f), '');
    assert.doesNotThrow(() => checkOutputDir(idx));
    for (const bad of ['seg-0.rows', 'seg-00.rowsx', 'notes.txt', '.ssh', 'manifest.json.bak']) assert.equal(INDEX_ENTRY.test(bad), false, bad);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------ M4
test('M4: every wallet RPC is refused, including the reads that return private keys', () => {
  for (const m of ['listdescriptors', 'gethdkeys', 'dumpprivkey', 'dumpwallet', 'listunspent', 'getbalance', 'getbalances', 'getwalletinfo', 'listwallets', 'listwalletdir', 'gettransaction', 'getaddressinfo', 'listtransactions', 'listsinceblock', 'walletdisplayaddress', 'simulaterawtransaction']) {
    const c = classifyMethod(m);
    assert.equal(c.allowed, false, `${m} must be refused`);
  }
  assert.ok(WALLET_METHODS.size >= 55);
  for (const m of ['getblockcount', 'getblockchaininfo', 'getpeerinfo', 'getmempoolinfo', 'getnetworkinfo', 'listbanned', 'getrawtransaction', 'decoderawtransaction', 'estimatesmartfee', 'getchaintips', 'uptime', 'help']) {
    assert.equal(classifyMethod(m).allowed, true, `${m} is a node read and stays allowed`);
  }
});

// ------------------------------------------------------------------------------------------ M6
test('M6: an oversized RPC method name is clamped before it reaches the audit trail or the reply', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    const huge = `x${'A'.repeat(200_000)}`;
    const r = await client.post('/api/rpc', { method: huge, params: [] });
    assert.equal(r.status, 403);
    assert.ok(JSON.stringify(r.body).length < 2_000, 'the refusal does not echo the whole name');
    const rows = await app.readAudit(20);
    const denied = rows.find((e) => e.type === 'rpc-denied');
    assert.ok(denied, 'the refusal is still audited');
    assert.ok(JSON.stringify(denied).length < 2_000, `the audit row is small: ${JSON.stringify(denied).length} chars`);
    // and the clamp is general: any string field over the limit is cut, whatever route writes it
    await app.audit({ type: 'test-long', note: 'n'.repeat(50_000) });
    const long = (await app.readAudit(5)).find((e) => e.type === 'test-long');
    assert.ok(long.note.length < 1_100 && /more chars\]$/.test(long.note));
  });
});

// ------------------------------------------------------------------------------------------ M7
test('M7: the npm package holds only tracked files, and none of the private notes', (t) => {
  let packed, tracked;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
    packed = JSON.parse(out)[0].files.map((f) => f.path.replace(/\\/g, '/'));
    tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean));
  } catch (err) {
    t.skip(`npm or git unavailable here: ${err.message.split('\n')[0]}`);
    return;
  }
  assert.ok(packed.length > 50, 'the pack listing was read');
  const privateNotes = packed.filter((f) => /^docs\/(STATE|PRIVATE)-/.test(f));
  assert.deepEqual(privateNotes, [], 'gitignored private notes must not be published');
  const untracked = packed.filter((f) => !tracked.has(f));
  assert.deepEqual(untracked, [], 'every published file is one git tracks (npm does not read .gitignore)');
});

// ------------------------------------------------------------------------------------------ M8
test('M8: the shipped systemd unit sandboxes the service, and says only what it does', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'systemd', 'blockyard.service'), 'utf8');
  const set = (k) => unit.split('\n').filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1));
  assert.deepEqual(set('ProtectSystem'), ['strict']);
  assert.deepEqual(set('ProtectHome'), ['read-only']);
  assert.deepEqual(set('PrivateTmp'), ['true']);
  assert.deepEqual(set('NoNewPrivileges'), ['true']);
  assert.deepEqual(set('CapabilityBoundingSet'), ['']);
  assert.deepEqual(set('UMask'), ['0077']);
  assert.deepEqual(set('SystemCallFilter'), ['@system-service']);
  assert.ok(set('ReadWritePaths').some((p) => /\/data$/.test(p)) && set('ReadWritePaths').some((p) => /\/config$/.test(p)), 'the data and config directories stay writable');
  assert.ok(set('RestrictAddressFamilies')[0]?.includes('AF_NETLINK'), 'the boot interface check needs netlink');
  assert.deepEqual(set('MemoryDenyWriteExecute'), [], 'V8 cannot run under MemoryDenyWriteExecute');
  assert.ok(!/NoNewPrivileges plus a read-only \/home is enough/.test(unit), 'the comment that described a sandbox the unit did not have is gone');
});
