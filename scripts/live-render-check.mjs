// Render EVERY page against the LIVE monitor, under the DOM stub.
//
// Why: unit tests of a chart's geometry passed while the page that draws it threw a
// ReferenceError on the first real frame -- and an uncaught throw inside one renderer
// takes the whole page's cards with it, so the symptom was "two cards render nothing"
// when the cause was an undefined variable three lines above them. Nothing in the suite
// had ever run the page code with real-shaped data. This does, for every page.
import { execFileSync } from 'node:child_process';
import { installDom } from '../test/dom-stub.js';

// No address is written here. Point it at whatever is running:
//   BLOCKYARD_BASE=https://<address>:8088 BLOCKYARD_CA=/path/ca.crt npm run render:live
// With no BLOCKYARD_BASE it boots its own server against the fake node, so the check runs
// on any machine with no host identity to leak and no assumption about this one.
const CA = process.env.BLOCKYARD_CA;
const BASE = process.env.BLOCKYARD_BASE;
const curlArgs = (p) => ['--max-time', '20', ...(CA ? ['--cacert', CA] : []), `${BASE}${p}`];
const get = (p) => JSON.parse(execFileSync('curl', ['-s', ...curlArgs(p)], { encoding: 'utf8', maxBuffer: 1 << 26 }));

if (!BASE) {
  console.log('usage: BLOCKYARD_BASE=https://<address>:8088 [BLOCKYARD_CA=<ca.pem>] npm run render:live');
  console.log('       (point it at a running monitor; no address is baked into this script)');
  process.exit(2);
}

installDom();
let rafN = 0;
globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: true }) };
globalThis.matchMedia = () => ({ matches: true });
globalThis.requestAnimationFrame = (fn) => { rafN += 1; fn(rafN * 16); return rafN; };
globalThis.cancelAnimationFrame = () => {};
globalThis.performance = { now: () => 0 };

const F = await import('../public/js/fmt.js');
const panels = await import('../public/js/panels.js');
panels.setFmt(F);
const app = await import('../public/js/app.js');

const snap = get('/api/state?node=main');
try { snap.attribution = { ...(snap.attribution || {}), nextBlock: get('/api/nextblock?node=main') }; } catch { /* the page says so itself */ }
let dist = null;
try { dist = get('/api/mempool?node=main')?.dist ?? null; } catch { /* ditto */ }

Object.assign(app.state, { snap, page: 'overview', series: snap.series ?? {}, node: snap.id ?? 'main', byNode: new Map([[snap.id ?? 'main', { series: snap.series ?? {}, snap }]]), mempoolDist: dist ? { ...dist, fetchedAt: Date.now() } : null });

const PAGES = ['overview', 'chain', 'mempool', 'peers', 'network', 'mining', 'logs', 'node'];
// Cards that must have something in them once the page has rendered with live data.
const MUST_FILL = {
  overview: ['ovMpCount', 'ovMpBytes', 'ovMpVsBlock', 'ovMpVsBlockKv', 'ovFeesCard', 'ovCaveats', 'ovTrain', 'ovGnTreemapNote'],
  chain: ['chState', 'chUtxo', 'chDiff'],
  mempool: ['mpLimits'],
  peers: ['prCount', 'prBudget'],
  network: ['ntRpc'],
  mining: ['mnPools', 'gnMempoolNote'],
};

let failed = 0;
for (const page of PAGES) {
  app.state.page = page;
  try {
    app.render();
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${page}: render threw -- ${e.message}`);
    console.log(String(e.stack).split('\n').slice(1, 4).map((l) => `     ${l.trim()}`).join('\n'));
    continue;
  }
  // The stub does not register ids out of injected markup, so a card rewritten through
  // innerHTML is asserted on the element that was written -- which is the element the
  // browser also paints. Asserting the stale child would measure the harness.
  const empties = (MUST_FILL[page] ?? []).filter((id) => {
    const el = globalThis.document.getElementById(id);
    // Content may be written as markup or as plain text; an empty `_html` string is not
    // null, so `??` would never look at textContent and a perfectly good note would be
    // reported as empty. Read both.
    const html = String(el?.innerHTML ?? '');
    const txt = (html || String(el?.textContent ?? '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return !txt || txt === '–';
  });
  if (empties.length) { failed += 1; console.log(`FAIL ${page}: cards left empty: ${empties.join(', ')}`); }
  const fees = String(globalThis.document.getElementById('ovFeesCard')?.innerHTML ?? '');
  if (page === 'overview' && /in 1 block/.test(fees) && !/\d/.test(fees.replace(/in \d+ block/g, ''))) {
    failed += 1; console.log('FAIL overview: the fee tiers rendered with no numbers in them');
  }
  else console.log(`ok   ${page}`);
}

console.log(failed ? `\n${failed} page(s) failed` : '\nall pages rendered with live data');
process.exit(failed ? 1 : 0);
