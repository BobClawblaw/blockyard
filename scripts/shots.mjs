// Refresh the README/docs screenshots against a running monitor.
//
// (operator, 2026-09-13: "We should probably take updated screenshots for everything with
// the new defaults" -- the shipped look changed that day: stars on, a dense sky with the
// spiral arms on, markets opening on 24h in the FLAT view, and the courts' own grids.)
//
// THREE RULES THIS FILE OBEYS, each learned the hard way in this repo:
//
//  1. NAVIGATE BY CLICKING, never by setting the hash. A hash-only navigation against a
//     warm document is a no-op, and every reading taken that way here was the wrong page
//     measured (motion-check.mjs). Capturing 11 pages by hash would quietly produce 11
//     copies of the overview. Every shot re-asserts which page it landed on.
//  2. HEIGHT IS MEASURED, NOT INHERITED. The old markets.jpg was 1600x2400 because the
//     page then stacked a 3D board above the flat chart; with 2D as the default it is
//     1423 tall, and capturing at 2400 gives a screenshot that is half dead black.
//  3. A SETTINGS TOGGLE NOW WRITES THROUGH TO THE SERVER. The neon shot changes
//     space.neon, which POSTs to /api/settings and rewrites config/blockyard.json -- the
//     operator's own saved settings. It is captured last, and restored, and the caller
//     checks the file's md5 against the baseline afterwards.
//
// Zero dependencies: chromium speaks CDP over a plain WebSocket and Node 22 ships one.
//
//   BLOCKYARD_BASE=http://127.0.0.1:21000 [BROWSER_CDP=http://127.0.0.1:9445] [BLOCKYARD_NODE=main] \
//     node scripts/shots.mjs [name ...]
//
// SHOOT A THROWAWAY INSTANCE, NOT THE LIVE ONE (2026-10-14; operator: "set up fake cities for the screenshots Don't leak
// my locations"): the weather ribbon names the places in the SHARED settings file, and the live monitor's are the
// operator's own. Start a second monitor on a scratch config whose blockyard.json beside it names stand-in places
// (Boulder, Colorado and Berlin in the shipped pictures), against the same node, and point BLOCKYARD_BASE at it:
//   BLOCKYARD_CONFIG=<scratch>/local.json BLOCKYARD_DATA=<scratch>/data BLOCKYARD_AUTH=0 BLOCKYARD_TLS=0 \
//     BLOCKYARD_PORT=18092 node server/main.js
// The LOOKS at the end (the Sun sky, the Formation, the finishes) need WebGL on a real card: a second chromium with
// --enable-gpu --ignore-gpu-blocklist --use-angle=vulkan --enable-features=Vulkan, named by BROWSER_CDP for that run.
import { writeFileSync } from 'node:fs';

const BASE = process.env.BLOCKYARD_BASE ?? 'http://127.0.0.1:21000';
const CDP = process.env.BROWSER_CDP ?? 'http://127.0.0.1:9445';
const QUALITY = Number(process.env.SHOT_QUALITY ?? 82);
const W = 1600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = JSON.parse(await (await fetch(`${CDP}/json/list`)).text());
const target = targets.find((t) => t.type === 'page');
if (!target) { console.log('no page target; is chromium running with --remote-debugging-port?'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method}: timeout`)); } }, 40000);
});
const evl = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

// NOT document.body.scrollHeight. scrollHeight is never smaller than the viewport, so
// measuring from a tall viewport returns the viewport -- the first cut measured at the
// 2600 cap and every page came back "2600 tall", which is how four screenshots ended up
// as half a page of content over a page of black. The visible sections' lowest edge is
// the only content-driven number here.
const CONTENT_H = `(() => {
  const secs=[...document.querySelectorAll('main section, .app > section')].filter(s=>s.offsetParent!==null);
  const bottom=Math.max(0,...secs.map(s=>s.getBoundingClientRect().bottom+window.scrollY));
  return Math.max(600, Math.ceil(bottom) + 12);
})()`;

const metrics = (h) => send('Emulation.setDeviceMetricsOverride', { width: W, height: h, deviceScaleFactor: 1, mobile: false });
// the menu bar (2026-10-13): the lit button WITH a data-page is the page's item (a lit title has none)
const page = () => evl(`(document.querySelector('#nav button[data-page].on')?.dataset.page) ?? '(none)'`);

async function nav(p) {
  const ok = await evl(`(() => { const b=document.querySelector('#nav button[data-page="${p}"]'); if(!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no nav button for "${p}"`);
  await sleep(1500);
  const on = await page();
  if (on !== p) throw new Error(`asked for "${p}", landed on "${on}"`);
}

async function shoot(name, { settle = 6000, height = null, cap = 2600 } = {}) {
  // MEASURE FROM A KNOWN VIEWPORT, not from whatever the previous shot left behind.
  // The first cut measured while the page was still laid out at the PREVIOUS shot's
  // height, so the overview's 1788 propagated into markets, kiosk and the explorer --
  // three screenshots padded with dead black, which is the exact defect the measuring
  // was introduced to fix. The reset is tall so a long page is never measured while
  // clipped; CONTENT_H reads the sections' lowest edge, so a tall viewport does not
  // inflate the answer the way scrollHeight did.
  if (height == null) {
    await metrics(cap);
    await sleep(900);
  } else {
    // A FIXED-HEIGHT PAGE IS LAID OUT AT THAT HEIGHT BEFORE IT SETTLES (2026-10-14; operator, of the Kiosk picture:
    // "block space screenshot is compressed vertically wrong"). The Kiosk's boards fit themselves to the viewport
    // when they land; settling at the previous shot's 1,743 px and then shrinking to 1,000 px 1.4 s before the capture
    // photographed a board fitted for a tall panel squeezed into a short one.
    await metrics(height);
    await sleep(900);
  }
  await sleep(settle);
  const h = Math.min(height ?? await evl(CONTENT_H), cap);
  await metrics(h);
  await sleep(1400);                       // let the board re-fit to the new viewport
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY, captureBeyondViewport: false });
  const buf = Buffer.from(shot.data, 'base64');
  writeFileSync(`docs/images/${name}.jpg`, buf);
  console.log(`  ok ${name.padEnd(20)} ${W}x${h}  ${String(Math.round(buf.length / 1024)).padStart(4)} KB`);
  return { name, ok: true };
}

await send('Page.enable');
await send('Runtime.enable');
await metrics(1000);
// WHICH NODE. The header remembers the last node picked, per browser, in localStorage; a fresh
// profile gets the first node in the config. On the operator's box that is the Umbrel over the
// LAN, whose RPC answers in ~30 s: the 2026-09-14 run photographed an empty Block space board,
// "no block template yet" and a column of collector errors -- true of that node, and useless as
// a picture of the product. BLOCKYARD_NODE names the node to shoot against (the local Core here).
const NODE = process.env.BLOCKYARD_NODE ?? null;
if (NODE) {
  await send('Page.navigate', { url: `${BASE}/?shots=${Date.now()}` });
  await sleep(3000);
  await evl(`localStorage.setItem('blockyard.node', ${JSON.stringify(NODE)})`);
}
await send('Page.navigate', { url: `${BASE}/?shots=${Date.now()}#overview` });
await sleep(9000);
// the picker lives on Chain & Sync since 2026-10-13; the browser's remembered choice is what the page watches
const onNode = await evl(`localStorage.getItem('blockyard.node') ?? '(none)'`);
if (NODE && onNode !== NODE) { console.log(`asked for node "${NODE}", the header shows "${onNode}"`); process.exit(1); }
console.log(`base ${BASE}  node ${onNode}`);

const want = new Set(process.argv.slice(2));
const doing = (n) => !want.size || want.has(n);
const done = [];
const fail = (n, e) => { console.log(`  !! ${n.padEnd(20)} ${e.message}`); done.push({ name: n, ok: false }); };

// ---------------------------------------------------------------- plain pages
for (const [name, p, settle, height = null] of [
  ['overview', 'overview', 9000],
  ['markets', 'markets', 9000],
  // KIOSK TAKES A FIXED HEIGHT. It is the wall view: its panels are sized to fill the
  // viewport, so measuring it returns whatever viewport it was measured in -- reset to
  // 2600 and the panels honestly report 2600. Every other page here is content-sized and
  // measures fine; this one is told what it is.
  ['kiosk', 'kiosk', 12000, 1000],
  // the Weather tab (0.1.6): the ribbon, the map on the place -- streets if the server has an extract -- and the days;
  // a fixed height like the kiosk's, since the map's box is sized by the viewport
  ['weather', 'weather', 16000, 1000],
  ['explorer-home', 'explorer', 6000],
  // the network row, the labelled pie and the year chart (2026-09-16); content-sized like the rest
  ['mining', 'mining', 12000],
  // Chain & Sync (0.1.3): the sync strip and the block charts; worth shooting on a node in initial
  // sync, where the charts sample the whole chain by height (BLOCKYARD_NODE picks it)
  ['chain', 'chain', 15000],
]) {
  if (!doing(name)) continue;
  try { await nav(p); done.push(await shoot(name, { settle, height })); } catch (e) { fail(name, e); }
}

// ------------------------------------------------------- block space, 2 modes
// The settles are LONG because switching vmode restarts the flight: the first cut gave
// mode2 16s and photographed a near-empty lattice under a header claiming 5,415
// transactions -- the stones were still in the air.
for (const [name, vmode, settle] of [['block-space-mode1', '1', 20000], ['block-space-mode2', '2', 28000]]) {
  if (!doing(name)) continue;
  try {
    await nav('space');
    const set = await evl(`(() => { const b=document.querySelector('[data-vmode="${vmode}"]'); if(!b) return false; b.click(); return true; })()`);
    if (!set) throw new Error(`no [data-vmode="${vmode}"] control`);
    done.push(await shoot(name, { settle, height: 1009 }));
  } catch (e) { fail(name, e); }
}

// ------------------------------------------------------------ explorer detail
if (doing('explorer-block')) {
  try {
    await nav('explorer'); await sleep(2500);
    const ok = await evl(`(() => { const a=document.querySelector('a.xlink[href*="#explorer/block/"]'); if(!a) return false; a.click(); return true; })()`);
    if (!ok) throw new Error('no block link on the explorer');
    done.push(await shoot('explorer-block', { settle: 5000 }));
  } catch (e) { fail('explorer-block', e); }
}
if (doing('explorer-tx')) {
  try {
    // THE SECOND transaction, not the first: the first is the coinbase, whose page says "fee:
    // none" and shows one input -- a poor picture of a transaction page. The second is an
    // ordinary transaction with inputs, a fee and a fee rate.
    const ok = await evl(`(() => { const as=document.querySelectorAll('a[href*="#explorer/tx/"]'); const a=as[1]??as[0]; if(!a) return false; a.click(); return true; })()`);
    if (!ok) throw new Error('no tx link on the block page (is a block page open?)');
    done.push(await shoot('explorer-tx', { settle: 5000 }));
  } catch (e) { fail('explorer-tx', e); }
}

// -------------------------------------------------------------------- settings
if (doing('settings')) {
  try {
    // Let the BOARD settle before opening the panel: the panel covers a third of the
    // frame and the rest is the board, so a half-drawn court behind it spoils the shot.
    await nav('space');
    await evl(`document.querySelector('[data-vmode="1"]')?.click()`);
    await sleep(20000);
    await evl(`document.getElementById('btnSettings')?.click()`);
    await sleep(1800);
    const open = await evl(`(()=>{const w=document.getElementById('settingsWrap');return w? !w.classList.contains('hidden'):false})()`);
    if (!open) throw new Error('the settings panel did not open');
    done.push(await shoot('settings', { settle: 2500, height: 1000 }));
    await evl(`document.getElementById('btnSettings')?.click()`);
    await sleep(800);
  } catch (e) { fail('settings', e); }
}

// ----------------------------------------------------------------------- about
// Not in the README; captured so the page can be looked at after a change (the donation address).
if (doing('about')) {
  try {
    await evl(`document.getElementById('brandAbout')?.click()`);
    await sleep(3000);
    // About is not a nav tab, so page() cannot see it: ask the section itself
    const open = await evl(`(() => { const s=document.querySelector('section.page[data-page="about"]'); return !!s && s.offsetParent !== null; })()`);
    if (!open) throw new Error('the brand button did not open About');
    done.push(await shoot('about', { settle: 2500, height: 900 }));
  } catch (e) { fail('about', e); }
}

// --------------------------------------------------------------------- tetrust
if (doing('tetrust')) {
  try {
    await evl(`document.getElementById('navDivBtn')?.click()`);
    await sleep(700);
    const ok = await evl(`(() => { const b=document.querySelector('button[data-page="tetrust"]'); if(!b) return false; b.click(); return true; })()`);
    if (!ok) throw new Error('no tetrust button behind Diversions');
    await sleep(3000);
    await metrics(1000);
    // G.running starts false: a key both starts the game and then plays it. Keys go to
    // document, so dispatching to the page is enough -- no element focus needed.
    const key = async (k, code, vk) => {
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      }
      await sleep(260);
    };
    await key('Enter', 'Enter', 13);
    await sleep(1500);
    for (const [k, c, v] of [['ArrowLeft', 'ArrowLeft', 37], ['ArrowDown', 'ArrowDown', 40], ['ArrowRight', 'ArrowRight', 39],
      ['ArrowUp', 'ArrowUp', 38], ['ArrowDown', 'ArrowDown', 40], ['ArrowLeft', 'ArrowLeft', 37],
      ['ArrowDown', 'ArrowDown', 40], ['ArrowRight', 'ArrowRight', 39], ['ArrowDown', 'ArrowDown', 40]]) {
      await key(k, c, v);
    }
    await sleep(4000);
    done.push(await shoot('tetrust', { settle: 1200 }));
  } catch (e) { fail('tetrust', e); }
}

// ------------------------------------------------------------- scorched yard
// a game against the computer, a nuke on its way in from You (the shot is set up through the
// screen's currentGame hook so the picture has a blast in it rather than an empty field)
if (doing('scorched')) {
  try {
    await evl(`document.getElementById('navDivBtn')?.click()`);
    await sleep(700);
    const ok = await evl(`(() => { const b=document.querySelector('button[data-page="scorched"]'); if(!b) return false; b.click(); return true; })()`);
    if (!ok) throw new Error('no scorched button behind Diversions');
    await sleep(2500);
    await metrics(1000);
    await evl(`document.getElementById('syResume')?.click()`);
    await sleep(1500);
    // A DAYTIME ROUND (2026-09-17). Each round draws its sky hour from the seed (scorchedyard.js
    // ROUND_HOURS[(seed + round*7) % 8]), so a shot taken at whatever the seed gave was as likely
    // night as day; the Earth sky's sun, clouds and the wind's flow lines read best at 15:00 (index 3).
    // The land is already generated, so only the sky's hour follows the new seed.
    await evl(`import('/js/scorchedyard.js').then((m) => { const g = m.currentGame(); if (g) g.seed = g.seed - ((g.seed + g.round * 7) % 8 + 8) % 8 + 3; })`);
    await sleep(2500);
    await evl(`import('/js/scorchedyard.js').then(async (m) => { const g = m.currentGame(); const t = g.tanks[0]; const ai = await import('/js/scorchedai.js'); const target = ai.nearest(g, t); t.inventory.nuke = 1; t.weapon = 'nuke'; const s = ai.spoiler(g, t, () => 0.9, target); t.angle = s.angle; t.power = s.power; })`);
    await sleep(300);
    await evl(`document.getElementById('syFire')?.click()`);
    await sleep(2400);
    done.push(await shoot('scorched', { settle: 0, height: 1000 }));
  } catch (e) { fail('scorched', e); }
}

// ------------------------------------------------------------ the looks: LAST, each restored
// A picture of a finish or a sky is shot under settings this tool sets THROUGH THE PANEL'S OWN CONTROLS and puts back
// afterwards, so the instance's saved look is what it was (the old neon shot did exactly this for one switch; the
// 2026-10-14 re-shoot under the menu bar brought the Sun, the Formation, chrome, satin and the 1 h chart under the
// same discipline). They need a renderer that draws skies and finishes: the shipped Simple draws neither, and the
// Formation and the Sun decline a software rasteriser, so run them in a chromium on the card (see the header).
async function setCfg(pairs) {
  await evl(`document.getElementById('btnSettings')?.click()`);
  await sleep(1200);
  const open = await evl(`(()=>{const w=document.getElementById('settingsWrap');return w? !w.classList.contains('hidden'):false})()`);
  if (!open) throw new Error('the settings panel did not open');
  const prev = {};
  for (const [k, v] of Object.entries(pairs)) {
    // A TAB'S CONTROLS EXIST ONLY WHILE IT IS THE OPEN ONE (2026-09-16): open the group's tab first.
    await evl(`document.querySelector('[data-cfgtab="${k.split('.')[0]}"]')?.click()`);
    await sleep(400);
    const r = await evl(`(() => {
      const want = ${JSON.stringify(v)};
      const seg = document.querySelector('[data-cfgset="${k}"][data-value="' + String(want) + '"]');
      if (seg) { const on = document.querySelector('[data-cfgset="${k}"].on'); const was = on?.dataset.value ?? null; if (!seg.classList.contains('on')) seg.click(); return { was }; }
      const el = document.querySelector('[data-cfg="${k}"]');
      if (!el) return null;
      if (el.type === 'checkbox') { const was = el.checked; if (was !== !!want) el.click(); return { was }; }
      const was = el.value; el.value = String(want); el.dispatchEvent(new Event('input', { bubbles: true })); return { was };
    })()`);
    if (!r) throw new Error(`no control for ${k}`);
    prev[k] = r.was;
    await sleep(300);
  }
  await evl(`document.getElementById('btnSettings')?.click()`);
  await sleep(1000);                       // the debounced push to the server takes ~0.5 s
  return prev;
}
const LOOKS = [
  // name, page, settings, settle, height. A Block space look also holds the pool for two minutes: the shipped board
  // takes a push every 5 s and the second Sun shot caught its tiles in the air. Long settles: a renderer or look change restarts the flight, and a shot taken
  // during it shows an empty court with stones still in the air over a header claiming six thousand transactions.
  ['markets-1h', 'markets', { 'appearance.renderer': 'webgl', 'markets.range': '1', 'markets.priceView': '2d' }, 9000, 900],
  ['sky-formation', 'markets', { 'appearance.renderer': 'webgl', 'markets.range': '1', 'markets.priceView': '3d', 'markets.sky': 'form' }, 14000, 900],
  // SDO's 171 angstrom gold, whatever channel the instance has chosen: the picture is of the Sun, not of a setting
  // -- and no idle effect: the first one is due about 23 s after a landing, which is inside this settle, and the first
  // shot had a supernova over the board where the Sun was meant to be looked at
  ['sky-sun', 'space', { 'appearance.renderer': 'webgl', 'space.refreshEvery': 120, 'space.sky': 'sun', 'sky.sunChannel': '171', 'space.idleFx': false }, 26000, 1009],
  ['finish-chrome', 'space', { 'appearance.renderer': 'webgl', 'space.refreshEvery': 120, 'space.sheen': true, 'space.sheenStyle': 'chrome' }, 26000, 1009],
  ['finish-satin', 'space', { 'appearance.renderer': 'webgl', 'space.refreshEvery': 120, 'space.sheen': true, 'space.sheenStyle': 'satin' }, 26000, 1009],
  ['finish-neon', 'space', { 'appearance.renderer': 'webgl', 'space.refreshEvery': 120, 'space.neon': true }, 26000, 1009],
  ['block-space-neon', 'space', { 'appearance.renderer': 'webgl', 'space.refreshEvery': 120, 'space.neon': true }, 26000, 1009],
];
for (const [name, p, pairs, settle, height] of LOOKS) {
  if (!doing(name)) continue;
  let prev = null;
  try {
    // THE SETTINGS FIRST, THE PAGE SECOND. A board painted under the old settings arms its idle-effect timer, and a
    // switch flipped afterwards does not disarm it: the third Sun shot had a plasma ball over a board whose effects
    // were off. Set from wherever the browser is, then open the page, so its first paint is under the look.
    prev = await setCfg(pairs);
    await nav(p); await sleep(2000);
    // BACK TO THE CUBE BOARD FIRST. A finish is a treatment on the stones, so in Detailed mode (which the mode2 shot
    // leaves behind) it photographs as a flat treemap and the shot says nothing about it at all.
    if (p === 'space') { await evl(`document.querySelector('[data-vmode="1"]')?.click()`); await sleep(3000); }
    done.push(await shoot(name, { settle, height }));
  } catch (e) { fail(name, e); }
  finally {
    if (prev) {
      try { await setCfg(prev); console.log(`  -- ${Object.keys(prev).join(', ')} restored`); } catch (e) { console.log(`  !! restore after ${name}: ${e.message}`); }
    }
  }
}

console.log(`\n${done.filter((d) => d.ok).length}/${done.length} captured`);
ws.close();
