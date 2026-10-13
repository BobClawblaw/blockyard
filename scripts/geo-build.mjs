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
//   features-10m.json { scale, roads: { major, secondary, minor }, rails, rivers, urban }       each a list of flat lines (urban: rings);
//                    a line's FIRST number is its Natural Earth scalerank, the coordinates follow -- roads are 1:10m
//                    motorways and highways (not streets: Natural Earth stops at major roads), rails to rank 6, rivers and
//                    lake centrelines, and the built-up urban footprint (10m areas of 5 km2 and up, the rest from 50m)
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
// THE FEATURES (operator, 2026-10-13: "no roads or other data available for maps?"): what Natural Earth has below the
// coastline. Ranked lines carry their scalerank first so the map can open the detail up as it zooms. Two economies,
// because the raw lines were 1.46 M points and 14.5 MB of JSON: Douglas-Peucker at 0.008 degrees (~900 m: under what
// 1:10m resolves and under a pixel at the zooms these draw at), and DELTA coordinates -- after the first point each
// number is the step from the last, mostly one or two digits (weathermap.js `undelta` expands them).
const dp = (pts, tol) => {
  if (pts.length <= 2) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, at + 1), tol).slice(0, -1), ...dp(pts.slice(at), tol)];
};
const SIMPLIFY = 0.008;
const enc = (coords, closed = false) => {
  const pts = coords.length > 1 && closed && coords[0][0] === coords.at(-1)[0] && coords[0][1] === coords.at(-1)[1] ? coords.slice(0, -1) : coords;
  const simple = dp(pts.map(([x, y]) => [x, y]), SIMPLIFY);
  const out = [];
  let lx = 0, ly = 0;
  for (const [lon, lat] of simple) {
    const x = Math.round(lon * K), y = Math.round(lat * K);
    if (out.length && x === lx && y === ly) continue;
    out.push(x - lx, y - ly); lx = x; ly = y;
  }
  return out;
};
const ranked = (j, keep) => {
  const ls = [];
  for (const f of j.features ?? []) {
    const g = f.geometry; if (!g) continue;
    const p = f.properties ?? {};
    if (!keep(p)) continue;
    const rank = Math.min(12, Math.max(0, Number(p.scalerank) || 0));
    const list = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const l of list) { const r = enc(l); if (r.length >= 4) { ls.push([rank, ...r]); points += r.length / 2; } }
  }
  return ls;
};
const rings = (j, keep) => {
  const out = [];
  for (const f of j.features ?? []) {
    const g = f.geometry; if (!g || !keep(f.properties ?? {})) continue;
    const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of list) { const r = enc(poly[0], true); if (r.length >= 8) { out.push(r); points += r.length / 2; } }
  }
  return out;
};
const roads = load('ne_10m_roads');
const rt = (p) => String(p.type ?? '');
const features = {
  source: 'Natural Earth 1:10m roads, railroads, rivers and lake centerlines, urban areas; 1:50m urban areas (public domain)',
  scale: K,
  roads: {
    major: ranked(roads, (p) => /Major Highway|Beltway/.test(rt(p)) && rt(p) !== 'Ferry Route'),
    secondary: ranked(roads, (p) => rt(p) === 'Secondary Highway'),
    minor: ranked(roads, (p) => (rt(p) === 'Road' || rt(p) === 'Unknown') && (Number(p.scalerank) || 99) <= 7),
  },
  rails: ranked(load('ne_10m_railroads'), (p) => (Number(p.scalerank) || 99) <= 5),
  rivers: ranked(load('ne_10m_rivers_lake_centerlines'), () => true),
  // urban: the 10m footprints of 10 km2 and up -- a town's built-up area, which is what makes a local map read as a place
  urban: rings(load('ne_10m_urban_areas'), (p) => (Number(p.area_sqkm) || 0) >= 10),
};
writeFileSync(path.join(out, 'features-10m.json'), JSON.stringify(features));
for (const f of ['land-50m.json', 'lines-50m.json', 'places-10m.json', 'features-10m.json']) console.log(f, readFileSync(path.join(out, f)).length, 'bytes');
console.log(`roads ${features.roads.major.length}/${features.roads.secondary.length}/${features.roads.minor.length}, rails ${features.rails.length}, rivers ${features.rivers.length}, urban ${features.urban.length}`);
console.log(`${land.polygons.length} land polygons, ${land.water.length} lakes, ${ln.borders.length} border lines, ${ln.states.length} state lines, ${pl.length} places; ${points} points`);
