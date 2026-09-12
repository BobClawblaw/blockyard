// Booting the real app inside a test process.
//
// Until `app.shutdown()` existed there was no way to stop what `boot()` starts, so
// anything that needed to speak real HTTP had to shell out to scripts/smoke.sh. That
// put a whole class of behaviour — response headers, session cookies, the login
// throttle, CSP nonces, TLS — outside the unit suite, which is how "60 smoke checks
// passed" coexisted with a page that had never rendered.
//
// This helper boots with a fake node (or several), talks to it over loopback, and
// always tears down. It writes nothing outside a temp directory, and it never reads
// config/local.json: BLOCKYARD_CONFIG=none keeps a deployment's bind addresses out of a
// hermetic run (that leak is what broke 54 smoke assertions on 2026-09-08).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startFakeNode } from '../../scripts/fake-node.js';

export async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * Boot the app with `n` fake nodes and hand the caller a client.
 *
 * `boot()` decides node wiring from config, so a two-node test is a config file plus
 * two fake daemons — which is also how production is configured, so the test path is
 * the real path.
 */
/**
 * Boot the app with `n` fake nodes and hand the caller a client.
 *
 * NOTHING here touches process.env any more, and that is deliberate: Node runs a
 * file's top-level tests CONCURRENTLY (verified: a sibling test sees an env var
 * another test set mid-await), so a helper that mutated the environment made one
 * boot read another test's configuration -- symptoms ranged from a 401 in a test
 * that expected open access to "Invalid configuration" raised in an innocent file.
 * Everything the boot needs goes in its config file or comes back from boot()
 * itself (the bootstrap admin password arrives on `app.bootstrap`).
 *
 * `boot()` decides node wiring from config, so a two-node test is a config file plus
 * two fake daemons -- which is also how production is configured, so the test path is
 * the real path.
 */
export async function withApp({ nodes = 1, config = {}, adminPassword = null, tlsFiles = null, log = null, auth = true } = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-app-'));
  const { boot } = await import('../../server/main.js');
  const fakes = [];
  const port = await freePort();
  const nodeDefs = [];
  for (let i = 0; i < nodes; i++) {
    const fport = await freePort();
    const fake = await startFakeNode({
      port: fport,
      logFile: path.join(dir, `fake-${i}.log`),
      ibd: i === 0 && nodes > 1 ? false : true,
      catchupBlocksPerSec: 9,
    });
    fakes.push(fake);
    nodeDefs.push({
      id: i === 0 ? 'node-a' : `node-${i}`,
      label: `Fake ${i}`,
      rpcUrl: fake.url,
      datadir: dir,
      chainHint: 'main',
      rpcUser: 'fake',
      rpcPassword: 'fake',
      logFile: path.join(dir, `fake-${i}.log`),
      optional: i > 0,
    });
  }
  const cfgFile = path.join(dir, 'config.json');
  const base = {
    server: {
      host: '127.0.0.1',
      port,
      ...(tlsFiles ? { tls: { cert: tlsFiles.cert, key: tlsFiles.key } } : {}),
    },
    nodes: nodeDefs,
    store: { dir: path.join(dir, 'store'), retentionHours: 1, snapshotEveryMs: 3_600_000 },
    // Accounts stay ON here even though the server default is now OFF: most tests
    // using this helper are testing the signed-in paths (sessions, CSRF, per-user
    // audit, the login throttle). Open mode is opted into explicitly with
    // { auth: false } so that choice stays visible at the call site.
    auth: { enabled: auth !== false, dataDir: path.join(dir, 'auth') },
    poll: { fastMs: 1500, midMs: 3000, slowMs: 6000, rareMs: 20000 },
    log: { level: 'error', healthMs: 5000 },
  };
  fs.writeFileSync(cfgFile, JSON.stringify(merge(base, config)));

  let app = null;
  try {
    // `configFile` is passed explicitly, so config/local.json on this box can never
    // enter the run (rule 18) -- no env sentinel needed.
    app = await boot({ configFile: cfgFile, log });
    const origin = `${app.tls ? 'https' : 'http'}://127.0.0.1:${port}`;
    const client = makeClient(origin, app);
    // The admin credential the boot actually created. Reading it back rather than
    // injecting one through the environment is what keeps this helper free of
    // process-global state.
    client.adminPassword = adminPassword ?? app.bootstrap?.password ?? null;
    return await fn({ app, base: origin, client, dir, fakes, port });
  } finally {
    if (app) await app.shutdown({ saveHistory: false }).catch(() => {});
    for (const f of fakes) await f.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Shallow-where-it-counts merge so a test can override one nested key. */
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(base[k] ?? {}), ...v } : v;
  }
  return out;
}

/**
 * A log sink that collects entries instead of printing them. Node's monitor logs
 * through `log.child({node})`, so the sink has to support that too.
 */
export function logSink() {
  const entries = [];
  const push = (entry) => { entries.push(typeof entry === 'string' ? { msg: entry } : entry); };
  push.child = (base) => (entry) => push(typeof entry === 'string' ? { ...base, msg: entry } : { ...base, ...entry });
  push.text = () => entries.map((e) => `${e.level ?? 'info'} ${e.msg}`).join('\n');
  push.entries = entries;
  return push;
}

/** A fetch client that keeps the session cookie and the CSRF token. */
export function makeClient(base, app) {
  const jar = new Map();
  const send = async (p, { method = 'GET', body, headers = {}, csrf = null, raw = false } = {}) => {
    const h = { ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (csrf) h['X-CSRF-Token'] = csrf;
    const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      if (i > 0 && /Max-Age=0/.test(sc)) jar.delete(pair.slice(0, i).trim());
      else if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (raw) return res;
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, headers: res.headers, body: json };
  };
  return {
    get: (p, o = {}) => send(p, o),
    post: (p, body, o = {}) => send(p, { ...o, method: 'POST', body }),
    raw: (p, o = {}) => send(p, { ...o, raw: true }),
    jar,
    /** Log in and return the tokens a browser would hold. */
    async login(username = 'admin', password) {
      const pw = password ?? this.adminPassword ?? null;
      const r = await send('/api/login', { method: 'POST', body: { username, password: pw } });
      return { status: r.status, body: r.body, csrf: r.body?.csrf ?? null };
    },
    cookies: () => [...jar.keys()],
  };
}
