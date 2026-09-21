// API surface. Every handler returns a plain object; the server serialises it and
// turns thrown HttpError into a JSON envelope. Nothing here writes to the node
// except the /action route, which is opt-in, role-gated and audited.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { classifyMethod, allowlistSummary, ACTIONS, actionAllowed, NODE_REFUSES } from '../rpc/allowlist.js';
import { RpcClient, displayUrl, shortPath } from '../rpc/client.js';
import { SERIES } from '../store/history.js';
import { randomPassword } from '../auth/users.js';
import { formatEta, formatBytes } from '../util/fmt.js';
import { xSearch, xTx, xBlock, xAddress } from './explorer.js';

// Dollar figures for the explorer: a spot price if one is at hand within 1.5 s -- never a slower
// page for want of one (server/collect/markets.js spot()).
// THE MARKET SWITCH (operator, 2026-09-15: "disable markets by default so we can claim true zero
// telemetry out of the box" ... "an app wide 'Enable Market Polling' checkbox"). Two layers:
//   - BLOCKYARD_MARKETS=0 (markets.enabled=false) removes the feed from the server altogether;
//     nothing in the browser can turn it on. For machines that must never reach out.
//   - otherwise the feed exists but polls only while the Display setting
//     markets.polling is on -- and that ships OFF, so a fresh install makes no outbound
//     connection but to the node until someone ticks the box.
// The setting lives in the server's settings file (config/blockyard.json, the same one every
// screen shares); it is read here per request, cached on the file's mtime and size, so a tick in
// the panel takes effect on the next call without a restart -- and the next call also PARKS the
// feed, so unticking stops the exchange traffic at once rather than ten minutes later.
const MARKETS_OFF = 'market data is off on this server (BLOCKYARD_MARKETS=0 or markets.enabled=false); the switch in Display settings cannot turn it on';
const POLLING_OFF = 'market polling is off -- the default, so that out of the box this monitor makes no outbound connection but to your node. Turn it on under Display settings → Markets & Price → Enable market polling';
const pollingCache = new WeakMap();
export async function marketsPollingOn(app) {
  const file = app.settingsFile;
  if (!file) return false;
  let st;
  try { st = await fsp.stat(file); } catch { return false; }
  const hit = pollingCache.get(app);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value = false;
  try { value = JSON.parse(await fsp.readFile(file, 'utf8'))?.markets?.polling === true; } catch { value = false; }
  pollingCache.set(app, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}
const pollingOff = (app) => { app.markets?.stop?.(); return { ok: true, enabled: false, polling: false, note: POLLING_OFF }; };

async function withUsd(app, r) {
  if (!r?.ok || !app.markets || !(await marketsPollingOn(app))) return r;
  const p = await Promise.race([app.markets.spot().catch(() => null), new Promise((res) => { setTimeout(res, 1500, null).unref?.(); })]);
  return { ...r, usd: p?.usd ?? null };
}

export class HttpError extends Error {
  constructor(status, message, { code = null, detail = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const ban = (user) => ({ ok: false, reason: 'CSRF token missing or incorrect', status: 403, user });

function needRole(ctx, role) {
  const rank = { viewer: 0, operator: 1, admin: 2 };
  if ((rank[ctx.user?.role] ?? -1) < (rank[role] ?? 99)) {
    // In open mode the shortfall is structural, not personal: name the switch that
    // changes it instead of telling an anonymous visitor they lack a role they have
    // no way to acquire.
    if (ctx.app?.cfg?.auth?.enabled === false) {
      throw new HttpError(403, 'accounts are disabled, so this endpoint has no one to authorise; start with BLOCKYARD_AUTH=1 to enable sign-in, users and the audit trail');
    }
    throw new HttpError(403, `this needs role "${role}"; you are "${ctx.user?.role ?? 'anonymous'}"`);
  }
}

function pickNode(ctx, app) {
  const wanted = ctx.query.node || ctx.query.nodeId;
  if (!wanted) return app.primary;
  const m = app.monitors.get(wanted);
  if (!m) throw new HttpError(404, `no node "${wanted}"; known: ${[...app.monitors.keys()].join(', ')}`);
  return m;
}

// ---- the node-connection form's two guards ------------------------------------------------
// (operator, asked which posture to take: "D - Want this easy to configure and going to assume
// it's on a safe network".)
//
// With accounts ON, this is an admin action like any other. With accounts OFF there is no identity
// to check, and the operator chose to allow it rather than demand BLOCKYARD_AUTH just to point the
// monitor at a node. Every save is audited.
//
// CSRF: the double-submit check only runs when there IS a session (server.js), so with accounts
// off it never fired here -- the claim this comment used to make ("CSRF still applies in both
// cases") was false, and a cross-site form could post to these routes. Open mode now refuses a
// cross-site Origin / Sec-Fetch-Site on every csrf:true route instead.
//
// This is deliberately NOT the /api/action posture. That gate refuses node writes while accounts
// are off because those commands reach the NODE. This reaches only this app's own config file.
function configWriteAllowed(app, ctx) {
  if (app.cfg.auth.enabled) needRole(ctx, 'admin');
}

// THE NODE CONNECTION IN OPEN MODE: FROM THIS MACHINE ONLY (audit 2026-09-16, M1 and M2).
//
// The open-mode cross-site check refuses a browser on another origin, because a browser cannot
// suppress Origin or forge Sec-Fetch-Site. A script sends neither header, and can forge both. So with
// accounts off, a script anywhere on the LAN could (1) save an rpcUrl of its choosing, after which the
// next restart sends the datadir's cookie to it -- reproduced end to end -- and (2) use the probe to
// make this server POST to internal URLs and read back what they answered. There is no identity to
// check in open mode, so the check is WHERE the caller is: the socket's own peer address must be
// loopback. X-Forwarded-For is never consulted, and behind a trusted proxy every request would look
// local, so the form is refused there. `auth.openNodeConfigFromNetwork` restores the old reach.
// Full server paths go to an admin; everyone else, which in open mode is anyone who can reach the
// port, gets the last two parts (audit 2026-09-16, L11).
const pathFor = (ctx, p) => (ctx.user?.role === 'admin' ? p : shortPath(p));

export function isLoopbackAddress(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
function nodeConfigAllowed(app, ctx) {
  if (app.cfg.auth.enabled) return needRole(ctx, 'admin');
  if (app.cfg.auth.openNodeConfigFromNetwork === true) return undefined;
  if (!app.cfg.server?.trustProxy && isLoopbackAddress(ctx.req.socket?.remoteAddress)) return undefined;
  throw new HttpError(403, app.cfg.server?.trustProxy
    ? 'with accounts off and server.trustProxy on, the node connection cannot be changed over HTTP: every proxied request looks local. Edit config/local.json, or turn accounts on'
    : 'with accounts off, the node connection can only be changed from this machine (open the monitor at 127.0.0.1), or turn accounts on, or set auth.openNodeConfigFromNetwork', { code: 'local_only' });
}

// What a form may set, and nothing else. Credentials come from the datadir's .cookie
// (config.js resolveCookie), so rpcUser / rpcPassword / cookieFile are NOT accepted here: taking a
// password over an endpoint that can be run open is not a thing to add quietly.
function candidateNode(app, body) {
  const cur = app.cfg.nodes?.[0] ?? {};
  const rpcUrl = String(body?.rpcUrl ?? '').trim();
  const datadir = String(body?.datadir ?? '').trim();
  const chainHint = String(body?.chainHint ?? '').trim() || cur.chainHint || 'main';
  const label = String(body?.label ?? '').trim();
  // THE SAME RULES config.js applies at boot, so a save cannot write a file that then refuses to
  // load -- a monitor that saves a configuration and will not start again is the worst outcome here.
  if (!/^https?:\/\//.test(rpcUrl)) {
    throw new HttpError(400, 'rpcUrl must be http(s)://host:port', { code: 'bad_rpc_url' });
  }
  try { new URL(rpcUrl); } catch { throw new HttpError(400, `rpcUrl is not a URL: ${rpcUrl}`, { code: 'bad_rpc_url' }); }
  const dd = datadir || cur.datadir || '';
  if (!dd && !cur.cookieFile) {
    throw new HttpError(400, 'a datadir is needed so the node’s .cookie can be read for authentication', { code: 'need_datadir' });
  }
  // ONLY THE FOUR FIELDS THIS FORM OWNS. The save merges these onto whatever the file already
  // says, so everything else survives by not being mentioned -- which is both simpler and safer
  // than carrying the in-memory node across.
  //
  // Spreading `...cur` here was the first cut and it was wrong twice over. Measured: the running
  // config holds `logFile: null` (the key EXISTS, with a null value), so spreading it would write
  // null over a real path in the file and silently unconfigure the log tail -- the very regression
  // this endpoint is supposed to avoid. And `cur` also holds values the ENVIRONMENT put there, so a
  // save would quietly bake a systemd drop-in's override into the file as though it had been
  // chosen here.
  return { rpcUrl, datadir: dd, chainHint, ...(label || cur.label ? { label: label || cur.label } : {}) };
}

function parseRange(text, fallbackMs = 3600_000) {
  if (!text) return fallbackMs;
  const m = String(text).match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit];
  return Math.max(1000, Math.min(31 * 86_400_000, n * mult));
}

const RANGES = { '15m': 900_000, '1h': 3600_000, '6h': 21600_000, '24h': 86400_000, '7d': 604800_000 };

// Which source backs each panel -- stated per mode, because the answer genuinely
// differs. Every claim below is a measurement from 2026-09-08, and the RPC-only
// column is build-dependent in a way that no RPC call can tell you: the build
// that published 2,116,236,872 bytes and the build that published 0 both report
// the same subversion string as each other.
function sourcesFor(logEnabled) {
  const logOnly = 'no RPC source for this; it exists only in the node log';
  return [
    { panel: 'sync bar', source: 'getblockchaininfo blocks/headers + verificationprogress', note: 'kept as two separate figures (rule 9)' },
    logEnabled
      ? { panel: 'bandwidth', source: 'node log [dlc] tick lines', note: 'the deployed build answers getnettotals 0/0; the 03:02 bench build answers real totals (11.56 MB/s by delta against 11.2 MB/s stated in its own log)' }
      : { panel: 'bandwidth', source: 'getnettotals delta rate (RPC-only mode)', note: 'works when the counters move. Measured 2026-09-09: the production daemon read 0/0 at 09:36 and 23,955,131 bytes received at 17:36 with no restart in between, so this row is a question to re-ask, not an answer to remember (MEASUREMENTS 23). When the counter is flat the panel is empty, never 0 B/s' },
    logEnabled
      ? { panel: 'peer identity', source: 'node log (relay legs, worker lines, connects)', note: 'getpeerinfo returns [] on the deployed build; the 03:02 bench build answers 21 rows with per-peer bytes' }
      : { panel: 'peer identity', source: 'getpeerinfo (RPC-only mode, promoted to the 15 s tier)', note: '[] on the deployed build means no peer panel at all; on newer builds rows sum to 70.29% of getnettotals, so they are a subset, not a breakdown' },
    logEnabled
      ? { panel: 'peer book', source: 'getaddrmaninfo (RPC) + log [dlc] discovery lines', note: 'production addrman measured: 52,877 tried (ipv4 36,482 / ipv6 9,046 / onion 6,304 / i2p 1,045)' }
      : { panel: 'peer book', source: 'getaddrmaninfo (RPC)', note: 'the only peer-set figure RPC-only mode keeps; the log\'s "book now N" and "confirmed-live" counts are lost' },
    logEnabled
      ? { panel: 'banned peers', source: 'node log [dlc] banned N/M', note: 'listbanned answered [] while the same node\'s log said banned 8/114 -- worker bans are not in the stored ban table' }
      : { panel: 'banned peers', source: 'listbanned (stored ban table only)', note: 'the download worker\'s per-run bans have no RPC source; that count is unavailable, not zero' },
    { panel: 'disk write rate', source: logEnabled ? 'node log [dlc] write field' : 'none (RPC-only mode)', note: logEnabled ? 'getnettotals carries no write counter' : logOnly },
    { panel: 'mempool ingest + rejects', source: logEnabled ? 'node log [tx_accept] / [txrelay]' : 'none (RPC-only mode)', note: logEnabled ? 'pool counts also come from getmempoolinfo' : logOnly },
    { panel: 'mempool feerate', source: 'getrawmempool verbose (vsize, fees.base)', note: 'no depends/ancestorcount fields in this node\'s reply' },
    { panel: 'block stats', source: 'getblockstats', note: 'per-height fee, txs, total_size/total_weight and feerate percentiles. The size shown is total_size -- the sum of transaction sizes, not the serialized block (the 80-byte header and the txid-count varint are excluded), and the row carries that basis as sizeBasis. size/weight/strippedsize are getblock fields and are not statistics this endpoint has: asking for them by name returns 31 keys and none of them (MEASUREMENTS 24)' },
    { panel: 'node\'s own IBD eta', source: logEnabled ? 'node log [dlc] == / [utxo_live] catchup' : 'none (RPC-only mode)', note: 'kept separate from the monitor\'s measured rate, never merged (rule 4)' },
    { panel: 'validation stalls / archive holes', source: logEnabled ? 'node log [utxo_live] / [check]' : 'none (RPC-only mode)', note: logOnly },
  ];
}

export const routes = [
  // ---------------------------------------------------------------- public
  {
    method: 'GET', path: '/api/build', auth: 'none', handler: async (ctx, app) => {
      // Computed once per request: reporting one digest in `build` and answering
      // `matchesClient` from a second one would be two answers to one question.
      const live = await app.buildId();
      return {
        version: app.version,
        // Live, not the value this process read at boot. The question this endpoint exists
        // to answer is "is the code in my tab the code on disk?", and on a box that
        // deploys by copying files over a running service -- which is this box, and the
        // reason the id is a file digest rather than a git SHA -- the boot value stops
        // being that answer the moment anyone edits public/. Editing one asset and
        // leaving the service up made every page report "you are running an older
        // build", because the page was stamped with the live digest while the API still
        // quoted the boot one.
        build: live,
        bootBuild: app.build,
        // The page sends what it was served with; the answer is whether they agree.
        // This exists because "did my fix land?" cost fifteen minutes each time it was
        // asked on 2026-09-08: an unversioned script behind a revalidating ETag is
        // indistinguishable from a stale one from inside the tab.
        matchesClient: ctx.query.build ? String(ctx.query.build) === live : null,
        scheme: app.scheme,
        tls: app.tls,
        uptimeSec: Math.round((Date.now() - app.startedAt) / 1000),
      };
    },
  },
  // THE ABOUT PAGE'S HOST FACTS (operator, 2026-09-12: "system info. os info version").
  //
  // `auth: 'any'` rather than 'none' ON PURPOSE. With accounts off this is the same as open --
  // that is the operator's posture, stated elsewhere -- but with accounts ON, the host's OS,
  // processor and memory should not be readable before sign-in. /api/build and /api/health are
  // 'none' because a version string answers "is my tab current", which a login page needs.
  //
  // What is deliberately NOT here: hostname, username, network addresses, environment. In open
  // mode (BLOCKYARD_AUTH=0) anything on this route is readable by anyone who can
  // reach the port -- and those four are precisely what test/privacy.test.js exists to keep out
  // of published artefacts. The OS and the processor identify a machine's SHAPE, not its owner.
  {
    method: 'GET', path: '/api/about', auth: 'any', handler: async (ctx, app) => {
      const os = await import('node:os');
      const cpus = os.cpus() ?? [];
      return {
        version: app.version,
        build: await app.buildId(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: cpus.length || null,
        cpuModel: cpus[0]?.model?.trim() ?? null,
        totalMemGb: Math.round((os.totalmem() / 1e9) * 10) / 10,
        node: process.version,
        uptimeSec: Math.round((Date.now() - app.startedAt) / 1000),
      };
    },
  },
  {
    method: 'GET', path: '/api/health', auth: 'none', handler: (ctx, app) => {
      const nodes = [...app.monitors.values()].map((m) => ({
        id: m.id, label: m.label, online: m.rpc.telemetry().online,
        // Without this the `required` filter below sees `optional` undefined on
        // every node, treats ALL of them as required, and the optional-node fix
        // silently does nothing. Behaviour is asserted in
        // test/health-semantics.test.js, not just pattern-matched.
        optional: !!m.cfg.optional,
        chain: m.state.chain, tip: m.state.chainInfo?.blocks ?? null,
        lastError: m.state.lastError?.message ?? null,
      }));
      // What "ok" means, since uptime probes key on it. Requiring EVERY
      // configured node to be up was wrong in a way I introduced myself: making
      // the benchmark node a default meant that benchmark ending turned the whole
      // app red ("ok": false) while it was monitoring its real node perfectly.
      // An optional node that has gone away is a note, not a failure.
      const required = nodes.filter((n) => !n.optional);
      const degraded = nodes.filter((n) => !n.online).map((n) => n.id);
      return {
        ok: app.monitors.size > 0 && required.every((n) => n.online),
        degraded,
        version: app.version,
        build: app.build,
        scheme: app.scheme,
        tls: app.tls,
        uptimeSec: Math.round((Date.now() - app.startedAt) / 1000),
        authRequired: app.cfg.auth.enabled,
        nodes,
      };
    },
  },

  // ------------------------------------------------------------------ auth
  {
    method: 'POST', path: '/api/login', auth: 'none', body: true, csrf: false,
    handler: async (ctx, app) => {
      // Accounts off: do not run the KDF against a password nobody can own. This is
      // also the honest answer — "accounts are disabled" beats "invalid username or
      // password", which implies a credential exists to be wrong about.
      if (!app.cfg.auth.enabled) {
        throw new HttpError(403, 'accounts are disabled on this monitor; it is open without sign-in (start it with BLOCKYARD_AUTH=1 to require accounts)', { code: 'accounts_disabled' });
      }
      // Per-address throttle in front of the KDF. LoginGuard answers "this username
      // keeps failing", and the per-user token bucket cannot apply here (there is no
      // user yet), so before this a distributed grind -- many addresses, a few
      // attempts each -- sat below every threshold the code had. It is also the only
      // thing standing between a cheap flood and the scrypt KDF (~50 ms, ~16 MB per
      // guess) running on the request thread until the box stops answering.
      const rl = app.loginLimiter?.check(`login:${ctx.ip}`, 1);
      if (rl && !rl.ok) {
        await app.audit({ type: 'login-throttled', username: String(ctx.body?.username ?? '').toLowerCase().trim() || null, ip: ctx.ip, retryAfterMs: rl.retryAfterMs });
        throw new HttpError(429, `too many login attempts from this address; retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`, { code: 'throttled' });
      }
      const username = String(ctx.body?.username ?? '').toLowerCase().trim();
      const password = String(ctx.body?.password ?? '');
      if (!username || !password) throw new HttpError(400, 'username and password are both required');
      const gate = app.guard.status(username, ctx.ip);
      if (gate.blocked) {
        throw new HttpError(429, `too many failed logins; retry in ${Math.ceil(gate.retryAfterMs / 1000)}s`, { code: 'locked' });
      }
      const result = await app.users.verify(username, password);
      if (!result.ok) {
        const lock = app.guard.noteFailure(username, ctx.ip);
        await app.audit({ type: 'login', ok: false, username, ip: ctx.ip, reason: result.reason, locked: lock.locked.length > 0 });
        // Same message for "no such user" and "wrong password": the account's
        // existence is not information this endpoint hands out.
        throw new HttpError(401, 'invalid username or password', { code: 'bad_credentials' });
      }
      if (result.upgraded) {
        // Say it once, in the log and the audit trail rather than in the UI: an
        // operator who raises auth.scrypt needs to know it took effect, and "it
        // applies on the next login" is only checkable if that login reports.
        app.log({ level: 'info', msg: `rehashed ${username}'s password at the configured cost (N ${result.upgraded.from.N} -> ${result.upgraded.to.N})` });
        await app.audit({ type: 'kdf-upgrade', username, from: result.upgraded.from, to: result.upgraded.to, ip: ctx.ip });
      }
      app.guard.noteSuccess(username, ctx.ip);
      const { token, session } = app.sessions.create(result.user, { ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
      await app.sessions.save().catch(() => {});
      await app.audit({ type: 'login', ok: true, username, ip: ctx.ip });
      ctx.setCookie(app.cfg.auth.cookieName, token, { maxAgeMs: app.cfg.auth.sessionTtlMs, secure: app.cfg.auth.secureCookie });
      // Readable by JS on purpose: it is the CSRF double-submit value.
      ctx.setCookie('blockyard_csrf', session.csrf, { httpOnly: false, maxAgeMs: app.cfg.auth.sessionTtlMs, secure: app.cfg.auth.secureCookie });
      return { ok: true, user: publicUser(result.user), csrf: session.csrf };
    },
  },
  {
    method: 'POST', path: '/api/logout', auth: 'any', csrf: true,
    handler: async (ctx, app) => {
      // Nothing to end when there was never a session; answer honestly rather than
      // writing an anonymous "logout" row into a trail that cannot attribute it.
      if (!app.cfg.auth.enabled) return { ok: true, accounts: false, note: 'accounts are off, so there is no session to end' };
      if (ctx.token) app.sessions.destroy(ctx.token);
      await app.sessions.save().catch(() => {});
      ctx.clearCookie(app.cfg.auth.cookieName);
      ctx.clearCookie('blockyard_csrf');
      await app.audit({ type: 'logout', ok: true, username: ctx.user.username, ip: ctx.ip });
      return { ok: true };
    },
  },
  {
    method: 'GET', path: '/api/me', auth: 'any',
    // Open mode is reported, not assumed: `accounts:false` is what the UI keys the
    // header pill and the hidden sign-out button off, and `note` says the same thing
    // in words so nobody has to infer the posture from a missing button.
    handler: (ctx, app) => (ctx.user?.open ? {
      user: publicUser(ctx.user),
      accounts: false,
      sessions: [],
      note: 'no sign-in: this monitor is open to anyone who can reach it, read-only',
      actions: visibleActions(app.cfg, ctx.user.role),
      capabilities: {
        canCallRpc: true,
        canAct: false,
        actionsEnabled: app.cfg.actions.enabled,
        // Node writes stay refused in open mode unless the operator opted into
        // exactly that, twice (config.actions.allowWritesWithoutAuth).
        writesRequireAccounts: !app.cfg.actions.allowWritesWithoutAuth,
        allowedActions: [],
        ceiling: 'viewer',
      },
    } : {
      user: publicUser(ctx.user),
      accounts: true,
      sessions: app.sessions.listFor(ctx.user.id).map((s) => ({ ...s, current: ctx.session && s.createdAt === ctx.session.createdAt })),
      actions: visibleActions(app.cfg, ctx.user.role),
      capabilities: {
        canCallRpc: true,
        canAct: app.cfg.actions.enabled && app.cfg.actions.allow.length > 0,
        actionsEnabled: app.cfg.actions.enabled,
        allowedActions: app.cfg.actions.allow,
        ceiling: ctx.user.role,
      },
    }),
  },
  {
    method: 'POST', path: '/api/logout-all', auth: 'any', csrf: true,
    handler: async (ctx, app) => {
      if (!app.cfg.auth.enabled) throw new HttpError(403, 'accounts are disabled (start with BLOCKYARD_AUTH=1 to enable them)');
      const n = app.sessions.destroyForUser(ctx.user.id);
      await app.sessions.save().catch(() => {});
      ctx.clearCookie(app.cfg.auth.cookieName);
      await app.audit({ type: 'logout-all', ok: true, username: ctx.user.username, sessions: n, ip: ctx.ip });
      return { ok: true, revoked: n };
    },
  },

  // -------------------------------------------------------------- read model
  { method: 'GET', path: '/api/state', auth: 'any', handler: (ctx, app) => fullState(ctx, app) },
  {
    // The sync bar's endpoint on its own: small enough to poll hard from a
    // status widget without paying for the whole read model.
    method: 'GET', path: '/api/sync', auth: 'any',
    handler: (ctx, app) => {
      const m = pickNode(ctx, app);
      const s = m.snapshot({ seriesRanges: {} });
      return { node: s.id, sync: s.sync, tip: s.tip, chain: s.chain, ibd: s.ibd, health: { rpc: { online: s.health.rpc.online, lastError: s.health.lastError } } };
    },
  },
  { method: 'GET', path: '/api/mempool', auth: 'any', handler: (ctx, app) => mempoolView(pickNode(ctx, app)) },
  // Viewer Mode 2: every transaction in the next block's worth of the pool (monitor.js denseBlock)
  {
    method: 'GET', path: '/api/mempool/dense', auth: 'any',
    handler: (ctx, app) => { const m = pickNode(ctx, app); return { node: m.id, ...(m.mempoolDense ?? { at: null, n: 0, v: [], r: [], id: [] }) }; },
  },
  { method: 'GET', path: '/api/peers', auth: 'any', handler: (ctx, app) => peersView(pickNode(ctx, app)) },
  { method: 'GET', path: '/api/net', auth: 'any', handler: (ctx, app) => netView(pickNode(ctx, app)) },
  { method: 'GET', path: '/api/mining', auth: 'any', handler: (ctx, app) => ({ node: pickNode(ctx, app).id, ...pickNode(ctx, app).miningView() }) },
  {
    // The block being built right now, ASSEMBLED HERE from the verbose mempool the pool tier
    // already reads (collect/gbt.js) -- no RPC call of its own. It used to be a getblocktemplate
    // worth 1.3-1.5 s of the node's single RPC thread, which is why this was on-demand; what
    // `stale` now bounds is re-assembly of the same pool, not a call to the node. The answer is
    // exactly as fresh as the pool tier's last read, and says so (poolAgeMs).
    method: 'GET', path: '/api/nextblock', auth: 'any',
    handler: async (ctx, app) => {
      const m = pickNode(ctx, app);
      const stale = Number(ctx.query.stale ?? 15000);
      const res = await m.fetchTemplate({ staleMs: Number.isFinite(stale) ? stale : 15000, force: ctx.query.refresh === '1' });
      return { node: m.id, ...(res ?? { unavailable: 'no answer' }) };
    },
  },
  {
    method: 'GET', path: '/api/blocks', auth: 'any',
    handler: (ctx, app) => {
      const m = pickNode(ctx, app);
      const limit = clampInt(ctx.query.limit, 1, 400, 90);
      const s = m.snapshot({ seriesRanges: {} });
      return { node: m.id, blocks: s.blocks.recent.slice(0, limit), stats: blockStats(s.blocks.recent) };
    },
  },
  // The blocks the monitor holds, sampled evenly by height -- what the Chain page draws for a node
  // in initial sync, whose last 24 hours of blocks do not exist (monitor.js blockSamples).
  {
    method: 'GET', path: '/api/blocks/sampled', auth: 'any',
    handler: (ctx, app) => {
      const m = pickNode(ctx, app);
      return { node: m.id, ...m.blockSamples(clampInt(ctx.query.points, 2, 600, 300)) };
    },
  },
  // ------------------------------------------------- block / tx drill-down
  //
  // "Which transaction?" used to be answerable only by typing an RPC call into the
  // console, which is a shell, not a view. These two routes are read-only, go
  // through the same serialized lane as everything else (rule 1), and are
  // deliberately narrow about what they ask the node:
  //
  //   * getblock verbosity=2 is never called. Measured 2026-09-08 (MEASUREMENTS §6):
  //     this node returns 11 MB of hex for one block at verbosity 2 AND omits the
  //     fee/deltafee fields Core includes, so the verbose form is simultaneously the
  //     slowest option and the least informative. verbosity=1 gives header + txids.
  //   * No transaction hex is ever returned. A caller who needs it is one
  //     /api/rpc getblock away; a dashboard proxying 11 MB per click is a denial of
  //     service against a single-threaded server, wearing a nice font.
  {
    method: 'GET', path: '/api/block', auth: 'any',
    handler: async (ctx, app) => blockDrill(ctx, app),
  },
  {
    method: 'GET', path: '/api/tx', auth: 'any',
    handler: async (ctx, app) => txDrill(ctx, app),
  },
  // The explorer (server/http/explorer.js): block, transaction and address pages, each one
  // batched lane turn (or two). They answer { ok: false, error, hint } for a bad query.
  { method: 'GET', path: '/api/x/search', auth: 'any', handler: (ctx, app) => xSearch(pickNode(ctx, app), ctx.query) },
  { method: 'GET', path: '/api/x/tx', auth: 'any', handler: async (ctx, app) => withUsd(app, await xTx(pickNode(ctx, app), ctx.query)) },
  { method: 'GET', path: '/api/x/block', auth: 'any', handler: async (ctx, app) => withUsd(app, await xBlock(pickNode(ctx, app), ctx.query)) },
  { method: 'GET', path: '/api/x/address', auth: 'any', handler: async (ctx, app) => withUsd(app, await xAddress(pickNode(ctx, app), ctx.query)) },
  // Exchange prices (server/collect/markets.js). Asking is what keeps the feed polling.
  {
    method: 'GET', path: '/api/markets', auth: 'any',
    handler: async (ctx, app) => {
      if (!app.markets) return { ok: true, enabled: false, note: MARKETS_OFF };
      if (!(await marketsPollingOn(app))) return pollingOff(app);
      // ?tf=1m|5m|15m: the finer bars a short chart draws (anything else: the hourly series alone)
      app.markets.touch(ctx.query.tf);
      return app.markets.view(ctx.query.tf);
    },
  },
  // THE SPOT PRICE, for dollar figures on pages that are not Markets (the Mining tab's reward
  // stats, 2026-09-15: "Add dollar figures"): the feed's median while it is polling, else the
  // explorer's cached spot read (two exchanges, at most once a minute) -- and null, saying why,
  // while market polling is off. Does NOT touch the feed: asking the price here never starts
  // the week-long polling that Markets does.
  {
    method: 'GET', path: '/api/price', auth: 'any',
    handler: async (ctx, app) => {
      if (!app.markets) return { ok: true, usd: null, enabled: false, note: MARKETS_OFF };
      if (!(await marketsPollingOn(app))) return { ok: true, usd: null, polling: false, note: POLLING_OFF };
      const p = await Promise.race([app.markets.spot().catch(() => null), new Promise((res) => { setTimeout(res, 1500, null).unref?.(); })]);
      return { ok: true, usd: p?.usd ?? null, at: p?.at ?? null, source: p?.source ?? null };
    },
  },
  // The depth chart: the books as cumulative depth, and the snapshot `ago` seconds earlier.
  {
    method: 'GET', path: '/api/markets/depth', auth: 'any',
    handler: async (ctx, app) => {
      if (!app.markets) return { ok: true, enabled: false, note: MARKETS_OFF };
      if (!(await marketsPollingOn(app))) return pollingOff(app);
      app.markets.touch();
      return app.markets.depthView(Number(ctx.query.ago) || 600);
    },
  },
  {
    method: 'GET', path: '/api/events', auth: 'any',
    handler: (ctx, app) => {
      const since = ctx.query.since != null ? Number(ctx.query.since) : 0;
      const limit = clampInt(ctx.query.limit, 1, 1000, 200);
      // Default: what this monitor observed and decided. Node log lines are a separate
      // source and are not shown as panels any more; ?source=all opts back in for a
      // person debugging the parser itself.
      const src = ctx.query.source ? String(ctx.query.source).split(',') : ['monitor'];
      // THE LOG FEED IN OPEN MODE (audit 2026-09-19, M2 follow-up; the 09-16 loopback gate
      // did not cover this endpoint). With accounts off, ?source=all would hand the node's
      // log -- including the raw, unparsed lines -- to anyone who can reach the port. The
      // log source stays on (the operator's decision, 2026-09-17), but its event-feed rows
      // are operator-visible only: ?source=all is refused with the switch that changes it
      // named, and kind "raw" rows are dropped from every open-mode answer. The gate keys
      // off auth.enabled, not the caller's address -- behind server.trustProxy every
      // request looks local, so an address check would be a fiction. auth.openEventsFromNetwork
      // restores the old reach; with accounts on there is no gate.
      const logClosed = !app.cfg.auth.enabled && app.cfg.auth.openEventsFromNetwork !== true;
      if (logClosed && src.includes('all')) {
        throw new HttpError(403, 'with accounts off, ?source=all is refused: it includes the node log feed, which open deployments keep for the operator -- turn accounts on, or set auth.openEventsFromNetwork to serve it', { code: 'log_feed_closed' });
      }
      const sev = ctx.query.severity ? String(ctx.query.severity).split(',') : null;
      const kinds = ctx.query.kind ? String(ctx.query.kind).split(',') : null;
      const q = ctx.query.q ? String(ctx.query.q).toLowerCase() : null;
      let rows = app.history.eventsSinceSeq(since, limit * 4);
      if (!src.includes('all')) rows = rows.filter((r) => src.includes(r.source ?? 'monitor'));
      if (logClosed) rows = rows.filter((r) => r.kind !== 'raw');
      if (sev) rows = rows.filter((r) => sev.includes(r.severity));
      if (kinds) rows = rows.filter((r) => kinds.includes(r.kind));
      if (q) rows = rows.filter((r) => `${r.text ?? ''} ${r.tag ?? ''} ${r.kind ?? ''}`.toLowerCase().includes(q));
      return { events: rows.slice(0, limit), maxSeq: app.history.eventsSeq, count: rows.length };
    },
  },
  {
    method: 'GET', path: '/api/series', auth: 'any',
    handler: (ctx, app) => {
      const m = pickNode(ctx, app);
      const names = (ctx.query.name ? String(ctx.query.name).split(',') : ['mempool']);
      const range = parseRange(ctx.query.range ?? ctx.query.since, 3600_000);
      const points = clampInt(ctx.query.points, 20, 2000, 240);
      const bucketMs = Math.max(1000, Math.round(range / points / 1000) * 1000);
      const out = { node: m.id, rangeMs: range, bucketMs, series: {} };
      for (const name of names) {
        const fields = SERIES[name];
        if (!fields) throw new HttpError(400, `unknown series "${name}"; known: ${Object.keys(SERIES).join(', ')}`);
        const wantFields = ctx.query.field ? String(ctx.query.field).split(',') : fields.filter((f) => f !== 't');
        const bad = wantFields.filter((f) => !fields.includes(f));
        if (bad.length) throw new HttpError(400, `field(s) ${bad.join(', ')} not in series "${name}"; known: ${fields.join(', ')}`);
        const ring = app.history.forNode(m.id).ring(name);
        out.series[name] = Object.fromEntries(wantFields.map((f) => [
          f, ring.series(f, { since: Date.now() - range, bucketMs, agg: ctx.query.agg ?? 'last' }),
        ]));
      }
      return out;
    },
  },
  {
    // Every configured node with its sync state, so the UI can say WHICH node is
    // which. A single-node deployment that reports "Synced 100%" while a second
    // node three directories away is 72% through an IBD is not lying, but it is
    // not useful either -- and it is exactly what happened on this box.
    method: 'GET', path: '/api/nodes', auth: 'any',
    // A BITCOIN MACHINE CODE NODE IS LISTED ONLY WHEN IT IS 100% SYNCED (operator, 2026-09-19:
    // "only show 100% synced BMC nodes in the drop-down"). A bmc node still in initial sync is
    // a benchmark run, and the picker, the "also syncing" buttons and the attention list all
    // come from here, so it is left out of all three until its sync state says `synced`. It is
    // known as bmc by its own user agent (getnetworkinfo subversion /BitcoinMachineCode:...).
    // A page that remembered it falls back to the primary node, because the list no longer
    // names it. /api/state?node= still answers for it: this hides it, it does not unconfigure it.
    handler: (ctx, app) => ({
      nodes: [...app.monitors.values()].filter((m) => !bmcStillSyncing(m)).map((m) => {
        let sync = null;
        try { sync = m.snapshot({ seriesRanges: {} }).sync; } catch { /* not yet populated */ }
        return {
          id: m.id, label: m.label, color: m.color, rpcUrl: displayUrl(m.node?.rpcUrl ?? m.rpc.url),
          chain: m.state.chain, online: m.rpc.telemetry().online,
          optional: !!m.cfg.optional,
          syncState: sync?.state ?? null, pct: sync?.pct ?? null,
          height: sync?.height ?? null, headers: sync?.headers ?? null,
          syncing: !!sync && sync.state !== 'synced' && sync.state !== 'unknown',
        };
      }),
      primary: app.primary?.id ?? null,
      // Any node needing attention, so a default landing page lands on the work
      // rather than on the node that has none.
      attention: [...app.monitors.values()].filter((m) => !bmcStillSyncing(m)).map((m) => {
        try {
          const sy = m.snapshot({ seriesRanges: {} }).sync;
          // Unknown counts as attention: a node we cannot read is exactly the
          // thing to land on, not something to hide behind a synced sibling.
          return sy && sy.state !== 'synced' ? m.id : null;
        } catch { return null; }
      }).filter(Boolean),
    }),
  },
  {
    method: 'GET', path: '/api/telemetry', auth: 'any',
    handler: async (ctx, app) => ({
      self: app.selfTelemetry(),
      nodes: [...app.monitors.values()].map((m) => ({
        id: m.id,
        rpc: m.rpc.telemetry(),
        log: m.tail ? m.tail.status() : { exists: false },
        tiers: m.state.tierRunAt,
        lastTier: m.tierStats ?? null,
        history: app.history.summary(),
      })),
      sse: app.hub.stats(),
      audit: await app.auditLog.stats(),
    }),
  },
  {
    method: 'GET', path: '/api/config', auth: 'any',
    handler: (ctx, app) => ({
      poll: app.cfg.poll,
      rpc: { maxInFlight: app.cfg.rpc.maxInFlight, minIntervalMs: app.cfg.rpc.minIntervalMs, maxRatePerSec: app.cfg.rpc.maxRatePerSec, timeoutMs: app.cfg.rpc.timeoutMs },
      allowlist: allowlistSummary(),
      actions: { enabled: app.cfg.actions.enabled, allow: app.cfg.actions.allow, requireAdmin: app.cfg.requireAdmin },
      retention: { hours: app.cfg.store.retentionHours, ringCapacity: app.cfg.store.ringCapacity, events: app.cfg.store.maxEventLog },
      // Access posture, so the UI can state it rather than infer it from which
      // buttons happen to be hidden.
      access: app.cfg.auth.enabled
        ? { mode: 'accounts', anonymous: false }
        : { mode: 'open', anonymous: true, role: 'viewer', writesAllowed: app.cfg.actions.allowWritesWithoutAuth },
      // Which source backs each panel, stated rather than implied.
      // The posture itself, so the UI and the smoke suite can assert against the
      // source table instead of a remembered string: which sources are in effect is a
      // fact about this deployment, not a constant.
      log: { enabled: app.cfg.log.enabled === true },
      sources: sourcesFor(app.cfg.log.enabled),
    }),
  },

  // ------------------------------------------------------- RPC passthrough
  {
    method: 'POST', path: '/api/rpc', auth: 'any', csrf: true, body: true,
    handler: async (ctx, app) => {
      const m = pickNode(ctx, app);
      const method = String(ctx.body?.method ?? '');
      const params = Array.isArray(ctx.body?.params) ? ctx.body.params : [];
      const cls = classifyMethod(method);
      if (!cls.allowed) {
        // No RPC name is longer than a few dozen characters; the caller's string is clamped before
        // it is written or echoed (audit 2026-09-16, M6).
        const shown = method.length > 64 ? `${method.slice(0, 64)}… (${method.length} chars)` : method;
        await app.audit({ type: 'rpc-denied', username: ctx.user.username, node: m.id, method: shown, reason: cls.reason, ip: ctx.ip });
        throw new HttpError(403, `${shown || '(empty)'} is not callable from the web UI: ${cls.reason}`, { code: 'rpc_denied' });
      }
      const t0 = Date.now();
      try {
        const result = await m.rpc.call(method, params, {});
        await app.audit({ type: 'rpc', ok: true, username: ctx.user.username, node: m.id, method, ms: Date.now() - t0, ip: ctx.ip });
        return {
          ok: true, node: m.id, method, ms: Date.now() - t0, result,
          note: NODE_REFUSES.has(method) ? 'the node documents this method as refused or worker-owned; an error here is expected behaviour, not a monitor fault' : null,
        };
      } catch (err) {
        // WHAT A NODE SAID IS NOT ALWAYS OURS TO REPEAT (audit 2026-09-19, L1). RpcError carries up
        // to 200 characters of a transport reply's body, and `?node=` can name any configured
        // monitor -- so echoing err.message here was the same read-back primitive the 09-16 M2 fix
        // removed from /api/config/node/test, one console POST to a mispointed node entry away.
        // The full detail is kept where the operator reads: the audit trail, which open mode does
        // not serve. What the HTTP reply carries is the class of failure, verbatim from the same
        // GENERIC table the node-connection probe uses -- and only for the kinds that quote the
        // endpoint; rpc/auth errors are the NODE's own JSON-RPC refusal, not transport noise.
        const GENERIC = {
          timeout: 'the node did not answer in time',
          transport: 'the node could not be reached, or answered with an HTTP error',
          parse: 'the node answered, but not with JSON-RPC',
          breaker: 'the node is backing off after consecutive failures',
        };
        const message = GENERIC[err.kind] ?? err.message;
        await app.audit({ type: 'rpc', ok: false, username: ctx.user.username, node: m.id, method, error: err.message, ip: ctx.ip });
        return { ok: false, node: m.id, method, ms: Date.now() - t0, error: { message, code: err.code ?? null, kind: err.kind ?? 'rpc' } };
      }
    },
  },

  // ------------------------------------------------------------- actions
  {
    method: 'GET', path: '/api/actions', auth: 'any',
    handler: (ctx, app) => ({ enabled: app.cfg.actions.enabled, allowed: app.cfg.actions.allow, actions: visibleActions(app.cfg, ctx.user.role) }),
  },
  {
    method: 'POST', path: '/api/action', auth: 'any', csrf: true, body: true,
    handler: async (ctx, app) => {
      const name = String(ctx.body?.action ?? '');
      const m = pickNode(ctx, app);
      const gate = actionAllowed(app.cfg, name, ctx.user.role);
      if (!gate.ok) {
        await app.audit({ type: 'action-denied', username: ctx.user.username, node: m.id, action: name, reason: gate.reason, ip: ctx.ip });
        throw new HttpError(403, `action "${name}" not permitted: ${gate.reason}`, { code: 'action_denied' });
      }
      if (ctx.body?.confirm !== name) {
        // A typed confirmation of the action name, so a stray click cannot fire.
        throw new HttpError(400, `pass confirm:"${name}" to run this action`, { code: 'confirm_required' });
      }
      // Belt and braces with the config-load guard: a node write arriving over an
      // unauthenticated socket fails even if that check is ever loosened.
      if (!app.cfg.auth.enabled && !app.cfg.actions.allowWritesWithoutAuth) {
        await app.audit({ type: 'action-denied', username: ctx.user.username, node: m.id, action: name, reason: 'writes disabled while accounts are off', ip: ctx.ip });
        throw new HttpError(403, `action "${name}" refused: accounts are off, so this request carries no identity to hold accountable`, { code: 'action_denied' });
      }
      const def = gate.def;
      const params = def.fixed ?? normaliseArgs(def.args, ctx.body?.args);
      if (def.fixed && def.args.length) params.push(...normaliseArgs(def.args.slice(def.fixed.length), ctx.body?.args));
      try {
        const result = await m.rpc.call(def.method, params, {});
        await app.audit({ type: 'action', ok: true, username: ctx.user.username, node: m.id, action: name, method: def.method, ip: ctx.ip, resultPreview: preview(result) });
        return { ok: true, action: name, method: def.method, result };
      } catch (err) {
        await app.audit({ type: 'action', ok: false, username: ctx.user.username, node: m.id, action: name, error: err.message, ip: ctx.ip });
        return { ok: false, action: name, method: def.method, error: { message: err.message, code: err.code ?? null } };
      }
    },
  },

  // --------------------------------------------------------------- admin
  { method: 'GET', path: '/api/users', auth: 'admin', handler: (ctx, app) => ({ users: app.users.list(), roles: ['viewer', 'operator', 'admin'] }) },
  {
    method: 'POST', path: '/api/users', auth: 'admin', csrf: true, body: true,
    handler: async (ctx, app) => {
      const { username, password, role } = ctx.body ?? {};
      try {
        const created = await app.users.createUser(username, password, { role: role ?? 'viewer' });
        await app.audit({ type: 'user-create', username: ctx.user.username, target: created.username, role: created.role, ip: ctx.ip });
        return { ok: true, user: created };
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    },
  },
  {
    // Creates a user with a generated password shown exactly once. There is no
    // email to send a reset link to on a LAN box, so "generate and hand it over"
    // is the honest equivalent -- and never storing it in plaintext is the price.
    method: 'POST', path: '/api/users/generate', auth: 'admin', csrf: true, body: true,
    handler: async (ctx, app) => {
      const uname = String(ctx.body?.username ?? '').toLowerCase().trim();
      const role = ctx.body?.role ?? 'viewer';
      const pw = randomPassword(18);
      try {
        const created = await app.users.createUser(uname, pw, { role });
        await app.audit({ type: 'user-create', username: ctx.user.username, target: created.username, role: created.role, generated: true, ip: ctx.ip });
        return { ok: true, user: created, password: pw, warning: 'this password is shown once and is not stored in recoverable form' };
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    },
  },
  {
    method: 'POST', path: '/api/users/:username/role', auth: 'admin', csrf: true, body: true,
    handler: async (ctx, app) => {
      try {
        const r = await app.users.setRole(ctx.params.username, ctx.body?.role);
        app.sessions.destroyForUser(app.users.find(ctx.params.username)?.id);
        await app.sessions.save().catch(() => {});
        await app.audit({ type: 'user-role', username: ctx.user.username, target: r.username, role: r.role, ip: ctx.ip });
        return { ok: true, user: r };
      } catch (err) { throw new HttpError(400, err.message); }
    },
  },
  {
    method: 'POST', path: '/api/users/:username/disabled', auth: 'admin', csrf: true, body: true,
    handler: async (ctx, app) => {
      try {
        const r = await app.users.setDisabled(ctx.params.username, !!ctx.body?.disabled);
        if (r.disabled) {
          app.sessions.destroyForUser(app.users.find(ctx.params.username)?.id);
          await app.sessions.save().catch(() => {});
        }
        await app.audit({ type: 'user-disabled', username: ctx.user.username, target: r.username, disabled: r.disabled, ip: ctx.ip });
        return { ok: true, user: r };
      } catch (err) { throw new HttpError(400, err.message); }
    },
  },
  {
    method: 'POST', path: '/api/password', auth: 'any', csrf: true, body: true,
    handler: async (ctx, app) => {
      if (!app.cfg.auth.enabled) throw new HttpError(403, 'accounts are disabled, so there are no passwords to change (start with BLOCKYARD_AUTH=1)');
      const current = String(ctx.body?.current ?? '');
      const next = String(ctx.body?.password ?? '');
      const who = ctx.user.role === 'admin' && ctx.body?.username ? String(ctx.body.username) : ctx.user.username;
      if (who !== ctx.user.username) needRole(ctx, 'admin');
      else {
        const check = await app.users.verify(ctx.user.username, current);
        if (!check.ok) throw new HttpError(403, 'current password is incorrect');
      }
      try {
        await app.users.setPassword(who, next);
        app.sessions.destroyForUser(app.users.find(who)?.id);
        await app.sessions.save().catch(() => {});
        ctx.clearCookie(app.cfg.auth.cookieName);
        await app.audit({ type: 'password-change', username: ctx.user.username, target: who, ip: ctx.ip });
        return { ok: true, signedOut: true, note: 'sessions revoked; sign in again with the new password' };
      } catch (err) { throw new HttpError(400, err.message); }
    },
  },
  {
    // The audit trail names who did what, which only means something if there is a
    // who. With accounts off every entry would read "anonymous", so the endpoint
    // says so instead of serving a trail that cannot attribute anything.
    method: 'GET', path: '/api/audit', auth: 'admin',
    handler: async (ctx, app) => {
      if (!app.cfg.auth.enabled) {
        return { entries: [], disabled: true, note: 'accounts are off, so audit entries could name nobody; start with BLOCKYARD_AUTH=1 to record per-user activity' };
      }
      const limit = clampInt(ctx.query.limit, 1, 500, 100);
      // `log` is the state of the audit file itself. An audit trail that silently
      // stopped rotating, or failed to rotate, is a disk-usage incident in progress
      // -- and an audit trail nobody can see the size of is a lie waiting to happen.
      return { entries: await app.readAudit(limit), limit, log: await app.auditLog.stats() };
    },
  },

  // ------------------------------------------------------ node connection
  // (operator, 2026-09-12: "Still left to do is a config connection in the web settings. We have no
  // way for users to configure a connection to their rpc backend".)
  //
  // TWO ROUTES, DELIBERATELY. Testing a connection and committing it are different acts: the test
  // writes nothing at all, and the save exists so a working answer can be kept. That is the
  // operator's own ordering -- "We should only install the systemd after confirming a working
  // connection to the server and everything works."
  {
    method: 'POST', path: '/api/config/node/test', auth: 'any', csrf: true, body: true,
    handler: async (ctx, app) => {
      nodeConfigAllowed(app, ctx);
      const node = candidateNode(app, ctx.body);
      const started = Date.now();
      // A THROWAWAY CLIENT WITH ITS OWN LANE. The live node's client holds a serialized queue
      // against a single-threaded RPC server; probing somewhere else must not take a slot in it.
      //
      // CREDENTIALS GO TO ONE ENDPOINT ONLY: the one this monitor is already configured for.
      //
      // This route used to build the probe as `{ ...app.cfg.nodes[0], ...node }`, so it inherited
      // the live node's datadir and resolveCookie() read the real .cookie -- which the client then
      // sent as an Authorization header TO WHATEVER URL THE REQUEST NAMED. With accounts off (the
      // shipped default) the route needs no session, and the CSRF check is skipped without one, so
      // a single unauthenticated POST -- including a plain cross-site HTML form, since readBody
      // accepts x-www-form-urlencoded -- moved the node's RPC credential to any address the caller
      // chose. Confirmed with a working proof of concept on 2026-09-13 against a planted cookie:
      // the collector received it as `Authorization: Basic <the cookie>`.
      //
      // Dropping the spread alone does NOT fix it: candidateNode falls back to the configured
      // datadir, so a request naming only an rpcUrl would still resolve the real cookie. The rule
      // has to be about the DESTINATION. Same endpoint: authenticate as we already do. Any other
      // endpoint: no datadir, no cookieFile, no rpcUser -- resolveCookie returns null and the
      // client sends no Authorization header at all.
      const cur = app.cfg.nodes?.[0] ?? {};
      const sameEndpoint = !!cur.rpcUrl && node.rpcUrl === cur.rpcUrl;
      const probeNode = sameEndpoint
        ? { ...cur, ...node, id: 'probe' }
        : { rpcUrl: node.rpcUrl, chainHint: node.chainHint, id: 'probe' };
      const probe = new RpcClient(probeNode,
        { ...app.cfg.rpc, timeoutMs: Math.min(app.cfg.rpc.timeoutMs ?? 8000, 8000) }, { log: () => {} });
      try {
        const info = await probe.call('getblockchaininfo', []);
        return {
          ok: true, ms: Date.now() - started, authenticated: sameEndpoint,
          chain: info?.chain ?? null, blocks: info?.blocks ?? null,
          ibd: info?.initialblockdownload ?? null,
        };
      } catch (err) {
        // A 401 from a NEW endpoint is the expected answer, not a fault: it proves the address is
        // an RPC server, which is what the form needs to know. Saying so beats reporting a
        // mysterious auth failure for a credential we deliberately did not send.
        if (!sameEndpoint && (err.kind === 'auth' || /\b401\b/.test(err.message ?? ''))) {
          return {
            ok: true, ms: Date.now() - started, authenticated: false, reachable: true,
            chain: null, blocks: null, ibd: null,
            note: 'the endpoint answered, and refused an unauthenticated call -- which is what an RPC server should do. '
              + 'Credentials are only sent to the endpoint this monitor is already configured for, so authentication was not tested. '
              + 'Save this connection and the monitor will use the datadir cookie for it.',
          };
        }
        // A failed probe is an ANSWER, not a server error: the form needs the reason to show it.
        // `authenticated` is reported on EVERY path, success or failure: a caller cannot otherwise
        // tell "it refused us" from "we deliberately sent no credential", and those mean different
        // things to someone deciding whether the connection they typed is right.
        //
        // NOT WHAT A FOREIGN ENDPOINT SAID (audit 2026-09-16, M2). RpcClient's message carries up to
        // 200 characters of the reply body, so echoing it made this route a way to read internal URLs
        // through the server. For any endpoint but the configured one, the answer is the class of
        // failure only.
        const GENERIC = {
          timeout: 'the endpoint did not answer in time',
          transport: 'the endpoint could not be reached, or answered with an HTTP error',
          parse: 'the endpoint answered, but not with JSON-RPC: this is not a Bitcoin Core RPC port',
          rpc: 'the endpoint answered with an RPC error',
          breaker: 'the endpoint could not be reached',
        };
        const message = sameEndpoint ? err.message : (GENERIC[err.kind] ?? 'the connection failed');
        return {
          ok: false, ms: Date.now() - started, authenticated: sameEndpoint,
          error: { message, kind: err.kind ?? null, code: sameEndpoint ? (err.code ?? null) : null },
        };
      }
    },
  },
  {
    method: 'POST', path: '/api/config/node', auth: 'any', csrf: true, body: true,
    handler: async (ctx, app) => {
      nodeConfigAllowed(app, ctx);
      if (!app.configFile) {
        throw new HttpError(409, 'this process was started without a config file (BLOCKYARD_CONFIG=none), so there is nowhere to save to', { code: 'no_config_file' });
      }
      if (ctx.body?.confirm !== 'save') throw new HttpError(400, 'pass confirm:"save" to write the configuration', { code: 'confirm_required' });
      const node = candidateNode(app, ctx.body);

      // Merge into whatever the file already says, so keys this form does not own survive.
      let fileCfg = {};
      try { fileCfg = JSON.parse(await fsp.readFile(app.configFile, 'utf8')); } catch { fileCfg = {}; }
      const nodes = Array.isArray(fileCfg.nodes) && fileCfg.nodes.length ? fileCfg.nodes.slice() : [];
      // UNDEFINED VALUES ARE NOT CHANGES. A key present with an undefined value still spreads, and
      // JSON.stringify then omits it -- so carrying `{...cur}` across could DELETE a field from the
      // file rather than preserve it. Only real values take part in the merge.
      const changes = Object.fromEntries(Object.entries(node).filter(([, v]) => v !== undefined));
      // CREDENTIALS BELONG TO AN ENDPOINT (audit 2026-09-16, M1). The merge kept rpcUser, rpcPassword
      // and cookieFile while the URL changed, so a saved address inherited another server's secret.
      // When the host or port changes they are dropped; the cookie is then read from the datadir the
      // form names, which is the credential this form was always meant to use.
      const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
      const prior = nodes[0] ?? {};
      const droppedCredentials = [];
      if (prior.rpcUrl && hostOf(prior.rpcUrl) !== hostOf(changes.rpcUrl)) {
        for (const k of ['rpcUser', 'rpcPassword', 'cookieFile']) if (k in prior) droppedCredentials.push(k);
      }
      nodes[0] = { ...prior, ...changes };
      for (const k of droppedCredentials) delete nodes[0][k];
      if (droppedCredentials.length && !nodes[0].datadir) {
        throw new HttpError(400, 'a new endpoint needs a datadir, so its own .cookie can be read', { code: 'need_datadir' });
      }
      delete nodes[0].__urlOverridden;
      const next = { ...fileCfg, nodes };

      // tmp + fsync + rename: a reader sees the old file or the new one, never a half-written one.
      await fsp.mkdir(path.dirname(app.configFile), { recursive: true });
      const tmp = `${app.configFile}.tmp`;
      const fh = await fsp.open(tmp, 'w', 0o600);
      await fh.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await fh.sync();
      await fh.close();
      await fsp.rename(tmp, app.configFile);

      // THE HONEST PART. The environment is applied AFTER the file is merged (config.js), so on a
      // box whose unit sets BLOCKYARD_NODE_URL the file is written and then overridden. Saying
      // "saved" without saying that would be a lie the operator only discovers after a restart.
      const envOverrides = ['BLOCKYARD_NODE_URL', 'BLOCKYARD_DATADIR', 'BLOCKYARD_LOGFILE', 'BLOCKYARD_COOKIE', 'BLOCKYARD_NODE_LABEL']
        .filter((k) => process.env[k] !== undefined && process.env[k] !== '');
      await app.audit({ type: 'config-node', username: ctx.user.username, ip: ctx.ip, rpcUrl: node.rpcUrl, file: app.configFile });
      return {
        ok: true, file: app.configFile, restartRequired: true, envOverrides, droppedCredentials,
        note: envOverrides.length
          ? `saved, but this process takes its node from ${envOverrides.join(', ')}, which the environment sets and which beats the file — change the unit or drop-in, or the restart will keep the old endpoint`
          : 'saved; restart the monitor for it to take effect',
      };
    },
  },

  // ---------------------------------------------------------- display settings
  // (operator, 2026-09-13: "This is a server app. Should store things on a server", of the display
  // settings that until now lived in each browser's localStorage.)
  //
  // They were per-browser by an earlier decision -- "a kiosk screen and a laptop looking at the
  // same monitor want different answers, and neither should need an account to have one". The cost
  // of that was the one the operator hit: the settings existed nowhere the app could read, so they
  // could not be backed up, shared between machines, or even looked at from the server.
  //
  // THE SERVER KEEPS THE BLOB AND NOTHING ELSE. It does not know the schema and must not grow one:
  // public/js/settings.js normalise() clamps every value on the way in, so a hand-edited file
  // cannot put the UI into a state the panel could not. What the server owes is durability, a size
  // limit, and the same gate as every other config write.
  {
    method: 'GET', path: '/api/settings', auth: 'any',
    handler: async (ctx, app) => {
      try {
        const raw = await fsp.readFile(app.settingsFile, 'utf8');
        return { settings: JSON.parse(raw), file: pathFor(ctx, app.settingsFile), stored: true };
      } catch (err) {
        // Nothing saved yet is the normal first-run answer, not a fault: the client then keeps its
        // own defaults and offers to push them up. A CORRUPT file is different and says so.
        if (err.code === 'ENOENT') return { settings: null, file: pathFor(ctx, app.settingsFile), stored: false };
        return { settings: null, file: pathFor(ctx, app.settingsFile), stored: false, error: `unreadable: ${err.message.replaceAll(app.settingsFile, pathFor(ctx, app.settingsFile))}` };
      }
    },
  },
  {
    method: 'POST', path: '/api/settings', auth: 'any', csrf: true, body: true,
    handler: async (ctx, app) => {
      configWriteAllowed(app, ctx);
      const s = ctx.body?.settings;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        throw new HttpError(400, 'send { settings: { ... } }', { code: 'bad_settings' });
      }
      // A cap, because this is a body from a browser and the file is written to disk. The whole
      // settled object is a couple of kilobytes; 256 KB is room to grow and still far from a way
      // to fill a disk one POST at a time.
      const text = `${JSON.stringify(s, null, 2)}\n`;
      if (text.length > 262_144) throw new HttpError(413, 'settings too large', { code: 'too_large' });

      await fsp.mkdir(path.dirname(app.settingsFile), { recursive: true });
      const tmp = `${app.settingsFile}.tmp`;
      const fh = await fsp.open(tmp, 'w', 0o600);
      await fh.writeFile(text);
      await fh.sync();
      await fh.close();
      await fsp.rename(tmp, app.settingsFile);

      return { ok: true, file: pathFor(ctx, app.settingsFile), bytes: text.length };
    },
  },
];

// ----------------------------------------------------------------- views

function fullState(ctx, app) {
  const m = pickNode(ctx, app);
  // ?series=none is the cheap poll; the chart data comes from /api/series or the
  // separate `series` SSE event on its own slower cadence.
  const wantSeries = ctx.query.series === 'none' ? {} : {
    hour: parseRange(ctx.query.range, 3600_000),
    hours6: parseRange(ctx.query.range6, 21600_000),
    day: RANGES['24h'],
  };
  const s = m.snapshot({ seriesRanges: wantSeries });
  return {
    ...s,
    app: {
      version: app.version,
      build: app.build,
      scheme: app.scheme,
      uptimeSec: Math.round((Date.now() - app.startedAt) / 1000),
      sseClients: app.hub.stats().clients,
      self: app.selfTelemetry(),
      serverTime: Date.now(),
    },
    user: ctx.user ? publicUser(ctx.user) : null,
    seq: app.stateSeq,
  };
}

const HEX64 = /^[0-9a-fA-F]{64}$/;
const TX_PAGE = 50; // txids returned per block view; the count is always the real one

function drillError(m, query, err, hint) {
  // 200 with ok:false, like /api/rpc: the node's own refusal is the information,
  // and a 5xx would bury it behind the server's generic error shape.
  return {
    ok: false,
    node: m.id,
    query,
    error: { message: err?.message ?? String(err), code: err?.code ?? null, kind: err?.kind ?? 'rpc' },
    hint: hint ?? null,
  };
}

/**
 * One block: header, statistics, and the first page of txids.
 *
 * Accepts ?hash=, ?height=, or neither (the current tip). A height that is not
 * stored is the node's own error, quoted rather than turned into a 404 of our own
 * invention -- the difference matters when the answer is "pruned", not "typo".
 */
async function blockDrill(ctx, app) {
  const m = pickNode(ctx, app);
  const hashArg = ctx.query.hash ? String(ctx.query.hash).trim() : null;
  const heightArg = ctx.query.height != null && ctx.query.height !== '' ? String(ctx.query.height).trim() : null;
  const query = { hash: hashArg, height: heightArg };
  if (hashArg && !HEX64.test(hashArg)) throw new HttpError(400, `"${hashArg}" is not a 64-hex-character block hash`);
  if (heightArg != null && !/^\d{1,12}$/.test(heightArg)) throw new HttpError(400, `"${heightArg}" is not a block height`);
  // AND NOT ABSURDLY ABOVE THE TIP. The regex alone admits 999,999,999,999, and each such request
  // spends a turn in the node's SINGLE-THREADED RPC lane only to be told "block height out of
  // range" -- the lane this whole app is built to be careful with. (Audit, 2026-09-13.)
  //
  // The 1000-block margin is deliberate, not slack: our chainInfo is a cached poll and can be a
  // block or two behind, so clamping hard at the tip would refuse the block that was mined a
  // second ago. Rejecting a real block the operator just saw would be a worse defect than the
  // wasted turn this prevents.
  const knownTip = m.state.chainInfo?.blocks ?? null;
  if (heightArg != null && knownTip != null && Number(heightArg) > knownTip + 1000) {
    throw new HttpError(400, `block ${heightArg} is above this node's tip (${knownTip})`, { code: 'above_tip' });
  }

  let height = heightArg != null ? Number(heightArg) : null;
  let hash = hashArg;
  try {
    if (!hash) {
      if (height == null) {
        height = m.state.chainInfo?.blocks ?? null;
        if (height == null) throw new HttpError(503, 'this node has not answered getblockchaininfo yet, so there is no tip to show');
      }
      hash = await m.rpc.call('getblockhash', [height]);
    }
    const block = await m.rpc.call('getblock', [hash, 1]);
    // getblockstats by hash: one extra lane turn, and the only way to get per-block
    // fees without fetching the whole block's transactions.
    const stats = await m.rpc.call('getblockstats', [hash, ['totalfee', 'txs', 'size', 'weight', 'avgfee', 'medianfee', 'maxfee', 'feerate_percentiles', 'subsidy', 'utxo_increase', 'ins', 'outs']])
      .catch((err) => ({ error: { message: err.message } }));
    const txids = Array.isArray(block.tx) ? block.tx : [];
    return {
      ok: true,
      node: m.id,
      requested: { ...query, resolvedHash: hash, resolvedHeight: block.height ?? height },
      ms: null,
      header: {
        hash: block.hash ?? hash,
        confirmations: block.confirmations ?? null,
        height: block.height ?? height,
        version: block.version ?? null,
        size: block.size ?? null,
        weight: block.weight ?? null,
        time: block.time ?? null,
        mediantime: block.mediantime ?? null,
        merkleRoot: block.merkleroot ?? null,
        txCount: txids.length || block.nTx || null,
        nTx: block.nTx ?? txids.length,
        previousblockhash: block.previousblockhash ?? null,
        nextblockhash: block.nextblockhash ?? null,
        bits: block.bits ?? null,
        difficulty: block.difficulty ?? null,
        chainTrust: block.chaintrust ?? block.chainwork ?? null,
      },
      stats: stats?.error ? null : stats,
      statsError: stats?.error?.message ?? null,
      txids: txids.slice(0, TX_PAGE),
      txidsShown: Math.min(txids.length, TX_PAGE),
      txidsTotal: txids.length || block.nTx || null,
      truncated: txids.length > TX_PAGE,
      notes: [
        'header + txids only: getblock verbosity=2 costs this node 11 MB of hex per block (measured 2026-09-08) and still omits Core\'s fee fields',
        txids.length > TX_PAGE ? `${txids.length - TX_PAGE} further txid(s) not listed; ask the node directly or drill in from a mempool row` : null,
        block.confirmations === 0 ? 'confirmations 0: this is not on the best chain (orphan or reorged out)' : null,
      ].filter(Boolean),
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const hint = /blocks of availability|have block|No such block|not on disk|Cannot obtain block/i.test(err?.message ?? '')
      ? 'the node does not have this block stored (pruned, or a height from before the last prune); pick a height the block list actually covers'
      : null;
    return drillError(m, query, err, hint);
  }
}

/**
 * One transaction, decoded by the node (verbosity 1) rather than by us.
 *
 * What is *not* here is the fee. Computing it means fetching every input's
 * prevout, which is N more lane turns per lookup on a server with one thread, and
 * this node does not include fee/deltafee in its verbose reply anyway (MEASUREMENTS
 * §6). So `notReported` names it, and no field pretends otherwise (rule 3).
 */
async function txDrill(ctx, app) {
  const m = pickNode(ctx, app);
  const txid = ctx.query.txid ? String(ctx.query.txid).trim() : null;
  const blockHash = ctx.query.block ? String(ctx.query.block).trim() : null;
  const query = { txid, block: blockHash };
  if (!txid) throw new HttpError(400, 'txid is required');
  if (!HEX64.test(txid)) throw new HttpError(400, `"${txid}" is not a 64-hex-character txid`);
  if (blockHash && !HEX64.test(blockHash)) throw new HttpError(400, `"${blockHash}" is not a block hash`);
  try {
    const params = blockHash ? [txid, true, blockHash] : [txid, true];
    const tx = await m.rpc.call('getrawtransaction', params);
    if (typeof tx === 'string') {
      // verbosity 1 asked for, hex came back: this node answered the compact form.
      return {
        ok: true, node: m.id, requested: query, decoded: false, sizeHex: tx.length / 2,
        notes: ['the node answered with raw hex despite verbosity=1; decoding it here would be inventing a parser for a node whose answers have already changed shape three times today'],
      };
    }
    const trunc = (s, n = 96) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s ?? null);
    return {
      ok: true,
      node: m.id,
      requested: query,
      txid: tx.txid ?? txid,
      size: tx.size ?? null,
      vsize: tx.vsize ?? null,
      weight: tx.weight ?? null,
      version: tx.version ?? null,
      locktime: tx.locktime ?? null,
      inMempool: tx.confirmations == null,
      blockHash: tx.blockhash ?? null,
      blockHeight: tx.blockheight ?? null,
      confirmations: tx.confirmations ?? null,
      blockTime: tx.blocktime ?? null,
      time: tx.time ?? null,
      inputs: (tx.vin ?? []).slice(0, 40).map((v) => ({
        txid: v.txid ?? null,
        vout: v.vout ?? null,
        sequence: v.sequence ?? null,
        scriptSigAsm: trunc(v.scriptSig?.asm),
        scriptSigType: v.scriptSig?.type ?? null,
        witness: Array.isArray(v.txinwitness) ? v.txinwitness.map((w) => trunc(w, 32)) : null,
        value: v.value ?? null,
        address: v.address ?? null,
      })),
      inputsTotal: (tx.vin ?? []).length,
      outputs: (tx.vout ?? []).slice(0, 40).map((v) => ({
        n: v.n ?? null,
        value: v.value ?? null,
        scriptPubKeyType: v.scriptPubKey?.type ?? null,
        address: v.scriptPubKey?.address ?? v.scriptPubKey?.addresses?.[0] ?? null,
        scriptPubKeyAsm: trunc(v.scriptPubKey?.asm),
        spent: v.spentIndex ? { txid: v.spentIndex.spendingTxid, n: v.spentIndex.spendingIndex } : null,
      })),
      outputsTotal: (tx.vout ?? []).length,
      totalOutSat: (tx.vout ?? []).reduce((a, v) => (Number.isFinite(v?.value) ? a + Math.round(v.value * 1e8) : a), 0) || null,
      notReported: [
        'fee / feerate (needs every input\'s prevout, which is N more turns on a one-threaded RPC server; this node also omits fee from its verbose reply)',
        (tx.vout ?? []).length > 40 ? `${(tx.vout ?? []).length - 40} output(s) beyond the first 40 not listed` : null,
        (tx.vin ?? []).length > 40 ? `${(tx.vin ?? []).length - 40} input(s) beyond the first 40 not listed` : null,
      ].filter(Boolean),
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const hint = /Transaction not found|no information available|not found in the chain|does not exist/i.test(err?.message ?? '')
      ? 'not in the mempool' + (blockHash ? '' : ' — if it is confirmed, add &block=<blockhash>, which some nodes need to find a transaction that has left the pool')
      : null;
    return drillError(m, query, err, hint);
  }
}

function mempoolView(m) {
  const s = m.snapshot({ seriesRanges: {} });
  return {
    node: m.id,
    // What kind of data this is, stated rather than implied by the word "live":
    // the node refuses zmqpubsequence, so there is no per-transaction add/remove
    // stream to show and no UI wording should imply one (docs/DEFECTS.md).
    feed: {
      kind: 'poll',
      cadenceSec: 20,
      streamAvailable: false,
      why: 'the node refuses zmqpubsequence: it can publish adds but has no clean "removed" choke point, so a diff of successive polls would report evictions as removes only when the poll happened to straddle them',
      source: 'getrawmempool verbose on the 20 s pool tier',
    },
    info: s.mempool,
    // The full distribution including the scatter points, which the snapshot
    // deliberately leaves out.
    dist: m.state.mempoolDist,
    // Fields this node does not report, stated so the UI shows "not reported"
    // instead of an empty box that reads as zero.
    notReported: [
      s.mempool.dist?.pendingAncestors == null ? 'pendingancestors' : null,
      s.mempool.dist?.replaceable == null ? 'replaceable (BIP125) flag' : null,
      'fees.prioritiserved', 'modifiedfees', 'ancestorcount/ancestorfees', 'withdrawreason', 'replaced-by',
    ].filter(Boolean),
    log: {
      lastDrain: s.logState?.lastDrain ?? s.mempool.lastDrain ?? null,
      orphans: m.state.logState.orphans ?? null,
      orphanDetail: m.state.logState.orphanDetail ?? null,
      accept: m.state.logState.lastTxAccept ?? null,
      relayRate: m.state.logState.relayRate ?? null,
    },
    fees: s.fees,
    history: {
      count: app_ring(m, 'mempool', 'count'),
      usage: app_ring(m, 'mempool', 'usage'),
    },
  };
}

/** A Bitcoin Machine Code node not yet 100% synced: kept out of the node list (see /api/nodes). */
export function bmcStillSyncing(m) {
  if (!/^\/BitcoinMachineCode:/.test(m.state?.networkInfo?.subversion ?? '')) return false;
  let sync = null;
  try { sync = m.snapshot({ seriesRanges: {} }).sync; } catch { return true; }
  return sync?.state !== 'synced';
}

function app_ring(m, seriesName, field) {
  const r = m.history?.ring?.(seriesName);
  if (!r) return null;
  return r.tail(60).map((row) => ({ t: row.t, v: row[field] ?? null }));
}

function peersView(m) {
  const s = m.snapshot({ seriesRanges: {} });
  return {
    node: m.id,
    counts: {
      connections: s.peers.connections, in: s.peers.in, out: s.peers.out, wanted: s.peers.wanted,
      budget: s.peers.budget, banned: s.peers.banned, bannedOf: s.peers.bannedOf,
    },
    ranking: s.peers.ranking,
    identitySource: s.peers.identitySource,
    // The `[dl]` identity rows (user agent, protocol, the peer's own height, direction).
    // Parsed since the first build of this monitor, returned by the snapshot, and never
    // drawn until now — data collected and then dropped on the floor.
    identity: s.peers.identity ?? null,
    rpcRows: s.peers.rpcRows,
    rpcUpdatedAt: s.peers.rpcRowsUpdatedAt,
    // The peer table the node's own RPC gives us, verbatim, next to the log
    // derived activity that exists because it is empty.
    rpcPeers: m.state.peers.list,
    activity: s.peers.activity,
    recentEvents: s.peers.recentEvents,
    // the node's getnetworkinfo, as docs/API.md describes it -- the snapshot keeps it under
    // `nodeNetwork` since 2026-09-19, because its `network` is the Mining page's network row
    network: s.nodeNetwork,
  };
}

// Exported for tests: this is the function that decides whether an absent figure is
// reported as absent, so it must be reachable without booting an app and a fake node.
export function netView(m) {
  const s = m.snapshot({ seriesRanges: {} });
  // Every gap in one list, in words. It used to hold exactly one entry (upload), which
  // meant that in RPC-only mode — where a dozen figures lose their only source at once
  // — the list came back *empty*, saying less the less there was. That is the inverse of
  // the purpose: the list has to grow when the sources go away.
  const unavailable = [];
  if (!s.net.uploadMeasured) {
    unavailable.push('outbound bytes / upload rate: getnettotals reports 0 in this deployment and no other source carries it');
  }
  if (!s.net.downloadMeasured) {
    unavailable.push('inbound bytes / download rate: totalbytesrecv has read 0 for the whole uptime on this build, so 0 B/s would be a claim about an idle node rather than an absence');
  }
  if (!m.logEnabled) {
    unavailable.push('log-only figures (no RPC source, and the log tail is off by configuration): which peer served a block, per-peer download rate and relay legs, the mempool accept/reject breakdown, disk-write rate and write totals, the download worker\'s banned-peer count, the node\'s own IBD eta, UTXO compaction and validation stalls, archive-layout holes, sync_failing');
  }
  return {
    node: m.id,
    measured: {
      inBps: s.net.inBps, diskWriteBps: s.net.diskWriteBps,
      netTotalLog: s.net.netTotalLog, diskTotal: s.net.diskTotal,
      avgRecv: s.net.avgRecv, avgWrite: s.net.avgWrite,
      floor: s.net.floor, poolMedian: s.net.poolMedian,
      // Named per mode. Claiming "node log [dlc] tick lines" while the tail is closed
      // is a provenance lie. Note what this string deliberately does NOT say: it used
      // to assert "the deployed build counts 0 bytes", which was false within the hour
      // of being written (MEASUREMENTS 23 — the same process read 0/0 at 09:36 and
      // 23,955,131 bytes at 17:36, no restart). A row that names a build's behaviour is
      // a claim that rots; the gate on the field next to it is the live answer.
      source: m.logEnabled
        ? 'node log [dlc] tick lines'
        : 'getnettotals delta rate (RPC) — reported only while that counter moves; it has read 0 for whole uptimes on some builds and started counting mid-uptime on others',
      downloadMeasured: s.net.downloadMeasured,
    },
    rpc: { totalRecv: s.net.totalRecvRpc, totalSent: s.net.totalSentRpc, uploadtarget: s.net.uploadtarget, uploadMeasured: s.net.uploadMeasured },
    // An upload rate we do not have is said so here, in words, so no chart can
    // imply one. See the nettotals-zero quality flag.
    unavailable,
    peers: { connections: s.peers.connections, in: s.peers.in, out: s.peers.out, wanted: s.peers.wanted },
    series: s.series.net,
    formatted: { inBps: s.net.inBps == null ? null : formatBytes(s.net.inBps) + '/s', disk: s.net.diskTotal == null ? null : formatBytes(s.net.diskTotal) },
  };
}

function blockStats(recent) {
  if (!recent.length) return null;
  const fees = recent.map((b) => b.totalfee).filter((v) => v != null);
  const sizes = recent.map((b) => b.size).filter((v) => v != null);
  const txs = recent.map((b) => b.txs).filter((v) => v != null);
  const gaps = recent.map((b) => b.gapSec).filter((v) => v != null && v >= 0 && v < 7200);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    count: recent.length,
    spanSec: recent.length > 1 ? Math.round((recent[0].t - recent[recent.length - 1].t) / 1000) : null,
    totalFeesSat: fees.length ? sum(fees) : null,
    avgFeesSat: fees.length ? Math.round(sum(fees) / fees.length) : null,
    avgSize: sizes.length ? Math.round(sum(sizes) / sizes.length) : null,
    maxSize: sizes.length ? Math.max(...sizes) : null,
    avgTxs: txs.length ? Math.round(sum(txs) / txs.length) : null,
    avgGapSec: gaps.length ? +(sum(gaps) / gaps.length).toFixed(1) : null,
    medGapSec: gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null,
    etaCadence: gaps.length ? formatEta(Math.round(sum(gaps) / gaps.length)) : null,
  };
}

function visibleActions(cfg, role) {
  return Object.entries(ACTIONS).map(([name, def]) => ({
    name, label: def.label, note: def.note, args: def.args, requiredRole: def.role,
    enabled: cfg.actions.enabled && cfg.actions.allow.includes(name),
    permittedForYou: actionAllowed(cfg, name, role).ok,
    method: def.method,
  }));
}

function publicUser(u) {
  if (!u) return null;
  return { username: u.username, role: u.role, id: u.id, disabled: !!u.disabled, lastLoginAt: u.lastLoginAt ?? null };
}

function normaliseArgs(spec = [], args = {}) {
  const out = [];
  for (const s of spec) {
    const key = s.replace(/\?$/, '');
    const optional = s.endsWith('?');
    if (args?.[key] !== undefined) out.push(args[key]);
    else if (!optional) out.push(undefined);
  }
  while (out.length && out[out.length - 1] === undefined) out.pop();
  return out;
}

function preview(result) {
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  return s == null ? null : s.slice(0, 200);
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export { ban };
