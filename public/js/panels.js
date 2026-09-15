// Page renderers other than Overview. Each reads `state` and paints into the DOM
// skeleton from index.html. Nothing here fetches on its own except where a
// payload is deliberately kept out of the live frame (mempool scatter, logs,
// admin) -- those have their own cadence.
import { lineChart, histogram, scatter, meter, stackedBars, paint, COL } from './charts.js';

const F = () => panelsFmt;
let panelsFmt = null;
export function setFmt(mod) { panelsFmt = mod; }

// ------------------------------------------------------------------ chain

export function renderChain(s, state, h) {
  if (!s) return;
  document.querySelectorAll('[data-sync-hero]').forEach((box) => {
    // The chain page shows the same component; app.js owns the renderer.
    h.renderSyncHero(box, s);
  });
  const fmt = F();
  const ser = state.series ?? {};
  const n = ser.node ?? {};
  const b = ser.blocks ?? {};

  const tip = n.tip ?? [];
  paint(h.canvas('chTipChart'), {
    when: tip.length > 1,
    draw: (c) => lineChart(c, [
      { label: 'blocks applied', color: COL.accent, points: tip, area: true },
    ], { fmtY: (v) => fmt.short(v), fmtTip: (v) => fmt.num(v), zeroBase: false }),
    placeholder: 'no tip samples yet',
  });
  h.setText('chTipNote', s.tip?.headers != null && s.tip?.height != null
    ? `<span title="Headers-first: this reaches 100% only when the last block lands">${fmt.num(s.tip.height)} of ${fmt.num(s.tip.headers)} announced headers applied</span>`
    : 'no header count reported yet');

  const gap = (b.gap ?? []).filter((p) => Number.isFinite(p.v));
  paint(h.canvas('chGapChart'), {
    when: gap.length > 1,
    draw: (c) => lineChart(c, [
      { label: 'seconds between blocks', color: COL.info, points: gap, area: true },
    ], { fmtY: (v) => `${Math.round(v)}s`, fmtTip: (v) => `${(v / 60).toFixed(1)} min`, marker: { v: 600, label: '10 min target', color: COL.ok } }),
    placeholder: 'need two blocks to measure an interval',
  });
  const stats = s.blocks?.recent ?? [];
  const gaps = stats.map((x) => x.gapSec).filter((x) => x != null && x >= 0 && x < 7200);
  h.setText('chGapNote', gaps.length
    ? `${gaps.length} intervals measured · median ${fmt.ageSec(median(gaps))} · ${gaps.filter((g) => g > 1200).length} over 20 min`
    : '');

  drawFromSeries(h, 'chSizeChart', b.size, COL.purple, (v) => fmt.bytes(v, 0), { fmtTip: (v) => fmt.bytes(v, 0) });
  // What the number *is*, stated where the number is drawn. The figure is
  // getblockstats' total_size -- the sum of transaction sizes -- not the serialized
  // block, and the difference is exactly the kind of thing a reader cannot recover
  // from a chart. When the basis is absent the chart is empty, and an empty chart
  // reads as "broken panel" unless the panel says otherwise: this figure sat empty
  // for a day because the request asked for statistics the endpoint has never had.
  const sizeRow = (s.blocks?.recent ?? [])[0] ?? null;
  // one line (2026-09-15, the packing pass): the basis sentence is the note's title, the figures its text
  h.setText('chSizeNote', sizeRow?.sizeBasis
    ? `<span class="mono" title="${fmt.esc(sizeRow.sizeBasis)}">total_size</span>`
      + (sizeRow.medianTxSize != null && sizeRow.swtotalSize != null && sizeRow.size != null
        ? ` · this block: median tx ${fmt.bytes(sizeRow.medianTxSize, 0)}, witness ${fmt.bytes(sizeRow.swtotalSize, 0)} of ${fmt.bytes(sizeRow.size, 0)}`
        : '')
    : (sizeRow?.sizeMissing ?? 'no block stats collected yet — the monitor has not seen a new height since it started'));
  drawFromSeries(h, 'chFeeChart', b.fee, COL.ok, (v) => fmt.short(v), { fmtTip: (v) => `${fmt.sats(v)} sat` });
  drawFromSeries(h, 'chTxChart', b.txs, COL.cyan, (v) => fmt.short(v));

  const txr = n.txRate ?? [];
  paint(h.canvas('chTxRateChart'), {
    when: txr.length > 1,
    draw: (c) => lineChart(c, [{ label: 'tx/s', color: COL.accent, points: txr, area: true }], { fmtY: (v) => fmt.short(v) }),
    placeholder: 'getchaintxstats has not answered yet',
  });
  const cs = s.chaintxstats;
  // ONE WRAPPING LINE (2026-09-15, the packing pass): as a four-column grid these overflowed a
  // 330px card and as two columns they made the card the row's tallest
  const item = (k, v) => `<span><span class="k">${k}</span><b>${v}</b></span>`;
  h.setText('chTxStats', cs
    ? item('window', `${fmt.num(cs.window_block_count ?? 0)} blocks`) + item('txs in window', fmt.num(cs.window_tx_count ?? 0))
      + item('all-time txs', fmt.num(cs.txcount ?? 0)) + item('rate', cs.txrate != null ? `${cs.txrate.toFixed(2)} tx/s` : '–')
    : '<span class="faint">not yet fetched</span>');

  h.setText('chState', kv([
    ['chain', s.chain ?? '–'],
    ['height', s.tip?.height != null ? fmt.num(s.tip.height) : '–'],
    ['headers', s.tip?.headers != null ? fmt.num(s.tip.headers) : '–'],
    // short forms: the list runs in two columns, and a full date or a 10+10 hash wrapped
    ['best hash', s.tip?.hash ? fmt.hash(s.tip.hash, 6) : '–'],
    ['tip time', s.tip?.time ? fmt.clock(s.tip.time * 1000) : '–'],
    ['tip age', s.tip?.ageSec != null ? fmt.ageSec(s.tip.ageSec) : '–'],
    ['progress', s.progress != null ? (s.progress * 100).toFixed(4) + '%' : '–'],
    ['on disk', s.sizeOnDisk != null ? fmt.bytes(s.sizeOnDisk, 0) : '–'],
    ['pruned', s.pruned == null ? '–' : String(s.pruned)],
    ['chain work', s.chainwork ? fmt.hash(s.chainwork.replace(/^0+/, '') || '0', 6) : '–'],
    ['IBD', s.ibd == null ? '–' : String(s.ibd)],
    ['uptime', s.uptimeSec != null ? fmt.uptime(s.uptimeSec * 1000) : '–'],
  ]));

  const u = s.utxo ?? {};
  h.setText('chUtxo', kv([
    ['coins', u.txouts != null ? fmt.num(u.txouts) : '–'],
    ['height', u.height != null ? fmt.num(u.height) : '–'],
    ['total amount', u.total_amount != null ? u.total_amount.toFixed(4) + ' BTC' : '–'],
    ['muhash', u.muhash ? fmt.hash(u.muhash, 8) : '–'],
  ]));
  drawFromSeries(h, 'chUtxoChart', n.txouts, COL.ok, (v) => fmt.short(v));

  h.setText('chDiff', kv([
    ['difficulty', s.difficulty != null ? fmt.short(s.difficulty) : '–'],
    // Suppressed during IBD by the monitor (difficulty ÷ a gap measured while applying
    // hundreds of blocks a second is not a hashrate), and the reason travels with it
    // so the dash is an explanation rather than a mystery.
    ['network hash', s.hashrateEstEh != null ? fmt.eh(s.hashrateEstEh)
      : `<span title="${fmt.esc(s.hashrateNote ?? '')}">–</span>`],
    ...(s.hashrateEstEh == null && s.hashrateNote ? [['hash rate note', `<span class="tiny faint">${fmt.esc(s.hashrateNote)}</span>`]] : []),
    ['avg interval', s.avgBlockGapSec != null ? fmt.ageSec(s.avgBlockGapSec) : '–'],
    ['reorgs seen', String(s.blocks?.reorgs ?? 0)],
  ]));
  drawFromSeries(h, 'chDiffChart', n.difficulty, COL.warn, (v) => fmt.short(v));

  const idx = s.indexes ?? {};
  const rows = Object.entries(idx).map(([name, v]) => `<tr><td>${fmt.esc(name)}</td>
    <td class="r">${v?.best_block_height != null ? fmt.num(v.best_block_height) : '–'}</td>
    <td class="${v?.synced ? 'ok' : 'warn'}">${v?.synced ? 'synced' : `behind${v?.best_block_height != null && s.tip?.height != null ? ' ' + fmt.num(s.tip.height - v.best_block_height) : ''}`}</td></tr>`);
  const itb = document.querySelector('#chIndexes tbody');
  if (itb) itb.innerHTML = rows.join('') || '<tr><td colspan="3" class="faint">getindexinfo has not answered</td></tr>';

  const ttb = document.querySelector('#chTips tbody');
  if (ttb) ttb.innerHTML = (s.tips ?? []).map((t) => `<tr><td>${fmt.num(t.height)}</td>
    <td class="r">${fmt.num(t.branchlen)}</td>
    <td class="${t.status === 'active' ? 'ok' : 'warn'}">${fmt.esc(t.status)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="faint">getchaintips has not answered</td></tr>';
}

// --------------------------------------------------------------- mempool

export function renderMempool(s, state, h, detail) {
  if (!s) return;
  const fmt = F();
  const mp = s.mempool ?? {};
  const d = mp.dist ?? null;
  const dd = detail?.dist ?? d;

  meter(h.canvas('mpMeter'), { value: mp.usage, max: mp.maxUsage, fmt: (v) => fmt.bytes(v, 0) });
  // No Block space viewer on this page any more (operator: "just remove the block space panel from
  // mempool entirely"). `poolViewer` is still exported by mining.js and still used by Overview,
  // Block space, Mining and the Kiosk -- only this page's call is gone, along with its import.
  h.setText('mpLimits', kv([
    ['transactions', mp.count != null ? fmt.num(mp.count) : '–'],
    ['serialized', mp.bytes != null ? fmt.bytes(mp.bytes) : '–'],
    ['memory used', mp.usage != null ? fmt.bytes(mp.usage) : '–'],
    ['limit', mp.maxUsage != null ? fmt.bytes(mp.maxUsage) : '–'],
    ['pool fees', mp.totalFee != null ? mp.totalFee.toFixed(5) + ' BTC' : '–'],
    ['min fee rate', mp.minFee != null ? fmt.satPerVb(mp.minFee) + ' sat/vB' : '–'],
    ['min relay', mp.minRelayFee != null ? fmt.satPerVb(mp.minRelayFee) + ' sat/vB' : '–'],
    ['unbroadcast', mp.unbroadcast ?? '–'],
    ['OP_RETURN max', mp.maxDataCarrier != null ? fmt.num(mp.maxDataCarrier) + ' B' : '–'],
    // COMPUTED ALL ALONG, NEVER SHOWN. server/collect/monitor.js has measured these on every
    // sample since the distribution existed; nothing on the page read them. They cost nothing to
    // draw and they answer the obvious question the byte total does not: how big is a typical
    // transaction in there, and what is the pool worth.
    ['total vsize', dd?.totalVsize != null ? fmt.bytes(dd.totalVsize) : '–'],
    ['average vsize', dd?.avgVsize != null ? fmt.num(dd.avgVsize) + ' vB' : '–'],
    ['fees in pool', dd?.totalFeeSat != null ? fmt.num(dd.totalFeeSat) + ' sat' : '–'],
  ]));

  const ser = state.series?.mempool ?? {};
  paint(h.canvas('mpSizeChart'), {
    when: (ser.hour ?? []).length > 1,
    draw: (c) => lineChart(c, [
      { label: 'transactions', color: COL.accent, points: ser.hour, area: true },
      { label: 'memory', color: COL.purple, points: ser.usageHour ?? [], axis: 'right' },
    ], { fmtY: (v) => fmt.short(v), fmtRight: (v) => fmt.short(v), fmtTip: (v) => fmt.short(v) }),
    placeholder: 'collecting mempool samples…',
  });

  paint(h.canvas('mpHistChart'), {
    when: !!dd?.hist?.counts,
    draw: (c) => histogram(c, dd.hist.counts, {
      edges: dd.hist.edges, color: COL.accent, fmtX: (v) => (v >= 1 ? fmt.short(v) : v.toFixed(1)),
      fmtY: (v) => fmt.short(v), axisLabel: 'sat/vB (log)',
      highlight: mp.minFee != null ? mp.minFee * 1e8 / 1000 : null,
    }),
    placeholder: 'waiting for getrawmempool (20 s tier)',
  });
  if (dd?.hist?.counts) {
    h.setText('mpHistNote', `${fmt.num(dd.count ?? 0)} transactions · median ${dd.p50Feerate ?? '–'} sat/vB · p90 ${dd.p90Feerate ?? '–'} · max ${dd.maxFeerate ?? '–'} · green bar = the pool's minimum fee rate`);
  }

  paint(h.canvas('mpScatter'), {
    when: !!dd?.scatter?.length,
    draw: (c) => scatter(c, dd.scatter, { logY: true, fmtX: (v) => fmt.ageSec(v), fmtY: (v) => fmt.short(v), yLabel: 'sat/vB (log)', color: 'rgba(247,147,26,.55)' }),
    placeholder: 'waiting for the mempool sample (20 s tier)',
  });
  if (dd?.scatter?.length) {
    h.setText('mpScatterNote', `${fmt.num(dd.scatter.length)} of ${fmt.num(dd.count ?? 0)} transactions plotted · dot area ∝ vsize · oldest in pool ${fmt.ageSec(dd.oldestSec)}`
      + (dd.ageUnknown ? ` · ${fmt.num(dd.ageUnknown)} report no entry time (time = 0) and are left out of the age charts` : ''));
  }

  paint(h.canvas('mpAgeChart'), {
    when: !!dd?.ageHist?.counts,
    draw: (c) => histogram(c, dd.ageHist.counts, {
      edges: dd.ageHist.edges, color: COL.info, fmtX: (v) => fmt.ageSec(v), axisLabel: 'age in pool',
    }),
    placeholder: 'waiting for getrawmempool',
  });

  const feeS = state.series?.fees ?? {};
  paint(h.canvas('mpFeeChart'), {
    when: (feeS.f6 ?? []).length > 1,
    draw: (c) => lineChart(c, [
      { label: '1 block', color: COL.accent, points: feeS.f1 ?? [] },
      { label: '2', color: COL.cyan, points: feeS.f2 ?? [] },
      { label: '6', color: COL.info, points: feeS.f6 ?? [] },
      { label: '24', color: COL.purple, points: feeS.f24 ?? [] },
      { label: '144', color: COL.ok, points: feeS.f144 ?? [] },
      { label: 'pool min', color: COL.bad, points: feeS.min ?? [] },
    ], { fmtY: (v) => fmt.satPerVb(v, 0), fmtTip: (v) => fmt.satPerVb(v) + ' sat/vB' }),
    placeholder: 'the fee estimator has no data yet',
  });

  // THESE TWO PANELS COME FROM THE NODE'S LOG, NOT FROM RPC. With the log tail off
  // (BLOCKYARD_LOG_SOURCE=0, which is this deployment) there is no source for any of it, and a
  // column of dashes would read as "the node has no orphans" rather than "we are not watching".
  // Say which it is, the same way the peers page says "not reported by this build".
  const noLog = state.cfg?.log?.enabled === false;
  // ...and when there is no log, the two cards that read it collapse to the sentence that says so,
  // rather than standing a 130px empty chart open under one line of text.
  //
  // BY ID, never by walking up from a child. The DOM stub the tests run against returns null from
  // that traversal, so a class toggled through it is silently skipped under test -- the suite stays
  // green while the browser shows a card that never collapses. web-contract.test.js forbids it
  // outright; `ovFeesCard` is the same lesson already learned once.
  // (And the rule is enforced by scanning this file for the call, so it must not be spelled out
  // here either -- writing it in a comment failed the guard exactly as using it would.)
  for (const id of ['mpAcceptCard', 'mpOrphansCard']) {
    document.getElementById(id)?.classList.toggle('lognone', noLog);
  }
  const acc = mp.rejects;
  if (noLog) {
    h.setText('mpAccept', '<dt>ingest &amp; rejects</dt><dd class="faint">needs the node\'s log; this monitor is running on RPC alone</dd>');
  } else h.setText('mpAccept', kv([
    ['ingest rate', mp.ingestRate != null ? mp.ingestRate.toFixed(2) + ' tx/s' : 'measuring…'],
    ['window', acc?.windowSec != null ? `${acc.windowSec}s` : '–'],
    ['accepted', acc ? fmt.num(acc.windowSec ? Math.round((state.snap?.mempool?.ingestRate ?? 0) * acc.windowSec) : 0) : '–'],
    ['missing inputs', acc ? fmt.num(acc.missingInputs) : '–'],
    ['policy reject', acc ? fmt.num(acc.policy) : '–'],
    ['invalid', acc ? fmt.num(acc.invalid) : '–'],
    ['already confirmed', acc ? fmt.num(acc.alreadyConfirmed) : '–'],
    ['last block drain', mp.lastDrain ? `${fmt.num(mp.lastDrain.removed)} tx at ${fmt.num(mp.lastDrain.height)}` : '–'],
  ]));
  const tf = state.series?.txflow ?? {};
  drawFromSeries(h, 'mpIngestChart', tf.accepted, COL.accent, (v) => fmt.short(v));

  const or = detail?.log?.orphans;
  const od = detail?.log?.orphanDetail;
  if (noLog) {
    h.setText('mpOrphans', '<dt>orphan pool</dt><dd class="faint">needs the node\'s log; this monitor is running on RPC alone</dd>');
  } else h.setText('mpOrphans', kv([
    ['held', or ? fmt.num(or.held) : '–'],
    ['parked', or ? fmt.num(or.parked) : '–'],
    ['resolved', or ? fmt.num(or.resolved) : '–'],
    ['dropped', or ? fmt.num(or.dropped) : '–'],
    ['1p1c accepted', or?.oneP1C ? fmt.num(or.oneP1C.accepted) : '–'],
    ['parents requested', od ? fmt.num(od.requested) : '–'],
    ['notfound', od ? fmt.num(od.notfound) : '–'],
    ['in flight', od ? fmt.num(od.inFlight) : '–'],
    ['gave up', od ? fmt.num(od.gaveUp) : '–'],
  ]));
  drawFromSeries(h, 'mpOrphanChart', tf.orphansParked, COL.warn, (v) => fmt.short(v));

  const nr = detail?.notReported ?? [];
  h.setText('mpNotReported', nr.length
    ? `This node's getrawmempool answers ${'<span class="mono">vsize, weight, time, fees.base</span>'} only. These Core fields are therefore <b>not shown rather than shown empty</b>: ${nr.map((x) => `<span class="mono">${fmt.esc(x)}</span>`).join(', ')}.`
    : 'Every field is populated.') ;
  // Keep the page's own refresh loop for the scatter alive.
  h.refreshMempoolDetail?.();
}

// ----------------------------------------------------------------- peers

export function renderPeers(s, state, h) {
  if (!s) return;
  const fmt = F();
  const p = s.peers ?? {};
  h.setText('prCount', p.connections == null ? '–' : fmt.num(p.connections));
  h.setText('prSplit', `in ${fmt.num(p.in ?? 0)} · out ${fmt.num(p.out ?? 0)}${p.wanted != null ? ` · wants ${p.wanted}` : ''}`);
  // only what the node reports: on this build every one of these answered "–" or
  // "not reported", seven rows saying nothing above the peer table
  const budget = [
    ['configured max', p.budget?.max], ['outbound budget', p.budget?.outbound], ['full relay', p.budget?.fullRelay],
    ['block-relay', p.budget?.blockRelay], ['feeler', p.budget?.feeler], ['inbound cap', p.budget?.inboundCap],
  ].filter(([, v]) => v != null).map(([k, v]) => [k, fmt.num(v)]);
  if (p.banned != null) budget.push(['banned', `${fmt.num(p.banned)} of ${fmt.num(p.bannedOf ?? 0)}`]);
  h.setText('prBudget', budget.length ? kv(budget) : '<dt>budget &amp; bans</dt><dd class="faint">not reported by this build</dd>');

  const ser = state.series?.peers ?? {};
  paint(h.canvas('prChart'), {
    when: (ser.connections ?? []).length > 1,
    draw: (c) => lineChart(c, [
      { label: 'connections', color: COL.ok, points: ser.connections, area: false },
      { label: 'inbound', color: COL.info, points: ser.in ?? [] },
      { label: 'outbound', color: COL.accent, points: ser.out ?? [] },
      { label: 'peers relaying', color: COL.purple, points: ser.relay ?? [] },
    ], { fmtY: (v) => fmt.short(v), zeroBase: false, legend: true }),
    placeholder: 'no connection samples yet',
  });


  const pr = (id, v) => h.setText(id, v);
  pr('ovPeers', p.connections == null ? '–' : fmt.num(p.connections));
  pr('ovPeersOf', p.wanted != null ? `of ${fmt.num(p.wanted)} wanted` : '');
  pr('ovPeerRelay', p.in != null || p.out != null ? `in ${fmt.num(p.in ?? 0)} · out ${fmt.num(p.out ?? 0)}` : '–');

  // The peer table getpeerinfo publishes (see peerTableHtml), and a sentence for what
  // it still does not. Earlier builds answered with no rows at all -- the second branch.
  const rows = state.peerRows;
  h.setText('prTable', peerTableHtml(rows, fmt, { tip: s.tip?.height ?? null }));
  pr('prIdentityNote', rows?.length
    ? `${fmt.num(rows.length)} peers, most bytes received first${p.byteCoverage != null ? ` (${(p.byteCoverage * 100).toFixed(1)}% of getnettotals received)` : ''} · rate = change over 15 s · height = reported at connect (synced_* answers -1 here) · no call publishes per-peer relay counts or blocks served`
    : p.rpcRows
    ? 'loading the peer table…'
    : `<span class="warn">getpeerinfo returns no rows</span> while getconnectioncount reports ${fmt.num(p.connections ?? 0)} connections — this build keeps its peer table in the forked download worker and publishes nothing per-peer over RPC. Peer identity, transport, user agent and per-peer bytes are therefore not shown anywhere in this monitor, and are not guessed from any other source.`);

  h.setText('prNet', '');

}

// THE PEER TABLE (operator, 2026-09-11: "Doesn't the node's rpc pull more info for peers
// now?"). It does: getpeerinfo on this build answers one row per connection -- address,
// network, user agent and protocol version, direction, when it connected, when it last
// received and sent, the bytes each way (summing to 99.99% of getnettotals, MEASUREMENTS
// 27), and how far it has synced -- and the server adds a rate from successive samples
// (withPeerRates). Most bytes received first. The page used to print only the row count.
export function peerTableHtml(rows, fmt, { now = Date.now(), tip = null } = {}) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const best = tip ?? Math.max(...rows.map((p) => p.synced_headers ?? p.synced_blocks ?? 0));
  const sorted = rows.slice().sort((a, b) => (b.bytesrecv ?? 0) - (a.bytesrecv ?? 0));
  const since = (sec) => (Number.isFinite(sec) && sec > 0 ? fmt.ageSec(Math.max(0, now / 1000 - sec)) : '–');
  const lag = (h) => (!Number.isFinite(h) || h < 0 ? '–' : best - h <= 0 ? 'tip' : `−${fmt.num(best - h)}`);
  // synced_headers / synced_blocks answer -1 on this build (not tracked), so the height a
  // peer reported when it connected stands in, with the blocks the chain has gained since
  const height = (q) => (Number.isFinite(q.synced_blocks) && q.synced_blocks >= 0
    ? lag(q.synced_blocks)
    : Number.isFinite(q.startingheight) && q.startingheight > 0
      ? `${fmt.num(q.startingheight)}${tip != null && tip > q.startingheight ? faint(`+${fmt.num(tip - q.startingheight)}`) : ''}`
      : '–');
  // the services that tell peers apart (every one here is NETWORK + WITNESS)
  const SVC = { P2P_V2: 'v2', COMPACT_FILTERS: 'filters', NETWORK_LIMITED: 'pruned', BLOOM: 'bloom' };
  const svc = (q) => (Array.isArray(q.servicesnames) ? q.servicesnames.map((n) => SVC[n]).filter(Boolean) : []);
  const ua = (s) => String(s ?? '').replace(/^\/|\/$/g, '') || '–';
  const faint = (s) => ` <span class="faint">${fmt.esc(s)}</span>`;
  const body = sorted.map((p) => `<tr>
    <td>${p.inbound ? '<span class="badge muted">in</span>' : '<span class="badge">out</span>'}</td>
    <td class="addr" title="${fmt.esc(p.addr ?? '')}">${fmt.esc(p.addr ?? '–')}${p.network ? faint(p.network) : ''}</td>
    <td class="w">${fmt.esc(ua(p.subver))}${p.version ? faint(String(p.version)) : ''}${svc(p).map((t) => ` <span class="badge muted">${t}</span>`).join('')}</td>
    <td class="r">${Number.isFinite(p.conntime) ? fmt.uptime((now / 1000 - p.conntime) * 1000) : '–'}</td>
    <td class="r">${since(p.lastrecv)}</td>
    <td class="r">${since(p.lastsend)}</td>
    <td class="r">${fmt.bytes(p.bytesrecv)} <span class="faint">${p.recvRate == null ? '–' : fmt.rate(p.recvRate)}</span></td>
    <td class="r">${fmt.bytes(p.bytessent)} <span class="faint">${p.sentRate == null ? '–' : fmt.rate(p.sentRate)}</span></td>
    <td class="r">${height(p)}</td>
    <td class="r">${Number.isFinite(p.timeoffset) ? `${p.timeoffset}s` : '–'}</td>
    <td class="w">${p.relaytxes === false ? '<span class="faint">blocks only</span>' : 'tx relay'}${Array.isArray(p.permissions) && p.permissions.length ? faint(p.permissions.join(',')) : ''}</td>
  </tr>`).join('');
  return `<table class="t peertbl"><thead><tr><th></th><th>peer</th><th>client</th><th>connected</th><th>last recv</th><th>last send</th><th>received</th><th>sent</th><th>height</th><th>clock</th><th>relay</th></tr></thead><tbody>${body}</tbody></table>`;
}

// --------------------------------------------------------------- network

export function renderNetwork(s, state, h) {
  if (!s) return;
  const fmt = F();
  const net = s.net ?? {};
  const ser = state.series?.net ?? {};
  h.setText('ntIn', net.inBps == null ? '–' : fmt.short(net.inBps));
  h.setText('ntInTotals', net.netTotalLog != null ? `${fmt.bytes(net.netTotalLog)} received since the last log tick reset` : 'no totals yet');
  h.setText('ntDisk', net.diskWriteBps == null ? '–' : fmt.short(net.diskWriteBps));
  h.setText('ntDiskTotals', net.diskTotal != null ? `${fmt.bytes(net.diskTotal)} written to the block archive` : 'no totals yet');

  drawFromSeries(h, 'ntInChart', ser.inHour, COL.cyan, (v) => fmt.short(v) + 'B/s', { fmtTip: (v) => fmt.rate(v) });
  drawFromSeries(h, 'ntDiskChart', ser.diskHour, COL.purple, (v) => fmt.short(v) + 'B/s', { fmtTip: (v) => fmt.rate(v) });

  // One note covers both directions: the reason is one mechanism (the peer byte
  // counters live in the forked download worker), and the honest sentence differs only
  // per direction. The element id still says "Upload" from when only that half was
  // unmeasurable; renaming it means touching index.html and the id contract test, so
  // the mismatch is commented here rather than silently carried in the prose.
  const dlMeas = !!net.downloadMeasured, upMeas = !!net.uploadMeasured;
  h.setText('ntUploadNote', dlMeas && upMeas
    ? 'The node reports both byte counters, so download and upload are measured directly.'
    : `<b class="warn">${[!dlMeas && 'Download', !upMeas && 'Upload'].filter(Boolean).join(' and ')} is not available.</b>
       <span class="mono">getnettotals</span> answers
       <span class="mono">${[!dlMeas && 'totalbytesrecv: 0', !upMeas && 'totalbytessent: 0'].filter(Boolean).join(', ')}</span>
       in this deployment — the peer byte counters live in the node's forked download
       worker and are not published to the RPC process. Nothing else on this box carries
       these numbers, so no figure is shown here rather than an invented one.`);
  h.setText('ntRpc', kv([
    ['totalbytesrecv (RPC)', net.totalRecvRpc != null ? fmt.num(net.totalRecvRpc) + ' B' : '–'],
    ['totalbytessent (RPC)', net.totalSentRpc != null ? fmt.num(net.totalSentRpc) + ' B' : '–'],
    ['upload target', net.uploadtarget?.target ? fmt.bytes(net.uploadtarget.target, 0) + ' / day' : 'none configured'],
    ['serve historical', net.uploadtarget?.serve_historical_blocks == null ? '–' : String(net.uploadtarget.serve_historical_blocks)],
  ]));
  h.setText('ntAccounting', kv([
    ['received (log)', net.netTotalLog != null ? fmt.bytes(net.netTotalLog) : '–'],
    ['written to disk (log)', net.diskTotal != null ? fmt.bytes(net.diskTotal) : '–'],
    ['average recv since start', net.avgRecv != null ? fmt.rate(net.avgRecv) : '–'],
    ['average write since start', net.avgWrite != null ? fmt.rate(net.avgWrite) : '–'],
    ['dead-weight floor', net.floor != null ? fmt.rate(net.floor) : '–'],
    ['pool median', net.poolMedian != null ? fmt.rate(net.poolMedian) : '–'],
    ['chain size on disk', s.sizeOnDisk != null ? fmt.bytes(s.sizeOnDisk, 0) : '–'],
  ]));

  const src = state.cfg?.sources ?? [];
  h.setText('ntSources', src.length
    ? `<div class="scroll"><table class="t"><thead><tr><th>panel</th><th>source</th><th>note</th></tr></thead><tbody>${
        src.map((x) => `<tr><td>${fmt.esc(x.panel)}</td><td class="mono tiny">${fmt.esc(x.source)}</td><td class="w tiny faint">${fmt.esc(x.note ?? '')}</td></tr>`).join('')
      }</tbody></table></div>`
    : 'config not loaded');
}

// ----------------------------------------------------------------- logs

let logsLoaded = false;
export function ensureLogsLoaded(state, h) {
  if (logsLoaded) return;
  logsLoaded = true;
  h.api('/api/events?limit=500').then((d) => {
    if (!state.events.length) state.events = d.events ?? [];
    h.render();
  }).catch(() => { logsLoaded = false; });
}

export function renderLogs(state, h) {
  const fmt = F();
  const rows = state.events ?? [];
  const kinds = [...new Set(rows.map((r) => r.kind).filter(Boolean))].slice(0, 40);
  const kindSel = document.getElementById('lgKind');
  if (kindSel && kindSel.options.length <= 1) {
    kindSel.insertAdjacentHTML('beforeend', kinds.map((k) => `<option value="${fmt.esc(k)}">${fmt.esc(k)}</option>`).join(''));
    kindSel.addEventListener('change', () => renderLogs(state, h));
    document.getElementById('lgSev')?.addEventListener('change', () => renderLogs(state, h));
    document.getElementById('lgSearch')?.addEventListener('input', () => renderLogs(state, h));
    document.getElementById('lgClear')?.addEventListener('click', () => { state.events = []; renderLogs(state, h); });
  }

  const q = (document.getElementById('lgSearch')?.value ?? '').toLowerCase();
  const sev = document.getElementById('lgSev')?.value ?? '';
  const kind = document.getElementById('lgKind')?.value ?? '';
  // Raw node log lines are not shown: the feed is the monitor's own observations.
  const wantRaw = false;

  let out = rows;
  if (sev) out = out.filter((r) => r.severity === sev);
  if (kind) out = out.filter((r) => r.kind === kind);
  if (!wantRaw) out = out.filter((r) => r.kind !== 'raw');
  if (q) out = out.filter((r) => `${r.text ?? ''} ${r.tag ?? ''} ${r.kind ?? ''} ${r.addr ?? ''}`.toLowerCase().includes(q));

  const el = document.getElementById('lgFeed');
  const cnt = document.getElementById('lgCount');
  if (cnt) cnt.textContent = `${out.length} of ${rows.length} buffered`;
  if (!el) return;
  el.innerHTML = out.slice(0, 600).map((r) => `<div class="row ${r.severity ?? 'info'}">
      <span class="ts">${fmt.clock(r.ts)}</span>
      <span class="tag">${fmt.esc(r.tagBase ?? r.kind ?? '')}</span>
      <span class="txt">${fmt.esc((r.text ?? '').slice(0, 400))}</span>
    </div>`).join('') || '<div class="row info"><span class="ts"></span><span class="tag"></span><span class="txt faint">nothing matches</span></div>';
}

// ------------------------------------------------------------------ node

export function renderNode(s, state, h) {
  if (!s) return;
  const fmt = F();
  const rpc = s.health?.rpc ?? {};
  h.setText('ndRpc', kv([
    ['endpoint', rpc.url ?? '–'],
    ['cookie source', rpc.cookieSource ? fmt.hash(rpc.cookieSource, 14) : '–'],
    ['in flight', '1 (by design)'],
    ['calls (60 s window)', String(rpc.ratePerSec ?? 0) + '/s'],
    ['total calls', fmt.num(rpc.calls)],
    ['batches', fmt.num(rpc.batches)],
    ['methods sent', fmt.num(rpc.methods)],
    ['last latency', rpc.lastLatencyMs != null ? rpc.lastLatencyMs + ' ms' : '–'],
    ['avg latency', rpc.avgLatencyMs != null ? rpc.avgLatencyMs + ' ms' : '–'],
    ['slowest seen', rpc.maxLatencyMs != null ? rpc.maxLatencyMs + ' ms' : '–'],
    ['lane busy', rpc.busyMsPerSec != null ? rpc.busyMsPerSec + ' ms/s' : '–'],
    ['errors / timeouts', `${fmt.num(rpc.errors)} / ${fmt.num(rpc.timeouts)}`],
    ['polls dropped as stale', fmt.num(rpc.staleDropped ?? 0)],
    ['breaker trips', fmt.num(rpc.breakerTrips)],
    ['queued now', fmt.num(rpc.queued)],
  ]));
  const lat = state.series?.rpc?.latency ?? [];
  paint(h.canvas('ndLatChart'), {
    when: lat.length > 1,
    draw: (c) => lineChart(c, [{ label: 'RPC latency ms', color: COL.info, points: lat, area: true }], { fmtY: (v) => `${Math.round(v)}` }),
    placeholder: 'no latency samples yet',
  });

  const cad = s.health?.cadence ?? {};
  const cb = document.querySelector('#ndCadence tbody');
  if (cb) cb.innerHTML = Object.entries(cad).map(([tier, v]) => `<tr>
      <td>${fmt.esc(tier)}</td>
      <td class="r">${(v.configuredMs / 1000).toFixed(0)}s</td>
      <td class="r ${v.effectiveMs > v.configuredMs ? 'warn' : ''}">${(v.effectiveMs / 1000).toFixed(1)}s</td>
      <td class="r faint">${v.lastRunMs != null ? v.lastRunMs + 'ms' : '–'}</td></tr>`).join('')
    || '<tr><td colspan="4" class="faint">no tiers have run</td></tr>';
  h.setText('ndCadenceNote', s.health?.cadenceStretched
    ? '<span class="warn">Cadence is stretched.</span> The node\'s RPC is slow right now, so these tiers are deliberately polling less often rather than queueing requests behind a single-threaded server. This recovers on its own when the node answers faster.'
    : 'All tiers at their configured cadence.');

  const q = s.health?.quality ?? [];
  h.setText('ndQuality', q.length
    ? q.map((x) => `<div class="caveat${x.severity === 'warn' ? ' bad' : ''}"><b>${fmt.esc(x.key)}</b> — ${fmt.esc(x.text)} <span class="faint tiny">(${fmt.ago(x.at)})</span></div>`).join('')
    : '<div class="note ok tiny">No quality flags: every panel is backed by a live figure.</div>');

  h.setText('ndSelf', kv(Object.entries(s.app?.self ?? state.snap?.app?.self ?? {}).map(([k, v]) => [k, typeof v === 'number' ? fmt.short(v) : String(v)])));
  drawSelf(h, s);

  const t = s.log ?? {};
  const lh = t.health ?? {};
  h.setText('ndTail', kv([
    ['file', t.source === 'disabled'
      ? '<span class="faint">disabled — running on RPC only</span>'
      : (t.file ? fmt.hash(t.file, 16) : 'not configured')],
    ['exists', t.exists == null ? '–' : String(t.exists)],
    ['size', t.size != null ? fmt.bytes(t.size, 1) : '–'],
    ['read to', t.pos != null ? fmt.bytes(t.pos, 1) : '–'],
    ['lag', t.lagBytes != null ? fmt.bytes(t.lagBytes, 1) : '–'],
    ['events parsed', fmt.num(t.events)],
    ['rotations handled', fmt.num(t.rotations)],
    ['truncations handled', fmt.num(t.truncations)],
    ['read errors', fmt.num(t.readErrors)],
    ['last event', t.lastEventAt ? fmt.ago(t.lastEventAt) : '–'],
    ['backfilled', String(t.backfilled ?? false)],
    // The two figures that separate "this node is quiet" from "we are tailing the
    // wrong file". A tail that stops moving is invisible in every other panel.
    ['lines matched', lh.ratio != null
      ? `${Math.round(lh.ratio * 100)}%${lh.lines ? ` <span class="faint tiny">(${fmt.num(lh.parsed)}/${fmt.num(lh.lines)} last window)</span>` : ''}`
      : '<span class="faint">not checked yet</span>'],
    ['last new bytes', lh.lastGrowthAt
      ? `${fmt.ago(lh.lastGrowthAt)} <span class="faint tiny">(warns after ${lh.staleAfterMs ? Math.round(lh.staleAfterMs / 60000) : '?'} min)</span>`
      : '–'],
  ]));

  const src = state.cfg?.sources ?? [];
  h.setText('ndSources', src.length
    ? `<table class="t"><thead><tr><th>panel</th><th>source</th><th>why</th></tr></thead><tbody>${
        src.map((x) => `<tr><td>${fmt.esc(x.panel)}</td><td class="mono tiny">${fmt.esc(x.source)}</td><td class="w tiny faint">${fmt.esc(x.note ?? '')}</td></tr>`).join('')
      }</tbody></table>`
    : 'config not loaded');

  bindConsole(h);
  bindConnection(h);
  // PREFILL ONCE, and only where the operator has not typed. This page repaints every second, and
  // rewriting an <input> under the cursor is how a form eats what is being entered. The data
  // directory is not in the snapshot, so it is left blank on purpose -- the server reads a blank
  // datadir as "keep the one already configured", never as "clear it".
  const put = (id, v) => { const e = document.getElementById(id); if (e && !e.value && v) e.value = v; };
  put('cnUrl', rpc.url);
  put('cnLabel', s.label);
  const chainSel = document.getElementById('cnChain');
  if (chainSel && !chainSel.dataset.set && s.chain) {
    chainSel.value = ['main', 'test', 'signet', 'regtest'].includes(s.chain) ? s.chain : 'main';
    chainSel.dataset.set = '1';
  }
}

// THE LAST READING STANDS (operator, 2026-09-13: "This section shows info, then it disappears.
// Can we not make info go away, and just have it updated?").
//
// Every figure here was re-derived from the frame being painted, so ANY frame without `app.self`
// -- the first paint before the stream has answered, a reconnect, a paused stream, an error frame
// -- rewrote the whole block as seven dashes. The values did not go stale; they were erased and
// replaced by placeholders, which reads as the panel breaking rather than as the panel waiting.
//
// A figure now only ever changes when there is a NEW figure. `–` survives exactly as long as
// nothing has ever been read, which is the one time it is honest.
const SELF_LAST = {};
function drawSelf(h, s) {
  const fmt = F();
  const t = s.app?.self ?? {};
  // keep(key, value) -- remember it when it is real, otherwise reuse what we last knew
  const keep = (k, v) => {
    if (v != null) SELF_LAST[k] = v;
    return SELF_LAST[k] ?? '–';
  };
  h.setText('ndSelf', kv([
    ['resident', keep('rss', t.rssMb != null ? `${t.rssMb} MB` : null)],
    ['heap', keep('heap', t.heapMb != null ? `${t.heapMb} MB` : null)],
    ['cpu', keep('cpu', t.cpuPct != null ? `${t.cpuPct.toFixed(1)}%` : null)],
    ['sse clients', keep('sse', s.app?.sseClients != null ? String(s.app.sseClients) : null)],
    ['active users', keep('users', t.usersActive != null ? String(t.usersActive) : null)],
    ['events/s', keep('events', t.eventRate != null ? String(t.eventRate) : null)],
    ['app uptime', keep('uptime', s.app?.uptimeSec != null ? fmt.uptime(s.app.uptimeSec * 1000) : null)],
  ]));

  // THE CHART IS FED BY A RING THE SERVER NEVER SENDS. app.selfRing collects a row every 10 s and
  // caps at 5,000, but nothing exports it -- `s.app.selfHistory` is undefined on every frame ever
  // served, so this branch has always been dead and the panel has always said "no self history
  // yet". Rather than leave a permanent placeholder, the client keeps its own short history from
  // the readings it is already being given, which needs no server change and cannot go stale.
  const rows = (s.app?.selfHistory) ?? SELF_SERIES;
  if (t.rssMb != null && (!SELF_SERIES.length || SELF_SERIES[SELF_SERIES.length - 1].t !== t.t)) {
    SELF_SERIES.push({ t: t.t ?? Date.now(), rssMb: t.rssMb });
    if (SELF_SERIES.length > 480) SELF_SERIES.shift();     // ~8 minutes at one a second
  }
  if (rows && rows.length > 1) {
    lineChart(h.canvas('ndSelfChart'), [{ label: 'rss MB', color: COL.cyan, points: rows.map((r) => ({ t: r.t, v: r.rssMb })), area: true }], { fmtY: (v) => `${Math.round(v)}` });
  } else {
    paint(h.canvas('ndSelfChart'), { when: false, draw: () => {}, placeholder: 'gathering…' });
  }
}
const SELF_SERIES = [];

let consoleBound = false;
function bindConsole(h) {
  if (consoleBound) return;
  consoleBound = true;
  const run = async () => {
    const method = (document.getElementById('rpcMethod').value || '').trim();
    const out = document.getElementById('rpcOut');
    if (!method) { out.textContent = 'enter a method'; return; }
    let params = [];
    const raw = (document.getElementById('rpcParams').value || '').trim();
    if (raw) {
      try { params = JSON.parse(raw); } catch (e) { out.textContent = `params is not valid JSON: ${e.message}`; return; }
      if (!Array.isArray(params)) { out.textContent = 'params must be a JSON array, e.g. [6]'; return; }
    }
    out.textContent = '…';
    const t0 = Date.now();
    try {
      const r = await h.api('/api/rpc', { method: 'POST', body: { method, params, node: h.state.node } });
      out.textContent = `${r.method} · ${r.ms ?? Date.now() - t0} ms\n\n${JSON.stringify(r.result, null, 1)}`;
      if (r.note) out.textContent += `\n\nnote: ${r.note}`;
    } catch (err) {
      out.textContent = `${err.message}${err.payload?.error?.code ? `\ncode: ${err.payload.error.code}` : ''}`;
    }
  };
  document.getElementById('rpcRun').addEventListener('click', run);
  ['rpcMethod', 'rpcParams'].forEach((id) => document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); }));
}

// ---- the node connection form (index.html, Node & RPC page) --------------------------------
// TEST FIRST, SAVE SECOND. `save` stays disabled until a test has ANSWERED, and goes back to
// disabled the moment any field changes -- a configuration nobody reached is not one worth
// keeping, and a green tick next to an edited field would be a lie about what was tested.
let connBound = false;
let connTested = false;
function bindConnection(h) {
  if (connBound) return;
  connBound = true;
  const el = (id) => document.getElementById(id);
  const out = el('cnOut');
  if (!out) return;
  const fmt = F();
  const body = () => ({
    rpcUrl: (el('cnUrl').value || '').trim(),
    datadir: (el('cnDatadir').value || '').trim(),
    chainHint: el('cnChain').value,
    label: (el('cnLabel').value || '').trim(),
  });
  const invalidate = () => { connTested = false; el('cnSave').disabled = true; };
  for (const id of ['cnUrl', 'cnDatadir', 'cnLabel']) el(id).addEventListener('input', invalidate);
  el('cnChain').addEventListener('change', invalidate);

  el('cnTest').addEventListener('click', async () => {
    out.textContent = 'testing…';
    try {
      const r = await h.api('/api/config/node/test', { method: 'POST', body: body() });
      if (r.ok) {
        connTested = true;
        el('cnSave').disabled = false;
        out.innerHTML = `<b class="ok">answered in ${r.ms} ms</b> — chain ${fmt.esc(String(r.chain ?? '?'))}, `
          + `${fmt.num(r.blocks ?? 0)} blocks${r.ibd ? ', still in initial block download' : ''}`;
      } else {
        invalidate();
        out.innerHTML = `<b class="bad">no answer</b> — ${fmt.esc(r.error?.message ?? 'unknown')}`;
      }
    } catch (err) { invalidate(); out.textContent = err.message; }
  });

  el('cnSave').addEventListener('click', async () => {
    if (connTested !== true) return;          // belt and braces with the disabled attribute
    out.textContent = 'saving…';
    try {
      const r = await h.api('/api/config/node', { method: 'POST', body: { ...body(), confirm: 'save' } });
      // The environment is applied AFTER the file (server/config.js), so on a box whose unit sets
      // BLOCKYARD_NODE_URL the save is real and still will not take effect. Say so loudly rather
      // than report a success the next restart quietly contradicts.
      out.innerHTML = `<b class="ok">saved to ${fmt.esc(r.file)}</b> — ${fmt.esc(r.note)}`;
    } catch (err) { out.textContent = err.message; }
  });
}

// ---------------------------------------------------------------- admin

export async function renderAdmin(s, state, h, force = false) {
  if (!h.state.user) return;
  const fmt = F();
  if (force || !document.querySelector('#adUsers tbody').dataset.loaded) loadAdmin(h, force);

  const acts = state.actions ?? [];
  h.setText('adActions', acts.length
    ? `<table class="t"><thead><tr><th>action</th><th>role</th><th>state</th></tr></thead><tbody>${
        acts.map((a) => `<tr><td class="w"><b>${fmt.esc(a.label)}</b><div class="tiny faint">${fmt.esc(a.note ?? '')}</div></td>
          <td>${fmt.esc(a.requiredRole)}</td>
          <td class="${a.enabled ? (a.permittedForYou ? 'ok' : 'warn') : 'faint'}">${a.enabled ? (a.permittedForYou ? 'enabled for you' : 'enabled, needs ' + a.requiredRole) : 'disabled'}</td></tr>`).join('')
      }</tbody></table>`
    : '<span class="faint">No actions configured. Node writes stay off unless the operator both enables them and names them, because a monitoring tool that can restart your node is a different kind of accident.</span>');
}

async function loadAdmin(h, force) {
  const fmt = F();
  try {
    if (h.state.user?.role !== 'admin') return;
    const [users, actions, audit] = await Promise.all([h.api('/api/users'), h.api('/api/actions'), h.api('/api/audit?limit=60')]);
    h.state.actions = actions.actions;
    const tb = document.querySelector('#adUsers tbody');
    tb.dataset.loaded = '1';
    tb.innerHTML = users.users.map((u) => `<tr>
        <td>${fmt.esc(u.username)}${u.disabled ? ' <span class="bad">(disabled)</span>' : ''}${u.kdfNeedsUpgrade
          ? ` <span class="warn tiny" title="stored hash uses N=${u.kdf?.N ?? '?'}, r=${u.kdf?.r ?? '?'}, p=${u.kdf?.p ?? '?'}; this server is configured for more. Nothing is broken -- the cost rises for this account the next time it logs in with the correct password">kdf behind</span>`
          : ''}</td>
        <td>${fmt.esc(u.role)}</td>
        <td class="faint">${new Date(u.createdAt).toLocaleDateString()}</td>
        <td class="faint">${u.lastLoginAt ? fmt.ago(u.lastLoginAt) : 'never'}</td>
        <td class="r">
          <button class="btn" data-act="role" data-u="${fmt.esc(u.username)}">role</button>
          <button class="btn" data-act="disable" data-u="${fmt.esc(u.username)}">${u.disabled ? 'enable' : 'disable'}</button>
        </td></tr>`).join('');
    tb.onclick = async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const u = b.dataset.u;
      try {
        if (b.dataset.act === 'role') {
          const role = prompt(`new role for ${u} (viewer|operator|admin)`);
          if (!role) return;
          await h.api(`/api/users/${encodeURIComponent(u)}/role`, { method: 'POST', body: { role } });
        } else {
          const cur = users.users.find((x) => x.username === u);
          await h.api(`/api/users/${encodeURIComponent(u)}/disabled`, { method: 'POST', body: { disabled: !cur.disabled } });
        }
        h.toast('user updated', 'ok');
        loadAdmin(h, true);
      } catch (err) { h.toast(err.message, 'bad'); }
    };

    h.setText('adActions', null);
    renderAdminActions(h, actions);

    const atb = document.querySelector('#adAudit tbody');
    atb.innerHTML = (audit.entries ?? []).map((x) => `<tr>
      <td class="faint">${fmt.clock(x.at)}</td>
      <td class="${/denied|rejected|fail/.test(x.type ?? '') ? 'bad' : ''}">${fmt.esc(x.type)}</td>
      <td>${fmt.esc(x.username ?? '–')}</td>
      <td class="w tiny faint">${fmt.esc([x.method, x.action, x.reason, x.error, x.target].filter(Boolean).join(' · ') || '')}</td></tr>`).join('')
      || '<tr><td colspan="4" class="faint">nothing recorded yet</td></tr>';

    // The size of the trail is part of the trail's story: it rotates by size now, and
    // a rotation that failed is written here rather than only to stdout.
    const size = document.getElementById('adAuditSize');
    if (size) {
      const g = audit.log ?? {};
      const mb = (n) => `${((n ?? 0) / 1048576).toFixed(2)} MB`;
      size.innerHTML = g.rotationError
        ? `<span class="bad">rotation failed: ${fmt.esc(g.rotationError)}</span> — the file is growing past its ${mb(g.maxBytes)} budget until that succeeds`
        : `${mb(g.currentBytes)} of ${mb(g.maxBytes)} used · ${fmt.num(g.rotations ?? 0)} rotation(s) · keeping ${g.keep ?? '–'} previous file(s) (${(g.files ?? []).length} on disk)`;
    }

    document.getElementById('btnGen').onclick = async () => {
      const username = document.getElementById('newUser').value.trim();
      const role = document.getElementById('newRole').value;
      if (!username) return h.toast('enter a username', 'bad');
      try {
        const r = await h.api('/api/users/generate', { method: 'POST', body: { username, role } });
        // Shown once, in the DOM, and deliberately never cached anywhere.
        document.getElementById('adGen').innerHTML = `<span class="ok">created ${fmt.esc(r.user.username)}</span> · password
          <span class="mono accent select-all">${fmt.esc(r.password)}</span> — ${fmt.esc(r.warning)}`;
        h.toast('user created', 'ok');
        loadAdmin(h, true);
      } catch (err) { h.toast(err.message, 'bad'); }
    };
    document.getElementById('btnPw').onclick = async () => {
      try {
        const r = await h.api('/api/password', {
          method: 'POST',
          body: { current: document.getElementById('pwCurrent').value, password: document.getElementById('pwNew').value },
        });
        h.toast(r.note ?? 'password changed', 'ok');
        setTimeout(() => { window.location.href = '/login'; }, 900);
      } catch (err) { h.toast(err.message, 'bad'); }
    };
  } catch (err) {
    if (err.status !== 403) h.toast(err.message, 'bad');
  }
}

function renderAdminActions(h, actions) {
  const fmt = F();
  const el = document.getElementById('adActions');
  if (!el) return;
  el.outerHTML = `<div id="adActions">${actions.actions.length
    ? `<table class="t"><thead><tr><th>action</th><th>role</th><th>state</th></tr></thead><tbody>${
        actions.actions.map((a) => `<tr><td class="w"><b>${fmt.esc(a.label)}</b><div class="tiny faint">${fmt.esc(a.note ?? '')}</div></td>
          <td>${fmt.esc(a.requiredRole)}</td>
          <td class="${a.enabled ? (a.permittedForYou ? 'ok' : 'warn') : 'faint'}">${a.enabled ? (a.permittedForYou ? 'enabled for you' : `enabled, needs ${a.requiredRole}`) : 'disabled'}</td></tr>`).join('')
      }</tbody></table><div class="note tiny faint mt-6">Enabled actions: ${actions.allowed.length ? actions.allowed.map(fmt.esc).join(', ') : 'none'} · feature flag ${actions.enabled ? 'on' : 'off'}</div>`
    : '<span class="faint">No actions configured.</span>'}</div>`;
}

// ---------------------------------------------------------------- shared

/**
 * The house chart call. Delegates to paint(), which will NOT clear a canvas that
 * already shows data: a gap in sampling costs an amber "no fresh data" pill, not
 * the chart. This is why every panel goes through here rather than calling
 * lineChart/empty directly.
 */
function drawFromSeries(h, id, points, color, fmtY, extra = {}) {
  paint(h.canvas(id), {
    when: Array.isArray(points) && points.length > 1,
    draw: (c) => lineChart(c, [{ label: '', color, points, area: true }], { fmtY, ...extra }),
    placeholder: extra.placeholder ?? 'waiting for samples',
  });
}

function kv(pairs) {
  return pairs.map(([k, v]) => `<dt>${String(k)}</dt><dd>${String(v)}</dd>`).join('');
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function init(fmtModule) { panelsFmt = fmtModule; }

// ------------------------------------------------------------ block drill-down

let drillBound = false;

/**
 * Inspect one block, then any transaction inside it.
 *
 * This exists because "which transaction?" previously had exactly one answer in
 * this app: type an RPC into the console. That is a shell, not a view. The shape is
 * deliberately constrained by what the node can afford (see /api/block):
 *
 *   * the header and stats come from getblock verbosity=1 + getblockstats, never
 *     verbosity=2 — measured 2026-09-08, that costs this node 11 MB of hex per
 *     block and still omits Core's fee fields;
 *   * txids are listed as buttons rather than dumped, because a block has up to
 *     ~6,000 of them and a wall of 64-character strings is not a readable list;
 *   * the transaction pane shows what the node decoded, plus `notReported` naming
 *     the fee — which is not computable here without N extra turns on a
 *     single-threaded RPC server, and is not in this node's reply either.
 */
export function initChainDrill(h) {
  const runBtn = document.getElementById('bdRun');
  const input = document.getElementById('bdQuery');
  if (!runBtn || !input) return;
  if (drillBound) return;
  drillBound = true;

  const hdr = () => document.getElementById('bdHeader');
  const list = () => document.getElementById('bdTxids');
  const txBox = () => document.getElementById('bdTx');

  const showTx = async (txid, blockHash) => {
    const box = txBox();
    if (!box) return;
    const fmt = F();
    box.innerHTML = '<div class="note tiny faint">decoding…</div>';
    const qs = new URLSearchParams({ txid });
    if (blockHash) qs.set('block', blockHash);
    if (h.state.node) qs.set('node', h.state.node);
    let d;
    try {
      d = await h.api(`/api/tx?${qs}`);
    } catch (err) {
      box.innerHTML = `<div class="caveat bad">${fmt.esc(err.message)}</div>`;
      return;
    }
    if (!d.ok) {
      box.innerHTML = `<div class="caveat bad"><b>${fmt.esc(d.error?.message ?? 'the node refused')}</b>${d.hint ? `<div class="tiny">${fmt.esc(d.hint)}</div>` : ''}</div>`;
      return;
    }
    const rows = [
      ['txid', `<span class="mono tiny select-all">${fmt.esc(d.txid ?? txid)}</span> <a class="xlink" href="#explorer/tx/${encodeURIComponent(d.txid ?? txid)}">open in the explorer ›</a>`],
      ['in', d.inMempool ? '<span class="warn">mempool (unconfirmed)</span>' : `block ${fmt.esc(d.blockHash ?? '?')}`],
      ['confirmations', d.confirmations == null ? '– (in the pool)' : fmt.num(d.confirmations)],
      ['size / vsize / weight', [d.size, d.vsize, d.weight].map((v) => (v == null ? '–' : fmt.num(v))).join(' / ')],
      ['locktime', d.locktime ?? 0],
      ['inputs', `${fmt.num(d.inputsTotal)}${d.inputsTotal > (d.inputs?.length ?? 0) ? ` (first ${d.inputs?.length} shown)` : ''}`],
      ['outputs', `${fmt.num(d.outputsTotal)}${d.outputsTotal > (d.outputs?.length ?? 0) ? ` (first ${d.outputs?.length} shown)` : ''}`],
      ['total out', d.totalOutSat != null ? `${fmt.num(d.totalOutSat)} sat` : '–'],
    ];
    const io = (rows2, label) => `<div class="note tiny mt-6"><b>${label}</b></div><table class="t"><tbody>${rows2}</tbody></table>`;
    const inRows = (d.inputs ?? []).map((v) => `<tr><td class=\"mono tiny w\">${fmt.esc(String(v.txid ?? 'coinbase').slice(0, 16))}…:${v.vout ?? '–'}</td><td class=\"tiny faint\">${fmt.esc(v.scriptSigType ?? '')} ${fmt.esc(v.scriptSigAsm ?? '')}</td></tr>`).join('');
    const outRows = (d.outputs ?? []).map((v) => `<tr><td class=\"r faint\">${v.n ?? '–'}</td><td class=\"mono tiny\">${fmt.esc(String(v.address ?? v.scriptPubKeyType ?? '–'))}</td><td class=\"r\">${v.value == null ? '–' : fmt.num(v.value)}</td></tr>`).join('');
    box.innerHTML = `<div class=\"drill\">
      <dl class=\"kv\">${kv(rows)}</dl>
      ${inRows ? io(inRows, `inputs (${d.inputsTotal})`) : ''}
      ${outRows ? io(outRows, `outputs (${d.outputsTotal})`) : ''}
      ${(d.notReported ?? []).length ? `<div class=\"note tiny faint mt-6\">not reported: ${d.notReported.map(fmt.esc).join(' · ')}</div>` : ''}
      ${(d.notes ?? []).map((n) => `<div class=\"note tiny faint\">${fmt.esc(n)}</div>`).join('')}
    </div>`;
  };

  const run = async () => {
    const fmt = F();
    const q = (input.value || '').trim();
    const node = h.state.node;
    if (hdr()) hdr().innerHTML = '<dt>loading</dt><dd>…</dd>';
    if (list()) list().innerHTML = '';
    if (txBox()) txBox().innerHTML = '';
    const qs = new URLSearchParams();
    if (/^\d{1,12}$/.test(q)) qs.set('height', q);
    else if (/^[0-9a-fA-F]{64}$/.test(q)) qs.set('hash', q);
    else if (q) { h.toast('enter a block height or a 64-character block hash', 'bad'); return; }
    if (node) qs.set('node', node);
    let d;
    try {
      d = await h.api(`/api/block?${qs}`);
    } catch (err) {
      if (hdr()) hdr().innerHTML = `<dt>failed</dt><dd class=\"bad\">${fmt.esc(err.message)}</dd>`;
      return;
    }
    if (!d.ok) {
      if (hdr()) hdr().innerHTML = `<dt>node refused</dt><dd class=\"bad\">${fmt.esc(d.error?.message ?? 'unknown error')}</dd>`;
      if (txBox()) txBox().innerHTML = d.hint ? `<div class=\"note tiny faint\">${fmt.esc(d.hint)}</div>` : '';
      return;
    }
    const b = d.header ?? {};
    const st = d.stats ?? {};
    if (hdr()) hdr().innerHTML = kv([
      ['height', b.height == null ? '–' : `<a class="xlink" href="#explorer/block/${b.height}">${fmt.num(b.height)}</a> <span class="tiny faint">open in the explorer</span>`],
      ['hash', `<span class=\"mono tiny select-all\">${fmt.esc(String(b.hash ?? '').slice(0, 24))}…</span>`],
      ['confirmations', b.confirmations == null ? '–' : `${fmt.num(b.confirmations)}${b.confirmations === 0 ? ' <span class=\"bad\">(not on the best chain)</span>' : ''}`],
      ['time', b.time ? `${new Date(b.time * 1000).toISOString().replace('T', ' ').slice(0, 19)}Z` : '–'],
      ['age', b.time ? fmt.ago(b.time * 1000) : '–'],
      ['size / weight', `${b.size == null ? '–' : fmt.bytes(b.size, 0)} / ${b.weight == null ? '–' : fmt.num(b.weight)} WU`],
      ['transactions', fmt.num(b.nTx ?? b.txCount ?? 0)],
      ['fees', st.totalfee == null ? (d.statsError ? '<span class=\"warn\">getblockstats failed</span>' : '–') : `${fmt.num(st.totalfee)} sat`],
      ['median fee', st.medianfee == null ? '–' : `${fmt.num(st.medianfee)} sat`],
      ['fee rate p10/50/90', (st.feerate_percentiles ?? []).length ? st.feerate_percentiles.map((v) => Number(v).toFixed(1)).join(' / ') : '–'],
      ['subsidy', st.subsidy == null ? '–' : `${fmt.num(st.subsidy)} sat`],
      ['utxo delta', st.utxo_increase == null ? '–' : fmt.num(st.utxo_increase)],
      ['prev / next', `<span class=\"mono tiny\">${fmt.esc(String(b.previousblockhash ?? '–').slice(0, 10))}… / ${fmt.esc(String(b.nextblockhash ?? 'none').slice(0, 10))}…</span>`],
      ['merkle root', `<span class=\"mono tiny\">${fmt.esc(String(b.merkleRoot ?? '–').slice(0, 16))}…</span>`],
    ]);
    const ids = d.txids ?? [];
    if (list()) {
      list().innerHTML = ids.map((t, i) => `<button data-txid=\"${fmt.esc(t)}\"${b.hash ? ` data-block=\"${fmt.esc(b.hash)}\"` : ''} title=\"${i === 0 ? 'coinbase' : `transaction ${i} of ${d.txidsTotal}`}\">${fmt.esc(t.slice(0, 10))}…</button>`).join('')
        + (d.truncated ? `<span class=\"tiny faint\">+${(d.txidsTotal ?? ids.length) - ids.length} more (list is capped; ask the RPC console)</span>` : '');
      list().onclick = (e) => {
        const btn = e.target.closest('button[data-txid]');
        if (btn) showTx(btn.dataset.txid, btn.dataset.block);
      };
    }
  };

  runBtn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  // Open on the tip when the page is first visited: an empty box invites nobody to
  // type, and one click on a real block is what shows the shape of the view.
  h.drillRun = run;
}
