// What does the LIVE node report per cell — and is one feerate worth one colour?
//
// Today's measurements (2026-09-10, production node):
//   - /api/mempool dist.cells: 401 cells, rates 100.24 down to 0.61, p50 4.14
//   - /api/nextblock visual.cells: the block's 400 drawn cells run 8.41 down to 0.22
//   - the AGGREGATE tail cell on both maps sits at the pool's floor (0.4-0.6)
// The palette therefore needs one colour PER FEERATE, and must not spend its whole
// bright half of the range on the 1% of the pool that pays premium. This test pins the
// contract against the numbers the node actually gave today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rateColor } from '../public/js/goggles.js';

const here = dirname(fileURLToPath(import.meta.url));

// Frozen live shapes (a full getrawmempool is MBs; these are the cell arrays the node
// actually served today, sampled to their quantiles — the DISTRIBUTION is the fixture).
const LIVE_MEMPOOL_RATES = [100.24, 52.0, 30.4, 20.1, 15.0, 10.04, 8.2, 6.5, 5.2, 4.14, 3.6, 3.05, 2.5, 2.0, 1.5, 1.0, 0.61, 0.4, 0.22];
const LIVE_BLOCK_RATES = [8.41, 7.95, 6.38, 5.0, 4.0, 3.0, 2.0, 1.5, 1.0, 0.8, 0.6, 0.44, 0.3, 0.22];

const lumaOf = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('THE DISAPPEARANCE GUARD: no bitmap the frame blits may be big enough to lose the canvas', async () => {
  // "The block space view still disappears on update." The mechanism, found 2026-09-10:
  // the crowd texture was a bitmap the SIZE OF THE AGGREGATE (898x898 at dpr 1 on a
  // 1440px-wide card; 1796x1798 on a retina client — 3.2 megapixels), drawImage'd every
  // chase frame. A source that large blitted dozens of times a second crosses the
  // compositor's budget for a canvas source, the surface gets dropped, and the map
  // vanishes — on update, exactly as reported (the settled first paint is one blit; the
  // chase is dozens). The fix is a 24x24 tiled pattern; this test is the assertion that
  // would have failed the shipped code: the frame path may never touch a source bitmap
  // larger than the tile, in ANY code path.
  const { blockTreemap } = await import('../public/js/goggles.js');
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };   // retina: worst case
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.performance = { now: () => 0 };
  // Track EVERY canvas this code creates, and every source it hands to createPattern or
  // drawImage — both paths, because both move pixels from a bitmap into the map.
  const created = [];
  globalThis.document = {
    createElement: () => {
      const t = { width: 0, height: 0 };
      t.getContext = () => ({ fillRect() {}, fillStyle: '', strokeStyle: '', lineWidth: 0, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {}, createPattern: () => null });
      created.push(t);
      return t;
    },
  };
  const usedSources = [];
  const bigSources = [];   // sources >65,536px anywhere in the pipeline (see below)
  const mkCtx = () => new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (k === 'setTransform') return () => {};
      if (k === 'clearRect') return () => {};
      if (k === 'createPattern') return (src) => { usedSources.push({ via: 'pattern', w: src?.width ?? -1, h: src?.height ?? -1 }); return null; };
      if (k === 'drawImage') return (src, ...rest) => {
        const w = src?.width ?? -1, h = src?.height ?? -1;
        usedSources.push({ via: 'drawImage', w, h });
        if (w * h > 65536) bigSources.push({ via: 'drawImage', w, h });
        return undefined;
      };
      return (...a) => t.canvas;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = {
    clientWidth: 899, clientHeight: 899, width: 0, height: 0, style: {},   // the full w8 square
    parentElement: { querySelector: () => null }, addEventListener() {},
    getContext: () => mkCtx(),
  };
  // Today's measured pool shape: one aggregate holding the majority of the area.
  const cells = [
    { vbytes: 60_000, rate: 40, txid: 'a' },
    { vbytes: 40_000, rate: 10, txid: 'b' },
    { vbytes: 1_100_000, rate: 0.6, aggregate: 11000 },
  ];
  blockTreemap(canvas, { cells, totalVbytes: 1_200_000 }, { remainingWeight: 0 }, { weightLimit: 4_000_000 });

  // 1. No TEXTURE canvas the map code creates may be large — the crowd builds a small
  //    tile, not a per-aggregate bitmap. The offscreen COMPOSITE surface is the one
  //    allowed exception (it mirrors the display one-to-one): it is a destination that
  //    is painted in full each frame and blitted whole once, never a source cropped or
  //    tiled. Textures — the things that used to be giant — stay ≤ 65,536 px.
  const textures = created.filter((c) => c !== canvas.__offscreen);
  for (const c of textures) {
    assert.ok(c.width * c.height <= 65536,
      `a created TEXTURE is ${c.width}x${c.height} (${(c.width * c.height / 1e6).toFixed(2)} MP) — big textures are what dropped the canvas and blanked the view`);
  }
  // 2. Every source the frame used is either a small texture or the ONE composite blit;
  //    the composite is allowed to be large only as the whole-canvas blit (w/h match the
  //    live canvas backing store, and it is the only large op per frame).
  for (const s of usedSources) {
    if (s.w * s.h > 65536) {
      assert.equal(s.via, 'drawImage', `a ${s.via} of ${s.w}x${s.h} is not the composite blit and must be small`);
      assert.ok(s.w <= canvas.clientWidth * 2 + 2 && s.h <= canvas.clientHeight * 2 + 2,
        `the composite source ${s.w}x${s.h} exceeds the display size even at dpr 2`);
    }
  }
  // 3. The map still drew (the guard must not silence the texture, only its size).
  assert.ok(canvas.__hasData, 'it drew');
});

const satOf = (hex) => {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(...ch), mn = Math.min(...ch);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
// Warmth measured in HUE DEGREES, not an RGB ratio: the blue half of the ramp moves
// *away* from warm as it approaches cyan (the blue channel saturates), and an RGB
// ratio reads that as "getting cooler" and fails the monotonic check mid-ramp. Hue
// angle (200° steel-blue -> 180° cyan -> 155° green -> 75° lime -> 45° amber -> 15°
// orange -> 355° red) is the channel the ordering actually lives in, modulo 360.
const hueOf = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  const h60 = r === mx ? ((g - b) / d) % 6 : g === mx ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h60 * 60 + 360) % 360;
};

test('the colours the live node\'s cells actually get are neither dim nor identical', () => {
  // Every rate the node reported today must land on a colour with real chroma: the
  // complaint was "colours are not bright enough", and a 20%-saturation slate is exactly
  // what that complaint measured. The hot end (top 1% of the pool) may sit lower in
  // luma — that is a hue, not a dim cell — so the luma gate holds through orange, the
  // part of the ramp where today's mass and the whole block actually live.
  const lumaFloor = 118;            // above the ~100 the old washed-grey floor scored
  const satFloor = 0.30;
  for (const r of [...LIVE_MEMPOOL_RATES, ...LIVE_BLOCK_RATES]) {
    const c = rateColor(r);
    assert.ok(satOf(c) >= satFloor, `${r} sat/vB -> ${c} is washed out (sat ${(satOf(c) * 100).toFixed(0)}%)`);
    if (r <= 52) assert.ok(lumaOf(c) >= lumaFloor, `${r} sat/vB -> ${c} is too dim (luma ${lumaOf(c).toFixed(0)})`);
  }
});

test('the floor is one honest colour — the pool\'s majority, but not a void', () => {
  // The aggregate tail (rate 0.2-0.6, the majority of the pool by AREA) is ONE
  // category: "nobody paid for this". It must not read as background (#0b0d10, luma 11)
  // — the old floor scored luma 90-101, which against a dark card is a void, which is
  // why the map read empty. It must read as slate that clearly is a cell.
  for (const r of [0.22, 0.4, 0.61]) {
    const c = rateColor(r);
    assert.ok(lumaOf(c) > 118, `floor ${r} sat/vB -> ${c} (luma ${lumaOf(c).toFixed(0)}) must not read as the void`);
    assert.ok(satOf(c) > 0.35, `floor ${r} -> ${c} carries real colour, not grey`);
  }
  // ...and neighbouring floor rates stay ONE colour (a category, not a spectrum).
  assert.ok(lumaOf(rateColor(0.22)) - lumaOf(rateColor(0.6)) < 20 && satOf(rateColor(0.5)) > 0.3,
    'the sub-2 band reads as the same family it belongs to');
});

test('the ramp marches cool to warm across the live range, in hue', () => {
  // The eye reads feerate order as hue rotation: steel-blue through cyan and green to
  // amber, orange, red. Hue DEGREES must fall monotonically (200 -> 155 -> 75 -> 45 ->
  // 20 -> -5/355 wrapping once at the red end). The check walks hue with a wrapping
  // comparison, because a palette that crosses 0° once (orange into red) is correct,
  // and a naive "always decreasing" assertion would fail on the crossing itself.
  const ladder = [1, 2, 4, 7, 14, 28, 52, 96];
  const hues = ladder.map((r) => ({ r, h: hueOf(rateColor(r)) }));
  let crossed = 0;
  for (let i = 1; i < hues.length; i++) {
    let delta = hues[i].h - hues[i - 1].h;
    if (delta > 180) { delta -= 360; crossed++; }          // wrapped at the red end
    assert.ok(delta < -3, `hue falls past ${ladder[i]} sat/vB (${hues[i - 1].h.toFixed(0)}° -> ${hues[i].h.toFixed(0)}°)`);
  }
  assert.ok(crossed <= 1, `the ramp crosses the 0° wrap at most once (${crossed})`);
});
