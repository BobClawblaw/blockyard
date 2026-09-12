// Is `createPattern` a no-op on the LIVE canvas, in the live page?
// One question, measured on the real element: fill a known red block, then paint the
// same block with a pattern made from a red-tile canvas on that same context, and read
// the pixels back. A canvas context that silently drops pattern fills returns 0.
const CDP = 'http://127.0.0.1:9333';
const BASE = process.env.BLOCKYARD_BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = JSON.parse(await (await fetch(`${CDP}/json/list`)).text());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => new Promise((r) => { const i = id++; pend.set(i, (x) => r(x.result ?? x.error ?? {})); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evl = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true }))?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}#overview` });
await sleep(5000);
await evl(`document.querySelector('#nav button[data-page="mining"]')?.click()`);
await sleep(4000);
console.log(await evl(`(() => {
  const c = document.getElementById('gnMempoolTreemap');
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#ff0000'; g.fillRect(40, 40, 60, 60);
  const tile = document.createElement('canvas'); tile.width = 4; tile.height = 4;
  const tc = tile.getContext('2d');
  tc.fillStyle = '#00ff00'; tc.fillRect(0, 0, 2, 2);
  let pat = null; let err = null;
  try { pat = g.createPattern(tile, 'repeat'); } catch (e) { err = String(e); }
  if (pat) { g.fillStyle = pat; g.fillRect(140, 40, 60, 60); }
  const px = (x) => { const d = g.getImageData(x, 60, 1, 1).data; return [d[0], d[1], d[2], d[3]]; };
  return JSON.stringify({ patternType: typeof pat, err, redBlock: px(60), patternBlock: pat ? px(160) : 'no pattern', });
})()`));
ws.close();
