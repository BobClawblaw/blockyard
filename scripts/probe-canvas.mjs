// One canvas, live, twice — with the second look 30 s after a real template/mempool
// refresh — and a crop each time. For the questions a hash cannot answer: is the map
// still on screen after updates, is the aggregate readable, did the frontier move.
import { execFileSync } from 'node:child_process';
const BASE = process.env.BLOCKYARD_BASE;
const CDP = process.env.BROWSER_CDP ?? 'http://127.0.0.1:9333';
const ID = process.env.PROBE_ID ?? 'gnMempoolTreemap';
const GAP_MS = Number(process.env.PROBE_GAP ?? 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!BASE) { console.log('usage: BLOCKYARD_BASE=... node scripts/probe-canvas.mjs'); process.exit(2); }
const targets = JSON.parse(await (await fetch(`${CDP}/json/list`)).text());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1; const pending = new Map();
const exceptions = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
};
const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, (m) => res(m.result ?? m.error ?? {})); ws.send(JSON.stringify({ id, method, params })); });
const evl = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#overview` });
await sleep(5000);
// Switch the SPA page through the nav button — a hash-only navigation on a warm
// document is a no-op (rule 25).
await evl(`document.querySelector('#nav button[data-page="mining"]')?.click()`);

const look = async (tag) => {
  const info = await evl(`(() => {
  const c = document.getElementById(${JSON.stringify(ID)});
  if (!c) return JSON.stringify({missing:true});
  const r = c.getBoundingClientRect();
  const v = c.__view;
  const t = (v?.items ?? []).filter(it=>!it.departing);
  const covered = t.reduce((n,it)=>n+it.tw*it.th,0);
  const cut = v?.cutNow, w=r.width,h=r.height;
  return JSON.stringify({ rect:{w:Math.round(r.width),h:Math.round(r.height)},
    hasData: c.__hasData, rects: c.__rects?.size, anim: c.__anim?.size, items: items => 0,
    cut: Math.round(cut ?? -1), unused: c.__geom?.unused,
    coveredPct: Math.round(100*covered/(r.width*r.height)),
    parked: c.__parked, raf: !!c.__raf }); })()`.replace('items: items => 0,', `items: (v?.items??[]).length, aggLabelled: (function(){
      // did the aggregate's own label get drawn? look for the text we know it writes
      const t = (v?.items??[]).find(i=>i.aggregate); return t ? {agg:t.aggregate, x:Math.round(t.tx), y:Math.round(t.ty), w:Math.round(t.tw), h:Math.round(t.th)} : null; })(),`));
  console.log(`${tag}:`, info);
  const cb = JSON.parse(await evl(`(() => { const c=document.getElementById(${JSON.stringify(ID)}); const b=c.getBoundingClientRect(); return JSON.stringify({x:b.x,y:b.y,w:b.width,h:b.height}); })()`));
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: cb.x - 4, y: cb.y - 4, width: cb.w + 8, height: cb.h + 8, scale: 1 } });
  const fs = await import('node:fs');
  const out = `/tmp/probe-${ID}-${tag}-${process.pid}.png`;
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`${tag} crop:`, out);
};

await sleep(14000);
await look('first');
await sleep(GAP_MS);
await look('after');
if (exceptions.length) { console.log(`uncaught exceptions: ${exceptions.length}`); exceptions.slice(0, 5).forEach((e) => console.log(`   !! ${String(e).split('\n')[0]}`)); }
ws.close();
