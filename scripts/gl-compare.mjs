// THE TWO RENDERERS, SIDE BY SIDE, IN A REAL BROWSER.
//
// gl2d.js is tested under node against a recording stub, which proves what it ASKS the GPU for.
// What comes out is a different question, and only a browser answers it. This script serves
// public/ on a loopback port, starts a headless chromium (software GL: SwiftShader, so it runs on
// a box with no GPU), and on one page draws every scene TWICE -- once with renderer: 'software',
// once with renderer: 'webgl' -- on a virtual clock with a seeded Math.random, so both renderers
// are handed the same frame of the same effect. It reports, per scene, how far apart the pixels
// are, and writes each pair as PNGs to look at.
//
//   node scripts/gl-compare.mjs [--out <dir>] [--only ripple,pulsar] [--size 720x450] [--bench]
//
// Zero dependencies: chromium speaks CDP over a WebSocket and Node 22 ships one. Exit 1 when a
// scene threw, fell back to software, or differs by more than the budget.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', path.join(os.tmpdir(), 'blockyard-gl-compare'));
const ONLY = arg('--only', '');
const SIZE = arg('--size', '720x450');
const BENCH = process.argv.includes('--bench');
// --look: WebGL with its own finish on (bloom, dither) -- it is MEANT to differ from Software, so
// nothing is judged; the pairs are written to look at. Without it the finish is off and pixels must agree.
const LOOK = process.argv.includes('--look');
// --gpu [vulkan|gl-egl|...]: the machine's own graphics card instead of SwiftShader. The report names
// the renderer the browser actually got, because asking for a GPU and being given one are different things.
const GPU = process.argv.includes('--gpu') ? (arg('--gpu', '').startsWith('--') || !arg('--gpu', '') ? true : arg('--gpu')) : false;
const AT = Number(arg('--at', '0.45'));                 // how far through the effect the pictures are taken
const BUDGET = Number(arg('--budget', '6'));             // mean absolute difference per channel, 0-255
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset="utf-8"><title>gl-compare</title>
<style>body{margin:0;background:#000} .wrap{position:relative;width:${SIZE.split('x')[0]}px;height:${SIZE.split('x')[1]}px} canvas.board{width:100%;height:100%;display:block}</style>
<div id="host"></div>
<script type="module">
const out = { scenes: [], errors: [] };
window.__out = out;
window.addEventListener('error', (e) => out.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => out.errors.push(String(e.reason)));
try {
  // ---- the virtual clock and the seeded dice, installed BEFORE the modules read either
  if (${JSON.stringify(process.argv.includes('--trace'))}) window.__gl2dTrace = new Map();
  let VT = 1000; const q = [];
  performance.now = () => VT;
  let rafId = 0;
  window.requestAnimationFrame = (fn) => { fn.id = ++rafId; q.push(fn); return fn.id; };
  window.cancelAnimationFrame = (id) => { const i = q.findIndex((fn) => fn.id === id); if (i >= 0) q.splice(i, 1); };
  const realTimeout = window.setTimeout;
  window.setTimeout = (fn, ms) => realTimeout(fn, 1e9);      // idle-effect timers never fire here
  let seed = 1;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pump = (ms, dt, each) => { for (let t = 0; t < ms; t += dt) { VT += dt; const run = q.splice(0); for (const fn of run) fn(VT); each?.(); } };
  // both canvases queue their work; a one-pixel readback makes the frame actually happen inside the timing
  const px = new Uint8Array(4);
  const sync = (canvas) => { const glc = canvas.previousElementSibling; if (glc) { const gl = glc.getContext('webgl2'); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } else canvas.getContext('2d').getImageData(0, 0, 1, 1); };

  const d3 = await import('/js/details3d.js');
  const mk = await import('/js/markets.js');
  const st = await import('/js/settings.js');
  const S = st.normalise(null);
  const ONLY = ${JSON.stringify(ONLY)}.split(',').filter(Boolean);
  const BENCH = ${JSON.stringify(BENCH)};

  // ---- the data: a mempool's worth of cells, and three days of candles
  let r = 7; const rnd = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 4294967296; };
  const cells = [];
  for (let i = 0; i < 420; i++) cells.push({ txid: (i.toString(16).padStart(8, '0')).repeat(8), vbytes: Math.round(140 + Math.pow(rnd(), 4) * 60000), rate: 1 + Math.pow(rnd(), 3) * 300 });
  const candles = []; let p = 64000;
  for (let i = 0; i < 72; i++) { const o = p; p += (rnd() - 0.48) * 900; const c = p; candles.push({ t: Date.UTC(2026, 8, 18) + i * 3600e3, o, c, h: Math.max(o, c) + rnd() * 300, l: Math.min(o, c) - rnd() * 300, v: 10 + rnd() * 90 }); }
  const ser = { candles, base: { id: 'x', name: 'Test', pair: 'BTC/USD' } };

  const host = document.getElementById('host');
  const stage = () => { host.innerHTML = '<div class="wrap"><canvas class="board"></canvas></div>'; return host.querySelector('canvas'); };
  const boards = {
    space: (canvas, extra) => d3.render3d(canvas, cells, { ...st.spaceOptions(S), idleFx: false, ...extra }),
    // a game's playfield: tiles the caller laid, no sky of its own, a CLEAR background over whatever
    // is behind the canvas (Tetrust's well over its sky canvas), neon finish, no choreography
    well: (canvas, extra) => {
      const tiles = [];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) if ((x * 7 + y * 3) % 4) tiles.push({ txid: 'w' + x + ',' + y, x, y, s: 1, tall: 1, color: ['#e84d4d', '#4da3e8', '#e8c84d', '#5ce87a'][(x + y) % 4] });
      return d3.board3d(canvas, tiles, { gridW: 10, gridH: 20, background: 'rgba(0,0,0,0)', stars: false, still: true, hover: false, neon: true, sheen: true, overheadLight: true, idleFx: false, ...extra });
    },
    markets: (canvas, extra) => {
      const aspect = canvas.clientWidth / canvas.clientHeight;
      const c3 = mk.chart3d(ser, { zMax: mk.fitZ(aspect, 72 * mk.C3.slot) });
      const cam = { ...mk.CAMERA_3D, oblique: { ...mk.CAMERA_3D.oblique, headroom: mk.C3.zBase + c3.zMax + 2 } };
      return d3.board3d(canvas, c3.tiles, { ...cam, gridW: c3.gridW, gridH: c3.gridH, axes: c3.axes, ...st.marketsOptions(S), idleFx: false, ...extra });
    },
  };
  const grab = (canvas) => {
    const w = canvas.width, h = canvas.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    for (const el of canvas.parentElement.querySelectorAll('canvas')) g.drawImage(el, 0, 0, w, h);   // DOM order IS the stacking order
    return { c, data: g.getImageData(0, 0, w, h).data, w, h };
  };
  const shot = (board, fx, at, renderer, extra) => {
    seed = 1; VT = 1000; q.length = 0;
    const canvas = stage();
    boards[board](canvas, { renderer, glow: ${LOOK ? 'undefined' : '0'}, ...extra });
    pump(200, 50);
    if (fx) { d3.triggerIdle(canvas, fx); }
    // the effect's OWN length: a flat six seconds sampled the pulsar 2.7 s into a 26 s run, before
    // its gas had built up, and reported a slow effect as a fast one
    const ms = fx ? (board === 'markets' && d3.MARKET_MS[fx] ? d3.MARKET_MS[fx] : d3.fxMs(fx) || 6000) * at : 400;
    const s0 = d3.rendererStats(canvas);
    const t0 = Date.now();
    const steps = Math.max(1, Math.round(ms / 50));
    // the worst frame and where in the run it fell: an average hides a phase that stalls
    let worst = 0, worstAt = 0, last = Date.now(), k = 0;
    pump(ms, 50, BENCH ? () => { sync(canvas); const n = Date.now(); k++; if (n - last > worst) { worst = n - last; worstAt = k * 50 / ms * at; } last = n; } : null);
    const wall = Date.now() - t0;
    const g = grab(canvas);
    const s1 = d3.rendererStats(canvas);
    const per = s0 && s1 && s1.frames > s0.frames ? { draws: (s1.draws - s0.draws) / (s1.frames - s0.frames), verts: (s1.verts - s0.verts) / (s1.frames - s0.frames), stencils: (s1.stencils - s0.stencils) / (s1.frames - s0.frames) } : null;
    return { ...g, used: d3.rendererIn(canvas), msPerFrame: wall / steps, per, worst, worstAt, live: s1 && s1.live };
  };

  const scenes = [];
  for (const sky of ['galaxy', 'earth', 'none']) scenes.push({ name: 'space-rest-' + sky, board: 'space', fx: null, extra: { ...st.skyFor({ ...S, space: { ...S.space, sky } }, 'space') } });
  scenes.push({ name: 'markets-rest', board: 'markets', fx: null });
  scenes.push({ name: 'well-clear-neon', board: 'well', fx: null });
  for (const k of d3.SPACE_FX) scenes.push({ name: 'space-' + k, board: 'space', fx: k });
  for (const k of d3.MARKET_FX) scenes.push({ name: 'markets-' + k, board: 'markets', fx: k });

  scenes.push({ name: 'space-rest-form', board: 'space', fx: null, extra: { ...st.skyFor({ ...S, space: { ...S.space, sky: 'form' } }, 'space') }, loose: true });

  // ---- the switch is live, in both directions, and leaves the page as it found it
  if (!ONLY.length || ONLY.includes('switch')) {
    const check = (what, ok) => { if (!ok) out.errors.push('switch: ' + what); };
    // (a look change that arrives mid-transition is parked until the board lands: pump past it)
    seed = 1; VT = 1000; q.length = 0;
    const canvas = stage(); canvas.style.background = 'rgb(2, 9, 6)';
    boards.space(canvas, { renderer: 'software' }); pump(30000, 500);
    check('starts on software', d3.rendererIn(canvas) === 'software' && canvas.parentElement.querySelectorAll('canvas').length === 1);
    boards.space(canvas, { renderer: 'webgl' }); pump(30000, 500);
    const glc = canvas.previousElementSibling;
    check('webgl adds one canvas directly under the board', d3.rendererIn(canvas) === 'webgl' && glc && glc.tagName === 'CANVAS' && canvas.parentElement.querySelectorAll('canvas').length === 2);
    check('the board canvas keeps the pointer and is clear', glc && glc.style.pointerEvents === 'none' && canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] === 0);
    check('the layer covers the board box', glc && glc.offsetWidth === canvas.offsetWidth && glc.offsetHeight === canvas.offsetHeight && glc.offsetLeft === canvas.offsetLeft && glc.offsetTop === canvas.offsetTop);
    check('nothing was raised', getComputedStyle(canvas).zIndex === 'auto');
    boards.space(canvas, { renderer: 'software' }); pump(30000, 500);
    check('back to software removes the layer and restores the styles', d3.rendererIn(canvas) === 'software' && canvas.parentElement.querySelectorAll('canvas').length === 1 && canvas.style.background === 'rgb(2, 9, 6)' && canvas.style.position === '');
    check('and software paints again', canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] === 255);
    // a lost context is Software from the next frame, for good
    boards.space(canvas, { renderer: 'webgl' }); pump(30000, 500);
    const lose = canvas.previousElementSibling.getContext('webgl2').getExtension('WEBGL_lose_context');
    lose.loseContext();
    await new Promise((res) => realTimeout(res, 50));        // the lost event is delivered as a task
    pump(30000, 500);
    check('a lost context falls back to software and keeps painting', d3.rendererIn(canvas) === 'software' && canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] === 255);
    boards.space(canvas, { renderer: 'webgl' }); pump(30000, 500);
    check('and does not try again on that canvas', d3.rendererIn(canvas) === 'software');
    out.switchChecked = true;
  }

  for (const sc of scenes) {
    if (ONLY.length && !ONLY.some((o) => sc.name.includes(o))) continue;
    try {
      const at = sc.at ?? ${AT};
      const b = shot(sc.board, sc.fx, at, 'webgl', sc.extra), a = ${JSON.stringify(process.argv.includes('--gl-only'))} ? b : shot(sc.board, sc.fx, at, 'software', sc.extra);
      let sum = 0, far = 0; const n = a.w * a.h;
      for (let i = 0; i < a.data.length; i += 4) {
        const d0 = Math.abs(a.data[i] - b.data[i]), d1 = Math.abs(a.data[i + 1] - b.data[i + 1]), d2 = Math.abs(a.data[i + 2] - b.data[i + 2]);
        sum += d0 + d1 + d2; if (Math.max(d0, d1, d2) > 48) far++;
      }
      const lit = (d) => { let k = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) k++; return k / n; };
      out.scenes.push({ name: sc.name, loose: !!sc.loose, used: b.used, mean: sum / (3 * n), far: far / n, litSoft: lit(a.data), litGl: lit(b.data), msSoft: a.msPerFrame, msGl: b.msPerFrame, live: b.live, worstSoft: a.worst, worstGl: b.worst, worstGlAt: b.worstAt, per: b.per,
        png: BENCH ? null : [a.c.toDataURL('image/png'), b.c.toDataURL('image/png')] });
    } catch (e) { out.errors.push(sc.name + ': ' + (e && e.stack || e)); }
    await new Promise((res) => realTimeout(res, 0));
  }
} catch (e) { out.errors.push(String(e && e.stack || e)); }
try { const g = document.createElement('canvas').getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); out.gpu = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); } catch (e) { out.gpu = 'unknown: ' + e; }
out.trace = window.__gl2dTrace ? [...window.__gl2dTrace].sort((a, b) => b[1] - a[1]).slice(0, 14) : null;
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
// a snap chromium may write only under its own ~/snap directory (not /tmp, not a dot-directory)
const snapHome = path.join(os.homedir(), 'snap', 'chromium', 'common');
const profile = path.join(existsSync(snapHome) ? snapHome : os.tmpdir(), `blockyard-gl-compare-${process.pid}`);   // per run: a killed browser's children can hold the last one's lock
await mkdir(profile, { recursive: true });
const bin = process.env.CHROMIUM ?? 'chromium';
const chrome = spawn(bin, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  ...(GPU ? ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${GPU === true ? 'default' : GPU}`, '--enable-features=Vulkan'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']), '--hide-scrollbars', `--window-size=1000,800`, 'about:blank'], { stdio: process.env.GL_DEBUG ? 'inherit' : 'ignore', detached: true });
// the whole process GROUP: a snap's launcher is a wrapper, and killing it alone leaves the browser running
const stop = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch { try { chrome.kill('SIGKILL'); } catch { /* gone already */ } } server.close(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still be letting go of it */ } };

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
  const PROFILE = process.argv.includes('--profile');     // where the JS time goes, by function (self time)
  if (PROFILE) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start'); }
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  let done = false;
  for (let i = 0; i < 1800 && !done; i++) { await sleep(1000); done = await evl('!!(window.__out && window.__out.done)'); if (i % 20 === 19) console.log(`  ... ${await evl('window.__out ? window.__out.scenes.length : 0')} scenes`); }
  if (PROFILE) {
    const { profile } = await send('Profiler.stop');
    const self = new Map(); const dt = profile.timeDeltas; const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
    profile.samples.forEach((id, i) => { const f = byId.get(id).callFrame; const k = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\//, '')}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); });
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    console.log('\nself time by function (both renderers, whole run)');
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 28)) console.log(`  ${(v / 1000).toFixed(0).padStart(7)} ms ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
  const n = await evl('window.__out.scenes.length');
  const errors = JSON.parse(await evl('JSON.stringify(window.__out.errors)') ?? '[]');
  await mkdir(OUT, { recursive: true });
  console.log('scene                          used      mean   far%   lit soft/gl    ms/frame soft -> gl');
  for (let i = 0; i < n; i++) {
    const s = JSON.parse(await evl(`JSON.stringify(window.__out.scenes[${i}])`));
    if (s.png) for (const [j, tag] of [[0, 'software'], [1, 'webgl']]) await writeFile(path.join(OUT, `${s.name}-${tag}.png`), Buffer.from(s.png[j].split(',')[1], 'base64'));
    const bad = s.used !== 'webgl' || !LOOK && s.mean > (s.loose ? 40 : BUDGET) || s.litGl < s.litSoft * 0.8;
    if (bad) code = 1;
    console.log(`${s.name.padEnd(30)} ${s.used.padEnd(9)} ${s.mean.toFixed(2).padStart(5)}  ${(s.far * 100).toFixed(2).padStart(5)}   ${(s.litSoft * 100).toFixed(1).padStart(5)}/${(s.litGl * 100).toFixed(1).padEnd(5)}   ${s.msSoft.toFixed(1).padStart(7)} -> ${s.msGl.toFixed(1).padEnd(7)} ${s.worstGl ? `worst ${s.worstSoft}/${s.worstGl}ms @${s.worstGlAt.toFixed(2)} ` : ''}${s.per ? `${Math.round(s.per.draws)} draws ${Math.round(s.per.stencils)} stencils ${Math.round(s.per.verts / 1000)}k verts${s.live ? ` (board live: ${s.live})` : ''}` : ''}${bad ? '   <-- LOOK' : ''}`);
  }
  const trace = JSON.parse(await evl('JSON.stringify(window.__out.trace)') ?? 'null');
  if (trace) { console.log('\nstencil passes by call site'); for (const [k, v] of trace) console.log(`  ${String(v).padStart(7)}  ${k}`); }
  if (await evl('!!window.__out.switchChecked')) console.log(`\nlive switch, restore and lost-context fallback: ${errors.some((e) => e.startsWith('switch:')) ? 'FAILED' : 'ok'}`);
  if (!done) { console.log('TIMED OUT'); code = 1; }
  if (errors.length) { code = 1; console.log('\nERRORS'); for (const e of errors) console.log('  ' + e); }
  console.log(`\nWebGL renderer: ${await evl('window.__out.gpu')}`);
  console.log(`\npictures: ${OUT}`);
} catch (e) { console.log(String(e?.stack ?? e)); code = 1; }
stop();
process.exit(code);
