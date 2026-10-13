// STATIC TEXT GOES OUT GZIPPED (server/http/static.js serve(); operator, 2026-10-13, of the map geography's 4.3 MB
// first load: "do it"): compressed once, kept in memory, its own ETag, identity for a client that does not accept it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { StaticFiles, GZIP_MIN, GZIP_TYPES } from '../server/http/static.js';

const res = () => { const r = { head: null, chunks: [], writeHead(s, h) { r.head = [s, h]; }, end(b) { if (b) r.chunks.push(Buffer.from(b)); r.done = true; }, write(b) { r.chunks.push(Buffer.from(b)); }, on() {}, once() {}, emit() {}, destroy() {}, body() { return Buffer.concat(r.chunks); } }; return r; };
const wait = (r) => new Promise((ok) => { const t = setInterval(() => { if (r.done) { clearInterval(t); ok(); } }, 5); });

test('a large JSON asset is gzipped for a client that accepts it, identity otherwise, 304 on either ETag, never below the floor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'by-gz-'));
  fs.mkdirSync(path.join(root, 'geo'));
  const big = JSON.stringify({ polygons: Array.from({ length: 3000 }, (_, i) => [i, i * 2, i * 3]) });
  fs.writeFileSync(path.join(root, 'geo', 'land.json'), big);
  fs.writeFileSync(path.join(root, 'small.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'pic.png'), Buffer.alloc(GZIP_MIN * 2, 7));
  assert.ok(big.length >= GZIP_MIN, 'the fixture is over the floor');
  const st = new StaticFiles(root);
  // gzip accepted
  let r = res();
  const out = await st.serve({ method: 'GET', headers: { 'accept-encoding': 'gzip, deflate, br' } }, r, '/geo/land.json');
  assert.equal(out.gzip, true); assert.equal(r.head[0], 200);
  assert.equal(r.head[1]['Content-Encoding'], 'gzip'); assert.equal(r.head[1].Vary, 'Accept-Encoding');
  assert.equal(r.head[1]['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(Number(r.head[1]['Content-Length']), r.body().length, 'the length is the gzipped body’s');
  assert.ok(r.body().length < big.length * 0.6, `compressed (${r.body().length} of ${big.length}; distinct integers gzip to about 45 %)`);
  assert.equal(gunzipSync(r.body()).toString(), big, 'and it is the file');
  assert.match(r.head[1].ETag, /-gz"$/);
  const gzEtag = r.head[1].ETag;
  assert.equal(st.gzCache.size, 1, 'kept in memory');
  // the same again: from the cache, and a conditional request answers 304
  r = res(); await st.serve({ method: 'GET', headers: { 'accept-encoding': 'gzip', 'if-none-match': gzEtag } }, r, '/geo/land.json');
  assert.equal(r.head[0], 304);
  // identity for a client without gzip: the stream, the plain ETag, Vary still said
  r = res(); const plain = await st.serve({ method: 'GET', headers: {} }, r, '/geo/land.json'); await wait(r);
  assert.equal(plain.gzip, undefined); assert.equal(r.head[1]['Content-Encoding'], undefined); assert.equal(r.head[1].Vary, 'Accept-Encoding');
  assert.ok(!/-gz"$/.test(r.head[1].ETag)); assert.equal(r.body().toString(), big);
  r = res(); await st.serve({ method: 'GET', headers: { 'if-none-match': plain.etag } }, r, '/geo/land.json');
  assert.equal(r.head[0], 304, 'the plain ETag matches the plain form');
  // under the floor, and a binary type: never gzipped
  r = res(); const sm = await st.serve({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, r, '/small.json'); await wait(r);
  assert.equal(sm.gzip, undefined); assert.equal(r.head[1]['Content-Encoding'], undefined);
  r = res(); const png = await st.serve({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, r, '/pic.png'); await wait(r);
  assert.equal(png.gzip, undefined); assert.equal(r.head[1].Vary, undefined, 'a binary type does not vary');
  // HEAD carries the headers and no body
  r = res(); await st.serve({ method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }, r, '/geo/land.json');
  assert.equal(r.head[1]['Content-Encoding'], 'gzip'); assert.equal(r.body().length, 0);
  // a changed file is recompressed, the old entry dropped
  fs.writeFileSync(path.join(root, 'geo', 'land.json'), big + ' ');
  r = res(); await st.serve({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, r, '/geo/land.json');
  assert.equal(gunzipSync(r.body()).toString(), big + ' '); assert.equal(st.gzCache.size, 1, 'one entry per file');
  assert.ok(GZIP_TYPES.has('.js') && GZIP_TYPES.has('.css') && !GZIP_TYPES.has('.png'));
});
