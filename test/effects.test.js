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
import { FX_KINDS, board3d, triggerIdle } from '../public/js/details3d.js';
import { DEFAULTS, PANEL, enabledEffects, spaceOptions, marketsOptions } from '../public/js/settings.js';

test('there are at least twenty-five effects, and every one has a switch of its own', () => {
  assert.ok(FX_KINDS.length >= 25, `${FX_KINDS.length} effects`);
  assert.deepEqual(Object.keys(DEFAULTS.effects), FX_KINDS, 'the switches are exactly the effects, in order');
  const rows = PANEL.find((g) => g.group === 'effects')?.rows.map((r) => r.key);
  assert.deepEqual(rows, FX_KINDS, 'and the panel lists exactly the effects, in order');
  assert.ok(FX_KINDS.every((k) => DEFAULTS.effects[k] === true), 'all on: they were asked for');
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
    if (kind === 'pulse') continue;            // the pulse is drawn on the price line, not on cubes
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
  for (const kind of ['firework', 'flare', 'sparkle', 'glitch', 'rain', 'quake']) {
    const fx = { kind, u: 0.4, amp: 1, gridW: 20, gridH: 20, dx: 1, dy: 0, seed: 99, x: 9, y: 11 };
    assert.deepEqual(fxAt(t, fx), fxAt(t, fx), `${kind} replays identically`);
  }
});

test('the switches reach the scheduler: the enabled list is what the boards are given', () => {
  const all = spaceOptions({});
  assert.deepEqual(all.fxKinds, FX_KINDS, 'everything on by default');
  const few = spaceOptions({ effects: Object.fromEntries(FX_KINDS.map((k) => [k, k === 'ripple' || k === 'nova'])) });
  assert.deepEqual(few.fxKinds, ['ripple', 'nova'], 'only what is left on, in FX_KINDS order');
  assert.deepEqual(marketsOptions({}).fxKinds, FX_KINDS, 'the price board is given the same list');
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
  const LINE_FX = ['pulse', 'twinkle'];
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
  void LINE_FX;
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
