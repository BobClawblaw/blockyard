// The 2026-09-16 audit's low findings in the address index and the stores (docs/SECURITY-AUDIT-2026-09-16.md):
// L7 the height table, L8 the undo record's coin count, L9 one build to a directory, L10 file modes and
// temporary files that followed symlinks, and the informational I3 (--workers) and I4 (self-written
// files that threw instead of failing soft). Every directory is a fresh mkdtemp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { hash256, decodeTx } from '../server/chain/tx.js';
import { MAGIC } from '../server/chain/blockfile.js';
import { HeightTable, MAX_LOAD } from '../server/chain/index/heights.js';
import { blockRows, RowSink, ROW } from '../server/chain/index/rows.js';
import { buildIndex, checkOutputDir, INDEX_ENTRY, LOCK, lockOutputDir, writeFileAtomic, JOURNAL } from '../server/chain/index/build.js';
import { IndexStore } from '../server/chain/index/store.js';
import { LiveIndex } from '../server/chain/index/live.js';
import { openLedger } from '../server/store/ledger.js';
import { AuditLog } from '../server/store/audit.js';
import { History } from '../server/store/history.js';

const ROOT = new URL('..', import.meta.url);
const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/chain-tx.json', import.meta.url), 'utf8'));
const hex = (h) => Buffer.from(h, 'hex');
const WIN = process.platform === 'win32';
const modeOf = (f) => fs.statSync(f).mode & 0o777;
const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `blockyard-low-${tag}-`));
// a symlink needs a privilege on Windows: the tests that plant one skip where it cannot be made
const trySymlink = (target, link) => { try { fs.symlinkSync(target, link); return true; } catch { return false; } };

// Core's WriteVarInt and CompressAmount, to write undo records the way Core does (as test/chain-index.test.js)
const varint = (n) => { const t = []; for (let len = 0; ; len++) { t.push((n % 128) | (len ? 0x80 : 0)); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; } return Buffer.from(t.reverse()); };
const compressAmount = (n) => { if (n === 0) return 0; let e = 0; while (n % 10 === 0 && e < 9) { n /= 10; e++; } if (e < 9) { const d = n % 10; n = Math.floor(n / 10); return 1 + (n * 9 + d - 1) * 10 + e; } return 1 + (n - 1) * 10 + 9; };
const compact = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 255, n >> 8]));
const frame = (body, trailer = Buffer.alloc(0)) => { const h = Buffer.alloc(8); h.writeUInt32LE(MAGIC.main, 0); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body, trailer]); };
const SPENT = hex('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac');

// a block of fixture transactions after a coinbase; `extraCoins` adds that many coins to the first
// transaction's undo, which is what a block paired with its sibling's undo looks like
function makeBlock(prevHex, txHexes, { extraCoins = 0, nonce = 1 } = {}) {
  const header = Buffer.alloc(80);
  hex(prevHex).reverse().copy(header, 4);
  header.writeUInt32LE(0x1d00ffff, 72);
  header.writeUInt32LE(nonce, 76);
  const coinbase = FX.txs.find((f) => f.covers.includes('segwit-coinbase')).hex;
  const txs = [coinbase, ...txHexes].map(hex);
  const body = Buffer.concat([header, compact(txs.length), ...txs]);
  const undoParts = [compact(txHexes.length)];
  txHexes.forEach((h, i) => {
    const nin = decodeTx(h).vin.length + (i === 0 ? extraCoins : 0);
    undoParts.push(compact(nin));
    for (let j = 0; j < nin; j++) undoParts.push(varint(1000), varint(0), varint(compressAmount(5000 + j)), varint(SPENT.length + 6), SPENT);
  });
  return { body, hash: hash256(header).reverse().toString('hex'), undo: Buffer.concat(undoParts) };
}
const plainTx = () => FX.txs.find((f) => f.expect.vin[0].coinbase == null).hex;

const genesis = { body: hex(FX.genesis.hex), hash: FX.genesis.expect.hash };
const chainRpc = (chain) => ({ batch: async (calls) => calls.map((c) => {
  if (c.method === 'getblockchaininfo') return { ok: true, result: { chain: 'main', blocks: chain.length - 1 } };
  if (c.method === 'getblockhash') return { ok: true, result: chain[c.params[0]].hash };
  return { ok: false, error: { message: c.method } };
}) });

// a block directory holding the real genesis block only
function genesisBlocks(root) {
  const blocksDir = path.join(root, 'blocks');
  fs.mkdirSync(blocksDir);
  fs.writeFileSync(path.join(blocksDir, 'blk00000.dat'), frame(genesis.body));
  fs.writeFileSync(path.join(blocksDir, 'rev00000.dat'), Buffer.alloc(0));
  return blocksDir;
}

// ------------------------------------------------------------------------------------------ L7
test('L7: the height table refuses past a load of 0.75, and neither set nor get loops on a full table', () => {
  const t = new HeightTable(1024);
  const key = (n) => (2 * n + 1).toString(16).padStart(64, '0');   // odd: the table ORs in the low bit
  const fit = Math.floor(1024 * MAX_LOAD);
  for (let n = 1; n <= fit; n++) t.set(key(n), n);
  assert.equal(t.get(key(fit)), fit);
  t.set(key(fit), 7);                                            // an update of a key it holds is not a new entry
  assert.equal(t.get(key(fit)), 7);
  const t0 = Date.now();
  assert.throws(() => t.set(key(fit + 1), 0), /too small/, 'the 769th key of 1,024 slots is refused, not looped on');
  assert.ok(Date.now() - t0 < 1000);

  // a table full to the last slot -- only reachable by writing its buffer -- still answers
  const full = new HeightTable(1024);
  full.keys.fill(0xffn);
  const attached = HeightTable.attach(full.buffer, 1024);
  assert.equal(attached.get(key(12345)), -1, 'get gives up after one lap');
  assert.throws(() => attached.set(key(12345), 1), /full|too small/, 'and set throws');

  // sized from the tip: at least twice tip + 1, a power of two
  assert.equal(HeightTable.forTip(0).capacity, 1024);
  assert.equal(HeightTable.forTip(966_000).capacity, 1 << 21);
  assert.equal(HeightTable.forTip(2_097_152).capacity, 1 << 23, 'the height that hung a 2^21 table');
  for (const tip of [0, 511, 512, 1_048_575, 1_048_576]) { const c = HeightTable.forTip(tip).capacity; assert.ok(c >= 2 * (tip + 1) && (c & (c - 1)) === 0, `tip ${tip}: ${c}`); }
  assert.throws(() => new HeightTable(1000), /power of two/);
  assert.throws(() => HeightTable.forTip(-1), /tip height/);
});

// ------------------------------------------------------------------------------------------ L8
test('L8: an undo record whose coin count differs from the transaction\'s inputs fails loudly', () => {
  const tx = plainTx();
  const good = makeBlock(genesis.hash, [tx]);
  assert.ok(blockRows(good.body, good.undo, 1, new RowSink(16)) > 0, 'the matching undo indexes');
  for (const extra of [1, -1]) {
    const bad = makeBlock(genesis.hash, [tx], { extraCoins: extra });
    assert.throws(() => blockRows(bad.body, bad.undo, 1, new RowSink(16)), /transaction 1 has \d+ inputs and its undo record \d+ spent coins/, `extra coins ${extra}`);
  }
});

// ------------------------------------------------------------------------------------------ I4 (undo message)
test('I4: a block that cannot be indexed fails the build naming the block and undo files and their offsets', async () => {
  const root = tmpdir('undo');
  try {
    const blocksDir = path.join(root, 'blocks');
    fs.mkdirSync(blocksDir);
    const bad = makeBlock(genesis.hash, [plainTx()], { extraCoins: 1 });
    const checksum = hash256(Buffer.concat([hex(genesis.hash).reverse(), bad.undo]));
    fs.writeFileSync(path.join(blocksDir, 'blk00000.dat'), Buffer.concat([frame(genesis.body), frame(bad.body)]));
    fs.writeFileSync(path.join(blocksDir, 'rev00000.dat'), frame(bad.undo, checksum));
    const offset = 8 + genesis.body.length;                       // a record's offset is its frame's
    await assert.rejects(buildIndex({ rpc: chainRpc([genesis, bad]), blocksDir, out: path.join(root, 'index'), workers: 1 }),
      (err) => err.message.includes(`blk00000.dat offset ${offset}, rev00000.dat offset 0`) && /block 1 /.test(err.message) && /spent coins/.test(err.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------ L9
test('L9: one build to a directory -- a live lock refuses, a stale one is taken over, and the lock is released', async () => {
  const root = tmpdir('lock');
  try {
    const blocksDir = genesisBlocks(root);
    const out = path.join(root, 'index');
    const rpc = chainRpc([genesis]);
    assert.ok(INDEX_ENTRY.test(LOCK), 'the lock is a name an index writes');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, LOCK), '');
    assert.doesNotThrow(() => checkOutputDir(out), 'so a directory holding one is not refused as foreign');

    // in this process: a second lock on the same directory is refused while the first is held
    const release = lockOutputDir(out);
    assert.throws(() => lockOutputDir(out), /already running/);
    await assert.rejects(buildIndex({ rpc, blocksDir, out, workers: 1 }), /already running/);
    assert.ok(fs.existsSync(path.join(out, LOCK)), 'a refused build leaves the holder\'s lock');
    release();
    assert.ok(!fs.existsSync(path.join(out, LOCK)), 'released');

    // another process that is alive (the one that started this test) holds it
    fs.writeFileSync(path.join(out, LOCK), JSON.stringify({ pid: process.ppid, startedAt: 'then' }));
    await assert.rejects(buildIndex({ rpc, blocksDir, out, workers: 1 }), new RegExp(`another address index build \\(process ${process.ppid}`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, LOCK), 'utf8')).pid, process.ppid, 'and its lock is not touched');

    // a process that has exited: its lock is stale and taken over; during the build the lock is ours
    // and the fresh build's clearing of index files leaves it; after, it is gone
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(path.join(out, LOCK), JSON.stringify({ pid: dead }));
    let during = null;
    const m = await buildIndex({ rpc, blocksDir, out, workers: 1, hook: (p) => { if (p === 'pool') during = JSON.parse(fs.readFileSync(path.join(out, LOCK), 'utf8')).pid; } });
    assert.equal(m.tip.height, 0);
    assert.equal(during, process.pid, 'the lock names this build while it runs');
    assert.ok(!fs.existsSync(path.join(out, LOCK)), 'and is removed when it finishes');

    // released when the build fails too
    await assert.rejects(buildIndex({ rpc, blocksDir, out: path.join(root, 'failing'), workers: 1, hook: (p) => { if (p === 'scanned') throw new Error('stop'); } }), /stop/);
    assert.ok(!fs.existsSync(path.join(root, 'failing', LOCK)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------ L10
test('L10: index files are owner-only whatever the umask, and a temporary name never follows a symlink', async (t) => {
  const root = tmpdir('modes');
  const umask = process.umask(0);                              // the worst case: nothing masked
  try {
    const blocksDir = genesisBlocks(root);
    const out = path.join(root, 'new', 'index');
    await buildIndex({ rpc: chainRpc([genesis]), blocksDir, out, workers: 1 });
    if (!WIN) {
      assert.equal(modeOf(out), 0o700, 'the directory the build created');
      for (const f of fs.readdirSync(out)) assert.equal(modeOf(path.join(out, f)), 0o600, f);
    }

    // writeFileAtomic with a symlink planted at its temporary name: the link's target is untouched
    const victim = path.join(root, 'victim');
    fs.writeFileSync(victim, 'keep me');
    const file = path.join(root, 'manifest.json');
    if (!trySymlink(victim, `${file}.tmp`)) { t.diagnostic('symlinks cannot be made here'); return; }
    writeFileAtomic(file, 'new contents');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new contents');
    if (!WIN) assert.equal(modeOf(file), 0o600);
  } finally { process.umask(umask); fs.rmSync(root, { recursive: true, force: true }); }
});

test('L10: a resume refuses a bucket file that is a symlink, and truncates nothing', async (t) => {
  const root = tmpdir('bucketlink');
  try {
    const blocksDir = genesisBlocks(root);
    const out = path.join(root, 'index');
    const STOP = new Error('stopped');
    await assert.rejects(buildIndex({ rpc: chainRpc([genesis]), blocksDir, out, workers: 1, checkpointMs: 0, hook: (p) => { if (p === 'scanned') throw STOP; } }), (e) => e === STOP);
    assert.ok(fs.existsSync(path.join(out, JOURNAL)));
    const bucket = fs.readdirSync(out).find((f) => f.endsWith('.unsorted'));
    assert.ok(bucket, 'the stopped build left a bucket');
    const victim = path.join(root, 'victim');
    fs.writeFileSync(victim, 'x'.repeat(fs.statSync(path.join(out, bucket)).size + 100));
    const before = fs.readFileSync(victim, 'utf8');
    fs.rmSync(path.join(out, bucket));
    if (!trySymlink(victim, path.join(out, bucket))) { t.diagnostic('symlinks cannot be made here'); return; }
    await assert.rejects(buildIndex({ rpc: chainRpc([genesis]), blocksDir, out, workers: 1 }), /is a symlink/);
    assert.equal(fs.readFileSync(victim, 'utf8'), before, 'the link\'s target was not truncated');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('L10: the ledger, audit trail and history snapshot are owner-only, existing files included, and their temporary files follow no symlink', async (t) => {
  const root = tmpdir('stores');
  const umask = process.umask(0);
  try {
    const links = (target, link) => trySymlink(target, link);
    const victim = path.join(root, 'victim');
    fs.writeFileSync(victim, 'keep me');

    // jsonl ledger: an existing group-readable file is tightened; a compaction's .tmp link is not followed
    const ledgerFile = path.join(root, 'ledger', 'ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerFile));
    fs.writeFileSync(ledgerFile, '', { mode: 0o664 });
    fs.chmodSync(ledgerFile, 0o664);
    const ledger = await openLedger({ file: ledgerFile, engine: 'jsonl' });
    if (!WIN) assert.equal(modeOf(ledgerFile), 0o600, 'the existing ledger file');
    const canLink = links(victim, `${ledgerFile}.tmp`);
    ledger.putMany([{ height: 1 }, { height: 2 }]);
    ledger.dropAbove(1);                                         // compacts through ledger.jsonl.tmp
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
    assert.ok(!fs.readFileSync(ledgerFile, 'utf8').includes('"height":2'));
    if (!WIN) assert.equal(modeOf(ledgerFile), 0o600, 'the compacted ledger file');
    ledger.close();

    // a new ledger directory is owner-only
    const fresh = path.join(root, 'fresh', 'ledger.jsonl');
    (await openLedger({ file: fresh, engine: 'jsonl' })).close();
    if (!WIN) { assert.equal(modeOf(path.dirname(fresh)), 0o700); assert.equal(modeOf(fresh), 0o600); }

    // audit trail: files from before the mode was passed are tightened when adopted at startup
    const auditFile = path.join(root, 'audit.jsonl');
    fs.writeFileSync(auditFile, '{}\n'); fs.chmodSync(auditFile, 0o644);
    fs.writeFileSync(path.join(root, 'audit.1.jsonl'), '{}\n'); fs.chmodSync(path.join(root, 'audit.1.jsonl'), 0o644);
    await new AuditLog(auditFile).adopt();
    if (!WIN) { assert.equal(modeOf(auditFile), 0o600); assert.equal(modeOf(path.join(root, 'audit.1.jsonl')), 0o600); }

    // history snapshot: tightened on load; the save's .tmp link is not followed
    const histDir = path.join(root, 'hist');
    fs.mkdirSync(histDir);
    const history = new History(histDir, { ringCapacity: 10, maxEventLog: 10, retentionHours: 1, snapshotEveryMs: 1e9 });
    fs.writeFileSync(history.file, '{}'); fs.chmodSync(history.file, 0o644);
    await history.load();
    if (!WIN) assert.equal(modeOf(history.file), 0o600, 'the existing snapshot');
    if (canLink) links(victim, `${history.file}.tmp`);
    const saved = await history.save();
    assert.equal(saved.saved, true, saved.error);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
    if (!WIN) assert.equal(modeOf(history.file), 0o600);
    if (!canLink) t.diagnostic('symlinks cannot be made here; the symlink half was not exercised');
  } finally { process.umask(umask); fs.rmSync(root, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------------------ I3
test('I3: index-build refuses --workers that is not a whole number of at least one', async () => {
  const script = fileURLToPath(new URL('scripts/index-build.js', ROOT));
  for (const bad of ['0', 'abc', '1.5', '-2']) {
    const r = spawnSync(process.execPath, [script, '--workers', bad, '--out', 'unused'], { encoding: 'utf8', timeout: 20_000 });   // refused before any config is read
    assert.equal(r.status, 2, `--workers ${bad}: ${r.stderr}`);
    assert.match(r.stderr, /--workers must be a whole number of at least 1/);
  }
  await assert.rejects(buildIndex({ rpc: chainRpc([genesis]), blocksDir: 'unused', out: 'unused', workers: 0 }), /at least one worker/);
});

// ------------------------------------------------------------------------------------------ I4
test('I4: a CRC-valid but malformed live.log record is cut off like a torn one; a bad layer is skipped; a manifest\'s blockRows is checked', async () => {
  const root = tmpdir('selfwritten');
  try {
    const blocksDir = genesisBlocks(root);
    const dir = path.join(root, 'index');
    await buildIndex({ rpc: chainRpc([genesis]), blocksDir, out: dir, workers: 1 });
    const record = (type, payload) => {
      const head = Buffer.alloc(9); head.writeUInt32LE(0x42594c47, 0); head.writeUInt8(type, 4); head.writeUInt32LE(payload.length, 5);
      const tail = Buffer.alloc(4); tail.writeUInt32LE(crc32(payload), 0);
      return Buffer.concat([head, payload, tail]);
    };
    const good = Buffer.alloc(36 + ROW); good.writeUInt32LE(1, 0); good.fill(0xab, 4, 36); good.fill(0x01, 36);
    const keep = record(1, good);
    const rpc = { batch: async () => [{ ok: false, error: { message: 'offline' } }] };
    for (const [name, bad] of [['a block record under 4 bytes', record(1, Buffer.from([1, 2]))], ['rows that are not whole rows', record(1, Buffer.concat([good, Buffer.alloc(5)]))], ['a rollback under 4 bytes', record(2, Buffer.from([1]))]]) {
      const logFile = path.join(dir, 'live.log');
      fs.writeFileSync(logFile, Buffer.concat([keep, bad]));
      const warned = [];
      let live;
      assert.doesNotThrow(() => { live = new LiveIndex(dir, { rpc, log: { warn: (m) => warned.push(m), info() {} } }); }, name);
      assert.equal(live.tip, 1, `the good record before it is kept (${name})`);
      assert.equal(fs.statSync(logFile).size, keep.length, `and the log is cut after it (${name})`);
      assert.ok(warned.some((m) => /dropping/.test(m)), name);
      if (!WIN) assert.equal(modeOf(logFile), 0o600, 'the rewritten log is owner-only');
    }
    fs.rmSync(path.join(dir, 'live.log'));

    // a layer whose .idx is not whole 8-byte keys is skipped and named, and said once
    fs.mkdirSync(path.join(dir, 'layers'));
    fs.writeFileSync(path.join(dir, 'layers', 'L1-1.rows'), Buffer.alloc(ROW));
    fs.writeFileSync(path.join(dir, 'layers', 'L1-1.idx'), Buffer.alloc(5));
    const warned = [];
    let store;
    assert.doesNotThrow(() => { store = new IndexStore(dir, { log: { warn: (m) => warned.push(m) } }); });
    assert.equal(store.layers.length, 0);
    assert.equal(store.badLayers.length, 1);
    assert.match(store.badLayers[0].error, /L1-1\.idx is 5 bytes/);
    store.reloadLayers();
    assert.equal(warned.length, 1, `said once: ${warned.join(' | ')}`);
    fs.rmSync(path.join(dir, 'layers'), { recursive: true });

    // blockRows sizes an allocation: checked first
    const manifestFile = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const br of [2 ** 40, 0, -1, 1.5, '4096', null]) {
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, blockRows: br }));
      assert.throws(() => new IndexStore(dir), /rows to a block/, `blockRows ${JSON.stringify(br)}`);
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.doesNotThrow(() => new IndexStore(dir));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
