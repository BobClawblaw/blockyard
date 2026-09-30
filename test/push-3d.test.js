// THE 3D BOARDS ON THE PUSHED POOL (2026-09-30; operator: "take advantage of this new information flow ...
// adjusting the 3D views to work with the new datastream"). The pool arrives every 5 s; the boards keep their
// layout (packExactStable for Simple, packStable for Detailed); an update with nothing moving is a trickle --
// departures fly off, arrivals fall in, settled in ~3 s (blockscene3d.js TRICKLE) -- and a found block is
// still the full flight. Also the compressed pool routes the Detailed board fetches every push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTransition, isTrickle, TRICKLE } from '../public/js/blockscene3d.js';
import { render3d } from '../public/js/details3d.js';
import { withApp } from './helpers/http.js';

const tile = (txid, x, y, s = 1) => ({ txid, x, y, s, color: '#33aa66' });

test('isTrickle: arrivals, departures and holds are a trickle; one block changing its square is not', () => {
  const prev = [tile('a', 0, 0, 2), tile('b', 3, 0)];
  assert.equal(isTrickle(prev, [tile('a', 0, 0, 2), tile('c', 5, 0)]), true);
  assert.equal(isTrickle(prev, [tile('a', 1, 0, 2), tile('b', 3, 0)]), false, 'a moved');
  assert.equal(isTrickle(prev, [tile('a', 0, 0, 3)]), false, 'a changed size');
  assert.equal(isTrickle([], [tile('a', 0, 0)]), true);
});

test('the trickle settles inside one push; the full flight still takes its twenty seconds', () => {
  const prev = [tile('a', 0, 0, 2), tile('b', 3, 0)];
  const next = [tile('a', 0, 0, 2), tile('c', 5, 0), tile('d', 7, 2, 3)];
  const full = planTransition(prev, next, { now: 0, gridN: 44, maxGrowth: 4 });
  const quick = planTransition(prev, next, { now: 0, gridN: 44, maxGrowth: 4, ...TRICKLE });
  assert.ok(full.settleAt >= 19_000, `the reshuffle's phases (${full.settleAt} ms)`);
  assert.ok(quick.settleAt <= 4_000, `the trickle (${quick.settleAt} ms)`);
  assert.ok(TRICKLE.riseStagger === 0, 'nothing lifts: holds stay on the floor');
});

// the recording canvas the renderer tests use
function harness() {
  let rafPending = null;
  harness.t = 0;
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => harness.t ?? 0 };
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 42; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) { if (k === 'canvas') return t.canvas; if (k === 'measureText') return (s) => ({ width: String(s).length * 6 }); return () => t.canvas; },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = { clientWidth: 480, clientHeight: 480, width: 0, height: 0, style: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 480 }), addEventListener: () => {}, setPointerCapture: () => {} };
  ctx.canvas = canvas;
  return { canvas, pump: (n = 5000) => { let g = 0; while (rafPending && g++ < n) { const fn = rafPending; rafPending = null; harness.t += 16; fn(harness.t); } return g; }, pending: () => !!rafPending };
}
const SOFT = { renderer: 'software', stars: false, idleFx: false, shadows: false, boardOrder: 'stable' };   // (the kept-layout tests; Board order: Exact is tested on its own)
const mk = (n, tag, r0 = 90, spread = 20000) => Array.from({ length: n }, (_, i) => ({ txid: `${tag}-${i}-`.padEnd(64, 'x'), vbytes: 300 + ((i * 7919) % spread), rate: r0 - i * 0.2 }));
const where = (r) => new Map(r.tiles.filter((t) => !String(t.txid).startsWith('aggregate')).map((t) => [t.txid, `${t.x},${t.y},${t.s}`]));
const moved = (a, b) => [...b].filter(([id, p]) => a.has(id) && a.get(id) !== p).length;

test('Software, Simple viewer: a small update moves nothing and settles in about three seconds', () => {
  const base = mk(200, 'k').concat([{ vbytes: 500000, rate: 0.8, aggregate: 30000 }]);
  const next = base.filter((c, i) => i % 50 !== 3).concat(mk(3, 'z', 50));
  const h = harness();
  const a = where(render3d(h.canvas, base, SOFT));
  h.pump();
  harness.t += 5000;
  const b = where(render3d(h.canvas, next, SOFT));
  assert.equal(moved(a, b), 0, 'not one survivor moved');
  const frames = h.pump();
  assert.ok(frames * 16 <= 4_000, `settled in ${frames * 16} ms of frames`);
  assert.equal(h.pending(), false);
});

test('Software, Detailed viewer: the dense board keeps its squares too (packStable)', () => {
  const DENSE = { ...SOFT, resolution: 96, slab: 1.2, order: 'diagonal', dither: true };
  // (a block's worth, as the dense list is: 900 transactions of 300-1,300 vB)
  const base = mk(900, 'd', 60, 1000);
  const next = base.filter((c, i) => i % 97 !== 5).concat(mk(12, 'e', 30, 1000));
  const h = harness();
  const a = where(render3d(h.canvas, base, DENSE));
  h.pump();
  harness.t += 5000;
  const b = where(render3d(h.canvas, next, DENSE));
  assert.ok(moved(a, b) <= 2, `${moved(a, b)} survivors moved`);
  // (it flies -- "I'm not seeing animations. Just new blocks appearing on the board" -- over a kept board of the tiles
  // that do not move: test/retained-layer.test.js)
  const frames = h.pump();
  assert.ok(frames > 5 && frames * 16 <= 22_000, `a kept-layout update on Detailed animates and settles (${frames} frames)`);
});

test('the pool routes are gzipped when asked (they carry public data only); others never are', async () => {
  const { compressed, COMPRESS_MIN } = await import('../server/http/server.js');
  const { routes } = await import('../server/http/api.js');
  const zlib = await import('node:zlib');
  const big = JSON.stringify({ id: Array.from({ length: 2000 }, (_, i) => i.toString(16).padStart(64, 'a')) });
  const gz = compressed({ headers: { 'accept-encoding': 'gzip, deflate, br' } }, big, true);
  assert.ok(gz && gz.length < big.length / 2, `smaller (${gz?.length} of ${big.length})`);
  assert.equal(zlib.gunzipSync(gz).toString(), big, 'and it decodes to the same body');
  assert.equal(compressed({ headers: {} }, big, true), null, 'not asked, not sent');
  assert.equal(compressed({ headers: { 'accept-encoding': 'gzip' } }, big, false), null, 'a route that did not opt in');
  assert.equal(compressed({ headers: { 'accept-encoding': 'gzip' } }, 'x'.repeat(COMPRESS_MIN - 1), true), null, 'too small to bother');
  // who opted in: the two public pool routes, and nothing else (BREACH: never a route that can carry a secret)
  assert.deepEqual(routes.filter((r) => r.compress === true).map((r) => r.path).sort(), ['/api/mempool', '/api/mempool/dense']);
});

test('the rapid reshuffle: the default, and a whole re-pack settles inside one push', async () => {
  const { MOTION, DEFAULTS, PANEL, normalise, spaceOptions } = await import('../public/js/settings.js');
  assert.equal(DEFAULTS.space.motion, 'rapid');
  const row = PANEL.find((g) => g.group === 'space').rows.find((r) => r.key === 'motion');
  assert.deepEqual(row.options.map((o) => o[0]), ['blink', 'swift', 'rapid', 'steady', 'quick', 'full', 'still']);
  assert.equal(normalise({ space: { motion: 'full' } }).space.motion, 'full', 'a saved choice is kept');
  assert.deepEqual(spaceOptions(normalise(null)).transition, MOTION.rapid);
  // every block moving: a shifted grid of 600 cubes
  const prev = [], next = [];
  for (let i = 0; i < 600; i++) { prev.push(tile(`t${i}`, i % 40, Math.floor(i / 40))); next.push(tile(`t${i}`, (i + 7) % 40, Math.floor(i / 40) + 1)); }
  const rapid = planTransition(prev, next, { now: 0, gridN: 44, maxGrowth: 4, ...MOTION.rapid });
  const full = planTransition(prev, next, { now: 0, gridN: 44, maxGrowth: 4 });
  assert.ok(rapid.tweens.filter((t) => t.kind === 'move').length === 600);
  assert.ok(rapid.settleAt <= 5_000, `rapid settles in ${rapid.settleAt} ms`);
  assert.ok(full.settleAt >= 19_000);
  assert.ok(MOTION.rapid.riseStagger < MOTION.rapid.rise, 'every block is airborne before any descends (the no-collision proof)');
});


test('"None" draws each new board as it is: no flight, no trickle, no slide, on any renderer', async () => {
  const { MOTION } = await import('../public/js/settings.js');
  assert.equal(MOTION.still.none, true);
  const base = mk(200, 'k').concat([{ vbytes: 500000, rate: 0.8, aggregate: 30000 }]);
  const small = base.filter((c, i) => i % 50 !== 3).concat(mk(3, 'z', 50));       // a trickle's worth
  const repack = mk(150, 'q', 70).concat([{ vbytes: 500000, rate: 0.8, aggregate: 30000 }]);   // everything moves
  for (const renderer of ['software', '2.5d']) {
    const o = { ...SOFT, renderer, flatSlide: 'slide', transition: MOTION.still };
    const h = harness();
    render3d(h.canvas, base, o);
    h.pump();
    for (const next of [small, repack]) {
      harness.t += 5000;
      const r = render3d(h.canvas, next, o);
      assert.equal(r.settled, true, `${renderer}: settled at once`);
      assert.equal(h.pending(), false, `${renderer}: no frame asked for -- nothing moves`);
    }
  }
});

test('"None" on Software: the blocks redraw and play no effect, and the SKY STILL MOVES', async () => {
  // (operator, 2026-09-30, late: "When I set flight time to 'None', the background doesn't move at all" -- None is about
  // the board; an hour earlier it had frozen the sky too)
  const { MOTION } = await import('../public/js/settings.js');
  const { triggerIdle } = await import('../public/js/details3d.js');
  const o = { renderer: 'software', stars: true, galaxy: true, idleFx: true, transition: MOTION.still };
  const base = mk(200, 'k').concat([{ vbytes: 500000, rate: 0.8, aggregate: 30000 }]);
  const h = harness();
  render3d(h.canvas, base, o);
  assert.equal(h.pending(), true, 'the sky keeps a loop going');
  assert.equal(triggerIdle(h.canvas, 'ripple'), false, 'no idle effect can start');
  harness.t += 5000;
  render3d(h.canvas, base.slice(0, 150).concat(mk(5, 'n', 40)), o);
  const { viewerIdle } = await import('../public/js/details3d.js');
  assert.equal(viewerIdle(h.canvas), true, 'new data: the blocks are where they land at once (the sky loop runs on)');
});

test('rapid takes about three seconds; each Refresh animation option says its seconds; Refresh every is 5-120 s', async () => {
  const { MOTION, DEFAULTS, PANEL, normalise } = await import('../public/js/settings.js');
  const prev = [], next = [];
  for (let i = 0; i < 600; i++) { prev.push(tile(`t${i}`, i % 40, Math.floor(i / 40))); next.push(tile(`t${i}`, (i + 7) % 40, Math.floor(i / 40) + 1)); }
  const rapid = planTransition(prev, next, { now: 0, gridN: 44, maxGrowth: 4, ...MOTION.rapid });
  assert.ok(rapid.settleAt <= 3_300, `rapid settles in ${rapid.settleAt} ms`);
  const rows = PANEL.find((g) => g.group === 'space').rows;
  const labels = Object.fromEntries(rows.find((r) => r.key === 'motion').options);
  assert.match(labels.rapid, /3 s flight/); assert.match(labels.quick, /10 s flight/); assert.match(labels.full, /20 s/); assert.match(labels.still, /no flight/);
  const every = rows.find((r) => r.key === 'refreshEvery');
  assert.deepEqual([every.kind, every.min, every.max], ['range', 5, 120]);
  assert.equal(DEFAULTS.space.refreshEvery, 5);
  assert.equal(normalise({ space: { refreshEvery: 500 } }).space.refreshEvery, 120);
  assert.equal(normalise({ space: { refreshEvery: 1 } }).space.refreshEvery, 5);
  // the page takes a pushed pool at most that often, and its 30 s poll no longer replaces the board's picture
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(Date\.now\(\) - \(state\.poolAdoptedAt \?\? 0\) < refreshEveryMs\(s\) - 250\) return;/);
  assert.match(app, /loadSettings\(\)\.space\.refreshEvery/);
  assert.match(app, /const pushed = !force && poolPushed\(state\.snap\);/);
});

test('Swift and Blink: two seconds and one, with gravity raised to match -- a reshuffle and a small update alike', async () => {
  const { MOTION } = await import('../public/js/settings.js');
  const prev = [], next = [];
  for (let i = 0; i < 600; i++) { prev.push(tile(`t${i}`, i % 40, Math.floor(i / 40))); next.push(tile(`t${i}`, (i + 7) % 40, Math.floor(i / 40) + 1)); }
  const swift = planTransition(prev, next, { now: 0, gridN: 44, maxGrowth: 4, ...MOTION.swift });
  const blink = planTransition(prev, next, { now: 0, gridN: 44, maxGrowth: 4, ...MOTION.blink });
  assert.ok(swift.settleAt <= 2_150, `swift settles in ${swift.settleAt} ms`);
  assert.ok(blink.settleAt <= 1_150, `blink settles in ${blink.settleAt} ms`);
  assert.ok(MOTION.blink.gravity > MOTION.swift.gravity && MOTION.swift.gravity > 1, 'gravity rises as the clock shortens');
  // the same fall under stronger gravity is shorter by sqrt(g): landings keep their shape
  const one = planTransition([], [tile('a', 1, 1, 2)], { now: 0, gridN: 44, maxGrowth: 4, ...MOTION.rapid });
  const heavy = planTransition([], [tile('a', 1, 1, 2)], { now: 0, gridN: 44, maxGrowth: 4, ...MOTION.rapid, gravity: 4 });
  const land = (p) => { const tw = p.tweens.find((t) => t.kind === 'enter'); return tw; };
  assert.ok(land(one) && land(heavy));
  // a small update under Blink is quicker than the trickle's three seconds: the faster of the two is used
  const base = mk(200, 'k').concat([{ vbytes: 500000, rate: 0.8, aggregate: 30000 }]);
  const small = base.filter((c, i) => i % 50 !== 3).concat(mk(3, 'z', 50));
  const h = harness();
  const o = { ...SOFT, transition: MOTION.blink };
  render3d(h.canvas, base, o);
  h.pump();
  harness.t += 5000;
  render3d(h.canvas, small, o);
  const frames = h.pump();
  assert.ok(frames * 16 <= 1_400, `a small update under Blink settled in ${frames * 16} ms`);
});

test('Board order: Exact (the default) lays the board out afresh, richest lowest, on every update', async () => {
  const { DEFAULTS } = await import('../public/js/settings.js');
  assert.equal(DEFAULTS.space.boardOrder, 'exact');
  const DENSE = { ...SOFT, boardOrder: 'exact', resolution: 96, slab: 1.2, order: 'diagonal', dither: true };
  const base = mk(900, 'd', 60, 1000);
  // a rich newcomer: under Stable it takes the free space at the top; under Exact it is laid where its fee puts it
  const next = base.slice(0, -10).concat(mk(10, 'r', 99, 1000)).sort((a, b) => b.rate - a.rate);   // (richest first, as the server sends it)
  const h = harness();
  render3d(h.canvas, base, DENSE);
  h.pump();
  harness.t += 5000;
  const r = render3d(h.canvas, next, DENSE);
  // exactly the layout a board drawn from scratch gets -- the packer's fee order, nothing kept from before
  const fresh = render3d(harness().canvas, next, DENSE);
  const at = (t) => `${t.txid}@${t.x},${t.y},${t.s}`;
  assert.deepEqual(r.tiles.map(at).sort(), fresh.tiles.map(at).sort());
  // (Stable's kept layout and its re-sort are held by the tests above and test/blockpack-stable.test.js)
});

test('Steady: the five-second flight', async () => {
  const { MOTION, PANEL } = await import('../public/js/settings.js');
  const prev = [], next = [];
  for (let i = 0; i < 600; i++) { prev.push(tile(`t${i}`, i % 40, Math.floor(i / 40))); next.push(tile(`t${i}`, (i + 7) % 40, Math.floor(i / 40) + 1)); }
  const p = planTransition(prev, next, { now: 0, gridN: 44, maxGrowth: 4, ...MOTION.steady });
  assert.ok(p.settleAt >= 4_000 && p.settleAt <= 5_500, `steady settles in ${p.settleAt} ms`);
  const labels = Object.fromEntries(PANEL.find((g) => g.group === 'space').rows.find((r) => r.key === 'motion').options);
  assert.match(labels.steady, /5 s flight/);
});
