# BlockYard Security Audit — 2026-09-22

> **STATUS: EVERY FINDING REMEDIATED — 2026-09-22, branch `main`.** Findings:
> **0 critical, 1 HIGH, 4 MEDIUM, 10 LOW/informational — 15 in total, all fixed.** Each has a
> regression test that failed against the pre-fix code (`test/audit-2026-09-22.test.js`); the
> remediation record, per fix and with its commit, is `docs/REMEDIATION-2026-09-22.md`. Nothing
> here has been pushed past this box; `main` is ahead of `origin/main` until the operator says
> so. Severity scale: CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL, graded by realistic blast
> radius for *this* product (a single- or few-operator Bitcoin node monitor), not by a generic
> CVSS-style ceiling.

- **Project:** BlockYard, a multi-user web monitor for a Bitcoin Core (or Bitcoin Machine
  Code) node — `/storage/blockyard`, version 0.1.3.
- **Audit date:** 2026-09-22 (UTC), single session.
- **Repo state at audit:** branch `main` @ `dbc19b8` (clean working tree at the time of
  reading; this file itself is new and untracked).
- **Requested by the operator, verbatim:** a brutally honest, extremely technical audit,
  "pay special attention to the DOS emulator for any attacks," want to know "everything
  that might be concern that we should resolve," and scope out whether toggling the DOS
  emulator off would help. Also asked what this project does well.
- **Method.** I read the prior four audits in this repo first
  (`docs/SECURITY-AUDIT.md`, `-2026-09-14.md`, `-2026-09-16.md`, `-2026-09-19b.md`) and
  `docs/SECURITY.md`/`docs/DEFECTS.md` so this report doesn't re-litigate what's already
  fixed — where a past finding is checked below, it's because I re-verified it against
  the current tree, not because I assumed the docs are still accurate. I then split the
  codebase into five areas and read each one directly, line by line, in parallel: (1)
  auth/sessions/RBAC/audit trail, (2) HTTP server/TLS/CSP/network exposure, (3) the RPC
  lane/allowlist/admin-suite exclusion/config loading, (4) the address-index build
  (raw blk/rev file parsing), the log parser, the explorer's output escaping, and every
  outbound network call, and (5) the DOS Diversions (the x86 interpreter and everything
  around it) as its own dedicated, deepest pass, per the request. Every finding below that
  a sub-review reported, I re-read myself at the cited file:line before including it here
  — nothing in this report is taken on trust from a sub-review's word alone. I did **not**
  run a live penetration test, a fuzzer, or a Windows machine; where that matters, the
  finding says so explicitly rather than asserting a Linux-only observation as universal.

---

## Executive summary

This is a well-built, unusually self-aware codebase from a security standpoint — four
prior audits already landed real fixes, the threat model is written down in
`docs/SECURITY.md` in enough concrete detail to be falsifiable (and I falsified several
of its specific claims by reading the code, and every one held), and the defaults
(sign-in on, loopback bind, HTTPS with a self-made certificate, a default-deny RPC
allowlist, an entire administrative/wallet-capable module excluded from every release
artifact) are the right defaults for a product that sits next to a node's credentials.

Against that high bar, I found **one HIGH finding that deserves fixing before this box's
`trustProxy` setting is ever turned on**, and it's a genuinely interesting one: the
project's own reverse-proxy documentation, followed exactly as written, defeats the
project's own IP-spoofing protection — the danger is *correctly* documented in one place
(`docs/CONFIGURATION.md`) and *silently reintroduced* in the worked example three files
away (`docs/INSTALL.md`). Four MEDIUM findings are real, narrow gaps (an admin-suite
exclusion that works by filename convention rather than by content, a password-reset tool
that doesn't revoke sessions, a login endpoint with no cross-site protection at all, and
an SSE response class that's exempt from the app's own header policy). Ten LOW/informational
items round it out — several of them "this is fine today, here is exactly the assumption
it's fine *under*, and here is what breaks that assumption."

**The DOS Diversions, which you asked me to look at hardest, are the best-defended part
of the codebase.** The x86 interpreter's memory model is provably sound (every one of
several dozen call sites masks every address against a power-of-two buffer size before
touching real memory — I verified this claim myself, at the source, rather than trusting
the sub-review that first reported it), there is no `eval`/`Function`/WebAssembly anywhere
in the entire client bundle, and a corrupted or hostile game binary is contained to its
own worker and cannot touch the rest of the app. The one real gap there is a documentation
gap, not a code gap: the file loaders don't validate header fields against the actual file
size, which is fine *only* because the games are ones the operator personally chose to
drop in `games/`, and that assumption is never written down anywhere. There's a scoping
section for an on/off switch near the end, since you asked for one.

---

## Findings

### H1 — `trustProxy`, followed exactly per this project's own nginx example, lets a remote client spoof the client address the CIDR gate, rate limits, and audit trail all rely on

**Severity: HIGH.** **Who can exploit it:** any unauthenticated remote client, but only on
a deployment that has both (a) put a reverse proxy in front per `docs/INSTALL.md`'s exact
worked example, and (b) turned `server.trustProxy` on as that same doc instructs. This box
runs neither (`server.trustProxy` is unset in `config/local.json`), so it is not exposed
right now — this is a finding about what the *documentation leads an operator into*, not
about this box's current configuration.

`server/http/server.js:434-439`:

```js
export function clientIp(req, cfg) {
  if (cfg?.server?.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return normalizeIp(fwd.split(',')[0].trim());
  }
  return normalizeIp(req.socket?.remoteAddress ?? '0.0.0.0');
}
```

This trusts the **first** (leftmost) entry of `X-Forwarded-For`. That is only safe if the
proxy in front *overwrites* the header — discarding whatever the client sent — so that the
only entry present is the one the proxy itself added. `docs/CONFIGURATION.md` says exactly
this, twice, correctly:

- line 103: *"When `true`, the client address is the **first** entry of the
  `X-Forwarded-For` header instead of the socket's peer address... Turn it on only when a
  reverse proxy you control is the sole way in and it sets that header. Otherwise any
  client can pick its own address and walk past `allowCidrs`."*
- line 670: *"Only set `trustProxy` if the proxy overwrites `X-Forwarded-For`."*

But `docs/INSTALL.md:520-549`, the walkthrough that hands an operator a copy-pasteable
nginx config right next to the instruction to turn `trustProxy` on, does the opposite:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

`$proxy_add_x_forwarded_for` **appends** nginx's view of the real client onto whatever
`X-Forwarded-For` the client already sent — it does not overwrite. A raw request carrying
`X-Forwarded-For: 203.0.113.6` arrives at nginx, which appends the real address and forwards
`X-Forwarded-For: 203.0.113.6, <real client>` to BlockYard. `clientIp()` takes `split(',')[0]`
— `"203.0.113.6"`, the attacker's own forged value.

**Concrete impact once an operator follows the docs exactly as written:**
- `server.allowCidrs` (the CIDR allowlist) can be walked around by claiming an allowed
  address.
- Every per-address rate limit — the login throttle in front of the KDF, the
  three-tier `LoginGuard` lockout (`server/auth/sessions.js:150-223`), the SSE
  per-key stream cap — can be defeated, or turned into a tool to lock out an innocent
  address by spoofing it into every counter.
- The audit trail (`app.audit({..., ip})`) — including the very entries that exist to
  attribute abuse, `csrf-rejected` and the node-connection test/save routes — records a
  forged address for every action.

This is CWE-290 (trusting a client-controllable element of a header as an authentication/
authorization signal) and it is a self-contradiction *within this project's own docs*, not
a case of nobody having thought about it — `docs/CONFIGURATION.md` gets the danger exactly
right. The worked example just doesn't follow the rule the project itself states.

**Fix direction:** change the nginx example to `proxy_set_header X-Forwarded-For
$remote_addr;` (overwrite; correct for a single, directly-connected trusted hop — which is
what this deployment shape is), or, if multiple hops are ever a real scenario, change
`clientIp()` to take the **last** entry rather than the first and document that the proxy
must be the outermost hop. Either fix is small; I'd lean toward fixing the doc's nginx
snippet first since it's the one an operator will actually copy.

---

### M1 — The administrative suite is excluded from releases by filename pattern, not by capability; a differently-named mutating module would ship silently

**Severity: MEDIUM.** **Who can exploit it:** nobody today — this is a structural gap in
the *guarantee*, not a live hole (`server/admin/` does not currently ship, verified by
`test/release-guard.test.js` passing). It matters because the guarantee is load-bearing:
`docs/SECURITY.md`'s whole threat model rests on "the monitor does not hold keys... every
wallet RPC is refused by name," and one of the three enforcement layers behind that promise
is this pattern-match.

Three independent mechanisms keep the wallet-capable admin suite out of what ships:
`test/release-guard.test.js` (walks the repo and flags any path matching
`/(^|\/)admin(\/|-|\.)/ ` not already in a known-excluded list), `package.json`'s `files`
array, and `.dockerignore` — all three keyed on the same four literal, hand-maintained
paths (`server/admin/`, `server/rpc/admin-allowlist.js`, `public/js/admin/`,
`public/css/admin.css`). **None of the three inspects file *content*.**

Concretely: a future contributor adds `server/chain/spend.js` or `server/rpc/wallet-ops.js`
that imports `RpcClient` directly and calls `sendtoaddress`/`walletprocesspsbt`. It doesn't
match the `admin` naming regex, isn't in the exclusion lists, and ships in both the npm
tarball and the container image with **zero test failures** — the exact mechanism that
already bit this project once (`server/rpc/admin-allowlist.js` was originally missed by an
earlier, directory-only version of this exclusion before being caught; see the comment at
`scripts/build-edition.js:36-40`).

**Fix direction:** add a content-based check alongside the path-based one — grep the built
artifact (tarball contents, or the container's copied files) for the literal names of every
method in `server/rpc/admin-allowlist.js`'s allow list (`sendtoaddress`,
`walletprocesspsbt`, `walletpassphrase`, etc.) or any import of that file, and fail the
release-guard test if any turn up outside `server/rpc/allowlist.js`'s own read-only
allowlist. Even a blunt "no file outside the known admin paths may import
`admin-allowlist.js` or reference its exports" static check would catch a rename-based
bypass the path-glob approach structurally cannot.

*(Worth stating plainly: even if this exclusion failed completely, `server/admin/`'s own
code still requires `admin.enabled=true`, per-wallet allow-listing, a mandatory spend cap,
and elevation/re-authentication before it can move a satoshi — so a leaked file alone isn't
instant exploitability. But "the guard that's supposed to catch this can't see it happen"
is still the right thing to fix, because the whole point of the guard is not needing to
trust every future contributor to name their files a certain way.)*

---

### M2 — `manage-users.js passwd` resets a password without revoking the account's existing sessions

**Severity: MEDIUM.** **Who can exploit it:** nobody remotely — this is a gap in an
operator's own incident-recovery tool, not a network-facing hole. It matters because of
*when* the tool gets used.

`scripts/manage-users.js:91-96` (the `passwd` subcommand):

```js
try { await store.setPassword(username, pw); process.stdout.write(`password set for ${username}; all their sessions were left intact -- sign them out from the UI if needed\n`); }
```

Compare `/api/password` (`server/http/api.js:802-820`), the web route for changing your own
password, which explicitly calls `app.sessions.destroyForUser(...)` and clears the cookie.
`manage-users.js passwd` is documented (in `AGENTS.md`) as the lost-password recovery path
— "Lost it? `node scripts/manage-users.js passwd admin`" — which is also, unavoidably, the
tool an operator reaches for during a *suspected compromise*. In exactly that scenario, the
tool leaves any existing session token for that account valid for up to 72 hours (the
absolute session TTL) after the password has been changed, because it never touches
`sessions.json`. The tool is honest about this in its own output — it's not a hidden
behavior — but "sign them out from the UI" isn't a real option when the reason you're
running the CLI tool is that you don't trust the account to sign anyone out from.

**Fix direction:** call the same session-revocation path the API route uses (or add a
`--revoke-sessions` flag, or just always do it — a lost-password reset has no legitimate
reason to want to *keep* a possibly-unrelated existing session alive).

---

### M3 — `/api/login` has no cross-site protection of any kind (login CSRF)

**Severity: MEDIUM** *(concrete code gap; honestly limited practical impact — see below)*.
**Who can exploit it:** an attacker who already holds *some* valid BlockYard account (any
role — there's no open self-registration) and can get a victim's browser to load a page
they control.

`server/http/server.js:236-282` runs two different cross-site checks, and **both** are
gated on `route.csrf === true`:

```js
if (route.csrf && session) { /* double-submit token check */ }
...
if (route.csrf && !session) { /* Origin / Sec-Fetch-Site fallback check */ }
```

`/api/login` is registered with `csrf: false` (`server/http/api.js:296`) — reasonable for
the double-submit check (there's no session yet to double-submit against) — but as a
side effect it is **also** exempt from the Origin/Sec-Fetch-Site fallback, which was
written specifically to give open-mode, no-session state-changing routes *some* cross-site
protection. Since `readBody` accepts `application/x-www-form-urlencoded`, a plain
auto-submitting cross-site `<form method=post action="https://target/api/login">` carrying
the attacker's own username/password as hidden fields succeeds unconditionally: it sets the
session cookie for the **attacker's** account in the **victim's** browser. `SameSite=Strict`
doesn't stop this — it restricts sending an *existing* cookie cross-site on a later request,
not accepting a `Set-Cookie` from this same-site-destination POST.

**Honest impact assessment, not overstated:** I could not build a privilege-escalation
chain from this. The attacker needs their own account already, and the practical effect is
"the victim's browser is now authenticated as the attacker's account" — mostly a confusing
downgrade for the victim rather than an elevation for the attacker. The real risk is a
confused-deputy scenario: if the victim, believing they're in their own session, saves a
node connection (with RPC credentials) or changes a setting while unknowingly in the
attacker's account, that data lands where the attacker can read it back. I'm flagging this
as MEDIUM because it's a clean, concrete violation of the module's own stated invariant
("every mutating request needs..."), not because I have a severe demonstrated exploit.

**Fix direction:** apply the same Origin/Sec-Fetch-Site check to `/api/login` (and any other
`csrf: false` route), independent of whether a session exists yet — the check doesn't need
a session to work, it only needs to know the request changes state.

---

### M4 — SSE responses (`/api/stream`) never get the app's own security headers

**Severity: MEDIUM (low likelihood, but a real and cheap-to-fix inconsistency).** Every
other response type — HTML, JSON, error pages, even the `/games/` route — carries
`securityHeaders()`: CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`. The SSE hub does not.

`server/http/sse.js`, `StreamHub.add()`'s `writeHead` sets only `Content-Type`,
`Cache-Control`, `Connection`, and `X-Accel-Buffering` — no `nosniff`, no CSP, nothing else.

**Exploit scenario, honestly graded as unlikely on a modern browser:** if a client is ever
navigated directly to `/api/stream?...` outside of `EventSource` (a crafted link, an old
browser or extension that still does MIME-sniffing), the response has no `nosniff`. If any
reflected content early in the stream could be steered toward HTML-like bytes, a sniffing
user agent could in principle render it as HTML rather than `text/event-stream` — defeating
the app's otherwise-strict CSP for that one response simply because the header isn't there
to stop it, not because the policy itself is weak. I did not find a way to get attacker-
controlled bytes early enough in an SSE frame to actually demonstrate this; it's the
*absence of the header*, not a demonstrated bypass, that's the finding.

**Fix direction:** merge `securityHeaders({ tls, hstsMs })` into `StreamHub.add()`'s
`writeHead` call, the same as every other response path already does.

---

### L1 — A dead, misleadingly-written exception clause in the RPC allowlist

**Severity: LOW (currently harmless; a landmine for a future edit).**
`server/rpc/allowlist.js:79`:

```js
for (const p of DENY_PREFIXES) if (method.startsWith(p) && !ALLOW_PREFIXES.includes(method)) return denied;
```

`ALLOW_PREFIXES.includes(method)` is an **exact-string** membership test against short
prefix strings like `'get'`/`'list'` — not a prefix test on `method` — so this exception can
essentially never fire (no real RPC method is literally named `"get"`). It reads as if it
means "unless this method is also allow-prefixed," but it doesn't do that; the deny list is
currently *stricter* than the comment implies, which is the safe direction, so there's no
live hole. But it's a trap: a future edit that "fixes" the obviously-wrong-looking
`.includes()` into what the code appears to promise (an actual prefix check) would silently
reopen every `DENY_PREFIXES` method whose name happens to also start with an
`ALLOW_PREFIXES` entry. **Fix direction:** rewrite the condition to be unambiguous, or
delete the dead clause outright.

### L2 — DOS Diversions' executable loaders don't validate header fields against file size

Covered in full in the dedicated DOS section below (finding D1) — summarized here for the
severity list: **LOW**, safe under the current trust model (operator-supplied game files
only), undocumented as a trust boundary, untested against a truncated/corrupted file.

### L3 — `/games/*` has no rate limit or throughput cap

Covered in the DOS section below (finding D2). **LOW / open scope question.**

### L4 — No `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` headers

**Severity: LOW/INFORMATIONAL.** Not currently exploitable — I grepped the entire codebase
for `SharedArrayBuffer` and found zero uses (the DOS emulator's worker uses plain
`postMessage`/transferable `ArrayBuffer`s, not shared memory), so nothing here depends on
cross-origin isolation. Given how deliberately the rest of the header policy is built
(`docs/SECURITY.md`'s own description matches the code exactly), adding `Cross-Origin-
Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin` is cheap,
standard, defense-in-depth that costs nothing today and protects against some Spectre-class
and cross-origin-window-reference issues if the threat model ever changes.

### L5 — `audit.jsonl` has no tamper-evidence

**Severity: LOW/INFORMATIONAL.** `server/store/audit.js` is plain newline-delimited JSON
with filesystem permissions (0600) as its only protection — no hash chain, no HMAC, no
append-only enforcement at the application layer. Anyone with write access to `data/`
(root, the service account itself if some *other* component running as that account were
compromised) can edit or delete entries with nothing to detect it. This is **not a broken
promise** — nowhere does the code or docs claim tamper-evidence; "chain-aware reader" in
`AGENTS.md`'s file layout refers to the rotation chain (`audit.1.jsonl`, `audit.2.jsonl`,
...), not a cryptographic one. Worth naming explicitly given the module's own stated bar
("a multi-user webserver... must not be the soft spot") and because the gap is genuinely
easy to close (an HMAC over each line, keyed by something in `data/` itself, would at least
detect tampering by someone who doesn't also hold that key) if the operator's threat model
includes "another compromised process running as the same user."

### L6 — IPv6 address rotation degrades (not bypasses) the login brute-force tiers

**Severity: LOW/INFORMATIONAL.** `normalizeIp` (`server/http/server.js:442-`) only strips a
`::ffff:`-mapped IPv4 prefix; it doesn't collapse an IPv6 address to a /64 or similar. An
attacker with a routed IPv6 /64 (trivial to obtain from many providers) gets a fresh
per-`(username,ip)` `LoginGuard` bucket and a fresh per-IP rate-limit bucket for every
address in that block. The per-username-across-every-address tier (`LoginGuard`'s 80-
failure `u:` key) still catches a sustained attack regardless — this paces and degrades the
finer-grained protection, it doesn't bypass the account lock entirely.

### L7 — A file-descriptor leak on a read error in the address-index sort worker

**Severity: LOW.** `server/chain/index/worker.js:69-76`, `sortBucket()`: `openSync` /
`fstatSync` / a manual `readSync` loop / `closeSync`, with no `try/finally`. If `fstatSync`
or `readSync` throws (a genuine disk I/O error), the fd is never closed. The throw is
caught one level up and reported as a build error rather than crashing the worker process,
so a worker that keeps retrying against a failing disk leaks descriptors — the same class of
bug the deliberate "64 open bucket files, LRU-close" design in `build.js` was written to
avoid elsewhere. Compare `blockfile.js`'s equivalent read path, which does wrap this in
`try/finally { closeSync(fd) }`. **Fix direction:** match that pattern here.

### L8 — `rows.js`'s varint/transaction reader has no explicit bounds checks (theoretical)

**Severity: LOW, not demonstrated exploitable.** `server/chain/index/rows.js`'s hand-rolled
`varint()` and `walkTx()` read via raw `buf[st.pos++]` and `buf.subarray(...)` with no bounds
check, unlike the codebase's own `blockfile.js` reader (which checks every read) or
`chain/tx.js`'s `Reader` class (`need(n)` before every read). `Buffer.prototype.subarray`
silently clips out-of-range rather than throwing, so a corrupted length field on a script
*could* hand a truncated slice to `scriptKey()` with no exception at that point. In
practice this is almost always caught: any later fixed-width read in the same transaction
throws on an out-of-range offset, and `blockRows()`'s final `st.pos !== body.length` check
fails the whole block otherwise — matching this codebase's own stated "never fabricate a
number, a parsed source reports its own coverage" ethos everywhere *except* this one file.
The residual gap is narrow and unconfirmed: a corrupted length field could in principle land
`st.pos` back on `body.length` by coincidence, writing one bogus row with no error raised at
all. **Fix direction:** give `varint()`/`walkTx()` the same explicit bounds checks
`blockfile.js`'s reader already has.

### L9 — `scripts/pool-map.js`'s fetch has no response-size cap

**Severity: LOW/INFORMATIONAL, operator-run dev tool, not server-facing.** Unlike
`server/collect/markets.js`'s `readJsonCapped()` (which the running server itself uses and
which does bound the response), this manually-invoked script accumulates its HTTPS response
with no limit. It only ever hits a single pinned `raw.githubusercontent.com` URL with
`--expect-sha256` supply-chain pinning already in place, so the realistic blast radius is
small (a DNS hijack or compromised CDN edge causing unbounded memory growth on whichever
machine an operator happens to run the refresh command on) — but it's inconsistent with the
discipline the rest of the codebase applies to third-party responses. **Fix direction:**
reuse the same cap `markets.js` already has.

### L10 — An untested Windows path-containment edge case

**Severity: LOW/INFORMATIONAL, no concrete bypass found.** The static file server's
containment check (`realpath` comparison against the resolved root) is the correct defense
and was independently verified to catch both `../` and symlinks planted inside `public/`.
One edge case wasn't ruled out without a Windows machine to test on: `path.normalize` is
platform-specific, and on Windows a percent-encoded backslash (`%5C`) decodes to a literal
backslash before normalization runs. CI does run this suite on `windows-latest`
(`.github/workflows/test.yml`), so a targeted regression test for this specific case would
be worth adding even without a demonstrated bypass — I'm flagging the untested edge
honestly rather than either asserting a bug or declaring it safe.

---

## The DOS Diversions — dedicated deep review

You asked me to look hardest here, and I did — this section covers the x86 interpreter
(`public/js/x86.js`, ~2,000 lines), the emulated PC (`dospc.js`, ~1,400 lines, DOS/DPMI/
DJGPP support), the Web Worker boundary (`dosworker.js`), the sound hardware emulation
(`dosaudio.js`, `soundcard.js`), the per-game wrappers, and the server-side `/games/` route
(`server/http/games.js`). This runs three real, unmodified DOS-era shareware `.EXE`
binaries (Wolfenstein 3D, DOOM, Quake) entirely client-side, in a from-scratch, zero-
dependency, hand-written x86 CPU interpreter — a lot of low-level code interpreting
binary-machine-code-shaped data, which is exactly the kind of subsystem that deserves the
most scrutiny in a report like this.

**The headline result: this is the best-defended part of the codebase, and it's
structurally so, not just carefully-tested-so.**

### Memory safety — the central claim, and I verified it myself at the source

`dospc.js:21`: `MEM_SIZE = 32 * MB` — 32 MB, a power of two, allocated once as a single
`Uint8Array`. `x86.js:65`: `AMASK = M.length - 1`. I grepped every one of `x86.js`'s memory
accessors myself (`rb`, `rw`, `rd`, `rbx`, `wb`, `ww`, `wd`, the string-instruction bulk
copy/fill fast paths, the FPU's raw-float memory forms, and the decoded-instruction cache's
inlined addressing, which duplicates this logic for speed and is exactly the place such a
guarantee would most likely quietly break under maintenance) — **every single one masks the
computed address with `& AMASK` before it ever touches `M`.** Because the buffer's length is
a power of two, `a & AMASK` is mathematically incapable of producing an index outside
`[0, M.length)`. A wild pointer from a corrupted or adversarial program wraps around inside
the emulated 32 MB space; it cannot reach the underlying `ArrayBuffer`'s bounds, let alone
the JS heap around it. This is the correct way to make "no out-of-bounds access is possible"
a property of the memory-access *functions themselves*, rather than something that has to be
independently re-proven at every call site — and, having checked, it holds everywhere.

I also specifically looked for the other classic failure mode in an interpreter like this:
a decoded byte used to index directly into a *real* JS object or array (which, unlike a
`TypedArray`, can produce prototype-chain lookups or silent `undefined` on an out-of-range
index — an information-disclosure or logic-corruption primitive within the JS realm, distinct
from memory corruption). Every dispatch table in the interpreter is either a `switch` over
the full 0–255 opcode byte (throwing on anything unhandled) or a lookup into a fixed-size
typed array indexed by an explicitly bit-masked field. I found no unmasked index into a real
JS object anywhere in `x86.js`, `dospc.js`, or `soundcard.js`.

### No `eval`, confirmed by grep across the *entire* client bundle, not just the DOS files

`grep -rnE "\beval\(|new Function\(|setTimeout\(\s*['\"]|setInterval\(\s*['\"]|WebAssembly\." public/js/` returns nothing but a single comment in `x86.js` that mentions the word "eval" while explaining why there isn't one. The CSP (`script-src 'self'`, per-response nonce, no
`'unsafe-eval'`) backs this up independently — given this subsystem is, quite literally,
interpreting untrusted-shaped binary machine code, the combination of "no code-generation
trick anywhere in the interpreter" and "the platform would refuse one if there were" is the
right belt-and-suspenders. (Worth noting: closures-as-dispatch were tried and reverted
during development, per `AGENTS.md` — reverted for being *slower* than the switch, not for
being disallowed, which is a good sign the switch-dispatch design is a genuine choice, not
a workaround nobody wanted.)

### The worker boundary and the DOS "filesystem" — two independent traversal defenses

`server/http/games.js`'s route regex (`GAME_PATH`) permits at most one directory segment
plus an 8.3-shaped filename with a fixed extension — no dots, no slashes within a segment,
so there is no traversal syntax expressible in the URL at all — and `findGameFile` walks
`fsp.readdir` per path component, matching enumerated real directory entries case-
insensitively; it can never concatenate an untrusted string into a path outside what it just
enumerated. I read this myself and independently confirmed it before either sub-review
touched it.

The emulated DOS side is a *different* mechanism and doesn't depend on the first one being
correct: `dospc.js`'s INT 21h filesystem handlers resolve DOS paths (dropping `.`/`..`)
entirely within an in-memory `Map<string, Uint8Array>` — there is no real filesystem access
anywhere inside the emulated CPU's I/O handlers. The only real disk read is the one-time
`fetch('/games/...')` at worker startup, against the same regex-validated route, for a fixed
per-game file list. A maximally adversarial in-game "path" — even one the game itself writes
at runtime, which Quake's `CONFIG.CFG` does — can only ever address entries of that in-memory
map. It cannot reach the host filesystem. Two independent layers, neither depending on the
other's correctness, is the right shape.

### Crash isolation — traced end-to-end, holds up

A CPU fault (or any other exception) thrown inside the interpreter's instruction loop
propagates through exactly one `try/catch`, in `dospc.js`'s `run()`, into `dosworker.js`'s
message loop, which sets `running = false` and posts an `error` message back to the main
thread rather than rethrowing. `dosgame.js` receives that and shows a "stopped" state
confined to the Diversion's own tab. I traced this whole chain: **nothing in it touches the
main page's DOM, the live SSE connection, or any other panel.** A corrupted or hostile game
binary can kill its own Diversion; it cannot take down Overview, Mining, or the Explorer,
because the failure never crosses the worker boundary as an uncaught exception. The
interpreter also yields to the event loop every ~10ms of wall time regardless of what the
emulated program is doing (`SLICE_MS = 10`, a `MessageChannel`-based yield in
`dosworker.js`), which functions as a real watchdog against an infinite-loop program locking
up the worker's own message handling — it doesn't stop a stuck program from pegging one CPU
core indefinitely, but it does mean the tab stays responsive and controllable (pause, close)
throughout.

### D1 (= L2 above) — File loaders trust header fields against the file's real length

`dospc.js`'s LE loader (`hasLE`/`loadLE`, roughly lines 40–120) and its COFF/DJGPP loader
(`parseCoff`, ~128–151) read structural fields — page counts, section counts, offsets, sizes
— directly out of the executable's own header and use them to drive loops and buffer slices,
**with no check that these fields are consistent with the file's actual length.** Concretely:
a corrupted or absurd `nPages` field in an LE header drives an effectively-unbounded loop in
`loadLE` (a hang inside that Diversion's `boot()`, not a crash); a corrupted `ob.base`
pointed outside the 32 MB `mem` buffer hits `Uint8Array.prototype.set`'s own bounds check and
throws a `RangeError` — which, per the crash-isolation trace above, is contained and
reported cleanly, not silently wrong. `parseCoff`'s section loop has the same shape of gap.

This is **low severity today specifically because of who supplies the files**: `games/` is
filled by the operator's own copies of shareware they've chosen to run, not fetched from a
third party or accepted from a visitor at runtime — the server route only ever serves files
that already exist on disk under a fixed, regex-matched path. The threat model this matters
under is: a *different* operator, in the future, drops a different `.EXE`-shaped file into
`games/` (or a future Diversion) expecting the same care Wolf3D/DOOM/Quake's own files got,
and gets none. **This exact trust boundary is never written down anywhere** — `AGENTS.md`'s
extensive DOOM/Wolfenstein/Quake notes cover real-mode support, DPMI impersonation, the
decoded-instruction cache, and controls in detail, but never file-format validation or a
truncated/malformed-file scenario, and no test in `test/dos-pc.test.js` exercises one.
**Fix direction:** at minimum, a code comment stating the trust boundary explicitly; a cheap
length-sanity check before each loop/slice would let the project state a stronger guarantee
if it ever wants to.

### D2 (= L3 above) — `/games/*` has no rate limit or throughput cap

Unlike `/api/stream` (which has both a request-rate limiter and a per-key open-stream cap)
and the login route (which has its own three-tier throttle), `/games/*` has neither. A
client can request the 18 MB Quake PAK repeatedly with no server-side throttle beyond
whatever the OS/Node connection limits impose — `ETag`/`Cache-Control: no-cache` does give a
cheap `304` on a *repeat, unchanged* request, but there's nothing stopping a client from
never sending the conditional header at all. This may simply be the same posture the rest of
the static-file server has for any large `public/` asset (I didn't find evidence it's
`/games/`-specific), which would make this a repo-wide policy question rather than a
Diversions-specific bug — flagged as a scope question for the operator, not asserted as
something that must change.

### Auth on `/games/*`

Confirmed directly: `server/http/server.js` gates `/games/*` behind the session the same
way the rest of the app is gated — reachable without sign-in only when accounts are off,
same as everything else. This box currently runs with accounts off, so the games are
reachable by anyone who can reach the bind on *this* deployment — but that's the documented,
deliberate open-mode posture for the whole app, not a games-specific decision, and nothing
here changes that analysis.

### Toggling the DOS Diversions off — scoping, not implemented

You asked me to scope this out. **No such switch exists today.** I searched
`settings.js`, `config.js`, and the page-navigation code for anything resembling a
"diversions" or "games" runtime toggle and found none — the only "Diversions" reference in
`settings.js` is a cosmetic settings-panel group label for an unrelated set of games
(Tetrust/Blockout/Blockanoid/Scorched Yard), not the DOS emulator.

To add a real operator-facing off switch, three independent things would need to change —
naming exactly where, without writing the code, since you asked for scoping:

1. **Server-side enforcement (the part that actually matters for security/bandwidth).**
   `server/http/server.js`'s `/games/` handling currently runs unconditionally once past
   the auth check. A new config key — following the exact precedent `app.adminEnabled`
   already sets for gating `/admin` — would need to short-circuit this to a 404 when off,
   plus the corresponding key and validation in `server/config.js`.
2. **Client-side menu hiding.** Wherever the page navigation enumerates pages, the
   `wolf3d`/`doom`/`quake` entries would need to be omitted when the server reports the
   flag off — ideally surfaced through the same `/api/config` feature-flag channel that
   already carries `log-source-disabled` and similar provenance flags, so the client
   doesn't have to guess or duplicate server-side state.
3. **A build-time alternative, if that's what's actually wanted instead of (or in addition
   to) a runtime toggle:** this codebase already has a working precedent for "exclude a
   whole subsystem from what ships" — the admin suite's exclusion mechanism
   (`package.json`'s `files`, `.dockerignore`, `test/release-guard.test.js`). The same
   pattern (minus finding M1's content-blind-spot, which doesn't apply here since there's
   no dangerous *capability* to hide, just bytes) could produce a "no-games" build edition
   the same way `scripts/build-edition.js --edition admin` already produces a differently-
   scoped one.

None of this exists in the tree today; it would be new code in `server/http/server.js`,
`server/config.js`, and whichever module renders the page nav (not read in this pass).

---

## What this project does well

This section is as important as the findings, because a fair report says both, and because
several of these are genuinely unusual and worth calling out by name rather than with
generic praise.

**Cryptography and credential handling**
- Passwords: scrypt with per-user stored parameters (not a global constant), so raising
  `auth.scrypt` in config migrates the account fleet gradually on next successful login
  rather than forcing a mass reset — and it only rehashes *after* a successful verify
  against the *old* parameters, so a wrong guess can never poison a stored hash.
- `randomPassword()` explicitly avoids `randomBytes() % n` modulo bias and uses
  `crypto.randomInt` instead, with a comment citing the exact bias arithmetic (a 66-
  character alphabet against `256 % 66 = 58`) — a level of rigor rarely seen in a bootstrap-
  credential generator.
- Session tokens are 32 random bytes, stored **only** as their SHA-256 hash — never
  plaintext — with a fresh token on every login (no session fixation), `HttpOnly`,
  `SameSite=Strict`, and a `Secure` flag that's force-derived from whether TLS is actually
  on rather than independently misconfigurable.
- The `__Host-` cookie-name prefix is used whenever TLS is on — this is a real, browser-
  enforced guarantee (no `Domain` attribute, `Path=/`, `Secure` required) most projects
  don't bother with.
- Every password/session/CSRF comparison goes through `crypto.timingSafeEqual`, including
  the CSRF double-submit check, and unknown-username logins still run a full dummy scrypt
  derivation so response timing doesn't leak account existence — verified by reading the
  code, not assumed from the docs' claim.
- CSRF is defended in depth even where it didn't strictly have to be: `SameSite=Strict`
  already blocks most cross-site cookie-riding, and the code adds a double-submit token
  *on top*, with a comment explaining exactly which browser-relaxation scenario that
  guards against — reasoning about the residual risk after the primary control, not
  stopping at "we have one control, ship it."
- The self-signed TLS certificate is hand-assembled DER/X.509 (ECDSA P-256, Node's own
  CSPRNG for both the key and the serial, no OpenSSL dependency) — genuinely impressive
  given the project's zero-dependency constraint — with the private key written `0o600`
  in a `0o700` directory via a temp-file-plus-rename pattern (atomic, no window with a
  partially-written key on disk), and it's never logged (only its fingerprint is) or
  returned by any API route.

**The RPC/node-write boundary**
- The wallet-method denylist is checked *first*, ahead of any prefix-matching logic, so it
  can't be defeated by a method name that happens to start with an allowed prefix
  (`getnewaddress`, `getrawchangeaddress` are refused by name specifically because they
  start with "get" but create keys).
- Node-write gating (`BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH`) is enforced **twice**,
  independently — a fatal config-load check and a separate route-level re-check with its
  own audit entry — genuine defense-in-depth verified by reading both code paths, not just
  asserted in a comment.
- The admin suite's dynamic `import()` (only reached when the admin gate passes) means a
  disabled suite isn't merely refused at the route level, it's **never loaded into the
  process at all** — a real absence, reducing any bug in 3,000+ lines of wallet-adjacent
  code to "unreachable" rather than "reachable but hopefully caught."
- Argument-shape scrutiny inside the admin allowlist itself is unusually careful for code
  most projects would treat as a simple name-based allowlist: `listdescriptors` is
  specifically blocked from the argument form that reveals private descriptors,
  `lockunspent`'s `persistent` flag is explicitly forbidden, `walletpassphrase`'s timeout
  is capped server-side (not just documented) at 120 seconds.
- File permissions on every secret-bearing path (`config/local.json`, `users.json`,
  `sessions.json`, the audit trail, the TLS key) are consistently 0600/0700, applied both
  at creation and retroactively (via `fchmod`) to files written before the mode was
  enforced — the fix was applied to the past, not just going forward.

**Network posture**
- The CSP is genuinely strict and I verified every clause against the literal array in
  code: no `unsafe-inline`, no `unsafe-eval`, `object-src 'none'`, `frame-ancestors
  'none'`, `base-uri 'self'`, `form-action 'self'`, a fresh per-response nonce from a real
  CSPRNG for the one legitimate inline-script need. Applied to HTML, JSON, error pages, and
  the games route (the one gap, SSE, is M4 above).
- Static file containment uses a `realpath` comparison against the resolved root, not a
  string-prefix check on the raw request path — this is the correct defense and
  specifically closes the "symlink planted inside `public/`" bypass class a naive
  `startsWith` check would miss.
- Outbound market-data calls use hardcoded per-exchange URLs (never built from config or
  request input), `redirect: 'error'`, an explicit timeout, and a response reader that
  bounds accumulated bytes even against a hostile/compromised exchange endpoint — and cross-
  checks each order book's mid-price against every other source before trusting it, dropping
  and *reporting* (never silently zero-filling) any book that disagrees by too much.
- Request body size (1 MB) and timing (30s arrival deadline) are enforced through one shared
  code path used by every route that reads a body — not duplicated, and therefore not
  something a new route can forget.
- The node-connection test/save routes distinguish "the destination is our already-
  configured node" from "the destination is arbitrary" and gate credential exposure on the
  *destination*, not on what the caller claims — the right invariant, applied consistently.

**Process and supply chain**
- Genuinely zero runtime dependencies (`package.json` confirmed empty `dependencies` and
  `devDependencies`), which removes an entire class of supply-chain risk most Node projects
  simply accept.
- GitHub Actions are pinned by full commit SHA, not by tag (a tag can be moved by whoever
  controls the action's repo; a SHA can't), with the resolved tag documented in a comment
  next to each pin, and CI workflow permissions are `contents: read` only, with the image-
  publish workflow using the ephemeral `GITHUB_TOKEN` rather than a long-lived credential.
- The systemd unit is thoroughly hardened (`ProtectSystem=strict`, `NoNewPrivileges`, an
  empty `CapabilityBoundingSet`, a restricted syscall filter and address-family list, a
  0077 umask) and — notably — it **documents the one thing it deliberately doesn't do**
  (`MemoryDenyWriteExecute`, correctly explained as incompatible with V8's JIT) rather than
  silently omitting it or overclaiming completeness.
- The Docker image runs as a non-root UID, needs no build stage (nothing to install), and
  correctly excludes the admin suite via `.dockerignore` in parallel with the npm
  packaging exclusion.

**The explorer and event feed (XSS discipline)**
- I read every `innerHTML` interpolation of node/chain-controlled data I could find —
  transaction IDs, addresses, script types, coinbase/pool tags (which is attacker/miner-
  controlled arbitrary bytes), peer `subver` strings (classic block-explorer XSS vector,
  and it's the very first thing I checked), error/hint strings, and event-feed text — and
  every one of them is passed through a standard HTML-entity escaper before insertion. This
  was checked independently by two separate reviews (mine and one sub-review's) and neither
  found an exception.

**The DOS Diversions** — covered in full above; briefly, restated for this list: the
memory-safety guarantee is structural rather than case-by-case, there is no `eval` anywhere
in the client bundle (confirmed by exhaustive grep, not by trusting a docstring), a crashed
or corrupted game is provably contained to its own tab, and the decoded-instruction cache's
self-invalidation (correctness-critical, since the games themselves self-modify code) is
handled conservatively everywhere a write can happen.

**Documentation honesty, as a practice.** `docs/SECURITY.md` makes specific, falsifiable
claims ("32-byte random tokens, stored hashed," "8 failures in 5 minutes... 10 minutes,"
"a request... must arrive within 30 seconds") rather than vague assurances, and every one I
checked against the code was accurate. That's a meaningfully higher bar than most security
documentation clears, and it's *why* finding H1 above is interesting rather than damning:
the danger is correctly written down in one document and only slips through the cracks in
a different one's worked example.

---

## Summary table

| ID | Title | Severity | Status |
|---|---|---|---|
| H1 | `trustProxy` + this project's own nginx example spoofs the client address | HIGH | fixed (4955196) |
| M1 | Admin-suite exclusion is name-pattern, not capability-based | MEDIUM | fixed (743f11e) |
| M2 | `manage-users.js passwd` doesn't revoke sessions | MEDIUM | fixed (ccf645c) |
| M3 | `/api/login` has no cross-site protection (login CSRF) | MEDIUM | fixed (7c399d7) |
| M4 | SSE responses skip the app's security headers | MEDIUM | fixed (7c399d7) |
| L1 | Dead/misleading exception clause in the RPC allowlist | LOW | fixed (ba2eb14) |
| L2 / D1 | DOS executable loaders don't validate header fields vs. file size | LOW | fixed (377c91d) |
| L3 / D2 | `/games/*` has no rate limit or throughput cap | LOW | fixed (7c399d7) |
| L4 | No COOP/CORP headers | LOW/INFO | fixed (cdca41b) |
| L5 | `audit.jsonl` has no tamper-evidence | LOW/INFO | fixed (1151deb) |
| L6 | IPv6 rotation degrades login-throttle granularity | LOW/INFO | fixed (daf93eb) |
| L7 | Fd leak on read error in the index-build sort worker | LOW | fixed (77aa0c1) |
| L8 | `rows.js` varint/tx reader lacks explicit bounds checks | LOW | fixed (0b26bd6) |
| L9 | `pool-map.js` fetch has no response-size cap | LOW/INFO | fixed (e441dac) |
| L10 | Untested Windows path-containment edge case | LOW/INFO | fixed (cdca41b) |

Zero critical findings. Nothing here is presented as urgent in the sense of "this box is
being exploited" — the highest-severity item (H1) requires a specific, non-default
configuration change the operator would have to make deliberately, following the docs.

---

## Scope and limitations, stated plainly

- No live penetration test was run against a running instance; every finding above is from
  reading the source, tracing call paths, and (for the DOS memory-safety claim, the RPC
  allowlist's exact logic, the X-Forwarded-For handling, the login CSRF gate, and the
  worker fd leak) independently re-verifying the specific lines myself rather than trusting
  a sub-review's summary.
- No fuzzing was performed against the x86 interpreter, the DOS file loaders, or the block-
  file parser; where a finding rests on "this *could* happen under corruption," that's
  stated as a reasoned-through mechanism, not a demonstrated crash.
- Not tested on Windows or macOS; the one Windows-specific concern (L10) is flagged as
  untested rather than resolved either way.
- I did not independently re-verify the full RPC allow/deny method lists against a live
  Core 29/30 `help` dump — I read and trust the code's own dated comments describing where
  the lists came from; no contradicting evidence turned up.
- This report covers what I read; it is not a claim that nothing else exists. The areas
  explicitly scoped (auth, HTTP/TLS/network, RPC/admin/config, chain-file parsing and
  outbound calls, and the DOS Diversions) are, between them, the great majority of the
  attack surface a network-facing Bitcoin monitor has — but Tetrust/Blockanoid/Scorched
  Yard/the other in-browser games, the 3D rendering pipeline, and the WebGL shader code
  were not part of this pass, on the reasoning that they have no privileged capability and
  no network/file input of their own to abuse (they render local, already-fetched chain
  and market data) — if that reasoning is wrong for any of them, that's worth a follow-up.
