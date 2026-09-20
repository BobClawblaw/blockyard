# BlockYard Security Audit — 2026-09-19, second round

> **STATUS: EVERY CODE FINDING REMEDIATED — 2026-09-20, branch `audit-2026-09-19-round2`.**
> Findings: **0 critical, 0 high, 2 MEDIUM, 2 LOW** — none in code that ships today. The
> MEDIUMs are the open-mode log feed on `/api/events` (the gate the first round's
> remediation doc described but never landed, item 2 of the reconciliation's consolidated
> list) and the `admin.allowWithoutAuth` disclosure gap (item 3). The LOWs are the shipped
> unit's commented-out `PATH` pin (item 4) and regtest helper hygiene (item 5). Every
> finding has a regression test that failed against the pre-fix code; the remediation
> record, per fix, is `docs/REMEDIATION-2026-09-19b.md`.
>
> This is the **second** audit of 2026-09-19; the "b" keeps its date files clear of the
> first round's (`docs/REMEDIATION-2026-09-19.md`). Severity scale:
> CRITICAL / HIGH / MEDIUM / LOW / INFO.

- **Project:** BlockYard, a multi-user web monitor for a Bitcoin Core node
  (`/storage/blockyard`), version 0.1.3 (prepared, not tagged, not published).
- **Audit date:** 2026-09-19 (UTC), single session, after the first round's fixes had
  landed (`7736b1c` was in the tree; this audit re-verified that commit's work as part of
  its read).
- **Report generator model:** `qwen38-nvfp4` (NVFP4-quantized Qwen on a custom inference
  endpoint), running as Hermes Agent by Nous Research.
- **Remediation model:** the fixes this report records were implemented by Qwen 3.8 27b
  (branch `audit-2026-09-19-round2`, 2026-09-20), each against a test that failed first.
- **Repo state at audit:** branch `main` @ `e3c94e5` (clean working tree, `git status`
  empty).
- **Full report:** `/storage/audits/SECURITY_AUDIT_2026-09-19.md` (405 lines). This file
  is the in-tree record of it: the findings, their evidence, and their state.
- **The first round of the same day:** GLM-5.3-Flash-EXL3, via Hermes Agent, ran
  ~18:30–19:00 against `main` @ `564d545` — before the fixes. Its report is
  `/storage/audits/SECURITY_AUDIT_2026-09-19.pdf`, its remediation record is
  `docs/REMEDIATION-2026-09-19.md` (findings L1–L3, fixed in `7736b1c` the same day), and
  its two deployment findings (the installed-unit sandbox drift, the open-mode log-source
  deviation) were settled on the machine and by decision the same day, with the log-feed
  gate as the named follow-up this round closes. The two rounds' reconciliation is
  `/storage/audits/RECONCILIATION_2026-09-19.md`.
- **System at audit (no personal identifiers):** Ubuntu 24.04.4 LTS, kernel
  7.0.0-31-generic, x86_64, AMD Ryzen 9 9950X3D (32 threads), 123 GiB RAM, Node v22.23.2.
  No usernames, no home paths, no user addresses. Measured 2026-09-20 on the same host.
- **Method:** parallel line-level review of every security-relevant module, with each
  sub-review's file:line claims re-checked against the source; the 2026-09-16 audit's 36
  findings re-verified against the tree (not against their FIXED notes); `npm test` and
  `bash scripts/smoke.sh` at `e3c94e5`; the release-guard and edition suites re-run.
  At audit time the suite was 1311 pass with 34 regtest failures that traced to this
  host's `/tmp` being unable to hold a regtest datadir (verified by running `bitcoind`
  directly with a hand-created datadir).

---

## Findings

### M2 follow-up (MEDIUM) — the open-mode log feed on `/api/events`

The first round found its deployment's `BLOCKYARD_LOG_SOURCE=1` drop-in shipping the
node's raw log text into a feed every reader of an open monitor can see, and settled it
as a documented decision: **keep the source on** (2026-09-17, operator: the log surfaces
findings the RPC lane cannot see), **close the gap by making the event feed's raw-kind
rows operator-visible only** — "the open-mode answer for `/api/events` limits `?source=all`
and raw rows the same way the rest of the open-mode ceiling already limits writes: named
rather than hidden, refused with the switch that changes it."

**That gate was not in the code at `e3c94e5`.** This round read the handler
(`server/http/api.js`, `/api/events`, `auth: 'any'`) and confirmed it: with accounts off,
`?source=all` answered every reader on the network bind with the whole event feed,
including `kind: 'raw'` rows (unparsed node-log lines, `source: 'log'`). The remediation
doc was honest that the item "is recorded here as a decision rather than a landed code
change"; this round records that the change was still pending, and the reconciliation
settles it as the single most important open item neither final state fully reflected.

**Fixed 2026-09-20** on this branch (`auth.openEventsFromNetwork`,
`BLOCKYARD_OPEN_EVENTS_FROM_NETWORK`, default false; see the remediation record for the
exact behaviour and its tests). The log source stays on; the gate is open-mode only;
accounts-on deployments are unaffected.

### N1 (MEDIUM) — `admin.allowWithoutAuth`: the gate condition, correctly labelled, with one disclosure gap

The gate chain (`docs/PLAN-ADMIN-SUITE.md` §2, `server/admin-gate.js`) has six conditions;
condition 3 ("accounts on") is defeatable by the explicit switch `admin.allowWithoutAuth:
true`. The switch's refusal message says exactly what it is ("anyone who can reach the
port is an administrator"), the plan says the suite "can spend money and has not had a
security review" and ships nowhere, and the released builds do not carry it (the four
release guards hold — re-run green at `e3c94e5` and again on this branch). **The switch
is not set in this box's config; the suite is not loaded here.**

The one gap is disclosure: the suite's own status report shows `accounts: false` without
naming what opened the gate. **Fixed 2026-09-20**: the ON line (boot banner and the
status route's summary, one function) now names the switch, and the status payload
carries `allowWithoutAuth` next to `accounts`.

**Measured correction, 2026-09-20 (against the pre-fix server):** the first-round report
described the open-mode reach as "every `/api/admin/*` route answers". That is not what
the pre-fix code does: with accounts off and `admin.allowWithoutAuth: true`,
`/api/admin/status` answered **403** — the `viewer` ceiling applies to admin routes
whether or not the switch is set, because in open mode the only identity is the frozen
`viewer` and every suite route asks for role `admin`. The switch satisfies the gate, so
the suite **loads** (its modules enter the process, its UI files are served); it does not
make the routes **reachable**. The remediation's disclosure states exactly that, and a
test holds it: a real boot with the switch on and accounts off asserts the banner names
the switch **and** that `/api/admin/status` answers 403.

### N2 (LOW) — the shipped unit's `ExecStart` depends on the default `PATH`

`systemd/blockyard.service` runs `ExecStart=/usr/bin/env node server/main.js` with the
`Environment=PATH=` line present but commented out. The unit is sandboxed (the 09-16 M8
fix, re-verified here), so a compromised process cannot swap the interpreter; the
exposure is the ordinary one — an install whose default `PATH` resolution ever finds a
different `node` first. **Fixed 2026-09-20**: the line is uncommented, the reasoning
kept beside it. Rollout note in the remediation record.

### N3 (LOW) — regtest hygiene: failures that read like app defects, and the litter they leave

On the audit host the regtest node could not start (its `/tmp` could not hold the
datadir — "Permission denied" creating `regtest/wallets`, confirmed by running
`bitcoind` directly with a hand-created datadir; **not** root or setuid — a
host-permission condition of the filesystem). Every regtest-based suite therefore failed
rather than skipped, and each failure left an empty `blockyard-*` datadir in `/tmp`:
about 18,000 after one `npm test` run.

**Fixed 2026-09-20**: the helper probes the host (binary present **and** the datadir
shape actually creatable) and the suites skip with the one-line reason instead of failing
N tests; every start — the helper's and the three files that keep their own scaffolding —
removes its datadir and kills its node on a failed start, so a failure leaves no litter
and no running process.

**Re-measured 2026-09-20 on the same host: the condition no longer reproduces.**
`bitcoind` now starts and runs in `/tmp` (the host was reloaded between the two
measurements; the ~18,000 datadirs were cleaned up), and the full suite passed
1345/1345 with the regtest suites running for real. The fix stands as hygiene: on this
host the suites now run and clean up after themselves; on a host like the audit
host's, or CI without `bitcoind`, they skip with the reason instead of reporting
failures that read like app defects.

---

## Re-verification of the earlier audits (independent, not on trust)

Every finding of the 2026-09-13, 2026-09-14 and 2026-09-16 audits (36 findings, all
marked fixed on their days) was re-checked against `e3c94e5`. **None regressed.** The
load-bearing ones, with the evidence that held:

| Prior finding | State at `e3c94e5` | Evidence |
|---|---|---|
| 09-16 H1 — a stalled SSE client is never dropped | Holds | `server/http/sse.js` `SSE_LIMITS` (4 MB buffered / 1 min blocked → drop; 16 streams per address/account), applied in `server/http/server.js` |
| 09-16 M1/M2 — open-mode node connection: script reach, probe SSRF | Holds, and tightened since | loopback-only in open mode (`isLoopbackAddress`, `X-Forwarded-For` never consulted; behind `server.trustProxy` refused outright); a probe of a foreign endpoint carries no datadir/cookieFile/rpcUser, so `resolveCookie` returns null; a foreign endpoint's answer is the class of failure, not its body |
| 09-16 M3 — the index build deletes its output directory | Holds | symlink/root/home/working/blocks-directory refusals; index-named files only; temps `O_EXCL` owner-only |
| 09-16 M4 — wallet key reads in the RPC allowlist | Holds | `WALLET_METHODS` refusal; the suite's own allowlist refuses `listdescriptors` with any argument; `gethdkeys` not listed |
| 09-16 M5/M6/M7 — body deadline; audit-string flush; private docs in the pack | Hold | 30 s request timeout + 1 MB cap; 1,024-char clamp now covers the suite's audit calls too; the pack is pinned to tracked files (release-guard re-run 7/7) |
| 09-16 M8 — the shipped unit had almost no sandboxing | Holds | `ProtectSystem=strict` + `ReadWritePaths` for `data/`/`config/`, `ProtectHome=read-only`, `PrivateTmp`, `NoNewPrivileges`, `CapabilityBoundingSet=`, `UMask=0077`, address-family and syscall restrictions (full list in the 09-16 report §M8) |
| 09-16 L1–L17 | All hold | spot-checked the load-bearing ones: open-redirect guard, `kv()` escaping, coinbase pool attribution, order-book cap, the log-parser line cut (`MAX_LINE = 8192`), height-table sizing from the tip, the build journal, the audit-log fchmods, the redacted paths, `setup.js`'s non-echoing 0600 writes, the percent-encoding 400 |
| 09-14 M1/M2, L1–L4, I1 | Hold / open by decision | the page-sized allocation bound, the post-tip row exclusion, the pool-key escaping, the transaction-cache byte bound all still in place; **I1** (open-mode config save aims the cookie) is open by decision and now loopback-gated in open mode, named in `docs/SECURITY.md` |
| The first round of 09-19 (`7736b1c`) | Fixed, verified | the `/api/rpc` transport-class answer, the bounded `LoginGuard` map (5,000 entries; sheds only dead lockouts), the `__Host-`-prefixed session cookie under TLS, the tightened `test/tls.test.js` assertion. Its note that the CI workflow "dropped the name key" was confirmed an artifact of a truncated excerpt: `.github/workflows/test.yml` parses the `run:` key correctly |

## The unreviewed surface, stated plainly

**The code that can spend money is on `main` on this machine.** M4–M7 (send,
transaction tools, daemon control, config editors) merged 2026-09-19 (`fbd3be1`) after
a money-safety **code read** (four parallel reviews, findings reproduced against a
throwaway regtest node or confirmed in the code before they counted, then fixed with
tests that failed first). That read was not a security audit: `docs/PLAN-ADMIN-SUITE.md`
M8 — "the fourth security audit, run over the whole suite the way 2026-09-16's was run
over the monitor" — is not started, deliberately. What keeps the money surface safe in
the meantime is the release rule: **no released artifact carries the suite** — the npm
`files` list, the `.dockerignore`, the edition build's refusal, and the registry's
`private` mark, all held by `test/release-guard.test.js` (re-run green at `e3c94e5` and
on this branch). This audit did not change that, and its remediation does not.

## Open after this round (by design, each named)

| Item | State |
|---|---|
| M8 — the security audit of the administrative suite | **Open — top priority.** Not started, deliberately; the release exclusion holds in the meantime |
| I1 (2026-09-14) — open-mode config save aims the cookie | Open by decision; loopback-gated in open mode since 09-16; named in `docs/SECURITY.md` |
| The open-mode posture itself (bound to a reachable address, accounts off, on this box) | The operator's choice, announced at every boot with the switch that closes it |

## What was done right (observed this pass, not inherited from the last audit)

- The gate the suite's money paths live behind is a load decision made **before** the
  capability is imported — a route that returns 403 is one bug away from not returning
  403; code that was never imported cannot be reached by any bug, including one in the
  gate itself.
- The open-mode ceiling is enforced on **both** branches of the session check, and the
  anonymous identity is frozen `viewer` with a refusal that says what it is (the
  403s measured above for N1 are this ceiling doing its job).
- The 09-16 audit's loopback gate handles the proxy case by refusing, not by trusting
  the proxy's word for the caller's address; this round's log-feed gate takes the same
  stance (it keys off `auth.enabled`, not the caller's address).
- The audit trail's string clamp reached the suite's `app.audit()` calls in the
  remediation round — the 09-16 M6 fix did not stop at the monitor's own call sites.
