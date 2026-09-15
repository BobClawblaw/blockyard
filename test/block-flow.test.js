// The pipeline moves. The value of the motion is that it means something: it steps when a
// block arrives and stays still when a frame merely repaints -- and this page repaints
// once a second, so the difference between those two cases is the whole feature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flowMotion, railSeconds, flowFrame, templateDrift, tipFreshness, agoText } from '../public/js/mining.js';

test('a repaint of the same tip earns no motion', () => {
  assert.deepEqual(flowMotion(966267, 966267), { shift: false, arrived: null }, 'a once-a-second replay would drain all meaning from the animation');
  assert.deepEqual(flowMotion(966268, 966267), { shift: false, arrived: null }, 'a reorg backwards is not an arrival');
});

test('a new height earns exactly one arrival, on the card that is new', () => {
  const m = flowMotion(966267, 966268);
  assert.equal(m.shift, true);
  assert.equal(m.arrived, 966268, 'the class goes on the arriving card, not the whole row');
  const jump = flowMotion(966260, 966264);
  assert.equal(jump.arrived, 966264, 'a gap of several blocks still names the tip');
});

test('the first render earns no motion', () => {
  assert.deepEqual(flowMotion(undefined, 966268), { shift: false, arrived: null }, 'a page loading must not pretend a block just landed');
  assert.deepEqual(flowMotion(null, 966268), { shift: false, arrived: null });
});

test('rail speed comes from the measured gap and stays inside a visible range', () => {
  assert.equal(railSeconds(600), 24, 'a 10-minute gap');
  assert.equal(railSeconds(120), 12, 'fast chain, faster rail, clamped at the bottom');
  assert.equal(railSeconds(7200), 240, 'a stalled chain, slow rail, clamped at the top');
  assert.equal(railSeconds(null), 24, 'no measurement yet: the 10-minute default, stated on the page');
  assert.equal(railSeconds(0), 24, 'zero is not a measurement of instant blocks');
});

test('the centre comes from the chain tip, not from whatever was attributed last', () => {
  // The case that produced the bug: attribution trails the tip by a block or several, and
  // the newest attributed row was being treated as "the current block".
  const recent = [{ height: 900 }, { height: 899 }, { height: 898 }];
  const f = flowFrame({ tipHeight: 903, recent });
  assert.equal(f.tip.height, 903, 'the tip is the tip');
  assert.equal(f.tip.row, null, 'no coinbase read for it yet, so no fake card');
  // History always shows eight heights behind the tip, so the unattributed count is the
  // tip plus the five heights with no row -- said out loud, never by leaving gaps.
  assert.equal(f.unattributed, 6, 'tip + five empty heights are counted, not hidden');
  assert.deepEqual(f.history.map((h) => h.height), [902, 901, 900, 899, 898, 897, 896, 895],
    'heights are generated downward from the tip, newest nearest the centre, oldest far right');
});

test('heights are matched by height, so a full window renders normally', () => {
  const recent = [10, 9, 8, 7, 6].map((h) => ({ height: h }));
  const f = flowFrame({ tipHeight: 10, recent });
  assert.equal(f.tip.row.height, 10);
  assert.equal(f.unattributed, 4, 'heights 5..2 have never been attributed, and the cards will say so');
  assert.deepEqual(f.history.slice(0, 4).map((h) => h.row?.height ?? null), [9, 8, 7, 6]);
});

test('a template that is no longer the next block is called stale', () => {
  assert.deepEqual(templateDrift(904, 903), { known: true, behind: 0, ok: true, stale: false });
  const stale = templateDrift(902, 903);
  assert.equal(stale.stale, true, 'the node mined on since this template was read');
  assert.equal(stale.behind, -2);
  assert.equal(templateDrift(null, 903).known, false, 'no template is not the same as a stale one');
});

test("the verdict is measured against this chain's own interval, not a fixed clock", () => {
  // Blocks here arrive every ~9 min, so a 7-minute-old tip is NORMAL. Calling it late
  // cried wolf on the one colour on the page that people act on.
  const gap = 540;
  assert.equal(tipFreshness({ arrivalSec: 30, avgGapSec: gap }).level, 'fresh');
  assert.equal(tipFreshness({ arrivalSec: 420, avgGapSec: gap }).level, 'fresh', '7 min with a 9 min average is on time');
  assert.equal(tipFreshness({ arrivalSec: 545, avgGapSec: gap }).level, 'late', 'past one average gap');
  assert.equal(tipFreshness({ arrivalSec: 850, avgGapSec: gap }).level, 'overdue', '1.5x the average: a block is properly due');
  assert.equal(tipFreshness({ arrivalSec: 30, avgGapSec: gap }).basis, 'arrival');
  // A chain that suddenly looks fast is not trusted below the 4/8 minute floor.
  assert.equal(tipFreshness({ arrivalSec: 100, avgGapSec: 30 }).lateAt, 240);
  assert.equal(tipFreshness({ arrivalSec: 300, avgGapSec: 7200 }).lateAt, 7200, 'a slow chain gets its own allowance');
  assert.equal(tipFreshness({ arrivalSec: 1080, avgGapSec: 600 }).level, 'overdue', '18 min on a 10 min chain is overdue');
});

test('block time is only a fallback, and it says so', () => {
  const f = tipFreshness({ ageSec: 600, avgGapSec: 240 });   // a chain where 10 min is two gaps
  assert.equal(f.level, 'overdue');
  assert.equal(f.basis, 'block time', 'this page has not watched a block arrive yet');
  assert.equal(tipFreshness({}).level, 'n/a');
  // Witnessed arrival is authoritative: the page saw the block land, so a timestamp two
  // and a half hours old is a timestamp artefact, not an age. (The bug was the reverse --
  // first paint used to count as a witnessed arrival, which made a 14-minute-old tip read
  // as just-found. flowMotion/blockFlow no longer grant that.)
  assert.equal(tipFreshness({ arrivalSec: 60, ageSec: 9000 }).basis, 'arrival', 'witnessed arrival is the age');
  // A minute old by our own watch, with a 200-second timestamp, is a minute old.
  assert.equal(tipFreshness({ arrivalSec: 10, ageSec: 200 }).level, 'fresh', 'late timestamps are normal, not lateness');
  assert.equal(tipFreshness({ ageSec: 420, avgGapSec: 540 }).level, 'fresh', 'on time for this chain');
});

test('the judgement is refused where it would lie', () => {
  assert.equal(tipFreshness({ ageSec: 24000, ibd: true }).level, 'n/a', 'a six-hour-old tip during a reindex is not a warning');
  assert.equal(tipFreshness({ ageSec: 900, online: false }).level, 'n/a', 'the node is not answering; we know nothing');
  assert.equal(tipFreshness({ ageSec: 900, paused: true }).level, 'n/a', 'updates are frozen, so age is not a fact about the chain');
  assert.match(tipFreshness({ ageSec: 1, ibd: true }).why, /initial download/);
});

test('times read at a glance and never pretend to precision the data lacks', () => {
  const now = Date.UTC(2026, 8, 9, 12, 0, 0);
  assert.equal(agoText(now - 30 * 1000, now), 'just now');
  assert.equal(agoText(now - 75 * 1000, now), '1m ago');
  assert.equal(agoText(now - 12 * 60 * 1000, now), '12m ago');
  assert.equal(agoText(now - 3 * 3600 * 1000, now), '3.0h ago');
  assert.equal(agoText(now - 2 * 86400 * 1000, now), '2d ago');
  assert.equal(agoText(null, now), null, 'no time, no claim');
  assert.equal(agoText(now + 600 * 1000, now), 'just now', 'a clock ahead is not a negative age');
});

test('a tip cannot be coloured greener than its own timestamp allows', () => {
  // The bug this pins: the page had just painted, so its arrival timer said "5 seconds",
  // while the block in the centre was mined 14 minutes ago. Green meant "just found" and
  // was wrong -- and this is the colour the whole page is read by.
  // The bug, stated as data: a page that had only just painted was treated as having
  // watched the block arrive, so arrivalSec was ~0 and a 14-minute-old tip went green.
  // With no witnessed arrival there is no arrivalSec at all, and the timestamp decides.
  const noWitness = tipFreshness({ ageSec: 840, avgGapSec: 300 });   // 840 s is past two 5-min gaps
  assert.equal(noWitness.level, 'overdue', '14 minutes old is overdue, tab timer or not');
  assert.equal(noWitness.basis, 'block time', 'and the card says which clock decided');

  // Where arrival says the block is older than its timestamp, arrival is the age.
  const older = tipFreshness({ arrivalSec: 900, ageSec: 60 });
  assert.equal(older.seconds, 900);
  assert.equal(older.basis, 'arrival');

  // First paint has no arrival at all, so the timestamp decides and says so.
  const first = tipFreshness({ ageSec: 300 });
  assert.equal(first.level, 'late');
  assert.equal(first.basis, 'block time');
});

// The pending/done divider (shaped after mempool.space's block train): ONE vertical
// arrow-line separating the work in progress from the work the network accepted.
// Order along the row: forecasts (far left) → the block being assembled (immediately
// left of the divider) → the divider → the tip and receding history. History fills the
// row instead of being capped to a narrow reservation.
test('the divider is one line; assembled block, then done, in that order', async () => {
  const { blockFlow } = await import('../public/js/mining.js');
  const fmt = { num: (n) => String(n ?? '–'), bytes: (n) => String(n ?? '–'), esc: (s) => String(s ?? ''), ago: () => '–', rate: (v) => String(v ?? '–'), satPerVb: (v) => String(v ?? '–'), ageSec: () => '–', pct: (n) => String(n ?? '–') };
  const el = { clientWidth: 900, innerHTML: '' };
  const recent = [
    { height: 966294, time: 1788000000, at: 1788000000000, tagText: 'pool x', txs: 1200, weight: 3_000_000, totalfee: 50000, hash: 'aa' },
    { height: 966293, time: 1787999400, at: 1787999400000, tagText: 'pool y', txs: 900, weight: 2_500_000, totalfee: 40000, hash: 'bb' },
  ];
  blockFlow(el, { tipHeight: 966294, recent, next: { height: 966295, txCount: 3000, weight: 1_200_000, weightLimit: 4_000_000, weightPct: 30, totalFeesSat: 90000, at: Date.now(), ms: 1300, economy: { ahead: [{ offset: 2, bytes: 300000, spillRate: 0.5 }, { offset: 3, bytes: null, spillRate: 0.5 }] } }, avgGapSec: 600 }, fmt);
  const html = el.innerHTML;
  const seps = (html.match(/class="flowsep"/g) ?? []).length;
  assert.equal(seps, 1, `exactly one divider line, got ${seps}`);
  assert.match(html, /flowsep-arrow up/, 'the divider has an up arrowhead');
  assert.match(html, /flowsep-arrow down/, 'and a down arrowhead');
  assert.ok(!html.includes('flowarrow'), 'no leftover horizontal flow arrows');
  assert.match(html, /flowside todo/, 'a pending zone exists');
  assert.match(html, /flowside done/, 'a done zone exists');
  // along the row: forecast slivers FIRST (far left), then the assembled block, then
  // the divider, then the done zone. Position in the markup IS the left-to-right order
  // (the zones are flex rows).
  // 2026-09-11 the forecast slivers were removed entirely (see the test below),
  // so the pending side is the assembled block and nothing else.
  const builtIdx = html.indexOf('being built');
  const sepIdx = html.indexOf('flowsep');
  const doneIdx = html.indexOf('flowside done');
  assert.ok(builtIdx >= 0 && builtIdx < sepIdx && sepIdx < doneIdx,
    `order must be assembled(${builtIdx}) < divider(${sepIdx}) < done(${doneIdx})`);
  // the assembled block is IMMEDIATELY left of the divider: after its card opens, no
  // other card may appear before the divider
  const betweenBuiltAndSep = html.slice(builtIdx, sepIdx);
  assert.ok((betweenBuiltAndSep.match(/bcard /g) ?? []).length === 0,
    'no card sits between the assembled block and the divider');
  assert.ok(!html.slice(doneIdx).includes('not yet assembled'),
    'the done side holds only confirmed work');
});

test('history fills the row — the old 400px reservation cap is gone', async () => {
  // The old code reserved ~400px of a 900px panel for next+tip+arrows and capped
  // history at what fit the remainder, so on a wide panel the mined side stopped short
  // of the divider and the forecast cards were jammed against it. The cap's job now
  // belongs to the horizontal scroll; the markup must render the full frame.
  const { blockFlow } = await import('../public/js/mining.js');
  const fmt = { num: (n) => String(n ?? '–'), bytes: (n) => String(n ?? '–'), esc: (s) => String(s ?? ''), ago: () => '–', rate: (v) => String(v ?? '–'), satPerVb: (v) => String(v ?? '–'), ageSec: () => '–', pct: (n) => String(n ?? '–') };
  const el = { clientWidth: 900, innerHTML: '' };
  const recent = Array.from({ length: 8 }, (_, i) => ({ height: 966294 - i, time: 1788000000 - i * 600, at: (1788000000 - i * 600) * 1000, tagText: 'p', txs: 1, weight: 3_000_000, totalfee: 1, hash: 'h' + i }));
  blockFlow(el, { tipHeight: 966294, recent, avgGapSec: 600 }, fmt);
  const html = el.innerHTML;
  const histCards = (html.slice(html.indexOf('flowside done')).match(/bcard/g) ?? []).length;
  assert.ok(histCards >= 7, `a full 8-block frame renders (got ${histCards} cards on the done side; the frame is 1 tip + 8)`);
  assert.ok(!html.includes('scroll for more'), 'no "N older / scroll for more" chip — the whole frame is in the row, scrolling shows it');
});

test('the 3D slab depth is NOT a decoration we claim', async () => {
  // The operator's call: no 3D depth on the rendered blocks — flat cards with their
  // pool-coloured edge. What the train keeps is the DIVIDER (pending | done) and the
  // scroll geometry. This asserts the depth treatment stays out, so a future refactor
  // re-adding it is a deliberate decision, not an accident.
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  // 2026-09-10 this asserted that cards carry NO depth at all, because the depth
  // they had then was a ::before lip hanging BELOW the card and the row's own
  // overflow clipped it into a smear. 2026-09-11 the operator asked for depth
  // back ("actual blocks with some depth"). The requirement is therefore not
  // "no depth" but "depth that nothing can clip": painted inside the border box,
  // with a cast shadow small enough to live in the row's gap.
  assert.ok(!/\.bcard::before \{[^}]*top: 100%/.test(css), 'still no bottom-lip ::before on cards');
  const depth = /\.bcard \{\s*\n\s*border-radius[^}]*\}/.exec(css);
  assert.ok(depth, 'the card carries a depth rule');
  assert.match(depth[0], /box-shadow:/, 'and that depth is a shadow, not a transform that would need room');
  // only the CAST layers matter here; inset layers cannot escape the box by
  // definition, and it was an inset that made the first version of this
  // assertion report a 16px overhang that does not exist.
  const value = /box-shadow:([^;]*);/.exec(depth[0])[1];
  const cast = value.split(/\),/).map((s) => s.trim()).filter((s) => !/inset/.test(s));
  assert.ok(cast.length >= 1, 'there is at least one cast shadow');
  const offsets = cast.map((s) => Math.abs(Number(/^(-?\d+)px/.exec(s)?.[1] ?? 0)));
  assert.ok(Math.max(...offsets) <= 8, `cast shadow stays inside the row gap, got ${Math.max(...offsets)}px`);
  // ...but the divider's own rules and the scroll padding (which the row needs to clip
  // nothing) stay.
  assert.match(css, /\.flowsep-line \{/, 'the divider line rule is present');
  assert.match(css, /\.flowwrap \{[^}]*overflow-x: auto/, 'the train row still scrolls');
});

test('the train scrolls from the divider, with the assembled block left of it', async () => {
  const { blockFlow } = await import('../public/js/mining.js');
  const fmt = { num: (n) => String(n ?? '–'), bytes: (n) => String(n ?? '–'), esc: (s) => String(s ?? ''), ago: () => '–', rate: (v) => String(v ?? '–'), satPerVb: (v) => String(v ?? '–'), ageSec: () => '–', pct: (n) => String(n ?? '–') };
  // a stub element with the scroll API the first render uses (scrollTo/scrollLeft)
  const scrolls = [];
  const el = {
    clientWidth: 900, innerHTML: '',
    get scrollLeft() { return this._sl ?? 0; }, set scrollLeft(v) { this._sl = v; scrolls.push(v); },
    scrollTo: (opts) => scrolls.push(opts?.left ?? opts),
    getBoundingClientRect: () => ({ left: 0 }),
    querySelector: (sel) => (sel === '.flowsep' ? { getBoundingClientRect: () => ({ left: 540 }) } : null),
  };
  const recent = Array.from({ length: 8 }, (_, i) => ({ height: 966294 - i, time: 1788000000 - i * 600, at: (1788000000 - i * 600) * 1000, tagText: 'p', txs: 1, weight: 3_000_000, totalfee: 1, hash: 'h' + i }));
  blockFlow(el, { tipHeight: 966294, recent, next: { height: 966295, txCount: 3000, weight: 1_200_000, weightLimit: 4_000_000, weightPct: 30, totalFeesSat: 90000, at: Date.now(), ms: 1300, economy: { ahead: [{ offset: 2, bytes: 300000, spillRate: 0.5 }] } }, avgGapSec: 600 }, fmt);
  // the assembled block is immediately left of the divider: the LAST card in the todo
  // zone is the assembled one (forecasts, if any, sit left of it). "being built" also
  // appears in the zone label, so compare positions inside the zone slice.
  const html = el.innerHTML;
  const todo = html.slice(html.indexOf('flowside todo'), html.indexOf('flowsep'));
  assert.ok(todo.indexOf('bcard ghost') === -1 || todo.indexOf('bcard ghost') < todo.lastIndexOf('class="bcard next'),
    'the card nearest the divider on the pending side is the assembled block');
  // history now fills the row (not capped to a 400px reservation) — a full frame reaches
  // the divider from the right without a scroll on a 900px panel
  assert.ok((html.slice(html.indexOf('flowside done')).match(/bcard/g) ?? []).length >= 4,
    'the done zone carries the tip plus a full row of history');
  // the first render parks the scroll at the divider
  assert.ok(scrolls.length > 0 && scrolls[scrolls.length - 1] >= 0,
    'blockFlow scrolled the row to the divider on first render');
});

test('renderMining paints the flow, the packages and the pools, and no longer the pool viewer', async () => {
  // The canvas kit reads window/matchMedia the way a browser does; the drawing itself is
  // proxied into nothing, because this test is about the WORDS beside the picture.
  globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: true }) };
  globalThis.matchMedia = globalThis.matchMedia ?? (() => ({ matches: true }));
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame ?? ((fn) => 0);
  globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame ?? (() => {});
  globalThis.performance = globalThis.performance ?? { now: () => 0 };
  const { renderMining } = await import('../public/js/mining.js');
  const mk = (dist) => {
    const notes = {};
    const doc = globalThis.document;
    const wanted = { gnMempoolNote: 'mempool', mnPools: 'table', mnFlow: 'flow', mnPackages: 'pkg', mnCoverage: 'cov', mnFeeLandscape: 'cv', gnMempoolTreemap: 'cv' };
    const el = (id) => {
      const node = wanted[id] === 'cv'
        ? { clientWidth: 600, clientHeight: 200, width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: () => () => undefined, set: () => true }), addEventListener() {}, parentElement: null }
        : { innerHTML: '', textContent: '', style: {}, addEventListener() {}, querySelector: () => null, closest: () => null, classList: { add() {}, toggle() {}, remove() {} }, getContext: () => new Proxy({}, { get: () => () => undefined, set: () => true }) };
      if (wanted[id]) notes[id] = node;
      return node;
    };
    globalThis.document = { getElementById: (id) => el(id), querySelector: () => el('x'), querySelectorAll: () => [], createElement: (t) => el(t) };
    const state = { page: 'mining', mempoolDist: dist, paused: false, series: {} };
    const h = { canvas: (id) => el(id), fmt: { num: (n) => String(n ?? '–'), bytes: (n) => String(n ?? '–'), esc: (s) => String(s ?? ''), ago: () => '–', rate: (v) => String(v ?? '–'), satPerVb: (v) => String(v ?? '–'), ageSec: () => '–', pct: (n) => String(n ?? '–') }, charts: {}, setText: () => {}, renderFeed: () => {}, nextBlock: () => {}, mempoolDetail: () => {} };
    renderMining({ attribution: { nextBlock: null, recent: [], byPool: [] }, mempool: { count: dist?.count ?? 0 } }, state, h);
    globalThis.document = doc;
    return notes;
  };
  // the Mempool space viewer left the Mining page on 2026-09-15 (it is on Overview, Block space and
  // Mempool): renderMining paints the flow, the packages and the pools without touching it
  const painted = mk({ cells: [{ vbytes: 500, rate: 12 }, { vbytes: 900, rate: 1, aggregate: 40 }], totalVsize: 1400, count: 42 });
  assert.equal(painted.gnMempoolNote, undefined, 'the viewer\'s note is never asked for');
  assert.equal(painted.gnMempoolTreemap, undefined, 'nor its canvas');
  assert.ok(painted.mnFlow && painted.mnPackages && painted.mnPools, 'the rest of the page is painted');
});

const FMT = { num: (n) => String(n ?? '-'), bytes: (n) => String(n ?? '-'), esc: (s) => String(s ?? ''), ago: () => '-', rate: (v) => String(v ?? '-'), satPerVb: (v) => String(v ?? '-'), ageSec: () => '-', pct: (n) => String(n ?? '-') };
const ROWS = (n) => Array.from({ length: n }, (_, i) => ({ height: 966294 - i, time: 1788000000 - i * 600, at: (1788000000 - i * 600) * 1000, tagText: 'p', txs: 1, weight: 3e6, totalfee: 1, hash: 'h' + i }));
const TEMPLATE = (economy) => ({ height: 966295, txCount: 3, weight: 1.2e6, weightLimit: 4e6, weightPct: 30, totalFeesSat: 9e4, at: Date.now(), ms: 10, economy });

test('the left of the row is not reserved for the absence of data', async () => {
  // THE BUG (operator: "too much space is wasted on the left side ... empty
  // forecasts that never have activity"). economy.ahead always reports the same
  // fixed offsets, so a quiet chain drew permanent dashed cards reading "nothing
  // queued to reach it" and they OPENED the row.
  const { blockFlow } = await import('../public/js/mining.js');
  const run = (ahead) => {
    const el = { clientWidth: 900, innerHTML: '' };
    blockFlow(el, { tipHeight: 966294, recent: ROWS(1), next: TEMPLATE({ ahead }), avgGapSec: 600 }, FMT);
    return el.innerHTML;
  };

  // Filtering to the ones with bytes behind them was tried first and changed
  // nothing on a live chain -- the queue always reaches three blocks out, so all
  // three cards stayed. They are gone outright, both when the queue is empty and
  // when it is deep.
  for (const ahead of [
    [{ offset: 2, bytes: null }, { offset: 3, bytes: 0 }, { offset: 4 }],
    [{ offset: 2, bytes: 300000 }, { offset: 3, bytes: 900000 }, { offset: 4, bytes: 2e6 }],
  ]) {
    const html = run(ahead);
    assert.ok(!html.includes('bcard ghost'), 'no forecast slivers');
    assert.ok(!html.includes('not yet assembled'), 'and none of their text');
    const todo = html.slice(html.indexOf('flowside todo'), html.indexOf('flowsep'));
    assert.equal((todo.match(/class="bcard/g) ?? []).length, 1,
      'the pending side holds exactly one card: the block being built');
  }

  // the fact they were built on is not lost -- it is on the assembled block's
  // own card, measured, in one line.
  const deep = run([{ offset: 2, bytes: 300000 }]);
  assert.ok(/queue/.test(deep), 'the queue depth is still stated');
});

test('the block being built carries the clock, and the train is a chain', async () => {
  // (operator: "the current block being built does not have a colored outline
  // like it's supposed to for it's time"). The ring says how long THIS block has
  // been accumulating, so it belongs on the work in progress, not on the block
  // that already landed.
  const { blockFlow } = await import('../public/js/mining.js');
  const at = (tipAgeSec) => {
    const el = { clientWidth: 900, innerHTML: '' };
    blockFlow(el, { tipHeight: 966294, recent: ROWS(5), tipAgeSec, avgGapSec: 600, next: TEMPLATE(null) }, FMT);
    return el.innerHTML;
  };
  const nextClass = (html) => /class="bcard next([^"]*)"/.exec(html)?.[1] ?? '';

  assert.match(nextClass(at(60)), /fresh/, 'a minute in, the block being built is green');
  assert.match(nextClass(at(3000)), /overdue/, 'fifty minutes in, it is red');
  assert.ok(!/class="bcard[^"]*tip[^"]*(fresh|late|overdue)/.test(at(3000)),
    'the confirmed tip does not wear the countdown; it is not the block being built');

  // the chain: one link between every pair of cards on the done side
  const html = at(60);
  const done = html.slice(html.indexOf('flowside done'));
  const cards = (done.match(/class="bcard/g) ?? []).length;
  const links = (done.match(/class="chainlink"/g) ?? []).length;
  assert.equal(links, cards - 1, `${cards} blocks means ${cards - 1} links, got ${links}`);
});

test('the block being built fills a meter: one row, lit by weight, coloured by what fills it', async () => {
  // (operator: "That orange wavy part inside the block being built is
  // disjointed and not contiguous across the line when moving. we need to find
  // some other visually interesting way to convey information that the block
  // is growing.") The ticks wrapped onto a second line and their count was
  // sqrt(txCount) -- decoration shaped like a number.
  const { growthMeter, METER_SEGMENTS, blockFlow } = await import('../public/js/mining.js');
  const nb = {
    height: 900, weight: 1_050_000, weightLimit: 4_000_000,
    visual: { cells: [{ vbytes: 60_000, rate: 2 }, { vbytes: 40_000, rate: 50 }, { vbytes: 162_500, rate: 1 }] },
  };
  const m = growthMeter(nb, null, 0);
  const segs = m.html.match(/<i[ >]/g) ?? [];
  assert.equal(segs.length, METER_SEGMENTS, 'exactly one row of fixed segments, so nothing can wrap');
  assert.equal(m.lit, 10, '26.25% of the cap lights 10 of 40');
  assert.match(m.html, /class="edge"><span data-w="50\.0"/, 'the frontier segment fills fractionally');
  const fees = [...m.html.matchAll(/class="on[^"]*" data-fee="([\d.]+)"/g)].map((x) => Number(x[1]));
  assert.equal(fees.length, 10);
  assert.equal(fees[0], 50, 'richest first: the block fills from its best-paying transactions');
  assert.equal(fees.at(-1), 1, 'and runs down to its cheapest');
  for (let i = 1; i < fees.length; i++) assert.ok(fees[i] <= fees[i - 1], 'hot to cool, left to right');
  assert.ok(!/class="on new/.test(m.html), 'a first reading marks nothing as new');

  // growth at the same height lights only the added segments
  const grown = growthMeter({ ...nb, weight: 1_300_000 }, m.lit, 0);
  assert.equal((grown.html.match(/class="on new"/g) ?? []).length, grown.lit - m.lit, 'only the new ones light up');

  // an exact boundary still shows where the block grows next
  assert.match(growthMeter({ ...nb, weight: 1_000_000 }, null, 0).html, /class="next"/);
  assert.equal(growthMeter(null).html, '', 'no template, no meter');

  // and it is in the card, where the ticks were
  const el = { clientWidth: 900, innerHTML: '' };
  blockFlow(el, { tipHeight: 899, recent: ROWS(2), avgGapSec: 600, next: { ...TEMPLATE(null), height: 900, visual: nb.visual } }, FMT);
  assert.ok(el.innerHTML.includes('class="bmeter"'), 'the meter is on the block being built');
  assert.ok(!el.innerHTML.includes('inflow'), 'the bobbing ticks are gone');
});

test('the four-sentence explainer under the train is gone', async () => {
  // (operator: 'Too much verbosity with "The line divides the two kinds of work"
  // - remove all that text'). What survives is the data-quality line, and only
  // when there is a gap to declare -- stating gaps is the whole posture, and it
  // is one clause rather than a paragraph.
  const { blockFlow } = await import('../public/js/mining.js');
  const el = { clientWidth: 900, innerHTML: '' };
  blockFlow(el, { tipHeight: 966294, recent: ROWS(3), avgGapSec: 600, next: TEMPLATE(null) }, FMT);
  const html = el.innerHTML;
  for (const gone of [
    'The line divides the two kinds of work',
    'older blocks recede right',
    'Bars are weight used against',
    'Rail speed =',
  ]) assert.ok(!html.includes(gone), `removed: ${gone}`);
  assert.ok(html.includes('bcard'), 'the train itself is still rendered');
});

import { dragScroll } from '../public/js/mining.js';
import { readFileSync } from 'node:fs';

test('Block flow scrolls by dragging the row, with momentum, and a drag is never a click', async () => {
  const on = {};
  const classes = new Set();
  const el = { scrollLeft: 300, addEventListener: (k, f) => { (on[k] ??= []).push(f); }, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  const fire = (k, e) => (on[k] ?? []).forEach((f) => f({ button: 0, pointerType: 'mouse', pointerId: 1, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...e }));
  dragScroll(el);
  dragScroll(el);
  assert.equal(on.pointermove.length, 1, 'bound once per row');
  fire('pointerdown', { clientX: 500 });
  fire('pointermove', { clientX: 498 });
  assert.equal(el.scrollLeft, 300, 'a jitter under 4 px is not a drag');
  fire('pointermove', { clientX: 400 });
  assert.equal(el.scrollLeft, 400, 'dragging left scrolls the row right');
  assert.ok(classes.has('dragging'), 'snap is off while it moves');
  fire('pointerup', {});
  const click = { prevented: false };
  (on.click ?? []).forEach((f) => f({ preventDefault() { click.prevented = true; }, stopPropagation() {} }));
  assert.equal(click.prevented, true, 'the click that ends a drag is swallowed');
  // a plain click still goes through
  fire('pointerdown', { clientX: 200 });
  fire('pointerup', {});
  const click2 = { prevented: false };
  (on.click ?? []).forEach((f) => f({ preventDefault() { click2.prevented = true; }, stopPropagation() {} }));
  assert.equal(click2.prevented, false);
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.flowwrap\.dragging \{ cursor: grabbing; scroll-snap-type: none; \}/);
});

test('nothing jitters: tabular numerals everywhere, and the live labels hold their width', () => {
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /body \{ font-variant-numeric: tabular-nums; \}/);
  assert.match(css, /\.viewer-ctl \.refresh-in \{ display: inline-block; min-width: 17ch;/);
  assert.match(css, /#sseState \{ display: inline-block; min-width: 12ch; \}/);
  assert.match(css, /\.khead \.faint \{[^}]*text-overflow: ellipsis/);
});

test('a height whose coinbase has not been read yet still shows everything known about it', async () => {
  // Operator, 2026-09-12: "It's not showing any data at all for unattributed blocks. How is that
  // possible?" -- and it was a fair question. Attribution reads one coinbase per poll so it trails
  // the tip, but getblockstats has been in hand the whole time. The card was built only from the
  // attribution row, so a height the reader had not reached drew as an empty dashed box: every
  // known fact about the block thrown away to report the one fact that was missing.
  const { blockFlow, flowFrame } = await import('../public/js/mining.js');
  const FMT = { num: (n) => String(n ?? '-'), bytes: (n) => String(n ?? '-'), esc: (s) => String(s ?? ''), ago: () => '-', rate: (x) => String(x ?? '-'), satPerVb: (x) => String(x ?? '-'), ageSec: () => '-', pct: (n) => String(n ?? '-') };
  const recent = [{ height: 101, poolLabel: 'Foundry USA', poolKey: 'foundry', poolLabelKey: 'foundry', weight: 3_900_000, txs: 5000, totalfee: 700_000, size: 1_600_000, at: Date.now(), time: 1789200000 }];
  // present in getblockstats, absent from attribution: the case that used to blank the card
  const stats = [{ height: 100, weight: 3_991_446, txs: 5842, totalfee: 688_384, size: 1_623_024, avgFeerate: 2, t: Date.now() - 600_000, time: 1789199400 }];

  const frame = flowFrame({ tipHeight: 101, recent, stats, history: 2 });
  assert.ok(frame.history[0].row, 'the height with stats but no coinbase now has a row to draw');
  assert.equal(frame.history[0].row.coinbaseUnread, true, 'marked, so the plate can say why');
  assert.equal(frame.history[0].row.txs, 5842, 'carrying what getblockstats already knew');
  // BOTH past heights are unattributed here: 100 has stats but no coinbase read, 99 has neither.
  // The count is of coinbases still unread, not of blank cards -- filling 100's card in must not
  // make the reader's lag disappear from the note under the row.
  assert.equal(frame.unattributed, 2, 'the lag is STILL counted: drawing the card must not hide it');

  const el = { clientWidth: 900, innerHTML: '' };
  blockFlow(el, { tipHeight: 101, recent, stats, avgGapSec: 600 }, FMT);
  const html = el.innerHTML;
  const at100 = html.indexOf('#100');
  assert.ok(at100 > 0, 'the height is drawn');
  // bounded at the NEXT card, not a guessed character count: a fixed window ran 1601 chars over a
  // 1275-char card and swallowed the stub for height 99, which IS a stub (no stats, no coinbase),
  // so the assertion below was reading the wrong block's markup
  const start = html.lastIndexOf('<div class="bcard', at100);
  const nextCard = html.indexOf('<div class="bcard', at100);
  const card = html.slice(start, nextCard === -1 ? undefined : nextCard);
  assert.ok(!/bcard pending/.test(card), 'and not as an empty dashed stub');
  assert.ok(card.includes('5842'), 'its transaction count is on the card');
  assert.ok(card.includes('bgrid'), 'with the rest of its figures beside it');
  assert.match(card, /class="pill waiting"/, 'the plate says the coinbase is still being read');
  assert.ok(card.includes('reading coinbase'), 'in words, not as a blank');
});
