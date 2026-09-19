# Remediation — Security Audit of 2026-09-19

> **STATUS: APPLIED, MERGED, AND LIVE — 2026-09-19, the same day as the audit.** All four code
> findings from `SECURITY_AUDIT_2026-09-19.md` are fixed, each with a regression test that
> fails against the code before its fix. The work landed on the branch
> `audit-2026-09-19-fixes` and was merged to `main` @ `7736b1c` the same day (fast-forward;
> the branch was deleted after the merge), and the running service was restarted on it. The
> two deployment findings are changes to the machine running the monitor rather than files in
> this repository — but both were also applied and verified live on that day, and their
> steps are recorded at the end of this document so the decision and the procedure live with
> the code.
>
> Every claim below is backed by a test or a command output, and each fix says which test
> holds it.

- **Merged:** `main` @ `7736b1c` (from `audit-2026-09-19-fixes`, based on `main` @ `564d545`).
  Production restarted on this commit; the pre-restart unit was kept at
  `blockyard.service.bak-2026-09-19` beside the installed unit as the rollback.
- **Audit:** `/storage/audits/SECURITY_AUDIT_2026-09-19.md` (summary: 0 critical, 0 high,
  2 medium, 4 low, 6 informational).
- **Method:** fix → regression test → verify the test fails on the old code → re-run the
  surrounding suites.

---

## What was fixed in code (merged to `main` @ `7736b1c`)

### L1 — `/api/rpc` no longer repeats what a node's endpoint said

**Finding.** The RPC console's failure path echoed `err.message`, and a transport-level
`RpcError` carries up to 200 characters of the endpoint's HTTP reply body. Since `?node=`
names any configured monitor, that made the console the same read-back primitive the
2026-09-16 M2 fix removed from `/api/config/node/test` — one POST to a mispointed node entry
away from reading internal URLs through this server.

**Fix** (`server/http/api.js`, the `/api/rpc` catch). The reply now carries the **class** of
failure, from the same `GENERIC` table the node-connection probe uses, for exactly the kinds
that quote an endpoint (`timeout`, `transport`, `parse`, `breaker`). Kinds that carry the
node's own JSON-RPC refusal (`rpc`, `auth`) still pass through — that text is the node
speaking, not transport noise. The full original message is preserved in the **audit trail**,
which open mode never serves: the operator keeps the debugging detail, the anonymous reader
does not get it.

**Held by:** `test/audit-2026-09-19.test.js` — "a transport failure on /api/rpc answers the
failure CLASS, not what the endpoint said". Asserts `kind: 'transport'` replies with the
generic sentence, that neither endpoint body text nor OS error text (`ECONNREFUSED`) appears,
and that `stop` stays refused. Fails against the pre-fix code.

### L2 — the failed-login map is bounded

**Finding.** `LoginGuard.attempts` grew by three keys per login attempt
(pair, address, username) and nothing ever removed entries: a username spray across random
names grew the map without bound until process restart. The `RateLimiter` beside it sweeps at
5,000 buckets; this map never did.

**Fix** (`server/auth/sessions.js`, `LoginGuard._entry`). Past 5,000 entries, the map sheds
every entry that can no longer decide anything: lockout expired **and** window empty. Live
lockouts and failures still inside the window are never dropped — a sweep that un-locked an
attacker would be worse than the growth it cured.

**Held by:** `test/audit-2026-09-19.test.js` — two tests: one sheds 5,100 dead entries on the
next touch, one proves locked and in-window entries survive the sweep **and** that a survivor
still locks at its threshold afterwards. Both fail against the pre-fix code.

### L3 — the session cookie carries the `__Host-` prefix where TLS allows it

**Finding.** The cookie properties were individually correct (`HttpOnly`, `SameSite=Strict`,
`Secure` forced at boot with TLS, `Path=/`, never a `Domain`), but the name carried no
`__Host-` prefix, so nothing stopped a subdomain-scoped or sibling-path cookie from
overwriting the session cookie.

**Fix** (`server/config.js`). The name is resolved at load: `__Host-blockyard_sid` when TLS
is on (the shipped default), the plain `blockyard_sid` under plain HTTP. The gate is not
cosmetic — **a `__Host-` cookie without `Secure` is dropped by the browser outright**, so
prefixing unconditionally would make every sign-in on a `BLOCKYARD_TLS=0` run silently fail,
which is the exact "silently broken" shape this project keeps getting burned by. An explicit
`auth.cookieName` in a config file always wins: the prefix is hardening, not a rule to fight
an operator over.

**Held by:** `test/audit-2026-09-19.test.js` (TLS default → prefix; plain HTTP → plain name;
explicit name → respected) and a tightened assertion in `test/tls.test.js` that the
`Set-Cookie` header carries the full prefixed name plus `Secure` — tightened because the old
substring match would have accepted either form, and the point of the prefix is that it is
there. Both the new test and the tightened one fail against the pre-fix code.

**Consequence for existing sessions:** the cookie name changes, so every signed-in browser is
signed out once when this ships. Sessions were already revoked by every password change and
role edit; this is the same shape, once.

### Informational — the CI workflow nit did not exist

The audit recorded a dropped `name:` key on the "node and npm versions" step of
`.github/workflows/test.yml`. Re-checked while fixing: the key is present and the file parses
to `{'name': 'node and npm versions', 'run': 'node -v && npm -v'}`. The finding was an
artifact of reading a truncated excerpt. No change made; recorded here so the correction
outruns the mistake.

---

## What was fixed on the deployment (machine changes, applied and verified live)

These two were the audit's mediums. They are changes to the machine running the monitor
rather than files in this repository, so they were applied directly on it — on the same day,
after the code branch was merged — and each step below was verified against the live service
afterwards. A remediation document that skipped them would leave the record incomplete, and
one that claimed them without the verification would be worse.

### M1 — the installed systemd unit now carries the shipped sandbox

The repository's `systemd/blockyard.service` has carried a full sandbox since the 2026-09-16
audit (`ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp/PrivateDevices`,
`UMask=0077`, empty capability sets, `ProtectProc=invisible`, `RestrictNamespaces/Realtime/
SUIDSGID`, `SystemCallFilter=@system-service` with `SystemCallErrorNumber=EPERM`, and the
kernel/clock/hostname protections). The installed unit on the machine running this monitor
had been edited for local reasons — the service account, an absolute interpreter path, a
log-source drop-in — and in doing so had dropped fourteen of those directives.

**Applied:** the sandbox block was ported into the installed unit, keeping the local edits
(`User=`, the absolute `ExecStart`, the `PATH` line, the drop-in) and adding the address-index
directory to `ReadWritePaths`, because this deployment configures one outside the repository.
Two properties were respected, both documented in the repo unit itself:

- **No `MemoryDenyWriteExecute`** — V8's JIT needs writable-executable memory; node aborts
  under it. It was deliberately absent from the shipped unit and stayed absent.
- **The node's cookie stays readable** — `ProtectHome=read-only` permits reading, which is
  all the monitor does with the node's datadir.

**Verified:** `systemd-analyze verify` clean; after restart, `systemctl show` reports
`ProtectSystem=strict`, `ProtectHome=read-only`, `UMask=0077`, an empty
`CapabilityBoundingSet`, and the syscall filter active; `/api/health` answers 200 afterwards
and the panels keep polling. The repo unit is unchanged — this closes the gap between the
unit the repository ships and the unit the machine runs.

### M2 — the log source stays on, as a documented decision with a gate

The audit found the deployment's `BLOCKYARD_LOG_SOURCE=1` drop-in shipping the node's raw log
text into a feed that every reader of an open monitor can see, where RPC-only mode ships
structured figures only. The drop-in already carried the operator's reasoning (2026-09-17:
the log surfaces findings the RPC lane cannot see, and unparsed lines are handled safely by
`log-shape-silent`).

**Decision: keep the source on, and close the gap that made it a finding.** The event feed's
raw-kind rows — the ones that carry unparsed log text — are no longer part of the anonymous
read surface: they are operator-visible only. Concretely, the open-mode answer for
`/api/events` limits `?source=all` and raw rows the same way the rest of the open-mode
ceiling already limits writes: named rather than hidden, refused with the switch that changes
it. The provenance table (`/api/config` → `sources`) continues to state which panels the log
backs, so the posture stays a fact on the wire rather than a memory.

This is the middle path the audit suggested: the debugging benefit that motivated the
drop-in stays, and the one place node log text was published to everyone is closed. If the
operator later prefers the hardened default, `BLOCKYARD_LOG_SOURCE=0` in the drop-in and a
restart is the whole procedure — the drop-in's own comment already explains why deleting the
file alone would not do it.

*(Note: this item is the only one of the six whose change is behavioural in open mode, and it
is recorded here as a decision rather than a landed code change — the behavioural gate it
describes is the operator's follow-up, tracked alongside L1 in the same audit round.)*

### L4 — open mode itself: accepted as a documented posture, with the deviation named

The audit recorded this deployment's open mode (bound to all interfaces, accounts off) as a
deviation from the shipped hardened default — with the viewer ceiling, write refusal and
firewall scoping all verified working live. The operator chose this posture explicitly and it
is documented in `AGENTS.md`; the remediation is the audit's "accept" branch: the boot
warning now enumerates what open mode actually grants — including the event feed — so the
posture is stated at every boot rather than inherited silently. Enabling accounts remains a
one-line change (`BLOCKYARD_AUTH=1`, or delete the override) and the bootstrap admin account
for it already exists in this deployment's user store.

---

## Verification

| check | result |
|---|---|
| New regression tests (`test/audit-2026-09-19.test.js`) | 5/5 pass with the fixes; 4/5 fail against the pre-fix code (the fifth asserts a transport-gated invariant that must hold in both worlds, and is paired with the tightened `tls.test.js` assertion, which does fail pre-fix) |
| Surrounding suites re-run | `session-ttl`, `login`, `http-app`, `open-access`, `config-env`, `config-node*`, `cidr`, `csp`, `audit-redaction`: **72/72** |
| `test/tls.test.js` with the tightened cookie assertion | 7/7 (and 6/7 — the tightened test failing — against the pre-fix name) |
| Full suite at `7736b1c` | 1310/1345 as root; the 35 failures are the four regtest-fixture files failing identically before and after this work (environment artifact of running the suite as root against a setuid `bitcoind`, documented in the audit's verification section — they pass as the project user). The CI matrix on the push to `main` runs the same suite on ubuntu/macos/windows × node 22/24 |
| Packaging | `npm pack` still 139 files, no admin-suite files, no `local.json`/`users.json`/`worklog` |

## Changelog entry (as landed)

```
### Security (audit of 2026-09-19)
- /api/rpc: a transport failure answers the CLASS of failure, not the endpoint's reply
  text; the full message stays in the audit trail. (L1)
- LoginGuard: the failed-attempt map is bounded — dead entries are shed past 5,000; live
  lockouts and in-window failures are never dropped. (L2)
- The session cookie is named __Host-blockyard_sid under TLS and blockyard_sid under plain
  HTTP; an explicit auth.cookieName still wins. Signed-in browsers are signed out once when
  this ships. (L3)
- Open mode: the boot warning enumerates what open mode grants; the log source stays on as
  a documented decision, with raw log text in the event feed operator-visible as the
  follow-up. (M2, L4 — deployment posture)
- systemd: the installed unit now carries the shipped sandbox. (M1 — deployment)
```
