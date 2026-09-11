import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// "Collecting samples deletes the displayed data. We shouldn't ever do that."
// These drive the real charts.js against a stub canvas and assert what happens to
// pixels, because a grep for `empty(` would have passed all through the bug: the
// call was in the right place, it just cleared the canvas on its way in.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal window/devicePixelRatio so the browser module loads under node.
globalThis.window = { devicePixelRatio: 1 };

function stubCanvas() {
  const calls = [];
  const texts = [];
  const listeners = {};
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (p === 'roundRect') return (...a) => { calls.push('roundRect'); };
      if (!(p in t)) {
        t[p] = (...a) => {
          calls.push(String(p));
          if (p === 'fillText') texts.push(String(a[0]));
        };
      }
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  return {
    clientWidth: 320, clientHeight: 130, width: 0, height: 0,
    getContext: () => ctx,
    // The stub used to swallow addEventListener entirely -- which is precisely why
    // charts.js' hover path had no coverage at all: the listeners were never even
    // registered, so nothing that happens on mousemove could be observed here.
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    __listenerCount: (type) => (listeners[type] ?? []).length,
    __fire(type, ev = {}) {
      for (const fn of listeners[type] ?? []) fn({ clientX: 150, clientY: 60, ...ev });
      return calls.length;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    __calls: calls,
    __texts: texts,
    clearCount: () => calls.filter((c) => c === 'clearRect').length,
    // Everything drawn since the LAST clearRect. This is the question a user can
    // answer by looking at the screen: after the canvas was last wiped, what is
    // actually on it?
    sinceLastClear: () => calls.length - 1 - calls.lastIndexOf('clearRect'),
  };
}

const charts = await import('../public/js/charts.js');
const { lineChart, paint, hasData, resetCanvas, empty, markStale } = charts;

const series = [{ label: 'x', color: '#f7931a', points: [{ t: 1, v: 1 }, { t: 2, v: 2 }], area: true }];

test('drawing data marks the canvas as holding data', () => {
  const c = stubCanvas();
  lineChart(c, series, {});
  assert.equal(hasData(c), true);
  assert.ok(c.clearCount() >= 1, 'a real draw does clear-then-draw');
});

test('THE RULE: no data arriving must not clear a canvas that already shows data', () => {
  const c = stubCanvas();
  lineChart(c, series, {});
  const clears = c.clearCount();
  const textsBefore = c.__texts.length;

  // A frame where the sample never arrived -- the exact "collecting samples" case.
  paint(c, { when: false, draw: () => lineChart(c, series, {}), placeholder: 'collecting samples…' });

  assert.equal(c.clearCount(), clears, 'clearRect must not be called: the chart survives');
  assert.equal(hasData(c), true);
  // And the absence is still reported, just not by destroying the chart.
  const said = c.__texts.slice(textsBefore).join(' ');
  assert.match(said, /no fresh data/, 'the gap is stated, not hidden');
  assert.ok(!c.__texts.includes('collecting samples…'), 'the placeholder must not overwrite a live chart');
});

test('a canvas that never had data does show the placeholder', () => {
  const c = stubCanvas();
  paint(c, { when: false, draw: () => {}, placeholder: 'waiting for samples' });
  assert.ok(c.__texts.includes('waiting for samples'));
  assert.equal(hasData(c), false);
});

test('resetCanvas is the only thing that clears a populated canvas', () => {
  const c = stubCanvas();
  lineChart(c, series, {});
  const before = c.clearCount();
  resetCanvas(c);
  assert.equal(hasData(c), false, 'after a node switch the old pixels must be gone');
  assert.ok(c.clearCount() > before, 'and it clears explicitly, by design');
});

test('empty() on a populated canvas degrades to a stale pill, never an erase', () => {
  const c = stubCanvas();
  lineChart(c, series, {});
  const clears = c.clearCount();
  empty(c, 'no data');
  assert.equal(c.clearCount(), clears, 'empty() must not clear content it did not draw');
  assert.match(c.__texts.filter((t) => /no data|no fresh/.test(t)).join(' '), /.*/);
});

test('the stale pill is opaque, so re-drawing it every frame does not darken the chart', () => {
  const c = stubCanvas();
  lineChart(c, series, {});
  markStale(c, 'no fresh data · 3m');
  markStale(c, 'no fresh data · 3m');
  markStale(c, 'no fresh data · 3m');
  // An alpha-blended badge composited on itself would end up black within a
  // minute at one repaint per second. Opaque fill + stroke + text = 3 ops each.
  const fills = c.__calls.filter((x) => x === 'fill').length;
  assert.ok(fills >= 3, 'badge drawn each call');
  assert.ok(!c.__calls.includes('globalAlpha'), 'no globalAlpha compositing for the badge');
});

// ------------------------------------------------------------------ hover
//
// "When I mouse over a chart, it disappears and shows a popup where the cursor is.
// We shouldn't have the charts disappearing when mousing over them to see details."
// The tooltip path repainted the chart and then asked for a context through a
// helper that cleared the canvas -- so every pixel of the just-repainted chart was
// erased before the crosshair was drawn. Only the popup survived. Rule 8 in a
// nutshell: the overlay may sit on top of the data, never instead of it.

const richSeries = [{
  label: 'fee', color: '#f7931a',
  points: Array.from({ length: 40 }, (_, i) => ({ t: 1_700_000_000_000 + i * 60_000, v: 2 + (i % 7) })),
  area: true,
}];

test('hovering a chart binds exactly one mousemove/mouseleave pair', () => {
  const c = stubCanvas();
  lineChart(c, richSeries, {});
  lineChart(c, richSeries, {});          // a repaint must not double-bind
  assert.equal(c.__listenerCount('mousemove'), 1, 'one mousemove listener');
  assert.equal(c.__listenerCount('mouseleave'), 1, 'one mouseleave listener');
});

test('THE RULE: mouseover must not cost the canvas its chart', () => {
  const c = stubCanvas();
  lineChart(c, richSeries, {});
  const chartOps = c.sinceLastClear();
  assert.ok(chartOps > 30, `a 40-point chart should draw a lot (${chartOps})`);

  c.__fire('mousemove', { clientX: 150, clientY: 60 });

  const afterHover = c.sinceLastClear();
  assert.ok(hasData(c), 'the canvas must still believe it holds data');
  assert.ok(afterHover >= chartOps,
    `after the wipe triggered by hover, ${afterHover} ops remain where the chart drew ${chartOps} ` +
    '-- the tooltip is being drawn INSTEAD of the chart, not on top of it');
});

test('the tooltip still draws, so the fix is not "disable the popup"', () => {
  const c = stubCanvas();
  lineChart(c, richSeries, {});
  const textsBefore = c.__texts.length;
  c.__fire('mousemove', { clientX: 150, clientY: 60 });
  const added = c.__texts.slice(textsBefore).join(' ');
  assert.match(c.__calls.slice(-60).join(' '), /roundRect/, 'the popup box is drawn');
  assert.match(added, /\d/, 'the popup says something with a number in it');
});

test('leaving the chart restores it, popup gone', () => {
  const c = stubCanvas();
  lineChart(c, richSeries, {});
  const chartOps = c.sinceLastClear();
  c.__fire('mousemove', { clientX: 150, clientY: 60 });
  const withTip = c.sinceLastClear();
  c.__fire('mouseleave');
  const afterLeave = c.sinceLastClear();
  assert.ok(afterLeave >= chartOps, 'the chart is back after the pointer leaves');
  assert.ok(afterLeave <= withTip, 'and the crosshair/popup are not left painted on it');
});

test('a pointer outside the plot area repaints rather than leaving a stale crosshair', () => {
  const c = stubCanvas();
  lineChart(c, richSeries, {});
  const chartOps = c.sinceLastClear();
  c.__fire('mousemove', { clientX: 318, clientY: 60 });   // past the right margin
  assert.ok(c.sinceLastClear() >= chartOps, 'no hover, no erasure');
});

// ------------------------------------------------------------------ wiring

const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');

test('panels never call the destructive path directly', () => {
  const panels = read('js/panels.js');
  assert.match(panels, /import \{[^}]*paint[^}]*\} from '\.\/charts\.js'/, 'panels must go through paint()');
  assert.doesNotMatch(panels, /\bempty\(/, 'no direct empty() calls in panels');
  assert.ok((panels.match(/paint\(/g) || []).length >= 12, 'every chart should route through paint');
});

test('data state is never nulled, and canvases reset only on a node switch', () => {
  const app = read('js/app.js');
  assert.doesNotMatch(app, /state\.series = null|state\.snap = null/,
    'nulling the cache is what blanked the charts between frames');
  assert.match(app, /function resetAllCharts/, 'a node switch must clear the old node\'s pixels');
  assert.match(app, /resetAllCharts\(\);/, 'and it actually calls it');
  // The wipe must be scoped to node switches. Counting `resetAllCharts()` naive
  // also catches the `function resetAllCharts()` declaration line, so strip it.
  const callsites = (app.replace(/function resetAllCharts\(\) \{/, '').match(/resetAllCharts\(\);/g) || []);
  assert.equal(callsites.length, 1, `exactly one call site (switchNode), found ${callsites.length}`);
  // and it must live inside switchNode, not render() -- wiping on every frame
  // would blank the charts every second, which is the bug being fixed.
  const fn = app.slice(app.indexOf('async function switchNode'), app.indexOf('/**\n * The background collector.'));
  assert.match(fn, /resetAllCharts\(\);/, 'the wipe happens in switchNode');
  const renderBody = app.slice(app.indexOf('export function render()'), app.indexOf('const helpers ='));
  assert.doesNotMatch(renderBody, /resetAllCharts/, 'render() must never wipe the canvas set');
});

test('sampling happens in the background, on its own timer and on visibility', () => {
  const app = read('js/app.js');
  assert.match(app, /async function backgroundRefresh/, 'there is a background collector');
  assert.match(app, /setInterval\(\(\) => \{ if \(!document\.hidden && !state\.paused\) backgroundRefresh\(\); \}/, 'polled while visible');
  assert.match(app, /visibilitychange[\s\S]{0,80}backgroundRefresh/, 'and refreshed on focus return');
  assert.match(app, /rec\.series = \{ \.\.\.\(rec\.series \?\? \{\}\), \.\.\.\(sn\.series \?\? \{\}\) \}/,
    'merged, so a frame missing a series cannot drop a chart');
  // SSE series events must merge for the same reason
  assert.match(app, /rec\.series = \{ \.\.\.\(rec\.series \?\? \{\}\), \.\.\.\(p\.series \?\? p\) \}/);
});
