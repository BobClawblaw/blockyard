// LOCAL WEATHER (operator, 2026-10-13: "add a local weather report feature to blockyard. Something users would have
// to opt into ... current, 7 day, and 10 day forecasts ... a ribbon that shows this info on the top of the screen").
//
// THE SECOND OUTBOUND CONNECTION THAT IS NOT THE NODE, after the exchanges (server/collect/markets.js), and built
// on the same terms: server-side, because the page's CSP lets the browser talk to this origin only; OFF until a
// Display setting is ticked (weather.enabled, read from the shared settings file per request -- http/api.js
// weatherOn); BLOCKYARD_WEATHER=0 removes it from the server so that no checkbox can turn it on.
//
// THE SOURCE IS OPEN-METEO (open-meteo.com), chosen because it is the one free service that answers all three
// questions with no account and no key, for any place on Earth: current conditions, hourly, and up to sixteen days
// of daily forecast from national weather models (DWD, NOAA, Météo-France, ECMWF and others, blended per place).
// The alternatives were looked at: the US National Weather Service (api.weather.gov) is keyless but US-only and
// stops at seven days; MET Norway is keyless and global but nine days, and wants a contact address in every
// request; OpenWeatherMap, Tomorrow.io, WeatherAPI and Visual Crossing all need an account and a key, which a
// self-hosted monitor would then have to keep. Open-Meteo's free tier is for non-commercial use, about 10,000
// calls a day -- this module makes at most one call per place per ten minutes, and only while a ribbon is on
// screen, so a monitor watched all day costs ~150. Probed from this host 2026-10-13: forecast reply 4.6 KB in
// ~120 ms; geocoding reply 2.9 KB.
//
// WHAT LEAVES THE MACHINE: this host's address, a User-Agent naming the software, and the coordinates of the place
// chosen in Display settings (rounded to two decimals, ~1 km) -- or, while someone is searching for a place, the
// words they typed. Nothing about the node.
//
// PULL-THROUGH, NO TIMERS: a forecast is fetched when a page asks for it and the copy here is older than freshMs,
// so a monitor nobody is looking at makes no weather traffic at all, and there is nothing to park.
import { readJsonCapped } from './markets.js';

export const WEATHER_HOSTS = Object.freeze(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
// THE GLOBE'S RADAR (docs/PLAN-WEATHER-GLOBE.md; operator: "yes to all three, build it"): RainViewer's public
// composite -- the frame list from api.rainviewer.com, 256-px PNG tiles from tilecache.rainviewer.com. Free, keyless;
// the tiles are cached here so a pan of the map never fans out into a burst of requests to them.
export const RADAR_HOSTS = Object.freeze(['api.rainviewer.com', 'tilecache.rainviewer.com']);
const RADAR_LIST_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_LIST_MS = 5 * 60_000;         // RainViewer publishes a frame every 10 minutes
export const TILE_ZOOM_MAX = 7;           // RainViewer's tiles stop here: past 7 it answers 200 with a "Zoom Level Not Supported" picture (seen on the map 2026-10-13; a probe that
                                          // checked the status alone had said 8-13 were fine). Closer views upscale the zoom-7 tile: ~1 km a pixel, about the radar's own resolution
const TILE_BYTES_MAX = 256 * 1024;        // a 256-px radar tile is 1-30 KB
const TILE_CACHE_BYTES = 48 * 1024 * 1024;
const TILE_FRESH_MS = 60 * 60_000;        // a frame's tile never changes; an hour is just housekeeping
const FRAME_PATH = /^\/v2\/(radar|satellite)\/[a-z0-9]{6,32}$/;
// THE REFRESH (operator: "Configurable starting at 10 minute refreshes ... Default should be 10 minute refresh for
// 6 per hours max"): a forecast is re-asked no more often than this, whatever a browser asks for, and no more than
// six times in any hour for one place. The grid is 121 points a request against a 10,000-a-day quota, so it keeps a
// floor of its own.
export const REFRESH_FLOOR_MS = 10 * 60_000;
export const REFRESH_PER_HOUR_MAX = 6;
export const GRID_MIN_MS = 30 * 60_000;
export const GRID_N = 11;                 // 11 x 11 points: at the LOCAL step a tenth of a degree apart (~11 km, about 110 km across -- the
                                          // surrounding zip codes; operator: "It's a local weather station to start"), at the REGIONAL half a degree
export const GRID_STEPS = Object.freeze({ local: 0.1, regional: 0.5 });
const GRID_STEP = GRID_STEPS.local;
export const gridSpanOf = (v) => (Object.hasOwn(GRID_STEPS, String(v)) ? String(v) : 'local');
const GRID_HOURS = 48;
const UA = 'BlockYard (self-hosted Bitcoin node monitor)';
const MAX_BODY = 256 * 1024;          // the 10-day reply is ~5 KB; a geocoding page ~3 KB
const GRID_BODY = 2 * 1024 * 1024;    // 121 points' replies, each with its own units block: ~330 KB measured 2026-10-13
const GRID_TIMEOUT_MS = 25_000;       // 121 points took 0.6 s one minute and over 8 s the next (2026-10-13); the page waits
const DAYS = 10;                      // the most the ribbon draws; 7 is a slice of it

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 80) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null);

/** A place the ribbon can ask about: two finite numbers inside the globe, rounded to ~1 km. Null otherwise. */
export function placeOf(lat, lon) {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: Math.round(la * 100) / 100, lon: Math.round(lo * 100) / 100 };
}
export const unitsOf = (u) => (u === 'imperial' ? 'imperial' : 'metric');

export function forecastUrl({ lat, lon }, units) {
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: 'auto', forecast_days: String(DAYS), forecast_hours: '24',
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,pressure_msl',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,wind_speed_10m_max,uv_index_max',
  });
  if (units === 'imperial') { q.set('temperature_unit', 'fahrenheit'); q.set('wind_speed_unit', 'mph'); q.set('precipitation_unit', 'inch'); }
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}
export const geocodeUrl = (name) => `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name, count: '8', language: 'en', format: 'json' })}`;

const col = (o, k) => (Array.isArray(o?.[k]) ? o[k] : []);

/** Open-Meteo's reply, reduced to what the ribbon draws -- every figure a number or null, never invented (rule 3). */
export function parseForecast(j, units) {
  if (j?.error) throw new Error(String(j.reason ?? 'the forecast service refused the request'));
  const c = j?.current;
  if (!c || typeof c !== 'object') throw new Error('no current conditions in the reply');
  const d = j.daily ?? {}, h = j.hourly ?? {};
  const days = col(d, 'time').slice(0, DAYS).map((date, i) => ({
    date: str(date, 10),
    code: num(col(d, 'weather_code')[i]),
    hi: num(col(d, 'temperature_2m_max')[i]),
    lo: num(col(d, 'temperature_2m_min')[i]),
    pop: num(col(d, 'precipitation_probability_max')[i]),
    precip: num(col(d, 'precipitation_sum')[i]),
    wind: num(col(d, 'wind_speed_10m_max')[i]),
    uv: num(col(d, 'uv_index_max')[i]),
    sunrise: str(col(d, 'sunrise')[i], 16),
    sunset: str(col(d, 'sunset')[i], 16),
  })).filter((x) => x.date);
  const hours = col(h, 'time').slice(0, 24).map((t, i) => ({
    t: str(t, 16),
    temp: num(col(h, 'temperature_2m')[i]),
    pop: num(col(h, 'precipitation_probability')[i]),
    code: num(col(h, 'weather_code')[i]),
    day: col(h, 'is_day')[i] === 1,
  })).filter((x) => x.t);
  return {
    units,
    timezone: str(j.timezone, 64),
    tzAbbr: str(j.timezone_abbreviation, 16),
    utcOffset: num(j.utc_offset_seconds),
    current: {
      time: str(c.time, 16),
      temp: num(c.temperature_2m),
      feels: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m),
      day: c.is_day === 1,
      precip: num(c.precipitation),
      code: num(c.weather_code),
      cloud: num(c.cloud_cover),
      wind: num(c.wind_speed_10m),
      windDir: num(c.wind_direction_10m),
      gusts: num(c.wind_gusts_10m),
      uv: num(c.uv_index),
      pressure: num(c.pressure_msl),
    },
    hours,
    days,
  };
}

/** The forecast grid's points, row by row (south to north, west to east), and the URL that asks for all of them at once. */
export function gridPoints({ lat, lon }, n = GRID_N, step = GRID_STEP) {
  const half = (n - 1) / 2;
  // the same distance east-west as north-south, so the grid is square on the ground, not squeezed near the poles
  const dLon = Math.round((step / Math.max(0.2, Math.cos((lat * Math.PI) / 180))) * 1000) / 1000;
  const lat0 = Math.round((lat - half * step) * 1000) / 1000, lon0 = Math.round((lon - half * dLon) * 1000) / 1000;
  const lats = [], lons = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    lats.push(Math.round((lat0 + r * step) * 1000) / 1000);
    let x = lon0 + c * dLon;
    if (x > 180) x -= 360; else if (x < -180) x += 360;
    lons.push(Math.round(x * 1000) / 1000);
  }
  return { n, lat0, lon0, dLat: step, dLon, lats, lons };
}
export function gridUrl(g, units) {
  const q = new URLSearchParams({
    latitude: g.lats.join(','), longitude: g.lons.join(','), timezone: 'UTC', forecast_hours: String(GRID_HOURS),
    hourly: 'precipitation,temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,weather_code',
  });
  if (units === 'imperial') { q.set('temperature_unit', 'fahrenheit'); q.set('wind_speed_unit', 'mph'); q.set('precipitation_unit', 'inch'); }
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}
const GRID_VARS = Object.freeze({ precip: 'precipitation', temp: 'temperature_2m', wind: 'wind_speed_10m', windDir: 'wind_direction_10m', cloud: 'cloud_cover', code: 'weather_code' });
/** Open-Meteo's multi-point reply as flat per-variable arrays, hour-major (index = hour * n*n + point). */
export function parseGrid(j, g, units) {
  if (j?.error) throw new Error(String(j.reason ?? 'the forecast service refused the request'));
  const list = Array.isArray(j) ? j : j && typeof j === 'object' && j.hourly ? [j] : null;
  const np = g.n * g.n;
  if (!list || list.length !== np) throw new Error(`expected ${np} points in the reply, got ${list?.length ?? 'none'}`);
  const times = col(list[0].hourly, 'time').slice(0, GRID_HOURS).map((t) => str(t, 16));
  const nh = times.length;
  if (!nh) throw new Error('no hours in the reply');
  const out = { units, n: g.n, lat0: g.lat0, lon0: g.lon0, dLat: g.dLat, dLon: g.dLon, times, fields: {} };
  for (const [k, name] of Object.entries(GRID_VARS)) {
    const a = new Array(nh * np).fill(null);
    for (let p = 0; p < np; p++) {
      const v = col(list[p].hourly, name);
      for (let h = 0; h < nh; h++) { const x = num(v[h]); a[h * np + p] = x == null ? null : Math.round(x * 10) / 10; }
    }
    out.fields[k] = a;
  }
  return out;
}

/** RainViewer's frame list, reduced: the tile host and the frames, oldest first, nowcast marked. */
export function parseRadarList(j) {
  const host = typeof j?.host === 'string' && /^https:\/\/tilecache\.rainviewer\.com$/.test(j.host) ? j.host : 'https://tilecache.rainviewer.com';
  const frames = [];
  const take = (list, nowcast) => { for (const f of Array.isArray(list) ? list : []) if (num(f?.time) != null && typeof f?.path === 'string' && FRAME_PATH.test(f.path)) frames.push({ time: f.time, id: f.path.split('/').pop(), kind: f.path.split('/')[2], nowcast }); };
  take(j?.radar?.past, false);
  take(j?.radar?.nowcast, true);
  if (!frames.length) throw new Error('no radar frames in the reply');
  return { host, frames };
}

export function parseGeocode(j) {
  if (j?.error) throw new Error(String(j.reason ?? 'the place search refused the request'));
  return (Array.isArray(j?.results) ? j.results : []).map((r) => {
    const p = placeOf(r?.latitude, r?.longitude);
    if (!p || !str(r?.name)) return null;
    return { name: str(r.name), region: str(r.admin1) ?? '', country: str(r.country) ?? '', cc: (str(r.country_code, 2) ?? '').toUpperCase(), ...p };
  }).filter(Boolean);
}

export class WeatherFeed {
  constructor(cfg = {}, { log = () => {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.cfg = { freshMs: 600_000, keepMs: 6 * 3600_000, timeoutMs: 8_000, maxPlaces: 16, maxSearches: 64, ...cfg };
    this.log = log;
    this.fetch = fetchImpl;
    this.now = now;
    this.places = new Map();     // "lat,lon,units" -> { data, at, error, errorAt, pending, asked: [when each request went out] }
    this.searches = new Map();   // lower-cased query -> { results, at }
    this.grids = new Map();      // the same, for the globe's forecast grid
    this.radar = { list: null, at: 0, error: null, errorAt: 0, pending: null, known: new Map() };   // known: frame id -> the frame, for the tile proxy
    this.tiles = new Map();      // "id/z/x/y" -> { buf, at }, a byte-capped LRU
    this.tileBytes = 0;
    this.tilePending = new Map();
  }

  /** The refresh a browser asked for, floored (REFRESH_FLOOR_MS) and defaulted to the feed's own. */
  refreshOf(ms) { const n = Number(ms); return Math.max(REFRESH_FLOOR_MS, Number.isFinite(n) && n > 0 ? n : this.cfg.freshMs); }

  // A row is due when its copy is older than the refresh, its last failure a minute old, and fewer than
  // REFRESH_PER_HOUR_MAX requests went out for it in the last hour.
  due(row, freshMs) {
    const t = this.now();
    row.asked = (row.asked ?? []).filter((w) => t - w < 3600_000);
    return t - row.at >= freshMs && t - row.errorAt >= 60_000 && row.asked.length < REFRESH_PER_HOUR_MAX;
  }
  rowOf(map, key, max) {
    let row = map.get(key);
    if (!row) {
      row = { data: null, at: 0, error: null, errorAt: 0, pending: null, asked: [] };
      map.set(key, row);
      while (map.size > max) map.delete(map.keys().next().value);
    }
    return row;
  }
  // one request in flight per row; the first answer waits for it, a later one is served from the copy while it refreshes
  async refill(row, freshMs, url, parse, what, limit = MAX_BODY, timeoutMs = this.cfg.timeoutMs) {
    if (this.due(row, freshMs) && !row.pending) {
      // the copy is dated from when it was ASKED FOR, not when the reply's callback ran: a refresh behind a served
      // copy lands later, and dating it then would stretch every interval past the setting
      const sent = this.now();
      row.asked.push(sent);
      row.pending = this.get(url, limit, timeoutMs)
        .then((j) => { row.data = parse(j); row.at = sent; row.error = null; })
        .catch((e) => { row.error = String(e?.message ?? e); row.errorAt = this.now(); this.log({ level: 'warn', msg: `weather: ${what} failed: ${row.error}` }); })
        .finally(() => { row.pending = null; });
    }
    if (row.pending && !row.data) await row.pending;
    return row.data && this.now() - row.at <= this.cfg.keepMs;
  }

  async get(url, limit = MAX_BODY, timeoutMs = this.cfg.timeoutMs) {
    // redirect 'error': every URL is Open-Meteo's or RainViewer's own host; a 3xx pointing anywhere else is not followed
    const r = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      let reason = '';
      try { reason = (await readJsonCapped(r, 16_384))?.reason ?? ''; } catch { /* the status says enough */ }
      throw new Error(`HTTP ${r.status}${reason ? `: ${String(reason).slice(0, 160)}` : ''}`);
    }
    return readJsonCapped(r, limit);
  }

  /** The forecast for a place: the copy here while it is fresh, else a new one -- one request in flight per place. */
  async forecast(lat, lon, units, { refreshMs = null } = {}) {
    const p = placeOf(lat, lon);
    if (!p) return { ok: false, error: 'no place chosen, or not a place on Earth' };
    const u = unitsOf(units);
    const key = `${p.lat},${p.lon},${u}`;
    const row = this.rowOf(this.places, key, this.cfg.maxPlaces);
    const fresh = this.refreshOf(refreshMs);
    if (!(await this.refill(row, fresh, forecastUrl(p, u), (j) => parseForecast(j, u), `forecast for ${key}`))) {
      return { ok: false, error: row.error ?? 'the forecast has not arrived yet', place: p };
    }
    return { ok: true, place: p, at: row.at, age: Math.max(0, Math.round((this.now() - row.at) / 1000)), refreshMs: fresh, source: 'open-meteo.com', error: row.error, ...row.data };
  }

  /** The 11 x 11 forecast grid round a place: 121 points, 48 hours, re-asked no more than every GRID_MIN_MS. */
  async grid(lat, lon, units, { refreshMs = null, span = 'local' } = {}) {
    const p = placeOf(lat, lon);
    if (!p) return { ok: false, error: 'no place chosen, or not a place on Earth' };
    const u = unitsOf(units);
    const sp = gridSpanOf(span);
    const key = `${p.lat},${p.lon},${u},${sp}`;
    const row = this.rowOf(this.grids, key, 4);
    const g = gridPoints(p, GRID_N, GRID_STEPS[sp]);
    const fresh = Math.max(GRID_MIN_MS, this.refreshOf(refreshMs));
    if (!(await this.refill(row, fresh, gridUrl(g, u), (j) => parseGrid(j, g, u), `grid for ${key}`, GRID_BODY, GRID_TIMEOUT_MS))) {
      return { ok: false, error: row.error ?? 'the forecast grid has not arrived yet', place: p };
    }
    return { ok: true, place: p, at: row.at, refreshMs: fresh, span: sp, source: 'open-meteo.com', error: row.error, ...row.data };
  }

  /** RainViewer's frame list, five minutes fresh; the frames it names are the only ones the tile proxy serves. */
  async radarFrames() {
    const row = this.radar;
    const ok = await this.refill(row, RADAR_LIST_MS, RADAR_LIST_URL, (j) => {
      const r = parseRadarList(j);
      for (const f of r.frames) row.known.set(f.id, f);
      while (row.known.size > 64) row.known.delete(row.known.keys().next().value);
      return r;
    }, 'radar frame list');
    if (!ok) return { ok: false, error: row.error ?? 'the radar frame list has not arrived yet' };
    return { ok: true, at: row.at, source: 'rainviewer.com', error: row.error, frames: row.data.frames, zoomMax: TILE_ZOOM_MAX };
  }

  /** One radar tile (PNG bytes) of a listed frame, from the cache or from RainViewer. Null for a tile this proxy will not ask for. */
  async radarTile(id, z, x, y) {
    const f = this.radar.known.get(String(id));
    const zi = Number(z), xi = Number(x), yi = Number(y);
    if (!f || !Number.isInteger(zi) || zi < 0 || zi > TILE_ZOOM_MAX || !Number.isInteger(xi) || !Number.isInteger(yi) || xi < 0 || yi < 0 || xi >= 2 ** zi || yi >= 2 ** zi) return null;
    const key = `${f.id}/${zi}/${xi}/${yi}`;
    const hit = this.tiles.get(key);
    if (hit && this.now() - hit.at < TILE_FRESH_MS) { this.tiles.delete(key); this.tiles.set(key, hit); return hit.buf; }
    if (!this.tilePending.has(key)) {
      // colour scheme 2 (the universal blue), smoothed, snow marked: RainViewer's documented tile path
      const url = `${this.radar.data?.host ?? 'https://tilecache.rainviewer.com'}/v2/${f.kind}/${f.id}/256/${zi}/${xi}/${yi}/2/1_1.png`;
      this.tilePending.set(key, this.getBytes(url, TILE_BYTES_MAX).then((buf) => {
        if (hit) this.tileBytes -= hit.buf.length;
        this.tiles.set(key, { buf, at: this.now() });
        this.tileBytes += buf.length;
        while (this.tileBytes > TILE_CACHE_BYTES && this.tiles.size) { const [k, v] = this.tiles.entries().next().value; this.tiles.delete(k); this.tileBytes -= v.buf.length; }
        return buf;
      }).finally(() => this.tilePending.delete(key)));
    }
    return this.tilePending.get(key);
  }

  async getBytes(url, limit) {
    const r = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'image/png' }, redirect: 'error', signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const declared = Number(r.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > limit) throw new Error(`tile of ${declared} bytes is over the ${limit}-byte limit`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > limit) throw new Error(`tile over the ${limit}-byte limit`);
    return buf;
  }

  async search(q) {
    const name = String(q ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
    if (name.length < 2) return { ok: true, results: [] };
    const key = name.toLowerCase();
    const hit = this.searches.get(key);
    if (hit && this.now() - hit.at < 24 * 3600_000) return { ok: true, results: hit.results };
    try {
      const results = parseGeocode(await this.get(geocodeUrl(name)));
      this.searches.set(key, { results, at: this.now() });
      while (this.searches.size > this.cfg.maxSearches) this.searches.delete(this.searches.keys().next().value);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), results: [] };
    }
  }
}
