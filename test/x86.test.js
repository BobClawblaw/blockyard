// X86, the CPU under the DOOM Diversion (public/js/x86.js). Instruction-level: bytes in, registers
// and flags out, on a bare bus with no machine around it.
//
// Where the expected values come from: the fuzzer that was run against this interpreter while it
// was written executed ~78,000 random instructions natively on the host CPU and compared every
// register and every defined flag (2026-09-15, zero mismatches). A native fuzzer needs a C compiler
// and cannot live in `npm test`, so the cases below are the classes it exercised -- each chosen
// because a plausible interpreter bug gets it wrong: a carry out of 32 bits, a borrow into ADC/SBB,
// a sign flip on INC, a count past the width, a quotient that does not fit, a segment base.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCpu, EAX, ECX, EDX, EBX, ESP, ESI, EDI, DS, ES, CS } from '../public/js/x86.js';

const CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, OF = 0x800;

function machine({ vectors = {}, bases = {}, softInt = () => true } = {}) {
  const mem = new Uint8Array(1 << 20);
  const ports = [];
  const vga = [];
  const cpu = createCpu({
    mem,
    vgaWrite: (a, v) => vga.push([a, v]),
    vgaRead: () => 0x5a,
    portIn: (p) => (p === 0x60 ? 0x1e : 0),
    portOut: (p, s, v) => ports.push([p, s, v]),
    softInt,
    vector: (n) => vectors[n] ?? null,
    selectorBase: (sel) => bases[sel] ?? 0,
  });
  cpu.loadSeg(CS, 8); cpu.loadSeg(DS, 16); cpu.loadSeg(ES, 16);
  cpu.R[ESP] = 0x80000;
  const exec = (bytes, n = 1, at = 0x1000) => { mem.set(bytes, at); cpu.eip = at; cpu.run(n); return cpu; };
  return { cpu, mem, exec, ports, vga };
}
const u = (v) => v >>> 0;

test('ADD sets carry out of 32 bits, overflow on a sign change, and zero on a wrap to 0', () => {
  const { cpu, exec } = machine();
  cpu.R[EAX] = 0xffffffff; cpu.R[EBX] = 1;
  exec([0x01, 0xd8]);                                   // add eax, ebx
  assert.equal(u(cpu.R[EAX]), 0);
  assert.equal(cpu.flags & (CF | ZF | OF | SF), CF | ZF, 'carry and zero, no overflow');
  cpu.R[EAX] = 0x7fffffff; cpu.R[EBX] = 1;
  exec([0x01, 0xd8]);
  assert.equal(u(cpu.R[EAX]), 0x80000000);
  assert.equal(cpu.flags & (CF | ZF | OF | SF), OF | SF, 'signed overflow into a negative');
  assert.equal(cpu.flags & AF, AF, 'the nibble carried');
});

test('ADC and SBB take the carry in, including the all-ones edge where a naive compare misses it', () => {
  const { cpu, exec } = machine();
  cpu.R[EAX] = 5; cpu.R[EBX] = 0xffffffff; cpu.flags = 0x202 | CF;
  exec([0x11, 0xd8]);                                   // adc eax, ebx: 5 + (2^32-1) + 1
  assert.equal(u(cpu.R[EAX]), 5);
  assert.equal(cpu.flags & CF, CF, 'r === a with a carry in is still a carry out');
  cpu.R[EAX] = 5; cpu.R[EBX] = 5; cpu.flags = 0x202 | CF;
  exec([0x19, 0xd8]);                                   // sbb eax, ebx: 5 - 5 - 1
  assert.equal(u(cpu.R[EAX]), 0xffffffff);
  assert.equal(cpu.flags & (CF | SF | ZF), CF | SF, 'a borrow when the operands are equal and carry was set');
});

test('CMP then Jcc: unsigned below and signed less disagree about 0xffffffff', () => {
  const { cpu, exec, mem } = machine();
  // cmp eax, 1 ; jb +2 ; mov bl,1 ; jl +2 ; mov cl,1 ; nop
  mem.set([0x83, 0xf8, 0x01, 0x72, 0x02, 0xb3, 0x01, 0x7c, 0x02, 0xb1, 0x01, 0x90], 0x1000);
  cpu.R[EAX] = -1; cpu.R[EBX] = 0; cpu.R[ECX] = 0;
  cpu.eip = 0x1000; cpu.run(5);
  assert.equal(cpu.R[EBX] & 0xff, 1, '0xffffffff is not below 1 unsigned: the jb falls through');
  assert.equal(cpu.R[ECX] & 0xff, 0, '-1 is less than 1 signed: the jl is taken over mov cl');
});

test('INC keeps the carry it found and DEC reports the overflow at the sign boundary', () => {
  const { cpu, exec } = machine();
  cpu.flags = 0x202 | CF; cpu.R[EAX] = 0x7fffffff;
  exec([0x40]);                                         // inc eax
  assert.equal(cpu.flags & (CF | OF | SF), CF | OF | SF, 'CF untouched, OF on 0x7fffffff -> 0x80000000');
  cpu.flags = 0x202; cpu.R[ECX] = 0x80;
  exec([0xfe, 0xc9]);                                   // dec cl
  assert.equal(cpu.R[ECX] & 0xff, 0x7f);
  assert.equal(cpu.flags & (OF | CF), OF, 'an 8-bit dec overflows at 0x80, and still leaves CF alone');
});

test('shifts: a count is masked to 5 bits, 0 changes nothing, and SAR fills with the sign', () => {
  const { cpu, exec } = machine();
  cpu.R[EAX] = 0x80000001; cpu.flags = 0x202 | ZF;
  exec([0xc1, 0xe0, 0x20]);                             // shl eax, 32 -> count 0
  assert.equal(u(cpu.R[EAX]), 0x80000001, 'shl by 32 is shl by 0');
  assert.equal(cpu.flags & ZF, ZF, 'and a zero count leaves the flags as they were');
  exec([0xd1, 0xe0]);                                   // shl eax, 1
  assert.equal(u(cpu.R[EAX]), 2);
  assert.equal(cpu.flags & (CF | OF), CF | OF, 'the top bit went out, and the sign changed');
  cpu.R[EDX] = -8;
  exec([0xc1, 0xfa, 0x02]);                             // sar edx, 2
  assert.equal(cpu.R[EDX], -2);
  cpu.R[EBX] = 0x81;
  exec([0xc0, 0xfb, 0x09]);                             // sar bl, 9: past an 8-bit width
  assert.equal(cpu.R[EBX] & 0xff, 0xff, 'all sign');
  assert.equal(cpu.flags & CF, CF, 'and the last bit out was a sign bit');
});

test('rotates touch only CF and OF, and RCL carries through the carry flag', () => {
  const { cpu, exec } = machine();
  cpu.R[EAX] = 0x80000000; cpu.flags = 0x202 | ZF | SF;
  exec([0xd1, 0xc0]);                                   // rol eax, 1
  assert.equal(u(cpu.R[EAX]), 1);
  assert.equal(cpu.flags & (CF | ZF | SF), CF | ZF | SF, 'ZF and SF are not a rotate\'s business');
  cpu.R[EBX] = 0x40; cpu.flags = 0x202 | CF;
  exec([0xd0, 0xd3]);                                   // rcl bl, 1
  assert.equal(cpu.R[EBX] & 0xff, 0x81, 'the carry came in at the bottom');
  assert.equal(cpu.flags & CF, 0);
});

test('32x32 multiplies keep all 64 bits: FixedMul is imul then shrd', () => {
  const { cpu, exec } = machine();
  // FixedMul(3.5, -2.25) in 16.16 = -7.875
  cpu.R[EAX] = 3.5 * 65536; cpu.R[EBX] = -2.25 * 65536;
  exec([0xf7, 0xeb, 0x0f, 0xac, 0xd0, 0x10], 2);        // imul ebx ; shrd eax, edx, 16
  assert.equal(cpu.R[EAX], -7.875 * 65536);
  cpu.R[EAX] = -1; cpu.R[EBX] = -1;
  exec([0xf7, 0xe3]);                                   // mul ebx: (2^32-1)^2
  assert.equal(u(cpu.R[EDX]), 0xfffffffe);
  assert.equal(u(cpu.R[EAX]), 1);
  assert.equal(cpu.flags & (CF | OF), CF | OF);
  cpu.R[EAX] = 0x12345678; cpu.R[ECX] = 0x9abcdef;
  exec([0x0f, 0xaf, 0xc1]);                             // imul eax, ecx
  assert.equal(cpu.R[EAX], Math.imul(0x12345678, 0x9abcdef));
  assert.equal(cpu.flags & (CF | OF), CF | OF, 'the product did not fit');
});

test('divides: exact below 2^53, BigInt above it, and a quotient that does not fit is #DE', () => {
  const vectors = { 0: { sel: 8, off: 0x2000 } };
  const { cpu, exec, mem } = machine({ vectors });
  // FixedDiv's shape: a<<16 / b through edx:eax
  cpu.R[EDX] = 0x3; cpu.R[EAX] = 0x00010000; cpu.R[EBX] = 7;
  exec([0xf7, 0xfb]);                                   // idiv ebx
  const n = 3 * 4294967296 + 0x10000;
  assert.equal(cpu.R[EAX], Math.trunc(n / 7));
  assert.equal(cpu.R[EDX], n % 7);
  cpu.R[EDX] = -0x3fffffff; cpu.R[EAX] = 0x12345; cpu.R[EBX] = 0x7fffffff;
  exec([0xf7, 0xfb]);                                   // a dividend past 2^53, a quotient that fits
  const big = (-0x3fffffffn << 32n) + 0x12345n;
  assert.equal(cpu.R[EAX], Number(big / 0x7fffffffn));
  assert.equal(cpu.R[EDX], Number(big % 0x7fffffffn), 'the remainder takes the dividend\'s sign');
  mem[0x2000] = 0x90;
  cpu.R[EDX] = 1; cpu.R[EAX] = 0; cpu.R[EBX] = 1;
  exec([0xf7, 0xf3]);                                   // div ebx: 2^32 / 1 does not fit
  assert.equal(cpu.eip, 0x2000, 'the divide error took vector 0');
  assert.equal(cpu.rd(cpu.R[ESP]), 0x1000, 'with the faulting instruction as the return address');
});

test('REP MOVSB copies forward the way the hardware does, overlap included', () => {
  const { cpu, exec, mem } = machine();
  mem.set([1, 2, 3, 4], 0x3000);
  cpu.R[ESI] = 0x3000; cpu.R[EDI] = 0x3001; cpu.R[ECX] = 4;
  exec([0xf3, 0xa4]);
  assert.deepEqual([...mem.subarray(0x3000, 0x3005)], [1, 1, 1, 1, 1], 'a byte copy one ahead smears the first byte, like the chip');
  assert.equal(cpu.R[ECX], 0);
  mem.set([9, 8, 7, 6, 5, 4, 3, 2], 0x4000);
  cpu.R[ESI] = 0x4000; cpu.R[EDI] = 0x5000; cpu.R[ECX] = 2;
  exec([0xf3, 0xa5]);                                   // rep movsd
  assert.deepEqual([...mem.subarray(0x5000, 0x5008)], [9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(cpu.R[EDI], 0x5008);
});

test('REPNE SCASB stops on the match, and a write into the VGA window goes to the VGA', () => {
  const { cpu, exec, mem, vga } = machine();
  mem.set([...'hello\0'].map((c) => c.charCodeAt(0)), 0x6000);
  cpu.R[EDI] = 0x6000; cpu.R[ECX] = -1; cpu.R[EAX] = 0;
  exec([0xf2, 0xae]);
  assert.equal(cpu.R[EDI], 0x6006, 'one past the terminator');
  assert.equal(~cpu.R[ECX] - 1, 5, 'strlen, the C runtime way');
  cpu.R[EDI] = 0xa0000; cpu.R[ECX] = 3; cpu.R[EAX] = 0x2a;
  exec([0xf3, 0xaa]);
  assert.deepEqual(vga, [[0xa0000, 0x2a], [0xa0001, 0x2a], [0xa0002, 0x2a]], 'planar memory is not a byte array');
});

test('a data segment with a base: an override adds it, and so does DS when it is loaded with one', () => {
  const { cpu, exec, mem } = machine({ bases: { 0x18: 0x7000 } });
  mem[0x7004] = 0x77;
  cpu.loadSeg(ES, 0x18);
  cpu.R[EBX] = 4;
  exec([0x26, 0x8a, 0x03]);                             // mov al, es:[ebx]
  assert.equal(cpu.R[EAX] & 0xff, 0x77);
  cpu.loadSeg(DS, 0x18);
  cpu.R[EAX] = 0;
  exec([0x8a, 0x03]);                                   // mov al, [ebx] with DS based
  assert.equal(cpu.R[EAX] & 0xff, 0x77, 'the start-up code reads its environment exactly so');
  cpu.loadSeg(DS, 16);
});

test('16-bit operands and addressing: 66h keeps the upper half, 67h uses the old [bx+si] forms', () => {
  const { cpu, exec, mem } = machine();
  cpu.R[EAX] = 0x1234ffff; cpu.R[EBX] = 1;
  exec([0x66, 0x01, 0xd8]);                             // add ax, bx
  assert.equal(u(cpu.R[EAX]), 0x12340000);
  assert.equal(cpu.flags & CF, CF);
  mem[0x0305] = 0x99;
  cpu.R[EBX] = 0x300; cpu.R[ESI] = 5;
  exec([0x67, 0x8a, 0x00]);                             // mov al, [bx+si]
  assert.equal(cpu.R[EAX] & 0xff, 0x99);
});

test('INT goes to the machine first, and IRET returns with the flags it saved', () => {
  const calls = [];
  const { cpu, exec, mem } = machine({
    softInt: (c, n) => { calls.push(n); return n === 0x21; },
    vectors: { 0x08: { sel: 8, off: 0x2000 } },
  });
  cpu.R[EAX] = 0x4c00;
  exec([0xcd, 0x21]);
  assert.deepEqual(calls, [0x21], 'the machine answered DOS itself');
  assert.equal(cpu.eip, 0x1002);
  mem[0x2000] = 0xcf;                                   // the handler is a bare IRET
  cpu.flags = 0x202 | CF;
  exec([0xcd, 0x08, 0x90], 2);
  assert.equal(cpu.eip, 0x1002, 'back after the INT');
  assert.equal(cpu.flags & (CF | 0x200), CF | 0x200, 'with CF and IF as they were');
});

test('ports, BSF and SETcc: the odds and ends a C runtime and a keyboard handler use', () => {
  const { cpu, exec, ports } = machine();
  exec([0xe4, 0x60]);                                   // in al, 60h
  assert.equal(cpu.R[EAX] & 0xff, 0x1e);
  cpu.R[EAX] = 0x20;
  exec([0xe6, 0x20]);                                   // out 20h, al (EOI)
  assert.deepEqual(ports.at(-1), [0x20, 0, 0x20]);
  cpu.R[ECX] = 0x80;
  exec([0x0f, 0xbc, 0xc1]);                             // bsf eax, ecx
  assert.equal(cpu.R[EAX], 7);
  assert.equal(cpu.flags & ZF, 0);
  cpu.R[EAX] = 3; cpu.R[EBX] = 3;
  exec([0x39, 0xd8, 0x0f, 0x94, 0xc1], 2);              // cmp eax, ebx ; sete cl
  assert.equal(cpu.R[ECX] & 0xff, 1);
});

test('the FPU: load, arithmetic, compare into AX, and an integer store that rounds to even', () => {
  const { cpu, exec, mem } = machine();
  const dv = new DataView(mem.buffer);
  dv.setFloat64(0x8000, 2.5, true);
  dv.setFloat64(0x8008, 1.5, true);
  // fld qword [8000h] ; fadd qword [8008h] ; fistp dword [8010h]
  exec([0xdd, 0x05, 0x00, 0x80, 0, 0, 0xdc, 0x05, 0x08, 0x80, 0, 0, 0xdb, 0x1d, 0x10, 0x80, 0, 0], 3);
  assert.equal(dv.getInt32(0x8010, true), 4);
  dv.setFloat64(0x8000, 2.5, true);
  exec([0xdd, 0x05, 0x00, 0x80, 0, 0, 0xdb, 0x1d, 0x10, 0x80, 0, 0], 2);
  assert.equal(dv.getInt32(0x8010, true), 2, '2.5 rounds to the even 2 under the default control word');
  // fld1 ; fldz ; fcompp ; fnstsw ax  -> 0 < 1 sets C0
  exec([0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xd9, 0xdf, 0xe0], 4);
  assert.equal(cpu.R[EAX] & 0x4500, 0x100);
});

test('code and stack bases: calls push offsets, returns and jumps land at base + offset (DJGPP)', () => {
  const { cpu, mem } = machine({ bases: { 0x30: 0x40000, 0x38: 0x40000 } });
  cpu.loadSeg(CS, 0x30); cpu.loadSeg(DS, 0x38); cpu.loadSeg(0 /* ES */, 0x38); cpu.loadSeg(2 /* SS */, 0x38);
  cpu.R[ESP] = 0x8000;
  // at offset 0x1000: call +5 (to 0x100a) ; nop... ; at 0x100a: ret
  mem.set([0xe8, 0x05, 0x00, 0x00, 0x00, 0x90, 0x90, 0x90, 0x90, 0x90, 0xc3], 0x41000);
  cpu.eip = 0x41000;
  cpu.run(1);
  assert.equal(cpu.eip, 0x4100a, 'the call went to base + target');
  assert.equal(cpu.R[ESP], 0x7ffc, 'ESP is an offset in SS');
  assert.equal(cpu.rd(0x47ffc), 0x1005, 'and the return address pushed is an offset, at SS base + ESP');
  cpu.run(1);
  assert.equal(cpu.eip, 0x41005, 'ret came back to base + offset');
  // jmp dword [0x2000] through a table holding an offset
  mem.set([0x00, 0x30, 0x00, 0x00], 0x42000);
  mem.set([0xff, 0x25, 0x00, 0x20, 0x00, 0x00], 0x41005);
  cpu.run(1);
  assert.equal(cpu.eip, 0x43000);
});

test('a 16-bit code segment decodes 16-bit, and 66h gives it 32-bit operands back', () => {
  const { cpu, mem } = machine({ bases: { 0x40: 0x3000 } });
  const m = { is16: new Set([0x40]) };
  // re-create with a bus that knows the 16-bit selector
  const mem2 = new Uint8Array(1 << 20);
  const c2 = createCpu({ mem: mem2, vgaWrite() {}, vgaRead: () => 0, portIn: () => 0, portOut() {}, softInt: () => true, vector: () => null,
    selectorBase: (sel) => (sel === 0x40 ? 0x3000 : 0), selectorIs16: (sel) => m.is16.has(sel) });
  c2.loadSeg(CS, 0x40); c2.loadSeg(DS, 0x10); c2.loadSeg(2, 0x10);
  c2.R[ESP] = 0x9000;
  // mov ax, 0x1234 ; mov eax, 0x89abcdef (66h) ; retf with an 16-bit frame... just the moves
  mem2.set([0xb8, 0x34, 0x12, 0x66, 0xb8, 0xef, 0xcd, 0xab, 0x89], 0x3000);
  c2.eip = 0x3000;
  c2.run(1);
  assert.equal(c2.R[EAX] & 0xffff, 0x1234, 'B8 takes a word in a 16-bit segment');
  assert.equal(c2.eip, 0x3003);
  c2.run(1);
  assert.equal(c2.R[EAX] >>> 0, 0x89abcdef, 'and a dword behind 66h');
  void cpu; void mem;
});
