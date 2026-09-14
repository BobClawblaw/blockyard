// The address index following the chain (server/chain/index/live.js): catch-up, restart, a torn log,
// a reorganisation, folding into layers, merging them, and a reorganisation too deep to repair -- each
// checked by looking addresses up and comparing against what the chain says at that moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash256 } from '../server/chain/tx.js';
import { MAGIC } from '../server/chain/blockfile.js';
import { scriptKey } from '../server/chain/index/rows.js';
import { buildIndex } from '../server/chain/index/build.js';
import { LiveIndex } from '../server/chain/index/live.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/chain-tx.json', import.meta.url), 'utf8'));
const frame = (body, trailer = Buffer.alloc(0)) => { const h = Buffer.alloc(8); h.writeUInt32LE(MAGIC.main, 0); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body, trailer]); };

// eight scripts to pay and spend between
const SCRIPTS = Array.from({ length: 8 }, (_, i) => `0014${String(i).repeat(40).slice(0, 40)}`);
const sat = (btc) => Math.round(btc * 1e8);

// a verbose (getblock <hash> 3) block: a coinbase paying one script, and a transaction moving value
function verboseBlock(height, prev, salt) {
  const hash = hash256(Buffer.from(`${prev}:${height}:${salt}`)).toString('hex');
  const a = SCRIPTS[(height + salt) % 8], b = SCRIPTS[(height * 3 + salt + 1) % 8], c = SCRIPTS[(height + 5) % 8];
  return {
    hash, height, previousblockhash: prev,
    tx: [
      { vin: [{ coinbase: '00' }], vout: [{ value: 50, scriptPubKey: { hex: a } }, { value: 0, scriptPubKey: { hex: '6a0101' } }] },
      { vin: [{ prevout: { value: 1.5, scriptPubKey: { hex: c } } }], vout: [{ value: 1.0 + salt / 100, scriptPubKey: { hex: b } }, { value: 0.4, scriptPubKey: { hex: c } }] },
    ],
  };
}

// what an address's rows are on a given chain of verbose blocks (heights > base only), computed plainly
function expectedRows(blocks, script) {
  const out = [];
  for (const b of blocks) b.tx.forEach((tx, p) => {
    let v = 0, touched = false;
    for (const o of tx.vout) if (o.scriptPubKey.hex === script) { v += sat(o.value); touched = true; }
    for (const i of tx.vin) if (i.prevout?.scriptPubKey.hex === script) { v -= sat(i.prevout.value); touched = true; }
    if (touched) out.push({ height: b.height, pos: p, value: v });
  });
  return out;
}

async function tinyBase(root) {
  // a base index over the real genesis block only: the live tail does the rest
  const blocksDir = path.join(root, 'blocks'), out = path.join(root, 'index');
  mkdirSync(blocksDir);
  writeFileSync(path.join(blocksDir, 'blk00000.dat'), frame(Buffer.from(FX.genesis.hex, 'hex')));
  writeFileSync(path.join(blocksDir, 'rev00000.dat'), Buffer.alloc(0));
  const rpc = { batch: async (calls) => calls.map((c) => {
    if (c.method === 'getblockchaininfo') return { ok: true, result: { chain: 'main', blocks: 0 } };
    if (c.method === 'getblockhash') return { ok: true, result: FX.genesis.expect.hash };
    return { ok: false, error: { message: c.method } };
  }) };
  await buildIndex({ rpc, blocksDir, out, workers: 1 });
  return out;
}

// a node whose chain can be replaced from any height
function fakeNode() {
  const node = { chain: [{ hash: FX.genesis.expect.hash, height: 0 }] };
  node.extend = (to, salt = 0) => { while (node.chain.length <= to) { const prev = node.chain[node.chain.length - 1]; node.chain.push(verboseBlock(node.chain.length, prev.hash, salt)); } };
  node.reorg = (from, to, salt) => { node.chain.length = from; node.extend(to, salt); };
  node.rpc = { batch: async (calls) => calls.map((c) => {
    if (c.method === 'getblockcount') return { ok: true, result: node.chain.length - 1 };
    if (c.method === 'getblockhash') return node.chain[c.params[0]] ? { ok: true, result: node.chain[c.params[0]].hash } : { ok: false, error: { message: 'Block height out of range' } };
    if (c.method === 'getblock') { const b = node.chain.find((x) => x.hash === c.params[0]); return b ? { ok: true, result: b } : { ok: false, error: { message: 'Block not found' } }; }
    return { ok: false, error: { message: c.method } };
  }) };
  return node;
}

function check(live, node, label) {
  for (const s of SCRIPTS) {
    const want = expectedRows(node.chain.slice(1), s);
    const got = live.store.rowsForKey(scriptKey(Buffer.from(s, 'hex'))).map(({ height, pos, value }) => ({ height, pos, value }));
    assert.deepEqual(got, want, `${label}: rows for ${s.slice(0, 10)}`);
    const sum = live.store.summaryForKey(scriptKey(Buffer.from(s, 'hex')), { limit: 3 });
    assert.equal(sum.txCount, want.length, `${label}: count`);
    assert.equal(sum.balance, want.reduce((a, r) => a + r.value, 0), `${label}: balance`);
  }
  assert.equal(live.store.tip, node.chain.length - 1, `${label}: the index reaches the node's tip`);
}

test('THE INDEX FOLLOWS THE CHAIN: catch up, restart, torn log, reorg, fold, merge, and a reorg too deep to repair', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blockyard-live-'));
  try {
    const dir = await tinyBase(root);
    const node = fakeNode();
    const opts = { rpc: node.rpc, confirmations: 3, foldBlocks: 4, maxLayers: 2, maxBlocksPerPoll: 100 };

    // catch up from the base
    node.extend(6);
    let live = new LiveIndex(dir, opts);
    await live.poll();
    assert.equal(live.lastError, null, live.lastError);
    // 6 blocks, 3 confirmations: blocks 1..3 are deep, but 4 are needed to fold, so all stay in the tail
    assert.equal(live.status().layers, 0);
    check(live, node, 'caught up');

    // a restart replays the log
    live = new LiveIndex(dir, opts);
    check(live, node, 'after restart');

    // a record torn by a crash is dropped, not misread
    appendFileSync(path.join(dir, 'live.log'), Buffer.from('474c5942010000ffff', 'hex'));
    live = new LiveIndex(dir, opts);
    check(live, node, 'after a torn write');

    // a reorganisation: blocks 5 and 6 replaced, and the chain grows past them
    node.reorg(5, 7, 9);
    await live.poll();
    check(live, node, 'after a reorg');
    live = new LiveIndex(dir, opts);
    check(live, node, 'the rollback survives a restart');

    // folding: grow until four blocks are three deep -> one layer, and the log keeps only the rest
    node.extend(10);
    await live.poll();
    assert.equal(live.status().layers, 1, 'folded into a layer');
    assert.ok(live.status().tailBlocks < 10, 'and dropped from memory');
    check(live, node, 'after a fold');
    live = new LiveIndex(dir, opts);
    check(live, node, 'a fold survives a restart');

    // merging: more layers than allowed become one
    node.extend(22);
    await live.poll();
    assert.ok(live.status().layers <= 2, `layers are merged (${live.status().layers})`);
    check(live, node, 'after merging layers');
    live = new LiveIndex(dir, opts);
    check(live, node, 'merged layers survive a restart');
    assert.ok(!readdirSync(path.join(dir, 'layers')).some((f) => f.endsWith('.tmp')), 'no temporary files left behind');

    // a reorganisation below what is folded cannot be repaired: the index says so and stops
    node.reorg(3, 23, 77);
    await live.poll();
    assert.match(live.status().stale ?? '', /rebuild/, 'stale, asking for a rebuild');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
