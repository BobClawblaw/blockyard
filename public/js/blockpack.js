// SPDX-License-Identifier: Apache-2.0
//
// blockpack.js -- lays a block's transactions out as SQUARES on an integer
// grid, the look of mempool.space's block visualisation, implemented here
// from scratch.
//
// THE SCALE. One 1x1 grid unit stands for vbytesPerUnit() vbytes, chosen so a
// full block needs a little less than resolution x resolution units: the rest
// is headroom for rounding sides to whole units. A transaction's square has
// the side whose area is closest to its vsize in units, rounded a little
// generously (see sideFor), and never less than one unit.
//
// THE PACKING is first fit: each square goes to the lowest row where it fits,
// and within that row as far left as it fits. Transactions arrive richest
// first, so the richest settle on the lowest rows, and every small one drops
// into the lowest gap it fits -- including the gaps beside big squares -- so
// a real block packs densely.
//
// THE STABLE RE-PACK (packStable) lays a refresh out so that transactions
// already on the board keep their squares, and only what changed moves.

import { feeShade } from './feepalette.js';

// A full block needs this share of resolution^2 raw units.
const BLOCK_SHARE = 0.98;
// A square claims this much more area than its raw units. Most of a real
// block is transactions of 1.2-1.4 units that can only be drawn as ONE unit,
// so a block packed at exactly its raw units comes out well short of the
// grid (89% on a live block); scaling every square's area up by the same
// small factor gives that area back to the larger squares, keeping their
// sizes relative to each other exact. Measured on a live 3,051-transaction
// block (2026-09-11): at 96 units it packs 90 rows tall and 93.5% full, a
// 140 vB transaction is one unit at 96 and at 112 units, and a block of
// mid-sized transactions (200-6,200 vB) at 90% of the limit still packs
// inside a 40-unit grid.
const AREA_GAIN = 1.06;

export function vbytesPerUnit(blockLimit, resolution) {
  const units = Math.max(1, Number(resolution) || 1) ** 2 * BLOCK_SHARE;
  return Math.max(1e-9, Number(blockLimit) || 0) / units;
}

// the side whose square is nearest the transaction's (gained) area, in whole units
export function sideFor(vsize, vpu, gridWidth = Infinity) {
  const units = Math.max(0, Number(vsize) || 0) / Math.max(1e-12, Number(vpu) || 0);
  const side = Math.round(Math.sqrt(AREA_GAIN * units));
  return Math.max(1, Math.min(Math.floor(gridWidth) || 1, side));
}

// the vsize whose square is exactly `side` units: its root lands on the whole
// number itself, the middle of the band of sizes that round to it, so no
// float error can tip it into a neighbour
export function vsizeForSide(side, vpu) {
  const k = Math.max(1, Math.floor(Number(side)) || 1);
  return (Number(vpu) * k * k) / AREA_GAIN;
}

// AREA-TRUE SIDES FOR THE DETAILED VIEW (operator, 2026-09-11: "Our packer sucks compared to
// mempool space. How do we improve?"). Measured on the live block that day: 6,699 transactions,
// 80% of them 139-140 vB, at 96 units (110.7 vB a unit). A 140 vB transaction is 1.27 units and
// sideFor draws it as ONE, so the block as drawn was 82% of its true area -- a full block stopped
// 77 rows up a 96-row board, the rest bare grid. Whole-unit squares can only be area-true on
// average if some of them round up: a transaction of u units is drawn at floor(sqrt(u)) or one
// more, the larger with the probability that makes its expected area exactly u. The coin is a
// hash of the txid, so a transaction keeps its side on every refresh (a running error carry is
// area-exact too, but one newcomer early in the order would resize everything after it). No
// AREA_GAIN here: the areas are already true.
function unitHash(key) {
  let h = 0x9747b28c;                        // not feepalette's seed: size and shade stay independent
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;   // mix, so similar ids spread
  return (h >>> 0) / 4294967296;
}

export function ditheredSide(vsize, vpu, gridWidth = Infinity, key = '') {
  const units = Math.max(0, Number(vsize) || 0) / Math.max(1e-12, Number(vpu) || 0);
  const lo = Math.max(1, Math.floor(Math.sqrt(units)));
  const hi = lo + 1;
  const p = Math.min(1, Math.max(0, (units - lo * lo) / (hi * hi - lo * lo)));
  const s = key == null || key === '' ? Math.max(1, Math.round(Math.sqrt(units))) : (unitHash(String(key)) < p ? hi : lo);
  return Math.max(1, Math.min(Math.floor(gridWidth) || 1, s));
}

const idOf = (tx) => (tx && typeof tx === 'object' ? tx.txid : tx);

// ---------------------------------------------------------------------------
// The occupancy grid. Rows are unbounded upward: a square that does not fit
// below `height` is placed above it, so insert() always succeeds.
//
// For every cell the grid keeps `run`: how many free cells start there and
// continue to the right in the same row (0 for an occupied cell). A square of
// side s fits at (x, y) when run >= s at column x in each of its s rows, and
// a scan along a row can jump over a whole free run too short to use.
export class BlockLayout {
  constructor({ width, height } = {}) {
    this.width = Math.max(1, Math.floor(Number(width) || 1));
    this.height = Math.max(1, Math.floor(Number(height) || this.width));
    this.rows = 0;
    this.cap = 0;
    this.run = new Uint16Array(0);
    this.free = new Uint32Array(0);   // free cells per row
    this.floor = 0;                   // no free cell below this row
    this.top = 0;                     // one past the highest occupied row
    this.at = new Map();              // txid -> { x, y, s }
    this.grow(this.height);
  }

  grow(rows) {
    if (rows <= this.rows) return;
    const W = this.width;
    if (rows > this.cap) {
      const cap = Math.max(rows, this.cap * 2, 16);
      const run = new Uint16Array(cap * W);
      run.set(this.run.subarray(0, this.rows * W));
      const free = new Uint32Array(cap);
      free.set(this.free.subarray(0, this.rows));
      this.run = run; this.free = free; this.cap = cap;
    }
    for (let y = this.rows; y < rows; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) this.run[o + x] = W - x;
      this.free[y] = W;
    }
    this.rows = rows;
  }

  fits(x, y, s) {
    if (x < 0 || y < 0 || x + s > this.width) return false;
    const W = this.width;
    for (let yy = y; yy < y + s; yy++) {
      if (yy >= this.rows) return true;           // rows not yet made are empty
      if (this.run[yy * W + x] < s) return false;
    }
    return true;
  }

  fill(x, y, s, on) {
    const W = this.width;
    this.grow(y + s);
    for (let yy = y; yy < y + s; yy++) {
      const o = yy * W;
      if (on) {
        for (let xx = x; xx < x + s; xx++) this.run[o + xx] = 0;
        this.free[yy] -= s;
        // the free run ending at x is now shorter
        let n = 0;
        for (let xx = x - 1; xx >= 0 && this.run[o + xx] !== 0; xx--) this.run[o + xx] = ++n;
      } else {
        let n = x + s < W ? this.run[o + x + s] : 0;
        for (let xx = x + s - 1; xx >= 0; xx--) {
          if (xx < x && this.run[o + xx] === 0) break;
          this.run[o + xx] = ++n;
        }
        this.free[yy] += s;
      }
    }
    if (on) {
      this.top = Math.max(this.top, y + s);
      while (this.floor < this.rows && this.free[this.floor] === 0) this.floor++;
    } else {
      this.floor = Math.min(this.floor, y);
    }
  }

  // first fit: the lowest row, then the leftmost column, where s x s is free.
  //
  // TRIED AND REVERTED (2026-09-12): alternating the scan direction by row, to stop every row's
  // leftover space landing on the same side. It reads well in Detailed, where a tile is one unit
  // and the leftover is a cell or two -- and badly in Simple, where a row holds a few EQUAL pieces
  // and the wide leftover then sat at opposite ends on alternate rows: a staircase with stranded
  // columns ("why is packing messed up again"). The board's rightward lean is dealt with in the
  // FLIGHT instead (blockscene3d flightDir), which is where it came from.
  find(s) {
    const W = this.width;
    for (let y = this.floor; ; y++) {
      if (y >= this.rows) return { x: 0, y };
      if (this.free[y] < s) continue;
      const o = y * W;
      for (let x = 0; x + s <= W;) {
        const r = this.run[o + x];
        if (r < s) { x += r + 1; continue; }        // this free run is too short: skip it and the cell ending it
        let ok = true;
        for (let yy = y + 1; yy < y + s && yy < this.rows; yy++) {
          if (this.run[yy * W + x] < s) { ok = false; break; }
        }
        if (ok) return { x, y };
        x++;
      }
    }
  }

  insert(tx, side) {
    const s = Math.max(1, Math.min(this.width, Math.floor(Number(side)) || 1));
    const id = idOf(tx);
    if (this.at.has(id)) this.remove(tx);
    const { x, y } = this.find(s);
    this.fill(x, y, s, true);
    const pos = { x, y, s };
    this.at.set(id, pos);
    return { ...pos };
  }

  // occupy an explicit position; null (and nothing changes) when any of it is taken
  place(tx, x, y, side) {
    const s = Math.max(1, Math.floor(Number(side)) || 1);
    const id = idOf(tx);
    if (this.at.has(id)) this.remove(tx);
    if (!Number.isInteger(x) || !Number.isInteger(y) || !this.fits(x, y, s)) return null;
    this.fill(x, y, s, true);
    const pos = { x, y, s };
    this.at.set(id, pos);
    return { ...pos };
  }

  remove(tx) {
    const id = idOf(tx);
    const pos = this.at.get(id);
    if (!pos) return false;
    this.at.delete(id);
    this.fill(pos.x, pos.y, pos.s, false);
    if (pos.y + pos.s >= this.top) {
      let t = 0;
      for (const p of this.at.values()) t = Math.max(t, p.y + p.s);
      this.top = t;
    }
    return true;
  }

  positionOf(tx) {
    const p = this.at.get(idOf(tx));
    return p ? { ...p } : null;
  }
}

// ---------------------------------------------------------------------------

function prepare(txs, vpu, width, dither = false) {
  return (txs || []).map((tx) => {
    const vsize = Math.max(1, Number(tx?.vsize) || 0);
    const fee = Number(tx?.fee);
    const rate = Number.isFinite(fee) && fee > 0 ? fee / vsize : 0;
    return { txid: tx?.txid, vsize, rate, s: dither ? ditheredSide(vsize, vpu, width, tx?.txid ?? '') : sideFor(vsize, vpu, width) };
  });
}

const tileOf = (it, pos) => ({ txid: it.txid, x: pos.x, y: pos.y, s: pos.s, vsize: it.vsize, rate: it.rate, color: feeShade(it.rate, it.txid) });

export function packBlock(txs, { resolution = 80, blockLimit = 1000000, dither = false } = {}) {
  const width = Math.max(1, Math.floor(Number(resolution) || 80));
  const vpu = vbytesPerUnit(blockLimit, width);
  const layout = new BlockLayout({ width, height: width });
  const items = prepare(txs, vpu, width, dither);
  const tiles = new Array(items.length);
  let gridHeight = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pos = layout.insert(it.txid, it.s);
    tiles[i] = tileOf(it, pos, feeShade);
    if (pos.y + pos.s > gridHeight) gridHeight = pos.y + pos.s;
  }
  return { tiles, gridWidth: width, gridHeight, vbytesPerUnit: vpu };
}

// ---------------------------------------------------------------------------
// THE STABLE RE-PACK. `prev` is the board as drawn (tiles with txid, x, y, s);
// `txs` the next layout's transactions, richest first.
//
//  * A transaction on the previous board with the same side keeps its square.
//  * The tail's equal pieces are interchangeable (their ids name a slot, not a
//    transaction), so a piece takes any previous piece's slot of its size.
//  * Newcomers, and anything whose side changed, fill the free space first
//    fit, in the order given.
//  * When that leaves more off the board than a fresh pack would, the board
//    is re-packed above a line, `keptBelow`: survivors wholly below it stay
//    put and everything else is laid out again first fit. The line starts at
//    the top of the board and comes down only as far as it must, so what
//    moves is the cheap top of the board.
//
// Returns null when there is nothing to be stable against (an empty board)
// or when most of the block is new (a block was mined): the caller packs
// fresh. Otherwise { tiles, waiting, keptBelow }: the tiles that are on the
// board, in input order, and the vbytes that did not fit on it.

const SURVIVOR_SHARE = 0.5;      // below this share of the block's vbytes kept, pack fresh
const WAIT_ALLOWANCE = 0.01;     // may leave this share more waiting than a fresh pack

const isPiece = (id) => typeof id === 'string' && id.startsWith('aggregate');

export function packStable(prev, txs, opts = {}) {
  if (!Array.isArray(prev) || !prev.length || !Array.isArray(txs) || !txs.length) return null;
  const width = Math.max(1, Math.floor(Number(opts.resolution) || 80));
  const height = width;
  const vpu = vbytesPerUnit(opts.blockLimit ?? 1000000, width);
  const items = prepare(txs, vpu, width, !!opts.dither);

  // where each survivor was
  const was = new Map();
  const slots = new Map();         // side -> previous piece slots, lowest first
  for (const t of prev) {
    if (!t || !(t.s >= 1) || t.x < 0 || t.y < 0 || t.x + t.s > width || t.y + t.s > height) continue;
    if (isPiece(t.txid)) {
      if (!slots.has(t.s)) slots.set(t.s, []);
      slots.get(t.s).push(t);
    } else {
      was.set(t.txid, t);
    }
  }
  for (const list of slots.values()) list.sort((a, b) => a.y - b.y || a.x - b.x);
  let kept = 0, total = 0;
  const seen = new Set();
  for (const it of items) {
    total += it.vsize;
    if (seen.has(it.txid)) continue;           // a duplicated id keeps one square
    seen.add(it.txid);
    let w = isPiece(it.txid) ? slots.get(it.s)?.shift() : was.get(it.txid);
    if (w && w.s === it.s) { it.keep = w; kept += it.vsize; }
  }
  if (kept < total * SURVIVOR_SHARE) return null;

  const attempt = (line) => {
    const layout = new BlockLayout({ width, height });
    const pos = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const k = items[i].keep;
      if (k && k.y + k.s <= line) pos[i] = layout.place(i, k.x, k.y, k.s);
    }
    let waiting = 0;
    for (let i = 0; i < items.length; i++) {
      if (pos[i]) continue;
      const p = layout.insert(i, items[i].s);
      if (p.y + p.s > height) { layout.remove(i); waiting += items[i].vsize; pos[i] = null; } else pos[i] = p;
    }
    return { pos, waiting, keptBelow: line };
  };

  // what a fresh pack would leave off the board: the line never needs to go lower than that
  const fresh = attempt(0);
  const allowed = fresh.waiting + total * WAIT_ALLOWANCE + 1e-9;
  const step = Math.max(1, Math.round(height / 24));
  let best = fresh;
  for (let line = height; line > 0; line -= step) {
    const r = attempt(line);
    if (r.waiting <= allowed) { best = r; break; }
  }
  const tiles = [];
  for (let i = 0; i < items.length; i++) if (best.pos[i]) tiles.push(tileOf(items[i], best.pos[i], feeShade));
  return { tiles, waiting: best.waiting, keptBelow: best.keptBelow };
}

// ---------------------------------------------------------------------------
// THE EXACT FILL (operator, 2026-09-12: "Simple viewer mode is what I use as
// default. It needs to be fucking perfect", then "packer is still fucked up").
//
// The Simple board is one block's worth: a few hundred real transactions,
// richest first, and ONE summed tail standing for the thousands behind them.
// The old path cut the tail into equal squares of a side chosen in advance,
// packed everything, and when it overflowed shrank the scale 5% at a time until
// it happened to fit -- so the last row was partial BY CONSTRUCTION. Measured
// on the live pool: the top row 55% full, 92 cells stranded, a torn edge.
//
// This packs the other way round. The scale is SOLVED: one unit is chosen so
// that the real transactions' squares plus the tail's area come to exactly
// resolution x resolution. The real transactions go down first-fit as before.
// Then every cell still empty is tiled with the largest square that fits, no
// bigger than `cap` -- so the tail stays a field of small equal-looking pieces
// (a 14x14 tail piece beside a 1x1 transaction would claim to be 196x bigger,
// which it is not; it was tried and rejected for exactly that) and the board
// fills to the last cell. Measured on the live pool and three synthetic ones:
// 1936 of 1936 cells, a flush top row, every time.
//
// `plain`: [{ txid, vsize, rate }] richest first. `tail`: { vbytes, rateAt(frac) }
// where rateAt maps a share of the tail (0 = richest) to a feerate, or null.
export function packExact(plain, tail, { resolution = 44, cap = 3 } = {}) {
  const RES = Math.max(1, Math.floor(Number(resolution) || 44));
  const total = RES * RES;
  const items = (plain || []).map((c, i) => ({ txid: c.txid ?? `cell-${i}`, vsize: Math.max(1, Number(c.vsize) || 0), rate: Math.max(0, Number(c.rate) || 0) }));
  const tailVb = tail ? Math.max(0, Number(tail.vbytes) || 0) : 0;
  const realArea = (vpu) => items.reduce((a, c) => { const s = sideFor(c.vsize, vpu, RES); return a + s * s; }, 0);
  // both terms fall as vpu rises, so bisect for the vpu that fills the grid exactly
  let lo = 1, hi = 1e6;
  for (let i = 0; i < 64; i++) { const m = (lo + hi) / 2; if (realArea(m) + tailVb / m > total) lo = m; else hi = m; }
  let vpu = (lo + hi) / 2;

  // the real transactions, first-fit; if first fit cannot honour the solved area (it is a
  // heuristic, not a guarantee) the scale steps up a little and they are laid again
  let layout, tiles;
  for (let attempt = 0; attempt < 8; attempt++) {
    layout = new BlockLayout({ width: RES, height: RES });
    tiles = [];
    let overflow = false;
    for (const c of items) {
      const s = sideFor(c.vsize, vpu, RES);
      const pos = layout.insert(c.txid, s);
      if (pos.y + pos.s > RES) { overflow = true; break; }
      tiles.push({ txid: c.txid, x: pos.x, y: pos.y, s: pos.s, vsize: c.vsize, rate: c.rate, color: feeShade(c.rate, c.txid) });
    }
    if (!overflow) break;
    vpu *= 1.04;
  }

  // the remainder, tiled to the last cell: low-left first, the largest square up to `cap`
  const pieces = [];
  let k = 0;
  // BlockLayout.fits treats rows beyond the grid as empty (the layout grows), so the top edge
  // is this loop's to guard: a piece may not reach past row RES
  const room = (x, y, s) => y + s <= RES && layout.fits(x, y, s);
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      if (!room(x, y, 1)) continue;
      let s = 1;
      while (s + 1 <= cap && room(x, y, s + 1)) s++;
      const id = `aggregate-${k++}`;
      const pos = layout.place(id, x, y, s);
      if (pos) pieces.push({ ...pos, txid: id });
    }
  }
  // each piece stands for its share of the tail's vbytes, coloured richest-first by that share
  const pieceArea = pieces.reduce((a, p) => a + p.s * p.s, 0) || 1;
  let acc = 0;
  for (const p of pieces) {
    const vsize = tailVb * (p.s * p.s) / pieceArea;
    const frac = tailVb > 0 ? (acc + vsize / 2) / tailVb : 0;
    acc += vsize;
    const rate = tail && typeof tail.rateAt === 'function' ? Math.max(0, Number(tail.rateAt(frac)) || 0) : Math.max(0, Number(tail?.rate) || 0);
    tiles.push({ txid: p.txid, x: p.x, y: p.y, s: p.s, vsize, rate, color: feeShade(rate, p.txid) });
  }
  return { tiles, gridWidth: RES, gridHeight: RES, vbytesPerUnit: vpu, pieces: pieces.length };
}
