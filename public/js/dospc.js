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
const SEL_CODE = 0x08, SEL_DATA = 0x10, SEL_PSP = 0x18, SEL_ENV = 0x20, SEL_CODE16 = 0x28, SEL_LOL = 0x30, SEL_FIRST_FREE = 0x38;

const PIT_HZ = 1193182;

// ------------------------------------------------------------------ the LE loader
/**
 * Find the LE image in a bound DOS/4GW executable, copy its pages into `mem` at `delta` above the
 * addresses it was linked for, and apply its fixups. Returns the objects, entry point and stack.
 */
/** Whether a file carries an LE image behind its MZ stub (a DOS/4GW program). */
export function hasLE(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  for (let i = 0; i + 0x40 < buf.length; i++) {
    if (buf[i] !== 0x4d || buf[i + 1] !== 0x5a) continue;
    const l = dv.getUint32(i + 0x3c, true);
    if (i + l + 2 < buf.length && buf[i + l] === 0x4c && buf[i + l + 1] === 0x45) return true;
  }
  return false;
}

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
// ------------------------------------------------------------------ the COFF loader
/**
 * A DJGPP v2 program: a go32 stub (an MZ executable that finds a DPMI host and loads the rest), then
 * a COFF image. Returns the image's sections, entry point and the size its memory block must have,
 * or null when `buf` is not one. Nothing is copied: DJGPP programs are position-independent of their
 * block (every address is an offset from a selector based at it), so the caller loads them there.
 */
export function parseCoff(buf) {
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const lastPage = dv.getUint16(2, true), pages = dv.getUint16(4, true);
  const coff = lastPage ? (pages - 1) * 512 + lastPage : pages * 512;
  if (coff + 20 > buf.length || dv.getUint16(coff, true) !== 0x14c) return null;
  const nsec = dv.getUint16(coff + 2, true), optSize = dv.getUint16(coff + 16, true);
  if (optSize < 28) return null;
  const entry = dv.getUint32(coff + 20 + 16, true);
  const sections = [];
  let end = 0;
  for (let i = 0; i < nsec; i++) {
    const h = coff + 20 + optSize + i * 40;
    const name = String.fromCharCode(...buf.subarray(h, h + 8)).replace(/\0.*$/, '');
    const vaddr = dv.getUint32(h + 12, true), size = dv.getUint32(h + 16, true), fileOff = dv.getUint32(h + 20, true), flags = dv.getUint32(h + 36, true);
    sections.push({ name, vaddr, size, fileOff: coff + fileOff, bss: (flags & 0x80) !== 0 });
    end = Math.max(end, vaddr + size);
  }
  // the stub's own parameters live in its image: "go32stub" then the size, stack and transfer buffer
  const at = String.fromCharCode(...buf.subarray(0, Math.min(coff, 0x800))).indexOf('go32stub');
  const minstack = at >= 0 ? dv.getUint32(at + 0x14, true) : 0x40000;
  const minkeep = at >= 0 ? dv.getUint16(at + 0x20, true) : 0x4000;
  return { coff, entry, sections, size: (end + 0xfff) & ~0xfff, minstack, minkeep: minkeep || 0x4000 };
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
export function createPC({ files = {}, args = '', now = () => 0, onWrite = null, onExit = null, sound = null, log = null, programName = 'GAME.EXE' } = {}) {
  const mem = new Uint8Array(MEM_SIZE);
  if (typeof sound === 'function') sound = sound(mem);    // a card built on this machine's memory
  const selectors = new Map([[0, 0], [SEL_CODE, 0], [SEL_DATA, 0], [SEL_PSP, PSP_SEG * 16], [SEL_ENV, ENV_SEG * 16], [SEL_LOL, 0x500]]);
  // where the running program's PSP is: 0100h for DOS/4GW, just below the transfer buffer for DJGPP
  let pspSeg = PSP_SEG;
  let realMode = 0;                       // inside a DPMI 0300 call: DOS answers with segments
  let nextSelector = SEL_FIRST_FREE;
  const seg16 = new Set();                // selectors whose descriptor is 16-bit (D bit clear)

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
    writes: 0,                         // bumped on every write into the graphics window
    latch: new Uint8Array(4),          // the byte of each plane the last read left (write mode 1)
  };
  vga.seq[2] = 0x0f; vga.seq[4] = 0x0e;
  const chain4 = () => (vga.seq[4] & 0x08) !== 0;
  function vgaWrite(a, v) {
    const off = a - 0xa0000;
    // the text buffer at B8000 is plain memory in either mode; the graphics window is planes
    if (vga.mode !== 0x13 || off >= 0x10000) { if (a >= 0xb8000) mem[a] = v; return; }
    if (chain4()) { vga.planes[off & 3][off >> 2] = v; vga.writes++; return; }
    vga.writes++;
    const mask = vga.seq[2];
    // WRITE MODE 1 copies the bytes the last read latched from every plane, whatever is written:
    // Wolfenstein 3D copies between its pages with it (a read from one, a write to the other)
    if ((vga.gc[5] & 3) === 1) {
      for (let pl = 0; pl < 4; pl++) if (mask & (1 << pl)) vga.planes[pl][off] = vga.latch[pl];
      return;
    }
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
    for (let pl = 0; pl < 4; pl++) vga.latch[pl] = vga.planes[pl][off];
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
    latch: [-1, -1, -1], readLow: [true, true, true], start: [0, 0, 0], nextIrq: 0, gate2: 0, tickBase: 0,
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
        if (ch === 0) pit.tickBase += Math.floor(((now() - pit.start[0]) * PIT_HZ) / 1000 / 65536);
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
        cpu.invalidate(at, size);
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
  // DOS CONVENTIONAL MEMORY: blocks of paragraphs, first fit, that can be freed and resized in
  // place. A bump pointer did for the extenders, which ask once; a real-mode Borland program is
  // handed all of memory at start, gives most back with AH=4Ah, and grows its heap by resizing its
  // own block again.
  const DOS_TOP = 0x9f00;
  const dosBlocks = [];                  // { seg, paras }, sorted by segment
  function dosFreeAfter(i) {
    const end = i + 1 < dosBlocks.length ? dosBlocks[i + 1].seg : DOS_TOP;
    return end - (dosBlocks[i].seg + dosBlocks[i].paras);
  }
  function dosLargest() {
    let at = DOS_HEAP_SEG, best = 0;
    for (const b of dosBlocks) { best = Math.max(best, b.seg - at); at = b.seg + b.paras; }
    return Math.max(best, DOS_TOP - at);
  }
  function dosAlloc(paras) {
    let at = DOS_HEAP_SEG;
    for (let i = 0; i <= dosBlocks.length; i++) {
      const limit = i < dosBlocks.length ? dosBlocks[i].seg : DOS_TOP;
      if (limit - at >= paras) { dosBlocks.splice(i, 0, { seg: at, paras }); return at; }
      if (i < dosBlocks.length) at = dosBlocks[i].seg + dosBlocks[i].paras;
    }
    return -1;
  }
  function dosFree(seg) {
    const i = dosBlocks.findIndex((b) => b.seg === seg);
    if (i < 0) return false;
    dosBlocks.splice(i, 1);
    return true;
  }
  /** Resize the block at `seg` in place: true, or the largest size it could have. */
  function dosResize(seg, paras) {
    const i = dosBlocks.findIndex((b) => b.seg === seg);
    if (i < 0) return -1;
    const most = dosBlocks[i].paras + dosFreeAfter(i);
    if (paras > most) return most;
    dosBlocks[i].paras = paras;
    return true;
  }

  // ---------------------------------------------------------------- files
  // PATHS, NOT JUST NAMES: the drive is the program's directory, and a file is its upper-case path
  // under it ("ID1/PAK0.PAK"). DOOM keeps everything beside its executable; Quake keeps its data a
  // directory down and makes more of them.
  const dir = new Map();                // PATH -> Uint8Array
  const dirs = new Set();               // directories made by the program, beside those files imply
  for (const [k, v] of Object.entries(files)) dir.set(normPath(k), v);
  const handles = new Map();            // n -> { name, data, pos, dirty, size }
  function normPath(raw) {
    const parts = [];
    for (const p of String(raw).replace(/^[a-zA-Z]:/, '').replace(/\\/g, '/').split('/')) {
      if (!p || p === '.') continue;
      if (p === '..') parts.pop(); else parts.push(p.toUpperCase());
    }
    return parts.join('/');
  }
  function dosName(a) {
    let s = '';
    for (let i = 0; i < 128; i++) { const c = mem[a + i]; if (!c) break; s += String.fromCharCode(c); }
    return normPath(s);
  }
  const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
  function isDir(path) {
    if (path === '' || dirs.has(path)) return true;
    for (const k of dir.keys()) if (k.startsWith(`${path}/`)) return true;
    return false;
  }
  function openHandle(name, data) {
    let h = 5;
    while (handles.has(h)) h++;
    if (h >= SFT_ENTRIES) return -1;
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
  // THE SYSTEM FILE TABLE. DOS keeps one entry per open file in its own memory, and a program that
  // wants more than a handle can give -- DJGPP's fstat() wants the size, the date and a number to
  // use as an inode -- asks INT 21h AH=52h for the "list of lists", follows its pointer to the SFT,
  // and reads the entry the PSP's job file table names for the handle. So there is one, at 0050:0000
  // below the PSP, kept in step with every open, read, write, seek and close (syncSft).
  const LOL = 0x500, SFT = 0x510, SFT_ENTRIES = 20, SFT_SIZE = 0x3b;
  function initSft() {
    mem.fill(0, LOL, SFT + 6 + SFT_ENTRIES * SFT_SIZE);
    mem[LOL + 4] = SFT - LOL; mem[LOL + 5] = 0; mem[LOL + 6] = (LOL >> 4) & 0xff; mem[LOL + 7] = LOL >> 12;
    mem[SFT] = 0xff; mem[SFT + 1] = 0xff; mem[SFT + 2] = 0xff; mem[SFT + 3] = 0xff;   // no next table
    mem[SFT + 4] = SFT_ENTRIES;
    const psp = pspSeg * 16;
    mem[psp + 0x32] = SFT_ENTRIES;
    mem[psp + 0x34] = 0x18; mem[psp + 0x35] = 0; mem[psp + 0x36] = pspSeg & 0xff; mem[psp + 0x37] = pspSeg >> 8;
    syncSft();
  }
  function syncSft() {
    const psp = pspSeg * 16;
    for (let h = 0; h < SFT_ENTRIES; h++) {
      const e = SFT + 6 + h * SFT_SIZE, f = handles.get(h);
      const put16 = (o, v) => { mem[e + o] = v; mem[e + o + 1] = v >> 8; };
      const put32 = (o, v) => { mem[e + o] = v; mem[e + o + 1] = v >> 8; mem[e + o + 2] = v >> 16; mem[e + o + 3] = v >>> 24; };
      if (h < 5) {                                         // the standard devices
        mem[psp + 0x18 + h] = h;
        put16(0, 1); put16(5, 0x80d3);
        for (let i = 0; i < 11; i++) mem[e + 0x20 + i] = 'CON        '.charCodeAt(i);
        continue;
      }
      if (!f) { mem[psp + 0x18 + h] = 0xff; put16(0, 0); continue; }
      mem[psp + 0x18 + h] = h;
      put16(0, 1); put16(2, f.mode ?? 2); mem[e + 4] = 0x20; put16(5, 0x02 | (f.dirty ? 0 : 0x40));
      put16(0x0b, 2 + h); put16(0x0d, 0); put16(0x0f, 0x21); put32(0x11, f.size); put32(0x15, f.pos);
      const base = f.name.slice(f.name.lastIndexOf('/') + 1), [stem, ext = ''] = base.split('.');
      const fcb = stem.padEnd(8).slice(0, 8) + ext.padEnd(3).slice(0, 3);
      for (let i = 0; i < 11; i++) mem[e + 0x20 + i] = fcb.charCodeAt(i);
    }
  }

  // find first / find next over the directory, matching DOS wildcards
  let findList = [];
  function wildcard(pat) {
    const [pn, pe = ''] = pat.split('.');
    const rx = (p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.?');
    return new RegExp(`^${rx(pn)}(\\.${rx(pe)})?$`, 'i');
  }
  /** The entries of one directory matching a DOS pattern: files, and subdirectories when asked. */
  function listDir(pattern, attrs) {
    const parent = parentOf(pattern), rx = wildcard(pattern.slice(parent ? parent.length + 1 : 0) || '*.*');
    const seen = new Map();
    const consider = (path, isDirectory) => {
      if (parentOf(path) !== parent) return;
      const name = path.slice(parent ? parent.length + 1 : 0);
      if (rx.test(name) && !seen.has(name)) seen.set(name, { name, isDirectory, size: isDirectory ? 0 : dir.get(path).length });
    };
    for (const k of dir.keys()) {
      consider(k, false);
      if (attrs & 0x10) {                                  // directories implied by the paths under them
        let d = parentOf(k);
        while (d && d !== parent) { consider(d, true); d = parentOf(d); }
      }
    }
    if (attrs & 0x10) for (const d of dirs) consider(d, true);
    return [...seen.values()];
  }
  function fillDta(dta, entry) {
    mem[dta + 0x15] = entry.isDirectory ? 0x10 : 0x20;
    mem[dta + 0x16] = 0; mem[dta + 0x17] = 0; mem[dta + 0x18] = 0x21; mem[dta + 0x19] = 0x1f;
    const n = entry.size;
    mem[dta + 0x1a] = n; mem[dta + 0x1b] = n >> 8; mem[dta + 0x1c] = n >> 16; mem[dta + 0x1d] = n >> 24;
    for (let i = 0; i < 13; i++) mem[dta + 0x1e + i] = i < entry.name.length ? entry.name.charCodeAt(i) : 0;
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
    selectorIs16: (sel) => seg16.has(sel & 0xfff8),
    // real mode: the vector table at 0:0, as DOS and the BIOS leave it (each entry a ROM stub until
    // the program sets its own); protected mode: the vectors set through DPMI
    vector: (n) => (cpu.realMode ? { sel: mem[n * 4 + 2] | (mem[n * 4 + 3] << 8), off: mem[n * 4] | (mem[n * 4 + 1] << 8) } : pmVectors[n] ?? romStub(n)),
    softInt: (cpu, n) => {
      // a vector the program installed takes the call, unless it is the one the stub is making
      const fromStub = cpu.eip - 2 === ROM_STUBS + n * 16;
      if (cpu.realMode) {
        const off = mem[n * 4] | (mem[n * 4 + 1] << 8), segv = mem[n * 4 + 2] | (mem[n * 4 + 3] << 8);
        if (!(segv === 0xf000 && off === n * 16) && !fromStub) return false;
      } else if (pmVectors[n] && !fromStub) return false;
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
      case 0x21: { const r = dos(c); syncSft(); return r; }
      case 0x20: exited = true; exitCode = 0; c.stop(); onExit?.(0); return true;
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
      case 0x2f:
        if (u16(R[EAX]) === 0x1500) { R[EBX] &= ~0xffff; return true; }   // MSCDEX: no CD-ROM drives
        setAX(R[EAX] & 0xff00);
        return true;
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
      case 0x25:
        if (c.realMode) { mem[al * 4] = R[EDX]; mem[al * 4 + 1] = R[EDX] >> 8; mem[al * 4 + 2] = c.seg[DS]; mem[al * 4 + 3] = c.seg[DS] >> 8; return true; }
        pmVectors[al] = { sel: c.seg[DS], off: R[EDX] >>> 0 };
        return true;
      case 0x2a: { const d = new Date(); R[ECX] = (R[ECX] & ~0xffff) | d.getFullYear(); R[EDX] = (R[EDX] & ~0xffff) | ((d.getMonth() + 1) << 8) | d.getDate(); R[EAX] = (R[EAX] & ~0xff) | d.getDay(); return true; }
      case 0x2c: { const d = new Date(); R[ECX] = (R[ECX] & ~0xffff) | (d.getHours() << 8) | d.getMinutes(); R[EDX] = (R[EDX] & ~0xffff) | (d.getSeconds() << 8) | Math.floor(d.getMilliseconds() / 10); return true; }
      case 0x2f: c.loadSeg(ES, SEL_DATA); R[EBX] = dta; return true;
      case 0x30: R[EAX] = 0x1606; R[EBX] = 0; R[ECX] = 0; return true;   // DOS 6.22, and no Phar Lap signature
      case 0x33:
        if (al === 0) R[EDX] &= ~0xff;
        // the true version, which DJGPP reads before it trusts the SFT's layout: DOS 6, in the HMA
        if (al === 6) { R[EBX] = (R[EBX] & ~0xffff) | 0x0006; R[EDX] = (R[EDX] & ~0xffff) | 0x1000; }
        ok();
        return true;
      case 0x35: {
        if (c.realMode) { c.loadSeg(ES, mem[al * 4 + 2] | (mem[al * 4 + 3] << 8)); R[EBX] = (R[EBX] & ~0xffff) | mem[al * 4] | (mem[al * 4 + 1] << 8); return true; }
        const v = pmVectors[al] ?? romStub(al); c.loadSeg(ES, v.sel); R[EBX] = v.off;
        return true;
      }
      case 0x36: setAX(4); R[EBX] = (R[EBX] & ~0xffff) | 0x4000; R[ECX] = (R[ECX] & ~0xffff) | 512; R[EDX] = (R[EDX] & ~0xffff) | 0xffff; return true;
      case 0x39: { const d = dosName(linDS(R[EDX])); if (dir.has(d) || isDir(d)) { fail(5); return true; } dirs.add(d); ok(); return true; }
      case 0x3a: { const d = dosName(linDS(R[EDX])); if (!isDir(d)) { fail(3); return true; } dirs.delete(d); ok(); return true; }
      case 0x3b: if (isDir(dosName(linDS(R[EDX])))) ok(); else fail(3); return true;
      case 0x3c: case 0x5b: {                     // create
        const name = dosName(linDS(R[EDX]));
        if (ah === 0x5b && dir.has(name)) { fail(80); return true; }
        if (isDir(name) || !isDir(parentOf(name))) { fail(isDir(name) ? 5 : 3); return true; }
        const data = new Uint8Array(4096);
        const h = openHandle(name, data);
        if (h < 0) { fail(4); return true; }
        const f = handles.get(h); f.size = 0; f.dirty = true; f.mode = 2;
        dir.set(name, new Uint8Array(0));
        R[EAX] = h; ok();
        return true;
      }
      case 0x3d: {                                // open
        const name = dosName(linDS(R[EDX]));
        const data = dir.get(name);
        if (!data) { fail(2); return true; }
        const h = openHandle(name, (al & 3) ? data.slice() : data);
        if (h < 0) { fail(4); return true; }
        handles.get(h).mode = al;
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
        cpu.invalidate(a, k);
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
        const directory = !dir.has(name) && isDir(name);
        if (!dir.has(name) && !directory) { fail(2); return true; }
        if (al === 0) R[ECX] = (R[ECX] & ~0xffff) | (directory ? 0x10 : 0x20);
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
        if (s < 0) { fail(8); R[EBX] = (R[EBX] & ~0xffff) | dosLargest(); return true; }
        R[EAX] = s; ok();
        return true;
      }
      case 0x49: if (dosFree(c.seg[ES] & 0xffff) || !c.realMode) ok(); else fail(9); return true;
      case 0x4a: {
        if (!c.realMode) { ok(); return true; }
        const r = dosResize(c.seg[ES] & 0xffff, u16(R[EBX]));
        if (r === true) ok(); else if (r < 0) fail(9); else { fail(8); R[EBX] = (R[EBX] & ~0xffff) | r; }
        return true;
      }
      case 0x4c: exited = true; exitCode = al; c.stop(); onExit?.(al); return true;
      case 0x4e: {
        findList = listDir(dosName(linDS(R[EDX])), u16(R[ECX]));
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
      case 0x58: if (al === 0) setAX(0); ok(); return true;
      case 0x59: setAX(0); R[EBX] &= ~0xffff; R[ECX] &= ~0xffff; return true;
      case 0x60: {                                // canonical name: C:\ and the path
        const out = `C:\\${dosName(linDS(R[ESI])).replace(/\//g, '\\')}\0`, a = linES(R[EDI]);
        for (let i = 0; i < out.length; i++) mem[a + i] = out.charCodeAt(i);
        ok();
        return true;
      }
      case 0x67: case 0x68: case 0x6a: ok(); return true;
      case 0x71: setAX(0x7100); cpu.setCF(true); return true;
      case 0x5d: fail(1); return true;              // the swappable data area: not offered, which DOS 6 may also say   // no long file names: the answer programs expect
      case 0x51: case 0x62: R[EBX] = (R[EBX] & ~0xffff) | (realMode || c.realMode ? pspSeg : SEL_PSP); return true;
      case 0x52: c.loadSeg(ES, SEL_LOL); R[EBX] &= ~0xffff; return true;   // the list of lists (syncSft)
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
      case 0x0008: ok(); return true;
      case 0x0009: if (u16(R[ECX]) & 0x4000) seg16.delete(u16(R[EBX]) & 0xfff8); else if (u16(R[ECX]) & 0x08) seg16.add(u16(R[EBX]) & 0xfff8); refreshSegs(c); ok(); return true;
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
        // a code descriptor with the D bit clear is 16-bit code
        if ((mem[a + 5] & 0x08) && !(mem[a + 6] & 0x40)) seg16.add(u16(R[EBX]) & 0xfff8); else seg16.delete(u16(R[EBX]) & 0xfff8);
        refreshSegs(c); ok();
        return true;
      }
      case 0x0100: {
        const s = dosAlloc(u16(R[EBX]));
        if (s < 0) { fail(8); R[EBX] = (R[EBX] & ~0xffff) | dosLargest(); return true; }
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
        cpu.invalidate(nb.base, old.size);
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
      case 0x0507: case 0x0506: fail(0x8001); return true;       // DPMI 1.0 page attributes: a 0.9 host has none, and DJGPP expects that
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
    // real mode is 16-bit: a caller that fills the table through a union leaves stale upper halves,
    // and a pointer in DS:DX must not carry them
    R[EDI] = g16(0); R[ESI] = g16(4); R[EBP] = g16(8); R[EBX] = g16(16); R[EDX] = g16(20); R[ECX] = g16(24); R[EAX] = g16(28);
    // real-mode segments: selectors whose base is the segment times sixteen
    const rmSel = (segv, which) => { const sel = 0xf000 + which * 8; selectors.set(sel, segv * 16); c.loadSeg(which, sel); };
    rmSel(g16(0x22), ES); rmSel(g16(0x24), DS);
    c.flags = g16(0x20);
    realMode++;
    try { service(c, n); } finally { realMode--; }
    const outFlags = c.flags;
    // a service that returns a pointer in ES or DS (the list of lists, a vector) hands back a segment
    p16(0x22, (c.segBase[ES] >>> 4) & 0xffff); p16(0x24, (c.segBase[DS] >>> 4) & 0xffff);
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
      case 0x4f: setAX(0x0100); return true;      // VESA BIOS extensions: not here (AL != 4Fh), VGA modes only
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
  // THE POINTER HAS A POSITION (operator, 2026-09-18: "keys still don't work in the menu. I can't
  // even start the game"). Function 3 used to answer 0,0 whatever happened, and function 4 was
  // ignored. Wolfenstein 3D's menus read the mouse that way: centre it with function 4 (x 320,
  // y 100), read it back with function 3, and take anything more than 60 from the centre as a
  // direction held -- then wait for that direction to be let go before taking the next input. At
  // 0,0 it was "up, held" forever, so the menu waited forever and no key, Enter included, got
  // through. Now the driver keeps a position the way a real one does: centred in its range on a
  // reset, set by function 4, bounded by 7 and 8, and moved by the page's mouse motion -- a
  // mickey a pixel across, two a pixel down, the driver defaults.
  const mouseState = {
    dx: 0, dy: 0, buttons: 0, present: true,
    x: 320, y: 100, minX: 0, maxX: 639, minY: 0, maxY: 199, fx: 0, fy: 0,
    /** Motion in mickeys: the counters function 0Bh reads, and the pointer function 3 reads. */
    move(dx, dy) {
      this.dx += dx; this.dy += dy;
      this.fx += dx; this.fy += dy / 2;
      const ix = Math.trunc(this.fx), iy = Math.trunc(this.fy);
      this.fx -= ix; this.fy -= iy;
      this.x = Math.max(this.minX, Math.min(this.maxX, this.x + ix));
      this.y = Math.max(this.minY, Math.min(this.maxY, this.y + iy));
    },
  };
  const s16 = (v) => (v << 16) >> 16;
  function mouse(c) {
    const ax = u16(R[EAX]);
    const m = mouseState;
    switch (ax) {
      case 0x0001: case 0x0002: case 0x000f: case 0x001a: case 0x001d: return true;
      case 0x0000: case 0x0021:
        if (!m.present) { setAX(0); return true; }
        // a reset: the default range, the pointer in the middle of it
        m.minX = 0; m.maxX = 639; m.minY = 0; m.maxY = 199; m.x = 320; m.y = 100; m.fx = 0; m.fy = 0;
        setAX(0xffff); R[EBX] = (R[EBX] & ~0xffff) | 3; return true;
      case 0x0003: R[EBX] = (R[EBX] & ~0xffff) | m.buttons; R[ECX] = (R[ECX] & ~0xffff) | m.x; R[EDX] = (R[EDX] & ~0xffff) | m.y; return true;
      case 0x0004:
        m.x = Math.max(m.minX, Math.min(m.maxX, s16(u16(R[ECX]))));
        m.y = Math.max(m.minY, Math.min(m.maxY, s16(u16(R[EDX]))));
        m.fx = 0; m.fy = 0;
        return true;
      case 0x0007: case 0x0008: {
        const a = s16(u16(R[ECX])), b = s16(u16(R[EDX]));
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (ax === 7) { m.minX = lo; m.maxX = hi; m.x = Math.max(lo, Math.min(hi, m.x)); } else { m.minY = lo; m.maxY = hi; m.y = Math.max(lo, Math.min(hi, m.y)); }
        return true;
      }
      case 0x000b: {
        const dx = Math.max(-32768, Math.min(32767, Math.round(mouseState.dx)));
        const dy = Math.max(-32768, Math.min(32767, Math.round(mouseState.dy)));
        mouseState.dx -= dx; mouseState.dy -= dy;
        R[ECX] = (R[ECX] & ~0xffff) | (dx & 0xffff); R[EDX] = (R[EDX] & ~0xffff) | (dy & 0xffff);
        return true;
      }
    }
    note(`INT 33 AX=${ax.toString(16)}`);
    return true;
  }

  // ---------------------------------------------------------------- start
  function writeEnvironment(programPath) {
    const env = ENV_SEG * 16;
    const envText = 'PATH=C:\\\0COMSPEC=C:\\COMMAND.COM\0BLASTER=A220 I7 D1 T4\0\0';
    let p = env;
    for (const ch of envText) mem[p++] = ch.charCodeAt(0);
    mem[p++] = 1; mem[p++] = 0;
    for (const ch of `${programPath}\0`) mem[p++] = ch.charCodeAt(0);
    return p - env;
  }
  function writeCommandTail(psp) {
    const tail = args ? ` ${args}` : '';
    mem[psp + 0x80] = Math.min(126, tail.length);
    for (let i = 0; i < tail.length && i < 126; i++) mem[psp + 0x81 + i] = tail.charCodeAt(i);
    mem[psp + 0x81 + Math.min(126, tail.length)] = 13;
  }
  function biosDataArea() {
    // what a program might peek at: 80 columns, a colour card, the timer count (updateTimers)
    mem[0x449] = 3; mem[0x44a] = 80; mem[0x463] = 0xd4; mem[0x464] = 0x03; mem[0x484] = 24;
  }
  const newSelector = (base) => { const sel = nextSelector; nextSelector += 8; selectors.set(sel, base >>> 0); return sel; };

  /**
   * Start a program: a DOS/4GW LE (DOOM) or a DJGPP COFF (Quake), told apart by what is in the file.
   */
  function boot(exe) {
    const coff = parseCoff(exe);
    if (coff) return bootCoff(exe, coff);
    if (!hasLE(exe)) return bootMZ(exe);
    const img = loadLE(exe, mem, LOAD_DELTA);
    // PSP: the command tail at 80h, the environment's selector at 2Ch
    const psp = PSP_SEG * 16;
    mem[psp] = 0xcd; mem[psp + 1] = 0x20;
    mem[psp + 2] = 0x00; mem[psp + 3] = 0xa0;
    mem[psp + 0x2c] = SEL_ENV; mem[psp + 0x2d] = 0;
    writeCommandTail(psp);
    initSft();
    // the environment, then the program's own path after a count of one
    writeEnvironment('C:\\DOOM\\DOOM.EXE');
    selectors.set(SEL_CODE16, img.objs.find((o) => !(o.flags & 0x2000))?.base ?? 0);
    biosDataArea();
    R[ESP] = img.esp;
    cpu.loadSeg(CS, SEL_CODE); cpu.loadSeg(DS, SEL_DATA); cpu.loadSeg(SS, SEL_DATA);
    cpu.loadSeg(ES, SEL_PSP); cpu.loadSeg(FS, 0); cpu.loadSeg(GS, 0);
    cpu.eip = img.entry;
    cpu.flags = 0x202;
    setVideoMode(3);
    pit.nextIrq = now() + pitPeriodMs();
    return img;
  }

  /**
   * A REAL-MODE PROGRAM (Wolfenstein 3D): what DOS's own EXEC does. The program gets the largest free
   * block of conventional memory with its PSP at the front, the image is copied in after the PSP and
   * its segment relocations fixed up, DS and ES point at the PSP, and the CPU starts in real mode at
   * the header's CS:IP with its SS:SP. The vector table at 0:0 points every interrupt at the ROM
   * stubs until the program hooks one.
   */
  function bootMZ(exe) {
    const dv = new DataView(exe.buffer, exe.byteOffset, exe.length);
    const u = (o) => dv.getUint16(o, true);
    const lastPage = u(2), pages = u(4);
    const fileSize = lastPage ? (pages - 1) * 512 + lastPage : pages * 512;
    const hdr = u(8) * 16;
    const image = exe.subarray(hdr, Math.min(exe.length, fileSize));
    const imageParas = (image.length + 15) >> 4;
    const want = Math.min(dosLargest(), Math.max(0x10 + imageParas + u(0x0a), Math.min(0xffff, 0x10 + imageParas + u(0x0c))));
    pspSeg = dosAlloc(want);
    if (pspSeg < 0) throw new Error('not enough conventional memory for this program');
    const loadSeg = pspSeg + 0x10;
    mem.set(image, loadSeg * 16);
    for (let i = 0; i < u(6); i++) {
      const e = u(0x18) + i * 4;
      const at = (u(e + 2) + loadSeg) * 16 + u(e);
      const v = (mem[at] | (mem[at + 1] << 8)) + loadSeg;
      mem[at] = v; mem[at + 1] = v >> 8;
    }
    const psp = pspSeg * 16;
    mem.fill(0, psp, psp + 0x100);
    mem[psp] = 0xcd; mem[psp + 1] = 0x20;
    const top = pspSeg + want;
    mem[psp + 2] = top; mem[psp + 3] = top >> 8;
    mem[psp + 0x2c] = ENV_SEG & 0xff; mem[psp + 0x2d] = ENV_SEG >> 8;
    selectors.set(SEL_PSP, psp);
    dta = psp + 0x80;
    writeCommandTail(psp);
    initSft();
    writeEnvironment(`C:\\${programName}`);
    for (let n = 0; n < 256; n++) { mem[n * 4] = n * 16; mem[n * 4 + 1] = (n * 16) >> 8; mem[n * 4 + 2] = 0x00; mem[n * 4 + 3] = 0xf0; }
    biosDataArea();
    cpu.realMode = true;
    cpu.loadSeg(CS, u(0x16) + loadSeg); cpu.loadSeg(SS, u(0x0e) + loadSeg);
    cpu.loadSeg(DS, pspSeg); cpu.loadSeg(ES, pspSeg); cpu.loadSeg(FS, 0); cpu.loadSeg(GS, 0);
    R[ESP] = u(0x10);
    cpu.eip = (u(0x16) + loadSeg) * 16 + u(0x14);
    cpu.flags = 0x202;
    setVideoMode(3);
    pit.nextIrq = now() + pitPeriodMs();
    return { kind: 'mz', loadSeg, psp: pspSeg };
  }

  /**
   * THE GO32 STUB, IMPERSONATED. The real stub is 16-bit code that finds a DPMI host (loading
   * CWSDPMI.EXE if it must), switches to protected mode, allocates the program's memory block,
   * reads the COFF sections into it and jumps to the entry with FS on a copy of its "stubinfo". The
   * CPU here has no real mode, so this does what the stub leaves behind: the block with the sections
   * in it, code and data selectors based at the block, a transfer buffer in conventional memory, and
   * the stubinfo that crt0 reads -- and then CWSDPMI's part is played by this file's INT 31h.
   */
  function bootCoff(exe, img) {
    const block = allocBlock(img.size);
    for (const sec of img.sections) {
      if (sec.bss) continue;
      mem.set(exe.subarray(sec.fileOff, sec.fileOff + sec.size), block.base + sec.vaddr);
    }
    const csSel = newSelector(block.base), dsSel = newSelector(block.base);
    // the transfer buffer DOS calls go through, and the PSP with the environment's real-mode segment
    // the real stub is loaded at PSP+100h and its transfer buffer is inside it, and DJGPP's libc
    // finds the PSP by subtracting 100h from the buffer's address: so the PSP sits right below it
    pspSeg = dosAlloc(0x10 + ((img.minkeep + 15) >> 4));
    selectors.set(SEL_PSP, pspSeg * 16);
    dta = pspSeg * 16 + 0x80;
    const tbSeg = pspSeg + 0x10;
    const tbSel = newSelector(tbSeg * 16);
    const psp = pspSeg * 16;
    mem[psp] = 0xcd; mem[psp + 1] = 0x20; mem[psp + 2] = 0x00; mem[psp + 3] = 0xa0;
    // a DPMI host swaps the environment's segment at PSP:2Ch for a selector on entry to protected
    // mode, and DJGPP's libc reads it as one
    mem[psp + 0x2c] = SEL_ENV; mem[psp + 0x2d] = 0;
    writeCommandTail(psp);
    initSft();
    const envSize = writeEnvironment('C:\\QUAKE.EXE');
    // stubinfo (djgpp stub.asm): magic, size, minstack, memory handle, initial size, minkeep, the
    // transfer buffer's selector and segment, the PSP selector, the stub's CS, env size, names
    const siSeg = dosAlloc(8), si = siSeg * 16;
    const put32 = (o, v) => { mem[si + o] = v; mem[si + o + 1] = v >> 8; mem[si + o + 2] = v >> 16; mem[si + o + 3] = v >>> 24; };
    const put16 = (o, v) => { mem[si + o] = v; mem[si + o + 1] = v >> 8; };
    const putStr = (o, str, n) => { for (let i = 0; i < n; i++) mem[si + o + i] = i < str.length ? str.charCodeAt(i) : 0; };
    putStr(0, 'go32stub, v 2.00', 16);
    put32(0x10, 0x54); put32(0x14, img.minstack); put32(0x18, block.handle); put32(0x1c, img.size);
    // the stub's own code selector: 16-bit, based where the stub (and so the transfer buffer) is.
    // crt0's exit copies its last few instructions -- free the program's memory, INT 21h 4Ch -- into
    // the buffer and jumps to them through this
    const stubCs = newSelector(tbSeg * 16);
    seg16.add(stubCs);
    put16(0x20, img.minkeep); put16(0x22, tbSel); put16(0x24, tbSeg); put16(0x26, SEL_PSP); put16(0x28, stubCs);
    put16(0x2a, envSize);
    putStr(0x2c, 'QUAKE', 8); putStr(0x34, 'QUAKE.EXE', 16); putStr(0x44, 'CWSDPMI', 16);
    const siSel = newSelector(si);
    biosDataArea();
    // registers as the stub hands over: a scratch stack below the video memory until crt0 makes its own
    cpu.loadSeg(CS, csSel); cpu.loadSeg(DS, dsSel); cpu.loadSeg(ES, dsSel);
    cpu.loadSeg(SS, SEL_DATA); cpu.loadSeg(FS, siSel); cpu.loadSeg(GS, 0);
    R[ESP] = 0x9ff00;
    cpu.eip = block.base + img.entry;
    cpu.flags = 0x202;
    setVideoMode(3);
    pit.nextIrq = now() + pitPeriodMs();
    return { ...img, base: block.base, kind: 'djgpp' };
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
    // THE BIOS TICK COUNT at 0040:006C, which the BIOS's own IRQ 0 handler keeps. Programs read it
    // beside the timer's counter to tell the time finely (DJGPP's uclock), so it advances exactly
    // when counter 0 wraps -- a wrap per 65,536 input clocks -- and is carried across reprogramming
    const wraps = Math.floor(((t - pit.start[0]) * PIT_HZ) / 1000 / 65536);
    const ticks = (pit.tickBase + wraps) >>> 0;
    mem[0x46c] = ticks; mem[0x46d] = ticks >> 8; mem[0x46e] = ticks >> 16; mem[0x46f] = ticks >>> 24;
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
  function run(n, slice = 8000) {
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
