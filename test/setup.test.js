// THE INSTALLER'S CHECKS AND ITS CONFIG (scripts/check.js, scripts/setup.js): against a stub node
// and a temporary data directory holding a real genesis block, every check that should pass
// passes, and each thing a fresh install can get wrong -- no RPC answer, txindex off, a pruned
// node, a missing datadir, a wrong chain, an unwritable index directory -- is a FAIL by name.
// (operator, 2026-09-14: "build a test into the installer so we can verify it properly connects to
// an RPC server and finds the bitcoin logs ... something that writes out a config/local.json at
// the end ... that we can up and run immediately to start building the transaction set")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync, chmodSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGIC } from '../server/chain/blockfile.js';
import { runChecks } from '../scripts/check.js';
import { localConfig, writeLocalConfig, defaultDatadir, defaultWorkers } from '../scripts/setup.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-tx.json', import.meta.url), 'utf8'));

// a data directory the way Core leaves one: blocks/blk00000.dat starting with genesis, its undo
// file, a cookie, and a debug.log
function datadir(root, { chain = 'main', cookie = true } = {}) {
  const dir = path.join(root, 'bitcoin');
  mkdirSync(path.join(dir, 'blocks'), { recursive: true });
  const body = Buffer.from(FX.genesis.hex, 'hex');
  const head = Buffer.alloc(8); head.writeUInt32LE(MAGIC[chain], 0); head.writeUInt32LE(body.length, 4);
  writeFileSync(path.join(dir, 'blocks', 'blk00000.dat'), Buffer.concat([head, body, Buffer.alloc(64)]));
  writeFileSync(path.join(dir, 'blocks', 'rev00000.dat'), Buffer.alloc(0));
  if (cookie) writeFileSync(path.join(dir, '.cookie'), '__cookie__:secret');
  writeFileSync(path.join(dir, 'debug.log'), '2026-09-14T00:00:00Z Bitcoin Core version v29.0.0\n');
  return dir;
}

// a node that answers the way Core 29 does, with knobs for what an install can get wrong
function stubRpc({ chain = 'main', txindex = true, pruned = false, version = 290000, refuse = false, prevouts = true } = {}) {
  const genesis = FX.genesis.expect.hash;
  return { batch: async (calls) => {
    if (refuse) { const e = new Error('connect ECONNREFUSED 127.0.0.1:8332'); e.kind = 'transport'; throw e; }
    return calls.map(({ method, params }) => {
      switch (method) {
        case 'getblockchaininfo': return { ok: true, result: { chain, blocks: 0, headers: 0, initialblockdownload: false, pruned } };
        case 'getnetworkinfo': return { ok: true, result: { version, subversion: `/Satoshi:${(version / 10000).toFixed(1)}.0/` } };
        case 'getindexinfo': return { ok: true, result: txindex ? { txindex: { synced: true, best_block_height: 0 } } : {} };
        case 'getbestblockhash': return { ok: true, result: genesis };
        case 'getblock': return params[1] === 3
          ? { ok: true, result: { tx: [{ vin: [{ coinbase: '00' }] }, { vin: [prevouts ? { prevout: {} } : {}] }] } }
          : { ok: false, error: { message: 'wrong verbosity' } };
        default: return { ok: false, error: { code: -32601, message: 'Method not found' } };
      }
    });
  } };
}

const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

test('A GOOD NODE PASSES EVERY CHECK: rpc, credentials, chain, txindex, getblock 3, the block files, the log, the index', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-setup-'));
  try {
    const dir = datadir(root);
    const idx = path.join(root, 'index'); mkdirSync(idx);
    writeFileSync(path.join(idx, 'manifest.json'), JSON.stringify({ format: 3, tip: { height: 0 }, builtAt: '2026-09-14T00:00:00Z' }));
    const r = await runChecks({ id: 'main', rpcUrl: 'http://127.0.0.1:8332', datadir: dir, chainHint: 'main', addressIndex: idx }, { rpc: stubRpc() });
    const c = byName(r);
    assert.equal(r.ok, true, JSON.stringify(r.checks, null, 1));
    assert.equal(c.credentials.status, 'ok'); assert.match(c.credentials.detail, /\.cookie$/, 'the cookie file is named');
    assert.equal(c.rpc.status, 'ok'); assert.match(c.rpc.detail, /chain main/);
    assert.equal(c.version.status, 'ok'); assert.match(c.version.detail, /29\.0/);
    assert.equal(c.txindex.status, 'ok');
    assert.equal(c['getblock 3'].status, 'ok');
    assert.equal(c['address index rpc'].status, 'info'); assert.match(c['address index rpc'].detail, /no address index/);
    assert.equal(c['block files'].status, 'ok'); assert.match(c['block files'].detail, /1 block files and 1 undo files/);
    assert.equal(c['read a block'].status, 'ok', c['read a block'].detail); assert.match(c['read a block'].detail, /genesis/);
    assert.equal(c['node log'].status, 'info'); assert.match(c['node log'].detail, /debug\.log/, 'the log is found');
    assert.equal(c['address index'].status, 'ok'); assert.match(c['address index'].detail, /0 behind/);
    assert.equal(c['index writable'].status, 'ok');
    assert.deepEqual({ chain: r.facts.chain, blockFiles: r.facts.blockFiles, version: r.facts.version }, { chain: 'main', blockFiles: 1, version: 290000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('EACH THING AN INSTALL CAN GET WRONG IS A FAIL BY NAME', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-setup-'));
  try {
    const dir = datadir(root);
    const node = { id: 'main', rpcUrl: 'http://127.0.0.1:8332', datadir: dir, chainHint: 'main' };
    // nothing listening
    let r = await runChecks(node, { rpc: stubRpc({ refuse: true }) });
    assert.equal(r.ok, false); assert.equal(byName(r).rpc.status, 'fail'); assert.match(byName(r).rpc.detail, /ECONNREFUSED/);
    assert.ok(!byName(r).txindex, 'and nothing further is asked of a node that does not answer');
    // no credential at all
    r = await runChecks({ ...node, datadir: datadir(path.join(root, 'nocookie'), { cookie: false }) }, { rpc: stubRpc() });
    assert.equal(byName(r).credentials.status, 'fail');
    r = await runChecks({ ...node, datadir: datadir(path.join(root, 'userpass'), { cookie: false }), rpcUser: 'u', rpcPassword: 'p' }, { rpc: stubRpc() });
    assert.equal(byName(r).credentials.status, 'ok'); assert.match(byName(r).credentials.detail, /rpcUser "u"/);
    // txindex off, a pruned node, an old node, no prevouts
    r = await runChecks(node, { rpc: stubRpc({ txindex: false }) });
    assert.equal(byName(r).txindex.status, 'fail'); assert.match(byName(r).txindex.detail, /txindex=1/);
    r = await runChecks(node, { rpc: stubRpc({ pruned: true }) });
    assert.equal(byName(r).pruned.status, 'fail');
    r = await runChecks(node, { rpc: stubRpc({ version: 240000 }) });
    assert.equal(byName(r).version.status, 'fail'); assert.match(byName(r).version.detail, /25\.0/);
    r = await runChecks(node, { rpc: stubRpc({ prevouts: false }) });
    assert.equal(byName(r)['getblock 3'].status, 'fail');
    // the wrong chain, both ways: config says main but the node is on signet; block files of another chain
    r = await runChecks(node, { rpc: stubRpc({ chain: 'signet' }) });
    assert.equal(byName(r).chain.status, 'fail'); assert.match(byName(r).chain.detail, /signet/);
    r = await runChecks({ ...node, chainHint: 'signet', datadir: datadir(path.join(root, 'wrongfiles'), { chain: 'signet' }) }, { rpc: stubRpc() });
    assert.equal(byName(r)['read a block'].status, 'fail', 'main-chain magic against signet files');
    // no datadir, a datadir that is not there, no block files
    r = await runChecks({ ...node, datadir: undefined, rpcUser: 'u', rpcPassword: 'p' }, { rpc: stubRpc() });
    assert.equal(byName(r).datadir.status, 'fail');
    r = await runChecks({ ...node, datadir: path.join(root, 'missing') }, { rpc: stubRpc() });
    assert.equal(byName(r).datadir.status, 'fail'); assert.match(byName(r).datadir.detail, /does not exist/);
    const empty = path.join(root, 'empty'); mkdirSync(path.join(empty, 'blocks'), { recursive: true }); writeFileSync(path.join(empty, '.cookie'), 'a:b');
    r = await runChecks({ ...node, datadir: empty }, { rpc: stubRpc() });
    assert.equal(byName(r)['block files'].status, 'fail');
    // an index directory that is configured but not built, and one the follower cannot write to
    r = await runChecks({ ...node, addressIndex: path.join(root, 'noindex') }, { rpc: stubRpc() });
    assert.equal(byName(r)['address index'].status, 'warn'); assert.match(byName(r)['address index'].detail, /index-build/);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {   // Windows ignores directory modes
      const ro = path.join(root, 'ro'); mkdirSync(ro);
      writeFileSync(path.join(ro, 'manifest.json'), JSON.stringify({ tip: { height: 0 } }));
      chmodSync(ro, 0o500);
      r = await runChecks({ ...node, addressIndex: ro }, { rpc: stubRpc() });
      assert.equal(byName(r)['index writable'].status, 'fail');
      chmodSync(ro, 0o700);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('THE CONFIG THE ANSWERS PRODUCE, and the file it is written to', () => {
  const cfg = localConfig({ label: 'Mac Core 29', rpcUrl: 'http://127.0.0.1:8332', datadir: '/Users/x/Library/Application Support/Bitcoin', chain: 'main', host: '127.0.0.1', port: '21000', indexDir: '/Users/x/blockyard-index' });
  assert.deepEqual(cfg, { server: { host: '127.0.0.1', port: 21000 }, nodes: [{ id: 'main', label: 'Mac Core 29', rpcUrl: 'http://127.0.0.1:8332', datadir: '/Users/x/Library/Application Support/Bitcoin', chainHint: 'main', addressIndex: '/Users/x/blockyard-index' }] });
  const withPass = localConfig({ label: 'x', rpcUrl: 'http://127.0.0.1:8332', datadir: '/d', host: '0.0.0.0', port: 21000, rpcUser: 'u', rpcPassword: 'p' });
  assert.deepEqual(withPass.nodes[0], { id: 'main', label: 'x', rpcUrl: 'http://127.0.0.1:8332', datadir: '/d', chainHint: 'main', rpcUser: 'u', rpcPassword: 'p' }, 'a user/password node carries both, and no index until one is chosen');
  assert.equal(localConfig({ label: 'x', rpcUrl: 'u', datadir: '/d', host: 'h', port: 1, chain: 'signet' }).nodes[0].chainHint, 'signet', 'the chain the node reported');

  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-setup-'));
  try {
    const file = path.join(root, 'config', 'local.json');
    writeLocalConfig(file, cfg);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), cfg);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'the file may carry a password: owner-only');
    assert.throws(() => writeLocalConfig(file, withPass), /exists/, 'an existing config is not overwritten by accident');
    writeLocalConfig(file, withPass, { force: true, now: new Date('2026-09-14T20:00:00Z') });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), withPass);
    const bak = readdirSync(path.dirname(file)).find((f) => f.startsWith('local.json.bak-'));
    assert.ok(bak, 'and a backup of what was there is kept');
    assert.deepEqual(JSON.parse(readFileSync(path.join(path.dirname(file), bak), 'utf8')), cfg);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the defaults follow the platform and the machine', () => {
  assert.equal(defaultDatadir('darwin', '/Users/x', {}), '/Users/x/Library/Application Support/Bitcoin');
  assert.equal(defaultDatadir('linux', '/home/x', {}), '/home/x/.bitcoin');
  assert.equal(defaultDatadir('win32', 'C:\\Users\\x', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), 'C:\\Users\\x\\AppData\\Roaming\\Bitcoin', 'a Windows path, whatever machine asks');
  assert.equal(defaultWorkers(32, 132e9), 16, 'capped at sixteen');
  assert.equal(defaultWorkers(10, 16e9), 6, 'four cores left for the node, and memory allows six');
  assert.equal(defaultWorkers(8, 8e9), 3, 'memory is the limit on a small machine');
  assert.equal(defaultWorkers(2, 4e9), 1, 'never none');
});

test('WHAT AN ANSWER MUST BE: every prompt validates, explains, and normalises', async () => {
  const { validate, expand, shortPath, portInUse } = await import('../scripts/setup.js');
  assert.deepEqual(validate.rpcUrl('http://127.0.0.1:8332'), { value: 'http://127.0.0.1:8332' });
  assert.deepEqual(validate.rpcUrl(' http://umbrel.local '), { value: 'http://umbrel.local:8332' }, 'no port: Core\'s default');
  assert.deepEqual(validate.rpcUrl('https://node.example/'), { value: 'https://node.example' }, 'https keeps its implicit 443, and loses a trailing slash');
  assert.match(validate.rpcUrl('127.0.0.1:8332').error, /not a URL/);
  assert.match(validate.rpcUrl('ftp://x').error, /not http/);
  assert.match(validate.port('0').error, /1 to 65535/); assert.match(validate.port('abc').error, /whole number/); assert.match(validate.port('21000.5').error, /whole number/);
  assert.deepEqual(validate.port(' 21000 '), { value: 21000 });
  assert.deepEqual(validate.host('localhost'), { value: '127.0.0.1' }, 'localhost is spelled as the address the validator accepts');
  assert.deepEqual(validate.host('0.0.0.0'), { value: '0.0.0.0' }); assert.deepEqual(validate.host('::1'), { value: '::1' });
  assert.match(validate.host('my-box.lan').error, /IP address literal/, 'the config refuses hostnames, so setup does too');
  assert.deepEqual(validate.workers('4'), { value: 4 }); assert.match(validate.workers('0').error, /1 to 64/);
  assert.match(validate.label('   ').error, /label/); assert.deepEqual(validate.label(' Mac '), { value: 'Mac' });
  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-setup-'));
  try {
    assert.deepEqual(validate.dir(root), { value: root });
    assert.match(validate.dir(path.join(root, 'nope')).error, /does not exist/);
    assert.match(validate.dir('relative/path').error, /absolute/);
    writeFileSync(path.join(root, 'afile'), '');
    assert.match(validate.dir(path.join(root, 'afile')).error, /not a directory/);
    assert.deepEqual(validate.newDir(path.join(root, 'later')), { value: path.join(root, 'later') }, 'an index directory need not exist yet');
    assert.match(validate.newDir(path.join(root, 'afile')).error, /not a directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.equal(expand('~/x'), path.join(os.homedir(), 'x')); assert.equal(expand('/abs'), '/abs');
  assert.equal(shortPath('/repo/config/local.json', '/repo', '/home/u'), path.join('config', 'local.json'), 'relative to the checkout, in this platform\'s spelling');
  assert.equal(shortPath('/home/u/blockyard-index', '/repo', '/home/u'), '~/blockyard-index');
  assert.equal(shortPath('/tmp/x.json', '/repo', '/home/u'), '/tmp/x.json');

  // a port with nothing on it is free; one with a BlockYard on it says which
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, version: '9.9.9' })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    assert.deepEqual(await portInUse('127.0.0.1', srv.address().port), { busy: true, blockyard: '9.9.9' });
    const closed = http.createServer(); await new Promise((r) => closed.listen(0, '127.0.0.1', r)); const freePort = closed.address().port; await new Promise((r) => closed.close(r));
    assert.deepEqual(await portInUse('127.0.0.1', freePort), { busy: false, blockyard: null });
  } finally { await new Promise((r) => srv.close(r)); }
});

test('the progress bar and the box are arithmetic, not decoration', async () => {
  const { progressLine, strip, box, wrapText } = await import('../scripts/ui.js');
  const half = strip(progressLine({ phase: 'scan', done: 50, total: 100, rows: 1_234_567, elapsed: 60 }, 100));
  assert.match(half, /^  scan    █+░+  \s*50\/100 · 50% · 1\.2 M rows · about 60 s left$/, half);
  const [filled, empty] = [(half.match(/█/g) ?? []).length, (half.match(/░/g) ?? []).length];
  assert.equal(filled, empty, 'half done is half a bar');
  assert.match(strip(progressLine({ phase: 'sort', done: 256, total: 256, elapsed: 190 }, 100)), /100% · done in 3 min$/);
  assert.match(strip(progressLine({ phase: 'scan', done: 0, total: 5757, elapsed: 0 }, 100)), /0\/5757 · 0%$/, 'no rate yet, no ETA claimed');
  assert.match(strip(progressLine({ phase: 'scan', done: 10, total: 5757, rows: 5, elapsed: 20 }, 100)), /about 3\.2 h left$/);
  const b = box(['ab', 'abcd'], { title: 'T' });
  const lines = strip(b).split('\n');
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.length === lines[0].length), 'every line the same width');
  assert.match(lines[0], /^╭─ T ─+╮$/); assert.match(lines[3], /^╰─+╯$/);
  assert.equal(wrapText('one two three four', 9, 2), 'one two\n  three\n  four');
});
