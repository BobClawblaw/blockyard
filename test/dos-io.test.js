// THE DOS DIVERSIONS between the browser and the PC: the keyboard's scancodes, the control schemes
// laid over DOOM's config, Quake's first-run autoexec, text mode's character set, the palette -- and
// the server route that hands the games their files (server/http/games.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scancodes, withControls, CONTROLS, DEFAULT_CONTROLS, CP437, CGA, textRuns, paletteLut, quakeAutoexec, GAMES } from '../public/js/dosio.js';
import { GAME_PATH, GAME_DIRS, findGameFile } from '../server/http/games.js';
import { withApp } from './helpers/http.js';

const cfgText = (bytes) => String.fromCharCode(...bytes);

test('keys arrive as set-1 scancodes: a make, a break with bit 7, and the AT keys behind E0', () => {
  assert.deepEqual(scancodes('KeyW', true), [0x11]);
  assert.deepEqual(scancodes('KeyW', false), [0x91]);
  assert.deepEqual(scancodes('ControlLeft', true), [0x1d], 'fire');
  assert.deepEqual(scancodes('ArrowUp', true), [0xe0, 0x48], 'DOOM skips the prefix and reads keypad 8: forward');
  assert.deepEqual(scancodes('ArrowLeft', false), [0xe0, 0xcb]);
  assert.deepEqual(scancodes('Escape', true), [0x01]);
  assert.deepEqual(scancodes('F11', true), [0x57], 'gamma, past F10\'s block');
  assert.equal(scancodes('Pause', true)[0], 0xe1, 'the one key that sends its break inside its make');
  assert.equal(scancodes('LaunchMail', true), null, 'a key no PC keyboard had is not sent at all');
});

test('the control schemes rewrite the keys DOOM reads from default.cfg, and always turn the mouse on', () => {
  const shipped = new TextEncoder().encode('mouse_sensitivity\t\t5\nkey_up\t\t72\nkey_use\t\t57\nuse_mouse\t\t0\nsnd_sfxdevice\t\t3\n');
  const wasd = cfgText(withControls(shipped, 'wasd'));
  assert.match(wasd, /^key_up\t\t17$/m, 'W');
  assert.match(wasd, /^key_strafeleft\t\t30$/m, 'A, appended because the file lacked it');
  assert.match(wasd, /^key_use\t\t18$/m, 'E');
  assert.match(wasd, /^use_mouse\t\t1$/m);
  assert.match(wasd, /^snd_sfxdevice\t\t3$/m, 'everything else untouched');
  assert.match(wasd, /^mouse_sensitivity\t\t5$/m);
  const classic = cfgText(withControls(withControls(shipped, 'wasd'), 'classic'));
  for (const [k, v] of Object.entries(CONTROLS.classic)) assert.match(classic, new RegExp(`^${k}\\t\\t${v}$`, 'm'), `${k} back to the game's own`);
  assert.equal((classic.match(/^key_up/gm) ?? []).length, 1, 'rewritten in place, never duplicated');
  assert.equal(DEFAULT_CONTROLS, 'wasd', 'WASD unless someone turns it off (operator: "not enabled by default")');
  assert.match(cfgText(withControls(shipped)), /^key_up\t\t17$/m, 'and a config with no scheme named gets WASD');
});

test('text mode: code page 437 is 256 characters, and a screen becomes runs of one colour', () => {
  assert.equal([...CP437].length, 256);
  assert.equal(CP437[0xdb], '█');
  assert.equal(CP437[0xc4], '─');
  assert.equal(CP437[65], 'A');
  assert.equal(CGA.length, 16);
  const cells = new Uint8Array(4000);
  for (let i = 0; i < 2000; i++) { cells[i * 2] = 0x20; cells[i * 2 + 1] = 0x07; }
  cells[0] = 0x44; cells[1] = 0x4f;                     // 'D' bright white on red, ENDOOM's colours
  cells[2] = 0x4f; cells[3] = 0x4f;
  const runs = textRuns(cells);
  assert.deepEqual(runs[0], { x: 0, y: 0, text: 'DO', fg: '#ffffff', bg: '#aa0000' });
  assert.equal(runs[1].text.length, 78, 'the rest of the row is one run');
  assert.equal(runs.length, 26, 'and every other row is a single run');
});

test('the palette: six-bit DAC values become full-scale pixels in an ImageData\'s byte order', () => {
  const pal = new Uint8Array(768);
  pal[3] = 63; pal[4] = 0; pal[5] = 31;                 // entry 1
  const lut = paletteLut(pal);
  assert.equal(lut[1], (0xff000000 | (Math.round(31 * 255 / 63) << 16) | 0xff) >>> 0, 'ABGR: red in the low byte');
  assert.equal(lut[0], 0xff000000, 'black, opaque');
});

test('Quake gets W A S D and mouse look the first time, and only mouse look after its own config exists', () => {
  const first = String.fromCharCode(...quakeAutoexec({ firstRun: true }));
  assert.match(first, /^\+mlook$/m);
  assert.match(first, /^bind "w" "\+forward"$/m);
  assert.match(first, /^bind "d" "\+moveright"$/m);
  const later = String.fromCharCode(...quakeAutoexec({ firstRun: false }));
  assert.equal(later, '+mlook\n', 'the player\'s own bindings, saved by Quake on quit, are left alone');
  assert.equal(GAMES.quake.exe, 'QUAKE.EXE');
  assert.match(GAMES.quake.args, /-nocdaudio/, 'no CD: without it Quake waits at a warning for a key');
  for (const [key, g] of Object.entries(GAMES)) assert.equal(g.dir, `games/${GAME_DIRS[key]}`, `${key}: the page and the server name the same directory`);
});

test('the /games/ route serves only a named game and a short DOS path of the kinds they read', async () => {
  for (const ok of ['/games/doom/DOOM1.WAD', '/games/doom/doom.exe', '/games/quake/ID1/PAK0.PAK', '/games/quake/id1/config.cfg']) assert.match(ok, GAME_PATH);
  for (const bad of ['/games/doom/../package.json', '/games/doom/.._DOOM1.WAD', '/games/doom/README.TXT', '/games/quake/A/B/PAK0.PAK', '/games/doom/DOOM1.WAD/x', '/games/doom/TOOLONGNAME.WAD', '/games/doom/%2e%2e%2fserver.js', '/games/quake/../doom_dos/DOOM.EXE']) {
    assert.doesNotMatch(bad, GAME_PATH, bad);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-games-'));
  try {
    fs.mkdirSync(path.join(dir, 'ID1'));
    fs.writeFileSync(path.join(dir, 'ID1', 'PAK0.PAK'), 'PACK');
    fs.writeFileSync(path.join(dir, 'DOOM1.WAD'), 'IWAD');
    assert.equal(await findGameFile(dir, 'doom1.wad'), path.join(dir, 'DOOM1.WAD'), 'DOS names are case-insensitive');
    assert.equal(await findGameFile(dir, 'id1/pak0.pak'), path.join(dir, 'ID1', 'PAK0.PAK'), 'and so are directories');
    assert.equal(await findGameFile(dir, 'DOOM.WAD'), null);
    assert.equal(await findGameFile(dir, 'DOOM1.WAD/X'), null, 'a file is not a directory');
    assert.equal(await findGameFile(path.join(dir, 'missing'), 'DOOM1.WAD'), null, 'no directory is not an exception');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the server hands over the files in open mode, and wants a session when accounts are on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-games-'));
  fs.mkdirSync(path.join(dir, 'doom_dos'));
  fs.mkdirSync(path.join(dir, 'quake_dos', 'ID1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doom_dos', 'DOOM1.WAD'), Buffer.from('IWAD\x01\x00\x00\x00'));
  fs.writeFileSync(path.join(dir, 'quake_dos', 'ID1', 'PAK0.PAK'), 'PACK');
  try {
    await withApp({ auth: false }, async ({ app, base }) => {
      app.gamesDir = dir;
      const r = await fetch(`${base}/games/doom/doom1.wad`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'application/octet-stream');
      assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/, 'the same policy as every other response');
      assert.equal(Buffer.from(await r.arrayBuffer()).toString('latin1'), 'IWAD\x01\x00\x00\x00');
      const etag = r.headers.get('etag');
      assert.equal((await fetch(`${base}/games/doom/DOOM1.WAD`, { headers: { 'If-None-Match': etag } })).status, 304, 'megabytes are not sent twice');
      const pak = await fetch(`${base}/games/quake/id1/pak0.pak`);
      assert.equal(pak.status, 200, 'one directory down, as Quake keeps its data');
      assert.equal(await pak.text(), 'PACK');
      const missing = await fetch(`${base}/games/doom/DOOM.EXE`);
      assert.equal(missing.status, 404);
      assert.match(await missing.text(), /DOOM\.EXE is not in games\/doom_dos/, 'the page can tell the operator what to install');
      assert.equal((await fetch(`${base}/games/heretic/HERETIC.EXE`)).status, 404, 'only the games this server names');
      assert.equal((await fetch(`${base}/games/doom/..%2fpackage.json`)).status, 404, 'no path out of the directory');
    });
    await withApp({}, async ({ app, base, client }) => {
      app.gamesDir = dir;
      assert.equal((await fetch(`${base}/games/doom/DOOM1.WAD`)).status, 401, 'accounts on: no session, no game');
      const { status } = await client.login();
      assert.equal(status, 200);
      const r = await client.raw('/games/doom/DOOM1.WAD');
      assert.equal(r.status, 200, 'signed in, served');
      await r.arrayBuffer();
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
