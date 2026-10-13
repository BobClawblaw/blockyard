// LOCAL WEATHER (operator, 2026-10-13: "add a local weather report feature to blockyard. Something users would have to
// opt into ... current, 7 day, and 10 day forecasts ... a ribbon ... Allow us to move it above or below the price bar
// on main page and kiosk mode"). The server's feed (server/collect/weather.js), its switch (http/api.js weatherOn),
// the settings, and the ribbon's markup (public/js/weather.js) -- all without a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, PANEL, TAB_ROWS, normalise } from '../public/js/settings.js';
import { routes, weatherOn } from '../server/http/api.js';
import { WeatherFeed, parseForecast, parseGeocode, placeOf, forecastUrl, geocodeUrl, WEATHER_HOSTS } from '../server/collect/weather.js';
import { wmo, skyOf, unitsFor, tempColour, iconSvg, ribbonHtml, hoursSvg, slotFor, SLOTS, weatherQuery, compass, placesOf, pullWeather } from '../public/js/weather.js';

const root = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'by-weather-')), 'blockyard.json');
const route = (p) => routes.find((r) => r.path === p && r.method === 'GET');

// A reply in Open-Meteo's own shape (probed 2026-10-13, trimmed to three days and four hours).
const REPLY = {
  latitude: 52.52, longitude: 13.42, utc_offset_seconds: 7200, timezone: 'Europe/Berlin', timezone_abbreviation: 'GMT+2',
  current: { time: '2026-10-13T21:15', temperature_2m: 13.7, relative_humidity_2m: 59, apparent_temperature: 10.9, is_day: 0, precipitation: 0, weather_code: 3, cloud_cover: 100, wind_speed_10m: 11.9, wind_direction_10m: 178, wind_gusts_10m: 26.6, uv_index: 0, pressure_msl: 1012.4 },
  hourly: { time: ['2026-10-13T21:00', '2026-10-13T22:00', '2026-10-13T23:00', '2026-10-14T00:00'], temperature_2m: [13.7, 13.7, 13.5, 13.2], precipitation_probability: [3, 3, 38, 40], weather_code: [3, 3, 61, 3], is_day: [0, 0, 0, 0] },
  daily: {
    time: ['2026-10-13', '2026-10-14', '2026-10-15'], weather_code: [61, 61, 3], temperature_2m_max: [15.8, 16.4, 16.1], temperature_2m_min: [3.3, 10, 7],
    precipitation_probability_max: [38, 98, 0], precipitation_sum: [0.4, 0.7, 0], sunrise: ['2026-10-13T07:28', '2026-10-14T07:29', '2026-10-15T07:31'],
    sunset: ['2026-10-13T18:21', '2026-10-14T18:19', '2026-10-15T18:17'], wind_speed_10m_max: [14, 20, 9], uv_index_max: [2, 1.5, 2.2],
  },
};
const okReply = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

test('weather ships OFF, in its own tab beside Markets & Price, and says which hosts it would contact', () => {
  assert.equal(DEFAULTS.weather.enabled, false);
  assert.equal(normalise(null).weather.enabled, false, 'a fresh browser agrees');
  assert.equal(DEFAULTS.weather.place, '', 'and no place is assumed');
  assert.ok(TAB_ROWS[0].groups.includes('weather'));
  const g = PANEL.find((x) => x.group === 'weather');
  assert.equal(g.rows[0].key, 'enabled');
  assert.match(g.rows[0].hint, /Off out of the box/);
  for (const h of WEATHER_HOSTS) assert.ok(g.rows[0].hint.includes(h), `the switch names ${h}`);
  assert.deepEqual(g.rows.find((r) => r.key === 'forecast').options.map(([v]) => v), ['current', '7', '10'], 'now, 7 days and 10 days');
  assert.deepEqual(g.rows.find((r) => r.key === 'overviewAt').options.map(([v]) => v), ['above', 'below']);
  assert.deepEqual(g.rows.find((r) => r.key === 'kioskAt').options.map(([v]) => v), ['above', 'below', 'top', 'bottom'], 'the Markets-column panel first: it is the default (2026-10-13, "half the vertical size")');
  assert.equal(DEFAULTS.weather.kioskAt, 'above');
});

test('the Location row sets a name, coordinates and a country, each clamped like any other setting', () => {
  const n = normalise({ weather: { place: 'Ber\u0000lin<script>', lat: 123, lon: -500, country: 'DEU', units: 'kelvin', forecast: '14' } }).weather;
  assert.equal(n.place, 'Berlin<script>', 'control characters go; markup is escaped where it is drawn, not here');
  assert.equal(n.lat, 90); assert.equal(n.lon, -180);
  assert.equal(n.country, 'DE');
  assert.equal(n.units, 'auto'); assert.equal(n.forecast, '7', 'an unknown choice is the default');
  assert.equal(normalise({ weather: { place: 42 } }).weather.place, '', 'not a string: the default');
});

test('weatherOn reads the SHARED settings file; the routes refuse, saying why, until it is ticked', async () => {
  let fetches = 0;
  const app = { settingsFile: tmpFile(), weather: new WeatherFeed({}, { fetchImpl: async () => { fetches++; return okReply(REPLY); } }) };
  assert.equal(await weatherOn(app), false, 'no file: off');
  const off = await route('/api/weather').handler({ query: { lat: '52.52', lon: '13.41' } }, app);
  assert.equal(off.enabled, false); assert.match(off.note, /Enable weather/);
  const offSearch = await route('/api/weather/places').handler({ query: { q: 'Berlin' } }, app);
  assert.equal(offSearch.enabled, false); assert.deepEqual(offSearch.results, []);
  assert.equal(fetches, 0, 'nothing left the machine');
  fs.writeFileSync(app.settingsFile, JSON.stringify({ weather: { enabled: true } }));
  const on = await route('/api/weather').handler({ query: { lat: '52.52', lon: '13.41', units: 'metric' } }, app);
  assert.equal(on.ok, true); assert.equal(on.enabled, true); assert.equal(on.current.temp, 13.7);
  assert.equal(fetches, 1);
  const hard = await route('/api/weather').handler({ query: {} }, { settingsFile: app.settingsFile, weather: null });
  assert.equal(hard.enabled, false); assert.match(hard.note, /cannot turn it on/, 'BLOCKYARD_WEATHER=0 is the hard off');
});

test('the feed asks once per place per fresh window, shares one request in flight, and keeps its last answer through a failure', async () => {
  let t = 1_000_000, calls = 0, fail = false;
  const urls = [];
  const feed = new WeatherFeed({ freshMs: 600_000 }, {
    now: () => t,
    fetchImpl: async (url) => { calls++; urls.push(url); if (fail) throw new Error('offline'); return okReply(REPLY); },
  });
  const [a, b] = await Promise.all([feed.forecast(52.5201, 13.4049, 'metric'), feed.forecast(52.52, 13.40, 'metric')]);
  assert.equal(calls, 1, 'two screens, one request (the place is rounded to two decimals first)');
  assert.equal(a.ok && b.ok, true);
  assert.match(urls[0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.match(urls[0], /latitude=52\.52&longitude=13\.4&/);
  t += 300_000; await feed.forecast(52.52, 13.40, 'metric');
  assert.equal(calls, 1, 'five minutes later: still fresh');
  await feed.forecast(52.52, 13.40, 'imperial');
  assert.equal(calls, 2, 'other units are another forecast');
  assert.match(urls[1], /temperature_unit=fahrenheit/);
  t += 700_000; fail = true;
  const stale = await feed.forecast(52.52, 13.40, 'metric');
  await new Promise((r) => setImmediate(r));
  const after = await feed.forecast(52.52, 13.40, 'metric');
  assert.equal(stale.ok, true, 'the last answer stands while the refresh fails');
  assert.equal(after.error, 'offline', 'and says the refresh failed');
  assert.equal(calls, 3, 'a failure is not retried at once');
  assert.equal((await feed.forecast('x', 1)).ok, false, 'not a place: refused before any request');
  assert.equal((await feed.forecast(91, 0)).ok, false);
  assert.equal(calls, 3);
});

test('the reply is reduced to numbers or nulls, never invented', () => {
  const f = parseForecast(REPLY, 'metric');
  assert.equal(f.days.length, 3); assert.equal(f.hours.length, 4);
  assert.deepEqual(f.days[1], { date: '2026-10-14', code: 61, hi: 16.4, lo: 10, pop: 98, precip: 0.7, wind: 20, uv: 1.5, sunrise: '2026-10-14T07:29', sunset: '2026-10-14T18:19' });
  assert.equal(f.current.day, false); assert.equal(f.current.windDir, 178);
  const holes = parseForecast({ current: { temperature_2m: 'warm' }, daily: { time: ['2026-10-13'] } }, 'metric');
  assert.equal(holes.current.temp, null, 'a figure that is not a number is absent, not zero');
  assert.equal(holes.days[0].hi, null);
  assert.throws(() => parseForecast({ error: true, reason: 'Latitude must be in range' }), /Latitude/);
  assert.throws(() => parseForecast({}), /no current conditions/);
});

test('the place search: names, regions and coordinates, rounded; junk dropped', async () => {
  const got = parseGeocode({ results: [
    { name: 'Berlin', admin1: 'State of Berlin', country: 'Germany', country_code: 'DE', latitude: 52.52437, longitude: 13.41053 },
    { name: 'Nowhere', latitude: 'x', longitude: 1 },
  ] });
  assert.deepEqual(got, [{ name: 'Berlin', region: 'State of Berlin', country: 'Germany', cc: 'DE', lat: 52.52, lon: 13.41 }]);
  assert.deepEqual(parseGeocode({}), []);
  assert.match(geocodeUrl('São Paulo'), /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=S%C3%A3o\+Paulo&/);
  let calls = 0;
  const feed = new WeatherFeed({}, { fetchImpl: async () => { calls++; return okReply({ results: [] }); } });
  await feed.search('Berlin'); await feed.search('berlin');
  assert.equal(calls, 1, 'a search is remembered');
  assert.deepEqual((await feed.search('B')).results, [], 'one letter asks nobody');
  assert.equal(calls, 1);
  assert.deepEqual(placeOf('52.123', '-0.456'), { lat: 52.12, lon: -0.46 });
  assert.match(forecastUrl({ lat: 1, lon: 2 }, 'metric'), /forecast_days=10/, 'ten days asked for: seven is a slice of it');
});

test('codes, skies, units and colours', () => {
  assert.equal(wmo(0, true).label, 'Clear sky'); assert.equal(wmo(0, false).label, 'Clear night');
  assert.equal(wmo(95).kind, 'thunder'); assert.equal(wmo(99).hail, true);
  assert.equal(wmo(1234).kind, 'unknown');
  assert.equal(skyOf(wmo(0, false)), 'night'); assert.equal(skyOf(wmo(65, true)), 'rain'); assert.equal(skyOf(wmo(96, true)), 'storm');
  assert.equal(unitsFor({ units: 'auto', country: 'US' }), 'imperial');
  assert.equal(unitsFor({ units: 'auto', country: 'DE' }), 'metric');
  assert.equal(unitsFor({ units: 'metric', country: 'US' }), 'metric', 'a choice beats the country');
  assert.equal(tempColour(0, 'metric'), tempColour(32, 'imperial'), 'one scale, whatever the units');
  assert.equal(tempColour(-80), tempColour(-25), 'clamped at the cold end');
  assert.equal(compass(178), 'S'); assert.equal(compass(359), 'N');
  for (const code of [0, 1, 2, 3, 45, 51, 56, 61, 66, 71, 80, 85, 95, 96]) {
    for (const day of [true, false]) {
      const svg = iconSvg(wmo(code, day), 32);
      assert.match(svg, /^<svg class="wx-ico[^"]*" viewBox="0 0 64 64"/, `code ${code} draws`);
      assert.ok(!/NaN|undefined/.test(svg), `code ${code}: no holes in the geometry`);
    }
  }
});

test('the ribbon: now alone, seven days or ten; no style attributes (the CSP refuses them); the place escaped', () => {
  const d = { ok: true, enabled: true, at: Date.now(), place: { lat: 52.52, lon: 13.42 }, ...parseForecast({ ...REPLY, daily: { ...REPLY.daily, time: Array.from({ length: 10 }, (_, i) => `2026-10-${13 + i}`) } }, 'metric') };
  const w = (forecast) => ({ ...DEFAULTS.weather, enabled: true, place: 'Berlin <b>', forecast });
  const count = (html) => (html.match(/class="wx-day[ "]/g) ?? []).length;
  assert.equal(count(ribbonHtml(d, w('current'))), 0);
  assert.equal(count(ribbonHtml(d, w('7'))), 7);
  assert.equal(count(ribbonHtml(d, w('10'))), 10);
  const html = ribbonHtml(d, w('10'));
  assert.ok(!/\sstyle=/.test(html), 'no style attribute anywhere');
  assert.ok(html.includes('Berlin &lt;b&gt;') && !html.includes('Berlin <b>'), 'the place name is escaped');
  assert.ok(!/NaN|undefined/.test(html), 'no holes');
  assert.match(html, /wx-sky-overcastnight/, 'the sky is the weather now');
  assert.match(html, /class="wx-day today/, 'the first tile is marked as today');
  assert.match(ribbonHtml(d, { ...w('10'), ribbon: 'full' }), />Today<small>Oct 1[34]<\/small></, 'the full ribbon names it, with the date');
  assert.match(html, /<span class="wx-dn"><b>[A-Z][a-z]{2}<\/b> 1[0-9]<\/span>/, 'a slim tile carries the weekday and the day of the month');
  assert.ok(!/>Today</.test(html) && /wx-slim/.test(html), 'the slim ribbon (the default) shows the weekday instead: the highlight says which is today');
  assert.ok(DEFAULTS.weather.ribbon === 'slim', 'slim ships (2026-10-13: "reduced in half yet again")');
  assert.match(ribbonHtml(null, w('7')), /asking for the weather/);
  assert.match(ribbonHtml({ ok: true, enabled: false, note: 'the switch is off' }, w('7')), /the switch is off/);
  assert.match(ribbonHtml({ ok: false, error: 'HTTP 502' }, w('7')), /HTTP 502/, 'a failure says so, never a blank strip');
  assert.match(ribbonHtml({ needPlace: true }, w('7')), /choose a place/);
  assert.equal(hoursSvg([{ temp: 1 }], 'metric'), '', 'one hour is not a curve');
});

test('the ribbon goes where it is told on Overview and Kiosk, and nowhere while it is off', () => {
  const on = { ...DEFAULTS.weather, enabled: true, place: 'X' };
  assert.equal(slotFor('overview', DEFAULTS.weather), null, 'shipped: off');
  assert.equal(slotFor('overview', on), 'ovWxAbove');
  assert.equal(slotFor('overview', { ...on, overviewAt: 'below' }), 'ovWxBelow');
  assert.equal(slotFor('overview', { ...on, overview: false }), null);
  for (const [at, id] of Object.entries({ top: 'kWxTop', above: 'kWxAbove', below: 'kWxBelow', bottom: 'kWxBottom' })) assert.equal(slotFor('kiosk', { ...on, kioskAt: at }), id);
  assert.equal(slotFor('markets', on), null);
  assert.equal(weatherQuery({ ...on, enabled: false }), null);
  assert.equal(weatherQuery({ ...on, place: '' }), null, 'no place: nobody is asked');
  assert.equal(weatherQuery({ ...on, lat: 40.71, lon: -74.01, country: 'US' }), '/api/weather?lat=40.71&lon=-74.01&units=imperial');
  // every slot exists in the page, and they sit where their names say
  const html = read('public/index.html');
  for (const p of Object.values(SLOTS)) for (const id of p.ids) assert.ok(html.includes(`id="${id}"`), `${id} is in the page`);
  const at = (id) => html.indexOf(`id="${id}"`);
  assert.ok(at('ovWxAbove') < at('ovMkSummary') && at('ovMkSummary') < at('ovWxBelow'), 'above and below the price line');
  assert.ok(at('kWxTop') < at('kWxAbove') && at('kWxAbove') < at('kPrice') && at('kPrice') < at('kWxBelow') && at('kWxBelow') < at('kWxBottom'), 'and round the Kiosk’s price panel');
  assert.ok(at('kiosk') < at('kWxTop') && at('kWxBottom') < html.indexOf('</section>', at('kiosk')), 'inside the kiosk, so full screen keeps it');
});

test('the ribbon’s endless animations run on a live page only', () => {
  const css = read('public/css/app.css');
  const rules = css.match(/[^{}]+\{[^}]*\binfinite\b[^}]*\}/g) ?? [];
  const wx = rules.filter((r) => /\.wx/.test(r.split('{')[0]));
  assert.ok(wx.length >= 5, 'the weather has its motion');
  for (const r of wx) for (const sel of r.split('{')[0].split(',')) assert.match(sel.trim(), /^html\[data-motion="live"\] /, `${sel.trim()} waits for a live page`);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.wx \*/);
});

test('the documented outbound promise names the weather hosts', () => {
  const sec = read('docs/SECURITY.md');
  for (const h of WEATHER_HOSTS) assert.ok(sec.includes(h), `docs/SECURITY.md names ${h}`);
  assert.match(sec, /BLOCKYARD_WEATHER=0/);
});

// THREE PLACES (operator, 2026-10-13: "add support for up to 3 different weather locations and bars on kiosk")
test('up to three places: the first always, the others where set, each its own query and cache; the rows own their coordinates', async () => {
  const w = { ...DEFAULTS.weather, enabled: true, place: 'Boulder', lat: 40.01, lon: -105.27, country: 'US', place3: 'Berlin', lat3: 52.52, lon3: 13.41, country3: 'DE' };
  const ps = placesOf(w);
  assert.deepEqual(ps.map((p) => [p.i, p.place]), [[1, 'Boulder'], [3, 'Berlin']], 'the second is unset and skipped, the third kept with its number');
  assert.equal(weatherQuery(w, ps[0]), '/api/weather?lat=40.01&lon=-105.27&units=imperial');
  assert.equal(weatherQuery(w, ps[1]), '/api/weather?lat=52.52&lon=13.41&units=metric', 'auto units follow each place\u2019s own country');
  assert.equal(placesOf(DEFAULTS.weather).length, 1, 'a fresh setting has the first place alone, unset');
  const asked = [];
  const api = async (q) => { asked.push(q); return { ok: true, q }; };
  pullWeather(w, api, null, ps[0]); pullWeather(w, api, null, ps[1]); pullWeather(w, api, null, ps[0]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['/api/weather?lat=40.01&lon=-105.27&units=imperial', '/api/weather?lat=52.52&lon=13.41&units=metric'], 'one request per place, not per paint');
  assert.equal(pullWeather(w, api, null, ps[1]).q, asked[1], 'each place answers from its own cache');
  const g = PANEL.find((x) => x.group === 'weather');
  for (const k of ['place2', 'place3']) { const r = g.rows.find((x) => x.key === k); assert.equal(r.kind, 'place'); assert.deepEqual(Object.keys(r.owns), [`lat${k.slice(-1)}`, `lon${k.slice(-1)}`, `country${k.slice(-1)}`]); }
  const n = normalise({ weather: { place2: 'X', lat2: 200, lon2: -500, country2: 'xyz' } }).weather;
  assert.equal(n.lat2, 90); assert.equal(n.lon2, -180); assert.equal(n.country2, 'xy', 'owned keys clamp like any setting');
  // the ribbon names the place it was asked for, not the first
  const d = { ok: true, enabled: true, at: Date.now(), place: { lat: 52.52, lon: 13.41 }, units: 'metric', current: { temp: 1, code: 0, day: true }, hours: [], days: [] };
  assert.match(ribbonHtml(d, w, { placeName: 'Berlin' }), />Berlin</);
  assert.ok(!/Boulder/.test(ribbonHtml(d, w, { placeName: 'Berlin' })));
});
