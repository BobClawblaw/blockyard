// THE VECTOR TILE DECODER (public/js/mvt.js) and the archive reader (server/http/vtiles.js): a tile encoded here is
// decoded back to the same features; tile ids follow the Hilbert curve the PMTiles spec gives; a directory written by
// the extract script is read back by the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTile, encodeTile, decodeGeometry, ringArea, GEOM } from '../public/js/mvt.js';
import { tileId, parseHeader, parseDirectory, VTILE_PATH } from '../server/http/vtiles.js';

test('a tile round-trips: layers, extents, properties of every type, points, lines and closed polygons', () => {
  const tile = {
    roads: { features: [
      { id: 7, type: GEOM.LINE, props: { kind: 'highway', name: 'A100', is_bridge: true, lanes: 4, layer: -1, width: 3.5 }, geom: [[[0, 0], [100, 50], [4096, 4096]]] },
      { type: GEOM.LINE, props: {}, geom: [[[10, 10], [20, 20]], [[30, 30], [40, 10]]] },
    ] },
    water: { extent: 8192, features: [{ type: GEOM.POLYGON, props: { kind: 'lake' }, geom: [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]] }] },
    places: { features: [{ type: GEOM.POINT, props: { name: 'Berlin', 'name:de': 'Berlin', min_zoom: 3.2 }, geom: [[[2048, 2048]]] }] },
  };
  const d = decodeTile(encodeTile(tile));
  assert.deepEqual(Object.keys(d.layers), ['roads', 'water', 'places']);
  assert.equal(d.layers.water.extent, 8192); assert.equal(d.layers.roads.extent, 4096);
  const r = d.layers.roads.features[0];
  assert.equal(r.id, 7); assert.equal(r.type, GEOM.LINE);
  assert.deepEqual(r.props, { kind: 'highway', name: 'A100', is_bridge: true, lanes: 4, layer: -1, width: 3.5 });
  assert.deepEqual(r.geom, [[[0, 0], [100, 50], [4096, 4096]]]);
  assert.deepEqual(d.layers.roads.features[1].geom, [[[10, 10], [20, 20]], [[30, 30], [40, 10]]], 'a multi-line');
  const w = d.layers.water.features[0];
  assert.deepEqual(w.geom, [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]], 'a polygon comes back closed');
  assert.ok(ringArea(w.geom[0]) > 0, 'clockwise in tile space: an outer ring');
  assert.deepEqual(d.layers.places.features[0].geom, [[[2048, 2048]]]);
  assert.equal(d.layers.places.features[0].props['name:de'], 'Berlin');
  assert.ok(Math.abs(d.layers.places.features[0].props.min_zoom - 3.2) < 1e-12);
});

test('geometry commands: MoveTo, LineTo and ClosePath with zigzag deltas, as the spec’s own example', () => {
  // the spec's polygon example: MoveTo(3,6), LineTo(8,12), LineTo(20,34), ClosePath
  const cmds = [9, 6, 12, 18, 10, 12, 24, 44, 15];
  assert.deepEqual(decodeGeometry(cmds, GEOM.POLYGON), [[[3, 6], [8, 12], [20, 34], [3, 6]]]);
  assert.deepEqual(decodeGeometry([9, 4, 4, 18, 0, 16, 16, 0], GEOM.LINE), [[[2, 2], [2, 10], [10, 10]]]);
  assert.deepEqual(decodeGeometry([17, 10, 14, 3, 9], GEOM.POINT), [[[5, 7]], [[3, 2]]], 'a multipoint');
});

test('PMTiles ids: the spec’s values, and the server’s header and directory readers', () => {
  // the spec: z0 -> 0; z1 (0,0) 1, (0,1) 2, (1,1) 3, (1,0) 4; z2 starts at 5
  assert.equal(tileId(0, 0, 0), 0n);
  assert.deepEqual([tileId(1, 0, 0), tileId(1, 0, 1), tileId(1, 1, 1), tileId(1, 1, 0)], [1n, 2n, 3n, 4n]);
  assert.equal(tileId(2, 0, 0), 5n);
  assert.equal(tileId(3, 7, 0), 21n + 63n, 'the end of the zoom-3 curve is its bottom-right corner, as at zoom 1');
  const ids = new Set(); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ids.add(tileId(3, x, y).toString());
  assert.equal(ids.size, 64, 'every zoom-3 tile its own id');
  // a header and a directory as map-extract.mjs writes them
  const hdr = Buffer.alloc(127); hdr.write('PMTiles', 0, 'latin1'); hdr[7] = 3;
  hdr.writeBigUInt64LE(127n, 8); hdr.writeBigUInt64LE(40n, 16); hdr.writeBigUInt64LE(167n, 24); hdr.writeBigUInt64LE(10n, 32);
  hdr.writeBigUInt64LE(177n, 56); hdr.writeBigUInt64LE(1000n, 64); hdr.writeBigUInt64LE(3n, 80); hdr.writeBigUInt64LE(3n, 88);
  hdr[97] = 2; hdr[98] = 2; hdr[99] = 1; hdr[100] = 0; hdr[101] = 15;
  hdr.writeInt32LE(Math.round(13.0 * 1e7), 102); hdr.writeInt32LE(Math.round(52.0 * 1e7), 106); hdr.writeInt32LE(Math.round(14.0 * 1e7), 110); hdr.writeInt32LE(Math.round(53.0 * 1e7), 114);
  const h = parseHeader(hdr);
  assert.equal(h.rootOff, 127); assert.equal(h.dataOff, 177); assert.equal(h.maxZoom, 15); assert.equal(h.tileType, 1);
  assert.deepEqual(h.bounds, { w: 13, s: 52, e: 14, n: 53 });
  assert.throws(() => parseHeader(Buffer.from('not a pmtiles file, not at all, no sir, nope ....................................................................')), /not a PMTiles/);
  // a directory: ids 5, 6 (a run of 2 sharing bytes), 9; offsets 0, then contiguous, then explicit
  const vb = []; const v = (n) => { do { let c = n & 0x7f; n = Math.floor(n / 128); if (n) c |= 0x80; vb.push(c); } while (n); };
  v(2); v(5); v(4); v(2); v(1); v(100); v(50); v(1); v(0);
  const d = parseDirectory(Buffer.from(vb));
  assert.equal(d.n, 2); assert.deepEqual(d.ids, [5n, 9n]); assert.deepEqual(d.runs, [2, 1]); assert.deepEqual(d.lens, [100, 50]); assert.deepEqual(d.offs, [0, 100]);
  assert.ok(VTILE_PATH.test('/weather/vtile/15/17600/10750.mvt') && !VTILE_PATH.test('/weather/vtile/15/17600/10750.png'));
});
