// THE DEPTH CHART (operator, 2026-09-11, with a picture of bitcoinity's: "we are totally missing
// this view in the market info").
//
// x is price. The left axis is cumulative BTC: bids (green) summed downward from the best bid,
// asks (red) summed upward from the best ask -- every exchange's book a faint line, all of them
// together the bright line, and that total as it stood N minutes ago the dashed line. The right
// axis is a symmetric log scale, as on bitcoinity, for the change bars: how much was added (+) or
// pulled (-) AT each price since then. The books come from server/collect/markets.js, read every
// 30 s while the tab is open, as cumulative depth on fixed $50 levels. A shallow book (Kraken
// gives 500 levels, OKX 5000 -- a percent or two either side) is not extended: its line ends,
// the end is marked, and the total past it counts only the books that reach.
import { niceTicks } from './charts.js';
import { prep } from './pricechart.js';

export const AGOS = [[60, '1m'], [300, '5m'], [600, '10m'], [1800, '30m'], [3600, '1h']];
export const ZOOMS = [[0.01, '±1%'], [0.025, '±2.5%'], [0.05, '±5%'], [0.1, '±10%']];
export const DEPTH_MS = 30_000;
const D = { data: null, at: 0, busy: false, key: null, ago: 600, zoom: 0.05, hover: null, bound: false, error: null };
const BID = '#3dff7a', ASK = '#ff4545';
const BID_T = 'rgba(61,255,122,0.32)', ASK_T = 'rgba(255,69,69,0.32)';
const BID_THEN = 'rgba(61,255,122,0.55)', ASK_THEN = 'rgba(255,69,69,0.55)';
const PAD_FULL = { top: 28, right: 62, bottom: 22, left: 56 };
// COMPACT, for the kiosk. The full chart spends 62 px on the right purely to label the change
// bars' axis and 56 on the left for the cumulative-BTC labels plus a rotated caption -- on a wall
// panel a couple of hundred pixels tall that is most of the picture. Compact keeps the curves and
// the price axis, which are what carry the meaning across a room, and drops the annotation.
const PAD_COMPACT = { top: 15, right: 10, bottom: 17, left: 42 };

const money = (v, dp = 0) => (v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const btc = (v) => (v == null ? '–' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(Math.abs(v) >= 10 ? 1 : 2));
const kUsd = (v) => `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k`;
const shortN = (v) => (v >= 1000 ? `${v / 1000}k` : String(v));
const clock = (t) => new Date(t).toISOString().slice(11, 19);

// Pure: the /api/markets/depth reply in, the curves the chart draws out.
export function depthSeries(d) {
  if (!d?.ok || !d.n || !(d.exchanges ?? []).some((e) => e.bids)) return null;
  const n = d.n;
  const prices = Array.from({ length: n }, (_, i) => d.p0 + i * d.step);
  // A BOOK THAT ENDS STILL COUNTS (2026-09-11: with Kraken's 500 levels ending at -2%, the total
  // DROPPED there, and "within 5%" printed smaller than "within 1%"). Cumulative depth past the
  // last level a book gave is at least what it had reached, so that value is carried on outward
  // as a lower bound -- not an extrapolation -- and those levels are flagged partial: the chart
  // draws the total there as "at least", and the readout says so.
  const carry = (arr, side) => {
    if (!arr) return null;
    const o = arr.slice();
    if (side === 'bid') { const lo = o.findIndex((v) => v != null); if (lo > 0) for (let i = lo - 1; i >= 0; i--) o[i] = o[lo]; }
    else { let hi = -1; for (let i = n - 1; i >= 0; i--) if (o[i] != null) { hi = i; break; } if (hi >= 0) for (let i = hi + 1; i < n; i++) o[i] = o[hi]; }
    return o;
  };
  const sum = (key, side) => {
    const tot = new Array(n).fill(null), part = new Array(n).fill(false);
    for (const e of d.exchanges) {
      const raw = e[key];
      const full = carry(raw, side);
      if (!full) continue;
      for (let i = 0; i < n; i++) {
        if (full[i] == null) continue;
        tot[i] = (tot[i] ?? 0) + full[i];
        if (raw[i] == null) part[i] = true;
      }
    }
    return { tot, part };
  };
  const B = sum('bids', 'bid'), A = sum('asks', 'ask'), TB = sum('thenBids', 'bid'), TA = sum('thenAsks', 'ask');
  const bid = B.tot, ask = A.tot, thenBid = TB.tot, thenAsk = TA.tot;
  const bidPart = B.part, askPart = A.part;
  const hasThen = d.exchanges.some((e) => e.thenBids);
  // the amount AT a level (not cumulative): bids accumulate downward, asks upward
  const amt = (cum, i, side) => (cum[i] == null ? null : cum[i] - ((side === 'bid' ? cum[i + 1] : cum[i - 1]) ?? 0));
  const change = hasThen ? prices.map((_, i) => {
    const nb = amt(bid, i, 'bid'), tb = amt(thenBid, i, 'bid'), na = amt(ask, i, 'ask'), ta = amt(thenAsk, i, 'ask');
    const v = (nb != null && tb != null && !bidPart[i] ? nb - tb : 0) + (na != null && ta != null && !askPart[i] ? na - ta : 0);
    return Math.abs(v) < 1e-6 ? 0 : v;
  }) : null;
  const reach = d.exchanges.filter((e) => e.bids).map((e) => {
    const lo = e.bids.findIndex((v) => v != null);
    let hi = -1;
    for (let i = n - 1; i >= 0; i--) if (e.asks?.[i] != null) { hi = i; break; }
    return { id: e.id, name: e.name, low: lo > 0 ? prices[lo] : null, high: hi >= 0 && hi < n - 1 ? prices[hi] : null };
  });
  return { prices, step: d.step, bid, ask, bidPart, askPart, thenBid, thenAsk, change, mid: d.mid, exchanges: d.exchanges.filter((e) => e.bids), reach };
}

// Cumulative BTC bid within pct below the mid, and asked within pct above it.
export function depthSums(ser, pct) {
  const idx = (p) => Math.round((p - ser.prices[0]) / ser.step);
  const ib = idx(ser.mid * (1 - pct)), ia = idx(ser.mid * (1 + pct));
  return { bids: ser.bid[ib] ?? null, asks: ser.ask[ia] ?? null, atLeast: Boolean(ser.bidPart?.[ib] || ser.askPart?.[ia]) };
}

export function drawDepth(canvas, ser, { zoom = 0.05, hover = null, compact = false } = {}) {
  if (!canvas?.getContext) return null;
  const PAD = compact ? PAD_COMPACT : PAD_FULL;
  const { ctx, w, h } = prep(canvas);
  if (!ser) {
    ctx.fillStyle = '#6a7484'; ctx.textAlign = 'center';
    ctx.fillText('asking the exchanges for their order books…', w / 2, h / 2);
    return null;
  }
  const plotW = Math.max(10, w - PAD.left - PAD.right), plotH = Math.max(40, h - PAD.top - PAD.bottom);
  const pmin = ser.mid * (1 - zoom), pmax = ser.mid * (1 + zoom);
  const X = (p) => PAD.left + ((p - pmin) / (pmax - pmin)) * plotW;
  const inWin = (i) => ser.prices[i] >= pmin && ser.prices[i] <= pmax;
  const line = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
  let vmax = 1;
  ser.prices.forEach((_, i) => { if (inWin(i)) for (const a of [ser.bid, ser.ask, ser.thenBid, ser.thenAsk]) if (a[i] != null && a[i] > vmax) vmax = a[i]; });
  vmax *= 1.06;
  const Y = (v) => PAD.top + plotH - (v / vmax) * plotH;
  let cmax = 1;
  if (ser.change) ser.change.forEach((v, i) => { if (inWin(i) && Math.abs(v) > cmax) cmax = Math.abs(v); });
  const F = Math.max(1, Math.ceil(Math.log10(1 + cmax)));
  const sl = (v) => Math.sign(v) * Math.log10(1 + Math.abs(v));
  const YC = (v) => PAD.top + plotH / 2 - (sl(v) / F) * (plotH / 2);

  // left axis: cumulative BTC
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (const v of niceTicks(0, vmax, Math.max(3, Math.floor(plotH / 44)))) {
    const y = Math.round(Y(v)) + 0.5;
    if (y < PAD.top) continue;
    ctx.strokeStyle = '#1a2029'; line(PAD.left, y, w - PAD.right, y);
    ctx.fillStyle = '#7d8898'; ctx.fillText(btc(v), PAD.left - 6, y);
  }
  if (!compact) {
    ctx.save?.();
    ctx.translate(12, PAD.top + plotH / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillStyle = '#56606e'; ctx.fillText('BTC, cumulative', 0, 0);
    ctx.restore?.();
  }
  ctx.setTransform(Math.min(globalThis.devicePixelRatio || 1, 2), 0, 0, Math.min(globalThis.devicePixelRatio || 1, 2), 0, 0);
  // right axis: the change bars' symmetric log scale
  if (ser.change) {
    ctx.textAlign = 'left';
    for (let e = -F; e <= F; e++) {
      const v = e === 0 ? 0 : Math.sign(e) * 10 ** Math.abs(e);
      const y = Math.round(YC(v)) + 0.5;
      if (!compact) {
        ctx.fillStyle = '#7d8898';
        ctx.fillText(v === 0 ? '0' : `${v > 0 ? '' : '-'}${shortN(Math.abs(v))}`, w - PAD.right + 6, y);
      }
      if (v === 0) { ctx.strokeStyle = '#2a323d'; line(PAD.left, y, w - PAD.right, y); }
    }
  }
  // price axis
  ctx.textAlign = 'center';
  for (const p of niceTicks(pmin, pmax, Math.max(3, Math.floor(plotW / 90)))) {
    const x = Math.round(X(p)) + 0.5;
    if (x < PAD.left || x > w - PAD.right) continue;
    ctx.strokeStyle = '#161b22'; line(x, PAD.top, x, PAD.top + plotH);
    ctx.fillStyle = '#7d8898'; ctx.fillText(zoom <= 0.01 ? money(p) : kUsd(p), x, h - PAD.bottom / 2);
  }
  ctx.strokeStyle = '#2a323d';
  line(PAD.left + 0.5, PAD.top, PAD.left + 0.5, PAD.top + plotH);
  line(w - PAD.right + 0.5, PAD.top, w - PAD.right + 0.5, PAD.top + plotH);
  line(PAD.left, PAD.top + plotH + 0.5, w - PAD.right, PAD.top + plotH + 0.5);

  // change bars
  if (ser.change) {
    const bw = Math.max(1, (plotW / ((pmax - pmin) / ser.step)) * 0.8);
    ser.change.forEach((v, i) => {
      if (!v || !inWin(i)) return;
      const x = X(ser.prices[i]), y0 = YC(0), y1 = YC(v);
      ctx.fillStyle = v > 0 ? 'rgba(110,180,255,0.6)' : 'rgba(255,170,70,0.6)';
      ctx.fillRect(x - bw / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0)));
    });
  }
  // the curves: each book faint, the total then (dashed), the total now (bright)
  const curve = (arr, col, lw, dash = []) => {
    if (!arr) return;
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.setLineDash(dash);
    ctx.beginPath();
    let on = false;
    ser.prices.forEach((p, i) => {
      const v = arr[i];
      if (v == null || !inWin(i)) { on = false; return; }
      if (on) ctx.lineTo(X(p), Y(v)); else { ctx.moveTo(X(p), Y(v)); on = true; }
    });
    ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 1;
  };
  for (const e of ser.exchanges) { curve(e.bids, BID_T, 1); curve(e.asks, ASK_T, 1); }
  if (ser.change) { curve(ser.thenBid, BID_THEN, 1.4, [5, 4]); curve(ser.thenAsk, ASK_THEN, 1.4, [5, 4]); }
  const only = (arr, part, want) => arr.map((v, i) => (v != null && (part[i] === want || (i > 0 && part[i - 1] === want) || (i < arr.length - 1 && part[i + 1] === want)) ? v : null));
  curve(only(ser.bid, ser.bidPart, true), 'rgba(61,255,122,0.5)', 2.2, [2, 3]);
  curve(only(ser.ask, ser.askPart, true), 'rgba(255,69,69,0.5)', 2.2, [2, 3]);
  curve(only(ser.bid, ser.bidPart, false), BID, 2.2);
  curve(only(ser.ask, ser.askPart, false), ASK, 2.2);
  // the mid, and where each shallow book ends
  ctx.strokeStyle = 'rgba(220,230,240,0.35)';
  const xm = Math.round(X(ser.mid)) + 0.5;
  line(xm, PAD.top, xm, PAD.top + plotH);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  let lane = 0;
  for (const r of ser.reach) {
    for (const p of [r.low, r.high]) {
      if (p == null || p < pmin || p > pmax) continue;
      const x = Math.round(X(p)) + 0.5;
      ctx.strokeStyle = 'rgba(200,210,225,0.5)'; line(x, PAD.top + plotH - 8, x, PAD.top + plotH);
      if (!compact) {
        ctx.fillStyle = '#8994a3'; ctx.textAlign = 'center';
        ctx.fillText(`${r.name} ends`, x, PAD.top + plotH - 14 - 11 * (lane++ % 3));
      }
    }
  }
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

  // readout: the pointer's price, or the sums near the mid
  ctx.textAlign = 'left'; ctx.fillStyle = '#dfe6ee';
  if (hover && hover.x >= PAD.left && hover.x <= w - PAD.right) {
    const p = pmin + ((hover.x - PAD.left) / plotW) * (pmax - pmin);
    const i = Math.max(0, Math.min(ser.prices.length - 1, Math.round((p - ser.prices[0]) / ser.step)));
    const bidSide = ser.prices[i] <= ser.mid;
    const cum = bidSide ? ser.bid[i] : ser.ask[i];
    const per = ser.exchanges.map((e) => [e.name, bidSide ? e.bids[i] : e.asks?.[i]]).filter(([, v]) => v != null).map(([nm, v]) => `${nm} ${btc(v)}`).join(' · ');
    ctx.strokeStyle = 'rgba(200,215,230,0.5)'; ctx.setLineDash([3, 3]);
    const x = Math.round(X(ser.prices[i])) + 0.5;
    line(x, PAD.top, x, PAD.top + plotH);
    ctx.setLineDash([]);
    const part = bidSide ? ser.bidPart[i] : ser.askPart[i];
    ctx.fillText(`$${money(ser.prices[i])} · ${bidSide ? 'bid at or above' : 'asked at or below'}: ${part ? 'at least ' : ''}${btc(cum)} BTC${ser.change ? ` · change here ${ser.change[i] > 0 ? '+' : ''}${btc(ser.change[i])} BTC` : ''}${per ? `   (${per})` : ''}`, PAD.left + 2, 12);
  } else {
    const s1 = depthSums(ser, 0.01), s5 = depthSums(ser, 0.05);
    const al = (s) => (s.atLeast ? '≥ ' : '');
    ctx.fillText(compact
      ? `mid $${money(ser.mid)} · 1%: ${al(s1)}${btc(s1.bids)} / ${btc(s1.asks)} BTC`
      : `mid $${money(ser.mid)} · within 1%: ${al(s1)}bids ${btc(s1.bids)} / asks ${btc(s1.asks)} BTC · within 5%: ${al(s5)}bids ${btc(s5.bids)} / asks ${btc(s5.asks)} BTC   (dotted: a book has ended, so at least)`,
      PAD.left + 2, compact ? 8 : 12);
  }
  return { pmin, pmax, vmax, F };
}

export function depthBarHtml(ago = D.ago, zoom = D.zoom) {
  const b = (attr, v, label, on) => `<button type="button" class="mkbtn${on ? ' on' : ''}" ${attr}="${v}">${label}</button>`;
  return `<div class="mkgrp"><span class="mklab">change bars for the last</span>${AGOS.map(([s, l]) => b('data-ago', s, l, s === ago)).join('')}</div>
    <div class="mkgrp"><span class="mklab">price window</span>${ZOOMS.map(([z, l]) => b('data-zoom', z, l, z === zoom)).join('')}</div>`;
}

export function depthNote(d, fmt) {
  if (!d) return 'asking the exchanges for their order books…';
  if (d.warming) return 'reading the order books for the first time…';
  const agoL = AGOS.find(([s]) => s === d.ago)?.[1] ?? `${d.ago} s`;
  const parts = [`books read at ${clock(d.at)} UTC, every ${Math.round((d.bookMs ?? DEPTH_MS) / 1000)} s while this tab is open`];
  parts.push(d.thenAt ? `the dashed line and the change bars compare with ${clock(d.thenAt)} UTC (${agoL} before)` : `no snapshot ${agoL} old yet -- the books have been read since ${clock(d.firstAt)} UTC, so the change bars wait`);
  const bad = (d.exchanges ?? []).filter((e) => e.error);
  if (bad.length) parts.push(`not read: ${bad.map((e) => `${fmt.esc(e.name)} (${fmt.esc(e.error)})`).join(', ')}`);
  parts.push('OKX quotes USDT; it is in the total');
  return parts.join(' · ');
}

function draw() {
  const canvas = document.getElementById('mkDepth');
  if (!canvas) return;
  drawDepth(canvas, depthSeries(D.data), { zoom: D.zoom, hover: D.hover });
}

/**
 * ONE FETCH, HOWEVER MANY VIEWS. The Markets tab and the Kiosk both want the books; this is the
 * shared poll, so opening both does not double the traffic to five exchanges. The server's route
 * calls markets.touch(), so a Kiosk polling on its own keeps the collector out of its idle park --
 * a wall display needs no special handling.
 */
function ensureDepth(h) {
  const now = Date.now();
  const key = String(D.ago);
  if (!D.busy && (D.key !== key || now - D.at >= (D.data && !D.data.warming ? DEPTH_MS : 4000))) {
    D.busy = true; D.at = now; D.key = key;
    h.api(`/api/markets/depth?ago=${D.ago}`)
      .then((d) => { if (D.key === key) { D.data = d; D.error = null; } })
      .catch((err) => { D.error = err.message; })
      .finally(() => { D.busy = false; h.render(); });
  }
}

/**
 * The chart into a canvas of the caller's choosing, compact and with no toolbar -- for the Kiosk.
 * It deliberately does NOT touch D.hover or D.zoom: those belong to the Markets tab's chart, and
 * sharing them would make a pointer on one view redraw the other.
 */
export function renderDepthInto(canvasId, h, { zoom = 0.025, compact = true } = {}) {
  ensureDepth(h);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  return drawDepth(canvas, depthSeries(D.data), { zoom, compact });
}

export function renderDepth(h) {
  ensureDepth(h);
  const bar = document.getElementById('mkDepthBar'), canvas = document.getElementById('mkDepth'), note = document.getElementById('mkDepthNote');
  if (!bar || !canvas) return;
  const html = depthBarHtml();
  if (bar.__html !== html) { bar.innerHTML = html; bar.__html = html; }
  if (!D.bound) {
    D.bound = true;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.ago) D.ago = Number(btn.dataset.ago);
      if (btn.dataset.zoom) D.zoom = Number(btn.dataset.zoom);
      h.render();
    });
    canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); D.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; draw(); });
    canvas.addEventListener('pointerleave', () => { D.hover = null; draw(); });
  }
  draw();
  if (note) {
    const t = D.error ? h.fmt.esc(D.error) : depthNote(D.data, h.fmt);
    if (note.__html !== t) { note.innerHTML = t; note.__html = t; }
  }
}
