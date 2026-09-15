// X86: an i386 in protected mode, flat, interpreted -- the CPU the DOOM Diversion runs on
// (operator, 2026-09-15: "Get DOOM working as a diversion inside blockyard with zero dependancies").
//
// Our own implementation, written for one job: running a 32-bit DOS-extended program (a Watcom
// build under DOS/4GW) whose world the machine in dospc.js fakes around it. So this is a user-mode
// 386 with a 487 beside it, and deliberately no more: no paging, no privilege rings, no task
// switches, no real mode. Segment registers hold a selector and the base the machine assigns it
// (every flat selector is base 0); an INT, a port and a hardware interrupt are the machine's
// business, handed over through `bus`.
//
// SPEED IS THE WHOLE PROBLEM. DOOM wants about a million instructions a frame, and the page forbids
// eval (CSP `script-src 'self'`), so there is no JIT to hide behind: this interpreter has to run at
// tens of millions of instructions a second on its own. What that cost:
//   - EVERY VALUE IS AN INT32. A 32-bit register, operand or result is a signed int32 in JS (8- and
//     16-bit ones are masked non-negative), and unsigned comparisons flip the sign bit instead of
//     using `>>> 0`. A `>>> 0` above 2^31 is a double, and a double in a closure variable is an
//     allocation: the first cut spent its time in the garbage collector.
//   - FLAGS ARE LAZY. Arithmetic records its operands and result in an Int32Array, and CF/ZF/SF/OF/
//     PF/AF are worked out only when something reads them -- a Jcc, a PUSHF, an ADC. `cond()` reads
//     a cmp's operands directly. Rotates, shifts and multiplies set CF and OF eagerly.
//   - no try/catch around each instruction (it cost 14% on its own); one around the loop.
//   - the instructions a Watcom build is made of (mov, add/sub/cmp with an imm8, jcc, inc/dec) have
//     32-bit paths that skip the size switch.
//
// Memory is one flat Uint8Array; every address is masked to it rather than bounds-checked, so a
// wild pointer reads garbage instead of throwing. Writes into 0xA0000-0xBFFFF go to the machine's
// VGA, which has planes a byte array does not.

const S8 = 0, S16 = 1, S32 = 2;
const MASK = [0xff, 0xffff, -1];
const SIGN = [0x80, 0x8000, -0x80000000];
const BITS = [8, 16, 32];
const FLIP = -0x80000000;               // x ^ FLIP turns an unsigned comparison into a signed one

// lazy flag producers
const F_NONE = 0, F_ADD = 1, F_ADC = 2, F_SUB = 3, F_SBB = 4, F_LOGIC = 5, F_INC = 6, F_DEC = 7, F_EAGER = 8;

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let b = i, p = 1; while (b) { p ^= b & 1; b >>= 1; } PARITY[i] = p; }

const PREFIX = new Uint8Array(256);
for (const p of [0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3]) PREFIX[p] = 1;

export const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
export const ES = 0, CS = 1, SS = 2, DS = 3, FS = 4, GS = 5;

export class CpuFault extends Error {
  constructor(msg, eip) { super(`${msg} at ${(eip >>> 0).toString(16)}`); this.eip = eip; }
}
class DivFault extends Error {}

/**
 * The CPU. `bus` supplies:
 *   mem: Uint8Array (a power-of-two length, at least 1 MB)
 *   vgaWrite(addr, byte), vgaRead(addr)
 *   portIn(port, size) -> value, portOut(port, size, value)     size: 0 byte, 1 word, 2 dword
 *   softInt(cpu, n) -> true when the machine handled INT n itself (else its vector is taken)
 *   vector(n) -> { sel, off }: where INT n (or IRQ) goes when the machine does not handle it
 *   selectorBase(sel) -> the linear base of a selector loaded into a segment register
 */
export function createCpu(bus) {
  const M = bus.mem;
  const M32 = new Int32Array(M.buffer, M.byteOffset, M.length >> 2);
  const M16 = new Uint16Array(M.buffer, M.byteOffset, M.length >> 1);
  const AMASK = M.length - 1;
  const R = new Int32Array(8);
  const seg = new Uint16Array(6);
  const segBase = new Int32Array(6);
  const LF = new Int32Array(3);          // lazy flags: operand a, operand b, result

  let eip = 0;
  let flags = 0x202;                    // DF, IF, TF always; CF..OF too while fOp is F_NONE
  let fOp = F_NONE, fSz = S32, fCF = 0, fOF = 0;
  let halted = false;
  let cycles = 0;
  let opEip = 0, os = S32, as32 = true, segOv = -1, rep = 0;
  let stop = false;
  let defBases = false;                 // DS or SS has a base other than 0
  // CODE AND STACK BASES. EIP is kept LINEAR (fetch never adds a base); what the program sees -- a
  // return address pushed, a jump target loaded -- is an offset from CS's base, converted at the
  // edges. ESP is an offset from SS's base. Both are 0 under DOS/4GW; a DJGPP program's segments
  // start at its memory block.
  let csb = 0, ssb = 0;
  let splitBases = false;               // DS and SS have different bases
  // a 16-bit code segment (its descriptor's D bit clear) decodes with 16-bit operands and addresses
  // unless a prefix says otherwise: DJGPP's start-up copies a small 16-bit helper into DOS memory
  let cs16 = false;

  // ------------------------------------------------------------------ memory
  const rb = (a) => M[a & AMASK];
  function rw(a) { a &= AMASK; return (a & 1) === 0 ? M16[a >> 1] : M[a] | (M[(a + 1) & AMASK] << 8); }
  function rd(a) { a &= AMASK; return (a & 3) === 0 ? M32[a >> 2] : (M[a] | (M[(a + 1) & AMASK] << 8) | (M[(a + 2) & AMASK] << 16) | (M[(a + 3) & AMASK] << 24)); }
  function rbx(a) { a &= AMASK; return (a - 0xa0000) >>> 0 < 0x20000 ? bus.vgaRead(a) : M[a]; }
  function wb(a, v) {
    a &= AMASK;
    if ((a - 0xa0000) >>> 0 < 0x20000) { bus.vgaWrite(a, v & 0xff); return; }
    M[a] = v;
  }
  function ww(a, v) {
    a &= AMASK;
    if ((a - 0x9ffff) >>> 0 < 0x20001) { wb(a, v); wb(a + 1, v >> 8); return; }
    if ((a & 1) === 0) M16[a >> 1] = v; else { M[a] = v; M[(a + 1) & AMASK] = v >> 8; }
  }
  function wd(a, v) {
    a &= AMASK;
    if ((a - 0x9fffd) >>> 0 < 0x20003) { wb(a, v); wb(a + 1, v >> 8); wb(a + 2, v >> 16); wb(a + 3, v >> 24); return; }
    if ((a & 3) === 0) M32[a >> 2] = v;
    else { M[a] = v; M[(a + 1) & AMASK] = v >> 8; M[(a + 2) & AMASK] = v >> 16; M[(a + 3) & AMASK] = v >> 24; }
  }
  const isVga = (a) => ((a & AMASK) - 0xa0000) >>> 0 < 0x20000;

  // ------------------------------------------------------------------ fetch
  function f8s() { return (M[eip++] << 24) >> 24; }
  function f16() { const v = M[eip] | (M[eip + 1] << 8); eip += 2; return v; }
  function f32() { const v = M[eip] | (M[eip + 1] << 8) | (M[eip + 2] << 16) | (M[eip + 3] << 24); eip += 4; return v; }
  function fImm(s) { return s === S32 ? f32() : s === S16 ? f16() : M[eip++]; }

  // ------------------------------------------------------------------ registers
  function get8(i) { return i < 4 ? R[i] & 0xff : (R[i - 4] >> 8) & 0xff; }
  function set8(i, v) { if (i < 4) R[i] = (R[i] & ~0xff) | (v & 0xff); else R[i - 4] = (R[i - 4] & ~0xff00) | ((v & 0xff) << 8); }
  function getR(s, i) { return s === S32 ? R[i] : s === S16 ? R[i] & 0xffff : get8(i); }
  function setR(s, i, v) { if (s === S32) R[i] = v; else if (s === S16) R[i] = (R[i] & ~0xffff) | (v & 0xffff); else set8(i, v); }

  // ------------------------------------------------------------------ flags
  function getCF() {
    switch (fOp) {
      case F_NONE: return flags & 1;
      case F_ADD: return (LF[2] ^ FLIP) < (LF[0] ^ FLIP) ? 1 : 0;
      case F_ADC: return (LF[2] ^ FLIP) < (LF[0] ^ FLIP) || (fCF && LF[2] === LF[0]) ? 1 : 0;
      case F_SUB: return (LF[0] ^ FLIP) < (LF[1] ^ FLIP) ? 1 : 0;
      case F_SBB: return (LF[0] ^ FLIP) < (LF[1] ^ FLIP) || (fCF && LF[0] === LF[1]) ? 1 : 0;
      case F_LOGIC: return 0;
      default: return fCF;
    }
  }
  function getOF() {
    switch (fOp) {
      case F_NONE: return (flags >> 11) & 1;
      case F_ADD: case F_ADC: return ((LF[0] ^ LF[2]) & (LF[1] ^ LF[2]) & SIGN[fSz]) !== 0 ? 1 : 0;
      case F_SUB: case F_SBB: return ((LF[0] ^ LF[1]) & (LF[0] ^ LF[2]) & SIGN[fSz]) !== 0 ? 1 : 0;
      case F_LOGIC: return 0;
      case F_INC: return LF[2] === SIGN[fSz] ? 1 : 0;
      case F_DEC: return LF[2] === ((SIGN[fSz] - 1) | 0) ? 1 : 0;
      default: return fOF;
    }
  }
  function getZF() { return fOp === F_NONE ? (flags >> 6) & 1 : LF[2] === 0 ? 1 : 0; }
  function getSF() { return fOp === F_NONE ? (flags >> 7) & 1 : (LF[2] & SIGN[fSz]) !== 0 ? 1 : 0; }
  function getPF() { return fOp === F_NONE ? (flags >> 2) & 1 : PARITY[LF[2] & 0xff]; }
  function getAF() {
    switch (fOp) {
      case F_NONE: return (flags >> 4) & 1;
      case F_ADD: case F_ADC: case F_SUB: case F_SBB: case F_INC: case F_DEC: return (LF[0] ^ LF[1] ^ LF[2]) & 0x10 ? 1 : 0;
      default: return 0;
    }
  }
  function getFlags() {
    if (fOp === F_NONE) return (flags & 0x3f7fd7) | 2;
    return (flags & 0x3f772a) | 2 | getCF() | (getPF() << 2) | (getAF() << 4) | (getZF() << 6) | (getSF() << 7) | (getOF() << 11);
  }
  function setFlags(v) { flags = (v & 0x3f7fd7) | 2; fOp = F_NONE; }
  function setCFbit(c) { flags = (getFlags() & ~1) | (c & 1); fOp = F_NONE; }
  function setCFOF(c, o) { flags = (getFlags() & ~0x801) | (c & 1) | ((o & 1) << 11); fOp = F_NONE; }
  function zfSet(z) { flags = (getFlags() & ~0x40) | ((z & 1) << 6); fOp = F_NONE; }

  function cond(c) {
    if (fOp === F_SUB) {
      const a = LF[0], b = LF[1];
      switch (c) {
        case 2: return (a ^ FLIP) < (b ^ FLIP);
        case 3: return (a ^ FLIP) >= (b ^ FLIP);
        case 4: return a === b;
        case 5: return a !== b;
        case 6: return (a ^ FLIP) <= (b ^ FLIP);
        case 7: return (a ^ FLIP) > (b ^ FLIP);
        case 0xc: case 0xd: case 0xe: case 0xf: {
          let x = a, y = b;
          if (fSz !== S32) { const sh = fSz === S8 ? 24 : 16; x = (a << sh) >> sh; y = (b << sh) >> sh; }
          return c === 0xc ? x < y : c === 0xd ? x >= y : c === 0xe ? x <= y : x > y;
        }
      }
    } else if (fOp === F_LOGIC || fOp === F_INC || fOp === F_DEC) {
      switch (c) {
        case 4: return LF[2] === 0;
        case 5: return LF[2] !== 0;
      }
    }
    switch (c) {
      case 0: return getOF() === 1;
      case 1: return getOF() === 0;
      case 2: return getCF() === 1;
      case 3: return getCF() === 0;
      case 4: return getZF() === 1;
      case 5: return getZF() === 0;
      case 6: return (getCF() | getZF()) === 1;
      case 7: return (getCF() | getZF()) === 0;
      case 8: return getSF() === 1;
      case 9: return getSF() === 0;
      case 0xa: return getPF() === 1;
      case 0xb: return getPF() === 0;
      case 0xc: return getSF() !== getOF();
      case 0xd: return getSF() === getOF();
      case 0xe: return getZF() === 1 || getSF() !== getOF();
      default: return getZF() === 0 && getSF() === getOF();
    }
  }

  // ------------------------------------------------------------------ arithmetic
  // operands arrive as the size's convention (int32, or masked non-negative) and results leave so
  function alu32(op, a, b) {
    let r;
    switch (op) {
      case 0: r = (a + b) | 0; fOp = F_ADD; break;
      case 1: r = a | b; fOp = F_LOGIC; break;
      case 2: { const c = getCF(); r = (a + b + c) | 0; fCF = c; fOp = F_ADC; break; }
      case 3: { const c = getCF(); r = (a - b - c) | 0; fCF = c; fOp = F_SBB; break; }
      case 4: r = a & b; fOp = F_LOGIC; break;
      case 5: case 7: r = (a - b) | 0; fOp = F_SUB; break;
      default: r = a ^ b; fOp = F_LOGIC; break;
    }
    LF[0] = a; LF[1] = b; LF[2] = r; fSz = S32;
    return r;
  }
  function arith(op, a, b, s) {
    if (s === S32) return alu32(op, a, b);
    const m = MASK[s];
    let r;
    switch (op) {
      case 0: r = (a + b) & m; fOp = F_ADD; break;
      case 1: r = a | b; fOp = F_LOGIC; break;
      case 2: { const c = getCF(); r = (a + b + c) & m; fCF = c; fOp = F_ADC; break; }
      case 3: { const c = getCF(); r = (a - b - c) & m; fCF = c; fOp = F_SBB; break; }
      case 4: r = a & b; fOp = F_LOGIC; break;
      case 5: case 7: r = (a - b) & m; fOp = F_SUB; break;
      default: r = a ^ b; fOp = F_LOGIC; break;
    }
    LF[0] = a; LF[1] = b; LF[2] = r; fSz = s;
    return r;
  }
  function inc(v, s) { fCF = getCF(); const r = (v + 1) & MASK[s]; LF[0] = v; LF[1] = 1; LF[2] = r; fSz = s; fOp = F_INC; return r; }
  function dec(v, s) { fCF = getCF(); const r = (v - 1) & MASK[s]; LF[0] = v; LF[1] = 1; LF[2] = r; fSz = s; fOp = F_DEC; return r; }
  function logicFlags(r, s) { LF[2] = r; fSz = s; fOp = F_LOGIC; }
  function eager(r, s, c, o) { LF[2] = r; fSz = s; fCF = c; fOF = o; fOp = F_EAGER; }

  function shift(op, v, cnt, s) {
    cnt &= 31;
    if (cnt === 0) return v;
    const bits = BITS[s], m = MASK[s], top = bits - 1;
    let r;
    switch (op) {
      case 0: { // ROL
        const c = cnt % bits;
        r = c === 0 ? v : ((v << c) | (v >>> (bits - c))) & m;
        setCFOF(r & 1, ((r >>> top) & 1) ^ (r & 1));
        return r;
      }
      case 1: { // ROR
        const c = cnt % bits;
        r = c === 0 ? v : ((v >>> c) | (v << (bits - c))) & m;
        setCFOF((r >>> top) & 1, ((r >>> top) ^ (r >>> (top - 1))) & 1);
        return r;
      }
      case 2: { // RCL
        let c = cnt % (bits + 1), cf = getCF();
        r = v;
        while (c-- > 0) { const n = (r >>> top) & 1; r = ((r << 1) | cf) & m; cf = n; }
        setCFOF(cf, ((r >>> top) & 1) ^ cf);
        return r;
      }
      case 3: { // RCR
        let c = cnt % (bits + 1), cf = getCF();
        r = v;
        while (c-- > 0) { const n = r & 1; r = ((r >>> 1) | (cf << top)) & m; cf = n; }
        setCFOF(cf, ((r >>> top) ^ (r >>> (top - 1))) & 1);
        return r;
      }
      case 4: case 6: { // SHL
        r = cnt >= bits ? 0 : (v << cnt) & m;
        const cf = cnt > bits ? 0 : (v >>> (bits - cnt)) & 1;
        eager(r, s, cf, ((r >>> top) & 1) ^ cf);
        return r;
      }
      case 5: { // SHR
        r = cnt >= bits ? 0 : (v >>> cnt) & m;
        const cf = cnt > bits ? 0 : (v >>> (cnt - 1)) & 1;
        eager(r, s, cf, (v >>> top) & 1);
        return r;
      }
      default: { // SAR
        const sv = s === S32 ? v : s === S16 ? (v << 16) >> 16 : (v << 24) >> 24;
        r = (sv >> cnt) & m;
        eager(r, s, (sv >> (Math.min(cnt, bits) - 1)) & 1, 0);
        return r;
      }
    }
  }

  // 32x32 products without losing bits to doubles
  let mulHi = 0;
  function mulu32(a, b) {
    const aL = a & 0xffff, aH = a >>> 16, bL = b & 0xffff, bH = b >>> 16;
    const ll = aL * bL, lh = aL * bH, hl = aH * bL, hh = aH * bH;
    const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
    mulHi = (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) | 0;
    return (mid << 16) | (ll & 0xffff);
  }
  function muls32(a, b) {
    const p = a * b;
    if (p < 9007199254740992 && p > -9007199254740992) {
      mulHi = Math.floor(p / 4294967296) | 0;
      return p | 0;
    }
    const lo = mulu32(a, b);
    let hi = mulHi;
    if (a < 0) hi = (hi - b) | 0;
    if (b < 0) hi = (hi - a) | 0;
    mulHi = hi;
    return lo;
  }

  function grp3(sub, s) {
    const v = loadE(s);
    switch (sub) {
      case 0: case 1: logicFlags(v & fImm(s), s); return;
      case 2: storeE(s, ~v & MASK[s]); return;
      case 3: storeE(s, arith(5, 0, v, s)); return;
      case 4: { // MUL
        if (s === S8) { const p = (R[EAX] & 0xff) * v; R[EAX] = (R[EAX] & ~0xffff) | p; const o = p > 0xff ? 1 : 0; eager(p & 0xff, s, o, o); }
        else if (s === S16) { const p = (R[EAX] & 0xffff) * v; setR(S16, EAX, p); setR(S16, EDX, p >>> 16); const o = p > 0xffff ? 1 : 0; eager(p & 0xffff, s, o, o); }
        else { const lo = mulu32(R[EAX], v); R[EAX] = lo; R[EDX] = mulHi; const o = mulHi !== 0 ? 1 : 0; eager(lo, s, o, o); }
        return;
      }
      case 5: { // IMUL
        if (s === S8) { const p = ((R[EAX] << 24) >> 24) * ((v << 24) >> 24); R[EAX] = (R[EAX] & ~0xffff) | (p & 0xffff); const o = p !== ((p << 24) >> 24) ? 1 : 0; eager(p & 0xff, s, o, o); }
        else if (s === S16) { const p = ((R[EAX] << 16) >> 16) * ((v << 16) >> 16); setR(S16, EAX, p); setR(S16, EDX, p >> 16); const o = p !== ((p << 16) >> 16) ? 1 : 0; eager(p & 0xffff, s, o, o); }
        else { const lo = muls32(R[EAX], v); R[EAX] = lo; R[EDX] = mulHi; const o = mulHi !== (lo >> 31) ? 1 : 0; eager(lo, s, o, o); }
        return;
      }
      case 6: { // DIV
        if (v === 0) throw new DivFault();
        if (s === S8) { const n = R[EAX] & 0xffff, q = Math.floor(n / v); if (q > 0xff) throw new DivFault(); R[EAX] = (R[EAX] & ~0xffff) | ((n % v) << 8) | q; }
        else if (s === S16) { const n = (R[EDX] & 0xffff) * 65536 + (R[EAX] & 0xffff), q = Math.floor(n / v); if (q > 0xffff) throw new DivFault(); setR(S16, EAX, q); setR(S16, EDX, n % v); }
        else {
          const hi = R[EDX] >>> 0, lo = R[EAX] >>> 0, d = v >>> 0;
          if (hi >= d) throw new DivFault();
          if (hi < 0x200000) { const n = hi * 4294967296 + lo, q = Math.floor(n / d); R[EAX] = q; R[EDX] = n - q * d; }
          else { const n = (BigInt(hi) << 32n) | BigInt(lo), bd = BigInt(d); R[EAX] = Number(n / bd); R[EDX] = Number(n % bd); }
        }
        return;
      }
      default: { // IDIV
        if (v === 0) throw new DivFault();
        if (s === S8) {
          const n = (R[EAX] << 16) >> 16, d = (v << 24) >> 24, q = Math.trunc(n / d);
          if (q > 127 || q < -128) throw new DivFault();
          R[EAX] = (R[EAX] & ~0xffff) | (((n - q * d) & 0xff) << 8) | (q & 0xff);
        } else if (s === S16) {
          const n = (R[EDX] << 16) | (R[EAX] & 0xffff), d = (v << 16) >> 16, q = Math.trunc(n / d);
          if (q > 32767 || q < -32768) throw new DivFault();
          setR(S16, EAX, q); setR(S16, EDX, n - q * d);
        } else {
          const hi = R[EDX], lo = R[EAX] >>> 0;
          if (hi >= -0x200000 && hi < 0x200000) {
            const n = hi * 4294967296 + lo, q = Math.trunc(n / v);
            if (q > 2147483647 || q < -2147483648) throw new DivFault();
            R[EAX] = q; R[EDX] = n - q * v;
          } else {
            const n = (BigInt(hi) << 32n) | BigInt(lo), bd = BigInt(v), q = n / bd;
            if (q > 2147483647n || q < -2147483648n) throw new DivFault();
            R[EAX] = Number(q); R[EDX] = Number(n % bd);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ addressing
  let mrm = 0;
  let eaddr = 0;
  function ea() {
    const mod = mrm >> 6, rm = mrm & 7;
    let a;
    if (as32) {
      let baseReg = -1;
      if (rm === 4) {
        const sib = M[eip++], base = sib & 7, idx = (sib >> 3) & 7;
        a = idx === 4 ? 0 : R[idx] << (sib >> 6);
        if (base === 5 && mod === 0) a = (a + f32()) | 0; else { a = (a + R[base]) | 0; baseReg = base; }
      } else if (rm === 5 && mod === 0) a = f32();
      else { a = R[rm]; baseReg = rm; }
      if (mod === 1) a = (a + ((M[eip++] << 24) >> 24)) | 0; else if (mod === 2) a = (a + f32()) | 0;
      if (segOv >= 0) return (a + segBase[segOv]) | 0;
      // DS and SS with a base: one addition when they share it (DJGPP's always do), and the stack's
      // for an [esp]/[ebp] base only when they differ (the C runtime's start-up, for a moment)
      if (defBases) a = (a + (splitBases && (baseReg === ESP || baseReg === EBP) ? segBase[SS] : segBase[DS])) | 0;
      return a;
    }
    switch (rm) {
      case 0: a = R[EBX] + R[ESI]; break;
      case 1: a = R[EBX] + R[EDI]; break;
      case 2: a = R[EBP] + R[ESI]; break;
      case 3: a = R[EBP] + R[EDI]; break;
      case 4: a = R[ESI]; break;
      case 5: a = R[EDI]; break;
      case 6: a = mod === 0 ? f16() : R[EBP]; break;
      default: a = R[EBX]; break;
    }
    if (mod === 1) a += f8s(); else if (mod === 2) a += f16();
    a &= 0xffff;
    if (segOv >= 0) return (a + segBase[segOv]) | 0;
    if (defBases) a += (rm === 2 || rm === 3 || (rm === 6 && mod !== 0)) ? segBase[SS] : segBase[DS];
    return a | 0;
  }
  function loadE(s) {
    if (mrm >= 0xc0) return getR(s, mrm & 7);
    eaddr = ea();
    return s === S32 ? rd(eaddr) : s === S16 ? rw(eaddr) : rbx(eaddr);
  }
  // write back to the operand loadE just read (no second decode)
  function storeE(s, v) {
    if (mrm >= 0xc0) { setR(s, mrm & 7, v); return; }
    if (s === S32) wd(eaddr, v); else if (s === S16) ww(eaddr, v); else wb(eaddr, v);
  }
  function writeE(s, v) {
    if (mrm >= 0xc0) { setR(s, mrm & 7, v); return; }
    eaddr = ea();
    if (s === S32) wd(eaddr, v); else if (s === S16) ww(eaddr, v); else wb(eaddr, v);
  }

  // ------------------------------------------------------------------ stack
  function push(v) { const sp = (R[ESP] - 4) | 0; R[ESP] = sp; wd(sp + ssb, v); }
  function pop() { const sp = R[ESP]; R[ESP] = (sp + 4) | 0; return rd(sp + ssb); }
  function pushS(s, v) { if (s === S16) { R[ESP] -= 2; ww(R[ESP] + ssb, v); } else push(v); }
  function popS(s) { if (s === S16) { const v = rw(R[ESP] + ssb); R[ESP] += 2; return v; } return pop(); }

  function loadSeg(i, sel) {
    seg[i] = sel & 0xffff;
    segBase[i] = bus.selectorBase(sel & 0xffff);
    defBases = segBase[DS] !== 0 || segBase[SS] !== 0;
    csb = segBase[CS]; ssb = segBase[SS];
    splitBases = segBase[DS] !== segBase[SS];
    if (i === CS) cs16 = bus.selectorIs16?.(sel & 0xffff) === true;
  }

  // ------------------------------------------------------------------ interrupts
  function interrupt(n, retEip) {
    const v = bus.vector(n);
    if (!v) throw new CpuFault(`no handler for INT ${n.toString(16)}`, opEip);
    push(getFlags());
    push(seg[CS]);
    push((retEip - csb) | 0);
    flags &= ~0x300;                   // IF and TF off in the handler
    loadSeg(CS, v.sel);
    eip = (v.off + csb) >>> 0;
  }
  function softInt(n) {
    if (bus.softInt(api, n)) return;
    interrupt(n, eip);
  }

  // ------------------------------------------------------------------ string ops
  function stringOp(op) {
    const s = op & 1 ? os : S8;
    const n = s === S32 ? 4 : s === S16 ? 2 : 1;
    const d = (flags & 0x400) ? -n : n;
    const cntReg = as32 ? R[ECX] >>> 0 : R[ECX] & 0xffff;
    const srcBase = segOv >= 0 ? segBase[segOv] : segBase[DS];
    const esb = segBase[ES];
    const setCount = (c) => { if (as32) R[ECX] = c; else R[ECX] = (R[ECX] & ~0xffff) | c; };
    const readS = (a) => (s === S32 ? rd(a) : s === S16 ? rw(a) : rbx(a));
    const writeS = (a, v) => { if (s === S32) wd(a, v); else if (s === S16) ww(a, v); else wb(a, v); };
    // a block that touches neither the VGA window nor the end of memory can be moved in one call
    const plain = (a, len) => a + len <= M.length && (a + len <= 0xa0000 || a >= 0xc0000);
    switch (op) {
      case 0xa4: case 0xa5: { // MOVS
        if (rep) {
          let c = cntReg, si = R[ESI], di = R[EDI];
          const src = (si + srcBase) & AMASK, dst = (di + esb) & AMASK, len = c * n;
          if (d > 0 && len > 0 && plain(dst, len) && src + len <= M.length && (dst <= src || dst >= src + len)) {
            M.copyWithin(dst, src, src + len);
            R[ESI] = si + len; R[EDI] = di + len; setCount(0);
            return;
          }
          while (c > 0) { writeS(di + esb, readS(si + srcBase)); si += d; di += d; c--; }
          R[ESI] = si; R[EDI] = di; setCount(0);
        } else {
          writeS(R[EDI] + esb, readS(R[ESI] + srcBase)); R[ESI] += d; R[EDI] += d;
        }
        return;
      }
      case 0xaa: case 0xab: { // STOS
        const v = getR(s, EAX);
        if (rep) {
          let c = cntReg, di = R[EDI];
          const dst = (di + esb) & AMASK, len = c * n;
          if (s === S8 && d > 0 && len > 0 && plain(dst, len)) {
            M.fill(v, dst, dst + len); R[EDI] = di + len; setCount(0); return;
          }
          while (c > 0) { writeS(di + esb, v); di += d; c--; }
          R[EDI] = di; setCount(0);
        } else { writeS(R[EDI] + esb, v); R[EDI] += d; }
        return;
      }
      case 0xac: case 0xad: { // LODS
        if (rep) { let c = cntReg; while (c > 0) { setR(s, EAX, readS(R[ESI] + srcBase)); R[ESI] += d; c--; } setCount(0); }
        else { setR(s, EAX, readS(R[ESI] + srcBase)); R[ESI] += d; }
        return;
      }
      case 0xa6: case 0xa7: { // CMPS
        if (rep) {
          let c = cntReg;
          while (c > 0) {
            arith(7, readS(R[ESI] + srcBase), readS(R[EDI] + esb), s);
            R[ESI] += d; R[EDI] += d; c--;
            if ((rep === 0xf3) !== (getZF() === 1)) break;
          }
          setCount(c);
        } else { arith(7, readS(R[ESI] + srcBase), readS(R[EDI] + esb), s); R[ESI] += d; R[EDI] += d; }
        return;
      }
      case 0xae: case 0xaf: { // SCAS
        const v = getR(s, EAX);
        if (rep) {
          let c = cntReg;
          while (c > 0) {
            arith(7, v, readS(R[EDI] + esb), s);
            R[EDI] += d; c--;
            if ((rep === 0xf3) !== (getZF() === 1)) break;
          }
          setCount(c);
        } else { arith(7, v, readS(R[EDI] + esb), s); R[EDI] += d; }
        return;
      }
      case 0x6c: case 0x6d: { // INS
        let c = rep ? cntReg : 1;
        while (c > 0) { writeS(R[EDI] + esb, bus.portIn(R[EDX] & 0xffff, s)); R[EDI] += d; c--; }
        if (rep) setCount(0);
        return;
      }
      default: { // OUTS
        let c = rep ? cntReg : 1;
        while (c > 0) { bus.portOut(R[EDX] & 0xffff, s, readS(R[ESI] + srcBase)); R[ESI] += d; c--; }
        if (rep) setCount(0);
      }
    }
  }

  // ------------------------------------------------------------------ the FPU
  // An x87, in doubles. DOOM's C runtime only probes for one; Quake does its geometry, its lighting
  // and a divide every sixteen pixels of every span in floating point, so this sits on the hot path
  // too: the stack is a Float64Array indexed from `ftop`, and memory operands are converted through
  // typed-array views of one scratch buffer rather than a DataView. Precision control is not modelled
  // (every result is a double); rounding control is, because fist/fistp depend on it.
  const ST = new Float64Array(8);
  let ftop = 0, fcw = 0x37f, fsw = 0, ftag = 0xffff;
  const scratch = new ArrayBuffer(8);
  const sI32 = new Int32Array(scratch), sF32 = new Float32Array(scratch, 0, 1), sF64 = new Float64Array(scratch);
  const K_F32 = 0, K_F64 = 1, K_I16 = 2, K_I32 = 3, K_I64 = 4, K_F80 = 5;
  function fpush(v) { ftop = (ftop - 1) & 7; ST[ftop] = v; ftag &= ~(3 << (ftop * 2)); }
  function fpop() { const v = ST[ftop]; ftag |= 3 << (ftop * 2); ftop = (ftop + 1) & 7; return v; }
  function fround(v) {
    switch ((fcw >> 10) & 3) {
      case 0: {
        const r = Math.round(v);
        return r - v === 0.5 && (r & 1) !== 0 ? r - 1 : r;      // ties to even: Math.round sends .5 up
      }
      case 1: return Math.floor(v);
      case 2: return Math.ceil(v);
      default: return Math.trunc(v);
    }
  }
  function fcompare(a, b) {
    let c;
    if (a > b) c = 0; else if (a < b) c = 0x100; else if (a === b) c = 0x4000; else c = 0x4500;
    fsw = (fsw & ~0x4700) | c;
  }
  const fswWord = () => (fsw & ~0x3800) | (ftop << 11);
  function readReal(a, kind) {
    switch (kind) {
      case K_F32: sI32[0] = rd(a); return sF32[0];
      case K_F64: sI32[0] = rd(a); sI32[1] = rd(a + 4); return sF64[0];
      case K_I16: return (rw(a) << 16) >> 16;
      case K_I32: return rd(a);
      case K_I64: return rd(a + 4) * 4294967296 + (rd(a) >>> 0);
      default: {
        const lo = rd(a) >>> 0, hi = rd(a + 4) >>> 0, se = rw(a + 8);
        const e = se & 0x7fff, sgn = se & 0x8000 ? -1 : 1;
        if (e === 0 && lo === 0 && hi === 0) return sgn * 0;
        if (e === 0x7fff) return (hi & 0x7fffffff) || lo ? NaN : sgn * Infinity;
        return sgn * (hi * 4294967296 + lo) * Math.pow(2, e - 16383 - 63);
      }
    }
  }
  function writeReal(a, kind, v) {
    switch (kind) {
      case K_F32: sF32[0] = v; wd(a, sI32[0]); return;
      case K_F64: sF64[0] = v; wd(a, sI32[0]); wd(a + 4, sI32[1]); return;
      case K_I16: { const r = fround(v); ww(a, r >= -32768 && r <= 32767 ? r : 0x8000); return; }
      case K_I32: { const r = fround(v); wd(a, r >= -2147483648 && r <= 2147483647 ? r : -0x80000000); return; }
      case K_I64: {
        const r = fround(v);
        const b = Number.isFinite(r) && Math.abs(r) < 9.2e18 ? BigInt.asUintN(64, BigInt(r)) : 1n << 63n;
        wd(a, Number(b & 0xffffffffn)); wd(a + 4, Number(b >> 32n));
        return;
      }
      default: {
        if (v === 0 || !Number.isFinite(v)) {
          wd(a, 0); wd(a + 4, Number.isNaN(v) ? 0xc0000000 : v === 0 ? 0 : 0x80000000);
          ww(a + 8, (v < 0 || Object.is(v, -0) ? 0x8000 : 0) | (v === 0 ? 0 : 0x7fff));
          return;
        }
        const sgn = v < 0 ? 0x8000 : 0, x = Math.abs(v);
        let e = Math.floor(Math.log2(x));
        if (Math.pow(2, e) > x) e--;
        if (Math.pow(2, e + 1) <= x) e++;
        const b = BigInt(Math.round(x / Math.pow(2, e - 63)));
        wd(a, Number(b & 0xffffffffn)); wd(a + 4, Number((b >> 32n) & 0xffffffffn)); ww(a + 8, sgn | (e + 16383));
      }
    }
  }
  // the D8/DC/DA/DE row's operation on (a, b): add, mul, -, -, sub (a-b), subr (b-a), div, divr
  function farith(sub, a, b) {
    switch (sub) {
      case 0: return a + b;
      case 1: return a * b;
      case 4: return a - b;
      case 5: return b - a;
      case 6: return a / b;
      default: return b / a;
    }
  }
  const ROW_KIND = { 0xd8: K_F32, 0xdc: K_F64, 0xda: K_I32, 0xde: K_I16 };
  function fpuOp(op) {
    mrm = M[eip++];
    const reg = (mrm >> 3) & 7;
    if (mrm < 0xc0) {
      const a = ea();
      switch (op) {
        case 0xd8: case 0xdc: case 0xda: case 0xde: {
          const v = readReal(a, ROW_KIND[op]);
          if (reg === 2 || reg === 3) { fcompare(ST[ftop], v); if (reg === 3) fpop(); } else ST[ftop] = farith(reg, ST[ftop], v);
          return;
        }
        case 0xd9:
          switch (reg) {
            case 0: fpush(readReal(a, K_F32)); return;
            case 2: writeReal(a, K_F32, ST[ftop]); return;
            case 3: writeReal(a, K_F32, fpop()); return;
            case 4: fcw = rw(a) | 0x40; fsw = rw(a + 4); ftop = (fsw >> 11) & 7; ftag = rw(a + 8); return;   // FLDENV
            case 5: fcw = rw(a); return;                                                                  // FLDCW
            case 6: for (let i = 0; i < 28; i++) wb(a + i, 0); ww(a, fcw); ww(a + 4, fswWord()); ww(a + 8, ftag); return;
            case 7: ww(a, fcw); return;                                                                   // FNSTCW
          }
          break;
        case 0xdb:
          switch (reg) {
            case 0: fpush(readReal(a, K_I32)); return;
            case 1: { const v = fpop(); wd(a, Number.isFinite(v) && Math.abs(v) < 2147483648 ? Math.trunc(v) : -0x80000000); return; }
            case 2: writeReal(a, K_I32, ST[ftop]); return;
            case 3: writeReal(a, K_I32, fpop()); return;
            case 5: fpush(readReal(a, K_F80)); return;
            case 7: writeReal(a, K_F80, fpop()); return;
          }
          break;
        case 0xdd:
          switch (reg) {
            case 0: fpush(readReal(a, K_F64)); return;
            case 2: writeReal(a, K_F64, ST[ftop]); return;
            case 3: writeReal(a, K_F64, fpop()); return;
            case 4:                                                                                      // FRSTOR
              fcw = rw(a); fsw = rw(a + 4); ftop = (fsw >> 11) & 7; ftag = rw(a + 8);
              for (let i = 0; i < 8; i++) ST[(ftop + i) & 7] = readReal(a + 28 + i * 10, K_F80);
              return;
            case 6:                                                                                      // FNSAVE
              for (let i = 0; i < 28; i++) wb(a + i, 0);
              ww(a, fcw); ww(a + 4, fswWord()); ww(a + 8, ftag);
              for (let i = 0; i < 8; i++) writeReal(a + 28 + i * 10, K_F80, ST[(ftop + i) & 7]);
              fcw = 0x37f; fsw = 0; ftop = 0; ftag = 0xffff;
              return;
            case 7: ww(a, fswWord()); return;
          }
          break;
        case 0xdf:
          switch (reg) {
            case 0: fpush(readReal(a, K_I16)); return;
            case 2: writeReal(a, K_I16, ST[ftop]); return;
            case 3: writeReal(a, K_I16, fpop()); return;
            case 5: fpush(readReal(a, K_I64)); return;
            case 7: writeReal(a, K_I64, fpop()); return;
          }
          break;
      }
      throw new CpuFault(`FPU ${op.toString(16)} /${reg}`, opEip);
    }
    const i = (ftop + (mrm & 7)) & 7;
    switch (op) {
      case 0xd8:
        if (reg === 2 || reg === 3) { fcompare(ST[ftop], ST[i]); if (reg === 3) fpop(); } else ST[ftop] = farith(reg, ST[ftop], ST[i]);
        return;
      case 0xdc:
        if (reg === 2 || reg === 3) { fcompare(ST[ftop], ST[i]); if (reg === 3) fpop(); return; }
        ST[i] = farith(reg === 4 ? 5 : reg === 5 ? 4 : reg === 6 ? 7 : reg === 7 ? 6 : reg, ST[i], ST[ftop]);
        return;
      case 0xde:
        if (mrm === 0xd9) { fcompare(ST[ftop], ST[(ftop + 1) & 7]); fpop(); fpop(); return; }       // FCOMPP
        if (reg === 2 || reg === 3) { fcompare(ST[ftop], ST[i]); fpop(); return; }
        ST[i] = farith(reg === 4 ? 5 : reg === 5 ? 4 : reg === 6 ? 7 : reg === 7 ? 6 : reg, ST[i], ST[ftop]);
        fpop();
        return;
      case 0xd9:
        if (reg === 0) { fpush(ST[i]); return; }                                                    // FLD ST(i)
        if (reg === 1) { const t = ST[ftop]; ST[ftop] = ST[i]; ST[i] = t; return; }                  // FXCH
        switch (mrm) {
          case 0xd0: return;
          case 0xe0: ST[ftop] = -ST[ftop]; return;
          case 0xe1: ST[ftop] = Math.abs(ST[ftop]); return;
          case 0xe4: fcompare(ST[ftop], 0); return;
          case 0xe5: {
            const empty = ((ftag >> (ftop * 2)) & 3) === 3, v = ST[ftop];
            const sign = v < 0 || Object.is(v, -0) ? 0x200 : 0;
            const cls = empty ? 0x4100 : Number.isNaN(v) ? 0x100 : !Number.isFinite(v) ? 0x500 : v === 0 ? 0x4000 : 0x400;
            fsw = (fsw & ~0x4700) | cls | sign;
            return;
          }
          case 0xe8: fpush(1); return;
          case 0xe9: fpush(Math.log2(10)); return;
          case 0xea: fpush(Math.log2(Math.E)); return;
          case 0xeb: fpush(Math.PI); return;
          case 0xec: fpush(Math.log10(2)); return;
          case 0xed: fpush(Math.LN2); return;
          case 0xee: fpush(0); return;
          case 0xf0: ST[ftop] = Math.pow(2, ST[ftop]) - 1; return;
          case 0xf1: { const x = fpop(); ST[ftop] = ST[ftop] * Math.log2(x); return; }
          case 0xf2: ST[ftop] = Math.tan(ST[ftop]); fpush(1); return;
          case 0xf3: { const x = fpop(); ST[ftop] = Math.atan2(ST[ftop], x); return; }
          case 0xf4: { const x = ST[ftop]; const e = x === 0 ? 0 : Math.floor(Math.log2(Math.abs(x))); ST[ftop] = e; fpush(x / Math.pow(2, e)); return; }
          case 0xf5: case 0xf8: {
            const a = ST[ftop], b = ST[(ftop + 1) & 7];
            const q = mrm === 0xf8 ? Math.trunc(a / b) : Math.round(a / b);
            ST[ftop] = a - q * b;
            fsw = (fsw & ~0x4700) | ((q & 1) ? 0x200 : 0) | ((q & 2) ? 0x4000 : 0) | ((q & 4) ? 0x100 : 0);
            return;
          }
          case 0xf6: ftop = (ftop - 1) & 7; return;
          case 0xf7: ftop = (ftop + 1) & 7; return;
          case 0xfa: ST[ftop] = Math.sqrt(ST[ftop]); return;
          case 0xfb: { const x = ST[ftop]; ST[ftop] = Math.sin(x); fpush(Math.cos(x)); return; }
          case 0xfc: ST[ftop] = fround(ST[ftop]); return;
          case 0xfd: ST[ftop] = ST[ftop] * Math.pow(2, Math.trunc(ST[(ftop + 1) & 7])); return;
          case 0xfe: ST[ftop] = Math.sin(ST[ftop]); return;
          case 0xff: ST[ftop] = Math.cos(ST[ftop]); return;
        }
        break;
      case 0xdd:
        if (reg === 0) { ftag |= 3 << (i * 2); return; }                                             // FFREE
        if (reg === 2) { ST[i] = ST[ftop]; return; }                                                  // FST ST(i)
        if (reg === 3) { ST[i] = ST[ftop]; fpop(); return; }                                          // FSTP ST(i)
        if (reg === 4 || reg === 5) { fcompare(ST[ftop], ST[i]); if (reg === 5) fpop(); return; }     // FUCOM(P)
        break;
      case 0xdb:
        if (mrm === 0xe2) { fsw &= 0x7f00; return; }
        if (mrm === 0xe3) { fcw = 0x37f; fsw = 0; ftop = 0; ftag = 0xffff; return; }
        if (mrm === 0xe0 || mrm === 0xe1 || mrm === 0xe4) return;
        break;
      case 0xdf:
        if (mrm === 0xe0) { setR(S16, EAX, fswWord()); return; }
        if (reg === 0) { ftag |= 3 << (i * 2); fpop(); return; }
        break;
      case 0xda:
        if (mrm === 0xe9) { fcompare(ST[ftop], ST[(ftop + 1) & 7]); fpop(); fpop(); return; }
        break;
    }
    throw new CpuFault(`FPU ${op.toString(16)} ${mrm.toString(16)}`, opEip);
  }

  // ------------------------------------------------------------------ one instruction
  function step() {
    opEip = eip;
    let op = M[eip++];
    os = S32; as32 = true; segOv = -1; rep = 0;
    if (cs16) { os = S16; as32 = false; }
    if (PREFIX[op] === 1) {
      for (;;) {
        switch (op) {
          case 0x66: os = cs16 ? S32 : S16; break;
          case 0x67: as32 = cs16; break;
          case 0x26: segOv = ES; break;
          case 0x2e: segOv = CS; break;
          case 0x36: segOv = SS; break;
          case 0x3e: segOv = DS; break;
          case 0x64: segOv = FS; break;
          case 0x65: segOv = GS; break;
          case 0xf2: case 0xf3: rep = op; break;
        }
        op = M[eip++];
        if (PREFIX[op] === 0) break;
      }
      // an override naming a base-0 segment is no override: forget it so ea() skips the addition,
      // unless DS or SS has a base, when the override is what stops the default from applying
      if (segOv >= 0 && segBase[segOv] === 0 && !defBases) segOv = -1;
    }

    switch (op) {
      // ---- the ALU rows: add, or, adc, sbb, and, sub, xor, cmp
      case 0x00: case 0x08: case 0x10: case 0x18: case 0x20: case 0x28: case 0x30: case 0x38: {
        mrm = M[eip++]; const sub = op >> 3;
        const r = arith(sub, loadE(S8), get8((mrm >> 3) & 7), S8);
        if (sub !== 7) storeE(S8, r);
        return;
      }
      case 0x01: case 0x09: case 0x11: case 0x19: case 0x21: case 0x29: case 0x31: case 0x39: {
        mrm = M[eip++]; const sub = op >> 3;
        if (os === S32) {
          if (mrm >= 0xc0) { const r = alu32(sub, R[mrm & 7], R[(mrm >> 3) & 7]); if (sub !== 7) R[mrm & 7] = r; return; }
          eaddr = ea();
          const r = alu32(sub, rd(eaddr), R[(mrm >> 3) & 7]);
          if (sub !== 7) wd(eaddr, r);
          return;
        }
        const r = arith(sub, loadE(os), getR(os, (mrm >> 3) & 7), os);
        if (sub !== 7) storeE(os, r);
        return;
      }
      case 0x02: case 0x0a: case 0x12: case 0x1a: case 0x22: case 0x2a: case 0x32: case 0x3a: {
        mrm = M[eip++]; const sub = op >> 3;
        const b = loadE(S8);
        const r = arith(sub, get8((mrm >> 3) & 7), b, S8);
        if (sub !== 7) set8((mrm >> 3) & 7, r);
        return;
      }
      case 0x03: case 0x0b: case 0x13: case 0x1b: case 0x23: case 0x2b: case 0x33: case 0x3b: {
        mrm = M[eip++]; const sub = op >> 3, g = (mrm >> 3) & 7;
        if (os === S32) {
          const b = mrm >= 0xc0 ? R[mrm & 7] : rd(ea());
          const r = alu32(sub, R[g], b);
          if (sub !== 7) R[g] = r;
          return;
        }
        const b = loadE(os);
        const r = arith(sub, getR(os, g), b, os);
        if (sub !== 7) setR(os, g, r);
        return;
      }
      case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x34: case 0x3c: {
        const sub = op >> 3;
        const r = arith(sub, R[EAX] & 0xff, M[eip++], S8);
        if (sub !== 7) set8(0, r);
        return;
      }
      case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x35: case 0x3d: {
        const sub = op >> 3;
        const b = fImm(os);
        const r = arith(sub, getR(os, EAX), b, os);
        if (sub !== 7) setR(os, EAX, r);
        return;
      }

      case 0x06: pushS(os, seg[ES]); return;
      case 0x07: loadSeg(ES, popS(os)); return;
      case 0x0e: pushS(os, seg[CS]); return;
      case 0x16: pushS(os, seg[SS]); return;
      case 0x17: loadSeg(SS, popS(os)); return;
      case 0x1e: pushS(os, seg[DS]); return;
      case 0x1f: loadSeg(DS, popS(os)); return;
      case 0x0f: twoByte(); return;
      case 0x27: case 0x2f: { // DAA / DAS
        const old = R[EAX] & 0xff, cf = getCF(), af = getAF();
        let al = old, ncf = 0, naf = 0;
        if ((al & 0xf) > 9 || af) { al = op === 0x27 ? al + 6 : al - 6; naf = 1; }
        if (old > 0x99 || cf) { al = op === 0x27 ? al + 0x60 : al - 0x60; ncf = 1; }
        set8(0, al);
        const z = (al & 0xff) === 0 ? 1 : 0, sgn = (al & 0x80) ? 1 : 0;
        flags = (getFlags() & ~0x8d5) | ncf | (PARITY[al & 0xff] << 2) | (naf << 4) | (z << 6) | (sgn << 7);
        fOp = F_NONE;
        return;
      }
      case 0x37: case 0x3f: { // AAA / AAS
        if ((R[EAX] & 0xf) > 9 || getAF()) {
          setR(S16, EAX, (op === 0x37 ? R[EAX] + 0x106 : R[EAX] - 0x106) & 0xff0f);
          flags = getFlags() | 0x11; fOp = F_NONE;
        } else { setR(S16, EAX, R[EAX] & 0xff0f); flags = getFlags() & ~0x11; fOp = F_NONE; }
        return;
      }
      case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47:
        if (os === S32) R[op & 7] = inc(R[op & 7], S32); else setR(os, op & 7, inc(R[op & 7] & 0xffff, S16));
        return;
      case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f:
        if (os === S32) R[op & 7] = dec(R[op & 7], S32); else setR(os, op & 7, dec(R[op & 7] & 0xffff, S16));
        return;
      case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
        if (os === S32) push(R[op & 7]); else pushS(os, R[op & 7] & 0xffff);
        return;
      case 0x58: case 0x59: case 0x5a: case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
        if (os === S32) R[op & 7] = pop(); else setR(S16, op & 7, popS(S16));
        return;
      case 0x60: { const sp = getR(os, ESP); for (let i = 0; i < 8; i++) pushS(os, i === ESP ? sp : getR(os, i)); return; }
      case 0x61: for (let i = 7; i >= 0; i--) { const v = popS(os); if (i !== ESP) setR(os, i, v); } return;
      case 0x62: mrm = M[eip++]; ea(); return;             // BOUND: never out of bounds here
      case 0x68: pushS(os, fImm(os)); return;
      case 0x6a: pushS(os, f8s() & MASK[os]); return;
      case 0x69: case 0x6b: {
        mrm = M[eip++];
        const v = loadE(os);
        const imm = op === 0x6b ? f8s() : os === S32 ? f32() : (f16() << 16) >> 16;
        imul2(os, (mrm >> 3) & 7, v, imm);
        return;
      }
      case 0x6c: case 0x6d: case 0x6e: case 0x6f: stringOp(op); return;
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7a: case 0x7b: case 0x7c: case 0x7d: case 0x7e: case 0x7f: {
        const d = (M[eip++] << 24) >> 24;
        if (cond(op & 15)) eip += d;
        return;
      }
      case 0x80: case 0x82: {
        mrm = M[eip++]; const sub = (mrm >> 3) & 7;
        const a = loadE(S8);
        const r = arith(sub, a, M[eip++], S8);
        if (sub !== 7) storeE(S8, r);
        return;
      }
      case 0x81: case 0x83: {
        mrm = M[eip++]; const sub = (mrm >> 3) & 7;
        if (os === S32) {
          if (mrm >= 0xc0) {
            const b = op === 0x83 ? (M[eip++] << 24) >> 24 : f32();
            const r = alu32(sub, R[mrm & 7], b);
            if (sub !== 7) R[mrm & 7] = r;
            return;
          }
          eaddr = ea();
          const b = op === 0x83 ? (M[eip++] << 24) >> 24 : f32();
          const r = alu32(sub, rd(eaddr), b);
          if (sub !== 7) wd(eaddr, r);
          return;
        }
        const a = loadE(os);
        const b = op === 0x83 ? f8s() & MASK[os] : fImm(os);
        const r = arith(sub, a, b, os);
        if (sub !== 7) storeE(os, r);
        return;
      }
      case 0x84: { mrm = M[eip++]; const a = loadE(S8); logicFlags(a & get8((mrm >> 3) & 7), S8); return; }
      case 0x85: {
        mrm = M[eip++];
        if (os === S32) { const a = mrm >= 0xc0 ? R[mrm & 7] : rd(ea()); logicFlags(a & R[(mrm >> 3) & 7], S32); return; }
        const a = loadE(os); logicFlags(a & getR(os, (mrm >> 3) & 7), os);
        return;
      }
      case 0x86: case 0x87: {
        const s = op & 1 ? os : S8;
        mrm = M[eip++];
        const a = loadE(s), g = (mrm >> 3) & 7, b = getR(s, g);
        storeE(s, b); setR(s, g, a);
        return;
      }
      case 0x88: {
        mrm = M[eip++];
        const v = get8((mrm >> 3) & 7);
        if (mrm >= 0xc0) set8(mrm & 7, v); else wb(ea(), v);
        return;
      }
      case 0x89: {
        mrm = M[eip++];
        if (os === S32) { if (mrm >= 0xc0) R[mrm & 7] = R[(mrm >> 3) & 7]; else wd(ea(), R[(mrm >> 3) & 7]); return; }
        writeE(os, getR(os, (mrm >> 3) & 7));
        return;
      }
      case 0x8a: mrm = M[eip++]; set8((mrm >> 3) & 7, loadE(S8)); return;
      case 0x8b: {
        mrm = M[eip++];
        if (os === S32) { R[(mrm >> 3) & 7] = mrm >= 0xc0 ? R[mrm & 7] : rd(ea()); return; }
        setR(os, (mrm >> 3) & 7, loadE(os));
        return;
      }
      case 0x8c: mrm = M[eip++]; if (mrm >= 0xc0) setR(os, mrm & 7, seg[(mrm >> 3) & 7]); else writeE(S16, seg[(mrm >> 3) & 7]); return;
      case 0x8d: {
        mrm = M[eip++];
        const so = segOv, db = defBases;
        segOv = -1; defBases = false;
        const a = ea();
        segOv = so; defBases = db;
        setR(os, (mrm >> 3) & 7, a);
        return;
      }
      case 0x8e: mrm = M[eip++]; loadSeg((mrm >> 3) & 7, loadE(S16)); return;
      case 0x8f: { mrm = M[eip++]; const v = popS(os); writeE(os, v); return; }
      case 0x90: return;
      case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97: {
        const a = getR(os, EAX), b = getR(os, op & 7); setR(os, EAX, b); setR(os, op & 7, a);
        return;
      }
      case 0x98: if (os === S32) R[EAX] = (R[EAX] << 16) >> 16; else setR(S16, EAX, (R[EAX] << 24) >> 24); return;
      case 0x99: if (os === S32) R[EDX] = R[EAX] >> 31; else setR(S16, EDX, (R[EAX] << 16) >> 31); return;
      case 0x9a: { const off = os === S32 ? f32() : f16(); const sel = f16(); pushS(os, seg[CS]); pushS(os, eip - csb); loadSeg(CS, sel); eip = (off + csb) >>> 0; return; }
      case 0x9b: return;
      case 0x9c: pushS(os, getFlags() & 0xfcffff); return;
      case 0x9d: { const v = popS(os); setFlags(os === S16 ? (getFlags() & ~0xffff) | v : v); return; }
      case 0x9e: setFlags((getFlags() & ~0xd5) | ((R[EAX] >> 8) & 0xd5)); return;
      case 0x9f: set8(4, getFlags() & 0xff); return;
      case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
        const s = op & 1 ? os : S8;
        let a = as32 ? f32() : f16();
        a = (a + (segOv >= 0 ? segBase[segOv] : segBase[DS])) | 0;
        if (op < 0xa2) { if (s === S32) R[EAX] = rd(a); else setR(s, EAX, s === S16 ? rw(a) : rbx(a)); }
        else { const v = getR(s, EAX); if (s === S32) wd(a, v); else if (s === S16) ww(a, v); else wb(a, v); }
        return;
      }
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        stringOp(op); return;
      case 0xa8: logicFlags(R[EAX] & M[eip++] & 0xff, S8); return;
      case 0xa9: { const v = fImm(os); logicFlags(getR(os, EAX) & v, os); return; }
      case 0xb0: case 0xb1: case 0xb2: case 0xb3: case 0xb4: case 0xb5: case 0xb6: case 0xb7:
        set8(op & 7, M[eip++]); return;
      case 0xb8: case 0xb9: case 0xba: case 0xbb: case 0xbc: case 0xbd: case 0xbe: case 0xbf:
        if (os === S32) R[op & 7] = f32(); else setR(S16, op & 7, f16());
        return;
      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const s = op & 1 ? os : S8;
        mrm = M[eip++];
        const v = loadE(s);
        const cnt = op <= 0xc1 ? M[eip++] : op <= 0xd1 ? 1 : R[ECX] & 0xff;
        if ((cnt & 31) === 0) return;
        storeE(s, shift((mrm >> 3) & 7, v, cnt, s));
        return;
      }
      case 0xc2: { const n = f16(); eip = (popS(os) + csb) >>> 0; R[ESP] += n; return; }
      case 0xc3: eip = ((os === S32 ? pop() : popS(S16)) + csb) >>> 0; return;
      case 0xc4: case 0xc5: {
        mrm = M[eip++];
        const a = ea();
        const off = os === S32 ? rd(a) : rw(a), sel = rw(a + (os === S32 ? 4 : 2));
        loadSeg(op === 0xc4 ? ES : DS, sel); setR(os, (mrm >> 3) & 7, off);
        return;
      }
      case 0xc6: mrm = M[eip++]; if (mrm >= 0xc0) set8(mrm & 7, M[eip++]); else { eaddr = ea(); wb(eaddr, M[eip++]); } return;
      case 0xc7: {
        mrm = M[eip++];
        if (mrm >= 0xc0) { setR(os, mrm & 7, fImm(os)); return; }
        eaddr = ea();
        if (os === S32) wd(eaddr, f32()); else ww(eaddr, f16());
        return;
      }
      case 0xc8: {
        const size = f16(), level = M[eip++] & 31;
        pushS(os, getR(os, EBP));
        const frame = R[ESP];
        for (let i = 1; i < level; i++) { R[EBP] -= os === S32 ? 4 : 2; pushS(os, os === S32 ? rd(R[EBP] + ssb) : rw(R[EBP] + ssb)); }
        if (level > 0) pushS(os, frame);
        setR(os, EBP, frame);
        R[ESP] -= size;
        return;
      }
      case 0xc9: R[ESP] = R[EBP]; setR(os, EBP, popS(os)); return;
      case 0xca: { const n = f16(); const off = popS(os); loadSeg(CS, popS(os)); eip = (off + csb) >>> 0; R[ESP] += n; return; }
      case 0xcb: { const off = popS(os); loadSeg(CS, popS(os)); eip = (off + csb) >>> 0; return; }
      case 0xcc: softInt(3); return;
      case 0xcd: softInt(M[eip++]); return;
      case 0xce: if (getOF()) softInt(4); return;
      case 0xcf: {
        const off = popS(os);
        loadSeg(CS, popS(os));
        eip = (off + csb) >>> 0;
        const f = popS(os);
        setFlags(os === S16 ? (getFlags() & ~0xffff) | f : f);
        return;
      }
      case 0xd4: { const b = M[eip++] || 10; const al = R[EAX] & 0xff; setR(S16, EAX, (Math.floor(al / b) << 8) | (al % b)); logicFlags(al % b, S8); return; }
      case 0xd5: { const b = M[eip++]; const al = ((R[EAX] >> 8) & 0xff) * b + (R[EAX] & 0xff); setR(S16, EAX, al & 0xff); logicFlags(al & 0xff, S8); return; }
      case 0xd6: set8(0, getCF() ? 0xff : 0); return;
      case 0xd7: { const a = (R[EBX] + (R[EAX] & 0xff) + (segOv >= 0 ? segBase[segOv] : segBase[DS])) | 0; set8(0, rbx(a)); return; }
      case 0xd8: case 0xd9: case 0xda: case 0xdb: case 0xdc: case 0xdd: case 0xde: case 0xdf:
        fpuOp(op); return;
      case 0xe0: case 0xe1: case 0xe2: {
        const d = f8s();
        let c;
        if (as32) { c = R[ECX] = (R[ECX] - 1) | 0; } else { c = (R[ECX] - 1) & 0xffff; setR(S16, ECX, c); }
        let take = c !== 0;
        if (op === 0xe0) take = take && getZF() === 0;
        else if (op === 0xe1) take = take && getZF() === 1;
        if (take) eip += d;
        return;
      }
      case 0xe3: { const d = f8s(); if ((as32 ? R[ECX] : R[ECX] & 0xffff) === 0) eip += d; return; }
      case 0xe4: set8(0, bus.portIn(M[eip++], S8)); return;
      case 0xe5: setR(os, EAX, bus.portIn(M[eip++], os)); return;
      case 0xe6: bus.portOut(M[eip++], S8, R[EAX] & 0xff); return;
      case 0xe7: bus.portOut(M[eip++], os, getR(os, EAX)); return;
      case 0xe8: {
        if (os === S32) { const d = f32(); push(eip - csb); eip = (eip + d) >>> 0; return; }
        const d = (f16() << 16) >> 16; pushS(S16, eip - csb); eip = (eip + d) >>> 0;
        return;
      }
      case 0xe9: { const d = os === S32 ? f32() : (f16() << 16) >> 16; eip = (eip + d) >>> 0; return; }
      case 0xea: { const off = os === S32 ? f32() : f16(); const sel = f16(); loadSeg(CS, sel); eip = (off + csb) >>> 0; return; }
      case 0xeb: { const d = (M[eip++] << 24) >> 24; eip += d; return; }
      case 0xec: set8(0, bus.portIn(R[EDX] & 0xffff, S8)); return;
      case 0xed: setR(os, EAX, bus.portIn(R[EDX] & 0xffff, os)); return;
      case 0xee: bus.portOut(R[EDX] & 0xffff, S8, R[EAX] & 0xff); return;
      case 0xef: bus.portOut(R[EDX] & 0xffff, os, getR(os, EAX)); return;
      case 0xf4: halted = true; stop = true; return;
      case 0xf5: setCFbit(getCF() ^ 1); return;
      case 0xf6: mrm = M[eip++]; grp3((mrm >> 3) & 7, S8); return;
      case 0xf7: mrm = M[eip++]; grp3((mrm >> 3) & 7, os); return;
      case 0xf8: setCFbit(0); return;
      case 0xf9: setCFbit(1); return;
      case 0xfa: flags &= ~0x200; return;
      case 0xfb: flags |= 0x200; return;
      case 0xfc: flags &= ~0x400; return;
      case 0xfd: flags |= 0x400; return;
      case 0xfe: {
        mrm = M[eip++];
        const sub = (mrm >> 3) & 7, v = loadE(S8);
        if (sub === 0) storeE(S8, inc(v, S8)); else if (sub === 1) storeE(S8, dec(v, S8));
        else throw new CpuFault(`FE /${sub}`, opEip);
        return;
      }
      case 0xff: {
        mrm = M[eip++];
        switch ((mrm >> 3) & 7) {
          case 0: storeE(os, inc(loadE(os), os)); return;
          case 1: storeE(os, dec(loadE(os), os)); return;
          case 2: { const t = loadE(os); pushS(os, eip - csb); eip = (t + csb) >>> 0; return; }
          case 3: { const a = ea(); const off = os === S32 ? rd(a) : rw(a); const sel = rw(a + (os === S32 ? 4 : 2)); pushS(os, seg[CS]); pushS(os, eip - csb); loadSeg(CS, sel); eip = (off + csb) >>> 0; return; }
          case 4: eip = (loadE(os) + csb) >>> 0; return;
          case 5: { const a = ea(); const off = os === S32 ? rd(a) : rw(a); const sel = rw(a + (os === S32 ? 4 : 2)); loadSeg(CS, sel); eip = (off + csb) >>> 0; return; }
          case 6: pushS(os, loadE(os)); return;
        }
        throw new CpuFault('FF /7', opEip);
      }
    }
    throw new CpuFault(`opcode ${op.toString(16)}`, opEip);
  }

  function imul2(s, g, a, b) {
    if (s === S32) {
      const lo = Math.imul(a, b);
      const o = a * b !== lo ? 1 : 0;
      R[g] = lo; eager(lo, s, o, o);
    } else {
      const p = ((a << 16) >> 16) * ((b << 16) >> 16);
      setR(S16, g, p); const o = p !== ((p << 16) >> 16) ? 1 : 0; eager(p & 0xffff, s, o, o);
    }
  }

  function bitOp(sub, s, bitFromReg, immBit) {
    // sub: 4 BT, 5 BTS, 6 BTR, 7 BTC
    const bits = BITS[s];
    let v, bit, addr = 0;
    const isReg = mrm >= 0xc0;
    if (isReg) { v = getR(s, mrm & 7); bit = (bitFromReg ? getR(s, (mrm >> 3) & 7) : immBit) & (bits - 1); }
    else {
      addr = ea();
      if (bitFromReg) {
        const off = s === S32 ? R[(mrm >> 3) & 7] : (R[(mrm >> 3) & 7] << 16) >> 16;
        addr = (addr + Math.floor(off / bits) * (bits >> 3)) | 0;
        bit = off & (bits - 1);
      } else bit = immBit & (bits - 1);
      v = s === S32 ? rd(addr) : rw(addr);
    }
    setCFbit((v >>> bit) & 1);
    if (sub === 4) return;
    const r = (sub === 5 ? v | (1 << bit) : sub === 6 ? v & ~(1 << bit) : v ^ (1 << bit)) & MASK[s];
    if (isReg) setR(s, mrm & 7, r); else if (s === S32) wd(addr, r); else ww(addr, r);
  }

  function twoByte() {
    const op = M[eip++];
    if (op >= 0x80 && op <= 0x8f) {
      const d = os === S32 ? f32() : (f16() << 16) >> 16;
      if (cond(op & 15)) eip = (eip + d) >>> 0;
      return;
    }
    if (op >= 0x90 && op <= 0x9f) { mrm = M[eip++]; writeE(S8, cond(op & 15) ? 1 : 0); return; }
    if (op >= 0xc8 && op <= 0xcf) {
      const v = R[op & 7];
      R[op & 7] = ((v & 0xff) << 24) | (((v >> 8) & 0xff) << 16) | (((v >> 16) & 0xff) << 8) | ((v >>> 24) & 0xff);
      return;
    }
    switch (op) {
      case 0x00: case 0x01: {
        mrm = M[eip++];
        const sub = (mrm >> 3) & 7;
        if (op === 0x01 && sub === 4) { writeE(S16, 0x0011); return; } // SMSW: protected, FPU present
        if (mrm < 0xc0) { const a = ea(); if (op === 0x01 && (sub === 0 || sub === 1)) { ww(a, 0xff); wd(a + 2, 0); } }
        else if (op === 0x00 && (sub === 0 || sub === 1)) setR(os, mrm & 7, 0);
        return;
      }
      case 0x02: mrm = M[eip++]; loadE(S16); setR(os, (mrm >> 3) & 7, 0xcf9a00); zfSet(1); return;     // LAR
      case 0x03: mrm = M[eip++]; loadE(S16); setR(os, (mrm >> 3) & 7, -1); zfSet(1); return;           // LSL
      case 0x06: return;
      case 0x1f: mrm = M[eip++]; if (mrm < 0xc0) ea(); return;
      case 0x20: case 0x21: case 0x22: case 0x23:
        mrm = M[eip++];
        if (op === 0x20 || op === 0x21) R[mrm & 7] = op === 0x20 && ((mrm >> 3) & 7) === 0 ? 0x11 : 0;
        return;
      case 0x31: R[EAX] = cycles; R[EDX] = 0; return;
      case 0xa0: pushS(os, seg[FS]); return;
      case 0xa1: loadSeg(FS, popS(os)); return;
      case 0xa8: pushS(os, seg[GS]); return;
      case 0xa9: loadSeg(GS, popS(os)); return;
      case 0xa2: // CPUID: a 486DX
        if (R[EAX] === 0) { R[EAX] = 1; R[EBX] = 0x756e6547; R[EDX] = 0x49656e69; R[ECX] = 0x6c65746e; }
        else { R[EAX] = 0x0421; R[EBX] = 0; R[ECX] = 0; R[EDX] = 1; }
        return;
      case 0xa3: mrm = M[eip++]; bitOp(4, os, true, 0); return;
      case 0xab: mrm = M[eip++]; bitOp(5, os, true, 0); return;
      case 0xb3: mrm = M[eip++]; bitOp(6, os, true, 0); return;
      case 0xbb: mrm = M[eip++]; bitOp(7, os, true, 0); return;
      case 0xba: {
        mrm = M[eip++];
        const sub = (mrm >> 3) & 7;
        if (sub < 4) throw new CpuFault(`0f ba /${sub}`, opEip);
        if (mrm >= 0xc0) { bitOp(sub, os, false, M[eip++]); return; }
        // the immediate follows the displacement: decode once to find it, then again for real
        const save = eip; ea(); const imm = M[eip]; const after = eip + 1; eip = save;
        bitOp(sub, os, false, imm); eip = after;
        return;
      }
      case 0xa4: case 0xa5: case 0xac: case 0xad: {
        mrm = M[eip++];
        const s = os, bits = BITS[s], g = getR(s, (mrm >> 3) & 7);
        const v = loadE(s);
        const cnt = (op === 0xa4 || op === 0xac ? M[eip++] : R[ECX]) & 31;
        if (cnt === 0) return;
        let r, cf;
        if (s === S32) {
          if (op <= 0xa5) { r = (v << cnt) | (g >>> (32 - cnt)); cf = (v >>> (32 - cnt)) & 1; }
          else { r = (v >>> cnt) | (g << (32 - cnt)); cf = (v >>> (cnt - 1)) & 1; }
        } else if (op <= 0xa5) {
          r = ((((v << 16) | g) << cnt) >>> 16) & 0xffff; cf = (v >>> (16 - cnt)) & 1;
        } else {
          r = (((g << 16) | v) >>> cnt) & 0xffff; cf = (v >>> (cnt - 1)) & 1;
        }
        eager(r, s, cf, ((r ^ v) >>> (bits - 1)) & 1);
        storeE(s, r);
        return;
      }
      case 0xaf: {
        mrm = M[eip++];
        const v = loadE(os);
        imul2(os, (mrm >> 3) & 7, getR(os, (mrm >> 3) & 7), v);
        return;
      }
      case 0xb0: case 0xb1: {
        const s = op & 1 ? os : S8;
        mrm = M[eip++];
        const v = loadE(s), a = getR(s, EAX);
        arith(7, a, v, s);
        if (a === v) storeE(s, getR(s, (mrm >> 3) & 7)); else { setR(s, EAX, v); storeE(s, v); }
        return;
      }
      case 0xb2: case 0xb4: case 0xb5: {
        mrm = M[eip++];
        const a = ea();
        const off = os === S32 ? rd(a) : rw(a), sel = rw(a + (os === S32 ? 4 : 2));
        loadSeg(op === 0xb2 ? SS : op === 0xb4 ? FS : GS, sel); setR(os, (mrm >> 3) & 7, off);
        return;
      }
      case 0xb6: mrm = M[eip++]; setR(os, (mrm >> 3) & 7, mrm >= 0xc0 ? get8(mrm & 7) : rbx(ea())); return;
      case 0xb7: mrm = M[eip++]; setR(os, (mrm >> 3) & 7, mrm >= 0xc0 ? R[mrm & 7] & 0xffff : rw(ea())); return;
      case 0xbe: mrm = M[eip++]; setR(os, (mrm >> 3) & 7, ((mrm >= 0xc0 ? get8(mrm & 7) : rbx(ea())) << 24) >> 24); return;
      case 0xbf: mrm = M[eip++]; setR(os, (mrm >> 3) & 7, ((mrm >= 0xc0 ? R[mrm & 7] : rw(ea())) << 16) >> 16); return;
      case 0xbc: case 0xbd: {
        mrm = M[eip++];
        const v = loadE(os);
        if (v === 0) { zfSet(1); return; }
        setR(os, (mrm >> 3) & 7, op === 0xbc ? 31 - Math.clz32(v & -v) : 31 - Math.clz32(v));
        zfSet(0);
        return;
      }
      case 0xc0: case 0xc1: {
        const s = op & 1 ? os : S8;
        mrm = M[eip++];
        const v = loadE(s), g = (mrm >> 3) & 7, b = getR(s, g);
        const r = arith(0, v, b, s);
        setR(s, g, v); storeE(s, r);
        return;
      }
    }
    throw new CpuFault(`opcode 0f ${op.toString(16)}`, opEip);
  }

  // ------------------------------------------------------------------ the loop
  /** Run up to `n` instructions (fewer if one halts). Returns the number executed. */
  function run(n) {
    stop = false;
    let i = 0;
    while (i < n) {
      try {
        while (i < n) {
          i++;
          step();
          if (stop) { n = i; break; }
        }
      } catch (e) {
        if (e instanceof DivFault) { eip = opEip; interrupt(0, opEip); continue; }
        eip = opEip;
        cycles += i - 1;
        throw e;
      }
    }
    cycles += i;
    return i;
  }

  const api = {
    R, seg, segBase, M,
    get eip() { return eip; }, set eip(v) { eip = v >>> 0; },
    get opEip() { return opEip; },
    get halted() { return halted; }, set halted(v) { halted = v; },
    get cycles() { return cycles; }, set cycles(v) { cycles = v; },
    get flags() { return getFlags(); }, set flags(v) { setFlags(v); },
    get IF() { return (flags & 0x200) !== 0; },
    setCF(c) { setCFbit(c ? 1 : 0); },
    setZF(z) { zfSet(z ? 1 : 0); },
    loadSeg, push, pop, rb, rw, rd, wb, ww, wd,
    interrupt(n) { halted = false; interrupt(n, eip); },
    stop() { stop = true; },
    run, step,
    get fpu() { return { st: Array.from({ length: 8 }, (_, k) => ST[(ftop + k) & 7]), top: ftop, cw: fcw, sw: fswWord() }; },
  };
  return api;
}
