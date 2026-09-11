// The block packer: transactions as squares on an integer grid, area tracking
// vsize, laid out first fit from the bottom-left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vbytesPerUnit, sideFor, vsizeForSide, BlockLayout, packBlock } from '../public/js/blockpack.js';
import { feeShade } from '../public/js/feepalette.js';

function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}
// a block's worth shaped like a live one: mostly one-input one-output
// transactions, a tail of larger ones, now and then a very large one
function realistic(seed, limit = 1_000_000) {
  const r = rng(seed), out = [];
  let used = 0, i = 0;
  for (;;) {
    const p = r();
    const vsize = p < 0.8 ? 110 + Math.floor(r() * 140) : p < 0.95 ? 250 + Math.floor(r() * 750) : p < 0.99 ? 1000 + Math.floor(r() * 4000) : 5000 + Math.floor(r() * 60000);
    if (used + vsize > limit) break;
    out.push({ txid: `r${seed}-${i++}`, vsize, fee: vsize * (80 * (1 - used / limit) + r()) });
    used += vsize;
  }
  return out;
}
function randomPool(seed, n) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const vsize = r() < 0.9 ? Math.floor(60 + r() * 900) : Math.floor(1000 + r() * 90000);
    return { txid: `p${seed}-${i}`, vsize, fee: vsize * r() * 50 };
  });
}
function assertNoOverlap(tiles, width) {
  const H = tiles.reduce((m, t) => Math.max(m, t.y + t.s), 0);
  const occ = new Uint8Array(width * Math.max(1, H));
  for (const t of tiles) {
    assert.ok(Number.isInteger(t.x) && Number.isInteger(t.y) && Number.isInteger(t.s) && t.s >= 1, `${t.txid} sits on whole units`);
    assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.s <= width, `${t.txid} inside the grid width`);
    for (let y = t.y; y < t.y + t.s; y++) for (let x = t.x; x < t.x + t.s; x++) {
      assert.equal(occ[y * width + x], 0, `${t.txid} overlaps another square at ${x},${y}`);
      occ[y * width + x] = 1;
    }
  }
}

test('vbytesPerUnit: a full block needs a little less than the whole grid', () => {
  for (const res of [28, 40, 44, 64, 80, 96, 112]) {
    for (const limit of [1_000_000, 4_000_000 / 4 * 1.3, 250_000]) {
      const units = limit / vbytesPerUnit(limit, res);
      assert.ok(units > 0.9 * res * res && units < res * res, `${res} units, ${limit} vB: ${units.toFixed(0)} of ${res * res}`);
    }
  }
});

test('sideFor: whole units, at least one, never wider than the grid', () => {
  const vpu = vbytesPerUnit(1_000_000, 96);
  for (const v of [0, 1, 10, 60, 139, 140, 141, 500, 5000, 70000, 1e9, NaN, -5]) {
    const s = sideFor(v, vpu, 96);
    assert.ok(Number.isInteger(s) && s >= 1 && s <= 96, `${v} vB -> side ${s}`);
  }
  assert.equal(sideFor(1e12, vpu, 40), 40, 'a giant is clamped to the grid width');
  for (const v of [139, 140, 141]) assert.equal(sideFor(v, vpu, 96), 1, `${v} vB is one unit at 96 units`);
  assert.equal(sideFor(1, vpu, 96), 1);
});

test('sideFor: the area tracks vsize, so 16x the vsize is about 4x the side', () => {
  for (const [limit, res] of [[1_000_000, 96], [1_000_000, 44], [900_000, 40]]) {
    const vpu = vbytesPerUnit(limit, res);
    // from a few units up: below that, whole-unit rounding is most of the side
    for (const units of [4, 7, 9, 16, 20, 25, 40]) {
      const v = units * vpu;
      const ratio = sideFor(16 * v, vpu, 1e9) / sideFor(v, vpu, 1e9);
      assert.ok(ratio >= 3.5 && ratio <= 4.5, `${units} units: 16x the vsize is ${ratio.toFixed(2)}x the side`);
    }
    let last = 0;
    for (let v = 1; v < 400 * vpu; v *= 1.07) {
      const s = sideFor(v, vpu, 1e9);
      assert.ok(s >= last, 'a bigger transaction never gets a smaller square');
      last = s;
      if (v >= 9 * vpu) {
        const areaRatio = (s * s) / (v / vpu);
        assert.ok(areaRatio > 0.75 && areaRatio < 1.5, `area ${s * s} for ${(v / vpu).toFixed(1)} units`);
      }
    }
  }
});

test('vsizeForSide is the exact inverse: every k comes back as k', () => {
  for (const vpu of [vbytesPerUnit(1_000_000, 96), vbytesPerUnit(1_000_000 * 1.2763, 44), 0.7, 1, 108.33, 540.1, 9999.9]) {
    for (let k = 1; k <= 600; k++) {
      assert.equal(sideFor(vsizeForSide(k, vpu), vpu, 1e9), k, `vpu ${vpu}, k ${k}`);
    }
  }
});

test('BlockLayout: first fit, from the bottom row up and from the left', () => {
  const L = new BlockLayout({ width: 4, height: 4 });
  assert.deepEqual(L.insert({ txid: 'a' }, 2), { x: 0, y: 0, s: 2 });
  assert.deepEqual(L.insert({ txid: 'b' }, 1), { x: 2, y: 0, s: 1 });
  assert.deepEqual(L.insert({ txid: 'c' }, 1), { x: 3, y: 0, s: 1 });
  assert.deepEqual(L.insert({ txid: 'd' }, 2), { x: 2, y: 1, s: 2 }, 'the lowest row it fits in, beside the big one');
  assert.deepEqual(L.insert({ txid: 'e' }, 1), { x: 0, y: 2, s: 1 });
  assert.deepEqual(L.insert({ txid: 'f' }, 3), { x: 0, y: 3, s: 3 }, 'too wide for row 2 beside d: the next row that has room');
  assert.deepEqual(L.insert({ txid: 'g' }, 1), { x: 1, y: 2, s: 1 }, 'a small one drops into the gap left below');
});

test('BlockLayout: nothing fits below the height, so it keeps going up', () => {
  const L = new BlockLayout({ width: 2, height: 2 });
  assert.deepEqual([0, 1, 2].map((i) => L.insert({ txid: `t${i}` }, 2).y), [0, 2, 4]);
  assert.equal(L.insert({ txid: 'w' }, 9).s, 2, 'a square wider than the grid is clamped to it');
});

test('BlockLayout: remove frees exactly that square, and the same size reclaims the same slot', () => {
  const vpu = vbytesPerUnit(1_000_000, 64);
  const txs = randomPool(21, 500);
  const L = new BlockLayout({ width: 64, height: 64 });
  const at = new Map(txs.map((tx) => [tx.txid, L.insert(tx, sideFor(tx.vsize, vpu, 64))]));
  const r = rng(5);
  for (let n = 0; n < 40; n++) {
    const tx = txs[Math.floor(r() * txs.length)];
    const was = at.get(tx.txid);
    assert.equal(L.remove(tx), true);
    assert.equal(L.positionOf(tx), null);
    assert.deepEqual(L.insert(tx, was.s), was, `${tx.txid} comes back to ${was.x},${was.y}`);
  }
  assert.equal(L.remove({ txid: 'never-there' }), false);
});

test('BlockLayout: place occupies an explicit square and refuses a taken one', () => {
  const L = new BlockLayout({ width: 10, height: 10 });
  assert.deepEqual(L.place({ txid: 'a' }, 3, 4, 3), { x: 3, y: 4, s: 3 });
  assert.equal(L.place({ txid: 'b' }, 5, 6, 2), null, 'overlaps a');
  assert.equal(L.place({ txid: 'c' }, 9, 0, 2), null, 'past the right edge');
  assert.deepEqual(L.place({ txid: 'd' }, 6, 4, 2), { x: 6, y: 4, s: 2 }, 'right beside it is free');
  assert.deepEqual(L.insert({ txid: 'e' }, 4), { x: 0, y: 0, s: 4 }, 'below the placed squares is free');
  assert.deepEqual(L.insert({ txid: 'f' }, 4), { x: 4, y: 0, s: 4 }, 'x 4..7, rows 0..3: clear of a and d');
  assert.deepEqual(L.insert({ txid: 'g' }, 3), { x: 0, y: 4, s: 3 }, 'the 3-wide gap left of a');
  assert.deepEqual(L.insert({ txid: 'h' }, 2), { x: 8, y: 0, s: 2 }, 'the strip at the right edge');
});

test('packBlock: one tile per transaction, in input order, carrying vsize, rate and colour', () => {
  const txs = [
    { txid: 'a', vsize: 250, fee: 5000 },
    { txid: 'b', vsize: '400', fee: 400 },
    { txid: 'c', vsize: 0, fee: 3 },
    { txid: 'd', vsize: 900 },
    { txid: 'e', vsize: 300, fee: NaN },
  ];
  const p = packBlock(txs, { resolution: 30, blockLimit: 100_000 });
  assert.equal(p.gridWidth, 30);
  assert.equal(p.vbytesPerUnit, vbytesPerUnit(100_000, 30));
  assert.deepEqual(p.tiles.map((t) => t.txid), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(p.tiles.map((t) => t.vsize), [250, 400, 1, 900, 300], 'vsize is a number, at least 1');
  assert.deepEqual(p.tiles.map((t) => t.rate), [20, 1, 3, 0, 0], 'fee / vsize, 0 when the fee is unknown');
  for (const t of p.tiles) {
    assert.equal(t.color, feeShade(t.rate, t.txid), 'the colour is the rate\'s shade for this txid');
    assert.equal(t.s, sideFor(t.vsize, p.vbytesPerUnit, 30));
  }
  assert.equal(p.gridHeight, Math.max(...p.tiles.map((t) => t.y + t.s)));
  assert.deepEqual(packBlock([], {}), { tiles: [], gridWidth: 80, gridHeight: 0, vbytesPerUnit: vbytesPerUnit(1_000_000, 80) }, 'defaults: 80 units, 1 MvB');
});

test('packBlock: random pools never overlap and stay inside the grid width', () => {
  for (const [seed, n, res] of [[1, 50, 20], [2, 400, 44], [3, 1500, 64], [4, 3000, 96], [5, 800, 28], [6, 200, 112]]) {
    const p = packBlock(randomPool(seed, n), { resolution: res });
    assert.equal(p.tiles.length, n);
    assertNoOverlap(p.tiles, res);
  }
});

test('packBlock: the richest settle lowest', () => {
  const txs = realistic(7).sort((a, b) => b.fee / b.vsize - a.fee / a.vsize);
  const { tiles } = packBlock(txs, { resolution: 96 });
  const q = Math.floor(tiles.length / 4);
  const meanY = (ts) => ts.reduce((a, t) => a + t.y, 0) / ts.length;
  assert.ok(meanY(tiles.slice(0, q)) < meanY(tiles.slice(-q)) / 2, 'the richest quarter sits far below the cheapest');
});

// the live block's shape (2026-09-11: 3,051 transactions, 2,705 of them 139-141 vB,
// a few dozen at 66 vB, a spread of a few hundred vB, and a dozen very large ones)
function liveShaped() {
  const r = rng(77), out = [];
  const add = (n, lo, hi) => { for (let i = 0; i < n; i++) out.push(lo + Math.floor(r() * (hi - lo + 1))); };
  add(2705, 139, 141); add(34, 66, 66); add(200, 150, 500); add(60, 500, 3000); add(12, 3000, 72000);
  // shuffle, then take one block's worth, richest first
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  const txs = [];
  let used = 0;
  for (const vsize of out) { if (used + vsize > 1_000_000) continue; txs.push({ txid: `l${txs.length}`, vsize, fee: vsize * (13 - 12.6 * used / 1_000_000) }); used += vsize; }
  return txs;
}

test('packBlock: a realistic block packs densely, small squares filling the gaps beside big ones', () => {
  // (a block whose very large transaction arrives last can leave a ragged top for any
  // first-fit packing -- realistic(12) covers 89% of its rows -- so these are blocks
  // whose largest squares arrive among the rest, as they usually do)
  const live = packBlock(liveShaped(), { resolution: 96, blockLimit: 1_000_000 });
  const liveArea = live.tiles.reduce((a, t) => a + t.s * t.s, 0);
  assertNoOverlap(live.tiles, 96);
  assert.ok(live.gridHeight <= 96, `the live-shaped block fits the square grid at full scale (${live.gridHeight} rows)`);
  assert.ok(liveArea / 96 ** 2 >= 0.9, `and fills it (${(100 * liveArea / 96 ** 2).toFixed(1)}%)`);
  assert.ok(live.tiles.filter((t) => t.s === 1).length / live.tiles.length >= 0.9, 'a typical transaction is one unit');
  for (const seed of [11, 13]) {
    const txs = realistic(seed);
    const p = packBlock(txs, { resolution: 96, blockLimit: 1_000_000 });
    const area = p.tiles.reduce((a, t) => a + t.s * t.s, 0);
    assertNoOverlap(p.tiles, 96);
    // density: of the rows the block uses, how much is covered. (Whether a
    // block fits the square at full scale depends on its shape -- this one
    // has a very large transaction every hundred -- and is the renderer's
    // fit loop's business; the live-shaped block in viewer-modes checks it.)
    assert.ok(area / (96 * p.gridHeight) >= 0.9, `seed ${seed}: ${(100 * area / (96 * p.gridHeight)).toFixed(1)}% of the rows used is covered`);
    assert.ok(p.tiles.filter((t) => t.s === 1).length / p.tiles.length > 0.5, 'most transactions are one unit');
  }
});

test('packBlock: a whole block of 3,000 transactions packs in well under a frame budget', () => {
  const txs = realistic(31);
  packBlock(txs, { resolution: 96 });            // warm up
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) packBlock(txs, { resolution: 96 });
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 100, `${ms.toFixed(1)} ms per pack`);
});
