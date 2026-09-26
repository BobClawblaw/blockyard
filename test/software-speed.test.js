// SOFTWARE'S SPEED (operator, 2026-09-26: "is there any way for us to improve the software renderer
// performance" ... "do 1 and 3"). Two things, both driven through the real render3d here:
//   1. a resting board is drawn ONCE into a kept layer and blitted under every later frame of the sky
//      (details3d.js keptBoard), and a moving board is never kept;
//   2. Software draws at its own resolution (settings.js appearance.softwareScale), and WebGL does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { board3d, render3d, hitTest, softwareScaleOf } from '../public/js/details3d.js';
import { DEFAULTS, normalise, PANEL } from '../public/js/settings.js';

// a recording 2D context: every call and set, by name, into `sink`
const ctxFor = (sink, canvas) => new Proxy({ canvas, lineWidth: 1, lineJoin: 'miter', lineCap: 'butt' }, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
    if (k === 'drawImage') return (src) => { sink.push(`drawImage:${src?.__id ?? '?'}`); };
    return () => { sink.push(String(k)); };
  },
  set(t, k, v) { t[k] = v; return true; },
});

function stage({ dpr = 2 } = {}) {
  let raf = [];
  let now = 1000;
  globalThis.window = { devicePixelRatio: dpr, matchMedia: () => ({ matches: false }) };
  globalThis.requestAnimationFrame = (fn) => { raf.push(fn); return raf.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.performance = { now: () => now };
  const made = [];
  globalThis.document = {
    createElement: () => {
      const c = { __id: `off${made.length}`, width: 0, height: 0, ops: [] };
      c.getContext = (kind) => (kind === '2d' ? ctxFor(c.ops, c) : null);     // no WebGL here
      made.push(c);
      return c;
    },
  };
  const live = [];
  const canvas = {
    __id: 'board', clientWidth: 400, clientHeight: 300, width: 0, height: 0, style: {}, isConnected: true, offsetParent: {},
    parentElement: { querySelector: () => null, querySelectorAll: () => [] }, addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
  };
  const c2 = ctxFor(live, canvas);
  canvas.getContext = () => c2;
  const pump = (ms) => { for (let t = 0; t < ms; t += 50) { now += 50; const run = raf; raf = []; for (const fn of run) fn(now); } };
  return { canvas, live, made, pump, clock: () => now };
}

const TILES = [];
for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) TILES.push({ txid: `t${x},${y}`, x: x * 3, y: y * 3, s: 2, color: '#33cc99' });
const OPTS = { gridW: 20, gridH: 20, stars: true, idleFx: false, renderer: 'software', showFps: false, softwareScale: 'full' };
// each frame's ops, split on the clearRect paintFrame opens with
const frames = (ops) => ops.join('\n').split('clearRect').slice(1).map((f) => f.split('\n'));

test('a resting board under a sky is drawn once into a kept layer, and every later frame is one blit of it', () => {
  const { canvas, live, made, pump } = stage();
  board3d(canvas, TILES, { ...OPTS, sheen: true, sheenStyle: 'chrome' });
  pump(2000);
  const fs = frames(live);
  assert.ok(fs.length >= 20, `the sky kept the loop going (${fs.length} frames)`);
  const kept = made.find((c) => c.width === canvas.width && c.height === canvas.height && c.ops.includes('fill'));
  assert.ok(kept, 'a layer the panel\'s size was made and the board drawn into it');
  const fillsIn = (ops) => ops.filter((o) => o === 'fill').length;
  const boardFills = fillsIn(kept.ops);
  assert.ok(boardFills > TILES.length * 3, `the whole board went into it (${boardFills} fills)`);
  assert.ok(kept.ops.filter((o) => o === 'clearRect').length === 1, 'and it was built exactly once in two seconds of frames');
  // the frames after it carry the blit and not the board's fills
  const late = fs.slice(-10);
  assert.ok(late.every((f) => f.includes(`drawImage:${kept.__id}`)), 'every late frame blits the kept layer');
  assert.ok(late.every((f) => fillsIn(f) < boardFills / 4), 'and none of them fills the board\'s faces again');
});

test('a moving board is never kept: it draws straight on, and the layer is built again once it rests', () => {
  const { canvas, live, made, pump } = stage();
  board3d(canvas, TILES, OPTS);
  pump(1000);
  const kept = made.find((c) => c.width === canvas.width && c.ops.includes('fill'));
  assert.ok(kept);
  const builds = () => kept.ops.filter((o) => o === 'clearRect').length;
  assert.equal(builds(), 1);
  // a new layout: tiles move, the transition runs
  const moved = TILES.map((t, i) => (i % 3 ? t : { ...t, x: (t.x + 1) % 18 }));
  const at = live.length;
  board3d(canvas, moved, OPTS);
  pump(400);
  const flying = frames(live.slice(at)).slice(1, 5);
  assert.ok(flying.length >= 3 && flying.every((f) => !f.includes(`drawImage:${kept.__id}`)), 'mid-flight frames never blit the old board');
  assert.ok(flying.every((f) => f.filter((o) => o === 'fill').length > TILES.length), 'they draw their faces live');
  pump(60000);
  assert.equal(builds(), 2, 'landed, the board is kept again -- once');
  assert.ok(frames(live).at(-1).includes(`drawImage:${kept.__id}`));
});

test('SOFTWARE\'S RESOLUTION: full is every device pixel, 1x one per CSS pixel, half half that -- and WebGL is never capped', () => {
  assert.equal(DEFAULTS.appearance.softwareScale, 'full', 'shipped unchanged');
  assert.equal(normalise({ appearance: { softwareScale: '1' } }).appearance.softwareScale, '1');
  assert.equal(normalise({ appearance: { softwareScale: '3' } }).appearance.softwareScale, 'full', 'an unknown value is the default');
  const row = PANEL.flatMap((g) => g.rows ?? []).find((r) => r.key === 'softwareScale');
  assert.ok(row && row.options.map((o) => o[0]).join() === 'full,1,0.5', 'the panel offers the three');
  assert.equal(softwareScaleOf({ softwareScale: 'full' }), Infinity);
  assert.equal(softwareScaleOf({ softwareScale: '1' }), 1);
  assert.equal(softwareScaleOf({ softwareScale: '0.5' }), 0.5);

  const sized = (extra) => { const { canvas } = stage({ dpr: 2 }); render3d(canvas, [], { ...OPTS, laid: TILES, ...extra }); return [canvas.width, canvas.height]; };
  assert.deepEqual(sized({ softwareScale: 'full' }), [800, 600]);
  assert.deepEqual(sized({ softwareScale: '1' }), [400, 300]);
  assert.deepEqual(sized({ softwareScale: '0.5' }), [200, 150]);
  // a board's own maxDpr still wins where it is lower
  assert.deepEqual(sized({ softwareScale: '1', maxDpr: 0.5 }), [200, 150]);
  // WebGL chosen on a browser WITHOUT it (this stub has none) is Software -- so it is capped too
  assert.deepEqual(sized({ softwareScale: '1', renderer: 'webgl' }), [400, 300]);
});

test('the pointer finds a tile on a board drawn at fewer pixels than the screen has', () => {
  // hitTest used the SCREEN's pixel ratio, so on a capped board the pointer landed at twice its distance
  const hitAt = (maxDpr) => {
    const { canvas, pump } = stage({ dpr: 2 });
    board3d(canvas, TILES, { ...OPTS, maxDpr });   // (maxDpr: the older way a board draws at fewer pixels -- Tetrust's sky)
    pump(500);
    const hits = [];
    for (let y = 10; y < 300; y += 20) for (let x = 10; x < 400; x += 20) hits.push(hitTest(canvas, x, y)?.txid ?? hitTest(canvas, x, y)?.id ?? (hitTest(canvas, x, y) ? 'hit' : '-'));
    return hits;
  };
  const full = hitAt(undefined), half = hitAt(1);
  assert.ok(full.some((h) => h !== '-'), 'the probe hits something');
  const same = full.filter((h, i) => h === half[i]).length;
  assert.ok(same / full.length > 0.95, `the same tiles under the same pointer (${same}/${full.length})`);
});
