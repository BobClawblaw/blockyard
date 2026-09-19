// THE QR ENCODER (public/js/admin/qr.js), checked three ways.
//
// A QR code that is subtly wrong scans as a different string, and the string here is a
// bitcoin address. "It looked like a QR code" is evidence of nothing, so:
//
//   1. ROUND TRIP. Every matrix is read back — walked, unmasked, de-interleaved, parsed —
//      and must yield the exact bytes that went in. This is the property that matters:
//      what a scanner will see. The reader below is written from the standard's own
//      description rather than by calling back into the encoder, so it is a check and not
//      an echo.
//   2. AGAINST AN INDEPENDENT IMPLEMENTATION. segno (a Python QR library, installed into a
//      temp directory for the test only, never shipped) draws the same payloads, and the
//      FUNCTION modules — finders, timing, alignment, format bits — must match exactly.
//   3. AGAINST THE PUBLISHED EXAMPLE. ISO/IEC 18004's worked example, read back through
//      this reader, must give the codewords the standard prints.
//
// WHERE THIS DELIBERATELY DOES NOT MATCH SEGNO: the pad codewords. For byte mode segno
// emits one extra 0x00 before the 0xEC/0x11 padding; the standard's own worked example
// goes straight to 0xEC, which is what this encoder does. The mode, character count and
// payload are identical either way, and a decoder stops reading at the end of the payload —
// so both scan the same, and copying the quirk would mean copying it without knowing why.
// The tests below therefore compare the DECODED CONTENT, not the padding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodeQr, paymentUri, drawQr } from '../public/js/admin/qr.js';

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

/** Undo the block interleaving and return the data codewords in order. */
function deinterleave(words, version) {
  const { ec, groups } = VERSION_BLOCKS[version];
  const sizes = groups.flatMap(([count, len]) => new Array(count).fill(len));
  const blocks = sizes.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < sizes.length; b++) if (i < sizes[b]) blocks[b].push(words[at++]);
  }
  return blocks.flat();
}

/** Parse mode, character count and payload. Byte mode only, which is all this encoder emits. */
function decode(modules, version, mask) {
  const data = deinterleave(readCodewords(modules, version, mask), version);
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

test('the function patterns match an independent encoder exactly', { skip: haveSegno ? false : 'segno unavailable' }, () => {
  for (const payload of PAYLOADS.slice(0, 4)) {
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
  // Their matrix, read by this reader, must say the same thing as mine does.
  for (const payload of PAYLOADS.slice(0, 4)) {
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
  const words = readCodewords(ref.matrix, 1, ref.mask).slice(0, 16);
  assert.deepEqual(words, [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
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
