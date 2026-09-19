# BlockYard HTTP API

BlockYard serves its browser UI and a JSON API from the same port. Everything the dashboard draws comes from the endpoints documented here, so any script can read the same data. This reference is derived from `server/http/api.js` (the route table), `server/http/server.js` (routing, auth, limits), `server/http/sse.js` (the event stream), `server/http/explorer.js`, `server/collect/markets.js`, `server/collect/monitor.js` and `server/rpc/allowlist.js`.

Contents

1. [Conventions](#1-conventions)
2. [Endpoint index](#2-endpoint-index)
3. [Health and build](#3-health-and-build)
4. [State, sync and nodes](#4-state-sync-and-nodes)
5. [Chart history: /api/series](#5-chart-history-apiseries)
6. [Mempool](#6-mempool)
7. [Blocks and transactions (drill-down)](#7-blocks-and-transactions-drill-down)
8. [Explorer: /api/x/*](#8-explorer-apix)
9. [Mining](#9-mining)
10. [Peers and network](#10-peers-and-network)
11. [Events](#11-events)
12. [Markets](#12-markets)
13. [RPC console and the allowlist](#13-rpc-console-and-the-allowlist)
14. [Node actions](#14-node-actions)
15. [Accounts, sessions, users and audit](#15-accounts-sessions-users-and-audit)
16. [Telemetry and configuration](#16-telemetry-and-configuration)
17. [The event stream: /api/stream](#17-the-event-stream-apistream)
18. [End-to-end examples](#18-end-to-end-examples)

---

## 1. Conventions

### Base URL

The server listens on port `21000` by default (`BLOCKYARD_PORT`), on the addresses in `server.host` / `BLOCKYARD_BIND`. HTTPS is on by default (`server.tls.enabled`), with a certificate the server makes for itself under `<data>/tls/` unless `BLOCKYARD_TLS_CERT` + `BLOCKYARD_TLS_KEY` name your own. `BLOCKYARD_TLS=0` serves plain HTTP behind a TLS-terminating proxy. The examples below use:

```
http://127.0.0.1:21000
```

Against a default install use `https://` (and `curl --cacert`, or `-k` for the self-signed certificate). `/api/build` and `/api/health` report which one is in effect (`scheme`, `tls`).

### JSON everywhere

- Every `/api/*` response is `application/json; charset=utf-8` with `Cache-Control: no-store`. The only exception is `/api/stream`, which is `text/event-stream`.
- Request bodies (POST) can be JSON or `application/x-www-form-urlencoded`, and are capped at 1 MB. A larger body is refused with `413`, and a body that is not valid JSON with `400` (`kind: "body"`).
- Timestamps named `at`, `t`, `ts`, `*At` are Unix milliseconds. Fields named `time`, `mediantime`, `blocktime` are node-supplied Unix seconds.
- A figure the node does not report is `null`, never `0`. Several endpoints also carry `notReported` / `unavailable` / `note` strings saying why.

### Multi-node: the `node` parameter

A monitor can watch several nodes. Every per-node endpoint accepts `?node=<id>` (`?nodeId=` is an alias, except on `/api/stream`). When it is omitted, the first configured node (the "primary") answers. `/api/nodes` lists the configured ids. The built-in default id is `main`, and the examples use it.

An unknown id is a `404`:

```json
{ "error": { "message": "no node \"nope\"; known: main", "kind": "api", "code": null } }
```

These endpoints are **not** per-node: `/api/health`, `/api/build`, `/api/nodes`, `/api/telemetry`, `/api/config`, `/api/config/node*` (they always address `nodes[0]`), `/api/settings`, `/api/events` (rows carry a `node` field but there is no node filter), `/api/markets*`, and the account/admin routes.

### Errors and status codes

Transport-level failures use one envelope:

```json
{ "error": { "message": "human-readable sentence", "kind": "api", "code": "rpc_denied" } }
```

`code` is present only on errors raised by a handler (`kind: "api"`). Some errors add sibling fields: `login` (on 401) or `accounts` (on admin refusals in open mode).

| `kind` | Status | Meaning |
|---|---|---|
| `api` | 400 / 401 / 403 / 404 / 429 / 503 | A handler refused the request. See `code`. |
| `auth` | 401 | Accounts are on and there is no valid session. The body includes `"login": "/login"`. |
| `forbidden` | 403 | Address outside the CIDR gate, disabled account, or an admin route without the admin role. |
| `csrf` | 403 | `X-CSRF-Token` missing or wrong (accounts on only). |
| `ratelimited` | 429 | The token bucket is empty. The message says how many seconds to wait (no `Retry-After` header is sent). |
| `not_found` | 404 | No such `/api/...` path. |
| `method` | 405 | The path exists with another method. The `Allow` header lists the valid ones. |
| `body` | 400 / 413 | The body is unreadable, not JSON, or larger than 1 MB. |
| `unknown_node` | 404 | `/api/stream?node=` named a node that does not exist. |
| `internal` | 500 | Unexpected server error. Details go to the server log only. |

Handler `code` values: `accounts_disabled`, `throttled`, `locked`, `bad_credentials`, `rpc_denied`, `action_denied`, `confirm_required`, or `null`.

**Node errors are not HTTP errors.** When the node itself refuses or fails, the answer is `200` with `ok: false` and the node's own message. This applies to `/api/rpc`, `/api/action`, `/api/block`, `/api/tx` and all of `/api/x/*`. Always check `ok`, not just the status.

Other statuses: `204` for `OPTIONS` on any path (`Allow: GET,POST,DELETE,HEAD`). `HEAD` works for static files only. On `/api/*` a `HEAD` gets `405`.

### Access modes and auth levels

Each route in the table has one of three auth levels:

| Level | Accounts off (`BLOCKYARD_AUTH=0`) | Accounts on (the default) |
|---|---|---|
| `none` | Open. | Open. No session needed. |
| `any` | Served as the built-in anonymous user (`role: "viewer"`). | Any valid, non-disabled session. Without one: `401`. |
| `admin` | Always `403` with `"accounts": false`: nothing in open mode has the admin role. | Session with role `admin`, else `403`. |

The roles are `viewer` < `operator` < `admin`. No route in the table requires `viewer` or `operator` by itself. Those two roles matter in two places only: each node action names a minimum role (section 14), and `POST /api/password` needs `admin` to change *another* user's password.

**Open mode (`auth.enabled=false`, a choice; the default is accounts on).** No sign-in. Anyone who can reach the port can read everything (state, charts, events, peers, mempool, explorer, markets, the read-only RPC console) as `viewer`. The ceiling is fixed and nothing can raise it. As a result:

- user administration, `/api/audit` and password changes are closed;
- node writes (`/api/action`) are refused unless `BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1` was set deliberately;
- `/api/login` answers `403 accounts_disabled`;
- `GET /login` redirects (`302`) to `/`.

**Accounts mode (the default).** Sign-in, roles, sessions, CSRF protection and a per-user audit trail. On first start with no users, an `admin` account is created. Its password comes from `BLOCKYARD_ADMIN_PASSWORD`, or is generated and printed once to the server log.

### Session cookie

`POST /api/login` sets two cookies:

| Cookie | Attributes | Purpose |
|---|---|---|
| `blockyard_sid` (configurable as `auth.cookieName`) | `HttpOnly; SameSite=Strict; Path=/; Max-Age=259200` (+ `Secure` over TLS or with `BLOCKYARD_SECURE_COOKIE=1`) | The session token. Only its SHA-256 is stored server-side. |
| `blockyard_csrf` | Same, but **not** `HttpOnly` | The CSRF double-submit value, readable by page JavaScript. |

Sessions expire 72 hours after creation (`auth.sessionTtlMs`), or after 8 hours without a request (`auth.idleTtlMs`). A role change or a disable takes effect on the next request, not at next login.

### CSRF: the `X-CSRF-Token` header

With accounts on, every mutating route (`POST /api/logout`, `/api/logout-all`, `/api/rpc`, `/api/action`, `/api/password`, `/api/config/node/test`, `/api/config/node`, `/api/settings`, and all `POST /api/users*`) needs the session's CSRF token. Send it in the `X-CSRF-Token` header, or as a `csrf` field in the body. The cookie alone is **not** accepted, because a cross-site request would carry it too. The value is returned by `/api/login` as `csrf` and is also in the `blockyard_csrf` cookie.

`/api/login` itself is exempt. In open mode there is no session, so no CSRF check runs.

### Rate limits

| Bucket | Key | Capacity / refill | Applies to |
|---|---|---|---|
| General | `anon:<ip>` in open mode, the user id with accounts | 120 requests, refilled at 40/s | Every `auth: any` / `admin` route. |
| Stream | `sse:anon:<ip>` or `sse:<userId>` | 120 / 40 per s | Opening `/api/stream`. |
| Login | `login:<ip>` | 10 attempts, refilled at 1 per 2 s | `POST /api/login` (answers `429 throttled`). |
| Login lockout | per username **and** per IP | 8 failures in 5 minutes locks for 10 minutes | `POST /api/login` (answers `429 locked`). |

`auth: none` routes (`/api/health`, `/api/build`) and static files are not rate limited.

### The CIDR gate

When `server.allowCidrs` / `BLOCKYARD_ALLOW_CIDRS` is set (comma-separated IPv4/IPv6 CIDRs, for example `192.0.2.0/24,127.0.0.1/32`), every request is checked first: API, static files and the stream, before any KDF or session work. An address outside the list gets:

```json
{ "error": { "message": "this address is not permitted", "kind": "forbidden" } }
```

The reason is logged server-side only. The client IP is the socket peer, unless `server.trustProxy` / `BLOCKYARD_TRUST_PROXY=1` is set, in which case the first `X-Forwarded-For` entry is used. Enable that only behind a proxy you control.

### Security headers

Every JSON, static and error response carries:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
```

HTML pages get a per-response script nonce (`script-src 'self' 'nonce-...'`). `Strict-Transport-Security` is added only when TLS is on and `server.tls.hstsMs > 0`. Static files are `Cache-Control: no-cache` with a weak ETag. Asset URLs in pages carry `?v=<build>`.

---

## 2. Endpoint index

| Method | Path | Auth | Section |
|---|---|---|---|
| GET | `/api/health` | none | [3](#3-health-and-build) |
| GET | `/api/about` | any | [3](#3-health-and-build) |
| GET | `/api/build` | none | [3](#3-health-and-build) |
| GET | `/api/state` | any | [4](#4-state-sync-and-nodes) |
| GET | `/api/sync` | any | [4](#4-state-sync-and-nodes) |
| GET | `/api/nodes` | any | [4](#4-state-sync-and-nodes) |
| GET | `/api/series` | any | [5](#5-chart-history-apiseries) |
| GET | `/api/mempool` | any | [6](#6-mempool) |
| GET | `/api/mempool/dense` | any | [6](#6-mempool) |
| GET | `/api/blocks` | any | [7](#7-blocks-and-transactions-drill-down) |
| GET | `/api/block` | any | [7](#7-blocks-and-transactions-drill-down) |
| GET | `/api/tx` | any | [7](#7-blocks-and-transactions-drill-down) |
| GET | `/api/x/search` | any | [8](#8-explorer-apix) |
| GET | `/api/x/tx` | any | [8](#8-explorer-apix) |
| GET | `/api/x/block` | any | [8](#8-explorer-apix) |
| GET | `/api/x/address` | any | [8](#8-explorer-apix) |
| GET | `/api/mining` | any | [9](#9-mining) |
| GET | `/api/nextblock` | any | [9](#9-mining) |
| GET | `/api/peers` | any | [10](#10-peers-and-network) |
| GET | `/api/net` | any | [10](#10-peers-and-network) |
| GET | `/api/events` | any | [11](#11-events) |
| GET | `/api/markets` | any | [12](#12-markets) |
| GET | `/api/markets/depth` | any | [12](#12-markets) |
| POST | `/api/rpc` | any + CSRF | [13](#13-rpc-console-and-the-allowlist) |
| GET | `/api/actions` | any | [14](#14-node-actions) |
| POST | `/api/action` | any + CSRF (+ action role) | [14](#14-node-actions) |
| POST | `/api/login` | none | [15](#15-accounts-sessions-users-and-audit) |
| POST | `/api/logout` | any + CSRF | [15](#15-accounts-sessions-users-and-audit) |
| POST | `/api/logout-all` | any + CSRF | [15](#15-accounts-sessions-users-and-audit) |
| GET | `/api/me` | any | [15](#15-accounts-sessions-users-and-audit) |
| POST | `/api/password` | any + CSRF | [15](#15-accounts-sessions-users-and-audit) |
| GET | `/api/users` | admin | [15](#15-accounts-sessions-users-and-audit) |
| POST | `/api/users` | admin + CSRF | [15](#15-accounts-sessions-users-and-audit) |
| POST | `/api/users/generate` | admin + CSRF | [15](#15-accounts-sessions-users-and-audit) |
| POST | `/api/users/:username/role` | admin + CSRF | [15](#15-accounts-sessions-users-and-audit) |
| POST | `/api/users/:username/disabled` | admin + CSRF | [15](#15-accounts-sessions-users-and-audit) |
| GET | `/api/audit` | admin | [15](#15-accounts-sessions-users-and-audit) |
| GET | `/api/telemetry` | any | [16](#16-telemetry-and-configuration) |
| GET | `/api/config` | any | [16](#16-telemetry-and-configuration) |
| POST | `/api/config/node/test` | any + CSRF (admin with accounts on) | [16](#16-telemetry-and-configuration) |
| POST | `/api/config/node` | any + CSRF (admin with accounts on) | [16](#16-telemetry-and-configuration) |
| GET | `/api/settings` | any | [16](#16-telemetry-and-configuration) |
| POST | `/api/settings` | any + CSRF (admin with accounts on) | [16](#16-telemetry-and-configuration) |
| GET | `/api/stream` | any (checked in `server.js`) | [17](#17-the-event-stream-apistream) |

Any other path that is not an `/api/*` path is served from `public/` as a static file (`/` is `index.html`, `/login` is `login.html`). A missing page gets `404.html` with status 404.

---

## 3. Health and build

### `GET /api/health`

Auth `none`, not rate limited. Built for uptime probes. `ok` is `true` when at least one node is configured and every **non-optional** node's RPC is online. An optional node that is down shows up in `degraded` but does not turn `ok` false.

```json
{
  "ok": true,
  "degraded": [],
  "version": "0.1.0",
  "build": "0.1.0-fd620adc52",
  "scheme": "http",
  "tls": false,
  "uptimeSec": 1519,
  "authRequired": false,
  "nodes": [
    { "id": "main", "label": "Bitcoin Core", "online": true, "optional": false,
      "chain": "main", "tip": 966546, "lastError": null }
  ]
}
```

### `GET /api/about`

What the About page shows: the monitor's version and live build, and the **shape** of the machine it runs on.

```json
{ "version": "0.1.0", "build": "0.1.0-a6ecedff3c", "platform": "linux", "release": "7.0.0-31-generic",
  "arch": "x64", "cpus": 32, "cpuModel": "AMD Ryzen 9 9950X3D 16-Core Processor",
  "totalMemGb": 132.3, "node": "v22.23.2", "uptimeSec": 2355 }
```

`auth: any` rather than `none`, unlike `/api/health` and `/api/build`: a version string answers "is my tab running current code", which a login page legitimately needs, whereas the host's processor and memory should not be readable before sign-in when accounts are on.

It reports **no hostname, no username, no network addresses and no environment**. In open mode (`BLOCKYARD_AUTH=0`) everything here is readable by anyone who can reach the port; the operating system and processor describe a machine's shape, not its owner. A test pins those absences.

### `GET /api/build`

Auth `none`. Answers "is the code in my tab the code on disk?" The build id is `<version>-<10 hex>`, a digest of the sizes and mtimes of the files under `public/`.

| Query | Type | Meaning |
|---|---|---|
| `build` | string | Optional. The build id the page was served with. |

```json
{
  "version": "0.1.0",
  "build": "0.1.0-5223f98d84",
  "bootBuild": "0.1.0-fd620adc52",
  "matchesClient": null,
  "scheme": "http",
  "tls": false,
  "uptimeSec": 1571
}
```

`build` is computed live, `bootBuild` at process start. `matchesClient` is `true`/`false` when `?build=` was sent, otherwise `null`.

---

## 4. State, sync and nodes

### `GET /api/state`

The whole read model for one node: the same object the stream pushes as `snapshot` (section 17), plus `app`, `user` and `seq`.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `node` | string | primary | Node id. |
| `series` | `none` | — | `series=none` returns `"series": {}`: the cheap poll. |
| `range` | duration | `1h` | Range of the "hour" chart windows. |
| `range6` | duration | `6h` | Range of the "hours6" chart windows. |

A duration is a number with an optional unit `s` (default), `m`, `h` or `d`, for example `15m`, `24h`, `7d`. It is clamped to 1 s through 31 d. Anything unparseable falls back to the default.

Top-level keys:

```
id label color online chain ibd tip sync progress warnings difficulty hashrateEstEh hashrateNote
avgBlockGapSec sizeOnDisk pruned chainwork uptimeSec network mempool peers net attribution blocks
network (the Mining tab's network row: rewards over 144 blocks, adjustment, halving, adjustments[], hashrate { networkHashPs, series[] }, pools { blocks, luckPct, pools[], filled, todo }; collect/network.js)
fees mining utxo chaintxstats indexes tips deployments rpcInfo log health series app user seq
```

Trimmed example:

```json
{
  "id": "main",
  "label": "Bitcoin Core",
  "color": "#f7931a",
  "online": true,
  "chain": "main",
  "ibd": false,
  "tip": { "height": 966546, "headers": 966546,
           "hash": "0000000000000000000019f6fb9d8e1e43e9d72916b2ed8aef080c778685a4aa",
           "time": 1789154285, "mediantime": 1789151883, "ageSec": 1403, "behindHeaders": 0 },
  "sync": { "state": "synced", "height": 966546, "headers": 966546, "behind": 0, "pct": 100,
            "verificationProgress": 100, "etaSec": null, "eta": null, "rateTrend": "stalled",
            "node": "main", "nodeLabel": "Bitcoin Core", "endpoint": "http://127.0.0.1:8332",
            "strip": [ { "label": "chain", "...": "..." } ] },
  "difficulty": 127450789715843.1,
  "hashrateEstEh": 200.1,
  "hashrateNote": null,
  "mempool": { "count": 21398, "bytes": 8123456, "usage": 41234567, "maxUsage": 300000000,
               "usagePct": 13.7, "totalFee": 0.123, "minFee": 0.00001, "minRelayFee": 0.00001,
               "rejects": null, "dist": { "count": 21398, "p50Feerate": 1.2, "scatterPoints": 1500, "...": "..." } },
  "peers": { "connections": 11, "in": 0, "out": 11, "identitySource": "getpeerinfo", "...": "..." },
  "net": { "inBps": null, "downloadMeasured": false, "outBps": null, "uploadMeasured": false, "...": "..." },
  "attribution": { "recent": [], "pools": [], "...": "same shape as /api/mining" },
  "blocks": { "count": 31, "recent": [ { "height": 966546, "totalfee": 1929031, "...": "..." } ],
              "backfilled": true, "reorgs": 0 },
  "fees": { "f1": 3.1, "f2": 2.0, "f6": 1.1, "f24": 1.0, "f144": 1.0 },
  "log": { "exists": false, "source": "disabled", "...": "..." },
  "health": { "rpc": { "online": true, "...": "..." }, "cadence": { "fast": { "configuredMs": 4000,
              "effectiveMs": 4000, "stretched": false, "lastRunMs": 120 } }, "quality": [] },
  "series": { "mempool": { "hour": [ { "t": 1789154820000, "v": 18780 } ], "...": "..." } },
  "app": { "version": "0.1.0", "build": "0.1.0-fd620adc52", "scheme": "http", "uptimeSec": 1536,
           "sseClients": 5, "self": { "rssMb": 175.6, "heapMb": 42.8, "cpuPct": 2.71 }, "serverTime": 1789155688322 },
  "user": { "username": "anonymous", "role": "viewer", "id": "anonymous", "disabled": false, "lastLoginAt": null },
  "seq": 406
}
```

Notes:

- `sync` always carries the node's own identity (`node`, `nodeLabel`, `endpoint`), and `strip` is the ordered list of facts the sync bar draws. `sync.state` is one of `unknown`, `ibd`, `catching_up`, `synced`, `stalled` or `reorg` (see `server/collect/sync.js`). `stalled` is claimed only when the connected peers report a tip above the node's (`computeSync` takes `peerBestHeight`, the highest `synced_headers` — `startingheight` as a fallback — over `getpeerinfo`); a long gap with the peers agreeing is `synced` with a caveat, and with no peer heights at all the state becomes `stalled` after 7200 s without a block.
- `utxo` is filled only from a node whose `getindexinfo` reports a synced `coinstatsindex`; the slow tier asks `getindexinfo` first, on its own, and sends `gettxoutsetinfo` only to such a node. Otherwise `utxo` is `null` and `health.quality` carries `utxo-unindexed`.
- `health.quality` is the list of named gaps the Overview shows. While the server is building the address index it holds `address-index-building` (phase, done of total, rows, time left, `paused while the node's RPC is slow`); a failed build leaves `address-index-build-failed`. `rpc-slow` and `rpc-timeouts` describe the measurement and name the index build when one is running rather than asserting a cause.
- `hashrateEstEh` is the network hash rate in EH/s, estimated as difficulty x 2^32 divided by the observed mean block gap -- a difficulty-1 target expects 2^32 hashes, so leaving that factor out understates the rate by 4.29 billion (it did until 2026-09-12, and the figure reached the page as `0.0 EH/s`). The estimate agrees with the node's own `getnetworkhashps` to about one per cent. During IBD, or more than 6 blocks behind headers, it is `null` and `hashrateNote` says why.
- `mempool.dist` omits the scatter points (`scatterPoints` is their count). Fetch them from `/api/mempool`.
- `blocks.recent` holds the newest 40 blocks, newest first.
- `series` has the chart windows listed under [/api/series](#snapshot-series-windows).

### `GET /api/sync`

Only the sync bar's data: small enough to poll hard from a status widget.

| Query | Meaning |
|---|---|
| `node` | Node id. |

```json
{
  "node": "main",
  "sync": { "state": "synced", "chain": "main", "height": 966546, "headers": 966546, "behind": 0,
            "pct": 100, "verificationProgress": 100, "headersMayLag": false, "tipAgeSec": 1408,
            "etaSec": null, "etaBest": null, "etaWorst": null, "blocksPerMin": null,
            "avgBlockGapSec": 636.7, "sizeOnDisk": 767996069971, "peers": 11, "reorgs": 0,
            "warnings": [], "reason": null, "caveats": [], "node": "main", "strip": [] },
  "tip": { "height": 966546, "headers": 966546, "hash": "0000...a4aa", "ageSec": 1408, "behindHeaders": 0 },
  "chain": "main",
  "ibd": false,
  "health": { "rpc": { "online": true, "lastError": null } }
}
```

### `GET /api/nodes`

Every configured node with its sync state -- except a Bitcoin Machine Code node (known by its
`/BitcoinMachineCode:` user agent) that is not yet synced, which is left out of `nodes` and
`attention` until it is. `/api/state?node=<id>` still answers for it.

```json
{
  "nodes": [
    { "id": "main", "label": "Bitcoin Core", "rpcUrl": "http://127.0.0.1:8332", "chain": "main",
      "online": true, "optional": false, "syncState": "synced", "pct": 100,
      "height": 966546, "headers": 966546, "syncing": false }
  ],
  "primary": "main",
  "attention": []
}
```

`attention` lists node ids whose sync state is not `synced` (including `unknown`). `primary` is the node that answers when `?node=` is omitted.

---

## 5. Chart history: `/api/series`

### `GET /api/series`

Bucketed time series from the in-memory history rings. The rings are persisted to disk and kept for `store.retentionHours`.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `node` | string | primary | Node id. |
| `name` | csv | `mempool` | One or more series names (table below). |
| `field` | csv | all fields of each series | Fields to return. Every field must exist in every named series. |
| `range` (alias `since`) | duration | `1h` | How far back. Clamped to 1 s through 31 d. |
| `points` | int | `240` | Target number of buckets, 20–2000. `bucketMs = round(range / points)` to whole seconds, at least 1 s. |
| `agg` | enum | `last` | Per-bucket aggregate: `last`, `first`, `avg`, `min`, `max`, `sum`, `delta` (the sum of positive steps). |

An unknown name or field is a `400` that lists the valid ones.

```json
{
  "node": "main",
  "rangeMs": 900000,
  "bucketMs": 45000,
  "series": {
    "mempool": {
      "count": [ { "t": 1789154820000, "v": 18780 }, { "t": 1789154865000, "v": 18927 } ]
    }
  }
}
```

Each point is `{ t, v }`. `t` is the **end** of the bucket, and empty buckets are left out.

| Series | Fields |
|---|---|
| `node` | `blocks headers progress difficulty sizeOnDisk ibd connections peersIn peersOut uptimeMs txRate chainTxCount txouts totalAmount muhash` |
| `mempool` | `count bytes usage maxUsage totalFee minFee minRelayFee unbroadcast ingestRate acceptedDelta rejectMissing rejectPolicy rejectInvalid confirmedDrain pendingAncestors replaceable avgFee avgVsize` |
| `net` | `inBps outBps diskWriteBps inTotal outTotal diskTotal avgRecvBps avgWriteBps floorBps poolMedianBps` |
| `fees` | `f1 f2 f6 f24 f144 mempoolmin priority estimatorOk` |
| `peers` | `connections in out relayPeers servedBlocks txRelayPeers wanted banned rankingLive rankingAnswered rankingMedianKbps` |
| `blocks` | `height time mediantime totalfee txs size weight medianTxSize avgTxSize swtotalSize swtxs avgFeerate subsidy utxoIncrease ins outs avgfee medianfee maxfee p0 p1 p2 p3 p4 gapSec viaPeer source` |
| `txflow` | `accepted relayAccepted rejectMissing rejectPolicy rejectInvalid alreadyConfirmed orphansHeld orphansParked orphansResolved orphansDropped inFlight oneP1C oneP1CFailed windowSec` |
| `rpc` | `latencyMs avgLatencyMs ratePerSec queued errors breakerTrips busyMsPerSec` |
| `self` | `rssMb heapMb sseClients usersActive cpuPct eventRate` |

Many fields only fill from a node log source. **That source does not currently support Bitcoin Core** (the parsers target an experimental node's log grammar), so against Core these stay empty -- empty, never zero. RPC-only is the default and supported mode.

#### Snapshot series windows

The `series` object inside `/api/state`, the `snapshot` event and the `series` event uses fixed windows, keyed `series.<name>.<window>`:

| Series | Windows (field, range) |
|---|---|
| `mempool` | `hour`/`hours6`/`day` (count over `range` / `range6` / 24 h), `bytesHour`, `usageHour`, `feeHour`, `ingestHour` |
| `net` | `inHour`, `outHour`, `diskHour`, `inDay` |
| `fees` | `f1`, `f2`, `f6`, `f24`, `f144`, `min` (24 h) |
| `blocks` | `fee`, `size`, `txs`, `gap`, `p1`, `p2`, `p3` (24 h, 300 points) |
| `peers` | `connections`, `in`, `out`, `relay` (24 h) |
| `node` | `tip`, `difficulty` (7 d avg), `txRate`, `txouts` (7 d avg), `disk` |
| `txflow` | `accepted`, `rejectPolicy` (1 h avg), `orphansHeld`, `orphansParked`, `inFlight` |
| `rpc` | `latency`, `rate` (1 h) |

---

## 6. Mempool

### `GET /api/mempool`

The mempool panel's data, including the scatter points and treemap cells that the snapshot leaves out. The data comes from `getrawmempool` (verbose) on the 20 s pool tier: it is a poll, not a stream, and `feed` says so.

```json
{
  "node": "main",
  "feed": { "kind": "poll", "cadenceSec": 60, "streamAvailable": false,
            "why": "the node refuses zmqpubsequence: ...",
            "source": "getrawmempool verbose on the 20 s pool tier + [tx_accept]/[txrelay] log lines" },
  "info": { "loaded": true, "count": 21398, "bytes": 8123456, "usage": 41234567, "maxUsage": 300000000,
            "usagePct": 13.7, "totalFee": 0.123, "minFee": 0.00001, "minRelayFee": 0.00001,
            "incrementalRelayFee": 0.00001, "unbroadcast": 0, "maxDataCarrier": 83,
            "permitBareMultisig": true, "ingestRate": null, "acceptWindow": null, "rejects": null,
            "lastDrain": null, "dist": { "...": "as in /api/state" } },
  "dist": {
    "count": 21398, "totalVsize": 5200000, "totalFeeSat": 12345678,
    "avgFeerate": 2.4, "p50Feerate": 1.2, "p90Feerate": 4.1, "maxFeerate": 350.5,
    "avgVsize": 243, "oldestSec": 86000, "ageUnknown": 0,
    "hist":    [ "40 log-spaced feerate buckets, 0.5-2000 sat/vB" ],
    "ageHist": [ "30 linear age buckets" ],
    "scatter": [ [ 120, 1.25, 141 ] ],
    "cells":   [ { "vbytes": 141, "rate": 120.0, "txid": "9891f72b..." } ],
    "cellCount": 21398,
    "pendingAncestors": null, "replaceable": null,
    "projected": {
      "blockVsize": 1000000,
      "skipped": { "n": 4107, "vsize": 999930, "feeSat": 1100000, "maxRate": 350.5, "minRate": 1.01, "medianRate": 1.5 },
      "blocks": [ { "n": 5200, "vsize": 999800, "feeSat": 1000000, "maxRate": 1.01, "minRate": 1.0, "medianRate": 1.0 } ],
      "rest": { "n": 900, "vsize": 200000, "feeSat": 20000, "maxRate": 1.0, "minRate": 0.1, "blocks": 1 }
    }
  },
  "notReported": [ "pendingancestors", "replaceable (BIP125) flag", "fees.prioritiserved", "modifiedfees",
                   "ancestorcount/ancestorfees", "withdrawreason", "replaced-by" ],
  "log": { "lastDrain": null, "orphans": null, "orphanDetail": null, "accept": null, "relayRate": null },
  "fees": { "f1": 3.1, "f2": 2.0, "f6": 1.1, "f24": 1.0, "f144": 1.0 },
  "history": { "count": [ { "t": 1789155600000, "v": 21398 } ], "usage": [ { "t": 1789155600000, "v": 41234567 } ] }
}
```

- `scatter` rows are `[ageSec, feerate sat/vB, vsize]`, sampled to at most 1500 points. Entries with an unknown age (`time` 0) or no fee are left out, and `ageUnknown` counts the unknown ages.
- `cells` holds the richest (up to) 400 transactions, then one aggregate cell for the rest.
  The aggregate carries `strata`: the tail grouped by feerate, richest first, at most 32
  groups of `{ "vbytes", "rate", "n" }`; the 3D board colours the tail's pieces from them.
- `projected` cuts the pool, richest feerate first, into 1,000,000 vB blocks. `skipped` is the first block's worth, which the node is assembling itself (see `/api/nextblock`). `blocks` holds the next six, and `rest` sums everything beyond. This is an estimate: the node reports no ancestor data, so a CPFP child is placed at its own feerate.
- `history` holds the last 60 raw ring rows for count and usage.

### `GET /api/mempool/dense`

Every transaction in the next block's worth of the pool, richest feerate first: roughly 3–5k entries and about 100 KB. This feeds the dense block view and is kept out of the snapshot. It is refreshed on the pool tier.

```json
{
  "node": "main",
  "at": 1789155648684,
  "blockVsize": 1000000,
  "n": 4107,
  "vsize": 999930,
  "poolCount": 21398,
  "unranked": 0,
  "v":  [ 189, 189, 110 ],
  "r":  [ 350.5, 120.0, 88.2 ],
  "id": [ "9891f72bea4bc27b", "..." ]
}
```

`v`, `r` and `id` are parallel arrays: vsize, feerate (sat/vB, 2 dp), and a 16-hex txid prefix. `unranked` counts entries without a reported fee, which cannot be ranked. Before the first pool poll the answer is `{ "at": null, "n": 0, "v": [], "r": [], "id": [] }`.

---

## 7. Blocks and transactions (drill-down)

These go through the same RPC lane as the collectors (up to `rpc.maxInFlight` at once, starts spaced). They never request `getblock` verbosity 2, and never return transaction hex. For richer pages use the explorer (section 8).

### `GET /api/blocks`

Recent blocks with per-block statistics from `getblockstats`.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `node` | string | primary | Node id. |
| `limit` | int | `90` | 1–400. The source list holds at most the newest 40 blocks, so larger values return 40. |

```json
{
  "node": "main",
  "blocks": [
    { "t": 1789154285000, "height": 966546,
      "hash": "0000000000000000000019f6fb9d8e1e43e9d72916b2ed8aef080c778685a4aa",
      "time": 1789154285, "mediantime": 1789151883, "totalfee": 1929031, "txs": 3441,
      "size": 2224872, "weight": 3991722,
      "sizeBasis": "sum of transaction sizes (getblockstats total_size); excludes the 80-byte header and the txid-count varint",
      "sizeMissing": null, "medianTxSize": 222, "avgTxSize": 646, "avgFeerate": 1,
      "swtotalSize": 2121556, "swtxs": 2833, "subsidy": 312500000, "utxoIncrease": 1857,
      "ins": 6038, "outs": 7895, "avgfee": 560, "medianfee": 178, "maxfee": 51899,
      "p": [0, 1, 1, 2, 3], "viaPeer": null, "source": "getblockstats", "gapSec": 438 }
  ],
  "stats": { "count": 31, "spanSec": 17766, "totalFeesSat": 103184764, "avgFeesSat": 3328541,
             "avgSize": 1773700, "maxSize": 3142799, "avgTxs": 3585, "avgGapSec": 636.7,
             "medGapSec": 438, "etaCadence": "00:00:10:37" }
}
```

`p` holds the feerate percentiles (10/25/50/75/90) in sat/vB. `gapSec` is the time since the previous block. Gaps of 7200 s or more are left out of `stats`.

### `GET /api/blocks/sampled`

The blocks the monitor holds, sampled evenly by height. The Chain page draws these for a node in
initial block download. That node has no last 24 hours of blocks, and it applies blocks faster than
the monitor asks about them (at most the newest 24 per poll), so the blocks the monitor holds are a
real but gappy sample of the sync so far. Every point is a block the node reported; nothing is
interpolated. `gapSec` is set only when the previous height was also fetched.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `node` | string | primary | Node id. |
| `points` | int | `300` | 2–600. At most this many, spread evenly from the oldest held height to the newest (both included). |

```json
{
  "node": "bmc-run27", "held": 11136, "from": 647125, "to": 777400,
  "points": [ { "height": 647125, "time": 1597000000, "size": 1234567, "totalfee": 23456789, "txs": 2345, "gapSec": null } ]
}
```

### `GET /api/block`

One block: header, statistics and the first 50 txids.

| Query | Type | Meaning |
|---|---|---|
| `hash` | 64 hex | Block hash. |
| `height` | int | Block height (up to 12 digits). |
| `node` | string | Node id. |

With neither `hash` nor `height`, the current tip is returned. A malformed hash or height is a `400`. If the node has not answered `getblockchaininfo` yet, the answer is `503`.

```json
{
  "ok": true,
  "node": "main",
  "requested": { "hash": null, "height": "966000",
                 "resolvedHash": "0000000000000000000013b8a367391f68a9891808c636ced0a399cdc1e0d5ab",
                 "resolvedHeight": 966000 },
  "ms": null,
  "header": { "hash": "0000000000000000000013b8a367391f68a9891808c636ced0a399cdc1e0d5ab",
              "confirmations": 547, "height": 966000, "version": 551559168, "size": 1661742,
              "weight": 3993924, "time": 1788831647, "mediantime": 1788829927,
              "merkleRoot": "7d9d386ed407ee2c8bca86fef5c5c28a21163a5220f060447f1e5a17dbd8f140",
              "txCount": 5997, "nTx": 5997,
              "previousblockhash": "00000000000000000000dbb4d1e55ad22ed5b5a7d81d4c0fe992fceb8a5302d0",
              "nextblockhash": "00000000000000000000032a2840c7dfc576808660ddff94773d6db984ff870c",
              "bits": "1702355e", "difficulty": 127450789715843.1,
              "chainTrust": "000000000000000000000000000000000000000145ab4333c85f0902722fea5e" },
  "stats": { "totalfee": 0, "txs": 5997, "feerate_percentiles": [1, 1, 2, 3, 5], "...": "getblockstats reply" },
  "statsError": null,
  "txids": [ "9445363a2e1715ba61f24d068e7a3aec62a88aad458dee12284d9f89c33d883a",
             "9891f72bea4bc27b8dd3990295be331e5e9ae69bc152c5ad31862efbb624ae69" ],
  "txidsShown": 50,
  "txidsTotal": 5997,
  "truncated": true,
  "notes": [ "header + txids only: ...", "5947 further txid(s) not listed; ..." ]
}
```

When the node refuses (for example, a pruned block), the answer is `200` with:

```json
{ "ok": false, "node": "main", "query": { "hash": null, "height": "12" },
  "error": { "message": "Block not available (pruned data)", "code": -1, "kind": "rpc" },
  "hint": "the node does not have this block stored (pruned, ...)" }
```

### `GET /api/tx`

One transaction, decoded by the node (`getrawtransaction` verbosity 1).

| Query | Type | Meaning |
|---|---|---|
| `txid` | 64 hex | Required. |
| `block` | 64 hex | Optional block hash. Some nodes need it to find a confirmed transaction. |
| `node` | string | Node id. |

```json
{
  "ok": true,
  "node": "main",
  "requested": { "txid": "9891f72bea4bc27b8dd3990295be331e5e9ae69bc152c5ad31862efbb624ae69", "block": null },
  "txid": "9891f72bea4bc27b8dd3990295be331e5e9ae69bc152c5ad31862efbb624ae69",
  "size": 222, "vsize": 141, "weight": 561, "version": 2, "locktime": 0,
  "inMempool": false,
  "blockHash": "0000000000000000000013b8a367391f68a9891808c636ced0a399cdc1e0d5ab",
  "blockHeight": null, "confirmations": 547, "blockTime": 1788831647, "time": 1788831647,
  "inputs": [ { "txid": "e990507273c34ad15db3c8491158b976940dfedfa9c42fc0a9adc2204c51376b", "vout": 1,
                "sequence": 4294967295, "scriptSigAsm": "", "scriptSigType": null,
                "witness": [ "304402205160e150b09b2632eab91797…" ], "value": null, "address": null } ],
  "inputsTotal": 1,
  "outputs": [ { "n": 0, "value": 0.0022176, "scriptPubKeyType": "witness_v0_keyhash",
                 "address": "bc1qqe2mj05z2q4zrqly789r59q5k53rhtgn8hznl0",
                 "scriptPubKeyAsm": "0 0655b93e82502a2183e4f1ca3a1414b5223bad13", "spent": null } ],
  "outputsTotal": 2,
  "totalOutSat": 12116383,
  "notReported": [ "fee / feerate (needs every input's prevout, ...)" ]
}
```

- At most 40 inputs and 40 outputs are listed. Scripts are truncated to 96 characters and witness items to 32.
- Output `value` is in **BTC**, as the node reports it. `totalOutSat` is in satoshis.
- If the node answers raw hex instead, the result is `{ ok: true, decoded: false, sizeHex, notes }`.
- A malformed `txid` is a `400`. An unknown transaction is `ok: false` with a `hint`.

---

## 8. Explorer: `/api/x/*`

Block, transaction and address pages, built on this node's own RPC. Each page is one batched RPC request (sometimes two). It is queued at priority 3 on the RPC lane and may wait up to 45 s. Decoded **confirmed** transactions are cached in memory (LRU, 3000 entries).

Conventions for all four:

- **Bad input is not an HTTP error.** A malformed or unknown query answers `200` with `{ "ok": false, "error": { "message": "..." }, "hint": "..." | null }`.
- Amounts are in **satoshis**. `feerate` is sat/vB, to 2 dp.
- **`usd`**: `/api/x/tx`, `/api/x/block` and `/api/x/address` add `"usd": <number|null>` to every `ok: true` answer when market data is enabled. The price is the median of fresh exchange tickers if the Markets tab is polling. Otherwise it is one Coinbase and one Kraken ticker read, cached for 60 s. The server waits at most 1.5 s for a price; if none arrives, `usd` is `null`. The field is absent when markets are disabled. `/api/x/search` never carries it.

### `GET /api/x/search`

| Query | Meaning |
|---|---|
| `q` | A height, block hash, txid or address. |

Classification:

- 1–9 digits: a block (no node call).
- 64 hex: `getblockheader` decides between `block` and `tx`.
- 14–100 alphanumerics: `validateaddress`.

```json
{ "ok": true, "type": "block", "id": "966000" }
```

```json
{ "ok": false, "error": { "message": "nothing on this node matches \"zzz\"" },
  "hint": "a height is digits; a block hash or txid is 64 hex characters; an address starts 1, 3 or bc1" }
```

`type` is `block`, `tx` or `address`. A hex `id` is returned lowercased.

### `GET /api/x/tx`

| Query | Meaning |
|---|---|
| `txid` | 64 hex. |

Uses `getrawtransaction` verbosity 2, which carries the fee and every prevout. Then, in a second batch, `getblockheader` (for the height) and `gettxspendingprevout` (spent-by, for up to 500 outputs).

```json
{
  "ok": true,
  "node": "main",
  "tx": {
    "txid": "9891f72bea4bc27b8dd3990295be331e5e9ae69bc152c5ad31862efbb624ae69",
    "hash": "00267bf1d6de9f1a811665fe9cbe3f8f551ead73703e41e4b7f0ecb097669c8e",
    "version": 2, "locktime": 0, "size": 222, "vsize": 141, "weight": 561,
    "fee": 16920, "feerate": 120, "coinbase": false,
    "inSat": 12133303, "outSat": 12116383,
    "vin": [ { "txid": "e990507273c34ad15db3c8491158b976940dfedfa9c42fc0a9adc2204c51376b", "vout": 1,
               "sequence": 4294967295, "value": 12133303,
               "address": "bc1qgwmsxwp6wj0fla53kwtx3h7eeyh3hsuamynp9z",
               "type": "witness_v0_keyhash", "height": 965976, "witness": true } ],
    "vout": [
      { "n": 0, "value": 221760, "address": "bc1qqe2mj05z2q4zrqly789r59q5k53rhtgn8hznl0",
        "type": "witness_v0_keyhash", "spentBy": null },
      { "n": 1, "value": 11894623, "address": "bc1qgwmsxwp6wj0fla53kwtx3h7eeyh3hsuamynp9z",
        "type": "witness_v0_keyhash",
        "spentBy": { "txid": "6e556dd8ec13181e7f92ecdc6e2172ffa2f9c98ebece6f4245d5cc46eab88ff7",
                     "blockhash": "0000000000000000000125c3df20202df66378286a3bcd84142877bfae84e466" } }
    ],
    "features": [ "segwit" ],
    "blockhash": "0000000000000000000013b8a367391f68a9891808c636ced0a399cdc1e0d5ab",
    "confirmations": 547, "time": 1788831647, "height": 966000
  },
  "tip": 966546,
  "outputsShown": 2,
  "usd": 77267.47
}
```

- A coinbase input is `{ "coinbase": true, "sequence": ... }`, and a coinbase transaction has `fee: 0`.
- `features` can contain `segwit`, `taproot`, `rbf` (some input sequence below `0xfffffffe`), `consolidation` (5 or more inputs, 2 or fewer outputs) and `op_return`.
- `confirmations: 0` means the transaction is in the mempool.

### `GET /api/x/block`

| Query | Type | Meaning |
|---|---|---|
| `id` | height or 64 hex | Required. |
| `page` | int ≥ 0 | 25 transactions per page. Default 0. |

```json
{
  "ok": true,
  "node": "main",
  "block": { "hash": "0000000000000000000013b8a367391f68a9891808c636ced0a399cdc1e0d5ab",
             "height": 966000, "confirmations": 547, "time": 1788831647, "mediantime": 1788829927,
             "size": 1661742, "strippedsize": 777394, "weight": 3993924, "version": 551559168,
             "versionHex": "20e02000",
             "merkleroot": "7d9d386ed407ee2c8bca86fef5c5c28a21163a5220f060447f1e5a17dbd8f140",
             "bits": "1702355e", "nonce": 545538887, "difficulty": 127450789715843.1,
             "chainwork": "000000000000000000000000000000000000000145ab4333c85f0902722fea5e",
             "nTx": 5997,
             "previousblockhash": "00000000000000000000dbb4d1e55ad22ed5b5a7d81d4c0fe992fceb8a5302d0",
             "nextblockhash": "00000000000000000000032a2840c7dfc576808660ddff94773d6db984ff870c" },
  "stats": { "avgfee": 0, "feerate_percentiles": [1, 1, 2, 3, 5], "total_size": 1661600, "...": "full getblockstats reply" },
  "pool": { "label": "ViaBTC", "tag": "/ViaBTC/" },
  "page": 0,
  "pages": 240,
  "txs": [
    { "txid": "9445363a2e1715ba61f24d068e7a3aec62a88aad458dee12284d9f89c33d883a", "fee": 0, "feerate": 0,
      "vsize": 419, "outSat": 313349306, "coinbase": true, "inCount": 1, "outCount": 6,
      "features": [ "op_return" ], "height": 966000, "time": 1788831647, "confirmations": 547 },
    { "txid": "9891f72bea4bc27b8dd3990295be331e5e9ae69bc152c5ad31862efbb624ae69", "fee": 16920, "feerate": 120,
      "vsize": 141, "outSat": 12116383, "coinbase": false, "inCount": 1, "outCount": 2,
      "features": [ "segwit" ], "height": 966000, "time": 1788831647, "confirmations": 547 }
  ],
  "tip": 966546,
  "usd": 77280.04
}
```

`pool` is set only when mining attribution has a row for that height. A transaction the node could not return appears as `{ "txid": "...", "missing": true }`.

### `GET /api/x/address`

| Query | Type | Meaning |
|---|---|---|
| `addr` | string | 14–100 alphanumerics. |
| `page` | int ≥ 0 | 25 transactions per page, newest first. |

**Bitcoin Core has no address index** — `getaddressbalance` and `getaddresstxids` are insight-style
extensions, and a stock Core node answers `Method not found` (measured 2026-09-13 against both
configured nodes, both Bitcoin Core). So a node configured with `addressIndex` answers
from **BlockYard's own index**, built from the node's block files and kept current by a follower
(see [Building the address index](INSTALL.md#building-the-address-index)); the reply says so in
`source` and describes the index in `index`.

```json
{
  "ok": true,
  "node": "main",
  "dataNode": "main",
  "address": "bc1qqe2mj05z2q4zrqly789r59q5k53rhtgn8hznl0",
  "type": "witness v0",
  "scriptType": null,
  "indexed": true,
  "source": "local-index",
  "balance": { "balance": 221760, "received": 221760, "utxos": 1 },
  "utxos": [ { "txid": "9891f72b...", "n": 0, "value": 221760, "height": 966000 } ],
  "utxoNote": null,
  "txCount": 1,
  "index": { "tip": 966963, "behind": 0, "builtAt": "2026-09-14T06:54:06.609Z", "following": true, "stale": null, "postTip": 0 },
  "page": 0,
  "pages": 1,
  "txs": [ { "txid": "9891f72b...", "fee": 16920, "feerate": 120, "vsize": 141, "outSat": 12116383,
             "coinbase": false, "inCount": 1, "outCount": 2, "features": [ "segwit" ],
             "height": 966000, "time": 1788831647, "confirmations": 547, "delta": 221760 } ],
  "tip": 966546,
  "usd": 77280.04
}
```

Without an index the page still answers, but it answers *honestly*: `indexed` is `false`,
`txCount` is **`null` rather than `0`**, `balance` is `null`, `txs` is empty and the page says the
node keeps no address index. A count nobody can answer is not zero. `validateaddress` works
everywhere (script parsing, no index), so the address is still confirmed and typed. Transaction and
block lookups are unaffected — those use `txindex`.

**While the server is building the index** (a configured `addressIndex` directory with no finished
index in it), the answer is the same `indexed: false` shape plus `indexBuilding`, so the page can say
how far the build has got:

```json
{
  "ok": true, "node": "main", "address": "bc1qqe2mj05z2q4zrqly789r59q5k53rhtgn8hznl0", "type": "witness v0",
  "indexed": false, "txCount": null, "balance": null, "txs": [], "page": 0, "pages": 1,
  "indexError": "Method not found", "balanceError": "Method not found", "localIndexError": null,
  "indexBuilding": { "dir": "/var/lib/blockyard/index", "node": "main", "phase": "scan",
                     "done": 1812, "total": 4870, "rows": 2190345120, "eta": "19 min",
                     "startedAt": 1789154285000, "error": null, "paused": false },
  "tip": 966546, "usd": 77280.04
}
```

`indexBuilding` is `null` whenever no build is running. `phase` is `heights` (block hashes over
RPC; `done`/`total` are heights), `scan` (block files on the worker pool; `done`/`total` are files)
or `sort` (buckets); `rows` is the count so far, `eta` a short duration string or `null`, and
`paused` is `true` while the build is held because the node's RPC is failing or slow. On finish the
follower starts and the next request answers `indexed: true`.

- `type` is `witness v<N>`, `script` or `legacy`.
- `indexed` says whether this node can answer address history at all. When `false`, `txCount` is
  `null`, `balance` is `null`, and nothing on the page is derived from the refusal; `indexError` and
  `balanceError` carry the node's own message (`Method not found` on Core), and `localIndexError`
  says why a configured `addressIndex` could not be opened, so a broken index does not look like an
  unconfigured one.
- `source` is `local-index` when the answer comes from BlockYard's index; `dataNode` is the node
  whose RPC the follower reads (one index serves every node on the same chain).
- `balance.balance` and `balance.received` are sums of each transaction's **net** for the address
  (a transaction that both paid and spent it counts once, by its net). `utxos` lists the address's
  unspent outputs — every transaction the index says touched it, each output paying it checked with
  `gettxout` (the UTXO set, less what the mempool already spends), `height` from the index's own row
  — and `balance.utxos` is their count. The walk is the whole history, so it is made for an address
  with at most 100 transactions; a longer one gets `utxos: null` and a `utxoNote` saying so.
- `index.tip` is the highest block the index covers (base, folded layers and the follower's live
  tail together); `behind` is how many blocks the node is ahead of it; `builtAt` is the manifest's
  build time; `following` says a follower is running; `stale` is a message when it has stopped (a
  reorganisation deeper than its tail, asking for a rebuild); `postTip` counts rows above the node's
  own tip, which are excluded from the balance and the history rather than shown.
- `delta` is the net change to this address in satoshis: outputs to it minus inputs from it. A
  transaction the node could not return is `{ "txid": ..., "missing": true, "height": ..., "delta": ... }`
  — the height and amount are the index's own.
- Pages are 25 rows, newest first, and a deep page costs no more than the first: the index keeps
  only `skip + limit` rows in a ring while it sums the balance.

---

## 9. Mining

### `GET /api/mining`

Pool attribution over the observed window of recent blocks, plus the cached block template. Attribution costs two cheap reads per block and can be turned off with `BLOCKYARD_MINING=0`.

```json
{
  "node": "main",
  "recent": [
    { "height": 966546, "hash": "0000...a4aa", "at": 1789154285000, "poolKey": "viabtc",
      "tagText": "/ViaBTC/", "tagSource": "push", "tagParseable": true, "tagHeightMatch": true,
      "weight": 3993366, "size": 2225310, "strippedSize": 589352, "txs": 3441, "totalfee": 1929031,
      "avgFeerate": 1, "p50": 1, "p75": 1, "p99": 3, "extraNonce": null, "commitment": "fabe6d6d",
      "rawCoinbase": "0392bf0e...", "poolLabel": "ViaBTC", "poolLabelKey": "viabtc",
      "matchedTag": "/ViaBTC/", "seenAt": 1789154316094, "poolName": null }
  ],
  "pools": [
    { "poolKey": "viabtc", "label": "ViaBTC", "tagText": "/ViaBTC/", "tags": [ "/ViaBTC/" ],
      "blocks": 7, "sharePct": 22.6, "txs": 21361, "avgWeight": 3993511, "medianSize": 1791590,
      "avgFeeRate": 2.14, "medianFeeRate": 1, "totalFeesSat": 20814877,
      "firstHeight": 966519, "lastHeight": 966546, "name": null }
  ],
  "byPool": [ { "poolKey": "foundry usa", "label": "Foundry USA", "blocks": 8, "sharePct": 25.8,
                "name": "Foundry USA", "labelled": true, "...": "same fields as pools" } ],
  "labelSource": null,
  "nextBlock": { "...": "the last /api/nextblock result, or null" },
  "nextBlockAgeMs": 12000,
  "windowBlocks": 31,
  "windowHeights": { "from": 966516, "to": 966546 },
  "fetched": 31, "at": 1789154316094, "lastError": null, "skippedIbd": 0,
  "aliasesLoaded": false, "enabled": true,
  "note": "shares are of the observed window only, ..."
}
```

- `recent` holds the newest 40 attributed blocks.
- `pools` groups blocks by coinbase tag. `byPool` groups by pool label, when a pool map is loaded (`labelSource` then names its source and hash).
- `poolName` / `name` come from `data/pool-aliases.json`. When a block has no alias, the coinbase text is shown as the pool wrote it.

### `GET /api/nextblock`

The block being built right now, **assembled by this server from the mempool** — it makes no RPC call of its own. Core publishes `depends`, the ancestor sizes and fees, and `fees.chunk`/`chunkweight` in `getrawmempool(true)`, which the monitor already reads every 20 s for the mempool view; `server/collect/gbt.js` selects greedily over the node's own chunk feerate, taking each transaction with its unselected ancestors. Assembly costs this process ~50–70 ms and your node nothing. The reply carries `assembledLocally: true`, `source: "getrawmempool"`, `poolSize` and `poolAgeMs` so a caller can see how fresh its input was. Measured against the node's own `getblocktemplate` on the same pool: 0.03% apart on total fees. It is a reconstruction of what a miner would choose, not the node's template — sigop limits and policy the mempool does not publish are not modelled.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `node` | string | primary | Node id. |
| `stale` | ms | `15000` | Serve the cached template if it is younger than this. |
| `refresh` | `1` | — | Force a new call. |

```json
{
  "node": "main",
  "height": 966547,
  "previous": "0000000000000000000019f6fb9d8e1e43e9d72916b2ed8aef080c778685a4aa",
  "txCount": 1186,
  "weight": 2027641, "weightLimit": 4000000, "weightPct": 50.7,
  "totalFeesSat": 1087392, "coinbaseSat": 313587392,
  "feeRate": { "...": "summary" },
  "feeRateHistogram": [ { "lo": 0, "hi": 0.1, "n": 57, "weight": 30528 } ],
  "mintime": 1789151884, "bits": "1702355e", "sigopLimit": 80000, "sizeLimit": 4000000,
  "version": 536870912, "signal": null,
  "packages": { "total": 1100, "multiTx": 40, "txsInPackages": 126, "largest": 5,
                "cpfpCandidates": 12, "sizeHistogram": [], "top": [] },
  "economy": { "remainingWeight": 1972359, "remainingPct": 49.3, "marginal": null, "spillCount": 0,
               "spillWeight": 0, "poolBytes": 8123456, "poolFitsNextPct": 100, "backlogBlocks": 0,
               "blockBytesEstimate": 1661742, "ahead": [], "note": "..." },
  "visual": { "cells": [], "totalVbytes": 506910, "tailCount": 786 },
  "at": 1789155693548,
  "ms": 72,
  "note": "the block being built is assembled here from getrawmempool(true) ...",
  "assembledLocally": true,
  "source": "getrawmempool",
  "poolSize": 30768,
  "poolAgeMs": 2276
}
```

When no template is available, the answer is `{ "node": "...", "unavailable": "<reason>" }`. The reasons are: disabled with `BLOCKYARD_MINING_TEMPLATE=0`, the node is in initial download, or the node's error. If a refresh fails after an earlier success, the last template is returned with a `lastError` field.

---

## 10. Peers and network

### `GET /api/peers`

```json
{
  "node": "main",
  "counts": { "connections": 11, "in": 0, "out": 11, "wanted": null, "budget": null,
              "banned": null, "bannedOf": null },
  "ranking": null,
  "identitySource": "getpeerinfo",
  "identity": null,
  "rpcRows": 11,
  "rpcUpdatedAt": 1789155718231,
  "rpcPeers": [ { "id": 3, "addr": "192.0.2.10:8333", "subver": "/Satoshi:27.0.0/", "...": "getpeerinfo row, verbatim" } ],
  "activity": [],
  "recentEvents": [],
  "network": { "version": 10000, "subversion": "/Satoshi:29.0.0/", "protocol": 70016,
               "services": "0000000000000409", "servicesNames": [ "NETWORK", "WITNESS" ],
               "networkactive": true, "relayfee": 0.00001, "incrementalfee": 0.00001,
               "networks": [], "localaddresses": [] }
}
```

- `rpcPeers` is the node's `getpeerinfo` reply, passed through as-is.
- `activity`, `identity`, `ranking`, `wanted`, `budget` and `banned` come from the node log, and stay empty or `null` unless `BLOCKYARD_LOG_SOURCE=1`.
- `identitySource` names the source in use.

### `GET /api/net`

Bandwidth and disk, with every absent figure listed in words.

```json
{
  "node": "main",
  "measured": { "inBps": null, "diskWriteBps": null, "netTotalLog": null, "diskTotal": null,
                "avgRecv": null, "avgWrite": null, "floor": null, "poolMedian": null,
                "source": "getnettotals delta rate (RPC) — reported only while that counter moves; ...",
                "downloadMeasured": false },
  "rpc": { "totalRecv": 0, "totalSent": 0, "uploadtarget": { "...": "getnettotals uploadtarget" }, "uploadMeasured": false },
  "unavailable": [ "outbound bytes / upload rate: ...", "inbound bytes / download rate: ...", "log-only figures (...)" ],
  "peers": { "connections": 11, "in": 0, "out": 11, "wanted": null },
  "series": null,
  "formatted": { "inBps": null, "disk": null }
}
```

`inBps` / `outBps` are `null` (never `0`) while the node's byte counter reads zero.

---

## 11. Events

### `GET /api/events`

The monitor's own event feed: collector errors, quality flags, new tips, reorgs and so on. It is newest first and shared by all nodes; each row names its `node`. Rows of kind `index` mark the start, the finish and a failure of an address index build the server runs; the browser shows those three as notifications.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `since` | int | `0` | Return only rows with `seq` greater than this. |
| `limit` | int | `200` | 1–1000. |
| `source` | csv | `monitor` | `monitor`, `log`, …, or `all`. Node-log lines are excluded unless asked for. |
| `severity` | csv | — | For example `warn,error`. |
| `kind` | csv | — | For example `collector_error`. |
| `q` | string | — | Case-insensitive substring over `text`, `tag` and `kind`. |

```json
{
  "events": [
    { "seq": 194639, "source": "monitor", "kind": "collector_error", "severity": "warn",
      "tag": "collector", "ts": 1789107616900,
      "text": "getrawmempool verbose failed: RPC circuit breaker open; retry in 22s (...)",
      "node": "main" }
  ],
  "maxSeq": 194639,
  "count": 8
}
```

To poll incrementally, keep `maxSeq` and pass it back as `since`. The filters are applied to a window of `limit × 4` rows, and `count` is the number of matches in that window.

---

## 12. Markets

Exchange prices from the public REST APIs of Coinbase, Kraken, Bitstamp, Bitfinex and OKX. **This is the only outbound connection BlockYard makes that is not to the node.** It runs server-side, because the page's CSP allows `connect-src 'self'` only.

- **Off by default.** Polling runs only while the Display setting **Markets & Price → Enable market polling** is on (`markets.polling` in the shared settings file, read per request). With it off, both endpoints answer `{ "ok": true, "enabled": false, "polling": false, "note": "market polling is off ..." }`, the call parks the feed, and the monitor makes no outbound connection but to the node.
- `BLOCKYARD_MARKETS=0` (or `markets.enabled=false`) removes the feed altogether; both endpoints then answer `{ "ok": true, "enabled": false, "note": "market data is off on this server ..." }` whatever the setting.
- **On demand.** With polling on, nothing is fetched until someone calls `/api/markets` or `/api/markets/depth`. Each call "touches" the feed. The dashboard's Overview makes that call by default (Display settings → Markets & Price → Price line on Overview), so a monitor with anyone on its landing page is polling. While touched, it polls tickers every 15 s, hourly candles every 5 min and order books every 30 s. It stops 10 minutes after the last touch.
- An exchange that fails keeps its last data and reports `error`. It is never dropped or zero-filled.

### `GET /api/markets`

```json
{
  "ok": true, "enabled": true, "at": 1789155671855, "running": true,
  "interval": "1h", "tickerMs": 15000, "warming": false,
  "summary": { "median": 77282.55, "spread": 14.17, "vol24": 23204.09, "reporting": 4 },
  "exchanges": [
    { "id": "coinbase", "name": "Coinbase", "pair": "BTC-USD", "quote": "USD",
      "last": 77286.14, "bid": 77286.13, "ask": 77286.14, "spread": 0.01, "vol24": 7289.43,
      "change24": 0.00205, "high24": 79852.22, "low24": 76030,
      "at": 1789155664470, "stale": false, "error": null,
      "candles": [ { "t": 1788552000000, "o": 79808.55, "h": 79890, "l": 79680.01, "c": 79718.63, "v": 181.98 } ],
      "candlesAt": 1789155409559 }
  ]
}
```

- `summary.median` and `summary.spread` use USD-quoted exchanges only (OKX quotes USDT). Stale tickers are excluded. `reporting` is how many exchanges contributed.
- `stale` is `true` when the ticker is older than 3 × `tickerMs`.
- `change24` is a fraction, relative to the open of the first hourly candle within the last 24 h.
- `candles` are hourly, oldest first, up to 168 (7 days). `v` is in BTC.
- `warming` is `true` until any exchange has reported a price. The first call after an idle period usually returns `warming: true`.

### `GET /api/markets/depth`

The order books as cumulative depth on a fixed price grid, plus the snapshot from `ago` seconds earlier for comparison.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `ago` | seconds | `600` | One of `60`, `300`, `600`, `1800`, `3600`. Other values become 600. |

```json
{
  "ok": true, "enabled": true, "running": true, "bookMs": 30000,
  "at": 1789155680845, "thenAt": 1789155380703, "firstAt": 1789154211190, "ago": 300,
  "mid": 77276.995, "p0": 68000, "n": 372, "step": 50,
  "exchanges": [
    { "id": "coinbase", "name": "Coinbase", "quote": "USD",
      "bids": [ 1127.511, 1087.61, 1087.313, "..." ],
      "asks": [ null, null, null, "..." ],
      "thenBids": [ 1137.445, 1097.559, 1097.261, "..." ],
      "thenAsks": [ null, null, null, "..." ],
      "error": null, "bookAt": 1789155680841 }
  ]
}
```

- The grid is `price(i) = p0 + i × step` for `i` from 0 to `n - 1`. `step` is $50, and the grid spans ±12 % around the median mid across exchanges.
- `bids[i]` is the total BTC bid at or above `price(i)`. `asks[i]` is the total BTC asked at or below it.
- A value is `null` where that side has nothing to say: above the best bid, below the best ask, or past the end of a book the exchange cut short.
- `thenBids` / `thenAsks` are the older snapshot, re-aligned onto the current grid. They are `null` until an old enough snapshot exists. History is kept for about an hour.
- Before the first book poll completes, the answer is `{ ok, enabled, running, bookMs, "warming": true, "exchanges": [ { "id", "name", "error" } ] }`.

---

## 13. RPC console and the allowlist

### `POST /api/rpc`

Auth `any`, with CSRF when accounts are on. Runs one **read-only** RPC method against the node, through the same lane as the collectors.

| Body field | Type | Meaning |
|---|---|---|
| `method` | string | RPC method name. |
| `params` | array | Positional parameters. Anything that is not an array is replaced with `[]`. |

| Query | Meaning |
|---|---|
| `node` | Node id. |

Success:

```json
{ "ok": true, "node": "main", "method": "getblockcount", "ms": 314, "result": 966546, "note": null }
```

The node returned an error (still HTTP 200):

```json
{ "ok": false, "node": "main", "method": "getblock", "ms": 12,
  "error": { "message": "Block not found", "code": -5, "kind": "rpc" } }
```

The allowlist refused the method (HTTP 403):

```json
{ "error": { "message": "stop is not callable from the web UI: this method mutates state or monopolises the node's single-threaded RPC server",
             "kind": "api", "code": "rpc_denied" } }
```

`note` is set for methods the node itself documents as refused or worker-owned, so an error there is expected: `loadtxoutset`, `getopenrpcinfo`, `rpc.discover`, `exportasmap`, `getmemoryinfo`, `getblockfrompeer`, `preciousblock`, `pruneblockchain`, `submitheader`.

Every call, allowed or denied, is written to the audit log (method name, node, duration, and the error if any). Parameters are not recorded.

### How a method is classified (`server/rpc/allowlist.js`)

The default is **deny**. The rules are applied in this order, and the first match wins:

1. **Not a non-empty string**: denied.
2. **Exact deny list**: denied, even when the name looks like a read. The list:

   | Group | Methods |
   |---|---|
   | Wallet key material | `getnewaddress`, `getrawchangeaddress`, `keypoolrefill`, `addhdkey` |
   | Spends and broadcasts | `sendtoaddress`, `sendmany`, `send`, `sendall`, `sendrawtransaction`, `submitpackage`, `walletcreatefundedpsbt`, `fundrawtransaction`, `bumpfee`, `psbtbumpfee`, `signrawtransactionwithwallet` |
   | Wallet state | `walletpassphrase`, `walletlock`, `walletpassphrasechange`, `encryptwallet`, `setlabel`, `importprivkey`, `importaddress`, `importpublickey`, `importdescriptors`, `importmempool`, `importmulti`, `importprunedfunds`, `removeprunedfunds`, `createwallet`, `loadwallet`, `unloadwallet`, `restorewallet`, `migratewallet`, `setwalletflag`, `backupwallet`, `exportwatchonlywallet`, `abandontransaction`, `lockunspent`, `sethdseed`, `settxfee`, `signmessage`, `signrawtransactionwithkey`, `walletprocesspsbt`, `descriptorprocesspsbt` |
   | Peer / network control | `addnode`, `removeaddednode`, `disconnectnode`, `setban`, `clearbanned`, `setnetworkactive`, `ping` |
   | Chain / storage | `invalidateblock`, `reconsiderblock`, `preciousblock`, `pruneblockchain`, `submitblock`, `submitheader`, `stop`, `savemempool`, `dumptxoutset`, `loadtxoutset`, `simulateutxo` |
   | Heavy reads that monopolise the single-threaded RPC server | `rescanblockchain`, `scanblocks`, `scantxoutset`, `getdescriptoractivity`, `verifychain` |
   | Other | `logging` |

3. **Deny prefixes**: denied. The prefixes are `generate`, `invalidate`, `reconsider`, `import`, `send`, `set`, `unload`, `load`, `sign`. A node that adds vendor-prefixed commands of its own beyond Core's RPC set has the mutating shapes of those denied too, by the same rule.
4. `help` and `uptime` are allowed. `stop` is denied.
5. **Allow prefixes**: allowed. The prefixes are `get`, `list`, `estimate`, `verify`, `help`, `uptime`, `decoderaw`, `decodescript`, `createraw`, `analyzepsbt`, `decodepsbt`, `convertbits`, `getrpcinfo`. Where a node adds vendor-prefixed commands, its **read** verbs are admitted by name (its `get`/`list`/`estimate`/`verify` forms) and the bare vendor prefix is **not**, so a future vendor-prefixed `setban` cannot be pre-authorised.
6. **Anything else**: denied, with the message "not recognised as a read-only method; add it to server/rpc/allowlist.js if this is wrong".

Consequences worth knowing:

- The list is fixed in code, and no setting widens it.
- Wallet RPCs are refused by name, reads included (`getbalance`, `listunspent`, `listdescriptors`, `gethdkeys`, …): some of them return private keys, and the monitor has no use for a wallet.
- `createrawtransaction` is allowed: it only builds an unsigned transaction and changes nothing.
- `/api/config` → `allowlist` publishes a summary: the prefixes, the size of the deny list, the number of wallet methods refused, and the default decision.

Node writes never go through this endpoint. They are separate, opt-in actions (next section).

---

## 14. Node actions

A small, fixed set of node writes. They are off by default, each one must be listed explicitly, each is role-gated, needs a typed confirmation, and is audited.

| Action | RPC method | Minimum role | Args (body `args` keys) |
|---|---|---|---|
| `broadcast` | `sendrawtransaction` | operator | `hexstring`, `maxfeerate?` |
| `savemempool` | `savemempool` | operator | — |
| `testmempoolaccept` | `testmempoolaccept` | viewer | `rawtxs`, `maxfeerate?` |
| `verifychain_l1` | `verifychain` | admin | fixed to `[2, 6]` (checklevel 2, depth 6) |

To enable them: `BLOCKYARD_ENABLE_ACTIONS=1` and `BLOCKYARD_ACTIONS=broadcast,testmempoolaccept` (or `actions.enabled` / `actions.allow`). With accounts off they also need `BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1`. Enabling actions in open mode without that setting is a fatal configuration error at startup.

### `GET /api/actions`

```json
{
  "enabled": false,
  "allowed": [],
  "actions": [
    { "name": "broadcast", "label": "Broadcast a raw transaction", "note": "Pushes a signed transaction ...",
      "args": [ "hexstring", "maxfeerate?" ], "requiredRole": "operator",
      "enabled": false, "permittedForYou": false, "method": "sendrawtransaction" }
  ]
}
```

### `POST /api/action`

Auth `any` + CSRF.

| Body field | Type | Meaning |
|---|---|---|
| `action` | string | Action name. |
| `confirm` | string | Must equal `action` exactly. |
| `args` | object | Named arguments from the table, for example `{ "hexstring": "0200..." }`. Names ending in `?` are optional. |

| Query | Meaning |
|---|---|
| `node` | Node id. |

The checks run in this order, each a `403 action_denied` unless noted:

1. unknown action;
2. actions disabled;
3. accounts off without the writes override;
4. action not in the allow list;
5. caller's role below the action's role;
6. `confirm` missing or different: `400 confirm_required`.

```json
{ "ok": true, "action": "testmempoolaccept", "method": "testmempoolaccept",
  "result": [ { "txid": "aaaa...", "allowed": true } ] }
```

If the node refuses, the answer is `200` with `{ "ok": false, "action", "method", "error": { "message", "code" } }`.

---

## 15. Accounts, sessions, users and audit

These routes are meaningful only with accounts on (the default). In open mode they answer as noted.

The user object returned by these routes (`publicUser`):

```json
{ "username": "alice", "role": "operator", "id": "3f9a1c0b7d2e4a61", "disabled": false, "lastLoginAt": 1789150000000 }
```

### `POST /api/login`

Auth `none`, no CSRF. Body: `{ "username": "...", "password": "..." }` (JSON or form-encoded).

```json
{ "ok": true, "user": { "username": "alice", "role": "operator", "id": "3f9a1c0b7d2e4a61", "disabled": false, "lastLoginAt": 1789150000000 },
  "csrf": "Zk2c...base64url" }
```

It also sets the `blockyard_sid` and `blockyard_csrf` cookies. Errors:

| Status | `code` | Meaning |
|---|---|---|
| 400 | — | Username or password missing. |
| 401 | `bad_credentials` | Wrong password, unknown user or disabled account. The message is the same in all three cases. |
| 403 | `accounts_disabled` | Open mode. |
| 429 | `throttled` | The per-IP login bucket is empty. |
| 429 | `locked` | Too many failures for this username or address. |

### `POST /api/logout`

Auth `any` + CSRF. Ends the current session and clears both cookies: `{ "ok": true }`. In open mode it answers `{ "ok": true, "accounts": false, "note": "accounts are off, so there is no session to end" }`.

### `POST /api/logout-all`

Auth `any` + CSRF. Revokes every session of the calling user: `{ "ok": true, "revoked": 3 }`. In open mode: `403`.

### `GET /api/me`

Auth `any`. Returns who you are, your sessions, and what you may do. With accounts on:

```json
{
  "user": { "username": "alice", "role": "operator", "id": "3f9a1c0b7d2e4a61", "disabled": false, "lastLoginAt": 1789150000000 },
  "accounts": true,
  "sessions": [ { "createdAt": 1789150000000, "lastSeenAt": 1789155000000, "ip": "192.0.2.20",
                  "userAgent": "Mozilla/5.0 ...", "current": true } ],
  "actions": [ "... as in /api/actions ..." ],
  "capabilities": { "canCallRpc": true, "canAct": false, "actionsEnabled": false,
                    "allowedActions": [], "ceiling": "operator" }
}
```

In open mode: `"accounts": false`, `"sessions": []`, a `note`, and `capabilities` with `"ceiling": "viewer"`, `"canAct": false` and `"writesRequireAccounts": true|false`.

### `POST /api/password`

Auth `any` + CSRF.

| Body field | Meaning |
|---|---|
| `current` | Your current password. Required when changing your own. |
| `password` | The new password. |
| `username` | Admins only: change another user's password (no `current` needed). |

Password rules: at least 12 characters (`auth.minPasswordChars`), must not contain the username, must not start with a common breach-corpus word, and must not be a single repeated character.

On success, every session of the target user is revoked:

```json
{ "ok": true, "signedOut": true, "note": "sessions revoked; sign in again with the new password" }
```

A wrong `current` is `403`. A rule violation is `400`. In open mode: `403`.

### `GET /api/users`

Auth `admin`.

```json
{
  "users": [ { "id": "3f9a1c0b7d2e4a61", "username": "alice", "role": "operator",
               "createdAt": 1789000000000, "updatedAt": 1789000000000, "lastLoginAt": 1789150000000,
               "disabled": false, "scheme": "scrypt", "kdf": { "N": 16384, "r": 8, "p": 1, "keylen": 32 } } ],
  "roles": [ "viewer", "operator", "admin" ]
}
```

### `POST /api/users`

Auth `admin` + CSRF. Body: `{ "username", "password", "role"? }`. `role` defaults to `viewer`. Usernames are 2–31 characters of lowercase letters, digits, `.`, `-` and `_`.

```json
{ "ok": true, "user": { "id": "3f9a1c0b7d2e4a61", "username": "alice", "role": "operator" } }
```

A validation failure is a `400` with the reason.

### `POST /api/users/generate`

Auth `admin` + CSRF. Body: `{ "username", "role"? }`. Creates the user with a generated 18-character password that is **shown exactly once**:

```json
{ "ok": true, "user": { "id": "...", "username": "bob", "role": "viewer" },
  "password": "generated-once", "warning": "this password is shown once and is not stored in recoverable form" }
```

### `POST /api/users/:username/role`

Auth `admin` + CSRF. Body: `{ "role": "viewer" | "operator" | "admin" }`. Revokes the user's sessions.

```json
{ "ok": true, "user": { "id": "...", "username": "bob", "role": "operator" } }
```

Demoting the last enabled admin is refused with `400`.

### `POST /api/users/:username/disabled`

Auth `admin` + CSRF. Body: `{ "disabled": true | false }`. Disabling revokes the user's sessions.

```json
{ "ok": true, "user": { "id": "...", "username": "bob", "disabled": true } }
```

Disabling the last enabled admin is refused with `400`.

### `GET /api/audit`

Auth `admin`.

| Query | Default | Meaning |
|---|---|---|
| `limit` | `100` | 1–500. |

```json
{
  "entries": [ { "at": 1789155000000, "type": "rpc", "ok": true, "username": "alice", "node": "main",
                 "method": "getblockcount", "ms": 12, "ip": "192.0.2.20" } ],
  "limit": 100,
  "log": { "file": "audit.jsonl", "files": 1, "totalBytes": 20480, "currentBytes": 20480,
           "maxBytes": 8388608, "keep": 5, "rotations": 0, "rotationError": null, "headroomBytes": 8368128 }
}
```

The file rotates at 8 MB and keeps 5 files (`store.auditMaxBytes`, `store.auditKeep`). Entry `type` values: `login`, `login-throttled`, `logout`, `logout-all`, `kdf-upgrade`, `rpc`, `rpc-denied`, `action`, `action-denied`, `user-create`, `user-role`, `user-disabled`, `password-change`, `csrf-rejected`, `config-node`. Passwords are never recorded.

---

## 16. Telemetry and configuration

### `GET /api/telemetry`

The monitor's own health: process, RPC client, log tail, stream clients and the audit file.

```json
{
  "self": { "t": 1789155700000, "rssMb": 175.6, "heapMb": 42.8, "sseClients": 5, "usersActive": 0,
            "cpuPct": 2.71, "eventRate": 0, "build": "0.1.0-fd620adc52" },
  "nodes": [
    { "id": "main",
      "rpc": { "nodeId": "main", "url": "http://127.0.0.1:8332", "cookieSource": "...", "online": true,
               "lastGoodAt": 1789155699000, "lastError": null, "breakerOpen": false, "breaker": {},
               "queued": 0, "inFlight": 0, "maxInFlight": 4, "peakInFlight": 2, "recent": [ "..." ],
               "calls": 12345, "batches": 2345, "methods": {}, "errors": 3, "timeouts": 0,
               "authRetries": 0, "breakerTrips": 1, "lastLatencyMs": 8, "avgLatencyMs": 40,
               "maxLatencyMs": 4200, "ratePerSec": 1.8, "busyMsPerSec": 90, "staleDropped": 0 },
      "log": { "exists": false },
      "tiers": { "fast": 1789155699000 },
      "lastTier": {},
      "history": { "mempool": { "points": 5000, "firstAt": 1789000000000, "lastAt": 1789155699000,
                                "unattributed": 0, "nodes": [ "main" ] } } }
  ],
  "sse": { "clients": 1, "perClient": [ { "id": 1, "user": "anonymous", "seconds": 1666, "kb": 243531,
                                          "dropped": { "snapshot": 0, "series": 0, "events": 0 }, "node": "main" } ] },
  "audit": { "file": "audit.jsonl", "files": 1, "totalBytes": 20480, "...": "as in /api/audit log" }
}
```

In `nodes[].rpc`, `inFlight` is calls outstanding now, `maxInFlight` the lane's limit, and `peakInFlight` the most seen at once (the Node & RPC page shows `N of M (peak P)`).

### `GET /api/config`

The effective, non-secret configuration and the access posture.

```json
{
  "poll": { "fastMs": 4000, "midMs": 15000, "poolMs": 20000, "slowMs": 60000, "rareMs": 900000, "blockBackfill": 30 },
  "rpc": { "maxInFlight": 4, "minIntervalMs": 250, "maxRatePerSec": 4, "timeoutMs": 90000 },
  "allowlist": { "denyExactCount": 68, "walletDenied": 73, "allowPrefixes": [ "analyzepsbt", "convertbits", "..." ],
                 "denyPrefixes": [ "generate", "..." ], "defaultDecision": "deny" },
  "actions": { "enabled": false, "allow": [] },
  "retention": { "hours": 72, "ringCapacity": 20000, "events": 5000 },
  "access": { "mode": "accounts", "anonymous": false },
  "log": { "enabled": false },
  "sources": [ { "panel": "sync bar", "source": "getblockchaininfo blocks/headers + verificationprogress",
                 "note": "kept as two separate figures (rule 9)" } ]
}
```

In open mode (`BLOCKYARD_AUTH=0`), `access` is `{ "mode": "open", "anonymous": true, "role": "viewer", "writesAllowed": false }`. `sources` states which data source backs each dashboard panel in the current mode (log tail on or off). The numbers above are the shipped defaults.

### `POST /api/config/node/test` and `POST /api/config/node`

The Node connection form on Node & RPC. Auth `any` + CSRF; with accounts on, both need the `admin` role. Both take the same body and accept **only four fields** — `rpcUrl` (required, `http(s)://host:port`), `datadir`, `chainHint` (default: the current node's, else `main`) and `label`. `rpcUser`, `rpcPassword` and `cookieFile` are refused: authentication is the datadir cookie, and a password is not taken over an endpoint that can be run open. Without a `datadir` (given or already configured) and with no `cookieFile` configured, the answer is `400 need_datadir`; a bad URL is `400 bad_rpc_url`.

`/test` writes nothing. It probes `getblockchaininfo` with a throwaway client on its own lane (timeout at most 8 s). **Credentials go to one endpoint only**: the cookie is sent when `rpcUrl` equals the endpoint this monitor is already configured for, and to any other address the probe carries no `Authorization` header at all — a `401` from a new endpoint is reported as `ok: true, reachable: true, authenticated: false` with a `note`, since it proves an RPC server answered.

```json
{ "ok": true, "ms": 41, "authenticated": true, "chain": "main", "blocks": 966546, "ibd": false }
```

A failed probe is `200` with `{ "ok": false, "ms", "authenticated", "error": { "message", "kind", "code" } }`.

`/api/config/node` needs `"confirm": "save"` in the body (`400 confirm_required` otherwise) and merges the four fields onto `nodes[0]` of the configuration file, leaving every other key as it was; the file is written `0600` by temporary file, fsync and rename. A process started with `BLOCKYARD_CONFIG=none` has nowhere to save and answers `409 no_config_file`. The write is audited as `config-node`.

```json
{ "ok": true, "file": "/path/to/config/local.json", "restartRequired": true,
  "envOverrides": [ "BLOCKYARD_NODE_URL" ],
  "note": "saved, but this process takes its node from BLOCKYARD_NODE_URL, which the environment sets and which beats the file — ..." }
```

`envOverrides` lists the node environment variables currently set, because the environment is applied after the file and a restart would keep the old endpoint.

### `GET /api/settings` and `POST /api/settings`

The Display settings, kept on the server in `config/blockyard.json` (beside the configuration file) so every browser sees the same choices. The server stores the blob and nothing else: it has no schema, and `public/js/settings.js` clamps every value on the way in.

`GET` is auth `any`. Nothing saved yet is the normal first-run answer, not an error:

```json
{ "settings": { "version": 3, "space": { "...": "..." }, "...": "..." }, "file": "/path/to/config/blockyard.json", "stored": true }
```

With no file: `{ "settings": null, "file": "...", "stored": false }`; an unreadable file adds `"error": "unreadable: ..."`.

`POST` is auth `any` + CSRF, `admin` with accounts on. Body: `{ "settings": { ... } }` (an object; anything else is `400 bad_settings`). The serialised text is capped at 256 KB (`413 too_large`), and the file is written `0600` by temporary file, fsync and rename. Reply: `{ "ok": true, "file": "...", "bytes": 2431 }`.

---

## 17. The event stream: `/api/stream`

Server-Sent Events over plain HTTP: one-way, node to browser, with no WebSocket and no dependency. A browser `EventSource` reconnects on its own.

### Connecting

```
GET /api/stream?node=main
Accept: text/event-stream
```

- **Auth.** Open mode: anyone. Accounts on: a valid `blockyard_sid` cookie, otherwise `401` `{ "error": { "message": "authentication required", "kind": "auth" } }`.
- **Limit.** Each connection attempt spends one token from the stream bucket (section 1). An empty bucket answers `429` `{ "error": { "message": "too many streams", "kind": "ratelimited" } }`.
- **Node.** `?node=<id>` scopes the stream to one node. An unknown id is refused with `404` (`kind: "unknown_node"`), so a client pointed at a removed node gets a visible failure instead of a silent stream. Only `node` works here, not `nodeId`.
- **Headers.** `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-store, must-revalidate`, `Connection: keep-alive`, `X-Accel-Buffering: no` (so nginx does not buffer the stream).

**Always pass `?node=`.** `series` and `events` frames are delivered only to streams scoped to the node they belong to. A stream opened without `?node=` receives `snapshot` frames for every node, but no `series` or `events` frames.

### Frames

The stream opens with the comment line `: stream open`. After that:

| Event | `id:` | Cadence | `data` |
|---|---|---|---|
| `snapshot` | the global `seq` | at most 1/s per node, sent when a collector tier finishes | The same object as `GET /api/state` without `app` and `user`, and with the default series windows included. It is large: hundreds of KB with series. |
| `series` | — | every 20 s while any client is connected | `{ "node": "main", "series": { "mempool": { "hour": [ {"t","v"} ], "...": "..." }, "...": "..." } }` (the windows in section 5) |
| `events` | — | batched as they occur | An array of event rows, same shape as `/api/events` rows. Routine `raw`/`info` chatter is filtered out. |
| comment `: ping` | — | every 15 s | Heartbeat. There is no payload. |

Example wire format:

```
: stream open

id: 406
event: snapshot
data: {"id":"main","label":"Bitcoin Core","online":true,"chain":"main","tip":{"height":966546,...},"seq":406,...}

event: events
data: [{"seq":194640,"source":"monitor","kind":"tip_jump","severity":"info","ts":1789155700000,"text":"...","node":"main"}]

: ping

```

### Backpressure and reconnects

- **Backpressure.** Each client has at most one pending `snapshot` and one pending `series`, and the newest replaces an unsent older one. The event batch is capped: past 800 queued rows, the oldest 400 are dropped. `/api/telemetry` → `sse.perClient[].dropped` counts what was skipped. A slow client sees a coarser stream, not a growing queue.
- **Reconnects.** The server sends no `retry:` field, so clients use their default delay (about 3 s in browsers). `Last-Event-ID` is not replayed. After a reconnect, the next `snapshot` is the complete current state, and `/api/events?since=<last seq>` fills any gap in the event feed.
- **Dead connections.** A client socket that has closed is removed on the next write or heartbeat.

---

## 18. End-to-end examples

Get the current state of the primary node, without chart series:

```sh
curl -s 'http://127.0.0.1:21000/api/state?series=none' | jq '{height: .tip.height, sync: .sync.state, mempool: .mempool.count}'
```

Look up a transaction, first through search, then as a full page:

```sh
curl -s 'http://127.0.0.1:21000/api/x/search?q=9891f72bea4bc27b8dd3990295be331e5e9ae69bc152c5ad31862efbb624ae69'
# {"ok":true,"type":"tx","id":"9891f72b..."}

curl -s 'http://127.0.0.1:21000/api/x/tx?txid=9891f72bea4bc27b8dd3990295be331e5e9ae69bc152c5ad31862efbb624ae69' \
  | jq '{ok, fee: .tx.fee, feerate: .tx.feerate, height: .tx.height, usd}'
```

Stream live updates (`-N` turns off curl's buffering):

```sh
curl -sN 'http://127.0.0.1:21000/api/stream?node=main' | grep --line-buffered '^event:'
```

Query market depth. The first call starts exchange polling, and books appear within about 30 s:

```sh
curl -s 'http://127.0.0.1:21000/api/markets' > /dev/null
sleep 35
curl -s 'http://127.0.0.1:21000/api/markets/depth?ago=300' \
  | jq '{mid, p0, step, n, coinbase: (.exchanges[] | select(.id=="coinbase") | {bestBidDepth: (.bids | map(select(. != null)) | last), error})}'
```

Call a read-only RPC method (open mode):

```sh
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"method":"getblockchaininfo"}' http://127.0.0.1:21000/api/rpc | jq '.result.blocks'
```

With accounts on: sign in, keep the cookie, and send the CSRF token on mutating calls:

```sh
B=http://127.0.0.1:21000
CSRF=$(curl -s -c jar.txt -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"a long passphrase here"}' $B/api/login | jq -r .csrf)

curl -s -b jar.txt "$B/api/me" | jq .user
curl -s -b jar.txt -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"method":"getmempoolinfo"}' "$B/api/rpc" | jq .result.size
curl -sN -b jar.txt "$B/api/stream?node=main"
```

Poll the event feed incrementally:

```sh
SEQ=0
while sleep 10; do
  R=$(curl -s "http://127.0.0.1:21000/api/events?since=$SEQ&severity=warn,error")
  echo "$R" | jq -r '.events[] | "\(.ts) \(.severity) \(.text)"'
  SEQ=$(echo "$R" | jq .maxSeq)
done
```
