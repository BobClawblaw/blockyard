// A STREET MAP OF YOUR OWN PLACE, FROM THE COMMAND LINE (the same engine as Display settings → Weather → Build street
// map: server/collect/pmextract.js; docs/PLAN-WEATHER-GLOBE.md, part B).
//
//   node scripts/map-extract.mjs --lat 52.52 --lon 13.41 [--radius-km 60] [--maxzoom 15] [--out data/map/place.pmtiles]
//                                [--build 20261013.pmtiles] [--dry-run]
//
// Cuts the OpenStreetMap vector tiles within --radius-km of the place out of Protomaps' planet archive
// (build.protomaps.com, ~139 GB, HTTP range requests; no account, no key) and writes them as a small PMTiles file the
// monitor then reads from disk (server/http/vtiles.js) -- nothing contacted afterwards. Data (c) OpenStreetMap
// contributors, ODbL. Measured 2026-10-13: Berlin, 60 km, zoom 15: 35,480 tiles, 193 MB, about a minute; a 60 km
// suburban extract in the United States, 18,469 tiles, 149 MB.
import path from 'node:path';
import { extract } from '../server/collect/pmextract.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const lat = Number(arg('--lat')), lon = Number(arg('--lon'));
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error('usage: node scripts/map-extract.mjs --lat <lat> --lon <lon> [--radius-km 60] [--maxzoom 15] [--out file] [--build key] [--dry-run]');
  process.exit(2);
}
const out = path.resolve(arg('--out', path.join('data', 'map', `${lat.toFixed(2)}_${lon.toFixed(2)}.pmtiles`)));
let lastLine = '';
const t0 = Date.now();
try {
  const r = await extract({
    lat, lon, radiusKm: Number(arg('--radius-km', 60)), maxzoom: Number(arg('--maxzoom', 15)), out, build: arg('--build', null), dryRun: args.includes('--dry-run'),
    onProgress: (p) => {
      const line = p.phase === 'tiles' ? `${p.done}/${p.total} tiles, ${(p.bytes / 1e6).toFixed(0)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s` : `${p.phase}${p.key ? ` (${p.key})` : ''}${p.total ? `: ${p.total} tiles` : ''}${p.estBytes ? `, ${(p.estBytes / 1e6).toFixed(1)} MB to fetch` : ''}`;
      if (line !== lastLine) { process.stdout.write(`\r${line}   `); lastLine = line; }
    },
  });
  process.stdout.write('\n');
  if (!r.out) console.log(`dry run: ${r.tiles} distinct tiles (${r.empty} wanted ids are empty), ${(r.estBytes / 1e6).toFixed(1)} MB to fetch from ${r.key}; nothing written`);
  else console.log(`wrote ${r.out}: ${(r.bytes / 1e6).toFixed(1)} MB, ${r.tiles} tiles, from ${r.key} (${r.requests} requests, ${(r.fetched / 1e6).toFixed(0)} MB fetched)\ndata (c) OpenStreetMap contributors (ODbL), tiles by Protomaps; leave it in data/map/ to be found, or name it as weather.mapFile`);
} catch (e) {
  process.stdout.write('\n');
  console.error(`map-extract: ${e?.message ?? e}`);
  process.exit(1);
}
