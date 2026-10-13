// THE STREET MAP'S ROUTE (server/http/vtiles.js): off until the weather switch is ticked, honest without an extract,
// and the archive discovery in data/map. The archive reader itself is exercised in test/mvt.test.js and, end to end,
// by scripts/map-extract.mjs against the real Protomaps planet (a 193 MB Berlin extract, 2026-10-13).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveVectorTile, findMapFile, mapArchive } from '../server/http/vtiles.js';
import { routes } from '../server/http/api.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'by-vtiles-'));
const res = () => { const r = { head: null, body: null, writeHead(s, h) { r.head = [s, h]; }, end(b) { r.body = b; } }; return r; };
const req = { method: 'GET', headers: {} };

test('the vector tile route: not a tile path, weather off, unticked, then no extract on this server', async () => {
  const dir = tmp();
  const app = { settingsFile: path.join(dir, 'blockyard.json'), weather: {}, cfg: { store: { dir } } };
  assert.equal(await serveVectorTile(req, res(), '/weather/vtile/14/8802/5373.png', app), null, 'not a tile path');
  assert.equal((await serveVectorTile(req, res(), '/weather/vtile/14/8802/5373.mvt', { ...app, weather: null })).status, 404, 'BLOCKYARD_WEATHER=0');
  assert.equal((await serveVectorTile(req, res(), '/weather/vtile/14/8802/5373.mvt', app)).status, 403, 'unticked');
  fs.writeFileSync(app.settingsFile, JSON.stringify({ weather: { enabled: true } }));
  const r = res();
  const none = await serveVectorTile(req, r, '/weather/vtile/14/8802/5373.mvt', app);
  assert.equal(none.status, 404); assert.match(String(r.body), /map-extract/, 'and says how to make one');
  const info = await routes.find((x) => x.path === '/api/weather/map').handler({ query: {} }, app);
  assert.equal(info.ok, true); assert.equal(info.map, null); assert.match(info.note, /map-extract\.mjs --lat/);
});

test('the archive is found: weather.mapFile first, else the newest *.pmtiles in data/map; a broken file is logged, not fatal', async () => {
  const dir = tmp();
  assert.equal(await findMapFile({ store: { dir } }), null, 'no map directory yet');
  fs.mkdirSync(path.join(dir, 'map'));
  assert.equal(await findMapFile({ store: { dir } }), null, 'an empty one');
  fs.writeFileSync(path.join(dir, 'map', 'old.pmtiles'), 'x');
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, 'map', 'new.pmtiles'), 'y');
  fs.writeFileSync(path.join(dir, 'map', 'notes.txt'), 'z');
  assert.equal(path.basename(await findMapFile({ store: { dir } })), 'new.pmtiles', 'the newest archive');
  assert.equal(await findMapFile({ store: { dir }, weather: { mapFile: '/elsewhere/place.pmtiles' } }), path.resolve('/elsewhere/place.pmtiles'), 'a named file wins');
  const logs = [];
  const app = { cfg: { store: { dir } }, log: (l) => logs.push(l) };
  assert.equal(await mapArchive(app), null, 'a file that is not an archive opens as nothing');
  assert.match(logs[0]?.msg ?? '', /could not be opened/);
});
