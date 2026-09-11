// Configuration. Defaults are wired to the actual deployment discovered on this
// box (see README "Where the defaults come from"), so `npm start` works with no
// setup. Every value is overridable by env var or by config/local.json.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBindableHost, planBinds, parseCidr } from './netinfo.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HERE_DOC = `
Defaults reflect the deployment inspected when this project was created:
  node RPC     127.0.0.1:8331  (config/bitcoin.conf rpcport=8331; P2P owns 8332)
  NOTE  those two lines in the node's bitcoin.conf are operational, not tuning. They
  have been lost twice (a merge cleanup on 2026-08-26, a conf rewrite on 2026-09-08)
  and each time this monitor reported production offline with ECONNREFUSED while the
  node was healthy on Core's default RPC port 8332. Before believing that report, check
  the node log for '[boot] config:' and '[rpc] JSON-RPC server on 127.0.0.1:8331'.
  RPC binds ~100 s after systemd says "running", and [utxo_live] init blocks chain RPCs
  for ~40 s after that -- see MEASUREMENTS 18.
  cookie       <datadir>/<chain>/.cookie  (regenerated each boot, deleted on stop)
  datadir      /storage/bitcoinmachinecode/data
  systemd      bmcbitcoind.service
  log          <datadir>/../logs/<chain>/bitcoin.main.log  (logrotate'd)
`.trim();

const DEFAULTS = {
  server: {
    // Multi-user means the LAN has to reach it, so it binds broadly by default.
    // Set BMC_MON_BIND=127.0.0.1 to keep it on this machine only.
    host: '0.0.0.0',
    port: 8088,
    // Defense in depth: only these CIDRs may connect. Empty = any.
    allowCidrs: [],
    trustProxy: false,
    // TLS is off unless both files are named, and then it is on for every listener.
    // It stays opt-in because this box is a LAN monitor whose certificate has no
    // issuer: a self-signed cert produces a browser warning on every address change,
    // and the alternative already documented (an SSH tunnel to 127.0.0.1, or a
    // reverse proxy that owns the cert) is better on a machine you control.
    // What was missing until 2026-09-09 was the option at all -- serving a session
    // cookie and every RPC reply over plain HTTP on a LAN is not a gap you get to
    // call "documented, therefore fine".
    tls: {
      cert: null,   // PEM; BMC_MON_TLS_CERT
      key: null,    // PEM; BMC_MON_TLS_KEY
      // Sent over TLS responses only. Two days, not the usual year: a LAN address
      // can be reissued to something else, and HSTS is the header that cannot be
      // unsent. Deliberately no includeSubDomains and no preload.
      hstsMs: 172_800_000,
    },
  },
  // Production only, by decision -- see "Why the benchmark node is not monitored"
  // at the bottom of this block, and the measurements in docs/MEASUREMENTS.md.
  //
  // Multi-node support is intact (see the node switcher, per-node series rings, and
  // the fact that this is an array): add entries in config/local.json to bring other
  // nodes back. What is no longer default is watching a benchmark from the same box
  // that runs it.
  //
  // A node whose datadir is absent is skipped at boot (see main.js) rather than
  // failing, so a datadir that gets cleaned up does not break startup.
  nodes: [
    {
      id: 'bmc-main',
      label: 'BMC mainnet (production)',
      rpcUrl: 'http://127.0.0.1:8331',
      datadir: '/storage/bitcoinmachinecode/data',
      chainHint: 'main',
      cookieFile: null, // derived from datadir+chainHint when null
      rpcUser: null,
      rpcPassword: null,
      logFile: '/storage/bitcoinmachinecode/logs/main/bitcoin.main.log',
      systemdUnit: 'bmcbitcoind.service',
      color: '#f7931a',
    },
  ],
  // Why the benchmark node is not monitored (was `bmc-bench`, removed 2026-09-08).
  //
  // Not because the data was wrong. Because on this box the observation changes the
  // thing observed and degrades the thing that matters:
  //
  //   1. Contention with the thing we actually care about. The node's RPC server
  //      services ONE connection at a time on one thread. Every poll of the bench
  //      node is time the bench cannot spend on the benchmark, and a monitor that
  //      shares the box with a benchmark is a load generator wearing a label.
  //      main.js already refuses to let `npm run dev` or smoke.sh touch the real
  //      bench node for this reason; running it as a monitored node was the same
  //      mistake with better branding.
  //   2. It could not be read reliably anyway. Measured in one hour of monitoring:
  //      RPC average latency ~18-32 s, 90 s timeouts on the fast and slow tiers,
  //      25 failed tier runs, and nine-plus restarts by its harness (each looking
  //      like an outage). Production, same monitor, same code: 0 errors, max 22 ms.
  //   3. It contaminated the production charts. Un-tagged series rings mixed 2,308
  //      production rows with 1,816 bench rows in one line (MEASUREMENTS 20). The
  //      rings are per-node now, but the lesson stands: while both were displayed,
  //      at least one chart was not a fact about the node it was labelled with.
  //
  // To watch a benchmark again, put this in config/local.json (gitignored) -- the
  // node switcher, the per-node rings and the picker all already support it:
  //
  //   { "nodes": [
  //     { "id": "bmc-main", "label": "BMC mainnet (production)",
  //       "rpcUrl": "http://127.0.0.1:8331",
  //       "datadir": "/storage/bitcoinmachinecode/data", "chainHint": "main",
  //       "logFile": "/storage/bitcoinmachinecode/logs/main/bitcoin.main.log" },
  //     { "id": "bmc-bench", "label": "BMC bench (IBD / benchmark)",
  //       "rpcUrl": "http://127.0.0.1:8461",
  //       "datadir": "/mnt/2tbssd/bmc-bench/data", "chainHint": "main",
  //       "logFile": "/mnt/2tbssd/bmc-bench/console.log",
  //       "logStaleMs": 600000, "optional": true }
  //   ] }
  //
  // Two caveats recorded while it was wired, because they will bite whoever pastes
  // that in: the benchmark's real log is the run directory's `console.log`, NOT
  // `<datadir>/main/debug.log` (a 144-byte stub -- three "node start" lines -- which
  // is what the monitor tailed for two hours while reporting nothing); and that file
  // is block-buffered, so lines can sit frozen for minutes and then arrive in a
  // burst. `log-silent` distinguishes the two by quoting the chain delta it saw.
  /* previous second entry, kept readable rather than silently deleted:
    {
      id: 'bmc-bench',
      label: 'BMC bench (IBD / benchmark)',
      rpcUrl: 'http://127.0.0.1:8461',
      datadir: '/mnt/2tbssd/bmc-bench/data',
      chainHint: 'main',
      logFile: '/mnt/2tbssd/bmc-bench/console.log',
      logStaleMs: 600000,
      optional: true,
    },
  */
  rpc: {
    // The node's RPC server accepts and services ONE connection at a time on a
    // single thread (docs/RPC_LIVE_NODE.md, slice 11). One browser tab polling
    // eight methods is polite; forty tabs is a denial of service against our own
    // node. So: one in-flight request globally, a floor between requests, and
    // every poll tier sized so the node is never the bottleneck for itself.
    maxInFlight: 1,
    minIntervalMs: 250,
    // Measured on this box: a bare getblockcount against the bench node took
    // 40.4s while it was doing initial block download, and 7s once against the
    // synced node under benchmark load. A 20s timeout would have declared a
    // healthy-but-busy node unreachable, so the ceiling is well above that and
    // the tier cadence adapts instead (see monitor.effectiveTierMs).
    timeoutMs: 90000,
    heavyTimeoutMs: 300000,
    // A poll answer that arrives later than this describes a moment that has
    // already passed; it is dropped rather than shown as current state.
    staleDropMs: 12000,
    // Above this average latency the UI says the node is slow rather than
    // implying the monitor is broken.
    slowLatencyMs: 5000,
    breakerThreshold: 3, // consecutive failures before we back off
    breakerCooldownMs: 30000,
    // Hard ceiling on RPC calls/second we will issue, whatever the tiers ask for.
    maxRatePerSec: 4,
  },
  poll: {
    fastMs: 4000, // chaininfo, mempoolinfo, connections, nettotals, uptime
    midMs: 15000, // mining info, fee estimates, chain tips, mempool ids
    // The verbose mempool read has its own tier since 2026-09-11 (operator: "Faster
    // refresh"): it measured 0.144 s for ~19k entries on this node, cheap next to
    // gettxoutsetinfo, so it no longer waits on the heavy minute.
    poolMs: 20000, // mempool verbose (feeds the block-space viewer and the mempool map)
    slowMs: 60000, // indexes, txoutset, chaintxstats
    rareMs: 900000, // peerinfo, deployment info, rpc info
    blockBackfill: 30, // blocks of history to backfill at startup
  },
  store: {
    dir: null, // resolved below; JSONL + snapshots
    retentionHours: 72,
    ringCapacity: 20000,
    maxEventLog: 5000,
    snapshotEveryMs: 120000,
    // The in-memory height -> block map, kept bounded so long-range analytics come
    // from the rings and not from an unbounded Map. Measured on 2026-09-09: 12,000
    // rows cost 3.6 MB of heap (~310 B/row, test/monitor-shapes.test.js). The old
    // 3,000-row cap was a round number rather than a budget, and it evicted blocks
    // that the 72 h retention would happily have kept -- for ~0.9 MB.
    blockMapCap: 12000,
    // audit.jsonl rotation. The file records logins, RPC calls and action results;
    // it holds no credentials, and it used to grow forever on a box that has filled
    // its disk before -- at which point the failure is not "no audit" but "no node",
    // because the monitor cannot write snapshots either.
    auditMaxBytes: 8 * 1024 * 1024,
    auditKeep: 5,
  },
  auth: {
    // OPEN BY DEFAULT, like a block explorer: anyone who can reach the listen
    // addresses reads the dashboard with no account. This is a posture decision, not
    // a convenience -- see README "Open by default" and the boot warning, which names
    // the addresses this leaves readable.
    //
    // What "open" is bounded by, in server/http/server.js:
    //   * the anonymous role is `viewer` and the ceiling is not configurable; user
    //     administration, the audit trail and password changes stay 403;
    //   * node writes are refused outright in open mode unless
    //     actions.allowWritesWithoutAuth says so explicitly (config load is fatal
    //     otherwise, because "open monitor + enabled writes" is a combination nobody
    //     should discover by accident);
    //   * rate limits key on the IP, so one noisy tab cannot spend everyone's bucket.
    //
    // Set BMC_MON_AUTH=1 (or auth.enabled in config/local.json) for accounts, roles,
    // sessions, CSRF and the audit trail-by-user.
    enabled: false,
    dataDir: null,
    sessionTtlMs: 8 * 3600 * 1000,
    idleTtlMs: 72 * 3600 * 1000,
    scrypt: { N: 16384, r: 8, p: 1, keylen: 32 },
    minPasswordChars: 12,
    loginMaxAttempts: 8,
    loginWindowMs: 300000,
    lockoutMs: 600000,
    cookieName: 'bmcmon_sid',
    secureCookie: false, // forced true at boot when TLS is on
  },
  actions: {
    // Anything that can change node or machine state is off unless explicitly
    // enabled AND role-gated. Reads are the default; the UI says so.
    enabled: false,
    allow: [], // e.g. ['broadcast','savemempool']
    requireAdmin: true,
    // Separate acknowledgement: with accounts off there is no role to check, so an
    // enabled write would be reachable by anyone who can open a socket.
    allowWritesWithoutAuth: false,
  },
  log: {
    level: 'info',
    tailBytes: 2 * 1024 * 1024,
    // OFF by default since 2026-09-09: the UI reads RPC only. Tailing a file the
    // node rewrites between releases is a grammar dependency that has already cost
    // this project two silent-outage incidents, and every panel that needed it has
    // been removed rather than left showing dashes.
    // Turning it on (BMC_MON_LOG_SOURCE=1) still works and is still honest about
    // what it bought: on the build deployed to production RPC answers getnettotals
    // 0/0 and getpeerinfo [] while getconnectioncount says 16, so "RPC only" there
    // means "no bandwidth and no peer names at all" -- and both builds report
    // subversion /BitcoinMachineCode:0.0.1/, so RPC cannot tell you which one you
    // have (MEASUREMENTS 3, 4, 11, 26).
    enabled: false,
    // How long a tailed file may go without a single new byte before the monitor
    // says so. Default 30 min: measured 2026-09-08, the synced production node's own
    // log went 1,182 s (~20 min) between lines at its quietest across 1,840 lines,
    // so anything under ~20 min flags a healthy idle node as broken. A per-node
    // `logStaleMs` tightens it where the node is known to be chatty.
    staleMs: 1800000,
    // How often that check runs. It is a stat() plus arithmetic, no RPC, so it can
    // be far more frequent than anything that touches the node's single lane.
    healthMs: 30000,
  },
  // The Markets tab (server/collect/markets.js): public exchange APIs over HTTPS -- the one
  // outbound connection that is not the node. Polled only while someone has the tab open, and
  // parked idleAfterMs after the last request. BMC_MON_MARKETS=0 turns it off.
  markets: {
    enabled: true,
    tickerMs: 15000,
    candleMs: 300000,
    bookMs: 30000,      // order books, for the depth chart
    idleAfterMs: 600000,
    timeoutMs: 8000,
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  if (extra === undefined || extra === null) return base;
  if (Array.isArray(base) || Array.isArray(extra)) return extra;
  if (!isPlainObject(base) || !isPlainObject(extra)) return extra;
  const out = { ...base };
  for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
  return out;
}

// Bind accepts one address, a comma list, or a JSON array -- because "LAN and the
// tunnel, but not the container bridges" cannot be said with a single socket.
function hostList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Read one env var and put it in the shape the config expects.
 *
 * This function used to handle only Number and Boolean and silently return the raw
 * string for every *function* cast -- and half the entries in the table below pass a
 * function. Measured consequence, found by test/cidr.test.js on 2026-09-09:
 *
 *   BMC_MON_ALLOW_CIDRS=203.0.113.0/24  ->  the string "203.0.113.0/24", not a list.
 *   The gate then iterated it CHARACTER by character, matched nothing, and refused
 *   every address -- so the documented way to restrict the monitor to a LAN was a
 *   deny-all firewall that also locked out the operator.
 *
 *   BMC_MON_ACTIONS=broadcast  ->  a string, and `allow.includes(name)` is a substring
 *   test on a string: permissions decided by substring matching instead of set
 *   membership. It happened not to grant anything today only because the action names
 *   do not contain each other.
 *
 * The host list survived by luck: validate() re-splits a string there.
 */
function env(name, cast) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  if (cast === Number) return Number(raw);
  if (cast === Boolean) return /^(1|true|yes|on)$/i.test(raw);
  if (typeof cast === 'function') return cast(raw);
  return raw;
}

/**
 * Where the machine-specific file lives -- and how a hermetic run opts out of it.
 *
 * Tests and the dev fake-node boot used to inherit whatever `config/local.json`
 * happened to say on this box. That is how a *deployment* decision (bind this box's
 * LAN + tailnet addresses) silently broke 54 smoke assertions: the script pinned its
 * data dir, ports and admin password, curled `127.0.0.1` -- and the server under test
 * was not listening there. A machine config must not leak into a hermetic run, so
 * give it a way to say "no file".
 */
function defaultConfigFile() {
  const e = process.env.BMC_MON_CONFIG;
  if (e === undefined || e === '') return path.join(ROOT, 'config', 'local.json');
  // A literal device path (e.g. /dev/null) is not a config file either; treat the
  // sentinel and a non-regular file the same way rather than throwing on parse.
  if (/^(none|off|no|-)$/i.test(e)) return null;
  return e;
}

// `ifaces` is injectable so tests are hermetic. Without it, validating a bind
// address against os.networkInterfaces() meant any test naming a bind address
// could only pass by naming THIS machine's real address -- fragile across lease
// changes, and a standing reason to commit a host address into the repository.
/**
 * `ifaces` and `now` are injectable so the checks below are testable without
 * touching this machine's real interfaces or waiting for a certificate to expire.
 * Both have production defaults; neither is read from anywhere but the caller.
 */
export function loadConfig({ configFile = defaultConfigFile(), ifaces = null, now = Date.now() } = {}) {
  let fileCfg = {};
  if (configFile && fs.existsSync(configFile) && fs.statSync(configFile).isFile()) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (err) {
      throw new Error(`config: cannot parse ${configFile}: ${err.message}`);
    }
  }
  let cfg = deepMerge(structuredClone(DEFAULTS), fileCfg);

  const e = {
    'BMC_MON_HOST': ['server.host', hostList],
    'BMC_MON_PORT': ['server.port', Number],
    'BMC_MON_BIND': ['server.host', hostList],
    'BMC_MON_ALLOW_CIDRS': ['server.allowCidrs', (v) => v.split(',').map((s) => s.trim()).filter(Boolean)],
    'BMC_MON_TRUST_PROXY': ['server.trustProxy', Boolean],
    'BMC_MON_NODE_URL': ['__nodeUrl', String],
    'BMC_MON_DATADIR': ['__datadir', String],
    'BMC_MON_LOGFILE': ['__logfile', String],
    'BMC_MON_COOKIE': ['__cookie', String],
    'BMC_MON_UNIT': ['__unit', String],
    'BMC_MON_RPC_TIMEOUT': ['rpc.timeoutMs', Number],
    'BMC_MON_RPC_MIN_INTERVAL': ['rpc.minIntervalMs', Number],
    'BMC_MON_RPC_STALE_DROP': ['rpc.staleDropMs', Number],
    'BMC_MON_DATA': ['store.dir', String],
    'BMC_MON_AUTH': ['auth.enabled', Boolean],
    'BMC_MON_ALLOW_WRITES_WITHOUT_AUTH': ['actions.allowWritesWithoutAuth', Boolean],
    // Run on RPC alone: 0 turns the log tail off for every node. Measured why is
    // in server/collect/monitor.js and MEASUREMENTS 3/4 -- bandwidth and per-peer
    // bytes work on builds that publish them and do not on the deployed one.
    'BMC_MON_LOG_SOURCE': ['log.enabled', Boolean],
    'BMC_MON_MARKETS': ['markets.enabled', Boolean],
    'BMC_MON_SECURE_COOKIE': ['auth.secureCookie', Boolean],
    'BMC_MON_TLS_CERT': ['server.tls.cert', String],
    'BMC_MON_TLS_KEY': ['server.tls.key', String],
    'BMC_MON_ACTIONS': ['actions.allow', (v) => v.split(',').map((s) => s.trim()).filter(Boolean)],
    'BMC_MON_ENABLE_ACTIONS': ['actions.enabled', Boolean],
    'BMC_MON_LOG_LEVEL': ['log.level', String],
    'BMC_MON_RETENTION_HOURS': ['store.retentionHours', Number],
  };
  // Sentinel keys gathered below (they address nodes[0], a fixed path would not).
  const sentinels = {};
  for (const [name, [p, cast]] of Object.entries(e)) {
    const v = env(name, cast);
    if (v === undefined) continue;
    if (p.startsWith('__')) { sentinels[p.slice(2)] = v; continue; }
    setPath(cfg, p, v);
  }
  if (sentinels.nodeUrl) {
    cfg.nodes[0].rpcUrl = sentinels.nodeUrl;
    cfg.nodes[0].__urlOverridden = true;
  }
  if (sentinels.datadir) {
    cfg.nodes[0].datadir = sentinels.datadir;
    cfg.nodes[0].cookieFile = null;
  }
  if (sentinels.logfile) cfg.nodes[0].logFile = sentinels.logfile;
  if (sentinels.cookie) cfg.nodes[0].cookieFile = sentinels.cookie;
  if (sentinels.unit) cfg.nodes[0].systemdUnit = sentinels.unit;

  if (env('BMC_MON_FAKE_NODE', Boolean)) cfg.__fakeNode = true;

  cfg.store.dir = cfg.store.dir || path.join(ROOT, 'data');
  cfg.auth.dataDir = cfg.auth.dataDir || cfg.store.dir;
  cfg.nodes.forEach((n, i) => { n.id = n.id || `node-${i}`; });

  validate(cfg, ifaces, now);
  cfg.__defaultsDoc = HERE_DOC;
  return cfg;
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const problems = [];
export function configProblems() { return problems; }

/**
 * TLS, checked at load, because every failure mode here is worse later.
 *
 * Half a TLS configuration is the important one. `cert` without `key` would
 * otherwise be silently ignored, which means an operator who set one line believed
 * the monitor was serving HTTPS while it was serving plaintext on the same port.
 * So a partial pair is fatal, not warned.
 *
 * The certificate is parsed with crypto.X509Certificate (a builtin, so no
 * dependency for a fact this important) and an expired cert is fatal too: a browser
 * refusing the connection is not information the dashboard can surface, because the
 * dashboard is on the other side of that refusal.
 */
/**
 * TLS, checked at load. `now` is injectable so the expiry branch is a tested
 * branch rather than a comment about a future date.
 */
function validateTls(cfg, now = Date.now()) {
  const tls = cfg.server.tls ?? {};
  cfg.server.tls = tls;
  cfg.tls = Boolean(tls.cert || tls.key);
  if (!cfg.tls) return;
  if (!tls.cert || !tls.key) {
    problems.push(`server.tls needs BOTH cert and key (got ${tls.cert ? 'cert only' : 'key only'}); a half-configured TLS would fall back to plaintext on a port you believe is HTTPS`);
    return;
  }
  for (const [what, file] of [['cert', tls.cert], ['key', tls.key]]) {
    try {
      fs.readFileSync(file);
    } catch (err) {
      problems.push(`server.tls.${what} cannot be read (${file}: ${err.code ?? err.message})`);
    }
  }
  if (problems.length) return;
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(tls.cert, 'utf8'));
    tls.fingerprint = x.fingerprint256;
    tls.notAfter = Date.parse(x.validTo);
    tls.selfSigned = x.issuer === x.subject;
    if (!Number.isFinite(tls.notAfter)) problems.push('server.tls.cert has no parseable validity window');
    else if (tls.notAfter <= now) {
      problems.push(`server.tls.cert expired ${new Date(tls.notAfter).toISOString()}; the browser will refuse the connection, and the dashboard cannot tell you so from behind that refusal`);
    } else if (tls.notAfter - now < 14 * 86_400_000) {
      cfg.__tlsExpiring = `certificate expires ${new Date(tls.notAfter).toISOString()}`;
    }
  } catch (err) {
    problems.push(`server.tls.cert is not a parseable X.509 certificate: ${err.message}`);
  }
}


function validate(cfg, ifaces = null, now = Date.now()) {
  problems.length = 0;
  if (!Array.isArray(cfg.nodes) || cfg.nodes.length === 0) problems.push('nodes must be non-empty');
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) problems.push('server.port invalid');
  // `hosts` is the truth: one address, a comma list, or an array all normalise here.
  // `host` stays populated with the first entry for anything that still reads it.
  cfg.server.hosts = hostList(cfg.server.hosts ?? cfg.server.host ?? '0.0.0.0');
  cfg.server.host = cfg.server.hosts[0];
  if (!cfg.server.hosts.length) problems.push('server.hosts is empty; nothing would be served');
  // A hostname here binds whatever DNS says at boot, and fails at listen() with a
  // message about names -- or, after a reboot with changed DNS, at the worst moment.
  // Refuse it at load and name the alternative.
  for (const h of cfg.server.hosts) {
    if (!isBindableHost(h)) problems.push(`server.hosts entry "${h}" is not an address literal; use an IPv4/IPv6 address, 0.0.0.0, or localhost`);
  }
  // Warn at boot -- not fatal -- about addresses this machine cannot take right now
  // (a tunnel interface that comes up after us is the common case).
  const plan = planBinds(cfg.server.hosts, ifaces ?? undefined);
  if (plan.noneUsable) problems.push(`none of the configured bind addresses (${plan.list.join(', ')}) exist on this machine; refusing to start with nothing to serve`);
  else if (plan.missing.length) cfg.server.hostsMissing = plan.missing;
  if (cfg.rpc.maxInFlight < 1) problems.push('rpc.maxInFlight must be >= 1');
  if (cfg.poll.fastMs < 1000) problems.push('poll.fastMs below 1s risks hammering a single-threaded RPC server');
  // An allowlist entry that does not parse is an inert rule, and an inert rule in an
  // allowlist is a hole that looks like a policy. The matcher also refuses to let one
  // admit anything (server/netinfo.js ipDecision), but the operator has to hear about
  // it at boot rather than notice when the gate disagrees with the file.
  for (const c of cfg.server.allowCidrs ?? []) {
    const parsed = parseCidr(c);
    if (!parsed.ok) problems.push(`server.allowCidrs entry "${c}" is unusable: ${parsed.reason}`);
  }
  validateTls(cfg, now);
  // "Open to everyone" plus "node writes enabled" is the one combination where the
  // role gate is vacuous: with no accounts there is no role to check, so every
  // action in actions.allow is callable by whoever can reach the port. Refuse to
  // boot on that configuration rather than trusting that the operator meant it; the
  // override exists precisely so it has to be chosen twice.
  if (cfg.actions.enabled && !cfg.auth.enabled && !cfg.actions.allowWritesWithoutAuth) {
    problems.push('node actions are enabled while accounts are OFF, which would let any address that can reach the port call them (there is no role to check). Either set BMC_MON_AUTH=1, or set BMC_MON_ALLOW_WRITES_WITHOUT_AUTH=1 deliberately alongside BMC_MON_ACTIONS.');
  }
  if (!cfg.auth.enabled) {
    // Not a problem, a fact the operator should see once at boot.
    cfg.__openAccess = true;
  }
  if (!(Number.isInteger(cfg.store.blockMapCap) && cfg.store.blockMapCap >= 100)) {
    problems.push('store.blockMapCap must be an integer >= 100; a block map that holds nothing renders "no blocks" as if it were a fact');
  }
  if (!(Number.isInteger(cfg.store.auditMaxBytes) && cfg.store.auditMaxBytes >= 64 * 1024)) {
    problems.push('store.auditMaxBytes must be >= 65536; below that the audit rotates on every write');
  }
  for (const n of cfg.nodes) {
    if (!n.rpcUrl || !/^https?:\/\//.test(n.rpcUrl)) problems.push(`node ${n.id}: rpcUrl must be http(s)://host:port`);
    if (!n.datadir && !n.cookieFile) problems.push(`node ${n.id}: need datadir or cookieFile for cookie auth`);
  }
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

// Cookie resolution. <datadir>/<chain>/.cookie is the real layout; the file is
// regenerated on every boot and deleted on shutdown, so a cached cookie is a
// liability and callers re-resolve on 401 rather than trusting a stale value.
export function resolveCookie(node) {
  const candidates = [];
  if (node.cookieFile) candidates.push(node.cookieFile);
  if (node.datadir) {
    if (node.chainHint) candidates.push(path.join(node.datadir, node.chainHint, '.cookie'));
    candidates.push(path.join(node.datadir, '.cookie'));
    try {
      for (const ent of fs.readdirSync(node.datadir, { withFileTypes: true })) {
        if (ent.isDirectory()) candidates.push(path.join(node.datadir, ent.name, '.cookie'));
      }
    } catch { /* datadir not readable from here; the explicit paths still stand */ }
  }
  for (const c of candidates) {
    try {
      const raw = fs.readFileSync(c, 'utf8').trim();
      if (raw.includes(':')) return { user: raw.split(':')[0], password: raw.slice(raw.indexOf(':') + 1), source: c };
    } catch { /* try next */ }
  }
  if (node.rpcUser) return { user: node.rpcUser, password: node.rpcPassword || '', source: 'config' };
  return null;
}
