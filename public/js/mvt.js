// MAPBOX VECTOR TILES, DECODED HERE (docs/PLAN-WEATHER-GLOBE.md, part B). A tile is a protobuf: layers, each with a
// name, an extent (4096 by default), a table of keys and values, and features that carry a geometry type, a list of
// tag indexes into those tables, and geometry as a stream of commands (MoveTo, LineTo, ClosePath) in zigzag-encoded
// deltas. This reads exactly that -- no general protobuf library, the few field numbers the spec defines -- and hands
// back plain objects the renderer (weatherstreets.js) draws. Pure: a Uint8Array in, objects out; tested under node:test.
//
// Spec: github.com/mapbox/vector-tile-spec, 2.1. Field numbers: Tile.layers = 3; Layer: version 15, name 1, features 2,
// keys 3, values 4, extent 5; Feature: id 1, tags 2, type 3, geometry 4; Value: string 1, float 2, double 3, int 4,
// uint 5, sint 6, bool 7.

export const GEOM = Object.freeze({ UNKNOWN: 0, POINT: 1, LINE: 2, POLYGON: 3 });

class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }
  varint() {
    let r = 0, s = 0, c;
    do { c = this.buf[this.pos++]; r += s < 28 ? (c & 0x7f) << s : (c & 0x7f) * 2 ** s; s += 7; } while (c >= 0x80);
    return r;
  }
  // a 64-bit varint as a Number (ids and ints can exceed 2^32 but not 2^53 in any tile we draw)
  varint64() { return this.varint(); }
  svarint() { const v = this.varint(); return v % 2 === 1 ? -(v + 1) / 2 : v / 2; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unknown wire type ${wire}`);
  }
  bytes() { const n = this.varint(); const s = this.pos; this.pos += n; return this.buf.subarray(s, this.pos); }
  string() { return DEC.decode(this.bytes()); }
  float() { const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true); this.pos += 4; return v; }
  double() { const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true); this.pos += 8; return v; }
}
const DEC = new TextDecoder();

function readValue(r) {
  const n = r.varint(), end = r.pos + n;   // the length FIRST: `pos + varint()` read the position before the varint moved it
  let v = null;
  while (r.pos < end) {
    const tag = r.varint(), f = tag >> 3, w = tag & 7;
    if (f === 1) v = r.string();
    else if (f === 2) v = r.float();
    else if (f === 3) v = r.double();
    else if (f === 4) v = r.varint64();
    else if (f === 5) v = r.varint64();
    else if (f === 6) v = r.svarint();
    else if (f === 7) v = r.varint() !== 0;
    else r.skip(w);
  }
  return v;
}

/** The geometry commands of a feature as rings/lines: an array of arrays of [x, y] in tile units. */
export function decodeGeometry(cmds, type) {
  const parts = [];
  let x = 0, y = 0, cur = null;
  for (let i = 0; i < cmds.length;) {
    const c = cmds[i++], id = c & 7, n = c >> 3;
    if (id === 1) {             // MoveTo
      for (let k = 0; k < n; k++) { x += zz(cmds[i++]); y += zz(cmds[i++]); cur = [[x, y]]; parts.push(cur); }
    } else if (id === 2) {      // LineTo
      for (let k = 0; k < n; k++) { x += zz(cmds[i++]); y += zz(cmds[i++]); cur.push([x, y]); }
    } else if (id === 7) {      // ClosePath
      if (cur && type === GEOM.POLYGON && cur.length) cur.push(cur[0]);
    } else throw new Error(`geometry command ${id}`);
  }
  return parts;
}
const zz = (v) => (v % 2 === 1 ? -(v + 1) / 2 : v / 2);

/** Signed area of a ring in tile units (positive = clockwise in the tile's y-down space = an outer ring per the spec). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

/**
 * Decode a tile. Returns { layers: { [name]: { extent, features: [{ id, type, props, geom }] } } } where geom is the
 * output of decodeGeometry: lines/rings as arrays of [x, y] in tile units (0..extent).
 */
export function decodeTile(buf) {
  const r = new Reader(buf);
  const layers = {};
  while (r.pos < r.end) {
    const tag = r.varint(), f = tag >> 3, w = tag & 7;
    if (f !== 3) { r.skip(w); continue; }
    const ln = r.varint(), end = r.pos + ln;   // the length FIRST: `pos + varint()` read the position before the varint moved it
    const layer = { name: '', extent: 4096, keys: [], values: [], raw: [] };
    while (r.pos < end) {
      const t = r.varint(), lf = t >> 3, lw = t & 7;
      if (lf === 1) layer.name = r.string();
      else if (lf === 2) { const n = r.varint(); layer.raw.push([r.pos, r.pos + n]); r.pos += n; }
      else if (lf === 3) layer.keys.push(r.string());
      else if (lf === 4) layer.values.push(readValue(r));
      else if (lf === 5) layer.extent = r.varint();
      else r.skip(lw);
    }
    const features = [];
    for (const [s, e] of layer.raw) {
      const fr = new Reader(buf, s, e);
      const ft = { id: null, type: 0, props: {}, geom: [] };
      let cmds = null;
      while (fr.pos < e) {
        const t = fr.varint(), ff = t >> 3, fw = t & 7;
        if (ff === 1) ft.id = fr.varint64();
        else if (ff === 2) { const n = fr.varint(), pe = fr.pos + n; while (fr.pos < pe) { const k = fr.varint(), v = fr.varint(); ft.props[layer.keys[k]] = layer.values[v]; } }
        else if (ff === 3) ft.type = fr.varint();
        else if (ff === 4) { const n = fr.varint(), pe = fr.pos + n; cmds = []; while (fr.pos < pe) cmds.push(fr.varint()); }
        else fr.skip(fw);
      }
      ft.geom = cmds ? decodeGeometry(cmds, ft.type) : [];
      features.push(ft);
    }
    layers[layer.name] = { extent: layer.extent, features };
  }
  return { layers };
}

// ---------------------------------------------------------------- the encoder, for tests and fixtures

const enc = { v: (out, n) => { do { let c = n & 0x7f; n = Math.floor(n / 128); if (n) c |= 0x80; out.push(c); } while (n); }, zz: (n) => (n < 0 ? -2 * n - 1 : 2 * n) };
function field(out, f, wire, body) {
  enc.v(out, (f << 3) | wire);
  if (wire === 2) { enc.v(out, body.length); for (const b of body) out.push(b); } else enc.v(out, body);
}
/** Build a tile from { layerName: { extent?, features: [{ id?, type, props, geom: [[[x,y],...]] }] } } (closes polygons). */
export function encodeTile(layers) {
  const tile = [];
  for (const [name, L] of Object.entries(layers)) {
    const keys = [], values = [], keyIx = new Map(), valIx = new Map();
    const lay = [];
    field(lay, 15, 0, 2);
    field(lay, 1, 2, [...new TextEncoder().encode(name)]);
    for (const ft of L.features) {
      const fb = [];
      if (ft.id != null) field(fb, 1, 0, ft.id);
      const tags = [];
      for (const [k, v] of Object.entries(ft.props ?? {})) {
        if (!keyIx.has(k)) { keyIx.set(k, keys.length); keys.push(k); }
        const vk = typeof v + ':' + String(v);
        if (!valIx.has(vk)) { valIx.set(vk, values.length); values.push(v); }
        enc.v(tags, keyIx.get(k)); enc.v(tags, valIx.get(vk));
      }
      field(fb, 2, 2, tags);
      field(fb, 3, 0, ft.type);
      const g = [];
      let x = 0, y = 0;
      for (const part of ft.geom) {
        const pts = ft.type === GEOM.POLYGON && part.length > 1 && part[0][0] === part.at(-1)[0] && part[0][1] === part.at(-1)[1] ? part.slice(0, -1) : part;
        enc.v(g, (1 << 3) | 1); enc.v(g, enc.zz(pts[0][0] - x)); enc.v(g, enc.zz(pts[0][1] - y)); x = pts[0][0]; y = pts[0][1];
        if (pts.length > 1) { enc.v(g, ((pts.length - 1) << 3) | 2); for (let i = 1; i < pts.length; i++) { enc.v(g, enc.zz(pts[i][0] - x)); enc.v(g, enc.zz(pts[i][1] - y)); x = pts[i][0]; y = pts[i][1]; } }
        if (ft.type === GEOM.POLYGON) enc.v(g, (1 << 3) | 7);
      }
      field(fb, 4, 2, g);
      field(lay, 2, 2, fb);
    }
    for (const k of keys) field(lay, 3, 2, [...new TextEncoder().encode(k)]);
    for (const v of values) {
      const vb = [];
      if (typeof v === 'string') field(vb, 1, 2, [...new TextEncoder().encode(v)]);
      else if (typeof v === 'boolean') field(vb, 7, 0, v ? 1 : 0);
      else if (Number.isInteger(v) && v >= 0) field(vb, 5, 0, v);
      else if (Number.isInteger(v)) field(vb, 6, 0, enc.zz(v));
      else { const b = Buffer.alloc(8); b.writeDoubleLE(v); enc.v(vb, (3 << 3) | 1); vb.push(...b); }
      field(lay, 4, 2, vb);
    }
    field(lay, 5, 0, L.extent ?? 4096);
    field(tile, 3, 2, lay);
  }
  return new Uint8Array(tile);
}
