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

/** Find the archive: cfg.weather.mapFile, else the newest *.pmtiles under <dataDir>/map. Null where there is none. */
export async function findMapFile(cfg) {
  const named = cfg?.weather?.mapFile;
  if (named) return path.resolve(named);
  const dir = path.join(cfg?.store?.dir ?? cfg?.auth?.dataDir ?? 'data', 'map');
  let names;
  try { names = (await fsp.readdir(dir)).filter((n) => /^[A-Za-z0-9_.-]+\.pmtiles$/.test(n)); } catch { return null; }
  if (!names.length) return null;
  const stats = await Promise.all(names.map(async (n) => [n, (await fsp.stat(path.join(dir, n))).mtimeMs]));
  return path.join(dir, stats.sort((a, b) => b[1] - a[1])[0][0]);
}

/** The server's archive, opened lazily and re-opened when the file changes (a new extract replaces the old). */
export async function mapArchive(app) {
  const file = await findMapFile(app.cfg);
  if (!file) { if (app.mapArchive) { await app.mapArchive.close(); app.mapArchive = null; } return null; }
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (app.mapArchive && app.mapArchive.file === file && app.mapArchive.mtimeMs === st.mtimeMs) return app.mapArchive;
  if (app.mapArchive) await app.mapArchive.close();
  try {
    app.mapArchive = await new MapArchive(file).open();
    app.mapArchive.mtimeMs = st.mtimeMs;
    app.log?.({ level: 'info', msg: `street map: ${path.basename(file)} (${(st.size / 1e6).toFixed(0)} MB, ${app.mapArchive.head.tiles} tiles to zoom ${app.mapArchive.head.maxZoom})` });
  } catch (e) {
    app.log?.({ level: 'warn', msg: `street map: ${file} could not be opened: ${e?.message ?? e}` });
    app.mapArchive = null;
  }
  return app.mapArchive;
}

export async function serveVectorTile(req, res, urlPath, app, { tls = false, hstsMs = 0 } = {}) {
  const m = VTILE_PATH.exec(urlPath);
  if (!m) return null;
  const headers = { ...securityHeaders({ tls, hstsMs }), 'Cache-Control': 'no-store' };
  const text = (status, body) => { res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : body); return { status }; };
  if (!app.weather) return text(404, 'weather is off on this server');
  if (!(await weatherOn(app))) return text(403, 'the weather switch is off in Display settings');
  const arc = await mapArchive(app);
  if (!arc) return text(404, 'no street map on this server: make one with scripts/map-extract.mjs');
  let buf;
  try { buf = await arc.tile(Number(m[1]), Number(m[2]), Number(m[3])); } catch (e) { return text(500, `the tile could not be read: ${String(e?.message ?? e)}`); }
  if (!buf) { res.writeHead(204, { ...headers, 'Cache-Control': 'private, max-age=3600' }); res.end(); return { status: 204 }; }
  res.writeHead(200, { ...headers, 'Content-Type': 'application/vnd.mapbox-vector-tile', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
  res.end(req.method === 'HEAD' ? undefined : buf);
  return { status: 200 };
}
