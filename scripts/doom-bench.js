// How fast the DOOM Diversion's emulated PC runs on this machine, headless (docs/MEASUREMENTS.md §32).
//
// Boots doom_dos/DOOM.EXE on a clock that counts instructions (30 million to the virtual second, a
// fast 486), lets the title and demos run, and reports instructions a second of wall time and pages
// flipped. No browser: the same x86.js and dospc.js the worker runs, on Node's V8.
//
//   node scripts/doom-bench.js [millions of instructions, default 400]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPC } from '../public/js/dospc.js';
import { createSoundCard } from '../public/js/soundcard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'doom_dos');
const total = Number(process.argv[2] ?? 400) * 1e6;

if (!fs.existsSync(path.join(DIR, 'DOOM.EXE'))) {
  console.error(`no ${path.join(DIR, 'DOOM.EXE')}: this measures the shareware DOOM, which is not here`);
  process.exit(1);
}
const files = {};
for (const f of fs.readdirSync(DIR)) if (!f.startsWith('.')) files[f] = new Uint8Array(fs.readFileSync(path.join(DIR, f)));

let pc;
const now = () => (pc ? pc.cpu.cycles : 0) / 30e6 * 1000;
pc = createPC({ files, now, sound: (mem) => createSoundCard({ mem, rate: 44100 }) });
pc.boot(files['DOOM.EXE']);

const t0 = process.hrtime.bigint();
let done = 0, graphicsAt = null;
while (done < total && !pc.exited) {
  done += pc.run(1e6);
  if (graphicsAt === null && pc.vga.mode === 0x13) graphicsAt = done;
}
const secs = Number(process.hrtime.bigint() - t0) / 1e9;
console.log(`node ${process.version}`);
console.log(`${(done / 1e6).toFixed(0)} M instructions in ${secs.toFixed(2)} s: ${(done / secs / 1e6).toFixed(1)} M a second`);
console.log(`graphics mode after ${(graphicsAt / 1e6).toFixed(1)} M instructions`);
console.log(`${(pc.vga.frames / 2).toFixed(0)} pages flipped (two CRTC writes a flip) in ${(done / 30e6).toFixed(1)} virtual seconds`);
