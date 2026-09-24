// Pure parsers for the node's own log lines. No I/O here, so the formats can be
// unit-tested against frozen real lines (test/fixtures/log-samples.txt).
//
// Why parse logs at all when there is RPC: three things this node only exposes
// in its log, each confirmed against the live file --
//   1. bandwidth. getnettotals() answers {totalbytesrecv:0,totalbytessent:0} in
//      this deployment, because the peer byte counters live in the forked
//      download worker. The `[dlc] -- network recv this tick ... --` line is the
//      real number.
//   2. per-peer transaction relay. getpeerinfo() answers [] in this deployment
//      while getconnectioncount() says 13. The `[txrelay] ... via legs
//      [0:136.38.88.88:8333 +70, ...]` line names the peers and their counts.
//   3. which peer served which block (`[block] stored ... (via IP:port)`).
// Every rule below is deliberately tolerant: an unrecognised line still becomes
// a generic event, because an unexpected format is information, not noise.

const TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.(\d{3}) /;
const TAG_RE = /^\[[a-z0-9_]+(?::\d+)?\]\s*/;

// "1.0KB", "32.0 KB/s", "0.0B", "2.3MB", "128 KB". (2026-09-16, audit L6: the number is
// `\d*\.\d+|\d+`, the same numbers as the old `[0-9]*\.?[0-9]+` without the two digit
// runs that could split a long string of digits every possible way.) The node prints decimal
// units (4096 bytes renders as "4.0KB"), so decode the same way back.
const SIZE_UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };
export function parseSize(text) {
  if (text == null) return null;
  const m = String(text).trim().match(/^(\d*\.\d+|\d+)\s*(B|KB|MB|GB|TB|PB)(?:\/s)?$/i);
  if (!m) return null;
  const unit = m[2].toUpperCase();
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[unit]);
}

export function parseRate(text) {
  if (text == null) return null;
  const m = String(text).trim().match(/^(\d*\.\d+|\d+)\s*(B|KB|MB|GB|TB)\/s$/i);
  if (!m) return null;
  return parseFloat(m[1]) * SIZE_UNITS[m[2].toUpperCase()];
}

// DD:HH:MM:SS as printed by the heartbeat.
export function parseUptime(text) {
  const m = String(text || '').match(/^(\d+):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return ((+d * 24 + +h) * 60 + +mi) * 60 * 1000 + +s * 1000;
}

// The same node prints two different clock widths depending on the line, both
// seen on 2026-09-08 in the bench log: `elapsed 1:22:01` (H:MM:SS, 3 fields) and
// `eta 00:07:54:48` (DD:HH:MM:SS, 4 fields). Rightmost field is always seconds,
// so decode by counting fields instead of assuming a width -- guessing DD would
// have read the 1h22m elapsed as 1 day 22 minutes.
export function parseClock(text) {
  const parts = String(text || '').trim().split(':');
  if (parts.length < 2 || parts.length > 4) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const [s, mi, h, d] = parts.reverse();
  return (((+(d || 0) * 24 + +h) * 60 + +mi) * 60 + +s) * 1000;
}

// Split an address like "1.2.3.4:8333" or a CJDNS/I2P form without a port.
function addrParts(s) {
  if (!s) return null;
  const m = s.match(/^(.+):(\d{2,5})$/);
  if (m) return { host: m[1], port: Number(m[2]), addr: s };
  return { host: s, port: null, addr: s };
}

// THE AUXILIARY INDEX FAMILY (2026-09-18). Three index builders -- `txindex`,
// `txospender` and `addr_hist` -- and the `[trail]` line that reports all three at once.
// Together they are 1,866 of 40,478 tagged lines in run 26's log, and every one of them
// was `raw` before these rules.
//
// TWO SPELLINGS, TWO WRITERS, ONE SUBSYSTEM. The daemon writes `[txindex]`,
// `[txospender]` and `[addr_hist]` with a timestamp; the child processes it forks to
// build a run write `[txindex]`, `[txospender]` and `[addrhist]` -- note the missing
// underscore -- with NO TIMESTAMP AT ALL, because they are separate programs
// (`bmc_build_tx_index` and friends) whose output is redirected into the same file.
// 40% of these lines are the child's. `index` normalises the spelling; `tsFallback`
// (parseLine) marks the ones whose time is the time we read them, which is the honest
// answer and the one the feed needs so it does not order them as if they were stamped.
//
// A number followed by a word is the grammar these builders share: `20136 records`,
// `77 funds, 0 spendrefs`, `22 keys, 87 events`. Rather than one regex per noun --
// which is how a parser ends up 52% -- the count list is scanned pair by pair, so a
// builder that starts reporting a new noun is read rather than dropped, the way
// `dlcProgressFields` already handles the download ticks.
const INDEX_NAMES = { txindex: 'txindex', txospender: 'txospender', addr_hist: 'addr_hist', addrhist: 'addr_hist' };

/**
 * "20136 records, 79 sparse, 0.00 GB, 0s" or "22 keys, 87 events (77 funds, 10
 * spends), to height 19999, 0.00 GB, 0s" -> { counts, bytes, secs, height, extra }.
 * Every `<number> <noun>` pair becomes a count; the sizes, the seconds and a stated
 * height are pulled out by shape. What matched nothing is kept verbatim in `extra`,
 * so an unread segment is visible instead of silently gone.
 */
export function parseCountList(text) {
  const out = { counts: {}, bytes: null, secs: null, height: null, from: null, to: null, extra: [] };
  if (!text) return out;
  // The parenthesised breakdown ("(77 funds, 10 spends)") is a list in its own right.
  // `heights [0,119999]` splits on its own comma into "heights [0" and "119999]",
  // which is why each half is recognised separately below rather than as one range.
  for (const part of String(text).replace(/[()]/g, ', ').split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    let m;
    if ((m = seg.match(/^(\d*\.\d+|\d+)\s*(B|KB|MB|GB|TB|PB)$/i))) { out.bytes = parseSize(seg); continue; }
    if ((m = seg.match(/^(\d+(?:\.\d+)?)s$/))) { out.secs = parseFloat(m[1]); continue; }
    if ((m = seg.match(/^to height (\d+)$/))) { out.height = +m[1]; continue; }
    if ((m = seg.match(/^heights \[(-?\d+)$/))) { out.from = +m[1]; continue; }
    if ((m = seg.match(/^(-?\d+)\]$/))) { out.to = +m[1]; continue; }
    if ((m = seg.match(/^(-?\d+)\s+([a-z][a-z_ ]*)$/i))) { out.counts[m[2].trim().replace(/ /g, '_')] = +m[1]; continue; }
    out.extra.push(seg);
  }
  return out;
}

/**
 * One `[trail]` segment: "txindex: runs reach 179999; the next run starts once 7623
 * more heights are ready". The three states seen are waiting, building and merging;
 * anything else is kept as its own text rather than dropped.
 */
function trailSegment(seg) {
  const at = seg.indexOf(':');
  if (at < 0) return null;
  const name = seg.slice(0, at).trim();
  const rest = seg.slice(at + 1).trim();
  const index = INDEX_NAMES[name] ?? name;
  let m;
  if ((m = rest.match(/^runs reach (-?\d+); the next run starts once (\d+) more heights are ready$/))) {
    return [index, { state: 'waiting', reach: +m[1], needMore: +m[2] }];
  }
  if ((m = rest.match(/^building run \[(\d+),(\d+)\] \(pid (\d+)\)$/))) {
    return [index, { state: 'building', from: +m[1], to: +m[2], pid: +m[3] }];
  }
  if ((m = rest.match(/^merging (\d+) runs \(pid (\d+)\)$/))) {
    return [index, { state: 'merging', runs: +m[1], pid: +m[2] }];
  }
  return [index, { state: 'other', text: rest }];
}

// 2026-09-16 (audit L6): a `\s*` in front of a capture such as `([^,]+)` that can itself
// start with a space lets the engine split one run of spaces between the two in every
// possible way -- quadratic on a long run, and each rule pays it on every line. Those
// captures now start with a character `\s` cannot match (`[^\s,][^,]*`), which matches
// the same real lines and leaves only one way to read the spaces.
const RULES = [
  // [dlc] -- network recv this tick: 4.0KB (405.0B/s) | total recv: 2.3MB || disk write this tick: 0.0B (0.0B/s) | total written: 1.9MB --
  {
    name: 'bandwidth',
    re: /\[dlc\]\s*--\s*network recv this tick:\s*(\S+)\s*\(([^)]+)\)\s*\|\s*total recv:\s*(\S+)\s*\|\|\s*disk write this tick:\s*(\S+)\s*\(([^)]+)\)\s*\|\s*total written:\s*(\S+)\s*--/,
    apply(m) {
      return {
        kind: 'bandwidth',
        netThisTick: parseSize(m[1]),
        netRate: parseRate(m[2]) ?? parseSize(m[2]),
        netTotal: parseSize(m[3]),
        diskThisTick: parseSize(m[4]),
        diskRate: parseRate(m[5]) ?? parseSize(m[5]),
        diskTotal: parseSize(m[6]),
      };
    },
  },
  // [dlc] -- average since start: 0.0B/s recv, 0.0B/s write --
  {
    name: 'bwAverage',
    re: /\[dlc\]\s*--\s*average since start:\s*([^\s]+)\s+recv,\s*([^\s]+)\s+write\s*--/,
    apply(m) { return { kind: 'bw_average', avgRecv: parseRate(m[1]), avgWrite: parseRate(m[2]) }; },
  },
  // [dlc] -- dead-weight floor this tick: 32.0 KB/s (pool median 0.0 KB/s, absolute 32.0 KB/s) --
  {
    name: 'deadweight',
    re: /\[dlc\]\s*--\s*dead-weight floor this tick:\s*([^\s]+(?:\s?[KMG]?B\/s)?)\s*\(pool median\s*([^\s,][^,]*),\s*absolute\s*([^\s)][^)]*)\)/,
    apply(m) {
      return { kind: 'deadweight', floor: parseRate(m[1].trim()), poolMedian: parseRate(m[2].trim()), absolute: parseRate(m[3].trim()) };
    },
  },
  // [dlc] -- peers banned: 0 of 109 --
  { name: 'banned', re: /\[dlc\]\s*--\s*peers banned(?: this run)?:\s*(\d+)\s+of\s*(\d+)\s*--/, apply: (m) => ({ kind: 'ban_count', banned: +m[1], of: +m[2], severity: +m[1] > 0 ? 'warn' : 'info' }) },
  // [dlc] ranked 116 live peer(s) by a 2000-header sample in 44.6s: 39 answered, best 94 KB/s, median 63 KB/s, slowest answering 48 KB/s; the 77 silent rank last
  {
    name: 'ranking',
    re: /\[dlc\]\s*ranked\s*(\d+)\s*live peer\(s\)[^.]*in\s*([\d.]+)s:\s*(\d+)\s*answered,\s*best\s*([^\s,][^,]*),\s*median\s*([^\s,][^,]*),\s*slowest answering\s*([^\s;][^;]*);\s*the\s*(\d+)\s*silent/,
    apply(m) {
      return {
        kind: 'peer_ranking', live: +m[1], sampleSecs: +m[2], answered: +m[3],
        best: parseRate(m[4].trim()), median: parseRate(m[5].trim()), slowest: parseRate(m[6].trim()), silent: +m[7],
        // Warn only when the pool is mostly silent -- the phrase 'silent rank last'
        // appears in healthy runs too, so a keyword match would cry wolf.
        severity: (+m[3] / Math.max(1, +m[1])) < 0.4 ? 'warn' : 'info',
      };
    },
  },
  // [dl] heartbeat: tip=965993 peers=12/16 txouts=165335351 uptime=00:14:15:21 sync_failing=10
  {
    name: 'heartbeat',
    re: /\[dl\]\s*heartbeat:\s*tip=(\d+)\s+peers=(\d+)\/(\d+)\s+txouts=(\d+)(?:\s+uptime=(\S+))?(?:\s+sync_failing=(\d+))?/,
    apply(m) {
      return {
        kind: 'heartbeat', tip: +m[1], peersInUse: +m[2], peersWanted: +m[3],
        txouts: +m[4], uptime: parseUptime(m[5]), syncFailing: m[6] == null ? null : +m[6],
      };
    },
  },
  // [dl] new block: height=965993 hash=0000... (+2)
  { name: 'newBlock', re: /\[dl\]\s*new block:\s*height=(\d+)\s+hash=([0-9a-f]{6,})(?:\s+\(\+(\d+)\))?/, apply: (m) => ({ kind: 'new_block', height: +m[1], hashPrefix: m[2], jump: m[3] == null ? 1 : +m[3] }) },
  // [dl] announced tip height=965993 to 12/13 legs
  { name: 'announce', re: /\[dl\]\s*announced tip height=(\d+)\s+to\s*(\d+)\/(\d+)\s+legs/, apply: (m) => ({ kind: 'tip_announce', height: +m[1], legsReached: +m[2], legsTotal: +m[3] }) },
  // [dl] parallel downloader wrote 7 block(s); archive now 965993
  { name: 'archive', re: /\[dl\]\s*parallel downloader wrote\s*(\d+)\s*block\(s\);\s*archive now\s*(\d+)/, apply: (m) => ({ kind: 'archive_write', blocks: +m[1], archiveHeight: +m[2] }) },
  // [block] stored height=965923 hash=0000000000000000.. bytes=1464177 tx=6866 (via 193.223.81.8:8333)
  // [block] stored height=967441 hash=0000…c8 bytes=1565590 (pushed compact block + blocktxn from 86.127.254.44:8333)
  // The newer spelling (2026-09-17 on): no tx count, and how the block came -- a compact block
  // alone, or with the transactions it lacked fetched by getblocktxn. 238 lines of the current
  // logs unread until 2026-09-19; the delivery is kept: it is the compact-block hit rate in a word.
  {
    name: 'blockStored',
    re: /\[block\]\s*stored\s+height=(\d+)\s+hash=([0-9a-f.]+)\s+bytes=(\d+)(?:\s+tx=(\d+))?(?:\s*\((?:via\s*([^\s)][^)]*)|pushed (compact block(?: \+ blocktxn)?) from\s+([^\s)]+))\))?/,
    apply(m) {
      const via = addrParts(m[5] ?? m[7]);
      return {
        kind: 'block_stored', height: +m[1], hashPrefix: m[2].replace(/\.$/, ''), bytes: +m[3], txs: m[4] == null ? null : +m[4], via: via?.addr ?? null, viaHost: via?.host ?? null,
        ...(m[6] ? { delivery: m[6] } : {}),
      };
    },
  },
  // [mempool] block 965993: removed 175 pool tx (confirmed/conflicted)
  { name: 'mempoolBlock', re: /\[mempool\]\s*block\s*(\d+):\s*removed\s*(\d+)\s*pool tx/, apply: (m) => ({ kind: 'mempool_block_drain', height: +m[1], removed: +m[2] }) },
  // [tx_accept] last 30s: +77 accepted (mempool 4033) | rejected: 333 missing-inputs, 0 invalid, 18 policy | 0 already confirmed
  {
    name: 'txAccept',
    // `N invalid (last: "p2wpkh signature invalid")` -- the node started naming the last
    // invalid transaction's reason inside the count, and this rule stopped matching 85 of the
    // current logs' lines: the §39 drift again, found the same way (enumerating the unread).
    // The reason is optional, so both spellings parse, and kept, since it says WHY.
    re: /\[tx_accept\]\s*last\s*(\d+)s:\s*\+(\d+)\s*accepted\s*\(mempool\s*(\d+)\)\s*\|\s*rejected:\s*(\d+)\s*missing-inputs,\s*(\d+)\s*invalid(?:\s*\(last:\s*"([^"]*)"\))?,\s*(\d+)\s*policy\s*\|\s*(\d+)\s*already confirmed/,
    apply(m) {
      return {
        kind: 'tx_accept', windowSec: +m[1], accepted: +m[2], mempool: +m[3],
        rejectMissingInputs: +m[4], rejectInvalid: +m[5], rejectPolicy: +m[7], alreadyConfirmed: +m[8],
        acceptRate: +(+m[2] / Math.max(1, +m[1])).toFixed(2),
        ...(m[6] != null ? { lastInvalid: m[6] } : {}),
      };
    },
  },
  // [txrelay] last 60s: +195 tx accepted via legs [0:83.106.166.127:8333 +39, 4:136.38.88.88:8333 +114] (mempool 9624)
  {
    name: 'txRelay',
    re: /\[txrelay\]\s*last\s*(\d+)s:\s*\+(\d+)\s*tx accepted via legs\s*\[([^\]]*)\]\s*\(mempool\s*(\d+)\)/,
    apply(m) {
      const legs = [];
      for (const part of m[3].split(',')) {
        const pm = part.trim().match(/^(\d+):(\S+?)\s*\+(\d+)$/);
        if (pm) {
          const a = addrParts(pm[2]);
          legs.push({ leg: +pm[1], addr: a?.addr ?? pm[2], host: a?.host ?? pm[2], accepted: +pm[3] });
        }
      }
      return { kind: 'tx_relay', windowSec: +m[1], accepted: +m[2], legs, mempool: +m[4], relayRate: +(+m[2] / Math.max(1, +m[1])).toFixed(2) };
    },
  },
  // [txrelay] last 60s: +5 tx accepted (mempool 12) -- the no-legs form
  { name: 'txRelayBare', re: /\[txrelay\]\s*last\s*(\d+)s:\s*\+(\d+)\s*tx accepted(?! via)\s*\(mempool\s*(\d+)\)/, apply: (m) => ({ kind: 'tx_relay', windowSec: +m[1], accepted: +m[2], legs: [], mempool: +m[3] }) },
  // [txrelay] orphans: 0 held, 71004 parked, 16288 resolved, 54716 dropped; 1p1c: 2 accepted, 0 failed
  {
    name: 'orphans',
    re: /\[txrelay\]\s*orphans:\s*(\d+)\s*held,\s*(\d+)\s*parked,\s*(\d+)\s*resolved,\s*(\d+)\s*dropped(?:;\s*1p1c:\s*(\d+)\s*accepted,\s*(\d+)\s*failed)?/,
    apply(m) {
      return { kind: 'orphans', held: +m[1], parked: +m[2], resolved: +m[3], dropped: +m[4], oneP1C: m[5] == null ? null : { accepted: +m[5], failed: +m[6] } };
    },
  },
  // [txrelay] orphan drops: 54714 ttl, 0 evicted, 2 rejected | parents requested 76410, notfound 60971, re-requested after timeout 16714, retried on another peer 532026 (gave up 132632, in flight 379), sync deferred 15150
  {
    name: 'orphanDetail',
    // `drained N` was inserted before the parenthesis by the node at some point after
    // 2026-09-08, and this rule stopped matching: 498 lines of run 26, silently raw,
    // exactly the drift MEASUREMENTS 37 is about. Optional, so both spellings parse.
    re: /\[txrelay\]\s*orphan drops:\s*(\d+)\s*ttl,\s*(\d+)\s*evicted,\s*(\d+)\s*rejected\s*\|\s*parents requested\s*(\d+),\s*notfound\s*(\d+),\s*re-requested after timeout\s*(\d+),\s*retried on another peer\s*(\d+)(?:,\s*drained\s*(\d+))?\s*\(gave up\s*(\d+),\s*in flight\s*(\d+)\)(?:,\s*sync deferred\s*(\d+))?/,
    apply(m) {
      return {
        kind: 'orphan_detail', ttl: +m[1], evicted: +m[2], rejected: +m[3], requested: +m[4],
        notfound: +m[5], reRequested: +m[6], retriedOtherPeer: +m[7],
        drained: m[8] == null ? null : +m[8], gaveUp: +m[9], inFlight: +m[10],
        syncDeferred: m[11] == null ? null : +m[11],
      };
    },
  },
  // [dial] 208.161.116.211:8333 connected over v2
  { name: 'dialOk', re: /\[dial\]\s*(\S+?)\s+connected over\s*(v\d)/, apply: (m) => ({ kind: 'peer_connect', addr: m[1], host: addrParts(m[1])?.host, transport: m[2], reason: 'connected' }) },
  // [dial] 172.233.47.67:8333 lacks NODE_WITNESS (services=0xc05) -- dropping...
  { name: 'dialReject', re: /\[dial\]\s*(\S+?)\s+lacks NODE_WITNESS \(services=(\S+?)\)/, apply: (m) => ({ kind: 'peer_reject', addr: m[1], host: addrParts(m[1])?.host, reason: 'lacks NODE_WITNESS', services: m[2] }) },
  // [dial] 154.5.180.120:8333: dialing as block-relay-only (1 of 2)
  { name: 'dialBlockRelay', re: /\[dial\]\s*(\S+?):\s*dialing as block-relay-only\s*\((\d+) of (\d+)\)/, apply: (m) => ({ kind: 'peer_dial', addr: m[1], host: addrParts(m[1])?.host, reason: 'block-relay-only' }) },
  // [mux:7] leg replaced: connected next pool peer 208.161.116.211:8333 (fd 266) addrv2=1
  { name: 'legReplaced', re: /\[mux:(\d+)\]\s*leg replaced:\s*connected next pool peer\s*(\S+)\s*\(fd\s*(\d+)\)\s*addrv2=(\d)/, apply: (m) => ({ kind: 'peer_connect', leg: +m[1], addr: m[2], host: addrParts(m[2])?.host, fd: +m[3], addrv2: m[4] === '1', reason: 'leg replaced' }) },
  // [mux:9] next peer 86.147.78.44:8333 unreachable: connect: Operation now in progress (leg stays down)
  // 2026-09-16 (audit L6): was `unreachable:\s*(.+?)\s*\(leg stays down\)`, which is cubic
  // on a long run of spaces -- 20,000 of them did not finish in 300 s. The lazy capture
  // now meets a literal straight away, and the apply trims what the two `\s*` used to.
  // Builds of 2026-09-10..12 added the redial backoff inside the bracket: `(leg stays down; not
  // dialled again for 10 min)`. Optional, kept as `retry` only when printed.
  { name: 'legDown', re: /\[mux:(\d+)\]\s*next peer\s*(\S+)\s+unreachable:(.+?)\(leg stays down(?:; ([^)]*))?\)/, apply: (m) => ({ kind: 'peer_unreachable', leg: +m[1], addr: m[2], host: addrParts(m[2])?.host, reason: m[3].trim(), ...(m[4] ? { retry: m[4] } : {}) }) },
  // [dl:7] 209.38.162.73:8333 connection dropped (revents 0x11); re-dialing
  { name: 'legDropped', re: /\[dl:(\d+)\]\s*(\S+?)\s+connection dropped\s*\(revents\s*(\S+?)\)(?:;\s*(\S+))?/, apply: (m) => ({ kind: 'peer_drop', leg: +m[1], addr: m[2], host: addrParts(m[2])?.host, revents: m[3], follow: m[4] || null }) },
  // [net] feeler 47.232.103.88:8333 -> dead
  { name: 'feeler', re: /\[net\]\s*feeler\s*(\S+?)\s*->\s*dead/, apply: (m) => ({ kind: 'feeler_dead', addr: m[1], host: addrParts(m[1])?.host }) },
  // [check] block data is NOT laid out monotonically (first break at height 964924) -- ...
  { name: 'archiveHole', re: /\[check\]\s*block data is NOT laid out monotonically\s*\(first break at height\s*(\d+)\)/, apply: (m) => ({ kind: 'archive_hole', height: +m[1], severity: 'warn' }) },
  // [config] conns: max=256 outbound=11 (full=8 blockrelay=2 feeler=1) inbound=245 feeler_every=120s
  {
    name: 'connBudget',
    re: /\[config\]\s*conns:\s*max=(\d+)\s+outbound=(\d+)\s*\(full=(\d+) blockrelay=(\d+) feeler=(\d+)\)\s*inbound=(\d+)(?:\s+feeler_every=(\d+)s)?/,
    apply(m) {
      return {
        kind: 'conn_budget', max: +m[1], outbound: +m[2], fullRelay: +m[3],
        blockRelay: +m[4], feeler: +m[5], inboundCap: +m[6], feelerEverySec: m[7] == null ? null : +m[7],
      };
    },
  },
  // [mempool] recent-rejects filter: 128 KB shared (...)
  { name: 'rejectFilter', re: /\[mempool\]\s*recent-rejects filter:\s*([^\s]+)(?:\s*(?:KB|MB|B))?\s+shared/, apply: (m) => ({ kind: 'reject_filter', size: parseSize(m[1] + (/\s?(KB|MB|B)$/i.test(m[1]) ? '' : 'KB')) }) },

  // ---- the 2026-09-08 bench build (v0.0.1, built 03:02) rewrote these lines ----
  // Measured the same day against that node's own log: of 1,702 lines the rules
  // above matched 30, and of its 1,006 `[dlc]` lines exactly 1 matched. The same
  // facts are still there, in a new grammar:
  //   prod  [dlc] -- network recv this tick: 4.0KB (405.0B/s) | total recv: 2.3MB ||
  //               disk write this tick: 0.0B (0.0B/s) | total written: 1.9MB --
  //   bench [dlc] -- recv 11.2MB/s (avg 10.5MB/s) | write 11.2MB/s (avg 10.7MB/s) |
  //               floor 32.0 KB/s (median 499.6) | banned 6/121 | events 0 rot 0 ...
  // It decodes to the SAME `bandwidth` kind, so nothing downstream has to know
  // which build it is talking to. The new line has no running totals, so
  // netTotal/diskTotal are absent (rendered `–`), never zero.
  //
  // `(median 499.6)` is printed WITHOUT a unit. It is left in `poolMedianText`
  // and `poolMedian` stays null: if it is KB/s it is a peer speed, if it is B/s
  // it is 2000x smaller, and the log does not say which. Rule 3 -- no invented
  // unit to fill a gap.
  {
    name: 'bandwidthTick',
    // 2026-09-16 (audit L6): every `\s*` in front of a capture that could also match
    // spaces now hands over to a first character that cannot (`[^\s)]`), and no lazy
    // capture is followed by `\s*` -- the captures keep their trailing spaces and the
    // apply trims them. The old form retried the same run of spaces from both sides and
    // went quadratic on a long one.
    re: /\[dlc\]\s*--\s*recv\s*([^\s(]+)\s*\(avg\s*([^\s)][^)]*)\)\s*\|\s*write\s*([^\s(]+)\s*\(avg\s*([^\s)][^)]*)\)\s*\|\s*floor\s*([^\s()][^()]*?)\(median\s*([^\s)][^)]*)\)\s*\|\s*banned\s*(\d+)\/(\d+)(?:\s*\|\s*(events.*?)|\s*)--/,
    apply(m) {
      const counters = {};
      for (const [, k, v] of (m[9] || '').matchAll(/\b(events|rot|wait|help|fail)\s+(\d+)/g)) counters[k] = +v;
      return {
        kind: 'bandwidth',
        netRate: parseRate(m[1]),
        avgNetRate: parseRate(m[2].trim()),
        diskRate: parseRate(m[3]),
        avgDiskRate: parseRate(m[4].trim()),
        floor: parseRate((m[5] || '').trim()),
        poolMedianText: (m[6] || '').trim() || null,
        banned: +m[7],
        bannedOf: +m[8],
        worker: Object.keys(counters).length ? counters : null,
        workerText: (m[9] || '').trim() || null,
        // Explicit severity: the generic classifier warns on the word "banned",
        // which would mark every 10-second tick as a warning even at banned=0.
        severity: +m[7] > 0 ? 'warn' : 'info',
      };
    },
  },
  // The same tick line, decoded field by field instead of end to end. Written
  // because the rigid version above died twice in two hours: at 05:42 the node
  // added `staged 1` and 26 of 26 tick lines matched nothing; by 06:14 it had added
  // a second one (`staged 38 commit 6288`). A labelled line is now scanned one
  // labelled field at a time, so an added, removed or reordered field costs that
  // field and not the measurement. Fields no rule knows about are kept verbatim in
  // `extraValues` and named in `extraFields` -- a new field becomes visible data
  // rather than a silently unparsed line, and nobody has to guess what `staged`
  // means before the numbers work again.
  //
  // It requires two recognised fields to claim the line, so the other
  // `[dlc] -- … --` banners (`peer status`, `peers banned: N of M`, `dead-weight
  // floor this tick:`, `average since start:`) stay with their own rules.
  {
    name: 'bandwidthTickFields',
    // 2026-09-16 (audit L6): `\s*(.+?)\s*--` retried every space run from both sides
    // (quadratic). The capture now starts on a non-space and runs to the first `--`; its
    // trailing spaces are trimmed with each segment below, so the fields are the same.
    re: /\[dlc\]\s*--\s*(\S.*?)--/,
    apply(m) {
      const out = { kind: 'bandwidth', extraFields: [], extraValues: null };
      let claims = 0;
      for (const seg of m[1].split('|').map((s) => s.trim()).filter(Boolean)) {
        let r;
        if ((r = /^recv\s+(\S+)(?:\s*\(avg\s+([^)]+)\))?/.exec(seg))) {
          out.netRate = parseRate(r[1]); if (r[2]) out.avgNetRate = parseRate(r[2]); claims += 1;
        } else if ((r = /^write\s+(\S+)(?:\s*\(avg\s+([^)]+)\))?/.exec(seg))) {
          out.diskRate = parseRate(r[1]); if (r[2]) out.avgDiskRate = parseRate(r[2]); claims += 1;
        } else if ((r = /^floor\s+(\S+\s*(?:[KMGTP]?B\/s)?)(?:\s*\(median\s+([^)]+)\))?/i.exec(seg))) {
          out.floor = parseRate(r[1].trim());
          // Still no unit printed for the median, so still no unit invented.
          if (r[2]) out.poolMedianText = r[2].trim();
          claims += 1;
        } else if ((r = /^banned\s+(\d+)\/(\d+)/.exec(seg))) {
          out.banned = +r[1]; out.bannedOf = +r[2]; claims += 1;
        } else if (/^events\b/.test(seg)) {
          const counters = {};
          for (const [, k, v] of seg.matchAll(/\b(events|rot|wait|help|fail)\s+(\d+)/g)) counters[k] = +v;
          if (Object.keys(counters).length) out.worker = counters;
          out.workerText = seg;
          claims += 1;
        } else {
          // One segment can carry more than one new field (`staged 26 commit 6484`),
          // so name each `label number` pair inside it. Half-parsing a new field is
          // still better than losing the line: the name is what tells you the node
          // changed, and the value is what lets you decide later what it means.
          const pairs = [...seg.matchAll(/\b([a-z][a-z0-9_]*)\s+(-?\d+(?:\.\d+)?)/g)];
          if (pairs.length) {
            for (const [, label, value] of pairs) {
              (out.extraFields ||= []).push(label);
              (out.extraValues ||= {})[label] = value;
            }
          } else {
            const label = /^([a-z][a-z0-9_]*)\b/.exec(seg)?.[1];
            if (label) {
              (out.extraFields ||= []).push(label);
              (out.extraValues ||= {})[label] = seg.slice(label.length).trim();
            }
          }
        }
      }
      if (claims < 2) return null;
      if (out.extraFields?.length) out.unexpected = `tick line carries fields no rule knows yet: ${out.extraFields.join(', ')}`;
      out.severity = (out.banned ?? 0) > 0 ? 'warn' : 'info';
      return out;
    },
  },
  // Field-scanned progress line. The rigid rule above died on 2026-09-08 when the
  // parenthetical changed shape and 185 of 185 progress lines matched nothing:
  //   (oldest gap 0s at 388878, 99.93% landed)   ->  (no gap, 100.00% landed)
  // and `eta` can print `--:--:--:--` when the node has no estimate. Decoded field
  // by field: an unknown eta is null, an unknown gap phrasing is kept verbatim, and
  // the stored/applied figures survive whatever the node does to the prose.
  {
    name: 'dlcProgressFields',
    // 2026-09-16 (audit L6): same rewrite as bandwidthTickFields, same reason.
    re: /\[dlc\]\s*==\s*(\S.*?)==/,
    apply(m) {
      const out = { kind: 'dlc_progress', extraFields: [] };
      let claims = 0;
      for (const seg of m[1].split('|').map((s) => s.trim()).filter(Boolean)) {
        let r;
        if ((r = /^elapsed\s+(\S+)/.exec(seg))) { out.elapsedMs = parseClock(r[1]); claims += 1; }
        else if ((r = /^eta\s+(\S+)/.exec(seg))) {
          // `--:--:--:--` is the node saying it has no estimate. parseClock returns
          // null for it, which is exactly right: absent, not zero, not a huge number.
          out.nodeEtaMs = parseClock(r[1]);
          out.etaText = r[1];
          claims += 1;
        } else if ((r = /^overall:\s*(\d+)\/(\d+)\s*stored\s*(?:\((\d+\.?\d*)%\s*of\s*real tip\))?/.exec(seg))) {
          out.stored = +r[1]; out.storedOf = +r[2]; if (r[3] != null) out.storedPct = +r[3]; claims += 1;
        } else if ((r = /^in flight\s+(\d+)(?:\s*of\s*window\s*(\d+))?(?:\s*through\s*(\d+))?\s*(?:\((.*)\))?/.exec(seg))) {
          out.inFlight = +r[1];
          if (r[2] != null) out.windowSize = +r[2];
          if (r[3] != null) out.throughHeight = +r[3];
          const paren = (r[4] || '').trim();
          if (paren) {
            out.gapText = paren;
            const landed = /([\d.]+)%\s*landed/.exec(paren);
            if (landed) out.landedPct = +landed[1];
            const gap = /oldest gap\s*(\d+)s\s*at\s*(\d+)/.exec(paren);
            if (gap) { out.oldestGapSec = +gap[1]; out.oldestGapAtHeight = +gap[2]; }
            else if (/^no gap/i.test(paren)) out.oldestGapSec = 0;
          }
          claims += 1;
        } else if ((r = /^applied=(\d+)\s+lag=(\d+)/.exec(seg))) {
          out.applied = +r[1]; out.appliedLag = +r[2]; claims += 1;
        } else {
          const pairs = [...seg.matchAll(/\b([a-z][a-z0-9_]*)\s+(-?\d+(?:\.\d+)?)/g)];
          for (const [, label, value] of pairs) {
            (out.extraFields ||= []).push(label);
            (out.extraValues ||= {})[label] = value;
          }
        }
      }
      if (claims < 2) return null;
      if (out.extraFields?.length) out.unexpected = `progress line carries fields no rule knows yet: ${out.extraFields.join(', ')}`;
      return out;
    },
  },
  // [serve] inbound 127.0.0.1:34184 accepted -> child pid 3425259 (1/245 inbound)
  // The node forks a child per inbound connection, so this is the inbound half of
  // the peer table -- which matters most when the handshake then fails, because
  // getpeerinfo never sees the connection at all. 646 of these arrived in half an
  // hour on the production node, all from 127.0.0.1, all failing v2.
  {
    name: 'serveInboundAccept',
    re: /\[serve\]\s*inbound\s*(\S+)\s*accepted ->\s*child pid\s*(\d+)\s*\((\d+)\/(\d+) inbound\)/,
    apply(m) {
      const a = addrParts(m[1]);
      return {
        kind: 'peer_connect', direction: 'inbound', addr: a?.addr ?? m[1], host: a?.host ?? m[1],
        childPid: +m[2], inboundCount: +m[3], inboundCap: +m[4], reason: 'inbound accepted',
      };
    },
  },
  // [serve] inbound 127.0.0.1:34184 v2 handshake failed -- dropping
  // The peer is gone before the protocol version is known, so no RPC ever learns
  // it existed. 323 accepts, 323 failures: whatever is probing the node's P2P port
  // locally cannot speak BIP324.
  {
    name: 'serveHandshakeFail',
    re: /\[serve\]\s*inbound\s*(\S+)\s*(v\d) handshake failed\s*--+\s*dropping/,
    apply(m) {
      const a = addrParts(m[1]);
      return {
        kind: 'peer_reject', addr: a?.addr ?? m[1], host: a?.host ?? m[1],
        transport: m[2], reason: `${m[2]} handshake failed`, severity: 'warn',
      };
    },
  },
  // [serve] shutting down (signal 15): tip=965914 outbound_legs=0
  // The monitor's RPC goes away a moment later, so a restart that is not in the log
  // looks like a network fault. This line says what actually happened, including
  // the tip the node last had -- useful when the question is "did it lose blocks".
  {
    name: 'serveShutdown',
    re: /\[serve\]\s*shutting down\s*\(signal (\d+)\):\s*tip=(\d+)(?:\s+outbound_legs=(\d+))?/,
    apply(m) {
      return { kind: 'node_shutdown', signal: +m[1], tipAtShutdown: +m[2], outboundLegs: m[3] == null ? null : +m[3], severity: 'warn' };
    },
  },
  // [dlc]   w1 84.215.4.221:8333     chunks=54   blocks=2160   (+10 blk/s, 941.2KB/s)
  // [dlc]   w2 164.90.253.129:8333   chunks=0    blocks=0      (+0 blk/s, 0.0B/s) [early-kill, last 0.0B/s, peer BANNED]
  // [dlc]   w3 13.41.145.246:8333    chunks=0    blocks=0      (+0 blk/s, 0.0B/s) (Dragging: 1 of 3)
  //
  // Per-peer DOWNLOAD RATE for one named peer. Nothing in the RPC offers this:
  // getpeerinfo on the production build answers [] and on the bench build answers
  // rows whose bytessent/bytesrecv sum to getnettotals -- 3 KB of a ~47 GB run
  // (MEASUREMENTS 3). This line is the only per-peer throughput that exists.
  // blk/s can be negative: the node prints `+-46 blk/s` when a worker is being
  // re-windowed, and that is decoded as negative rather than dropped.
  {
    name: 'dlcWorkerPeer',
    re: /\[dlc\]\s*w(\d+)\s+(\S+?)\s+chunks=(\d+)\s+blocks=(\d+)\s*\(\+(-?\d+) blk\/s,\s*([^\s)][^)]*)\)(?:\s*[\[(]([^\])]*?)[\])])?/,
    apply(m) {
      const a = addrParts(m[2]);
      const note = (m[7] || '').trim() || null;
      const banned = /banned/i.test(note || '');
      return {
        kind: 'peer_throughput', worker: +m[1],
        addr: a?.addr ?? m[2], host: a?.host ?? m[2],
        chunks: +m[3], blocks: +m[4], blkPerSec: +m[5], rate: parseRate(m[6].trim()),
        note, banned,
        severity: banned || /early-kill/i.test(note || '') ? 'warn' : 'info',
      };
    },
  },
  // [dlc]   #1 57.132.130.217:8333    1270 KB/s   (a row of the ranking table)
  {
    name: 'dlcRankRow',
    re: /\[dlc\]\s*#(\d+)\s+(\S+?)\s+([0-9.]+\s*[KMG]?B\/s)\s*$/,
    apply(m) {
      const a = addrParts(m[2]);
      return { kind: 'peer_speed', rank: +m[1], addr: a?.addr ?? m[2], host: a?.host ?? m[2], rate: parseRate(m[3].trim()) };
    },
  },
  // [dlc] -- peer status (16/16 worker(s) active) --
  { name: 'dlcWorkerStatus', re: /\[dlc\]\s*--\s*peer status\s*\((\d+)\/(\d+) worker\(s\) active\)/, apply: (m) => ({ kind: 'worker_status', active: +m[1], total: +m[2], severity: +m[1] < +m[2] ? 'warn' : 'info' }) },
  // [dlc] -- 1 peer(s) dropped for lacking NODE_WITNESS; 0 redial(s) skipped since --
  { name: 'dlcPeerDropCount', re: /\[dlc\]\s*--\s*(\d+) peer\(s\) dropped for lacking NODE_WITNESS;\s*(\d+) redial\(s\) skipped since\s*--/, apply: (m) => ({ kind: 'peer_drop_count', dropped: +m[1], redialsSkipped: +m[2], severity: +m[1] > 0 ? 'warn' : 'info' }) },
  // [dlc] headers +3 from 57.132.130.217:8333 (total 966011)
  { name: 'dlcHeaders', re: /\[dlc\]\s*headers\s*\+(\d+)\s*from\s*(\S+?)\s*\(total\s*(\d+)\)/, apply: (m) => { const a = addrParts(m[2]); return { kind: 'headers_from', headers: +m[1], addr: a?.addr ?? m[2], host: a?.host ?? m[2], total: +m[3] }; } },
  // [dlc] == elapsed 1:22:12 | eta 00:07:54:27 | overall: 391483/966011 stored (40.53% of real tip)
  //         | in flight 279 of window 4096 through 391761 (oldest gap 0s at 388878, 99.93% landed)
  //         | applied=388876 lag=1 ==
  // The node's OWN sync arithmetic, including its own ETA -- kept as a separate
  // labelled figure and never merged with the monitor's measured rate (rules 4 and
  // 9). Stored, not streamed: 424 of these arrive per 80 minutes of IBD.
  //
  // Parsed by `dlcProgressFields` above, which subsumes the rigid rule this used to
  // have: an end-anchored pattern here matched 185 of 185 progress lines on the old
  // grammar and then 0 of 185 when the parenthetical became `(no gap, 100.00%
  // landed)`. Two code paths for one line is how that happens.
  // [utxo_live] catchup progress: height=135639/966010 (14.0%) 23.3 blk/s (avg 23.3)
  //               eta 00:09:55:05 | read 0% idx 0% verify 70% ... (42.40 ms/blk over 1)
  // A third rate, from the state-applying thread rather than the download worker.
  // Again: stored beside the others, not averaged with them.
  {
    name: 'catchupProgress',
    // 2026-09-16 (audit L6): the phase text was `\|\s*(.*?)\s*\(`, quadratic on spaces;
    // it is now everything between the bar and the parenthesis. Only the `name N%` pairs
    // are read out of it, so the spaces it now keeps change nothing. The eta stops at a
    // bar, so a run of bars is not re-scanned once for every bar in it.
    re: /\[utxo_live\]\s*catchup progress:\s*height=(\d+)\/(\d+)\s*\((\d+\.?\d*)%\)\s*([\d.]+)\s*blk\/s\s*\(avg\s*([\d.]+)\)\s*eta\s*([^\s|]+)\s*\|(.*?)\(([\d.]+)\s*ms\/blk over (\d+)\)/,
    apply(m) {
      // Groups: 1 height 2 of 3 pct 4 blk/s 5 avg 6 eta 7 phase text 8 ms/blk 9 samples.
      // An earlier cut of this apply() read 8/9/10 and returned msPerBlk 155 for a
      // line printing "15.90 ms/blk" -- caught by decoding a real line, not by the
      // test I would have written around my own assumption.
      const phases = {};
      for (const [, name, pct] of (m[7] || '').matchAll(/\b([a-z0-9_]+)\s+(\d+(?:\.\d+)?)%/g)) phases[name] = +pct;
      return {
        kind: 'catchup_progress',
        height: +m[1], of: +m[2], pct: +m[3], blkPerSec: +m[4], avgBlkPerSec: +m[5],
        nodeEtaMs: parseClock(m[6]), phases: Object.keys(phases).length ? phases : null,
        msPerBlk: +m[8], samples: +m[9],
      };
    },
  },
  // [utxo_live] compaction done in 0.3s (12 run(s) [0..12) of 12, mid-catchup, full merge;
  //   started at height 138932): manifest_n 12 -> 1, merged into run 36, 0 flushed meanwhile,
  //   12 input run(s) unlinked; apply never waited
  {
    name: 'utxoCompaction',
    re: /\[utxo_live\]\s*compaction done in\s*([\d.]+)s\s*\((\d+) run\(s\)\s*\[[^\]]*\)\s*of\s*(\d+)(?:[^;\d][^;]*)?;\s*started at height\s*(\d+)\)?:\s*manifest_n\s*(\d+)\s*->\s*(\d+),\s*merged into run\s*(\d+),\s*(\d+) flushed meanwhile,\s*(\d+) input run\(s\) unlinked;\s*apply\s*(never waited|waited[^;,]*)/,
    apply(m) {
      const waited = m[10] !== 'never waited';
      return {
        kind: 'utxo_compaction',
        secs: +m[1], runsMerged: +m[2], runsTotal: +m[3], startedAtHeight: +m[4],
        manifestFrom: +m[5], manifestTo: +m[6], runId: +m[7],
        flushedMeanwhile: +m[8], inputsUnlinked: +m[9],
        applyWaited: waited, detail: m[10],
        // "apply waited" is the one clause that says UTXO compaction stalled
        // block validation, which is a thing an operator needs to see unprompted.
        severity: waited ? 'warn' : 'info',
      };
    },
  },
  // [check] checklevel=3 over 6 block(s) [136156..136161]: 1 examined, 5 hole(s), 1 problem(s)
  {
    name: 'checkLevel',
    re: /\[check\]\s*checklevel=(\d+)\s*over\s*(\d+) block\(s\)\s*\[(\d+)\.\.(\d+)\]:\s*(\d+) examined,\s*(\d+) hole\(s\),\s*(\d+) problem\(s\)/,
    apply(m) {
      const problems = +m[7];
      return {
        kind: 'checklevel', level: +m[1], blocks: +m[2], from: +m[3], to: +m[4],
        examined: +m[5], holes: +m[6], problems,
        severity: problems > 0 ? 'warn' : 'info',
      };
    },
  },
  // [dl] outbound 4 = 24.9.164.99:8333 (fd 70) proto=70016 services=0xc49 ua="/Satoshi:31.0.0/" height=966010 addrv2=1
  // Peer identity. On the production build getpeerinfo answers [] and on the
  // bench build it answers 5 rows covering 3 KB of a ~47 GB run (MEASUREMENTS 3),
  // so the log remains the only complete list of who we are talking to.
  {
    name: 'peerIdentify',
    // `filled outbound 7 = … [background dial]` (2026-09-10 on) is the same line for a slot
    // filled by the background dialer: 121 lines of the current logs raw until 2026-09-19.
    re: /\[dl\]\s*(filled )?(outbound|inbound)\s*(\d+)\s*=\s*(\S+?)\s*\(fd\s*(\d+)\)\s*proto=(\d+)\s*services=(\S+?)\s*ua="([^"]*)"\s*height=(\d+)(?:\s+addrv2=(\d))?(?:\s+\[([^\]]+)\])?/,
    apply(m) {
      const a = addrParts(m[4]);
      return {
        kind: 'peer_identify', direction: m[2], index: +m[3],
        addr: a?.addr ?? m[4], host: a?.host ?? m[4], fd: +m[5], proto: +m[6],
        services: m[7], userAgent: m[8], peerHeight: +m[9], addrv2: m[10] == null ? null : m[10] === '1',
        ...(m[1] ? { filled: true, via: m[11] ?? null } : {}),
      };
    },
  },
  // [dl] archive at 136161, peers announce 966010: 829849 blocks behind -- running the parallel downloader (16 workers)
  {
    name: 'ibdBehind',
    re: /\[dl\]\s*archive at\s*(\d+),\s*peers announce\s*(\d+):\s*(\d+) blocks behind\s*--+\s*running the parallel downloader\s*\((\d+) workers\)/,
    apply: (m) => ({ kind: 'ibd_behind', archiveHeight: +m[1], announcedTip: +m[2], behind: +m[3], workers: +m[4] }),
  },
  // [dl] connected 5/8 peer(s); downloading across them...
  { name: 'dlConnected', re: /\[dl\]\s*connected\s*(\d+)\/(\d+)\s*peer\(s\);\s*downloading/, apply: (m) => ({ kind: 'dl_connected', connected: +m[1], wanted: +m[2] }) },
  // [dl] per-block lines and tip announcements are off while the tip is older than maxtipage
  //      (initial block download; Core relays no blocks in IBD) -- they resume at the tip
  //
  // Kept as a rule because it is the *reason* the per-peer panels are empty during
  // IBD. When a panel has no data, this line is the answer, and an unexplained
  // blank is what rule 3 is about.
  {
    name: 'relayPaused',
    re: /\[dl\]\s*per-block lines and tip announcements are off\s*while the tip is older than maxtipage\s*\(([^)]*)\)/,
    apply: (m) => ({ kind: 'relay_paused', reason: m[1].trim(), resumes: 'at the tip' }),
  },
  // [dlc] discovered +0 peers (book now 339) | 304 candidate peer(s) in pool
  //      | 121 confirmed-live peer(s) (1 probe round(s))
  { name: 'peerDiscovery', re: /\[dlc\]\s*discovered\s*([-+]\d+)\s*peers\s*\(book now\s*(\d+)\)/, apply: (m) => ({ kind: 'peer_discovery', delta: +m[1], book: +m[2] }) },
  { name: 'peerCandidates', re: /\[dlc\]\s*(\d+) candidate peer\(s\) in pool/, apply: (m) => ({ kind: 'peer_candidates', candidates: +m[1] }) },
  { name: 'peerLiveProbe', re: /\[dlc\]\s*(\d+) confirmed-live peer\(s\)\s*\((\d+) probe round\(s\)\)/, apply: (m) => ({ kind: 'peer_live_probe', live: +m[1], probeRounds: +m[2] }) },
  // [txrelay] addrv2 gossip: +3 address(es) to the book
  // 418 occurrences on production, median 22 s apart. This is the chatter that made
  // the corpus parse ratio fall to 73.4% today while costing no measurement at all --
  // parsed so the ratio means something again, and so book growth is a figure. `addr gossip`
  // (v1 addr messages, since 2026-09-12) is the same line and the same figure.
  // [dial-handoff] 203.0.113.61:8333: helper hands fd over 445ms after the dial began (v1) pend=0 first=- eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED
  // [dial-handoff] 203.0.113.61:8333: worker received fd 41 461ms after the dial began pend=1150 first=sendcmpct eof=0 hup=0 err=0 so_error=0 tcp=ESTABLISHED
  // bmc's handoff probe (1dcb859f, 2026-09-24): the helper's side and the worker's side of
  // one dial. `pend` is bytes already waiting on the socket, `first` the first message in them.
  {
    name: 'dialHandoff',
    keys: ['dial-handoff'],
    re: /\[dial-handoff\]\s*(\S+): (?:helper hands fd over|worker received fd \d+) (\d+)ms after the dial began(?: \((v\d)\))? pend=(\d+) first=(\S+) eof=(\d+) hup=(\d+) err=(\d+) so_error=(\d+) tcp=(\S+)/,
    apply: (m) => ({
      kind: 'dial_handoff', side: m[0].includes('helper hands') ? 'helper' : 'worker',
      host: m[1].replace(/:\d+$/, ''), ms: +m[2], transport: m[3] ?? null, pend: +m[4], first: m[5] === '-' ? null : m[5],
      eof: +m[6], hup: +m[7], err: +m[8], soError: +m[9], tcp: m[10],
    }),
  },
  { name: 'addrGossip', re: /\[txrelay\]\s*addr(?:v2)? gossip:\s*\+(\d+)\s*address\(es\)\s*to the book/, apply: (m) => ({ kind: 'addr_gossip', added: +m[1] }) },
  // [dl] outbound top-up: 4 dial(s) failed, first 172.104.174.241:8333: peer lacks NODE_WITNESS
  // The reason is the finding, so it is kept verbatim: 'peer lacks NODE_WITNESS' and
  // 'handshake failed (rc=0)' are different problems. Aggregate in the monitor --
  // median 59 s, p95 393 s apart on production.
  {
    name: 'dialTopUpFails',
    re: /\[dl\]\s*outbound top-up:\s*(\d+)\s*dial\(s\) failed(?:,\s*first\s+(\S+):(.+))?\s*$/,
    apply(m) {
      const a = m[2] ? addrParts(m[2]) : null;
      return {
        kind: 'dial_failures', failed: +m[1], firstHost: a?.host ?? null, firstAddr: a?.addr ?? null,
        reason: (m[3] || '').trim() || null,
        severity: +m[1] > 0 ? 'warn' : 'info',
      };
    },
  },
  // [dl] updating utxo: applied 2 block(s), now at height 966001, live=165338542 (0.34s)
  // Validation throughput from the thread that applies blocks: a third rate, and it
  // stays a third rate. The download rate, `[utxo_live] catchup progress` and this one
  // measure different things and are never averaged (rule 9).
  {
    name: 'utxoApply',
    re: /\[dl\]\s*updating utxo:\s*applied\s*(\d+)\s*block\(s\),\s*now at height\s*(\d+),\s*live=(\d+)\s*\(([\d.]+)s\)/,
    apply(m) {
      const blocks = +m[1], secs = +m[4];
      return {
        kind: 'utxo_apply', blocks, height: +m[2], utxoCount: +m[3], secs,
        blocksPerSec: secs > 0 ? +(blocks / secs).toFixed(2) : null,
      };
    },
  },
  // [dl] header mirror +1 from the archive (now 966055, archive tip 966054)
  // How far the header chain is running ahead of what has been applied.
  {
    name: 'headerMirror',
    re: /\[dl\]\s*header mirror\s*\+(\d+)\s*from the archive\s*\(now\s*(\d+),\s*archive tip\s*(\d+)\)/,
    apply(m) {
      return { kind: 'header_mirror', added: +m[1], headersNow: +m[2], archiveTip: +m[3], gap: +m[2] - +m[3] };
    },
  },
  // [dial] 31.47.202.112:8333: dialing in the background (ipv4)
  // Aggregate only: 52 of these in the sampled window would be a feed of nothing
  // but dial attempts.
  {
    name: 'dialAttempt',
    re: /\[dial\]\s*(\S+?):\s*dialing in the background\s*(?:\((\w+)\))?/,
    apply(m) {
      const a = addrParts(m[1]);
      return { kind: 'dial_attempt', addr: a?.addr ?? m[1], host: a?.host ?? m[1], family: m[2] ?? null };
    },
  },
  // [dial] 172.104.174.241:8333: background dial failed: peer lacks NODE_WITNESS
  // One per host with a reason, at ~20 per window: that volume belongs in the peer
  // event list, which is what it is for.
  {
    name: 'dialBackgroundFail',
    // 2026-09-16 (audit L6): `:\s*(.+?)\s*$` became `:(.+)$` (here and in dialTopUpFails):
    // the same text once trimmed, and one pass to the end instead of one per space.
    re: /\[dial\]\s*(\S+?):\s*background dial failed:(.+)$/,
    apply(m) {
      const a = addrParts(m[1]);
      return { kind: 'peer_reject', direction: 'outbound', addr: a?.addr ?? m[1], host: a?.host ?? m[1], reason: m[2].trim(), severity: 'warn' };
    },
  },
  // [dial] no global IPv6 route on this host: ipv6 peers are unreachable (cjdns unaffected)
  // A capability the host lacks, not a peer problem, and it explains an ipv6 peer
  // count of zero better than the count does.
  {
    name: 'noIPv6',
    re: /\[dial\]\s*no global IPv6 route on this host:\s*(ipv6 peers are unreachable)\s*(\(([^)]*)\))?/,
    apply(m) {
      return { kind: 'network_note', note: m[1], caveat: (m[3] || '').trim() || null, severity: 'info' };
    },
  },

  // ------------------------------------------------- the chain view's fold (run 27)
  // A QUARTER OF THE NODE'S LOG, and until 2026-09-18 none of it was read. Reported
  // upstream from here with the numbers (24.0% of run 26; 79.1% of the fold lines said
  // present=0 new=0; err and short were non-zero ZERO times in 30 hours), and the node
  // changed rather than this parser: bitcoinmachinecode PR #265 split one throttle into
  // two, so run 27 writes ~77% fewer fold lines. The shape is the same, with two new
  // optional tails -- the anomaly marker, and a count of the quiet passes a heartbeat
  // stands for. Both are read here, because "nothing happened 412 times" is a figure.
  {
    name: 'idxFold',
    re: /\[idx\]\s*fold (-?\d+)\.\.(-?\d+):\s*read=(\d+) present=(\d+) new=(\d+) dup=(\d+) short=(\d+) err=(\d+) r=(-?\d+) folded_to=(-?\d+) slots=(\d+)(\s+<-- PRESENT BUT NOT INSERTED)?(?:\s+\(\+(\d+) quiet pass\(es\), read=(\d+)\))?/,
    apply(m) {
      const err = +m[8], short = +m[7];
      const anomaly = m[12] != null;
      return {
        kind: 'index_fold', from: +m[1], to: +m[2], read: +m[3], present: +m[4], added: +m[5],
        dup: +m[6], short, err, r: +m[9], foldedTo: +m[10], slots: +m[11],
        // The node never throttles trouble or the anomaly now, so either reaching us
        // means it happened rather than that it happened to fall outside a window.
        anomaly, quietPasses: m[13] == null ? null : +m[13], quietRead: m[14] == null ? null : +m[14],
        severity: err > 0 || short > 0 || anomaly ? 'warn' : 'info',
      };
    },
  },
  // [idx] chain view open: stored tip=967325, by-hash table 65536 slots
  {
    name: 'idxViewOpen',
    re: /\[idx\]\s*chain view open:\s*stored tip=(-?\d+), by-hash table (\d+) slots/,
    apply: (m) => ({ kind: 'index_view_open', tip: +m[1], slots: +m[2] }),
  },
  // [idx] table full; grew to 131072 slots, reload 0..967325: present=67081 new=67081 r=0 folded_to=67080
  {
    name: 'idxTableGrew',
    re: /\[idx\]\s*table full; grew to (\d+) slots, reload (-?\d+)\.\.(-?\d+):\s*present=(\d+) new=(\d+) r=(-?\d+) folded_to=(-?\d+)/,
    apply: (m) => ({ kind: 'index_table_grew', slots: +m[1], from: +m[2], to: +m[3], present: +m[4], added: +m[5], r: +m[6], foldedTo: +m[7] }),
  },
  // [idx] grow to 262144 slots FAILED (malloc)
  // Never seen in any run; it is the branch the two above exist to avoid, so it is read
  // as a warning rather than left to arrive as an unstructured row on the day it happens.
  {
    name: 'idxGrowFailed',
    re: /\[idx\]\s*grow to (\d+) slots FAILED \(([^)]*)\)/,
    apply: (m) => ({ kind: 'index_grow_failed', slots: +m[1], why: m[2], severity: 'warn' }),
  },

  // --------------------------------------------------- the rest of run 26's remainder
  // [utxo_live] merge of 2 run(s) deferred: the apply is 533584 blocks behind the archive (waits under 24 runs)
  // The second biggest unread shape (2,349 lines). It is the reason the run count sits
  // above its threshold during catch-up, so it explains a number the page already shows.
  {
    name: 'utxoMergeDeferred',
    re: /\[utxo_live\]\s*merge of (\d+) run\(s\) deferred:\s*the apply is (-?\d+) blocks behind the archive \(waits under (\d+) runs\)/,
    apply: (m) => ({ kind: 'utxo_merge_deferred', runs: +m[1], applyLag: +m[2], waitsUnder: +m[3] }),
  },
  // [dial] memory: 3 address(es) remembered, 0 candidate(s) skipped under backoff; blocks: 0 claimed, 0 duplicate fetch(es) avoided
  {
    name: 'dialMemory',
    // Builds before 2026-09-12 printed the first half only; the block figures are then null.
    re: /\[dial\]\s*memory:\s*(\d+) address\(es\) remembered, (\d+) candidate\(s\) skipped under backoff(?:; blocks:\s*(\d+) claimed, (\d+) duplicate fetch\(es\) avoided|$)/,
    apply: (m) => ({ kind: 'dial_memory', remembered: +m[1], skippedBackoff: +m[2], blocksClaimed: m[3] == null ? null : +m[3], duplicateFetchesAvoided: m[4] == null ? null : +m[4] }),
  },
  // [tip] 75.157.152.207:8333 announced block 00000000.. by headers: its pass runs next
  // WHICH PEER TOLD US FIRST, and how. RPC has no equivalent; `block_stored` names who
  // served a block, this names who announced it, which is a different peer's credit.
  {
    name: 'tipAnnounced',
    re: /\[tip\]\s*(\S+?)\s+announced block\s+([0-9a-f]{2,}\.\.)\s+by\s+(.+?):\s*its pass runs next/,
    apply(m) {
      const a = addrParts(m[1]);
      return { kind: 'tip_announced', addr: a?.addr ?? m[1], host: a?.host ?? m[1], hashPrefix: m[2].replace(/\.+$/, ''), via: m[3].trim() };
    },
  },
  // [cmpct] 38.15.35.109:8333 accepts compact blocks: requesting MSG_CMPCT_BLOCK on this leg from now on
  {
    name: 'cmpctAccepts',
    re: /\[cmpct\]\s*(\S+?)\s+accepts compact blocks:\s*(.+)$/,
    apply(m) {
      const a = addrParts(m[1]);
      return { kind: 'cmpct_peer', addr: a?.addr ?? m[1], host: a?.host ?? m[1], note: m[2].trim() };
    },
  },
  // [cmpct] 86.127.254.44:8333 delivered a block: high-bandwidth compact blocks from this leg from now on (Core: the last 3 block sources)
  // [cmpct] 86.127.254.44:8333 back to low-bandwidth compact blocks (the high-bandwidth set holds 3)
  {
    name: 'cmpctBandwidth',
    re: /\[cmpct\]\s*(\S+?)\s+(?:delivered a block:\s*(high)-bandwidth compact blocks|back to (low)-bandwidth compact blocks)(?:.*?holds (\d+))?/,
    apply(m) {
      const a = addrParts(m[1]);
      return { kind: 'cmpct_bandwidth', addr: a?.addr ?? m[1], host: a?.host ?? m[1], mode: m[2] ?? m[3], setSize: m[4] == null ? null : +m[4] };
    },
  },
  // [cmpct] reconstructed 6 block(s) from the mempool (6 needed a getblocktxn round trip, 0 fell back to a full block)
  {
    name: 'cmpctReconstructed',
    re: /\[cmpct\]\s*reconstructed (\d+) block\(s\) from the mempool \((\d+) needed a getblocktxn round trip, (\d+) fell back to a full block\)/,
    apply: (m) => ({ kind: 'cmpct_reconstructed', blocks: +m[1], roundTrips: +m[2], fellBack: +m[3] }),
  },
  // [cmpct] block 967440 (86.127.254.44:8333): 26 tx: 0 from the mempool (0.0%), 1 prefilled, 25 fetched by getblocktxn (3889 KB): 25 never announced, ...
  // How much of a block the mempool already held is the compact-block hit rate, and the
  // KB fetched is bandwidth this node spent because it did not.
  {
    name: 'cmpctBlock',
    re: /\[cmpct\]\s*block (\d+)(?:\s+hash=([0-9a-f]{6,}))?\s*\((\S+?)\):\s*(\d+) tx:\s*(\d+) from the mempool \(([\d.]+)%\), (\d+) prefilled, (\d+) fetched by getblocktxn \(([\d.]+) ([KMG]?B)\)/,
    apply(m) {
      const a = addrParts(m[3]);
      return {
        kind: 'cmpct_block', height: +m[1], hashPrefix: m[2] ?? null, addr: a?.addr ?? m[3], host: a?.host ?? m[3],
        txs: +m[4], fromMempool: +m[5], hitPct: +m[6], prefilled: +m[7], fetched: +m[8], fetchedBytes: parseSize(`${m[9]}${m[10]}`),
      };
    },
  },
  // [dl] outbound top-up: 1 dial(s) not started, first 141.239.119.165:8333: no dial helper free
  // The node saying it WANTED a peer and could not start the dial -- which is why a
  // connection count sits below its target, and is not visible anywhere else.
  {
    name: 'dlTopUpBlocked',
    // `(\S+)` greedy, not `(\S+?)`: the address carries its own colon, and a lazy
    // capture stopped at it -- addr "141.239.119.165", reason "8333: no dial helper free".
    re: /\[dl\]\s*outbound top-up:\s*(\d+) dial\(s\) not started, first (\S+):\s*(.+)$/,
    apply(m) {
      const a = addrParts(m[2]);
      return { kind: 'dial_failures', notStarted: +m[1], addr: a?.addr ?? m[2], host: a?.host ?? m[2], reason: m[3].trim(), severity: 'info' };
    },
  },
  // [pool] 0 peer(s) sampled from the book: ipv4 0, ipv6 0, onion 0, i2p 0, cjdns 0 (book has 0/0/0/0/0 dialable)
  {
    name: 'poolSample',
    re: /\[pool\]\s*(\d+) peer\(s\) sampled from the book:\s*ipv4 (\d+), ipv6 (\d+), onion (\d+), i2p (\d+), cjdns (\d+)\s*\(book has (\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+) dialable\)/,
    apply: (m) => ({
      kind: 'pool_sample', sampled: +m[1],
      byFamily: { ipv4: +m[2], ipv6: +m[3], onion: +m[4], i2p: +m[5], cjdns: +m[6] },
      dialable: { ipv4: +m[7], ipv6: +m[8], onion: +m[9], i2p: +m[10], cjdns: +m[11] },
    }),
  },
  // [coinstats_hist] pass1 w0 10000/120922 (0s)
  // Both spellings: the tag was `[coinstats-hist]` until PR #263 renamed it, and a
  // hyphenated tag is one TAG_RE cannot claim, so it is still sitting in the text.
  {
    name: 'coinstatsHistPass',
    keys: ['coinstats_hist', 'coinstats-hist'],
    // Pass 4 adds a running `txouts=N` before the time (read since 2026-09-19).
    re: /\[coinstats[-_]hist\]\s*pass(\d+)(?:\s+w(\d+))? (\d+)\/(\d+)(?: txouts=(\d+))? \((\d+(?:\.\d+)?)s\)/,
    apply: (m) => ({ kind: 'coinstats_hist_pass', pass: +m[1], worker: m[2] == null ? null : +m[2], done: +m[3], of: +m[4], secs: +m[6], ...(m[5] != null ? { txouts: +m[5] } : {}) }),
  },

  // ---------------------------------------------------------- the index builders
  // The tag alternation is spelled out in each rule rather than built from
  // INDEX_NAMES: a literal regex is what every other rule in this file is, and a
  // constructed one would be the only thing here that cannot be read at a glance.

  // [txindex] run txindex.r000000000-000019999.dat: 20136 records, heights [0,19999]
  // The run inventory, re-listed whenever the set changes: 760 of the family's lines.
  // State, not feed.
  {
    name: 'indexRunListed',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*run (\S+\.dat):\s*(\d+) ([a-z]+), heights \[(-?\d+),(-?\d+)\]/,
    apply: (m) => ({ kind: 'index_run_listed', index: INDEX_NAMES[m[1]], file: m[2], rows: +m[3], noun: m[4], from: +m[5], to: +m[6] }),
  },
  // [txindex] trail: building run [0,19999] with /…/bmc_build_tx_index (pid 1669405)
  {
    name: 'indexRunStart',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*trail: building run \[(\d+),(\d+)\] with (\S+) \(pid (\d+)\)/,
    apply: (m) => ({ kind: 'index_run_start', index: INDEX_NAMES[m[1]], from: +m[2], to: +m[3], tool: m[4], pid: +m[5] }),
  },
  // [txindex] run [0,19999] built by pid 1669405 in 2s (1 runs so far)
  {
    name: 'indexRunBuilt',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*run \[(\d+),(\d+)\] built by pid (\d+) in (\d+)s \((\d+) runs so far\)/,
    apply: (m) => ({ kind: 'index_run_built', index: INDEX_NAMES[m[1]], from: +m[2], to: +m[3], pid: +m[4], secs: +m[5], runs: +m[6] }),
  },
  // [txindex] trail: merging 6 runs with /…/bmc_merge_index_runs (pid 1677449)
  {
    name: 'indexMergeStart',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*trail: merging (\d+) runs with (\S+) \(pid (\d+)\)/,
    apply: (m) => ({ kind: 'index_merge_start', index: INDEX_NAMES[m[1]], runs: +m[2], tool: m[3], pid: +m[4] }),
  },
  // [addr_hist] runs merged by pid 1677451 in 3s (1 merges so far)
  {
    name: 'indexMerged',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*runs merged by pid (\d+) in (\d+)s \((\d+) merges so far\)/,
    apply: (m) => ({ kind: 'index_merged', index: INDEX_NAMES[m[1]], pid: +m[2], secs: +m[3], merges: +m[4] }),
  },
  // [txindex] tail rotated: 20136 records folded into runs (to 19999), 965 kept
  {
    name: 'indexTailRotated',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*tail rotated:\s*(\d+) ([a-z]+) folded into runs \(to (\d+)\), (\d+) kept/,
    apply: (m) => ({ kind: 'index_tail_rotated', index: INDEX_NAMES[m[1]], folded: +m[2], noun: m[3], to: +m[4], kept: +m[5] }),
  },
  // [txindex] tail active: base to=319999 covered=321800 (backfilled 0)
  // `covered` above `base to` is the live tail carrying the index past its last run,
  // which is the only line that says the index is usable ahead of its runs.
  {
    name: 'indexTailActive',
    // `base to=-1` is a real value, not a typo: it is what an index with no run yet
    // reports, and a `\d+` here read the empty index as "base to=1" for four lines of
    // every run before the first fold.
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*tail active: base to=(-?\d+) covered=(\d+) \(backfilled (\d+)\)/,
    apply: (m) => ({ kind: 'index_tail_active', index: INDEX_NAMES[m[1]], baseTo: +m[2], covered: +m[3], backfilled: +m[4] }),
  },
  // [txindex] dir=/…/main tip=967325 range=[0,19999]
  // [addrhist] dir=/…/main tip=967325 range=[0,19999] (run: spends from undo) -> addr_hist.r000000000-000019999.dat
  // The child's first line. No timestamp: see the note above INDEX_NAMES.
  {
    name: 'indexScanStart',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*dir=(\S+) tip=(\d+) range=\[(\d+),(\d+)\](?:\s*\(run: ([^)]*)\))?(?:\s*->\s*(\S+))?/,
    apply: (m) => ({ kind: 'index_scan_start', index: INDEX_NAMES[m[1]], dir: m[2], tip: +m[3], from: +m[4], to: +m[5], note: m[6] ?? null, file: m[7] ?? null }),
  },
  // [txindex] pass1 0/19999 (1 txs, 0s)   |   [addrhist] pass3 bucket 0/256 (0 keys, 0s)
  {
    name: 'indexPass',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*pass(\d+)(?: (bucket))? (\d+)\/(\d+) \(([^)]*)\)/,
    apply(m) {
      const list = parseCountList(m[6]);
      return { kind: 'index_pass', index: INDEX_NAMES[m[1]], pass: +m[2], unit: m[3] ? 'bucket' : 'height', done: +m[4], of: +m[5], counts: list.counts, secs: list.secs };
    },
  },
  // [txindex] pass1 done: 20136 transactions in 0s   |   [addrhist] pass1 done: 77 funds, 0 spendrefs, 0s
  // Two spellings of the same line ("… in 0s" and "…, 0s"), so the seconds are read
  // from either by putting both through the count list.
  {
    name: 'indexPassDone',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*pass(\d+) done:\s*(.+)$/,
    apply(m) {
      const list = parseCountList(m[3].replace(/\s+in\s+(\d+(?:\.\d+)?s)$/, ', $1'));
      return { kind: 'index_pass_done', index: INDEX_NAMES[m[1]], pass: +m[2], counts: list.counts, secs: list.secs, extra: list.extra };
    },
  },
  // [txindex] DONE: 20136 records, 79 sparse, 0.00 GB, 0s
  // [addrhist] DONE: 22 keys, 87 events (77 funds, 10 spends), to height 19999, 0.00 GB, 0s
  {
    name: 'indexDone',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*DONE:\s*(.+)$/,
    apply(m) {
      const list = parseCountList(m[2]);
      return { kind: 'index_done', index: INDEX_NAMES[m[1]], counts: list.counts, bytes: list.bytes, secs: list.secs, height: list.height, extra: list.extra };
    },
  },
  // [txindex] merge: 6 runs, 435480 records, heights [0,119999] -> txindex.r000000000-000119999.dat
  {
    name: 'indexMergeRows',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*merge:\s*(\d+) runs,\s*(\d+) ([a-z]+), heights \[(-?\d+),(-?\d+)\]\s*->\s*(\S+)/,
    apply: (m) => ({ kind: 'index_merge_rows', index: INDEX_NAMES[m[1]], runs: +m[2], rows: +m[3], noun: m[4], from: +m[5], to: +m[6], file: m[7] }),
  },
  // [txindex] merge DONE: 435480 records, 1702 sparse, 0.01 GB, 0s
  {
    name: 'indexMergeDone',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*merge DONE:\s*(.+)$/,
    apply(m) {
      const list = parseCountList(m[2]);
      return { kind: 'index_merge_done', index: INDEX_NAMES[m[1]], counts: list.counts, bytes: list.bytes, secs: list.secs, extra: list.extra };
    },
  },
  // [txindex] 1425612630 records, heights [0,964174]
  // [txospender] 3486631449 records, to height 966038
  // What a FINISHED index reports: the totals, once, rather than a run's progress.
  // Seen only on the synced production node, which is why it is last -- every rule
  // above names its own line, and this one takes what is left that begins with a count.
  {
    name: 'indexSummary',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*(\d+ [a-z][a-z_ ]*(?:,.*)?)$/,
    apply(m) {
      const list = parseCountList(m[2]);
      if (!Object.keys(list.counts).length) return null;
      return { kind: 'index_summary', index: INDEX_NAMES[m[1]], counts: list.counts, height: list.height, from: list.from, to: list.to, bytes: list.bytes };
    },
  },
  // [txindex] no run yet -- the tail starts at genesis; the trailing builder folds it into runs
  // The state an index is in before its first run exists, printed once per boot.
  {
    name: 'indexNoRuns',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*no run yet\s*--\s*(.+)$/,
    apply: (m) => ({ kind: 'index_no_runs', index: INDEX_NAMES[m[1]], note: m[2].trim() }),
  },
  // [trail] txindex: runs reach 179999; … | txospender: building run [200000,219999] (pid 1749252) | addr_hist: …
  // One line, every builder's state, every couple of minutes. The whole point of it is
  // that the three are read together, so it parses to a map rather than three events.
  {
    name: 'indexTrail',
    re: /\[trail\]\s*(.+)$/,
    apply(m) {
      const indexes = {};
      for (const seg of m[1].split('|')) {
        const parsed = trailSegment(seg.trim());
        if (parsed) indexes[parsed[0]] = parsed[1];
      }
      if (!Object.keys(indexes).length) return null;
      return { kind: 'index_trail', indexes };
    },
  },

  // --------------------------------------------------- the boot sequence
  // WHAT THE NODE SAYS AS IT STARTS (2026-09-18: the monitor flagged "[boot] has 25 line(s) no
  // rule claims" on run 27's first start). Twenty-five lines, once per start, in 25 shapes: where
  // it logs, its chain and effective config, each boot step with its time, the DNS seeds and what
  // they gave, and the total. One of them is news -- the boot finished, in how long, at what tip
  // -- and goes to the feed; the rest is state (monitor.js `ls.boot`), the same rule as §39's
  // chatty lines. A rule per shape rather than one `[boot] .*` catch-all, so a new boot line is
  // still reported as unread instead of being claimed without being read.
  //
  // [boot] logging to /…/debug.log (debuglogfile) -- the first line of every start
  {
    name: 'bootLogging',
    // `… (debuglogfile) and to the console (printtoconsole=1)`: the production unit logs to
    // the console as well (read since 2026-09-19).
    re: /\[boot\]\s*logging to (\S+) \((\w+)\)(?: and to the console \((\w+)=(\d)\))?$/,
    apply: (m) => ({ kind: 'boot_start', logFile: m[1], via: m[2], ...(m[3] ? { console: m[4] === '1' } : {}) }),
  },
  // [boot] chain=main datadir=/… port=8462 dnsseed=1
  {
    name: 'bootChain',
    re: /\[boot\]\s*chain=(\S+) datadir=\S+ port=(\d+) dnsseed=(\d+)$/,
    apply: (m) => ({ kind: 'boot_chain', chain: m[1], port: +m[2], dnsseed: m[3] === '1' }),
  },
  // [boot] config: datadir=/… port=8462 (bitcoin.conf) listen=1 nwant=3 catchup_workers=8 (bmc.catchupworkers) dialratelimit=0/s (off) …
  // Every key=value, with the source or state the node puts in brackets after it. The datadir
  // is left out: it is a path on the node's machine, and the monitor already knows it.
  {
    name: 'bootConfig',
    re: /\[boot\]\s*config:\s*(.+)$/,
    apply(m) {
      const settings = {};
      for (const [, k, v, note] of m[1].matchAll(/(\w+)=(\S+)(?:\s+\(([^)]*)\))?/g)) {
        if (k === 'datadir') continue;
        settings[k] = note ? { value: v, note } : { value: v };
      }
      return Object.keys(settings).length ? { kind: 'boot_config', settings } : null;
    },
  },
  // [boot] boot phase complete (0.07s total) -- the news: before the timed-step rule, which would claim it
  {
    name: 'bootComplete',
    re: /\[boot\]\s*boot phase complete \((\d+(?:\.\d+)?)s total\)$/,
    apply: (m) => ({ kind: 'boot_complete', sec: +m[1] }),
  },
  // [boot] chain archive loaded: tip=0 (0.00s) · archive check clean (0.00s) · catch-up check done: 0 block(s) written (0.00s)
  // [boot] hash index build done (0.06s) · tx-validation snapshot ready (0.00s) -- inbound peers inherit it
  {
    name: 'bootStep',
    re: /\[boot\]\s*(.+?)\s*\((\d+(?:\.\d+)?)s\)(?:\s*--\s*(.+))?$/,
    apply(m) {
      const tip = m[1].match(/\btip=(-?\d+)/);
      const written = m[1].match(/(\d+) block\(s\) written/);
      return { kind: 'boot_step', step: m[1].replace(/:\s*.*$/, '').trim(), detail: m[1].trim(), sec: +m[2], note: m[3]?.trim() ?? null,
        tip: tip ? +tip[1] : null, blocksWritten: written ? +written[1] : null };
    },
  },
  // [boot] loading chain archive from disk... · checking for archive gaps / missing blocks... · building hash index...
  {
    name: 'bootStepBegin',
    re: /\[boot\]\s*(.+?)\.\.\.$/,
    apply: (m) => ({ kind: 'boot_step_begin', step: m[1].trim() }),
  },
  // [boot] main genesis seeded at height 0 (empty archive)
  {
    name: 'bootGenesis',
    re: /\[boot\]\s*(\w+) genesis seeded at height (\d+)(?:\s*\(([^)]*)\))?$/,
    apply: (m) => ({ kind: 'boot_genesis', chain: m[1], height: +m[2], note: m[3] ?? null }),
  },
  // [boot] bmc.bootcatchup=0 -- skipping the boot catch-up; the worker's far-behind trigger will run it if needed
  {
    name: 'bootCatchupSetting',
    re: /\[boot\]\s*bmc\.bootcatchup=(\d+)\s*--\s*(.+)$/,
    apply: (m) => ({ kind: 'boot_catchup_setting', bootCatchup: m[1] === '1', note: m[2].trim() }),
  },
  // [boot] pid 1394725 written to bmcbitcoind.pid
  {
    name: 'bootPid',
    re: /\[boot\]\s*pid (\d+) written to (\S+)$/,
    apply: (m) => ({ kind: 'boot_pid', pid: +m[1], file: m[2] }),
  },
  // [boot] seed.bitcoin.sipa.be -> +25 peers (dns)
  {
    name: 'bootDnsSeed',
    re: /\[boot\]\s*(\S+) -> \+(\d+) peers \(dns\)$/,
    apply: (m) => ({ kind: 'boot_dns_seed', seed: m[1], peers: +m[2] }),
  },
  // [boot] discovered +143 peers (peers2.dat now 143)
  {
    name: 'bootDiscovered',
    re: /\[boot\]\s*discovered \+(\d+) peers \((\S+) now (\d+)\)$/,
    apply: (m) => ({ kind: 'boot_discovered', added: +m[1], file: m[2], total: +m[3] }),
  },
  // [boot] 64 public peer candidate(s) in pool
  {
    name: 'bootCandidates',
    re: /\[boot\]\s*(\d+) public peer candidate\(s\) in pool$/,
    apply: (m) => ({ kind: 'boot_candidates', candidates: +m[1] }),
  },
  // [boot] archive check found 1 problem(s) in 0.03s -- see [check] lines above
  // The boot step whose time is not in brackets. The problems themselves are the [check]
  // lines, which already warn; this is the step and its count.
  {
    name: 'bootArchiveCheck',
    re: /\[boot\]\s*archive check found (\d+) problem\(s\) in (\d+(?:\.\d+)?)s\b/,
    apply: (m) => ({ kind: 'boot_step', step: 'archive check', detail: `archive check found ${m[1]} problem(s)`, sec: +m[2], note: null, tip: null, blocksWritten: null, problems: +m[1] }),
  },
  // [boot] index.dat carried 645525 empty record(s) past the tip (height 321800) -- trimmed
  // [boot] headers.dat runs 645525 linked record(s) ahead of the archive tip (headers-first): kept
  // [boot] headers.dat ran 143 record(s) past the archive tip -- trimmed to 965871 (builds before 2026-09-10)
  // [boot] headers.dat diverged from the archive at position 965018 -- trimmed (re-derived from the blocks at boot)
  // What the node did to its own files before starting: state on the boot record, where the
  // question "did this start repair anything" is answered.
  {
    name: 'bootIndexTrim',
    re: /\[boot\]\s*index\.dat carried (\d+) empty record\(s\) past the tip \(height (-?\d+)\) -- trimmed$/,
    apply: (m) => ({ kind: 'boot_repair', file: 'index.dat', action: 'trimmed', records: +m[1], height: +m[2] }),
  },
  {
    name: 'bootHeadersAhead',
    re: /\[boot\]\s*headers\.dat runs (\d+) linked record\(s\) ahead of the archive tip \(headers-first\): kept$/,
    apply: (m) => ({ kind: 'boot_repair', file: 'headers.dat', action: 'kept', records: +m[1], height: null }),
  },
  {
    name: 'bootHeadersTrimmed',
    re: /\[boot\]\s*headers\.dat ran (\d+) record\(s\) past the archive tip -- trimmed to (\d+)$/,
    apply: (m) => ({ kind: 'boot_repair', file: 'headers.dat', action: 'trimmed', records: +m[1], height: +m[2] }),
  },
  {
    name: 'bootHeadersDiverged',
    re: /\[boot\]\s*headers\.dat diverged from the archive at position (\d+) -- trimmed/,
    apply: (m) => ({ kind: 'boot_repair', file: 'headers.dat', action: 'diverged, trimmed', records: null, height: +m[1], severity: 'warn' }),
  },
  // [boot] boot catch-up runs BEFORE the UTXO engine starts: ... (bmc.bootcatchup=0 leaves the download to the worker, ...)
  // The newer spelling of the setting `bootCatchupSetting` reads; the setting is the figure.
  {
    name: 'bootCatchupOrder',
    re: /\[boot\]\s*boot catch-up runs BEFORE the UTXO engine starts:.*\(bmc\.bootcatchup=(\d+)\b/,
    apply: (m) => ({ kind: 'boot_catchup_setting', bootCatchup: m[1] === '1', note: 'boot catch-up runs before the UTXO engine starts' }),
  },
  // [boot] FATAL: cannot obtain a lock on data directory /…/main. bmcbitcoind is probably already running.
  // A start that did not happen. News, and a warning: the monitor would otherwise see only
  // an RPC that answers from the OTHER process, or none.
  {
    name: 'bootFatalLock',
    re: /\[boot\]\s*FATAL: cannot obtain a lock on data directory (\S+?)\.? (\S+) is probably already running\./,
    apply: (m) => ({ kind: 'node_fatal', subsystem: 'boot', reason: 'data directory locked by another process', process: m[2], severity: 'warn' }),
  },
  // [boot] lsock failed: Address already in use  (builds before 2026-09-12)
  {
    name: 'bootListenFailed',
    re: /\[boot\]\s*lsock failed: (.+)$/,
    apply: (m) => ({ kind: 'node_fatal', subsystem: 'boot', reason: `listen socket failed: ${m[1].trim()}`, severity: 'warn' }),
  },
  // [boot] shutdown requested during the catch-up -- exiting before the worker starts
  {
    name: 'bootShutdownCatchup',
    re: /\[boot\]\s*shutdown requested during the catch-up -- exiting before the worker starts$/,
    apply: () => ({ kind: 'boot_aborted', reason: 'shutdown requested during the boot catch-up' }),
  },

  // ======================================== EVERYTHING ELSE BMC WRITES (2026-09-19)
  // The operator, 2026-09-19: "Why don't we read 100% of BMC logs?" Before this section,
  // run 27 parsed at 99.11%, run 26 at 94.88% and the production log at ~93-94%, which
  // left 4,643 lines in 186 distinct shapes unread across the four current logs. Every one
  // of those shapes has a rule below, and each rule is one shape, never a whole tag: a line
  // the node adds tomorrow must still arrive as `raw`, because that is how the monitor's
  // census names it.
  //
  // What a claimed line becomes is one of two things, and the monitor's absorb switch says
  // which. READ: an event with its figures, which is state by default and reaches the feed
  // only for news (a failure, a stall, a peer banned, a phase finishing). SET ASIDE: kind
  // `noted`, used by exactly three rules (six line shapes), each with its reason beside it --
  // lines whose whole content is a continuation or a separator, so there is nothing to read.
  //
  // Once-per-boot facts (the RPC endpoint, the wallet's lock state, where zmq publishes) are
  // `node_fact`: one subsystem, a few named facts, merged into `logState.nodeFacts`. They
  // are the node describing itself, so they are state, and a later start overwrites them.

  // ---------------------------------------------------------------- [block]
  // (`blockStored` above reads the newer `(pushed compact block … from A)` spelling too.)

  // ---------------------------------------------------------------- [mux:N], [dl:N]
  // [mux:3] stored tip height=967440 from 86.127.254.44:8333 (announced on connect)
  // The block a new leg's peer announced as its tip, stored as it connected. 165 lines in
  // the four current logs; per peer, never feed.
  {
    name: 'legTipOnConnect',
    re: /\[mux:(\d+)\]\s*stored tip height=(\d+) from (\S+) \(announced on connect\)/,
    apply(m) { const a = addrParts(m[3]); return { kind: 'tip_on_connect', leg: +m[1], height: +m[2], addr: a.addr, host: a.host }; },
  },
  // [mux:7] no dial helper free for 65.181.13.28:58333 -- the leg stays down until the next retry
  // The per-leg form of `dlTopUpBlocked`: the node wanted this peer and had no helper to
  // dial it with. Counted, because the count is why a leg sits empty.
  {
    name: 'legNoDialHelper',
    re: /\[mux:(\d+)\]\s*no dial helper free for (\S+) -- the leg stays down until the next retry/,
    apply(m) { const a = addrParts(m[2]); return { kind: 'leg_no_helper', leg: +m[1], addr: a.addr, host: a.host }; },
  },
  // [mux:3] 86.127.254.44:8333     sync ok=1 new=56 tip=967440 (45.64s)
  // One leg's sync pass: whether it succeeded, how many blocks it brought, and how long.
  {
    name: 'legSync',
    re: /\[mux:(\d+)\]\s*(\S+)\s+sync ok=(\d+) new=(\d+) tip=(\d+) \((\d+(?:\.\d+)?)s\)/,
    apply(m) { const a = addrParts(m[2]); return { kind: 'leg_sync', leg: +m[1], addr: a.addr, host: a.host, ok: m[3] === '1', added: +m[4], tip: +m[5], secs: +m[6] }; },
  },
  // [mux:7] broadcast tip height=965724 to 91.206.17.195:8333  (builds before 2026-09-10)
  {
    name: 'legBroadcastTip',
    re: /\[mux:(\d+)\]\s*broadcast tip height=(\d+) to (\S+)$/,
    apply(m) { const a = addrParts(m[3]); return { kind: 'tip_broadcast', leg: +m[1], height: +m[2], addr: a.addr, host: a.host }; },
  },
  // [dl:2] 3.146.133.93:8333 connection closed theirs (revents 0x2019) after 90s; unread: (nothing)
  // [dl:7] 82.116.38.140:8333 connection closed theirs (EOF on the first read) after 0s; unread: (nothing)
  // [dl:0] 142.126.143.14:8333 connection closed ours/shutdown after 254s -- the worker is stopping
  // [dl:1] 192.80.135.43:8333 connection closed ours/ping-timeout after 1258s -- no pong in 20 min
  // [dl:0] 216.138.33.235:8333 connection closed ours/sync-failed-3x after 86s -- 3 failing sync passes, last where=3 in 24.1s
  // [dl:2] 104.238.220.72:8333 connection closed ours/sync-budget after 62s -- the pass exceeded 60s (where=7)
  // WHO CLOSED A LEG, WHY, AND AFTER HOW LONG: 562 lines in the current logs, in one
  // grammar -- side, then the side's reason, then the age, then either what was left
  // unread or an explanation. One rule, because it is one sentence with slots; the reason
  // is kept verbatim so a new one is visible rather than folded into an old one. A peer
  // event (the list, not the feed): 100+ a day of peers hanging up is not news.
  {
    name: 'legClosed',
    re: /\[dl:(\d+)\]\s*(\S+) connection closed (theirs|ours)(?:\/([\w-]+))?(?: \(([^)]*)\))? after (\d+)s(?:; unread: (.*)| -- (.*))?$/,
    apply(m) {
      const a = addrParts(m[2]);
      const unread = m[7] == null ? null : m[7].trim() === '(nothing)' ? [] : m[7].trim().split(/\s+/);
      const revents = /^revents (\S+)$/.exec(m[5] ?? '')?.[1] ?? null;
      return {
        kind: 'leg_closed', leg: +m[1], addr: a.addr, host: a.host, by: m[3],
        reason: m[4] ?? m[5] ?? null, revents, ageSec: +m[6], unread, note: m[8]?.trim() ?? null,
        // Routine however it is worded: `sync-failed-3x` would otherwise read as a warning.
        severity: 'info',
      };
    },
  },
  // [dl:1] 82.168.170.188:8333 exceeded 60s budget; re-dialing   (builds before 2026-09-12;
  // `?` in place of an address is the node's own spelling for a leg with no peer yet)
  {
    name: 'legBudgetExceeded',
    re: /\[dl:(\d+)\]\s*(\S+) exceeded (\d+)s budget; re-dialing$/,
    apply(m) { const a = m[2] === '?' ? null : addrParts(m[2]); return { kind: 'leg_budget', leg: +m[1], addr: a?.addr ?? null, host: a?.host ?? null, budgetSec: +m[3] }; },
  },
  // [txrelay:3] 79.112.132.88:8333: +14 tx accepted (mempool 4992)  (builds before 2026-09-08)
  // The per-leg form the `last 60s … via legs [...]` summary replaced: 4,057 lines in the
  // archives, one per leg per batch, so it is its own kind and state, never a feed row.
  {
    name: 'txRelayLeg',
    re: /\[txrelay:(\d+)\]\s*(\S+): \+(\d+) tx accepted \(mempool (\d+)\)$/,
    apply(m) { const a = addrParts(m[2]); return { kind: 'tx_relay_leg', leg: +m[1], addr: a.addr, host: a.host, accepted: +m[3], mempool: +m[4] }; },
  },

  // ---------------------------------------------------------------- [dlc]
  // [dlc] the pool announces height 967591 (85 of 117 peers claimed one; the median claim counts)
  // The height the downloader believes is the tip, and how many peers said so.
  {
    name: 'dlcPoolClaim',
    re: /\[dlc\]\s*the pool announces height (\d+) \((\d+) of (\d+) peers claimed one; the median claim counts\)/,
    apply: (m) => ({ kind: 'pool_tip_claim', height: +m[1], claimed: +m[2], of: +m[3] }),
  },
  // [dlc] headers: already current per 216.230.225.42:8333 (total 967328)
  {
    name: 'dlcHeadersCurrent',
    re: /\[dlc\]\s*headers: already current per (\S+) \(total (\d+)\)/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'headers_current', addr: a.addr, host: a.host, total: +m[2] }; },
  },
  // [dlc] archive already complete through 967462
  {
    name: 'dlcArchiveComplete',
    re: /\[dlc\]\s*archive already complete through (\d+)$/,
    apply: (m) => ({ kind: 'archive_complete', height: +m[1] }),
  },
  // [dlc] w6 172.220.244.249:8333 is stalling the window: chunk [188041,188080] is the oldest missing and
  //       the window (4096 above 188041) is full -- dropped after 2 s (next timeout 4 s; peer BANNED for the run)
  // A PEER BANNED, and why: it held the oldest chunk while the window was full. The ban is
  // news (a warning in the feed); `peer already banned` is the same stall by a peer the
  // node had already given up on, and is state.
  {
    name: 'dlcWindowStall',
    re: /\[dlc\]\s*w(\d+) (\S+) is stalling the window: chunk \[(\d+),(\d+)\] is the oldest missing and the window \((\d+) above (\d+)\) is full -- dropped after (\d+) s \(next timeout (\d+) s; peer (BANNED for the run|already banned)\)/,
    apply(m) {
      const a = addrParts(m[2]);
      const newly = m[9] === 'BANNED for the run';
      return {
        kind: 'window_stall', worker: +m[1], addr: a.addr, host: a.host, chunkFrom: +m[3], chunkTo: +m[4],
        window: +m[5], windowBase: +m[6], droppedAfterSec: +m[7], nextTimeoutSec: +m[8], newlyBanned: newly,
        severity: newly ? 'warn' : 'info',
      };
    },
  },
  // [dlc w6] 172.220.244.249:8333 stalling the window (held its oldest missing chunk while it was full) (last measured 113.5KB/s, completed 0 chunk(s)/0 block(s) on this peer); dropping for a fresh peer
  // [dlc w2] 13.53.202.93:8333 dead weight (last measured 495.2B/s, completed 0 chunk(s)/0 block(s) on this peer); dropping for a fresh peer
  // Why a download worker let a peer go, with the peer's last measured rate and what it had
  // delivered: per-peer state, the rate being the one figure nothing else gives.
  {
    name: 'dlcWorkerDrop',
    re: /\[dlc w(\d+)\]\s*(\S+) (stalling the window|dead weight)(?: \([^)]*\))? \(last measured ([^,]+), completed (\d+) chunk\(s\)\/(\d+) block\(s\) on this peer\)(?:; (.+))?$/,
    apply(m) {
      const a = addrParts(m[2]);
      return { kind: 'worker_drop', worker: +m[1], addr: a.addr, host: a.host, reason: m[3], rate: parseRate(m[4].trim()), chunks: +m[5], blocks: +m[6], action: m[7]?.trim() ?? null };
    },
  },
  // [dlc w7] 20.14.178.84:8333: chunk [195281,195320] attempt 3 failed after 794 ms: socket read failed or closed (code -4)
  // [dlc w5] 188.134.8.36:8333: chunk [236081,236120] attempt 3 failed after 3928 ms: a block failed cons_verify (code -5)
  // A lost socket is routine; a block that FAILED CONSENSUS VERIFICATION is not, and goes to
  // the feed as a warning. Both are read the same way; the reason decides.
  {
    name: 'dlcChunkFailed',
    re: /\[dlc w(\d+)\]\s*(\S+): chunk \[(\d+),(\d+)\] attempt (\d+) failed after (\d+) ms: (.+?) \(code (-?\d+)\)$/,
    apply(m) {
      const a = addrParts(m[2]);
      const verify = /cons_verify|invalid/i.test(m[7]);
      return { kind: 'chunk_failed', worker: +m[1], addr: a.addr, host: a.host, from: +m[3], to: +m[4], attempt: +m[5], ms: +m[6], reason: m[7], code: +m[8], verifyFailed: verify, severity: verify ? 'warn' : 'info' };
    },
  },
  // [dlc w4] no reachable peer -- amnesty, un-banned 38 peer(s)
  // Every peer banned or unreachable, so the bans were lifted wholesale: news.
  {
    name: 'dlcAmnesty',
    re: /\[dlc w(\d+)\]\s*no reachable peer -- amnesty, un-banned (\d+) peer\(s\)/,
    apply: (m) => ({ kind: 'ban_amnesty', worker: +m[1], unbanned: +m[2], severity: 'warn' }),
  },
  // [dlc w3] done: blocks=23120
  {
    name: 'dlcWorkerDone',
    re: /\[dlc w(\d+)\]\s*done: blocks=(\d+)$/,
    apply: (m) => ({ kind: 'worker_done', worker: +m[1], blocks: +m[2] }),
  },
  // [dlc w2] reconnect budget [965951,965990]  ·  [dlc w2] chunk [965951,965990] ABANDONED  (builds before 2026-09-10)
  {
    name: 'dlcReconnectBudget',
    re: /\[dlc w(\d+)\]\s*reconnect budget \[(\d+),(\d+)\]$/,
    apply: (m) => ({ kind: 'chunk_retry', worker: +m[1], from: +m[2], to: +m[3], abandoned: false }),
  },
  {
    name: 'dlcChunkAbandoned',
    re: /\[dlc w(\d+)\]\s*chunk \[(\d+),(\d+)\] ABANDONED$/,
    apply: (m) => ({ kind: 'chunk_retry', worker: +m[1], from: +m[2], to: +m[3], abandoned: true, severity: 'warn' }),
  },
  // [dlc] headers from 216.230.225.43:8333 are below -minimumchainwork so far -- holding 2000, storing none until the chain proves its work
  // [dlc] headers from 216.230.225.43:8333: still below -minimumchainwork after 50 held page(s) (100000 headers, 7.7 MB) in 4s -- 1.8MB/s
  // [dlc] chain from 216.230.225.43:8333 crossed -minimumchainwork -- storing 469 held page(s)
  // The anti-DoS header sync of a fresh node: held in memory until the chain proves its
  // work. Crossing is the milestone and reaches the feed; the rest is progress.
  {
    name: 'dlcHeadersHolding',
    re: /\[dlc\]\s*headers from (\S+) are below -minimumchainwork so far -- holding (\d+), storing none/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'headers_minwork', state: 'holding', addr: a.addr, host: a.host, held: +m[2] }; },
  },
  {
    name: 'dlcHeadersStillBelow',
    re: /\[dlc\]\s*headers from (\S+): still below -minimumchainwork after (\d+) held page\(s\) \((\d+) headers, (\d+(?:\.\d+)? ?[KMG]?B)\) in (\d+)s -- (\S+)$/,
    apply(m) {
      const a = addrParts(m[1]);
      return { kind: 'headers_minwork', state: 'below', addr: a.addr, host: a.host, pages: +m[2], headers: +m[3], bytes: parseSize(m[4]), secs: +m[5], rate: parseRate(m[6]) };
    },
  },
  {
    name: 'dlcHeadersCrossed',
    re: /\[dlc\]\s*chain from (\S+) crossed -minimumchainwork -- storing (\d+) held page\(s\)/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'headers_minwork', state: 'crossed', addr: a.addr, host: a.host, pages: +m[2] }; },
  },
  // [dlc] headers from 98.116.106.214:8333 attach at height 959297 and end at 961296, below the 967496 we hold -- the peer is behind us; trying another
  {
    name: 'dlcHeadersBehind',
    re: /\[dlc\]\s*headers from (\S+) attach at height (\d+) and end at (\d+), below the (\d+) we hold/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'headers_behind', addr: a.addr, host: a.host, from: +m[2], to: +m[3], ours: +m[4] }; },
  },
  // [dlc] headers from 23.16.135.74:8333 fork from our chain at height 961632 -- discarding  (builds before 2026-09-10)
  // [dlc] headers from 79.116.38.44:8333 do not connect to our tip -- discarding 3 header(s)
  {
    name: 'dlcHeadersFork',
    re: /\[dlc\]\s*headers from (\S+) fork from our chain at height (\d+) -- discarding$/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'headers_rejected', addr: a.addr, host: a.host, why: 'fork', height: +m[2], headers: null, severity: 'warn' }; },
  },
  {
    name: 'dlcHeadersNoConnect',
    re: /\[dlc\]\s*headers from (\S+) do not connect to our tip -- discarding (\d+) header\(s\)$/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'headers_rejected', addr: a.addr, host: a.host, why: 'do not connect', height: null, headers: +m[2] }; },
  },
  // [dlc] span [1,967592] (967592 heights)
  // [dlc] Core's shape: 8 of 117 live peer(s) download at once (cap 8, span 967592), window 4096 blocks above the connected tip, stall timeout 2 s
  // The download's plan, once per run: what it will fetch and how wide.
  {
    name: 'dlcSpan',
    re: /\[dlc\]\s*span \[(\d+),(\d+)\] \((\d+) heights\)/,
    apply: (m) => ({ kind: 'dl_plan', from: +m[1], to: +m[2], heights: +m[3] }),
  },
  {
    name: 'dlcCoreShape',
    re: /\[dlc\]\s*Core's shape: (\d+) of (\d+) live peer\(s\) download at once \(cap (\d+)(?:, span (\d+))?\), window (\d+) blocks above the connected tip, stall timeout (\d+) s/,
    // Severity stated: the words `stall timeout` would make every plan a warning.
    apply: (m) => ({ kind: 'dl_plan', parallel: +m[1], live: +m[2], cap: +m[3], span: m[4] == null ? null : +m[4], window: +m[5], stallTimeoutSec: +m[6], severity: 'info' }),
  },
  // [dlc] connected 321801 block(s) during the download; connected tip 321800 (the rotation drains the rest)
  // [dlc] catch-up done: 322400 new blocks written
  // The download finishing. `catch-up done` is the milestone; the connected count is state.
  {
    name: 'dlcConnectedDuring',
    re: /\[dlc\]\s*connected (\d+) block\(s\) during the download; connected tip (\d+)/,
    apply: (m) => ({ kind: 'dl_connected_during', blocks: +m[1], tip: +m[2] }),
  },
  {
    name: 'dlcCatchupDone',
    re: /\[dlc\]\s*catch-up done: (\d+) new blocks written$/,
    apply: (m) => ({ kind: 'dl_catchup_done', blocks: +m[1] }),
  },
  // [dlc] shutdown requested -- stopping 8 worker(s)
  {
    name: 'dlcStopping',
    re: /\[dlc\]\s*shutdown requested -- stopping (\d+) worker\(s\)$/,
    apply: (m) => ({ kind: 'dl_stopping', workers: +m[1] }),
  },
  // [dlc] stage: discarded 18 file(s) an earlier run left; their chunks are fetched again
  {
    name: 'dlcStageDiscarded',
    re: /\[dlc\]\s*stage: discarded (\d+) file\(s\) an earlier run left/,
    apply: (m) => ({ kind: 'dl_stage_discarded', files: +m[1] }),
  },
  // [dlc] committer: 5311 chunk(s) appended in height order; committed tip 967384
  // [dlc] committer exited unexpectedly (status 0) -- restarting it
  {
    name: 'dlcCommitter',
    re: /\[dlc\]\s*committer: (\d+) chunk\(s\) appended in height order; committed tip (\d+)$/,
    apply: (m) => ({ kind: 'dl_committer', chunks: +m[1], tip: +m[2] }),
  },
  {
    name: 'dlcCommitterRestart',
    re: /\[dlc\]\s*committer exited unexpectedly \(status (-?\d+)\) -- restarting it$/,
    apply: (m) => ({ kind: 'dl_committer_restart', status: +m[1], severity: 'warn' }),
  },
  // [dlc] recorded 1 known-good peer(s) for next boot  (builds before 2026-09-10)
  {
    name: 'dlcKnownGood',
    re: /\[dlc\]\s*recorded (\d+) known-good peer\(s\) for next boot$/,
    apply: (m) => ({ kind: 'dl_known_good', peers: +m[1] }),
  },

  // ---------------------------------------------------------------- [dl]
  // [dl] waited for 1 pass helper(s) before the parallel download; 0 still running
  {
    name: 'dlPassHelpers',
    re: /\[dl\]\s*waited for (\d+) pass helper\(s\) before the parallel download; (\d+) still running/,
    apply: (m) => ({ kind: 'pass_helpers', waited: +m[1], running: +m[2] }),
  },
  // [dl] worker: reloading chain archive...  ·  [dl] worker: loading live UTXO state...
  // [dl] worker: chain archive reloaded: tip=967700 (0.00s)  ·  live UTXO state loaded (0.44s)
  // [dl] worker: chainwork in step with the archive (1 record(s) backfilled, 0.00s)
  // The download worker's own start, after the boot phase: the same step-and-time record
  // as [boot], kept apart from it because it is a second process.
  {
    name: 'dlWorkerStepBegin',
    re: /\[dl\]\s*worker: (reloading chain archive|loading live UTXO state)\.\.\.$/,
    apply: (m) => ({ kind: 'worker_step_begin', step: m[1] }),
  },
  {
    name: 'dlWorkerArchive',
    re: /\[dl\]\s*worker: chain archive reloaded: tip=(-?\d+) \((\d+(?:\.\d+)?)s\)$/,
    apply: (m) => ({ kind: 'worker_step', step: 'chain archive reloaded', tip: +m[1], records: null, sec: +m[2] }),
  },
  {
    name: 'dlWorkerUtxo',
    re: /\[dl\]\s*worker: live UTXO state loaded \((\d+(?:\.\d+)?)s\)$/,
    apply: (m) => ({ kind: 'worker_step', step: 'live UTXO state loaded', tip: null, records: null, sec: +m[1] }),
  },
  {
    name: 'dlWorkerChainwork',
    re: /\[dl\]\s*worker: chainwork in step with the archive \((\d+) record\(s\) backfilled, (\d+(?:\.\d+)?)s\)$/,
    apply: (m) => ({ kind: 'worker_step', step: 'chainwork in step with the archive', tip: null, records: +m[1], sec: +m[2] }),
  },
  // [dl] dial: 8 of 64 candidate(s) answered within the budget
  {
    name: 'dlDialProbe',
    re: /\[dl\]\s*dial: (\d+) of (\d+) candidate\(s\) answered within the budget/,
    apply: (m) => ({ kind: 'dial_probe', answered: +m[1], candidates: +m[2] }),
  },
  // [dl] shutting down (signal 15): tip=967325 peers=5 txouts=13485256 uptime=00:00:37:42
  // The download worker's half of a shutdown. The serve process writes its own line
  // (`serveShutdown`), which is the one that reaches the feed; this one carries the
  // worker's figures -- peers, UTXO count, uptime -- and is state.
  {
    name: 'dlShutdown',
    re: /\[dl\]\s*shutting down \(signal (\d+)\): tip=(\d+) peers=(\d+) txouts=(\d+)(?: uptime=(\S+))?/,
    apply: (m) => ({ kind: 'worker_shutdown', signal: +m[1], tip: +m[2], peers: +m[3], txouts: +m[4], uptime: parseUptime(m[5]) }),
  },
  // [dl] sendrawtransaction accepted, queued for announcement to 3/3 legs
  // [dl] sendrawtransaction accepted, relayed to 6/8 legs (repeats muted; +N shows in the tx_accept summary)
  // A transaction submitted to this node over RPC, and how many legs it went to. The feed:
  // it is somebody's payment leaving. The node mutes repeats itself, so this cannot flood.
  {
    name: 'dlSendRaw',
    re: /\[dl\]\s*sendrawtransaction accepted, (queued for announcement|relayed) to (\d+)\/(\d+) legs( \(repeats muted)?/,
    apply: (m) => ({ kind: 'tx_broadcast', how: m[1] === 'relayed' ? 'relayed' : 'queued', legs: +m[2], of: +m[3], repeatsMuted: m[4] != null }),
  },
  // [dl] 673 blocks on disk ahead of the UTXO set -- applying before syncing legs
  // [dl] UTXO backlog 0 -- resuming normal leg rotation
  {
    name: 'dlUtxoBacklog',
    re: /\[dl\]\s*(\d+) blocks on disk ahead of the UTXO set -- applying before syncing legs/,
    apply: (m) => ({ kind: 'utxo_backlog', behind: +m[1], state: 'applying' }),
  },
  {
    name: 'dlUtxoBacklogDone',
    re: /\[dl\]\s*UTXO backlog (\d+) -- resuming normal leg rotation/,
    apply: (m) => ({ kind: 'utxo_backlog', behind: +m[1], state: 'resumed' }),
  },
  // [dl] utxo_live_catchup FAILED at height 428470 -- attempting in-place recovery
  // [dl] utxo STILL failing after recovery (streak=1) -- DEGRADED (no UTXO tracking), retrying in 60s
  // [dl] utxo recovery SUCCEEDED (1 compaction round(s)) -- tracking continues at height 428471
  // Builds before 2026-09-10 only, and read anyway: a node that stopped tracking its UTXO
  // set is the most important thing its log ever said.
  {
    name: 'dlUtxoFailed',
    re: /\[dl\]\s*utxo_live_catchup FAILED at height (\d+) -- attempting in-place recovery/,
    apply: (m) => ({ kind: 'utxo_failure', state: 'failed', height: +m[1], severity: 'warn' }),
  },
  {
    name: 'dlUtxoDegraded',
    re: /\[dl\]\s*utxo STILL failing after recovery \(streak=(\d+)\) -- DEGRADED \(no UTXO tracking\), retrying in (\d+)s/,
    apply: (m) => ({ kind: 'utxo_failure', state: 'degraded', streak: +m[1], retrySec: +m[2], severity: 'warn' }),
  },
  {
    name: 'dlUtxoRecovered',
    re: /\[dl\]\s*utxo recovery SUCCEEDED \((\d+) compaction round\(s\)\) -- tracking continues at height (\d+)/,
    apply: (m) => ({ kind: 'utxo_failure', state: 'recovered', rounds: +m[1], height: +m[2] }),
  },
  // [dl] coinstatsindex=0 -- not maintaining the coin statistics index   (builds before 2026-09-12)
  {
    name: 'dlCoinstatsOff',
    re: /\[dl\]\s*coinstatsindex=0 -- not maintaining the coin statistics index$/,
    apply: () => ({ kind: 'node_fact', subsystem: 'coinstats', facts: { maintained: false } }),
  },

  // ---------------------------------------------------------------- [addrself], [txrelay]
  // [addrself] external address confirmed by 2 peers: 203.0.113.7:8462
  // [addrself] advertised 203.0.113.7:8464 to 6 clearnet peer(s)
  // The address the network sees this node at, which is what inbound peers dial.
  {
    name: 'addrSelfConfirmed',
    re: /\[addrself\]\s*external address confirmed by (\d+) peers: (\S+)$/,
    apply: (m) => ({ kind: 'self_address', addr: m[2], confirmedBy: +m[1], advertisedTo: null }),
  },
  {
    name: 'addrSelfAdvertised',
    re: /\[addrself\]\s*advertised (\S+) to (\d+) clearnet peer\(s\)$/,
    apply: (m) => ({ kind: 'self_address', addr: m[1], confirmedBy: null, advertisedTo: +m[2] }),
  },
  // [txrelay] 1p1c accepted: parent 9eb944e6aab6d5cf.. + child e532129369baf941.. (package 350 sat / 318 vB)
  // One-parent-one-child package relay: the pair, and the package's fee and size, from which
  // the rate the child paid to carry its parent.
  {
    name: 'txPackage',
    re: /\[txrelay\]\s*1p1c accepted: parent ([0-9a-f]+)\.* \+ child ([0-9a-f]+)\.* \(package (\d+) sat \/ (\d+) vB\)/,
    apply: (m) => ({ kind: 'package_accepted', parent: m[1], child: m[2], feeSat: +m[3], vsize: +m[4], satPerVb: +(+m[3] / Math.max(1, +m[4])).toFixed(2) }),
  },

  // ---------------------------------------------------------------- [zmq]
  // [zmq] notification ring overrun: 24 transaction(s) not published (total 70892) (repeats muted; the total is cumulative)
  // A SUBSCRIBER MISSING NOTIFICATIONS: whatever reads this node's zmq (an indexer, a
  // wallet) did not see these transactions. A warning, kept as a running total and a flag
  // rather than 147 feed rows.
  {
    name: 'zmqOverrun',
    re: /\[zmq\]\s*notification ring overrun: (\d+) transaction\(s\) not published \(total (\d+)\)/,
    apply: (m) => ({ kind: 'zmq_overrun', dropped: +m[1], total: +m[2], severity: 'warn' }),
  },
  // [zmq] publishing hashblock on tcp://127.0.0.1:28332
  {
    name: 'zmqPublishing',
    re: /\[zmq\]\s*publishing (\w+) on (\S+)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'zmq', facts: { [m[1]]: m[2] } }),
  },
  // [zmq] subscriber connected on tcp://127.0.0.1:28332 (1 total)
  {
    name: 'zmqSubscriber',
    re: /\[zmq\]\s*subscriber connected on (\S+) \((\d+) total\)/,
    apply: (m) => ({ kind: 'zmq_subscriber', endpoint: m[1], total: +m[2] }),
  },
  // [zmq] subscriber could not take a rawtx message; dropping it
  {
    name: 'zmqSubscriberDrop',
    re: /\[zmq\]\s*subscriber could not take a (\w+) message; dropping it$/,
    apply: (m) => ({ kind: 'zmq_overrun', dropped: 1, total: null, topic: m[1], severity: 'warn' }),
  },

  // ---------------------------------------------------------------- [tx_accept]
  // [tx_accept] reject (policy): txn-already-in-mempool (repeats muted; the 30s summary counts them)
  // One rejection with its reason, the first of each kind (the node mutes the rest into the
  // 30 s summary, which `txAccept` reads). Counted per reason.
  {
    name: 'txReject',
    re: /\[tx_accept\]\s*reject \((\w+)\): (.+?)( \(repeats muted; the \d+s summary counts them\))?$/,
    apply: (m) => ({ kind: 'tx_reject', class: m[1], reason: m[2], repeatsMuted: m[3] != null }),
  },
  // [tx_accept] WAL is 2531390197 bytes -- sizing the validation snapshot at 2^24 slots, 2430 MB blob (the writer was bulk-sized when it last wrote)
  {
    name: 'txvalSizing',
    re: /\[tx_accept\]\s*WAL is (\d+) bytes -- sizing the validation snapshot at 2\^(\d+) slots, (\d+) MB blob/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'txval', facts: { walBytes: +m[1], slots: 2 ** +m[2], blobMB: +m[3] } }),
  },

  // ---------------------------------------------------------------- [addrindex]
  // [addrindex] journal rotated: 97 records folded into history runs (to 19999), 3 kept
  // [addrindex] LIVE: covered=431427 (backfilled 0; the archive is ahead, the rest lands as the engine applies it) -- extension index, not a Core feature
  // The address index is the fourth of the node's auxiliary indexes, and it reports in the
  // same terms as the other three, so it is read into the same kinds and the same record.
  {
    name: 'addrindexRotated',
    re: /\[addrindex\]\s*journal rotated: (\d+) ([a-z]+) folded into history runs \(to (\d+)\), (\d+) kept/,
    apply: (m) => ({ kind: 'index_tail_rotated', index: 'addrindex', folded: +m[1], noun: m[2], to: +m[3], kept: +m[4] }),
  },
  {
    name: 'addrindexLive',
    re: /\[addrindex\]\s*LIVE: covered=(-?\d+) \(backfilled (\d+)(; the archive is ahead[^)]*)?\)/,
    apply: (m) => ({ kind: 'index_tail_active', index: 'addrindex', baseTo: null, covered: +m[1], backfilled: +m[2], archiveAhead: m[3] != null }),
  },
  // [addrindex] rolled back 966500 -> 966499 (store truncated)   (a reorg, builds before 2026-09-12)
  // [txindex] tail watermark rolled back 966500 -> 966499 (store truncated)
  {
    name: 'indexRolledBack',
    re: /\[(addrindex|txindex|txospender|addr_hist)\]\s*(?:tail watermark )?rolled back (\d+) -> (\d+) \(store truncated\)/,
    apply: (m) => ({ kind: 'index_rolled_back', index: INDEX_NAMES[m[1]] ?? m[1], from: +m[2], to: +m[3] }),
  },
  // [addrindex] boot backfill failed -- disabled  ·  [addrindex] backfill stopped at height 966097 (undo pruned?)
  {
    name: 'addrindexBackfillFailed',
    re: /\[addrindex\]\s*(?:boot backfill failed -- disabled|backfill stopped at height (\d+) \(([^)]*)\))$/,
    apply: (m) => ({ kind: 'index_disabled', index: 'addrindex', height: m[1] == null ? null : +m[1], why: m[2] ?? 'boot backfill failed', severity: 'warn' }),
  },
  // [txindex] trail: builder /…/bmc_build_tx_index not executable -- the index cannot be built
  // [txospender] no base txospender.dat -- index disabled (build one with daemon/bmc_build_txospender_index)
  // An index that will not be built, and why: news, once.
  {
    name: 'indexBuilderMissing',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*trail: builder (\S+) not executable -- the index cannot be built/,
    apply: (m) => ({ kind: 'index_disabled', index: INDEX_NAMES[m[1]], why: `builder ${m[2].split('/').pop()} not executable`, height: null, severity: 'warn' }),
  },
  {
    name: 'indexNoBase',
    re: /\[(txindex|txospender|addr_hist|addrhist)\]\s*no base (\S+) -- index disabled/,
    apply: (m) => ({ kind: 'index_disabled', index: INDEX_NAMES[m[1]], why: `no base ${m[2]}`, height: null, severity: 'warn' }),
  },

  // ---------------------------------------------------------------- [mempool]
  // [mempool] maxmempool=300MB -> 1048576 slots, 286MB tx storage (shared, locked)
  {
    name: 'mempoolSizing',
    re: /\[mempool\]\s*maxmempool=(\d+)MB -> (\d+) slots, (\d+)MB tx storage/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'mempool', facts: { maxmempoolMB: +m[1], slots: +m[2], txStorageMB: +m[3] } }),
  },
  // [mempool] departure journal: 2000000 records (289 MB) in mempool_journal.dat
  {
    name: 'mempoolJournal',
    re: /\[mempool\]\s*departure journal: (\d+) records \((\d+) MB\) in (\S+)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'mempool', facts: { journalRecords: +m[1], journalMB: +m[2] } }),
  },
  // [mempool] saved 1 transaction(s) to mempool.dat  ·  [mempool] no mempool.dat to reload (persistmempool=1)
  // [mempool] loaded mempool.dat: 1 of 1 in the pool (1 admitted, 0 already there); 0 refused: 0 missing-inputs,
  //           0 conflicting, 0 policy, 0 no-ack, 0 other (0 re-offered, 0 then accepted); 1 arrival time(s) restored
  // What the mempool carried across a restart: saved at shutdown, loaded at start, and what
  // was refused on the way back in, by reason.
  {
    name: 'mempoolSaved',
    re: /\[mempool\]\s*saved (\d+) transaction\(s\) to mempool\.dat$/,
    apply: (m) => ({ kind: 'mempool_persist', state: 'saved', txs: +m[1] }),
  },
  {
    name: 'mempoolNoFile',
    re: /\[mempool\]\s*no mempool\.dat to reload \(persistmempool=(\d)\)$/,
    apply: (m) => ({ kind: 'mempool_persist', state: 'none', txs: 0, persist: m[1] === '1' }),
  },
  {
    name: 'mempoolLoaded',
    re: /\[mempool\]\s*loaded mempool\.dat: (\d+) of (\d+) in the pool \((\d+) admitted, (\d+) already there\); (\d+) refused: ([^;]*)(?:; (\d+) arrival time\(s\) restored)?$/,
    apply(m) {
      const refusedBy = {};
      for (const [, n, what] of m[6].matchAll(/(\d+) ([a-z][a-z-]*(?: accepted)?)/g)) refusedBy[what.replace(/[- ]/g, '_')] = +n;
      return {
        kind: 'mempool_persist', state: 'loaded', txs: +m[1], offered: +m[2], admitted: +m[3], alreadyThere: +m[4],
        refused: +m[5], refusedBy, arrivalTimes: m[7] == null ? null : +m[7],
      };
    },
  },
  // [mempool] loaded mempool.dat: 19359 accepted, 125 rejected of 19484 (2 waited for a parent, 0 of them then accepted)  (builds before 2026-09-12)
  {
    name: 'mempoolLoadedOld',
    re: /\[mempool\]\s*loaded mempool\.dat: (\d+) accepted, (\d+) rejected of (\d+) \((\d+) waited for a parent, (\d+) of them then accepted\)/,
    apply: (m) => ({ kind: 'mempool_persist', state: 'loaded', txs: +m[1], offered: +m[3], admitted: +m[1], alreadyThere: null, refused: +m[2], refusedBy: null, arrivalTimes: null, waitedForParent: +m[4] }),
  },
  // [mempool] WARNING: a process died holding the mempool lock; the lock has
  // [mempool]          been recovered and the node keeps running, but the pool
  // [mempool]          may hold a partially-applied entry. It is rebuilt from
  // [mempool]          the chain on the next reorg reconcile; restart if you
  // [mempool]          want it rebuilt now.
  // One warning written as five lines. The first carries the event (a process died holding
  // the lock) and goes to the feed; the four after it are the rest of the same sentence.
  {
    name: 'mempoolLockRecovered',
    re: /\[mempool\]\s*WARNING: a process died holding the mempool lock; the lock has$/,
    apply: () => ({ kind: 'mempool_lock_recovered', severity: 'warn' }),
  },
  // SET ASIDE: the four continuation lines of that warning. Their words belong to the line
  // above, which is read; on their own they carry nothing. Each is named in full, so a
  // different indented [mempool] line is still reported as unread.
  {
    name: 'mempoolLockContinued',
    re: /\[mempool\] {2,}(?:been recovered and the node keeps running, but the pool|may hold a partially-applied entry\. It is rebuilt from|the chain on the next reorg reconcile; restart if you|want it rebuilt now\.)$/,
    apply: () => ({ kind: 'noted', why: 'continuation of the mempool-lock warning above' }),
  },

  // ---------------------------------------------------------------- [hashidx], [archive], [bfilter]
  // [hashidx] indexed 967701 stored heights  ·  [hashidx] +1 height(s) now servable (through 966975)
  {
    name: 'hashidxIndexed',
    re: /\[hashidx\]\s*indexed (\d+) stored heights$/,
    apply: (m) => ({ kind: 'hash_index', heights: +m[1], added: null, through: null }),
  },
  {
    name: 'hashidxServable',
    re: /\[hashidx\]\s*\+(\d+) height\(s\) now servable \(through (\d+)\)$/,
    apply: (m) => ({ kind: 'hash_index', heights: null, added: +m[1], through: +m[2] }),
  },
  // [archive] integrity OK: 967701 entries, 967701 unique, 0 duplicates
  {
    name: 'archiveIntegrity',
    re: /\[archive\]\s*integrity OK: (\d+) entries, (\d+) unique, (\d+) duplicates$/,
    apply: (m) => ({ kind: 'archive_integrity', entries: +m[1], unique: +m[2], duplicates: +m[3], severity: +m[3] > 0 ? 'warn' : 'info' }),
  },
  // [archive] *** CORRUPTION DETECTED ***
  // The head of a fifteen-line report (2026-09-0x, one occurrence). The head is read, as
  // the most serious thing this log has ever said; the report's lines after it are one-off
  // prose in a build no longer running and are left unread (MEASUREMENTS §42 lists them).
  {
    name: 'archiveCorruption',
    re: /\[archive\]\s*\*\*\* CORRUPTION DETECTED \*\*\*$/,
    apply: () => ({ kind: 'archive_integrity', entries: null, unique: null, duplicates: null, corrupt: true, severity: 'warn' }),
  },
  // [bfilter] index open at 967453 records (tip 967453)  ·  … -- closing the gap from the archive + undo, in slices
  // [bfilter] index at 964360, tip 965666 -- waiting for the backfill to close in  (builds before 2026-09-12)
  // [bfilter] ADOPTED at 967127 records (tip 967127) -- closing the gap from undo data   (the same)
  // The compact block filter index (BIP157), and how far behind the tip it is.
  {
    name: 'bfilterOpen',
    re: /\[bfilter\]\s*(?:index open|ADOPTED) at (\d+) records \(tip (\d+)\)( -- closing the gap[^)]*)?$/,
    apply: (m) => ({ kind: 'bfilter_state', records: +m[1], tip: +m[2], backfilling: m[3] != null }),
  },
  {
    name: 'bfilterWaiting',
    re: /\[bfilter\]\s*index at (\d+), tip (\d+) -- waiting for the backfill to close in$/,
    apply: (m) => ({ kind: 'bfilter_state', records: +m[1], tip: +m[2], backfilling: true }),
  },

  // ---------------------------------------------------------------- [serve], [rpc], [wallet], [tor], [net], [mux], [reorg]
  // Each of these is printed once per start and describes how the node came up. node_fact:
  // a few named facts per subsystem, state, overwritten by the next start.
  // [serve] download worker pid 1374477  ·  [serve] forwarded SIGTERM to download worker pid 1655716
  {
    name: 'serveWorkerPid',
    re: /\[serve\]\s*download worker pid (\d+)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'serve', facts: { workerPid: +m[1] } }),
  },
  {
    name: 'serveWorkerSignalled',
    re: /\[serve\]\s*forwarded (SIG\w+) to download worker pid (\d+)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'serve', facts: { workerSignalled: m[1], workerPid: +m[2] } }),
  },
  // [serve] inbound 192.0.2.76:59048 connected [v1] (pid 3406446) proto=70016 services=0x809 ua="/BitcoinMachineCode:0.0.1/" height=0
  // [serve] inbound 192.0.2.76:53607 handshake failed [v1] (pid 3815876)
  // Builds before 2026-09-12: 9,270 lines in the archives, none in a current log. The same
  // identity the outbound `peerIdentify` reads, for an inbound peer.
  {
    name: 'serveInboundIdentify',
    re: /\[serve\]\s*inbound (\S+) connected \[(v\d)\] \(pid (\d+)\) proto=(\d+) services=(\S+) ua="([^"]*)" height=(\d+)/,
    apply(m) {
      const a = addrParts(m[1]);
      return { kind: 'peer_identify', direction: 'inbound', index: null, addr: a.addr, host: a.host, fd: null, proto: +m[4], services: m[5], userAgent: m[6], peerHeight: +m[7], addrv2: null, transport: m[2], childPid: +m[3] };
    },
  },
  {
    name: 'serveInboundHandshakeFail',
    re: /\[serve\]\s*inbound (\S+) handshake failed \[(v\d)\] \(pid (\d+)\)/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'peer_reject', addr: a.addr, host: a.host, transport: m[2], reason: `${m[2]} handshake failed`, severity: 'warn' }; },
  },
  // THE SHUTDOWN HANDOVER (bmc, 2026-09-19, the build that fixed the NUL byte and the bind
  // misread): the server waits for the download worker to let go of the datadir lock before it
  // exits, and says so in three lines. A clean stop, so state rather than feed.
  // [serve] no process lists the datadir lock, but 1 still hold(s) it on the way out: 1374477 (download worker) -- waiting for the exit to complete (0.0s)
  // [serve] download worker pid 1374477 exited with status 0 (0.1s)
  // [serve] datadir lock held by no other process (waited 0.1s) -- exiting releases it
  {
    name: 'serveLockWaiting',
    re: /\[serve\]\s*no process lists the datadir lock, but (\d+) still hold\(s\) it on the way out: (.+?) -- waiting for the exit to complete \((\d+(?:\.\d+)?)s\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'serve', facts: { lockHoldersOnExit: +m[1], lockHolders: m[2], lockWaitSec: +m[3] } }),
  },
  {
    name: 'serveWorkerExited',
    re: /\[serve\]\s*download worker pid (\d+) exited with status (-?\d+) \((\d+(?:\.\d+)?)s\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'serve', facts: { workerPid: +m[1], workerExitStatus: +m[2], workerExitSec: +m[3] } }),
  },
  {
    name: 'serveLockReleased',
    re: /\[serve\]\s*datadir lock held by no other process \(waited (\d+(?:\.\d+)?)s\) -- exiting releases it$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'serve', facts: { lockReleasedAfterSec: +m[1] } }),
  },
  // [ctl] network DISABLED: dropped all 11 outbound leg(s)   (setnetworkactive false; news: the node has no peers)
  {
    name: 'ctlNetworkDisabled',
    re: /\[ctl\]\s*network DISABLED: dropped all (\d+) outbound leg\(s\)$/,
    apply: (m) => ({ kind: 'network_active', active: false, droppedLegs: +m[1], severity: 'warn' }),
  },
  // [serve] FATAL: download worker pid 2298970 exited with status 1 -- exiting so systemd restarts the unit
  {
    name: 'serveWorkerDied',
    re: /\[serve\]\s*FATAL: download worker pid (\d+) exited with status (-?\d+)/,
    apply: (m) => ({ kind: 'node_fatal', subsystem: 'serve', reason: `download worker pid ${m[1]} exited with status ${m[2]}`, severity: 'warn' }),
  },
  // [rpc] gettxout answers via the download worker (IPC)
  // [rpc] no rpcuser/rpcpassword -- using cookie authentication
  // [rpc] cookie authentication enabled (.cookie, mode 0600)
  // [rpc] block archive opened (chain RPCs live)
  // [rpc] JSON-RPC server on 127.0.0.1:8461 (live-node + chain, user=)
  // [rpc] Esplora facade on 127.0.0.1:3006 (bmc.esploraport; no auth: keep it on loopback or behind a proxy)
  // [rpc] encrypted wallet adopted (locked -- use walletpassphrase)
  {
    name: 'rpcGettxout',
    re: /\[rpc\]\s*gettxout answers via the download worker \(IPC\)$/,
    apply: () => ({ kind: 'node_fact', subsystem: 'rpc', facts: { gettxoutVia: 'download worker (IPC)' } }),
  },
  {
    name: 'rpcCookieAuth',
    re: /\[rpc\]\s*no rpcuser\/rpcpassword -- using cookie authentication$/,
    apply: () => ({ kind: 'node_fact', subsystem: 'rpc', facts: { auth: 'cookie' } }),
  },
  {
    name: 'rpcCookieFile',
    re: /\[rpc\]\s*cookie authentication enabled \((\S+), mode (\d+)\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'rpc', facts: { auth: 'cookie', cookieFile: m[1], cookieMode: m[2] } }),
  },
  {
    name: 'rpcChainLive',
    re: /\[rpc\]\s*block archive opened \(chain RPCs live\)$/,
    apply: () => ({ kind: 'node_fact', subsystem: 'rpc', facts: { chainRpcs: true } }),
  },
  {
    name: 'rpcServer',
    re: /\[rpc\]\s*JSON-RPC server on (\S+) \(([^,)]+)(?:, user=([^)]*))?\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'rpc', facts: { listen: m[1], serves: m[2].trim(), user: m[3] || null } }),
  },
  {
    name: 'rpcEsplora',
    re: /\[rpc\]\s*Esplora facade on (\S+) \(([^;)]+)(?:;\s*([^)]*))?\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'rpc', facts: { esplora: m[1], esploraSetting: m[2].trim(), esploraAuth: /no auth/.test(m[3] ?? '') ? 'none' : null } }),
  },
  {
    name: 'rpcEsploraFailed',
    re: /\[rpc\]\s*Esplora facade NOT started: (.+)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'rpc', facts: { esplora: null, esploraError: m[1].trim() }, severity: 'warn' }),
  },
  {
    name: 'rpcWalletAdopted',
    re: /\[rpc\]\s*encrypted wallet adopted (?:\((locked) -- use walletpassphrase\)|and (unlocked) from the configured passphrase source)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'wallet', facts: { encrypted: true, locked: m[1] === 'locked' } }),
  },
  // [wallet] seed, mnemonic and passphrase locked into RAM (mlock) and excluded from core dumps
  // [wallet] encrypted store present -- locked (walletpassphrase to unlock)
  {
    name: 'walletMlock',
    re: /\[wallet\]\s*seed, mnemonic and passphrase locked into RAM \(mlock\) and excluded from core dumps$/,
    apply: () => ({ kind: 'node_fact', subsystem: 'wallet', facts: { secretsMlocked: true } }),
  },
  {
    name: 'walletEncrypted',
    re: /\[wallet\]\s*encrypted store present -- (locked|unlocked)\b/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'wallet', facts: { encrypted: true, locked: m[1] === 'locked' } }),
  },
  // [tor] no onion service: cannot connect to tor control port 127.0.0.1:9051
  // [tor] onion service r7tb….onion:8333 -> 127.0.0.1:8334 (key onion_v3_private_key)   (builds before 2026-09-12)
  // [tor] announcing r7tb….onion:8333 to onion peers  ·  [tor] listenonion=0 -- no onion service
  {
    name: 'torNoOnion',
    re: /\[tor\]\s*no onion service: cannot connect to tor control port (\S+)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'tor', facts: { onionService: null, controlPort: m[1], why: 'cannot connect to the tor control port' } }),
  },
  // SET ASIDE: the second half of the line above, printed as its own line. It qualifies the
  // missing onion service (outbound onion still works) and has no figure of its own.
  {
    name: 'torInboundOnly',
    re: /\[tor\]\s*\(outbound onion is unaffected; only INBOUND needs the control port\)$/,
    apply: () => ({ kind: 'noted', why: 'explains the [tor] line above; no figure of its own' }),
  },
  {
    name: 'torOnionService',
    re: /\[tor\]\s*onion service (\S+) -> (\S+) \(key ([^)]+)\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'tor', facts: { onionService: m[1], target: m[2] } }),
  },
  {
    name: 'torAnnouncing',
    re: /\[tor\]\s*announcing (\S+) to onion peers$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'tor', facts: { announced: m[1] } }),
  },
  {
    name: 'torListenOff',
    re: /\[tor\]\s*listenonion=0 -- no onion service$/,
    apply: () => ({ kind: 'node_fact', subsystem: 'tor', facts: { onionService: null, why: 'listenonion=0' } }),
  },
  // [net] listening on IPv6 [::]:8462 (cjdns peers arrive here)
  // [net] BIP324 v2 transport enabled (services=0x809); 0 of 0 known peers advertise v2
  // [net] bind failed: Address already in use   (builds before 2026-09-12)
  {
    name: 'netListening',
    re: /\[net\]\s*listening on (IPv[46]) (\S+) \(([^)]*)\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'net', facts: { [`listen${m[1]}`]: m[2] } }),
  },
  {
    name: 'netV2',
    re: /\[net\]\s*BIP324 v2 transport enabled \(services=(\S+)\); (\d+) of (\d+) known peers advertise v2/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'net', facts: { v2: true, services: m[1], knownV2: +m[2], known: +m[3] } }),
  },
  {
    name: 'netBindFailed',
    re: /\[net\]\s*bind failed: (.+)$/,
    apply: (m) => ({ kind: 'node_fatal', subsystem: 'net', reason: `bind failed: ${m[1].trim()}`, severity: 'warn' }),
  },
  // [mux] using 64 peer(s) from the address book (seeds are bootstrap-only)
  // [mux] address book empty -- falling back to the seed list
  {
    name: 'muxBook',
    re: /\[mux\]\s*using (\d+) peer\(s\) from the address book/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'mux', facts: { bookPeers: +m[1], seeds: false } }),
  },
  {
    name: 'muxSeeds',
    re: /\[mux\]\s*address book empty -- falling back to the seed list$/,
    apply: () => ({ kind: 'node_fact', subsystem: 'mux', facts: { bookPeers: 0, seeds: true } }),
  },
  // [reorg] mempool reconciliation armed (shared pool, policy capacity 1048576)
  {
    name: 'reorgArmed',
    re: /\[reorg\]\s*mempool reconciliation armed \(shared pool, policy capacity (\d+)\)/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'reorg', facts: { reconcileCapacity: +m[1] } }),
  },
  // [reorg] detected competing chain at height 966499, work=0x… vs ours=0x… (our tip=966500, candidate adds 2 blocks)
  // [reorg] complete: new tip height=966501 hash=0000000000000000.. (9.11s, -1 +2 blocks)
  // [reorg] candidate REJECTED: fork at height 0 is 967127 blocks deep (max 100 -- deeper than the retained undo data). Human review required.
  // [reorg] probe of 212.132.122.236:8333 rejected a candidate chain (no action taken)
  // Builds before 2026-09-12 (no current log has had a reorg). A reorg is the news the feed
  // exists for, and "human review required" is a warning in the node's own words.
  {
    name: 'reorgDetected',
    re: /\[reorg\]\s*detected competing chain at height (\d+), work=(\S+) vs ours=(\S+) \(our tip=(\d+), candidate adds (\d+) blocks\)/,
    apply: (m) => ({ kind: 'reorg', state: 'detected', forkHeight: +m[1], work: m[2], ours: m[3], tip: +m[4], adds: +m[5], severity: 'warn' }),
  },
  {
    name: 'reorgComplete',
    re: /\[reorg\]\s*complete: new tip height=(\d+) hash=([0-9a-f]+)\.* \((\d+(?:\.\d+)?)s, -(\d+) \+(\d+) blocks\)/,
    apply: (m) => ({ kind: 'reorg', state: 'complete', tip: +m[1], hashPrefix: m[2], secs: +m[3], disconnected: +m[4], connected: +m[5], severity: 'warn' }),
  },
  {
    name: 'reorgRejected',
    re: /\[reorg\]\s*candidate REJECTED: fork at height (\d+) is (\d+) blocks deep \(max (\d+)/,
    apply: (m) => ({ kind: 'reorg', state: 'rejected', forkHeight: +m[1], depth: +m[2], maxDepth: +m[3], severity: 'warn' }),
  },
  {
    name: 'reorgProbeRejected',
    re: /\[reorg\]\s*probe of (\S+) rejected a candidate chain \(no action taken\)$/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'reorg_probe', addr: a.addr, host: a.host, result: 'rejected' }; },
  },
  {
    name: 'reorgProbeBudget',
    re: /\[reorg\]\s*probe of (\S+) exceeded (\d+)s budget; re-dialing$/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'reorg_probe', addr: a.addr, host: a.host, result: 'timed out', budgetSec: +m[2] }; },
  },

  // ---------------------------------------------------------------- [feeest]
  // [feeest] estimator seeded from fee_estimates.dat (115 MB shared)  ·  … started fresh (no fee_estimates.dat) (115 MB shared)
  // [feeest] shutdown: 0 unconfirmed tx flushed, fee_estimates.dat written (best height 321800)
  {
    name: 'feeestStart',
    re: /\[feeest\]\s*estimator (seeded from fee_estimates\.dat|started fresh \(no fee_estimates\.dat\)) \((\d+) MB shared\)/,
    apply: (m) => ({ kind: 'fee_estimator', state: m[1].startsWith('seeded') ? 'seeded' : 'fresh', sharedMB: +m[2] }),
  },
  {
    name: 'feeestSaved',
    re: /\[feeest\]\s*shutdown: (\d+) unconfirmed tx flushed, fee_estimates\.dat written \(best height (\d+)\)/,
    apply: (m) => ({ kind: 'fee_estimator', state: 'saved', flushed: +m[1], bestHeight: +m[2] }),
  },

  // ---------------------------------------------------------------- [dial]
  // [dial] 104.195.232.36:8333: background dial landed but the leg was not installed
  {
    name: 'dialUnused',
    re: /\[dial\]\s*(\S+?): background dial landed but the leg was not installed$/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'dial_unused', addr: a.addr, host: a.host }; },
  },
  // [dial] tip stale for 30 min (no block seen): wanting 9 outbound
  // [dial] tip fresh again: wanting 8 outbound
  // THE NODE SAYING IT HAS NOT SEEN A BLOCK FOR HALF AN HOUR, and reaching for more peers:
  // a stall, in the node's own words, and its recovery. Both are feed.
  {
    name: 'dialTipStale',
    re: /\[dial\]\s*tip stale for (\d+) min \(no block seen\): wanting (\d+) outbound/,
    apply: (m) => ({ kind: 'tip_stale', stale: true, minutes: +m[1], wantOutbound: +m[2], severity: 'warn' }),
  },
  {
    name: 'dialTipFresh',
    re: /\[dial\]\s*tip fresh again: wanting (\d+) outbound/,
    apply: (m) => ({ kind: 'tip_stale', stale: false, minutes: null, wantOutbound: +m[1] }),
  },
  // [dial] anchors.dat: 1 block-relay-only peer(s) saved  ·  … from the last run dialled first
  {
    name: 'dialAnchors',
    re: /\[dial\]\s*anchors\.dat: (\d+) block-relay-only peer\(s\) (saved|from the last run dialled first)$/,
    apply: (m) => ({ kind: 'anchors', peers: +m[1], state: m[2] === 'saved' ? 'saved' : 'dialled' }),
  },
  // [dial] 45.137.226.182:8333 advertised v2 but the handshake failed -- retrying as v1
  {
    name: 'dialV2Fallback',
    re: /\[dial\]\s*(\S+) advertised v2 but the handshake failed -- retrying as v1$/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'dial_v2_fallback', addr: a.addr, host: a.host, severity: 'info' }; },
  },
  // [dial] 31.209.143.169:8333 exceeded 20s dial budget; dropping   (builds before 2026-09-12)
  {
    name: 'dialBudget',
    re: /\[dial\]\s*(\S+) exceeded (\d+)s dial budget; dropping$/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'dial_attempt', addr: a.addr, host: a.host, family: null, timedOutSec: +m[2] }; },
  },
  // [dial] 6hjj….onion:8333 connected via onion transport   (builds before 2026-09-12)
  {
    name: 'dialTransport',
    re: /\[dial\]\s*(\S+) connected via (\w+) transport$/,
    apply(m) { const a = addrParts(m[1]); return { kind: 'dial_transport', addr: a.addr, host: a.host, network: m[2] }; },
  },
  // [dial] cjdns reachable (fc00::/8 over IPv6)  ·  [dial] onion via SOCKS5 127.0.0.1:9050   (the same builds)
  {
    name: 'dialCjdns',
    re: /\[dial\]\s*cjdns reachable \(([^)]*)\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'dial', facts: { cjdns: m[1] } }),
  },
  {
    name: 'dialOnionProxy',
    re: /\[dial\]\s*onion via (SOCKS\d) (\S+)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'dial', facts: { onionProxy: m[2] } }),
  },
  // [dial] i2p session up via SAM 127.0.0.1:7656, our address 37bw….b32.i2p   (builds before 2026-09-12)
  // [i2p] accepting inbound streams on 37bw….b32.i2p (SAM STREAM ACCEPT)
  {
    name: 'dialI2pSession',
    re: /\[dial\]\s*i2p session up via SAM (\S+), our address (\S+)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'i2p', facts: { sam: m[1], address: m[2] } }),
  },
  {
    name: 'i2pAccepting',
    re: /\[i2p\]\s*accepting inbound streams on (\S+) \(SAM STREAM ACCEPT\)$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'i2p', facts: { address: m[1], inbound: true } }),
  },
  // [privbcast] enabled: sendrawtransaction goes out over tor i2p short-lived connections, 3 per transaction, … (the same builds)
  {
    name: 'privateBroadcast',
    re: /\[privbcast\]\s*enabled: sendrawtransaction goes out over ((?:\w+ )*?)short-lived connections, (\d+) per transaction/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'privbcast', facts: { enabled: true, networks: m[1].trim().split(/\s+/).filter(Boolean), perTx: +m[2] } }),
  },

  // ---------------------------------------------------------------- [utxo_live]
  // [utxo_live] assumevalid: block found at height 938343 on the header chain -- script evaluation skipped through it, resumed above
  // [utxo_live] assumevalid: above height 938343 -- script evaluation resumed
  // [utxo_live] assumevalid: block not on the header chain yet -- every script is evaluated; re-checked every 1,000 blocks
  // Whether scripts are being verified, and from where: the assumevalid block and which side
  // of it the applier is on.
  {
    name: 'assumevalidFound',
    re: /\[utxo_live\]\s*assumevalid: block found at height (\d+)(?: on the header chain)? -- script evaluation skipped through it/,
    apply: (m) => ({ kind: 'assumevalid', state: 'skipping', height: +m[1] }),
  },
  {
    name: 'assumevalidResumed',
    re: /\[utxo_live\]\s*assumevalid: above height (\d+) -- script evaluation resumed$/,
    apply: (m) => ({ kind: 'assumevalid', state: 'verifying', height: +m[1] }),
  },
  {
    name: 'assumevalidNotFound',
    re: /\[utxo_live\]\s*assumevalid: block not on the header chain yet -- every script is evaluated; re-checked every ([\d,]+) blocks$/,
    apply: (m) => ({ kind: 'assumevalid', state: 'not found', height: null, recheckEvery: +m[1].replace(/,/g, '') }),
  },
  // [utxo_live] sizing: steady-state (applied=434960 tip=434960 gap=0) slots=2^16 blob=64MB compact_at=12
  // [utxo_live] sizing: BULK -- far behind, batch-sized memtable (applied=-1 tip=0 gap=1) slots=2^25 blob=6144MB compact_at=48
  // [utxo_live] WAL tail is 2414MB -- bulk-sizing the memtable despite gap=0 (see incident #32)
  {
    name: 'utxoSizing',
    re: /\[utxo_live\]\s*sizing: (steady-state|BULK)\b[^(]*\(applied=(-?\d+) tip=(-?\d+) gap=(-?\d+)\) slots=2\^(\d+) blob=(\d+)MB compact_at=(\d+)/,
    apply: (m) => ({ kind: 'utxo_sizing', mode: m[1] === 'BULK' ? 'bulk' : 'steady', applied: +m[2], tip: +m[3], gap: +m[4], slots: 2 ** +m[5], blobMB: +m[6], compactAt: +m[7], walTailMB: null }),
  },
  {
    name: 'utxoWalTail',
    re: /\[utxo_live\]\s*WAL tail is (\d+)MB -- bulk-sizing the memtable despite gap=(-?\d+)/,
    apply: (m) => ({ kind: 'utxo_sizing', mode: 'bulk', gap: +m[2], walTailMB: +m[1] }),
  },
  // [utxo_live] init dir=/…/main slots=2^16 reload applied_height=967700 manifest_n=10 live=165253693
  // The UTXO engine opening: whether it reloaded or started fresh, where it had got to, and
  // how many coins it holds. The directory is left out, as in `bootConfig`.
  {
    name: 'utxoInit',
    re: /\[utxo_live\]\s*init dir=\S+ slots=2\^(\d+) (reload|fresh) applied_height=(-?\d+) manifest_n=(\d+) live=(\d+)/,
    apply: (m) => ({ kind: 'utxo_init', slots: 2 ** +m[1], mode: m[2], appliedHeight: +m[3], manifestN: +m[4], live: +m[5] }),
  },
  // [utxo_live] init: pre-catchup compact manifest_n=36 -> 1 (result=1)  ·  recover: compact … (builds before 2026-09-10)
  // [utxo_live] init: swept 1 orphan file(s) the manifest does not name
  {
    name: 'utxoInitCompact',
    re: /\[utxo_live\]\s*(init: pre-catchup|recover:) compact manifest_n=(\d+) -> (\d+) \(result=(-?\d+)\)/,
    apply: (m) => ({ kind: 'utxo_maintenance', action: m[1].startsWith('init') ? 'pre-catchup compact' : 'recovery compact', manifestFrom: +m[2], manifestTo: +m[3], result: +m[4] }),
  },
  {
    name: 'utxoInitSwept',
    re: /\[utxo_live\]\s*init: swept (\d+) orphan file\(s\) the manifest does not name$/,
    apply: (m) => ({ kind: 'utxo_maintenance', action: 'swept orphans', files: +m[1] }),
  },
  // [utxo_live] BIP30: ancestor at height 227931 is BIP34Hash -- skipping the duplicate-outpoint check above that height
  // [utxo_live] h=91842: duplicate coinbase outpoint overwritten (Core: AddCoins overwrite=fCoinbase); coinstats: remove old + add new
  // Consensus bookkeeping Core does silently. The two duplicate coinbases (91842, 91880) are
  // history, not news, so this is state.
  {
    name: 'utxoBip30Skip',
    re: /\[utxo_live\]\s*BIP30: ancestor at height (\d+) is BIP34Hash -- skipping the duplicate-outpoint check above that height/,
    apply: (m) => ({ kind: 'bip30', state: 'skipping check', height: +m[1] }),
  },
  {
    name: 'utxoDupCoinbase',
    re: /\[utxo_live\]\s*h=(\d+): duplicate coinbase outpoint overwritten \(Core: AddCoins overwrite=fCoinbase\)/,
    apply: (m) => ({ kind: 'bip30', state: 'duplicate coinbase overwritten', height: +m[1] }),
  },
  // [utxo_live] catchup timing: 673 block(s) 433048..433720 in 22.4s -- read 0% idx 3% verify 1% get 13% put 19% ckpt 1% flush 61% csi 2% other 0% (33.34 ms/blk over 673)
  // Where the applier's time went, by phase: the same phase split `catchupProgress` reads.
  {
    name: 'utxoCatchupTiming',
    re: /\[utxo_live\]\s*catchup timing: (\d+) block\(s\) (\d+)\.\.(\d+) in (\d+(?:\.\d+)?)s -- (.*?)\((\d+(?:\.\d+)?) ms\/blk over (\d+)\)/,
    apply(m) {
      const phases = {};
      for (const [, name, pct] of m[5].matchAll(/\b([a-z0-9_]+)\s+(\d+(?:\.\d+)?)%/g)) phases[name] = +pct;
      return { kind: 'catchup_timing', blocks: +m[1], from: +m[2], to: +m[3], secs: +m[4], phases, msPerBlk: +m[6], samples: +m[7] };
    },
  },
  // [utxo_live] catchup progress: height=965871/965913 (100.0%) 5.3 blk/s (avg 5.3) eta 00:00:00:07
  // [utxo_live] catchup progress: height=964942/964942 (100.0%)
  // The two shorter spellings of `catchupProgress`, from builds before 2026-09-10.
  {
    name: 'catchupProgressShort',
    re: /\[utxo_live\]\s*catchup progress: height=(\d+)\/(\d+) \((\d+(?:\.\d+)?)%\)(?: (\d+(?:\.\d+)?) blk\/s \(avg (\d+(?:\.\d+)?)\) eta (\S+))?$/,
    apply: (m) => ({
      kind: 'catchup_progress', height: +m[1], of: +m[2], pct: +m[3],
      blkPerSec: m[4] == null ? null : +m[4], avgBlkPerSec: m[5] == null ? null : +m[5],
      nodeEtaMs: m[6] == null ? null : parseClock(m[6]), phases: null, msPerBlk: null, samples: null,
    }),
  },
  // [utxo_live] run files total 46.7 GB > budget 46.3 GB (35% of RAM) -- compacting 27 of 27 runs below the count threshold
  {
    name: 'utxoRunBudget',
    re: /\[utxo_live\]\s*run files total (\d+(?:\.\d+)?) GB > budget (\d+(?:\.\d+)?) GB \((\d+)% of RAM\) -- compacting (\d+) of (\d+) runs/,
    apply: (m) => ({ kind: 'utxo_maintenance', action: 'over run budget', runGB: +m[1], budgetGB: +m[2], ramPct: +m[3], compacting: +m[4], runs: +m[5] }),
  },
  // [utxo_live] compaction of 9 run(s) [3..12) of 12 started in background pid 2988100 (mid-catchup at height 966018; …) -- apply continues
  // [utxo_live] background compaction done in 1967.9s: manifest_n 12 -> 4 (9 merged into run 205, 0 flushed meanwhile), 9 input run(s) unlinked (started at height 966018; apply never waited)
  // Builds before 2026-09-12: the background form `utxoCompaction` replaced.
  {
    name: 'utxoCompactionStarted',
    re: /\[utxo_live\]\s*compaction of (\d+) run\(s\) \[(\d+)\.\.(\d+)\) of (\d+) started in background pid (\d+) \(([\w-]+) at height (\d+)/,
    apply: (m) => ({ kind: 'utxo_maintenance', action: 'compaction started', runsMerged: +m[1], runsTotal: +m[4], pid: +m[5], phase: m[6], height: +m[7] }),
  },
  {
    name: 'utxoCompactionBackground',
    re: /\[utxo_live\]\s*background compaction done in (\d+(?:\.\d+)?)s: manifest_n (\d+) -> (\d+) \((\d+) merged into run (\d+), (\d+) flushed meanwhile\), (\d+) input run\(s\) unlinked \(started at height (\d+); apply (never waited|waited[^)]*)\)/,
    apply(m) {
      const waited = m[9] !== 'never waited';
      return {
        kind: 'utxo_compaction', secs: +m[1], runsMerged: +m[4], runsTotal: null, startedAtHeight: +m[8],
        manifestFrom: +m[2], manifestTo: +m[3], runId: +m[5], flushedMeanwhile: +m[6], inputsUnlinked: +m[7],
        applyWaited: waited, detail: m[9], severity: waited ? 'warn' : 'info',
      };
    },
  },
  // [utxo_live] shutdown requested -- stopping catch-up cleanly after height 431427 (307 block(s) applied this call, checkpoint persisted)
  // [utxo_live] shutdown: killed background compaction pid 3103403 (its partial run is an orphan)
  {
    name: 'utxoShutdownCatchup',
    re: /\[utxo_live\]\s*shutdown requested -- stopping catch-up cleanly after height (\d+) \((\d+) block\(s\) applied this call/,
    apply: (m) => ({ kind: 'utxo_maintenance', action: 'catch-up stopped for shutdown', height: +m[1], blocks: +m[2] }),
  },
  {
    name: 'utxoShutdownCompaction',
    re: /\[utxo_live\]\s*shutdown: killed background compaction pid (\d+)/,
    apply: (m) => ({ kind: 'utxo_maintenance', action: 'compaction killed for shutdown', pid: +m[1], severity: 'info' }),
  },
  // [utxo_live] caught up at height 433720 -- downshifting to steady-state flush thresholds (fill=49152 op=131072)
  // [utxo_live] caught up: flushed the WAL tail (295135888 bytes, manifest_n 13 -> 14) so the next reload has nothing to replay
  // THE APPLIER REACHING THE TIP: the end of a catch-up. The first line is the milestone
  // (feed); the second is its bookkeeping (state).
  {
    name: 'utxoCaughtUp',
    re: /\[utxo_live\]\s*caught up at height (\d+) -- downshifting to steady-state flush thresholds \(fill=(\d+) op=(\d+)\)/,
    apply: (m) => ({ kind: 'utxo_caught_up', height: +m[1], fill: +m[2], op: +m[3] }),
  },
  {
    name: 'utxoCaughtUpFlush',
    re: /\[utxo_live\]\s*caught up: flushed the WAL tail \((\d+) bytes, manifest_n (\d+) -> (\d+)\)/,
    apply: (m) => ({ kind: 'utxo_maintenance', action: 'flushed WAL tail', bytes: +m[1], manifestFrom: +m[2], manifestTo: +m[3] }),
  },
  // [utxo_live] REJECT h=428471 tx=3: input references a missing/already-spent UTXO
  // [utxo_live] FATAL: apply_block failed at height 428471 -- stopping catch-up
  // Builds before 2026-09-10. A block the node's own applier refused: always a warning.
  {
    name: 'utxoReject',
    re: /\[utxo_live\]\s*REJECT h=(\d+) tx=(\d+): (.+)$/,
    apply: (m) => ({ kind: 'utxo_failure', state: 'rejected', height: +m[1], tx: +m[2], reason: m[3].trim(), severity: 'warn' }),
  },
  {
    name: 'utxoFatal',
    re: /\[utxo_live\]\s*FATAL: apply_block failed at height (\d+)/,
    apply: (m) => ({ kind: 'utxo_failure', state: 'apply failed', height: +m[1], severity: 'warn' }),
  },
  // [utxo_live] unapply h=966500: 2494 of 10178 created outputs were ALREADY ABSENT and were not deleted -- … the set may hold phantom coins
  // Seen once, during the reorg of 2026-09-0x; the node's own words are that its UTXO set may
  // now be wrong, which is a warning however rare.
  {
    name: 'utxoUnapplyAbsent',
    re: /\[utxo_live\]\s*unapply h=(\d+): (\d+) of (\d+) created outputs were ALREADY ABSENT/,
    apply: (m) => ({ kind: 'utxo_failure', state: 'unapply found outputs absent', height: +m[1], absent: +m[2], of: +m[3], severity: 'warn' }),
  },
  // [catchup] store now tips at height 966647   (builds before 2026-09-10)
  {
    name: 'catchupStoreTip',
    re: /\[catchup\]\s*store now tips at height (\d+)$/,
    apply: (m) => ({ kind: 'archive_complete', height: +m[1] }),
  },

  // ---------------------------------------------------------------- [coinstats]
  // [coinstats] fold worker pid 1394840 started at height -1: the connect thread pushes coin records, the worker folds
  // [coinstats] fold worker exiting: folded 240158840 element(s), watermark height 321800   (written untimestamped by the worker)
  // [coinstats] fold worker pid 1655732 is gone (already reaped) -- the index cannot be maintained
  // The coin-statistics (gettxoutsetinfo) index's worker. "Is gone" reads like a failure,
  // and it is worded as one, but all 32 in the current logs came during a shutdown, after the
  // node's `[feeest] shutdown:` line -- so it is state, with the node's severity kept.
  {
    name: 'coinstatsWorkerStarted',
    re: /\[coinstats\]\s*fold worker pid (\d+) started at height (-?\d+)/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'worker started', pid: +m[1], height: +m[2] }),
  },
  {
    name: 'coinstatsWorkerExiting',
    re: /\[coinstats\]\s*fold worker exiting: folded (\d+) element\(s\), watermark height (-?\d+)/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'worker exiting', folded: +m[1], height: +m[2] }),
  },
  // [coinstats] fold worker pid 1378753 stopped (coinstats.dat through height 967712)   (a clean stop, 2026-09-19 build)
  {
    name: 'coinstatsWorkerStopped',
    re: /\[coinstats\]\s*fold worker pid (\d+) stopped \((\S+) through height (-?\d+)\)$/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'worker stopped', pid: +m[1], file: m[2], height: +m[3] }),
  },
  {
    name: 'coinstatsWorkerGone',
    re: /\[coinstats\]\s*fold worker pid (\d+) is gone \(([^)]*)\) -- the index cannot be maintained/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'worker gone', pid: +m[1], how: m[2], severity: 'warn' }),
  },
  // [coinstats] adopted persisted state at height 321800
  // [coinstats] seeding from a full walk at height -1 (~-1M coins; one-time)  ·  … (minutes; one-time)
  // [coinstats] seeded: 0 coins, txouts=0 at height -1
  // [coinstats] seed walk: 20M of ~165M coins (12%, 0.9M/s)   (builds before 2026-09-12)
  // [coinstats] history base complete to 967384
  {
    name: 'coinstatsAdopted',
    re: /\[coinstats\]\s*adopted persisted state at height (-?\d+)$/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'adopted', height: +m[1] }),
  },
  {
    name: 'coinstatsSeeding',
    re: /\[coinstats\]\s*seeding from a full walk at height (-?\d+) \(([^)]*)\)$/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'seeding', height: +m[1], note: m[2] }),
  },
  {
    name: 'coinstatsSeeded',
    re: /\[coinstats\]\s*seeded: (\d+) coins, txouts=(\d+) at height (-?\d+)$/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'seeded', coins: +m[1], txouts: +m[2], height: +m[3] }),
  },
  {
    name: 'coinstatsSeedWalk',
    re: /\[coinstats\]\s*seed walk: (\d+)M of ~(\d+)M coins \((\d+)%, (\d+(?:\.\d+)?)M\/s\)$/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'seeding', coinsDone: +m[1] * 1e6, coinsOf: +m[2] * 1e6, pct: +m[3], coinsPerSec: +m[4] * 1e6 }),
  },
  {
    name: 'coinstatsHistoryComplete',
    re: /\[coinstats\]\s*history base complete to (\d+)$/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'history complete', height: +m[1] }),
  },
  // [coinstats] repair: history base absent -- building rows 0..967384 with 8 worker(s) (pid 2729906, attempt 1 of 3; /…/bmc_build_coinstats_hist)
  // [coinstats] repair: history base rebuilt, rows 0..967384 verified (pid 2729906, 5917s)
  // A repair starting and finishing: both feed. It takes an hour and a half.
  {
    name: 'coinstatsRepairStart',
    re: /\[coinstats\]\s*repair: history base absent -- building rows (\d+)\.\.(\d+) with (\d+) worker\(s\) \(pid (\d+), attempt (\d+) of (\d+)/,
    apply: (m) => ({ kind: 'coinstats_repair', state: 'building', from: +m[1], to: +m[2], workers: +m[3], pid: +m[4], attempt: +m[5], attempts: +m[6] }),
  },
  // [coinstats] repair: builder /…/bmc_build_coinstats_hist not executable -- cannot rebuild the history base
  // The repair cannot start: news, as a warning, and the builder named by its file only.
  {
    name: 'coinstatsRepairNoBuilder',
    re: /\[coinstats\]\s*repair: builder (\S+) not executable -- cannot rebuild the history base$/,
    apply: (m) => ({ kind: 'coinstats_repair', state: 'builder not executable', builder: m[1].split('/').pop(), severity: 'warn' }),
  },
  {
    name: 'coinstatsRepairDone',
    re: /\[coinstats\]\s*repair: history base rebuilt, rows (\d+)\.\.(\d+) verified \(pid (\d+), (\d+)s\)/,
    apply: (m) => ({ kind: 'coinstats_repair', state: 'rebuilt', from: +m[1], to: +m[2], pid: +m[3], secs: +m[4] }),
  },
  // [coinstats] persisted height 965913 != applied 966096 -- re-seed needed    (builds before 2026-09-12)
  // [coinstats] index INVALIDATED (pre-BIP34 duplicate-coinbase overwrite) -- will re-seed
  {
    name: 'coinstatsReseed',
    re: /\[coinstats\]\s*(?:persisted height (-?\d+) != applied (-?\d+)|index INVALIDATED \(([^)]*)\)) -- (?:re-seed needed|will re-seed)$/,
    apply: (m) => ({ kind: 'coinstats_state', state: 'invalidated', height: m[1] == null ? null : +m[1], applied: m[2] == null ? null : +m[2], why: m[3] ?? 'persisted height behind the applied height', severity: 'warn' }),
  },

  // ---------------------------------------------------------------- [coinstats-hist]
  // The coin-statistics history builder, a child process: some of its lines have no
  // timestamp (tsFallback). `coinstatsHistPass` above reads its progress lines.
  // [coinstats-hist] dir=/…/main tip=967384 to=967384 workers=8 chain=main
  // [coinstats-hist] pass1 done (3012s)  ·  pass2 w4: 437267723 spends matched, 0 unmatched
  // [coinstats-hist] pass3: 5 worker(s) (largest range needs ~11439 MB each; MemAvailable 87468 MB)
  // [coinstats-hist] DONE: rows 0..967384, txouts=165248406 amount=20085348.00433346 prevout_spent=… coinbase=… scripts=5116221750 subsidy=… (2s)
  {
    name: 'coinstatsHistStart',
    keys: ['coinstats_hist', 'coinstats-hist'],
    re: /\[coinstats[-_]hist\]\s*dir=\S+ tip=(\d+) to=(\d+) workers=(\d+) chain=(\w+)$/,
    apply: (m) => ({ kind: 'coinstats_hist', state: 'started', tip: +m[1], to: +m[2], workers: +m[3], chain: m[4] }),
  },
  {
    name: 'coinstatsHistPassDone',
    keys: ['coinstats_hist', 'coinstats-hist'],
    re: /\[coinstats[-_]hist\]\s*pass(\d+) done \((\d+(?:\.\d+)?)s\)$/,
    apply: (m) => ({ kind: 'coinstats_hist', state: 'pass done', pass: +m[1], secs: +m[2] }),
  },
  {
    name: 'coinstatsHistMatched',
    keys: ['coinstats_hist', 'coinstats-hist'],
    re: /\[coinstats[-_]hist\]\s*pass(\d+) w(\d+): (\d+) spends matched, (\d+) unmatched$/,
    apply: (m) => ({ kind: 'coinstats_hist', state: 'matched', pass: +m[1], worker: +m[2], matched: +m[3], unmatched: +m[4], severity: +m[4] > 0 ? 'warn' : 'info' }),
  },
  {
    name: 'coinstatsHistPlan',
    keys: ['coinstats_hist', 'coinstats-hist'],
    re: /\[coinstats[-_]hist\]\s*pass(\d+): (\d+) worker\(s\) \(largest range needs ~(\d+) MB each; MemAvailable (\d+) MB\)/,
    apply: (m) => ({ kind: 'coinstats_hist', state: 'planned', pass: +m[1], workers: +m[2], needMB: +m[3], availableMB: +m[4] }),
  },
  {
    name: 'coinstatsHistDone',
    keys: ['coinstats_hist', 'coinstats-hist'],
    re: /\[coinstats[-_]hist\]\s*DONE: rows (\d+)\.\.(\d+), txouts=(\d+) amount=(\d+(?:\.\d+)?) .*\((\d+(?:\.\d+)?)s\)$/,
    apply: (m) => ({ kind: 'coinstats_hist', state: 'done', from: +m[1], to: +m[2], txouts: +m[3], amount: m[4], secs: +m[5] }),
  },
  // [coinstats-hist] discarded 0 stale scratch file(s) and 252 old-layout csh_*.tmp (…)   (builds before 2026-09-12)
  {
    name: 'coinstatsHistDiscarded',
    keys: ['coinstats_hist', 'coinstats-hist'],
    re: /\[coinstats[-_]hist\]\s*discarded (\d+) stale scratch file\(s\) and (\d+) old-layout/,
    apply: (m) => ({ kind: 'coinstats_hist', state: 'cleaned', stale: +m[1], oldLayout: +m[2] }),
  },

  // ---------------------------------------------------------------- [config]
  // [config] loaded /…/bitcoin.conf: 17 setting(s) applied  ·  … (some rejected -- see above)
  {
    name: 'configLoaded',
    re: /\[config\]\s*loaded (\S+): (\d+) setting\(s\) applied( \(some rejected)?/,
    apply: (m) => ({ kind: 'config_loaded', file: m[1].split('/').pop(), applied: +m[2], someRejected: m[3] != null, severity: m[3] ? 'warn' : 'info' }),
  },
  // [config] peers: min_bps=32768 ticks=3 min_usable=8 pool=2048
  // [config] mpol : minrelay=100 inc=100 sat/vB, anc=25/101kvB desc=25/101kvB fullrbf=1
  // … one line per section: peers addr utxo pool mpol res net src chain mine wallet rpc log pow work
  // THE EFFECTIVE CONFIGURATION, section by section: every key=value read, the same way as
  // `bootConfig`. The sections are named, not matched by pattern, so a section the node adds
  // later is reported as unread rather than read without anyone looking at it.
  {
    name: 'configSection',
    re: /\[config\]\s*(peers|addr|utxo|pool|mpol|res|net|src|chain|mine|wallet|rpc|log|pow|work)\s*:\s*(\S.*)$/,
    apply(m) {
      const settings = {};
      for (const [, k, v] of m[2].matchAll(/([a-z_][a-z0-9_]*)=([^\s,]+)/gi)) settings[k] = v;
      return Object.keys(settings).length ? { kind: 'config_section', section: m[1], settings } : null;
    },
  },
  // [config] chain:   checking last 6 block(s)
  {
    name: 'configCheckBlocks',
    re: /\[config\]\s*chain:\s+checking last (\d+) block\(s\)$/,
    apply: (m) => ({ kind: 'config_section', section: 'chain', settings: { checkblocksEffective: m[1] } }),
  },
  // [config] bind=192.0.2.242 is not a usable number -- reading it as 0
  // [config] dbcache=0 out of range [4,262144] -- ignoring
  // [config] txindex=1 has no effect -- the txid index is built OFFLINE (…)
  // A SETTING THE NODE DID NOT TAKE AS WRITTEN. The first is a real misreading on this box
  // today (`bind=` read as a number); all three are warnings and reach the feed, once per start.
  {
    name: 'configNotANumber',
    re: /\[config\]\s*([a-z_][a-z0-9_.]*)=(.*?) is not a usable number -- reading it as (-?\d+)$/i,
    apply: (m) => ({ kind: 'config_rejected', setting: m[1], value: m[2].replace(/\s+#.*$/, '').trim(), readAs: m[3], why: 'not a usable number', severity: 'warn' }),
  },
  {
    name: 'configOutOfRange',
    re: /\[config\]\s*([a-z_][a-z0-9_.]*)=(\S+) out of range \[(-?\d+),(-?\d+)\] -- ignoring$/i,
    apply: (m) => ({ kind: 'config_rejected', setting: m[1], value: m[2], readAs: null, why: `out of range [${m[3]},${m[4]}]`, severity: 'warn' }),
  },
  {
    name: 'configNoEffect',
    re: /\[config\]\s*([a-z_][a-z0-9_.]*)=(\S+) has no effect -- /i,
    apply: (m) => ({ kind: 'config_rejected', setting: m[1], value: m[2], readAs: null, why: 'has no effect in this node', severity: 'warn' }),
  },
  // [config] FATAL: private broadcast of own transactions requested (privatebroadcast=1), but none of Tor or I2P networks is reachable -- …
  {
    name: 'configFatal',
    re: /\[config\]\s*FATAL: (.+?)(?: -- .*)?$/,
    apply: (m) => ({ kind: 'node_fatal', subsystem: 'config', reason: m[1].trim(), severity: 'warn' }),
  },

  // ---------------------------------------------------------------- untagged
  // These carry no `[tag]`, so they are tried on every line that its own tag did not claim:
  // anchored at the start, so each costs one character comparison on a line that is not it.
  //
  // serving on port 8462 (0 outbound peer(s))...
  {
    name: 'servingOnPort',
    re: /^serving on port (\d+) \((\d+) outbound peer\(s\)\)\.\.\.$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'serve', facts: { port: +m[1], outboundAtStart: +m[2] } }),
  },
  // INFO node start (serve mode / download worker)
  // Written by the download worker as it starts, with no timestamp of its own -- so it is
  // `tsFallback`, as every such line is. A start is state; the boot record has the rest.
  // The line ENDS IN A NUL BYTE (`) \0 \n`, all 31 copies in run 26 and run 27's one): the
  // worker writes its string's terminator into the log. Allowed for here, and worth a word
  // upstream, since a NUL in a text log is what makes grep call it a binary file.
  {
    name: 'workerStart',
    re: /^INFO node start \(([^)]*)\)[\s\0]*$/,
    apply: (m) => ({ kind: 'node_fact', subsystem: 'worker', facts: { started: m[1] } }),
  },
  // ======================================================================
  // ===== bmcbitcoind  LOG START: 2026-09-19 11:50:10 UTC
  // =====   pid 1362025  v0.0.1  built Sep 19 2026 09:08:09  mode=serve
  // The banner a start writes before its first timestamped line. The version and build time
  // are the one place the log says WHICH BUILD is running, so they are read. The banner's
  // own time is UTC and printed by the banner, not in the node's timestamp format, so the
  // event keeps `tsFallback` and carries that time as a figure (`loggedAtUtc`) instead.
  {
    name: 'bannerStart',
    re: /^===== (\S+)\s+LOG START: (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/,
    apply: (m) => ({ kind: 'node_build', program: m[1], loggedAtUtc: Date.parse(`${m[2]}T${m[3]}Z`) }),
  },
  {
    name: 'bannerBuild',
    re: /^=====\s+pid (\d+)\s+v(\S+)\s+built (.+?)\s+mode=(\w+)$/,
    apply: (m) => ({ kind: 'node_build', pid: +m[1], version: m[2], built: m[3], mode: m[4] }),
  },
  // SET ASIDE: the banner's rule line, a row of `=`. It is a separator; there is nothing in it.
  {
    name: 'bannerRule',
    re: /^={20,}$/,
    apply: () => ({ kind: 'noted', why: 'the start banner\'s separator line' }),
  },
];

// DISPATCH BY TAG (2026-09-19). Until today every line was tried against every rule, twice
// (once without its tag, once with), which was cheap at 60 rules and would not have been at
// 250: reading all of bmc's log took the rule count past four times what §37 measured. Each
// rule now names the tag it belongs to -- read from the literal `\[tag` its pattern starts
// with, or given as `keys` where the pattern spells the tag some other way -- and a line
// tries only the rules for the tag it opens with, then the few that are not keyed on a tag.
// The key is taken from the text itself rather than TAG_RE, so `[dlc w5]` and
// `[coinstats-hist]`, which TAG_RE does not claim, still find their rules.
//
// A line that none of those claims then tries the rules of every OTHER tag that appears
// later in it, in rule order. That is exactly the set of rules the old every-rule loop could
// still have matched -- a keyed rule's pattern starts with its own `\[tag` -- so the old
// behaviour survives for odd lines: of 615,000 lines checked, one needs it, two log lines
// the node wrote without a newline between them. Trying every rule instead cost a line with
// no tag at all (all of a Core log) 40% of its speed, for nothing.
const KEY_RE = /^\s*\[([a-z0-9_-]+)/;
const LATER_KEY_RE = /\[([a-z0-9_-]+)/g;
function laterTagRules(body, key) {
  let found = null;
  LATER_KEY_RE.lastIndex = 1;
  for (let m; (m = LATER_KEY_RE.exec(body));) {
    const list = m[1] !== key && RULES_BY_KEY.get(m[1]);
    if (list) (found ??= new Set()).add(list);
  }
  if (!found) return [];
  if (found.size === 1) return [...found][0];
  return [...new Set([...found].flat())].sort((a, b) => RULE_ORDER.get(a) - RULE_ORDER.get(b));
}
function ruleKeys(rule) {
  if (rule.keys) return rule.keys;
  const src = rule.re.source;
  const lit = src.match(/^\\\[([a-z0-9_]+)(?:\\\]|:| )/);
  if (lit) return [lit[1]];
  const alt = src.match(/^\\\[\(([a-z0-9_|]+)\)\\\]/);
  if (alt) return alt[1].split('|');
  return null;
}
const RULES_BY_KEY = new Map();
const RULES_ANY = [];
const RULE_ORDER = new Map(RULES.map((r, i) => [r, i]));
for (const rule of RULES) {
  const keys = ruleKeys(rule);
  if (!keys) { RULES_ANY.push(rule); continue; }
  for (const k of keys) {
    if (!RULES_BY_KEY.has(k)) RULES_BY_KEY.set(k, []);
    RULES_BY_KEY.get(k).push(rule);
  }
}
function tryRules(list, text) {
  for (const rule of list) {
    const m = text.match(rule.re);
    if (m) {
      const out = rule.apply(m);
      if (out) return [rule, out];
    }
  }
  return null;
}
export const RULE_KEYS_FOR_TEST = { byKey: RULES_BY_KEY, any: RULES_ANY };

// Which measurements must keep arriving, and how long a silence counts as a format
// change rather than a quiet phase.
//
// Why this exists: four grammars changed on 2026-09-08 and the corpus-wide parse
// ratio flagged none of them, because a ratio over every line measures the corpus
// and not the rule (rule 16). The ratio then cut the other way an hour later --
// production dropped to 73.4% purely because `addrv2 gossip` chatter grew, costing
// nothing.
//
// Gates are p95 x 8, clamped to [10 min, 30 min], from cadences measured on both
// live nodes the same day (production: 355-640 occurrences per shape):
//
//   shape                  median    p95     max     gate
//   heartbeat                65s    152s   1657s     20 min
//   relay legs               64s    120s   1842s     16 min
//   orphans                  65s    152s   1657s     20 min
//   accepts and rejects      33s     86s   1652s     12 min
//   address gossip           22s     87s    902s     12 min
//   bandwidth tick           10s     17s     17s     10 min   (IBD only)
//   download progress        10s     17s     17s     10 min   (IBD only)
//
// Left unwatched, with the numbers that justify it: `[dl] updating utxo`
// (460/1868/3669 s) and `header mirror` (502/2054/3669 s) are bursty, and
// `ban_count`, `relay_paused`, `ibd_behind` and the discovery lines are one-shot or
// phase-dependent. Watching an irregular line produces a warning that is wrong often
// enough to be ignored, which is worse than no warning.
//
// A shape is watched only after it has matched at least once (armed). That is how
// build differences are handled without a build table: the bench build never emits
// `heartbeat`, and production emits a bandwidth tick twice in several hours because
// it is synced. Neither should be a warning.
//
// The four relay shapes are the mirror image: watched only OUTSIDE IBD (syncedOnly). Their
// cadences were measured on synced nodes; a node in initial sync has no mempool to relay
// into. Measured 2026-09-24 on a mainnet bmc at 93%: `[tx_accept]` was all missing-inputs
// rejects against "mempool 0" and stopped for good at 19:16 when the two relay peers closed
// their end, while the download ran on at 11 MB/s. Flagging that as a reworded line was
// wrong for two hours straight.
export const SHAPES = [
  { shape: 'bandwidth rate', rules: ['bandwidthTick', 'bandwidthTickFields'], gateMs: 600_000, ibdOnly: true },
  { shape: 'download progress', rules: ['dlcProgressFields'], gateMs: 600_000, ibdOnly: true },
  { shape: 'heartbeat', rules: ['heartbeat'], gateMs: 1_200_000 },
  { shape: 'relay legs', rules: ['txRelay', 'txRelayBare'], gateMs: 960_000, syncedOnly: true },
  { shape: 'accepts and rejects', rules: ['txAccept'], gateMs: 720_000, syncedOnly: true },
  { shape: 'orphans', rules: ['orphans'], gateMs: 1_200_000, syncedOnly: true },
  { shape: 'address gossip', rules: ['addrGossip'], gateMs: 720_000, syncedOnly: true },
];

// The shape a rule belongs to, for the liveness bookkeeping in the monitor.
// Built once: rule name -> shape label.
export const RULE_TO_SHAPE = new Map(
  SHAPES.flatMap((s) => s.rules.map((r) => [r, s.shape])),
);

// Coarse severity so the UI can colour the feed without understanding each tag.
function classify(tag, msg) {
  if (/\b(error|failed|failure|unreachable|refus|denied|dropped|not laid out|abort|fatal|panic|corrupt|OOM|killed)\b/i.test(msg)) return 'warn';
  if (/\b(warn|warning|stall|banned|silent rank last)\b/i.test(msg)) return 'warn';
  if (/\b(connected|accepted|stored|wrote|resolved|done|synced|bound|listening)\b/i.test(msg)) return 'info';
  return 'info';
}

// The node logs local time with no UTC offset, so assemble the date in local
// time. Date.parse of a non-ISO string is implementation-defined; explicit
// fields are not.
function localFromLogTs(dateTime, ms) {
  const m = dateTime.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return Date.now();
  const [, y, mo, d, h, mi, s] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, +s, +ms).getTime();
}

// LONG LINES (2026-09-16, audit L6). Every rule runs unanchored on the server's main
// thread, so a line's length is a cost every rule pays. No line this node prints comes
// near 8 KB (the longest in the fixtures is a few hundred bytes); anything past that is
// cut before matching, and the event says so (`truncated`: the characters dropped).
// Together with the rewritten patterns above, a 20,000-space line parses in
// a few milliseconds where `legDown` alone used to not finish in 300 s.
export const MAX_LINE = 8192;

// One line in, one event out (or null for a continuation/blank line).
export function parseLine(line) {
  if (!line) return null;
  let cut = 0;
  if (line.length > MAX_LINE) { cut = line.length - MAX_LINE; line = line.slice(0, MAX_LINE); }
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim()) return null;

  // A LINE WITH NO TIMESTAMP IS STAMPED NOW, AND SAYS SO (2026-09-18). The fallback
  // was always here; what was missing is that the event never admitted to it, so a
  // line the parser dated itself was indistinguishable in the feed from one the node
  // dated. That matters for real lines, not just for Core: the index builders' child
  // processes write ~750 untimestamped lines per run into this same log, and they
  // arrive in the feed at the moment they were READ. `tsFallback` lets the consumer
  // order, gate or mark them differently; nothing here decides that for it.
  let ts = Date.now();
  let tsFallback = false;
  let rest = trimmed;
  const tsm = trimmed.match(TS_RE);
  if (tsm) {
    ts = localFromLogTs(tsm[1], tsm[2]);
    rest = trimmed.slice(tsm[0].length);
  } else {
    tsFallback = true;
  }

  const body = rest;
  let tag = null;
  const tagm = rest.match(TAG_RE);
  if (tagm) { tag = tagm[0].replace(/[\[\]\s]/g, ''); rest = rest.slice(tagm[0].length); }
  const tagBase = tag ? tag.split(':')[0] : null;

  // The line's own rules first, then the untagged ones, then -- only for a line neither
  // claims -- the rules of any other tag that appears later in the line (see RULES_BY_KEY).
  const key = body.match(KEY_RE)?.[1];
  const own = key ? RULES_BY_KEY.get(key) : undefined;
  const hit = (own && tryRules(own, body)) ?? tryRules(RULES_ANY, body) ?? tryRules(laterTagRules(body, key), body);
  if (hit) {
    const [rule, out] = hit;
    out.ts = ts;
    if (tsFallback) out.tsFallback = true;
    out.tag = tag;
    out.tagBase = tagBase;
    out.text = rest.trim();
    out.rule = rule.name;
    out.severity = out.severity ?? classify(tagBase, rest);
    if (cut) out.truncated = cut;
    return out;
  }

  return {
    kind: 'raw',
    ts,
    ...(tsFallback ? { tsFallback: true } : {}),
    tag,
    tagBase,
    text: rest.trim(),
    severity: classify(tagBase, rest),
    rule: null,
    ...(cut ? { truncated: cut } : {}),
  };
}

// Lines arrive in chunks; keep the trailing partial line for the next round.
//
// 2026-09-16 (audit L6): the partial line used to grow without limit, so a log that
// never printed a newline was held whole in memory and handed to every rule at once.
// `carry` now keeps at most MAX_LINE characters -- the front of the line, where the
// timestamp and tag are -- and parseLine would cut it there anyway. What is dropped is
// counted in `state.carryDropped`, so a mangled log shows up as a number, not silence.
export function splitLines(buf, state = { carry: '' }) {
  const text = state.carry + buf;
  const parts = text.split('\n');
  state.carry = parts.pop() ?? '';
  if (state.carry.length > MAX_LINE) {
    state.carryDropped = (state.carryDropped ?? 0) + state.carry.length - MAX_LINE;
    state.carry = state.carry.slice(0, MAX_LINE);
  }
  const out = [];
  for (const p of parts) { const e = parseLine(p); if (e) out.push(e); }
  return out;
}
