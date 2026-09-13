// HTTP assembly: security gate -> static or API -> JSON envelope.
//
// Every mutating request needs the CSRF double-submit token; every request after
// the first needs a session; every request is rate limited per user. The audit
// trail records credentials use without ever recording a credential.
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { StaticFiles, SECURITY_HEADERS, securityHeaders } from './static.js';
import { routes, HttpError } from './api.js';
import { parseCookies, serializeCookie, csrfOk } from '../auth/sessions.js';
import { ipDecision } from '../netinfo.js';

// Kept importable from the HTTP module while the gate lives here; the logic is in
// netinfo.js so it can be tested without assembling a server.
export { ipAllowed, parseIp, parseCidr } from '../netinfo.js';

const MAX_BODY = 1024 * 1024; // 1 MB: a raw transaction is nowhere near this

function compile(routesTable) {
  return routesTable.map((r) => {
    const names = [];
    const re = new RegExp('^' + r.path.replace(/:[A-Za-z_]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
    return { ...r, re, names };
  });
}

export function createAppServer(app) {
  const compiled = compile(routes);
  const hstsMs = app.cfg.server.tls?.hstsMs ?? 0;
  // Accounts off => every request below is served as `viewer` with no session.
  const openAccess = !app.cfg.auth.enabled;
  const statics = new StaticFiles(app.publicDir, { version: app.version, tls: app.tls, hstsMs });
  const limiter = app.limiter;
  // Responses built here (JSON, 404 pages, OPTIONS) carry the same policy as the
  // static ones; HSTS is only included when this listener actually speaks TLS.
  const H = () => securityHeaders({ tls: app.tls, hstsMs });

  const listener = (req, res) => {
    // HSTS on every TLS response. It is set once, here, rather than per sendJson /
    // static / SSE path: a header that is valid on any HTTPS response and must not
    // depend on which code path answered is a listener concern. Over plain HTTP it
    // would pin an upgrade this server cannot serve, so it is conditional.
    if (app.tls && hstsMs > 0) res.setHeader('Strict-Transport-Security', `max-age=${Math.floor(hstsMs / 1000)}`);
    handle(req, res).catch((err) => {
      app.log({ level: 'error', msg: `unhandled request error: ${err.stack ?? err.message}` });
      if (!res.headersSent) sendJson(req, res, 500, { error: { message: 'internal error', kind: 'internal' } });
      else res.destroy();
    });
  };
  // TLS is per-listener, and every listener gets it or none does: a monitor that
  // serves the LAN in clear text while the tunnel is encrypted is a monitor whose
  // weakest address decides whether the session cookie is a secret. app.tlsOptions
  // is loaded once at boot, where the certificate was already validated.
  const server = app.tls && app.tlsOptions
    ? https.createServer({ ...app.tlsOptions }, listener)
    : http.createServer(listener);
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  // SSE connections are long-lived by design; do not let the defaults reap them.
  server.requestTimeout = 0;
  server.headersTimeout = 15000;

  async function handle(req, res) {
    const ip = clientIp(req, app.cfg);
    const started = Date.now();

    // Network gate before anything else -- including before we spend a KDF on a
    // login attempt from an address we will not serve anyway.
    if (app.cfg.server.allowCidrs.length) {
      const gate = ipDecision(ip, app.cfg.server.allowCidrs);
      if (!gate.allowed) {
        // The reason goes to the log, not the client: telling a stranger which
        // prefixes are configured is a map of the inside.
        app.log({ level: 'warn', msg: `refused connection from ${ip}: ${gate.reason}` });
        return sendJson(req, res, 403, { error: { message: 'this address is not permitted', kind: 'forbidden' } });
      }
      if (gate.malformed?.length) {
        // Loud, but only once per request path: a typo in server.allowCidrs makes
        // an entry inert, and an inert entry in an allowlist is a silent hole.
        app.log({ level: 'warn', msg: `server.allowCidrs has unusable entries: ${gate.malformed.join(', ')}` });
      }
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET,POST,DELETE,HEAD', ...H() });
      return res.end();
    }

    // SSE needs the raw response, so it is matched ahead of the JSON handlers.
    if (path === '/api/stream' && req.method === 'GET') {
      // The stream is the dashboard. If it asks for a session that the rest of the
      // server does not ask for, open mode serves a page of frozen numbers -- the
      // exact "nothing refreshes" shape this repo has already been burned by.
      const user = openAccess ? { user: ANONYMOUS_USER } : resolveSession(req, app);
      if (!user) return sendJson(req, res, 401, { error: { message: 'authentication required', kind: 'auth' } });
      const rl = limiter.check(openAccess ? `sse:anon:${ip}` : `sse:${user.user.id}`, 1);
      if (!rl.ok) return sendJson(req, res, 429, { error: { message: 'too many streams', kind: 'ratelimited' } });
      // A stream is accepted for an unknown node id and then every frame is filtered
      // out by nodeId -- which means a tab left pointing at a removed node gets a
      // connection that is genuinely "live", a badge that says "live", and no data,
      // forever, with nothing in any log. Refuse it here instead, so the client can
      // see the failure and recover. `sse #N opened` should only ever be printed for
      // a stream that will actually deliver something.
      const wantNode = query.node || null;
      if (wantNode && !app.monitors.has(wantNode)) {
        return sendJson(req, res, 404, {
          error: {
            message: `no node "${wantNode}"; known: ${[...app.monitors.keys()].join(', ') || '(none configured)'}`,
            kind: 'unknown_node',
          },
        });
      }
      const client = app.hub.add(req, res, { user: user.user, nodeId: wantNode });
      app.log({ level: 'info', msg: `sse #${client.id} opened by ${user.user.username} (${ip})` });
      req.on('close', () => app.log({ level: 'info', msg: `sse #${client.id} closed (${Math.round((Date.now() - started) / 1000)}s)` }));
      return undefined;
    }

    const match = matchRoute(compiled, req.method, path);
    if (match?.methodMismatch) {
      res.setHeader('Allow', [...new Set(compiled.filter((r) => r.re.test(path)).map((r) => r.method))].join(', '));
      return sendJson(req, res, 405, { error: { message: `${req.method} is not allowed on ${path}`, kind: 'method' } });
    }
    if (!match) {
      if (path.startsWith('/api/')) return sendJson(req, res, 404, { error: { message: `no such endpoint ${path}`, kind: 'not_found' } });
      // With accounts off there is nothing to sign in to, and a login form that
      // cannot be submitted is worse than no form: send the visitor to the dashboard
      // and let /api/me explain the mode.
      if (openAccess && req.method === 'GET' && (path === '/login' || path === '/login.html')) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', ...H() });
        return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(req, res, 405, { error: { message: 'method not allowed', kind: 'method' } });
      const out = await statics.serve(req, res, path);
      if (out?.error) return serveStaticError(req, res, statics, path, out.error, H());
      app.access({ req, res, path, status: out?.status ?? 200, ms: Date.now() - started, ip, user: null });
      return undefined;
    }

    const { route, params } = match;
    const cookies = parseCookies(req.headers.cookie);
    let session = null;
    let user = null;
    let token = null;

    if (route.auth !== 'none') {
      if (openAccess) {
        // Accounts are off: nobody is authenticated, so nobody is denied either --
        // up to the ceiling applied just below, which is what makes "open to
        // everyone" mean open READS rather than open everything.
        user = ANONYMOUS_USER;
        // Rate limit per ADDRESS. Keying on user.id here would hand every client on
        // the LAN one shared bucket, so a single chatty tab would rate-limit
        // everyone else -- an outage caused by the neighbour's browser.
        const rl = limiter.check(`anon:${ip}`, 1);
        if (!rl.ok) {
          return sendJson(req, res, 429, {
            error: { message: `rate limited; retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`, kind: 'ratelimited' },
          });
        }
      } else {
        const resolved = resolveSession(req, app, cookies);
        if (!resolved) {
          return sendJson(req, res, 401, { error: { message: 'authentication required', kind: 'auth' }, login: '/login' });
        }
        session = resolved.session;
        user = resolved.user;
        token = resolved.token;
        if (user.disabled) return sendJson(req, res, 403, { error: { message: 'account disabled', kind: 'forbidden' } });
        const rl = limiter.check(`${user.id}`, 1);
        if (!rl.ok) {
          return sendJson(req, res, 429, {
            error: { message: `rate limited; retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`, kind: 'ratelimited' },
          });
        }
      }

      // Enforced on BOTH branches. This is the whole point of the ceiling: an
      // anonymous visitor must not reach the user-admin or audit routes merely
      // because there is no session to check. Keeping this test only in the
      // authenticated branch is how "no login required" quietly becomes "no login
      // required, and anyone may create accounts".
      if (route.auth === 'admin' && user.role !== 'admin') {
        return sendJson(req, res, 403, openAccess
          ? { error: { message: 'accounts are disabled, so this endpoint has no one to authorise; start with BLOCKYARD_AUTH=1 to enable sign-in, users and the audit trail', kind: 'forbidden' }, accounts: false }
          : { error: { message: 'administrator role required', kind: 'forbidden' } });
      }
    }

    let body = null;
    if (route.body || req.method === 'POST') {
      const read = await readBody(req, res);
      if (read.error) return sendJson(req, res, read.error, { error: { message: read.message, kind: 'body' } });
      body = read.value;
    }

    if (route.csrf && session) {
      // Header or body only, deliberately NOT the cookie: a cross-site request
      // carries the cookie just as happily, so accepting it here would make the
      // whole check decorative. Reading the cookie and echoing it back in a
      // header is the part a cross-origin page cannot do.
      //
      // `&& session`: the check exists because a cross-site request can ride a
      // session cookie. With accounts OFF there is no cookie and no credential to
      // ride, so the check has nothing left to protect and would only break the
      // read-only RPC console. What open mode does instead is cap the role at viewer
      // and refuse node writes (see ANONYMOUS_USER and actionAllowed).
      const given = req.headers['x-csrf-token'] ?? body?.csrf;
      if (!csrfOk(session, given)) {
        await app.audit({ type: 'csrf-rejected', username: user?.username ?? null, path, ip });
        return sendJson(req, res, 403, { error: { message: 'CSRF token missing or incorrect', kind: 'csrf' } });
      }
    }

    // OPEN MODE STILL HAS TO REFUSE CROSS-SITE WRITES.
    //
    // The check above is skipped without a session, on the reasoning that there is no credential
    // to ride. That is true of READS, and false of every route that makes the SERVER act. The node
    // connection test was the proof: with accounts off it took an unauthenticated POST -- and a
    // plain cross-site <form> reaches it, because readBody accepts x-www-form-urlencoded, so there
    // is no preflight to stop it -- and pointed a credentialed RPC probe at an attacker's URL.
    //
    // A page on another origin cannot suppress Origin on a form post, nor forge Sec-Fetch-Site, so
    // these two are exactly the signal open mode has left. A non-browser client (curl, a script)
    // sends neither and is unaffected: it can already reach the port, and this check is about what
    // a BROWSER can be made to do on somebody's behalf.
    if (route.csrf && !session) {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      let crossSite = false;
      if (origin && origin !== 'null') {
        try { crossSite = new URL(origin).host !== req.headers.host; } catch { crossSite = true; }
      } else if (origin === 'null') {
        crossSite = true;                       // an opaque origin: a sandboxed frame or a data: URL
      }
      if (site && !['same-origin', 'none'].includes(site)) crossSite = true;
      if (crossSite) {
        await app.audit({ type: 'csrf-rejected', username: null, path, ip, reason: 'cross-site request in open mode' });
        return sendJson(req, res, 403, {
          error: { message: 'cross-site request refused: this endpoint changes state, and with accounts off there is no token to check', kind: 'csrf' },
        });
      }
    }

    const setCookies = [];
    const ctx = {
      req, res, app, ip, params, query, body, user, session, token,
      setCookie: (name, value, opts) => setCookies.push(serializeCookie(name, value, { secure: app.cfg.auth.secureCookie, ...opts })),
      clearCookie: (name) => setCookies.push(serializeCookie(name, '', { maxAgeMs: 0, secure: app.cfg.auth.secureCookie })),
    };

    try {
      const result = await route.handler(ctx, app);
      if (res.writableEnded || res.headersSent) return undefined;
      if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
      const status = result?.__status ?? (req.method === 'POST' && !result?.ok ? 200 : 200);
      sendJson(req, res, status, result ?? { ok: true });
      app.access({ req, res, path, status, ms: Date.now() - started, ip, user: user?.username ?? null });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(req, res, err.status, { error: { message: err.message, kind: 'api', code: err.code }, ...(err.detail ? { detail: err.detail } : {}) }, setCookies);
        app.access({ req, res, path, status: err.status, ms: Date.now() - started, ip, user: user?.username ?? null, error: err.message });
        return undefined;
      }
      app.log({ level: 'error', msg: `${req.method} ${path} failed: ${err.stack ?? err.message}` });
      sendJson(req, res, 500, { error: { message: 'internal error', kind: 'internal' } }, setCookies);
      app.access({ req, res, path, status: 500, ms: Date.now() - started, ip, user: user?.username ?? null, error: err.message });
    }
    return undefined;
  }

  return server;
}

/**
 * The identity every request carries when accounts are off.
 *
 * `viewer` is a ceiling, not a default: it is not configurable, it is not read from
 * anywhere, and there is no credential that can raise it. That is what lets the
 * dashboard be open to everyone while /api/users, /api/audit and /api/password stay
 * shut — the admin routes still ask for role `admin`, and nothing in open mode has it.
 */
const ANONYMOUS_USER = Object.freeze({
  id: 'anonymous',
  username: 'anonymous',
  role: 'viewer',
  disabled: false,
  lastLoginAt: null,
  open: true,
});

function matchRoute(compiled, method, path) {
  let methodMismatch = false;
  for (const r of compiled) {
    const m = r.re.exec(path);
    if (!m) continue;
    if (r.method !== method) { methodMismatch = true; continue; }
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return methodMismatch ? { methodMismatch: true } : null;
}

// A missing page gets a page, not a bare status line, so the browser has
// something to show. A path-traversal attempt is a 403 and stays one.
//
// StaticFiles.serve() writes the response itself when it finds a file, so the
// fallback must not also write headers -- doing that is ERR_HTTP_HEADERS_SENT.
async function serveStaticError(req, res, statics, path, code, headers = SECURITY_HEADERS) {
  const wantsPage = code === 404 && (/\.[a-z0-9]+$/i.test(path) === false || path.endsWith('.html'));
  if (wantsPage && !path.startsWith('/assets')) {
    const out = await statics.resolve('/404.html');
    if (!out.error) {
      // status 404 with the page body: serve() defaults to 200, and a missing
      // path answering 200 would make every crawler and uptime check think the
      // guess was right.
      const r = await statics.serve(req, res, '/404.html', { status: 404 });
      if (!r?.error) return undefined; // sent with the right status
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...headers });
    res.end('<!doctype html><meta charset=utf-8><title>404</title><h1>404 not found</h1><p><a href="/">back to the dashboard</a>');
    return undefined;
  }
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(code === 403 ? '403 forbidden' : '404 not found');
  return undefined;
}

function resolveSession(req, app, cookies = parseCookies(req.headers.cookie)) {
  const token = cookies[app.cfg.auth.cookieName];
  if (!token) return null;
  const session = app.sessions.get(token);
  if (!session) return null;
  const user = app.users.byId(session.userId);
  if (!user || user.disabled) return null;
  // Role changes take effect on the next request, not only at next login: a
  // session must not keep a privilege the account no longer has.
  session.role = user.role;
  return { session, user: { ...user }, token };
}

function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        finish({ error: 413, message: `request body larger than ${MAX_BODY / 1024} KB` });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return finish({ value: null });
      const ctype = req.headers['content-type'] || '';
      if (ctype.includes('application/x-www-form-urlencoded')) {
        return finish({ value: Object.fromEntries(new URLSearchParams(raw).entries()) });
      }
      try {
        finish({ value: JSON.parse(raw) });
      } catch (err) {
        finish({ error: 400, message: `body is not valid JSON: ${err.message}` });
      }
    });
    req.on('error', () => finish({ error: 400, message: 'body read failed' }));
  });
}

function sendJson(req, res, status, obj, setCookies) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj ?? null);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  };
  if (setCookies?.length) headers['Set-Cookie'] = setCookies;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function clientIp(req, cfg) {
  if (cfg?.server?.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return normalizeIp(fwd.split(',')[0].trim());
  }
  return normalizeIp(req.socket?.remoteAddress ?? '0.0.0.0');
}

export function normalizeIp(addr) {
  if (typeof addr !== 'string') return '0.0.0.0';
  if (addr.startsWith('::ffff:')) return addr.slice(7);
  return addr;
}

// IPv4/IPv6 CIDR membership now lives in server/netinfo.js (parseIp / parseCidr /
// ipDecision), where it is tested directly. It used to sit here comparing the
// text prefix of an address, which over-permitted: see the note above the gate and
// docs/DEFECTS.md.

