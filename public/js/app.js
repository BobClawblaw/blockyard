// App core: session, SSE link, routing, the sync hero, and the Overview page.
// Chart pages live in panels.js.
// histogram/scatter/meter/stackedBars are named below in the `helpers.charts`
// object, which is module scope: an identifier that is referenced there but not
// imported throws while app.js is still evaluating -- before login, before the
// stream, before a single pixel. The page then shows nothing at all and the server
// log shows nothing either, because no request was ever made. Import them.
import { lineChart, histogram, scatter, meter, stackedBars, sparkline, paint, resetCanvas, COL } from './charts.js';
import * as F from './fmt.js';
import { renderMiningOverview, renderMining, renderBlockSpace, refreshLabel } from './mining.js';
import { viewerIdle } from './details3d.js';
import {
  loadSettings, setSetting, resetSettings, seedSettings, setSettingsPush,
  SETTINGS_KEY, PANEL as SETTINGS_PANEL, formatRangeValue,
} from './settings.js';
import { renderExplorer } from './explorer.js';
import { renderMarkets, summaryHtml as marketsSummaryHtml, REFRESH_MS as MARKETS_REFRESH_MS } from './markets.js';
import { renderKiosk } from './kiosk.js';
import { renderTetrust } from './tetrust.js';
import { renderBlockout } from './blockout.js';
import { renderBlockanoid } from './blockanoid.js';
import { renderDoom } from './doom.js';
import { renderAbout } from './about.js';
import { renderChain, renderMempool, renderPeers, renderNetwork, renderLogs, renderNode, renderAdmin, ensureLogsLoaded, init as initPanels, initChainDrill } from './panels.js';

// panels.js needs the formatters but must not import them from here (circular);
// they are injected once at module start instead.
initPanels(F);

export const state = {
  snap: null,
  // the Block space viewer's mode (mining.js VIEWER_MODES), remembered per browser
  viewerMode: (() => { try { return globalThis.localStorage?.getItem('blockyard.viewerMode') === '2' ? '2' : '1'; } catch { return '1'; } })(),
  denseBlock: null,
  series: null,
  events: [],
  // Liveness bookkeeping for the stream. Without these a dropped SSE leaves the page
  // looking exactly like a healthy one: frozen numbers, a badge stuck on
  // "reconnecting", and not a single line in any log.
  lastFrameAt: Date.now(),
  startedAt: Date.now(),
  streamFails: 0,
  user: null,
  // Whether the server has accounts at all. Default true so nothing flashes "open
  // access" before /api/me answers; boot() sets it from the server's own report.
  accounts: true,
  caps: null,
  cfg: null,
  nodes: [],
  node: null,
  page: 'overview',
  paused: false,
  pausedHard: false,
  seenSeq: 0,
  charts: {},
  // Per-node cache. Two reasons, both about honesty: switching nodes must never
  // leave the previous node's chart on screen, and a transient gap in the stream
  // must never blank a chart that already has data for the node you are looking
  // at. So data is kept per node, canvases are wiped only on a node switch, and
  // sampling happens in the background.
  byNode: new Map(),
  heroForced: false,
};

const nodeRec = (id) => {
  if (!id) return {};
  if (!state.byNode.has(id)) state.byNode.set(id, {});
  return state.byNode.get(id);
};

/** Every chart canvas currently in the document. */
const allCanvases = () => [...document.querySelectorAll('canvas.chart')];

/**
 * Write data-driven sizes through the CSSOM.
 *
 * CSP `style-src 'self'` refuses `style="width:42%"` inside injected HTML, which is
 * why this app spent a while with a `style-src-attr 'unsafe-inline'` allowance -- an
 * allowance that also permitted any injected markup to style itself however it
 * liked. The narrow fix is not to widen the policy: markup now carries
 * `data-w` / `data-left` / `data-h`, and the value lands on `el.style.width` here,
 * which CSP permits because it is not parsed markup. A string that never reaches an
 * HTML attribute cannot be an injection site.
 *
 * Numbers only. Anything that will not parse as a number is skipped and left at the
 * class default, so a malformed figure degrades to "no bar" rather than to "the
 * first string the node printed became CSS".
 */
export function applyDataSizes(root = document) {
  const set = (sel, prop, transform) => {
    let nodes = [];
    try { nodes = root.querySelectorAll(sel); } catch { return; } // the DOM stub answers nothing
    for (const el of nodes ?? []) {
      const raw = el.dataset?.[attrOf(sel)];
      if (raw == null || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      const v = transform(Math.max(0, Math.min(100, n)));
      try { el.style[prop] = v; } catch { /* a stub without a CSSOM has nothing to set */ }
    }
  };
  set('[data-w]', 'width', (n) => `${n}%`);
  set('[data-left]', 'left', (n) => `${n}%`);
  set('[data-h]', 'height', (n) => `${n}%`);
  return root;
}

const attrOf = (sel) => ({ '[data-w]': 'w', '[data-left]': 'left', '[data-h]': 'h' }[sel] ?? 'w');

/**
 * Wipe every chart. Called ONLY when the selected node changes: the pixels on
 * screen belong to a different daemon, and leaving them up while the header
 * names another node would be a straight lie.
 */
function resetAllCharts() {
  for (const c of allCanvases()) resetCanvas(c);
}

// ------------------------------------------------------------------ api

const csrf = () => {
  const m = /(?:^|;\s*)blockyard_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
};

async function api(path, { method = 'GET', body } = {}) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.headers['X-CSRF-Token'] = csrf() ?? '';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(path, opt);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('signed out');
  }
  let data = null;
  try { data = await res.json(); } catch { data = { error: { message: `HTTP ${res.status}` } }; }
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const box = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, kind === 'bad' ? 6500 : 3200);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3700);
}

// ------------------------------------------------------------- sync hero

const STATE_BADGE = {
  synced: ['ok', 'Synced'], ibd: ['sync', 'Initial block download'],
  catching_up: ['sync', 'Catching up'], stalled: ['bad', 'Stalled'],
  reorg: ['warn', 'Reorganising'], unknown: ['muted', 'Unknown'],
};

/**
 * The sync viewer. One bar, two figures, never merged:
 *  - the fill is blocks held over announced headers (this node is headers-first,
 *    so it only reaches 100% when the last block has landed);
 *  - the blue tick is the node's own difficulty-weighted estimate.
 * ETA carries the rate it was computed from and whether that rate is falling,
 * because a decelerating sync's ETA is a number that is about to be wrong.
 */
/**
 * The sync viewer: one dense instrument row plus a hairline bar, for every state.
 *
 * It used to swap to a ~10-row hero whenever a sync was running, which pushed the
 * charts off screen at exactly the moment you want to see them, and spent ten
 * rows saying "100%" when nothing was running. Both cases now render the same row
 * of the node's own figures; `detail` expands the long-form explanation on demand.
 *
 * The node is named inside the row. "Synced" without saying which daemon is how a
 * monitor looks wrong while telling the truth about a different one.
 */
export function renderSyncHero(box, s) {
  if (!box) return;
  const sync = s?.sync ?? {};
  const [tone, label] = STATE_BADGE[sync.state] ?? STATE_BADGE.unknown;
  const moving = sync.state === 'ibd' || sync.state === 'catching_up';
  const pct = sync.pct;
  const width = pct == null ? 0 : Math.max(0.4, Math.min(100, pct));
  const vp = sync.verificationProgress;
  const done = sync.state === 'synced';
  const fillCls = sync.state === 'stalled' || sync.state === 'reorg' ? 'stall' : done ? 'done' : '';
  const others = (state.nodes ?? []).filter((n) => n.syncing && n.id !== (sync.node ?? state.node));
  const caveats = sync.caveats ?? [];

  const facts = (sync.strip ?? []).map((f) => `<span class="sf${f.tone ? ` ${F.esc(f.tone)}` : ''}"${f.title ? ` title="${F.esc(f.title)}"` : ''}><i>${F.esc(f.label)}</i><b>${F.esc(f.value)}</b></span>`).join('');
  // Two figures, never merged: the fill is blocks held over announced headers,
  // the marker is the node's own difficulty-weighted estimate.
  const pctTitle = `blocks held ÷ announced headers. The marker on the bar is the node's own estimate (${vp == null ? 'not reported' : vp.toFixed(3) + '%'}), kept separate because the two measure different things.`;

  box.className = 'sync';
  box.innerHTML = `
    <div class="strip">
      <span class="badge ${tone} ${moving ? 'pulse' : ''}"><span class="dot"></span>${F.esc(label)}</span>
      <span class="sf node" title="${F.esc(sync.endpoint ?? '')}"><b>${F.esc(sync.nodeLabel ?? s?.label ?? 'node')}</b></span>
      <span class="sf pct-big ${done ? 'ok' : 'accent'}" title="${F.esc(pctTitle)}"><b>${pct == null ? '–' : pct.toFixed(pct >= 99.995 ? 4 : 2)}%</b></span>
      ${facts}
      ${others.length ? others.map((n) => `<button class="sf jump" data-jump-node="${F.esc(n.id)}" title="Switch to this node"><i>also syncing</i><b>${F.esc(n.label)} ${n.pct == null ? '…' : n.pct.toFixed(0) + '%'}</b></button>`).join('') : ''}
      <span class="strip-tail">
        ${caveats.length ? `<span class="sf note-count ${caveats.some((c) => /LONGER|stall|backwards|hide the stall/.test(c)) ? 'bad' : 'warn'}" data-toggle-sync="1" title="${F.esc(caveats.join(' '))}"><i>${caveats.length} note${caveats.length > 1 ? 's' : ''}</i><b>show</b></span>` : ''}
        <button class="btn tiny-btn" data-toggle-hero="1" title="Show the full derivation, legend and notes">${state.heroForced ? 'compact' : 'detail'}</button>
      </span>
    </div>
    <div class="bar" role="progressbar" aria-valuenow="${pct ?? 0}" aria-valuemin="0" aria-valuemax="100" title="${F.esc(pctTitle)}">
      <div class="fill ${fillCls}" data-w="${width}"></div>
      ${vp != null && !done ? `<div class="vp-tick" data-left="${Math.min(100, vp)}"></div>` : ''}
    </div>
    ${state.heroForced ? expanded(s, sync, caveats) : ''}
    ${F.nodeWarnings(s?.warnings).length && !state.heroForced ? `<div class="caveat bad mt-6"><b>Node warnings:</b> ${F.esc(F.nodeWarnings(s.warnings).join('; '))}</div>` : ''}
  `;
  // The bar is drawn from data-w above; without this call the fill is 0 wide and
  // the strip reads as an empty bar on a node that is 96% synced.
  applyDataSizes(box);
}

/** The long-form view behind `detail`: derivation, legend, every caveat in full. */
function expanded(s, sync, caveats) {
  const ibd = s?.log?.ibd ?? {};
  const rows = [
    ['node', `${sync.nodeLabel ?? s?.label ?? '–'} @ ${sync.endpoint ?? '–'}`],
    ['chain / status', `${s?.chain ?? '–'} · ${sync.state ?? 'unknown'}`],
    ['height', sync.height == null ? '–' : F.num(sync.height)],
    ['announced headers', sync.headers == null ? 'not reported' : F.num(sync.headers)],
    ['behind', sync.behind == null ? '–' : F.num(sync.behind)],
    ['bar fill (blocks ÷ headers)', sync.pct == null ? 'not derivable' : `${sync.pct.toFixed(4)}%`],
    ['node estimate (verificationprogress)', sync.verificationProgress == null ? 'not reported' : `${sync.verificationProgress.toFixed(4)}%`],
    ['throughput', sync.blockRatePerSec == null ? 'measuring…' : `${sync.blockRatePerSec.toFixed(2)} blk/s (${(sync.blockRatePerSec * 60).toFixed(1)}/min)${sync.rateTrend && !['steady', 'unknown'].includes(sync.rateTrend) ? ` · ${sync.rateTrend}` : ''}`],
    ['rate windows', (sync.rateWindows ?? []).length ? sync.rateWindows.map((w) => `${w.blocksPerSec} blk/s over ${w.name}${w.spanSec ? ` (span ${w.spanSec}s)` : ''}`).join(' · ') : 'no window with enough history yet'],
    ['ETA', sync.eta ?? 'not available'],
    ['ETA basis', sync.etaBasis ?? '–'],
    ['ETA range', sync.etaWorst ? `${sync.etaBest} … ${sync.etaWorst} (node downloads in bursts)` : 'single window agrees'],
    ['tip age', sync.tipAgeSec == null ? '–' : F.ageSec(sync.tipAgeSec)],
    ['chain size', sync.sizeOnDisk == null ? '–' : F.bytes(sync.sizeOnDisk, 0)],
    ['utxos', sync.txouts == null ? '–' : F.num(sync.txouts)],
    ['peers', sync.peers == null ? '–' : F.num(sync.peers)],
    // ROWS ONLY WHERE THE FIGURE EXISTS (2026-09-14): these three are read from an experimental
    // node's log; Bitcoin Core prints none of them, and a row saying "not printed by this build"
    // was three lines of nothing on every Core install
    ...(ibd.nodeProgress == null ? [] : [['node\'s own progress ([dlc] ==)',
      `${ibd.nodeProgress.pct == null ? '–' : `${ibd.nodeProgress.pct}% stored`} · ${ibd.nodeProgress.stored ?? '–'}/${ibd.nodeProgress.total ?? '?'} blocks${ibd.nodeProgress.etaText ? ` · their own eta ${ibd.nodeProgress.etaText}` : ''}${ibd.nodeProgress.rateText ? ` · ${ibd.nodeProgress.rateText}` : ''}`]]),
    ...(ibd.nodeCatchup == null ? [] : [['applying thread ([utxo_live])',
      `${ibd.nodeCatchup.pct == null ? '–' : `${ibd.nodeCatchup.pct}%`} caught up${ibd.nodeCatchup.blocksPerSec != null ? ` at ${ibd.nodeCatchup.blocksPerSec} blk/s` : ''}${ibd.nodeCatchup.eta ? ` · their own eta ${ibd.nodeCatchup.eta}` : ''}`]]),
    ...(ibd.applyRate == null ? [] : [['apply rate ([dl] updating utxo)',
      `${ibd.applyRate.perSec ?? '–'} tx/s over ${ibd.applyRate.windowSec ?? '?'}s`]]),
    // Deliberately separate rows: three different threads reporting three
    // different rates is information, and averaging them would be a fabrication
    // (rules 4 and 9). They stay out of the strip for the same reason -- the <=60px
    // budget has no room for a fourth figure, so they live here with their labels.
    ['reorg events seen', String(s?.blocks?.reorgs ?? 0)],
  ];
  return `<div class="expanded">
    <dl class="kv">${rows.map(([k, v]) => `<dt>${F.esc(k)}</dt><dd>${F.esc(v)}</dd>`).join('')}</dl>
    ${(sync.reason && sync.state === 'unknown') ? `<div class="caveat bad mt-8"><b>Why this is unknown:</b> ${F.esc(sync.reason)}</div>` : ''}
    ${caveats.map((c) => `<div class="caveat${/LONGER|stall|cut off|backwards|hide the stall/.test(c) ? ' bad' : ''} mt-5">${F.esc(c)}</div>`).join('')}
    ${F.nodeWarnings(s?.warnings).length ? `<div class="caveat bad mt-5"><b>Node warnings:</b> ${F.esc(F.nodeWarnings(s.warnings).join('; '))}</div>` : ''}
  </div>`;
}

// --------------------------------------------------------------- overview

// The last /api/markets reply, for the Overview price strip. Module scope rather than `state`
// because it is not node state and must not ride the SSE snapshot.
let overviewMarkets = null;

function renderOverview(s) {
  if (!s) return;
  document.querySelectorAll('[data-sync-hero]').forEach((box) => renderSyncHero(box, s));
  renderMiningOverview(s, state, helpers);

  // THE PRICE STRIP, between the sync hero and Block flow (operator, 2026-09-13: "We really need
  // to squeeze this line into the top of the Overview, between Sync status and Block Flow").
  //
  // Visibility only. NOTHING IS FETCHED HERE: render() runs on every SSE frame, about once a
  // second, and a fetch on that path would poll five exchanges at 1 Hz. The data arrives on its
  // own timer (see marketsStripTimer in boot), which is also where the setting gates the network.
  const stripOn = !!loadSettings().markets?.overviewSummary;
  const strip = document.getElementById('ovMkSummary');
  if (strip) {
    // and nothing to show while the feed is off (the default): the strip stays hidden
    const have = overviewMarkets && overviewMarkets.enabled !== false;
    strip.hidden = !stripOn || !have;
    if (stripOn && have) strip.innerHTML = marketsSummaryHtml(overviewMarkets, F);
  }

  const mp = s.mempool ?? {};
  setText('ovMpCount', mp.count == null ? '–' : F.num(mp.count));
  setText('ovMpBytes', mp.bytes != null
    ? `${F.bytes(mp.bytes)} · ${F.bytes(mp.usage)} of ${F.bytes(mp.maxUsage)}`
    : 'no byte figure reported');

  // "How much work is queued, in blocks?" -- the question the mempool number is
  // actually asked for. The divisor is the size of blocks that were really mined in the
  // window, not 1 MB or 4 MWU assumed; when attribution has not run, the card says so
  // instead of dividing by a constant nobody chose.
  const minedRows = (s.attribution?.recent ?? []).filter((r) => r.size != null);
  const avgBlock = minedRows.length ? Math.round(minedRows.reduce((n, r) => n + r.size, 0) / minedRows.length) : null;
  // No second count. `ovMpCount2` printed the same mp.count as `ovMpCount` one card away
  // under the label "waiting", so one measurement read as two. The queue-in-blocks line
  // is the figure that was actually missing, and it stays.
  setText('ovMpVsBlock', mp.bytes != null && avgBlock
    ? `≈ ${(mp.bytes / avgBlock).toFixed(1)} blocks at the ${F.bytes(avgBlock, 0)} average of the last ${minedRows.length} mined`
    : (mp.bytes == null ? 'no byte figure reported' : 'no mined block sizes in the window yet'));
  const avgWeight = minedRows.length ? Math.round(s.attribution.recent.reduce((n, r) => n + (r.weight ?? 0), 0) / minedRows.length) : null;
  setText('ovMpVsBlockKv', `<dl class="kv">
    <dt>queued</dt><dd>${mp.bytes != null ? F.bytes(mp.bytes) : '–'}</dd>
    <dt>avg block mined</dt><dd>${avgBlock != null ? `${F.bytes(avgBlock, 0)} · ${avgWeight != null ? F.num(avgWeight) : '–'} WU` : '<span class="warn">no attributed blocks in the window</span>'}</dd>
    <dt>inbound tx rate</dt><dd>${s.mempool?.ingestRate != null ? `${F.short(s.mempool.ingestRate)} tx/s` : '–'}</dd>
  </dl>`);

  // Throughput and peer counts live on the Network and Peers pages now, and so do the
  // writers. A card whose element is on another page and whose setText runs in
  // renderOverview only ever updates while you are looking at a different screen --
  // which is how the peer counts sat frozen at their boot values for a whole day.

  // fees
  const fees = s.fees ?? {};
  const feeRows = [[1, 'f1'], [2, 'f2'], [6, 'f6'], [24, 'f24'], [144, 'f144']]
    .map(([t, k]) => `<dt>in ${t} block${t > 1 ? 's' : ''}</dt><dd class="${fees[k] == null ? 'faint' : ''}">${fees[k] == null ? 'unset' : `${F.satPerVb(fees[k])} <span class="faint">sat/vB</span>`}</dd>`).join('');
  // Rewritten wholesale rather than patched field-by-field: the row count is fixed by
  // the estimator's targets, and this runs once a second.
  //
  // The card is addressed by id, not by walking up from its child. `closest()` is
  // answered `null` by the DOM stub, so that traversal made this card invisible to every
  // test -- it could and did render nothing in the browser while the suite stayed green,
  // because the tested path and the shipped path were not the same code.
  const feeCard = document.getElementById('ovFeesCard');
  if (feeCard) feeCard.innerHTML = `<h3>Fees <span class="sp"></span><span class="src">estimatesmartfee</span></h3>
    <div class="kv" id="ovFees">${feeRows}<dt>pool min</dt><dd>${mp.minFee != null ? `${F.satPerVb(mp.minFee)} <span class="faint">sat/vB</span>` : '–'}</dd></div>
    <canvas class="chart xs" id="ovFeeChart"></canvas>`;

  // overview mini charts
  const ser = state.series?.mempool ?? {};
  miniLine('ovMpChart', ser.hour, COL.accent);
  const netS = state.series?.net ?? {};
  const inSeries = netS.inHour ?? [];
  paint(canvas('ovNetChart'), {
    when: inSeries.length > 1,
    draw: (c) => lineChart(c, [
      { label: 'network in', color: COL.cyan, points: inSeries, area: true },
      { label: 'disk write', color: COL.purple, points: netS.diskHour ?? [], area: false },
    ], { fmtY: (v) => F.short(v), fmtTip: (v) => F.short(v) + 'B/s' }),
    placeholder: 'no bandwidth ticks in the log yet',
  });

  const feeS = state.series?.fees ?? {};
  paint(canvas('ovFeeChart'), {
    when: (feeS.f6 ?? []).length > 1 || (feeS.f2 ?? []).length > 1,
    draw: (c) => lineChart(c, [
      { label: 'next block', color: COL.accent, points: feeS.f1 ?? [] },
      { label: '6 blocks', color: COL.info, points: feeS.f6 ?? [] },
      { label: '144 blocks', color: COL.purple, points: feeS.f144 ?? [] },
    ], { fmtY: (v) => F.satPerVb(v, 0), fmtTip: (v) => F.satPerVb(v) + ' sat/vB', legend: true }),
    placeholder: 'the fee estimator has no data yet',
  });

  const peerS = state.series?.peers ?? {};
  paint(canvas('ovPeerChart'), {
    when: (peerS.connections ?? []).length > 1,
    draw: (c) => lineChart(c, [
      { label: 'connections', color: COL.ok, points: peerS.connections, area: true },
      { label: 'peers relaying', color: COL.info, points: peerS.relay ?? [] },
    ], { fmtY: (v) => F.short(v), zeroBase: false }),
    placeholder: 'no connection samples yet',
  });

  // blocks table
  const tb = document.querySelector('#ovBlocks tbody');
  if (tb) {
    const rows = (s.blocks?.recent ?? []).slice(0, 14);
    tb.innerHTML = rows.map((b) => `<tr>
      <td><a class="xlink" href="#explorer/block/${b.height}">${F.num(b.height)}</a></td>
      <td class="faint">${F.ageSec(Math.round((Date.now() - b.t) / 1000))}</td>
      <td class="${gapClass(b.gapSec)}">${b.gapSec == null ? '–' : F.ageSec(b.gapSec)}</td>
      <td class="r">${F.num(b.txs)}</td>
      <td class="r">${b.size == null ? '–' : F.bytes(b.size, 0)}</td>
      <td class="r">${b.weight == null ? '–' : F.bytes(Math.round(b.weight / 4), 0)}</td>
      <td class="r">${b.totalfee == null ? '–' : F.btc(b.totalfee)}</td>
      <td class="r">${b.p?.[1] == null ? '–' : b.p[1] + ' s/vB'}</td>
      <td class="w faint tiny">${b.viaPeer ? F.esc(b.viaPeer) : '<span class="faint">–</span>'}</td>
    </tr>`).join('') || `<tr><td colspan="9" class="faint">no block statistics loaded yet</td></tr>`;
  }

  const cav = document.getElementById('ovCaveats');
  if (cav) {
    const q = (s.health?.quality ?? []);
    cav.innerHTML = `<h3>What this panel cannot tell you <span class="sp"></span><span class="src">stated, not hidden</span></h3>`
      + (q.length ? q.map((x) => `<div class="caveat${x.severity === 'warn' ? ' bad' : ''}"><b>${F.esc(x.key)}</b> — ${F.esc(x.text)}</div>`).join('')
        : '<div class="note ok tiny">No known gaps: every panel is backed by a live figure from the node.</div>');
  }

  renderFeed('ovFeed', state.events.slice(0, 40));
}

function gapClass(g) {
  if (g == null) return 'faint';
  if (g > 3600) return 'bad';
  if (g > 1200) return 'warn';
  return '';
}

function miniLine(id, points, color, placeholder = 'no samples yet') {
  paint(canvas(id), {
    when: Array.isArray(points) && points.length > 1,
    draw: (c) => sparkline(c, points, { color }),
    placeholder,
  });
}

export function renderFeed(id, rows) {   // exported so the harness can exercise the
                                                       // real row builder, not a stub
  const el = document.getElementById(id);
  if (!el) return;
  const want = rows.filter((r) => !(r.kind === 'raw' && r.severity === 'info'));
  el.innerHTML = want.map((r) => `<div class="row ${r.severity ?? 'info'}">
      <span class="ts">${F.clock(r.ts)}</span>
      <span class="tag" title="${F.esc(r.tagBase ?? r.kind ?? '')}">${F.esc(r.tagBase ?? r.kind ?? '')}</span>
      <span class="txt">${F.esc(trimLine(r))}</span>
    </div>`).join('') || '<div class="row info"><span class="ts"></span><span class="tag"></span><span class="txt faint">no events yet</span></div>';
}

function trimLine(r) {
  const t = r.text ?? '';
  return t.length > 220 ? t.slice(0, 220) + '…' : t;
}

function canvas(id) { return document.getElementById(id); }
export function setText(id, v) {
  const el = document.getElementById(id);
  if (el && !el.classList.contains('no-auto')) el.innerHTML = v;
}

// -------------------------------------------------------------- dispatch

// THE HEADER UPTIME HOLDS ITS FIGURE (operator, 2026-09-13: "Uptime keeps blanking out and does
// not stay drawn. It should stay there until updated").
//
// It was not a dropped stream. `app` IS NOT IN AN SSE FRAME AT ALL: wireMonitor pushes
// `m.snapshot({})`, the bare node snapshot, about once a second, while the `app` block -- version,
// build, uptime, self telemetry -- is added by fullState, which only runs on the HTTP pull every
// 20 s. So the uptime was written once per pull and blanked by the very next stream frame a second
// later. What looked like a flickering value was a figure that is simply absent from 95% of the
// frames that render the header.
//
// Two ways to fix that, and the obvious one is wrong: putting the `app` block on every frame means
// calling app.selfTelemetry() once a second, and that is not a pure read -- it PUSHES A ROW into
// app.selfRing, a 5,000-row history sampled every 10 s. Filling it at frame rate would destroy the
// server's own telemetry history to keep a header field warm.
//
// So the value is held here instead: it changes when a new reading arrives and never otherwise, and
// `–` survives only until the first one. Monitor uptime is a property of THIS MONITOR, not of the
// node being watched, so holding it across a node switch stays correct -- which is exactly why the
// rpc latency beside it is left alone. That one is per node, and holding it would show one node's
// round trip under another node's name. It also never blanks, because health.rpc is in every frame.
let lastUptime = null;

export function render() {
  const s = state.snap;
  document.getElementById('rpcLat').textContent = s?.health?.rpc?.lastLatencyMs != null ? `${s.health.rpc.lastLatencyMs}ms` : '–';
  document.getElementById('rpcLat').className = s?.health?.rpc?.avgLatencyMs > 5000 ? 'bad' : '';
  // `s?.app ?` was also wrong on its own terms: an app block with a null uptimeSec multiplied to 0
  // and rendered "0m" -- a made-up figure rather than a missing one. The reading is the number.
  if (s?.app?.uptimeSec != null) lastUptime = F.uptime(s.app.uptimeSec * 1000);
  document.getElementById('appUp').textContent = lastUptime ?? '–';
  document.getElementById('offline').classList.toggle('hidden', !!s?.online);
  if (s && !s.online) {
    document.getElementById('offline').innerHTML = `<b>${F.esc(s.label)} is not answering RPC.</b> `
      + F.esc(s.health?.rpc?.lastError?.message ?? 'no error detail yet')
      + ' — everything below is the last state we saw.';
  } else if (!s) {
    // No snapshot has ever arrived for the node this page is watching. Before this
    // branch the banner was *shown* (the toggle above opens it whenever online is not
    // truthy) but its text was only written when a snapshot existed -- so a tab left
    // pointing at a node that had been removed from the config displayed a strip of
    // dashes, an open red bar with nothing in it, and no explanation. A blank page
    // that does not say why is the failure this project exists to avoid.
    document.getElementById('offline').innerHTML = `<b>No data from ${F.esc(state.node ?? 'this node')}.</b> `
      + 'Nothing has arrived from it since this page opened, so every figure below is – rather than 0. '
      + 'Either the node is not answering, or it is no longer configured in this monitor.';
  }

  if (!state.pickerBusy) {
    state.pickerBusy = true;
    // Throttled: this fires on every frame, and the picker only needs to move
    // when a percentage or a state actually changed.
    setTimeout(() => { state.pickerBusy = false; state.refreshPicker?.(); }, 20000);
  }
  switch (state.page) {
    case 'overview': renderOverview(s); break;
    case 'space': renderBlockSpace(s, state, helpers); break;
    case 'chain': renderChain(s, state, helpers); break;
    case 'mining': renderMining(s, state, helpers); break;
    case 'mempool': renderMempool(s, state, helpers); break;
    case 'peers': {
      // The peer table, every 15 s while this page is open (the server reads
      // getpeerinfo on its 15 s tier). The rows live on `state`, not on the
      // snapshot: the stream replaces the snapshot every second, and keying the
      // fetch on "this snapshot has no rows" re-fetched /api/peers on every frame.
      if (!peersFetching && Date.now() - peersFetchedAt >= 15_000) { peersFetching = true; peersDetail(true).then(() => { peersFetching = false; render(); }); }
      renderPeers(s, state, helpers);
      break;
    }
    case 'network': renderNetwork(s, state, helpers); break;
    case 'logs': renderLogs(state, helpers); break;
    case 'node': renderNode(s, state, helpers); break;
    case 'admin': renderAdmin(s, state, helpers); break;
    case 'explorer': renderExplorer(s, state, helpers); break;
    case 'markets': renderMarkets(s, state, helpers); break;
    case 'kiosk': renderKiosk(s, state, helpers); break;
    case 'tetrust': renderTetrust(s, state, helpers); break;
    case 'blockout': renderBlockout(s, state, helpers); break;
    case 'blockanoid': renderBlockanoid(s, state, helpers); break;
    case 'doom': renderDoom(s, state, helpers); break;
    case 'about': renderAbout(s, state, helpers); break;
  }
}

const helpers = { api, toast, setText, canvas, renderFeed, state, fmt: F, nextBlock: nextBlockDetail, mempoolDetail: mempoolDetail,
  // paint/resetCanvas are exposed so panels never call charts.empty() directly:
  // a missing sample must mark a chart stale, never erase it.
  charts: { lineChart, histogram, scatter, meter, stackedBars, paint, resetCanvas, COL },
  render, refreshMempoolDetail, renderSyncHero, peersDetail };

// getpeerinfo's raw rows are deliberately not in the 1s snapshot (they are either
// empty on this build or large on others); the peers page pulls them itself.
let peersFetchedAt = 0;
async function peersDetail(force = false) {
  if (state.page !== 'peers') return;
  if (!force && Date.now() - peersFetchedAt < 15_000) return state.peerRows;
  peersFetchedAt = Date.now();
  try {
    const d = await api(`/api/peers?node=${encodeURIComponent(state.node ?? '')}`);
    state.peerRows = d.rpcPeers ?? [];
    return state.peerRows;
  } catch { return null; }
}

let peersFetching = false;

// The block being built right now. Fetched only while the Mining page is on screen, and
// only once every 20 s -- which is now OUR cost, not the node's: since 2026-09-13 the server
// assembles the template from the mempool it already reads (collect/gbt.js) rather than
// spending 1.3-1.5 s of the node's single RPC thread on getblocktemplate. The cadence stays
// because re-assembling an unchanged pool would produce an identical block for ~50 ms of CPU.
// The full pool distribution is 40-50 KB and belongs in neither the snapshot nor the
// 1 s stream (rule 5), so the Mining page asks for it on its own cadence and the cell
// list is drawn from wherever the newest answer came from.
let mempoolFetchedAt = 0;
// 2026-09-10: 20 s, not 60, and on BOTH pages that draw the pool viewer.
//
// Cost, measured on production rather than assumed: getrawmempool verbose
// answers in 0.08 s for a 2.2 MB payload over 12,555 transactions, against a
// node with 4 RPC threads. Three calls a minute is ~0.24 s of node RPC time
// per minute -- a 0.4% duty cycle -- and ~6.6 MB/min of JSON over loopback.
// The old 60 s gate was not paying for itself: it made the viewer's 5.4 s
// transition run once a minute, which is what "takes too long to update
// between animations" was.
//
// The page test used to be `!== 'mining'`, which meant the Overview copy of
// the viewer could never have data at all.
// 2026-09-11: 20 s -> 60 s. The viewer's transition is now 40 s end to end
// (operator: "increase the animation time to at least 40 seconds if it's
// refreshed every 60 seconds"), so a 20 s poll would hand it a new layout
// halfway through every flight; the renderer also parks a mid-flight layout
// until the running one lands. A third of the RPC cost, too.
// 2026-09-11 (again): 60 s -> 30 s ("Faster refresh"), with the server reading the
// pool every 20 s on its own tier and the transition cut to 20 s end to end, so
// the board spends as long at rest as moving.
const MEMPOOL_DETAIL_MS = 30_000;
const POOL_VIEWER_PAGES = new Set(['mining', 'overview', 'space', 'kiosk']);
async function mempoolDetail(force = false) {
  if (!POOL_VIEWER_PAGES.has(state.page) || document.hidden) return state.mempoolDist;
  if (!force && Date.now() - mempoolFetchedAt < MEMPOOL_DETAIL_MS) return state.mempoolDist;
  mempoolFetchedAt = Date.now();
  state.poolFetchedAt = mempoolFetchedAt;   // the panels count down from here
  try {
    if (state.viewerMode === '2') {
      api(`/api/mempool/dense?node=${encodeURIComponent(state.node ?? '')}`)
        .then((x) => { if (x?.v) { state.denseBlock = { ...x, fetchedAt: Date.now() }; render(); } })
        .catch(() => { /* the mode 1 picture stays up */ });
    }
    const d = await api(`/api/mempool?node=${encodeURIComponent(state.node ?? '')}`);
    if (d?.dist) {
      state.mempoolDist = { ...d.dist, count: d.info?.count ?? d.dist.count, fetchedAt: Date.now(), stale: false };
      render();
    }
    return state.mempoolDist;
  } catch {
    if (state.mempoolDist) state.mempoolDist.stale = true;   // keep the picture, mark it
    return state.mempoolDist ?? null;
  }
}

let templateFetchedAt = 0;
const TEMPLATE_PAGES = new Set(['mining', 'overview', 'space', 'kiosk']);
async function nextBlockDetail(force = false) {
  // The block being built is asked for on both pages that draw it -- the Overview and
  // Mining -- and nowhere else, and never while the tab is hidden or updates are paused.
  // This used to cost the node 1.3-1.5 s of its single RPC thread per answer, and the
  // cadence was that price. The template is assembled from the mempool now and costs the
  // node nothing, but the cadence stands on its own: the pool tier only refreshes every
  // 20 s, so asking faster would re-assemble an identical block. 20 s on the page whose
  // whole subject is the template, 60 s on the landing page that shows a card of it; the
  // Block space page carries it in its own panel and pays the Mining rate.
  if (!TEMPLATE_PAGES.has(state.page)) return state.snap?.attribution?.nextBlock;
  if (document.hidden || state.paused) return state.snap?.attribution?.nextBlock ?? null;
  const freshMs = state.page === 'overview' ? 60_000 : 20_000;
  if (!force && Date.now() - templateFetchedAt < freshMs) return state.snap?.attribution?.nextBlock;
  templateFetchedAt = Date.now();
  try {
    const d = await api(`/api/nextblock?node=${encodeURIComponent(state.node ?? '')}`);
    if (state.snap?.attribution && d && !d.unavailable) { state.snap.attribution.nextBlock = d; render(); }
    return d;
  } catch { return state.snap?.attribution?.nextBlock ?? null; }
}

// The mempool scatter is deliberately kept out of the 1s snapshot; the mempool
// page pulls it on its own cadence instead.
let mpDetailTimer = null;
async function refreshMempoolDetail(force = false) {
  if (state.page !== 'mempool') return;
  // ...but never makes the viewer wait past its minute: the countdown in its
  // panel promises that moment, so the fetch goes as soon as it is due
  if (!force && mpDetailTimer && Date.now() - mpDetailTimer < 9000 && Date.now() < mempoolFetchedAt + MEMPOOL_DETAIL_MS) return;
  mpDetailTimer = Date.now();
  try {
    const d = await api(`/api/mempool?node=${encodeURIComponent(state.node ?? '')}`);
    state.mempoolDetail = d;
    // the page's own fetch also feeds its Block space viewer, so the Mempool
    // page does not poll /api/mempool twice -- but only once a minute, the
    // same beat as every other page's viewer and the one its countdown shows
    // (a new layout every 9 s landed in the middle of every 40 s flight)
    if (d?.dist && (!state.mempoolDist || Date.now() - mempoolFetchedAt >= MEMPOOL_DETAIL_MS)) {
      mempoolFetchedAt = Date.now();
      state.poolFetchedAt = mempoolFetchedAt;
      state.mempoolDist = { ...d.dist, count: d.info?.count ?? d.dist.count, fetchedAt: Date.now(), stale: false };
    }
    if (state.page === 'mempool') renderMempool(state.snap, state, helpers, d);
  } catch { /* the next tick will try again */ }
}

// ----------------------------------------------------------------- boot

function connect() {
  const es = new EventSource(`/api/stream${state.node ? `?node=${encodeURIComponent(state.node)}` : ''}`);
  const badge = document.getElementById('sseState');
  es.onopen = () => { badge.textContent = 'live'; badge.className = 'ok'; };
  es.onerror = () => {
    badge.textContent = 'reconnecting';
    badge.className = 'warn';
    // EventSource reconnects by itself -- but it reconnects to the SAME url. If the
    // node this tab chose has left the configuration, that is a 404 retried forever:
    // a page that never updates and never says why. Two consecutive failures with no
    // frame in between is the signal to re-resolve the node list rather than keep
    // knocking on a door that is gone.
    state.streamFails = (state.streamFails ?? 0) + 1;
    const quietFor = Date.now() - (state.lastFrameAt ?? 0);
    if (state.streamFails >= 2 && quietFor > 20_000) attemptStreamRecovery('the live link kept failing');
  };
  const noteFrame = () => { state.lastFrameAt = Date.now(); state.streamFails = 0; };
  es.addEventListener('snapshot', (ev) => {
    noteFrame();
    if (state.paused) return;
    const s = JSON.parse(ev.data);
    if (s.id && state.node && s.id !== state.node) return;
    const rec = nodeRec(s.id ?? state.node);
    rec.snap = s;
    rec.snapAt = Date.now();
    state.snap = s;
    render();
  });
  es.addEventListener('series', (ev) => {
    if (state.paused) return;
    const p = JSON.parse(ev.data);
    const rec = nodeRec(state.node);
    // Merge, do not replace: a partial push must not drop the series that were
    // not in it, or the panel they feed would lose its chart.
    rec.series = { ...(rec.series ?? {}), ...(p.series ?? p) };
    rec.seriesAt = Date.now();
    state.series = rec.series;
    render();
  });
  es.addEventListener('events', (ev) => {
    noteFrame();
    const rows = JSON.parse(ev.data);
    if (state.pausedHard) return;
    for (const r of rows) {
      state.events.unshift(r);
      // the address index build is the one thing worth interrupting a page for: it takes half an hour
      if (r.kind === 'index') toast(r.text, r.severity === 'warn' ? 'bad' : 'ok');
    }
    // Bounded: an unbounded feed is a slow memory leak with a visible UI.
    if (state.events.length > 1500) state.events.length = 1500;
    if (state.page === 'logs' || state.page === 'overview' || state.page === 'peers') render();
  });
  state.es = es;
}

/**
 * The live link has been useless for a while: work out why, and say it.
 *
 * Two outcomes, and both have to be visible. Either the node this tab chose no longer
 * exists -- then re-resolve the list and switch, which is what recoverMissingNode does
 * -- or the node is still here and the stream is simply down, which is a *staleness*
 * claim and must be shown as one. The failure being designed against is the silent
 * kind: a page of frozen numbers, a badge stuck on "reconnecting", nothing in any log.
 */
let recovering = false;
async function attemptStreamRecovery(why) {
  if (recovering) return;
  recovering = true;
  try {
    const nodes = await api('/api/nodes').catch(() => null);
    const known = (nodes?.nodes ?? []).map((n) => n.id);
    if (nodes && state.node && !known.includes(state.node)) {
      await recoverMissingNode();
      return;
    }
    // Node still real: make the silence loud rather than pretty.
    const banner = document.getElementById('offline');
    const since = state.lastFrameAt ? Math.round((Date.now() - state.lastFrameAt) / 1000) : null;
    banner.innerHTML = `<b>${why}.</b> Nothing has arrived for ${since == null ? 'as long as this page has been open' : `${since}s`} `
      + '— the figures below are the last ones received, not current. Check the server log for `sse #` lines if this persists.';
    banner.classList.remove('hidden');
  } finally {
    recovering = false;
  }
}

/**
 * Change which node is being watched.
 *
 * The cache means returning to a node you have already looked at is instant and
 * its charts come back immediately. The canvas wipe is not optional: the pixels
 * on screen were measured on the other daemon, and a chart is not labelled with
 * its node the way the header is, so a stale one would silently misattribute
 * data. Anything we do not have for the new node shows a placeholder and fills
 * in from the background pull.
 */
// THE NODE YOU PICKED IS THE NODE YOU GET BACK (operator, 2026-09-13: "The selected option should
// stay sticky as the default"). Remembered per browser, like the viewer mode, and written ONLY
// here: switchNode is the single audited path a deliberate choice goes through (web-contract.test
// requires the switch be delegated to it), so a storage write anywhere else would be a second
// owner of the same fact.
//
// Wrapped, because storage does not merely return null when it is unavailable -- a private window
// THROWS on access, and an exception here would take the node switch down with it.
const NODE_KEY = 'blockyard.node';
const rememberNode = (id) => { try { globalThis.localStorage?.setItem(NODE_KEY, id); } catch { /* storage refused */ } };
export const rememberedNode = () => { try { return globalThis.localStorage?.getItem(NODE_KEY) || null; } catch { return null; } };

async function switchNode(id) {
  if (!id || id === state.node) return;
  state.node = id;
  rememberNode(id);
  const rec = nodeRec(id);
  resetAllCharts();
  state.snap = rec.snap ?? null;
  state.series = rec.series ?? null;
  state.events = [];
  state.es?.close();
  connect();
  render();
  if (!rec.snap) await backgroundRefresh();
}

/**
 * The background collector.
 *
 * Charts are filled by SSE, but a reconnect, a proxy hiccup or a slow server
 * push must never show up as an empty panel -- so this pulls the full read model
 * (including every chart series) on its own timer, when the page is visible, and
 * merges it into the cache. The foreground renders whatever is known right now
 * and flags it as stale if it is old; it never waits and never clears itself.
 */
let pulling = false;
async function backgroundRefresh() {
  if (!state.node || pulling) return;
  pulling = true;
  try {
    const sn = await api(`/api/state?node=${encodeURIComponent(state.node)}`);
    // A successful pull is liveness too, by any definition -- the watchdog below asks
    // "has anything arrived lately", and an HTTP refresh is exactly that.
    state.lastFrameAt = Date.now();
    state.streamFails = 0;
    const rec = nodeRec(state.node);
    rec.snap = sn;
    rec.snapAt = Date.now();
    // Merge rather than replace so a frame missing one series cannot erase a chart.
    rec.series = { ...(rec.series ?? {}), ...(sn.series ?? {}) };
    rec.seriesAt = Date.now();
    state.snap = sn;
    state.series = rec.series;
    render();
  } catch (err) {
    // A node that is no longer configured is not a flaky link: retrying the same
    // request never recovers, and the page would sit showing dashes forever while the
    // header looked merely slow. Re-read the node list and land on a real one.
    // Seen for real when the benchmark node was removed from the config while a tab
    // was open on it: the tab kept asking for a node that no longer existed.
    if (err.status === 404) await recoverMissingNode();
    // Otherwise silence is correct: the next tick retries, and the charts still show
    // what they showed before, marked stale. A toast every 20s on a flaky link would
    // be worse than the gap.
  } finally {
    pulling = false;
  }
}

/**
 * The node this tab is watching has disappeared from the configuration.
 *
 * Re-resolve from the server rather than reloading blindly: the answer might be a
 * renamed node, a different primary, or genuinely nothing -- and "no nodes are
 * configured" must read as that, not as a monitor that is merely quiet.
 *
 * Deliberately does NOT touch state.snap / state.series or wipe canvases itself.
 * Nulling the cache between frames is the bug `test/never-blank.test.js` exists to
 * keep dead, and the canvas wipe belongs to exactly one code path. Switching to the
 * surviving node is a node switch, so it goes through switchNode() and inherits its
 * rules instead of quietly growing a second copy of them.
 */
async function recoverMissingNode() {
  const lost = state.node;
  try {
    const nodes = await api('/api/nodes');
    state.nodes = nodes.nodes ?? [];
    const next = (nodes.attention && nodes.attention[0]) || nodes.primary;
    if (!next) {
      // No node to switch to: leave whatever is on screen visible and say plainly
      // that nothing is being polled. Blankening it would trade an honest stale view
      // for an unexplained empty one.
      document.getElementById('offline').innerHTML = '<b>This monitor has no nodes configured.</b> '
        + 'Nothing is being polled, so any figure that reads – is – by design rather than by failure. '
        + 'Add a node under <span class="mono">nodes</span> in config/local.json and restart.';
      document.getElementById('offline').classList.remove('hidden');
      toast('no nodes configured in this monitor', 'bad');
      return;
    }
    toast(`${lost} is no longer configured; watching ${next}`, 'warn');
    state.node = null;          // switchNode no-ops on the same id; this one differs
    // This also REPLACES the remembered node, because switchNode remembers what it is given -- and
    // that is the behaviour wanted here rather than an accident of call order: the node someone
    // picked is genuinely gone, so keeping its id would make every future boot re-check a node that
    // no longer exists before falling back. The recovery's choice becomes the new default.
    await switchNode(next);
  } catch {
    // Signed out mid-recovery (api() redirects) or the node list is unreachable too.
    // Nothing further to do; the no-snapshot banner already says what is true.
    render();
  }
}

/**
 * Say which build this tab is running, and complain when it is not the current one.
 *
 * The page carries `data-blockyard-build`, stamped per response by the static layer, and
 * asks /api/build whether that string is still current. If it is not, this tab is
 * executing code that has been replaced -- and nothing else on screen would ever
 * reveal that. Every "did the fix land?" on 2026-09-08 cost fifteen minutes for want
 * of exactly this comparison.
 */
export async function checkBuild() {
  const served = document.documentElement?.dataset?.blockyardBuild ?? null;
  const verEl = document.getElementById('ver');
  const note = document.getElementById('buildNote');
  let info = null;
  try {
    info = await api(`/api/build${served ? `?build=${encodeURIComponent(served)}` : ''}`);
  } catch {
    if (verEl) verEl.textContent = served ? `build ${shortBuild(served)} (server unreachable)` : 'build unknown';
    return { served, current: null };
  }
  const now = shortBuild(info.build);
  if (verEl) verEl.textContent = `v${info.version} · ${now}`;
  const stale = info.matchesClient === false;
  if (note) {
    note.classList.toggle('hidden', !stale);
    const b = note.querySelector?.('b');
    if (b) b.textContent = stale ? 'stale build — reload' : 'build current';
    note.title = stale
      ? `this tab loaded build ${shortBuild(served)} and the server is now running ${now}; reload to execute the code that is actually on disk`
      : `this tab is running build ${now}`;
    if (stale && !state.buildWarned) {
      state.buildWarned = true;
      toast('the monitor was redeployed since this page loaded — reload to pick up the new build', 'bad');
    }
  }
  return { served: info.build, current: !stale };
}

/** `0.1.0-3faef7bb00` -> `3faef7bb00`: the part that distinguishes two builds. */
function shortBuild(build) {
  const s = String(build ?? '');
  const i = s.indexOf('-');
  return i > 0 ? s.slice(i + 1) : s;
}

// "explorer/tx/<txid>" -> the explorer page, subroute "tx/<txid>". Only the explorer has
// subroutes; they stay on the URL so every explorer page is a link.
// The games live behind the Diversions pop-down at the end of the nav; the menu shows as the
// active tab while one of them is open, since its own button is out of sight inside the popup.
const DIVERSION_PAGES = ['tetrust', 'blockout', 'blockanoid', 'doom'];

function setPage(route) {
  const [page, ...rest] = String(route).split('/');
  state.xroute = page === 'explorer' ? rest.join('/') : '';
  state.page = page;
  document.querySelectorAll('.page').forEach((el) => el.classList.toggle('on', el.dataset.page === page));
  document.querySelectorAll('nav.pages button').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  document.getElementById('navDivBtn')?.classList.toggle('on', DIVERSION_PAGES.includes(page));
  const want = `#${page}${state.xroute ? `/${state.xroute}` : ''}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  if (page === 'mempool') refreshMempoolDetail(true);
  // Render the cache immediately, then top it up in the background. The user
  // never waits on a fetch to see a chart that already has data.
  backgroundRefresh();
  if (page === 'logs') ensureLogsLoaded(state, helpers);
  if (page === 'chain') initChainDrill(helpers);
  if (page === 'admin') renderAdmin(state.snap, state, helpers, true);
  render();
}

// Reading localStorage is not merely empty in a locked-down context, it throws, and
// boot() is not the place to find that out.
function hasLocalSettings() {
  try { return !!globalThis.localStorage?.getItem(SETTINGS_KEY); } catch { return false; }
}

async function boot() {
  let me = null;
  try {
    me = await api('/api/me');
  } catch {
    // Only reachable when accounts are on: with them off /api/me answers for the
    // anonymous viewer, so a redirect here would be a loop.
    window.location.href = '/login';
    return;
  }
  state.user = me.user;
  state.caps = me.capabilities;
  // `accounts` is reported by the server rather than inferred from a missing button:
  // the posture has to be stateable in words, and "we appear to have no login" is a
  // worse sentence than "this monitor is open to everyone who can reach it".
  state.accounts = me.accounts !== false;
  const open = !state.accounts;
  document.getElementById('whoami').textContent = open
    ? 'no sign-in · read-only'
    : `${me.user.username} · ${me.user.role}`;
  // Sign out with no session is a button that does nothing, which is the kind of UI
  // that makes people reload the page and then report it as broken.
  const out = document.getElementById('btnLogout');
  if (out) out.hidden = open;
  const pill = document.getElementById('accessPill');
  if (pill) {
    pill.hidden = !open;
    const b = pill.querySelector?.('b');
    if (b) b.textContent = 'open access';
    pill.title = 'No account is required: anyone who can reach this monitor reads it as role "viewer" (reads only — user admin, the audit trail and node writes stay closed). Start the server with BLOCKYARD_AUTH=1 to require sign-in.';
  }
  document.getElementById('navAdmin').hidden = me.user.role !== 'admin';
  const [nodes, cfg, saved] = await Promise.all([
    api('/api/nodes'),
    api('/api/config'),
    // Display settings belong to the deployment, not to one browser: this is a server
    // app, so a phone and a desktop pointed at it see the same monitor. A server that
    // cannot answer still boots -- the browser's own settings stand in, which is
    // exactly the behaviour there was before the file existed.
    api('/api/settings').catch(() => null),
  ]);
  state.nodes = nodes.nodes;
  // Land on a node that is doing something. Defaulting to config order meant a
  // fully-synced production node could open at "Synced 100%" and fill the hero
  // while a bench node sat at 72% -- the wrong node, at the wrong size.
  //
  // ...UNLESS SOMEONE HAS CHOSEN ONE (operator, 2026-09-13: "The selected option should stay sticky
  // as the default"). An explicit pick is stronger evidence of intent than the heuristic, so a
  // remembered node wins; the attention rule above still decides a FIRST visit, and still decides
  // it for anyone who has never touched the picker. That keeps "land on the work" for the case it
  // was written for without overriding someone who has already said otherwise.
  //
  // VALIDATED AGAINST THE LIVE LIST, never trusted on its own: a node can be removed from the
  // config between visits, and a remembered id that no longer exists would open the page on a node
  // that cannot answer -- a strip of dashes with no explanation, which is the failure this app
  // exists to avoid. An unknown id simply falls through to the heuristic.
  const remembered = rememberedNode();
  const known = (nodes.nodes ?? []).some((n) => n.id === remembered);
  state.node = (known ? remembered : null) || (nodes.attention && nodes.attention[0]) || nodes.primary;
  state.cfg = cfg;
  // Seed before the first paint: every later reader calls loadSettings(), so settings
  // applied after a render would show this browser's copy and then visibly swap it.
  if (saved?.stored && saved.settings) seedSettings(saved.settings);
  else if (hasLocalSettings()) {
    // A server with no file yet, reached from a browser that already has settings:
    // hand them up rather than make someone pick them all again. Silent on refusal --
    // a viewer without write access still gets a working page, just not a saved one.
    api('/api/settings', { method: 'POST', body: { settings: loadSettings() } }).catch(() => {});
  }
  // From here on every save reaches the server too; settings.js debounces the push.
  setSettingsPush((s) => api('/api/settings', { method: 'POST', body: { settings: s } }));
  await checkBuild();
  // Re-check on a timer, because the failure this exists for happens while the tab
  // is open: the operator deploys, the tab does not reload, and every subsequent
  // report describes code that is no longer on disk. Five minutes, because a
  // deploy is slower than that and a reload is cheaper than an hour of doubt.
  setInterval(() => { if (!document.hidden) checkBuild(); }, 300_000);

  const pick = document.getElementById('nodePick');
  const STATE_DOT = { synced: 'ok', ibd: 'accent', catching_up: 'accent', stalled: 'bad', reorg: 'warn', unknown: 'faint' };
  const describe = (n) => `${n.label} — ${n.pct == null ? (n.online ? 'no data yet' : 'offline') : `${n.pct.toFixed(1)}%`}${n.syncing ? ' syncing' : ''}`;
  const renderPicker = (list) => {
    if (!list.length) return;
    if (list.length === 1) {
      pick.innerHTML = `<span class="${STATE_DOT[list[0].syncState] ?? 'faint'}" title="${F.esc(list[0].label + ' — ' + list[0].rpcUrl)}">${F.esc(list[0].label)}</span>`;
      return;
    }
    // Every node visible with its own state, because picking a node blind is how
    // you end up watching the one that needs nothing.
    pick.innerHTML = `<select class="f" id="nodeSel">${list.map((n) => `<option value="${F.esc(n.id)}"${n.id === state.node ? ' selected' : ''}>${F.esc(describe(n))}</option>`).join('')}</select>`;
    pick.querySelector('select').addEventListener('change', (e) => switchNode(e.target.value));
  };
  renderPicker(nodes.nodes);
  // Keep the picker's percentages honest without a reload: refresh it whenever a
  // snapshot arrives, but only if anything changed.
  state.refreshPicker = async () => {
    try {
      const n2 = await api('/api/nodes');
      const sig = JSON.stringify(n2.nodes.map((n) => [n.id, n.syncState, Math.round(n.pct ?? -1)]));
      if (sig !== state.pickerSig) { state.pickerSig = sig; renderPicker(n2.nodes); }
    } catch { /* keep the stale list */ }
  };

  // The compact hero's "detail" button: a user who wants the big view can have
  // it, without paying for it on every page load.
  // The hero's expand/collapse control. State lives in one flag and the renderer
  // re-reads it; the alternative (mutating the DOM in place) would be undone by
  // the very next snapshot frame, which overwrites this element's innerHTML.
  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-toggle-hero],[data-toggle-sync]')) {
      state.heroForced = !state.heroForced;
      render();
      return;
    }
    const jump = e.target.closest('[data-jump-node]');
    if (jump) await switchNode(jump.dataset.jumpNode);
  });
  document.getElementById('nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (b) setPage(b.dataset.page);
  });
  // The monogram routes like a tab, but it lives OUTSIDE <nav> (it is the brand), and the handler
  // above is bound to the nav element -- so it needs its own listener rather than inheriting one.
  document.getElementById('brandAbout')?.addEventListener('click', () => setPage('about'));
  // the Diversions pop-down: opens on its button, closes on a choice, on a click anywhere else,
  // and on Escape
  const divWrap = document.getElementById('navDiv');
  const divBtn = document.getElementById('navDivBtn');
  const divPop = document.getElementById('navDivPop');
  // The panel is position:fixed (see app.css), so it is placed from the button's own rect each
  // time it opens -- the nav scrolls and the header clips, and a panel positioned inside either of
  // them cannot be seen at all. Custom properties through the CSSOM, never a style attribute.
  const placeDiversions = () => {
    if (!divBtn || !divPop) return;
    const r = divBtn.getBoundingClientRect();
    // MEASURED, not transformed. The panel used to be pulled left by translateX(-100%); now its
    // real left edge is computed so nothing depends on transform behaviour I cannot test here.
    // It must be measurable to be measured, so it is un-hidden first if it is not already open.
    const wasHidden = divPop.classList.contains('hidden');
    if (wasHidden) divPop.classList.remove('hidden');
    const w = divPop.offsetWidth || 160;
    if (wasHidden) divPop.classList.add('hidden');
    // right-aligned to the button, then held inside the viewport on both sides
    const left = Math.max(6, Math.min(r.right - w, window.innerWidth - w - 6));
    divPop.style.setProperty('--x', `${Math.round(left)}px`);
    divPop.style.setProperty('--y', `${Math.round(r.bottom + 6)}px`);
  };
  const openDiversions = (open) => {
    if (open) placeDiversions();
    divPop?.classList.toggle('hidden', !open);
    divBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  divBtn?.addEventListener('click', (e) => { e.stopPropagation(); openDiversions(divPop?.classList.contains('hidden')); });
  // The panel lives OUTSIDE <nav> now (see index.html: WebKit would not let the button be clicked
  // inside the scrolling nav), so the delegated handler bound to #nav no longer sees these items.
  // They route from here instead -- without this the three games become unreachable, which is a
  // worse fault than the one the move fixes.
  divPop?.addEventListener('click', (e) => {
    const b = e.target.closest?.('button[data-page]');
    if (b) setPage(b.dataset.page);
    openDiversions(false);
  });
  // The panel is no longer inside divWrap (it is a child of <body> now, so the header cannot clip
  // it), so a click INSIDE the panel is outside the wrapper. Without naming the panel too, opening
  // the menu and clicking an item would close it before the item's own handler ran.
  document.addEventListener('click', (e) => {
    const inside = (divWrap && divWrap.contains(e.target)) || (divPop && divPop.contains(e.target));
    if (!inside) openDiversions(false);
  });
  window.addEventListener('resize', () => { if (divPop && !divPop.classList.contains('hidden')) placeDiversions(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openDiversions(false); });
  // DISPLAY SETTINGS (settings.js). The panel is built from PANEL, so a control and its value
  // cannot drift apart, and every change is saved and applied without a reload: the boards read
  // loadSettings() on their next paint, and a repaint is asked for immediately.
  const cfgWrap = document.getElementById('settingsWrap');
  const cfgBody = document.getElementById('cfgBody');
  const cfgGear = document.getElementById('btnSettings');
  // TABS (operator, 2026-09-12: "tabbed section panel in setup"). One tab per PANEL group: the
  // effects group alone is twenty-six switches, and a single scrolling column buried every other
  // setting under it. The open tab is remembered for the session, not persisted -- it is where you
  // were looking, not a preference.
  let cfgTab = SETTINGS_PANEL[0].group;
  const drawSettings = () => {
    const s = loadSettings();
    if (!SETTINGS_PANEL.some((g) => g.group === cfgTab)) cfgTab = SETTINGS_PANEL[0].group;
    const tabs = `<div class="cfgtabs" role="tablist">${SETTINGS_PANEL.map((g) =>
      `<button type="button" class="cfgtab${g.group === cfgTab ? ' on' : ''}" role="tab" aria-selected="${g.group === cfgTab}" data-cfgtab="${g.group}">${g.title}</button>`).join('')}</div>`;
    cfgBody.innerHTML = tabs + SETTINGS_PANEL.filter((g) => g.group === cfgTab).map((g) => {
      // ALL / NONE, on the groups that ask for it (the two effects tabs): twenty-eight switches is
      // a lot of clicking to answer "just show me the quiet board". This was "every row is a
      // toggle" until the no-repeat slider joined the effects group and silently took the buttons
      // with it.
      const bulk = g.bulk
        ? `<div class="cfgbulk"><button type="button" class="btn" data-cfgall="${g.group}">all on</button><button type="button" class="btn" data-cfgnone="${g.group}">all off</button></div>`
        : '';
      return `<div class="cfggroup"><h3>${g.title}</h3><p>${g.note}</p>${bulk}${g.rows.map((r) => {
      const v = s[g.group][r.key];
      const id = `cfg-${g.group}-${r.key}`;
      const ctl = r.kind === 'toggle'
        ? `<input type="checkbox" id="${id}" data-cfg="${g.group}.${r.key}"${v ? ' checked' : ''}>`
        : r.kind === 'choice'
          ? `<select id="${id}" data-cfg="${g.group}.${r.key}">${r.options.map(([val, label]) => `<option value="${val}"${val === v ? ' selected' : ''}>${label}</option>`).join('')}</select>`
          : r.kind === 'colour'
            ? `<input type="color" id="${id}" data-cfg="${g.group}.${r.key}" value="${v}">`
            : `<span class="cfgrange"><input type="range" id="${id}" data-cfg="${g.group}.${r.key}" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}"><span class="val" data-val-for="${g.group}.${r.key}">${formatRangeValue(r.step, v)}</span></span>`;
      return `<div class="cfgrow"><b><label for="${id}">${r.label}</label></b><span>${ctl}</span><i>${r.hint}</i></div>`;
      }).join('')}</div>`;
    }).join('');
  };
  const openSettings = (open) => {
    cfgWrap.classList.toggle('hidden', !open);
    cfgGear.classList.toggle('on', open);
    cfgGear.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) drawSettings();
  };
  cfgGear.addEventListener('click', () => openSettings(cfgWrap.classList.contains('hidden')));
  document.getElementById('cfgClose').addEventListener('click', () => openSettings(false));
  document.getElementById('settingsScrim').addEventListener('click', () => openSettings(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !cfgWrap.classList.contains('hidden')) openSettings(false); });
  document.getElementById('cfgReset').addEventListener('click', () => {
    resetSettings();
    drawSettings();
    render();
    toast('display settings back to their defaults');
  });
  cfgBody.addEventListener('click', (e) => {
    const tab = e.target.closest?.('[data-cfgtab]');
    if (tab) { cfgTab = tab.dataset.cfgtab; drawSettings(); return; }
    const bulk = e.target.closest?.('[data-cfgall], [data-cfgnone]');
    if (!bulk) return;
    const on = bulk.hasAttribute('data-cfgall');
    const group = bulk.dataset.cfgall ?? bulk.dataset.cfgnone;
    for (const r of SETTINGS_PANEL.find((g) => g.group === group)?.rows ?? []) {
      if (r.kind === 'toggle') setSetting(loadSettings(), `${group}.${r.key}`, on);
    }
    drawSettings();
    render();
  });
  // ONE REPAINT PER FRAME, not one per input event (operator, 2026-09-12: "the grid intensity
  // slider jitters when I move it"). `render()` is not cheap -- it rewrites the header, toggles the
  // offline banner and then repaints the open page's canvases -- and dragging a slider fires an
  // `input` event per step. The grid intensity control has forty steps across its range AND
  // recolours a board on each one, so a drag queued forty synchronous repaints and the thumb
  // visibly stuttered behind the pointer. Every one of the twelve range controls had this; the new
  // one only made it obvious.
  // The VALUE is still stored and the readout still updates on every event -- those are cheap, and
  // the number beside the slider must track the thumb exactly. Only the repaint is coalesced, so at
  // most one runs per animation frame however fast the pointer moves.
  let repaintQueued = 0;
  const repaintSoon = () => {
    if (repaintQueued) return;
    repaintQueued = requestAnimationFrame(() => { repaintQueued = 0; render(); });
  };
  cfgBody.addEventListener('input', (e) => {
    const el = e.target.closest?.('[data-cfg]');
    if (!el) return;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    setSetting(loadSettings(), el.dataset.cfg, value);
    const out = cfgBody.querySelector(`[data-val-for="${el.dataset.cfg}"]`);
    // fixed decimals from the slider's own step, so the number never changes width (formatRangeValue)
    if (out) out.textContent = el.type === 'range' ? formatRangeValue(el.step, value) : String(value);
    repaintSoon();     // the boards pick the new options up on their next paint
  });

  document.getElementById('btnPause').addEventListener('click', (e) => {
    state.paused = !state.paused;
    state.pausedHard = e.shiftKey ? true : state.paused ? state.pausedHard : false;
    e.target.textContent = state.paused ? 'resume' : 'pause';
    e.target.classList.toggle('primary', state.paused);
    toast(state.paused ? `updates frozen${state.pausedHard ? ' including the event feed' : ''}` : 'updates resumed');
  });
  document.getElementById('btnLogout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* session may already be gone */ }
    window.location.href = '/login';
  });

  // Background collection, not foreground waiting. 20s keeps the charts filling
  // even if every SSE frame is lost, and only while the tab is actually visible.
  setInterval(() => { if (!document.hidden && !state.paused) backgroundRefresh(); }, 20_000);
  // THE OVERVIEW PRICE STRIP'S OWN TIMER, and the one place its network cost is decided.
  //
  // GET /api/markets calls markets.touch() on the server, which is what starts the five-exchange
  // polling -- so this must not run unless the operator switched the strip on. Turning it off
  // stops asking, the server's feed parks itself after idleAfterMs, and the promise in
  // docs/SECURITY.md holds again. Same cadence as the Markets page, and only while the tab is
  // visible: a backgrounded tab has nobody reading the price.
  const pullMarketsStrip = () => {
    if (document.hidden || state.paused) return;
    if (!loadSettings().markets?.overviewSummary) return;
    if (state.page !== 'overview') return;      // Markets and Kiosk fetch their own
    api('/api/markets').then((d) => { overviewMarkets = d; if (state.page === 'overview') render(); }).catch(() => {});
  };
  setInterval(pullMarketsStrip, MARKETS_REFRESH_MS);
  pullMarketsStrip();
  // "Trigger Refresh Now" (operator, 2026-09-11: "a button for 'Trigger Refresh
  // Now' that is only enabled when the animation is idle"). A click makes the
  // viewer due at once and fetches; the ticker below keeps each button enabled
  // only while its own board is at rest (viewerIdle), updates are not paused
  // and no refresh is already under way. Checked again on click, since the
  // ticker runs once a second.
  let poolRefreshing = false;
  // a refresh button's board: through its control bar, which lives in the panel's heading now
  const viewerCanvasFor = (b) => b.closest('.viewer-ctl')?.__canvas ?? b.closest('.treemapwrap')?.querySelector('canvas') ?? null;
  document.addEventListener('click', async (e) => {
    const b = e.target.closest?.('[data-refresh-now]');
    if (!b || b.disabled || poolRefreshing || state.paused) return;
    if (!viewerIdle(viewerCanvasFor(b))) return;
    poolRefreshing = true;
    b.disabled = true;
    mempoolFetchedAt = 0;   // due now
    try { if (state.page === 'mempool') await refreshMempoolDetail(true); else await mempoolDetail(true); }
    finally { poolRefreshing = false; }
  });
  // The pool viewers' countdown to their next refresh (see refreshLabel), once
  // a second. Text and a CSS variable only -- nothing is re-rendered.
  setInterval(() => {
    if (document.hidden) return;
    const { text, frac } = refreshLabel(state.poolFetchedAt ? state.poolFetchedAt + MEMPOOL_DETAIL_MS : NaN, Date.now(), { paused: state.paused, period: MEMPOOL_DETAIL_MS });
    for (const el of document.querySelectorAll('[data-refresh]')) {
      if (el.textContent !== text) el.textContent = text;
      el.style.setProperty('--p', `${Math.round(frac * 100)}%`);
    }
    for (const b of document.querySelectorAll('[data-refresh-now]')) {
      const ok = !state.paused && !poolRefreshing && viewerIdle(viewerCanvasFor(b));
      if (b.disabled === ok) b.disabled = !ok;
      b.title = ok ? 'refresh the pool now' : state.paused ? 'updates are paused' : 'waits for the board to come to rest';
    }
  }, 1000);
  // Watchdog. A page can lose its stream without anything else noticing: the badge
  // says "reconnecting", the numbers stop moving, and no log line is written anywhere.
  // So every 15s, ask the blunt question -- has any frame arrived in the last 90s?
  setInterval(() => {
    if (document.hidden || state.pausedHard) return;
    const quietFor = Date.now() - (state.lastFrameAt ?? state.startedAt);
    if (quietFor > 90_000) attemptStreamRecovery('no live data has arrived');
    else if (state.lastFrameAt) {
      const rec = state.byNode.get(state.node);
      const age = Date.now() - (rec?.snapAt ?? 0);
      // Stale must be VISIBLY stale (rule 8): numbers that stopped moving look
      // identical to numbers that are current, which is the whole trap.
      const badge = document.getElementById('sseState');
      if (age > 90_000 && badge.textContent === 'live') { badge.textContent = 'stale'; badge.className = 'warn'; }
    }
  }, 15_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) backgroundRefresh(); });
  window.addEventListener('resize', () => { clearTimeout(state.rt); state.rt = setTimeout(render, 220); });
  // VIEWER MODES: the switch in every Block space viewer's control bar (mining.js VIEWER_MODES)
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-vmode]');
    if (!b) return;
    state.viewerMode = b.dataset.vmode;
    try { localStorage.setItem('blockyard.viewerMode', state.viewerMode); } catch { /* storage refused */ }
    mempoolDetail(true);
    render();
  });
  window.addEventListener('hashchange', () => {
    const p = location.hash.slice(1);
    if (p && p !== `${state.page}${state.xroute ? `/${state.xroute}` : ''}`) setPage(p);
  });

  // The node has to be on the URL. /api/state falls back to app.primary, so
  // selecting the attention node in `state.node` and then fetching without it
  // meant the page still opened on the synced production node -- the picker
  // looked right and the data underneath it was a different daemon.
  await backgroundRefresh();
  const ev = await api('/api/events?limit=200');
  state.events = ev.events ?? [];
  connect();
  setPage(location.hash.slice(1) || 'overview');
}

boot().catch((err) => {
  console.error(err);
  toast(`startup failed: ${err.message}`, 'bad');
});
