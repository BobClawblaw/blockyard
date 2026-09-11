// The block flow: past blocks, the tip, and the block being built right now -- plus the
// Goggles-style views of what is inside the block under construction.
//
// Layout follows the thing it is imitating, for a reason: mempool.space puts past blocks
// on the left, the tip in the middle, and the block being assembled on the right, with the
// eye moving left-to-right because that is the direction blocks leave. A bar chart of
// "weight used per block" carries the same numbers and communicates none of it, so the
// cards show what a block *is* -- who mined it, how long the gap was, how full it came
// out, what it paid -- and the next-block card shows a block that does not exist yet.
//
// The honest part: an unlabelled coinbase is drawn with its raw text and a grey rail, the
// next-block card states its own age and what it cost the node to answer, and the package
// view is labelled as the block-under-construction's ancestor graph -- the one dependency
// graph this node publishes (getblocktemplate carries `depends`; getrawmempool does not).

import { paint, COL } from './charts.js';
import { blockTreemap, mempoolTreemap, rateColor as rateBucketColor } from './goggles.js';
// 2026-09-10: the block and the pool now draw as lit solids on a square-packed
// grid (the look of mempool.space's block view, our own packer in blockpack.js) with feerate carried
// in HEIGHT as well as colour, and refreshes that lift, fly and land. The flat
// treemap entry points stay imported above so a fallback is one edit away.
import { block3d, mempool3d } from './details3d.js';
import { feeColor } from './feepalette.js';

// ONE viewer, two pages. The operator asked for the mempool viewer to be
// IDENTICAL on Overview and Mining, so both call this and nothing else --
// same data, same options. A "smaller copy" that quietly diverges is exactly
// the failure this replaces.
export function poolViewerArgs(s, state) {
  const mp = state?.mempoolDist ?? s?.mempool ?? {};
  return { cells: mp.cells ?? [], totalVsize: mp.totalVsize ?? mp.usage ?? null };
}
// the same viewer, for the Mempool page (2026-09-11: "add the mempool display here too")
export function poolViewer(canvas, s, state) { return drawPoolViewer(canvas, s, state); }

// THE COUNTDOWN TO THE NEXT REFRESH (operator, 2026-09-11: "we need to add a
// countdown to refresh somewhere in that panel"). The viewer's picture changes
// every 30 s; this says when. `frac` is the share of the wait already gone,
// drawn as a fill behind the text. No refresh scheduled yet: nothing to show.
export function refreshLabel(nextAt, now, { paused = false, period = 60_000 } = {}) {
  if (!Number.isFinite(nextAt)) return { text: '', frac: 0 };
  const rem = nextAt - now;
  const frac = Math.max(0, Math.min(1, 1 - rem / period));
  if (paused) return { text: 'refresh paused', frac };
  if (rem <= 0) return { text: 'refreshing…', frac: 1 };
  const s = Math.ceil(rem / 1000);
  return { text: `next refresh ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, frac };
}

// VIEWER MODES (operator, 2026-09-11: "we need to save off the current viewer as "Viewer Mode 1"
// or something, as we add more viewer variants"). Mode 1 is the viewer as it was: the richest
// 400 transactions as cubes, the rest as equal pieces, on a 44-unit board. Mode 2 is the
// high-density view asked for beside mempool.space's Goggles: every transaction in the next
// block's worth (denseBlock on the server), one square each on a 128-unit board, standing as low
// slabs so thousands stay readable and fast. Same board, camera, lighting and effects.
export const VIEWER_MODES = [
  // named Simple and Detailed (operator, 2026-09-11: "We should not call it Goggles Mode. We should call it
  // Detailed. Mode 1 as Simple"); the ids stay '1' and '2' so a remembered choice survives the rename
  { id: '1', label: 'Simple', title: 'Simple: the richest 400 transactions as cubes, the rest as equal pieces coloured by feerate' },
  { id: '2', label: 'Detailed', title: 'Detailed: every transaction in the next block; small ones of the same feerate bundled into larger squares' },
];
// 96 UNITS, MEASURED (2026-09-11, the live next block: 3,051 transactions, p10/50/90 139/140/141
// vB). The packer rounds a square's side (round(sqrt(1.1 vsize / vbytes-per-unit))), and at 128
// units a 140 vB transaction rounds to 2 x 2: the block overflowed to 172 rows, the fit shrank
// everything back to 1 x 1, and 30 of the 128 rows stood empty -- the scattered, holed board. At
// 96 a typical transaction is exactly one unit: every one fits with no shrinking, 2,943 of them
// 1 x 1, the board 94% full, the largest still 26 units a side.
// dither: area-true square sides (blockpack.js ditheredSide), so a full block fills the board;
// bundleSide: runs of small same-feerate transactions drawn as one ~5x5 square (bundleSmall)
export const DENSE_OPTS = { resolution: 96, slab: 1.2, order: 'diagonal', gridStep: 8, neonCell: 'rgba(50,190,125,0.22)', dither: true, bundleSide: 5 };
export function viewerSetup(s, state) {
  const d = state?.denseBlock;
  if (state?.viewerMode === '2' && d?.v?.length) {
    const cells = d.v.map((v, i) => ({ vbytes: v, rate: d.r[i], txid: d.id?.[i] ?? `d${i}` }));
    return { mode: '2', args: { cells, totalVsize: d.vsize ?? null }, opts: DENSE_OPTS };
  }
  // mode 2 before its first dense read: the mode 1 picture, not a blank board
  // ONE ID FORMAT FOR BOTH MODES: full txids -- a transaction on both boards is the same tile, so
  // switching modes flies the richest few hundred to their new places instead of emptying the
  // board and refilling it; and a click on any of them opens it in the explorer
  return { mode: state?.viewerMode === '2' ? '2-waiting' : '1', args: poolViewerArgs(s, state), opts: {} };
}
function modeSwitch(canvas, state) {
  // THE CONTROLS SIT IN THE PANEL'S TITLE ROW, not over the board (operator, 2026-09-11: "move the
  // buttons out of the 3D display. It's covering the blocks at the top of the scene"). The bar is
  // authored inside the viewer's wrapper; the first render moves it into the card's heading and
  // remembers its board (app.js finds a refresh button's board through the bar).
  const ctl = canvas?.__viewerCtl ?? canvas?.parentElement?.querySelector?.('.viewer-ctl');
  if (!ctl) return;
  if (canvas && !canvas.__viewerCtl) {
    canvas.__viewerCtl = ctl;
    ctl.__canvas = canvas;
    const head = canvas.closest?.('.card, .kpanel')?.querySelector?.('h3, .khead');
    if (head && ctl.parentElement !== head && typeof head.appendChild === 'function') { head.appendChild(ctl); ctl.classList?.add('in-head'); }
  }
  let el = ctl.querySelector?.('.viewer-mode');
  if (!el && typeof document?.createElement === 'function') {
    el = document.createElement('div');
    el.className = 'viewer-mode';
    el.innerHTML = VIEWER_MODES.map((m) => `<button type="button" data-vmode="${m.id}" title="${m.title}">${m.label}</button>`).join('');
    ctl.prepend?.(el);
  }
  for (const b of el?.querySelectorAll?.('button') ?? []) b.classList?.toggle('on', b.dataset.vmode === (state?.viewerMode ?? '1'));
}

function drawPoolViewer(canvas, s, state) {
  // Scaled to the POOL, so the packing fills a SQUARE grid and every block
  // lands inside it (operator: "the grid needs to take up the entire
  // viewspace. Every block needs to fit within the grid"). Against one
  // block's 1,000,000 vB a 3 MB pool packs three times taller than it is
  // wide, and no square grid could hold it. Where one block's worth ends is
  // drawn as a brighter line inside the grid instead.
  modeSwitch(canvas, state);
  const v = viewerSetup(s, state);
  return mempool3d(canvas, v.args, v.opts);
}

const WU_CAP_FALLBACK = 4_000_000;

const POOL_COLOURS = [COL.accent, COL.info, COL.ok, COL.purple, COL.cyan, COL.pink,
  COL.warn, '#8bd450', '#d98b5f', '#5fb0c9', '#c78bd4', '#c9b45f'];

function poolColor(key) {
  const k = String(key ?? '');
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
  return POOL_COLOURS[Math.abs(h) % POOL_COLOURS.length];
}

/** Palette entry per pool: index only, resolved to a colour by our own CSSOM code. */
function who(row) {
  if (row.poolLabel) return { name: row.poolLabel, idx: poolIndex(row.poolLabelKey ?? row.poolKey), labelled: true };
  if (row.poolKey && !String(row.poolKey).startsWith('unknown:')) {
    return { name: row.poolKey, idx: poolIndex(row.poolKey), labelled: false };
  }
  return { name: row.tagText ? trunc(row.tagText, 12) : 'unknown', idx: -1, labelled: false };
}

/** Thousands, through whatever fmt the page handed us; never a bare Number(). */
function fmtNum(n, h) {
  const f = h?.fmt?.num;
  return typeof f === 'function' ? f(n) : (n == null ? '–' : String(n));
}

// Fees in a two-column card grid: the unit lives in the LABEL ("fees ₿"), because
// "0.01193 BTC" does not fit a half-card column and wrapped onto a second line --
// a whole extra row of height per card for three letters.
const btcNum = (sats) => (sats == null ? '–' : (sats / 1e8).toFixed(sats > 1e7 ? 3 : 5));
const trunc = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t || 'unknown'; };
const btc = (sats) => (sats == null ? '–' : `${(sats / 1e8).toFixed(sats > 1e7 ? 3 : 5)} BTC`);
const gapText = (sec) => (sec == null ? '–' : sec >= 600 ? `${Math.floor(sec / 600)}m${Math.floor((sec % 600) / 60)}s` : sec >= 60 ? `${Math.floor(sec / 60)}s${sec % 60 ? ` ${(sec % 60)}s` : ''}` : `${sec}s`);

/**
 * Which motions this data has earned, as opposed to decoration.
 *
 * The pipeline must animate when a block ARRIVES and stay still when a frame merely
 * repaints -- and this page repaints once a second. Compared against the previous render,
 * not against a timer: without this, every second of every day would replay the arrival
 * animation until the motion meant nothing at all.
 */
export function flowMotion(prevNewest, newest) {
  const has = (v) => Number.isFinite(v);
  if (!has(prevNewest) || !has(newest) || newest <= prevNewest) return { shift: false, arrived: null };
  return { shift: true, arrived: newest };
}

/** Rail speed: the measured average block gap, clamped to something a screen can show. */
export function railSeconds(avgGapSec) {
  const g = Number.isFinite(avgGapSec) && avgGapSec > 0 ? avgGapSec : 600;
  return +Math.min(240, Math.max(12, g / 25)).toFixed(1);
}

/**
 * The block meter: the block being built, filling up, in ONE row.
 *
 * Replaces a row of bobbing ticks whose count was sqrt(txCount) -- decoration
 * shaped like a number, which also wrapped onto a second line and bobbed out of
 * step (operator, 2026-09-11: "disjointed and not contiguous across the line").
 *
 * Each of METER_SEGMENTS segments is an equal share of the weight cap. A lit
 * segment is weight the node has selected, coloured by the feerate of the
 * transaction sitting at that point of the template when it is laid out richest
 * first -- so the row reads hot-to-cool left to right, exactly as a miner fills
 * a block. The frontier segment is filled fractionally. Segments the latest
 * reading added over `prevLit` (same height only) are marked `new` and light
 * up once. Everything is a reading: weight, cap, and the template's own cells.
 */
export const METER_SEGMENTS = 40;
export function growthMeter(nb, prevLit = null, now = Date.now()) {
  if (!nb || nb.unavailable) return { html: '', lit: 0 };
  const cap = Number(nb.weightLimit) || WU_CAP_FALLBACK;
  const frac = Math.max(0, Math.min(1, (Number(nb.weight) || 0) / cap));
  const n = METER_SEGMENTS;
  const full = Math.min(n, Math.floor(frac * n + 1e-9));
  const part = frac * n - full;
  const cells = (nb.visual?.cells ?? [])
    .map((c) => ({ vb: Math.max(0, Number(c.vbytes ?? c.vsize) || 0), rate: Number(c.rate) }))
    .filter((c) => c.vb > 0 && Number.isFinite(c.rate))
    .sort((a, b) => b.rate - a.rate);
  const totalVb = cells.reduce((s, c) => s + c.vb, 0);
  // the rate of the transaction at fraction f (0..1) of the template's own size
  const rateAt = (f) => {
    if (!totalVb) return null;
    const target = Math.max(0, Math.min(1, f)) * totalVb;
    let acc = 0;
    for (const c of cells) { acc += c.vb; if (acc >= target) return c.rate; }
    return cells[cells.length - 1].rate;
  };
  const fee = (r) => (r == null ? '' : ` data-fee="${Math.round(r * 100) / 100}"`);
  const grew = Number.isFinite(prevLit) && full > prevLit;
  const segs = [];
  for (let i = 0; i < n; i++) {
    if (i < full) {
      segs.push(`<i class="on${grew && i >= prevLit ? ' new' : ''}"${fee(rateAt(frac > 0 ? ((i + 0.5) / n) / frac : 0))}></i>`);
    } else if (i === full && part > 0.001) {
      segs.push(`<i class="edge"><span data-w="${(part * 100).toFixed(1)}"${fee(rateAt(1))} data-phase="${((now % 2400) / 1000).toFixed(2)}"></span></i>`);
    } else if (i === full) {
      segs.push(`<i class="next" data-phase="${((now % 2400) / 1000).toFixed(2)}"></i>`);
    } else {
      segs.push('<i></i>');
    }
  }
  const title = `${(frac * 100).toFixed(1)}% of the ${cap.toLocaleString('en-US')} WU cap selected. `
    + `Each segment is ${(100 / n).toFixed(1)}% of the cap; lit segments are coloured by the feerate of the transactions that fill them, richest first.`;
  return { html: `<div class="bmeter" title="${title}">${segs.join('')}</div>`, lit: full };
}

/**
 * Where each card comes from.
 *
 * The TIP HEIGHT -- `getblockchaininfo.blocks`, polled every second -- is the only thing
 * allowed to decide what sits in the centre. The attribution rows lag it: one block per
 * poll, two RPC reads each, and nothing at all during initial download. If the newest
 * attributed row were treated as the tip, the centre card would quietly show a block from
 * four minutes ago and call it the current one, which is the bug this exists to prevent.
 * So heights are generated from the tip and the rows are matched to them by height; a
 * height with no row yet is drawn as a placeholder that says so, not skipped -- skipping
 * hides the lag, and a row that hides its lag is a lie with better typography.
 */
export function flowFrame({ tipHeight, recent = [], history = 8 } = {}) {
  const rows = new Map((recent ?? []).filter((r) => r && Number.isFinite(r.height)).map((r) => [r.height, r]));
  const tip = { height: Number.isFinite(tipHeight) ? tipHeight : null, row: rows.get(tipHeight) ?? null };
  const past = [];
  if (Number.isFinite(tipHeight)) {
    for (let h = tipHeight - 1; h > tipHeight - 1 - history && h >= 0; h--) {
      past.push({ height: h, row: rows.get(h) ?? null });
    }
  }
  const unattributed = (tip.row ? 0 : 1) + past.filter((p) => !p.row).length;
  return { tip, history: past, unattributed };
}

/**
 * Does the template actually describe the block that comes NEXT?
 *
 * The template is fetched on demand and can be seconds or minutes old while the chain
 * moves; showing a stale one under the label "being built" implies the node is assembling
 * a block that is already three heights back.
 */
export function templateDrift(templateHeight, tipHeight) {
  if (!Number.isFinite(templateHeight) || !Number.isFinite(tipHeight)) return { known: false };
  const behind = templateHeight - (tipHeight + 1);
  return { known: true, behind, ok: behind === 0, stale: behind < 0 };
}

/**
 * How overdue the next block is, and when the answer must not be given at all.
 *
 * The clock that matters is ARRIVAL -- seconds since the tip height last changed --
 * because "we are expecting a new tip at any moment" is a statement about the chain's
 * behaviour, not about a timestamp a miner chose. Block time is the fallback on a page
 * load, where no arrival has been witnessed yet, and in that case the note says so.
 *
 * Suppressed entirely during initial download, while the node is not answering, and while
 * updates are paused: a tip that is six hours old in the middle of a reindex is not a
 * warning, and a red card that means nothing is worse than no card -- it teaches people to
 * ignore the colour that is supposed to be the most important one on the screen.
 */
export function tipFreshness({ arrivalSec = null, ageSec = null, avgGapSec = null, ibd = false, online = true, paused = false } = {}) {
  if (ibd || !online || paused) return { level: 'n/a', seconds: null, basis: null, why: ibd ? 'initial download' : (!online ? 'node not answering' : 'updates paused') };
  if (!Number.isFinite(arrivalSec) && !Number.isFinite(ageSec)) return { level: 'n/a', seconds: null, basis: null, why: 'no tip reading yet' };
  // Arrival is used only when the caller actually WITNESSED the transition (blockFlow does
  // the witnessing, and refuses to on a first paint). That is what makes it authoritative:
  // a page that has watched the height change knows when this block landed, whatever the
  // timestamp says -- timestamps can run minutes late, and the node accepts blocks up to
  // two hours in the past by rule. Where nothing was witnessed, the block timestamp is the
  // only honest clock, and the legend says so rather than quietly mixing the two.
  const seconds = Number.isFinite(arrivalSec) ? arrivalSec : (Number.isFinite(ageSec) ? ageSec : null);
  const basis = Number.isFinite(arrivalSec) ? 'arrival' : (Number.isFinite(ageSec) ? 'block time' : null);
  // Judged against THIS chain's measured interval, floored at the agreed 4/8 minutes.
  // Amber past one average gap — it is taking longer than it has been taking. Red at 1.5x:
  // "two average gaps" on an 11-minute chain means waiting 22 minutes to be told a
  // 22-minute-old tip is overdue, and by then the colour has stopped meaning anything.
  // No measurement, no allowance: with no observed interval the marks stay at the absolute
  // 4/8 minutes rather than granting a healthy 10-minute chain we never saw.
  const gap = Number.isFinite(avgGapSec) && avgGapSec > 0 ? avgGapSec : 0;
  const lateAt = Math.max(240, gap);
  const overdueAt = Math.max(480, gap * 1.5);
  const level = seconds < lateAt ? 'fresh' : seconds < overdueAt ? 'late' : 'overdue';
  return { level, seconds, basis, lateAt, overdueAt, gap: Number.isFinite(avgGapSec) ? avgGapSec : null };
}

/** Rank of each block by the feerate its miner achieved, within the window shown. */
function feeRank(rows) {
  const ranked = rows.filter((r) => r?.avgFeerate != null).sort((a, b) => b.avgFeerate - a.avgFeerate);
  return new Map(ranked.map((r, i) => [r.height, i + 1]));
}

/** "12m ago", "4h ago", "just now" -- coarse on purpose; a train card is read at a glance. */
export function agoText(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return null;
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 75) return 'just now';
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/** Everything a card can say from the row alone, derived or read. */
function blockFacts(row) {
  const vB = row.weight != null ? Math.round(row.weight / 4) : null;
  const capPct = row.weight != null ? (100 * row.weight) / (row.weightLimit ?? WU_CAP_FALLBACK) : null;
  const fillVb = row.size != null ? row.size : vB;
  const satsPerTx = row.totalfee != null && row.txs ? Math.round(row.totalfee / row.txs) : null;
  return { vB, capPct, fillVb, satsPerTx };
}

/** One mined block, as a card. */
function blockCard(row, prev, fmt, arrived = false, isTip = false, extraClass = '', ctx = {}) {
  const w = who(row);
  const f = blockFacts(row);
  const age = agoText(row.at ?? row.seenAt, ctx.now);
  const gapToPrev = prev?.time && row.time ? row.time - prev.time : null;
  const tooltip = [
    row.tagText ? `coinbase: ${row.tagText}` : 'coinbase: no readable text',
    row.matchedTag ? `label matched "${row.matchedTag}"` : 'no curated label matched',
    row.tagSource ? `tag read by ${row.tagSource === 'scan' ? 'printable-run scan (the scriptSig push lengths do not describe their own bytes)' : 'push parsing'}` : '',
    f.vB != null ? `${fmt.num(f.vB)} vB / ${fmt.num(row.weight)} WU` : '',
    row.strippedSize != null ? `stripped size ${fmt.bytes(row.strippedSize, 0)}` : '',
    f.satsPerTx != null ? `${fmt.num(f.satsPerTx)} sat/tx` : '',
    row.p50 != null ? `block sat/vB p50 ${row.p50}${row.p75 != null ? ` · p75 ${row.p75}` : ''}${row.p99 != null ? ` · p99 ${row.p99}` : ''}` : '',
    row.commitment ? `witness commitment ${row.commitment}` : '',
    row.extraNonce ? `extranonce ${row.extraNonce.slice(0, 16)}` : '',
    row.hash ? `hash ${row.hash.slice(0, 24)}…` : '',
    row.at != null ? `block time ${new Date(row.at).toISOString().slice(0, 19)}Z` : '',
    row.seenAt != null ? `attributed ${new Date(row.seenAt).toISOString().slice(11, 19)}Z` : '',
  ].filter(Boolean).join('\n');

  return `<div class="bcard ${w.labelled ? '' : 'unlabelled'}${isTip ? ' tip' : ''}${arrived ? ' arrive' : ''}${extraClass ? ' ' + extraClass : ''}" data-pool="${w.idx}"
      title="${fmt.esc(tooltip)}">
    <i class="bstack" data-h="${f.capPct == null ? 0 : f.capPct.toFixed(1)}" data-pool="${w.idx}" aria-hidden="true"></i>
    <div class="bh"><span class="bdot" data-pool="${w.idx}"></span>${Number.isFinite(row.height) ? `<a class="bxlink" href="#explorer/block/${row.height}" title="open block ${row.height} in the explorer"><b>#${row.height}</b></a>` : '<b>#?</b>'}
      ${ctx.tipHeight && Number.isFinite(row.height) ? `<i class="delt">−${ctx.tipHeight - row.height}</i>` : ''}
      <span class="bpool" data-pool-fg="${w.idx}">${fmt.esc(trunc(w.name, 11))}</span></div>
    <div class="bwhen ${gapToPrev != null && gapToPrev > 1200 ? 'longgap' : ''}">${age ? `mined ${age}` : 'mined –'}${gapToPrev != null ? ` · gap ${gapText(gapToPrev)}` : ''}</div>
    <div class="bgrid">
      <div><i>size</i><span>${f.fillVb != null ? fmt.bytes(f.fillVb, 0) : '–'}</span></div>
      <div><i>txs</i><span>${row.txs != null ? fmt.num(row.txs) : '–'}</span></div>
      <div><i>fees ₿</i><span>${btcNum(row.totalfee)}</span></div>
      <div><i>sat/tx</i><span>${f.satsPerTx != null ? fmt.num(f.satsPerTx) : '–'}</span></div>
      <div><i>avg/vB</i><span>${row.avgFeerate ?? '–'}</span></div>
      <div><i>p50/vB</i><span>${row.p50 ?? '–'}</span></div>
    </div>
    <div class="bfill" title="${f.capPct != null ? `${f.capPct.toFixed(1)}% of the 4,000,000 WU cap` : 'weight unknown'}">
      <span data-w="${f.capPct == null ? 0 : f.capPct.toFixed(1)}" data-pool="${w.idx}"></span>
    </div>
    <div class="bcap">${f.capPct != null ? `${f.capPct.toFixed(1)}% of 4M WU` : 'weight –'}${ctx.rank && ctx.rank.get(row.height) ? ` · feerate #${ctx.rank.get(row.height)}` : ''}</div>
  </div>`;
}

/** The block that does not exist yet: how full it is, what it paid, what is queued behind it. */
function nextCard(nb, mempool, drift = {}, fmt, freshClass = '', fresh = null, meter = '') {
  const ec = nb?.economy ?? null;
  const ring = freshClass ? ' ' + freshClass : '';
  const since = fresh && Number.isFinite(fresh.seconds) ? Math.round(fresh.seconds / 60) : null;
  if (!nb) return `<div class="bcard next empty${ring}">The block being built.<br><span class="tiny">No template yet — the page asks for one on open and the node takes about a second and a half to answer. <a href="#mining">Mining</a> shows the packages inside it.</span></div>`;
  if (nb.unavailable) return `<div class="bcard next empty${ring}">No block template.<br><span class="tiny">${fmt.esc(nb.unavailable)}</span></div>`;
  const pct = nb.weightPct ?? 0;
  const ageSec = nb.at ? Math.round((Date.now() - nb.at) / 1000) : null;
  const cap = Math.min(100, Math.max(pct, 0.6));
  const q = mempool?.bytes;
  return `<div class="bcard next${ring}" title="${fmt.esc(nb.note ?? '')}">
    <div class="bh"><span class="live"></span><b>#${nb.height ?? '?'}</b><span class="bpool">${drift.stale ? 'stale template' : 'being built'}</span>${since != null ? `<span class="bage">${since}m</span>` : ''}</div>
    ${drift.stale ? `<div class="note tiny warn">this reading is ${Math.abs(drift.behind)} height(s) behind the tip — the node has since mined a block</div>` : ''}
    <div class="bgap">${ageSec != null ? `${ageSec}s old · answered in ${nb.ms ?? '?'}ms` : ''}</div>
    ${meter}
    <div class="bgrid" title="${fmt.num(nb.weight)} of ${fmt.num(nb.weightLimit ?? WU_CAP_FALLBACK)} WU selected${q != null ? ` · ${fmt.bytes(q)} queued in the mempool` : ''}">
      <div><i>txs</i><span>${nb.txCount != null ? fmt.num(nb.txCount) : '–'}</span></div>
      <div><i>full</i><span>${pct.toFixed(1)}%</span></div>
      <div><i>fees ₿</i><span>${btcNum(nb.totalFeesSat)}</span></div>
      <div><i>free</i><span>${ec?.remainingPct != null ? `${ec.remainingPct}%` : '–'}</span></div>
      <div><i>med/vB</i><span>${nb.feeRate?.p50 ?? '–'}</span></div>
      <div><i>max/vB</i><span>${nb.feeRate?.max ?? '–'}</span></div>
    </div>
    <div class="bnextfill"><span data-h="${cap.toFixed(1)}"></span></div>
    ${ec ? `<div class="chips">
        <span class="chip ${ec.marginal?.rate != null ? 'hot' : 'cold'}" title="the lowest feerate the node still had room for">${ec.marginal?.rate != null ? `marginal ~${ec.marginal.rate}/vB` : 'not full'}</span>
        ${ec.spillCount ? `<span class="chip warn" title="selected transactions in and below the marginal band, plus the queue that did not fit">${fmt.num(ec.spillCount)} spill</span>` : ''}
        ${ec.poolFitsNextPct != null ? `<span class="chip" title="getmempoolinfo.bytes against the weight still free: this share of the pool fits in the block">${ec.poolFitsNextPct}% fits</span>` : ''}
      </div>
      <div class="bcap" title="${ec.spillCount ? `~${fmt.num(Math.round(ec.spillWeight / 4))} vB of selected and queued weight waits beyond this block` : ''}">${ec.backlogBlocks != null ? `≈ ${ec.backlogBlocks} blocks queued` : 'queue depth unknown'}</div>` : ''}
    ${nb.lastError ? `<div class="note tiny bad">last refresh failed: ${fmt.esc(nb.lastError)}</div>` : ''}
  </div>`;
}

/**
 * The block being assembled on the LEFT, the latest confirmed block in the CENTRE, history
 * receding to the RIGHT. Three motions, each tied to a fact:
 *   - the rail runs at a speed derived from the measured average block gap, so a faster
 *     chain visibly moves faster, and the figure driving it is stated below;
 *   - when the TIP HEIGHT advances, the centre card plays the arrival (it is the new
 *     block) and the history row slides one step right. It is keyed on the chain's own tip
 *     from getblockchaininfo, never on the newest attributed row -- attribution runs one
 *     block per poll and would otherwise decide the animation, so the centre would step
 *     late and show the wrong height in between;
 *   - the under-construction card eases its fill toward the weight the node reported, and
 *     the inflow boxes stand for the transactions already selected, with the age of that
 *     reading on the card so it is never mistaken for a live per-transaction feed.
 * With prefers-reduced-motion, every number stays and nothing moves.
 */
// DRAG THE TRAIN (operator, 2026-09-11: "in block Flow, I should be able to mouse drag the blocks
// left and right, instead of using the drag bar"). Press anywhere on the row and drag to scroll it,
// with a little momentum on release. A drag never counts as a click on the block links it started
// over, snap scrolling is off while it moves, and touch keeps the browser's own scrolling. Bound
// once per row.
export function dragScroll(el) {
  if (!el || el.__drag || typeof el.addEventListener !== 'function') return;
  el.__drag = true;
  const now = () => (globalThis.performance && performance.now()) || Date.now();
  let down = null, moved = false, v = 0, raf = null;
  const settle = () => { el.classList?.remove('dragging'); };
  const stopGlide = () => { if (raf != null && globalThis.cancelAnimationFrame) cancelAnimationFrame(raf); raf = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    stopGlide();
    down = { x: e.clientX, left: el.scrollLeft, lx: e.clientX, t: now() };
    moved = false; v = 0;
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    if (!moved && Math.abs(dx) < 4) return;
    if (!moved) { moved = true; el.setPointerCapture?.(e.pointerId); el.classList?.add('dragging'); }
    const t = now();
    v = (e.clientX - down.lx) / Math.max(1, t - down.t);     // px per ms over the last stretch
    down.lx = e.clientX; down.t = t;
    el.scrollLeft = down.left - dx;
  });
  const up = (e) => {
    if (!down) return;
    down = null;
    el.releasePointerCapture?.(e.pointerId);
    if (!moved) return;
    if (!(Math.abs(v) > 0.05) || !globalThis.requestAnimationFrame) { settle(); return; }
    let last = now();
    const glide = (t) => {
      const dt = Math.max(0, t - last); last = t;
      el.scrollLeft -= v * dt;
      v *= Math.pow(0.94, dt / 16);
      if (Math.abs(v) > 0.02) raf = requestAnimationFrame(glide); else { raf = null; settle(); }
    };
    raf = requestAnimationFrame(glide);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('dragstart', (e) => e.preventDefault());           // no link-drag ghost
  el.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
}

export function blockFlow(el, { tipHeight = null, recent = [], next = null, mempool = null, avgGapSec = null, tipAgeSec = null, ibd = false, online = true, paused = false } = {}, fmt) {
  dragScroll(el);
  if (!el) return;
  const frame = flowFrame({ tipHeight, recent });
  const motion = flowMotion(el.__tip, frame.tip.height);
  // Arrival is WITNESSED: the timer starts only when the height changes under our eyes,
  // never on the first paint. A page that opened on a 14-minute-old tip has no idea when
  // the chain found it, and pretending otherwise coloured a stale tip green.
  if (Number.isFinite(frame.tip.height)) {
    if (el.__tip === undefined) { el.__tip = frame.tip.height; el.__tipAt = null; }
    else if (frame.tip.height !== el.__tip) { el.__tip = frame.tip.height; el.__tipAt = Date.now(); el.__witnessed = true; }
  }
  if (Number.isFinite(frame.tip.height)) el.__tip = frame.tip.height;
  const arrivalSec = el.__witnessed && el.__tipAt && el.__tip === frame.tip.height
    ? Math.round((Date.now() - el.__tipAt) / 1000) : null;
  const fresh = tipFreshness({ arrivalSec, ageSec: tipAgeSec, avgGapSec, ibd, online, paused });
  const drift = templateDrift(next?.height, frame.tip.height);
  if (!frame.tip.height && !next) {
    el.innerHTML = `<div class="note">No blocks drawn yet. The centre card needs the chain tip; the cards behind it need attribution, which is two small reads per block on the node's own RPC lane, skipped entirely during initial download.</div>`;
    return;
  }
  const gapMin = Math.round((Number.isFinite(avgGapSec) && avgGapSec > 0 ? avgGapSec : 600) / 60);
  const freshClass = fresh.level === 'n/a' ? '' : fresh.level;
  const shown = [frame.tip, ...frame.history].map((p) => p.row).filter(Boolean);
  const ctx = { now: Date.now(), tipHeight: frame.tip.height, rank: feeRank(shown) };
  // The coloured ring says HOW LONG THIS BLOCK HAS BEEN BUILDING, which is a fact
  // about the block under construction, not about the one that already landed
  // (operator: "the current block being built does not have a colored outline like
  // it's supposed to for it's time"). The tip keeps its own accent ring, which means
  // something else: this is the height the chain reports.
  const centre = frame.tip.row
    ? blockCard(frame.tip.row, frame.history[0]?.row, fmt, motion.arrived === frame.tip.height, true, '', ctx)
    : `<div class="bcard tip pending ${freshClass}"><div class="bh"><b>#${frame.tip.height ?? '?'}</b><span class="bpool warn">awaiting attribution</span></div>
        <div class="bgap">this is the chain tip; its coinbase has not been read yet</div>
        <div class="brows"><div><i>why</i><span>1 block per poll</span></div>${frame.unattributed ? `<div><i>heights behind</i><span>${frame.unattributed}</span></div>` : ''}</div></div>`;

  // The row scrolls horizontally and shows what it shows in flex; the cap that used to
  // live here (reserve 400 px for next+tip+arrows, fit history in the rest) broke the
  // timeline on wide panels — the mined side stopped short of the divider while the
  // forecast slivers were jammed against it. Every block the frame carries is rendered;
  // the horizontal scroll, parked at the divider on first paint (below), is what shows
  // more. This is the order the operator asked for: forecasts far left, the assembled
  // block immediately left of the line, the chain receding right of it.
  const hist = frame.history;
  // The meter remembers how many segments it lit for THIS height, so a reading
  // that adds weight lights only the new ones; a new height starts over.
  const same = el.__meter && next && el.__meter.height === next.height;
  const meter = growthMeter(next, same ? el.__meter.lit : null);
  if (next && !next.unavailable) el.__meter = { height: next.height, lit: meter.lit };
  el.innerHTML = `
    <div class="rail" data-rail="${railSeconds(avgGapSec)}" title="rail speed derived from the measured average block gap"><span></span></div>
    <div class="flow${motion.shift ? ' shift' : ''}">
      <div class="flowside todo">
        ${projectedCards(mempool?.dist?.projected, { avgGapSec, tipAgeSec }, fmt)}${nextCard(next, mempool, drift, fmt, freshClass, fresh, meter.html)}
      </div>
      <div class="flowsep" title="the divider: left is the work in progress, right is work the network accepted">
        <span class="flowsep-arrow up" aria-hidden="true"></span>
        <span class="flowsep-line" aria-hidden="true"></span>
        <span class="flowsep-arrow down" aria-hidden="true"></span>
        <span class="flowsep-tag">pending &#8646; done</span>
      </div>
      <div class="flowside done">
        ${centre}
        <div class="flowpast">${hist.map((p, i) => LINK + (p.row
          ? blockCard(p.row, hist[i + 1]?.row ?? null, fmt, false, false, '', ctx)
          : `<div class="bcard pending"><div class="bh"><b>#${p.height}</b></div><div class="bgap">not attributed</div></div>`)).join('')}</div>
      </div>
    </div>
    ${frame.unattributed ? `<div class="flownote"><b class="warn">${frame.unattributed} height(s) here have no coinbase reading yet</b> — attribution is one block per poll, so it trails the tip.</div>` : ''}
    <div class="tiplegend">${fresh.level === 'n/a'
      ? `<span class="tl na">tip age not judged — ${fmt.esc(fresh.why ?? 'no reading')}</span>`
      : `<span class="tl fresh" title="green: found within this">≤ ${Math.round((fresh.lateAt ?? 240) / 60)} min</span><span class="tl late" title="amber: later than the chain's average gap">≤ ${Math.round((fresh.overdueAt ?? 480) / 60)} min</span><span class="tl overdue" title="red: past 1.5x the average gap -- a block is due">due</span>
         <span class="tl now" title="${fresh.basis === 'block time' ? 'from the block timestamp: this page has not watched a block arrive yet' : 'since this page watched the tip change'}">${Math.round((fresh.seconds ?? 0) / 60)} min since the last block${fresh.gap != null ? ` · avg ${Math.round(fresh.gap / 60)} min` : ''}</span>`}</div>`;

  // First paint parks the scroll so the DIVIDER sits a quarter of the way in: the
  // interesting edge is what is being built against what landed, and both sides of
  // it have to be on screen for that to be an edge at all. Parking the divider
  // hard against the left margin was right when the pending side was three
  // forecast slivers plus the assembled block, roughly a third of the row. With
  // the forecasts gone the pending side is one card, so the same rule pushed the
  // block being built — the one card carrying the countdown ring — off the left
  // edge, and the panel opened on nothing but history. Subsequent repaints leave
  // the operator's scroll position alone; reading history should not snap back on
  // every SSE tick.
  // With PROJECTED BLOCKS on the pending side (2026-09-11) that rule opened the row on the
  // block being built with every projected card off the left edge -- measured on the
  // Overview: five cards in the page, none on screen. So when they are there the row parks
  // on the second-nearest (+2), showing +2, +1, the block being built and the chain after the
  // divider -- as long as the divider stays in the left 70% of the panel; a narrow panel
  // keeps the rule above. Cards that arrive after the first paint re-park once, never again.
  const projCards = typeof el.querySelectorAll === 'function' ? [...el.querySelectorAll('.bcard.proj')] : [];
  if ((!el.__divParked || (projCards.length && !el.__projParked)) && !el.hidden && el.clientWidth) {
    const sep = typeof el.querySelector === 'function' ? el.querySelector('.flowsep') : null;
    if (sep && typeof sep.getBoundingClientRect === 'function' && typeof el.getBoundingClientRect === 'function'
        && typeof el.scrollTo === 'function') {
      const sepR = sep.getBoundingClientRect();
      const elR = el.getBoundingClientRect();
      const lead = Math.max(12, Math.round(el.clientWidth * 0.28));
      let target = (el.scrollLeft ?? 0) + (sepR.left - elR.left) - lead;
      // the nearest projected card that still leaves the block being built and the divider
      // on screen: +2 if +2, +1, the block being built and the divider fit, else +1, else
      // the divider rule (an earlier cut anchored +2 whatever the width, and a narrow
      // Overview opened on forecasts with the block being built off the right edge)
      for (const anchor of [projCards[projCards.length - 2], projCards[projCards.length - 1]]) {
        if (!anchor || typeof anchor.getBoundingClientRect !== 'function') continue;
        const aR = anchor.getBoundingClientRect();
        if (sepR.left + 40 - aR.left <= el.clientWidth) { target = (el.scrollLeft ?? 0) + (aR.left - elR.left) - 12; break; }
      }
      el.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
      el.__divParked = true;
      if (projCards.length) el.__projParked = true;
    }
  }
}

/**
 * A block that nobody is assembling yet.
 *
 * `getblocktemplate` reports ONE candidate at a time, so anything beyond tip+1 is
 * inference. Those cards say so in their own border and text rather than being drawn like
 * the real one: an estimate that looks like a measurement is the same category of error
 * as a number that was never measured. What can honestly be shown is how much of the
 * queue is expected to reach that far, from getmempoolinfo.bytes.
 */
// The link between two blocks in the train. It is a picture of the thing the cards
// are actually describing -- each block commits to the one before it -- and it is
// markup rather than a ::before so the row's flex gaps stay predictable.
const LINK = '<span class="chainlink" aria-hidden="true"><i></i><i></i></span>';

/*
 * THE FORECAST SLIVERS ARE GONE (2026-09-11, operator: "too much space is
 * wasted on the left side ... empty forecasts that never have activity").
 *
 * `economy.ahead` reports a fixed set of offsets beyond tip+1 with a byte
 * estimate for each, and the row drew one dashed card per offset. They opened
 * the train, so the left third of the panel was permanently inference -- and
 * inference that says nothing new: every one of them is a restatement of the
 * queue depth, which the assembled block's own card already gives as
 * "queue ~ N blocks deep", measured, in one line, from the same figure.
 *
 * Filtering them to the ones with bytes behind them was tried first and did
 * nothing: a live mempool always has bytes reaching three blocks out, so all
 * three cards stayed. The honest reading is that they were never carrying
 * their width. The number they were built on is still on the page.
 */

/*
 * PROJECTED BLOCKS (operator, 2026-09-11: "Why can't we forecast at least one block ahead of
 * current work, like mempool space app does?"). Not the slivers above, which were a byte
 * estimate per fixed offset and read "nothing queued" on a quiet chain: these are the mempool
 * itself (projectBlocks, server side) -- sorted by feerate, the block being built skipped, the
 * next ones cut at 1,000,000 vB, each with its fee range, median, fees and count, and an ETA
 * from the measured average gap. Furthest future on the far left, as on mempool.space; the
 * card being built stays against the divider. Drawn as inference: dashed, no depth. A child
 * paying for its parent can be projected a block late (no ancestor data in this node's pool).
 */
function projectedCards(proj, { avgGapSec, tipAgeSec } = {}, fmt) {
  if (!proj?.blocks?.length) return '';
  const gap = Number.isFinite(avgGapSec) && avgGapSec > 0 ? avgGapSec : 600;
  const since = Number.isFinite(tipAgeSec) && tipAgeSec > 0 ? tipAgeSec : 0;
  const eta = (k) => Math.max(1, Math.round(((k + 1) * gap - since) / 60));
  const r = (v) => (v == null ? '–' : v >= 10 ? String(Math.round(v)) : v.toFixed(2));
  // READABLE (operator, 2026-09-11: "The forecast block text is unreadable. Do better !!!"):
  // light text on a dark card, the fee colour as a bar and a band, one fact per line and no
  // line wrapping -- the first cut put grey 10.5 px text on a saturated fill
  const card = (b, k) => `<div class="bcard proj" data-pfee="${Number(b.medianRate ?? 0)}" title="projected from the mempool by feerate: ${fmt.num(b.n)} transactions, ${fmt.bytes(b.vsize)}">
      <div class="ph">+${k}</div>
      <div class="pm">~${r(b.medianRate)} sat/vB</div>
      <div class="pr">${r(b.minRate)} – ${r(b.maxRate)}</div>
      <div class="pf">${(b.feeSat / 1e8).toFixed(3)} ₿</div>
      <div class="pf">${fmt.num(b.n)} tx</div>
      <div class="pe">in ~${eta(k)} min</div>
    </div>`;
  const cards = proj.blocks.map((b, i) => card(b, i + 1));
  if (proj.rest?.n) {
    const k = proj.blocks.length + 1;
    cards.push(`<div class="bcard proj rest" data-pfee="${Number(proj.rest.maxRate ?? 0)}" title="the rest of the mempool, beyond the projected blocks">
      <div class="ph">+${k}…</div>
      <div class="pm">≤ ${r(proj.rest.maxRate)} sat/vB</div>
      <div class="pf">${fmt.num(proj.rest.n)} tx</div>
      <div class="pe">≈ ${fmt.num(proj.rest.blocks)} more block${proj.rest.blocks === 1 ? '' : 's'}</div>
    </div>`);
  }
  return cards.reverse().join('');
}

/** Ancestor packages: what the miner grouped, and who is paying for whom. */
export function packagesView(el, packages, fmt) {
  if (!el) return;
  if (!packages) {
    el.innerHTML = `<div class="note">No packages yet — this needs a block template, which the page asks for only while it is open.</div>`;
    return;
  }
  if (!packages.multiTx) {
    el.innerHTML = `<div class="note">Every one of the <b>${packages.total}</b> transactions the node would include is on its own — no child paying for a parent in this template. That is a real reading, not a missing chart.</div>`;
    return;
  }
  const hist = Object.entries(packages.sizeHistogram ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  const maxN = Math.max(...hist.map(([, n]) => n), 1);
  el.innerHTML = `
    <div class="pkghist">${hist.map(([size, n]) => `<div class="pkbar" title="${n} package(s) of ${size} tx"><span data-w="${(100 * n / maxN).toFixed(1)}"></span><i>${size} tx</i><b>${n}</b></div>`).join('')}</div>
    <table class="t pkgtable"><thead><tr><th>package</th><th class="r">fees</th><th class="r">weight</th><th class="r">package sat/vB</th><th class="r">child</th><th class="r">parent</th><th>shape</th></tr></thead><tbody>
    ${(packages.top ?? []).map((p) => `<tr class="${p.cpfp ? 'cpfp' : ''}">
        <td>${p.size} tx</td>
        <td class="r">${fmt.num(p.feesSat)} sat</td>
        <td class="r">${fmt.num(p.weight)} WU</td>
        <td class="r"><b>${p.packageFeeRate ?? '–'}</b></td>
        <td class="r">${p.childRate ?? '–'}</td>
        <td class="r">${p.parentRate ?? '–'}</td>
        <td class="pkshape" title="${fmt.esc((p.txids ?? []).join(' '))}">${rateBoxes(p)}</td>
      </tr>`).join('')}
    </tbody></table>
    <div class="note tiny faint">${packages.txsInPackages} of the template's transactions sit inside a package; ${packages.cpfpCandidates} packages have a child paying at least twice its parent's rate — that is the child-pays-for-parent shape. The ancestor graph comes from <span class="mono">getblocktemplate … depends</span>, which is the graph this node publishes; <span class="mono">getrawmempool</span> on this build carries no <span class="mono">depends</span> or <span class="mono">ancestorcount</span>, so this is the block under construction, not the whole pool.</div>`;
}

/** A tiny picture of a package: box size = weight, colour = that transaction's own rate. */
function rateBoxes(p) {
  const rates = [p.childRate, p.parentRate].filter((v) => v != null);
  if (!rates.length) return '–';
  const top = Math.max(...rates, 1);
  return rates.map((r) => `<span class="pkgbox" data-rate="${r}" title="${r} sat/vB"></span>`).join('');
}

export function poolIndex(key) {
  const k = String(key ?? '');
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
  return Math.abs(h) % POOL_COLOURS.length;
}

/**
 * Resolve `data-pool` / `data-pool-fg` / `data-rate` / `data-delay` / `data-rail`
 * through the CSSOM.
 *
 * CSP `style-src 'self'` refuses `style="..."` inside injected markup, and the fix is
 * not to widen the policy: the markup carries an INDEX into our own palette, and the
 * colour string never comes from the payload at all. A node that invented a pool name
 * therefore cannot become CSS, and a name we do know still cannot inject markup.
 */
/**
 * data-w / data-h -> CSSOM width/height, for the markup this module writes.
 *
 * app.js owns the same helper for the sync hero. It is not imported: app.js runs boot()
 * at module scope, so importing it from here dragged a browser-only startup path into
 * every Node test that touches mining.js (window is not defined). Duplicated on purpose,
 * numbers-only for the same reason, and small enough that the two cannot drift far.
 */
function applySizes(root) {
  const q = (sel) => { try { return root.querySelectorAll(sel) ?? []; } catch { return []; } };
  const pct = (n) => `${Math.max(0, Math.min(100, n))}%`;
  for (const el of q('[data-w]')) {
    const n = Number(el.dataset.w);
    if (Number.isFinite(n)) { try { el.style.width = pct(n); } catch { /* no CSSOM in the stub */ } }
  }
  for (const el of q('[data-h]')) {
    const n = Number(el.dataset.h);
    if (Number.isFinite(n)) { try { el.style.height = pct(n); } catch { /* no CSSOM in the stub */ } }
  }
}

export function applyMiningStyles(root = document) {
  // data-w / data-h land on the CSSOM in app.js; the flow and the maps are written here,
  // so the size pass has to be invoked on this markup too. It used to run only on the
  // sync hero, so every weight bar in the block train stayed at its default and the
  // cards looked identically empty whatever the node had mined.
  const q = (sel) => { try { return root.querySelectorAll(sel) ?? []; } catch { return []; } };
  // Custom properties must go through setProperty: `el.style['--pool'] = …` is accepted
  // without complaint and does nothing, which is how the block cards lost their pool rail
  // while the dots beside them kept theirs -- a half-applied style pass that only a real
  // browser shows you, because nothing throws.
  const set = (el, prop, val) => {
    try {
      if (prop.startsWith('--')) el.style.setProperty(prop, val);
      else el.style[prop] = val;
    } catch { /* a stub without a CSSOM has nothing to set */ }
  };
  for (const el of q('[data-pool]')) {
    const n = Number(el.dataset.pool);
    if (!Number.isFinite(n) || n < 0) continue;
    const c = POOL_COLOURS[n % POOL_COLOURS.length];
    // A card carries its pool as a rail and an accent; only the small marks (dot,
    // fill bar) get filled with the colour itself. Painting a whole card in the pool
    // colour would turn the legend into a patchwork quilt and hide its own text.
    if (!el.classList.contains('bcard')) set(el, 'background', c);
    set(el, '--pool', c);
  }
  // a projected block is tinted by its median feerate: a NUMBER in the markup (the CSP
  // allows no style attributes), the colour from our own fee palette here. Its own
  // attribute: [data-fee] is the fee swatches', whose pass paints the whole background
  // inline -- which is what filled the first projected cards solid green
  for (const el of q('[data-pfee]')) {
    const n = Number(el.dataset.pfee);
    if (Number.isFinite(n) && n >= 0) set(el, '--pc', feeColor(n));
  }
  for (const el of q('[data-pool-key]')) {
    const c = POOL_COLOURS[poolIndex(el.dataset.poolKey) % POOL_COLOURS.length];
    set(el, 'background', c); set(el, '--pool', c);
  }
  for (const el of q('[data-pool-fg]')) {
    const n = Number(el.dataset.poolFg);
    if (Number.isFinite(n) && n >= 0) set(el, 'color', POOL_COLOURS[n % POOL_COLOURS.length]);
  }
  for (const el of q('[data-rate]')) {
    const r = Number(el.dataset.rate);
    if (Number.isFinite(r)) set(el, 'background', rateBucketColor(r));
  }
  // our feerate palette (feepalette.js), so the block meter and the Block space stones agree
  for (const el of q('[data-fee]')) {
    const r = Number(el.dataset.fee);
    if (Number.isFinite(r)) set(el, 'background', feeColor(r));
  }
  // A NEGATIVE delay: the animation resumes at the phase it would have reached,
  // so a loop survives the once-a-second innerHTML repaint without restarting.
  for (const el of q('[data-phase]')) {
    const d = Number(el.dataset.phase);
    if (Number.isFinite(d)) set(el, 'animationDelay', `-${Math.min(10, Math.max(0, d))}s`);
  }
  for (const el of q('[data-delay]')) {
    const d = Number(el.dataset.delay);
    if (Number.isFinite(d)) set(el, 'animationDelay', `${Math.min(3, Math.max(0, d))}s`);
  }
  for (const el of q('[data-rail]')) {
    const d = Number(el.dataset.rail);
    if (Number.isFinite(d)) set(el, 'animationDuration', `${Math.min(240, Math.max(12, d))}s`);
  }
  applySizes(root);
  return root;
}

function rateColor(r, top) {
  const t = Math.min(1, r / top);
  return t > 0.66 ? COL.ok : t > 0.33 ? COL.warn : COL.bad;
}

/** Feerate landscape of the block being built: 1,496 transactions, 15 buckets. */
export function feeLandscape(canvas, nb, fmt) {
  const h = nb?.feeRateHistogram ?? [];
  paint(canvas, {
    when: h.some((b) => b.n > 0),
    placeholder: nb?.unavailable ? `no template: ${nb.unavailable}` : 'no block template requested yet',
    draw: (c) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth || 600; const hh = c.clientHeight || 140;
      c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr);
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hh);
      const max = Math.max(...h.map((b) => b.n), 1);
      const bw = w / h.length;
      ctx.font = '9px ui-monospace, monospace'; ctx.textBaseline = 'middle';
      h.forEach((b, i) => {
        const bh = Math.max(1, (b.n / max) * (hh - 30));
        const x = i * bw + 2;
        ctx.fillStyle = rateColor(b.hi, 20);
        ctx.fillRect(x, hh - 18 - bh, bw - 4, bh);
        ctx.fillStyle = COL.text; ctx.textAlign = 'center';
        ctx.fillText(`${b.hi}`, x + (bw - 4) / 2, hh - 9);
        if (b.n) { ctx.fillStyle = COL.textDim; ctx.fillText(`${b.n}`, x + (bw - 4) / 2, hh - 22 - bh); }
      });
      ctx.textAlign = 'left'; ctx.fillStyle = COL.textDim;
      ctx.fillText('sat/vB →', 2, 8);
      c.__hasData = true;
    },
  });
}

export const flowArgs = (s, state) => ({
  tipHeight: s?.tip?.height ?? null,
  recent: s?.attribution?.recent ?? [],
  next: s?.attribution?.nextBlock ?? null,
  mempool: s?.mempool,
  avgGapSec: s?.avgBlockGapSec ?? null,
  tipAgeSec: s?.tip?.ageSec ?? null,
  ibd: s?.ibd === true || s?.sync?.state === 'ibd',
  online: s?.online !== false,
  paused: !!state?.paused,
});

export function renderMiningOverview(s, state, h) {
  const a = s?.attribution;
  // The same map as the Mining page, same data, same rules -- a smaller copy must
  // not quietly become a different claim. The box used to break that promise: a
  // fixed w4/168px square gave a 34%-full block an 84px band of transactions in a
  // dead square (measured 2026-09-10). The card is now w8 and the canvas's height
  // follows the FILL, from the template's own weightPct — the width always carries
  // the whole block, so the canvas is width x (width x fill) with a 240px floor
  // that keeps an empty block's hatch legible. The box still IS the block; it is
  // just no longer a square that hides how empty the block is.
  const nbOv = a?.nextBlock ?? null;
  h.mempoolDetail?.();   // the overview draws the same pool viewer, so it needs the same data
  const ovCanvas = h.canvas('ovGnTreemap');
  // No inline height any more. It used to scale the canvas by the template's
  // fill, which fought the square card and left the canvas ZERO-SIZED whenever
  // there was no template yet (the browser check read zeroSized). The card and
  // its wrapper are square in CSS; the canvas fills them.
  if (ovCanvas?.style?.height) ovCanvas.style.height = '';
  drawPoolViewer(ovCanvas, s, state);
  const ovNote = document.getElementById('ovGnTreemapNote');
  if (ovNote) {
    const v = nbOv?.visual;
    ovNote.textContent = v?.cells?.length
      ? `${fmtNum(v.cells.length, h)} selected transactions, ${fmtNum(v.totalVbytes, h)} vB`
      : (nbOv?.unavailable ?? 'no block template yet');
  }
  h.nextBlock?.();
  blockFlow(document.getElementById('ovTrain'), flowArgs(s, state), h.fmt);
  poolTable(document.getElementById('ovMiningPools'), a, h.fmt);
  applyMiningStyles(document);
}

// --------------------------------------------------------------- block space page
//
// The viewer at full size, with the block being built and the chain tip in the
// same panel (operator, 2026-09-11). The viewer is drawPoolViewer -- the SAME
// call Overview and Mining make, per the "one viewer, identical everywhere" ask --
// and the two side panels are built from the same readings the flow cards use.

/** The block being built, as the side panel shows it. Pure: markup from readings. */
export function nextHud(nb, { meter = '', fresh = null, mempool = null } = {}, fmt) {
  const head = (k) => `<div class="hudh"><span class="live"></span><b>Being built</b>${k}</div>`;
  if (!nb) return `${head('')}<div class="note tiny">No block template yet. The page asks the node for one when it opens; answering costs the node about four seconds of its single RPC thread, so it is asked at most every 20 s.</div>`;
  if (nb.unavailable) return `${head('')}<div class="note tiny">No block template: ${fmt.esc(nb.unavailable)}</div>`;
  const cap = Number(nb.weightLimit) || WU_CAP_FALLBACK;
  const pct = Number.isFinite(nb.weightPct) ? nb.weightPct : 100 * (Number(nb.weight) || 0) / cap;
  const lvl = fresh && fresh.level !== 'n/a' ? fresh.level : '';
  const mins = fresh && Number.isFinite(fresh.seconds) ? Math.floor(fresh.seconds / 60) : null;
  const ageSec = nb.at ? Math.max(0, Math.round((Date.now() - nb.at) / 1000)) : null;
  const ec = nb.economy ?? null;
  const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  return `${head(`<span class="hudk">#${nb.height ?? '?'}</span><span class="hudclock ${lvl}" title="time since the last block: how long this block has been accumulating${fresh?.basis === 'block time' ? ' (from the block timestamp)' : ''}">${mins != null ? `${mins}m` : '–'}</span>`)}
    ${meter}
    <div class="hudbig">${pct.toFixed(1)}<small>% full</small>${ec?.marginal?.rate != null ? `<span class="chip hot">marginal ~${ec.marginal.rate}/vB</span>` : '<span class="chip">not full</span>'}</div>
    <dl class="hudkv">
      ${kv('transactions', nb.txCount != null ? fmt.num(nb.txCount) : '–')}
      ${kv('fees', btc(nb.totalFeesSat))}
      ${kv('weight', `${fmt.num(nb.weight)} / ${fmt.num(cap)}`)}
      ${kv('sat/vB', `${nb.feeRate?.p50 ?? '–'} med · ${nb.feeRate?.max ?? '–'} max`)}
      ${mempool?.bytes != null ? kv('queued', fmt.bytes(mempool.bytes)) : ''}
      ${ec?.backlogBlocks != null ? kv('queue depth', `≈ ${ec.backlogBlocks} blocks`) : ''}
      ${kv('template', `${ageSec != null ? `${ageSec}s old` : '–'} · ${nb.ms ?? '?'} ms to answer`)}
    </dl>`;
}

/** The chain tip, as the side panel shows it. Pure. */
export function tipHud(tipHeight, row, prev, { avgGapSec = null, now = Date.now() } = {}, fmt) {
  const head = `<div class="hudh"><b>Chain tip</b><span class="hudk">${Number.isFinite(tipHeight) ? `#${tipHeight}` : '–'}</span></div>`;
  if (!Number.isFinite(tipHeight)) return `${head}<div class="note tiny">No tip reading yet.</div>`;
  const avg = Number.isFinite(avgGapSec) && avgGapSec > 0 ? `${(avgGapSec / 60).toFixed(1)} min` : '–';
  if (!row) return `${head}<div class="note tiny">This height's coinbase has not been read yet: attribution runs one block per poll, so it trails the tip.</div><dl class="hudkv"><dt>average gap</dt><dd>${avg}</dd></dl>`;
  const w = who(row);
  const f = blockFacts(row);
  const gap = prev?.time && row.time ? row.time - prev.time : null;
  const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  return `${head}
    <div class="hudpool"><span class="bdot" data-pool="${w.idx}"></span><b data-pool-fg="${w.idx}">${fmt.esc(trunc(w.name, 22))}</b><span class="faint">${agoText(row.at ?? row.seenAt, now) ? `mined ${agoText(row.at ?? row.seenAt, now)}` : ''}</span></div>
    <div class="hudbar" title="${f.capPct != null ? `${f.capPct.toFixed(1)}% of the 4,000,000 WU cap` : 'weight unknown'}"><span data-w="${f.capPct == null ? 0 : f.capPct.toFixed(1)}" data-pool="${w.idx}"></span></div>
    <dl class="hudkv">
      ${kv('full', f.capPct != null ? `${f.capPct.toFixed(1)}%` : '–')}
      ${kv('size', f.fillVb != null ? fmt.bytes(f.fillVb, 0) : '–')}
      ${kv('transactions', row.txs != null ? fmt.num(row.txs) : '–')}
      ${kv('fees', row.totalfee != null ? btc(row.totalfee) : '–')}
      ${kv('sat/vB', `${row.avgFeerate ?? '–'} avg · ${row.p50 ?? '–'} p50`)}
      ${kv('gap before it', gap != null ? gapText(gap) : '–')}
      ${kv('average gap', avg)}
    </dl>`;
}

// the rates a reader actually meets; each swatch is the colour of the band that rate falls in
// from 0.1 sat/vB, where the palette starts and this chain's blocks spend most of their space
const LEGEND_RATES = [0, 0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500];
export function feeLegend() {
  return `<div class="hudh"><b>Feerate</b><span class="hudk">sat/vB</span></div>
    <div class="feelegend">${LEGEND_RATES.map((r) => `<span><i data-fee="${r}"></i>${r === 0 ? '&lt;0.1' : `${r}+`}</span>`).join('')}</div>
    <div class="note tiny faint">Our own feerate banding, the same colours as the stones.</div>`;
}

export function renderBlockSpace(s, state, h) {
  const a = s?.attribution;
  h.mempoolDetail?.();
  h.nextBlock?.();
  drawPoolViewer(h.canvas('spTreemap'), s, state);
  const nb = a?.nextBlock ?? null;
  const nextEl = document.getElementById('spNext');
  if (nextEl) {
    const same = nextEl.__meter && nb && nextEl.__meter.height === nb.height;
    const m = growthMeter(nb, same ? nextEl.__meter.lit : null);
    if (nb && !nb.unavailable) nextEl.__meter = { height: nb.height, lit: m.lit };
    const fresh = tipFreshness({
      ageSec: s?.tip?.ageSec ?? null, avgGapSec: s?.avgBlockGapSec ?? null,
      ibd: s?.ibd === true || s?.sync?.state === 'ibd', online: s?.online !== false, paused: !!state?.paused,
    });
    nextEl.innerHTML = nextHud(nb, { meter: m.html, fresh, mempool: s?.mempool }, h.fmt);
  }
  const tipEl = document.getElementById('spTip');
  if (tipEl) {
    const tipH = s?.tip?.height ?? null;
    const recent = a?.recent ?? [];
    const row = recent.find((r) => r.height === tipH) ?? null;
    const prev = recent.find((r) => r.height === tipH - 1) ?? null;
    tipEl.innerHTML = tipHud(tipH, row, prev, { avgGapSec: s?.avgBlockGapSec ?? null }, h.fmt);
  }
  const lg = document.getElementById('spLegend');
  if (lg && !lg.__drawn) { lg.innerHTML = feeLegend(); lg.__drawn = true; }
  const note = document.getElementById('spNote');
  if (note) {
    const mp = state?.mempoolDist ?? s?.mempool ?? {};
    const count = mp.count ?? s?.mempool?.count ?? null;
    note.textContent = (mp.cells ?? []).length
      ? `One block's worth (1,000,000 vB) of the ${count != null ? fmtNum(count, h) : '?'} transactions waiting, laid out richest first; hover a block for its transaction. Blocks lift off, travel and land when the pool changes; the pool is polled every 30 s and a change waits for the running animation to land.`
      : 'The mempool detail has not arrived yet: it is polled every 30 s while this page is open.';
  }
  applyMiningStyles(document);
}

export function renderMining(s, state, h) {
  const a = s?.attribution;
  // Ask on every paint of the page; the helper de-duplicates by age and the server by
  // in-flight call, so this cannot turn into a polling storm with several tabs open.
  h.nextBlock?.();
  blockFlow(document.getElementById('mnFlow'), flowArgs(s, state), h.fmt);
  packagesView(document.getElementById('mnPackages'), a?.nextBlock?.packages, h.fmt);
  const nb = a?.nextBlock ?? null;
  h.mempoolDetail?.();
  const mp = state?.mempoolDist ?? s?.mempool ?? {};
  drawPoolViewer(h.canvas('gnMempoolTreemap'), s, state);
  const mnote = document.getElementById('gnMempoolNote');
  if (mnote) {
    const cells = mp.cells ?? [];
    const tail = cells.find((c) => c.aggregate) ?? null;
    const total = mp.totalVsize ?? 0;
    const drawn = cells.length - (tail ? 1 : 0);
    if (cells.length) {
      const parts = [`${fmtNum(drawn, h)} drawn`];
      if (tail) parts.push(`+ 1 aggregate of ${fmtNum(tail.aggregate, h)} smaller ones`);
      if (mp.cellCount != null) parts.push(`= ${fmtNum(mp.cellCount, h)} transactions as at the poll`);
      if (mp.fetchedAt != null) parts.push(`${Math.round((Date.now() - mp.fetchedAt) / 1000)}s ago`);
      const fits = total <= 1_000_000
        ? '<b>everything waiting fits in a single block</b>'
        : 'the line sits where one block runs out and everything right of it waits';
      mnote.innerHTML = `${parts.join(', ')}; ${fmtNum(total, h)} vB waiting. One block is 1,000,000 vB, so ${fits}.`
        + ' Ordered by feerate, because that is the order a miner takes them; colour is what each transaction pays.'
        + (mp.stale ? ' <span class="warn">Last poll failed; this picture may be old.</span>' : '');
    } else if (mp.stale) {
      mnote.innerHTML = '<span class="warn">Detail stale</span> — the last poll of the full pool failed. Anything drawn above is the previous reading.';
    } else if (mp.count != null && mp.count > 0) {
      mnote.innerHTML = `<span class="warn">Cells not loaded yet</span> — ${fmtNum(mp.count, h)} transactions are waiting; the full pool is polled on the 20 s tier and this page has not received it.`;
    } else if (mp.count === 0) {
      mnote.textContent = 'The mempool is empty: nothing is waiting, so there is nothing to draw.';
    } else {
      mnote.textContent = 'Nothing to draw yet — the full pool is polled on the 20 s tier, not every second.';
    }
  }
  feeLandscape(h.canvas('mnFeeLandscape'), a?.nextBlock ?? null, h.fmt);
  poolTable(document.getElementById('mnPools'), a, h.fmt);
  const el = document.getElementById('mnCoverage');
  if (el) el.innerHTML = coveragePanel(a, h);
  applyMiningStyles(document);
}

function coveragePanel(a, h) {
  const esc = h.fmt.esc;
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  if (!a) return `<dl class="kv">${row('attribution', '<span class="warn">not in this snapshot yet</span>')}</dl>`;
  const nb = a.nextBlock;
  return `<dl class="kv">
    ${row('blocks attributed', a.windowBlocks ?? 0)}
    ${row('window', a.windowHeights ? `#${a.windowHeights.from} – #${a.windowHeights.to}` : '–')}
    ${row('curated labels matched', `${(a.recent ?? []).filter((r) => r.poolLabel).length} of ${(a.recent ?? []).length}`)}
    ${row('skipped during IBD', a.skippedIbd ? `${a.skippedIbd} heights` : 'none')}
    ${row('label source', a.labelSource
      ? `<span class="mono">${esc((a.labelSource.sha256 ?? '').slice(0, 10))}</span> fetched ${esc((a.labelSource.fetchedAt ?? '').slice(0, 10))}`
      : '<span class="warn">none — run node scripts/pool-map.js</span>')}
    ${row('block in progress', nb && !nb.unavailable
      ? `#${nb.height ?? '?'} · ${(nb.weightPct ?? 0).toFixed(1)}% full · ${nb.txCount ?? '?'} txs${nb.ageMs != null ? '' : ''}`
      : `<span class="warn">${esc(nb?.unavailable ?? 'not requested yet — this page asks while it is visible')}</span>`)}
    ${nb?.ms != null ? row('template cost', `${nb.ms} ms for the node to answer, once per view refresh`) : ''}
    ${a.lastError ? row('last error', `<span class="bad">${esc(a.lastError)}</span>`) : ''}
  </dl>`;
}

/** The pool table. Kept here because it shares the colour scale with the flow cards. */
export function poolTable(el, a, fmt) {
  if (!el) return;
  const rows = a?.byPool ?? [];
  if (!rows.length) {
    el.innerHTML = `<div class="note">No blocks attributed yet. Attribution is two small reads per block on the node's own RPC lane, skipped entirely during initial download${a?.skippedIbd ? ` — ${a.skippedIbd} heights skipped so far` : ''}.</div>`;
    return;
  }
  const w = a.windowHeights;
  el.innerHTML = `<table class="t"><thead><tr><th>pool</th><th class="r">blocks</th><th class="r">share</th><th class="r">median sat/vB</th><th class="r">avg weight</th><th>coinbase tags seen</th></tr></thead><tbody>`
    + rows.map((p) => `<tr>
        <td><span class="bdot" data-pool-key="${p.poolKey ?? p.poolLabel ?? ''}"></span>
            ${p.labelled || p.label ? fmt.esc(p.label ?? p.name) : `<span class="muted">${fmt.esc(p.poolKey)}</span> <span class="warn">unlabelled</span>`}</td>
        <td class="r">${p.blocks}</td>
        <td class="r">${p.sharePct != null ? `${p.sharePct}%` : '–'}</td>
        <td class="r">${p.medianFeeRate ?? '–'}</td>
        <td class="r">${p.avgWeight != null ? fmt.num(p.avgWeight) : '–'}</td>
        <td class="mono muted" title="${fmt.esc((p.tags ?? []).join(' | '))}">${fmt.esc((p.tags ?? [])[0] ?? '–')}</td>
      </tr>`).join('')
    + `</tbody></table>
    <div class="note tiny faint">${rows.reduce((n, p) => n + p.blocks, 0)} blocks between #${w?.from ?? '?'} and #${w?.to ?? '?'}; shares are of that window only. ${a.labelSource
      ? `Labels: ${fmt.esc(a.labelSource.source)} @ <span class="mono">${fmt.esc((a.labelSource.sha256 ?? '').slice(0, 10))}</span>, fetched ${fmt.esc((a.labelSource.fetchedAt ?? '').slice(0, 10) ?? '?')}. An unlabelled row is a coinbase the curated map does not know.`
      : 'No label map loaded — run <span class="mono">node scripts/pool-map.js</span>; until then only the raw coinbase text is shown.'}</div>`;
}

export { poolColor };
