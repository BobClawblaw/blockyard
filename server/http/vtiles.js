// THE STREET MAP'S TILES, FROM A FILE OF YOUR OWN (docs/PLAN-WEATHER-GLOBE.md, part B). scripts/map-extract.mjs
// writes a PMTiles archive of the OpenStreetMap-derived vector tiles round the place; this reads it -- the 127-byte
// header, the gzip-compressed root directory of [tileId, offset, length, runLength] entries, tiles on a Hilbert curve
// per zoom -- and serves one tile at a time, gunzipped, at /weather/vtile/<z>/<x>/<y>.mvt. Shaped like the radar tiles
// (http/weathertiles.js): a branch before the route table, behind the session when accounts are on, rate-limited.
// Nothing is contacted: the file is on disk, chosen as weather.mapFile in config/local.json or found in data/map/.
// Data (c) OpenStreetMap contributors, ODbL: /api/weather/map carries the attribution and the map draws it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { securityHeaders } from './static.js';
import { weatherOn } from './api.js';

export const VTILE_PATH = /^\/weather\/vtile\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.mvt$/;

import { tileId, parseHeader as baseHeader, readDirectory } from '../collect/pmextract.js';
export { tileId };
export const parseDirectory = readDirectory;
/** The engine's header plus what the server shows: the bounds, the centre, and `tiles` (the spec's "tile contents"). */
export function parseHeader(b) {
  const h = baseHeader(b);
  const i32 = (o) => b.readInt32LE(o) / 1e7;
  return { ...h, tiles: h.contents, bounds: { w: i32(102), s: i32(106), e: i32(110), n: i32(114) }, centerZoom: b[118], center: { lon: i32(119), lat: i32(123) } };
}
const inflate = (b, kind) => (kind === 2 ? gunzipSync(b) : kind === 1 || kind === 0 ? b : (() => { throw new Error(`compression ${kind} is not gzip`); })());

/** One archive: opened once, its directory in memory, each tile a positional read. */
export class MapArchive {
  constructor(file) { this.file = file; this.fd = null; this.head = null; this.dir = null; this.meta = null; }
  async open() {
    this.fd = await fsp.open(this.file, 'r');
    const hb = Buffer.alloc(127);
    await this.fd.read(hb, 0, 127, 0);
    this.head = parseHeader(hb);
    const h = this.head;
    if (h.tileType !== 1) throw new Error(`${this.file}: tile type ${h.tileType} is not MVT`);
    if (h.leafLen > 0) throw new Error(`${this.file}: leaf directories are not read here; make the file with scripts/map-extract.mjs`);
    const rb = Buffer.alloc(h.rootLen);
    await this.fd.read(rb, 0, h.rootLen, h.rootOff);
    this.dir = parseDirectory(inflate(rb, h.internalCompression));
    const mb = Buffer.alloc(h.metaLen);
    await this.fd.read(mb, 0, h.metaLen, h.metaOff);
    try { this.meta = JSON.parse(inflate(mb, h.internalCompression).toString('utf8')); } catch { this.meta = {}; }
    this.size = (await this.fd.stat()).size;
    return this;
  }
  async close() { await this.fd?.close(); this.fd = null; }
  /** The tile's bytes, inflated, or null where the archive has none (outside the extract, or an empty tile). */
  async tile(z, x, y) {
    const h = this.head, d = this.dir;
    if (z < h.minZoom || z > h.maxZoom || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
    const id = tileId(z, x, y);
    let lo = 0, hi = d.n - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (d.ids[m] <= id) { at = m; lo = m + 1; } else hi = m - 1; }
    if (at < 0 || !(id < d.ids[at] + BigInt(d.runs[at])) || d.runs[at] === 0) return null;
    const buf = Buffer.alloc(d.lens[at]);
    await this.fd.read(buf, 0, d.lens[at], h.dataOff + d.offs[at]);
    return inflate(buf, h.tileCompression);
  }
  view() {
    const h = this.head;
    return { file: path.basename(this.file), bytes: this.size, tiles: h.tiles, minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: h.bounds, center: h.center, attribution: this.meta?.attribution ?? '© OpenStreetMap contributors', source: this.meta?.name ?? 'Protomaps Basemap', osmTime: this.meta?.['planetiler:osm:osmosisreplicationtime'] ?? null };
  }
}

/** The archive files: cfg.weather.mapFile (one) plus every *.pmtiles under <dataDir>/map. */
export async function listMapFiles(cfg) {
  const out = [];
  if (cfg?.weather?.mapFile) out.push(path.resolve(cfg.weather.mapFile));
  const dir = path.join(cfg?.store?.dir ?? cfg?.auth?.dataDir ?? 'data', 'map');
  try { for (const n of await fsp.readdir(dir)) if (/^[A-Za-z0-9_.-]+\.pmtiles$/.test(n)) out.push(path.join(dir, n)); } catch { /* no directory yet */ }
  return [...new Set(out)];
}
/** The newest of them, for callers that want one file (the tests, the first cut). */
export async function findMapFile(cfg) {
  if (cfg?.weather?.mapFile) return path.resolve(cfg.weather.mapFile);   // a named file wins outright
  const files = await listMapFiles(cfg);
  if (!files.length) return null;
  const stats = await Promise.all(files.map(async (f) => { try { return [f, (await fsp.stat(f)).mtimeMs]; } catch { return [f, 0]; } }));
  return stats.sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * SEVERAL EXTRACTS AT ONCE (operator, 2026-10-13: "grab the road data for the current view ... a refresh view button"):
 * every archive in data/map/ is open, and a tile comes from whichever covers it -- the one with the deepest zoom
 * first, then the newest. The set is re-read when the directory changes (a build just finished, a file removed).
 */
export class MapSet {
  constructor() { this.archives = new Map(); this.scannedAt = 0; this.sig = ''; }
  async refresh(cfg, log) {
    const files = await listMapFiles(cfg);
    const stats = [];
    for (const f of files) { try { const st = fs.statSync(f); stats.push([f, st.mtimeMs, st.size]); } catch { /* gone between listing and stat */ } }
    const sig = stats.map((x) => x.join(':')).join('|');
    this.scannedAt = Date.now();
    if (sig === this.sig) return this;
    this.sig = sig;
    for (const [f, arc] of this.archives) if (!stats.some((x) => x[0] === f && x[1] === arc.mtimeMs)) { await arc.close(); this.archives.delete(f); }
    for (const [f, mtimeMs, size] of stats) {
      if (this.archives.has(f)) continue;
      try {
        const arc = await new MapArchive(f).open();
        arc.mtimeMs = mtimeMs;
        this.archives.set(f, arc);
        log?.({ level: 'info', msg: `street map: ${path.basename(f)} (${(size / 1e6).toFixed(0)} MB, ${arc.head.tiles} tiles to zoom ${arc.head.maxZoom})` });
      } catch (e) { log?.({ level: 'warn', msg: `street map: ${f} could not be opened: ${e?.message ?? e}` }); }
    }
    return this;
  }
  get size() { return this.archives.size; }
  /** The archives that could hold a point, deepest zoom first, then newest. */
  covering(lat, lon, z = 0) {
    return [...this.archives.values()].filter((a) => { const b = a.head.bounds; return lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e && a.head.maxZoom >= Math.min(z, a.head.maxZoom); })
      .sort((a, b) => b.head.maxZoom - a.head.maxZoom || b.mtimeMs - a.mtimeMs);
  }
  async tile(z, x, y) {
    // the archives whose bounds MEET the tile's box (a small extract holds the big low-zoom tiles over it too), the
    // deepest first, then the newest
    const n = 2 ** z;
    const latOf = (yy) => Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * (180 / Math.PI);
    const w = (x / n) * 360 - 180, e = ((x + 1) / n) * 360 - 180, nn = latOf(y), ss = latOf(y + 1);
    const list = [...this.archives.values()].filter((a) => { const b = a.head.bounds; return z <= a.head.maxZoom && e >= b.w && w <= b.e && nn >= b.s && ss <= b.n; })
      .sort((a, b) => b.head.maxZoom - a.head.maxZoom || b.mtimeMs - a.mtimeMs);
    for (const a of list) { const t = await a.tile(z, x, y); if (t) return t; }
    return null;
  }
  views() { return [...this.archives.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).map((a) => ({ ...a.view(), extract: a.meta?.['blockyard:extract'] ?? null })); }
}
/** The server's set, re-scanned at most every 5 s (and at once when a build finished since the last scan). */
export async function mapSet(app) {
  if (!app.mapSet) app.mapSet = new MapSet();
  const built = app.mapBuilder?.state?.finishedAt ?? 0;
  if (Date.now() - app.mapSet.scannedAt > 5000 || built > app.mapSet.scannedAt) await app.mapSet.refresh(app.cfg, app.log);
  return app.mapSet;
}
/** One archive: the newest, kept for callers written against a single file. */
export async function mapArchive(app) {
  const set = await mapSet(app);
  return set.views().length ? set.archives.get([...set.archives.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)[0].file) : null;
}

export async function serveVectorTile(req, res, urlPath, app, { tls = false, hstsMs = 0 } = {}) {
  const m = VTILE_PATH.exec(urlPath);
  if (!m) return null;
  const headers = { ...securityHeaders({ tls, hstsMs }), 'Cache-Control': 'no-store' };
  const text = (status, body) => { res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : body); return { status }; };
  if (!app.weather) return text(404, 'weather is off on this server');
  if (!(await weatherOn(app))) return text(403, 'the weather switch is off in Display settings');
  const set = await mapSet(app);
  if (!set.size) return text(404, 'no street map on this server: build one under Display settings → Weather, or with scripts/map-extract.mjs');
  let buf;
  try { buf = await set.tile(Number(m[1]), Number(m[2]), Number(m[3])); } catch (e) { return text(500, `the tile could not be read: ${String(e?.message ?? e)}`); }
  if (!buf) { res.writeHead(204, { ...headers, 'Cache-Control': 'private, max-age=3600' }); res.end(); return { status: 204 }; }
  res.writeHead(200, { ...headers, 'Content-Type': 'application/vnd.mapbox-vector-tile', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
  res.end(req.method === 'HEAD' ? undefined : buf);
  return { status: 200 };
}
