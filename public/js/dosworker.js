// THE DOS WORKER: the PC runs here, off the page's thread, for the DOOM and Quake Diversions
// (operator, 2026-09-15: "Get DOOM working as a diversion inside blockyard with zero dependancies",
// then "get Quake working as a diversion").
//
// A worker because the emulated 486 wants every millisecond it can get: on the page's own thread it
// would share a 16 ms frame with the layout, the SSE feed and every other tab of the app, and the
// game would stutter whenever the monitor redrew a chart. Here it runs in ~10 ms slices and yields
// between them so key presses arrive; the page draws what it is sent.
//
// Messages in:  boot {game, rate, controls}, run {on}, key {codes}, mouse {dx, dy, buttons}, audio {port}
// Messages out: status {text}, frame {pixels, palette?}, text {cells, cursor}, stats {mips},
//               saved {name}, exit {code, cells}, error {message}
//               (and controls {scheme}: rebind the running game's keys)
import { createPC } from './dospc.js';
import { createSoundCard } from './soundcard.js';
import { withControls, rebindKeys, quakeAutoexec, GAMES } from './dosio.js';

const SLICE_MS = 10;
const CHUNK = 50000;                       // instructions between looks for a finished picture

let pc = null, card = null, audioPort = null;
let running = false, scheduled = false;
let clock = 0, lastWall = 0;               // machine time: wall time while running, frozen while not
let lastFrameSeq = -1, lastPalSeq = -1, lastText = null;
let pixels = new Uint8Array(64000);        // bounced back by the page after each frame, to reuse
let lastWrites = -1, seenWrites = -1;
const keyEntries = {};                     // where DOOM's key settings live, once found
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
      const req = indexedDB.open(game.db, 1);
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
let game = null;
async function fetchFile(name, required) {
  const r = await fetch(`/games/${game.key}/${name}`, { credentials: 'same-origin' });
  if (!r.ok) {
    if (required) throw new Error(`${name} is not installed: put the shareware files in ${game.dir}/ on the server (HTTP ${r.status})`);
    return null;
  }
  return new Uint8Array(await r.arrayBuffer());
}

async function boot({ game: key = 'doom', rate, controls }) {
  game = { key, ...GAMES[key] };
  if (!GAMES[key]) throw new Error(`no game called ${key}`);
  post({ type: 'status', text: `loading ${game.label}…` });
  const names = [game.exe, ...game.required, ...game.optional];
  const [saved, ...got] = await Promise.all([loadSaved(), ...names.map((n, i) => fetchFile(n, i <= game.required.length))]);
  const fetched = Object.fromEntries(names.map((n, i) => [n, got[i]]));
  const files = {};
  for (const n of [...game.required, ...game.optional]) if (fetched[n]) files[n] = fetched[n];
  // the game's saves and the config it wrote on its last quit, over the shipped ones
  const firstRun = !saved[game.config];
  for (const [name, bytes] of Object.entries(saved)) files[name] = bytes;
  if (key === 'doom' && files[game.config]) files[game.config] = withControls(files[game.config], controls);
  if (key === 'quake') files['ID1/AUTOEXEC.CFG'] = quakeAutoexec({ firstRun });
  pc = createPC({
    files,
    args: game.args,
    programName: game.exe,
    now,
    sound: rate ? (mem) => (card = createSoundCard({ mem, rate })) : null,
    onWrite: (name, bytes) => { store(name, bytes); post({ type: 'saved', name, deleted: !bytes }); },
    onExit: (code) => { running = false; post({ type: 'exit', code, cells: pc.mem.slice(0xb8000, 0xb8000 + 4000) }); },
    log: (m) => post({ type: 'log', text: m }),
  });
  pc.boot(fetched[game.exe]);
  post({ type: 'status', text: 'booted' });
}

// ------------------------------------------------------------------ the loop
function loop() {
  if (!running || !pc || pc.exited) return;
  const start = performance.now();
  let n = 0;
  try {
    // in chunks of about half a millisecond, looking for a finished picture after each: at 50 frames
    // a second two of Quake's frame copies could otherwise land in one 10 ms slice and one never be shown
    do { n += pc.run(CHUNK); present(); } while (performance.now() - start < SLICE_MS && !pc.exited);
  } catch (e) {
    running = false;
    post({ type: 'error', message: e.message });
    return;
  }
  const spent = performance.now() - start;
  mips = mips * 0.95 + (n / Math.max(0.001, spent)) * 0.05 * 1000 / 1e6;
  if (card && audioPort && card.buffered > 0) {
    const chunk = card.drain();
    audioPort.postMessage(chunk, [chunk.buffer]);
  }
  if (performance.now() - lastStats > 1000) { lastStats = performance.now(); post({ type: 'stats', mips }); }
  if (!scheduled) { scheduled = true; yieldChannel.port2.postMessage(0); }
}
let mips = 0, lastStats = 0, textTick = 0;

function present() {
  if (pc.vga.mode === 0x13) {
    lastText = null;
    // a new picture: a page flipped (DOOM), the palette changed, or the linear window was written
    // (Quake copies each finished frame into A0000h and never flips). A copy can straddle two chunks,
    // so writes are only shown once a chunk has passed without any: never half a frame
    const writing = pc.vga.writes !== seenWrites;
    seenWrites = pc.vga.writes;
    if (writing && pc.vga.frames === lastFrameSeq) return;
    if (pc.vga.frames === lastFrameSeq && pc.vga.palSeq === lastPalSeq && pc.vga.writes === lastWrites) return;
    if (!pixels) return;                       // the page still has the last frame
    lastFrameSeq = pc.vga.frames; lastWrites = pc.vga.writes;
    const m = { type: 'frame', pixels: pc.renderIndexed(pixels) };
    if (pc.vga.palSeq !== lastPalSeq) { lastPalSeq = pc.vga.palSeq; m.palette = pc.vga.pal.slice(); }
    const buf = pixels.buffer;
    pixels = null;
    post(m, [buf]);
    return;
  }
  lastFrameSeq = -1; lastPalSeq = -1;
  if (++textTick % 20 !== 0) return;          // text mode changes slowly: look every ten milliseconds
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
      case 'controls':
        if (pc) {
          // the running game's keys now, and the config it would read if it started again
          rebindKeys(pc.mem, m.scheme, keyEntries);
          const cfg = pc.dir.get('DEFAULT.CFG');
          if (cfg) pc.dir.set('DEFAULT.CFG', withControls(cfg, m.scheme));
        }
        break;
      case 'audio': audioPort = m.port; break;
      case 'pixels': pixels = new Uint8Array(m.buffer); break;
    }
  } catch (err) {
    running = false;
    post({ type: 'error', message: err.message });
  }
};
