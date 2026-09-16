// Canvas chart kit. No dependencies, no CDN: the panel has to render identically
// with no network reachable.
//
// THE ONE RULE THAT MATTERS MOST HERE: a chart never erases itself to show a
// status message. Data already on screen is the most valuable thing this page
// has; a transient gap in sampling must not destroy it. Absence is reported with
// an unobtrusive, idempotent "stale" pill drawn ON TOP of the existing pixels,
// and a placeholder is only ever painted onto a canvas that has never held data
// for the node currently selected.
//
// The flip side of "never blank": stale data must be visibly stale. Keeping an
// old chart and calling it current is the same sin as inventing a number, so the
// pill says how old it is.
const M = { top: 8, right: 10, bottom: 18, left: 46 };
// THE COLOURS COME FROM THE THEME (theme.js, 2026-09-16): COL is the theme module's live object,
// refilled when the operator picks a theme, and the chrome colours below read INK the same way --
// a chart painted from literals of the dark look was unreadable on a light card.
import { COL, INK } from './theme.js';
const palette = () => [COL.accent, COL.info, COL.ok, COL.purple, COL.cyan, COL.pink, COL.warn, COL.bad];

function prep(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
  const h = canvas.clientHeight || 130;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  return { ctx, w, h, dpr };
}

// ------------------------------------------------------------------ content

/** True once this canvas has been drawn with real data for the current node. */
export function hasData(canvas) { return !!canvas.__hasData; }

/**
 * Wipe the canvas and its memory of having held data.
 * Only two things may call this: the first data arriving for a node that has
 * never been drawn, and a node switch -- where the old pixels belong to a
 * different daemon and showing them would be a lie.
 */
export function resetCanvas(canvas) {
  canvas.__hasData = false;
  canvas.__chart = null;
  canvas.__since = null;
  try { prep(canvas); } catch { /* not laid out yet */ }
}

/**
 * The absence report. If the canvas holds data, the data stays: a "stale" pill
 * is drawn over it instead. A placeholder only ever lands on an empty canvas.
 *
 * The pill is drawn with OPAQUE colours because this runs every animation frame;
 * a translucent badge would composite on itself and darken the chart into
 * blackness within a minute. Idempotent by construction.
 */
export function empty(canvas, msg = 'no data from the node yet') {
  if (canvas.__hasData) { markStale(canvas, msg); return; }
  const { ctx, w, h } = prep(canvas);
  ctx.fillStyle = INK.textDim;
  ctx.textAlign = 'center';
  ctx.fillText(msg, w / 2, h / 2);
  ctx.textAlign = 'left';
  canvas.__chart = null;
}

/** A small, opaque, repeatable caption over existing pixels. Never clears. */
export function markStale(canvas, msg = 'no fresh samples') {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = canvas.clientWidth || 320;
  const label = String(msg ?? 'no fresh samples');
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const tw = ctx.measureText(label).width;
  const pw = tw + 20;
  const x = Math.max(4, w - pw - 6);
  ctx.fillStyle = INK.panel;
  ctx.strokeStyle = INK.panelLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, 4, pw, 16, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COL.warn;
  ctx.beginPath();
  ctx.arc(x + 9, 12, 3, 0, 7);
  ctx.fill();
  ctx.fillStyle = INK.label;
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 15, 12);
}

/** Elapsed since the series backing a chart last changed, as a short string. */
export function ageLabel(ms) {
  if (!Number.isFinite(ms)) return null;
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s` ;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// At most `count` intervals, on a 1/2/5/10 step. `count` used to be a hint the step then
// rounded DOWN from, so 0..160M came out as nine ticks at 20M -- on a 64 px chart the labels
// stacked into a smear (2026-09-11, the Chain & Sync page made compact). Now the step is the
// smallest nice one that keeps to the count.
export function niceTicks(lo, hi, count = 4) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [lo];
  const span = hi - lo;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1e-9) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out.length ? out : [lo, hi];
}

// ------------------------------------------------------------------ line

/**
 * Multi-series line/area. series: [{label, color, points:[{t,v}], axis:'right', type:'line'|'area'}]
 * opts: {fmtY, fmtX, fmtTip, min, max, rightMax, zeroBase, marker, staleMs}
 */
export function lineChart(canvas, series, opts = {}) {
  const pts = (series ?? []).filter((s) => s.points && s.points.length);
  if (!pts.length) return empty(canvas, opts.emptyMsg);
  const { ctx, w, h } = prep(canvas);
  const L = { ...M, left: opts.left ?? M.left, bottom: opts.bottom ?? M.bottom };
  const plotW = Math.max(10, w - L.left - L.right);
  const plotH = Math.max(10, h - L.top - L.bottom);

  const all = pts.flatMap((s) => s.points.filter((p) => Number.isFinite(p.v)));
  if (!all.length) return empty(canvas, opts.emptyMsg);
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const tSpan = Math.max(1, t1 - t0);

  const leftVals = pts.filter((s) => s.axis !== 'right').flatMap((s) => s.points.map((p) => p.v)).filter(Number.isFinite);
  const rightVals = pts.filter((s) => s.axis === 'right').flatMap((s) => s.points.map((p) => p.v)).filter(Number.isFinite);
  let lo = opts.min != null ? opts.min : Math.min(0, ...leftVals);
  let hi = opts.max != null ? opts.max : Math.max(...leftVals);
  if (hi === lo) hi = lo + 1;
  if (opts.zeroBase !== false && lo > 0 && Math.min(...leftVals) >= 0) lo = 0;
  let rLo = opts.rightMin ?? Math.min(...rightVals, 0);
  let rHi = opts.rightMax ?? Math.max(...rightVals, 1);
  if (rHi === rLo) rHi = rLo + 1;

  const X = (t) => L.left + ((t - t0) / tSpan) * plotW;
  const Y = (v) => L.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const Y2 = (v) => L.top + plotH - ((v - rLo) / (rHi - rLo)) * plotH;

  ctx.strokeStyle = COL.grid;
  ctx.fillStyle = COL.text;
  ctx.lineWidth = 1;
  // as many ticks as the height can label (one per ~22 px, 2..4), and no label repeated:
  // bytes rounded to whole MB printed "2 MB, 2 MB, 1 MB, 1 MB" down the Block size axis
  const yticks = opts.logY ? logTicks(Math.max(lo, 1e-9), hi) : niceTicks(lo, hi, Math.max(2, Math.min(4, Math.floor(plotH / 22))));
  ctx.textAlign = 'right';
  let lastLabel = null;
  for (const tv of yticks) {
    const y = Math.round((opts.logY ? logY(tv, lo, hi, L, plotH) : Y(tv))) + 0.5;
    if (y < L.top - 2 || y > L.top + plotH + 2) continue;
    ctx.beginPath(); ctx.moveTo(L.left, y); ctx.lineTo(w - L.right, y); ctx.stroke();
    const label = (opts.fmtY ?? short)(tv);
    if (label !== lastLabel) ctx.fillText(label, L.left - 5, y);
    lastLabel = label;
  }
  if (rightVals.length) {
    ctx.fillStyle = pts.find((s) => s.axis === 'right')?.color ?? COL.info;
    ctx.textAlign = 'left';
    for (const tv of niceTicks(rLo, rHi, 3)) {
      const y = Math.round(Y2(tv)) + 0.5;
      ctx.fillText((opts.fmtRight ?? short)(tv), w - L.right + 3, y);
    }
    ctx.fillStyle = COL.text;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = COL.text;
  const xt = 4;
  for (let i = 0; i <= xt; i++) {
    const t = t0 + (tSpan * i) / xt;
    const x = Math.min(w - L.right - 12, Math.max(L.left + 10, X(t)));
    ctx.fillText((opts.fmtX ?? clock)(t), x, h - 7);
  }

  for (let si = 0; si < pts.length; si++) {
    const s = pts[si];
    const pal = palette();
    const color = s.color ?? pal[si % pal.length];
    const yOf = s.axis === 'right' ? Y2 : (opts.logY ? (v) => logY(v, lo, hi, L, plotH) : Y);
    const sorted = s.points.slice().sort((a, b) => a.t - b.t);

    if (s.type === 'area' || s.area) {
      const g = ctx.createLinearGradient(0, L.top, 0, L.top + plotH);
      g.addColorStop(0, hexA(color, 0.34));
      g.addColorStop(1, hexA(color, 0.02));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(X(sorted[0].t), L.top + plotH);
      for (const p of sorted) ctx.lineTo(X(p.t), clampN(yOf(p.v), L.top - 40, L.top + plotH + 40));
      ctx.lineTo(X(sorted[sorted.length - 1].t), L.top + plotH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = s.width ?? 1.6;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const p of sorted) {
      const x = X(p.t);
      const y = clampN(yOf(p.v), L.top - 60, L.top + plotH + 60);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const last = sorted[sorted.length - 1];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(X(last.t), clampN(yOf(last.v), L.top, L.top + plotH), 2.2, 0, 7);
    ctx.fill();
  }

  if (opts.marker != null && Number.isFinite(opts.marker.v)) {
    const y = clampN(Y(opts.marker.v), L.top, L.top + plotH);
    ctx.strokeStyle = opts.marker.color ?? COL.warn;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(L.left, y); ctx.lineTo(w - L.right, y); ctx.stroke();
    ctx.setLineDash([]);
    if (opts.marker.label) {
      ctx.fillStyle = opts.marker.color ?? COL.warn;
      ctx.textAlign = 'left';
      ctx.fillText(opts.marker.label, L.left + 4, y - 7);
    }
  }

  if (pts.length > 1 && opts.legend !== false) drawLegend(ctx, pts, L, w);

  canvas.__hasData = true;
  canvas.__since = t1;
  canvas.__chart = { kind: 'line', t0, t1, X, Y, Y2, series: pts, L, plotW, plotH, opts, w, h };
  canvas.__chart.redrawWith = () => lineChart(canvas, series, opts);
  attachLineTip(canvas, opts);
  // Freshness pill: if the newest sample is old, say so rather than let the
  // chart read as live.
  if (opts.staleMs != null && Date.now() - t1 > opts.staleMs) {
    markStale(canvas, `stale ${ageLabel(Date.now() - t1)}`);
  }
}

function logY(v, lo, hi, L, plotH) {
  const l = Math.log10(Math.max(1e-9, lo || 1e-9));
  const hh = Math.log10(Math.max(1e-9, hi));
  const y = Math.log10(Math.max(1e-9, v));
  return L.top + plotH - ((y - l) / (hh - l)) * plotH;
}

function drawLegend(ctx, series, L, w) {
  ctx.font = '10px system-ui, sans-serif';
  let x = L.left + 2;
  const y = L.top + 7;
  for (const s of series.slice(0, 5)) {
    const label = s.label ?? '';
    const wid = ctx.measureText(label).width;
    ctx.fillStyle = s.color ?? COL.accent;
    ctx.fillRect(x, y - 4, 7, 2);
    ctx.fillStyle = COL.text;
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 10, y - 3);
    x += wid + 20;
    if (x > w - 40) break;
  }
  ctx.font = '10px ui-monospace, monospace';
}

function attachLineTip(canvas, opts) {
  if (canvas.__tipBound) return;
  canvas.__tipBound = true;
  canvas.addEventListener('mousemove', (ev) => {
    const c = canvas.__chart;
    if (!c || c.kind !== 'line') return;
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    if (mx < c.L.left || mx > c.w - c.L.right) { redraw(canvas); return; }
    const t = c.t0 + ((mx - c.L.left) / c.plotW) * (c.t1 - c.t0);
    const rows = [];
    let nearX = mx;
    for (const s of c.series) {
      let best = null;
      let bd = Infinity;
      for (const p of s.points) {
        const d = Math.abs(p.t - t);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) {
        rows.push({ label: s.label ?? '', v: best.v, color: s.color ?? COL.accent, axis: s.axis });
        nearX = c.X(best.t);
      }
    }
    if (!rows.length) return hideTip(canvas);
    redraw(canvas);
    const { ctx } = ctxOf(canvas);
    ctx.strokeStyle = INK.faintLine;
    ctx.beginPath(); ctx.moveTo(nearX, c.L.top); ctx.lineTo(nearX, c.L.top + c.plotH); ctx.stroke();
    const fmt = opts.fmtTip ?? ((v, s) => short(v));
    const boxW = 118;
    const boxH = 14 + rows.length * 12;
    const bx = Math.min(c.w - boxW - 4, nearX + 8);
    const by = c.L.top + 4;
    ctx.fillStyle = INK.tip;
    ctx.strokeStyle = INK.tipLine;
    ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 5); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.text;
    ctx.fillText(clock(t), bx + 6, by + 8);
    rows.forEach((row, i) => {
      const y = by + 20 + i * 12;
      ctx.fillStyle = row.color;
      ctx.fillRect(bx + 6, y - 3, 6, 2);
      ctx.fillStyle = INK.tipText;
      const label = (row.label || '').slice(0, 12);
      ctx.fillText(label, bx + 16, y - 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = INK.bright;
      ctx.fillText(fmt(row.v, row), bx + boxW - 6, y - 2);
      ctx.textAlign = 'left';
    });
  });
  canvas.addEventListener('mouseleave', () => hideTip(canvas));
}

function redraw(canvas) {
  const c = canvas.__chart;
  if (!c) return;
  if (c.redrawWith) c.redrawWith();
}
function ctxOf(canvas) {
  // Deliberately does NOT clear. The caller has just repainted the chart through
  // redraw(), and this context exists only to draw the crosshair and the popup ON TOP
  // of it. The clearRect this used to carry -- on the reasonable-looking theory that a
  // helper handing out a context should start from a clean slate -- erased the very
  // chart it had been asked to annotate: hovering replaced 120 draw ops of chart with
  // the 12 a popup needs, so the chart vanished and only the tooltip was left standing.
  // "Never erase the screen to show a status" applies to a tooltip exactly as much as
  // to a placeholder: the overlay may sit on the data, never instead of it.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  return { ctx };
}
/** Drop the crosshair and the popup by repainting the chart that sits under them. */
function hideTip(canvas) { redraw(canvas); }

// ------------------------------------------------------------------- bar

/** values aligned to edges (histogram). opts: {edges, logX, color, fmtX, fmtY, highlight} */
export function histogram(canvas, values, opts = {}) {
  const vals = (values ?? []).map(Number);
  if (!vals.length || vals.every((v) => !v)) return empty(canvas, opts.emptyMsg ?? 'no samples');
  const { ctx, w, h } = prep(canvas);
  const L = { ...M, left: opts.left ?? M.left };
  const plotW = w - L.left - L.right;
  const plotH = h - L.top - L.bottom;
  const hi = Math.max(...vals);
  const lo = 0;
  const n = vals.length;
  const bw = plotW / n;
  const edges = opts.edges ?? null;

  ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text; ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (const tv of niceTicks(lo, hi, 3)) {
    const y = Math.round(L.top + plotH - (tv / hi) * plotH) + 0.5;
    ctx.beginPath(); ctx.moveTo(L.left, y); ctx.lineTo(w - L.right, y); ctx.stroke();
    ctx.fillText(short(tv), L.left - 5, y);
  }

  for (let i = 0; i < n; i++) {
    if (!vals[i]) continue;
    const bh = (vals[i] / hi) * plotH;
    const x = L.left + i * bw;
    const isHi = opts.highlight != null && edges && edges[i] != null && edges[i] <= opts.highlight && (edges[i + 1] ?? Infinity) > opts.highlight;
    const g = ctx.createLinearGradient(0, L.top + plotH - bh, 0, L.top + plotH);
    const col = isHi ? COL.ok : (opts.color ?? COL.accent);
    g.addColorStop(0, col);
    g.addColorStop(1, hexA(col, 0.42));
    ctx.fillStyle = g;
    ctx.fillRect(x + Math.min(1.5, bw * 0.12), L.top + plotH - bh, Math.max(1, bw - Math.min(3, bw * 0.24)), bh);
  }

  if (edges && edges.length) {
    ctx.fillStyle = COL.text;
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(n / 6));
    for (let i = 0; i < n; i += step) {
      const x = L.left + i * bw + bw / 2;
      if (x > w - L.right - 8) break;
      ctx.fillText((opts.fmtX ?? short)(edges[i]), x, h - 7);
    }
  }
  // The axis label sits in the plot's top-right corner, not on the tick row:
  // at the tick row's end it printed over the last tick ("sat/873 (log)").
  if (opts.axisLabel) {
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.axisLabel, w - L.right, 3);
    ctx.textBaseline = 'alphabetic';
  }
  canvas.__hasData = true;
  canvas.__since = Date.now();
  canvas.__chart = { kind: 'hist' };
}

// --------------------------------------------------------------- scatter

/** points: [[x, y, size]] ; logY for feerate */
export function scatter(canvas, points, opts = {}) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return empty(canvas, opts.emptyMsg ?? 'no transactions to plot');
  const { ctx, w, h } = prep(canvas);
  const L = { ...M, left: opts.left ?? M.left };
  const plotW = w - L.left - L.right;
  const plotH = h - L.top - L.bottom;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = opts.xMin ?? Math.min(...xs);
  const x1 = opts.xMax ?? Math.max(...xs);
  let y0 = opts.yMin ?? Math.max(0.1, Math.min(...ys));
  let y1 = opts.yMax ?? Math.max(...ys) * 1.15;
  if (opts.logY) { y0 = Math.max(0.05, y0); y1 = Math.max(y0 * 10, y1); }
  const X = (v) => L.left + ((v - x0) / Math.max(1e-9, x1 - x0)) * plotW;
  const Y = (v) => opts.logY ? logY(v, y0, y1, L, plotH) : L.top + plotH - ((v - y0) / (y1 - y0)) * plotH;

  ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text; ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  const yticks = opts.logY ? logTicks(y0, y1) : niceTicks(y0, y1, Math.max(2, Math.min(4, Math.floor(plotH / 22))));
  let lastLabel = null;
  for (const tv of yticks) {
    const y = Math.round(Y(tv)) + 0.5;
    if (y < L.top || y > L.top + plotH) continue;
    ctx.beginPath(); ctx.moveTo(L.left, y); ctx.lineTo(w - L.right, y); ctx.stroke();
    const label = (opts.fmtY ?? short)(tv);
    if (label !== lastLabel) ctx.fillText(label, L.left - 5, y);
    lastLabel = label;
  }
  ctx.textAlign = 'center';
  for (const tv of niceTicks(x0, x1, 4)) {
    const x = X(tv);
    ctx.fillText((opts.fmtX ?? dur)(tv), x, h - 7);
  }

  const maxS = Math.max(...pts.map((p) => p[2] ?? 1), 1);
  for (const p of pts) {
    const x = X(p[0]);
    const y = Y(p[1]);
    if (x < L.left || x > w - L.right || y < L.top || y > L.top + plotH) continue;
    const r = opts.logY ? 1.2 + 2.4 * Math.sqrt((p[2] ?? 1) / maxS) : 1.8;
    ctx.fillStyle = opts.color ?? hexA(COL.accent, 0.5);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  if (opts.yLabel) {
    ctx.save();
    ctx.fillStyle = COL.textDim;
    ctx.textAlign = 'left';
    ctx.translate(10, L.top + 4);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'right';
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }
  canvas.__hasData = true;
  canvas.__since = Date.now();
  canvas.__chart = { kind: 'scatter' };
}

// ------------------------------------------------------------ gauge/usage

/** horizontal usage meter with a danger zone; used for mempool usage vs max */
export function meter(canvas, { value, max, label, danger = 0.9, fmt }) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return empty(canvas, 'no usage figure');
  const { ctx, w, h } = prep(canvas);
  // Text is placed in PIXELS, not as fractions of the radius: in a short
  // canvas the three radius-relative lines landed on top of each other
  // ("of maxmempool", the percentage and the byte figures, in one pile).
  // The percentage sits inside the arc; the byte figures sit below it.
  const r = Math.max(18, Math.min(h - 26, w / 2 - 12, 64));
  const cx = w / 2;
  const cy = h - 20;
  const pct = Math.min(1.15, value / max);
  const a0 = Math.PI;
  const a1 = Math.PI * 2;
  ctx.lineWidth = Math.max(7, r * 0.34);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = INK.panel;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
  // the region past which the node starts feerate-evicting
  ctx.strokeStyle = hexA(COL.bad, 0.5);
  ctx.beginPath(); ctx.arc(cx, cy, r, a0 + Math.PI * danger, a1); ctx.stroke();
  const col = pct >= danger ? COL.bad : pct > 0.75 ? COL.warn : COL.ok;
  ctx.strokeStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + Math.PI * Math.min(1, pct)); ctx.stroke();
  ctx.fillStyle = INK.bright;
  ctx.textAlign = 'center';
  ctx.font = '600 17px ui-monospace, monospace';
  ctx.fillText(`${((value / max) * 100).toFixed(1)}%`, cx, cy - 4);
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = COL.text;
  ctx.fillText((fmt ? fmt(value) : short(value)) + ' of ' + (fmt ? fmt(max) : short(max)) + (label ? ' ' + label : ''), cx, h - 4);
  ctx.textAlign = 'left';
  canvas.__hasData = true;
  canvas.__since = Date.now();
  canvas.__chart = { kind: 'meter' };
}

export function sparkline(canvas, points, opts = {}) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p.v ?? p));
  if (!pts.length) return empty(canvas, opts.emptyMsg ?? '');
  const norm = pts.map((p) => (p.v != null ? { t: p.t, v: p.v } : { t: 0, v: p }));
  lineChart(canvas, [{ label: opts.label ?? '', color: opts.color ?? COL.info, points: norm, area: true }], {
    ...opts, left: 0, bottom: 2, legend: false, fmtY: () => '', fmtX: () => '',
  });
}

/** stacked bars for the peer-connect mix / orphan states */
export function stackedBars(canvas, rows, opts = {}) {
  const data = (rows ?? []).filter((r) => r && Number.isFinite(r.value));
  if (!data.length) return empty(canvas, opts.emptyMsg);
  const { ctx, w, h } = prep(canvas);
  const L = { top: 6, right: 8, bottom: 16, left: opts.left ?? 116 };
  const plotW = w - L.left - L.right;
  const rowH = Math.min(20, (h - L.top - L.bottom) / data.length);
  const max = Math.max(...data.map((r) => r.value), 1);
  data.forEach((r, i) => {
    const y = L.top + i * rowH;
    ctx.fillStyle = COL.text;
    ctx.textAlign = 'right';
    ctx.fillText(String(r.label ?? '').slice(0, 20), L.left - 6, y + rowH / 2);
    ctx.fillStyle = INK.panel;
    ctx.fillRect(L.left, y + 2, plotW, rowH - 5);
    const bw = (r.value / max) * plotW;
    ctx.fillStyle = r.color ?? COL.accent;
    ctx.fillRect(L.left, y + 2, Math.max(1, bw), rowH - 5);
    ctx.fillStyle = INK.bright;
    ctx.textAlign = 'left';
    ctx.fillText(String(r.display ?? short(r.value)), L.left + Math.min(bw + 5, plotW - 40), y + rowH / 2);
  });
  canvas.__hasData = true;
  canvas.__since = Date.now();
  canvas.__chart = { kind: 'bars' };
}

/**
 * The only way panels should draw.
 *
 * `paint(canvas, { when, draw, placeholder, staleMs })`:
 *   - has data      -> draw (clearing is fine, it is replacing like with like)
 *   - no data, but this canvas already shows data for THIS node -> leave it
 *     alone and mark it stale
 *   - no data, never had any -> placeholder
 *
 * Background sampling therefore never reaches the foreground: a gap in the
 * stream costs you a small amber pill, not your chart.
 */
export function paint(canvas, { when, draw, placeholder = 'no data yet', staleMs = 90_000, staleMsg }) {
  if (!canvas) return false;
  if (when) {
    draw(canvas);
    return true;
  }
  if (hasData(canvas)) {
    const since = canvas.__since;
    const age = Number.isFinite(since) ? Date.now() - since : null;
    markStale(canvas, staleMsg ?? (age != null ? `no fresh data · ${ageLabel(age)}` : 'no fresh data'));
    return false;
  }
  empty(canvas, placeholder);
  return false;
}

// ------------------------------------------------------------ formatters

export function short(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(1) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return +v.toFixed(1) + '';
  return +v.toFixed(4) + '';
}
export function clock(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function dur(sec) {
  if (!Number.isFinite(sec)) return '–';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
function hexA(hex, a) {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export { COL, palette };
