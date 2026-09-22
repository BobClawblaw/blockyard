// Static file serving with a strict containment rule.
//
// The containment check resolves the symlink and compares against the real root,
// not the requested string: `/assets/../../../etc/passwd` and a symlink planted
// inside public/ are different attacks and only the realpath test stops both.
import fsp from 'node:fs/promises';
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

export class StaticFiles {
  constructor(root, { version = '0.0.0', tls = false, hstsMs = 0 } = {}) {
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
    res.writeHead(status, headers);
    const stream = (await import('node:fs')).createReadStream(r.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return { status: 200, file: r.file, etag };
  }
}

