# Configuration reference

This is the complete reference for configuring bmcmonitor: every configuration
key, every environment variable, what lives in the data directory, and which
mistakes stop the server from starting.

bmcmonitor needs no configuration file to start. The built-in defaults describe
one particular bmc install, though, so most deployments want at least a
`config/local.json` that says where the node is.

- [How configuration is resolved](#how-configuration-is-resolved)
- [Creating config/local.json](#creating-configlocaljson)
- [Configuration keys](#configuration-keys)
  - [server](#server)
  - [nodes](#nodes)
  - [rpc](#rpc)
  - [poll](#poll)
  - [store](#store)
  - [auth](#auth)
  - [actions](#actions)
  - [log](#log)
  - [markets](#markets)
- [Environment variables](#environment-variables)
- [Examples](#examples)
- [The data directory](#the-data-directory)
- [Validation: what stops the boot](#validation-what-stops-the-boot)
- [Known quirks](#known-quirks)

---

## How configuration is resolved

Three layers, highest priority first:

1. **Environment variables** (`BMC_MON_*`, see [the table](#environment-variables)).
2. **The configuration file**: `config/local.json` in the repository root, or the
   file named by `BMC_MON_CONFIG`.
3. **Built-in defaults** (`DEFAULTS` in `server/config.js`).

Merge rules:

- **Objects are merged key by key.** `{"server": {"port": 9000}}` changes the port
  and keeps every other `server` key at its default.
- **Arrays replace the default wholesale.** This matters for `nodes`. As soon as your
  file has a `nodes` array, the built-in node entry is gone and none of its fields
  are inherited. Every node you list must be complete on its own.
- **Unknown keys are ignored silently.** No schema check runs, so a misspelled key
  such as `"allowCIDRs"` has no effect and produces no error.

`BMC_MON_CONFIG` controls which file is read:

| value | effect |
|---|---|
| unset or empty | read `<repo>/config/local.json` if it exists |
| a path | read that file instead |
| `none`, `off`, `no` or `-` (any case) | read no file; defaults plus environment only |

A path that does not exist, or is not a regular file (for example `/dev/null`),
counts as "no file". **It is not an error**, so a typo in the path quietly gives you
the defaults. A file that exists but is not valid JSON stops the boot (see
[Validation](#validation-what-stops-the-boot)).

`npm run dev` sets `BMC_MON_CONFIG=none`, so a development run never picks up the
machine's real configuration.

## Creating config/local.json

```bash
cd /path/to/bmcmonitor
mkdir -p config
$EDITOR config/local.json      # see the examples below
chmod 600 config/local.json    # if it contains rpcPassword or other secrets
npm start
```

`config/local.json` is listed in `.gitignore`. Machine-specific facts (addresses,
paths, credentials) belong there and never in a committed file.

The file is read once at startup. Restart the server after editing it.

---

## Configuration keys

Durations are in milliseconds unless the name says otherwise (`retentionHours`).

### server

| key | default | meaning |
|---|---|---|
| `server.host` | `"0.0.0.0"` | Address to listen on. Kept for compatibility; `server.hosts` wins when both are set. |
| `server.hosts` | *(unset; falls back to `host`)* | Addresses to listen on: an array (`["192.0.2.10", "2001:db8::10"]`), or a single string with commas (`"192.0.2.10,198.51.100.7"`). One HTTP server is started per address, and all of them share sessions, rate limits and monitors. Entries must be address literals: IPv4, IPv6, `0.0.0.0`, `::`, or `localhost`. Hostnames are refused. See [Binding](#binding-to-specific-addresses). |
| `server.port` | `8088` | TCP port. It is the same port on every address. It must be an integer from 1 to 65535. |
| `server.allowCidrs` | `[]` | Client allowlist. Empty means every client that can reach the port is admitted. Otherwise only addresses inside one of the networks connect, and everyone else gets HTTP 403 (the reason goes to the server log). Entries are CIDRs or bare addresses (a bare address means `/32` or `/128`), IPv4 or IPv6, compared bit by bit. An entry that cannot be parsed stops the boot. |
| `server.trustProxy` | `false` | When `true`, the client address is the **first** entry of the `X-Forwarded-For` header instead of the socket's peer address. That address feeds the CIDR allowlist, the rate limits and the audit log. Turn it on only when a reverse proxy you control is the sole way in and it sets that header. Otherwise any client can pick its own address and walk past `allowCidrs`. |
| `server.tls.cert` | `null` | Path to a PEM certificate. TLS is on only when `cert` and `key` are both set, and then every listener serves HTTPS. |
| `server.tls.key` | `null` | Path to the PEM private key for `cert`. This file is secret. |
| `server.tls.hstsMs` | `172800000` (2 days) | `max-age` of the `Strict-Transport-Security` header. It is sent on TLS responses only. `0` turns it off. `includeSubDomains` and `preload` are never sent. |

When TLS is on, `auth.secureCookie` is forced to `true`. At startup the server logs
the certificate's SHA-256 fingerprint and whether it is self-signed. It also warns
when the certificate expires within 14 days.

### nodes

`nodes` is an array with one object per bmc node to monitor. It must not be empty.
If you list more than one node, the web UI shows a node picker, and every node gets
its own charts and event stream.

| field | default | meaning |
|---|---|---|
| `id` | `node-<index>` | Stable identifier, used in URLs (`?node=<id>`) and to tag stored history. Changing it orphans that node's past chart data. |
| `label` | same as `id` | Display name in the UI. |
| `rpcUrl` | **required** | `http://host:port` or `https://host:port` of the node's JSON-RPC server. |
| `datadir` | none | The node's data directory, used to find its RPC cookie (see below). |
| `chainHint` | none | Name of the chain subdirectory inside `datadir` that holds the cookie, for example `main`. |
| `cookieFile` | `null` | Explicit path to the RPC cookie file. When set, it is tried first. |
| `rpcUser` | `null` | RPC username. It is used only when no cookie file can be read. |
| `rpcPassword` | `null` | RPC password for `rpcUser`. It is a secret, so protect the config file. |
| `logFile` | none | The node's log file, tailed only when `log.enabled` is `true`. With the log source off (the default) this field is ignored, and a line in the startup log says so. |
| `logStaleMs` | *(uses `log.staleMs`)* | Per-node override for how long the log may go without new bytes before the monitor reports it as silent. Use a smaller value for a node that is known to log often. |
| `optional` | `false` | Marks a node whose absence is expected, such as a test or benchmark node. Its failures are logged at a lower severity, a missing datadir is reported at `info` instead of `warn`, and it does not count as a required node in `/api/health`. |
| `color` | `"#f7931a"` | Accent colour for this node in the UI. |
| `systemdUnit` | *(see defaults)* | Name of the node's systemd unit. It is informational and not currently used by the server. |

**Credentials.** Every node needs `datadir` or `cookieFile`, even one that
authenticates with `rpcUser`/`rpcPassword` (see
[Known quirks](#known-quirks) and the [remote node example](#a-remote-node-with-a-username-and-password)).
Before every connection that lacks a credential, and again after any HTTP 401, the
client looks for a credential in this order and uses the first one found:

1. `cookieFile`
2. `<datadir>/<chainHint>/.cookie`
3. `<datadir>/.cookie`
4. `<datadir>/<every subdirectory>/.cookie`
5. `rpcUser` / `rpcPassword`

A cookie file that can be read always wins over `rpcUser`. The node rewrites its
cookie on every restart, and the monitor picks up the new one automatically. The
account running bmcmonitor needs read access to the cookie file, and to `logFile` if
you use one.

**Skipped nodes.** A node that has `datadir`, has no `cookieFile`, and whose
`datadir` does not exist at startup is **skipped** with a log line. The server does
not stop. This lets a node whose directory has been removed disappear cleanly
instead of showing as permanently offline.

**Built-in default node.** Without a `nodes` array in your file, one node is
configured. It assumes a bmc mainnet install under `/storage/bitcoinmachinecode`
whose RPC server listens on port 8331:

| field | built-in value |
|---|---|
| `id` | `bmc-main` |
| `label` | `BMC mainnet (production)` |
| `rpcUrl` | `http://127.0.0.1:8331` |
| `datadir` | `/storage/bitcoinmachinecode/data` |
| `chainHint` | `main` |
| `logFile` | `/storage/bitcoinmachinecode/logs/main/bitcoin.main.log` |
| `systemdUnit` | `bmcbitcoind.service` |
| `color` | `#f7931a` |

If your node lives elsewhere, override it with a `nodes` array in
`config/local.json`, or for the first node only, with `BMC_MON_NODE_URL`,
`BMC_MON_DATADIR`, `BMC_MON_COOKIE` and `BMC_MON_LOGFILE`. Note that Bitcoin Core's
standard mainnet RPC port is 8332, so check your node's `rpcport`.

### rpc

The node's RPC server handles one connection at a time on a single thread.
bmcmonitor therefore sends requests one at a time, in priority order, and these
limits protect the node from the monitor. They apply to each node separately.

| key | default | meaning |
|---|---|---|
| `rpc.maxInFlight` | `1` | Requests outstanding at once. It must be at least 1. Raising it only helps a node that serves requests concurrently. |
| `rpc.minIntervalMs` | `250` | Minimum gap between the start of one request and the next. |
| `rpc.maxRatePerSec` | `4` | Hard ceiling on requests per second, whatever the poll tiers ask for. |
| `rpc.timeoutMs` | `90000` | Timeout for ordinary calls. It is deliberately generous, because a busy but healthy node can take tens of seconds to answer. |
| `rpc.heavyTimeoutMs` | `300000` | Timeout for calls that are known to be expensive (UTXO-set statistics and similar). |
| `rpc.staleDropMs` | `12000` | A poll answer that arrives later than this after it was requested is thrown away, not shown as current state. |
| `rpc.slowLatencyMs` | `5000` | Above this average latency, the UI says the node is slow instead of implying the monitor is broken. |
| `rpc.breakerThreshold` | `3` | Consecutive failures before the circuit breaker opens and the monitor stops sending requests for a while. |
| `rpc.breakerCooldownMs` | `30000` | How long the breaker stays open before the next attempt. |

### poll

Each tier is a group of RPC reads that runs on its own cadence. The cadence adapts
under load: a tier stretches to at least twice the observed RPC latency, and the
heavy tiers are thinned while the node is slow.

| key | default | what it reads |
|---|---|---|
| `poll.fastMs` | `4000` | Chain info, mempool info, connection count, network totals, uptime. It must be at least 1000. |
| `poll.midMs` | `15000` | Mining info, fee estimates, chain tips, mempool transaction ids. |
| `poll.poolMs` | `20000` | The verbose mempool, which feeds the block-space viewer and the mempool map. If it is missing, `slowMs` is used. |
| `poll.slowMs` | `60000` | Index info, UTXO-set info, chain transaction statistics. |
| `poll.rareMs` | `900000` | Peer info, deployment info, RPC server info. |
| `poll.blockBackfill` | `30` | How many recent blocks are fetched at startup when no block history is loaded. |

### store

| key | default | meaning |
|---|---|---|
| `store.dir` | `<repo>/data` | Data directory for history snapshots, the audit log and the mining label files. It is created if missing. See [The data directory](#the-data-directory). |
| `store.retentionHours` | `72` | How long chart history is kept. |
| `store.ringCapacity` | `20000` | Maximum points kept per chart series. |
| `store.maxEventLog` | `5000` | Maximum entries kept in the event feed. |
| `store.snapshotEveryMs` | `120000` | How often changed history is written to `history.json`. Writes are atomic (temporary file, fsync, rename). History is also saved on a clean shutdown. |
| `store.blockMapCap` | `12000` | Maximum blocks kept in the in-memory block map. It must be an integer of at least 100. |
| `store.auditMaxBytes` | `8388608` (8 MiB) | Size at which `audit.jsonl` is rotated. It must be at least 65536. |
| `store.auditKeep` | `5` | Rotated audit files to keep (`audit.1.jsonl` … `audit.5.jsonl`). The oldest is deleted when a new one is created. |

### auth

Accounts are **off by default**. With accounts off, anyone who can reach a listen
address reads the monitor without signing in, as role `viewer`: charts, event feed,
peer and mempool detail, and the read-only RPC console. User administration, the
audit trail and password changes stay closed. Node writes stay closed unless
[`actions`](#actions) explicitly opens them. A warning at every startup names the
addresses left open.

With accounts on you get sign-in, three roles (`viewer` < `operator` < `admin`),
sessions, CSRF protection and a per-user audit trail.

| key | default | meaning |
|---|---|---|
| `auth.enabled` | `false` | Turn accounts on. |
| `auth.dataDir` | same as `store.dir` | Where `users.json` and `sessions.json` live. |
| `auth.sessionTtlMs` | `28800000` (8 h) | Absolute session lifetime, counted from sign-in. |
| `auth.idleTtlMs` | `259200000` (72 h) | A session unused for this long expires. With the defaults the 8-hour absolute lifetime always expires first. |
| `auth.scrypt.N` | `16384` | scrypt cost parameter for password hashes. |
| `auth.scrypt.r` | `8` | scrypt block size. |
| `auth.scrypt.p` | `1` | scrypt parallelism. |
| `auth.scrypt.keylen` | `32` | Derived key length in bytes. |
| `auth.minPasswordChars` | `12` | Minimum password length. Passwords are also refused if they contain the username, begin with a common breached password (`password`, `admin`, `qwerty`, `bitcoin`, …), or are one character repeated. |
| `auth.loginMaxAttempts` | `8` | Intended: failed logins per username before lockout. See [Known quirks](#known-quirks); the effective value is 8 whatever you set. |
| `auth.loginWindowMs` | `300000` (5 min) | Intended: window in which failed attempts are counted. See [Known quirks](#known-quirks); the effective value is 5 minutes. |
| `auth.lockoutMs` | `600000` (10 min) | How long a username stays locked after too many failures. |
| `auth.cookieName` | `"bmcmon_sid"` | Name of the session cookie. |
| `auth.secureCookie` | `false` | Mark the session cookie `Secure`. Forced to `true` when `server.tls` is on. Set it yourself only when a TLS-terminating reverse proxy sits in front, because browsers never send a `Secure` cookie over plain HTTP. |

Separately from these settings, login requests are rate-limited per client address
(a burst of 10, then one attempt every 2 seconds). All API requests are
rate-limited too.

**The first admin account.** When accounts are on and `users.json` holds no users, the
server creates a user named `admin` at startup:

- If `BMC_MON_ADMIN_PASSWORD` is set, that is the password. It must pass the
  password rules above; for example, it may not contain `admin`. A password that
  fails them stops the boot.
- Otherwise a random 20-character password is generated and printed **once** in the
  startup banner. Only its scrypt hash is stored.

**Managing accounts from the command line**, for example after a lost password.
Passwords are always read from the terminal without echo, never from arguments:

```bash
npm run user -- list
npm run user -- create alice operator
npm run user -- passwd alice
npm run user -- role alice admin
npm run user -- disable alice      # or: enable alice
npm run user -- rm alice
```

(`npm run user` is `node scripts/manage-users.js`.) The tool loads the same
configuration as the server and edits `<auth.dataDir>/users.json`. It will not
disable, demote or delete the last enabled admin. If accounts are off in the
configuration it loads, it says so, because the server ignores `users.json` in that
state.

### actions

Actions are the only node **writes** bmcmonitor can make. Everything is off by
default. An action runs only when all of these are true:

1. `actions.enabled` is `true`;
2. the action's name is listed in `actions.allow`;
3. accounts are on **and** the signed-in user has at least the role the action
   requires, **or** accounts are off and `actions.allowWritesWithoutAuth` is `true`;
4. the request carries a typed confirmation of the action's name.

Every attempt, allowed or denied, is written to the audit log.

| key | default | meaning |
|---|---|---|
| `actions.enabled` | `false` | Master switch for node writes. |
| `actions.allow` | `[]` | Names of the actions to enable (see below). |
| `actions.requireAdmin` | `true` | Not currently consulted; each action's minimum role is fixed (see the table below and [Known quirks](#known-quirks)). |
| `actions.allowWritesWithoutAuth` | `false` | Required, deliberately and separately, to enable actions while accounts are off. With accounts off there is no role to check, so every allowed action can be called by anyone who can reach the port. |

Available actions:

| name | node RPC | minimum role |
|---|---|---|
| `broadcast` | `sendrawtransaction` | `operator` |
| `savemempool` | `savemempool` | `operator` |
| `testmempoolaccept` | `testmempoolaccept` (a dry run, changes nothing) | `viewer` |
| `verifychain_l1` | `verifychain` at check level 2, depth 6 | `admin` |

### log

| key | default | meaning |
|---|---|---|
| `log.level` | `"info"` | Server log verbosity: `debug`, `info`, `warn` or `error`. The server logs to stdout. Under systemd that goes to the journal. |
| `log.enabled` | `false` | Tail each node's `logFile` as an extra data source. Off by default: the monitor runs on RPC alone. Turn it on only if your node build writes a log format bmcmonitor parses. With it off, figures that only the log can provide (bandwidth and per-peer bytes on builds whose RPC reports zero) are shown as unavailable. |
| `log.tailBytes` | `2097152` (2 MiB) | Size of the read-back window the log tail uses. |
| `log.staleMs` | `1800000` (30 min) | How long a tailed log may go without a single new byte before the monitor reports it as silent. A synced, idle node can legitimately stay quiet for about 20 minutes. Override per node with `logStaleMs`. |
| `log.healthMs` | `30000` | How often that check runs. It costs no RPC. |

### markets

The Markets tab fetches public BTC/USD prices, hourly candles and order books from
five exchanges over HTTPS: Coinbase, Kraken, Bitstamp, Bitfinex and OKX (OKX quotes
BTC/USDT). The fetches run on the server, not in the browser. This is bmcmonitor's
only outbound connection other than the node. Exchanges see this server's IP
address and a User-Agent, nothing about the node. Polling starts when someone opens
the Markets tab and stops `idleAfterMs` after the last request from that tab, so an
unwatched monitor makes no exchange traffic. The exchange list is fixed in code.

| key | default | meaning |
|---|---|---|
| `markets.enabled` | `true` | `false` removes the feed entirely, and no request is ever made. |
| `markets.tickerMs` | `15000` | Ticker (last, bid, ask, 24 h volume) refresh. |
| `markets.candleMs` | `300000` | Hourly candle refresh. |
| `markets.bookMs` | `30000` | Order book refresh, for the depth chart. |
| `markets.idleAfterMs` | `600000` | Stop polling this long after the last Markets request. |
| `markets.timeoutMs` | `8000` | Timeout for each exchange request. |

---

## Environment variables

Environment variables override `config/local.json`.

- **Booleans**: `1`, `true`, `yes` or `on` (any case) mean true. Any other non-empty
  value means false.
- **Empty values**: a variable set to the empty string counts as unset.
- **Numbers**: parsed with `Number()`. A non-numeric value becomes `NaN`. Only
  `BMC_MON_PORT` is range-checked, so check spelling.
- **Lists**: comma-separated, with spaces around entries trimmed.
- **Node variables** (`BMC_MON_NODE_URL`, `BMC_MON_DATADIR`, `BMC_MON_COOKIE`,
  `BMC_MON_LOGFILE`, `BMC_MON_UNIT`) change **only the first entry** of `nodes`,
  whether that entry comes from the defaults or from your file.

### Server variables

| variable | sets | type | default | meaning |
|---|---|---|---|---|
| `BMC_MON_CONFIG` | *(which file is read)* | path or `none` | `<repo>/config/local.json` | Configuration file to read. `none`/`off`/`no`/`-` reads no file. |
| `BMC_MON_BIND` | `server.host` | list | `0.0.0.0` | Listen address(es), for example `127.0.0.1` or `192.0.2.10,2001:db8::10`. If both are set, this wins over `BMC_MON_HOST`. Ignored when the file sets `server.hosts` (see [Known quirks](#known-quirks)). |
| `BMC_MON_HOST` | `server.host` | list | `0.0.0.0` | Same as `BMC_MON_BIND`. |
| `BMC_MON_PORT` | `server.port` | number | `8088` | Listen port. |
| `BMC_MON_ALLOW_CIDRS` | `server.allowCidrs` | list | *(empty: everyone)* | Client allowlist, for example `192.0.2.0/24,2001:db8::/32`. |
| `BMC_MON_TRUST_PROXY` | `server.trustProxy` | boolean | `false` | Take the client address from `X-Forwarded-For`. |
| `BMC_MON_TLS_CERT` | `server.tls.cert` | path | unset | PEM certificate. Set it together with `BMC_MON_TLS_KEY`. |
| `BMC_MON_TLS_KEY` | `server.tls.key` | path | unset | PEM private key. Set it together with `BMC_MON_TLS_CERT`. |
| `BMC_MON_NODE_URL` | `nodes[0].rpcUrl` | URL | `http://127.0.0.1:8331` | RPC endpoint of the first node. |
| `BMC_MON_DATADIR` | `nodes[0].datadir` | path | `/storage/bitcoinmachinecode/data` | Data directory of the first node. It also **clears** `nodes[0].cookieFile`, so the cookie is looked up under the new datadir. |
| `BMC_MON_COOKIE` | `nodes[0].cookieFile` | path | unset | Explicit cookie file for the first node. It is applied after `BMC_MON_DATADIR`, so it wins. |
| `BMC_MON_LOGFILE` | `nodes[0].logFile` | path | see [defaults](#nodes) | Log file of the first node. Used only when the log source is on. |
| `BMC_MON_UNIT` | `nodes[0].systemdUnit` | string | `bmcbitcoind.service` | systemd unit name of the first node. Informational only. |
| `BMC_MON_RPC_TIMEOUT` | `rpc.timeoutMs` | number | `90000` | RPC timeout for ordinary calls. |
| `BMC_MON_RPC_MIN_INTERVAL` | `rpc.minIntervalMs` | number | `250` | Minimum gap between RPC requests. |
| `BMC_MON_RPC_STALE_DROP` | `rpc.staleDropMs` | number | `12000` | Drop poll answers older than this. |
| `BMC_MON_DATA` | `store.dir` | path | `<repo>/data` | Data directory. Also the default `auth.dataDir`. |
| `BMC_MON_RETENTION_HOURS` | `store.retentionHours` | number | `72` | Chart history retention. |
| `BMC_MON_AUTH` | `auth.enabled` | boolean | `false` | Turn accounts on. |
| `BMC_MON_SECURE_COOKIE` | `auth.secureCookie` | boolean | `false` | `Secure` session cookie. Use it behind a TLS terminator; it is automatic with built-in TLS. |
| `BMC_MON_ADMIN_PASSWORD` | *(none)* | string | *(generated)* | Password for the `admin` account created on first boot when accounts are on and no users exist. It is ignored once any user exists. It is a secret, so do not leave it in a unit file after first boot. |
| `BMC_MON_ENABLE_ACTIONS` | `actions.enabled` | boolean | `false` | Master switch for node writes. |
| `BMC_MON_ACTIONS` | `actions.allow` | list | *(empty)* | Actions to enable, for example `testmempoolaccept,savemempool`. |
| `BMC_MON_ALLOW_WRITES_WITHOUT_AUTH` | `actions.allowWritesWithoutAuth` | boolean | `false` | Permit actions while accounts are off. |
| `BMC_MON_LOG_SOURCE` | `log.enabled` | boolean | `false` | `1` tails node log files; `0` (or unset) runs on RPC alone. |
| `BMC_MON_LOG_LEVEL` | `log.level` | string | `info` | `debug`, `info`, `warn` or `error`. |
| `BMC_MON_MARKETS` | `markets.enabled` | boolean | `true` | `0` turns the Markets feed off. |
| `BMC_MON_MINING` | *(none)* | `0` or anything | on | `0` turns off miner attribution, which decodes each block's coinbase to show the pool tag. Block sizes, fees and weights are unaffected. Only the literal `0` disables it. |
| `BMC_MON_MINING_BACKFILL` | *(none)* | number | `36` | How many recent blocks are attributed to miners at startup. |
| `BMC_MON_MINING_TEMPLATE` | *(none)* | `0` or anything | on | `0` stops the Mining page from requesting `getblocktemplate`, a call that occupies the node's RPC thread for over a second. It is only ever fetched on demand, never on a timer. Only the literal `0` disables it. |
| `BMC_MON_POOL_MAP` | *(none)* | path | `<store.dir>/pool-map.json` | Pool label map to load (see [The data directory](#the-data-directory)). |
| `BMC_MON_FAKE_NODE` | *(none)* | boolean | `false` | Development mode: start a built-in simulated node and monitor **only** that. Every configured node is replaced. Never set this in production. |
| `FAKE_PORT` | *(none)* | number | `18331` | Port of the simulated node, with `BMC_MON_FAKE_NODE`. It is also used by `npm run fake-node`. |
| `FAKE_IBD` | *(none)* | `0` or anything | on | `0` starts the simulated node already synced instead of in initial block download. |
| `FAKE_RATE` | *(none)* | number | `9` | Blocks per second the simulated node catches up while "syncing". |
| `BMC_MON_LEDGER_ENGINE` | *(none)* | `sqlite` or `jsonl` | `sqlite` | Storage engine for the mining ledger module (`node:sqlite` with an append-only-file fallback). The running server does not currently open a ledger, so this has no effect today. |

### Development and tooling variables

These are read only by scripts under `scripts/`, never by the server.

| variable | used by | meaning |
|---|---|---|
| `FAKE_LOG` | `scripts/fake-node.js` (standalone) | Log file the standalone simulated node writes. Default `/tmp/bmcmonitor-fake/bitcoin.main.log`. |
| `BMC_MON_CA_FILE` | `scripts/pool-map.js` | CA certificate used for the optional `--check` against a TLS-serving monitor. Default `/etc/ssl/bmc-local/ca.crt`. |
| `BMC_MON_BASE` | browser and render check scripts | Base URL of the monitor to test. |
| `BMC_MON_CA` | `live-render-check.mjs`, `motion-check.mjs` | CA certificate for a TLS-serving monitor. |
| `BROWSER_CDP` | browser probe scripts | Chrome DevTools Protocol endpoint of the browser to drive. |
| `MOTION_OUT` | `motion-check.mjs` | Output PNG path. |
| `PROBE_ID`, `PROBE_GAP` | canvas probe scripts | Element id to probe, and the gap between samples. |
| `VISION_BASE`, `VISION_MODEL` | `browser-check.mjs` | Optional vision-model endpoint and model name for screenshot review. |

### npm scripts

| command | what it runs |
|---|---|
| `npm start` | `node server/main.js`, with your configuration |
| `npm run dev` | The server with `BMC_MON_CONFIG=none BMC_MON_BIND=127.0.0.1 BMC_MON_PORT=18088 BMC_MON_FAKE_NODE=1`: a self-contained development run on `http://127.0.0.1:18088` against a simulated node |
| `npm run fake-node` | The simulated node on its own |
| `npm run user -- <command>` | Account administration (see [auth](#auth)) |
| `npm test` | The test suite |

---

## Examples

All examples are complete `config/local.json` files. Addresses are documentation
addresses; substitute your own.

### A single node on the same machine

The usual case: the node runs on this machine, and bmcmonitor reads its cookie from
the data directory. The node here keeps its data in `/var/lib/bmc`, with the mainnet
cookie at `/var/lib/bmc/main/.cookie`:

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "bmc mainnet",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/var/lib/bmc",
      "chainHint": "main"
    }
  ]
}
```

The same thing without a file, using only the environment:

```bash
BMC_MON_NODE_URL=http://127.0.0.1:8332 BMC_MON_DATADIR=/var/lib/bmc npm start
```

Without `chainHint`, the monitor tries `<datadir>/.cookie` and then every
subdirectory, so the cookie is usually found anyway. Setting `chainHint` makes the
choice explicit when several chains share one data directory.

### A remote node with a username and password

For a node on another machine, configure `rpcuser`/`rpcpassword` (or `rpcauth`)
and an `rpcallowip` that admits this host in the node's own configuration, then:

```json
{
  "nodes": [
    {
      "id": "remote",
      "label": "bmc on 198.51.100.20",
      "rpcUrl": "http://198.51.100.20:8332",
      "cookieFile": "/nonexistent/.cookie",
      "rpcUser": "monitor",
      "rpcPassword": "a-long-random-secret"
    }
  ]
}
```

The `cookieFile` line is needed because every node must name `datadir` or
`cookieFile` (see [Known quirks](#known-quirks)). Pointing it at a path that does
not exist satisfies that check. The credential lookup then finds no cookie and falls
through to `rpcUser`/`rpcPassword`. Do **not** use `datadir` for this: a missing
`datadir` without `cookieFile` makes the node get skipped at startup.

Plain HTTP JSON-RPC sends the password and every reply in clear text. Across an
untrusted network, reach the node through an SSH tunnel or VPN. For example,
`ssh -N -L 18332:127.0.0.1:8332 user@node-host` with `"rpcUrl": "http://127.0.0.1:18332"`.
Keep the file private with `chmod 600 config/local.json`.

### Two nodes

Listing more than one node turns on the node picker. The second node here is
marked `optional`, so when it is down the monitor reports it at a lower severity and
does not count it against overall health:

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "mainnet",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/var/lib/bmc",
      "chainHint": "main"
    },
    {
      "id": "test",
      "label": "test node",
      "rpcUrl": "http://127.0.0.1:18332",
      "datadir": "/srv/bmc-test/data",
      "chainHint": "main",
      "color": "#4aa3df",
      "optional": true
    }
  ]
}
```

Every RPC limit in [`rpc`](#rpc) applies to each node separately. Two nodes on one
machine are two sets of polling, so avoid monitoring a node that is running a
benchmark.

### Accounts on

```json
{
  "auth": { "enabled": true }
}
```

On first boot the banner prints the generated `admin` password once. To choose it
instead:

```bash
BMC_MON_ADMIN_PASSWORD='choose-a-long-passphrase' npm start
```

Then create personal accounts with `npm run user -- create <name> <role>`. Without
TLS, the startup log warns that the session cookie crosses the network in clear
text. Pair accounts with one of the TLS options below, or with a loopback bind and
an SSH tunnel.

Accounts plus two node writes that operators may run:

```json
{
  "auth": { "enabled": true },
  "actions": {
    "enabled": true,
    "allow": ["testmempoolaccept", "savemempool"]
  }
}
```

### TLS

Built-in HTTPS on every listener:

```json
{
  "server": {
    "tls": {
      "cert": "/etc/bmcmon/cert.pem",
      "key": "/etc/bmcmon/key.pem"
    }
  },
  "auth": { "enabled": true }
}
```

Both files must be readable by the account running bmcmonitor. The certificate
must be valid PEM X.509 and not expired. A self-signed certificate works, but the
browser warns on first visit to each address.

Behind a reverse proxy that terminates TLS (nginx, Caddy, …), serve plain HTTP on
loopback only and let the proxy own the certificate:

```json
{
  "server": {
    "hosts": ["127.0.0.1"],
    "trustProxy": true
  },
  "auth": { "enabled": true, "secureCookie": true }
}
```

Only set `trustProxy` if the proxy overwrites `X-Forwarded-For`. The loopback bind
matters here too: it makes the proxy the only way in.

### Binding to specific addresses

The default `0.0.0.0` listens on every IPv4 interface the machine has, including VPN
tunnels and container bridges. To serve exactly one LAN address and one VPN
address, and admit only clients from those networks:

```json
{
  "server": {
    "hosts": ["192.0.2.10", "2001:db8::10"],
    "port": 8088,
    "allowCidrs": ["192.0.2.0/24", "2001:db8::/32"]
  }
}
```

Things to know about specific binds:

- `127.0.0.1` stops working on the host itself unless you list it. From the host,
  use one of the listed addresses. The startup log names the interfaces left
  unserved.
- An address the machine does not have at startup, such as a tunnel interface that
  comes up later, is **skipped with a warning**. The server fails only when **none**
  of the listed addresses exist. Under systemd, order the unit after the tunnel's
  service if you need that address from the first second.
- Binding picks a destination address, not an ingress interface. Traffic that can
  be routed to a bound address still reaches it. If "LAN only" must be enforced,
  use a firewall or `allowCidrs`.
- For this machine only, use `"hosts": ["127.0.0.1"]` and reach it with
  `ssh -L 8088:127.0.0.1:8088 user@monitor-host`.

### Markets off

No outbound connections except to the node:

```json
{
  "markets": { "enabled": false }
}
```

or `BMC_MON_MARKETS=0`.

### RPC-only mode, and turning the log source on

RPC-only is the **default**: `log.enabled` is `false`, and every node's `logFile` is
ignored. To make it explicit, and to survive a future default change:

```json
{
  "log": { "enabled": false }
}
```

or `BMC_MON_LOG_SOURCE=0`.

To tail the node's log as well, which fills in bandwidth and per-peer figures on
builds whose RPC reports zeros:

```json
{
  "log": { "enabled": true },
  "nodes": [
    {
      "id": "main",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/var/lib/bmc",
      "chainHint": "main",
      "logFile": "/var/lib/bmc/main/debug.log"
    }
  ]
}
```

### Running under systemd

`systemd/bmcmonitor.service` is a template. Edit `User=`, `Group=`,
`WorkingDirectory=` and the path to a Node.js 22+ binary before installing it.

**The shipped unit sets `Environment=` lines for `BMC_MON_PORT`, `BMC_MON_NODE_URL`,
`BMC_MON_DATADIR`, `BMC_MON_LOGFILE` and `BMC_MON_LOG_LEVEL`.** Environment
variables beat `config/local.json`, so those lines override the first node in your
file. Either edit them to match, or delete them and keep everything in
`config/local.json`. To add settings without editing the unit, use a drop-in:

```bash
sudo systemctl edit bmcmonitor
```

```ini
[Service]
Environment=BMC_MON_AUTH=1
Environment=BMC_MON_DATA=/var/lib/bmcmonitor
```

The service account needs read access to the node's cookie file (and log file, if
used), and write access to the data directory.

---

## The data directory

`store.dir` (`BMC_MON_DATA`, default `<repo>/data`) holds runtime state. The server
creates it at startup. The account files live in `auth.dataDir`, which defaults to
the same directory. `<repo>/data/` is in `.gitignore`. Back it up if you care about
accounts and chart history, and never commit or publish it.

| file | written by | secret? | contents |
|---|---|---|---|
| `users.json` | the server (first boot) and `npm run user` | **yes** | Accounts: usernames, roles, scrypt hashes and salts. Mode `0600`. Only in `auth.dataDir`. |
| `sessions.json` | the server | **yes** | Active sessions, stored as token hashes, with creation time, last use, client address and user agent. Mode `0600`. Only in `auth.dataDir`. |
| `audit.jsonl` | the server | sensitive | Append-only log of sign-ins, RPC console calls, actions (allowed and denied) and account changes, with usernames and client addresses. Passwords and RPC credentials are removed before writing. |
| `audit.1.jsonl` … `audit.N.jsonl` | the server | sensitive | Rotated audit files, newest first. There are at most `store.auditKeep` of them, and rotation happens at `store.auditMaxBytes`. |
| `history.json` | the server | no, but reveals node details | Snapshot of chart series, events and recent blocks, restored on startup and pruned to `store.retentionHours`. Can be tens of MB. |
| `pool-aliases.json` | **you**, optionally | no | Hand-written display names for mining pools: a JSON object from pool key to label, for example `{"examplepool": "Example Pool"}`. The pool key is the lowercased coinbase tag the Mining page shows, or `unknown:<hex>` for blocks without a readable tag. Absent by default, in which case the coinbase text is shown as written. |
| `pool-map.json` | `node scripts/pool-map.js` | no | Coinbase-tag-to-pool-name map built from the public mempool/mining-pools data set, with source URL and content hash. Absent until you run the script, which needs network access. The server reads it from `BMC_MON_POOL_MAP` if set, otherwise from `<store.dir>/pool-map.json`. The script always writes `<repo>/data/pool-map.json`, so move it, or set `BMC_MON_POOL_MAP`, if you use a different `store.dir`. `--file <pools-v2.json>` builds it offline. |
| `fake-node.log` | development mode only | no | Log of the simulated node when `BMC_MON_FAKE_NODE=1`. |
| `*.tmp` | the server | as the target file | Short-lived files from atomic writes (write, fsync, rename). A leftover one after a crash is safe to delete. |

Other secrets outside the data directory:

- `config/local.json`, if it contains `rpcPassword`.
- The TLS private key named by `server.tls.key`.
- The node's own cookie file, which bmcmonitor reads but never copies or logs.

The server's own log (stdout, or the journal under systemd) masks credentials that
look like passwords, cookies or URL passwords. The banner line that prints a
generated first-admin password is deliberate and appears once.

---

## Validation: what stops the boot

The configuration is checked once, after merging all three layers. Every problem
found is reported together, and the process exits with:

```
Error: Invalid configuration:
  - <problem>
  - <problem>
```

| mistake | message |
|---|---|
| The configuration file is not valid JSON | `config: cannot parse <file>: <parser message>` (reported on its own, before any other check) |
| `nodes` is empty or not an array | `nodes must be non-empty` |
| Port missing, not an integer, or out of range (including a non-numeric `BMC_MON_PORT`) | `server.port invalid` |
| Empty host list | `server.hosts is empty; nothing would be served` |
| A hostname in the host list | `server.hosts entry "<name>" is not an address literal; use an IPv4/IPv6 address, 0.0.0.0, or localhost` |
| None of the listed addresses exists on this machine | `none of the configured bind addresses (<list>) exist on this machine; refusing to start with nothing to serve` |
| `rpc.maxInFlight` below 1 | `rpc.maxInFlight must be >= 1` |
| `poll.fastMs` below 1000 | `poll.fastMs below 1s risks hammering a single-threaded RPC server` |
| An unparseable `allowCidrs` entry | `server.allowCidrs entry "<entry>" is unusable: <reason>`. The reason is, for example, `"<x>" is not an IPv4 or IPv6 address` or `/33 is wider than an ipv4 address (32 bits)` |
| Only one of `tls.cert` / `tls.key` set | `server.tls needs BOTH cert and key (got cert only)` (or `key only`) `; a half-configured TLS would fall back to plaintext on a port you believe is HTTPS` |
| A TLS file cannot be read | `server.tls.cert cannot be read (<path>: <error code>)`, and likewise for `key` |
| The certificate is not X.509 PEM | `server.tls.cert is not a parseable X.509 certificate: <details>` |
| The certificate has no usable validity dates | `server.tls.cert has no parseable validity window` |
| The certificate has expired | `server.tls.cert expired <date>; the browser will refuse the connection, and the dashboard cannot tell you so from behind that refusal` |
| Actions enabled while accounts are off, without the explicit override | `node actions are enabled while accounts are OFF, which would let any address that can reach the port call them (there is no role to check). Either set BMC_MON_AUTH=1, or set BMC_MON_ALLOW_WRITES_WITHOUT_AUTH=1 deliberately alongside BMC_MON_ACTIONS.` |
| `store.blockMapCap` not an integer of at least 100 | `store.blockMapCap must be an integer >= 100; …` |
| `store.auditMaxBytes` below 65536 | `store.auditMaxBytes must be >= 65536; below that the audit rotates on every write` |
| A node's `rpcUrl` missing or not `http(s)://` | `node <id>: rpcUrl must be http(s)://host:port` |
| A node with neither `datadir` nor `cookieFile` | `node <id>: need datadir or cookieFile for cookie auth` |

Failures after validation, while the server starts:

| situation | what happens |
|---|---|
| A listed address is taken, or the port is privileged | Exit 1. The log explains the cause: already in use (probably a second instance), permission denied (ports below 1024), or no such address, and lists the addresses the machine has. |
| `BMC_MON_ADMIN_PASSWORD` fails the password rules on first boot | The boot throws with the rule it broke, for example `password must be at least 12 characters` or `password must not contain the username`. |
| `BMC_MON_FAKE_NODE=1` and the simulated node cannot start (for example, `FAKE_PORT` in use) | `dev mode needs a local fake node: <error>` |

Reported but **not** fatal:

- A listed bind address that the machine does not currently have is skipped with a
  warning, as long as at least one address works.
- A certificate expiring within 14 days produces a warning at startup.
- A node whose `datadir` does not exist (and has no `cookieFile`) is skipped.
- Accounts off: a warning names the addresses that anyone can read.
- Accounts on without TLS: a warning that the session cookie travels in clear text.
- A node `logFile` while the log source is off: an info line says it is ignored.
- A node that cannot be reached or authenticated is **not** a configuration error.
  The server starts, shows the node as offline, and keeps retrying. An
  authentication failure is reported as `RPC 401 and no credential found (checked
  cookie paths)` or `RPC authentication failed (cookie rejected)`.

---

## Known quirks

These are current behaviours of the code that a configuration author should know
about.

- **`rpcUser`/`rpcPassword` alone fail validation.** Every node must name `datadir`
  or `cookieFile`. For a password-only node, set `cookieFile` to a path that does not
  exist, as in [the remote node example](#a-remote-node-with-a-username-and-password).
- **`server.hosts` in the file beats `BMC_MON_BIND`/`BMC_MON_HOST`.** The
  environment variables set `server.host`, but a `server.hosts` array takes
  precedence over `server.host`. If your file uses `hosts`, change the bind there,
  or run with `BMC_MON_CONFIG=none`.
- **Node environment variables change only `nodes[0]`.** With several nodes in the
  file, `BMC_MON_NODE_URL` and friends rewrite the first one and leave the rest
  alone. The shipped systemd unit sets several of them.
- **`auth.loginMaxAttempts` and `auth.loginWindowMs` are not read.** The login guard
  takes its limits from keys named `maxAttempts` and `windowMs` and otherwise falls
  back to 8 attempts per 5 minutes. Those are the same numbers as the documented
  defaults, so nothing changes unless you try to change them. `auth.lockoutMs` is
  read.
- **`actions.requireAdmin` is not consulted.** Each action's minimum role is fixed in
  code (see [actions](#actions)).
- **`systemdUnit` is informational.** The server does not query or control systemd.
- **A missing `BMC_MON_CONFIG` file is silent.** A path that does not exist gives you
  the defaults without an error.
