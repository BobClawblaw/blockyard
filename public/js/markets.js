// THE MARKETS TAB (operator, 2026-09-11: "another tab that basically rips off bitcoinity.org
// entirely" ... "we should really leverage the 3D view we have established with the block space
// panel ... If we're going to render a price chart, it would be good to see it on a similar grid
// structure, with similar effects, just tasked to show market data").
//
// One series, two views, both driven by the toolbar (exchange, range):
//   * the PRICE CHART (pricechart.js) -- flat and exact: axes, candles, volume, crosshair. The
//     first cut of this tab had only rows of 3D towers with no axis, and the operator's verdict
//     was "What the fuck is this? Where is the price chart info?!??";
//   * the SAME CHART ON THE 3D BOARD (details3d board3d) -- operator: "Remember, we can alter the
//     perspective. I just want to leverage the 3D view engine we have". The camera is swung round
//     to face a shallow board (CAMERA_3D: height reads straight up, as price) and parked along the
//     bottom of the panel; each hour is a candle FLOATING at its price -- a body from open to close
//     and a thin wick below and above it from low to high, standing on `floor` (a resting
//     altitude) -- with volume on the floor in front, and the engine drawing the price levels and
//     the hours through the same projection (opts.axes). A candle's id is its exchange and hour,
//     so a new hour slides the chart along and another exchange drops its own candles in.
// The server polls five exchanges' public APIs while this tab is open (server/collect/markets.js).
import { board3d } from './details3d.js';
import { loadSettings, setSetting, marketsOptions } from './settings.js';
import { drawPriceChart, readout, EX_COLORS } from './pricechart.js';
import { niceTicks } from './charts.js';
import { INK } from './theme.js';
import { renderDepth } from './depthchart.js';

export const REFRESH_MS = 15_000;
export const RANGES = [[24, '24 h'], [48, '48 h'], [168, '7 d']];
// 72, AND THE 168 EXPERIMENT IS WHY (2026-09-12). The original note here read "168 towers on the
// board is a comb, not a chart". The operator chose to overrule it -- the 7 d button said seven
// days and the board drew three, undisclosed -- so the cap went to 168 and the result was worse
// than the truncation: not a comb, a broken chart. Measured and seen: gridW 336 units drove
// fitZ to zMax 101 (from 37), so the vertical scale spanned far more than the week's actual price
// movement and every body collapsed into a strip along the floor, in two disconnected bands, while
// the close line still ran the full width. Reverted by the operator's call: "back to 72".
//
// So the old note was right about the outcome and imprecise about the cause. The limit is not
// really "168 candles look like a comb" -- it is that widening the board drives the price band
// taller (fitZ solves zMax from the panel's aspect), and past roughly 72 hours the scale stops
// describing the data. Raising this number again means fixing that coupling first.
//
// The truncation is now STATED rather than silent: renderMarkets says so whenever the chosen range
// is longer than this, which is the thing the operator was right to object to.
export const MAX_3D_HOURS = 72;
// the 3D candle: two units a slot, a 1.4-unit body, a 0.4-unit wick, prices over 28 units
// zBase: the price band starts above the volume band -- from a low camera the volume in the
// front row would otherwise stand in front of the lowest candles
export const C3 = { slot: 2, body: 1.4, wick: 0.4, zMax: 28, depth: 8, row: 3, volMax: 4, zBase: 6 };
export const CAMERA_3D = {
  // low (operator: "even lower ... more of the side view, than from above"): depth drawn at 0.3
  oblique: { ox: 0.07, oy: 0.95, dy: 0.3, headroom: C3.zBase + C3.zMax + 2, flight: 10, anchor: 'bottom' },
  // flat: a bowed board bent the price levels in the middle away from the labels at the edge
  dome: 0,
  gridStep: 2,
  // SPACE (operator: "make the floor transparent black against a twinkling star field. Get rid of
  // the texture entirely for the markets page"): no deck texture, a translucent black board over
  // a twinkling star field, quieter cell lines
  space: true,
  // and no ground grid at all: "Just draw the one single line between the candles and the date/time"
  floorLine: true,
  // lit from the viewer (operator: "move the lighting to the viewer position ... everything bright
  // and clear on the faces"): brightest toward the camera, light edges, no cast shadows
  light: 'viewer',
  background: 'rgba(1,2,8,1)',
  neonCell: 'rgba(40,150,100,0.5)',
  // a new hour slides the whole row one slot: brisk, not the block board's 20 s reshuffle
  transition: { rise: 700, travel: 2200, drop: 1400, riseStagger: 300, dropStagger: 600, entryMs: 600 },
};
const UP = '#1fc98a', DOWN = '#ef4d5e';
// volume, lit as brightly as the candles (operator: "not enough light on the volume activity at the
// grid level")
const UP_V = '#2bd49a', DOWN_V = '#f0606e';
const UP_W = '#8af2c9', DOWN_W = '#ff9ea8';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// THE TOOLBAR IS A PREFERENCE (operator, 2026-09-12: "We need to remember the user settings for
// the Markets page"). The exchange and the range were a click that lasted until the tab closed.
// They are seeded from the store on first use and written back on every click, so the page opens
// where it was left -- on this browser, like every other display setting.
const M = { data: null, at: 0, busy: false, error: null, ex: null, range: null, view: null, hover: null, bound: false };
function prefs() {
  if (M.ex === null || M.range === null || M.view === null) {
    const mk = loadSettings().markets;
    M.ex = mk.exchange;
    M.range = Number(mk.range);
    M.view = mk.priceView;
  }
  return M;
}

// ONE VIEW OR THE OTHER (operator, 2026-09-12: "have a selector for either the 3D view or 2D view
// for price. Not both at the same time. Too much waste of space for that screen"). The two views
// draw the SAME hours from the same series -- that is the point of the pair, and also why showing
// both spent two tall panels saying one thing. The Kiosk is unaffected: renderMarketsBoard draws
// the board on its own canvas and does not consult this.
// 2D first, and the default (operator: "Swap 2D and 3D view buttons and make 2D view the default").
export const PRICE_VIEWS = Object.freeze([
  Object.freeze({ id: '2d', label: '2D', title: '2D: the flat chart -- axes, volume and a crosshair' }),
  Object.freeze({ id: '3d', label: '3D', title: '3D: each hour a candle floating at its price, over the star field' }),
]);

const r2 = (v) => Math.round(v * 100) / 100;
const money = (v, dp = 2) => (v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));

// Pure: the chart series in, board3d tiles and axes out.
// THE CHART FILLS THE PANEL (operator, 2026-09-11: "bring view in lower . and not waste so much
// space with the top half of the market grid"). The camera fit is bound by the board's WIDTH in a
// wide panel, so a fixed 28-unit price height left the top half empty. The height is solved from
// the panel's shape instead: the most price height whose headroom still fits (obliqueFit, anchor
// 'bottom': gridH + (zMax + 4) * oy + 3 units tall against gridW + 9 + 2 * (zMax + 4) * ox wide).
export function fitZ(aspect, gridW, cam = CAMERA_3D) {
  const { ox, oy } = cam.oblique;
  const dyS = cam.oblique.dy ?? 1;
  let z = C3.zMax;
  for (let k = 0; k < 4; k++) {
    const head = C3.zBase + z + 2 + (cam.dome ?? 0);
    const wU = gridW + 9 + 2 * head * ox;
    z = (wU * aspect - C3.depth * dyS - 3) / oy - 2 - (cam.dome ?? 0) - C3.zBase;
  }
  // (the cap was 90: a near-square panel -- the Kiosk's -- wanted ~125, so the camera fitted the
  // board's width and left the top quarter of the panel empty)
  return Math.max(12, Math.min(160, Math.floor(z * 0.97)));
}

// `fit`: the price range the board was last drawn to ({ lo, hi }), from the caller's memory. A
// STEADY FIT (operator, 2026-09-15: "when the black hole sequence finishes, it causes a strange
// redraw of the entire market screen that snaps it into a new sized view"). A refresh arriving
// during an effect is parked until the effect ends, and every refresh re-fitted the price range
// from the new candles -- so the whole chart re-scaled, unanimated, at the moment the effect let
// go. The last fit is kept while the data still sits inside it and fills at least two-thirds of
// it; only data that leaves the range, or shrinks well inside it, re-fits.
export function chart3d(ser, { hours = MAX_3D_HOURS, zMax = C3.zMax, fit = null } = {}) {
  const cs = (ser?.candles ?? []).slice(-hours).filter((k) => Number.isFinite(k.c) && Number.isFinite(k.o));
  if (!cs.length) return { tiles: [], gridW: C3.slot, gridH: C3.depth, axes: null, lo: null, hi: null };
  let lo = Infinity, hi = -Infinity, vmax = 1e-9;
  for (const k of cs) { lo = Math.min(lo, k.l ?? k.c); hi = Math.max(hi, k.h ?? k.c); vmax = Math.max(vmax, k.v ?? 0); }
  const pad = (hi - lo) * 0.04 || 1;
  const rawLo = lo, rawHi = hi;
  lo -= pad; hi += pad;
  if (fit && Number.isFinite(fit.lo) && Number.isFinite(fit.hi) && fit.hi > fit.lo
    && rawLo >= fit.lo && rawHi <= fit.hi && (rawHi - rawLo) >= (fit.hi - fit.lo) * 0.66) { lo = fit.lo; hi = fit.hi; }
  const Z = (p) => C3.zBase + ((p - lo) / (hi - lo)) * zMax;
  const id = ser.base?.id ?? 'x';
  const name = `${ser.base?.name ?? ''} ${ser.base?.pair ?? ''}`.trim();
  const tiles = [];
  cs.forEach((k, i) => {
    const up = k.c >= k.o;
    const x = i * C3.slot + (C3.slot - C3.body) / 2;
    const wx = i * C3.slot + (C3.slot - C3.wick) / 2, wy = C3.row + (C3.body - C3.wick) / 2;
    const z0 = Z(Math.min(k.o, k.c)), z1 = Z(Math.max(k.o, k.c));
    const zl = Z(k.l ?? Math.min(k.o, k.c)), zh = Z(k.h ?? Math.max(k.o, k.c));
    const top = Math.max(z1, z0 + 0.25);
    const label = readout(k, name);
    tiles.push({ txid: `v:${id}:${k.t}`, x, y: 0.5, s: C3.body, tall: r2(Math.max(0.12, ((k.v ?? 0) / vmax) * C3.volMax)), color: up ? UP_V : DOWN_V, label });
    // the wick inside the body's footprint, at the body's depth, so its height reads as the
    // body's does (a wick set behind the body drew a unit higher per unit of depth)
    if (z0 - zl > 0.05) tiles.push({ txid: `wl:${id}:${k.t}`, x: wx, y: wy, s: C3.wick, floor: r2(zl), tall: r2(z0 - zl), color: up ? UP_W : DOWN_W, label });
    tiles.push({ txid: `b:${id}:${k.t}`, x, y: C3.row, s: C3.body, floor: r2(z0), tall: r2(top - z0), color: up ? UP : DOWN, label });
    if (zh - top > 0.05) tiles.push({ txid: `wh:${id}:${k.t}`, x: wx, y: wy, s: C3.wick, floor: r2(top), tall: r2(zh - top), color: up ? UP_W : DOWN_W, label });
  });
  const last = cs.at(-1);
  const z = niceTicks(lo, hi, 6).filter((v) => v >= lo && v <= hi).map((v) => ({ z: r2(Z(v)), label: money(v, 0) }));
  z.push({ z: r2(Z(last.c)), label: money(last.c), color: last.c >= last.o ? UP : DOWN, strong: true });
  const every = cs.length > 48 ? 12 : 6;
  const x = [];
  cs.forEach((k, i) => {
    const d = new Date(k.t);
    if (d.getUTCHours() % every === 0) x.push({ x: i * C3.slot + C3.slot / 2, label: d.getUTCHours() === 0 ? `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` : `${String(d.getUTCHours()).padStart(2, '0')}:00` });
  });
  // the neon line: each hour's close, at the centre of its candle
  const line = cs.map((k, i) => ({ x: i * C3.slot + C3.slot / 2, z: r2(Z(k.c)) }));
  return { tiles, gridW: cs.length * C3.slot, gridH: C3.depth, lo, hi, zMax, hours: cs.length, axes: { y: C3.row + C3.body / 2, zTop: C3.zBase + zMax, z, x, line } };
}

export function summaryHtml(d, fmt) {
  const s = d.summary ?? {};
  const item = (k, v) => `<span><span class="k">${k}</span><b>${v}</b></span>`;
  return [
    item('median (USD)', s.median == null ? '–' : `$${money(s.median)}`),
    item('spread across exchanges', s.spread == null ? '–' : `$${money(s.spread)}`),
    item('24 h volume', s.vol24 == null ? '–' : `${fmt.num(Math.round(s.vol24))} BTC`),
    item('reporting', `${s.reporting ?? 0} of ${(d.exchanges ?? []).filter((e) => e.quote === 'USD').length} USD books`),
  ].join('');
}

export function tableHtml(d, fmt, now = Date.now()) {
  const rows = (d.exchanges ?? []).map((e) => {
    const ch = e.change24;
    const spreadBps = e.spread != null && e.last ? (e.spread / e.last) * 1e4 : null;
    return `<tr>
      <td class="w"><b>${fmt.esc(e.name)}</b></td>
      <td class="faint opt">${fmt.esc(e.pair)}</td>
      <td class="r">${money(e.last)}</td>
      <td class="r">${money(e.bid)}</td>
      <td class="r">${money(e.ask)}</td>
      <td class="r">${e.spread == null ? '–' : `${money(e.spread)} <span class="faint">${spreadBps < 0.1 ? '<0.1' : spreadBps.toFixed(1)} bp</span>`}</td>
      <td class="r ${ch > 0 ? 'xpos' : ch < 0 ? 'xneg' : ''}">${ch == null ? '–' : `${ch > 0 ? '+' : ''}${(ch * 100).toFixed(2)}%`}</td>
      <td class="r opt">${money(e.low24, 0)} – ${money(e.high24, 0)}</td>
      <td class="r opt">${e.vol24 == null ? '–' : `${fmt.num(Math.round(e.vol24))} <span class="faint">BTC</span>`}</td>
      <td class="r ${e.stale ? 'stale' : 'faint'}">${e.error ? `<span class="warn" title="${fmt.esc(e.error)}">${fmt.esc(e.error.slice(0, 40))}</span>` : e.at ? fmt.ago(e.at, now) : '–'}</td>
    </tr>`;
  }).join('');
  return `<div class="scroll"><table class="t mktbl"><thead><tr><th>exchange</th><th class="opt">pair</th><th class="r">last</th><th class="r">bid</th><th class="r">ask</th><th class="r">spread</th><th class="r">24 h</th><th class="r opt">24 h low – high</th><th class="r opt">24 h volume</th><th class="r">updated</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// (legend3dHtml lived here: a 250px column of prose beside the board explaining that a green body
// closed up and a red one closed down. Removed with the legend it filled -- operator: "get rid of
// this. takes up too much space on the markets page" -- rather than left as an exported function
// with no caller.)

export function toolbarHtml(d) {
  prefs();
  const exs = (d?.exchanges ?? []).filter((e) => e.candles?.length);
  const b = (attr, v, label, on) => `<button type="button" class="mkbtn${on ? ' on' : ''}" ${attr}="${v}">${label}</button>`;
  return `<div class="mkgrp">${exs.map((e) => b('data-mkex', e.id, `<i class="mkdot" data-ex="${e.id}"></i>${e.name}`, e.id === M.ex)).join('')}</div>
    <div class="mkgrp">${RANGES.map(([n, l]) => b('data-mkrange', n, l, n === M.range)).join('')}</div>
    <div class="mkgrp">${PRICE_VIEWS.map((v) => b('data-mkview', v.id, v.label, v.id === M.view)).join('')}</div>`;
}

// The selected exchange's candles (the live hour closing at its ticker), the rest as lines.
export function chartSeries(d, ex, range, now = Date.now()) {
  const withC = (d?.exchanges ?? []).filter((e) => e.candles?.length);
  const base = withC.find((e) => e.id === ex) ?? withC[0];
  if (!base) return null;
  const candles = base.candles.slice(-range).map((k) => ({ ...k }));
  const live = candles.at(-1);
  if (live && base.last != null && now - live.t < 3600e3) {
    live.c = base.last;
    live.h = Math.max(live.h ?? base.last, base.last);
    live.l = Math.min(live.l ?? base.last, base.last);
  }
  const t0 = candles[0]?.t ?? 0;
  const overlays = withC.filter((e) => e !== base).map((e) => ({ name: e.name, color: EX_COLORS[e.id] ?? '#8aa0b4', candles: e.candles.filter((k) => k.t >= t0) }));
  return { base, candles, overlays };
}

function drawChart() {
  const canvas = document.getElementById('mkChart');
  const { ex, range } = prefs();
  const ser = chartSeries(M.data, ex, range);
  if (!canvas || !ser) return;
  drawPriceChart(canvas, { candles: ser.candles, overlays: ser.overlays, name: `${ser.base.name} ${ser.base.pair}`, hover: M.hover });
}

function drawBoard(id = 'mkBoard') {
  const canvas = document.getElementById(id);
  const { ex, range } = prefs();
  const ser = chartSeries(M.data, ex, range);
  if (!canvas || !ser) return null;
  const hours = Math.min(MAX_3D_HOURS, ser.candles.length);
  const aspect = (canvas.clientHeight || 400) / Math.max(1, canvas.clientWidth || 1000);
  const fitKey = `${ser.base?.id ?? 'x'}|${M.range}|${hours}`;
  const c3 = chart3d(ser, { zMax: fitZ(aspect, hours * C3.slot), fit: M.fitKey === fitKey ? M.fit3d : null });
  M.fitKey = fitKey; M.fit3d = c3.lo != null ? { lo: c3.lo, hi: c3.hi } : null;   // the fit the board was drawn to, kept for the next refresh
  const cam = { ...CAMERA_3D, oblique: { ...CAMERA_3D.oblique, headroom: C3.zBase + c3.zMax + 2 } };
  if (c3.tiles.length) board3d(canvas, c3.tiles, { ...cam, gridW: c3.gridW, gridH: c3.gridH, axes: c3.axes, ...marketsOptions(loadSettings()) });
  return { c3, ser };
}

/**
 * Draw the chosen price view, and NOT the other one.
 *
 * The saving is the WORK, not the pixels. Hiding a canvas in CSS would still pay for a full
 * board3d pass or a candlestick render on every 15 s refresh, for something nobody can see. So the
 * container is hidden AND its draw is skipped. Both elements stay in the document: the toolbar
 * switches between them live, and markets.test.js addresses them by id.
 */
function drawPrice() {
  const { view } = prefs();
  const three = view !== '2d';
  document.getElementById('mkLayout')?.classList?.toggle('hidden', !three);
  document.getElementById('mkChart')?.classList?.toggle('hidden', three);
  if (!three) { drawChart(); return null; }
  return drawBoard();
}

function bindChart() {
  if (M.bound) return;
  const bar = document.getElementById('mkBar'), canvas = document.getElementById('mkChart');
  if (!bar || !canvas) return;
  M.bound = true;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.mkex) setSetting(loadSettings(), 'markets.exchange', (M.ex = btn.dataset.mkex));
    if (btn.dataset.mkrange) setSetting(loadSettings(), 'markets.range', String((M.range = Number(btn.dataset.mkrange))));
    if (btn.dataset.mkview) setSetting(loadSettings(), 'markets.priceView', (M.view = btn.dataset.mkview));
    const html = toolbarHtml(M.data);
    bar.innerHTML = html; bar.__html = html;
    drawPrice();
  });
  canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); M.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; drawChart(); });
  canvas.addEventListener('pointerleave', () => { M.hover = null; drawChart(); });
}

function fetchMarkets(h, now) {
  const wait = M.data?.warming || !M.data ? 3000 : REFRESH_MS;
  if (M.busy || now - M.at < wait) return;
  M.busy = true;
  M.at = now;
  h.api('/api/markets')
    .then((d) => { M.data = d; M.error = null; })
    .catch((err) => { M.error = err.message; })
    .finally(() => { M.busy = false; h.render(); });
}

// THE PRICE INFORMATION PANEL (operator, 2026-09-11, of the Kiosk's markets board: "Way too much
// empty space on top of the markets view. Perhaps shrink up markets view, and add a Price
// Information Panel?"). The USD median in the price line's neon yellow with its 24 h change; the
// 24 h high, low and volume and the spread across books; every exchange's last, change and
// spread; how fresh it is. Pure: the /api/markets reply in, markup out.
export function priceInfoHtml(d, fmt, now = Date.now()) {
  if (d?.enabled === false) return `<div class="kp-wait">${fmt.esc(d.note ?? 'market data is off on this monitor')}</div>`;
  if (!d?.exchanges) return '<div class="kp-wait">asking the exchanges…</div>';
  const usd = d.exchanges.filter((e) => e.quote === 'USD' && e.last != null && !e.stale);
  const med = d.summary?.median ?? null;
  const chs = usd.map((e) => e.change24).filter((v) => v != null).sort((a, b) => a - b);
  const ch = chs.length ? chs[Math.floor((chs.length - 1) / 2)] : null;
  const pct = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
  const cls = (v) => (v > 0 ? 'xpos' : v < 0 ? 'xneg' : '');
  const newest = d.exchanges.reduce((m, e) => Math.max(m, e.at ?? 0), 0);
  // THE KIOSK KEEPS THE PRICE AND LOSES THE 24 h BOOK DETAIL (operator, 2026-09-12: "swap out 24
  // hour order book spread and details, keep the price, but change to market order depth chart that
  // fits within the view"). The high/low/volume/spread block and the per-exchange table are gone:
  // the depth chart that replaces them says far more about the book than a single spread figure,
  // and a four-column table is unreadable from across the room a kiosk is meant to be seen from.
  // The median, its day's change and the provenance line stay -- that is "keep the price".
  return `<div class="kp-main"><span class="kp-pair">BTC / USD</span><b class="kp-price">${med == null ? '–' : `$${money(med)}`}</b><span class="kp-chg ${cls(ch)}">${pct(ch)} <small>24 h</small></span></div>
    <div class="kp-foot">median of ${usd.length} USD book${usd.length === 1 ? '' : 's'}${newest ? ` · updated ${fmt.ago(newest, now)}` : ''} · OKX quotes USDT</div>`;
}

export function renderPriceInfo(id, h) {
  const el = document.getElementById(id);
  if (!el) return;
  const html = priceInfoHtml(M.data, h.fmt);
  if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
}

// The 3D board alone, on any canvas -- the Kiosk tab's markets panel (kiosk.js)
export function renderMarketsBoard(id, h) {
  fetchMarkets(h, Date.now());
  if (M.data?.enabled === false) {
    // the Kiosk's board says so on its own canvas, since there is nothing else on that panel
    const cv = document.getElementById(id), ctx = cv?.getContext?.('2d');
    if (ctx) {
      const w = cv.clientWidth || 600, hh = cv.clientHeight || 300;
      if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
      ctx.clearRect(0, 0, w, hh);
      ctx.fillStyle = INK.text; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(M.data.polling === false ? 'market polling is off' : 'market data is off on this server', w / 2, hh / 2 - 10);
      if (M.data.polling === false) ctx.fillText('Display settings → Markets & Price → Enable market polling', w / 2, hh / 2 + 12);
    }
    return { label: M.data.polling === false ? 'market polling is off · Display settings → Markets & Price' : 'market data is off on this server' };
  }
  const b = drawBoard(id);
  if (!b) return null;
  const last = b.ser.candles.at(-1)?.c;
  return { label: `${b.ser.base.name} ${b.ser.base.pair} · last ${b.c3.hours} h${last != null ? ` · $${money(last)}` : ''}` };
}

export function renderMarkets(s, state, h) {
  const now = Date.now();
  fetchMarkets(h, now);
  const put = (id, html) => { const el = document.getElementById(id); if (el && el.__html !== html) { el.innerHTML = html; el.__html = html; } };
  const d = M.data;
  if (!d) { put('mkTable', `<div class="note">${M.error ? h.fmt.esc(M.error) : 'asking the exchanges…'}</div>`); return; }
  // OFF: the note at the TOP, where the figures go, with a button to the switch -- and the board,
  // the chart and the depth panel folded away (the CSS class), because six hundred pixels of empty
  // board above a note nobody scrolls to is no way to say "polling is off" (2026-09-15)
  const card = document.querySelector('section.page[data-page="markets"] .mkcard');
  if (d.enabled === false) {
    card?.classList.add('mk-off');
    put('mkBar', '');
    put('mkTable', '');
    put('mkSummary', `<div class="caveat mkoff">${h.fmt.esc(d.note ?? 'market data is off')}${d.polling === false ? ' <button type="button" class="btn small" id="mkOpenSettings">Open Display settings</button>' : ''}</div>`);
    document.getElementById('mkOpenSettings')?.addEventListener('click', () => document.getElementById('btnSettings')?.click(), { once: true });
    return;
  }
  card?.classList.remove('mk-off');
  put('mkSummary', summaryHtml(d, h.fmt));
  put('mkBar', toolbarHtml(d));
  bindChart();
  put('mkTable', tableHtml(d, h.fmt, now));
  renderDepth(h);
  // one view, chosen in the toolbar; the other is neither shown nor drawn
  drawPrice();
  // THE BOARD'S RANGE, SAID OUT LOUD when it is shorter than the one chosen. The 3D view caps at
  // MAX_3D_HOURS (see the note on that constant), so at 7 d it draws the most recent three. That
  // was true before and went unmentioned, which is the one part of it the operator was right to
  // object to: a button that says seven days while the picture shows three is a truncation the
  // reader cannot see. Only shown when it actually applies, and only for the view it applies to.
  const capped = prefs().view !== '2d' && M.range > MAX_3D_HOURS;
  const capNote = capped
    ? ` The 3D board draws the most recent ${MAX_3D_HOURS} hours of the ${M.range} you picked — the price band is solved from the panel's shape, and a wider board stops describing the prices. The flat chart draws the whole range.`
    : '';
  put('mkNote', `Public REST APIs of ${d.exchanges.map((e) => h.fmt.esc(e.name)).join(', ')}, fetched by this server every ${Math.round((d.tickerMs ?? REFRESH_MS) / 1000)} s while this tab is open and never otherwise. OKX quotes USDT, so it is left out of the USD median and spread.${capNote}${d.warming ? ' Warming up…' : ''}`);
}
