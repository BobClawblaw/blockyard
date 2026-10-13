// THE WEATHER GLOBE'S MATHS (docs/PLAN-WEATHER-GLOBE.md; operator, 2026-10-13: "a zoomable view of the area centered
// around the users location ... weather radar animations ... zooming in and out and rotating to see global weather").
//
// Pure: typed arrays in, typed arrays out, no DOM, no canvas, no clock. Everything the globe shows is ONE
// equirectangular picture (W x H, lon -180..180 across, lat 90..-90 down) that weatherglobe.js assembles from these
// parts -- the land mask, a radar frame's mercator tiles resampled row by row, a forecast hour interpolated from the
// grid -- and the globe itself is the orthographic INVERSE of each panel pixel into that picture (orthoRender). One
// code path for every layer and no horizon clipping of polygons. Past a zoom the view flattens into web mercator
// (flatView), where the tiles are drawn as they are.

import { tempColour } from './weather.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// ------------------------------------------------------------------ web mercator tiles

/** Tile x (fractional) of a longitude at zoom z, and y of a latitude; the inverses. */
export const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export function tileY(lat, z) {
  const s = Math.sin(clamp(lat, -85.0511, 85.0511) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}
export const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * R2D;

/**
 * Resample a mercator raster (the world at zoom z as a square of 256 * 2^z pixels, RGBA) into an equirectangular
 * one of W x H. Columns map straight (both are linear in longitude); each equirect row takes one mercator row.
 * Rows above 85 degrees, which mercator does not have, stay as they were in `dst`.
 */
export function mercatorToEquirect(src, size, dst, W, H) {
  const z = Math.log2(size / 256);
  for (let y = 0; y < H; y++) {
    const lat = 90 - ((y + 0.5) / H) * 180;
    if (Math.abs(lat) > 85.0511) continue;
    const sy = clamp(Math.floor((tileY(lat, z) / 2 ** z) * size), 0, size - 1);
    const srow = sy * size * 4, drow = y * W * 4;
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(((x + 0.5) / W) * size);
      const si = srow + sx * 4, di = drow + x * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
  }
  return dst;
}

// ------------------------------------------------------------------ the land

/**
 * Rasterise the coastline file's polygons (rings as flat [lon, lat, ...] in hundredths of a degree, holes after
 * their outer ring) into a W x H mask: 1 where there is land. Scanline, even-odd, so holes (the Caspian) come out
 * as sea. 127 polygons and 5,000 points into 2048 x 1024 is ~20 ms in node.
 */
export function rasterLand(data, W, H) {
  const mask = new Uint8Array(W * H);
  const k = data.scale ?? 100;
  const X = (lon) => ((lon / k + 180) / 360) * W;
  const Y = (lat) => ((90 - lat / k) / 180) * H;
  const xs = [];
  for (const rings of data.polygons) {
    // every ring of the polygon together, even-odd: a hole's crossings cancel the outer ring's
    const edges = [];
    for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = X(r[2 * i]), y0 = Y(r[2 * i + 1]), x1 = X(r[2 * j]), y1 = Y(r[2 * j + 1]);
        if (y0 !== y1) edges.push(y0 < y1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0]);
      }
    }
    if (!edges.length) continue;
    let yMin = Infinity, yMax = -Infinity;
    for (const e of edges) { if (e[1] < yMin) yMin = e[1]; if (e[3] > yMax) yMax = e[3]; }
    for (let y = Math.max(0, Math.floor(yMin)); y < Math.min(H, Math.ceil(yMax)); y++) {
      const cy = y + 0.5;
      xs.length = 0;
      for (const [x0, y0, x1, y1] of edges) if (cy >= y0 && cy < y1) xs.push(x0 + ((cy - y0) * (x1 - x0)) / (y1 - y0));
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const a = Math.max(0, Math.round(xs[i])), b = Math.min(W, Math.round(xs[i + 1]));
        for (let x = a; x < b; x++) mask[y * W + x] = 1;
      }
    }
  }
  return mask;
}

/** Cut the lakes out of a land mask (the land file's `water` rings), the same scanline fill. */
export function cutWater(mask, data, W, H) {
  if (!data.water?.length) return mask;
  const inv = rasterLand({ scale: data.scale, polygons: data.water.map((r) => [r]) }, W, H);
  for (let i = 0; i < mask.length; i++) if (inv[i]) mask[i] = 0;
  return mask;
}

/**
 * Draw polylines (flat [lon, lat, ...] in hundredths of a degree) into an RGBA equirect picture, one pixel wide
 * (Bresenham), blending `rgba` over what is there. A line that jumps more than half the world is the antimeridian
 * seam and is not drawn across.
 */
export function rasterLines(lines, k, W, H, dst, rgba) {
  const [r, g, b, a] = rgba, al = a / 255;
  const plot = (x, y) => {
    if (y < 0 || y >= H) return;
    const o = ((y * W) + ((x % W) + W) % W) * 4;
    dst[o] += (r - dst[o]) * al; dst[o + 1] += (g - dst[o + 1]) * al; dst[o + 2] += (b - dst[o + 2]) * al; dst[o + 3] = 255;
  };
  for (const l of lines) {
    for (let i = 2; i < l.length; i += 2) {
      let x0 = Math.round(((l[i - 2] / k + 180) / 360) * W), y0 = Math.round(((90 - l[i - 1] / k) / 180) * H);
      let x1 = Math.round(((l[i] / k + 180) / 360) * W), y1 = Math.round(((90 - l[i + 1] / k) / 180) * H);
      if (Math.abs(x1 - x0) > W / 2) continue;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        plot(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
  }
  return dst;
}

/**
 * Expand a delta-encoded line from features-10m.json ([rank, x0, y0, dx, dy, ...], hundredths of a degree) into
 * absolute coordinates with its bounding box: { rank, pts (flat [lon, lat, ...] in hundredths), minX, minY, maxX, maxY }.
 */
export function undelta(line, ranked = true) {
  const pts = [];
  let x = 0, y = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = ranked ? 1 : 0; i + 1 < line.length; i += 2) {
    x += line[i]; y += line[i + 1];
    pts.push(x, y);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { rank: ranked ? line[0] : 0, pts, minX, minY, maxX, maxY };
}
/** The whole features file expanded once: roads by class, rails, rivers, urban rings. */
export function expandFeatures(f) {
  return {
    scale: f.scale ?? 100,
    roads: { major: f.roads.major.map((l) => undelta(l)), secondary: f.roads.secondary.map((l) => undelta(l)), minor: f.roads.minor.map((l) => undelta(l)) },
    rails: f.rails.map((l) => undelta(l)),
    rivers: f.rivers.map((l) => undelta(l)),
    urban: f.urban.map((l) => undelta(l, false)),
  };
}
/** Which feature layers draw at a tile zoom, and the rank each admits (Natural Earth scalerank: lower is bigger). */
export function featureLevels(z) {
  return {
    urban: z >= 6, rivers: z >= 4 ? (z >= 7 ? 12 : z >= 6 ? 8 : 4) : -1,
    major: z >= 5 ? 12 : -1, secondary: z >= 7 ? 12 : -1, minor: z >= 8 ? (z >= 10 ? 12 : 6) : -1, rails: z >= 8 ? 12 : -1,
  };
}

/** The places worth a name at a tile zoom: a rank ceiling that opens up as the map comes closer (places-10m.json rows). */
export function rankCeiling(z) { return z <= 2 ? 1 : z <= 4 ? 3 : z <= 6 ? 5 : z <= 8 ? 8 : 10; }
/**
 * Lay out labels without overlaps, biggest first: `items` are { x, y, w, h, ... } in panel pixels (the label's box),
 * already sorted by importance. Returns those that fit, greedily.
 */
export function placeLabels(items, pw, ph, pad = 2) {
  const kept = [];
  for (const it of items) {
    if (it.x + it.w < 0 || it.x > pw || it.y + it.h < 0 || it.y > ph) continue;
    let clash = false;
    for (const k of kept) if (it.x < k.x + k.w + pad && it.x + it.w + pad > k.x && it.y < k.y + k.h + pad && it.y + it.h + pad > k.y) { clash = true; break; }
    if (!clash) kept.push(it);
  }
  return kept;
}

/** Paint the base picture: sea and land (and the sea slightly lighter where the mask's neighbour is land: a shore). */
export function paintBase(mask, W, H, dst, { sea = [12, 24, 48], land = [44, 58, 76], shore = [38, 66, 104] } = {}) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4;
    let c = land;
    if (!mask[i]) {
      c = sea;
      if ((x > 0 && mask[i - 1]) || (x + 1 < W && mask[i + 1]) || (y > 0 && mask[i - W]) || (y + 1 < H && mask[i + W])) c = shore;
    }
    dst[o] = c[0]; dst[o + 1] = c[1]; dst[o + 2] = c[2]; dst[o + 3] = 255;
  }
  return dst;
}

/** Lay `over` (RGBA, straight alpha) on `base` into `dst`, at `strength`. */
export function composite(base, over, dst, strength = 1) {
  for (let i = 0; i < dst.length; i += 4) {
    const a = (over[i + 3] / 255) * strength;
    if (a <= 0) { dst[i] = base[i]; dst[i + 1] = base[i + 1]; dst[i + 2] = base[i + 2]; dst[i + 3] = base[i + 3]; continue; }
    dst[i] = base[i] + (over[i] - base[i]) * a;
    dst[i + 1] = base[i + 1] + (over[i + 1] - base[i + 1]) * a;
    dst[i + 2] = base[i + 2] + (over[i + 2] - base[i + 2]) * a;
    dst[i + 3] = 255;
  }
  return dst;
}

// ------------------------------------------------------------------ the view

/** The view's state: the place under the middle of the panel, and the zoom (1 = the whole globe fits). */
export const ZOOM_MAX = 4096;   // zoom 12 tiles on a small panel need ~600; room past that is harmless (the tiles stop at TILE_ZOOM_MAX)
export const viewOf = (lat, lon, zoom = 1) => ({ lat: clamp(lat, -89, 89), lon: wrapLon(lon), zoom: clamp(zoom, 0.6, ZOOM_MAX) });
/** The sphere's radius in panel pixels at this view. */
export const sphereRadius = (view, pw, ph) => (Math.min(pw, ph) / 2 - 8) * view.zoom;
/** Past this the sphere is wider than three panels and the view is a flat map (`flatView`). */
export const FLAT_FROM = 3.2;
export const isFlat = (view, pw, ph) => (2 * sphereRadius(view, pw, ph)) / Math.min(pw, ph) > FLAT_FROM;

/** Turn the globe by a drag of (dx, dy) pixels: a pixel moves the surface by one pixel at the sphere's radius. */
export function dragView(view, dx, dy, pw, ph) {
  const R = sphereRadius(view, pw, ph);
  const per = R2D / R;
  return viewOf(view.lat + dy * per, view.lon - (dx * per) / Math.max(0.2, Math.cos(view.lat * D2R)), view.zoom);
}
export const zoomView = (view, factor) => viewOf(view.lat, view.lon, view.zoom * factor);

/**
 * Draw the globe: for each pixel of a pw x ph panel, the orthographic inverse into the W x H equirect picture
 * (nearest sample), limb-darkened, with a faint atmosphere just outside the disc. `out` is RGBA pw x ph.
 */
export function orthoRender(pic, W, H, out, pw, ph, view, { smooth = false } = {}) {
  const R = sphereRadius(view, pw, ph);
  const cx = pw / 2, cy = ph / 2;
  const lat0 = view.lat * D2R, lon0 = view.lon;
  const sinLat0 = Math.sin(lat0), cosLat0 = Math.cos(lat0);
  const R2 = R * R, halo = R + Math.max(3, R * 0.03), halo2 = halo * halo;
  for (let py = 0; py < ph; py++) {
    const yy = -(py + 0.5 - cy);
    for (let px = 0; px < pw; px++) {
      const xx = px + 0.5 - cx;
      const o = (py * pw + px) * 4;
      const d2 = xx * xx + yy * yy;
      if (d2 > R2) {
        // the atmosphere: a blue rim fading out over 3% of the radius
        if (d2 < halo2) { const t = 1 - (Math.sqrt(d2) - R) / (halo - R); out[o] = 90; out[o + 1] = 150; out[o + 2] = 255; out[o + 3] = Math.round(120 * t * t); } else out[o + 3] = 0;
        continue;
      }
      const x = xx / R, y = yy / R, z = Math.sqrt(1 - (d2 / R2));
      const lat = Math.asin(clamp(y * cosLat0 + z * sinLat0, -1, 1));
      const lon = lon0 + Math.atan2(x, z * cosLat0 - y * sinLat0) * R2D;
      const fx = ((wrapLon(lon) + 180) / 360) * W - 0.5, fy = ((90 - lat * R2D) / 180) * H - 0.5;
      const shade = 0.55 + 0.45 * z;   // the limb darkens; the middle is lit
      if (smooth) {
        // bilinear: the four texels round the point, longitude wrapping round the seam (the GL path samples LINEAR too)
        const x0 = Math.floor(fx), y0 = clamp(Math.floor(fy), 0, H - 1), y1 = Math.min(H - 1, y0 + 1);
        const tx = fx - x0, ty = clamp(fy - y0, 0, 1);
        const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W;
        const a = (y0 * W + xa) * 4, b = (y0 * W + xb) * 4, c = (y1 * W + xa) * 4, d = (y1 * W + xb) * 4;
        for (let k = 0; k < 3; k++) {
          const top = pic[a + k] + (pic[b + k] - pic[a + k]) * tx, bot = pic[c + k] + (pic[d + k] - pic[c + k]) * tx;
          out[o + k] = (top + (bot - top) * ty) * shade;
        }
      } else {
        const sx = clamp(Math.floor(fx + 0.5), 0, W - 1), sy = clamp(Math.floor(fy + 0.5), 0, H - 1);
        const s = (sy * W + sx) * 4;
        out[o] = pic[s] * shade; out[o + 1] = pic[s + 1] * shade; out[o + 2] = pic[s + 2] * shade;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The panel pixel of a lat/lon on the globe, or null when it is on the far side. */
export function orthoProject(lat, lon, pw, ph, view) {
  const R = sphereRadius(view, pw, ph);
  const la = lat * D2R, dl = (lon - view.lon) * D2R, la0 = view.lat * D2R;
  const cosc = Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(dl);
  if (cosc < 0) return null;
  const x = Math.cos(la) * Math.sin(dl);
  const y = Math.cos(la0) * Math.sin(la) - Math.sin(la0) * Math.cos(la) * Math.cos(dl);
  return { x: pw / 2 + x * R, y: ph / 2 - y * R, depth: cosc };
}

// ------------------------------------------------------------------ the flat map

/**
 * The flat (web mercator) view: the tile zoom to draw at, the scale in panel pixels per tile, and the world
 * pixel at the panel's top-left. Zoom 1 of the globe is a sphere of radius R; the flat map continues its scale.
 */
/** The view zoom that draws the flat map at tile zoom `z` (the inverse of flatView's z). */
export function zoomForTileZ(z, pw, ph) {
  const R1 = Math.min(pw, ph) / 2 - 8;            // the sphere's radius at zoom 1
  return (256 * 2 ** z) / (2 * Math.PI * R1);
}
/** The HOME view: the place at the scale of its surrounding towns (tile zoom 11: about 75 km across a wide panel). */
export const HOME_TILE_Z = 11;
export const homeView = (lat, lon, pw, ph) => viewOf(lat, lon, zoomForTileZ(HOME_TILE_Z, pw, ph));
/** Metres per panel pixel of a flat view at a latitude (web mercator's scale varies with cos(lat)). */
export const metresPerPixel = (fv, lat) => (40_075_016.686 * Math.cos(lat * D2R)) / fv.worldPx;
/** A scale bar's length: the nicest round distance under `maxPx` pixels, in metres, with its label. */
export function scaleBar(fv, lat, maxPx = 160, units = 'metric') {
  const mpp = metresPerPixel(fv, lat);
  const steps = units === 'imperial' ? [100, 200, 500, 1000, 1609.344, 3218.688, 8046.72, 16093.44, 32186.88, 80467.2, 160934.4, 321868.8, 804672, 1609344] : [100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000];
  let m = steps[0];
  for (const v of steps) if (v / mpp <= maxPx) m = v;
  const label = units === 'imperial' ? (m < 1609 ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m / 1609.344)} mi`) : (m < 1000 ? `${m} m` : `${m / 1000} km`);
  return { metres: m, px: m / mpp, label };
}
/** The distance rings to draw round the place at this scale: radii in metres that fit the panel, up to four. */
export function ringRadii(fv, lat, pw, ph, units = 'metric') {
  const mpp = metresPerPixel(fv, lat);
  const half = Math.min(pw, ph) / 2;
  const base = units === 'imperial' ? [1609.344, 3218.688, 8046.72, 16093.44, 32186.88, 80467.2, 160934.4, 321868.8, 804672] : [1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000];
  const fit = base.filter((m) => m / mpp >= 24 && m / mpp <= half * 0.95);
  return fit.slice(-4).map((m) => ({ metres: m, px: m / mpp, label: units === 'imperial' ? `${Math.round(m / 1609.344)} mi` : `${m / 1000} km` }));
}
export function flatView(view, pw, ph, zoomMax = 12) {
  const R = sphereRadius(view, pw, ph);
  // the globe's scale at the equator in px/degree, as a mercator "world width": 2 pi R
  const worldPx = 2 * Math.PI * R;
  const z = clamp(Math.floor(Math.log2(worldPx / 256)), 0, zoomMax);
  const scale = worldPx / 2 ** z;                // panel pixels per tile at zoom z
  const cxW = tileX(view.lon, z) * scale, cyW = tileY(view.lat, z) * scale;
  return { z, scale, worldPx, left: cxW - pw / 2, top: cyW - ph / 2 };
}
/** The tiles a flat view needs: { z, x, y, px, py } (px, py the panel pixel of the tile's top-left), x wrapped. */
export function flatTiles(fv, pw, ph) {
  const n = 2 ** fv.z, out = [];
  const x0 = Math.floor(fv.left / fv.scale), x1 = Math.floor((fv.left + pw) / fv.scale);
  const y0 = Math.max(0, Math.floor(fv.top / fv.scale)), y1 = Math.min(n - 1, Math.floor((fv.top + ph) / fv.scale));
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push({ z: fv.z, x: ((tx % n) + n) % n, y: ty, px: tx * fv.scale - fv.left, py: ty * fv.scale - fv.top });
  return out;
}
export const flatProject = (lat, lon, fv) => ({ x: tileX(lon, fv.z) * fv.scale - fv.left, y: tileY(lat, fv.z) * fv.scale - fv.top });
/** The lat/lon under a panel pixel of a flat view. */
export const flatUnproject = (px, py, fv) => ({ lat: tileLat((fv.top + py) / fv.scale, fv.z), lon: wrapLon(tileLon((fv.left + px) / fv.scale, fv.z)) });

// ------------------------------------------------------------------ the forecast grid

/** A sampler of one field of the grid at one hour: (lat, lon) -> bilinear value, or null off the grid or in a hole. */
export function gridSampler(grid, hour, key) {
  const { n, lat0, lon0, dLat, dLon } = grid;
  const f = grid.fields?.[key];
  if (!f) return () => null;
  const base = hour * n * n;
  return (lat, lon) => {
    const r = (lat - lat0) / dLat;
    let dl = lon - lon0;
    if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    const c = dl / dLon;
    if (r < 0 || c < 0 || r > n - 1 || c > n - 1) return null;
    const r0 = Math.min(n - 2, Math.floor(r)), c0 = Math.min(n - 2, Math.floor(c));
    const fr = r - r0, fc = c - c0;
    const v00 = f[base + r0 * n + c0], v01 = f[base + r0 * n + c0 + 1], v10 = f[base + (r0 + 1) * n + c0], v11 = f[base + (r0 + 1) * n + c0 + 1];
    if (v00 == null || v01 == null || v10 == null || v11 == null) return null;
    return (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr;
  };
}
/** The grid's bounds in the equirect picture: rows and columns to paint. */
export function gridBounds(grid, W, H) {
  const { n, lat0, lon0, dLat, dLon } = grid;
  const latN = lat0 + (n - 1) * dLat, lonE = lon0 + (n - 1) * dLon;
  const y0 = clamp(Math.floor(((90 - latN) / 180) * H), 0, H - 1), y1 = clamp(Math.ceil(((90 - lat0) / 180) * H), 0, H);
  const x0 = Math.floor(((lon0 + 180) / 360) * W), x1 = Math.ceil(((lonE + 180) / 360) * W);
  return { x0, x1, y0, y1 };
}

/** Rain: a blue-to-violet ramp in mm/h (or in/h x 25.4), transparent under a drizzle. */
export function rainColour(mm) {
  if (!(mm > 0.04)) return [0, 0, 0, 0];
  const t = clamp(Math.log10(mm / 0.04) / Math.log10(25 / 0.04), 0, 1);   // 0.04 mm .. 25 mm an hour
  const stops = [[0, [110, 200, 255, 70]], [0.3, [60, 140, 255, 150]], [0.55, [40, 200, 120, 200]], [0.75, [250, 220, 60, 225]], [0.9, [255, 110, 50, 240]], [1, [255, 60, 190, 255]]];
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
  const [t0, a] = stops[i], [t1, b] = stops[i + 1];
  const f = (t - t0) / (t1 - t0);
  return a.map((v, k) => Math.round(v + (b[k] - v) * f));
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/**
 * Paint one forecast hour of the grid into an RGBA overlay (W x H equirect, straight alpha), zero outside the grid:
 * rain as the ramp above, or temperature as weather.js's scale at a fixed alpha, or cloud as white haze.
 */
export function paintGrid(grid, hour, field, dst, W, H) {
  const sample = gridSampler(grid, hour, field);
  const { x0, x1, y0, y1 } = gridBounds(grid, W, H);
  const units = grid.units ?? 'metric';
  const tempCache = new Map();
  for (let y = y0; y < y1; y++) {
    const lat = 90 - ((y + 0.5) / H) * 180;
    for (let xi = x0; xi < x1; xi++) {
      const x = ((xi % W) + W) % W;
      const lon = ((x + 0.5) / W) * 360 - 180;
      const v = sample(lat, lon);
      const o = (y * W + x) * 4;
      if (v == null) { dst[o + 3] = 0; continue; }
      let c;
      if (field === 'precip') c = rainColour(units === 'imperial' ? v * 25.4 : v);
      else if (field === 'temp') { const k = Math.round(v); let rgb = tempCache.get(k); if (!rgb) { rgb = hex(tempColour(k, units)); tempCache.set(k, rgb); } c = [rgb[0], rgb[1], rgb[2], 165]; }
      else if (field === 'cloud') c = [235, 240, 250, Math.round(clamp(v, 0, 100) * 1.6)];
      else c = [0, 0, 0, 0];
      dst[o] = c[0]; dst[o + 1] = c[1]; dst[o + 2] = c[2]; dst[o + 3] = c[3];
    }
  }
  return dst;
}

/** Wind arrows for a flat or globe view: one per grid point, { lat, lon, speed, dir } for the hour. */
export function windPoints(grid, hour) {
  const { n, lat0, lon0, dLat, dLon } = grid;
  const sp = grid.fields?.wind, dr = grid.fields?.windDir;
  if (!sp || !dr) return [];
  const out = [], base = hour * n * n;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = base + r * n + c;
    if (sp[i] == null || dr[i] == null) continue;
    out.push({ lat: lat0 + r * dLat, lon: wrapLon(lon0 + c * dLon), speed: sp[i], dir: dr[i] });
  }
  return out;
}

// ---------------------------------------------------------------- streets for the view (part B, the auto-fetch)

/**
 * What a street-map fetch for this flat view would be, and whether one of `maps` (the server's archives, each with
 * bounds and maxZoom) already covers it: the centre, a radius that holds the panel's half-diagonal (5-150 km), and a
 * zoom two past the view's (10-15) -- enough to zoom in a little without another fetch, not the whole city at 15.
 * `covered` is true when an archive holds the whole view box at that zoom or deeper.
 */
export function streetRequestFor(view, pw, ph, maps = [], zoomMax = 16) {
  const fv = flatView(view, pw, ph, zoomMax);
  const mpp = metresPerPixel(fv, view.lat);
  const halfDiag = (Math.hypot(pw, ph) / 2) * mpp / 1000;
  const radiusKm = Math.round(Math.min(150, Math.max(5, halfDiag * 1.1)));
  const maxzoom = Math.min(15, Math.max(10, fv.z + 2));
  const a = flatUnproject(0, 0, fv), b = flatUnproject(pw, ph, fv);
  const box = { w: Math.min(a.lon, b.lon), e: Math.max(a.lon, b.lon), s: Math.min(a.lat, b.lat), n: Math.max(a.lat, b.lat) };
  const covered = maps.some((m) => m?.bounds && m.maxZoom >= maxzoom && box.w >= m.bounds.w && box.e <= m.bounds.e && box.s >= m.bounds.s && box.n <= m.bounds.n);
  return { lat: Math.round(view.lat * 100) / 100, lon: Math.round(view.lon * 100) / 100, radiusKm, maxzoom, z: fv.z, box, covered };
}
