// THE COASTLINES THE WEATHER GLOBE DRAWS (operator, 2026-10-13: a zoomable, rotatable globe of the weather round
// the chosen place; "yes to all three" on shipping a coastline file).
//
//   node scripts/coastline-build.mjs <ne_110m_land.geojson> [--out public/geo/land-110m.json]
//
// Input: Natural Earth's 1:110m land polygons as GeoJSON (public domain; naturalearthdata.com, or the geojson/
// directory of github.com/nvkelso/natural-earth-vector). Output: the same 127 polygons as one compact JSON --
// every ring a flat [lon, lat, lon, lat, ...] array of integers in HUNDREDTHS of a degree (1:110m is drawn for a
// whole-globe map; a hundredth of a degree is ~1 km, far below what it resolves), holes kept after their outer
// ring. 138 KB of GeoJSON becomes ~45 KB, ~14 KB gzipped. The file is DATA shipped with the code, like
// config/pool-map.json: no code from Natural Earth, nothing fetched at run time.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'public/geo/land-110m.json';
if (!src) { console.error('usage: node scripts/coastline-build.mjs <ne_110m_land.geojson> [--out file]'); process.exit(2); }

const j = JSON.parse(readFileSync(src, 'utf8'));
const polys = [];
let points = 0;
for (const f of j.features ?? []) {
  const g = f.geometry;
  const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of list) {
    // each polygon: [outerRing, hole, hole, ...]; a ring is closed in GeoJSON (last point = first), which the
    // drawer closes itself, so the repeat is dropped
    const rings = poly.map((ring) => {
      const flat = [];
      const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
      for (const [lon, lat] of pts) flat.push(Math.round(lon * 100), Math.round(lat * 100));
      points += pts.length;
      return flat;
    }).filter((r) => r.length >= 6);
    if (rings.length) polys.push(rings);
  }
}
const data = { source: 'Natural Earth 1:110m land (public domain)', scale: 100, polygons: polys };
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
console.log(`${polys.length} polygons, ${points} points -> ${out} (${readFileSync(out).length} bytes)`);
