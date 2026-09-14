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
const page = () => evl(`(document.querySelector('#nav button.on')?.dataset.page) ?? '(none)'`);

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
const onNode = await evl(`document.getElementById('nodeSel')?.value ?? '(none)'`);
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
  ['explorer-home', 'explorer', 6000],
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

// -------------------------------------------------- neon: LAST, and it is restored
if (doing('block-space-neon')) {
  let toggled = false;
  try {
    await nav('space'); await sleep(2000);
    // BACK TO THE CUBE BOARD FIRST. The neon finish is a treatment on the stones, so in
    // Detailed mode (which the mode2 shot leaves behind) it photographs as a flat treemap
    // and the shot says nothing about neon at all.
    await evl(`document.querySelector('[data-vmode="1"]')?.click()`);
    await sleep(3000);
    await evl(`document.getElementById('btnSettings')?.click()`);
    await sleep(1200);
    // space.neon lives in the Block space group; find its control by data-cfg.
    const on = await evl(`(() => {
      const el=document.querySelector('[data-cfg="space.neon"]');
      if(!el) return false;
      if(!el.checked){ el.click(); return 'clicked'; }
      return 'already';
    })()`);
    if (!on) throw new Error('no [data-cfg="space.neon"] control found');
    toggled = on === 'clicked';
    await evl(`document.getElementById('btnSettings')?.click()`);
    await sleep(1000);
    // A LONG settle: switching vmode and toggling neon each restart the choreography, and
    // a shot taken during it shows an empty court with stones still in the air over a
    // header claiming six thousand transactions.
    done.push(await shoot('block-space-neon', { settle: 26000, height: 1009 }));
  } catch (e) { fail('block-space-neon', e); }
  finally {
    if (toggled) {
      await evl(`document.getElementById('btnSettings')?.click()`);
      await sleep(1000);
      const back = await evl(`(() => { const el=document.querySelector('[data-cfg="space.neon"]'); if(!el) return false; if(el.checked){ el.click(); } return !el.checked; })()`);
      await evl(`document.getElementById('btnSettings')?.click()`);
      console.log(`  -- space.neon restored to off: ${back}  (debounced push takes ~0.5s)`);
      await sleep(2500);
    }
  }
}

console.log(`\n${done.filter((d) => d.ok).length}/${done.length} captured`);
ws.close();
