// A QR ENCODER, because Core's receive dialog has one and this codebase has no dependencies.
//
// Operator, 2026-09-18: "...and I believe it generates a qr code for the new address". It
// does — ReceiveRequestDialog draws a QR of the BIP21 URI. Adding a library for it was
// never an option here: the zero-dependency rule is what makes the suite auditable, and
// `script-src 'self'` forbids a CDN even if it were.
//
// So this is QR encoding, byte mode, error correction level M, versions 1–10 — which
// covers every address and BIP21 URI this suite will ever draw (a bech32m mainnet address
// in a URI is about 75 characters; version 10 holds 213 bytes at level M).
//
// HOW IT IS CHECKED, AND HOW IT ONCE WAS NOT. A QR code that is subtly wrong scans as a
// different address or as nothing, and "it looked like a QR code" is not evidence. The
// first version of this header (2026-09-18) said the test compared this encoder against
// segno "module for module". It did not: it compared the function patterns only, and read
// the payload back through a reader that skipped the error-correction codewords and the
// version-information areas. Both were wrong here -- the Reed-Solomon remainder used the
// generator backwards and one term off, and versions 7-10 wrote no version information,
// snaking data through the two blocks instead -- and every test passed. Found in review on
// 2026-09-19: not one symbol this file drew decoded in OpenCV, from version 2 to 10.
//
// Since then test/qr.test.js checks the ISO/IEC 18004 worked example's EC codewords
// exactly, checks every block's syndromes and both version blocks on every read-back, and
// compares the WHOLE matrix against segno when segno can be had. Measured 2026-09-19 with
// OpenCV 5.0 (a scratch check, not a repo test: the suite does not depend on Python): 22
// P2WPKH and P2TR BIP21 payloads spanning versions 2-10, each drawn at all eight masks --
// every symbol at the mask this file chooses decoded to the exact input in both of
// OpenCV's detectors, and all 176 in QRCodeDetectorAruco. The classic QRCodeDetector
// missed two unchosen masks on a perfect pixel grid and read both once rotated 7 degrees;
// it misses segno's own symbol at one of the same two, so that is the detector's
// localisation, not the content. Before the fix, none of the 176 decoded.
//
// The pieces, in the order the standard applies them: encode the data, add error
// correction over GF(256), interleave the blocks, place the modules on the grid, try the
// eight masks, score them as the standard prescribes, and write the format bits.

// ---------------------------------------------------------------- GF(256) arithmetic
// The Reed-Solomon field of the QR standard: generator 2, primitive polynomial 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

/**
 * The error-correction codewords for one block: the data, times x^degree, modulo the
 * generator.
 *
 * `rsGenerator` returns the coefficients LOWEST degree first -- index `degree` holds the
 * monic leading 1 -- while `rem` below is kept HIGHEST degree first, so the term that
 * lines up with rem[i] is gen[degree - 1 - i]. Until 2026-09-19 this read gen[i + 1],
 * which is the right term only for a generator stored the other way round; every EC
 * codeword came out wrong ('01234567' at 1-M gave 7b a6 46 ... where the standard prints
 * a5 24 d4 ...) and no scanner could read the result.
 */
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[degree - 1 - i], factor);
  }
  return rem;
}

// -------------------------------------------------------------- version parameters
// Per version (1–10) at error-correction level M: total codewords, EC codewords per
// block, and the block layout [count, dataCodewords] groups. From the tables in
// ISO/IEC 18004; the test cross-checks the capacities that follow from them.
const VERSIONS = {
  1: { total: 26, ecPerBlock: 10, groups: [[1, 16]] },
  2: { total: 44, ecPerBlock: 16, groups: [[1, 28]] },
  3: { total: 70, ecPerBlock: 26, groups: [[1, 44]] },
  4: { total: 100, ecPerBlock: 18, groups: [[2, 32]] },
  5: { total: 134, ecPerBlock: 24, groups: [[2, 43]] },
  6: { total: 172, ecPerBlock: 16, groups: [[4, 27]] },
  7: { total: 196, ecPerBlock: 18, groups: [[4, 31]] },
  8: { total: 242, ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  9: { total: 292, ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  10: { total: 346, ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
};

/** Where the alignment patterns go, per version. */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const dataCapacity = (v) => VERSIONS[v].groups.reduce((n, [count, words]) => n + count * words, 0);

// THE TABLE CHECKS ITSELF (2026-09-18). Version 9 was entered as [[3,36],[4,37]] -- seven
// blocks where the standard has five -- which made version 9 claim MORE data capacity than
// version 10, and would have produced a symbol no scanner could read. A transcription
// error in a table like this cannot be seen by reading it; it can be seen by asking whether
// the numbers agree with each other, which is what this does at module load.
for (const [v, spec] of Object.entries(VERSIONS)) {
  const blocks = spec.groups.reduce((n, [count]) => n + count, 0);
  const total = spec.groups.reduce((n, [count, words]) => n + count * (words + spec.ecPerBlock), 0);
  if (total !== spec.total) {
    throw new Error(`QR table: version ${v} says ${spec.total} codewords but its blocks add to ${total}`);
  }
  if (blocks < 1) throw new Error(`QR table: version ${v} has no blocks`);
}
for (let v = 2; v <= 10; v++) {
  if (dataCapacity(v) <= dataCapacity(v - 1)) {
    throw new Error(`QR table: version ${v} holds no more than version ${v - 1}`);
  }
}

/** The smallest version that holds this many bytes in byte mode at level M. */
function pickVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    // 4 bits mode + 8 or 16 bits length + the data itself, in whole codewords.
    const lengthBits = v < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lengthBits + byteLength * 8) / 8);
    if (needed <= dataCapacity(v)) return v;
  }
  throw new Error(`${byteLength} bytes is more than this encoder handles (version 10 at level M)`);
}

// ------------------------------------------------------------------------ bit stream
class Bits {
  constructor() { this.bits = []; }
  push(value, length) { for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1); }
  get length() { return this.bits.length; }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out.push(byte);
    }
    return out;
  }
}

/** Data codewords: mode, length, payload, terminator, padding. */
function encodeData(bytes, version) {
  const capacity = dataCapacity(version) * 8;
  const bits = new Bits();
  bits.push(0b0100, 4);                       // byte mode
  bits.push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) bits.push(b, 8);
  bits.push(0, Math.min(4, capacity - bits.length));   // terminator
  while (bits.length % 8 !== 0) bits.push(0, 1);
  const words = bits.toBytes();
  // The standard's own alternating pad bytes, until the version is full.
  const pad = [0xec, 0x11];
  for (let i = 0; words.length < dataCapacity(version); i++) words.push(pad[i % 2]);
  return words;
}

/** Interleave the data and EC blocks, as the standard requires. */
function buildCodewords(dataWords, version) {
  const { ecPerBlock, groups } = VERSIONS[version];
  const blocks = [];
  let at = 0;
  for (const [count, words] of groups) {
    for (let i = 0; i < count; i++) {
      const data = dataWords.slice(at, at + words);
      at += words;
      blocks.push({ data, ec: rsRemainder(data, ecPerBlock) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// -------------------------------------------------------------------- module placement
function emptyGrid(size) {
  return {
    size,
    // null means "not yet written", which is how the data path knows what to skip.
    cells: Array.from({ length: size }, () => new Array(size).fill(null)),
    fixed: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function place(grid, x, y, dark, fixed = true) {
  grid.cells[y][x] = dark ? 1 : 0;
  grid.fixed[y][x] = fixed;
}

function finder(grid, cx, cy) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) continue;
      const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      place(grid, x, y, inRing);
    }
  }
}

function alignment(grid, version) {
  const centres = ALIGN[version];
  for (const cy of centres) {
    for (const cx of centres) {
      // Not where the finders already are.
      if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= grid.size - 9) || (cx >= grid.size - 9 && cy <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          place(grid, cx + dx, cy + dy, ring !== 1);
        }
      }
    }
  }
}

function timing(grid) {
  for (let i = 8; i < grid.size - 8; i++) {
    place(grid, i, 6, i % 2 === 0);
    place(grid, 6, i, i % 2 === 0);
  }
}

/** Reserve the format areas; the bits themselves are written after masking. */
function reserveFormat(grid) {
  for (let i = 0; i < 9; i++) {
    if (grid.cells[8][i] === null) place(grid, i, 8, false);
    if (grid.cells[i][8] === null) place(grid, 8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    place(grid, grid.size - 1 - i, 8, false);
    place(grid, 8, grid.size - 1 - i, false);
  }
  place(grid, 8, grid.size - 8, true);   // the always-dark module
}

/**
 * Version information, versions 7 and up: the version number in six bits and a BCH(18,6)
 * remainder over the generator 0x1F25, unmasked. A scanner reads the version from here on
 * these sizes rather than trusting the module count.
 */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

/**
 * Write both 6x3 version blocks: above the bottom-left finder and, transposed, left of the
 * top-right one. Written before the data is placed, so the data path goes around them.
 * Missing until 2026-09-19, when data was snaked straight through both blocks.
 */
function drawVersion(grid, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    place(grid, a, b, dark);
    place(grid, b, a, dark);
  }
}

/** Snake the codewords up and down the grid, skipping everything already placed. */
function placeData(grid, codewords) {
  let bitIndex = 0;
  const bitAt = (i) => (i >> 3) < codewords.length ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0;
  let upward = true;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;   // the vertical timing column is skipped entirely
    for (let step = 0; step < grid.size; step++) {
      const y = upward ? grid.size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (grid.cells[y][x] !== null) continue;
        place(grid, x, y, bitAt(bitIndex) === 1, false);
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The standard's four penalty rules, which decide which mask is used. */
function penalty(cells) {
  const n = cells.length;
  let score = 0;

  // Rule 1: runs of five or more of the same colour, in both directions.
  for (const line of [...cells, ...cells[0].map((_, x) => cells.map((row) => row[x]))]) {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (line[i] === line[i - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
      else run = 1;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = cells[y][x];
      if (v === cells[y][x + 1] && v === cells[y + 1][x] && v === cells[y + 1][x + 1]) score += 3;
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules either side.
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const lines = [...cells, ...cells[0].map((_, x) => cells.map((row) => row[x]))];
  for (const line of lines) {
    for (let i = 0; i + 11 <= n; i++) {
      const slice = line.slice(i, i + 11);
      if (p1.every((v, j) => v === slice[j]) || p2.every((v, j) => v === slice[j])) score += 40;
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  const dark = cells.flat().reduce((a, b) => a + b, 0);
  const ratio = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/** Format information: EC level M (0b00) and the mask, BCH-encoded and XOR-masked. */
function formatBits(mask) {
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function writeFormat(grid, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) place(grid, 8, i, bit(i));
  place(grid, 8, 7, bit(6));
  place(grid, 8, 8, bit(7));
  place(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) place(grid, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) place(grid, grid.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) place(grid, 8, grid.size - 15 + i, bit(i));
  place(grid, 8, grid.size - 8, true);
}

/**
 * Encode `text` and return `{ size, modules }`, modules being a size×size array of 0/1
 * where 1 is dark.
 */
export function encodeQr(text, { forceMask = null } = {}) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const version = pickVersion(bytes.length);
  const size = 17 + version * 4;
  const codewords = buildCodewords(encodeData(bytes, version), version);

  const base = emptyGrid(size);
  finder(base, 0, 0);
  finder(base, size - 7, 0);
  finder(base, 0, size - 7);
  alignment(base, version);
  timing(base);
  reserveFormat(base);
  drawVersion(base, version);
  placeData(base, codewords);

  // Try every mask, keep the one the standard's penalty rules like best. `forceMask` is
  // for the test that compares each candidate against an independent implementation --
  // without it a disagreement cannot be told apart from a disagreement about scoring.
  let best = null;
  const candidates = [];
  for (let m = 0; m < 8; m++) {
    const cells = base.cells.map((row, y) => row.map((v, x) => (base.fixed[y][x] ? v : v ^ (MASKS[m](x, y) ? 1 : 0))));
    const grid = { size, cells, fixed: base.fixed };
    writeFormat(grid, m);
    const score = penalty(grid.cells);
    candidates.push({ mask: m, score, cells: grid.cells });
    if (!best || score < best.score) best = { score, cells: grid.cells, mask: m };
  }
  if (forceMask != null) best = candidates[forceMask];
  return { size, version, mask: best.mask, modules: best.cells, candidates };
}

/**
 * The pieces the tests check against the standard directly (ISO/IEC 18004's worked example
 * and Annex D's version table). Not for the suite's own use.
 */
export const qrInternals = Object.freeze({ rsRemainder, versionBits });

/** The BIP21 URI Core puts in the code, rather than the bare address. */
export function paymentUri(address, { label = '', amountSat = null } = {}) {
  const params = [];
  if (amountSat) params.push(`amount=${(amountSat / 1e8).toFixed(8)}`);
  if (label) params.push(`label=${encodeURIComponent(label)}`);
  return `bitcoin:${address}${params.length ? `?${params.join('&')}` : ''}`;
}

/** Draw a matrix into a canvas element, with the quiet zone the standard requires. */
export function drawQr(canvas, { size, modules }, { scale = 5, quiet = 4 } = {}) {
  const px = (size + quiet * 2) * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  // The quiet zone is not decoration: without four light modules around it, many scanners
  // will not see the code at all.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
  return canvas;
}
