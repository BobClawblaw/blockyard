// Fixed-capacity time-ordered store with on-read downsampling.
//
// Charts ask "give me 6 hours at ~200 pixels", which is a bucketed aggregate,
// not a raw walk. Doing that here means the browser receives a few hundred
// numbers per series instead of 20k, on every SSE refresh.
export class Ring {
  constructor(capacity = 20000) {
    this.capacity = capacity;
    this.rows = [];
  }

  push(row) {
    if (row == null || !Number.isFinite(row.t)) return;
    // SORTED, NOT MERELY APPENDED. `since`, `series` and `pruneBefore` binary-search
    // the rows, which is only right while they are in time order. Most rings are
    // stamped with the collection time and do only ever move forward, but the
    // `blocks` ring is stamped with each block's own time and is shared by every
    // node: a node in initial sync writes blocks from a year ago after another
    // node's current ones, and the restart backfill writes blocks from hours ago
    // after rows already there. Appended, that unsorted tail sent the search to
    // the end, so the 30-second prune deleted the whole ring -- every node's
    // block charts blank (operator, 2026-09-18: "Why is this info blank when BMC
    // has everything it needs at 100% sync?"). A late row now goes where its time
    // puts it: after any row with the same t, so equal times keep arrival order.
    const last = this.rows[this.rows.length - 1];
    if (!last || row.t >= last.t) this.rows.push(row);
    else this.rows.splice(upperBound(this.rows, row.t), 0, row);
    if (this.rows.length > this.capacity) this.rows.splice(0, this.rows.length - this.capacity);
  }

  get length() { return this.rows.length; }
  first() { return this.rows[0] ?? null; }
  last() { return this.rows[this.rows.length - 1] ?? null; }

  pruneBefore(cutoffMs) {
    const i = lowerBound(this.rows, cutoffMs);
    if (i > 0) this.rows.splice(0, i);
  }

  since(t) {
    const i = lowerBound(this.rows, t);
    return this.rows.slice(i);
  }

  tail(n) { return this.rows.slice(Math.max(0, this.rows.length - n)); }

  // Rows written before per-node tagging existed. Reported rather than silently
  // dropped or silently attributed.
  unattributed() { return this.rows.reduce((n, r) => n + (r.node == null ? 1 : 0), 0); }

  nodes() {
    const seen = [];
    for (const r of this.rows) if (r.node != null && !seen.includes(r.node)) seen.push(r.node);
    return seen;
  }

  // Bucketed single-field aggregate for a chart series.
  //
  // `node` matters because one ring per series is shared by every configured node.
  // Measured with two live nodes on 2026-09-08: the `peers` ring held 2,308 rows
  // from production interleaved with 1,816 from the bench node, and no row said
  // which. Drawn as one line, that is a chart of an average of two daemons, which
  // is not a fact about either. Rows written before the tagging exist and have no
  // node: they are excluded from a node-filtered read, because guessing their owner
  // would put bench traffic on a production chart. They still count in `stats()`
  // with no filter, and in `unattributed()` so the number is visible.
  series(field, { since: from, bucketMs = 0, agg = 'last', node = null } = {}) {
    const rows = pick(this.rows, from, node);
    if (!bucketMs) return rows.map((r) => ({ t: r.t, v: r[field] })).filter((p) => p.v != null);
    const out = [];
    let bucket = null;
    const acc = { n: 0, sum: 0, min: Infinity, max: -Infinity, last: null, first: null, prev: null };
    const flush = () => {
      if (bucket == null) return;
      out.push({ t: bucket + bucketMs, v: aggregate(agg, acc) });
      acc.n = 0; acc.sum = 0; acc.min = Infinity; acc.max = -Infinity; acc.last = null; acc.first = null; acc.prev = null;
    };
    for (const r of rows) {
      const v = r[field];
      const b = Math.floor(r.t / bucketMs) * bucketMs;
      if (bucket === null) bucket = b;
      if (b !== bucket) { flush(); bucket = b; }
      if (v == null || Number.isNaN(v)) continue;
      if (acc.n === 0) acc.first = v;
      if (agg === 'delta') {
        if (acc.n > 0) { acc.sum += Math.max(0, v - acc.last); }
        acc.prev = acc.last;
      }
      acc.n += 1; acc.sum += v; acc.min = Math.min(acc.min, v); acc.max = Math.max(acc.max, v); acc.last = v;
    }
    flush();
    return out.filter((p) => p.v != null);
  }

  stats(field, { since: from, node = null } = {}) {
    const rows = pick(this.rows, from, node);
    const acc = { n: 0, sum: 0, min: Infinity, max: -Infinity, last: null, first: null, prev: null };
    for (const r of rows) {
      const v = r[field];
      if (v == null || Number.isNaN(v)) continue;
      if (acc.n === 0) acc.first = v;
      if (acc.n > 0) acc.sum += Math.max(0, v - acc.last);
      acc.n += 1;
      acc.min = Math.min(acc.min, v); acc.max = Math.max(acc.max, v); acc.last = v;
    }
    if (!acc.n) return null;
    return {
      n: acc.n, first: acc.first, last: acc.last, min: acc.min, max: acc.max,
      avg: acc.sum / acc.n, spread: acc.max - acc.min,
      // A counter's growth per bucket, not its level.
      growth: acc.n > 1 ? acc.sum : 0,
    };
  }

  toJSON() { return { capacity: this.capacity, rows: this.rows }; }
  static fromJSON(o, capacity) {
    const r = new Ring(capacity ?? o?.capacity ?? 20000);
    // a file saved before push kept rows in order may not be sorted: sort once on load
    // (stable, so equal times keep their order), then keep the newest `capacity`
    if (o?.rows) r.rows = o.rows.filter((x) => x && Number.isFinite(x.t)).sort((a, b) => a.t - b.t).slice(-1 * (capacity ?? o.capacity ?? 20000));
    return r;
  }
}

function aggregate(kind, acc) {
  if (!acc.n) return null;
  switch (kind) {
    case 'avg': return acc.sum / acc.n;
    case 'min': return acc.min;
    case 'max': return acc.max;
    case 'sum': return acc.sum;
    case 'first': return acc.first;
    case 'delta': return acc.sum; // sum of positive inter-sample steps in the bucket
    case 'last':
    default: return acc.last;
  }
}


// the first row with a time after t: where a row at t goes to keep equal times in arrival order
export function upperBound(rows, t) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function lowerBound(rows, t) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Time slice, then optional owner filter. The filter runs after the binary search
// so the cheap part stays cheap; a node-filtered walk is O(rows-since) which is
// bounded by the ring capacity either way.
function pick(rows, from, node) {
  let out = from ? rows.slice(lowerBound(rows, from)) : rows;
  if (node != null) out = out.filter((r) => r.node === node);
  return out;
}

// A sliding window that also answers "per second over the window", which is how
// every counter in this system (bytes, tx counts, txouts) becomes a rate.
export class CounterRate {
  constructor(windowMs = 120000) {
    this.windowMs = windowMs;
    this.samples = [];
  }
  add(value, t = Date.now()) {
    if (value == null || !Number.isFinite(value)) return null;
    this.samples.push({ t, value });
    const cutoff = t - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].t < cutoff) this.samples.shift();
    if (this.samples.length > 2000) this.samples.splice(0, this.samples.length - 2000);
    // A counter reset (node restart zeroes it) must not read as a negative rate
    // nor as a colossal one; treat a decrease as a fresh baseline.
    if (value < this.samples[0].value) { this.samples = [{ t, value }]; return 0; }
    return this.rate();
  }

  // Current rate without pushing a sample, so a read model can ask for the rate
  // at snapshot time.
  rate() {
    if (this.samples.length < 2) return null;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return null;
    return (b.value - a.value) / dt;
  }

  get span() { return this.samples.length >= 2 ? this.samples[this.samples.length - 1].t - this.samples[0].t : 0; }
}
