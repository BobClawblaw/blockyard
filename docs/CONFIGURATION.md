# Configuration reference

This is the complete reference for configuring BlockYard: every configuration
key, every environment variable, what lives in the data directory, and which
mistakes stop the server from starting.

BlockYard needs no configuration file to start. The built-in defaults describe
a stock local Bitcoin Core node, though, so most deployments want at least a
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

1. **Environment variables** (`BLOCKYARD_*`, see [the table](#environment-variables)).
2. **The configuration file**: `config/local.json` in the repository root, or the
   file named by `BLOCKYARD_CONFIG`.
3. **Built-in defaults** (`DEFAULTS` in `server/config.js`).

Merge rules:

- **Objects are merged key by key.** `{"server": {"port": 9000}}` changes the port
  and keeps every other `server` key at its default.
- **Arrays replace the default wholesale.** This matters for `nodes`. As soon as your
  file has a `nodes` array, the built-in node entry is gone and none of its fields
  are inherited. Every node you list must be complete on its own.
- **Unknown keys are ignored silently.** No schema check runs, so a misspelled key
  such as `"allowCIDRs"` has no effect and produces no error.

`BLOCKYARD_CONFIG` controls which file is read:

| value | effect |
|---|---|
| unset or empty | read `<repo>/config/local.json` if it exists |
| a path | read that file instead |
| `none`, `off`, `no` or `-` (any case) | read no file; defaults plus environment only |

A path that does not exist, or is not a regular file (for example `/dev/null`),
counts as "no file". **It is not an error**, so a typo in the path quietly gives you
the defaults. A file that exists but is not valid JSON stops the boot (see
[Validation](#validation-what-stops-the-boot)).

`npm run dev` sets `BLOCKYARD_CONFIG=none`, so a development run never picks up the
machine's real configuration.

## Creating config/local.json

```bash
cd /path/to/blockyard
mkdir -p config
$EDITOR config/local.json      # see the examples below
chmod 600 config/local.json    # if it contains rpcPassword or other secrets
npm start
```

`config/local.json` is listed in `.gitignore`. Machine-specific facts (addresses,
paths, credentials) belong there and never in a committed file.

The file is read once at startup. Restart the server after editing it.

Two things write into `config/` while the server runs, both from the web UI: the **Node
connection** form on Node & RPC saves `nodes[0]` back into this file (`POST /api/config/node`;
a restart applies it), and **Display settings** are kept in `config/blockyard.json` beside it
(`POST /api/settings`; it holds no secrets and is also in `.gitignore`). Both are written mode
`0600` by temporary file, fsync and rename, and with accounts on both need the admin role. The
service account therefore needs write access to `config/` if either is to be saved from the UI.

---

## Configuration keys

Durations are in milliseconds unless the name says otherwise (`retentionHours`).

### server

| key | default | meaning |
|---|---|---|
| `server.host` | `"0.0.0.0"` | Address to listen on. Kept for compatibility; `server.hosts` wins when both are set. |
| `server.hosts` | *(unset; falls back to `host`)* | Addresses to listen on: an array (`["192.0.2.10", "2001:db8::10"]`), or a single string with commas (`"192.0.2.10,198.51.100.7"`). One HTTP server is started per address, and all of them share sessions, rate limits and monitors. Entries must be address literals: IPv4, IPv6, `0.0.0.0`, `::`, or `localhost`. Hostnames are refused. See [Binding](#binding-to-specific-addresses). |
| `server.port` | `21000` | TCP port. It is the same port on every address. It must be an integer from 1 to 65535. |
| `server.allowCidrs` | `[]` | Client allowlist. Empty means every client that can reach the port is admitted. Otherwise only addresses inside one of the networks connect, and everyone else gets HTTP 403 (the reason goes to the server log). Entries are CIDRs or bare addresses (a bare address means `/32` or `/128`), IPv4 or IPv6, compared bit by bit. An entry that cannot be parsed stops the boot. |
| `server.trustProxy` | `false` | When `true`, the client address is the **first** entry of the `X-Forwarded-For` header instead of the socket's peer address. That address feeds the CIDR allowlist, the rate limits and the audit log. Turn it on only when a reverse proxy you control is the sole way in and it sets that header. Otherwise any client can pick its own address and walk past `allowCidrs`. |
| `server.tls.cert` | `null` | Path to a PEM certificate. TLS is on only when `cert` and `key` are both set, and then every listener serves HTTPS. |
| `server.tls.key` | `null` | Path to the PEM private key for `cert`. This file is secret. |
| `server.tls.hstsMs` | `172800000` (2 days) | `max-age` of the `Strict-Transport-Security` header. It is sent on TLS responses only. `0` turns it off. `includeSubDomains` and `preload` are never sent. |

When TLS is on, `auth.secureCookie` is forced to `true`. At startup the server logs
the certificate's SHA-256 fingerprint and whether it is self-signed. It also warns
when the certificate expires within 14 days.

### nodes

`nodes` is an array with one object per Bitcoin Core node to monitor. It must not
be empty. If you list more than one node, the web UI shows a node picker, and every
node gets its own charts and event stream.

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
| `addressIndex` | none | Directory of the address index, built from this node's own block files (`<datadir>/blocks`). With it, the explorer's address page shows history, balance, unspent outputs and per-transaction amounts; without it, Core cannot answer those and the page says so. If the directory holds no finished index (no `manifest.json`) when the server starts, **the server builds one in the background** (see the next two keys). One index serves every node on the same chain. The server keeps it current as blocks arrive (a follower per directory writes `live.log` and `layers/` inside it, so the directory must be writable by the service); the page says if it is behind or has stopped following. See `docs/MEASUREMENTS.md` §30. |
| `addressIndexBuild` | *(unset)* | `"manual"` keeps the server from building a missing address index on start. Otherwise a missing index is built inside the server on worker threads while every page keeps serving: the progress is the `address-index-building` quality flag on the Overview (phase, done of total, rows, time left, and whether it is paused), an event of kind `index` marks the start, the finish and a failure (the browser shows each as a notification), the follower starts the moment the build finishes so address pages go live with no restart, and a failure raises `address-index-build-failed` with the command to run by hand. The build is paced by the node's own RPC: it holds while the node is failing, its breaker is open or its average latency is above `rpc.slowLatencyMs`, and eases off above 40% of it. A build interrupted by a stop does not resume; the next start begins it again. `npm run setup --build-later` writes this key. |
| `addressIndexWorkers` | half of a dedicated build's count, at most 4 | Worker threads for the background build. A dedicated build (`scripts/index-build.js`) uses `cpus − 4`, one per ~2.5 GB of memory, at most 16; the server takes half of that, at most 4, because the node shares the disk. **Use 1 on a spinning disk**: parallel readers seek against each other and against the node. The installer writes the number you give it. |
| `optional` | `false` | Marks a node whose absence is expected, such as a test or benchmark node. Its failures are logged at a lower severity, a missing datadir is reported at `info` instead of `warn`, and it does not count as a required node in `/api/health`. |
| `color` | `"#f7931a"` | Accent colour for this node in the UI. |
| `systemdUnit` | *(see defaults)* | Name of the node's systemd unit. It is informational and not currently used by the server. |

**Credentials.** A node needs **either** a cookie path (`datadir`, optionally with `chainHint`,
or an explicit `cookieFile`) **or** `rpcUser` + `rpcPassword`. Cookie auth is the usual case on the
same machine; user/password is for a node that authenticates with `rpcauth` rather than the cookie
file. (BlockYard runs on the node's machine; see INSTALL, "It runs on the node's machine".) A
node with neither is
refused at boot, and `rpcUser` without `rpcPassword` is refused too, rather than sending
`Basic dXNlcjo=` and failing with a confusing 401.
Before every connection that lacks a credential, and again after any HTTP 401, the
client looks for a credential in this order and uses the first one found:

1. `cookieFile`
2. `<datadir>/<chainHint>/.cookie`
3. `<datadir>/.cookie`
4. `<datadir>/<every subdirectory>/.cookie`
5. `rpcUser` / `rpcPassword`

A cookie file that can be read always wins over `rpcUser`. The node rewrites its
cookie on every restart, and the monitor picks up the new one automatically. The
account running BlockYard needs read access to the cookie file, and to `logFile` if
you use one.

**Skipped nodes.** A node that has `datadir`, has no `cookieFile`, and whose
`datadir` does not exist at startup is **skipped** with a log line. The server does
not stop. This lets a node whose directory has been removed disappear cleanly
instead of showing as permanently offline.

**Built-in default node.** Without a `nodes` array in your file, one node is
configured. It is Bitcoin Core's own mainnet layout: RPC on the standard port
8332, with the data directory of a `bitcoin` service account:

| field | built-in value |
|---|---|
| `id` | `main` |
| `label` | `Bitcoin Core (mainnet)` |
| `rpcUrl` | `http://127.0.0.1:8332` |
| `datadir` | `/home/bitcoin/.bitcoin` |
| `chainHint` | `main` |
| `logFile` | `/home/bitcoin/.bitcoin/debug.log` |
| `systemdUnit` | `bitcoind.service` |
| `color` | `#f7931a` |

If your node lives elsewhere, override it with a `nodes` array in
`config/local.json`, or for the first node only, with `BLOCKYARD_NODE_URL`,
`BLOCKYARD_DATADIR`, `BLOCKYARD_COOKIE`, `BLOCKYARD_LOGFILE` and `BLOCKYARD_NODE_LABEL`.
A node built from source or run by a distribution package may keep its data directory
somewhere else, and a node with an `rpcport=` line of its own is not on 8332 at all: a
non-default RPC port is the most common reason this monitor reports a healthy node
as offline, so check the node's own `rpcport`.

**The label follows the node.** If you set `BLOCKYARD_NODE_URL` to an address other
than the one the node was already configured for, and do not also set
`BLOCKYARD_NODE_LABEL`, the first node is renamed to `node @ host:port` rather than
keeping the built-in name, which would now describe a different node. Restating the
address it already had redirects nothing, so in that case the built-in name stands.
Give it a name of your own with `BLOCKYARD_NODE_LABEL`, or with `label` in a `nodes`
entry; either one wins over both.

### rpc

The node's RPC server handles one connection at a time on a single thread.
BlockYard therefore sends requests one at a time, in priority order, and these
limits protect the node from the monitor. They apply to each node separately.

| key | default | meaning |
|---|---|---|
| `rpc.maxInFlight` | `1` | Requests outstanding at once. **Currently advisory:** the lane is serialised by construction and does not read this value (measured 2026-09-13 at 1, 4 and 8 -- peak concurrency was 1 in every case). It must still be at least 1. |
| `rpc.minIntervalMs` | `250` | Minimum gap between the start of one request and the next. |
| `rpc.maxRatePerSec` | `4` | Hard ceiling on requests per second, whatever the poll tiers ask for. |
| `rpc.timeoutMs` | `90000` | Timeout for ordinary calls. It is deliberately generous, because a busy but healthy node can take tens of seconds to answer. |
| `rpc.heavyTimeoutMs` | `300000` | Timeout for calls that are known to be expensive (UTXO-set statistics and similar). |
| `rpc.staleDropMs` | `12000` | A poll answer that arrives later than this after it was requested is thrown away, not shown as current state. |
| `rpc.slowLatencyMs` | `5000` | Above this average latency, the UI says the node is slow instead of implying the monitor is broken. The background address index build holds above it and eases off above 40% of it (see `addressIndexBuild` under [nodes](#nodes)). |
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
| `store.dir` | `<repo>/data` | Data directory for history snapshots, the audit log and the mining label files (`pool-aliases.json`, and a `pool-map.json` that overrides the shipped `config/pool-map.json`). It is created if missing. See [The data directory](#the-data-directory). |
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
| `auth.sessionTtlMs` | `259200000` (72 h) | Absolute session lifetime, counted from sign-in. |
| `auth.idleTtlMs` | `28800000` (8 h) | A session unused for this long expires. Until 2026-09-13 the two defaults were the other way round, so the idle check could never fire and a session was 8 h whatever you did. |
| `auth.scrypt.N` | `16384` | scrypt cost parameter for password hashes. |
| `auth.scrypt.r` | `8` | scrypt block size. |
| `auth.scrypt.p` | `1` | scrypt parallelism. |
| `auth.scrypt.keylen` | `32` | Derived key length in bytes. |
| `auth.minPasswordChars` | `12` | Minimum password length. Passwords are also refused if they contain the username, begin with a common breached password (`password`, `admin`, `qwerty`, `bitcoin`, …), or are one character repeated. |
| `auth.loginMaxAttempts` | `8` | Intended: failed logins per username before lockout. See [Known quirks](#known-quirks); the effective value is 8 whatever you set. |
| `auth.loginWindowMs` | `300000` (5 min) | Intended: window in which failed attempts are counted. See [Known quirks](#known-quirks); the effective value is 5 minutes. |
| `auth.lockoutMs` | `600000` (10 min) | How long a username stays locked after too many failures. |
| `auth.cookieName` | `"blockyard_sid"` | Name of the session cookie. |
| `auth.secureCookie` | `false` | Mark the session cookie `Secure`. Forced to `true` when `server.tls` is on. Set it yourself only when a TLS-terminating reverse proxy sits in front, because browsers never send a `Secure` cookie over plain HTTP. |

Separately from these settings, login requests are rate-limited per client address
(a burst of 10, then one attempt every 2 seconds). All API requests are
rate-limited too.

**The first admin account.** When accounts are on and `users.json` holds no users, the
server creates a user named `admin` at startup:

- If `BLOCKYARD_ADMIN_PASSWORD` is set, that is the password. It must pass the
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

Actions are the only node **writes** BlockYard can make. Everything is off by
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
| `log.enabled` | `false` | Tail each node's `logFile` as an extra data source. **Off by default, and there is currently no log format this parses for Bitcoin Core** -- see the note below. With it off, figures only a log could provide are shown as unavailable rather than as zero. |
| `log.tailBytes` | `2097152` (2 MiB) | Size of the read-back window the log tail uses. |
| `log.staleMs` | `1800000` (30 min) | How long a tailed log may go without a single new byte before the monitor reports it as silent. A synced, idle node can legitimately stay quiet for about 20 minutes. Override per node with `logStaleMs`. |
| `log.healthMs` | `30000` | How often that check runs. It costs no RPC. |

### markets

The Markets tab fetches public BTC/USD prices, hourly candles and order books from
five exchanges over HTTPS: Coinbase, Kraken, Bitstamp, Bitfinex and OKX (OKX quotes
BTC/USDT). The fetches run on the server, not in the browser. This is BlockYard's
only outbound connection other than the node, and **polling is off by default**: a fresh
install makes no request to anyone but the node until someone ticks **Display settings → Markets & Price → Enable market polling** in the browser (a Display
setting, stored in `config/blockyard.json` and shared by every screen; no restart).
Exchanges then see this server's IP address and a User-Agent, nothing about the node. Polling starts when a browser asks for market data
-- the Markets and Kiosk tabs, and Overview's price line (Display settings → Markets &
Price → Price line on Overview) -- and stops `idleAfterMs` after the last request, so an
unwatched monitor makes no exchange traffic. With that line switched off, only Markets
and Kiosk start it. The exchange list is fixed in code.

| key | default | meaning |
|---|---|---|
| `markets.enabled` | `true` | `false` removes the feed entirely: no request is ever made, Markets and Kiosk say so, and the **Enable market polling** checkbox cannot turn it on. |
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
  `BLOCKYARD_PORT` is range-checked, so check spelling.
- **Lists**: comma-separated, with spaces around entries trimmed.
- **Node variables** (`BLOCKYARD_NODE_URL`, `BLOCKYARD_DATADIR`, `BLOCKYARD_COOKIE`,
  `BLOCKYARD_LOGFILE`, `BLOCKYARD_UNIT`, `BLOCKYARD_NODE_LABEL`) change **only the first
  entry** of `nodes`, whether that entry comes from the defaults or from your file.

### Server variables

| variable | sets | type | default | meaning |
|---|---|---|---|---|
| `BLOCKYARD_CONFIG` | *(which file is read)* | path or `none` | `<repo>/config/local.json` | Configuration file to read. `none`/`off`/`no`/`-` reads no file. |
| `BLOCKYARD_BIND` | `server.host` | list | `0.0.0.0` | Listen address(es), for example `127.0.0.1` or `192.0.2.10,2001:db8::10`. If both are set, this wins over `BLOCKYARD_HOST`. Ignored when the file sets `server.hosts` (see [Known quirks](#known-quirks)). |
| `BLOCKYARD_HOST` | `server.host` | list | `0.0.0.0` | Same as `BLOCKYARD_BIND`. |
| `BLOCKYARD_PORT` | `server.port` | number | `21000` | Listen port. |
| `BLOCKYARD_ALLOW_CIDRS` | `server.allowCidrs` | list | *(empty: everyone)* | Client allowlist, for example `192.0.2.0/24,2001:db8::/32`. |
| `BLOCKYARD_TRUST_PROXY` | `server.trustProxy` | boolean | `false` | Take the client address from `X-Forwarded-For`. |
| `BLOCKYARD_TLS_CERT` | `server.tls.cert` | path | unset | PEM certificate. Set it together with `BLOCKYARD_TLS_KEY`. |
| `BLOCKYARD_TLS_KEY` | `server.tls.key` | path | unset | PEM private key. Set it together with `BLOCKYARD_TLS_CERT`. |
| `BLOCKYARD_NODE_URL` | `nodes[0].rpcUrl` | URL | `http://127.0.0.1:8332` | RPC endpoint of the first node. |
| `BLOCKYARD_DATADIR` | `nodes[0].datadir` | path | `/home/bitcoin/.bitcoin` | Data directory of the first node. It also **clears** `nodes[0].cookieFile`, so the cookie is looked up under the new datadir. |
| `BLOCKYARD_COOKIE` | `nodes[0].cookieFile` | path | unset | Explicit cookie file for the first node. It is applied after `BLOCKYARD_DATADIR`, so it wins. |
| `BLOCKYARD_LOGFILE` | `nodes[0].logFile` | path | see [defaults](#nodes) | Log file of the first node. Used only when the log source is on -- which is not supported for Bitcoin Core; see [RPC-only mode](#rpc-only-mode-and-the-log-source). |
| `BLOCKYARD_UNIT` | `nodes[0].systemdUnit` | string | `bitcoind.service` | systemd unit name of the first node. Informational only. |
| `BLOCKYARD_NODE_LABEL` | `nodes[0].label` | string | `Bitcoin Core (mainnet)` | Display name of the first node, shown in the header. Setting `BLOCKYARD_NODE_URL` to a *different* address without this renames the node to `node @ host:port`, so a redirected instance cannot keep a built-in name that would describe the wrong node. Restating the address the node already had renames nothing. |
| `BLOCKYARD_RPC_TIMEOUT` | `rpc.timeoutMs` | number | `90000` | RPC timeout for ordinary calls. |
| `BLOCKYARD_RPC_MIN_INTERVAL` | `rpc.minIntervalMs` | number | `250` | Minimum gap between RPC requests. |
| `BLOCKYARD_RPC_STALE_DROP` | `rpc.staleDropMs` | number | `12000` | Drop poll answers older than this. |
| `BLOCKYARD_DATA` | `store.dir` | path | `<repo>/data` | Data directory. Also the default `auth.dataDir`. |
| `BLOCKYARD_RETENTION_HOURS` | `store.retentionHours` | number | `72` | Chart history retention. |
| `BLOCKYARD_AUTH` | `auth.enabled` | boolean | `false` | Turn accounts on. |
| `BLOCKYARD_SECURE_COOKIE` | `auth.secureCookie` | boolean | `false` | `Secure` session cookie. Use it behind a TLS terminator; it is automatic with built-in TLS. |
| `BLOCKYARD_ADMIN_PASSWORD` | *(none)* | string | *(generated)* | Password for the `admin` account created on first boot when accounts are on and no users exist. It is ignored once any user exists. It is a secret, so do not leave it in a unit file after first boot. |
| `BLOCKYARD_ENABLE_ACTIONS` | `actions.enabled` | boolean | `false` | Master switch for node writes. |
| `BLOCKYARD_ACTIONS` | `actions.allow` | list | *(empty)* | Actions to enable, for example `testmempoolaccept,savemempool`. |
| `BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH` | `actions.allowWritesWithoutAuth` | boolean | `false` | Permit actions while accounts are off. |
| `BLOCKYARD_LOG_SOURCE` | `log.enabled` | boolean | `false` | `1` tails node log files; `0` (or unset) runs on RPC alone. |
| `BLOCKYARD_LOG_LEVEL` | `log.level` | string | `info` | `debug`, `info`, `warn` or `error`. |
| `BLOCKYARD_MARKETS` | `markets.enabled` | boolean | `true` | `0` removes the Markets feed; the polling checkbox then cannot turn it on. |
| `BLOCKYARD_MINING` | *(none)* | `0` or anything | on | `0` turns off miner attribution, which decodes each block's coinbase to show the pool tag. Block sizes, fees and weights are unaffected. Only the literal `0` disables it. |
| `BLOCKYARD_MINING_BACKFILL` | *(none)* | number | `36` | How many recent blocks are attributed to miners at startup. |
| `BLOCKYARD_MINING_TEMPLATE` | *(none)* | `0` or anything | on | `0` turns off the "block being built" card. Since 2026-09-13 the template is **assembled from the mempool this monitor already reads**, so leaving it on costs your node no RPC call at all — it costs this process ~50-70 ms of CPU per assembly. Before that it was a `getblocktemplate` worth over a second of the node's single RPC thread, which is why the switch exists. Only the literal `0` disables it. |
| `BLOCKYARD_POOL_MAP` | *(none)* | path | `<store.dir>/pool-map.json` if it exists, else `<repo>/config/pool-map.json` | Pool label map to load. It overrides both the shipped map and the one in the data directory (see [The data directory](#the-data-directory)). |
| `BLOCKYARD_FAKE_NODE` | *(none)* | boolean | `false` | Development mode: start a built-in simulated node and monitor **only** that. Every configured node is replaced. Never set this in production. |
| `FAKE_PORT` | *(none)* | number | `18331` | Port of the simulated node, with `BLOCKYARD_FAKE_NODE`. It is also used by `npm run fake-node`. |
| `FAKE_IBD` | *(none)* | `0` or anything | on | `0` starts the simulated node already synced instead of in initial block download. |
| `FAKE_RATE` | *(none)* | number | `9` | Blocks per second the simulated node catches up while "syncing". |
| `BLOCKYARD_LEDGER_ENGINE` | *(none)* | `sqlite` or `jsonl` | `sqlite` | Storage engine for the mining ledger module (`node:sqlite` with an append-only-file fallback). The running server does not currently open a ledger, so this has no effect today. |

### Development and tooling variables

These are read only by scripts under `scripts/`, never by the server.

| variable | used by | meaning |
|---|---|---|
| `FAKE_LOG` | `scripts/fake-node.js` (standalone) | Log file the standalone simulated node writes. Default `/tmp/blockyard-fake/bitcoin.main.log`. |
| `BLOCKYARD_SMOKE_PORT`, `BLOCKYARD_SMOKE_FAKE` | `scripts/smoke.sh` | Ports for the smoke run's monitor (default `18099`) and its simulated node (default `18461`). |
| `BLOCKYARD_CA_FILE` | `scripts/pool-map.js` | CA certificate used for the optional `--check` against a TLS-serving monitor. It has a built-in default path; see `scripts/pool-map.js`. |
| `BLOCKYARD_BASE` | browser and render check scripts | Base URL of the monitor to test. |
| `BLOCKYARD_CA` | `live-render-check.mjs`, `motion-check.mjs` | CA certificate for a TLS-serving monitor. |
| `BROWSER_CDP` | browser probe scripts | Chrome DevTools Protocol endpoint of the browser to drive. |
| `MOTION_OUT` | `motion-check.mjs` | Output PNG path. |
| `PROBE_ID`, `PROBE_GAP` | canvas probe scripts | Element id to probe, and the gap between samples. |
| `VISION_BASE`, `VISION_MODEL` | `browser-check.mjs` | Optional vision-model endpoint and model name for screenshot review. |

### npm scripts

| command | what it runs |
|---|---|
| `npm start` | `node server/main.js`, with your configuration |
| `npm run dev` | The server with `BLOCKYARD_CONFIG=none BLOCKYARD_BIND=127.0.0.1 BLOCKYARD_PORT=18088 BLOCKYARD_FAKE_NODE=1`: a self-contained development run on `http://127.0.0.1:18088` against a simulated node |
| `npm run fake-node` | The simulated node on its own |
| `npm run user -- <command>` | Account administration (see [auth](#auth)) |
| `npm run setup` | The installer (`scripts/setup.js`): reads the node's `bitcoin.conf` for the chain, RPC port and credentials, checks the node, writes `config/local.json`, and either builds the address index or leaves it to the server's first start (`--build-later` writes `addressIndexBuild: "manual"`; `--workers N` is written as `addressIndexWorkers`) |
| `npm run check` | The same checks against every configured node (`scripts/check.js`), each RPC call timed; exit 1 on a failure |
| `npm test` | The test suite |

---

## Examples

All examples are complete `config/local.json` files. Addresses are documentation
addresses; substitute your own.

### A single node on the same machine

The usual case: the node runs on this machine, and BlockYard reads its cookie from
the data directory. The node here keeps its data in `/var/lib/bitcoind`, with the
mainnet cookie at `/var/lib/bitcoind/main/.cookie`:

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "mainnet",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/var/lib/bitcoind",
      "chainHint": "main"
    }
  ]
}
```

The same thing without a file, using only the environment:

```bash
BLOCKYARD_NODE_URL=http://127.0.0.1:8332 BLOCKYARD_DATADIR=/var/lib/bitcoind npm start
```

Without `chainHint`, the monitor tries `<datadir>/.cookie` and then every
subdirectory, so the cookie is usually found anyway. Setting `chainHint` makes the
choice explicit when several chains share one data directory.

### A node with a username and password (`rpcauth`)

For a node that authenticates with `rpcuser`/`rpcpassword` or `rpcauth` instead of the cookie
file:

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "My node",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/home/you/.bitcoin",
      "rpcUser": "monitor",
      "rpcPassword": "a-long-random-secret"
    }
  ]
}
```

Keep `datadir`: the explorer's address index is built from the block files under it, and the
credential lookup only falls through to `rpcUser`/`rpcPassword` when no cookie is readable there.
The RPC connection stays on this machine (`127.0.0.1`), so the password never crosses a network.

### The address index

What `npm run setup` writes for a node whose address index the server should build on its first
start, with two worker threads (a spinning disk would want one):

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "mainnet",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/var/lib/bitcoind",
      "chainHint": "main",
      "addressIndex": "/var/lib/blockyard/index",
      "addressIndexWorkers": 2
    }
  ]
}
```

Add `"addressIndexBuild": "manual"` to build it yourself instead:
`node scripts/index-build.js --out /var/lib/blockyard/index --workers 16`, then restart. The
directory must be writable by the service account either way, because the follower writes into it.

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
      "datadir": "/var/lib/bitcoind",
      "chainHint": "main"
    },
    {
      "id": "test",
      "label": "test node",
      "rpcUrl": "http://127.0.0.1:18332",
      "datadir": "/srv/bitcoind-test/data",
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
BLOCKYARD_ADMIN_PASSWORD='choose-a-long-passphrase' npm start
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
      "cert": "/etc/blockyard/cert.pem",
      "key": "/etc/blockyard/key.pem"
    }
  },
  "auth": { "enabled": true }
}
```

Both files must be readable by the account running blockyard. The certificate
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
    "port": 21000,
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
  `ssh -L 21000:127.0.0.1:21000 user@monitor-host`.

### Markets off, for good

Out of the box there are no outbound connections except to the node, because market polling is
a checkbox that ships unticked (**Display settings → Markets & Price → Enable market polling**). To be certain a machine never reaches out whatever anyone
ticks, remove the feed from the server:

```json
{
  "markets": { "enabled": false }
}
```

or `BLOCKYARD_MARKETS=0`.

### RPC-only mode, and the log source

RPC-only is the **default and the supported mode**: `log.enabled` is `false`, and every
node's `logFile` is ignored. To make it explicit, and to survive a future default change:

```json
{
  "log": { "enabled": false }
}
```

or `BLOCKYARD_LOG_SOURCE=0`.

> **Log parsing does not currently support Bitcoin Core.** The parsers were written and
> measured against an experimental node implementation with a different log grammar, and
> that is the only format they have been tested against. Measured 2026-09-13 against real
> Core `debug.log` lines: every line comes back as an unstructured `raw` event with **no
> figures extracted**, and the timestamp falls back to the time of reading rather than the
> time in the line -- so enabling it against Core adds nothing and misdates the event feed.
>
> Nothing in the UI depends on it: every panel reads RPC. Support for Core's log format
> would mean new parser rules and Core fixtures, not a configuration change.

### Running under systemd

`systemd/blockyard.service` is a template. Edit `User=`, `Group=`,
`WorkingDirectory=` and the path to a Node.js 22+ binary before installing it.

**The shipped unit sets `Environment=` lines for `BLOCKYARD_PORT`, `BLOCKYARD_NODE_URL`,
`BLOCKYARD_DATADIR`, `BLOCKYARD_LOGFILE` and `BLOCKYARD_LOG_LEVEL`.** Environment
variables beat `config/local.json`, so those lines override the first node in your
file. Either edit them to match, or delete them and keep everything in
`config/local.json`. To add settings without editing the unit, use a drop-in:

```bash
sudo systemctl edit blockyard
```

```ini
[Service]
Environment=BLOCKYARD_AUTH=1
Environment=BLOCKYARD_DATA=/var/lib/blockyard
```

The service account needs read access to the node's cookie file (and log file, if
used), write access to the data directory, and write access to `config/` if the Node
connection form or Display settings are to be saved from the web UI.

---

## The data directory

`store.dir` (`BLOCKYARD_DATA`, default `<repo>/data`) holds runtime state. The server
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
| `pool-map.json` | `node scripts/pool-map.js` | no | Coinbase-tag-to-pool-name map built from the public mempool/mining-pools data set (MIT), with source URL and content hash. **A copy ships in `config/pool-map.json`** (151 pools), so pools are labelled from the first start; one here, written by the script (which needs network access), **overrides** the shipped copy. The server reads `BLOCKYARD_POOL_MAP` if set, else `<store.dir>/pool-map.json` if it exists, else the shipped file. The script always writes `<repo>/data/pool-map.json`, so move it, or set `BLOCKYARD_POOL_MAP`, if you use a different `store.dir`. `--file <pools-v2.json>` builds it offline. |
| `fake-node.log` | development mode only | no | Log of the simulated node when `BLOCKYARD_FAKE_NODE=1`. |
| `*.tmp` | the server | as the target file | Short-lived files from atomic writes (write, fsync, rename). A leftover one after a crash is safe to delete. |

Other secrets outside the data directory:

- `config/local.json`, if it contains `rpcPassword`.
- The TLS private key named by `server.tls.key`.
- The node's own cookie file, which BlockYard reads but never copies or logs.

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
| Port missing, not an integer, or out of range (including a non-numeric `BLOCKYARD_PORT`) | `server.port invalid` |
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
| Actions enabled while accounts are off, without the explicit override | `node actions are enabled while accounts are OFF, which would let any address that can reach the port call them (there is no role to check). Either set BLOCKYARD_AUTH=1, or set BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1 deliberately alongside BLOCKYARD_ACTIONS.` |
| `store.blockMapCap` not an integer of at least 100 | `store.blockMapCap must be an integer >= 100; …` |
| `store.auditMaxBytes` below 65536 | `store.auditMaxBytes must be >= 65536; below that the audit rotates on every write` |
| A node's `rpcUrl` missing or not `http(s)://` | `node <id>: rpcUrl must be http(s)://host:port` |
| A node with neither a cookie path (`datadir` / `cookieFile`) nor `rpcUser` + `rpcPassword` | `node <id>: needs either datadir/cookieFile (cookie auth, same machine) or rpcUser + rpcPassword (a node authenticating with rpcauth)` |
| `rpcUser` set without `rpcPassword` | `node <id>: rpcUser is set but rpcPassword is empty` |

Failures after validation, while the server starts:

| situation | what happens |
|---|---|
| A listed address is taken, or the port is privileged | Exit 1. The log explains the cause: already in use (probably a second instance), permission denied (ports below 1024), or no such address, and lists the addresses the machine has. |
| `BLOCKYARD_ADMIN_PASSWORD` fails the password rules on first boot | The boot throws with the rule it broke, for example `password must be at least 12 characters` or `password must not contain the username`. |
| `BLOCKYARD_FAKE_NODE=1` and the simulated node cannot start (for example, `FAKE_PORT` in use) | `dev mode needs a local fake node: <error>` |

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

- **`rpcUser`/`rpcPassword` alone are fine** since 2026-09-13. They used to fail validation,
  and the documented workaround was to point `cookieFile` at a path that does not exist. That is
  no longer needed: a node authenticated by username and password needs no `datadir` and no
  `cookieFile`. If you copied the old workaround, it still works -- but you can delete the line.
- **`server.hosts` in the file beats `BLOCKYARD_BIND`/`BLOCKYARD_HOST`.** The
  environment variables set `server.host`, but a `server.hosts` array takes
  precedence over `server.host`. If your file uses `hosts`, change the bind there,
  or run with `BLOCKYARD_CONFIG=none`.
- **Node environment variables change only `nodes[0]`.** With several nodes in the
  file, `BLOCKYARD_NODE_URL` and friends rewrite the first one and leave the rest
  alone. The shipped systemd unit sets several of them.
- **`auth.loginMaxAttempts` and `auth.loginWindowMs` are not read.** The login guard
  takes its limits from keys named `maxAttempts` and `windowMs` and otherwise falls
  back to 8 attempts per 5 minutes. Those are the same numbers as the documented
  defaults, so nothing changes unless you try to change them. `auth.lockoutMs` is
  read.
- **`actions.requireAdmin` is not consulted.** Each action's minimum role is fixed in
  code (see [actions](#actions)).
- **`systemdUnit` is informational.** The server does not query or control systemd.
- **A missing `BLOCKYARD_CONFIG` file is silent.** A path that does not exist gives you
  the defaults without an error.
