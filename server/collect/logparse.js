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
  {
    name: 'blockStored',
    re: /\[block\]\s*stored\s+height=(\d+)\s+hash=([0-9a-f.]+)\s+bytes=(\d+)\s+tx=(\d+)(?:\s*\(via\s*([^\s)][^)]*)\))?/,
    apply(m) {
      const via = addrParts(m[5]);
      return { kind: 'block_stored', height: +m[1], hashPrefix: m[2].replace(/\.$/, ''), bytes: +m[3], txs: +m[4], via: via?.addr ?? null, viaHost: via?.host ?? null };
    },
  },
  // [mempool] block 965993: removed 175 pool tx (confirmed/conflicted)
  { name: 'mempoolBlock', re: /\[mempool\]\s*block\s*(\d+):\s*removed\s*(\d+)\s*pool tx/, apply: (m) => ({ kind: 'mempool_block_drain', height: +m[1], removed: +m[2] }) },
  // [tx_accept] last 30s: +77 accepted (mempool 4033) | rejected: 333 missing-inputs, 0 invalid, 18 policy | 0 already confirmed
  {
    name: 'txAccept',
    re: /\[tx_accept\]\s*last\s*(\d+)s:\s*\+(\d+)\s*accepted\s*\(mempool\s*(\d+)\)\s*\|\s*rejected:\s*(\d+)\s*missing-inputs,\s*(\d+)\s*invalid,\s*(\d+)\s*policy\s*\|\s*(\d+)\s*already confirmed/,
    apply(m) {
      return {
        kind: 'tx_accept', windowSec: +m[1], accepted: +m[2], mempool: +m[3],
        rejectMissingInputs: +m[4], rejectInvalid: +m[5], rejectPolicy: +m[6], alreadyConfirmed: +m[7],
        acceptRate: +(+m[2] / Math.max(1, +m[1])).toFixed(2),
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
  { name: 'legDown', re: /\[mux:(\d+)\]\s*next peer\s*(\S+)\s+unreachable:(.+?)\(leg stays down\)/, apply: (m) => ({ kind: 'peer_unreachable', leg: +m[1], addr: m[2], host: addrParts(m[2])?.host, reason: m[3].trim() }) },
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
    re: /\[dl\]\s*(outbound|inbound)\s*(\d+)\s*=\s*(\S+?)\s*\(fd\s*(\d+)\)\s*proto=(\d+)\s*services=(\S+?)\s*ua="([^"]*)"\s*height=(\d+)(?:\s+addrv2=(\d))?/,
    apply(m) {
      const a = addrParts(m[3]);
      return {
        kind: 'peer_identify', direction: m[1], index: +m[2],
        addr: a?.addr ?? m[3], host: a?.host ?? m[3], fd: +m[4], proto: +m[5],
        services: m[6], userAgent: m[7], peerHeight: +m[8], addrv2: m[9] == null ? null : m[9] === '1',
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
  // parsed so the ratio means something again, and so book growth is a figure.
  { name: 'addrGossip', re: /\[txrelay\]\s*addrv2 gossip:\s*\+(\d+)\s*address\(es\)\s*to the book/, apply: (m) => ({ kind: 'addr_gossip', added: +m[1] }) },
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
    re: /\[dial\]\s*memory:\s*(\d+) address\(es\) remembered, (\d+) candidate\(s\) skipped under backoff; blocks:\s*(\d+) claimed, (\d+) duplicate fetch\(es\) avoided/,
    apply: (m) => ({ kind: 'dial_memory', remembered: +m[1], skippedBackoff: +m[2], blocksClaimed: +m[3], duplicateFetchesAvoided: +m[4] }),
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
    re: /\[coinstats[-_]hist\]\s*pass(\d+)(?:\s+w(\d+))? (\d+)\/(\d+) \((\d+(?:\.\d+)?)s\)/,
    apply: (m) => ({ kind: 'coinstats_hist_pass', pass: +m[1], worker: m[2] == null ? null : +m[2], done: +m[3], of: +m[4], secs: +m[5] }),
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
    re: /\[boot\]\s*logging to (\S+) \((\w+)\)$/,
    apply: (m) => ({ kind: 'boot_start', logFile: m[1], via: m[2] }),
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
];

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
export const SHAPES = [
  { shape: 'bandwidth rate', rules: ['bandwidthTick', 'bandwidthTickFields'], gateMs: 600_000, ibdOnly: true },
  { shape: 'download progress', rules: ['dlcProgressFields'], gateMs: 600_000, ibdOnly: true },
  { shape: 'heartbeat', rules: ['heartbeat'], gateMs: 1_200_000 },
  { shape: 'relay legs', rules: ['txRelay', 'txRelayBare'], gateMs: 960_000 },
  { shape: 'accepts and rejects', rules: ['txAccept'], gateMs: 720_000 },
  { shape: 'orphans', rules: ['orphans'], gateMs: 1_200_000 },
  { shape: 'address gossip', rules: ['addrGossip'], gateMs: 720_000 },
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

  let tag = null;
  const tagm = rest.match(TAG_RE);
  if (tagm) { tag = tagm[0].replace(/[\[\]\s]/g, ''); rest = rest.slice(tagm[0].length); }
  const tagBase = tag ? tag.split(':')[0] : null;

  for (const rule of RULES) {
    const m = rest.match(rule.re) ?? trimmed.match(rule.re);
    if (m) {
      const out = rule.apply(m);
      if (out) {
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
    }
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
