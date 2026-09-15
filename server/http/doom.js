// THE DOOM FILES (operator, 2026-09-15: "I've added doom_dos to the project directory. Get DOOM
// working as a diversion inside blockyard with zero dependancies").
//
// The DOOM Diversion runs the shareware DOOM.EXE in a PC emulated in the browser (public/js/x86.js,
// dospc.js, soundcard.js), and the emulator needs the game's own files. They live in
// `games/doom_dos/`, where the operator put them (the root's doom_dos/ until the games had a home of
// their own) -- not in public/, which is the app and is
// stamped with a build id computed over every file in it (4 MB of WAD in that digest, re-hashed
// every two seconds of page loads, would be a cost paid by every page for one diversion).
//
// Served under /doom/NAME, and only NAME: an 8.3 name of the three kinds the game reads (the
// executable, a WAD, its config). No directories, no dots but the one, so there is no path to
// traverse; the lookup is case-insensitive because DOS names are, and the files on disk are
// upper-case while a browser asks for whatever it was told.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { securityHeaders } from './static.js';

export const DOOM_NAME = /^\/doom\/([A-Za-z0-9_-]{1,8}\.(?:wad|exe|cfg))$/i;

/** The file in `dir` whose name matches `name` ignoring case, or null. */
export async function findDoomFile(dir, name) {
  let names;
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const want = name.toUpperCase();
  const hit = names.find((e) => e.isFile() && e.name.toUpperCase() === want);
  return hit ? path.join(dir, hit.name) : null;
}

/**
 * Answer a /doom/ request. Returns { status } when it answered, or null when the path is not one
 * of ours (the caller's 404 applies).
 */
export async function serveDoom(req, res, urlPath, dir, { tls = false, hstsMs = 0 } = {}) {
  const m = DOOM_NAME.exec(urlPath);
  if (!m) return null;
  const file = await findDoomFile(dir, m[1]);
  const headers = securityHeaders({ tls, hstsMs });
  if (!file) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : `${m[1].toUpperCase()} is not in games/doom_dos/`);
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
