// DOSPC: the PC the DOOM Diversion's DOOM.EXE thinks it is running on (operator, 2026-09-15: "Get
// DOOM working as a diversion inside blockyard with zero dependancies").
//
// Our own implementation. The CPU is x86.js; everything else a DOS/4GW program touches is here,
// emulated at the level the program sees it rather than as the silicon underneath:
//
//   - the LE executable inside the bound DOS/4GW stub, loaded above 1 MB with its fixups applied
//     (the extender itself -- its real-mode loader and protected-mode kernel -- never runs: this
//     file IS the extender, answering INT 21h, INT 31h and the hardware interrupts it reflects)
//   - DOS: files from an in-memory, case-insensitive directory; console output into text VRAM
//   - DPMI: descriptors, memory blocks, protected-mode interrupt vectors
//   - the BIOS calls a game makes: video mode, cursor, keyboard, mouse
//   - hardware: the 8259 PICs, the 8254 timer, the keyboard controller, the VGA (planar memory,
//     unchained mode, CRTC page flipping, the DAC), the PC speaker gate, and -- through `sound` --
//     a Sound Blaster and an OPL
//
// Nothing in here knows it is DOOM: every behaviour is what the hardware or the DOS call does.
import { createCpu, EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI, ES, CS, SS, DS, FS, GS } from './x86.js';

const MB = 1 << 20;
export const MEM_SIZE = 32 * MB;        // 32 MB, a power of two: the CPU masks every address with it
const LOAD_DELTA = 0x100000;            // the LE's objects move up a megabyte, clear of conventional memory
const HEAP_BASE = 0x300000;             // DPMI memory blocks from here to the top
const PSP_SEG = 0x0100;                 // real-mode segments in conventional memory
const ENV_SEG = 0x0110;
const DOS_HEAP_SEG = 0x0200;            // DOS memory (INT 21h 48h / DPMI 0100) from here to 0x9F00
const ROM_STUBS = 0xf0000;              // the "BIOS" handlers a chained vector returns to

// selectors: flat code and data at 0, then the ones the start-up hands the program
const SEL_CODE = 0x08, SEL_DATA = 0x10, SEL_PSP = 0x18, SEL_ENV = 0x20, SEL_CODE16 = 0x28, SEL_FIRST_FREE = 0x30;

const PIT_HZ = 1193182;

// ------------------------------------------------------------------ the LE loader
/**
 * Find the LE image in a bound DOS/4GW executable, copy its pages into `mem` at `delta` above the
 * addresses it was linked for, and apply its fixups. Returns the objects, entry point and stack.
 */
export function loadLE(buf, mem, delta = LOAD_DELTA) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  let stub = -1;
  for (let i = 0; i + 0x40 < buf.length; i++) {
    if (buf[i] !== 0x4d || buf[i + 1] !== 0x5a) continue;
    const l = dv.getUint32(i + 0x3c, true);
    if (i + l + 2 < buf.length && buf[i + l] === 0x4c && buf[i + l + 1] === 0x45) { stub = i; break; }
  }
  if (stub < 0) throw new Error('no LE executable in this file');
  const le = stub + dv.getUint32(stub + 0x3c, true);
  const u32 = (o) => dv.getUint32(le + o, true);
  const pageSize = u32(0x28), nPages = u32(0x14), lastPage = u32(0x2c);
  const objs = [];
  for (let i = 0; i < u32(0x44); i++) {
    const o = le + u32(0x40) + i * 24;
    objs.push({
      size: dv.getUint32(o, true), base: dv.getUint32(o + 4, true) + delta, flags: dv.getUint32(o + 8, true),
      pageIdx: dv.getUint32(o + 12, true), nPages: dv.getUint32(o + 16, true),
    });
  }
  const dataPages = stub + u32(0x80);
  const opt = le + u32(0x48), fpt = le + u32(0x68), frt = le + u32(0x6c);
  const pageAddr = [];
  for (const ob of objs) {
    for (let p = 0; p < ob.nPages; p++) {
      const e = opt + (ob.pageIdx - 1 + p) * 4;
      const num = (buf[e] << 16) | (buf[e + 1] << 8) | buf[e + 2];
      const src = dataPages + (num - 1) * pageSize;
      const len = num === nPages ? lastPage : pageSize;
      mem.set(buf.subarray(src, src + len), ob.base + p * pageSize);
      pageAddr[num] = ob.base + p * pageSize;
    }
  }
  const w32 = (a, v) => { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >>> 24; };
  let fixups = 0;
  for (let p = 1; p <= nPages; p++) {
    let r = frt + dv.getUint32(fpt + (p - 1) * 4, true);
    const end = frt + dv.getUint32(fpt + p * 4, true);
    while (r < end) {
      const st = buf[r], fl = buf[r + 1]; r += 2;
      let list = null, single = 0;
      if (st & 0x20) list = buf[r++]; else { single = dv.getInt16(r, true); r += 2; }
      if ((fl & 3) !== 0) throw new Error('imported fixups are not supported');
      let obj;
      if (fl & 0x40) { obj = dv.getUint16(r, true); r += 2; } else obj = buf[r++];
      let toff = 0;
      if ((st & 0xf) !== 2) { if (fl & 0x10) { toff = dv.getUint32(r, true); r += 4; } else { toff = dv.getUint16(r, true); r += 2; } }
      const srcs = [];
      if (list !== null) for (let k = 0; k < list; k++) { srcs.push(dv.getInt16(r, true)); r += 2; } else srcs.push(single);
      const target = objs[obj - 1].base + toff;
      for (const so of srcs) {
        const a = pageAddr[p] + so;
        switch (st & 0xf) {
          case 7: w32(a, target); break;
          case 8: w32(a, target - (a + 4)); break;
          case 2: mem[a] = objSelector(objs[obj - 1]); mem[a + 1] = 0; break;
          case 5: mem[a] = target; mem[a + 1] = target >> 8; break;
          case 6: w32(a, target); mem[a + 4] = objSelector(objs[obj - 1]); mem[a + 5] = 0; break;
          default: throw new Error(`LE fixup type ${st}`);
        }
        fixups++;
      }
    }
  }
  return {
    objs,
    entry: objs[u32(0x18) - 1].base + u32(0x1c),
    esp: objs[u32(0x20) - 1].base + u32(0x24),
    fixups,
  };
}
function objSelector(ob) {
  if (ob.flags & 0x2000) return ob.flags & 0x4 ? SEL_CODE : SEL_DATA;   // 32-bit objects are flat
  return SEL_CODE16;
}

// ------------------------------------------------------------------ a tiny PNG-free framebuffer
/** The DAC's 6-bit colours as 8-bit, the way a VGA's 18-bit palette reaches a screen. */
const DAC8 = new Uint8Array(64);
for (let i = 0; i < 64; i++) DAC8[i] = Math.round((i * 255) / 63);

// ------------------------------------------------------------------ the PC
/**
 * A PC with DOOM's world around it.
 *   files: { NAME: Uint8Array } -- the working directory (names are case-insensitive)
 *   args: the command tail, e.g. '-nosound'
 *   now(): milliseconds, the clock the timer chip counts against (performance.now in a browser)
 *   onWrite(name, bytes): a file was written and closed (savegames, the config)
 *   onExit(code): the program ended
 *   sound: (mem) => a card with portIn/portOut/tick (soundcard.js), or null for no sound hardware
 */
export function createPC({ files = {}, args = '', now = () => 0, onWrite = null, onExit = null, sound = null, log = null } = {}) {
  const mem = new Uint8Array(MEM_SIZE);
  if (typeof sound === 'function') sound = sound(mem);    // a card built on this machine's memory
  const selectors = new Map([[0, 0], [SEL_CODE, 0], [SEL_DATA, 0], [SEL_PSP, PSP_SEG * 16], [SEL_ENV, ENV_SEG * 16]]);
  let nextSelector = SEL_FIRST_FREE;

  // ---------------------------------------------------------------- VGA
  const vga = {
    planes: [new Uint8Array(0x10000), new Uint8Array(0x10000), new Uint8Array(0x10000), new Uint8Array(0x10000)],
    mode: 3,
    seqIndex: 0, seq: new Uint8Array(8),
    gcIndex: 0, gc: new Uint8Array(16),
    crtcIndex: 0, crtc: new Uint8Array(32),
    attrFlip: false, attrIndex: 0, attr: new Uint8Array(32),
    dacWrite: 0, dacRead: 0, dacSub: 0, dacReadSub: 0,
    pal: new Uint8Array(768),
    misc: 0x63,
    frames: 0,                         // bumped on every CRTC start change: a page was flipped
    palSeq: 0,                         // bumped on every DAC write
  };
  vga.seq[2] = 0x0f; vga.seq[4] = 0x0e;
  const chain4 = () => (vga.seq[4] & 0x08) !== 0;
  function vgaWrite(a, v) {
    const off = a - 0xa0000;
    // the text buffer at B8000 is plain memory in either mode; the graphics window is planes
    if (vga.mode !== 0x13 || off >= 0x10000) { if (a >= 0xb8000) mem[a] = v; return; }
    if (chain4()) { vga.planes[off & 3][off >> 2] = v; return; }
    const mask = vga.seq[2];
    if (mask & 1) vga.planes[0][off] = v;
    if (mask & 2) vga.planes[1][off] = v;
    if (mask & 4) vga.planes[2][off] = v;
    if (mask & 8) vga.planes[3][off] = v;
  }
  function vgaRead(a) {
    if (vga.mode !== 0x13) return mem[a];
    const off = a - 0xa0000;
    if (off >= 0x10000) return 0;
    if (chain4()) return vga.planes[off & 3][off >> 2];
    return vga.planes[vga.gc[4] & 3][off];
  }
  function setVideoMode(m) {
    vga.mode = m & 0x7f;
    vga.palSeq++;
    // the BIOS keeps the mode in its data area, and programs read it back from there: DOOM's
    // shutdown only returns to text mode (and so only shows ENDOOM) if 0x449 says 13h
    mem[0x449] = vga.mode === 0x13 ? 0x13 : 3;
    if (vga.mode === 0x13) {
      vga.seq[2] = 0x0f; vga.seq[4] = 0x0e; vga.crtc[0x13] = 0x28; vga.crtc[0x14] = 0x40; vga.crtc[0x17] = 0xa3;
      vga.crtc[0x0c] = 0; vga.crtc[0x0d] = 0;
      if (!(m & 0x80)) for (const p of vga.planes) p.fill(0);
      defaultPalette();
    } else {
      vga.mode = 3;
      if (!(m & 0x80)) for (let i = 0; i < 4000; i += 2) { mem[0xb8000 + i] = 0x20; mem[0xb8001 + i] = 0x07; }
      text.x = 0; text.y = 0;
    }
  }
  function defaultPalette() {
    // the first sixteen are the EGA colours; the rest a grey ramp is enough before a game sets its own
    const ega = [0, 0, 0, 0, 0, 42, 0, 42, 0, 0, 42, 42, 42, 0, 0, 42, 0, 42, 42, 21, 0, 42, 42, 42,
      21, 21, 21, 21, 21, 63, 21, 63, 21, 21, 63, 63, 63, 21, 21, 63, 21, 63, 63, 63, 21, 63, 63, 63];
    for (let i = 0; i < 256; i++) {
      if (i < 16) { vga.pal[i * 3] = ega[i * 3]; vga.pal[i * 3 + 1] = ega[i * 3 + 1]; vga.pal[i * 3 + 2] = ega[i * 3 + 2]; }
      else { const g = (i * 63 / 255) | 0; vga.pal[i * 3] = g; vga.pal[i * 3 + 1] = g; vga.pal[i * 3 + 2] = g; }
    }
  }
  /**
   * The picture on the monitor in mode 13h: 320x200 palette indices into `out`, read the way the
   * CRTC scans them -- from the start address, through whichever planes the memory mode says.
   */
  function renderIndexed(out) {
    const start = (vga.crtc[0x0c] << 8) | vga.crtc[0x0d];
    const P = vga.planes;
    if (chain4()) {
      const base = start * 4;
      for (let i = 0; i < 64000; i++) { const off = base + i; out[i] = P[off & 3][(off >> 2) & 0xffff]; }
      return out;
    }
    const perLine = (vga.crtc[0x13] * 2) || 80;
    let o = 0;
    for (let y = 0; y < 200; y++) {
      const row = start + y * perLine;
      for (let x = 0; x < 320; x++) out[o++] = P[x & 3][(row + (x >> 2)) & 0xffff];
    }
    return out;
  }
  /** The same picture as RGBA through the DAC (tests and screenshots; the page uses the indices). */
  const indexScratch = new Uint8Array(64000);
  function renderGraphics(out) {
    renderIndexed(indexScratch);
    const pal = vga.pal;
    for (let i = 0, o = 0; i < 64000; i++) {
      const c = indexScratch[i] * 3;
      out[o++] = DAC8[pal[c]]; out[o++] = DAC8[pal[c + 1]]; out[o++] = DAC8[pal[c + 2]]; out[o++] = 255;
    }
    return out;
  }

  // ---------------------------------------------------------------- text console
  const text = { x: 0, y: 0, attr: 0x07 };
  function scrollText() {
    mem.copyWithin(0xb8000, 0xb8000 + 160, 0xb8000 + 4000);
    for (let i = 0; i < 160; i += 2) { mem[0xb8000 + 3840 + i] = 0x20; mem[0xb8000 + 3841 + i] = 0x07; }
  }
  function putChar(ch, attr = null) {
    stdout.push(ch);
    if (ch === 13) { text.x = 0; return; }
    if (ch === 10) { text.y++; if (text.y >= 25) { scrollText(); text.y = 24; } return; }
    if (ch === 8) { if (text.x > 0) text.x--; return; }
    if (ch === 7) return;
    const a = 0xb8000 + (text.y * 80 + text.x) * 2;
    mem[a] = ch;
    if (attr !== null) mem[a + 1] = attr;
    text.x++;
    if (text.x >= 80) { text.x = 0; text.y++; if (text.y >= 25) { scrollText(); text.y = 24; } }
  }
  const stdout = [];

  // ---------------------------------------------------------------- PIC, PIT, keyboard, CMOS
  const pic = { mask: [0xb8, 0xff], isr: [0, 0], irr: [0, 0], readIsr: [false, false], init: [0, 0] };
  const pit = {
    reload: [65536, 65536, 65536], mode: [3, 3, 3], access: [3, 3, 3], lowNext: [true, true, true],
    latch: [-1, -1, -1], readLow: [true, true, true], start: [0, 0, 0], nextIrq: 0, gate2: 0,
  };
  const kbd = { queue: [], data: 0, port61: 0 };
  function pitPeriodMs() { return (pit.reload[0] * 1000) / PIT_HZ; }
  function pitCount(ch, t) {
    const periodTicks = pit.reload[ch];
    const elapsed = ((t - pit.start[ch]) * PIT_HZ) / 1000;
    const c = periodTicks - (Math.floor(elapsed) % periodTicks);
    return c & 0xffff;
  }
  function raiseIrq(n) { pic.irr[n >> 3] |= 1 << (n & 7); }

  function portIn(port, size) {
    if (size === 2) return portIn(port, 1) | (portIn(port + 1, 1) << 8) | (portIn(port + 2, 1) << 16) | (portIn(port + 3, 1) << 24);
    if (size === 1) return portIn(port, 0) | (portIn(port + 1, 0) << 8);
    switch (port) {
      case 0x20: return pic.readIsr[0] ? pic.isr[0] : pic.irr[0];
      case 0x21: return pic.mask[0];
      case 0xa0: return pic.readIsr[1] ? pic.isr[1] : pic.irr[1];
      case 0xa1: return pic.mask[1];
      case 0x40: case 0x41: case 0x42: {
        const ch = port - 0x40;
        const v = pit.latch[ch] >= 0 ? pit.latch[ch] : pitCount(ch, now());
        const acc = pit.access[ch];
        if (acc === 1) { pit.latch[ch] = -1; return v & 0xff; }
        if (acc === 2) { pit.latch[ch] = -1; return (v >> 8) & 0xff; }
        if (pit.readLow[ch]) { pit.readLow[ch] = false; if (pit.latch[ch] < 0) pit.latch[ch] = v; return v & 0xff; }
        pit.readLow[ch] = true; pit.latch[ch] = -1; return (v >> 8) & 0xff;
      }
      case 0x60: {
        const v = kbd.data;
        return v;
      }
      case 0x61: return (kbd.port61 & 0x0f) | ((now() * 0.066 | 0) & 1 ? 0x10 : 0) | 0x20;
      case 0x64: return kbd.queue.length ? 0x1d : 0x1c;
      case 0x71: return 0;
      case 0x3c1: return vga.attr[vga.attrIndex & 0x1f];
      case 0x3c4: return vga.seqIndex;
      case 0x3c5: return vga.seq[vga.seqIndex & 7];
      case 0x3c7: return 3;
      case 0x3c8: return vga.dacWrite;
      case 0x3c9: {
        const v = vga.pal[vga.dacRead * 3 + vga.dacReadSub];
        if (++vga.dacReadSub === 3) { vga.dacReadSub = 0; vga.dacRead = (vga.dacRead + 1) & 0xff; }
        return v;
      }
      case 0x3cc: return vga.misc;
      case 0x3ce: return vga.gcIndex;
      case 0x3cf: return vga.gc[vga.gcIndex & 0xf];
      case 0x3d4: return vga.crtcIndex;
      case 0x3d5: return vga.crtc[vga.crtcIndex & 0x1f];
      case 0x3da: {
        vga.attrFlip = false;
        // retrace for 1.2 ms of every 14.3 (70 Hz), display-enable toggling fast inside it
        const t = now() % (1000 / 70);
        return (t < 1.2 ? 0x08 : 0) | ((t * 31) & 1);
      }
      case 0x201: return 0xff;                       // no joystick: every axis timed out
    }
    if (sound) { const v = sound.portIn?.(port); if (v !== undefined) return v; }
    return 0xff;
  }

  function portOut(port, size, v) {
    if (size === 2) { portOut(port, 0, v & 0xff); portOut(port + 1, 0, (v >> 8) & 0xff); portOut(port + 2, 0, (v >> 16) & 0xff); portOut(port + 3, 0, (v >>> 24) & 0xff); return; }
    if (size === 1) {
      // a word to an index port is index then data -- the idiom every VGA program uses
      if (port === 0x3c4 || port === 0x3ce || port === 0x3d4) { portOut(port, 0, v & 0xff); portOut(port + 1, 0, (v >> 8) & 0xff); return; }
      portOut(port, 0, v & 0xff); portOut(port + 1, 0, (v >> 8) & 0xff); return;
    }
    v &= 0xff;
    switch (port) {
      case 0x20: case 0xa0: {
        const i = port === 0x20 ? 0 : 1;
        if (v & 0x10) { pic.init[i] = 1; pic.mask[i] = 0; pic.isr[i] = 0; return; }
        if ((v & 0x18) === 0x08) { if ((v & 3) === 2) pic.readIsr[i] = false; if ((v & 3) === 3) pic.readIsr[i] = true; return; }
        if ((v & 0xe0) === 0x20) {                       // non-specific EOI: the highest in service
          const s = pic.isr[i];
          if (s) pic.isr[i] = s & ~(s & -s);
        } else if ((v & 0xe0) === 0x60) pic.isr[i] &= ~(1 << (v & 7));
        return;
      }
      case 0x21: case 0xa1: {
        const i = port === 0x21 ? 0 : 1;
        if (pic.init[i]) { pic.init[i] = pic.init[i] === 3 ? 0 : pic.init[i] + 1; return; }
        pic.mask[i] = v;
        return;
      }
      case 0x40: case 0x41: case 0x42: {
        const ch = port - 0x40;
        const acc = pit.access[ch];
        let r = pit.reload[ch] & 0xffff;
        if (acc === 1) r = (r & 0xff00) | v;
        else if (acc === 2) r = (r & 0xff) | (v << 8);
        else if (pit.lowNext[ch]) { pit.lowNext[ch] = false; pit.pending = v; return; }
        else { pit.lowNext[ch] = true; r = pit.pending | (v << 8); }
        pit.reload[ch] = r || 65536;
        pit.start[ch] = now();
        if (ch === 0) pit.nextIrq = now() + pitPeriodMs();
        if (ch === 2) sound?.speaker?.(pit.reload[2], kbd.port61);
        return;
      }
      case 0x43: {
        const ch = (v >> 6) & 3;
        if (ch === 3) return;
        const acc = (v >> 4) & 3;
        if (acc === 0) { pit.latch[ch] = pitCount(ch, now()); pit.readLow[ch] = true; return; }
        pit.access[ch] = acc; pit.mode[ch] = (v >> 1) & 7; pit.lowNext[ch] = true; pit.readLow[ch] = true;
        return;
      }
      case 0x61: kbd.port61 = v; sound?.speaker?.(pit.reload[2], v); return;
      case 0x3c0:
        if (!vga.attrFlip) vga.attrIndex = v; else vga.attr[vga.attrIndex & 0x1f] = v;
        vga.attrFlip = !vga.attrFlip;
        return;
      case 0x3c2: vga.misc = v; return;
      case 0x3c4: vga.seqIndex = v; return;
      case 0x3c5: vga.seq[vga.seqIndex & 7] = v; return;
      case 0x3c7: vga.dacRead = v; vga.dacReadSub = 0; return;
      case 0x3c8: vga.dacWrite = v; vga.dacSub = 0; return;
      case 0x3c9:
        vga.pal[vga.dacWrite * 3 + vga.dacSub] = v & 0x3f;
        vga.palSeq++;
        if (++vga.dacSub === 3) { vga.dacSub = 0; vga.dacWrite = (vga.dacWrite + 1) & 0xff; }
        return;
      case 0x3ce: vga.gcIndex = v; return;
      case 0x3cf: vga.gc[vga.gcIndex & 0xf] = v; return;
      case 0x3d4: vga.crtcIndex = v; return;
      case 0x3d5:
        vga.crtc[vga.crtcIndex & 0x1f] = v;
        if (vga.crtcIndex === 0x0c || vga.crtcIndex === 0x0d) vga.frames++;
        return;
    }
    sound?.portOut?.(port, v);
  }

  // ---------------------------------------------------------------- memory allocation
  // DPMI blocks: first fit over a sorted list, from HEAP_BASE to the top of memory
  const blocks = [];                     // { base, size, handle }
  let nextHandle = 1;
  function allocBlock(size) {
    size = (size + 0xfff) & ~0xfff;
    let at = HEAP_BASE;
    for (let i = 0; i <= blocks.length; i++) {
      const limit = i < blocks.length ? blocks[i].base : MEM_SIZE;
      if (limit - at >= size) {
        const b = { base: at, size, handle: nextHandle++ };
        blocks.splice(i, 0, b);
        mem.fill(0, at, at + size);
        return b;
      }
      if (i < blocks.length) at = blocks[i].base + blocks[i].size;
    }
    return null;
  }
  function freeMemory() {
    let free = 0, largest = 0, at = HEAP_BASE;
    for (let i = 0; i <= blocks.length; i++) {
      const limit = i < blocks.length ? blocks[i].base : MEM_SIZE;
      free += limit - at; largest = Math.max(largest, limit - at);
      if (i < blocks.length) at = blocks[i].base + blocks[i].size;
    }
    return { free, largest };
  }
  // DOS conventional memory: a bump pointer over segments, with the size kept per block
  const dosBlocks = new Map();
  let dosNext = DOS_HEAP_SEG;
  function dosAlloc(paras) {
    if (dosNext + paras > 0x9f00) return -1;
    const s = dosNext; dosNext += paras; dosBlocks.set(s, paras);
    return s;
  }

  // ---------------------------------------------------------------- files
  const dir = new Map();                // NAME -> Uint8Array
  for (const [k, v] of Object.entries(files)) dir.set(k.toUpperCase(), v);
  const handles = new Map();            // n -> { name, data, pos, dirty, size }
  function dosName(a) {
    let s = '';
    for (let i = 0; i < 128; i++) { const c = mem[a + i]; if (!c) break; s += String.fromCharCode(c); }
    s = s.replace(/^[a-zA-Z]:/, '').replace(/^[\\/.]+/, '').replace(/.*[\\/]/, '');
    return s.toUpperCase();
  }
  function openHandle(name, data) {
    let h = 5;
    while (handles.has(h)) h++;
    handles.set(h, { name, data, size: data.length, pos: 0, dirty: false });
    return h;
  }
  function closeHandle(h) {
    const f = handles.get(h);
    if (!f) return false;
    if (f.dirty) {
      const bytes = f.data.slice(0, f.size);
      dir.set(f.name, bytes);
      onWrite?.(f.name, bytes);
    }
    handles.delete(h);
    return true;
  }
  // find first / find next over the directory, matching DOS wildcards
  let findList = [];
  function wildcard(pat) {
    const [pn, pe = ''] = pat.split('.');
    const rx = (p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.?');
    return new RegExp(`^${rx(pn)}(\\.${rx(pe)})?$`, 'i');
  }
  function fillDta(dta, name) {
    const data = dir.get(name);
    mem[dta + 0x15] = 0x20;
    mem[dta + 0x16] = 0; mem[dta + 0x17] = 0; mem[dta + 0x18] = 0x21; mem[dta + 0x19] = 0x1f;
    const n = data.length;
    mem[dta + 0x1a] = n; mem[dta + 0x1b] = n >> 8; mem[dta + 0x1c] = n >> 16; mem[dta + 0x1d] = n >> 24;
    for (let i = 0; i < 13; i++) mem[dta + 0x1e + i] = i < name.length ? name.charCodeAt(i) : 0;
  }
  let dta = PSP_SEG * 16 + 0x80;

  // ---------------------------------------------------------------- interrupt vectors
  // the program's own protected-mode handlers; unset ones fall back to the ROM stubs
  const pmVectors = new Array(256).fill(null);
  const romStub = (n) => ({ sel: SEL_CODE, off: ROM_STUBS + n * 16 });
  function writeStubs() {
    for (let n = 0; n < 256; n++) {
      const a = ROM_STUBS + n * 16;
      let code;
      if (n === 8) code = [0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf];                       // EOI, IRET
      else if (n === 9) code = [0x50, 0xe4, 0x60, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf];      // read the key, EOI, IRET
      else if (n >= 0x70 && n <= 0x77) code = [0x50, 0xb0, 0x20, 0xe6, 0xa0, 0xe6, 0x20, 0x58, 0xcf];
      else if ((n >= 0x0a && n <= 0x0f)) code = [0x50, 0xb0, 0x20, 0xe6, 0x20, 0x58, 0xcf];
      else code = [0xcd, n, 0xcf];                                                         // INT n (the machine's), IRET
      mem.set(code, a);
    }
  }

  // ---------------------------------------------------------------- the CPU
  let exited = false, exitCode = 0;
  const bus = {
    mem,
    vgaWrite, vgaRead, portIn, portOut,
    selectorBase: (sel) => selectors.get(sel & 0xfff8 | (sel & 0)) ?? selectors.get(sel) ?? 0,
    vector: (n) => pmVectors[n] ?? romStub(n),
    softInt: (cpu, n) => {
      // a vector the program installed takes the call, unless it is the one the stub is making
      if (pmVectors[n] && !(cpu.eip - 2 === ROM_STUBS + n * 16)) return false;
      return service(cpu, n);
    },
  };
  const cpu = createCpu(bus);
  const R = cpu.R;
  writeStubs();

  const u16 = (v) => v & 0xffff;
  const setAX = (v) => { R[EAX] = (R[EAX] & ~0xffff) | (v & 0xffff); };
  const ok = () => cpu.setCF(false);
  const fail = (code) => { setAX(code); cpu.setCF(true); };
  const linDS = (off) => (cpu.segBase[DS] + off) >>> 0;
  const linES = (off) => (cpu.segBase[ES] + off) >>> 0;
  const unhandled = new Set();
  function note(what) {
    if (unhandled.has(what)) return;
    unhandled.add(what);
    log?.(`unhandled ${what}`);
  }

  function service(c, n) {
    switch (n) {
      case 0x21: return dos(c);
      case 0x31: return dpmi(c);
      case 0x10: return video(c);
      case 0x16: return biosKey(c);
      case 0x33: return mouse(c);
      case 0x1a: {
        const ah = (R[EAX] >> 8) & 0xff;
        if (ah === 0) { const t = Math.floor(now() * 18.2065 / 1000); R[ECX] = (R[ECX] & ~0xffff) | ((t >> 16) & 0xffff); R[EDX] = (R[EDX] & ~0xffff) | (t & 0xffff); setAX(0); }
        else if (ah === 2 || ah === 4) { R[ECX] &= ~0xffff; R[EDX] &= ~0xffff; ok(); }
        return true;
      }
      case 0x11: setAX(0x0027); return true;
      case 0x12: setAX(640); return true;
      case 0x15: fail(0x8600); return true;
      case 0x2f: setAX(R[EAX] & 0xff00); return true;
      case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x0e: case 0x0f:
      case 0x1c: case 0x23: case 0x24: case 0x1b: return true;
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77: return true;
      default:
        note(`INT ${n.toString(16)} AX=${u16(R[EAX]).toString(16)}`);
        return true;
    }
  }

  // ---------------------------------------------------------------- INT 21h
  function dos(c) {
    const ah = (R[EAX] >> 8) & 0xff, al = R[EAX] & 0xff;
    switch (ah) {
      case 0x02: putChar(R[EDX] & 0xff); return true;
      case 0x06: if ((R[EDX] & 0xff) !== 0xff) putChar(R[EDX] & 0xff); else { c.setZF(true); R[EAX] &= ~0xff; } return true;
      case 0x07: case 0x08: R[EAX] = (R[EAX] & ~0xff) | (kbd.queue.length ? 13 : 13); return true;
      case 0x09: { let a = linDS(R[EDX]); for (let i = 0; i < 4096 && mem[a] !== 0x24; i++) putChar(mem[a++]); return true; }
      case 0x0b: R[EAX] &= ~0xff; return true;
      case 0x0e: R[EAX] = (R[EAX] & ~0xff) | 26; return true;
      case 0x19: R[EAX] &= ~0xff | 2; R[EAX] = (R[EAX] & ~0xff) | 2; return true;
      case 0x1a: dta = linDS(R[EDX]); return true;
      case 0x25: pmVectors[al] = { sel: c.seg[DS], off: R[EDX] >>> 0 }; return true;
      case 0x2a: { const d = new Date(); R[ECX] = (R[ECX] & ~0xffff) | d.getFullYear(); R[EDX] = (R[EDX] & ~0xffff) | ((d.getMonth() + 1) << 8) | d.getDate(); R[EAX] = (R[EAX] & ~0xff) | d.getDay(); return true; }
      case 0x2c: { const d = new Date(); R[ECX] = (R[ECX] & ~0xffff) | (d.getHours() << 8) | d.getMinutes(); R[EDX] = (R[EDX] & ~0xffff) | (d.getSeconds() << 8) | Math.floor(d.getMilliseconds() / 10); return true; }
      case 0x2f: c.loadSeg(ES, SEL_DATA); R[EBX] = dta; return true;
      case 0x30: R[EAX] = 0x1606; R[EBX] = 0; R[ECX] = 0; return true;   // DOS 6.22, and no Phar Lap signature
      case 0x33: if (al === 0) R[EDX] &= ~0xff; ok(); return true;
      case 0x35: { const v = pmVectors[al] ?? romStub(al); c.loadSeg(ES, v.sel); R[EBX] = v.off; return true; }
      case 0x36: setAX(4); R[EBX] = (R[EBX] & ~0xffff) | 0x4000; R[ECX] = (R[ECX] & ~0xffff) | 512; R[EDX] = (R[EDX] & ~0xffff) | 0xffff; return true;
      case 0x39: case 0x3b: ok(); return true;
      case 0x3a: ok(); return true;
      case 0x3c: case 0x5b: {                     // create
        const name = dosName(linDS(R[EDX]));
        if (ah === 0x5b && dir.has(name)) { fail(80); return true; }
        const data = new Uint8Array(4096);
        const h = openHandle(name, data);
        const f = handles.get(h); f.size = 0; f.dirty = true;
        dir.set(name, new Uint8Array(0));
        R[EAX] = h; ok();
        return true;
      }
      case 0x3d: {                                // open
        const name = dosName(linDS(R[EDX]));
        const data = dir.get(name);
        if (!data) { fail(2); return true; }
        const h = openHandle(name, (al & 3) ? data.slice() : data);
        R[EAX] = h; ok();
        return true;
      }
      case 0x3e: {
        const h = u16(R[EBX]);
        if (h < 5) { ok(); return true; }
        if (closeHandle(h)) ok(); else fail(6);
        return true;
      }
      case 0x3f: {                                // read
        const h = u16(R[EBX]), n = R[ECX] >>> 0, a = linDS(R[EDX]);
        if (h === 0) { R[EAX] = 0; ok(); return true; }
        const f = handles.get(h);
        if (!f) { fail(6); return true; }
        const k = Math.max(0, Math.min(n, f.size - f.pos));
        mem.set(f.data.subarray(f.pos, f.pos + k), a);
        f.pos += k; R[EAX] = k; ok();
        return true;
      }
      case 0x40: {                                // write
        const h = u16(R[EBX]), n = R[ECX] >>> 0, a = linDS(R[EDX]);
        if (h === 1 || h === 2) { for (let i = 0; i < n; i++) putChar(mem[a + i]); R[EAX] = n; ok(); return true; }
        const f = handles.get(h);
        if (!f) { fail(6); return true; }
        if (n === 0) { f.size = f.pos; f.dirty = true; R[EAX] = 0; ok(); return true; }   // truncate
        if (f.pos + n > f.data.length) {
          const grown = new Uint8Array(Math.max(f.pos + n, f.data.length * 2));
          grown.set(f.data.subarray(0, f.size)); f.data = grown;
        }
        f.data.set(mem.subarray(a, a + n), f.pos);
        f.pos += n; f.size = Math.max(f.size, f.pos); f.dirty = true;
        R[EAX] = n; ok();
        return true;
      }
      case 0x41: { const name = dosName(linDS(R[EDX])); if (dir.delete(name)) { onWrite?.(name, null); ok(); } else fail(2); return true; }
      case 0x42: {                                // seek
        const h = u16(R[EBX]);
        const f = handles.get(h);
        if (!f) { if (h < 5) { R[EAX] = 0; R[EDX] &= ~0xffff; ok(); } else fail(6); return true; }
        const off = ((u16(R[ECX]) << 16) | u16(R[EDX])) | 0;
        const base = al === 0 ? 0 : al === 1 ? f.pos : f.size;
        f.pos = Math.max(0, base + off);
        R[EAX] = f.pos; R[EDX] = (R[EDX] & ~0xffff) | ((f.pos >>> 16) & 0xffff);
        ok();
        return true;
      }
      case 0x43: {
        const name = dosName(linDS(R[EDX]));
        if (!dir.has(name)) { fail(2); return true; }
        if (al === 0) R[ECX] = (R[ECX] & ~0xffff) | 0x20;
        ok();
        return true;
      }
      case 0x44: {
        const h = u16(R[EBX]);
        if (al === 0) { R[EDX] = (R[EDX] & ~0xffff) | (h < 5 ? (h === 0 ? 0x80d3 : 0x80d3) : 0x0002); ok(); return true; }
        if (al === 1) { ok(); return true; }
        if (al === 8) { setAX(1); ok(); return true; }
        if (al === 9) { R[EDX] &= ~0xffff; ok(); return true; }
        fail(1);
        return true;
      }
      case 0x45: { const f = handles.get(u16(R[EBX])); if (!f) { if (u16(R[EBX]) < 5) { R[EAX] = u16(R[EBX]); ok(); } else fail(6); return true; } const h = openHandle(f.name, f.data); Object.assign(handles.get(h), { size: f.size, pos: f.pos }); R[EAX] = h; ok(); return true; }
      case 0x47: mem[linDS(R[ESI])] = 0; ok(); return true;
      case 0x48: {
        const paras = u16(R[EBX]);
        const s = dosAlloc(paras);
        if (s < 0) { fail(8); R[EBX] = (R[EBX] & ~0xffff) | (0x9f00 - dosNext); return true; }
        R[EAX] = s; ok();
        return true;
      }
      case 0x49: case 0x4a: ok(); return true;
      case 0x4c: exited = true; exitCode = al; c.stop(); onExit?.(al); return true;
      case 0x4e: {
        const rx = wildcard(dosName(linDS(R[EDX])) || '*.*');
        findList = [...dir.keys()].filter((k) => rx.test(k));
        if (!findList.length) { fail(18); return true; }
        fillDta(dta, findList.shift()); ok();
        return true;
      }
      case 0x4f: if (!findList.length) { fail(18); return true; } fillDta(dta, findList.shift()); ok(); return true;
      case 0x56: {
        const from = dosName(linDS(R[EDX])), to = dosName(linES(R[EDI]));
        const d = dir.get(from);
        if (!d) { fail(2); return true; }
        dir.delete(from); dir.set(to, d); onWrite?.(from, null); onWrite?.(to, d); ok();
        return true;
      }
      case 0x57: R[ECX] &= ~0xffff; R[EDX] = (R[EDX] & ~0xffff) | 0x21; ok(); return true;
      case 0x62: R[EBX] = (R[EBX] & ~0xffff) | SEL_PSP; return true;
      case 0xff:
        // DOS/4GW's own presence check (DX = 0x78): answer "yes, DOS/4G", and hand over the
        // selector for the first megabyte in GS the way the extender does
        if (al === 0 && u16(R[EDX]) === 0x78) { R[EAX] = 0x4734ff01; c.loadSeg(GS, SEL_DATA); return true; }
        R[EAX] &= ~0xff;
        return true;
    }
    note(`INT 21 AH=${ah.toString(16)} AL=${al.toString(16)}`);
    cpu.setCF(true);
    return true;
  }

  // ---------------------------------------------------------------- INT 31h, DPMI 0.9
  function dpmi(c) {
    const ax = u16(R[EAX]);
    const bxcx = () => ((u16(R[EBX]) << 16) | u16(R[ECX])) >>> 0;
    const setBXCX = (v) => { R[EBX] = (R[EBX] & ~0xffff) | ((v >>> 16) & 0xffff); R[ECX] = (R[ECX] & ~0xffff) | (v & 0xffff); };
    const setSIDI = (v) => { R[ESI] = (R[ESI] & ~0xffff) | ((v >>> 16) & 0xffff); R[EDI] = (R[EDI] & ~0xffff) | (v & 0xffff); };
    const sidi = () => ((u16(R[ESI]) << 16) | u16(R[EDI])) >>> 0;
    switch (ax) {
      case 0x0000: {
        const n = Math.max(1, u16(R[ECX]));
        const first = nextSelector;
        for (let i = 0; i < n; i++) { selectors.set(nextSelector, 0); nextSelector += 8; }
        setAX(first); ok();
        return true;
      }
      case 0x0001: selectors.delete(u16(R[EBX])); ok(); return true;
      case 0x0002: { const sel = nextSelector; nextSelector += 8; selectors.set(sel, u16(R[EBX]) * 16); setAX(sel); ok(); return true; }
      case 0x0003: setAX(8); ok(); return true;
      case 0x0006: { const b = selectors.get(u16(R[EBX])) ?? 0; R[ECX] = (R[ECX] & ~0xffff) | (b >>> 16); R[EDX] = (R[EDX] & ~0xffff) | (b & 0xffff); ok(); return true; }
      case 0x0007: selectors.set(u16(R[EBX]), ((u16(R[ECX]) << 16) | u16(R[EDX])) >>> 0); refreshSegs(c); ok(); return true;
      case 0x0008: case 0x0009: ok(); return true;
      case 0x000a: { const sel = nextSelector; nextSelector += 8; selectors.set(sel, selectors.get(u16(R[EBX])) ?? 0); setAX(sel); ok(); return true; }
      case 0x000b: {
        const a = linES(R[EDI]), b = selectors.get(u16(R[EBX])) ?? 0;
        mem.set([0xff, 0xff, b & 0xff, (b >> 8) & 0xff, (b >> 16) & 0xff, 0xf2, 0xcf, (b >>> 24) & 0xff], a);
        ok();
        return true;
      }
      case 0x000c: {
        const a = linES(R[EDI]);
        selectors.set(u16(R[EBX]), (mem[a + 2] | (mem[a + 3] << 8) | (mem[a + 4] << 16) | (mem[a + 7] << 24)) >>> 0);
        refreshSegs(c); ok();
        return true;
      }
      case 0x0100: {
        const s = dosAlloc(u16(R[EBX]));
        if (s < 0) { fail(8); R[EBX] = (R[EBX] & ~0xffff) | (0x9f00 - dosNext); return true; }
        const sel = nextSelector; nextSelector += 8; selectors.set(sel, s * 16);
        setAX(s); R[EDX] = (R[EDX] & ~0xffff) | sel; ok();
        return true;
      }
      case 0x0101: case 0x0102: ok(); return true;
      case 0x0200: R[ECX] &= ~0xffff; R[EDX] &= ~0xffff; ok(); return true;
      case 0x0201: ok(); return true;
      case 0x0202: { const v = romStub(R[EBX] & 0xff); R[ECX] = (R[ECX] & ~0xffff) | v.sel; R[EDX] = v.off; ok(); return true; }
      case 0x0203: ok(); return true;
      case 0x0204: { const v = pmVectors[R[EBX] & 0xff] ?? romStub(R[EBX] & 0xff); R[ECX] = (R[ECX] & ~0xffff) | v.sel; R[EDX] = v.off; ok(); return true; }
      case 0x0205: {
        const n = R[EBX] & 0xff, sel = u16(R[ECX]), off = R[EDX] >>> 0;
        pmVectors[n] = sel === SEL_CODE && off === ROM_STUBS + n * 16 ? null : { sel, off };
        ok();
        return true;
      }
      case 0x0300: case 0x0301: case 0x0302: return realModeCall(c, ax);
      case 0x0303: R[ECX] = (R[ECX] & ~0xffff) | 0xf000; R[EDX] = (R[EDX] & ~0xffff) | 0x0100; ok(); return true;
      case 0x0304: ok(); return true;
      case 0x0400: setAX(0x005a); R[EBX] = (R[EBX] & ~0xffff) | 0x0005; R[ECX] = (R[ECX] & ~0xff) | 4; R[EDX] = (R[EDX] & ~0xffff) | 0x0870; ok(); return true;
      case 0x0500: {
        const a = linES(R[EDI]), { free, largest } = freeMemory();
        const put = (o, v) => { mem[a + o] = v; mem[a + o + 1] = v >> 8; mem[a + o + 2] = v >> 16; mem[a + o + 3] = v >>> 24; };
        for (let i = 0; i < 48; i++) mem[a + i] = 0xff;
        put(0, largest); put(4, largest >>> 12); put(8, largest >>> 12); put(0x0c, free >>> 12);
        put(0x10, free >>> 12); put(0x14, free >>> 12); put(0x18, MEM_SIZE >>> 12); put(0x1c, free >>> 12); put(0x20, 0);
        ok();
        return true;
      }
      case 0x0501: {
        const b = allocBlock(bxcx());
        if (!b) { fail(0x8013); return true; }
        setBXCX(b.base); setSIDI(b.handle); ok();
        return true;
      }
      case 0x0502: {
        const i = blocks.findIndex((b) => b.handle === sidi());
        if (i < 0) { fail(0x8023); return true; }
        blocks.splice(i, 1); ok();
        return true;
      }
      case 0x0503: {
        const i = blocks.findIndex((b) => b.handle === sidi());
        if (i < 0) { fail(0x8023); return true; }
        const old = blocks[i], want = (bxcx() + 0xfff) & ~0xfff;
        const nextBase = i + 1 < blocks.length ? blocks[i + 1].base : MEM_SIZE;
        if (old.base + want <= nextBase) { old.size = want; setBXCX(old.base); setSIDI(old.handle); ok(); return true; }
        blocks.splice(i, 1);
        const nb = allocBlock(want);
        if (!nb) { blocks.splice(i, 0, old); fail(0x8013); return true; }
        mem.copyWithin(nb.base, old.base, old.base + old.size);
        setBXCX(nb.base); setSIDI(nb.handle); ok();
        return true;
      }
      case 0x0600: case 0x0601: case 0x0602: case 0x0603: case 0x0702: case 0x0703: ok(); return true;
      case 0x0604: R[EBX] &= ~0xffff; R[ECX] = (R[ECX] & ~0xffff) | 0x1000; ok(); return true;
      case 0x0800: ok(); return true;              // physical address mapping: identity
      case 0x0801: ok(); return true;
      case 0x0900: case 0x0901: {
        const was = c.IF ? 1 : 0;
        c.flags = ax === 0x0901 ? c.flags | 0x200 : c.flags & ~0x200;
        R[EAX] = (R[EAX] & ~0xff) | was;
        return true;
      }
      case 0x0902: R[EAX] = (R[EAX] & ~0xff) | (c.IF ? 1 : 0); return true;
      case 0x0a00: fail(0x8001); return true;
      case 0x0e00: setAX(0x004d); ok(); return true;
      case 0x0e01: ok(); return true;
    }
    note(`INT 31 AX=${ax.toString(16)}`);
    fail(0x8001);
    return true;
  }
  function refreshSegs(c) {
    for (let i = 0; i < 6; i++) c.loadSeg(i, c.seg[i]);
  }

  // DPMI 0300: a real-mode interrupt with registers in a table at ES:EDI. The services a
  // protected-mode program asks for this way are the same BIOS and DOS calls, so they run through
  // the same handlers with the table's registers swapped in, then swapped back out.
  function realModeCall(c, ax) {
    const t = linES(R[EDI]);
    const g32 = (o) => mem[t + o] | (mem[t + o + 1] << 8) | (mem[t + o + 2] << 16) | (mem[t + o + 3] << 24);
    const g16 = (o) => mem[t + o] | (mem[t + o + 1] << 8);
    const p32 = (o, v) => { mem[t + o] = v; mem[t + o + 1] = v >> 8; mem[t + o + 2] = v >> 16; mem[t + o + 3] = v >> 24; };
    const p16 = (o, v) => { mem[t + o] = v; mem[t + o + 1] = v >> 8; };
    if (ax !== 0x0300) { note(`DPMI ${ax.toString(16)} (real-mode far call)`); ok(); return true; }
    const n = R[EBX] & 0xff;
    const saved = Array.from(R), savedSeg = Array.from(c.seg), savedFlags = c.flags;
    R[EDI] = g32(0); R[ESI] = g32(4); R[EBP] = g32(8); R[EBX] = g32(16); R[EDX] = g32(20); R[ECX] = g32(24); R[EAX] = g32(28);
    // real-mode segments: selectors whose base is the segment times sixteen
    const rmSel = (segv, which) => { const sel = 0xf000 + which * 8; selectors.set(sel, segv * 16); c.loadSeg(which, sel); };
    rmSel(g16(0x22), ES); rmSel(g16(0x24), DS);
    c.flags = g16(0x20);
    service(c, n);
    const outFlags = c.flags;
    p32(0, R[EDI]); p32(4, R[ESI]); p32(8, R[EBP]); p32(16, R[EBX]); p32(20, R[EDX]); p32(24, R[ECX]); p32(28, R[EAX]);
    p16(0x20, outFlags);
    for (let i = 0; i < 8; i++) R[i] = saved[i];
    for (let i = 0; i < 6; i++) c.loadSeg(i, savedSeg[i]);
    c.flags = savedFlags;
    ok();
    return true;
  }

  // ---------------------------------------------------------------- INT 10h
  function video(c) {
    const ah = (R[EAX] >> 8) & 0xff, al = R[EAX] & 0xff;
    switch (ah) {
      case 0x00: setVideoMode(al); return true;
      case 0x01: return true;
      case 0x02: text.y = Math.min(24, (R[EDX] >> 8) & 0xff); text.x = Math.min(79, R[EDX] & 0xff); return true;
      case 0x03: R[EDX] = (R[EDX] & ~0xffff) | (text.y << 8) | text.x; R[ECX] = (R[ECX] & ~0xffff) | 0x0607; return true;
      case 0x05: return true;
      case 0x06: case 0x07: {
        const lines = al, attr = (R[EBX] >> 8) & 0xff;
        const top = (R[ECX] >> 8) & 0xff, left = R[ECX] & 0xff, bottom = Math.min(24, (R[EDX] >> 8) & 0xff), right = Math.min(79, R[EDX] & 0xff);
        const cell = (x, y) => 0xb8000 + (y * 80 + x) * 2;
        const h = bottom - top + 1;
        for (let y = 0; y < h; y++) {
          for (let x = left; x <= right; x++) {
            const dst = ah === 0x06 ? top + y : bottom - y;
            const srcY = ah === 0x06 ? dst + lines : dst - lines;
            const inside = lines !== 0 && srcY >= top && srcY <= bottom;
            mem[cell(x, dst)] = inside ? mem[cell(x, srcY)] : 0x20;
            mem[cell(x, dst) + 1] = inside ? mem[cell(x, srcY) + 1] : attr;
          }
        }
        return true;
      }
      case 0x08: { const a = 0xb8000 + (text.y * 80 + text.x) * 2; setAX((mem[a + 1] << 8) | mem[a]); return true; }
      case 0x09: case 0x0a: {
        const n = u16(R[ECX]), attr = R[EBX] & 0xff;
        for (let i = 0; i < n; i++) {
          const p = text.y * 80 + text.x + i;
          if (p >= 2000) break;
          mem[0xb8000 + p * 2] = al;
          if (ah === 0x09) mem[0xb8001 + p * 2] = attr;
        }
        return true;
      }
      case 0x0e: putChar(al); return true;
      case 0x0f: setAX((80 << 8) | vga.mode); R[EBX] &= ~0xff00; return true;
      case 0x10:
        if (al === 0x12 || al === 0x10) {
          const first = u16(R[EBX]), count = al === 0x10 ? 1 : u16(R[ECX]);
          if (al === 0x10) { vga.pal[first * 3] = (R[EDX] >> 8) & 0x3f; vga.pal[first * 3 + 1] = (R[ECX] >> 8) & 0x3f; vga.pal[first * 3 + 2] = R[ECX] & 0x3f; return true; }
          const a = linES(R[EDX]);
          for (let i = 0; i < count * 3; i++) vga.pal[(first * 3 + i) % 768] = mem[a + i] & 0x3f;
          vga.palSeq++;
        }
        return true;
      case 0x11: case 0x12: if (ah === 0x12 && (R[EBX] & 0xff) === 0x10) R[EBX] = (R[EBX] & ~0xffff) | 0x0003; return true;
      case 0x1a: if (al === 0) { R[EAX] = (R[EAX] & ~0xff) | 0x1a; R[EBX] = (R[EBX] & ~0xffff) | 0x0008; } return true;
    }
    note(`INT 10 AH=${ah.toString(16)}`);
    return true;
  }

  // ---------------------------------------------------------------- INT 16h, INT 33h
  const biosKeys = [];                   // [scan, ascii] typed while a program reads the BIOS
  function biosKey(c) {
    const ah = (R[EAX] >> 8) & 0xff;
    if (ah === 0x00 || ah === 0x10) { const k = biosKeys.shift() ?? [0x1c, 13]; setAX((k[0] << 8) | k[1]); return true; }
    if (ah === 0x01 || ah === 0x11) { if (biosKeys.length) { const k = biosKeys[0]; setAX((k[0] << 8) | k[1]); c.setZF(false); } else c.setZF(true); return true; }
    if (ah === 0x02 || ah === 0x12) { R[EAX] &= ~0xff; return true; }
    return true;
  }
  const mouseState = { dx: 0, dy: 0, buttons: 0, present: true };
  function mouse(c) {
    const ax = u16(R[EAX]);
    switch (ax) {
      case 0x0000: case 0x0021:
        if (!mouseState.present) { setAX(0); return true; }
        setAX(0xffff); R[EBX] = (R[EBX] & ~0xffff) | 3; return true;
      case 0x0003: R[EBX] = (R[EBX] & ~0xffff) | mouseState.buttons; R[ECX] &= ~0xffff; R[EDX] &= ~0xffff; return true;
      case 0x000b: {
        const dx = Math.max(-32768, Math.min(32767, Math.round(mouseState.dx)));
        const dy = Math.max(-32768, Math.min(32767, Math.round(mouseState.dy)));
        mouseState.dx -= dx; mouseState.dy -= dy;
        R[ECX] = (R[ECX] & ~0xffff) | (dx & 0xffff); R[EDX] = (R[EDX] & ~0xffff) | (dy & 0xffff);
        return true;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- start
  function boot(exe) {
    const img = loadLE(exe, mem, LOAD_DELTA);
    // PSP: the command tail at 80h, the environment's selector at 2Ch
    const psp = PSP_SEG * 16;
    mem[psp] = 0xcd; mem[psp + 1] = 0x20;
    mem[psp + 2] = 0x00; mem[psp + 3] = 0xa0;
    mem[psp + 0x2c] = SEL_ENV; mem[psp + 0x2d] = 0;
    const tail = args ? ` ${args}` : '';
    mem[psp + 0x80] = Math.min(126, tail.length);
    for (let i = 0; i < tail.length && i < 126; i++) mem[psp + 0x81 + i] = tail.charCodeAt(i);
    mem[psp + 0x81 + Math.min(126, tail.length)] = 13;
    // the environment, then the program's own path after a count of one
    const env = ENV_SEG * 16;
    const envText = 'PATH=C:\\\0COMSPEC=C:\\COMMAND.COM\0BLASTER=A220 I7 D1 T3\0\0';
    let p = env;
    for (const ch of envText) mem[p++] = ch.charCodeAt(0);
    mem[p++] = 1; mem[p++] = 0;
    for (const ch of 'C:\\DOOM\\DOOM.EXE\0') mem[p++] = ch.charCodeAt(0);
    selectors.set(SEL_CODE16, img.objs.find((o) => !(o.flags & 0x2000))?.base ?? 0);
    R[ESP] = img.esp;
    cpu.loadSeg(CS, SEL_CODE); cpu.loadSeg(DS, SEL_DATA); cpu.loadSeg(SS, SEL_DATA);
    cpu.loadSeg(ES, SEL_PSP); cpu.loadSeg(FS, 0); cpu.loadSeg(GS, 0);
    cpu.eip = img.entry;
    cpu.flags = 0x202;
    setVideoMode(3);
    // the BIOS data area a program might peek at: 80 columns, a colour card, the timer count
    mem[0x449] = 3; mem[0x44a] = 80; mem[0x463] = 0xd4; mem[0x464] = 0x03; mem[0x484] = 24;
    pit.nextIrq = now() + pitPeriodMs();
    return img;
  }

  // ---------------------------------------------------------------- running
  function deliverIrq() {
    if (!cpu.IF) return false;
    for (let chip = 0; chip < 2; chip++) {
      const pending = pic.irr[chip] & ~pic.mask[chip];
      if (!pending) continue;
      const bit = pending & -pending;
      const higherInService = pic.isr[chip] & (bit - 1 | bit);
      if (higherInService) continue;
      if (chip === 1 && (pic.mask[0] & 4)) continue;
      pic.irr[chip] &= ~bit;
      pic.isr[chip] |= bit;
      const irq = 31 - Math.clz32(bit);
      if (irq === 1 && chip === 0) kbd.data = kbd.queue.shift() ?? kbd.data;
      cpu.interrupt(chip === 0 ? 8 + irq : 0x70 + irq);
      return true;
    }
    return false;
  }
  function updateTimers(t) {
    const period = pitPeriodMs();
    if (t >= pit.nextIrq) {
      raiseIrq(0);
      pit.nextIrq += period;
      if (t - pit.nextIrq > period * 4) pit.nextIrq = t + period;   // fell behind by more than a few: do not replay them all
    }
    if (kbd.queue.length && !(pic.irr[0] & 2) && !(pic.isr[0] & 2)) raiseIrq(1);
    sound?.tick?.(t, raiseIrq);
  }

  /** Run the machine for `n` instructions, in slices, servicing the hardware between them. */
  function run(n, slice = 2000) {
    let done = 0;
    while (done < n && !exited) {
      updateTimers(now());
      deliverIrq();
      if (cpu.halted) {
        // nothing to do until an interrupt: let the clock run
        if (!(pic.irr[0] & ~pic.mask[0]) && !(pic.irr[1] & ~pic.mask[1])) return done;
        cpu.halted = false;
        continue;
      }
      done += cpu.run(Math.min(slice, n - done));
    }
    return done;
  }

  return {
    mem, cpu, vga, text, pic, pit, kbd, mouse: mouseState, dir, stdout,
    boot, run, renderGraphics, renderIndexed,
    get exited() { return exited; }, get exitCode() { return exitCode; },
    /** A key: a set-1 scancode (the break code has bit 7 set; extended keys arrive after 0xE0). */
    key(scancode) { kbd.queue.push(scancode & 0xff); },
    biosKey(scan, ascii) { biosKeys.push([scan, ascii]); },
    raiseIrq,
    unhandled,
  };
}
