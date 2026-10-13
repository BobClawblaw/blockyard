// THE STREET-MAP EXTRACT, AS A MODULE (docs/PLAN-WEATHER-GLOBE.md, part B; operator, 2026-10-13: "we need to build
// this feature into BlockYard. Not just one-off shit"). The engine behind both the Build button in Display settings
// (server/collect/mapbuild.js) and the command line (scripts/map-extract.mjs): cut the OpenStreetMap vector tiles
// within a radius of a place out of Protomaps' planet archive and write them as a small PMTiles file of their own.
//
// Protomaps publishes the whole of OpenStreetMap as ONE PMTiles archive (build.protomaps.com, ~139 GB, zoom 0-15; data
// (c) OpenStreetMap contributors, ODbL), made for HTTP range requests: this reads the 127-byte header, the gzip root
// directory, the few leaf directories covering the wanted tile ids (on a Hilbert curve per zoom), then the tiles'
// byte ranges in coalesced runs. No account, no key, nothing else contacted. Zero dependencies: fetch and zlib are
// Node's; the format is read and written here. The result has ONE root directory (http/vtiles.js reads any size).
import { mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const PM_INDEX = 'https://build-metadata.protomaps.dev/builds.json';
export const PM_BASE = 'https://build.protomaps.com/';
export const PM_HOSTS = Object.freeze(['build-metadata.protomaps.dev', 'build.protomaps.com']);
const UA = 'BlockYard map-extract (self-hosted Bitcoin node monitor)';
const RUN_GAP = 65_536, RUN_MAX = 8 * 1024 * 1024;

// ---------------------------------------------------------------- tile ids (PMTiles v3: zoom offset + Hilbert)
const ZOOM_BASE = [0n];
for (let z = 1; z <= 32; z++) ZOOM_BASE[z] = ZOOM_BASE[z - 1] + (1n << BigInt(2 * (z - 1)));
export function tileId(z, x, y) {
  const n = 1 << z;
  let d = 0n, tx = x, ty = y;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (tx & s) > 0 ? 1 : 0, ry = (ty & s) > 0 ? 1 : 0;
    d += BigInt(s) * BigInt(s) * BigInt((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; } const t = tx; tx = ty; ty = t; }
  }
  return ZOOM_BASE[z] + d;
}
const D2R = Math.PI / 180;
const tileX = (lo, z) => Math.floor(((lo + 180) / 360) * 2 ** z);
const tileY = (la, z) => { const s = Math.sin(la * D2R); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z); };

/** The tiles within radiusKm of a place at zooms 0..maxzoom (those touching the circle's box), and the box. */
export function wantedTiles(lat, lon, radiusKm, maxzoom) {
  const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.max(0.2, Math.cos(lat * D2R)));
  const bbox = { s: Math.max(-85, lat - dLat), n: Math.min(85, lat + dLat), w: Math.max(-180, lon - dLon), e: Math.min(180, lon + dLon) };
  const ids = [];
  for (let z = 0; z <= maxzoom; z++) {
    const n = 2 ** z;
    const x0 = Math.max(0, tileX(bbox.w, z)), x1 = Math.min(n - 1, tileX(bbox.e, z));
    const y0 = Math.max(0, tileY(bbox.n, z)), y1 = Math.min(n - 1, tileY(bbox.s, z));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ids.push(tileId(z, x, y));
  }
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ids, bbox };
}

// ---------------------------------------------------------------- the format
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
export function parseHeader(b) {
  if (b.length < 127 || b.toString('latin1', 0, 7) !== 'PMTiles' || b[7] !== 3) throw new Error('not a PMTiles v3 archive');
  return {
    rootOff: u64(b, 8), rootLen: u64(b, 16), metaOff: u64(b, 24), metaLen: u64(b, 32), leafOff: u64(b, 40), leafLen: u64(b, 48),
    dataOff: u64(b, 56), dataLen: u64(b, 64), addressed: u64(b, 72), entries: u64(b, 80), contents: u64(b, 88),
    clustered: b[96], internalCompression: b[97], tileCompression: b[98], tileType: b[99], minZoom: b[100], maxZoom: b[101],
  };
}
export function readDirectory(b) {
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
/** The inverse: entries [{ id (BigInt), off, len, run }] sorted by id, as the spec's varint columns. */
export function writeDirectory(entries) {
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
const inflate = (b, kind) => (kind === 2 ? gunzipSync(b) : kind === 1 || kind === 0 ? b : (() => { throw new Error(`compression ${kind} is not gzip`); })());
const find = (dir, id) => { let lo = 0, hi = dir.n - 1, at = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dir.ids[m] <= id) { at = m; lo = m + 1; } else hi = m - 1; } return at; };

/** A whole archive from parts, as the extract writes it: header + one root directory + metadata + tile data. */
export function buildArchive({ tiles, meta, maxzoom, bbox, center, tileCompression = 2 }) {
  // tiles: [{ ids: [BigInt], buf }] -- several ids may share one buffer (the planet dedupes identical tiles)
  const entries = [];
  let off = 0;
  const bufs = [];
  for (const t of tiles) {
    bufs.push(t.buf);
    for (const id of [...t.ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) entries.push({ id, off, len: t.buf.length, run: 1 });
    off += t.buf.length;
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const merged = [];
  for (const e of entries) { const p = merged.at(-1); if (p && p.off === e.off && p.len === e.len && p.id + BigInt(p.run) === e.id) p.run++; else merged.push({ ...e }); }
  const rootDir = gzipSync(writeDirectory(merged));
  const metaGz = gzipSync(Buffer.from(JSON.stringify(meta ?? {})));
  const hdr = Buffer.alloc(127);
  hdr.write('PMTiles', 0, 'latin1'); hdr[7] = 3;
  const rootOff = 127, metaOff = rootOff + rootDir.length, leafOff = metaOff + metaGz.length, dataOff = leafOff;
  const w = (o, val) => hdr.writeBigUInt64LE(BigInt(val), o);
  w(8, rootOff); w(16, rootDir.length); w(24, metaOff); w(32, metaGz.length); w(40, leafOff); w(48, 0); w(56, dataOff); w(64, off);
  w(72, entries.length); w(80, merged.length); w(88, tiles.length);
  hdr[96] = 1; hdr[97] = 2; hdr[98] = tileCompression; hdr[99] = 1; hdr[100] = 0; hdr[101] = maxzoom;
  const i32 = (o, val) => hdr.writeInt32LE(Math.round(val * 1e7), o);
  i32(102, bbox.w); i32(106, bbox.s); i32(110, bbox.e); i32(114, bbox.n);
  hdr[118] = Math.min(maxzoom, 11); i32(119, center.lon); i32(123, center.lat);
  return Buffer.concat([hdr, rootDir, metaGz, ...bufs]);
}

/** The newest planet build's key from the index. */
export async function latestBuild(fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(PM_INDEX, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`the build index answered HTTP ${r.status}`);
  const list = await r.json();
  const key = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.key === 'string' && /^\d{8}\.pmtiles$/.test(x.key)).sort((a, b) => a.key.localeCompare(b.key)).at(-1)?.key;
  if (!key) throw new Error('no builds listed');
  return key;
}

/**
 * The extract. `onProgress(p)` is called with { phase, done, total, bytes, tiles, key, estBytes } as it goes; `signal`
 * aborts between requests. Writes `out` atomically (a .part file renamed at the end) and returns the result.
 */
export async function extract({ lat, lon, radiusKm = 60, maxzoom = 15, out, build = null, fetchImpl = globalThis.fetch, onProgress = () => {}, signal = null, dryRun = false, base = PM_BASE }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) throw new Error('not a place on Earth');
  maxzoom = Math.min(15, Math.max(0, Math.round(maxzoom)));   // the route asks for 8-15; the engine takes any (tests use a small planet)
  radiusKm = Math.min(300, Math.max(5, radiusKm));
  const check = () => { if (signal?.aborted) throw new Error('cancelled'); };
  let fetched = 0, requests = 0;
  const range = async (url, off, len) => {
    check();
    const r = await fetchImpl(url, { headers: { 'user-agent': UA, range: `bytes=${off}-${off + len - 1}` }, redirect: 'error', signal: signal ?? undefined });
    if (r.status !== 206) throw new Error(`HTTP ${r.status} for bytes ${off}-${off + len - 1}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== len) throw new Error(`short read: ${buf.length} of ${len}`);
    fetched += buf.length; requests++;
    return buf;
  };
  const progress = (p) => onProgress({ phase: 'directories', done: 0, total: 0, bytes: fetched, tiles: 0, key: build, estBytes: 0, ...p });
  progress({ phase: 'index' });
  const key = build ?? await latestBuild(fetchImpl);
  const url = base + key;
  const { ids: wantedIds, bbox } = wantedTiles(lat, lon, radiusKm, maxzoom);
  progress({ phase: 'directories', key, total: wantedIds.length });
  const head = parseHeader(await range(url, 0, 127));
  if (head.tileType !== 1) throw new Error(`tile type ${head.tileType} is not MVT`);
  const root = readDirectory(inflate(await range(url, head.rootOff, head.rootLen), head.internalCompression));
  const meta = JSON.parse(inflate(await range(url, head.metaOff, head.metaLen), head.internalCompression).toString('utf8'));
  const leafWanted = new Map();
  for (const id of wantedIds) { const i = find(root, id); if (i >= 0 && root.runs[i] === 0) leafWanted.set(root.offs[i], root.lens[i]); }
  const leafCache = new Map();
  for (const [off, len] of [...leafWanted.entries()].sort((a, b) => a[0] - b[0])) leafCache.set(off, readDirectory(inflate(await range(url, head.leafOff + off, len), head.internalCompression)));
  const tiles = new Map();
  let empty = 0;
  for (const id of wantedIds) {
    const i = find(root, id);
    if (i < 0) { empty++; continue; }
    let dir = root, j = i;
    if (root.runs[i] === 0) { dir = leafCache.get(root.offs[i]); j = find(dir, id); if (j < 0) { empty++; continue; } }
    if (!(id < dir.ids[j] + BigInt(dir.runs[j]))) { empty++; continue; }
    const k = `${dir.offs[j]},${dir.lens[j]}`;
    if (!tiles.has(k)) tiles.set(k, { off: dir.offs[j], len: dir.lens[j], ids: [] });
    tiles.get(k).ids.push(id);
  }
  const uniq = [...tiles.values()].sort((a, b) => a.off - b.off);
  const estBytes = uniq.reduce((n, t) => n + t.len, 0);
  const plan = { key, wanted: wantedIds.length, tiles: uniq.length, empty, estBytes, directoryBytes: fetched, requests, bbox };
  progress({ phase: dryRun ? 'planned' : 'tiles', key, total: uniq.length, estBytes });
  if (dryRun) return plan;
  // the tile data in coalesced runs: a clustered archive keeps nearby ids in nearby bytes
  const data = [];
  let i = 0, done = 0;
  while (i < uniq.length) {
    let j = i, end = uniq[i].off + uniq[i].len;
    while (j + 1 < uniq.length && uniq[j + 1].off - end < RUN_GAP && uniq[j + 1].off + uniq[j + 1].len - uniq[i].off <= RUN_MAX) { j++; end = Math.max(end, uniq[j].off + uniq[j].len); }
    const buf = await range(url, head.dataOff + uniq[i].off, end - uniq[i].off);
    for (let k = i; k <= j; k++) { const t = uniq[k]; data.push({ ids: t.ids, buf: buf.subarray(t.off - uniq[i].off, t.off - uniq[i].off + t.len) }); done++; }
    i = j + 1;
    progress({ phase: 'tiles', key, done, total: uniq.length, estBytes, tiles: done });
  }
  const archive = buildArchive({ tiles: data, meta: { ...meta, 'blockyard:extract': { lat, lon, radiusKm, maxzoom, build: key, at: new Date().toISOString() } }, maxzoom, bbox, center: { lat, lon }, tileCompression: head.tileCompression });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(`${out}.part`, archive);
  renameSync(`${out}.part`, out);
  progress({ phase: 'done', key, done, total: uniq.length, estBytes, tiles: done });
  return { ...plan, out, bytes: statSync(out).size, fetched, requests };
}
