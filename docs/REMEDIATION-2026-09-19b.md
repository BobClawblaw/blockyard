# Remediation — Security Audit of 2026-09-19, second round

> **STATUS: APPLIED — 2026-09-20, branch `audit-2026-09-19-round2` (four fixes, four
> commits; docs in a fifth).** Every code finding of the second 2026-09-19 audit
> (`docs/SECURITY-AUDIT-2026-09-19b.md`, full report
> `/storage/audits/SECURITY_AUDIT_2026-09-19.md`) is fixed here, each against a
> regression test that was run against the pre-fix code and failed. The fixes were
> implemented by **Qwen 3.8 27b**; the audit they answer was run by `qwen38-nvfp4` via
> Hermes Agent. The first round of the same day (GLM, `docs/REMEDIATION-2026-09-19.md`)
> is untouched, as are its test files.
>
> Every claim below is backed by a test or a command output, and each fix says which
> test holds it.

---

## A — the open-mode log feed on `/api/events` is gated (M2 follow-up, MEDIUM)

**Finding.** The first round's remediation said the open-mode answer for `/api/events`
would limit `?source=all` and raw rows "named rather than hidden, refused with the
switch that changes it"; the gate it described was never in the code, and the second
round confirmed it at `e3c94e5`: with accounts off, `?source=all` answered the node's
log — including the `kind: 'raw'` rows (unparsed log lines) — to anyone who could
reach the port.

**What changed.**

- `server/config.js`: `auth.openEventsFromNetwork` (default `false`), next to
  `openNodeConfigFromNetwork`, with the reasoning beside it; the env var
  `BLOCKYARD_OPEN_EVENTS_FROM_NETWORK` in the env table.
- `server/http/api.js`, the `/api/events` handler: with accounts off and the switch
  unset, `?source=all` is **refused** — 403, `code: 'log_feed_closed'`, the switch named
  in the refusal — and `kind: 'raw'` rows are **dropped from every answer**.
  `?source=log` still serves the parser's *structured* rows (the debugging benefit the
  `BLOCKYARD_LOG_SOURCE=1` drop-in was chosen for stays; the verbatim log text does not).
  The gate keys off `auth.enabled`, not the caller's address: behind
  `server.trustProxy` every request looks local, so an address check would be a
  fiction — the same stance as the 09-16 loopback gate's proxy clause. With accounts on
  the gate does not exist.
- Docs: `docs/CONFIGURATION.md` (the key and the env var), `docs/SECURITY.md`'s
  open-mode table (the event feed's log rows move to the "still closed" side, the
  switch named).

**Held by.** `test/audit-2026-09-19b.test.js` — the refusal (message and code, three
`?source=all` spellings), the raw-row drop on the default and `?source=log` answers
(against a feed with a monitor row, a structured log row and a raw row), the opt-in
restoring `?source=all` with the raw rows, the accounts-on invariant (the gate does not
exist), the config default, and the real-server wiring (a booted open-mode app: the
default call answers 200 with no raw rows, `?source=all` answers 403). The env var is
asserted in `test/config-env.test.js` (the file that is allowed to touch
`process.env`). All failed against the pre-fix code.

**Rollout / operator note.** Restarting the monitor on this build changes what open
readers see: `?source=all` on `/api/events` refuses. On this box (open mode, log source
on, per the operator's 2026-09-17 decision) that is the intended posture; the UI's own
event calls pass no `source` and are unaffected. To serve the log feed to open readers
again: `auth.openEventsFromNetwork: true` in the config (or
`BLOCKYARD_OPEN_EVENTS_FROM_NETWORK=1`), then restart. The live SSE stream is a
separate surface and keeps its own (pre-existing) raw-chatter filter; the gate here
governs the historical endpoint the audit named.

**Verify.** `node --test test/audit-2026-09-19b.test.js test/config-env.test.js`
(both green on the branch; four of the five gate tests fail on `e3c94e5`).

## B — `admin.allowWithoutAuth` is named in the suite's reporting (N1, MEDIUM)

**Finding.** With accounts off and the switch on, the suite loads, and the operator
could not tell from the suite's own reporting what opened the gate. One correction was
measured against the pre-fix server before the wording was written (2026-09-20): in
that mode `/api/admin/status` answers **403** — the `viewer` ceiling applies to admin
routes whether or not the switch is set. The switch satisfies the gate (the suite
**loads**: its modules enter the process, its UI files are served); it does not make
the routes **reachable**. The disclosure states exactly that.

**What changed.**

- `server/admin-gate.js`, the ON line of `adminGateLine` (the boot banner **and** the
  status route's summary are one function): in that configuration it now reads
  `accounts off, loaded via admin.allowWithoutAuth; its routes still refuse -- with no
  accounts there is no admin role to grant, so the suite is in this process but not
  reachable over HTTP (BLOCKYARD_AUTH=1 for reachability)`. With accounts on the switch
  plays no part in the gate, and the line does not claim one.
- `server/admin/index.js`, the status payload: `gates.allowWithoutAuth` next to
  `gates.accounts`, in both states.

No gate behaviour changes; no new config.

**Held by.** `test/admin-disabled.test.js`, three new tests: the line in both states
(named with the switch when it did the opening; silent with accounts on), a real boot
with the switch on and accounts off asserting the banner names the switch **and** that
`/api/admin/status` answers 403 (the measured semantics, so the disclosure cannot
drift from the server), and the status payload in both states. All three failed against
the pre-fix code.

**Rollout / operator note.** Nothing to roll out: the line only changes in a
configuration where the suite loads with accounts off.

**Verify.** `node --test test/admin-disabled.test.js` (12/12 on the branch; the three
new tests fail on `e3c94e5`).

## C — the shipped unit pins `PATH` (N2, LOW)

**Finding.** `systemd/blockyard.service` runs `ExecStart=/usr/bin/env node
server/main.js` with `Environment=PATH=` commented out: what the service ran depended
on systemd's default `PATH`. The unit is sandboxed (09-16 M8), so a compromised process
cannot swap the interpreter; the pin covers the ordinary case — an install whose
default `PATH` resolution finds a different `node` first.

**What changed.** `systemd/blockyard.service`: the line uncommented
(`Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin`), the
reasoning kept beside it, and a note that the pin documents the measured order rather
than guessing a new one. No behaviour change on this box (measured: the pinned order
starts with the same directories systemd's default `PATH` starts with).

**Held by.** `test/audit-2026-09-19b.test.js`: the directive must be present and
active, and the commented-out form is asserted to be the pre-fix state. Failed against
the commented state.

**Rollout.** The installed unit is `/etc/systemd/system/blockyard.service` — a rollout
step, not part of this change: apply the same line there, then
`systemctl daemon-reload && systemctl restart blockyard`. (This box's installed unit
already carries the first round's sandbox; only the `PATH` line is new.)

**Verify.** `node --test test/audit-2026-09-19b.test.js` (the N2 test fails on
`e3c94e5`).

## D — the regtest suites skip with a reason; failed starts clean up (N3, LOW)

**Finding.** On the audit host the binary was present but the OS temp directory could
not hold a regtest datadir ("Permission denied" creating `regtest/wallets`, confirmed
by running `bitcoind` directly; a host-permission condition, not root/setuid). Every
regtest suite failed instead of skipping, and each failure left an empty `blockyard-*`
datadir in `/tmp` — about 18,000 after one `npm test` run.

**What changed.**

- `test/helpers/regtest.js` exports `regtestUnavailable()`: `null`, or a one-line
  reason. It checks the binary **and** creates the exact shape `bitcoind` itself
  creates (a datadir with `regtest/wallets` inside) in a scratch directory, then
  removes the scratch directory; the answer is cached per process.
- The four regtest suites (`test/admin-money-regtest.test.js`,
  `test/admin-daemon.test.js`, `test/admin-send-regtest.test.js`,
  `test/admin-txtools-regtest.test.js`) now select `describe.skip` with that reason
  when the host cannot run regtest, instead of failing N tests that read like app
  defects. The sentinel that used to assert "a bitcoind exists" now asserts "regtest
  can run here, or say why the suite is skipped", and is itself skipped with the reason.
- Every regtest start — the helper's and the three files that keep their own
  scaffolding — removes its datadir and kills a node that spawned but never answered
  RPC on a failed start, so a failure leaves no litter and no running process.

**Held by.** `test/audit-2026-09-19b.test.js` holds the probe's contract
host-independently (null-or-reason, cached, no scratch litter); the four suites'
sentinels hold the skip decision. Against the pre-helper code all four files failed at
import (the probe did not exist); with the helper, the suites run for real on a host
that can run regtest — on this host that is 51/51 against real Core regtest nodes, with
no `blockyard-*` datadirs left in `/tmp` afterwards.

**Re-measured 2026-09-20 on the audit host: the environmental condition no longer
reproduces** (the host was reloaded between the two measurements; the datadir litter
was cleaned up). `bitcoind` now starts and runs in `/tmp`, and the regtest suites pass
for real here. The fix stands as hygiene for the class of host the audit measured, and
for CI runners without `bitcoind` (which skip with the candidate list named, as before).

**Verify.** `node --test test/admin-money-regtest.test.js test/admin-daemon.test.js
test/admin-send-regtest.test.js test/admin-txtools-regtest.test.js
test/audit-2026-09-19b.test.js` (green on the branch).

---

## Baseline and state

- **Before** (`e3c94e5`): the suite declared 1311 tests; on this host `npm test`
  initially reported 1311 pass + 34 regtest failures (the environmental `/tmp`
  condition above). `bash scripts/smoke.sh`: 109/109.
- **After** (this branch, 2026-09-20): the suite declares 1322 tests (1311 + 7 in
  `test/audit-2026-09-19b.test.js` — five for A, one for C, one for D — + 1 env-var
  test in `test/config-env.test.js` + 3 in `test/admin-disabled.test.js`); `npm test`
  passes in full on this host — the regtest suites now run for real, 0 fail, 0 skip.
  `bash scripts/smoke.sh` passes. The documented count is regenerated with
  `npm run counts:fix` in the accompanying commit.
- **Deliberately not fixed:** M8 — the security audit of the administrative suite.
  Open by design, top priority when it runs; no released artifact carries the suite,
  and the four release guards (`test/release-guard.test.js`) were re-run green on this
  branch. The operator's open-mode posture and I1 (2026-09-14) stand as decided and
  named in `docs/SECURITY.md`.
