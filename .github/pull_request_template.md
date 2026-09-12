<!--
CONTRIBUTING.md has the project's rules in full. The four that catch people out:

  1. No dependencies. Not a small one. `npm install` does not exist here by design.
  2. No inline styles — the CSP refuses `style="…"`. Write a class, set data-* through
     the CSSOM.
  3. Read-only toward the node. A new RPC read must be in server/rpc/allowlist.js;
     anything that writes stays behind the actions gate.
  4. `npm run counts:fix` BEFORE `npm test` — they race on README/AGENTS otherwise.
-->

## What this changes, and why

<!-- The behaviour, not the diff. If it fixes something, say what the failure looked like. -->

## How it was verified

<!-- "The suite passes" is necessary and not sufficient for anything that draws. A green
     suite says nothing about whether a chart fits, a colour reads, or a board animates —
     say what you measured or looked at. -->

- [ ] `npm run counts:fix && npm test` passes locally
- [ ] Checked in a browser, if it draws anything
- [ ] No host identity in committed files (no usernames, hostnames or real addresses — `test/privacy.test.js` enforces this)
- [ ] Docs updated if behaviour changed (README / docs/USER-GUIDE.md / CHANGELOG.md)
