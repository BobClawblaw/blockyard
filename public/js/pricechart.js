// THE PRICE CHART (operator, 2026-09-11, on the first Markets tab -- rows of towers on the 3D
// board with no axis at all: "What the fuck is this? Where is the price chart info?!??").
// A price chart has to be READ: a price axis, a time axis, candles, volume, the last price, and a
// crosshair that says exactly what an hour did. This is that chart. The 3D board under it is a
// view of the same hours, not a substitute for it.
import { niceTicks } from './charts.js';

export const EX_COLORS = { coinbase: '#4c8dff', kraken: '#a78bfa', bitstamp: '#2ecc8f', bitfinex: '#4dd0e1', okx: '#f0b429' };
const UP = '#26c281', DOWN = '#ef5350';
const UP_V = 'rgba(38,194,129,0.42)', DOWN_V = 'rgba(239,83,80,0.42)';
const PAD = { top: 28, right: 78, bottom: 22, left: 10 };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const H1 = 3600e3;

const money = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const stamp = (t) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

// Pure: where everything goes. candles oldest first; overlays [{ candles }] only widen the scale.
export function layoutChart(candles, overlays, w, h) {
  const n = candles.length;
  const plotW = Math.max(10, w - PAD.left - PAD.right);
  const plotH = Math.max(40, h - PAD.top - PAD.bottom);
  const volH = Math.round(plotH * 0.2);
  const priceH = plotH - volH - 8;
  const t0 = candles[0]?.t ?? 0, t1 = candles.at(-1)?.t ?? 0;
  let lo = Infinity, hi = -Infinity;
  for (const k of candles) { lo = Math.min(lo, k.l ?? k.c); hi = Math.max(hi, k.h ?? k.c); }
  for (const o of overlays ?? []) for (const k of o.candles) if (k.t >= t0 && k.t <= t1) { lo = Math.min(lo, k.c); hi = Math.max(hi, k.c); }
  const padV = (hi - lo) * 0.06 || Math.abs(hi) * 0.001 || 1;
  lo -= padV; hi += padV;
  const vmax = Math.max(1e-9, ...candles.map((k) => k.v ?? 0));
  const slot = plotW / Math.max(1, n);
  const step = n > 1 ? (t1 - t0) / (n - 1) : H1;
  const X = (i) => PAD.left + slot * (i + 0.5);
  const XT = (t) => X((t - t0) / step);
  const Y = (v) => PAD.top + priceH - ((v - lo) / (hi - lo)) * priceH;
  const V = (y) => lo + (1 - (y - PAD.top) / priceH) * (hi - lo);
  const VY0 = PAD.top + priceH + 8 + volH;
  const VH = (v) => ((v ?? 0) / vmax) * volH;
  const index = (x) => clamp(Math.round((x - PAD.left) / slot - 0.5), 0, Math.max(0, n - 1));
  return { n, plotW, plotH, priceH, volH, lo, hi, slot, t0, t1, step, X, XT, Y, V, VY0, VH, index, w, h };
}

// Whole UTC hours, as far apart as the width can label (~80 px); midnight carries the date.
export function timeTicks(t0, t1, plotW) {
  const span = Math.max(H1, t1 - t0);
  const step = [1, 2, 3, 6, 12, 24, 48, 96].map((x) => x * H1).find((s) => plotW / (span / s) >= 80) ?? 96 * H1;
  const out = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const d = new Date(t);
    out.push({ t, label: d.getUTCHours() === 0 ? `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` : `${String(d.getUTCHours()).padStart(2, '0')}:00` });
  }
  return out;
}

export function readout(k, name) {
  const ch = k.o ? (k.c - k.o) / k.o : null;
  return `${name} · ${stamp(k.t)} UTC   O ${money(k.o)}  H ${money(k.h)}  L ${money(k.l)}  C ${money(k.c)}  ${ch == null ? '' : `${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(2)}%`}  vol ${k.v == null ? '–' : money(k.v, 0)} BTC`;
}

export function prep(canvas) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 420;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  return { ctx, w, h };
}

export function drawPriceChart(canvas, { candles = [], overlays = [], name = '', hover = null } = {}) {
  if (!canvas?.getContext) return null;
  const { ctx, w, h } = prep(canvas);
  if (!candles.length) {
    ctx.fillStyle = '#6a7484'; ctx.textAlign = 'center';
    ctx.fillText('no candles yet', w / 2, h / 2);
    return null;
  }
  const L = layoutChart(candles, overlays, w, h);
  const right = w - PAD.right;

  // price grid and axis (right, as on a trading screen)
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
  for (const v of niceTicks(L.lo, L.hi, Math.max(3, Math.floor(L.priceH / 46)))) {
    const y = Math.round(L.Y(v)) + 0.5;
    if (y < PAD.top || y > PAD.top + L.priceH) continue;
    ctx.strokeStyle = '#1a2029';
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = '#7d8898';
    ctx.fillText(money(v, 0), right + 7, y);
  }
  // time grid and axis
  ctx.textAlign = 'center';
  for (const tk of timeTicks(L.t0, L.t1, L.plotW)) {
    const x = Math.round(L.XT(tk.t)) + 0.5;
    ctx.strokeStyle = tk.label.includes(' ') ? '#27303b' : '#161b22';
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, L.VY0); ctx.stroke();
    ctx.fillStyle = tk.label.includes(' ') ? '#b5c0cc' : '#7d8898';
    ctx.fillText(tk.label, x, h - PAD.bottom / 2);
  }
  // the pane edges
  ctx.strokeStyle = '#2a323d';
  ctx.beginPath(); ctx.moveTo(right + 0.5, PAD.top); ctx.lineTo(right + 0.5, L.VY0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(PAD.left, L.VY0 + 0.5); ctx.lineTo(right, L.VY0 + 0.5); ctx.stroke();

  const bodyW = Math.max(1, Math.min(16, L.slot * 0.66));
  // volume
  candles.forEach((k, i) => {
    const vh = L.VH(k.v);
    if (vh < 0.5) return;
    ctx.fillStyle = k.c >= k.o ? UP_V : DOWN_V;
    ctx.fillRect(L.X(i) - bodyW / 2, L.VY0 - vh, bodyW, vh);
  });
  ctx.fillStyle = '#56606e'; ctx.textAlign = 'left';
  ctx.fillText('volume', PAD.left + 4, L.VY0 - L.volH + 6);

  // the other exchanges, as thin close lines
  for (const o of overlays) {
    const pts = o.candles.filter((k) => k.t >= L.t0 && k.t <= L.t1);
    if (pts.length < 2) continue;
    ctx.strokeStyle = o.color; ctx.lineWidth = 1.1;
    ctx.beginPath();
    pts.forEach((k, j) => { const x = L.XT(k.t), y = L.Y(k.c); if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  // candles: the wick is the hour's range, the body open to close
  candles.forEach((k, i) => {
    const x = Math.round(L.X(i)) + 0.5;
    const col = k.c >= k.o ? UP : DOWN;
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(x, L.Y(k.h ?? Math.max(k.o, k.c))); ctx.lineTo(x, L.Y(k.l ?? Math.min(k.o, k.c))); ctx.stroke();
    const y1 = L.Y(Math.max(k.o, k.c)), y2 = L.Y(Math.min(k.o, k.c));
    ctx.fillStyle = col;
    ctx.fillRect(x - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1));
  });

  // the last price: a dashed line and its label on the axis
  const lastK = candles.at(-1);
  const ly = Math.round(L.Y(lastK.c)) + 0.5;
  const lcol = lastK.c >= lastK.o ? UP : DOWN;
  ctx.strokeStyle = lcol; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(PAD.left, ly); ctx.lineTo(right, ly); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = lcol; ctx.fillRect(right + 1, ly - 9, PAD.right - 2, 18);
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left';
  ctx.fillText(money(lastK.c), right + 6, ly);

  // the crosshair
  let shown = lastK;
  if (hover && hover.x >= PAD.left && hover.x <= right) {
    const i = L.index(hover.x);
    shown = candles[i];
    const x = Math.round(L.X(i)) + 0.5;
    ctx.strokeStyle = 'rgba(200,215,230,0.45)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, L.VY0); ctx.stroke();
    if (hover.y >= PAD.top && hover.y <= PAD.top + L.priceH) {
      const y = Math.round(hover.y) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#3a4452'; ctx.fillRect(right + 1, y - 9, PAD.right - 2, 18);
      ctx.fillStyle = '#ffffff'; ctx.fillText(money(L.V(hover.y)), right + 6, y);
    }
    ctx.setLineDash([]);
  }
  // readout (top-left) and overlay legend (top-right)
  ctx.textAlign = 'left';
  ctx.fillStyle = '#dfe6ee';
  ctx.fillText(readout(shown, name), PAD.left + 2, 12);
  ctx.textAlign = 'right';
  let lx = right;
  for (const o of [...overlays].reverse()) {
    const wT = ctx.measureText(o.name).width;
    ctx.fillStyle = '#9aa5b3'; ctx.fillText(o.name, lx, 12);
    ctx.fillStyle = o.color; ctx.fillRect(lx - wT - 16, 11, 11, 2);
    lx -= wT + 26;
  }
  return L;
}
