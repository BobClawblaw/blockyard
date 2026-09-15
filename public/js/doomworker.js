// THE DOOM WORKER: the PC runs here, off the page's thread (operator, 2026-09-15: "Get DOOM working
// as a diversion inside blockyard with zero dependancies").
//
// A worker because the emulated 486 wants every millisecond it can get: on the page's own thread it
// would share a 16 ms frame with the layout, the SSE feed and every other tab of the app, and the
// game would stutter whenever the monitor redrew a chart. Here it runs in ~10 ms slices and yields
// between them so key presses arrive; the page draws what it is sent.
//
// Messages in:  boot {rate}, run {on}, key {codes}, mouse {dx, dy, buttons}, audio {port}
// Messages out: status {text}, frame {pixels, palette?}, text {cells, cursor}, stats {mips},
//               saved {name}, exit {code, cells}, error {message}
import { createPC } from './dospc.js';
import { createSoundCard } from './soundcard.js';
import { withControls } from './doomio.js';

const SLICE_MS = 10;

let pc = null, card = null, audioPort = null;
let running = false, scheduled = false;
let clock = 0, lastWall = 0;               // machine time: wall time while running, frozen while not
let lastFrameSeq = -1, lastPalSeq = -1, lastText = null;
let pixels = new Uint8Array(64000);        // bounced back by the page after each frame, to reuse
const yieldChannel = new MessageChannel();
yieldChannel.port1.onmessage = () => { scheduled = false; loop(); };

const post = (m, transfer) => self.postMessage(m, transfer ?? []);
const now = () => (running ? clock + (performance.now() - lastWall) : clock);

// ------------------------------------------------------------------ saved files (IndexedDB)
// Savegames and the config the game writes on quit, kept in this browser. A browser that refuses
// IndexedDB still plays; its saves last as long as the tab.
function db() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('blockyard-doom', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function loadSaved() {
  const d = await db();
  if (!d) return {};
  return new Promise((resolve) => {
    const out = {};
    try {
      const tx = d.transaction('files', 'readonly');
      const cur = tx.objectStore('files').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(out); return; }
        if (c.value instanceof Uint8Array) out[c.key] = c.value;
        c.continue();
      };
      cur.onerror = () => resolve(out);
    } catch { resolve(out); }
  });
}
async function store(name, bytes) {
  const d = await db();
  if (!d) return;
  try {
    const tx = d.transaction('files', 'readwrite');
    if (bytes) tx.objectStore('files').put(bytes, name); else tx.objectStore('files').delete(name);
  } catch { /* quota, private mode: the save lives for this session */ }
}

// ------------------------------------------------------------------ boot
async function fetchFile(name, required) {
  const r = await fetch(`/doom/${name}`, { credentials: 'same-origin' });
  if (!r.ok) {
    if (required) throw new Error(`${name} is not installed: put the shareware DOOM files in doom_dos/ on the server (HTTP ${r.status})`);
    return null;
  }
  return new Uint8Array(await r.arrayBuffer());
}

async function boot({ rate, controls }) {
  post({ type: 'status', text: 'loading DOOM.EXE and DOOM1.WAD…' });
  const [exe, wad, cfg, saved] = await Promise.all([fetchFile('DOOM.EXE', true), fetchFile('DOOM1.WAD', true), fetchFile('DEFAULT.CFG', false), loadSaved()]);
  const files = { 'DOOM1.WAD': wad };
  // the shipped config, then whatever the game wrote back on its last quit
  const baseCfg = saved['DEFAULT.CFG'] ?? cfg;
  if (baseCfg) files['DEFAULT.CFG'] = withControls(baseCfg, controls);
  for (const [name, bytes] of Object.entries(saved)) if (name !== 'DEFAULT.CFG') files[name] = bytes;
  pc = createPC({
    files,
    now,
    sound: rate ? (mem) => (card = createSoundCard({ mem, rate })) : null,
    onWrite: (name, bytes) => { store(name, bytes); post({ type: 'saved', name, deleted: !bytes }); },
    onExit: (code) => { running = false; post({ type: 'exit', code, cells: pc.mem.slice(0xb8000, 0xb8000 + 4000) }); },
    log: (m) => post({ type: 'log', text: m }),
  });
  pc.boot(exe);
  post({ type: 'status', text: 'booted' });
}

// ------------------------------------------------------------------ the loop
function loop() {
  if (!running || !pc || pc.exited) return;
  const start = performance.now();
  let n = 0;
  try {
    do { n += pc.run(150000); } while (performance.now() - start < SLICE_MS && !pc.exited);
  } catch (e) {
    running = false;
    post({ type: 'error', message: e.message });
    return;
  }
  const spent = performance.now() - start;
  mips = mips * 0.95 + (n / Math.max(0.001, spent)) * 0.05 * 1000 / 1e6;
  present();
  if (card && audioPort && card.buffered > 0) {
    const chunk = card.drain();
    audioPort.postMessage(chunk, [chunk.buffer]);
  }
  if (performance.now() - lastStats > 1000) { lastStats = performance.now(); post({ type: 'stats', mips }); }
  if (!scheduled) { scheduled = true; yieldChannel.port2.postMessage(0); }
}
let mips = 0, lastStats = 0;

function present() {
  if (pc.vga.mode === 0x13) {
    lastText = null;
    if (pc.vga.frames === lastFrameSeq && pc.vga.palSeq === lastPalSeq) return;
    if (!pixels) return;                       // the page still has the last frame
    lastFrameSeq = pc.vga.frames;
    const m = { type: 'frame', pixels: pc.renderIndexed(pixels) };
    if (pc.vga.palSeq !== lastPalSeq) { lastPalSeq = pc.vga.palSeq; m.palette = pc.vga.pal.slice(); }
    const buf = pixels.buffer;
    pixels = null;
    post(m, [buf]);
    return;
  }
  lastFrameSeq = -1; lastPalSeq = -1;
  const cells = pc.mem.subarray(0xb8000, 0xb8000 + 4000);
  if (lastText && lastText.every((v, i) => v === cells[i])) return;
  lastText = cells.slice();
  post({ type: 'text', cells: lastText.slice(), cursor: [pc.text.x, pc.text.y] });
}

function setRunning(on) {
  if (on === running) return;
  if (on) { lastWall = performance.now(); running = true; loop(); }
  else { clock = now(); running = false; }
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'boot': await boot(m); setRunning(true); break;
      case 'run': setRunning(m.on); break;
      case 'key': if (pc) for (const c of m.codes) pc.key(c); break;
      case 'mouse':
        if (pc) { pc.mouse.dx += m.dx; pc.mouse.dy += m.dy; pc.mouse.buttons = m.buttons; }
        break;
      case 'audio': audioPort = m.port; break;
      case 'pixels': pixels = new Uint8Array(m.buffer); break;
    }
  } catch (err) {
    running = false;
    post({ type: 'error', message: err.message });
  }
};
