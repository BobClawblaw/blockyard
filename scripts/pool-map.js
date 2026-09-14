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
import { execFileSync } from 'node:child_process';

function getOverHttps(url, redirectsLeft = 3, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, ...extra, headers: { 'user-agent': 'BlockYard pool-map/1' }, timeout: 20_000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(getOverHttps(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
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

async function fetchContent() {
  try {
    return await getOverHttps(URL_);
  } catch (err) {
    // curl follows its own resolver order and got 200 here while node's fetch failed,
    // so a second, different path is worth one retry before declaring the fetch dead.
    try {
      return execFileSync('curl', ['-fsSL', '--max-time', '25', URL_], { encoding: 'utf8', maxBuffer: 8 << 20 });
    } catch {
      throw new Error(`could not fetch ${URL_}: ${err?.message ?? err}`);
    }
  }
}

const content = asFile ? fs.readFileSync(asFile, 'utf8') : await fetchContent();
const map = build(content, asFile ? `file:${path.basename(asFile)}` : URL_);

// What we are actually seeing right now, so the coverage number is measured and not
// assumed. Read live from the running monitor if it answers; otherwise say it is unknown.
let observed = null;
let coverageError = null;
try {
  const cfgPath = path.join(ROOT, 'config', 'local.json');
  const host = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.server?.hosts?.[0] ?? '127.0.0.1';
  // Same family:4 path as the fetch above, plus the box's own CA: the monitor serves TLS
  // from a local CA that is not in the system trust store, and "could not verify" is a
  // different fact from "could not reach".
  const caFile = process.env.BLOCKYARD_CA_FILE ?? '/etc/ssl/bmc-local/ca.crt';
  const body = await getOverHttps(`https://${host}:8088/api/mining?node=main`, 0, fs.existsSync(caFile) ? { ca: fs.readFileSync(caFile) } : {});
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

console.log(`pools: ${map.pools.length}  matchers: ${map.matchers.length}  sha256: ${map.sourceSha256.slice(0, 12)}`);
if (observed) console.log(`coverage of the ${observed.blocks} attributed blocks: ${observed.labelled} matched a curated tag, ${observed.unknown} keep their raw tag\n  ${observed.labelSource ?? ''}`);
else console.log(`coverage: not measured (${coverageError}) -- reported as unknown rather than assumed`);
if (checkOnly) process.exit(0);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(map, null, 1)}\n`);
fs.renameSync(tmp, OUT);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
