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
  DEFAULTS, PANEL, SETTINGS_KEY, SCHEMA_VERSION, normalise, loadSettings, saveSettings, setSetting,
  resetSettings, isDefault, spaceOptions, marketsOptions, tetrustOptions, onSettingsChange,
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
  assert.equal(normalise(null).sky.density, 1);
  const s = store();
  assert.deepEqual(loadSettings(s), normalise(null), 'empty store');
  s.setItem(SETTINGS_KEY, '{not json');
  assert.deepEqual(loadSettings(s), normalise(null), 'corrupt store is not a crash');
  s.setItem(SETTINGS_KEY, JSON.stringify({ version: SCHEMA_VERSION, space: { detail: 'nonsense', dome: 999 }, sky: { density: -5 } }));
  const got = loadSettings(s);
  assert.equal(got.space.detail, 'full', 'an unknown choice falls back');
  assert.equal(got.space.dome, 12, 'out of range is clamped, not rejected');
  assert.equal(got.sky.density, 0.2, 'and clamped at the bottom too');
});

test('a setting round-trips through the store, and reset puts everything back', () => {
  const s = store();
  const next = setSetting(loadSettings(s), 'space.shadows', false, s);
  assert.equal(next.space.shadows, false);
  assert.equal(loadSettings(s).space.shadows, false, 'it persisted');
  assert.equal(isDefault(next), false);
  // It used to be ignored and return the settled object, which made a typo look exactly like a
  // saved setting: the control moved, nothing persisted, and nothing said so.
  assert.throws(() => setSetting(next, 'space.nonsense', true, s), /unknown setting "space\.nonsense"/,
    'an unknown path is refused out loud, not swallowed');
  assert.equal(loadSettings(s).space.shadows, false, 'and the store is untouched by the attempt');
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
  assert.equal(off.stars, false, 'stars off means the board draws none');
  assert.equal(off.space, true, 'but it is still a space board: the switch is the sky, not the style');
  const dim = marketsOptions({ sky: { brightness: 0.4 } });
  assert.equal(dim.starBrightness, 0.4);
  // the same sky, reaching the OTHER board: this is what the regroup was for
  assert.equal(spaceOptions({ sky: { density: 2.5 } }).starDensity, 2.5,
    'the block-space board can thin its stars too, which it could not when they lived under markets');
  assert.equal(spaceOptions({ sky: { brightness: 0.5 } }).starBrightness, 0.5);
  // the grid glow is off on this board at every setting, so there is no longer a switch for it
  assert.equal(marketsOptions({}).neonHalo, 'rgba(0,0,0,0)', 'the halo is silenced, always');
  assert.equal(marketsOptions({}).gridGlow, 'rgba(0,0,0,0)');
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
  // the park test reads the SKY now, not the board style: `space` also carries the deck texture
  // and the floor, so it could not go on standing in for "the stars need another frame"
  const park = src.indexOf('if (!starsOn(opts) && !glowAnimating(st, t)) {', rest);
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

test('an idle effect starts on a board at rest, even while the loop runs for the stars', () => {
  // operator, 2026-09-12: "i don't see any idle effects going off when the starfield background is
  // on the block space". Measured in the browser: the timer armed and fired (38/36, none
  // cancelled) and then declined to start, because "busy" tested st.raf -- and a star field keeps
  // the loop awake for ever. Busy has to mean the BOARD is moving.
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /const busy = st\.raf != null/, 'a running loop is not the same as a moving board');
  assert.match(src, /const busy = \(st\.plan && now < st\.plan\.settleAt\) \|\| st\.dirty \|\| !!st\.pending;/,
    'busy is: the choreography is running, a repaint is owed, or a newer layout waits');
});

test('cubes lean away from the middle of the board, not all one way', async () => {
  // operator, 2026-09-12: "all the blocks seem to lean right. Even the ones on the left side ...
  // I would expect blocks on the left side to have their right cube side visible".
  const { obliqueLean, tileFaces } = await import('../public/js/blockscene3d.js');
  const o = { unit: 6, zUnit: 6, oblique: { ox: 0.13, oy: 0.32, headroom: 10 }, dome: 5, gridW: 40, gridH: 40 };
  assert.ok(obliqueLean(0, o) < 0, 'at the left edge the push is leftward');
  assert.ok(Math.abs(obliqueLean(20, o)) < 1e-9, 'over the middle a cube stands straight up');
  assert.ok(obliqueLean(40, o) > 0, 'at the right edge it is rightward');
  assert.equal(obliqueLean(0, o), -obliqueLean(40, o), 'and the fan is symmetric');
  const sidesAt = (x) => tileFaces({ txid: 't', x, y: 20, s: 3, z: 0 }, o).sides.map((s) => s.key).sort();
  assert.ok(sidesAt(1).includes('right'), 'a block on the left shows its RIGHT face');
  assert.ok(sidesAt(36).includes('left'), 'a block on the right shows its LEFT face');
  assert.equal(obliqueLean(5, {}), 0.15, 'with no board width it is the old constant, so bare projections are unchanged');
});

test('the renderer honours the option names the settings hand it', () => {
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /drawStars\(ctx, pw, ph, dpr \|\| 1, view\.now \?\? 0, opts\)/, 'star options reach drawStars');
  // the galaxy joins density as something the FIELD is built from, not something painted over it
  // afterwards: the stars are laid on arms at generation, and only the angle moves per frame
  assert.match(src, /starField\(pw, ph, dpr, 7, density, galaxy\)/, 'density and the galaxy reach the field');
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

test('a v1 store keeps the choices it holds when a key moves group', () => {
  // The foundation the operator chose to build first (2026-09-12). Before this, regrouping a key
  // silently discarded whatever the operator had set: normalise dropped what it did not
  // recognise. The sky keys moving out of `markets` is the first migration to prove it.
  const s = store();
  s.setItem(SETTINGS_KEY, JSON.stringify({ space: { shadows: false }, markets: { stars: false, starDensity: 2.4, starBrightness: 0.6, glow: false } }));
  const got = loadSettings(s);            // no `version`: that is every store written before v2
  assert.equal(got.sky.density, 2.4, 'the density the operator chose, under its new name');
  assert.equal(got.sky.brightness, 0.6);
  assert.equal(got.markets.stars, false, 'and the keys that did not move are untouched');
  assert.equal(got.markets.glow, undefined, 'markets.glow was dropped at v3; a v1 store does not resurrect it');
  assert.equal(got.space.shadows, false);
  assert.equal(got.markets.starDensity, undefined, 'the old name is gone, not kept as a duplicate');
});

test('a store from a newer build falls back to defaults instead of guessing', () => {
  const s = store();
  s.setItem(SETTINGS_KEY, JSON.stringify({ version: SCHEMA_VERSION + 5, space: { dome: 11 }, sky: { density: 3 } }));
  assert.deepEqual(loadSettings(s), normalise(null),
    'its shape is unknown, so reading its keys would be a guess dressed as a preference');
});

test('what is written carries its version, and reading it back changes nothing', () => {
  const s = store();
  const saved = saveSettings({ space: { dome: 9 }, sky: { density: 2 } }, s);
  const raw = JSON.parse(s.getItem(SETTINGS_KEY));
  assert.equal(raw.version, SCHEMA_VERSION, 'stamped, so the next schema knows what it is reading');
  assert.deepEqual(loadSettings(s), saved, 'a round trip is a fixed point');
});

test('the clamp and the slider cannot drift: the bounds have one source', () => {
  // They were written out twice -- once in normalise, once in the PANEL row -- with nothing
  // linking them. normalise reads the row now, so a slider that offers a value always stores it.
  for (const g of PANEL) {
    for (const r of g.rows) {
      if (r.kind !== 'range') continue;
      const below = normalise({ [g.group]: { [r.key]: r.min - 1 } })[g.group][r.key];
      const above = normalise({ [g.group]: { [r.key]: r.max + 1 } })[g.group][r.key];
      assert.equal(below, r.min, `${g.group}.${r.key} clamps to the minimum its slider offers`);
      assert.equal(above, r.max, `${g.group}.${r.key} clamps to the maximum its slider offers`);
      const mid = Math.min(r.max, r.min + r.step);
      assert.equal(normalise({ [g.group]: { [r.key]: mid } })[g.group][r.key], mid,
        `${g.group}.${r.key} stores a value the slider can actually produce`);
    }
    if (g.rows.some((r) => r.kind === 'choice')) {
      for (const r of g.rows.filter((x) => x.kind === 'choice')) {
        for (const [val] of r.options) {
          assert.equal(normalise({ [g.group]: { [r.key]: val } })[g.group][r.key], val,
            `${g.group}.${r.key} accepts ${val}, which its own control offers`);
        }
      }
    }
  }
});

test('a change reaches a subscriber without waiting for the next paint', () => {
  const s = store();
  const seen = [];
  const off = onSettingsChange((next) => seen.push(next.space.dome));
  setSetting(loadSettings(s), 'space.dome', 2, s);
  resetSettings(s);
  off();
  setSetting(loadSettings(s), 'space.dome', 7, s);
  assert.deepEqual(seen, [2, DEFAULTS.space.dome], 'the save and the reset both announced themselves');
  assert.equal(loadSettings(s).space.dome, 7, 'and unsubscribing stops the telling, not the storing');
});

test('the galaxy is a toggle: off is the shipped sky, on lays the same stars on arms', async () => {
  // operator, 2026-09-12: "I want all the starts slowly rotating to form a spiral galaxy in the
  // background. We should have a preference to increase or decrease star/galaxy density. Make it
  // a toggle."
  const { starField } = await import('../public/js/details3d.js');
  const [W, H] = [1200, 800];
  const flat = starField(W, H, 1, 7, 1, false);
  const spiral = starField(W, H, 1, 7, 1, true);
  assert.deepEqual(starField(W, H, 1, 7, 1, false), flat, 'off is still the seeded scatter, unchanged');
  assert.deepEqual(starField(W, H, 1, 7, 1, true), spiral, 'and the galaxy is seeded too: the same sky every time');
  // An arm is drawn BY its stars, and at the scattered sky's count there were never enough of them
  // to make one: the first cut passed its structure tests and still looked like a faint sprinkle.
  // The galaxy is sampled several times harder; the density preference scales both.
  assert.ok(spiral.length > flat.length * 4, `the galaxy is sampled far harder (${flat.length} -> ${spiral.length})`);
  assert.ok(spiral.length <= 24000, 'but bounded: the count scales with area, and a 4K panel must not run away');
  assert.ok(flat.every((s) => s.gr === undefined), 'a scattered star has no orbit to turn on');
  assert.ok(spiral.every((s) => Number.isFinite(s.gr) && Number.isFinite(s.ga)), 'every galaxy star has one');
  assert.ok(spiral.some((s) => s.big), 'the bright ones survive the change of shape');
  // density still reaches it with the galaxy on -- the preference the operator asked for
  assert.ok(starField(W, H, 1, 7, 2.5, true).length > spiral.length * 2, 'denser galaxy');
  assert.ok(starField(W, H, 1, 7, 0.3, true).length < spiral.length / 2, 'sparser galaxy');
});

test('the galaxy sits low and left, and turning it does not thin the sky', async () => {
  // operator, 2026-09-12: "We should have the spiral galaxy centers on the lower left grid
  // location. That should cluster things up enough to be interesting."
  //
  // The earlier disc was centred and sized so no star ever left the panel. Off-centre that is not
  // possible -- the arms have to cross the edges, which is the point -- so the guarantee is
  // replaced by the property that actually matters: the number of stars ON the panel must stay
  // steady as it turns, or the sky would visibly thin and thicken every few minutes.
  const { starField, galaxyGeometry, GALAXY_FLATTEN, GALAXY_SPIN } = await import('../public/js/details3d.js');
  const [W, H] = [1200, 800];
  const spiral = starField(W, H, 1, 7, 1, true);
  const { cx, cy } = galaxyGeometry(W, H);
  assert.ok(cx < W / 2, `the middle is left of centre (${Math.round(cx)} of ${W})`);
  assert.ok(cy > H / 2, `and below it (${Math.round(cy)} of ${H})`);

  const visibleAt = (t) => {
    let seen = 0;
    for (const s of spiral) {
      const ang = s.ga + t * GALAXY_SPIN;
      const x = cx + s.gr * Math.cos(ang), y = cy + s.gr * GALAXY_FLATTEN * Math.sin(ang);
      if (x >= 0 && x <= W && y >= 0 && y <= H) seen++;
    }
    return seen;
  };
  const counts = [0, 112_500, 225_000, 337_500, 450_000, 675_000, 900_000].map(visibleAt);
  const lo = Math.min(...counts), hi = Math.max(...counts);
  assert.ok(lo > 200, `enough stars on the panel at every angle (${lo})`);
  assert.ok(hi - lo < lo * 0.35, `and the count barely moves as it turns (${lo}..${hi})`);

  // TRAILING, not leading: the arms wind outward in +theta, so the disc must turn in -theta or the
  // arm tips run ahead of the rotation -- which disc galaxies do not do (operator: "galaxy is
  // rotating in wrong direction for the astrophysics to work").
  assert.ok(GALAXY_SPIN < 0, 'the disc turns against the way the arms wind, so the arms trail');
  assert.ok(Math.abs(GALAXY_SPIN) * 60_000 < 0.5, 'slowly: well under a tenth of a turn in a minute');
  assert.ok(Math.abs(GALAXY_SPIN) * 900_000 >= Math.PI * 2 - 1e-9, 'but it does come all the way round');
  const s0 = spiral.find((s) => s.gr > 100);
  const pos = (t) => { const a = s0.ga + t * GALAXY_SPIN; return [cx + s0.gr * Math.cos(a), cy + s0.gr * GALAXY_FLATTEN * Math.sin(a)]; };
  const [x0, y0] = pos(0), [x1, y1] = pos(120_000);
  assert.ok(Math.hypot(x1 - x0, y1 - y0) > 5, 'two minutes moves a star visibly');
});

test('the density setting means the same thing wherever the galaxy sits', async () => {
  // Measured when the placements went in: a centred disc lies entirely on the panel while a
  // corner one puts about 40% of itself off it. Generating the same number either way made the
  // centred galaxy more than twice as dense as a corner one at the SAME slider position -- one
  // control quietly meaning two different things depending on an unrelated setting.
  const { starField, galaxyGeometry, GALAXY_PLACEMENTS, GALAXY_FLATTEN } = await import('../public/js/details3d.js');
  const [W, H] = [1265, 598];
  const onPanel = (at) => {
    const stars = starField(W, H, 1, 7, 1, at);
    const { cx, cy } = galaxyGeometry(W, H, at);
    let seen = 0;
    for (const s of stars) {
      const x = cx + s.gr * Math.cos(s.ga), y = cy + s.gr * GALAXY_FLATTEN * Math.sin(s.ga);
      if (x >= 0 && x <= W && y >= 0 && y <= H) seen++;
    }
    return seen;
  };
  const counts = Object.keys(GALAXY_PLACEMENTS).map((at) => [at, onPanel(at)]);
  const seen = counts.map(([, c]) => c);
  const lo = Math.min(...seen), hi = Math.max(...seen);
  assert.ok(lo > 500, `every placement fills the panel (${JSON.stringify(counts)})`);
  assert.ok(hi - lo < lo * 0.3, `and fills it comparably: ${JSON.stringify(counts)}`);
});

test('the arms are arms: the stars bunch along the spiral instead of spreading evenly', async () => {
  // The structural claim behind the effect. On a logarithmic arm the angle tracks log(radius), so
  // undoing that twist should collapse most stars onto a couple of headings; a uniform scatter
  // would stay uniform under the same transform.
  const { starField, galaxyGeometry, GALAXY_ARMS, GALAXY_TWIST } = await import('../public/js/details3d.js');
  const [W, H] = [1200, 800];
  const spiral = starField(W, H, 1, 7, 1, true);
  const { maxR, inner } = galaxyGeometry(W, H);
  const period = (Math.PI * 2) / GALAXY_ARMS;
  const wrap = (v) => { const m = ((v % period) + period) % period; return Math.min(m, period - m); };
  const mid = spiral.filter((s) => s.gr > inner * 2 && s.gr < maxR * 0.95);
  assert.ok(mid.length > 100, `enough stars to judge (${mid.length})`);
  const onArm = mid.filter((s) => wrap(s.ga - Math.log(s.gr / inner) / GALAXY_TWIST) < 0.5).length / mid.length;
  assert.ok(onArm > 0.5, `most mid-disc stars sit on an arm (${(onArm * 100).toFixed(0)}%)`);
  // the same measure on the scattered sky, which has no arms to find
  const flat = starField(W, H, 1, 7, 1, false);
  const fake = flat.map((s) => ({ gr: Math.hypot(s.x - W / 2, s.y - H / 2) || 1, ga: Math.atan2(s.y - H / 2, s.x - W / 2) }));
  const fakeOnArm = fake.filter((s) => wrap(s.ga - Math.log(s.gr / inner) / GALAXY_TWIST) < 0.5).length / fake.length;
  assert.ok(onArm > fakeOnArm * 1.4, `and far more than an even scatter would (${(fakeOnArm * 100).toFixed(0)}%)`);
});

test('the galaxy reaches both boards, because the sky belongs to neither', async () => {
  assert.equal(spaceOptions({ sky: { galaxy: true } }).galaxy, true, 'the block-space board');
  assert.equal(marketsOptions({ sky: { galaxy: true } }).galaxy, true, 'and the candle board');
  assert.equal(spaceOptions({}).galaxy, false, 'off by default: it is an opt-in effect');
  assert.equal(marketsOptions({}).galaxy, false);
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /f\.galaxy !== galaxy/, 'the field is rebuilt when the shape changes, not every frame');
  // The forbidden canvas shortcuts are NOT re-checked here. viewer-canvas-rules.test.js owns that
  // rule, and the runtime op recorders in details3d.test.js and never-clip.test.js back it up. A
  // source grep for the names cannot tell a call from a comment -- the first cut of this line
  // failed on the comment in drawGalacticCore explaining why those shortcuts are not used.
});

test('every sky control repaints the board at once, not at the next poll', () => {
  // operator, 2026-09-12: "checking the boxes needs to apply the new effects immediately, and
  // refresh the panels if need-be". render3d skips a board whose layout signature is unchanged, so
  // a display setting only lands if it is part of the LOOK signature beside it. The sky was not:
  // the star field is cached on its density and its shape, and nothing asked for a repaint when
  // either changed, so the galaxy toggle and both sliders would have looked broken until some
  // unrelated poll replanned the board.
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const sig = src.slice(src.indexOf('const optSig = ['), src.indexOf('const lookChanged'));
  assert.ok(sig.length > 0, 'the look signature is still built here');
  for (const opt of ['opts.starDensity', 'opts.starBrightness', 'opts.galaxy']) {
    assert.ok(sig.includes(opt), `${opt} is part of the look, so changing it repaints`);
  }
  // and the settings actually produce those option names, or the signature watches nothing
  const fromSpace = spaceOptions({ sky: { galaxy: true, density: 2, brightness: 0.5 } });
  assert.equal(fromSpace.galaxy, true);
  assert.equal(fromSpace.starDensity, 2);
  assert.equal(fromSpace.starBrightness, 0.5);
});

test('the parse is memoised, and a write invalidates it', () => {
  // markets.js and mining.js call loadSettings() as they draw, so this was a JSON.parse per frame.
  let reads = 0;
  const inner = store();
  const counting = {
    getItem: (k) => { reads++; return inner.getItem(k); },
    setItem: (k, v) => inner.setItem(k, v),
    removeItem: (k) => inner.removeItem(k),
  };
  const a = loadSettings(counting);
  const b = loadSettings(counting);
  assert.equal(a, b, 'an unchanged store hands back the very same object');
  assert.equal(reads, 2, 'it still checks the store each time; it just does not re-parse it');
  setSetting(a, 'space.dome', 1, counting);
  assert.equal(loadSettings(counting).space.dome, 1, 'a write is seen immediately after it lands');
});

test('tetrust: its own group, its own switches on the panel, and tetrustOptions carries the display sky when its stars are on', () => {
  // (operator, 2026-09-12: "Add teh starfield simulation as a toggle for teh game" ... "Tetris music
  // and sound effects ... Toggle for each in the game display")
  assert.deepEqual(DEFAULTS.tetrust, { stars: true, galaxy: true, galaxyAt: 'center', music: true, sfx: true, neon: false, neonSource: 'piece', neonColour: '#3d8bff', neonBrightness: 1 }, 'the panel is the sky, galaxy centred behind the title');
  const rows = PANEL.find((g) => g.group === 'tetrust')?.rows.map((r) => r.key);
  assert.deepEqual(rows, ['stars', 'galaxy', 'galaxyAt', 'music', 'sfx', 'neon', 'neonSource', 'neonColour', 'neonBrightness']);
  const off = tetrustOptions({ tetrust: { stars: false, galaxy: false, music: false, sfx: true }, sky: { galaxy: true, density: 4 } });
  assert.equal(off.stars, false); assert.equal(off.galaxy, false, 'the game decides its own galaxy, not the Sky group'); assert.equal(off.music, false); assert.equal(off.sfx, true);
  const on = tetrustOptions({ tetrust: { stars: true, galaxyAt: 'top-right' }, sky: { galaxy: false, density: 4, galaxyAt: 'bottom-left', dust: false } });
  assert.equal(on.stars, true);
  assert.equal(on.galaxy, true); assert.equal(on.starDensity, 4); assert.equal(on.galaxyAt, 'top-right'); assert.equal(on.dust, false, 'the display sky, layer for layer');
  assert.equal(normalise({ tetrust: { galaxyAt: 'nowhere' } }).tetrust.galaxyAt, 'center', 'an unknown placement is the default');
  const map = new Map();
  const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  assert.throws(() => setSetting({}, 'tetrust.volume', 1, store), /unknown setting/);
  setSetting({}, 'tetrust.music', false, store);
  assert.equal(loadSettings(store).tetrust.music, false, 'persisted like every other setting');
});

test('the neon tubes are tunable: source, one colour (a hex, validated), brightness (clamped) -- for the board and the game', () => {
  // (operator, 2026-09-12: "preferences for tuning the neon outline colors in Tetrust and in our
  // block space view. Slider for brightness, color selection ... optionally have the neon color
  // tied to the block temperature")
  const o = spaceOptions({ space: { neon: true, neonSource: 'colour', neonColour: '#FF00AA', neonBrightness: 9 } });
  assert.equal(o.neonSource, 'colour'); assert.equal(o.neonColour, '#ff00aa', 'a hex, lower-cased'); assert.equal(o.neonBrightness, 2, 'clamped to the slider');
  assert.equal(spaceOptions({ space: { neonColour: 'red' } }).neonColour, '#3d8bff', 'not a hex: the default');
  assert.equal(spaceOptions({ space: { neonSource: 'moon' } }).neonSource, 'temperature');
  const t = tetrustOptions({ tetrust: { neon: true, neonSource: 'colour', neonColour: '#123456', neonBrightness: 0 } });
  assert.equal(t.neon, true); assert.equal(t.neonSource, 'colour'); assert.equal(t.neonColour, '#123456'); assert.equal(t.neonBrightness, 0.2);
  assert.equal(tetrustOptions({ tetrust: { neonSource: 'piece' } }).neonSource, 'temperature', 'the piece\'s colour is the engine\'s "temperature" source');
  const colourRows = PANEL.flatMap((g) => g.rows.filter((r) => r.kind === 'colour').map((r) => `${g.group}.${r.key}`));
  assert.deepEqual(colourRows, ['space.neonColour', 'tetrust.neonColour'], 'a colour control for each');
});
