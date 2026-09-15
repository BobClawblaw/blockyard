// THE DOOM DIVERSION'S PC (public/js/dospc.js, soundcard.js): the executable loader, the hardware a
// DOS game programs directly, and -- when the shareware files are present -- DOOM.EXE itself,
// booted headless on a clock that counts instructions, so every run is the same run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPC, loadLE, MEM_SIZE } from '../public/js/dospc.js';
import { createSoundCard, Opl3, oplRateTimes } from '../public/js/soundcard.js';
import { rebindKeys, withControls } from '../public/js/doomio.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOOM = path.join(ROOT, 'doom_dos');
const haveDoom = fs.existsSync(path.join(DOOM, 'DOOM.EXE')) && fs.existsSync(path.join(DOOM, 'DOOM1.WAD'));
// Not silently green without the files: the skip names what is missing.
const needDoom = haveDoom ? {} : { skip: 'doom_dos/DOOM.EXE and DOOM1.WAD are not in this checkout' };

function doomFiles() {
  const out = {};
  for (const f of fs.readdirSync(DOOM)) if (!f.startsWith('.')) out[f] = new Uint8Array(fs.readFileSync(path.join(DOOM, f)));
  return out;
}
const text = (pc) => String.fromCharCode(...pc.stdout);

// ------------------------------------------------------------------ with DOOM.EXE
test('the LE inside the bound DOS/4GW stub loads above a megabyte with every fixup applied', needDoom, () => {
  const mem = new Uint8Array(MEM_SIZE);
  const img = loadLE(new Uint8Array(fs.readFileSync(path.join(DOOM, 'DOOM.EXE'))), mem);
  assert.equal(img.objs.length, 3, 'code, a 16-bit stub, data');
  assert.ok(img.objs.every((o) => o.base >= 0x100000), 'clear of conventional memory and the VGA window');
  assert.equal(img.fixups, 12104, 'the count the executable carries (a parse that stops early loads a program that jumps into zeros)');
  assert.equal(img.entry, 0x150b48);
  assert.equal(mem[img.entry], 0xeb, 'the Watcom start-up begins with a short jump over its copyright');
});

test('DOOM.EXE boots: DOS/4GW is believed, the zone is allocated, the WAD is read, graphics come up', needDoom, () => {
  let pc;
  const now = () => (pc ? pc.cpu.cycles : 0) / 30e6 * 1000;   // 30 million instructions a virtual second
  pc = createPC({ files: doomFiles(), now, sound: (mem) => createSoundCard({ mem, rate: 11025 }) });
  pc.boot(new Uint8Array(fs.readFileSync(path.join(DOOM, 'DOOM.EXE'))));
  let n = 0;
  while (pc.vga.frames < 20 && n < 150e6 && !pc.exited) n += pc.run(1e6);
  const out = text(pc);
  // the blue title bar is not printed: DOOM writes it through INT 10h straight into text memory
  const row0 = String.fromCharCode(...[...pc.mem.subarray(0xb8000, 0xb8000 + 160)].filter((_, i) => i % 2 === 0));
  assert.match(row0, /DOOM System Startup v1\.9/);
  assert.match(out, /DPMI memory: 0x[0-9a-f]+, 0x800000 allocated for zone/, 'eight megabytes of zone, as on a real 486');
  assert.match(out, /adding doom1\.wad/);
  assert.match(out, /shareware version/);
  assert.match(out, /ST_Init: Init status bar/);
  assert.doesNotMatch(out, /isn't responding/, 'the Sound Blaster and the OPL were both found');
  assert.equal(pc.vga.mode, 0x13);
  assert.ok(pc.vga.frames >= 20, `pages flipped: ${pc.vga.frames} after ${n} instructions`);
  assert.equal(pc.mem[0x449], 0x13, 'the BIOS data area says so too -- DOOM reads it back before showing ENDOOM');
  const frame = pc.renderIndexed(new Uint8Array(64000));
  assert.ok(new Set(frame).size > 100, 'the title screen, not a blank page');
  assert.deepEqual([...pc.unhandled], [], 'no DOS, DPMI or BIOS call went unanswered');

  // THE KEYS, LIVE (operator: "have to refresh for settings to take effect"): the defaults table
  // DOOM loaded its config into is found by name and rewritten in place
  const dv = new DataView(pc.mem.buffer);
  const liveKey = (entries, name) => dv.getInt32(dv.getUint32(entries[name] + 4, true), true);
  const entries = {};
  assert.equal(rebindKeys(pc.mem, 'classic', entries), 7, 'all seven movement settings found');
  assert.equal(liveKey(entries, 'key_up'), 0xad, 'classic: the up arrow, in DOOM\'s own key code');
  assert.equal(liveKey(entries, 'key_use'), 32);
  assert.equal(rebindKeys(pc.mem, 'wasd', entries), 7);
  assert.equal(liveKey(entries, 'key_up'), 119, 'w');
  assert.equal(liveKey(entries, 'key_straferight'), 100, 'd');
  assert.equal(dv.getInt32(entries.key_strafeleft + 16, true), 30, 'and the scancode DOOM writes back to its config on quit');
});

// ------------------------------------------------------------------ the hardware, without DOOM
function barePC() {
  const pc = createPC({ files: { 'A.TXT': new TextEncoder().encode('hello') } });
  return pc;
}

test('the VGA: chained mode 13h is a byte per pixel; unchained writes go through the map mask', () => {
  const pc = barePC();
  const { cpu } = pc;
  cpu.R[0] = 0x13;
  // int 10h with AX=0013h goes through the machine
  pc.mem.set([0xcd, 0x10, 0xf4], 0x2000);
  cpu.eip = 0x2000; cpu.run(2);
  assert.equal(pc.vga.mode, 0x13);
  cpu.wb(0xa0000 + 321, 7);
  let f = pc.renderIndexed(new Uint8Array(64000));
  assert.equal(f[321], 7, 'chained: offset is pixel');
  // unchain (sequencer memory mode bit 3 off), map mask plane 1, CRTC offset 40, start page 0x4000
  const out = (p, v) => { pc.mem.set([0xb0, v, 0x66, 0xba, p & 0xff, p >> 8, 0xee, 0xf4], 0x2000); cpu.eip = 0x2000; cpu.run(3); };
  out(0x3c4, 4); out(0x3c5, 0x06);
  out(0x3c4, 2); out(0x3c5, 0x02);
  out(0x3d4, 0x13); out(0x3d5, 40);
  out(0x3d4, 0x0c); out(0x3d5, 0x40);
  cpu.wb(0xa4000 + 80 * 3 + 2, 9);                      // row 3, column 2 of plane 1 = pixel x 9
  f = pc.renderIndexed(new Uint8Array(64000));
  assert.equal(f[3 * 320 + 9], 9, 'a planar page, displayed from the CRTC start address');
  assert.ok(pc.vga.frames > 0, 'moving the start address is a page flip');
});

test('the timer interrupts at the rate the program sets, and the PIC holds IRQ0 until EOI', () => {
  let t = 0;
  const pc = createPC({ now: () => t });
  const { cpu, mem } = pc;
  // handler at 0x3000: inc dword [0x500] ; iret  -- no EOI, so only one IRQ can be taken
  mem.set([0xff, 0x05, 0x00, 0x05, 0x00, 0x00, 0xcf], 0x3000);
  // program: set vector 8 via DPMI 0205, program PIT to 1000 Hz, unmask IRQ0, sti, loop
  const prog = [
    0xb8, 0x05, 0x02, 0x00, 0x00, 0xb3, 0x08, 0xb9, 0x08, 0x00, 0x00, 0x00, 0xba, 0x00, 0x30, 0x00, 0x00, 0xcd, 0x31,
    0xb0, 0x34, 0xe6, 0x43, 0xb0, 0xa9, 0xe6, 0x40, 0xb0, 0x04, 0xe6, 0x40,         // 1193 = 0x04a9
    0xb0, 0xfe, 0xe6, 0x21, 0xfb, 0xeb, 0xfe,
  ];
  mem.set(prog, 0x2000);
  cpu.eip = 0x2000;
  pc.pic.mask[0] = 0xff;
  pc.run(20);
  for (let i = 0; i < 10; i++) { t += 1.0; pc.run(100); }
  assert.equal(mem[0x500], 1, 'one interrupt in service and never acknowledged blocks the next');
  // now a handler that acknowledges: inc ; mov al,20h ; out 20h,al ; iret
  mem.set([0xff, 0x05, 0x00, 0x05, 0x00, 0x00, 0xb0, 0x20, 0xe6, 0x20, 0xcf], 0x3000);
  pc.pic.isr[0] = 0;
  for (let i = 0; i < 10; i++) { t += 1.0; pc.run(100); }
  assert.ok(mem[0x500] >= 9 && mem[0x500] <= 12, `about one a millisecond at 1000 Hz, got ${mem[0x500] - 1} in 10 ms`);
});

test('DOS files: open, read, seek, and a written file handed to the host when it is closed', () => {
  const written = [];
  const pc = createPC({ files: { 'A.TXT': new TextEncoder().encode('hello world') }, onWrite: (n, b) => written.push([n, b && new TextDecoder().decode(b)]) });
  const { cpu, mem } = pc;
  const name = (s, at) => mem.set([...new TextEncoder().encode(s), 0], at);
  const int21 = () => { mem.set([0xcd, 0x21, 0xf4], 0x2000); cpu.eip = 0x2000; cpu.run(2); };
  name('C:\\DOOM\\a.txt', 0x4000);
  cpu.R[0] = 0x3d00; cpu.R[2] = 0x4000; int21();
  const h = cpu.R[0] & 0xffff;
  assert.ok(h >= 5, 'a handle past the standard five');
  cpu.R[0] = 0x4200; cpu.R[3] = h; cpu.R[1] = 0; cpu.R[2] = 6; int21();
  cpu.R[0] = 0x3f00; cpu.R[3] = h; cpu.R[1] = 5; cpu.R[2] = 0x5000; int21();
  assert.equal(cpu.R[0], 5);
  assert.equal(new TextDecoder().decode(mem.subarray(0x5000, 0x5005)), 'world', 'case-insensitive, drive and directory ignored, after the seek');
  name('DOOMSAV0.DSG', 0x4000);
  cpu.R[0] = 0x3c00; cpu.R[1] = 0; cpu.R[2] = 0x4000; int21();
  const w = cpu.R[0] & 0xffff;
  mem.set(new TextEncoder().encode('saved!'), 0x5000);
  cpu.R[0] = 0x4000; cpu.R[3] = w; cpu.R[1] = 6; cpu.R[2] = 0x5000; int21();
  assert.deepEqual(written, [], 'nothing is handed over while the file is open');
  cpu.R[0] = 0x3e00; cpu.R[3] = w; int21();
  assert.deepEqual(written, [['DOOMSAV0.DSG', 'saved!']]);
  name('NOPE.WAD', 0x4000);
  cpu.R[0] = 0x3d00; cpu.R[2] = 0x4000; int21();
  assert.equal(cpu.flags & 1, 1, 'a missing file is a carry and an error code');
  assert.equal(cpu.R[0] & 0xffff, 2);
});

test('DPMI memory: blocks are allocated, reported, freed and reused', () => {
  const pc = createPC();
  const { cpu, mem } = pc;
  const int31 = () => { mem.set([0xcd, 0x31, 0xf4], 0x2000); cpu.eip = 0x2000; cpu.run(2); };
  cpu.R[0] = 0x0500; cpu.R[7] = 0x6000; int31();
  const free0 = mem[0x6000] | (mem[0x6001] << 8) | (mem[0x6002] << 16) | (mem[0x6003] << 24);
  assert.ok(free0 > 20 * 1024 * 1024, 'most of 32 MB is free before the program asks');
  cpu.R[0] = 0x0501; cpu.R[3] = 0x80; cpu.R[1] = 0; int31();   // 8 MB
  const base = ((cpu.R[3] & 0xffff) << 16) | (cpu.R[1] & 0xffff);
  const handle = ((cpu.R[6] & 0xffff) << 16) | (cpu.R[7] & 0xffff);
  assert.ok(base >= 0x300000 && base + 0x800000 <= MEM_SIZE);
  cpu.R[0] = 0x0502; cpu.R[6] = handle >> 16; cpu.R[7] = handle & 0xffff; int31();
  assert.equal(cpu.flags & 1, 0);
  cpu.R[0] = 0x0501; cpu.R[3] = 0x80; cpu.R[1] = 0; int31();
  assert.equal(((cpu.R[3] & 0xffff) << 16) | (cpu.R[1] & 0xffff), base, 'the freed block is the first fit again');
});

test('the keyboard: a scancode raises IRQ1 and waits on port 60h for the handler', () => {
  let t = 0;
  const pc = createPC({ now: () => t });
  const { cpu, mem } = pc;
  // handler: in al,60h ; mov [0x600],al ; mov al,20h ; out 20h,al ; iret
  mem.set([0xe4, 0x60, 0xa2, 0x00, 0x06, 0x00, 0x00, 0xb0, 0x20, 0xe6, 0x20, 0xcf], 0x3000);
  cpu.R[0] = 0x0205; cpu.R[3] = 9; cpu.R[1] = 8; cpu.R[2] = 0x3000;
  mem.set([0xcd, 0x31, 0xfb, 0xeb, 0xfe], 0x2000);
  cpu.eip = 0x2000;
  pc.pic.mask[0] = 0xfd;
  pc.run(10);
  pc.key(0x1e);
  pc.run(50);
  assert.equal(mem[0x600], 0x1e, 'A went down');
  pc.key(0x9e);
  pc.run(50);
  assert.equal(mem[0x600], 0x9e, 'and came up');
});

// ------------------------------------------------------------------ the Sound Blaster
function cardOn() {
  const mem = new Uint8Array(0x100000);
  const irqs = [];
  const card = createSoundCard({ mem, rate: 11025 });
  return { mem, card, irqs, raise: (n) => irqs.push(n) };
}

test('the DSP answers the reset handshake and its version, and forces an interrupt on request', () => {
  const { card, irqs, raise } = cardOn();
  card.portOut(0x226, 1); card.portOut(0x226, 0);
  assert.equal(card.portIn(0x22e) & 0x80, 0x80, 'data waiting');
  assert.equal(card.portIn(0x22a), 0xaa, 'the reset byte');
  card.portOut(0x22c, 0xe1);
  assert.deepEqual([card.portIn(0x22a), card.portIn(0x22a)], [3, 2], 'a Sound Blaster Pro 2');
  card.portOut(0x22c, 0xf2);
  card.tick(0, raise);
  assert.deepEqual(irqs, [7], 'IRQ 7, the one a driver probes for');
});

test('DMA playback: samples come out of memory at the DSP rate, and the block ends in an interrupt', () => {
  const { mem, card, irqs, raise } = cardOn();
  for (let i = 0; i < 2205; i++) mem[0x20000 + i] = i % 2 ? 255 : 0;       // a loud square
  // DMA channel 1: mask, mode single-cycle playback, address 0x20000, count 2204
  card.portOut(0x0a, 0x05); card.portOut(0x0c, 0); card.portOut(0x0b, 0x49);
  card.portOut(0x02, 0x00); card.portOut(0x02, 0x00); card.portOut(0x83, 0x02);
  card.portOut(0x03, 2204 & 0xff); card.portOut(0x03, 2204 >> 8);
  card.portOut(0x0a, 0x01);
  card.portOut(0x22c, 0xd1);                            // speaker on
  card.portOut(0x22c, 0x40); card.portOut(0x22c, 256 - Math.round(1e6 / 11025));
  card.portOut(0x22c, 0x14); card.portOut(0x22c, 2204 & 0xff); card.portOut(0x22c, 2204 >> 8);
  card.tick(0, raise);
  card.tick(100, raise);
  assert.deepEqual(irqs, [], 'a fifth of a second of samples is not done after a tenth');
  const out = card.drain();
  assert.ok(out.length / 2 >= 1100 && out.length / 2 <= 1103, `100 ms at 11025 Hz, got ${out.length / 2} frames`);
  assert.ok(Math.max(...out) > 0.5 && Math.min(...out) < -0.5, 'the square is in the output');
  card.tick(210, raise);
  assert.deepEqual(irqs, [7], 'the interrupt at the end of the block');
});

test('the OPL is detected the way drivers detect it, and a keyed note sounds at its F-number', () => {
  const { card, raise } = cardOn();
  const reg = (r, v) => { card.portOut(0x388, r); card.portOut(0x389, v); };
  reg(4, 0x60); reg(4, 0x80);
  const s1 = card.portIn(0x388);
  reg(2, 0xff); reg(4, 0x21);
  const s2 = card.portIn(0x388);
  reg(4, 0x60); reg(4, 0x80);
  assert.equal(s1 & 0xe0, 0, 'flags clear after the reset');
  assert.equal(s2 & 0xe0, 0xc0, 'timer 1 expired once started');
  // an organ tone on channel 0: carrier only, full level, instant attack, sustained
  reg(0x20, 0x01); reg(0x23, 0x21); reg(0x40, 0x3f); reg(0x43, 0x00);
  reg(0x60, 0xf0); reg(0x63, 0xf0); reg(0x80, 0x00); reg(0x83, 0x00); reg(0xc0, 0x01);
  const fnum = 0x244, block = 4;                        // 0x244 * 2^4 * 49716 / 2^20 = 440 Hz
  reg(0xa0, fnum & 0xff); reg(0xb0, 0x20 | (block << 2) | (fnum >> 8));
  for (let t = 0; t <= 1000; t += 50) card.tick(t, raise);   // the card refuses to replay a long stall as a burst
  const out = card.drain();
  let crossings = 0;
  for (let i = 2; i < out.length; i += 2) if ((out[i - 2] < 0) !== (out[i] < 0)) crossings++;
  const hz = crossings / 2 / (out.length / 2 / 11025);
  assert.ok(Math.abs(hz - 440) < 4, `about 440 Hz, heard ${hz}`);
});

test('OPL envelope times follow the documented scale: a quarter octave faster per rate step', () => {
  assert.equal(oplRateTimes(0).attack, Infinity, 'rate 0 never moves');
  assert.ok(Math.abs(oplRateTimes(4).attack - 2.826) < 0.001);
  assert.ok(Math.abs(oplRateTimes(8).decay * 2 - oplRateTimes(4).decay) < 1e-9, 'four steps is an octave');
  assert.equal(oplRateTimes(60).attack, 0, 'the top rates are instant attacks');
  assert.ok(new Opl3(44100).chans.length === 18, 'two register arrays of nine channels');
});
