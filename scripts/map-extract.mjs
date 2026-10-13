// A STREET MAP OF YOUR OWN PLACE, DOWNLOADED ONCE (docs/PLAN-WEATHER-GLOBE.md, part B; operator, 2026-10-13: "can we
// add street level detail?" -- then "continue with your plan").
//
//   node scripts/map-extract.mjs --lat 52.52 --lon 13.41 [--radius-km 60] [--maxzoom 15] [--out data/map/place.pmtiles]
//                                [--build 20261013.pmtiles] [--dry-run]
//
// Protomaps publishes the whole of OpenStreetMap as ONE PMTiles archive (build.protomaps.com, ~139 GB, zoom 0-15,
// vector tiles; data (c) OpenStreetMap contributors, ODbL -- the map must say so, and does). The archive is made for
// HTTP range requests, so this cuts out the tiles within --radius-km of the place at every zoom, by reading the
// directories that cover them and fetching those tiles' byte ranges, and writes them as a small PMTiles file of
// their own. Nothing else is contacted, there is no account, and after this the monitor reads the file from disk
// (server/http/vtiles.js): no map-tile server at run time. Zero dependencies: the format is read and written here
// (PMTiles v3: a 127-byte header, gzip-compressed directories of [tileId, offset, length, runLength] entries, tile
// ids on a Hilbert curve per zoom), fetch and zlib are Node's.
//
// Measured 2026-10-13 against 20261013.pmtiles: see the figures the dry run prints -- a 60 km radius at zoom 15 is a
// few tens of thousands of tiles.
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const lat = Number(arg('--lat')), lon = Number(arg('--lon'));
const radiusKm = Number(arg('--radius-km', 60));
const maxzoom = Math.min(15, Math.max(8, Number(arg('--maxzoom', 15))));
const dry = args.includes('--dry-run');
const INDEX = 'https://build-metadata.protomaps.dev/builds.json';
const BASE = 'https://build.protomaps.com/';
if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
  console.error('usage: node scripts/map-extract.mjs --lat <lat> --lon <lon> [--radius-km 60] [--maxzoom 15] [--out file] [--build key] [--dry-run]');
  process.exit(2);
}

// ---------------------------------------------------------------- tile ids (PMTiles v3: zoom offset + Hilbert)
const ZOOM_BASE = [0n];
for (let z = 1; z <= 32; z++) ZOOM_BASE[z] = ZOOM_BASE[z - 1] + (1n << BigInt(2 * (z - 1)));
function tileId(z, x, y) {
  const n = 1 << z;
  let d = 0n, rx, ry, tx = x, ty = y;
  for (let s = n >> 1; s > 0; s >>= 1) {
    rx = (tx & s) > 0 ? 1 : 0; ry = (ty & s) > 0 ? 1 : 0;
    d += BigInt(s) * BigInt(s) * BigInt((3 * rx) ^ ry);
    // rotate
    if (ry === 0) { if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; } const t = tx; tx = ty; ty = t; }
  }
  return ZOOM_BASE[z] + d;
}
const D2R = Math.PI / 180;
const tileX = (lo, z) => Math.floor(((lo + 180) / 360) * 2 ** z);
const tileY = (la, z) => { const s = Math.sin(la * D2R); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z); };

// the tiles wanted: every zoom 0..maxzoom, those touching the circle's bounding box
const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.max(0.2, Math.cos(lat * D2R)));
const bbox = { s: Math.max(-85, lat - dLat), n: Math.min(85, lat + dLat), w: Math.max(-180, lon - dLon), e: Math.min(180, lon + dLon) };
const wanted = new Map();     // tileId (BigInt as string) -> [z, x, y]
for (let z = 0; z <= maxzoom; z++) {
  const n = 2 ** z;
  const x0 = Math.max(0, tileX(bbox.w, z)), x1 = Math.min(n - 1, tileX(bbox.e, z));
  const y0 = Math.max(0, tileY(bbox.n, z)), y1 = Math.min(n - 1, tileY(bbox.s, z));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) wanted.set(tileId(z, x, y).toString(), [z, x, y]);
}
const wantedIds = [...wanted.keys()].map((k) => BigInt(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
console.log(`${wantedIds.length} tiles wanted within ${radiusKm} km of ${lat}, ${lon} to zoom ${maxzoom}`);

// ---------------------------------------------------------------- the archive
const UA = 'BlockYard map-extract (self-hosted Bitcoin node monitor)';
let fetched = 0, requests = 0;
async function range(url, off, len) {
  const r = await fetch(url, { headers: { 'user-agent': UA, range: `bytes=${off}-${off + len - 1}` }, redirect: 'error' });
  if (r.status !== 206) throw new Error(`HTTP ${r.status} for bytes ${off}-${off + len - 1}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length !== len) throw new Error(`short read: ${buf.length} of ${len}`);
  fetched += buf.length; requests++;
  return buf;
}
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
function parseHeader(b) {
  if (b.toString('latin1', 0, 7) !== 'PMTiles' || b[7] !== 3) throw new Error('not a PMTiles v3 archive');
  return {
    rootOff: u64(b, 8), rootLen: u64(b, 16), metaOff: u64(b, 24), metaLen: u64(b, 32), leafOff: u64(b, 40), leafLen: u64(b, 48),
    dataOff: u64(b, 56), dataLen: u64(b, 64), addressed: u64(b, 72), entries: u64(b, 80), contents: u64(b, 88),
    clustered: b[96], internalCompression: b[97], tileCompression: b[98], tileType: b[99], minZoom: b[100], maxZoom: b[101],
  };
}
function readVarints(b) {
  let pos = 0;
  const next = () => { let r = 0n, s = 0n; for (;;) { const c = b[pos++]; r |= BigInt(c & 0x7f) << s; if (c < 0x80) return r; s += 7n; } };
  const n = Number(next());
  const ids = new Array(n), runs = new Array(n), lens = new Array(n), offs = new Array(n);
  let t = 0n;
  for (let i = 0; i < n; i++) { t += next(); ids[i] = t; }
  for (let i = 0; i < n; i++) runs[i] = Number(next());
  for (let i = 0; i < n; i++) lens[i] = Number(next());
  for (let i = 0; i < n; i++) { const v = next(); offs[i] = v === 0n && i > 0 ? offs[i - 1] + lens[i - 1] : Number(v) - 1; }
  return { n, ids, runs, lens, offs };
}
const decompress = (b, kind) => (kind === 2 ? gunzipSync(b) : kind === 1 ? b : (() => { throw new Error(`compression ${kind} is not gzip`); })());
function writeDirectory(entries) {
  // entries: [{ id (BigInt), off, len, run }], sorted by id
  const parts = [];
  const v = (x) => { let n = BigInt(x); do { let c = Number(n & 0x7fn); n >>= 7n; if (n) c |= 0x80; parts.push(c); } while (n); };
  v(entries.length);
  let last = 0n;
  for (const e of entries) { v(e.id - last); last = e.id; }
  for (const e of entries) v(e.run);
  for (const e of entries) v(e.len);
  for (let i = 0; i < entries.length; i++) v(i > 0 && entries[i].off === entries[i - 1].off + entries[i - 1].len ? 0 : entries[i].off + 1);
  return Buffer.from(parts);
}

async function main() {
  let key = arg('--build', null);
  if (!key) {
    const list = await (await fetch(INDEX, { headers: { 'user-agent': UA } })).json();
    key = list.filter((x) => x && typeof x.key === 'string').sort((a, b) => a.key.localeCompare(b.key)).at(-1)?.key;
    if (!key) throw new Error('no builds listed');
  }
  const url = BASE + key;
  const head = parseHeader(await range(url, 0, 127));
  if (head.tileType !== 1) throw new Error(`tile type ${head.tileType} is not MVT`);
  console.log(`archive ${key}: zoom ${head.minZoom}-${head.maxZoom}, ${head.entries} entries, root ${head.rootLen} B, leaf directories ${(head.leafLen / 1e6).toFixed(0)} MB`);
  const root = readVarints(decompress(await range(url, head.rootOff, head.rootLen), head.internalCompression));
  const meta = decompress(await range(url, head.metaOff, head.metaLen), head.internalCompression);
  // walk: for each wanted id find its root entry (last entry with id <= wanted); a leaf pointer (run 0) names a leaf
  // directory to fetch; a tile entry (run > 0) covers ids [id, id + run)
  const find = (dir, id) => { let lo = 0, hi = dir.n - 1, at = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dir.ids[m] <= id) { at = m; lo = m + 1; } else hi = m - 1; } return at; };
  const leafCache = new Map();
  const tiles = new Map();      // "off,len" -> { off, len, ids: [BigInt] }
  let missing = 0;
  const leafWanted = new Map(); // leaf off -> len (to fetch once, in order)
  for (const id of wantedIds) {
    const i = find(root, id);
    if (i < 0) { missing++; continue; }
    if (root.runs[i] === 0) leafWanted.set(root.offs[i], root.lens[i]);
  }
  console.log(`${leafWanted.size} leaf directories to read`);
  for (const [off, len] of [...leafWanted.entries()].sort((a, b) => a[0] - b[0])) {
    leafCache.set(off, readVarints(decompress(await range(url, head.leafOff + off, len), head.internalCompression)));
  }
  for (const id of wantedIds) {
    const i = find(root, id);
    if (i < 0) { missing++; continue; }
    let dir = root, j = i;
    if (root.runs[i] === 0) { dir = leafCache.get(root.offs[i]); j = find(dir, id); if (j < 0) { missing++; continue; } }
    if (!(id < dir.ids[j] + BigInt(dir.runs[j]))) { missing++; continue; }   // a gap: an empty tile (sea)
    const k = `${dir.offs[j]},${dir.lens[j]}`;
    if (!tiles.has(k)) tiles.set(k, { off: dir.offs[j], len: dir.lens[j], ids: [] });
    tiles.get(k).ids.push(id);
  }
  const uniq = [...tiles.values()].sort((a, b) => a.off - b.off);
  const bytes = uniq.reduce((n, t) => n + t.len, 0);
  console.log(`${uniq.length} distinct tiles (${missing} wanted ids are empty tiles), ${(bytes / 1e6).toFixed(1)} MB of tile data to fetch`);
  if (dry) { console.log(`dry run: nothing written (directories read: ${(fetched / 1e6).toFixed(1)} MB in ${requests} requests)`); return; }

  // fetch the tile data in coalesced runs (clustered archive: nearby ids are nearby bytes), 8 MB a request at most
  const out = path.resolve(arg('--out', path.join('data', 'map', `${lat.toFixed(2)}_${lon.toFixed(2)}.pmtiles`)));
  mkdirSync(path.dirname(out), { recursive: true });
  const data = [];
  let i = 0, done = 0, t0 = Date.now();
  while (i < uniq.length) {
    let j = i, end = uniq[i].off + uniq[i].len;
    while (j + 1 < uniq.length && uniq[j + 1].off - end < 65_536 && uniq[j + 1].off + uniq[j + 1].len - uniq[i].off <= 8 * 1024 * 1024) { j++; end = Math.max(end, uniq[j].off + uniq[j].len); }
    const buf = await range(url, head.dataOff + uniq[i].off, end - uniq[i].off);
    for (let k = i; k <= j; k++) { const t = uniq[k]; t.buf = buf.subarray(t.off - uniq[i].off, t.off - uniq[i].off + t.len); data.push(t); done++; }
    i = j + 1;
    if (done % 500 < (j - i + 1) || i >= uniq.length) process.stdout.write(`\r${done}/${uniq.length} tiles, ${(fetched / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
  }
  process.stdout.write('\n');
  // write: header, ONE root directory (our own reader, server/http/vtiles.js, reads any size), metadata, tile data
  const entries = [];
  let off = 0;
  const outData = [];
  for (const t of data) {
    outData.push(t.buf);
    for (const id of t.ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) entries.push({ id, off, len: t.len, run: 1 });
    off += t.len;
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // merge consecutive ids pointing at the same bytes into runs
  const merged = [];
  for (const e of entries) { const p = merged.at(-1); if (p && p.off === e.off && p.len === e.len && p.id + BigInt(p.run) === e.id) p.run++; else merged.push({ ...e }); }
  const rootDir = gzipSync(writeDirectory(merged));
  const metaGz = gzipSync(meta);
  const hdr = Buffer.alloc(127);
  hdr.write('PMTiles', 0, 'latin1'); hdr[7] = 3;
  const rootOff = 127, metaOff = rootOff + rootDir.length, leafOff = metaOff + metaGz.length, dataOff = leafOff;
  const w = (o, v) => hdr.writeBigUInt64LE(BigInt(v), o);
  w(8, rootOff); w(16, rootDir.length); w(24, metaOff); w(32, metaGz.length); w(40, leafOff); w(48, 0); w(56, dataOff); w(64, off);
  w(72, wantedIds.length); w(80, merged.length); w(88, data.length);
  hdr[96] = 1; hdr[97] = 2; hdr[98] = head.tileCompression; hdr[99] = 1; hdr[100] = 0; hdr[101] = maxzoom;
  const i32 = (o, v) => hdr.writeInt32LE(Math.round(v * 1e7), o);
  i32(102, bbox.w); i32(106, bbox.s); i32(110, bbox.e); i32(114, bbox.n);
  hdr[118] = Math.min(maxzoom, 11); i32(119, lon); i32(123, lat);
  writeFileSync(out, Buffer.concat([hdr, rootDir, metaGz, ...outData]));
  console.log(`wrote ${out}: ${(statSync(out).size / 1e6).toFixed(1)} MB, ${data.length} tiles, ${merged.length} directory entries, from ${key} (${requests} requests)`);
  console.log('data (c) OpenStreetMap contributors (ODbL), tiles by Protomaps; name it in the monitor as weather.mapFile or leave it in data/map/ to be found');
}
main().catch((e) => { console.error(`map-extract: ${e?.message ?? e}`); process.exit(1); });
