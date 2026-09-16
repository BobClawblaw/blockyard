#!/usr/bin/env node
// Build the address index from the configured node's block files (server/chain/index/build.js).
//
//   node scripts/index-build.js --out <dir> [--node <id>] [--workers N] [--files 0,1,5754]
//
// --files builds a partial index for testing (the completeness check is skipped). A build stopped part
// way resumes when run again with the same --out (build.js, THE BUILD JOURNAL); the log line says so,
// or says why the unfinished work was discarded. Progress goes to
// stderr once a second; the manifest, with every phase's timings, goes to stdout at the end.
import { loadConfig } from '../server/config.js';
import { RpcClient } from '../server/rpc/client.js';
import { buildIndex, rpcPacer } from '../server/chain/index/build.js';
import path from 'node:path';
import { progress, progressLine, strip, c, fmt } from './ui.js';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const cfg = loadConfig();
const node = cfg.nodes.find((n) => n.id === arg('node', null)) ?? cfg.nodes.find((n) => n.datadir) ?? cfg.nodes[0];
if (!node.datadir) { console.error(`node ${node.id} has no datadir configured; the index is built from its block files`); process.exit(2); }
const out = arg('out', null);
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const rpc = new RpcClient(node, { ...(cfg.rpc ?? {}), ...(node.rpc ?? {}) }, { log: { info() {}, warn() {}, error() {}, debug() {} } });

const started = Date.now();
let phase = null, phaseStart = started;
const bar = progress();
const manifest = await buildIndex({
  rpc, blocksDir: path.join(node.datadir, 'blocks'), out,
  pace: rpcPacer(rpc, { onChange: (held) => process.stderr.write(held ? '  paused while the node\'s RPC is slow or failing\n' : '  resumed\n') }),
  log: (text) => { bar.done(); process.stderr.write(`  ${text}\n`); },
  workers: arg('workers', null) ? Number(arg('workers')) : undefined,
  files: arg('files', null) ? arg('files').split(',').map(Number) : null,
  onProgress: (p) => {
    if (p.phase !== phase) {
      if (phase) bar.done(strip(progressLine({ phase, done: 1, total: 1, elapsed: (Date.now() - phaseStart) / 1000 })));
      phase = p.phase; phaseStart = Date.now();
    }
    bar.update({ ...p, elapsed: (Date.now() - phaseStart) / 1000 });
  },
});
bar.done(`  ${c.ok('✓')} ${fmt.big(manifest.rows ?? 0)} rows to block ${Number(manifest.tip?.height ?? 0).toLocaleString()} in ${((Date.now() - started) / 60000).toFixed(1)} min -> ${out}`);
console.log(JSON.stringify(manifest, (k, v) => (k === 'bucketRows' ? undefined : v), 1));
process.exit(0);
