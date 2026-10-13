// THE WEATHER GLOBE (docs/PLAN-WEATHER-GLOBE.md; operator, 2026-10-13: "a zoomable view of the area centered around
// the users location ... weather radar animations ... zooming in and out and rotating to see global weather" --
// "heck see if we can do it for simple mode too"). The maths are weathermap.js (pure); this file owns the canvases,
// the pointer, the tiles and the clock.
//
// THE PICTURE. One equirectangular RGBA buffer (PW x PH) is the globe's skin: the land mask painted once, and over
// it the layer -- a radar frame's sixteen zoom-2 tiles drawn into an offscreen mercator canvas and resampled, or a
// forecast hour interpolated from the grid. The globe is that picture through the orthographic inverse:
//   Software  -- weathermap.orthoRender into an ImageData (a 600 px globe is ~11 ms), put on the 2D canvas.
//   WebGL     -- the same picture as a texture on a GL canvas under the 2D one; the sphere is ray-cast per pixel in a
//                fragment shader with linear sampling. Falls back to Software where WebGL2 is missing or dies.
//   Simple    -- the Software picture, drawn ONCE per change of view, frame or layer, from no loop: the frame loop
//                plays only while the play button is held down (AGENTS.md, the GPU budget: a looping animation is
//                exactly the repaint the Simple renderer exists to avoid).
// Past weathermap.FLAT_FROM the view flattens into web mercator on the 2D canvas whatever the renderer: the land as
// vector paths, the frame's tiles drawn as they are (zoom <= 7), the forecast sampled per pixel.
//
// THE TILES come from this server (/weather/tile/<frame>/<z>/<x>/<y>.png, a cache in front of RainViewer); the
// current frame's are asked for first, the others prefetched in order, so a loop plays from the browser's own copies.

import { loadSettings } from './settings.js';
import {
  wrapLon, tileX, tileY, mercatorToEquirect, rasterLand, paintBase, composite, viewOf, sphereRadius, isFlat, dragView, zoomView,
  orthoRender, orthoProject, flatView, flatTiles, flatProject, flatUnproject, gridSampler, paintGrid, rainColour, windPoints,
  homeView, scaleBar, ringRadii, cutWater, rasterLines, rankCeiling, placeLabels,
} from './weathermap.js';
import { tempColour } from './weather.js';

const PW = 1536, PH = 768;            // the skin: 0.23 degrees a pixel, about what zoom-2 radar tiles resolve
const RADAR_Z = 2;                    // 4 x 4 tiles of 256 for the whole world on the globe
const FRAME_MS = 280;                 // the loop's pace: thirteen frames in under four seconds
const PIC_CACHE = 8;                  // composited skins kept (one per frame or hour), ~4.7 MB each
const LAND_UNTIL_Z = 10;              // the 1:50m coastline, lakes and borders are drawn on the flat map up to this tile zoom; closer they are too coarse to trust
const states = new WeakMap();

// ------------------------------------------------------------------ WebGL

const VERT = `#version 300 es
in vec2 p; out vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform vec2 uRes; uniform float uR; uniform float uLat0; uniform float uLon0; uniform sampler2D uPic;
const float PI = 3.141592653589793;
void main() {
  vec2 px = (v * 0.5 + 0.5) * uRes;
  float xx = px.x - uRes.x * 0.5, yy = px.y - uRes.y * 0.5;
  float d2 = xx * xx + yy * yy, R2 = uR * uR;
  float halo = uR + max(3.0, uR * 0.03);
  if (d2 > R2) {
    // premultiplied: the canvas composites colour * alpha, so a straight colour at a faint alpha drew a solid band
    if (d2 < halo * halo) { float t = 1.0 - (sqrt(d2) - uR) / (halo - uR); float a = 0.47 * t * t; o = vec4(vec3(0.35, 0.59, 1.0) * a, a); } else o = vec4(0.0);
    return;
  }
  float x = xx / uR, y = yy / uR, z = sqrt(1.0 - d2 / R2);
  float sl = sin(uLat0), cl = cos(uLat0);
  float lat = asin(clamp(y * cl + z * sl, -1.0, 1.0));
  float lon = uLon0 + atan(x, z * cl - y * sl);
  float u = fract((lon + PI) / (2.0 * PI));
  float t = (PI * 0.5 - lat) / PI;
  vec3 c = texture(uPic, vec2(u, t)).rgb * (0.55 + 0.45 * z);
  o = vec4(c, 1.0);
}`;

function glInit(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('weather globe shader:', gl.getShaderInfoLog(s)); return null; } return s; };
  const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const u = { res: gl.getUniformLocation(prog, 'uRes'), R: gl.getUniformLocation(prog, 'uR'), lat0: gl.getUniformLocation(prog, 'uLat0'), lon0: gl.getUniformLocation(prog, 'uLon0'), pic: gl.getUniformLocation(prog, 'uPic') };
  return { gl, prog, tex, u, picKey: null };
}

// ------------------------------------------------------------------ state

function stateOf(root) {
  let st = states.get(root);
  if (st) return st;
  st = {
    root, cv: root.querySelector('canvas.wxg-ui'), glcv: root.querySelector('canvas.wxg-gl'), gl: null, glDead: false,
    view: null, home: null, land: null, base: null, pics: new Map(), skin: new Uint8ClampedArray(PW * PH * 4), over: new Uint8ClampedArray(PW * PH * 4),
    radar: null, radarAt: 0, radarAsking: false, grid: null, gridKey: null, gridAsking: false,
    tiles: new Map(), tilePending: 0, frame: 0, playing: false, playTimer: null, raf: 0, dirty: true,
    pointer: null, pinch: null, lastDraw: '', settings: null, w: null, api: null, say: '',
    merc: null,
  };
  states.set(root, st);
  return st;
}

async function loadLand(st) {
  if (st.land || st.landAsking) return;
  st.landAsking = true;
  try {
    const get = async (f) => { const r = await fetch(`/geo/${f}`, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); };
    // the land first (the picture needs it), the lines and names after (they draw over it when they land)
    const data = await get('land-50m.json');
    st.landData = data;
    st.land = cutWater(rasterLand(data, PW, PH), data, PW, PH);
    st.base = paintBase(st.land, PW, PH, new Uint8ClampedArray(PW * PH * 4));
    st.pics.clear(); st.dirty = true; schedule(st);
    const [lines, places] = await Promise.all([get('lines-50m.json'), get('places-10m.json')]);
    st.lines = lines;
    st.places = places.places;
    // borders and state lines go into the skin: the states faint, the countries firmer
    rasterLines(lines.states, lines.scale, PW, PH, st.base, [150, 170, 200, 70]);
    rasterLines(lines.borders, lines.scale, PW, PH, st.base, [205, 220, 245, 150]);
    st.pics.clear(); st.dirty = true; schedule(st);
  } catch (e) { st.say = `the map data did not load: ${e?.message ?? e}`; }
  st.landAsking = false;
}

// ------------------------------------------------------------------ data

function pullRadar(st) {
  const t = Date.now();
  if (st.radarAsking || t - st.radarAt < 5 * 60_000) return;
  st.radarAsking = true; st.radarAt = t;
  st.api('/api/weather/radar').then((d) => {
    if (d?.ok) { st.radar = d; if (st.frame >= d.frames.length) st.frame = d.frames.length - 1; if (!st.frameChosen) st.frame = d.frames.filter((f) => !f.nowcast).length - 1; st.say = ''; }
    else st.say = d?.enabled === false ? d.note : `no radar: ${d?.error ?? 'no answer'}`;
    st.dirty = true; schedule(st);
  }).catch((e) => { st.say = `no radar: ${e?.message ?? e}`; }).finally(() => { st.radarAsking = false; });
}
function pullGrid(st) {
  const w = st.w;
  const span = w.gridSpan === 'regional' ? 'regional' : 'local';
  const key = `${w.lat},${w.lon},${unitsOf(w)},${span}`;
  if (st.gridAsking || (st.gridKey === key && Date.now() - (st.gridAt ?? 0) < 10 * 60_000)) return;
  st.gridAsking = true; st.gridKey = key; st.gridAt = Date.now();
  st.api(`/api/weather/grid?lat=${encodeURIComponent(w.lat)}&lon=${encodeURIComponent(w.lon)}&units=${unitsOf(w)}&span=${span}`).then((d) => {
    if (d?.ok) { st.grid = d; st.pics.clear(); st.say = ''; if (!st.hourChosen) st.hour = 0; }
    else st.say = d?.enabled === false ? d.note : `no forecast grid: ${d?.error ?? 'no answer'}`;
    st.dirty = true; schedule(st);
  }).catch((e) => { st.say = `no forecast grid: ${e?.message ?? e}`; }).finally(() => { st.gridAsking = false; });
}
const unitsOf = (w) => (w.units === 'imperial' || w.units === 'metric' ? w.units : (['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'BS', 'KY', 'BZ', 'PW', 'FM', 'MH'].includes(String(w.country).toUpperCase()) ? 'imperial' : 'metric'));

/** A tile image, from the cache or the server; null until it has loaded (and a redraw is asked for when it does). */
function tile(st, id, z, x, y) {
  const key = `${id}/${z}/${x}/${y}`;
  const hit = st.tiles.get(key);
  if (hit) return hit.ok ? hit.img : null;
  if (st.tilePending >= 24) return null;       // a pan past twenty-four tiles in flight waits its turn
  const img = new Image();
  const rec = { img, ok: false };
  st.tiles.set(key, rec);
  st.tilePending++;
  img.onload = () => { rec.ok = true; st.tilePending--; st.pics.delete(id); st.dirty = true; schedule(st); };
  img.onerror = () => { st.tilePending--; st.tiles.delete(key); };
  img.src = `/weather/tile/${id}/${z}/${x}/${y}.png`;
  while (st.tiles.size > 600) st.tiles.delete(st.tiles.keys().next().value);
  return null;
}

// ------------------------------------------------------------------ the skin

/** The frame's sixteen zoom-2 tiles as one mercator raster, or null while any is still loading. */
function radarMercator(st, id) {
  const n = 2 ** RADAR_Z, size = 256 * n;
  const imgs = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const im = tile(st, id, RADAR_Z, x, y); if (im) imgs.push([x, y, im]); }
  if (imgs.length < n * n) return null;
  if (!st.merc) { st.merc = document.createElement('canvas'); st.merc.width = size; st.merc.height = size; }
  const ctx = st.merc.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  for (const [x, y, im] of imgs) ctx.drawImage(im, x * 256, y * 256);
  return ctx.getImageData(0, 0, size, size).data;
}

/** The composited skin for the current layer and frame/hour, built on demand and kept (PIC_CACHE of them). */
function skinFor(st) {
  if (!st.base) return null;
  const layer = st.w.mapLayer;
  let key, over = null;
  if (layer === 'forecast') {
    if (!st.grid) return { key: 'base', pic: st.base };
    const field = st.field ?? 'precip';
    key = `g:${st.grid.at}:${st.hour ?? 0}:${field}`;
    if (!st.pics.has(key)) { st.over.fill(0); over = paintGrid(st.grid, st.hour ?? 0, field, st.over, PW, PH); }
  } else {
    const f = st.radar?.frames?.[st.frame];
    if (!f) return { key: 'base', pic: st.base };
    key = `r:${f.id}`;
    if (!st.pics.has(key)) {
      const merc = radarMercator(st, f.id);
      if (!merc) return { key: 'base', pic: st.base, loading: true };
      st.over.fill(0);
      over = mercatorToEquirect(merc, 256 * 2 ** RADAR_Z, st.over, PW, PH);
    }
  }
  if (!st.pics.has(key)) {
    const pic = new Uint8ClampedArray(PW * PH * 4);
    composite(st.base, over, pic, layer === 'forecast' ? 1 : 0.9);
    st.pics.set(key, pic);
    while (st.pics.size > PIC_CACHE) st.pics.delete(st.pics.keys().next().value);
  }
  const pic = st.pics.get(key);
  st.pics.delete(key); st.pics.set(key, pic);   // most recent last
  return { key, pic };
}

// ------------------------------------------------------------------ drawing

const rendererNow = () => { try { return loadSettings().appearance.renderer; } catch { return 'software'; } };

function size(st) {
  const r = st.root.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.max(200, Math.round(r.width)), ph = Math.max(200, Math.round(r.height));
  for (const c of [st.cv, st.glcv]) {
    if (!c) continue;
    const want = c === st.glcv && rendererNow() !== 'webgl' ? 1 : dpr;
    if (c.width !== Math.round(pw * want) || c.height !== Math.round(ph * want)) { c.width = Math.round(pw * want); c.height = Math.round(ph * want); st.dirty = true; }
  }
  return { pw, ph, dpr };
}

function drawGlobe(st, pw, ph, dpr) {
  const ctx = st.cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, st.cv.width, st.cv.height);
  const skin = skinFor(st);
  if (!skin) return;
  const renderer = rendererNow();
  let onGl = false;
  if (renderer === 'webgl' && st.glcv && !st.glDead) {
    if (!st.gl) { st.gl = glInit(st.glcv); if (!st.gl) st.glDead = true; }
    if (st.gl) {
      const { gl, prog, tex, u } = st.gl;
      if (gl.isContextLost()) { st.glDead = true; st.gl = null; } else {
        gl.viewport(0, 0, st.glcv.width, st.glcv.height);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (st.gl.picKey !== skin.key) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PW, PH, 0, gl.RGBA, gl.UNSIGNED_BYTE, skin.pic); st.gl.picKey = skin.key; }
        gl.uniform2f(u.res, st.glcv.width, st.glcv.height);
        gl.uniform1f(u.R, sphereRadius(st.view, pw, ph) * dpr);
        gl.uniform1f(u.lat0, (st.view.lat * Math.PI) / 180);
        gl.uniform1f(u.lon0, (st.view.lon * Math.PI) / 180);
        gl.uniform1i(u.pic, 0);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        onGl = true;
      }
    }
  }
  st.glcv.hidden = !onGl;
  if (!onGl) {
    // Software and Simple: the globe at panel resolution (not device: 11 ms at 600 px, four times that at dpr 2)
    const sw = pw, sh = ph;
    if (!st.img || st.img.width !== sw || st.img.height !== sh) st.img = ctx.createImageData(sw, sh);
    orthoRender(skin.pic, PW, PH, st.img.data, sw, sh, st.view, { smooth: sw * sh <= 1_300_000 });   // bilinear up to ~1300 x 1000; nearest past that (twice the cost)
    if (dpr === 1) ctx.putImageData(st.img, 0, 0);
    else {
      if (!st.soft) st.soft = document.createElement('canvas');
      st.soft.width = sw; st.soft.height = sh;
      st.soft.getContext('2d').putImageData(st.img, 0, 0);
      ctx.drawImage(st.soft, 0, 0, st.cv.width, st.cv.height);
    }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the forecast's wind, the place, the graticule's equator -- the 2D layer over either globe
  if (st.w.mapLayer === 'forecast' && st.grid) drawWind(ctx, st, (lat, lon) => orthoProject(lat, lon, pw, ph, st.view), sphereRadius(st.view, pw, ph) / 90);
  // names: on the globe only the big ones, by the sphere's size on screen
  const R = sphereRadius(st.view, pw, ph);
  drawNames(ctx, st, (lat, lon) => orthoProject(lat, lon, pw, ph, st.view), pw, ph, R < 500 ? 1 : R < 1200 ? 2 : R < 3000 ? 3 : 4);
  drawPlace(ctx, st, orthoProject(st.home.lat, st.home.lon, pw, ph, st.view));
  if (skin.loading) st.say = st.say || 'loading the radar frame…';
}

/** Place names, biggest first, no overlaps (weathermap placeLabels); `rank` is the places file's ceiling. */
function drawNames(ctx, st, project, pw, ph, rank) {
  if (!st.places) return;
  ctx.save();
  ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const items = [];
  for (const p of st.places) {
    if (p[4] > rank) continue;
    const q = project(p[1] / 100, p[2] / 100);
    if (!q || (q.depth != null && q.depth < 0.12)) continue;
    if (q.x < -40 || q.x > pw + 40 || q.y < -10 || q.y > ph + 10) continue;
    const w = ctx.measureText(p[0]).width + 10;
    items.push({ x: q.x + 4, y: q.y - 7, w, h: 14, p, q, depth: q.depth ?? 1 });
    if (items.length > 400) break;     // the file is sorted by rank then population: the first few hundred in view are the ones that matter
  }
  for (const it of placeLabels(items, pw, ph, 3)) {
    const big = it.p[4] <= 2;
    const a = Math.min(1, 0.45 + 0.55 * it.depth);
    ctx.fillStyle = `rgba(255,255,255,${(0.9 * a).toFixed(2)})`;
    ctx.beginPath(); ctx.arc(it.q.x, it.q.y, big ? 2.4 : 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${big ? '650 12px' : '500 11px'} system-ui, sans-serif`;
    ctx.lineWidth = 3; ctx.strokeStyle = `rgba(4,8,16,${(0.75 * a).toFixed(2)})`; ctx.lineJoin = 'round';
    ctx.strokeText(it.p[0], it.q.x + 5, it.q.y); ctx.fillText(it.p[0], it.q.x + 5, it.q.y);
  }
  ctx.restore();
}

function drawFlat(st, pw, ph, dpr) {
  st.glcv.hidden = true;
  const ctx = st.cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const fv = flatView(st.view, pw, ph, 12);   // the MAP goes to 12; the tiles stop where the server says (the radar branch below)
  const close = fv.z > LAND_UNTIL_Z;
  ctx.fillStyle = close ? '#121c2c' : '#0c1830'; ctx.fillRect(0, 0, pw, ph);
  // the land as vectors (the 110m file: fine at zoom 3-5, coarse by 8; closer than that it is not drawn at all --
  // a 110m coastline across a town is a straight edge in the wrong place -- and the ground is distance rings)
  if (st.landData && !close) {
    const k = st.landData.scale;
    const n = 2 ** fv.z;
    // only what is in view goes through the path: at zoom 8 the whole file is 110k points a frame otherwise
    const lonW = Math.max(1, (pw / fv.scale) * (360 / n)), latH = Math.max(1, (ph / fv.scale) * (180 / n));
    const inView = (r) => { let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity; for (let i = 0; i < r.length; i += 2) { const x = r[i] / k, y = r[i + 1] / k; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } return maxX >= st.view.lon - lonW && minX <= st.view.lon + lonW && maxY >= st.view.lat - latH && minY <= st.view.lat + latH; };
    const trace = (r, dx) => { for (let i = 0; i < r.length; i += 2) { const x = tileX(r[i] / k, fv.z) * fv.scale - fv.left + dx, y = tileY(r[i + 1] / k, fv.z) * fv.scale - fv.top; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } };
    for (const dx of [0, -fv.worldPx, fv.worldPx]) {   // the world as it is first; its neighbours only when a copy is narrower than the panel
      ctx.beginPath();
      for (const rings of st.landData.polygons) if (fv.z < 4 || inView(rings[0])) for (const r of rings) { trace(r, dx); ctx.closePath(); }
      ctx.fillStyle = '#2c3a4c'; ctx.fill('evenodd');
      ctx.strokeStyle = '#4c6a90'; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath();
      for (const r of st.landData.water ?? []) if (fv.z < 4 || inView(r)) { trace(r, dx); ctx.closePath(); }
      ctx.fillStyle = '#0c1830'; ctx.fill(); ctx.strokeStyle = '#3a5478'; ctx.lineWidth = 0.8; ctx.stroke();
      if (st.lines) {
        const lk = st.lines.scale;
        const traceL = (r) => { for (let i = 0; i < r.length; i += 2) { const x = tileX(r[i] / lk, fv.z) * fv.scale - fv.left + dx, y = tileY(r[i + 1] / lk, fv.z) * fv.scale - fv.top; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } };
        const vis = (r) => { let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity; for (let i = 0; i < r.length; i += 2) { const x = r[i] / lk, y = r[i + 1] / lk; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } return maxX >= st.view.lon - lonW && minX <= st.view.lon + lonW && maxY >= st.view.lat - latH && minY <= st.view.lat + latH; };
        if (fv.z >= 4) {
          ctx.beginPath(); for (const r of st.lines.states) if (vis(r)) traceL(r);
          ctx.strokeStyle = 'rgba(160,180,210,.35)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.beginPath(); for (const r of st.lines.borders) if (fv.z < 4 || vis(r)) traceL(r);
        ctx.strokeStyle = 'rgba(215,228,250,.7)'; ctx.lineWidth = fv.z >= 6 ? 1.4 : 1; ctx.stroke();
      }
      if (n * fv.scale > 3 * pw) break;   // one copy of the world is wider than three panels: no wrap needed (the first pass was dx 0)
    }
  }
  if (st.w.mapLayer === 'forecast') {
    if (st.grid) {
      drawFlatGrid(ctx, st, fv, pw, ph);
      drawWind(ctx, st, (lat, lon) => flatProject(lat, lon, fv), fv.worldPx / 360);   // panel pixels per degree of longitude
    }
  } else {
    const f = st.radar?.frames?.[st.frame];
    if (f) {
      ctx.globalAlpha = 0.85;
      ctx.imageSmoothingEnabled = true;
      let missing = 0;
      // RainViewer's tiles stop at zoom 7 (the server says which, `zoomMax`): closer than that, the part of the
      // zoom-7 tile under this tile is drawn scaled up -- about a kilometre a pixel, the radar's own grain
      const tz = Math.min(fv.z, st.radar?.zoomMax ?? 7), d = fv.z - tz, sub = 256 / 2 ** d;
      for (const t of flatTiles(fv, pw, ph)) {
        const im = tile(st, f.id, tz, t.x >> d, t.y >> d);
        if (!im) { missing++; continue; }
        if (d === 0) ctx.drawImage(im, t.px, t.py, fv.scale + 0.5, fv.scale + 0.5);
        else ctx.drawImage(im, (t.x & (2 ** d - 1)) * sub, (t.y & (2 ** d - 1)) * sub, sub, sub, t.px, t.py, fv.scale + 0.5, fv.scale + 0.5);
      }
      ctx.globalAlpha = 1;
      if (missing) st.say = st.say || 'loading radar tiles…';
    }
  }
  if (close) drawRings(ctx, st, fv, pw, ph);
  drawNames(ctx, st, (lat, lon) => { const q = flatProject(lat, lon, fv); return q; }, pw, ph, rankCeiling(fv.z));
  drawScale(ctx, st, fv, pw, ph);
  drawPlace(ctx, st, flatProject(st.home.lat, st.home.lon, fv));
}

/** Close in: rings round the place at round distances, labelled, and a faint graticule -- the ground in place of a map. */
function drawRings(ctx, st, fv, pw, ph) {
  const units = unitsOf(st.w);
  const c = flatProject(st.home.lat, st.home.lon, fv);
  ctx.save();
  ctx.setLineDash([4, 6]);
  ctx.strokeStyle = 'rgba(160, 190, 230, .28)'; ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(200, 220, 255, .55)'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
  for (const r of ringRadii(fv, st.home.lat, pw, ph, units)) {
    ctx.beginPath(); ctx.arc(c.x, c.y, r.px, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(r.label, c.x, c.y - r.px - 4);
  }
  ctx.setLineDash([]);
  ctx.restore();
}
/** A scale bar, bottom left. */
function drawScale(ctx, st, fv, pw, ph) {
  const bar = scaleBar(fv, st.view.lat, Math.min(160, pw / 4), unitsOf(st.w));
  const x = 14, y = ph - 16;
  ctx.save();
  ctx.strokeStyle = 'rgba(235, 245, 255, .85)'; ctx.lineWidth = 2; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + bar.px, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 1); ctx.moveTo(x + bar.px, y - 5); ctx.lineTo(x + bar.px, y + 1); ctx.stroke();
  ctx.fillStyle = 'rgba(235, 245, 255, .85)'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(bar.label, x + 4, y - 7);
  ctx.restore();
}

/** The forecast layer on the flat map: the panel sampled every other pixel through the grid, scaled up. */
function drawFlatGrid(ctx, st, fv, pw, ph) {
  const step = 2, sw = Math.ceil(pw / step), sh = Math.ceil(ph / step);
  const field = st.field ?? 'precip';
  const sample = gridSampler(st.grid, st.hour ?? 0, field);
  const units = st.grid.units ?? 'metric';
  if (!st.flatImg || st.flatImg.width !== sw || st.flatImg.height !== sh) st.flatImg = ctx.createImageData(sw, sh);
  const d = st.flatImg.data;
  const tcache = new Map();
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const { lat, lon } = flatUnproject(x * step + 1, y * step + 1, fv);
    const v = sample(lat, lon);
    const o = (y * sw + x) * 4;
    if (v == null) { d[o + 3] = 0; continue; }
    let c;
    if (field === 'precip') c = rainColour(units === 'imperial' ? v * 25.4 : v);
    else if (field === 'temp') { const k = Math.round(v); let rgb = tcache.get(k); if (!rgb) { const h = tempColour(k, units); rgb = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; tcache.set(k, rgb); } c = [...rgb, 165]; }
    else c = [235, 240, 250, Math.round(Math.max(0, Math.min(100, v)) * 1.6)];
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
  }
  if (!st.flatCv) st.flatCv = document.createElement('canvas');
  st.flatCv.width = sw; st.flatCv.height = sh;
  st.flatCv.getContext('2d').putImageData(st.flatImg, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(st.flatCv, 0, 0, pw, ph);
}

function drawWind(ctx, st, project, unit) {
  // `unit` is panel pixels per degree; the points are half a degree apart, so under 14 px between them the arrows
  // are a tangle (the first cut drew 121 of them in a thumb-sized patch on the globe): thin them to every other
  // point, and past that draw none -- the rain field still shows where the grid is
  const gap = unit * (st.grid.dLat ?? 0.5);
  if (gap < 7) return;
  const every = gap < 14 ? 2 : 1;
  const pts = windPoints(st.grid, st.hour ?? 0).filter((p, i) => every === 1 || ((i % st.grid.n) % 2 === 0 && Math.floor(i / st.grid.n) % 2 === 0));
  const len = Math.max(6, Math.min(18, gap * 0.8));
  ctx.lineWidth = 1.2; ctx.lineCap = 'round';
  for (const p of pts) {
    const q = project(p.lat, p.lon);
    if (!q || (q.depth != null && q.depth < 0.15)) continue;
    const a = ((p.dir + 180) * Math.PI) / 180;     // the direction it blows TO
    const l = len * Math.min(1.6, 0.4 + p.speed / 30);
    const dx = Math.sin(a) * l, dy = -Math.cos(a) * l;
    ctx.strokeStyle = p.speed > 40 ? 'rgba(255,200,120,.9)' : 'rgba(235,245,255,.75)';
    ctx.beginPath(); ctx.moveTo(q.x - dx / 2, q.y - dy / 2); ctx.lineTo(q.x + dx / 2, q.y + dy / 2);
    const hx = q.x + dx / 2, hy = q.y + dy / 2, b = Math.atan2(dy, dx);
    ctx.moveTo(hx, hy); ctx.lineTo(hx - 4 * Math.cos(b - 0.5), hy - 4 * Math.sin(b - 0.5));
    ctx.moveTo(hx, hy); ctx.lineTo(hx - 4 * Math.cos(b + 0.5), hy - 4 * Math.sin(b + 0.5));
    ctx.stroke();
  }
}

function drawPlace(ctx, st, q) {
  if (!q) return;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(q.x, q.y, 6.5, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#f7931a';
  ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill();
}

function draw(st) {
  st.raf = 0;
  if (!st.view) return;
  const { pw, ph, dpr } = size(st);
  st.say = st.say && /loading/.test(st.say) ? '' : st.say;
  if (isFlat(st.view, pw, ph)) drawFlat(st, pw, ph, dpr); else drawGlobe(st, pw, ph, dpr);
  st.dirty = false;
  caption(st);
}
function schedule(st) {
  if (st.raf || !st.dirty) return;
  st.raf = requestAnimationFrame(() => draw(st));
}

// ------------------------------------------------------------------ the loop and the controls

const clock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function frameLabel(st) {
  if (st.w.mapLayer === 'forecast') {
    const t = st.grid?.times?.[st.hour ?? 0];
    if (!t) return '–';
    const d = new Date(`${t}Z`);
    return `${DOW[d.getDay()]} ${clock(d.getTime())}`;
  }
  const f = st.radar?.frames?.[st.frame];
  return f ? `${clock(f.time * 1000)}${f.nowcast ? ' (nowcast)' : ''}` : '–';
}
function frameCount(st) { return st.w.mapLayer === 'forecast' ? (st.grid?.times?.length ?? 0) : (st.radar?.frames?.length ?? 0); }
function setFrame(st, i) {
  const n = frameCount(st);
  if (!n) return;
  const k = ((i % n) + n) % n;
  if (st.w.mapLayer === 'forecast') { st.hour = k; st.hourChosen = true; } else { st.frame = k; st.frameChosen = true; }
  st.dirty = true; schedule(st);
  // prefetch the next frame's tiles so the loop does not stall on them
  const next = st.radar?.frames?.[(k + 1) % n];
  if (st.w.mapLayer !== 'forecast' && next) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) tile(st, next.id, RADAR_Z, x, y);
}
function play(st, on) {
  st.playing = on;
  clearInterval(st.playTimer); st.playTimer = null;
  if (on) {
    st.playTimer = setInterval(() => {
      if (document.hidden) return;
      const n = frameCount(st);
      if (!n) return;
      setFrame(st, (st.w.mapLayer === 'forecast' ? (st.hour ?? 0) : st.frame) + 1);
    }, st.w.mapLayer === 'forecast' ? 420 : FRAME_MS);
  }
  caption(st);
}
function caption(st) {
  const r = st.root.parentElement;
  const lab = r?.querySelector('[data-wxg-time]'), range = r?.querySelector('[data-wxg-range]'), note = r?.querySelector('[data-wxg-note]'), playBtn = r?.querySelector('[data-wxg-play]');
  const n = frameCount(st), i = st.w.mapLayer === 'forecast' ? (st.hour ?? 0) : st.frame;
  if (lab) lab.textContent = frameLabel(st);
  if (range) { range.max = String(Math.max(0, n - 1)); if (Number(range.value) !== i) range.value = String(i); range.disabled = n < 2; }
  if (playBtn) { playBtn.textContent = rendererNow() === '2.5d' ? 'hold to play' : st.playing ? 'pause' : 'play'; playBtn.classList.toggle('on', st.playing); }
  if (note) {
    const flat = st.view ? isFlat(st.view, ...[st.root.clientWidth || 600, st.root.clientHeight || 400]) : false;
    const parts = [];
    if (st.say) parts.push(st.say);
    else if (st.w.mapLayer === 'forecast') parts.push(`forecast ${st.field === 'temp' ? 'temperature' : st.field === 'cloud' ? 'cloud cover' : 'rain and snow'}, Open-Meteo, 11 x 11 points about ${(st.grid?.dLat ?? 0.5) * 10}° across; wind arrows point where it blows`);
    else parts.push('observed radar, RainViewer, the last two hours; blank where no radar station reaches (oceans, much of the world)');
    if (flat) { const z = flatView(st.view, st.root.clientWidth || 600, st.root.clientHeight || 400).z; parts.push(z > LAND_UNTIL_Z ? `zoom ${z}: rings are distance from the place; no street map (this monitor contacts no map-tile server)` : `flat map, zoom ${z}; coasts, lakes and borders are Natural Earth 1:50m${z >= 8 ? ', coarse this close' : ''}`); }
    note.textContent = parts.join(' · ');
  }
}

function bind(st) {
  const root = st.root, cv = st.cv;
  const pw = () => root.clientWidth || 600, ph = () => root.clientHeight || 400;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    if (st.pointer && st.pointer.id !== e.pointerId) { st.pinch = { a: st.pointer.id, b: e.pointerId, pa: [st.pointer.x, st.pointer.y], pb: [e.clientX, e.clientY], zoom: st.view.zoom }; return; }
    st.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  });
  cv.addEventListener('pointermove', (e) => {
    if (st.pinch) {
      if (e.pointerId === st.pinch.a) st.pinch.pa = [e.clientX, e.clientY]; else if (e.pointerId === st.pinch.b) st.pinch.pb = [e.clientX, e.clientY]; else return;
      const d0 = Math.hypot(st.pinch.pa0?.[0] ?? 0, 0);
      if (!st.pinch.d0) st.pinch.d0 = Math.hypot(st.pinch.pa[0] - st.pinch.pb[0], st.pinch.pa[1] - st.pinch.pb[1]) || 1;
      const d = Math.hypot(st.pinch.pa[0] - st.pinch.pb[0], st.pinch.pa[1] - st.pinch.pb[1]);
      void d0;
      st.view = viewOf(st.view.lat, st.view.lon, st.pinch.zoom * (d / st.pinch.d0));
      st.dirty = true; schedule(st);
      return;
    }
    if (!st.pointer || e.pointerId !== st.pointer.id) return;
    const dx = e.clientX - st.pointer.x, dy = e.clientY - st.pointer.y;
    st.pointer.x = e.clientX; st.pointer.y = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 0) st.pointer.moved = true;
    if (isFlat(st.view, pw(), ph())) {
      // a pan: the place under the panel's middle moves by the drag, in mercator
      const fv = flatView(st.view, pw(), ph(), 12);
      const c = flatUnproject(pw() / 2 - dx, ph() / 2 - dy, fv);
      st.view = viewOf(c.lat, c.lon, st.view.zoom);
    } else st.view = dragView(st.view, dx, dy, pw(), ph());
    st.dirty = true; schedule(st);
  });
  const up = (e) => { if (st.pinch && (e.pointerId === st.pinch.a || e.pointerId === st.pinch.b)) { st.pinch = null; st.pointer = null; } if (st.pointer && e.pointerId === st.pointer.id) st.pointer = null; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    st.view = zoomView(st.view, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016)));
    st.dirty = true; schedule(st); caption(st);
  }, { passive: false });
  const bar = root.parentElement;
  bar?.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-wxg]');
    if (!b) return;
    const k = b.dataset.wxg;
    if (k === 'in') st.view = zoomView(st.view, 2);
    else if (k === 'out') st.view = zoomView(st.view, 0.5);
    else if (k === 'home') st.view = homeView(st.home.lat, st.home.lon, pw(), ph());
    else if (k === 'region') st.view = viewOf(st.home.lat, st.home.lon, 1.6 * 3);
    else if (k === 'world') st.view = viewOf(Math.max(-60, Math.min(60, st.home.lat)), st.home.lon, 1);
    else if (k === 'field') { st.field = { precip: 'temp', temp: 'cloud', cloud: 'precip' }[st.field ?? 'precip']; b.textContent = { precip: 'rain', temp: 'temperature', cloud: 'cloud' }[st.field]; }
    st.dirty = true; schedule(st); caption(st);
  });
  const playBtn = bar?.querySelector('[data-wxg-play]');
  if (playBtn) {
    // Simple: the loop runs only while the button is held (no endless repaint at rest); the others toggle
    playBtn.addEventListener('pointerdown', (e) => { if (rendererNow() === '2.5d') { e.preventDefault(); play(st, true); } });
    const stopHold = () => { if (rendererNow() === '2.5d' && st.playing) play(st, false); };
    playBtn.addEventListener('pointerup', stopHold); playBtn.addEventListener('pointercancel', stopHold); playBtn.addEventListener('pointerleave', stopHold);
    playBtn.addEventListener('click', () => { if (rendererNow() !== '2.5d') play(st, !st.playing); });
  }
  bar?.querySelector('[data-wxg-range]')?.addEventListener('input', (e) => { play(st, false); setFrame(st, Number(e.target.value)); caption(st); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) play(st, false); });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { st.dirty = true; schedule(st); }).observe(root);
}

/** The markup the Weather page puts the globe in (once; weather.js keeps the element across its own redraws). */
export function globeHtml({ bare = false } = {}) {
  // bare: the Kiosk's panel -- the map alone, no bar and no note (a wall has nobody to click; the ribbon above it says the time)
  if (bare) return '<div class="wxg-box"><canvas class="wxg-gl" hidden></canvas><canvas class="wxg-ui"></canvas></div>';
  return `<div class="wxg-bar">
    <span class="wxg-ctl"><button type="button" class="btn" data-wxg-play>play</button><input type="range" class="wxg-range" min="0" max="0" value="0" data-wxg-range aria-label="frame"><b class="wxg-time" data-wxg-time>–</b></span>
    <span class="sp"></span>
    <span class="wxg-ctl"><button type="button" class="btn" data-wxg="field" title="Which forecast field: rain, temperature or cloud (forecast layer only)">rain</button><button type="button" class="btn" data-wxg="home" title="The place and its surrounding towns (about 75 km across)">local</button><button type="button" class="btn" data-wxg="region" title="The region, about 1,500 km across">region</button><button type="button" class="btn" data-wxg="world" title="The whole globe">world</button><button type="button" class="btn" data-wxg="out" aria-label="zoom out">−</button><button type="button" class="btn" data-wxg="in" aria-label="zoom in">+</button></span>
  </div>
  <div class="wxg-box"><canvas class="wxg-gl" hidden></canvas><canvas class="wxg-ui"></canvas></div>
  <p class="wxg-note tiny faint" data-wxg-note>loading the coastlines…</p>`;
}

/**
 * Mount or update the globe in `box` (the .wxg-box inside the markup above) for these weather settings.
 * Called on every render of the Weather page; it asks for data at most as its own timers allow.
 */
export function renderGlobe(box, w, h, { autoplay = false } = {}) {
  const st = stateOf(box);
  st.api = h.api;
  st.autoplay = autoplay;
  const changed = !st.w || st.w.lat !== w.lat || st.w.lon !== w.lon || st.w.mapLayer !== w.mapLayer || unitsOf(st.w) !== unitsOf(w) || st.w.gridSpan !== w.gridSpan;
  const layerChanged = st.w && (st.w.mapLayer !== w.mapLayer || st.w.gridSpan !== w.gridSpan);
  st.w = w;
  if (!st.bound) { st.bound = true; bind(st); }
  // THE FIRST VIEW IS LOCAL (operator: "It's a local weather station to start"): the place at tile zoom 11, flat
  if (!st.view || !st.home || st.home.lat !== w.lat || st.home.lon !== w.lon) { st.home = { lat: w.lat, lon: w.lon }; st.view = homeView(w.lat, w.lon, box.clientWidth || 600, box.clientHeight || 400); st.dirty = true; }
  if (layerChanged) { play(st, false); st.pics.clear(); st.dirty = true; }
  loadLand(st);
  if (w.mapLayer === 'forecast') pullGrid(st); else pullRadar(st);
  // the Kiosk's map plays its loop by itself on Software and WebGL (a wall display wants motion); Simple shows the
  // latest frame and plays nothing -- the same rule as the play button
  if (st.autoplay && !st.playing && rendererNow() !== '2.5d' && frameCount(st) > 1 && !document.hidden) play(st, true);
  const r = box.parentElement?.querySelector('[data-wxg="field"]');
  if (r) r.hidden = w.mapLayer !== 'forecast';
  if (changed) st.dirty = true;
  schedule(st);
  caption(st);
}

/** For tests and scripts: the globe's state for a box. */
export const globeState = (box) => states.get(box) ?? null;
