// THE 2.5D RENDERER IN A REAL BROWSER: what it paints, and how often.
//
//   node scripts/renderer-25d-check.mjs [--out <dir>] [--size 2560x1300] [--gpu [vulkan]]
//
// Serves public/ on a loopback port, starts a headless chromium (the same harness as gl-compare.mjs:
// CDP over Node's WebSocket, zero dependencies), and on one page draws the Block space board, the
// Markets board and a game well with renderer '2.5d', under the SHIPPED settings (sky on, effects
// on) -- then lets thirty virtual seconds pass and counts the animation frames each board painted.
// The claim under test is the renderer's whole reason to exist: a resting 2.5D board paints NOTHING.
// The same boards on Software are counted beside it for the comparison, and each board's one paint
// is timed. PNGs of every board go to --out for looking at.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', path.join(os.tmpdir(), 'blockyard-25d'));
const SIZE = arg('--size', '1280x720');
const GPU = process.argv.includes('--gpu') ? (arg('--gpu', '').startsWith('--') || !arg('--gpu', '') ? true : arg('--gpu')) : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;background:#000} .wrap{position:relative;width:${SIZE.split('x')[0]}px;height:${SIZE.split('x')[1]}px} canvas.board{width:100%;height:100%;display:block}</style>
<div id="host"></div>
<script type="module">
const out = { boards: [], errors: [] };
window.__out = out;
window.addEventListener('error', (e) => out.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => out.errors.push(String(e.reason)));
try {
  let VT = 1000; const q = []; let painted = 0;
  performance.now = () => VT;
  let rafId = 0;
  window.requestAnimationFrame = (fn) => { fn.id = ++rafId; q.push(fn); return fn.id; };
  window.cancelAnimationFrame = (id) => { const i = q.findIndex((fn) => fn.id === id); if (i >= 0) q.splice(i, 1); };
  const realTimeout = window.setTimeout;
  window.setTimeout = (fn, ms) => realTimeout(fn, 1e9);      // idle-effect timers never fire here
  let seed = 1;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // an animation frame that RUNS is a frame painted: the loop asks for the next one from inside it
  const pump = (ms, dt) => { for (let t = 0; t < ms; t += dt) { VT += dt; const run = q.splice(0); for (const fn of run) { painted++; fn(VT); } } };

  const d3 = await import('/js/details3d.js');
  const mk = await import('/js/markets.js');
  const st = await import('/js/settings.js');
  const S = st.normalise(null);
  let r = 7; const rnd = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 4294967296; };
  const cells = [];
  for (let i = 0; i < 420; i++) cells.push({ txid: (i.toString(16).padStart(8, '0')).repeat(8), vbytes: Math.round(140 + Math.pow(rnd(), 4) * 60000), rate: 1 + Math.pow(rnd(), 3) * 300 });
  const cells2 = cells.slice(40).concat(cells.slice(0, 20).map((c) => ({ ...c, txid: 'f' + c.txid.slice(1) })));
  const candles = []; let p = 64000;
  for (let i = 0; i < 72; i++) { const o = p; p += (rnd() - 0.48) * 900; const c = p; candles.push({ t: Date.UTC(2026, 8, 18) + i * 3600e3, o, c, h: Math.max(o, c) + rnd() * 300, l: Math.min(o, c) - rnd() * 300, v: 10 + rnd() * 90 }); }
  const ser = { candles, base: { id: 'x', name: 'Test', pair: 'BTC/USD' } };
  const host = document.getElementById('host');
  const stage = () => { host.innerHTML = '<div class="wrap"><canvas class="board"></canvas></div>'; return host.querySelector('canvas'); };
  const boards = {
    space: (canvas, data, extra) => d3.render3d(canvas, data, { ...st.spaceOptions(S), ...extra }),
    markets: (canvas, data, extra) => {
      const c3 = mk.chart3d(ser, { zMax: mk.fitZ(canvas.clientWidth / canvas.clientHeight, 72 * mk.C3.slot) });
      const cam = { ...mk.CAMERA_3D, oblique: { ...mk.CAMERA_3D.oblique, headroom: mk.C3.zBase + c3.zMax + 2 } };
      return d3.board3d(canvas, c3.tiles, { ...cam, gridW: c3.gridW, gridH: c3.gridH, axes: c3.axes, ...st.marketsOptions(S), ...extra });
    },
    well: (canvas, data, extra) => {
      const tiles = [];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) if ((x * 7 + y * 3) % 4) tiles.push({ txid: 'w' + x + ',' + y, x, y, s: 1, tall: 1, color: ['#e84d4d', '#4da3e8', '#e8c84d', '#5ce87a'][(x + y) % 4] });
      return d3.board3d(canvas, tiles, { gridW: 10, gridH: 20, background: 'rgba(0,0,0,0)', stars: false, still: true, hover: false, neon: true, sheen: true, overheadLight: true, ...extra });
    },
  };
  const grab = (canvas) => {
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    for (const el of canvas.parentElement.querySelectorAll('canvas')) g.drawImage(el, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  };
  for (const board of ['space', 'markets', 'well']) {
    for (const renderer of ['2.5d', 'software']) {
      seed = 1; VT = 1000; q.length = 0; painted = 0;
      const canvas = stage();
      const t0 = Date.now();
      boards[board](canvas, cells, { renderer });
      canvas.getContext('2d').getImageData(0, 0, 1, 1);      // the paint actually happens inside the timing
      const paintMs = Date.now() - t0;
      pump(30000, 16);                                       // thirty seconds at rest
      const rest = painted;
      // hover over the middle of the panel: what it costs to light a tile
      painted = 0;
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: canvas.clientWidth / 2, clientY: canvas.clientHeight * 0.55, bubbles: true }));
      pump(2000, 16);
      const hover = painted;
      // a refresh with new data: the flight (or, on 2.5D, the one frame)
      painted = 0;
      if (board === 'space') { boards[board](canvas, cells2, { renderer }); pump(30000, 16); }
      const refresh = painted;
      out.boards.push({ board, renderer, used: d3.rendererIn(canvas), paintMs, rest, hover, refresh, png: grab(canvas) });
      await new Promise((res) => realTimeout(res, 0));
    }
  }
} catch (e) { out.errors.push(String(e && e.stack || e)); }
out.done = true;
</script>`;

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  const file = path.join(ROOT, path.normalize(url.pathname));
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cdpPort = 9400 + (process.pid % 500);
const snapHome = path.join(os.homedir(), 'snap', 'chromium', 'common');
const profile = path.join(existsSync(snapHome) ? snapHome : os.tmpdir(), `blockyard-25d-${process.pid}`);
await mkdir(profile, { recursive: true });
const bin = process.env.CHROMIUM ?? 'chromium';
const chrome = spawn(bin, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  ...(GPU ? ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${GPU === true ? 'default' : GPU}`, '--enable-features=Vulkan'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']), '--hide-scrollbars', '--window-size=1000,800', 'about:blank'], { stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch { try { chrome.kill('SIGKILL'); } catch { /* gone */ } } server.close(); rm(profile, { recursive: true, force: true }).catch(() => {}); };
let code = 0;
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { page = JSON.parse(await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).text()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  }
  if (!page) throw new Error('chromium did not come up');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, (m) => res(m.result ?? m.error ?? {})); ws.send(JSON.stringify({ id, method, params })); });
  const evl = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  let done = false;
  for (let i = 0; i < 300 && !done; i++) { await sleep(1000); done = await evl('!!(window.__out && window.__out.done)'); }
  const n = await evl('window.__out.boards.length');
  const errors = JSON.parse(await evl('JSON.stringify(window.__out.errors)') ?? '[]');
  await mkdir(OUT, { recursive: true });
  console.log(`panel ${SIZE}; frames painted in 30 s at rest, in 2 s after a hover, in 30 s after a refresh with new data; ms for the first paint`);
  console.log('board     renderer  used      rest  hover  refresh   paint ms');
  for (let i = 0; i < n; i++) {
    const b = JSON.parse(await evl(`JSON.stringify(window.__out.boards[${i}])`));
    await writeFile(path.join(OUT, `${b.board}-${b.renderer}.png`), Buffer.from(b.png.split(',')[1], 'base64'));
    const bad = b.renderer === '2.5d' && (b.used !== '2.5d' || b.rest !== 0 || b.hover > 1 || b.refresh > 1);
    if (bad) code = 1;
    console.log(`${b.board.padEnd(9)} ${b.renderer.padEnd(9)} ${b.used.padEnd(9)} ${String(b.rest).padStart(4)}  ${String(b.hover).padStart(5)}  ${String(b.refresh).padStart(7)}   ${String(b.paintMs).padStart(6)}${bad ? '   <-- 2.5D painted on its own' : ''}`);
  }
  if (!done) { console.log('TIMED OUT'); code = 1; }
  if (errors.length) { code = 1; console.log('\nERRORS'); for (const e of errors) console.log('  ' + e); }
  console.log(`\npictures: ${OUT}`);
} catch (e) { console.log(String(e?.stack ?? e)); code = 1; }
stop();
process.exit(code);
