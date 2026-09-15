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
Defaults are Bitcoin Core's own, so \`npm start\` works against a stock local node:
  node RPC     127.0.0.1:8332  (Core's mainnet default; testnet 18332, signet 38332)
  cookie       <datadir>/<chain>/.cookie  (regenerated each boot, deleted on stop)
  datadir      ~/.bitcoin
  systemd      bitcoind.service
  log          <datadir>/debug.log
  NOTE  a node that serves RPC on a NON-default port is the single most common reason
  this monitor reports the node offline with ECONNREFUSED while the node is healthy.
  Measured twice on the machine this was built against, where an rpcport= line was lost
  to a config cleanup: check the node's own log for its "JSON-RPC server on ..." line
  before believing the report. RPC can also bind well after systemd says "running", and
  chain RPCs can block for tens of seconds after that -- see MEASUREMENTS 18.
`.trim();

const DEFAULTS = {
  server: {
    // Multi-user means the LAN has to reach it, so it binds broadly by default.
    // Set BLOCKYARD_BIND=127.0.0.1 to keep it on this machine only.
    host: '0.0.0.0',
    // 21000 (operator, 2026-09-13: "make default web port 21000 for access"). It was 8088, which
    // sits in the range every other monitor on a box reaches for; this one is ours.
    port: 21000,
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
      cert: null,   // PEM; BLOCKYARD_TLS_CERT
      key: null,    // PEM; BLOCKYARD_TLS_KEY
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
      // Bitcoin Core's own mainnet defaults (operator, 2026-09-13: a Core-centric release,
      // "meant to be pointed at your Umbrel nodes or local Bitcoin Nodes"). A deployment
      // that differs says so in config/local.json or through BLOCKYARD_NODE_* -- both are
      // applied over these, so nothing here has to be right for everyone.
      id: 'main',
      label: 'Bitcoin Core (mainnet)',
      rpcUrl: 'http://127.0.0.1:8332',
      datadir: '/home/bitcoin/.bitcoin',
      chainHint: 'main',
      cookieFile: null, // derived from datadir+chainHint when null
      rpcUser: null,
      rpcPassword: null,
      logFile: '/home/bitcoin/.bitcoin/debug.log',
      systemdUnit: 'bitcoind.service',
      color: '#f7931a',
    },
  ],
  // Why the benchmark node is not monitored (was `bench`, removed 2026-09-08).
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
  //     { "id": "main", "label": "Bitcoin Core (mainnet)",
  //       "rpcUrl": "http://127.0.0.1:8332",
  //       "datadir": "/home/bitcoin/.bitcoin", "chainHint": "main",
  //       "logFile": "/home/bitcoin/.bitcoin/debug.log" },
  //     { "id": "bench", "label": "Bench node (IBD / benchmark)",
  //       "rpcUrl": "http://127.0.0.1:8461",
  //       "datadir": "/mnt/2tbssd/bench/data", "chainHint": "main",
  //       "logFile": "/mnt/2tbssd/bench/console.log",
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
      id: 'bench',
      label: 'Bench node (IBD / benchmark)',
      rpcUrl: 'http://127.0.0.1:8461',
      datadir: '/mnt/2tbssd/bench/data',
      chainHint: 'main',
      logFile: '/mnt/2tbssd/bench/console.log',
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
    // Set BLOCKYARD_AUTH=1 (or auth.enabled in config/local.json) for accounts, roles,
    // sessions, CSRF and the audit trail-by-user.
    enabled: false,
    dataDir: null,
    // THE LONG ONE IS THE ABSOLUTE LIFETIME, the short one the idle ceiling -- which is the way
    // round the names read, and the opposite of what shipped until 2026-09-13. With an 8 h
    // absolute and a 72 h idle ceiling, the idle check in sessions.js could never fire: nothing
    // lived long enough to be 72 h idle, so a session was 8 h whatever you did. Found in an audit;
    // docs/SECURITY.md described the intended relationship, not the one in force.
    sessionTtlMs: 72 * 3600 * 1000,   // absolute: a session dies 72 h after sign-in, active or not
    idleTtlMs: 8 * 3600 * 1000,       // idle: 8 h without a request and it is gone
    scrypt: { N: 16384, r: 8, p: 1, keylen: 32 },
    minPasswordChars: 12,
    loginMaxAttempts: 8,
    loginWindowMs: 300000,
    lockoutMs: 600000,
    cookieName: 'blockyard_sid',
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
    // OFF by default, and NOT SUPPORTED AGAINST BITCOIN CORE.
    //
    // logparse.js targets an experimental node's log grammar: its rules key on [dlc], [dl],
    // [dial], [utxo_live] and [config] tags, and its timestamp rule wants
    // "YYYY-MM-DD HH:MM:SS.mmm ", not the "2026-09-13T01:30:00Z" Core writes. Measured
    // 2026-09-13 against real Core debug.log lines: every line comes back as an unstructured
    // `raw` event with NO fields extracted, and its timestamp falls back to the time of reading
    // rather than the time in the line -- so turning this on against Core adds nothing and
    // misdates the event feed. Both fixtures in test/fixtures/ are experimental-format; no Core
    // log has ever been tested against this parser (test/log-core-unsupported.test.js pins that).
    //
    // Off since 2026-09-09 for an independent reason that still holds: tailing a file the node
    // rewrites between releases is a grammar dependency that has already cost this project two
    // silent-outage incidents, and every panel that needed it was removed rather than left
    // showing dashes. Nothing in the UI depends on the log.
    //
    // The measurements that motivated the option are from the experimental node and are kept for
    // the reasoning, not as claims about Core: on the build deployed there, RPC answered
    // getnettotals 0/0 and getpeerinfo [] while getconnectioncount said 16, so "RPC only" meant
    // "no bandwidth and no peer names at all" -- and both builds reported the same non-Core
    // subversion string, so RPC could not tell you which one you had (MEASUREMENTS 3, 4, 11, 26).
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
  // parked idleAfterMs after the last request. BLOCKYARD_MARKETS=0 removes it altogether.
  // POLLING IS OFF OUT OF THE BOX regardless (operator, 2026-09-15: "disable markets by default so
  // we can claim true zero telemetry out of the box" ... "an app wide 'Enable Market Polling'
  // checkbox"): the feed is built here but asks nobody anything until the switch in Display
  // settings -> Markets & Price -> Enable market polling is on (http/api.js marketsPollingOn).
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
 *   BLOCKYARD_ALLOW_CIDRS=203.0.113.0/24  ->  the string "203.0.113.0/24", not a list.
 *   The gate then iterated it CHARACTER by character, matched nothing, and refused
 *   every address -- so the documented way to restrict the monitor to a LAN was a
 *   deny-all firewall that also locked out the operator.
 *
 *   BLOCKYARD_ACTIONS=broadcast  ->  a string, and `allow.includes(name)` is a substring
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
  const e = process.env.BLOCKYARD_CONFIG;
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
    'BLOCKYARD_HOST': ['server.host', hostList],
    'BLOCKYARD_PORT': ['server.port', Number],
    'BLOCKYARD_BIND': ['server.host', hostList],
    'BLOCKYARD_ALLOW_CIDRS': ['server.allowCidrs', (v) => v.split(',').map((s) => s.trim()).filter(Boolean)],
    'BLOCKYARD_TRUST_PROXY': ['server.trustProxy', Boolean],
    'BLOCKYARD_NODE_URL': ['__nodeUrl', String],
    'BLOCKYARD_DATADIR': ['__datadir', String],
    'BLOCKYARD_LOGFILE': ['__logfile', String],
    'BLOCKYARD_COOKIE': ['__cookie', String],
    'BLOCKYARD_UNIT': ['__unit', String],
    'BLOCKYARD_NODE_LABEL': ['__label', String],
    'BLOCKYARD_RPC_TIMEOUT': ['rpc.timeoutMs', Number],
    'BLOCKYARD_RPC_MIN_INTERVAL': ['rpc.minIntervalMs', Number],
    'BLOCKYARD_RPC_STALE_DROP': ['rpc.staleDropMs', Number],
    'BLOCKYARD_DATA': ['store.dir', String],
    'BLOCKYARD_AUTH': ['auth.enabled', Boolean],
    'BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH': ['actions.allowWritesWithoutAuth', Boolean],
    // Run on RPC alone: 0 turns the log tail off for every node. Measured why is
    // in server/collect/monitor.js and MEASUREMENTS 3/4 -- bandwidth and per-peer
    // bytes work on builds that publish them and do not on the deployed one.
    'BLOCKYARD_LOG_SOURCE': ['log.enabled', Boolean],
    'BLOCKYARD_MARKETS': ['markets.enabled', Boolean],
    'BLOCKYARD_SECURE_COOKIE': ['auth.secureCookie', Boolean],
    'BLOCKYARD_TLS_CERT': ['server.tls.cert', String],
    'BLOCKYARD_TLS_KEY': ['server.tls.key', String],
    'BLOCKYARD_ACTIONS': ['actions.allow', (v) => v.split(',').map((s) => s.trim()).filter(Boolean)],
    'BLOCKYARD_ENABLE_ACTIONS': ['actions.enabled', Boolean],
    'BLOCKYARD_LOG_LEVEL': ['log.level', String],
    'BLOCKYARD_RETENTION_HOURS': ['store.retentionHours', Number],
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
  // A node is named by whoever knows its name: an explicit label -- from the environment or from
  // the file -- is the operator speaking, and always wins. Failing that, a node whose URL was
  // overridden is named by the endpoint it actually answers on, which cannot be wrong. Keeping
  // the built-in label there would state something false about a node nobody named; the
  // fallback states only what was measured. Nodes nobody redirected keep their built-in name.
  const fileNode0 = Array.isArray(fileCfg.nodes) ? fileCfg.nodes[0] : null;
  const fileLabel = fileNode0 && fileNode0.label;
  // The address this node was already configured for, before the environment spoke. An override
  // that names this same address has redirected nothing, so the built-in name still describes the
  // node being polled and must stand.
  const baseUrl = (fileNode0 && fileNode0.rpcUrl) || DEFAULTS.nodes[0].rpcUrl;
  const movedNode = !!sentinels.nodeUrl && sentinels.nodeUrl !== baseUrl;
  // Guarded, because `nodes: []` is refused by validate() below with a sentence that names the
  // mistake, and reaching into nodes[0] before then would replace that sentence with a TypeError.
  if (cfg.nodes[0]) {
    if (sentinels.label) cfg.nodes[0].label = sentinels.label;
    else if (movedNode && !fileLabel) {
      let host = cfg.nodes[0].rpcUrl;
      try { host = new URL(cfg.nodes[0].rpcUrl).host; } catch { /* validate() reports a bad URL */ }
      cfg.nodes[0].label = `node @ ${host}`;
    }
  }

  if (env('BLOCKYARD_FAKE_NODE', Boolean)) cfg.__fakeNode = true;

  cfg.store.dir = cfg.store.dir || path.join(ROOT, 'data');
  cfg.auth.dataDir = cfg.auth.dataDir || cfg.store.dir;
  cfg.nodes.forEach((n, i) => { n.id = n.id || `node-${i}`; });

  validate(cfg, ifaces, now);
  cfg.__defaultsDoc = HERE_DOC;
  // WHICH FILE THIS CAME FROM. The path was an argument, used and then forgotten, so nothing
  // downstream could say where the settings live -- and a UI that offers to save a connection must
  // name the file it would write rather than guess at one. `null` is a real answer: a hermetic run
  // (BLOCKYARD_CONFIG=none) has no file, and a save must be refused rather than invent a path.
  cfg.__configFile = configFile ?? null;
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
    problems.push('node actions are enabled while accounts are OFF, which would let any address that can reach the port call them (there is no role to check). Either set BLOCKYARD_AUTH=1, or set BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1 deliberately alongside BLOCKYARD_ACTIONS.');
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
    // AUTHENTICATION CAN COME FROM EITHER PLACE. Cookie auth needs a datadir (or an explicit
    // cookieFile) to read <datadir>/<chain>/.cookie -- but a node that authenticates with rpcauth
    // has no cookie to read, and rpcUser/rpcPassword is the way in. resolveCookie() has always
    // supported that (it falls through to the configured user/password); this validator did not,
    // so a user/password node was refused at boot with "need datadir or cookieFile". Found
    // 2026-09-13. BlockYard runs on the node's machine (the explorer needs its block files), so
    // this is for a node that uses rpcauth, not a node elsewhere.
    const hasCookiePath = !!(n.datadir || n.cookieFile);
    const hasUserPass = !!(n.rpcUser && n.rpcPassword);
    if (!hasCookiePath && !hasUserPass) {
      problems.push(`node ${n.id}: needs either datadir/cookieFile (cookie auth, same machine) or rpcUser + rpcPassword (a node authenticating with rpcauth)`);
    }
    if (n.rpcUser && !n.rpcPassword) problems.push(`node ${n.id}: rpcUser is set but rpcPassword is empty`);
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
