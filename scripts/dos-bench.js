// How fast the DOS Diversions' emulated PC runs on this machine, headless (docs/MEASUREMENTS.md §32).
//
// Boots a game from games/ on a clock that counts instructions, lets its title and demos run, and
// reports instructions a second of wall time and the screens it drew. No browser: the same x86.js
// and dospc.js the worker runs, on Node's V8.
//
//   node scripts/dos-bench.js [doom|quake] [millions of instructions]
//
// DOOM runs at 30 million instructions to the virtual second (a fast 486); Quake at 70 million and
// with `+timedemo demo1`, so its screens drawn over the virtual time are the frame rate its own
// benchmark reports on a machine exactly as fast as this emulator.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPC } from '../public/js/dospc.js';
import { createSoundCard } from '../public/js/soundcard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const game = process.argv[2] === 'quake' ? 'quake' : 'doom';
const SPEC = {
  doom: { dir: 'doom_dos', exe: 'DOOM.EXE', args: '', ips: 30e6, total: 400 },
  quake: { dir: 'quake_dos', exe: 'QUAKE.EXE', args: '-nocdaudio +timedemo demo1', ips: 70e6, total: 3000 },
}[game];
const DIR = path.join(ROOT, 'games', SPEC.dir);
const total = Number(process.argv[3] ?? SPEC.total) * 1e6;

if (!fs.existsSync(path.join(DIR, SPEC.exe))) {
  console.error(`no ${path.join(DIR, SPEC.exe)}: this measures the shareware ${game}, which is not here`);
  process.exit(1);
}
const files = {};
const walk = (dir, pre) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), `${pre}${e.name}/`);
    else files[`${pre}${e.name}`] = new Uint8Array(fs.readFileSync(path.join(dir, e.name)));
  }
};
walk(DIR, '');

let pc;
const now = () => (pc ? pc.cpu.cycles : 0) / SPEC.ips * 1000;
pc = createPC({ files, now, args: SPEC.args, sound: (mem) => createSoundCard({ mem, rate: 44100 }) });
pc.boot(files[SPEC.exe]);

const t0 = process.hrtime.bigint();
let done = 0, graphicsAt = null;
while (done < total && !pc.exited) {
  done += pc.run(1e6);
  if (graphicsAt === null && pc.vga.mode === 0x13) graphicsAt = done;
}
const secs = Number(process.hrtime.bigint() - t0) / 1e9;
console.log(`${game} on node ${process.version}`);
console.log(`${(done / 1e6).toFixed(0)} M instructions in ${secs.toFixed(2)} s: ${(done / secs / 1e6).toFixed(1)} M a second`);
console.log(`graphics mode after ${(graphicsAt / 1e6).toFixed(1)} M instructions`);
console.log(`${(pc.vga.frames / 2).toFixed(0)} pages flipped, ${(pc.vga.writes / 64000).toFixed(0)} screens' worth written, in ${(done / SPEC.ips).toFixed(1)} virtual seconds`);
