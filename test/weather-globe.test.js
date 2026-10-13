// THE WEATHER GLOBE (docs/PLAN-WEATHER-GLOBE.md): the pure maths (weathermap.js), the shipped coastline file, the
// feed's radar proxy and forecast grid with their refresh floor and cap, and the tile route -- no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tileX, tileY, tileLon, tileLat, mercatorToEquirect, rasterLand, paintBase, composite, viewOf, sphereRadius, isFlat, dragView, zoomView,
  orthoRender, orthoProject, flatView, flatTiles, flatProject, flatUnproject, gridSampler, paintGrid, rainColour, windPoints, wrapLon, FLAT_FROM,
  homeView, zoomForTileZ, HOME_TILE_Z, metresPerPixel, scaleBar, ringRadii, cutWater, rasterLines, rankCeiling, placeLabels, undelta, expandFeatures, featureLevels,
} from '../public/js/weathermap.js';
import { WeatherFeed, gridPoints, gridUrl, parseGrid, parseRadarList, RADAR_HOSTS, REFRESH_FLOOR_MS, REFRESH_PER_HOUR_MAX, GRID_MIN_MS, GRID_N, GRID_STEPS, gridSpanOf, TILE_ZOOM_MAX } from '../server/collect/weather.js';
import { serveWeatherTile, TILE_PATH } from '../server/http/weathertiles.js';
import { routes, weatherRefreshMs } from '../server/http/api.js';
import { DEFAULTS, PANEL, normalise } from '../public/js/settings.js';

const root = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'by-globe-')), 'blockyard.json');
const okReply = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const okBytes = (buf) => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-length' ? String(buf.length) : null) }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });

test('web mercator: tile maths round-trip, and the poles are cut at 85 degrees', () => {
  assert.equal(tileX(-180, 3), 0); assert.equal(tileX(180, 3), 8);
  assert.ok(Math.abs(tileLon(tileX(13.41, 5), 5) - 13.41) < 1e-9);
  assert.ok(Math.abs(tileLat(tileY(52.52, 5), 5) - 52.52) < 1e-9);
  assert.ok(Math.abs(tileY(0, 1) - 1) < 1e-12, 'the equator is the middle');
  assert.equal(tileY(89, 2), tileY(85.0511, 2), 'clamped');
  assert.equal(wrapLon(190), -170); assert.equal(wrapLon(-181), 179);
});

test('a mercator raster resampled to equirect keeps columns and moves rows', () => {
  const size = 512, src = new Uint8ClampedArray(size * size * 4);
  // a band round the equator (rows 248-263) red, the rest blue
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = (y * size + x) * 4; const eq = y >= 248 && y < 264; src[o] = eq ? 255 : 0; src[o + 2] = eq ? 0 : 255; src[o + 3] = 255; }
  const W = 128, H = 64, dst = new Uint8ClampedArray(W * H * 4);
  mercatorToEquirect(src, size, dst, W, H);
  const at = (x, y) => dst[(y * W + x) * 4];
  assert.equal(at(10, 32), 255, 'the equator lands on the equirect middle row');
  assert.equal(at(10, 10), 0);
  assert.equal(dst[(0 * W + 5) * 4 + 3], 0, 'rows above 85 degrees are left as they were (transparent)');
});

test('the shipped geography: 1:50m land and lakes rasterise (Berlin land, the Atlantic sea, the Caspian and Superior water), borders and names load', () => {
  const data = JSON.parse(read('public/geo/land-50m.json'));
  assert.equal(data.scale, 100);
  assert.ok(data.polygons.length >= 1000 && data.polygons.length <= 2000, `${data.polygons.length} land polygons`);
  assert.ok(data.water.length >= 300, `${data.water.length} lakes`);
  const W = 1024, H = 512, mask = cutWater(rasterLand(data, W, H), data, W, H);
  const at = (lat, lon) => mask[Math.floor(((90 - lat) / 180) * H) * W + Math.floor(((lon + 180) / 360) * W)];
  assert.equal(at(52.5, 13.4), 1, 'Berlin'); assert.equal(at(30, -40), 0, 'the Atlantic'); assert.equal(at(42, 50), 0, 'the Caspian (a hole)');
  assert.equal(at(-19, 47), 1, 'Madagascar'); assert.equal(at(-80, 0), 1, 'Antarctica'); assert.equal(at(0, -160), 0, 'the Pacific');
  assert.equal(at(47.5, -87.5), 0, 'Lake Superior is water (cut from the land)');
  const share = mask.reduce((a, b) => a + b, 0) / mask.length;
  assert.ok(share > 0.28 && share < 0.4, `about a third of the equirect picture is land (${share.toFixed(3)})`);
  const pic = paintBase(mask, W, H, new Uint8ClampedArray(W * H * 4));
  const over = new Uint8ClampedArray(W * H * 4); over[3] = 255; over[0] = 255;
  const out = composite(pic, over, new Uint8ClampedArray(W * H * 4), 0.5);
  assert.equal(out[3], 255); assert.ok(out[0] > pic[0], 'the overlay shows through at half strength');
  assert.equal(out[4], pic[4], 'a transparent overlay pixel is the base');
  // the lines: the US-Canada border runs along the 49th parallel; drawn into the picture it lights those pixels
  const lines = JSON.parse(read('public/geo/lines-50m.json'));
  assert.ok(lines.borders.length >= 300 && lines.states.length >= 500, `${lines.borders.length} borders, ${lines.states.length} state lines`);
  const before = pic.slice();
  rasterLines(lines.borders, lines.scale, W, H, pic, [255, 255, 255, 255]);
  const col = Math.floor(((-110 + 180) / 360) * W), row = Math.round(((90 - 49) / 180) * H);
  const lit = [row - 1, row, row + 1].some((y) => pic[(y * W + col) * 4] === 255 && before[(y * W + col) * 4] < 255);
  assert.ok(lit, 'the 49th parallel at 110 W is a border pixel');
  const nowhere = (Math.floor(((90 - 30) / 180) * H) * W + Math.floor(((-40 + 180) / 360) * W)) * 4;
  assert.equal(pic[nowhere], before[nowhere], 'mid-Atlantic untouched');
  // the names: sorted by rank then population, Berlin and small towns both present
  const places = JSON.parse(read('public/geo/places-10m.json')).places;
  assert.ok(places.length >= 7000, `${places.length} places`);
  assert.ok(places.every((p) => typeof p[0] === 'string' && Number.isInteger(p[1]) && Number.isInteger(p[2]) && p[4] >= 0 && p[4] <= 10));
  const berlin = places.find((p) => p[0] === 'Berlin' && Math.abs(p[1] - 5252) < 20);
  assert.ok(berlin && berlin[3] > 3_000_000, 'Berlin, with its population');
  assert.ok(places.filter((p) => p[4] >= 7).length > 3000, 'and thousands of small towns (rank 7 and up) for the local view');
  for (let i = 1; i < places.length; i++) assert.ok(places[i][4] >= places[i - 1][4], 'rank ascending');
  assert.ok(fs.statSync(new URL('public/geo/land-50m.json', root)).size + fs.statSync(new URL('public/geo/lines-50m.json', root)).size + fs.statSync(new URL('public/geo/places-10m.json', root)).size < 1_600_000, 'under 1.6 MB together (the features file is its own 2.9 MB, loaded last)');
  // which names at which zoom, and a greedy layout without overlaps
  assert.equal(rankCeiling(1), 1); assert.equal(rankCeiling(5), 5); assert.equal(rankCeiling(11), 10);
  const kept = placeLabels([{ x: 10, y: 10, w: 40, h: 12 }, { x: 20, y: 12, w: 40, h: 12 }, { x: 100, y: 10, w: 40, h: 12 }, { x: -200, y: 0, w: 40, h: 12 }], 300, 200);
  assert.equal(kept.length, 2, 'the overlapping second and the off-panel fourth are dropped');
});

test('the features file: roads, rails, rivers and urban areas, delta-encoded and simplified, under 3 MB', () => {
  // operator, 2026-10-13: "no roads or other data available for maps?" -- Natural Earth's 1:10m roads are motorways
  // and main roads (never streets); 1.46 M raw points became 572 k by Douglas-Peucker at ~900 m, 14.5 MB became 2.9
  const f = JSON.parse(read('public/geo/features-10m.json'));
  assert.equal(f.scale, 100);
  assert.ok(f.roads.major.length > 8000 && f.roads.secondary.length > 8000 && f.roads.minor.length > 15000, 'the road classes');
  assert.ok(f.rails.length > 3000 && f.rivers.length > 2000 && f.urban.length > 10000);
  assert.ok(fs.statSync(new URL('public/geo/features-10m.json', root)).size < 3_000_000, 'under 3 MB');
  const l = undelta(f.roads.major[0]);
  assert.ok(l.pts.length >= 4 && l.minX <= l.maxX && Math.abs(l.pts[0]) <= 18000 && Math.abs(l.pts[1]) <= 9000, 'absolute coordinates again, on Earth');
  const steps = f.roads.major.slice(0, 200).flatMap((x) => x.slice(3)).map(Math.abs);
  assert.ok(steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] < 40, 'a step is a few hundredths of a degree: the deltas are small');
  assert.deepEqual(undelta([3, 100, 200, 5, -5, 5, 0]), { rank: 3, pts: [100, 200, 105, 195, 110, 195], minX: 100, minY: 195, maxX: 110, maxY: 200 });
  assert.deepEqual(undelta([10, 10, 1, 1], false).pts, [10, 10, 11, 11], 'an urban ring has no rank');
  const X = expandFeatures({ scale: 100, roads: { major: [[1, 0, 0, 1, 1]], secondary: [], minor: [] }, rails: [], rivers: [[2, 5, 5, 1, 0]], urban: [[0, 0, 1, 0, 1, 1]] });
  assert.equal(X.roads.major[0].rank, 1); assert.equal(X.urban[0].pts.length, 6);
  // a motorway through Berlin is in the file: a major line passing within a hundredth of a degree of 52.5, 13.4
  const near = f.roads.major.map((x) => undelta(x)).some((r) => r.minX <= 1400 && r.maxX >= 1300 && r.minY <= 5300 && r.maxY >= 5200);
  assert.ok(near, 'a major road crosses the Berlin box');
  const lv = featureLevels(11);
  assert.ok(lv.urban && lv.major === 12 && lv.minor === 12 && lv.rails === 12, 'everything close in');
  assert.ok(!featureLevels(3).urban && featureLevels(3).major === -1, 'nothing at globe scale');
  assert.equal(featureLevels(8).minor, 6, 'minor roads open up by rank');
});

test('the globe: a view turns and zooms within bounds, the place projects to the middle, the far side is hidden', () => {
  const v = viewOf(52.5, 13.4, 1.6);
  const pw = 600, ph = 400;
  const q = orthoProject(52.5, 13.4, pw, ph, v);
  assert.ok(Math.abs(q.x - 300) < 1e-9 && Math.abs(q.y - 200) < 1e-9, 'the view’s centre is the panel’s middle');
  assert.equal(orthoProject(-52.5, -166.6, pw, ph, v), null, 'the antipode is behind the globe');
  const turned = dragView(v, 40, 0, pw, ph);
  assert.ok(turned.lon < v.lon, 'dragging right turns the globe so the surface follows the pointer');
  assert.equal(viewOf(95, 0).lat, 89); assert.equal(viewOf(0, 0, 1e6).zoom, 4096); assert.equal(viewOf(0, 0, 0.1).zoom, 0.6);
  assert.equal(zoomView(v, 2).zoom, 3.2);
  assert.equal(isFlat(viewOf(0, 0, 1), pw, ph), false);
  assert.equal(isFlat(viewOf(0, 0, 8), pw, ph), true);
  assert.ok(FLAT_FROM > 2);
  // render a tiny globe: inside the disc is opaque and lit, the corners are transparent, the rim has an atmosphere
  const W = 64, H = 32, pic = new Uint8ClampedArray(W * H * 4).fill(200);
  const out = orthoRender(pic, W, H, new Uint8ClampedArray(100 * 100 * 4), 100, 100, viewOf(0, 0, 1));
  const px = (x, y) => out.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4);
  assert.equal(px(50, 50)[3], 255); assert.equal(px(50, 50)[0], 200, 'the middle is fully lit');
  assert.equal(px(0, 0)[3], 0, 'outside the sphere is clear');
  const R = sphereRadius(viewOf(0, 0, 1), 100, 100);
  const rim = px(50, Math.round(50 - R + 1));
  assert.ok(rim[0] < 200 && rim[0] > 100, `the limb is darker (${rim[0]})`);
  const halo = px(50, Math.round(50 - R - 1));
  assert.ok(halo[3] > 0 && halo[3] < 255 && halo[2] === 255, 'a blue atmosphere just outside the disc');
});

test('the flat map: zoom follows the globe’s scale, capped; the tiles in view wrap round the antimeridian', () => {
  const v = viewOf(52.5, 13.4, 8);
  const fv = flatView(v, 800, 600, 7);
  assert.equal(fv.z, 5);
  const back = flatUnproject(400, 300, fv);
  assert.ok(Math.abs(back.lat - 52.5) < 1e-6 && Math.abs(back.lon - 13.4) < 1e-6, 'the panel’s middle is the view’s place');
  const p = flatProject(52.5, 13.4, fv);
  assert.ok(Math.abs(p.x - 400) < 1e-6 && Math.abs(p.y - 300) < 1e-6);
  const tiles = flatTiles(fv, 800, 600);
  assert.ok(tiles.length >= 4 && tiles.length <= 12, `${tiles.length} tiles`);
  for (const t of tiles) assert.ok(t.x >= 0 && t.x < 32 && t.y >= 0 && t.y < 32);
  assert.equal(flatView(viewOf(0, 0, 200), 800, 600, 7).z, 7, 'capped at the proxy’s zoom');
  const edge = flatTiles(flatView(viewOf(0, 179.9, 8), 800, 600, 7), 800, 600);
  assert.ok(edge.some((t) => t.x === 0) && edge.some((t) => t.x === 31), 'both sides of the antimeridian');
});

test('THE MAP OPENS LOCAL: the home view is the place at tile zoom 11, with rings and a scale bar in metres that fit', () => {
  // operator: "it needs to zoom in at least to the surrounding zip codes. Not up so high. It's a local weather station to start"
  assert.equal(HOME_TILE_Z, 11);
  const v = homeView(52.52, 13.41, 1600, 700);
  assert.equal(isFlat(v, 1600, 700), true, 'flat, not a globe');
  const fv = flatView(v, 1600, 700);
  assert.equal(fv.z, 11);
  for (const z of [3, 5, 8, 11]) assert.equal(flatView(viewOf(10, 10, zoomForTileZ(z, 800, 600)), 800, 600).z, z, `zoomForTileZ(${z}) round-trips`);
  const across = metresPerPixel(fv, 52.52) * 1600 / 1000;
  assert.ok(across > 50 && across < 110, `a wide panel spans the surrounding towns, about ${across.toFixed(0)} km`);
  const bar = scaleBar(fv, 52.52, 160, 'metric');
  assert.ok(bar.px <= 160 && bar.px > 60 && /km$/.test(bar.label), `${bar.label} in ${bar.px.toFixed(0)} px`);
  assert.match(scaleBar(fv, 52.52, 160, 'imperial').label, /mi$/);
  const rings = ringRadii(fv, 52.52, 1600, 700, 'metric');
  assert.ok(rings.length >= 2 && rings.length <= 4 && rings.every((r) => r.px <= 350 * 0.95 && r.px >= 24), `rings fit the panel: ${rings.map((r) => r.label).join(', ')}`);
  assert.deepEqual(ringRadii(fv, 52.52, 1600, 700, 'imperial').map((r) => r.label.slice(-2)), ringRadii(fv, 52.52, 1600, 700, 'imperial').map(() => 'mi'));
  assert.equal(viewOf(0, 0, 1e9).zoom, 4096, 'zoom is bounded');
});

test('the forecast grid: 121 points round the place in one URL, square on the ground, parsed hour-major', () => {
  assert.deepEqual(GRID_STEPS, { local: 0.1, regional: 0.5 }); assert.equal(gridSpanOf('x'), 'local', 'local is the default span');
  const local = gridPoints({ lat: 52.52, lon: 13.41 });
  assert.equal(local.dLat, 0.1, 'a tenth of a degree apart by default: about 11 km, 110 km across');
  const g = gridPoints({ lat: 52.52, lon: 13.41 }, GRID_N, GRID_STEPS.regional);
  assert.equal(g.n, GRID_N); assert.equal(g.lats.length, 121);
  assert.equal(g.dLat, 0.5); assert.ok(g.dLon > 0.8 && g.dLon < 0.85, `wider east-west at 52 degrees (${g.dLon})`);
  assert.equal(g.lats[60], 52.52); assert.equal(g.lons[60], 13.41, 'the place is the middle point');
  const url = gridUrl(g, 'metric');
  assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=/);
  assert.match(url, /forecast_hours=48/);
  assert.ok(!/temperature_unit/.test(url)); assert.match(gridUrl(g, 'imperial'), /wind_speed_unit=mph/);
  const near = gridPoints({ lat: 0, lon: 179.9 });
  assert.ok(near.lons.every((x) => x >= -180 && x <= 180), 'longitudes wrap');
  const reply = g.lats.map((lat, i) => ({ latitude: lat, longitude: g.lons[i], hourly: { time: ['2026-10-14T00:00', '2026-10-14T01:00'], precipitation: [i === 60 ? 2.5 : 0, 0.1], temperature_2m: [10, 11], wind_speed_10m: [5, 6], wind_direction_10m: [180, 190], cloud_cover: [50, 60], weather_code: [3, 61] } }));
  const grid = parseGrid(reply, g, 'metric');
  assert.deepEqual(grid.times, ['2026-10-14T00:00', '2026-10-14T01:00']);
  assert.equal(grid.fields.precip[60], 2.5); assert.equal(grid.fields.precip[121 + 60], 0.1, 'hour-major');
  assert.throws(() => parseGrid(reply.slice(0, 5), g, 'metric'), /expected 121 points/);
  const s = gridSampler(grid, 0, 'precip');
  assert.ok(Math.abs(s(52.52, 13.41) - 2.5) < 1e-9, 'at the point itself');
  assert.ok(s(52.52 + 0.25, 13.41) > 1 && s(52.52 + 0.25, 13.41) < 2.5, 'bilinear between points');
  assert.equal(s(0, 0), null, 'off the grid');
  assert.equal(windPoints(grid, 1).length, 121);
  assert.equal(windPoints(grid, 1)[60].dir, 190);
  const W = 256, H = 128, over = paintGrid(grid, 0, 'precip', new Uint8ClampedArray(W * H * 4), W, H);
  const o = (Math.floor(((90 - 52.52) / 180) * H) * W + Math.floor(((13.41 + 180) / 360) * W)) * 4;
  assert.ok(over[o + 3] > 0, 'rain painted over Berlin'); assert.equal(over[3], 0, 'nothing off the grid');
  assert.deepEqual(rainColour(0), [0, 0, 0, 0]); assert.ok(rainColour(1)[3] > 100); assert.equal(rainColour(100)[3], 255);
});

test('RainViewer’s list is reduced to frames with safe paths; the feed serves only tiles of a listed frame, cached, capped at zoom 7', async () => {
  const list = { host: 'https://tilecache.rainviewer.com', radar: { past: [{ time: 1791913200, path: '/v2/radar/a092a4f0fddf' }, { time: 1791913800, path: '/v2/radar/../../etc' }, { time: 1791920400, path: '/v2/radar/cac22feaf4dd' }], nowcast: [{ time: 1791921000, path: '/v2/radar/nowcast00001' }] } };
  const r = parseRadarList(list);
  assert.equal(r.frames.length, 3, 'the path that is not a frame id is dropped');
  assert.equal(r.frames[2].nowcast, true); assert.equal(r.frames[0].id, 'a092a4f0fddf');
  assert.equal(parseRadarList({ host: 'https://evil.example', radar: { past: list.radar.past } }).host, 'https://tilecache.rainviewer.com', 'the tile host is never taken from the reply');
  assert.throws(() => parseRadarList({}), /no radar frames/);
  assert.deepEqual(RADAR_HOSTS, ['api.rainviewer.com', 'tilecache.rainviewer.com']);
  const urls = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const feed = new WeatherFeed({}, { fetchImpl: async (url) => { urls.push(url); return url.endsWith('.json') ? okReply(list) : okBytes(png); } });
  assert.equal(await feed.radarTile('cac22feaf4dd', 3, 1, 1), null, 'before the list is read, no frame is known');
  const frames = await feed.radarFrames();
  assert.equal(frames.ok, true); assert.equal(frames.frames.length, 3); assert.equal(frames.zoomMax, TILE_ZOOM_MAX);
  const t1 = await feed.radarTile('cac22feaf4dd', 3, 1, 1);
  assert.deepEqual([...t1], [...png]);
  assert.match(urls.at(-1), /^https:\/\/tilecache\.rainviewer\.com\/v2\/radar\/cac22feaf4dd\/256\/3\/1\/1\/2\/1_1\.png$/);
  const n = urls.length;
  await feed.radarTile('cac22feaf4dd', 3, 1, 1); await feed.radarTile('cac22feaf4dd', '3', '1', '1');
  assert.equal(urls.length, n, 'served from the cache');
  assert.equal(await feed.radarTile('cac22feaf4dd', 8, 0, 0), null, 'zoom 8 is refused (a placeholder picture, not radar)');
  assert.equal(await feed.radarTile('cac22feaf4dd', 3, 8, 0), null, 'x past the row is refused');
  assert.equal(await feed.radarTile('deadbeefdead', 3, 0, 0), null, 'an unlisted frame is refused');
  assert.equal(await feed.radarTile('cac22feaf4dd', 1.5, 0, 0), null);
  assert.equal(urls.length, n, 'none of those asked RainViewer');
});

test('the refresh: floored at ten minutes, at most six requests an hour for a place, the grid at least every thirty', async () => {
  let t = 10_000_000, calls = 0;
  const REPLY = { current: { time: '2026-10-13T21:15', temperature_2m: 1 }, daily: {}, hourly: {} };
  const feed = new WeatherFeed({}, { now: () => t, fetchImpl: async () => { calls++; return okReply(REPLY); } });
  assert.equal(REFRESH_FLOOR_MS, 10 * 60_000); assert.equal(REFRESH_PER_HOUR_MAX, 6); assert.equal(GRID_MIN_MS, 30 * 60_000);
  assert.equal(feed.refreshOf(60_000), REFRESH_FLOOR_MS, 'a minute asked for is ten');
  assert.equal(feed.refreshOf(30 * 60_000), 30 * 60_000);
  assert.equal(feed.refreshOf(null), feed.cfg.freshMs);
  const ask = () => feed.forecast(52.52, 13.41, 'metric', { refreshMs: 60_000 });
  const first = await ask();
  assert.equal(first.refreshMs, REFRESH_FLOOR_MS, 'and the reply says what the server will honour');
  // a served copy is refreshed BEHIND the answer, so let each refresh land before the clock moves on
  const tick = async (ms) => { t += ms; await ask(); await new Promise((r) => setImmediate(r)); };
  for (let i = 0; i < 6; i++) await tick(5 * 60_000);
  assert.equal(calls, 4, 'asked every five minutes for half an hour, it asked Open-Meteo every ten');
  const row = feed.places.values().next().value;
  assert.equal(row.at, 10_000_000 + 30 * 60_000, 'the copy is dated from when it was asked for');
  // the cap: a failing fetch is retried after a minute, and that is where six an hour has to hold
  let fails = 0;
  const bad = new WeatherFeed({}, { now: () => t, fetchImpl: async () => { fails++; throw new Error('offline'); } });
  for (let i = 0; i < 40; i++) { t += 61_000; await bad.forecast(1, 1, 'metric', { refreshMs: 60_000 }).catch(() => {}); await new Promise((r) => setImmediate(r)); }
  assert.ok(fails <= 7 && fails >= 6, `forty minutes of retries, six an hour (${fails})`);
  // the grid: 30 minutes however short the refresh
  let gcalls = 0;
  const g = gridPoints({ lat: 52.52, lon: 13.41 });
  const gridReply = g.lats.map(() => ({ hourly: { time: ['2026-10-14T00:00'], precipitation: [0], temperature_2m: [1], wind_speed_10m: [1], wind_direction_10m: [1], cloud_cover: [1], weather_code: [0] } }));
  const gf = new WeatherFeed({}, { now: () => t, fetchImpl: async () => { gcalls++; return okReply(gridReply); } });
  const g1 = await gf.grid(52.52, 13.41, 'metric', { refreshMs: 60_000 });
  assert.equal(g1.ok, true); assert.equal(g1.refreshMs, GRID_MIN_MS); assert.equal(g1.n, 11); assert.equal(g1.span, 'local'); assert.equal(g1.dLat, 0.1);
  const g2 = await gf.grid(52.52, 13.41, 'metric', { refreshMs: 60_000, span: 'regional' });
  assert.equal(g2.dLat, 0.5); assert.equal(gcalls, 2, 'the regional grid is another request');
  t += 20 * 60_000; await gf.grid(52.52, 13.41, 'metric', { refreshMs: 60_000 });
  assert.equal(gcalls, 2, 'twenty minutes on: not yet');
  t += 11 * 60_000; await gf.grid(52.52, 13.41, 'metric', { refreshMs: 60_000 });
  assert.equal(gcalls, 3);
});

test('the settings: refresh, the globe and its layer; the shared file’s refresh reaches the server', async () => {
  assert.equal(DEFAULTS.weather.refresh, '10'); assert.equal(DEFAULTS.weather.map, true); assert.equal(DEFAULTS.weather.mapLayer, 'radar'); assert.equal(DEFAULTS.weather.gridSpan, 'local');
  const rows = PANEL.find((g) => g.group === 'weather').rows;
  assert.deepEqual(rows.find((r) => r.key === 'refresh').options.map(([v]) => v), ['10', '15', '20', '30', '60'], 'ten minutes is the least offered');
  assert.equal(normalise({ weather: { refresh: '5' } }).weather.refresh, '10', 'an unknown value is the default');
  assert.match(rows.find((r) => r.key === 'map').hint, /rainviewer\.com/);
  const app = { settingsFile: tmpFile() };
  assert.equal(await weatherRefreshMs(app), null);
  fs.writeFileSync(app.settingsFile, JSON.stringify({ weather: { enabled: true, refresh: '30' } }));
  assert.equal(await weatherRefreshMs(app), 30 * 60_000);
});

test('the routes and the raw tile: off until ticked, then the frames, the grid and PNG bytes; junk paths 404', async () => {
  const list = { radar: { past: [{ time: 1, path: '/v2/radar/abcdef123456' }] } };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const g = gridPoints({ lat: 52.52, lon: 13.41 });
  const gridReply = g.lats.map(() => ({ hourly: { time: ['2026-10-14T00:00'], precipitation: [0], temperature_2m: [1], wind_speed_10m: [1], wind_direction_10m: [1], cloud_cover: [1], weather_code: [0] } }));
  const app = { settingsFile: tmpFile(), weather: new WeatherFeed({}, { fetchImpl: async (url) => (url.includes('rainviewer.com/public') ? okReply(list) : url.includes('open-meteo') ? okReply(gridReply) : okBytes(png)) }) };
  const route = (p) => routes.find((r) => r.path === p && r.method === 'GET');
  assert.equal(route('/api/weather/grid').compress, undefined, 'the grid is not gzipped: the mempool routes stay the only ones that are');
  for (const p of ['/api/weather/radar', '/api/weather/grid']) { const r = await route(p).handler({ query: { lat: '52.52', lon: '13.41' } }, app); assert.equal(r.enabled, false); assert.match(r.note, /Enable weather/); }
  const res = () => { const r = { head: null, body: null, writeHead(s, h) { r.head = [s, h]; }, end(b) { r.body = b; } }; return r; };
  let r = res();
  const off = await serveWeatherTile({ method: 'GET', headers: {} }, r, '/weather/tile/abcdef123456/3/1/1.png', app);
  assert.equal(off.status, 403, 'unticked: refused');
  fs.writeFileSync(app.settingsFile, JSON.stringify({ weather: { enabled: true } }));
  const frames = await route('/api/weather/radar').handler({ query: {} }, app);
  assert.equal(frames.ok, true); assert.equal(frames.frames[0].id, 'abcdef123456');
  const grid = await route('/api/weather/grid').handler({ query: { lat: '52.52', lon: '13.41' } }, app);
  assert.equal(grid.ok, true); assert.equal(grid.fields.precip.length, 121);
  r = res();
  const got = await serveWeatherTile({ method: 'GET', headers: {} }, r, '/weather/tile/abcdef123456/3/1/1.png', app);
  assert.equal(got.status, 200); assert.equal(r.head[1]['Content-Type'], 'image/png'); assert.deepEqual([...r.body], [...png]);
  r = res();
  assert.equal((await serveWeatherTile({ method: 'GET', headers: {} }, r, '/weather/tile/abcdef123456/8/1/1.png', app)).status, 404);
  assert.equal(await serveWeatherTile({ method: 'GET', headers: {} }, res(), '/weather/tile/../x.png', app), null, 'not a tile path at all');
  assert.ok(TILE_PATH.test('/weather/tile/abcdef123456/7/127/127.png') && !TILE_PATH.test('/weather/tile/abcdef123456/7/127/127.jpg'));
  assert.ok(TILE_PATH.test('/weather/tile/abcdef123456/11/1100/671.png'), 'four-digit tile indexes (zoom 10-12): three digits lost every local-view tile to the static 404');
  assert.equal((await serveWeatherTile({ method: 'GET', headers: {} }, res(), '/weather/tile/abcdef123456/3/1/1.png', { settingsFile: app.settingsFile, weather: null })).status, 404, 'BLOCKYARD_WEATHER=0');
});

test('the page: the globe’s slot and markup; the docs name RainViewer; the rate limiter and the server branch exist', async () => {
  const { globeHtml } = await import('../public/js/weatherglobe.js');
  const html = globeHtml();
  for (const sel of ['data-wxg-play', 'data-wxg-range', 'data-wxg="home"', 'data-wxg="region"', 'data-wxg="world"', 'class="wxg-gl"', 'class="wxg-ui"']) assert.ok(html.includes(sel), sel);
  assert.match(html, />local</, 'the home button says where it goes');
  assert.ok(!/\sstyle=/.test(html));
  const sec = read('docs/SECURITY.md');
  for (const h of RADAR_HOSTS) assert.ok(sec.includes(h), `docs/SECURITY.md names ${h}`);
  assert.match(read('server/http/server.js'), /path\.startsWith\('\/weather\/tile\/'\)/);
  assert.match(read('server/main.js'), /app\.weatherLimiter = new RateLimiter/);
  assert.match(read('public/js/weather.js'), /data-wx-globe-slot/);
  assert.match(read('public/js/weatherglobe.js'), /land-50m\.json/);
  assert.ok(!fs.existsSync(new URL('public/geo/land-110m.json', root)), 'the 1:110m file is gone with its straight-edge coastlines');
});
