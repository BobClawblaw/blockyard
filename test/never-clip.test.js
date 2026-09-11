import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blockTreemap } from '../public/js/goggles.js';

test('the map never depends on clip or globalAlpha — the software-rasteriser trap that blanked it', async () => {
  // "The block space view disappears after the first update", on the operator's browser
  // AND this headless box. Root cause (proven by the direct-vs-composite A/B and by
  // per-primitive probes): software rasterisers (headless swiftshader, and the same
  // fallback a VM or blocklisted-GPU browser hits) silently DROP fills drawn through a
  // ctx.clip(), and honour ctx.globalAlpha inconsistently on texture/pattern fills.
  // The map's cells sat inside a frontier clip; its line and legend did not — hence
  // "line and legend painted, everything else blank". The map must therefore paint with
  // NO clip and NO globalAlpha: the frontier is enforced by repaint ORDER (the unfilled
  // band paints over the cell loop), and arrival fades ride on rgba() in fill colours.
  //
  // This test drives the REAL draw path (blockTreemap: full pool snapshot + chase
  // frames + a partly-filled band snapshot, dpr 2) through a recording context over
  // the whole canvas graph the map builds, and fails if the forbidden vocabulary ever
  // appears — the guard that would have caught every version of this bug.
  let rafPending = null;
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  globalThis.performance = { now: () => 0 };

  const createdCanvases = [];
  const ctxFor = (sink) => new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'createPattern') return (src) => { sink.push(`createPattern(${src?.width}x${src?.height})`); return { __pattern: true }; };
      if (k === 'drawImage') return (src, ...rest) => { sink.push(`drawImage(${src?.width}x${src?.height})`); return undefined; };
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return (...a) => { sink.push(String(k)); return t.canvas; };
    },
    set(t, k, v) { sink.push('set:' + k + '=' + String(v).slice(0, 14)); t[k] = v; return true; },
  });
  globalThis.document = {
    createElement: () => {
      const t = { width: 0, height: 0 };
      t.__ops = [];
      t.getContext = () => ctxFor(t.__ops);
      createdCanvases.push(t);
      return t;
    },
  };

  const liveOps = [];
  const liveCanvas = {
    clientWidth: 899, clientHeight: 899, width: 0, height: 0, style: {},
    parentElement: { querySelector: () => null }, addEventListener() {},
    getContext: () => ctxFor(liveOps),
  };

  const cells = [
    { vbytes: 60_000, rate: 40, txid: 'a' },
    { vbytes: 40_000, rate: 10, txid: 'b' },
    { vbytes: 1_100_000, rate: 0.6, aggregate: 11000 },
  ];
  blockTreemap(liveCanvas, { cells, totalVbytes: 1_200_000 }, { remainingWeight: 0 }, { weightLimit: 4_000_000 });
  let guard = 0;
  while (rafPending && guard++ < 10) { const fn = rafPending; rafPending = null; fn(guard * 16); }

  const allOps = [
    ...liveOps,
    ...createdCanvases.flatMap((c) => c.__ops ?? []),
  ];
  assert.ok(allOps.length > 20, 'the draw path actually ran (ops recorded)');
  assert.ok(!allOps.some((o) => o === 'clip'), 'the map never calls ctx.clip() — software rasterisers silently drop clipped fills (the disappearance mechanism)');
  assert.ok(!allOps.some((o) => o.startsWith('set:globalAlpha')), 'the map never sets ctx.globalAlpha — texture alpha is honoured inconsistently there');

  // The frontier is still enforced: on a partly-filled snapshot the band's own paints
  // (#0d1015 solid fill and its copy) must come AFTER the cell fills in the same frame
  // — repaint order, not a clip, keeps cells honest.
  const bandCanvas = {
    clientWidth: 899, clientHeight: 899, width: 0, height: 0, style: {},
    parentElement: { querySelector: () => null }, addEventListener() {},
    getContext: () => ctxFor(liveOps),
  };
  const before = liveOps.length;
  const canvasesBefore = createdCanvases.length;
  blockTreemap(bandCanvas, { cells: [{ vbytes: 400_000, rate: 3, txid: 'z' }], totalVbytes: 400_000 },
    { remainingWeight: 2_400_000 }, { weightLimit: 4_000_000 });   // 40% full, band to the right
  while (rafPending && guard++ < 20) { const fn = rafPending; rafPending = null; fn(guard * 16); }
  const frameOps = [
    ...liveOps.slice(before),
    ...createdCanvases.slice(canvasesBefore).flatMap((c) => c.__ops ?? []),
  ];
  const cellFill = frameOps.findIndex((o) => o === 'fillRect');
  const bandFill = frameOps.findIndex((o) => o === 'set:fillStyle=#0d1015');
  assert.ok(cellFill >= 0 && bandFill > cellFill,
    'the unfilled frontier band paints AFTER the cell loop (repaint order replaces the clip)');
});

test('the map paints through ONE direct draw path — no composite hop to be eaten', () => {
  // The offscreen + drawImage composite was the disappearance's fourth chapter: probes
  // showed the blit into a live canvas accepted (ops recorded) and NEVER landing, while
  // the identical frame drawn directly landed in full. A software rasteriser must not
  // get a second compositing hop, so the composite is banned outright.
  const src = readFileSync(fileURLToPath(new URL('../public/js/goggles.js', import.meta.url)), 'utf8');
  assert.ok(!/ctx\.drawImage/.test(src), 'the draw path never blits into a live canvas');
  assert.ok(!/__offscreen/.test(src), 'no offscreen composite surface left behind');
});
