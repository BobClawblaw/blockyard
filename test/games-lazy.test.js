// THE GAMES LOAD WHEN OPENED (the outside review of 2026-09-16: "Move the DOOM/Wolfenstein/Quake
// emulator and 3D games into an optional, separately loadable module ... This reduces the attack and
// bug surface of the core monitor"). Walks app.js's static import graph and holds it to containing
// no game module at all; each game is an import() the router makes when its page is first opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');
const staticGraph = (entry) => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(entry);
  return seen;
};

test('the core app statically imports no game; each game is loaded when its page opens', () => {
  const graph = [...staticGraph(path.join(JS, 'app.js'))].map((f) => path.basename(f));
  const GAME = ['tetrust.js', 'blockout.js', 'breakout.js', 'blockanoid.js', 'arkanoid.js', 'tetsound.js', 'scorchedyard.js', 'scorched.js', 'scorchedai.js', 'scorchedshop.js', 'scorchedfx.js', 'scorchedair.js', 'scorchedwind.js', 'wolf3d.js', 'doom.js', 'quake.js', 'dosgame.js', 'dosio.js', 'dospc.js', 'dosaudio.js', 'dosworker.js', 'x86.js', 'soundcard.js'];
  const leaked = graph.filter((f) => GAME.includes(f));
  assert.deepEqual(leaked, [], `no game module reaches the monitor through a static import (${leaked.join(', ')})`);
  const app = fs.readFileSync(path.join(JS, 'app.js'), 'utf8');
  for (const [page, file, fn] of [['tetrust', 'tetrust', 'renderTetrust'], ['blockout', 'blockout', 'renderBlockout'], ['blockanoid', 'blockanoid', 'renderBlockanoid'], ['scorched', 'scorchedyard', 'renderScorchedYard'], ['wolf3d', 'wolf3d', 'renderWolf3d'], ['doom', 'doom', 'renderDoom'], ['quake', 'quake', 'renderQuake']]) {
    assert.match(app, new RegExp(`${page}: \\(\\) => import\\('\\./${file}\\.js'\\)\\.then\\(\\(m\\) => m\\.${fn}\\)`), `${page} is an import() on first open`);
    const mod = fs.readFileSync(path.join(JS, `${file}.js`), 'utf8');
    assert.ok(mod.includes(`export function ${fn}(`) || mod.includes(`export const ${fn} =`), `${file}.js still exports ${fn}`);
  }
  assert.match(app, /\.catch\(\(e\) => \{ gameLoads\.delete\(page\); toast\(/, 'a module that fails to load says so, and can be retried');
});
