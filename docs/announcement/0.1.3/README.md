# The 0.1.3 announcement

For the bitcointalk thread (https://bitcointalk.org/index.php?topic=5594141): a release post for
0.1.3, five days after 0.1.2 (prepared on 2026-09-19 as the companion-node release, then held while the
skies, the WebGL renderer and the Sun landed; released 2026-09-22 with both halves).

`blockyard-0.1.3-announcement.txt` is the post in Markdown; `blockyard-0.1.3-announcement.bbcode`
is the same post in BBCode for the forum, generated from it so the two cannot drift. Its nine
pictures are marked `IMAGE-URL-FOR:<file>` until they are uploaded to talkimg.com and the links put
in: `overview.jpg` at the top; `sky-sun.jpg`, `sky-sun-limb.jpg`, `sky-formation.jpg`, `finish-chrome.jpg`,
`effect-ball-lightning-markets.jpg` and `markets-1h.jpg` through the skies section; `about.jpg` (the
Bitcoin Machine Code card) beside that section; `chain.jpg` (Chain & Sync) beside the charts. The other
screenshots are here too, for the thread.

Every picture was shot at 0.1.3 on 2026-09-22 against the local Core node -- the pages with
`scripts/shots.mjs`, the skies and finishes on WebGL with a GPU-backed headless browser, the two effect
shots from `scripts/gl-compare.mjs` on its own synthetic board -- and is a copy of `docs/images/`. No Bitcoin Machine Code node was configured
when they were taken -- run 27 was benchmarking its initial sync, and BlockYard's polling would have
disturbed the timing -- so the Chain & Sync shot is of a synced Core node.

The post leads with the skies and the renderer, then Bitcoin Machine Code as BlockYard's companion node (and its experimental
warning), then the four-wide RPC lane, the chart fixes found by watching a node in initial sync, the
Diversions, and what to know when upgrading from 0.1.2. The full list is `CHANGELOG.md` under 0.1.3.
