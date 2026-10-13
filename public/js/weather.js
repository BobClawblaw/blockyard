// THE WEATHER RIBBON (operator, 2026-10-13: "add a local weather report feature to blockyard. Something users would
// have to opt into ... current, 7 day, and 10 day forecasts ... a ribbon that shows this info on the top of the
// screen ... above or below the price bar on main page and kiosk mode ... Make the weather graphics beautiful and
// visually stunning").
//
// The data is Open-Meteo's, fetched by the server (server/collect/weather.js; the page's CSP lets it talk to this
// origin only) and asked for here no more than once every five minutes while a ribbon is on screen. Everything in
// this file but `pullWeather` is pure -- strings in, strings out, no DOM -- so the ribbon is tested under node:test.
//
// HOW IT IS DRAWN. Every icon is inline SVG built from a handful of shapes (sun, moon, two clouds, drops, flakes,
// a bolt, fog bars) filled with gradients defined ONCE per page (`WX_DEFS`, which the ribbon carries in a hidden
// <svg>), so a ribbon of eleven icons is eleven small trees of <use>-free paths, not eleven copies of the gradients.
// The temperature colour scale is absolute (in Celsius whatever the units), so a cold week is blue and a hot one
// orange at a glance; the day bars are drawn against ONE gradient laid across the whole span, Apple-Weather style,
// so a bar's colours are the temperatures it covers. No style attributes anywhere: the CSP refuses them, and SVG
// presentation attributes are not style.
//
// MOTION follows the page (theme.js data-motion): drifting clouds, falling rain and a turning sun play only on the
// 'live' page (Page pulses: Smooth); the shipped Simple renderer and the default tick keep the ribbon still, since an
// endless CSS animation composites the whole page every refresh (AGENTS.md, the GPU budget).

import { esc } from './fmt.js';
import { loadSettings } from './settings.js';
import { globeHtml, renderGlobe } from './weatherglobe.js';

// ------------------------------------------------------------------ what the codes mean

/** WMO weather interpretation codes (Open-Meteo's `weather_code`) -> what to draw and what to call it. */
export function wmo(code, day = true) {
  const c = Number(code);
  const T = (kind, label, extra = {}) => ({ kind, label, day, ...extra });
  switch (c) {
    case 0: return T('clear', day ? 'Clear sky' : 'Clear night');
    case 1: return T('partly', 'Mainly clear', { cover: 1 });
    case 2: return T('partly', 'Partly cloudy', { cover: 2 });
    case 3: return T('cloudy', 'Overcast');
    case 45: return T('fog', 'Fog');
    case 48: return T('fog', 'Freezing fog', { ice: true });
    case 51: return T('drizzle', 'Light drizzle', { n: 1 });
    case 53: return T('drizzle', 'Drizzle', { n: 2 });
    case 55: return T('drizzle', 'Dense drizzle', { n: 3 });
    case 56: return T('drizzle', 'Freezing drizzle', { n: 2, ice: true });
    case 57: return T('drizzle', 'Heavy freezing drizzle', { n: 3, ice: true });
    case 61: return T('rain', 'Light rain', { n: 1 });
    case 63: return T('rain', 'Rain', { n: 2 });
    case 65: return T('rain', 'Heavy rain', { n: 3 });
    case 66: return T('sleet', 'Freezing rain', { n: 1, ice: true });
    case 67: return T('sleet', 'Heavy freezing rain', { n: 2, ice: true });
    case 71: return T('snow', 'Light snow', { n: 1 });
    case 73: return T('snow', 'Snow', { n: 2 });
    case 75: return T('snow', 'Heavy snow', { n: 3 });
    case 77: return T('snow', 'Snow grains', { n: 1 });
    case 80: return T('showers', 'Light showers', { n: 1 });
    case 81: return T('showers', 'Showers', { n: 2 });
    case 82: return T('showers', 'Violent showers', { n: 3 });
    case 85: return T('snowshowers', 'Snow showers', { n: 1 });
    case 86: return T('snowshowers', 'Heavy snow showers', { n: 2 });
    case 95: return T('thunder', 'Thunderstorm');
    case 96: return T('thunder', 'Thunderstorm, hail', { hail: true });
    case 99: return T('thunder', 'Severe thunderstorm, hail', { hail: true });
    default: return T('unknown', Number.isFinite(c) ? `Weather code ${c}` : 'No report');
  }
}

/** The sky behind the ribbon: a class for each look, by what is happening and whether the sun is up. */
export function skyOf(w) {
  const k = w.kind;
  if (k === 'thunder') return 'storm';
  if (k === 'snow' || k === 'snowshowers' || k === 'sleet') return w.day ? 'snow' : 'snownight';
  if (k === 'rain' || k === 'showers' || k === 'drizzle') return w.day ? 'rain' : 'rainnight';
  if (k === 'fog') return w.day ? 'fog' : 'fognight';
  if (k === 'cloudy') return w.day ? 'overcast' : 'overcastnight';
  if (k === 'partly') return w.day ? 'partly' : 'night';
  return w.day ? 'clear' : 'night';
}

// ------------------------------------------------------------------ units and colour

// Fahrenheit countries and their territories; everywhere else is metric (Liberia and Myanmar are on the usual list
// but report in Celsius day to day, and are left metric here)
const FAHRENHEIT = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'BS', 'KY', 'BZ', 'PW', 'FM', 'MH']);
/** 'metric' | 'imperial' from the setting, with 'auto' following the chosen place's country. */
export function unitsFor(w) {
  if (w?.units === 'metric' || w?.units === 'imperial') return w.units;
  return FAHRENHEIT.has(String(w?.country ?? '').toUpperCase()) ? 'imperial' : 'metric';
}

const toC = (t, units) => (units === 'imperial' ? (t - 32) * 5 / 9 : t);
// An absolute scale, in Celsius: deep violet at -25 through ice blue, teal, spring green, gold and orange to a hot
// rose at 40. Stops chosen by eye against the ribbon's night sky and its day sky.
const TEMP_STOPS = [
  [-25, [124, 92, 255]], [-12, [79, 140, 255]], [0, [70, 200, 255]], [8, [62, 222, 190]], [15, [130, 230, 110]],
  [21, [228, 226, 80]], [27, [255, 184, 60]], [33, [255, 120, 60]], [40, [255, 66, 110]],
];
/** The colour of a temperature, as #rrggbb. */
export function tempColour(t, units = 'metric') {
  const c = toC(Number(t), units);
  if (!Number.isFinite(c)) return '#8a96a8';
  let i = 0;
  while (i < TEMP_STOPS.length - 1 && c > TEMP_STOPS[i + 1][0]) i++;
  const [t0, a] = TEMP_STOPS[i], [t1, b] = TEMP_STOPS[Math.min(i + 1, TEMP_STOPS.length - 1)];
  const f = t1 === t0 ? 0 : Math.max(0, Math.min(1, (c - t0) / (t1 - t0)));
  return `#${a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, '0')).join('')}`;
}

const r1 = (v) => Math.round(v * 10) / 10;
const deg = (t) => (t == null || !Number.isFinite(t) ? '–' : `${Math.round(t)}°`);
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (d) => (Number.isFinite(d) ? COMPASS[Math.round((((d % 360) + 360) % 360) / 22.5) % 16] : '');

// ------------------------------------------------------------------ the gradients, once per page
// Put in <body> once (ensureDefs), OUTSIDE every page section: a gradient defined inside a display:none subtree is
// not painted by every engine, and the Overview's section is display:none while the Kiosk is open.

export const WX_DEFS = `<svg class="wx-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
<radialGradient id="wxSunCore" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#fffbe0"/><stop offset=".45" stop-color="#ffd84a"/><stop offset="1" stop-color="#ff9d1a"/></radialGradient>
<radialGradient id="wxSunGlow"><stop offset="0" stop-color="#ffd25a" stop-opacity=".55"/><stop offset=".55" stop-color="#ffb030" stop-opacity=".16"/><stop offset="1" stop-color="#ff9a1a" stop-opacity="0"/></radialGradient>
<linearGradient id="wxRay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe680"/><stop offset="1" stop-color="#ffab2e"/></linearGradient>
<radialGradient id="wxMoon" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#e3e9ff"/><stop offset="1" stop-color="#a9b6e8"/></radialGradient>
<mask id="wxCrescent" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="#fff"/><circle cx=".8" cy=".26" r=".46" fill="#000"/></mask>
<radialGradient id="wxMoonGlow"><stop offset="0" stop-color="#b9c8ff" stop-opacity=".45"/><stop offset="1" stop-color="#8aa0ff" stop-opacity="0"/></radialGradient>
<linearGradient id="wxCloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#e6edf7"/><stop offset="1" stop-color="#c3cfe0"/></linearGradient>
<linearGradient id="wxCloudBack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9d4e6"/><stop offset="1" stop-color="#8e9cb4"/></linearGradient>
<linearGradient id="wxCloudDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9aa6bc"/><stop offset=".65" stop-color="#6b7790"/><stop offset="1" stop-color="#4c566c"/></linearGradient>
<linearGradient id="wxCloudStorm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7d7a9e"/><stop offset=".7" stop-color="#4a4766"/><stop offset="1" stop-color="#2e2c44"/></linearGradient>
<linearGradient id="wxDrop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a8dcff" stop-opacity=".2"/><stop offset="1" stop-color="#3d9bff"/></linearGradient>
<linearGradient id="wxIce" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8fbff" stop-opacity=".3"/><stop offset="1" stop-color="#9fe6ff"/></linearGradient>
<linearGradient id="wxBolt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffbd0"/><stop offset=".5" stop-color="#ffe14a"/><stop offset="1" stop-color="#ff9f1a"/></linearGradient>
<radialGradient id="wxBoltGlow"><stop offset="0" stop-color="#fff2a0" stop-opacity=".6"/><stop offset="1" stop-color="#ffcc33" stop-opacity="0"/></radialGradient>
<linearGradient id="wxFog" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#dfe7f2" stop-opacity="0"/><stop offset=".25" stop-color="#dfe7f2" stop-opacity=".9"/><stop offset=".75" stop-color="#dfe7f2" stop-opacity=".9"/><stop offset="1" stop-color="#dfe7f2" stop-opacity="0"/></linearGradient>
</defs></svg>`;

// ------------------------------------------------------------------ the icons

// The cloud outline, in a 64-unit box: three lobes on a flat base from x 12 to 52 at y 47.
const CLOUD = 'M19 47a9 9 0 0 1-1.6-17.86A13.5 13.5 0 0 1 43.2 25.4 10.8 10.8 0 0 1 46 47Z';
const cloud = (fill, tx = 0, ty = 0, s = 1, cls = 'wx-cl') =>
  `<g transform="translate(${tx} ${ty}) scale(${s})"><g class="${cls}"><path d="${CLOUD}" fill="url(#${fill})"/></g></g>`;
// (the class goes on an INNER group: a CSS transform -- the drift on a live page -- replaces an element's transform
// attribute rather than adding to it, and would throw the cloud back to the corner)

function sun(cx, cy, r, rays = true) {
  let s = `<circle cx="${cx}" cy="${cy}" r="${r1(r * 2.1)}" fill="url(#wxSunGlow)"/>`;
  if (rays) {
    s += `<g transform="translate(${cx} ${cy})"><g class="wx-rays">`;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, c = Math.cos(a), n = Math.sin(a);
      s += `<line x1="${r1(c * r * 1.38)}" y1="${r1(n * r * 1.38)}" x2="${r1(c * r * 1.78)}" y2="${r1(n * r * 1.78)}" stroke="url(#wxRay)" stroke-width="${r1(r * 0.22)}" stroke-linecap="round"/>`;
    }
    s += '</g></g>';
  }
  return `${s}<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#wxSunCore)"/>`;
}
function moon(cx, cy, r, stars = true) {
  // a crescent: the disc masked by a second disc set off toward the upper right (wxCrescent, in the shared defs;
  // an even-odd path of the two discs filled the part of the second that lies OUTSIDE the first, and drew a ring)
  let s = `<circle cx="${cx}" cy="${cy}" r="${r1(r * 1.9)}" fill="url(#wxMoonGlow)"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#wxMoon)" mask="url(#wxCrescent)" transform="rotate(-12 ${cx} ${cy})"/>`;
  if (stars) s += `<g class="wx-stars" fill="#eef2ff"><circle cx="${r1(cx + r * 1.25)}" cy="${r1(cy - r * 0.9)}" r="1.1"/><circle cx="${r1(cx + r * 0.7)}" cy="${r1(cy + r * 1.1)}" r=".8"/><circle cx="${r1(cx - r * 1.2)}" cy="${r1(cy - r * 1.05)}" r=".7"/></g>`;
  return s;
}
const orb = (day, cx, cy, r) => (day ? sun(cx, cy, r) : moon(cx, cy, r, false));

function drops(n, ice = false) {
  const xs = n >= 3 ? [20, 27, 34, 41, 48] : n === 2 ? [22, 31, 40, 47] : [25, 35, 44];
  return `<g class="wx-fall">${xs.map((x, i) => {
    const y = 50 + (i % 2) * 3;
    return `<line x1="${x}" y1="${y}" x2="${x - 3}" y2="${y + 8}" stroke="url(#${ice ? 'wxIce' : 'wxDrop'})" stroke-width="2.6" stroke-linecap="round"/>`;
  }).join('')}</g>`;
}
function dots(n, ice = false) {
  const xs = n >= 3 ? [21, 28, 35, 42, 49] : n === 2 ? [24, 32, 40, 47] : [26, 36, 45];
  return `<g class="wx-fall" fill="${ice ? '#bff0ff' : '#7cc4ff'}">${xs.map((x, i) => `<circle cx="${x}" cy="${52 + (i % 2) * 4}" r="1.6"/>`).join('')}</g>`;
}
function flake(x, y, s) {
  let p = '';
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6, c = r1(Math.cos(a) * s), n = r1(Math.sin(a) * s);
    p += `<line x1="${r1(x - c)}" y1="${r1(y - n)}" x2="${r1(x + c)}" y2="${r1(y + n)}"/>`;
  }
  return p;
}
function flakes(n) {
  const at = n >= 3 ? [[21, 53], [31, 57], [41, 53], [49, 58], [26, 61]] : n === 2 ? [[23, 54], [34, 58], [45, 54]] : [[28, 55], [42, 56]];
  return `<g class="wx-fall wx-snow" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round">${at.map(([x, y]) => flake(x, y, 3.4)).join('')}</g>`;
}
const bolt = `<g class="wx-bolt"><circle cx="34" cy="53" r="11" fill="url(#wxBoltGlow)"/><path d="M36 40 25 55h8l-4 12 13-17h-8l5-10Z" fill="url(#wxBolt)" stroke="#fff6c0" stroke-width=".6" stroke-linejoin="round"/></g>`;
const hail = '<g class="wx-fall" fill="#e9f7ff" stroke="#9fd6ff" stroke-width=".6"><circle cx="20" cy="57" r="2"/><circle cx="47" cy="55" r="2"/><circle cx="44" cy="62" r="1.6"/></g>';
const fogBars = `<g class="wx-fogbars">${[[14, 46, 36], [20, 52, 30], [12, 58, 40]].map(([x, y, w]) =>
  `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y}" stroke="url(#wxFog)" stroke-width="3.2" stroke-linecap="round"/>`).join('')}</g>`;

/** One weather icon as an inline SVG string (64-unit box, drawn at `size` px). */
export function iconSvg(w, size = 48) {
  const { kind, day } = w;
  let g;
  switch (kind) {
    case 'clear': g = day ? sun(32, 32, 13) : moon(32, 32, 14); break;
    case 'partly': g = (w.cover === 1 ? orb(day, 24, 24, 11) : orb(day, 23, 22, 10)) + cloud('wxCloud', w.cover === 1 ? 8 : 4, w.cover === 1 ? 6 : 3, w.cover === 1 ? 0.88 : 0.95); break;
    case 'cloudy': g = cloud('wxCloudBack', -6, -9, 0.82, 'wx-cl wx-back') + cloud('wxCloud', 2, 2); break;
    case 'fog': g = cloud('wxCloudBack', 0, -10, 0.9) + fogBars; break;
    case 'drizzle': g = cloud('wxCloudDark', 0, -8) + dots(w.n, w.ice); break;
    case 'rain': g = cloud('wxCloudBack', -7, -14, 0.75, 'wx-cl wx-back') + cloud('wxCloudDark', 0, -8) + drops(w.n); break;
    case 'sleet': g = cloud('wxCloudDark', 0, -8) + drops(1, true) + flakes(1); break;
    case 'showers': g = orb(day, 21, 17, 9) + cloud('wxCloudDark', 2, -6, 0.95) + drops(w.n); break;
    case 'snow': g = cloud('wxCloudBack', -7, -14, 0.75, 'wx-cl wx-back') + cloud('wxCloud', 0, -8) + flakes(w.n); break;
    case 'snowshowers': g = orb(day, 21, 17, 9) + cloud('wxCloud', 2, -6, 0.95) + flakes(w.n); break;
    case 'thunder': g = cloud('wxCloudStorm', -7, -15, 0.75, 'wx-cl wx-back') + cloud('wxCloudStorm', 0, -9) + bolt + (w.hail ? hail : drops(1)); break;
    default: g = cloud('wxCloudBack', 0, 0); break;
  }
  return `<svg class="wx-ico wx-${kind}" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${esc(w.label)}">${g}</svg>`;
}

// ------------------------------------------------------------------ the pieces of the ribbon

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (iso, i) => {
  if (i === 0) return 'Today';
  const [y, m, d] = String(iso).split('-').map(Number);
  return Number.isFinite(y) ? DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] : '–';
};
const clock = (iso) => {
  const m = /T(\d\d):(\d\d)/.exec(String(iso ?? ''));
  if (!m) return '–';
  const h = Number(m[1]);
  return `${h % 12 || 12}${m[2] === '00' ? '' : `:${m[2]}`}${h < 12 ? 'a' : 'p'}`;
};
const hourLabel = (iso) => clock(iso).replace(/:\d\d/, '');

/** The next 24 hours as a temperature curve over chance-of-rain bars: an SVG at its own pixel size. */
export function hoursSvg(hours, units, { w = 236, h = 66, id = 'wxh' } = {}) {
  const pts = hours.filter((x) => x.temp != null);
  if (pts.length < 2) return '';
  const temps = pts.map((x) => x.temp);
  const lo = Math.min(...temps), hi = Math.max(...temps), span = Math.max(hi - lo, units === 'imperial' ? 6 : 3);
  const mid = (hi + lo) / 2, top = 14, bot = h - 17, base = h - 12, barMax = Math.max(12, Math.round(h * 0.22));   // the curve above, rain bars on `base`, hour labels under it
  const X = (i) => r1(6 + (i * (w - 12)) / (hours.length - 1));
  const Y = (t) => r1(bot - ((t - (mid - span / 2)) / span) * (bot - top));
  const P = hours.map((x, i) => (x.temp == null ? null : [X(i), Y(x.temp)])).filter(Boolean);
  // a smooth line through every hour (Catmull-Rom as cubic Béziers)
  let d = `M${P[0][0]} ${P[0][1]}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    d += `C${r1(p1[0] + (p2[0] - p0[0]) / 6)} ${r1(p1[1] + (p2[1] - p0[1]) / 6)} ${r1(p2[0] - (p3[0] - p1[0]) / 6)} ${r1(p2[1] - (p3[1] - p1[1]) / 6)} ${p2[0]} ${p2[1]}`;
  }
  const area = `${d}L${P.at(-1)[0]} ${base}L${P[0][0]} ${base}Z`;
  // the stroke's colour follows the temperature up the panel: a vertical gradient from the span's cold to its warm
  const g = `<linearGradient id="${id}L" gradientUnits="userSpaceOnUse" x1="0" y1="${bot}" x2="0" y2="${top}"><stop offset="0" stop-color="${tempColour(mid - span / 2, units)}"/><stop offset="1" stop-color="${tempColour(mid + span / 2, units)}"/></linearGradient>`
    + `<linearGradient id="${id}A" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tempColour(hi, units)}" stop-opacity=".34"/><stop offset="1" stop-color="${tempColour(lo, units)}" stop-opacity="0"/></linearGradient>`;
  const step = (w - 12) / (hours.length - 1);
  const bw = Math.max(2, step - 2);
  const bars = hours.map((x, i) => (x.pop > 0 ? `<rect x="${r1(X(i) - bw / 2)}" y="${r1(base - (x.pop / 100) * barMax)}" width="${r1(bw)}" height="${r1(Math.max(0.8, (x.pop / 100) * barMax))}" rx="1" fill="#4aa8ff" fill-opacity="${r1(0.3 + (x.pop / 100) * 0.6)}"/>` : '')).join('');
  // the night as one soft band per run of dark hours (one rect an hour drew as a barcode)
  let night = '';
  for (let i = 0; i < hours.length; i++) {
    if (hours[i].day) continue;
    let j = i;
    while (j + 1 < hours.length && !hours[j + 1].day) j++;
    const x0 = Math.max(0, X(i) - step / 2), x1 = Math.min(w, X(j) + step / 2);
    night += `<rect x="${r1(x0)}" y="2" width="${r1(x1 - x0)}" height="${base - 2}" rx="4" fill="#020617" fill-opacity=".2"/>`;
    i = j;
  }
  const iHi = hours.findIndex((x) => x.temp === hi), iLo = hours.findIndex((x) => x.temp === lo);
  const tag = (i, above) => `<circle cx="${X(i)}" cy="${Y(hours[i].temp)}" r="2.4" fill="${tempColour(hours[i].temp, units)}" stroke="#0b1220" stroke-width="1"/>`
    + `<text x="${Math.min(w - 12, Math.max(12, X(i)))}" y="${r1(Y(hours[i].temp) + (above ? -5 : 11))}" text-anchor="middle" class="wx-hv">${deg(hours[i].temp)}</text>`;
  const ticks = [0, 6, 12, 18].filter((i) => i < hours.length).map((i) =>
    `<text x="${Math.max(10, Math.min(w - 10, X(i)))}" y="${h - 1.5}" text-anchor="middle" class="wx-ht">${i === 0 ? 'now' : hourLabel(hours[i].t)}</text>`).join('');
  return `<svg class="wx-hours" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="the next 24 hours: ${deg(lo)} to ${deg(hi)}"><defs>${g}</defs>`
    + `${night}${bars}<path d="${area}" fill="url(#${id}A)"/><path d="${d}" fill="none" stroke="url(#${id}L)" stroke-width="2.4" stroke-linecap="round"/>`
    + `${iHi !== iLo ? tag(iLo, false) : ''}${tag(iHi, true)}${ticks}</svg>`;
}

/** The day bars: each day's low-to-high span over the whole forecast's span, cut from one gradient laid across it. */
export function dayBar(day, lo, hi, units, id, now = null) {
  if (day.lo == null || day.hi == null || !(hi > lo)) return '<span class="wx-bar"></span>';
  const x = (t) => r1(((t - lo) / (hi - lo)) * 100);
  // LINES WITH A NON-SCALING STROKE, not rounded rects: the box is stretched to the cell (preserveAspectRatio none),
  // which drew a rect's rounded ends -- and a dot -- as long points on a wide row
  const dot = now == null ? '' : `<line class="wx-now-tick" x1="${Math.max(1, Math.min(99, x(now)))}" y1="3" x2="${Math.max(1, Math.min(99, x(now)))}" y2="3" stroke="#ffffff" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  return `<svg class="wx-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><line class="wx-track" x1="0" y1="3" x2="100" y2="3" stroke="currentColor" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
    + `<line class="wx-span" x1="${x(day.lo)}" y1="3" x2="${Math.max(x(day.lo) + 0.5, x(day.hi))}" y2="3" stroke="url(#${id})" stroke-linecap="round" vector-effect="non-scaling-stroke"/>${dot}</svg>`;
}

function weekGradient(id, lo, hi, units) {
  const stops = [];
  for (let i = 0; i <= 6; i++) { const t = lo + ((hi - lo) * i) / 6; stops.push(`<stop offset="${r1(i / 6)}" stop-color="${tempColour(t, units)}"/>`); }
  return `<svg class="wx-defs" width="0" height="0" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">${stops.join('')}</linearGradient></defs></svg>`;
}

/** Wind as an arrow pointing where it blows TO (the reported direction is where it comes from). */
const windArrow = (dir) => (Number.isFinite(dir)
  ? `<svg class="wx-wind" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><g transform="rotate(${Math.round(dir + 180)} 8 8)"><path d="M8 1.5 12 9.5 8 7.6 4 9.5Z" fill="currentColor"/><line x1="8" y1="7" x2="8" y2="14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></g></svg>`
  : '');

// ------------------------------------------------------------------ the ribbon

const FORECASTS = { current: 0, 7: 7, 10: 10 };

/**
 * The whole ribbon as HTML. `d` is /api/weather's reply; `w` the weather settings; `opts.id` keeps a page's two
 * ribbons' gradient ids apart; `opts.now` the clock (for the age line).
 */
function notReady(d, w) {
  if (!d) return 'asking for the weather…';
  if (d.needPlace) return 'Weather is on -- choose a place under Display settings → Weather → Location';
  if (d.enabled === false) return d.note ?? 'weather is off';
  if (!d.ok) return `no forecast for ${w?.place || 'this place'}: ${d.error ?? 'the service did not answer'}`;
  return null;
}

export function ribbonHtml(d, w, { id = 'wx', now = Date.now(), compact = false } = {}) {
  const why = notReady(d, w);
  if (why) return `<div class="wx wx-sky-night wx-empty"><span class="wx-msg">${esc(why)}</span></div>`;
  const units = d.units === 'imperial' ? 'imperial' : 'metric';
  const c = d.current ?? {};
  const cw = wmo(c.code, c.day);
  const wind = units === 'imperial' ? 'mph' : 'km/h';
  const today = d.days?.[0] ?? {};
  const n = FORECASTS[w?.forecast] ?? 7;
  const days = (d.days ?? []).slice(0, n);
  const ageMin = Math.max(0, Math.round((now - (d.at ?? now)) / 60_000));
  const stale = d.error ? ` <b class="wx-stale" title="${esc(d.error)}">last answer</b>` : '';
  // the next turn of the light: tonight's sunset by day; by night the next sunrise, today's if it is still to come
  const nextSun = c.day ? today.sunset : (c.time && today.sunrise && c.time < today.sunrise ? today.sunrise : d.days?.[1]?.sunrise);
  const facts = [
    c.wind != null ? `<span>${windArrow(c.windDir)}<b>${Math.round(c.wind)}</b> ${wind} ${compass(c.windDir)}${c.gusts != null && c.gusts > c.wind * 1.25 ? `<i>gusts ${Math.round(c.gusts)}</i>` : ''}</span>` : '',
    c.humidity != null ? `<span><i>humidity</i><b>${Math.round(c.humidity)}%</b></span>` : '',
    c.uv != null && c.day ? `<span><i>UV</i><b>${r1(c.uv)}</b></span>` : '',
    c.pressure != null && !compact ? `<span><i>pressure</i><b>${units === 'imperial' ? (c.pressure * 0.02953).toFixed(2) : Math.round(c.pressure)}</b> ${units === 'imperial' ? 'inHg' : 'hPa'}</span>` : '',
    nextSun ? `<span><i>${c.day ? 'sunset' : 'sunrise'}</i><b>${clock(nextSun)}</b></span>` : '',
  ].filter(Boolean).join('');
  const now$ = `<div class="wx-now">${iconSvg(cw, compact ? 54 : 64)}
    <div class="wx-temp"><b>${deg(c.temp)}</b><small>${units === 'imperial' ? 'F' : 'C'}</small></div>
    <div class="wx-say"><b>${esc(cw.label)}</b><span>feels ${deg(c.feels)} · <em class="wx-hi">H ${deg(today.hi)}</em> <em class="wx-lo">L ${deg(today.lo)}</em></span>
      <span class="wx-where" title="${esc(`${d.place?.lat}, ${d.place?.lon} · ${d.timezone ?? ''} · Open-Meteo`)}">${esc(w?.place || `${d.place?.lat}, ${d.place?.lon}`)} · ${ageMin < 1 ? 'just now' : `${ageMin} min ago`}${stale}</span></div>
  </div>`;
  const hoursHtml = w?.hourly !== false ? `<div class="wx-24">${hoursSvg(d.hours ?? [], units, { id: `${id}h`, w: compact ? 200 : 236 })}</div>` : '';
  let daysHtml = '';
  if (days.length) {
    const lo = Math.min(...days.map((x) => x.lo).filter((v) => v != null)), hi = Math.max(...days.map((x) => x.hi).filter((v) => v != null));
    const gid = `${id}w`;
    daysHtml = `${weekGradient(gid, lo, hi, units)}<div class="wx-days wx-n${days.length}">${days.map((x, i) => {
      const xw = wmo(x.code, true);
      const pop = x.pop != null && x.pop >= 10 ? `<span class="wx-pop${x.pop >= 60 ? ' wet' : ''}">${Math.round(x.pop)}%</span>` : '<span class="wx-pop"></span>';
      return `<div class="wx-day${i === 0 ? ' today' : ''}" title="${esc(`${x.date}: ${xw.label}${x.precip ? `, ${x.precip} ${units === 'imperial' ? 'in' : 'mm'}` : ''}${x.wind != null ? `, wind to ${Math.round(x.wind)} ${wind}` : ''}`)}">`
        + `<span class="wx-dn">${dayName(x.date, i)}</span>${iconSvg(xw, compact ? 32 : 38)}${pop}`
        + `<span class="wx-hl"><b>${deg(x.hi)}</b><i>${deg(x.lo)}</i></span>${dayBar(x, lo, hi, units, gid, i === 0 ? c.temp : null)}</div>`;
    }).join('')}</div>`;
  }
  return `<div class="wx wx-sky-${skyOf(cw)}${compact ? ' wx-compact' : ''}${n === 0 ? ' wx-nowonly' : ''}"><div class="wx-glow"></div>${now$}<div class="wx-facts">${facts}</div>${hoursHtml}${daysHtml}</div>`;
}

// ------------------------------------------------------------------ fetching (the one impure part)

const cache = { key: null, data: null, at: 0, busy: false };
export const WEATHER_REFRESH_MS = 5 * 60_000;
/** The query a ribbon with these settings asks for, or null while there is no place to ask about. */
export function weatherQuery(w) {
  if (!w?.enabled || !w.place) return null;
  return `/api/weather?lat=${encodeURIComponent(w.lat)}&lon=${encodeURIComponent(w.lon)}&units=${unitsFor(w)}`;
}
/** The last reply for these settings, fetching a fresh one when it is due; `done` is called when one lands. */
export function pullWeather(w, api, done) {
  const q = weatherQuery(w);
  if (!q) return null;
  const due = cache.key !== q || Date.now() - cache.at > WEATHER_REFRESH_MS;
  if (due && !cache.busy && !(typeof document !== 'undefined' && document.hidden)) {
    cache.busy = true;
    if (cache.key !== q) cache.data = null;
    const key = q;
    cache.key = q; cache.at = Date.now();
    api(q).then((d) => { if (cache.key === key) cache.data = d; }).catch((e) => {
      if (cache.key === key) cache.data = { ok: false, error: String(e?.message ?? e) };
    }).finally(() => { cache.busy = false; done?.(); });
  }
  return cache.key === q ? cache.data : null;
}

/** Paint a ribbon into `el` only when what it shows has changed (render() runs once a second). */
export function paintRibbon(el, d, w, opts = {}) {
  if (!el) return;
  const minute = Math.floor(Date.now() / 60_000);
  const sig = JSON.stringify([d?.at ?? null, d?.ok, d?.note, d?.error, w, opts.compact, minute]);
  if (el.__wxSig === sig) return;
  const fresh = el.__wxAt !== (d?.at ?? null);
  el.__wxSig = sig; el.__wxAt = d?.at ?? null;
  el.innerHTML = ribbonHtml(d, w, opts);
  if (fresh) el.firstElementChild?.classList.add('wx-arrive');
}

function ensureDefs() {
  if (typeof document === 'undefined' || document.getElementById('wxDefs')) return;
  const box = document.createElement('div');
  box.id = 'wxDefs';
  box.className = 'wx-defs';
  box.innerHTML = WX_DEFS;
  document.body.appendChild(box);
}

// Where each page's ribbon may go, and which slot each setting picks.
export const SLOTS = Object.freeze({
  overview: Object.freeze({ ids: Object.freeze(['ovWxAbove', 'ovWxBelow']), on: 'overview', at: 'overviewAt', pick: Object.freeze({ above: 'ovWxAbove', below: 'ovWxBelow' }) }),
  kiosk: Object.freeze({ ids: Object.freeze(['kWxTop', 'kWxAbove', 'kWxBelow', 'kWxBottom']), on: 'kiosk', at: 'kioskAt', pick: Object.freeze({ top: 'kWxTop', above: 'kWxAbove', below: 'kWxBelow', bottom: 'kWxBottom' }) }),
});
/** Which slot of `page` the ribbon goes in under these settings, or null for none. */
export function slotFor(page, w) {
  const p = SLOTS[page];
  if (!p || !w?.enabled || !w[p.on]) return null;
  return p.pick[w[p.at]] ?? p.ids[0];
}

/** The ribbon on `page` (Overview or Kiosk): fills the chosen slot, empties the others. Called on every render. */
export function renderWeather(page, h) {
  const p = SLOTS[page];
  if (!p || typeof document === 'undefined') return;
  const w = loadSettings().weather;
  const active = slotFor(page, w);
  const d = !active ? null : w.place ? pullWeather(w, h.api, () => h.render?.()) : { needPlace: true };
  if (active) ensureDefs();
  for (const id of p.ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const on = id === active;
    el.hidden = !on;
    if (!on) { if (el.__wxSig || el.__wxPanel) { el.innerHTML = ''; el.__wxSig = null; el.__wxAt = undefined; el.__wxPanel = false; el.classList.remove('kpanel', 'kwx-big'); } continue; }
    // THE KIOSK'S COLUMN PANEL (operator, 2026-10-13: "make the weather take up half the vertical size on kiosk"): half
    // the Markets column, the ribbon over the local map -- the same globe element kind the Weather tab has, bare (no
    // bar: nobody at a wall clicks), the radar loop playing by itself on Software and WebGL, the latest frame on Simple
    if (page === 'kiosk' && (w.kioskAt === 'above' || w.kioskAt === 'below')) {
      if (!el.__wxPanel) {
        el.__wxPanel = true;
        el.classList.add('kpanel', 'kwx-big');
        el.innerHTML = '<div class="khead"><b>Weather</b><span class="faint" data-wx-khead></span></div><div class="wx-rib"></div>';
        if (!kioskGlobeEl) { kioskGlobeEl = document.createElement('div'); kioskGlobeEl.className = 'wxg wxg-bare'; kioskGlobeEl.innerHTML = globeHtml({ bare: true }); }
        el.appendChild(kioskGlobeEl);
      }
      const head = el.querySelector('[data-wx-khead]');
      const headText = `${w.place || 'no place chosen'} · Open-Meteo${w.mapLayer === 'forecast' ? '' : ' · RainViewer radar'}`;
      if (head && head.textContent !== headText) head.textContent = headText;
      paintRibbon(el.querySelector('.wx-rib'), d, w, { id: `${page}wx`, compact: true });
      if (d?.ok && kioskGlobeEl?.isConnected) renderGlobe(kioskGlobeEl.querySelector('.wxg-box'), w, h, { autoplay: true });
      continue;
    }
    paintRibbon(el, d, w, { id: `${page}wx`, compact: false });
  }
}
let kioskGlobeEl = null;

// ------------------------------------------------------------------ the Weather tab

// THE WEATHER TAB (operator, 2026-10-13: "Might as well try to squeeze in an optional 'Weather' Tab if enabled and it
// fits on the bar"): the same reply as the ribbon, at full size -- the conditions as a hero, the next 24 hours as a
// wide curve over an hour-by-hour strip, and every day the reply holds (ten) as rows on one shared scale. Its nav
// button shows only while weather is on and weather.tab is ticked.
export const tabShown = (w) => !!(w?.enabled && w.tab);

/** The Weather page as HTML (pure, like the ribbon). */
export function pageHtml(d, w, { now = Date.now(), width = 1200 } = {}) {
  const why = notReady(d, w);
  if (why) return `<div class="wx wx-sky-night wx-empty wxp-empty"><span class="wx-msg">${esc(why)}</span></div>`;
  const units = d.units === 'imperial' ? 'imperial' : 'metric';
  const c = d.current ?? {};
  const cw = wmo(c.code, c.day);
  const wind = units === 'imperial' ? 'mph' : 'km/h';
  const rain = units === 'imperial' ? 'in' : 'mm';
  const today = d.days?.[0] ?? {};
  const ageMin = Math.max(0, Math.round((now - (d.at ?? now)) / 60_000));
  const nextSun = c.day ? today.sunset : (c.time && today.sunrise && c.time < today.sunrise ? today.sunrise : d.days?.[1]?.sunrise);
  const fact = (k, v, u = '') => (v == null || v === '' ? '' : `<div class="wxp-fact"><i>${k}</i><b>${v}</b>${u ? `<small>${u}</small>` : ''}</div>`);
  const facts = [
    c.wind != null ? `<div class="wxp-fact"><i>wind</i><b>${windArrow(c.windDir)} ${Math.round(c.wind)}</b><small>${wind} ${compass(c.windDir)}</small></div>` : '',
    fact('gusts', c.gusts != null ? Math.round(c.gusts) : null, wind),
    fact('humidity', c.humidity != null ? `${Math.round(c.humidity)}%` : null),
    fact('cloud', c.cloud != null ? `${Math.round(c.cloud)}%` : null),
    fact('UV index', c.uv != null ? r1(c.uv) : null),
    fact('pressure', c.pressure != null ? (units === 'imperial' ? (c.pressure * 0.02953).toFixed(2) : Math.round(c.pressure)) : null, units === 'imperial' ? 'inHg' : 'hPa'),
    fact('rain now', c.precip != null ? c.precip : null, rain),
    fact(c.day ? 'sunset' : 'sunrise', nextSun ? clock(nextSun) : null),
  ].join('');
  const hero = `<div class="wx wxp-hero wx-sky-${skyOf(cw)}"><div class="wx-glow"></div>
    <div class="wxp-now">${iconSvg(cw, 132)}<div class="wxp-temp"><b>${deg(c.temp)}</b><small>${units === 'imperial' ? 'F' : 'C'}</small></div>
      <div class="wxp-say"><b>${esc(cw.label)}</b><span>feels like ${deg(c.feels)}</span><span><em class="wx-hi">High ${deg(today.hi)}</em> · <em class="wx-lo">Low ${deg(today.lo)}</em></span>
      <span class="wxp-where">${esc(w?.place || `${d.place?.lat}, ${d.place?.lon}`)}</span></div></div>
    <div class="wxp-facts">${facts}</div></div>`;
  const hours = d.hours ?? [];
  const hw = Math.max(480, Math.min(1800, Math.round(width - 40)));
  const strip = hours.map((x, i) => {
    const xw = wmo(x.code, x.day);
    return `<div class="wxp-hour${i === 0 ? ' now' : ''}"><span>${i === 0 ? 'Now' : hourLabel(x.t)}</span>${iconSvg(xw, 30)}<b>${deg(x.temp)}</b><i>${x.pop ? `${Math.round(x.pop)}%` : ''}</i></div>`;
  }).join('');
  const day24 = `<div class="card wxp-card"><h3>Next 24 hours <span class="sp"></span><span class="src">temperature, chance of rain, the night shaded</span></h3>`
    + `<div class="wxp-curve">${hoursSvg(hours, units, { id: 'wxpH', w: hw, h: 150 })}</div><div class="wxp-hours">${strip}</div></div>`;
  const days = d.days ?? [];
  let list = '';
  if (days.length) {
    const lo = Math.min(...days.map((x) => x.lo).filter((v) => v != null)), hi = Math.max(...days.map((x) => x.hi).filter((v) => v != null));
    list = `${weekGradient('wxpW', lo, hi, units)}<div class="wxp-days">${days.map((x, i) => {
      const xw = wmo(x.code, true);
      return `<div class="wxp-day${i === 0 ? ' today' : ''}"><span class="wxp-dn">${dayName(x.date, i)}<small>${esc(String(x.date ?? '').slice(5).replace('-', '/'))}</small></span>`
        + `${iconSvg(xw, 40)}<span class="wxp-cond">${esc(xw.label)}</span>`
        + `<span class="wx-pop${x.pop >= 60 ? ' wet' : ''}">${x.pop != null && x.pop >= 10 ? `${Math.round(x.pop)}%` : ''}</span>`
        + `<span class="wxp-lo">${deg(x.lo)}</span>${dayBar(x, lo, hi, units, 'wxpW', i === 0 ? c.temp : null)}<span class="wxp-hi">${deg(x.hi)}</span>`
        + `<span class="wxp-more">${x.precip ? `${x.precip} ${rain}` : ''}${x.wind != null ? `<i>wind ${Math.round(x.wind)} ${wind}</i>` : ''}${x.uv != null ? `<i>UV ${r1(x.uv)}</i>` : ''}</span></div>`;
    }).join('')}</div>`;
  }
  const daysCard = `<div class="card wxp-card"><h3>${days.length}-day forecast <span class="sp"></span><span class="src">each day's low to high, on one scale for the whole span</span></h3>${list}</div>`;
  const foot = `<p class="wxp-foot tiny faint">Forecast by <b>Open-Meteo</b> (open-meteo.com), asked for by this monitor's server · ${esc(d.timezone ?? '')} ${esc(d.tzAbbr ?? '')} · ${d.place?.lat}, ${d.place?.lon} · ${ageMin < 1 ? 'updated just now' : `updated ${ageMin} min ago`}${d.error ? ` · the last refresh failed: ${esc(d.error)}` : ''}</p>`;
  // the globe's place in the page: weatherglobe.js owns the element, which renderWeatherPage moves into this slot
  // after every redraw (its canvases and their contexts survive a DOM move; an innerHTML would destroy them)
  const globe = w?.map && w?.tab ? '<div class="card wxp-card wxp-globecard"><h3>The globe <span class="sp"></span><span class="src">drag to turn, scroll to zoom; past a point it flattens into a map</span></h3><div data-wx-globe-slot></div></div>' : '';
  return `<div class="wxp">${hero}${globe}${day24}${daysCard}${foot}</div>`;
}

/** The Weather page: drawn when its reply or its size changes. */
export function renderWeatherPage(h) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('wxPage');
  if (!el) return;
  const w = loadSettings().weather;
  const d = !w.enabled ? { enabled: false, note: 'Weather is off. Switch it on under Display settings → Weather → Enable weather' }
    : w.place ? pullWeather(w, h.api, () => h.render?.()) : { needPlace: true };
  ensureDefs();
  const width = el.clientWidth || 1200;
  const sig = JSON.stringify([d?.at ?? null, d?.ok, d?.note, d?.error, d?.needPlace, w, Math.round(width / 40), Math.floor(Date.now() / 60_000)]);
  if (el.__wxSig === sig) return;
  el.__wxSig = sig;
  el.innerHTML = pageHtml(d, w, { width });
  const slot = el.querySelector('[data-wx-globe-slot]');
  if (slot) {
    if (!globeEl) { globeEl = document.createElement('div'); globeEl.className = 'wxg'; globeEl.innerHTML = globeHtml(); }
    slot.replaceWith(globeEl);
  }
  if (globeEl?.isConnected && d?.ok) renderGlobe(globeEl.querySelector('.wxg-box'), w, h);
}
let globeEl = null;
