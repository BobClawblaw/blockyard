// THE LAYERS OF THE SKY, EACH ITS OWN SWITCH (operator, 2026-09-12: "What else other than nebulas
// can we add as galactic effects? We should have toggles for all these sub-options in
// preferences"). A switch that does not change what is drawn is a lie told in a checkbox, so each
// one is read through a recording canvas: on, the layer's operations are there; off, they are not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render3d, nebulaClouds, dustLanes, starClusters, farGalaxies } from '../public/js/details3d.js';
import { spaceOptions, marketsOptions, DEFAULTS } from '../public/js/settings.js';

function harness() {
  let rafPending = null;
  const ops = [];
  harness.t = 0;
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => harness.t ?? 0 };
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 42; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  globalThis.document = globalThis.document ?? {};
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return (s) => ({ width: 6 });
      return (...a) => { ops.push(k === 'ellipse' ? 'ellipse' : String(k)); return t.canvas; };
    },
    set(t, k, v) { ops.push('set:' + k + '=' + String(v).slice(0, 30)); t[k] = v; return true; },
  });
  const canvas = { clientWidth: 600, clientHeight: 400, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: () => {}, setPointerCapture: () => {} };
  const step = (t) => { const fn = rafPending; rafPending = null; harness.t = t; if (fn) fn(t); return !!fn; };
  return { canvas, ops, step };
}

const CELLS = [{ txid: 'a', vbytes: 60000, rate: 40 }, { txid: 'b', vbytes: 40000, rate: 10 }];
const SKY = { space: true, stars: true, galaxy: true, galaxyAt: 'bottom-left', idleFx: false, transition: { rise: 0, travel: 1, drop: 0 } };

// one settled frame's worth of ops, with the given sky options
function frameOps(extra) {
  const h = harness();
  render3d(h.canvas, CELLS, { ...SKY, ...extra });
  for (let i = 1; i <= 3; i++) h.step(i * 16);
  return h.ops;
}
const count = (ops, pred) => ops.filter(pred).length;
// dust is the only layer that draws BLACK ellipses; a bare black-fill count also caught the
// board's shadows and seams (4 of them with dust off, which failed the first run of this)
const dustFills = (ops) => { let n = 0, fill = ''; for (const o of ops) { if (o.startsWith('set:fillStyle=')) fill = o; else if (o === 'ellipse' && fill.startsWith('set:fillStyle=rgba(0,0,0,')) n++; } return n; };
const clusterFills = (ops) => count(ops, (o) => o.startsWith('set:fillStyle=rgba(255,244,222'));
const glintStrokes = (ops) => count(ops, (o) => o === 'arc');
const warmStars = (ops) => count(ops, (o) => o.startsWith('set:fillStyle=rgba(255,214,150'));

test('every layer draws when on, and its switch removes exactly that layer', () => {
  const on = frameOps({});
  assert.ok(count(on, (o) => o === 'ellipse') > 50, 'gas, dust and distant galaxies are ellipses; there are many');
  assert.ok(dustFills(on) > 0, 'dust lanes are drawn as black fills');
  assert.ok(clusterFills(on) > 0, 'clusters are drawn as warm-white points');
  assert.ok(glintStrokes(on) > 0, 'the brightest stars carry a halo');
  assert.ok(warmStars(on) > 0, 'the bulge is warm');

  const noNeb = frameOps({ nebulae: false });
  assert.ok(count(noNeb, (o) => o === 'ellipse') < count(on, (o) => o === 'ellipse'), 'nebulae off draws fewer ellipses');
  assert.ok(dustFills(noNeb) > 0, 'and leaves the dust alone');

  const noDust = frameOps({ dust: false });
  assert.equal(dustFills(noDust), 0, 'dust off draws no dark ribbons');
  assert.ok(clusterFills(noDust) > 0, 'and leaves the clusters alone');

  const noClusters = frameOps({ clusters: false });
  assert.equal(clusterFills(noClusters), 0, 'clusters off draws none');

  const noGlints = frameOps({ starGlints: false });
  assert.equal(glintStrokes(noGlints), 0, 'glints off: no halo arcs at all');

  const noColours = frameOps({ starColours: false });
  assert.equal(warmStars(noColours), 0, 'colours off: no warm bulge stars, one colour of starlight');

  const noFar = frameOps({ galaxies: false });
  assert.ok(count(noFar, (o) => o === 'ellipse') < count(on, (o) => o === 'ellipse'), 'distant galaxies off draws fewer ellipses');
});

test('the generators are seeded and placed on the disc', () => {
  assert.deepEqual(dustLanes(800, 500), dustLanes(800, 500), 'the same lanes every time');
  assert.deepEqual(starClusters(800, 500), starClusters(800, 500));
  assert.deepEqual(nebulaClouds(800, 500), nebulaClouds(800, 500));
  assert.deepEqual(farGalaxies(800, 500), farGalaxies(800, 500));
  assert.ok(dustLanes(800, 500).every((d) => Number.isFinite(d.gr) && Number.isFinite(d.ga) && d.puffs.length > 0));
  assert.ok(starClusters(800, 500).every((k) => k.stars.length > 20));
});

test('the settings hand every switch to both boards, and the look signature watches them', () => {
  for (const k of ['nebulae', 'galaxies', 'dust', 'clusters', 'colours', 'glints']) {
    assert.equal(DEFAULTS.sky[k], true, `${k} ships on: it was asked for`);
  }
  const off = { sky: { nebulae: false, galaxies: false, dust: false, clusters: false, colours: false, glints: false } };
  for (const opt of [spaceOptions(off), marketsOptions(off)]) {
    assert.equal(opt.nebulae, false); assert.equal(opt.galaxies, false); assert.equal(opt.dust, false);
    assert.equal(opt.clusters, false); assert.equal(opt.starColours, false); assert.equal(opt.starGlints, false);
  }
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const sig = src.slice(src.indexOf('const optSig = ['), src.indexOf('const lookChanged'));
  for (const o of ['opts.nebulae', 'opts.galaxies', 'opts.dust', 'opts.clusters', 'opts.starColours', 'opts.starGlints']) {
    assert.ok(sig.includes(o), `${o} is part of the look, so flipping it repaints at once`);
  }
});
