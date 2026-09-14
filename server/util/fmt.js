// Server-side formatting. Deliberately small: the browser has its own copy of
// the display rules (public/js/fmt.js) and the two must not drift in the
// one place that matters -- the ETA shape, which this project already prints as
// DD:HH:MM:SS in its own status line.

// DD:HH:MM:SS, as used by the node's downloader ETA and its heartbeat `uptime`.
export function formatEta(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(d, 2)}:${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)}`;
}

function pad(n, w) { return String(n).padStart(w, '0'); }

// Decimal units, matching how the node prints sizes ("4.0KB" for 4096 bytes).
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function formatBytes(n, dp = 1) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i += 1; }
  return `${(n < 0 ? '-' : '')}${v.toFixed(i === 0 ? 0 : dp)} ${UNITS[i]}`;
}


