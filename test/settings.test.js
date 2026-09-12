// DISPLAY SETTINGS (operator, 2026-09-12: "We need to add a configuration panel, allow persistent
// settings ... remove shadows, simple cubes, lower level of detail ... anything to make it run
// faster ... settings that affect the star field").
//
// The point of these tests is that a switch in the panel CHANGES WHAT IS DRAWN. A checkbox that
// persists a value nobody reads is worse than no checkbox: it tells the operator the board is
// cheaper when it is not. So each setting is followed through to the renderer's own output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULTS, PANEL, SETTINGS_KEY, normalise, loadSettings, saveSettings, setSetting, resetSettings,
  isDefault, spaceOptions, marketsOptions,
} from '../public/js/settings.js';
import { buildScene } from '../public/js/blockscene3d.js';
import { starField } from '../public/js/details3d.js';

// a localStorage stand-in: the real one is per browser, and these tests must not need one
function store() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() { return map.size; },
  };
}

test('defaults are the shipped look, and an empty or corrupt store still yields them', () => {
  assert.deepEqual(normalise(null), normalise(undefined));
  assert.equal(normalise(null).space.shadows, true);
  assert.equal(normalise(null).space.detail, 'full');
  assert.equal(normalise(null).markets.starDensity, 1);
  const s = store();
  assert.deepEqual(loadSettings(s), normalise(null), 'empty store');
  s.setItem(SETTINGS_KEY, '{not json');
  assert.deepEqual(loadSettings(s), normalise(null), 'corrupt store is not a crash');
  s.setItem(SETTINGS_KEY, JSON.stringify({ space: { detail: 'nonsense', dome: 999 }, markets: { starDensity: -5 } }));
  const got = loadSettings(s);
  assert.equal(got.space.detail, 'full', 'an unknown choice falls back');
  assert.equal(got.space.dome, 12, 'out of range is clamped, not rejected');
  assert.equal(got.markets.starDensity, 0.2, 'and clamped at the bottom too');
});

test('a setting round-trips through the store, and reset puts everything back', () => {
  const s = store();
  const next = setSetting(loadSettings(s), 'space.shadows', false, s);
  assert.equal(next.space.shadows, false);
  assert.equal(loadSettings(s).space.shadows, false, 'it persisted');
  assert.equal(isDefault(next), false);
  assert.deepEqual(setSetting(next, 'space.nonsense', true, s).space.shadows, false, 'an unknown key changes nothing');
  const back = resetSettings(s);
  assert.equal(isDefault(back), true);
  assert.equal(loadSettings(s).space.shadows, true, 'the store is empty again');
});

test('every panel control names a real setting, and every setting has a control', () => {
  const listed = new Set();
  for (const g of PANEL) {
    assert.ok(DEFAULTS[g.group], `panel group ${g.group} exists`);
    for (const r of g.rows) {
      assert.ok(r.key in DEFAULTS[g.group], `${g.group}.${r.key} is a real setting`);
      assert.ok(r.label && r.hint, `${g.group}.${r.key} is labelled and explained`);
      if (r.kind === 'choice') assert.ok(r.options?.length >= 2, 'a choice offers choices');
      if (r.kind === 'range') assert.ok(r.min < r.max && r.step > 0, 'a range has bounds');
      listed.add(`${g.group}.${r.key}`);
    }
  }
  for (const group of Object.keys(DEFAULTS)) {
    for (const key of Object.keys(DEFAULTS[group])) {
      assert.ok(listed.has(`${group}.${key}`), `${group}.${key} has a control in the panel`);
    }
  }
});

test('shadows off removes the cube-on-cube shadows too, not just the floor ones', () => {
  // operator, 2026-09-12: "still see shadows being cast from higher blocks onto lower blocks".
  // Cast shadows are built by a separate path (`casters` -> face: 'cast') from the floor shadows,
  // and the first version of the setting gated only the floor ones. This needs a real overlap: a
  // stone in flight directly above a resting stone, under the oblique camera.
  // the flyer has to be above the lower cube's TOP, not merely above the board: the projection
  // skips any caster whose gap to that top is negative (blockscene3d, `gap < -1e-6`), and a wide
  // stone is a tall cube. So: a small stone below, and a flyer well clear of it.
  const tiles = [
    { txid: 'under', x: 4, y: 4, s: 2, z: 0, color: '#3c9' },
    { txid: 'over', x: 4, y: 4, s: 2, z: 8, color: '#3c9' },      // straight above it, clear of its top
  ];
  const o = { unit: 6, zUnit: 6, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5, gridW: 20, gridH: 20 };
  const castOf = (opts) => buildScene(tiles, opts).ops.filter((op) => op.face === 'cast');
  assert.ok(castOf(o).length > 0, 'by default a flyer marks the top of the cube beneath it');
  assert.equal(castOf({ ...o, ...spaceOptions({ space: { shadows: false } }) }).length, 0,
    'with shadows off, not one cube-on-cube shadow is built');
});

test('shadows off really removes the shadow polygons from the scene', () => {
  const tiles = [
    { txid: 'a', x: 0, y: 0, s: 4, z: 0, color: '#3c9' },
    { txid: 'b', x: 6, y: 6, s: 3, z: 2.5, color: '#3c9' },      // in flight: casts as well as rests
  ];
  const o = { unit: 6, zUnit: 6, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5, gridW: 20, gridH: 20 };
  const withShadows = buildScene(tiles, o).ops.filter((op) => op.face === 'shadow' || op.face === 'cast');
  assert.ok(withShadows.length > 0, 'the shipped board casts shadows');
  const without = buildScene(tiles, { ...o, ...spaceOptions({ space: { shadows: false } }) }).ops
    .filter((op) => op.face === 'shadow' || op.face === 'cast');
  assert.equal(without.length, 0, 'with shadows off, not one shadow polygon is built');
});

test('level of detail raises the facet and crown thresholds', () => {
  const full = spaceOptions({ space: { detail: 'full' } });
  const simple = spaceOptions({ space: { detail: 'simple' } });
  const flat = spaceOptions({ space: { detail: 'flat' } });
  assert.ok(simple.facetPx > full.facetPx && simple.crownPx > full.crownPx, 'simple cubes: fewer polygons at the same size');
  assert.ok(flat.facetPx > simple.facetPx, 'flat is simpler still');
  assert.equal(spaceOptions({ space: { edges: false } }).seamAlpha, 0, 'edges off means no seam');
});

test('the Stone edges switch works at every level of detail -- no dead control', () => {
  // operator, 2026-09-12: "stone edges don't work in flat tile display mode". Flat forced the
  // seam off, so its own switch did nothing there.
  for (const detail of ['full', 'simple', 'flat']) {
    const on = spaceOptions({ space: { detail, edges: true } });
    const off = spaceOptions({ space: { detail, edges: false } });
    assert.equal(on.edges, true, detail + ': edges on means edges');
    assert.notEqual(on.seamAlpha, 0, detail + ': and a seam to draw');
    assert.equal(off.edges, false, detail + ': edges off means none');
    assert.equal(off.seamAlpha, 0, detail + ': and no seam');
  }
});

test('motion settings shorten or remove the flight; the board still lands', () => {
  assert.equal(spaceOptions({ space: { motion: 'full' } }).transition, undefined, 'full flight is the shipped choreography');
  const quick = spaceOptions({ space: { motion: 'quick' } }).transition;
  const still = spaceOptions({ space: { motion: 'still' } }).transition;
  assert.ok(quick.rise + quick.travel + quick.drop < 20000, 'quick is shorter than the 20 s flight');
  assert.ok(still.rise + still.travel + still.drop <= 1, 'still lands at once');
});

test('star density and brightness reach the field itself', () => {
  const base = starField(1200, 800, 1, 7, 1).length;
  const dense = starField(1200, 800, 1, 7, 2.5).length;
  const sparse = starField(1200, 800, 1, 7, 0.3).length;
  assert.ok(base > 0);
  assert.ok(dense > base * 2, `denser sky: ${base} -> ${dense}`);
  assert.ok(sparse < base / 2, `sparser sky: ${base} -> ${sparse}`);
  assert.deepEqual(starField(1200, 800, 1, 7, 1), starField(1200, 800, 1, 7, 1), 'seeded: the same sky every time');
  const off = marketsOptions({ markets: { stars: false } });
  assert.equal(off.space, false, 'stars off means the board draws none');
  const dim = marketsOptions({ markets: { starBrightness: 0.4 } });
  assert.equal(dim.starBrightness, 0.4);
  assert.equal(marketsOptions({ markets: { glow: false } }).neonHalo, 'rgba(0,0,0,0)', 'glow off silences the halo');
});

test('the shadows option survives the whole path: settings -> render3d -> the scene', () => {
  // The first version merged `shadows` into render3d options and stopped there: `view` is a
  // curated object handed to buildScene, and shadows were not in it, so the board went on
  // casting them (operator: "It still casts shadows when I have shadows unchecked"). Asserting
  // on buildScene alone is what let that through, so this reads the render path itself.
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const viewAt = src.indexOf('const view = {');
  const builtAt = src.indexOf('shadows: opts.shadows !== false');
  assert.ok(viewAt > 0, 'the view object is still built here');
  assert.ok(builtAt > viewAt, 'and it carries the shadows option into the scene');
  assert.ok(builtAt - viewAt < 1200, 'inside the same view literal, not somewhere else entirely');
});

test('simple cubes carry no divot at any size, and flat carries nothing at all', () => {
  const full = spaceOptions({ space: { detail: 'full' } });
  const simple = spaceOptions({ space: { detail: 'simple' } });
  const flat = spaceOptions({ space: { detail: 'flat' } });
  assert.equal(simple.crownPx, Infinity, 'no crown on a stone of any size');
  assert.ok(simple.facetPx > full.facetPx, 'and fewer facets than full detail');
  assert.equal(flat.crownPx, Infinity);
  assert.equal(flat.facetPx, Infinity);
  assert.equal(flat.edges, true, 'flat still honours the edges switch, which defaults to on');
});

test('idle effects are armed when the board rests, star field or not', () => {
  // operator, 2026-09-12: "i don't see any idle effects going off when the starfield background is
  // on the block space". scheduleFx was called only where the loop PARKS, and parking is gated on
  // !opts.space -- so with stars on, nothing was ever scheduled.
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const rest = src.indexOf('if (frame.settled && !st.dirty && !fxNow(st, t)) {');
  assert.ok(rest > 0, 'the rest branch no longer requires the loop to park');
  const armed = src.indexOf('scheduleFx(canvas, st, opts, !afterEffect)');
  const park = src.indexOf('if (!opts.space && !glowAnimating(st, t)) {', rest);
  assert.ok(armed > rest && armed < park, 'effects are armed before the park is even considered');
  assert.match(src, /if \(first\.settled\) \{ st\.atRest = true; scheduleFx\(canvas, st, opts, true\); \}/, 'and on a first paint that is already at rest');
  assert.match(src, /if \(!st\.atRest\) \{/, 'armed on the edge, not every frame');
  assert.match(src, /else st\.atRest = false;/, 'and re-armed once something moves again');
  // the trap this guards: scheduleFx with `soon` clears any pending timer, so calling it on
  // every settled frame (which a star field makes certain) resets the countdown for ever
  const armedAt = src.indexOf('scheduleFx(canvas, st, opts, !afterEffect)');
  const edgeAt = src.indexOf('if (!st.atRest) {');
  assert.ok(edgeAt > 0 && armedAt > edgeAt && armedAt - edgeAt < 300, 'the arming sits inside the edge test');
});

test('the renderer honours the option names the settings hand it', () => {
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /drawStars\(ctx, pw, ph, dpr \|\| 1, view\.now \?\? 0, opts\)/, 'star options reach drawStars');
  assert.match(src, /starField\(pw, ph, dpr, 7, density\)/, 'density reaches the field');
  const scene = readFileSync(new URL('../public/js/blockscene3d.js', import.meta.url), 'utf8');
  assert.match(scene, /if \(o\.shadows !== false\)/, 'shadows are optional in the scene builder');
  const mining = readFileSync(new URL('../public/js/mining.js', import.meta.url), 'utf8');
  assert.match(mining, /spaceOptions\(loadSettings\(\)\)/, 'the block boards read the settings');
  const markets = readFileSync(new URL('../public/js/markets.js', import.meta.url), 'utf8');
  assert.match(markets, /marketsOptions\(loadSettings\(\)\)/, 'the markets board reads them too');
});

test('the gear opens a panel, and none of it is styled inline (CSP)', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="btnSettings"/, 'there is a gear button');
  assert.match(html, /<svg viewBox="0 0 24 24"[^>]*>/, 'with a gear in it');
  assert.match(html, /id="settingsPanel"[^>]*role="dialog"/, 'and a panel it opens');
  assert.doesNotMatch(html, /style="/, 'no inline styles: the CSP forbids them');
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /btnSettings/, 'the gear is bound');
  assert.match(app, /Escape/, 'escape closes it');
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.cfgwrap \{/, 'the panel is styled');
  assert.match(css, /\.btn\.gear \{/, 'and so is the gear');
});
