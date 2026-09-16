#!/usr/bin/env node
// Build the pool label map: coinbase tag -> pool name, from mempool.space's curated
// mining-pools data (https://github.com/mempool/mining-pools, pools-v2.json).
//
// WHY THIS IS ALLOWED AND A GUESS IS NOT. The monitor never invents a miner name. It
// shows the bytes the pool put in its own coinbase, verbatim. A label from this file is
// not a guess by us -- it is a curated mapping by the people who maintain one, and it
// arrives with its provenance (source URL, content sha, fetchedAt) and travels with
// every row, so a reader can see which label came from where and check it. Blocks that
// match nothing stay 'unknown:<fingerprint>' with the raw tag on screen.
//
// HOW TO RUN. It is manual by default, on purpose: the app must not need the network at
// runtime, and a surprise fetch that changes which organisation the dashboard blames for
// a block is not a benign dependency. Refresh it when you want newer labels:
//
//   node scripts/pool-map.js                      # fetch and write data/pool-map.json
//   node scripts/pool-map.js --file pools-v2.json # offline input
//   node scripts/pool-map.js --check              # compare against what we are seeing now
//   node scripts/pool-map.js --yes                # replace an existing data/pool-map.json without asking
//   node scripts/pool-map.js --expect-sha256 HEX  # refuse a download that is not exactly those bytes
//
// Before it replaces data/pool-map.json it prints which pools the new map adds, removes and
// changes, and writes only on --yes or a "y" at the prompt; redirects are followed to HTTPS only,
// by both the node:https path and the curl fallback; and the coverage check asks the monitor on
// the port and scheme its config names (2026-09-16, audit L15).
//
// The input shape as fetched on 2026-09-09: 35,733 bytes, 171 pools, 201 tags, keys
// per pool: addresses, id, link, name, tags. Tags are literal fragments of the coinbase
// text (e.g. "/BlockfillsPool/"), which is exactly what we can test for -- no regex
// dialect, no wildcards, no heuristics.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'pool-map.json');
const URL_ = 'https://raw.githubusercontent.com/mempool/mining-pools/master/pools-v2.json';

const args = process.argv.slice(2);
const asFile = args.includes('--file') ? path.resolve(args[args.indexOf('--file') + 1]) : null;
const checkOnly = args.includes('--check');

/** The whole scriptSig rendered as text, so a tag with non-ASCII bytes can still match. */
function normalizeText(s) {
  return String(s ?? '')
    .replace(/\0+/g, ' ')
    .replace(/[\x01-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function build(content, source) {
  const list = JSON.parse(content);
  if (!Array.isArray(list) || !list.length) throw new Error('pools-v2.json is not a non-empty array');
  const pools = [];
  for (const p of list) {
    const name = (p.name ?? p.poolName ?? '').toString().trim();
    if (!name) continue;
    const tags = (p.tags ?? []).map((t) => String(t)).filter((t) => t.trim().length >= 2);
    if (!tags.length) continue;
    pools.push({
      key: name.toLowerCase().replace(/\s+/g, ' '),
      name,
      slug: (p.slug ?? p.slugInfo?.slug ?? null) || null,
      link: p.link ?? p.poolLinks?.[0]?.urls?.[0]?.url ?? null,
      tags: tags.sort((a, b) => b.length - a.length),
    });
  }
  // Longest tag wins, so "/Foundry USA Pool" is never stolen by a shorter overlapping tag.
  const matchers = pools
    .flatMap((p) => p.tags.map((tag) => ({ tag, tagNorm: normalizeText(tag), key: p.key, name: p.name })))
    .filter((m) => m.tagNorm.length >= 3)
    .sort((a, b) => b.tagNorm.length - a.tagNorm.length);
  return {
    source,
    sourceSha256: crypto.createHash('sha256').update(content).digest('hex'),
    fetchedAt: new Date().toISOString(),
    attribution: 'mempool.space/mining-pools (MIT). Labels are their curated mapping, matched by literal coinbase text; unmatched blocks keep their raw tag and an unknown fingerprint.',
    matchRule: 'longest literal tag substring wins, case-insensitive, on the whole coinbase scriptSig as text; tags shorter than 3 normalised characters are dropped',
    pools,
    matchers,
  };
}

// node:https with family:4, not fetch(). Measured on this box: `fetch` handed the
// request to every A and AAAA address, every IPv6 attempt was ENETUNREACH (this host has
// no IPv6 route -- the node's own log says the same: "no global IPv6 route"), and the
// call died inside a 20 s budget while an IPv4 socket to the same host was connecting in
// 367 ms. Pinning the family is the fix; a curl fallback is kept because a tool that
// fetches pool labels has to work on a box whose stack is half broken.
import https from 'node:https';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../server/config.js';

/**
 * Where a redirect may go (2026-09-16, audit L15): HTTPS only. A `Location: http://...` would
 * otherwise have been followed by the curl fallback, and the labels read over plain HTTP.
 * Returns the absolute next URL, or throws.
 */
export function redirectTarget(location, from) {
  const next = new URL(location, from);
  if (next.protocol !== 'https:') throw new Error(`refusing a redirect from ${from} to ${next.protocol}//${next.host}: HTTPS only`);
  return next.toString();
}

export function getOverHttps(url, redirectsLeft = 3, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, ...extra, headers: { 'user-agent': 'BlockYard pool-map/1' }, timeout: 20_000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let next;
        try { next = redirectTarget(res.headers.location, url); } catch (err) { return reject(err); }
        return resolve(getOverHttps(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}

/**
 * The curl fallback's arguments. `--proto =https --proto-redir =https` (2026-09-16, audit L15):
 * -L alone follows a redirect to any protocol curl speaks, plain http included.
 */
export function curlArgs(url) {
  return ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '25', url];
}

async function fetchContent() {
  try {
    return await getOverHttps(URL_);
  } catch (err) {
    // curl follows its own resolver order and got 200 here while node's fetch failed,
    // so a second, different path is worth one retry before declaring the fetch dead.
    // A refused non-HTTPS redirect is not a flaky stack: it is not retried another way.
    if (/HTTPS only/.test(err?.message ?? '')) throw err;
    try {
      return execFileSync('curl', curlArgs(URL_), { encoding: 'utf8', maxBuffer: 8 << 20 });
    } catch {
      throw new Error(`could not fetch ${URL_}: ${err?.message ?? err}`);
    }
  }
}

/**
 * What a refresh changes, pool by pool (2026-09-16, audit L15): the file decides which
 * organisation the dashboard names for a block, so a rewrite is shown before it is made.
 * `changed` is a pool whose name, link or tags differ. Keys are the maps' own pool keys.
 */
export function diffPoolMaps(before, after) {
  const index = (m) => new Map((m?.pools ?? []).map((p) => [p.key, p]));
  const a = index(before), b = index(after);
  const same = (x, y) => x.name === y.name && (x.link ?? null) === (y.link ?? null)
    && JSON.stringify([...(x.tags ?? [])].sort()) === JSON.stringify([...(y.tags ?? [])].sort());
  const added = [...b.keys()].filter((k) => !a.has(k)).sort();
  const removed = [...a.keys()].filter((k) => !b.has(k)).sort();
  const changed = [...b.keys()].filter((k) => a.has(k) && !same(a.get(k), b.get(k))).sort();
  return { added, removed, changed, unchanged: [...b.keys()].filter((k) => a.has(k)).length - changed.length };
}

export function formatDiff(d, name = (k) => k) {
  const list = (ks) => (ks.length > 12 ? `${ks.slice(0, 12).map(name).join(', ')}, and ${ks.length - 12} more` : ks.map(name).join(', '));
  const lines = [`pools: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.unchanged} unchanged`];
  if (d.added.length) lines.push(`  + ${list(d.added)}`);
  if (d.removed.length) lines.push(`  - ${list(d.removed)}`);
  if (d.changed.length) lines.push(`  ~ ${list(d.changed)}`);
  return lines.join('\n');
}

/** --expect-sha256: the download must be exactly these bytes (2026-09-16, audit L15). */
export function checkExpectedSha(content, expected) {
  if (expected == null) return null;
  const want = String(expected).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('--expect-sha256 takes 64 hex characters');
  const got = crypto.createHash('sha256').update(content).digest('hex');
  if (got !== want) throw new Error(`sha256 mismatch: expected ${want}, got ${got}; nothing written`);
  return got;
}

/**
 * The running monitor's own mining endpoint, for the coverage check (2026-09-16, audit L15): it
 * was https://<host>:8088 whatever the config said, and the default port has been 21000 since
 * 2026-09-13, so coverage was never measured. Port, TLS and bind address come from the loaded
 * config (config/local.json, BLOCKYARD_PORT, BLOCKYARD_TLS); HTTPS unless TLS is turned off.
 */
export function coverageUrl(cfg) {
  const server = cfg?.server ?? {};
  let host = server.hosts?.[0] ?? server.host ?? '127.0.0.1';
  if (Array.isArray(host)) host = host[0] ?? '127.0.0.1';
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  const port = Number.isInteger(Number(server.port)) && Number(server.port) > 0 ? Number(server.port) : 21000;
  const scheme = cfg?.tls === false || server.tls?.enabled === false ? 'http' : 'https';
  return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}/api/mining?node=main`;
}

async function main() {
  const argAfter = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? null : null);
  const content = asFile ? fs.readFileSync(asFile, 'utf8') : await fetchContent();
  try { checkExpectedSha(content, argAfter('--expect-sha256')); } catch (err) { console.error(err.message); process.exit(1); }
  const map = build(content, asFile ? `file:${path.basename(asFile)}` : URL_);

  // What we are actually seeing right now, so the coverage number is measured and not
  // assumed. Read live from the running monitor if it answers; otherwise say it is unknown.
  let observed = null;
  let coverageError = null;
  try {
    let cfg;
    try { cfg = loadConfig(); } catch { cfg = { server: { port: Number(process.env.BLOCKYARD_PORT) || 21000 } }; }
    const url = coverageUrl(cfg);
    // Same family:4 path as the fetch above, plus the box's own CA: the monitor serves TLS
    // from a local CA that is not in the system trust store, and "could not verify" is a
    // different fact from "could not reach".
    const caFile = process.env.BLOCKYARD_CA_FILE ?? null;   // a CA file, only where the fetch needs a private one
    const extra = caFile && fs.existsSync(caFile) ? { ca: fs.readFileSync(caFile) } : {};
    const body = url.startsWith('https:') ? await getOverHttps(url, 0, extra) : await (await fetch(url)).text();
    const d = JSON.parse(body);
    const rows = d.recent ?? [];
    const hit = rows.filter((r) => map.matchers.some((m) => normalizeText(`${r.rawCoinbase ? Buffer.from(r.rawCoinbase, 'hex').toString('utf8') : ''} ${r.tagText || ''}`).includes(m.tagNorm))).length;
    observed = {
      blocks: rows.length, labelled: hit, unknown: rows.filter((r) => !r.poolLabel).length,
      labelSource: d.labelSource ? `labels from ${d.labelSource.source} @ ${(d.labelSource.sha256 || '').slice(0, 10)}` : 'no map loaded by the monitor yet',
    };
  } catch (err) {
    coverageError = err?.message ?? String(err);
  }

  console.log(`pools: ${map.pools.length}  matchers: ${map.matchers.length}  sha256: ${map.sourceSha256}`);
  if (observed) console.log(`coverage of the ${observed.blocks} attributed blocks: ${observed.labelled} matched a curated tag, ${observed.unknown} keep their raw tag\n  ${observed.labelSource ?? ''}`);
  else console.log(`coverage: not measured (${coverageError}) -- reported as unknown rather than assumed`);

  // THE DIFF BEFORE THE WRITE (2026-09-16, audit L15): against the file this replaces, or, when
  // there is none yet, the shipped config/pool-map.json the monitor uses until then.
  const shipped = path.join(ROOT, 'config', 'pool-map.json');
  const replacing = fs.existsSync(OUT);
  const prevFile = replacing ? OUT : fs.existsSync(shipped) ? shipped : null;
  let prev = null;
  if (prevFile) { try { prev = JSON.parse(fs.readFileSync(prevFile, 'utf8')); } catch { prev = null; } }
  if (prev) {
    const names = new Map([...(prev.pools ?? []), ...map.pools].map((p) => [p.key, p.name]));
    console.log(`against ${path.relative(ROOT, prevFile)}${prev.sourceSha256 ? ` (sha256 ${prev.sourceSha256.slice(0, 12)})` : ''}:`);
    console.log(formatDiff(diffPoolMaps(prev, map), (k) => names.get(k) ?? k));
  }
  if (checkOnly) process.exit(0);

  if (replacing && !args.includes('--yes')) {
    if (!process.stdin.isTTY) { console.log(`not written: ${path.relative(ROOT, OUT)} exists; pass --yes to replace it`); process.exit(1); }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`replace ${path.relative(ROOT, OUT)}? (y/N) `)).trim().toLowerCase();
    rl.close();
    if (!a.startsWith('y')) { console.log('not written'); process.exit(1); }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(map, null, 1)}\n`);
  fs.renameSync(tmp, OUT);
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}

// run only as a script, so the tests can import the pieces without a fetch
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
}
