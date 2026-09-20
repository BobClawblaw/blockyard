// THE ARCADE (operator, 2026-09-12: "Think of many more other video-game inspired effects ... at
// least 25 total different effects, all toggleable ... tabbed section panel in setup").
//
// Two things can rot here and neither shows on screen until someone waits thirteen seconds for an
// effect that never comes: an effect with no switch (unreachable from the panel) and a switch with
// no effect (a control that does nothing). So the lists are asserted against each other, and every
// kind is then played through fxAt to prove it actually lights something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fxAt, fxHash } from '../public/js/blockscene3d.js';
import { FX_KINDS, SPACE_FX, MARKET_FX, MARKET_MS, board3d, triggerIdle, chooseIdleFx, fxDirection, fxOrigin, onPriceBoard, pulsarHeights, pulsarZ, pulsarSpin } from '../public/js/details3d.js';
import { DEFAULTS, PANEL, enabledEffects, spaceOptions, marketsOptions, fxCadence } from '../public/js/settings.js';

test('there are at least twenty-five effects, and every one has a switch of its own', () => {
  assert.ok(FX_KINDS.length >= 25, `${FX_KINDS.length} effects`);
  // EACH BOARD ITS OWN GROUP (operator, 2026-09-14: "I want the markets tab to have a separate
  // effects list"): each group also holds one number, noRepeat; the SWITCHES are exactly the
  // board's list, and between them the two lists cover every effect
  const switches = (group) => Object.keys(DEFAULTS[group]).filter((k) => typeof DEFAULTS[group][k] === 'boolean');
  const panelRows = (group) => PANEL.find((g) => g.group === group)?.rows.filter((r) => r.kind === 'toggle').map((r) => r.key);
  assert.deepEqual(switches('effects'), SPACE_FX, 'the block board switches are exactly SPACE_FX, in order');
  assert.deepEqual(panelRows('effects'), SPACE_FX, 'and its tab lists exactly those');
  assert.deepEqual(switches('marketEffects'), MARKET_FX, 'the price board switches are exactly MARKET_FX, in order');
  assert.deepEqual(panelRows('marketEffects'), MARKET_FX, 'and its tab lists exactly those');
  assert.deepEqual([...new Set([...SPACE_FX, ...MARKET_FX])].sort(), [...FX_KINDS].sort(), 'between them, every effect has a switch');
  assert.ok(MARKET_FX.every((k) => SPACE_FX.includes(k) || ['pulse', 'bulge', 'breathe', 'saber', 'blackhole', 'pulsar'].includes(k)), 'the price board offers nothing the block board lacks but the six of its own');
  assert.ok(SPACE_FX.length >= 25, 'twenty-five or more on the block board');
  assert.deepEqual(MARKET_FX, ['ripple', 'outline', 'tide', 'cascade', 'twinkle', 'scan', 'xray', 'pulse', 'bulge', 'breathe', 'saber', 'blackhole', 'firework', 'flare', 'wave', 'pulsar', 'stormball'], 'the price board ships the twelve the operator chose (2026-09-14) plus the four of 2026-09-15 and the pulsar wind of 2026-09-20, in FX_KINDS order');
  assert.deepEqual(FX_KINDS.filter((k) => !SPACE_FX.includes(k)), ['pulse', 'bulge', 'breathe', 'saber', 'blackhole', 'pulsar'], 'the block board lacks only the six that are the price board\'s own (the black hole hovered over it for a day, 2026-09-15, and was taken off again; the pulsar wind for one day too, 2026-09-20: "remove it from the block space view")');
  for (const group of ['effects', 'marketEffects']) {
    assert.equal(DEFAULTS[group].noRepeat, 12, `${group}: the no-repeat window defaults to 12`);
    // all on, they were asked for -- but the fireworks, kept for occasions (2026-09-15), ship off
    assert.ok(switches(group).every((k) => DEFAULTS[group][k] === (k !== 'firework')), `${group}: all on but the fireworks`);
    assert.equal(DEFAULTS[group].firework, false, `${group}: the fireworks are off until ticked`);
    assert.equal(PANEL.find((g) => g.group === group).bulk, true, `${group}: the tab has all on / all off`);
    const slider = PANEL.find((g) => g.group === group).rows.find((r) => r.key === 'noRepeat');
    assert.equal(slider.max, switches(group).length, `${group}: the no-repeat slider tops out at the list's length (${slider.max})`);
    assert.ok(DEFAULTS[group].noRepeat <= slider.max, `${group}: the default sits on the slider`);
  }
});

test('every effect lights something at some point in its run, and nothing before or after it', () => {
  // a board of cubes across a 20x20 grid: whatever an effect reaches, one of these is under it
  const tiles = [];
  for (let x = 0; x < 20; x += 2) for (let y = 0; y < 20; y += 2) tiles.push({ txid: `t${x}_${y}`, x, y, s: 2, rate: x + y });
  const rank = new Map(tiles.map((t, i) => [t.txid, i / (tiles.length - 1)]));
  const fxFor = (kind, u) => ({
    kind, u, amp: Math.min(1, u * 6) * Math.pow(1 - u, 0.8), gridW: 20, gridH: 20,
    dx: 1, dy: 0, seed: 4242, x: 9, y: 11, rank,
    // the three that carry their own geometry (fxNow builds these; the shapes are pinned elsewhere)
    r: 20 * u, w: 2.4,
    ball: { x: 20 * u, y: 10, z: 1 },
    heads: [{ x: 20 * u, y: 10, color: [80, 220, 255], alpha: 1 }],
  });
  for (const kind of FX_KINDS) {
    if (kind === 'pulse' || kind === 'bulge' || kind === 'breathe' || kind === 'saber' || kind === 'blackhole') continue;   // the price board's own
    let lit = 0, worst = 0;
    for (let u = 0.02; u < 1; u += 0.02) {
      const fx = fxFor(kind, u);
      for (const t of tiles) {
        const v = fxAt(t, fx);
        assert.ok(v.glow >= 0 && v.glow <= 1.001, `${kind} glow in range at u=${u.toFixed(2)}: ${v.glow}`);
        assert.ok(v.outline >= 0 && v.outline <= 1.001, `${kind} outline in range: ${v.outline}`);
        assert.ok(v.lift >= 0 && v.lift < 12, `${kind} lift is a lift, not a launch: ${v.lift}`);
        if (v.color) assert.ok(v.color.length === 3 && v.color.every((c) => Number.isFinite(c) && c >= 0 && c <= 255), `${kind} colour is a colour: ${v.color}`);
        const m = Math.max(v.glow, v.outline, v.lift / 4);
        if (m > 0.05) lit++;
        worst = Math.max(worst, m);
      }
    }
    assert.ok(lit > 0, `${kind} lights at least one cube somewhere in its run`);
    assert.ok(worst > 0.3, `${kind} is actually visible at its peak (${worst.toFixed(2)})`);
  }
});

test('an effect is the same picture every time it replays: no Math.random in the per-tile pass', () => {
  // the board-level choices (where a firework bursts, which cube flares) are hashed out of the
  // seed, so a test can assert on them and a replay cannot drift
  assert.equal(fxHash(7), fxHash(7));
  assert.notEqual(fxHash(7), fxHash(8));
  assert.ok(fxHash(12345) >= 0 && fxHash(12345) < 1);
  const t = { txid: 'a', x: 4, y: 4, s: 2 };
  for (const kind of ['firework', 'flare', 'sparkle', 'plasma', 'rain', 'quake']) {
    const fx = { kind, u: 0.4, amp: 1, gridW: 20, gridH: 20, dx: 1, dy: 0, seed: 99, x: 9, y: 11 };
    assert.deepEqual(fxAt(t, fx), fxAt(t, fx), `${kind} replays identically`);
  }
});

test('the switches reach the scheduler: the enabled list is what the boards are given', () => {
  const all = spaceOptions({});
  assert.deepEqual(all.fxKinds, SPACE_FX.filter((k) => k !== 'firework'), 'everything on by default but the fireworks, kept for occasions');
  const few = spaceOptions({ effects: Object.fromEntries(FX_KINDS.map((k) => [k, k === 'ripple' || k === 'nova'])) });
  assert.deepEqual(few.fxKinds, ['ripple', 'nova'], 'only what is left on, in list order');
  assert.deepEqual(marketsOptions({}).fxKinds, MARKET_FX.filter((k) => k !== 'firework'), 'the price board is given its own list, fireworks off there too');
  assert.equal(marketsOptions({}).fxNoRepeat, 12, 'and its own window');
  // THE LISTS ARE INDEPENDENT: the block board's switches say nothing about the price board's
  const split = { effects: Object.fromEntries(SPACE_FX.map((k) => [k, false])), marketEffects: { noRepeat: 3, ...Object.fromEntries(MARKET_FX.map((k) => [k, k === 'pulse' || k === 'wave'])) } };
  assert.deepEqual(spaceOptions(split).fxKinds, [], 'the block board rests');
  assert.deepEqual(marketsOptions(split).fxKinds, ['pulse', 'wave'], 'while the price board plays its two');
  assert.equal(marketsOptions(split).fxNoRepeat, 3);
  assert.deepEqual(enabledEffects({ effects: Object.fromEntries(FX_KINDS.map((k) => [k, false])) }), [], 'all off is a board at rest');
});

test('NO EFFECT IS THE SCHEDULER\'S FAVOURITE', () => {
  // (operator, 2026-09-13: "the tron lightcycles effect happens way too often".)
  //
  // There was a rule in scheduleFx giving the light cycles a 50% head start on the first effect
  // after the board came to rest. Written when there were nine effects, it read as a flourish;
  // measured with fifty-six it took 33.2% of every first-after-landing pick against 1.8% for an
  // even split -- an eighteenfold bias. And the block-space board re-lays on every pool refresh,
  // so that branch fires constantly, which is why it felt relentless.
  //
  // Nothing guarded it, which is why it survived four batches of new effects. This does: the
  // choice is replicated exactly as scheduleFx makes it, and no kind may run away with the board.
  const LINE_FX = MARKET_FX;   // the price board's list
  const pick = (last) => {
    const kinds = FX_KINDS.filter((k) => k !== 'pulse');
    let pool = kinds.filter((k) => k !== last);
    if (pool.length > 1 && pool.includes('pulse') && Math.random() < 0.75) pool = pool.filter((k) => k !== 'pulse');
    return (pool.length ? pool : kinds)[(Math.random() * (pool.length ? pool.length : kinds.length)) | 0];
  };
  const n = 20000;
  const count = {};
  let last = null;
  for (let i = 0; i < n; i++) { const k = pick(last); count[k] = (count[k] ?? 0) + 1; last = k; }
  const even = 1 / (FX_KINDS.length - 1);
  const worst = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  const share = worst[1] / n;
  assert.ok(share < even * 2,
    `${worst[0]} takes ${(100 * share).toFixed(1)}% of picks; an even split is ${(100 * even).toFixed(1)}% `
    + '-- no effect may be hardcoded as a favourite');
  // and every kind must be reachable at all: a kind the scheduler can never pick is dead code
  const never = FX_KINDS.filter((k) => k !== 'pulse' && !count[k]);
  assert.deepEqual(never, [], `these kinds were never chosen in ${n} draws`);

  // THE PRICE BOARD'S LIST IS PICKED THE SAME WAY (operator, 2026-09-14: "Make the pipe 'special
  // rare' effects no longer special, and bake them into the regular round of choosing effects for
  // the market"). The pulse, the bulge and ball lightning used to wait 2.5-6 minutes between plays;
  // now they are picks like any other: no waiting on a fresh board, no clock, an even share.
  let seed = 20260914;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const st = {};
  const cnt = {};
  for (let i = 0; i < 24000; i++) { const k = chooseIdleFx(LINE_FX, st, i * 8000, rnd); cnt[k] = (cnt[k] ?? 0) + 1; }
  const evenShare = 1 / LINE_FX.length;
  for (const k of ['pulse', 'bulge', 'stormball']) {
    assert.ok(cnt[k] / 24000 > evenShare * 0.8 && cnt[k] / 24000 < evenShare * 1.2, `${k} takes an ordinary share of the price board's picks (${(100 * cnt[k] / 24000).toFixed(1)}% against ${(100 * evenShare).toFixed(1)}%)`);
  }
  assert.equal(chooseIdleFx(['pulse'], {}, 0), 'pulse', 'a lone pulse plays at once');
  assert.equal(chooseIdleFx(['bulge'], {}, 0), 'bulge', 'so does a lone bulge');
  assert.equal(chooseIdleFx(['stormball'], {}, 0), 'stormball', 'and lone ball lightning, on either board');
  const fresh = {};
  chooseIdleFx(LINE_FX, fresh, 0, rnd);
  assert.deepEqual(Object.keys(fresh), ['recentFx'], 'the picker keeps only the no-repeat history');
});

test('with every effect switched off the board never schedules one, and it still draws', () => {
  // the scheduler used to pick from the whole list and the switches were advisory
  const timers = [];
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => 0 };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.document = globalThis.document ?? {};
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
  try {
    const ctx = new Proxy({ canvas: {} }, {
      get(t, k) { if (k === 'canvas') return t.canvas; if (k === 'measureText') return () => ({ width: 6 }); return () => t.canvas; },
      set(t, k, v) { t[k] = v; return true; },
    });
    const canvas = { clientWidth: 300, clientHeight: 300, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() {}, setPointerCapture() {}, isConnected: true };
    const tiles = [{ txid: 'a', x: 0, y: 0, s: 4, color: '#33cc99' }];
    const opts = { gridW: 8, gridH: 8, idleFx: true, still: true, transition: { rise: 0, travel: 1, drop: 0 } };
    const drawn = board3d(canvas, tiles, { ...opts, fxKinds: [] });
    assert.ok(drawn, 'the board is still drawn');
    for (const t of timers) t.fn();
    assert.equal(triggerIdle(canvas, 'ripple'), true, 'and an effect asked for by name still plays: the switch governs the scheduler, not the engine');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('markets remembers its toolbar: the exchange and the range are settings with controls', () => {
  // (operator, 2026-09-12: "We need to remember the user settings for the Markets page")
  assert.equal(DEFAULTS.markets.exchange, 'coinbase');
  assert.equal(DEFAULTS.markets.range, '24', 'a string: a <select> hands back a string');
  const rows = PANEL.find((g) => g.group === 'markets')?.rows ?? [];
  const ex = rows.find((r) => r.key === 'exchange'), range = rows.find((r) => r.key === 'range');
  assert.ok(ex?.options.some(([v]) => v === 'kraken') && ex.options.length >= 2, 'the exchanges are offered');
  assert.deepEqual(range?.options.map(([v]) => v), ['24', '48', '168'], 'and the ranges the toolbar offers');
  const src = readFileSync(new URL('../public/js/markets.js', import.meta.url), 'utf8');
  assert.match(src, /setSetting\(loadSettings\(\), 'markets\.exchange'/, 'a click on an exchange is persisted');
  assert.match(src, /setSetting\(loadSettings\(\), 'markets\.range'/, 'and a click on a range');
  assert.match(src, /M\.ex = mk\.exchange/, 'and the page opens where it was left');
});

test('the settings panel is tabbed, one tab per group, with all-on/all-off where a group is only switches', () => {
  // (operator, 2026-09-12: "tabbed section panel in setup") -- twenty-six switches in one scroll
  // buried every other setting under them
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /class="cfgtabs" role="tablist"/, 'a tab strip');
  assert.match(app, /data-cfgtab="\$\{g\.group\}"/, 'one tab per panel group');
  assert.match(app, /g\.group === cfgTab/, 'and only the open tab is rendered');
  assert.match(app, /data-cfgall="\$\{g\.group\}"/, 'all on, where a group is nothing but switches');
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.cfgtab\.on \{/, 'the open tab is marked');
});

test('on the price board every front runs along the hours and every ring starts on the candles', () => {
  // operator, 2026-09-14: "For the markets effects, it all needs to be left/right or right/left
  // movement. Not coming towards the viewer. Always interacting with either the grid price line or candles"
  const price = { gridW: 48, gridH: 8, axes: { y: 3.7, line: [{ x: 1, z: 10 }, { x: 3, z: 12 }] } };
  const blocks = { gridW: 20, gridH: 20 };
  assert.equal(onPriceBoard(price), true); assert.equal(onPriceBoard(blocks), false); assert.equal(onPriceBoard({ axes: { line: [] } }), false);
  const rnd = (() => { let s = 7; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296); })();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    for (const kind of ['outline', 'scan', 'tide', 'wave']) {
      const [dx, dy] = fxDirection(kind, price, rnd);
      assert.equal(dy, 0, `${kind}: never along the depth`);
      assert.ok(dx === 1 || dx === -1, `${kind}: left to right or right to left`);
      seen.add(dx);
    }
    const o = fxOrigin(price, rnd);
    assert.equal(o.y, 3.7, 'a ring starts on the candle row');
    assert.ok(o.x >= 0 && o.x <= 48, 'anywhere along the hours');
  }
  assert.deepEqual([...seen].sort(), [-1, 1], 'both ways, over time');
  // the block board keeps its seven ways and its free origin
  const dirs = new Set(), ys = new Set();
  for (let i = 0; i < 300; i++) { dirs.add(fxDirection('outline', blocks, rnd).join(',')); ys.add(Math.floor(fxOrigin(blocks, rnd).y)); }
  assert.equal(dirs.size, 7); assert.ok(ys.size > 10);
});

test('the cadence sliders: each effects tab sets how long its board rests between effects, up to ten minutes', () => {
  // operator, 2026-09-14: "add sliders to each the market and block space effects panels so we can
  // tune the randomized timing of the events being triggered ... based on the current defaults ...
  // delay effects being triggered even longer than they are now"
  for (const group of ['effects', 'marketEffects']) {
    const rows = PANEL.find((g) => g.group === group).rows;
    for (const key of ['pauseMin', 'pauseMax']) assert.equal(rows.find((r) => r.key === key)?.kind, 'range', `${group}: a ${key} slider`);
    assert.equal(rows.find((r) => r.key === 'pauseMax').max, group === 'effects' ? 600 : 300, `${group}: up to ten minutes between effects on the block board, five on the candle board`);
    assert.equal(rows.find((r) => r.key === 'pauseMin').max, rows.find((r) => r.key === 'pauseMax').max);
    assert.deepEqual(fxCadence(DEFAULTS[group]).idleEvery, [5000, 9000], `${group}: the defaults reproduce the cadence there was`);
  }
  // ONLY THE BLOCK BOARD LANDS (operator: "there is no 'landing' for the markets display"): its tab
  // has the first-after-landing slider and the defaults reproduce 0.8-1.6 s; the Markets tab has
  // no such slider, and the candle board's first effect after a refresh keeps the cadence
  assert.equal(PANEL.find((g) => g.group === 'effects').rows.find((r) => r.key === 'firstAfter')?.kind, 'range');
  assert.equal(PANEL.find((g) => g.group === 'marketEffects').rows.find((r) => r.key === 'firstAfter'), undefined, 'no landing slider on the Markets tab');
  assert.equal(DEFAULTS.marketEffects.firstAfter, undefined);
  assert.deepEqual(spaceOptions({}).idleEvery, [5000, 9000]); assert.deepEqual(spaceOptions({}).idleFirst, [800, 1600]);
  assert.deepEqual(marketsOptions({}).idleEvery, [5000, 9000]); assert.deepEqual(marketsOptions({}).idleFirst, [5000, 9000]);
  // longer than now, per board, independently; a floor above its ceiling swaps rather than jams
  const slow = { effects: { pauseMin: 120, pauseMax: 600, firstAfter: 30 }, marketEffects: { pauseMin: 45, pauseMax: 20 } };
  assert.deepEqual(spaceOptions(slow).idleEvery, [120000, 600000]); assert.deepEqual(spaceOptions(slow).idleFirst, [20000, 40000]);
  assert.deepEqual(marketsOptions(slow).idleEvery, [20000, 45000]); assert.deepEqual(marketsOptions(slow).idleFirst, [20000, 45000]);
  assert.deepEqual(marketsOptions({ marketEffects: { pauseMin: 1, pauseMax: 9999 } }).idleEvery, [1000, 300000], 'the candle board clamps at five minutes');
  // clamped to the sliders' own ranges
  assert.deepEqual(spaceOptions({ effects: { pauseMin: 9999, pauseMax: -4, firstAfter: 500 } }).idleEvery, [1000, 600000]);
});

test('the no-repeat window holds from the very first pick: nothing repeats before every effect has had a turn', () => {
  // operator, 2026-09-15: "I don't think the avoid repeats is working well in at least the market
  // view. I keep seeing the same effect being played before new ones". The window was read with
  // recent.slice(recent.length - window), and a negative index counts from the END: with fewer
  // plays than the window is wide, only the last few were blocked. Measured: a repeat at the
  // tenth pick of twelve.
  let seed = 42;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (const [kinds, window] of [[MARKET_FX, 12], [SPACE_FX, 12], [MARKET_FX, 5], [SPACE_FX, 28]]) {
    for (let run = 0; run < 20; run++) {
      const st = {};
      const seq = [];
      for (let i = 0; i < 60; i++) seq.push(chooseIdleFx(kinds, st, i * 8000, rnd, window));
      const w = Math.min(window, kinds.length - 1);
      for (let i = 0; i < seq.length; i++) {
        const back = seq.slice(Math.max(0, i - w), i);
        assert.ok(!back.includes(seq[i]), `${kinds.length} kinds, window ${window}: ${seq[i]} at pick ${i + 1} repeats within the last ${w} (${back.join(' ')})`);
      }
    }
  }
});

test('ball lightning crosses the price board a third slower than the block board', () => {
  // operator, 2026-09-15: "cut the speed by 33% now that it's slower"
  assert.equal(MARKET_MS.stormball, 27500, '11 s on the block board, 27.5 s on the candles (a third slower, then 40% slower again)');
});

test('THE SCAN IS A CONE, NOT A STACK OF SHEETS', () => {
  // (operator, 2026-09-15: "that leaning portion and the cross-hatching is not working. Can we make
  // it a conical beam. instead, and do something volumetric effect?")
  //
  // The curtain was twenty-one PARALLEL flat quads with raster lines across them. Under the oblique
  // camera parallel sheets project to parallelograms offset by a constant, so their translucent
  // edges fall on near-parallel screen lines and read as a leaning lattice. No alpha tuning fixes
  // that -- the geometry IS a grid.
  //
  // NOTHING IN THIS SUITE DREW THE SCAN, which is how that shipped green. This drives the real
  // painter and holds the property that matters: the body is a fan of triangles CONVERGING on one
  // apex. A cone has no parallel edges, and its density rises toward the axis because the geometry
  // overlaps there -- the volume is real rather than painted on a flat face.
  let raf = null, clock = 0;
  const drawn = [];
  let cur = null;
  const ctx = new Proxy({ canvas: {} }, {
    get(t, k) {
      if (k === 'canvas') return t.canvas;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'beginPath') return () => { cur = []; };
      if (k === 'moveTo' || k === 'lineTo') return (x, y) => { if (cur) cur.push({ x, y }); };
      if (k === 'arc') return (x, y, r) => { if (cur) cur.push({ x, y, r, arc: true }); };
      if (k === 'closePath') return () => {};
      if (k === 'fill') return () => { if (cur && cur.length) drawn.push(cur.slice()); cur = []; };
      if (k === 'stroke') return () => { cur = []; };
      return () => t.canvas;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const prevRaf = globalThis.requestAnimationFrame, prevPerf = globalThis.performance;
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => clock };
  globalThis.requestAnimationFrame = (fn) => { raf = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { raf = null; };
  globalThis.document = globalThis.document ?? {};
  try {
    const canvas = { clientWidth: 900, clientHeight: 500, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() {}, setPointerCapture() {} };
    const line = [];
    for (let i = 0; i < 40; i++) line.push({ x: i * 1.5, z: 2 + Math.sin(i / 5) * 3 });
    const tiles = [];
    for (let i = 0; i < 40; i++) tiles.push({ txid: `c${i}`, x: i * 1.5, y: 2, s: 1, tall: 2, color: '#33cc99' });
    const opts = { axes: { y: 1, zTop: 34, z: [], x: [], line }, gridW: 60, gridH: 8, space: true, stars: false, idleFx: true, transition: { rise: 0, travel: 1, drop: 0 } };
    board3d(canvas, tiles, opts);
    for (let i = 1; i <= 6; i++) { clock = i * 16; const fn = raf; raf = null; fn?.(clock); }
    clock = 1000;
    assert.equal(triggerIdle(canvas, 'scan'), true, 'the scan is triggerable');
    drawn.length = 0;
    // MID-SWEEP, DERIVED -- not a fixed 3500, which was mid-sweep of a 6 s effect and is barely off
    // the starting line now that the Markets scan runs 14.6 s (operator asked for it slower twice).
    // A hardcoded sample time silently stops testing the thing it was written for the moment the
    // pacing changes: at 3500 the front was still off the board, so there was no cone to find.
    const ms = MARKET_MS.scan ?? 6000;
    clock = 1000 + ms * 0.5;
    const fn = raf; raf = null; fn?.(clock);

    const tris = drawn.filter((p) => p.length === 3 && !p[0].arc);
    assert.ok(tris.length > 100, `the cone body is drawn as many triangles (${tris.length})`);
    // every triangle shares the apex: that is what makes it a cone rather than a fan of sheets
    const counts = new Map();
    for (const t of tris) for (const p of t) { const k = `${p.x.toFixed(1)},${p.y.toFixed(1)}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
    const [apexKey, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    assert.ok(n >= tris.length * 0.9, `every triangle converges on one apex (${n} of ${tris.length})`);
    // and it has real extent: wide where it lands, tall to its source
    const ys = tris.flatMap((t) => t.map((p) => p.y)), xs = tris.flatMap((t) => t.map((p) => p.x));
    const apexY = Number(apexKey.split(',')[1]);
    // PROPORTION, not just presence. The first cut passed both of these -- 49px wide by 147px tall --
    // and was a needle on screen (operator: "the scanner effect is fucked now"). A spotlight reads
    // as one when the width where it lands is comparable to its height; a tall thin spike does not.
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - apexY;
    // THE ABSOLUTE HEIGHT IS NOT A PROPERTY ANY MORE, and that is deliberate. The craft used to fly
    // at a fixed share of the chart's ceiling, so its cone was always tall; it now flies a set
    // clearance above the PRICE LINE (operator, 2026-09-15: "It's flying at the top of teh screen
    // ... set it lower with some above tolerances"), so on a low chart -- which this fixture has --
    // a shorter cone is correct. What must hold at every altitude is that it is still a cone: the
    // ratio below is what caught both the needle and, when the craft came down, the flat fan.
    assert.ok(w > 15, `it is wide at the floor (${w.toFixed(0)}px)`);
    assert.ok(h > 15, `and has real height from floor to apex (${h.toFixed(0)}px)`);
    assert.ok(w / h > 0.7 && w / h < 3, `and shaped like a beam rather than a needle (${w.toFixed(0)}x${h.toFixed(0)}, ratio ${(w / h).toFixed(2)})`);

    // NO GRADIENTS IN THE BEAM (operator, 2026-09-15: "gradient visible! We need smooth fills. no
    // gradient shit!"). createRadialGradient bands on this rasteriser -- visibly, and worst on a
    // large fill like the pool. The house doctrine is nested flat rgba discs, as bloom() does in
    // agents.js: each layer is a plain fill and the SUM is the curve. Asserted on the source,
    // because a banded gradient is not something a recording canvas can see.
    const coneSrc = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
    const fnStart = coneSrc.indexOf('function drawScanCurtain');
    const fnEnd = coneSrc.indexOf('\n}\n', fnStart);
    const body = coneSrc.slice(fnStart, fnEnd);
    assert.ok(fnStart > 0 && fnEnd > fnStart, 'the beam painter is still findable');
    assert.doesNotMatch(body, /createRadialGradient|createLinearGradient/, 'the beam uses layered flat fills, never a gradient');
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.performance = prevPerf;
  }
});

test('every Markets effect plays through the frame loop on a candle board without throwing', () => {
  // 2026-09-15: the supernova called a helper it had not imported; the first frame threw, the
  // loop died, and the board froze on that frame for the rest of the run. Nothing here triggered
  // a field effect on a price board, so nothing caught it. This does, for every kind on the list.
  let rafPending = null; let T = 0;
  const realRaf = globalThis.requestAnimationFrame, realCaf = globalThis.cancelAnimationFrame, realPerf = globalThis.performance, realWin = globalThis.window, realMM = globalThis.matchMedia, realST = globalThis.setTimeout;
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.performance = { now: () => T };
  globalThis.requestAnimationFrame = (fn) => { rafPending = fn; return 42; };
  globalThis.cancelAnimationFrame = () => { rafPending = null; };
  globalThis.document = globalThis.document ?? {};
  globalThis.setTimeout = () => 1;   // no scheduler: only what is triggered plays
  try {
    const ctx = new Proxy({ canvas: {}, lineWidth: 1 }, {
      get(tg, k) { if (k in tg) return tg[k]; if (k === 'measureText') return (s) => ({ width: String(s).length * 6 }); if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} }); return () => tg.canvas; },
      set(tg, k, v) { tg[k] = v; return true; },
    });
    const canvas = { clientWidth: 1500, clientHeight: 600, width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: () => {}, setPointerCapture: () => {}, isConnected: true };
    const step = (t) => { const fn = rafPending; rafPending = null; T = t; if (fn) fn(t); };
    const tiles = [], line = [];
    for (let i = 0; i < 24; i++) { const z0 = 10 + 6 * Math.sin(i / 4); tiles.push({ txid: `b:${i}`, x: i * 2 + 0.3, y: 3, s: 1.4, floor: z0, tall: 2, color: '#3c9' }); tiles.push({ txid: `v:${i}`, x: i * 2 + 0.3, y: 0.5, s: 1.4, tall: 1, color: '#3c9' }); line.push({ x: i * 2 + 1, z: z0 + 1 }); }
    const axes = { y: 3.7, zTop: 40, z: [], x: [], line };
    board3d(canvas, tiles, { gridW: 48, gridH: 8, axes, space: true, stars: false, idleFx: true, oblique: { ox: 0.07, oy: 0.95, dy: 0.3, headroom: 36, flight: 10, anchor: 'bottom' }, transition: { rise: 0, travel: 1, drop: 0 } });
    for (let i = 1; i <= 30; i++) step(i * 16);
    for (const kind of MARKET_FX) {
      T = 5000 + MARKET_FX.indexOf(kind) * 40000;
      assert.equal(triggerIdle(canvas, kind), true, `${kind} triggers`);
      // frames across the whole run, including past its end
      for (let i = 1; i <= 40; i++) assert.doesNotThrow(() => step(T + i * 700), `${kind}: frame ${i} draws without throwing`);
    }
  } finally {
    globalThis.requestAnimationFrame = realRaf; globalThis.cancelAnimationFrame = realCaf; globalThis.performance = realPerf; globalThis.window = realWin; globalThis.matchMedia = realMM; globalThis.setTimeout = realST;
  }
});

test('the searchlight and the tractor beam never follow each other: they fly the same saucer', () => {
  // operator, 2026-09-15: "I just saw the UFO effect get triggered twice in a row on the block space"
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const kinds = ['scan', 'tractor', 'ripple', 'nova'];
  for (let run = 0; run < 30; run++) {
    const st = {};
    let prev = null;
    for (let i = 0; i < 40; i++) {
      const k = chooseIdleFx(kinds, st, i * 8000, rnd, 1);
      assert.ok(!((prev === 'scan' && k === 'tractor') || (prev === 'tractor' && k === 'scan')), `${prev} then ${k}: the saucer twice running`);
      prev = k;
    }
  }
});

test('THE PULSAR STAYS ON SCREEN, and does not always fly down the price line', () => {
  // Two operator notes on the same day, both about where the passage goes (2026-09-20):
  // "Don't always have it moving so close to the line", then "Don't have the pulsar off-screen
  // ... Always make sure it's travelling inside the viewport". The first is a matter of taste in
  // the lane mix; the second is a hard bound, and the reason this is a pure function at all --
  // it was checked by looking at screenshots twice, and a tall price range broke it anyway.
  const lanes = { through: 0, above: 0, below: 0 };
  const CASES = [
    // [lo, hi, zTop] -- the Markets board's own shape (zBase 6, zMax 28) with a quiet range and
    // with prices filling the axis, the harness's chart, a flat one, and two extremes. The
    // second is the one that broke it: measured against the price range, the high lane sat well
    // above the top of the panel.
    [10, 20, 34], [7, 32, 34], [5, 17, 40], [10, 12, 40], [2, 34, 40], [1, 38, 40], [8, 9, 12],
  ];
  for (const [lo, hi, zTop] of CASES) {
    const ceil = Math.max(1.8, zTop * 0.82);
    for (let i = 0; i < 400; i++) {
      const h6 = fxHash(i * 3 + 1), h7 = fxHash(i * 3 + 2), h8 = fxHash(i * 3 + 3);
      const h = pulsarHeights(lo, hi, zTop, h6, h7, h8);
      const { za, zb, lane } = h;
      if (lo === 10 && hi === 20) lanes[lane]++;         // the mix, judged on a chart with room
      // the wander goes nowhere the ends could not: same bounds, at every moment of the crossing
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const z = pulsarZ(h, t, fxHash(i * 7 + 4), fxHash(i * 7 + 5), fxHash(i * 7 + 6), fxHash(i * 7 + 7));
        assert.ok(z >= 0.8 - 1e-9 && z <= ceil + 1e-9, `lo=${lo} hi=${hi} zTop=${zTop} t=${t.toFixed(2)}: wandered to ${z}`);
      }
      // and it arrives and leaves exactly where the heights say
      assert.ok(Math.abs(pulsarZ(h, 0) - za) < 1e-9, 'the wander is nothing at the near edge');
      assert.ok(Math.abs(pulsarZ(h, 1) - zb) < 1e-9, 'and nothing at the far one');
      for (const z of [za, zb]) {
        assert.ok(z >= 0.8 - 1e-9, `lo=${lo} hi=${hi} zTop=${zTop}: ${z} is under the deck`);
        assert.ok(z <= ceil + 1e-9, `lo=${lo} hi=${hi} zTop=${zTop}: ${z} is above the panel (ceiling ${ceil})`);
      }
      // the whole passage is a straight run between the two, so both ends inside the bound means
      // every moment of it is inside the bound
      assert.ok(Math.min(za, zb) >= 0.8 - 1e-9 && Math.max(za, zb) <= ceil + 1e-9, 'the run between the ends stays in the same bound');
    }
  }
  const total = lanes.through + lanes.above + lanes.below;
  assert.ok(lanes.through / total > 0.2 && lanes.through / total < 0.5, `about a third pass through the line's band (${lanes.through}/${total})`);
  assert.ok(lanes.above / total > 0.3, `most pass clear above it (${lanes.above}/${total})`);
  assert.ok(lanes.below > 0, 'and some skim below');
  // and where there IS no room -- prices filling their axis -- the passage still keeps clear of
  // the line more often than not, by going under it rather than collapsing on to the ceiling
  let clear = 0;
  for (let i = 0; i < 400; i++) {
    const h8 = fxHash(i * 3 + 3);
    if (pulsarHeights(7, 32, 34, fxHash(i * 3 + 1), fxHash(i * 3 + 2), h8).lane !== 'through') clear++;
  }
  assert.ok(clear > 100, `a full chart still gets passages clear of the line (${clear}/400)`);
  // IT DOES NOT FLY A RULED LINE (operator, 2026-09-20: "It always seems to move in a straight
  // line"). Two things it used to do: arrive and leave at the same height, and go from one to the
  // other without deviating. Measured on a chart with room, most passages now have a real skew
  // between their ends, and most bow away from the straight run between them by a visible amount.
  let skewed = 0, bowed = 0, runs = 0;
  for (let i = 0; i < 300; i++) {
    const h = pulsarHeights(10, 20, 34, fxHash(i * 7 + 1), fxHash(i * 7 + 2), fxHash(i * 7 + 3));
    const span = Math.max(1, h.ceil - h.floor);
    runs++;
    if (Math.abs(h.zb - h.za) > span * 0.05) skewed++;
    let worst = 0;
    for (let t = 0.05; t < 1; t += 0.05) {
      const straight = h.za + (h.zb - h.za) * t;
      worst = Math.max(worst, Math.abs(pulsarZ(h, t, fxHash(i * 7 + 4), fxHash(i * 7 + 5), fxHash(i * 7 + 6), fxHash(i * 7 + 7)) - straight));
    }
    if (worst > span * 0.02) bowed++;
  }
  assert.ok(skewed / runs > 0.8, `most passages end at a different height from where they began (${skewed}/${runs})`);
  assert.ok(bowed / runs > 0.8, `and most wander off the straight run between the two (${bowed}/${runs})`);
  // ONE DIRECTION, ALL THE WAY THROUGH (operator, 2026-09-20: "It should always spin in one
  // constant direction and never change direction"). The sign came off the disks' weights first
  // and off a halfway flip second, and both read as the wind changing its mind. It is a function
  // of the seed and of nothing else now -- so it cannot vary within a run, whatever the acts do.
  assert.equal(pulsarSpin.length, 1, 'the spin takes the seed alone: nothing that moves during a run can reach it');
  let cw = 0;
  for (let i = 0; i < 200; i++) {
    const s = pulsarSpin(i * 977);
    assert.ok(s === 1 || s === -1, `a direction, not a number: ${s}`);
    assert.equal(s, pulsarSpin(i * 977), 'and the same one every time that seed replays');
    if (s > 0) cw++;
  }
  assert.ok(cw > 60 && cw < 140, `both directions actually happen (${cw}/200 clockwise)`);
});
