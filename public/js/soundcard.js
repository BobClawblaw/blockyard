// SOUNDCARD: the Sound Blaster Pro 2 in the DOOM Diversion's PC -- a DSP that plays digitised sound
// through DMA, and an OPL3 FM synthesiser for the music (operator, 2026-09-15: "Get DOOM working as
// a diversion inside blockyard with zero dependancies").
//
// Our own implementation, at the level a driver sees the card: the DSP's reset handshake, command
// bytes and interrupts; the 8237 DMA controller's address and count registers, which is where the
// samples come from (the driver leaves them in conventional memory and the card pulls them); and the
// OPL's register map, timers and status byte, which is how a driver decides the chip exists at all.
//
// THE SYNTHESIS IS A MODEL, NOT A CHIP. Each OPL operator is a phase accumulator, one of eight
// waveforms, and an envelope in decibels (attack, decay to the sustain level, release) with the
// chip's documented rate scaling: 2826 ms for a full attack and 39281 ms for a full 96 dB decay at
// rate 4, each rate step a quarter of an octave faster. Modulation is phase modulation in cycles --
// a modulator at full level moves its carrier by four cycles, the chip's own scaling. It sounds like
// an OPL; it is not sample-exact to one, and nothing here pretends it is.
//
// Time is the machine's: `tick(t)` is called with the PC's clock, and every millisecond of it
// produces `rate` samples a second of stereo output, mixed from the DSP's DAC and the FM voices, into
// a ring the caller drains. The DSP's end-of-block interrupt is raised from inside that same loop,
// so a driver's next block is requested exactly when the last one ran out, in machine time.

const OPL_RATE = 49716;

// ------------------------------------------------------------------ OPL tables
const WAVE_BITS = 10, WAVE_LEN = 1 << WAVE_BITS;
const WAVES = [];
{
  const sin = (i) => Math.sin((2 * Math.PI * (i + 0.5)) / WAVE_LEN);
  const mk = (f) => { const t = new Float32Array(WAVE_LEN); for (let i = 0; i < WAVE_LEN; i++) t[i] = f(i); return t; };
  const half = WAVE_LEN / 2, quarter = WAVE_LEN / 4;
  WAVES.push(mk((i) => sin(i)));                                            // 0 sine
  WAVES.push(mk((i) => (i < half ? sin(i) : 0)));                           // 1 half-sine
  WAVES.push(mk((i) => Math.abs(sin(i))));                                  // 2 abs-sine
  WAVES.push(mk((i) => ((i % half) < quarter ? Math.abs(sin(i)) : 0)));     // 3 pulse-sine
  WAVES.push(mk((i) => (i < half ? sin(i * 2) : 0)));                       // 4 even-periods sine
  WAVES.push(mk((i) => (i < half ? Math.abs(sin(i * 2)) : 0)));             // 5 even-periods abs-sine
  WAVES.push(mk((i) => (i < half ? 1 : -1)));                               // 6 square
  WAVES.push(mk((i) => (i < half ? Math.pow(10, -(i / half) * 4.8) : -Math.pow(10, -((WAVE_LEN - 1 - i) / half) * 4.8)))); // 7 derived square
}
// the tremolo LFO: a raised cosine, 0 to 1, over 256 steps
const LFO_TREM = new Float32Array(256);
for (let i = 0; i < 256; i++) LFO_TREM[i] = (1 - Math.cos((2 * Math.PI * i) / 256)) * 0.5;
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const KSL_TABLE = [0, 18, 24, 27, 30, 32.25, 33.75, 35.25, 36, 37.5, 38.25, 39, 39.75, 40.5, 41.25, 42];
const KSL_SCALE = [0, 0.5, 0.25, 1];   // 0, 3, 1.5 and 6 dB an octave, as fractions of the table's 6
const MAX_DB = 96;
// dB -> linear, in tenths of a dB: the envelope is summed in dB and looked up once a sample
const DB_STEPS = 10;
const DB_TO_AMP = new Float32Array(MAX_DB * DB_STEPS * 2 + 2);
for (let i = 0; i < DB_TO_AMP.length; i++) DB_TO_AMP[i] = i >= MAX_DB * DB_STEPS ? 0 : Math.pow(10, -i / DB_STEPS / 20);

/** Seconds for a full attack and a full 96 dB decay at an effective rate (0..63). */
export function oplRateTimes(rate) {
  if (rate < 4) return { attack: Infinity, decay: Infinity };
  if (rate >= 60) return { attack: 0, decay: 0.3 / 1000 * Math.pow(2, -(Math.min(rate, 63) - 60) / 4) * 8 };
  const k = Math.pow(2, (rate - 4) / 4);
  return { attack: 2.82624 / k, decay: 39.28064 / k };
}

const EG_OFF = 0, EG_ATTACK = 1, EG_DECAY = 2, EG_SUSTAIN = 3, EG_RELEASE = 4;

class Operator {
  constructor() {
    this.am = 0; this.vib = 0; this.egt = 0; this.ksr = 0; this.mult = 1;
    this.ksl = 0; this.tl = 0; this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0; this.wave = 0;
    this.phase = 0; this.env = MAX_DB; this.stage = EG_OFF;
    this.out = 0; this.prev = 0;
    // worked out per render call from the registers (Opl3.prepare)
    this.attackK = 0; this.decayInc = 0; this.releaseInc = 0; this.slLevel = 0; this.levelDb = 0; this.inc = 0; this.table = null;
  }
}

class Channel {
  constructor() {
    this.fnum = 0; this.block = 0; this.key = false; this.fb = 0; this.cnt = 0;
    this.left = true; this.right = true;
    this.ops = [new Operator(), new Operator()];
  }
}

export class Opl3 {
  constructor(rate) {
    this.rate = rate;
    this.reg = new Uint8Array(0x200);
    this.chans = Array.from({ length: 18 }, () => new Channel());
    this.newMode = false;           // register 0x105 bit 0: OPL3 features on
    this.wse = false;               // register 0x01 bit 5: waveform select (OPL2)
    this.nts = 0;
    this.amDepth = 1; this.vibDepth = 7;
    this.lfoAm = 0; this.lfoVib = 0;
    this.timer1 = 0; this.timer2 = 0; this.status = 0; this.timerCtl = 0;
    this.index = [0, 0];
    this.trem = new Float32Array(0); this.vib = new Float32Array(0);
  }

  /** The status byte: timer flags in bits 5-7, and OPL3's low bits read 0 (an OPL2 reads 6). */
  readStatus() { return this.status; }

  write(array, reg, v) {
    const r = (array << 8) | reg;
    this.reg[r] = v;
    if (array === 1 && reg === 0x05) { this.newMode = (v & 1) === 1; return; }
    if (array === 0) {
      switch (reg) {
        case 0x01: this.wse = (v & 0x20) !== 0; return;
        case 0x02: this.timer1 = v; return;
        case 0x03: this.timer2 = v; return;
        case 0x04:
          if (v & 0x80) { this.status = 0; return; }       // reset the flags
          this.timerCtl = v;
          // a started timer has overflowed by the time a driver reads the status: detection waits
          // longer than either period, so it is honest to raise the flag at once
          if ((v & 1) && !(v & 0x40)) this.status |= 0xc0;
          if ((v & 2) && !(v & 0x20)) this.status |= 0xa0;
          return;
        case 0x08: this.nts = (v >> 6) & 1; return;
        case 0xbd: this.amDepth = v & 0x80 ? 4.8 : 1; this.vibDepth = v & 0x40 ? 14 : 7; return;
      }
    }
    const base = array === 0 ? 0 : 9;
    if (reg >= 0x20 && reg <= 0xf5 && reg < 0xa0 || reg >= 0xe0) {
      const opi = OP_SLOT[reg & 0x1f];
      if (opi < 0) return;
      const ch = this.chans[base + Math.floor(opi / 2)], op = ch.ops[opi % 2];
      switch (reg & 0xe0) {
        case 0x20: op.am = (v >> 7) & 1; op.vib = (v >> 6) & 1; op.egt = (v >> 5) & 1; op.ksr = (v >> 4) & 1; op.mult = MULT[v & 15]; return;
        case 0x40: op.ksl = (v >> 6) & 3; op.tl = v & 0x3f; return;
        case 0x60: op.ar = (v >> 4) & 15; op.dr = v & 15; return;
        case 0x80: op.sl = (v >> 4) & 15; op.rr = v & 15; if (op.stage === EG_SUSTAIN && op.env < this.slDb(op)) op.stage = EG_DECAY; return;
        case 0xe0: op.wave = v & 7; return;
      }
      return;
    }
    if (reg >= 0xa0 && reg <= 0xa8) { const ch = this.chans[base + reg - 0xa0]; ch.fnum = (ch.fnum & 0x300) | v; return; }
    if (reg >= 0xb0 && reg <= 0xb8) {
      const ch = this.chans[base + reg - 0xb0];
      ch.fnum = (ch.fnum & 0xff) | ((v & 3) << 8);
      ch.block = (v >> 2) & 7;
      const key = (v & 0x20) !== 0;
      if (key && !ch.key) for (const op of ch.ops) { op.stage = EG_ATTACK; op.phase = 0; }
      if (!key && ch.key) for (const op of ch.ops) if (op.stage !== EG_OFF) op.stage = EG_RELEASE;
      ch.key = key;
      return;
    }
    if (reg >= 0xc0 && reg <= 0xc8) {
      const ch = this.chans[base + reg - 0xc0];
      ch.fb = (v >> 1) & 7; ch.cnt = v & 1;
      ch.left = (v & 0x10) !== 0; ch.right = (v & 0x20) !== 0;
    }
  }

  slDb(op) { return op.sl === 15 ? 93 : op.sl * 3; }

  effRate(ch, op, r) {
    if (r === 0) return 0;
    const rof = (ch.block << 1) | ((ch.fnum >> (this.nts ? 8 : 9)) & 1);
    return Math.min(63, r * 4 + (op.ksr ? rof : rof >> 2));
  }

  /**
   * Mix `n` stereo frames into out[off..] (added, not replaced). Registers do not change inside a
   * call -- the machine writes them between calls -- so everything that depends only on them (a
   * channel's frequency, an operator's level and envelope rates) is worked out once per call, and
   * the per-sample loop is phase, envelope and a table read.
   */
  render(out, off, n) {
    const dt = 1 / this.rate;
    const waveMask = this.newMode ? 7 : this.wse ? 3 : 0;
    if (this.trem.length < n) { this.trem = new Float32Array(n); this.vib = new Float32Array(n); }
    const trem = this.trem, vib = this.vib;
    const vibScale = this.vibDepth * Math.LN2 / 1200;       // cents to a frequency ratio, to first order
    for (let i = 0; i < n; i++) {
      this.lfoAm += 3.7 * dt; if (this.lfoAm >= 1) this.lfoAm -= 1;
      this.lfoVib += 6.1 * dt; if (this.lfoVib >= 1) this.lfoVib -= 1;
      trem[i] = LFO_TREM[(this.lfoAm * 256) | 0] * this.amDepth;
      vib[i] = 1 + WAVES[0][(this.lfoVib * WAVE_LEN) | 0] * vibScale;
    }
    for (let c = 0; c < 18; c++) {
      const ch = this.chans[c];
      const m = ch.ops[0], k = ch.ops[1];
      if (m.stage === EG_OFF && k.stage === EG_OFF) continue;
      if (c >= 9 && !this.newMode) continue;
      const cycles = ch.fnum * (1 << ch.block) * OPL_RATE / 1048576 * dt;   // one cycle a sample = 1
      const kslDb = Math.max(0, KSL_TABLE[ch.fnum >> 6] - 6 * (7 - ch.block));
      this.prepare(ch, m, cycles, kslDb, dt, waveMask);
      this.prepare(ch, k, cycles, kslDb, dt, waveMask);
      const fb = ch.fb ? Math.pow(2, ch.fb - 6) * 0.5 : 0;
      const gl = (!this.newMode || ch.left) ? 0.11 : 0, gr = (!this.newMode || ch.right) ? 0.11 : 0;
      for (let i = 0; i < n; i++) {
        // modulator, with feedback from its own last two outputs
        const mo = this.sample(ch, m, fb ? (m.out + m.prev) * fb : 0, trem[i], vib[i]);
        m.prev = m.out; m.out = mo;
        const s = ch.cnt === 0 ? this.sample(ch, k, mo * 4, trem[i], vib[i]) : mo + this.sample(ch, k, 0, trem[i], vib[i]);
        out[off + i * 2] += s * gl;
        out[off + i * 2 + 1] += s * gr;
      }
    }
  }

  // the per-call constants of one operator, stored on it
  prepare(ch, op, cycles, kslDb, dt, waveMask) {
    const at = oplRateTimes(this.effRate(ch, op, op.ar)).attack;
    op.attackK = at === 0 ? -1 : at === Infinity ? 0 : (dt / at) * 3.22;
    const dtime = oplRateTimes(this.effRate(ch, op, op.dr)).decay;
    op.decayInc = dtime === Infinity ? 0 : MAX_DB * dt / dtime;
    const rtime = oplRateTimes(this.effRate(ch, op, op.rr)).decay;
    op.releaseInc = rtime === Infinity ? 0 : MAX_DB * dt / rtime;
    op.slLevel = this.slDb(op);
    op.levelDb = op.tl * 0.75 + kslDb * KSL_SCALE[op.ksl];
    op.inc = cycles * op.mult;
    op.table = WAVES[op.wave & waveMask];
  }

  sample(ch, op, pm, trem, vib) {
    // envelope, in dB of attenuation
    switch (op.stage) {
      case EG_ATTACK:
        // the chip's attack is exponential in dB: fast at first, easing into full level
        if (op.attackK < 0) op.env = 0; else op.env -= (op.env + 4) * op.attackK;
        if (op.env <= 0) { op.env = 0; op.stage = EG_DECAY; }
        break;
      case EG_DECAY:
        op.env += op.decayInc;
        if (op.env >= op.slLevel) { op.env = op.slLevel; op.stage = EG_SUSTAIN; }
        break;
      case EG_SUSTAIN:
        if (!op.egt) op.env += op.releaseInc;               // a percussive sound keeps decaying
        break;
      case EG_RELEASE:
        op.env += op.releaseInc;
        break;
      default:
        return 0;
    }
    if (op.env >= MAX_DB) {
      op.env = MAX_DB;
      if (op.stage === EG_RELEASE || !ch.key) op.stage = EG_OFF;
    }
    op.phase += op.vib ? op.inc * vib : op.inc;
    if (op.phase >= 1) op.phase -= Math.floor(op.phase);
    const db = op.env + op.levelDb + (op.am ? trem : 0);
    if (db >= MAX_DB) return 0;
    let p = op.phase + pm;
    p -= Math.floor(p);
    return op.table[(p * WAVE_LEN) | 0] * DB_TO_AMP[(db * DB_STEPS) | 0];
  }
}
// register offset (low 5 bits of 0x20..0x95, 0xE0..0xF5) -> operator slot: channel * 2 + (0 mod, 1 car)
const OP_SLOT = [0, 2, 4, 1, 3, 5, -1, -1, 6, 8, 10, 7, 9, 11, -1, -1, 12, 14, 16, 13, 15, 17, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];

// ------------------------------------------------------------------ the card
/**
 * A Sound Blaster Pro 2 at `base` (0x220), IRQ `irq`, 8-bit DMA `dma`, with its OPL3 at 0x388 too.
 * `mem` is the machine's memory (DMA reads it). Output is stereo at `rate`.
 */
export function createSoundCard({ mem, base = 0x220, irq = 7, dma = 1, rate = 48000, ring = 1 << 16 } = {}) {
  const opl = new Opl3(rate);
  const dsp = {
    resetting: false, queue: [], cmd: -1, args: [], need: 0,
    speaker: true, rate: 11025, stereo: false, blockSize: 0x7ff,
    playing: false, auto: false, paused: false, left: 0, exitAuto: false,
    irqPending: false, test: 0, level: 0, lastSample: 0x80, pos: 0,
    irqAt: -1,
  };
  const dmac = {
    addr: new Uint16Array(4), count: new Uint16Array(4), baseAddr: new Uint16Array(4), baseCount: new Uint16Array(4),
    page: new Uint8Array(4), mode: new Uint8Array(4), mask: 0x0f, flip: false, status: 0,
  };
  const mixer = { index: 0, reg: new Uint8Array(256) };
  mixer.reg[0x22] = 0xff; mixer.reg[0x04] = 0xff; mixer.reg[0x26] = 0xff;
  const PAGE_PORT = [0x87, 0x83, 0x81, 0x82];

  // output ring: interleaved stereo float frames
  const buf = new Float32Array(ring * 2);
  let head = 0, count = 0;
  const scratch = new Float32Array(8192);
  let lastT = -1, outFrac = 0, dspFrac = 0;
  let pendingIrq = null;

  function resetDsp() {
    dsp.playing = false; dsp.auto = false; dsp.paused = false; dsp.cmd = -1; dsp.need = 0; dsp.args = [];
    dsp.queue = [0xaa]; dsp.stereo = false; dsp.exitAuto = false;
  }
  function command(c) {
    dsp.cmd = c; dsp.args = [];
    const needs = { 0x10: 1, 0x14: 2, 0x16: 2, 0x17: 2, 0x24: 2, 0x40: 1, 0x41: 2, 0x42: 2, 0x48: 2, 0x74: 2, 0x75: 2, 0x76: 2, 0x77: 2, 0x80: 2, 0xe0: 1, 0xe2: 1, 0xe4: 1 };
    if ((c & 0xf0) === 0xb0 || (c & 0xf0) === 0xc0) dsp.need = 3;
    else dsp.need = needs[c] ?? 0;
    if (dsp.need === 0) execute();
  }
  function startBlock(len, auto) {
    dsp.left = len; dsp.auto = auto; dsp.playing = true; dsp.paused = false; dsp.exitAuto = false;
  }
  function execute() {
    const c = dsp.cmd, a = dsp.args;
    dsp.cmd = -1;
    switch (c) {
      case 0x10: dsp.level = a[0]; dsp.lastSample = a[0]; return;
      case 0x14: case 0x16: case 0x17: case 0x91: startBlock(c === 0x91 ? dsp.blockSize + 1 : (a[0] | (a[1] << 8)) + 1, false); return;
      case 0x1c: case 0x90: startBlock(dsp.blockSize + 1, true); return;
      case 0x20: dsp.queue.push(0x80); return;
      case 0x40: dsp.rate = Math.round(1000000 / (256 - a[0])); return;
      case 0x41: case 0x42: dsp.rate = (a[0] << 8) | a[1]; return;
      case 0x48: dsp.blockSize = a[0] | (a[1] << 8); return;
      case 0x80: dsp.silence = (a[0] | (a[1] << 8)) + 1; startBlock(dsp.silence, false); dsp.silent = true; return;
      case 0xa0: dsp.stereo = false; return;
      case 0xa8: dsp.stereo = true; return;
      case 0xd0: dsp.paused = true; return;
      case 0xd1: dsp.speaker = true; return;
      case 0xd3: dsp.speaker = false; return;
      case 0xd4: dsp.paused = false; return;
      case 0xd8: dsp.queue.push(dsp.speaker ? 0xff : 0x00); return;
      case 0xda: dsp.exitAuto = true; return;
      case 0xe0: dsp.queue.push(~a[0] & 0xff); return;
      case 0xe1: dsp.queue.push(3, 2); return;
      case 0xe3: for (const ch of 'COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.\0') dsp.queue.push(ch.charCodeAt(0)); return;
      case 0xe4: dsp.test = a[0]; return;
      case 0xe8: dsp.queue.push(dsp.test); return;
      case 0xf2: case 0xf3: pendingIrq = 'soon'; return;
      case 0xf8: dsp.queue.push(0); return;
    }
    if ((c & 0xf0) === 0xb0 || (c & 0xf0) === 0xc0) {
      // SB16 transfers: mode byte then a length; the 8-bit ones are the ones this card honours
      startBlock((a[1] | (a[2] << 8)) + 1, (c & 0x04) !== 0);
      dsp.stereo = (a[0] & 0x20) !== 0;
    }
  }

  // one sample off DMA: returns 0..255, or -1 when the channel has nothing
  function dmaByte() {
    const ch = dma & 3;
    if (dmac.mask & (1 << ch)) return -1;
    const addr = (dmac.page[ch] << 16) | dmac.addr[ch];
    const v = mem[addr];
    dmac.addr[ch] = (dmac.addr[ch] + ((dmac.mode[ch] & 0x20) ? -1 : 1)) & 0xffff;
    dmac.count[ch] = (dmac.count[ch] - 1) & 0xffff;
    if (dmac.count[ch] === 0xffff) {
      dmac.status |= 1 << ch;
      if (dmac.mode[ch] & 0x10) { dmac.addr[ch] = dmac.baseAddr[ch]; dmac.count[ch] = dmac.baseCount[ch]; }
      else dmac.mask |= 1 << ch;
    }
    return v;
  }

  function portIn(port) {
    if (port === 0x388 || port === 0x38a || port === base + 8 || port === base) return opl.readStatus();
    if (port === base + 0x0a) { if (dsp.queue.length) dsp.last = dsp.queue.shift(); return dsp.last ?? 0xaa; }
    if (port === base + 0x0c) return 0x7f;                          // ready for a command
    if (port === base + 0x0e) { dsp.irqPending = false; return dsp.queue.length ? 0xff : 0x7f; }
    if (port === base + 0x04) return mixer.index;
    if (port === base + 0x05) return mixer.reg[mixer.index];
    if (port === base + 0x06) return 0xff;
    if (port <= 0x07) {
      const ch = port >> 1, isCount = port & 1;
      const v = isCount ? dmac.count[ch] : dmac.addr[ch];
      const r = dmac.flip ? v >> 8 : v & 0xff;
      dmac.flip = !dmac.flip;
      return r;
    }
    if (port === 0x08) { const s = dmac.status; dmac.status &= 0xf0; return s; }
    return undefined;
  }

  function portOut(port, v) {
    if (port === 0x388 || port === base + 8 || port === base) { opl.index[0] = v; return true; }
    if (port === 0x389 || port === base + 9 || port === base + 1) { opl.write(0, opl.index[0], v); return true; }
    if (port === 0x38a || port === base + 2) { opl.index[1] = v; return true; }
    if (port === 0x38b || port === base + 3) { opl.write(1, opl.index[1], v); return true; }
    if (port === base + 0x06) {
      if (v & 1) { dsp.resetting = true; return true; }
      if (dsp.resetting) { dsp.resetting = false; resetDsp(); }
      return true;
    }
    if (port === base + 0x0c) {
      if (dsp.cmd >= 0) { dsp.args.push(v); if (dsp.args.length >= dsp.need) execute(); }
      else command(v);
      return true;
    }
    if (port === base + 0x04) { mixer.index = v; return true; }
    if (port === base + 0x05) { mixer.reg[mixer.index] = v; if (mixer.index === 0x00) mixer.reg.fill(0); return true; }
    if (port <= 0x07) {
      const ch = port >> 1, isCount = port & 1;
      const arr = isCount ? dmac.count : dmac.addr, baseArr = isCount ? dmac.baseCount : dmac.baseAddr;
      arr[ch] = dmac.flip ? (arr[ch] & 0xff) | (v << 8) : (arr[ch] & 0xff00) | v;
      baseArr[ch] = arr[ch];
      dmac.flip = !dmac.flip;
      return true;
    }
    if (port === 0x0a) { if (v & 4) dmac.mask |= 1 << (v & 3); else dmac.mask &= ~(1 << (v & 3)); return true; }
    if (port === 0x0b) { dmac.mode[v & 3] = v; return true; }
    if (port === 0x0c) { dmac.flip = false; return true; }
    if (port === 0x0f) { dmac.mask = v & 0x0f; return true; }
    const pi = PAGE_PORT.indexOf(port);
    if (pi >= 0) { dmac.page[pi] = v; return true; }
    return false;
  }

  function push(l, r) {
    if (count === ring) { head = (head + 1) % ring; count--; }      // overrun: drop the oldest
    const at = (head + count) % ring;
    buf[at * 2] = l; buf[at * 2 + 1] = r;
    count++;
  }

  /** Advance the card to machine time `t` (ms), raising its interrupt through `raiseIrq`. */
  function tick(t, raiseIrq) {
    if (pendingIrq === 'soon') { pendingIrq = null; dsp.irqPending = true; raiseIrq(irq); }
    if (lastT < 0) { lastT = t; return; }
    // the machine calls this every few thousand instructions -- a sample or two each time. Work in
    // batches of at least 128 frames (under 3 ms): a DSP block is thousands of samples, so its
    // interrupt is no later for it, and the synthesiser's per-call set-up is paid 300 times a
    // second instead of 40,000
    if ((t - lastT) * rate / 1000 + outFrac < 128) return;
    let ms = t - lastT;
    lastT = t;
    if (ms <= 0) return;
    if (ms > 200) ms = 200;                                          // a stall is not replayed as a burst
    outFrac += ms * rate / 1000;
    let n = Math.floor(outFrac);
    outFrac -= n;
    const step = dsp.rate / rate / (dsp.stereo ? 2 : 1);
    let off = 0;
    while (n > 0) {
      const k = Math.min(n, scratch.length >> 1);
      scratch.fill(0, 0, k * 2);
      opl.render(scratch, 0, k);
      for (let i = 0; i < k; i++) {
        let s = 0;
        if (dsp.playing && !dsp.paused) {
          dspFrac += step;
          while (dspFrac >= 1 && dsp.playing) {
            dspFrac -= 1;
            if (dsp.silent) dsp.lastSample = 0x80;
            else { const b = dmaByte(); if (b >= 0) dsp.lastSample = b; }
            if (--dsp.left <= 0) {
              dsp.irqPending = true; raiseIrq(irq);
              if (dsp.auto && !dsp.exitAuto) dsp.left = dsp.blockSize + 1;
              else { dsp.playing = false; dsp.silent = false; dsp.lastSample = 0x80; }
            }
          }
        }
        if (dsp.speaker) s = (dsp.lastSample - 128) / 128 * 0.9;
        push(scratch[i * 2] + s, scratch[i * 2 + 1] + s);
      }
      n -= k; off += k;
    }
  }

  /** Take up to `max` frames of output (interleaved stereo), or all there is. */
  function drain(max = count) {
    const n = Math.min(max, count);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { const at = (head + i) % ring; out[i * 2] = buf[at * 2]; out[i * 2 + 1] = buf[at * 2 + 1]; }
    head = (head + n) % ring; count -= n;
    return out;
  }

  return { opl, dsp, dmac, mixer, portIn, portOut, tick, drain, get buffered() { return count; }, rate };
}
