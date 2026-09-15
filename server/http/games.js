// THE GAME FILES (operator, 2026-09-15: "I've added doom_dos to the project directory. Get DOOM
// working as a diversion inside blockyard with zero dependancies"; later "move doom_dos out of the
// root and move into games", and "get Quake working as a diversion").
//
// The DOS Diversions run shareware DOOM and Quake in a PC emulated in the browser (public/js/x86.js,
// dospc.js, soundcard.js), and the emulator needs the games' own files. They live in games/, one
// directory a game, where the operator put them -- not in public/, which is the app and is stamped
// with a build id computed over every file in it (18 MB of PAK in that digest, re-hashed every two
// seconds of page loads, would be a cost paid by every page for two diversions).
//
// Served under /games/<game>/<path>, and only that: a game this file names, and a DOS path of at
// most one directory and an 8.3 name of a kind the games read (an executable, a WAD, a PAK, a
// config, Wolfenstein 3D's .WL1 data). No dots but the one in each name, so there is no path to
// traverse; the lookup is
// case-insensitive because DOS names are, and the files on disk are upper-case while a browser asks
// for whatever it was told.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { securityHeaders } from './static.js';

/** Each game's directory under the games root. */
export const GAME_DIRS = Object.freeze({ wolf3d: 'wolf3d_dos', doom: 'doom_dos', quake: 'quake_dos' });

export const GAME_PATH = /^\/games\/([a-z0-9]+)\/((?:[A-Za-z0-9_-]{1,8}\/)?[A-Za-z0-9_-]{1,8}\.(?:wad|exe|cfg|pak|wl1))$/i;

/** The file under `dir` at the DOS path `rel` ("ID1/PAK0.PAK"), matching each part ignoring case, or null. */
export async function findGameFile(dir, rel) {
  let at = dir;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    let names;
    try { names = await fsp.readdir(at, { withFileTypes: true }); } catch { return null; }
    const want = parts[i].toUpperCase(), last = i === parts.length - 1;
    const hit = names.find((e) => (last ? e.isFile() : e.isDirectory()) && e.name.toUpperCase() === want);
    if (!hit) return null;
    at = path.join(at, hit.name);
  }
  return at;
}

/**
 * Answer a /games/ request. Returns { status } when it answered, or null when the path is not one
 * of ours (the caller's 404 applies).
 */
export async function serveGame(req, res, urlPath, root, { tls = false, hstsMs = 0 } = {}) {
  const m = GAME_PATH.exec(urlPath);
  if (!m || !Object.hasOwn(GAME_DIRS, m[1])) return null;
  const dirName = GAME_DIRS[m[1]];
  const file = await findGameFile(path.join(root, dirName), m[2]);
  const headers = securityHeaders({ tls, hstsMs });
  if (!file) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : `${m[2].toUpperCase()} is not in games/${dirName}/`);
    return { status: 404 };
  }
  const st = await fsp.stat(file);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...headers, ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return { status: 304 };
  }
  res.writeHead(200, {
    ...headers,
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
  });
  if (req.method === 'HEAD') { res.end(); return { status: 200 }; }
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return { status: 200 };
}
