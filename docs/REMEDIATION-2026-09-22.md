# Remediation — Security Audit of 2026-09-22

> **STATUS: APPLIED — 2026-09-22, branch `main`, 13 commits (12 fixes, one shared test file).**
> Every finding in `docs/SECURITY-AUDIT-2026-09-22.md` is fixed here: 1 HIGH, 4 MEDIUM,
> 10 LOW/informational — 15 findings in total, none left open. Each fix has a regression test
> that failed against the pre-fix code, gathered in one file for the round
> (`test/audit-2026-09-22.test.js`, 20 tests) the way earlier rounds' test files did. Full
> suite: 1468 tests, 0 failures, after every fix and after `npm run counts:fix`. Nothing in
> this round was pushed past this box; `main` is ahead of `origin/main` and stays that way
> until the operator says so.

- **Audit:** `docs/SECURITY-AUDIT-2026-09-22.md`, same session, same day.
- **Repo state at the start of remediation:** `main` @ `dbc19b8`.
- **Method:** every fix was implemented, then checked against the real, running tree — not
  just the new unit test. Three of these were verified against genuinely external state: M1
  against a real regtest node's wallet flow (not a mock), L2/D1 against the actual shipped
  `DOOM.EXE`/`QUAKE.EXE`/`WOLF3D.EXE`, and L5 against this box's own real, pre-existing
  56-entry `data/audit.jsonl` — which is exactly what caught a real bug in the first cut of
  that fix (see L5 below) before it ever shipped.

---

## H1 (HIGH) — the reverse-proxy nginx example overwrote X-Forwarded-For instead of replacing it

**Finding.** `docs/INSTALL.md`'s worked nginx config used `$proxy_add_x_forwarded_for`, which
appends the real client's address onto whatever `X-Forwarded-For` the client already sent
rather than replacing it. `clientIp()` (`server/http/server.js`) trusts the *first* entry of
that header once `server.trustProxy` is on — so a client sending a forged
`X-Forwarded-For: 203.0.113.6` kept that value as the trusted address, walking past the CIDR gate,
every per-address rate limit, and the audit trail's own attribution. The danger was already
correctly written down in `docs/CONFIGURATION.md` ("only set `trustProxy` if the proxy
overwrites `X-Forwarded-For`") — the worked example three files away just didn't follow its own
rule.

**Fix.** `docs/INSTALL.md`'s nginx snippet now uses `X-Forwarded-For $remote_addr` (overwrite,
correct for this deployment shape — a single directly-connected trusted hop), with a comment
explaining why and what to do differently for a real multi-hop chain. `docs/SECURITY.md`'s CSRF
section and `clientIp()` itself were not touched — the bug was in the doc an operator would
actually copy, not in the code's own (correct) contract.

**Commit:** `4955196`. **Held by:** *"H1: the reverse-proxy nginx example overwrites
X-Forwarded-For, not appends to it"*.

---

## M1 (MEDIUM) — the admin-suite's read-only guarantee depended on every caller checking first

**Finding.** The admin suite is excluded from every release artifact by file *path* pattern
(`test/release-guard.test.js`'s `ADMIN_PATHS`), not by *capability* — none of the four exclusion
mechanisms inspects file content. Worse, the actual transport, `RpcClient`, enforced nothing at
all: the read-only console's allowlist is checked at the HTTP route, and the admin suite's own
capability gate (`adminCallAllowed`) is checked in `walletCall` — but a hypothetical new module
anywhere in the tree, importing `RpcClient` directly and calling `rpc.call('sendtoaddress', ...)`,
would have reached the node with nothing in its way.

**Fix.** `RpcClient.batch()` — the one function every RPC call in the process funnels through,
`call()` and `walletCall()` alike — now refuses any `WALLET_METHODS`-classified call outright,
before any network request is built, unless the caller passes `adminAuthorized: true`. That flag
is set in exactly one place, `walletCall` (`server/admin/wallet.js`), itself already gated on
`adminCallAllowed`. The read-only guarantee no longer depends on every present and future caller
remembering to check an allowlist first — it depends on the transport every caller has to pass
through regardless. The path-pattern exclusion (`ADMIN_PATHS`) stays as it was; this is a second,
independent layer under it, not a replacement.

**Verified against a real node**, not a mock: `test/admin-money-regtest.test.js`,
`test/admin-send-regtest.test.js` and `test/admin-txtools-regtest.test.js` (33 + others, all
passing) exercise real wallet flows against a regtest `bitcoind` through the new gate — proving
`adminAuthorized: true` actually gets legitimate calls through, not just that unauthorized ones
are refused.

**Commit:** `743f11e`. **Held by:** *"M1: RpcClient itself refuses a wallet method with no
adminAuthorized flag..."* and *"M1: every method the admin suite can call, and only those..."*.

---

## M2 (MEDIUM) — `manage-users.js passwd` didn't revoke the account's existing sessions

**Finding.** The CLI tool documented as the lost-password/locked-out recovery path — and
unavoidably also what an operator reaches for during a *suspected compromise* — left every
existing session for the account valid for up to 72 hours (the absolute session TTL) after a
password reset, with only a printed reminder to "sign them out from the UI if needed." Not a real
option when the reason you're on the CLI is that you don't trust the account to sign anyone out
from. `/api/password`, the web route for the same operation, already revoked.

**Fix.** `passwd` now calls the same session-revocation path the web route uses and reports how
many sessions were signed out. `disable` had the identical gap (the *web* route for disabling a
user does revoke; the CLI command did not) and got the same fix, for consistency, though its real
severity was lower — `resolveSession` already refuses a disabled user's session on the very next
request regardless, so the CLI gap there was a hygiene issue (a stale, unusable session entry
left in `sessions.json`), not an access-control bypass the way `passwd`'s was.

**Commit:** `ccf645c`. **Held by:** *"M2: manage-users.js passwd and disable revoke the account's
existing sessions"* — a real subprocess integration test, not a unit test: it spawns the actual
CLI, feeding its hidden-password prompt one character per tick (the prompt reads stdin as a real
terminal delivers keystrokes, not as a single bulk pipe write delivers a string — discovered
while writing this test, see below).

---

## M3 (MEDIUM) — `/api/login` had no cross-site protection of any kind (login CSRF)

**Finding.** `server/http/server.js` ran two cross-site checks — a session-bound double-submit
token check, and an Origin/Sec-Fetch-Site fallback for routes with no session — both gated on
`route.csrf === true`. `/api/login` is `csrf: false`, correctly for the token check (there's no
session yet to double-submit against), but that also exempted it from the fallback check, which
doesn't need a session either. A cross-site auto-submitting `<form method=post
action=".../api/login">` with an attacker's own credentials in hidden fields logged the victim's
browser into the attacker's account: `SameSite=Strict` governs sending an *existing* cookie
cross-site, not accepting a `Set-Cookie` from this same-site-destination POST.

**Honest impact, unchanged from the audit:** no privilege escalation demonstrated — the attacker
needs an account already (no open self-registration exists) — but a real, concrete violation of
the module's own stated invariant, with a plausible confused-deputy consequence (a victim who
unknowingly saves data, such as a node connection with RPC credentials, into the attacker's
account instead of their own).

**Fix.** The Origin/Sec-Fetch-Site check now runs for every mutating request (`req.method` not
`GET`/`HEAD`) with no session, regardless of `route.csrf` — which is exactly every route reachable
unauthenticated that changes state, login included.

**Commit:** `7c399d7`. **Held by:** *"M3: a cross-site POST to /api/login is refused (login
CSRF), with accounts on or off"* and *"M3: a same-site login POST ... is unaffected"* (the second
test exists specifically to prove the fix didn't also break ordinary sign-in).

---

## M4 (MEDIUM) — SSE responses skipped the app's own security headers

**Finding.** `/api/stream` was the one response type that never carried `securityHeaders()` —
CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` — that
every other response path (HTML, JSON, error pages, the games route) already applies uniformly.

**Fix.** `StreamHub.add()` takes a `headers` option now; `server.js` passes it the same
`securityHeaders({ tls, hstsMs })` result every other path uses, so there is exactly one policy,
not a second copy that can drift from the first.

**Commit:** `7c399d7` (same commit as M3 and L3/D2 — all three touch `server/http/server.js`).
**Held by:** *"M4: an SSE response carries the same security headers every other response does"*.

---

## L1 (LOW) — a dead, misleadingly-written exception in the RPC deny-prefix rule

**Finding.** `classifyMethod`'s deny loop read `&& !ALLOW_PREFIXES.includes(method)`, which reads
as "unless the method is also allow-prefixed" but is an exact-string match against short prefix
strings (`'get'`, `'list'`, ...) — never true for a real method name, so the exception could not
fire. Harmless today (the deny list was *stricter* than the comment implied) but a landmine: a
future edit "fixing" it into an actual prefix test would have reopened every deny-prefixed method
whose name happens to also start with an allow-prefix entry.

**Fix.** Removed. A method starting with a deny prefix is denied, full stop.

**Commit:** `ba2eb14`. **Held by:** *"L1: the RPC allowlist's deny-prefix rule has no exact-match
exception left to misread as a prefix test"*.

---

## L2/D1 (LOW) — the DOS executable loaders didn't validate header fields against file length

**Finding.** `dospc.js`'s LE (DOS/4GW) and COFF (DJGPP) loaders trusted structural header
fields — page counts, object base addresses, section counts/offsets/sizes — against nothing.
Low severity under the real trust model (`games/` holds only the operator's own shareware, served
through a path-traversal-free route), but genuinely undocumented: a different operator dropping
an untrusted `.EXE`-shaped file in `games/` got no validation at all, an absurd page count was an
effectively unbounded loop, and a corrupted object base reaching past the 32 MB emulated memory
only failed because `Uint8Array#set` happens to throw on an out-of-range destination.

**Fix.** Both loaders now check every header-derived range against the file's real length and the
machine's real memory before using it, throwing a specific, named error instead of hanging or
silently copying short. Verified two ways: the real shipped `DOOM.EXE`/`QUAKE.EXE`/`WOLF3D.EXE`
still boot unaffected (`test/dos-pc.test.js`, 19/19, including full headless game boots), and
truncated copies of the real files — which used to silently short-copy — now throw the new, named
error consistently across several truncation points.

**Commit:** `377c91d`. **Held by:** *"L2/D1: a truncated LE (DOS/4GW) executable is refused with
a named reason..."* and *"L2/D1: a truncated COFF (DJGPP) executable is refused..."*.

---

## L3/D2 (LOW) — `/games/*` had no rate limit or throughput cap

**Finding.** Unlike `/api/stream` (a per-key stream cap) and login (a three-tier throttle),
`/games/*` had nothing pacing repeat requests for an 18 MB file — flagged as an open scope
question more than a confirmed bug, since it might simply match the rest of the static-file
server's posture for any large asset.

**Resolution.** Given a dedicated cap, matching the pattern used elsewhere for size-heavy routes:
a third `RateLimiter` (`app.gamesLimiter`, 40-request burst refilling at 1/second) now gates the
route, sized to comfortably cover a real page load (Wolfenstein alone is half a dozen small
files) with room to spare.

**Commit:** `7c399d7`. **Held by:** *"L3/D2: /games/* is rate-limited, like every other
size-heavy route"*.

---

## L4 (LOW/INFORMATIONAL) — no COOP/CORP headers

**Finding.** No `Cross-Origin-Opener-Policy` or `Cross-Origin-Resource-Policy`. Not exploitable
today — no `SharedArrayBuffer` anywhere in the codebase, confirmed by grep, so nothing needs
cross-origin isolation — but cheap, standard defense-in-depth.

**Fix.** Both added, `same-origin`.

**Commit:** `cdca41b`. **Held by:** *"L4: COOP and CORP are sent same-origin..."*.

---

## L5 (LOW/INFORMATIONAL) — the audit trail had no tamper-evidence

**Finding.** `audit.jsonl` was plain newline-delimited JSON with filesystem permissions (0600) as
its only protection — nothing detected an entry edited or removed in place. Not a broken promise
(never claimed as a property anywhere), but worth closing given the module's own stated bar ("a
multi-user webserver... must not be the soft spot").

**Fix.** Every appended row now carries `hash`: sha256 of the previous row's `hash` plus this
row's own canonical (key-sorted) JSON content. A new `verifyChain()` walks the file — or the whole
retained rotation chain — recomputing that and reports the first row that no longer matches,
naming the exact file and line. `adopt()` (called on every boot) picks the chain back up from
whatever `hash` is actually on the last line on disk, so a restart continues the chain instead of
resetting it. `node scripts/verify-audit.js` (also `npm run verify-audit`, and `blockyard
verify-audit` from a global install) checks it without the server running.

**Stated honestly, in the code and in `docs/SECURITY.md`:** there is no secret key — one stored on
the same machine an attacker with `data/` write access already reaches would prove nothing extra.
This is **tamper-evident**, not tamper-proof: it catches a partial edit (one line changed or
removed without regenerating everything after it — the realistic shape of accidental corruption,
a bug elsewhere writing where it shouldn't, or a lazy tamper attempt), not someone with full
read/write access to `data/` who bothers to regenerate a self-consistent chain from scratch.
Closing that residual gap needs an independent, externally-stored checkpoint (an operator copying
a chain-tip hash off-box, or a remote log sink) — a deployment choice, not something this file can
manufacture alone.

**A real bug this caught before it shipped.** The first cut of `verifyChain()` crashed
(`TypeError: The "data" argument must be of type string...`) the moment it was run against this
box's own real `data/audit.jsonl` — 56 entries written before this fix existed, none carrying a
`hash` field. `prev` (initialized to `null`, correctly skipping verification for the very first
entry) was being set to `row.hash`, which is `undefined` for a pre-migration row — and
`undefined !== null` is `true` in JavaScript, so the *second* pre-migration entry tried to verify
against `undefined` and `crypto.createHash().update(undefined)` threw. Fixed by treating a missing
`hash` field as a fresh starting point (falling back to a fixed genesis value) exactly the way
`adopt()` already does when the last entry on disk predates chaining — the same rule applied
consistently in both places, so the first entry appended after an upgrade verifies correctly
against what `adopt()` actually seeded it from. This is exactly why the fix was checked against
real, pre-existing on-disk data rather than only synthetic test fixtures.

**Commit:** `1151deb`. **Held by:** the four *"L5: ..."* tests — clean-chain verification,
tamper detection naming the exact line, restart continuity, and the pre-existing-data migration
case that caught the bug above.

---

## L6 (LOW/INFORMATIONAL) — IPv6 rotation degraded the login-throttle tiers

**Finding.** `LoginGuard`'s per-`(username, address)` and per-address buckets keyed on the full
address; a routed IPv6 /64 (trivially available from many providers) gets a fresh bucket on every
host-suffix rotation, degrading (not bypassing — the per-username-across-every-address tier still
catches a sustained attack) those two finer-grained tiers.

**Fix.** Bucket keys now collapse an IPv6 address to its /64 — the way an ISP actually allocates
one — before keying. IPv4 and the audit trail's recorded address are untouched.

**Commit:** `daf93eb`. **Held by:** *"L6: an IPv6 /64 cannot rotate past the per-address
login-throttle tiers"*.

---

## L7 (LOW) — a file-descriptor leak on a read error in the index-build sort worker

**Finding.** `sortBucket`'s `openSync`/`fstatSync`/`readSync`/`closeSync` sequence had no
`try/finally`; a genuine disk I/O error mid-read skipped `closeSync` entirely.
`blockfile.js`'s equivalent read path already got this right.

**Fix.** Wrapped in `try/finally { closeSync(fd) }`, matching `readChainFile`.

**Commit:** `77aa0c1`. **Held by:** *"L7: the index-build sort worker closes its fd in a finally,
matching readChainFile"*.

---

## L8 (LOW) — the address-index row reader had no explicit bounds checks

**Finding.** `rows.js`'s hand-rolled `varint()`/`walkTx()` read via raw indexing and
`buf.subarray(...)` with no bounds check, unlike this codebase's own `blockfile.js` reader or
`chain/tx.js`'s `Reader` class. `Buffer#subarray` silently clips rather than throwing, so a
corrupted length field could — in a narrow, not-fully-demonstrated case — produce a bogus row
instead of the fail-loud behavior the rest of the index-build path guarantees.

**Fix.** Both bounds-checked, cheaply (`need(buf, pos, n)`, a single comparison per read — not a
`Reader`-class wrapper; this module is deliberately lean, per its own header comment, so the fix
matches that rather than paying the heavier decoder's cost it exists to avoid). Verified with a
hand-built block whose sole transaction claims an 80-byte output script but supplies 3: now throws
`truncated: need 80 bytes at ...`, naming exactly which read failed, instead of the old generic
"N bytes left after the last transaction."

**Commit:** `0b26bd6`. **Held by:** *"L8: a corrupted output-script length in a block is refused
loudly and specifically, not clipped silently"*.

---

## L9 (LOW/INFORMATIONAL) — `pool-map.js`'s fetch had no response-size cap

**Finding.** Unlike `server/collect/markets.js`'s `readJsonCapped()` (used by the running server
itself), this operator-run, manually-invoked refresh script accumulated its HTTPS response with
no limit.

**Fix.** Capped at 8 MB, checked against both the declared `Content-Length` and the actual
accumulated byte count as it streams.

**Commit:** `e441dac`. **Held by:** *"L9: pool-map.js's fetch refuses a body over its cap,
declared or actual"* — a real local HTTPS server (a self-signed cert made with this project's own
`makeSelfSigned`), not a mock.

---

## L10 (LOW/INFORMATIONAL) — an untested Windows path-containment edge case

**Finding.** `%5C` decodes to a literal backslash, treated as an ordinary filename character on
POSIX but as a path separator on Windows — untested despite this suite's own CI running on
`windows-latest`.

**Fix.** The static resolver now refuses a decoded backslash outright, on every platform. No file
this server ever serves has a backslash in its real name, so this costs nothing on any platform
and closes the edge without needing a Windows box to prove it.

**Commit:** `cdca41b` (same commit as L4 — both touch `server/http/static.js`). **Held by:** *"L10:
a decoded backslash in a static request is refused, not passed to path.normalize"*.

---

## Full suite, after every fix

```
npm test
# tests 1468
# pass 1468
# fail 0
```

`npm run counts:check` agrees (`README.md`/`AGENTS.md` updated by `counts:fix` for the 20 new
tests this round added, 1414 → 1434 declared).

## What was not changed

Two things the audit named were explicitly *not* additional code changes:

- **M1's structural fix subsumes the narrower "content-scan the release guard" suggestion.**
  The audit's own fix direction offered both a static content scan of built artifacts and a
  runtime transport-level gate; the runtime gate (implemented) makes the static scan's marginal
  value much smaller — a file that could never succeed at calling a wallet method through
  `RpcClient` doesn't need a separate build-time check to catch it too. `ADMIN_PATHS`'s
  path-pattern exclusion is unchanged and still real: it keeps the admin suite's *code* (UI,
  routes, elevation, argument-shape scrutiny) out of every release artifact, which M1's fix
  does not attempt to replace.
- **L3/D2's exact rate-limit numbers** (40 burst, 1/s) are a judgment call, not a value derived
  from a stated requirement — the audit posed this as an open scope question rather than a
  concrete threshold. Worth revisiting if a real deployment's legitimate traffic pattern turns
  out to need more headroom.
