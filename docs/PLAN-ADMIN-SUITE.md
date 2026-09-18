# The Administrative Suite — a plan for running the node from the web

*Scoped 2026-09-18, before any code. Operator: "I want us to build an entire node and wallet
management interface into blockyard. It would have to be explicitly enabled and not default
behavior at all, and should require https and user authentication, unless the user explicitly
disables it. Let's add a complete user interface and required tabs, to support wallet and
transaction management, config settings editor, restart daemon...An entire administrative suite so
that we can use it 100% as a client via the web."*

Four decisions were taken at scoping time and the rest of this plan follows from them:

| | decision |
|---|---|
| wallet | **full hot wallet** — unlock and spend from the browser |
| daemon control | **`stop` RPC + the supervisor's own restart**; no sudo, no shell |
| config editor | **both** the node's `bitcoin.conf` and BlockYard's own config |
| action gate | **password re-entry** per sensitive action, with a short grace window |

## 1. What this changes, and what it costs

BlockYard is a monitor. Its security posture to date is that it cannot do harm because it cannot
do anything: reads only, wallet RPCs refused **by name** (`server/rpc/allowlist.js`,
`WALLET_METHODS` — audit finding M4 of 2026-09-16, added because `listdescriptors true` and
`gethdkeys {"private":true}` return private keys through read-shaped verbs), node writes off
unless `actions.enabled` and role-gated, and a config load that refuses to start if writes are
enabled while accounts are off.

This plan deliberately inverts that for an opt-in mode. It should be said plainly, once, at the
top: **after this lands, a bug in this web application can cost the operator money.** Every other
defect in this codebase has cost a wrong number on a panel. That is the difference, and it is the
reason the milestones below start with the refusals rather than the features.

What does *not* change: the default. A BlockYard that nobody configured is exactly what it is
today, and M0's job is to prove that with tests before any capability exists.

## 2a. Two builds, not one build with a switch

*Added 2026-09-18, after the first cut of §2. Operator: "we really need to think about
security for this. Im thinking we have two different builds entirely that get loaded. You
can either run the read only build like it is now, or you can run a full administrative
build. It should default to the read only build by default."*

There are two artifacts:

| | |
|---|---|
| `blockyard` | **read-only, the default.** `server/admin/` and `public/js/admin/` are **not in it** |
| `blockyard-admin` | the same monitor, plus the suite |

`scripts/build-edition.js` builds either; `npm pack` produces the read-only one, because
`package.json`'s `files` list carries `!server/admin/` and `!public/js/admin/`. The artifact
declares itself in `package.json` as `blockyardEdition`, which `server/edition.js` reads,
and which is **condition zero** of the gate chain below — checked before `admin.enabled`,
so an operator who sets `BLOCKYARD_ADMIN=1` on the read-only build is told the suite is not
*in* this build and what to install, rather than that it is switched off.

Why this and not only the runtime gate: a gate is code declining to run other code that is
sitting right there, one bug or one confused-deputy request away from running it. Code that
was never copied onto the disk has no such distance to travel. The runtime gate stays as
well — a git checkout has every file present, which is how the suite gets developed and
tested — so the two mechanisms cover different machines rather than duplicating each other.

`test/edition.test.js` builds both editions into a temp directory and reads back what
landed, rather than trusting this section.

## 2. The gate chain

Six conditions, every one of which must hold before a spend, a config write or a daemon action
executes. They are listed in the order the server checks them, and each has its own refusal
message naming the setting that would change it.

0. **The edition carries the suite at all** (§2a) — on the read-only build the rest of this
   list is moot, because there is nothing to load.
1. **`admin.enabled: false`** — a new config block, separate from `actions`, off by default.
2. **HTTPS** — refused over plain HTTP unless `admin.allowInsecure: true` is set deliberately.
   The reason is specific, not ritual: a wallet passphrase and an elevation password cross this
   connection. (Behind a reverse proxy that terminates TLS, `server.trustProxy` already exists;
   the check honours it.)
3. **Accounts on** — refused when `auth.enabled: false` unless `admin.allowWithoutAuth: true`.
   This mirrors the existing `actions.allowWritesWithoutAuth` precedent exactly: with no accounts
   there is no role to check, so the acknowledgement has to be its own separate word.
4. **Role** — `admin` for config and daemon control. Wallet access is a per-user capability flag
   (`walletAccess`) rather than a role, so "can watch the node" and "can spend" are different
   grants. Default off for every account including the bootstrap admin.
5. **Per-wallet opt-in** — `admin.wallets: []`. A wallet the operator has not named is not
   loadable, not listable and not spendable, whatever the RPC would allow.
6. **Elevation** — a fresh password re-entry, good for `admin.elevationMs` (default 5 minutes),
   required for every state change. The session gets you the UI; it does not get you the money.

Existing machinery this builds on rather than reinvents: CSRF double-submit
(`server/http/server.js`), `HttpOnly; SameSite=Strict; Secure` session cookies, the login
throttle, the audit trail with its redaction tests, CSP with per-response nonces, and the
`actions` allow/deny vocabulary.

## 3. What a hot wallet in a browser actually risks

Stated as failure scenarios, each with the answer this design gives it. A mitigation that is not
listed here does not exist.

| the way the money leaves | what stops it |
|---|---|
| XSS executes a spend with the user's session | Elevation: the password is not in the DOM, not in a cookie, and expires. CSP already forbids inline script and third-party origins; the suite adds no CDN, no framework, no build step — the same zero-dependency rule that makes this codebase auditable is a security control here |
| Stolen session cookie (borrowed laptop, backup, XSS exfiltration) | Elevation again, plus per-action audit and a visible session list with revoke |
| CSRF from another tab | Double-submit token + `SameSite=Strict`, already in place and tested |
| The passphrase lingers in the node after unlock | `walletpassphrase` is called with the shortest viable timeout and `walletlock` runs in a `finally`, so an error path cannot leave the wallet open. The passphrase is never stored, never logged, never audited, and is redacted from every error object |
| A typo or a swapped address sends to the wrong place | The confirm screen shows the decoded destination, amount, fee and total from the **built transaction**, not from the form; you confirm what will actually be broadcast |
| Malware rewrites the address in the page before you confirm | Not fully solvable in a browser, and the docs will say so. Partially answered by `admin.addressBook` — a named allowlist where a destination outside it needs an extra typed confirmation |
| A compromised BlockYard drains everything at once | `admin.spendCap` per action and per rolling 24 hours, enforced server-side, changeable only on disk |
| The admin UI is reachable from the internet | Refuses to enable while bound to a public address unless `admin.allowPublicBind: true`; the banner says what is exposed |

**The one that has no mitigation**, and belongs in the docs rather than in a table: a hot wallet
is a hot wallet. If the coins matter more than the convenience, the watch-only + PSBT shape is
still the better instrument, and M4 is built so that the PSBT path exists underneath the spend
path rather than beside it.

## 4. The RPC surface

`server/rpc/allowlist.js` is **not loosened**. The RPC console keeps its deny-all posture and its
`WALLET_METHODS` refusal, because the console is a free-form command box and M4's reasoning about
it is unchanged.

The suite gets its own `server/rpc/admin-allowlist.js`: explicit method lists grouped by
capability (`wallet.read`, `wallet.receive`, `wallet.spend`, `node.control`), reachable only
through the typed admin routes, never through the console, each entry carrying a one-line note on
why it is there. Anything not named is denied, as before.

## 5. The tabs

Seven, and the first four are the suite proper:

- **Wallet** — balances per wallet, receive (labelled addresses with a QR), send, history with
  confirmations, UTXOs with coin control, labels.
- **Transactions** — decode a raw transaction or PSBT, paste and broadcast, bump a fee, watch a
  broadcast reach the mempool and then a block. The PSBT tools work with no wallet loaded at all.
- **Node** — daemon state, uptime, the restart/stop controls of §6, peers and bans, the version
  and build.
- **Config** — the two editors of §7, side by side, each with its own diff and backup.
- **Security** — the audit trail with filters, active sessions with revoke, accounts and roles,
  the `walletAccess` grants, and a plain-English summary of which gates in §2 are currently open.
- *(existing)* Overview, Explorer, Peers, Mempool, Diversions — untouched.

The suite is one route tree (`/admin/*`) that does not load at all when §2 is not satisfied, so a
default install serves none of it.

## 6. Daemon control

`stop` is in `DENY_EXACT` for the console and stays there; the admin path calls it directly.
BlockYard then waits for the RPC to stop answering, and for the supervisor to bring the node back.

**BlockYard cannot promise the node returns**, and the UI must say that rather than imply it. The
node's config gains `supervisor: "systemd:bitcoind"` (or `"none"`), and the control panel:

- reads it and shows what will happen in words before the button is live;
- refuses the restart entirely when `supervisor: "none"` — a stop with nothing to restart it is a
  shutdown, and it will be labelled Shut down, not Restart;
- requires typed confirmation (the node's id) for both;
- polls afterwards and reports "back at height N in 41 s", or says it has not returned.

No sudo, no shell, no privileged helper anywhere in the design. That is the whole point of taking
the RPC route: a bug in this web application reaches the node's RPC, not the machine.

## 7. The two config editors

**`bitcoin.conf`** — parsed into key/value with section awareness, validated against a table of
known keys, written through a timestamped backup (`bitcoin.conf.bak-<stamp>`, the convention
`scripts/setup.js` already uses), with a diff preview and an explicit "this needs a restart to
apply" banner naming the keys that changed. Keys that can lock the operator out or widen exposure
— `rpcauth`, `rpcpassword`, `rpcallowip`, `bind`, `rpcbind`, `prune`, `txindex`, `wallet` — are
flagged in the diff and need their own confirmation.

**BlockYard's own config** — `local.json` and the display settings, with one carve-out that
matters:

> **The `admin` block itself is not editable from the web.** The suite cannot widen its own gates,
> grant `walletAccess`, raise `spendCap` or turn off `requireHttps`. Those change on disk, by
> someone with shell access, and the editor shows them read-only with a note saying so.

A suite that can edit the settings that restrain it is not restrained. (This is the same reasoning
that stops an agent granting itself permissions, and it is worth stating in the file rather than
leaving to be rediscovered.)

## 8. Milestones

Each lands on its own branch, with tests, and each is useful on its own.

- **M0 — the gates, and nothing else.** The `admin` config block, the six checks of §2, the
  refusal messages, the boot banner, and `test/admin-disabled.test.js`: a standing proof that a
  default install serves no admin route, that every gate refuses in isolation, and that the RPC
  console's wallet refusal is untouched. No capability ships in M0.
- **M1 — elevation and the shell.** Password re-entry, the grace window, the audit entries, the
  `/admin` tab shell with everything empty. Nothing to steal yet, which makes it the right time
  to get the mechanism right.
- **M2 — wallet, read-only.** Balances, UTXOs, history, labels, descriptors (public only —
  `listdescriptors` without `true`, and a test that pins it). Per-wallet opt-in enforced.
- **M3 — receive.** `getnewaddress` with labels. The first write, and the smallest possible one.
- **M4 — send.** Build (`walletcreatefundedpsbt`) → confirm from the built transaction → elevate
  → unlock → sign → broadcast → lock, with caps, address book and the full audit trail. The PSBT
  sits underneath, so "build and sign elsewhere" is a supported path from day one.
- **M5 — transaction tools.** Decode, paste-and-broadcast, fee bump, coin control.
- **M6 — daemon control.** §6, including the supervisor preflight and the "it did not come back"
  case.
- **M7 — the config editors.** §7, both of them, with the `admin`-block carve-out.
- **M8 — the fourth security audit**, run over the whole suite the way 2026-09-16's was run over
  the monitor, plus the user guide, and a re-run of the M0 proofs.

## 8a. What was built overnight, 2026-09-18

M0–M3 are merged to main; M4, M6 and M7 are on `admin-m4-send` and wait for a read.

| | state | where |
|---|---|---|
| M0 gates + two editions | **merged** | `server/edition.js`, `server/admin-gate.js`, `scripts/build-edition.js` |
| M1 elevation + `walletAccess` | **merged** | `server/admin/elevation.js` |
| M2 wallet, read-only | **merged** | `server/admin/wallet.js`, `server/rpc/admin-allowlist.js` |
| M3 receive | **merged** | `server/admin/receive.js` |
| M4 send | **branch** | `server/admin/send.js` + a regtest end-to-end test |
| M5 transaction tools | not started | — |
| M6 daemon control | **branch** | `server/admin/daemon.js` |
| M7 config editors | **branch** | `server/admin/config-edit.js` |
| M8 security audit | not started, deliberately | to be read awake |

Two corrections to this plan, made because the code disagreed with it:

1. **§2.6 said elevation is required for every state change**, which the first
   implementation read as "consume it when the request arrives". That meant a mistyped
   confirmation cost the operator their password and taught them to re-type it without
   reading — the precise habit the mechanism exists to prevent. Elevation is now consumed
   at the **point of no return**, by the handler, immediately before the irreversible call.
2. **The "weighty keys" list in §7 originally included `dbcache` and `maxconnections`.**
   Neither can lock anyone out or open anything up. An acknowledgement asked for a
   performance knob is an acknowledgement people learn to click through, which spends the
   attention the mechanism is there to buy.

## 9. Non-goals

No seed generation, no key display, no `dumpprivkey`, no `sethdseed`, ever. No wallet backup
download (a file of keys over HTTP is a worse idea than it sounds; `backupwallet` to a server path
may be reconsidered in M8). No hardware wallet integration in this plan. No multisig ceremony. No
new runtime dependencies — the zero-dependency rule is load-bearing for auditability.

## 10. Open decisions for the operator

1. **Who may spend** — is `walletAccess` grantable to an `operator`, or `admin` only?
2. **Spend caps** — a default cap, or unlimited until configured? (Recommendation: a per-action
   cap must be set before the first spend works at all, so the decision is made once, deliberately,
   rather than discovered.)
3. **Address book** — required for destinations, or advisory?
4. **Mainnet gate** — should the first spend on `chain=main` need a second, differently-worded
   confirmation than on testnet/signet?
5. **TOTP** — declined at scoping in favour of password re-entry. Worth revisiting at M8 as an
   addition rather than a replacement.
