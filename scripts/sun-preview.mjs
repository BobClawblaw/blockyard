// THE SUN, FRAME BY FRAME, IN A REAL BROWSER (form-preview.mjs's twin). Serves public/, starts a headless chromium,
// and draws sunsky.js alone (no board over it) at chosen clock values, writing each as a PNG -- a sky is judged by
// looking at it, next to SDO's footage. With several --times it reports how much of the picture moved between them.
//
//   node scripts/sun-preview.mjs [--out <dir>] [--times 60000,120000] [--size 1280x720] [--gpu vulkan]
//        [--place center|top-left|top-right|bottom-left|bottom-right] [--spin 1] [--brightness 0.6] [--fallback]
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', path.join(os.tmpdir(), 'blockyard-sun-preview'));
// --times 60000,62000: absolute clock values (ms) instead of loop fractions -- for judging MOTION: the
// report then says how much of the picture changed between consecutive frames
const TIMES = arg('--times', '60000').split(',').map(Number);
const SPEED = Number(arg('--spin', '1'));
const PLACE = arg('--place', 'center');
const BRIGHT = Number(arg('--brightness', '0.6')), SIZE = Number(arg('--sun-size', '2.6')), CYCLE = Number(arg('--cycle', '0.8')), CHANNEL = arg('--channel', '171'), ACT = !process.argv.includes('--quiet'), PROM = !process.argv.includes('--no-prominences'), DETAIL = arg('--detail', 'high');
const FALLBACK = process.argv.includes('--fallback');     // draw drawSunSky, the 2D sky for machines with no graphics card
const [SW, SH] = arg('--size', '1280x720').split('x').map(Number);
const GPU = process.argv.includes('--gpu') ? arg('--gpu', 'vulkan') : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<canvas id="c" style="width:${SW}px;height:${SH}px;display:block"></canvas>
<script type="module">
const out = { shots: [], errors: [] }; window.__out = out;
try {
  const { sunGlAttach, drawSunSky } = await import('/js/sunsky.js');
  const OPTS = { sunSpin: ${SPEED}, sunBrightness: ${BRIGHT}, sunAt: ${JSON.stringify(PLACE)}, sunSize: ${SIZE}, sunCycle: ${CYCLE}, sunChannel: ${JSON.stringify(CHANNEL)}, sunActivity: ${ACT}, sunProminences: ${PROM}, sunDetail: ${JSON.stringify(DETAIL)} };
  const canvas = document.getElementById('c');
  if (${FALLBACK}) {
    canvas.width = ${SW}; canvas.height = ${SH};
    const c2 = canvas.getContext('2d');
    for (const u of ${JSON.stringify(TIMES)}) {
      const t0 = performance.now();
      c2.fillStyle = '#000'; c2.fillRect(0, 0, ${SW}, ${SH});
      drawSunSky(c2, ${SW}, ${SH}, 1, u, OPTS);
      c2.getImageData(0, 0, 1, 1);
      out.shots.push({ u, ms: performance.now() - t0, w: canvas.width, h: canvas.height, png: canvas.toDataURL('image/png') });
    }
    out.done = true;
    throw new Error('__fallback_done__');
  }
  const ctl = sunGlAttach(canvas, { preserve: true, allowSoftware: true, onCompileError: (l) => out.errors.push('compile: ' + l) });
  if (!ctl) out.errors.push('no controller');
  else for (const u of ${JSON.stringify(TIMES)}) {
    const t0 = performance.now();
    ctl.draw(${SW}, ${SH}, 1, u, OPTS);
    { const g2 = canvas.getContext('webgl2'), w = canvas.width, h = canvas.height, buf = new Uint8Array(w * h * 4); g2.readPixels(0, 0, w, h, g2.RGBA, g2.UNSIGNED_BYTE, buf);
      if (window.__prev) { let ch = 0, sum = 0; for (let i = 0; i < buf.length; i += 4) { const d = Math.abs(buf[i] - window.__prev[i]) + Math.abs(buf[i + 1] - window.__prev[i + 1]) + Math.abs(buf[i + 2] - window.__prev[i + 2]); sum += d; if (d > 24) ch++; } out.motion = (out.motion || []).concat([{ u, changed: ch / (w * h), mean: sum / (3 * w * h) }]); }
      window.__prev = buf; }
    const gl = canvas.getContext('webgl2'); const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.shots.push({ u, ms: performance.now() - t0, w: canvas.width, h: canvas.height, png: canvas.toDataURL('image/png') });
  }
  // the GPU's own time a frame: sixty draws, then one readback that waits for all of them
  if (ctl) {
    const gl = canvas.getContext('webgl2'), px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) ctl.draw(${SW}, ${SH}, 1, 60000 + i * 40, OPTS);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    out.gpuMs = (performance.now() - t0) / 60; out.size = canvas.width + 'x' + canvas.height;
    const e = gl.getExtension('WEBGL_debug_renderer_info'); out.gpu = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?';
  }
} catch (e) { if (!String(e && e.message).includes('__fallback_done__')) out.errors.push(String(e && e.stack || e)); }
out.done = true;
</script>`;
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  const file = path.join(ROOT, path.normalize(url.pathname));
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port, cdpPort = 9400 + (process.pid % 500);
const snapHome = path.join(os.homedir(), 'snap', 'chromium', 'common');
const profile = path.join(existsSync(snapHome) ? snapHome : os.tmpdir(), `blockyard-sun-preview-${process.pid}`);
await mkdir(profile, { recursive: true });
const chrome = spawn(process.env.CHROMIUM ?? 'chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  ...(GPU ? ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${GPU}`, '--enable-features=Vulkan'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']),
  `--window-size=${SW},${SH}`, 'about:blank'], { stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* gone */ } server.close(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* still letting go */ } };
let code = 0;
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { await sleep(500); try { page = JSON.parse(await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).text()).find((t) => t.type === 'page'); } catch { /* not up yet */ } }
  if (!page) throw new Error('chromium did not come up');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, (m) => res(m.result ?? m.error ?? {})); ws.send(JSON.stringify({ id, method, params })); });
  const evl = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  for (let i = 0; i < 300 && !(await evl('!!(window.__out && window.__out.done)')); i++) await sleep(500);
  await mkdir(OUT, { recursive: true });
  const n = await evl('window.__out.shots.length');
  for (let i = 0; i < n; i++) {
    const s = JSON.parse(await evl(`JSON.stringify(window.__out.shots[${i}])`));
    const file = path.join(OUT, `sun-${String(s.u).replace('.', '_')}.png`);
    await writeFile(file, Buffer.from(s.png.split(',')[1], 'base64'));
    console.log(`u=${s.u}  ${s.w}x${s.h}  ${s.ms.toFixed(1)} ms  ${file}`);
  }
  const motion = JSON.parse(await evl('JSON.stringify(window.__out.motion || [])'));
  for (const m of motion) console.log(`  to ${m.u}: ${(m.changed * 100).toFixed(1)}% of pixels changed visibly, mean ${m.mean.toFixed(2)} of 255`);
  if (!FALLBACK) console.log(`GPU time a frame: ${Number(await evl('window.__out.gpuMs')).toFixed(2)} ms at ${await evl('window.__out.size')} on ${await evl('window.__out.gpu')}`);
  const errors = JSON.parse(await evl('JSON.stringify(window.__out.errors)') ?? '[]');
  if (errors.length || !n) { code = 1; for (const e of errors) console.log('ERROR ' + e); }
} catch (e) { console.log(String(e?.stack ?? e)); code = 1; }
stop();
process.exit(code);
