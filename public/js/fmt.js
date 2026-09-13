// Display formatters. Units are decimal (1 KB = 1000 B) to match how the node
// itself prints sizes -- its log renders 4096 bytes as "4.0KB", so the monitor
// must not be the one place on the box that says 4.1 KB.
const U = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytes(n, dp = 1) {
  if (n == null || !Number.isFinite(n)) return '–';
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1000 && i < U.length - 1) { v /= 1000; i += 1; }
  return `${n < 0 ? '-' : ''}${v.toFixed(i === 0 ? 0 : dp)} ${U[i]}`;
}

export function rate(bps, unit = 'B/s') {
  if (bps == null || !Number.isFinite(bps)) return '–';
  let v = Math.abs(bps);
  let i = 0;
  while (v >= 1000 && i < U.length - 1) { v /= 1000; i += 1; }
  return `${(bps < 0 ? '-' : '')}${v.toFixed(i === 0 ? 0 : 1)} ${U[i]}/${unit === 'B/s' ? 's' : unit}`;
}

export function num(n, dp = 0) {
  if (n == null || !Number.isFinite(n)) return '–';
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pct(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return '–';
  return `${n.toFixed(dp)}%`;
}

// DD:HH:MM:SS, matching the node's own ETA and heartbeat format.
export function eta(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '–';
  const s = Math.floor(sec);
  const p = (x, w = 2) => String(x).padStart(w, '0');
  return `${p(Math.floor(s / 86400), 2)}:${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export function ago(ms, now = Date.now()) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
}

export function ageSec(sec) {
  if (sec == null || !Number.isFinite(sec)) return '–';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${(sec / 60).toFixed(1)}m`;
  if (sec < 172800) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export function sats(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  return n.toLocaleString('en-US');
}

export function btc(sat) {
  if (sat == null || !Number.isFinite(sat)) return '–';
  return (sat / 1e8).toFixed(8);
}

// Core reports feerates in BTC/kvB; operators think in sat/vB. Convert, and show
// the unit every time so nobody compares two numbers in different currencies.
export function satPerVb(btcPerKvB, dp = 2) {
  if (btcPerKvB == null || !Number.isFinite(btcPerKvB)) return '–';
  return (btcPerKvB * 1e8 / 1000).toFixed(dp);
}

// `n` is already in EH/s, so each step up is a THOUSAND of them: 1e3 EH/s is a zettahash and 1e6
// is a yottahash. Both labels were one prefix too low (2026-09-12) -- 1112 EH/s printed as
// "1.11 EH/s" -- which stayed hidden while the estimator that feeds this was itself out by 2^32
// and never produced a number above 1.
export function eh(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} YH/s`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} ZH/s`;
  return `${n.toFixed(1)} EH/s`;
}

export function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function short(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(1) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return (+n.toFixed(1)).toString();
  return (+n.toFixed(4)).toString();
}

export function hash(x, keep = 8) {
  if (!x || typeof x !== 'string') return '–';
  if (x.length <= keep * 2 + 3) return x;
  return `${x.slice(0, keep)}…${x.slice(-keep)}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};

export function uptime(ms) {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// THE ONE WARNING THE BANNER DOES NOT SHOW (operator, 2026-09-13, getting ready for release:
// "how do we get rid of the node warning?" -- "This is a pre-release test build - use at your
// own risk - do not use for mining or merchant applications").
//
// It is TRUE: a node built from source reports itself pre-release on every poll, which means a red
// caveat sits across the hero permanently and stops meaning anything. The fix is deliberately
// the narrowest one available -- this exact notice, matched on the phrase bitcoind has always
// used for it, and nothing else. "unknown new rules activated", a chain reorganisation, an
// unsupported chainstate: all still land in the banner, in red.
//
// WHERE THIS DOES NOT HAPPEN: the server. monitor.js and sync.js keep passing the node's exact
// words through, so /api/state still reports what the node said and the filter cannot become a
// way for the monitor to conceal it. This is a presentation choice, applied at the banner.
const PRE_RELEASE = /pre-release test build/i;

/** The node's warnings, minus the permanent pre-release notice. Never throws on odd input. */
export function nodeWarnings(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((w) => typeof w === 'string' && w.trim() && !PRE_RELEASE.test(w));
}
