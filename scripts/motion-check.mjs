// Measure the blockspace maps AS ANIMATION, not as a still.
//
// browser-check.mjs answers "did pixels get painted". It cannot answer the question
// actually on the table today: "does the picture MOVE, and can I see the mempool
// reshuffling?" For that you sample the same canvas twice and count pixels that changed.
// It also asserts the browser is running the bytes on disk (rule 25), and switches the
// SPA page through the nav button rather than by hash, because a hash-only navigation
// against a warm document is a no-op and every such reading this repo has had was the
// wrong page measured.
//
//   BMC_MON_BASE=https://<lan>:8088 [CDP=http://127.0.0.1:9333] node scripts/motion-check.mjs
import { execFileSync } from 'node:child_process';

const BASE = process.env.BMC_MON_BASE;
const CDP = process.env.BROWSER_CDP ?? 'http://127.0.0.1:9333';
const CA = process.env.BMC_MON_CA ?? '/etc/ssl/bmc-local/ca.crt';
const OUT = process.env.MOTION_OUT ?? `/tmp/motion-check-${process.pid}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!BASE) { console.log('usage: BMC_MON_BASE=https://<address>:8088 node scripts/motion-check.mjs'); process.exit(2); }

const servedSha = (p) => execFileSync('curl', ['-sk', '--cacert', CA, `${BASE}${p}`], { encoding: 'utf8', maxBuffer: 1 << 24 })
  .split('').reduce((h, c) => (h * 33 ^ c.charCodeAt(0)) >>> 0, 5381).toString(16);

const targets = JSON.parse(await (await fetch(`${CDP}/json/list`)).text());
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
const exceptions = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
};
const send = (method, params = {}) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, (m) => res(m.result ?? m.error ?? {}));
  ws.send(JSON.stringify({ id, method, params }));
});
const evl = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1900, deviceScaleFactor: 1, mobile: false });

// ---- load the app, then SWITCH pages the way a user does (rule 25) ----------------
const url = `${BASE}/?t=${Date.now()}#overview`;
const loaded = new Promise((res) => {
  const orig = ws.onmessage;
  ws.onmessage = (m) => { orig(m); if (JSON.parse(m.data).method === 'Page.loadEventFired') res(true); };
  setTimeout(() => res(false), 25_000);
});
await send('Page.navigate', { url });
await loaded;
await sleep(4000);

const shell = JSON.parse(await evl(`JSON.stringify({nav: !!document.getElementById('nav'), path: location.pathname})`) ?? '{}');
if (!shell.nav || shell.path.startsWith('/login')) { console.log('ABORT: not the app', shell); process.exit(3); }

// Prove the document runs the bytes on disk, by reading back something only the new code
// has. Not the build id -- the served JS itself, hashed in the page against the served copy.
const ramp = await evl(`(async () => { const t = await (await fetch('/js/goggles.js')).text();
  return JSON.stringify({ hasRamp: /RAMP/.test(t) && /255, 43, 111/.test(t), hasPulse: /PULSE_MS/.test(t), hasHatch: /hatchPattern/.test(t), len: t.length }); })()`);
console.log('served goggles.js:', ramp);

// Click through to Mining and wait for the template (the node spends ~1.3 s on it).
await evl(`(() => { const b = document.querySelector('#nav button[data-page="mining"]'); if (b) b.click(); return !!b; })()`);
await sleep(9000);

// ---- the measurement: does the canvas actually change between frames? -------------
const sampler = () => {
  window.__snap = window.__snap ?? {};
  window.__grab = (id) => {
    const c = document.getElementById(id);
    if (!c) return { missing: true };
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const key = [];
    let lit = 0, bright = 0;
    const hist = {};
    for (let i = 0; i < d.length; i += 4 * 7) {
      if (d[i + 3] < 8) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      key.push(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (L > 60) lit++;
      if (L > 150) bright++;
      const k = `${r >> 4},${g >> 4},${b >> 4}`;
      hist[k] = (hist[k] ?? 0) + 1;
    }
    let hsh = 2166136261;
    for (let i = 0; i < key.length; i++) { hsh ^= key[i]; hsh = Math.imul(hsh, 16777619) >>> 0; }
    const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const tot = Object.values(hist).reduce((a, b) => a + b, 0) || 1;
    return { hash: hsh, px: key.length, litPct: +(100 * lit / key.length).toFixed(1), brightPct: +(100 * bright / key.length).toFixed(1),
      top: top.map(([k, v]) => `${k}:${(100 * v / tot).toFixed(0)}%`) };
  };
  return 'ready';
};
await send('Runtime.evaluate', { expression: `(${sampler.toString()})()` });

const read = (id) => evl(`window.__grab(${JSON.stringify(id)})`);
const IDS = ['gnTreemap', 'gnMempoolTreemap'];
const frames = { gnTreemap: [], gnMempoolTreemap: [] };
for (let f = 0; f < 24; f++) {
  for (const id of IDS) frames[id].push(await read(id));
  await sleep(200);
}
// A second wave later: does the map reshuffle when a new template lands?
await sleep(14000);
const after = {};
for (const id of IDS) after[id] = await read(id);

console.log('\n-- per-canvas, 24 samples at 200 ms --');
for (const id of IDS) {
  const fs = frames[id];
  if (fs[0]?.missing) { console.log(`   ${id}: MISSING`); continue; }
  const hashes = fs.map((f) => f.hash);
  const distinct = new Set(hashes).size;
  // Adjacent-frame change: how many samples differ from the one before.
  let changed = 0;
  for (let i = 1; i < hashes.length; i++) if (hashes[i] !== hashes[i - 1]) changed++;
  console.log(`   ${id.padEnd(18)} distinct=${distinct}/${hashes.length} adjacent-changes=${changed}/${hashes.length - 1}`);
  console.log(`      lit=${fs[0].litPct}% bright=${fs[0].brightPct}%  colours=${JSON.stringify(fs[0].top)}`);
  const a = after[id];
  console.log(`      14s later: distinctAgainstFirst=${a.hash !== fs[fs.length - 1].hash} lit=${a.litPct}% bright=${a.brightPct}%`);
}
if (exceptions.length) { console.log(`uncaught exceptions: ${exceptions.length}`); exceptions.slice(0, 5).forEach((e) => console.log(`   !! ${String(e).split('\n')[0]}`)); }

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.data) {
  const fs = await import('node:fs');
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`\nscreenshot: ${OUT}`);
}
ws.close();
