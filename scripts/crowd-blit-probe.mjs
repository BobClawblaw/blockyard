// Draw the crowd texture into a canvas on THIS browser and sample the pixels.
// One question: does the bitmap-blit path put the tiles on screen, here, now?
const CDP = 'http://127.0.0.1:9333';
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
// stay on the current document; just add a scratch canvas
const probe = await evl(`(() => {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#555f82';
  g.fillRect(0, 0, 400, 400);
  const layer = document.createElement('canvas');
  layer.width = 400; layer.height = 400;
  const lc = layer.getContext('2d');
  const n = 8642;
  const side = Math.sqrt((400 * 400) / n);
  lc.fillStyle = 'rgba(233, 240, 250, 0.16)';
  const gap = Math.max(0.5, side * 0.22);
  const dot = Math.max(1, side - gap);
  let tiles = 0;
  for (let rI = 0; rI * side < 400; rI++) {
    for (let cI = 0; cI * side < 400; cI++) { lc.fillRect(cI * side + gap / 2, rI * side + gap / 2, dot, dot); tiles++; }
  }
  g.drawImage(layer, 0, 0, 400, 400);
  const d = g.getImageData(0, 0, 400, 400).data;
  const hist = {};
  for (let i = 0; i < d.length; i += 4) { const k = d[i] + ',' + d[i+1] + ',' + d[i+2]; hist[k] = (hist[k] || 0) + 1; }
  const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return JSON.stringify({ side: +side.toFixed(2), tiles, distinct: Object.keys(hist).length, top });
})()`);
console.log('crowd blit probe:', probe);
ws.close();
