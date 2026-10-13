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
const UA = 'BlockYard (self-hosted Bitcoin node monitor)';
const MAX_BODY = 256 * 1024;          // the 10-day reply is ~5 KB; a geocoding page ~3 KB
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
    this.places = new Map();     // "lat,lon,units" -> { data, at, error, errorAt, pending }
    this.searches = new Map();   // lower-cased query -> { results, at }
  }

  async get(url) {
    // redirect 'error': both URLs are Open-Meteo's own hosts; a 3xx pointing anywhere else is not followed
    const r = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (!r.ok) {
      let reason = '';
      try { reason = (await readJsonCapped(r, 16_384))?.reason ?? ''; } catch { /* the status says enough */ }
      throw new Error(`HTTP ${r.status}${reason ? `: ${String(reason).slice(0, 160)}` : ''}`);
    }
    return readJsonCapped(r, MAX_BODY);
  }

  /** The forecast for a place: the copy here while it is fresh, else a new one -- one request in flight per place. */
  async forecast(lat, lon, units) {
    const p = placeOf(lat, lon);
    if (!p) return { ok: false, error: 'no place chosen, or not a place on Earth' };
    const u = unitsOf(units);
    const key = `${p.lat},${p.lon},${u}`;
    let row = this.places.get(key);
    if (!row) {
      row = { data: null, at: 0, error: null, errorAt: 0, pending: null };
      this.places.set(key, row);
      while (this.places.size > this.cfg.maxPlaces) this.places.delete(this.places.keys().next().value);
    }
    const t = this.now();
    // a failure is not retried for a minute: the page asks every few minutes per screen, and a down service must
    // not be asked once per screen per ask
    const due = t - row.at > this.cfg.freshMs && t - row.errorAt > 60_000;
    if (due && !row.pending) {
      row.pending = this.get(forecastUrl(p, u))
        .then((j) => { row.data = parseForecast(j, u); row.at = this.now(); row.error = null; })
        .catch((e) => { row.error = String(e?.message ?? e); row.errorAt = this.now(); this.log({ level: 'warn', msg: `weather: forecast for ${key} failed: ${row.error}` }); })
        .finally(() => { row.pending = null; });
    }
    // the first answer for a place waits for the request; a later one is served from here while it refreshes
    if (row.pending && !row.data) await row.pending;
    if (!row.data || t - row.at > this.cfg.keepMs) return { ok: false, error: row.error ?? 'the forecast has not arrived yet', place: p };
    return { ok: true, place: p, at: row.at, age: Math.max(0, Math.round((this.now() - row.at) / 1000)), source: 'open-meteo.com', error: row.error, ...row.data };
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
