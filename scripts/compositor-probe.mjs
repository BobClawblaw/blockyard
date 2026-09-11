// Which paint operation survives the compositor on the LIVE page, for a LARGE fill on a
// canvas that is being re-painted per frame? The disappearance left a signature: small
// ops (1px bevels, the legend, the cut line) land; the large ops (aggregate base fill,
// crowd tiles, crowd pattern) do not — the aggregate samples as canvas-clear dark, i.e.
// nothing landed there. This probe replicates each candidate op on the live map canvas,
// forces a repaint cycle (like the chase does), and reports which ones persist. The
// result decides the draw path (direct fills / strips / offscreen-state + single blit),
// instead of guessing again.
const CDP = 'http://127.0.0.1:9333';
const BASE = process.env.BMC_MON_BASE;
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
await evl(`document.querySelector('#nav button[data-page="mining"]')?.click()`);
await sleep(12000);

// A scratch canvas the size of the live map, plus a per-frame repaint loop like the
// chase's: every candidate op is painted into it, then the loop runs 30 frames, then we
// sample which ops survived. The live canvas must NOT be written to (it would change
// what the user sees mid-probe).
const out = await evl(`(() => {
  const live = document.getElementById('gnMempoolTreemap');
  const W = live.width, H = live.height;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };

  const mkTile = () => { const t = document.createElement('canvas'); t.width = 24; t.height = 24;
    const tc = t.getContext('2d'); tc.fillStyle = 'rgba(233,240,250,0.5)';
    for (let r=0;r<3;r++) for (let q=0;q<3;q++) tc.fillRect(q*8+1, r*8+1, 6, 6); return t; };

  const results = {};
  const paintAll = (canvas) => {
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, W, H);
    // 1. large solid fill
    g.fillStyle = '#5563f0'; g.fillRect(10, 10, W*0.6, H*0.6);
    // 2. large pattern fill (crowd pattern candidate)
    const t = mkTile();
    let pat = null; try { pat = g.createPattern(t, 'repeat'); } catch (e) {}
    if (pat) { g.fillStyle = pat; g.fillRect(10, H*0.7, W*0.6, H*0.25); }
    results.patternCreated = !!pat;
    // 3. many small fillRects tiling a large region (crowdTiles candidate)
    g.fillStyle = 'rgba(233,240,250,0.16)';
    const side = 6, gap = 1.5, dot = side - gap;
    const x0 = W*0.75, y0 = 10, rw = W*0.22, rh = H*0.85;
    for (let yy = y0; yy < y0 + rh - side; yy += side) for (let xx = x0; xx < x0 + rw - side; xx += side) g.fillRect(xx, yy, dot, dot);
    // 4. strip-decomposed large fill (strip candidate)
    g.fillStyle = '#20c070';
    const sy = H*0.7, sh = H*0.25, sw = W*0.6, sx = W*0.05;
    for (let off = 0; off < sh; off += 32) g.fillRect(sx, sy + off, sw, Math.min(32, sh - off));
    // NOTE: ops are spatially separated so a sample can attribute survival to an op.
    return g;
  };

  const sample = (g) => ({
    solid:   (() => { const d = g.getImageData(Math.round(W*0.3), Math.round(H*0.3), 1, 1).data; return [d[0],d[1],d[2],d[3]].join(','); })(),
    pattern: (() => { const d = g.getImageData(Math.round(W*0.4), Math.round(H*0.82), 1, 1).data; return [d[0],d[1],d[2],d[3]].join(','); })(),
    tiles:   (() => { const d = g.getImageData(Math.round(W*0.86), Math.round(H*0.5), 1, 1).data; return [d[0],d[1],d[2],d[3]].join(','); })(),
    strips:  (() => { const d = g.getImageData(Math.round(W*0.35), Math.round(H*0.82), 1, 1).data; return [d[0],d[1],d[2],d[3]].join(','); })(),
  });

  // A. paint once, read immediately — the baseline (should all land).
  const a = mk(); const ga = paintAll(a); results.immediate = sample(ga);

  // B. paint, then a 30-frame repaint loop like the chase (clear+repaint each frame —
  //    the live canvas's situation), read AFTER. Ops that the compositor eats vanish.
  const b = mk();
  const run = () => new Promise((res) => {
    let n = 0;
    const step = () => {
      const g = b.getContext('2d', { willReadFrequently: true });
      paintAll(b);
      if (++n < 30) requestAnimationFrame(step);
      else { res(sample(b.getContext('2d', { willReadFrequently: true }))); }
    };
    requestAnimationFrame(step);
  });
  results.afterFrames = await run();
  return JSON.stringify(results, null, 1);
})()`);
console.log(out);
ws.close();
