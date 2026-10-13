// THE STREET MAP (docs/PLAN-WEATHER-GLOBE.md, part B; operator, 2026-10-13: "can we add street level detail?"). Draws
// the OpenStreetMap-derived vector tiles the server serves from the operator's own extract (/weather/vtile/z/x/y.mvt,
// http/vtiles.js; made by scripts/map-extract.mjs) on the flat map's 2D canvas, in the monitor's dark style, under the
// radar. Layers are Protomaps Basemap v4's: earth, landuse, water, buildings, roads, boundaries, places, pois -- each
// feature carries a `kind`. Decoding is mvt.js (pure); this file owns the fetching, the cache and the drawing.
//
// No clip: a tile's features run a little past its edge (the spec's buffer) and are simply drawn; neighbours' fills
// match and a road's end overlaps its own continuation by a few pixels. No globalAlpha, no composite modes.
import { decodeTile, GEOM } from './mvt.js';
import { placeLabels, flatUnproject } from './weathermap.js';

const PENDING_MAX = 12;
const CACHE_MAX = 400;

/** A decoded tile from the cache or the server; null while loading or where the extract has none. */
export function streetTile(st, z, x, y) {
  const key = `${z}/${x}/${y}`;
  const c = st.vtiles ?? (st.vtiles = new Map());
  const hit = c.get(key);
  if (hit) return hit.tile;
  if ((st.vpending ?? 0) >= PENDING_MAX) return null;
  const rec = { tile: null, state: 'loading' };
  c.set(key, rec);
  st.vpending = (st.vpending ?? 0) + 1;
  fetch(`/weather/vtile/${z}/${x}/${y}.mvt`, { credentials: 'same-origin' }).then(async (r) => {
    if (r.status === 204) { rec.state = 'empty'; rec.tile = { layers: {}, empty: true }; return; }
    if (!r.ok) { rec.state = 'failed'; c.delete(key); return; }
    const bytes = new Uint8Array(await r.arrayBuffer());
    try { rec.tile = decodeTile(bytes); rec.state = 'ok'; } catch (e) {
      // a tile this decoder cannot read is skipped, not refetched: the record stays, empty, and the gap shows
      rec.state = 'bad'; rec.tile = { layers: {}, empty: true }; console.warn(`street tile ${key}: ${e?.message ?? e}`);
    }
  }).catch(() => { rec.state = 'failed'; c.delete(key); }).finally(() => {
    st.vpending--;
    st.dirty = true; st.schedule?.();
    while (c.size > CACHE_MAX) c.delete(c.keys().next().value);
  });
  return null;
}

// ---------------------------------------------------------------- the style

const LANDUSE = {
  park: '#1a2e2a', forest: '#182a26', wood: '#182a26', grass: '#1b2d28', golf_course: '#1a2e2a', cemetery: '#1d2b2a', garden: '#1a2e2a', nature_reserve: '#182a26', recreation_ground: '#1b2d28', pitch: '#1c2f2a',
  residential: '#1b2535', neighbourhood: '#1b2535', commercial: '#232838', retail: '#232838', industrial: '#242734', railway: '#22262f', military: '#262432',
  hospital: '#2a2733', school: '#262a39', university: '#262a39', college: '#262a39', farmland: '#1c2823', farmyard: '#1c2823', orchard: '#182a26', vineyard: '#1c2a24', wetland: '#162634', beach: '#2a2a28', glacier: '#2a3340', aerodrome: '#22262f', runway: '#3a3f4a', pedestrian: '#262c3a',
};
const WATER_FILL = '#0c1830';
const ROAD = {
  highway: { casing: '#3b2d10', line: '#d9a64a', w: [1.2, 2.4, 4, 6], minZ: 5 },
  major_road: { casing: '#2e2a1c', line: '#b89b63', w: [0.8, 1.6, 2.8, 4.5], minZ: 8 },
  medium_road: { casing: '#23262e', line: '#8d8f96', w: [0.6, 1.2, 2.2, 3.5], minZ: 11 },
  minor_road: { casing: '#1f222a', line: '#5c6372', w: [0, 0.8, 1.6, 2.8], minZ: 12 },
  path: { casing: null, line: '#4a5262', w: [0, 0, 1, 1.4], minZ: 14, dash: [3, 3] },
  rail: { casing: null, line: '#6a6f7a', w: [0, 0.8, 1.2, 1.6], minZ: 10, dash: [6, 4] },
  ferry: { casing: null, line: '#3a6aa8', w: [0, 0.8, 1, 1.2], minZ: 10, dash: [4, 6] },
  aerialway: { casing: null, line: '#7a7a8a', w: [0, 0.8, 1, 1], minZ: 12, dash: [2, 4] },
  other: { casing: null, line: '#4a5060', w: [0, 0.6, 1, 1.4], minZ: 13 },
};
const ROAD_ORDER = ['other', 'path', 'ferry', 'aerialway', 'rail', 'minor_road', 'medium_road', 'major_road', 'highway'];
const widthAt = (spec, z) => spec.w[z <= 10 ? 0 : z <= 12 ? 1 : z <= 14 ? 2 : 3];

// ---------------------------------------------------------------- drawing

/**
 * Draw the tiles under a flat view: `fv` is weathermap.flatView, `tz` the tile zoom to draw (the extract's at most),
 * `tiles` the list from weathermap.flatTiles at that zoom, each { z, x, y, px, py } with `scale` panel px a tile.
 * Returns how many tiles are still loading.
 */
export function drawStreets(ctx, st, fv, tz, tiles, scale, pw, ph) {
  st.streetFv = fv;
  let loading = 0;
  const z = fv.z;
  const decoded = [];
  for (const t of tiles) {
    const tile = streetTile(st, tz, t.x, t.y);
    if (!tile) { loading++; continue; }
    if (tile.empty) continue;
    decoded.push({ t, tile });
  }
  const pathOf = (parts, extent, t, closeRings) => {
    const k = scale / extent;
    for (const part of parts) {
      for (let i = 0; i < part.length; i++) {
        const x = t.px + part[i][0] * k, y = t.py + part[i][1] * k;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (closeRings) ctx.closePath();
    }
  };
  const fillLayer = (name, colourOf) => {
    const groups = new Map();
    for (const { t, tile } of decoded) {
      const L = tile.layers[name]; if (!L) continue;
      for (const f of L.features) {
        if (f.type !== GEOM.POLYGON) continue;
        const c = colourOf(f.props, z); if (!c) continue;
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push([f, L.extent, t]);
      }
    }
    for (const [c, list] of groups) { ctx.beginPath(); for (const [f, ex, t] of list) pathOf(f.geom, ex, t, true); ctx.fillStyle = c; ctx.fill('evenodd'); }
  };
  // 1. earth and landuse
  fillLayer('earth', () => '#1b2535');
  fillLayer('landuse', (p) => LANDUSE[p.kind] ?? (p.kind ? '#20273a' : null));
  // 2. water: polygons, then the lines (rivers and streams as lines)
  fillLayer('water', () => WATER_FILL);
  ctx.beginPath();
  for (const { t, tile } of decoded) { const L = tile.layers.water; if (L) for (const f of L.features) if (f.type === GEOM.LINE && (z >= 12 || f.props.kind === 'river')) pathOf(f.geom, L.extent, t, false); }
  ctx.strokeStyle = '#2a4a7a'; ctx.lineWidth = z >= 14 ? 2 : 1.2; ctx.lineCap = 'round'; ctx.stroke();
  // 3. buildings
  if (z >= 13) {
    ctx.beginPath();
    for (const { t, tile } of decoded) { const L = tile.layers.buildings; if (L) for (const f of L.features) if (f.type === GEOM.POLYGON) pathOf(f.geom, L.extent, t, true); }
    ctx.fillStyle = z >= 15 ? '#2c3547' : '#283040'; ctx.fill('evenodd');
    if (z >= 15) { ctx.strokeStyle = '#1a2130'; ctx.lineWidth = 0.6; ctx.stroke(); }
  }
  // 4. roads: casing first for the big ones, then lines, by class from small to large; bridges and tunnels alike
  const byKind = new Map();
  for (const { t, tile } of decoded) {
    const L = tile.layers.roads; if (!L) continue;
    for (const f of L.features) {
      if (f.type !== GEOM.LINE) continue;
      const kind = ROAD[f.props.kind] ? f.props.kind : 'other';
      const spec = ROAD[kind];
      if (z < spec.minZ) continue;
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push([f, L.extent, t]);
    }
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const kind of ROAD_ORDER) {
    const list = byKind.get(kind); if (!list) continue;
    const spec = ROAD[kind], w = widthAt(spec, z);
    if (!(w > 0)) continue;
    if (spec.casing && w >= 2) { ctx.beginPath(); for (const [f, ex, t] of list) pathOf(f.geom, ex, t, false); ctx.strokeStyle = spec.casing; ctx.lineWidth = w + 1.6; ctx.stroke(); }
  }
  for (const kind of ROAD_ORDER) {
    const list = byKind.get(kind); if (!list) continue;
    const spec = ROAD[kind], w = widthAt(spec, z);
    if (!(w > 0)) continue;
    ctx.beginPath(); for (const [f, ex, t] of list) pathOf(f.geom, ex, t, false);
    ctx.strokeStyle = spec.line; ctx.lineWidth = w; if (spec.dash) ctx.setLineDash(spec.dash); ctx.stroke(); ctx.setLineDash([]);
  }
  // 5. boundaries
  ctx.beginPath();
  for (const { t, tile } of decoded) { const L = tile.layers.boundaries; if (L) for (const f of L.features) if (f.type === GEOM.LINE && (f.props.kind === 'country' || (z >= 8 && f.props.kind === 'region'))) pathOf(f.geom, L.extent, t, false); }
  ctx.strokeStyle = 'rgba(215,228,250,.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);
  // 6. names: places and, close in, points of interest and the roads
  drawStreetLabels(ctx, st, z, decoded, scale, pw, ph);
  return loading;
}

const PLACE_FONT = { country: '650 13px', region: '600 12px', locality: '600 12px', neighbourhood: '500 11px', other: '500 10.5px' };
function drawStreetLabels(ctx, st, z, decoded, scale, pw, ph) {
  const items = [];
  const font = (p) => `${PLACE_FONT[p.kind] ?? PLACE_FONT.other} system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const { t, tile } of decoded) {
    const L = tile.layers.places;
    if (L) for (const f of L.features) {
      if (f.type !== GEOM.POINT || !f.props.name) continue;
      if (f.props.min_zoom != null && f.props.min_zoom > z + 0.5) continue;
      const k = scale / L.extent;
      const x = t.px + f.geom[0][0][0] * k, y = t.py + f.geom[0][0][1] * k;
      ctx.font = font(f.props);
      const w = ctx.measureText(f.props.name).width;
      items.push({ x: x - w / 2 - 3, y: y - 8, w: w + 6, h: 16, text: f.props.name, cx: x, cy: y, font: ctx.font, rank: f.props.kind === 'locality' ? 1 : f.props.kind === 'neighbourhood' ? 2 : 0, dot: f.props.kind === 'locality', place: true });
    }
    const P = tile.layers.pois;
    if (P && z >= 15) for (const f of P.features) {
      if (f.type !== GEOM.POINT || !f.props.name) continue;
      if (f.props.min_zoom != null && f.props.min_zoom > z) continue;
      const k = scale / P.extent;
      const x = t.px + f.geom[0][0][0] * k, y = t.py + f.geom[0][0][1] * k;
      ctx.font = '500 10px system-ui, sans-serif';
      const w = ctx.measureText(f.props.name).width;
      items.push({ x: x - w / 2 - 3, y: y - 7, w: w + 6, h: 14, text: f.props.name, cx: x, cy: y, font: ctx.font, rank: 4, poi: true });
    }
    const R = tile.layers.roads;
    if (R && z >= 14) for (const f of R.features) {
      if (f.type !== GEOM.LINE || !f.props.name || !['highway', 'major_road', 'medium_road', 'minor_road'].includes(f.props.kind)) continue;
      // the longest part, laid along the straightest run in it: a name needs more room than its own width
      const k = scale / R.extent;
      let best = null;
      for (const part of f.geom) {
        let len = 0;
        for (let i = 1; i < part.length; i++) len += Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]) * k;
        if (!best || len > best.len) best = { part, len };
      }
      if (!best) continue;
      ctx.font = '500 10px system-ui, sans-serif';
      const w = ctx.measureText(f.props.name).width;
      if (best.len < w + 24) continue;
      // the point halfway along the part, and the direction there
      let half = best.len / 2, px = 0, py = 0, ang = 0;
      for (let i = 1; i < best.part.length; i++) {
        const ax = t.px + best.part[i - 1][0] * k, ay = t.py + best.part[i - 1][1] * k, bx = t.px + best.part[i][0] * k, by = t.py + best.part[i][1] * k;
        const seg = Math.hypot(bx - ax, by - ay);
        if (seg >= half) { const u = seg ? half / seg : 0; px = ax + (bx - ax) * u; py = ay + (by - ay) * u; ang = Math.atan2(by - ay, bx - ax); break; }
        half -= seg;
      }
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      items.push({ x: px - w / 2, y: py - 6, w, h: 12, text: f.props.name, cx: px, cy: py, ang, font: ctx.font, rank: 3, road: true });
    }
  }
  items.sort((a, b) => a.rank - b.rank);
  for (const it of placeLabels(items, pw, ph, 4)) {
    // a place name is a double-click target (weatherglobe.js): its coordinates from the panel pixel through the view
    if (it.place && st.labelHits && st.streetFv) { const ll = flatUnproject(it.cx, it.cy, st.streetFv); st.labelHits.push({ x: it.x, y: it.y, w: it.w, h: it.h, lat: ll.lat, lon: ll.lon, name: it.text }); }
    ctx.font = it.font;
    ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(8,12,22,.85)';
    if (it.road) {
      ctx.save(); ctx.translate(it.cx, it.cy); ctx.rotate(it.ang); ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(225,230,240,.85)'; ctx.strokeText(it.text, 0, 0); ctx.fillText(it.text, 0, 0); ctx.restore();
      continue;
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = it.poi ? 'rgba(200,215,235,.8)' : '#ffffff';
    if (it.dot) { ctx.beginPath(); ctx.arc(it.cx, it.cy, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeText(it.text, it.cx, it.cy + (it.dot ? -9 : 0)); ctx.fillText(it.text, it.cx, it.cy + (it.dot ? -9 : 0));
  }
}
