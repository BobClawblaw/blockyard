// Static file serving with a strict containment rule.
//
// The containment check resolves the symlink and compares against the real root,
// not the requested string: `/assets/../../../etc/passwd` and a symlink planted
// inside public/ are different attacks and only the realpath test stops both.
import fsp from 'node:fs/promises';
import { gzip } from 'node:zlib';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// A page that can read node state must not be embeddable anywhere, and must not
// be able to reach off-origin scripts. Everything here is same-origin.
//
// style-src: no `'unsafe-inline'` anywhere, and none for `style-src-attr` either.
// That allowance existed because this UI drew bars and progress widths with
// data-driven `style="width:42%"` attributes injected through innerHTML, which
// `style-src 'self'` refuses. The correct fix was never to widen the policy: the
// markup now carries `data-w`/`data-left` and the width is written through the
// CSSOM (app.js `applyDataSizes`), which CSP permits, and every static `style=`
// became a class. See docs/DEFECTS.md and test/csp.test.js — a test now fails if a
// `style="` comes back into the shipped HTML or JS.
export const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self'", // + ' nonce-…' per response, see securityHeaders()
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  // SSE is same-origin EventSource; no third-party anything.
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
];

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  // No SharedArrayBuffer anywhere in this codebase (checked: the DOS emulator's worker uses
  // plain postMessage and transferable ArrayBuffers, never shared memory), so nothing here
  // needs cross-origin isolation -- these are cheap, standard defense-in-depth rather than a
  // requirement (audit 2026-09-22, L4): same-origin windows can't hold a reference into this
  // page, and this page's own responses can't be pulled into another origin as a subresource.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP_BASE.join('; '),
};

/**
 * Headers for one response.
 *
 * `nonce` — a per-response script nonce, so an inline `<script>` in a page is
 * possible at all. Until now `script-src 'self'` meant that adding one would fail
 * in the browser with no server-side trace, which is the same "silently broken"
 * shape as the module-level ReferenceError that blanked this UI for a day. Pages
 * are rewritten through `renderHtml()` so a placeholder can receive the nonce.
 *
 * `tls` — HSTS is only meaningful, and only safe, over TLS. Sending it over plain
 * HTTP instructs a browser to pin an upgrade path that the server cannot serve.
 */
export function securityHeaders({ nonce = null, tls = false, hstsMs = 0 } = {}) {
  const csp = nonce
    ? [...CSP_BASE.slice(0, 1), `script-src 'self' 'nonce-${nonce}'`, ...CSP_BASE.slice(2)]
    : CSP_BASE;
  const h = { ...SECURITY_HEADERS, 'Content-Security-Policy': csp.join('; ') };
  if (tls && hstsMs > 0) h['Strict-Transport-Security'] = `max-age=${Math.floor(hstsMs / 1000)}`;
  return h;
}

/** One usable nonce per response. 16 bytes is what the CSP spec's example uses. */
export function newNonce() {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Rewrite an HTML document: nonce into the placeholders, build id into the asset
 * URLs and the `data-blockyard-build` attribute.
 *
 * The cache-busting is the point of the build stamp, not a side effect: a tab that
 * quietly runs yesterday's app.js was indistinguishable from one running today's,
 * and every "did my fix land?" cost fifteen minutes for want of it (DEFECTS). The
 * footer now compares the build this page loaded against what the server says is
 * current, and says so in words when they differ.
 */
export function renderHtml(src, { nonce, build }) {
  return String(src)
    .replace(/%BLOCKYARD_NONCE%/g, nonce ?? '')
    .replace(/%BLOCKYARD_BUILD%/g, build ?? 'dev')
    // Only assets get a version. Pages are `Cache-Control: no-cache` already, and
    // stamping `href="/"` would put `?v=` on the dashboard link, where the query
    // string is reserved for `?node=` and `?range=` -- a cosmetic rewrite that
    // touches the app's own parameter space is not cosmetic.
    .replace(/\b(href|src)="(\/[^"?]*\/[^"?]*\.(?:js|css|svg|png|jpe?g|webp|ico|woff2|map))"/g,
      (m, attr, url) => `${attr}="${url}?v=${build}"`);
}

/**
 * A build id: version + a digest over the asset file sizes and mtimes.
 *
 * Deliberately not a git SHA. `data/` and this tree are deployed by copy on this
 * box, and an id derived from files answers the actual question — "is the code in
 * this tab the code on disk?" — where a SHA would be a lie about a working tree
 * that was never committed at the moment of boot.
 */
export async function computeBuildId(root, version = '0.0.0') {
  const h = crypto.createHash('sha256');
  const walk = async (dir, prefix = '') => {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { await walk(p, `${prefix}${ent.name}/`); continue; }
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      h.update(`${prefix}${ent.name}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  };
  await walk(root);
  return `${version}-${h.digest('hex').slice(0, 10)}`;
}

// what is gzipped on the way out (static.js serve()): text assets of this size and up, kept compressed in memory
export const GZIP_TYPES = new Set(['.json', '.js', '.mjs', '.css', '.svg', '.txt', '.map', '.html']);
export const GZIP_MIN = 8 * 1024;
export const GZIP_CACHE_BYTES = 24 * 1024 * 1024;

export class StaticFiles {
  constructor(root, { version = '0.0.0', tls = false, hstsMs = 0 } = {}) {
    this.gzCache = new Map(); this.gzBytes = 0;   // gzipped bodies by file, size and mtime (serve(), gzipped())
    this.root = path.resolve(root);
    this.version = version;
    this.tls = tls;
    this.hstsMs = hstsMs;
    this._build = null;
    this._buildAt = 0;
  }

  /** Cached for 2 s: a page load resolves index.html, then its assets, in a burst. */
  async buildId() {
    if (!this._build || Date.now() - this._buildAt > 2000) {
      this._build = await computeBuildId(this.root, this.version);
      this._buildAt = Date.now();
    }
    return this._build;
  }

  async resolve(urlPath) {
    let decoded;
    try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return { error: 400 }; }
    if (decoded.includes('\0')) return { error: 400 };
    // REFUSED ON EVERY PLATFORM, NOT ONLY WHERE IT MATTERS (audit 2026-09-22, L10). `%5C` decodes
    // to a literal backslash, which path.normalize/path.join treat as an ordinary filename
    // character on POSIX but as a path SEPARATOR on Windows -- an untested edge this suite runs CI
    // for (.github/workflows/test.yml, windows-latest) but never exercised. No file this server
    // ever serves has a backslash in its real name, so refusing the character outright costs
    // nothing on any platform and closes the edge without needing a Windows box to prove it: a
    // string that can never mean a directory separator here cannot be used to build one there.
    if (decoded.includes('\\')) return { error: 400 };
    if (decoded === '/') decoded = '/index.html';
    if (decoded === '/login') decoded = '/login.html';
    const candidate = path.join(this.root, path.normalize(decoded));
    if (candidate !== this.root && !candidate.startsWith(this.root + path.sep)) return { error: 403 };
    let st;
    try {
      st = await fsp.stat(candidate);
    } catch {
      return { error: 404 };
    }
    if (st.isDirectory()) return { error: 404 };
    // The decisive check: the resolved target must still be inside the root.
    let real;
    try { real = await fsp.realpath(candidate); } catch { return { error: 404 }; }
    const realRoot = await fsp.realpath(this.root).catch(() => this.root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { error: 403 };
    return { file: real, stat: st, ext: path.extname(candidate).toLowerCase() };
  }

  async serve(req, res, urlPath, { send = true, status = 200 } = {}) {
    const r = await this.resolve(urlPath);
    if (r.error) return r;
    const etag = `W/"${r.stat.size.toString(16)}-${Math.floor(r.stat.mtimeMs).toString(16)}"`;
    // HTML is rewritten per response (nonce + build id), so its body is not the
    // file on disk: no ETag conditional, and Content-Length must be recomputed.
    const isHtml = r.ext === '.html';
    const nonce = isHtml ? newNonce() : null;
    const headers = {
      ...securityHeaders({ nonce, tls: this.tls, hstsMs: this.hstsMs }),
      'Content-Type': MIME[r.ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': new Date(r.stat.mtimeMs).toUTCString(),
    };
    if (!isHtml && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'], ...securityHeaders({ tls: this.tls, hstsMs: this.hstsMs }) });
      res.end();
      return { status: 304, file: r.file };
    }
    if (isHtml) {
      const raw = await fsp.readFile(r.file).catch(() => null);
      if (!raw) return { error: 404 };
      const body = renderHtml(raw.toString('utf8'), { nonce, build: await this.buildId() });
      headers['Content-Length'] = Buffer.byteLength(body);
      if (!send) { res.writeHead(status, headers); res.end(); return { status, file: r.file }; }
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
      return { status, file: r.file, etag };
    }
    // The caller may be serving a real 404/403 *page*; the body being a file
    // that exists does not make the request successful.
    if (!send) { res.writeHead(status, headers); res.end(); return { status, file: r.file }; }
    // GZIP, ONCE, IN MEMORY (operator, 2026-10-13, of the 4.3 MB of map geography: "do it"): a text asset of 8 KB or more
    // goes out gzipped to a client that accepts it, compressed on first request and kept by path, size and mtime (the
    // cache is bounded; a file changed on disk is recompressed). Nothing extra ships, and every large script and
    // stylesheet gains the same. Static files carry no secret, so BREACH does not apply (the API's routes stay as they
    // are: only the two mempool routes opt in there). The gzipped variant has its own ETag, so a conditional request
    // for either form answers 304 correctly, and Vary says the body depends on Accept-Encoding.
    if (GZIP_TYPES.has(r.ext) && r.stat.size >= GZIP_MIN && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      const gzEtag = `${etag.slice(0, -1)}-gz"`;
      if (req.headers['if-none-match'] === gzEtag) {
        res.writeHead(304, { ETag: gzEtag, 'Cache-Control': headers['Cache-Control'], Vary: 'Accept-Encoding', ...securityHeaders({ tls: this.tls, hstsMs: this.hstsMs }) });
        res.end();
        return { status: 304, file: r.file };
      }
      const gz = await this.gzipped(r);
      if (gz) {
        res.writeHead(status, { ...headers, ETag: gzEtag, 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Vary: 'Accept-Encoding' });
        res.end(req.method === 'HEAD' ? undefined : gz);
        return { status, file: r.file, etag: gzEtag, gzip: true };
      }
    }
    if (GZIP_TYPES.has(r.ext)) headers.Vary = 'Accept-Encoding';
    res.writeHead(status, headers);
    const stream = (await import('node:fs')).createReadStream(r.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return { status: 200, file: r.file, etag };
  }

  /** The gzipped body of a file, from the cache or made now; null if the file could not be read. */
  async gzipped(r) {
    const key = `${r.file}:${r.stat.size}:${Math.floor(r.stat.mtimeMs)}`;
    const hit = this.gzCache.get(key);
    if (hit) { this.gzCache.delete(key); this.gzCache.set(key, hit); return hit; }
    const raw = await fsp.readFile(r.file).catch(() => null);
    if (!raw) return null;
    const gz = await new Promise((resolve, reject) => gzip(raw, { level: 6 }, (e, b) => (e ? reject(e) : resolve(b))));
    // one entry per file: an older version of the same path goes first
    for (const k of [...this.gzCache.keys()]) if (k.startsWith(`${r.file}:`)) { this.gzBytes -= this.gzCache.get(k).length; this.gzCache.delete(k); }
    this.gzCache.set(key, gz); this.gzBytes += gz.length;
    while (this.gzBytes > GZIP_CACHE_BYTES && this.gzCache.size > 1) { const [k, v] = this.gzCache.entries().next().value; this.gzCache.delete(k); this.gzBytes -= v.length; }
    return gz;
  }
}

