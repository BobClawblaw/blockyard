// Is the aggregate TEXTURE on screen? Sample a 6x6 block of pixels inside its rect,
// count distinct luminance levels and how many differ from the block's median.
// Textured => many distinct values / scattered variation. Flat => one value.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
const BASE = process.env.BMC_MON_BASE;
const CDP = process.env.BROWSER_CDP ?? 'http://127.0.0.1:9333';
const ID = process.env.PROBE_ID ?? 'gnMempoolTreemap';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = JSON.parse(await (await fetch(`${CDP}/json/list`)).text());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, (m) => res(m.result ?? m.error ?? {})); ws.send(JSON.stringify({ id, method, params })); });
const evl = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#overview` });
await sleep(5000);
await evl(`document.querySelector('#nav button[data-page="mining"]')?.click()`);
await sleep(16000);

// --- the instrument's own honesty check -------------------------------------------
// Same texture the map draws, blitted into a scratch canvas on THIS page, sampled with
// the same getImageData. If this comes back flat, the INSTRUMENT is broken (a
// zero-sized or cleared scratch canvas reads as one flat colour), and no verdict about
// the map may be drawn from the sampling path.
const ctl = JSON.parse(await evl(`(() => {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#555f82'; g.fillRect(0, 0, 400, 400);
  const layer = document.createElement('canvas');
  layer.width = 400; layer.height = 400;
  const lc = layer.getContext('2d');
  const side = 4.3;
  lc.fillStyle = 'rgba(233, 240, 250, 0.16)';
  const gap = Math.max(0.5, side * 0.22); const dot = Math.max(1, side - gap);
  for (let r = 0; r * side < 400; r++) for (let q = 0; q * side < 400; q++) lc.fillRect(q * side + gap / 2, r * side + gap / 2, dot, dot);
  g.drawImage(layer, 0, 0, 400, 400);
  const d = g.getImageData(0, 0, 400, 400).data;
  const hist = {}; for (let i = 0; i < d.length; i += 4) { const k = d[i]+','+d[i+1]+','+d[i+2]; hist[k] = (hist[k]||0)+1; }
  return JSON.stringify({ distinct: Object.keys(hist).length, w: c.width, h: c.height });
})()`)) ?? {};
console.log('sampling control (same texture, this page):', JSON.stringify(ctl));
if (!(ctl.distinct > 4)) {
  console.log('ABORT: the sampling path itself reads a known-textured canvas as flat. No verdict about the map is valid.');
  ws.close(); process.exit(4);
}

const raw = await evl(`(() => {
  const c = document.getElementById(${JSON.stringify(ID)});
  const b = c.getBoundingClientRect();
  const v = c.__view;
  const agg = (v?.items ?? []).find(i => i.aggregate);
  if (!agg) return JSON.stringify({noAgg:true});
  return JSON.stringify({ box:{x:b.x,y:b.y}, agg:{x:agg.tx,y:agg.ty,w:agg.tw,h:agg.th,n:agg.aggregate, rate: agg.rate},
    cssSize:{w:Math.round(b.width),h:Math.round(b.height)}, backing:{w:c.width,h:c.height} });
})()`);
const info = JSON.parse(raw);
console.log('state:', raw);
if (info.noAgg) { ws.close(); process.exit(0); }
const cx = Math.round(info.box.x + info.agg.x + info.agg.w * 0.45);
const cy = Math.round(info.box.y + info.agg.y + info.agg.h * 0.45);
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: cx, y: cy, width: 40, height: 40, scale: 1 } });
const out = `/tmp/agg-40px-${process.pid}.png`;
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('40x40 crop inside the aggregate:', out);
const decoded = execFileSync('python3', ['/storage/bmcmonitor/scripts/png-hist.py', out], { encoding: 'utf8' });
console.log(decoded.trim());
ws.close();
