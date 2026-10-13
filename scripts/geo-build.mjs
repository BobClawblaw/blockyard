// THE GEOGRAPHY THE WEATHER MAP DRAWS (operator, 2026-10-13: "yes to all three" on shipping a coastline file; then, of
// the first globe, "no country, state, borders or names ... No globe detail at all").
//
//   node scripts/geo-build.mjs <dir> [--out public/geo]
//
// <dir> holds Natural Earth's GeoJSON (public domain; naturalearthdata.com, or the geojson/ directory of
// github.com/nvkelso/natural-earth-vector): ne_50m_land, ne_50m_lakes, ne_50m_admin_0_boundary_lines_land,
// ne_50m_admin_1_states_provinces_lines and ne_10m_populated_places_simple. Output, three compact JSON files:
//   land-50m.json    { scale, polygons: [[outerRing, hole, ...], ...], water: [[ring], ...] }   rings flat [lon, lat, ...]
//   lines-50m.json   { scale, borders: [[lon, lat, ...], ...], states: [[...], ...] }           country and state/province lines
//   places-10m.json  { places: [[name, lat, lon, population, rank], ...] }                      ~7,300 towns, rank 0 (a capital) to 10
// Coordinates are integers in HUNDREDTHS of a degree (~1 km): 1:50m resolves nothing finer. The files are DATA shipped
// with the code, like config/pool-map.json: no code from Natural Earth, nothing fetched at run time.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'public/geo';
if (!dir) { console.error('usage: node scripts/geo-build.mjs <dir of Natural Earth geojson> [--out public/geo]'); process.exit(2); }
const load = (name) => JSON.parse(readFileSync(path.join(dir, `${name}.geojson`), 'utf8'));
const K = 100;
const flat = (ring) => {
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
  const o = [];
  let lx = null, ly = null;
  for (const [lon, lat] of pts) {
    const x = Math.round(lon * K), y = Math.round(lat * K);
    if (x === lx && y === ly) continue;      // a point that rounds onto the last says nothing
    o.push(x, y); lx = x; ly = y;
  }
  return o;
};
let points = 0;
const polygons = (j) => {
  const polys = [];
  for (const f of j.features ?? []) {
    const g = f.geometry;
    const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of list) {
      const rings = poly.map(flat).filter((r) => r.length >= 6);
      if (rings.length) { polys.push(rings); for (const r of rings) points += r.length / 2; }
    }
  }
  return polys;
};
const lines = (j) => {
  const ls = [];
  for (const f of j.features ?? []) {
    const g = f.geometry;
    const list = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const l of list) { const r = flat(l); if (r.length >= 4) { ls.push(r); points += r.length / 2; } }
  }
  return ls;
};

mkdirSync(out, { recursive: true });
const land = { source: 'Natural Earth 1:50m land and lakes (public domain)', scale: K, polygons: polygons(load('ne_50m_land')), water: polygons(load('ne_50m_lakes')).map((p) => p[0]) };
writeFileSync(path.join(out, 'land-50m.json'), JSON.stringify(land));
const ln = { source: 'Natural Earth 1:50m admin-0 boundary lines and admin-1 states/provinces lines (public domain)', scale: K, borders: lines(load('ne_50m_admin_0_boundary_lines_land')), states: lines(load('ne_50m_admin_1_states_provinces_lines')) };
writeFileSync(path.join(out, 'lines-50m.json'), JSON.stringify(ln));
const pl = load('ne_10m_populated_places_simple').features.map((f) => {
  const p = f.properties, [lon, lat] = f.geometry.coordinates;
  return [String(p.name ?? p.nameascii ?? '').slice(0, 40), Math.round(lat * K), Math.round(lon * K), Math.max(0, Math.round(Number(p.pop_max) || 0)), Math.min(10, Math.max(0, Number(p.scalerank) || 0))];
}).filter((x) => x[0]).sort((a, b) => a[4] - b[4] || b[3] - a[3]);
writeFileSync(path.join(out, 'places-10m.json'), JSON.stringify({ source: 'Natural Earth 1:10m populated places (public domain)', scale: K, places: pl }));
for (const f of ['land-50m.json', 'lines-50m.json', 'places-10m.json']) console.log(f, readFileSync(path.join(out, f)).length, 'bytes');
console.log(`${land.polygons.length} land polygons, ${land.water.length} lakes, ${ln.borders.length} border lines, ${ln.states.length} state lines, ${pl.length} places; ${points} points`);
