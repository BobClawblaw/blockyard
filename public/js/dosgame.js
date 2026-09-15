// A DOS GAME, THE TAB: what the DOOM and Quake Diversions share (operator, 2026-09-15: "Get DOOM
// working as a diversion inside blockyard with zero dependancies", then "get Quake working as a
// diversion").
//
// THE REAL GAMES. Not ports and not remakes: the shareware executables from games/, unmodified,
// running on a PC this repository emulates -- an i386 (x86.js), the DOS extender and the PC around
// it (dospc.js), a Sound Blaster Pro 2 with its OPL3 (soundcard.js) -- inside a worker
// (dosworker.js). A game's tab is this module with its own names: the monitor, the keyboard, the
// mouse and the speakers. It draws the frames the worker sends, and sends the worker scancodes,
// mouse motion and the audio port.
//
// Same manners as the other Diversions: it pauses when you change tabs or look away, holds the
// machine exactly where it was (the emulated clock stops with it, so nothing moves), and resumes on
// the button. Savegames and the config a game writes on quit are kept in this browser.
import { scancodes, textRuns, paletteLut } from './dosio.js';

/**
 * One game's tab. `spec`:
 *   game       the worker's name for it ('doom', 'quake')
 *   page       the app's page id
 *   prefix     the element id prefix in index.html ('doom' -> doomScreen, doomPlay, ...)
 *   title      shown on the overlay
 *   idleText, loadingText
 *   saveName   a RegExp for the files worth a "saved" toast
 *   keysText(prefs)  the HUD's key list
 *   switches   [{ id, pref, fallback, on(value), flip(value) -> value, apply(value, G) }]
 *   bootMessage(prefs) -> extra fields for the worker's boot message
 * Returns the page's render hook for app.js.
 */
export function createDosGame(spec) {
  const pfx = spec.prefix;
  const SMOOTH_KEY = `blockyard.${spec.game}.smooth`;
  const MUTE_KEY = `blockyard.${spec.game}.mute`;

  const G = {
    worker: null, state: null, h: null, bound: false,
    phase: 'idle',            // idle | loading | running | paused | exited | failed
    why: '',
    audio: null, gain: null, speakers: null, connect: null,
    lut: new Uint32Array(256), image: null, ctx: null,
    held: new Set(), mouse: { dx: 0, dy: 0, buttons: 0, dirty: false },
    frames: 0, fps: 0, mips: 0, fpsAt: 0, raf: null,
    mode: 'graphics',
  };

  const el = (name) => document.getElementById(`${pfx}${name}`);
  const pref = (key, fallback) => { try { return globalThis.localStorage?.getItem(key) ?? fallback; } catch { return fallback; } };
  const setPref = (key, v) => { try { globalThis.localStorage?.setItem(key, v); } catch { /* private mode */ } };

  // ---------------------------------------------------------------- the screen
  function screen() {
    const c = el('Screen');
    if (!c) return null;
    if (!G.ctx || G.ctx.canvas !== c) { G.ctx = c.getContext('2d', { alpha: false }); G.image = null; }
    return c;
  }

  function drawFrame(pixels, palette) {
    const c = screen();
    if (!c) return;
    if (palette) paletteLut(palette, G.lut);
    if (G.mode !== 'graphics' || c.width !== 320) { c.width = 320; c.height = 200; G.mode = 'graphics'; G.image = null; }
    if (!G.image) G.image = G.ctx.createImageData(320, 200);
    const px = new Uint32Array(G.image.data.buffer);
    const lut = G.lut;
    for (let i = 0; i < 64000; i++) px[i] = lut[pixels[i]];
    G.ctx.putImageData(G.image, 0, 0);
    G.frames++;
  }

  // text mode: a game's start-up log, and DOOM's ENDOOM when it quits -- 80x25 cells at 8x16 pixels
  function drawText(cells) {
    const c = screen();
    if (!c) return;
    if (G.mode !== 'text') { c.width = 640; c.height = 400; G.mode = 'text'; }
    const ctx = G.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 400);
    ctx.font = '15px ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    const w = ctx.measureText('M').width || 8;
    for (const run of textRuns(cells)) {
      if (run.bg !== '#000000') { ctx.fillStyle = run.bg; ctx.fillRect(run.x * 8, run.y * 16, run.text.length * 8, 16); }
      if (!run.text.trim()) continue;
      ctx.fillStyle = run.fg;
      for (let i = 0; i < run.text.length; i++) {
        const ch = run.text[i];
        if (ch === ' ' || ch === '\u0000') continue;
        // block elements fill their cell exactly; glyphs are squeezed to the cell's eight pixels
        const x = (run.x + i) * 8, y = run.y * 16;
        if (ch === '█') { ctx.fillRect(x, y, 8, 16); continue; }
        if (ch === '▀') { ctx.fillRect(x, y, 8, 8); continue; }
        if (ch === '▄') { ctx.fillRect(x, y + 8, 8, 8); continue; }
        if (ch === '▌') { ctx.fillRect(x, y, 4, 16); continue; }
        if (ch === '▐') { ctx.fillRect(x + 4, y, 4, 16); continue; }
        ctx.setTransform(8 / w, 0, 0, 1, x, y + 1);
        ctx.fillText(ch, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }

  // ---------------------------------------------------------------- the overlay and HUD
  function overlay(msg, sub, button, dim = true) {
    const ov = el('Over');
    if (!ov) return;
    ov.classList.toggle('hidden', !msg);
    ov.classList.toggle('dim', dim);
    el('Msg').textContent = msg ?? '';
    el('Sub').textContent = sub ?? '';
    const b = el('Play');
    if (b) { b.textContent = button ?? 'play'; b.classList.toggle('hidden', !button); }
  }

  const switchValue = (sw) => pref(sw.pref, sw.fallback);
  const prefsNow = () => Object.fromEntries((spec.switches ?? []).map((sw) => [sw.pref, switchValue(sw)]));
  function drawHud() {
    const keys = el('Keys');
    if (keys) keys.textContent = spec.keysText(prefsNow());
    const lights = [...(spec.switches ?? []).map((sw) => [sw.id, sw.on(switchValue(sw))]),
      ['Smooth', pref(SMOOTH_KEY, '0') === '1'], ['Sound', pref(MUTE_KEY, '0') !== '1']];
    for (const [id, on] of lights) {
      const b = el(id);
      if (!b) continue;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    el('Screen')?.classList.toggle('smooth', pref(SMOOTH_KEY, '0') === '1');
    const st = el('Status');
    if (st) {
      const rows = [
        ['machine', { idle: 'off', loading: 'booting', running: 'running', paused: 'paused', exited: 'powered off', failed: 'halted' }[G.phase]],
        ['cpu', G.mips ? `${G.mips.toFixed(0)} MIPS` : '–'],
        ['frames', G.phase === 'running' && G.fps ? `${G.fps.toFixed(0)} a second` : '–'],
        ['sound', G.audio ? (pref(MUTE_KEY, '0') === '1' ? 'muted' : `Sound Blaster Pro 2 · ${G.audio.sampleRate} Hz`) : '–'],
      ];
      const html = rows.map(([k, v]) => `<i>${k}</i><b>${v}</b>`).join('');
      if (st.innerHTML !== html) st.innerHTML = html;
    }
  }

  // ---------------------------------------------------------------- audio
  async function startAudio() {
    // one context for the life of the page; each power-on gets a fresh port into it
    if (G.audio) return G.connect?.() ?? null;
    const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    const gain = ctx.createGain();
    gain.gain.value = pref(MUTE_KEY, '0') === '1' ? 0 : 1;
    gain.connect(ctx.destination);
    G.audio = ctx; G.gain = gain;
    // An AudioWorklet needs a secure context; this monitor is often plain HTTP on a LAN address,
    // where `audioWorklet` does not exist. The fallback is a ScriptProcessor fed on this thread.
    if (ctx.audioWorklet && globalThis.AudioWorkletNode) {
      try {
        await ctx.audioWorklet.addModule('/js/dosaudio.js');
        const node = new AudioWorkletNode(ctx, 'dos-speakers', { numberOfInputs: 0, outputChannelCount: [2] });
        node.connect(gain);
        G.speakers = node;
        G.connect = () => {
          const channel = new MessageChannel();
          node.port.postMessage({ flush: true });
          node.port.postMessage({ port: channel.port1 }, [channel.port1]);
          return channel.port2;
        };
        return G.connect();
      } catch { /* fall through to the processor */ }
    }
    const node = ctx.createScriptProcessor(1024, 0, 2);
    const q = { chunks: [], pos: 0, queued: 0 };
    node.onaudioprocess = (e) => {
      const l = e.outputBuffer.getChannelData(0), r = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < l.length; i++) {
        const c = q.chunks[0];
        if (!c) { l[i] = 0; r[i] = 0; continue; }
        l[i] = c[q.pos]; r[i] = c[q.pos + 1]; q.pos += 2; q.queued--;
        if (q.pos >= c.length) { q.chunks.shift(); q.pos = 0; }
      }
    };
    node.connect(gain);
    G.speakers = node;
    G.connect = () => {
      const channel = new MessageChannel();
      q.chunks = []; q.pos = 0; q.queued = 0;
      channel.port1.onmessage = (m) => {
        const c = m.data;
        q.chunks.push(c); q.queued += c.length / 2;
        while (q.queued > ctx.sampleRate / 4 && q.chunks.length > 1) { const o = q.chunks.shift(); q.queued -= (o.length - q.pos) / 2; q.pos = 0; }
      };
      return channel.port2;
    };
    return G.connect();
  }

  // ---------------------------------------------------------------- the machine
  async function powerOn() {
    if (G.worker) { G.worker.terminate(); G.worker = null; }
    G.phase = 'loading'; G.mips = 0; G.fps = 0;
    overlay(spec.title, spec.loadingText, null, true);
    let port = null;
    try { port = await startAudio(); } catch { port = null; }
    if (G.audio?.state === 'suspended') G.audio.resume().catch(() => {});
    const w = new Worker('/js/dosworker.js', { type: 'module' });
    G.worker = w;
    w.onmessage = (e) => onWorker(e.data);
    w.onerror = (e) => fail(e.message || 'the machine failed to start');
    if (port) w.postMessage({ type: 'audio', port }, [port]);
    w.postMessage({ type: 'boot', game: spec.game, rate: G.audio ? G.audio.sampleRate : 0, ...(spec.bootMessage?.(prefsNow()) ?? {}) });
    drawHud();
  }

  function onWorker(m) {
    switch (m.type) {
      case 'status':
        if (m.text === 'booted') { G.phase = 'running'; overlay(null); loopUi(); }
        else overlay(spec.title, m.text, null, true);
        break;
      case 'frame':
        drawFrame(m.pixels, m.palette);
        G.worker?.postMessage({ type: 'pixels', buffer: m.pixels.buffer }, [m.pixels.buffer]);
        break;
      case 'text': drawText(m.cells); break;
      case 'stats': G.mips = m.mips; drawHud(); break;
      case 'saved': if (!m.deleted && spec.saveName?.test(m.name)) G.h?.toast?.(`saved ${m.name} in this browser`); break;
      case 'exit':
        G.phase = 'exited';
        releaseKeys();
        drawText(m.cells);
        document.exitPointerLock?.();
        overlay(null);
        el('Play2')?.classList.remove('hidden');
        drawHud();
        break;
      case 'error': fail(m.message); break;
    }
  }

  function fail(message) {
    G.phase = 'failed';
    G.worker?.terminate(); G.worker = null;
    overlay(`${spec.title} stopped`, message, 'start again', true);
    drawHud();
  }

  function pause(why) {
    if (G.phase !== 'running') return;
    G.phase = 'paused'; G.why = why;
    releaseKeys();
    G.worker?.postMessage({ type: 'run', on: false });
    G.audio?.suspend().catch(() => {});
    document.exitPointerLock?.();
    overlay(why, 'the machine is holding exactly where it was', 'resume', true);
    drawHud();
  }

  function resume() {
    if (G.phase === 'paused') {
      G.phase = 'running';
      overlay(null);
      G.audio?.resume().catch(() => {});
      G.worker?.postMessage({ type: 'run', on: true });
      loopUi();
      drawHud();
      return;
    }
    if (G.phase === 'idle' || G.phase === 'exited' || G.phase === 'failed') {
      el('Play2')?.classList.add('hidden');
      powerOn();
    }
  }

  // the page's own loop: pause on leaving, batch the mouse, count frames
  function loopUi() {
    if (G.raf) return;
    const tick = (t) => {
      G.raf = null;
      if (G.phase !== 'running') return;
      if (document.hidden || G.state?.page !== spec.page) { pause(document.hidden ? 'paused — you looked away' : 'paused — you changed tabs'); return; }
      if (G.mouse.dirty) {
        G.worker?.postMessage({ type: 'mouse', dx: G.mouse.dx, dy: G.mouse.dy, buttons: G.mouse.buttons });
        G.mouse.dx = 0; G.mouse.dy = 0; G.mouse.dirty = false;
      }
      if (t - G.fpsAt >= 1000) { G.fps = G.frames * 1000 / (t - G.fpsAt || 1000); G.frames = 0; G.fpsAt = t; drawHud(); }
      G.raf = requestAnimationFrame(tick);
    };
    G.fpsAt = performance.now(); G.frames = 0;
    G.raf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- input
  function releaseKeys() {
    const codes = [];
    for (const code of G.held) codes.push(...(scancodes(code, false) ?? []));
    G.held.clear();
    if (codes.length) G.worker?.postMessage({ type: 'key', codes });
    if (G.mouse.buttons) { G.mouse.buttons = 0; G.mouse.dirty = true; }
  }

  function onKey(e, down) {
    if (G.state?.page !== spec.page || G.phase !== 'running') return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.code === 'F12') return;             // the browser's own shortcuts and tools
    const codes = scancodes(e.code, down);
    if (!codes) return;
    e.preventDefault();
    if (down) G.held.add(e.code); else G.held.delete(e.code);
    if (codes.length) G.worker?.postMessage({ type: 'key', codes });
  }

  function bind() {
    if (G.bound) return;
    G.bound = true;
    document.addEventListener('keydown', (e) => onKey(e, true));
    document.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => releaseKeys());
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause('paused — you looked away'); });
    const c = el('Screen');
    c?.addEventListener('click', () => { if (G.phase === 'running' && document.pointerLockElement !== c) c.requestPointerLock?.(); });
    c?.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== c || G.phase !== 'running') return;
      G.mouse.dx += e.movementX; G.mouse.dy += e.movementY; G.mouse.dirty = true;
    });
    const buttons = (e) => {
      if (document.pointerLockElement !== c || G.phase !== 'running') return;
      // DOS mouse bits and the DOM's agree: 1 left, 2 right, 4 middle
      G.mouse.buttons = e.buttons & 7; G.mouse.dirty = true;
    };
    document.addEventListener('mousedown', buttons);
    document.addEventListener('mouseup', buttons);
    el('Play')?.addEventListener('click', () => resume());
    el('Play2')?.addEventListener('click', () => resume());
    for (const sw of spec.switches ?? []) {
      el(sw.id)?.addEventListener('click', () => {
        const next = sw.flip(switchValue(sw));
        setPref(sw.pref, next);
        drawHud();
        sw.apply?.(next, G);
      });
    }
    el('Smooth')?.addEventListener('click', () => { setPref(SMOOTH_KEY, pref(SMOOTH_KEY, '0') === '1' ? '0' : '1'); drawHud(); });
    el('Sound')?.addEventListener('click', () => {
      const mute = pref(MUTE_KEY, '0') !== '1';
      setPref(MUTE_KEY, mute ? '1' : '0');
      if (G.gain) G.gain.gain.value = mute ? 0 : 1;
      drawHud();
    });
    // FULL SCREEN, AND A WAY BACK (operator, 2026-09-15: "I can't exit fullscreen in the dos emulated
    // games"). The keyboard lock on Escape is what lets a tap of Esc reach the game's own menu in
    // full screen -- and it is also what takes away the browser's Esc-to-leave. So two ways out:
    // an "exit full screen" button in the corner (drawn only while full screen), and HOLDING Esc
    // for a second, which the page times itself rather than trusting the browser's own hold
    // gesture (Chrome has one under keyboard lock; Firefox has no keyboard lock at all). Leaving
    // unlocks the keyboard and lets the mouse go.
    const leave = () => { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); };
    el('Full')?.addEventListener('click', () => {
      const wrap = el('Wrap');
      if (!wrap?.requestFullscreen) return;
      if (!wrap.querySelector('.dosexit')) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn dosexit'; b.textContent = 'exit full screen'; b.title = 'or hold Esc for a second';
        b.addEventListener('click', leave);
        wrap.appendChild(b);
      }
      wrap.requestFullscreen().then(() => navigator.keyboard?.lock?.(['Escape'])).catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) { navigator.keyboard?.unlock?.(); document.exitPointerLock?.(); }
    });
    let escHold = null;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !document.fullscreenElement || e.repeat) return;
      escHold = setTimeout(() => { escHold = null; leave(); }, 1000);
    });
    document.addEventListener('keyup', (e) => { if (e.key === 'Escape' && escHold) { clearTimeout(escHold); escHold = null; } });
  }

  /** The page's render hook, called by app.js whenever the app draws. */
  return function render(s, state, h) {
    G.state = state; G.h = h;
    bind();
    drawHud();
    if (G.phase === 'idle') { overlay(spec.title, spec.idleText, 'play', false); return; }
    if (G.phase === 'paused') overlay(G.why, 'the machine is holding exactly where it was', 'resume', true);
  };
}
