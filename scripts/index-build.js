#!/usr/bin/env node
// Build the address index from the configured node's block files (server/chain/index/build.js).
//
//   node scripts/index-build.js --out <dir> [--node <id>] [--workers N] [--files 0,1,5754]
//
// --files builds a partial index for testing (the completeness check is skipped). Progress goes to
// stderr once a second; the manifest, with every phase's timings, goes to stdout at the end.
import { loadConfig } from '../server/config.js';
import { RpcClient } from '../server/rpc/client.js';
import { buildIndex } from '../server/chain/index/build.js';
import path from 'node:path';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const cfg = loadConfig();
const node = cfg.nodes.find((n) => n.id === arg('node', null)) ?? cfg.nodes.find((n) => n.datadir) ?? cfg.nodes[0];
if (!node.datadir) { console.error(`node ${node.id} has no datadir configured; the index is built from its block files`); process.exit(2); }
const out = arg('out', null);
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const rpc = new RpcClient(node, { ...(cfg.rpc ?? {}), ...(node.rpc ?? {}) }, { log: { info() {}, warn() {}, error() {}, debug() {} } });

let last = 0;
const started = Date.now();
const manifest = await buildIndex({
  rpc, blocksDir: path.join(node.datadir, 'blocks'), out,
  workers: arg('workers', null) ? Number(arg('workers')) : undefined,
  files: arg('files', null) ? arg('files').split(',').map(Number) : null,
  onProgress: (p) => {
    const now = Date.now();
    if (now - last < 1000 && p.done !== p.total) return;
    last = now;
    const el = ((now - started) / 1000).toFixed(0);
    process.stderr.write(`[${el}s] ${p.phase} ${p.done}/${p.total}${p.rows != null ? ` rows ${p.rows.toLocaleString()}` : ''}\n`);
  },
});
console.log(JSON.stringify(manifest, (k, v) => (k === 'bucketRows' ? undefined : v), 1));
process.exit(0);
