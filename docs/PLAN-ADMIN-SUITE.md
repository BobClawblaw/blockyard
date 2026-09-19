# The Administrative Suite — a plan for running the node from the web

*Scoped 2026-09-18. M0–M3 (the gates and two editions, elevation, the read-only wallet, receive)
are merged to main, where they stay in git only. The suite is excluded from the npm tarball and
the Docker image, and `build-edition.js` refuses `--edition admin` without `--unreleased`, so
released builds are read-only. M4 to M7 are on the `admin-m4-send` branch, not merged; M8 is not
started (§8a, §11).* *Operator: "I want us to build an entire node and wallet
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

Both editors are **refusal-first** since the review of 2026-09-19. The first cut refused only
the `admin` block and acknowledged everything else, and "everything else" turned out to include
a way to point the node editor at `~/.bashrc`, a section name written raw into the file (one
field could add any line), `rpcallowip` behind a checkbox, and `server.trustProxy` and
`auth.enabled` in BlockYard's own file -- the settings that switch off the HTTPS and accounts
gates of §2. Operator decisions, 2026-09-19:

> (1) The web config editor may NOT touch RPC credentials or binding, and may not redirect
> which file it writes.
>
> (4) BlockYard's own config editor edits only an ALLOWLIST of display and polling settings;
> everything else is locked like the admin block.

**`bitcoin.conf`** -- always `<datadir>/bitcoin.conf`; a node `confFile` that names another
file is a refusal to read or write, not a choice. The file must be a regular file (a symbolic
link is refused, and opened with `O_NOFOLLOW` so one swapped in is an error). Parsed with
section awareness, written back through a backup (`bitcoin.conf.bak-<stamp>-<random>`, 0600,
from the same bytes the diff was computed on), atomically, **with the original's mode, owner and
group** -- and refused, before anything is touched, when the monitor cannot give the new file
the old one's owner (not root, and not the owner). Only changed lines are re-rendered; the rest
stay byte for byte, CRLF included.

- **Refused outright** (`key-refused`), in every spelling -- global, section-qualified
  (`main.rpcallowip`) and negated (`norpcallowip`): `rpcauth`, `rpcuser`, `rpcpassword`,
  `rpcbind`, `rpcallowip`, `rpcport`, `rpccookiefile`, `rpccookieperms`, `rpcwhitelist`,
  `rpcwhitelistdefault`, `server`, `rest`, `includeconf`, `conf`, `datadir`, `walletdir`,
  `blocksdir`, `whitebind`, `whitelist`, `chain`, `testnet`, `testnet4`, `regtest`, `signet`,
  `signetchallenge`, `signetseednode`, `zmqpub*`. They are the path around every wallet gate in
  this suite, or they move or lock out the node, and they are edited by hand on the machine.
  Added to the operator's list for a worse reason: the `*notify` keys and `signer` (each runs
  a command as the node's user) and `debuglogfile`, `pid`, `settings`, `ipcbind` (paths the
  node writes to).
- **Acknowledged by exact name** (`acknowledge` must be a list; a string was a substring
  test): `bind`, `listen`, `onlynet`, `proxy`, `onion`, `tor`, `listenonion`, `torcontrol`,
  `externalip`, `discover`, `prune`, `txindex`, `blockfilterindex`, `coinstatsindex`,
  `assumevalid`, `reindex`, `reindex-chainstate`, `wallet`, `disablewallet`. Resource knobs
  (`dbcache`, `maxconnections`, `maxuploadtarget`) are not, so the acknowledgement keeps its
  meaning.
- A section is one of `main`, `test`, `testnet4`, `signet`, `regtest`. A new global key goes
  above the first section header (appended to the end it would be inside the last section).
  A key that appears more than once in its scope is refused ("edit by hand").
- `rpcauth`, `rpcuser`, `rpcpassword` and `torpassword` values are masked in the text, the
  settings list and every diff. Reading is admin-role, not elevated: after masking, nothing in
  it is a credential.

**BlockYard's own config** -- the loaded config file's own JSON (never the in-force config,
whose defaults and env values would be frozen into the file), patched leaf by leaf, only
where the leaf is on the allowlist (`SELF_EDITABLE` in `server/admin/config-edit.js`, with a
type and a range each): `poll.*`, `markets.*`, `store.retentionHours`/`ringCapacity`/
`maxEventLog`/`blockMapCap`/`snapshotEveryMs`, `log.staleMs`/`healthMs`. Anything else is
refused naming the key (`setting-locked`), and the whole patch with it.
`__proto__`/`constructor`/`prototype` are refused at any depth, and `server/config.js` skips
them when it merges a file.

> **The `admin` block itself is not editable from the web.** The suite cannot widen its own gates,
> grant `walletAccess`, raise `spendCap` or turn off `requireHttps`. Those change on disk, by
> someone with shell access, and the editor shows them read-only with a note saying so. Since
> 2026-09-19 the same holds for `auth`, `server`, `actions`, `nodes`, `rpc` and every path or
> credential: they are the gates the admin block stands on.

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

M0–M3 are merged to main; M4–M7 and the suite's screens are on `admin-m4-send`. They were read
on 2026-09-19 (§8b) and every finding was fixed on the branch.

| | state | where |
|---|---|---|
| M0 gates + two editions | **merged** | `server/edition.js`, `server/admin-gate.js`, `scripts/build-edition.js` |
| M1 elevation + `walletAccess` | **merged** | `server/admin/elevation.js` |
| M2 wallet, read-only | **merged** | `server/admin/wallet.js`, `server/rpc/admin-allowlist.js` |
| M3 receive | **merged** | `server/admin/receive.js` |
| M4 send | **branch** | `server/admin/send.js` + a regtest end-to-end test |
| M5 transaction tools | **branch** | `server/admin/txtools.js` + a regtest test |
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

## 8b. The read, 2026-09-19

Four parallel reviews (send; transaction tools; daemon and config editors; the screens and new
routes), each finding reproduced against a throwaway regtest node or confirmed in the code before
it counted, then fixed on three branches merged into `admin-m4-send`, each fix with a test that
failed first. What they found, in the order of what it could cost:

- **The config editor could reach the machine.** A section name was written into
  `bitcoin.conf` unvalidated (a newline in it wrote any line), the file written was whatever
  `confFile` said and the self-editor could set that, the "weighty key" acknowledgement missed
  `main.`-qualified spellings, and the node's RPC credentials went to the browser. Fixed: only
  `<datadir>/bitcoin.conf`, opened `O_NOFOLLOW`, mode and owner kept or the write refused;
  sections are the five networks; credentials are redacted.
- **The caps could be raced and dodged.** The 24h cap was checked, then five RPC awaits, then
  recorded: two confirms at once both passed (305,640 sat out under a 250,000 cap). The paste box
  decided "ours" from `listunspent`, which leaves out coins already spent in the mempool or
  locked (10 BTC and 49.999 BTC went out uncapped), and asked only the request's wallet. Fixed:
  check-and-reserve in one synchronous step; ownership from each input's parent transaction
  across every named wallet; the Send phrase on pasted spends; one elevation, one action.
- **A second build could replace a send already reported sent**, and a broadcast that timed out
  was neither counted nor recorded. Fixed: a build locks its coins (released on cancel, expiry
  or a failure before broadcast); the txid is recorded before broadcasting and an ambiguous
  outcome says "may have been broadcast".
- **The QR codes could not be scanned**: the Reed-Solomon remainder read the generator backwards,
  and versions 7–10 lacked their version blocks. The tests had passed because their reader
  shared the blind spots. Now checked against ISO/IEC 18004's worked example, and 176 of 176
  symbols decode in OpenCV (0 before).
- Smaller: amounts under 100 sat threw (JavaScript prints them in exponent form); the fee-bump
  dialog could sign a rate other than the one it priced; the wallet on screen could differ from
  the one a send was built from; the wallet relock could be dropped by a busy lane.

**Decisions taken with the fixes (operator, 2026-09-19).** (1) The web config editor does not
touch RPC credentials, binding, or anything that says which file is written: `rpcauth`,
`rpcuser`, `rpcpassword`, `rpcbind`, `rpcallowip`, `server`, `includeconf`, the chain switches,
`zmqpub*`, the `*notify` commands and the rest are refused in every spelling, to be edited by
hand. (2) The wallet passphrase is required for every send, paste-box spend and fee bump on an
encrypted wallet, and one signing operation runs at a time per wallet. (3) `admin.wallets`
entries name their node, `{ "node", "wallet" }`; a bare name only works with one node
configured. (4) BlockYard's own config editor changes only an allowlist of polling, markets,
storage-tuning and log-timing settings; everything else is locked like the `admin` block.

## 11. Releases, while this is being built

*Operator, 2026-09-18: "Nobody should ever use the wallet build for now, and we should
exclude it from shipping entirely. It will need a lot of work before it's ready to ship
publicly."*

**The rule: releases continue as normal, and they are read-only releases.** Nothing about
the release process changes, because the suite is excluded from every artifact rather than
held on a branch that someone has to remember not to merge.

Four exclusions, each of which fails on its own:

| artifact | what excludes the suite |
|---|---|
| npm tarball (`npm pack`, `npm publish`) | `package.json` `files`, with `!` negations for every path in `ADMIN_PATHS` |
| container image (Umbrel) | `.dockerignore` — Docker never reads `files`, and `umbrel/Dockerfile` does `COPY server ./server` |
| a built edition | `scripts/build-edition.js` refuses `--edition admin` without `--unreleased` |
| the registry | the admin artifact is marked `private: true`, which `npm publish` refuses outright |

`ADMIN_PATHS` in `scripts/build-edition.js` is the single definition, and
`test/release-guard.test.js` fails if any of the four drifts from it — including a new file
that *looks* like suite code but sits outside the listed paths, which is how
`server/rpc/admin-allowlist.js` was caught shipping.

**What a released build does when someone asks for the suite.** It says the suite is not in
this build and names the edition that has it (`server/edition.js`, `server/admin-gate.js` —
both ship for exactly this reason). A setting that is silently ignored teaches people the
switch is broken; one that explains itself teaches them it is absent.

**What ships today**, with M0–M3 merged: nothing user-visible. The gate chain and the
elevation machinery are on `main`, excluded from artifacts, default-off, and inert — a
released `blockyard` behaves exactly as it did before this work started, which is the
property `test/admin-disabled.test.js` exists to hold.

**Before it can ship publicly**, at minimum: M8's security audit over the whole surface;
the operator's own use of it on a real wallet for long enough to trust it; the open
decisions in §10; and a deliberate decision about whether it ships as a second artifact at
all or stays a private build. None of that is close, and the exclusions above mean none of
it is blocking a release of the monitor.

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
