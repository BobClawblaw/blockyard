# Installing blockyard

This guide takes you from nothing to a monitor running as a service, reachable from the
machines you choose. Every setting mentioned here is described in full in
[CONFIGURATION.md](CONFIGURATION.md).

- [1. Requirements](#1-requirements)
- [2. Get the code](#2-get-the-code)
- [3. Try it without a node](#3-try-it-without-a-node)
- [4. Point it at your node](#4-point-it-at-your-node)
- [5. First run](#5-first-run)
- [6. Run it as a service](#6-run-it-as-a-service)
- [7. Decide who can reach it](#7-decide-who-can-reach-it)
- [8. Accounts (optional)](#8-accounts-optional)
- [9. HTTPS (optional)](#9-https-optional)
- [10. Behind a reverse proxy (optional)](#10-behind-a-reverse-proxy-optional)
- [11. Updating](#11-updating)
- [12. Uninstalling](#12-uninstalling)
- [Checklist](#checklist)

## 1. Requirements

| need | notes |
|---|---|
| **Node.js 22 or newer** | `node -v` must print `v22` or later. Older runtimes fail on syntax at start-up, which looks like a bug in the app. Install from [nodejs.org](https://nodejs.org), your distribution's backports, or a version manager such as `nvm`. |
| **A running Bitcoin node** | [Bitcoin Core](https://github.com/bitcoin/bitcoin) with its JSON-RPC server enabled -- your own build, a distribution package, or a node appliance such as [Umbrel](https://umbrel.com), [Start9](https://start9.com) or myNode. The monitor reads it; it does not manage it. |
| **RPC credentials** | Either read access to the node's cookie file (`<datadir>/<chain>/.cookie`, the usual case on the same machine) or an RPC user and password. |
| **Linux** (recommended) | Any OS with Node 22 runs it; the service instructions below assume systemd. |
| **Disk** | A few hundred MB at most for history, sessions and the audit trail (`./data` by default). |
| **A modern browser** | Any current Chrome, Edge, Firefox or Safari. The 3D views use a 2D canvas and run without WebGL; a GPU helps with the dense viewer mode. |

### Node indexes

**`txindex=1` is required for the explorer's transaction pages.** A transaction page asks the node
for `getrawtransaction <txid> 2` with no block hash, and a node without a transaction index can
only answer that for transactions still in its mempool — so without it, looking up a confirmed
transaction by id fails even though the node is perfectly healthy. Set it in `bitcoin.conf`:

```
txindex=1
```

Adding it to a node that has been running without it triggers a one-off reindex, which takes a
while and is unavoidable; the node reports progress, and `getindexinfo` tells you when it is
`synced`. Everything else in the monitor — the dashboard, block space, mempool, fees, peers,
mining, the block pages — works without it.

Two further indexes are genuinely optional:

- an **address index** — address pages (balance, received, transaction history);
- a **spent-output index** — "spent by" links on every output.

Pages that need an index the node does not have say so, rather than showing empty data.

**Outbound network access** is needed only for the Markets and Kiosk tabs and for the
explorer's dollar figures (HTTPS to five exchanges' public APIs). Everything else talks only
to your node. See [SECURITY.md](SECURITY.md#outbound-connections).

## 2. Get the code

```bash
git clone https://github.com/BobClawblaw/blockyard.git
cd blockyard
```

There is **no `npm install`** — the project has no dependencies. Optionally confirm your
runtime is good:

```bash
npm test
```

## 3. Try it without a node

```bash
npm run dev
```

This starts the monitor on <http://127.0.0.1:18088> against a built-in fake node that
simulates a node syncing, with no configuration file read. It is the quickest way to see
every page, and it is what the test suite uses. Stop it with `Ctrl-C`.

## 4. Point it at your node

Create `config/local.json` (it is git-ignored, so your settings never end up in a commit).

**Same machine, cookie authentication** — the common case. The monitor finds the cookie
at `<datadir>/<chainHint>/.cookie`:

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "My node",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/home/you/.bitcoin",
      "chainHint": "main"
    }
  ]
}
```

**Another machine, or user/password authentication:**

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "My node",
      "rpcUrl": "http://192.0.2.20:8332",
      "rpcUser": "monitor",
      "rpcPassword": "a long random password"
    }
  ]
}
```

Use the RPC port your node is configured with (`rpcport` in its configuration file; Core's
mainnet default is 8332). Any value you set in `config/local.json` or in the environment
overrides the built-in defaults.

**On a node appliance** (Umbrel, Start9, myNode), the node usually listens on the
appliance's LAN address with an RPC user and password rather than a cookie file you can
read, so use the `rpcUser` / `rpcPassword` form above and point `rpcUrl` at it.

**Several nodes** — add more entries to `nodes`; a node picker appears in the header and
every chart, table and stream is per node.

**The node's log.** The monitor works from RPC alone, and that is the supported mode.
**Log parsing does not currently support Bitcoin Core**: the parsers were written against an
experimental node with a different log grammar, and fed real Core `debug.log` lines they
extract no figures and misdate the entries (measured 2026-09-13). Leave `log.enabled` off --
it is off by default -- and ignore `logFile`. The Node & RPC page lists exactly which figures
each source provides.

## 5. First run

```bash
npm start
```

Watch the start-up lines. You should see the addresses it listens on, a line per node,
and — because accounts are off by default — a warning that names who can read the monitor.
Then open <http://127.0.0.1:21000>.

Check it from the shell:

```bash
curl -s http://127.0.0.1:21000/api/health
```

If a node shows as offline, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#a-node-shows-offline).

## 6. Run it as a service

1. **Create an account for it** that can read the node's cookie (and log, if you use it).
   Usually that means adding it to the node's group:

   ```bash
   sudo useradd --system --home /opt/blockyard --shell /usr/sbin/nologin blockyard
   sudo usermod -aG <node-group> blockyard
   ```

2. **Put the code somewhere stable**, for example `/opt/blockyard`, owned by that account:

   ```bash
   sudo git clone https://github.com/BobClawblaw/blockyard.git /opt/blockyard
   sudo cp config/local.json /opt/blockyard/config/   # the file from step 4
   sudo chown -R blockyard:blockyard /opt/blockyard
   ```

3. **Install the unit** shipped in `systemd/blockyard.service` and edit it:

   ```bash
   sudo cp /opt/blockyard/systemd/blockyard.service /etc/systemd/system/
   sudo systemctl edit --full blockyard
   ```

   Set `User=` / `Group=` to the account from step 1, `WorkingDirectory=` to where the code
   lives, and replace the `Environment=` lines that name paths with your own (or delete
   them and keep everything in `config/local.json`). Point `ExecStart` at an absolute Node
   22 binary — `/usr/bin/env node` can resolve to an older system Node under systemd:

   ```ini
   ExecStart=/usr/local/bin/node server/main.js
   ```

4. **Start it:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now blockyard
   journalctl -u blockyard -f
   ```

The unit restarts the monitor if it ever exits and gives it time to save its history on
shutdown. Stop and start with `systemctl stop|start blockyard`.

## 7. Decide who can reach it

Where the monitor listens is a security decision. Set `server.host` in `config/local.json`
(a string or a list) or `BLOCKYARD_BIND`:

| bind | who can connect | typical use |
|---|---|---|
| `"127.0.0.1"` | this machine only | reach it with an SSH tunnel: `ssh -L 21000:127.0.0.1:21000 you@host` |
| `"192.0.2.10"` (a LAN address) | anything that can route to that address | a home or office LAN |
| `["192.0.2.10", "198.51.100.7"]` | exactly those addresses | LAN plus a VPN such as Tailscale or WireGuard |
| `"0.0.0.0"` (the default) | every interface | behind a firewall you control |

Notes:

- Binding a single LAN address means `127.0.0.1` on the host itself stops answering — test
  with the address you bound.
- An address the machine does not have at start-up is skipped with a warning; start-up fails
  only if none of the listed addresses exist.
- A bind chooses a destination address, not an incoming interface. If "LAN only" must hold
  against containers or tunnels on the same host, add a firewall rule, for example:

  ```bash
  sudo ufw allow from 192.0.2.0/24 to any port 21000 proto tcp
  ```

- `server.allowCidrs` (or `BLOCKYARD_ALLOW_CIDRS=192.0.2.0/24,2001:db8::/32`) makes the
  monitor itself refuse clients outside those networks, as a second line of defence.

## 8. Accounts (optional)

By default anyone who can reach the port reads the monitor as a `viewer` — charts, the
explorer, the event stream, the read-only RPC console. User administration, the audit trail
and every node write stay closed.

To require sign-in, set `"auth": { "enabled": true }` or `BLOCKYARD_AUTH=1` and restart. The
first start with an empty data directory creates an `admin` account and prints its password
**once** in the log. Set your own instead with `BLOCKYARD_ADMIN_PASSWORD` for that first start.

Manage accounts from the Admin page, or from the shell — for example, to reset the admin
password:

```bash
node scripts/manage-users.js passwd admin
```

Roles: `viewer` reads; `operator` may also run node actions that you have enabled; `admin`
also manages users and reads the audit trail. Node actions are off unless you enable them
explicitly — see [SECURITY.md](SECURITY.md#node-writes).

## 9. HTTPS (optional)

Name a certificate and key and every listener serves HTTPS:

```bash
BLOCKYARD_TLS_CERT=/etc/blockyard/cert.pem BLOCKYARD_TLS_KEY=/etc/blockyard/key.pem npm start
```

or in `config/local.json`: `"server": { "tls": { "cert": "...", "key": "..." } }`.

A self-signed certificate is fine on a LAN (expect one browser warning per address):

```bash
sudo mkdir -p /etc/blockyard
sudo openssl req -x509 -newkey rsa:3072 -nodes -days 825 \
  -keyout /etc/blockyard/key.pem -out /etc/blockyard/cert.pem \
  -subj "/CN=blockyard" -addext "subjectAltName=IP:192.0.2.10,DNS:blockyard.lan.example"
sudo chown blockyard:blockyard /etc/blockyard/*.pem && sudo chmod 600 /etc/blockyard/key.pem
```

With TLS on, the session cookie is marked `Secure` and a short HSTS header is sent. A
half-configured pair (only a cert, or only a key) and an expired certificate stop the start-up
rather than silently serving plain HTTP.

## 10. Behind a reverse proxy (optional)

If you already run nginx, Caddy or similar, bind the monitor to `127.0.0.1` and let the proxy
terminate TLS. The live stream (`/api/stream`) is Server-Sent Events, so the proxy must not
buffer it. An nginx example:

```nginx
server {
    listen 443 ssl;
    server_name monitor.example.org;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:21000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /api/stream {
        proxy_pass http://127.0.0.1:21000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

Then set `"server": { "trustProxy": true }` so the monitor uses the forwarded client
address for rate limits and the CIDR gate, and `BLOCKYARD_SECURE_COOKIE=1` so the session
cookie is marked `Secure` behind the proxy's TLS.

## 11. Updating

```bash
cd /opt/blockyard
sudo -u blockyard git pull
sudo systemctl restart blockyard
```

Your `config/local.json` and `data/` directory are untouched by updates. Read
[CHANGELOG.md](../CHANGELOG.md) for anything that needs your attention. The browser picks
up new front-end files on the next page load; the header shows a notice when the page you
have open is older than the server.

## 12. Uninstalling

```bash
sudo systemctl disable --now blockyard
sudo rm /etc/systemd/system/blockyard.service && sudo systemctl daemon-reload
sudo rm -rf /opt/blockyard        # includes data/: history, accounts and the audit trail
sudo userdel blockyard
```

## Checklist

- [ ] `node -v` prints v22 or later for the account the service runs as
- [ ] `config/local.json` names your node's RPC URL and a readable cookie (or user/password)
- [ ] the start-up log shows the addresses you intended, and no node offline
- [ ] you have decided who can reach the port (bind, firewall, `allowCidrs`)
- [ ] accounts on if the port is reachable by people who should not see your node
- [ ] HTTPS on, or a proxy / tunnel in front, if the network is not trusted
- [ ] `BLOCKYARD_MARKETS=0` if the machine must make no outbound connections
