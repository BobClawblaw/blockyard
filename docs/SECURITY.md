# Security and privacy

BlockYard watches a Bitcoin node and shows what it sees to the people you let in. This
page describes the access model, what protects it, and exactly what leaves your machine.
To report a vulnerability, see [SECURITY.md](../SECURITY.md) at the repository root.

- [Threat model in one paragraph](#threat-model-in-one-paragraph)
- [Access: sign-in by default, open on request](#access-sign-in-by-default-open-on-request)
- [Accounts, sessions and passwords](#accounts-sessions-and-passwords)
- [Talking to the node](#talking-to-the-node)
- [Node writes](#node-writes)
- [Network exposure](#network-exposure)
- [Transport security](#transport-security)
- [Browser security](#browser-security)
- [Outbound connections](#outbound-connections)
- [What is stored, and where](#what-is-stored-and-where)
- [Hardening checklist](#hardening-checklist)

## Threat model in one paragraph

The monitor is a **reader**. It holds your node's RPC credentials, so the main risks are:
someone using the monitor to make the node do something (prevented: writes are off, the RPC
console is read-only behind a default-deny allowlist), someone reading your node's state who
should not (controlled by where it listens, a CIDR gate, and optional accounts), and the
monitor leaking information about you to third parties (limited to the on-demand market data
connections listed below, which you can turn off). The monitor does not hold keys, and every
wallet RPC is refused by name (since 2026-09-16; before that, wallet reads such as
`listdescriptors` passed the allowlist's `list` prefix, see the audit of that date).

## Access: sign-in by default, open on request

**Out of the box the monitor listens on `127.0.0.1` only and requires sign-in.** The first
start creates an `admin` account and prints its password once (or takes it from
`BLOCKYARD_ADMIN_PASSWORD`). Reach it from another machine over an SSH tunnel
(`ssh -L 21000:127.0.0.1:21000 you@host`), or bind a LAN address with `BLOCKYARD_BIND` /
`server.hosts` once you have decided who may see it. These are the defaults since
2026-09-15; 0.0.9 shipped bound to every interface with no sign-in, which the first outside
review rightly called out.

Open access is still available as a posture you choose: with `auth.enabled: false`
(`BLOCKYARD_AUTH=0`), anyone who can reach the port reads the monitor with the fixed role
`viewer`:

| open to anyone who can reach the port | still closed |
|---|---|
| every chart, the sync view, the event stream | user administration |
| peer, mempool, block and transaction detail, the explorer | the audit trail |
| the read-only RPC console (behind the allowlist) | password changes and sessions |
| the live Server-Sent Events stream | **every node write**, even if actions are enabled |
| Display settings (they are normalised before use) | the node connection form, except from this machine's loopback address (`auth.openNodeConfigFromNetwork` widens it) |
| the event feed, without the log source's rows | the node log feed: `/api/events?source=all` is refused and `raw`-kind rows are dropped (`auth.openEventsFromNetwork` restores it) |

The `viewer` ceiling cannot be raised by configuration or by any credential while accounts
are off. The start-up log states which addresses are readable and how to close them, so
"anyone on the LAN can read your node" is never a surprise.

With sign-in on (the default; `BLOCKYARD_AUTH=1` restores it after an override), roles:

| role | may |
|---|---|
| `viewer` | read everything above |
| `operator` | also run node actions that have been explicitly enabled |
| `admin` | also manage users and read the audit trail |

The last enabled admin cannot be demoted, disabled or deleted.

## Accounts, sessions and passwords

- **Passwords** are hashed with scrypt (N=16384, r=8, p=1 by default), with a per-user salt;
  a 12-character minimum and common breach-corpus shapes are refused. Passwords are never
  logged, never returned by any API, and stored only as hashes. Each user's scrypt
  parameters are stored with the hash; raising them in the configuration upgrades an
  account on its next successful sign-in.
- **Sessions** use 32-byte random tokens, stored hashed, in an `HttpOnly`, `SameSite=Strict`
  cookie (`Secure` over HTTPS). A session ends 8 hours after its last request, and 72 hours
  after sign-in whatever happens.
  Roles are re-read on every request, so a demotion takes effect immediately.
- **CSRF**: every state-changing request must carry an `X-CSRF-Token` header matching the
  session; the cookie alone is never accepted as proof. With accounts off, or for `/api/login`
  itself (which by definition has no session yet), there is no token to compare -- and until
  2026-09-13 that meant those routes had no cross-site protection at all. An audit proved it
  with a working exploit against the node-connection test. Every state-changing request with no
  session -- open-mode writes and `/api/login` alike -- is refused instead whenever its `Origin`
  is not this server, or its `Sec-Fetch-Site` says cross-site (a second audit, 2026-09-22, found
  `/api/login` had been left out of this check: a cross-site auto-submitting form could log a
  visitor's browser into an attacker-chosen account). A client that sends neither header (curl, a
  script) is not stopped by that check, which only guards against what a *browser* can be made to
  do. So the one form where a script could do real harm, the node connection (a saved
  address decides where the node's cookie goes after a restart, and its test makes the server
  connect somewhere), answers only a loopback caller while accounts are off (audit 2026-09-16).
  A save that moves the node to a different host drops the old endpoint's `rpcUser`,
  `rpcPassword` and `cookieFile`, and a test of a foreign endpoint reports the kind of failure,
  never what the endpoint answered.
- **Brute force**: sign-in is locked after 8 failures in 5 minutes per username and per
  address, for 10 minutes, with the same error and the same hashing time for unknown users
  and wrong passwords. A separate throttle limits sign-in attempts per address, because each
  attempt costs a deliberately expensive hash.
- **Rate limits** apply per client address.
- **Slow and stalled clients** cannot hold memory or connections: a request, body included, must
  arrive within 30 seconds; an event stream whose reader stops reading is sent nothing more until
  it drains, and is dropped when 4 MB is buffered or it stays blocked for a minute; one address
  (or account) holds at most 16 streams. Free-form audit fields are clamped to 1,024 characters,
  so a caller cannot rotate real events out of the trail.

## Talking to the node

- **Read-only allowlist, default deny.** The RPC console and every internal call go through
  an allowlist: read-shaped methods are allowed; every wallet method (reads included, since some
  return private keys), spending, peer-control, chain-mutating and very heavy methods are refused
  by name — including `getnewaddress` and
  `getrawchangeaddress`, which start with "get" but create keys. Unknown methods are refused.
- **The refusal does not depend on every caller remembering to check first** (audit 2026-09-22, M1).
  The allowlist above is enforced at the HTTP route; the administrative suite (which does call
  wallet methods, deliberately, when it ships at all — see the next section) has its own separate
  capability check. Both sit in front of `RpcClient`, the actual transport — but `RpcClient` itself
  now refuses any wallet-classified method outright unless the caller explicitly marks the call
  `adminAuthorized: true`, which only the suite's one gated call site ever sets. So a method that
  moves funds or reveals keys cannot leave this process through any code path, present or future,
  that skips both of those checks — the transport itself is the backstop, not just the route.
- **A bounded lane per node.** At most `rpc.maxInFlight` requests at once (four by default, one
  for a node configured as single-threaded), their starts spaced by a minimum interval and a
  calls-per-second ceiling, with batching, priorities and a stale-drop rule. It cannot be used to
  flood your node. The one exception is the address index build,
  which makes its few cheap calls (block hashes) over a second connection so that the pages are
  not queued behind it — and which pauses itself whenever the first lane sees the node failing
  or answering slowly.
- **The block files are read directly** (`<datadir>/blocks`), once, to build the address
  index; the node is not asked for them. The index directory is written by the build and by the
  follower, and nothing else in the node's data directory is ever written.
- **Credentials** are read from the cookie file on demand (it changes on every node restart)
  or from the configured user and password. They are never sent to the browser.

## Node writes

Node actions (for example `savemempool`) are **off**. Enabling one requires all of:

1. `BLOCKYARD_ENABLE_ACTIONS=1`,
2. the action named in `BLOCKYARD_ACTIONS` (a comma-separated list),
3. accounts on and a role of at least `operator` — or the deliberate
   `BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1`, which exists so that the combination can only ever
   be chosen on purpose,
4. a typed confirmation that matches the action's name, per call.

Every call and every refusal is appended to the audit trail.

## Network exposure

- **Bind** only the addresses you mean to serve (`server.host`, a string or a list). See
  [INSTALL.md](INSTALL.md#7-decide-who-can-reach-it) for the options and their consequences.
- A bind chooses a destination address, not an incoming interface; use a firewall if "LAN
  only" must hold against containers or tunnels on the same machine.
- **CIDR gate**: `server.allowCidrs` refuses clients outside the listed IPv4/IPv6 networks.
  Membership is computed on the address bytes, and a malformed entry stops the start-up
  rather than silently admitting or refusing everyone.
- `/api/health` needs no sign-in, so an uptime probe works. It reveals the node inventory,
  version, tip and health to anyone who can reach the port.
- Behind a reverse proxy, set `server.trustProxy` so rate limits and the CIDR gate see the
  real client address — and only then.

## Transport security

- HTTPS is the default on **every** listener. With no certificate named, the server makes its
  own self-signed one on first start (`server/tls/selfsigned.js`, under `<data>/tls/`, the key
  mode 600, ECDSA P-256), naming the addresses it is reached on, and remakes it when it nears
  expiry or stops naming a bound address; the log prints its fingerprint. A certificate of your
  own replaces it (`BLOCKYARD_TLS_CERT`/`_KEY`); a half-configured pair or an expired
  certificate stops the start-up. `BLOCKYARD_TLS=0` is plain HTTP, for a proxy in front.
- A self-signed certificate proves nothing about who you are talking to the first time; it
  does encrypt the session and pins the fingerprint after that. Compare the fingerprint the
  log prints with the one the browser shows before trusting it on a network you do not own.
- Over HTTPS the session cookie is `Secure` and `Strict-Transport-Security` is sent with a
  two-day lifetime, without `includeSubDomains` or `preload` — a LAN address can be reissued,
  and HSTS cannot be withdrawn once a browser has it.
- Plain HTTP is acceptable for a trusted LAN or behind a tunnel; the start-up log says when
  it is serving plain HTTP.

## Browser security

- **Content Security Policy**: `default-src 'self'`, `frame-ancestors 'none'`, scripts only
  from the monitor itself plus a per-response nonce, and **no inline styles at all**
  (`style-src 'self'` with no attribute exception). Every data-driven style is applied through
  the CSSOM instead of `style="…"` attributes.
- Also sent: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`.
- The browser loads nothing from third parties: no CDN, no web fonts, no analytics. Market
  data reaches the browser only through the monitor's own API.

## Outbound connections

Everything in the monitor talks only to your node, **except**:

| when | to | what is sent |
|---|---|---|
| only with **Enable market polling** ticked in Display settings (**off by default**), while someone has the **Markets**, **Kiosk** or **Overview** tab open — Overview's price line reads the same feed unless you switch it off — and for 10 minutes after the last request | `api.exchange.coinbase.com`, `api.kraken.com`, `www.bitstamp.net`, `api-pub.bitfinex.com`, `api.gemini.com`, `www.okx.com` (HTTPS) | public ticker, candle and order-book requests with a `User-Agent` naming the software — nothing about your node |
| with polling on, when someone opens an **explorer** page or the **Mining** tab and no fresh market price is at hand | two of the exchanges above, at most once a minute | a public ticker request |

**Out of the box none of this happens**: polling is off until someone ticks **Display settings → Markets & Price → Enable market polling**, and until then the
Markets and Kiosk tabs say so and the explorer shows no dollar figures. The switch is a Display
setting shared by every screen, so anyone who can change settings on this monitor can turn it
on; `BLOCKYARD_MARKETS=0` (or `"markets": { "enabled": false }`) removes the feed from the
server so that no checkbox can. With polling on, nothing is fetched when nobody is looking. Your machine's public address is visible to those exchanges
when a request is made, as with any web request.

The monitor sends no telemetry, checks for no updates, and phones home to no one.

## What is stored, and where

Everything the monitor writes lives in its data directory (`./data` by default,
`BLOCKYARD_DATA` to move it):

| file | contents | sensitivity |
|---|---|---|
| `users.json` | account names, roles, scrypt hashes and salts | **secret** (mode 0600) |
| `sessions.json` | hashed session tokens | **secret** |
| `user-settings.json` | Display settings saved under "My account" (GET/POST `/api/settings/mine`, 2026-09-22): one blob per signed-in user, keyed by account id, open to any role -- not the shared blob below. Dropped for an account by `node scripts/manage-users.js rm` | private (mode 0600); no secrets, no RPC access, just colours and switches |
| `audit.jsonl` (+ rotations) | who called what and when; rotated by size (8 MiB, 5 kept); hash-chained (each entry's `hash` covers the one before it), so an entry edited or removed in place breaks the chain from there on -- `npm run verify-audit` (or `blockyard verify-audit`) checks it. Tamper-evident, not tamper-proof: there is no secret key, so someone with write access to `data/` who regenerates the whole chain leaves no trace this alone can catch | private |
| history snapshots | chart time series for the retention window (72 h by default) | private |
| `pool-aliases.json`, `pool-map.json` | optional mining-pool labels: `pool-aliases.json` is human-edited; `data/pool-map.json` is what `node scripts/pool-map.js` fetches, and it overrides the curated `config/pool-map.json` that ships with the code (mempool.space/mining-pools, MIT, 151 pools) | not secret |
| the address index (`addressIndex`, `data/index` by default) | the explorer's address index: ~124 GB of sorted rows built from the node's block files, plus the follower's `live.log` and `layers/` | public chain data, not secret |

`config/local.json` may hold an RPC password; keep it readable only by the service account.
Both it and `data/` are git-ignored. Display settings (the gear) have three stores, picked per
browser (2026-09-22): "Shared" -- the pre-2026-09-22 default -- in `config/blockyard.json`, so
every browser sees the same board (write needs admin once accounts are on); "This browser", kept
only in that browser's own localStorage and never sent to the server at all; and "My account", the
`user-settings.json` row above, open to any signed-in role and following that account across
devices. All three change how things are drawn, never what is measured.

Logs go to standard output (the systemd journal). They record requests, node state changes
and errors; they never contain passwords, session tokens or RPC credentials.

## Hardening checklist

- Run as a dedicated, unprivileged account that can read only the node's cookie and its
  `blocks/` directory (and log), and write only its own `data/` and the index directory. The
  shipped systemd unit enforces the write half (`ProtectSystem=strict` with `ReadWritePaths=` for
  `data/`, `config/` and the index) and drops capabilities, system calls and address families the
  monitor does not use; add your index directory to it.
- Point `addressIndex` (or `--out`) at a new or empty directory. The build refuses a symlink, the
  filesystem root, a home or working directory, the node's blocks directory, and any directory
  holding files an index does not write; it only ever removes its own files.
- Bind the narrowest set of addresses that serves your users; add a firewall rule if needed.
- Turn accounts on if anyone who can reach the port should not see your node.
- Use HTTPS, a reverse proxy, or an SSH tunnel on untrusted networks.
- Leave node actions off unless you have a specific need, and then enable only that action.
- Set `BLOCKYARD_MARKETS=0` on machines that must not make outbound connections: the polling checkbox (off by default) then cannot turn the feed on.
- Keep `config/local.json` and `data/` readable only by the service account.
- Keep Node.js current within the 22.x line or later.
