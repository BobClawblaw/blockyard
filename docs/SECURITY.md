# Security and privacy

bmcmonitor watches a Bitcoin node and shows what it sees to the people you let in. This
page describes the access model, what protects it, and exactly what leaves your machine.
To report a vulnerability, see [SECURITY.md](../SECURITY.md) at the repository root.

- [Threat model in one paragraph](#threat-model-in-one-paragraph)
- [Access: open by default, accounts on request](#access-open-by-default-accounts-on-request)
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
connections listed below, which you can turn off). The monitor does not hold keys and has no
wallet access.

## Access: open by default, accounts on request

With the default `auth.enabled: false`, anyone who can reach the port reads the monitor
with the fixed role `viewer`:

| open to anyone who can reach the port | still closed |
|---|---|
| every chart, the sync view, the event stream | user administration |
| peer, mempool, block and transaction detail, the explorer | the audit trail |
| the read-only RPC console (behind the allowlist) | password changes and sessions |
| the live Server-Sent Events stream | **every node write**, even if actions are enabled |

The `viewer` ceiling cannot be raised by configuration or by any credential while accounts
are off. The start-up log states which addresses are readable and how to close them, so
"anyone on the LAN can read your node" is never a surprise.

Set `BMC_MON_AUTH=1` (or `"auth": { "enabled": true }`) to require sign-in. Roles:

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
  cookie (`Secure` over HTTPS). Sessions expire after 8 hours, with a 72-hour idle ceiling.
  Roles are re-read on every request, so a demotion takes effect immediately.
- **CSRF**: every state-changing request must carry an `X-CSRF-Token` header matching the
  session; the cookie alone is never accepted as proof. With accounts off there is no session
  to ride, so the check does not apply.
- **Brute force**: sign-in is locked after 8 failures in 5 minutes per username and per
  address, for 10 minutes, with the same error and the same hashing time for unknown users
  and wrong passwords. A separate throttle limits sign-in attempts per address, because each
  attempt costs a deliberately expensive hash.
- **Rate limits** apply per client address.

## Talking to the node

- **Read-only allowlist, default deny.** The RPC console and every internal call go through
  an allowlist: read-shaped methods are allowed; wallet, key-material, spending, peer-control,
  chain-mutating and very heavy methods are refused by name — including `getnewaddress` and
  `getrawchangeaddress`, which start with "get" but create keys. Unknown methods are refused.
- **One request at a time.** The node's RPC server is single-threaded, so the monitor runs a
  single serialized request lane with a minimum spacing, batching, priorities and a stale-drop
  rule. It cannot be used to flood your node.
- **Credentials** are read from the cookie file on demand (it changes on every node restart)
  or from the configured user and password. They are never sent to the browser.

## Node writes

Node actions (for example `savemempool`) are **off**. Enabling one requires all of:

1. `BMC_MON_ENABLE_ACTIONS=1`,
2. the action named in `BMC_MON_ACTIONS` (a comma-separated list),
3. accounts on and a role of at least `operator` — or the deliberate
   `BMC_MON_ALLOW_WRITES_WITHOUT_AUTH=1`, which exists so that the combination can only ever
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

- HTTPS is built in: name a certificate and key and **every** listener serves HTTPS. A
  half-configured pair or an expired certificate stops the start-up; a certificate close to
  expiry starts with a warning, and the log prints its fingerprint.
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
  `Referrer-Policy: no-referrer`.
- The browser loads nothing from third parties: no CDN, no web fonts, no analytics. Market
  data reaches the browser only through the monitor's own API.

## Outbound connections

Everything in the monitor talks only to your node, **except**:

| when | to | what is sent |
|---|---|---|
| while someone has the **Markets** or **Kiosk** tab open, and for 10 minutes after the last request | `api.exchange.coinbase.com`, `api.kraken.com`, `www.bitstamp.net`, `api-pub.bitfinex.com`, `www.okx.com` (HTTPS) | public ticker, hourly candle and order-book requests with a `User-Agent` naming the software — nothing about your node |
| when someone opens an **explorer** page and no fresh market price is at hand | two of the exchanges above, at most once a minute | a public ticker request |

Nothing is fetched when nobody is looking. Your machine's public address is visible to those
exchanges when a request is made, as with any web request. To make **no** outbound connections
at all, set `BMC_MON_MARKETS=0` (or `"markets": { "enabled": false }`): the Markets and Kiosk
tabs then say that market data is off, and the explorer shows no dollar figures.

The monitor sends no telemetry, checks for no updates, and phones home to no one.

## What is stored, and where

Everything the monitor writes lives in its data directory (`./data` by default,
`BMC_MON_DATA` to move it):

| file | contents | sensitivity |
|---|---|---|
| `users.json` | account names, roles, scrypt hashes and salts | **secret** (mode 0600) |
| `sessions.json` | hashed session tokens | **secret** |
| `audit.jsonl` (+ rotations) | who called what and when; rotated by size (8 MiB, 5 kept) | private |
| history snapshots | chart time series for the retention window (72 h by default) | private |
| `pool-aliases.json`, `pool-map.json` | optional, human-edited mining-pool labels | not secret |

`config/local.json` may hold an RPC password; keep it readable only by the service account.
Both it and `data/` are git-ignored.

Logs go to standard output (the systemd journal). They record requests, node state changes
and errors; they never contain passwords, session tokens or RPC credentials.

## Hardening checklist

- Run as a dedicated, unprivileged account that can read only the node's cookie (and log).
- Bind the narrowest set of addresses that serves your users; add a firewall rule if needed.
- Turn accounts on if anyone who can reach the port should not see your node.
- Use HTTPS, a reverse proxy, or an SSH tunnel on untrusted networks.
- Leave node actions off unless you have a specific need, and then enable only that action.
- Set `BMC_MON_MARKETS=0` on machines that must not make outbound connections.
- Keep `config/local.json` and `data/` readable only by the service account.
- Keep Node.js current within the 22.x line or later.
