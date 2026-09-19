// THE QR ENCODER (public/js/admin/qr.js), checked four ways.
//
// A QR code that is subtly wrong scans as a different string, or as nothing, and the
// string here is a bitcoin address. "It looked like a QR code" is evidence of nothing, and
// -- as 2026-09-19 showed -- neither is a round trip through a reader that skips the parts
// the encoder got wrong. So:
//
//   1. ROUND TRIP. Every matrix is read back -- walked, unmasked, de-interleaved, parsed --
//      and must yield the exact bytes that went in. The reader is written from the
//      standard's own description rather than by calling back into the encoder.
//   2. THE ERROR CORRECTION IS CHECKED, NOT SKIPPED. Every block read back must be a valid
//      Reed-Solomon codeword: all of its syndromes zero. This is computed by evaluating the
//      block as a polynomial at the generator's roots, which shares no code with the
//      encoder's long division.
//   3. THE VERSION INFORMATION IS CHECKED, NOT SKIPPED. From version 7 up, both 6x3 blocks
//      must carry the 18-bit BCH word the standard tabulates for that version.
//   4. AGAINST THE PUBLISHED EXAMPLE AND AN INDEPENDENT IMPLEMENTATION. ISO/IEC 18004's
//      worked example must give the EC codewords the standard prints; segno (a Python QR
//      library, installed into a temp directory for the test only, never shipped, skipped
//      when it cannot be had) must draw the same matrix at the same mask.
//
// WHY 2 AND 3 EXIST (2026-09-19). Until then this reader parsed only the DATA codewords, and
// its map of function modules left out the version-information areas. The encoder had a
// Reed-Solomon bug (every EC codeword wrong) and wrote no version information at all from
// version 7 up -- data sat where the version blocks belong -- and every test here passed,
// because the reader skipped exactly those two things in exactly the same way. OpenCV's
// decoder, given the same symbols, read not one of them. A reader that checks only what the
// encoder already agrees with is an echo, whatever its comments say.
//
// WHERE THIS DELIBERATELY DOES NOT MATCH SEGNO: the pad codewords. segno 1.6.6 adds
// `8 - (length % 8)` padding bits after the terminator (encoder.py, write_padding_bits),
// which is a whole zero byte when the stream already ends on a byte boundary -- and in byte
// mode it always does. The standard pads to the boundary and goes straight to 0xEC/0x11, as
// its own worked example shows, and so does this encoder. Read 2026-09-19, when the full
// comparison below was added. So the whole-matrix comparison uses payloads that fill their
// version exactly, where there are no pad codewords to disagree about; for every other
// payload the function modules and the decoded content are compared instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as qr from '../public/js/admin/qr.js';

const { encodeQr, paymentUri, drawQr } = qr;

// ------------------------------------------------------------------- the reader
// Written from the standard, not from the encoder: the point is to disagree with the
// encoder if the encoder is wrong.

const VERSION_BLOCKS = {
  1: { ec: 10, groups: [[1, 16]] }, 2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] }, 4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] }, 6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] }, 8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] }, 10: { ec: 26, groups: [[4, 43], [1, 44]] },
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Which modules are function modules, for a symbol of this version. */
function functionMap(size, version) {
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) fixed[y][x] = true; };
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) mark(ox + dx, oy + dy);
  }
  for (const cy of ALIGN[version]) {
    for (const cx of ALIGN[version]) {
      if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy);
    }
  }
  for (let i = 0; i < size; i++) { mark(i, 6); mark(6, i); }
  for (let i = 0; i < 9; i++) { mark(i, 8); mark(8, i); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  // The two version-information blocks, from version 7 up: 6 rows x 3 columns above the
  // bottom-left finder, and its transpose left of the top-right one. Leaving these out is
  // how this map once agreed with an encoder that wrote data into them.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      mark(size - 11 + (i % 3), Math.floor(i / 3));
      mark(Math.floor(i / 3), size - 11 + (i % 3));
    }
  }
  return fixed;
}

/** Read the codewords out of a matrix, undoing the mask on the way. */
function readCodewords(modules, version, mask) {
  const size = modules.length;
  const fixed = functionMap(size, version);
  const m = MASKS[mask];
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (fixed[y][x]) continue;
        bits.push(modules[y][x] ^ (m(x, y) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    words.push(b);
  }
  return words;
}

/** Undo the block interleaving: each block's data codewords and its EC codewords. */
function deinterleave(words, version) {
  const { ec, groups } = VERSION_BLOCKS[version];
  const sizes = groups.flatMap(([count, len]) => new Array(count).fill(len));
  const blocks = sizes.map(() => ({ data: [], ec: [] }));
  let at = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < sizes.length; b++) if (i < sizes[b]) blocks[b].data.push(words[at++]);
  }
  for (let i = 0; i < ec; i++) for (const b of blocks) b.ec.push(words[at++]);
  return blocks;
}

// GF(256) for the syndrome check, built here rather than imported: the check must not
// share its arithmetic with the thing it checks.
const GF_EXP = [];
const GF_LOG = [];
for (let i = 0, x = 1; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
const gfMul = (a, b) => (a && b ? GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255] : 0);

/**
 * The syndromes of one block: the block (data then EC, highest degree first) evaluated at
 * alpha^0 .. alpha^(ec-1), the roots of the QR generator polynomial. A block the encoder got
 * right gives all zeros; any wrong EC codeword makes at least one of them non-zero.
 */
function syndromes(block, ec) {
  const word = [...block.data, ...block.ec];
  const out = [];
  for (let i = 0; i < ec; i++) {
    let acc = 0;
    for (const c of word) acc = gfMul(acc, GF_EXP[i]) ^ c;   // Horner's rule
    out.push(acc);
  }
  return out;
}

// ISO/IEC 18004 Annex D's table of version information, versions 7-10, as bit strings
// read top (bit 17) to bottom (bit 0). Typed from the table, not computed.
const VERSION_INFO = {
  7: '000111110010010100', 8: '001000010110111100',
  9: '001001101010011001', 10: '001010010011010011',
};

/** Both version-information blocks, each as an 18-character bit string, bit 17 first. */
function readVersionInfo(modules) {
  const size = modules.length;
  const topRight = [];
  const bottomLeft = [];
  for (let i = 17; i >= 0; i--) {
    topRight.push(modules[Math.floor(i / 3)][size - 11 + (i % 3)]);
    bottomLeft.push(modules[size - 11 + (i % 3)][Math.floor(i / 3)]);
  }
  return { topRight: topRight.join(''), bottomLeft: bottomLeft.join('') };
}

/** Parse mode, character count and payload. Byte mode only, which is all this encoder emits. */
function decode(modules, version, mask) {
  const blocks = deinterleave(readCodewords(modules, version, mask), version);
  blocks.forEach((b, i) => assert.ok(syndromes(b, VERSION_BLOCKS[version].ec).every((v) => v === 0),
    `block ${i} of version ${version} (mask ${mask}) is not a Reed-Solomon codeword: its error correction is wrong`));
  if (version >= 7) {
    const vi = readVersionInfo(modules);
    assert.equal(vi.topRight, VERSION_INFO[version], `version ${version}: top-right version information`);
    assert.equal(vi.bottomLeft, VERSION_INFO[version], `version ${version}: bottom-left version information`);
  }
  const data = blocks.flatMap((b) => b.data);
  const bits = data.flatMap((w) => [...Array(8)].map((_, i) => (w >> (7 - i)) & 1));
  let at = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[at++]; return v; };
  const mode = take(4);
  assert.equal(mode, 0b0100, 'byte mode');
  const count = take(version < 10 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(take(8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// --------------------------------------------------------------- the round trip

const PAYLOADS = [
  'x',
  'bcrt1qga25epnygm3uecq25xg7k0ruzz2p6zn0t0yzjk',
  'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  paymentUri('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', { label: 'cold storage' }),
  paymentUri('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', { label: 'a fairly long label for a payment request' }),
  // Long enough to need several error-correction blocks, which is where interleaving
  // either works or quietly scrambles the payload.
  'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?label=' + 'a'.repeat(120),
];

// A taproot URI with a label long enough to need each of versions 7-10: the versions that
// carry version information, which no payload above reached until 2026-09-19.
const TAPROOT = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const BIG = { 7: 40, 8: 55, 9: 95, 10: 115 };
const BIG_PAYLOADS = Object.entries(BIG).map(([v, n]) => [Number(v), paymentUri(TAPROOT, { label: 'L'.repeat(n) })]);
PAYLOADS.push(...BIG_PAYLOADS.map(([, p]) => p));

test('every code reads back as exactly what went in', () => {
  for (const payload of PAYLOADS) {
    const q = encodeQr(payload);
    assert.equal(decode(q.modules, q.version, q.mask), payload,
      `round trip failed at version ${q.version}, mask ${q.mask}, ${payload.length} bytes`);
  }
});

test('every mask reads back the same payload', () => {
  // The mask must not change what the symbol says -- if one of the eight is applied to the
  // wrong modules, only that mask breaks, and the encoder might never pick it.
  const payload = 'bcrt1qga25epnygm3uecq25xg7k0ruzz2p6zn0t0yzjk';
  for (let mask = 0; mask < 8; mask++) {
    const q = encodeQr(payload, { forceMask: mask });
    assert.equal(decode(q.modules, q.version, mask), payload, `mask ${mask} corrupts the payload`);
  }
});

test('multi-block versions interleave and de-interleave correctly', () => {
  // Version 8 and above split the data across blocks of two different sizes, which is the
  // fiddliest part of the format and the easiest to get subtly wrong.
  for (const n of [160, 200, 213]) {
    const payload = 'b'.repeat(n);
    const q = encodeQr(payload);
    assert.ok(q.version >= 8, `${n} bytes should need version 8+, got ${q.version}`);
    assert.equal(decode(q.modules, q.version, q.mask), payload);
  }
});

test('Reed-Solomon: ISO/IEC 18004\'s worked example gives the EC codewords the standard prints', () => {
  // '01234567', version 1-M: sixteen data codewords in, ten EC codewords out. The encoder
  // once gave 7b a6 46 7d 71 a4 1f 53 c5 46 here -- it read the generator polynomial in the
  // wrong order and one term off -- and nothing noticed, because nothing asked.
  const { rsRemainder } = qr.qrInternals ?? {};
  assert.equal(typeof rsRemainder, 'function', 'qr.js must expose rsRemainder through qrInternals for this check');
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(rsRemainder(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  // And the check the round trip uses agrees: the standard's block has zero syndromes.
  assert.deepEqual(syndromes({ data, ec: [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55] }, 10), new Array(10).fill(0));
});

test('versions 7-10 carry the standard\'s version information in both blocks', () => {
  // The BCH words themselves, against Annex D's table...
  const { versionBits } = qr.qrInternals ?? {};
  assert.equal(typeof versionBits, 'function', 'qr.js must expose versionBits through qrInternals');
  for (const [v, bits] of Object.entries(VERSION_INFO)) {
    assert.equal(versionBits(Number(v)).toString(2).padStart(18, '0'), bits, `version ${v} BCH word`);
  }
  // ...and where they land, at every mask: version information is not masked, and the data
  // must go around it rather than through it.
  for (const [v, payload] of BIG_PAYLOADS) {
    for (let mask = 0; mask < 8; mask++) {
      const q = encodeQr(payload, { forceMask: mask });
      assert.equal(q.version, v, `the fixture meant to need version ${v} needs ${q.version}`);
      const vi = readVersionInfo(q.modules);
      assert.equal(vi.topRight, VERSION_INFO[v], `version ${v} mask ${mask}: top-right block`);
      assert.equal(vi.bottomLeft, VERSION_INFO[v], `version ${v} mask ${mask}: bottom-left block`);
      assert.equal(decode(q.modules, v, mask), payload);
    }
  }
});

// ------------------------------------------------ the tables, checked against themselves

test('the version table agrees with itself and grows', () => {
  // Version 9 was once entered with seven blocks instead of five, which made it claim more
  // capacity than version 10. The module refuses to load if that returns, and this says so
  // out loud rather than leaving the check silent.
  for (const [v, spec] of Object.entries(VERSION_BLOCKS)) {
    const q = encodeQr('a'.repeat(4), { forceMask: 0 });
    assert.ok(q, `version table unusable at ${v}`);
  }
  const capacity = (v) => VERSION_BLOCKS[v].groups.reduce((n, [c, w]) => n + c * w, 0);
  for (let v = 2; v <= 10; v++) assert.ok(capacity(v) > capacity(v - 1), `version ${v} holds no more than ${v - 1}`);
});

test('a payload larger than this encoder handles is refused, not mangled', () => {
  assert.throws(() => encodeQr('y'.repeat(250)), /more than this encoder handles/);
});

// ------------------------------------------- against an independent implementation

const LIBS = path.join(os.tmpdir(), 'blockyard-qr-ref');

function reference(text) {
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(LIBS)})
import segno
q = segno.make(sys.argv[1], error='m', micro=False, mode='byte', boost_error=False)
print(json.dumps({"version": q.version, "mask": q.mask, "matrix": [[int(b) for b in row] for row in q.matrix]}))
`;
  try {
    return JSON.parse(execFileSync('python3', ['-c', script, text], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch { return null; }
}

const haveSegno = (() => {
  if (reference('test')) return true;
  try { execFileSync('pip3', ['install', 'segno', '--quiet', '--target', LIBS], { stdio: 'ignore', timeout: 90_000 }); } catch { return false; }
  return Boolean(reference('test'));
})();

// Byte counts that fill each version exactly at level M (mode + count + data + terminator =
// the data capacity), so neither encoder writes a pad codeword.
const EXACT_FILL = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };

test('the whole matrix matches an independent encoder exactly, versions 1-10', { skip: haveSegno ? false : 'segno unavailable' }, () => {
  // Every module, not just the function patterns: the EC codewords and the version
  // information are exactly what a function-patterns-only comparison could not see.
  for (const [v, n] of Object.entries(EXACT_FILL)) {
    const payload = paymentUri(TAPROOT, { label: 'x'.repeat(200) }).slice(0, n);
    const theirs = reference(payload);
    assert.ok(theirs, 'no reference');
    assert.equal(theirs.version, Number(v), `segno chose version ${theirs.version} for ${n} bytes`);
    const mine = encodeQr(payload, { forceMask: theirs.mask });
    assert.equal(mine.version, theirs.version, `version differs for ${n} bytes`);
    let differ = 0;
    for (let y = 0; y < mine.size; y++) {
      for (let x = 0; x < mine.size; x++) if (mine.modules[y][x] !== theirs.matrix[y][x]) differ++;
    }
    assert.equal(differ, 0, `${differ} modules differ at version ${v}, mask ${theirs.mask}`);
    // The mask CHOICE is not compared, on purpose: segno scores the candidates before
    // writing the format bits (it cites ISO/IEC 18004:2015 7.8) and counts a finder-like
    // run touching the symbol's edge, while this encoder scores after writing them, as the
    // 2006 text and Nayuki's reference do. The two differ at version 2 (checked
    // 2026-09-19). Any of the eight masks is a valid symbol -- every one of them is decoded
    // above and by OpenCV -- so the choice changes how well a code scans, not what it says.
  }
});

test('the function patterns match an independent encoder exactly', { skip: haveSegno ? false : 'segno unavailable' }, () => {
  for (const payload of PAYLOADS) {
    const theirs = reference(payload);
    assert.ok(theirs, 'no reference');
    const mine = encodeQr(payload, { forceMask: theirs.mask });
    assert.equal(mine.version, theirs.version, `version differs for ${payload.slice(0, 20)}`);
    const fixed = functionMap(mine.size, mine.version);
    let checked = 0;
    for (let y = 0; y < mine.size; y++) {
      for (let x = 0; x < mine.size; x++) {
        if (!fixed[y][x]) continue;
        checked++;
        assert.equal(mine.modules[y][x], theirs.matrix[y][x],
          `function module ${x},${y} differs (version ${mine.version}, mask ${theirs.mask})`);
      }
    }
    assert.ok(checked > 190, 'too few function modules compared to mean anything');
  }
});

test('and so does the payload they each encode', { skip: haveSegno ? false : 'segno unavailable' }, () => {
  // Their matrix, read by this reader, must say the same thing as mine does -- and pass
  // the same EC and version-information checks, which is what shows the checks are right.
  for (const payload of PAYLOADS) {
    const theirs = reference(payload);
    assert.equal(decode(theirs.matrix, theirs.version, theirs.mask), payload,
      'the reader disagrees with an independent encoder, so the reader is wrong');
  }
});

test('ISO/IEC 18004\'s worked example reads back as the standard prints it', { skip: haveSegno ? false : 'segno unavailable' }, () => {
  // '01234567' at version 1, level M, numeric mode. The standard publishes the codewords;
  // this reads them out of an independently produced symbol, which checks the READER --
  // the thing every other test here leans on.
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(LIBS)})
import segno
q = segno.make('01234567', error='m', micro=False, mode='numeric', boost_error=False, version=1)
print(json.dumps({"mask": q.mask, "matrix": [[int(b) for b in row] for row in q.matrix]}))
`;
  const ref = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
  const words = readCodewords(ref.matrix, 1, ref.mask);
  assert.deepEqual(words, [
    0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
    0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
  ]);
});

// ------------------------------------------------------------------ the odds and ends

test('the BIP21 URI is what Core puts in the code', () => {
  assert.equal(paymentUri('bc1qxy'), 'bitcoin:bc1qxy');
  assert.equal(paymentUri('bc1qxy', { label: 'rent' }), 'bitcoin:bc1qxy?label=rent');
  assert.equal(paymentUri('bc1qxy', { amountSat: 150_000 }), 'bitcoin:bc1qxy?amount=0.00150000');
  assert.match(paymentUri('bc1qxy', { label: 'cold storage & spare' }), /label=cold%20storage%20%26%20spare/);
});

test('drawing leaves the quiet zone, without which many scanners see nothing', () => {
  const calls = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ set fillStyle(v) { calls.push(['fill', v]); }, fillRect: (...a) => calls.push(['rect', ...a]) }),
  };
  const code = encodeQr('bcrt1qexample');
  drawQr(canvas, code, { scale: 4, quiet: 4 });
  assert.equal(canvas.width, (code.size + 8) * 4);
  const rects = calls.filter((c) => c[0] === 'rect');
  assert.deepEqual(rects[0].slice(1, 4), [0, 0, canvas.width], 'the background covers the whole canvas');
  assert.ok(rects.slice(1).every(([, x, y]) => x >= 16 && y >= 16), 'no module may be drawn in the quiet zone');
});
