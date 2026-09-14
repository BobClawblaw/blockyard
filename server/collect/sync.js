// Sync state: the single place that decides "how far along is this node", and
// how far it may reach in confidence.
//
// Two progress numbers exist and they are NOT the same measurement, so this
// module keeps them apart and labels each:
//
//   heightRatio = blocks / headers
//     The share of already-ANNOUNCED headers whose blocks we hold. This node is
//     headers-first (docs/RPC_LIVE_NODE.md, README "Initial block download"), so
//     headers race to the chain tip almost immediately and this ratio runs low
//     for most of a sync and reaches 1 only at the end. That is exactly the
//     0%->100% shape wanted for the bar, and it is a real quantity: we do not
//     have a block for a header we have not been given.
//
//   verificationProgress = getblockchaininfo.verificationprogress
//     Core's difficulty-weighted estimate, which this node reproduces. It is a
//     better measure of "how much work is done" mid-sync, but it is an estimate
//     and it saturates towards 1 well before the last block lands.
//
// They are never averaged, maxed or otherwise merged into one number. The bar
// draws heightRatio; verificationProgress is drawn as a second, separately
// labelled marker on the same track.
import { formatEta } from '../util/fmt.js';

const RATE_WINDOW_RECENT = '2 minutes';

export const STATE = {
  UNKNOWN: 'unknown',
  IBD: 'ibd',
  CATCHING_UP: 'catching_up',
  SYNCED: 'synced',
  STALLED: 'stalled',
  REORG: 'reorg',
};

// No block after this many seconds while not in IBD is a stall. Two expected
// intervals plus slack: a node on a quiet chain legitimately waits ~20 min for
// the next block, so anything under that must not raise a stall flag.
const STALL_SEC = 2400;
// A LONG GAP IS NOT A STALL (2026-09-14: two independent nodes at the same height, no block for
// 42 minutes, and the header said STALLED in red -- "Production is fucked now"). The network finds
// no block for 40 minutes about once in fifty; a node is stalled only when its PEERS know a higher
// tip than it holds. With no peer heights to ask, the old age alone must be well past what a gap
// can be before the word is used.
const STALL_ALONE_SEC = 7200;
// "Synced" also requires the tip to be this close to now, to avoid calling a
// node that lost all its peers "synced".
const FRESH_SEC = 3600;

export function computeSync({
  now = Date.now(),
  blocks = null,
  headers = null,
  ibd = null,
  verificationProgress = null,
  tipTime = null,
  bestHash = null,
  sizeOnDisk = null,
  chain = null,
  warnings = [],
  blockRatePerSec = null,
  blockRateFastSpanMs = null,
  blockRateSlowPerSec = null,
  blockRateSlowSpanMs = null,
  avgBlockGapSec = null,
  reorgEvents = 0,
  reorgAt = null,
  peers = null,
  txouts = null,
  difficulty = null,
  reason = null,
  targetHeight = null,
  peerBestHeight = null,   // the highest tip any connected peer reports (getpeerinfo synced_headers)
} = {}) {
  const hasCounts = Number.isFinite(blocks);
  const headersKnown = Number.isFinite(headers) && headers > 0;
  const behind = headersKnown && hasCounts ? Math.max(0, headers - blocks) : null;

  const heightRatio = hasCounts && headersKnown ? clamp(blocks / headers) : null;
  const vp = Number.isFinite(verificationProgress) ? clamp(verificationProgress) : null;

  const tipAgeSec = Number.isFinite(tipTime) ? Math.max(0, Math.floor(now / 1000) - tipTime) : null;

  const state = decideState({ blocks, peerBestHeight,  hasCounts, headersKnown, behind, ibd, tipAgeSec, reorgAt, now, reorgEvents });

  // Rate windows, and when they may be believed.
  //
  // Observed live on the bench node on 2026-09-08, during initial block download:
  // the tip advances in BURSTS, not steadily -- +955 blocks in 92 s (10.4 blk/s),
  // then +4 per 25 s (0.16 blk/s) minutes later. A throughput sample taken inside
  // a trough, from a process only 40 seconds old, produced an ETA of 23 days when
  // the same node finished the same stretch in about 8 hours.
  //
  // So a rate is only used once its window has actually accumulated span, the
  // longest usable window drives the ETA, and when the windows disagree the answer
  // is a RANGE with both rates named -- not a single confident number.
  const windows = [
    { name: '10 minutes', perSec: blockRateSlowPerSec, spanMs: blockRateSlowSpanMs },
    { name: '2 minutes', perSec: blockRatePerSec, spanMs: blockRateFastSpanMs },
  ];
  // A window younger than this has not seen enough of a bursty process to
  // characterize it, however exact its arithmetic looks.
  const MIN_SPAN_MS = 60_000;
  // A caller that names a window but not its span has already vouched for it;
  // the guard exists for the monitor, which always reports how long it has been
  // watching. Absent span therefore means "trusted", not "rejected" -- otherwise
  // this pure function would silently refuse rates in every other context.
  const trusted = (w) => w.spanMs == null || w.spanMs >= MIN_SPAN_MS;
  const usable = windows.filter((w) => Number.isFinite(w.perSec) && w.perSec > 0 && trusted(w));
  // A sample that existed but was too young to use must still be EXPLAINED, or
  // the bar silently shows no ETA and the user cannot tell "just started" from
  // "broken" from "the node is not making progress".
  const seenTooYoung = windows.some((w) => Number.isFinite(w.perSec) && Number.isFinite(w.spanMs)
    && w.spanMs < MIN_SPAN_MS);
  // Zero in the freshest window outranks an older average: "nothing arrived in
  // the last two minutes" is exactly the fact an ETA computed from a
  // flattering earlier window would hide.
  const freshWindow = windows[windows.length - 1];
  const stalledNow = Number.isFinite(freshWindow.perSec) && freshWindow.perSec === 0 && trusted(freshWindow);
  const fast = usable[0]?.perSec ?? null;
  const slow = usable.length > 1 ? usable[usable.length - 1].perSec : null;
  // A stall pre-empts every window. Checking this after picking a basis let a
  // flattering ten-minute average answer "8 hours" while nothing had arrived for
  // two minutes -- the exact situation an ETA is supposed to reveal, not mask.
  const usableForEta = stalledNow ? [] : usable;
  const basis = usableForEta[0] ?? null;

  let rateTrend = null;
  if (stalledNow) rateTrend = 'stalled';
  if (rateTrend === null && usable.length >= 2) {
    // `usable` is ordered long-window-first, so the short one is the last entry.
    const ratio = usable[usable.length - 1].perSec / usable[0].perSec;
    rateTrend = ratio < 0.5 ? 'decelerating' : ratio > 2 ? 'accelerating' : 'steady';
  } else if (basis) {
    rateTrend = 'unknown';
  }

  let etaSec = null;
  let etaBasis = null;
  let etaBestSec = null;
  let etaWorstSec = null;
  if (behind != null && behind > 0 && basis) {
    etaSec = Math.round(behind / basis.perSec);
    etaBasis = `measured ${basis.perSec.toFixed(2)} blocks/s over ${basis.name}`;
    if (usableForEta.length >= 2) {
      const rates = usableForEta.map((w) => w.perSec);
      const fastest = Math.max(...rates);
      const slowest = Math.min(...rates);
      if ((fastest - slowest) / slowest > 0.25) {
        etaBestSec = Math.round(behind / fastest);
        etaWorstSec = Math.round(behind / slowest);
      }
    }
  } else if (behind != null && behind > 0 && stalledNow) {
    etaBasis = 'no blocks arrived in the most recent window, so no ETA is given; an older average would hide the stall';
  } else if (behind != null && behind > 0 && ibd !== true && Number.isFinite(avgBlockGapSec) && avgBlockGapSec > 0) {
    // Near the tip, blocks really do arrive at roughly the network cadence, so
    // that cadence is a legitimate predictor for a short catch-up.
    etaSec = Math.round(behind * avgBlockGapSec);
    etaBasis = 'assumes the 10-minute target cadence (no measured download rate yet)';
  }
  // During IBD the cadence is deliberately NOT used as a fallback. Observed
  // 2026-09-08 against the bench node: 296,325 blocks behind with no rate sample
  // yet, the cadence assumption produced an ETA of 1,432 DAYS -- ~100x larger than
  // what actually happened, because a syncing node applies blocks far faster than
  // the network produces them.

  const blocksPerMin = fast != null ? +(fast * 60).toFixed(2) : null;


  return {
    state,
    chain: chain ?? null,
    height: hasCounts ? blocks : null,
    headers: headersKnown ? headers : null,
    behind,
    // What the bar draws, and what the UI must label it as.
    pct: heightRatio == null ? null : +(heightRatio * 100).toFixed(4),
    verificationProgress: vp == null ? null : +(vp * 100).toFixed(4),
    // The gap in the node's own announced headers: headers may also lag the real
    // network tip, which heightRatio cannot see. Reported, not hidden.
    headersMayLag: headersKnown && tipAgeSec != null && tipAgeSec > STALL_SEC && behind === 0,
    bestHash: bestHash ?? null,
    targetHeight: Number.isFinite(targetHeight) ? targetHeight : (headersKnown ? headers : null),
    tipAgeSec,
    etaSec,
    eta: etaSec == null ? null : formatEta(etaSec),
    etaBasis,
    blocksPerMin,
    blockRatePerSec: fast,
    blockRateSlowPerSec: slow,
    rateWindows: usableForEta.map((w) => ({ name: w.name, blocksPerSec: +w.perSec.toFixed(3), spanSec: w.spanMs == null ? null : Math.round(w.spanMs / 1000) })),
    rateTrend,
    // The bursty-process honesty pair: the same 293k blocks take this long at the
    // fastest observed rate and this long at the slowest.
    etaBestSec,
    etaWorstSec,
    etaBest: etaBestSec == null ? null : formatEta(etaBestSec),
    etaWorst: etaWorstSec == null ? null : formatEta(etaWorstSec),
    avgBlockGapSec,
    sizeOnDisk: Number.isFinite(sizeOnDisk) ? sizeOnDisk : null,
    ibd: typeof ibd === 'boolean' ? ibd : null,
    txouts: Number.isFinite(txouts) ? txouts : null,
    difficulty: Number.isFinite(difficulty) ? difficulty : null,
    peers: Number.isFinite(peers) ? peers : null,
    reorgs: Number.isFinite(reorgEvents) ? reorgEvents : 0,
    warnings: Array.isArray(warnings) ? warnings : [],
    // Why we do not know, whenever we do not know. "unknown" on its own reads as
    // a broken monitor; the node usually told us exactly what it is doing.
    reason: state === STATE.UNKNOWN ? (reason ?? null) : null,
    // Honest summary of what we cannot know, so the UI can say it out loud.
    caveats: caveatsOf({ blocks, peerBestHeight, 
          headersKnown, hasCounts, vp, heightRatio, behind, tipAgeSec, state, rateTrend,
          etaBestSec, etaWorstSec,
          // pre-vetting values, so the wording can distinguish "never sampled"
          // from "sampled too recently to trust"
          rawRates: { recent: windows[1].perSec, slow: windows[0].perSec },
          seenTooYoung, stalledNow, hasUsableRate: !!basis,
          // Destructured parameters are not in scope automatically; this was the
          // third missing-threading bug in this file (after rateTrend and
          // etaBestSec), so the call site now passes every value the body reads.
          reason,
        }),
  };
}

function decideState({ hasCounts, headersKnown, behind, ibd, tipAgeSec, reorgAt, now, reorgEvents, blocks = null, peerBestHeight = null }) {
  if (!hasCounts) return STATE.UNKNOWN;
  // A reorg in the last 3 minutes outranks everything: the bar is about to move
  // backwards, and calling that "synced" would be wrong twice over.
  if (reorgEvents > 0 && reorgAt != null && now - reorgAt < 180_000) return STATE.REORG;
  if (ibd === true) return STATE.IBD;
  if (headersKnown && behind > 0) return STATE.CATCHING_UP;
  if (tipAgeSec != null && tipAgeSec > STALL_SEC) {
    const peersAhead = Number.isFinite(peerBestHeight) && Number.isFinite(blocks) && peerBestHeight > blocks;
    const peersAgree = Number.isFinite(peerBestHeight) && Number.isFinite(blocks) && peerBestHeight <= blocks;
    if (peersAhead) return STATE.STALLED;
    if (!peersAgree && tipAgeSec > STALL_ALONE_SEC) return STATE.STALLED;
    // peers agree on this tip, or nobody can say otherwise yet: a long gap, and synced
  }
  if (tipAgeSec != null && tipAgeSec <= FRESH_SEC) return STATE.SYNCED;
  if (behind === 0 && headersKnown) return STATE.SYNCED;
  return STATE.UNKNOWN;
}

function caveatsOf({ headersKnown, hasCounts, vp, heightRatio, behind, tipAgeSec, state, rateTrend, etaBestSec, etaWorstSec, rawRates = {}, seenTooYoung = false, stalledNow = false, hasUsableRate = false, reason = null, blocks = null, peerBestHeight = null }) {
  const out = [];
  // Whether any window saw a rate at all, before vetting turned a too-young
  // sample into null. "No rate measured" and "a sample existed but was too young
  // to trust" are different statements to the user and get different wording.
  const sawRate = Number.isFinite(rawRates.recent) || Number.isFinite(rawRates.slow);

  if (!hasCounts) {
    out.push(reason
      ? `no height, headers or percentage yet: the node answered ${reason}`
      : 'the node has not answered getblockchaininfo yet, so no height is known');
  }
  else if (!headersKnown) out.push('no header count was reported, so percentage complete cannot be derived from heights');

  if (vp != null && heightRatio != null && Math.abs(vp - heightRatio) > 0.02) {
    out.push(`height ratio ${(heightRatio * 100).toFixed(2)}% and the node's own estimate ${(vp * 100).toFixed(2)}% differ: the first is blocks we hold over announced headers, the second is difficulty-weighted work. Both are shown`);
  }
  if (behind === 0 && tipAgeSec != null && tipAgeSec > 2400) {
    if (Number.isFinite(peerBestHeight) && Number.isFinite(blocks) && peerBestHeight > blocks) out.push(`connected peers report a tip ${peerBestHeight - blocks} block(s) above this node's: it is behind the network, not waiting for it`);
    else if (Number.isFinite(peerBestHeight)) out.push(`no block for ${Math.round(tipAgeSec / 60)} minutes, and the connected peers agree on this tip: a long gap on the network, not a fault of this node`);
    else out.push('blocks and headers agree, but the tip is old and no peer height is known, so a long gap and a node cut off from its peers cannot be told apart yet');
  }
  if (behind != null && behind > 0 && stalledNow) {
    out.push('no blocks arrived in the last couple of minutes: either the download has stalled or this node is between bursts, so no ETA is offered');
  }
  if (behind != null && behind > 0 && !stalledNow && seenTooYoung && !hasUsableRate) {
    out.push('a rate was measured but the monitor has not been watching long enough to trust it against a bursty download, so no ETA yet');
  }
  if (behind != null && behind > 0 && !sawRate && !stalledNow && !seenTooYoung) {
    out.push(state === STATE.IBD
      ? 'no download rate measured yet, so no ETA is shown: guessing one from the 10-minute cadence would be wildly wrong during initial block download'
      : 'no download rate measured yet, so the ETA assumes the 10-minute cadence and will be optimistic');
  }
  if (state === STATE.REORG) out.push('the active chain moved backwards; the height, the percentage and the ETA are all about to change');
  if (behind != null && behind > 0 && rateTrend === 'decelerating') {
    out.push('the throughput over the last 2 minutes is well under the 10-minute average, so this ETA will get LONGER, not shorter');
  }
  if (behind != null && behind > 0 && rateTrend === 'accelerating') {
    out.push('the throughput over the last 2 minutes is well over the 10-minute average, so this ETA will shorten');
  }
  if (behind != null && behind > 0 && etaBestSec != null && etaWorstSec != null) {
    out.push(`the node downloads in bursts, so a single figure would be a guess: at the observed rates this completes in between ${formatEta(etaBestSec)} and ${formatEta(etaWorstSec)}`);
  }
  if (state === STATE.STALLED) out.push(Number.isFinite(peerBestHeight) && Number.isFinite(blocks) && peerBestHeight > blocks ? 'stalled: peers know a higher tip than this node holds' : 'no new block for over two hours, and no peer height to check it against');
  return out;
}

/**
 * The sync viewer's one-line instrument strip.
 *
 * Everything the operator needs is assembled here, in one ordered list, for every
 * state -- so the browser draws the same dense row whether the node is at the tip
 * or 900k blocks behind, instead of swapping to a ~10-row hero whenever a sync is
 * running. A monitoring header that grows when there is news pushes the actual
 * charts off the screen, which is the opposite of when you need to see them.
 *
 * Every figure is the node's own. A stat with no value is omitted rather than
 * rendered as a placeholder, so the row shrinks to exactly what is known.
 */
export function stripFacts(sync = {}) {
  const {
    height = null, headers = null, behind = null, blockRatePerSec = null, rateTrend = null,
    eta = null, tipAgeSec = null, sizeOnDisk = null, txouts = null, peers = null,
    chain = null, state = null,
  } = sync;
  const out = [];
  // When we cannot know the height, say why in the row itself. An unexplained
  // blank reads as a broken monitor -- the node usually told us what it is doing.
  if (state === STATE.UNKNOWN && sync.reason) out.push({ label: 'node says', value: sync.reason, tone: 'warn', title: sync.reason });
  if (chain) out.push({ label: 'chain', value: chain, tone: '' });
  if (height != null) {
    out.push({
      label: 'height',
      value: headers != null && headers !== height ? `${fmtNum(height)} / ${fmtNum(headers)}` : fmtNum(height),
      tone: '',
    });
  }
  if (behind != null && behind > 0) out.push({ label: 'behind', value: fmtNum(behind), tone: 'accent' });
  if (Number.isFinite(blockRatePerSec)) {
    const tone = rateTrend === 'decelerating' || rateTrend === 'stalled' ? 'bad' : rateTrend === 'accelerating' ? 'ok' : '';
    out.push({
      label: 'rate',
      // The arrow is the whole trend story, so the word "decelerating" does not
      // have to spend the row's width. (An earlier .trim() here ate the space and
      // rendered "0.15 blk/s↘".)
      value: `${blockRatePerSec >= 10 ? blockRatePerSec.toFixed(0) : blockRatePerSec.toFixed(2)} blk/s${ARROW[rateTrend] ? ` ${ARROW[rateTrend]}` : ''}`,
      title: rateTrend && rateTrend !== 'steady' && rateTrend !== 'unknown' ? `throughput is ${rateTrend}` : null,
      tone,
    });
  }
  if (eta) out.push({ label: 'eta', value: eta, tone: 'accent' });
  // Tip age is withheld during initial block download. The node is replaying
  // history, so the tip block is old by definition -- the live node showed
  // "tip 4929.1d" while downloading at 10 blk/s, which reads like a 13-year
  // stall and is not a fact about responsiveness at all. Near the tip
  // (catching_up, synced, stalled) the same figure genuinely is useful.
  if (tipAgeSec != null && state !== STATE.IBD) out.push({ label: 'tip', value: tipAgeSec < 90 ? `${Math.round(tipAgeSec)}s` : tipAgeSec < 5400 ? `${Math.round(tipAgeSec / 60)}m` : tipAgeSec < 172800 ? `${(tipAgeSec / 3600).toFixed(1)}h` : `${(tipAgeSec / 86400).toFixed(1)}d`, tone: tipAgeSec > 2400 && state !== STATE.SYNCED ? 'bad' : '' });
  if (sizeOnDisk != null) out.push({ label: 'on disk', value: fmtBytes(sizeOnDisk), tone: '' });
  if (txouts != null) out.push({ label: 'utxos', value: shortNum(txouts), tone: '' });
  if (peers != null) out.push({ label: 'peers', value: String(peers), tone: '' });
  return out;
}

const ARROW = { accelerating: '\u2197', decelerating: '\u2198', stalled: '\u2014' };
// 'steady' and 'unknown' deliberately have no entry: no mark is the correct mark
// for a rate that is doing nothing notable.

function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}
function shortNum(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1)}${u[i]}`;
}

export function stateLabel(state) {
  return {
    [STATE.UNKNOWN]: 'Unknown',
    [STATE.IBD]: 'Initial block download',
    [STATE.CATCHING_UP]: 'Catching up',
    [STATE.SYNCED]: 'Synced',
    [STATE.STALLED]: 'Stalled',
    [STATE.REORG]: 'Reorganising',
  }[state] ?? state;
}


function clamp(v) {
  if (!Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}
