// THE STREET MAP BUILT BY THE MONITOR (server/collect/pmextract.js, server/collect/mapbuild.js; operator, 2026-10-13:
// "we need to build this feature into BlockYard. Not just one-off shit"). A fake planet archive lives in memory and is
// served by a fetch that honours Range, so the whole extract runs here: wanted tiles, directories, tile ranges, the
// written file, and the server's reader opening what was written. Then the builder's state machine and the routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { extract, wantedTiles, tileId, buildArchive, writeDirectory, readDirectory, parseHeader, PM_HOSTS } from '../server/collect/pmextract.js';
import { MapBuilder } from '../server/collect/mapbuild.js';
import { MapArchive } from '../server/http/vtiles.js';
import { encodeTile, decodeTile, GEOM } from '../public/js/mvt.js';
import { routes } from '../server/http/api.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'by-mapbuild-'));

/** A planet of zoom 0-4 round the whole world: every tile a gzip'd MVT naming itself; ids 7..9 share one buffer. */
function fakePlanet() {
  const tiles = [];
  const byId = new Map();
  for (let z = 0; z <= 4; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) {
    const id = tileId(z, x, y);
    const buf = gzipSync(Buffer.from(encodeTile({ t: { features: [{ type: GEOM.POINT, props: { z, x, y }, geom: [[[1, 1]]] }] } })));
    tiles.push({ ids: [id], buf }); byId.set(id.toString(), { z, x, y });
  }
  const planet = buildArchive({ tiles, meta: { name: 'fake planet', attribution: 'test' }, maxzoom: 4, bbox: { w: -180, s: -85, e: 180, n: 85 }, center: { lat: 0, lon: 0 } });
  return { planet, byId };
}
/** A fetch for the index and the archive, Range honoured; counts requests and bytes. */
function fetcher(planet, key = '20261013.pmtiles') {
  const log = { requests: 0, bytes: 0 };
  const f = async (url, opts = {}) => {
    log.requests++;
    if (String(url).endsWith('builds.json')) return { ok: true, status: 200, json: async () => [{ key: '20261001.pmtiles' }, { key }, { key: 'junk' }] };
    assert.ok(String(url).endsWith('/' + key), `the archive url ${url}`);
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers?.range ?? '');
    assert.ok(m, 'every archive request is a range request');
    const a = Number(m[1]), b = Math.min(Number(m[2]), planet.length - 1);
    const slice = planet.subarray(a, b + 1);
    log.bytes += slice.length;
    return { ok: true, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
  };
  return { fetch: f, log };
}

test('the wanted tiles: every zoom to the ceiling, the box round the radius, ids sorted', () => {
  const { ids, bbox } = wantedTiles(52.52, 13.41, 60, 4);
  assert.ok(ids.length >= 5 && ids.length <= 12, `${ids.length} tiles (one per zoom at least)`);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], 'sorted');
  assert.ok(bbox.n > 52.52 && bbox.s < 52.52 && bbox.e > 13.41 && bbox.w < 13.41);
  assert.ok(Math.abs((bbox.n - bbox.s) - 2 * 60 / 111.32) < 1e-9, 'the radius in degrees of latitude');
  assert.deepEqual(PM_HOSTS, ['build-metadata.protomaps.dev', 'build.protomaps.com']);
});

test('a directory written is a directory read: runs, contiguous offsets, explicit offsets', () => {
  const entries = [{ id: 5n, off: 0, len: 100, run: 2 }, { id: 9n, off: 100, len: 50, run: 1 }, { id: 20n, off: 1000, len: 7, run: 1 }];
  const d = readDirectory(writeDirectory(entries));
  assert.deepEqual(d.ids, [5n, 9n, 20n]); assert.deepEqual(d.runs, [2, 1, 1]); assert.deepEqual(d.lens, [100, 50, 7]); assert.deepEqual(d.offs, [0, 100, 1000]);
});

test('the extract: from a fake planet to a file the server opens, by range requests only; a dry run fetches no tiles', async () => {
  const { planet, byId } = fakePlanet();
  const { fetch, log } = fetcher(planet);
  const dir = tmp(), out = path.join(dir, 'place.pmtiles');
  const seen = [];
  const plan = await extract({ lat: 10, lon: 20, radiusKm: 500, maxzoom: 4, out, fetchImpl: fetch, dryRun: true, onProgress: (p) => seen.push(p.phase) });
  assert.equal(plan.key, '20261013.pmtiles', 'the newest listed build');
  assert.ok(plan.tiles >= 5 && plan.tiles < 50, `${plan.tiles} tiles planned`);
  assert.ok(!fs.existsSync(out), 'a dry run writes nothing');
  assert.deepEqual(seen.slice(0, 3), ['index', 'directories', 'planned']);
  const before = log.requests;
  const r = await extract({ lat: 10, lon: 20, radiusKm: 500, maxzoom: 4, out, fetchImpl: fetch, build: '20261013.pmtiles', onProgress: (p) => seen.push(p.phase) });
  assert.ok(seen.includes('tiles') && seen.at(-1) === 'done');
  assert.ok(log.requests - before >= 3, 'header, root, metadata, tiles');
  assert.equal(r.tiles, plan.tiles); assert.ok(fs.existsSync(out) && !fs.existsSync(`${out}.part`), 'written atomically');
  assert.ok(r.bytes < planet.length, 'smaller than the planet');
  const arc = await new MapArchive(out).open();
  assert.equal(arc.head.maxZoom, 4); assert.equal(arc.meta['blockyard:extract'].radiusKm, 300, 'the engine caps the radius at 300 km'); assert.equal(arc.meta.name, 'fake planet');
  // a wanted tile reads back as itself; one outside the box is not there
  const want = wantedTiles(10, 20, 500, 4).ids.map((id) => byId.get(id.toString()));
  const t = want.find((x) => x.z === 4);
  const got = decodeTile(new Uint8Array(await arc.tile(t.z, t.x, t.y)));
  assert.deepEqual(got.layers.t.features[0].props, { z: t.z, x: t.x, y: t.y });
  assert.equal(await arc.tile(4, (t.x + 8) % 16, (t.y + 8) % 16), null, 'the far side of the world is not in the extract');
  assert.deepEqual(parseHeader(fs.readFileSync(out).subarray(0, 127)).leafLen, 0, 'one root directory, no leaves');
  await arc.close();
  // cancelled between requests
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(extract({ lat: 10, lon: 20, radiusKm: 500, maxzoom: 4, out: path.join(dir, 'x.pmtiles'), fetchImpl: fetch, signal: ctl.signal, build: '20261013.pmtiles' }), /cancelled/);
});

test('the builder: one at a time, progress on view(), the outcome kept, cancel aborts', async () => {
  const dir = tmp();
  let t = 1000, resolve, reject, gotSignal;
  const fake = (opts) => new Promise((res, rej) => { resolve = res; reject = rej; gotSignal = opts.signal; opts.onProgress({ phase: 'tiles', done: 5, total: 20, bytes: 1e6, estBytes: 4e6, key: 'k' }); });
  const b = new MapBuilder({ dir, extractImpl: fake, now: () => t });
  assert.equal(b.view().running, false);
  assert.throws(() => b.start({ lat: 99, lon: 0 }), /not a place/);
  const v = b.start({ lat: 48.86, lon: 2.35, radiusKm: 60, name: 'Paris' });
  assert.equal(v.running, true); assert.equal(v.place.name, 'Paris'); assert.equal(path.basename(v.out), '48.86_2.35.pmtiles');
  assert.throws(() => b.start({ lat: 1, lon: 1 }), /already being built/);
  t += 10_000;
  const mid = b.view();
  assert.equal(mid.phase, 'tiles'); assert.equal(mid.done, 5); assert.equal(mid.etaSec, null, 'no estimate yet: five of twenty is under the twenty tiles it waits for');
  b.state.done = 20; b.state.total = 80;
  assert.equal(b.view().etaSec, 30, 'ten seconds for twenty of eighty: thirty to go');
  resolve({ out: v.out, bytes: 123, tiles: 20, key: 'k', requests: 3 });
  await new Promise((r) => setImmediate(r));
  assert.equal(b.view().running, false); assert.equal(b.view().phase, 'done'); assert.equal(b.view().result.tiles, 20);
  assert.equal(b.cancel(), false, 'nothing to cancel');
  b.start({ lat: 1, lon: 2 });
  assert.equal(b.cancel(), true); assert.equal(gotSignal.aborted, true);
  reject(new Error('cancelled'));
  await new Promise((r) => setImmediate(r));
  assert.equal(b.view().phase, 'cancelled'); assert.equal(b.view().error, null);
  b.start({ lat: 1, lon: 2 }); reject(new Error('HTTP 503')); await new Promise((r) => setImmediate(r));
  assert.equal(b.view().phase, 'failed'); assert.equal(b.view().error, 'HTTP 503');
});

test('the routes: build needs the weather switch and the settings-write right; the map view carries the build', async () => {
  const dir = tmp();
  const started = [];
  const app = { settingsFile: path.join(dir, 'blockyard.json'), weather: {}, cfg: { store: { dir }, auth: { enabled: false } }, mapBuilder: new MapBuilder({ dir, extractImpl: (o) => { started.push(o); return new Promise(() => {}); } }) };
  const route = (p) => routes.find((r) => r.path === p && r.method === 'POST');
  assert.ok(route('/api/weather/map/build').csrf && route('/api/weather/map/build').body, 'a POST with CSRF and a body');
  await assert.rejects(route('/api/weather/map/build').handler({ query: {}, body: { lat: 1, lon: 2 } }, app), /off for this monitor/, 'unticked');
  fs.writeFileSync(app.settingsFile, JSON.stringify({ weather: { enabled: true } }));
  const r = await route('/api/weather/map/build').handler({ query: {}, body: { lat: 48.86, lon: 2.35, radiusKm: 1000, name: 'Paris' } }, app);
  assert.equal(r.ok, true); assert.equal(r.build.running, true); assert.equal(started[0].radiusKm, 300, 'the radius is capped');
  await assert.rejects(route('/api/weather/map/build').handler({ query: {}, body: { lat: 1, lon: 2 } }, app), /already being built/);
  const view = await routes.find((x) => x.path === '/api/weather/map' && x.method === 'GET').handler({ query: {} }, app);
  assert.equal(view.build.running, true); assert.equal(view.map, null);
  const c = await route('/api/weather/map/build/cancel').handler({ query: {} }, app);
  assert.equal(c.cancelled, true);
  // with accounts on, a viewer may not start one
  const closed = { ...app, cfg: { ...app.cfg, auth: { enabled: true } } };
  await assert.rejects(route('/api/weather/map/build').handler({ query: {}, body: { lat: 1, lon: 2 }, user: { role: 'viewer' } }, closed), /admin|forbidden|role/i);
});
