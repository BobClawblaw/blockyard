// Look at the page with a real browser, and ask the vision model what it sees.
//
// Two kinds of evidence, deliberately kept apart:
//   HARD   -- pixels sampled in the page by Runtime.evaluate, and element rects. The
//            canvas is same-origin, so getImageData answers "did anything actually get
//            painted, and in which colours" without any judgement at all.
//   SOFT   -- a screenshot handed to the local vision model (qwen3.8 on the bench host).
//            Good for "does this read as a block being filled", "is the legend legible",
//            "do these overlap". Bad at precise numbers. Where the two disagree, the
//            pixels win, and the report says so.
//
// Zero dependencies: Chromium speaks CDP over a plain WebSocket, and Node 22 ships one.
//
//   BLOCKYARD_BASE=https://<lan>:8088 [BROWSER_CDP=http://127.0.0.1:9333] \
//   [VISION_BASE=http://198.51.100.20:8888 VISION_MODEL=<model-id>] \
//     node scripts/browser-check.mjs [overview|mining]
import { execFileSync } from 'node:child_process';

const BASE = process.env.BLOCKYARD_BASE;
const CDP = process.env.BROWSER_CDP ?? 'http://127.0.0.1:9333';
const VISION_BASE = process.env.VISION_BASE;   // the local vision model, e.g. vLLM on the bench host
const VISION_MODEL = process.env.VISION_MODEL ?? 'qwen3.8-flash-next';
const PAGE = process.argv[2] ?? 'mining';
if (!BASE) {
  console.log('usage: BLOCKYARD_BASE=https://<address>:8088 node scripts/browser-check.mjs [overview|mining]');
  console.log('       needs a headless chromium with --remote-debugging-port and --ignore-certificate-errors');
  process.exit(2);
}
const URL = `${BASE}/#${PAGE}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP client
const targets = JSON.parse(await (await fetch(`${CDP}/json/list`)).text());
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('no page target; is chromium running headless with --remote-debugging-port?'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
const events = [];
const consoleErrors = [];
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method) {
    events.push(msg.method);
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
      consoleErrors.push(`[${msg.params.entry.source}] ${msg.params.entry.text}`.slice(0, 200));
    }
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, (msg) => res(msg.result ?? msg.error ?? {}));
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1900, deviceScaleFactor: 1, mobile: false });

const loadWait = new Promise((res) => {
  const wait = (ev) => { if (ev === 'Page.loadEventFired') res(true); };
  const orig = ws.onmessage;
  ws.onmessage = (m) => { orig(m); wait(JSON.parse(m.data).method); };
  setTimeout(() => res(false), 25_000);
});
// Cache-bust deliberately: Page.navigate to a URL that differs from the current one only
// in its #fragment is a NO-OP, so reusing a still-open browser silently re-measures the
// document that was loaded before the last deploy. Every "old code path" and "blank
// canvas" reading this harness ever produced against a warm browser was this.
//
// ...and the query-string bust is NOT enough on its own. It changes the
// DOCUMENT url only; the ES MODULES the document imports keep their own urls,
// so a warm browser serves them from cache and the harness measures the
// PREVIOUS build's JavaScript against the current build's HTML. Measured
// 2026-09-10: the viewer's projection was replaced outright, the server was
// confirmed to be serving the new file, every unit test agreed -- and the
// screenshot kept showing the old camera, from a headless shell that had been
// up 48 hours. Disabling the network cache is what makes this harness
// trustworthy for a JS change at all.
await send('Network.enable', {});
await send('Network.setCacheDisabled', { cacheDisabled: true });
const busted = URL + (URL.includes('?') ? '&' : '?') + 't=' + Date.now();
await send('Page.navigate', { url: busted });
const loaded = await loadWait;
// A document can load and still not be the app (a redirect to the login page loads
// perfectly well). Assert the shell is here before judging anything drawn inside it.
// NOTE what this does NOT check: document.body.firstChild. Leading whitespace is a text
// node in every ordinary document, and an earlier throwaway probe asserted on exactly
// that and "proved" the app rendered nothing when it had rendered fine all along.
const shell = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ bodyKids: document.body.children.length, nav: !!document.querySelector('#nav'), login: location.pathname.startsWith('/login') })`,
  returnByValue: true,
}).then((r) => JSON.parse(r?.result?.value || '{}'));
if (!shell.bodyKids || !shell.nav || shell.login) {
  console.error(`not the app: bodyKids=${shell.bodyKids} nav=${shell.nav} path=${shell.login ? '/login' : '?'}`);
  await browser.close();
  process.exit(1);
}
// The mining page asks the node for a block template on load (~1.3 s) and the map tweens
// for ~520 ms after that. Judge nothing before it has settled.
//
// AND switch the SPA to the requested page the way a user does — by clicking the nav
// button. Loading `/#mining` in this harness has repeatedly measured the OVERVIEW instead
// (every canvas zeroSized or from the wrong page), because the hash route is applied
// inside boot's async tail and a hash-only change on a warm document is no kind of
// navigation at all (rule 25). Clicking is deterministic; hoping for the hash is not.
await sleep(3000);
if (PAGE !== 'overview') {
  await send('Runtime.evaluate', { expression: `document.querySelector('#nav button[data-page=${JSON.stringify(PAGE)}]')?.click()` });
}
await sleep(4000);
// Prove we are on the page we claim to be measuring, before judging a single pixel.
const onPage = JSON.parse(await send('Runtime.evaluate', {
  expression: `(() => { const on = document.querySelector('.page.on'); return JSON.stringify({page: on?.dataset?.page ?? null, hash: location.hash}) })()`,
  returnByValue: true,
}).then((r) => r?.result?.value ?? '{}'));
if (onPage.page && onPage.page !== PAGE) {
  console.error(`not on #${PAGE}: the app is showing "${onPage.page}". The page switch failed; every measurement below would describe the wrong page.`);
  ws.close();
  process.exit(1);
}

// Refuse to review a page that did not load. Without this guard a broken invocation
// (an empty BLOCKYARD_BASE once sent it to https://:8088) produced a blank screenshot,
// the vision model confidently reported "the page is completely empty", and that read
// would have been believed. Check the document before asking anyone to judge it.
const sanity = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    href: location.href,
    title: document.title,
    nav: !!document.getElementById('nav'),
    nodes: document.body ? document.body.childElementCount : 0,
    text: document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0,120) : ''
  })`,
  returnByValue: true,
});
let sanityObj = {};
try { sanityObj = JSON.parse(sanity.result?.value ?? '{}'); } catch { /* reported below */ }
if (!sanityObj.nav || !sanityObj.nodes) {
  console.log(`\n== ${URL} ==`);
  console.log(`ABORT: nothing to look at. href=${sanityObj.href} title=${JSON.stringify(sanityObj.title)} bodyChildren=${sanityObj.nodes}`);
  console.log('The browser reached a document with no app in it. Check BLOCKYARD_BASE (and that the service is up) before reading anything into a screenshot.');
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((e) => console.log(`   ! ${e}`));
  ws.close();
  process.exit(3);
}

// ------------------------------------------------------- HARD: measure the page
const PROBE = () => {
  const out = { canvases: {}, rects: {}, cssom: {}, text: {}, scroll: {} };
  const px = (id, label) => {
    const c = document.getElementById(id);
    if (!(c instanceof HTMLCanvasElement)) { out.canvases[id] = { missing: true }; return; }
    const r = c.getBoundingClientRect();
    out.rects[id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    if (!r.width || !r.height) { out.canvases[id] = { zeroSized: true }; return; }
    let ctx;
    try { ctx = c.getContext('2d', { willReadFrequently: true }); } catch { out.canvases[id] = { noContext: true }; return; }
    const dpr = c.width / r.width || 1;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const colours = new Map();
    let lit = 0;
    for (let i = 0; i < data.length; i += 4 * 17) {          // sampled every 17 px, fast and enough
      const a = data[i + 3];
      if (a < 8) continue;
      const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
      colours.set(key, (colours.get(key) ?? 0) + 1);
      if (data[i] + data[i + 1] + data[i + 2] > 200) lit++;
    }
    const top = [...colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    out.canvases[id] = {
      sampled: label, dpr: +dpr.toFixed(2),
      // If nothing painted, say what the drawing code left behind: __hasData is set by
      // paint(), __rects by the treemap layout. hasData=true with 0 colours means it drew
      // and something wiped it; false means the draw never ran at all.
      hasData: !!c.__hasData, rects: c.__rects?.size ?? 0, cells: c.__cells ?? 0,
      backing: `${c.width}x${c.height}`,
      distinctColours: colours.size, litPixels: lit,
      topColourShares: top.map(([k, v]) => `${k}:${(100 * v / [...colours.values()].reduce((a, b) => a + b, 0)).toFixed(0)}%`),
      paintedPixelsPct: +((100 * [...colours.values()].reduce((a, b) => a + b, 0)) / (data.length / (4 * 17))).toFixed(1),
    };
  };
  ['gnMempoolTreemap', 'ovGnTreemap', 'ovTrain', 'ovMpChart', 'ovFeeChart', 'mnFeeLandscape']
    .forEach((id) => px(id, document.getElementById(id) ? 'present' : 'absent'));

  // CSSOM applied? If the CSP/CSSOM conversion is broken the marks have no background.
  const dots = [...document.querySelectorAll('.bdot')].slice(0, 6);
  out.cssom.bdotBackgrounds = dots.map((d) => getComputedStyle(d).backgroundColor);
  const cards = [...document.querySelectorAll('.bcard')].slice(0, 8);
  out.cssom.cardPoolVars = cards.map((c) => getComputedStyle(c).getPropertyValue('--pool').trim() || '(none)');
  const rail = document.querySelector('.rail');
  out.cssom.railDuration = rail ? getComputedStyle(rail).animationDuration : '(no rail)';
  const bar = document.querySelector('.bfill span');
  out.cssom.fillWidth = bar ? `${getComputedStyle(bar).width} (data-w=${bar.dataset?.w ?? '-'})` : '(no fill)';
  // Distinguish "we never set it" from "the browser computed something else": inline CSSOM
  // values are what applyMiningStyles writes, computed values are what actually renders.
  out.cssom.cardInlinePool = [...document.querySelectorAll('.bcard')].slice(0, 4)
    .map((c) => `${c.style.getPropertyValue('--pool') || '(unset)'}|computed:${getComputedStyle(c).getPropertyValue('--pool').trim() || '(none)'}`);

  // Card geometry: overlapping cards is the classic flexbox overflow failure.
  const flows = [...document.querySelectorAll('.flow, .flowwrap')];
  out.rects.flowOverflow = flows.map((f) => ({ scrollW: f.scrollWidth, clientW: f.clientWidth, clipped: f.scrollWidth > f.clientWidth + 2 }));

  const txt = (id) => { const el = document.getElementById(id); const s = (el?.textContent ?? '').trim(); return s.length > 160 ? `${s.slice(0, 160)}…` : s; };
  ['ovFeesCard', 'ovMpVsBlock', 'ovMpVsBlockKv', 'ovMempoolCard', 'ovGnTreemapNote', 'gnMempoolNote', 'mnPools', 'ovCaveats']
    .forEach((id) => { out.text[id] = txt(id); });
  out.scroll = { bodyH: document.body.scrollHeight, winH: innerHeight };
  return out;
};
const probed = await send('Runtime.evaluate', { expression: `(${PROBE.toString()})()`, returnByValue: true });
const hard = probed.result?.value ?? { error: probed.error ?? 'no value' };

const shot = await send('Page.captureScreenshot', { format: 'png' });
const png = shot.data ?? null;

// ------------------------------------------------------- SOFT: ask the vision model
let soft = null;
if (png && VISION_BASE) {
  const prompt = [
    'You are reviewing a screenshot of a self-hosted Bitcoin node monitor (dark theme).',
    `This is the "${PAGE}" page. Report only what you can see, and say "cannot tell" rather than guessing.`,
    'Answer each numbered question in one short sentence:',
    '1. Are any large areas blank, empty boxes, or placeholder dashes? Name them.',
    '2. Is there a treemap of rectangles (a block-space map)? Do the rectangles vary in size and colour, and is any large unfilled band visible?',
    '3. Is there a row of block cards? Read the height numbers you can see, left to right, and say whether one is marked as current.',
    '4. Is any text unreadable because of low contrast, overlap, or clipping?',
    '5. Does anything look obviously broken (misaligned, clipped, overlapping, wrong colours)?',
    '6. What is the single most damaging visual problem on this page, if any?',
  ].join('\n');
  const res = await fetch(`${VISION_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 700,
      temperature: 0.2,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
      ] }],
    }),
  });
  const j = await res.json().catch(() => null);
  const m = j?.choices?.[0]?.message ?? {};
  // This deployment is a reasoning model: it can answer with content=null and the text in
  // `reasoning`. Reading only `content` reports a confident-looking empty review, which is
  // the worst possible failure for a check whose whole job is to notice problems.
  soft = m.content ?? m.reasoning ?? JSON.stringify(j).slice(0, 400);
}

// ------------------------------------------------------------------- report
console.log(`\n== ${URL} ${loaded ? '' : '(load event not seen)'} ==`);
console.log(`console errors/warnings: ${consoleErrors.length}`);
consoleErrors.slice(0, 8).forEach((e) => console.log(`   ! ${e}`));
if (exceptions.length) { console.log(`uncaught exceptions: ${exceptions.length}`); exceptions.slice(0, 5).forEach((e) => console.log(`   !! ${String(e).split('\n')[0]}`)); }
console.log('\n-- HARD: canvas pixels sampled in the page --');
for (const [id, v] of Object.entries(hard.canvases ?? {})) console.log(`   ${id.padEnd(18)} ${JSON.stringify(v)}`);
console.log('-- HARD: CSSOM + geometry --');
console.log('   ', JSON.stringify(hard.cssom));
console.log('   flow:', JSON.stringify(hard.rects?.flowOverflow));
console.log('-- HARD: text on the page --');
for (const [id, v] of Object.entries(hard.text ?? {})) if (v) console.log(`   ${id.padEnd(16)}: ${String(v).slice(0, 120)}`);
console.log(`   page height ${hard.scroll?.bodyH} vs window ${hard.scroll?.winH}`);
if (png) {
  const fs = await import('node:fs');
  const path = `/tmp/browser-check-${PAGE}.png`;
  fs.writeFileSync(path, Buffer.from(png, 'base64'));
  console.log(`\nscreenshot: ${path} (${Math.round(png.length * 3 / 4 / 1024)} KB)`);
}
console.log(`\n-- SOFT: ${VISION_MODEL} on the screenshot --`);
console.log(soft ? soft.split('\n').map((l) => `   ${l.trim()}`).filter((l) => l.trim()).join('\n') : '   (no VISION_BASE set, so the screenshot was not reviewed)');
console.log('\nHARD evidence is measured in the page; SOFT is a model\'s reading. Where they disagree, the pixels win.');
ws.close();
