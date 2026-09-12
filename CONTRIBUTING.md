# Contributing to blockyard

Thank you for helping. This project has a small set of firm rules; most of them exist because
breaking them once caused a real, hard-to-see failure. They are listed with their reasons in
[docs/RULES.md](docs/RULES.md).

## Getting started

```bash
git clone https://github.com/BobClawblaw/blockyard.git
cd blockyard
npm run dev        # the full app against a built-in fake node, http://127.0.0.1:18088
npm test           # the unit suite
```

There is nothing to install. Node.js 22 or later is the only requirement. The front end is
served straight from `public/`, so edits there show up on a page reload; server changes need a
restart.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before a larger change.

## The rules

1. **Zero dependencies.** No npm packages, no CDN, no build step. Node built-ins on the
   server; vanilla ES modules and hand-written canvas drawing in the browser.
2. **Read-only toward the node.** New RPC reads must be allowed by `server/rpc/allowlist.js`;
   anything that changes node state belongs behind the node-actions gate, never in a poll.
3. **Be a good guest.** The node's RPC server is single-threaded. Every call goes through the
   serialized lane in `server/rpc/client.js`; batch related calls into one request; give user-
   facing reads a priority; never add a poll without measuring its cost on a real node.
4. **Honest data.** Show a missing value as missing (`–`), never as zero. Mark stale data as
   stale. Label inferences. Add new figures to the provenance table on the Node & RPC page.
5. **No inline styles.** The Content Security Policy forbids `style="…"` attributes. Put
   styles in `public/css/app.css`; for data-driven values use `data-*` attributes and set them
   through the CSSOM. `test/csp.test.js` enforces this.
6. **Canvas rules for the 3D engine.** In `public/js/details3d.js` and
   `public/js/blockscene3d.js`: no `ctx.clip()`, no `globalAlpha`, no composite modes, no
   `shadowBlur`. Transparency rides inside `rgba()` colours; depth is paint order. Some
   software rasterisers silently drop what those features produce. `test/viewer-canvas-
   rules.test.js` enforces this.
7. **No host identity in commits.** Never commit a real username, hostname, LAN or VPN
   address, or personal path. Use documentation addresses (`192.0.2.0/24`, `198.51.100.0/24`,
   `203.0.113.0/24`, `2001:db8::/32`) in code, tests and docs. Machine-specific settings go in
   the git-ignored `config/local.json`. `test/privacy.test.js` enforces this.

## Tests

```bash
npm test             # every *.test.js under test/ (node:test)
npm run smoke        # boots the real server twice (accounts on and off) and checks the API
npm run counts:fix   # after adding or removing tests: update the documented test count
```

- Add a test with every behaviour change. Pure functions (renderers that turn data into
  markup, layout functions, parsers) are tested directly; the HTTP layer is tested by booting
  the app in-process (`test/helpers/`); page renderers run against a DOM stub
  (`test/dom-stub.js`).
- For a bug fix, write the test first and watch it fail.
- The documented test count in `README.md` and `AGENTS.md` is generated —
  `npm run counts:check` fails if it drifts.

## Making a change

1. Fork, create a branch, make the change with its tests.
2. Run `npm test` (and `npm run smoke` for server changes).
3. **Run the thing.** Start `npm run dev` and look at the pages you touched; a green suite has
   missed start-up crashes before.
4. For visual changes, include before-and-after screenshots in the pull request.
5. Keep commits focused; explain *why* in the message, not only what.

## Style

- Match the surrounding code: its naming, comment density and idiom.
- Comments explain decisions and constraints, especially non-obvious ones ("why not the
  simpler thing").
- User-facing text is plain and specific: say what a number is, where it came from, and what
  is not known.

## Reporting bugs

Open an issue with what you did, what you expected, what happened, the version (shown in the
header), your browser, and the relevant part of the start-up log. For security problems, see
[SECURITY.md](SECURITY.md) — please report those privately.

## License of contributions

blockyard is licensed under the Apache License 2.0. By contributing you agree that your
contribution is licensed under the same terms (see [LICENSE](LICENSE)).
