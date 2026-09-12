// Replay the user's sequence and verify, via SCREENSHOT pixels only (never via
// getImageData on the live canvas — that readback is what contaminates the context and
// produced every false reading today): does the map stay painted across page switches
// and updates? A painted map => the 40x40 centre crop has >3 distinct colours; blank =>
// one colour.
import { execFileSync } from 'node:child_process';
const CDP = 'http://127.0.0.1:9333';
const BASE = process.env.BLOCKYARD_BASE;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const targets = JSON.parse(await (await fetch(CDP + '/json/list')).text());
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => new Promise(r => { const i = id++; pend.set(i, x => r(x.result ?? x.error ?? {})); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evl = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true }))?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#overview` });
await sleep(7000);

const histOf = (pngPath) => execFileSync('python3', ['/storage/blockyard/scripts/png-hist.py', pngPath], { encoding: 'utf8' });

const check = async (tag, id) => {
  const b = JSON.parse(await evl(`(() => { const c=document.getElementById(${JSON.stringify(id)}); if(!c) return '{}'; const r=c.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height, vis: r.width>10}) })()`));
  if (!b.vis) { console.log(tag, 'not visible (hidden page) — expected when switched away'); return; }
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: b.x + b.w * 0.2, y: b.y + b.h * 0.2, width: 60, height: 60, scale: 2 } });
  const fs = await import('node:fs');
  const out = `/tmp/replay2-${tag}.png`;
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(tag, histOf(out).trim().split('\n')[0]);
};

await check('T0-overview', 'ovGnTreemap');
await evl(`document.querySelector('#nav button[data-page="mining"]')?.click()`);
await sleep(12000);
await check('T1-mining', 'gnMempoolTreemap');
await sleep(12000);
await check('T2-mining-24s', 'gnMempoolTreemap');
await evl(`document.querySelector('#nav button[data-page="overview"]')?.click()`);
await sleep(8000);
await check('T3-back-overview', 'ovGnTreemap');
ws.close();
