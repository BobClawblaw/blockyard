// Entry point: build the app, boot the monitors, serve, and shut down cleanly.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { History } from './store/history.js';
import { AuditLog } from './store/audit.js';
import { UserStore, randomPassword } from './auth/users.js';
import { SessionStore, RateLimiter, LoginGuard } from './auth/sessions.js';
import { StreamHub } from './http/sse.js';
import { createAppServer } from './http/server.js';
import { computeBuildId } from './http/static.js';
import { NodeMonitor } from './collect/monitor.js';
import { localAddresses, bindProblemMessage, planBinds } from './netinfo.js';
import { ensureSelfSigned } from './tls/selfsigned.js';
import { inspectTls } from './config.js';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ONE PLACE, NOT TWO. This was a literal here AND a "version" field in package.json, and on
// 2026-09-13 they had drifted: this said 0.0.9 while CHANGELOG.md released [0.9.0]. Harmless until
// something compares versions -- and the auto-update design (docs/AUTO-UPDATE.md) compares exactly
// this field to decide whether a release is newer, so the drift would have made it answer wrongly.
// package.json is the authority; a test asserts the two agree.
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export async function boot({ configFile, log: logOverride = null } = {}) {
  const cfg = loadConfig({ configFile });
  await fsp.mkdir(cfg.store.dir, { recursive: true });
  await fsp.mkdir(cfg.auth.dataDir, { recursive: true });

  const app = {
    version: VERSION,
    cfg,
    // the file the settings were read from, or null for a run that was given none
    configFile: cfg.__configFile ?? null,
    // DISPLAY SETTINGS live on the server (operator, 2026-09-13: "This is a server app. Should
    // store things on a server"). They were per-browser localStorage, which meant a kiosk screen
    // and a desk looking at the same monitor kept different answers and neither could be read back.
    // Beside local.json rather than in data/: it is configuration a person chose, not runtime state.
    //
    // DERIVED FROM THE CONFIG FILE, not pinned to ROOT. A hardcoded repo path meant any test that
    // POSTed settings wrote the REAL config/blockyard.json of the working copy -- a test run
    // clobbering a deployment's own preferences. Following configFile puts it in the temp dir for a
    // hermetic boot and leaves it exactly where it already is for this one (the unit sets no
    // BLOCKYARD_CONFIG, so configFile is ROOT/config/local.json and the dirname is unchanged).
    // env is deliberately NOT the lever: helpers/http.js touches no process.env, because Node runs
    // a file's tests concurrently and a mutated var leaks into a sibling's boot.
    settingsFile: path.join(
      cfg.__configFile ? path.dirname(cfg.__configFile) : path.join(ROOT, 'config'),
      'blockyard.json',
    ),
    startedAt: Date.now(),
    publicDir: path.join(ROOT, 'public'),
    // the DOOM Diversion's game files, where the operator put them (http/doom.js)
    doomDir: path.join(ROOT, 'games', 'doom_dos'),
    monitors: new Map(),
    stateSeq: 0,
    rssStart: process.memoryUsage().rss,
    cpuStart: process.cpuUsage(),
    selfRing: [],
  };

  app.log = logOverride ?? makeLogger(cfg);
  // `logOverride` exists so a test can capture what the boot said. The alternative —
  // replacing process.stdout.write for the duration — raced the test runner's own TAP
  // writer and swallowed the results of other tests in the same file, which is a
  // worse outcome than the silence it was trying to observe.

  // ---------------------------------------------------------------- TLS
  // Decided here, before any listener exists, and the cookie follows it: a Secure
  // cookie on an HTTP listener is a cookie the browser will not send, which reads
  // as "login keeps failing" -- so the two settings must not be independently set.
  // HTTPS BY DEFAULT (2026-09-15): no certificate named means the monitor's own, made here on
  // first start under <data>/tls and kept, naming every address it can be reached on -- the
  // bound hosts, this machine's addresses, its hostname, localhost -- and remade when it nears
  // expiry or stops naming a bound host. BLOCKYARD_TLS=0 is plain HTTP.
  if (cfg.__tlsAuto) {
    const bound = (cfg.server.hosts ?? [cfg.server.host]).filter((h) => h && h !== '0.0.0.0' && h !== '::');
    const sans = ['localhost', os.hostname(), '127.0.0.1', '::1', ...bound, ...localAddresses().map((a) => a.address)];
    const made = ensureSelfSigned(path.join(cfg.store.dir, 'tls'), { sans, mustName: bound });
    cfg.server.tls.cert = made.certFile; cfg.server.tls.key = made.keyFile;
    if (made.made) app.log({ level: 'warn', msg: `made this monitor's own self-signed certificate (${made.why}) at ${made.certFile}, valid to ${new Date(made.notAfter).toISOString().slice(0, 10)}, for ${made.sans.join(', ')} -- browsers warn once per address; name your own with BLOCKYARD_TLS_CERT/KEY, or BLOCKYARD_TLS=0 behind a proxy that terminates TLS` });
    inspectTls(cfg, cfg.server.tls);   // fingerprint, expiry note, self-signed flag for the log line below
  }
  app.tls = Boolean(cfg.server.tls?.cert && cfg.server.tls?.key);
  if (app.tls) {
    app.tlsOptions = {
      cert: fs.readFileSync(cfg.server.tls.cert),
      key: fs.readFileSync(cfg.server.tls.key),
    };
    if (!cfg.auth.secureCookie) {
      cfg.auth.secureCookie = true;
      app.log({ level: 'info', msg: 'TLS is on, so the session cookie is now Secure (a Secure cookie over plain HTTP is never sent, which looks like a login that will not stick)' });
    }
    app.log({ level: 'warn', msg: `TLS on (fingerprint ${String(cfg.server.tls.fingerprint).slice(0, 17)}…${cfg.server.tls.selfSigned ? ', self-signed: expect a browser warning the first time per address' : ''})${cfg.__tlsExpiring ? `; WARNING ${cfg.__tlsExpiring}` : ''}` });
  } else if (cfg.auth.enabled && !(cfg.server.hosts ?? [cfg.server.host]).every((h) => LOOPBACK.has(h))) {
    // (not said for a loopback-only bind -- the default now -- where nothing crosses the LAN)
    app.log({ level: 'warn', msg: 'serving HTTP, not HTTPS: the session cookie and every RPC reply cross the LAN in the clear. Either put a TLS terminator in front (then BLOCKYARD_SECURE_COOKIE=1), name server.tls.cert/key, or bind 127.0.0.1 and use an SSH tunnel -- see README, "TLS, or the lack of it".' });
  }
  app.scheme = app.tls ? 'https' : 'http';

  // The build id the pages are stamped with and /api/build reports. The browser
  // compares the two and says "this tab is running an older build" in words;
  // without it, a stale tab is indistinguishable from a fix that did not land.
  app.buildId = async () => computeBuildId(app.publicDir, VERSION);
  app.build = await app.buildId();

  app.history = new History(cfg.store.dir, cfg.store, { log: app.log });
  const loaded = await app.history.load();
  app.log({ level: 'info', msg: `history: ${loaded.loaded ? `restored ${loaded.points} points from ${new Date(loaded.savedAt).toISOString()}` : `starting empty (${loaded.reason})`}` });
  app.history.startAutosave();

  app.users = new UserStore(path.join(cfg.auth.dataDir, 'users.json'), cfg.auth);
  const userLoad = await app.users.load();
  app.sessions = new SessionStore(path.join(cfg.auth.dataDir, 'sessions.json'), cfg.auth);
  await app.sessions.load();
  app.guard = new LoginGuard(cfg.auth);
  app.limiter = new RateLimiter({ capacity: 120, perSec: 40 });
  // A second, separate bucket for /api/login only. LoginGuard answers "this
  // username keeps failing"; the per-user token bucket cannot cover login because
  // it is keyed on the authenticated user and login has none yet. What was
  // unmitigated was the slow distributed grind: N addresses at 1 attempt each per
  // second, under every lockout threshold. Cost of a login attempt is a scrypt KDF
  // (~50 ms, 16 MB) on the request thread, so this is also the only thing keeping
  // a cheap flood from becoming a CPU denial of service on the monitor.
  app.loginLimiter = new RateLimiter({ capacity: 10, perSec: 0.5 });
  app.hub = new StreamHub({ log: app.log });

  // First run has to produce a credential somehow. Env-provided wins; otherwise
  // one is generated, used once and never persisted in recoverable form.
  let bootstrap = null;
  if (cfg.auth.enabled && app.users.count === 0) {
    const pw = process.env.BLOCKYARD_ADMIN_PASSWORD || randomPassword(20);
    const created = await app.users.createUser('admin', pw, { role: 'admin' });
    bootstrap = { username: created.username, password: pw, generated: !process.env.BLOCKYARD_ADMIN_PASSWORD };
    app.log({ level: 'warn', msg: `created the first admin account (${created.username}) -- ${bootstrap.generated ? 'generated password below is shown once' : 'password from BLOCKYARD_ADMIN_PASSWORD'}` });
  }
  app.bootstrap = bootstrap;

  // Open access is a posture, so it is announced rather than left implicit. The line
  // names the addresses that are now readable by anyone and the one switch that
  // closes it, because "anyone on the LAN can read the node" must never be something
  // an operator discovers from a screenshot.
  if (!cfg.auth.enabled) {
    const where = (cfg.server.hosts ?? [cfg.server.host]).join(', ') || '(wildcard)';
    app.log({
      level: 'warn',
      msg: `NO SIGN-IN (auth.enabled=false -- accounts were switched off; they are on out of the box): anyone who can reach ${where}:${cfg.server.port} reads this monitor — charts, the event feed, peer and mempool detail, and the read-only RPC console — as role "viewer". Not open to them: user administration, the audit trail, password changes, and node writes (BLOCKYARD_AUTH=1, or drop the override, for accounts, roles, sessions and CSRF).`,
    });
  }

  if (cfg.__fakeNode) {
    const { startFakeNode } = await import('../scripts/fake-node.js');
    const logFile = path.join(cfg.store.dir, 'fake-node.log');
    let fake;
    try {
      fake = await startFakeNode({
        port: Number(process.env.FAKE_PORT || 18331),
        logFile,
        ibd: process.env.FAKE_IBD !== '0',
        catchupBlocksPerSec: Number(process.env.FAKE_RATE || 9),
      });
    } catch (err) {
      throw new Error(`dev mode needs a local fake node: ${err.message}`);
    }
    cfg.nodes[0].rpcUrl = fake.url;
    cfg.nodes[0].cookieFile = null;
    cfg.nodes[0].rpcUser = 'fake';
    cfg.nodes[0].rpcPassword = 'fake';
    cfg.nodes[0].datadir = cfg.store.dir;
    cfg.nodes[0].logFile = logFile;
    cfg.nodes[0].label = 'Fake node (IBD simulation)';
    // Dev and smoke runs are hermetic: keep ONLY the fake. Leaving the real
    // default nodes in place would have `npm run dev` and scripts/smoke.sh
    // polling the operator's actual bench node -- a benchmark run disturbed by a
    // test suite is a nasty class of interference.
    cfg.nodes = [cfg.nodes[0]];
    app.fakeNode = fake;
    app.log({ level: 'warn', msg: `fake node running at ${fake.url}, logging to ${logFile}` });
  }

  // RPC-only mode. Blanked here rather than in config.js so the config object
  // stays declarative and this line is the one place that says what is lost.
  if (!cfg.log.enabled) {
    for (const n of cfg.nodes) {
      if (n.logFile) app.log({ level: 'info', msg: `node "${n.id}": ignoring logFile ${n.logFile} because the log source is disabled (BLOCKYARD_LOG_SOURCE=0)` });
      n.logFile = null;
    }
    app.log({ level: 'warn', msg: 'log source DISABLED: running on RPC only -- which is the supported mode, and the only one for Bitcoin Core (the log parsers target an experimental node grammar; see docs/CONFIGURATION.md). Bandwidth and per-peer bytes work only on node builds that publish them (measured 2026-09-08: bench build 11.56 MB/s via getnettotals against 11.2 MB/s stated in its log; production build 0 bytes and getpeerinfo [] with 16 connections). Per-peer relay legs, served-block attribution, tx accept/reject counts, disk-write rate, worker bans, the node\'s own ETA, compaction/validation stalls and sync_failing have no RPC source at all.' });
  } else {
    // THE INVERSE CASE, said out loud. Turning the log source on against Bitcoin Core produces
    // nothing useful and is easy to mistake for a configuration problem: logparse.js targets an
    // experimental node's grammar ([dlc], [dl], [dial], [utxo_live], [config], and a
    // "YYYY-MM-DD HH:MM:SS.mmm " timestamp), so Core's debug.log lines come back as unstructured
    // `raw` events with no fields, timestamped when they were READ rather than when they were
    // written. The boot log is the most visible place to say so before someone spends an evening
    // wondering why the bandwidth chart is empty. (operator, 2026-09-13.)
    app.log({
      level: 'warn',
      msg: 'log source ENABLED: note that log parsing does NOT support Bitcoin Core -- the parsers '
        + 'were written and tested against an experimental node implementation with a different log '
        + 'grammar. Against a Core debug.log every line is kept as an unstructured event with no '
        + 'figures extracted and a timestamp taken at read time, so panels that need the log stay '
        + 'empty and the event feed is misdated. Set BLOCKYARD_LOG_SOURCE=0 (the default) unless your '
        + 'node writes the format in test/fixtures/. See docs/CONFIGURATION.md, "RPC-only mode".',
    });
  }

  for (const nodeCfg of cfg.nodes) {
    // Cookie auth is impossible without the datadir, so a configured node whose
    // datadir has gone (a benchmark directory that got cleaned up) is skipped
    // with a reason rather than kept as a permanently-offline panel. A wrong
    // "offline" is worse than an absent one: it invites someone to go fix a node
    // that is running fine.
    if (nodeCfg.datadir && !nodeCfg.cookieFile && !fs.existsSync(nodeCfg.datadir)) {
      app.log({ level: nodeCfg.optional ? 'info' : 'warn', msg: `skipping node "${nodeCfg.id}": datadir ${nodeCfg.datadir} does not exist, so its RPC cookie cannot be read (remove it from config.nodes or point it at a live node)` });
      continue;
    }
    const m = new NodeMonitor(nodeCfg, { rpc: cfg.rpc, poll: cfg.poll, store: cfg.store, log: app.log, history: app.history, logCfg: cfg.log, miningCfg: {
      // Two cheap reads per block on the shared lane (measured 2026-09-09: 8 ms + 63 ms).
      // BLOCKYARD_MINING=0 turns attribution off entirely; the sizes, fees and weights stay.
      enabled: process.env.BLOCKYARD_MINING !== '0',
      backfill: Number(process.env.BLOCKYARD_MINING_BACKFILL ?? 36),
      // The block being built is assembled from the mempool the pool tier already reads
      // (collect/gbt.js), so it costs the node no call of its own -- it used to be a
      // getblocktemplate worth 1.3-1.5 s of the node's single RPC thread.
      // BLOCKYARD_MINING_TEMPLATE=0 still turns the card off for anyone who does not want it.
      template: process.env.BLOCKYARD_MINING_TEMPLATE !== '0',
      perTick: 1,
      // A human-edited tag -> label map. Absent by default, which is the correct state:
      // the coinbase text is shown as the pool wrote it.
      aliasesFile: path.join(cfg.store.dir, 'pool-aliases.json'),
      // Written by `node scripts/pool-map.js` into data/; until someone runs it, the copy shipped in
      // config/ (mempool.space/mining-pools, MIT, fetched 2026-09-09) -- a fresh install attributed
      // nothing and showed raw coinbase tags (operator, 2026-09-14: "Block attribution is fucked up")
      poolMapFile: process.env.BLOCKYARD_POOL_MAP ?? (fs.existsSync(path.join(cfg.store.dir, 'pool-map.json')) ? path.join(cfg.store.dir, 'pool-map.json') : path.join(ROOT, 'config', 'pool-map.json')),
    } });
    m.node = nodeCfg;
    // Deliberately NOT `m.history = app.history`: the monitor wraps the shared store
    // in a node-scoped view in its constructor, and reassigning the raw store here is
    // what made every node's charts draw the average of all nodes.
    wireMonitor(app, m);
    app.monitors.set(nodeCfg.id, m);
    await m.start();
  }
  app.primary = [...app.monitors.values()][0] ?? null;

  // Exchange prices for the Markets tab: the one outbound connection that is not the node,
  // and it polls only while someone has that tab open (server/collect/markets.js).
  if (cfg.markets?.enabled) {
    const { MarketFeed } = await import('./collect/markets.js');
    app.markets = new MarketFeed(cfg.markets, { log: app.log });
  } else app.markets = null;

  app.auditLog = new AuditLog(path.join(cfg.store.dir, 'audit.jsonl'), {
    maxBytes: cfg.store.auditMaxBytes,
    keep: cfg.store.auditKeep,
    log: app.log,
  });
  await app.auditLog.adopt();
  // REDACT BY SHAPE, not by a list of two names. Deleting `password` and `rpcPassword` covered the
  // fields today's routes happen to carry -- but the trail also stores action ARGUMENTS and a
  // 200-character preview of action RESULTS, so the next action that echoes a key-shaped argument
  // would write it into audit.jsonl for ever, where the whole point of the file is that it is kept.
  // An audit on 2026-09-13 pointed at exactly that gap. Nested, because arguments are objects.
  //
  // `key` alone is deliberately NOT in the pattern: it would redact poolKey, labelKey and keylen,
  // which are not secrets, and an audit trail full of [redacted] where the useful fields were is
  // its own kind of failure.
  const SECRETISH = /pass(word|phrase)?|secret|cookie|token|priv(ate)?_?key|seed|mnemonic|authorization|credential/i;
  const redact = (v, depth = 0) => {
    if (v == null || depth > 6) return v;
    if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
    if (typeof v !== 'object') return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRETISH.test(k) ? '[redacted]' : redact(val, depth + 1);
    return out;
  };
  app.audit = async (row) => {
    const entry = redact({ at: Date.now(), ...row });
    await app.auditLog.append(entry).catch((err) => app.log({ level: 'error', msg: `audit write failed: ${err.message}` }));
  };
  app.readAudit = async (limit = 100) => app.auditLog.read(limit);

  app.access = ({ req, path: p, status, ms, ip, user = null, error = null }) => {
    if (p === '/api/stream') return;
    const slow = ms > 3000;
    if (status >= 400 || slow) {
      app.log({ level: status >= 500 ? 'error' : 'warn', msg: `${req.method} ${p} -> ${status} in ${ms}ms${error ? ` (${error})` : ''} user=${user ?? '-'} ip=${ip}` });
    }
  };

  app.selfTelemetry = () => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(app.cpuStartBaseline ?? process.cpuUsage());
    const wall = Date.now() - app.startedAt;
    const cpuPct = wall > 0 ? ((cpu.user + cpu.system) / 1000 / wall) * 100 : 0;
    app.cpuStartBaseline ||= process.cpuUsage();
    const row = {
      t: Date.now(),
      rssMb: +(mem.rss / 1048576).toFixed(1),
      heapMb: +(mem.heapUsed / 1048576).toFixed(1),
      sseClients: app.hub.clients.size,
      usersActive: app.sessions.active().users,
      cpuPct: +cpuPct.toFixed(2),
      eventRate: app.eventWindow?.rate ?? 0,
      build: app.build,
    };
    app.selfRing.push(row);
    if (app.selfRing.length > 5000) app.selfRing.splice(0, app.selfRing.length - 5000);
    return row;
  };

  // One HTTP server per bound address, all sharing `app`. A single server cannot
  // listen twice (ERR_SERVER_ALREADY_LISTEN), and the wildcard is exactly what we
  // are avoiding, so the fan-out lives here. The rate limiter, sessions and monitors
  // all live on `app`, so an attacker picking a different address gets the same
  // budget, not another one. (StaticFiles is per server -- duplicated ETag state for
  // a couple of hundred KB of assets, which is cheaper than pretending one socket
  // can speak for two interfaces.)
  app.servers = [];
  app.server = null;

  const hosts = cfg.server.hosts ?? [cfg.server.host];
  // Binding is a decision with casualties, so make them visible: addresses the
  // machine lacks are reported and skipped (a tunnel interface that comes up after
  // us must not stop the monitor serving the interfaces that exist), and only
  // "nothing here is bindable" is fatal. Loopback and the container bridges are
  // excluded by construction when specific addresses are named -- and saying so at
  // boot is what saves the next person an hour, because a refused 127.0.0.1 curl is
  // indistinguishable from a dead monitor.
  const plan = planBinds(hosts);
  if (plan.noneUsable) {
    app.log({ level: 'error', msg: bindProblemMessage({ err: { code: 'EADDRNOTAVAIL' }, host: plan.list.join(' | '), port: cfg.server.port }) });
    process.exitCode = 1;
    await app.history?.save?.().catch(() => {});
    process.exit(1);
  }
  for (const missing of plan.missing) {
    app.log({
      level: 'warn',
      msg: `not binding ${missing}: this machine has no such address right now. If it is a tunnel (tailscale0), start this unit after tailscaled.service, or drop it from server.hosts. Continuing on: ${plan.bindable.join(', ')}`,
    });
  }
  for (const host of plan.bindable) {
    const srv = createAppServer(app);
    app.servers.push(srv);
    if (!app.server) app.server = srv;
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(cfg.server.port, host, resolve);
    }).catch((err) => {
      app.log({ level: 'error', msg: bindProblemMessage({ err, host, port: cfg.server.port }) });
      // Anything already listening must not be left serving half the addresses --
      // "reachable on the LAN but not the tailnet" is worse than a clean failure.
      for (const s of app.servers) { try { s.close(); } catch { /* already gone */ } }
      process.exit(1);
    });
  }
  const served = plan.bindable.map((h) => `${app.scheme}://${h}:${cfg.server.port}`);
  app.log({ level: 'info', msg: `BlockYard ${VERSION} listening on ${served.join(' and ')}` });
  const loopbackOnly = plan.bindable.every((h) => LOOPBACK.has(h));
  if (loopbackOnly) {
    app.log({ level: 'info', msg: 'bound to this machine only (the default): reach it from elsewhere over an SSH tunnel, or bind a LAN address with BLOCKYARD_BIND / server.hosts -- docs/INSTALL.md §7' });
  } else if (!plan.bindable.includes('0.0.0.0') && !plan.bindable.includes('::')) {
    const v4 = localAddresses().filter((a) => a.family === 'IPv4' && !plan.bindable.includes(a.address) && !a.internal);
    const v6 = localAddresses().filter((a) => a.family === 'IPv6' && !plan.bindable.includes(a.address) && !a.internal).length;
    // warn, not info: when loopback is not among the bound addresses, "connection
    // refused from the machine itself" is the confusion this line exists to prevent,
    // and tooling that runs at LOG_LEVEL=warn (scripts/smoke.sh) would never see it at
    // info. That silencing cost a false "54 failures" reading today.
    app.log({
      level: 'warn',
      msg: `bound to specific interfaces -- NOT reachable on ${v4.map((a) => `${a.address} (${a.name})`).join(', ') || 'other IPv4 addresses'}`
        + `${v6 ? ` (plus ${v6} IPv6 address(es))` : ''}${plan.bindable.some((h) => LOOPBACK.has(h)) ? '.' : ', and not on 127.0.0.1 either: use one of the addresses above from this machine too.'}`,
    });
    if (plan.missing.length) {
      app.log({ level: 'warn', msg: `skipped at boot: ${plan.missing.join(', ')} -- clients that would have used those addresses will get "connection refused", which is not a crash` });
    }
  }

  // Periodic series refresh and self-telemetry, plus an event-rate window the
  // telemetry panel uses so "how much is this app doing" is answerable.
  app.eventWindow = { count: 0, since: Date.now(), rate: 0 };
  app.timers = [
    setInterval(() => {
      const now = Date.now();
      const secs = (now - app.eventWindow.since) / 1000;
      app.eventWindow.rate = secs > 0 ? +(app.eventWindow.count / secs).toFixed(2) : 0;
      app.eventWindow.count = 0;
      app.eventWindow.since = now;
      app.selfTelemetry();
      if (app.history.dirtySince && now - app.history.dirtySince > 30_000) app.history.prune();
    }, 10_000),
    setInterval(() => {
      const n = app.sessions.sweep();
      if (n) app.sessions.save().catch(() => {});
    }, 60_000),
  ];
  app.timers.forEach((t) => t.unref?.());

  // Chart series change slowly; pushing them on every snapshot would be most of
  // the bandwidth for almost no benefit.
  const seriesPush = setInterval(() => {
    if (!app.hub.clients.size) return;
    for (const m of app.monitors.values()) {
      app.hub.pushSeries({ node: m.id, series: m.seriesView({}) }, { nodeId: m.id });
    }
  }, 20_000);
  seriesPush.unref?.();
  app.timers.push(seriesPush);

  // THE ADDRESS INDEX FOLLOWS THE CHAIN (server/chain/index/live.js): one follower per index
  // directory, fed by a node that uses it -- one with its block files on this machine if there is
  // one, since that is the node the index was built from. A follower that cannot open its index
  // logs why and the address page says the same; nothing else is held up by it.
  const followers = new Map();
  for (const m of app.monitors.values()) {
    const dir = m.cfg?.addressIndex;
    if (!dir) continue;
    const had = followers.get(dir);
    if (!had || (!had.cfg?.datadir && m.cfg?.datadir)) followers.set(dir, m);
  }
  if (followers.size) {
    const { LiveIndex } = await import('./chain/index/live.js');
    const { registerLiveIndex, registerIndexBuild } = await import('./http/explorer.js');
    const { buildIndex, defaultWorkers, rpcPacer } = await import('./chain/index/build.js');
    const follow = (dir, m) => {
      const live = new LiveIndex(dir, { rpc: m.rpc, nodeId: m.id, log: { info: (msg) => app.log({ level: 'info', msg }), warn: (msg) => app.log({ level: 'warn', msg }) } });
      registerLiveIndex(dir, live);
      const tick = () => { live.poll().catch(() => {}); };
      tick();
      const t = setInterval(tick, 30_000);
      t.unref?.();
      app.timers.push(t);
      app.log({ level: 'info', msg: `address index ${dir}: following ${m.id} from block ${live.tip}` });
    };
    // A MISSING INDEX IS BUILT HERE, IN THE BACKGROUND (operator, 2026-09-14: "Is it possible to run
    // step 6 in the background, and have a status notification in blockyard when the index process
    // is finished?"). The build runs on worker threads inside this process while every page keeps
    // serving; its progress is a quality flag the Overview shows and the address page repeats; an
    // event -- which the browser toasts -- marks the start, the finish, or a failure. A node config
    // can say addressIndexBuild: "manual" to keep this from happening.
    const HMS = (sec) => (sec < 90 ? `${Math.round(sec)} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);
    const build = async (dir, m) => {
      // at most four, and half what a dedicated build would take: the node shares this machine's disk
      // (an external one, on the first Mac), and the pacer only sees trouble after it has started
      // ...or the number the config names: on spinning disks one reader is the fast one (parallel
      // readers seek against each other and against the node), so addressIndexWorkers: 1 there
      const workers = Number.isInteger(m.cfg?.addressIndexWorkers) && m.cfg.addressIndexWorkers > 0 ? m.cfg.addressIndexWorkers : Math.max(1, Math.min(4, Math.floor(defaultWorkers() / 2)));
      // ITS OWN CONNECTION (2026-09-14, the first Mac: the build's getblockhash batches sat at the back
      // of the monitor's one-in-flight lane behind multi-second mempool and block reads, and both
      // starved -- "heights 1,000 of 967,015" for a quarter of an hour). The build's calls are cheap
      // and few, on a second lane, exactly as scripts/index-build.js has always run; the pacer still
      // reads the monitor's lane, which is the measure of how the node is coping.
      const { RpcClient } = await import('./rpc/client.js');
      const quiet = { info() {}, warn() {}, error() {}, debug() {} };
      const rpc = new RpcClient(m.cfg, { ...(cfg.rpc ?? {}), ...(m.cfg.rpc ?? {}) }, { log: quiet });
      const status = { dir, node: m.id, phase: 'starting', done: 0, total: 0, rows: 0, eta: null, startedAt: Date.now(), error: null, paused: false };
      registerIndexBuild(dir, status);
      m.indexBuild = status;
      // PACED BY THE NODE'S OWN ANSWERS: the workers read the block files the node is also reading, so
      // when its RPC slows past the monitor's own threshold (rpc.slowLatencyMs, 5 s) the next file waits
      // until it recovers (2026-09-14, the first Mac install: 18 s answers and 90 s timeouts while the
      // build ran flat out -- which turned out to be gettxoutsetinfo, not the build, but the pacing stays)
      let phase = null, phaseAt = Date.now(), lastFlag = 0, lastProgressAt = Date.now();
      const flagLine = () => {
        const pct = status.total ? Math.round((100 * status.done) / status.total) : 0;
        const quiet = Date.now() - lastProgressAt;
        return `the address index is being built: ${status.phase ?? 'starting'} ${Number(status.done ?? 0).toLocaleString()} of ${Number(status.total ?? 0).toLocaleString()} (${pct}%)${status.rows ? `, ${status.rows.toLocaleString()} rows so far` : ''}${status.eta ? `, about ${status.eta} left` : ''}${status.paused ? ' -- paused while the node\'s RPC is slow' : quiet > 120_000 ? ` -- no progress for ${Math.round(quiet / 60000)} min` : ''}`;
      };
      const pace = rpcPacer(m.rpc, { slowMs: cfg.rpc?.slowLatencyMs ?? 5000, onChange: (held, t) => {
        status.paused = held;
        lastFlag = Date.now(); m.flagQuality?.('address-index-building', flagLine(), 'info');   // on the flag the moment it changes
        app.log({ level: 'info', msg: held ? `address index build: paused while the node's RPC is ${t.breakerOpen ? 'refused' : t.lastError ? 'failing' : `answering in ${((t.avgLatencyMs ?? 0) / 1000).toFixed(1)} s`}` : 'address index build: resumed' });
      } });
      const say = (text, severity = 'info') => { m.addEvent?.({ kind: 'index', severity, tag: 'index', ts: Date.now(), text }); app.log({ level: severity === 'warn' ? 'warn' : 'info', msg: text }); };
      say(`address index: building ${dir} from ${m.id}'s block files with ${workers} workers -- the Overview shows the progress`);
      // THE FLAG IS REWRITTEN ON A CLOCK, NOT ONLY ON PROGRESS (2026-09-15: "scan 5,720 of 5,721,
      // about 1 s left (88m ago)" -- a build that had stopped moving showed its last good line,
      // and a pause showed nothing at all until the next file finished). Every 30 s it says how
      // long since anything happened, and a pause is on it the moment it begins.
      const heartbeat = setInterval(() => { if (Date.now() - lastFlag > 25_000) { lastFlag = Date.now(); m.flagQuality?.('address-index-building', flagLine(), 'info'); } }, 30_000);
      heartbeat.unref?.();
      buildIndex({
        rpc, blocksDir: path.join(m.cfg.datadir, 'blocks'), out: dir, workers, pace,
        onProgress: (p) => {
          if (p.phase !== phase) { phase = p.phase; phaseAt = Date.now(); }
          const elapsed = (Date.now() - phaseAt) / 1000;
          const rate = elapsed > 0 && p.done > 0 ? p.done / elapsed : 0;
          Object.assign(status, { phase: p.phase, done: p.done, total: p.total, rows: p.rows ?? status.rows, eta: rate > 0 && p.total > p.done ? HMS((p.total - p.done) / rate) : null });
          lastProgressAt = Date.now();
          if (Date.now() - lastFlag > 5000) {
            lastFlag = Date.now();
            m.flagQuality?.('address-index-building', flagLine(), 'info');
          }
        },
      }).then((manifest) => {
        clearInterval(heartbeat);
        registerIndexBuild(dir, null);
        m.indexBuild = null;
        m.clearQuality?.('address-index-building');
        const mins = ((Date.now() - status.startedAt) / 60000).toFixed(1);
        say(`address index built: ${Number(manifest.rows ?? 0).toLocaleString()} rows to block ${Number(manifest.tip?.height ?? 0).toLocaleString()} in ${mins} min -- address pages are live`);
        try { follow(dir, m); } catch (err) { say(`address index ${dir}: built, but the follower could not start: ${err.message}`, 'warn'); }
      }).catch((err) => {
        clearInterval(heartbeat);
        status.error = err.message;
        registerIndexBuild(dir, null);
        m.indexBuild = null;
        m.flagQuality?.('address-index-build-failed', `the address index build failed: ${err.message} -- fix the cause and run node scripts/index-build.js --out ${dir}`, 'warn');
        say(`address index build failed: ${err.message}`, 'warn');
      });
    };
    for (const [dir, m] of followers) {
      const finished = fs.existsSync(path.join(dir, 'manifest.json'));
      if (finished) {
        try { follow(dir, m); } catch (err) { app.log({ level: 'warn', msg: `address index ${dir}: ${err.message}` }); }
      } else if (m.cfg?.addressIndexBuild === 'manual') {
        app.log({ level: 'warn', msg: `address index ${dir}: not built, and addressIndexBuild is "manual" -- run node scripts/index-build.js --out ${dir}` });
      } else if (!m.cfg?.datadir) {
        app.log({ level: 'warn', msg: `address index ${dir}: not built, and node ${m.id} has no datadir to build it from` });
      } else build(dir, m).catch((err) => app.log({ level: 'warn', msg: `address index ${dir}: ${err.message}` }));
    }
  }

  installShutdown(app);
  return app;
}

function wireMonitor(app, m) {
  let pushTimer = null;
  const schedulePush = () => {
    if (pushTimer) return;
    // Coalesce to one snapshot push per second per node: several tiers can
    // finish inside the same tick, and the browser only ever wants the newest.
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (!app.hub.clients.size) return;
      try {
        const snap = m.snapshot({});
        app.stateSeq += 1;
        snap.seq = app.stateSeq;
        app.hub.pushSnapshot(snap, { nodeId: m.id });
      } catch (err) {
        app.log({ level: 'error', msg: `snapshot failed: ${err.stack ?? err.message}` });
      }
    }, 1000);
    pushTimer.unref?.();
  };
  m.on('changed', schedulePush);
  m.on('blocks', schedulePush);
  m.on('events', (rows) => {
    const list = Array.isArray(rows) ? rows : [rows];
    app.eventWindow.count += list.length;
    for (const r of list) {
      // The raw chatter (per-tick bandwidth, heartbeat) is stored for charts but
      // not pushed as a feed line, or the event list buries its own news.
      if (r.kind === 'raw' && r.severity === 'info' && !/error|fail|warn|drop|refus|reject|unreachable|banned|connect/i.test(r.text ?? '')) continue;
      app.hub.pushEvent(r, { nodeId: m.id });
    }
    schedulePush();
  });
}

function makeLogger(cfg) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[cfg.log.level] ?? 20;
  const log = (entry) => {
    const e = typeof entry === 'string' ? { msg: entry } : entry;
    const level = e.level ?? 'info';
    if ((levels[level] ?? 20) < threshold) return;
    const ctx = e.node ? ` [${e.node}]` : '';
    const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${level.toUpperCase().padEnd(5)}${ctx} ${e.msg}`;
    // Never let a credential reach stdout, where a journald capture would keep it
    // forever -- including a fake-node cookie in a dev URL.
    process.stdout.write(line.replace(/(:[^:@\s]{16,}@)/g, ':***@').replace(/(password|secret|cookie)["']=([^"']{6,})/gi, '$1=***') + '\n');
  };
  log.child = (base) => (entry) => {
    const e = typeof entry === 'string' ? { msg: entry } : entry;
    log({ ...base, ...e });
  };
  return log;
}

function installShutdown(app) {
  let closing = false;
  // Exposed as app.shutdown() rather than living only in the signal handler, for a
  // boring reason: an HTTP-level test that boots the real app in-process had no way
  // to stop it, so every test that wanted to speak HTTP had to shell out to
  // scripts/smoke.sh. Teardown being unreachable is why this repo had no in-process
  // integration test for sessions, headers or the login throttle.
  const close = async ({ saveHistory = true } = {}) => {
    if (closing) return { alreadyClosed: true };
    closing = true;
    for (const t of app.timers ?? []) clearInterval(t);
    app.hub?.closeAll();
    for (const m of app.monitors.values()) await m.stop().catch(() => {});
    app.markets?.stop();
    if (saveHistory) await app.history?.stop?.().catch((err) => app.log({ level: 'error', msg: `history save failed: ${err.message}` }));
    await app.sessions?.save?.().catch(() => {});
    await new Promise((r) => {
      const open = (app.servers ?? [app.server]).filter(Boolean);
      if (!open.length) return r();
      let left = open.length;
      for (const s of open) s.close(() => { if (--left <= 0) r(); });
    });
    if (app.fakeNode) await app.fakeNode.stop().catch(() => {});
    return { closed: true };
  };
  app.shutdown = close;

  const bye = async (sig) => {
    if (closing) return;
    app.log({ level: 'info', msg: `${sig}: shutting down` });
    await close();
    app.log({ level: 'info', msg: 'bye' });
    // Do not hang on a socket that refused to close; history is already durable.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('unhandledRejection', (err) => app.log({ level: 'error', msg: `unhandled rejection: ${err?.stack ?? err}` }));
  process.on('uncaughtException', (err) => {
    app.log({ level: 'error', msg: `uncaught exception: ${err?.stack ?? err}` });
    setTimeout(() => process.exit(1), 300);
  });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function banner(app) {
  const lines = [];
  const host = app.cfg.server.host;
  lines.push('');
  lines.push('  BlockYard is up');
  lines.push(`    URL      ${app.scheme}://${host === '0.0.0.0' ? 'localhost' : host}:${app.cfg.server.port}  (build ${app.build})`);
  if (app.bootstrap) {
    lines.push(`    login    ${app.bootstrap.username} / ${app.bootstrap.password}`);
    lines.push(`             ${app.bootstrap.generated ? 'generated now, shown once, stored only as a scrypt hash' : 'taken from BLOCKYARD_ADMIN_PASSWORD'}`);
  } else if (app.cfg.auth.enabled) {
    lines.push('    login    your usual account');
  } else {
    // Same content as the boot warning, in the banner: the first thing on screen
    // after `npm start` should be the sentence about who can read the node.
    lines.push('    login    DISABLED — open to anyone who can reach the addresses above (role: viewer, read-only)');
    lines.push('             user admin, the audit trail and node writes stay closed; BLOCKYARD_AUTH=1 turns accounts back on');
  }
  // LOOPBACK IS THE DEFAULT (2026-09-15): say how to reach it from anywhere else, because "it
  // works on the box and nowhere else" is the first thing a new install runs into now
  const hosts = app.cfg.server.hosts ?? [host];
  if (hosts.every((h) => LOOPBACK.has(h))) {
    const p = app.cfg.server.port;
    lines.push(`    reach    this machine only. From elsewhere: ssh -L ${p}:127.0.0.1:${p} you@this-host, then http://localhost:${p}`);
    lines.push('             or bind a LAN address: BLOCKYARD_BIND=192.0.2.10 (or 0.0.0.0 for every interface) — docs/INSTALL.md §7');
  }
  lines.push(`    nodes    ${[...app.monitors.values()].map((m) => `${m.id} -> ${m.rpc.url}`).join(', ')}`);
  if (app.cfg.server.allowCidrs.length) lines.push(`    CIDRs    ${app.cfg.server.allowCidrs.join(', ')}`);
  lines.push(`    actions  ${app.cfg.actions.enabled ? `enabled: ${app.cfg.actions.allow.join(', ') || '(none listed)'}` : 'disabled (read-only)'}`);
  lines.push('');
  return lines.join('\n');
}

// run-as-main, portably: on Windows a file URL's path is "/C:/x" and realpath gives "C:\\x", so the
// two are compared as paths, never as strings (2026-09-14, the first Windows CI run)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  const app = await boot();
  process.stdout.write(banner(app) + '\n');
  // The banner is also the only place the bootstrap password ever appears.
  if (app.bootstrap) await app.audit({ type: 'bootstrap-admin', generated: app.bootstrap.generated, ip: 'local' });
}
