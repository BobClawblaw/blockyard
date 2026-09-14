# Auto-update — design

**Status: proposal, not implemented.** Written 2026-09-13 at the operator's request: "design an
auto-update system that integrates with github, so users can upgrade-in-place when notified", with
a dialog showing "update notes vs last version(s)".

Decisions taken by the operator, and designed to here:

| question | choice |
|---|---|
| autonomy | **notify + one-click apply** — nothing moves without a human |
| authenticity | **pinned repo over HTTPS, no signatures** |
| who may apply | **admin; or anyone, when accounts are off** |

---

## 1. What already exists

Three quarters of the notification half is built, and the design leans on it rather than
duplicating it.

- **`computeBuildId(root, version)`** (`server/http/static.js`) hashes every file under `public/`
  by name, size and mtime into `<version>-<10 hex>`. It is recomputed per request, deliberately,
  so it reflects the code *on disk* rather than what the process read at boot.
- **`GET /api/build`** answers `{ version, build, matchesClient }` and is `auth: 'none'` — the one
  thing a login page is allowed to know.
- **The browser already polls it** every five minutes (`checkBuild()` in `public/js/app.js`) and
  shows a `stale build — reload` badge in the header (`#buildNote`). This is the notification
  surface; it currently means "the files on disk changed under your tab", and gains a second
  meaning: "a newer release exists upstream".
- **`Restart=always`** in the systemd unit. This is the single most useful fact in the design: the
  updater never needs `sudo`, `systemctl`, or any privilege at all. It writes files, exits 0, and
  systemd restarts it. (This box happens to have `NOPASSWD: ALL`, and the design must not rely on
  that, because users will not.)
- **Zero dependencies and no build step.** An update is *replace files and restart*. There is no
  `npm install`, no compile, no native module to rebuild — which removes the largest single source
  of update failure in self-hosted software.
- **State is already isolated from the code.** `config/local.json`, `config/blockyard.json` and
  `data/` are gitignored, so a `git checkout` cannot touch them. Verified.

## 2. Threat model, stated plainly

An updater is a mechanism for **running code from the internet as the service account**, on a box
that holds node RPC credentials and can reach a Bitcoin node. That deserves naming before any
mechanism is chosen.

What the chosen options do and do not defend against:

| threat | covered? |
|---|---|
| Network attacker tampering in transit | **Yes** — HTTPS with certificate validation, pinned remote URL. |
| Someone pointing the updater at a different repo | **Yes** — the remote URL is pinned in code, not read from config. |
| Downgrade to a known-vulnerable older release | **Yes** — fast-forward-only; see §4. |
| History rewrite / force-push on the release branch | **Yes** — fast-forward-only refuses it. |
| **Compromise of the GitHub account or repo** | **No.** Without signatures, a malicious push is indistinguishable from a release. This is the accepted residual risk of the "no signatures" choice. |
| **A stranger on the LAN triggering an update** | **Not in open mode** — see the objection in §6. |

Signed tags remain the upgrade path if that residual risk ever stops being acceptable; §9 says what
would change.

## 3. Release channel

Releases are **annotated git tags** matching `v<major>.<minor>.<patch>` on the pinned remote. Not
branch heads: a branch tip is whatever was pushed last, including a half-finished afternoon.

```
origin  https://github.com/BobClawblaw/blockyard.git   (pinned in code)
tag     v0.1.0, v0.1.1, ...
```

The updater does a **shallow tag fetch** (`git fetch --tags --depth=1 origin`) — the repository is
12 MB today, but a user's machine should not pay for history it will never read.

> **Blocker for public use:** the repository is **private**. `git fetch` from a user's deployment
> needs credentials that do not exist. On this box it works only because `gh` puts a `GH_TOKEN` in
> the environment — there is no credential helper configured. **The updater is unusable by anyone
> else until the repository is public**, and no amount of design fixes that. This is the first
> thing to resolve before implementing.

## 4. Mechanism

### 4.1 Check (cheap, periodic, read-only)

Every `update.checkEveryMs` (default 6 h, `0` disables), and on demand:

```
git ls-remote --tags --refs origin      # one network call, no objects fetched
```

Pick the highest tag by semver that is **greater than the running version**. Cache
`{ latest, checkedAt, notes }` in memory and in `data/update-state.json`.

*No GitHub API, no token, no rate limit to respect* — `ls-remote` is the same transport as the
fetch, and works for a private repo with whatever credential the user configured.

### 4.2 Notes for the dialog

The operator asked for "update notes vs last version(s)" — plural, which matters: someone three
releases behind should see all three, not just the newest.

Notes come from **`CHANGELOG.md` at the target tag**, not from the GitHub Releases API. The reason
is integrity, not convenience: the notes then come from the same pinned source as the code, so they
cannot disagree with what is about to be installed.

```
git fetch --depth=1 origin tag v0.1.2
git show v0.1.2:CHANGELOG.md
```

Parse the `## [x.y.z] — date` sections, take every section newer than the running version, and
return them as structured entries:

```json
{ "current": "0.1.0", "latest": "0.1.2", "behind": 2,
  "releases": [
    { "version": "0.1.2", "date": "2026-09-20", "sections": { "Fixed": ["..."] } },
    { "version": "0.1.1", "date": "2026-09-16", "sections": { "Added": ["..."], "Fixed": ["..."] } }
  ] }
```

`CHANGELOG.md` already has the required shape (`## [0.1.0] — 2026-09-14`). Markdown is rendered as
**text, not HTML** — see §7.

### 4.3 Apply

1. **Refuse if the working tree is dirty.** `git status --porcelain` must be empty. An operator who
   edited a file locally gets told so, with the file list, rather than having the edit destroyed or
   the updater silently refusing forever. This is a real case: this deployment has been edited in
   place repeatedly.
2. **Refuse if not fast-forward.** `git merge-base --is-ancestor HEAD <tag>` must succeed. This is
   what makes downgrade and force-push rewrite impossible without a human on the box.
3. **Record the rollback point** — `git rev-parse HEAD` into `data/update-state.json`, with the
   version and timestamp, *before* anything moves.
4. **Check out the tag** — `git -c advice.detachedHead=false checkout --detach <tag>`.
5. **Verify what landed** — `git rev-parse HEAD` matches the tag's commit, and `package.json`'s
   version matches the tag. A mismatch aborts and rolls back immediately.
6. **Audit** the whole thing: `{ type: 'update', from, to, user, ip, ok }`.
7. **Exit 0.** systemd restarts the process on the new code. The browser's existing five-minute
   `checkBuild()` poll notices the new build and shows the reload badge — no new client machinery.

There is deliberately **no `npm install` step**, because there are no dependencies. If that ever
changes, this design needs revisiting, not extending.

### 4.4 Rollback

`POST /api/update/rollback` checks out the recorded previous commit and exits 0. One click, and it
works even if the new version cannot serve a page, because the *previous* process is what is
running by then. A version that fails to boot is caught by systemd's restart loop; the rollback
point on disk is what an operator uses from the shell (`git checkout <sha>`), and the docs must say
so, because a UI cannot rescue a server that will not start.

## 5. API surface

| route | auth | purpose |
|---|---|---|
| `GET /api/update` | `any` | `{ current, latest, behind, releases[], checkedAt, dirty, canApply, reason }` |
| `POST /api/update/check` | admin-or-open | Force a check now. Rate limited. |
| `POST /api/update/apply` | admin-or-open | Body `{ version, confirm: "<version>" }`. |
| `POST /api/update/rollback` | admin-or-open | Body `{ confirm: "rollback" }`. |

`confirm` must equal the **version being installed** — the same shape as the node-connection form's
`confirm: "save"`, but carrying the target, so a replayed or cross-site request cannot apply a
different release than the one the dialog showed.

## 6. The open-mode objection

The operator chose "admin; or anyone, when accounts are off", matching `configWriteAllowed`. The
design implements that, and records the objection, because it contradicts the project's own
strictest existing rule.

`actionAllowed()` in `server/rpc/allowlist.js` refuses node writes in open mode *even when the
operator has explicitly listed them*, with this reasoning:

> accounts are off, so there is no identity to hold a node write accountable

A node write is one RPC call. **An update replaces the entire codebase and restarts the process.**
If the stricter rule is right for `savemempool`, it is hard to argue it is wrong here. Under the
chosen setting, on a default install, anyone who can reach port 21000 can make the server fetch and
execute a new release.

Mitigations that preserve the operator's choice:

- **Only tagged releases** — not arbitrary commits or branches.
- **Fast-forward only** — no downgrade, no rewritten history.
- **Typed confirmation** carrying the target version.
- **Cross-site refused** — the `Origin`/`Sec-Fetch-Site` check added 2026-09-13 already covers open
  mode, so a drive-by page cannot trigger it; the exposure is to someone who can reach the port.
- **Audited**, with the applying identity (or `anonymous`) and address.
- **Rate limited**, one apply in flight at a time.

If that residual is not acceptable later, the one-line change is an
`update.allowWithoutAuth` flag defaulting to `false`, mirroring `actions.allowWritesWithoutAuth` —
which is exactly how the project already resolved this same argument once.

## 7. UI

**Notification.** The existing `#buildNote` badge gains a second state: `update available — v0.1.2`.
It already polls every five minutes and already handles "server unreachable" without lying.

**Dialog.** Reuse the settings modal's structure (`.cfgwrap` / `.cfgscrim` / `role="dialog"
aria-modal="true"`), which is the overlay pattern that already renders correctly in Safari after
the 2026-09-12 fix. Contents:

- current version → target version, and how many releases are being skipped;
- **one collapsible block per intervening release**, newest first, with its date and its
  Added/Changed/Fixed sections;
- what will happen, in words: the server restarts, settings and history are untouched, the page
  reloads itself;
- any blocker, stated before the button: a dirty tree lists the modified files;
- the confirm field, and **Update** / **Cancel**.

**Rendering the notes is a security boundary.** `CHANGELOG.md` is attacker-influenced input in the
threat model where the repo is compromised. It is rendered as **escaped text** through
`fmt.esc()` — no markdown-to-HTML, no `innerHTML` of remote content. The CSP has no
`unsafe-inline` and `csp.test.js` enforces that; this must not become the exception.

## 8. Configuration

```json
{ "update": {
    "enabled": true,
    "checkEveryMs": 21600000,
    "channel": "stable"
} }
```

The remote URL is **not** configurable — it is pinned in code. Making it a config value would turn
a config-file write into arbitrary code execution, and this app has a config-writing endpoint.

## 9. What would change with signatures

If the residual risk in §2 becomes unacceptable: sign release tags, commit the public key to the
repo, and add `git verify-tag` before step 4.4.4. No new dependency (`git` verifies), no change to
the transport, no change to the UI. The cost is release ceremony — every release must be signed, and
an unsigned tag must fail closed.

## 10. Prerequisites before implementation

1. **Make the repository public**, or document that auto-update requires a token. Today it is
   private and the feature cannot work for anyone else.
2. ~~**Fix the version scheme.**~~ **Done 2026-09-13.** `package.json` and `server/main.js` said
   **0.0.9** while `CHANGELOG.md` said **[0.9.0]** and **[0.1.0]**; any "is this newer?" comparison
   would have been wrong, and that field is what the whole feature compares. 0.1.0 is current, and
   every source now says so. The version is no longer written down twice: `server/main.js` reads
   it from `package.json`.
3. ~~**Create the first tag.**~~ **Done 2026-09-14:** `v0.1.0`, the first official release, is
   tagged, so the release channel in §3 exists.
4. **Decide the open-mode question** in §6 knowingly.

## 11. Tests

- semver comparison, including the 0.0.9 / 0.9.0 trap and pre-release suffixes;
- changelog parsing across several releases, and against a malformed changelog;
- fast-forward refusal on a non-ancestor tag;
- dirty-tree refusal, naming the files;
- confirm-mismatch refusal;
- rollback restores the recorded commit;
- notes containing `<script>` render as text (the §7 boundary);
- open-mode cross-site apply is refused;
- **a negative control for each**: every one of these must fail against the unfixed behaviour, or
  it is decoration.
